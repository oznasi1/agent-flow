import * as fs from "fs";

/** Resolve symlinks so two spellings of one directory compare equal — /var vs
 * /private/var on macOS being the case that bites. Falls back to the input for a
 * path that does not exist: an identity is still wanted for a deleted worktree. */
export function canon(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** `kill(pid, 0)` sends no signal — it only probes: it throws ESRCH for a dead pid
 * and EPERM for a live process we don't own. Either "no error" or EPERM ⇒ alive. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
