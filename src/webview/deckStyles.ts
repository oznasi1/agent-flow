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
/** How long a drawer's slide takes, in ms. Declared HERE, beside the keyframes
 * it drives, and imported by `Drawer.tsx` rather than duplicated there: that
 * module holds a closing drawer mounted for exactly this long, so a number that
 * drifted from the CSS would either cut the slide off mid-flight or park an
 * invisible drawer in the DOM. This module imports nothing, so the dependency
 * only ever points one way. */
export const DRAWER_ANIM_MS = 180;

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
  .hd { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px;
    padding: 14px 20px 13px; border-bottom: 1px solid var(--hair); }
  /* The gloss sits under the label, not beside it: stacked, the two lines read as one
     title block instead of a sentence that happens to change weight mid-way. Free
     vertically — the stat tiles next to it already set the header's height. */
  /* 16px, not 15: the panel's lead and the stat figures beside it are what give the
     scale its range, so that --t-title can read as a title at 13.5px rather than as
     slightly-larger body. Tracking tightens as size grows. */
  .hd .title { font-size: 16px; font-weight: 620; letter-spacing: -.02em; white-space: nowrap;
    line-height: 1.3; }
  .hd .title .sub { display: block; color: color-mix(in srgb, var(--vscode-foreground) 45%, transparent);
    font-weight: 400; font-size: 11.5px; letter-spacing: 0; line-height: 1.3; }
  /* Wraps under the title rather than clipping: the tiles are an unshrinkable
     block on their own, and a header that only folded around them (via .hd's
     own flex-wrap) would still lose its right edge below ~400px. */
  .stats { display: flex; flex-wrap: wrap; align-items: stretch; gap: 2px; }
  /* Sentence case, matching the column headers: one tile per board column, named
     exactly as the column names itself. The two used to differ in case.

     No border and no ground: four outlines around four numbers rank nothing against
     anything, and the numbers are the tiles. The transparent border stays declared so
     the lit states below can colour it without shifting the tile by a pixel. It also
     wraps better under ~520px, where four bordered boxes folding read worse than four
     numbers folding. */
  .stat { display: flex; flex-direction: column; gap: 2px; padding: 4px 13px 5px; border-radius: var(--r-ctl);
    border: 1px solid transparent; background: transparent; }
  .stat .n { font-size: 19px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.05;
    letter-spacing: -.03em; }
  /* Same muted-suffix treatment as the card's own \`.spend .u\` — the unit reads
     as a footnote on the number, not a second figure. */
  .stat .n .u { font-family: var(--vscode-font-family); font-size: var(--t-micro); font-weight: 400;
    opacity: .55; margin-left: 2px; }
  .stat .l { font-size: var(--t-micro); color: var(--dim); letter-spacing: .01em; white-space: nowrap; }
  .stat.attn { border-color: color-mix(in srgb, var(--c-attn) 55%, var(--hair)); }
  .stat.attn .n { color: var(--c-attn); }
  .stat.attn .l { color: color-mix(in srgb, var(--c-attn) 70%, var(--dim)); }
  /* The good-news tile, in the merge column's own green. Two lit tiles is still the
     point — one says something is wrong, the other says something is at the merge,
     and they are the only two numbers on this header you can act on without opening
     anything — but they are no longer lit on identical terms: ink lights both, and
     the outline is now reserved for attention debt alone. Something ready to merge is
     good news, not a debt, and a second outlined tile is a second claim on the same
     glance. */
  .stat.up .n { color: var(--c-done); }
  .stat.up .l { color: color-mix(in srgb, var(--c-done) 70%, var(--dim)); }
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
  .board { flex: 1; min-height: 0; display: flex; align-items: flex-start; gap: 18px;
    padding: 0 20px 20px; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
  /* min-width: 0 keeps the fixed basis honest — a card's unbreakable branch/key text would
     otherwise raise the column's automatic minimum width and stretch the whole board. */
  .col { position: relative; flex: 0 0 318px; min-width: 0; display: flex; flex-direction: column; }
  /* Sticky so the column you're reading stays labelled once the board scrolls; opaque because
     cards pass underneath it. */
  .col-hd { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 8px;
    padding: 15px 0 8px; flex: none; background: var(--vscode-editor-background); }
  .col-hd .dot { order: -3; width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--zone); }
  /* The halo, on the zones where the dot means something is alive right now. A
     spread-only shadow rather than a blur ring: it reads as light coming off the
     dot at 8px, where a blurred ring reads as a smudge. Static, not animated —
     .sdot's pulse is reserved for one working agent, and four pulsing column
     headers would drown it. */
  .col-hd .dot.glow { box-shadow: 0 0 0 3px color-mix(in srgb, var(--zone) 26%, transparent),
    0 0 9px 1px color-mix(in srgb, var(--zone) 55%, transparent); }
  /* A heading, voiced as one: sentence case in the UI font at full-strength ink.
     This was mono uppercase micro in the zone's own hue, on the argument that a zone
     label is a coordinate rather than a heading — but it spent mono on English, which
     is rule #1 at the top of this file, and it left the board's largest structural
     labels quieter than the metadata inside the cards. The hue has not gone
     anywhere: the dot beside it carries it, and the footer legend names it. */
  .col-hd .nm { order: -2; font-family: inherit; font-size: 11.5px; font-weight: 600;
    text-transform: none; letter-spacing: -.008em; white-space: nowrap; color: var(--vscode-foreground); }
  /* Beside the label, not past the rule. Right-aligned it sat one board gap from the
     NEXT column's dot, so "7 ● Action required" read as one phrase — and the
     comparable column of counts that position bought is already paid for by the
     header's stat tiles, which are exactly that row of counts. The order values are
     what reseat it, because the count comes last in the markup. */
  .col-hd .ct { order: -1; font-size: 11px; font-weight: 500; font-variant-numeric: tabular-nums;
    border: 0; padding: 0; line-height: 1.3;
    color: color-mix(in srgb, var(--vscode-foreground) 45%, transparent); }
  .col-hd .rule { order: 0; flex: 1; height: 1px; background: var(--hair); }
  /* The zone, stated once: a rail you can trace from the column head to the last card.
     This replaces a flat tint of the same hue behind the cards. The tint had to stay so
     faint to avoid fighting the cards that it barely read at all, and it was the third
     statement of one hue — after the head's dot and the card's own accent rail, both of
     which said the same thing louder. A line states it once and states it clearly.
     It also gives every column a hard left edge, which is what stops a right-hand
     neighbour's content from reading as part of this column.
     Still on .col-body rather than .col, so the rail starts under the sticky header
     instead of scrolling out from behind it. */
  .col-body { display: flex; flex-direction: column; gap: 8px; padding: 6px 0 10px 12px;
    border-left: 1px solid color-mix(in srgb, var(--zone) 40%, transparent); }
  /* An empty column draws nothing below its head. The body is a childless div then, so
     the rail would be a floating ~16px tick in the zone's hue — a rail with nothing to
     rail, which reads as a stray mark rather than as structure. (The tint this rail
     replaced had the same shape and got away with it: a 16px rounded field read as an
     empty place, where a 16px line reads as debris.) The head still says "Merge 0". */
  .col-body:empty { border-left: 0; padding: 0; }
  /* A band inside a column. Deliberately quieter than .col-hd — no dot, no sticky,
     lowercase from the markup — so the column header still reads as the heading and
     this reads as a divider under it. The first lane sits tight to the column
     header; later ones open a gap so the break between bands is visible without a
     heavier rule. It takes no zone colour of its own: the column body is already
     tinted, and a second green inside a green column adds nothing. */
  .lane-hd { display: flex; align-items: center; gap: 7px; flex: none;
    padding: 2px 2px 0; color: var(--dim); font-size: var(--t-micro); }
  .lane-hd:not(:first-child) { margin-top: 6px; }
  .lane-hd .nm { letter-spacing: .01em; white-space: nowrap; }
  .lane-hd .ct { font-variant-numeric: tabular-nums; }
  .lane-hd .rule { flex: 1; height: 1px; background: var(--hair); }

  /* \`flex: none\` is load-bearing: .card sets overflow:hidden, which zeroes its automatic
     minimum size — without it the flex column squeezes every card and clips its content
     instead of growing the column. (overflow:hidden originally existed to clip the card's
     accent rail. The rail is gone — the column body's own rail states the zone once now —
     but the clip still guards long unbreakable content, so both declarations stay.) */
  .card { position: relative; flex: none; border: 1px solid var(--hair); border-radius: var(--r-card);
    background: color-mix(in srgb, var(--vscode-foreground) 3%, var(--vscode-editor-background));
    padding: 10px 12px 9px; overflow: hidden;
    transition: border-color .12s ease, background-color .12s ease; }
  /* The one card asking for you, and now the only card on the board wearing a hue at all:
     an amber border and a warm wash, standing in a column whose rail is already behind it.
     Both reinforcements are of one signal, and nothing else competes with them. */
  .card.attn { background: color-mix(in srgb, var(--c-attn) 6%, var(--vscode-editor-background));
    border-color: color-mix(in srgb, var(--c-attn) 58%, var(--hair)); }
  .card:hover { border-color: color-mix(in srgb, var(--vscode-foreground) 25%, transparent); }
  .card.attn:hover { border-color: color-mix(in srgb, var(--c-attn) 55%, var(--hair)); }
  .card:focus-within { border-color: var(--vscode-focusBorder); }

  /* State leads every card from the same x, so a column scans as one strip of status. */
  /* Wraps for the agent name only: state and ticket always share line one, and
     the name drops beneath the ticket when the column is too narrow for three —
     which beats ellipsizing an identifier, and costs no height when it fits. */
  /* The card's header: the kind avatar leads from the same x on every card, the
     title is the anchor, the key trails it. \`align-items: flex-start\` so a two-line
     title grows downward and leaves the avatar and the key on line one. */
  .c-hd { display: flex; align-items: flex-start; gap: 10px; min-width: 0; }
  .c-hd .hd-t { flex: 1; min-width: 0; }
  .c-hd .hd-t .c-title { margin-top: -1px; }
  /* \`flex: none\` and \`max-width: none\` together: the key must not shrink, and the
     .key rule below caps every key at 46% of its row — a cap meant for a row the key
     shared with the state text, and far too tight for its own slot. The title wraps
     instead; it is already built to. */
  .c-hd .hd-k { flex: none; padding-top: 1px; }
  .c-hd .hd-k .key, .c-hd .hd-k .key-wrap { margin-left: 0; max-width: none; }

  /* The kind avatar. A neutral tile with a hued glyph: the ground stays neutral
     because a column of cards must not become a column of colours — the board's
     colour vocabulary belongs to the columns and to .attn, and a kind is not a
     status. */
  .av { position: relative; flex: none; width: 22px; height: 22px; border-radius: 6px;
    display: inline-flex; align-items: center; justify-content: center;
    border: 1px solid var(--hair); color: var(--dim);
    background: color-mix(in srgb, var(--vscode-foreground) 5%, transparent); }
  .av svg { display: block; }
  /* A ticket is the ordinary case and appears in every column, so it stays
     neutral: any accent hue here would be read as a status the card does not have
     — a purple tag on an In-progress card says "in review". The other four kinds
     are the exceptions, and each borrows the hue of the column it naturally lives
     in, which reinforces rather than contradicts. */
  .av.k-task    { color: color-mix(in srgb, var(--vscode-foreground) 62%, transparent); }
  .av.k-notepad { color: color-mix(in srgb, var(--vscode-charts-yellow) 78%, var(--vscode-foreground)); }
  .av.k-explore { color: color-mix(in srgb, var(--c-progress) 78%, var(--vscode-foreground)); }
  .av.k-review  { color: color-mix(in srgb, var(--c-review) 78%, var(--vscode-foreground)); }
  .av.k-local   { color: var(--dim); }
  /* The tool driving this card, on the kind tile's corner. Overflow has to open up for
     it: the badge deliberately breaks the tile's edge, which is what makes it read as a
     badge rather than as a second glyph crammed inside. */
  .av { overflow: visible; }
  .pv { position: absolute; right: -5px; bottom: -5px; width: 15px; height: 15px;
    border-radius: 5px; display: inline-flex; align-items: center; justify-content: center;
    border: 1px solid var(--hair);
    background: color-mix(in srgb, var(--vscode-foreground) 10%, var(--vscode-editor-background));
    color: color-mix(in srgb, var(--vscode-foreground) 72%, transparent); }
  .pv svg { display: block; }
  /* Claude has a brand colour that survives both themes; Cursor and GitHub Copilot are
     black-on-white marks and take the theme's own ink instead. The hue is safe here in a
     way it would not be on the card's ground: the badge never changes with state, so it
     cannot be read as the status that colour otherwise always means on a card. */
  .pv.p-claude-code { color: var(--p-claude);
    border-color: color-mix(in srgb, var(--p-claude) 34%, var(--hair));
    background: color-mix(in srgb, var(--p-claude) 10%, var(--vscode-editor-background)); }
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
  /* Weight 550 → 560 and leading 1.42 → 1.36: at 13.5px the old leading left the two
     clamped lines reading as two separate rows rather than as one title. */
  .c-title { margin-top: 5px; font-size: var(--t-title); font-weight: 560; line-height: 1.36; letter-spacing: -.012em;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }

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
  /* Neutral ink, with the direction carried by the glyph — see the matching \`.c-diff\`
     pair below, which this rule is kept in step with. Green on this board means a live
     agent or a mergeable branch; spending it on "lines added" made one hue mean three
     things on one screen, and red on a card is reserved for a real failure, which a
     deletion count is not.

     Neutral, but NOT faint. These sit inside .c-sig, which passes down a dim gray, and
     a diff count that lands near that gray is the exact bug DeckApp.test.tsx was
     written to catch: full ink for the added count, 85% for the removed one, both
     comfortably clear of --dim. The 85% is a whisper of hierarchy, not a warning. */
  .repo .add { color: var(--vscode-foreground); }
  .repo .del { color: color-mix(in srgb, var(--vscode-foreground) 85%, transparent); }
  .repo .dirty { color: var(--c-idle); }

  /* The workspace label and the repo chips under it. The name is an identifier,
     so it is mono; "2 repos" is prose, so it is not. Nothing folds, so the label
     is a label — no pointer, no hover affordance, nothing to click. The chips
     below it are the .c-repos row above, margin and all. */
  .c-ws { margin-top: 7px; }
  .ws { display: inline-flex; align-items: baseline; gap: 5px; font-size: var(--t-data);
    color: var(--dim); background: none; border: 1px solid var(--hair); border-radius: var(--r-chip);
    padding: 1px 6px; }
  .ws .n { font-family: var(--mono); color: color-mix(in srgb, var(--vscode-foreground) 82%, transparent); }

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
  /* An identifier, so mono — the same rule .ag-name and .key follow. Quieter than the
     name: which session this is matters more than what is driving it. */
  .ag-model { flex: none; font-family: var(--mono); font-size: var(--t-data);
    color: color-mix(in srgb, var(--vscode-foreground) 62%, transparent); }
  .ag-model .plus { margin-left: 3px; opacity: .6; }

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
  /* Same control language as sort — it sits beside it and does the same kind of job. */
  .rv-select { display: inline-flex; align-items: center; gap: 5px; }
  .rv-select button { border: 0; background: none; padding: 0; cursor: pointer;
    font-size: var(--t-body); color: var(--dim); }
  .rv-select button.on { color: var(--vscode-foreground); text-decoration: underline; text-underline-offset: 2px; }
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
  /* The head holds the row's two controls side by side — the line that opens the
     row, and the play button that launches an agent without opening it. It exists
     because .rv-detail is a sibling of them both and has to sit UNDER both: one
     flex container cannot do that, so the head is the flex line and .rv-row stays
     a block. .rv-line then takes whatever .rv-go leaves. */
  .rv-head { display: flex; align-items: stretch; }
  /* On the head, not on .rv-line: hovering either control has to light the whole
     line, or the play cell stays a 26px unlit notch at the end of a hovered row.
     Scoped away from the skeletons via the aria-hidden their row already carries —
     they are not rows you can open, so they take no hover at all (which is why
     .rv-line.rv-skel needs no hover rule of its own any more). Scoped to the head
     rather than the row so an open row's detail block still takes none either. */
  .rv-row:not([aria-hidden]) .rv-head:hover {
    background: var(--vscode-list-hoverBackground, var(--vscode-toolbar-hoverBackground)); }
  /* A button, so reset the button chrome and let it fill the row. outline-offset is
     negative because .rv-strip clips overflow — a ring drawn outside would vanish. */
  .rv-line { display: flex; align-items: baseline; gap: 8px; padding: 6px 12px; cursor: pointer;
    font-size: var(--t-body); font-variant-numeric: tabular-nums;
    flex: 1; min-width: 0; text-align: left; background: none; border: 0; color: inherit;
    font-family: inherit; outline-offset: -2px; }

  /* The row's agent action. --brand, the same hue .act.primary uses for the
     expanded row's own "Review with agent" — one action, one colour, whichever
     way you reach it. A fixed width so it stacks into a column like every other
     field on the row, and full height so the whole cell is the hit target.

     .cold is the repo-not-checked-out case: --dim, not a faded brand, because a
     washed-out brand glyph reads as the primary action gone wrong rather than
     one that isn't available here. It stays clickable — the host explains.

     .busy is a span, not a button (see ReviewStrip), so it gets the layout rules
     and none of the affordance. */
  .rv-go { flex: none; width: 26px; display: inline-flex; align-items: center;
    justify-content: center; background: none; border: 0; padding: 0;
    font-size: var(--t-body); line-height: 1; color: var(--brand);
    outline-offset: -2px; }
  .rv-go:not(.busy) { cursor: pointer; }
  .rv-go:not(.busy):hover { background: color-mix(in srgb, var(--brand) 16%, transparent); }
  .rv-go.cold { color: var(--dim); }
  .rv-go.cold:hover { background: color-mix(in srgb, var(--vscode-foreground) 10%, transparent); }
  .rv-caret { flex: none; width: 9px; color: var(--dim); }
  /* Exactly the caret's width, so turning selection on doesn't shift every title
     sideways — the columns below stay where they were. */
  .rv-chk { flex: none; width: 9px; line-height: 1; color: var(--dim); font-size: var(--t-data); }
  .rv-chk.on { color: var(--vscode-foreground); }
  .rv-row.picked .rv-head { background: color-mix(in srgb, var(--brand) 10%, transparent); }
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
  /* The agent finished and its findings are waiting: the done hue, not --brand — the
     accent belongs to the action you can take, and this chip is a state. Shaped like
     .rv-draft beside it so the two read as one row of chips. */
  .rv-ready { flex: none; font-size: var(--t-micro); color: var(--c-done);
    border: 1px solid color-mix(in srgb, var(--c-done) 40%, transparent);
    border-radius: var(--r-chip); padding: 0 4px; }
  .rv-files, .rv-author, .rv-age { flex: none; color: var(--dim); }
  .rv-running { flex: none; color: var(--c-progress); }

  /* The batch bar, values carried over from the sidebar's own (src/webview/styles.ts)
     so selecting rows here and selecting tasks there look like the same gesture. The
     count and the shift-click hint are English, so no mono; the launch carries --brand,
     and nothing here is red — an empty selection is disabled, not an error. */
  .batch-bar { display: flex; align-items: center; gap: 8px; padding: 7px 10px;
    border-top: 1px solid var(--hair); }
  .batch-count { font-size: var(--t-micro); color: var(--dim); }
  .batch-link { background: none; border: none; cursor: pointer; padding: 0;
    font-size: var(--t-micro); color: var(--vscode-textLink-foreground); }
  .batch-launch { margin-left: auto; display: inline-flex; align-items: center; gap: 5px;
    font-size: var(--t-body); padding: 3px 11px; border-radius: 8px; border: none; cursor: pointer;
    background: var(--brand); color: var(--brand-ink); }
  .batch-launch:hover:not(:disabled) { background: color-mix(in srgb, var(--brand) 84%, var(--vscode-foreground)); }
  .batch-launch:disabled { cursor: default; opacity: 0.45; }

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

  /* The drawer shell — everything the card detail (.dd) and the Orchestrator
     (.orch, orchestratorStyles.ts) share, which is everything except width and
     how each one scrolls. They are the same kind of object: a panel below the
     header, anchored right, no scrim, in one fixed slot at z-index 40 that only
     one of them may occupy (DeckApp.tsx enforces the exclusion). The header
     carries the chip you just pressed and the toggles the board reads from, so
     the panel starts below it rather than at the top of the webview; and a modal
     veil would block the drag the Orchestrator exists to receive, so there is no
     scrim on either.

     They used to be two rules, and they drifted — two shadow depths, and only
     one of them animated at all. \`Drawer.tsx\` is the component half of this
     seam; a drawer's own class carries its differences and nothing else. */
  .drawer { position: fixed; top: 53px; right: 0; bottom: 0; z-index: 40;
    display: flex; flex-direction: column;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border-left: 1px solid var(--hair); box-shadow: -14px 0 34px -12px rgba(0,0,0,.45);
    animation: drawer-in ${DRAWER_ANIM_MS}ms cubic-bezier(.22,.61,.36,1) both; }

  /* A drawer is anchored to the right edge, so it arrives and leaves along that
     edge — a panel that slid up, faded, or scaled would be inventing a second
     story about where this surface lives. The distance is the drawer's own
     width, so the slide starts fully off-screen no matter how wide the user has
     dragged it, and the opacity ramp is short and front-loaded: it exists to
     soften the shadow's arrival, not to make the panel read as translucent on
     the way in.

     \`both\` matters. Without it the first painted frame is the drawer at its
     final position, and the animation then jumps it back off-screen — one frame
     of flash on every open. */
  @keyframes drawer-in {
    from { transform: translateX(100%); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }

  /* Closing. \`Drawer.tsx\`'s \`useDrawerExit\` keeps the aside mounted for exactly
     DRAWER_ANIM_MS after its open key drops, drawing the item it last held, and
     that span is what this animates. Inert throughout — \`pointer-events\` off,
     and the element carries \`aria-hidden\` — because a drawer already on its way
     out must not take a click that was meant for the board behind it.

     The declared \`opacity: 0\` is the reduced-motion fallback, and it is load
     bearing. tokens.ts's reset carries a global
     \`* { animation: none !important }\` for users who have asked the system for
     less motion, which suppresses \`drawer-out\` outright — and the unmount is a
     JS timer, so without this the drawer would sit fully visible in place for
     DRAWER_ANIM_MS after the user dismissed it. A running animation outranks a
     declared value, so while \`drawer-out\` plays this is inert and the keyframes
     own the fade; it only takes effect when they are gone. (The query itself is
     deliberately not written here — tokens.test.ts asserts no surface sheet
     carries a motion reset of its own, and the shared one in tokens.ts is the
     only place that should.) */
  .drawer.closing { animation-name: drawer-out; pointer-events: none; opacity: 0; }
  @keyframes drawer-out {
    from { transform: translateX(0); opacity: 1; }
    to { transform: translateX(100%); opacity: 0; }
  }

  /* The selected card's detail. 460px is the narrowest width at which a
     .pr-block's label column and value column both fit without wrapping.

     \`hidden auto\`, not \`auto\`: the drawer is a fixed-width panel of rows that all
     ellipsize, so sideways scroll here is never a feature — it is always a row that
     failed to shrink (a long mono key did exactly that), and it takes the close
     button off-screen with it. Vertical scroll is the only axis it needs. */
  .dd { width: 460px; overflow: hidden auto; }
  /* Two rows, and the header is the block that stacks them: \`.dd-id\` carries the
     identity (mark, key, tracker status, close) and the title takes the next row
     whole.

     The title used to sit inline between the key and the status pill, and at 460px
     that made every long one unreadable — the title and the pill are both shrinkable,
     so the row's shortfall was split between them, and a long title turned "Ready for
     Dev" into "Read…" while still being cut itself. Neither survived. A row of its own
     is the only arrangement in which the whole title fits, which is the point: the
     title is what the drawer is about, and the reader should not have to hover it.

     A real inner element rather than \`flex-wrap\` on \`.dd-hd\` itself, and measured:
     wrapping puts the break wherever the line runs out, and flexbox breaks lines from
     the items' *unshrunk* sizes, so a long key next to a long status wrapped the PILL
     and the close button onto a line of their own and pushed the title to a third.
     One row that cannot break, plus a block below it, has no such degree of freedom. */
  .dd-hd { padding: 9px 12px; border-bottom: 1px solid var(--hair); }
  .dd-id { display: flex; align-items: center; gap: 8px; }
  /* \`max-width\` is load-bearing: a nowrap flex item's automatic minimum size is its
     full text width, so an unbounded key could not shrink and any key wider than the
     drawer pushed the row past 460px instead of ellipsizing. Half the header is the
     widest a key can be before it stops being context and starts replacing the rest
     of the row.

     Shrinkable past that cap (\`min-width: 0\`, not \`flex: none\`) so the key — not the
     pill — is what gives ground when the two together still overflow. That priority is
     the reverse of what it was while the title shared this row, and it is only safe now
     the title has left: the pill is the row's one other flexible item and its width is
     small and bounded, so a short key never shrinks at all. Where something must, a
     truncated key costs least — the title below already says what the task is, and for
     a notepad run the key is derived from that title anyway. The full key stays on the
     \`title\` attribute, and Copy ticket key still copies it verbatim. */
  .dd-hd .k { font-family: var(--vscode-editor-font-family); font-size: 12px; white-space: nowrap;
    flex: 0 1 auto; min-width: 0; max-width: 50%; overflow: hidden; text-overflow: ellipsis; }
  /* The drawer opens with the card's own mark, at the card's own size — a smaller
     one here would read as a different object. */
  .dd-hd .av { flex: none; }
  /* The whole title, wrapped onto as many rows as it takes — never ellipsized, which
     is the whole point of the second row. \`overflow-wrap: anywhere\` is for the titles
     that are one unbroken token: a 60-character notepad slug has no space to break at,
     and without it the word would run past 460px and be clipped by \`.dd\`'s own
     \`overflow: hidden\`. Full foreground weight, unlike the dim inline version it
     replaces — on a row of its own it reads as the drawer's title rather than as a
     gloss on the key. */
  .dd-hd .t { display: block; margin-top: 2px; font-size: var(--t-body);
    color: var(--vscode-foreground); white-space: normal; overflow-wrap: anywhere; }
  /* Holds its text: \`flex: none\`, so the key beside it is what shrinks. It is two or
     three words of tracker vocabulary — "Ready for Dev", "In Progress" — and a first
     letter plus an ellipsis is not a shorter way of saying them, it is a different and
     useless thing. Capped all the same, so a pathological status cannot squeeze the
     key to nothing. */
  .dd-hd .pill { flex: none; max-width: 50%; }
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

  /* One child worktree, same list-row shape as .dd-act. Same bug this file's
     .dd-hd .k comment already names, and the same fix commit (8ebdd43,
     "stop the detail drawer scrolling sideways") already measured: a
     \`white-space: nowrap\` flex item's automatic minimum size is its own full
     text width UNLESS its own overflow is non-visible — and \`flex: none\`
     (used below on \`.k\`/\`.bn\`, the identifiers) sets flex-shrink to 0, which
     means that automatic-minimum rule never even gets asked; the item simply
     renders at its natural content width every time. Left uncapped, a long
     branch name would claim however much width it wants and \`.t\` — the only
     item with flex-grow, and the only one meant to give ground — would be
     the one squeezed, all the way to invisible if \`.k\`+\`.bn\`'s natural widths
     alone already exceed the row. \`max-width\` on \`.k\` and \`.bn\` is what
     bounds that: past it they ellipsize on their OWN box instead of
     continuing to claim space from \`.t\`, so the summary is guaranteed some
     share and is the thing that visibly shortens first in the ordinary case
     (it usually has the most text). \`.dd\`'s own \`overflow: hidden auto\`
     (see above) is the backstop if a row still doesn't fit even capped: it
     clips rather than taking the close button off-screen, exactly as it
     already does for every other row in this drawer. */
  .dd-child { display: flex; align-items: baseline; gap: 6px; width: 100%; text-align: left;
    background: none; border: 0; padding: 3px 0; color: inherit; cursor: pointer; min-width: 0; }
  .dd-child:hover { background: var(--vscode-list-hoverBackground); }
  .dd-child .k { flex: none; max-width: 30%; font-family: var(--vscode-editor-font-family); font-size: 11px; opacity: .85;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dd-child .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dd-child .bn { flex: none; max-width: 40%; font-family: var(--vscode-editor-font-family); font-size: 11px; opacity: .7;
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
  /* Under the title as a caption rather than a third band of body text: same bits,
     same order, same cap of three — only the typography changes. Mono because every
     bit it carries is an identifier or a count. */
  .c-sig { display: flex; align-items: center; gap: 7px; flex-wrap: nowrap; overflow: hidden;
    margin-top: 4px; font-family: var(--mono); font-size: var(--t-data); color: var(--dim); }
  .c-sig > * { flex: none; white-space: nowrap; }
  .c-sig .m { font-family: var(--vscode-editor-font-family);
    flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .c-sig .sep { opacity: .45; }
  .c-sig .bad, .c-sig .warn { color: var(--c-attn); }
  .c-sig .ok { color: var(--c-done); }
  .c-diff { display: inline-flex; gap: 5px; font-family: var(--vscode-editor-font-family); }
  /* Kept in step with the \`.repo\` pair above, which carries the reasoning. Both rules
     must exist and neither may land on the dim gray .c-sig passes down — asserted in
     DeckApp.test.tsx, which caught exactly that bug once already. */
  .c-diff .add { color: var(--vscode-foreground); }
  .c-diff .del { color: color-mix(in srgb, var(--vscode-foreground) 85%, transparent); }

  /* The card's only rule. Identity and facts above it, live state below. */
  .c-hr { border: 0; height: 1px; margin: 9px 0 7px;
    background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent); }

  /* State left, the run's age right. The age is mono and tabular so a column of
     cards lines its numbers up; the state text is not, because it is English.
     The dot is .status's sibling here rather than its child, so the gap is this
     row's to set. */
  .c-st { display: flex; align-items: center; gap: 7px; min-width: 0; }
  .c-st .status { flex: 0 1 auto; }
  .c-meta { margin-left: auto; flex: none; display: inline-flex; align-items: baseline; gap: 6px;
    font-family: var(--mono); font-size: var(--t-data); color: var(--dim); font-variant-numeric: tabular-nums; }

  .c-foot2 { display: flex; gap: 5px; margin-top: auto; padding-top: 2px; }

  /* The spend figure. A count, so it is mono — the deck's rule is mono for
     identifiers and counts, prose in the UI font. It sits in the footer's dead
     right side: on the top row it wraps the ticket key onto a second line
     whenever the state text is long, and on the signal line it breaks the
     three-bit cap and truncates the branch further. */
  /* Spend, in the drawer only — never on the card. Counts are mono, the class
     names beside them are prose in the UI font: the deck's standing rule is mono
     for identifiers and numbers, UI font for anything that reads as English.
     Right-aligned values so four rows of very different magnitudes line up on
     their last digit and can be compared down the column. */
  .dd-spend { display: flex; flex-direction: column; gap: 3px; }
  .dd-spend .sp-row { display: flex; align-items: baseline; gap: 8px; font-size: var(--t-body); }
  .dd-spend .sp-k { color: var(--dim); }
  .dd-spend .sp-v { margin-left: auto; font-family: var(--vscode-editor-font-family);
    font-variant-numeric: tabular-nums; white-space: nowrap; }
  /* The weighted total is the one figure that is not a raw token count, so it is
     separated by a hairline rather than just sitting as a fifth sibling. */
  .dd-spend .sp-tot { margin-top: 4px; padding-top: 5px; border-top: 1px solid var(--hair); }
  .dd-spend .sp-tot .sp-k { color: var(--vscode-foreground); cursor: help; }
  .dd-spend .sp-tot .u { font-family: var(--vscode-font-family); opacity: .55; margin-left: 2px; }

  /* One row per PR failure, each with the verb that fixes it. These REPLACE the
     signal line on a failing card, so a card is never taller than the problems
     it actually has — and a card with three failures grows past the 152px floor,
     which is the intended trade: attention should follow size. */
  .c-rows { display: flex; flex-direction: column; gap: 5px; }
  .c-row { display: flex; align-items: center; gap: 7px; overflow: hidden;
    font-size: 11.5px; color: var(--dim); }
  /* The elastic member: a long list of failing check names takes the ellipsis
     rather than pushing the button off the card. */
  .c-row > .lbl { flex: 0 1 auto; min-width: 0; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  .c-row > .m { flex: none; font-family: var(--vscode-editor-font-family); }
  .c-row .bad, .c-row .warn { color: var(--c-attn); }
  /* A state, not a brand accent — --c-done, never var(--brand): tokens.test.ts
     asserts set equality of this sheet's --brand spenders, and a merge-ready card
     is not a place to put the board's accent. */
  .c-row .ok { color: var(--c-done); }
  .c-row .act { margin-left: auto; flex: none; height: 20px; padding: 0 7px; font-size: 11px; }
`;
