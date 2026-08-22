# Deck Type and Colour Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reset the Deck's type scale, status palette, spacing and radii so hierarchy is carried by size and restraint rather than by colour, without touching card or column anatomy.

**Architecture:** Two files carry the whole change. [src/webview/tokens.ts](../../../src/webview/tokens.ts) changes token *values* only (the shared registry keeps its exact membership, so the sidebar and Marketplace inherit the new scale without being restyled). [src/webview/deckStyles.ts](../../../src/webview/deckStyles.ts) changes rules on the Deck's own selectors. One `.tsx` edit removes a now-dead custom property. No component, message-type, or behaviour change anywhere.

**Tech Stack:** TypeScript template-literal stylesheets injected into the webview head by [src/webview/deck.tsx](../../../src/webview/deck.tsx), Vitest, esbuild, headless-Chrome screenshot harnesses in gitignored `preview/`.

**Spec:** [docs/superpowers/specs/2026-08-22-deck-type-and-colour-design.md](../specs/2026-08-22-deck-type-and-colour-design.md)

## Global Constraints

- **CI gate is exactly four commands, all must pass:** `npm ci`, `npm run typecheck`, `npm test`, `npm run build`. `npm run build` is a real gate, not a formality.
- **`npm test` is ~4,500 tests over ~2+ minutes** and exceeds the default Bash tool timeout — pass `timeout: 600000`. Never pipe vitest through `tail`/`head`; it loses the failure list. A single failure under CPU contention is usually flake — re-run that file alone before believing it.
- **The existing suite must pass unmodified.** The one permitted test edit in this plan is adding a new `describe` block and one new value to an existing registry list; a test you had to *change* to go green is the signal to stop.
- **Never redeclare a token `tokens.ts` owns** in a surface sheet, and never use a custom property no sheet declares — `test/webview/tokens.test.ts` enforces both directions.
- **Pinned values, do not touch:** `--c-attn: #e0913a`, its light override `#a85c00`, `--brand: #2AA79B`, `--brand-ink: #04211E`, light `--brand: #157F76` / `--brand-ink: #ffffff`. Assertions match these as exact strings, including the whitespace in `--c-attn:     #e0913a`.
- **No `--brand` may reach a `.attn` selector** in `DECK_CSS`, and the permitted `--brand` selector list per surface in `tokens.test.ts` must not need new entries — this pass adds no brand usage.
- **Engine floor:** manifest is `"vscode": "^1.90.0"` = Chromium 122. Relative colour (`oklch(from …)`) shipped in Chromium 119, so it resolves — but every use ships a plain derived declaration first as fallback.
- **Mono stays the host's editor font** (`--mono`, i.e. `--vscode-editor-font-family`). No rule in this plan sets a UI font family.
- **Comment discipline:** these sheets are template literals full of prose. A stray `*/` silently discards the comment *and the rule after it*; `tokens.test.ts` walks the delimiters to catch it. When a rule is deleted, delete or correct the comment that explains it — a comment describing a removed rail is worse than no comment.
- **The `type scale` guard at [tokens.test.ts:358](../../../test/webview/tokens.test.ts#L358) scans the sidebar and `CONTROLS_CSS` only** — not `DECK_CSS`, which carries pre-token literals the guard would fail on. The Deck's new 16px and 19px leads are therefore legal, and adding `DECK_CSS` to that `SCALE_CLOSED` list as a "tidy-up" would fail CI on legacy code this pass does not touch. Leave the list alone.
- **The `surface header` guard** asserts `.hd .title .sub` keeps `display: block` and carries **no** `margin-left`. Task 2 rewrites that exact rule — keep both properties as they are or that test fails, correctly.
- **`preview/` is gitignored** — never `git add` anything under it.
- **Work on a branch, never on the shared root checkout of `main`.** Several sessions land on `main` a day.

## File Structure

| File | Change | Responsibility after the change |
|---|---|---|
| `src/webview/tokens.ts` | Modify | Same token membership, new values: four type steps, three radii, `--hair`, `--edge`, and four chroma-scaled resting hues |
| `src/webview/deckStyles.ts` | Modify | Deck rules: header, column head, column body rail, card, card content, action buttons, diff counts |
| `src/webview/DeckApp.tsx` | Modify (2 lines removed) | Stops computing and setting the per-card `--accent`, which no rule reads once the card rail goes |
| `test/webview/tokens.test.ts` | Modify (additive) | Adds a `resting status hues` describe block and a dead-`--accent` guard; the `RUNTIME_ONLY` list loses `--accent` |
| `CHANGELOG.md` | Modify | One entry under `## [Unreleased]` |

---

### Task 1: Token values and the chroma-scaled resting hues

The registry's membership does not change, so nothing else in the product can break by name. Values change, and the four resting hues gain a second declaration.

**Files:**
- Modify: `src/webview/tokens.ts` (the `TOKENS_CSS` `:root` block, roughly lines 10–90)
- Test: `test/webview/tokens.test.ts` (new describe block, appended)

**Interfaces:**
- Consumes: nothing.
- Produces: `--t-micro: 10.5px`, `--t-data: 11px`, `--t-body: 11.5px`, `--t-title: 13.5px`, `--r-card: 6px`, `--r-ctl: 5px`, `--r-chip: 4px`, and `--hair` / `--edge` as foreground mixes. Tasks 2 and 3 consume these by name only.

- [ ] **Step 1: Write the failing test**

Append to `test/webview/tokens.test.ts`:

```ts
describe("resting status hues", () => {
  // The four column hues that are NOT --c-attn. Each must stay DERIVED from the
  // host's chart palette — hard-coding them is how a dark-tuned hex ends up on a
  // light theme — and each must ship the chroma scale as a SECOND declaration, so
  // an engine that cannot parse relative colour keeps the plain derived hue
  // instead of an unset variable.
  const RESTING = ["--c-progress", "--c-review", "--c-done", "--c-idle"];

  it.each(RESTING)("%s derives from the host palette and scales its chroma", (token) => {
    const decls = [...stripComments(TOKENS_CSS).matchAll(new RegExp(`${token}:\\s*([^;]+);`, "g"))]
      .map((m) => m[1].trim());
    expect(decls).toHaveLength(2);
    expect(decls[0]).toMatch(/^var\(--vscode-charts-[a-z]+/);
    expect(decls[1]).toMatch(/^oklch\(from var\(--vscode-charts-[a-z]+/);
    expect(decls[1]).toContain("calc(c *");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/webview/tokens.test.ts -t "derives from the host palette"`
Expected: FAIL, four cases, each `expected length 2, received 1` — today each hue has exactly one declaration.

- [ ] **Step 3: Replace the four resting hue declarations**

In `TOKENS_CSS`, the block currently reading `--c-progress: var(--vscode-charts-blue, #4aa3df);` through `--c-idle: …`. Keep `--c-attn` and `--c-danger` exactly as they are, including `--c-attn`'s comment and its unusual whitespace. Result:

```css
    /* Resting hues: derived from the host's chart palette, then dropped to ~78% of
       their chroma. The board's rule is that one card at a time gets to be loud, and
       the loud one is amber — which only bites if everything at rest recedes.

       Two declarations per hue on purpose. The plain derived value comes first so an
       engine that cannot parse relative colour keeps a working hue rather than an
       unset variable; the oklch form then scales chroma without touching lightness,
       which is what keeps the hue correct on a light theme as well as a dark one.
       Mixing toward the foreground instead would lighten on dark and darken on
       light, and neither of those is "quieter". */
    --c-progress: var(--vscode-charts-blue, #4aa3df);
    --c-progress: oklch(from var(--vscode-charts-blue, #4aa3df) l calc(c * .78) h);
    --c-review:   var(--vscode-charts-purple, #b083f0);
    --c-review:   oklch(from var(--vscode-charts-purple, #b083f0) l calc(c * .78) h);
    --c-done:     var(--vscode-charts-green, #4ac26b);
    --c-done:     oklch(from var(--vscode-charts-green, #4ac26b) l calc(c * .78) h);
    --c-idle:     var(--vscode-charts-yellow, #d7a531);
    --c-idle:     oklch(from var(--vscode-charts-yellow, #d7a531) l calc(c * .78) h);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/webview/tokens.test.ts`
Expected: PASS, whole file — the pre-existing `attention hue`, `brand accent` and per-surface blocks included.

- [ ] **Step 5: Change the scale, radii and hairline values**

Same `:root` block. Replace the four type steps and three radii, and the two line values:

```css
    /* Four steps. Every font-size on every surface is one of these, so a new
       element can't quietly invent a fifth. --t-data and --t-micro sit half a pixel
       apart and that is deliberate, not a rounding accident: nine of the fourteen
       --t-data rules pair it with var(--mono), so it is the MONOSPACE step, and mono
       at the same nominal size reads wider and heavier than the proportional face.
       The lead sizes above body live on their own surfaces (.hd .title, .stat .n)
       because only one surface has a lead. */
    --t-micro: 10.5px;
    --t-data: 11px;
    --t-body: 11.5px;
    --t-title: 13.5px;

    /* One radius per role, one family. Squarer than before: with the tinted lane
       field gone there is no longer a container whose radius must exceed the cards
       standing in it, and the board reads as an instrument rather than an app. */
    --r-card: 6px;
    --r-ctl: 5px;
    --r-chip: 4px;
```

And the two line values (keep `--mono` and `--dim` untouched):

```css
    /* A hairline the theme cannot lose: panelBorder disappears against a card
       ground, which is already lifted off the editor background. */
    --hair: color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
    --edge: color-mix(in srgb, var(--vscode-foreground) 14%, transparent);
```

- [ ] **Step 6: Run the full gates**

Run: `npm run typecheck` then `npm test` (tool timeout `600000`) then `npm run build`.
Expected: all pass. The sidebar and Marketplace consume these tokens, so a failure here is a real cross-surface regression, not a Deck problem — read the failing assertion before changing anything.

- [ ] **Step 7: Commit**

```bash
git add src/webview/tokens.ts test/webview/tokens.test.ts
git commit -m "refactor(webview): widen the type scale and quieten the resting hues"
```

---

### Task 2: Header and column heads

**Files:**
- Modify: `src/webview/deckStyles.ts` — `.hd` / `.hd .title` / `.hd .title .sub` (~lines 36–45), `.stats` / `.stat` / `.stat .n` / `.stat .l` (~lines 46–60), `.stat.attn` / `.stat.up` (~lines 61–70), `.col-hd` and children (~lines 104–130)

**Interfaces:**
- Consumes: Task 1's `--t-*`, `--r-*`, `--hair`, `--edge`.
- Produces: nothing later tasks read. `.col-hd`'s flex `order` values are local to that rule.

- [ ] **Step 1: Strip the chrome from the stat tiles**

`.stat` loses its border and ground; `.stat.attn` keeps its outline; `.stat.up` loses its outline and keeps its green ink. Replace the `.stats` / `.stat` / `.stat .n` / `.stat .l` rules and the `.stat.up` border line:

```css
  .stats { display: flex; flex-wrap: wrap; align-items: stretch; gap: 2px; }
  /* No border, no ground. Four outlines around four numbers rank nothing against
     anything; the numbers themselves are the tiles. This also wraps better at panel
     widths under ~520px, where four bordered boxes folding read worse than four
     numbers folding. */
  .stat { display: flex; flex-direction: column; gap: 2px; padding: 4px 13px 5px;
    border-radius: var(--r-ctl); border: 1px solid transparent; background: transparent; }
  .stat .n { font-size: 19px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.05;
    letter-spacing: -.03em; }
```

Keep `.stat .n .u` and `.stat .l` as they are apart from `.stat .l`'s size:

```css
  .stat .l { font-size: var(--t-micro); color: var(--dim); letter-spacing: .01em; white-space: nowrap; }
```

`.stat.attn` keeps its border rule verbatim. Delete only the `.stat.up` border line, keeping its `.n` and `.l` colour rules, and say why:

```css
  /* Ink, no outline. An outline is reserved for attention debt, and something ready
     to merge is good news rather than a debt — a second outlined tile would be a
     second claim on the same glance. */
  .stat.up .n { color: var(--c-done); }
  .stat.up .l { color: color-mix(in srgb, var(--c-done) 70%, var(--dim)); }
```

- [ ] **Step 2: Lift the header's lead**

```css
  .hd { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px;
    padding: 14px 20px 13px; border-bottom: 1px solid var(--hair); }
  .hd .title { font-size: 16px; font-weight: 620; letter-spacing: -.02em; white-space: nowrap;
    line-height: 1.3; }
  .hd .title .sub { display: block; color: color-mix(in srgb, var(--vscode-foreground) 45%, transparent);
    font-weight: 400; font-size: 11.5px; letter-spacing: 0; line-height: 1.3; }
```

- [ ] **Step 3: Make the column head a heading, with its count beside its label**

Replace `.col-hd`'s own rule, `.col-hd .nm`, `.col-hd .ct` and `.col-hd .rule`. Leave `.col-hd .dot` and `.dot.glow` untouched apart from the added `order`:

```css
  .col-hd { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 8px;
    padding: 15px 0 8px; flex: none; background: var(--vscode-editor-background); }
  /* Sentence case in the UI font, at full-strength ink: a column head is a heading and
     should be voiced as one. It also gives mono back to identifiers only, which is this
     sheet's own rule #1 — the uppercase-mono label was quietly breaking it.
     The count follows the label rather than sitting past the rule. Right-aligned it
     landed one board gap from the NEXT column's dot, so "7 ● Action required" read as
     one phrase; and the comparable column of counts that position bought is already
     paid for by the header's stat tiles, which are exactly that row. The order values
     are what reseat it, because the count is last in the markup. */
  .col-hd .dot { order: -3; }
  .col-hd .nm { order: -2; font-family: inherit; font-size: 11.5px; font-weight: 600;
    text-transform: none; letter-spacing: -.008em; white-space: nowrap; color: var(--vscode-foreground); }
  .col-hd .ct { order: -1; border: 0; padding: 0; font-size: 11px; font-weight: 500;
    font-variant-numeric: tabular-nums; line-height: 1.3;
    color: color-mix(in srgb, var(--vscode-foreground) 45%, transparent); }
  .col-hd .rule { order: 0; flex: 1; height: 1px; background: var(--hair); }
```

The `.col-hd .dot` rule keeps its `width`/`height`/`border-radius`/`background: var(--zone)` — add `order: -3` to the existing rule rather than declaring a second one.

- [ ] **Step 4: Run the gates**

Run: `npm run typecheck` then `npm test` (timeout `600000`) then `npm run build`.
Expected: all pass. `tokens.test.ts`'s comment-delimiter walk is the one most likely to catch a mistake here — this step writes several prose comments.

- [ ] **Step 5: Look at it**

Run: `node preview/shoot-deck.js /tmp/deck-hd.png 980`
Expected: the header shows four unboxed numbers with only *Action required* outlined; each column head reads `In progress 7` with a hairline running to the column's right edge; no count sits adjacent to the next column's dot.

- [ ] **Step 6: Commit**

```bash
git add src/webview/deckStyles.ts
git commit -m "style(deck): voice the column heads as headings and unbox the stat tiles"
```

---

### Task 3: Column body, card, and the dead accent variable

**Files:**
- Modify: `src/webview/deckStyles.ts` — `.board` (~line 103), `.col-body` (~lines 141–146), `.card` and `.card::before` / `.card.attn::before` / `.card.attn` (~lines 161–176), `.c-title` (~line 265), `.repo .add` / `.repo .del` (~line 279), `.c-diff .add` / `.c-diff .del` (~lines 783–785). `.act` needs **no** edit — it already reads `var(--t-body)` and `var(--r-ctl)`, so it takes Task 1's values for free
- Modify: `src/webview/DeckApp.tsx` — delete line 165 (`const accent = …`) and line 209 (`style={{ ["--accent" as any]: accent }}`)
- Test: `test/webview/tokens.test.ts` — new guard, and `RUNTIME_ONLY` loses `--accent`

**Interfaces:**
- Consumes: Task 1's tokens. `--zone`, set per board column at runtime, stays and is now the *only* carrier of column hue on the board surface.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Append to `test/webview/tokens.test.ts`:

```ts
describe("per-card accent", () => {
  // The card rail is gone: the column body's rail states the zone once, and the one
  // card that needs you says so with an amber border and wash. A custom property
  // still set on every card that no rule reads is dead weight nothing else can see
  // — tsc does not flag it (noUnusedLocals is off), and no rendering test would
  // notice. This asserts producer and consumer went together.
  it("is set by nobody now that no rule reads it", () => {
    expect(DECK_CSS).not.toContain("--accent");
    const app = readFileSync(join(__dirname, "../../src/webview/DeckApp.tsx"), "utf8");
    expect(app).not.toContain("--accent");
  });
});
```

Add the two imports at the top of the file if absent:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/webview/tokens.test.ts -t "is set by nobody"`
Expected: FAIL on the first assertion — `DECK_CSS` still contains `--accent` in the `.card::before` rule.

- [ ] **Step 3: Delete the card rail and reground the card**

Replace the `.card` rule, and **delete** `.card::before` and `.card.attn::before` entirely along with the comments describing the rail. Keep `.card:hover`, `.card.attn:hover` and `.card:focus-within` as they are:

```css
  /* \`flex: none\` is load-bearing: .card sets overflow:hidden, which zeroes its automatic
     minimum size — without it the flex column squeezes every card and clips its content
     instead of growing the column. (overflow:hidden originally existed to clip the accent
     rail; the rail is gone, but the clip still guards long unbreakable content, so both
     declarations stay.) */
  .card { position: relative; flex: none; border: 1px solid var(--hair); border-radius: var(--r-card);
    background: color-mix(in srgb, var(--vscode-foreground) 3%, var(--vscode-editor-background));
    padding: 10px 12px 9px; overflow: hidden;
    transition: border-color .12s ease, background-color .12s ease; }
  /* The one card asking for you, and now the only card on the board wearing a hue at
     all: an amber border and a wash, with the column's own rail behind it. */
  .card.attn { background: color-mix(in srgb, var(--c-attn) 6%, var(--vscode-editor-background));
    border-color: color-mix(in srgb, var(--c-attn) 58%, var(--hair)); }
```

- [ ] **Step 4: Turn the zone field into a rail**

Replace `.col-body` and `.board`'s gap. Replace the long "zone tint" comment — it argues for a field that no longer exists:

```css
  .board { flex: 1; min-height: 0; display: flex; align-items: flex-start; gap: 18px;
    padding: 0 20px 20px; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
  /* The zone, stated once. A rail you can trace from the column head to the last card
     replaces the flat tint behind them: the tint had to stay so faint to avoid fighting
     the cards that it barely read at all, and it was the third statement of the same
     hue after the head's dot and the card's own rail. It also gives every column a hard
     left edge, which is what stops a right-hand neighbour's content from reading as
     part of this column. Sits on .col-body, not .col, so it starts under the sticky
     header instead of scrolling out from behind it. */
  .col-body { display: flex; flex-direction: column; gap: 8px; padding: 6px 0 10px 12px;
    border-left: 1px solid color-mix(in srgb, var(--zone) 40%, transparent); }
```

- [ ] **Step 5: Set the card's title and neutralise the diff counts**

`.c-title` in full — the `-webkit-line-clamp` half is load-bearing (it is what caps a title at
two lines) and must survive the edit, so here is the whole rule rather than the changed half:

```css
  .c-title { margin-top: 5px; font-size: var(--t-title); font-weight: 560; line-height: 1.36; letter-spacing: -.012em;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
```

Weight rises 550 → 560 and leading tightens 1.42 → 1.36: at 13.5px the old leading left the two
clamped lines reading as two separate rows rather than one title.

Then both diff-count pairs. `.repo .add` / `.repo .del` (~line 279) and `.c-diff .add` / `.c-diff .del` (~lines 784–785):

```css
  /* Neutral ink, with the sign carried by the glyph. Green on the board means a live
     agent or a mergeable branch; spending it on "lines added" made one hue mean three
     things on one screen. Removed counts sit quieter than added ones because a deletion
     count is the less load-bearing of the two, not because it is a warning. */
  .repo .add, .c-diff .add { color: color-mix(in srgb, var(--vscode-foreground) 78%, transparent); }
  .repo .del, .c-diff .del { color: color-mix(in srgb, var(--vscode-foreground) 55%, transparent); }
```

Delete the now-duplicated `.c-diff .add` / `.c-diff .del` declarations at their old site, keeping `.c-diff`'s own layout rule.

- [ ] **Step 6: Remove the dead accent producer**

In `src/webview/DeckApp.tsx`, delete the `const accent = \`var(${col.varName})\`;` line and the `style={{ ["--accent" as any]: accent }}` prop on the card `div`. Check that `col` is still read by something else in the component before deleting anything else — it is, for the zone.

Then in `test/webview/tokens.test.ts`, drop `--accent` from `RUNTIME_ONLY` and correct the comment above it so it names only `--zone`.

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run test/webview/tokens.test.ts`
Expected: PASS, whole file.

- [ ] **Step 8: Run the gates**

Run: `npm run typecheck` then `npm test` (timeout `600000`) then `npm run build`.
Expected: all pass. If a Deck test asserts on `--accent` or on a rail, stop — that is a released-behaviour signal, not a test to edit.

- [ ] **Step 9: Commit**

```bash
git add src/webview/deckStyles.ts src/webview/DeckApp.tsx test/webview/tokens.test.ts
git commit -m "style(deck): state the zone once, as a column rail"
```

---

### Task 4: Verify by eye, in both themes and at panel width

Nothing in this pass is visible to jsdom. This task is the actual test.

**Files:**
- Modify: `CHANGELOG.md` (one entry under `## [Unreleased]`)

**Interfaces:**
- Consumes: the built `dist/deck.js` from Task 3's `npm run build`.
- Produces: nothing.

- [ ] **Step 1: Shoot the board in both themes**

```bash
npm run build
node preview/shoot-deck.js /tmp/deck-dark.png 980
```

Then open `preview/agent-flow-deck.html?theme=light` in a browser, or shoot it:
`node preview/shoot-any.js preview/deck-head.html /tmp/deck-light.png light`

Check, against the spec: exactly one card wearing a hue; each column bounded by a traceable rail; four unboxed header numbers with only *Action required* outlined; diff counts neutral; column heads sentence case with the count beside the label.

- [ ] **Step 2: Check the desaturated hues on a light theme specifically**

The chroma scaling is the one new mechanism in this pass. On the light shot, confirm each column's dot and rail is still *identifiable* as its own hue — blue, amber, purple, green — and that the green rail has not faded to invisibility. If any has, raise the multiplier from `.78` toward `.85` **for all four together**, never one hue alone: they are a set and drifting one is how a near-miss palette starts.

- [ ] **Step 3: Check the panel at narrow width**

```bash
node preview/shoot-narrow.js preview/deck-head.html /tmp/deck-narrow.png 520
```

Expected: the header folds into stacked bands; the unboxed numbers wrap without leaving orphaned outlines; no column head's rule collapses to zero width.

- [ ] **Step 4: Check it in a real editor window**

Press **F5** ("Run Agent Flow Deck"), or launch with VS Code's own `code --extensionDevelopmentPath=…` — the Cursor CLI silently drops that flag. Open the Deck on a real board and confirm: the amber card still reads as the loud one against your actual theme's ground, and hover/focus borders still register now that `--hair` is a foreground mix rather than `panelBorder`.

- [ ] **Step 5: Note the metric caveat, then add the changelog entry**

The tracking values (`-.012em`, `-.02em`, `-.03em`) were tuned on macOS SF. If a Windows or Segoe-UI environment is available, check the header lead and card title there before calling the tracking final; if not, record that it is unverified rather than implying it was checked.

Add under `## [Unreleased]` in `CHANGELOG.md`:

```markdown
### Changed
- The Deck's type scale, palette and spacing: a wider scale with a real lead, column heads voiced as headings with the count beside the label, the column's hue stated once as a rail rather than three times, resting status hues dropped to ~78% chroma so the one card that needs you is the only saturated thing on the board, and diff counts in neutral ink.
```

- [ ] **Step 6: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for the Deck type and colour pass"
```

---

## Known consequence: literals on the other two surfaces

Token *values* are shared, so the sidebar and the Marketplace pick up 10.5 / 11 / 11.5 / 13.5
wherever they read a `--t-*` token. Their own **literals** do not move: `styles.ts` has
grandfathered `10px`, `13px` and others on the allowlist above, and those rules will now sit half
a pixel off the token-driven text beside them. That is the accepted cost of "tokens shared, Deck
first" — visible only on those two surfaces, and only to someone measuring. Closing those
literals is the follow-up pass, not a fix to make here; converting them mid-pass would put the
sidebar's whole type scale in a diff that nobody rendered.

## Out of scope, recorded

- The footer legend restates four column colours already on screen. Removing it is anatomy.
- Propagating the new scale and hues into the sidebar and Marketplace *sheets*; they already inherit the token values.
- A bundled typeface plus the `font-src` CSP change, judged on metric stability rather than letterforms.
