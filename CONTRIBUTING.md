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
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run package` | Build a `.vsix` with `vsce`. |

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
│   ├── workspace.ts    # briefs, .code-workspace, plan.json, open windows, agent seed
│   ├── runs.ts         # what you've launched, for the Deck
│   ├── transcript.ts   # best-effort live agent state from ~/.claude/projects
│   ├── sessions.ts     # Claude Code's own registry of running sessions
│   ├── forge/          # which forge is active, behind one interface (docs/FORGES.md)
│   ├── pr/             # PR/MR facts per repo, over `gh` — and `pr/glab/` over `glab`
│   ├── review/         # the review queue + "Review with agent": search, sort, launch, store
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

The agent seed is one chokepoint in `engine/workspace.ts` that every launch path — take,
batch, Explore, Notepad, Deck relaunch, Address PR, Review with agent — goes through. It
resolves `agentFlow.agentProvider` × `agentFlow.agentSurface` **at seed time in the target
window**, never from the plan file, so flipping either setting also changes plans already
on disk.

## Conventions

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
