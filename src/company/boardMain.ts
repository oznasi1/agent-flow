import * as crypto from "crypto";
import { spawn } from "child_process";
import type { AddressInfo } from "net";
import { companyPaths, ensureCompanyDirs } from "./paths";
import { createBoardServer, CycleMode, RunnerResult } from "./server";

const repoRoot = process.argv[2] ?? process.cwd();
const paths = companyPaths(repoRoot);
ensureCompanyDirs(paths);

/**
 * Phase B replaces this with a spawn of scripts/company-cycle.sh. Until then the
 * button tells the truth instead of failing silently.
 */
async function spawnCycle(_mode: CycleMode): Promise<RunnerResult> {
  return { ok: false, detail: "The cycle script arrives in phase B — nothing was started." };
}

/** Long enough for a real revert with hooks, short enough that nobody waits. */
const GIT_TIMEOUT_MS = 60_000;

interface GitRun {
  ok: boolean;
  out: string;
  timedOut: boolean;
}

/**
 * Runs one git command to completion, or kills it. Without the timeout a hook
 * that waits for input — or an editor git decided to open — leaves the promise
 * pending forever, and with it the HTTP request the board is holding open.
 */
function runGit(args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<GitRun> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd: repoRoot });
    let out = "";
    let timedOut = false;
    let settled = false;
    const finish = (run: GitRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(run);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (out += c.toString()));
    child.on("error", (e) => finish({ ok: false, out: e.message, timedOut }));
    child.on("close", (code) =>
      finish({
        ok: code === 0 && !timedOut,
        out: out.trim() || `git ${args.join(" ")} exited ${code}`,
        timedOut,
      }),
    );
  });
}

/**
 * Reverts a landed commit, and leaves nothing half-done if it cannot.
 *
 * A conflicted `git revert` exits non-zero with REVERT_HEAD and conflict markers
 * in place, so every later Undo failed with "revert already in progress" until
 * the reviewer happened to know to run `git revert --abort` themselves. Unwind
 * it here instead, and say so — but only when a revert really is in progress,
 * since `--abort` with nothing to abort would fail and turn a plain "unknown
 * sha" into a scary and untrue "the repository is mid-revert".
 */
async function gitRevert(sha: string): Promise<RunnerResult> {
  const revert = await runGit(["revert", "--no-edit", sha]);
  if (revert.ok) return { ok: true, detail: revert.out };

  const why = revert.timedOut
    ? `git revert ${sha} was killed after ${GIT_TIMEOUT_MS / 1000}s without finishing — ` +
      "a hook or an editor was most likely waiting for input."
    : `git revert ${sha} did not apply cleanly:\n${revert.out}`;

  const inProgress = (await runGit(["rev-parse", "--verify", "--quiet", "REVERT_HEAD"])).ok;
  if (!inProgress) {
    return { ok: false, detail: `${why}\nNothing was left behind — the working tree is unchanged.` };
  }

  const abort = await runGit(["revert", "--abort"]);
  if (abort.ok) {
    return {
      ok: false,
      detail:
        `${why}\nThe revert conflicted and has been aborted, so the working tree is clean ` +
        "again and the next Undo will not trip over it. Nothing was changed.",
    };
  }
  return {
    ok: false,
    detail:
      `${why}\nThe revert conflicted, and aborting it also failed:\n${abort.out}\n` +
      "The repository is still mid-revert — every later Undo will refuse until that is " +
      `cleared. Run this in ${repoRoot}:\n  git revert --abort`,
  };
}

const token = crypto.randomBytes(24).toString("hex");
const server = createBoardServer({ paths, token, spawnCycle, gitRevert });
const port = Number(process.env.BOARD_PORT ?? 0);

server.listen(port, "127.0.0.1", () => {
  const bound = server.address() as AddressInfo;
  process.stdout.write(`Company board: http://127.0.0.1:${bound.port}/?key=${token}\n`);
});
