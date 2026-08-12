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

    /* The one fixed hue in the product. Measured 5.57:1 on the dark editor ground
       and 6.00:1 on the dark sidebar; the light variant exists because #2AA79B on
       white is 2.96:1, which fails. */
    --brand: #2AA79B;
    --brand-ink: #04211E;
  }

  /* VS Code stamps the theme kind onto <body>, so the swap needs no JavaScript. */
  body.vscode-light { --brand: #157F76; --brand-ink: #ffffff; }
  /* No high-contrast override: currentColor, used outside the color property
     itself, would resolve a filled button's background to its own label color.
     The hue already measures 7.10:1 on #000000 and 4.85:1 on #ffffff, so it
     needs no opt-out. */
`;

// box-sizing and the reduced-motion query were common to all three surfaces;
// the button reset and :focus-visible outline were deckStyles.ts's alone,
// unified here on purpose — the sidebar and Marketplace had no keyboard focus
// indicator before this.
export const BASE_CSS = `
  * { box-sizing: border-box; }
  button { font: inherit; color: inherit; }
  :focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; border-radius: 4px; }
  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; animation: none !important; }
  }
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
