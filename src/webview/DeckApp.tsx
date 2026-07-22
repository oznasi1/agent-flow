import * as React from "react";
import { send } from "./vscodeApi";
import { DeckColumn, OutboundMessage, RepoGit, RunStatus } from "../types";

let toastSeq = 0;

const COLUMNS: { id: DeckColumn; label: string; varName: string }[] = [
  { id: "progress", label: "Working", varName: "--c-working" },
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

function stateView(r: RunStatus, live: boolean): { text: string; tone: Tone } {
  if (r.column === "done") return { text: "merged", tone: "merged" };
  if (!live || r.agent.state === "unknown") return { text: "parked · git + Jira only", tone: "parked" };
  switch (r.agent.state) {
    case "working": return { text: `working · ${timeAgo(r.agent.lastActivityMs)}`, tone: "working" };
    case "needs-you": return { text: `ended turn · ${timeAgo(r.agent.lastActivityMs)}`, tone: "needs" };
    case "idle": return { text: `idle · ${timeAgo(r.agent.lastActivityMs)}`, tone: "idle" };
    default: return { text: "parked · git + Jira only", tone: "parked" };
  }
}

function RepoChip({ g }: { g: RepoGit }): JSX.Element {
  return (
    <span className="repo">
      ⎇ {g.name}
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

  return (
    <div className={`card ${r.column === "needs" ? "needs" : ""}`} style={{ ["--accent" as any]: accent }}>
      <div className="c-top">
        <span className="key" title="Open the ticket" onClick={() => send({ type: "openExternal", url: r.run.url })}>
          {r.run.key}
        </span>
        <span className={`status tone-${sv.tone}`}>
          <span className={`sdot tone-${sv.tone} ${sv.tone === "working" ? "pulse" : ""}`} />
          {sv.text}
        </span>
      </div>
      <div className="c-title">{r.run.summary}</div>

      <div className="c-repos">{r.repos.map((g) => <RepoChip key={g.name} g={g} />)}</div>

      <div className="c-foot">
        <span className="pill">{r.jiraStatus ?? "—"}</span>
        <div className="actions">
          <span className="act primary" onClick={() => send({ type: "deck:inspect", key: r.run.key, action: "open" })}>Open</span>
          <span className="act" onClick={() => send({ type: "deck:inspect", key: r.run.key, action: "diff" })}>Diff</span>
        </div>
      </div>
    </div>
  );
}

export function DeckApp(): JSX.Element {
  const [runs, setRuns] = React.useState<RunStatus[]>([]);
  const [live, setLive] = React.useState(true);
  const [syncedAt, setSyncedAt] = React.useState<number | null>(null);
  const [, forceTick] = React.useState(0);
  const [toasts, setToasts] = React.useState<{ id: number; level: string; message: string }[]>([]);

  React.useEffect(() => {
    const handler = (ev: MessageEvent<OutboundMessage>) => {
      const m = ev.data;
      if (m.type === "deck:runs") {
        setRuns(m.runs);
        setLive(m.liveSignal);
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
        <div className="counts">
          <span><b>{runs.length}</b> in flight</span>
          {needs > 0 && <span className="alert"><b>{needs}</b> need you</span>}
        </div>
        <div className="sp" />
        <div className={`ctl ${live ? "on" : ""}`} onClick={toggleLive} title="Best-effort live signal from Claude Code transcripts. Off → git + Jira only.">
          <span className="switch" />Live signal
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
            const list = runs.filter((r) => r.column === c.id);
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
        <span className="note">git + Jira backbone · best-effort live from ~/.claude/projects</span>
      </div>

      <div className="toasts">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.level}`}>{t.message}</div>)}
      </div>
    </>
  );
}
