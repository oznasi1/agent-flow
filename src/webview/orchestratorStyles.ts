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
// Width is a fixed 560px in this phase: resize and expand were cut from Phase 2a
// and tracked as a known gap, not built here. Do not reintroduce a var(--orch-w,
// 560px) indirection speculatively — nothing sets that variable yet, and
// tokens.test.ts's orphan-usage check is what caught it last time. A real resize
// task can add the variable back once something actually sets it inline.
export const ORCH_CSS = `
  .orch-chip { gap: 6px; }
  .orch-chip .ic { font-size: 12px; line-height: 1; }
  .orch-chip .ct { font-family: var(--mono); font-size: var(--t-micro); color: var(--dim); }

  .orch { position: fixed; top: 53px; right: 0; bottom: 0; width: 560px; z-index: 40;
    display: flex; flex-direction: column;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border-left: 1px solid var(--hair); box-shadow: -14px 0 34px -12px rgba(0,0,0,.45); }

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
`;
