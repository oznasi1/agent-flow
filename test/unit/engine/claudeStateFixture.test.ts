// The E2E lane seeds Claude Code state on disk (test-e2e/_helpers/claudeState.ts)
// and then asserts on what the Deck renders from it. That only proves anything if
// each seeded shape reads as the state its name claims — through the REAL readers
// the extension host calls, not a re-derivation. This file is that check: every
// shape goes through `readSessionActivity` (src/engine/transcript.ts), the
// function deckView.ts and attentionFs.ts classify a named session with, and
// every session record through `readOpenSessionsProbe` (src/engine/sessions.ts).
// A shape drifting from the reader fails here, before an E2E journey encodes it.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readSessionActivity, encodeProjectDir as realEncodeProjectDir } from "../../../src/engine/transcript";
import { readOpenSessionsProbe } from "../../../src/engine/sessions";
import { seedSession, seedTranscript, encodeProjectDir, TranscriptShape } from "../../../test-e2e/_helpers/claudeState";

// A pid no process on a developer's machine or CI runner can hold: macOS caps
// pids at 99,998 and Linux's default pid_max is 32,768 (4,194,304 at most).
const DEAD_PID = 999_999;

describe("claudeState fixture helper", () => {
  let home: string;
  const cwd = "/Users/e2e/repos/rocket";
  const sb = () => ({ home });
  const projectsRoot = () => path.join(home, ".claude", "projects");
  const sessionsDir = () => path.join(home, ".claude", "sessions");

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "af-claude-state-"));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  describe("seedTranscript, read back through readSessionActivity", () => {
    const read = (sessionId: string) => readSessionActivity(projectsRoot(), cwd, sessionId, Date.now());

    // Mutation-checked: wrote under the raw cwd instead of encodeProjectDir(cwd)
    it("writes the transcript where readSessionActivity looks for it", () => {
      const file = seedTranscript(sb(), { cwd, sessionId: "s-1", shape: "working" });
      expect(file).toBe(path.join(home, ".claude", "projects", realEncodeProjectDir(cwd), "s-1.jsonl"));
      expect(fs.existsSync(file)).toBe(true);
    });

    // Mutation-checked: wrote under the raw cwd instead of encodeProjectDir(cwd)
    it("`working` reads as working, with work owed", () => {
      seedTranscript(sb(), { cwd, sessionId: "s-w", shape: "working" });
      const a = read("s-w");
      expect(a.state).toBe("working");
      expect(a.midWork).toBe(true);
    });

    // Mutation-checked: ended-turn wrote stop_reason tool_use instead of end_turn
    it("`ended-turn` reads as needs-you — the turn handed control back", () => {
      seedTranscript(sb(), { cwd, sessionId: "s-e", shape: "ended-turn" });
      const a = read("s-e");
      expect(a.state).toBe("needs-you");
      expect(a.midWork).toBe(false);
    });

    // Mutation-checked: dropped the utimesSync, so the file's mtime stayed at now
    it("`idle` reads as idle — its default age is past the reader's working window", () => {
      seedTranscript(sb(), { cwd, sessionId: "s-i", shape: "idle" });
      expect(read("s-i").state).toBe("idle");
    });

    // Mutation-checked: named the pending tool Read instead of Bash
    it("`pending-tool` reads as working and names the tool it waits on", () => {
      seedTranscript(sb(), { cwd, sessionId: "s-p", shape: "pending-tool" });
      const a = read("s-p");
      expect(a.state).toBe("working");
      expect(a.pendingTool).toBe("Bash");
      expect(a.midWork).toBe(true);
    });

    // Mutation-checked: wrote under the raw cwd instead of encodeProjectDir(cwd) (state stays unknown either way — this pins the empty file, not the address)
    it("`empty` reads as unknown — a file with no meaningful lines", () => {
      const file = seedTranscript(sb(), { cwd, sessionId: "s-0", shape: "empty" });
      expect(fs.readFileSync(file, "utf8")).toBe("");
      expect(read("s-0").state).toBe("unknown");
    });

    // Mutation-checked: marked assistant lines isSidechain, which the model read skips
    it("every shape carries a main-chain model, so the drawer's model read is non-null", () => {
      for (const shape of ["working", "ended-turn", "idle", "pending-tool"] as TranscriptShape[]) {
        seedTranscript(sb(), { cwd, sessionId: `m-${shape}`, shape });
        expect(read(`m-${shape}`).model, shape).toBe("claude-fixture");
      }
    });

    // Mutation-checked: dropped the utimesSync; also caught the Bash→Read and end_turn→tool_use mutations
    it("`ageMs` lands on the file's mtime, which is what the reader ages by", () => {
      // The reader ignores line timestamps and ages the file by mtime
      // (deriveActivity's `at`), so a shape whose age is asserted through the
      // real thresholds proves the helper touched the right clock.
      seedTranscript(sb(), { cwd, sessionId: "a-1", shape: "working", ageMs: 60_000 });
      expect(read("a-1").state).toBe("idle"); // stale user line → idle

      seedTranscript(sb(), { cwd, sessionId: "a-2", shape: "pending-tool", ageMs: 100_000 });
      expect(read("a-2").state).toBe("stalled"); // stale Bash, under its 720s ceiling

      seedTranscript(sb(), { cwd, sessionId: "a-3", shape: "pending-tool", ageMs: 800_000 });
      expect(read("a-3").state).toBe("blocked"); // past the Bash ceiling

      seedTranscript(sb(), { cwd, sessionId: "a-4", shape: "ended-turn", ageMs: 3_600_000 });
      expect(read("a-4").state).toBe("needs-you"); // age never demotes a finished turn
    });

    // Mutation-checked: ended-turn wrote stop_reason tool_use instead of end_turn
    it("re-seeding the same session replaces the transcript rather than appending", () => {
      seedTranscript(sb(), { cwd, sessionId: "r-1", shape: "working" });
      seedTranscript(sb(), { cwd, sessionId: "r-1", shape: "ended-turn" });
      expect(read("r-1").state).toBe("needs-you");
    });

    // Mutation-checked: (type-level) a local copy of the function would not be the same reference
    it("re-exports the reader's own encodeProjectDir, not a copy", () => {
      expect(encodeProjectDir).toBe(realEncodeProjectDir);
    });
  });

  describe("seedSession, read back through readOpenSessionsProbe", () => {
    // Mutation-checked: wrote kind "background", which the probe drops
    it("a record with a live pid is listed with the fields a card needs", () => {
      const file = seedSession(sb(), { pid: process.pid, cwd, id: "live-1" });
      expect(file).toBe(path.join(sessionsDir(), "live-1.json"));
      const probe = readOpenSessionsProbe(sessionsDir());
      expect(probe.readable).toBe(true);
      expect(probe.sessions).toHaveLength(1);
      expect(probe.sessions[0]).toMatchObject({ pid: process.pid, sessionId: "live-1", cwd });
      expect(probe.sessions[0].startedAt).toBeGreaterThan(0);
      expect(probe.sessions[0].name).toBeTruthy();
    });

    // Mutation-checked: n/a — proves the reader's pidAlive drop, with DEAD_PID chosen above the OS pid ceiling
    it("a record with a dead pid is written but not listed — the directory still reads", () => {
      const file = seedSession(sb(), { pid: DEAD_PID, cwd, id: "dead-1" });
      expect(fs.existsSync(file)).toBe(true);
      const probe = readOpenSessionsProbe(sessionsDir());
      expect(probe.readable).toBe(true);
      expect(probe.sessions).toEqual([]);
    });

    // Mutation-checked: wrote kind "background", which the probe drops
    it("generates a distinct id per call when none is given, so one pid can hold several sessions", () => {
      const a = seedSession(sb(), { pid: process.pid, cwd });
      const b = seedSession(sb(), { pid: process.pid, cwd });
      expect(a).not.toBe(b);
      const ids = readOpenSessionsProbe(sessionsDir()).sessions.map((s) => s.sessionId);
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(2);
    });

    // Mutation-checked: ended-turn wrote stop_reason tool_use; also caught kind "background"
    it("the session id names the transcript readSessionActivity reads", () => {
      seedSession(sb(), { pid: process.pid, cwd, id: "pair-1" });
      seedTranscript(sb(), { cwd, sessionId: "pair-1", shape: "ended-turn" });
      const [s] = readOpenSessionsProbe(sessionsDir()).sessions;
      expect(readSessionActivity(projectsRoot(), s.cwd, s.sessionId, Date.now()).state).toBe("needs-you");
    });
  });
});
