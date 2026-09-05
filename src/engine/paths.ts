import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** ~/.claude/projects — where Claude Code keeps one directory of transcripts per
 * cwd. Hoisted from the inline const the status build used, so the usage sweep
 * and the activity read cannot drift onto two different roots. A function
 * rather than a module-level const because `os.homedir()` at import time is a
 * needless load-order dependency in a module the extension host loads early. */
/** `~/.agentflow` — the cross-window state root: `runs/`, `plans/`, `flows/`,
 * and the headless identity file beside them. Each of those still builds its own
 * path today; this exists for the one caller that wants the ROOT rather than a
 * subdirectory, and is the honest place to name it. */
export function agentFlowDir(): string {
  return path.join(os.homedir(), ".agentflow");
}

export function claudeProjectsRoot(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

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
