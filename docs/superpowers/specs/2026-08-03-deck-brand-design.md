# Agent Flow Deck — brand and look-and-feel

**Date:** 2026-08-03
**Status:** approved design, ready for a plan
**Worktree:** `.claude/worktrees/deck-brand-design`

## Problem

The extension ships three webview surfaces with three visual languages.

- **Deck** ([`src/webview/deckStyles.ts`](../../../src/webview/deckStyles.ts)) is mature: a four-step
  type scale, one radius per role, mono reserved for identifiers, and saturated color spent only on
  attention debt.
- **Sidebar** ([`src/webview/styles.ts`](../../../src/webview/styles.ts)) carries none of it: blue
  filled pills for every lens, 6px cards, badge-filled chips, and a red rail for high-priority
  tickets. It is also the README hero and the first surface a new user sees.
- **Marketplace** ([`src/webview/marketplaceStyles.ts`](../../../src/webview/marketplaceStyles.ts))
  claims to mirror the Deck's grammar and does so halfway.

Separately, the product has no brand presence at all while you use it. Every color is
`var(--vscode-*)`, so the extension is invisibly well-behaved and completely unmemorable. The mark
exists (a ring of sixteen dots) but appears only as a masked activity-bar glyph and a store tile.

## Direction: Instrument

Chosen from three candidates mocked up side by side in `preview/brand-directions.html` (Instrument,
Signal, Ink), reviewed on both Dark Modern and Light Modern.

Control-tower register: precise, monochrome-first, one accent spent rarely. It extends what the Deck
already does instead of fighting it. The two rejected candidates were rejected for specific
measured reasons, recorded here so they are not re-litigated:

- **Signal** (magenta) put a loud primary button inside the orange attention card. The board's
  central rule is that one card at a time gets to be loud.
- **Ink** (no hue) was faultless in-product and vanished in a marketplace grid of a hundred blue
  extension tiles.

## Identity system

### Accent tokens

VS Code sets `vscode-dark` / `vscode-light` / `vscode-high-contrast` on `body`, so the theme swap is
pure CSS:

```css
:root             { --brand: #2AA79B; --brand-ink: #04211E; }
body.vscode-light { --brand: #157F76; --brand-ink: #ffffff; }
```

**High contrast gets the real accent, not an opt-out.** An earlier draft set
`--brand: currentColor` under `body.vscode-high-contrast` on the theory that an HC theme should never
be tinted. That is broken, not merely conservative: `background: var(--brand)` resolves `currentColor`
to the element's own `color`, which is `var(--brand-ink)` — so a filled button's background equals its
label color and the text disappears. It would have shipped invisible `Take` and `Open file` buttons in
the one theme people choose for legibility.

The accent needs no opt-out anyway. Measured on both HC grounds: **7.10:1** on `#000000` and **4.85:1**
on `#ffffff`, with fills at 5.72 and 4.85. Keeping the real hue is both simpler and safer, and it
removes every self-referential `currentColor` from the accent's derivations. Ruled 2026-08-03 after
Task 2's review caught it.

Measured contrast, each pair in the role it actually ships in:

| pair | ratio |
| --- | --- |
| `#2AA79B` on editor dark `#1f1f1f` | 5.57 |
| `#2AA79B` on sidebar dark `#181818` | 6.00 |
| `#157F76` on white | 4.85 |
| `#157F76` on sidebar light `#f8f8f8` | 4.57 |
| `#04211E` label on `#2AA79B` fill | 5.72 |
| white label on `#157F76` fill | 4.85 |

`#2AA79B` on white is 2.96. That is why the light variant exists; it is not a refinement.

### Where the accent may appear

Exactly three places:

1. the sidebar header gauge,
2. the sidebar `Take` button — filled, because it is the pool's one verb,
3. the Deck's ordinary primary `Open` — tinted outline.

Forbidden everywhere else, specifically: the attention card in any form (orange owns attention),
status dots, rails, chips, links, and the Marketplace kind colors.

### Mark

The existing ring stays. Its eight outer dots become a gauge; the eight inner dots stay fixed at 40%
opacity because they are texture, not data.

- Lit dots = `min(liveCount, 8)`.
- Nothing in flight means nothing lit. The mark is allowed to report idle.
- No animation. The gauge is a count, not a pulse (see *Gauge* below for why the breathing dot was
  dropped).
- The activity-bar icon stays `currentColor` monochrome — VS Code masks view icons to the theme
  foreground, so it cannot be teal.

### Wordmark

`AGENT FLOW`, uppercase, .13em tracking, weight 550, set as live text in the UI font. Two variants:
teal ring with foreground text, and an all-mono one for docs.

No new typefaces anywhere. A VS Code panel that ships its own font stops looking native. The Deck's
existing scale becomes canonical for all three surfaces: `--t-micro: 10px`, `--t-data: 10.5px`,
`--t-body: 11px`, `--t-title: 13px`, plus the 15px header. Mono for identifiers and counts only;
prose never.

### Voice

Factual, sentence case, no exclamation. A verb keeps its name through the whole flow — `Take`
produces "Taken", not "Success". Failures state what happened and what the board is showing instead:

> Jira didn't answer. Showing git only — retry to reconcile.

## Shared token module

The host HTML injects no CSS ([`src/deckView.ts:841`](../../../src/deckView.ts)); each webview entry
appends its own `<style>` ([`src/webview/deck.tsx:7-9`](../../../src/webview/deck.tsx)). That is the
seam.

**New `src/webview/tokens.ts`**, two exports:

- `TOKENS_CSS` — the `:root` block: type scale, radii, `--hair`, `--edge`, `--mono`, `--dim`, the six
  status hues, the brand triplet, and the `body.vscode-light` / `body.vscode-high-contrast`
  overrides.
- `BASE_CSS` — `box-sizing`, `button { font: inherit }`, `:focus-visible`, and the
  `prefers-reduced-motion` query. Only `box-sizing` was actually present on all three surfaces
  before this work; the button reset and the focus outline lived in `deckStyles.ts` alone. Sharing
  them is a deliberate unification, not a pure move: the sidebar and the Marketplace gain a
  keyboard focus indicator neither previously had, and the sidebar's gate buttons stop rendering
  in the browser's UA button font. Both approved 2026-08-03.

Each entry (`index.tsx`, `deck.tsx`, `marketplace.tsx`) appends `TOKENS_CSS`, then `BASE_CSS`, then
its own sheet. Order matters: tokens go first so surface rules win specificity ties.

`deckStyles.ts` loses its `:root` and reset and becomes Deck-specific rules only. `styles.ts` and
`marketplaceStyles.ts` stop hardcoding fallback hexes such as `var(--vscode-charts-green, #3fb950)`
and reference `--c-done` instead — one place to change a hue, and no surface can quietly invent a
seventh font size.

The Marketplace's `--skill` / `--command` / `--agent` / `--hook` are a taxonomy, not a status —
a different axis, so they keep their own names but move into tokens as `--k-*` so they cannot drift
either.

**Harness consequence.** The preview heads declare `--vscode-*` variables but never set a theme
class on `body`. The brand override keys off `body.vscode-light`, so every head needs
`class="vscode-dark"` and the `?theme=light` path must swap it. Without this, previews would render
the dark accent on a light ground and every review would be reviewing a lie.

## Sidebar port

The header's clipboard emoji becomes the gauge; everything else is the Deck's grammar applied to
elements that currently invent their own.

| element | today | after |
| --- | --- | --- |
| header | `📋 DEMO` | gauge mark + `DEMO`, user right-aligned |
| filter tabs | 5 loose pills, active = blue fill | one segmented control, active = foreground on `--edge` |
| size / status lenses | 2 more rows of blue-fill pills, uppercase micro-caps labels | segmented controls, sentence-case `--t-micro` labels |
| card | `r=6px`, editor bg, hover → `focusBorder` | `--r-card` 10px, `foreground 4%` mix, hover → `foreground 25%` |
| left rail | priority: **red** / yellow / grey | Jira `statusCategory`: `new` → `--dim`, `indeterminate` → `--c-progress`, `done` → `--c-done` |
| priority | encoded as the rail's hue | a chip, `Highest` only, in `--c-attn` |
| `Take` | blue fill, 14px pill, `translateY(-1px)` bounce | teal fill, `--r-ctl`, no bounce |
| `Address PR` | green outline | neutral `.act` outline |
| sprint add / remove | two bespoke pill styles | the same `.act` language, one weight apart |
| service chips | badge fill, italic when guessed | `--r-chip` outline + mono, `~` prefix when inferred |
| issue key | `textLink` blue | `--dim` mono, link affordance on hover |
| toasts | 3px colored left border | the Deck's full-border toast |

Only three rail hues, because `statusCategory` is the only status axis the sidebar actually receives
— `new`, `indeterminate`, `done`, already used by `.status--*` in `styles.ts`. No `--c-review` rail:
inventing a fourth would mean inferring a state the data does not carry.

**Why the rail flips meaning.** Today hue on that rail answers "how urgent did Jira say this is?"
while the same visual position on a Deck card answers "where is this in the flow?". One has to give,
and the Deck's is the one a user reads all day. Priority becomes a chip because a chip can be
ignored; a 3px rail cannot.

**Why `Address PR` loses its green.** Green means Done on the Deck. A PR waiting on you is not done.

**Files:** `tokens.ts` (new), `styles.ts` (substantial rewrite), `App.tsx` (markup for the segmented
controls, the gauge, the priority chip), `index.tsx` (append tokens).

**Test risk, checked.** `test/webview/App.test.tsx` queries by role and text, not by class — 91 such
queries, no assertions on `p-high` or the pill classes. The restyle is safe; only the
segmented-control markup can break queries, and those break loudly.

## Gauge

The sidebar does **not** know an in-flight count — `App.tsx` holds Jira tasks only. Its host does
know something adjacent and cheap: `readLiveWindows(defaultWindowsDir())` at
[`src/tasksView.ts:1500`](../../../src/tasksView.ts), already called for `liveWindowItems()` and
gated by the `trackOpenWindows` setting (default on).

- The state message `tasksView` already sends gains `liveCount`, from a one-line helper shared with
  `liveWindowItems()` so the count and the picker cannot disagree.
- `trackOpenWindows` off → field absent → the mark renders as the static six-lit lockup.
- Lit dots = `min(liveCount, 8)`; inner eight fixed at 40%.
- Accessibility: `aria-label="3 Agent Flow windows open"` on the live variant, `aria-hidden` on the
  static one.

**No breathing dot.** An earlier draft had one dot pulsing while an agent was mid-turn. The sidebar
has no turn state — that lives in the Deck's session data — so the gauge never animates. It counts
open windows and claims nothing else.

## Deck and Marketplace deltas

**Deck** — deliberately the smallest diff in the plan, because it is the reference:

- `:root` and the reset move to `tokens.ts`.
- `.act.primary` gains the teal tint at rest, replacing today's `foreground 14%` mix
  ([`deckStyles.ts:241-243`](../../../src/webview/deckStyles.ts)).
- The attention card's primary is untouched. Orange keeps it.

No layout change, no new hue on a card.

**Marketplace:**

- reset and `:root` move to `tokens.ts`; kind hues become `--k-skill` … `--k-plugin`.
- filter chips lose the blue fill for the same segmented treatment the sidebar gets.
- `Open file` becomes the teal primary; `Reveal in Finder` stays a neutral `.act`.

## Outward assets

**Store tile.** `icon-src.svg` / `icon-store-src.svg` become the teal ring on graphite, six of eight
outer dots lit — a fully lit ring reads static, and the product is about work in flight. Rasterized
with the Chrome the preview harness already drives, so no new dependency: 128×128 `icon.png` (VS
Code's floor) and 256×256 `icon-store.png`.

**Wordmark, with a stated limitation.** [`media/logo.svg`](../../../media/logo.svg) is traced
outlines, which is why it renders identically on GitHub. It can be recolored and its dot cluster
replaced with the teal ring. It **cannot** be re-set in uppercase with .13em tracking — outlining new
text needs a font tool this repo does not have. A real tracked SVG wordmark is a separate task
needing a font pipeline.

**Two files, not `currentColor` and not a styled heading (Ruled 2026-08-04).** The original plan
was one `currentColor`-filled word plus a CSS-tracked `<h1>` in the README. Both fail for a README
image, one reason each:
- an `<img>`-loaded SVG resolves `currentColor` to black — the browser renders it as its own
  document, not something that inherits the embedding page's ink;
- GitHub strips inline `style` attributes from Markdown-embedded HTML, so a tracked
  `<h1 style="letter-spacing:…">` silently renders as a plain heading.

So the lockup ships as two SVGs, letterforms untouched in both: `logo.svg` is the dark-background
variant (ring `#2AA79B`, word `#F0F2F4`) and
[`media/logo-light.svg`](../../../media/logo-light.svg) is the light one (ring `#157F76` —
`#2AA79B` measures only 2.96:1 on white — word `#16191C`). The README hero serves them through a
`<picture>` keyed on `prefers-color-scheme`, with the product name carried in the `<img>` `alt`.

**README and screenshots.** The lockup replaces the bare icon at the top. `screenshot.png` reshot
after the sidebar port lands; `deck.png` and `marketplace.png` refreshed through the existing harness
so the docs stop showing pre-brand UI.

**Copy.** `package.json` `description` and the README opening rewritten in the Instrument voice. That
string is the marketplace listing, so it changes what shoppers read.

## Verification

Every commit must leave all four of these clean, per `CONTRIBUTING.md`:

- `npm run typecheck`
- `npm test`
- `npm run test:cov` — thresholds are enforced
- `npm run build`

Plus, for this work specifically:

- Screenshot review through the preview harness on **both** themes.
- A narrow-panel shot (`preview/shoot-narrow.js`) — the sidebar is resizable and the segmented
  controls have to survive the squeeze.
- A high-contrast theme check confirming the brand hue disappears entirely.

## Sequencing

Four commits:

1. `tokens.ts` plus all three surfaces consuming it — pure extraction, zero visual change, trivially
   reviewable.
2. Brand tokens, the accent in its three allowed places, gauge and `liveCount`.
3. The sidebar port.
4. Assets, copy, fresh screenshots.

The version bump and a fresh `.vsix` happen at land time per the repo's release convention, not in
these four.

## Out of scope

- A font-outlined tracked SVG wordmark (needs a font pipeline).
- Any new hue on a Deck card, or any change to what the attention card looks like.
- Teal in the activity-bar icon — VS Code masks it.
- Live gauge on the Deck header; the Deck's stat tiles already state those counts.
