import * as React from "react";
import { send } from "./vscodeApi";
import { isTicketRun, runKind, type PrFacts } from "../types";
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
  onClose: () => void;
  onForget: (key: string) => void;
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
   * number, a path) when `id` is set, prose ("already running", "start a
   * session against the review") otherwise. Only an identifier earns the mono
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

export function DeckDetail({ card, sourceLabel, usage, closing = false, onClose, onForget }: DeckDetailProps): JSX.Element {
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
  // `dd-acts` above the fold (Open workspace, Open PR, Diff — all repos under
  // its plain "Diff" label, and Address PR): those keep exactly the same
  // handlers, called from the promoted buttons instead, so nothing about what
  // a click actually does has changed, only where the button sits. Removing
  // them here rather than duplicating them is what keeps every action
  // reachable exactly once — a row surviving in both places would give a
  // screen reader (and `getByRole`) two buttons with the same accessible name.
  const actions: { group: string; items: Action[] }[] = [
    { group: "This task", items: [
      { label: "Diff — all repos", run: diffAll },
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

  return (
    <Drawer surface="dd" label={`Detail for ${key}`} closing={closing} style={{ ["--dd-w" as any]: `${width}px` }}>
      {/* Same ARIA shape as the Orchestrator drawer's own grip (role="separator"
          + aria-orientation, keyboard-resizable): one resize control, one
          contract, on both drawers this shell serves. */}
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
        * `getByText`) the instant it exists, open or not. */}
      <details className="dd-more" onToggle={(e) => setMoreOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary role="button">More — copy, per-repo diffs, spend breakdown, forget</summary>
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
                  // sighted rendering shows it — "already running" tells a screen-reader
                  // user the window is open, same as it tells a sighted one, which
                  // aria-hidden-ing the span would have thrown away.
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
    </Drawer>
  );
}
