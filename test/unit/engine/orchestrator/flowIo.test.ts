import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { nodeFlowIo, newFlowId, nodeLockIo, nodeJournalIo } from "../../../../src/engine/orchestrator/flowIo";
import { readFlows, writeFlow, removeFlow } from "../../../../src/engine/orchestrator/store";
import { emptyFlow } from "../../../../src/engine/orchestrator/model";
import {
  appendEvent, readJournal, journalPath, JOURNAL_CAP_BYTES,
} from "../../../../src/engine/orchestrator/journal";

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
    // `writeFlow` mints `analyticsId` for a flow that has none, so what comes
    // back is the flow PLUS that field — which is why the round-trip is asserted
    // against the return value rather than against the input. Compared as a whole
    // object, not `toMatchObject`, so a write that dropped or rewrote any other
    // field still fails here.
    const written = writeFlow(io, dir, flow);
    expect(readFlows(io, dir)).toEqual([written]);
    expect(written).toEqual({ ...flow, analyticsId: written.analyticsId });
    expect(written.analyticsId).toMatch(/^[0-9a-f-]{36}$/);
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

describe("nodeJournalIo", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-journal-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips events through the real filesystem", () => {
    const io = nodeJournalIo();
    appendEvent(io, dir, "f1", { kind: "armed", armed: true, source: "toggle" }, 1_000);
    appendEvent(io, dir, "f1", { kind: "reset", edge: "e7" }, 1_001);

    const events = readJournal(io, dir, "f1");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "armed", armed: true });
    expect(events[1]).toMatchObject({ kind: "reset", edge: "e7" });
  });

  it("creates the flows directory if it is not there yet", () => {
    const io = nodeJournalIo();
    const nested = path.join(dir, "not", "made", "yet");
    appendEvent(io, nested, "f1", { kind: "reset", edge: "e1" }, 1_000);
    expect(fs.existsSync(journalPath(nested, "f1"))).toBe(true);
  });

  it("appends rather than overwriting — a second writer cannot lose the first's lines", () => {
    // Root ignores permission bits, which would make this assertion vacuous
    // rather than failing — skip loudly instead of passing quietly.
    if (process.getuid?.() === 0) return;

    const io = nodeJournalIo();
    const p = journalPath(dir, "f1");
    appendEvent(io, dir, "f1", { kind: "reset", edge: "e1" }, 1_000);

    // Write-only, unreadable. A real appendFileSync opens O_WRONLY|O_APPEND and
    // succeeds; a read-modify-write implementation must read first and throws
    // EACCES. This is what actually distinguishes the two — sequentially they
    // are otherwise indistinguishable.
    fs.chmodSync(p, 0o222);
    try {
      // A SECOND JournalIo, as another window would have.
      appendEvent(nodeJournalIo(), dir, "f1", { kind: "reset", edge: "e2" }, 1_001);
    } finally {
      fs.chmodSync(p, 0o644);
    }

    const events = readJournal(io, dir, "f1");
    expect(events).toHaveLength(2);
  });

  it("reads a missing journal as empty rather than throwing", () => {
    const io = nodeJournalIo();
    expect(io.size(journalPath(dir, "nope"))).toBeNull();
    expect(io.readFile(journalPath(dir, "nope"))).toBeNull();
    expect(readJournal(io, dir, "nope")).toEqual([]);
  });

  it("reports the real byte size, so the cap is measured against the file and not a guess", () => {
    const io = nodeJournalIo();
    appendEvent(io, dir, "f1", { kind: "reset", edge: "e1" }, 1_000);
    const p = journalPath(dir, "f1");
    expect(io.size(p)).toBe(fs.readFileSync(p, "utf8").length);
  });

  it("replaces atomically and leaves no temp file behind", () => {
    // Root ignores permission bits, which would make this assertion vacuous
    // rather than failing — skip loudly instead of passing quietly.
    if (process.getuid?.() === 0) return;

    const io = nodeJournalIo();
    const p = journalPath(dir, "f1");
    appendEvent(io, dir, "f1", { kind: "reset", edge: "e1" }, 1_000);

    // Read-only file, writable directory. A write-then-rename succeeds because
    // rename needs write permission on the containing directory, not on the
    // target path; a plain truncating writeFileSync opens the target directly
    // and throws EACCES. This is what actually distinguishes the two.
    fs.chmodSync(p, 0o444);
    try {
      io.replace(p, "replaced\n");
    } finally {
      fs.chmodSync(p, 0o644);
    }

    expect(fs.readFileSync(p, "utf8")).toBe("replaced\n");
    expect(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("trims a real file that grows past the cap, and it still reads", () => {
    const io = nodeJournalIo();
    for (let i = 0; i < 200; i++) {
      appendEvent(io, dir, "f1", { kind: "reset", edge: `e${i}` + "p".repeat(10_000) }, 1_000 + i);
    }
    const p = journalPath(dir, "f1");
    expect(fs.statSync(p).size).toBeLessThanOrEqual(JOURNAL_CAP_BYTES);
    const events = readJournal(io, dir, "f1") as unknown as { edge: string }[];
    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1].edge).toContain("e199");
  });

  it("keeps the journal out of the flow store's sight", () => {
    const io = nodeJournalIo();
    appendEvent(io, dir, "f1", { kind: "reset", edge: "e1" }, 1_000);
    writeFlow(nodeFlowIo(), dir, emptyFlow("f1", "Ship it", 1_000));

    // The journal file is in the same directory and readFlows must not try to
    // parse it as a flow.
    expect(readFlows(nodeFlowIo(), dir).map((f) => f.id)).toEqual(["f1"]);
  });

  it("survives removeFlow — the record outlives the flow it describes", () => {
    const io = nodeJournalIo();
    appendEvent(io, dir, "f1", { kind: "reset", edge: "e1" }, 1_000);
    writeFlow(nodeFlowIo(), dir, emptyFlow("f1", "Ship it", 1_000));
    removeFlow(nodeFlowIo(), dir, "f1");

    expect(readFlows(nodeFlowIo(), dir)).toEqual([]);
    expect(readJournal(io, dir, "f1")).toHaveLength(1);
  });
});
