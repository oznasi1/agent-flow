import * as React from "react";
import { send } from "./vscodeApi";
import { DeckColumn, OutboundMessage, PrEntryMap, PrFacts, RepoGit, RunStatus } from "../types";

let toastSeq = 0;

const COLUMNS: { id: DeckColumn; label: string; varName: string }[] = [
  { id: "progress", label: "In progress", varName: "--c-progress" },
  { id: "needs", label: "Needs you", varName: "--c-needs" },
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

type Tone = "working" | "idle" | "needs" | "parked" | "merged";

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
    case "needs-you": return { text: `ended turn · ${timeAgo(r.agent.lastActivityMs)}`, tone: "needs" };
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
function RepoChip({ g }: { g: RepoGit }): JSX.Element {
  return (
    <span className="repo" title={g.path}>
      {g.name}
      {g.files > 0 && (
        <> <span className="add">+{g.added}</span><span className="del">−{g.removed}</span></>
      )}
      {g.ahead > 0 && <> · ↑{g.ahead}</>}
      {g.dirty && <span className="dirty" title="uncommitted changes">●</span>}
    </span>
  );
}

function Card({ r, live }: { r: RunStatus; live: boolean }): JSX.Element {
  const col = COLUMNS.find((c) => c.id === r.column)!;
  const accent = `var(${col.varName})`;
  const sv = stateView(r, live);
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
    <div className={`card ${r.column === "needs" ? "needs" : ""}`} style={{ ["--accent" as any]: accent }}>
      {/* State leads, identity trails: the dot sits at the same x on every card, so a column
          scans top-to-bottom as one strip of "who needs me". */}
      <div className="c-top">
        <span className={`status tone-${sv.tone}`}>
          <span className={`sdot tone-${sv.tone} ${sv.tone === "working" ? "pulse" : ""}`} />
          {sv.text}
        </span>
        <button className="key" title={`Open ${r.run.key} in Jira`} onClick={() => send({ type: "openExternal", url: r.run.url })}>
          {r.run.key}
        </button>
      </div>
      <div className="c-title" title={r.run.summary}>{r.run.summary}</div>

      {r.run.repos[0]?.branch && (
        <div className="c-branch" title={r.run.repos[0].branch}>⎇ {r.run.repos[0].branch}</div>
      )}

      <div className="c-repos">
        {r.repos.map((g) => <RepoChip key={g.name} g={g} />)}
        <span className="elapsed">launched {timeAgo(r.run.createdAt)}</span>
      </div>

      {(() => {
        const withPr = Object.entries(r.prs).filter(([, e]) => e.facts !== null) as [string, { facts: PrFacts }][];
        return withPr.map(([name, e]) => (
          <PrBlock key={name} repo={name} f={e.facts} showRepo={withPr.length > 1} />
        ));
      })()}

      {r.windowOpen && <div className="c-openhint">open now — Open will focus this window</div>}

      <div className="c-foot">
        {r.jiraStatus && <span className="pill" title={`Jira status: ${r.jiraStatus}`}>{r.jiraStatus}</span>}
        <div className="actions">
          <button className="act primary" onClick={() => send({ type: "deck:inspect", key: r.run.key, action: "open" })}>Open</button>
          <button className="act" onClick={() => send({ type: "deck:inspect", key: r.run.key, action: "diff" })}>Diff</button>
          <span className="more-wrap">
            <button className="more" title="More actions" onClick={(e) => { e.stopPropagation(); setMenuOpen((o) => !o); }}>⋯</button>
            {menuOpen && (
              <div className="menu" onClick={(e) => e.stopPropagation()}>
                <button className="mi" onClick={() => { setMenuOpen(false); send({ type: "openExternal", url: r.run.url }); }}>Open in Jira</button>
                <button className="mi danger" onClick={() => { setMenuOpen(false); send({ type: "deck:forget", key: r.run.key }); }}>Forget</button>
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
  const [ghNote, setGhNote] = React.useState<string | null>(null);
  const [syncedAt, setSyncedAt] = React.useState<number | null>(null);
  const [, forceTick] = React.useState(0);
  const [toasts, setToasts] = React.useState<{ id: number; level: string; message: string }[]>([]);

  React.useEffect(() => {
    const handler = (ev: MessageEvent<OutboundMessage>) => {
      const m = ev.data;
      if (m.type === "deck:runs") {
        setRuns(m.runs);
        setLive(m.liveSignal);
        setPrFacts(m.prFacts);
        setGhNote(m.ghNote);
        setSyncedAt(Date.now());
      } else if (m.type === "toast") {
        const id = ++toastSeq;
        setToasts((t) => [...t.slice(-2), { id, level: m.level, message: m.message }]);
        setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600);
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

  return (
    <>
      <div className="hd">
        <div className="title">In-flight<span className="sub">everything you've launched</span></div>
        <div className="stats">
          <div className="stat"><span className="n">{runs.filter((r) => r.column === "progress").length}</span><span className="l">In progress</span></div>
          <div className={`stat ${needs > 0 ? "alert" : ""}`}><span className="n">{needs}</span><span className="l">Need you</span></div>
          <div className="stat"><span className="n">{runs.filter((r) => r.column === "review").length}</span><span className="l">In review</span></div>
          <div className="stat"><span className="n">{runs.length}</span><span className="l">Total</span></div>
        </div>
        <div className="sp" />
        <div className={`ctl ${live ? "on" : ""}`} onClick={toggleLive} title="Best-effort live signal from Claude Code transcripts. Off → git + Jira only.">
          <span className="switch" />Live signal
        </div>
        <div className={`ctl ${prFacts ? "on" : ""}`} onClick={() => { const next = !prFacts; setPrFacts(next); send({ type: "deck:setPrFacts", on: next }); }} title="Read each task's PR state from GitHub with the gh CLI. Off → git + Jira only.">
          <span className="switch" />PR facts
        </div>
        <div className="ctl" onClick={() => send({ type: "deck:refresh" })}>
          ⟳ <span className="synced">{syncedAt ? `synced ${timeAgo(syncedAt)}` : "refresh"}</span>
        </div>
      </div>

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
                  {list.map((r) => <Card key={r.run.key} r={r} live={live} />)}
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
        <span className="note">git + Jira backbone · best-effort live from ~/.claude/projects</span>
      </div>

      <div className="toasts">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.level}`}>{t.message}</div>)}
      </div>
    </>
  );
}
