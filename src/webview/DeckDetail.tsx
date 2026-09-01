import * as React from "react";
import { send } from "./vscodeApi";
import { isTicketRun, runKind, type BranchCiStatus, type FlowTemplate, type PrFacts, type RunStatus } from "../types";
import { formatEq, weightedEq, type UsageTotals } from "../engine/usage";
import type { DeckCard } from "./deckCards";
// Same import DeckApp.tsx's own Card makes, and safe for the same reason: bucket.ts
// is kept free of fs-touching imports, which bucket.test.ts enforces.
import { prSignals } from "../engine/bucket";
import { AgentsRow, PrBlock, RepoChip, WorkspaceChip, workspaceLabel } from "./deckParts";
import { Drawer } from "./Drawer";
import { CardKindIcon } from "./icons";
import { createDrawerResize, RESIZE_STEP } from "./drawerResize";
import { keyLabel, timeAgo } from "./helpers";
import type { Flow } from "../engine/orchestrator/model";
import { attachedWorkflows, rankByState, workflowState } from "../engine/orchestrator/attach";
import { WorkflowBlock } from "./WorkflowBlock";

export interface DeckDetailProps {
  card: DeckCard;
  sourceLabel: string;
  /** This run's token usage. Three states, all distinct on screen:
   * `undefined` — not read yet (the request is in flight);
   * `null` — the host tried and could not read it;
   * a total — including a genuine all-zero, which is NOT the same as either above.
   * Printing 0 for an unread run would assert it cost nothing. */
  usage?: UsageTotals | null;
  /** Sliding out. The card this drawer draws is the one it last held, not one
   * still selected on the board — `DeckApp.tsx` owns that bookkeeping through
   * `useDrawerExit`, because the selection state this drawer would need to read
   * it from lives there. Absent means open, which is what every caller that
   * only ever renders an open drawer gets for free. */
  closing?: boolean;
  /** Every flow on the board, so this card's own workflow(s) can be derived
   * (`attachedWorkflows`) rather than read off a field that could disagree with
   * the graph — see attach.ts's own header comment for why attachment is never
   * stored. */
  flows: Flow[];
  /** Reusable shapes the attach picker offers. Rides `deck:flows` alongside
   * `flows` itself (see types.ts's own comment on `templates`), and is empty
   * whenever the orchestrator is off — never "not loaded yet" and empty at once. */
  templates: FlowTemplate[];
  /** Every run on the board — `workflowState`/`previewFlow` need it to answer
   * conditions that read OTHER cards, not just this one. The full list, not a
   * caller's already-filtered one: same reasoning as `OrchestratorDrawer`'s own
   * `runs` prop. */
  runs: RunStatus[];
  /** Branch-CI verdicts, keyed `repo#branch` — the same map `evaluateFlow` and
   * the Orchestrator drawer read, so this drawer's workflow state cannot disagree
   * with theirs about what a `branch-ci-passed` rule is waiting on. */
  branchCi: Record<string, BranchCiStatus>;
  /** `agentFlow.orchestrator`. The Workflow section — chip, block, picker,
   * everything — renders nothing at all while this is false: the setting
   * defaults off, and new surface must ship inert. */
  orchEnabled: boolean;
  onClose: () => void;
  onForget: (key: string) => void;
  /** "Open in Workflows ↗" on the block header. Sends no message of its own —
   * the Orchestrator drawer already renders from state `DeckApp.tsx` holds, so
   * this just names which flow to open there; the same component that owns
   * `openFlowId` also owns closing this drawer, the way its own Orchestrator
   * chip already does when it opens the drawer over a selected card. */
  onOpenWorkflow: (flowId: string) => void;
}

/** The search-and-tick list `+ Add command…`/`+ Add place…` (`combo.tsx`'s
 * `MultiCombo`) use, adapted for a single immediate pick rather than
 * tick-then-commit: attaching a workflow binds exactly one template, so there
 * is nothing to batch and no second "Add" click to wait for. Not a second
 * `MultiCombo` instance — that component's whole shape is built around
 * committing a ticked SET in one call, which has no meaning for a picker that
 * answers with one templateId and closes. */
function WorkflowPicker({
  ticketKey,
  templates,
  onPick,
  onClose,
}: {
  ticketKey: string;
  templates: FlowTemplate[];
  onPick: (templateId: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [q, setQ] = React.useState("");
  const rootRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const placeholder = `Choose a template for ${ticketKey}…`;
  const filtered = templates.filter((t) => t.name.toLowerCase().includes(q.toLowerCase()));

  React.useEffect(() => { inputRef.current?.focus(); }, []);
  // Same click-outside/Escape shape `useComboFilter` gives every other picker
  // in this app — this one is not built on that hook (its open/closed state
  // lives one level up, in `pickerOpen`, not inside this component), but a
  // reader who dismisses any other picker this app renders the same two ways
  // must get the same two ways here.
  React.useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div className="wf-picker" ref={rootRef}>
      <div className="wf-picker-search">
        <input
          ref={inputRef}
          value={q}
          spellCheck={false}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(e) => setQ(e.target.value)}
        />
        <button type="button" className="wf-picker-close" aria-label="Cancel" onClick={onClose}>✕</button>
      </div>
      <div className="wf-picker-list">
        {templates.length === 0 && <div className="wf-picker-empty">No templates saved yet</div>}
        {templates.length > 0 && filtered.length === 0 && <div className="wf-picker-empty">No match for “{q}”</div>}
        {filtered.map((t) => (
          <button key={t.id} type="button" className="wf-picker-opt" onClick={() => onPick(t.id)}>
            {t.name}
          </button>
        ))}
      </div>
    </div>
  );
}

/** This drawer's own instance of the shared width machinery (`drawerResize.ts`) —
 * the ceiling, clamp, "full panel width" escape hatch, and defensive read/write,
 * all parameterized here rather than re-derived. A floor of 460px is this
 * drawer's own former fixed width: already proven, by the header comments below,
 * to hold the identity row without wrapping or clipping. A default of 620px is
 * wider than that floor on purpose — the extra room this rebuild exists to give
 * the promoted actions and the fact strips below. `ddResize.MIN`/`ddResize.DEFAULT`
 * mirror those two numbers back out, and the component reads them from there
 * rather than a second pair of local constants — see `drawerResize.ts`'s own
 * note on why the factory returns them.
 *
 * Persisted under `"ddWidth"`, never the Orchestrator drawer's `"orchWidth"`:
 * `persist` merges into the one shared state object (see `drawerResize.ts`), so
 * the two keys coexist without either drawer's resize wiping the other's. */
const ddResize = createDrawerResize({ min: 460, def: 620, key: "ddWidth" });

/** One row in the action list, rendered inside the `More` disclosure. `run`
 * does the work; the list itself is data so a future row can never drift from
 * what actually renders. The four busiest actions (Open workspace, Open PR,
 * Diff, Address PR) are promoted out of this list entirely — see `dd-acts`
 * below — so this shape now describes only what `More` holds. */
interface Action {
  label: string;
  /** Extra context beside the label — an identifier (a branch, a key, a PR
   * number, a path) when `id` is set, prose ("give this place a ticket", "the
   * worktree is left untouched") otherwise. Only an identifier earns the mono
   * treatment: the spec's rule is mono for identifiers, UI font for anything
   * that reads as English. */
  hint?: string;
  /** `hint` is an identifier, not prose — renders in the mono font. */
  id?: true;
  danger?: boolean;
  run: () => void;
}

/** Clipboard writes are webview-local on purpose: routing them through the host
 * would mean a new message for something the browser already does. Guarded
 * because a webview without clipboard permission has no `navigator.clipboard`,
 * and an unguarded read throws out of the click handler. */
function copy(text: string): void {
  void navigator.clipboard?.writeText(text);
}

export function DeckDetail({
  card, sourceLabel, usage, closing = false, flows, templates, runs, branchCi, orchEnabled,
  onClose, onForget, onOpenWorkflow,
}: DeckDetailProps): JSX.Element {
  const r = card.status;
  const key = r.run.key;
  const tracked = isTicketRun(r.run);
  const local = runKind(r.run) === "local";
  const repo = card.agent?.repo;
  const own = repo ? r.run.repos.find((x) => x.name === repo) : undefined;
  const branch = (own ?? r.run.repos[0])?.branch ?? "";
  // Same plain-cast pattern DeckApp.tsx's own Card uses around its withPr (near
  // the PR block), rather than a self-referential type predicate — `Object.entries`
  // order is preserved, and a null `facts` is skipped, same as there.
  const withPr = Object.entries(r.prs).filter(([, e]) => e.facts !== null) as [string, { facts: PrFacts }][];
  const lead = withPr[0]?.[1].facts;

  // A place binds by the run key every card has; a planned node binds by the
  // ticket key, which a local card only has when the host could infer one off
  // its branch (see `inferredKey`'s identical reasoning in DeckApp.tsx's Card).
  const boundTicketKey = tracked ? key : r.inferredTicketKey;
  // `[]` while the setting is off rather than skipping the call: `orchEnabled`
  // is the one gate for the whole section below, so nothing downstream needs a
  // second one. `Date.now()` is read fresh on every render, deliberately not
  // memoized — `workflowState`/`rankByState` are pure and cheap (bounded by one
  // flow's edge count, same as the board's own per-card chip already computes
  // every tick), and a cached wall-clock reading is exactly the kind of state
  // that goes stale the moment the drawer sits open across a poll: a
  // `branch-ci-passed` rule waiting on an elapsed window would freeze mid-wait
  // until some unrelated prop changed and evicted the memo. Recomputing here
  // costs nothing a `useMemo` keyed on `Date.now()` itself would have saved —
  // that key invalidates every render anyway — so a plain call is the whole fix.
  const bound = orchEnabled ? rankByState(attachedWorkflows(flows, key, boundTicketKey), runs, Date.now(), branchCi) : [];
  const wf = bound[0];
  const wfState = wf ? workflowState(wf, runs, Date.now(), branchCi) : undefined;
  const [pickerOpen, setPickerOpen] = React.useState(false);

  // Address PR rides the column, not the ticket status. In review means one thing
  // now that ready-to-merge is a column of its own — a PR somebody still has to
  // look at — so the old `lane === "waiting"` half of this test is what the column
  // itself says. The `local` guard stays: a local card's key is read off its
  // branch, so its status may belong to a ticket somebody else owns, not something
  // to start a session against. prSignals(r.prs).open guards the remaining hole: a
  // card can reach review off its Jira status alone, with `prs: {}` and no actual
  // PR to address.
  const canAddressPr = !local && card.column === "review" && prSignals(r.prs).open;

  const openWorkspace = () => send({ type: "deck:inspect", key, action: "open", ...(repo ? { repo } : {}) });
  const diffAll = () => send({ type: "deck:inspect", key, action: "diff", ...(repo ? { repo } : {}) });
  const addressPr = () => send({ type: "deck:addressPr", key });
  const openLeadPr = () => lead && send({ type: "openExternal", url: lead.url });

  // Everything that used to live here MINUS the four rows promoted into
  // `dd-acts` above the fold (Open workspace, Open PR, the old "Diff — all
  // repos" row — now the promoted plain "Diff" button, calling the same
  // `diffAll` and dropped from this list entirely rather than kept under its
  // old label — and Address PR): those keep exactly the same handlers, called
  // from the promoted buttons instead, so nothing about what a click actually
  // does has changed, only where the button sits. Removing them here rather
  // than duplicating them is what keeps every action reachable exactly once —
  // a row surviving in both places would give a screen reader (and
  // `getByRole`) two buttons with the same handler and a different label,
  // which is a subtler bug than a name collision: nothing catches it by
  // accessible name alone, only by tracing what each row actually calls.
  const actions: { group: string; items: Action[] }[] = [
    { group: "This task", items: [
      ...(r.repos.length > 1
        ? r.repos.map((g) => ({ label: `Diff — ${g.name}`,
            run: () => send({ type: "deck:inspect", key, action: "diff", repo: g.name }) }))
        : []),
      ...(tracked
        ? [{ label: `Open in ${sourceLabel}`, hint: key, id: true as const,
            run: () => send({ type: "openExternal", url: r.run.url }) }]
        : []),
    ] },
    // Only the lead PR's failing checks: `Open PR #N` itself is promoted, and
    // the old list never gave a non-lead repo's PR or checks an action of
    // their own either (see the `lead` guard here, unchanged from before) —
    // those stay reachable the way they always were, through the PR block's
    // own inline links.
    { group: "Pull request", items: lead
      ? lead.ci.failing.filter((c) => c.url).map((c) => ({
          label: `Open failing check — ${c.name}`,
          run: () => send({ type: "openExternal", url: c.url }),
        }))
      : [] },
    { group: "Copy", items: [
      ...(branch ? [{ label: "Copy branch name", hint: branch, id: true as const, run: () => copy(branch) }] : []),
      ...(tracked ? [{ label: "Copy ticket key", hint: key, id: true as const, run: () => copy(key) }] : []),
      ...(lead ? [{ label: "Copy PR url", hint: `#${lead.number}`, id: true as const, run: () => copy(lead.url) }] : []),
      ...((own ?? r.run.repos[0])
        ? [{ label: "Copy worktree path", hint: (own ?? r.run.repos[0]).path, id: true as const,
            run: () => copy((own ?? r.run.repos[0]).path) }]
        : []),
    ] },
    { group: "Record", items: [
      local
        ? { label: "Track it", hint: "give this place a ticket", run: () => send({ type: "deck:track", key }) }
        : { label: "Forget", hint: "the worktree is left untouched", danger: true, run: () => onForget(key) },
    ] },
  ];

  const groups = actions.filter((g) => g.items.length > 0);
  const ws = workspaceLabel(r.run);

  // Width state for the resize grip below. Read once at mount (persisted value,
  // clamped to the current viewport) and written back only on drag-release or an
  // arrow-key press — the same shape `OrchestratorDrawer.tsx` uses over its own
  // `orchResize` instance, parameterized here on `ddResize` instead.
  const [width, setWidth] = React.useState<number>(() => ddResize.clamp(ddResize.read() ?? ddResize.DEFAULT));
  const [resizing, setResizing] = React.useState<{ startX: number; startW: number } | null>(null);
  /** Mirrors `OrchestratorDrawer.tsx`'s own `resizeRef`: `pointerup` can arrive
   * before React flushes the last `pointermove`'s `setWidth`, so the release
   * handler below reads this ref (written synchronously in `move`) rather than
   * the `width` this effect closed over. */
  const resizeRef = React.useRef<number | null>(null);
  const [moreOpen, setMoreOpen] = React.useState(false);

  // One pointer handler pair on `window`, live only while a resize is in
  // progress, torn down the moment it ends. The persist happens once, in `up`,
  // not on every move — a disk write per pixel would be wasteful.
  React.useEffect(() => {
    if (!resizing) return;
    const move = (e: PointerEvent) => {
      // Pulling the left border further LEFT (a smaller clientX) grows the
      // drawer, since it is anchored to the right edge of the panel.
      const next = ddResize.clamp(resizing.startW + (resizing.startX - e.clientX));
      resizeRef.current = next;
      setWidth(next);
    };
    const up = () => {
      const finalWidth = resizeRef.current ?? resizing.startW;
      resizeRef.current = null;
      setResizing(null);
      ddResize.persist(finalWidth);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [resizing]);

  const startResize = (e: React.PointerEvent) => setResizing({ startX: e.clientX, startW: width });

  /** ArrowLeft grows the drawer, ArrowRight shrinks it — the same mapping the
   * pointer drag uses above: pulling the left border further left is what
   * makes the drawer wider. Persisted immediately, same as a released drag,
   * rather than waiting for the grip to lose focus. */
  const onGripKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = ddResize.clamp(e.key === "ArrowLeft" ? width + RESIZE_STEP : width - RESIZE_STEP);
    setWidth(next);
    ddResize.persist(next);
  };

  // `--dd-w` is written on `document.documentElement` (`:root`), not as an
  // inline style on this drawer's own element. A custom property only
  // cascades to descendants of wherever it's declared, and `.board` — the
  // rule that has to track this width so a resized drawer never permanently
  // covers the last column (`.board.dd-open` in deckStyles.ts) — is
  // `DeckApp.tsx`'s sibling of this drawer, not its child. `:root` is the one
  // ancestor common to both, so that's where the live value has to live.
  // `useLayoutEffect`, not `useEffect`: this runs before the browser paints,
  // so a mount with a persisted non-default width (e.g. 800px) never flashes
  // the CSS's own 620px fallback first. The cleanup removes the property on
  // every re-run (including unmount) rather than leaving a stale value for
  // whichever drawer opens next — harmless in practice (`.board.dd-open` only
  // ever applies while _this_ drawer is the one open) but one fact in one
  // place either way.
  React.useLayoutEffect(() => {
    document.documentElement.style.setProperty("--dd-w", `${width}px`);
    return () => { document.documentElement.style.removeProperty("--dd-w"); };
  }, [width]);

  return (
    <Drawer surface="dd" label={`Detail for ${key}`} closing={closing}>
      {/* Same ARIA shape as the Orchestrator drawer's own grip (role="separator"
          + aria-orientation, keyboard-resizable): one resize control, one
          contract, on both drawers this shell serves. A direct child of
          `.drawer` — a sibling of `.dd-scroll` below, never inside it — is
          load-bearing, not cosmetic: `.dd-scroll` is the one element that
          scrolls and clips horizontally, and the grip sitting a few pixels
          outside this element's own left border needs neither to happen to
          it. Inside `.dd-scroll` it would have been clipped by that element's
          `overflow-x: hidden` (the same rule that keeps a long mono row from
          taking the close button off-screen) and would have scrolled out of
          reach the moment the panel's content — likely `More`, once open —
          grew past one screen. */}
      <div
        className="dd-grip"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize detail drawer"
        aria-valuenow={Math.round(width)}
        aria-valuemin={ddResize.MIN}
        aria-valuemax={ddResize.ceiling()}
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={onGripKeyDown}
      />
      {/* The one scrolling, horizontally-clipping element — see the grip's own
        * comment above for why it has to be everything BUT the grip. */}
      <div className="dd-scroll">
        <div className="dd-hd">
          {/* Identity on one row, the title on the next. The title shared this row until
           * a long one proved it could not: it and the status pill are both shrinkable,
           * so at 460px they split the shortfall and neither came out readable. What
           * names the run — mark, key, status — is short and bounded and belongs on a
           * line together; the title is neither, and gets a line of its own below. */}
          <div className="dd-id">
            {/* The card's own mark, at the card's own size: a selected card and its
              * drawer are one object, and a smaller mark here would read as two. */}
            <CardKindIcon kind={runKind(r.run)} provider={r.provider} />
            {/* The label, not the raw key: a notepad key is ~64 mono characters — wider
             * than the drawer itself, which as a nowrap flex item took the header (and
             * with it the whole drawer) into horizontal scroll, pushing the summary to
             * zero width and the close button off-screen. Same rule the card's own key
             * chip uses, so the two name the same run the same way. The full key stays
             * on the title, and Copy ticket key still copies it verbatim. */}
            <span className="k" title={key}>{keyLabel(r.run)}</span>
            {/* Moved verbatim off the card's old .c-foot — the design's own list of
             * what relocates here names "the status pill" alongside the branch row,
             * repo chips, PR blocks and agents fold. */}
            {r.ticketStatus && <span className="pill" title={`${sourceLabel} status: ${r.ticketStatus}`}>{r.ticketStatus}</span>}
            <button type="button" className="dd-x" aria-label="Close" onClick={onClose}>✕</button>
          </div>
          {/* No `title`: it wraps to as many rows as it needs, so the text is already
           * all there and a tooltip repeating it would be noise. */}
          <span className="t">{r.run.summary}</span>
        </div>

        {/* The drawer's busiest actions, promoted above the fold — everything else
          * (copy, per-repo diffs, the spend table, forget) lives one click away in
          * `More` below. A real `role="group"` with its own name, not just a div: a
          * reader tabbing through should land on "Actions" the same way they land
          * on any other named control group in this app. */}
        <div className="dd-acts" role="group" aria-label="Actions">
          <button type="button" className="dd-pact" onClick={openWorkspace}
            title={r.windowOpen ? "already running" : undefined}>
            Open workspace
          </button>
          {lead && (
            <button type="button" className="dd-pact" onClick={openLeadPr}>
              Open PR #{lead.number}
            </button>
          )}
          <button type="button" className="dd-pact" onClick={diffAll}>Diff</button>
          {canAddressPr && (
            <button type="button" className="dd-pact" onClick={addressPr} title="start a session against the review">
              Address PR
            </button>
          )}
        </div>

        {/* The workflow bound to this card, directly under the promoted actions —
          * see DeckDetailProps' own doc comments for why `orchEnabled` gates the
          * whole section, not just the picker: the setting defaults off and this
          * entire surface must ship inert. `bound` and `wf` are computed above,
          * once, from the same `flows`/`runs`/`branchCi` the Orchestrator drawer
          * reads, so this section and that drawer cannot disagree about the
          * workflow's state. */}
        {orchEnabled && (
          <div className="dd-sec">
            <div className="dd-lbl">Workflow</div>
            <WorkflowBlock
              flow={wf}
              state={wfState}
              extraCount={Math.max(bound.length - 1, 0)}
              onAttach={() => setPickerOpen(true)}
              onArm={(armed) => wf && send({ type: "flow:arm", id: wf.id, armed })}
              onDetach={() => wf && send({ type: "flow:detach", id: wf.id })}
              onAnswerGate={(edgeId, answer) => wf && send({ type: "flow:answerGate", id: wf.id, edgeId, answer })}
              onResetEdge={(edgeId) => wf && send({ type: "flow:resetEdge", id: wf.id, edgeId })}
              onOpenInWorkflows={() => wf && onOpenWorkflow(wf.id)}
            />
            {pickerOpen && (
              <WorkflowPicker
                ticketKey={boundTicketKey ?? key}
                templates={templates}
                onPick={(templateId) => {
                  send({
                    type: "flow:attach", runKey: key, templateId,
                    // A card that already carries a workflow can only gain a
                    // second one by explicit replacement — see `flow:attach`'s
                    // own doc comment in types.ts: an unset `replace` is a
                    // refusal, not a silent second attachment, when one is
                    // already there.
                    ...(bound.length > 0 ? { replace: true as const } : {}),
                  });
                  setPickerOpen(false);
                }}
                onClose={() => setPickerOpen(false)}
              />
            )}
          </div>
        )}

        {/* Work: a single-line fact strip. The label now shares the branch/elapsed
          * row instead of heading a block of its own — repo signal (dirty, ahead,
          * added/removed) stays on its own row below, since collapsing it into the
          * same line would either drop that detail or overflow every width this
          * drawer supports. */}
        <div className="dd-sec">
          <div className="dd-strip">
            <div className="dd-lbl">Work</div>
            <div className="c-branch">
              {branch && <span className="bn" title={branch}>⎇ {branch}</span>}
              <span className="elapsed">launched {timeAgo(r.run.createdAt)}</span>
            </div>
          </div>
          {ws && r.repos.length > 1
            ? <WorkspaceChip label={ws} repos={r.repos} filePath={r.run.workspaceFile ?? ws} />
            : r.repos.length > 0 && (
                <div className="c-repos">{r.repos.map((g) => <RepoChip key={g.name} g={g} />)}</div>
              )}
        </div>

        {(r.run.children?.length ?? 0) > 0 && (
          <div className="dd-sec">
            <div className="dd-lbl">Children</div>
            {/* No sessions of their own — the fan-out orchestrator's subagent per
             * leaf worktree never opens a Claude Code session, so these never earn
             * a card. This drawer is the only place they surface. Keyed by
             * key+repo, not key alone: the same ticket key can span two repos
             * (its own row per repo, per the fan-out shape) — and the repo has to
             * be in the accessible name too, or two rows for the same key read to
             * a screen reader as the exact same button twice, with only the
             * (non-audible) `title` telling them apart. */}
            {r.run.children!.map((c) => (
              <button
                type="button"
                className="dd-child"
                key={`${c.key}:${c.repo}`}
                aria-label={`Copy ${c.key} worktree path in ${c.repo}`}
                title={c.path}
                onClick={() => copy(c.path)}
              >
                <span className="k">{c.key}</span>
                <span className="t">{c.summary}</span>
                <span className="bn">⎇ {c.branch}</span>
              </button>
            ))}
          </div>
        )}

        <div className="dd-sec">
          <div className="dd-lbl">Pull requests</div>
          {withPr.length > 0
            ? withPr.map(([name, e]) => <PrBlock key={name} repo={name} f={e.facts} showRepo={withPr.length > 1} />)
            : <div className="dd-none">No pull request yet</div>}
        </div>

        <div className="dd-sec">
          <div className="dd-lbl">Sessions</div>
          {/* Already a single-line fact strip: collapsed, this is one row (a name
            * or a count) with the per-session detail a click away — the same
            * "compact by default, more on demand" shape `More` uses below.
            * Expanded by default here — there is room in the drawer, unlike the
            * card, where the fold existed because the card had none. */}
          {card.agents.length > 0
            ? <AgentsRow agents={card.agents} defaultOpen />
            : <div className="dd-none">No session open — git + {sourceLabel} only</div>}
        </div>

        {/* Everything else, one click away. `<details>` rather than a second bespoke
          * toggle: it is a real disclosure widget with its own keyboard and
          * accessibility behavior for free. The body renders only while open —
          * relying on the browser's native `details:not([open])` hiding would have
          * left the content in the accessibility tree (and reachable to
          * `getByText`) the instant it exists, open or not.
          *
          * `role="button"` on the summary is there only because neither jsdom's
          * nor a real screen reader's role mapping treats a bare `<summary>` as
          * one — but overriding the role also throws away its native expanded/
          * collapsed state, so `aria-expanded` puts that back explicitly rather
          * than leaving every reader hearing "…button" whether this is open or
          * shut. */}
        <details className="dd-more" onToggle={(e) => setMoreOpen((e.currentTarget as HTMLDetailsElement).open)}>
          <summary role="button" aria-expanded={moreOpen}>More — copy, per-repo diffs, spend breakdown, forget</summary>
          {moreOpen && (
            <>
              {/* Spend lives only here, never on the card: the four classes are what make
                * the number honest, only the drawer has room for them, and a per-card figure
                * competed with the state line and the failure rows the reader can act on.
                * The eq total is
                * effort-weighted, so it is deliberately NOT the sum of the four rows above
                * it — cache reads dominate the raw count at a tenth the rate, and a raw sum
                * would rank tasks by conversation length rather than by cost. The rows are
                * raw token counts and say so; only the total carries the eq unit. */}
              <div className="dd-sec">
                <div className="dd-lbl">Spend</div>
                {usage === undefined
                  ? <div className="dd-none">Reading transcripts…</div>
                  : usage === null
                    ? <div className="dd-none">Couldn't read this task's transcripts</div>
                    : weightedEq(usage) === 0
                      ? <div className="dd-none">No recorded usage</div>
                      : (
                        <div className="dd-spend">
                          <div className="sp-row"><span className="sp-k">input</span><span className="sp-v">{usage.input.toLocaleString()}</span></div>
                          <div className="sp-row"><span className="sp-k">output</span><span className="sp-v">{usage.output.toLocaleString()}</span></div>
                          <div className="sp-row"><span className="sp-k">cache write</span><span className="sp-v">{usage.cacheWrite.toLocaleString()}</span></div>
                          <div className="sp-row"><span className="sp-k">cache read</span><span className="sp-v">{usage.cacheRead.toLocaleString()}</span></div>
                          <div className="sp-row sp-tot">
                            <span className="sp-k" title="Effort-weighted equivalent: input×1, cache-write×1.25, cache-read×0.1, output×5. Rate ratios, not prices — so it does not go stale and does not claim a dollar amount.">
                              weighted
                            </span>
                            <span className="sp-v">{formatEq(weightedEq(usage))}<span className="u">eq</span></span>
                          </div>
                        </div>
                      )}
              </div>

              {groups.map((g) => (
                <div className="dd-sec" key={g.group}>
                  <div className="dd-lbl">{g.group}</div>
                  {g.items.map((a) => (
                    // Explicit aria-label: without it, an accessible name is computed from
                    // the button's full text content, folding the hint into the name (e.g.
                    // "Forget" becomes "Forget the worktree is left untouched"). The hint
                    // itself stays in the DOM and reaches assistive tech exactly as the
                    // sighted rendering shows it — "give this place a ticket" tells a
                    // screen-reader user what Track it does, same as it tells a sighted
                    // one, which aria-hidden-ing the span would have thrown away.
                    <button type="button" className={`dd-act${a.danger ? " danger" : ""}`} key={a.label}
                      aria-label={a.label} onClick={a.run}>
                      <span className="t">{a.label}</span>
                      {a.hint && <span className={`h${a.id ? " id" : ""}`}>{a.hint}</span>}
                    </button>
                  ))}
                </div>
              ))}
            </>
          )}
        </details>
      </div>
    </Drawer>
  );
}
