// Strict type check of this fork's own files (quality/tsconfig.json `include`). The program still loads the upstream
// files they import, but only diagnostics in the fork's files fail the gate: upstream code is held to the repository's
// own `tsc --noEmit`, not to these stricter flags.
import { dirname, join } from "node:path";
import ts from "typescript";

const configPath = join(import.meta.dirname, "tsconfig.json");
const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: report });
if (config === undefined) process.exit(1);
const program = ts.createProgram({ rootNames: config.fileNames, options: config.options });
const owned = new Set(config.fileNames.map((file) => ts.sys.resolvePath(file)));

const diagnostics = [
	...config.errors,
	...program.getOptionsDiagnostics(),
	...program.getGlobalDiagnostics(),
	...program
		.getSourceFiles()
		.filter((file) => owned.has(ts.sys.resolvePath(file.fileName)))
		.flatMap((file) => [...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file)]),
];
for (const diagnostic of diagnostics) report(diagnostic);
console.log(`Type checked ${String(owned.size)} files; ${String(diagnostics.length)} errors.`);
process.exit(diagnostics.length === 0 ? 0 : 1);

function report(diagnostic) {
	const host = { getCanonicalFileName: (name) => name, getCurrentDirectory: () => dirname(import.meta.dirname), getNewLine: () => "\n" };
	process.stderr.write(ts.formatDiagnostic(diagnostic, host));
}
