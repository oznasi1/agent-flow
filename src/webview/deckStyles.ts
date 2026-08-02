// Injected into the Deck panel <head>. Uses VS Code theme variables so the board
// matches the editor theme (light or dark), with a few semantic status accents.
//
// Two rules hold the look together, and both are easy to break by accident:
//
// 1. Monospace is for identifiers and counts only — issue keys, branches, repo
//    names, diff numbers, PR fields. Anything that reads as English ("ended turn ·
//    4m ago", "launched 22m ago", "In Progress") is set in the UI font. Setting
//    prose in mono is what made this board read as a log dump.
// 2. Saturated color is spent on attention debt. A card that needs nothing from you
//    is monochrome until you point at it; the one asking for you carries the orange.
//    That is why the primary button is a quiet surface everywhere except in Action
//    required — six identical bright slabs signal nothing.
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
    /* Column accents. */
    --c-progress: var(--vscode-charts-blue, #4aa3df);
    --c-attn:    var(--vscode-charts-orange, #e0913a);
    --c-review:  var(--vscode-charts-purple, #b083f0);
    --c-done:    var(--vscode-charts-green, #4ac26b);
    /* Warm but passive: an idle agent or an uncommitted file is worth noticing, not
       worth acting on. Deliberately paler than --c-attn, which is the call to act. */
    --c-idle:    var(--vscode-charts-yellow, #d7a531);
    /* Something is actually broken or destructive: failing checks, deletions, Forget. */
    --c-danger:  var(--vscode-charts-red, #e5534b);

    --hair: var(--vscode-panel-border);
    /* Controls need an edge that survives sitting on a card, which is already 4%
       lighter than the editor background — panelBorder disappears against it, which is
       what made Diff look like a bare label next to Open. */
    --edge: color-mix(in srgb, var(--vscode-foreground) 16%, transparent);
    --mono: var(--vscode-editor-font-family, ui-monospace, monospace);
    --dim: var(--vscode-descriptionForeground);

    /* Type scale. Four steps plus the two header sizes — every font-size below is
       one of these, so a new element can't quietly invent a seventh. */
    --t-micro: 10px;   /* stat labels, branch */
    --t-data: 10.5px;  /* mono identifiers, PR table */
    --t-body: 11px;    /* status, meta, controls, legend */
    --t-title: 13px;   /* card summary */

    /* One radius per role. */
    --r-card: 10px;
    --r-ctl: 6px;
    --r-chip: 5px;

    /* Six rows, plus a deliberate half-row peek: a clean cut at a row boundary reads as
       "the list ends here", where a sliced row reads as "there is more" — and that is the
       only scroll hint this container gets. Derived, so the intent survives a row-height
       change: --t-body plus .rv-line's 6px padding top and bottom is ~26px. */
    --rv-row-h: 26px;
  }

  .hd { flex: none; display: flex; align-items: center; gap: 14px;
    padding: 13px 20px; border-bottom: 1px solid var(--hair); }
  .hd .title { font-size: 15px; font-weight: 600; letter-spacing: -.012em; white-space: nowrap; }
  .hd .title .sub { color: var(--dim); font-weight: 400; margin-left: 7px; font-size: 12px; letter-spacing: 0; }
  .stats { display: flex; align-items: stretch; gap: 6px; }
  /* Sentence case, matching the column headers: these four tiles and those four
     headers name the same four things, and used to do it in two different cases. */
  .stat { display: flex; flex-direction: column; gap: 2px; padding: 4px 11px 5px; border-radius: 8px;
    border: 1px solid var(--edge); background: var(--vscode-editorWidget-background, transparent); }
  .stat .n { font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.05;
    letter-spacing: -.02em; }
  .stat .l { font-size: var(--t-micro); color: var(--dim); letter-spacing: .01em; white-space: nowrap; }
  .stat.attn { border-color: color-mix(in srgb, var(--c-attn) 55%, var(--hair)); }
  .stat.attn .n { color: var(--c-attn); }
  .stat.attn .l { color: color-mix(in srgb, var(--c-attn) 70%, var(--dim)); }
  .hd .sp { flex: 1; }

  /* Two toggles that answer the same question — how much should the board trust? —
     read as one object rather than three separate pills next to the refresh control. */
  .ctls { display: inline-flex; flex: none; border: 1px solid var(--edge); border-radius: var(--r-ctl); overflow: hidden; }
  .ctls .ctl { border: 0; border-radius: 0; }
  .ctls .ctl + .ctl { box-shadow: inset 1px 0 0 var(--edge); }
  .ctl { display: inline-flex; align-items: center; gap: 7px; height: 26px; cursor: pointer; user-select: none;
    font-size: var(--t-body); padding: 0 10px; border-radius: var(--r-ctl); white-space: nowrap;
    border: 1px solid var(--edge); background: transparent; color: var(--dim);
    transition: color .12s ease, background-color .12s ease; }
  .ctl:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
  .ctl.on { color: var(--vscode-foreground); }
  .switch { width: 24px; height: 14px; border-radius: 10px; background: var(--vscode-input-background);
    border: 1px solid var(--hair); position: relative; flex: none; transition: background .15s; }
  .switch::after { content: ""; position: absolute; top: 1px; left: 1px; width: 10px; height: 10px;
    border-radius: 50%; background: var(--dim); transition: transform .15s, background .15s; }
  .ctl.on .switch { background: var(--vscode-button-background); border-color: var(--vscode-button-background); }
  .ctl.on .switch::after { transform: translateX(10px); background: var(--vscode-button-foreground); }
  /* tabular-nums, not mono: "synced 4s ago" is a sentence, but its number ticks every
     second and must not reflow the control while it does. */
  .synced { font-size: var(--t-body); font-variant-numeric: tabular-nums; }

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
  .col-hd .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .col-hd .nm { font-size: 12px; font-weight: 600; letter-spacing: -.005em; white-space: nowrap; }
  .col-hd .ct { font-size: var(--t-micro); font-variant-numeric: tabular-nums; color: var(--dim);
    border: 1px solid var(--hair); border-radius: 20px; padding: 1px 7px; line-height: 1.3; }
  .col-hd .rule { flex: 1; height: 1px; background: var(--hair); }
  .col-body { display: flex; flex-direction: column; gap: 10px; padding: 1px 3px 3px; }

  /* \`flex: none\` is load-bearing: .card sets overflow:hidden to clip the accent rail, which
     zeroes its automatic minimum size — without it the flex column squeezes every card and
     clips its content instead of growing the column. */
  .card { position: relative; flex: none; border: 1px solid var(--hair); border-radius: var(--r-card);
    background: color-mix(in srgb, var(--vscode-foreground) 4%, var(--vscode-editor-background));
    padding: 10px 12px 9px 14px; overflow: hidden;
    transition: border-color .12s ease, background-color .12s ease; }
  /* The rail is the column's accent restated on the card, quiet enough to be structure
     rather than decoration — but not so quiet that a light theme's darker chart colors
     fade it out at 30%. */
  .card::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2px; background: var(--accent); opacity: .42; }
  /* The one card asking for you: full-strength rail, a warm wash, and a tinted border.
     Three quiet reinforcements of one signal rather than a single loud one. */
  .card.attn::before { width: 3px; opacity: 1; }
  .card.attn { background: color-mix(in srgb, var(--c-attn) 4%, var(--vscode-editor-background));
    border-color: color-mix(in srgb, var(--c-attn) 34%, var(--hair)); }
  .card:hover { border-color: color-mix(in srgb, var(--vscode-foreground) 25%, transparent); }
  .card.attn:hover { border-color: color-mix(in srgb, var(--c-attn) 55%, var(--hair)); }
  .card:focus-within { border-color: var(--vscode-focusBorder); }

  /* State leads every card from the same x, so a column scans as one strip of status. */
  .c-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .status { display: inline-flex; align-items: center; gap: 6px; min-width: 0; flex: 0 1 auto;
    font-size: var(--t-body); color: var(--dim); font-variant-numeric: tabular-nums;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* Weight, not just hue — the one status the board wants you to read. */
  .status.tone-attn { color: var(--c-attn); font-weight: 600; }
  /* An identifier: mono, and the only thing on this row that is. */
  .key { margin-left: auto; flex: 0 1 auto; min-width: 0; max-width: 46%; font-family: var(--mono); font-size: var(--t-data);
    padding: 0; border: 0; background: none; color: var(--dim); cursor: pointer;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .key:hover { color: var(--vscode-textLink-foreground, var(--vscode-foreground)); }
  /* Inherits .key's layout so the chip sits at the same x as every other card's
     key; drops the affordances, because there is nothing to click through to. */
  .key.untracked { cursor: default; opacity: .75; }
  .key.untracked:hover { color: var(--dim); }
  /* A muted marker on a card, never a status: "local", "~inferred". Nothing here
     is red — a discovered card is not a failure. */
  .chip { display: inline-block; margin-right: 6px; padding: 0 5px; border-radius: 3px;
    border: 1px solid var(--vscode-panel-border, var(--dim)); color: var(--dim);
    font-size: var(--t-data); opacity: .8; vertical-align: baseline; }
  .key-wrap { margin-left: auto; display: flex; align-items: baseline; gap: 4px; min-width: 0; }
  .key-wrap .key { margin-left: 0; }
  .sdot { width: 7px; height: 7px; border-radius: 50%; background: var(--dim); flex: none; }
  .sdot.tone-working { background: var(--c-done); }
  .sdot.tone-idle    { background: var(--c-idle); }
  .sdot.tone-attn    { background: var(--c-attn); }
  .sdot.tone-parked, .sdot.tone-merged { background: transparent; border: 1.5px solid var(--dim); }
  .sdot.pulse { animation: pulse 1.7s ease-out infinite; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 var(--c-done); } 70% { box-shadow: 0 0 0 5px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
  .spin { display: inline-block; font-size: 12px; }
  .spin.on { animation: spin .9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Clamped so long summaries can't stretch one card out of the column's rhythm; the full
     text stays available on hover. */
  .c-title { margin-top: 5px; font-size: var(--t-title); font-weight: 550; line-height: 1.42; letter-spacing: -.008em;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }

  .c-branch { margin-top: 7px; display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .c-branch .bn { font-family: var(--mono); font-size: var(--t-data); color: var(--dim);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* "launched 22m ago" is English; only its number needs to hold its width. */
  .elapsed { margin-left: auto; flex: none; font-size: var(--t-body); color: var(--dim);
    font-variant-numeric: tabular-nums; }

  .c-repos { display: flex; align-items: center; flex-wrap: wrap; gap: 5px 7px; margin-top: 7px; }
  .repo { display: inline-flex; align-items: baseline; gap: 5px; font-family: var(--mono); font-size: var(--t-data);
    border: 1px solid var(--hair); border-radius: var(--r-chip);
    padding: 1px 6px; color: var(--dim); font-variant-numeric: tabular-nums; }
  .repo .add { color: var(--c-done); } .repo .del { color: var(--c-danger); }
  .repo .dirty { color: var(--c-idle); }

  /* Agents open in this card's directories. Names are identifiers, so mono; the
     row is a control, so it takes the same focus treatment as .act. */
  .c-agents { margin-top: 7px; }
  .ag-toggle { display: flex; align-items: center; gap: 5px; width: 100%; padding: 0;
    background: none; border: 0; color: var(--dim); font: inherit; font-size: var(--t-data);
    cursor: pointer; text-align: left; }
  .ag-toggle:hover { color: var(--vscode-foreground); }
  .ag-caret { flex: none; width: 9px; }
  /* .ag-label is layout only. Mono is for identifiers, and this text isn't always
     one — "3 agents" is a count, only a solo session's own name (.id) is an
     identifier — so the typeface follows AgentsRow's own call, not the class. */
  .ag-label.id { font-family: var(--mono); }
  .ag-row { display: flex; align-items: center; gap: 6px; margin: 4px 0 0 14px;
    font-size: var(--t-data); color: var(--dim); min-width: 0; }
  .ag-name { font-family: var(--mono); color: var(--vscode-foreground);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ag-state.tone-attn { color: var(--c-attn); }
  .ag-age { margin-left: auto; flex: none; }
  .ag-open { flex: none; opacity: .7; }

  .c-foot { display: flex; align-items: center; gap: 8px; margin-top: 10px; min-width: 0; }
  .pill { flex: 0 1 auto; min-width: 0; font-size: var(--t-body);
    border: 1px solid var(--hair); border-radius: 20px; padding: 1px 9px;
    color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* One button language, three weights of the same 26px shape. The primary is a quiet
     raised surface at rest and only takes the theme's button color under the pointer:
     an Open slab on every card is ambient noise, not emphasis. The dimming lives on
     the buttons, not on .actions — opacity on the container would composite the whole
     subtree and make the overflow menu see-through. */
  .actions { margin-left: auto; flex: none; display: flex; align-items: center; gap: 5px; }
  .act:not(.primary), .more { opacity: .7; transition: opacity .12s ease; }
  .card:hover .act, .card:focus-within .act,
  .card:hover .more, .card:focus-within .more { opacity: 1; }
  .act { display: inline-flex; align-items: center; gap: 6px; font-size: var(--t-body); font-weight: 500;
    height: 26px; padding: 0 11px; border-radius: var(--r-ctl); cursor: pointer; white-space: nowrap;
    border: 1px solid var(--edge); background: transparent; color: var(--vscode-foreground);
    transition: background-color .12s ease, border-color .12s ease, color .12s ease; }
  .act:hover { background: var(--vscode-toolbar-hoverBackground); border-color: color-mix(in srgb, var(--vscode-foreground) 30%, transparent); }
  .act.primary { font-weight: 600;
    background: color-mix(in srgb, var(--vscode-foreground) 14%, var(--vscode-editor-background));
    border-color: color-mix(in srgb, var(--vscode-foreground) 28%, transparent); }
  .act.primary:hover { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border-color: var(--vscode-button-background); }
  /* The board's only colored call to action, on the only card that is asking for one.
     Outlined rather than filled on purpose: a theme owns charts.orange, and it ranges
     from pale amber to burnt sienna, so no fixed ink is legible on all of them. Mixing
     the label toward the theme's own foreground self-corrects — it darkens the orange on
     a light theme and lightens it on a dark one, clearing 5:1 either way. Hover is
     deliberately not overridden: every primary on the board fills with the theme's
     button colors, so the attn card differs only at rest. */
  .card.attn .act.primary { background: color-mix(in srgb, var(--c-attn) 12%, transparent);
    border-color: color-mix(in srgb, var(--c-attn) 60%, transparent);
    color: color-mix(in srgb, var(--c-attn) 78%, var(--vscode-foreground)); }
  /* This task already has a window open, so Open focuses it instead of opening another.
     A 5px marker plus the button's tooltip, where a whole line of green text used to be. */
  .act.live::before { content: ""; width: 5px; height: 5px; border-radius: 50%; flex: none;
    background: var(--c-done); }
  .card.attn .act.primary.live::before { background: currentColor; }

  /* Disabled means two different things on the review strip's verbs (an empty
     box, or a submit already in flight for the row) and previously looked
     identical to enabled — every color/background/cursor above was a fixed
     value, so the UA's own disabled rendering never had a chance to show
     through. Each selector below matches one of the compound forms above
     (plain, primary, primary-in-an-attn-card) so this wins regardless of the
     theme or which card the button sits on. */
  .act:disabled, .act:disabled:hover,
  .act.primary:disabled, .act.primary:disabled:hover,
  .card.attn .act.primary:disabled, .card.attn .act.primary:disabled:hover {
    cursor: default; color: var(--dim); background: transparent; border-color: var(--hair); }

  .more-wrap { position: relative; display: inline-flex; }
  .more { width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center;
    border: 0; background: none; border-radius: var(--r-ctl); color: var(--dim); cursor: pointer;
    font-size: 13px; line-height: 1; }
  .more:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
  .menu { position: absolute; right: 0; bottom: calc(100% + 5px); z-index: 20; min-width: 132px;
    border: 1px solid var(--hair); border-radius: 8px; padding: 4px;
    background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
    box-shadow: 0 8px 24px -10px rgba(0,0,0,.6); }
  .mi { display: block; width: 100%; text-align: left; font-size: 12px; padding: 6px 9px; border: 0;
    border-radius: var(--r-chip); cursor: pointer; background: none; color: var(--vscode-foreground); white-space: nowrap; }
  .mi:hover { background: var(--vscode-list-hoverBackground, var(--vscode-toolbar-hoverBackground)); }
  .mi.danger { color: var(--c-danger); }

  .empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 8px; color: var(--dim); text-align: center; padding: 40px; }
  .empty .big { font-size: 15px; font-weight: 550; letter-spacing: -.012em; color: var(--vscode-foreground); }

  .legend { flex: none; display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
    padding: 8px 20px; border-top: 1px solid var(--hair); font-size: var(--t-body); color: var(--dim); }
  .legend .lg { display: flex; align-items: center; gap: 6px; }
  .legend .lg .dot { width: 7px; height: 7px; border-radius: 50%; }
  .legend .note { margin-left: auto; }
  /* A path, so mono; the prose around it is not. */
  .legend .note .path { font-family: var(--mono); font-size: var(--t-data); }
  .legend .note.warn { color: var(--c-attn); margin-left: 0; }

  .toasts { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; gap: 6px; z-index: 50; }
  .toast { display: flex; align-items: center; gap: 10px; font-size: 12px; padding: 8px 14px; border-radius: 7px;
    border: 1px solid var(--hair); background: var(--vscode-notifications-background, var(--vscode-editorWidget-background));
    color: var(--vscode-foreground); box-shadow: 0 6px 20px -8px rgba(0,0,0,.5); }
  .toast.error { border-color: var(--c-danger); }
  .toast.success { border-color: var(--c-done); }
  .toast-msg { flex: 1; }
  /* A real button, not the toast's own onClick — Open PR must not be swallowed by a
     dismiss handler the toast doesn't even have here (unlike the sidebar's toast
     stack, this one only ever times out). */
  .toast-action { flex: none; font-size: var(--t-body); padding: 2px 9px; border-radius: var(--r-chip);
    cursor: pointer; background: transparent; color: var(--vscode-foreground); border: 1px solid var(--edge); }
  .toast-action:hover { background: var(--vscode-toolbar-hoverBackground); }

  .board::-webkit-scrollbar { width: 9px; height: 9px; }
  .board::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 8px; }
  .board::-webkit-scrollbar-corner { background: transparent; }

  /* The one place mono earns its keep on a card: four labelled rows whose values line
     up under each other, read as a table rather than as sentences. */
  .pr-block { margin-top: 8px; padding-top: 7px; border-top: 1px solid var(--hair);
    font-family: var(--mono); font-size: var(--t-data); font-variant-numeric: tabular-nums; }
  .pr-repo { color: var(--dim); margin-bottom: 2px; }
  .pr-line { display: flex; align-items: baseline; gap: 7px; line-height: 1.55; }
  .pr-lbl { width: 40px; flex: none; color: var(--dim); }
  .pr-link { background: none; border: 0; padding: 0; cursor: pointer; font: inherit;
    text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 2px; }
  .pr-ok { color: var(--c-done); }
  .pr-warn { color: var(--c-attn); }
  .pr-bad { color: var(--c-danger); }
  .pr-bad .pr-link { color: inherit; }
  .pr-wait { color: var(--dim); }
  .pr-draft { color: var(--dim); }

  /* The review queue: what other people are waiting on you for, above the board of
     what you are waiting on yourself. Inside the board's own 20px gutter, and
     flex: none so it never steals height from .board, which is the scrollport. */
  .rv-strip { flex: none; margin: 0 20px 10px; border: 1px solid var(--hair);
    border-radius: var(--r-card); overflow: hidden; }
  .rv-hd { display: flex; align-items: center; gap: 10px; padding: 7px 12px;
    font-size: var(--t-body); color: var(--dim); }
  .rv-toggle { display: inline-flex; align-items: center; gap: 6px; border: 0; background: none;
    padding: 0; cursor: pointer; font-size: var(--t-body); font-weight: 550;
    color: var(--vscode-foreground); }
  .rv-hd .sp { flex: 1; }
  .rv-sort { display: inline-flex; align-items: center; gap: 5px; }
  .rv-sort button { border: 0; background: none; padding: 0; cursor: pointer;
    font-size: var(--t-body); color: var(--dim); }
  .rv-sort button.on { color: var(--vscode-foreground); text-decoration: underline; text-underline-offset: 2px; }
  /* A queue we could not refresh is stale, not broken — attn, never danger. */
  .rv-note.warn { color: var(--c-attn); }

  /* Bounded, not hidden. Auto-collapsing a long queue met the "don't push the board
     off-screen" goal by defeating the feature's entire purpose — nine pending reviews
     opened as a bare count. A capped, scrolling list keeps the board's share of the
     window while every row stays one flick away. ~6 rows before it scrolls; the strip
     is the one place on this panel that owns a nested scroller, which is why the rule
     lives here rather than on .rv-strip. */
  .rv-rows { border-top: 1px solid var(--hair); max-height: calc(var(--rv-row-h) * 6.5);
    overflow-y: auto; overscroll-behavior: contain; }
  .rv-row + .rv-row { border-top: 1px solid var(--hair); }
  /* A button, so reset the button chrome and let it fill the row. outline-offset is
     negative because .rv-strip clips overflow — a ring drawn outside would vanish. */
  .rv-line { display: flex; align-items: baseline; gap: 8px; padding: 6px 12px; cursor: pointer;
    font-size: var(--t-body); font-variant-numeric: tabular-nums;
    width: 100%; text-align: left; background: none; border: 0; color: inherit; font-family: inherit;
    outline-offset: -2px; }
  .rv-line:hover { background: var(--vscode-list-hoverBackground, var(--vscode-toolbar-hoverBackground)); }
  .rv-caret { flex: none; width: 9px; color: var(--dim); }
  /* Identifiers and counts — the only mono on the row. The title and the handle
     beside them are English, and stay in the UI font. */
  /* flex: none + nowrap so a long title absorbs the squeeze through its own ellipsis
     rather than these badges wrapping to a second line in a narrow panel. */
  .rv-repo, .rv-num, .rv-size, .rv-line .add, .rv-line .del {
    font-family: var(--mono); font-size: var(--t-data); flex: none; white-space: nowrap; }
  .rv-repo, .rv-num { color: var(--dim); }
  .rv-size { font-weight: 600; color: var(--dim); }
  .rv-line .add { color: var(--c-done); }
  .rv-line .del { color: var(--c-danger); }
  .rv-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--vscode-foreground); }
  .rv-draft { flex: none; font-size: var(--t-micro); color: var(--dim);
    border: 1px solid var(--hair); border-radius: var(--r-chip); padding: 0 4px; }
  .rv-files, .rv-author, .rv-age { flex: none; color: var(--dim); }
  .rv-running { flex: none; color: var(--c-progress); }

  .rv-detail { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 8px 12px;
    padding: 2px 12px 9px 29px; font-size: var(--t-body); }
  .rv-facts { flex-basis: 100%; display: flex; align-items: baseline; gap: 6px; color: var(--dim); }
  /* Actions flow left, directly under the facts they belong to. \`margin-left: auto\`
     here reads as a bug in the common case: with no review box on the row yet, it
     strands a lone Open PR button ~700px away at the far right of an empty line,
     attached to nothing. Verified in the preview harness. When the box arrives it
     takes \`flex: 1\` on this same line and pushes the actions right on its own. */
  .rv-actions { margin-left: 0; flex: none; display: flex; align-items: center; gap: 5px; }
  .rv-facts.dim { font-style: italic; }
  .rv-sep { color: var(--dim); }
  /* .act dims to .7 unless it sits in a hovered .card. A row is not a card, so the
     rule never re-brightens and every button here would render permanently faded. */
  .rv-actions .act { opacity: 1; }

  /* .rv-actions is flex:none (never shrinks), so .rv-box was the row's only
     shrinkable item and absorbed the entire squeeze in a narrow panel — the
     field you type the review into became the smallest thing on the row,
     three-line-wrapping its own placeholder before the buttons gave up an inch.
     A basis plus a floor makes the row wrap (rv-detail is already flex-wrap)
     instead: min() keeps the floor from overflowing a container narrower than
     260px, rather than only ever protecting against the row's own siblings. */
  .rv-box { flex: 1 1 260px; min-width: min(260px, 100%); }
  .rv-box textarea { width: 100%; min-height: 46px; resize: vertical; font: inherit;
    font-size: var(--t-body); color: var(--vscode-input-foreground);
    background: var(--vscode-input-background); border: 1px solid var(--edge);
    border-radius: var(--r-ctl); padding: 5px 7px; }

  /* A failed submit's own line, full-width below the box and its verbs (flex-basis:
     100% wraps it under them, the same trick .rv-facts uses above). --c-attn, not
     --c-danger: nothing here is broken — GitHub may well have taken the review —
     this is "go check", the same register as the stale-queue note above. */
  .rv-fail { flex-basis: 100%; font-size: var(--t-body); color: var(--c-attn); }
`;
