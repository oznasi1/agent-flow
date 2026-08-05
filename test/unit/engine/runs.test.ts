import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { writeRun, readRuns, removeRun, runTarget, describeActiveTasks } from "../../../src/engine/runs";
import { Run } from "../../../src/types";

const mkRun = (key: string, createdAt: number): Run => ({
  key,
  summary: `${key} summary`,
  url: `https://x/${key}`,
  createdAt,
  mode: "per-window",
  repos: [{ name: "svc", path: "/repos/svc", isGit: true, branch: key.toLowerCase() }],
  briefPaths: [`/repos/svc/.pick-task/TASK.md`],
});

describe("runs store", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-runs-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("round-trips every written run", () => {
    writeRun(dir, mkRun("ASM-1", 100));
    writeRun(dir, mkRun("ASM-2", 300));
    expect(readRuns(dir).map((r) => r.key).sort()).toEqual(["ASM-1", "ASM-2"]);
  });

  it("returns runs newest-first by createdAt", () => {
    writeRun(dir, mkRun("ASM-1", 100));
    writeRun(dir, mkRun("ASM-2", 300));
    expect(readRuns(dir)[0].key).toBe("ASM-2");
  });

  it("preserves repo branch through the round-trip", () => {
    writeRun(dir, mkRun("ASM-1", 100));
    expect(readRuns(dir)[0].repos[0].branch).toBe("asm-1");
  });

  it("skips malformed files rather than throwing", () => {
    writeRun(dir, mkRun("ASM-1", 100));
    fs.writeFileSync(path.join(dir, "corrupt.json"), "{ not valid json");
    expect(readRuns(dir).length).toBe(1);
  });

  it("overwrites the same key (one file per ticket)", () => {
    writeRun(dir, mkRun("ASM-2", 300));
    writeRun(dir, mkRun("ASM-2", 999));
    const same = readRuns(dir).filter((r) => r.key === "ASM-2");
    expect(same.length).toBe(1);
    expect(same[0].createdAt).toBe(999);
  });

  it("removes a run", () => {
    writeRun(dir, mkRun("ASM-1", 100));
    removeRun(dir, "ASM-1");
    expect(readRuns(dir).some((r) => r.key === "ASM-1")).toBe(false);
  });

  it("returns [] for a missing dir (no throw)", () => {
    expect(readRuns(path.join(dir, "nope"))).toEqual([]);
  });
});

describe("runTarget", () => {
  const base = { key: "K-1", summary: "s", url: "u", createdAt: 1, mode: "per-window" as const, briefPaths: [] };

  it("prefers the multi-root workspace file", () => {
    expect(runTarget({ ...base, mode: "multiroot", workspaceFile: "/ws/K-1.code-workspace",
      repos: [{ name: "a", path: "/r/a", isGit: true }] })).toBe("/ws/K-1.code-workspace");
  });

  it("falls back to the first repo path", () => {
    expect(runTarget({ ...base, repos: [{ name: "a", path: "/r/a", isGit: true }] })).toBe("/r/a");
  });

  it("is undefined when there is nothing to open", () => {
    expect(runTarget({ ...base, repos: [] })).toBeUndefined();
  });
});

describe("describeActiveTasks", () => {
  it("returns the empty-state sentence when there are no runs", () => {
    expect(describeActiveTasks([], new Set())).toBe("_No other active tasks right now._");
  });

  it("excludes a finished run", () => {
    const finished = { ...mkRun("ASM-1", 100), finishedAt: 200 };
    expect(describeActiveTasks([finished], new Set())).toBe("_No other active tasks right now._");
  });

  it("includes only the unfinished runs from a mix of finished and unfinished", () => {
    const finished = { ...mkRun("ASM-1", 100), finishedAt: 200 };
    const unfinished = mkRun("ASM-2", 300);
    const md = describeActiveTasks([finished, unfinished], new Set());
    expect(md).not.toContain("ASM-1");
    expect(md).toContain("ASM-2");
  });

  it("lists an unfinished run as idle when its repo has no live session", () => {
    const run = mkRun("ASM-1", 100);
    expect(describeActiveTasks([run], new Set())).toBe(
      "## Active tasks\n- **ASM-1** (task) — ASM-1 summary — `/repos/svc` (branch: asm-1) — idle, no agent attached",
    );
  });

  it("marks a run as having an agent open when its repo is in livePlaces", () => {
    const run = mkRun("ASM-1", 100);
    expect(describeActiveTasks([run], new Set(["/repos/svc"]))).toContain("agent open");
    expect(describeActiveTasks([run], new Set(["/repos/svc"]))).not.toContain("idle");
  });

  it("renders a run's kind, tolerating an old record with no kind field", () => {
    const tagged = { ...mkRun("ASM-1", 100), kind: "explore" as const };
    expect(describeActiveTasks([tagged], new Set())).toContain("**ASM-1** (explore)");
    const untagged = mkRun("ASM-2", 100);
    expect(describeActiveTasks([untagged], new Set())).toContain("**ASM-2** (task)");
  });

  it("falls back to an 'unknown location' placeholder for a run with no repos", () => {
    const run = { ...mkRun("ASM-1", 100), repos: [] };
    expect(describeActiveTasks([run], new Set())).toContain("unknown location");
  });

  it("doesn't throw on a malformed run with repos missing entirely, and falls back to 'unknown location'", () => {
    // readRuns only validates `.key` — a hand-edited or legacy record can reach
    // here with no `repos` field at all (not just an empty array).
    const { repos, ...rest } = mkRun("ASM-1", 100);
    const malformed = rest as unknown as Run;
    expect(() => describeActiveTasks([malformed], new Set())).not.toThrow();
    expect(describeActiveTasks([malformed], new Set())).toContain("unknown location");
    expect(describeActiveTasks([malformed], new Set())).toContain("idle, no agent attached");
  });

  it("collapses an embedded newline in a run's summary so the bullet stays a single line", () => {
    const run = { ...mkRun("ASM-1", 100), summary: "Fix the retry bug\nand the flaky test" };
    const md = describeActiveTasks([run], new Set());
    expect(md.split("\n")).toEqual([
      "## Active tasks",
      "- **ASM-1** (task) — Fix the retry bug and the flaky test — `/repos/svc` (branch: asm-1) — idle, no agent attached",
    ]);
  });

  it("lists multiple active runs as separate bullets, newest first if readRuns already sorted them", () => {
    const a = mkRun("ASM-1", 100);
    const b = mkRun("ASM-2", 300);
    const md = describeActiveTasks([b, a], new Set());
    expect(md.split("\n")).toEqual([
      "## Active tasks",
      "- **ASM-2** (task) — ASM-2 summary — `/repos/svc` (branch: asm-2) — idle, no agent attached",
      "- **ASM-1** (task) — ASM-1 summary — `/repos/svc` (branch: asm-1) — idle, no agent attached",
    ]);
  });
});
