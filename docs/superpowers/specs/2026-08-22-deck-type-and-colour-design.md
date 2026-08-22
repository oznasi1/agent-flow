# Deck redesign: type and colour

**Date:** 2026-08-22 · **Surface:** the Deck (`In-flight`) · **Status:** design approved, not implemented

A visual pass over the Deck's typography and colour. No card or column anatomy changes: every
decision below is reachable in CSS through type, colour, spacing and radii alone, which is how
the directions were mocked (override sheets over the real bundle) and therefore how they are
known to be reachable.

## Scope

**In:** the type scale, the status palette, spacing, radii, and where colour is spent, in
[src/webview/tokens.ts](../../../src/webview/tokens.ts) (values only) and
[src/webview/deckStyles.ts](../../../src/webview/deckStyles.ts) (rules).

**Out, deliberately:**

- **Card and column anatomy.** What a card shows, in what order, stays exactly as it is.
- **A bundled typeface.** Decided against — see *The font question* below.
- **The sidebar and the Marketplace.** Token *values* are shared, so they inherit the new
  scale and hues; their own sheets are not restyled in this pass. Judge one surface at a time.
- **The footer legend**, which restates four column colours already on screen, and the
  `--accent` runtime variable this design leaves unused. Both noted under *Follow-ups*.

## What the redesign answers

Rendered from the real webview at 1340×720 @2x with a full board (`preview/build-typo.js`,
gitignored). Findings, in descending order of how much they cost the reader:

1. **Four type steps inside a 3px range** (10 / 10.5 / 11 / 13). Hierarchy therefore rests
   almost entirely on colour and weight; a card title barely outranks its own metadata.
2. **Green means three things at once** on one screen — the Merge column, a live agent, and
   `+173` added lines.
3. **Boxes inside boxes.** A tinted lane field, a bordered card inside it, radii stepping
   10 → 8 → 6 → 5 with no rule about which nests in which.
4. **The zone hue is stated three times** — column dot, tinted field, per-card accent rail.
5. **Uppercase mono column heads** spend mono on English, which is
   [deckStyles.ts](../../../src/webview/deckStyles.ts)' own documented rule #1.
6. **Four bordered stat tiles** in the header: four outlines around four numbers, none of
   which is more urgent than the others by that treatment.

A correction to an earlier reading of #1: `--t-micro` and `--t-data` sit half a pixel apart,
which looks like noise but is not. Nine of the fourteen `--t-data` rules pair it with
`var(--mono)`, and most of the rest are containers whose children are mono — `--t-data` is the
*monospace* step and `--t-micro` the proportional one. Monospace at the same nominal size reads
wider and heavier, so the half-pixel is a real optical correction. **Both steps survive.** What
does not survive is the 3px total range.

## The design

### Type

| Token | Was | Now | Role |
|---|---|---|---|
| `--t-micro` | 10px | **10.5px** | proportional micro-labels |
| `--t-data` | 10.5px | **11px** | monospace identifiers and counts |
| `--t-body` | 11px | **11.5px** | card body, status, controls |
| `--t-title` | 13px | **13.5px** | card title |
| — | — | **16px** (`.hd .title`, local) | the panel's lead |
| — | — | **19px** (`.stat .n`, local) | the header's lead figure |

The scale gains its range at the top, not the bottom: the 19px stat figure is what makes 13.5px
read as a title rather than as slightly-larger body. Tracking tightens as size grows
(`-.012em` on the card title, `-.03em` on the stat figure, `-.02em` on the header lead), which
is the one thing a fixed 3px range made pointless.

**Mono stays the user's editor font.** Identifiers, branches and diff counts came out of the
editor; they should look like it.

### Colour

Three rules, in priority order:

1. **One card at a time gets to be loud, and the loud one is amber.** Unchanged in principle —
   `--c-attn` keeps its measured `#e0913a` / `#a85c00` pair and its documented reason for not
   tracking `charts.orange`. What changes is everything around it getting quieter, so the rule
   actually bites.
2. **Resting hues recede.** The four column hues stay derived from the host's chart palette —
   never hard-coded — and lose roughly a fifth of their chroma:

   ```css
   --c-progress: var(--vscode-charts-blue, #4aa3df);
   --c-progress: oklch(from var(--vscode-charts-blue, #4aa3df) l calc(c * .78) h);
   ```

   Two declarations on purpose. The relative-colour form shipped in Chromium 119 and the
   manifest floor is VS Code `^1.90.0` (Chromium 122), so it resolves everywhere we support —
   but an editor that cannot parse it drops the second declaration and keeps a working hue
   rather than an unset variable. Chroma scaling in oklch is what keeps the hue theme-aware in
   *both* directions; mixing toward the foreground would lighten on dark themes and darken on
   light ones, which is not the same thing as quieter.

   > The mockups cheated here — they hard-code dark-tuned hexes (`#6f9dc9` and friends). On a
   > light theme those are simply wrong, which the light-theme render shows. The derived form
   > above is what ships, and it needs its own light-theme check.

3. **Diff counts go neutral.** `.c-diff .add` / `.repo .add` take
   `color-mix(in srgb, var(--vscode-foreground) 78%, transparent)` and the removed counts 55%,
   with the sign carried by the glyph. Green then means alive-or-merged and nothing else.

### Structure, spacing, radii

- **The zone is stated once**, as a rail you can trace: `.col-body` takes
  `border-left: 1px solid color-mix(in srgb, var(--zone) 40%, transparent)` and loses its
  tinted field; `.card::before` (the per-card accent rail) goes. The column dot stays, because
  the footer legend names it.
- **`.card.attn` carries the signal alone** — a 58%-amber border and a 6% amber wash. It is the
  only card on the board with a hue.
- **Radii collapse to one family:** `--r-card` 10 → **6**, `--r-ctl` 6 → **5**, `--r-chip`
  5 → **4**. Squarer reads as instrument rather than consumer app, and with the lane field gone
  there is no longer a container whose radius has to exceed the cards inside it.
- **Hairlines get their own value:** `--hair` moves from `var(--vscode-panel-border)` to
  `color-mix(in srgb, var(--vscode-foreground) 12%, transparent)`, and `--edge` 16% → 14%.
  `panelBorder` disappears against a card ground in several stock themes.
- **Board gap** 12 → 18px, so the columns read as separate objects now that they have rails.

### The two header fixes

- **The count follows its label** — "In progress 7" — instead of sitting at the column's right
  edge. Right-aligned and without its pill, the count lands one gap from the *next* column's
  dot, so "7 ● Action required" reads as one phrase. The comparable row of counts that the
  right edge was buying is already paid for by the header's stat tiles: that is literally what
  they are. Column heads also leave mono and uppercase for sentence case in the UI font at
  11.5px/600.
- **The stat tiles lose their borders and grounds.** Only `.stat.attn` keeps an outline,
  because it is the one tile whose value should ever interrupt you. This improves at narrow
  widths, where four bordered boxes wrapping read worse than four numbers wrapping.

  `.stat.up` — a nonzero Merge count — **keeps its green ink and loses its outline.** It never
  appeared in the mockups (Merge was 0 in the fixture, and `.stat.up` out-specifies the
  borderless `.stat` rule, so it would have kept its border silently). The rule it has to obey
  is the board's own: an outline is reserved for attention debt, and something ready to merge
  is good news, not a debt. A second outlined tile is a second claim on the same glance.

## The font question

Rejected: bundling a typeface, this pass.

The three directions were first mocked with Inter, Geist and IBM Plex Sans — and none of them
applied. `html { --vscode-font-family: … }` loses to the head's `:root { … }` on specificity
regardless of document order, so all three renders were the host font at different sizes. Once
fixed and measured on the same crop:

| Comparison | Sampled pixels differing |
|---|---|
| today → this design, host font | **11.1%** |
| this design, host font → Geist | 8.9% |
| this design, Geist → Inter | 8.3% |

The whole visible win is the scale, the palette and the spacing. Inter is dominated outright —
73KB and a CSP change to arrive at something indistinguishable from the host font. Geist is the
only face that pays for itself visually, and marginally.

The honest argument for bundling was never letterforms: it is **metrics**. A scale tuned on
macOS SF is a different scale on Windows Segoe UI and on whatever Cursor inherits. That
argument stands, and it is a separate, reviewable pass — it also needs
`font-src` added to the CSP in [src/deckView.ts:3666](../../../src/deckView.ts#L3666), which
today is `default-src 'none'` with no font source, so `@font-face` is refused even from a data
URI.

Two consequences to carry forward: **the tuned tracking above is only as reliable as the host's
metrics**, and this design must be eyeballed on Windows or in a Segoe-UI environment before the
tracking values are treated as final.

## Gate impact

- **`test/webview/tokens.test.ts` needs no edit.** Every token touched is already in `OWNED`;
  only values change. The pinned assertions (`--c-attn: #e0913a`, its light override, the
  `--brand` pair, "no `--brand` inside a `.attn` selector") all still hold, since no `--brand`
  usage moves and the amber card takes no teal.
- **`test/unit/compat.test.ts`:** untouched. No SecretStorage key, state key, setting, command
  id, telemetry value or on-disk run shape changes.
- **The comment-delimiter scan** applies to every sheet edit — the prose comments in these
  files have silently eaten rules three times.
- **Coverage thresholds** are unaffected by CSS-only changes, but any rule whose selector no
  longer exists (`.card::before`) must actually be deleted rather than zeroed, so the sheet
  does not accumulate dead rules.

## Verification

1. `npm run typecheck && npm test && npm run build` — all four CI steps, with
   `timeout: 600000` on the suite (~4,500 tests, 2+ minutes; longer under contention).
2. `node preview/shoot-deck.js` in **both** themes (`?theme=light`), full board, and
   `node preview/shoot-narrow.js` at 520px — the header wrap and the rails are the fragile
   parts.
3. **A real editor window.** jsdom cannot see any of this, and the amber card's contrast on a
   user's actual theme ground is the one thing a canned mock cannot answer.
4. Light-theme contrast check on the desaturated hues specifically — the chroma scaling is the
   one new mechanism in this pass.

## Follow-ups, not this pass

- `--accent` is set inline in [DeckApp.tsx:209](../../../src/webview/DeckApp.tsx#L209) and, with
  the card rail gone, nothing consumes it. Either the `.attn` card keeps a rail or the inline
  style goes; leaving a dead custom property is the worse of the three.
- The footer legend restates four column colours already visible. Removing it is anatomy.
- Propagating the new scale and hues into the sidebar and Marketplace *sheets* (they already
  inherit the token values).
- A bundled typeface, with the CSP change, judged on metric stability rather than letterforms.
