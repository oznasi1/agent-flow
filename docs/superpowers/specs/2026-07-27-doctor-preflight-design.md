# Design: Agent Flow Doctor — preflight diagnostics

**Date:** 2026-07-27
**Status:** Approved, ready to plan

## Summary

Agent Flow depends on five things outside itself — a reachable Jira site, valid
Atlassian credentials, `gh` installed *and* signed in, a `reposRoot` that
actually holds checkouts, and the `anthropic.claude-code` extension — plus ~22
settings. Today every one of those fails at the moment of use, narrowly, and
several fail *silently*.

`Agent Flow: Doctor` is one command that probes all of them and reports what is
broken, with the action that fixes it one click away.

## Why: three things that currently fail without saying so

- **`isAuthenticated()` does not check Jira.** [`jira/auth.ts`](../../../src/jira/auth.ts)
  returns true whenever an email and token exist in SecretStorage. A revoked or
  expired token reads as signed-in, and every later fetch fails with an auth
  error indistinguishable from a network problem.
- **Nothing checks that Claude Code is installed.**
  [`engine/workspace.ts`](../../../src/engine/workspace.ts) calls
  `claude-vscode.primaryEditor.open` and falls back if absent;
  `vscode.extensions.getExtension` is never called. Presence is no longer the
  whole story either — the shared-window batch launch needs
  `claude-vscode.editor.open`, which arrived in Claude Code **2.1.220**. An older
  Claude Code degrades that feature with no signal.
- **`discoverRepos` cannot distinguish a wrong path from an empty one.**
  [`engine/repos.ts`](../../../src/engine/repos.ts) swallows the `readdirSync`
  failure and returns `[]`, so a typo'd `reposRoot` and a directory with no
  checkouts both render as an empty pool.

Inspiration: `ao doctor` in
[AgentWrapper/agent-orchestrator](https://github.com/AgentWrapper/agent-orchestrator),
which checks config, data dir, daemon state, `git` and `tmux` in one command.

## Decisions

| Question | Decision |
|----------|----------|
| Report, or also fix? | **Report + one-click actions.** Each failing check offers the action that fixes it, on an explicit click only. No auto-repair — that cuts against how the rest of the extension behaves. |
| Surface? | **QuickPick**, plus a **Copy diagnostic report** row. Actions are inherent to the surface, theming is free, and there is no CSS or webview test surface to build. A fourth webview would cost roughly the Marketplace's footprint for a transient tool. |
| Trigger? | **Manual command**, plus a **Run Doctor** action on the existing failure surfaces. No background work and no activation-time probing — the Deck's design deliberately keeps the network off the startup path. |
| Network? | Yes: two authenticated GETs to the user's own Jira, and `gh auth status`. That live probe is what catches the revoked-token case; without it Doctor is cosmetic. |

## The check set

| Group | Check | Status rule |
|-------|-------|-------------|
| **Jira** | Site configured | `fail` when `jira.baseUrl` is empty or not an `https` URL |
| | Project configured | `fail` when `jira.project` is empty |
| | Credentials stored | `fail` when SecretStorage holds no email/token |
| | **Credentials valid** | live `getMyself()`: 200 → `ok` (shows display name); 401/403 → `fail`; network error → `warn` |
| **Local** | `git` on PATH | `fail` when not found |
| | Repos root | missing path → `fail`; exists with zero repos → `warn`; else `ok` with "N repos, M git" |
| | Workspace dir | `fail` when missing or not writable |
| **GitHub** | `gh` | reuses `probeGh()`; `missing` and `signed-out` are distinct, and the report names **where** `gh` was found. `skip` when `agentFlow.prFacts` is off |
| **Claude Code** | Extension installed | `fail` when `anthropic.claude-code` is absent |
| | Version ≥ 2.1.220 | `warn` below the floor, naming shared-window batches as what needs it |
| | `~/.claude/projects` | `warn` when unreadable — the live signal degrades to git + Jira |
| **State** | Tracked runs | informational: N runs in `~/.agentflow/runs` |

### Judgment calls

- **Repos-root-missing is `fail`; zero-repos is only `warn`.** An empty root is a
  legitimate state on a fresh machine; a missing one never is.
- **The Claude Code version floor is `warn`, not `fail`.** The extension still
  works; only shared-window batches don't.
- **`gh` is `skip`, not `fail`, when `prFacts` is off.** Reporting a problem the
  user has deliberately turned off is noise.

## Almost all of it already exists

- `probeGh()` in [`engine/pr/provider.ts`](../../../src/engine/pr/provider.ts)
  returns `GhGap | null` with kinds `missing` / `signed-out`, and `locateGh`
  searches beyond `PATH`. That last part is the single most valuable thing Doctor
  can surface: a Homebrew `gh` invisible to the extension host's bare launchd
  `PATH` reads to a signed-in user as the Deck being broken.
- `JiraClient.getMyself()` already exists — the live probe needs no new client
  method.
- `discoverRepos()`, `getConfig()`, `defaultRunsDir()`/`readRuns()` all exist.
- Only `vscode.extensions.getExtension` is new, and it is one line.

## Ordering and vocabulary

Four statuses, most-decisive first: **`fail`** (a core flow is broken) →
**`warn`** (something degrades) → **`skip`** (not applicable) → **`ok`**.
Failures sort first so the QuickPick opens on the thing to fix. The QuickPick
title carries the summary, e.g. *"2 problems · 1 warning"*.

## Actions

| Check | Action |
|-------|--------|
| Credentials missing or invalid | `agentFlow.signIn` |
| Site or project unconfigured | `agentFlow.setup` |
| Repos root / workspace dir | open Settings filtered to that key |
| Claude Code missing or old | reveal it in the Extensions view |
| `gh` missing or signed out | open `cli.github.com` externally |
| — | **Copy diagnostic report** writes plaintext to the clipboard |

## Surfaces

- **`src/engine/doctor.ts`** — pure. Takes a `DoctorInputs` bag the caller
  gathers, returns `Check[]`; plus `formatReport(checks)`. No `vscode` import, so
  it is table-testable with no mocking.
- **`src/doctorView.ts`** — builds the QuickPick and dispatches actions.
- **`src/extension.ts`**, **`package.json`** — one new command, `agentFlow.doctor`.
- **`src/tasksView.ts`** — the existing `JiraAuthError` surface gains a **Run
  Doctor** action.
- **`src/deckView.ts`** — the `GH_NOTES` strings gain "— run Agent Flow: Doctor".
  No new message type.
- **`README.md`** — the privacy section should say Doctor *probes* rather than
  only reads config.

## Testing

- **`doctor.test.ts`** — table-driven over `DoctorInputs` → expected statuses;
  the sort order; the summary counts; `formatReport`'s output.
- **`doctorView.test.ts`** — QuickPick items built from checks; selecting a
  failing item dispatches its action; Copy writes to the clipboard.

## Scope

**Out of scope:** auto-repair of any kind; background or activation-time probing;
a new webview; checks on anything Agent Flow does not own; and any write to Jira,
GitHub or the filesystem — Doctor is read-only apart from the clipboard.

## Open coordination point

`main` carries an in-flight design, *"transition required fields and readable
Jira errors"* (`38d94ca`), which overlaps Doctor's Jira checks. Reconcile before
implementation: if that work lands a richer Jira error classification, Doctor's
credentials-valid check should consume it rather than re-deriving one.
