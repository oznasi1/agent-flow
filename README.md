# Agent Flow

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
  configurable via `agentFlow.provenanceLabel`, toggle with `agentFlow.stampLabelOnWrite`).
- **Service inference** — reads the ticket's components/labels/text and matches your
  local repo checkouts (backend *and* frontend).
- **Open + seed** — writes `.pick-task/TASK.md` into each repo (git-excluded), generates a
  `<KEY>.code-workspace` (or one window per repo, or a per-task git worktree), and pre-fills
  the Claude Code panel with your chosen prompt mode (you press Enter to start).
- **Review PR** — once a task reaches your PR-review status (default `PR initiated`), a
  **Review PR** button appears on the card. It kicks off an agent **in a worktree** that finds
  the task's GitHub PR by its Jira key, checks out its branch, and assesses whether it's ready
  for your fixes — then, by default, starts implementing the requested changes (toggle with
  `agentFlow.prReviewAutoFix`).

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
- The **Claude Code** extension (`anthropic.claude-code`) installed — Agent Flow seeds its
  agent panel. Without it, the seeded task brief is still written and used as a fallback.
- An **Atlassian API token** for your Jira Cloud account
  ([create one](https://id.atlassian.com/manage-profile/security/api-tokens)).

## First-time setup

Agent Flow ships with **no organization-specific defaults** — the first time it activates it
offers a short guided setup that collects your Jira site, project key, and repos directory,
then signs you in. Everything is stored in your VS Code **user settings** (credentials go to
encrypted **SecretStorage**, never to `settings.json`).

You can re-run it anytime with the **"Agent Flow: Run Setup…"** command, or configure the
settings below by hand.

## Develop / run

```bash
npm install
npm run build        # or: npm run watch
npm test             # vitest
npm run typecheck    # tsc --noEmit
```

Press **F5** (Run Agent Flow) to launch an Extension Development Host with the extension
loaded. Open the **Agent Flow** icon in the activity bar and complete the first-run setup.

## Settings

| Setting | Default | Notes |
|---------|---------|-------|
| `agentFlow.jira.baseUrl` | `""` | Your Jira Cloud site, e.g. `https://your-org.atlassian.net`. |
| `agentFlow.jira.project` | `""` | Jira project key, e.g. `ABC`. |
| `agentFlow.reposRoot` | `~/projects` | Where your repo checkouts live. |
| `agentFlow.workspaceDir` | `~/projects` | Where generated `.code-workspace` files go. |
| `agentFlow.repoBlocklist` | `[]` | Directory names under `reposRoot` to exclude from discovery. |
| `agentFlow.githubOrg` | `""` | Reserved (clone support not yet implemented). |
| `agentFlow.provenanceLabel` | `claude-code` | Label stamped on Jira writes when enabled. |
| `agentFlow.stampLabelOnWrite` | `true` | Whether to stamp the provenance label. |
| `agentFlow.defaultFilter` | `mysprint` | Default task filter lens (`unassigned`, `mysprint`, `mine`, `sprint`, `backlog`). |
| `agentFlow.seedAgent` | `true` | Pre-fill the Claude Code panel after opening. |
| `agentFlow.trackOpenWindows` | `true` | Track open windows so a task can open into one you already have open. |
| `agentFlow.prReviewStatus` | `PR initiated` | Task status (case-insensitive) that shows the **Review PR** button on a card. |
| `agentFlow.prReviewAutoFix` | `true` | After the PR-review agent assesses the PR, let it implement the requested changes (off = assess only). |

Plus `agentFlow.workspaceMode`, `agentFlow.taskMode`, `agentFlow.promptModes`,
`agentFlow.explorePrompt`, `agentFlow.prReviewPrompt`, and `agentFlow.worktree` — see the
Settings UI. The **Review PR** kick-off always runs in a worktree. Per-task
worktrees are created inside each repo at `.claude/worktrees/<KEY>` (and git-excluded
automatically). Jira credentials are stored in VS Code **SecretStorage**, never in settings.

`agentFlow.openIn` controls where a task you take gets opened: `ask` (ask each time),
`new-window`, `this-window` (reuse the current window), or `pick-existing` — pick an
existing `.code-workspace` file and have the task's repos merged into it. That merge is
non-destructive: Agent Flow only appends the repos the task needs (preserving the
workspace file's existing folders, settings, and formatting) and opens it as a
multi-root workspace; it never overwrites or removes what was already there.

When taking a task (or starting an Explore session) with `agentFlow.openIn` set to
`ask`, Agent Flow also lists the windows you already have open — a repo folder or a
saved workspace — so you can drop the task straight into one of them. Choosing an open
**workspace** window merges the task's repos into it; choosing an open **folder** window
focuses it and seeds the agent there (a folder window can't gain root folders, so any
other repos the task touches keep their briefs but aren't added as roots). Set
`agentFlow.trackOpenWindows` to `false` to turn this off.

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
