# In-flight header redesign

Date: 2026-08-09
Status: approved, ready for planning

## The problem

The Deck's In-flight header is a single non-wrapping flex row holding, in order: the
title block, five stat tiles, a spacer, four toggle switches, a two-way lens, a
conditional "Clear stale" button, and refresh. Twelve-plus controls. `.hd` sets
`display: flex` with no `flex-wrap`, so below roughly 1200px the right end is not
folded — it is clipped off the panel entirely.

Two further defects surfaced while scoping this:

**The toggles are visibly flaky.** Clicking one flips it immediately, then it snaps
back to its old value for a second or two, then finally settles on the new value.
Control state is owned by the extension host and echoed to the webview only on
`deck:runs`, which is posted at the end of a full board rebuild (git per repo plus a
connector round trip per run — seconds). A rebuild already in flight when the click
lands posts a pre-click snapshot, re-asserting the old value; the rebuild the click
itself triggers arrives seconds later with the new one.

**"Open agents" off does more than it says.** Its setting description promises that
off means "only the tasks Agent Flow Deck launched". In fact `buildAll` empties the
`places` map when it is off, so tracked runs lose their agent chips too — the board
goes blind to who is running anywhere, not just in unknown directories. Out of scope
for this change; recorded here so it is not lost.

## What the header becomes

One row, in this order:

- The title block ("In-flight" over "everything you've launched"), unchanged.
- Three stat tiles: **In progress**, **Action required**, **In review** — the three
  board columns and nothing else.
- The flexible spacer.
- The **Agents / Workspaces** lens, right-aligned.
- `Clear stale (n)`, still conditional on `staleCount > 0`.
- The refresh / "synced Ns ago" control.

`.hd` gains `flex-wrap: wrap; row-gap: 10px`. The row must never clip again,
whatever a future change puts in it or however wide the user's font is. Rendered
candidates and the wrap behaviour down to 480px are in `preview/deck-header-redesign.html`.

### Counts

"To review" and "Total" tiles are removed.

- **To review** is already carried by the review strip immediately below the header,
  which renders its own count. Two numbers for one fact, six vertical pixels apart.
- **Total** is the sum of the three tiles beside it, over a board that is showing
  every card it counts. Nobody acts on it.

The `reviewsSeen` state exists solely to decide whether to render the "To review"
tile, and goes with it.

## What is removed

### Live signal — entirely

The button, the `deck:setLive` inbound message, and the `DeckViewProvider.liveSignal`
field. `readSessionActivity` is called unconditionally at both call sites in
`buildAll`.

This breaks nobody: `liveSignal` has no backing setting. It is a field initialised to
`true` in the constructor, so it already resets to on every time the panel opens. No
user can be running with it persistently off.

Graceful degradation survives. `stateView`'s "parked · git + <source> only" branch is
`!live || r.agent.state === "unknown"`; with `live` gone the second half remains, and
an unreadable or missing transcript is exactly what returns `UNKNOWN_ACTIVITY` from
`readSessionActivity`. The `live` prop on `Card` and the `live` parameter on
`stateView` are dropped along with the state.

The doc comment on `RunStatus.agent` in `src/types.ts` that explains `UNKNOWN_ACTIVITY`
as "when the Live signal is off" is rewritten to describe the remaining cause: an
unreadable transcript.

### PR facts, Open agents, Review queue — buttons only

The three buttons, their `deck:setPrFacts` / `deck:setOpenAgents` / `deck:setReviewQueue`
messages, and the three React states that back them. The host-side fields and all
behaviour they gate stay exactly as they are.

`agentFlow.prFacts`, `agentFlow.openAgents` and `agentFlow.reviewRequests` are
untouched — same keys, same descriptions, same `true` defaults. Anyone who has
deliberately set one to `false` sees no change.

### Dead CSS

`.switch` and `.ctl.on .switch` have no remaining users; both are deleted. The comment
block above them explaining why a switch track is allowed to spend `--brand` is
rewritten: `.act.primary` becomes the only brand-filled surface in the deck.

`.ctls`, `.ctls .ctl`, the `+ .ctl` divider and `.ctls.seg` all stay — the lens still
uses them.

## Settings must apply without a reload

The three buttons were the only in-session way to change those settings.
`DeckViewProvider` reads them once in its constructor, and the extension registers no
`onDidChangeConfiguration` listener anywhere outside telemetry. Removing the buttons
without adding one would mean a setting change does nothing until the panel is closed
and reopened.

The provider registers a configuration listener, disposed with the rest of the view's
subscriptions. When `agentFlow.prFacts`, `agentFlow.openAgents` or
`agentFlow.reviewRequests` changes:

- re-seed the corresponding field from `getConfig()`;
- if `prFacts` just turned on, clear `ghGap` and `ghProbe` so `gh` is re-probed — the
  same reset the `deck:setPrFacts` handler does today, for the same reason (the user
  may have run `gh auth login` since);
- if `reviewRequests` changed, post the cached reviews before refreshing, so switching
  off clears the strip immediately rather than after a full rebuild — again matching
  what the removed handler did;
- refresh.

Unrelated configuration changes must not trigger a rebuild.

## Fixing the flake

The cause is that control state travels on `deck:runs`, a message whose latency is a
full board rebuild. The fix is to stop putting control state on it.

`deck:runs` drops `liveSignal`, `prFacts`, `openAgents`, `reviewQueue` and `grouping`
from its payload. The first four have no webview consumer left. `grouping` moves to a
new outbound `deck:grouping` message posted once, in the `deck:ready` handler, before
the first rebuild — the same place `postCachedReviews()` already posts early for the
same reason.

After that seed the webview owns the lens. A click sets local state and sends
`deck:setGrouping`; nothing echoes back, so nothing can overtake it.

The host handler for `deck:setGrouping` persists the preference and **stops calling
`refreshBusy()`**. `deckGrouping` is display-only — `deckView.ts` reads it in exactly
one place, to put it on the wire — and the webview derives both lenses from the same
run list it already holds. Today, switching lens spends git per repo and a connector
round trip per run to produce a board the webview could have drawn instantly. The
lens becomes immediate.

## Testing

Repo gates, all of which must pass ([CONTRIBUTING.md](../../../CONTRIBUTING.md)):

| Command | Why it matters here |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` clean. |
| `npm test` | The existing suite must pass **unmodified**. |
| `npm run test:cov` | Coverage thresholds are enforced. |
| `npm run build` | The only gate that catches a webview module reaching for `fs`/`os`/`path`; typecheck and the suite both pass regardless. |

New coverage:

- `deck:runs` carries no control-state fields.
- `deck:ready` posts `deck:grouping` before the board rebuild.
- `deck:setGrouping` persists the preference and triggers no rebuild.
- A change to each of the three settings re-seeds its field and refreshes; a change to
  an unrelated key does not.
- Turning `prFacts` on via settings clears `ghGap`/`ghProbe`.
- Turning `reviewRequests` off via settings posts cleared reviews before the refresh.
- Activity is read from transcripts unconditionally, and a card whose transcript is
  unreadable still reads "parked · git + <source> only".
- The header renders three tiles, and "Action required" carries the attention accent
  only when its count is above zero.

## Out of scope

- The "Open agents off blinds tracked runs" coupling. Real, worth a separate change.
- Any change to the review strip, the cards, or the board columns.
- Any change to the settings themselves — keys, descriptions and defaults are frozen
  by this spec.
