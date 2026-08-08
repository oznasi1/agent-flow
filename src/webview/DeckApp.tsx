import * as React from "react";
import { send } from "./vscodeApi";
import { AgentActivity, CardAgent, DeckColumn, OutboundMessage, PendingResume, PrEntryMap, PrFacts, RepoGit, ReviewDetail, ReviewRequest, ReviewSort, Run, RunStatus, isTicketRun, runKind } from "../types";
import type { Flow } from "../engine/orchestrator/model";
import { DeckCard, projectCards } from "./deckCards";
import { DRAG_SEP, OrchestratorDrawer } from "./OrchestratorDrawer";
import { ReviewStrip } from "./ReviewStrip";
import { isPrReviewStatus } from "./helpers";

let toastSeq = 0;

// Everything on, and the shipped Jira label — what a first paint renders before
// `deck:runs` arrives. `deck:runs` is asynchronous (a real round-trip through the
// extension host), so there is always a gap between mount and the first message;
// defaulting to "Jira" means that gap renders exactly today's UI rather than a
// flash of nameless copy ("parked · git + only") before the truth arrives a
// moment later. Same reasoning, same default, as App.tsx's DEFAULT_SOURCE_LABEL.
const DEFAULT_SOURCE_LABEL = "Jira";

// `needs` stays the column id — it is the engine's vocabulary (DeckColumn, deriveBucket)
// and never reaches a user. "Action required" is what the board says, in the summary
// tile, the column header and the legend alike: one name for one thing.
const COLUMNS: { id: DeckColumn; label: string; varName: string }[] = [
  { id: "progress", label: "In progress", varName: "--c-progress" },
  { id: "needs", label: "Action required", varName: "--c-attn" },
  { id: "review", label: "In review", varName: "--c-review" },
  { id: "done", label: "Done", varName: "--c-done" },
];

function timeAgo(ms: number | null): string {
  if (!ms) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** A copy of `r` with `key` removed. Used to clear a per-row flag or body
 * without leaving a stale `false`/`""` entry sitting in the map forever. */
function drop<T>(r: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _omitted, ...rest } = r;
  return rest;
}

type Tone = "working" | "idle" | "attn" | "parked" | "merged";

/** Did every PR this run has actually land? Mirrors prSignals' `merged` rule in
 * status.ts — a run whose backend merged and whose frontend has not is not merged. */
function allMerged(prs: PrEntryMap): boolean {
  const facts = Object.values(prs).map((e) => e.facts).filter((f): f is PrFacts => f !== null);
  return facts.length > 0 && facts.every((f) => f.state === "MERGED");
}

function stateView(r: RunStatus, live: boolean, sourceLabel: string): { text: string; tone: Tone } {
  if (r.column === "done") return { text: allMerged(r.prs) ? "merged" : "done", tone: "merged" };
  if (!live || r.agent.state === "unknown") return { text: `parked · git + ${sourceLabel} only`, tone: "parked" };
  switch (r.agent.state) {
    case "working": return { text: `working · ${timeAgo(r.agent.lastActivityMs)}`, tone: "working" };
    case "needs-you": return { text: `ended turn · ${timeAgo(r.agent.lastActivityMs)}`, tone: "attn" };
    case "idle": return { text: `idle · ${timeAgo(r.agent.lastActivityMs)}`, tone: "idle" };
    default: return { text: `parked · git + ${sourceLabel} only`, tone: "parked" };
  }
}

const REVIEW_TEXT: Record<PrFacts["review"], string> = {
  approved: "approved",
  changes_requested: "changes",
  review_required: "required",
  none: "pending",
};

function PrBlock({ repo, f, showRepo }: { repo: string; f: PrFacts; showRepo: boolean }): JSX.Element {
  const ci = f.ci.failing.length > 0
    ? <span className="pr-bad">
        ✗ {f.ci.failing.map((c, i) => (
          <React.Fragment key={c.name}>
            {i > 0 && ", "}
            {c.url
              ? <button className="pr-link" title={c.url} onClick={() => send({ type: "openExternal", url: c.url })}>{c.name}</button>
              : <span>{c.name}</span>}
          </React.Fragment>
        ))}
      </span>
    : f.ci.pending > 0
      ? <span className="pr-wait">· {f.ci.pending} running</span>
      : <span className="pr-ok">✓ {f.ci.passing} passing</span>;

  return (
    <div className="pr-block">
      {showRepo && <div className="pr-repo">{repo}</div>}
      <div className="pr-line">
        <span className="pr-lbl">pr</span>
        <button className="pr-link" title={f.title} onClick={() => send({ type: "openExternal", url: f.url })}>
          #{f.number}
        </button>
        {f.isDraft && <span className="pr-draft">draft</span>}
      </div>
      <div className="pr-line"><span className="pr-lbl">ci</span>{ci}</div>
      <div className="pr-line">
        <span className="pr-lbl">review</span>
        <span className={f.review === "changes_requested" ? "pr-warn" : f.review === "approved" ? "pr-ok" : ""}>
          {REVIEW_TEXT[f.review]}{f.unresolved !== null && f.unresolved > 0 ? ` · ${f.unresolved} open` : ""}
        </span>
      </div>
      {/* Only an open PR has mergeability: GitHub stops computing it once the PR
        * merges or closes, handing back UNKNOWN for both fields it derives from.
        * The row could then only read "unknown" — a stale question, not a fact,
        * on the very cards whose header already says "merged". `ci` and `review`
        * keep their meaning after the merge, so they stay. */}
      {f.state === "OPEN" && (
        <div className="pr-line">
          <span className="pr-lbl">merge</span>
          <span className={f.mergeable === "conflicting" ? "pr-warn" : f.mergeable === "clean" ? "pr-ok" : ""}>
            {f.mergeable === "conflicting" ? "conflicts" : f.mergeable}
          </span>
        </div>
      )}
    </div>
  );
}

// No ⎇ here: that glyph means "branch" on this card, and a repo chip is a repo.
// Every part is its own element so the chip's flex `gap` sets the spacing — literal
// spaces and "·" separators between them would each become an anonymous flex item
// and get gapped on both sides.
function RepoChip({ g }: { g: RepoGit }): JSX.Element {
  return (
    <span className="repo" title={g.path}>
      <span>{g.name}</span>
      {g.files > 0 && (
        <><span className="add">+{g.added}</span><span className="del">−{g.removed}</span></>
      )}
      {g.ahead > 0 && <span>↑{g.ahead}</span>}
      {g.dirty && <span className="dirty" title="uncommitted changes">●</span>}
    </span>
  );
}

const AGENT_STATE: Record<AgentActivity["state"], { text: string; tone: Tone }> = {
  working: { text: "working", tone: "working" },
  "needs-you": { text: "ended turn", tone: "attn" },
  idle: { text: "idle", tone: "idle" },
  unknown: { text: "open", tone: "parked" },
};

/** Every agent open in this card's directories. Collapsed it is one line — the
 * name when there is one agent, a count when there are more; expanded it is a
 * row each, because two sessions in one worktree are two different states and a
 * single aggregate dot cannot say both. */
function AgentsRow({ agents }: { agents: CardAgent[] }): JSX.Element | null {
  const [open, setOpen] = React.useState(false);
  if (agents.length === 0) return null;
  // A single agent's label IS its name — an identifier, so it earns the mono
  // treatment (.id). Falling back to "1 agent", or counting several ("N agents"),
  // is prose, not an identifier, and must not go mono.
  const soloName = agents.length === 1 ? agents[0].session.name : null;
  const label = soloName ?? (agents.length === 1 ? "1 agent" : `${agents.length} agents`);
  return (
    <div className="c-agents">
      <button type="button" className="ag-toggle" onClick={() => setOpen((o) => !o)}
        title="Claude Code sessions open in this directory">
        <span className="ag-caret">{open ? "▾" : "▸"}</span>
        <span className={`ag-label ${soloName ? "id" : ""}`}>{label}</span>
      </button>
      {open && agents.map((a) => {
        const st = AGENT_STATE[a.activity.state];
        return (
          <div className="ag-row" key={a.session.sessionId}>
            <span className={`sdot tone-${st.tone} ${st.tone === "working" ? "pulse" : ""}`} />
            <span className="ag-name" title={a.activity.slug ?? undefined}>{a.session.name ?? a.session.sessionId.slice(0, 8)}</span>
            <span className={`ag-state tone-${st.tone}`}>{st.text}</span>
            <span className="ag-age">{timeAgo(a.activity.lastActivityMs)}</span>
            {/* readOpenSessions defaults a missing startedAt to 0 — timeAgo(0) is ""
                (falsy ms short-circuits it), which would otherwise render a bare
                "open" with nothing after it. */}
            {a.session.startedAt > 0 && <span className="ag-open">open {timeAgo(a.session.startedAt)}</span>}
          </div>
        );
      })}
    </div>
  );
}

/** The run's `.code-workspace` file's name, extension stripped — e.g.
 * "ASM-1+2.code-workspace" → "ASM-1+2". `undefined` for a single-repo
 * (per-window) run, which has no workspace file at all. */
function workspaceLabel(run: Run): string | undefined {
  return run.workspaceFile?.split(/[\\/]/).pop()?.replace(/\.code-workspace$/, "");
}

function Card({ r, live, prReviewStatus, onForget, agent, column, sourceLabel }: {
  r: RunStatus; live: boolean; prReviewStatus: string; onForget: (key: string) => void;
  /** Non-null on the Agents board: this card is that one session, and its state
   * line, name and action target come from the agent rather than the run. */
  agent: CardAgent | null;
  column: DeckColumn;
  sourceLabel: string;
}): JSX.Element {
  const col = COLUMNS.find((c) => c.id === column)!;
  const accent = `var(${col.varName})`;
  // The agent's own activity when this card is an agent; the run's reduction
  // otherwise. `column` is threaded in rather than read off `r` for the same
  // reason: on the Agents board both are per-session.
  const sv = stateView({ ...r, agent: agent ? agent.activity : r.agent, column }, live, sourceLabel);
  // A ticketless run has no tracked issue behind it: the key is a local slug, and
  // openExternal("") is a button that does nothing.
  const tracked = isTicketRun(r.run);
  // The short label is only honest for a real Explore session. isTicketRun keys off
  // an empty url and never inspects the key, so anything else untracked keeps its
  // key on the chip rather than being relabelled as something it is not. A Track'd
  // ticketless place is the one exception with an "explore-"-less key: its record
  // is kind: "explore" but Track it never renames it off its local- place-hash, so
  // that prefix reads as "explore" here too — it is exactly what the record now is.
  const explore = r.run.key.startsWith("explore-") || r.run.key.startsWith("local-");
  // A place with an agent open in it that Agent Flow Deck never launched. It has no
  // record on disk, so there is nothing to Forget — closing its agents is what
  // removes it.
  const local = runKind(r.run) === "local";
  // Offer Address PR once the ticket reaches the configured PR-review status. Never on
  // a local card: its key is read off the branch name (see inferredKey just below), so
  // the status on it may belong to a ticket that is not ours — not something to seed an
  // agent against on one click. A run with no ticket status needs no separate guard;
  // isPrReviewStatus is false whenever either side is empty.
  const canAddressPr = !local && isPrReviewStatus(r.ticketStatus ?? "", prReviewStatus);
  // The key came from the branch, not from a launch. Say so: the branch could
  // name a ticket somebody else owns, and the ticket status on this card would
  // then be theirs. Computed host-side (the webview has no connector to parse
  // r.run.url with) and sent as `inferredTicketKey` — absent whenever the host
  // found no ticket in the url, which for a non-local run is always.
  const inferredKey = local ? (r.inferredTicketKey ?? "") : "";
  // Only a card that names one run and one repo can become a node: a place node
  // resolves to exactly one repo so no condition is ever ambiguous about which
  // repo's git or PR it means.
  const dragRepo = agent?.repo ?? (r.repos.length === 1 ? r.repos[0].name : undefined);
  const cardDragKey = dragRepo ? `${r.run.key}${DRAG_SEP}${dragRepo}` : null;
  const [menuOpen, setMenuOpen] = React.useState(false);
  React.useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("click", close); window.removeEventListener("keydown", onKey); };
  }, [menuOpen]);

  return (
    <div
      className={`card ${column === "needs" ? "attn" : ""}`}
      style={{ ["--accent" as any]: accent }}
      draggable={cardDragKey !== null}
      onDragStart={(e) => {
        if (cardDragKey) e.dataTransfer.setData("text/plain", cardDragKey);
      }}
    >
      {/* State leads, identity trails: the dot sits at the same x on every card, so a column
          scans top-to-bottom as one strip of "who needs me". */}
      <div className="c-top">
        <span className={`status tone-${sv.tone}`}>
          <span className={`sdot tone-${sv.tone} ${sv.tone === "working" ? "pulse" : ""}`} />
          {sv.text}
        </span>
        {agent && (
          <span className="c-agent" title={`${agent.activity.slug ? `${agent.activity.slug} — ` : ""}Claude Code session in ${agent.repo ?? workspaceLabel(r.run) ?? r.run.repos[0]?.name ?? "this run"}`}>
            {agent.session.name ?? agent.session.sessionId.slice(0, 8)}
          </span>
        )}
        {inferredKey ? (
          <span className="key-wrap">
            <span className="chip" title="Read from the branch name — Agent Flow Deck did not launch this">~inferred</span>
            <button
              className="key"
              title={`Open ${inferredKey} in ${sourceLabel}`}
              onClick={() => send({ type: "openExternal", url: r.run.url })}
            >
              {inferredKey}
            </button>
          </span>
        ) : tracked ? (
          <button className="key" title={`Open ${r.run.key} in ${sourceLabel}`} onClick={() => send({ type: "openExternal", url: r.run.url })}>
            {r.run.key}
          </button>
        ) : (
          <span className="key untracked" title={r.run.key}>{local ? "local" : explore ? "explore" : r.run.key}</span>
        )}
      </div>
      <div className="c-title" title={r.run.summary}>
        {local && inferredKey && <span className="chip">local</span>}
        {r.run.summary}
      </div>

      {/* Where the work lives and when it started, on one line: this used to be a
          half-empty branch row followed by "launched …" trailing the repo chips, where
          it read as one more chip that had lost its border. */}
      <div className="c-branch">
        {r.run.repos[0]?.branch && (
          <span className="bn" title={r.run.repos[0].branch}>⎇ {r.run.repos[0].branch}</span>
        )}
        <span className="elapsed">launched {timeAgo(r.run.createdAt)}</span>
      </div>

      {r.repos.length > 0 && (
        <div className="c-repos">
          {r.repos.map((g) => <RepoChip key={g.name} g={g} />)}
        </div>
      )}

      {(() => {
        const withPr = Object.entries(r.prs).filter(([, e]) => e.facts !== null) as [string, { facts: PrFacts }][];
        return withPr.map(([name, e]) => (
          <PrBlock key={name} repo={name} f={e.facts} showRepo={withPr.length > 1} />
        ));
      })()}

      {/* An agent card IS one of those rows — nesting the whole list inside every
          sibling card would say the same thing four times. */}
      {agent === null && <AgentsRow agents={r.agents} />}

      <div className="c-foot">
        {r.ticketStatus && <span className="pill" title={`${sourceLabel} status: ${r.ticketStatus}`}>{r.ticketStatus}</span>}
        <div className="actions">
          {canAddressPr && (
            <button
              className="act"
              title={`Address the PR for ${r.run.key} — open its workspace and work through the review feedback`}
              onClick={() => send({ type: "deck:addressPr", key: r.run.key })}
            >
              Address PR
            </button>
          )}
          {/* An already-open window used to say so in a line of its own on every such
              card. The button that behaves differently is the right place to explain
              it: a 5px marker carries "there is something to focus", the tooltip
              carries what Open will actually do. */}
          <button
            className={`act primary ${r.windowOpen ? "live" : ""}`}
            title={r.windowOpen ? "Open now — Open focuses the window already running this task" : "Open this task's workspace"}
            onClick={() => send({ type: "deck:inspect", key: r.run.key, action: "open", ...(agent?.repo ? { repo: agent.repo } : {}) })}
          >
            Open
          </button>
          {/* main's multi-file diff editor, still scoped to this agent's own repo:
              dropping the spread would silently send an agent card's Diff to the
              run's first repo. */}
          <button className="act" title="Show everything this task changed, file by file" onClick={() => send({ type: "deck:inspect", key: r.run.key, action: "diff", ...(agent?.repo ? { repo: agent.repo } : {}) })}>Diff</button>
          <span className="more-wrap">
            <button className="more" title="More actions" onClick={(e) => { e.stopPropagation(); setMenuOpen((o) => !o); }}>⋯</button>
            {menuOpen && (
              <div className="menu" onClick={(e) => e.stopPropagation()}>
                {tracked && (
                  <button className="mi" onClick={() => { setMenuOpen(false); send({ type: "openExternal", url: r.run.url }); }}>{`Open in ${sourceLabel}`}</button>
                )}
                {local ? (
                  <button className="mi" onClick={() => { setMenuOpen(false); send({ type: "deck:track", key: r.run.key }); }}>Track it</button>
                ) : (
                  <button className="mi danger" onClick={() => { setMenuOpen(false); onForget(r.run.key); }}>Forget</button>
                )}
              </div>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

export function DeckApp(): JSX.Element {
  const [runs, setRuns] = React.useState<RunStatus[]>([]);
  const [live, setLive] = React.useState(true);
  const [prFacts, setPrFacts] = React.useState(true);
  const [openAgents, setOpenAgents] = React.useState(true);
  const [ghNote, setGhNote] = React.useState<string | null>(null);
  const [prReviewStatus, setPrReviewStatus] = React.useState("");
  const [syncedAt, setSyncedAt] = React.useState<number | null>(null);
  const [, forceTick] = React.useState(0);
  const [toasts, setToasts] = React.useState<{ id: number; level: string; message: string; action?: { label: string; url: string } }[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [reviewQueue, setReviewQueue] = React.useState(true);
  const [grouping, setGrouping] = React.useState<"agents" | "workspaces">("agents");
  const [staleCount, setStaleCount] = React.useState(0);
  // See DEFAULT_SOURCE_LABEL's own comment for why "Jira" rather than "".
  const [sourceLabel, setSourceLabel] = React.useState(DEFAULT_SOURCE_LABEL);
  const [reviews, setReviews] = React.useState<{ requests: ReviewRequest[]; issueCount: number; sort: ReviewSort; stale: boolean; reviewWrites: boolean; loading: boolean }>(
    { requests: [], issueCount: 0, sort: "oldest", stale: false, reviewWrites: false, loading: false },
  );
  const [reviewsCollapsed, setReviewsCollapsed] = React.useState(false);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  // `null` means the host tried this id's per-PR detail call and it failed —
  // distinct from absent (never asked yet), which is what lets the row show
  // "couldn't load checks" instead of "loading…" forever.
  const [details, setDetails] = React.useState<Record<string, ReviewDetail | null>>({});
  const [bodies, setBodies] = React.useState<Record<string, string>>({});
  /** Set when a row's box is filled by "Load agent's review" and stays set
   * through any amount of editing — the disclosure it drives ("an agent read
   * a teammate's code") stays true however much the wording changes. It clears
   * only when the box goes back to empty, since at that point nothing of the
   * agent's text is left to disclose. */
  const [fromDraft, setFromDraft] = React.useState<Record<string, boolean>>({});
  /** Mid-flight for this id: a submit has been posted and no
   * `deck:reviewSubmitDone` has come back for it yet. Cleared only by that
   * explicit, id-carrying message — never by a `toast` or a `deck:reviews`
   * post, both of which arrive constantly for reasons unrelated to any one
   * row's submit and carry no id to match against. */
  const [submitting, setSubmitting] = React.useState<Record<string, boolean>>({});
  /** The last submit for this id came back `"failed"`. Drives the strip's
   * inline "check the PR before trying again" line; cleared on `"ok"`, left
   * alone on `"cancelled"` (nothing was attempted, so nothing to warn about). */
  const [submitFailed, setSubmitFailed] = React.useState<Record<string, boolean>>({});
  /** Mirrors the host's own `enabled` flag on `deck:reviews`: true once a post
   * with the feature on has landed, false again the moment it posts `enabled:
   * false` (the setting turned off, PR facts turned off, or gh going unusable).
   * The stat tile needs this, not just `issueCount === 0` — "0 To review" is
   * information about an enabled, empty queue; a switched-off strip should show
   * no tile at all, the same way the strip itself renders nothing below. */
  const [reviewsSeen, setReviewsSeen] = React.useState(false);
  const [flows, setFlows] = React.useState<Flow[]>([]);
  const [pendingResume, setPendingResume] = React.useState<PendingResume[]>([]);
  const [orchEnabled, setOrchEnabled] = React.useState(false);
  const [openFlowId, setOpenFlowId] = React.useState<string | null>(null);
  /** The flow list the last `deck:flows` post carried. The message handler below is
   * registered once (`[]` deps, because re-running it would re-post `deck:ready`), so
   * the `flows` state variable it closes over never advances past `[]` — and telling
   * a newly created flow from one we already had needs the previous list. Mirrors
   * `flows` exactly; it is never a second source of truth for rendering. */
  const flowsRef = React.useRef<Flow[]>([]);

  React.useEffect(() => {
    const handler = (ev: MessageEvent<OutboundMessage>) => {
      const m = ev.data;
      if (m.type === "deck:runs") {
        setRuns(m.runs);
        setLive(m.liveSignal);
        setPrFacts(m.prFacts);
        setOpenAgents(m.openAgents);
        setReviewQueue(m.reviewQueue);
        setGrouping(m.grouping);
        setStaleCount(m.staleCount);
        setGhNote(m.ghNote);
        setPrReviewStatus(m.prReviewStatus);
        setSourceLabel(m.sourceLabel);
        setSyncedAt(Date.now());
      } else if (m.type === "toast") {
        const id = ++toastSeq;
        setToasts((t) => [...t.slice(-2), { id, level: m.level, message: m.message, action: m.action }]);
        setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600);
      } else if (m.type === "deck:loading") {
        setBusy(m.loading);
      } else if (m.type === "deck:reviews") {
        // No auto-collapse. A long queue is bounded by .rv-rows' capped height and its
        // own scroller, so the board keeps its share of the window without the queue
        // ever being hidden — which also means the collapse state is purely the user's,
        // with no seeded-once ref and no setState nested inside another's updater.
        setReviewsSeen(m.enabled);
        setReviews({ requests: m.requests, issueCount: m.issueCount, sort: m.sort, stale: m.stale, reviewWrites: m.reviewWrites, loading: m.loading });
      } else if (m.type === "deck:reviewDetail") {
        setDetails((d) => ({ ...d, [m.id]: m.detail }));
      } else if (m.type === "deck:reviewDraft") {
        setBodies((b) => ({ ...b, [m.id]: m.body }));
        setFromDraft((f) => ({ ...f, [m.id]: true }));
      } else if (m.type === "deck:reviewSubmitDone") {
        // The one signal that releases a row's disable — see `submitting`'s own doc
        // comment for why a toast or a routine deck:reviews poll (both far more
        // frequent, and idless) must not be trusted to mean the same thing.
        setSubmitting((s) => (m.id in s ? drop(s, m.id) : s));
        if (m.outcome === "failed") {
          setSubmitFailed((f) => ({ ...f, [m.id]: true }));
        } else if (m.outcome === "ok") {
          setSubmitFailed((f) => (m.id in f ? drop(f, m.id) : f));
          // Nothing of this row's box survives a successful write: a comment does
          // not evict the row, so a stale, re-enabled "lgtm" sitting in the
          // textarea would make the next click a real second review, with only the
          // confirmation modal in the way.
          setBodies((b) => (m.id in b ? drop(b, m.id) : b));
          setFromDraft((f) => (m.id in f ? drop(f, m.id) : f));
        }
        // "cancelled": nothing was attempted — only the disable above lifts. The
        // body, any draft flag, and any earlier failure warning are left exactly
        // as the user last saw them.
      } else if (m.type === "deck:flows") {
        // A create posts a flow we did not have — open it, since pressing the chip
        // with none is a request for exactly that. A flow deleted elsewhere must not
        // leave the drawer open on nothing.
        //
        // The comparison needs the previous list, and this listener is registered
        // once with `[]` deps so the `flows` state variable in scope is permanently
        // the initial `[]`. Hence the ref. What it must NOT be is `setOpenFlowId`
        // nested inside `setFlows`'s updater, which is what shipped: React's contract
        // is that an updater is pure, because React reserves the right to replay one.
        // (Measured, for the record: React 18.3.1's eager-state path happens to run
        // that updater exactly once per post, so the nested version was not producing
        // a wrong open flow today — this is closing the hole, not fixing a live
        // symptom. The same shape in the drawer's drag handler DID double-write.)
        // Reading the ref once, before overwriting it, keeps this block idempotent no
        // matter how many times React runs the updater below.
        const old = flowsRef.current;
        flowsRef.current = m.flows;
        setFlows(m.flows);
        setOpenFlowId((cur) => {
          if (cur && m.flows.some((f) => f.id === cur)) return cur;
          const fresh = m.flows.find((f) => !old.some((o) => o.id === f.id));
          return fresh ? fresh.id : null;
        });
        setOrchEnabled(m.enabled);
        setPendingResume(m.pendingResume);
      }
    };
    window.addEventListener("message", handler);
    send({ type: "deck:ready" });
    // keep "synced Ns ago" and relative times ticking
    const tick = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => {
      window.removeEventListener("message", handler);
      clearInterval(tick);
    };
  }, []);

  // One list either way, so the columns, counts, stat tiles and sort all read
  // from the same shape. Workspaces mode is today's board exactly: one card per
  // run, agent nested, bucketed by the run's own column.
  const cards: DeckCard[] = grouping === "agents"
    ? projectCards(runs)
    : runs.map((r) => ({ id: `w:${r.run.key}`, status: r, agent: null, column: r.column }));
  const needs = cards.filter((c) => c.column === "needs").length;
  const toggleLive = () => {
    const next = !live;
    setLive(next);
    send({ type: "deck:setLive", on: next });
  };

  const forget = React.useCallback((key: string) => {
    // Optimistic: the card leaves now rather than after a full refresh (a connector
    // round trip per run, plus git per repo). The next deck:runs post is
    // authoritative, so a delete that somehow failed brings the card straight back.
    setRuns((rs) => rs.filter((r) => r.run.key !== key));
    send({ type: "deck:forget", key });
  }, []);

  return (
    <>
      <div className="hd">
        <div className="title">In-flight<span className="sub">everything you've launched</span></div>
        <div className="stats">
          <div className="stat"><span className="n">{cards.filter((c) => c.column === "progress").length}</span><span className="l">In progress</span></div>
          <div className={`stat ${needs > 0 ? "attn" : ""}`}><span className="n">{needs}</span><span className="l">Action required</span></div>
          <div className="stat"><span className="n">{cards.filter((c) => c.column === "review").length}</span><span className="l">In review</span></div>
          {reviewsSeen && (
            // A spinning glyph where the number goes, not "0": on a cold start the
            // count is genuinely unknown for the few seconds the first `gh` search
            // takes, and "0 To review" is a claim we cannot back yet.
            <div className="stat">
              <span className="n">{reviews.loading ? <span className="spin on" aria-label="checking">⟳</span> : reviews.issueCount}</span>
              <span className="l">To review</span>
            </div>
          )}
          <div className="stat"><span className="n">{cards.length}</span><span className="l">Total</span></div>
        </div>
        <div className="sp" />
        {orchEnabled && (
          <button
            type="button"
            className="ctl orch-chip"
            onClick={() => {
              if (flows.length === 0) send({ type: "flow:create" });
              else setOpenFlowId((cur) => (cur ? null : flows[0].id));
            }}
          >
            <span className="ic">⚡</span>
            <span>Orchestrator</span>
            {flows.length > 0 && <span className="ct">{flows.length}</span>}
          </button>
        )}
        {/* Both toggles answer the same question — how much should the board trust? —
            so they read as one segmented control rather than two loose pills. Buttons,
            not divs: these are controls, and :focus-visible only reaches them here. */}
        <div className="ctls">
          <button type="button" className={`ctl ${live ? "on" : ""}`} onClick={toggleLive} title={`Best-effort live signal from Claude Code transcripts. Off → git + ${sourceLabel} only.`}>
            <span className="switch" />Live signal
          </button>
          <button type="button" className={`ctl ${prFacts ? "on" : ""}`} onClick={() => { const next = !prFacts; setPrFacts(next); send({ type: "deck:setPrFacts", on: next }); }} title={`Read each task's PR state from GitHub with the gh CLI. Off → git + ${sourceLabel} only.`}>
            <span className="switch" />PR facts
          </button>
          <button
            type="button"
            className={`ctl ${openAgents ? "on" : ""}`}
            onClick={() => { const next = !openAgents; setOpenAgents(next); send({ type: "deck:setOpenAgents", on: next }); }}
            title="Show every Claude Code session open on this machine, read from ~/.claude/sessions. Off → only what Agent Flow Deck launched."
          >
            <span className="switch" />Open agents
          </button>
          {/* Off stops the `gh` search outright — distinct from the strip's own
              collapse caret, which only folds rows already fetched. */}
          <button
            type="button"
            className={`ctl ${reviewQueue ? "on" : ""}`}
            onClick={() => { const next = !reviewQueue; setReviewQueue(next); send({ type: "deck:setReviewQueue", on: next }); }}
            title="Open PRs that ask for your review, read with the gh CLI. Off → no query, no queue."
          >
            <span className="switch" />Review queue
          </button>
        </div>
        {/* A lens, not a trust toggle: both sides show everything, one card per
            agent or one per launched task. Persisted, so it survives a reload. */}
        <div className="ctls seg">
          {(["agents", "workspaces"] as const).map((g) => (
            <button
              key={g}
              type="button"
              className={`ctl ${grouping === g ? "on" : ""}`}
              title={g === "agents"
                ? "One card per Claude Code agent, with the repo, ticket and PR it belongs to"
                : "One card per launched task, with its agents nested underneath"}
              onClick={() => { setGrouping(g); send({ type: "deck:setGrouping", grouping: g }); }}
            >
              {g === "agents" ? "Agents" : "Workspaces"}
            </button>
          ))}
        </div>
        {staleCount > 0 && (
          <button
            type="button"
            className="ctl"
            title="Retire run records that are only waiting out their window. Worktrees, branches and commits are left untouched."
            onClick={() => send({ type: "deck:clearStale" })}
          >
            Clear stale ({staleCount})
          </button>
        )}
        <button type="button" className="ctl" title={`Re-read git, ${sourceLabel} and PR state now`} onClick={() => send({ type: "deck:refresh" })}>
          <span className={`spin ${busy ? "on" : ""}`}>⟳</span>
          <span className="synced">{busy ? "syncing…" : syncedAt ? `synced ${timeAgo(syncedAt)}` : "refresh"}</span>
        </button>
      </div>

      <ReviewStrip
        requests={reviews.requests}
        issueCount={reviews.issueCount}
        sort={reviews.sort}
        stale={reviews.stale}
        loading={reviews.loading}
        collapsed={reviewsCollapsed}
        expanded={expanded}
        details={details}
        reviewWrites={reviews.reviewWrites}
        bodies={bodies}
        submitting={submitting}
        submitFailed={submitFailed}
        onCollapse={setReviewsCollapsed}
        onSort={(sort) => { setReviews((r) => ({ ...r, sort })); send({ type: "deck:setReviewSort", sort }); }}
        onExpand={(id) => {
          setExpanded((cur) => (cur === id ? null : id));
          // Once per session per row: the strip re-renders constantly (the 1s
          // clock tick), and a fetch on every render would spawn a gh call a second.
          if (!details[id]) send({ type: "deck:reviewExpand", id });
        }}
        onOpen={(url) => send({ type: "openExternal", url })}
        onLaunch={(id) => send({ type: "deck:reviewLaunch", id })}
        onLoadDraft={(id) => send({ type: "deck:reviewLoadDraft", id })}
        onBody={(id, body) => {
          setBodies((b) => ({ ...b, [id]: body }));
          // Editing a loaded draft does NOT clear the flag: the line tells a
          // teammate an agent read their code, which stays true however much you
          // reword it. Only emptying the box does — at that point nothing of the
          // agent's text is left to disclose.
          if (!body.trim()) setFromDraft((f) => (f[id] ? { ...f, [id]: false } : f));
        }}
        onSubmit={(id, verb) => {
          setSubmitting((s) => ({ ...s, [id]: true }));
          send({ type: "deck:reviewSubmit", id, verb, body: bodies[id] ?? "", fromDraft: !!fromDraft[id] });
        }}
      />

      {runs.length === 0 ? (
        <div className="empty">
          <div className="big">No tasks in flight</div>
          <div>Take a task from the Agent Flow Deck Tasks pool and it shows up here.</div>
        </div>
      ) : (
        <div className="board">
          {COLUMNS.map((col) => {
            // Sorting reads the agent's own activity on an agent card and the run's
            // reduction on a parked one, so a column still orders by "most
            // recently alive" whichever lens is up.
            const list = cards
              .filter((c) => c.column === col.id)
              .sort((a, b) =>
                ((b.agent?.activity ?? b.status.agent).lastActivityMs ?? 0) -
                ((a.agent?.activity ?? a.status.agent).lastActivityMs ?? 0) ||
                b.status.run.createdAt - a.status.run.createdAt);
            return (
              <section className="col" key={col.id}>
                <div className="col-hd">
                  <span className="dot" style={{ background: `var(${col.varName})` }} />
                  <span className="nm">{col.label}</span>
                  <span className="ct">{list.length}</span>
                  <span className="rule" />
                </div>
                <div className="col-body">
                  {list.map((c) => (
                    <Card key={c.id} r={c.status} live={live} prReviewStatus={prReviewStatus}
                      onForget={forget} agent={c.agent} column={c.column} sourceLabel={sourceLabel} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <div className="legend">
        {COLUMNS.map((c) => (
          <span className="lg" key={c.id}><span className="dot" style={{ background: `var(${c.varName})` }} />{c.label}</span>
        ))}
        {ghNote && <span className="note warn">{ghNote}</span>}
        <span className="note">{`git + ${sourceLabel} backbone · best-effort live from `}<span className="path">~/.claude/projects</span></span>
      </div>

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.level}`}>
            <span className="toast-msg">{t.message}</span>
            {t.action && (
              <button
                type="button"
                className="toast-action"
                onClick={() => send({ type: "openExternal", url: t.action!.url })}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>

      {orchEnabled && (
        <OrchestratorDrawer
          flows={flows}
          openId={openFlowId}
          runs={runs}
          pendingResume={pendingResume}
          onClose={() => setOpenFlowId(null)}
          onCreate={() => send({ type: "flow:create" })}
          onOpen={(id) => setOpenFlowId(id)}
          onRename={(id, name) => send({ type: "flow:rename", id, name })}
          onSave={(flow) => send({ type: "flow:save", flow })}
          onDelete={(id) => send({ type: "flow:delete", id })}
          onArm={(id, armed) => send({ type: "flow:arm", id, armed })}
          onResumeApprove={(id) => send({ type: "flow:resumeApprove", id })}
          onResumeDisarm={(id) => send({ type: "flow:resumeDisarm", id })}
          onResetEdge={(id, edgeId) => send({ type: "flow:resetEdge", id, edgeId })}
        />
      )}
    </>
  );
}
