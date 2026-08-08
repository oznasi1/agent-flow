import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { nodeFlowIo, newFlowId, nodeLockIo } from "../../../../src/engine/orchestrator/flowIo";
import { readFlows, writeFlow, removeFlow } from "../../../../src/engine/orchestrator/store";
import { emptyFlow } from "../../../../src/engine/orchestrator/model";

describe("newFlowId", () => {
  it("only ever produces characters the store accepts", () => {
    // store.ts rejects anything outside this set — a violation here is a crash
    // at write time, not a cosmetic problem.
    for (let i = 0; i < 200; i++) {
      const id = newFlowId(1_800_000_000_000 + i, () => i / 200);
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("is stable for the same inputs and differs when the clock moves", () => {
    expect(newFlowId(1_000, () => 0.5)).toBe(newFlowId(1_000, () => 0.5));
    expect(newFlowId(1_000, () => 0.5)).not.toBe(newFlowId(2_000, () => 0.5));
  });

  it("differs when only the random part changes, so two flows made in one millisecond collide never", () => {
    expect(newFlowId(1_000, () => 0.1)).not.toBe(newFlowId(1_000, () => 0.9));
  });
});

describe("nodeFlowIo", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-flowio-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a flow through the real filesystem", () => {
    const io = nodeFlowIo();
    const flow = { ...emptyFlow("f1", "Ship it", 1_000), armed: false };
    writeFlow(io, dir, flow);
    expect(readFlows(io, dir)).toEqual([flow]);
  });

  it("creates the directory on first write", () => {
    const io = nodeFlowIo();
    const nested = path.join(dir, "deep", "flows");
    writeFlow(io, nested, emptyFlow("f1", "n", 1));
    expect(fs.existsSync(path.join(nested, "f1.json"))).toBe(true);
  });

  it("reads an empty list from a directory that does not exist", () => {
    expect(readFlows(nodeFlowIo(), path.join(dir, "nope"))).toEqual([]);
  });

  it("returns null from readFile rather than throwing for a vanished file", () => {
    // The race readFlows is built to survive: removeFlow deletes between the
    // readdir and the read.
    expect(nodeFlowIo().readFile(path.join(dir, "gone.json"))).toBeNull();
  });

  it("returns null from readFile for a directory rather than throwing", () => {
    fs.mkdirSync(path.join(dir, "adir.json"));
    expect(nodeFlowIo().readFile(path.join(dir, "adir.json"))).toBeNull();
  });

  it("removes a flow, and removing a missing one is not an error", () => {
    const io = nodeFlowIo();
    writeFlow(io, dir, emptyFlow("f1", "n", 1));
    removeFlow(io, dir, "f1");
    expect(readFlows(io, dir)).toEqual([]);
    expect(() => removeFlow(io, dir, "f1")).not.toThrow();
  });

  it("lists only what is in the directory", () => {
    const io = nodeFlowIo();
    writeFlow(io, dir, emptyFlow("a", "a", 2));
    writeFlow(io, dir, emptyFlow("b", "b", 1));
    expect(io.readDir(dir).sort()).toEqual(["a.json", "b.json"]);
  });
});

describe("nodeLockIo", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-lockio-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates a lock exclusively — the second attempt fails rather than throwing", () => {
    const io = nodeLockIo();
    const p = path.join(dir, "x.lock");
    expect(io.tryCreate(p, "1")).toBe(true);
    expect(io.tryCreate(p, "2")).toBe(false);
    // And the first writer's contents survive.
    expect(io.read(p)).toBe("1");
  });

  it("creates the directory if it does not exist yet", () => {
    const io = nodeLockIo();
    expect(io.tryCreate(path.join(dir, "deep", "x.lock"), "1")).toBe(true);
  });

  it("reads null for a missing lock rather than throwing", () => {
    expect(nodeLockIo().read(path.join(dir, "nope.lock"))).toBeNull();
  });

  it("removes a lock, and removing a missing one is not an error", () => {
    const io = nodeLockIo();
    const p = path.join(dir, "x.lock");
    io.tryCreate(p, "1");
    io.remove(p);
    expect(io.read(p)).toBeNull();
    expect(() => io.remove(p)).not.toThrow();
  });

  it("reports an unexpected failure and still fails closed", () => {
    // A file sits where a directory in the lock's path needs to be. mkdirSync
    // must walk through `blocker` as an intermediate segment (not just find it as
    // the immediate parent — that case collapses to EEXIST on this platform,
    // indistinguishable from ordinary lock contention) to get ENOTDIR, which is
    // NOT EEXIST. The lock must still say "no" — never throw into the caller's
    // refresh — but it must also say why, or a stuck flow is undiagnosable.
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "not a directory");
    const lines: string[] = [];
    const io = nodeLockIo((m) => lines.push(m));

    expect(io.tryCreate(path.join(blocker, "sub", "x.lock"), "1")).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("lock");
  });

  it("does not log when the lock is merely already held", () => {
    const lines: string[] = [];
    const io = nodeLockIo((m) => lines.push(m));
    const p = path.join(dir, "x.lock");
    expect(io.tryCreate(p, "1")).toBe(true);
    expect(io.tryCreate(p, "2")).toBe(false);
    expect(lines).toEqual([]);
  });
});
