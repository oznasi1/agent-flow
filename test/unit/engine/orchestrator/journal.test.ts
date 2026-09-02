import { describe, it, expect } from "vitest";
import {
  JournalIo, journalPath, createIdMinter, appendEvent, readJournal, findEdgeOutput,
  truncateOutput, JOURNAL_CAP_BYTES, JOURNAL_TRIM_TO_BYTES, OUTPUT_HEAD_BYTES, OUTPUT_TAIL_BYTES,
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

describe("truncateOutput", () => {
  it("leaves an output that fits alone, with no marker", () => {
    const s = "deploying\nok\n";
    expect(truncateOutput(s)).toBe(s);
    expect(truncateOutput(s)).not.toContain("elided");
  });

  it("keeps the head and the tail and states how much went missing", () => {
    const head = "H".repeat(OUTPUT_HEAD_BYTES);
    const middle = "M".repeat(5_000);
    const tail = "T".repeat(OUTPUT_TAIL_BYTES);
    const out = truncateOutput(head + middle + tail);

    // The banner that says which command ran survives...
    expect(out.startsWith(head)).toBe(true);
    // ...and so does the stack trace at the end, which is what you actually read.
    expect(out.endsWith(tail)).toBe(true);
    expect(out).toContain("5000 bytes elided");
    expect(out).not.toContain("M");
  });

  it("is shorter than what it truncated, so the cap is actually defended", () => {
    const huge = "x".repeat(500_000);
    expect(truncateOutput(huge).length).toBeLessThan(huge.length);
    expect(truncateOutput(huge).length).toBeLessThan(OUTPUT_HEAD_BYTES + OUTPUT_TAIL_BYTES + 100);
  });
});

describe("the journal's byte cap", () => {
  /** One event whose serialised line is a known, large size. */
  const bigEvent = (edge: string) => ({ kind: "reset" as const, edge: edge + "p".repeat(10_000) });

  it("stays under the cap once it starts trimming", () => {
    const { io, files } = fakeIo();
    for (let i = 0; i < 200; i++) appendEvent(io, DIR, "f1", bigEvent(`e${i}`), 1_000 + i);
    expect(files[journalPath(DIR, "f1")].length).toBeLessThanOrEqual(JOURNAL_CAP_BYTES);
  });

  it("evicts the OLDEST events, keeping the newest", () => {
    const { io } = fakeIo();
    for (let i = 0; i < 200; i++) appendEvent(io, DIR, "f1", bigEvent(`e${i}`), 1_000 + i);

    const events = readJournal(io, DIR, "f1") as unknown as { edge: string }[];
    expect(events.length).toBeGreaterThan(0);
    expect(events.length).toBeLessThan(200);
    // The most recent event is always present; the first is long gone.
    expect(events[events.length - 1].edge).toContain("e199");
    expect(events.some((e) => e.edge.startsWith("e0p"))).toBe(false);
  });

  it("never leaves a partial line at the front — every surviving line still reads", () => {
    const { io, files } = fakeIo();
    for (let i = 0; i < 200; i++) appendEvent(io, DIR, "f1", bigEvent(`e${i}`), 1_000 + i);

    const raw = files[journalPath(DIR, "f1")];
    const lines = raw.split("\n").filter((l) => l.length > 0);
    // Nothing was dropped as unreadable: the trim cut on line boundaries only.
    expect(readJournal(io, DIR, "f1")).toHaveLength(lines.length);
  });

  it("does not trim a journal that fits", () => {
    const { io, files } = fakeIo();
    appendEvent(io, DIR, "f1", { kind: "reset", edge: "e1" }, 1_000);
    const afterFirst = files[journalPath(DIR, "f1")];
    appendEvent(io, DIR, "f1", { kind: "reset", edge: "e2" }, 1_001);
    // The first line is still there, byte for byte.
    expect(files[journalPath(DIR, "f1")].startsWith(afterFirst)).toBe(true);
  });

  /** A JournalIo that counts its rewrites, so a test can assert how OFTEN the
   * expensive read-rewrite-rename path runs, not merely that it runs. */
  const countingIo = () => {
    const files: Record<string, string> = {};
    let replaces = 0;
    const io: JournalIo = {
      append: (p, text) => { files[p] = (files[p] ?? "") + text; },
      size: (p) => (p in files ? files[p].length : null),
      readFile: (p) => files[p] ?? null,
      replace: (p, text) => { replaces += 1; files[p] = text; },
    };
    return { io, files, count: () => replaces };
  };

  it("cuts back to the low-water mark, not merely under the cap", () => {
    const { io, files, count } = countingIo();
    const p = journalPath(DIR, "f1");
    const afterATrim: number[] = [];
    let seen = 0;
    for (let i = 0; i < 200; i++) {
      appendEvent(io, DIR, "f1", bigEvent(`e${i}`), 1_000 + i);
      if (count() > seen) {
        seen = count();
        afterATrim.push(files[p].length);
      }
    }
    // The point of the low-water mark: a trim leaves real headroom, so the file
    // does not sit AT the cap paying a rewrite on every later append.
    expect(afterATrim.length).toBeGreaterThan(0);
    for (const size of afterATrim) expect(size).toBeLessThanOrEqual(JOURNAL_TRIM_TO_BYTES);
    expect(JOURNAL_TRIM_TO_BYTES).toBeLessThan(JOURNAL_CAP_BYTES);
  });

  it("amortizes the rewrite — appending after a trim does not trigger another one", () => {
    const { io, count } = countingIo();
    const appends = 200;
    for (let i = 0; i < appends; i++) appendEvent(io, DIR, "f1", bigEvent(`e${i}`), 1_000 + i);
    // Without a low-water mark the file settles at the cap and EVERY append past
    // that point rewrites the whole journal — roughly half of these 200. With one,
    // a rewrite buys ~250 KB of plain appends, so the count stays in single digits.
    expect(count()).toBeGreaterThan(0);
    expect(count()).toBeLessThan(appends / 10);
  });

  it("still writes a readable file when ONE event is bigger than the cap on its own", () => {
    const { io } = fakeIo();
    appendEvent(io, DIR, "f1", { kind: "reset", edge: "e1" }, 1_000);
    appendEvent(io, DIR, "f1", { kind: "reset", edge: "z".repeat(JOURNAL_CAP_BYTES + 1_000) }, 1_001);

    const events = readJournal(io, DIR, "f1") as unknown as { edge: string }[];
    // The oversized line is kept rather than silently dropped — losing the event
    // outright would be worse than exceeding the cap for one line.
    expect(events).toHaveLength(1);
    expect(events[0].edge.startsWith("z")).toBe(true);
  });
});

describe("findEdgeOutput", () => {
  // Built by hand rather than round-tripped through `appendEvent`/`readJournal`:
  // this function's contract is about the EVENT ARRAY, and the IO half already
  // has its own coverage above.
  const fired = (edge: string, output?: string) => ({
    id: "x", at: 1, flow: "f1", kind: "fired" as const,
    edge, from: "a", to: "z", action: "run", note: "",
    ...(output === undefined ? {} : { output }),
  });
  const errored = (edge: string, output?: string) => ({
    id: "y", at: 2, flow: "f1", kind: "errored" as const,
    edge, from: "a", to: "z", action: "run", error: "boom",
    ...(output === undefined ? {} : { output }),
  });

  it("reports no-journal for an empty event list — nothing at all has been recorded", () => {
    expect(findEdgeOutput([], "e1")).toEqual({ ok: false, reason: "no-journal" });
  });

  it("reports no-event when the journal has lines, but none naming this edge", () => {
    expect(findEdgeOutput([fired("e2", "hi")], "e1")).toEqual({ ok: false, reason: "no-event" });
  });

  it("reports no-output when the edge fired but the line carries no captured output", () => {
    expect(findEdgeOutput([fired("e1")], "e1")).toEqual({ ok: false, reason: "no-output" });
  });

  it("returns a fired edge's output, labelled fired", () => {
    expect(findEdgeOutput([fired("e1", "deployed ok")], "e1")).toEqual({ ok: true, output: "deployed ok", kind: "fired" });
  });

  it("returns an errored edge's output, labelled errored", () => {
    expect(findEdgeOutput([errored("e1", "stack trace")], "e1")).toEqual({ ok: true, output: "stack trace", kind: "errored" });
  });

  it("prefers the edge's LATEST fired/errored line even when an earlier one is the only one carrying output", () => {
    // A successful run's output, then a Reset, then a re-run that errored
    // without capturing any output. The drawer's own step now reads "fail",
    // and showing the earlier success's output under it would be exactly the
    // stale-but-plausible answer this function is built to refuse.
    const events = [
      fired("e1", "first run output"),
      { id: "r", at: 3, flow: "f1", kind: "reset" as const, edge: "e1" },
      errored("e1"),
    ];
    expect(findEdgeOutput(events, "e1")).toEqual({ ok: false, reason: "no-output" });
  });

  it("returns the latest event's own output when a Reset separates two runs that both captured one", () => {
    const events = [fired("e1", "old"), errored("e1", "new")];
    expect(findEdgeOutput(events, "e1")).toEqual({ ok: true, output: "new", kind: "errored" });
  });

  it("ignores other edges and non-fired/errored kinds when picking the latest", () => {
    const events = [
      fired("e2", "unrelated"),
      { id: "a", at: 1, flow: "f1", kind: "armed" as const, armed: true, source: "toggle" },
      fired("e1", "mine"),
    ];
    expect(findEdgeOutput(events, "e1")).toEqual({ ok: true, output: "mine", kind: "fired" });
  });
});
