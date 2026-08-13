import * as React from "react";
import { timeAgo } from "./helpers";

/** One run that has left the board: no agent of its own, no PR, no active
 * ticket, nothing uncommitted. It retires on its own after
 * `agentFlow.retireClosedAfterHours`. */
export interface ClosedRow {
  key: string;
  title: string;
  /** What the card's key chip said — a ticket key, or "notepad" / "explore". */
  label: string;
  /** null on a record written before `closedAt` existed. */
  closedAt: number | null;
}

/**
 * Everything that left the board, on one line until you ask for more.
 *
 * Collapsed by default, and collapsed is the state that matters: the strip
 * exists so a closed run costs one line instead of a card. The parent owns the
 * collapse flag so it survives a `deck:runs` re-render.
 *
 * Row actions are hover-and-focus only, in CSS — a row is something to glance
 * past, not a control panel. They stay reachable by keyboard because `:focus`
 * reveals them too.
 */
export function ClosedStrip({ rows, collapsed, onCollapse, onReopen, onForget, onClearAll }: {
  rows: ClosedRow[];
  collapsed: boolean;
  onCollapse: (collapsed: boolean) => void;
  onReopen: (key: string) => void;
  onForget: (key: string) => void;
  onClearAll: () => void;
}): JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <div className="rc">
      <div className="rc-hd">
        <button type="button" className="rc-toggle" onClick={() => onCollapse(!collapsed)}
          title="Runs that left the board — no agent, no pull request, nothing uncommitted">
          <span className="rc-caret">{collapsed ? "▸" : "▾"}</span>
          <span className="rc-nm">Recently closed</span>
          <span className="rc-ct">{rows.length}</span>
        </button>
        <span className="rc-sp" />
        {!collapsed && (
          <button type="button" className="rc-clear" onClick={onClearAll}
            title="Retire every record listed here. Worktrees, branches and commits are left untouched.">
            Clear all
          </button>
        )}
      </div>
      {!collapsed && (
        <div className="rc-rows">
          {rows.map((r) => (
            <div className="rc-row" key={r.key}>
              <span className="sdot tone-parked" />
              <span className="rc-key" title={r.key}>{r.label}</span>
              <span className="rc-ttl" title={r.title}>{r.title}</span>
              {r.closedAt !== null && <span className="rc-when">closed {timeAgo(r.closedAt)}</span>}
              <button type="button" className="rc-act" onClick={() => onReopen(r.key)}
                title="Open this task's workspace again">Reopen</button>
              <button type="button" className="rc-act" onClick={() => onForget(r.key)}
                title="Delete the run record now. The worktree, branch and commits are left untouched.">Forget</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
