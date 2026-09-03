import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { Sandbox } from "./sandbox";
import { encodeProjectDir } from "../../src/engine/transcript";

/**
 * Claude Code state on disk, seeded into a sandbox HOME so a journey can drive
 * the Live signal, the Action required column, the activity-bar badge, `local`
 * cards and Track it without a real Claude Code process.
 *
 * Two files, two readers — the record shapes below are copied from the readers,
 * which own them (Claude Code writes both; Agent Flow Deck only ever reads):
 *
 * `~/.claude/sessions/<id>.json` — read by `readOpenSessionsProbe`
 * (src/engine/sessions.ts:48-83). `RawSession` (sessions.ts:19-26) probes:
 *   pid        number > 0, and `pidAlive(pid)` must hold (sessions.ts:68, :71;
 *              paths.ts:27-34 — `process.kill(pid, 0)`, EPERM counts as alive)
 *   sessionId  non-empty string — names the transcript (sessions.ts:69)
 *   cwd        non-empty string (sessions.ts:70)
 *   startedAt  number, else 0 (sessions.ts:76) — the probe sorts oldest first
 *   name       non-empty string, else null (sessions.ts:77)
 *   kind       if a string, must be "interactive"; absent is kept (sessions.ts:67)
 * The pid to seed is the launched Electron's own (`launched.app.process().pid`):
 * alive for the test's life, dead the moment the host closes. Real Claude Code
 * names the file after the pid; this helper names it after the id so several
 * sessions can share the one Electron pid — the reader accepts any `*.json`
 * (sessions.ts:51).
 *
 * `~/.claude/projects/<encodeProjectDir(cwd)>/<sessionId>.jsonl` — read by
 * `readSessionActivity` (src/engine/transcript.ts:261-275), which hands the
 * last 200 parsed lines (`parseLines`, transcript.ts:168) plus the file's MTIME
 * to `deriveActivity` (transcript.ts:123-161). `TranscriptLine`
 * (transcript.ts:54-67) is read as:
 *   type                "user" | "assistant" are the meaningful lines (:129)
 *   message.stop_reason "end_turn" on the last line → needs-you, any age (:135)
 *                       "tool_use" on the last line → a pending tool (:140)
 *   message.content     last `{type:"tool_use", name}` block names it (:104-115)
 *   message.model       main-chain only — `isSidechain` lines are skipped (:82-87)
 *   slug, gitBranch     newest wins (:124, :190-192); unused here
 * Age is `nowMs - mtime`, never the line timestamps (:128, :146) — so `ageMs`
 * lands on the file with `utimesSync`, and the ISO timestamps on the lines are
 * kept consistent with it only for the reader of the raw file. Thresholds:
 *   ≤ WORKING_WINDOW_MS (45_000, :8)   → working, whatever the last line
 *   > 45s, last line user               → idle (:160)
 *   > 45s, last line tool_use           → stalled (:158), or blocked once past
 *                                         BLOCKED_AFTER_MS[tool] (:44-51);
 *                                         Bash's ceiling is 720_000
 * `empty` writes a zero-line file: no meaningful lines → "unknown" (:130) with
 * lastActivityMs = mtime. (A MISSING file is also "unknown", but with
 * lastActivityMs null — UNKNOWN_ACTIVITY, :272.)
 *
 * A `working` transcript stays working for 45s after seeding. Assert inside
 * that window, or re-seed before the assertion.
 */

/** The seed only needs `home`; a unit test passes a bare temp dir. */
export type ClaudeStateHome = Pick<Sandbox, "home">;

export type TranscriptShape = "working" | "ended-turn" | "idle" | "pending-tool" | "empty";

/** File age when the caller gives none. Fresh shapes sit at 0 so the 45s working
 * window is as wide as the journey can get; `idle` must exceed 45s (transcript.ts:8)
 * and 120s gives that a real margin while staying under every `blocked` ceiling. */
export const DEFAULT_AGE_MS: Record<TranscriptShape, number> = {
  working: 0,
  "pending-tool": 0,
  "ended-turn": 0,
  idle: 120_000,
  empty: 0,
};

export { encodeProjectDir };

/** Write one live-session record. Returns the path written. */
export function seedSession(sb: ClaudeStateHome, o: { pid: number; cwd: string; id?: string }): string {
  const id = o.id ?? `e2e-${crypto.randomBytes(6).toString("hex")}`;
  const dir = path.join(sb.home, ".claude", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  const record = {
    pid: o.pid,
    sessionId: id,
    cwd: o.cwd,
    startedAt: Date.now(),
    kind: "interactive",
    name: path.basename(o.cwd),
  };
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  return file;
}

type LineType = "user" | "assistant";

const line = (type: LineType, cwd: string, at: number, extra: Record<string, unknown>): string =>
  JSON.stringify({ type, timestamp: new Date(at).toISOString(), isSidechain: false, cwd, ...extra });

const prompt = (cwd: string, at: number): string =>
  line("user", cwd, at, { message: { role: "user", content: "Fix the rocket telemetry panel." } });

const toolResult = (cwd: string, at: number): string =>
  line("user", cwd, at, {
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_fixture", content: "ok" }] },
  });

const assistant = (cwd: string, at: number, stop: "end_turn" | "tool_use"): string =>
  line("assistant", cwd, at, {
    message: {
      role: "assistant",
      model: "claude-fixture",
      stop_reason: stop,
      content:
        stop === "tool_use"
          ? [{ type: "tool_use", id: "toolu_fixture", name: "Bash", input: { command: "npm test" } }]
          : [{ type: "text", text: "Done — the panel reads the live feed now." }],
    },
  });

/** Lines for each shape, oldest first, ending at `at` (the file's mtime). */
const SHAPES: Record<TranscriptShape, (cwd: string, at: number) => string[]> = {
  // Last line is a tool result the session has not answered yet: fresh → working, midWork.
  working: (cwd, at) => [prompt(cwd, at - 2_000), assistant(cwd, at - 1_000, "tool_use"), toolResult(cwd, at)],
  // Last line is an unanswered Bash call: fresh → working with pendingTool "Bash";
  // pass ageMs > 45_000 for stalled, > 720_000 for blocked.
  "pending-tool": (cwd, at) => [prompt(cwd, at - 1_000), assistant(cwd, at, "tool_use")],
  // Last line ended the turn: needs-you at any age.
  "ended-turn": (cwd, at) => [prompt(cwd, at - 1_000), assistant(cwd, at, "end_turn")],
  // Same lines as `working`; only the default age differs, and age is what makes it idle.
  idle: (cwd, at) => [prompt(cwd, at - 2_000), assistant(cwd, at - 1_000, "tool_use"), toolResult(cwd, at)],
  empty: () => [],
};

/** Write one session's transcript in the given shape. Replaces any existing file
 * for that session. Returns the path written. */
export function seedTranscript(
  sb: ClaudeStateHome,
  o: { cwd: string; sessionId: string; shape: TranscriptShape; ageMs?: number },
): string {
  const at = Date.now() - (o.ageMs ?? DEFAULT_AGE_MS[o.shape]);
  const dir = path.join(sb.home, ".claude", "projects", encodeProjectDir(o.cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${o.sessionId}.jsonl`);
  const lines = SHAPES[o.shape](o.cwd, at);
  fs.writeFileSync(file, lines.length === 0 ? "" : lines.join("\n") + "\n");
  // The reader ages the file by mtime, not by the line timestamps.
  fs.utimesSync(file, at / 1000, at / 1000);
  return file;
}
