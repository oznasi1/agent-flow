# Contributing to Agent Flow Deck

Thanks for your interest in improving Agent Flow Deck! This is a VS Code / Cursor extension written
in TypeScript, with React webviews bundled by esbuild and tested with Vitest.

## Getting started

```bash
git clone https://github.com/oznasi1/agent-flow.git
cd agent-flow
npm install
```

## Everyday commands

| Command | What it does |
|---------|--------------|
| `npm run build` | Bundle the extension host + both webviews into `dist/` (esbuild). |
| `npm run watch` | Same, in watch mode. |
| `npm test` | Run the Vitest unit/webview suite. |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run test:cov` | Run tests with V8 coverage (thresholds enforced). |
| `npm run test:ct` | Run the Playwright component tests (real Chromium; covers measured-layout behavior jsdom cannot). |
| `npm run test:e2e` | Real-host E2E: downloads a pinned VS Code, launches it sandboxed (own HOME, user-data, extensions), and drives take-a-task against the fixture connector. First run downloads ~150MB (the pinned VS Code) plus the pinned Claude Code vsix for the panel-seeding journey. |
| `npm run e2e:report` | Build the verify-feature report from the last `test:e2e` run — one self-contained HTML with a labelled screenshot strip and verdict per journey (`test-results/verify-report.html`). |
| `npm run sabotage [journey]` | Mutation-check the E2E lane: apply `test-e2e/sabotage/<journey>.patch`, rebuild, run that one journey, require it to fail, revert. Requires a clean tree — the revert would discard uncommitted work. Runs weekly in CI, not per-PR. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run package` | Build a `.vsix` with `vsce`. |

## Sabotage patches

Every E2E journey pairs with `test-e2e/sabotage/<journey>.patch`, a mutation
that MUST make it fail. A journey that survives its mutation asserts nothing.
Add the patch in the same commit as the journey; generate it by breaking `src/`
by hand, `git diff > test-e2e/sabotage/<journey>.patch`, then `git checkout src/`.

Each patch also needs a companion `test-e2e/sabotage/<journey>.expect`: one
line holding a distinctive substring of the `test("…")` title the mutation
must break. The runner does not trust the spec file's overall exit code —
`describeWithHost` runs serially and skips every test after the first genuine
failure, so an unrelated earlier failure could otherwise mask a target test
that never ran at all. `npm run sabotage` reads the JSON report and requires
the NAMED test to have actually failed; a missing `.expect`, a stale one (no
test title contains it anymore), or a target test that passed or was skipped
are all reported as distinct gate failures, not silently ignored.

**Recovering from a killed run.** The runner reverts each patch in a
`finally`, but a `finally` cannot run if the process itself is killed (e.g. a
tool or CI step timing out mid-patch) — that leaves a mutation applied to
`src/` with no automatic revert. Before applying a patch, the runner writes
`test-results/.sabotage-in-progress` (gitignored, alongside the rest of
`test-results/`) naming the patch in flight, and removes it once the revert
is confirmed clean. If a run dies mid-patch, the next invocation of
`npm run sabotage` finds that marker and — instead of the generic "working
tree is dirty" refusal — fails with the exact patch name and the recovery
command:

```
git apply -R test-e2e/sabotage/<journey>.patch
```

Run that, then re-run `npm run sabotage`; the marker is cleared automatically
once the tree is clean (whether by that command or by any other manual
recovery). Every other cause of a dirty tree still gets the plain "working
tree is dirty. Commit first" message.

## The E2E fixture connector

`agentFlow.taskSource: "fixture"` resolves a JSON-backed task source, but only
while `AGENT_FLOW_FIXTURE_DIR` is set in the environment — both are required, so
shipped installs can never reach it. Tasks come from `<dir>/tasks.json`; every
write the extension performs is appended to `<dir>/writes.jsonl` for tests to
assert on. See `src/tasks/fixture/connector.ts` and `test-e2e/_helpers/sandbox.ts`.

## Running the extension

Press **F5** in VS Code (the "Run Agent Flow Deck" launch config) to open an Extension Development
Host with a `build` pre-launch task. Open the **Agent Flow Deck** icon in the activity bar and
complete the first-run setup wizard.

## Architecture

```
src/
├── extension.ts        # activation, commands, first-run + seed-on-activation hooks
├── setup.ts            # guided first-run configuration wizard
├── tasksView.ts        # sidebar webview provider + the pick→confirm→open flow
├── notepad.ts          # the Notepad's globalState store + run-status derivation
├── deckView.ts         # the Deck panel: in-flight runs, live signal, open/diff
├── marketplaceView.ts  # the Marketplace panel: scan, file reads, open/reveal/copy
├── doctorView.ts       # the Doctor report: Jira + forge CLI + agent-provider probes
├── config.ts           # settings accessor
├── types.ts            # shared host ↔ webview message types
├── tasks/              # the task source, behind one connector interface
│   ├── provider.ts     # TaskProvider + capabilities (what a source can do)
│   ├── registry.ts     # which connector is active
│   └── jira/           # the Jira connector: auth (SecretStorage), REST client, JQL
├── engine/             # the logic, kept out of the views so it can be tested directly
│   ├── repos.ts        # discover local repo checkouts
│   ├── infer.ts        # component/label/text → service matching
│   ├── worktree.ts     # per-task git worktrees + branch naming
│   ├── workspace.ts    # briefs, .code-workspace, plan.json, open windows, session seed
│   ├── runs.ts         # what you've launched, for the Deck
│   ├── transcript.ts   # best-effort live session state from ~/.claude/projects
│   ├── sessions.ts     # Claude Code's own registry of running sessions
│   ├── forge/          # which forge is active, behind one interface (docs/FORGES.md)
│   ├── pr/             # PR/MR facts per repo, over `gh` — and `pr/glab/` over `glab`
│   ├── review/         # the review queue + "Review with …" (names your tool — Claude Code, Cursor, or Copilot): search, sort, launch, store
│   ├── claudeAssets.ts # scan ~/.claude: marketplaces, plugins, skills, commands, hooks
│   ├── sections.ts     # the Marketplace's category order (Yours → size → Uncategorized)
│   ├── fuzzy.ts        # the ranked fuzzy match behind the Marketplace's search
│   └── markdown.ts     # the parse-to-tree markdown renderer behind the file preview
├── telemetry/          # anonymous usage events (see docs/TELEMETRY.md)
└── webview/            # React UIs — task pool + Notepad, Deck, Marketplace
                        # (three esbuild bundles)
```

The task source sits behind the `TaskProvider` interface with a capability record, so a
connector that has no sprints or no size estimates hides those lenses instead of faking
them — see [docs/CONNECTORS.md](docs/CONNECTORS.md). Jira auth is behind `JiraAuth`: v1
ships the API-token provider; the OAuth web-flow provider (a
`vscode.AuthenticationProvider` that opens the browser) drops in later with no changes to
the client or UI.

The forge sits behind a seam of the same kind — `Forge` in `engine/forge/types.ts`,
selected by `agentFlow.forge` — so nothing outside `engine/forge/` and its two provider
directories knows whether a pull request came from `gh` or `glab`. A forge that can't
answer something degrades in a stated way rather than faking an answer;
[docs/FORGES.md](docs/FORGES.md) lists what those are.

The session seed is one chokepoint in `engine/workspace.ts` that every launch path — take,
batch, Explore, Notepad, Deck relaunch, Address PR, Review with … — goes through. It
resolves `agentFlow.agentProvider` × `agentFlow.agentSurface` **at seed time in the target
window**, never from the plan file, so flipping either setting also changes plans already
on disk.

## Conventions

- **Vocabulary.** A **session** is one run of a coding tool — one Deck card, one
  row in `run.agents[]`. An **agent** is a worker a session delegates to (the
  Marketplace's Agents tab, `.claude/agents/`). The tool itself is named
  — "Review with Claude Code" — never called "the agent". Identifiers, setting
  ids, stored values and orchestrator condition keys keep their released
  spelling, so the code says `agents` where the UI says sessions.
  `test/unit/vocabulary.test.ts` enforces this; its allowlist records every
  place "agent" is still correct.
- **No hardcoded organization values.** Anything organization-specific (Jira site, project
  key, repo layout, blocklist, provenance label) belongs in a `agentFlow.*` setting and is
  read through `getConfig()` in `src/config.ts` — never inlined. New behavior that varies per
  user should follow the same pattern and be collected in the first-run wizard (`src/setup.ts`)
  where appropriate.
- **Task sources are pluggable.** Jira is the default connector, not a hardwired
  dependency. Anything reading or writing tickets goes through `TaskProvider` /
  `TaskConnector` in `src/tasks/provider.ts` — never `src/tasks/jira/` directly.
  Vocabulary the seam itself owns lives beside it, not in a source's directory
  (e.g. `FieldPrompt` and `validateFieldInput` in `src/tasks/fields.ts`). The only
  imports into a connector's directory are the seam's own wiring: `registry.ts`
  reaches for each connector's factory, and `provider.ts` type-imports `TaskDetail`
  from the Jira client that still declares it.
  To add a source, see [docs/CONNECTORS.md](docs/CONNECTORS.md).
- **Forges are pluggable too.** GitHub is the default forge, not a hardwired dependency.
  Anything reading pull/merge requests, branch CI or review requests goes through the
  `Forge` seam in `src/engine/forge/types.ts`, selected by `agentFlow.forge` — never
  `src/engine/pr/glab/` or the `gh`-only providers directly. `src/engine/forge/*` imports
  `child_process` and must never be reachable from webview code. To add a forge, see
  [docs/FORGES.md](docs/FORGES.md).
- **Tests.** Add or update tests for any behavior change; coverage thresholds are enforced by
  `npm run test:cov`. The `vscode` module is mocked in `test/_mocks/vscode.ts`.
- **Type safety.** Keep `npm run typecheck` clean.

## Before opening a PR

Run `npm run typecheck` and `npm test`, and make sure `npm run build` succeeds. For any
user-facing change, add an entry under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md).

## Publishing (maintainers)

`package.json` carries the `publisher`, `repository`, `homepage`, and `bugs` metadata. Before
publishing to the Marketplace:

1. Confirm `publisher` matches your registered Marketplace publisher id.
2. Add a top-level `icon` pointing to a 128×128 PNG.
3. Move the `## [Unreleased]` notes in [CHANGELOG.md](CHANGELOG.md) under a new version
   heading, and bump `version` in `package.json`.
4. `npm run package` and `vsce publish`.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating you
agree to uphold it.

## Reporting a security problem

Not in a public issue, please — see [SECURITY.md](SECURITY.md), which also says what is in
scope and what is deliberately not.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
