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
        git(s.path, ["worktree", "add", wtPath, "-b", branch]);
      } catch {
        // Branch already exists — attach the worktree to it instead of creating it.
        git(s.path, ["worktree", "add", wtPath, branch]);
      }
      log(`worktree ${s.name}: created ${wtPath} on ${branch}`);
      return { name: s.name, path: wtPath, isGit: true };
    } catch (e) {
      log(`worktree ${s.name}: failed (${e}) — falling back to the main checkout`);
      return s;
    }
  });
}
