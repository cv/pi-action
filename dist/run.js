import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { buildPrompt, formatFollowUp } from "./context.js";
import { hasTrigger } from "./context.js";
import { DEFAULTS } from "./defaults.js";
import { formatErrorComment, formatSuccessComment } from "./formatting.js";
import { addReaction, extractTriggerInfo, } from "./github.js";
import { createActionModels, findModel } from "./models.js";
import { validatePermissions } from "./security.js";
import { Thread } from "./thread.js";
import { collectTriggers, triggerFromInfo, } from "./triggers.js";
import { getErrorMessage } from "./utils.js";
import { GitSyncConflictError } from "./vendor/git-backed-pi-durable/index.js";
/**
 * Validates that the trigger is authorized to run the agent.
 * Returns the trigger info if valid, null otherwise.
 */
function validateTrigger(deps) {
    const { inputs, context, createClient, log } = deps;
    const triggerInfo = extractTriggerInfo(context.payload);
    if (!triggerInfo) {
        log.info("No issue or pull_request in payload, skipping");
        return null;
    }
    if (!hasTrigger(triggerInfo.triggerText, inputs.triggerPhrase)) {
        log.info(`No trigger phrase "${inputs.triggerPhrase}" found, skipping`);
        return null;
    }
    const securityContext = {
        authorAssociation: triggerInfo.authorAssociation,
        authorLogin: triggerInfo.author.login,
        isBot: triggerInfo.author.type === "Bot",
        allowedBots: inputs.allowedBots,
    };
    if (!validatePermissions(securityContext)) {
        log.warning(`User ${triggerInfo.author.login} (${triggerInfo.authorAssociation}) does not have permission`);
        return null;
    }
    if (!inputs.githubToken) {
        log.setFailed("github_token is required");
        return null;
    }
    return { triggerInfo, ghClient: createClient(inputs.githubToken) };
}
function describeUnanswered(record, timedOutAfter) {
    if (record.reason === "aborted" && timedOutAfter !== undefined) {
        return `Timeout after ${timedOutAfter} seconds`;
    }
    const detail = record.detail === undefined
        ? ""
        : `: ${typeof record.detail === "string" ? record.detail : JSON.stringify(record.detail)}`;
    return `${record.reason ?? "unanswered"}${detail}`;
}
/** Waits that a timer can cut short, without keeping the process alive afterwards. */
function sleep(ms) {
    let timer;
    const promise = new Promise((resolve) => {
        timer = setTimeout(resolve, Math.max(0, ms));
    });
    return { promise, cancel: () => clearTimeout(timer) };
}
/** On cancellation (SIGINT, then SIGTERM), push what the thread has so far before the runner kills us. */
function pushOnSignals(thread, log) {
    const handler = (signal) => {
        log.warning(`Received ${signal}; pushing ${thread.ref} before exiting`);
        thread
            .push()
            .catch((error) => log.warning(getErrorMessage(error)))
            .finally(() => process.exit(1));
    };
    process.once("SIGINT", handler);
    process.once("SIGTERM", handler);
    return () => {
        process.off("SIGINT", handler);
        process.off("SIGTERM", handler);
    };
}
class Conversation {
    deps;
    thread;
    gh;
    info;
    handled = new Set();
    pending = new Set();
    posting = Promise.resolve();
    posted = new Map();
    timedOut = false;
    constructor(deps, thread, gh, info) {
        this.deps = deps;
        this.thread = thread;
        this.gh = gh;
        this.info = info;
    }
    get filter() {
        return {
            triggerPhrase: this.deps.inputs.triggerPhrase,
            allowedBots: this.deps.inputs.allowedBots,
        };
    }
    async run() {
        const { inputs, log } = this.deps;
        this.posted = await this.thread.postedResults();
        const current = triggerFromInfo(this.info, inputs.triggerPhrase);
        // A new thread starts from this trigger; an existing one also picks up comments no run handled yet.
        const since = this.thread.startedAt;
        const pollSince = since ?? new Date(Date.parse(current.createdAt) - 1000);
        await this.submit(await collectTriggers(this.gh, this.info, this.filter, since, current));
        const timeoutMs = inputs.modelConfig.timeout * 1000;
        const pollMs = (inputs.pollInterval ?? DEFAULTS.pollInterval) * 1000;
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                this.timedOut = true;
                break;
            }
            if (this.pending.size > 0) {
                const timer = sleep(Math.min(pollMs, remaining));
                await Promise.race([
                    Promise.allSettled([...this.pending]),
                    timer.promise,
                ]);
                timer.cancel();
            }
            const fresh = (await collectTriggers(this.gh, this.info, this.filter, pollSince)).filter((trigger) => !this.handled.has(trigger.key));
            if (fresh.length > 0) {
                log.info(`${fresh.length} new comment(s) for pi; adding them to the conversation`);
                await this.submit(fresh);
            }
            else if (this.pending.size === 0) {
                break;
            }
        }
        if (this.timedOut) {
            log.warning(`Timeout after ${inputs.modelConfig.timeout} seconds; aborting the run`);
            await this.thread.abort();
        }
        await Promise.allSettled([...this.pending]);
        await this.posting;
    }
    async submit(triggers) {
        for (const trigger of triggers) {
            if (this.handled.has(trigger.key)) {
                continue;
            }
            const first = this.thread.isNew && this.handled.size === 0;
            this.handled.add(trigger.key);
            const content = first
                ? buildPrompt(await this.issueContext(trigger), this.deps.inputs.promptTemplate)
                : formatFollowUp({
                    author: trigger.author.login,
                    task: trigger.task,
                    url: trigger.url,
                    reviewComment: trigger.source === "review_comment",
                });
            const submission = await this.thread.submit({
                key: trigger.key,
                content,
                data: {
                    author: trigger.author.login,
                    url: trigger.url,
                    source: trigger.source,
                },
            });
            const settled = submission
                .wait(BACKGROUND_CONTEXT)
                .then((record) => this.enqueueReport(trigger, record))
                .catch((error) => this.deps.log.warning(getErrorMessage(error)));
            this.pending.add(settled);
            settled.finally(() => this.pending.delete(settled));
        }
    }
    async issueContext(trigger) {
        const context = {
            type: this.info.isPullRequest ? "pull_request" : "issue",
            title: this.info.issueTitle,
            body: this.info.issueBody,
            number: this.info.issueNumber,
            triggerComment: trigger.text,
            task: trigger.task,
        };
        if (this.info.isPullRequest) {
            context.diff = await this.gh.getPullRequestDiff(this.info.issueNumber);
        }
        return context;
    }
    enqueueReport(trigger, record) {
        this.posting = this.posting
            .then(() => this.report(trigger, record))
            .catch((error) => this.deps.log.warning(`Failed to post result: ${getErrorMessage(error)}`));
        return this.posting;
    }
    /** Post each answer (or failure) once, also across runs; react on every trigger it covers. */
    async report(trigger, record) {
        const done = record.status === "done" && record.answer !== undefined;
        const key = done ? `answer-${record.answer}` : `error-${record.id}`;
        const footer = { ref: this.thread.ref };
        if (!this.posted.has(key)) {
            let body;
            if (done && record.answer !== undefined) {
                const text = await this.thread.answerText(record.answer);
                body = formatSuccessComment(text || "_(no text in the response)_", footer);
            }
            else {
                const timedOutAfter = this.timedOut
                    ? this.deps.inputs.modelConfig.timeout
                    : undefined;
                const reason = describeUnanswered(record, timedOutAfter);
                this.deps.log.error(`pi execution failed: ${reason}`);
                body = formatErrorComment(reason, footer);
            }
            const comment = await this.gh.createComment(this.info.issueNumber, body);
            this.posted.set(key, comment.url);
            await this.thread.markPosted(key, comment.url);
        }
        else if (!done) {
            return; // a failure an earlier run already reported
        }
        await addReaction(this.gh, {
            isCommentEvent: trigger.source !== "body",
            commentId: trigger.commentId,
            issueNumber: trigger.issueNumber,
            source: trigger.source,
        }, done ? "rocket" : "confused");
    }
}
const defaultModels = (inputs, log) => createActionModels({
    authJson: inputs.piAuthJson,
    modelsJson: inputs.modelsJson,
    log: log.info,
});
export async function run(deps) {
    const { inputs, log, cwd } = deps;
    const validated = validateTrigger(deps);
    if (!validated) {
        return;
    }
    const { triggerInfo, ghClient } = validated;
    // Acknowledge
    await addReaction(ghClient, triggerInfo, "eyes");
    let thread;
    let stopSignals;
    try {
        const models = await (deps.createModels ?? defaultModels)(inputs, log);
        const model = findModel(models, inputs.modelConfig.provider, inputs.modelConfig.model);
        thread = await Thread.open({
            cwd,
            issueNumber: triggerInfo.issueNumber,
            models,
            model,
            log,
            remote: deps.remote,
        });
        log.info(`Thread ${thread.ref}: ${thread.isNew ? "new" : `since ${thread.startedAt?.toISOString()}`}`);
        stopSignals = pushOnSignals(thread, log);
        await new Conversation(deps, thread, ghClient, triggerInfo).run();
    }
    catch (error) {
        const message = getErrorMessage(error);
        log.error(`pi execution failed: ${message}`);
        await addReaction(ghClient, triggerInfo, "confused");
        await ghClient.createComment(triggerInfo.issueNumber, formatErrorComment(message));
    }
    finally {
        try {
            await thread?.close();
        }
        catch (error) {
            const conflict = error instanceof GitSyncConflictError;
            log.warning(conflict
                ? `${thread?.ref} moved on the remote while this run worked; its history was not pushed. ${getErrorMessage(error)}`
                : `Could not save the thread: ${getErrorMessage(error)}`);
        }
        stopSignals?.();
    }
}
