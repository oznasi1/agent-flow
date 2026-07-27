import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveBin, systemLookup } from "../../../../src/engine/pr/which";
import type { BinLookup } from "../../../../src/engine/pr/which";

/** The PATH an extension host inherits from launchd when the editor gives up
 * resolving the user's shell environment. It holds /usr/bin/git but no package
 * manager's bin dir — the whole reason this module exists. */
const BARE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

const lookup = (p: string | undefined, executables: string[], home = "/Users/me"): BinLookup => ({
  path: p,
  home,
  isExecutable: (file) => executables.includes(file),
});

describe("resolveBin", () => {
  it("returns the first PATH directory that holds the binary", () => {
    expect(resolveBin("gh", lookup("/a:/b", ["/a/other", "/b/gh"]))).toBe("/b/gh");
  });

  it("finds a Homebrew gh when PATH is the bare launchd set", () => {
    // Cursor and VS Code both abandon shell-env resolution after 10s ("Unable to
    // resolve your shell environment in a reasonable time"), leaving the
    // extension host with this PATH — under which `execFile("gh", …)` can only
    // ever fail with ENOENT, however signed in the user is.
    expect(resolveBin("gh", lookup(BARE_PATH, ["/opt/homebrew/bin/gh"]))).toBe("/opt/homebrew/bin/gh");
  });

  it("finds an Intel-Homebrew or hand-installed gh", () => {
    expect(resolveBin("gh", lookup(BARE_PATH, ["/usr/local/bin/gh"]))).toBe("/usr/local/bin/gh");
  });

  it("finds a gh under the user's own home, expanded against this home dir", () => {
    expect(resolveBin("gh", lookup(BARE_PATH, ["/Users/me/.local/bin/gh"]))).toBe("/Users/me/.local/bin/gh");
  });

  it("prefers PATH over the fallback dirs", () => {
    expect(resolveBin("gh", lookup("/first", ["/first/gh", "/opt/homebrew/bin/gh"]))).toBe("/first/gh");
  });

  it("is null when no directory has it", () => {
    expect(resolveBin("gh", lookup(BARE_PATH, []))).toBeNull();
  });

  it("still searches the fallbacks when PATH is unset entirely", () => {
    expect(resolveBin("gh", lookup(undefined, ["/opt/homebrew/bin/gh"]))).toBe("/opt/homebrew/bin/gh");
  });

  it("ignores empty PATH entries rather than resolving a bare, relative name", () => {
    // An empty entry means "the cwd" to a shell, and path.join("", "gh") is the
    // relative "gh" — never something to hand to execFile as a located binary.
    expect(resolveBin("gh", lookup("::/x", ["gh"]))).toBeNull();
  });
});

describe("systemLookup", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-which-")); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const look = () => ({ ...systemLookup(), path: dir });
  /** Not `gh`: the fallback dirs are absolute and unmockable, so a real
   * /opt/homebrew/bin/gh on the developer's machine would answer instead. */
  const BIN = "agent-flow-probe";

  it("finds an executable file in a PATH directory", () => {
    fs.writeFileSync(path.join(dir, BIN), "#!/bin/sh\n", { mode: 0o755 });
    expect(resolveBin(BIN, look())).toBe(path.join(dir, BIN));
  });

  it("rejects a file that is not executable", () => {
    fs.writeFileSync(path.join(dir, BIN), "#!/bin/sh\n", { mode: 0o644 });
    expect(resolveBin(BIN, look())).toBeNull();
  });

  it("rejects a directory that merely shares the name", () => {
    // Directories carry the executable bit, so the access test alone would hand
    // execFile a path it can never spawn.
    fs.mkdirSync(path.join(dir, BIN));
    expect(resolveBin(BIN, look())).toBeNull();
  });

  it("reads this process's PATH and home by default", () => {
    const real = systemLookup();
    expect(real.path).toBe(process.env.PATH);
    expect(real.home).toBe(os.homedir());
  });
});
