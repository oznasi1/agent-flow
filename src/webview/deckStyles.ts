// Injected into the Deck panel <head>. Uses VS Code theme variables so the board
// matches the editor theme (light or dark), with a few semantic status accents.
export const DECK_CSS = `
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    overflow: hidden; }
  #root { height: 100vh; display: flex; flex-direction: column; }
  button { font: inherit; color: inherit; }
  :focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; border-radius: 4px; }
  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; animation: none !important; }
  }

  :root {
    --c-progress: var(--vscode-charts-blue, #4aa3df);
    --c-idle:    var(--vscode-charts-yellow, #d7a531);
    --c-needs:   var(--vscode-charts-red, #e5534b);
    --c-review:  var(--vscode-charts-purple, #b083f0);
    --c-done:    var(--vscode-charts-green, #4ac26b);
    --hair: var(--vscode-panel-border);
    --mono: var(--vscode-editor-font-family, ui-monospace, monospace);
  }

  .hd { flex: none; display: flex; align-items: center; gap: 14px;
    padding: 14px 20px; border-bottom: 1px solid var(--hair); }
  .hd .title { font-size: 15px; font-weight: 600; letter-spacing: -.01em; }
  .hd .title .sub { color: var(--vscode-descriptionForeground); font-weight: 400; margin-left: 6px; font-size: 12px; }
  .stats { display: flex; align-items: stretch; gap: 8px; }
  .stat { display: flex; flex-direction: column; gap: 2px; padding: 4px 12px 5px; border-radius: 8px;
    border: 1px solid var(--hair); background: var(--vscode-editorWidget-background, transparent); min-width: 62px; }
  .stat .n { font-size: 16px; font-weight: 650; font-variant-numeric: tabular-nums; line-height: 1; }
  .stat .l { font-size: 10px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: .05em; }
  .stat.alert { border-color: var(--c-needs); }
  .stat.alert .n { color: var(--c-needs); }
  .hd .sp { flex: 1; }

  .ctl { display: inline-flex; align-items: center; gap: 7px; cursor: pointer; user-select: none;
    font-size: 12px; padding: 5px 10px; border-radius: 6px;
    border: 1px solid var(--hair); background: transparent; color: var(--vscode-foreground); }
  .ctl:hover { background: var(--vscode-toolbar-hoverBackground); }
  .switch { width: 26px; height: 15px; border-radius: 10px; background: var(--vscode-input-background);
    border: 1px solid var(--hair); position: relative; transition: background .15s; }
  .switch::after { content: ""; position: absolute; top: 1px; left: 1px; width: 11px; height: 11px;
    border-radius: 50%; background: var(--vscode-descriptionForeground); transition: transform .15s, background .15s; }
  .ctl.on .switch { background: var(--vscode-button-background); }
  .ctl.on .switch::after { transform: translateX(11px); background: var(--vscode-button-foreground); }
  .synced { font-size: 11px; color: var(--vscode-descriptionForeground); font-family: var(--mono); }

  /* The board is the one scrollport for both axes: y scrolls the whole deck rather than each
     column on its own, so a card's vertical position is comparable across columns. align-items
     stays flex-start so every column keeps its natural height — stretching them to the board's
     height would cap how far a sticky header can travel. The 16px top gap lives on .col-hd
     instead of here: sticky offsets resolve against the scrollport, so padding-top on the
     scroll container would scroll away and leave the headers flush against the toolbar. */
  .board { flex: 1; min-height: 0; display: flex; align-items: flex-start; gap: 12px;
    padding: 0 20px 20px; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
  /* min-width: 0 keeps the fixed basis honest — a card's unbreakable branch/key text would
     otherwise raise the column's automatic minimum width and stretch the whole board. */
  .col { position: relative; flex: 0 0 318px; min-width: 0; display: flex; flex-direction: column; }
  /* Sticky so the column you're reading stays labelled once the board scrolls; opaque because
     cards pass underneath it. */
  .col-hd { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 8px;
    padding: 16px 2px 10px; flex: none; background: var(--vscode-editor-background); }
  .col-hd .dot { width: 9px; height: 9px; border-radius: 50%; }
  .col-hd .nm { font-size: 12px; font-weight: 600; }
  .col-hd .ct { font-family: var(--mono); font-size: 11px; color: var(--vscode-descriptionForeground);
    border: 1px solid var(--hair); border-radius: 20px; padding: 0 7px; }
  .col-hd .rule { flex: 1; height: 1px; background: var(--hair); }
  .col-body { display: flex; flex-direction: column; gap: 10px; padding: 1px 3px 3px; }

  /* \`flex: none\` is load-bearing: .card sets overflow:hidden to clip the accent rail, which
     zeroes its automatic minimum size — without it the flex column squeezes every card and
     clips its content instead of growing the column. */
  .card { position: relative; flex: none; border: 1px solid var(--hair); border-radius: 10px;
    background: color-mix(in srgb, var(--vscode-foreground) 4%, var(--vscode-editor-background));
    padding: 10px 12px 9px 14px; overflow: hidden;
    transition: border-color .12s ease, background-color .12s ease; }
  .card::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2px; background: var(--accent); opacity: .32; }
  .card.needs::before { opacity: 1; }
  .card.needs { background: color-mix(in srgb, var(--c-needs) 7%, var(--vscode-editor-background)); }
  .card:hover { border-color: color-mix(in srgb, var(--vscode-foreground) 25%, transparent); }
  .card:focus-within { border-color: var(--vscode-focusBorder); }

  /* State leads every card from the same x, so a column scans as one strip of status. */
  .c-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .status { display: inline-flex; align-items: center; gap: 6px; min-width: 0; flex: 0 1 auto;
    font-family: var(--mono); font-size: 10.5px; color: var(--vscode-descriptionForeground);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .status.tone-needs { color: var(--c-needs); }
  .key { margin-left: auto; flex: 0 1 auto; min-width: 0; max-width: 46%; font-family: var(--mono); font-size: 10.5px;
    padding: 0; border: 0; background: none; color: var(--vscode-descriptionForeground); cursor: pointer;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .key:hover { color: var(--vscode-textLink-foreground, var(--vscode-foreground)); }
  /* Inherits .key's layout so the chip sits at the same x as every other card's
     key; drops the affordances, because there is nothing to click through to. */
  .key.untracked { cursor: default; opacity: .75; }
  .key.untracked:hover { color: var(--vscode-descriptionForeground); }
  .sdot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); flex: none; }
  .sdot.tone-working { background: var(--c-done); }
  .sdot.tone-idle    { background: var(--c-idle); }
  .sdot.tone-needs   { background: var(--c-needs); }
  .sdot.tone-parked, .sdot.tone-merged { background: transparent; border: 1.5px solid var(--vscode-descriptionForeground); }
  .sdot.pulse { animation: pulse 1.7s ease-out infinite; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 var(--c-done); } 70% { box-shadow: 0 0 0 5px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
  .spin { display: inline-block; font-size: 12px; }
  .spin.on { animation: spin .9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Clamped so long summaries can't stretch one card out of the column's rhythm; the full
     text stays available on hover. */
  .c-title { margin-top: 6px; font-size: 13px; font-weight: 500; line-height: 1.42; letter-spacing: -.005em;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }

  .c-branch { margin-top: 6px; font-family: var(--mono); font-size: 10px; color: var(--vscode-descriptionForeground);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .c-openhint { margin-top: 9px; font-size: 10px; font-family: var(--mono); color: var(--c-done);
    display: inline-flex; align-items: center; gap: 5px; }
  .c-openhint::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--c-done); flex: none; }
  .elapsed { flex: none; font-size: 10px; color: var(--vscode-descriptionForeground); font-family: var(--mono); }

  .c-repos { display: flex; align-items: center; flex-wrap: wrap; gap: 5px 6px; margin-top: 7px; }
  .repo { font-family: var(--mono); font-size: 10px; border: 1px solid var(--hair); border-radius: 5px;
    padding: 1px 6px; color: var(--vscode-descriptionForeground); }
  .repo .add { color: var(--c-done); } .repo .del { color: var(--c-needs); margin-left: 4px; }
  .repo .dirty { color: var(--c-idle); margin-left: 5px; }

  .c-foot { display: flex; align-items: center; gap: 8px; margin-top: 9px; min-width: 0; }
  .pill { flex: 0 1 auto; min-width: 0; font-family: var(--mono); font-size: 10px;
    border: 1px solid var(--hair); border-radius: 20px; padding: 1px 8px;
    color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* Secondary controls stay legible at rest and come up to full contrast on the card you're
     pointing at. The dimming lives on the buttons, not on .actions: opacity on the container
     would composite the whole subtree and make the overflow menu see-through. */
  .actions { margin-left: auto; flex: none; display: flex; align-items: center; gap: 4px; }
  .act:not(.primary), .more { opacity: .72; transition: opacity .12s ease; }
  .card:hover .act, .card:focus-within .act,
  .card:hover .more, .card:focus-within .more { opacity: 1; }
  .act { font-size: 11px; height: 24px; padding: 0 10px; border-radius: 6px; cursor: pointer; white-space: nowrap;
    border: 1px solid var(--hair); background: transparent; color: var(--vscode-foreground); }
  .act:hover { background: var(--vscode-toolbar-hoverBackground); border-color: var(--vscode-focusBorder); }
  .act.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); }
  .act.primary:hover { background: var(--vscode-button-hoverBackground); }

  .more-wrap { position: relative; display: inline-flex; }
  .more { width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center;
    border: 0; background: none; border-radius: 6px; color: var(--vscode-descriptionForeground); cursor: pointer; }
  .more:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
  .menu { position: absolute; right: 0; bottom: calc(100% + 4px); z-index: 20; min-width: 130px;
    border: 1px solid var(--hair); border-radius: 8px; padding: 4px;
    background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
    box-shadow: 0 8px 24px -10px rgba(0,0,0,.6); }
  .mi { display: block; width: 100%; text-align: left; font-size: 12px; padding: 6px 9px; border: 0;
    border-radius: 5px; cursor: pointer; background: none; color: var(--vscode-foreground); white-space: nowrap; }
  .mi:hover { background: var(--vscode-list-hoverBackground, var(--vscode-toolbar-hoverBackground)); }
  .mi.danger { color: var(--c-needs); }

  .empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 8px; color: var(--vscode-descriptionForeground); text-align: center; padding: 40px; }
  .empty .big { font-size: 15px; color: var(--vscode-foreground); }

  .legend { flex: none; display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
    padding: 8px 20px; border-top: 1px solid var(--hair); font-size: 11px; color: var(--vscode-descriptionForeground); }
  .legend .lg { display: flex; align-items: center; gap: 6px; }
  .legend .lg .dot { width: 8px; height: 8px; border-radius: 50%; }
  .legend .note { margin-left: auto; font-family: var(--mono); }

  .toasts { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; gap: 6px; z-index: 50; }
  .toast { font-family: var(--mono); font-size: 12px; padding: 8px 14px; border-radius: 7px;
    border: 1px solid var(--hair); background: var(--vscode-notifications-background, var(--vscode-editorWidget-background));
    color: var(--vscode-foreground); box-shadow: 0 6px 20px -8px rgba(0,0,0,.5); }
  .toast.error { border-color: var(--c-needs); }
  .toast.success { border-color: var(--c-done); }

  .board::-webkit-scrollbar { width: 9px; height: 9px; }
  .board::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 8px; }
  .board::-webkit-scrollbar-corner { background: transparent; }

  .pr-block { margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--hair);
    font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
  .pr-repo { color: var(--vscode-descriptionForeground); margin-bottom: 2px; }
  .pr-line { display: flex; align-items: baseline; gap: 6px; line-height: 1.5; }
  .pr-lbl { width: 42px; flex: none; color: var(--vscode-descriptionForeground); }
  .pr-link { background: none; border: 0; padding: 0; cursor: pointer;
    text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 2px; }
  .pr-ok { color: var(--c-done); }
  .pr-warn { color: var(--c-idle); }
  .pr-bad { color: var(--c-needs); }
  .pr-bad .pr-link { color: inherit; }
  .pr-wait { color: var(--vscode-descriptionForeground); }
  .pr-draft { color: var(--vscode-descriptionForeground); }
  .legend .note.warn { color: var(--c-idle); }
`;
