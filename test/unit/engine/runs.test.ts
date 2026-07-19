import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { writeRun, readRuns, removeRun } from "../../../src/engine/runs";
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
