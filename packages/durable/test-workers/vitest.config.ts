import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import baseConfig from "../../../vitest.base.ts";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));
// Workspace packages resolve to their sources (vitest.base.ts), so tests run without building them.
const workspaceAliases = (baseConfig.resolve?.alias ?? []) as { find: RegExp; replacement: string }[];

// Runs in workerd: the Durable Object storage, alarms, and eviction are Cloudflare's own.
export default defineConfig({
	root: source("."),
	plugins: [cloudflareTest({ wrangler: { configPath: source("./wrangler.jsonc") } })],
	test: { include: ["*.test.ts"] },
	resolve: {
		conditions: ["source"],
		alias: [
			...workspaceAliases,
			{ find: /^@earendil-works\/pi-durable$/, replacement: source("../src/index.ts") },
			{ find: /^@earendil-works\/pi-durable\/testing$/, replacement: source("../src/testing/index.ts") },
			{
				find: /^@earendil-works\/pi-durable\/storage\/sqlite\/cloudflare$/,
				replacement: source("../src/storage/sqlite/cloudflare.ts"),
			},
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
});
