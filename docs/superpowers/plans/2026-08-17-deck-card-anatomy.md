# Deck Card Anatomy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a run's token spend, its true agent state, and an action per PR failure onto the Deck card.

**Architecture:** A new pure reducer (`engine/usage.ts`) sums transcript usage deduplicated by `requestId`; a separate fs reader (`engine/usageFs.ts`) tails transcripts incrementally on its own 60s cadence, never on the 6s refresh. `AgentState` widens with `stalled` and `exited` — the first derived in the pure transcript reducer, the second promoted in `buildRunStatus` where session liveness is visible. The card's single gated *Address PR* button is replaced by one row per PR failure, each with the verb that matches it.

**Tech Stack:** TypeScript, React (webview), esbuild, vitest.

**Spec:** `docs/superpowers/specs/2026-08-17-deck-card-anatomy-design.md` — read it before Task 1. It carries the measurements every decision here rests on.

## Global Constraints

- **All four gates must pass before a task is done:** `npm run typecheck`, `npm test`, `npm run build`, `npm run test:cov`.
- **`npm run build` is not optional and not covered by the others.** It is the only gate that catches a `src/webview/` module reaching a Node builtin. `tsc` and the full suite pass regardless. `src/webview/` must not import `fs`, `os`, `path`, or `child_process`, **even transitively**.
- **Coverage thresholds (`vitest.config.ts`):** statements 90, branches 85, functions 85, lines 90.
- **Every test must fail before the implementation exists.** Run it, see it fail, then implement. A test that passes against unmodified code covers nothing. If a test passes on the first run, it is broken — fix the test, do not proceed.
- **The existing suite passes unmodified, with exactly one authorised exception:** the test named `"reads a stale tool_use as idle"` in `test/unit/engine/transcript.test.ts:44`. Task 3 changes it deliberately. No other existing test may be edited; if one fails, the implementation is wrong, not the test.
- **This extension has thousands of installs.** New behaviour is additive. `deck:addressPr` keeps working.
- **Token unit is `eq`, never `tok`.** The figure is an effort-weighted equivalent, not a token count.
- **Absent usage and zero usage must render differently.** A run not yet measured shows no figure; it must never show `0`.
- **Work in the worktree** `/Users/oznasi/dev/agent-flow/.claude/worktrees/d3-card-anatomy` on branch `feat/deck-card-anatomy`. Use absolute paths in shell commands — parallel sessions share the root checkout and switch its branch.
- **Commit after every task.** A round can be killed mid-flight; an uncommitted tree is lost work.

## File Structure

| File | Responsibility |
|---|---|
| `src/engine/usage.ts` | **Create.** Pure leaf: `UsageTotals`, `accumulateUsage`, `weightedEq`, `formatEq`. Imports nothing but its own types — webview-safe. |
| `src/engine/usageFs.ts` | **Create.** `UsageReader` — incremental per-file tailing, per-dir and per-run summing. Owns all `fs`. |
| `src/engine/transcript.ts` | Modify. `deriveActivity` gains `stalled` and `midWork`. |
| `src/engine/activity.ts` | Modify. `STATE_RANK` gains the two states; `UNKNOWN_ACTIVITY` unchanged. |
| `src/engine/status.ts` | Modify. Promotes `midWork` + no live session to `exited`; attaches `usage`. |
| `src/engine/bucket.ts` | Modify. Routes `stalled` and `exited` to `needs`. |
| `src/engine/prompt.ts` | Modify. `prWorkClause` — the reason-specific preamble. |
| `src/types.ts` | Modify. `AgentState` widens; `AgentActivity.midWork?`; `RunStatus.usage?`; `deck:seedPrWork`. |
| `src/webview/deckSignal.ts` | Modify. `cardActions` beside `cardSignal`, sharing `leadPr`. |
| `src/webview/DeckApp.tsx` | Modify. Failure rows, footer spend figure, header total; `canAddressPr` deleted. |
| `src/webview/deckParts.tsx` | Modify. `STATE` map gains the two states. |
| `src/webview/OrchestratorDrawer.tsx` | Modify. `STATE_HUE` gains the two states. |
| `src/webview/deckStyles.ts` | Modify. `.c-rows`, `.c-row`, `.spend`. |
| `src/deckView.ts` | Modify. 60s usage sweep; `deck:seedPrWork` handler. |

The `usage.ts` / `usageFs.ts` split follows the `claudeAssets.ts` / `claudeAssetsFs.ts` pair already in the repo. It is not stylistic: `formatEq` and `weightedEq` are called from the webview, so they cannot live in a module that reaches `fs`.

---

### Task 1: The pure usage reducer

**Files:**
- Create: `src/engine/usage.ts`
- Test: `test/unit/engine/usage.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `UsageTotals { input, output, cacheWrite, cacheRead: number }`; `UsageLine`; `zeroUsage(): UsageTotals`; `accumulateUsage(lines: UsageLine[], into: UsageTotals, seen: Set<string>): UsageTotals`; `weightedEq(t: UsageTotals): number`; `formatEq(n: number): string`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine/usage.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { accumulateUsage, formatEq, UsageLine, weightedEq, zeroUsage } from "../../../src/engine/usage";

/** One assistant line carrying usage. `rid` is the requestId; omit it to test
 * the message.id fallback. */
const line = (
  usage: Partial<{ input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number }>,
  rid?: string,
  id?: string,
): UsageLine => ({ type: "assistant", ...(rid ? { requestId: rid } : {}), message: { ...(id ? { id } : {}), usage } });

const sum = (lines: UsageLine[]) => accumulateUsage(lines, zeroUsage(), new Set<string>());

describe("accumulateUsage", () => {
  it("sums the four classes into their own fields", () => {
    const t = sum([line({ input_tokens: 2, output_tokens: 100, cache_creation_input_tokens: 30, cache_read_input_tokens: 4000 }, "r1")]);
    expect(t).toEqual({ input: 2, output: 100, cacheWrite: 30, cacheRead: 4000 });
  });

  // Claude Code writes one line per content block of a multi-block assistant
  // message, and every line repeats the request's usage. A real 6.1MB transcript
  // had 102 such lines across 51 requestIds — naive summing inflated output 2.44x.
  it("counts a repeated requestId exactly once", () => {
    const dup = line({ output_tokens: 421, cache_creation_input_tokens: 57538 }, "req_A");
    const t = sum([dup, dup, dup, dup]);
    expect(t.output).toBe(421);
    expect(t.cacheWrite).toBe(57538);
  });

  it("still counts distinct requestIds", () => {
    const t = sum([line({ output_tokens: 10 }, "r1"), line({ output_tokens: 5 }, "r2")]);
    expect(t.output).toBe(15);
  });

  it("falls back to message.id when there is no requestId", () => {
    const a = line({ output_tokens: 7 }, undefined, "msg_1");
    const t = sum([a, a]);
    expect(t.output).toBe(7);
  });

  // Cannot be deduplicated, so it must be counted — dropping it would understate
  // spend, which is the one direction this figure must never err in.
  it("counts a line with neither requestId nor message.id every time", () => {
    const a = line({ output_tokens: 3 });
    const t = sum([a, a]);
    expect(t.output).toBe(6);
  });

  it("ignores lines with no usage object", () => {
    const t = sum([{ type: "user" }, { type: "assistant", message: {} }, line({ output_tokens: 9 }, "r1")]);
    expect(t.output).toBe(9);
  });

  it("defaults missing usage fields to 0 rather than NaN", () => {
    const t = sum([line({ output_tokens: 5 }, "r1")]);
    expect(t.input).toBe(0);
    expect(t.cacheRead).toBe(0);
    expect(Number.isNaN(t.cacheWrite)).toBe(false);
  });

  it("accumulates into the totals and seen set it is given, so a caller can resume", () => {
    const into = zeroUsage();
    const seen = new Set<string>();
    accumulateUsage([line({ output_tokens: 4 }, "r1")], into, seen);
    accumulateUsage([line({ output_tokens: 4 }, "r1"), line({ output_tokens: 6 }, "r2")], into, seen);
    expect(into.output).toBe(10);
    expect(seen.size).toBe(2);
  });
});

describe("weightedEq", () => {
  // Ratios between Anthropic's published rates: cache reads are ~0.1x input and
  // 96.7% of raw tokens, so a raw sum ranks cards by conversation length.
  it("weights input 1x, cache-write 1.25x, cache-read 0.1x, output 5x", () => {
    expect(weightedEq({ input: 100, output: 100, cacheWrite: 100, cacheRead: 100 })).toBe(100 + 500 + 125 + 10);
  });

  it("is 0 for zero usage", () => {
    expect(weightedEq(zeroUsage())).toBe(0);
  });

  it("rounds to a whole number", () => {
    expect(weightedEq({ input: 0, output: 0, cacheWrite: 0, cacheRead: 5 })).toBe(1);
  });
});

describe("formatEq", () => {
  it("prints hundreds as-is", () => {
    expect(formatEq(842)).toBe("842");
  });

  it("prints thousands with k", () => {
    expect(formatEq(380_400)).toBe("380k");
  });

  it("prints millions with one decimal", () => {
    expect(formatEq(12_428_708)).toBe("12.4M");
  });

  it("rounds up into k at the boundary", () => {
    expect(formatEq(999_500)).toBe("1000k");
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
cd /Users/oznasi/dev/agent-flow/.claude/worktrees/d3-card-anatomy
npx vitest run test/unit/engine/usage.test.ts
```

Expected: FAIL — `Failed to resolve import "../../../src/engine/usage"`.

- [ ] **Step 3: Write the implementation**

Create `src/engine/usage.ts`:

```ts
// The leaf of the spend graph: what a run's token usage IS, how to sum it, and
// how to print it. Types and arithmetic only — no I/O, no other module.
//
// The webview bundles for a BROWSER target and esbuild resolves imports
// statically, so any module the webview's graph can reach must never touch a
// Node builtin. `weightedEq` and `formatEq` are called from DeckApp, which is
// why they live here rather than beside the reader in ./usageFs. Same split as
// ./claudeAssets and ./claudeAssetsFs.
//
// Keep this file importing nothing. test/webview/webviewGraph.test.ts walks the
// real import graph from each webview entry point and fails the moment anything
// reachable from it imports a Node builtin.

/** Token usage, kept in its four billing classes rather than pre-summed. The
 * classes have wildly different rates, so a single total cannot be un-mixed
 * later — and the detail drawer needs the breakdown. */
export interface UsageTotals {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** The subset of a transcript line this module reads. Declared here rather than
 * imported from ./transcript because that module owns `fs`. */
export interface UsageLine {
  type?: string;
  /** Claude Code's per-request id — the dedup key. */
  requestId?: string;
  message?: {
    id?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

/** A fresh zero. A shared constant would be a mutable global that
 * `accumulateUsage` writes through. */
export function zeroUsage(): UsageTotals {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
}

/** The rate ratios between the four classes, not absolute prices. Ratios are
 * stable across Anthropic models, so this never goes stale the way a dollar
 * table would — and it does not claim a dollar amount for a subscription user
 * who paid none. */
const W_INPUT = 1;
const W_CACHE_WRITE = 1.25;
const W_CACHE_READ = 0.1;
const W_OUTPUT = 5;

const num = (v: number | undefined): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Sum usage across `lines` into `into`, skipping any request already in `seen`.
 *
 * Deduplication is a correctness requirement, not a nicety: Claude Code writes
 * one line per content block of a multi-block assistant message and repeats the
 * request's usage on every one of them. On a real 6.1MB transcript, 102 lines
 * carried usage across only 51 unique requestIds — 37 of them repeated up to
 * 4x — and summing naively inflated output tokens 2.44x.
 *
 * `into` and `seen` are mutated and returned so an incremental reader can carry
 * dedup state across chunk boundaries: the duplicate lines of one request are
 * not guaranteed to land in the same read.
 */
export function accumulateUsage(lines: UsageLine[], into: UsageTotals, seen: Set<string>): UsageTotals {
  for (const l of lines) {
    const u = l.message?.usage;
    if (!u) continue;
    // A line with neither id is counted every time. It cannot be deduplicated,
    // and understating spend is the one error this figure must not make.
    const key = l.requestId ?? l.message?.id ?? null;
    if (key !== null) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    into.input += num(u.input_tokens);
    into.output += num(u.output_tokens);
    into.cacheWrite += num(u.cache_creation_input_tokens);
    into.cacheRead += num(u.cache_read_input_tokens);
  }
  return into;
}

/** The one number a card prints: usage re-expressed as input-token equivalents.
 * Not a token count — the unit label is "eq", never "tok". */
export function weightedEq(t: UsageTotals): number {
  return Math.round(
    t.input * W_INPUT + t.cacheWrite * W_CACHE_WRITE + t.cacheRead * W_CACHE_READ + t.output * W_OUTPUT,
  );
}

/** Compact, at most five characters wide so it never pushes a card's footer. */
export function formatEq(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
npx vitest run test/unit/engine/usage.test.ts
```

Expected: PASS, 15 tests.

- [ ] **Step 5: Run the gates**

```bash
npm run typecheck && npm test && npm run build
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/engine/usage.ts test/unit/engine/usage.test.ts
git commit -m "feat(deck): a pure usage reducer, deduplicated by requestId"
```

---

### Task 2: The incremental usage reader

**Files:**
- Create: `src/engine/usageFs.ts`
- Test: `test/unit/engine/usageFs.test.ts`

**Interfaces:**
- Consumes: `UsageTotals`, `UsageLine`, `accumulateUsage`, `zeroUsage` from Task 1. `encodeProjectDir` from `src/engine/transcript.ts`.
- Produces: `class UsageReader` with `readFile(file: string): UsageTotals`, `readDir(dir: string): UsageTotals`, `readRun(projectsRoot: string, cwds: string[]): UsageTotals`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine/usageFs.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { UsageReader } from "../../../src/engine/usageFs";
import { encodeProjectDir } from "../../../src/engine/transcript";

/** One assistant line with usage, as it appears on disk. */
const row = (rid: string, out: number, cacheRead = 0): string =>
  JSON.stringify({ type: "assistant", requestId: rid, message: { usage: { output_tokens: out, cache_read_input_tokens: cacheRead } } });

describe("UsageReader.readFile", () => {
  let root: string;
  let file: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-usage-"));
    file = path.join(root, "s.jsonl");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("sums a whole file on first read", () => {
    fs.writeFileSync(file, [row("r1", 10), row("r2", 20)].join("\n") + "\n");
    expect(new UsageReader().readFile(file).output).toBe(30);
  });

  it("reads only the appended bytes on the second sweep, and totals the same as one full read", () => {
    fs.writeFileSync(file, row("r1", 10) + "\n");
    const r = new UsageReader();
    expect(r.readFile(file).output).toBe(10);
    fs.appendFileSync(file, row("r2", 20) + "\n");
    expect(r.readFile(file).output).toBe(30);

    // The same content read cold, in one pass, must agree.
    expect(new UsageReader().readFile(file).output).toBe(30);
  });

  it("does not double-count when nothing was appended", () => {
    fs.writeFileSync(file, row("r1", 10) + "\n");
    const r = new UsageReader();
    r.readFile(file);
    expect(r.readFile(file).output).toBe(10);
  });

  // A sweep can land mid-write. The bytes after the last newline are held over,
  // so the line is parsed once, whole, on the next sweep.
  it("counts a line split across two reads exactly once", () => {
    const full = row("r1", 42) + "\n";
    const cut = Math.floor(full.length / 2);
    fs.writeFileSync(file, full.slice(0, cut));
    const r = new UsageReader();
    expect(r.readFile(file).output).toBe(0); // no complete line yet
    fs.appendFileSync(file, full.slice(cut));
    expect(r.readFile(file).output).toBe(42);
  });

  it("counts a request whose duplicate lines straddle two reads exactly once", () => {
    fs.writeFileSync(file, row("r1", 421) + "\n");
    const r = new UsageReader();
    r.readFile(file);
    fs.appendFileSync(file, row("r1", 421) + "\n");
    expect(r.readFile(file).output).toBe(421);
  });

  it("rebuilds from zero when the file shrinks (truncated or replaced)", () => {
    fs.writeFileSync(file, [row("r1", 10), row("r2", 20)].join("\n") + "\n");
    const r = new UsageReader();
    expect(r.readFile(file).output).toBe(30);
    fs.writeFileSync(file, row("r9", 7) + "\n");
    expect(r.readFile(file).output).toBe(7);
  });

  it("survives a multi-byte character on the read boundary", () => {
    const wide = JSON.stringify({ type: "assistant", requestId: "r1", message: { usage: { output_tokens: 5 } }, note: "日本語テキスト" }) + "\n";
    const bytes = Buffer.from(wide, "utf8");
    // Cut inside the first multi-byte character.
    const cut = bytes.indexOf(Buffer.from("日")[0]) + 1;
    fs.writeFileSync(file, bytes.subarray(0, cut));
    const r = new UsageReader();
    r.readFile(file);
    fs.appendFileSync(file, bytes.subarray(cut));
    expect(r.readFile(file).output).toBe(5);
  });

  it("is zero (no throw) for a missing file", () => {
    expect(new UsageReader().readFile(path.join(root, "nope.jsonl")).output).toBe(0);
  });

  it("tolerates a malformed line", () => {
    fs.writeFileSync(file, ['{"usage": broken', row("r1", 11)].join("\n") + "\n");
    expect(new UsageReader().readFile(file).output).toBe(11);
  });
});

describe("UsageReader.readDir", () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-usage-d-")); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("sums every .jsonl in the directory", () => {
    fs.writeFileSync(path.join(root, "a.jsonl"), row("r1", 10) + "\n");
    fs.writeFileSync(path.join(root, "b.jsonl"), row("r2", 20) + "\n");
    fs.writeFileSync(path.join(root, "notes.txt"), row("r3", 999) + "\n");
    expect(new UsageReader().readDir(root).output).toBe(30);
  });

  it("dedups a requestId that appears in two files", () => {
    fs.writeFileSync(path.join(root, "a.jsonl"), row("shared", 10) + "\n");
    fs.writeFileSync(path.join(root, "b.jsonl"), row("shared", 10) + "\n");
    // Dedup state is per file, so this is 20 by design: two sessions genuinely
    // billed the same request only if Claude Code copied a line between
    // transcripts, which it does not do. Asserted so the boundary is explicit.
    expect(new UsageReader().readDir(root).output).toBe(20);
  });

  it("is zero (no throw) for a missing directory", () => {
    expect(new UsageReader().readDir(path.join(root, "nope")).output).toBe(0);
  });
});

describe("UsageReader.readRun", () => {
  let projects: string;
  beforeEach(() => { projects = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-usage-r-")); });
  afterEach(() => fs.rmSync(projects, { recursive: true, force: true }));

  const seed = (cwd: string, rid: string, out: number) => {
    const dir = path.join(projects, encodeProjectDir(cwd));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${rid}.jsonl`), row(rid, out) + "\n");
  };

  it("sums across a run's repo directories", () => {
    seed("/repo/alpha", "r1", 10);
    seed("/repo/beta", "r2", 20);
    expect(new UsageReader().readRun(projects, ["/repo/alpha", "/repo/beta"]).output).toBe(30);
  });

  it("counts a repo listed twice only once", () => {
    seed("/repo/alpha", "r1", 10);
    expect(new UsageReader().readRun(projects, ["/repo/alpha", "/repo/alpha"]).output).toBe(10);
  });

  it("is zero for a run whose repos have no transcripts", () => {
    expect(new UsageReader().readRun(projects, ["/repo/ghost"]).output).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npx vitest run test/unit/engine/usageFs.test.ts
```

Expected: FAIL — `Failed to resolve import "../../../src/engine/usageFs"`.

- [ ] **Step 3: Write the implementation**

Create `src/engine/usageFs.ts`:

```ts
import * as fs from "fs";
import * as path from "path";
import { accumulateUsage, UsageLine, UsageTotals, zeroUsage } from "./usage";
import { encodeProjectDir } from "./transcript";

/** What is remembered about one transcript between sweeps. */
interface FileUsage {
  /** File size at the last read — the offset the next read starts from. */
  size: number;
  totals: UsageTotals;
  /** requestIds already counted. Bounded by request count, not bytes: about 51
   * ids for a 6MB transcript, so holding these for the host's lifetime is cheap. */
  seen: Set<string>;
  /** Bytes after the last newline of the previous read, held over so a line
   * split across two sweeps is parsed once and whole. A Buffer rather than a
   * string because a multi-byte character can straddle the boundary too, and
   * decoding half of one corrupts it. */
  pendingTail: Buffer;
}

const fresh = (): FileUsage => ({ size: 0, totals: zeroUsage(), seen: new Set(), pendingTail: Buffer.alloc(0) });

/**
 * Cumulative token usage from Claude Code transcripts, read incrementally.
 *
 * Transcripts are append-only, so each sweep parses only the bytes added since
 * the last one. That is what makes this affordable at all: the corpus on a
 * working machine runs to hundreds of megabytes across hundreds of files, with
 * single transcripts past 50MB.
 *
 * Never call this on the Deck's 6s refresh. It has its own slower cadence, and
 * `refresh()` reads the totals it computed out of memory. One instance is held
 * for the host's lifetime — the per-file caches are the whole point.
 *
 * Best-effort throughout: an unreadable file or directory contributes nothing
 * and never throws, exactly as `readAgentActivity` degrades.
 */
export class UsageReader {
  private cache = new Map<string, FileUsage>();

  /** Cumulative totals for one transcript, parsing only what is new. */
  readFile(file: string): UsageTotals {
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return zeroUsage(); // missing or unreadable → contributes nothing
    }
    let e = this.cache.get(file);
    // A file smaller than we last saw was truncated or replaced under us: the
    // cached offset and dedup set describe content that no longer exists.
    if (!e || size < e.size) {
      e = fresh();
      this.cache.set(file, e);
    }
    if (size === e.size) return e.totals;

    let chunk: Buffer;
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, "r");
      const len = size - e.size;
      const buf = Buffer.allocUnsafe(len);
      const read = fs.readSync(fd, buf, 0, len, e.size);
      chunk = buf.subarray(0, read);
    } catch {
      return e.totals; // leave the offset untouched; retry on the next sweep
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* nothing useful to do about a failed close */
        }
      }
    }

    const text = Buffer.concat([e.pendingTail, chunk]);
    const nl = text.lastIndexOf(0x0a); // "\n"
    const complete = nl >= 0 ? text.subarray(0, nl).toString("utf8") : "";
    // Buffer.from copies, so the (possibly large) read buffer is not retained.
    e.pendingTail = Buffer.from(nl >= 0 ? text.subarray(nl + 1) : text);
    e.size = size;

    const lines: UsageLine[] = [];
    for (const r of complete.split("\n")) {
      // The fast path. Most lines in a transcript carry no usage, and this string
      // test is what keeps a 50MB file from costing 50MB of JSON.parse.
      if (!r.includes('"usage"')) continue;
      try {
        lines.push(JSON.parse(r) as UsageLine);
      } catch {
        /* tolerate a hand-edited or half-written line */
      }
    }
    accumulateUsage(lines, e.totals, e.seen);
    return e.totals;
  }

  /** Every transcript in one Claude Code project dir, summed. */
  readDir(dir: string): UsageTotals {
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return zeroUsage();
    }
    const out = zeroUsage();
    for (const n of names) {
      const t = this.readFile(path.join(dir, n));
      out.input += t.input;
      out.output += t.output;
      out.cacheWrite += t.cacheWrite;
      out.cacheRead += t.cacheRead;
    }
    return out;
  }

  /**
   * One run's total: every transcript in every project dir its repos map to.
   *
   * There is deliberately NO branch join here, unlike `readAgentActivity`. The
   * sweep is affordable only because it rejects a line before parsing it, and a
   * branch join needs `gitBranch`, which lives on precisely the lines that test
   * skips. A task launched into a worktree has its own cwd, so its project dir
   * already holds exactly one branch's sessions and the figure is exact; only a
   * repo checked out directly pools several branches, and there the number is
   * the honest total for that directory. The card's tooltip says so.
   */
  readRun(projectsRoot: string, cwds: string[]): UsageTotals {
    const out = zeroUsage();
    // A multi-repo run can name one path twice (two repos under one root); the
    // per-file cache would still return that file's full total each time.
    for (const cwd of new Set(cwds)) {
      const t = this.readDir(path.join(projectsRoot, encodeProjectDir(cwd)));
      out.input += t.input;
      out.output += t.output;
      out.cacheWrite += t.cacheWrite;
      out.cacheRead += t.cacheRead;
    }
    return out;
  }
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
npx vitest run test/unit/engine/usageFs.test.ts
```

Expected: PASS, 15 tests.

- [ ] **Step 5: Run the gates**

```bash
npm run typecheck && npm test && npm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/engine/usageFs.ts test/unit/engine/usageFs.test.ts
git commit -m "feat(deck): incremental transcript usage reader"
```

---

### Task 3: The state ladder — `stalled` and `midWork`

**Files:**
- Modify: `src/types.ts` (`AgentState` at line 88, `AgentActivity` at line 196)
- Modify: `src/engine/transcript.ts:34-48` (`deriveActivity`)
- Modify: `src/engine/activity.ts` (`STATE_RANK`)
- Modify: `src/webview/deckParts.tsx:110-112` (`STATE`)
- Modify: `src/webview/OrchestratorDrawer.tsx:276` (`STATE_HUE`)
- Modify: `src/webview/DeckApp.tsx:116-121` (`stateView` switch)
- Test: `test/unit/engine/transcript.test.ts` (extend, and change one existing test)

**Interfaces:**
- Consumes: nothing new.
- Produces: `AgentState` gains `"stalled" | "exited"`. `AgentActivity` gains `midWork?: boolean`. Task 4 promotes `midWork` to `exited`.

`midWork` is **optional**, not required. A required field would break every `AgentActivity` literal across the existing test suite, and the constraint is that the existing suite passes unmodified.

- [ ] **Step 1: Write the failing tests**

In `test/unit/engine/transcript.test.ts`, inside the existing `describe("deriveActivity")` block, add after the `"carries the session slug and last-activity mtime"` test:

```ts
  // A tool call that has not returned in 45s: the agent is at a permission
  // prompt, or a long command is still running. The transcript cannot tell the
  // two apart, so the label is true under either reading. Before this, the one
  // genuinely stuck card on the board rendered in the calmest tone there is.
  it("reads a stale tool_use as stalled", () => {
    expect(deriveActivity([userMsg, asstTool], NOW - 10 * 60_000, NOW).state).toBe("stalled");
  });

  it("still reads a fresh tool_use as working — a tool that just started is not stalled", () => {
    expect(deriveActivity([userMsg, asstTool], NOW - 10_000, NOW).state).toBe("working");
  });

  it("reads a stale trailing user line as idle, not stalled — no tool is outstanding", () => {
    expect(deriveActivity([asstTool, userMsg], NOW - 10 * 60_000, NOW).state).toBe("idle");
  });

  it("marks an unanswered tool_use as midWork", () => {
    expect(deriveActivity([userMsg, asstTool], NOW - 10 * 60_000, NOW).midWork).toBe(true);
  });

  it("marks an unanswered user line as midWork — the agent owes a reply", () => {
    expect(deriveActivity([asstTool, userMsg], NOW - 10 * 60_000, NOW).midWork).toBe(true);
  });

  it("does not mark a finished turn as midWork", () => {
    expect(deriveActivity([userMsg, asstEnd], NOW - 10 * 60_000, NOW).midWork).toBe(false);
  });

  it("does not mark an empty transcript as midWork", () => {
    expect(deriveActivity([], NOW, NOW).midWork).toBeFalsy();
  });
```

Then **change the one authorised existing test.** At `test/unit/engine/transcript.test.ts:44`, delete:

```ts
  it("reads a stale tool_use as idle", () => {
    expect(deriveActivity([userMsg, asstTool], NOW - 10 * 60_000, NOW).state).toBe("idle");
  });
```

It asserts exactly the behaviour this task changes, and the new test above replaces it. This is the only existing test the whole plan may touch.

- [ ] **Step 2: Run the tests and verify they fail**

```bash
npx vitest run test/unit/engine/transcript.test.ts
```

Expected: FAIL — `expected 'idle' to be 'stalled'`, plus `midWork` assertions failing on `undefined`.

- [ ] **Step 3: Widen the types**

In `src/types.ts`, replace line 88:

```ts
export type AgentState = "working" | "needs-you" | "idle" | "unknown";
```

with:

```ts
/** `stalled` and `exited` both mean "look at this", and both were `idle` before:
 * an agent waiting at a permission prompt and one that died mid-tool used to
 * render in the calmest tone on the board. `stalled` is derived from the
 * transcript alone; `exited` needs session liveness and so is assigned by
 * `buildRunStatus` (see AgentActivity.midWork). */
export type AgentState = "working" | "needs-you" | "stalled" | "exited" | "idle" | "unknown";
```

In the `AgentActivity` interface (line ~196), add the field:

```ts
export interface AgentActivity {
  state: AgentState;
  lastActivityMs: number | null; // transcript file mtime
  slug: string | null; // session slug (title), when known
  /** The transcript ends with work owed — an unanswered tool_use, or a user line
   * with no assistant reply. `buildRunStatus` promotes this to state "exited"
   * when no live session claims the run, which is the one thing a per-file
   * reducer cannot know. Optional so every existing AgentActivity literal
   * (the test suite is full of them) still compiles; absent means false. */
  midWork?: boolean;
}
```

- [ ] **Step 4: Derive `stalled` and `midWork`**

In `src/engine/transcript.ts`, replace the body of `deriveActivity` from the `const last =` line to the end of the function:

```ts
  const last = meaningful[meaningful.length - 1];
  // Turn ended and control is back with the human — actionable regardless of how
  // long ago it happened.
  if (last.type === "assistant" && last.message?.stop_reason === "end_turn") {
    return { state: "needs-you", lastActivityMs: mtimeMs, slug, midWork: false };
  }
  // A tool call that never returned. Nothing follows the last meaningful line by
  // definition, so "no tool_result after it" needs no separate check.
  const pendingTool = last.type === "assistant" && last.message?.stop_reason === "tool_use";
  // Work is owed either way: a tool that has not returned, or a user line — a
  // real prompt, or a tool_result — the agent has not answered. Note that Claude
  // Code writes tool results as type "user".
  const midWork = pendingTool || last.type === "user";
  const age = nowMs - mtimeMs;
  if (age <= WORKING_WINDOW_MS) return { state: "working", lastActivityMs: mtimeMs, slug, midWork };
  // Stale with a tool still outstanding: the agent is at a permission prompt, or
  // a long command is running. The transcript cannot separate the two, so the
  // label is chosen to be true under either.
  if (pendingTool) return { state: "stalled", lastActivityMs: mtimeMs, slug, midWork };
  return { state: "idle", lastActivityMs: mtimeMs, slug, midWork };
```

Also update the "unknown" early return a few lines above so it carries the field explicitly:

```ts
  if (meaningful.length === 0) return { state: "unknown", lastActivityMs: mtimeMs ?? null, slug, midWork: false };
```

And update the module comment at line 6 to match the widened behaviour:

```ts
// A working agent's transcript is written to within this window; older → not
// "working" (and, with a tool still outstanding, "stalled").
```

- [ ] **Step 5: Update the three exhaustive maps and the status line**

`src/engine/activity.ts` — replace `STATE_RANK`:

```ts
// needs-you outranks working: deriveBucket's ladder tests needs-you first, and
// with the old order it never saw one — any working session in the run buried
// the agent that was actually waiting on a human.
//
// stalled outranks working for that same reason: a run with one working agent
// and one stuck at a tool is a run that needs a human, and letting the working
// agent bury the stuck one is the identical bug. needs-you still outranks
// stalled — a turn that handed control back is more actionable than a tool that
// has not returned. `exited` is assigned by buildRunStatus AFTER this reduction,
// so it never competes as an input; its rank exists only for totality.
const STATE_RANK: Record<AgentState, number> = {
  "needs-you": 5,
  stalled: 4,
  exited: 3,
  working: 2,
  idle: 1,
  unknown: 0,
};
```

`src/webview/deckParts.tsx` — in the `STATE` map (line ~110), add beside the existing entries:

```ts
  stalled: { text: "stalled", tone: "attn" },
  exited: { text: "exited", tone: "attn" },
```

`src/webview/OrchestratorDrawer.tsx` — in `STATE_HUE` (line ~276), add:

```ts
  stalled: "var(--c-attn)",
  exited: "var(--c-attn)",
```

`src/webview/DeckApp.tsx` — in the `stateView` switch (line ~116), add before `case "idle"`:

```ts
    case "stalled": return { text: `stalled · ${timeAgo(r.agent.lastActivityMs)}`, tone: "attn" };
    case "exited": return { text: `exited · ${timeAgo(r.agent.lastActivityMs)}`, tone: "attn" };
```

- [ ] **Step 6: Run the tests and verify they pass**

```bash
npx vitest run test/unit/engine/transcript.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run the gates**

```bash
npm run typecheck && npm test && npm run build && npm run test:cov
```

`typecheck` is the important one here: if it reports a missing key in a `Record<AgentState, …>`, a renderer was missed. Fix it rather than widening the map's type.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/engine/transcript.ts src/engine/activity.ts \
        src/webview/deckParts.tsx src/webview/OrchestratorDrawer.tsx src/webview/DeckApp.tsx \
        test/unit/engine/transcript.test.ts
git commit -m "feat(deck): derive a stalled agent from an outstanding tool call"
```

---

### Task 4: `exited` promotion and bucket routing

**Files:**
- Modify: `src/engine/status.ts:68-71` (after `mostActive`)
- Modify: `src/engine/bucket.ts:36`
- Test: `test/unit/engine/status.test.ts` (extend), `test/unit/engine/bucket.test.ts` (extend)

**Interfaces:**
- Consumes: `AgentActivity.midWork` from Task 3.
- Produces: a `RunStatus.agent` whose state may be `"exited"`. No new exports.

- [ ] **Step 1: Write the failing tests**

In `test/unit/engine/bucket.test.ts`, inside the `deriveBucket` describe block, add:

```ts
  it("routes a stalled agent to needs — it is stuck, not calm", () => {
    expect(deriveBucket({ ticketCategory: null, ticketStatus: null, agentState: "stalled",
      prOpen: false, prBlocked: false, prMerged: false })).toBe("needs");
  });

  it("routes an exited agent to needs — it died with work in flight", () => {
    expect(deriveBucket({ ticketCategory: null, ticketStatus: null, agentState: "exited",
      prOpen: false, prBlocked: false, prMerged: false })).toBe("needs");
  });

  it("still does not route an idle agent to needs", () => {
    expect(deriveBucket({ ticketCategory: null, ticketStatus: null, agentState: "idle",
      prOpen: false, prBlocked: false, prMerged: false })).not.toBe("needs");
  });
```

Also add, in whichever describe block covers `mostActive` in `test/unit/engine/status.test.ts`:

```ts
  it("prefers a stalled agent over a working one — the stuck one needs a human", () => {
    expect(mostActive([
      { state: "working", lastActivityMs: 200, slug: null },
      { state: "stalled", lastActivityMs: 100, slug: null },
    ]).state).toBe("stalled");
  });

  it("still prefers needs-you over stalled", () => {
    expect(mostActive([
      { state: "stalled", lastActivityMs: 200, slug: null },
      { state: "needs-you", lastActivityMs: 100, slug: null },
    ]).state).toBe("needs-you");
  });

  it("carries midWork through the reduction on the reading that won", () => {
    expect(mostActive([
      { state: "idle", lastActivityMs: 200, slug: null, midWork: false },
      { state: "stalled", lastActivityMs: 100, slug: null, midWork: true },
    ]).midWork).toBe(true);
  });
```

In `test/unit/engine/status.test.ts`, inside the existing `describe("buildRunStatus")` block, add the three tests below. That block's `beforeAll` already writes a transcript whose only line is an unanswered `tool_use`, stamped at `NOW`, for the run fixture named `run` under `projRoot`. Advancing `nowMs` is all it takes to make that same transcript stale — no new fixture needed. The `agent(state, lastActivityMs)` helper at the top of the file builds a `CardAgent`.

```ts
  const LATER = NOW + 10 * 60_000; // the shared tool_use transcript is now stale

  it("promotes a stale mid-work transcript with no live session to exited", () => {
    const s = buildRunStatus({ run, ticket: null, projectsRoot: projRoot, nowMs: LATER });
    expect(s.agent.state).toBe("exited");
  });

  it("leaves a stale mid-work transcript as stalled while a session is still live", () => {
    // stalled (4) outranks working (2), so the reduction keeps the per-repo
    // reading — and its midWork is not promoted, because an agent is open.
    const s = buildRunStatus({
      run, ticket: null, projectsRoot: projRoot, nowMs: LATER,
      agents: [agent("working", LATER)],
    });
    expect(s.agent.state).toBe("stalled");
  });
```

Then add a nested describe with its own fixture, because the shared one has no finished turn in it:

```ts
  describe("buildRunStatus and a finished turn", () => {
    let endRoot: string;
    let endProj: string;
    let endRun: Run;

    beforeAll(() => {
      endRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-status-end-"));
      const repo = path.join(endRoot, "repo");
      fs.mkdirSync(repo, { recursive: true });
      endProj = path.join(endRoot, "projects");
      const tdir = path.join(endProj, encodeProjectDir(repo));
      fs.mkdirSync(tdir, { recursive: true });
      const tfile = path.join(tdir, "s.jsonl");
      fs.writeFileSync(tfile, JSON.stringify({ type: "assistant", slug: "done", message: { stop_reason: "end_turn" } }) + "\n");
      fs.utimesSync(tfile, NOW / 1000, NOW / 1000);
      endRun = {
        key: "ASM-10", summary: "finished", url: "https://x/ASM-10", createdAt: 1, mode: "per-window",
        repos: [{ name: "repo", path: repo, isGit: true, branch: "main" }], briefPaths: [],
      };
    });

    afterAll(() => fs.rmSync(endRoot, { recursive: true, force: true }));

    // An agent that handed control back and closed is not "exited" — it finished.
    it("does not promote a finished turn to exited, however old", () => {
      const s = buildRunStatus({ run: endRun, ticket: null, projectsRoot: endProj, nowMs: NOW + 6 * 60 * 60_000 });
      expect(s.agent.state).toBe("needs-you");
    });
  });
```

- [ ] **Step 2: Run the tests and verify they fail**

```bash
npx vitest run test/unit/engine/bucket.test.ts test/unit/engine/status.test.ts
```

Expected: FAIL — `expected 'progress' to be 'needs'` for the bucket tests, `expected 'stalled' to be 'exited'` for the promotion test.

- [ ] **Step 3: Route the two states in `deriveBucket`**

In `src/engine/bucket.ts`, replace line 36:

```ts
  if (i.agentState === "needs-you" || i.prBlocked) return "needs";
```

with:

```ts
  // stalled and exited join needs-you here: all three mean a human has to do
  // something, and all three used to arrive as "idle" and land in progress.
  if (i.agentState === "needs-you" || i.agentState === "stalled" || i.agentState === "exited" || i.prBlocked) {
    return "needs";
  }
```

Update the ladder comment at line ~20 to name them:

```ts
 *   signal, a stalled or exited agent, or a blocked PR) → the live "working"
 *   signal → review (an open PR /
```

- [ ] **Step 4: Promote to `exited` in `buildRunStatus`**

In `src/engine/status.ts`, replace the `const agent = mostActive([...])` assignment (lines ~68-71) with:

```ts
  const reduced = mostActive([
    ...agents.map((a) => a.activity),
    ...activityRepos.map((r) => readAgentActivity(projectsRoot, r.path, r.branch ?? null, nowMs)),
  ]);
  // A transcript that stops mid-work with no live session behind it did not
  // finish — the agent died holding the work. "idle" renders that in the calmest
  // tone on the board, which is exactly backwards. Liveness is invisible to a
  // per-file reducer, so the promotion happens here, against the session
  // registry this function already reads.
  //
  // Deliberately narrow: "has a transcript, no live session" would be half the
  // board on a working machine, and `parked` already says "nothing is running
  // here". This fires only when work was actually in flight.
  const agent: AgentActivity =
    reduced.midWork && agents.length === 0 ? { ...reduced, state: "exited" } : reduced;
```

The `AgentActivity` type is already imported at the top of the file.

- [ ] **Step 5: Run the tests and verify they pass**

```bash
npx vitest run test/unit/engine/bucket.test.ts test/unit/engine/status.test.ts
```

- [ ] **Step 6: Run the gates**

```bash
npm run typecheck && npm test && npm run build && npm run test:cov
```

- [ ] **Step 7: Commit**

```bash
git add src/engine/status.ts src/engine/bucket.ts test/unit/engine/status.test.ts test/unit/engine/bucket.test.ts
git commit -m "feat(deck): promote a dead mid-work agent to exited, route both new states to needs"
```

---

### Task 5: Carry usage to the card

**Files:**
- Modify: `src/types.ts` (`RunStatus`)
- Modify: `src/deckView.ts` (sweep timer beside `POLL_MS` at line 48 / `setInterval` at line 1499; attach in the status build)
- Test: `test/unit/engine/status.test.ts` or a new `test/unit/deckViewUsage.test.ts` — see Step 1

**Interfaces:**
- Consumes: `UsageReader.readRun` (Task 2), `UsageTotals` (Task 1).
- Produces: `RunStatus.usage?: UsageTotals`, consumed by Task 7's renderer.

- [ ] **Step 1: Write the failing test**

The sweep's timer plumbing is not worth a test harness; the **aggregation** is. Add to `test/unit/engine/usageFs.test.ts`:

```ts
describe("UsageReader as the Deck uses it", () => {
  let projects: string;
  beforeEach(() => { projects = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-usage-deck-")); });
  afterEach(() => fs.rmSync(projects, { recursive: true, force: true }));

  const seed = (cwd: string, rid: string, out: number, cacheRead = 0) => {
    const dir = path.join(projects, encodeProjectDir(cwd));
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${rid}.jsonl`), row(rid, out, cacheRead) + "\n");
  };

  // One reader instance is held for the host's lifetime, and several runs share
  // it. A per-file cache must not let one run's sweep consume another's bytes.
  it("gives each run its own total from one shared reader", () => {
    seed("/wt/task-a", "a1", 10);
    seed("/wt/task-b", "b1", 20);
    const r = new UsageReader();
    expect(r.readRun(projects, ["/wt/task-a"]).output).toBe(10);
    expect(r.readRun(projects, ["/wt/task-b"]).output).toBe(20);
    expect(r.readRun(projects, ["/wt/task-a"]).output).toBe(10);
  });

  it("grows a run's total as its transcript grows across sweeps", () => {
    seed("/wt/task-a", "a1", 10);
    const r = new UsageReader();
    expect(r.readRun(projects, ["/wt/task-a"]).output).toBe(10);
    seed("/wt/task-a", "a2", 5);
    expect(r.readRun(projects, ["/wt/task-a"]).output).toBe(15);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npx vitest run test/unit/engine/usageFs.test.ts -t "as the Deck uses it"
```

Expected: FAIL. (If `readRun` from Task 2 already satisfies these, that is a real pass, not a vacuous one — the tests describe the multi-run sharing contract Task 2 did not cover. Note it and continue.)

- [ ] **Step 3: Add the field to `RunStatus`**

In `src/types.ts`, add to the `RunStatus` interface:

```ts
  /** Cumulative token usage across this run's sessions, absent until the usage
   * sweep has read it. Absent and zero are NOT the same: a run not yet measured
   * must not render like one that cost nothing, so the card shows no figure for
   * `undefined` rather than "0". */
  usage?: UsageTotals;
```

Import the type at the top of `src/types.ts`:

```ts
import type { UsageTotals } from "./engine/usage";
```

`src/engine/usage.ts` imports nothing, so this adds no dependency to anything.

- [ ] **Step 4: Sweep and attach in `deckView.ts`**

Beside `POLL_MS` (line 48):

```ts
/** The usage sweep's own cadence. Deliberately far slower than POLL_MS: parsing
 * transcripts is the one read here that scales with corpus size rather than with
 * board size, and `refresh()` must never block on it. */
export const USAGE_POLL_MS = 60_000;
```

Add fields to the class beside `private timer`:

```ts
  private usageTimer: ReturnType<typeof setInterval> | undefined;
  /** Held for the view's lifetime — its per-file offsets and dedup sets are what
   * make each sweep cost only the newly appended bytes. */
  private readonly usage = new UsageReader();
  /** run key → last swept totals. Read by the status build; written only by the
   * sweep, so a refresh never waits on a parse. */
  private usageByRun = new Map<string, UsageTotals>();
```

Import them:

```ts
import { UsageReader } from "./engine/usageFs";
import type { UsageTotals } from "./engine/usage";
```

Add the sweep method:

```ts
  /** Re-read usage for every run currently on the board. Board-scoped on
   * purpose: the full corpus is hundreds of files and hundreds of megabytes,
   * while a board is about ten project dirs. Never throws — a failed read
   * leaves the previous total in place. */
  private sweepUsage(runs: Run[]): void {
    const root = claudeProjectsRoot();
    const next = new Map<string, UsageTotals>();
    // (see Step 4a below for claudeProjectsRoot)
    for (const run of runs) {
      try {
        next.set(run.key, this.usage.readRun(root, run.repos.map((r) => r.path)));
      } catch {
        const prev = this.usageByRun.get(run.key);
        if (prev) next.set(run.key, prev);
      }
    }
    this.usageByRun = next;
  }
```

**Step 4a — hoist the projects-root expression.** There is no shared helper today: `src/deckView.ts:2075` computes it inline as a local const.

```ts
const projectsRoot = path.join(os.homedir(), ".claude", "projects");
```

Add a module-level function near the top of `src/deckView.ts`:

```ts
/** ~/.claude/projects — where Claude Code keeps one directory of transcripts per
 * cwd. Hoisted from the inline const the status build used, so the usage sweep
 * and the activity read cannot drift onto two different roots. */
function claudeProjectsRoot(): string {
  return path.join(os.homedir(), ".claude", "projects");
}
```

Then replace the inline const at line 2075 with `const projectsRoot = claudeProjectsRoot();`. Both callers now share one derivation. A function rather than a module-level const because `os.homedir()` at import time is a needless load-order dependency in a module the extension host loads early.

Start the timer next to the existing one at line ~1499, and run one sweep immediately so the first board is not blank:

```ts
    this.timer = setInterval(() => void this.refresh(), POLL_MS);
    // One sweep now, then on its own slow cadence. Not awaited: a blank spend
    // figure for a few seconds is strictly better than a delayed board.
    void Promise.resolve().then(() => this.sweepUsage(this.sweepTargets()));
    this.usageTimer = setInterval(() => this.sweepUsage(this.sweepTargets()), USAGE_POLL_MS);
```

Add `sweepTargets()` using the **same** enumeration the status build already uses at `src/deckView.ts:2074`, so the sweep can never cover a different set of runs than the board shows:

```ts
  /** The runs the board shows: tracked records on disk plus the in-memory local
   * cards. Same filter as the status build — a review run has no agent and no
   * transcripts, so it has no spend to read. */
  private sweepTargets(): Run[] {
    return [
      ...readRuns(defaultRunsDir()).filter((r) => runKind(r) !== "review"),
      ...this.localRuns.values(),
    ];
  }
```

`readRuns`, `defaultRunsDir` and `runKind` are already imported in this file.

Dispose it wherever `this.timer` is cleared:

```ts
    if (this.usageTimer) clearInterval(this.usageTimer);
```

Finally, attach the totals where each `RunStatus` is assembled for the webview (the same place `shelf` is overwritten — grep for `shelf: "board"` and its overwrite in `buildAll`):

```ts
      usage: this.usageByRun.get(status.run.key),
```

- [ ] **Step 5: Run the tests and verify they pass**

```bash
npx vitest run test/unit/engine/usageFs.test.ts
```

- [ ] **Step 6: Run the gates**

```bash
npm run typecheck && npm test && npm run build && npm run test:cov
```

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/deckView.ts test/unit/engine/usageFs.test.ts
git commit -m "feat(deck): sweep transcript usage on its own cadence and attach it to each run"
```

---

### Task 6: `cardActions` — one action per PR failure

**Files:**
- Modify: `src/webview/deckSignal.ts`
- Test: `test/webview/deckSignal.test.ts` (extend)

**Interfaces:**
- Consumes: `leadPr` (already private in `deckSignal.ts`).
- Produces: `PrWorkReason = "ci" | "conflict" | "review"` and `SignalAction { tone, text, label, reason, detail? }`; `cardActions(r: RunStatus): SignalAction[]`. Task 7 renders these; Task 8's host message takes `reason` and `detail`.

- [ ] **Step 1: Write the failing tests**

Append to `test/webview/deckSignal.test.ts`. It already has `facts`, `repo`, `status` and `pr` helpers at the top of the file — use them.

```ts
import { cardActions } from "../../src/webview/deckSignal";

describe("cardActions", () => {
  it("returns nothing for a run with no PR", () => {
    expect(cardActions(status())).toEqual([]);
  });

  it("returns nothing for a healthy open PR", () => {
    expect(cardActions(status({ prs: pr(facts({ review: "approved", mergeable: "clean" })) }))).toEqual([]);
  });

  it("names the failing checks and offers Fix CI", () => {
    const acts = cardActions(status({
      prs: pr(facts({ ci: { passing: 1, pending: 0, failing: [{ name: "integration", url: "" }, { name: "lint", url: "" }] } })),
    }));
    expect(acts).toHaveLength(1);
    expect(acts[0].label).toBe("Fix CI");
    expect(acts[0].reason).toBe("ci");
    expect(acts[0].text).toContain("integration");
    expect(acts[0].text).toContain("lint");
    expect(acts[0].detail).toBe("integration, lint");
  });

  // Mirrors prSignals' `blocked` rule: an advisory failure does not block a
  // merge, so it must not put a Fix CI button on the card either.
  it("ignores an advisory CI failure", () => {
    const acts = cardActions(status({
      prs: pr(facts({ ciAdvisory: true, ci: { passing: 0, pending: 0, failing: [{ name: "flaky", url: "" }] } })),
    }));
    expect(acts).toEqual([]);
  });

  it("offers Resolve conflict for a conflicting PR", () => {
    const acts = cardActions(status({ prs: pr(facts({ mergeable: "conflicting" })) }));
    expect(acts.map((a) => a.reason)).toEqual(["conflict"]);
    expect(acts[0].label).toBe("Resolve conflict");
  });

  it("offers Address review when changes are requested", () => {
    const acts = cardActions(status({ prs: pr(facts({ review: "changes_requested" })) }));
    expect(acts.map((a) => a.reason)).toEqual(["review"]);
    expect(acts[0].label).toBe("Address review");
  });

  // The card the whole feature exists for: one "Address PR" cannot name which of
  // three problems it will work on.
  it("returns all three, worst first, when a PR has every problem at once", () => {
    const acts = cardActions(status({
      prs: pr(facts({
        ci: { passing: 0, pending: 0, failing: [{ name: "integration", url: "" }] },
        mergeable: "conflicting", review: "changes_requested",
      })),
    }));
    expect(acts.map((a) => a.reason)).toEqual(["ci", "conflict", "review"]);
  });

  // GitHub stops computing mergeability once a PR closes, so a merged PR's
  // "conflicting" is stale — and there is nothing to act on regardless.
  it("returns nothing for a merged PR, whatever its stale fields say", () => {
    expect(cardActions(status({
      prs: pr(facts({ state: "MERGED", mergeable: "conflicting", review: "changes_requested" })),
    }))).toEqual([]);
  });

  it("returns nothing for a draft PR — it is not asking for anything yet", () => {
    expect(cardActions(status({
      prs: pr(facts({ isDraft: true, ci: { passing: 0, pending: 0, failing: [{ name: "lint", url: "" }] } })),
    }))).toEqual([]);
  });

  it("reads the same lead PR as cardSignal does", () => {
    const prs = {
      zzz: { facts: facts({ number: 1, mergeable: "clean", review: "approved" }), fetchedAt: 1 },
      aaa: { facts: facts({ number: 2, ci: { passing: 0, pending: 0, failing: [{ name: "e2e", url: "" }] } }), fetchedAt: 1 },
    } as unknown as PrEntryMap;
    const acts = cardActions(status({ prs }));
    const bits = cardSignal(status({ prs }), null);
    expect(acts[0].reason).toBe("ci");
    // cardSignal leads with the same PR's number, so the two can never disagree.
    expect(bits[0]).toMatchObject({ text: "#2" });
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

```bash
npx vitest run test/webview/deckSignal.test.ts
```

Expected: FAIL — `cardActions is not a function` / no exported member.

- [ ] **Step 3: Implement `cardActions`**

Append to `src/webview/deckSignal.ts`:

```ts
/** Why an agent is being seeded against a PR. Travels to the host on
 * `deck:seedPrWork`, which turns it into the prompt's opening clause. */
export type PrWorkReason = "ci" | "conflict" | "review";

/** One thing wrong with this card's PR, and the verb that fixes it. */
export interface SignalAction {
  tone: "bad" | "warn";
  /** What is wrong, in the card's own voice: "✗ integration, lint". */
  text: string;
  /** The button. A verb, naming the work — never a generic "Address PR". */
  label: string;
  reason: PrWorkReason;
  /** Specifics for the seeded prompt, e.g. the failing check names. */
  detail?: string;
}

/**
 * Every problem standing between this card's PR and a merge, worst first.
 *
 * Replaces the single `Address PR` button, which was gated on the review
 * column's waiting lane and so appeared on cards with nothing to address while
 * missing cards with a failing check. Each row here names its own problem and
 * carries its own verb.
 *
 * Reads `leadPr` — the same PR `cardSignal` speaks for — so the rows can never
 * contradict the bits they replace.
 */
export function cardActions(r: RunStatus): SignalAction[] {
  const f = leadPr(r);
  // Nothing to act on unless a PR is open and out of draft: GitHub stops
  // computing mergeability once a PR closes, so a merged PR's `conflicting` is
  // stale, and a draft is not asking for anything yet.
  if (!f || f.state !== "OPEN" || f.isDraft) return [];

  const out: SignalAction[] = [];
  // Same advisory guard as prSignals' `blocked` rule: a failure that does not
  // block the merge must not put a button on the card.
  if (f.ci.failing.length > 0 && !f.ciAdvisory) {
    const names = f.ci.failing.map((c) => c.name).join(", ");
    out.push({ tone: "bad", text: `✗ ${names}`, label: "Fix CI", reason: "ci", detail: names });
  }
  if (f.mergeable === "conflicting") {
    out.push({ tone: "warn", text: "conflicts with main", label: "Resolve conflict", reason: "conflict" });
  }
  if (f.review === "changes_requested") {
    out.push({ tone: "warn", text: "changes requested", label: "Address review", reason: "review" });
  }
  return out;
}
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
npx vitest run test/webview/deckSignal.test.ts
```

- [ ] **Step 5: Run the gates**

```bash
npm run typecheck && npm test && npm run build && npm run test:cov
```

- [ ] **Step 6: Commit**

```bash
git add src/webview/deckSignal.ts test/webview/deckSignal.test.ts
git commit -m "feat(deck): derive one named action per PR failure"
```

---

### Task 7: Render the failure rows and the spend figure

**Files:**
- Modify: `src/webview/DeckApp.tsx` (`Card`, lines ~171-260)
- Modify: `src/webview/deckStyles.ts` (after the `.c-foot2` rule at the end)
- Test: `test/webview/DeckApp.test.tsx` (extend)

**Interfaces:**
- Consumes: `cardActions`, `SignalAction` (Task 6); `weightedEq`, `formatEq` (Task 1); `RunStatus.usage` (Task 5).
- Produces: `deck:seedPrWork` sends, handled in Task 8.

The reference render is `preview/_d3-g2.png`, produced by `preview/d3-options.html` (both gitignored). Reshoot with `node preview/shoot-d3.js` after `npm run build` if the geometry needs checking.

- [ ] **Step 1: Write the failing tests**

Add to `test/webview/DeckApp.test.tsx`. That file's harness is **synchronous** — `host()` wraps the dispatch in `act()`, so assert directly; no `await`, no `waitFor`. Use its existing `mkStatus`, `host`, `runsMsg`, and `sent` (`vi.mocked(send)`).

Add these two fixtures near the other helpers at the top of the file:

```tsx
/** A PR with every problem at once — the card the per-signal actions exist for. */
const failingPr = (): PrFacts => ({
  number: 3181, url: "https://gh/pr/3181", title: "t", state: "OPEN", isDraft: false,
  ci: { passing: 4, pending: 0, failing: [{ name: "integration", url: "" }, { name: "lint", url: "" }] },
  review: "changes_requested", unresolved: null, mergeable: "conflicting", ciAdvisory: false,
});

const healthyPr = (): PrFacts => ({
  number: 2044, url: "https://gh/pr/2044", title: "t", state: "OPEN", isDraft: false,
  ci: { passing: 8, pending: 0, failing: [] },
  review: "approved", unresolved: null, mergeable: "clean", ciAdvisory: false,
});

const withPr = (f: PrFacts, over: Partial<RunStatus> = {}): RunStatus =>
  mkStatus({ prs: { svc: { facts: f, fetchedAt: 1 } }, ...over } as Partial<RunStatus>);
```

Then the tests, in a new describe block:

```tsx
describe("DeckApp card anatomy", () => {
  beforeEach(() => sent.mockClear());

  it("shows a named button for each PR failure", () => {
    render(<DeckApp />);
    host(runsMsg([withPr(failingPr(), { column: "needs" })]));
    expect(screen.getByRole("button", { name: "Fix CI" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resolve conflict" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Address review" })).toBeTruthy();
  });

  it("no longer offers a generic Address PR", () => {
    render(<DeckApp />);
    host(runsMsg([withPr(failingPr(), { column: "review" })]));
    expect(screen.queryByRole("button", { name: "Address PR" })).toBeNull();
  });

  it("sends deck:seedPrWork with the reason for the button pressed", () => {
    render(<DeckApp />);
    host(runsMsg([withPr(failingPr(), { column: "needs" })]));
    fireEvent.click(screen.getByRole("button", { name: "Resolve conflict" }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:seedPrWork", key: "ASM-1", reason: "conflict" });
  });

  it("carries the failing check names as the ci action's detail", () => {
    render(<DeckApp />);
    host(runsMsg([withPr(failingPr(), { column: "needs" })]));
    fireEvent.click(screen.getByRole("button", { name: "Fix CI" }));
    expect(sent).toHaveBeenCalledWith({
      type: "deck:seedPrWork", key: "ASM-1", reason: "ci", detail: "integration, lint",
    });
  });

  it("keeps the ordinary signal line on a healthy card", () => {
    render(<DeckApp />);
    host(runsMsg([withPr(healthyPr())]));
    expect(screen.getByText(/✓ ci/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Fix CI" })).toBeNull();
  });

  it("prints the spend figure in eq, not tok", () => {
    render(<DeckApp />);
    // weightedEq({cacheRead: 3_804_000}) = 380,400 → formatEq → "380k"
    host(runsMsg([withPr(healthyPr(), { usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 3_804_000 } })]));
    expect(screen.getByText("380k")).toBeTruthy();
    expect(screen.queryByText(/tok/)).toBeNull();
  });

  // Absent and zero must not look alike: a run the sweep has not reached has not
  // been measured, and "0" would assert it cost nothing.
  it("shows no figure at all when usage has not been swept", () => {
    render(<DeckApp />);
    host(runsMsg([withPr(healthyPr(), { usage: undefined })]));
    expect(screen.getByText(/✓ ci/)).toBeTruthy();
    expect(document.querySelector(".c-foot2 .spend")).toBeNull();
  });

  it("shows no figure for genuinely zero usage either", () => {
    render(<DeckApp />);
    host(runsMsg([withPr(healthyPr(), { usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } })]));
    expect(document.querySelector(".c-foot2 .spend")).toBeNull();
  });

  it("totals the board's spend in the header", () => {
    render(<DeckApp />);
    const a = withPr(healthyPr(), { usage: { input: 0, output: 20_000, cacheWrite: 0, cacheRead: 0 } });
    const b = withPr(healthyPr(), {
      run: { ...mkStatus().run, key: "ASM-2" },
      usage: { input: 0, output: 20_000, cacheWrite: 0, cacheRead: 0 },
    });
    host(runsMsg([a, b]));
    // 2 × (20,000 × 5) = 200,000 → "200k"
    expect(screen.getByText("200k")).toBeTruthy();
  });
});
```

Note the two `.spend` assertions query the DOM directly rather than by text: a `queryByText(/eq/)` would also match the word inside any tooltip or label, and would pass for the wrong reason.

- [ ] **Step 2: Run the tests and verify they fail**

```bash
npx vitest run test/webview/DeckApp.test.tsx
```

Expected: FAIL — no `Fix CI` button, no `380k`.

- [ ] **Step 3: Render the rows and the figure**

In `src/webview/DeckApp.tsx`, add the imports:

```ts
import { cardActions, cardSignal } from "./deckSignal";
import { formatEq, weightedEq } from "../engine/usage";
```

`src/engine/usage.ts` imports nothing, so it is safe for the browser bundle. Task 7's own gate run proves it — `npm run build` is the only check that would catch a violation here.

Inside `Card`, replace the `canAddressPr` computation (line ~171) with:

```ts
  // Every reason to address a PR now has its own row and its own verb, so the
  // old single gated button could only ever duplicate one of them. The lane gate
  // goes with it: it put Address PR on cards with nothing to address, and
  // withheld it from cards with a failing check.
  const acts = local ? [] : cardActions(r);
```

The `local` guard is preserved from `canAddressPr` and matters: a local card's ticket is inferred from a branch name that may belong to somebody else's ticket, and seeding an agent against that inference on one click is what this must never do. The host re-checks it anyway.

Compute the spend figure:

```ts
  // Absent and zero render identically as "no figure": a run the sweep has not
  // reached has not been measured, and printing 0 would assert it cost nothing.
  const eq = r.usage ? weightedEq(r.usage) : 0;
  const spend = eq > 0 ? formatEq(eq) : null;
```

Replace the signal-line block (the `{sigBits.length > 0 && (…)}` JSX) with:

```tsx
      {acts.length > 0 ? (
        /* The failure rows REPLACE the signal line rather than joining it: the
           bits it would show (#pr, ✗ check, conflicts) name the very facts these
           rows name, and restating them above the actions is noise. A failing
           card therefore stops showing its branch and diff totals — the correct
           trade, since "how big" already loses to "what is wrong" in
           cardSignal's own cap, and both remain in the detail drawer. */
        <div className="c-rows" onClick={(e) => e.stopPropagation()}>
          {acts.map((a, i) => (
            <div className="c-row" key={a.reason}>
              {i === 0 && leadPrNumber !== null && <span className="m">#{leadPrNumber}</span>}
              <span className={`lbl ${a.tone}`}>{a.text}</span>
              <button
                className="act"
                title={`${a.label} — open this task's workspace and work through it`}
                onClick={() => send({ type: "deck:seedPrWork", key: r.run.key, reason: a.reason, ...(a.detail ? { detail: a.detail } : {}) })}
              >
                {a.label}
              </button>
            </div>
          ))}
        </div>
      ) : sigBits.length > 0 ? (
        <div className="c-sig">
          {sigBits.map((b, i) => (
            <React.Fragment key={i}>
              {i > 0 && <span className="sep">·</span>}
              {b.kind === "diff"
                ? <span className="c-diff"><span className="add">+{b.added}</span><span className="del">−{b.removed}</span></span>
                : <span className={`${b.mono ? "m" : ""} ${b.tone ?? ""}`.trim()} title={b.mono ? b.text : undefined}>{b.text}</span>}
            </React.Fragment>
          ))}
        </div>
      ) : null}
```

`leadPrNumber` is the PR number for the first row. Rather than re-deriving it, take it from the signal bits, which already lead with it — add beside `sigBits`:

```ts
  // sigBits[0] is the lead PR's number whenever this card has a PR; cardActions
  // reads the same lead PR, so the two cannot disagree.
  const firstBit = sigBits[0];
  const leadPrNumber = firstBit?.kind === "text" && firstBit.text.startsWith("#") ? firstBit.text.slice(1) : null;
```

Add the figure to the footer, after the buttons:

```tsx
        {spend && (
          <span className="spend" title="Effort-weighted tokens across every session in this task's directories (input×1, cache-write×1.25, cache-read×0.1, output×5)">
            {spend}<span className="u">eq</span>
          </span>
        )}
```

Then delete the now-unused `canAddressPr` JSX block (the `{canAddressPr && (<button … Address PR</button>)}` in `.c-foot2`).

In `DeckApp`, add the header stat beside the existing counts. Find the `.stats` block and add:

```tsx
        {boardEq > 0 && (
          <div className="stat">
            <span className="n">{formatEq(boardEq)}</span>
            <span className="l">Tokens on board</span>
          </div>
        )}
```

with, above the return:

```ts
  // The board's own total, not "today": a day figure would need per-line
  // timestamps and would print a number that disagrees with the cards under it.
  const boardEq = runs.reduce((s, x) => s + (x.usage ? weightedEq(x.usage) : 0), 0);
```

- [ ] **Step 4: Add the styles**

Append to `src/webview/deckStyles.ts`, after the `.c-foot2` rule:

```ts
  /* The spend figure. A count, so it is mono — the deck's rule is mono for
     identifiers and counts, prose in the UI font. It sits in the footer's dead
     right side: on the top row it wraps the ticket key onto a second line
     whenever the state text is long, and on the signal line it breaks the
     three-bit cap and truncates the branch further. */
  .c-foot2 .spend { margin-left: auto; align-self: center; flex: none;
    font-family: var(--vscode-editor-font-family); font-size: 11px;
    color: var(--dim); white-space: nowrap; }
  .c-foot2 .spend .u { font-family: var(--vscode-font-family); opacity: .55; margin-left: 2px; }

  /* One row per PR failure, each with the verb that fixes it. These REPLACE the
     signal line on a failing card, so a card is never taller than the problems
     it actually has — and a card with three failures grows past the 152px floor,
     which is the intended trade: attention should follow size. */
  .c-rows { display: flex; flex-direction: column; gap: 5px; }
  .c-row { display: flex; align-items: center; gap: 7px; overflow: hidden;
    font-size: 11.5px; color: var(--dim); }
  /* The elastic member: a long list of failing check names takes the ellipsis
     rather than pushing the button off the card. */
  .c-row > .lbl { flex: 0 1 auto; min-width: 0; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  .c-row > .m { flex: none; font-family: var(--vscode-editor-font-family); }
  .c-row .bad, .c-row .warn { color: var(--c-attn); }
  .c-row .act { margin-left: auto; flex: none; height: 20px; padding: 0 7px; font-size: 11px; }
```

- [ ] **Step 5: Run the tests and verify they pass**

```bash
npx vitest run test/webview/DeckApp.test.tsx
```

- [ ] **Step 6: Run the gates**

```bash
npm run typecheck && npm test && npm run build && npm run test:cov
```

**`npm run build` matters most in this task.** It is the only gate that catches `src/webview/DeckApp.tsx` reaching a Node builtin through the new `../engine/usage` import. If it fails with a `fs`/`path`/`os` resolution error, `usage.ts` gained an import it must not have.

- [ ] **Step 7: Commit**

```bash
git add src/webview/DeckApp.tsx src/webview/deckStyles.ts test/webview/DeckApp.test.tsx
git commit -m "feat(deck): a row and a named action per PR failure, spend on the footer"
```

---

### Task 8: `deck:seedPrWork` on the host

**Files:**
- Modify: `src/types.ts` (message union, line ~523)
- Modify: `src/engine/prompt.ts` (add `prWorkClause`)
- Modify: `src/deckView.ts:2596-2597` (dispatch) and `:3133` (`addressPr` → `seedPrWork`)
- Test: `test/unit/engine/prompt.test.ts` (extend)

**Interfaces:**
- Consumes: `PrWorkReason` (Task 6), `prReviewTemplate` (existing).
- Produces: `prWorkClause(reason: PrWorkReason, detail?: string): string`. Terminal task — nothing consumes it.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/engine/prompt.test.ts`:

```ts
import { prWorkClause } from "../../../src/engine/prompt";

describe("prWorkClause", () => {
  it("names the failing checks for a ci reason", () => {
    const c = prWorkClause("ci", "integration, lint");
    expect(c).toContain("integration, lint");
    expect(c.toLowerCase()).toContain("failing");
  });

  it("still says something useful for ci with no detail", () => {
    expect(prWorkClause("ci").toLowerCase()).toContain("failing");
  });

  it("tells the agent to rebase for a conflict reason", () => {
    expect(prWorkClause("conflict").toLowerCase()).toContain("rebase");
  });

  // The review path must stay byte-identical to what Address PR sent before, so
  // an existing user's configured prReviewPrompt reaches the agent unchanged.
  it("adds nothing for a review reason", () => {
    expect(prWorkClause("review")).toBe("");
  });

  it("never interpolates a detail into a regex replacement position", () => {
    // Detail is derived from check names, which are user-controlled on GitHub.
    expect(prWorkClause("ci", "$& $1 $'")).toContain("$& $1 $'");
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

```bash
npx vitest run test/unit/engine/prompt.test.ts
```

Expected: FAIL — no exported member `prWorkClause`.

- [ ] **Step 3: Add the clause builder**

Append to `src/engine/prompt.ts`:

```ts
/**
 * The opening clause that turns a generic PR-review prompt into one about the
 * specific thing wrong with the PR.
 *
 * `review` returns the empty string on purpose: that path must stay byte-identical
 * to what `Address PR` sent before this existed, so a user's configured
 * `prReviewPrompt` reaches the agent exactly as it always did.
 *
 * String concatenation only — never String.replace. `detail` comes from GitHub
 * check names, which are user-authored, and `$&`/`$1`/`$'` in a replacement
 * position would corrupt the prompt.
 */
export function prWorkClause(reason: PrWorkReason, detail?: string): string {
  switch (reason) {
    case "ci":
      return detail
        ? `CI is failing on this PR (${detail}). Find out why and make it pass.`
        : "CI is failing on this PR. Find out why and make it pass.";
    case "conflict":
      return "This PR conflicts with its base branch. Rebase it onto the base and resolve the conflicts.";
    case "review":
      return "";
  }
}
```

Import the type at the top of `src/engine/prompt.ts`:

```ts
import type { PrWorkReason } from "../webview/deckSignal";
```

If `src/engine/prompt.ts` importing from `src/webview/` is against the grain of this codebase (check whether any other `engine/` module does), move `PrWorkReason` to `src/types.ts` instead and import it from there in both places. `src/types.ts` is the shared vocabulary both sides already use — prefer that if there is any doubt.

- [ ] **Step 4: Add the message and the handler**

In `src/types.ts`, after the `deck:addressPr` line:

```ts
  | { type: "deck:seedPrWork"; key: string; reason: PrWorkReason; detail?: string }
```

Keep `deck:addressPr` exactly as it is. The webview ships with the host so the old message is not strictly reachable, but this extension has thousands of installs and a stale webview must not hit an unknown message type.

In `src/deckView.ts`, at the dispatch (line ~2596):

```ts
      case "deck:addressPr":
        // Retained alias: the review reason is exactly what this message meant.
        await this.seedPrWork(m.key, "review");
        break;
      case "deck:seedPrWork":
        await this.seedPrWork(m.key, m.reason, m.detail);
        break;
```

Rename `addressPr` (line ~3133) to `seedPrWork` and take the two new parameters. The **only** change to its body is the template line:

```ts
  private async seedPrWork(key: string, reason: PrWorkReason, detail?: string): Promise<void> {
```

and:

```ts
    const cfg = getConfig();
    const clause = prWorkClause(reason, detail);
    // The user's configured review prompt, preceded by what is actually wrong.
    // An empty clause (reason "review") leaves the template byte-identical to
    // what Address PR has always sent.
    const template = clause
      ? `${clause}\n\n${prReviewTemplate(cfg.prReviewPrompt, cfg.prReviewAutoFix)}`
      : prReviewTemplate(cfg.prReviewPrompt, cfg.prReviewAutoFix);
```

Everything else in that method — the `local` guard and its comment, `ticketKeyFor`, the multiroot/per-window `matches` split, `writePlanFile`, the collected-failures toast, the `seedAgent`-off toast — stays exactly as written. Update the `local` guard's log line to the new name:

```ts
      this.log(`deck: seedPrWork ignored for local card ${key}`);
```

Import the clause builder alongside the existing prompt imports:

```ts
import { composeAgentPrompt, hasNote, prReviewTemplate, prWorkClause } from "./engine/prompt";
```

- [ ] **Step 5: Run the tests and verify they pass**

```bash
npx vitest run test/unit/engine/prompt.test.ts
```

- [ ] **Step 6: Run the gates**

```bash
npm run typecheck && npm test && npm run build && npm run test:cov
```

- [ ] **Step 7: Verify the whole feature in a dev host**

`npm run build`, then launch with **VS Code's** `code` CLI — the Cursor CLI silently drops `--extensionDevelopmentPath`:

```bash
code --extensionDevelopmentPath=/Users/oznasi/dev/agent-flow/.claude/worktrees/d3-card-anatomy .
```

Open the Deck and confirm: a spend figure on cards, `eq` not `tok`, a stuck agent reading `stalled` rather than `idle`, and a failing PR showing a named button per failure.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/engine/prompt.ts src/deckView.ts test/unit/engine/prompt.test.ts
git commit -m "feat(deck): seed PR work against the specific failure, not a generic verb"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task:

| Spec section | Task |
|---|---|
| Effort-weighted figure, four classes stored | 1 |
| Dedup by `requestId` | 1 |
| Incremental reader, `pendingTail`, truncation, fast path | 2 |
| Board-scoped dirs, off the 6s tick, 60s cadence | 5 |
| No branch join, tooltip states scope | 2 (reader), 7 (tooltip) |
| `AgentState` widening, three `Record` maps | 3 |
| `stalled` derivation | 3 |
| `midWork` + `exited` promotion | 3 (field), 4 (promotion) |
| `STATE_RANK` ordering | 3 |
| `stalled`/`exited` → `needs` | 4 |
| `deck:seedPrWork` + alias | 8 |
| Reason clause, no new config | 8 |
| `cardActions` | 6 |
| `.c-rows` replaces `.c-sig`, spend on footer | 7 |
| Header total | 7 |
| Absent ≠ zero | 5 (field doc), 7 (render + 2 tests) |
| Error handling: unreadable file/dir, malformed line, missing fields | 1, 2 |

**Type consistency.** `UsageTotals` fields (`input`, `output`, `cacheWrite`, `cacheRead`) are identical in Tasks 1, 2, 5, 7. `PrWorkReason` values (`"ci" | "conflict" | "review"`) match across Tasks 6, 7, 8. `SignalAction` fields match between the definition in Task 6 and the render in Task 7. `midWork` is optional in Task 3 and read as possibly-undefined in Task 4. `accumulateUsage(lines, into, seen)` has the same three-parameter shape in Tasks 1 and 2.

**One open question flagged for the implementer, not left as a placeholder:** Task 8 Step 3 notes that `src/engine/prompt.ts` importing a type from `src/webview/deckSignal.ts` may cut against the codebase's layering, and gives the specific alternative (move `PrWorkReason` into `src/types.ts`) with the rule for choosing. Both paths are fully specified.
