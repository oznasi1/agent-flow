# Flow Deck

A VS Code / Cursor extension: a **task pool in your sidebar** that turns "what should I
work on?" into a workspace with an agent already primed.

Pick a Jira task → it infers which repos the task touches → opens them as a workspace →
seeds a task brief and pre-fills a Claude Code agent with the plan. You land ready to
orchestrate, not ready to set up.

## What it does

- **Sidebar task pool** (webview) with filter tabs (Unassigned · Mine · My sprint · Backlog)
  and a size lens (S/M/L by original estimate).
- **Jira fetch** over the REST API. Reads are the default; the only writes are optional
  status changes from a card — which also stamp a provenance label (default `claude-code`,
  configurable via `flowdeck.provenanceLabel`, toggle with `flowdeck.stampLabelOnWrite`).
- **Service inference** — reads the ticket's components/labels/text and matches your
  local repo checkouts (backend *and* frontend).
- **Open + seed** — writes `.pick-task/TASK.md` into each repo (git-excluded), generates a
  `<KEY>.code-workspace` (or one window per repo, or a per-task git worktree), and pre-fills
  the Claude Code panel with your chosen prompt mode (you press Enter to start).

## Architecture

```
src/
├── extension.ts        # activation, commands, first-run + seed-on-activation hooks
├── setup.ts            # guided first-run configuration wizard
├── tasksView.ts        # webview provider + the pick→confirm→open flow
├── config.ts           # settings accessor
├── types.ts            # shared host ↔ webview message types
├── jira/
│   ├── auth.ts         # JiraAuth interface + ApiTokenAuth (SecretStorage)
│   └── client.ts       # REST client: JQL builder, search, getIssue, transitions
├── engine/
│   ├── repos.ts        # discover local repo checkouts
│   ├── infer.ts        # component/label/text → service matching
│   ├── worktree.ts     # per-task git worktrees + branch naming
│   └── workspace.ts    # briefs, .code-workspace, plan.json, open windows, agent seed
└── webview/            # React task-pool UI (bundled separately by esbuild)
```

Auth is behind the `JiraAuth` interface: v1 ships the API-token provider; the OAuth
web-flow provider (a `vscode.AuthenticationProvider` that opens the browser) drops in later
with no changes to the client or UI.

## Requirements

- **VS Code** (or Cursor) `^1.90.0`.
- The **Claude Code** extension (`anthropic.claude-code`) installed — Flow Deck seeds its
  agent panel. Without it, the seeded task brief is still written and used as a fallback.
- An **Atlassian API token** for your Jira Cloud account
  ([create one](https://id.atlassian.com/manage-profile/security/api-tokens)).

## First-time setup

Flow Deck ships with **no organization-specific defaults** — the first time it activates it
offers a short guided setup that collects your Jira site, project key, and repos directory,
then signs you in. Everything is stored in your VS Code **user settings** (credentials go to
encrypted **SecretStorage**, never to `settings.json`).

You can re-run it anytime with the **"Flow Deck: Run Setup…"** command, or configure the
settings below by hand.

## Develop / run

```bash
npm install
npm run build        # or: npm run watch
npm test             # vitest
npm run typecheck    # tsc --noEmit
```

Press **F5** (Run Flow Deck) to launch an Extension Development Host with the extension
loaded. Open the **Flow Deck** icon in the activity bar and complete the first-run setup.

## Settings

| Setting | Default | Notes |
|---------|---------|-------|
| `flowdeck.jira.baseUrl` | `""` | Your Jira Cloud site, e.g. `https://your-org.atlassian.net`. |
| `flowdeck.jira.project` | `""` | Jira project key, e.g. `ABC`. |
| `flowdeck.reposRoot` | `~/projects` | Where your repo checkouts live. |
| `flowdeck.workspaceDir` | `~/projects` | Where generated `.code-workspace` files go. |
| `flowdeck.repoBlocklist` | `[]` | Directory names under `reposRoot` to exclude from discovery. |
| `flowdeck.githubOrg` | `""` | Reserved (clone support not yet implemented). |
| `flowdeck.provenanceLabel` | `claude-code` | Label stamped on Jira writes when enabled. |
| `flowdeck.stampLabelOnWrite` | `true` | Whether to stamp the provenance label. |
| `flowdeck.defaultFilter` | `mysprint` | Default task filter lens (`unassigned`, `mysprint`, `mine`, `sprint`, `backlog`). |
| `flowdeck.seedAgent` | `true` | Pre-fill the Claude Code panel after opening. |

Plus `flowdeck.workspaceMode`, `flowdeck.openIn`, `flowdeck.taskMode`,
`flowdeck.promptModes`, `flowdeck.explorePrompt`, `flowdeck.worktree`, and
`flowdeck.worktreeRoot` — see the Settings UI. Jira credentials are stored in VS Code
**SecretStorage**, never in settings.

## Status

v1 — task pool, filters, size lens, service inference, worktrees, open + seed, and status
changes from a card. The agent seed calls the Claude Code extension command
(`claude-vscode.primaryEditor.open`) with a URI-handler and clipboard fallback; the seeded
brief is the guaranteed fallback. Deferred: OAuth web sign-in, cloning not-yet-checked-out
repos, multi-project.

## Publishing

Before publishing to the VS Code Marketplace, confirm the `publisher` in `package.json` matches
your registered Marketplace publisher id and add a 128×128 PNG `icon`. See
[CONTRIBUTING.md](CONTRIBUTING.md).
