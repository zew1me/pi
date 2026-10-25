# pi durable fork

A trimmed fork of [earendil-works/pi](https://github.com/earendil-works/pi). It keeps one thing working: the experimental durable coding agent. It adds a cap on how many subagents run at once.

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

**Everything outside the app's dependency tree is removed.** The fork keeps the nine packages the launch command imports: `ai`, `agent`, `chord`, `codemode`, `coding-agent`, `durable`, `mcp`, `telemetry`, `tui`.

- Each keeps its source and its full upstream test suite. The eight library packages match upstream file for file.
- coding-agent keeps its docs (the system prompt points the model at them) and the example extensions and scripts its tests load.

The `env` and `evals` packages, coding-agent's other examples, release and publish tooling, Nix files, and upstream CI are gone.

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
| Type check (TypeScript 7, repository config) | `tsc --noEmit` | all kept sources |
| Strict type check (TypeScript 5.9, `noUnused*`, `noImplicitOverride`; diagnostics in the fork's files only) | `npm --prefix quality run typecheck` | all of `experimental/durable/` and its tests |
| Type-aware lint (`strictTypeChecked`, sonarjs, security, unicorn; style defers to Biome) | `npm --prefix quality run lint:eslint` | `subagent.ts`, `main.ts`, the tests |
| Markdown lint | `npm --prefix quality run lint:markdown` | this README and the app README |
| Secret scan | `npm --prefix quality run secrets` | the fork's files |
| Fork tests with coverage thresholds | `npm run test:fork` | `subagent.ts`: limiter unit tests, and the subagent tool on a real Harness with a faux model |
| Every package's upstream tests (pi-durable also with zero document retention and in workerd) | `./test.sh` (runs `npm test`) | all nine packages |

Set up once:

```bash
npm ci --ignore-scripts
npm --prefix quality ci --ignore-scripts
npm run hydrate:model-data   # packages/ai imports generated, gitignored provider data
npx husky                    # installs the git hooks; --ignore-scripts skips this
```

The tests also need `fd` and `ripgrep` (the find and grep tools; on macOS `brew install fd ripgrep`). If `bun` is on PATH, codemode's Bun tests run too and need Bun 1.4 or newer.

- **Why the build.** As upstream, some package tests load other packages' `dist/` output, so `npm run build` comes first. It builds the nine packages, with ai's offline build and coding-agent's unbundled build.
- **No API keys.** `./test.sh` runs everything in an isolated home without credentials, so end-to-end tests skip. Run tests through it: a plain `vitest` run picks up the logins in `~/.pi` and makes paid requests.

Scope notes:

- `runtime.ts` and `tui.ts` are mostly upstream code. The lines this fork changed in them pass the strict lint; the files as a whole are not in the ESLint gate, because the upstream code in them fails it.
- pi-buildout's knip (unused code and dependencies) is left out: it scans whole workspaces, and here it would report upstream code rather than the fork's.

## Updating from upstream

```bash
git fetch upstream
git merge upstream/main
```

Upstream changes to files this fork deleted show up as modify/delete conflicts; resolve them by keeping the deletion (`git rm`). After the merge, run `npm run build && npm run check && ./test.sh`. API changes in `pi-durable` surface as type errors in `packages/coding-agent/src/experimental/durable/`.

## License

MIT, as upstream. See [LICENSE](LICENSE).
