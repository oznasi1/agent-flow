import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { UsageReader } from "../../../src/engine/usageFs";
import { encodeProjectDir } from "../../../src/engine/transcript";

// `import * as fs` produces an ES module namespace object whose properties are
// non-configurable, so `vi.spyOn(fs, "readSync")` cannot redefine it. Replacing
// the whole module (spread the real implementation, override just `readSync`
// via a mutable hook) works because it swaps the module at resolution time
// rather than mutating the namespace object afterward. Default pass-through
// keeps every other test's real filesystem calls unaffected.
const fsHooks = vi.hoisted(() => ({
  readSyncOverride: null as ((...args: unknown[]) => number) | null,
  // The real implementation, for a test's override to delegate to without
  // recursing back through itself via the mocked `fs.readSync` binding.
  realReadSync: null as ((...args: unknown[]) => number) | null,
}));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  fsHooks.realReadSync = actual.readSync as (...a: unknown[]) => number;
  return {
    ...actual,
    readSync: (...args: unknown[]) =>
      fsHooks.readSyncOverride ? fsHooks.readSyncOverride(...args) : fsHooks.realReadSync!(...args),
  };
});

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

  // POSIX permits readSync to return fewer bytes than requested on a regular
  // file, and the file can also be replaced in the window between statSync and
  // readSync. The offset must advance only by what was actually consumed —
  // jumping straight to the stat-derived size would skip the unread remainder
  // forever, since the offset never moves backward.
  it("advances the offset by bytes actually read, not the stat target, on a short read", () => {
    const line1 = row("r1", 10) + "\n";
    const line2 = row("r2", 20) + "\n";
    fs.writeFileSync(file, line1 + line2);

    const shortRead = Buffer.byteLength(line1, "utf8");
    fsHooks.readSyncOverride = (...args: unknown[]) => {
      // Perform the real read (so buf holds genuine file bytes), then report
      // back fewer bytes consumed than were actually requested — exactly what
      // a short read looks like from the caller's perspective.
      fsHooks.realReadSync!(...args);
      return shortRead;
    };

    const r = new UsageReader();
    const first = r.readFile(file);
    fsHooks.readSyncOverride = null;
    expect(first.output).toBe(10); // only line1's bytes were reported consumed

    // No append happened. If the offset had jumped to the stat-derived size on
    // the short read, this second sweep would see size === cached offset and
    // return the stale total (10) forever, silently losing line2.
    const second = r.readFile(file);
    expect(second.output).toBe(30);
  });

  // statSync succeeds on a directory and reports a non-zero size, so the open
  // path is entered; openSync on a directory also succeeds; but readSync then
  // throws EISDIR. That must land in the open/read catch and return zero
  // totals rather than let the exception escape.
  it("is zero (no throw) when the path is a directory", () => {
    expect(new UsageReader().readFile(root).output).toBe(0);
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

  // I1: Claude Code writes subagent transcripts one level down, at
  // <sessionId>/subagents/*.jsonl. Before this, readDir only listed the dir's
  // own top-level files, which silently omitted every subagent transcript —
  // roughly half of real spend on a subagent-heavy run.
  it("recurses into a nested subagents directory", () => {
    fs.writeFileSync(path.join(root, "top.jsonl"), row("r1", 10) + "\n");
    fs.mkdirSync(path.join(root, "sess-1", "subagents"), { recursive: true });
    fs.writeFileSync(path.join(root, "sess-1", "subagents", "sub.jsonl"), row("r2", 20) + "\n");
    expect(new UsageReader().readDir(root).output).toBe(30);
  });

  // A subagent transcript's requestIds are disjoint from its parent's, so
  // recursing must not need (or introduce) any cross-file dedup — each file
  // keeps its own `seen` set via readFile's per-path cache.
  it("sums a nested transcript's own dedup independently of its parent's", () => {
    fs.writeFileSync(path.join(root, "top.jsonl"), [row("shared", 10), row("shared", 10)].join("\n") + "\n");
    fs.mkdirSync(path.join(root, "sess-1", "subagents"), { recursive: true });
    fs.writeFileSync(path.join(root, "sess-1", "subagents", "sub.jsonl"), row("shared", 5) + "\n");
    // top.jsonl dedups its own repeated "shared" id to one count (10); the
    // subagent file's "shared" id is a different file's cache entirely and is
    // not suppressed by the parent having already seen that id.
    expect(new UsageReader().readDir(root).output).toBe(15);
  });

  // The simplest way a recursive directory walk can go wrong: a symlinked
  // directory that points back at an ancestor, which a naive recursion would
  // walk forever. Skipping symlinked entries outright — including this one —
  // is the guard; if it regressed, this test would hang rather than fail fast.
  it("does not hang on a symlinked directory cycle", () => {
    fs.writeFileSync(path.join(root, "top.jsonl"), row("r1", 10) + "\n");
    fs.symlinkSync(root, path.join(root, "loop"), "dir");
    expect(new UsageReader().readDir(root).output).toBe(10);
  }, 2000);
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
