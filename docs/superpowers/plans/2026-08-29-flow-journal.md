# Append-Only Flow Journal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every meaningful thing an armed flow does to an append-only `~/.agentflow/flows/<id>.log.jsonl`, so Reset stops destroying history and command output outlives the window.

**Architecture:** A new pure module `src/engine/orchestrator/journal.ts` serialises one checksummed JSON object per line over an injected `JournalIo`, exactly as `store.ts` does over `FlowIo`. Real filesystem access lives in `flowIo.ts` as `nodeJournalIo()`. `deckView.ts` gains one `private journal(...)` helper that never throws, called from eight sites that already compute the fact and currently only `this.log` it.

**Tech Stack:** TypeScript, Node (extension host only — no webview reach), Vitest, esbuild.

**Spec:** [docs/superpowers/specs/2026-08-29-flow-journal-design.md](../specs/2026-08-29-flow-journal-design.md)

## Global Constraints

- The CI gate is exactly `npm ci`, `npm run typecheck`, `npm test`, `npm run build`. All four must pass.
- `npm test` is ~4,500 tests across 122 files and takes 2+ minutes. Run it with a **600000 ms timeout**. **Never pipe vitest through `tail` or `head`** — it loses the failure list. A single failure under CPU contention is usually flake; re-run that file alone before believing it.
- Run a single file while iterating: `npx vitest run test/unit/engine/orchestrator/journal.test.ts`.
- **The existing suite must pass unmodified.** A test you had to edit to go green is the signal to stop. The one permitted edit is *adding* `nodeJournalIo` to the existing `vi.mock` of `flowIo` in `test/unit/deckView.test.ts` (Task 4) — that mock is a module stub, and a module stub missing a newly-exported member makes the import undefined at runtime.
- `test/unit/compat.test.ts` must be **untouched**: no new setting, no new command id, no new telemetry wire value, no change to the on-disk run or flow shape.
- **`journal.ts` must not import `fs` or `child_process`.** It may import `path`, exactly as `store.ts` does. All real IO lives in `flowIo.ts`.
- Coverage thresholds in `vitest.config.ts` are enforced by `npm run test:cov`: 90% lines/statements, 85% branches/functions.
- Vocabulary (`test/unit/vocabulary.test.ts`): a **session** is one run of a coding tool; an **agent** is a worker a session delegates to. Never call the tool "the agent" in a comment or string. Note the gate fires on standalone words, so avoid the bare word in new prose where "session" is meant.
- Every user-facing change gets an entry under `## [Unreleased]` in `CHANGELOG.md`.
- Git identity for every commit in this repo: `oznasi1 / oznasi1@gmail.com`. Pass it per-commit: `git -c user.name=oznasi1 -c user.email=oznasi1@gmail.com commit ...`.
- Work stays in this worktree. Do not `cd` to the original repository root.

---

### Task 1: The journal record — types, ids, checksums, read/write

**Files:**
- Create: `src/engine/orchestrator/journal.ts`
- Modify: `src/engine/orchestrator/store.ts` (export `VALID_FLOW_ID`)
- Test: `test/unit/engine/orchestrator/journal.test.ts`

**Interfaces:**
- Consumes: `VALID_FLOW_ID` from `store.ts`.
- Produces: `JournalIo`, `JournalEventInput`, `JournalEvent`, `journalPath(dir, flowId): string`, `createIdMinter(rand?): (nowMs: number) => string`, `appendEvent(io, dir, flowId, ev, nowMs, mint?): void`, `readJournal(io, dir, flowId): JournalEvent[]`. Task 2 adds trimming inside `appendEvent`; Task 3 implements `JournalIo` for real; Tasks 4–6 call `appendEvent`.

**Background the implementer needs:**

`store.ts` currently keeps `VALID_FLOW_ID` private. It must be exported and reused rather than copied — the journal builds a path from a flow id the same way `fileFor` does, and an id like `../../.zshrc` has to be refused in both places or the second one is a hole.

`readFlows` filters directory entries with `.endsWith(".json")`. `"f1.log.jsonl".endsWith(".json")` is **false**, so journal files are already invisible to the flow store. Do not add a filter.

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine/orchestrator/journal.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/engine/orchestrator/journal.test.ts`
Expected: FAIL — `Failed to resolve import ".../journal"`.

- [ ] **Step 3: Export `VALID_FLOW_ID` from the store**

In `src/engine/orchestrator/store.ts`, change the declaration to an export and extend its comment. Find:

```ts
const VALID_FLOW_ID = /^[A-Za-z0-9_-]+$/;
```

Replace with:

```ts
/** Exported so `journal.ts` builds its path from the SAME charset this store
 * builds `<id>.json` from. A second copy of this regex is a second place for a
 * traversal hole to open: the journal turns an id straight into a path too, and
 * two regexes that are equal today drift the moment either is widened. */
export const VALID_FLOW_ID = /^[A-Za-z0-9_-]+$/;
```

- [ ] **Step 4: Write the module**

Create `src/engine/orchestrator/journal.ts`:

```ts
// An append-only record of what an armed flow did, one line per event, beside
// the flow file it describes. This exists because the flow file IS the history:
// a rule's receipt lives on the edge that fired it, and `flow:resetEdge` clears
// exactly those fields so the rule can fire again. Reset a failed 2am deploy and
// the only evidence it ever ran is gone, along with everything it printed.
//
// Pure over an injected IO for the same reason `store.ts` is: the whole
// trim-and-recover story is testable from a plain object, with no temp directory
// and no real clock. `path` is the only import, exactly as in `store.ts` — this
// module is host-side and never reachable from a webview entry point.
import * as path from "path";
import { VALID_FLOW_ID } from "./store";

/** The only IO surface. `append` MUST open with `O_APPEND` so two windows writing
 * at once cannot overwrite each other's offset; `replace` MUST be atomic
 * (tmp-then-rename) so a crash mid-trim leaves the OLD complete journal rather
 * than a half-written one. `size` and `readFile` return null for anything they
 * cannot read — a journal that is missing reads as empty, never as an error. */
export interface JournalIo {
  append(p: string, text: string): void;
  size(p: string): number | null;
  readFile(p: string): string | null;
  replace(p: string, text: string): void;
}

/** What happened, without the fields every event gets. One member per thing a
 * pass can decide — including the three ways a rule can fail to fire, which are
 * the half of the story the flow file has never recorded at all. */
export type JournalEventInput =
  | { kind: "armed"; armed: boolean; source: string }
  | { kind: "consent-asked"; action: string; target: string }
  | { kind: "consented"; answer: string }
  | { kind: "fired"; edge: string; from: string; to: string; action: string; note: string; output?: string }
  | { kind: "errored"; edge: string; from: string; to: string; action: string; error: string; output?: string }
  | { kind: "deferred"; edge: string; reason: string }
  | { kind: "skipped"; edge: string; reason: "disarmed-mid-pass" | "lock-lost" }
  | { kind: "promoted"; node: string; runKey: string; repo: string }
  | { kind: "reset"; edge: string };

/** An event as it sits on disk, minus `sum` — which is a property of the LINE,
 * not of the event, and is consumed by `readJournal` rather than handed on. */
export type JournalEvent = JournalEventInput & { id: string; at: number; flow: string };

/** Crockford base32 — no I, L, O or U, so an id read aloud or copied out of a log
 * cannot be transcribed into a different one. */
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function b32(n: number, width: number): string {
  let out = "";
  let v = Math.max(0, Math.floor(n));
  for (let i = 0; i < width; i++) {
    out = B32[v % 32] + out;
    v = Math.floor(v / 32);
  }
  return out;
}

/** Mint sortable ids. ULID-shaped: a fixed-width millisecond timestamp, then a
 * within-millisecond sequence, then a random tail.
 *
 * FIXED WIDTH is the load-bearing part — lexical order is only numeric order when
 * every id is the same length, and a shorter id for an earlier clock would sort
 * AFTER a longer one for a later clock.
 *
 * The sequence is why this is a factory returning a closure rather than a plain
 * function: two events in the same millisecond are ordinary (a pass stamps a whole
 * junction at once) and `at` alone cannot order them. Module-level counter state
 * would make every test order-dependent on every other; a closure is state the
 * caller owns and a test can create fresh. */
export function createIdMinter(rand: () => number = Math.random): (nowMs: number) => string {
  let lastMs = -1;
  let seq = 0;
  return (nowMs: number) => {
    const ms = Math.max(0, Math.floor(nowMs));
    if (ms === lastMs) seq += 1;
    else {
      lastMs = ms;
      seq = 0;
    }
    return b32(ms, 10) + b32(seq, 4) + b32(Math.floor(rand() * 1024), 2);
  };
}

/** The panel's minter. One per process, so the sequence actually counts across
 * every flow this window journals. */
const defaultMint = createIdMinter();

/** The fields a line writes first, in this order, so the common ones line up when
 * a human reads the file. Anything NOT listed still rides along, sorted, after
 * them — a line written by a newer build with a field this one has never heard of
 * must still checksum correctly here, or an older build would silently discard
 * every event a newer one wrote. */
const FIELD_ORDER = [
  "id", "at", "flow", "kind",
  "armed", "source", "action", "target", "answer",
  "edge", "from", "to", "note", "error", "reason",
  "node", "runKey", "repo", "output",
];

/** The line's payload, with keys in a deterministic order. Both the writer and
 * the verifier build the string this way, which is what makes the checksum
 * reproducible without depending on JSON key order surviving a parse. */
function canonicalJson(ev: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const k of FIELD_ORDER) if (ev[k] !== undefined) out[k] = ev[k];
  for (const k of Object.keys(ev).sort()) if (!(k in out) && ev[k] !== undefined) out[k] = ev[k];
  return JSON.stringify(out);
}

/** FNV-1a, 32-bit, hex. NOT a tamper defence — a TORN-WRITE defence. `O_APPEND`
 * makes the write OFFSET atomic but not an 8 KB payload, so two windows appending
 * a large command output can interleave their bytes and leave a line that parses
 * as JSON while describing an event that never happened. A line whose checksum
 * does not match its content is skipped on read, which is the posture `readFlows`
 * already takes toward a corrupt flow file: one bad record costs that record. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Where a flow's journal lives. `.log.jsonl` and not `.jsonl` alone so the file
 * is obviously paired with `<id>.json`, and — checked by a test — so it does not
 * end in `.json`, which is the extension `readFlows` scans for. If that ever
 * changed, every journal would be parsed as a flow and dropped as malformed.
 *
 * The id charset check is the same one `fileFor` (store.ts) makes, from the same
 * exported regex, because this function turns an id straight into a path too. */
export function journalPath(dir: string, flowId: string): string {
  if (!VALID_FLOW_ID.test(flowId)) throw new Error(`invalid flow id: ${JSON.stringify(flowId)}`);
  return path.join(dir, `${flowId}.log.jsonl`);
}

function serialize(ev: Record<string, unknown>): string {
  const body = canonicalJson(ev);
  // Spliced in rather than added to the object, so `sum` is always last and the
  // canonical form it was computed over never contains itself.
  return `${body.slice(0, -1)},"sum":"${fnv1a(body)}"}`;
}

/** Record one event. Appends a single newline-terminated line.
 *
 * `mint` is injectable so a test gets deterministic, assertable ids; production
 * uses the one process-wide minter. */
export function appendEvent(
  io: JournalIo,
  dir: string,
  flowId: string,
  ev: JournalEventInput,
  nowMs: number,
  mint: (nowMs: number) => string = defaultMint,
): void {
  const p = journalPath(dir, flowId);
  const line = serialize({ id: mint(nowMs), at: nowMs, flow: flowId, ...ev }) + "\n";
  io.append(p, line);
}

/** Every event in a flow's journal, oldest first — which is simply write order,
 * because the file is append-only.
 *
 * A line that does not parse, or whose checksum does not match, is SKIPPED rather
 * than fatal: the point of a post-mortem record is to survive the crash that
 * produced it, and a torn final line must not cost the hundred good lines above
 * it. Same house rule as `readFlows`: one bad record costs one record. */
export function readJournal(io: JournalIo, dir: string, flowId: string): JournalEvent[] {
  const text = io.readFile(journalPath(dir, flowId));
  if (text === null) return [];
  const out: JournalEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const { sum, ...rest } = parsed;
      if (typeof sum !== "string" || fnv1a(canonicalJson(rest)) !== sum) continue;
      out.push(rest as unknown as JournalEvent);
    } catch {
      /* a torn or hand-mangled line costs that line, never the journal */
    }
  }
  return out;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/unit/engine/orchestrator/journal.test.ts`
Expected: PASS, all cases.

- [ ] **Step 6: Confirm the store still passes and types check**

Run: `npx vitest run test/unit/engine/orchestrator/store.test.ts`
Expected: PASS (the export is additive).

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 7: Mutation-check the two claims that matter**

These two tests are the ones most likely to be vacuous. Prove they are not, one at a time, reverting after each:

1. In `journal.ts`, change `fnv1a`'s return to `return "00000000";`. Run the file. Expected: the "skips a line whose checksum no longer matches" test FAILS (a constant sum matches everything). Revert.
2. In `createIdMinter`, change `b32(ms, 10)` to `String(ms)`. Run the file. Expected: "produces a fixed-width id" FAILS. Revert.

Run after reverting: `npx vitest run test/unit/engine/orchestrator/journal.test.ts` — PASS.

- [ ] **Step 8: Commit**

```bash
git add src/engine/orchestrator/journal.ts src/engine/orchestrator/store.ts test/unit/engine/orchestrator/journal.test.ts
git -c user.name=oznasi1 -c user.email=oznasi1@gmail.com commit -m "feat(orchestrator): add the flow journal record and its reader

One checksummed JSON object per line beside each flow file. The checksum
is a torn-write defence, not a tamper defence: O_APPEND makes the offset
atomic but not an 8 KB payload, so two windows can interleave. A bad line
costs that line, the same house rule readFlows already keeps.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The byte cap and command-output truncation

**Files:**
- Modify: `src/engine/orchestrator/journal.ts`
- Test: `test/unit/engine/orchestrator/journal.test.ts`

**Interfaces:**
- Consumes: `JournalIo`, `appendEvent`, `journalPath` from Task 1.
- Produces: `JOURNAL_CAP_BYTES: number`, `OUTPUT_HEAD_BYTES: number`, `OUTPUT_TAIL_BYTES: number`, `truncateOutput(s: string): string`. Task 4 calls `truncateOutput`.

**Why this is its own task:** the cap is what makes "the journal survives `removeFlow`" affordable — a `run` edge can emit a large output every six seconds, and an uncapped file grows without bound for a flow nobody is watching. Truncation is what stops one verbose deploy from evicting a flow's entire history under that cap, so the two belong together and neither is useful alone.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/engine/orchestrator/journal.test.ts`. Extend the import at the top of the file to:

```ts
import {
  JournalIo, journalPath, createIdMinter, appendEvent, readJournal,
  truncateOutput, JOURNAL_CAP_BYTES, OUTPUT_HEAD_BYTES, OUTPUT_TAIL_BYTES,
} from "../../../../src/engine/orchestrator/journal";
```

Then add:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/engine/orchestrator/journal.test.ts`
Expected: FAIL — `truncateOutput is not a function` / `JOURNAL_CAP_BYTES` undefined, and the cap tests fail because nothing trims.

- [ ] **Step 3: Add the constants, the truncator and the trim**

In `src/engine/orchestrator/journal.ts`, add after the `JournalIo` interface:

```ts
/** How large one flow's journal may grow. A `run` edge can emit output every six
 * seconds and the journal deliberately OUTLIVES its flow (`removeFlow` deletes
 * `<id>.json` only), so "append-only, forever" is a disk leak on an unattended
 * machine. The trade-off is stated rather than hidden: a sufficiently chatty flow
 * does lose its oldest history.
 *
 * Capped by BYTES rather than by line count because a single command output can
 * be larger than a hundred ordinary events — a line cap would bound the wrong
 * quantity and leave the real one unbounded. */
export const JOURNAL_CAP_BYTES = 1_000_000;

/** How much of a command's output each end of a truncated record keeps. The head
 * carries which command actually ran; the tail carries the failure. The middle is
 * what a person scrolls past. */
export const OUTPUT_HEAD_BYTES = 4_000;
export const OUTPUT_TAIL_BYTES = 4_000;
```

Add, after `journalPath`:

```ts
/** A command's stdout+stderr, cut to fit. Without this one verbose deploy evicts
 * a flow's entire history under `JOURNAL_CAP_BYTES`, which would make the cap
 * self-defeating: the point of trimming is to keep MORE history, not to spend it
 * all on one run.
 *
 * The elision is explicit in the stored text so nobody mistakes a truncated log
 * for a complete one and concludes the command printed nothing in between. */
export function truncateOutput(s: string): string {
  if (s.length <= OUTPUT_HEAD_BYTES + OUTPUT_TAIL_BYTES) return s;
  const elided = s.length - OUTPUT_HEAD_BYTES - OUTPUT_TAIL_BYTES;
  return `${s.slice(0, OUTPUT_HEAD_BYTES)}\n… ${elided} bytes elided …\n${s.slice(s.length - OUTPUT_TAIL_BYTES)}`;
}

/** Make room for `incoming` bytes by dropping WHOLE lines from the front.
 *
 * Whole lines only: half a JSON object at the head of the file is a line
 * `readJournal` would skip anyway, so cutting mid-line would silently cost an
 * extra event on top of the ones the cap already claims.
 *
 * `replace` rather than a truncating write, because it is atomic: a crash between
 * emptying the file and refilling it would otherwise destroy the entire journal
 * to save a few kilobytes.
 *
 * An incoming line larger than the cap ALL BY ITSELF empties the file and is then
 * appended anyway. That is deliberate — exceeding the cap for one line is better
 * than dropping an event on the floor, and the alternative (refusing the write)
 * would silently lose exactly the enormous failure someone most wants to read. */
function trimFor(io: JournalIo, p: string, incoming: number): void {
  const size = io.size(p);
  if (size === null || size + incoming <= JOURNAL_CAP_BYTES) return;
  const text = io.readFile(p);
  if (text === null) return;
  const lines = text.split("\n").filter((l) => l.length > 0);
  let bytes = lines.reduce((n, l) => n + l.length + 1, 0);
  let first = 0;
  while (first < lines.length && bytes + incoming > JOURNAL_CAP_BYTES) {
    bytes -= lines[first].length + 1;
    first += 1;
  }
  const kept = lines.slice(first);
  io.replace(p, kept.length > 0 ? kept.join("\n") + "\n" : "");
}
```

Then call it from `appendEvent`, between building the line and appending it:

```ts
  const line = serialize({ id: mint(nowMs), at: nowMs, flow: flowId, ...ev }) + "\n";
  trimFor(io, p, line.length);
  io.append(p, line);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/engine/orchestrator/journal.test.ts`
Expected: PASS, all cases from Tasks 1 and 2.

- [ ] **Step 5: Mutation-check the trim**

Prove the cap tests are not vacuous, reverting after each:

1. Comment out the `trimFor(io, p, line.length);` call. Run the file. Expected: "stays under the cap" and "evicts the OLDEST events" both FAIL. Revert.
2. Change `trimFor` to drop from the END instead — `const kept = lines.slice(0, lines.length - first);`. Run the file. Expected: "evicts the OLDEST events" FAILS (it keeps `e0` and loses `e199`). Revert.
3. In `truncateOutput`, return `s.slice(0, OUTPUT_HEAD_BYTES)` (head only). Run the file. Expected: "keeps the head and the tail" FAILS. Revert.

Run after reverting: `npx vitest run test/unit/engine/orchestrator/journal.test.ts` — PASS.

- [ ] **Step 6: Commit**

```bash
git add src/engine/orchestrator/journal.ts test/unit/engine/orchestrator/journal.test.ts
git -c user.name=oznasi1 -c user.email=oznasi1@gmail.com commit -m "feat(orchestrator): cap the flow journal and truncate command output

The journal outlives its flow, so append-only forever is a disk leak.
1 MB per file, oldest whole lines evicted first through an atomic
replace. Command output is cut head+tail to 8 KB so one verbose deploy
cannot spend a flow's entire history on itself.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The real filesystem implementation

**Files:**
- Modify: `src/engine/orchestrator/flowIo.ts`
- Test: `test/unit/engine/orchestrator/flowIo.test.ts`

**Interfaces:**
- Consumes: `JournalIo`, `appendEvent`, `readJournal`, `journalPath`, `JOURNAL_CAP_BYTES` from Tasks 1–2.
- Produces: `nodeJournalIo(): JournalIo`. Task 4 constructs it in `DeckPanel`.

**Background:** `flowIo.ts` is the one file in `src/engine/orchestrator/` allowed to import `fs`. `flowIo.test.ts` already tests `nodeFlowIo` against a real temp directory created with `fs.mkdtempSync` in `beforeEach` and removed in `afterEach` — follow that exact pattern.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/engine/orchestrator/flowIo.test.ts`. Extend the imports at the top:

```ts
import { nodeFlowIo, newFlowId, nodeLockIo, nodeJournalIo } from "../../../../src/engine/orchestrator/flowIo";
import {
  appendEvent, readJournal, journalPath, JOURNAL_CAP_BYTES,
} from "../../../../src/engine/orchestrator/journal";
```

Then add:

```ts
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
    const io = nodeJournalIo();
    appendEvent(io, dir, "f1", { kind: "reset", edge: "e1" }, 1_000);
    // A SECOND JournalIo, as another window would have.
    appendEvent(nodeJournalIo(), dir, "f1", { kind: "reset", edge: "e2" }, 1_001);

    expect(readJournal(io, dir, "f1")).toHaveLength(2);
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
    const io = nodeJournalIo();
    const p = journalPath(dir, "f1");
    appendEvent(io, dir, "f1", { kind: "reset", edge: "e1" }, 1_000);
    io.replace(p, "replaced\n");

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/engine/orchestrator/flowIo.test.ts`
Expected: FAIL — `nodeJournalIo is not a function`.

- [ ] **Step 3: Implement `nodeJournalIo`**

In `src/engine/orchestrator/flowIo.ts`, extend the import line:

```ts
import { JournalIo } from "./journal";
```

and add at the end of the file:

```ts
/** The journal's real IO. `appendFileSync` is the whole point: it opens with
 * `O_APPEND`, so two windows writing at once cannot land on the same offset and
 * silently overwrite each other's events. It is not a full concurrency guarantee
 * — a payload larger than the pipe buffer can still interleave, which is why
 * every line carries a checksum and `readJournal` skips the ones that fail it.
 *
 * `replace` is write-then-rename rather than a truncating write, because a crash
 * between the two would otherwise leave an empty journal where a full one was.
 * `rename` over an existing path is atomic within a filesystem, and the temp file
 * is a sibling so it never crosses one.
 *
 * Both reads degrade to `null` rather than throwing, exactly as `nodeFlowIo`'s
 * do: a journal that cannot be read must cost the history, never the pass that
 * was trying to record into it. */
export function nodeJournalIo(): JournalIo {
  return {
    append: (p, text) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.appendFileSync(p, text);
    },
    size: (p) => {
      try {
        return fs.statSync(p).size;
      } catch {
        return null;
      }
    },
    readFile: (p) => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    replace: (p, text) => {
      const tmp = `${p}.tmp`;
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, p);
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/engine/orchestrator/flowIo.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the webview build is unaffected**

`journal.ts` imports `path`, so it must never become reachable from a browser entry point. It currently is not — nothing in `src/webview/` imports it — but the build is the only real gate:

Run: `npm run build`
Expected: exit 0, four bundles written.

Run: `npx vitest run test/webview/webviewGraph.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/engine/orchestrator/flowIo.ts test/unit/engine/orchestrator/flowIo.test.ts
git -c user.name=oznasi1 -c user.email=oznasi1@gmail.com commit -m "feat(orchestrator): add nodeJournalIo, the journal's filesystem seam

appendFileSync for O_APPEND, statSync for the cap, and a
write-then-rename replace so a crash mid-trim cannot empty a journal.
Both reads degrade to null: a journal that cannot be read costs the
history, never the pass trying to record into it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Journal what a pass DID — fired, errored, promoted

**Files:**
- Modify: `src/deckView.ts` (`EdgeDone` at ~336-342; `performRun` at ~1661; the panel's IO fields at ~518-523; the acting loop and the write site in `advanceUnderLock` at ~1005-1170)
- Test: `test/unit/deckView.test.ts`

**Interfaces:**
- Consumes: `nodeJournalIo` (Task 3), `appendEvent`, `truncateOutput`, `JournalEventInput` (Tasks 1–2).
- Produces: `DeckPanel`'s `private journal(flowId, ev, nowMs): void`, and `EdgeDone.output?: string`. Tasks 5 and 6 call `this.journal`.

**Background the implementer needs:**

1. `performRun` currently **drops** `outcome.output` — `runCommand` returns it, the code reads it only to decide whether the toast should mention the output channel, and `EdgeDone` has nowhere to carry it. Adding `output?: string` to `EdgeDone` is what makes the spec's "command output outlives the window" true.
2. The acting loop already collects `outcomes`, `promotions` and `receipts` into per-pass maps and writes once at the end via `writeFlow(this.flowIo, this.flowsDir, next)`. Journal lines go **after** that write, so a crash between them loses a line rather than inventing an event the flow file has no stamp for.
3. Branch on `f.action` (the action evaluation decided and carried on the `FiredEdge`), never on `e.action` — for the same reason `applyFired` documents at length: a concurrent edit can make the two disagree, and the journal must record the verb that actually ran.
4. The panel's IO fields are `private readonly flowIo = nodeFlowIo();` and `private readonly lockIo = nodeLockIo(...)` around line 518. Add the journal's beside them.

- [ ] **Step 1: Add `nodeJournalIo` to the test file's module mock**

This is the one permitted edit to an existing test. In `test/unit/deckView.test.ts`, the `vi.mock("../../src/engine/orchestrator/flowIo", ...)` factory (~line 440) must gain the new export, or the panel's `nodeJournalIo()` call is `undefined()` at construction and every flow test dies.

Add to the harness object `h` (near `lockIoLog`, ~line 207):

```ts
  // Every journal line this pass wrote, in order. A recording fake rather than a
  // spy on the module: the panel is meant to survive a journal that throws, and
  // that is only testable if the IO itself is the thing under the test's control.
  journalLines: [] as string[],
  journalThrows: false,
```

Reset it in the `beforeEach` that already clears `h.lockIoLog` (~line 785):

```ts
  h.journalLines = [];
  h.journalThrows = false;
```

Add to the `vi.mock` factory for `flowIo`:

```ts
  nodeJournalIo: () => ({
    append: (_p: string, text: string) => {
      if (h.journalThrows) throw new Error("ENOSPC");
      h.journalLines.push(text.trimEnd());
    },
    size: () => null,
    readFile: () => null,
    replace: () => {},
  }),
```

Add this helper near the other test helpers (`posts`, `show`, ~line 649):

```ts
/** The journal events this pass recorded, parsed. Order is write order. */
const journal = () => h.journalLines.map((l) => JSON.parse(l) as Record<string, unknown>);
```

- [ ] **Step 2: Write the failing test**

Add to `test/unit/deckView.test.ts`, in the same `describe` block as the existing test **"promotes the launched node and stamps the edge in ONE write"** (~line 6887). Build each fixture by copying that neighbouring test's setup verbatim and changing only what the assertion needs.

```ts
  it("journals a fired rule with the verb evaluation decided, after the flow is written", async () => {
    // Fixture: copy the setup from "promotes the launched node and stamps the
    // edge in ONE write" — an armed flow with launchConfirmedAt set and one met
    // launch rule — then assert on the journal instead of the write.
    // ... setup ...
    const fired = journal().filter((e) => e.kind === "fired");
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ kind: "fired", action: "launch", edge: "e1", from: "n1", to: "n2" });
    expect(fired[0].note).toEqual(expect.stringContaining("launched"));
  });

  it("journals the promotion alongside the rule that caused it", async () => {
    // Same fixture as above.
    const promoted = journal().filter((e) => e.kind === "promoted");
    expect(promoted).toHaveLength(1);
    expect(promoted[0]).toMatchObject({ kind: "promoted", node: "n2" });
  });

  it("journals a failed launch as errored, carrying the reason the edge was latched with", async () => {
    // Fixture: copy "stamps an error and promotes nothing when the launch fails,
    // and never retries it" (~line 6957).
    const errored = journal().filter((e) => e.kind === "errored");
    expect(errored).toHaveLength(1);
    expect(errored[0]).toMatchObject({ kind: "errored", action: "launch", edge: "e1" });
    expect(errored[0].error).toBeTruthy();
    expect(journal().some((e) => e.kind === "fired")).toBe(false);
  });

  it("journals a run rule's command output, which the flow file has never carried", async () => {
    // Fixture: an armed flow with commandConfirmedAt set and one met command
    // rule — copy the nearest existing command-rule test's setup, and make the
    // stubbed command runner resolve with a distinctive stdout.
    const fired = journal().filter((e) => e.kind === "fired");
    expect(fired).toHaveLength(1);
    expect(fired[0].output).toEqual(expect.stringContaining("deploying to staging"));
  });

  it("journals nothing at all for a pass in which no rule was decided", async () => {
    // Fixture: copy "writes nothing and says nothing when EVERY rule defers"
    // (~line 7029) and assert no fired/errored/promoted line was written.
    expect(journal().filter((e) => ["fired", "errored", "promoted"].includes(e.kind as string))).toEqual([]);
  });

  it("keeps firing when the journal itself is broken — a lost record is not a lost deploy", async () => {
    h.journalThrows = true;
    // Fixture: the same armed-and-confirmed launch flow as the first test here.
    // The flow must still be written and the launch must still have happened.
    expect(h.launchPlanned).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("flow journal unavailable"));
  });

  it("says the journal is unavailable ONCE, not once per rule", async () => {
    h.journalThrows = true;
    // Fixture: an armed flow with TWO met rules into different targets.
    const complaints = log.mock.calls.flat().filter((m) => String(m).includes("flow journal unavailable"));
    expect(complaints).toHaveLength(1);
  });
```

> **Note for the implementer:** the `// ... setup ...` lines are the ONLY place you write code that is not given here, and you write it by copying the named neighbouring test's fixture. Do not invent a new fixture shape — if the named test's setup does not produce the state the assertion needs, say so and stop rather than adjusting the assertion.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run test/unit/deckView.test.ts -t "journal"`
Expected: FAIL — the journal is empty because nothing writes to it.

> `deckView.test.ts` is the file that has previously OOMed a worker and reported "156/157 + 0 failures". The heap is pinned in `vitest.config.ts`, but pass `NODE_OPTIONS` explicitly if you see a worker die without a failure list.

- [ ] **Step 4: Carry the command output out of `performRun`**

In `src/deckView.ts`, extend `EdgeDone` (~line 336):

```ts
interface EdgeDone {
  kind: "done";
  outcome: ActOutcome;
  promote?: { nodeId: string; runKey: string; repo: string };
  receipt?: { level: "success" | "error"; message: string };
  /** A command's stdout+stderr, for the journal. `ActOutcome` cannot carry it:
   * that type is what `applyFired` stamps onto the edge, and an edge receipt is
   * one sentence by design. Before this field existed the output reached the
   * output channel and nowhere else, so it died with the window — which is the
   * whole reason the journal exists. Only a `run` sets it. */
  output?: string;
}
```

In `performRun`, add `output: outcome.output` to **both** returns:

```ts
      return {
        kind: "done",
        outcome: { ok: false, error: outcome.message },
        receipt: { level: "error", message },
        output: outcome.output,
      };
```

```ts
    return {
      kind: "done",
      outcome: { ok: true, note: `ran ${outcome.label} in ${where.repo}` },
      receipt: { level: "success", message: `${flow.name}: ran ${outcome.label} in ${where.repo}.` },
      output: outcome.output,
    };
```

- [ ] **Step 5: Give the panel a journal that cannot throw**

Extend the imports at the top of `src/deckView.ts`:

```ts
import { nodeFlowIo, nodeLockIo, newFlowId, nodeJournalIo } from "./engine/orchestrator/flowIo";
import { appendEvent, truncateOutput, JournalEventInput } from "./engine/orchestrator/journal";
```

Beside `flowIo` and `lockIo` (~line 519):

```ts
  private readonly journalIo = nodeJournalIo();
  /** Whether the journal has already failed once this session. The complaint is
   * worth making, but a broken journal fails on every event of every pass — six
   * seconds apart, forever — and an output channel full of one repeated line is
   * how the useful lines get lost. */
  private journalFailed = false;
```

And the helper, next to the other private flow methods:

```ts
  /** Record one event, and NEVER throw. The journal observes a pass; it does not
   * participate in one. A full disk, a permissions error or a bug in the trim
   * must not stop a deploy rule from firing — a missing line is a lost record, an
   * aborted pass is a lost deploy, and only one of those is recoverable by
   * looking again in six seconds. */
  private journal(flowId: string, ev: JournalEventInput, nowMs: number): void {
    try {
      appendEvent(this.journalIo, this.flowsDir, flowId, ev, nowMs);
    } catch (e) {
      if (this.journalFailed) return;
      this.journalFailed = true;
      this.log(
        `deck: flow journal unavailable — ${(e as Error).message}. Flows keep running; their history is not being recorded.`,
      );
    }
  }
```

- [ ] **Step 6: Collect the outputs and journal after the write**

In `advanceUnderLock`, beside the existing `const outcomes = new Map<string, ActOutcome>();`:

```ts
        // Kept separate from `outcomes` rather than folded into it: `outcomes` is
        // what `applyFired` stamps onto the edge, and an edge receipt is one
        // sentence. The output is for the journal alone.
        const outputs = new Map<string, string>();
```

In the acting loop, immediately after `outcomes.set(f.edge.id, done.outcome);`:

```ts
          if (done.output !== undefined && done.output.length > 0) {
            outputs.set(f.edge.id, truncateOutput(done.output));
          }
```

And immediately **after** `writeFlow(this.flowIo, this.flowsDir, next);`:

```ts
        // AFTER the write, never before. A crash in between loses a line rather
        // than inventing an event the flow file has no stamp for — the same
        // direction as this loop's act-then-record trade-off above. A missing
        // line is visibly missing; a false one is not.
        //
        // Read off `next` (what was actually written) but keyed by `stamping`,
        // and the verb comes from `f.action` — the action EVALUATION decided —
        // never from `e.action`, for the reason `applyFired` gives: a concurrent
        // edit can make the two disagree, and the journal must say what ran.
        for (const f of stamping) {
          const e = next.edges.find((x) => x.id === f.edge.id);
          if (!e) continue;
          const output = outputs.get(f.edge.id);
          const action = f.action ?? "unknown";
          if (e.error !== undefined) {
            this.journal(flow.id, {
              kind: "errored", edge: e.id, from: e.from, to: e.to, action, error: e.error,
              ...(output === undefined ? {} : { output }),
            }, nowMs);
          } else if (e.firedAt !== undefined) {
            this.journal(flow.id, {
              kind: "fired", edge: e.id, from: e.from, to: e.to, action, note: e.firedNote ?? "",
              ...(output === undefined ? {} : { output }),
            }, nowMs);
          }
        }
        for (const p of promotions) {
          this.journal(flow.id, { kind: "promoted", node: p.nodeId, runKey: p.runKey, repo: p.repo }, nowMs);
        }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run test/unit/deckView.test.ts -t "journal"`
Expected: PASS.

Then the whole file, to prove nothing else moved:
Run: `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run test/unit/deckView.test.ts`
Expected: PASS, with no test edited beyond the mock additions in Step 1.

- [ ] **Step 8: Mutation-check the ordering claim**

Move the journal block from after `writeFlow` to before it. Run the file. Expected: every journal test still passes — which proves the tests do **not** pin the ordering. Add one that does, then revert the move:

```ts
  it("writes the flow BEFORE it journals, so a crash cannot invent an event", async () => {
    const order: string[] = [];
    h.writeFlowCalled = () => order.push("write");
    // Record from the journal fake too — push "journal" in h's append.
    // Fixture: the armed-and-confirmed launch flow.
    expect(order).toEqual(["write", "journal"]);
  });
```

> If the harness has no `writeFlow` hook, record the order inside the existing `nodeFlowIo` mock's `writeFile` instead. Do not skip this step — ordering is the one property of this task that nothing else checks.

Revert the mutation and run the file again: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/deckView.ts test/unit/deckView.test.ts
git -c user.name=oznasi1 -c user.email=oznasi1@gmail.com commit -m "feat(deck): journal what an armed pass did

fired, errored and promoted, appended after the flow write so a crash
loses a line rather than inventing an event. EdgeDone now carries a run
edge's output, which performRun previously dropped on the floor — it
reached the output channel and died with the window.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Journal what a pass did NOT do — deferred, skipped, consent-asked

**Files:**
- Modify: `src/deckView.ts` (`advanceUnderLock`: the `asks.push` branch ~968, the `!stillArmed` branch ~1026, the `lostLock` branch ~1089, the `done.kind === "defer"` branch ~1100)
- Test: `test/unit/deckView.test.ts`

**Interfaces:**
- Consumes: `this.journal` (Task 4).
- Produces: nothing new.

**Why this is its own task:** Task 4 covers "what ran". This covers the other half — the four distinct reasons a rule can sit there doing nothing, each currently a `this.log` line in a channel nobody was watching. A reviewer could reasonably accept one and reject the other.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/deckView.test.ts`, near the existing tests named in each comment:

```ts
  it("journals a deferred rule with the reason, so a silently-stalled flow is diagnosable", async () => {
    // Fixture: copy "still stamps the rules that DID decide when one of them
    // defers" (~line 7059).
    const deferred = journal().filter((e) => e.kind === "deferred");
    expect(deferred).toHaveLength(1);
    expect(deferred[0]).toMatchObject({ kind: "deferred" });
    expect(deferred[0].reason).toBeTruthy();
  });

  it("journals a rule skipped because the flow was disarmed mid-pass", async () => {
    // Fixture: copy "stops a later acting edge in the same pass once the flow is
    // disarmed mid-pass" (~line 7324).
    const skipped = journal().filter((e) => e.kind === "skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ kind: "skipped", reason: "disarmed-mid-pass" });
  });

  it("journals a rule skipped because this window lost the flows lock", async () => {
    // Fixture: an armed flow with two met acting rules where h.renew is made to
    // answer false after the first — copy whichever existing test drives that.
    //
    // TWO sites emit lock-lost and they are both correct: the rule that WAS the
    // last step (journalled where `renew` answered false) and every rule the
    // `if (lostLock)` guard then skipped. So this asserts the reason and the
    // specific edges, not a count — the count is a property of the fixture.
    const skipped = journal().filter((e) => e.kind === "skipped");
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.every((e) => e.reason === "lock-lost")).toBe(true);
    // The rule that never got its turn is recorded, which is the point.
    expect(skipped.map((e) => e.edge)).toContain("e2");
  });

  it("journals the question a pass asked instead of spending", async () => {
    // Fixture: copy "stamps launchConfirmedAt on Launch and lets the NEXT pass
    // act" (~line 6767) and assert on the pass that ASKED.
    const asked = journal().filter((e) => e.kind === "consent-asked");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ kind: "consent-asked", action: "launch" });
    // A pass that asks performs nothing, so it must claim nothing.
    expect(journal().some((e) => e.kind === "fired")).toBe(false);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run test/unit/deckView.test.ts -t "journal"`
Expected: FAIL — four new cases, each finding an empty array.

- [ ] **Step 3: Add the four call sites**

In `src/deckView.ts`, in the `asks.push` branch, immediately before `asks.push({ flow: fresh, target: wantsSpend });`:

```ts
          // The question is the only thing that happened this pass, and it is the
          // one event the flow file cannot record: consent lands on a flow-level
          // field only if the user says yes, so an unanswered ask leaves no trace
          // at all. "It never fired and never asked" and "it asked and nobody
          // answered" are different problems.
          this.journal(fresh.id, {
            kind: "consent-asked",
            action: wantsSpend.action,
            target: wantsSpend.node.id,
          }, nowMs);
```

In the `!stillArmed` branch, beside the existing `this.log(...)` and inside the same block:

```ts
            this.journal(flow.id, { kind: "skipped", edge: f.edge.id, reason: "disarmed-mid-pass" }, nowMs);
```

Place it immediately after the `this.log(...)` call and **outside** the `if (!skipReported)` guard — the log line and the telemetry event are per-flow, but a skip is per-rule, and the journal is the only record of WHICH rules were left pending.

In the `lostLock` branch, inside the `if (!renew(...))` block after `this.log(...)`:

```ts
        lostLock = true;
```
becomes
```ts
            lostLock = true;
            this.journal(flow.id, { kind: "skipped", edge: f.edge.id, reason: "lock-lost" }, nowMs);
```

> Note this journals the edge that was the LAST one performed, matching what the existing log line says ("was the last step of this pass"). Every *subsequent* edge is skipped by the `if (lostLock)` guard at the top of the loop; add the same line there too:

```ts
          if (lostLock) {
            deferredTargets.add(f.edge.to);
            this.journal(flow.id, { kind: "skipped", edge: f.edge.id, reason: "lock-lost" }, nowMs);
            continue;
          }
```

In the `done.kind === "defer"` branch, beside its `this.log(...)`:

```ts
            this.journal(flow.id, { kind: "deferred", edge: f.edge.id, reason: done.reason }, nowMs);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run test/unit/deckView.test.ts`
Expected: PASS, whole file.

- [ ] **Step 5: Mutation-check the two skip reasons**

Swap the two `reason` literals (`"disarmed-mid-pass"` ↔ `"lock-lost"`) at the disarm site and the lost-lock site. Run the file. Expected: both skip tests FAIL. Revert and re-run: PASS.

If either test still passes with the reasons swapped, the fixture is not reaching the branch you think it is — fix the fixture, not the assertion.

- [ ] **Step 6: Commit**

```bash
git add src/deckView.ts test/unit/deckView.test.ts
git -c user.name=oznasi1 -c user.email=oznasi1@gmail.com commit -m "feat(deck): journal the four ways a rule fails to fire

deferred, disarmed mid-pass, lock lost, and waiting on consent. Each was
already computed and thrown at an output channel nobody was watching at
2am; an unanswered consent question left no trace anywhere at all.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Journal the user's own gestures, then document and ship

**Files:**
- Modify: `src/deckView.ts` (`askFirstSpend` ~1388-1398; the `flow:arm` case ~4075; the `flow:resetEdge` case ~4152)
- Modify: `CHANGELOG.md`
- Create: `docs/FLOW_JOURNAL.md`
- Modify: `README.md` or `docs/ORCHESTRATOR_COMMANDS.md` (one link to the new doc)
- Test: `test/unit/deckView.test.ts`

**Interfaces:**
- Consumes: `this.journal` (Task 4).
- Produces: nothing new. This is the last task.

**Background:** these three sites write the flow file **without** the lock, exactly as they do today (they re-read immediately before writing and touch only flow-level fields). The journal append is unlocked there too. Two windows appending at once is precisely the case the per-line checksum exists for — do not add a lock here.

`reset` is the event the whole feature exists for: `flow:resetEdge` is the gesture that destroys the receipt.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/deckView.test.ts`:

```ts
  it("journals a Reset, which is the gesture that destroys the edge's receipt", async () => {
    // Fixture: an armed-or-disarmed flow with one stamped edge, then send
    // { type: "flow:resetEdge", id: "f1", edgeId: "e1" } — copy the setup from
    // whichever existing flow:resetEdge test is nearest.
    const reset = journal().filter((e) => e.kind === "reset");
    expect(reset).toHaveLength(1);
    expect(reset[0]).toMatchObject({ kind: "reset", edge: "e1", flow: "f1" });
  });

  it("journals arming and disarming, naming which gesture it was", async () => {
    // Fixture: copy the nearest existing flow:arm test; send flow:arm twice.
    const armed = journal().filter((e) => e.kind === "armed");
    expect(armed).toHaveLength(2);
    expect(armed[0]).toMatchObject({ kind: "armed", armed: true, source: "toggle" });
    expect(armed[1]).toMatchObject({ kind: "armed", armed: false, source: "toggle" });
  });

  it("journals the answer to a first-spend question", async () => {
    // Fixture: copy "stamps launchConfirmedAt on Launch and lets the NEXT pass
    // act" (~line 6767), which drives the modal to the ACT answer.
    const consented = journal().filter((e) => e.kind === "consented");
    expect(consented).toHaveLength(1);
    expect(consented[0]).toMatchObject({ kind: "consented", answer: "act" });
  });

  it("journals a Disarm answer to a first-spend question", async () => {
    // Fixture: copy "disarms on Disarm, and never launches on any later pass"
    // (~line 6827).
    const consented = journal().filter((e) => e.kind === "consented");
    expect(consented).toHaveLength(1);
    expect(consented[0]).toMatchObject({ kind: "consented", answer: "disarm" });
  });

  it("journals a dismissed first-spend question as neither act nor disarm", async () => {
    // Fixture: the same modal, answered with undefined (dismissed).
    const consented = journal().filter((e) => e.kind === "consented");
    expect(consented).toHaveLength(1);
    expect(consented[0]).toMatchObject({ kind: "consented", answer: "dismissed" });
  });

  it("does not journal an arm for a flow id that is not on disk", async () => {
    // Fixture: send flow:arm for an unknown id — the handler returns early.
    expect(journal().filter((e) => e.kind === "armed")).toEqual([]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run test/unit/deckView.test.ts -t "journal"`
Expected: FAIL — six new cases finding empty arrays.

- [ ] **Step 3: Journal the answer in `askFirstSpend`**

In `src/deckView.ts`, replace the tail of `askFirstSpend`:

```ts
    if (answer === ACT) {
      const stamp = target.action === "run"
        ? { commandConfirmedAt: Date.now() }
        : { launchConfirmedAt: Date.now() };
      writeFlow(this.flowIo, this.flowsDir, { ...latest, ...stamp });
    } else if (answer === DISARM) writeFlow(this.flowIo, this.flowsDir, { ...latest, armed: false });
```

with:

```ts
    if (answer === ACT) {
      const stamp = target.action === "run"
        ? { commandConfirmedAt: Date.now() }
        : { launchConfirmedAt: Date.now() };
      writeFlow(this.flowIo, this.flowsDir, { ...latest, ...stamp });
    } else if (answer === DISARM) writeFlow(this.flowIo, this.flowsDir, { ...latest, armed: false });
    // Journalled on ALL THREE answers, dismissal included. A dismissed question
    // writes nothing at all, so without this the flow's history shows a pass that
    // asked and then simply nothing — indistinguishable from a window that was
    // closed before the modal was ever seen. After the write, like every other
    // journal call, so a line is never ahead of the fact it describes.
    this.journal(
      latest.id,
      { kind: "consented", answer: answer === ACT ? "act" : answer === DISARM ? "disarm" : "dismissed" },
      Date.now(),
    );
```

- [ ] **Step 4: Journal `flow:arm`**

In the `flow:arm` case, immediately after `writeFlow(this.flowIo, this.flowsDir, { ...flow, armed: m.armed });`:

```ts
        // `source: "toggle"` matches the `flow_armed` telemetry this handler
        // already emits below, so the two records of one gesture agree. The
        // pass's own auto-skip records its disarm as its own `skipped` events
        // rather than as an `armed` — nothing was toggled there.
        this.journal(m.id, { kind: "armed", armed: m.armed, source: "toggle" }, Date.now());
```

Place it after the write and before the armability computation, so an early return from anything below still leaves the record.

- [ ] **Step 5: Journal `flow:resetEdge`**

In the `flow:resetEdge` case, immediately after the `writeFlow(...)` call and before `trackEvent(...)`:

```ts
        // The event this whole journal exists for. Reset's job is to DELETE the
        // edge's receipt — `firedAt`, `firedNote`, `error`, `performed` — so that
        // the rule can run again, which until now meant a failed 2am deploy left
        // no evidence it had ever happened. The receipt moves here instead of
        // vanishing.
        this.journal(m.id, { kind: "reset", edge: m.edgeId }, Date.now());
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run test/unit/deckView.test.ts`
Expected: PASS, whole file.

- [ ] **Step 7: Write the format documentation**

Create `docs/FLOW_JOURNAL.md`:

````markdown
# The flow journal

Every armed flow keeps an append-only record of what it did, beside the flow
itself:

```
~/.agentflow/flows/<flow-id>.json        the flow — nodes, rules, and their current stamps
~/.agentflow/flows/<flow-id>.log.jsonl   the journal — one line per event, oldest first
```

The journal exists because the flow file is not a history. A rule's receipt lives
on the rule itself, and **Reset deletes it** so the rule can fire again. Without a
journal, resetting a deploy that failed overnight leaves no evidence it ever ran.

It is written whenever `agentFlow.orchestrator` is on. There is no separate
setting: a record you have to switch on in advance is empty for the first incident,
which is the incident you wanted it for.

## Reading it

One JSON object per line, so `jq` works directly:

```bash
# Everything a flow did, newest last
jq -c . ~/.agentflow/flows/f1x2-ab3c.log.jsonl

# Only the failures, with their command output
jq 'select(.kind == "errored")' ~/.agentflow/flows/f1x2-ab3c.log.jsonl

# Why did nothing fire?
jq 'select(.kind == "deferred" or .kind == "skipped") | {at, edge, reason}' \
  ~/.agentflow/flows/f1x2-ab3c.log.jsonl
```

## The fields

Every line has these:

| Field | Meaning |
|---|---|
| `id` | Sortable event id — a millisecond timestamp, a within-millisecond sequence, and a random tail. Lexical order is chronological order. |
| `at` | Epoch milliseconds. |
| `flow` | The flow id, so a journal stays self-describing if it is copied or concatenated. |
| `kind` | What happened — see below. |
| `sum` | A checksum of the rest of the line. |

`sum` guards against **torn writes**, not tampering. Two editor windows can advance
flows at the same time, and a large command output can interleave mid-line. A line
whose checksum does not match is skipped when the journal is read; the lines around
it are unaffected.

## The events

| `kind` | Extra fields | Meaning |
|---|---|---|
| `armed` | `armed`, `source` | The flow was switched on or off. |
| `consent-asked` | `action`, `target` | A pass needed first-spend approval, so it performed nothing and asked. |
| `consented` | `answer` | You answered that question: `act`, `disarm`, or `dismissed`. |
| `fired` | `edge`, `from`, `to`, `action`, `note`, `output?` | A rule fired. |
| `errored` | `edge`, `from`, `to`, `action`, `error`, `output?` | A rule ran or was refused, and was latched with an error. |
| `deferred` | `edge`, `reason` | Nothing was decided; the next pass will try again. |
| `skipped` | `edge`, `reason` | `disarmed-mid-pass` (switched off while a pass was in flight) or `lock-lost` (another window took over). |
| `promoted` | `node`, `runKey`, `repo` | Planned work became a real place on the board. |
| `reset` | `edge` | A rule's receipt was cleared so it can fire again. |

`output` carries a command's stdout and stderr, truncated to the first and last
4 KB with the elided byte count stated in between.

## Lifetime

- **The journal outlives its flow.** Deleting a flow removes `<id>.json` and leaves
  `<id>.log.jsonl`, because the moment you most want the history is usually just
  after you deleted the thing that produced it. Delete the `.log.jsonl` by hand
  when you want it gone.
- **It is capped at 1 MB per flow.** Past that, the oldest whole lines are dropped
  as new ones arrive. A single event larger than the cap is kept anyway.
- **A journal failure never stops a flow.** If the file cannot be written, the Agent
  Flow Deck output channel says so once and flows keep running unrecorded.
````

- [ ] **Step 8: Link the doc and add the changelog entry**

Add one line to `docs/ORCHESTRATOR_COMMANDS.md` (or the orchestrator section of `README.md`, whichever already lists the `~/.agentflow/flows` layout):

```markdown
Every armed flow also keeps an append-only record of what it did — see
[the flow journal](FLOW_JOURNAL.md).
```

Add under `## [Unreleased]` in `CHANGELOG.md`:

```markdown
- Flows now keep an append-only journal beside each flow file
  (`~/.agentflow/flows/<id>.log.jsonl`), one line per event. Reset no longer
  destroys the only record that a rule ran, a failed command's output outlives the
  window that ran it, and a rule that quietly did nothing says why — deferred,
  disarmed mid-pass, lock lost, or waiting on approval. The journal survives
  deleting the flow, is capped at 1 MB, and never blocks a flow when it cannot be
  written. See [docs/FLOW_JOURNAL.md](docs/FLOW_JOURNAL.md).
```

- [ ] **Step 9: Run the full gate**

Run: `npm run typecheck`
Expected: exit 0.

Run: `npm test` — **with a 600000 ms timeout, and do not pipe it through `tail` or `head`.**
Expected: PASS. `test/unit/compat.test.ts`, `test/unit/vocabulary.test.ts` and `test/unit/docs.test.ts` must all pass with no edits.

Run: `npm run build`
Expected: exit 0, four bundles.

Run: `npm run test:cov`
Expected: thresholds met (90% lines/statements, 85% branches/functions).

> If exactly one test fails in a run this long, re-run that file alone before believing it — the suite flakes under CPU contention. Read the real exit code; do not trust a wrapper's.

- [ ] **Step 10: Commit**

```bash
git add src/deckView.ts test/unit/deckView.test.ts docs/FLOW_JOURNAL.md docs/ORCHESTRATOR_COMMANDS.md CHANGELOG.md
git -c user.name=oznasi1 -c user.email=oznasi1@gmail.com commit -m "feat(deck): journal arm, consent and reset, and document the format

Reset is the gesture the journal exists for — it deletes the edge's
receipt so the rule can fire again. The receipt moves to the journal
instead of vanishing. A dismissed consent question is recorded too: it
writes nothing else anywhere, so without a line it is indistinguishable
from a window that was closed before the modal was seen.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Notes for the reviewer

Three things worth checking that the tests cannot:

1. **`journal.ts` must stay off the webview graph.** It imports `path`. Nothing in `src/webview/` reaches it today and `npm run build` is the gate — but `webviewGraph.test.ts` follows relative imports only, so the build is the check that matters.
2. **The trim reads the whole journal into memory** to cut it. Bounded by `JOURNAL_CAP_BYTES` (1 MB), so this is fine, and it happens only on the append that crosses the cap.
3. **`consent-asked` uses `fresh.id`, everything else in the pass uses `flow.id`.** They are the same value — `fresh` is a re-read of `flow` — and the sites simply use whichever copy is in scope. If a future change makes them differ, the ask site is the one to look at.
