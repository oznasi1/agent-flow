# Deck: attention that survives a closed panel

**Date:** 2026-08-24 · **Branch:** `docs/e1-attention-spec` · **Status:** approved design, not yet planned

## Problem

The Deck's poll stops when its panel hides. `deckView.ts` wires
`onDidChangeViewState` to `startPolling()` when `this.panel.visible || this.hasArmedFlow()`
and `stopPolling()` otherwise, so with the panel closed and no flow armed nothing reads
transcripts, nothing re-derives columns, and nothing renders. There is no badge on the
activity bar anywhere in the extension, and every toast the Deck raises goes to a webview
that is not on screen.

The consequence: a run entering **Action required** while the Deck is closed is completely
silent. The session is parked waiting for you and nothing anywhere says so.

## What it buys users

The product's premise is *launch several sessions, go do something else*. The payoff moment
is "come back when one wants you" — and today that signal exists only while you are already
looking at the thing it would tell you about. The most valuable half of the loop is the half
that is missing.

Concretely: a session that hits a permission prompt at minute two sits idle until you happen
to open the Deck. With parallel sessions — the whole point of the Deck — that idle time
compounds per session rather than being amortised across them.

The two tiers are also the right two. A badge is **ambient**: zero interruption, always in
the activity bar, ignorable, correct for "two sessions are parked." A toast is an
**interrupt**, which is why it is opt-in and edge-triggered.

## Decisions taken

| Question | Decision |
| --- | --- |
| What does the badge count? | **Exact Deck parity** — precisely the cards the Deck would draw in Action required. Shelved runs excluded, local/untracked session cards included. |
| Which window announces an edge? | **Focused window only** (`vscode.window.state.focused`), and it claims the edge cross-window so no other window re-announces later. |
| Defaults | **Badge on, toast off.** One new setting, `agentFlow.notifyOnActionRequired` (boolean, default `false`). |

## Design

### 1. The shared reduction — `src/engine/attention.ts`

A new leaf module, `fs`-free like `bucket.ts` and `visibility.ts`, owning the whole decision
so it exists in exactly one place:

```ts
export interface AttentionCandidate {
  key: string;
  agentState: AgentState;
  prs: PrEntryMap;
  hasLiveSession: boolean;
  justLaunched: boolean;
  hasWorkToLose: boolean;
  showAll: boolean;        // getConfig().inflightShowAll — bypasses shelfFor entirely
}

/** Keys of every candidate the Deck would draw in Action required, board order. */
export function attentionKeys(candidates: AttentionCandidate[]): string[];

/** The `inPlace` rule: does this run's dirty/ahead state count as work to lose?
 *  False for a ticketless Explore or Notepad run — its checkout is your own work
 *  in progress, not the session's. Extracted so neither caller re-derives it. */
export function ownsWorkToLose(run: Run): boolean;
```

`attentionKeys` runs `shelfFor` and then `deriveBucket` per candidate and keeps the ones that
land in `needs`. It returns **keys, not a count**: the badge needs only cardinality but the
toast needs identity, and returning keys makes the edge-trigger a plain set diff.

`showAll` is a field rather than a config read because `attention.ts` must stay a pure leaf,
and because `deckView.ts` already branches on `getConfig().inflightShowAll` before calling
`shelfFor` — a candidate with `showAll: true` is on the board unconditionally, exactly as the
Deck treats it.

`ownsWorkToLose` exists because `hasWorkToLose` is the one input whose derivation is
non-obvious (`!inPlace && repos.some(r => ownsPath(r.path) && (r.dirty || r.ahead > 0))`),
and duplicating the `inPlace` half in the gatherer is precisely the fork this design is
meant to prevent.

### 2. The gatherer — `src/engine/attentionFs.ts`

The `*Fs` sibling the repo's pure/`*Fs` convention mandates. It produces
`AttentionCandidate[]` from cheap readers, injected so the cost invariant is testable:

```ts
export interface AttentionDeps {
  runsDir: string;
  sessionsDir: string;
  prFactsDir: string;
  projectsRoot: string;
  nowMs: number;
  showAll: boolean;
  openAgents: boolean;
  gitState: (name: string, repoPath: string) => RepoGit;   // injected: the expensive one
}
export function gatherAttention(deps: AttentionDeps): AttentionCandidate[];
```

**Cost ladder per tick**, cheapest first:

1. `readRuns(runsDir)` + `readOpenSessions(sessionsDir)`. Already paid by the existing
   notepad poll, so free — hoist both into one read per tick that the notepad job and this
   one share.
2. Agent state per run, from `readSessionActivity` / `readAgentActivity` — a tail read of one
   `.jsonl` per run. This is the new recurring cost.
3. **Only for runs already in a needs agent state** (`needs-you | stalled | exited`):
   `readPrEntries(prFactsDir, key)` for `prMerged` — a file read of the cache, never a fetch.
4. **Only for a needs-state run with no live session** — in practice only the `exited` case:
   `gitState` for `hasWorkToLose`.

Two facts make rung 4 much narrower than it first appears. Local (untracked) cards are
synthesized from open-session places, so they always have `hasLiveSession: true` and
therefore `shelf === "board"` without any git call. And a tracked run in `needs-you` or
`stalled` is being read from a live session's transcript. So the steady state is **zero git
calls**, and the busy case is a handful.

`openAgents` gates local-card synthesis exactly as `deckView.buildAll` does (`places` is
empty when the toggle is off, so no local cards exist). It comes from `getConfig()`, so the
tick can see it — parity is preserved without reaching into the panel.

No `gh`, no `glab`, no Jira, on any rung. The hidden path never touches a forge.

### 3. The badge — `src/tasksView.ts`

One public method, mirroring the shape `postNotepad` already has for exactly this reason:

```ts
public setAttention(keys: string[]): void;
```

Sets `this.view.badge = { value, tooltip }`, and `undefined` — not `{ value: 0 }` — when the
count is zero. Tooltip wording is constrained by the vocabulary invariant, which
`test/unit/vocabulary.test.ts` enforces: **"sessions", never "agents"**. So
*"2 sessions are waiting on you — open the Deck"* (singular form for one).

The badge lives on the Tasks view but counts Deck cards. The `agentFlow` container
contributes exactly one view, so the container icon carries the badge with no ambiguity
about which view it belongs to, and the tooltip names the Deck.

**Known limitation.** `this.view` is undefined until the sidebar container is opened at least
once in that window — VS Code resolves a webview view lazily. A window where the user never
clicked the Agent Flow icon has nothing to badge. Mitigation: hold the last keys in a field
and apply them from `resolveWebviewView` as well, which covers the common case (opened once,
then collapsed or another view focused) and leaves only never-opened windows uncovered. Not
worth converting the view to a `TreeView` to fix.

### 4. The toast

A pure edge function, also in `attention.ts`, table-testable:

```ts
export function nextAnnouncements(
  current: string[],
  announced: Record<string, number>,
  knownKeys: string[],
  nowMs: number,
): { toAnnounce: string[]; announced: Record<string, number> };
```

The latch is **level-triggered**, unlike the flow engine's `firedAt` (permanent until Reset).
Entering the set announces; leaving it clears. Park → you answer → park again therefore
toasts twice, which is the correct behavior — the second parking is new news.

`knownKeys` is what prunes the record so it cannot grow without bound, the same discipline
`pruneNoteOrder` already applies to note order in `tasksView.ts`.

The latch is durable and cross-window, at `~/.agentflow/attention.json`. In-memory would
re-announce on every extension-host restart and once per open window besides. A lost write
race costs at most one duplicate toast, so last-write-wins is proportionate — say so in the
comment rather than reach for the orchestrator's lock.

Three rules keep the toast from becoming a nuisance:

- **Focus gate.** Only a window with `vscode.window.state.focused === true` announces, and it
  claims the edge on everyone's behalf. There is deliberately **no** backlog announcement on
  `onDidChangeWindowState`: a toast about a run that parked an hour ago is noise, and the
  badge already covers that case. `showInformationMessage` is in-app only, so a toast in an
  unfocused window was never going to be read anyway.
- **Coalesce per tick.** Three runs parking in one pass is one toast, not three:
  *"3 sessions are waiting on you"*. A single run names itself: *"BITE-42 is waiting on
  you"*.
- **Inert when off.** With `agentFlow.notifyOnActionRequired` false, the latch file is never
  read and never written — nothing appears on disk for a user who did not opt in.

One action button, **Open Deck**, wired to the existing `agentFlow.openDeck` command.
`test/unit/compat.test.ts` asserts **set equality** on manifest command ids, so adding a
command would fail CI; settings are only checked as a superset, so the new setting is free.

### 5. Wiring — `src/extension.ts`

E1 as written asks for a new host-side tick. It does not need one: `extension.ts` already
runs `setInterval(() => provider.postNotepad(), 6000)`, which outlives every panel, and whose
comment already reasons about badge staleness. This becomes a **second job on that timer**,
which is meaningfully less new machinery than the requirement assumes.

The attention job runs on **every other tick (12s)**. Transcript reads are the new recurring
cost and no human needs sub-10-second latency on a badge.

### 6. One writer, and what the open panel contributes — `src/deckView.ts`

`buildAll` already computes every `AttentionCandidate` field. It is refactored to build the
candidate array and call `attentionKeys` / `ownsWorkToLose` instead of deriving Action
required inline — that refactor *is* the "share the reduction rather than fork it"
requirement, and parity becomes true by construction rather than by inspection.

The tick stays the **sole writer** of the badge, to avoid a 6s panel and a 12s tick
flip-flopping the number. When the panel is open it publishes its freshly built candidate
array to a small holder that `extension.ts` owns and passes into `DeckPanel.show`; the tick
prefers those candidates when they are younger than `2 × POLL_MS` and otherwise gathers its
own. So while the Deck is open the tick spends no I/O at all, and the badge can never
disagree with the column next to it.

## Rejected approaches

**A headless Deck reducer.** Instantiate a panel-less `DeckPanel` in `extension.ts` and read
its board. Rejected: `DeckPanel` carries a webview, a `Forge`, a review cache and a usage
reader, and its `refresh()` does forge work — putting all of that on the hidden path is the
exact thing E1 forbids.

**The Deck writes the count to disk; the tick reads it.** Tempting — a trivial tick and
perfect parity. Rejected because the number is only ever as fresh as the last time the Deck
was *open*, which is the precise condition E1 exists to fix. It would badge stale counts and
never notice a run parking. Recorded here so nobody re-proposes it.

## Accepted trade-offs

- **`prMerged` comes from the on-disk cache.** A run merged since the Deck last ran will badge
  as Action required until something refreshes that cache. This is a *stale-cache* wrong
  answer, not a fabricated one, and the only alternative is a forge call on the hidden path.
  Document it; do not fix it.
- **A never-opened sidebar gets no badge**, per the resolution limitation in §3.
- **A run that parks while no window is focused never toasts.** The badge is its signal. This
  is the direct consequence of the focused-window decision and is the right trade: a toast
  nobody sees is an announcement spent on nobody.

## Testing

- **`attention.ts`** — table test over the precedence corners: each of `needs-you`,
  `stalled`, `exited` counts; `prMerged` suppresses; shelf `closed` suppresses;
  `justLaunched` keeps; `showAll` bypasses shelving. Plus the `fs`-free import assertion that
  `bucket.test.ts` and `visibility.test.ts` already carry.
- **The parity test is the one that matters.** Over one fixture candidate set, assert
  `attentionKeys(c)` equals the candidates whose `deriveBucket` result is `needs` after
  shelving. This is what makes "share the reduction" enforced rather than aspirational: a
  future edit to `deriveBucket`'s precedence that forgets `attention.ts` fails here.
- **The cost invariant needs its own test, or it rots.** Inject a spy `gitState` into
  `gatherAttention` and assert **zero calls** when no run is in a needs state, and no
  `readPrEntries` for a run outside the needs set. Without this, someone hoists `gitState`
  out of the candidate branch in six months and the hidden path quietly starts spending four
  git calls per run per tick.
- **`nextAnnouncements`** — enter, stay (no re-announce), leave (clears), re-enter
  (announces again), prune of a key no longer in any run record.
- **`tasksView.setAttention`** — zero clears the badge to `undefined`; a value set before
  `resolveWebviewView` is applied on resolve; tooltip says "sessions".
- **Mock extension.** `test/_mocks/vscode.ts` has `onDidChangeWindowState` but no
  `window.state`, and no `WebviewView.badge`. Both need adding — the mock is hand-written
  infrastructure, not part of the frozen released surface.
- Coverage thresholds in `vitest.config.ts` (90% lines/statements, 85% branches/functions)
  apply. The full CI gate is `npm ci`, `npm run typecheck`, `npm test`, `npm run build`; all
  four must pass, and `npm test` needs `timeout: 600000` when run through a tool.
- `test/unit/compat.test.ts` must pass **unmodified**.

## Out of scope

- OS-level notifications. `showInformationMessage` is in-app; anything else is a different
  feature.
- Any change to what `deriveBucket` decides. This work reads the existing precedence chain;
  it does not renegotiate it.
- Badging anything other than Action required.

## Files touched

| File | Change |
| --- | --- |
| `src/engine/attention.ts` | new — pure reduction (`attentionKeys`, `ownsWorkToLose`, `nextAnnouncements`) |
| `src/engine/attentionFs.ts` | new — `gatherAttention` over injected cheap readers |
| `src/extension.ts` | attention job on the existing 6s timer at 12s cadence; candidate holder passed to `DeckPanel.show` |
| `src/tasksView.ts` | `setAttention`, badge held across an unresolved view |
| `src/deckView.ts` | `buildAll` refactored onto the shared reduction; publishes candidates to the holder |
| `src/config.ts` | `notifyOnActionRequired` |
| `package.json` | `agentFlow.notifyOnActionRequired` property |
| `test/_mocks/vscode.ts` | `window.state.focused`, `WebviewView.badge` |
| `CHANGELOG.md` | entry under `## [Unreleased]` |
| `README.md` | the new setting in the settings table |
