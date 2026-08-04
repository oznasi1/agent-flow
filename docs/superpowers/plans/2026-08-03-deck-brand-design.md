# Agent Flow Deck Brand and Look-and-Feel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Agent Flow Deck one visual identity — a single teal accent spent sparingly (see Global Constraints for the exact, corrected count) and the ring mark reused as a live gauge — by promoting the Deck panel's design grammar into a shared token module that the sidebar and Marketplace also consume.

**Architecture:** A new `src/webview/tokens.ts` owns every design token and the shared reset; the three webview entry points (`index.tsx`, `deck.tsx`, `marketplace.tsx`) append it before their own sheet. The brand hue is a CSS variable with a `body.vscode-light` override, so the theme swap needs no JavaScript — high contrast deliberately gets no override at all (see Global Constraints) and so keeps the same real accent. The gauge is a small presentational component fed one new optional integer on the state message the sidebar host already sends, recomputed on every pool refresh (see Group B's B3 fix).

**Tech Stack:** TypeScript, React 18 (`createRoot`), esbuild, Vitest + Testing Library (jsdom), plain CSS-in-template-string sheets injected via `<style>`. No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-08-03-deck-brand-design.md`](../specs/2026-08-03-deck-brand-design.md) (commit `2b037a6`).

## Global Constraints

- **Accent tokens, exact values.** `--brand: #2AA79B` / `--brand-ink: #04211E` in `:root`; `--brand: #157F76` / `--brand-ink: #ffffff` under `body.vscode-light`. **No high-contrast override** — high contrast gets the real accent. An earlier version of this constraint set `--brand: currentColor` there; that resolves a filled button's `background` to its own `color` (`--brand-ink`), making the label invisible. The hue needs no opt-out: 7.10:1 on `#000000`, 4.85:1 on `#ffffff`, fills at 5.72 and 4.85. Ruled 2026-08-03.
- **The accent may appear in exactly six places:** the sidebar header gauge, the sidebar `Take` button (filled), the sidebar's sticky `.batch-launch` bar, the sidebar's `.gate .btn` (`Sign in to Jira` / `Run setup`), the Deck's ordinary `.act.primary` (tinted outline), and the Marketplace's `Open file` (`.btn.pri`, filled). This list was originally "three places" and omitted `.btn.pri` from day one — a plan defect, not a drift, caught by the final whole-branch review; `.batch-launch` and `.gate .btn` were added by that same review's ruling. Nowhere else — never on the Deck's `.card.attn` in any form, never on a status dot, rail, chip, link, or Marketplace kind color.
- **No new dependencies and no new typefaces.** Fonts stay `var(--vscode-font-family)` and `var(--vscode-editor-font-family)`.
- **Mono is for identifiers and counts only.** Prose is always the UI font.
- **Type scale:** `--t-micro: 10px`, `--t-data: 10.5px`, `--t-body: 11px`, `--t-title: 13px`, plus the 15px surface header. **No task may introduce a new size, and every rule a task rewrites must use a token.** The scale is not yet closed across `styles.ts`, which predates it: these literals live in rules no task in this plan touches, and they stay for now rather than silently resizing text a user reads every day —

  | size | `styles.ts` lines |
  | --- | --- |
  | `8px` | 137 |
  | `9px` | 236 |
  | `11.5px` | 187, 235 |
  | `12px` | 58, 93, 195, 227, 251, 254, 257, 263, 296 |
  | `12.5px` | 242 |
  | `14px` | 95, 126 |

  A reviewer seeing one of these on an **unchanged** line should not flag it; seeing one on a **changed** line should. Closing the scale across the whole sheet is a follow-up, noted in Out of scope.
- **Radii are closed:** `--r-card: 10px`, `--r-ctl: 6px`, `--r-chip: 5px`.
- **Rail hues use Jira `statusCategory` only** — `new` → `--dim`, `indeterminate` → `--c-progress`, `done` → `--c-done`. No fourth rail hue.
- **Priority chip appears for `Highest` only,** in `--c-attn`.
- **Gates on every commit** (`CONTRIBUTING.md`): `npm run typecheck` clean, `npm test` green, `npm run test:cov` above its enforced thresholds (`statements: 90, branches: 85, functions: 85, lines: 90` — `vitest.config.ts:40`), `npm run build` succeeding.
- **Work in the existing worktree** `.claude/worktrees/deck-brand-design` on branch `worktree-deck-brand-design`. Do not `cd` to the main checkout.

---

## File Structure

**Created:**

| path | responsibility |
| --- | --- |
| `src/webview/tokens.ts` | Every design token, the brand triplet and its theme overrides, the shared reset, and (from Task 4) the shared control/button language. The single source; no surface sheet may redeclare what it owns. |
| `src/webview/GaugeMark.tsx` | Presentational ring mark. Takes an optional live count, renders lit/unlit/texture dots, owns its own accessible label. No data fetching, no message handling. |
| `test/webview/tokens.test.ts` | Drift guard: asserts tokens are declared once, in tokens.ts, and that the accent never reaches a forbidden selector. |
| `test/webview/GaugeMark.test.tsx` | Clamping, pluralization, and the static fallback. |

**Modified:**

| path | change |
| --- | --- |
| `src/webview/styles.ts` | Loses its reset; loses every hardcoded fallback hex; sidebar rules rewritten onto the tokens (Tasks 4–5). |
| `src/webview/deckStyles.ts` | Loses its `:root` block (lines 30–67, except `--rv-row-h`, which is Deck-only) and its reset (lines 15–28). `.act.primary` gains the teal tint. |
| `src/webview/marketplaceStyles.ts` | Loses its `:root` and reset; kind hues become `--k-*`; filter chips and `.btn.pri` restyled. |
| `src/webview/index.tsx`, `deck.tsx`, `marketplace.tsx` | Append `TOKENS_CSS` and `BASE_CSS` before the surface sheet. |
| `src/webview/App.tsx` | Header gauge, three segmented controls, rail by status category, priority chip, restyled actions. |
| `src/webview/helpers.ts` | `prioClass` replaced by `railClass` + `isTopPriority`. |
| `src/types.ts:340` | State message gains `liveCount?: number`. |
| `src/tasksView.ts` | `liveWindows()` helper shared by `postState` and `liveWindowItems()`. |
| `test/webview/App.test.tsx` | The header assertion at line 46 stops matching the clipboard emoji. |
| `test/webview/helpers.test.ts` | `prioClass` tests replaced. |
| `media/icon-src.svg`, `icon-store-src.svg`, `icon.png`, `icon-store.png`, `logo.svg`, `logo-light.svg` | Recolored to the brand; PNGs re-rendered at 256×256. The wordmark ships as a dark- and a light-background SVG (Ruled 2026-08-04), not one `currentColor` file. |
| `README.md`, `package.json` | Lockup hero, refreshed screenshots, listing copy. |

**Task-to-commit mapping.** The spec settled four commits; this plan splits them into seven tasks so a reviewer can reject one without rejecting its neighbor. Order is preserved: spec commit 1 = Task 1; commit 2 = Tasks 2–3; commit 3 = Tasks 4–6; commit 4 = Task 7.

---

## Task 1: Extract the shared token module

Extraction, plus one deliberate unification. The acceptance criterion is **no visual change except the two deltas named below** — if anything else differs in a screenshot, something was dropped.

`BASE_CSS` carries four rules, and only `box-sizing` was genuinely present on all three surfaces before this task. `button { font: inherit; color: inherit; }` and the `:focus-visible` outline existed only in `deckStyles.ts`. Sharing them is intentional, and it changes two things on the sidebar and the Marketplace:

- `.gate .btn` (the `Retry` / `Run setup` / `Sign in to Jira` buttons) sets `font-size` but never `font-family`. Form controls don't inherit font, so those buttons rendered in the browser's UA button font and now render in the UI font.
- Every focusable element on those two surfaces gains a keyboard focus outline. Neither surface had one; that is a defect being fixed, not a regression.

Both are approved. A reviewer should confirm they are the *only* behavioral deltas, not object to them.

**Files:**
- Create: `src/webview/tokens.ts`
- Create: `test/webview/tokens.test.ts`
- Modify: `src/webview/deckStyles.ts:14-67` (remove reset + `:root`, keep `--rv-row-h`)
- Modify: `src/webview/styles.ts:3-10` (remove reset)
- Modify: `src/webview/marketplaceStyles.ts:3-21` (remove reset + `:root`)
- Modify: `src/webview/index.tsx:7-9`, `src/webview/deck.tsx:7-9`, `src/webview/marketplace.tsx` (same 3-line block)

**Interfaces:**
- Consumes: nothing.
- Produces: `TOKENS_CSS: string` and `BASE_CSS: string` from `src/webview/tokens.ts`. Every later task imports these by those exact names.

- [ ] **Step 1: Write the failing test**

Create `test/webview/tokens.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { TOKENS_CSS, BASE_CSS } from "../../src/webview/tokens";
import { CSS } from "../../src/webview/styles";
import { DECK_CSS } from "../../src/webview/deckStyles";
import { MARKETPLACE_CSS } from "../../src/webview/marketplaceStyles";

/** The tokens tokens.ts owns. A surface may USE these; none may DECLARE them. */
const OWNED = [
  "--t-micro", "--t-data", "--t-body", "--t-title",
  "--r-card", "--r-ctl", "--r-chip",
  "--c-progress", "--c-attn", "--c-review", "--c-done", "--c-idle", "--c-danger",
  "--k-skill", "--k-command", "--k-agent", "--k-hook", "--k-plugin",
  "--hair", "--edge", "--mono", "--dim",
];

const SURFACES: [string, string][] = [
  ["sidebar", CSS],
  ["deck", DECK_CSS],
  ["marketplace", MARKETPLACE_CSS],
];

const declarationsIn = (sheet: string): string[] =>
  [...sheet.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]);

const usagesIn = (sheet: string): string[] =>
  [...sheet.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1]);

describe("tokens.ts", () => {
  it("declares every token it owns", () => {
    const declared = new Set(declarationsIn(TOKENS_CSS));
    expect(OWNED.filter((t) => !declared.has(t))).toEqual([]);
  });

  it("carries the shared reset, not the tokens", () => {
    expect(BASE_CSS).toContain("box-sizing");
    expect(BASE_CSS).toContain("prefers-reduced-motion");
    expect(declarationsIn(BASE_CSS)).toEqual([]);
  });
});

describe.each(SURFACES)("%s sheet", (_name, sheet) => {
  it("never redeclares a token tokens.ts owns", () => {
    const clashes = declarationsIn(sheet).filter((t) => OWNED.includes(t));
    expect(clashes).toEqual([]);
  });

  it("only uses custom properties that are declared somewhere", () => {
    const local = new Set(declarationsIn(sheet));
    const orphans = [...new Set(usagesIn(sheet))].filter(
      (t) => !t.startsWith("--vscode-") && !OWNED.includes(t) && !local.has(t),
    );
    expect(orphans).toEqual([]);
  });

  it("carries no reset of its own", () => {
    expect(sheet).not.toContain("box-sizing");
    expect(sheet).not.toContain("prefers-reduced-motion");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/webview/tokens.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/webview/tokens"`.

- [ ] **Step 3: Create `src/webview/tokens.ts`**

```ts
// The design tokens every webview surface shares. Values moved here verbatim from
// deckStyles.ts, which is the surface they were designed on — the sidebar and the
// Marketplace previously hardcoded their own near-misses of the same hues.
//
// A surface sheet may USE anything declared here and must never REDECLARE it;
// test/webview/tokens.test.ts enforces both directions. --rv-row-h stays in
// deckStyles.ts because only the review strip has rows.
export const TOKENS_CSS = `
  :root {
    /* Column accents / status hues. */
    --c-progress: var(--vscode-charts-blue, #4aa3df);
    --c-attn:     var(--vscode-charts-orange, #e0913a);
    --c-review:   var(--vscode-charts-purple, #b083f0);
    --c-done:     var(--vscode-charts-green, #4ac26b);
    --c-idle:     var(--vscode-charts-yellow, #d7a531);
    --c-danger:   var(--vscode-charts-red, #e5534b);

    /* Marketplace taxonomy. A different axis from status: what KIND of thing this
       is, not where it is in a flow. Separate names so the two can't drift. */
    --k-skill:   var(--vscode-charts-blue, #4aa3df);
    --k-command: var(--vscode-charts-green, #4ac26b);
    --k-agent:   var(--vscode-charts-purple, #b083f0);
    --k-hook:    var(--vscode-charts-yellow, #d7a531);
    --k-plugin:  var(--vscode-descriptionForeground);

    --hair: var(--vscode-panel-border);
    /* Controls need an edge that survives sitting on a card, which is already 4%
       lighter than the editor background — panelBorder disappears against it. */
    --edge: color-mix(in srgb, var(--vscode-foreground) 16%, transparent);
    --mono: var(--vscode-editor-font-family, ui-monospace, monospace);
    --dim: var(--vscode-descriptionForeground);

    /* Four steps. Every font-size on every surface is one of these, so a new
       element can't quietly invent a fifth. */
    --t-micro: 10px;
    --t-data: 10.5px;
    --t-body: 11px;
    --t-title: 13px;

    /* One radius per role. */
    --r-card: 10px;
    --r-ctl: 6px;
    --r-chip: 5px;
  }
`;

// The reset all three surfaces repeated. Injected after TOKENS_CSS and before the
// surface sheet, so surface rules still win specificity ties.
export const BASE_CSS = `
  * { box-sizing: border-box; }
  button { font: inherit; color: inherit; }
  :focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; border-radius: 4px; }
  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; animation: none !important; }
  }
`;
```

- [ ] **Step 4: Strip the moved rules out of the three sheets**

In `src/webview/deckStyles.ts`: delete the `* { box-sizing }`, `button { font: inherit }`, `:focus-visible`, and `prefers-reduced-motion` rules (lines 15–28), and delete the whole `:root { … }` block (lines 30–67) **except** `--rv-row-h`, which becomes its own small block with its existing comment:

```css
  :root {
    /* Six rows, plus a deliberate half-row peek. Derived, so the intent survives a
       row-height change: --t-body plus .rv-line's 6px padding top and bottom is ~26px. */
    --rv-row-h: 26px;
  }
```

In `src/webview/styles.ts`: delete the `* { box-sizing: border-box; }` rule (line 4), and delete both surface-specific reduced-motion rules — `@media (prefers-reduced-motion: reduce) { .repo-combo, .repo-pop { animation: none; } }` (line 220) and `@media (prefers-reduced-motion: reduce) { .toast { animation: none; } }` (line 270). `BASE_CSS` disables every animation under the same query with `* { animation: none !important }`, which is strictly broader, so both rules are now redundant rather than load-bearing. Keep the `@keyframes` they guard. Leave everything else — Tasks 4 and 5 rewrite it.

In `src/webview/marketplaceStyles.ts`: delete `* { box-sizing: border-box; }` (line 4) and the whole `:root { … }` block (lines 13–21). Then replace each kind-hue usage with its token: `var(--skill)` → `var(--k-skill)`, `var(--command)` → `var(--k-command)`, `var(--agent)` → `var(--k-agent)`, `var(--hook)` → `var(--k-hook)`, `var(--plugin)` → `var(--k-plugin)`.

- [ ] **Step 5: Replace hardcoded fallback hexes with tokens**

In `src/webview/styles.ts`, replace these exact strings so the sidebar stops carrying its own copy of the palette:

| find | replace |
| --- | --- |
| `var(--vscode-charts-green, #3fb950)` | `var(--c-done)` |
| `var(--vscode-charts-yellow, #d29922)` | `var(--c-idle)` |
| `var(--vscode-editorWarning-foreground, #d29922)` | `var(--c-idle)` |
| `var(--vscode-editorError-foreground, #f85149)` | `var(--c-danger)` |
| `var(--vscode-errorForeground, #f85149)` | `var(--c-danger)` |
| `var(--vscode-focusBorder, #4daafc)` | `var(--vscode-focusBorder)` |

- [ ] **Step 6: Append the tokens in all three entry points**

In `src/webview/index.tsx`, replace lines 7–9 with:

```tsx
import { BASE_CSS, TOKENS_CSS } from "./tokens";

// Tokens first, then the reset, then the surface sheet: later sheets must win
// specificity ties against the reset, not the other way round.
for (const css of [TOKENS_CSS, BASE_CSS, CSS]) {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}
```

Apply the same block in `src/webview/deck.tsx` (with `DECK_CSS`) and `src/webview/marketplace.tsx` (with `MARKETPLACE_CSS`). Keep each file's existing `import` for its own sheet.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/webview/tokens.test.ts`
Expected: PASS, 11 assertions.

- [ ] **Step 8: Run the full gates**

Run: `npm run typecheck && npm test && npm run test:cov && npm run build`
Expected: all four succeed; coverage stays above `statements: 90, branches: 85, functions: 85, lines: 90`.

- [ ] **Step 9: Prove zero visual change**

The preview harness is gitignored, so it only exists in the main checkout. Copy it in, then shoot before/after:

```bash
mkdir -p preview && cp /Users/oznasi/dev/agent-flow/preview/*.html /Users/oznasi/dev/agent-flow/preview/*.js preview/
git stash list  # confirm nothing of yours is stashed before comparing
node preview/shoot-deck.js preview/deck-head.html preview/_after-deck.png
node preview/shoot-marketplace.js preview/marketplace-head.html preview/_after-mkt.png
node preview/shoot-narrow.js preview/head.html preview/_after-side.png
```

Open the three PNGs and compare against `media/deck.png` / `media/marketplace.png` / `media/screenshot.png`. Any difference in spacing, hue, or radius means a rule was dropped in Step 4 — find it before committing.

- [ ] **Step 10: Commit**

```bash
git add src/webview/tokens.ts test/webview/tokens.test.ts src/webview/styles.ts \
        src/webview/deckStyles.ts src/webview/marketplaceStyles.ts \
        src/webview/index.tsx src/webview/deck.tsx src/webview/marketplace.tsx
git commit -m "refactor(webview): extract shared design tokens into tokens.ts

The Deck's type scale, radii and status hues now live in one module the sidebar
and Marketplace import too, so a hue can't be redefined three ways. No visual
change; tokens.test.ts guards against redeclaration and orphaned properties."
```

---

## Task 2: Brand tokens and the accent in its three places

**Files:**
- Modify: `src/webview/tokens.ts` (add the brand triplet and theme overrides)
- Modify: `test/webview/tokens.test.ts` (add the brand and forbidden-zone assertions)
- Modify: `src/webview/deckStyles.ts` (`.act.primary`, around line 241)
- Modify: `src/webview/styles.ts` (`.take`, around line 144)
- Modify: `src/webview/marketplaceStyles.ts` (`.btn.pri`, line 32)
- Modify: `preview/*.html`, `preview/shoot-*.js` (theme class — not committed, the directory is gitignored)

**Interfaces:**
- Consumes: `TOKENS_CSS` from Task 1.
- Produces: the CSS variables `--brand` and `--brand-ink`, usable by any later task within the three-place rule.

- [ ] **Step 1: Write the failing test**

Append to `test/webview/tokens.test.ts`:

```ts
describe("brand accent", () => {
  it("declares the dark default and the light override", () => {
    expect(TOKENS_CSS).toContain("--brand: #2AA79B");
    expect(TOKENS_CSS).toContain("--brand-ink: #04211E");
    expect(TOKENS_CSS).toMatch(/body\.vscode-light\s*{[^}]*--brand:\s*#157F76/);
    expect(TOKENS_CSS).toMatch(/body\.vscode-light\s*{[^}]*--brand-ink:\s*#ffffff/);
  });

  // Regression guard. currentColor in any property other than `color` resolves to
  // that element's own color, so `background: var(--brand)` on a filled button
  // would equal its label color and the text would disappear. This nearly shipped.
  it("never resolves the accent to currentColor", () => {
    expect(TOKENS_CSS).not.toContain("currentColor");
  });

  // The board's rule: one card at a time gets to be loud, and the loud one is
  // orange. A teal button inside the attention card would be a second claim on
  // the same attention.
  it("never reaches a .attn selector on the Deck", () => {
    const attnBlocks = [...DECK_CSS.matchAll(/([^}]*\.attn[^{]*){([^}]*)}/g)].map((m) => m[2]);
    expect(attnBlocks.length).toBeGreaterThan(0);
    expect(attnBlocks.filter((b) => b.includes("--brand"))).toEqual([]);
  });

  it("is spent on exactly the three agreed surfaces", () => {
    const users = SURFACES.filter(([, sheet]) => sheet.includes("var(--brand"));
    expect(users.map(([name]) => name).sort()).toEqual(["deck", "marketplace", "sidebar"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/webview/tokens.test.ts`
Expected: FAIL — `expected '…' to contain '--brand: #2AA79B'`.

- [ ] **Step 3: Add the brand triplet to `tokens.ts`**

Inside the existing `:root` block, after the radii:

```css
    /* The one fixed hue in the product. Measured 5.57:1 on the dark editor ground
       and 6.00:1 on the dark sidebar; the light variant exists because #2AA79B on
       white is 2.96:1, which fails. */
    --brand: #2AA79B;
    --brand-ink: #04211E;
  }

  /* VS Code stamps the theme kind onto <body>, so the swap needs no JavaScript. */
  body.vscode-light { --brand: #157F76; --brand-ink: #ffffff; }

  /* No high-contrast override, deliberately. Setting --brand to currentColor there
     looks respectful and breaks the filled buttons: background: var(--brand) would
     resolve to the element's own color — which is var(--brand-ink) — so the label
     would vanish into its own background. The hue needs no opt-out anyway: 7.10:1
     on #000000 and 4.85:1 on #ffffff, with fills at 5.72 and 4.85. */
```

Add `"--brand"` and `"--brand-ink"` to the `OWNED` array in the test file.

- [ ] **Step 4: Spend the accent, three edits only**

`src/webview/deckStyles.ts` — replace the `.act.primary` rest state:

```css
  .act.primary { font-weight: 600;
    background: color-mix(in srgb, var(--brand) 13%, transparent);
    border-color: color-mix(in srgb, var(--brand) 52%, transparent);
    color: color-mix(in srgb, var(--brand) 72%, var(--vscode-foreground)); }
```

Leave `.act.primary:hover` and every `.card.attn .act.primary` rule exactly as they are.

`src/webview/styles.ts` — replace the `.take` fill:

```css
  .take { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600;
    padding: 3px 11px 3px 9px; border-radius: var(--r-ctl); cursor: pointer; border: none;
    background: var(--brand); color: var(--brand-ink);
    transition: background .12s ease; }
  .take:hover { background: color-mix(in srgb, var(--brand) 84%, var(--vscode-foreground)); }
```

Note both changes that ride along: the radius drops from `14px` to `--r-ctl`, and the `transform: translateY(-1px)` hover bounce is gone — the Deck has no bounce, and one button language means one motion language.

`src/webview/marketplaceStyles.ts:32` — replace `.btn.pri`:

```css
  .btn.pri { background: var(--brand); color: var(--brand-ink); border-color: var(--brand); }
  .btn.pri:hover { background: color-mix(in srgb, var(--brand) 84%, var(--vscode-foreground)); }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/webview/tokens.test.ts`
Expected: PASS.

- [ ] **Step 6: Teach the harness about theme classes**

The preview heads declare `--vscode-*` variables but never set a theme class, so `body.vscode-light` would never fire and every light-theme review would show the dark accent. In each of `preview/head.html`, `preview/deck-head.html`, `preview/marketplace-head.html`, change the body tag to `<body class="vscode-dark">` and add this before the closing `</body>`:

```html
<script>
  if (new URLSearchParams(location.search).get("theme") === "light") {
    document.body.className = "vscode-light";
  }
</script>
```

These files are gitignored; they are tooling, not deliverables, so they are not in the commit.

- [ ] **Step 6b: Add a harness script that can shoot any surface**

The existing scripts cannot serve this plan: `shoot-deck.js`, `shoot-marketplace.js` and `shoot-reviews.js` each hardcode a destination inside `media/`, so running one mid-plan would overwrite a committed screenshot with half-branded UI; and `shoot-any.js` / `shoot-narrow.js` both bundle `dist/deck.js`, so **no existing script can shoot the sidebar at all** — `preview/head.html` has never been paired with `dist/webview.js`.

Create `preview/shoot-surface.js` (gitignored tooling, not committed):

```js
// Shoot any one webview surface: pair a preview head with its bundle and write
// wherever you're told. The older scripts each hardcode a media/ destination,
// which makes them unusable for mid-plan review shots.
//
// Usage: node preview/shoot-surface.js <head> <bundle> <dest> [width] [theme]
//   node preview/shoot-surface.js preview/head.html dist/webview.js out.png 380
//   node preview/shoot-surface.js preview/deck-head.html dist/deck.js out.png 1340 light
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const [headFile, bundleFile, dest, width = "1340", theme = "dark"] = process.argv.slice(2);

const head = fs.readFileSync(path.join(root, headFile), "utf8");
const bundle = fs.readFileSync(path.join(root, bundleFile), "utf8");
const page = path.join(root, "preview/_tmp-surface.html");
fs.writeFileSync(page, head.replace("</body>", `  <script>${bundle}</script>\n</body>`));

execFileSync(CHROME, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars",
  "--force-device-scale-factor=2", `--window-size=${width},760`,
  "--virtual-time-budget=5000",
  `--screenshot=${path.join(root, dest)}`,
  `file://${page}${theme === "light" ? "?theme=light" : ""}`,
], { stdio: ["ignore", "ignore", "inherit"] });
console.log(`${dest} ← ${headFile} + ${bundleFile} (${theme})`);
```

If a head's canned data no longer matches its component's props the page will render blank or throw — the Deck head is known to be stale in this way. When that happens, patch the head's mock data locally to satisfy the current props; it is gitignored scratch, so note what you patched in your report rather than committing it.

- [ ] **Step 7: Review the accent on both themes**

```bash
npm run build
node preview/shoot-surface.js preview/deck-head.html dist/deck.js preview/_brand-deck-dark.png 1340
node preview/shoot-surface.js preview/deck-head.html dist/deck.js preview/_brand-deck-light.png 1340 light
node preview/shoot-surface.js preview/head.html dist/webview.js preview/_brand-side-dark.png 380
node preview/shoot-surface.js preview/head.html dist/webview.js preview/_brand-side-light.png 380 light
```

Confirm by eye: the Deck's ordinary `Open` is teal-tinted, the attention card's `Open` is still orange, and the sidebar `Take` is a teal fill with a legible label on both themes. Nothing in `media/` may change — `git status` must show no modified PNGs.

- [ ] **Step 8: Run the full gates**

Run: `npm run typecheck && npm test && npm run test:cov && npm run build`
Expected: all four succeed.

- [ ] **Step 9: Commit**

```bash
git add src/webview/tokens.ts test/webview/tokens.test.ts src/webview/deckStyles.ts \
        src/webview/styles.ts src/webview/marketplaceStyles.ts
git commit -m "feat(webview): add the brand accent and spend it in three places

One teal hue with light and high-contrast overrides, on the sidebar Take, the
Deck's ordinary primary and the Marketplace's Open file. The attention card
keeps orange; a test fails if --brand ever reaches a .attn selector."
```

---

## Task 3: The gauge

**Files:**
- Create: `src/webview/GaugeMark.tsx`
- Create: `test/webview/GaugeMark.test.tsx`
- Modify: `src/types.ts:340`
- Modify: `src/tasksView.ts:143-145` and `:1499-1507`
- Modify: `src/webview/styles.ts` (gauge rules)

**Interfaces:**
- Consumes: `--brand` from Task 2.
- Produces: `GaugeMark({ live?: number, size?: number })` from `src/webview/GaugeMark.tsx`; `liveCount?: number` on the `state` message in `src/types.ts`. Task 4 mounts the component in the sidebar header.

- [ ] **Step 1: Write the failing test**

Create `test/webview/GaugeMark.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import * as React from "react";
import { render, screen } from "@testing-library/react";
import { GaugeMark } from "../../src/webview/GaugeMark";

const lit = (c: HTMLElement) => c.querySelectorAll("circle.lit").length;

describe("GaugeMark", () => {
  it("lights one outer dot per live window", () => {
    const { container } = render(<GaugeMark live={3} />);
    expect(lit(container)).toBe(3);
  });

  it("lights nothing when nothing is in flight", () => {
    const { container } = render(<GaugeMark live={0} />);
    expect(lit(container)).toBe(0);
  });

  it("clamps at the eight outer dots", () => {
    const { container } = render(<GaugeMark live={19} />);
    expect(lit(container)).toBe(8);
  });

  it("names the count for screen readers, singular and plural", () => {
    render(<GaugeMark live={1} />);
    expect(screen.getByRole("img", { name: "1 Agent Flow window open" })).toBeInTheDocument();
    render(<GaugeMark live={4} />);
    expect(screen.getByRole("img", { name: "4 Agent Flow windows open" })).toBeInTheDocument();
  });

  it("falls back to the static six-lit lockup and hides itself when there is no count", () => {
    const { container } = render(<GaugeMark />);
    expect(lit(container)).toBe(6);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("always draws the eight texture dots", () => {
    const { container } = render(<GaugeMark live={2} />);
    expect(container.querySelectorAll("circle.tex").length).toBe(8);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/webview/GaugeMark.test.tsx`
Expected: FAIL — `Failed to resolve import "../../src/webview/GaugeMark"`.

- [ ] **Step 3: Create `src/webview/GaugeMark.tsx`**

```tsx
import * as React from "react";

// The eight large dots of the existing mark (media/agent-flow.svg), in ring order
// starting at twelve o'clock. They carry the count.
const OUTER: [number, number][] = [
  [12, 3.12], [18.28, 5.72], [20.88, 12], [18.28, 18.28],
  [12, 20.88], [5.72, 18.28], [3.12, 12], [5.72, 5.72],
];
// The eight small dots between them. Texture, not data — fixed opacity always.
const INNER: [number, number][] = [
  [15.4, 3.8], [20.2, 8.6], [20.2, 15.4], [15.4, 20.2],
  [8.6, 20.2], [3.8, 15.4], [3.8, 8.6], [8.6, 3.8],
];

/** Dots lit when the host isn't reporting a count — the brand's resting state. */
const STATIC_LIT = 6;

/**
 * The mark, doubling as a gauge. `live` is the number of Agent Flow windows open
 * right now; omit it (the host omits it when trackOpenWindows is off) to get the
 * static lockup. It never animates: the sidebar has no turn state, so a pulse
 * would imply activity this component cannot see.
 */
export function GaugeMark({ live, size = 15 }: { live?: number; size?: number }): JSX.Element {
  const known = live !== undefined;
  const count = known ? Math.max(0, Math.min(live, OUTER.length)) : STATIC_LIT;
  const label = known ? `${live} Agent Flow window${live === 1 ? "" : "s"} open` : undefined;

  return (
    <svg
      className="gauge"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role={known ? "img" : undefined}
      aria-label={label}
      aria-hidden={known ? undefined : true}
    >
      {OUTER.map(([cx, cy], i) => (
        <circle key={`o${i}`} cx={cx} cy={cy} r={2.02} className={i < count ? "lit" : "unlit"} />
      ))}
      {INNER.map(([cx, cy], i) => (
        <circle key={`i${i}`} cx={cx} cy={cy} r={1.21} className="tex" />
      ))}
    </svg>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/webview/GaugeMark.test.tsx`
Expected: PASS, 6 tests.

- [ ] **Step 5: Style the gauge**

Add to `src/webview/styles.ts`:

```css
  /* The mark is the sidebar's status display: lit dots are open Agent Flow
     windows. Unlit and texture dots ride the theme foreground so the ring keeps
     its shape on any background. */
  .gauge { flex: none; display: block; }
  .gauge .lit { fill: var(--brand); }
  .gauge .unlit { fill: currentColor; opacity: .26; }
  .gauge .tex { fill: currentColor; opacity: .4; }
```

- [ ] **Step 6: Write the failing host test for `liveCount`**

Add to `test/webview/App.test.tsx` inside the `mount + auth gate` describe block:

```tsx
  it("reports open windows on the header gauge", () => {
    render(<App />);
    host({ type: "state", authed: true, configured: true, project: "ASM", me: "Jane",
           prReviewStatus: "PR initiated", filters: ALL_FILTERS, liveCount: 2 });
    expect(screen.getByRole("img", { name: "2 Agent Flow windows open" })).toBeInTheDocument();
  });

  it("falls back to the static mark when the host reports no count", () => {
    render(<App />);
    authed();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run test/webview/App.test.tsx -t "open windows"`
Expected: FAIL — TypeScript rejects `liveCount` on the state message, and no `img` role is rendered.

- [ ] **Step 8: Widen the message type**

`src/types.ts:340` — add the optional field at the end. Optional, not required, so the existing `authed()` test helper and every other call site keep compiling:

```ts
  // liveCount is absent when trackOpenWindows is off: the sidebar then shows the
  // static mark rather than claiming zero windows are open.
  | { type: "state"; authed: boolean; configured: boolean; project: string; me: string | null; prReviewStatus: string; filters: FilterVisibility; liveCount?: number }
```

- [ ] **Step 9: Send it from the host**

In `src/tasksView.ts`, add a helper next to `liveWindowItems()` (around line 1499) and make both callers use it, so the count and the picker can never disagree:

```ts
  /** Live Agent-Flow windows other than this one. One source for both the open-target
   * picker and the sidebar's gauge count. */
  private liveWindows(): PresenceRecord[] {
    const self = windowIdentity()?.identity;
    return readLiveWindows(defaultWindowsDir()).filter((w) => w.identity !== self);
  }
```

Rewrite `liveWindowItems()` to start from `return this.liveWindows().map(...)`, dropping its own `self` lookup and `.filter`. Import `PresenceRecord` from `./engine/presence` alongside the existing imports on line 22.

Then in `postState` (line 145), append the field:

```ts
    this.post({ type: "state", authed, configured, project: cfg.project, me,
      prReviewStatus: cfg.prReviewStatus, filters: cfg.filters,
      liveCount: cfg.trackOpenWindows ? this.liveWindows().length : undefined });
```

- [ ] **Step 10: Hold the count in the webview**

In `src/webview/App.tsx`, add the state next to `project` (line 106):

```tsx
  const [liveCount, setLiveCount] = React.useState<number | undefined>(undefined);
```

and set it in the `case "state"` handler (after line 192):

```tsx
          setLiveCount(m.liveCount);
```

The header markup that consumes it lands in Task 4; until then the value is held and unused, which `typecheck` permits because it is read by `setLiveCount`'s own state pair.

- [ ] **Step 11: Render it, so the new tests can pass**

Replace `src/webview/App.tsx:450`:

```tsx
        <span className="title"><GaugeMark live={liveCount} /> {project || "Tasks"}</span>
```

Add the import at the top of the file: `import { GaugeMark } from "./GaugeMark";`

Then fix the existing header assertion at `test/webview/App.test.tsx:46`, which matches the clipboard emoji that no longer exists. `getByText` is a whole-string match, so `"ASM"` finds the header and not the `ASM-1` card key:

```tsx
    expect(screen.getByText("ASM")).toBeInTheDocument(); // header title, not the card key
```

- [ ] **Step 12: Run the tests to verify they pass**

Run: `npx vitest run test/webview/App.test.tsx test/webview/GaugeMark.test.tsx`
Expected: PASS, including the two new cases and the repaired line-46 assertion.

- [ ] **Step 13: Run the full gates**

Run: `npm run typecheck && npm test && npm run test:cov && npm run build`
Expected: all four succeed. If `tasksView.ts` coverage dips, add a host test asserting `postState` omits `liveCount` when `trackOpenWindows` is false.

- [ ] **Step 14: Commit**

```bash
git add src/webview/GaugeMark.tsx test/webview/GaugeMark.test.tsx src/types.ts \
        src/tasksView.ts src/webview/App.tsx src/webview/styles.ts test/webview/App.test.tsx
git commit -m "feat(sidebar): the mark reports open Agent Flow windows

The ring's eight outer dots light one per live window, from a liveCount the host
already had the data for. Absent when trackOpenWindows is off, in which case the
mark renders as the static lockup rather than claiming zero. Never animates —
the sidebar has no turn state to animate against."
```

---

## Task 4: Sidebar chrome — segmented lenses

**Files:**
- Modify: `src/webview/tokens.ts` (add `CONTROLS_CSS`)
- Modify: `src/webview/index.tsx` (append it)
- Modify: `src/webview/styles.ts:24-48` (tabs, sizes, statuses)
- Modify: `src/webview/App.tsx:461-505`
- Modify: `test/webview/tokens.test.ts` (`CONTROLS_CSS` declares nothing)

**Interfaces:**
- Consumes: `TOKENS_CSS`, `BASE_CSS` from Task 1.
- Produces: `CONTROLS_CSS: string` from `tokens.ts`, defining `.seg`, `.seg > button`, and `.seg-label`. Task 6 imports it for the Marketplace.

- [ ] **Step 1: Write the failing test**

Add to `test/webview/tokens.test.ts`:

```ts
import { CONTROLS_CSS } from "../../src/webview/tokens";

describe("CONTROLS_CSS", () => {
  it("defines the segmented control and declares no tokens of its own", () => {
    expect(CONTROLS_CSS).toContain(".seg");
    expect(declarationsIn(CONTROLS_CSS)).toEqual([]);
  });

  it("marks the on-state with weight and foreground, never a fill", () => {
    const on = CONTROLS_CSS.match(/\.seg > button\[aria-pressed="true"\]\s*{([^}]*)}/);
    expect(on).not.toBeNull();
    expect(on![1]).not.toContain("--vscode-button-background");
  });
});
```

And in `test/webview/App.test.tsx`, a behavioural test for the lens:

```tsx
  it("exposes the filter lens as a pressed-state group", () => {
    render(<App />);
    authed();
    const mine = screen.getByRole("button", { name: "Mine" });
    expect(mine).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(mine);
    expect(sent).toHaveBeenCalledWith(expect.objectContaining({ type: "fetch", filter: "mine" }));
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/webview/tokens.test.ts test/webview/App.test.tsx -t "segmented\|pressed"`
Expected: FAIL — `CONTROLS_CSS` is not exported; the buttons have no `aria-pressed`.

- [ ] **Step 3: Add `CONTROLS_CSS` to `tokens.ts`**

```ts
// One control language, shared by the sidebar and the Marketplace. Derived from
// the Deck's .ctls/.ctl rules; the Deck itself still carries its own copy, and
// migrating it is deliberately out of scope for this pass.
//
// The on-state is weight and foreground, never a fill: six filled slabs in a row
// signal nothing, and a filled pill next to a teal Take reads as two primaries.
export const CONTROLS_CSS = `
  .seg { display: inline-flex; border: 1px solid var(--edge); border-radius: var(--r-ctl); overflow: hidden; }
  .seg > button { font: inherit; font-size: var(--t-body); height: 24px; padding: 0 10px;
    border: 0; border-radius: 0; background: transparent; color: var(--dim);
    cursor: pointer; white-space: nowrap;
    transition: color .12s ease, background-color .12s ease; }
  .seg > button + button { box-shadow: inset 1px 0 0 var(--edge); }
  .seg > button:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
  .seg > button[aria-pressed="true"] { color: var(--vscode-foreground); font-weight: 600;
    background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent); }
  .seg-label { font-size: var(--t-micro); color: var(--dim); margin-right: 2px; }
`;
```

Append it in `src/webview/index.tsx`'s loop: `[TOKENS_CSS, BASE_CSS, CONTROLS_CSS, CSS]`.

- [ ] **Step 4: Replace the three lens rows in `styles.ts`**

Delete the `.tabs`, `.tab`, `.sizes`, `.sizes-label`, `.size-chip`, `.statuses`, `.statuses-label` and `.status-chip` rules (lines 24–48) and put in their place:

```css
  .lenses { display: flex; flex-direction: column; gap: 6px; margin: 0 2px 10px; }
  .lens { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
```

The controls themselves now come from `CONTROLS_CSS`. Note the labels lose their uppercase `text-transform` and `.06em` tracking: micro-caps were the sidebar's own invention, and the Deck sets equivalent labels in sentence case.

- [ ] **Step 5: Rewrite the markup**

Replace `src/webview/App.tsx:461-505` with:

```tsx
      <div className="lenses">
        <div className="lens">
          <div className="seg" role="group" aria-label="Task filter">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                aria-pressed={filter === f.id}
                onClick={() => refetch(f.id, size)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {filters.size && (
          <div className="lens">
            <span className="seg-label">Size</span>
            <div className="seg" role="group" aria-label="Size">
              {SIZES.map((s) => (
                <button
                  key={s.id}
                  aria-pressed={size === s.id}
                  title={s.title}
                  onClick={() => refetch(filter, s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {filters.status && availableStatuses.length > 0 && (
          <div className="lens">
            <span className="seg-label">Status</span>
            <div className="seg" role="group" aria-label="Status">
              <button
                aria-pressed={statuses.size === 0}
                title="Any status"
                onClick={() => setStatuses(new Set())}
              >
                All
              </button>
              {availableStatuses.map((s) => (
                <button
                  key={s.name}
                  aria-pressed={statuses.has(s.name)}
                  onClick={() => toggleStatus(s.name)}
                >
                  {s.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/webview/App.test.tsx test/webview/tokens.test.ts`
Expected: PASS. Any failure will be a query that relied on the old class names — fix the query, not the markup, unless the markup genuinely lost an accessible name.

- [ ] **Step 7: Check the narrow panel**

```bash
npm run build
node preview/shoot-surface.js preview/head.html dist/webview.js preview/_seg-narrow.png 300
node preview/shoot-surface.js preview/head.html dist/webview.js preview/_seg-wide.png 480
```

Expected: at 300px the status group wraps as a unit; no button is clipped and no row overflows horizontally. If a group overflows, add `flex-wrap: wrap` to `.seg` rather than shrinking the buttons. Nothing in `media/` may change.

- [ ] **Step 8: Run the full gates**

Run: `npm run typecheck && npm test && npm run test:cov && npm run build`

- [ ] **Step 9: Commit**

```bash
git add src/webview/tokens.ts src/webview/index.tsx src/webview/styles.ts \
        src/webview/App.tsx test/webview/App.test.tsx test/webview/tokens.test.ts
git commit -m "refactor(sidebar): lenses become segmented controls

Three rows of blue-filled pills become three grouped controls whose on-state is
weight and foreground. aria-pressed replaces the .active class, so the state is
now announced rather than only drawn."
```

---

## Task 5: Sidebar card

**Files:**
- Modify: `src/webview/helpers.ts:52-57`
- Modify: `test/webview/helpers.test.ts:28-41`
- Modify: `src/webview/styles.ts` (card, rail, chips, actions, toasts)
- Modify: `src/webview/App.tsx:694-699` and the card header/actions block at `:735-800`

**Interfaces:**
- Consumes: `CONTROLS_CSS` from Task 4, `--brand` from Task 2.
- Produces: `railClass(statusCategory: string | undefined): string` returning `"s-new" | "s-progress" | "s-done"`, and `isTopPriority(priority: string): boolean`, both from `src/webview/helpers.ts`. `prioClass` is removed.

- [ ] **Step 1: Write the failing test**

Replace the `prioClass` describe block in `test/webview/helpers.test.ts` (lines 28–41) with:

```ts
describe("railClass", () => {
  it("maps Jira's three status categories onto the three rail hues", () => {
    expect(railClass("new")).toBe("s-new");
    expect(railClass("indeterminate")).toBe("s-progress");
    expect(railClass("done")).toBe("s-done");
  });

  it("treats an unknown or missing category as not started", () => {
    expect(railClass(undefined)).toBe("s-new");
    expect(railClass("")).toBe("s-new");
    expect(railClass("wat")).toBe("s-new");
  });
});

describe("isTopPriority", () => {
  it("is true for Highest only", () => {
    expect(isTopPriority("Highest")).toBe(true);
    expect(isTopPriority("highest")).toBe(true);
  });

  it("is false for every other level, including High", () => {
    for (const p of ["High", "Medium", "Low", "Lowest", ""]) {
      expect(isTopPriority(p)).toBe(false);
    }
  });
});
```

Update the import on line 2: drop `prioClass`, add `railClass, isTopPriority`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/webview/helpers.test.ts`
Expected: FAIL — `railClass is not a function`.

- [ ] **Step 3: Replace `prioClass` in `helpers.ts`**

Delete `prioClass` (lines 52–57) and add:

```ts
/**
 * The card's left rail answers "where is this in the flow?", the same question the
 * Deck's rail answers — it used to answer "how urgent is this?", which meant the
 * same visual position meant two things across two surfaces. Jira's statusCategory
 * is the only status axis the sidebar receives, so there are exactly three hues.
 */
export function railClass(statusCategory: string | undefined): string {
  if (statusCategory === "indeterminate") return "s-progress";
  if (statusCategory === "done") return "s-done";
  return "s-new";
}

/**
 * Urgency moved off the rail and onto a chip, because a chip can be ignored and a
 * 3px rail cannot. Highest only — flagging High as well made a third of the pool
 * urgent, which is the same as flagging none of it.
 */
export function isTopPriority(priority: string): boolean {
  return (priority || "").toLowerCase() === "highest";
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/webview/helpers.test.ts`
Expected: PASS.

- [ ] **Step 5: Restyle the card in `styles.ts`**

Replace the `.card` block and its priority rules (lines 115–122) with:

```css
  .card { position: relative; border: 1px solid var(--hair); border-radius: var(--r-card);
    background: color-mix(in srgb, var(--vscode-foreground) 4%, var(--vscode-editor-background));
    padding: 9px 11px 9px 14px; overflow: hidden;
    transition: border-color .12s ease, background-color .12s ease; }
  .card::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2px;
    background: var(--rail); opacity: .5; }
  .card.s-new      { --rail: var(--dim); }
  .card.s-progress { --rail: var(--c-progress); }
  .card.s-done     { --rail: var(--c-done); }
  .card:hover { border-color: color-mix(in srgb, var(--vscode-foreground) 25%, transparent); }
  .card:focus-within { border-color: var(--vscode-focusBorder); }
```

Then replace the identifier, chip and action rules:

```css
  /* An identifier: mono, dim, and the link affordance arrives on hover — a blue
     key on every card was six links competing with the one button that matters. */
  .key { font-family: var(--mono); font-size: var(--t-data); color: var(--dim); text-decoration: none; }
  .key:hover { color: var(--vscode-textLink-foreground); }

  /* Urgency, and only at the top level. --c-attn, never --c-danger: an urgent
     ticket is not a broken one. */
  .p-top { font-size: var(--t-micro); font-weight: 600; padding: 0 5px; border-radius: var(--r-chip);
    color: var(--c-attn); border: 1px solid color-mix(in srgb, var(--c-attn) 45%, transparent); }

  /* Repo names are identifiers, so mono; an inferred one wears a ~ rather than
     italics, matching the Deck's ~inferred convention. */
  .svc { font-family: var(--mono); font-size: var(--t-data); padding: 1px 6px;
    border-radius: var(--r-chip); border: 1px solid var(--hair); color: var(--dim); }
  .svc.guess { font-style: normal; opacity: .8; }

  /* Address PR gives up its green: green means Done on the Deck, and a PR waiting
     on you is the opposite of done. */
  .address-pr, .sprint-add, .sprint-remove {
    display: inline-flex; align-items: center; gap: 5px; font-size: var(--t-body); font-weight: 500;
    height: 24px; padding: 0 10px; border-radius: var(--r-ctl); cursor: pointer; white-space: nowrap;
    border: 1px solid var(--edge); background: transparent; color: var(--vscode-foreground);
    transition: background-color .12s ease, border-color .12s ease; }
  .sprint-remove { color: var(--dim); }
  .address-pr:hover, .sprint-add:hover, .sprint-remove:hover {
    background: var(--vscode-toolbar-hoverBackground);
    border-color: color-mix(in srgb, var(--vscode-foreground) 30%, transparent); }
```

And bring the toast in line with the Deck's, replacing the `border-left-width: 3px` treatment and the three `--success/--error/--info` left-border rules:

```css
  .toast { pointer-events: auto; cursor: pointer; display: flex; align-items: flex-start; gap: 8px;
    padding: 8px 11px; border-radius: 7px; font-size: 12px; line-height: 1.4;
    background: var(--vscode-notifications-background, var(--vscode-editorWidget-background, var(--vscode-editor-background)));
    color: var(--vscode-notifications-foreground, var(--vscode-foreground));
    border: 1px solid var(--hair); box-shadow: 0 6px 20px -8px rgba(0,0,0,.5);
    animation: toast-in .16s ease; }
  .toast--success { border-color: var(--c-done); }
  .toast--error   { border-color: var(--c-danger); }
  .toast--info    { border-color: var(--vscode-focusBorder); }
```

- [ ] **Step 6: Rewire the card markup**

`src/webview/App.tsx:695` — swap the rail source:

```tsx
    "card", railClass(task.statusCategory),
```

Update the import on line 4: drop `prioClass`, add `isTopPriority, railClass`.

Then in the card header, immediately after the `.key` anchor (around line 743), add the chip:

```tsx
          {isTopPriority(task.priority) && <span className="p-top" title={`Priority: ${task.priority}`}>Highest</span>}
```

In the services row (around line 795), replace the italic guess marker with the tilde:

```tsx
              <span key={s} className="svc guess" title="Inferred from the ticket, not recorded on it">~{s}</span>
```

- [ ] **Step 7: Add the card behaviour tests**

In `test/webview/App.test.tsx`:

```tsx
  it("rails a card by its status category, not its priority", () => {
    render(<App />);
    authed();
    host({ type: "tasks", filter: "mine", tasks: [
      mkTask({ key: "ASM-1", summary: "Moving", statusCategory: "indeterminate", priority: "Highest" }),
      mkTask({ key: "ASM-2", summary: "Not started", statusCategory: "new", priority: "Low" }),
    ] });
    expect(screen.getByText("Moving").closest(".card")).toHaveClass("s-progress");
    expect(screen.getByText("Not started").closest(".card")).toHaveClass("s-new");
  });

  it("chips only the highest priority", () => {
    render(<App />);
    authed();
    host({ type: "tasks", filter: "mine", tasks: [
      mkTask({ key: "ASM-1", summary: "Urgent", priority: "Highest" }),
      mkTask({ key: "ASM-2", summary: "Ordinary", priority: "High" }),
    ] });
    expect(within(screen.getByText("Urgent").closest(".card")!).getByText("Highest")).toBeInTheDocument();
    expect(within(screen.getByText("Ordinary").closest(".card")!).queryByText("Highest")).not.toBeInTheDocument();
  });
```

Check `test/_helpers/factories.ts` first: if `mkTask` does not already accept `statusCategory` and `priority` overrides, add them there with defaults `"new"` and `"Medium"`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run test/webview/App.test.tsx test/webview/helpers.test.ts`
Expected: PASS.

- [ ] **Step 9: Review both themes and the narrow panel**

```bash
npm run build
node preview/shoot-surface.js preview/head.html dist/webview.js preview/_card-dark.png 380
node preview/shoot-surface.js preview/head.html dist/webview.js preview/_card-light.png 380 light
node preview/shoot-surface.js preview/head.html dist/webview.js preview/_card-narrow.png 300
```

Confirm: no red anywhere on a card, the rail reads as flow position, the `Highest` chip is amber and rare, `Take` is the only filled thing on the card. Nothing in `media/` may change.

- [ ] **Step 10: Run the full gates**

Run: `npm run typecheck && npm test && npm run test:cov && npm run build`

- [ ] **Step 11: Commit**

```bash
git add src/webview/helpers.ts test/webview/helpers.test.ts src/webview/styles.ts \
        src/webview/App.tsx test/webview/App.test.tsx test/_helpers/factories.ts
git commit -m "refactor(sidebar): cards adopt the Deck's grammar

The left rail now means flow position, as it does on the Deck, and urgency moves
to a chip shown for Highest only — so no card is painted red for being important.
Repo chips go mono-outlined with a ~ for inferred, keys go dim mono, and the
secondary actions share one button language."
```

---

## Task 5b: Sidebar polish — three things only rendering revealed

Tasks 4 and 5 were both spec-compliant and both reviews were clean. Rendering the result on
both themes then showed three problems the diffs could not: they are gaps in this plan, not in
the implementations. Approved 2026-08-04.

**Files:**
- Modify: `src/webview/styles.ts:22-29` (`.explore`), `:133-135` (status hues)
- Modify: `src/webview/App.tsx:778-786` (the `Remove` button)
- Modify: `test/webview/App.test.tsx` (the `Remove` query, which loses its visible label)

**Interfaces:** none new.

- [ ] **Step 1: Write the failing tests**

In `test/webview/App.test.tsx`:

```tsx
  it("keeps Remove reachable by name once its label goes", () => {
    render(<App />);
    authed();
    host({ type: "tasks", filter: "mysprint", tasks: [mkTask({ key: "ASM-1", summary: "In sprint" })] });
    const remove = screen.getByRole("button", { name: /Remove ASM-1 from your active sprint/i });
    expect(remove).toBeInTheDocument();
    expect(remove).toHaveTextContent("");
  });
```

Check how the neighbouring sprint tests make `onRemoveFromSprint` available — the button only
renders for a task in the active sprint — and follow that setup rather than inventing one.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/webview/App.test.tsx -t "reachable by name"`
Expected: FAIL — the accessible name currently comes from the `title`, but the button still has
the visible text `Remove`, so `toHaveTextContent("")` fails.

- [ ] **Step 3: `Explore` becomes a neutral outlined action**

Replace `styles.ts:22-29`. The pool has one verb, and it is `Take`; `Explore` is the escape hatch
for when no ticket fits. It gets the same language as the card's secondary actions, including
losing the `translateY` bounce that no other control has any more:

```css
  /* The pool's one filled control is Take. Explore is the way out when no ticket
     fits — useful, not primary — so it takes the secondary language. */
  .explore { display: inline-flex; align-items: center; gap: 5px; margin-left: auto;
    font-size: var(--t-body); font-weight: 500; height: 24px; padding: 0 10px;
    border-radius: var(--r-ctl); cursor: pointer;
    border: 1px solid var(--edge); background: transparent; color: var(--vscode-foreground);
    transition: background-color .12s ease, border-color .12s ease; }
  .explore:hover { background: var(--vscode-toolbar-hoverBackground);
    border-color: color-mix(in srgb, var(--vscode-foreground) 30%, transparent); }
  .explore svg { display: block; }
```

- [ ] **Step 4: The status chip drops its hue**

Replace `styles.ts:133-135`. The rail already carries `statusCategory`, so the chip was encoding
the same fact a second time — and its amber was indistinguishable from the `Highest` chip's, which
is the one thing on a card that has to stand out:

```css
  /* No hue: the rail already says where this ticket is in the flow. Amber on a card
     means exactly one thing, and it is the Highest chip. */
  .status--new, .status--indeterminate, .status--done { color: var(--dim); }
```

- [ ] **Step 5: `Remove` becomes icon-only**

At `App.tsx:778-786`, drop the visible label so three actions fit one row at sidebar widths. The
`title` already carries the full sentence; add `aria-label` so the name does not depend on tooltip
behaviour:

```tsx
            {onRemoveFromSprint && (
              <button
                className="sprint-remove icon-only"
                onClick={(e) => { e.stopPropagation(); onRemoveFromSprint(); }}
                title={`Remove ${task.key} from your active sprint (move it to the backlog)`}
                aria-label={`Remove ${task.key} from your active sprint (move it to the backlog)`}
              >
                <SprintRemoveIcon />
              </button>
            )}
```

Add the square variant beside the shared action rule in `styles.ts`:

```css
  /* Icon-only: a square of the same height, so the row reads as one set of controls. */
  .sprint-remove.icon-only { width: 24px; padding: 0; justify-content: center; }
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/webview/App.test.tsx`
Expected: PASS. Any other test that clicked `Remove` by its visible text now needs the accessible
name instead — fix the query, and say so in the report.

- [ ] **Step 7: Look at it**

```bash
npm run build
node preview/shoot-surface.js preview/head.html dist/webview.js preview/_5b-dark.png 420
node preview/shoot-surface.js preview/head.html dist/webview.js preview/_5b-light.png 420 light
```

Confirm all three: `Take` is the only filled control on the panel, `Highest` is the only amber
thing on any card, and no card's action row wraps. Nothing under `media/` may change.

Note (accepted 2026-08-04): the icon-only `Remove` change tightens the row and removes the empty
gap a wrap used to leave, but a card with all three actions (`Remove`, `Address PR`, `Take`) is
still expected to wrap at 420px — only PR-ready cards carry three actions, and wrapping tightly
with no leftover hole was judged an acceptable outcome rather than a defect to fix. The
"no card's action row wraps" line above is the original criterion, not the accepted result;
don't treat a report of wrapping on a three-action card as a regression.

- [ ] **Step 8: Run the full gates**

Run: `npm run typecheck && npm test && npm run test:cov && npm run build`

- [ ] **Step 9: Commit**

```bash
git add src/webview/styles.ts src/webview/App.tsx test/webview/App.test.tsx
git commit -m "fix(sidebar): one fill, one amber, one action row

Rendering the ported sidebar showed three things the diffs could not. Explore was
still a blue slab and outshouted Take, which is the pool's only verb. The status
chip repeated what the rail already says, in an amber indistinguishable from the
Highest chip. And a three-action card wrapped its buttons, leaving a hole."
```

---

## Task 6: Marketplace deltas

**Files:**
- Modify: `src/webview/marketplace.tsx` (append `CONTROLS_CSS`)
- Modify: `src/webview/marketplaceStyles.ts:44-49` (`.pill`, `.pill.on`) and `:77-81` (`.chip`)
- Modify: `src/webview/MarketplaceApp.tsx:140-146` (the `Pill` component) and `:344-365` (the two rows)

**Interfaces:**
- Consumes: `CONTROLS_CSS` from Task 4.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Add to `test/webview/MarketplaceApp.test.tsx`. This file already has a `host()` bridge at line 13 and an `assetsMsg()` factory at line 42 — use them exactly as its other tests do:

```tsx
  it("exposes the kind filters as a pressed-state group", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    const all = screen.getByRole("button", { name: /^All/ });
    expect(all).toHaveAttribute("aria-pressed", "true");
    const skills = screen.getByRole("button", { name: /^Skills/ });
    expect(skills).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(skills);
    expect(skills).toHaveAttribute("aria-pressed", "true");
    expect(all).toHaveAttribute("aria-pressed", "false");
  });

  it("groups the kind and scope lenses for assistive tech", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    expect(screen.getByRole("group", { name: "Kind" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Scope" })).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/webview/MarketplaceApp.test.tsx -t "pressed-state\|groups the kind"`
Expected: FAIL — no `aria-pressed` attribute and no `group` role.

- [ ] **Step 3: Consume the shared controls**

In `src/webview/marketplace.tsx`, extend the sheet list to `[TOKENS_CSS, BASE_CSS, CONTROLS_CSS, MARKETPLACE_CSS]`.

- [ ] **Step 4: Convert the filter rows**

One edit covers every button, because they all go through one component. Replace `src/webview/MarketplaceApp.tsx:140-146`:

```tsx
function Pill({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <button type="button" aria-pressed={on} onClick={onClick}>
      {children}
    </button>
  );
}
```

Then the two rows. The kind row (line 344) becomes a group wholesale:

```tsx
        <div className="seg" role="group" aria-label="Kind">
```

The scope row (line 355) needs care: `<PluginPicker>` is a dropdown, not a segment, so only the three scope Pills go inside the group and the picker stays a sibling:

```tsx
        <div className="pills">
          <div className="seg" role="group" aria-label="Scope">
            <Pill on={scope === "all"} onClick={() => { setScope("all"); setSel(0); }}>Everywhere</Pill>
            <Pill on={scope === "installed"} onClick={() => { setScope("installed"); setSel(0); }}>Installed only</Pill>
            <Pill on={scope === "enabled"} onClick={() => { setScope("enabled"); setSel(0); }}>Enabled only</Pill>
          </div>
          <PluginPicker
            items={pickerItems}
            selected={pluginSel}
            onToggle={togglePlugin}
            onClear={() => { setPluginSel([]); setSel(0); }}
          />
        </div>
```

Keep the `.pills` wrapper on both rows — it supplies the row's own gap and wrapping.

- [ ] **Step 5: Restyle what the conversion orphaned**

In `src/webview/marketplaceStyles.ts`, delete the `.pill` and `.pill.on` rules (lines 44–49) — `CONTROLS_CSS` now styles those buttons. Add a rule for the count badge that rides inside them, which previously inherited the pill's selected foreground:

```css
  .seg > button .n { margin-left: 5px; color: var(--dim); font-variant-numeric: tabular-nums; }
  .seg > button[aria-pressed="true"] .n { color: var(--vscode-foreground); }
```

Then quiet the removable filter chips at lines 77–81. These are still controls — each one drops a filter when clicked — so they keep `cursor: pointer`; what they lose is the selected-row fill that made them look like the active lens:

```css
  .chip { cursor: pointer; font-family: var(--mono); font-size: var(--t-data); padding: 1px 7px;
    border-radius: var(--r-chip); border: 1px solid var(--hair);
    background: transparent; color: var(--dim); }
  .chip:hover { color: var(--vscode-foreground); border-color: var(--edge); }
```

Leave `.chip.clear` as it is — it already reads as the quiet outlier it should be.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/webview/MarketplaceApp.test.tsx`
Expected: PASS. Existing tests that clicked a pill by name still pass — the accessible name did not change, only the class and the pressed attribute.

- [ ] **Step 7: Review**

```bash
npm run build
node preview/shoot-surface.js preview/marketplace-head.html dist/marketplace.js preview/_mkt-dark.png 1360
node preview/shoot-surface.js preview/marketplace-head.html dist/marketplace.js preview/_mkt-light.png 1360 light
```

Expected: the filter rows read as two grouped controls; `Open file` is the only teal thing on the panel. Do **not** use `shoot-marketplace.js` — it hardcodes `media/marketplace.png` and would overwrite the committed screenshot. Nothing in `media/` may change.

- [ ] **Step 8: Run the full gates**

Run: `npm run typecheck && npm test && npm run test:cov && npm run build`

- [ ] **Step 9: Commit**

```bash
git add src/webview/marketplace.tsx src/webview/marketplaceStyles.ts \
        src/webview/MarketplaceApp.tsx test/webview/MarketplaceApp.test.tsx
git commit -m "refactor(marketplace): filters share the sidebar's control language

Kind and scope rows become segmented groups with aria-pressed instead of
selection-colored pills, and the leftover chips read as labels."
```

---

## Task 7: Assets, copy, screenshots

No tests — these are binary assets and prose. The gate is visual review plus `npm run build`.

**Files:**
- Modify: `media/icon-src.svg`, `media/icon-store-src.svg`, `media/icon.png`, `media/icon-store.png`, `media/logo.svg`
- Create: `media/logo-light.svg` (the light-background wordmark variant, alongside `logo.svg`'s dark one)
- Modify: `media/screenshot.png`, `media/deck.png`, `media/marketplace.png`
- Modify: `README.md:1-16`, `package.json` (`description`)

**Interfaces:**
- Consumes: the finished UI from Tasks 1–6.
- Produces: nothing code-level.

- [ ] **Step 1: Recolor the icon sources**

In `media/icon-src.svg` and `media/icon-store-src.svg`: change the background `rect` fill from `#000000` to `#0E1113`, and split the dot group so six of the eight large dots take `#2AA79B` while the remaining two large dots and all small dots take `#FFFFFF` at `opacity="0.26"`. Six lit, not eight — a fully lit ring reads static, and this product is about work in flight.

Keep both files' existing `viewBox="0 0 100 100"`, the `rx="22"` corner, and the `translate(10,10) scale(0.8)` transform. Only fills change.

- [ ] **Step 2: Re-render both PNGs at their current size**

Both existing files are 256×256; keep that. Write a throwaway wrapper and shoot it with the Chrome the harness already uses:

```bash
for n in icon icon-store; do
  printf '<style>html,body{margin:0}svg{display:block;width:256px;height:256px}</style>' > preview/_ico.html
  cat "media/$n-src.svg" >> preview/_ico.html
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size=256,256 --virtual-time-budget=2000 \
    "--screenshot=media/$n.png" "file://$PWD/preview/_ico.html"
done
node -e 'for(const f of ["media/icon.png","media/icon-store.png"]){const b=require("fs").readFileSync(f);console.log(f,b.readUInt32BE(16)+"x"+b.readUInt32BE(20))}'
```

Expected output: both `256x256`. Then view both at thumbnail size and confirm the dots stay distinct.

- [ ] **Step 3: Re-ring the wordmark, as a two-file lockup**

`media/logo.svg` is the dark-background variant: keep the existing letterform paths untouched, set their fill to the literal `#F0F2F4`, and replace the dot-cluster paths with the brand ring in `#2AA79B`.

Add `media/logo-light.svg`: identical geometry, ring `#157F76` (the light-theme accent — `#2AA79B` measures only 2.96:1 on white), word ink `#16191C`.

Two files, not a `currentColor` fill and not a styled `<h1>`, for two reasons (Ruled 2026-08-04):
- an `<img>`-loaded SVG resolves `currentColor` to black, not the embedding page's ink — the browser treats it as its own document;
- GitHub strips inline `style` attributes from Markdown-embedded HTML, so a tracked `<h1 style="letter-spacing:…">` silently renders as a plain heading.

The README hero (Step 4) serves the two SVGs through a `<picture>` keyed on `prefers-color-scheme` instead.

Do **not** attempt to re-set the word in uppercase with .13em tracking as new outlined text. The letterforms are outlines, and outlining new text needs a font tool this repo does not have — a real tracked SVG wordmark is a separate task needing a font pipeline.

- [ ] **Step 4: Rewrite the listing copy**

`package.json` — replace `description` with a sentence in the Instrument voice: factual, sentence case, no exclamation, naming what the user controls:

```json
  "description": "A task pool in your sidebar. Take a Jira ticket and it opens the repos that ticket touches, with a Claude Code agent already briefed.",
```

`README.md:1-16` — replace the bare `<img src="media/icon.png">` hero with the two-file lockup from
Step 3, served by `<picture>` so each GitHub theme gets its matching variant, and keep the badges and
the screenshot below it:

```html
<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="media/logo.svg">
  <img src="media/logo-light.svg" alt="Agent Flow Deck" width="280">
</picture>

<p><strong>A task pool in your sidebar.</strong> Take a Jira ticket and it opens the repos
that ticket touches, with a Claude Code agent already briefed.</p>
```

Then audit the in-product strings against the same voice, since the spec sets it as a rule for the
whole product rather than only the listing:

```bash
grep -rn "!\"\|Success\|Oops\|Sorry\|Failed to" src/webview/*.tsx src/*.ts | grep -v "\.test\."
```

For each hit, apply the rule rather than a rewrite for its own sake: no exclamation marks; a toast
names the verb that produced it (`Take` → "Taken", never "Success"); a failure says what happened and
what the user is now looking at instead. Leave anything already conforming alone — this is an audit,
not a rewrite pass.

- [ ] **Step 5: Reshoot the three product screenshots**

This is the one task where writing into `media/` is the intent:

```bash
npm run build
node preview/shoot-surface.js preview/head.html dist/webview.js media/screenshot.png 420
node preview/shoot-surface.js preview/deck-head.html dist/deck.js media/deck.png 1340
node preview/shoot-surface.js preview/marketplace-head.html dist/marketplace.js media/marketplace.png 1360
```

Open all three. Every one must show the branded UI — teal `Take`, the gauge in the sidebar header, segmented lenses, no red rail. If any still shows the old chrome, the harness ran a stale `dist/`; re-run `npm run build` and shoot again. If a shot comes out blank, the head's canned data no longer matches its component's props — patch the gitignored head, don't change the component.

Compare each new PNG against the one it replaces before staging: same framing and roughly the same dimensions. A screenshot that silently changed aspect ratio makes the README hero look broken.

- [ ] **Step 6: High-contrast check**

Launch the extension (`F5`), switch VS Code to **Dark High Contrast**, and open both the sidebar and the Deck. Expected: the accent stays teal — there is no high-contrast override (a later ruling reversed an earlier draft's `currentColor` opt-out, which made filled buttons illegible; see Global Constraints). `Take`, `Open file` and the Deck's ordinary primary should all read as legible teal, measuring 7.10:1 on `#000000` and 4.85:1 on `#ffffff`. If a control renders as foreground-ink instead of teal, a rule regressed to the old opt-out.

- [ ] **Step 7: Run the full gates**

Run: `npm run typecheck && npm test && npm run test:cov && npm run build`

- [ ] **Step 8: Commit**

```bash
git add media/icon-src.svg media/icon-store-src.svg media/icon.png media/icon-store.png \
        media/logo.svg media/logo-light.svg media/screenshot.png media/deck.png media/marketplace.png \
        README.md package.json
git commit -m "feat(brand): teal mark, new lockup, refreshed listing and screenshots

Store tile and wordmark carry the accent; the README leads with the lockup and
shows the branded UI. Listing copy names what the user controls rather than what
the extension does internally."
```

---

## Out of scope

- Closing the type scale across all of `styles.ts`. The sixteen off-scale literals listed in Global Constraints live in rules no task here rewrites; converting them changes text sizes a user reads daily and deserves its own review.
- Migrating the Deck's own `.ctl` / `.act` rules onto `CONTROLS_CSS`. The Deck is the reference surface and its markup already ships against those classes; a follow-up can converge them.
- A font-outlined SVG wordmark with the tracked uppercase treatment (needs a font pipeline).
- Teal in the activity-bar icon — VS Code masks view icons to the theme foreground.
- A live gauge on the Deck header; its stat tiles already state those counts.
- The version bump and `.vsix` rebuild, which happen at land time per the repo's release convention.
