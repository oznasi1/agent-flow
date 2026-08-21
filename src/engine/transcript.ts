import * as fs from "fs";
import * as path from "path";
import { AgentActivity } from "../types";
import { UNKNOWN_ACTIVITY } from "./activity";

// A working agent's transcript is written to within this window; older → not
// "working" (and, with a tool still outstanding, "stalled").
const WORKING_WINDOW_MS = 45_000;

/** The subset of a Claude Code transcript line we read. */
export interface TranscriptLine {
  type?: string; // "user" | "assistant" | "attachment" | "file-history-snapshot" | …
  timestamp?: string; // ISO
  gitBranch?: string;
  cwd?: string;
  slug?: string;
  /** True on a subagent's turn. Its `message.model` is the subagent's, not this
   * session's, so the model read skips these. */
  isSidechain?: boolean;
  message?: { role?: string; stop_reason?: string | null; model?: string };
}

/**
 * Encode an absolute cwd into its Claude Code project-dir name under
 * ~/.claude/projects — every "/" and "." becomes "-".
 * e.g. /Users/me/proj/.worktrees/x → -Users-me-proj--worktrees-x
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/** The model this session is answering with, and how many it has used, from the tail.
 * Main chain only: a sidechain line is a subagent's turn and carries the subagent's
 * model, which is not this session's answer. One session legitimately holds several —
 * fast mode switches models mid-run — so the count travels with the current one. */
function modelOf(lines: TranscriptLine[]): { model: string | null; modelCount: number } {
  const models = lines
    .filter((l) => l.type === "assistant" && !l.isSidechain && l.message?.model)
    .map((l) => l.message!.model!);
  return { model: models.length > 0 ? models[models.length - 1] : null, modelCount: new Set(models).size };
}

/**
 * Derive live agent activity from the tail of a transcript plus the file's mtime.
 * Pure — `nowMs` is injected so callers control the clock. When no meaningful
 * lines exist the state is "unknown"; the caller uses "unknown" too when no
 * transcript file is found (graceful degradation to the git/Jira backbone).
 */
export function deriveActivity(lines: TranscriptLine[], mtimeMs: number, nowMs: number): AgentActivity {
  const slug = [...lines].reverse().find((l) => l.slug)?.slug ?? null;
  const model = modelOf(lines);
  const meaningful = lines.filter((l) => l.type === "user" || l.type === "assistant");
  if (meaningful.length === 0) return { state: "unknown", lastActivityMs: mtimeMs ?? null, slug, midWork: false, ...model };

  const last = meaningful[meaningful.length - 1];
  // Turn ended and control is back with the human — actionable regardless of how
  // long ago it happened.
  if (last.type === "assistant" && last.message?.stop_reason === "end_turn") {
    return { state: "needs-you", lastActivityMs: mtimeMs, slug, midWork: false, ...model };
  }
  // A tool call that never returned. Nothing follows the last meaningful line by
  // definition, so "no tool_result after it" needs no separate check.
  const pendingTool = last.type === "assistant" && last.message?.stop_reason === "tool_use";
  // Work is owed either way: a tool that has not returned, or a user line — a
  // real prompt, or a tool_result — the agent has not answered. Note that Claude
  // Code writes tool results as type "user".
  const midWork = pendingTool || last.type === "user";
  const age = nowMs - mtimeMs;
  if (age <= WORKING_WINDOW_MS) return { state: "working", lastActivityMs: mtimeMs, slug, midWork, ...model };
  // Stale with a tool still outstanding: the agent is at a permission prompt, or
  // a long command is running. The transcript cannot separate the two, so the
  // label is chosen to be true under either.
  if (pendingTool) return { state: "stalled", lastActivityMs: mtimeMs, slug, midWork, ...model };
  return { state: "idle", lastActivityMs: mtimeMs, slug, midWork, ...model };
}

// Defined in ./activity now, so a browser bundle can reach the constant without
// reaching this module's `fs`. Re-exported because deckView.ts and
// test/unit/engine/transcript.test.ts both address it here.
export { UNKNOWN_ACTIVITY };

function parseLines(file: string, tail = 200): TranscriptLine[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rows = raw.split("\n").filter(Boolean);
  const out: TranscriptLine[] = [];
  for (const r of rows.slice(-tail)) {
    try {
      out.push(JSON.parse(r));
    } catch {
      /* tolerate a partially-written trailing line */
    }
  }
  return out;
}

function lastBranch(lines: TranscriptLine[]): string | null {
  return [...lines].reverse().find((l) => l.gitBranch)?.gitBranch ?? null;
}

/**
 * Best-effort live agent activity for a run's repo. Locates the Claude Code
 * transcript dir for `cwd`, picks the transcript for `branch` (or the newest one
 * when a repo hosts sessions for several branches), and derives its state.
 * Returns "unknown" when nothing is found — the caller falls back to git + Jira.
 */
export function readAgentActivity(
  projectsRoot: string,
  cwd: string,
  branch: string | null,
  nowMs: number,
): AgentActivity {
  const dir = path.join(projectsRoot, encodeProjectDir(cwd));
  let files: { path: string; mtimeMs: number }[];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const p = path.join(dir, f);
        return { path: p, mtimeMs: fs.statSync(p).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return UNKNOWN_ACTIVITY; // no project dir / unreadable → graceful degradation
  }
  if (files.length === 0) return UNKNOWN_ACTIVITY;

  // Prefer the newest transcript whose branch matches this run; otherwise the
  // newest overall. (A worktree cwd already isolates one branch; a repo checked
  // out directly can hold sessions for several, so the branch join matters there.)
  const parsed = files.map((f) => ({ ...f, lines: parseLines(f.path) }));
  const match = branch ? parsed.find((f) => lastBranch(f.lines) === branch) : undefined;
  const chosen = match ?? parsed[0];
  return deriveActivity(chosen.lines, chosen.mtimeMs, nowMs);
}

/**
 * Live state of one named session. Its transcript is `<sessionId>.jsonl` in the
 * project dir encoding its cwd — an exact address, unlike readAgentActivity's
 * "newest transcript for this branch", which is the best a run record can do.
 * "unknown" when the file is absent or unreadable.
 */
export function readSessionActivity(
  projectsRoot: string,
  cwd: string,
  sessionId: string,
  nowMs: number,
): AgentActivity {
  const file = path.join(projectsRoot, encodeProjectDir(cwd), `${sessionId}.jsonl`);
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return UNKNOWN_ACTIVITY;
  }
  return deriveActivity(parseLines(file), mtimeMs, nowMs);
}
