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
