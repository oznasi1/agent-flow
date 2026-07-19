import * as fs from "fs";
import * as path from "path";
import { AgentActivity } from "../types";

// A working agent's transcript is written to within this window; older → not "working".
const WORKING_WINDOW_MS = 45_000;

/** The subset of a Claude Code transcript line we read. */
export interface TranscriptLine {
  type?: string; // "user" | "assistant" | "attachment" | "file-history-snapshot" | …
  timestamp?: string; // ISO
  gitBranch?: string;
  cwd?: string;
  slug?: string;
  message?: { role?: string; stop_reason?: string | null };
}

/**
 * Encode an absolute cwd into its Claude Code project-dir name under
 * ~/.claude/projects — every "/" and "." becomes "-".
 * e.g. /Users/me/proj/.worktrees/x → -Users-me-proj--worktrees-x
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/**
 * Derive live agent activity from the tail of a transcript plus the file's mtime.
 * Pure — `nowMs` is injected so callers control the clock. When no meaningful
 * lines exist the state is "unknown"; the caller uses "unknown" too when no
 * transcript file is found (graceful degradation to the git/Jira backbone).
 */
export function deriveActivity(lines: TranscriptLine[], mtimeMs: number, nowMs: number): AgentActivity {
  const slug = [...lines].reverse().find((l) => l.slug)?.slug ?? null;
  const meaningful = lines.filter((l) => l.type === "user" || l.type === "assistant");
  if (meaningful.length === 0) return { state: "unknown", lastActivityMs: mtimeMs ?? null, slug };

  const last = meaningful[meaningful.length - 1];
  // Turn ended and control is back with the human — actionable regardless of how
  // long ago it happened.
  if (last.type === "assistant" && last.message?.stop_reason === "end_turn") {
    return { state: "needs-you", lastActivityMs: mtimeMs, slug };
  }
  const age = nowMs - mtimeMs;
  if (age <= WORKING_WINDOW_MS) return { state: "working", lastActivityMs: mtimeMs, slug };
  return { state: "idle", lastActivityMs: mtimeMs, slug };
}

const UNKNOWN: AgentActivity = { state: "unknown", lastActivityMs: null, slug: null };

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
    return UNKNOWN; // no project dir / unreadable → graceful degradation
  }
  if (files.length === 0) return UNKNOWN;

  // Prefer the newest transcript whose branch matches this run; otherwise the
  // newest overall. (A worktree cwd already isolates one branch; a repo checked
  // out directly can hold sessions for several, so the branch join matters there.)
  const parsed = files.map((f) => ({ ...f, lines: parseLines(f.path) }));
  const match = branch ? parsed.find((f) => lastBranch(f.lines) === branch) : undefined;
  const chosen = match ?? parsed[0];
  return deriveActivity(chosen.lines, chosen.mtimeMs, nowMs);
}
