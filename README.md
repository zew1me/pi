# pi durable fork

A focused fork of [earendil-works/pi](https://github.com/earendil-works/pi). It restores the experimental durable coding agent, retains the libraries and reference material useful for building on it, and adds a cap on concurrent subagents.

```bash
npm ci --ignore-scripts
npm run hydrate:model-data
node --import ./packages/coding-agent/src/experimental/source-resolver.ts packages/coding-agent/src/experimental/durable/main.ts
```

`npm start` runs the same command; pass arguments after `--` (`npm start -- --continue`). Use `--continue` (or `-c`) to reopen the newest session for the current directory. Log in with pi itself; credentials are shared through `~/.pi/agent`.

## Why this fork exists

**The app was removed upstream.** Upstream commit `7472cda0d` removed the experimental durable app (`packages/coding-agent/src/experimental/durable/`) together with the server/client stack. The only way to run it was an older checkout at `v1.0.0`, pinned to an older `pi-durable` API. This fork restores the app from `7472cda0d^` on top of current upstream. It ports the app to the API changes made since then:

- `Conversation.watch()` and `Harness.watchTaskGraph()` replace `viewState()` and `taskGraph()`.
- Tool results return `output` instead of `content`.

**Subagent fan-out had no limit.** The app's `subagent` tool runs each delegated task in its own child conversation. Tools in one model answer run in parallel. So an answer with 12 `subagent` calls started 12 conversations at once, each streaming its own model requests. That causes rate limits, cost spikes, and a task panel nobody can follow. This fork caps the number of subagents running at once; the rest wait in arrival order.

**Keep potential durable integrations, not just today's imports.** All eleven upstream packages are retained, with their source and unit tests:

- `ai`, `agent`, `chord`, `codemode`, `coding-agent`, `durable`, `mcp`, `telemetry`, and `tui` support the local app.
- `env` implements Durable's `ExecutionEnv` over a Rust daemon and SSH. It is available for remote agents; the app still selects `NodeExecutionEnv` locally.
- `evals` preserves reusable evaluation infrastructure. Its current adapter targets classic Pi, not Durable; restoring it does not add durable behavioral coverage. Real-model evals remain opt-in and may incur costs.
- coding-agent's complete docs and examples remain available because the durable system prompt directs the model to them. Shared model, auth, settings, and TUI examples are useful references; classic extensions, RPC, and SDK sessions are not drop-in durable integrations.

Classic-only installation locks and the old JSONL session migration remain removed. Release/publish automation and Nix files remain out of scope. Consumer-install helpers, bundled builds, and browser/entry-graph checks are retained where the restored tooling needs them.

## Subagent concurrency cap

| How | Example | Scope | Takes effect |
| --- | --- | --- | --- |
| Environment, at startup | `PI_SUBAGENT_MAX_CONCURRENCY=2` | this process | at start |
| TUI command | `/subagents 6`, `/subagents off`, `/subagents` (show) | this process | at once for waiting calls |

- **Default and "no cap".** The default is no cap, as upstream: every subagent call starts at once. `off`, `none`, `unlimited`, or `0` also mean no cap.
- **Precedence.** The environment variable sets the starting value; `/subagents` replaces it until the process exits. The value is not stored in the session, so `--continue` starts from the environment again.
- **Prior art.** The variable name and its meaning follow the community pi-subagent extensions ([oira666/pi-subagent](https://pi.dev/packages/oira666_pi-subagent), [smoosex/pi-subagent](https://cdn.jsdelivr.net/gh/smoosex/pi-subagent@main/README.md)), and upstream PR [#2487](https://github.com/earendil-works/pi/pull/2487) proposed a similar `maxParallelTools` semaphore. All three target the classic pi agent loop and extension API, not pi-durable, so none of their code applies here. This limiter is built on pi-durable's own model: a replay-safe registry tool, child conversations owned by the call's task, and calls that queue again when a restarted Harness replays them.

How it behaves:

- **Order.** Waiting calls start first-come, first-served. A queued call shows "Subagent queued" in its tool card, and the footer shows `subagents 2/4 running, 3 queued`.
- **Raising and lowering.** Raising the cap starts waiting calls at once. Lowering it never stops a running subagent; new ones wait until enough have finished.
- **Aborting.** Esc aborts queued calls as well as running ones.
- **Restart.** After a crash or restart, replayed subagent calls queue again, so the cap holds across `--continue`.
- **No deadlock.** Child conversations never get the `subagent` tool, so a child can never wait for a slot its parent holds.

Other ways to set the cap were considered and left out:

- **settings.json.** It would need a pi settings schema change; the environment variable covers it.
- **The model setting it through a tool.** The cap protects the user's budget, so the model must not be able to raise it.
- **A per-call `maxParallel` parameter.** It overlaps with the global cap.

The code is in [`packages/coding-agent/src/experimental/durable/subagent.ts`](packages/coding-agent/src/experimental/durable/subagent.ts) (`SubagentLimiter`, `createSubagent`). The app's own README is [`packages/coding-agent/src/experimental/durable/README.md`](packages/coding-agent/src/experimental/durable/README.md).

## Quality gate

The full gate is `npm run build && npm run check && ./test.sh`. It runs in the pre-push hook and in CI (`.github/workflows/check.yml`); the pre-commit hook runs `npm run check`. Upstream code stays under upstream's Biome and `tsc` configuration. The fork's own files are held to the stricter gate of [zew1me/pi-buildout](https://github.com/zew1me/pi-buildout), from the separately installed `quality/` package.

| Check | Command | Covers |
| --- | --- | --- |
| Format and lint (repository style) | `node scripts/biome-check.mjs` | all kept sources |
| Type check (TypeScript 7, repository config) | `tsc --noEmit` and evals' config | sources, tests, examples, eval definitions and Docker entrypoint |
| Strict type check (TypeScript 5.9, `noUnused*`, `noImplicitOverride`; diagnostics in the fork's files only) | `npm --prefix quality run typecheck` | all of `experimental/durable/` and its tests |
| Type-aware lint (`strictTypeChecked`, sonarjs, security, unicorn; style defers to Biome) | `npm --prefix quality run lint:eslint` | `subagent.ts`, `main.ts`, the tests |
| Markdown lint | `npm --prefix quality run lint:markdown` | this README and the app README |
| Secret scan | `npm --prefix quality run secrets` | the fork's files |
| Fork tests with coverage thresholds | `npm run test:fork` | `subagent.ts`: limiter unit tests, and the subagent tool on a real Harness with a faux model |
| Every package's upstream tests (pi-durable also with zero document retention and in workerd) | `./test.sh` | all eleven packages, restored script tests, Rust daemon tests; no real-model evals |
| Rust format and lint | `npm run check:daemon` | env daemon, including its unit tests |
| Browser compatibility and dependency budgets | `npm run check:browser-smoke` and `npm run check:entry-graphs` | retained library entrypoints, including Durable |
| Eval image builds (CI only) | Docker builds both documentation variants | consumer installation and bundled runtime; no model requests |

Set up once:

```bash
npm ci --ignore-scripts
npm --prefix quality ci --ignore-scripts
npm run hydrate:model-data   # packages/ai imports generated, gitignored provider data
npx husky                    # installs the git hooks; --ignore-scripts skips this
# With rustup installed; daemon/rust-toolchain.toml pins the version:
rustup toolchain install 1.96.0 --component rustfmt --component clippy
```

The tests also need `fd` and `ripgrep` (the find and grep tools; on macOS `brew install fd ripgrep`). SSH bootstrap tests need OpenSSH client/server; CI installs them and creates `/run/sshd`. Docker is needed for eval image builds, not unit tests. If `bun` is on PATH, codemode's Bun tests run too and need Bun 1.4 or newer.

- **Why the build.** Some package tests load other packages' `dist/` output, and env tests need the daemon. `npm run build` builds the ten runtime packages, including coding-agent's bundle, then the Rust daemon. `build:offline` builds only the TypeScript packages from hydrated model data, so eval images do not need Rust.
- **No API keys.** `./test.sh` runs Rust tests using Cargo's cache, then JavaScript tests in an isolated home without credentials, so end-to-end tests skip. Run tests through it: a plain `vitest` run picks up the logins in `~/.pi` and makes paid requests. Evals' normal `test` command selects unit tests only; `npm run eval` is separate and must not be added to the gate.

Scope notes:

- `runtime.ts` and `tui.ts` are mostly upstream code. The lines this fork changed in them pass the strict lint; the files as a whole are not in the ESLint gate, because the upstream code in them fails it.
- pi-buildout's knip (unused code and dependencies) is left out: it scans whole workspaces, and here it would report upstream code rather than the fork's.

## Updating from upstream

```bash
git fetch upstream
git merge upstream/main
```

Upstream changes to deleted files show up as modify/delete conflicts. Review their purpose before resolving them: preserve code and references useful for durable agents, even if the current app does not import them. After the merge, run `npm run build && npm run check && ./test.sh`. API changes in `pi-durable` surface as type errors in the app and remote environment implementations.

## License

MIT, as upstream. See [LICENSE](LICENSE).
