import * as React from "react";
import { send } from "./vscodeApi";
import { AgentActivity, CardAgent, DeckColumn, OutboundMessage, PrEntryMap, PrFacts, RepoGit, ReviewDetail, ReviewRequest, ReviewSort, RunStatus, isTicketRun } from "../types";
import { ReviewStrip } from "./ReviewStrip";

let toastSeq = 0;

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

function stateView(r: RunStatus, live: boolean): { text: string; tone: Tone } {
  if (r.column === "done") return { text: allMerged(r.prs) ? "merged" : "done", tone: "merged" };
  if (!live || r.agent.state === "unknown") return { text: "parked · git + Jira only", tone: "parked" };
  switch (r.agent.state) {
    case "working": return { text: `working · ${timeAgo(r.agent.lastActivityMs)}`, tone: "working" };
    case "needs-you": return { text: `ended turn · ${timeAgo(r.agent.lastActivityMs)}`, tone: "attn" };
    case "idle": return { text: `idle · ${timeAgo(r.agent.lastActivityMs)}`, tone: "idle" };
    default: return { text: "parked · git + Jira only", tone: "parked" };
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
      <div className="pr-line">
        <span className="pr-lbl">merge</span>
        <span className={f.mergeable === "conflicting" ? "pr-warn" : f.mergeable === "clean" ? "pr-ok" : ""}>
          {f.mergeable === "conflicting" ? "conflicts" : f.mergeable}
        </span>
      </div>
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
            <span className="ag-name">{a.session.name ?? a.session.sessionId.slice(0, 8)}</span>
            <span className={`ag-state tone-${st.tone}`}>{st.text}</span>
            <span className="ag-age">{timeAgo(a.activity.lastActivityMs)}</span>
            <span className="ag-open">open {timeAgo(a.session.startedAt)}</span>
          </div>
        );
      })}
    </div>
  );
}

function Card({ r, live, onForget }: { r: RunStatus; live: boolean; onForget: (key: string) => void }): JSX.Element {
  const col = COLUMNS.find((c) => c.id === r.column)!;
  const accent = `var(${col.varName})`;
  const sv = stateView(r, live);
  // A ticketless run has no Jira issue behind it: the key is a local slug, and
  // openExternal("") is a button that does nothing.
  const tracked = isTicketRun(r.run);
  // The short label is only honest for a real Explore session. isTicketRun keys off
  // an empty url and never inspects the key, so anything else untracked keeps its
  // key on the chip rather than being relabelled as something it is not.
  const explore = r.run.key.startsWith("explore-");
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
    <div className={`card ${r.column === "needs" ? "attn" : ""}`} style={{ ["--accent" as any]: accent }}>
      {/* State leads, identity trails: the dot sits at the same x on every card, so a column
          scans top-to-bottom as one strip of "who needs me". */}
      <div className="c-top">
        <span className={`status tone-${sv.tone}`}>
          <span className={`sdot tone-${sv.tone} ${sv.tone === "working" ? "pulse" : ""}`} />
          {sv.text}
        </span>
        {tracked ? (
          <button className="key" title={`Open ${r.run.key} in Jira`} onClick={() => send({ type: "openExternal", url: r.run.url })}>
            {r.run.key}
          </button>
        ) : (
          <span className="key untracked" title={r.run.key}>{explore ? "explore" : r.run.key}</span>
        )}
      </div>
      <div className="c-title" title={r.run.summary}>{r.run.summary}</div>

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

      <AgentsRow agents={r.agents} />

      <div className="c-foot">
        {r.jiraStatus && <span className="pill" title={`Jira status: ${r.jiraStatus}`}>{r.jiraStatus}</span>}
        <div className="actions">
          {/* An already-open window used to say so in a line of its own on every such
              card. The button that behaves differently is the right place to explain
              it: a 5px marker carries "there is something to focus", the tooltip
              carries what Open will actually do. */}
          <button
            className={`act primary ${r.windowOpen ? "live" : ""}`}
            title={r.windowOpen ? "Open now — Open focuses the window already running this task" : "Open this task's workspace"}
            onClick={() => send({ type: "deck:inspect", key: r.run.key, action: "open" })}
          >
            Open
          </button>
          <button className="act" title="Show everything this task changed, as a diff" onClick={() => send({ type: "deck:inspect", key: r.run.key, action: "diff" })}>Diff</button>
          <span className="more-wrap">
            <button className="more" title="More actions" onClick={(e) => { e.stopPropagation(); setMenuOpen((o) => !o); }}>⋯</button>
            {menuOpen && (
              <div className="menu" onClick={(e) => e.stopPropagation()}>
                {tracked && (
                  <button className="mi" onClick={() => { setMenuOpen(false); send({ type: "openExternal", url: r.run.url }); }}>Open in Jira</button>
                )}
                <button className="mi danger" onClick={() => { setMenuOpen(false); onForget(r.run.key); }}>Forget</button>
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
  const [syncedAt, setSyncedAt] = React.useState<number | null>(null);
  const [, forceTick] = React.useState(0);
  const [toasts, setToasts] = React.useState<{ id: number; level: string; message: string; action?: { label: string; url: string } }[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [reviews, setReviews] = React.useState<{ requests: ReviewRequest[]; issueCount: number; sort: ReviewSort; stale: boolean; reviewWrites: boolean }>(
    { requests: [], issueCount: 0, sort: "oldest", stale: false, reviewWrites: false },
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

  React.useEffect(() => {
    const handler = (ev: MessageEvent<OutboundMessage>) => {
      const m = ev.data;
      if (m.type === "deck:runs") {
        setRuns(m.runs);
        setLive(m.liveSignal);
        setPrFacts(m.prFacts);
        setOpenAgents(m.openAgents);
        setGhNote(m.ghNote);
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
        setReviews({ requests: m.requests, issueCount: m.issueCount, sort: m.sort, stale: m.stale, reviewWrites: m.reviewWrites });
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

  const needs = runs.filter((r) => r.column === "needs").length;
  const toggleLive = () => {
    const next = !live;
    setLive(next);
    send({ type: "deck:setLive", on: next });
  };

  const forget = React.useCallback((key: string) => {
    // Optimistic: the card leaves now rather than after a full refresh (a Jira
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
          <div className="stat"><span className="n">{runs.filter((r) => r.column === "progress").length}</span><span className="l">In progress</span></div>
          <div className={`stat ${needs > 0 ? "attn" : ""}`}><span className="n">{needs}</span><span className="l">Action required</span></div>
          <div className="stat"><span className="n">{runs.filter((r) => r.column === "review").length}</span><span className="l">In review</span></div>
          {reviewsSeen && (
            <div className="stat"><span className="n">{reviews.issueCount}</span><span className="l">To review</span></div>
          )}
          <div className="stat"><span className="n">{runs.length}</span><span className="l">Total</span></div>
        </div>
        <div className="sp" />
        {/* Both toggles answer the same question — how much should the board trust? —
            so they read as one segmented control rather than two loose pills. Buttons,
            not divs: these are controls, and :focus-visible only reaches them here. */}
        <div className="ctls">
          <button type="button" className={`ctl ${live ? "on" : ""}`} onClick={toggleLive} title="Best-effort live signal from Claude Code transcripts. Off → git + Jira only.">
            <span className="switch" />Live signal
          </button>
          <button type="button" className={`ctl ${prFacts ? "on" : ""}`} onClick={() => { const next = !prFacts; setPrFacts(next); send({ type: "deck:setPrFacts", on: next }); }} title="Read each task's PR state from GitHub with the gh CLI. Off → git + Jira only.">
            <span className="switch" />PR facts
          </button>
          <button
            type="button"
            className={`ctl ${openAgents ? "on" : ""}`}
            onClick={() => { const next = !openAgents; setOpenAgents(next); send({ type: "deck:setOpenAgents", on: next }); }}
            title="Show every Claude Code session open on this machine, read from ~/.claude/sessions. Off → only what Agent Flow launched."
          >
            <span className="switch" />Open agents
          </button>
        </div>
        <button type="button" className="ctl" title="Re-read git, Jira and PR state now" onClick={() => send({ type: "deck:refresh" })}>
          <span className={`spin ${busy ? "on" : ""}`}>⟳</span>
          <span className="synced">{busy ? "syncing…" : syncedAt ? `synced ${timeAgo(syncedAt)}` : "refresh"}</span>
        </button>
      </div>

      <ReviewStrip
        requests={reviews.requests}
        issueCount={reviews.issueCount}
        sort={reviews.sort}
        stale={reviews.stale}
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
          <div>Take a task from the Agent Flow Tasks pool and it shows up here.</div>
        </div>
      ) : (
        <div className="board">
          {COLUMNS.map((c) => {
            const list = runs
              .filter((r) => r.column === c.id)
              .sort((a, b) => (b.agent.lastActivityMs ?? 0) - (a.agent.lastActivityMs ?? 0) || b.run.createdAt - a.run.createdAt);
            return (
              <section className="col" key={c.id}>
                <div className="col-hd">
                  <span className="dot" style={{ background: `var(${c.varName})` }} />
                  <span className="nm">{c.label}</span>
                  <span className="ct">{list.length}</span>
                  <span className="rule" />
                </div>
                <div className="col-body">
                  {list.map((r) => <Card key={r.run.key} r={r} live={live} onForget={forget} />)}
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
        <span className="note">git + Jira backbone · best-effort live from <span className="path">~/.claude/projects</span></span>
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
    </>
  );
}
