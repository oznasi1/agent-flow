// Injected into the webview <head>. Uses VS Code theme variables so it matches
// the user's editor theme (light or dark) automatically, with subtle accents.
export const CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background); }
  #root { padding: 8px 8px 20px; }

  .header { display: flex; align-items: center; gap: 8px; padding: 4px 4px 10px; }
  .header .title { font-weight: 600; font-size: 13px; }
  .header .me { color: var(--vscode-descriptionForeground); font-size: 11px; margin-left: 8px; }
  .explore { display: inline-flex; align-items: center; gap: 5px; margin-left: auto;
    font-size: 11px; font-weight: 500; padding: 3px 11px 3px 9px; border-radius: 14px;
    cursor: pointer; border: none;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    transition: transform .08s ease, background .12s ease; }
  .explore:hover { background: var(--vscode-button-hoverBackground); transform: translateY(-1px); }
  .explore:active { transform: translateY(0); }
  .explore svg { display: block; }

  .tabs { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 10px; }
  .tab { font-size: 11px; padding: 3px 10px; border-radius: 20px; cursor: pointer;
    border: 1px solid var(--vscode-panel-border); background: transparent;
    color: var(--vscode-foreground); user-select: none; }
  .tab:hover { background: var(--vscode-toolbar-hoverBackground); }
  .tab.active { background: var(--vscode-button-background);
    color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); }

  .sizes { display: flex; align-items: center; gap: 5px; margin: 0 0 10px 2px; }
  .sizes-label { font-size: 10px; text-transform: uppercase; letter-spacing: .06em;
    color: var(--vscode-descriptionForeground); margin-right: 2px; }
  .size-chip { font-size: 10px; min-width: 24px; padding: 2px 8px; border-radius: 20px; cursor: pointer;
    border: 1px solid var(--vscode-panel-border); background: transparent; color: var(--vscode-foreground); }
  .size-chip:hover { background: var(--vscode-toolbar-hoverBackground); }
  .size-chip.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border-color: var(--vscode-button-background); }

  .statuses { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; margin: 0 0 10px 2px; }
  .statuses-label { font-size: 10px; text-transform: uppercase; letter-spacing: .06em;
    color: var(--vscode-descriptionForeground); margin-right: 2px; }
  .status-chip { font-size: 10px; padding: 2px 9px; border-radius: 20px; cursor: pointer;
    border: 1px solid var(--vscode-panel-border); background: transparent; color: var(--vscode-foreground); }
  .status-chip:hover { background: var(--vscode-toolbar-hoverBackground); }
  .status-chip.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border-color: var(--vscode-button-background); }

  .est { font-size: 10px; color: var(--vscode-descriptionForeground); white-space: nowrap;
    font-variant-numeric: tabular-nums; }

  .repo-select { position: relative; margin: 0 2px 10px; }
  .repo-select-trigger { display: flex; align-items: center; gap: 7px; width: 100%;
    padding: 5px 9px; border-radius: 8px; border: 1px solid var(--vscode-panel-border);
    background: var(--vscode-input-background, transparent); cursor: pointer;
    color: var(--vscode-input-foreground, var(--vscode-foreground));
    font-family: var(--vscode-font-family); font-size: 12px; text-align: left; }
  .repo-select-trigger:hover { border-color: var(--vscode-focusBorder); }
  .repo-select-trigger svg { flex: none; opacity: .55; }
  .repo-select-label { flex: 1; min-width: 0; }
  .repo-select-label.placeholder { color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground)); }
  .repo-count { flex: none; font-size: 10px; line-height: 1; padding: 1px 6px; border-radius: 9px;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .repo-select-caret { flex: none; opacity: .6; font-size: 10px; }

  .repo-pop { position: absolute; z-index: 10; top: calc(100% + 4px); left: 0; right: 0;
    border: 1px solid var(--vscode-focusBorder); border-radius: 8px; overflow: hidden;
    background: var(--vscode-dropdown-background, var(--vscode-editorWidget-background, var(--vscode-editor-background)));
    box-shadow: 0 6px 20px rgba(0,0,0,.35); animation: repo-in .12s ease; }
  .repo-opt { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 5px;
    cursor: pointer; color: var(--vscode-foreground); }
  .repo-opt.active { background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground); }
  .repo-box { flex: none; width: 14px; height: 14px; border-radius: 3px;
    border: 1px solid var(--vscode-checkbox-border, var(--vscode-panel-border));
    display: flex; align-items: center; justify-content: center; font-size: 10px; }
  .repo-opt.checked .repo-box { background: var(--vscode-button-background);
    color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); }
  .repo-pop-foot { display: flex; justify-content: space-between; align-items: center;
    padding: 6px 10px; border-top: 1px solid var(--vscode-panel-border);
    font-size: 11px; color: var(--vscode-descriptionForeground); }
  .repo-clear-all { background: none; border: none; cursor: pointer; padding: 0; font-size: 11px;
    color: var(--vscode-textLink-foreground); }

  .text-search { display: flex; align-items: center; gap: 7px; margin: 0 2px 10px;
    padding: 4px 9px; border-radius: 8px; border: 1px solid var(--vscode-panel-border);
    background: var(--vscode-input-background, transparent); }
  .text-search:focus-within { border-color: var(--vscode-focusBorder); }
  .text-search svg { flex: none; opacity: .55; }
  .text-search input { flex: 1; min-width: 0; border: none; outline: none; background: transparent;
    color: var(--vscode-input-foreground, var(--vscode-foreground));
    font-family: var(--vscode-font-family); font-size: 12px; }
  .text-search input::placeholder { color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground)); }
  .text-search-clear { cursor: pointer; opacity: .6; font-size: 14px; line-height: 1; padding: 0 2px; }
  .text-search-clear:hover { opacity: 1; }

  .list { display: flex; flex-direction: column; gap: 6px; }

  .reorder-bar { display: flex; justify-content: flex-end; margin: -4px 2px 8px; }
  .reset-order { font-size: 10px; padding: 2px 9px; border-radius: 10px; cursor: pointer;
    background: transparent; border: 1px solid var(--vscode-panel-border);
    color: var(--vscode-descriptionForeground);
    transition: border-color .12s ease, color .12s ease; }
  .reset-order:hover { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); }

  .grip { cursor: grab; color: var(--vscode-descriptionForeground); font-size: 13px; line-height: 1;
    opacity: .4; user-select: none; margin-left: -3px; }
  .grip:hover { opacity: .9; }
  .grip:active { cursor: grabbing; }
  .card.dragging { opacity: .45; }
  .card.drop-before { box-shadow: inset 0 2px 0 0 var(--vscode-focusBorder); }
  .card.drop-after  { box-shadow: inset 0 -2px 0 0 var(--vscode-focusBorder); }

  .card { position: relative; border: 1px solid var(--vscode-panel-border);
    border-radius: 6px; background: var(--vscode-editor-background);
    padding: 9px 11px 9px 14px; overflow: hidden; }
  .card::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; }
  .card.p-high::before { background: var(--vscode-editorError-foreground, #f85149); }
  .card.p-med::before  { background: var(--vscode-editorWarning-foreground, #d29922); }
  .card.p-low::before  { background: var(--vscode-panel-border); }
  .card:hover { border-color: var(--vscode-focusBorder); }

  .card-main { cursor: pointer; }
  .card-top { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; row-gap: 6px; margin-bottom: 3px; }
  .chev { color: var(--vscode-descriptionForeground); font-size: 14px; line-height: 1;
    width: 10px; display: inline-block; transition: transform .12s ease; }
  .chev.open { transform: rotate(90deg); }
  .key { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px;
    color: var(--vscode-textLink-foreground); text-decoration: none; }
  .key:hover { text-decoration: underline; }
  .status { font-size: 10px; padding: 1px 7px; border-radius: 10px;
    color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-panel-border); }
  .status-btn { display: inline-flex; align-items: center; gap: 3px; cursor: pointer;
    font-family: inherit; background: transparent; transition: border-color .12s ease, color .12s ease; }
  .status-btn:hover { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); }
  .status-caret { font-size: 8px; opacity: .6; }
  .status-btn:hover .status-caret { opacity: 1; }
  /* Colour per status category */
  .status--new { color: var(--vscode-descriptionForeground); }
  .status--indeterminate { color: var(--vscode-charts-yellow, #d29922); }
  .status--done { color: var(--vscode-charts-green, #3fb950); }
  .spacer { flex: 1; }
  .take { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 500;
    padding: 3px 11px 3px 9px; border-radius: 14px; cursor: pointer; border: none;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    transition: transform .08s ease, background .12s ease; }
  .take:hover { background: var(--vscode-button-hoverBackground); transform: translateY(-1px); }
  .take:active { transform: translateY(0); }
  .take-icon { display: block; }

  /* Right-aligned action cluster; wraps together to its own line if the row is tight */
  .card-actions { display: inline-flex; align-items: center; gap: 7px; margin-left: auto; }

  /* Secondary action: add to my sprint (assign to me + active sprint) */
  .sprint-add { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 500;
    padding: 3px 11px 3px 9px; border-radius: 14px; cursor: pointer; white-space: nowrap;
    border: 1px solid var(--vscode-panel-border); background: transparent;
    color: var(--vscode-foreground);
    transition: color .12s ease, border-color .12s ease, background .12s ease; }
  .sprint-add:hover { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder);
    background: var(--vscode-toolbar-hoverBackground); }
  .sprint-add svg { display: block; }

  /* PR-review kick-off: outlined like sprint-add, tinted to read as "ready to ship" */
  .address-pr { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 500;
    padding: 3px 11px 3px 9px; border-radius: 14px; cursor: pointer; white-space: nowrap;
    border: 1px solid var(--vscode-charts-green, #3fb950); background: transparent;
    color: var(--vscode-charts-green, #3fb950);
    transition: color .12s ease, border-color .12s ease, background .12s ease; }
  .address-pr:hover { border-color: var(--vscode-focusBorder);
    background: var(--vscode-toolbar-hoverBackground); }
  .address-pr svg { display: block; }

  .detail { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--vscode-panel-border); }
  .detail-loading { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .desc { font-size: 11.5px; line-height: 1.5; color: var(--vscode-descriptionForeground);
    white-space: pre-wrap; max-height: 160px; overflow: auto; margin-bottom: 10px; }
  .sel-label { font-size: 10px; text-transform: uppercase; letter-spacing: .05em;
    color: var(--vscode-descriptionForeground); margin-bottom: 5px; }
  .chips { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
  .chip { display: inline-flex; align-items: center; gap: 5px; font-size: 10px;
    padding: 2px 5px 2px 8px; border-radius: 12px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .chip .x { cursor: pointer; opacity: .65; font-size: 12px; line-height: 1; }
  .chip .x:hover { opacity: 1; }
  .chip-none { font-size: 10px; color: var(--vscode-descriptionForeground); font-style: italic; }

  /* Repo picker — inline command-palette style */
  .repo-picker { margin-top: 8px; }
  .repo-add { display: inline-flex; align-items: center; gap: 5px; font-size: 11px;
    padding: 3px 11px; border-radius: 13px; cursor: pointer; background: transparent;
    color: var(--vscode-foreground); border: 1px dashed var(--vscode-panel-border);
    transition: border-color .12s ease, background .12s ease; }
  .repo-add:hover { border-color: var(--vscode-focusBorder); background: var(--vscode-toolbar-hoverBackground); }
  .repo-add-plus { font-size: 13px; line-height: 1; color: var(--vscode-descriptionForeground); }
  .repo-add:hover .repo-add-plus { color: var(--vscode-foreground); }

  .repo-combo { border: 1px solid var(--vscode-focusBorder); border-radius: 8px; overflow: hidden;
    background: var(--vscode-input-background, var(--vscode-editor-background));
    animation: repo-in .12s ease; }
  @keyframes repo-in { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .repo-combo, .repo-pop { animation: none; } }

  .repo-search { display: flex; align-items: center; gap: 7px; padding: 6px 10px;
    border-bottom: 1px solid var(--vscode-panel-border); }
  .repo-search svg { flex: none; opacity: .55; }
  .repo-search input { flex: 1; min-width: 0; border: none; outline: none; background: transparent;
    color: var(--vscode-input-foreground, var(--vscode-foreground));
    font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
  .repo-search input::placeholder { color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground)); }

  .repo-list { max-height: 190px; overflow-y: auto; padding: 4px; }
  .repo-row { display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 5px 8px; border-radius: 5px; cursor: pointer; color: var(--vscode-foreground); }
  .repo-row.active { background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground); }
  .repo-name { font-family: var(--vscode-editor-font-family, monospace); font-size: 11.5px; }
  .repo-add-hint { font-size: 9px; text-transform: uppercase; letter-spacing: .06em;
    opacity: 0; color: currentColor; white-space: nowrap; }
  .repo-row.active .repo-add-hint { opacity: .7; }
  .repo-empty { padding: 10px 8px; font-size: 11px; font-style: italic;
    color: var(--vscode-descriptionForeground); }

  .summary { font-size: 12.5px; line-height: 1.4; margin: 2px 0 6px; }
  .meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .assignee { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .assignee.unassigned { color: var(--vscode-editorWarning-foreground, #d29922); }
  .svc { font-size: 10px; padding: 1px 6px; border-radius: 4px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .svc.guess { opacity: .8; font-style: italic; }

  .empty, .gate { text-align: center; color: var(--vscode-descriptionForeground);
    padding: 28px 12px; font-size: 12px; }
  .gate .btn { margin-top: 12px; padding: 6px 16px; border: none; border-radius: 4px;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    cursor: pointer; font-size: 12px; }
  .gate .btn:hover { background: var(--vscode-button-hoverBackground); }
  .gate .gate-error { color: var(--vscode-errorForeground); line-height: 1.5; }
  .loading { color: var(--vscode-descriptionForeground); font-size: 12px; padding: 12px 4px; }

  /* Toasts — success / error / info, bottom of the panel */
  .toast-stack { position: fixed; left: 8px; right: 8px; bottom: 10px; z-index: 1000;
    display: flex; flex-direction: column; gap: 6px; pointer-events: none; }
  .toast { pointer-events: auto; cursor: pointer; display: flex; align-items: flex-start; gap: 8px;
    padding: 8px 11px; border-radius: 7px; font-size: 12px; line-height: 1.4;
    background: var(--vscode-notifications-background, var(--vscode-editorWidget-background, var(--vscode-editor-background)));
    color: var(--vscode-notifications-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-notifications-border, var(--vscode-panel-border));
    border-left-width: 3px; box-shadow: 0 4px 14px rgba(0,0,0,.35);
    animation: toast-in .16s ease; }
  @keyframes toast-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .toast { animation: none; } }
  .toast--success { border-left-color: var(--vscode-charts-green, #3fb950); }
  .toast--error   { border-left-color: var(--vscode-errorForeground, #f85149); }
  .toast--info    { border-left-color: var(--vscode-focusBorder, #4daafc); }
  .toast-ico { flex: none; font-weight: 700; line-height: 1.4; }
  .toast--success .toast-ico { color: var(--vscode-charts-green, #3fb950); }
  .toast--error .toast-ico   { color: var(--vscode-errorForeground, #f85149); }
  .toast--info .toast-ico    { color: var(--vscode-focusBorder, #4daafc); }
  .toast-msg { flex: 1; }

  .card-check { flex: 0 0 auto; margin: 0 6px 0 0; cursor: pointer;
    accent-color: var(--vscode-button-background); }
  .batch-bar { position: sticky; bottom: 0; z-index: 2; display: flex; align-items: center; gap: 8px;
    margin-top: 6px; padding: 8px 10px;
    background: var(--vscode-sideBar-background);
    border-top: 1px solid var(--vscode-panel-border); }
  .batch-count { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .batch-selectall, .batch-clear { background: none; border: none; cursor: pointer; padding: 0;
    font-size: 11px; color: var(--vscode-textLink-foreground); }
  .batch-launch { margin-left: auto; display: inline-flex; align-items: center; gap: 5px;
    font-size: 12px; padding: 4px 12px; border-radius: 8px; border: none; cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .batch-launch:hover { background: var(--vscode-button-hoverBackground); }
`;
