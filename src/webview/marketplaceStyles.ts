// Injected into the Marketplace panel <head>. Uses VS Code theme variables so it
// matches the editor theme (light or dark). Mirrors the Deck's visual grammar.
export const MARKETPLACE_CSS = `
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background); }
  #root { height: 100vh; display: flex; flex-direction: column; }

  :root {
    --hair: var(--vscode-panel-border);
    --mono: var(--vscode-editor-font-family, ui-monospace, monospace);
    --skill: var(--vscode-charts-blue, #4aa3df);
    --command: var(--vscode-charts-green, #4ac26b);
    --agent: var(--vscode-charts-purple, #b083f0);
    --hook: var(--vscode-charts-yellow, #d7a531);
    --plugin: var(--vscode-descriptionForeground);
  }

  .hd { flex: none; display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    padding: 13px 18px; border-bottom: 1px solid var(--hair); }
  .hd .title { font-size: 15px; font-weight: 600; letter-spacing: -.01em; }
  .hd .title .sub { color: var(--vscode-descriptionForeground); font-weight: 400; margin-left: 7px; font-size: 12px; }
  .sp { flex: 1; }

  .btn { cursor: pointer; font-family: inherit; font-size: 12px; padding: 5px 11px; border-radius: 6px;
    border: 1px solid var(--hair); background: transparent; color: var(--vscode-foreground); }
  .btn:hover { background: var(--vscode-toolbar-hoverBackground); }
  .btn.pri { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border-color: var(--vscode-button-background); }
  .btn.pri:hover { background: var(--vscode-button-hoverBackground); }

  .bar { flex: none; padding: 11px 18px; display: flex; flex-direction: column; gap: 9px;
    border-bottom: 1px solid var(--hair); }
  .search { max-width: 520px; }
  .search input { width: 100%; padding: 7px 10px; border-radius: 7px; font-size: 13px; font-family: inherit;
    border: 1px solid var(--hair); background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  .search input:focus { outline: none; border-color: var(--vscode-focusBorder); }

  .pills { display: flex; gap: 5px; flex-wrap: wrap; }
  .pill { cursor: pointer; font-family: inherit; display: inline-flex; align-items: center; gap: 6px;
    font-size: 11.5px; padding: 4px 10px; border-radius: 20px; border: 1px solid var(--hair);
    background: transparent; color: var(--vscode-foreground); }
  .pill:hover { background: var(--vscode-toolbar-hoverBackground); }
  .pill.on { background: var(--vscode-list-activeSelectionBackground); border-color: var(--vscode-focusBorder);
    color: var(--vscode-list-activeSelectionForeground); }
  .pill .n { font-family: var(--mono); font-size: 10px; opacity: .8; }

  .srcs { display: flex; gap: 5px; flex-wrap: wrap; }
  .tag { font-size: 10px; padding: 1px 7px; border-radius: 20px; border: 1px solid var(--hair);
    color: var(--vscode-descriptionForeground); white-space: nowrap; }
  .tag.ok { color: var(--vscode-charts-green, #4ac26b); }
  .tag.off { text-decoration: line-through; }
  .tag.bad { color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
  .tag.dim { opacity: .8; }

  .loading { flex: none; padding: 8px 18px; color: var(--vscode-descriptionForeground); font-size: 12px; }
  .split { flex: 1; min-height: 0; display: flex; }
  .results { flex: 1; min-width: 0; overflow-y: auto; border-right: 1px solid var(--hair); padding: 6px 0 30px; }
  .grouphd { display: flex; align-items: center; gap: 8px; width: 100%; padding: 11px 18px 5px;
    background: transparent; border: 0; cursor: pointer; font-family: inherit; text-align: left; }
  .grouphd:hover .lb { color: var(--vscode-foreground); }
  .grouphd .lb { font-size: 10px; text-transform: uppercase; letter-spacing: .09em;
    color: var(--vscode-descriptionForeground); font-weight: 600; }
  .grouphd .n { font-family: var(--mono); font-size: 10px; color: var(--vscode-descriptionForeground); }
  .grouphd .rule { flex: 1; height: 1px; background: var(--hair); }

  .chips { display: flex; gap: 5px; flex-wrap: wrap; align-items: center; }
  .chip { cursor: pointer; font-family: inherit; font-size: 11px; padding: 3px 9px; border-radius: 20px;
    border: 1px solid var(--vscode-focusBorder); background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground); }
  .chip:hover { opacity: .85; }
  .chip.clear { border-color: var(--hair); background: transparent; color: var(--vscode-descriptionForeground); }

  .row { display: flex; align-items: flex-start; gap: 10px; padding: 7px 18px; cursor: pointer;
    border-left: 2px solid transparent; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.on { background: var(--vscode-list-activeSelectionBackground); border-left-color: var(--vscode-focusBorder); }
  .row .body { min-width: 0; flex: 1; }
  .row .top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .row .nm { font-size: 12.5px; font-weight: 500; }
  .row .mono { font-family: var(--mono); }
  .row .meta, .row .ds { font-size: 11.5px; color: var(--vscode-descriptionForeground); }
  .row .ds { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .glyph { flex: none; width: 19px; height: 19px; border-radius: 5px; display: inline-flex;
    align-items: center; justify-content: center; font-size: 10.5px; font-weight: 700; font-family: var(--mono); }
  .t-skill .glyph { background: color-mix(in srgb, var(--skill) 18%, transparent); color: var(--skill); }
  .t-command .glyph { background: color-mix(in srgb, var(--command) 18%, transparent); color: var(--command); }
  .t-agent .glyph { background: color-mix(in srgb, var(--agent) 18%, transparent); color: var(--agent); }
  .t-hook .glyph { background: color-mix(in srgb, var(--hook) 18%, transparent); color: var(--hook); }
  .t-plugin .glyph { background: color-mix(in srgb, var(--plugin) 18%, transparent); color: var(--plugin); }

  .detail { flex: 0 0 39%; max-width: 460px; overflow-y: auto; padding: 18px;
    display: flex; flex-direction: column; gap: 13px; }
  .detail .dh { display: flex; align-items: center; gap: 9px; }
  .detail .dn { font-size: 16px; font-weight: 600; word-break: break-word; }
  .detail .tags, .acts { display: flex; gap: 6px; flex-wrap: wrap; }
  .detail .dd { font-size: 12.5px; }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 5px 12px; font-size: 11.5px; margin: 0; }
  .kv dt { color: var(--vscode-descriptionForeground); }
  .kv dd { margin: 0; font-family: var(--mono); font-size: 11px; word-break: break-all; }
  .snip { position: relative; }
  .snip pre { margin: 0; font-family: var(--mono); font-size: 11.5px; overflow-x: auto;
    background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.1));
    border: 1px solid var(--hair); border-radius: 7px; padding: 9px 74px 9px 11px; }
  .snip .cp { position: absolute; top: 6px; right: 6px; }

  .empty { padding: 44px 20px; text-align: center; color: var(--vscode-descriptionForeground); }
  .empty .big { font-size: 15px; color: var(--vscode-foreground); margin-bottom: 5px; }
  .empty code { font-family: var(--mono); font-size: 11.5px; }

  .toasts { position: fixed; bottom: 16px; right: 16px; display: flex; flex-direction: column; gap: 8px; }
  .toast { padding: 8px 14px; border-radius: 6px; font-size: 12px; border: 1px solid var(--hair);
    background: var(--vscode-editorWidget-background); }
  .toast.success { border-color: var(--vscode-charts-green, #4ac26b); }
  .toast.error { border-color: var(--vscode-errorForeground); }

  .results::-webkit-scrollbar, .detail::-webkit-scrollbar { width: 9px; }
  .results::-webkit-scrollbar-thumb, .detail::-webkit-scrollbar-thumb {
    background: var(--vscode-scrollbarSlider-background); border-radius: 8px; }
`;
