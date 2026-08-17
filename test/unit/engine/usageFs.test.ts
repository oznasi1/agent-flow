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
