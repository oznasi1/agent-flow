import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readOpenSessions, defaultSessionsDir } from "../../../src/engine/sessions";

const DEAD = 2 ** 30;

describe("readOpenSessions", () => {
  let dir: string;
  const put = (pid: number, over: Record<string, unknown> = {}): void => {
    fs.writeFileSync(
      path.join(dir, `${pid}.json`),
      JSON.stringify({
        pid,
        sessionId: `sess-${pid}`,
        cwd: "/Users/dev/projects/centaur",
        startedAt: 1_700_000_000_000,
        kind: "interactive",
        name: `centaur-${pid}`,
        ...over,
      }),
    );
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-sessions-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("returns a live session with the fields a card needs", () => {
    put(process.pid);
    expect(readOpenSessions(dir)).toEqual([
      {
        pid: process.pid,
        sessionId: `sess-${process.pid}`,
        cwd: "/Users/dev/projects/centaur",
        startedAt: 1_700_000_000_000,
        name: `centaur-${process.pid}`,
      },
    ]);
  });

  it("drops a record whose process is gone", () => {
    put(DEAD);
    expect(readOpenSessions(dir)).toEqual([]);
  });

  it("leaves the dead record on disk — the directory is Claude Code's", () => {
    put(DEAD);
    readOpenSessions(dir);
    expect(fs.existsSync(path.join(dir, `${DEAD}.json`))).toBe(true);
  });

  it("skips a malformed file without losing the good ones", () => {
    fs.writeFileSync(path.join(dir, "broken.json"), "{ not json");
    put(process.pid);
    expect(readOpenSessions(dir)).toHaveLength(1);
  });

  it("drops a kind that is present and is not interactive", () => {
    put(process.pid, { kind: "headless" });
    expect(readOpenSessions(dir)).toEqual([]);
  });

  it("keeps a record with no kind at all", () => {
    // A future Claude Code that stops writing the field should degrade to showing
    // sessions, not to showing none.
    put(process.pid, { kind: undefined });
    expect(readOpenSessions(dir)).toHaveLength(1);
  });

  it("skips a record missing a sessionId or a cwd", () => {
    put(process.pid, { sessionId: "" });
    expect(readOpenSessions(dir)).toEqual([]);
  });

  it("defaults a missing name to null and a missing startedAt to 0", () => {
    put(process.pid, { name: undefined, startedAt: undefined });
    expect(readOpenSessions(dir)[0]).toMatchObject({ name: null, startedAt: 0 });
  });

  it("ignores files that are not .json", () => {
    fs.writeFileSync(path.join(dir, "notes.txt"), "hello");
    expect(readOpenSessions(dir)).toEqual([]);
  });

  it("returns [] for a directory that does not exist", () => {
    expect(readOpenSessions(path.join(dir, "nope"))).toEqual([]);
  });

  it("sorts oldest session first", () => {
    put(process.pid, { startedAt: 200 });
    fs.writeFileSync(
      path.join(dir, "other.json"),
      JSON.stringify({ pid: process.pid, sessionId: "early", cwd: "/r", startedAt: 100, kind: "interactive" }),
    );
    expect(readOpenSessions(dir).map((s) => s.sessionId)).toEqual(["early", `sess-${process.pid}`]);
  });
});

describe("defaultSessionsDir", () => {
  it("points at ~/.claude/sessions", () => {
    expect(defaultSessionsDir()).toBe(path.join(os.homedir(), ".claude", "sessions"));
  });
});
