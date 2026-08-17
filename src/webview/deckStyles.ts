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
  html, body { height: 100%; }
  body { margin: 0;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    overflow: hidden; }
  #root { height: 100vh; display: flex; flex-direction: column; }

  :root {
    /* Six rows, plus a deliberate half-row peek: a clean cut at a row boundary reads as
       "the list ends here", where a sliced row reads as "there is more" — and that is the
       only scroll hint this container gets. Derived, so the intent survives a row-height
       change: --t-body plus .rv-line's 6px padding top and bottom is ~26px. */
    --rv-row-h: 26px;
  }

  /* Wraps, always. The row is the panel's widest object and gains controls over
     time; without this it clips its right end off-screen instead of folding.
     gap's shorthand form sets row-gap and column-gap in one value, so it is
     also the safe way to give them different sizes — a separate row-gap
     declaration ahead of a shorthand gap would be silently overwritten. */
  .hd { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px;
    padding: 13px 20px; border-bottom: 1px solid var(--hair); }
  /* The gloss sits under the label, not beside it: stacked, the two lines read as one
     title block instead of a sentence that happens to change weight mid-way. Free
     vertically — the stat tiles next to it already set the header's height. */
  .hd .title { font-size: 15px; font-weight: 600; letter-spacing: -.012em; white-space: nowrap;
    line-height: 1.3; }
  .hd .title .sub { display: block; color: var(--dim); font-weight: 400; font-size: 12px;
    letter-spacing: 0; line-height: 1.3; }
  /* Wraps under the title rather than clipping: the tiles are an unshrinkable
     block on their own, and a header that only folded around them (via .hd's
     own flex-wrap) would still lose its right edge below ~400px. */
  .stats { display: flex; flex-wrap: wrap; align-items: stretch; gap: 6px; }
  /* Sentence case, matching the column headers: these three tiles name three of
     the board's four columns — Done has no tile, since a done card needs
     nothing counted for you — and name the ones they share the same way, which
     used to differ in case. */
  .stat { display: flex; flex-direction: column; gap: 2px; padding: 4px 11px 5px; border-radius: 8px;
    border: 1px solid var(--edge); background: var(--vscode-editorWidget-background, transparent); }
  .stat .n { font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.05;
    letter-spacing: -.02em; }
  .stat .l { font-size: var(--t-micro); color: var(--dim); letter-spacing: .01em; white-space: nowrap; }
  .stat.attn { border-color: color-mix(in srgb, var(--c-attn) 55%, var(--hair)); }
  .stat.attn .n { color: var(--c-attn); }
  .stat.attn .l { color: color-mix(in srgb, var(--c-attn) 70%, var(--dim)); }
  .hd .sp { flex: 1; }

  /* The header's one remaining .ctls user is the Agents/Workspaces lens: a joined
     frame reads as one control with two positions rather than two loose buttons. */
  .ctls { display: inline-flex; flex: none; border: 1px solid var(--edge); border-radius: var(--r-ctl); overflow: hidden; }
  .ctls .ctl { border: 0; border-radius: 0; }
  .ctls .ctl + .ctl { box-shadow: inset 1px 0 0 var(--edge); }
  /* .ctls clips its children against its own radius, which also clips an outward
     focus ring drawn by :focus-visible. Draw it inside instead. */
  .ctls .ctl:focus-visible { outline-offset: -2px; }
  .ctl { display: inline-flex; align-items: center; gap: 7px; height: 26px; cursor: pointer; user-select: none;
    font-size: var(--t-body); padding: 0 10px; border-radius: var(--r-ctl); white-space: nowrap;
    border: 1px solid var(--edge); background: transparent; color: var(--dim);
    transition: color .12s ease, background-color .12s ease; }
  .ctl:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
  .ctl.on { color: var(--vscode-foreground); }
  /* With the switch tracks gone, .act.primary is the only surface left that spends
     --brand — every control on this board that isn't it stays monochrome, which is
     exactly the one-primary-per-surface rule the switch used to need an exception to. */
  /* A segmented control, not a switch: .ctls already draws the joined frame, so
     the active side only needs to read as pressed. */
  .ctls.seg .ctl.on { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
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
  /* A band inside a column. Deliberately quieter than .col-hd — no dot, no sticky, lowercase
     from the markup — so the column header still reads as the heading and this reads as a
     divider under it. The first lane sits tight to the column header; later ones open a gap
     so the break between bands is visible without a heavier rule. */
  .lane-hd { display: flex; align-items: center; gap: 7px; flex: none;
    padding: 2px 2px 0; color: var(--dim); font-size: var(--t-micro); }
  .lane-hd:not(:first-child) { margin-top: 6px; }
  .lane-hd .nm { letter-spacing: .01em; white-space: nowrap; }
  .lane-hd .ct { font-variant-numeric: tabular-nums; }
  .lane-hd .rule { flex: 1; height: 1px; background: var(--hair); }
  /* The one lane that is good news — an approved, green, conflict-free PR, or a run that
     actually landed. Nothing here is a failure, so nothing here is red. */
  .lane-hd.up { color: var(--c-done); font-weight: 600; }
  .lane-hd.up .rule { background: color-mix(in srgb, var(--c-done) 30%, var(--hair)); }

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
  /* Wraps for the agent name only: state and ticket always share line one, and
     the name drops beneath the ticket when the column is too narrow for three —
     which beats ellipsizing an identifier, and costs no height when it fits. */
  .c-top { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; row-gap: 2px; min-width: 0; }
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
  /* The refresh button's glyph at rest. It no longer turns: the mark takes over
     while a refresh is in flight, so nothing sets an "on" modifier any more. */
  .spin { display: inline-block; font-size: 12px; }

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

  /* The workspace chip and its fold. The name is an identifier, so it is mono;
     "2 repos" is prose, so it is not. The fold is in the DOM at rest and hidden
     with display:none — a card that has to grow anyway on hover should not also
     pay for a mount. */
  .c-ws { margin-top: 7px; }
  .ws { display: inline-flex; align-items: baseline; gap: 5px; font-size: var(--t-data);
    color: var(--dim); background: none; border: 1px solid var(--hair); border-radius: var(--r-chip);
    padding: 1px 6px; cursor: pointer; }
  .ws:hover { border-color: color-mix(in srgb, var(--vscode-foreground) 25%, transparent); }
  .ws .wsi { font-size: 9px; color: color-mix(in srgb, var(--vscode-foreground) 40%, transparent); }
  .ws .n { font-family: var(--mono); color: color-mix(in srgb, var(--vscode-foreground) 82%, transparent); }
  .ws-fold { display: none; margin-top: 6px; flex-wrap: wrap; gap: 5px 7px; }
  .c-ws:hover .ws-fold, .c-ws:focus-within .ws-fold, .c-ws.open .ws-fold { display: flex; }

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

  /* Still live: it moved off the card's old .c-foot into the drawer header,
     where it carries the run's tracker status (DeckDetail.tsx's .dd-hd .pill). */
  .pill { flex: 0 1 auto; min-width: 0; font-size: var(--t-body);
    border: 1px solid var(--hair); border-radius: 20px; padding: 1px 9px;
    color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* One button language, three weights of the same 26px shape. The primary is a quiet
     raised surface at rest and only takes the theme's button color under the pointer:
     an Open slab on every card is ambient noise, not emphasis. */
  .act:not(.primary) { opacity: .7; transition: opacity .12s ease; }
  .card:hover .act, .card:focus-within .act { opacity: 1; }
  .act { display: inline-flex; align-items: center; gap: 6px; font-size: var(--t-body); font-weight: 500;
    height: 26px; padding: 0 11px; border-radius: var(--r-ctl); cursor: pointer; white-space: nowrap;
    border: 1px solid var(--edge); background: transparent; color: var(--vscode-foreground);
    transition: background-color .12s ease, border-color .12s ease, color .12s ease; }
  .act:hover { background: var(--vscode-toolbar-hoverBackground); border-color: color-mix(in srgb, var(--vscode-foreground) 30%, transparent); }
  .act.primary { font-weight: 600;
    background: color-mix(in srgb, var(--brand) 13%, transparent);
    border-color: color-mix(in srgb, var(--brand) 52%, transparent);
    color: color-mix(in srgb, var(--brand) 72%, var(--vscode-foreground)); }
  /* Same hue, more of it — matching how .take and .btn.pri escalate on hover. The
     ordinary primary stays teal under the pointer instead of swapping to the
     theme's own button blue. */
  .act.primary:hover { background: color-mix(in srgb, var(--brand) 22%, transparent);
    border-color: color-mix(in srgb, var(--brand) 68%, transparent);
    color: color-mix(in srgb, var(--brand) 84%, var(--vscode-foreground)); }
  /* The board's only colored call to action, on the only card that is asking for one.
     Outlined rather than filled on purpose: a theme owns charts.orange, and it ranges
     from pale amber to burnt sienna, so no fixed ink is legible on all of them. Mixing
     the label toward the theme's own foreground self-corrects — it darkens the orange on
     a light theme and lightens it on a dark one, clearing 5:1 either way. This rule has
     no :hover of its own, and its selector out-specifies .act.primary:hover (four class
     steps against three), so hovering an attn card's primary keeps these rest colors
     rather than picking up the ordinary primary's teal escalation — attn and ordinary
     differ in hue, hovered or not. */
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
  .rv-repo, .rv-num, .rv-size, .rv-diff, .rv-line .add, .rv-line .del {
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

  /* Fixed widths so the row's fields stack into real columns down the strip.
     Sized naturally they were ragged — "+3923 −1998" and "+106 −0" share no
     width, and neither do two repo names — so every line had to be re-parsed
     from scratch. Widths are in ch on the mono fields, which makes them track
     the editor font rather than a hardcoded pixel guess.

     The repo is the one that truncates: names run past 18ch, but the alternative
     is a ragged left edge on the title, which is the field that actually gets
     read. Row markup carries a title attribute so a clipped name stays legible. */
  .rv-repo   { width: 18ch; overflow: hidden; text-overflow: ellipsis; }
  .rv-num    { width: 6ch; text-align: right; }
  .rv-size   { width: 1.5ch; text-align: center; }
  .rv-diff   { width: 12ch; display: inline-flex; justify-content: flex-end; gap: 5px; }
  .rv-files  { width: 52px; text-align: right; }
  /* The only one of these that had no flex rule of its own before — the mono
     badges and the .rv-files/.rv-author/.rv-age group each already carry one. */
  .rv-ci     { flex: none; width: 12px; text-align: center; }
  .rv-author { width: 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rv-age    { width: 26px; text-align: right; }

  /* Under ~860px the fixed columns plus a readable title no longer fit, and the
     title — the only element that can shrink — would be squeezed to nothing while
     the badges held their reserved width. Releasing them restores the pre-column
     behaviour, where the title absorbs the squeeze through its own ellipsis. */
  @media (max-width: 860px) {
    .rv-repo, .rv-num, .rv-size, .rv-diff, .rv-files, .rv-ci, .rv-author, .rv-age { width: auto; }
  }

  /* Placeholder rows while the first search runs. No hover and no pointer: they
     are not rows you can open. The shimmer is animation-only, so BASE_CSS's
     reduced-motion rule flattens it to a static bar without anything here — this
     sheet must not restate that query (tokens.test.ts enforces it). */
  /* align-items: center, not the row's usual baseline — these bars have no text,
     so there is no baseline to sit on and they would hang off the top of the line. */
  .rv-line.rv-skel { cursor: default; align-items: center; }
  .rv-line.rv-skel:hover { background: none; }
  .sk { display: inline-block; height: 9px; border-radius: 3px;
    background: linear-gradient(90deg,
      color-mix(in srgb, var(--vscode-foreground) 7%, transparent) 25%,
      color-mix(in srgb, var(--vscode-foreground) 14%, transparent) 50%,
      color-mix(in srgb, var(--vscode-foreground) 7%, transparent) 75%);
    background-size: 200% 100%; animation: shimmer 1.4s linear infinite; }
  @keyframes shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
  .sk-repo { flex: none; width: 110px; }
  /* Staggered so three identical bars don't read as a table that failed to load.
     :nth-child on .rv-row, not .sk — every skeleton line has the same structure. */
  .rv-row:nth-child(2) .sk-title { max-width: 55%; }
  .rv-row:nth-child(3) .sk-title { max-width: 78%; }
  .sk-title { flex: 1; min-width: 0; }
  .sk-meta { flex: none; width: 120px; }

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

  /* ── Recently closed ──────────────────────────────────────────────────
     Everything that left the board. Quiet by construction: no accent, no
     saturated color, row actions revealed only on hover or focus. Saturated
     color is spent on attention debt, and a closed run owes nothing. */
  .rc { margin: 10px 14px 0; border-top: 1px solid var(--vscode-panel-border); }
  .rc-hd { display: flex; align-items: center; padding: 3px 0; }
  .rc-toggle { display: flex; align-items: center; gap: 8px; background: none;
    border: 0; padding: 6px 2px; cursor: pointer; font: inherit; text-align: left;
    color: var(--vscode-descriptionForeground); }
  .rc-toggle:hover { color: var(--vscode-foreground); }
  .rc-caret { font-size: 9px; opacity: .8; }
  .rc-nm { color: var(--vscode-foreground); }
  /* A count is a number, so it earns the mono treatment; the label beside it is
     prose and must not. */
  .rc-ct { font-family: var(--vscode-editor-font-family); font-size: 11px; opacity: .75; }
  .rc-sp { flex: 1; }
  .rc-clear { background: none; border: 0; color: var(--vscode-descriptionForeground);
    font: inherit; font-size: 11px; cursor: pointer; padding: 2px 6px; border-radius: 4px; }
  .rc-clear:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
  .rc-rows { display: flex; flex-direction: column; padding-bottom: 8px; }
  .rc-row { display: flex; align-items: center; gap: 10px; padding: 5px 4px;
    border-radius: 4px; font-size: 12px; }
  .rc-row:hover { background: var(--vscode-list-hoverBackground); }
  .rc-row .sdot { flex: none; }
  .rc-key { font-family: var(--vscode-editor-font-family); font-size: 11px;
    color: var(--vscode-descriptionForeground); flex: none; min-width: 84px; }
  .rc-ttl { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rc-when { color: var(--vscode-descriptionForeground); font-size: 11px; flex: none; }
  .rc-act { background: none; border: 1px solid var(--vscode-panel-border);
    border-radius: 4px; color: var(--vscode-descriptionForeground); font: inherit;
    font-size: 11px; padding: 1px 7px; cursor: pointer; flex: none; opacity: 0; }
  .rc-row:hover .rc-act, .rc-act:focus { opacity: 1; }
  .rc-act:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }

  /* The selected card's detail. Same geometry as the Orchestrator drawer — below
     the header, anchored right, no scrim — because it is the same kind of object
     and the two are mutually exclusive. 460px is the narrowest width at which a
     .pr-block's label column and value column both fit without wrapping. */
  /* \`hidden auto\`, not \`auto\`: the drawer is a fixed-width panel of rows that all
     ellipsize, so sideways scroll here is never a feature — it is always a row that
     failed to shrink (a long mono key did exactly that), and it takes the close
     button off-screen with it. Vertical scroll is the only axis it needs. */
  .dd { position: fixed; top: 53px; right: 0; bottom: 0; width: 460px; z-index: 40;
    display: flex; flex-direction: column; overflow: hidden auto;
    background: var(--vscode-editorWidget-background);
    border-left: 1px solid var(--hair); box-shadow: -10px 0 26px rgba(0,0,0,.28); }
  .dd-hd { display: flex; align-items: center; gap: 8px; padding: 9px 12px;
    border-bottom: 1px solid var(--hair); }
  /* \`max-width\` is load-bearing: a nowrap flex item's automatic minimum size is its
     full text width, so an unbounded key could not shrink and any key wider than the
     drawer pushed the row past 460px instead of ellipsizing. Capping it — rather than
     letting it shrink with \`min-width: 0\` — is what keeps a short key whole: under
     free shrinking, "notepad" beside a long summary came out as "not…". Half the
     header is the widest a key can be before it stops being context for the summary
     and starts replacing it. \`flex: none\` so it is the cap, not the summary, that
     decides: the summary ellipsizes first, and the key only past 50%. */
  .dd-hd .k { font-family: var(--vscode-editor-font-family); font-size: 12px; white-space: nowrap;
    flex: none; max-width: 50%; overflow: hidden; text-overflow: ellipsis; }
  .dd-hd .t { font-size: var(--t-body); color: var(--dim);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dd-x { margin-left: auto; background: none; border: none; cursor: pointer;
    color: var(--dim); font-size: 13px; padding: 2px 5px; }
  .dd-x:hover { color: var(--vscode-foreground); }
  .dd-sec { padding: 10px 12px; }
  .dd-sec + .dd-sec { border-top: 1px solid var(--hair); }
  .dd-lbl { font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase;
    color: var(--dim); opacity: .8; margin-bottom: 7px; }
  .dd-count { padding: 9px 12px 0; margin: 0; }
  .dd-none { font-size: var(--t-body); color: var(--dim); }
  /* A list row, not a button slab: twelve bordered controls in a column would
     read as twelve competing calls to action. */
  .dd-act { display: flex; align-items: baseline; gap: 8px; width: 100%; text-align: left;
    background: none; border: none; border-radius: var(--r-ctl); cursor: pointer;
    padding: 5px 7px; color: var(--vscode-foreground); font-size: var(--t-body); }
  .dd-act:hover { background: var(--vscode-toolbar-hoverBackground); }
  .dd-act:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .dd-act.danger { color: var(--c-attn); }
  /* UI font by default: most hints ("already running", "give this place a
     ticket") read as English. The .id modifier overrides to mono for the
     hints that are actually identifiers — a branch, a ticket key, a PR
     number, a path. */
  .dd-act .h { margin-left: auto;
    font-size: 11.5px; color: var(--dim);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dd-act .h.id { font-family: var(--vscode-editor-font-family); }

  /* One child worktree, same list-row shape as .dd-act. The drawer already
     proved (in the .dd-hd .k comment above) that a nowrap flex item's automatic
     minimum is its own text width — a long branch or key here would reopen that
     same horizontal-scroll bug unless it can shrink. \`.t\`'s \`flex: 1\` gives it
     a zero flex-basis, so it absorbs the shrinking before \`.k\`/\`.bn\` ever have
     to; \`overflow: hidden\` on all three zeroes their automatic minimum too, so
     even a row where the key and branch alone are wider than the drawer
     ellipsizes instead of pushing the row (and the drawer) sideways. */
  .dd-child { display: flex; align-items: baseline; gap: 6px; width: 100%; text-align: left;
    background: none; border: 0; padding: 3px 0; color: inherit; cursor: pointer; min-width: 0; }
  .dd-child:hover { background: var(--vscode-list-hoverBackground); }
  .dd-child .k { flex: none; font-family: var(--vscode-editor-font-family); font-size: 11px; opacity: .85;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dd-child .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dd-child .bn { flex: none; font-family: var(--vscode-editor-font-family); font-size: 11px; opacity: .7;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* At any realistic panel width there is no arrangement in which four columns
     and a 460px drawer all fit — something is always off-screen. .board is
     already a horizontal scroller, so this does not MOVE the columns: it adds
     scroll run-out past the last one, which is what lets a covered column be
     scrolled clear of the drawer. Nothing becomes unreachable. */
  .board.dd-open { padding-right: 470px; }

  /* The two-tier card. A floor with no flex column would hang dead space under
     the last row; making the card a column is what lets the footer's margin-top:
     auto seat it on the bottom edge, so a card taller than its content reads as
     deliberately that tall rather than as one that ran out of things to say.
     152px is the approved density — 132 crowds a two-line title, 176 leaves a
     hollow middle on the one-line cards that dominate a real board. */
  .card { display: flex; flex-direction: column; min-height: 152px;
    padding: 13px 14px 13px 16px; gap: 9px; cursor: pointer; }
  .col-body { gap: 14px; }
  /* Under the card's own flex column, margins between children don't collapse —
     they add to .card's 9px gap — so .c-title's own margin-top: 5px (set before
     the card was a flex column) would ship the top-to-title gap at 14px against
     the approved 9px. Zeroing it here is what makes the gap exactly 9px. */
  .c-title { line-height: 1.45; margin-top: 0; }
  .card.sel { border-color: var(--vscode-focusBorder);
    background: color-mix(in srgb, var(--vscode-focusBorder) 7%, var(--vscode-editor-background)); }
  .card.sel::before { opacity: 1; width: 3px; }
  /* .card.attn:hover is (0,3,0) against .card.sel's (0,2,0), so without this a
     selected Action-required card would revert to the attn hover tint the
     moment the pointer sits on it. Same specificity as .card.attn:hover
     (0,3,0), and declared after it, so the selected state wins the tie
     whether or not the card is also hovered — without weakening .card.attn's
     own hover treatment for a card that isn't selected. */
  .card.attn.sel { border-color: var(--vscode-focusBorder); }

  /* One line, always. The three-bit cap in cardSignal is not enough on its own —
     a long branch name still pushes the third bit onto a second row — so the line
     never wraps and the one elastic bit (the mono branch) takes the ellipsis. */
  .c-sig { display: flex; align-items: center; gap: 7px; flex-wrap: nowrap; overflow: hidden;
    font-size: 11.5px; color: var(--dim); }
  .c-sig > * { flex: none; white-space: nowrap; }
  .c-sig .m { font-family: var(--vscode-editor-font-family);
    flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .c-sig .sep { opacity: .45; }
  .c-sig .bad, .c-sig .warn { color: var(--c-attn); }
  .c-sig .ok { color: var(--c-done); }
  .c-diff { display: inline-flex; gap: 5px; font-family: var(--vscode-editor-font-family); }
  .c-diff .add { color: var(--c-done); }
  .c-diff .del { color: var(--c-danger); }

  .c-foot2 { display: flex; gap: 5px; margin-top: auto; padding-top: 2px; }
`;
