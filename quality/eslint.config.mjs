// Run from the repository root with `-c quality/eslint.config.mjs`.
// Strict, type-aware correctness lint for this fork's own files, with the rule set of zew1me/pi-buildout. Style and
// formatting defer to the repository's Biome configuration, so no stylistic rules here.
import { dirname } from "node:path";
import eslint from "@eslint/js";
import importX from "eslint-plugin-import-x";
import security from "eslint-plugin-security";
import sonarjs from "eslint-plugin-sonarjs";
import unicorn from "eslint-plugin-unicorn";
import globals from "globals";
import tseslint from "typescript-eslint";

const owned = [
	"packages/coding-agent/src/experimental/durable/subagent.ts",
	"packages/coding-agent/src/experimental/durable/main.ts",
	"packages/coding-agent/test/durable-*.test.ts",
];

export default tseslint.config(
	{ ignores: ["**/node_modules/**", "**/dist/**"] },
	{ files: owned, extends: [eslint.configs.recommended] },
	...tseslint.configs.strictTypeChecked.map((config) => ({ ...config, files: owned })),
	{
		files: owned,
		languageOptions: {
			globals: globals.node,
			parserOptions: { project: "./quality/tsconfig.json", tsconfigRootDir: dirname(import.meta.dirname) },
		},
		plugins: { "import-x": importX, security, sonarjs, unicorn },
		rules: {
			"import-x/no-duplicates": "error",
			"security/detect-buffer-noassert": "error",
			"security/detect-child-process": "error",
			"security/detect-eval-with-expression": "error",
			"security/detect-new-buffer": "error",
			"security/detect-non-literal-regexp": "error",
			"security/detect-pseudoRandomBytes": "error",
			"sonarjs/cognitive-complexity": ["error", 15],
			"sonarjs/no-duplicated-branches": "error",
			"sonarjs/no-identical-conditions": "error",
			"sonarjs/no-identical-expressions": "error",
			"unicorn/consistent-function-scoping": "error",
			"unicorn/filename-case": ["error", { case: "kebabCase" }],
			"unicorn/no-abusive-eslint-disable": "error",
			"unicorn/prefer-node-protocol": "error",
			"@typescript-eslint/no-confusing-void-expression": "error",
			"@typescript-eslint/no-floating-promises": "error",
			"@typescript-eslint/no-misused-promises": "error",
		},
	},
);
