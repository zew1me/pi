import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stream } from "../src/api/openai-completions.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const unsupportedModelIds = ["deepseek-v4-flash", "deepseek-v4-pro", "kimi-k2.5", "kimi-k2.6", "minimax-m2.7"];
const controlModelId = "unlisted-control-model";
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
let root: string | undefined;
let models: Record<string, Model<"openai-completions">> = {};

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "pi-opencode-cache-generation-"));
	const preloadPath = join(root, "mock-catalog.mjs");
	const outputPath = join(root, "catalog");
	const catalog = {
		opencode: {
			models: Object.fromEntries(
				[...unsupportedModelIds, controlModelId].map((id) => [id, { id, tool_call: true, reasoning: false }]),
			),
		},
	};
	writeFileSync(
		preloadPath,
		`const catalog = ${JSON.stringify(catalog)};\n` +
			`globalThis.fetch = async (input) => {\n` +
			`  const url = String(input);\n` +
			`  if (url === "https://models.dev/api.json") return Response.json(catalog);\n` +
			`  if (url === "https://models.dev/models.json?type=decision") return Response.json({ "typesafe/jev-latest": { name: "Jev", type: "decision", limit: { context: 64000, output: 0 } } });\n` +
			`  if (url.startsWith("https://openrouter.ai/api/v1/models") || url === "https://ai-gateway.vercel.sh/v1/models") return Response.json({ data: [] });\n` +
			`  if (url === "https://radius.pi.dev/v1/config") return Response.json({ baseUrl: "https://radius.pi.dev", models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 4096 }] });\n` +
			`  throw new Error(\`Unexpected fetch: \${url}\`);\n` +
			`};\n`,
	);
	// Run only the local generator with a fetch mock; no shell or provider requests.
	const result = spawnSync(
		process.execPath,
		[
			"--import",
			pathToFileURL(preloadPath).href,
			"scripts/generate-models.ts",
			"--json-only",
			"--json-output",
			outputPath,
		],
		{ cwd: packageRoot, encoding: "utf8", timeout: 10_000 },
	);
	expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
	expect(result.stderr).toBe("");
	models = JSON.parse(readFileSync(join(outputPath, "providers/opencode.json"), "utf8")) as Record<
		string,
		Model<"openai-completions">
	>;
});

afterAll(() => {
	if (root !== undefined) rmSync(root, { force: true, recursive: true });
});

describe("OpenCode cache retention", () => {
	// Regression for #2 and #3: live catalog removals must not break this compatibility regression.
	it.each(unsupportedModelIds)("omits long cache retention for generated %s metadata", async (id) => {
		const model = models[id];
		expect(model.api).toBe("openai-completions");
		expect(model.compat?.supportsLongCacheRetention).toBe(false);
		let payload: { prompt_cache_key?: string; prompt_cache_retention?: string } | undefined;
		await stream(model, normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 0 }] }), {
			apiKey: "fake-key",
			cacheRetention: "long",
			sessionId: "session-opencode-long-cache-unsupported",
			onPayload: (value) => {
				payload = value as NonNullable<typeof payload>;
				throw new Error("payload captured");
			},
		}).result();
		expect(payload).toBeDefined();
		expect(payload?.prompt_cache_key).toBeUndefined();
		expect(payload?.prompt_cache_retention).toBeUndefined();
	});

	it("does not disable long cache retention for an unlisted model", () => {
		expect(models[controlModelId].compat?.supportsLongCacheRetention).toBeUndefined();
	});
});
