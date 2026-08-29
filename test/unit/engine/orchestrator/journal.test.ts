import { describe, it, expect } from "vitest";
import {
  JournalIo, journalPath, createIdMinter, appendEvent, readJournal,
} from "../../../../src/engine/orchestrator/journal";

/** An in-memory JournalIo. `files` is the whole store. */
const fakeIo = (files: Record<string, string> = {}) => {
  const io: JournalIo = {
    append: (p, text) => { files[p] = (files[p] ?? "") + text; },
    size: (p) => (p in files ? files[p].length : null),
    readFile: (p) => files[p] ?? null,
    replace: (p, text) => { files[p] = text; },
  };
  return { io, files };
};

const DIR = "/store/flows";

describe("journalPath", () => {
  it("sits beside the flow file and does not end in .json, so readFlows cannot see it", () => {
    expect(journalPath(DIR, "f1x2-ab3c")).toBe("/store/flows/f1x2-ab3c.log.jsonl");
    expect(journalPath(DIR, "f1x2-ab3c").endsWith(".json")).toBe(false);
  });

  it("refuses an id that would resolve outside the directory", () => {
    expect(() => journalPath(DIR, "../../.zshrc")).toThrow(/invalid flow id/);
    expect(() => journalPath(DIR, "f1/f2")).toThrow(/invalid flow id/);
  });
});

describe("createIdMinter", () => {
  it("sorts lexically in the order events were minted, within one millisecond", () => {
    const mint = createIdMinter(() => 0.5);
    const a = mint(1_000);
    const b = mint(1_000);
    const c = mint(1_000);
    expect([c, a, b].sort()).toEqual([a, b, c]);
  });

  it("sorts a later millisecond after an earlier one", () => {
    const mint = createIdMinter(() => 0.5);
    const early = mint(1_000);
    const late = mint(2_000);
    expect(late > early).toBe(true);
  });

  it("restarts the within-millisecond sequence when the clock moves, and still sorts", () => {
    const mint = createIdMinter(() => 0.5);
    const a = mint(1_000);
    const b = mint(1_000);
    const c = mint(1_001);
    expect(a < b && b < c).toBe(true);
  });

  it("produces a fixed-width id, so lexical order is numeric order", () => {
    const mint = createIdMinter(() => 0.5);
    expect(mint(1_000)).toHaveLength(mint(999_999_999_999).length);
  });
});

describe("appendEvent / readJournal", () => {
  it("round-trips events in order, stamping id, at and flow", () => {
    const { io } = fakeIo();
    const mint = createIdMinter(() => 0.5);
    appendEvent(io, DIR, "f1", { kind: "armed", armed: true, source: "toggle" }, 1_000, mint);
    appendEvent(io, DIR, "f1", { kind: "reset", edge: "e7" }, 1_001, mint);

    const events = readJournal(io, DIR, "f1");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ at: 1_000, flow: "f1", kind: "armed", armed: true, source: "toggle" });
    expect(events[1]).toMatchObject({ at: 1_001, flow: "f1", kind: "reset", edge: "e7" });
    expect(events[0].id < events[1].id).toBe(true);
  });

  it("writes one newline-terminated line per event", () => {
    const { io, files } = fakeIo();
    appendEvent(io, DIR, "f1", { kind: "reset", edge: "e1" }, 1_000);
    appendEvent(io, DIR, "f1", { kind: "reset", edge: "e2" }, 1_001);
    const raw = files[journalPath(DIR, "f1")];
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.trimEnd().split("\n")).toHaveLength(2);
  });

  it("returns nothing for a flow that has no journal", () => {
    const { io } = fakeIo();
    expect(readJournal(io, DIR, "f1")).toEqual([]);
  });

  it("skips a line whose checksum no longer matches its content, and keeps its neighbours", () => {
    const { io, files } = fakeIo();
    appendEvent(io, DIR, "f1", { kind: "reset", edge: "e1" }, 1_000);
    appendEvent(io, DIR, "f1", { kind: "reset", edge: "TAMPERED" }, 1_001);
    appendEvent(io, DIR, "f1", { kind: "reset", edge: "e3" }, 1_002);
    const p = journalPath(DIR, "f1");
    // Rewrite the middle line's payload WITHOUT recomputing its sum.
    files[p] = files[p].replace('"edge":"TAMPERED"', '"edge":"e2xxxxxxx"');

    const events = readJournal(io, DIR, "f1");
    expect(events.map((e) => (e as { edge: string }).edge)).toEqual(["e1", "e3"]);
  });

  it("skips a line that is not JSON at all, and keeps its neighbours", () => {
    const { io, files } = fakeIo();
    appendEvent(io, DIR, "f1", { kind: "reset", edge: "e1" }, 1_000);
    const p = journalPath(DIR, "f1");
    files[p] += "{half a line, torn by a concurrent append\n";
    appendEvent(io, DIR, "f1", { kind: "reset", edge: "e3" }, 1_002);

    expect(readJournal(io, DIR, "f1").map((e) => (e as { edge: string }).edge)).toEqual(["e1", "e3"]);
  });

  it("skips a line with no checksum field at all", () => {
    const { io, files } = fakeIo();
    appendEvent(io, DIR, "f1", { kind: "reset", edge: "e1" }, 1_000);
    const p = journalPath(DIR, "f1");
    files[p] += JSON.stringify({ id: "X", at: 1, flow: "f1", kind: "reset", edge: "e2" }) + "\n";

    expect(readJournal(io, DIR, "f1").map((e) => (e as { edge: string }).edge)).toEqual(["e1"]);
  });

  it("keeps a line carrying a field this build does not know, so a newer build's journal still reads", () => {
    const { io, files } = fakeIo();
    appendEvent(io, DIR, "f1", { kind: "reset", edge: "e1" }, 1_000);
    const p = journalPath(DIR, "f1");
    // Same serializer, one extra field — the checksum must cover it rather than ignore it.
    appendEvent(io, DIR, "f1", { kind: "reset", edge: "e2", futureField: "x" } as never, 1_001);

    const events = readJournal(io, DIR, "f1");
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ edge: "e2", futureField: "x" });
    expect(files[p].split("\n").filter((l) => l.length > 0)).toHaveLength(2);
  });

  it("refuses to append under an id that would escape the directory", () => {
    const { io } = fakeIo();
    expect(() => appendEvent(io, DIR, "../../.zshrc", { kind: "reset", edge: "e1" }, 1_000)).toThrow(/invalid flow id/);
  });
});
