import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { ServiceRef } from "../types";

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

function git(repo: string, args: string[]): void {
  execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
}

/**
 * Create a per-task git worktree for each service and return ServiceRefs pointing
 * at the worktrees. Layout: <worktreeRoot>/<KEY>/<repo>. On any failure (non-git
 * repo, branch already checked out, etc.) it falls back to the main checkout so
 * the flow never breaks. `worktreeRoot` must already be absolute.
 */
export function createWorktrees(
  services: ServiceRef[],
  key: string,
  summary: string,
  worktreeRoot: string,
  log: (m: string) => void,
): ServiceRef[] {
  const branch = branchName(key, summary);
  return services.map((s) => {
    if (!s.isGit) {
      log(`worktree ${s.name}: not a git repo — opening the checkout directly`);
      return s;
    }
    const wtPath = path.join(worktreeRoot, key, s.name);
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
