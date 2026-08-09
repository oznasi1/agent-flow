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
export const ORCH_CSS = `
  .orch-chip { gap: 6px; }
  .orch-chip .ic { font-size: 12px; line-height: 1; }
  .orch-chip .ct { font-family: var(--mono); font-size: var(--t-micro); color: var(--dim); }
  /* Armed is what is quietly spending your attention while the drawer is
     closed — worth reading at a glance, but the chip stays a chip: Arm is the
     drawer's one filled control, so this earns weight through contrast and
     weight alone, never a fill of its own. */
  .orch-chip.armed .ct { color: var(--vscode-foreground); font-weight: 600; }

  .orch { position: fixed; top: 53px; right: 0; bottom: 0; --orch-w: 560px; width: var(--orch-w); z-index: 40;
    display: flex; flex-direction: column;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border-left: 1px solid var(--hair); box-shadow: -14px 0 34px -12px rgba(0,0,0,.45); }

  /* The resize grip, centred ON the left border rather than beside it — half
     outside the drawer's box, half inside — so it never nudges the header,
     body, or footer's own layout. Never brand-tinted: this surface's one
     filled/accented control is Arm (.orch-arm below); a resize handle earning
     the same treatment would read as a second primary control on one surface. */
  .orch-grip { position: absolute; left: -4px; top: 0; bottom: 0; width: 9px; z-index: 1;
    background: transparent; border: 0; padding: 0; cursor: ew-resize; }
  .orch-grip:hover { background: color-mix(in srgb, var(--vscode-foreground) 10%, transparent); }
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
  .orch-bar { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
  .orch-bar .sp { flex: 1; }

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
`;
