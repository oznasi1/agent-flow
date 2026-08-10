// The Orchestrator drawer. Read alongside the approved mockup at
// docs/mockups/2026-08-05-deck-orchestrator-drawer.html (?v=canvas) — that file is
// the visual contract and is git-ignored, so it lives only in the primary checkout.
//
// Two things here are deliberate and easy to "fix" wrongly:
//  1. The drawer starts BELOW the Deck header, not at the top of the panel. The
//     header carries the chip you just pressed and the Live-signal / PR-facts
//     toggles the conditions read from; covering them hides the state.
//  2. There is NO scrim. A modal veil would block the drag the drawer exists to
//     receive — the board stays fully live while the drawer is open.
// Width is user-resizable: a grip on the drawer's left border (this task), and
// on top of that plumbing, an expand toggle (Task 4). --orch-w carries the live
// value. It is declared right here, locally, with the phase-1 pixel figure as
// its default — so tokens.test.ts's orphan-usage check sees a real declaration
// in this sheet and never needs --orch-w added to the RUNTIME_ONLY allowlist.
// OrchestratorDrawer.tsx then overrides it with an inline style carrying the
// current (dragged, arrow-keyed, or persisted) width — the override direction
// only works because the default already exists here to be overridden.
/** How long the drawer's slide takes, in ms. Declared HERE, beside the
 * keyframes it drives, and imported by `OrchestratorDrawer.tsx` rather than
 * duplicated there: that file holds the closing drawer mounted for exactly
 * this long, so a number that drifted from the CSS would either cut the
 * slide off mid-flight or park an invisible drawer in the DOM. This module
 * imports nothing, so the dependency only ever points one way. */
export const ORCH_ANIM_MS = 180;

/** How far an edge chip's own centre is painted from the point it is positioned
 * at, in px — negative because it sits ABOVE that point. Declared HERE for the
 * same reason `ORCH_ANIM_MS` is: `.orch-edge` below carries
 * `transform: translate(-50%, -150%)`, and this number is the vertical half of
 * that transform resolved against the chip's own height (a `--t-micro` line plus
 * 1px padding and a 1px border each way, ~19px, so -150% lifts the box to sit
 * between ~9 and ~28px above the point and centres it ~19px above).
 *
 * `OrchestratorDrawer.tsx` hands it to `labelPoint` (layout.ts) as that
 * function's `paintDy`, which is what makes the obstacle search avoid boxes for
 * the CHIP rather than for its anchor. Without it, every downward escape stepped
 * the anchor clear and then painted the chip straight back into the box it had
 * escaped — over a node's only status word. Change the transform below and this
 * number changes with it; they are one fact in two languages, the same way
 * `NOTIFY_W` and `.orch-node.notify`'s width are. */
export const ORCH_EDGE_PAINT_DY = -19;

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

  .orch { position: fixed; top: 53px; right: 0; bottom: 0; --orch-w: 560px; width: var(--orch-w); z-index: 40;
    display: flex; flex-direction: column;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border-left: 1px solid var(--hair); box-shadow: -14px 0 34px -12px rgba(0,0,0,.45);
    animation: orch-in ${ORCH_ANIM_MS}ms cubic-bezier(.22,.61,.36,1) both; }

  /* The drawer is anchored to the right edge, so it arrives and leaves along
     that edge — a panel that slid up, faded, or scaled would be inventing a
     second story about where this surface lives. The distance is the drawer's
     own width, so the slide starts fully off-screen no matter how wide the
     user has dragged it, and the opacity ramp is short and front-loaded: it
     exists to soften the shadow's arrival, not to make the panel read as
     translucent on the way in.

     \`both\` matters. Without it the first painted frame is the drawer at its
     final position, and the animation then jumps it back off-screen — one
     frame of flash on every open. */
  @keyframes orch-in {
    from { transform: translateX(100%); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }

  /* Closing. \`OrchestratorDrawer.tsx\` keeps the aside mounted for exactly
     ORCH_ANIM_MS after \`openId\` drops, drawing the flow it last held, and
     that span is what this animates. Inert throughout — \`pointer-events\`
     off, and the element carries \`aria-hidden\` — because a drawer already
     on its way out must not take a click that was meant for the board
     behind it.

     The declared \`opacity: 0\` is the reduced-motion fallback, and it is load
     bearing. tokens.ts's reset carries a global
     \`* { animation: none !important }\` for users who have asked the system
     for less motion, which suppresses \`orch-out\` outright — and the unmount
     is a JS timer, so without this the drawer would sit fully visible in
     place for ORCH_ANIM_MS after the user dismissed it. A running animation
     outranks a declared value, so while \`orch-out\` plays this is inert and
     the keyframes own the fade; it only takes effect when they are gone.
     (The query itself is deliberately not written here — tokens.test.ts
     asserts no surface sheet carries a motion reset of its own, and the
     shared one in tokens.ts is the only place that should.) */
  .orch.closing { animation-name: orch-out; pointer-events: none; opacity: 0; }
  @keyframes orch-out {
    from { transform: translateX(0); opacity: 1; }
    to { transform: translateX(100%); opacity: 0; }
  }

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

  .orch-flows { position: absolute; right: 16px; top: 40px; z-index: 5; min-width: 160px;
    border: 1px solid var(--edge); border-radius: var(--r-ctl); padding: 4px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    box-shadow: 0 6px 20px -8px rgba(0,0,0,.5); }
  .orch-flows button { display: block; width: 100%; text-align: left; border: 0; background: transparent;
    color: var(--vscode-foreground); font: inherit; font-size: var(--t-body);
    padding: 5px 8px; border-radius: var(--r-chip); cursor: pointer; }
  .orch-flows button:hover { background: var(--vscode-toolbar-hoverBackground); }

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
  /* An "add a node" picker sitting in a bar of buttons. \`.orch-sel\`'s own
     metrics (22px, --t-body, an input-coloured fill) belong to the inspector's
     sentence rows, where a select IS the sentence; on this bar the same element
     sat beside three \`.orch-mini\` buttons and became the heaviest thing in the
     row — taller, filled where they are transparent, and stretched to its widest
     option — which on a surface whose one accented control is Arm is a claim it
     has no business making. So it borrows \`.orch-mini\`'s height, type, border
     and dim foreground: the row reads as four controls of one weight, and the
     chevron still says (honestly, unlike a button) that this one opens a list.

     Not a new class, and not applied per element: scoping by the BAR is what
     makes it cover the place picker in the list view's own \`.orch-bar\` too —
     that select had exactly the same mismatch and the same fix, and a modifier
     class would have fixed whichever one someone remembered.

     \`max-width\` because a select's intrinsic width is its widest OPTION
     ("Deploy to staging", or a run key plus a repo), which is what stretched the
     row; the closed control only ever shows its own short placeholder, and the
     popup the browser opens is sized to its contents regardless of this cap. */
  .orch-bar .orch-sel { height: 20px; padding: 0 4px 0 7px; font-size: var(--t-micro);
    max-width: 150px; color: var(--dim); background: transparent; }
  .orch-bar .orch-sel:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }

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
