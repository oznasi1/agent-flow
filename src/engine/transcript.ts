import * as fs from "fs";
import * as path from "path";
import { AgentActivity } from "../types";
import { UNKNOWN_ACTIVITY } from "./activity";

// A working agent's transcript is written to within this window; older → not
// "working" (and, with a tool still outstanding, "stalled").
const WORKING_WINDOW_MS = 45_000;

/**
 * How long a pending call to each tool must stand before it means a human is
 * being asked something rather than a command is running. `deriveActivity`'s
 * `stalled` is deliberately true of both; the tool's NAME is the only
 * discriminator the transcript offers, and it settles the question only for a
 * tool that is permission-gated AND bounded — which is these six names.
 *
 * Thresholds are measured, not assumed: 279 transcripts in ~/.claude/projects
 * over eight days, ~13,000 tool calls, each gap taken between a
 * `stop_reason: "tool_use"` line and the `type: "user"` line that answered it.
 *
 *  - AskUserQuestion / ExitPlanMode — pendency IS the gate, so 0: there is no
 *    timing claim to make. Measured max 88,782s (24.7 hours), every second of
 *    which read `stalled` before this.
 *  - Edit / Write / NotebookEdit — measured max 47.2s across 1,566 calls, which
 *    is barely past WORKING_WINDOW_MS. 60s gives the ceiling a real margin.
 *  - Bash — the ONE threshold here that is not a heuristic: the Bash tool's own
 *    schema caps `timeout` at 600,000ms, so a pending call past that provably is
 *    not a running command. 720s is that cap plus two minutes for clock skew and
 *    a slow transcript flush; measured max 639s across 10,172 calls.
 *
 * A tool ABSENT from this table is never `blocked`, and for two distinct
 * reasons worth keeping straight when adding one:
 *
 *  - Agent, Workflow, TaskOutput, Monitor and every mcp__* call are gated but
 *    UNBOUNDED. A backgrounded subagent legitimately pends 46 minutes (measured
 *    max 2,775s), so no ceiling can be honest and none is offered.
 *  - Read, Grep, Glob and TodoWrite are bounded but NOT GATED. A hung read is a
 *    wedged host, not a question; calling it `blocked` would claim someone is
 *    being asked something when nobody is.
 *
 * WebFetch and WebSearch are gated and bounded in practice but the sample was
 * n=8, which is not a sample. They stay out until there is data.
 */
const BLOCKED_AFTER_MS: Record<string, number> = {
  AskUserQuestion: 0,
  ExitPlanMode: 0,
  Edit: 60_000,
  Write: 60_000,
  NotebookEdit: 60_000,
  Bash: 720_000,
};

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
  /** `content` is the API content-block array — text and tool_use blocks. Typed
   * `unknown` on purpose: Claude Code owns this format, and `pendingToolName`
   * below checks every hop rather than trusting the shape. */
  message?: { role?: string; stop_reason?: string | null; model?: string; content?: unknown };
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
 * The name of the tool call this line is waiting on, or null.
 *
 * Every hop is checked — the content array, its members, their `type` and their
 * `name` — for the same reason `readOpenSessions` narrows `RawSession`: Claude
 * Code owns this format and may change it under us. Anything unexpected yields
 * null, and null is the fall-through case for the class table in
 * `deriveActivity`, so a format change degrades to the pre-`blocked` reading
 * rather than to a wrong state or a throw.
 *
 * Reads the LAST tool_use block: one assistant turn can hold several parallel
 * calls, and the transcript cannot say which of them is the one still
 * outstanding. The last is the best available guess and matches what the
 * transcript's own tail-first reads elsewhere in this file already do.
 */
function pendingToolName(line: TranscriptLine): string | null {
  const content = line.message?.content;
  if (!Array.isArray(content)) return null;
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i];
    if (!block || typeof block !== "object") continue;
    if ((block as { type?: unknown }).type !== "tool_use") continue;
    const name = (block as { name?: unknown }).name;
    return typeof name === "string" && name ? name : null;
  }
  return null;
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
  // An mtime ahead of the injected clock (skew, a restored file) would put a
  // future timestamp on lastActivityMs and a negative age below; clamp to now.
  const at = mtimeMs > nowMs ? nowMs : mtimeMs;
  const meaningful = lines.filter((l) => l.type === "user" || l.type === "assistant");
  if (meaningful.length === 0) return { state: "unknown", lastActivityMs: at ?? null, slug, midWork: false, ...model };

  const last = meaningful[meaningful.length - 1];
  // Turn ended and control is back with the human — actionable regardless of how
  // long ago it happened.
  if (last.type === "assistant" && last.message?.stop_reason === "end_turn") {
    return { state: "needs-you", lastActivityMs: at, slug, midWork: false, ...model };
  }
  // A tool call that never returned. Nothing follows the last meaningful line by
  // definition, so "no tool_result after it" needs no separate check.
  const pendingTool = last.type === "assistant" && last.message?.stop_reason === "tool_use";
  const toolName = pendingTool ? pendingToolName(last) : null;
  // Work is owed either way: a tool that has not returned, or a user line — a
  // real prompt, or a tool_result — the agent has not answered. Note that Claude
  // Code writes tool results as type "user".
  const midWork = pendingTool || last.type === "user";
  const age = nowMs - at;
  if (age <= WORKING_WINDOW_MS) return { state: "working", lastActivityMs: at, slug, midWork, pendingTool: toolName, ...model };
  // Stale with a tool still outstanding. The table settles this for the four
  // gated-and-bounded tools; for everything else, and for a line whose tool name
  // could not be read, `stalled` stays the honest hedge it always was — the
  // agent is at a permission prompt, or a long command is running, and the
  // transcript cannot say which.
  if (pendingTool) {
    const ceiling = toolName === null ? undefined : BLOCKED_AFTER_MS[toolName];
    if (ceiling !== undefined && age > ceiling) {
      return { state: "blocked", lastActivityMs: at, slug, midWork, pendingTool: toolName, ...model };
    }
    return { state: "stalled", lastActivityMs: at, slug, midWork, pendingTool: toolName, ...model };
  }
  return { state: "idle", lastActivityMs: at, slug, midWork, ...model };
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
      // A line that is exactly "null" (or a bare scalar) is valid JSON but not
      // a record — property reads off it would throw downstream.
      const parsed = JSON.parse(r);
      if (parsed && typeof parsed === "object") out.push(parsed);
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
  //
  // Parsed one file at a time, and only as far as the answer needs. This used to
  // be `files.map(parseLines)` up front, which read EVERY transcript in the
  // directory before choosing one — and `parseLines` reads a whole `.jsonl` to
  // keep its last 200 lines. Claude Code never prunes ~/.claude/projects, so a
  // long-lived repo's directory grows without bound: measured here at 137 files
  // / 356 MB, one call cost ~1.0s of blocking I/O on the extension host's main
  // thread. The attention pass runs this on every other 6s poll whether or not
  // the Deck is open, so that was ~1.0s every 12s, forever, in every window.
  // Laziness is the whole fix — the read shape is deliberately unchanged.
  //
  // Behaviour-preserving by construction: `parsed.find` returned the FIRST
  // mtime-ordered branch match and fell back to `parsed[0]`, so parsing
  // `files[0]` eagerly and then stopping at the first match gives the identical
  // choice for every input. transcript.test.ts and status.test.ts pass
  // unmodified; transcriptLazy.test.ts pins the read count.
  const first = { ...files[0], lines: parseLines(files[0].path) };
  let chosen = first;
  if (branch) {
    for (let i = 0; i < files.length; i++) {
      const lines = i === 0 ? first.lines : parseLines(files[i].path);
      if (lastBranch(lines) === branch) {
        chosen = { ...files[i], lines };
        break;
      }
    }
  }
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
