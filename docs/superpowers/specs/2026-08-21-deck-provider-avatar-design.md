# Deck card provider avatar, and the model in the drawer

**Date:** 2026-08-21
**Status:** design, approved in brainstorming

## What this adds

Two facts the Deck can observe but never shows:

1. **Which tool is driving a run** — Claude Code, GitHub Copilot or Cursor — as a small
   brand mark riding the corner of the card's existing kind tile, on the card and in the
   detail drawer's header.
2. **Which model a session is answering with** — one per agent row in the drawer's Agents
   section.

Nothing else about the card changes. Both facts are absent-tolerant: where the answer is
not known, the UI shows nothing rather than a placeholder or a guess.

## Why the provider can only come from the launch

Session discovery is Claude-only and will stay that way for now. `readOpenSessions` reads
`~/.claude/sessions`, Claude Code's own registry of live sessions, keyed by pid
(`src/engine/sessions.ts`). No equivalent exists for the other two providers — verified on
the development machine: `~/.cursor/agents` is empty, `~/.cursor/projects/*` holds IDE
workspace state (terminals, mcps, canvases), and `~/.copilot` holds process logs. Neither
carries a live-session record the Deck could join to a run directory.

The consequence already visible on the board today: **a Cursor- or Copilot-launched run
renders as a parked card even while its agent is working**, because the Deck sees no
session in it. This design does not fix that — it only stops the card from being silent
about which tool it belongs to.

So the provider is a property of the *launch*, recorded at launch time, with one inference
for the case a record cannot cover.

## Data — host side

### 1. `AgentProvider` moves to `types.ts`

`AgentProvider` is declared in `src/config.ts`, which imports `vscode`. The webview bundles
for a browser target and esbuild resolves imports statically, so the webview cannot import
anything reachable from `vscode` — and `test/webview/webviewGraph.test.ts` walks the real
import graph from each webview entry point and fails when it can.

Declare the union in `src/types.ts` and re-export it from `config.ts`, so every existing
importer keeps working. This is exactly the pattern `OpenSession` already uses, for the
same reason and with the same comment style (`src/types.ts:181`).

```ts
// src/types.ts
export type AgentProvider = "claude-code" | "copilot" | "cursor";
```

`config.ts` keeps `providerLabel`, `isCursorHost` and the settings resolution — only the
type moves.

### 2. `Run.provider` — stamped at launch

```ts
// src/types.ts, in Run
/** The agent that was actually seeded when this run was launched — `OpenResult.provider`,
 * not the setting, so it names the real agent even under `ask`. Absent on every record
 * written before this field existed, and on a `local` run, which was never launched by
 * Agent Flow at all. */
provider?: AgentProvider;
```

Written in the two places that build a `Run` record:

- `openWorkspace` (`src/engine/workspace.ts:542`) — the provider is resolved at the top of
  the function, well before the record is written, so the value is simply in hand.
- `batchWorkspace` (`src/engine/batchWorkspace.ts:211`) — same value, same shape.

Optional, so no migration: every record already on disk stays valid and simply has no
provider.

### 3. `AgentActivity.model` — read from lines already parsed

```ts
// src/types.ts, in AgentActivity
/** The model the last main-chain assistant line answered with, e.g. "claude-opus-5".
 * Null when the tail carries no such line (a transcript whose last 200 lines are all
 * subagent work, or a session that has not answered yet). Absent on every
 * AgentActivity literal written before this field existed. */
model?: string | null;
/** How many DISTINCT main-chain models appear in the tail. 1 in the ordinary case; more
 * when the session switched models mid-run, which the drawer marks with a "+N". */
modelCount?: number;
```

Derived in `deriveActivity` (`src/engine/transcript.ts:35`), from the lines the function
already receives. `parseLines` tails 200 lines and is already called once per session per
sweep, so this adds no I/O and no new file read.

`TranscriptLine` grows two fields it does not currently read:

```ts
isSidechain?: boolean;
message?: { role?: string; stop_reason?: string | null; model?: string };
```

The rule, in order:

- Consider only lines with `type === "assistant"` and a `message.model`.
- **Exclude `isSidechain === true`** — those are subagent turns. A main session that
  dispatches a subagent must not report the subagent's model as its own.
- `model` is the **last** such line's model. `modelCount` is the number of distinct models
  across all such lines in the tail.

Both are real cases, not hypotheticals: this repo's own transcripts hold `claude-opus-5`
and `claude-fable-5` on the same main chain (fast mode switches the model mid-session), and
sidechain lines carry their own model routinely.

### 4. `RunStatus.provider` — the one place inference happens

```ts
// src/types.ts, in RunStatus
/** Which tool is driving this run, for the card's provider mark. The run record's own
 * stamp when it has one; otherwise inferred — a live Claude Code session in this run's
 * directories means claude-code, because that registry is the only one the Deck can
 * read. Absent when neither answers, and the card then shows no mark at all rather than
 * guessing from the current setting, which may have changed since the launch or be
 * `ask`. */
provider?: AgentProvider;
```

Set in `buildRunStatus` (`src/engine/status.ts:49`), which already holds both inputs:

```ts
const provider = run.provider ?? (agents.length > 0 ? "claude-code" : undefined);
```

The webview never infers. It renders the field or renders nothing.

## UI — the card and the drawer

### The provider badge

`CardKindIcon` (`src/webview/icons.tsx:150`) gains one optional prop:

```tsx
export const CardKindIcon = ({ kind, provider }: {
  kind: CardKind;
  provider?: AgentProvider | null;
}): JSX.Element
```

The badge renders inside the existing `.av` tile, which is already `position: relative`
(`src/webview/deckStyles.ts:199`) — so the tile keeps its slot, its size and its hue, and
the provider reads as a fact *about* the card's kind rather than as a competing mark. The
kind stays the card's identity, which is what the header comment in `DeckApp.tsx` already
says the tile is for.

Geometry, chosen against a 2× render at true card width:

- 15px plate, `border-radius: 5px`, `right: -5px; bottom: -5px`, `.av` set to
  `overflow: visible`.
- 11px mark inside it.
- Plate ground and border match the kind tile's own treatment, so it introduces no new
  surface: `color-mix(in srgb, var(--vscode-foreground) 10%, var(--vscode-editor-background))`
  with a `var(--hair)` border.

Both call sites pass it, because a selected card and its drawer are one object:

- `Card` in `DeckApp.tsx:224` — `<CardKindIcon kind={kind} provider={r.provider} />`
- `DeckDetail.tsx:127` — the same, off the same `RunStatus`.

### The marks

Three inline `<path>`s in a 24-unit box, `fill="currentColor"`, sitting beside
`CARD_KIND_GLYPHS` in `icons.tsx` — the same treatment, for the same reasons the existing
comment gives: no image assets, no `asWebviewUri` plumbing, no widened CSP.

Provenance, to go in a comment above them: the path data is Simple Icons' rendition of each
mark (CC0), fetched once and inlined; the marks themselves are the trademarks of Anthropic,
GitHub and Anysphere and appear here nominatively, to identify which tool is driving a run.
Claude's hue `#D97757` is Anthropic's own, taken from the `claude-logo.svg` that ships
inside the Claude Code extension.

Cost: roughly 3.8KB of path data across the three (Claude's alone is ~1.8KB — it is a
detailed mark, and a hand-redraw would be less faithful, which is the opposite of the
point).

### Hue

```
claude-code → #D97757 on the glyph, and the plate tinted with it:
              border-color: color-mix(in srgb, #D97757 34%, var(--hair));
              background:   color-mix(in srgb, #D97757 10%, var(--vscode-editor-background));
copilot     → theme ink: color-mix(in srgb, var(--vscode-foreground) 72%, transparent)
cursor      → theme ink, same as copilot
```

Cursor and GitHub Copilot are black-on-white marks. Neither has a brand colour that
survives a dark theme, so each takes the theme's own ink; only Claude is coloured. That
asymmetry is deliberate and was reviewed on both themes — it reads as "one of these has a
colour", not as a status difference.

One rule this must not break: a hue on a Deck card has so far always meant a *status*. The
badge is 15px, sits inside the neutral kind tile rather than on the card's ground, and
never changes with state — so it cannot be mistaken for the state dot or the `.attn`
treatment, which are the two things that own colour on a card today.

Accessibility: the badge carries a `title` naming the tool in full ("Claude Code",
"GitHub Copilot", "Cursor"), and the tile's `aria-label` extends to name both facts —
"Ticket · Claude Code" rather than the kind alone.

### The model, per agent row

`AgentsRow` (`src/webview/deckParts.tsx:118`) gains one span on `.ag-row`, between the
state and the age:

```tsx
{a.activity.model && (
  <span className="ag-model" title={modelTitle(a.activity)}>
    {modelLabel(a.activity.model)}
    {(a.activity.modelCount ?? 1) > 1 && <span className="plus">+{a.activity.modelCount! - 1}</span>}
  </span>
)}
```

- `.ag-model` is mono (`var(--mono)`, `var(--t-data)`) because a model name is an
  identifier — the same rule `.ag-name` and `.key` already follow.
- `modelLabel` strips a leading `claude-` and a trailing `-YYYYMMDD`, so `claude-opus-5` →
  `opus-5` and `claude-3-5-haiku-20241022` → `3-5-haiku`. It strips nothing else: an
  unrecognised model renders verbatim rather than being mangled into something that reads
  like a different model.
- `+N` appears only when the tail holds more than one distinct main-chain model. The
  `title` says which model is current and that the session used others.
- **No model, no span.** A row whose transcript yielded nothing shows the state, age and
  open-time it shows today — never "unknown", never a dash.

`AgentsRow` renders in two places (the card's collapsed fold and the drawer's expanded
section) and this change applies to both; the card's fold is collapsed by default, so the
card gains nothing at rest.

## What each case looks like

| Case | Badge | Model |
|---|---|---|
| Run launched by Agent Flow with Claude Code, session live | Claude, orange | per row |
| Same run after the agent exits | Claude, orange (from the record) | none — no session, no row |
| Run launched with Cursor or Copilot | Cursor / Copilot, theme ink | none — no transcript to read |
| Run record written before this ships, session live | Claude, orange (inferred) | per row |
| Run record written before this ships, no session | none | none |
| `local` discovered place with a Claude session | Claude, orange (inferred) | per row |
| Session whose 200-line tail is all subagent work | unchanged | none |

## Testing

Unit, `test/unit/engine/`:

- `transcript.test.ts` — `deriveActivity` returns the last main-chain model; ignores
  `isSidechain` lines even when they are last; counts distinct models; returns
  `model: null` with no assistant line carrying a model; leaves every existing assertion
  in the file untouched.
- `status.test.ts` — `buildRunStatus` prefers `run.provider`; infers `claude-code` from a
  live session when the record has none; leaves `provider` undefined with neither.
- `workspace.test.ts` and `batchWorkspace.test.ts` — the written record carries the
  provider that was actually seeded, including under `ask`.

Webview, `test/webview/` — both target files already exist and gain cases rather than
being created:

- `CardKindIcon.test.tsx` — renders the badge only when `provider` is given, picks the
  right mark and hue per provider, and keeps its existing kind assertions passing.
- `deckParts.test.tsx` — `AgentsRow` renders the model when present, omits the span
  entirely when absent, renders `+N` only for `modelCount > 1`, and applies `modelLabel`'s
  stripping.
- `webviewGraph.test.ts` must keep passing unchanged — it is what proves the
  `AgentProvider` move did not drag `vscode` into the webview graph.

Mutation check on every new test: break the implementation line the test claims to cover
and confirm the test fails. A test that passes against a deliberately broken
implementation is not coverage.

## Gates this must clear

- `npm run typecheck` (`tsc --noEmit`).
- `npm run build` — the only gate that catches a Node builtin reaching the webview graph;
  `tsc` and the full suite both pass regardless.
- `npm test` — the whole existing suite, unmodified. This extension has thousands of
  installs: new behaviour ships inert (every new field optional, every new mark absent
  when unknown), and no existing test may be edited to accommodate it. The run takes
  ~220s, past the default Bash timeout — invoke it with an explicit long timeout.
- `npm run test:cov` — thresholds in `vitest.config.ts` are statements 90 / branches 85 /
  functions 85 / lines 90; changed files should land at ≥95%.

## Out of scope

- **Discovering Cursor or Copilot sessions.** No registry exists to read. Until one does,
  those runs stay parked-looking, and the badge is the only thing that says a tool is
  behind them.
- **A model on the card.** Spend was deliberately taken off the card (a66c543) because a
  per-card number competed with the state line and the failure rows, and two tests pin
  that. The model is the same kind of fact and stays in the drawer.
- **Per-agent provider.** Every session the Deck can see is a Claude Code session, so a
  per-agent mark would be a constant. The badge is run-level for as long as that holds.
- **Retro-stamping existing run records.** They fill in through inference while a session
  is live, and permanently the next time the run is launched.
