# Ticket type indicator on task cards

**Date:** 2026-08-12
**Status:** Design approved, not implemented

## Problem

A task card in the sidebar shows the key, priority, status, summary and assignee — but never what kind of ticket it is. A bug, an epic and a sub-task are visually identical, so the user has to open the ticket in Jira to learn something the list already knows.

## Goal

Show the ticket type on every task card in the Tasks list, readable at a glance, without adding a second competing signal to a row that already carries a status pill and a "Highest" chip.

## Scope

In scope: the collapsed task cards in the Tasks view.

Out of scope, deliberately:

- Deck run cards. A run is a stored record (key, summary, url); carrying type there means writing it at take-time or re-fetching, and the value is lower — by then the user has already read the ticket.
- The expanded card detail body.
- Filtering or sorting by type.
- Jira's own issue-type icon URLs. They are remote images (a fetch per card, and the webview's CSP would have to be widened) for no gain over local glyphs.

## Design

### Data path

`Task` in `src/types.ts` gains one field:

```ts
type?: string; // the source's own type name, e.g. "Story", "Sub-task", "Spike"
```

Optional, and it holds the **raw** name rather than a normalized enum. Two reasons: nothing that constructs a `Task` today has to change, and the raw name is what the tooltip must show — a project that renamed "Story" to "Feature" should say "Feature".

In `src/tasks/jira/client.ts`:

- `LIST_FIELDS` gains `"issuetype"`. `DETAIL_FIELDS` is untouched — the detail body does not render this.
- The list row mapper sets `type: f.issuetype?.name ?? ""`.

No change to `TaskProvider`, the wire protocol, or `SerializedCaps` — the field rides along on `Task`, which already crosses to the webview.

### Kind mapping

A pure function in `src/webview/helpers.ts`:

```ts
export type TicketKind = "story" | "epic" | "task" | "subtask" | "bug" | "other";
export function ticketKind(typeName: string): TicketKind;
```

Lowercases and trims, then matches exactly: `story`, `epic`, `task`, `bug`, and `sub-task` / `subtask` (both spellings; Jira Cloud and Server disagree). Everything else — including an empty string — is `"other"`.

Unknown types are never dropped. `"Spike"` renders the neutral `other` glyph with the tooltip `Type: Spike`, so a project using custom type names still gets a marker on every card instead of a feature that looks broken. An empty `type` renders the `other` glyph too, with the tooltip `Type: unknown`.

Deliberately *not* folding unknown types onto the nearest known one via Jira's `subtask` flag or hierarchy level: it would mislabel genuinely different types, and the tooltip already tells the truth.

### Tokens

A new block in `src/webview/tokens.ts`, beside the existing Marketplace `--k-*` group and for the same stated reason — this is a "what KIND of thing is this" axis, not a "where is it in the flow" axis, so it must not reuse the `--c-*` status hues:

```
--k-story:   var(--vscode-charts-green, #4ac26b);
--k-epic:    var(--vscode-charts-purple, #b083f0);
--k-task:    var(--vscode-charts-blue, #4aa3df);
--k-subtask: var(--vscode-charts-blue, #4aa3df);
--k-bug:     color-mix(in srgb, var(--c-danger) 72%, var(--vscode-foreground));
--k-other:   var(--dim);
```

`--k-bug` is a muted red, not `--c-danger` itself: red on a card means a real failure, and an ordinary healthy bug ticket is not one. It is also not `--c-attn` — amber on a card means exactly one thing, the Highest chip. Task and sub-task share blue, as they do in Jira; their glyphs differ.

`test/webview/tokens.test.ts` already enforces that surface sheets use but never redeclare tokens, so these get that check for free.

### Render

In `src/webview/App.tsx`, inside `card-top`, immediately after the chevron and before the `.key` link:

```tsx
<TypeIcon kind={ticketKind(task.type ?? "")} label={task.type || "unknown"} />
```

which renders a 12px inline SVG:

```tsx
<span className={`ty ty-${kind}`} role="img" aria-label={`Type: ${label}`} title={`Type: ${label}`}>
```

`role="img"` plus `aria-label` because the glyph is the only carrier of this fact — an icon-only marker with no accessible name would be invisible to a screen reader.

`TypeIcon` and its glyphs live in `src/webview/icons.tsx`, each glyph a 12×12 viewBox using `currentColor`:

- **story** — filled bookmark
- **epic** — filled lightning bolt
- **task** — filled rounded square with a knocked-out check
- **subtask** — an elbow stroke into a small filled square
- **bug** — filled circle with a knocked-out centre dot
- **other** — hairline rounded square outline

The two knocked-out glyphs cut with the card background colour so they read at 12px without a second fill colour.

One rule in `src/webview/styles.ts`:

```
.ty { width: 12px; height: 12px; flex: none; display: inline-block; }
.ty svg { display: block; }
.ty-story { color: var(--k-story); }   /* …one per kind… */
```

`flex: none` matters — `.card-top` is a wrapping flex row and the marker must never be squeezed.

### Rejected alternatives

- **Monochrome glyph.** Quietest, and adds no hue to the row, but leaves shape alone to teach five types.
- **Text chip after the key** (`STORY`, `SUB-TASK`). Unambiguous, but a third chip on a row that already carries Highest and status, and "SUB-TASK" is wide in a narrow sidebar.
- **Glyph plus word.** Reads as metadata rather than a badge, but is the widest option and wraps the row soonest.

Hued glyph won because the card list is scanned, not read, and colour is what makes a scan work. The `--k-*` precedent already in the codebase means it costs no new convention.

## Testing

- `test/webview/helpers.test.ts` — `ticketKind` for each of the five known names, mixed casing, surrounding whitespace, both sub-task spellings, an unknown name, and the empty string.
- A client test asserting `issuetype` is among the requested list fields and that a search response's `issuetype.name` lands on `Task.type`, including the missing-`issuetype` case mapping to `""`.
- `test/webview/App.test.tsx` — a card for each kind exposes the accessible name `Type: <raw name>`; a task whose `type` is absent still renders a marker, named `Type: unknown`.

## Gates

The implementation plan must restate these; they are the repo's CI gates and a subagent follows the brief, not CONTRIBUTING:

- `npm run typecheck`
- `npm test`
- `npm run build` — the only check that catches a webview module reaching `fs`/`path`; `tsc` and the test suite both pass regardless.
- Existing tests pass unmodified.
