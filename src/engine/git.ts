import { execFileSync } from "child_process";
import { RepoGit } from "../types";

/** Run a git command in a repo, returning trimmed stdout or "" on any failure
 * (non-git dir, missing upstream, etc.) — the deck must never break on git. */
function git(repoPath: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", repoPath, ...args], {
      stdio: ["ignore", "pipe", "ignore"],
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
