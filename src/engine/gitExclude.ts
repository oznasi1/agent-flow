import * as fs from "fs";
import * as path from "path";

/**
 * Ensure `entry` is present in the repo's `.git/info/exclude` — a local, never-committed
 * ignore list. Used to keep extension-created paths (task briefs, in-repo worktrees) out
 * of `git status` without touching the tracked `.gitignore`.
 *
 * Handles both a normal checkout and a linked worktree: in a worktree `.git` is a file
 * pointing at `.git/worktrees/<name>`, whose `commondir` points back at the shared common
 * dir where the effective `info/exclude` lives. Idempotent. `entry` is written verbatim as
 * a single line, so pass exactly the pattern you want, e.g. `.claude/worktrees/`.
 *
 * Best-effort: returns false (without throwing) on any failure so callers never break a flow.
 */
export function ensureGitExcluded(repoPath: string, entry: string): boolean {
  const gitPath = path.join(repoPath, ".git");
  if (!fs.existsSync(gitPath)) return false;
  let gitDir = gitPath;
  try {
    if (fs.statSync(gitPath).isFile()) {
      const line = fs.readFileSync(gitPath, "utf8").trim();
      if (line.startsWith("gitdir:")) gitDir = line.slice("gitdir:".length).trim();
    }
    // In a worktree, gitDir is .git/worktrees/<name>; the effective info/exclude
    // lives in the shared common dir (pointed to by a `commondir` file).
    const commondir = path.join(gitDir, "commondir");
    if (fs.existsSync(commondir)) {
      gitDir = path.resolve(gitDir, fs.readFileSync(commondir, "utf8").trim());
    }
    const exclude = path.join(gitDir, "info", "exclude");
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    const existing = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
    if (!existing.split("\n").includes(entry)) {
      const sep = existing && !existing.endsWith("\n") ? "\n" : "";
      fs.appendFileSync(exclude, `${sep}${entry}\n`);
    }
    return true;
  } catch {
    return false;
  }
}
