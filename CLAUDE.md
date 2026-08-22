# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Agent Flow Deck is a VS Code / Cursor extension: TypeScript on the extension host, React
webviews, esbuild bundles, Vitest tests. [CONTRIBUTING.md](CONTRIBUTING.md) has the full
directory map and the contribution rules; this file covers the commands, the shape of the
system, and the invariants that are expensive to rediscover.

## Commands

```bash
npm run build            # bundle host + 3 webviews into dist/ (esbuild)
npm run watch            # same, watch mode
npm run typecheck        # tsc --noEmit
npm test                 # full Vitest suite
npm run test:cov         # + V8 coverage, thresholds enforced
npm run package          # rm -f *.vsix && vsce package --no-dependencies
```

Running a subset — the suite is large, so prefer this while iterating:

```bash
npx vitest run test/unit/engine/worktree.test.ts     # one file
npx vitest run test/webview -t "retires a run"       # one test by name
```

**`npm test` is ~4,500 tests across 122 files and takes 2+ minutes** — much longer under CPU
contention from parallel sessions. It exceeds the default Bash tool timeout and will
auto-background at 120s, so pass `timeout: 600000` when running it through a tool. Never pipe
vitest through `tail`/`head`: it loses the failure list you need. A single failure under heavy
contention is usually flake, not a regression — re-run that file alone before believing it.

The CI gate (`.github/workflows/ci.yml`) is exactly: `npm ci`, `npm run typecheck`,
`npm test`, `npm run build`. All four must pass. `npm run build` is a real gate, not a
formality — see the webview import rule below.

Dev host: press **F5** ("Run Agent Flow Deck"). If launching from a terminal, only VS
Code's own `code --extensionDevelopmentPath=…` works; the Cursor CLI silently drops the flag.

## Architecture

Four bundles come out of [esbuild.js](esbuild.js): the extension host (`src/extension.ts`,
Node/CJS) and three independent browser IIFEs — the sidebar (`src/webview/index.tsx`), the
Deck (`src/webview/deck.tsx`), and the Marketplace (`src/webview/marketplace.tsx`). Host and
webview only ever talk through the message types in [src/types.ts](src/types.ts).

The split that matters: **views do I/O, `src/engine/` holds the logic.** Each
`*View.ts` ([tasksView.ts](src/tasksView.ts), [deckView.ts](src/deckView.ts),
[marketplaceView.ts](src/marketplaceView.ts), [doctorView.ts](src/doctorView.ts)) is a thin
host-side shell; the decisions live in `src/engine/` as pure functions over injected
readers, which is why they are testable without a running editor.

Four seams carry most of the design:

- **Task source** — everything ticket-shaped goes through `TaskProvider` in
  [src/tasks/provider.ts](src/tasks/provider.ts) with a capability record, never into
  `src/tasks/jira/` directly. A source that has no sprints hides that lens rather than
  faking it. See [docs/CONNECTORS.md](docs/CONNECTORS.md).
- **Forge** — pull/merge requests, branch CI and review requests go through `Forge` in
  [src/engine/forge/types.ts](src/engine/forge/types.ts), selected by `agentFlow.forge`
  (`gh` or `glab`). Degradation is stated, never faked. See
  [docs/FORGES.md](docs/FORGES.md).
- **The session seed** — one chokepoint in [src/engine/workspace.ts](src/engine/workspace.ts)
  that every launch path goes through (take, batch, Explore, Notepad, Deck relaunch, Address
  PR, Review with your agent tool). It resolves `agentFlow.agentProvider` × `agentFlow.agentSurface`
  **at seed time in the target window**, never from the plan file, so flipping a setting also
  changes plans already on disk.
- **Pure vs. `*Fs`** — where logic needs the filesystem, the arithmetic and rules live in a
  pure module and the reads live beside it in a `*Fs.ts`
  ([claudeAssets.ts](src/engine/claudeAssets.ts) / [claudeAssetsFs.ts](src/engine/claudeAssetsFs.ts),
  [usage.ts](src/engine/usage.ts) / [usageFs.ts](src/engine/usageFs.ts)). Follow this split
  when a webview needs any part of the result.

[src/engine/orchestrator/](src/engine/orchestrator/) is the Deck's flow machine — a graph of
nodes joined by rules, where what a rule *does* is derived from the node it points at rather
than stored. Flows are global (`~/.agentflow/flows`) and shared across windows behind a lock,
and the Deck evaluates one pass every 6s. Gated by `agentFlow.orchestrator`.
[docs/ORCHESTRATOR_COMMANDS.md](docs/ORCHESTRATOR_COMMANDS.md) is authoritative over the
spec — when they disagree, the code wins.

State lives outside the workspace on purpose, and in three different places for three
different reasons: the Notepad in `globalState` (per editor, so it follows you between
repos), Jira credentials in `SecretStorage`, and everything cross-window under
`~/.agentflow/` — `runs/` is the Deck's durable one-file-per-task record
([runs.ts](src/engine/runs.ts)), `plans/` is the transient handshake the session seed
consumes, `flows/` is the orchestrator's. Live session signal is read best-effort from Claude
Code's own `~/.claude/projects` transcripts ([transcript.ts](src/engine/transcript.ts),
[sessions.ts](src/engine/sessions.ts)) — never assume it is present.

## Invariants

- **Vocabulary.** A **session** is one run of a coding tool — one Deck card, one
  row in `run.agents[]`. An **agent** is a worker a session delegates to (the
  Marketplace's Agents tab, `.claude/agents/`). The tool itself is named
  — "Review with Claude Code" — never called "the agent". Identifiers, setting
  ids, stored values and orchestrator condition keys keep their released
  spelling, so the code says `agents` where the UI says sessions.
  `test/unit/vocabulary.test.ts` enforces this; its allowlist records every
  place "agent" is still correct.
- **Webviews cannot reach Node.** Any module reachable from a browser entry point that
  imports `fs`, `os`, `path`, `child_process` (etc.) breaks `npm run build` even if the code
  never runs — esbuild resolves statically. `tsc` and most of the suite pass regardless;
  the near-gate is [test/webview/webviewGraph.test.ts](test/webview/webviewGraph.test.ts),
  which walks the real import graph — but it follows *relative* imports only, so a bare npm
  specifier that requires `fs` passes the test and still breaks the build. Adding a fourth
  browser bundle means editing its `BROWSER_ENTRIES` list too. The fix for a violation is to
  extract the pure part into a leaf module (as `engine/activity.ts` did for `mostActive`),
  not to reshuffle the caller.
- **Never break existing users.** The extension has thousands of installs.
  [test/unit/compat.test.ts](test/unit/compat.test.ts) freezes the released surface —
  SecretStorage keys, `globalState`/`workspaceState` keys, settings and command ids in the
  manifest, telemetry wire values, and the on-disk run shape. New behavior ships inert
  (default-off setting) and the existing suite must pass **unmodified**; a test you had to
  edit to go green is the signal to stop.
- **No hardcoded organization values.** Jira site, project key, repo layout, blocklists,
  labels — all `agentFlow.*` settings read through `getConfig()` in
  [src/config.ts](src/config.ts), collected in the first-run wizard
  ([src/setup.ts](src/setup.ts)) where it fits.
- **Docs are tested.** [test/unit/docs.test.ts](test/unit/docs.test.ts) asserts that every
  registered connector and forge is documented. Registering one without a docs entry fails
  CI.
- **Tests and coverage.** Add or update tests for any behavior change; thresholds in
  [vitest.config.ts](vitest.config.ts) are enforced by `npm run test:cov` (90% lines /
  statements, 85% branches / functions). `vscode` is aliased to the hand-written mock in
  `test/_mocks/vscode.ts`. Webview test files opt into jsdom with a
  `// @vitest-environment jsdom` docblock.
- **Async reads leak across webview tests.** A `FileReader` can outlive a `setTimeout(0)`,
  landing its `postMessage` in the *next* test. Assert with `waitFor`, never a bare tick.
- **jsdom is blind to drag.** An element with `draggable` cannot be text-selected in Blink,
  and `preventDefault` on `dragstart` does not give the gesture back. jsdom will not catch
  it — verify drag/selection interactions in a real editor window.
- **The public registry is pinned.** [.npmrc](.npmrc) points at `registry.npmjs.org` so a
  contributor's private-registry global config never lands in `package-lock.json`. If a
  lockfile diff grows internal registry URLs, drop them — CI fails with `E401`.
- **`.claude/` is gitignored.** Local agents, commands, and settings are never shared with
  contributors. Project guidance that should travel belongs in this file or in `docs/`.

## Changes and releases

Every user-facing change gets an entry under `## [Unreleased]` in
[CHANGELOG.md](CHANGELOG.md). A release moves those notes under a version heading, bumps
`version` in `package.json`, and rebuilds the `.vsix` (`npm run package` removes the stale
one). `main` moves fast and several sessions land on it a day — re-check `main`'s HEAD before
designing anything, and work in a git worktree so a parallel session cannot switch the
checkout under you.
