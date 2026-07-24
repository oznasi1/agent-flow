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
  #root { min-height: 100vh; display: flex; flex-direction: column; }

  :root {
    --hair: var(--vscode-panel-border);
    --mono: var(--vscode-editor-font-family, ui-monospace, monospace);
    --accent: var(--vscode-charts-blue, #4aa3df);
  }

  .hd { flex: none; display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    padding: 14px 20px; border-bottom: 1px solid var(--hair); }
  .hd .title { font-size: 15px; font-weight: 600; }
  .hd .title .sub { color: var(--vscode-descriptionForeground); font-weight: 400; margin-left: 6px; font-size: 12px; }
  .hd .sp, .sp { flex: 1; }

  .add { display: inline-flex; align-items: center; gap: 6px; }
  .add input { min-width: 260px; padding: 5px 8px; border-radius: 6px;
    border: 1px solid var(--hair); background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  .btn { cursor: pointer; font-size: 12px; padding: 5px 12px; border-radius: 6px;
    border: 1px solid var(--hair); background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn:hover { background: var(--vscode-button-hoverBackground); }
  .btn.ghost { background: transparent; color: var(--vscode-foreground); }
  .btn.ghost:hover { background: var(--vscode-toolbar-hoverBackground); }

  .how { margin: 12px 20px 0; }
  .how summary { cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 12px; }
  .how-body { margin-top: 8px; font-size: 12px; color: var(--vscode-descriptionForeground); }
  .how-body pre, .snippet pre { font-family: var(--mono); font-size: 12px;
    background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.1)); padding: 8px 10px; border-radius: 6px; overflow-x: auto; margin: 6px 0 0; }

  .loading { padding: 10px 20px; color: var(--vscode-descriptionForeground); }
  .list { padding: 14px 20px 40px; display: flex; flex-direction: column; gap: 16px; }
  .empty { padding: 60px 20px; text-align: center; color: var(--vscode-descriptionForeground); }
  .empty .big { font-size: 16px; font-weight: 600; color: var(--vscode-foreground); margin-bottom: 6px; }

  .mkt { border: 1px solid var(--hair); border-radius: 10px; overflow: hidden; }
  .mkt-hd { display: flex; align-items: center; gap: 10px; padding: 10px 14px;
    background: var(--vscode-editorWidget-background, transparent); border-bottom: 1px solid var(--hair); }
  .mkt-nm { font-weight: 650; }
  .mkt-repo { font-size: 12px; color: var(--vscode-textLink-foreground); text-decoration: none; }
  .mkt-repo:hover { text-decoration: underline; }
  .mkt-ct { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .mkt-x { cursor: pointer; font-size: 16px; line-height: 1; color: var(--vscode-descriptionForeground); padding: 0 4px; }
  .mkt-x:hover { color: var(--vscode-errorForeground); }
  .mkt-desc { padding: 8px 14px 0; font-size: 12px; color: var(--vscode-descriptionForeground); }
  .mkt-err { padding: 12px 14px; font-size: 12px; color: var(--vscode-errorForeground); }

  .plugins { padding: 12px 14px; display: flex; flex-direction: column; gap: 12px; }
  .plugin { border: 1px solid var(--hair); border-radius: 8px; padding: 10px 12px; }
  .plugin-nm { font-weight: 600; }
  .plugin-desc { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 4px 0 8px; }
  .chiprow { display: flex; align-items: baseline; gap: 8px; margin: 4px 0; }
  .chiprow-l { font-size: 11px; color: var(--vscode-descriptionForeground); min-width: 78px; }
  .chips { display: flex; flex-wrap: wrap; gap: 5px; }
  .chip { font-size: 11px; padding: 2px 8px; border-radius: 10px;
    border: 1px solid var(--hair); background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .snippet { position: relative; margin-top: 8px; }
  .snippet .copy { position: absolute; top: 6px; right: 6px; cursor: pointer; font-size: 11px;
    padding: 3px 8px; border-radius: 6px; border: 1px solid var(--hair); background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-foreground); }

  .toasts { position: fixed; bottom: 16px; right: 16px; display: flex; flex-direction: column; gap: 8px; }
  .toast { padding: 8px 14px; border-radius: 6px; font-size: 12px; border: 1px solid var(--hair);
    background: var(--vscode-editorWidget-background); }
  .toast.success { border-color: var(--vscode-charts-green, #4ac26b); }
  .toast.error { border-color: var(--vscode-errorForeground); }
`;
