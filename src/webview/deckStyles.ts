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

  .board { flex: 1; min-height: 0; display: flex; gap: 14px; padding: 16px 20px; overflow-x: auto; overflow-y: hidden; }
  .col { flex: 0 0 300px; display: flex; flex-direction: column; min-height: 0; }
  .col-hd { display: flex; align-items: center; gap: 8px; padding: 0 2px 10px; flex: none; }
  .col-hd .dot { width: 9px; height: 9px; border-radius: 50%; }
  .col-hd .nm { font-size: 12px; font-weight: 600; }
  .col-hd .ct { font-family: var(--mono); font-size: 11px; color: var(--vscode-descriptionForeground);
    border: 1px solid var(--hair); border-radius: 20px; padding: 0 7px; }
  .col-hd .rule { flex: 1; height: 1px; background: var(--hair); }
  .col-body { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 9px; padding: 2px 2px 30px; }

  .card { position: relative; border: 1px solid var(--hair); border-radius: 8px;
    background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    padding: 11px 12px; overflow: hidden; }
  .card::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--accent); opacity: 0; }
  .card.needs::before { opacity: .9; }
  .card:hover { border-color: var(--vscode-focusBorder); }

  .c-top { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; }
  .key { font-family: var(--mono); font-size: 11px; padding: 1px 6px; border-radius: 5px;
    border: 1px solid var(--hair); color: var(--vscode-foreground); cursor: pointer; }
  .key:hover { border-color: var(--vscode-focusBorder); }
  .status { margin-left: auto; display: flex; align-items: center; gap: 6px;
    font-family: var(--mono); font-size: 10.5px; color: var(--vscode-descriptionForeground); }
  .sdot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); flex: none; }
  .sdot.tone-working { background: var(--c-done); }
  .sdot.tone-idle    { background: var(--c-idle); }
  .sdot.tone-needs   { background: var(--c-needs); }
  .sdot.tone-parked, .sdot.tone-merged { background: transparent; border: 1.5px solid var(--vscode-descriptionForeground); }
  .sdot.pulse { animation: pulse 1.7s ease-out infinite; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 var(--c-done); } 70% { box-shadow: 0 0 0 5px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }

  .c-title { font-size: 13px; line-height: 1.35; }

  .c-repos { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }
  .repo { font-family: var(--mono); font-size: 10px; border: 1px solid var(--hair); border-radius: 6px;
    padding: 2px 6px; color: var(--vscode-descriptionForeground); }
  .repo .add { color: var(--c-done); } .repo .del { color: var(--c-needs); margin-left: 4px; }
  .repo .dirty { color: var(--c-idle); margin-left: 5px; }

  .c-foot { display: flex; align-items: center; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
  .pill { font-family: var(--mono); font-size: 10px; border: 1px solid var(--hair); border-radius: 20px;
    padding: 1px 8px; color: var(--vscode-descriptionForeground); }
  .actions { margin-left: auto; display: flex; gap: 5px; }
  .act { font-size: 11px; padding: 3px 9px; border-radius: 6px; cursor: pointer;
    border: 1px solid var(--hair); background: transparent; color: var(--vscode-foreground); }
  .act:hover { background: var(--vscode-toolbar-hoverBackground); border-color: var(--vscode-focusBorder); }
  .act.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); }
  .act.primary:hover { background: var(--vscode-button-hoverBackground); }

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

  .board::-webkit-scrollbar, .col-body::-webkit-scrollbar { width: 9px; height: 9px; }
  .board::-webkit-scrollbar-thumb, .col-body::-webkit-scrollbar-thumb {
    background: var(--vscode-scrollbarSlider-background); border-radius: 8px; }
`;
