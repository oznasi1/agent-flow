import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Run } from "../types";

// The Deck's durable source of truth: one file per launched task (no TTL — unlike
// the transient ~/.agentflow/plans handshake that the agent-seed consumes).
export function defaultRunsDir(): string {
  return path.join(os.homedir(), ".agentflow", "runs");
}

function fileFor(dir: string, key: string): string {
  return path.join(dir, `${key}.json`);
}

/** Persist a run, keyed by ticket — re-taking a task overwrites its record. */
export function writeRun(dir: string, run: Run): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fileFor(dir, run.key), JSON.stringify(run, null, 2) + "\n");
}

/** All runs in the store, newest first. Malformed files are skipped, not fatal. */
export function readRuns(dir: string): Run[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const runs: Run[] = [];
  for (const name of names) {
    try {
      const run = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as Run;
      if (run && run.key) runs.push(run);
    } catch {
      /* skip a corrupt/half-written record rather than blow up the whole deck */
    }
  }
  return runs.sort((a, b) => b.createdAt - a.createdAt);
}

/** Forget a run (e.g. after it's merged/archived). */
export function removeRun(dir: string, key: string): void {
  fs.rmSync(fileFor(dir, key), { force: true });
}
