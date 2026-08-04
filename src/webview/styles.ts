// Injected into the webview <head>. Uses VS Code theme variables so it matches
// the user's editor theme (light or dark) automatically, with subtle accents.
export const CSS = `
  body { margin: 0; padding: 0;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background); }
  #root { padding: 8px 8px 20px; }

  .header { display: flex; align-items: center; gap: 8px; padding: 4px 4px 10px; }
  .header .title { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; font-size: var(--t-title); }
  .header .me { color: var(--vscode-descriptionForeground); font-size: 11px; margin-left: 8px; }

  /* The mark is the sidebar's status display: lit dots are open Agent Flow
     windows. Unlit and texture dots ride the theme foreground so the ring keeps
     its shape on any background, and sit just under it rather than at a quarter
     of it — at .26 the ring read as a smudge at 15px. The count stays legible
     because lit/unlit differ in hue, not only in weight. */
  .gauge { flex: none; display: block; }
  .gauge .lit { fill: var(--brand); }
  .gauge .unlit { fill: currentColor; opacity: .85; }
  .gauge .tex { fill: currentColor; opacity: .85; }
  /* The pool's one filled control is Take. Explore is the way out when no ticket
     fits — useful, not primary — so it shares the secondary action language below
     with Address PR and the sprint actions, rather than repeating it. */
  .explore svg { display: block; }

  .lenses { display: flex; flex-direction: column; gap: 6px; margin: 0 2px 10px; }
  .lens { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }

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

  .card { position: relative; border: 1px solid var(--hair); border-radius: var(--r-card);
    background: color-mix(in srgb, var(--vscode-foreground) 4%, var(--vscode-editor-background));
    padding: 9px 11px 9px 14px; overflow: hidden;
    transition: border-color .12s ease, background-color .12s ease; }
  .card::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2px;
    background: var(--rail); opacity: .5; }
  .card.s-new      { --rail: var(--dim); }
  .card.s-progress { --rail: var(--c-progress); }
  .card.s-done     { --rail: var(--c-done); }
  .card:hover { border-color: color-mix(in srgb, var(--vscode-foreground) 25%, transparent); }
  .card:focus-within { border-color: var(--vscode-focusBorder); }

  .card-main { cursor: pointer; }
  .card-top { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; row-gap: 6px; margin-bottom: 3px; }
  .chev { color: var(--vscode-descriptionForeground); font-size: 14px; line-height: 1;
    width: 10px; display: inline-block; transition: transform .12s ease; }
  .chev.open { transform: rotate(90deg); }
  /* An identifier: mono, dim, and the link affordance arrives on hover — a blue
     key on every card was six links competing with the one button that matters. */
  .key { font-family: var(--mono); font-size: var(--t-data); color: var(--dim); text-decoration: none; }
  .key:hover { color: var(--vscode-textLink-foreground); }

  /* Urgency, and only at the top level. --c-attn, never --c-danger: an urgent
     ticket is not a broken one. */
  .p-top { font-size: var(--t-micro); font-weight: 600; padding: 0 5px; border-radius: var(--r-chip);
    color: var(--c-attn); border: 1px solid color-mix(in srgb, var(--c-attn) 45%, transparent); }
  .status { font-size: 10px; padding: 1px 7px; border-radius: 10px;
    color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-panel-border); }
  .status-btn { display: inline-flex; align-items: center; gap: 3px; cursor: pointer;
    font-family: inherit; background: transparent; transition: border-color .12s ease, color .12s ease; }
  .status-btn:hover { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); }
  .status-caret { font-size: 8px; opacity: .6; }
  .status-btn:hover .status-caret { opacity: 1; }
  /* No hue: the rail already says where this ticket is in the flow. Amber on a card
     means exactly one thing, and it is the Highest chip. */
  .status--new, .status--indeterminate, .status--done { color: var(--dim); }
  .spacer { flex: 1; }
  .take { display: inline-flex; align-items: center; gap: 5px; font-size: var(--t-body); font-weight: 600;
    padding: 3px 11px 3px 9px; border-radius: var(--r-ctl); cursor: pointer; border: none;
    background: var(--brand); color: var(--brand-ink);
    transition: background .12s ease; }
  .take:hover { background: color-mix(in srgb, var(--brand) 84%, var(--vscode-foreground)); }
  .take-icon { display: block; }

  /* Right-aligned action cluster; wraps together to its own line if the row is tight */
  .card-actions { display: inline-flex; align-items: center; gap: 7px; margin-left: auto; }

  /* One quiet secondary language for every non-Take action: Explore (the pool's
     escape hatch), Address PR (which gives up its green — green means Done on the
     Deck, and a PR waiting on you is the opposite of done) and the sprint actions.
     Explore is the only one pushed to the row's far side; the other three are the
     only ones that must never wrap their own label. */
  .explore, .address-pr, .sprint-add, .sprint-remove {
    display: inline-flex; align-items: center; gap: 5px; font-size: var(--t-body); font-weight: 500;
    height: 24px; padding: 0 10px; border-radius: var(--r-ctl); cursor: pointer;
    border: 1px solid var(--edge); background: transparent; color: var(--vscode-foreground);
    transition: background-color .12s ease, border-color .12s ease; }
  .explore { margin-left: auto; }
  .address-pr, .sprint-add, .sprint-remove { white-space: nowrap; }
  .sprint-remove { color: var(--dim); }
  .explore:hover, .address-pr:hover, .sprint-add:hover, .sprint-remove:hover {
    background: var(--vscode-toolbar-hoverBackground);
    border-color: color-mix(in srgb, var(--vscode-foreground) 30%, transparent); }
  /* Icon-only: a square of the same height, so the row reads as one set of controls. */
  .sprint-remove.icon-only { width: 24px; padding: 0; justify-content: center; }

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
  /* Off the ticket — inferred but never recorded on the issue, or no component at
     all. The dashed outline carries that on its own; the padding drops 1px to
     absorb the border so chips don't change size between states. */
  .chip.off-ticket { background: transparent; padding: 1px 4px 1px 7px;
    border: 1px dashed var(--vscode-badge-background); color: var(--vscode-descriptionForeground); }
  .chip .up { cursor: pointer; opacity: .65; font-size: 11px; line-height: 1; }
  .chip .up:hover { opacity: 1; }
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
  .assignee.unassigned { color: var(--c-idle); }
  /* Repo names are identifiers, so mono; an inferred one wears a ~ rather than
     italics, matching the Deck's ~inferred convention. */
  .svc { font-family: var(--mono); font-size: var(--t-data); padding: 1px 6px;
    border-radius: var(--r-chip); border: 1px solid var(--hair); color: var(--dim); }
  .svc.guess { opacity: .8; }

  .empty, .gate { text-align: center; color: var(--vscode-descriptionForeground);
    padding: 28px 12px; font-size: 12px; }
  /* Sign in to Jira / Run setup — the one action the gate screen offers, so it is
     a primary verb the same way Take is. */
  .gate .btn { margin-top: 12px; padding: 6px 16px; border: none; border-radius: 4px;
    background: var(--brand); color: var(--brand-ink);
    cursor: pointer; font-size: 12px; }
  .gate .btn:hover { background: color-mix(in srgb, var(--brand) 84%, var(--vscode-foreground)); }
  .gate .gate-error { color: var(--vscode-errorForeground); line-height: 1.5; }
  .loading { color: var(--vscode-descriptionForeground); font-size: 12px; padding: 12px 4px; }

  /* Toasts — success / error / info, bottom of the panel */
  .toast-stack { position: fixed; left: 8px; right: 8px; bottom: 10px; z-index: 1000;
    display: flex; flex-direction: column; gap: 6px; pointer-events: none; }
  .toast { pointer-events: auto; cursor: pointer; display: flex; align-items: flex-start; gap: 8px;
    padding: 8px 11px; border-radius: 7px; font-size: 12px; line-height: 1.4;
    background: var(--vscode-notifications-background, var(--vscode-editorWidget-background, var(--vscode-editor-background)));
    color: var(--vscode-notifications-foreground, var(--vscode-foreground));
    border: 1px solid var(--hair); box-shadow: 0 6px 20px -8px rgba(0,0,0,.5);
    animation: toast-in .16s ease; }
  @keyframes toast-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  .toast--success { border-color: var(--c-done); }
  .toast--error   { border-color: var(--c-danger); }
  .toast--info    { border-color: var(--vscode-focusBorder); }
  .toast-ico { flex: none; font-weight: 700; line-height: 1.4; }
  .toast--success .toast-ico { color: var(--c-done); }
  .toast--error .toast-ico   { color: var(--c-danger); }
  .toast--info .toast-ico    { color: var(--vscode-focusBorder); }
  .toast-msg { flex: 1; }
  .toast-action { flex: none; align-self: flex-start; cursor: pointer; font-size: 11px;
    padding: 2px 8px; border-radius: 4px; white-space: nowrap;
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-textLink-foreground));
    border: 1px solid var(--vscode-button-border, var(--vscode-panel-border)); }
  .toast-action:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }

  .card-check { flex: 0 0 auto; margin: 0 6px 0 0; cursor: pointer;
    accent-color: var(--vscode-button-background); }
  .batch-bar { position: sticky; bottom: 0; z-index: 2; display: flex; align-items: center; gap: 8px;
    margin-top: 6px; padding: 8px 10px;
    background: var(--vscode-sideBar-background);
    border-top: 1px solid var(--vscode-panel-border); }
  .batch-count { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .batch-selectall, .batch-clear { background: none; border: none; cursor: pointer; padding: 0;
    font-size: 11px; color: var(--vscode-textLink-foreground); }
  /* The sticky bar's one action, directly beneath a column of teal Take buttons —
     the same verb, so the same fill. */
  .batch-launch { margin-left: auto; display: inline-flex; align-items: center; gap: 5px;
    font-size: 12px; padding: 4px 12px; border-radius: 8px; border: none; cursor: pointer;
    background: var(--brand); color: var(--brand-ink); }
  .batch-launch:hover { background: color-mix(in srgb, var(--brand) 84%, var(--vscode-foreground)); }
`;
