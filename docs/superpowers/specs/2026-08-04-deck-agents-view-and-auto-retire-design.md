# Design: Agents view on the Deck, and auto-retiring stale runs

**Date:** 2026-08-04
**Status:** Approved, ready to plan

## Summary

Two changes to the Deck's In-flight board, related because the second is what
makes the first honest.

**1. An Agents view, and it becomes the default.** Today a card is a *run* — a
launch record whose target is a worktree or a `.code-workspace` — and every
Claude Code session found in that run's directories is nested underneath it by
`AgentsRow` ([DeckApp.tsx:140-172](../../../src/webview/DeckApp.tsx)). That
inverts: **one card per agent**, with the run's identity (repos, branch, Jira
key, PR) stated on the card. Today's grouping stays, one click away, as the
**Workspaces** view.

**2. Runs retire themselves.** Nothing prunes `~/.agentflow/runs` today, and
per-card `Forget` is the only removal path — so a record whose worktrees were
deleted weeks ago still renders a card and still costs a Jira poll every 30s. A
sweep retires a run once it is provably over — unreachable, landed a day ago, or
abandoned — with uncommitted or unpushed work as an absolute veto. A card lives
exactly as long as its record, so the board is never showing something the store
has given up on, or hiding something it still pays for.

## Decisions

| Question | Decision |
|----------|----------|
| What is a card in the new view? | One per `CardAgent`. Two agents in one worktree → two cards. |
| A run whose agent has exited? | Still one card (grey, `no agent · git + Jira only`). Once the work lands it stays for a **24h grace window**, then the sweep retires the record and the card goes with it. The board never hides a record it still holds — card lifetime and record lifetime are one thing. |
| Card anatomy | Agent leads: state + agent name on the top line; ticket, repos, branch and PR trail below. |
| Board arrangement | Today's four columns, unchanged. A session card is bucketed by *its own* state. |
| Where derivation lives | Webview-side projection of the `RunStatus[]` the host already posts. |
| Mode switch | Segmented control in the header, **persisted** to `agentFlow.deckGrouping` (`ConfigurationTarget.Global`). |
| Labels | **Agents** / **Workspaces**. |
| Default | `agents`. |
| Stale runs | Auto-retired on evidence, plus a `Clear stale` header action for abandoned runs still inside the age gate. |
| Retire safety | Uncommitted or unpushed work vetoes retirement outright. |

## Part 1 — the Agents view

### Why the webview projects it

`RunStatus` already carries everything an agent card needs:
`agents: CardAgent[]`, each with activity read per `sessionId`
([deckView.ts:579](../../../src/deckView.ts)), plus `repos`, `prs`, `jiraStatus`
and `run`. Agents mode is therefore a **re-projection of one payload**, not a
second pipeline: the mode switch is instant, both views stay in step by
construction, and the Jira/git/PR engine is untouched.

The rejected alternative — the host computing a card list and posting a new
`deck:cards` union — centralises derivation but makes the mode switch a host
round trip and churns the message contract for no behavioural gain.

### The one refactor this needs

Bucketing an agent card requires `deriveBucket`, which lives in
[status.ts](../../../src/engine/status.ts) next to imports that touch `fs`
(`gitState`, `readAgentActivity`, `runTarget`, `canon`). A webview module cannot
import that file.

Extract the three already-pure functions — `deriveBucket`, `prSignals`,
`mostActive` — plus `BucketInput` into a new **`src/engine/bucket.ts`** with no
`fs`-touching imports. `status.ts` imports and re-exports them, so every existing
host-side caller and its import sites are unaffected. Column logic stays
single-sourced across host and webview.

### Card projection

For each `RunStatus` in the posted list:

- **`agents.length > 0`** → one card per `CardAgent`, keyed `a:<sessionId>`.
  Column = `deriveBucket` with `agentState` set to *that session's* state and the
  run's `jiraCategory` / `jiraStatus` / `prSignals(prs)`.
- **`agents.length === 0`** → one card, keyed `p:<run.key>`, `agentState:
  "unknown"`. Renders grey with `no agent · git + Jira only`.

Keys are prefixed so an agent card and a parked card can never collide.

There is **no separate "hide finished parked runs" filter**, and the board never
hides a record it still holds. A card exists exactly as long as its record does;
what bounds the **Done** column is Part 2's 24h grace window on rule 2, not a
render-time rule. So Done shows the last day of landings — enough to see work
land, not enough to accumulate — and everything older is gone from disk, not
merely hidden.

This is the property the earlier draft of this spec got wrong by retiring finished
runs immediately *and* hiding them: two mechanisms that had to be kept in step,
plus a week-long window where a record was invisible but still cost a git spawn
per tick and a Jira poll per 30s.

The unchanged ladder is deliberate: `needs-you` outranks `working`, which
outranks the review stage, so an agent addressing PR feedback still reads *In
progress*, and a run with one working agent and one that ended its turn splits
across *In progress* and *Action required*. That split is the point of the view.

### Card body

Per the approved mockup (card style A):

```
● working · 12s ago                      agent-flow-2e
Improve loading page design
PROJ-5111 · webapp  e2e_suite
⎇ PROJ-5111-improve-loading-page-design
pr #398   ✓ 4 passing   review pending
                              [Open] [Diff] [⋯]
```

The ticket, repo chips and PR line repeat across sibling cards of the same run.
That redundancy is the accepted cost of agent-leading cards; it is what makes
each card answer "which workspace, which ticket, which PR" on its own.

Existing card conventions carry over unchanged: red only for real failures, mono
only for identifiers, no persistent hint lines. The agent name is an identifier
and takes `.id`; `no agent` is prose and does not.

### Actions

`Open` and `Diff` scope to the **session's own repo**, so each agent of a
multi-repo run opens the directory it actually runs in. `deck:inspect` already
accepts an optional `repo` name, so no host action code changes — but the webview
must know which repo a session sits in.

Add **`repo?: string`** to `CardAgent`. [deckView.ts:569](../../../src/deckView.ts)
builds those entries inside `for (const repo of run.repos)`, so the host already
holds the name at the point of construction; local runs have a single repo. A
parked card sends no `repo` and keeps today's run-level behaviour.

`Address PR`, `Track it` and `Forget` stay run-level and keep their existing
gates. On an agent card they act on the owning run — `Forget` on any card of a
run removes that run, as it does today.

### Degenerate cases

- **`Open agents` off** → no `CardAgent`s are attached to any run (`agentsByKey`
  stays empty; the underlying session read still happens, for the sweep — see
  "Reading sessions for the sweep"). Every run therefore has zero agents, and
  Agents mode renders one card per run: today's board minus the agents row.
  Coherent, and worth an explicit test.
- **`Live signal` off** → activities are `UNKNOWN_ACTIVITY`; agent cards still
  render per session, reading `open` in the parked tone. The registry still knows
  the session exists; only the transcript goes unread.
- **Stat tiles** count cards, not runs, in both views.
- **Sorting within a column** keeps today's rule: `lastActivityMs` desc, then
  `run.createdAt` desc.

### The mode switch

New setting **`agentFlow.deckGrouping`**: `"agents" | "workspaces"`, default
`"agents"`. Declared in `package.json` alongside the other Deck settings.

A segmented control sits in the header beside the `Live signal` / `PR facts` /
`Open agents` pills. Clicking it posts a new `deck:setGrouping` message; the host
writes the setting with `ConfigurationTarget.Global` and echoes the resolved
value back on the next `deck:runs`.

This is the first Deck control that persists — the three existing pills are
session-only by design, because they answer "how much should the board trust?"
per sitting. A *view* preference is not that: re-picking it every time the panel
opens is a daily papercut.

Workspaces mode keeps today's grouping, card layout and `AgentsRow` unchanged.
The one behavioural difference from what ships today is inherited, not chosen: the
retire sweep applies in both views, so a landed run leaves both a day after it
lands. The two views must agree on *which runs exist* and differ only in how they
group them — a card that vanishes when you switch view would be a worse bug than
anything the sweep does.

## Part 2 — auto-retiring stale runs

### The problem, concretely

Seven records in `~/.agentflow/runs`. Nothing prunes any of them today — five are
worth naming:

| record | age | state |
|---|---|---|
| `PROJ-5809` | Jul 23 | both worktrees deleted from disk; still Jira-polled every 30s |
| `PROJ-5111` | Aug 3 | one of two worktrees gone |
| `explore-make-verify-feature-command-generic` | Jul 21 | points at the main `webapp` checkout on `master` — nothing about it can ever change, so it can never leave the board on its own |
| `PROJ-5885` | Aug 3 | live work; carries a stray repo entry named `PROJ-5111` from a re-take |
| `review-technology-service-117` | Jul 29 | review-kind; never renders a card, worktree lingers |

A run record is a pointer. Retiring one deletes that pointer and its PR-facts
cache — precisely what `Forget` does today — and never touches a worktree,
branch, or commit.

### The rules

A new pure **`src/engine/retire.ts`** exposes a function returning a retire
reason or `null`. It is called from `buildAll` *after* statuses are built,
because rules 2 and 3 read `dirty` / `ahead` from the `gitState` that
`buildRunStatus` already computed — no extra git work. Retired runs are dropped
from the list `refresh` posts, so the board and the store never disagree.

**Every rule requires no live session on the run** (see "Reading sessions for the
sweep" below). Two new settings, one per timescale — landed work is over in hours,
an abandoned session takes days before you can be sure:

| setting | default | gates | `0` means |
|---|---|---|---|
| `agentFlow.retireFinishedAfterHours` | `24` | rule 2 | retire as soon as it lands |
| `agentFlow.retireAbandonedAfterDays` | `7` | rule 3 | disable rule 3 |

Rule 1 has no gate at all.

1. **Unreachable** — `run.repos.length > 0` and every repo path is gone from
   disk. Immediate: no age gate and no dependence on any feature toggle, because
   there is nothing left to `Open` or `Diff` and no work that could be lost.
   `workspaceFile` is deliberately not consulted — three of the seven records
   share one `.code-workspace`, so its existence says nothing about any single
   run. → retires `PROJ-5809`.
2. **Finished** — either every PR-bearing repo has merged, or `jiraCategory ===
   "done"` and **no entry in `prs` has `state === "OPEN"`** — and that has been
   true for ≥ `retireFinishedAfterHours`. Deliberately *not*
   `prSignals(prs).open`, which excludes drafts: a draft PR is unmerged work, and
   its worktree must keep its pointer. The no-open-PR clause matters at all
   because a ticket closed while its PR is still in review must not delete the
   pointer to the worktree that PR came from. → retires `PROJ-5111` a day after its
   ticket closes and its PR lands.
3. **Abandoned** — age ≥ `retireAbandonedAfterDays`, `!isTicketRun(run)`,
   `Object.keys(prs).length === 0`, and every repo clean. **Skipped entirely when
   `prFacts` is off**, since an empty `prs` map would otherwise be
   indistinguishable from "this run has no PR". → retires
   `explore-make-verify-feature-command-generic`.

### Timing rule 2's window

Rule 3's clock is `nowMs - run.createdAt` — the record already carries what it
needs. Rule 2's clock cannot be: `createdAt` is when the run was *launched*, so a
long task would retire the instant it landed while a same-day one would linger.

Nothing on disk records *when* a run finished, so the sweep stamps it: on the
first pass that sees a run satisfy rule 2's condition, it writes
**`finishedAt: number`** onto the record and retires nothing. A later pass with
`nowMs - finishedAt ≥ retireFinishedAfterHours` retires it. A run that stops
satisfying the condition — a PR reopened, a ticket moved back out of Done — has
`finishedAt` cleared, so its window restarts rather than resuming mid-count.

`finishedAt` is optional on `Run`, so every existing record stays valid and the
`Run` shape gains one nullable field. It is a *derived* stamp, not user data: a
hand-deleted one costs at most one extra grace window.

It has to live on disk rather than in a `DeckPanel` field. An in-memory stamp
restarts every time the panel opens, so a 24h window would only ever elapse if you
left the Deck open for a whole day — merged work would effectively never retire,
which is the bug this part exists to fix.

Rule 2 needs **positive** evidence of landing, so it fails closed: signed out of
Jira and with `prFacts` off, `jiraCategory` is null and `prs` is empty, neither
branch of the condition holds, and nothing is stamped or retired. A missing data
source can only ever make the sweep too conservative.

**The veto:** any repo with `dirty === true` or `ahead > 0` blocks rules 2 and 3.
The record is the only pointer back to that worktree, and unpushed work is
exactly what must not become unreachable. Rule 1 is exempt because a deleted
directory has neither.

### Reading sessions for the sweep

"No live session" must not be derived from the `openAgents` toggle. That toggle
is about *display*: with it off, [deckView.ts:562](../../../src/deckView.ts)
leaves `places` empty, so every run would look agentless and the sweep could
retire a run with an agent actively working in it.

So `buildAll` reads `groupByPlace(readOpenSessions(...))` **unconditionally** — a
cheap directory read — and `openAgents` continues to gate only what that read
feeds: attaching `CardAgent`s to cards, and synthesising `local` runs for
unclaimed places. The sweep consults the unconditional read.

Review-kind runs are swept too. They never render as cards — [deckView.ts:552](../../../src/deckView.ts)
filters them out — but their records and worktrees accumulate all the same, and
rules 1 and 2 apply to them unchanged.

Retirement is silent on the board (the card simply stops appearing) and writes a
`this.log` line naming the key and the reason, so a surprised user has something
to read.

### `Clear stale`

A header action applying **rules 2 and 3 with their time gates ignored** — every
veto still holds, and rule 1 needs no help since it is already immediate. It is
the escape hatch for both waits: clearing today's landings now rather than
tomorrow, and clearing an abandoned explore session without sitting out
`retireAbandonedAfterDays`.

Named `Clear stale` rather than `Clear finished` because it covers both rules, not
just landed work.

Behind a modal naming the count, unlike per-card `Forget` — a bulk delete earns a
confirmation. Hidden when the count is zero.

## Files touched

| file | change |
|---|---|
| `src/engine/bucket.ts` | **new** — `deriveBucket`, `prSignals`, `mostActive`, `BucketInput`, moved verbatim |
| `src/engine/status.ts` | import + re-export from `bucket.ts`; `buildRunStatus` unchanged |
| `src/engine/retire.ts` | **new** — the three rules, the veto, and the `finishedAt` stamp decision, pure |
| `src/types.ts` | `Run.finishedAt?`; `CardAgent.repo?`; `deck:setGrouping` and `deck:clearStale` inbound; `grouping` and `staleCount` on `deck:runs` |
| `src/config.ts` | `deckGrouping`, `retireFinishedAfterHours`, `retireAbandonedAfterDays` |
| `package.json` | declare all three settings |
| `src/deckView.ts` | fill `CardAgent.repo`; read sessions unconditionally; retire sweep + `finishedAt` stamping in `buildAll`; handle `deck:setGrouping` + `deck:clearStale` |
| `src/webview/DeckApp.tsx` | card projection, `AgentCard`, the segmented control, `Clear stale` |
| `src/webview/deckStyles.ts` | parked tone, segmented control, agent-card spacing |

## Testing

- `test/unit/engine/bucket.test.ts` — moved cases, behaviour unchanged.
- `test/unit/engine/retire.test.ts` — each rule fires; each veto blocks; a live
  session blocks every rule; rule 1 ignores `workspaceFile` and a zero-repo run;
  rule 2 spares a Jira-done run with an open PR **and one with a draft PR**; rule 2
  stamps rather than retires on first sight, retires once the window elapses, and
  clears `finishedAt` when the condition stops holding; rule 2 fails closed with no
  Jira and no PR facts; `retireFinishedAfterHours: 0` retires on the stamping pass;
  `retireAbandonedAfterDays: 0` disables rule 3; `prFacts` off skips rule 3;
  review-kind runs are swept.
- `test/unit/deckView.test.ts` — retired runs are absent from the posted list; the
  sweep deletes record + PR cache and bumps `prEpoch`; a stamped run is written back
  to disk and still rendered; **the sweep still sees sessions with `openAgents`
  off**; `deck:setGrouping` persists globally; `deck:clearStale` confirms then
  deletes and ignores both time gates; `CardAgent.repo` is filled.
- `test/webview/DeckApp.test.tsx` — two agents of one run split across columns; the parked card; `Open`/`Diff` carry the session's repo; `Open agents` off collapses to one card per run; toggling modes.

Gates before any commit: `npm run typecheck`, `npm test`, `npm run test:cov`
(thresholds enforced), `npm run build`.

## Out of scope

- The sidebar. This is the Deck's In-flight board only.
- The review-requests strip — unchanged in both views.
- Any change to how runs are *launched*, or to the runs-store format.
- Cross-linking sibling cards of one run (hover-highlighting, grouping rules).
  Accepted redundancy; revisit only if the repetition proves annoying in use.
- Fixing the stray repo entry a re-take can leave in a record — `PROJ-5885` holds
  one named `PROJ-5111` pointing into another run's worktree. The retire rules
  tolerate it correctly (a foreign worktree that still exists blocks rule 1, and
  dirty work in it vetoes rules 2 and 3 — both fail safe), so this stays a
  separate pre-existing bug.
