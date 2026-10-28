import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import {
	type AssistantMessage,
	createModels,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { describe, expect, it } from "vitest";
import {
	createSubagent,
	DEFAULT_SUBAGENT_LIMIT,
	formatSubagentLimit,
	formatSubagentSlots,
	parseSubagentLimit,
	SubagentLimiter,
} from "../src/experimental/durable/subagent.ts";

const context = BACKGROUND_CONTEXT;

/** Resolves once every queued microtask and timer callback before it ran. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("parseSubagentLimit", () => {
	it("reads a positive integer, off, or the fallback", () => {
		expect(parseSubagentLimit(undefined)).toBe(DEFAULT_SUBAGENT_LIMIT);
		expect(parseSubagentLimit("  ")).toBe(DEFAULT_SUBAGENT_LIMIT);
		expect(parseSubagentLimit("", 7)).toBe(7);
		expect(parseSubagentLimit(" 3 ")).toBe(3);
		for (const off of ["off", "OFF", "none", "unlimited", "0"]) {
			expect(parseSubagentLimit(off)).toBe(Number.POSITIVE_INFINITY);
		}
	});

	it("rejects anything else", () => {
		for (const bad of ["-1", "1.5", "two", "3x", "Infinity"]) {
			expect(() => parseSubagentLimit(bad)).toThrow(/Invalid subagent limit/);
		}
	});

	it("formats no cap as off", () => {
		expect(formatSubagentLimit(Number.POSITIVE_INFINITY)).toBe("off");
		expect(formatSubagentLimit(2)).toBe("2");
	});

	it("formats slots with the queue only when something waits", () => {
		expect(formatSubagentSlots({ running: 2, queued: 0, limit: 4 })).toBe("2/4 running");
		expect(formatSubagentSlots({ running: 4, queued: 3, limit: 4 })).toBe("4/4 running, 3 queued");
		expect(formatSubagentSlots({ running: 1, queued: 0, limit: Number.POSITIVE_INFINITY })).toBe("1/off running");
	});
});

describe("SubagentLimiter", () => {
	it("rejects limits that are not positive integers", () => {
		for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => new SubagentLimiter(bad)).toThrow();
		expect(() => {
			new SubagentLimiter(1).setLimit(0);
		}).toThrow();
	});

	it("never runs more than the limit and starts waiters in arrival order", async () => {
		const limiter = new SubagentLimiter(2);
		const started: number[] = [];
		const waits = [1, 2, 3, 4].map((id) => limiter.acquire(context).then(() => started.push(id)));
		await tick();
		expect(started).toEqual([1, 2]);
		expect(limiter.snapshot()).toEqual({ running: 2, queued: 2, limit: 2 });
		limiter.release();
		await tick();
		expect(started).toEqual([1, 2, 3]);
		limiter.release();
		await Promise.all(waits);
		expect(started).toEqual([1, 2, 3, 4]);
		expect(limiter.snapshot()).toEqual({ running: 2, queued: 0, limit: 2 });
	});

	it("tryAcquire never jumps the queue", async () => {
		const limiter = new SubagentLimiter(1);
		expect(limiter.tryAcquire()).toBe(true);
		const waiting = limiter.acquire(context);
		limiter.release();
		// The slot went to the waiter, not to a later tryAcquire().
		expect(limiter.tryAcquire()).toBe(false);
		await waiting;
		expect(limiter.snapshot().running).toBe(1);
	});

	it("raising the limit starts waiters; lowering it never stops running work", async () => {
		const limiter = new SubagentLimiter(1);
		await limiter.acquire(context);
		const second = limiter.acquire(context);
		const third = limiter.acquire(context);
		limiter.setLimit(3);
		await Promise.all([second, third]);
		expect(limiter.snapshot()).toEqual({ running: 3, queued: 0, limit: 3 });

		limiter.setLimit(1);
		expect(limiter.snapshot().running).toBe(3);
		let fourthStarted = false;
		const fourth = limiter.acquire(context).then(() => {
			fourthStarted = true;
		});
		limiter.release();
		limiter.release();
		await tick();
		// Two running left the count at the new limit of 1: still full.
		expect(fourthStarted).toBe(false);
		limiter.release();
		await fourth;
		expect(limiter.snapshot()).toEqual({ running: 1, queued: 0, limit: 1 });
	});

	it("an aborted waiter leaves the queue and rejects with the abort reason", async () => {
		const limiter = new SubagentLimiter(1);
		await limiter.acquire(context);
		const controller = new AbortController();
		const waiting = limiter.acquire(withAbortSignal(controller.signal, context));
		const after = limiter.acquire(context);
		expect(limiter.snapshot().queued).toBe(2);
		const reason = new Error("stop");
		controller.abort(reason);
		await expect(waiting).rejects.toBe(reason);
		expect(limiter.snapshot().queued).toBe(1);
		limiter.release();
		await after;
		expect(limiter.snapshot()).toEqual({ running: 1, queued: 0, limit: 1 });
	});

	it("wraps an abort reason that is not an Error", async () => {
		const limiter = new SubagentLimiter(1);
		await limiter.acquire(context);
		const controller = new AbortController();
		const waiting = limiter.acquire(withAbortSignal(controller.signal, context));
		controller.abort("user pressed Esc");
		const error = await waiting.then(
			() => undefined,
			(rejection: unknown) => rejection,
		);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).cause).toBe("user pressed Esc");
	});

	it("rejects at once when already aborted, and on a release without a slot", async () => {
		const limiter = new SubagentLimiter(1);
		const controller = new AbortController();
		controller.abort(new Error("gone"));
		await expect(limiter.acquire(withAbortSignal(controller.signal, context))).rejects.toThrow("gone");
		expect(limiter.snapshot()).toEqual({ running: 0, queued: 0, limit: 1 });
		expect(() => {
			limiter.release();
		}).toThrow(/without a held slot/);
	});

	it("notifies subscribers until they unsubscribe", () => {
		const limiter = new SubagentLimiter(1);
		let calls = 0;
		const unsubscribe = limiter.subscribe(() => {
			calls++;
		});
		limiter.tryAcquire();
		limiter.release();
		limiter.setLimit(2);
		expect(calls).toBe(3);
		unsubscribe();
		limiter.tryAcquire();
		expect(calls).toBe(3);
	});
});

/** The first user message of a model request: "go" for the main conversation, the task for a subagent. */
function firstUserText(messages: readonly { role: string; content: unknown }[]): string {
	const first = messages.find((message) => message.role === "user");
	return typeof first?.content === "string" ? first.content : "";
}

/**
 * The main conversation delegates `tasks` subagents in one round. A barrier holds each subagent's model request until
 * as many run as the limit allows (or as remain), then releases them together, so `maxActive` does not depend on timing.
 * The fallback timer only matters when fewer start than allowed; the assertions then fail instead of hanging.
 */
async function run(limit: number, tasks: number, options: { readonly failTask?: string } = {}) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const limiter = new SubagentLimiter(limit);
	const registry = createRegistry();
	registry.install(createSubagent(limiter));
	let active = 0;
	let maxActive = 0;
	let maxQueued = 0;
	let completed = 0;
	let held: (() => void)[] = [];
	const releaseHeld = (): void => {
		for (const release of held) release();
		held = [];
	};
	limiter.subscribe(() => {
		maxQueued = Math.max(maxQueued, limiter.snapshot().queued);
	});
	const step: FauxResponseStep = async (request): Promise<AssistantMessage> => {
		const first = firstUserText(request.messages);
		if (first === "go") {
			const answered = request.messages.some((message) => message.role === "toolResult");
			if (answered) return fauxAssistantMessage([fauxText("all done")]);
			const calls = Array.from({ length: tasks }, (_, index) =>
				fauxToolCall("subagent", { task: `task ${String(index)}` }, { id: `call-${String(index)}` }),
			);
			return fauxAssistantMessage(calls, { stopReason: "toolUse" });
		}
		active++;
		maxActive = Math.max(maxActive, active);
		await new Promise<void>((resolve) => {
			held.push(resolve);
			if (active >= Math.min(limit, tasks - completed)) releaseHeld();
			else setTimeout(releaseHeld, 2000);
		});
		// Stay active a little longer, so a limiter that admitted one too many would overlap and be counted.
		await new Promise((resolve) => setTimeout(resolve, 5));
		active--;
		completed++;
		if (first === options.failTask) {
			return fauxAssistantMessage([fauxText("")], { stopReason: "error", errorMessage: "provider down" });
		}
		return fauxAssistantMessage([fauxText(`answer to ${first}`)]);
	};
	faux.setResponses(Array.from({ length: tasks + 2 }, () => step));
	// No retries, so a failed subagent fails at once.
	const settings = { retry: { enabled: false } };
	const harness = await Harness.open(new MemoryStorage(), { models, registry, settings }, context);
	try {
		const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		const settled = await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		const page = await root.entries({}, 1000, undefined, context);
		const results = page.items
			.flatMap((entry) => entry.model ?? [])
			.filter((message): message is ToolResultMessage => message.role === "toolResult")
			.map(
				(message) =>
					`${message.isError ? "error: " : ""}${message.content.map((item) => (item.type === "text" ? item.text : "")).join("")}`,
			)
			.sort();
		return { status: settled.status, results, maxActive, maxQueued, final: limiter.snapshot() };
	} finally {
		await harness.close(context);
	}
}

describe("subagent tool with a limiter", () => {
	it("runs at most the limit of subagents at once and answers every call", async () => {
		const outcome = await run(2, 5);
		expect(outcome.status).toBe("done");
		expect(outcome.results).toEqual([0, 1, 2, 3, 4].map((index) => `answer to task ${String(index)}`));
		expect(outcome.maxActive).toBe(2);
		expect(outcome.maxQueued).toBe(3);
		expect(outcome.final).toEqual({ running: 0, queued: 0, limit: 2 });
	});

	it("runs them one at a time with a limit of 1", async () => {
		const outcome = await run(1, 3);
		expect(outcome.status).toBe("done");
		expect(outcome.maxActive).toBe(1);
		expect(outcome.final.running).toBe(0);
	});

	it("runs them all at once without a cap", async () => {
		const outcome = await run(Number.POSITIVE_INFINITY, 4);
		expect(outcome.status).toBe("done");
		expect(outcome.maxActive).toBe(4);
		expect(outcome.maxQueued).toBe(0);
	});

	it("frees the slot of a failed subagent, so the queued ones still run", async () => {
		const outcome = await run(1, 3, { failTask: "task 0" });
		expect(outcome.status).toBe("done");
		expect(outcome.results).toEqual([
			"answer to task 1",
			"answer to task 2",
			expect.stringMatching(/^error: [\s\S]*Subagent \d+ failed: unanswered/) as unknown as string,
		]);
		expect(outcome.final).toEqual({ running: 0, queued: 0, limit: 1 });
	});

	it("after a restart, a replayed call reuses its child and still waits for a slot", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-subagent-limit-"));
		try {
			const database = join(directory, "session.sqlite");
			const faux = fauxProvider();
			const models = createModels();
			models.setProvider(faux.provider);
			const settings = { retry: { enabled: false } };
			const delegate = fauxAssistantMessage(
				[0, 1].map((index) =>
					fauxToolCall("subagent", { task: `task ${String(index)}` }, { id: `call-${String(index)}` }),
				),
				{ stopReason: "toolUse" },
			);

			// First process: task 0 runs and hangs in its model request, task 1 waits for the only slot; then it stops.
			let hung: () => void = () => undefined;
			const hanging = new Promise<void>((resolve) => {
				hung = resolve;
			});
			const hang: FauxResponseStep = (_request, options) =>
				new Promise<AssistantMessage>((_resolve, reject) => {
					hung();
					options?.signal?.addEventListener("abort", () => {
						reject(new Error("closed"));
					});
				});
			faux.setResponses([delegate, hang]);
			const first = new SubagentLimiter(1);
			const firstRegistry = createRegistry();
			firstRegistry.install(createSubagent(first));
			let harness = await Harness.open(
				await openNodeSqliteStorage(database),
				{ models, registry: firstRegistry, settings },
				context,
			);
			let root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
			const submissionId = (await root.submit({ type: "input", content: "go" }, context)).id;
			await hanging;
			expect(first.snapshot()).toEqual({ running: 1, queued: 1, limit: 1 });
			await harness.close(context);

			// Second process: the replayed calls queue again behind a new limiter, and task 0 reuses its child.
			let active = 0;
			let maxActive = 0;
			const answer: FauxResponseStep = async (request) => {
				const task = firstUserText(request.messages);
				if (task === "go") return fauxAssistantMessage([fauxText("all done")]);
				active++;
				maxActive = Math.max(maxActive, active);
				await new Promise((resolve) => setTimeout(resolve, 20));
				active--;
				return fauxAssistantMessage([fauxText(`answer to ${task}`)]);
			};
			faux.setResponses([answer, answer, answer]);
			const second = new SubagentLimiter(1);
			const secondRegistry = createRegistry();
			secondRegistry.install(createSubagent(second));
			harness = await Harness.open(
				await openNodeSqliteStorage(database),
				{ models, registry: secondRegistry, settings },
				context,
			);
			try {
				root = await harness.root(context);
				harness.resume();
				const submission = await harness.submission(submissionId, context);
				expect((await submission?.wait(context))?.status).toBe("done");
				await harness.waitForIdle(context);
				const conversations = await harness.commit((tx) => tx.scanConversations({}, 100), context);
				// The main conversation and one child per call: the replayed call did not create a second child.
				expect(conversations.items).toHaveLength(3);
				expect(maxActive).toBe(1);
				expect(second.snapshot()).toEqual({ running: 0, queued: 0, limit: 1 });
			} finally {
				await harness.close(context);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("aborting the conversation aborts queued subagent calls and frees every slot", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const limiter = new SubagentLimiter(1);
		const registry = createRegistry();
		registry.install(createSubagent(limiter));
		const delegate = fauxAssistantMessage(
			[0, 1].map((index) =>
				fauxToolCall("subagent", { task: `task ${String(index)}` }, { id: `call-${String(index)}` }),
			),
			{ stopReason: "toolUse" },
		);
		// Task 0 holds the only slot until its request is aborted.
		const hang: FauxResponseStep = (_request, options) =>
			new Promise<AssistantMessage>((_resolve, reject) => {
				options?.signal?.addEventListener("abort", () => {
					reject(new Error("aborted"));
				});
			});
		faux.setResponses([delegate, hang, hang]);
		const queued = new Promise<void>((resolve) => {
			limiter.subscribe(() => {
				if (limiter.snapshot().queued === 1) resolve();
			});
		});
		const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
		try {
			const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
			const submission = await root.submit({ type: "input", content: "go" }, context);
			await queued;
			await root.abort(context);
			const settled = await submission.wait(context);
			expect(settled).toMatchObject({ status: "unanswered", reason: "aborted" });
			await harness.waitForIdle(context);
			expect(limiter.snapshot()).toEqual({ running: 0, queued: 0, limit: 1 });
		} finally {
			await harness.close(context);
		}
	});
});
