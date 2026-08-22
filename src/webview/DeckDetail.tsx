import * as React from "react";
import { send } from "./vscodeApi";
import { isTicketRun, runKind, type PrFacts } from "../types";
import { formatEq, weightedEq, type UsageTotals } from "../engine/usage";
import type { DeckCard } from "./deckCards";
// Same import DeckApp.tsx's own Card makes, and safe for the same reason: bucket.ts
// is kept free of fs-touching imports, which bucket.test.ts enforces.
import { prSignals } from "../engine/bucket";
import { AgentsRow, PrBlock, RepoChip, WorkspaceChip, workspaceLabel } from "./deckParts";
import { CardKindIcon } from "./icons";
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
  onClose: () => void;
  onForget: (key: string) => void;
}

/** One row in the action list. `run` does the work; the list itself is data so
 * the count the header prints can never drift from the rows rendered. */
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

export function DeckDetail({ card, sourceLabel, usage, onClose, onForget }: DeckDetailProps): JSX.Element {
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

  const actions: { group: string; items: Action[] }[] = [
    { group: "This task", items: [
      { label: "Open workspace", hint: r.windowOpen ? "already running" : undefined,
        run: () => send({ type: "deck:inspect", key, action: "open", ...(repo ? { repo } : {}) }) },
      { label: "Diff — all repos",
        run: () => send({ type: "deck:inspect", key, action: "diff", ...(repo ? { repo } : {}) }) },
      ...(r.repos.length > 1
        ? r.repos.map((g) => ({ label: `Diff — ${g.name}`,
            run: () => send({ type: "deck:inspect", key, action: "diff", repo: g.name }) }))
        : []),
      ...(canAddressPr
        ? [{ label: "Address PR", hint: "start a session against the review",
            run: () => send({ type: "deck:addressPr", key }) }]
        : []),
      ...(tracked
        ? [{ label: `Open in ${sourceLabel}`, hint: key, id: true as const,
            run: () => send({ type: "openExternal", url: r.run.url }) }]
        : []),
    ] },
    { group: "Pull request", items: lead
      ? [
          { label: `Open PR #${lead.number}`, run: () => send({ type: "openExternal", url: lead.url }) },
          ...lead.ci.failing.filter((c) => c.url).map((c) => ({
            label: `Open failing check — ${c.name}`,
            run: () => send({ type: "openExternal", url: c.url }),
          })),
        ]
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
  const count = groups.reduce((n, g) => n + g.items.length, 0);
  const ws = workspaceLabel(r.run);

  return (
    <aside className="dd" aria-label={`Detail for ${key}`}>
      <div className="dd-hd">
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
        <span className="t" title={r.run.summary}>{r.run.summary}</span>
        {/* Moved verbatim off the card's old .c-foot — the design's own list of
         * what relocates here names "the status pill" alongside the branch row,
         * repo chips, PR blocks and agents fold. */}
        {r.ticketStatus && <span className="pill" title={`${sourceLabel} status: ${r.ticketStatus}`}>{r.ticketStatus}</span>}
        <button type="button" className="dd-x" aria-label="Close" onClick={onClose}>✕</button>
      </div>

      <div className="dd-sec">
        <div className="dd-lbl">Work</div>
        <div className="c-branch">
          {branch && <span className="bn" title={branch}>⎇ {branch}</span>}
          <span className="elapsed">launched {timeAgo(r.run.createdAt)}</span>
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
        {/* Expanded by default here — there is room in the drawer, unlike the
          * card, where the fold existed because the card had none. */}
        {card.agents.length > 0
          ? <AgentsRow agents={card.agents} defaultOpen />
          : <div className="dd-none">No session open — git + {sourceLabel} only</div>}
      </div>

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

      <div className="dd-lbl dd-count">{count} actions</div>
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
    </aside>
  );
}
