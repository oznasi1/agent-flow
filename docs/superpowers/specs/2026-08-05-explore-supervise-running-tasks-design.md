# Design: "Supervise running tasks" Explore action

**Date:** 2026-08-05
**Status:** Approved, ready for planning

## Summary

Explore currently offers five actions (`jiraTicket`, `knowledge`, `debug`,
`general`, `verify` — see `EXPLORE_ACTION_DEFS` in `config.ts`), each seeding a
prompt scoped to the repos the user just picked. None of them look outward at
Agent Flow's *other* active work. This adds a sixth action, **`supervise`**
("Supervise running tasks"), that seeds a session whose job is to check on
every other run still in flight — is it stalled, does it still have an agent
attached, does it need a decision — and help unblock or integrate what it
safely can.

This is deliberately **not** the ticket-only "Orchestrator" prompt mode
(`DEFAULT_PROMPT_MODES` in `config.ts`, reachable via **Take** on a specific
Jira ticket). That mode's job is splitting *one* ticket's work into parallel
subagents; it stays exactly as is, reachable only from Take. `supervise` is
the opposite direction: it looks at work that already exists across *other*
runs, not the current focus.

## Decisions

| Question | Decision |
|----------|----------|
| Is this a new prompt-mode or a new Explore action? | **Explore action** — same mechanism as `jiraTicket`/`knowledge`/`debug`/`general`/`verify`: an id in `EXPLORE_ACTION_DEFS`, a `DEFAULT_EXPLORE_*_PROMPT` constant, one settings-page textarea. |
| Does this touch the ticket-flow "Orchestrator" prompt mode? | **No.** `DEFAULT_PROMPT_MODES`'s `orchestrator` entry, `choosePromptMode()`, and Take are untouched. |
| Where does "what's currently running" come from? | Data Agent Flow already tracks: `readRuns(defaultRunsDir())` (every run: task/explore/review, `key`/`summary`/`repos`/`finishedAt`) and `readOpenSessions(defaultSessionsDir())` + `groupByPlace()` (live Claude Code sessions by repo root) — the same two calls the Deck already uses for its own "is there a live agent here" checks (`deckView.ts`'s `livePlaces` / `hasLiveSession` idiom). |
| How does the agent see the list? | Folded into the seeded session's own **brief.md** via a custom `planMd` (the same extension point `explore()` already uses for the "no ticket yet" note) — not a new `{placeholder}`. `{brief}` already means "read this file for context." |
| Which runs count as "active"? | Every run from `readRuns()` where `!run.finishedAt`, any kind (`task`, `explore`, `review`). `local` runs are never persisted to the store, so they're naturally excluded — consistent with how `local` already behaves everywhere else. |
| What does each listed run show? | Key, kind, summary, first repo's path + branch, and whether any of its repos has a live Claude Code session open right now ("agent open" vs "idle, no agent attached"). |

## Approach rationale

- **Reuse the Deck's own live-session idiom.** `deckView.ts` already computes
  `hasLiveSession` for retirement decisions via
  `livePlaces = new Set(groupByPlace(readOpenSessions(defaultSessionsDir())).keys())`
  then `run.repos.some((r) => livePlaces.has(canon(r.path)))`. The new action
  reuses this exact pattern rather than inventing a second way to answer "is
  someone working on this."
- **No new placeholder.** `{brief}` is already documented to users as "read
  this file for context" and is populated via `planMd`, exactly like the
  existing Verify and generic-Explore notes. Adding a `{tasks}` placeholder
  would duplicate that mechanism for no benefit.
- **Prompt layer only.** Same division of labor as every other Explore
  action: the extension seeds context and an instruction; judging what's
  stalled, deciding what's safe to unblock, and doing the integration work is
  the agent's job, not new extension code. No new inter-session control
  (nudging a stalled sibling, writing to its status file) is added — the
  supervising agent reads state, it doesn't reach into other sessions.
- **Fixed action set, unchanged shape.** `exploreActions` stays a fixed
  code-defined list (only each action's *prompt text* is a user setting) —
  `supervise` is a seventh string setting alongside the existing five, not a
  new kind of configurability.

## The action (code constant)

Added to `EXPLORE_ACTION_DEFS` in `config.ts`, positioned right before
`verify`:

| id | label (picker) | prompt setting |
|----|----------------|-----------------|
| `supervise` | Supervise running tasks | `agentFlow.explorePrompts.supervise` |

Resulting picker order: Open a Jira ticket → Enhance knowledge / flow → Debug
→ General → **Supervise running tasks** → Verify on an environment.

## Default prompt (`config.ts`)

`DEFAULT_EXPLORE_SUPERVISE_PROMPT`:

> Supervision session — checking on your other active Agent Flow tasks. A
> brief listing them, and whether each still has an agent attached, is at
> {brief}. Read it, judge which ones are stalled, blocked, or waiting on you,
> and tell me what needs attention. Where it's safe and unambiguous, help
> unblock or integrate one yourself; flag anything you're unsure about rather
> than guessing.{files}

Placeholders: `{summary}` (optional priority, see below), `{brief}`,
`{files}` — same set every other non-`verify` Explore action uses.

## New helper (`engine/runs.ts`)

```ts
export function describeActiveTasks(runs: Run[], livePlaces: ReadonlySet<string>): string
```

- Filters `runs` to `!run.finishedAt`.
- Empty → returns `_No other active tasks right now._`.
- Otherwise one bullet per run:
  `- **{key}** ({kind}) — {summary} — \`{path}\`{ (branch: {branch})} — {agent open | idle, no agent attached}`
  where `{kind}` is `runKind(run)`, `{path}`/`{branch}` come from `run.repos[0]`,
  and the live check is `run.repos.some((r) => livePlaces.has(canon(r.path)))`
  — the exact idiom `deckView.ts` already uses.
- Returns a `## Active tasks` markdown block (heading + bullets), ready to
  drop into `planMd`.

`canon` comes from `./paths`, `runKind` from `../types` — both already used
elsewhere in `engine/`.

## Behavior & flow (`tasksView.explore()`)

1. Action picker gains the new entry automatically (it iterates
   `cfg.exploreActions`) — no change needed there.
2. **Topic input box.** When `action.id === "supervise"`, use
   supervise-specific copy: title "Supervise — anything specific to
   prioritize?", placeholder text noting it's optional. Blank input falls back
   to `"Check on active tasks"` instead of the generic `"Codebase
   exploration"`, so an unfocused session's `summary` reads sensibly.
3. Repo pick / destination / workspace-mode — unchanged; the user still picks
   where this supervising session itself runs, same as any Explore action.
4. **`planMd`.** Gains a third branch alongside the existing `env` /
   non-`env` ternary:
   - `env` set → today's Verify note (unchanged).
   - `action.id === "supervise"` → `## Supervise: {topic}` + the "no ticket
     yet" sentence + `describeActiveTasks(readRuns(defaultRunsDir()),
     new Set(groupByPlace(readOpenSessions(defaultSessionsDir())).keys()))`.
   - else → today's generic Exploration note (unchanged).
5. Everything after (`openWorkspace`, toast, remote control) — unchanged.

## Settings (package.json `contributes.configuration`)

| Setting | Type | Default | Renders as |
|---------|------|---------|------------|
| `agentFlow.exploreMode` | enum | adds `"supervise"` to the existing list | Dropdown entry added. |
| `agentFlow.explorePrompts.supervise` | string, `multilineText` | `DEFAULT_EXPLORE_SUPERVISE_PROMPT` | Textarea. |
| `agentFlow.exploreSlackDm` | object | adds `supervise: boolean` property, default `false` | Checkbox added. |

## Surfaces (files touched)

- `config.ts`: `DEFAULT_EXPLORE_SUPERVISE_PROMPT` constant, one entry in
  `EXPLORE_ACTION_DEFS`.
- `engine/runs.ts`: `describeActiveTasks()`.
- `tasksView.ts`: `explore()` — topic-box copy branch, `planMd` branch, new
  imports (`describeActiveTasks`, `readRuns`, `defaultRunsDir`,
  `readOpenSessions`, `defaultSessionsDir`, `groupByPlace`, `canon`).
- `telemetry/settingsSnapshot.ts`: add `"supervise"` to `EXPLORE_MODES`.
- `package.json`: the three setting changes above.
- No change to `types.ts`, the webview, or `openWorkspace`'s signature.

## Testing

- `engine/runs.test.ts`:
  - `describeActiveTasks` — empty/all-finished input → the "no other active
    tasks" sentence; a mix of finished and unfinished runs includes only the
    unfinished ones; a run whose repo path is in `livePlaces` renders "agent
    open", otherwise "idle, no agent attached"; `kind` renders via `runKind`
    (including the tolerant fallback for a record with no `kind` field).
- `config.test.ts`: `exploreActions` includes `supervise` with the built-in
  label and default prompt, in the documented position; `exploreMode`
  accepts `"supervise"`.
- `tasksView.test.ts` (extends the existing `explore()` tests):
  - Choosing `supervise` uses the supervise-specific topic-box copy and
    blank-input fallback.
  - The `planMd` passed to `openWorkspace` contains the `## Active tasks`
    section built from `describeActiveTasks`, given a stubbed `readRuns`/
    `readOpenSessions`.
  - `env`-based Verify `planMd` and generic-Explore `planMd` are unchanged
    (regression check on the existing two branches).
- `settingsSnapshot.test.ts`: `explore_mode` accepts `"supervise"` without
  falling back to "invalid".

## Non-goals (YAGNI)

- Any change to the ticket-flow "Orchestrator" prompt mode or Take.
- A new `{tasks}` (or similar) placeholder — folded into the existing brief
  mechanism instead.
- Reaching into another session to nudge, prompt, or write its status file —
  the supervising agent only reads state; anything it does to "unblock" a
  sibling task is ordinary work in that task's own workspace, not new
  inter-session plumbing.
- Listing sessions that have no matching `Run` record (stray Claude Code
  windows Agent Flow never tracked) — scope is Agent Flow's own runs, not a
  full session inventory.
- Pagination/truncation of the active-tasks list — no cap for this feature;
  revisit only if it proves noisy in practice.
