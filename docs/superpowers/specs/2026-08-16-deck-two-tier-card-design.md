# Deck: two-tier card — thin summary plus a detail drawer

**Date:** 2026-08-16
**Status:** Design approved, not implemented

## Problem

The Deck card is dense because the board IS the detail view. One card can carry a status line, the key, the title, a branch + launched row, per-repo diff chips, a four-line PR block per repo, an agents fold, a Jira status pill, three buttons and an overflow menu. Card heights run from 120px to 330px, so a column reads as a stack of unrelated blocks rather than a list. There is nowhere else for the detail to go.

## Goal

Give the Deck a second tier. The card at rest says who needs you and what it is; a drawer says everything else. Nothing is removed — only relocated.

The board should read calm. Uniform card heights matter more than fitting more cards on screen: measured on an 11-run board, this design shows the same number of full cards in the In progress column as today. The win is regularity, not density, and the design is not justified on a density claim.

## Scope

In scope: the Deck panel's card and a new selected-card detail drawer.

Out of scope, deliberately:

- Keyboard selection and Enter. That is D6; this task provides the surface it targets.
- Any new host message. Every action in the drawer is reachable through the protocol that exists today (see **Actions**).
- The Tasks list, the review strip, the closed strip, the Orchestrator's own contents.

## Design

### The card at rest

Four rows, always, in this order:

1. `c-top` — tone dot + state text (left), ticket key (right). Unchanged from today.
2. `c-title` — the summary. Unchanged.
3. `c-sig` — **new**: one aggregate signal line (below).
4. `c-foot2` — **new**: Open, Diff, and conditionally Address PR.

Everything else on today's card moves to the drawer: the branch/launched row, repo chips, the workspace fold, every PR block, the agents fold, the status pill, and the overflow menu.

#### The signal line

One line, never two. It carries at most **three** bits, worst fact first, joined by a dimmed `·`.

With a PR, in this order:

1. `#<number>` (mono)
2. the CI verdict — `✗ <first failing check>` | `<n> running` | `merged` | `✓ ci`
3. the worst thing between it and a merge — `conflicts` | `changes` | `approved` | the review word

Diff totals never appear on a card that has a PR. How big the change is loses to what is wrong with it.

Without a PR:

1. `⎇ <branch>` (mono)
2. `+<added> −<removed>` summed across repos
3. `<n> repos`, or `<n> agents` when there is only one repo

The three-bit cap is not sufficient on its own — a long branch name still pushes the third bit onto a second row. So `.c-sig` is `flex-wrap: nowrap; overflow: hidden`, every bit is `flex: none`, and the one elastic bit (the mono branch) takes `min-width: 0` and an ellipsis. This was verified in the mockup: `fix/export-pagination` truncates to `fix/export-paginat…` rather than wrapping.

#### The footer

- **Open** — primary, `deck:inspect { action: "open" }`. Keeps the `.live` marker when the window is already running.
- **Diff** — `deck:inspect { action: "diff" }`.
- **Address PR** — shown when the card is in the `review` column's `waiting` lane.

**This changes an existing rule.** Today `canAddressPr` is `!local && isPrReviewStatus(r.ticketStatus, prReviewStatus)` ([DeckApp.tsx:316](../../../src/webview/DeckApp.tsx#L316)) — a ticket-status test that can fire in any column. The new rule is lane-driven, so the button stops appearing on `needs` cards that today qualify by status. Both the `local` guard and the lane test are required: a `local` card's key is inferred from its branch, so its status may belong to somebody else's ticket.

#### The floor

`.card` is a plain block today, so a `min-height` alone would hang dead space under the last row. The two-tier card is therefore `display: flex; flex-direction: column`, and `.c-foot2` takes `margin-top: auto` so the footer seats on the bottom edge. A card that is taller than its content then reads as deliberately that tall.

Approved density (mockup H2):

| | |
|---|---|
| card floor | `min-height: 152px` |
| card padding | `13px 14px` |
| row gap inside the card | `9px` |
| gap between cards | `14px` (`.col-body`) |
| title line-height | `1.45` |

Two tighter and one looser candidate were rendered and rejected: 132px still crowds a two-line title, 176px leaves a hollow middle on the one-line cards that dominate a real board.

### The drawer

Geometry mirrors the Orchestrator drawer exactly — `position: fixed; top: 53px; right: 0; bottom: 0`, no scrim, board stays live — at **460px**, which is the narrowest width at which the PR block reads without wrapping.

**The drawer and the Orchestrator drawer are mutually exclusive.** Opening one closes the other. They share the slot and the geometry, and two overlapping fixed panels have no honest z-order.

At 1340px there is no arrangement in which four 318px columns and a 460px drawer all fit; something is always off-screen. `.board` is already a horizontal scroller, so it takes `padding-right` equal to the drawer width while the drawer is open. That does not move the columns — it adds scroll run-out so a covered column can be scrolled clear. Nothing becomes unreachable.

Contents, top to bottom:

- **Header** — tone dot, key (mono), title, close button.
- **Work** — the `c-branch` row (branch + launched) and the repo chips, or the `WorkspaceChip` fold for a multi-root run. Moved verbatim.
- **Pull requests** — one `PrBlock` per repo with a PR, `showRepo` when there is more than one. Moved verbatim, including the CI check links.
- **Agents** — the `AgentsRow` rows, expanded rather than folded. There is room; the fold existed because the card had none.
- **Actions** — see below.

### Actions

Grouped, and the drawer prints its own count so the header stays honest as conditions add or drop rows. Ten on a single-repo card in the waiting-on-review lane; nine on a PR card that offers no Address PR; more as repos and failing checks multiply.

(The `_d2-g.png` mockup reads "11 ACTIONS" because it was shot while Address PR was still ticket-status-driven and so appeared on an Action required card. The rule changed after that shot; the layout did not.)

| Group | Action | Message |
|---|---|---|
| This task | Open workspace | `deck:inspect { action: "open" }` |
| | Diff — all repos | `deck:inspect { action: "diff" }` |
| | Diff — `<repo>` (one per repo, multi-repo only) | `deck:inspect { action: "diff", repo }` |
| | Address PR (same condition as the footer) | `deck:addressPr` |
| | Open in `<source>` (tracked only) | `openExternal` |
| Pull request | Open PR #`<n>` | `openExternal` |
| | Open failing check — `<name>` (one per failing check) | `openExternal` |
| Copy | Copy branch name | webview-local |
| | Copy ticket key (tracked only) | webview-local |
| | Copy PR url (with a PR) | webview-local |
| | Copy worktree path | webview-local |
| Record | Forget, or Track it on a local card | `deck:forget` / `deck:track` |

**No new host message.** Per-repo Diff uses `deck:inspect`'s existing `repo` parameter; the copies use the webview's own clipboard. Three actions were considered and cut for being real host work beyond this task's scope: Reveal worktree in Finder, Open a terminal here, Focus an agent session.

### Selection

`DeckApp` holds `selectedId: string | null` — the `DeckCard.id`, not the run key, since the Agents lens renders one card per session and two cards can share a run.

- Clicking a card selects it. Clicking the footer's buttons does not (the handlers stop propagation).
- Selecting re-targets the open drawer rather than toggling it.
- Escape, the close button, and clicking the selected card again all clear it.
- A selection whose id is gone from the next `deck:runs` post clears itself; the drawer must never render against a card that no longer exists.
- Nothing selected → the drawer is not in the DOM and the board is full height.
- `.card.sel` takes the focus-border color and a 7% wash of it, and the accent rail goes to full strength.

## Testing

`test/webview/DeckApp.test.tsx` holds 177 tests, and a large number assert card internals this design relocates — `.c-repos`, `.c-branch .bn`, `.pr-block`, `.c-agents`, `.actions .act` labels, the overflow menu.

The usual house rule that the existing suite passes unmodified **cannot hold here**; the card's DOM changes by design. The rule that replaces it:

> A test asserting a fact that is still true must keep asserting it, re-pointed at the drawer. Only a test whose subject genuinely no longer exists may be deleted, and each such deletion is called out in the PR body.

Nothing on today's card is removed by this design, so **very few deletions should be justifiable**. A test that relocated its selector and still passes is the evidence that the detail was moved rather than dropped.

New tests to add:

- The signal line renders exactly three bits, and picks the worst fact when more are available.
- The signal line does not wrap (asserted through the `nowrap`/`min-width: 0` rules, not a measured width — jsdom has no layout).
- Address PR appears on the `review`/`waiting` lane and nowhere else, and never on a `local` card.
- Clicking a card selects; clicking Open does not; Escape clears.
- Selecting a second card re-targets the drawer instead of closing it.
- A selection cleared by a `deck:runs` post that no longer contains it.
- Opening the card drawer closes the Orchestrator drawer, and the reverse.
- Every action in the drawer posts the message the table above names, with the `repo` parameter set on per-repo Diff.

## Risks

- **Blast radius on the test file.** The largest cost in this task is re-pointing existing assertions, not writing the feature. Budget for it.
- **The Agents lens.** A card there is one session; the drawer's Agents section is then that one agent, and its Work section must read the agent's own repo rather than `repos[0]` — the same trap the card's branch row already documents at [DeckApp.tsx:384](../../../src/webview/DeckApp.tsx#L384).
- **`webview` cannot reach `fs`.** Copy worktree path uses the path already on `RepoGit`; it must not reach for `path` or `os`. Only `npm run build` catches a violation — `tsc` and the full suite pass regardless.
- **The drawer is not resizable in this task.** The Orchestrator drawer has a resize grip; this one ships at a fixed 460px. If it proves wrong for someone, the grip is a follow-up, not a reason to hold this.

## Mockups

Rendered against the real `DECK_CSS` and `TOKENS_CSS` with an 11-run board, in the gitignored `preview/`:

- `preview/d2-options.html` — every candidate, switched by `?v=`; `&theme=light`, `&sel=none` for the at-rest board.
- `_d2-before.png` — today's board, shot from the real bundle.
- `_d2-a/b/c/d.png` — drawer, bottom dock, inline, and dock-plus-per-card-button.
- `_d2-h1/h2/h3-rest.png` — the three densities. **H2 is the approved one.**
