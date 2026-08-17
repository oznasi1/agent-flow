import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as childProcess from "child_process";
import { branchName, createWorktrees, ensureBranch, repoRootOfWorktree } from "../../../src/engine/worktree";
import { ensureGitExcluded } from "../../../src/engine/gitExclude";
import { mkRepos } from "../../_helpers/factories";

vi.mock("fs");
vi.mock("child_process");
vi.mock("../../../src/engine/gitExclude");
const existsSync = vi.mocked(fs.existsSync);
const mkdirSync = vi.mocked(fs.mkdirSync);
const execFileSync = vi.mocked(childProcess.execFileSync);
const gitExcluded = vi.mocked(ensureGitExcluded);

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

describe("repoRootOfWorktree", () => {
  it("returns the repo a worktree belongs to", () => {
    expect(repoRootOfWorktree("/repos/centaur/.claude/worktrees/ASM-1")).toBe("/repos/centaur");
  });

  it("keeps any path below the worktree attached to the same repo", () => {
    expect(repoRootOfWorktree("/repos/centaur/.claude/worktrees/ASM-1/src/x.ts")).toBe(
      "/repos/centaur",
    );
  });

  it("unwinds a worktree nested inside a worktree to the outermost repo", () => {
    // Splitting on the FIRST marker undoes the whole cascade in one step: a polluted
    // workspace could otherwise hand us .../ASM-1/.claude/worktrees/ASM-2 and we would
    // treat ASM-1 as the repo.
    expect(
      repoRootOfWorktree("/repos/centaur/.claude/worktrees/ASM-1/.claude/worktrees/ASM-2"),
    ).toBe("/repos/centaur");
  });

  it("returns undefined for a plain repo path", () => {
    expect(repoRootOfWorktree("/repos/centaur")).toBeUndefined();
  });

  it("returns undefined for a .claude path that is not a worktree", () => {
    expect(repoRootOfWorktree("/repos/centaur/.claude/settings.json")).toBeUndefined();
  });

  it("returns undefined for the worktrees directory itself", () => {
    expect(repoRootOfWorktree("/repos/centaur/.claude/worktrees")).toBeUndefined();
  });

  it("returns undefined when there is no repo prefix", () => {
    expect(repoRootOfWorktree("/.claude/worktrees/ASM-1")).toBeUndefined();
  });
});

describe("createWorktrees", () => {
  const log = vi.fn();

  beforeEach(() => {
    existsSync.mockReset().mockReturnValue(false);
    mkdirSync.mockReset();
    execFileSync.mockReset();
    gitExcluded.mockReset().mockReturnValue(true);
    log.mockReset();
  });

  it("opens a non-git repo directly, without touching git", () => {
    const [repo] = mkRepos(["frontend"], { isGit: false });
    expect(createWorktrees([repo], "ASM-1", "summary", log)).toEqual([repo]);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(gitExcluded).not.toHaveBeenCalled();
  });

  it("creates a worktree inside the repo, on a new branch", () => {
    const [repo] = mkRepos(["centaur"]);
    const [out] = createWorktrees([repo], "ASM-1", "fix it", log);
    expect(out).toEqual({ name: "centaur", path: "/repos/centaur/.claude/worktrees/ASM-1", isGit: true });
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["-C", repo.path, "worktree", "add", "/repos/centaur/.claude/worktrees/ASM-1", "-b", "ASM-1-fix-it"],
      expect.anything(),
    );
  });

  it("git-excludes .claude/worktrees/ in the main checkout", () => {
    const [repo] = mkRepos(["centaur"]);
    createWorktrees([repo], "ASM-1", "fix it", log);
    expect(gitExcluded).toHaveBeenCalledWith(repo.path, ".claude/worktrees/");
  });

  it("reuses an existing worktree directory", () => {
    existsSync.mockReturnValue(true);
    const [repo] = mkRepos(["centaur"]);
    const [out] = createWorktrees([repo], "ASM-1", "fix it", log);
    expect(out.path).toBe("/repos/centaur/.claude/worktrees/ASM-1");
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("attaches to an existing branch when `-b` fails", () => {
    execFileSync.mockImplementationOnce(() => {
      throw new Error("branch already exists");
    });
    const [repo] = mkRepos(["centaur"]);
    const [out] = createWorktrees([repo], "ASM-1", "fix it", log);
    expect(out.path).toBe("/repos/centaur/.claude/worktrees/ASM-1");
    expect(execFileSync).toHaveBeenCalledTimes(2);
    // second attempt drops the -b flag
    expect(execFileSync).toHaveBeenLastCalledWith(
      "git",
      ["-C", repo.path, "worktree", "add", "/repos/centaur/.claude/worktrees/ASM-1", "ASM-1-fix-it"],
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
    expect(createWorktrees([repo], "ASM-1", "fix it", log)).toEqual([repo]);
  });

  it("maps a mixed set independently", () => {
    const repos = [...mkRepos(["a"]), ...mkRepos(["b"], { isGit: false })];
    const out = createWorktrees(repos, "ASM-9", "x", log);
    expect(out[0].path).toBe("/repos/a/.claude/worktrees/ASM-9");
    expect(out[1]).toEqual(repos[1]); // non-git passthrough
  });
});

describe("createWorktrees with a baseRef", () => {
  const log = vi.fn();

  beforeEach(() => {
    existsSync.mockReset().mockReturnValue(false);
    mkdirSync.mockReset();
    execFileSync.mockReset();
    gitExcluded.mockReset().mockReturnValue(true);
    log.mockReset();
  });

  it("branches the new worktree off the given ref", () => {
    const [repo] = mkRepos(["centaur"]);
    createWorktrees([repo], "ASM-2", "child work", log, { baseRef: "ASM-1-parent" });
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["-C", repo.path, "worktree", "add", "/repos/centaur/.claude/worktrees/ASM-2",
       "-b", "ASM-2-child-work", "ASM-1-parent"],
      expect.anything(),
    );
  });

  it("produces the pre-baseRef argv when the option is omitted", () => {
    const [repo] = mkRepos(["centaur"]);
    createWorktrees([repo], "ASM-2", "child work", log);
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["-C", repo.path, "worktree", "add", "/repos/centaur/.claude/worktrees/ASM-2",
       "-b", "ASM-2-child-work"],
      expect.anything(),
    );
  });

  it("produces the pre-baseRef argv for an empty options object", () => {
    const [repo] = mkRepos(["centaur"]);
    createWorktrees([repo], "ASM-2", "child work", log, {});
    expect(execFileSync).toHaveBeenLastCalledWith(
      "git",
      ["-C", repo.path, "worktree", "add", "/repos/centaur/.claude/worktrees/ASM-2",
       "-b", "ASM-2-child-work"],
      expect.anything(),
    );
  });

  it("drops the baseRef when attaching to a branch that already exists", () => {
    // `worktree add <path> <existing-branch>` takes no start point — passing one
    // would make git read it as a second path argument.
    execFileSync.mockImplementationOnce(() => {
      throw new Error("branch already exists");
    });
    const [repo] = mkRepos(["centaur"]);
    createWorktrees([repo], "ASM-2", "child work", log, { baseRef: "ASM-1-parent" });
    expect(execFileSync).toHaveBeenLastCalledWith(
      "git",
      ["-C", repo.path, "worktree", "add", "/repos/centaur/.claude/worktrees/ASM-2", "ASM-2-child-work"],
      expect.anything(),
    );
  });
});

describe("ensureBranch", () => {
  beforeEach(() => {
    execFileSync.mockReset();
  });

  it("leaves an existing branch exactly where it is", () => {
    // rev-parse resolves: the branch is there, nothing else runs.
    execFileSync.mockReturnValueOnce(Buffer.from("abc123\n"));
    expect(ensureBranch("/repos/centaur", "ASM-1-parent")).toBe(true);
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["-C", "/repos/centaur", "rev-parse", "--verify", "--quiet", "refs/heads/ASM-1-parent"],
      expect.anything(),
    );
  });

  it("creates the branch when it does not exist", () => {
    execFileSync.mockImplementationOnce(() => {
      throw new Error("not a valid ref");
    });
    expect(ensureBranch("/repos/centaur", "ASM-1-parent")).toBe(true);
    expect(execFileSync).toHaveBeenLastCalledWith(
      "git",
      ["-C", "/repos/centaur", "branch", "ASM-1-parent"],
      expect.anything(),
    );
  });

  it("creates the branch at an explicit start point", () => {
    execFileSync.mockImplementationOnce(() => {
      throw new Error("not a valid ref");
    });
    ensureBranch("/repos/centaur", "ASM-1-parent", "origin/main");
    expect(execFileSync).toHaveBeenLastCalledWith(
      "git",
      ["-C", "/repos/centaur", "branch", "ASM-1-parent", "origin/main"],
      expect.anything(),
    );
  });

  it("returns false when the branch cannot be created", () => {
    const boom = () => {
      throw new Error("boom");
    };
    execFileSync.mockImplementationOnce(boom).mockImplementationOnce(boom);
    expect(ensureBranch("/repos/centaur", "ASM-1-parent")).toBe(false);
  });
});
