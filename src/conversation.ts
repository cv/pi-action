import { setTimeout as sleep } from "node:timers/promises";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Submission } from "@earendil-works/pi-durable";

import { ANSWER_KIND } from "./answers.ts";
import type { Thread } from "./thread.ts";
import type { Trigger } from "./triggers.ts";
import type { Log } from "./types.ts";
import { getErrorMessage } from "./utils.ts";

type SettledRecord = Awaited<ReturnType<Submission["wait"]>>;

export type ThreadResult =
	| { success: true; response: string }
	| { success: false; error: string };

export interface ConversationOptions {
	thread: Thread;
	log: Log;
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
	/** The URLs of the questions pi-durable extensions asked in this run so far (see github-ui.ts). */
	asked?: () => readonly string[];
}

const EMPTY_RESPONSE = "Agent returned empty response";
const SUMMARY_SUFFIX = "-summary";
const CONTINUE_SUFFIX = "-continue-";
const SUMMARY_PROMPT = `IMPORTANT: You completed your work but did not provide a final text summary. This summary is REQUIRED. Please now write a plain-text summary of what you accomplished, including:
- What changes were made and why
- Which files were modified
- Any errors encountered or remaining issues
- Confirmation that your work is complete

Do NOT call any tools - just provide the text summary.`;
/** Sent when a response ran out of output tokens with no tool call: the model did not choose to stop. */
const CONTINUE_PROMPT =
	"Your last response hit the output token limit (max_tokens) before you finished. Continue where you left off; keep reasoning shorter and act with tools.";
/** How many responses in a row may hit the output token limit before the run gives up. */
const MAX_CUT_OFFS = 3;
const CUT_OFF_NOTE =
	"\n\n_This response was cut off at the output token limit (max_tokens); pi is continuing._";

/** A response that hit the output token limit too often (or at the timeout): an error with any partial text. */
function cutOffResult(
	text: string,
	count: number,
	timedOutAfter: number | undefined,
): ThreadResult {
	const reason =
		timedOutAfter === undefined
			? `pi's responses hit the output token limit (max_tokens) ${count} times in a row, so the run stopped before the work was finished. Raise \`model_max_tokens\` (for a custom provider) or use a model with a larger output limit, then ask again.`
			: `Timeout after ${timedOutAfter} seconds, while the last response was cut off at the output token limit (max_tokens).`;
	return {
		success: false,
		error: text
			? `${reason}\n\nThe last response, cut off:\n\n${text}`
			: reason,
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
	return `${record.reason}: ${detail}`;
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
	/** When the run times out; set once the initial triggers are submitted. */
	private deadline = Number.POSITIVE_INFINITY;
	private readonly options: ConversationOptions;

	constructor(options: ConversationOptions) {
		this.options = options;
	}

	async run(initial: Trigger[]): Promise<void> {
		const { thread, log, timeoutSeconds, pollIntervalMs, poll } = this.options;
		this.posted = await thread.postedResults();
		await this.submitAll(initial);

		this.deadline = Date.now() + timeoutSeconds * 1000;
		for (;;) {
			const remaining = this.deadline - Date.now();
			if (remaining <= 0) {
				this.timedOut = true;
				break;
			}
			if (this.pending.size > 0) {
				const wait = new AbortController();
				const timer = sleep(Math.min(pollIntervalMs, remaining), undefined, {
					signal: wait.signal,
				}).catch(() => undefined);
				// oxlint-disable-next-line eslint/no-await-in-loop -- the poll loop waits between rounds by design
				await Promise.race([Promise.allSettled(this.pending), timer]);
				wait.abort();
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

	/**
	 * Submit and wait. A response cut off by the output token limit is continued (see `settle()`); an empty
	 * answer is followed by one request for a summary (as pi-action always did).
	 */
	private async answer(
		trigger: Trigger,
		content: string,
	): Promise<SettledResult> {
		const outcome = await this.settle(trigger, trigger.key, content);
		// An answer an earlier run delivered (or a question it is waiting on) is not asked for again.
		if (!(outcome.empty && !this.outOfTime()) || this.posted.has(outcome.key)) {
			return outcome;
		}
		this.options.log.warning(
			"Agent returned empty response from first attempt. Re-prompting for a summary.",
		);
		const retry = await this.settle(
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

	/**
	 * Submit and wait; while the answer was cut off by the output token limit (no tool call: the agent loop
	 * ended, but the model did not choose to stop), ask it to continue, with tools. Partial text is posted as it
	 * comes. After `MAX_CUT_OFFS` cut-offs in a row (a run that used tools in between resets the count), or at
	 * the timeout, the result is an error that says so. Continuations have stable keys, so a re-run gets the same
	 * submissions back rather than sending them again.
	 */
	private async settle(
		trigger: Trigger,
		key: string,
		content: string,
	): Promise<SettledResult> {
		const { log } = this.options;
		let outcome = await this.submitAndWait(trigger, key, content);
		let inARow = 0;
		for (let continuation = 1; outcome.cutOff; continuation += 1) {
			inARow = outcome.cutOff.usedTools ? 1 : inARow + 1;
			const { text } = outcome.cutOff;
			if (inARow > MAX_CUT_OFFS || this.outOfTime()) {
				const timedOutAfter =
					inARow > MAX_CUT_OFFS ? undefined : this.options.timeoutSeconds;
				log.warning(
					timedOutAfter === undefined
						? `pi's responses hit the output token limit (max_tokens) ${inARow} times in a row; giving up. Consider raising the model_max_tokens input.`
						: "Timed out while pi's response was cut off at the output token limit (max_tokens); not continuing.",
				);
				return {
					key: outcome.key,
					empty: false,
					result: cutOffResult(text, inARow, timedOutAfter),
				};
			}
			log.warning(
				`pi's response hit the output token limit (max_tokens) without a tool call; asking it to continue (${inARow} of ${MAX_CUT_OFFS}). Consider raising the model_max_tokens input.`,
			);
			if (text) {
				this.enqueueDelivery(trigger, {
					key: outcome.key,
					empty: false,
					result: { success: true, response: `${text}${CUT_OFF_NOTE}` },
				});
			}
			// oxlint-disable-next-line eslint/no-await-in-loop -- each continuation follows the cut-off one
			outcome = await this.submitAndWait(
				trigger,
				`${key}${CONTINUE_SUFFIX}${continuation}`,
				CONTINUE_PROMPT,
			);
		}
		return outcome;
	}

	/** The run timed out, or is about to: no more prompts are sent. */
	private outOfTime(): boolean {
		return this.timedOut || Date.now() >= this.deadline;
	}

	private async submitAndWait(
		trigger: Trigger,
		key: string,
		content: string,
	): Promise<SettledResult> {
		const asked = this.options.asked ?? (() => []);
		const askedBefore = asked().length;
		const { answer } = trigger;
		const submission = await this.options.thread.submit({
			key,
			content,
			data: {
				author: trigger.author.login,
				source: trigger.source,
				...(trigger.url ? { url: trigger.url } : {}),
			},
			...(answer
				? {
						entry: {
							kind: ANSWER_KIND,
							data: {
								key: answer.key,
								kind: answer.kind,
								answer: answer.answer,
								by: answer.by,
								url: answer.url,
							},
						},
					}
				: {}),
		});
		const record = await submission.wait(BACKGROUND_CONTEXT);
		if (record.status === "done" && record.answer !== undefined) {
			// An input submission always has its entry; without one, the range is just the answer.
			const input = record.entry ?? record.answer;
			const { text, toolCalls, stopReason, usedTools } =
				await this.options.thread.answerText(record.answer, input);
			const questions = asked().slice(askedBefore);
			if (toolCalls && questions.length > 0) {
				// The run ended on a question (its tool round asked to terminate): the answer comes in a later run.
				return {
					key: `answer-${record.answer}`,
					empty: false,
					waiting: questions,
					result: { success: true, response: text },
				};
			}
			if (stopReason === "length" && !toolCalls) {
				return {
					key: `answer-${record.answer}`,
					empty: false,
					cutOff: { text, usedTools },
					result: { success: true, response: text },
				};
			}
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
		if (outcome.waiting) {
			this.options.log.info(
				`pi asked a question and ended its turn; waiting for an answer to ${outcome.waiting.join(", ")}`,
			);
			if (!alreadyPosted) {
				this.posted.set(outcome.key, outcome.waiting[0] ?? "");
				await this.options.thread.markPosted(
					outcome.key,
					outcome.waiting[0] ?? "",
				);
			}
			return;
		}
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
	/** The run ended on these questions: nothing is posted, the answers start a later run. */
	waiting?: readonly string[];
	/** The answer hit the output token limit with no tool call (`settle()` continues it). */
	cutOff?: { text: string; usedTools: boolean };
}
