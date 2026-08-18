# Deck: the card's visual pass, led by a kind avatar

**Date:** 2026-08-18
**Status:** Design approved, not implemented
**Related:** `2026-08-16-deck-two-tier-card-design.md` (D2, the card's four rows), `2026-08-17-deck-card-anatomy-design.md` (D3, spend and per-failure rows)

## Problem

D2 decided the card's rows and D3 decided what they say. Neither decided how the card *reads*, and the top row now carries three labels competing for one line: the state text on the left, the ticket key on the right, and — on the Agents board — the session name wrapping beneath them. The card's own identity arrives as prose or not at all: which agent a card is, and which *kind* of thing it is, can only be inferred from the key's shape (`DEMO-142`, `explore`, `note`, `~/scanner`) or from reading the summary.

A Deck card is not one kind of object. It can be a tracked ticket, a Notepad note, an Explore place, a PR review, or an untracked local place discovered from an open session. That distinction changes what the card's actions mean, and today it is carried by a text key that ellipsizes at 46% of the row.

## Goal

Give the card a leading avatar that says what it is, make the title the typographic anchor, and give the state its own row at the foot with the run's spend and age beside it. Nothing is added to the card that the webview does not already hold, and nothing observable is removed.

## Scope

In scope: the Deck card's markup and CSS, the same avatar in the detail drawer's header, and the card-kind glyphs in `src/webview/icons.tsx`.

Out of scope, deliberately:

- **A provider brand mark on the card.** See **Why no provider mark** below — this is the one place this design departs from its brief, and the reason is a data reason.
- Any new host message or any new field on `RunStatus`. Every value the new layout renders is already on the wire.
- The focus ring. That is D6; this design's `:focus-within` behaviour is the one already in `DECK_CSS`.
- A status-tinted card border per state. The `.card.attn` treatment stays the one case that has earned colour.
- The Tasks list, the review strip, the closed strip, the Orchestrator drawer.

## Why no provider mark

The brief asks the avatar to lead with a provider brand mark — Claude Code or Copilot, with a lettered-tile fallback. There is no per-card provider datum to render:

- `agentProvider` is a **workspace setting** (`src/config.ts`), read per window. It is identical for every card on a board.
- The Deck's agent read is Claude Code's own registry: `OpenSession` is `~/.claude/sessions/<pid>.json`, and the transcript reducer reads `~/.claude/projects`. A Copilot session is not observable there. So a card that has an agent at all is, today, a Claude Code card by construction.
- `Run` records nothing about the provider that launched them, and back-filling one would say nothing about the session running now.

A mockup of the composite avatar (`preview/_d8-g.png`) confirms the cost: a 9px pip, identical on every card that has an agent, in both themes. The inverse arrangement (`_d8-d.png`) is worse — every tile becomes the same asterisk and the card kind, the one real signal, drops to an unreadable pip.

So the avatar carries the card's **kind**, which is per-card, derivable, and currently unstated. Provider marks are not added to `icons.tsx` in this task: with nothing on the card to render them, they would be dead code. When a Copilot session becomes observable to the Deck — a per-card fact rather than a workspace constant — the avatar has a pip slot waiting and the mockup for it on record.

## Design

### The card at rest

Five regions, in this order:

1. `c-hd` — **new**. The avatar, the title, and the key on one flex row.
2. `c-sig` — the aggregate signal line, unchanged in content, restyled to a mono micro row. Still replaced by `c-rows` when the card has failures.
3. `c-hr` — **new**. One hairline. The card's only rule.
4. `c-st` — **new**. The tone dot and state text on the left; spend and age on the right, in mono.
5. `c-foot2` — Open and Diff. Unchanged.

```
┌─────────────────────────────────────────────┐
│ [av]  Export times out on large   DEMO-142  │  c-hd
│       workspaces                            │
│       ⎇ fix/export-pag…  +142 −23           │  c-sig
│  ─────────────────────────────────────────  │  c-hr
│  ● working · 24s          380k eq · 2h       │  c-st
│  Open   Diff                                │  c-foot2
└─────────────────────────────────────────────┘
```

### The avatar

A 22px tile at the card's leading edge, on the x the tone dot used to occupy, so a column still scans as one strip from a single left edge. A 1px hairline border and a 5%-foreground ground; a 14px glyph in `currentColor`.

Five kinds, from `runKind(run)`:

| Kind | Glyph | Hue |
|---|---|---|
| `task` | tag | `--c-review` mixed 78% into the foreground |
| `notepad` | lined page | `--vscode-charts-yellow` at 78% |
| `explore` | magnifier | `--vscode-charts-purple` at 78% |
| `review` | PR fork (two nodes joining a third) | `--c-done` at 78% |
| `local` | map pin | `--dim` |

The **glyph** takes the hue; the tile ground and border stay neutral. A column of cards must not become a column of colours — the board's colour vocabulary already belongs to the columns and to `attn`, and a kind is not a status.

Glyphs are inline SVG in `src/webview/icons.tsx`, following `TypeIcon`: no image assets, no `asWebviewUri` plumbing, no widened CSP, and `currentColor` throughout.

Each avatar carries `role="img"` with an `aria-label` and a `title` naming the kind in words ("Notepad note", "Explore place", "Untracked local place"), because the glyph is the only thing that says it.

### The header

`c-hd` is `display: flex; align-items: flex-start`, three children: the avatar (`flex: none`), a growing text block (`min-width: 0`), and the key (`flex: none`).

The title becomes the anchor: `--t-title`, weight 550, clamped to **two** lines rather than three. Two lines plus a two-line title is the tallest header this card can produce, and the card's height floor already absorbs it.

The key is `flex: none` with `max-width: none` inside its own wrapper. This matters: the mockup that let the key share a row with the branch and the diff (`preview/_d8-c.png`) truncated it to `DEMO…`, and a ticket key is the one string on the card that cannot be reconstructed from anything else. The title wraps instead — it is already built to.

`.chip` markers (`local`, `~inferred`) and the `key-wrap` arrangement keep their current behaviour inside the header's key slot.

### The signal row

`cardSignal` is untouched: same bits, same order, same cap of three, same `·` separators, same substitution by `c-rows` when `cardActions` is non-empty. Only its typography changes — `--t-data` in `--mono`, sitting directly under the title as a caption rather than as a third band of body text.

This is deliberate: re-homing the row must not change what the card *says*. A card whose PR is healthy still reads `#2044 · ✓ ci · approved`, and still says nothing about its branch, exactly as it does today.

### The state row

`c-hr` above it is a 1px `8%`-foreground rule with 9px above and 7px below. It is the card's only rule, so it means one thing: identity and facts above, live state below.

`c-st` holds:

- Left: the existing `.sdot` (with `.pulse` on `working`) and the existing `.status` span, class names unchanged, carrying `stateView`'s text and tone. `tone-attn` keeps its weight-600 treatment.
- Right: `.c-meta`, mono and `tabular-nums`, holding the spend figure and the age, joined by a dimmed `·`.

**Spend.** `formatEq(weightedEq(r.usage))` with the `eq` unit in the body face at 70% opacity — the same treatment the header total and the drawer already use. Absent `usage` renders **no figure at all**; a run not yet measured must never read as one that cost nothing. Zero renders `0eq` because zero is a measurement.

This is narrower than the brief's "usage + age right-aligned in mono", and deliberately so. `a66c543` (17 Aug) removed the card's own spend figure — "a per-card number the reader cannot act on competed with the state line and the failure rows, which they can" — and made the read lazy: `RunStatus.usage` is now populated only when `agentFlow.deck.showTokenTotal` is on, which is **off by default**, and the gate is on the transcript sweep itself, not just on the display. Re-adding an unconditional card figure would reverse both halves of that decision and make every user pay a 60s sweep again.

So the age is unconditional and the spend figure is not: a default install's state row reads `working · 24s` on the left and `2h` on the right, exactly as much information as the card carries today. A user who has turned the board total on has already opted into the board-wide read, and their cards then show `380k eq · 2h`. No new setting, no new sweep, and `absent ≠ zero` still holds.

**Age.** `timeAgo(r.run.createdAt)` — how long ago this run was launched. Its `title` says so in words ("launched 2h ago"), because the state text beside it also ends in a duration (`working · 24s`, the last activity) and the two must not be read as the same clock.

On the Agents board the card's state comes from the agent, as it does today; the avatar and the age still come from the run, which is the object the card belongs to.

### The drawer header

`DeckDetail`'s header takes the same avatar, at the same size, before its title. A selected card and its drawer then open with the same mark, so they read as one object rather than two views.

### Class-name contract

The DOM moves; the class contract does not. `.status`, `.c-sig`, `.key`, `.key-wrap`, `.chip`, `.c-rows`, `.c-row`, `.c-foot2`, `.sdot`, `.c-diff` all keep their names in their new homes, so the existing webview suite passes **unmodified**. New names: `.av` (+ `.av.k-<kind>`), `.c-hd`, `.hd-t`, `.hd-k`, `.c-hr`, `.c-st`, `.c-meta`. One rename: `.c-top` → `.c-hd`, which no test references.

`.c-branch` and `.elapsed` remain in `DECK_CSS` for the drawer, which still uses them.

## Testing

- One test per kind: the card renders the avatar with that kind's class and its accessible name.
- The header: a long title and a long key both render, and the key's text is intact (not ellipsized in the DOM — the assertion is on text content, since jsdom cannot measure).
- The state row: dot tone, state text, and `.c-meta` containing both figures; a run with `usage` absent renders `.c-meta` with the age and **no** `eq`; a run with all-zero usage renders `0eq`.
- The drawer: the selected run's avatar appears in the header with the same kind class.
- Unchanged behaviour, asserted by the existing suite passing untouched: signal bits, failure rows, footer actions, the `attn` treatment, drag, selection.
- Light and dark screenshots of the finished board, for the record.

## Risks

- **Height.** A two-line title plus the hairline and the state row is a taller header than today's. Mitigated by the clamp dropping to two lines and by the card's existing height floor; the mockups (`_d8-f.png`) show uniform heights across a four-column board.
- **Two durations side by side.** `working · 24s` and `2h` are different clocks on one row. Mitigated by the age's `title` and by mono/proportional contrast, and it is the arrangement the brief asks for.
- **Kind hues on a light theme.** Checked in `_d8-g-light.png`: the chart hues mixed 78% into the foreground hold at 14px on white.
