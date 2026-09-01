import { DRAWER_ANIM_MS } from "./deckStyles";

// The Orchestrator drawer. Read alongside the approved mockup at
// docs/mockups/2026-08-05-deck-orchestrator-drawer.html (?v=canvas) — that file is
// the visual contract and is git-ignored, so it lives only in the primary checkout.
//
// Two things about this drawer are deliberate and easy to "fix" wrongly — and
// neither lives here any more, because they are true of the card detail too:
// it starts BELOW the Deck header rather than at the top of the panel, and there
// is NO scrim. Both are stated once, on `.drawer` in deckStyles.ts, which this
// sheet's `.orch` composes onto. Only what differs is written below.
// Width is user-resizable: a grip on the drawer's left border (this task), and
// on top of that plumbing, an expand toggle (Task 4). --orch-w carries the live
// value. It is declared right here, locally, with the phase-1 pixel figure as
// its default — so tokens.test.ts's orphan-usage check sees a real declaration
// in this sheet and never needs --orch-w added to the RUNTIME_ONLY allowlist.
// OrchestratorDrawer.tsx then overrides it with an inline style carrying the
// current (dragged, arrow-keyed, or persisted) width — the override direction
// only works because the default already exists here to be overridden.
/** How long this drawer's slide takes, in ms — the Deck's one drawer figure,
 * under the name this sheet has always called it. The number and the keyframes
 * it drives moved to deckStyles.ts when the card detail and this drawer became
 * one shell (`.drawer` there, `Drawer.tsx` beside it): two slides of different
 * lengths on one surface was exactly the drift that seam exists to prevent. */
export const ORCH_ANIM_MS = DRAWER_ANIM_MS;

/** How far an edge chip's own centre is painted from the point it is positioned
 * at, in px — negative because it sits ABOVE that point. Declared HERE, beside
 * the rule it has to agree with, and imported by `OrchestratorDrawer.tsx` rather
 * than duplicated there: `.orch-edge` below carries
 * `transform: translate(-50%, -150%)`, so the box is lifted by 1.5 of its own
 * height and its CENTRE lands exactly one height above the point.
 *
 * MEASURED in the real bundle, not derived from the sheet: the chip is 16px tall,
 * so this is -16. An earlier value of -19 came from reading the CSS and
 * over-counting the `--t-micro` line box. It picked the same escape point in
 * practice (the search steps in 8px units and node coordinates are grid-snapped),
 * but it overstated the clearance, which is only 2px — so the number that decides
 * whether a label covers a node's only status word is the measured one.
 *
 * `OrchestratorDrawer.tsx` hands it to `labelPoint` (layout.ts) as that
 * function's `paintDy`, which is what makes the obstacle search avoid boxes for
 * the CHIP rather than for its anchor. Without it, every downward escape stepped
 * the anchor clear and then painted the chip straight back into the box it had
 * escaped — over a node's only status word. Change the transform below and this
 * number changes with it; they are one fact in two languages, the same way
 * `NOTIFY_W` and `.orch-node.notify`'s width are. */
export const ORCH_EDGE_PAINT_DY = -16;

export const ORCH_CSS = `
  /* Brand-toned, and the only control in the Deck header that carries a hue.
     It earned one: every other header control is a lens over what is already
     on the board, and this is the way into a surface that acts on its own.

     A TINT, not a fill. \`.take\` and \`.act.primary\` are this product's filled
     brand controls, and they are per-card primaries — a solid slab up here
     would read as a third one competing with them from the chrome. So the
     hue arrives as a hairline, a label, and a 12% wash: unmistakably the
     brand, without claiming to be the page's primary action.

     It also has to survive beside the header's one other accent, the amber
     \`.stat.attn\` tile. Amber means "a card needs you" and teal means "this
     is the Orchestrator"; they read as two different kinds of thing rather
     than two alarms, which a second amber or a second fill would not. */
  .orch-chip { gap: 6px; color: var(--brand);
    border-color: color-mix(in srgb, var(--brand) 45%, transparent);
    background: color-mix(in srgb, var(--brand) 12%, transparent); }
  .orch-chip svg { display: block; }
  .orch-chip .ct { font-family: var(--mono); font-size: var(--t-micro);
    color: color-mix(in srgb, var(--brand) 80%, var(--dim)); }
  /* Deepens the same hue rather than switching to the theme's generic toolbar
     hover, which would drop the tint on the way in and read as the chip
     losing its identity under the pointer. Matches how \`.take\` and
     \`.btn.pri\` escalate: same hue, more of it.

     \`color\` is restated here on purpose. \`.ctl:hover\` in deckStyles.ts sets
     \`color: var(--vscode-foreground)\` at the same specificity as this rule;
     ORCH_CSS is appended after DECK_CSS (see deck.tsx) so this sheet wins the
     tie, but only for properties it actually declares — omitting \`color\`
     would hand the label back to the generic hover and drop the hue. */
  .orch-chip:hover { color: var(--brand);
    background: color-mix(in srgb, var(--brand) 20%, transparent);
    border-color: color-mix(in srgb, var(--brand) 65%, transparent); }
  /* Armed is what is quietly spending your attention while the drawer is
     closed — worth reading at a glance. Still no fill: the chip is already
     the header's one tinted control, so the armed state escalates within
     that treatment (full-strength hue, more weight) rather than by becoming
     a different kind of object. */
  .orch-chip.armed .ct { color: var(--brand); font-weight: 600; }

  /* Width, and nothing else — the shell is \`.drawer\` in deckStyles.ts, including
     the slide this drawer used to own outright. */
  .orch { --orch-w: 560px; width: var(--orch-w); }

  /* The resize grip, centred ON the left border rather than beside it — half
     outside the drawer's box, half inside — so it never nudges the header,
     body, or footer's own layout. Never brand-tinted: this surface's one
     filled/accented control is Arm (.orch-arm below); a resize handle earning
     the same treatment would read as a second primary control on one surface. */
  .orch-grip { position: absolute; left: -4px; top: 0; bottom: 0; width: 9px; z-index: 1;
    background: transparent; border: 0; padding: 0; cursor: ew-resize; }
  /* A permanent, quiet affordance — three 1px dots, dim and low-opacity at
     rest — not merely a hover/focus tint. A grip that is pixel-identical to
     a plain border until touched is a control that fixes a clipped graph
     while being itself undiscoverable; the fix for one silence must not be
     another. Kept well short of Arm's own weight (a flat fill, brand-toned)
     so this never reads as competing with the surface's one filled control. */
  .orch-grip::after {
    content: ""; position: absolute; left: 50%; top: 50%; width: 3px; height: 21px;
    transform: translate(-50%, -50%); pointer-events: none;
    background-image: radial-gradient(circle, var(--dim) 1px, transparent 1.4px);
    background-size: 3px 7px; background-repeat: repeat-y; opacity: .6; }
  .orch-grip:hover, .orch-grip:focus-visible { background: color-mix(in srgb, var(--vscode-foreground) 10%, transparent); }
  .orch-grip:hover::after, .orch-grip:focus-visible::after { opacity: .9; }
  .orch-grip:focus-visible { outline: none;
    box-shadow: inset 0 0 0 1px var(--vscode-focusBorder); }

  .orch-hd { flex: none; padding: 13px 16px 11px; border-bottom: 1px solid var(--hair); }
  .orch-hd .row { display: flex; align-items: center; gap: 8px; }
  .orch-hd .eyebrow { font-size: var(--t-micro); letter-spacing: .06em; text-transform: uppercase; color: var(--dim); }
  .orch-hd .sp { flex: 1; }
  .orch-x { width: 24px; height: 24px; border: 0; border-radius: var(--r-ctl); background: transparent;
    color: var(--dim); cursor: pointer; font-size: 14px; line-height: 1; }
  .orch-x:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }

  .orch-name { width: 100%; margin-top: 5px; margin-left: -6px; padding: 3px 6px;
    background: transparent; border: 1px solid transparent; border-radius: var(--r-ctl);
    font: inherit; font-size: 15px; font-weight: 600; letter-spacing: -.012em; color: var(--vscode-foreground); }
  .orch-name:hover { border-color: var(--edge); }
  .orch-name:focus { border-color: var(--vscode-focusBorder); outline: none;
    background: var(--vscode-input-background); }

  .orch-mini { height: 20px; padding: 0 7px; font-size: var(--t-micro); border-radius: var(--r-chip);
    border: 1px solid var(--edge); background: transparent; color: var(--dim); cursor: pointer; }
  .orch-mini:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
  /* The Expand toggle's pressed state, and the Canvas/List view tabs'
     selected state — same on-state language, weight and foreground only, the
     same rule CONTROLS_CSS's .seg already follows ("never a fill"). Arm stays
     the one filled control on this whole surface. */
  .orch-mini[aria-pressed="true"], .orch-mini[aria-selected="true"] { color: var(--vscode-foreground); font-weight: 600; }

  .orch-body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden;
    padding: 14px 16px 18px; }

  .orch-sect { flex: none; margin-bottom: 12px; }
  .orch-sect-hd { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .orch-sect-hd .t { font-size: var(--t-micro); letter-spacing: .06em; text-transform: uppercase; color: var(--dim); }
  .orch-sect-hd .rule { flex: 1; height: 1px; background: var(--hair); }

  .orch-empty { border: 1px dashed var(--edge); border-radius: var(--r-card); padding: 22px 14px;
    text-align: center; font-size: var(--t-body); color: var(--dim); line-height: 1.5; }

  .orch-ft { flex: none; padding: 10px 16px; border-top: 1px solid var(--hair);
    display: flex; align-items: center; gap: 10px; font-size: var(--t-micro); color: var(--dim); }
  .orch-ft .sp { flex: 1; }

  .orch-flows { position: absolute; right: 16px; top: 40px; z-index: 5; min-width: 220px; max-width: 320px;
    border: 1px solid var(--edge); border-radius: var(--r-ctl); padding: 4px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    box-shadow: 0 6px 20px -8px rgba(0,0,0,.5); }
  .orch-flows button { display: block; width: 100%; text-align: left; border: 0; background: transparent;
    color: var(--vscode-foreground); font: inherit; font-size: var(--t-body);
    padding: 5px 8px; border-radius: var(--r-chip); cursor: pointer; }
  .orch-flows button:hover { background: var(--vscode-toolbar-hoverBackground); }

  /* Running/Templates share this one popover (see the \`orch-tabs\` tablist in
     OrchestratorDrawer.tsx) rather than a second panel — one switcher, one
     place to open a flow or start one. \`.orch-flows button\` above forces
     every plain button in here to sit full-width and left-aligned, which is
     right for a flow row that IS the button and wrong for a tab or a
     Duplicate/Rename/Delete action sitting inline beside its siblings.
     These two selectors carry two classes each, so they outrank that rule
     regardless of where either sits in the sheet. */
  .orch-flows .orch-tabs { display: flex; gap: 4px; padding: 0 2px 6px; margin-bottom: 4px;
    border-bottom: 1px solid var(--hair); }
  .orch-flows .orch-tabs button, .orch-flows .orch-tmpl-row button {
    display: inline-flex; width: auto; text-align: center; }

  .orch-tmpl-list { max-height: 260px; overflow-y: auto; }
  .orch-tmpl-row { padding: 6px 4px; }
  .orch-tmpl-row + .orch-tmpl-row { border-top: 1px solid var(--hair); margin-top: 2px; padding-top: 8px; }
  /* Every \`.row\`/\`.sp\` pair in this sheet is scoped to its own parent —
     there is no generic one — so this row needs its own, the same shape
     \`.orch-hd .row\`/\`.orch-hd .sp\` and \`.orch-resume .row\` already give
     theirs. Without it the name and rule count jam together with no gap, and
     the confirm state's Cancel/Confirm-delete pair drops onto its own line
     below the sentence instead of sitting at its end. */
  .orch-tmpl-row .row { display: flex; align-items: center; gap: 6px; }
  .orch-tmpl-row .row + .row { margin-top: 4px; }
  .orch-tmpl-row .sp { flex: 1; }
  .orch-tmpl-row .t { font-size: var(--t-body); font-weight: 600; }
  .orch-tmpl-row .meta { font-size: var(--t-micro); color: var(--dim); white-space: nowrap; }
  /* A place's own key cell in the Save dialog reuses \`.orch-kw\`, sized for
     "WHEN"/"THEN" (four letters). A run key like "PROJ-142" is longer and
     variable-length, so this widens the column and lets a genuinely long key
     ellipsize instead of colliding with the select beside it — see M-a. */
  .orch-tmpl-dialog .orch-kw { width: auto; max-width: 100px; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }

  /* The Save-as-template dialog. Lives in \`.orch-body\` (see
     OrchestratorDrawer.tsx), first among the panels that briefly take over
     that slot — the resume banner and the dry-run readout are the other
     two — so it borrows their spacing rather than the header's. */
  .orch-tmpl-dialog { flex: none; margin-bottom: 12px; border: 1px solid var(--edge);
    border-radius: var(--r-card); padding: 10px 10px 8px; }
  .orch-tmpl-dialog .row { display: flex; justify-content: flex-end; gap: 6px; margin-top: 8px; }

  /* The tray sits ABOVE the graph: attaching comes before wiring, and this is
     the primary drop target. It is a view of the same node list the canvas
     draws — never a second store. */
  .orch-tray { display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
    padding: 7px; min-height: 46px; border: 1px dashed var(--edge); border-radius: var(--r-card); }
  .orch-tray.over { border-style: solid; border-color: var(--brand);
    background: color-mix(in srgb, var(--brand) 7%, transparent); }
  .orch-tray .hint { font-size: var(--t-body); color: var(--dim); padding: 3px 4px; }
  .orch-tchip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 6px 4px 8px;
    border: 1px solid var(--hair); border-radius: var(--r-chip);
    background: color-mix(in srgb, var(--vscode-foreground) 5%, transparent); }
  .orch-tchip .k { font-family: var(--mono); font-size: var(--t-data); }
  /* An ACTION chip's identifier is a button: it selects the node, which is what
     opens the inspector on the node's own configuration (a command's command, a
     notify's message). A real button rather than a click handler on the span
     because this is the keyboard route to those fields — the list view has no
     canvas to click, and the canvas itself is divs and pointer events. The reset
     restates font-family/font-size AFTER \`font: inherit\`, which would otherwise
     undo the \`.orch-tchip .k\` rule above (this selector is the more specific of
     the two). */
  .orch-tchip button.k { border: 0; padding: 0; background: transparent; cursor: pointer;
    color: inherit; font: inherit; font-family: var(--mono); font-size: var(--t-data); }
  .orch-tchip button.k:hover { color: var(--vscode-foreground); }
  /* Selected: weight and foreground, never a fill — the same on-state language
     CONTROLS_CSS spends, and the same house rule that keeps Arm the only filled
     control on this surface. The chip's own hairline firms up with it so the
     selection is legible without colour. */
  .orch-tchip button.k[aria-pressed="true"] { color: var(--vscode-foreground); font-weight: 600; }
  .orch-tchip.on { border-color: color-mix(in srgb, var(--vscode-foreground) 30%, var(--hair)); }
  .orch-tchip .sub { font-size: var(--t-micro); color: var(--dim); }
  .orch-tchip .rm { border: 0; background: transparent; color: var(--dim); cursor: pointer;
    font-size: 9px; padding: 0 1px; }
  .orch-tchip .rm:hover { color: var(--vscode-foreground); }

  /* The graph takes whatever height the tray and inspector leave. A canvas that
     scrolls the inspector out of view makes you scroll away from the thing you
     are editing to edit it. */
  .orch-graph { flex: 1; min-height: 180px; position: relative; overflow: hidden;
    border: 1px solid var(--hair); border-radius: var(--r-card);
    background: var(--vscode-editor-background);
    background-image: radial-gradient(color-mix(in srgb, var(--vscode-foreground) 13%, transparent) 1px, transparent 0);
    background-size: 16px 16px; }
  .orch-graph.over { border-color: var(--brand); }
  /* The cue half of the original defect: resize and Expand fix a graph too
     wide for the drawer to FIT, but neither says anything when one still
     doesn't — a node clipped at the overflow:hidden edge with nothing to
     mark it. Fades to the graph's own background (not a new colour), and
     only ever renders when OrchestratorDrawer.tsx's clippedRight says a
     node's own right edge genuinely falls past the visible width — never on
     a graph that already fits, where it would be pure decoration. */
  .orch-graph-fade { position: absolute; top: 1px; right: 1px; bottom: 1px; width: 28px;
    pointer-events: none; background: linear-gradient(to right, transparent, var(--vscode-editor-background)); }
  .orch-bar { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
  .orch-bar .sp { flex: 1; }

  /* The "add a node" combo (combo.tsx) — the sidebar's repo filter, re-expressed
     in this surface's own language. It replaced two native \`<select>\`s, and the
     reason is not decoration: a select creates ONE node per trip, so staging
     three commands meant opening the same menu three times, and a menu of run
     keys had no way to find one by typing.
     Same PATTERN as \`.repo-pop\` in styles.ts (search row, ticked rows, footer),
     deliberately not the same rules: that sheet predates the token module and
     spends raw px and \`--vscode-input-*\` directly. Sharing one stylesheet would
     mean either restyling the sidebar's combos in this pass (a regression risk
     for a control this task does not touch) or importing sidebar CSS into the
     Deck bundle. The COMPONENT is shared, which is where the behaviour lives. */
  .combo { position: relative; }
  /* Bar weight, not input weight. The trigger stands beside \`.orch-mini\`
     buttons and borrows their metrics for the same reason the \`<select>\` it
     replaced did (see \`.orch-bar .orch-sel\` above): on a surface whose one
     accented control is Arm, an "add" picker must not be the heaviest thing in
     its row. The caret is what says, honestly, that this one opens a list. */
  .combo-trigger { display: inline-flex; align-items: center; gap: 4px; height: 20px;
    padding: 0 6px 0 7px; border: 1px solid var(--edge); border-radius: var(--r-chip);
    background: transparent; color: var(--dim); cursor: pointer;
    font-size: var(--t-micro); white-space: nowrap; }
  .combo-trigger:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
  .combo-trigger[aria-expanded="true"] { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); }
  .combo-caret { opacity: .6; }

  /* Floats, and needs to: the bar it hangs off is one row tall, and an inline
     panel would push the graph (or the rule list) down by its own height every
     time it opened. \`.orch-body\` is \`overflow: hidden\`, so this is clipped by
     the drawer's own bottom edge rather than escaping to the page — which is
     the correct boundary for a panel that belongs to the drawer, and is why the
     list is capped at 190px instead of growing with the option count. */
  /* RIGHT-anchored, and measured rather than guessed: both Add bars push their
     controls to the right edge with a spacer, so a popup that grew rightwards
     from \`left: 0\` ran straight off the drawer — the screenshot showed the Add
     button itself clipped by the window edge. Growing leftwards from the
     trigger's right edge keeps it inside the drawer at every width, with no
     measurement in JS. */
  .combo-pop { position: absolute; z-index: 20; top: calc(100% + 4px); right: 0; min-width: 240px;
    border: 1px solid var(--vscode-focusBorder); border-radius: var(--r-ctl); overflow: hidden;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    box-shadow: 0 6px 20px -8px rgba(0,0,0,.5); }
  .combo-search { display: flex; align-items: center; gap: 6px; padding: 6px 9px;
    border-bottom: 1px solid var(--hair); }
  .combo-search svg { flex: none; opacity: .55; }
  .combo-search input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent;
    color: var(--vscode-foreground); font: inherit; font-size: var(--t-body); }
  .combo-search input::placeholder { color: var(--vscode-input-placeholderForeground, var(--dim)); }
  .combo-list { max-height: 190px; overflow-y: auto; padding: 4px; }
  .combo-opt { display: flex; align-items: flex-start; gap: 8px; padding: 4px 6px;
    border-radius: var(--r-chip); cursor: pointer; color: var(--vscode-foreground); }
  .combo-opt.active { background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground); }
  .combo-box { flex: none; width: 13px; height: 13px; margin-top: 1px; border-radius: 3px;
    border: 1px solid var(--edge); display: flex; align-items: center; justify-content: center;
    font-size: var(--t-micro); line-height: 1; }
  /* The ticked state is a fill, and this is the one place on this surface where
     that is right: a checkbox with no fill is a checkbox you cannot read at a
     glance. It takes the theme's own button colours rather than \`--brand\`, so
     it never reads as a second primary beside Arm. */
  .combo-opt.checked .combo-box { background: var(--vscode-button-background);
    color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); }
  .combo-t { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .combo-t .l { font-size: var(--t-body); }
  /* A run key, not a sentence. Same treatment the tray's own chips give the same
     string (\`.orch-tchip .k\`), so one identifier does not read two ways on one
     surface — and set per OPTION, never per control: a command's label
     ("Deploy to staging") is prose and must stay in the UI font. */
  .combo-t .l.k { font-family: var(--mono); font-size: var(--t-data); }
  /* A command's own \`detail\` from settings — the sentence that says what it
     does. Second line rather than a title attribute: this is the only place the
     picker can explain a command before it becomes a node. */
  .combo-t .d { font-size: var(--t-micro); color: var(--dim); }
  .combo-opt.active .combo-t .d { color: inherit; opacity: .8; }
  .combo-empty { padding: 9px 7px; font-size: var(--t-body); color: var(--dim); }
  .combo-foot { display: flex; align-items: center; gap: 8px; padding: 6px 9px;
    border-top: 1px solid var(--hair); font-size: var(--t-micro); color: var(--dim); }
  .combo-foot .sp { flex: 1; }
  .combo-extra { border: 0; background: transparent; padding: 0; cursor: pointer;
    font-size: var(--t-micro); color: var(--vscode-textLink-foreground); }
  .combo-add { height: 19px; padding: 0 9px; border-radius: var(--r-chip);
    border: 1px solid var(--edge); background: transparent; color: var(--vscode-foreground);
    font-size: var(--t-micro); cursor: pointer; }
  .combo-add:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
  /* Nothing ticked yet: the button stays visible so the gesture is discoverable
     before it is available, but it cannot fire an empty add. */
  .combo-add:disabled { opacity: .45; cursor: default; color: var(--dim); }

  /* 168px is enough for a state dot, the key, and the one fact the rules read.
     Narrower and a node degenerates into a bare key. */
  .orch-node { position: absolute; width: 168px; padding: 7px 9px; cursor: grab; user-select: none;
    border: 1px solid var(--hair); border-radius: var(--r-ctl);
    background: color-mix(in srgb, var(--vscode-foreground) 6%, var(--vscode-editor-background)); }
  .orch-node:hover { border-color: color-mix(in srgb, var(--vscode-foreground) 26%, transparent); }
  .orch-node.sel { border-color: var(--brand); box-shadow: 0 0 0 1px var(--brand); }
  /* Not taken yet: dashed, because the place does not exist until something
     launches it. A notify terminal is not a place at all, so it loses a place's
     chrome entirely. */
  .orch-node.plan { border-style: dashed; background: transparent; }
  .orch-node.notify { width: 138px; border-radius: 16px; }
  /* A gate is the one node that carries a control, so it is the one node taller
     than NODE_H. The height is fixed rather than content-driven and MUST match
     GATE_H (layout.ts): edges anchor through boxOf at GATE_H/2, and a node that
     rendered at a different height would show its wire missing its own port. */
  .orch-node.gate { height: 70px; }
  .orch-node .gbtns { display: flex; gap: 5px; margin-top: 6px; }
  .orch-node .gbtn { flex: 1; height: 18px; border-radius: var(--r-chip);
    border: 1px solid var(--edge); background: transparent; color: var(--vscode-foreground);
    font-size: var(--t-micro); cursor: pointer; font-family: inherit; line-height: 1; }
  /* --c-done, not --brand: this is a STATE, and tokens.test.ts asserts set
     equality over each stylesheet's --brand rules, so a new brand rule would
     fail that gate until registered. Reject takes the neutral edge — grey, not
     --c-danger, because a rejection is your decision and not a failure. */
  .orch-node .gbtn.ok { border-color: color-mix(in srgb, var(--c-done) 55%, transparent);
    color: var(--c-done); }
  .orch-node .gbtn:hover { background: var(--vscode-toolbar-hoverBackground); }
  .orch-node .l1 { display: flex; align-items: center; gap: 6px; }
  .orch-node .l1 .d { width: 6px; height: 6px; border-radius: 50%; flex: none; }
  .orch-node .k { font-family: var(--mono); font-size: var(--t-data); }
  .orch-node .st { margin-top: 3px; font-size: var(--t-micro); color: var(--dim);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .orch-port { position: absolute; width: 10px; height: 10px; top: 50%; margin-top: -5px;
    border: 1px solid var(--edge); border-radius: 50%; cursor: crosshair;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); }
  .orch-port.out { right: -6px; }
  .orch-port.in { left: -6px; }
  .orch-port:hover { background: var(--brand); border-color: var(--brand); }
  /* While a wire is being drawn, every legal target announces itself. */
  .orch-graph.wiring .orch-node:not(.src) { border-color: color-mix(in srgb, var(--brand) 45%, var(--hair)); }
  .orch-graph.wiring .orch-node:not(.src) .orch-port.in { background: var(--brand); border-color: var(--brand); }

  .orch-graph svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }

  /* Sits ABOVE the midpoint, not on it: centred, a label as wide as the gap
     between two columns hides the whole connector it is labelling. */
  .orch-edge { position: absolute; transform: translate(-50%, -150%); white-space: nowrap; cursor: pointer;
    padding: 1px 6px; border: 1px solid var(--hair); border-radius: var(--r-chip);
    font-size: var(--t-micro); color: var(--dim);
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); }
  .orch-edge:hover { color: var(--vscode-foreground); border-color: var(--edge); }
  .orch-edge.sel { border-color: var(--brand); color: var(--vscode-foreground); }
  /* Danger tint only when the CONDITION is itself a failure — not decoration. */
  .orch-edge.bad { border-color: color-mix(in srgb, var(--c-danger) 40%, var(--hair)); }

  .orch-insp { flex: none; margin-top: 10px; padding: 10px 11px;
    border: 1px solid var(--hair); border-radius: var(--r-card);
    background: var(--vscode-editor-background); }
  .orch-insp.none { text-align: center; color: var(--dim); font-size: var(--t-body); padding: 16px 11px; }
  .orch-insp .t { display: flex; align-items: center; gap: 7px; margin-bottom: 8px;
    font-size: var(--t-micro); letter-spacing: .06em; text-transform: uppercase; color: var(--dim); }
  /* The eyebrow's uppercase is for its own word ("CONNECTION"), not for the two
     IDENTIFIERS beside it. A run key or a ticket key survives being shouted, but a
     free-text command is case-sensitive shell text and this row prints it —
     "deploy.sh --env=staging" rendered as "DEPLOY.SH --ENV=STAGING", which is not
     the command that runs. Scoped to this row's \`.k\` spans, which is where the
     identifiers are (and where \`--mono\` is already applied inline for the same
     reason: this is an identifier, not prose). */
  .orch-insp .t .k { text-transform: none; letter-spacing: 0; }
  .orch-insp .t .sp { flex: 1; }
  .orch-clause { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .orch-clause + .orch-clause { margin-top: 6px; }
  /* Three fixed-width keywords, so a rule reads as a sentence and not a form. */
  .orch-kw { width: 40px; flex: none; font-size: var(--t-micro); letter-spacing: .06em; color: var(--dim); }
  .orch-sel { height: 22px; padding: 0 7px; border-radius: var(--r-chip);
    border: 1px solid var(--edge); background: var(--vscode-input-background);
    color: var(--vscode-foreground); font: inherit; font-size: var(--t-body); cursor: pointer; }
  .orch-msg { flex: 1; min-width: 120px; height: 22px; padding: 0 7px; border-radius: var(--r-chip);
    border: 1px solid var(--edge); background: var(--vscode-input-background);
    color: var(--vscode-foreground); font: inherit; font-size: var(--t-body); }
  /* "Saved in settings as …" — the end state of the Save-to-settings row, and a
     statement rather than a control, so it takes the quiet voice every other
     receipt on this surface uses. No tick, no green: nothing was accomplished
     that the sentence does not already say, and \`--c-done\` is spent on a RULE
     that fired.

     Indented to the fields above it, not to the panel: 46px is \`.orch-kw\`'s own
     40px keyword column plus \`.orch-clause\`'s 6px gap, so the sentence starts
     where every value in this panel starts. Change either of those and this
     follows. */
  .orch-savedline { margin-top: 6px; padding-left: 46px; font-size: var(--t-micro); color: var(--dim); }

  /* A condition's own parameters (CondParams.tsx) — the repo and branch a
     \`branch-ci-passed\` rule watches, the status a \`ticket-status-is\` rule waits
     for, the span an idle rule counts. Two presentations render the same
     fragment: the inspector wraps it in a \`.orch-clause\` of its own, and a
     flowList row drops it straight into the flowing \`.fl-sentence\`. So these
     rules style the PARTS and never the row — a wrapper here would be right in
     one presentation and wrong in the other. */

  /* The word before a field ("repo", "branch"). Lower-case and unspaced, unlike
     \`.orch-kw\`: those three are the sentence's own skeleton and are shouted to
     read as one, while these sit INSIDE a clause and would compete with it. Not
     fixed-width either — two of them share a row, and a 40px column each would
     push the fields past the panel. */
  .orch-plabel { flex: none; font-size: var(--t-micro); color: var(--dim); }
  /* A minute count is at most three characters. \`.orch-msg\`'s \`flex: 1\` and
     120px floor would give it the width of a branch name and leave the label
     stranded, so this is the same field sized to what it holds. */
  .orch-num { width: 56px; flex: none; height: 22px; padding: 0 7px; border-radius: var(--r-chip);
    border: 1px solid var(--edge); background: var(--vscode-input-background);
    color: var(--vscode-foreground); font: inherit; font-size: var(--t-body); }
  /* "no branch set" — a rule that can never fire, said where it is fixed. NOT
     red: nothing has tried and failed, and red is spent in this codebase only on
     a real failure (see \`.orch-obs .err\` and \`.orch-edge.bad\`). This is
     unfinished work, which takes the same quiet voice \`.orch-savedline\` uses for
     the other statement on this surface. Arming says it louder, once, because by
     then it IS a consequence. */
  .orch-unset { flex: none; font-size: var(--t-micro); color: var(--dim); font-style: italic; }

  .orch-obs { margin-top: 8px; padding-top: 7px; border-top: 1px solid var(--hair);
    font-size: var(--t-micro); color: var(--dim); display: flex; align-items: center; gap: 8px; }
  .orch-obs .sp { flex: 1; }
  /* A fired rule's receipt reads as done, the same colour the board's own Done
     column uses — not a new claim of colour, the same one this codebase already
     spends on "this finished". */
  .orch-obs .fired { color: var(--c-done); }
  /* An errored rule tried and FAILED, and it will never be evaluated again until
     Reset. That is a real failure, which is the whole and only licence red has in
     this codebase — the same licence .orch-edge.bad spends above. */
  .orch-obs .err { color: var(--c-danger); }

  /* The drawer's ONE filled control, and the phase that earns it: Arm is the
     consent point for everything a flow does. Nothing else here may be filled. */
  .orch-arm { height: 26px; padding: 0 13px; border-radius: var(--r-ctl);
    border: 1px solid var(--brand); background: var(--brand); color: var(--brand-ink);
    font-size: var(--t-body); font-weight: 600; cursor: pointer; }
  .orch-arm:hover { filter: brightness(1.08); }
  /* Armed is a state, not an invitation: the fill goes away and the control
     becomes the quiet way back out. */
  .orch-arm.on { background: transparent; color: var(--vscode-foreground);
    border-color: color-mix(in srgb, var(--brand) 50%, var(--edge)); font-weight: 500; }

  .orch-ft .live { display: inline-flex; align-items: center; gap: 6px; }
  .orch-ft .live .d { width: 6px; height: 6px; border-radius: 50%; background: var(--dim); }
  .orch-ft .live.on .d { background: var(--brand); }
  /* A stalled rule is a real failure, so the armed dot stops reading as healthy.
     One dot, not a wall of red: the words beside it carry the count, and the
     inspector is where the failure is actually read. Ordered after .live.on so it
     wins at equal specificity — an armed AND stalled flow carries both classes. */
  .orch-ft .live.stalled .d { background: var(--c-danger); }

  /* The resume gate. Not red — nothing failed; a flow is waiting to be told to go. */
  .orch-resume { flex: none; margin-bottom: 12px; padding: 10px 12px;
    border: 1px solid color-mix(in srgb, var(--c-attn) 34%, var(--hair));
    border-left: 2px solid var(--c-attn); border-radius: var(--r-card);
    background: color-mix(in srgb, var(--c-attn) 5%, transparent); }
  .orch-resume .t { font-size: var(--t-body); font-weight: 600; margin-bottom: 5px; }
  .orch-resume ul { margin: 0 0 8px; padding-left: 18px; font-size: var(--t-micro); color: var(--dim); }
  .orch-resume .row { display: flex; gap: 6px; }

  /* The dry run. Deliberately NOT the resume gate's amber-washed card: that
     block is a thing to act on and this one is a thing to read, so it takes the
     quietest container this sheet has — a hairline and a 3% wash, no accent
     border. Capped and scrolling rather than growing: a flow with twenty rules
     must not push the graph it is describing off the bottom of the drawer. */
  .orch-dry { flex: none; margin-bottom: 12px; padding: 9px 11px;
    display: flex; flex-direction: column; max-height: 210px;
    border: 1px solid var(--hair); border-radius: var(--r-card);
    background: color-mix(in srgb, var(--vscode-foreground) 3%, transparent); }
  /* The rows are the only part that scrolls: the eyebrow above and the footer
     below are both claims about the whole panel, and a footer that scrolls out of
     sight is a disclaimer nobody reads (see the JSX's own comment). */
  .orch-dry .rows { flex: 1; min-height: 0; overflow: auto; }
  .orch-dry .hd { display: flex; align-items: center; gap: 7px; margin-bottom: 7px;
    font-size: var(--t-micro); letter-spacing: .06em; text-transform: uppercase; color: var(--dim); }
  .orch-dry .hd .sp { flex: 1; }
  /* The count carries no case or tracking of its own — it is a number, not a
     label, and reads as one beside the eyebrow it shares a row with. Emphasis,
     never hue, and for the same measured reason the verdict words gave it up
     (see the block below): weight survives a theme, 3.75:1 green on a Light+
     ground does not. It emphasises only once something would actually happen —
     "0 of 4 rules" in full foreground would put the answer "nothing" in the
     panel's loudest voice. */
  .orch-dry .hd .n { text-transform: none; letter-spacing: 0; }
  .orch-dry .hd .n.on { color: var(--vscode-foreground); font-weight: 600; }
  .orch-dry .r { display: flex; gap: 8px; align-items: baseline; padding: 3px 0; font-size: var(--t-body); }
  .orch-dry .s { flex: 1; min-width: 0; }
  .orch-dry .why { color: var(--dim); font-size: var(--t-micro); }
  .orch-dry .ft { margin-top: 8px; padding-top: 7px; border-top: 1px solid var(--hair);
    font-size: var(--t-micro); color: var(--dim); }

  /* One hue per verdict, carried by the DOT and never by the word. Measured, not
     assumed: on a Light+ ground these three hues run 2.17-3.75:1 as 10.5px text
     (\`--c-attn\` is a fixed hex, so its 2.17 is every theme's), against the 4.5:1
     a label that small needs. The same hues on a 5px dot are graphical, where the
     bar is 3:1 — and the words stay legible on any theme a user brings, including
     one whose \`charts.*\` overrides nobody here has seen. The drawer's own footer
     dot (\`.orch-ft .live .d\`) already reads this way: hue on the mark, plain text
     beside it.

     No red anywhere in this panel: nothing here has FAILED — that is
     \`.orch-obs .err\`'s licence, on a rule that tried. A dry run describes rules
     that have not run at all.
       fire    --c-done, the one thing that would actually happen
       defer   --c-idle, met and merely queued behind the cap
       blocked --c-attn, the same hue the resume gate spends on "needs you"
       unset   --c-attn too, and deliberately not a fourth hue: to a reader
               scanning the panel both mean "this one needs you before it can
               ever fire", and the WORD beside the dot is what separates a rule
               waiting on its card from a rule waiting on its own blank field
       waiting --dim, the resting state and the commonest, so it recedes

     The word carries a two-level hierarchy instead, which needs no hue at all:
     "would fire" at full foreground because it is what you opened the panel to
     find, and every not-now verdict at --dim. */
  .orch-dry .v { flex: none; width: 84px; display: inline-flex; align-items: center; gap: 5px;
    font-size: var(--t-micro); white-space: nowrap; color: var(--dim); }
  .orch-dry .v .d { width: 5px; height: 5px; border-radius: 50%; flex: none;
    background: color-mix(in srgb, var(--dim) 55%, transparent); }
  .orch-dry .v.fire { color: var(--vscode-foreground); font-weight: 600; }
  .orch-dry .v.fire .d { background: var(--c-done); }
  .orch-dry .v.defer .d { background: var(--c-idle); }
  .orch-dry .v.unset .d { background: var(--c-attn); }
  .orch-dry .v.blocked .d { background: var(--c-attn); }

  /* The keyboard path onto the same rules the canvas draws (flowList.tsx).
     Fills the body the same way the tray+graph+inspector block does when
     Canvas is selected, so switching views never changes the drawer's own
     size or position. */
  .fl-list { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 6px; }
  .fl-row { border: 1px solid var(--hair); border-radius: var(--r-card); padding: 8px 10px;
    background: var(--vscode-editor-background); cursor: pointer; }
  .fl-row:hover { border-color: color-mix(in srgb, var(--vscode-foreground) 26%, transparent); }
  /* Roving tabindex (see flowList.tsx's own comment on rowTabIndex): only
     the current row is ever a real Tab stop, so its focus ring is this
     surface's one visible "you are here" — never a fill, matching the grip's
     own focus-visible rule below it in this file. */
  .fl-row:focus { outline: none; box-shadow: inset 0 0 0 1px var(--vscode-focusBorder); }
  .fl-row.open { border-color: color-mix(in srgb, var(--vscode-foreground) 30%, var(--hair)); }
  .fl-sentence { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .fl-receipt { margin-top: 7px; padding-top: 6px; border-top: 1px solid var(--hair);
    display: flex; align-items: center; gap: 8px; font-size: var(--t-micro); color: var(--dim); }
  /* Same two licences as the inspector's .orch-obs, and for the same reasons:
     "fired" borrows the board's own Done colour rather than a new claim of
     colour, and red is spent ONLY on a rule that tried and actually failed. */
  .fl-receipt .fired { color: var(--c-done); }
  .fl-receipt .err { color: var(--c-danger); }

  /* Add a rule, from the keyboard (flowList.tsx's NewRuleBar). Dashed border
     marks it as the "build one" affordance rather than a rule already on
     disk — everything else about it (gap, wrap, the .orch-kw/.orch-sel it
     borrows) is deliberately the same quiet language a row already speaks. */
  .fl-newrule { border: 1px dashed var(--hair); border-radius: var(--r-card); padding: 8px 10px;
    margin-top: 6px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; flex: none; }
`;
