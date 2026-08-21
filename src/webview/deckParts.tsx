import * as React from "react";
import { send } from "./vscodeApi";
import { AgentActivity, CardAgent, PrFacts, RepoGit, Run } from "../types";
import { timeAgo } from "./helpers";

export type Tone = "working" | "idle" | "attn" | "parked" | "merged";

const REVIEW_TEXT: Record<PrFacts["review"], string> = {
  approved: "approved",
  changes_requested: "changes",
  review_required: "required",
  none: "pending",
};

export function PrBlock({ repo, f, showRepo }: { repo: string; f: PrFacts; showRepo: boolean }): JSX.Element {
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
export function RepoChip({ g }: { g: RepoGit }): JSX.Element {
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

/** The repos of a multi-root run, under the workspace that holds them: the
 * workspace names the task, and every repo chip below it carries its own git
 * signal.
 *
 * Nothing folds. This renders in the drawer, the one surface with room to spare,
 * and a reader who opened the drawer to find out which repos a task spans should
 * not then have to hover or click for the answer. On the card, where there is no
 * room, the `N repos` signal bit carries the names in its tooltip instead. */
export function WorkspaceChip({ label, repos, filePath }: { label: string; repos: RepoGit[]; filePath: string }): JSX.Element {
  return (
    <div className="c-ws">
      {/* The workspace file's own path, not a generic sentence — it is the only
        * thing that tells apart two open .code-workspace files that happen to
        * share a label. */}
      <span className="ws" title={filePath}>
        <span className="n">{label}</span>
        <span className="ct">{repos.length} repos</span>
      </span>
      <div className="c-repos">
        {repos.map((g) => <RepoChip key={g.name} g={g} />)}
      </div>
    </div>
  );
}

const AGENT_STATE: Record<AgentActivity["state"], { text: string; tone: Tone }> = {
  working: { text: "working", tone: "working" },
  "needs-you": { text: "ended turn", tone: "attn" },
  stalled: { text: "stalled", tone: "attn" },
  exited: { text: "exited", tone: "attn" },
  idle: { text: "idle", tone: "idle" },
  unknown: { text: "open", tone: "parked" },
};

/** Every agent open in this card's directories. Collapsed it is one line — the
 * name when there is one agent, a count when there are more; expanded it is a
 * row each, because two sessions in one worktree are two different states and a
 * single aggregate dot cannot say both.
 *
 * `defaultOpen` defaults to false so nothing else that renders this changes —
 * the drawer is the one caller with room to spare, and passes it explicitly. */
export function AgentsRow({ agents, defaultOpen = false }: { agents: CardAgent[]; defaultOpen?: boolean }): JSX.Element | null {
  const [open, setOpen] = React.useState(defaultOpen);
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
export function workspaceLabel(run: Run): string | undefined {
  return run.workspaceFile?.split(/[\\/]/).pop()?.replace(/\.code-workspace$/, "");
}
