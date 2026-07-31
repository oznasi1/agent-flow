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

function gitRevert(sha: string): Promise<RunnerResult> {
  return new Promise((resolve) => {
    const child = spawn("git", ["revert", "--no-edit", sha], { cwd: repoRoot });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (out += c.toString()));
    child.on("error", (e) => resolve({ ok: false, detail: e.message }));
    child.on("close", (code) =>
      resolve({ ok: code === 0, detail: out.trim() || `git revert exited ${code}` }),
    );
  });
}

const token = crypto.randomBytes(24).toString("hex");
const server = createBoardServer({ paths, token, spawnCycle, gitRevert });
const port = Number(process.env.BOARD_PORT ?? 0);

server.listen(port, "127.0.0.1", () => {
  const bound = server.address() as AddressInfo;
  process.stdout.write(`Company board: http://127.0.0.1:${bound.port}/?key=${token}\n`);
});
