import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as childProcess from "child_process";
import { branchName, createWorktrees } from "../../../src/engine/worktree";
import { mkRepos } from "../../_helpers/factories";

vi.mock("fs");
vi.mock("child_process");
const existsSync = vi.mocked(fs.existsSync);
const mkdirSync = vi.mocked(fs.mkdirSync);
const execFileSync = vi.mocked(childProcess.execFileSync);

describe("branchName", () => {
  it("is key + slugified summary", () => {
    expect(branchName("ASM-5412", "Wizer export fails on large accounts")).toBe(
      "ASM-5412-wizer-export-fails-on-large-accounts",
    );
  });

  it("caps the slug length", () => {
    expect(branchName("ASM-1", "x".repeat(80)).length).toBeLessThanOrEqual(46);
  });

  it("trims trailing dashes left by punctuation", () => {
    expect(branchName("ASM-2", "hello!!! ").endsWith("-")).toBe(false);
  });

  it("falls back to the bare key when the summary has no slug chars", () => {
    expect(branchName("ASM-3", "!!!")).toBe("ASM-3");
  });

  it("collapses runs of non-alphanumerics into a single dash", () => {
    expect(branchName("ASM-4", "a   b__c")).toBe("ASM-4-a-b-c");
  });
});

describe("createWorktrees", () => {
  const log = vi.fn();
  const root = "/wt";

  beforeEach(() => {
    existsSync.mockReset().mockReturnValue(false);
    mkdirSync.mockReset();
    execFileSync.mockReset();
    log.mockReset();
  });

  it("opens a non-git repo directly, without touching git", () => {
    const [repo] = mkRepos(["frontend"], { isGit: false });
    expect(createWorktrees([repo], "ASM-1", "summary", root, log)).toEqual([repo]);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("creates a worktree on a new branch", () => {
    const [repo] = mkRepos(["centaur"]);
    const [out] = createWorktrees([repo], "ASM-1", "fix it", root, log);
    expect(out).toEqual({ name: "centaur", path: "/wt/ASM-1/centaur", isGit: true });
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["-C", repo.path, "worktree", "add", "/wt/ASM-1/centaur", "-b", "ASM-1-fix-it"],
      expect.anything(),
    );
  });

  it("reuses an existing worktree directory", () => {
    existsSync.mockReturnValue(true);
    const [repo] = mkRepos(["centaur"]);
    const [out] = createWorktrees([repo], "ASM-1", "fix it", root, log);
    expect(out.path).toBe("/wt/ASM-1/centaur");
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("attaches to an existing branch when `-b` fails", () => {
    execFileSync.mockImplementationOnce(() => {
      throw new Error("branch already exists");
    });
    const [repo] = mkRepos(["centaur"]);
    const [out] = createWorktrees([repo], "ASM-1", "fix it", root, log);
    expect(out.path).toBe("/wt/ASM-1/centaur");
    expect(execFileSync).toHaveBeenCalledTimes(2);
    // second attempt drops the -b flag
    expect(execFileSync).toHaveBeenLastCalledWith(
      "git",
      ["-C", repo.path, "worktree", "add", "/wt/ASM-1/centaur", "ASM-1-fix-it"],
      expect.anything(),
    );
  });

  it("falls back to the main checkout when git fails outright", () => {
    // Both the `-b` create and the attach fallback fail; use *Once per call so
    // no persistent throwing implementation lingers past the test (Vitest flags
    // that as an unhandled error at teardown even when the SUT caught it).
    const boom = () => {
      throw new Error("boom");
    };
    execFileSync.mockImplementationOnce(boom).mockImplementationOnce(boom);
    const [repo] = mkRepos(["centaur"]);
    expect(createWorktrees([repo], "ASM-1", "fix it", root, log)).toEqual([repo]);
  });

  it("maps a mixed set independently", () => {
    const repos = [...mkRepos(["a"]), ...mkRepos(["b"], { isGit: false })];
    const out = createWorktrees(repos, "ASM-9", "x", root, log);
    expect(out[0].path).toBe("/wt/ASM-9/a");
    expect(out[1]).toEqual(repos[1]); // non-git passthrough
  });
});
