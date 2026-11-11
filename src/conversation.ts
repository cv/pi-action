import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Submission } from "@earendil-works/pi-durable";

import type { Thread } from "./thread.ts";
import type { Trigger } from "./triggers.ts";
import { getErrorMessage } from "./utils.ts";

type SettledRecord = Awaited<ReturnType<Submission["wait"]>>;

export type ThreadResult =
	| { success: true; response: string }
	| { success: false; error: string };

interface ConversationLogger {
	info: (msg: string) => void;
	warning: (msg: string) => void;
}

export interface ConversationOptions {
	thread: Thread;
	log: ConversationLogger;
	timeoutSeconds: number;
	pollIntervalMs: number;
	/** The message to submit for a trigger; `first` is true for the first one of a new thread. */
	message: (trigger: Trigger, first: boolean) => Promise<string>;
	/**
	 * Deliver a result. `alreadyPosted` is set when an earlier run delivered this answer (the trigger was
	 * answered together with another one). Returns where it was posted, recorded so it is never posted twice.
	 */
	deliver: (
		trigger: Trigger,
		result: ThreadResult,
		alreadyPosted: boolean,
	) => Promise<string | undefined>;
	/** Triggers that arrived since the run started; omitted for one-off runs. */
	poll?: () => Promise<Trigger[]>;
}

const EMPTY_RESPONSE = "Agent returned empty response";
const SUMMARY_SUFFIX = "-summary";
const SUMMARY_PROMPT = `IMPORTANT: You completed your work but did not provide a final text summary. This summary is REQUIRED. Please now write a plain-text summary of what you accomplished, including:
- What changes were made and why
- Which files were modified
- Any errors encountered or remaining issues
- Confirmation that your work is complete

Do NOT call any tools - just provide the text summary.`;

function sleep(ms: number): { promise: Promise<void>; cancel: () => void } {
	let timer: NodeJS.Timeout | undefined;
	const promise = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, Math.max(0, ms));
	});
	return {
		promise,
		cancel: () => {
			clearTimeout(timer);
		},
	};
}

function describeUnanswered(
	record: SettledRecord,
	timedOutAfter: number | undefined,
): string {
	if (record.reason === "aborted" && timedOutAfter !== undefined) {
		return `Timeout after ${timedOutAfter} seconds`;
	}
	if (record.detail === undefined) {
		return record.reason ?? "unanswered";
	}
	const detail =
		typeof record.detail === "string"
			? record.detail
			: JSON.stringify(record.detail);
	return `${record.reason ?? "unanswered"}: ${detail}`;
}

/**
 * Drives a thread through a set of triggers: submits them (new ones join the running conversation), waits for
 * every answer within the timeout, and delivers each answer or failure exactly once.
 */
export class ThreadConversation {
	private readonly handled = new Set<string>();
	private readonly pending = new Set<Promise<void>>();
	private delivering: Promise<void> = Promise.resolve();
	private posted = new Map<string, string>();
	private timedOut = false;
	private readonly options: ConversationOptions;

	constructor(options: ConversationOptions) {
		this.options = options;
	}

	async run(initial: Trigger[]): Promise<void> {
		const { thread, log, timeoutSeconds, pollIntervalMs, poll } = this.options;
		this.posted = await thread.postedResults();
		await this.submitAll(initial);

		const deadline = Date.now() + timeoutSeconds * 1000;
		for (;;) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				this.timedOut = true;
				break;
			}
			if (this.pending.size > 0) {
				const timer = sleep(Math.min(pollIntervalMs, remaining));
				// oxlint-disable-next-line eslint/no-await-in-loop -- the poll loop waits between rounds by design
				await Promise.race([Promise.allSettled(this.pending), timer.promise]);
				timer.cancel();
			}
			const fresh = poll
				? // oxlint-disable-next-line eslint/no-await-in-loop -- each round polls once, after the wait
					(await poll()).filter((trigger) => !this.handled.has(trigger.key))
				: [];
			if (fresh.length > 0) {
				log.info(
					`${fresh.length} new comment(s) for pi; adding them to the conversation`,
				);
				// oxlint-disable-next-line eslint/no-await-in-loop -- new comments join before the next round
				await this.submitAll(fresh);
			} else if (this.pending.size === 0) {
				break;
			}
		}

		if (this.timedOut) {
			log.warning(`Timeout after ${timeoutSeconds} seconds; aborting the run`);
			await thread.abort();
		}
		await Promise.allSettled(this.pending);
		await this.delivering;
	}

	private async submitAll(triggers: Trigger[]): Promise<void> {
		for (const trigger of triggers) {
			if (!this.handled.has(trigger.key)) {
				const first = this.options.thread.isNew && this.handled.size === 0;
				this.handled.add(trigger.key);
				// oxlint-disable-next-line eslint/no-await-in-loop -- triggers are submitted in order
				const content = await this.options.message(trigger, first);
				this.track(trigger, this.answer(trigger, content));
			}
		}
	}

	private track(trigger: Trigger, result: Promise<SettledResult>): void {
		const settled = (async () => {
			try {
				this.enqueueDelivery(trigger, await result);
			} catch (error) {
				this.options.log.warning(getErrorMessage(error));
			}
		})();
		this.pending.add(settled);
		settled
			.finally(() => {
				this.pending.delete(settled);
			})
			.catch(() => undefined);
	}

	/** Submit and wait; an empty answer is followed by one request for a summary (as pi-action always did). */
	private async answer(
		trigger: Trigger,
		content: string,
	): Promise<SettledResult> {
		const outcome = await this.submitAndWait(trigger, trigger.key, content);
		if (!(outcome.empty && !this.timedOut)) {
			return outcome;
		}
		this.options.log.warning(
			"Agent returned empty response from first attempt. Re-prompting for a summary.",
		);
		const retry = await this.submitAndWait(
			trigger,
			`${trigger.key}${SUMMARY_SUFFIX}`,
			SUMMARY_PROMPT,
		);
		if (!retry.empty) {
			return retry;
		}
		return {
			key: retry.key,
			empty: true,
			result: {
				success: false,
				error: `Agent failed to provide a response after two attempts. First attempt: ${EMPTY_RESPONSE}. Retry attempt: ${EMPTY_RESPONSE}.`,
			},
		};
	}

	private async submitAndWait(
		trigger: Trigger,
		key: string,
		content: string,
	): Promise<SettledResult> {
		const submission = await this.options.thread.submit({
			key,
			content,
			data: {
				author: trigger.author.login,
				source: trigger.source,
				...(trigger.url ? { url: trigger.url } : {}),
			},
		});
		const record = await submission.wait(BACKGROUND_CONTEXT);
		if (record.status === "done" && record.answer !== undefined) {
			const text = await this.options.thread.answerText(record.answer);
			return {
				key: `answer-${record.answer}`,
				empty: text === "",
				result: text
					? { success: true, response: text }
					: { success: false, error: EMPTY_RESPONSE },
			};
		}
		const timedOutAfter = this.timedOut
			? this.options.timeoutSeconds
			: undefined;
		return {
			key: `error-${record.id}`,
			empty: false,
			result: {
				success: false,
				error: describeUnanswered(record, timedOutAfter),
			},
		};
	}

	private enqueueDelivery(trigger: Trigger, outcome: SettledResult): void {
		this.delivering = this.delivering
			.then(async () => this.deliver(trigger, outcome))
			.catch((error: unknown) => {
				this.options.log.warning(
					`Failed to deliver result: ${getErrorMessage(error)}`,
				);
			});
	}

	private async deliver(
		trigger: Trigger,
		outcome: SettledResult,
	): Promise<void> {
		const alreadyPosted = this.posted.has(outcome.key);
		if (alreadyPosted && !outcome.result.success) {
			return; // a failure an earlier run already reported
		}
		const url = await this.options.deliver(
			trigger,
			outcome.result,
			alreadyPosted,
		);
		if (url !== undefined && !alreadyPosted) {
			this.posted.set(outcome.key, url);
			await this.options.thread.markPosted(outcome.key, url);
		}
	}
}

interface SettledResult {
	/** `answer-<entryId>` or `error-<submissionId>`: what is delivered once. */
	key: string;
	empty: boolean;
	result: ThreadResult;
}
