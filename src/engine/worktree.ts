import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { ServiceRef } from "../types";
import { ensureGitExcluded } from "./gitExclude";

/** In-repo location for per-task worktrees, relative to each repo root. `.claude/` is
 *  the convention Claude Code's own worktrees use; keeping ours here means the same
 *  git-exclude entry covers both and existing tooling already skips the directory. */
const WORKTREE_DIR = path.join(".claude", "worktrees");
/** The `.git/info/exclude` line that keeps the in-repo worktrees out of `git status`.
 *  Forward-slashed (git patterns are POSIX) and independent of `path.sep`. */
const WORKTREE_EXCLUDE = ".claude/worktrees/";

/** Branch/worktree name for a task, e.g. ABC-1234-fix-login-timeout. */
export function branchName(key: string, summary: string): string {
  const slug = summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug ? `${key}-${slug}` : key;
}

/** The repo a worktree path belongs to: the prefix before our `.claude/worktrees/<KEY>`
 *  segment. Splits on the FIRST occurrence, so a worktree nested inside a worktree unwinds
 *  all the way to the outermost real repo in one step. `undefined` for any path that isn't
 *  one of our worktrees — including the `worktrees` directory itself, which is not one.
 *
 *  The inverse of the layout createWorktrees writes, and it lives here so the convention
 *  and its reader cannot drift apart. */
export function repoRootOfWorktree(p: string): string | undefined {
  const marker = `${path.sep}${WORKTREE_DIR}${path.sep}`;
  const at = p.indexOf(marker);
  return at > 0 ? p.slice(0, at) : undefined;
}

function git(repo: string, args: string[]): void {
  execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
}

export interface WorktreeOptions {
  /** The ref the worktree's new branch starts at. Omitted means git's own default —
   *  the main checkout's HEAD — which is what every caller before child worktrees
   *  relied on, so omitting it must keep their argv byte-identical.
   *
   *  Ignored by the "branch already exists" fallback below: `worktree add <path>
   *  <branch>` takes no start point, and an existing branch already has a history
   *  that a start point could only contradict. */
  baseRef?: string;
}

/**
 * Create a per-task git worktree for each service and return ServiceRefs pointing
 * at the worktrees. Layout: <repo>/.claude/worktrees/<KEY> — i.e. inside each repo,
 * under the git-excluded `.claude/` dir (see WORKTREE_DIR). On any failure (non-git
 * repo, branch already checked out, etc.) it falls back to the main checkout so the
 * flow never breaks.
 */
export function createWorktrees(
  services: ServiceRef[],
  key: string,
  summary: string,
  log: (m: string) => void,
  opts: WorktreeOptions = {},
): ServiceRef[] {
  const branch = branchName(key, summary);
  return services.map((s) => {
    if (!s.isGit) {
      log(`worktree ${s.name}: not a git repo — opening the checkout directly`);
      return s;
    }
    // Keep the nested worktree out of the main checkout's git status. Do this before
    // creating it so there's never a window where `.claude/worktrees/` shows untracked.
    ensureGitExcluded(s.path, WORKTREE_EXCLUDE);
    const wtPath = path.join(s.path, WORKTREE_DIR, key);
    try {
      if (fs.existsSync(wtPath)) {
        log(`worktree ${s.name}: reusing ${wtPath}`);
        return { name: s.name, path: wtPath, isGit: true };
      }
      fs.mkdirSync(path.dirname(wtPath), { recursive: true });
      try {
        git(s.path, ["worktree", "add", wtPath, "-b", branch, ...(opts.baseRef ? [opts.baseRef] : [])]);
      } catch {
        // Branch already exists — attach the worktree to it instead of creating it.
        git(s.path, ["worktree", "add", wtPath, branch]);
      }
      log(`worktree ${s.name}: created ${wtPath} on ${branch}${opts.baseRef ? ` (off ${opts.baseRef})` : ""}`);
      return { name: s.name, path: wtPath, isGit: true };
    } catch (e) {
      log(`worktree ${s.name}: failed (${e}) — falling back to the main checkout`);
      return s;
    }
  });
}

/**
 * Make sure `branch` exists in `repo`, creating it at `from` (default: the checkout's
 * current HEAD) when it does not. Returns false when it could not be created — the
 * caller must then refuse, because a child worktree that silently branches off the
 * wrong base looks identical to a correct one until the merge.
 *
 * Idempotent, and deliberately so: several children in one repo each call this before
 * their own worktree, and an existing parent branch must never be moved under work
 * that is already on it. `--quiet` keeps a missing ref off stderr, so an absent branch
 * is an ordinary answer rather than noise in the log.
 */
export function ensureBranch(repo: string, branch: string, from?: string): boolean {
  try {
    git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    /* absent — create it below */
  }
  try {
    git(repo, from ? ["branch", branch, from] : ["branch", branch]);
    return true;
  } catch {
    return false;
  }
}
