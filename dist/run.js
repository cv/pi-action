import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runAgent } from "./agent.js";
import { extractTask, hasTrigger } from "./context.js";
import { formatErrorComment, formatSuccessComment } from "./formatting.js";
import { addReaction, extractTriggerInfo, } from "./github.js";
import { sanitizeInput, validatePermissions } from "./security.js";
export function setupAuth(piAuthJson) {
    if (piAuthJson) {
        const authDir = join(homedir(), ".pi", "agent");
        mkdirSync(authDir, { recursive: true });
        writeFileSync(join(authDir, "auth.json"), piAuthJson);
    }
}
export async function run(deps) {
    const { inputs, context, createClient, log, cwd } = deps;
    setupAuth(inputs.piAuthJson);
    // Extract trigger info from payload
    const triggerInfo = extractTriggerInfo(context.payload);
    if (!triggerInfo) {
        log.info("No issue or pull_request in payload, skipping");
        return;
    }
    // Check if trigger phrase is present
    if (!hasTrigger(triggerInfo.triggerText, inputs.triggerPhrase)) {
        log.info(`No trigger phrase "${inputs.triggerPhrase}" found, skipping`);
        return;
    }
    // Validate permissions
    const securityContext = {
        authorAssociation: triggerInfo.authorAssociation,
        authorLogin: triggerInfo.author.login,
        isBot: triggerInfo.author.type === "Bot",
        allowedBots: inputs.allowedBots,
    };
    if (!validatePermissions(securityContext)) {
        log.warning(`User ${triggerInfo.author.login} (${triggerInfo.authorAssociation}) does not have permission`);
        return;
    }
    if (!inputs.githubToken) {
        log.setFailed("github_token is required");
        return;
    }
    const ghClient = createClient(inputs.githubToken);
    // Add eyes reaction to acknowledge
    await addReaction(ghClient, triggerInfo, "eyes");
    // Build context
    const sanitizedBody = sanitizeInput(triggerInfo.triggerText);
    const task = extractTask(sanitizedBody, inputs.triggerPhrase);
    const piContext = {
        type: triggerInfo.isPullRequest ? "pull_request" : "issue",
        title: triggerInfo.issueTitle,
        body: triggerInfo.issueBody,
        number: triggerInfo.issueNumber,
        triggerComment: sanitizedBody,
        task,
    };
    // Get PR diff if applicable
    if (triggerInfo.isPullRequest) {
        piContext.diff = await ghClient.getPullRequestDiff(triggerInfo.issueNumber);
    }
    log.info(`Running pi agent for: ${task}`);
    // Run the agent
    const result = await runAgent(piContext, {
        provider: inputs.provider,
        model: inputs.model,
        timeout: inputs.timeout,
        cwd,
        logger: log,
        promptTemplate: inputs.promptTemplate,
    });
    if (result.success) {
        await addReaction(ghClient, triggerInfo, "rocket");
        await ghClient.createComment(triggerInfo.issueNumber, formatSuccessComment(result.response));
    }
    else {
        log.error(`pi execution failed: ${result.error}`);
        await addReaction(ghClient, triggerInfo, "confused");
        await ghClient.createComment(triggerInfo.issueNumber, formatErrorComment(result.error));
    }
}
