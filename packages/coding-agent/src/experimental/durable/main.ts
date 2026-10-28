#!/usr/bin/env node

import { type OpenDurableOptions, openDurable } from "./runtime.ts";
import { parseSubagentLimit, SUBAGENT_LIMIT_ENV } from "./subagent.ts";
import { runDurableTui } from "./tui.ts";

function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv): OpenDurableOptions {
	let continueSession = false;
	for (const arg of argv) {
		if (arg === "--continue" || arg === "-c") continueSession = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return { continueSession, subagentLimit: parseSubagentLimit(env[SUBAGENT_LIMIT_ENV]) };
}

const durable = await openDurable(parseArgs(process.argv.slice(2), process.env));
try {
	await runDurableTui(durable.view, durable.controller, durable.settings);
} finally {
	await durable.close();
}
