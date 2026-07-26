import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { claudeConfigDir, fsReader } from "../../../src/engine/claudeAssetsFs";

// This is the one module that touches the real filesystem, so it is tested
// against a real temp tree rather than an in-memory reader.
let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-assets-"));
  fs.mkdirSync(path.join(root, "skills", "build"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "build", "SKILL.md"), "---\nname: build\n---");
  fs.writeFileSync(path.join(root, "top.txt"), "hello");
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("fsReader", () => {
  it("reads a file's contents", () => {
    expect(fsReader().readFile(path.join(root, "top.txt"))).toBe("hello");
  });

  it("returns null for a missing file instead of throwing", () => {
    expect(fsReader().readFile(path.join(root, "nope.txt"))).toBeNull();
  });

  it("returns null when the path is a directory, not a file", () => {
    expect(fsReader().readFile(path.join(root, "skills"))).toBeNull();
  });

  it("lists a directory with dir/file flags, sorted by name", () => {
    const entries = fsReader().readDir(root);
    expect(entries).toEqual([
      { name: "skills", isDir: true },
      { name: "top.txt", isDir: false },
    ]);
  });

  it("returns an empty list for a missing directory instead of throwing", () => {
    expect(fsReader().readDir(path.join(root, "gone"))).toEqual([]);
  });

  it("identifies directories and rejects files and missing paths", () => {
    const r = fsReader();
    expect(r.isDir(root)).toBe(true);
    expect(r.isDir(path.join(root, "top.txt"))).toBe(false);
    expect(r.isDir(path.join(root, "gone"))).toBe(false);
  });
});

describe("claudeConfigDir", () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  });

  it("defaults to ~/.claude", () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(claudeConfigDir()).toBe(`${os.homedir()}/.claude`);
  });

  it("honours CLAUDE_CONFIG_DIR and strips a trailing slash", () => {
    process.env.CLAUDE_CONFIG_DIR = "/custom/claude/";
    expect(claudeConfigDir()).toBe("/custom/claude");
  });

  it("falls back to ~/.claude when the override is blank", () => {
    process.env.CLAUDE_CONFIG_DIR = "   ";
    expect(claudeConfigDir()).toBe(`${os.homedir()}/.claude`);
  });
});
