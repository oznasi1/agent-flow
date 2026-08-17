# Deck card anatomy — spend, true state, per-signal actions

**Date:** 2026-08-17
**Branch:** `feat/deck-card-anatomy`
**Backlog item:** D3

## Why

Three things the thin card should carry and does not:

1. **What a run costs.** Nothing on the board says how many tokens a task has
   burned. A run that has been looping for six hours looks exactly like one
   launched a minute ago.
2. **Whether an agent is actually stuck.** `deriveActivity` has four states and
   none of them means "waiting at a permission prompt" or "died mid-tool". Both
   collapse into `idle`, so the one genuinely stuck card renders in the calmest
   tone on the board.
3. **The action that matches the failure shown next to it.** A card can show
   `✗ integration · conflicts` and offer one button called *Address PR*, gated
   on the review column's waiting lane. The button does not name which of the
   two problems it will work on, and a card with a failing check outside that
   lane gets no action at all.

D3 was written with dependencies on two other items (E3 for state derivation,
E2 for action seeding). Neither exists in the repo. This design therefore
derives both itself; there is nothing to wait for.

## Decisions, and the measurements behind them

Every number below was measured against this machine's real
`~/.claude/projects` corpus during design, not estimated.

### The card prints an effort-weighted token figure, not a raw sum

Across the four most recent transcripts for this repo, deduplicated:

| class | tokens | share |
|---|---|---|
| input | 6,821 | 0.0% |
| output | 304,728 | 0.4% |
| cache write | 2,418,142 | 3.0% |
| cache read | 78,755,695 | **96.7%** |
| raw total | 81,485,386 | |

Cache reads are ~96.7% of raw tokens and are the cheapest class at roughly
0.1× the input rate. A raw sum therefore ranks cards by how long the
conversation got, not by what the work cost: two cards both reading "80M" can
differ by an order of magnitude in real spend.

The card prints an **effort-weighted equivalent**:

```
eq = input×1 + cacheWrite×1.25 + cacheRead×0.1 + output×5
```

For the corpus above that is 12,428,708 — 15% of the raw total.

These are the *ratios* between Anthropic's published rates, not absolute
prices. Ratios are stable across models, so this figure never goes stale the
way a hardcoded dollar table would, and it does not claim a dollar amount for
a subscription user who paid none. The unit label is `eq`, never `tok`, because
the number is not literally a token count. All four raw classes are stored
separately regardless, so the detail drawer can show the honest breakdown and a
future dollar view has what it needs.

### Usage must be deduplicated by `requestId`

On one real 6.1MB transcript: 102 assistant lines carried a `usage` object
across only **51 unique `requestId`s**. 37 of those ids appear more than once
(up to 4×), each repetition carrying an *identical* usage object — Claude Code
writes one line per content block of a multi-block assistant message, and every
line repeats the request's usage.

Summing naively inflates output tokens **2.44×**. Dedup by `requestId`, first
line wins, is a correctness requirement, not a defensive nicety.

### The stuck-agent label is neutral, because the data is ambiguous

A transcript whose last meaningful line is an `assistant` message with
`stop_reason: "tool_use"` and no `tool_result` after it means one of:

- the agent is sitting at a permission prompt;
- a tool is legitimately still running (a test suite, a build);
- the process died mid-tool.

The transcript cannot distinguish the first two. A live-session check separates
the third. So the label is **`stalled`**, which is true under either surviving
reading — something has been waiting on one tool for N minutes and you should
look — rather than `blocked`, which would assert a permission prompt the data
does not show.

The state is rare enough to be worth a tone: across 80 recent transcripts, 70
end cleanly at `end_turn`, 8 end at an unanswered `user` line, and 1 sits
mid-`tool_use`.

### `exited` means "died with work in flight", not "nothing is running"

On this machine's board, 10 runs exist and 5 have no live session. Defining
`exited` as "has a transcript, no live session" would stamp it on half the
board — a background condition, not a signal, and `parked` already covers
"nothing is running here".

`exited` is therefore the narrow case: the transcript stops **mid-work** (an
unanswered `tool_use`, or a `user` line with no assistant reply) **and** no
live session claims the run. That fires on roughly 10% of transcripts, and
every one of them is a card you would want to look at.

## Architecture

### 1. Spend

**New module `src/engine/usage.ts`**, split the way `transcript.ts` splits —
a pure reducer plus an fs-backed reader — so the reducer is testable without
touching disk.

```ts
export interface UsageTotals {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** Effort-weighted equivalent: the single number a card prints. */
export function weightedEq(t: UsageTotals): number;

/** Pure. Sums usage across lines, keyed by requestId — first line wins.
 *  `seen` is threaded in and mutated so an incremental reader can carry
 *  dedup state across chunk boundaries. */
export function accumulateUsage(
  lines: TranscriptLine[],
  into: UsageTotals,
  seen: Set<string>,
): UsageTotals;
```

`TranscriptLine` gains the fields this reads: `requestId?: string` and
`message.usage?` / `message.id?`. The dedup key is `requestId`, falling back to
`message.id`; a line carrying neither is counted (it cannot be deduplicated, and
dropping it would understate spend).

**The reader is incremental.** Transcripts are append-only, so a per-file cache
entry holds:

```ts
interface FileUsage {
  size: number;            // file size at last read
  totals: UsageTotals;
  seen: Set<string>;       // requestIds already counted
  pendingTail: string;     // bytes after the last newline, held over
}
```

Each sweep stats the file and reads only `[cached.size, size)`, prepending
`pendingTail` so a line split across two reads is parsed once and whole. When
`size < cached.size` the file was truncated or replaced, and the entry is
discarded and rebuilt from zero.

`seen` is bounded by request count, not by bytes — 51 ids for a 6MB file — so
holding it for the lifetime of the extension host is cheap.

**Cold start never touches the whole corpus.** The corpus here is 490MB across
262 transcripts, largest single file 50MB. Two things keep the cost off that
scale:

- Only project dirs belonging to runs **on the board** are read — about 10
  dirs, resolved through the existing `encodeProjectDir` join.
- A `line.includes('"usage"')` string test rejects a line before `JSON.parse`.
  Most lines in a transcript carry no usage.

**The parse never runs on the 6s tick.** `POLL_MS` is 6000 and `refresh()` must
stay non-blocking. The usage sweep runs on its own 60s cadence plus one sweep at
activation; `refresh()` reads the last-computed totals out of memory. A card
whose totals have not been computed yet shows no figure rather than a zero —
absent and "cost nothing" must not render the same.

**Aggregation.** Per-card totals sum **every** transcript in the run's repos'
project dirs, with **no branch join**. This is a deliberate simplification of
the join `readAgentActivity` performs, and the reason is the fast path: the
sweep is affordable only because it rejects a line on `includes('"usage"')`
before parsing it, and a branch join needs `gitBranch`, which lives on
precisely the lines that test skips. Reinstating the join would mean parsing
most lines in a 50MB file to attribute the few that carry usage.

The cost is bounded by how Agent Flow actually works: a task launched into a
worktree gets its own cwd, so its project dir already contains exactly one
branch's sessions and the figure is exact. Only a run whose repo is checked out
directly — where several branches' sessions share one dir — reads high, and
there the figure is the honest total for that directory. The tooltip says which
it is: *"across every session in this task's directories"*.

The header stat is the **sum of the cards currently on the board**, labelled
"Tokens on board" — not "today", which would need per-line day bucketing and
would print a figure that disagrees with the cards beneath it.

### 2. Honest state

`AgentState` widens:

```ts
export type AgentState =
  | "working" | "needs-you" | "stalled" | "exited" | "idle" | "unknown";
```

`AgentState` is the key type of three `Record<AgentState, …>` maps — `STATE_RANK`
in `engine/activity.ts`, `STATE` in `webview/deckParts.tsx`, `STATE_HUE` in
`webview/OrchestratorDrawer.tsx`. Widening the union makes `tsc` name every site
that must be updated, so no renderer can silently fall through to a default.

**`stalled` is derived in the pure reducer.** `deriveActivity` gains pending-tool
detection: the last meaningful line is an `assistant` with
`stop_reason: "tool_use"` and no `tool_result` after it. Fresh (within
`WORKING_WINDOW_MS`) stays `working` — a tool that started ten seconds ago is
not stalled. Stale becomes `stalled`.

**`exited` is derived one level up.** Liveness is not visible to a pure
per-file reducer, so `AgentActivity` gains `midWork: boolean` — true when the
transcript ends on an unanswered `tool_use` or on a `user` line with no
assistant reply — and `buildRunStatus` promotes
`midWork && state !== "working" && agents.length === 0` to `exited`. This keeps
the pure/impure split intact: the reducer reports what the file says, `status.ts`
reconciles it against the session registry it already reads.

The `state !== "working"` conjunct is load-bearing, and this spec's first draft
omitted it. `midWork` is true for a transcript written *moments* ago with a
pending tool call, because that transcript also ends with work owed — so the
two-term formula promoted a live, actively-working agent to `exited` whenever the
`agents` list handed in was empty. That is not a corner case: the per-repo
fallback path passes no agents for a tracked run whose transcript is warm but
whose session the registry has not recorded. Three pre-existing tests caught it
during implementation. Only a reading that has already gone stale — `stalled`,
or an unanswered prompt sitting at `idle` — with no live session behind it has
actually died.

On the Agents lens a card *is* one live session, so `exited` is unreachable
there by construction.

**Ranking and bucketing.** Only `stalled` ever reaches `mostActive` — `exited` is
assigned by `buildRunStatus` *after* the reduction, so it never competes as an
input. `STATE_RANK` becomes:

```ts
{ "needs-you": 5, stalled: 4, exited: 3, working: 2, idle: 1, unknown: 0 }
```

`stalled` outranks `working` for the same reason `needs-you` already does: a run
with one working agent and one stalled agent is a run that needs a human, and
letting the working agent bury the stalled one is the exact bug the existing
`STATE_RANK` comment describes. `needs-you` still outranks `stalled` — a turn
that has handed control back is more actionable than a tool that has not
returned. `exited` is given a rank for totality; it is unreachable as a
`mostActive` input by construction.

The promotion in `buildRunStatus` reads `midWork` off the **reduced** activity.
`mostActive` returns one of its inputs whole, so `midWork` travels with the
reading that won.

`deriveBucket` routes both `stalled` and `exited` to `needs`. **This moves cards
into Action required** — which is the point of the item, but it is a visible
change to board membership, and reviewers should see it named rather than
discover it.

### 3. Per-signal actions

**Host protocol.** `deck:addressPr` is superseded by:

```ts
| { type: "deck:seedPrWork"; key: string; reason: "ci" | "conflict" | "review"; detail?: string }
```

`deck:addressPr` stays accepted as an alias mapping to `reason: "review"`. The
webview ships with the host so the alias is not strictly reachable, but the
extension has thousands of installs and a stale webview must not hit an unknown
message.

The handler reuses `addressPr`'s body unchanged — run lookup, the `local` guard,
`ticketKeyFor`, the multiroot/per-window `matches` split, `writePlanFile`, the
collected-failures toast. Only the template differs: the existing
`prReviewTemplate(cfg.prReviewPrompt, cfg.prReviewAutoFix)` output gains a
prefix clause naming the concrete failure, e.g. *"CI check `integration` is
failing on #3181."* **No new configuration settings**, so there is nothing for
an existing user to migrate.

**Webview.** A new pure function beside `cardSignal` in `webview/deckSignal.ts`:

```ts
export interface SignalAction {
  tone: "bad" | "warn";
  text: string;                                  // "✗ integration, lint"
  label: string;                                 // "Fix CI"
  reason: "ci" | "conflict" | "review";
  detail?: string;
}

export function cardActions(r: RunStatus): SignalAction[];
```

It reads the same `leadPr(r)` the signal line reads, so the rows can never
contradict the bits above them, and returns rows worst-first: failing CI,
then conflict, then changes-requested.

The card renders `.c-rows` — one row per action, PR number leading the first
row — when `cardActions` is non-empty, and today's `.c-sig` line untouched
otherwise. The two are **mutually exclusive**: a failing card shows the rows
*instead of* the signal line, so the `#pr · ✗ check · conflicts` bits are not
restated above rows that name the same facts. The consequence is that a failing
card stops showing its diff totals and branch, which is the correct trade —
"how big" already loses to "what is wrong" in `cardSignal`'s own three-bit cap,
and both remain in the detail drawer.

A healthy card is byte-identical to what ships now. `canAddressPr` and its lane
gate are deleted; every reason to address a PR now has its own named action, so
a generic verb could only duplicate one of them.

**Layout.** Spend sits on the footer row, right-aligned past the buttons
(`margin-left: auto`), in space that is dead today. It was placed there rather
than on the top row, which wraps the ticket key onto a second line whenever the
state text is long, or on the signal line, which would break the three-bit cap
and truncate the branch further.

A card with three failures grows past the `min-height: 152px` floor. That ends
the uniform density the two-tier card established, and is accepted: attention
should follow size, and only broken cards pay it.

Candidates were rendered against the real `DECK_CSS` before this was chosen;
the throwaway harness is `preview/d3-options.html` + `preview/shoot-d3.js`
(both gitignored), and the chosen shape is variant `g2`.

## Data flow

```
~/.claude/projects/<encoded cwd>/*.jsonl
  │
  ├─ readAgentActivity ─── deriveActivity ──→ AgentActivity { state, midWork, … }
  │                                                │
  │                          buildRunStatus ───────┤ promotes midWork + no session → exited
  │                                                │
  ├─ usageSweep (60s) ─── accumulateUsage ──→ UsageTotals per file
  │      (incremental, dedup by requestId)          │
  │                                                 └─→ per-run totals → RunStatus.usage
  │
  └─ refresh() (6s) reads computed totals from memory, never parses

RunStatus → webview
              ├─ stateView      → status line  (working | ended turn | stalled | exited | idle | parked)
              ├─ cardSignal     → .c-sig       (unchanged, healthy cards)
              ├─ cardActions    → .c-rows      (one row + action per failure)
              └─ weightedEq     → footer spend figure  ("380k eq")

card action click → deck:seedPrWork { key, reason, detail }
                      → prReviewTemplate + reason clause → writePlanFile → openInEditor
```

## Error handling

Every new read follows the module's existing posture: best-effort, degrade to
the git + Jira backbone, never throw into a refresh.

- Unreadable project dir, unreadable file, `stat` failure → that file
  contributes nothing; other files still count.
- A malformed JSONL line → skipped by the existing per-line `try`/`catch`. A
  partially-written trailing line is held in `pendingTail` and parsed on the
  next sweep.
- A `usage` object with missing or non-numeric fields → each field defaults to
  0 rather than poisoning the total with `NaN`.
- Totals not yet computed → the card shows **no** figure. Never `0`.
- `weightedEq` of all-zero totals → no figure, same rule: a run that has
  genuinely burned nothing and a run not yet measured must not look alike.

## Testing

Unit tests, `vitest`, alongside the existing suites:

- `test/unit/engine/usage.test.ts` — `accumulateUsage` dedups by `requestId`;
  falls back to `message.id`; counts a line with neither; ignores lines with no
  usage; defaults missing fields to 0; `weightedEq` applies the four
  coefficients. A fixture reproducing the real 4×-repeated-`requestId` shape,
  asserting the deduplicated total rather than the 2.44×-inflated one.
- Incremental reader — a temp file appended to between two sweeps yields the
  same totals as one full read; a line split across the chunk boundary is
  counted once; a truncated file rebuilds from zero.
- `test/unit/engine/transcript.test.ts` — extended: unanswered `tool_use` when
  fresh is `working`, when stale is `stalled`; `midWork` true for an unanswered
  `tool_use` and for a trailing `user` line, false after `end_turn`.
- `test/unit/engine/status.test.ts` — extended: `midWork` with no agents
  promotes to `exited`; `midWork` with a live agent does not.
- `test/unit/engine/bucket.test.ts` — extended: `stalled` and `exited` route to
  `needs`; `STATE_RANK` orders them below `needs-you` and above `idle`.
- `test/unit/webview/deckSignal.test.ts` — `cardActions` returns rows
  worst-first; returns `[]` for a healthy PR and for a run with no PR; reads the
  same lead PR as `cardSignal`.
- Webview render tests for the new rows and the spend figure, following the
  existing `waitFor` discipline — a `FileReader`-style async read outliving a
  `setTimeout(0)` has leaked a send into the *next* test before.

Every test must fail against unmutated current code before it counts as
covering anything.

## Gates

The branch is not done until all four pass:

```
npm run typecheck     # tsc --noEmit
npm test              # vitest run
npm run build         # node esbuild.js
npm run test:cov      # thresholds: statements 90, branches 85, functions 85, lines 90
```

`npm run build` is not optional and not covered by the other three: it is the
**only** gate that catches a webview module reaching a Node builtin. `tsc` and
the full suite both pass regardless. `src/webview/` must not import `fs`, `os`,
`path`, or `child_process`, even transitively — which is precisely why
`accumulateUsage` and `weightedEq` live where the reducer can be imported
without the reader. `weightedEq` is called from the webview; the fs-backed
sweep is not.

## Non-goals

- **No dollar figure anywhere.** Not on the card, not in the drawer. A price
  table goes stale and lies to subscription users.
- **No per-day or historical spend.** One cumulative figure per run, one board
  total. No time series, no "today".
- **No `blocked` label.** The data cannot support the claim; see the decision
  above.
- **No new configuration settings.**
- **No change to the drawer's own layout.** The full four-class breakdown is a
  natural follow-up but is not in this branch.

## Risks

| risk | mitigation |
|---|---|
| Cold-start sweep is slow on a large corpus | Board-scoped dirs only; `"usage"` string pre-filter; off the 6s tick entirely |
| `eq` reads as a token count and misleads | Unit label is `eq`, never `tok`; tooltip states the formula |
| `stalled` fires on a long legitimate tool run | Label chosen to be true under that reading too |
| Routing `stalled`/`exited` to `needs` churns the board | Named explicitly here; both are rare (~10% of transcripts) |
| `AgentState` widening misses a renderer | Three `Record<AgentState, …>` maps make it a compile error |
