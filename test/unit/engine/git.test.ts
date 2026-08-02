import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { gitState, taskDiff, repoRoot, currentBranch, defaultBranch, prEligible } from "../../../src/engine/git";

describe("gitState", () => {
  let repo: string;
  const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: ["ignore", "pipe", "ignore"] });

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-git-"));
    g("init", "-q");
    g("config", "user.email", "t@t.dev");
    g("config", "user.name", "T");
    fs.writeFileSync(path.join(repo, "a.txt"), "1\n2\n3\n");
    g("add", "-A");
    g("commit", "-q", "-m", "init");
  });

  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

  it("reports a clean repo with no diff and a branch", () => {
    const s = gitState("svc", repo);
    expect(s.dirty).toBe(false);
    expect(s.files).toBe(0);
    expect(s.added).toBe(0);
    expect(s.branch).toBeTruthy();
  });

  it("reports an uncommitted change as dirty with a +1 line diff", () => {
    fs.appendFileSync(path.join(repo, "a.txt"), "4\n");
    const s = gitState("svc", repo);
    expect(s.dirty).toBe(true);
    expect(s.files).toBe(1);
    expect(s.added).toBe(1);
    expect(s.removed).toBe(0);
  });

  it("degrades to zeros and a null branch for a non-git path (no throw)", () => {
    const s = gitState("nope", path.join(repo, "does-not-exist"));
    expect(s.branch).toBeNull();
    expect(s.dirty).toBe(false);
    expect(s.files).toBe(0);
  });
});

describe("taskDiff", () => {
  let work: string;
  let bare: string;
  const g = (...a: string[]) => execFileSync("git", ["-C", work, ...a], { stdio: ["ignore", "pipe", "ignore"] });
  const file = () => path.join(work, "a.txt");

  beforeAll(() => {
    // A real origin, because the base is resolved from origin/HEAD. Both repos pin
    // init.defaultBranch so `remote set-head -a` resolves the same name on any git.
    bare = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-origin-"));
    work = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-task-"));
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "--bare", "-q", bare]);
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", work]);
    g("config", "user.email", "t@t.dev");
    g("config", "user.name", "T");
    fs.writeFileSync(file(), "1\n2\n3\n");
    g("add", "-A");
    g("commit", "-q", "-m", "init");
    g("remote", "add", "origin", bare);
    g("push", "-q", "-u", "origin", "HEAD");
    g("remote", "set-head", "origin", "-a");
  });

  afterAll(() => {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(bare, { recursive: true, force: true });
  });

  it("is empty on the default branch with a clean tree", () => {
    // merge-base is HEAD here, so this is the old `diff HEAD` behaviour, unchanged.
    expect(taskDiff(work)).toBe("");
  });

  it("shows an uncommitted change while still on the default branch", () => {
    fs.appendFileSync(file(), "4\n");
    expect(taskDiff(work)).toContain("+4");
    g("checkout", "-q", "--", "a.txt");
  });

  it("shows work the agent already committed on a task branch", () => {
    // The defect: `git diff HEAD` is blank here, so the Deck reported "no changes"
    // for every run whose agent had committed — i.e. every run with a PR.
    g("checkout", "-qb", "ASM-1-retry");
    fs.appendFileSync(file(), "committed\n");
    g("add", "-A");
    g("commit", "-q", "-m", "work");
    const d = taskDiff(work);
    expect(d).toContain("+committed");
    expect(d).toContain("a/a.txt");
  });

  it("shows committed and uncommitted work together", () => {
    fs.appendFileSync(file(), "uncommitted\n");
    const d = taskDiff(work);
    expect(d).toContain("+committed");
    expect(d).toContain("+uncommitted");
    g("checkout", "-q", "--", "a.txt");
  });

  it("returns a diff larger than execFileSync's 1 MB default rather than nothing", () => {
    // Without an explicit maxBuffer this throws ENOBUFS, git() swallows it, and the
    // Deck toasts "no changes" for a task that changed two megabytes.
    fs.writeFileSync(path.join(work, "big.txt"), "a line of some length\n".repeat(100_000));
    g("add", "-A");
    g("commit", "-q", "-m", "big");
    expect(taskDiff(work).length).toBeGreaterThan(1024 * 1024);
  });

  it("degrades to the uncommitted diff in a repo with no origin", () => {
    const solo = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-solo-"));
    const s = (...a: string[]) => execFileSync("git", ["-C", solo, ...a], { stdio: ["ignore", "pipe", "ignore"] });
    s("init", "-q");
    s("config", "user.email", "t@t.dev");
    s("config", "user.name", "T");
    fs.writeFileSync(path.join(solo, "a.txt"), "1\n");
    s("add", "-A");
    s("commit", "-q", "-m", "init");
    fs.appendFileSync(path.join(solo, "a.txt"), "2\n");
    expect(taskDiff(solo)).toContain("+2");
    fs.rmSync(solo, { recursive: true, force: true });
  });

  it("falls back to a real branch when origin/HEAD names one that no longer exists", () => {
    // Its own repo, so the shared fixture above keeps its refs and its ordering.
    const stale = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-stale-head-"));
    const staleOrigin = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-stale-origin-"));
    const s = (...a: string[]) => execFileSync("git", ["-C", stale, ...a], { stdio: ["ignore", "pipe", "ignore"] });
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "--bare", "-q", staleOrigin]);
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", stale]);
    s("config", "user.email", "t@t.dev");
    s("config", "user.name", "T");
    fs.writeFileSync(path.join(stale, "a.txt"), "1\n");
    s("add", "-A");
    s("commit", "-q", "-m", "init");
    s("remote", "add", "origin", staleOrigin);
    s("push", "-q", "-u", "origin", "HEAD");
    // What a remote default-branch rename leaves behind: origin/HEAD still names the
    // retired branch, which `fetch --prune` then deleted. Written directly rather
    // than by renaming and fetching, because git ≥ 2.50 re-points origin/HEAD on
    // fetch and older gits do not — the dangling ref is the state under test either way.
    s("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master");
    s("checkout", "-qb", "ASM-9-stale");
    fs.appendFileSync(path.join(stale, "a.txt"), "committed\n");
    s("add", "-A");
    s("commit", "-q", "-m", "work");
    // Trusting origin/HEAD here makes merge-base fail, which git() turns into "",
    // which sends taskDiff back to `diff HEAD` — blank, the original defect.
    expect(taskDiff(stale)).toContain("+committed");
    fs.rmSync(stale, { recursive: true, force: true });
    fs.rmSync(staleOrigin, { recursive: true, force: true });
  });

  it("returns empty for a path that is not a git repo", () => {
    expect(taskDiff("/definitely/not/here")).toBe("");
  });
});

describe("repoRoot & currentBranch", () => {
  let repo: string;
  const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: ["ignore", "pipe", "ignore"] });

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-root-"));
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", repo]);
    g("config", "user.email", "t@t.dev");
    g("config", "user.name", "T");
    fs.writeFileSync(path.join(repo, "a.txt"), "1\n");
    g("add", "-A");
    g("commit", "-q", "-m", "init");
    fs.mkdirSync(path.join(repo, "src"));
  });

  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

  it("resolves a subdirectory to the repo root", () => {
    expect(repoRoot(path.join(repo, "src"))).toBe(fs.realpathSync(repo));
  });

  it("is empty for a path in no repo", () => {
    const loose = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-loose-"));
    expect(repoRoot(loose)).toBe("");
    fs.rmSync(loose, { recursive: true, force: true });
  });

  it("serves a repeat call from the memo instead of recomputing", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-root-memo-"));
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", temp]);
    const first = repoRoot(temp);
    expect(first).toBe(fs.realpathSync(temp));
    fs.rmSync(temp, { recursive: true, force: true });
    // The directory is gone: a recomputing implementation would shell out to a
    // missing path and git()'s catch-all would turn that into "". Getting the
    // same non-empty answer back proves the memo served it, not git.
    expect(repoRoot(temp)).toBe(first);
  });

  it("reads the checked-out branch", () => {
    expect(currentBranch(repo)).toBe("main");
  });

  it("is null for a path in no repo", () => {
    expect(currentBranch("/definitely/not/here")).toBeNull();
  });
});

describe("defaultBranch & prEligible", () => {
  // Its own origin, because defaultBranch resolves from origin/HEAD. Each test
  // that needs a different answer builds its own repo: both helpers memoize per
  // path for the life of the process, so one directory has one answer forever.
  const clone = (name: string): string => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), `agent-flow-${name}-origin-`));
    const work = fs.mkdtempSync(path.join(os.tmpdir(), `agent-flow-${name}-`));
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "--bare", "-q", bare]);
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", work]);
    const g = (...a: string[]) => execFileSync("git", ["-C", work, ...a], { stdio: ["ignore", "pipe", "ignore"] });
    g("config", "user.email", "t@t.dev");
    g("config", "user.name", "T");
    fs.writeFileSync(path.join(work, "a.txt"), "1\n");
    g("add", "-A");
    g("commit", "-q", "-m", "init");
    g("remote", "add", "origin", bare);
    g("push", "-q", "-u", "origin", "HEAD");
    g("remote", "set-head", "origin", "-a");
    return work;
  };

  it("reads origin/HEAD as a short name", () => {
    expect(defaultBranch(clone("db"))).toBe("main");
  });

  it("is empty for a repo with no origin", () => {
    const solo = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-db-solo-"));
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", solo]);
    expect(defaultBranch(solo)).toBe("");
    fs.rmSync(solo, { recursive: true, force: true });
  });

  it("serves a repeat call from the memo instead of recomputing", () => {
    const work = clone("db-memo");
    const first = defaultBranch(work);
    expect(first).toBe("main");
    fs.rmSync(work, { recursive: true, force: true });
    // Without a working tree, defaultRemoteRef's git calls all fail and recompute
    // to "". Getting "main" back proves the memo served it, not a fresh lookup.
    expect(defaultBranch(work)).toBe(first);
  });

  it("says a feature branch can own a PR", () => {
    const work = clone("elig");
    expect(prEligible({ path: work, isGit: true, branch: "ASM-1-x" })).toBe(true);
  });

  it("says the default branch cannot", () => {
    // `gh pr list --head main` matches every PR ever opened from main — this is
    // the check that stopped a stranger's closed PR rendering on an Explore card.
    const work = clone("elig-def");
    expect(prEligible({ path: work, isGit: true, branch: "main" })).toBe(false);
  });

  it("says a repo with no origin cannot", () => {
    const solo = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-elig-solo-"));
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", solo]);
    expect(prEligible({ path: solo, isGit: true, branch: "ASM-1-x" })).toBe(false);
    fs.rmSync(solo, { recursive: true, force: true });
  });

  it("says a non-git service cannot, and one with no branch cannot", () => {
    expect(prEligible({ path: "/svc", isGit: false, branch: "ASM-1-x" })).toBe(false);
    expect(prEligible({ path: "/svc", isGit: true })).toBe(false);
  });
});
