import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Run, runKind } from "../types";
import { canon } from "./paths";

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

/** The path the Deck's "Open" acts on for a run: the multi-root workspace file,
 * else the first repo. Undefined when a run somehow has neither. */
export function runTarget(run: Run): string | undefined {
  return run.workspaceFile ?? run.repos[0]?.path;
}

/** One bullet per still-active run, for folding into a supervising session's
 * brief.md via `planMd` — not a new prompt placeholder. `livePlaces` is the
 * canonicalised repo-root set of directories with a live Claude Code session
 * open right now: build it the same way `deckView.ts` already does for its
 * own retire-sweep check — `new Set(groupByPlace(readOpenSessions(dir)).keys())`. */
export function describeActiveTasks(runs: Run[], livePlaces: ReadonlySet<string>): string {
  const active = runs.filter((r) => !r.finishedAt);
  if (active.length === 0) return "_No other active tasks right now._";
  const lines = active.map((r) => {
    // `r.repos` is guarded rather than trusted: readRuns only validates that a
    // record has `.key` (see its own comment), so a hand-edited or legacy file
    // can reach here with `repos` missing entirely. Degrading to "unknown
    // location" / not-live is the same best-effort posture readRuns already
    // takes with a corrupt file, rather than throwing mid-launch.
    const repos = r.repos ?? [];
    const live = repos.some((repo) => livePlaces.has(canon(repo.path)));
    const first = repos[0];
    const where = first ? `\`${first.path}\`${first.branch ? ` (branch: ${first.branch})` : ""}` : "unknown location";
    return `- **${r.key}** (${runKind(r)}) — ${r.summary} — ${where} — ${live ? "agent open" : "idle, no agent attached"}`;
  });
  return `## Active tasks\n${lines.join("\n")}`;
}
