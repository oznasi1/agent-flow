# Design: the Deck reflects every agent open on this machine

**Date:** 2026-08-02
**Status:** Approved, ready to plan

## Summary

The Deck renders one card per record in `~/.agentflow/runs/` — only what Agent
Flow itself launched. Every other Claude Code session on the machine is
invisible to it, including sessions in worktrees Claude Code made on its own,
and including the *second* agent in a directory the Deck already has a card for.

Measured on the author's machine while writing this:

| cwd | open sessions | on the Deck today |
|---|---|---|
| `~/dev/agent-flow` | 4 | ✗ |
| `~/Work-Projects/e2e_suite` | 3 | ✗ |
| `webapp/.claude/worktrees/PROJ-5772` | 2 | ✓ — as card `PROJ-5772`, showing one of them |
| `agent-flow/.claude/worktrees/explore-verify-on-environment` | 1 | ✗ |
| `~/Work-Projects/infra-tools` | 1 | ✗ |
| `portfolio/.claude/worktrees/surf-portfolio` | 1 | ✗ |

Eleven cards, twelve open agents, one card in common. This design closes that
gap: every open session lands on exactly one card, and a directory with no
tracked run gets a card of its own.

## What "currently running" is read from

Claude Code maintains a live session registry — one file per running session,
removed when it exits:

```jsonc
// ~/.claude/sessions/24768.json
{ "pid": 24768,
  "sessionId": "3bc8597d-826d-4d01-a2c8-5a097c61f135",
  "cwd": "/Users/oznasi/dev/agent-flow",
  "startedAt": 1785667544705,
  "kind": "interactive",
  "entrypoint": "claude-vscode",
  "name": "agent-flow-2e" }
```

Three fields carry the design. `cwd` names the place, and therefore the git
state. `sessionId` names the transcript at
`~/.claude/projects/<encodeProjectDir(cwd)>/<sessionId>.jsonl`, which
[`transcript.ts`](../../../src/engine/transcript.ts) already knows how to read.
`name` is a human-readable label Claude derives for the session, which is what a
card shows for an agent.

This is an undocumented internal of Claude Code, and it can change or disappear.
That is the same bet the **Live signal** already makes on the transcript format,
and it is taken the same way: every read is best-effort, an unreadable or absent
registry yields an empty list, and the Deck falls back to exactly today's
behaviour.

A crashed session leaves its file behind, so a record counts only if its pid is
alive. [`presence.ts`](../../../src/engine/presence.ts) already has that probe.

## Architecture

An untracked place is turned into a *synthetic `Run`*, so the whole existing
pipeline — `gitState`, `deriveBucket`, `prSignals`, presence, Open, Diff —
renders it with no changes.

```
readOpenSessions()  ──►  groupByPlace()  ──►  Map<placePath, OpenSession[]>
                                                    │
        ┌───────────────────────────────────────────┴──────────────┐
        ▼ place matches a tracked run.repos[].path                  ▼ nothing matches
   attach to that RunStatus.agents                          synthesize a local Run
                                                                     │
                                                                     ▼
                                                     buildRunStatus() — unchanged
```

### New module: `src/engine/sessions.ts`

```ts
/** One open Claude Code session, as ~/.claude/sessions/<pid>.json records it.
 *  Only the fields the Deck reads; the file carries more. */
export interface OpenSession {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  name: string | null; // Claude's derived label, e.g. "agent-flow-2e"
}

/** ~/.claude/sessions — the live session registry. */
export function defaultSessionsDir(): string;

/** Every session still open. Prunes records whose pid is dead, skips records
 *  that fail to parse, and drops any whose `kind` is present and is not
 *  "interactive" — an absent kind is included, so a future Claude Code that
 *  stops writing the field degrades to showing sessions rather than none. */
export function readOpenSessions(dir: string): OpenSession[];

/** Sessions grouped by the git repo root containing their cwd, so a session
 *  started in `webapp/src` groups with one started in `webapp`. Memoized per
 *  cwd for the process — a directory does not change repo. A cwd in no repo
 *  groups under itself. */
export function groupByPlace(sessions: OpenSession[]): Map<string, OpenSession[]>;
```

Unlike the runs store, nothing here is ever written. The registry is Claude
Code's; Agent Flow only reads it.

### Two helpers stop being duplicated

`pidAlive()` lives in `presence.ts` and is now wanted in `sessions.ts` too.
`canon()` — `realpathSync` with a swallow — exists in both `presence.ts` and
[`status.ts`](../../../src/engine/status.ts), and would be a third copy here.
Both move to a new `src/engine/paths.ts` and the two existing copies are
deleted. No behaviour change; the two current copies are already identical.

### `RunStatus` gains its agents

```ts
/** One open session attached to a card, with its own live state. */
export interface CardAgent {
  session: OpenSession;
  activity: AgentActivity; // "unknown" when Live signal is off
}

export interface RunStatus {
  // …unchanged…
  agents: CardAgent[]; // every open session in this run's directories
}
```

A tracked run collects sessions from every one of its `repos[].path`, which is
what fixes `PROJ-5772` showing one of its two agents.

Each session's activity is read from *its own* transcript rather than the
directory's newest, which is what today's per-repo read settles for:

```ts
// transcript.ts — factored out of readAgentActivity, which keeps its
// newest-transcript-for-a-branch behaviour for repos with no session open.
/** Live state of one named session: its transcript is <sessionId>.jsonl in the
 *  project dir encoding its cwd. "unknown" when that file is absent. */
export function readSessionActivity(
  projectsRoot: string, cwd: string, sessionId: string, nowMs: number,
): AgentActivity;
```

`run.agent` — the single aggregate the card header renders and `deriveBucket`
votes on — becomes `mostActive` over the **union** of the per-session activities
and the existing per-repo reads. The union matters in both directions: a card
with four open sessions is decided by all four rather than by whichever
transcript was touched last, and a tracked card whose agent has since exited
keeps the last-known state it shows today instead of dropping to *parked*.

### The synthetic run

```ts
{
  key: `local-${basename}-${sha1(placePath).slice(0, 8)}`,
  summary: <the branch's text after the key> ?? basename,
  url: <inferred Jira browse url>, // "" when no key was inferred
  createdAt: <earliest startedAt among the place's sessions>,
  kind: "local",
  mode: "per-window",
  repos: [{ name: basename, path: placePath, isGit, branch }],
  briefPaths: [],
}
```

`summary` is derived locally and never fetched: `PROJ-5641-team-table-new-design`
gives *"team table new design"*, and a branch with no key gives the directory
basename. Reading the real summary would mean an extra Jira call before the card
could even be built, to improve a line the branch already says.

The key must survive a refresh (React identity, and the `prfacts/<key>.json`
cache), be safe as a filename, and never collide. A slug of the whole path
satisfies the first two and can blow past a 255-byte filename on a deep
worktree; a bare hash satisfies all three and is unreadable in a log. The
basename-plus-hash form is bounded, greppable, and distinct for two places that
share a basename.

`kind` becomes a fourth `RunKind`. `runKind()`'s tolerant fallback means an old
record is unaffected; `RUN_KINDS` gains `"local"`. `buildAll`'s existing
`runKind(r) !== "review"` filter already admits it.

A synthetic run is never written to `~/.agentflow/runs/` unless the user asks
(see *Track it*).

## Enrichment

| | Gate | Why |
|---|---|---|
| Jira poll | the branch matches `^${config.project}-\d+` | `project` is already configured (`PROJ`), so an inferred key can only ever name an issue in the project the user works in. The card marks it `~inferred`. |
| PR fetch | the repo is git, has a branch, and that branch is **not** the repo's default branch | `gh pr list --head <feature-branch>` can only return that branch's pull request. |

`isTicketRun(run)` keeps gating the Jira poll: a local run with an inferred key
gets a url and polls, one without gets `""` and does not. No change to that
function.

### The PR gate moves from "has a ticket" to "is not on the default branch"

Today `buildAll` gates both the stored-facts read and the fetch on
`isTicketRun`. That was the [Defect 1
fix](2026-07-27-deck-untracked-runs-diff-forget-design.md): an Explore run sits
on `master`, so `gh pr list --head master` returned whatever pull request was
last opened from `master` — a stranger's — and rendered it on the card.

The default-branch test says that directly, and is what a local card needs
anyway: `~/dev/agent-flow` on `main` must not get a PR, and
`portfolio/.claude/worktrees/surf-portfolio` on its own branch must.

```ts
/** The repo's default branch, short — "main", "master", whatever origin/HEAD
 *  names. "" when the repo has no origin, which also means no pull requests.
 *  Memoized per repo for the process: origin/HEAD does not move. */
export function defaultBranch(repoPath: string): string;

/** Can this repo's branch have a pull request of its own? A branch that IS the
 *  default branch cannot: `gh pr list --head main` matches every PR ever opened
 *  from main, none of which belongs to this run. */
export function prEligible(repo: Run["repos"][number]): boolean;
```

`defaultBranch` is `defaultRemoteRef` — already in
[`git.ts`](../../../src/engine/git.ts) for `taskDiff` — exported, memoized, with
its `origin/` prefix stripped.

`prEligible` replaces `tracked` on **both** the read and the enqueue in
`buildAll`. Applying it to the read matters: the Defect 1 spec deliberately left
`prfacts/explore-*.json` on disk as inert, and gating the read on anything
looser would bring PR #241 back to life on the Explore card.

The branch tested is the run record's — unchanged for a tracked run, and for a
synthetic run the record's branch *is* the live one.

Effect on existing cards: none, except that an Explore run whose agent created a
branch now finds its pull request, which it should always have.

### The needs-you flip

[`mostActive`](../../../src/engine/status.ts) ranks `working` above `needs-you`.
[`deriveBucket`](../../../src/engine/status.ts) is written expecting the
opposite — its ladder tests `needs-you` first and never sees it, because
`mostActive` has already discarded it in favour of some other repo's working
session.

With one session per repo that rarely surfaced. With four independent sessions
in `~/dev/agent-flow`, it does: three working and one waiting on you reads as
*In progress*, and the agent that needs you is invisible — the exact thing the
column exists to prevent.

`STATE_RANK` becomes `{ "needs-you": 3, working: 2, idle: 1, unknown: 0 }`.

This changes existing tracked cards: a multi-repo run with one repo working and
another ended-turn moves from **In progress** to **Action required**. That is
the intended reading, and it makes `deriveBucket`'s own doc comment true.

## Surface

```
┌────────────────────────────────────────────────┐   ┌────────────────────────────────────────────────┐
│ agent-flow   local            ended turn · 1h  │   │ PROJ-5772          In Review     working · 4s   │
│ main · +412 −38 · 6 files · dirty              │   │ webapp · PROJ-5772-bec-show-date-detected…     │
│ ▾ 4 agents                                     │   │ pr #318 · ✓ 12 checks · approved               │
│    agent-flow-2e    working · 12s   ·  3h      │   │ ▸ 2 agents                                     │
│    agent-flow-47    ended turn · 1h ·  5h      │   │                                                │
│    agent-flow-b5    idle · 2h       ·  5h      │   │                       [ Open ] [ Diff ]   ⋯    │
│    agent-flow-cd    idle · 4h       ·  6h      │   └────────────────────────────────────────────────┘
│                       [ Open ] [ Diff ]   ⋯    │      tracked, unchanged but for the agents row
└────────────────────────────────────────────────┘
```

- The disclosure row sits below the repo and PR rows, above the actions, on
  every card that has an open agent — tracked or local. A card with exactly one
  agent renders its name (`▸ agent-flow-2e`) rather than a count of one.
- Expanded, one row per session: the session's name, its own live state and
  activity age, and how long it has been open. Collapsed by default; the
  expansion state is webview-local and resets on reload.
- `local` is a muted chip beside the title, the same treatment as the existing
  `explore` chip. A card whose key was inferred carries `~inferred` beside the
  key.
- Session names are identifiers, so they are mono. Nothing on these cards is
  red: an idle agent is not a failure.
- Sorting is unchanged — liveliest activity, then `createdAt`. A local card's
  `createdAt` is its earliest session's start, so a place you have been in all
  day outranks one you just opened.
- Column placement is unchanged too: local cards go through `deriveBucket` like
  everything else and interleave with tracked ones.

### Track it

A local card's `⋯` offers **Track it**, plus *Open in Jira* when a key was
inferred. It has no **Forget** — nothing is stored, so there is nothing to
forget; closing the last session in a place removes the card.

**Track it** writes the synthetic run to `~/.agentflow/runs/`:

- key inferred and free → `PROJ-5641.json`, `kind: "task"`, keeping the ticket url
- key inferred but a tracked run already owns it → the `local-…` key, still
  `kind: "task"` with the url, so it polls Jira but cannot overwrite the record
  that exists
- no key → the `local-…` key, `kind: "explore"`, url `""`

All three are existing semantics with no new code path. It also deletes the now-
orphaned `prfacts/local-….json`; the run refetches once under its new key. On
the next refresh the place matches a tracked run, so the card renders as tracked
and there is never a duplicate.

### Toggle

A third header toggle beside **Live signal** and **PR facts** — **Open agents**,
backed by `agentFlow.openAgents`, default on. Off, the board is exactly what it
is today: no local cards, no agents row.

It is independent of Live signal, because the registry knows a session is *open*
without any transcript being read. With Live signal off, local cards still
appear, every `CardAgent.activity` is `unknown`, and the header falls back to
the existing `parked · git + Jira only` line.

## Cost

Twelve sessions collapse to six places, five of them not already on the board.

| Work added per refresh | Cost |
|---|---|
| Read the registry: 12 small JSON files + 12 `kill(pid, 0)` | negligible |
| `git rev-parse --show-toplevel` per distinct cwd | ~8 the first time, memoized after |
| `defaultBranch` per repo | 1–3 subprocesses the first time, memoized after |
| `gitState` per new place — 4 synchronous subprocesses each | ~20, against ~80 today |

So roughly **+25% on a cold refresh**, a few hundred milliseconds on the
extension-host thread. It is bounded by how many places are open, and the toggle
removes it entirely.

Making `gitState` asynchronous is the real fix and is deliberately not in scope:
the [untracked-runs spec](2026-07-27-deck-untracked-runs-diff-forget-design.md)
already named it as the deferred half of "a bit slow", and doing it here would
dwarf the feature.

## Testing

| Area | Cases |
|---|---|
| `readOpenSessions` | a dead pid is pruned; malformed JSON is skipped; a `kind` that is present and not `"interactive"` is dropped; an absent `kind` is kept; an unreadable directory yields `[]` |
| `groupByPlace` | two sessions in one cwd group once; a session in `repo/src` groups under `repo`; a cwd in no git repo groups under itself; symlinked and real paths group together |
| synthetic run | the key is stable across two reads of the same place, is filename-safe, and differs for two places sharing a basename; `createdAt` is the earliest session's `startedAt`; `summary` is the branch tail after the key, and the basename when there is no key |
| `readSessionActivity` | the named transcript is read even when a newer one sits beside it; an absent `<sessionId>.jsonl` yields `unknown` |
| the aggregate | four sessions decide the card, not the newest transcript; a tracked run with no session open keeps its per-repo state instead of dropping to `unknown` |
| inference | `PROJ-5641-team-table` → key and url; `feature/x` → none; `main` → none; `PROJ-12-x` when the config names `PROJ` → none |
| `defaultBranch` / `prEligible` | `origin/HEAD` present; absent with `origin/main`; absent with `origin/master`; no origin at all → `""` and not eligible; a non-git repo → not eligible; a feature branch → eligible |
| `buildAll` | a session matching a tracked repo path attaches there and spawns no second card; an unmatched place becomes a local card; a stale `prfacts/explore-*.json` on a default branch is not read; a local card on a feature branch enqueues a fetch; the toggle off drops local cards *and* the agents row |
| `status` | `needs-you` outranks `working` in `mostActive`; a place with one ended-turn agent among three working lands in Action required |
| `DeckApp` | collapsed and expanded agents row; a single agent renders its name; the `local` and `~inferred` chips; Track it posts and the card has no Forget; a tracked card shows both its agents |
| Track it | an inferred, free key writes `PROJ-5641.json` with the url; an inferred key a tracked run already owns writes the `local-…` key and leaves the existing record intact; no key writes an `explore` record; the orphaned `prfacts/local-….json` is deleted |

Existing tests that assert a multi-repo run's aggregate agent state may need
updating for the `STATE_RANK` flip.

## Scope

**In:** the session registry read, place grouping, attaching sessions to tracked
and local cards, the synthetic run, the two enrichment gates, the `STATE_RANK`
flip, the agents row and its expansion, Track it, and the `agentFlow.openAgents`
toggle.

**Out:** watching the registry with `fs.watch` (the Deck's existing refresh
cadence carries it), per-session actions such as focusing or killing a session,
making `gitState` asynchronous, headless and `-p` sessions, a Dismiss action for
local cards, and surfacing any of this in the tasks sidebar.
