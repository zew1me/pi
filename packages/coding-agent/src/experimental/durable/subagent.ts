import type { Context } from "@earendil-works/chord";
import { type AssistantMessage, Type } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	configure,
	defineExtension,
	defineTool,
	type EntryId,
	type Extension,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";

/** The environment variable that sets the cap at startup, as in the pi-subagent extensions. */
export const SUBAGENT_LIMIT_ENV = "PI_SUBAGENT_MAX_CONCURRENCY";

/** Without `PI_SUBAGENT_MAX_CONCURRENCY`, no cap, as upstream: every call of a round starts at once. */
export const DEFAULT_SUBAGENT_LIMIT = Number.POSITIVE_INFINITY;

/** What the limiter holds now; `limit` is `Infinity` without a cap. */
export interface SubagentSlots {
	readonly running: number;
	readonly queued: number;
	readonly limit: number;
}

/**
 * A cap as typed by the user: a positive integer, or `off` (also `0`, `none`, `unlimited`) for no cap. Empty or
 * absent means `fallback`.
 */
export function parseSubagentLimit(value: string | undefined, fallback = DEFAULT_SUBAGENT_LIMIT): number {
	const raw = (value ?? "").trim();
	const text = raw.toLowerCase();
	if (text === "") return fallback;
	if (text === "off" || text === "none" || text === "unlimited" || text === "0") return Number.POSITIVE_INFINITY;
	if (!/^\d+$/u.test(text)) throw new Error(`Invalid subagent limit "${raw}": expected a positive integer or "off"`);
	return Number(text);
}

/** `4`, or `off` without a cap. */
export function formatSubagentLimit(limit: number): string {
	return limit === Number.POSITIVE_INFINITY ? "off" : String(limit);
}

/** `2/4 running, 3 queued`, for the footer, queued tool cards, and notices. */
export function formatSubagentSlots({ running, queued, limit }: SubagentSlots): string {
	const waiting = queued > 0 ? `, ${String(queued)} queued` : "";
	return `${String(running)}/${formatSubagentLimit(limit)} running${waiting}`;
}

/**
 * How many subagents run at once. Waiters start in arrival order. Lowering the limit never stops a running subagent;
 * new ones wait until enough have finished. In memory only: after a restart, replayed subagent calls acquire again.
 */
export class SubagentLimiter {
	#limit: number;
	#running = 0;
	readonly #waiters: (() => void)[] = [];
	readonly #listeners = new Set<() => void>();

	constructor(limit: number) {
		this.#limit = checkLimit(limit);
	}

	snapshot(): SubagentSlots {
		return { running: this.#running, queued: this.#waiters.length, limit: this.#limit };
	}

	setLimit(limit: number): void {
		this.#limit = checkLimit(limit);
		this.#drain();
		this.#emit();
	}

	/** Take a slot if one is free and nobody waits for it. */
	tryAcquire(): boolean {
		if (this.#running >= this.#limit || this.#waiters.length > 0) return false;
		this.#running++;
		this.#emit();
		return true;
	}

	/** Take a slot, waiting for one if needed. Rejects with the abort reason when `context` is aborted while waiting. */
	acquire(context: Context): Promise<void> {
		const signal = context.abortSignal;
		if (signal?.aborted) return Promise.reject(abortError(signal));
		if (this.tryAcquire()) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			const onAbort = (): void => {
				// Only reachable while waiting: `start` removes this listener before the waiter leaves the queue.
				this.#waiters.splice(this.#waiters.indexOf(start), 1);
				this.#emit();
				reject(signal === undefined ? new Error("Aborted") : abortError(signal));
			};
			const start = (): void => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			this.#waiters.push(start);
			this.#emit();
		});
	}

	/** Give back a slot taken by `tryAcquire()` or `acquire()`. */
	release(): void {
		if (this.#running === 0) throw new Error("SubagentLimiter.release() without a held slot");
		this.#running--;
		this.#drain();
		this.#emit();
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#drain(): void {
		while (this.#running < this.#limit) {
			const start = this.#waiters.shift();
			if (start === undefined) return;
			this.#running++;
			start();
		}
	}

	#emit(): void {
		for (const listener of this.#listeners) listener();
	}
}

function checkLimit(limit: number): number {
	if (limit === Number.POSITIVE_INFINITY || (Number.isInteger(limit) && limit >= 1)) return limit;
	throw new Error(`Invalid subagent limit ${String(limit)}: expected a positive integer or Infinity`);
}

/** The reason an aborted signal carries, as an Error. */
function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Aborted", { cause: signal.reason });
}

async function answerText(api: ToolExecutionApi, answer: EntryId, context: Context): Promise<string> {
	const entry = await api.commit((tx) => tx.entry(AssistantEntry, answer), context);
	const message = entry?.model?.[0] as AssistantMessage | undefined;
	return message?.content.flatMap((content) => (content.type === "text" ? [content.text] : [])).join("") ?? "";
}

/**
 * A foreground subagent: each call creates a child conversation owned by the call's task, runs the task there, and
 * returns the child's answer. Aborting the call aborts the child. The child outlives the call, so the user can switch
 * to it and keep talking. At most `limiter`'s limit of calls run at once; the others wait, shown as queued.
 */
export function createSubagent(limiter: SubagentLimiter): Extension {
	const subagent: Extension = defineExtension({
		name: "subagent",
		tools: [
			defineTool({
				name: "subagent",
				description:
					"Delegate a self-contained task to a subagent with the same tools and get its answer back. Give it everything it needs to know; it does not see this conversation.",
				parameters: Type.Object({ task: Type.String({ description: "What the subagent should do" }) }),
				// A rerun after a crash finds the child it created and the submission it made.
				replay: "safe",
				execute: async (args, api, context) => {
					if (!limiter.tryAcquire()) {
						await api.details({ queued: true }, context);
						await limiter.acquire(context);
					}
					try {
						const child = await api.commit(async (tx) => {
							const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items.at(0);
							if (existing !== undefined) return existing.id;
							// Starts as a copy of this conversation's agent, without this extension. Children never delegate, so
							// a child never waits for a slot its parent holds and the limiter cannot deadlock.
							const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
							await configure(tx, created.id, { extensions: { remove: [subagent] } });
							return created.id;
						}, context);
						await api.details({ conversationId: child }, context);
						const handle = await api.conversation(child, context);
						if (handle === undefined) throw new Error(`Subagent conversation ${String(child)} does not exist`);
						const request = {
							type: "input",
							content: args.task,
							requestId: `subagent:${String(api.taskId)}`,
						} as const;
						const settled = await (await handle.submit(request, context)).wait(context);
						if (settled.status !== "done" || settled.type !== "input") {
							throw new Error(`Subagent ${String(child)} failed: ${settled.status}`);
						}
						const text = await answerText(api, settled.answer, context);
						return { output: [{ type: "text", text }], details: { conversationId: child } };
					} finally {
						limiter.release();
					}
				},
			}),
		],
	});
	return subagent;
}
