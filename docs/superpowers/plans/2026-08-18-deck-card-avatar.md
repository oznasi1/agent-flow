# Deck Card Avatar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lead every Deck card with an avatar that says what kind of thing it is, make the title the card's typographic anchor, and give the live state its own row with the run's spend and age beside it.

**Architecture:** Pure webview change. A new `CardKindIcon` in `src/webview/icons.tsx` renders one inline SVG per `runKind` value, exactly as `TypeIcon` already does for ticket types. `DeckApp`'s `Card` regroups its existing rows around that avatar; `DeckDetail`'s header takes the same one. No host message changes, no new field on `RunStatus`, no new value on the wire — every figure the new layout prints (`runKind(r.run)`, `r.usage`, `r.run.createdAt`) is already there.

**Tech Stack:** TypeScript, React (webview), esbuild, vitest, @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-08-18-deck-card-avatar-design.md` — read it before Task 1. It carries the reasoning behind every choice here, including why no provider brand mark ships.

## Global Constraints

- **All four gates must pass before a task is done:** `npm run typecheck`, `npm test`, `npm run build`, `npm run test:cov`.
- **`npm run build` is not optional and not covered by the others.** It is the only gate that catches a `src/webview/` module reaching a Node builtin. `tsc` and the full suite pass regardless. `src/webview/` must not import `fs`, `os`, `path`, or `child_process`, **even transitively**.
- **Coverage thresholds (`vitest.config.ts`):** statements 90, branches 85, functions 85, lines 90.
- **Every test must fail before the implementation exists.** Run it, see it fail, then implement. A test that passes against unmodified code covers nothing. If a test passes on the first run, it is broken — fix the test, do not proceed.
- **The existing suite must pass completely unmodified.** This is why the spec pins the class-name contract: `.status`, `.c-sig`, `.key`, `.key-wrap`, `.chip`, `.c-rows`, `.c-row`, `.c-foot2`, `.sdot` and `.c-diff` keep their names in their new homes. If an existing test fails, the implementation is wrong, not the test. There is no authorised exception in this plan.
- **This extension has thousands of installs.** This task changes only how the card is arranged. No behaviour, no message, no action, no gate on any button may change.
- **Token unit is `eq`, never `tok`.** The figure is an effort-weighted equivalent, not a token count.
- **Absent usage and zero usage must render differently.** A run not yet measured shows no figure at all; a measured all-zero run shows `0eq`. It must never show `0` for the unmeasured case.
- **No image assets and no `asWebviewUri`.** Glyphs are inline SVG in `currentColor`, following `TypeIcon`. Anything else widens the webview CSP.
- **Mono is for identifiers and counts, never for prose.** The branch, the key, the PR number, the diff totals and the spend/age figures are mono; state text and kind names are not.
- **Work in the worktree** `/Users/oznasi/dev/agent-flow/.claude/worktrees/d8-card-visual` on branch `feat/deck-card-avatar`. Use absolute paths in shell commands — parallel sessions share the root checkout and switch its branch.
- **Commit after every task.** A round can be killed mid-flight; an uncommitted tree is lost work.

## File Structure

| File | Responsibility |
|---|---|
| `src/webview/icons.tsx` | Modify. Add `CARD_KIND_GLYPHS`, `CARD_KIND_LABEL` and `CardKindIcon`. Sits beside `TypeIcon`, which is the same idea for a different vocabulary. |
| `src/webview/DeckApp.tsx` | Modify. `Card`'s markup only: `.c-hd` header, restyled `.c-sig`, `.c-hr`, `.c-st` state row. No logic change — `stateView`, `cardSignal`, `cardActions`, the drag key and every handler stay byte-identical. |
| `src/webview/DeckDetail.tsx` | Modify. The same avatar in `.dd-hd`; correct the now-stale "spend lives only here" comment. |
| `src/webview/deckStyles.ts` | Modify. `.av` + kind hues, `.c-hd`/`.hd-t`/`.hd-k`, `.c-sig` restyle, `.c-hr`, `.c-st`/`.c-meta`, `.c-title` clamp 3→2. |
| `test/webview/CardKindIcon.test.tsx` | **Create.** One case per kind plus the accessible name, mirroring `TypeIcon.test.tsx`. |
| `test/webview/DeckApp.test.tsx` | Modify — **additions only**. New cases for the avatar, the header key, and the state row. |
| `test/webview/DeckDetail.test.tsx` | Modify — **additions only**. The drawer header's avatar. |

---

### Task 1: The card-kind glyphs

**Files:**
- Modify: `src/webview/icons.tsx`
- Test: `test/webview/CardKindIcon.test.tsx` (create)

**Interfaces:**
- Consumes: `runKind` from `../types` (for its return type only).
- Produces: `type CardKind = ReturnType<typeof runKind>` (i.e. `"task" | "explore" | "review" | "local" | "notepad"`); `CARD_KIND_LABEL: Record<CardKind, string>`; `CardKindIcon({ kind }: { kind: CardKind }): JSX.Element` — renders `<span class="av k-<kind>" role="img" aria-label="<label>" title="<label>">` around a 14px SVG.

- [ ] **Step 1: Write the failing test**

Create `test/webview/CardKindIcon.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import * as React from "react";
import { CARD_KIND_LABEL, CardKindIcon } from "../../src/webview/icons";

const KINDS = ["task", "explore", "review", "local", "notepad"] as const;

describe("CardKindIcon", () => {
  it("names the kind in words, not in a class name", () => {
    const { getByRole } = render(<CardKindIcon kind="notepad" />);
    // The glyph is the only thing on the card that says which kind it is, so the
    // accessible name has to say it too.
    expect(getByRole("img").getAttribute("aria-label")).toBe("Notepad note");
    expect(getByRole("img").getAttribute("title")).toBe("Notepad note");
  });

  it("carries a per-kind hue class so one kind never reads as another", () => {
    const seen = new Set<string>();
    for (const kind of KINDS) {
      const { container, unmount } = render(<CardKindIcon kind={kind} />);
      const av = container.querySelector(".av")!;
      expect(av.className).toBe(`av k-${kind}`);
      seen.add(CARD_KIND_LABEL[kind]);
      unmount();
    }
    // Five kinds, five distinct names: a shared label would make two kinds
    // indistinguishable to a screen reader even though their glyphs differ.
    expect(seen.size).toBe(KINDS.length);
  });

  it("draws a distinct glyph for every kind", () => {
    const shapes = new Set<string>();
    for (const kind of KINDS) {
      const { container, unmount } = render(<CardKindIcon kind={kind} />);
      const svg = container.querySelector("svg")!;
      expect(svg.getAttribute("width")).toBe("14");
      expect(svg.getAttribute("viewBox")).toBe("0 0 16 16");
      shapes.add(svg.innerHTML);
      unmount();
    }
    expect(shapes.size).toBe(KINDS.length);
  });

  it("inherits its colour rather than hard-coding one", () => {
    // currentColor is what lets .av.k-<kind> set the hue from CSS, and what keeps
    // the glyph legible in both themes without a second copy of each path.
    const { container } = render(<CardKindIcon kind="task" />);
    expect(container.innerHTML).toContain("currentColor");
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,6}/i);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run test/webview/CardKindIcon.test.tsx`
Expected: FAIL — `"CardKindIcon" is not exported by "src/webview/icons.tsx"`.

- [ ] **Step 3: Implement the glyphs**

Append to `src/webview/icons.tsx` (and add `runKind` to the existing type-only import from `../types`, i.e. `import { runKind } from "../types";` — it is a value import, but only its type is used, and `types.ts` is webview-safe):

```tsx
/** What a Deck card is, as `runKind` reports it. Derived from the function rather
 * than restated, so a sixth kind cannot be added to `types.ts` without the
 * compiler demanding a glyph for it here. */
export type CardKind = ReturnType<typeof runKind>;

/** The kind in words. It is the accessible name and the tooltip: the glyph is the
 * only thing on the card that says which kind it is, so this is not decoration. */
export const CARD_KIND_LABEL: Record<CardKind, string> = {
  task: "Ticket",
  notepad: "Notepad note",
  explore: "Explore place",
  review: "PR review",
  local: "Untracked local place",
};

// Card-kind glyphs. 14×14 in a 16-unit box, currentColor, hue supplied by the
// .av.k-<kind> rule in deckStyles.ts. Same reasoning as TYPE_GLYPHS above: inline
// SVG rather than image assets, so there is no asWebviewUri plumbing and no
// widened CSP for what amounts to five shapes.
const CARD_KIND_GLYPHS: Record<CardKind, JSX.Element> = {
  // A tag: the tracked thing on the other end of the card.
  task: (
    <path
      fill="currentColor"
      d="M7.6 2H13a1 1 0 0 1 1 1v5.4a1 1 0 0 1-.29.71l-5 5a1 1 0 0 1-1.42 0L2.29 9.11a1 1 0 0 1 0-1.42l5-5A1 1 0 0 1 7.6 2zm3.15 1.9a1.15 1.15 0 1 0 0 2.3 1.15 1.15 0 0 0 0-2.3z"
    />
  ),
  // A written-on page. One path, evenodd: the ruled lines are real holes, so the
  // glyph needs no second colour to knock them out.
  notepad: (
    <path fill="currentColor" fillRule="evenodd" d="M3.4 1.8h9.2v12.4H3.4zm1.6 2.4v1.3h6V4.2zm0 3v1.3h6V7.2zm0 3v1.3h3.6v-1.3z" />
  ),
  // A magnifier: an Explore run is a question, not a change.
  explore: (
    <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <circle cx="6.9" cy="6.9" r="4.1" />
      <path d="M10.1 10.1l3.3 3.3" />
    </g>
  ),
  // Two nodes joining a third — the same fork git hosts use for a pull request.
  review: (
    <g fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="4.3" cy="4" r="1.9" />
      <circle cx="4.3" cy="12" r="1.9" />
      <circle cx="11.7" cy="8" r="1.9" />
      <path d="M4.3 5.9v4.2M6.2 4h2.1a1.5 1.5 0 0 1 1.5 1.5v1" strokeLinecap="round" />
    </g>
  ),
  // A pin: a place on this machine, discovered rather than launched.
  local: (
    <path
      fill="currentColor"
      fillRule="evenodd"
      d="M8 1.6a4.5 4.5 0 0 1 4.5 4.5c0 3.1-4.5 8.3-4.5 8.3S3.5 9.2 3.5 6.1A4.5 4.5 0 0 1 8 1.6zm0 2.7a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z"
    />
  ),
};

/** What this card is, as a hued glyph in a neutral tile. Leads the Deck card and
 * the detail drawer's header, so a selected card and its detail open with the
 * same mark. */
export const CardKindIcon = ({ kind }: { kind: CardKind }): JSX.Element => (
  <span className={`av k-${kind}`} role="img" aria-label={CARD_KIND_LABEL[kind]} title={CARD_KIND_LABEL[kind]}>
    <svg width="14" height="14" viewBox="0 0 16 16">{CARD_KIND_GLYPHS[kind]}</svg>
  </span>
);
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run test/webview/CardKindIcon.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 5: Run the gates**

```bash
npm run typecheck && npm test && npm run build
```

Expected: all three clean. `npm run build` is what proves `icons.tsx` still reaches no Node builtin through its new `../types` import.

- [ ] **Step 6: Commit**

```bash
git add src/webview/icons.tsx test/webview/CardKindIcon.test.tsx
git commit -m "feat(deck): add a glyph per card kind"
```

---

### Task 2: The card's new arrangement

**Files:**
- Modify: `src/webview/DeckApp.tsx` (the `Card` component's returned JSX only)
- Modify: `src/webview/deckStyles.ts`
- Test: `test/webview/DeckApp.test.tsx` (additions only)

**Interfaces:**
- Consumes: `CardKindIcon`, `CardKind` from `./icons` (Task 1); `runKind` from `../types`; `formatEq`, `weightedEq` from `../engine/usage` (both already imported by `DeckApp.tsx`); `timeAgo` from `./helpers` (already imported).
- Produces: the card DOM the spec draws — `.c-hd > .av + .hd-t + .hd-k`, `.c-sig` (or `.c-rows`), `.c-hr`, `.c-st > .sdot + .status + .c-meta`, `.c-foot2`.

- [ ] **Step 1: Write the failing tests**

Add to `test/webview/DeckApp.test.tsx`, inside the existing top-level `describe` and following the file's own conventions for building runs and rendering the board (reuse the helpers already defined at the top of that file — do not invent new ones):

```tsx
describe("card avatar and state row", () => {
  it("leads the card with its kind, and keeps the ticket key whole beside the title", async () => {
    // A tracked run: the kind is "task", so the avatar is the ticket tag and the
    // key stays a link to the tracker.
    const { container } = await renderBoard([
      run({ key: "DEMO-142", summary: "Export times out on large workspaces" }),
    ]);
    const card = container.querySelector(".card")!;
    const hd = card.querySelector(".c-hd")!;
    // The avatar is the header's FIRST child: the whole point is that every card
    // starts at the same x with the same kind of mark.
    expect(hd.firstElementChild!.className).toBe("av k-task");
    expect(hd.querySelector(".hd-t .c-title")!.textContent).toBe("Export times out on large workspaces");
    // Not ellipsized away into a wrapper that shrinks: the key is the one string
    // on this card that cannot be reconstructed from anything else.
    expect(hd.querySelector(".hd-k .key")!.textContent).toBe("DEMO-142");
  });

  it("gives a notepad card the notepad mark, not the ticket one", async () => {
    const { container } = await renderBoard([
      run({ key: "note-abc", summary: "Rip the retry loop out of the fan-out", kind: "notepad" }),
    ]);
    expect(container.querySelector(".c-hd .av")!.className).toBe("av k-notepad");
  });

  it("puts the state on its own row under a hairline, with spend and age in mono", async () => {
    const { container } = await renderBoard([
      run({
        key: "DEMO-142",
        summary: "Export times out on large workspaces",
        agent: { state: "working", lastActivityMs: Date.now() - 24_000, slug: null },
        usage: { input: 2_000, output: 40_000, cacheWrite: 100_000, cacheRead: 4_000_000 },
      }),
    ]);
    const card = container.querySelector(".card")!;
    // The hairline sits between the facts and the live state, and there is exactly
    // one of it: a second rule would stop it meaning anything.
    expect(card.querySelectorAll(".c-hr").length).toBe(1);
    const st = card.querySelector(".c-st")!;
    expect(st.querySelector(".sdot")!.className).toContain("tone-working");
    expect(st.querySelector(".status")!.textContent).toContain("working");
    const meta = st.querySelector(".c-meta")!;
    expect(meta.textContent).toContain("eq");
    // The age is the run's own, and says so — the state text beside it ends in a
    // duration too (last activity), and the two are different clocks.
    expect(meta.querySelector(".age")!.getAttribute("title")).toMatch(/^launched /);
  });

  it("shows no figure at all for a run whose usage has not been read", async () => {
    const { container } = await renderBoard([run({ key: "DEMO-142", summary: "Not measured yet" })]);
    const meta = container.querySelector(".card .c-meta")!;
    // Absent is not zero. Printing 0 here would assert the run cost nothing.
    expect(meta.textContent).not.toContain("eq");
    expect(meta.querySelector(".age")).not.toBeNull();
  });

  it("shows 0eq for a run measured at zero", async () => {
    const { container } = await renderBoard([
      run({ key: "DEMO-142", summary: "Measured, and it cost nothing", usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } }),
    ]);
    expect(container.querySelector(".card .c-meta")!.textContent).toContain("0eq");
  });
});
```

Adapt `renderBoard(...)` / `run({...})` to whatever the surrounding file already calls its board-render and run-builder helpers — the names above are placeholders for that file's existing ones, and the assertions are what matter. If the file has no run-builder helper, build the `RunStatus` literals the same way its neighbouring tests do.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/webview/DeckApp.test.tsx -t "card avatar and state row"`
Expected: FAIL — `.c-hd` is null, because the card still renders `.c-top`.

- [ ] **Step 3: Re-arrange the card**

In `src/webview/DeckApp.tsx`, add to the existing `./icons` import (creating it if `DeckApp.tsx` has none): `import { CardKindIcon } from "./icons";` and add `runKind` to its existing import from `../types`.

Inside `Card`, above the `return`, add:

```tsx
  // What this card IS, as its own mark. The run's kind, never the agent's: on the
  // Agents board the state comes from the session, but the object the card belongs
  // to is still the run.
  const kind = runKind(r.run);
  // The eq total, or nothing. `r.usage` is absent until the host's 60s usage sweep
  // has read this run, and an unmeasured run must not render like one that cost
  // nothing — hence the explicit undefined check rather than a falsy one, which
  // would swallow a genuine zero.
  const eq = r.usage === undefined ? null : formatEq(weightedEq(r.usage));
```

Replace the `<div className="c-top" …>` block (the status span and the key/chip
arrangement) with the header below. **The key branch is moved verbatim** — the
`inferredKey` / `tracked` / untracked ternary, its titles, its handlers and its
`.chip` markers are unchanged; only their container is new:

```tsx
      {/* The avatar leads, on the x the tone dot used to hold, so a column still
          scans from one left edge. The title is the anchor; the key trails it on
          the same line, flex: none, because a truncated ticket key is the one
          identifier on this card nobody can reconstruct. */}
      <div className="c-hd" onClick={(e) => e.stopPropagation()}>
        <CardKindIcon kind={kind} />
        <div className="hd-t">
          <div className="c-title" title={r.run.summary}>
            {local && inferredKey && <span className="chip">local</span>}
            {r.run.summary}
          </div>
        </div>
        <span className="hd-k">
          {inferredKey ? (
            <span className="key-wrap">
              <span className="chip" title="Read from the branch name — Agent Flow Deck did not launch this">~inferred</span>
              <button
                className="key"
                title={`Open ${inferredKey} in ${sourceLabel}`}
                onClick={() => send({ type: "openExternal", url: r.run.url })}
              >
                {inferredKey}
              </button>
            </span>
          ) : tracked ? (
            <button className="key" title={`Open ${r.run.key} in ${sourceLabel}`} onClick={() => send({ type: "openExternal", url: r.run.url })}>
              {r.run.key}
            </button>
          ) : (
            <span className="key untracked" title={r.run.key}>{keyLabel(r.run)}</span>
          )}
        </span>
      </div>
```

Delete the old standalone `<div className="c-title" …>` block — the title now
lives inside `.hd-t`, and its `local` chip moved with it.

Leave the `acts.length > 0 ? … : sigBits.length > 0 ? … : null` region exactly as
it is: same classes, same bits, same handlers.

Then, immediately before the existing `.c-foot2` block, insert:

```tsx
      {/* One hairline, so it means one thing: identity and facts above it, live
          state below. */}
      <hr className="c-hr" />
      <div className="c-st">
        <span className={`sdot tone-${sv.tone} ${sv.tone === "working" ? "pulse" : ""}`} />
        <span className={`status tone-${sv.tone}`}>{sv.text}</span>
        <span className="c-meta">
          {eq !== null && <span className="eq" title="Effort-weighted equivalent: input×1, cache-write×1.25, cache-read×0.1, output×5. Rate ratios, not prices.">{eq}<span className="u">eq</span></span>}
          {/* Its own title, in words: the state text to the left also ends in a
              duration (the last activity), and these are different clocks. */}
          <span className="age" title={`launched ${timeAgo(r.run.createdAt)}`}>{timeAgo(r.run.createdAt)}</span>
        </span>
      </div>
```

The `.sdot` and `.status` spans are the ones that used to sit in `.c-top`,
unchanged: `sv.tone`, `sv.text` and the `pulse` condition are all as they were.
The `.status` span no longer wraps the dot, so the dot is now its sibling — which
is why `.c-st` owns the gap.

- [ ] **Step 4: Add the CSS**

In `src/webview/deckStyles.ts`, change `.c-title`'s clamp from three lines to two:

```css
  .c-title { margin-top: 5px; font-size: var(--t-title); font-weight: 550; line-height: 1.42; letter-spacing: -.008em;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
```

Replace the `.c-top` rule with the block below, keeping the `.status`, `.key`,
`.chip`, `.key-wrap` and `.sdot` rules that follow it exactly as they are — they
are the class contract:

```css
  /* The card's header: the kind avatar leads from the same x on every card, the
     title is the anchor, the key trails it. `align-items: flex-start` so a
     two-line title grows downward and leaves the avatar and key on line one. */
  .c-hd { display: flex; align-items: flex-start; gap: 10px; min-width: 0; }
  .c-hd .hd-t { flex: 1; min-width: 0; }
  .c-hd .hd-t .c-title { margin-top: -1px; }
  /* `flex: none` and `max-width: none` together: the key must not shrink, and the
     .key rule below caps every other key at 46% of its row. The title wraps
     instead — it is already built to. */
  .c-hd .hd-k { flex: none; padding-top: 1px; }
  .c-hd .hd-k .key, .c-hd .hd-k .key-wrap { margin-left: 0; max-width: none; }

  /* The kind avatar. A neutral tile with a hued glyph: the tile ground stays
     neutral because a column of cards must not become a column of colours — the
     board's colour vocabulary belongs to the columns and to .attn, and a kind is
     not a status. */
  .av { position: relative; flex: none; width: 22px; height: 22px; border-radius: 6px;
    display: inline-flex; align-items: center; justify-content: center;
    border: 1px solid var(--hair); color: var(--dim);
    background: color-mix(in srgb, var(--vscode-foreground) 5%, transparent); }
  .av svg { display: block; }
  .av.k-task    { color: color-mix(in srgb, var(--c-review) 78%, var(--vscode-foreground)); }
  .av.k-notepad { color: color-mix(in srgb, var(--vscode-charts-yellow) 78%, var(--vscode-foreground)); }
  .av.k-explore { color: color-mix(in srgb, var(--vscode-charts-purple) 78%, var(--vscode-foreground)); }
  .av.k-review  { color: color-mix(in srgb, var(--c-done) 78%, var(--vscode-foreground)); }
  .av.k-local   { color: var(--dim); }
```

Restyle `.c-sig` where it is defined — it keeps its name, its bits and its
separators, and becomes a mono caption under the title rather than a third band
of body text. Find the existing `.c-sig` rule and change only its type
treatment, leaving its layout, `.sep`, `.m`, `.ok`, `.bad`, `.warn` and
`.c-diff` children untouched:

```css
  /* Under the title as a caption: same bits, same order, same cap of three —
     only the typography changes. Mono because every bit it carries is an
     identifier or a count. */
  .c-sig { margin-top: 4px; font-family: var(--mono); font-size: var(--t-data); }
```

Add, immediately before the `.c-foot2` rule:

```css
  /* The card's only rule. Identity and facts above, live state below. */
  .c-hr { border: 0; height: 1px; margin: 9px 0 7px;
    background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent); }

  /* State left, spend and age right. The figures are mono and tabular so a
     column of cards lines its numbers up; the state text is not, because it is
     English. */
  .c-st { display: flex; align-items: center; gap: 7px; min-width: 0; }
  .c-st .status { flex: 0 1 auto; }
  .c-meta { margin-left: auto; flex: none; display: inline-flex; align-items: baseline; gap: 6px;
    font-family: var(--mono); font-size: var(--t-data); color: var(--dim); font-variant-numeric: tabular-nums; }
  /* Same muted-suffix treatment as the header total and the drawer's own eq row. */
  .c-meta .u { font-family: var(--vscode-font-family); opacity: .7; margin-left: 1px; }
  .c-meta .eq + .age::before { content: "·"; opacity: .45; margin-right: 6px; }
```

- [ ] **Step 5: Run the tests and watch them pass**

```bash
npx vitest run test/webview/DeckApp.test.tsx
```

Expected: PASS — the five new cases **and** every pre-existing case in the file,
untouched. If a pre-existing case fails, the class contract was broken: find
which name moved and put it back.

- [ ] **Step 6: Run the gates**

```bash
npm run typecheck && npm test && npm run build && npm run test:cov
```

- [ ] **Step 7: Commit**

```bash
git add src/webview/DeckApp.tsx src/webview/deckStyles.ts test/webview/DeckApp.test.tsx
git commit -m "feat(deck): lead the card with its kind and give state its own row"
```

---

### Task 3: The same mark in the drawer

**Files:**
- Modify: `src/webview/DeckDetail.tsx`
- Test: `test/webview/DeckDetail.test.tsx` (additions only)

**Interfaces:**
- Consumes: `CardKindIcon` from `./icons` (Task 1); `runKind`, already imported by `DeckDetail.tsx`.
- Produces: nothing other tasks consume.

- [ ] **Step 1: Write the failing test**

Add to `test/webview/DeckDetail.test.tsx`, using the file's existing render helper and card fixture:

```tsx
it("opens with the same mark the card does, so the two read as one object", () => {
  const { container } = renderDetail(cardFor({ key: "explore-tenant-config", kind: "explore" }));
  const hd = container.querySelector(".dd-hd")!;
  // First child, same class as the card's own avatar: a selected card and its
  // drawer must not look like two different objects.
  expect(hd.firstElementChild!.className).toBe("av k-explore");
  expect(hd.querySelector(".av")!.getAttribute("aria-label")).toBe("Explore place");
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run test/webview/DeckDetail.test.tsx -t "same mark"`
Expected: FAIL — the header's first child is `.k`, not `.av`.

- [ ] **Step 3: Implement**

In `src/webview/DeckDetail.tsx`, add `CardKindIcon` to the imports from `./icons`
(creating the import if there is none), and put it first inside `.dd-hd`, before
the existing `<span className="k">`:

```tsx
      <div className="dd-hd">
        <CardKindIcon kind={runKind(r.run)} />
        {/* The label, not the raw key: … (comment unchanged) */}
        <span className="k" title={key}>{keyLabel(r.run)}</span>
```

Then correct the stale comment above the Spend section — the four raw classes
still live only in the drawer, but the eq total now also leads the card's state
row. Change its opening sentence from "Spend lives only here, never on the card"
to:

```tsx
      {/* The four raw classes live only here: they are what make the number
        * honest, and only the drawer has room for them. The card's state row
        * carries the eq total alone. The eq total is deliberately NOT the sum of
        * the four rows above it — cache reads dominate the raw count at a tenth
        * the rate, and a raw sum would rank tasks by conversation length rather
        * than by cost. The rows are raw token counts and say so; only the total
        * carries the eq unit. */}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run test/webview/DeckDetail.test.tsx`
Expected: PASS — the new case and every pre-existing one.

- [ ] **Step 5: Add the drawer's avatar CSS**

In `src/webview/deckStyles.ts`, beside the existing `.dd-hd .k` rule:

```css
  /* The drawer opens with the card's own mark. Same 22px tile — a smaller one
     here would read as a different object. */
  .dd-hd .av { flex: none; }
```

- [ ] **Step 6: Run the gates and commit**

```bash
npm run typecheck && npm test && npm run build && npm run test:cov
git add src/webview/DeckDetail.tsx src/webview/deckStyles.ts test/webview/DeckDetail.test.tsx
git commit -m "feat(deck): open the detail drawer with the card's own mark"
```

---

### Task 4: See it, both themes

**Files:**
- Modify: none required. `preview/` is gitignored; nothing here is committed except a fix, if the shots reveal one.

**Interfaces:**
- Consumes: the finished card from Tasks 1–3.
- Produces: evidence. jsdom applies no CSS, so no test in this plan can see a
  wrong hue, an overflowing key, a collapsed hairline or a two-line title
  clipping. Only these screenshots can.

- [ ] **Step 1: Build the bundle the harness renders**

```bash
npm run build
```

- [ ] **Step 2: Shoot the real board in both themes**

The harness is already in this worktree's `preview/` (copied from the root
checkout during design): `preview/deck-head.html` is a mock host, and
`preview/shoot-any.js` renders `dist/deck.js` against it.

```bash
node preview/shoot-any.js preview/deck-head.html preview/_d8-after.png
node preview/shoot-any.js preview/deck-head.html preview/_d8-after-light.png light
```

- [ ] **Step 3: Read both PNGs and check them against the spec**

Look for, and fix in the file that owns each:

1. Every card starts with a tile at the same x, and the tile's glyph differs by kind.
2. No ticket key is ellipsized. If one is, `.c-hd .hd-k` lost its `flex: none` or its `max-width: none`.
3. Exactly one hairline per card, above the state row.
4. Spend and age are right-aligned and share the column's right edge across cards; the `eq` suffix is the body face, not mono.
5. A card with failure rows still shows them, and still shows no `.c-sig` beside them.
6. The light theme's kind hues are legible at 14px on white — this is the case the mockup flagged as the risk.
7. No card's title clips mid-word against the two-line clamp on the narrowest column.

- [ ] **Step 4: Run all four gates one final time**

```bash
npm run typecheck && npm test && npm run build && npm run test:cov
```

Expected: clean, with coverage at or above statements 90 / branches 85 /
functions 85 / lines 90.

- [ ] **Step 5: Commit any fix the shots produced**

```bash
git add -A src test
git commit -m "fix(deck): <what the screenshots caught>"
```

If the shots caught nothing, there is nothing to commit — say so rather than
inventing a commit.
