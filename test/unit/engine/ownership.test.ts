import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { OwnedRun, resolveOwnership } from "../../../src/engine/ownership";
import { OpenSession } from "../../../src/types";

describe("ownership.ts is fs-free", () => {
  it("imports nothing but ../types, so every rule is testable without a temp directory", () => {
    const src = fs.readFileSync(path.join(__dirname, "../../../src/engine/ownership.ts"), "utf8");
    const specifiers = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(specifiers).toEqual(["../types"]);
  });
});

const NOW = 1_700_000_000_000;
const MIN = 60_000;

const run = (key: string, createdAt: number, ...paths: string[]): OwnedRun => ({ key, createdAt, paths });
const sess = (sessionId: string, startedAt: number): OpenSession => ({
  pid: 1, sessionId, cwd: "/w/agent-flow", startedAt, name: null,
});
const places = (m: Record<string, OpenSession[]>) => new Map(Object.entries(m));

describe("resolveOwnership — sessions", () => {
  it("gives a session to the newest run created at or before it started", () => {
    const o = resolveOwnership({
      runs: [
        run("notepad-a", NOW - 90 * MIN, "/w/agent-flow"),
        run("notepad-b", NOW - 30 * MIN, "/w/agent-flow"),
        run("notepad-c", NOW - 5 * MIN, "/w/agent-flow"),
      ],
      sessionsByPlace: places({ "/w/agent-flow": [sess("s1", NOW - 60 * MIN)] }),
    });
    expect(o.sessionOwner.get("s1")).toBe("notepad-a");
  });

  it("renders two sessions in one checkout as two runs, not eight cards", () => {
    // The defect this module exists for: four notepad runs on one directory used
    // to each claim both sessions.
    const o = resolveOwnership({
      runs: [
        run("notepad-a", NOW - 90 * MIN, "/w/agent-flow"),
        run("notepad-b", NOW - 60 * MIN, "/w/agent-flow"),
        run("notepad-c", NOW - 30 * MIN, "/w/agent-flow"),
        run("notepad-d", NOW - 10 * MIN, "/w/agent-flow"),
      ],
      sessionsByPlace: places({
        "/w/agent-flow": [sess("s1", NOW - 45 * MIN), sess("s2", NOW - 5 * MIN)],
      }),
    });
    expect(o.sessionOwner.get("s1")).toBe("notepad-b");
    expect(o.sessionOwner.get("s2")).toBe("notepad-d");
    expect([...o.runsWithSession].sort()).toEqual(["notepad-b", "notepad-d"]);
  });

  it("falls back to the newest run when the session predates every run", () => {
    const o = resolveOwnership({
      runs: [run("a", NOW - 10 * MIN, "/w/x"), run("b", NOW - 5 * MIN, "/w/x")],
      sessionsByPlace: places({ "/w/x": [sess("s1", NOW - 60 * MIN)] }),
    });
    expect(o.sessionOwner.get("s1")).toBe("b");
  });

  it("falls back to the newest run for startedAt: 0, which the reader defaults", () => {
    const o = resolveOwnership({
      runs: [run("a", NOW - 10 * MIN, "/w/x"), run("b", NOW - 5 * MIN, "/w/x")],
      sessionsByPlace: places({ "/w/x": [sess("s1", 0)] }),
    });
    expect(o.sessionOwner.get("s1")).toBe("b");
  });

  it("breaks a createdAt tie on the key, so the board is stable refresh to refresh", () => {
    const o = resolveOwnership({
      runs: [run("zzz", NOW - 10 * MIN, "/w/x"), run("aaa", NOW - 10 * MIN, "/w/x")],
      sessionsByPlace: places({ "/w/x": [sess("s1", NOW)] }),
    });
    expect(o.sessionOwner.get("s1")).toBe("aaa");
  });

  it("holds the tie-break regardless of the order the runs arrive in", () => {
    const o = resolveOwnership({
      runs: [run("aaa", NOW - 10 * MIN, "/w/x"), run("zzz", NOW - 10 * MIN, "/w/x")],
      sessionsByPlace: places({ "/w/x": [sess("s1", NOW)] }),
    });
    expect(o.sessionOwner.get("s1")).toBe("aaa");
  });

  it("leaves a session in a path no run holds unclaimed, so local cards still build", () => {
    const o = resolveOwnership({
      runs: [run("a", NOW - 10 * MIN, "/w/x")],
      sessionsByPlace: places({ "/w/elsewhere": [sess("s1", NOW)] }),
    });
    expect(o.sessionOwner.has("s1")).toBe(false);
    expect(o.runsWithSession.size).toBe(0);
  });

  it("attributes a multi-repo run's session through whichever repo it runs in", () => {
    const o = resolveOwnership({
      runs: [run("ASM-1", NOW - 60 * MIN, "/w/api", "/w/web")],
      sessionsByPlace: places({ "/w/web": [sess("s1", NOW - 30 * MIN)] }),
    });
    expect(o.sessionOwner.get("s1")).toBe("ASM-1");
  });
});

describe("resolveOwnership — paths", () => {
  it("gives a path to the run that owns a live session in it", () => {
    const o = resolveOwnership({
      runs: [run("old", NOW - 90 * MIN, "/w/x"), run("new", NOW - 5 * MIN, "/w/x")],
      sessionsByPlace: places({ "/w/x": [sess("s1", NOW - 60 * MIN)] }),
    });
    // "old" launched the session, so the dirty checkout is attributed to it —
    // not to "new", which merely happens to be the newest record.
    expect(o.pathOwner.get("/w/x")).toBe("old");
  });

  it("gives a session-free path to the newest run holding it", () => {
    const o = resolveOwnership({
      runs: [run("old", NOW - 90 * MIN, "/w/x"), run("new", NOW - 5 * MIN, "/w/x")],
      sessionsByPlace: new Map(),
    });
    expect(o.pathOwner.get("/w/x")).toBe("new");
  });

  it("gives every repo of a sole holder to that run", () => {
    const o = resolveOwnership({
      runs: [run("ASM-1", NOW, "/w/api", "/w/web")],
      sessionsByPlace: new Map(),
    });
    expect(o.pathOwner.get("/w/api")).toBe("ASM-1");
    expect(o.pathOwner.get("/w/web")).toBe("ASM-1");
  });

  it("records no owner for a path no run holds", () => {
    const o = resolveOwnership({ runs: [run("a", NOW, "/w/x")], sessionsByPlace: new Map() });
    expect(o.pathOwner.has("/w/elsewhere")).toBe(false);
  });
});
