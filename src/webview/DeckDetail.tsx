import * as React from "react";
import { send } from "./vscodeApi";
import { isTicketRun, runKind, type PrFacts } from "../types";
import type { DeckCard } from "./deckCards";
import { AgentsRow, PrBlock, RepoChip, WorkspaceChip, workspaceLabel } from "./deckParts";
import { timeAgo } from "./helpers";

export interface DeckDetailProps {
  card: DeckCard;
  sourceLabel: string;
  onClose: () => void;
  onForget: (key: string) => void;
}

/** One row in the action list. `run` does the work; the list itself is data so
 * the count the header prints can never drift from the rows rendered. */
interface Action {
  label: string;
  /** The identifier this action acts on — a branch, a key, a url. Set in mono
   * beside the label, and left out when the label already says everything. */
  hint?: string;
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

export function DeckDetail({ card, sourceLabel, onClose, onForget }: DeckDetailProps): JSX.Element {
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

  // Address PR rides the lane, not the ticket status. The `local` guard stays:
  // a local card's key is read off its branch, so its status may belong to a
  // ticket somebody else owns — not something to seed an agent against.
  const canAddressPr = !local && card.column === "review" && card.lane === "waiting";

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
        ? [{ label: "Address PR", hint: "seed an agent against the review",
            run: () => send({ type: "deck:addressPr", key }) }]
        : []),
      ...(tracked
        ? [{ label: `Open in ${sourceLabel}`, hint: key,
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
      ...(branch ? [{ label: "Copy branch name", hint: branch, run: () => copy(branch) }] : []),
      ...(tracked ? [{ label: "Copy ticket key", hint: key, run: () => copy(key) }] : []),
      ...(lead ? [{ label: "Copy PR url", hint: `#${lead.number}`, run: () => copy(lead.url) }] : []),
      ...((own ?? r.run.repos[0])
        ? [{ label: "Copy worktree path", hint: (own ?? r.run.repos[0]).path,
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
        <span className="k">{key}</span>
        <span className="t" title={r.run.summary}>{r.run.summary}</span>
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

      <div className="dd-sec">
        <div className="dd-lbl">Pull requests</div>
        {withPr.length > 0
          ? withPr.map(([name, e]) => <PrBlock key={name} repo={name} f={e.facts} showRepo={withPr.length > 1} />)
          : <div className="dd-none">No pull request yet</div>}
      </div>

      <div className="dd-sec">
        <div className="dd-lbl">Agents</div>
        {card.agents.length > 0
          ? <AgentsRow agents={card.agents} />
          : <div className="dd-none">No agent open — git + {sourceLabel} only</div>}
      </div>

      <div className="dd-lbl dd-count">{count} actions</div>
      {groups.map((g) => (
        <div className="dd-sec" key={g.group}>
          <div className="dd-lbl">{g.group}</div>
          {g.items.map((a) => (
            <button type="button" className={`dd-act${a.danger ? " danger" : ""}`} key={a.label} onClick={a.run}>
              <span className="t">{a.label}</span>
              {/* aria-hidden: the hint is a mono-set identifier riding beside the
                * label (a branch, a key, a url) — decoration, not part of the
                * action's name. Folding it into the accessible name would turn
                * "Forget" into "Forget the worktree is left untouched", which is
                * not what a screen reader user asked their button-name query for. */}
              {a.hint && <span className="h" aria-hidden="true">{a.hint}</span>}
            </button>
          ))}
        </div>
      ))}
    </aside>
  );
}
