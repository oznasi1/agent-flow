# In-flight session cleanup

**Date:** 2026-08-12
**Status:** Design approved, not implemented
**Baseline:** `3db28ea` (0.15.0)

## Problem

The In-flight board shows every run record that exists, forever. Two independent
faults produce the mess:

**1. One session renders as many cards.** `buildAll` attaches every live Claude
Code session found in a directory to *every* run record holding that directory
([`src/deckView.ts:2091-2109`](../../../src/deckView.ts)). Notepad and Explore
runs launch in place rather than in a worktree, so they all point at the same
checkout. On the author's machine today:

```
notepad-the-start-button-should-be-above-the-edi-… | /Users/oznasi/dev/agent-flow
notepad-add-indication-for-the-ticket-the-type-o-… | /Users/oznasi/dev/agent-flow
notepad-add-option-of-drag-and-drop-to-the-notpa-… | /Users/oznasi/dev/agent-flow
notepad-the-details-int-notepad-task-is-not-atta-… | /Users/oznasi/dev/agent-flow
```

Two agents open in that checkout render as eight cards under the Agents lens.
The two `explore-` runs that both hold `centaur` double the same way.

**2. Nothing prunes a ticketless run.** `retireVerdict` rule 3
([`src/engine/retire.ts:88-97`](../../../src/engine/retire.ts)) needs
`retireAbandonedAfterDays` (default 7) *and* an authoritative empty PR map. A
notepad run has no ticket and no PR, so it sits on the board a full week after
its agent was closed.

Together: closing an agent removes nothing, and every closed run keeps
multiplying against every session that later opens in the same directory.

## Goal

A card is on the board while it represents work that is actually moving.
Everything else collapses into one quiet line the user can expand, and retires
on its own. One live session renders as exactly one card.

## Scope

In scope: the In-flight board's membership rule, session/path attribution, a
Recently-closed strip, and the retire sweep.

Out of scope, deliberately:

- `deriveBucket`. Which of the four columns a board card lands in is unchanged.
- The Review strip and the Orchestrator drawer.
- The Notepad tab itself. A note's own lifecycle (done, delete) is separate from
  its run's.
- Any change to worktree, branch or commit cleanup. Retirement removes a *record*,
  never work.

## Design

### 1. Visibility rule

New pure module `src/engine/visibility.ts`:

```ts
export type Shelf = "board" | "closed";

export interface VisibilityInput {
  /** A Claude Code session open in a path this run OWNS (see §2). */
  hasLiveSession: boolean;
  /** Any PR still OPEN, draft included. */
  prOpen: boolean;
  /** Every PR-bearing repo merged, or the ticket is done. */
  landed: boolean;
  /** A ticket run whose category is not "done". */
  ticketActive: boolean;
  /** dirty || ahead > 0, counted on OWNED paths only (see §2). */
  hasWorkToLose: boolean;
}

export function shelfFor(i: VisibilityInput): Shelf;
```

`"board"` if any field is true; `"closed"` otherwise.

`landed` keeps finished work on the board so it sits in the Done column until it
retires, rather than skipping straight to the strip. The four columns and
`deriveBucket` are untouched — `shelfFor` decides *membership*, `deriveBucket`
decides *which column*.

Lives in its own module, free of `fs`-touching imports, for the same reason
`bucket.ts` does: `src/webview/` may need to import it, and the webview bundle
cannot reach `fs`. A test enforces the constraint, mirroring `bucket.test.ts`.

**Known tradeoff.** A taken ticket with no agent, no PR and nothing changed stays
on the board indefinitely. This is deliberate and matches today's sweep, whose
abandoned rule already exempts ticket runs (`!isTicketRun(i.run)`). Tracked work
you took is a commitment; a notepad line is not.

### 2. Session and path ownership

New pure module `src/engine/ownership.ts`. Two rules, applied in order.

**Session ownership.** A session running in place `P` is claimed by exactly one
run: among the runs holding `P`, the newest whose `createdAt <= session.startedAt`
— the run that plausibly launched it. If no run qualifies (the session predates
every run, or `readOpenSessions` defaulted a missing `startedAt` to `0`), the
newest run holding `P` claims it. Ties on `createdAt` break on `run.key`
ascending, so the result is stable refresh to refresh.

**Path ownership.** A path `P` is owned by the run that claimed a live session in
it; if no session is running there, by the newest run holding `P`, same tie-break.

Path ownership exists because the four notepad runs share one *non-worktree*
checkout. Without it that single dirty working tree reads as `hasWorkToLose` on
all four runs, every one of them stays on the board, and the cleanup accomplishes
nothing. With it, the dirty state counts once, for the run that owns the path.

```ts
export interface OwnershipInput {
  runs: Run[];                                   // tracked runs, any order
  sessionsByPlace: ReadonlyMap<string, OpenSession[]>;
}
export interface Ownership {
  /** sessionId -> owning run key. */
  sessionOwner: ReadonlyMap<string, string>;
  /** canonical path -> owning run key. */
  pathOwner: ReadonlyMap<string, string>;
}
export function resolveOwnership(i: OwnershipInput): Ownership;
```

`buildAll`'s attach loop consults `sessionOwner` before pushing a `CardAgent`, and
the visibility inputs consult `pathOwner`. Local (untracked) runs are built from
the places *no tracked run claimed*, which is unchanged — ownership only
disambiguates between tracked runs.

**Ownership feeds `shelfFor` and the agent attach, and nothing else.** Repo chips
keep rendering on every card that holds a path: a card showing the state of the
directory it points at is information, not a bug.

**This applies regardless of the setting in §5.** Rendering one agent as four
cards is a defect, not a preference.

### 3. Recently closed strip

New `src/webview/ClosedStrip.tsx`, rendered between the board and the legend in
`DeckApp` — after the `.board` div, before `.legend`. Collapsed by default;
collapse state is component-local, like `reviewsCollapsed`.

Collapsed it is one line: `▸ Recently closed  5`. Expanded it is one row per
closed run, newest-closed first:

| dot | key (mono) | title | `closed 4h ago` | **Reopen** | **Forget** |

The two row actions appear on hover or focus only, and reuse messages that already
exist — `deck:inspect { action: "open" }` and `deck:forget`. The strip header
carries **Clear all**, which posts one `deck:forget` per row.

A mockup of the collapsed and expanded states, built from the real `DECK_CSS`,
lives at `preview/inflight-cleanup-options.html` (generator:
`preview/build-inflight-options.js`). `preview/` is gitignored.

**Timestamp.** `Run` gains `closedAt?: number`. The sweep stamps it the first time
a run shelves as `closed` and clears it if the run comes back to the board — the
same stamp/unstamp machinery `finishedAt` already uses, and for the same reason:
the window must survive a panel reload.

Wire protocol: `deck:runs` already carries whole `RunStatus` objects, so each one
gains a `shelf: Shelf` field and the webview partitions on it. No new message type.

### 4. Retirement

`retireVerdict` gains a closed path. Rule order, most-decisive first:

1. Live-session veto (unchanged) — clears any stamp and keeps the run.
2. Rule 1, unreachable (unchanged).
3. Rule 2, finished (unchanged).
4. **Rule 2b, closed** — new.
5. Rule 3, abandoned (unchanged; still the 7-day backstop for anything 2b misses).

Rule 2b fires when `shelfFor` returns `"closed"`:

- `closedAfterMs <= 0` → `{ action: "retire", reason: "closed" }`
- no stamp yet → `{ action: "stampClosed", closedAt: nowMs }`
- `nowMs - closedAt >= closedAfterMs` → `{ action: "retire", reason: "closed" }`
- otherwise → `{ action: "keep" }`

and, as with rule 2, a run that is no longer closed yields `{ action: "unstampClosed" }`
so the window restarts from scratch rather than resuming mid-count.

`RetireVerdict` gains `stampClosed` / `unstampClosed`; `RetireReason` gains
`"closed"`. `RetireInput` gains `shelf: Shelf` and `closedAfterMs: number` —
`shelf` is passed in rather than recomputed, so there is exactly one place that
decides what "closed" means.

**The dirty/ahead veto is unchanged and remains load-bearing.** A record is the
only pointer back to its worktree. A run with uncommitted or unpushed work has
`hasWorkToLose: true`, so `shelfFor` returns `"board"` and rule 2b never fires —
the visibility rule and the retire veto agree by construction rather than by
coincidence.

**`hasLiveSession` deliberately means two different things, and must stay that
way.** `RetireInput.hasLiveSession` is today's rule: *any* session open in *any*
of this run's directories, ownership ignored, because a record must never be
deleted out from under somebody who is working. `VisibilityInput.hasLiveSession`
is ownership-scoped, because a session belongs on one card. A non-owner run
sharing a directory with a live session therefore shelves as `closed` — one strip
row, not a duplicate card — while the retire veto still refuses to delete it. It
sits in the strip until the session closes, then ages out normally. This is the
intended behaviour; an implementer who "fixes" the two to match will either
resurrect the duplicate cards or start deleting live records.

### 5. Settings

Two new entries in `package.json` `contributes.configuration`, read in
`src/config.ts`:

- **`agentFlow.inflightShowAll`** — boolean, default `false`. When `true`, every
  run record renders on the board exactly as it does today: no `shelf`
  partitioning, strip hidden, no `closedAt` stamping, and rule 2b never fires.
  The escape hatch for a user who used stale cards as a to-do list.
- **`agentFlow.retireClosedAfterHours`** — number, default `24`, clamped at 0.
  `0` retires a closed run on sight.

`inflightShowAll` does **not** disable §2. Ownership is a correctness fix.

### 6. Testing

New:

- `test/unit/engine/visibility.test.ts` — the shelf table field by field, plus the
  case this design exists for: four runs sharing one dirty non-worktree checkout,
  where only the owner shelves as `board`.
- `test/unit/engine/ownership.test.ts` — the four-notepad-runs scenario; a session
  that predates every run; `startedAt: 0`; a `createdAt` tie resolving on key; a
  session in a path no tracked run holds (must stay unclaimed, so local-run
  building is unaffected).
- `test/webview/ClosedStrip.test.tsx` — collapsed and expanded render,
  Reopen/Forget message payloads, Clear all.

Extended:

- `test/unit/engine/retire.test.ts` — 2b stamp, unstamp, retire, the dirty/ahead
  veto, the non-owner-with-a-live-session case above, and rule ordering against
  rules 2 and 3.
- `test/unit/engine/bucket.test.ts`'s no-`fs`-imports guard (it reads
  `src/engine/bucket.ts` and asserts on its source), extended to cover
  `visibility.ts` and `ownership.ts`.
- `test/webview/DeckApp.test.tsx` and `test/unit/deckView.test.ts` — the board
  membership assertions that the new default changes.

**Expected breakage, stated up front:** the default board changes, so existing
deck tests that assert board contents under default config will need updating.
This design does *not* satisfy "the existing suite passes unmodified" — that is
impossible given the on-by-default rollout, and pretending otherwise would send an
implementer hunting for a way to have both.

Gates every implementation task must pass, restated here because a task brief is
what an implementer follows:

| Gate | Catches |
|---|---|
| `npm run typecheck` | `tsc --noEmit` clean |
| `npm test` | vitest, full suite |
| `npm run test:cov` | coverage thresholds are enforced |
| `npm run build` | the **only** gate that catches an `fs` import leaking into a webview bundle |

## Rollout

On by default, with `agentFlow.inflightShowAll` as the single way back. Users get
the cleanup without configuring anything; anyone who preferred the old board flips
one setting.
