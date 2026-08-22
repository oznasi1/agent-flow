import { CYCLE_MS } from "./markGeometry";

// The design tokens every webview surface shares. Values moved here verbatim from
// deckStyles.ts, which is the surface they were designed on — the sidebar and the
// Marketplace previously hardcoded their own near-misses of the same hues.
//
// A surface sheet may USE anything declared here and must never REDECLARE it;
// test/webview/tokens.test.ts enforces both directions. --rv-row-h stays in
// deckStyles.ts because only the review strip has rows.
export const TOKENS_CSS = `
  :root {
    /* Column accents / status hues.

       The resting four are derived from the host's chart palette, then dropped to
       ~78% of their chroma. The board's rule is that one card at a time gets to be
       loud and the loud one is amber — which only bites if everything at rest
       recedes; at full chroma a blue column, a green agent dot and a purple review
       rail all shout as loudly as the card that actually needs you.

       Two declarations per hue, on purpose. The plain derived value comes first so
       an engine that cannot parse relative colour keeps a working hue rather than an
       unset variable; the oklch form then scales chroma without touching lightness,
       which is what keeps each hue correct on a light theme as well as a dark one.
       Mixing toward the foreground instead would lighten on dark and darken on
       light, and neither of those is "quieter". */
    --c-progress: var(--vscode-charts-blue, #4aa3df);
    --c-progress: oklch(from var(--vscode-charts-blue, #4aa3df) l calc(c * .78) h);
    /* The one status hue that does NOT track the host's chart palette, because it
       cannot. VS Code registers charts.orange as inheriting from
       minimap.findMatchHighlight rather than carrying a literal default, and the
       stock Cursor Dark theme overrides that to #88C0D044 — pale blue at 27%
       alpha, which composites over the card ground to #3e4d51, a flat grey. A
       var() fallback is no defence: the variable IS defined there, just wrong.
       Amber on a card means one thing, so it is fixed. Measured 6.50:1 on the
       dark editor ground and 7.00:1 on Cursor's. */
    --c-attn:     #e0913a;
    --c-review:   var(--vscode-charts-purple, #b083f0);
    --c-review:   oklch(from var(--vscode-charts-purple, #b083f0) l calc(c * .78) h);
    --c-done:     var(--vscode-charts-green, #4ac26b);
    --c-done:     oklch(from var(--vscode-charts-green, #4ac26b) l calc(c * .78) h);
    --c-idle:     var(--vscode-charts-yellow, #d7a531);
    --c-idle:     oklch(from var(--vscode-charts-yellow, #d7a531) l calc(c * .78) h);
    --c-danger:   var(--vscode-charts-red, #e5534b);

    /* Marketplace taxonomy. A different axis from status: what KIND of thing this
       is, not where it is in a flow. Separate names so the two can't drift. */
    --k-skill:   var(--vscode-charts-blue, #4aa3df);
    --k-command: var(--vscode-charts-green, #4ac26b);
    --k-agent:   var(--vscode-charts-purple, #b083f0);
    --k-hook:    var(--vscode-charts-yellow, #d7a531);
    --k-plugin:  var(--vscode-descriptionForeground);

    /* Ticket taxonomy — the same "what KIND of thing is this" axis as the
       Marketplace block above, for the Tasks list's type marker. Task and
       sub-task share Jira's blue; the glyphs are what separate them.
       --k-bug is a muted red, NOT --c-danger: red on a card means a real
       failure, and a bug ticket is not one. Not --c-attn either — amber on a
       card means exactly one thing, the Highest chip. */
    --k-story:   var(--vscode-charts-green, #4ac26b);
    --k-epic:    var(--vscode-charts-purple, #b083f0);
    --k-task:    var(--vscode-charts-blue, #4aa3df);
    --k-subtask: var(--vscode-charts-blue, #4aa3df);
    --k-bug:     color-mix(in srgb, var(--c-danger) 72%, var(--vscode-foreground));
    --k-other:   var(--vscode-descriptionForeground);

    /* A hairline the theme cannot lose. This was var(--vscode-panel-border), which
       several stock themes set close enough to their editor background that it
       vanished against a card ground — and the card ground is lifted off that
       background by design. Derived from the foreground instead, so it holds its
       weight on light and dark alike. */
    --hair: color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
    /* Controls need an edge that survives sitting on a card, which is already
       lighter than the editor background. Slightly quieter than the 16% it replaced,
       because --hair is no longer the fainter of the two. */
    --edge: color-mix(in srgb, var(--vscode-foreground) 14%, transparent);
    --mono: var(--vscode-editor-font-family, ui-monospace, monospace);
    --dim: var(--vscode-descriptionForeground);

    /* Four steps. Every font-size on every surface is one of these, so a new
       element can't quietly invent a fifth.

       --t-data and --t-micro sit half a pixel apart, and that is deliberate rather
       than a rounding accident: nine of the fourteen --t-data rules in deckStyles.ts
       pair it with var(--mono), so it is the MONOSPACE step, and mono at the same
       nominal size reads wider and heavier than the proportional face. The lead
       sizes above body live on the one surface that has a lead (.hd .title and
       .stat .n in deckStyles.ts) rather than becoming a fifth token nothing else
       would use. */
    --t-micro: 10.5px;
    --t-data: 11px;
    --t-body: 11.5px;
    --t-title: 13.5px;

    /* One radius per role, and one family. Squarer than the set this replaced: with
       the Deck's tinted lane field gone there is no longer a container whose radius
       has to exceed the cards standing inside it, and the board reads as an
       instrument rather than as an app. */
    --r-card: 6px;
    --r-ctl: 5px;
    --r-chip: 4px;

    /* The one fixed hue in the product. Measured 5.57:1 on the dark editor ground
       and 6.00:1 on the dark sidebar; the light variant exists because #2AA79B on
       white is 2.96:1, which fails. */
    --brand: #2AA79B;
    --brand-ink: #04211E;

    /* A provider hue is a different kind of constant than --brand: it names a
       fixed mark that belongs to someone else, not this product's own theme, so
       it does not get a light-mode override — Claude's orange was checked on
       both themes at this exact value and reads correctly on white as well as
       dark. Only Claude gets one: Cursor and GitHub Copilot are black-on-white
       marks with no hue that would survive a dark theme, so their badges take
       the theme's own ink instead (see deckStyles.ts's .pv rule). */
    --p-claude: #D97757;
  }

  /* VS Code stamps the theme kind onto <body>, so the swap needs no JavaScript. */
  body.vscode-light { --brand: #157F76; --brand-ink: #ffffff; }
  /* #e0913a on white is 2.54:1, which fails; this reads 5.00:1. Same reason the
     brand hue above needs a light variant, and the same one-line swap. */
  body.vscode-light { --c-attn: #a85c00; }
  /* No high-contrast override: currentColor, used outside the color property
     itself, would resolve a filled button's background to its own label color.
     The hue already measures 7.10:1 on #000000 and 4.85:1 on #ffffff, so it
     needs no opt-out. */
`;

// The shared reset, plus the primitives every surface draws rather than each
// sheet restating them. box-sizing and the reduced-motion query were common to
// all three surfaces; the button reset and :focus-visible outline were
// deckStyles.ts's alone, unified here on purpose — the sidebar and Marketplace
// had no keyboard focus indicator before this. The loading mark joined for the
// same reason: all three surfaces wait on something.
export const BASE_CSS = `
  * { box-sizing: border-box; }
  button { font: inherit; color: inherit; }
  :focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; border-radius: 4px; }
  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; animation: none !important; }
  }

  /* The loading mark: the product's own logo, running. Shared by all three surfaces
     because all three wait on something. Geometry lives in markGeometry.ts, and each
     dot's animation-delay is set inline by LoadingMark.tsx — that stagger, not any
     transform, is what carries the lit dot round the ring.

     The dots rest LIT and the keyframes dim them, never the other way round: the rule
     above kills the animation outright under reduced motion, and a rule that rested
     dim would freeze into an all-but-invisible mark. */
  .lmark { flex: none; display: block; }
  /* Pairs the mark with the line of text that says what is being waited on. The mark
     is display:block, so a bare svg beside text would sit on the baseline and jitter
     the line height; this keeps the two centred on each other. */
  .lrow { display: flex; align-items: center; gap: 7px; }
  /* Identical to ".gauge .tex" in styles.ts on purpose — same dots, same coordinates,
     so they must look the same. Change one and change the other. */
  .lmark .tex { fill: currentColor; opacity: .85; }
  .lmark .ldot { fill: var(--brand); opacity: .9; animation: mark-comet ${CYCLE_MS}ms linear infinite; }
  @keyframes mark-comet { 0% { opacity: 1; } 8% { opacity: .58; } 16% { opacity: .3; } 30%, 100% { opacity: .12; } }
`;

// One control language, shared by the sidebar and the Marketplace. Derived from
// the Deck's .ctls/.ctl rules; the Deck itself still carries its own copy, and
// migrating it is deliberately out of scope for this pass.
//
// The on-state is weight and foreground, never a fill: six filled slabs in a row
// signal nothing, and a filled pill next to a teal Take reads as two primaries.
export const CONTROLS_CSS = `
  .seg { display: inline-flex; flex-wrap: wrap; border: 1px solid var(--edge); border-radius: var(--r-ctl); overflow: hidden; }
  /* A real border, not the inset-shadow separator .ctl uses: that separator strands
     itself at the start of a wrapped row (nothing to sit against). This rule isn't
     wrap-safe either, though — :not(:first-child) is DOM order, not visual row
     position, so a wrapped row's first button still matches and draws its own
     border-left, landing immediately inside .seg's own 1px border. That reads as a
     ~2px-thick left edge on wrapped rows only. Judged the acceptable trade-off: a
     thickened edge on the container's own border reads as one control, where the
     old inset-shadow separator floated free inside a row with nothing beside it. */
  .seg > button:not(:first-child) { border-left: 1px solid var(--edge); }
  .seg > button { font: inherit; font-size: var(--t-body); height: 24px; padding: 0 10px;
    border: 0; border-radius: 0; background: transparent; color: var(--dim);
    cursor: pointer; white-space: nowrap;
    transition: color .12s ease, background-color .12s ease; }
  .seg > button:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
  .seg > button[aria-pressed="true"] { color: var(--vscode-foreground); font-weight: 600;
    background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent); }
  /* .seg clips its children against its own radius, which also clips an outward
     focus ring. Draw it inside instead — an invisible focus ring is not a focus ring. */
  .seg > button:focus-visible { outline-offset: -2px; }
  .seg-label { font-size: var(--t-micro); color: var(--dim); margin-right: 2px; }
`;
