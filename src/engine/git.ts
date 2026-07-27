import { execFileSync } from "child_process";
import { RepoGit } from "../types";

/** Run a git command in a repo, returning trimmed stdout or "" on any failure
 * (non-git dir, missing upstream, etc.) — the deck must never break on git. */
function git(repoPath: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", repoPath, ...args], {
      stdio: ["ignore", "pipe", "ignore"],
      // A task diff is the one output here big enough to matter. Node's 1 MB
      // default throws ENOBUFS, which the catch below would turn into "", and a
      // caller cannot tell that apart from "this task changed nothing".
      maxBuffer: 32 * 1024 * 1024,
    })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

/**
 * The reliable backbone of a run's status: branch, working-tree diff vs HEAD
 * (uncommitted work the agent produced), commits ahead of upstream, and dirtiness.
 * Degrades to zeros/null for a non-git or missing path rather than throwing.
 */
export function gitState(name: string, repoPath: string): RepoGit {
  const branchRaw = git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchRaw && branchRaw !== "HEAD" ? branchRaw : null;
  const dirty = git(repoPath, ["status", "--porcelain"]).length > 0;

  const aheadRaw = git(repoPath, ["rev-list", "--count", "@{u}..HEAD"]);
  const ahead = aheadRaw ? parseInt(aheadRaw, 10) || 0 : 0;

  let added = 0;
  let removed = 0;
  let files = 0;
  const numstat = git(repoPath, ["diff", "HEAD", "--numstat"]);
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [a, r] = line.split("\t");
    files++;
    added += parseInt(a, 10) || 0; // binary files show "-" → NaN → 0
    removed += parseInt(r, 10) || 0;
  }

  return { name, path: repoPath, branch, dirty, ahead, added, removed, files };
}

/** The remote default branch a task is measured against: whatever origin/HEAD
 * points at, else origin/main, else origin/master. "" when the repo has no origin
 * to compare with — a local-only checkout, or a fresh init. */
function defaultRemoteRef(repoPath: string): string {
  const head = git(repoPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head) return head;
  // origin/HEAD is only written by `git clone` and goes stale after a default-branch
  // rename, so a working clone very often has no such ref.
  for (const ref of ["origin/main", "origin/master"]) {
    if (git(repoPath, ["rev-parse", "--verify", "--quiet", ref])) return ref;
  }
  return "";
}

/** Everything a task changed in this repo: the diff from where its branch left the
 * default branch through to the current working tree, so committed work counts.
 * The moment an agent commits, a plain `diff HEAD` goes blank and reads as "no work
 * done" — which is what the Deck's Diff button used to report for every run that
 * got as far as opening a PR. Degrades to the uncommitted diff when there is no
 * base to find, and on a run still sitting on the default branch merge-base *is*
 * HEAD, so the two are the same command. */
export function taskDiff(repoPath: string): string {
  const base = defaultRemoteRef(repoPath);
  const from = base ? git(repoPath, ["merge-base", "HEAD", base]) : "";
  return git(repoPath, ["diff", from || "HEAD"]);
}
