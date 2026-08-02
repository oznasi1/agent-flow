import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { readOpenSessions, defaultSessionsDir, groupByPlace } from "../../../src/engine/sessions";

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

describe("groupByPlace", () => {
  let repo: string;
  let root: string; // repo, realpath-resolved — what a place key looks like

  const session = (cwd: string, id: string): OpenSession => ({
    pid: process.pid, sessionId: id, cwd, startedAt: 1, name: id,
  });

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-place-"));
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", repo]);
    fs.mkdirSync(path.join(repo, "src"));
    root = fs.realpathSync(repo);
  });

  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

  it("groups a session in a subdirectory with one at the repo root", () => {
    const m = groupByPlace([session(repo, "a"), session(path.join(repo, "src"), "b")]);
    expect([...m.keys()]).toEqual([root]);
    expect(m.get(root)!.map((s) => s.sessionId)).toEqual(["a", "b"]);
  });

  it("groups a cwd in no repo under itself", () => {
    const loose = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-loose-place-"));
    const m = groupByPlace([session(loose, "a")]);
    expect([...m.keys()]).toEqual([fs.realpathSync(loose)]);
    fs.rmSync(loose, { recursive: true, force: true });
  });

  it("keeps two different repos apart", () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-place2-"));
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", other]);
    const m = groupByPlace([session(repo, "a"), session(other, "b")]);
    expect(m.size).toBe(2);
    fs.rmSync(other, { recursive: true, force: true });
  });

  it("returns an empty map for no sessions", () => {
    expect(groupByPlace([]).size).toBe(0);
  });
});
