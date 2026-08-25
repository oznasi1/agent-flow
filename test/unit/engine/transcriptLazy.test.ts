import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { encodeProjectDir, readAgentActivity, TranscriptLine } from "../../../src/engine/transcript";

/** Every `.jsonl` path read through `fs.readFileSync`, in call order.
 *
 * `vi.mock("fs")` rather than `vi.spyOn(fs, "readFileSync")`: the `fs` namespace
 * object is non-configurable under this vitest setup, so spyOn throws "Cannot
 * redefine property". The factory delegates every other member — and
 * readFileSync itself — to the real module, so this file's own fixture writes and
 * the reads under test all still hit the real filesystem. */
const tap = vi.hoisted(() => ({ reads: [] as string[], on: false }));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const readFileSync = (p: unknown, ...rest: unknown[]): unknown => {
    if (tap.on && typeof p === "string" && p.endsWith(".jsonl")) tap.reads.push(p);
    return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
  };
  return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

/**
 * How MANY transcripts `readAgentActivity` reads — not what it returns.
 *
 * Its own file rather than a block appended to `transcript.test.ts`, for two
 * reasons: that file is the behaviour-preservation proof for the laziness
 * refactor and is worth keeping byte-identical, and every test in it reads real
 * files off disk, which a `readFileSync` spy has no business sitting beside.
 *
 * Why a spy at all: the eager version parsed every `.jsonl` in the project
 * directory before choosing one, and `parseLines` reads a whole file to keep its
 * last 200 lines. On a real long-lived repo (137 files, 356 MB) that was ~1.0s of
 * blocking main-thread I/O per call, paid on every other 6s poll by every window
 * whether or not the Deck is open. The return value cannot see the difference —
 * the choice is identical either way — so only the read count can hold the fix
 * in place.
 */
describe("readAgentActivity read count", () => {
  const NOW = 1_800_000_000_000;
  const cwd = "/repo/lazy";
  let root: string;
  let encDir: string;

  const writeJsonl = (name: string, rows: TranscriptLine[], mtimeMs: number) => {
    const p = path.join(encDir, name);
    fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  };

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-tx-lazy-"));
    encDir = path.join(root, encodeProjectDir(cwd));
    fs.mkdirSync(encDir, { recursive: true });
    // Newest first by mtime: newest.jsonl (feat-c), middle.jsonl (feat-b),
    // oldest.jsonl (feat-a). Three, not two, so "stopped at the match" is
    // distinguishable from "read everything but the last one".
    writeJsonl("oldest.jsonl",
      [{ type: "user", gitBranch: "feat-a" }, { type: "assistant", gitBranch: "feat-a", slug: "aa", message: { stop_reason: "end_turn" } }],
      NOW - 3 * 60 * 60_000);
    writeJsonl("middle.jsonl",
      [{ type: "user", gitBranch: "feat-b" }, { type: "assistant", gitBranch: "feat-b", slug: "bb", message: { stop_reason: "end_turn" } }],
      NOW - 2 * 60 * 60_000);
    writeJsonl("newest.jsonl",
      [{ type: "assistant", gitBranch: "feat-c", slug: "cc", message: { stop_reason: "tool_use" } }],
      NOW - 5_000);
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  /** Which `.jsonl` files this call actually read, in call order. */
  const readsDuring = (f: () => void): string[] => {
    tap.reads = [];
    tap.on = true;
    try {
      f();
    } finally {
      tap.on = false;
    }
    return tap.reads.map((p) => path.basename(p));
  };

  // The spy has to be able to see the module's own reads, or every assertion
  // below would pass on an empty array.
  it("observes the reads at all", () => {
    expect(readsDuring(() => readAgentActivity(root, cwd, null, NOW)).length).toBeGreaterThan(0);
  });

  // The hidden attention path passes `branch: null` for every local place on
  // every tick (engine/attentionFs.ts) — this is the case that was costing a
  // second per call.
  it("reads ONE transcript when no branch is asked for", () => {
    expect(readsDuring(() => readAgentActivity(root, cwd, null, NOW))).toEqual(["newest.jsonl"]);
  });

  it("reads only the newest when the newest is the branch match", () => {
    expect(readsDuring(() => readAgentActivity(root, cwd, "feat-c", NOW))).toEqual(["newest.jsonl"]);
  });

  it("stops at the branch match rather than reading the whole directory", () => {
    // feat-b is the middle file: the oldest must never be opened.
    expect(readsDuring(() => readAgentActivity(root, cwd, "feat-b", NOW))).toEqual([
      "newest.jsonl", "middle.jsonl",
    ]);
  });

  it("reads every transcript only when no branch matches — the one case that needs them all", () => {
    expect(readsDuring(() => readAgentActivity(root, cwd, "feat-none", NOW))).toEqual([
      "newest.jsonl", "middle.jsonl", "oldest.jsonl",
    ]);
  });

  it("does not re-read the newest transcript while walking for a branch", () => {
    // The fallback candidate is parsed once up front; the walk must reuse those
    // lines rather than opening the same file a second time.
    const seen = readsDuring(() => readAgentActivity(root, cwd, "feat-none", NOW));
    expect(seen.filter((f) => f === "newest.jsonl")).toEqual(["newest.jsonl"]);
  });

  // Laziness must not have changed the answer. These four are the same verdicts
  // transcript.test.ts asserts, restated here against the three-file fixture so
  // a read-count test can never be satisfied by reading the wrong file.
  it("still picks the newest transcript when no branch is asked for", () => {
    expect(readAgentActivity(root, cwd, null, NOW).slug).toBe("cc");
  });

  it("still prefers a branch match over the newest", () => {
    expect(readAgentActivity(root, cwd, "feat-b", NOW).slug).toBe("bb");
  });

  it("still reaches the oldest transcript when that is the branch match", () => {
    const a = readAgentActivity(root, cwd, "feat-a", NOW);
    expect(a.slug).toBe("aa");
    expect(a.state).toBe("needs-you");
  });

  it("still falls back to the newest when nothing matches the branch", () => {
    const a = readAgentActivity(root, cwd, "feat-none", NOW);
    expect(a.slug).toBe("cc");
    expect(a.state).toBe("working");
  });
});
