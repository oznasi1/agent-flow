// `dist/tick.js` — one orchestrator pass from a shell, with no editor running.
//
//   node dist/tick.js [--settings <path>] [--dry-run] [--no-fetch]
//
// Exit codes: 0 a pass ran (or --dry-run reported); 2 another process holds the
// flows lock (try again next tick); 3 could not start — no settings file, or
// `agentFlow.orchestrator` is off. Everything the pass did, or refused to do and
// why, is printed one line each; the same facts land in each flow's journal.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readCommandConsent, readCommands, readNeverAutoRun } from "../configReaders";
import { defaultFlowsDir, readFlows } from "../engine/orchestrator/store";
import { newFlowId, nodeFlowIo, nodeJournalIo, nodeLockIo } from "../engine/orchestrator/flowIo";
import { shellCommandRunner } from "../engine/orchestrator/shellRunner";
import { defaultRunsDir, readRuns } from "../engine/runs";
import { defaultSessionsDir, readOpenSessionsProbe } from "../engine/sessions";
import { claudeProjectsRoot } from "../engine/paths";
import { readSessionActivity } from "../engine/transcript";
import { UsageReader } from "../engine/usageFs";
import { weightedEq } from "../engine/usage";
import { defaultPrFactsDir, readPrEntries, writePrEntry } from "../engine/pr/store";
import { prEligible } from "../engine/git";
import { discoverRepos } from "../engine/repos";
import { resolveForge } from "../engine/forge/registry";
import { loadSettings } from "./settings";
import { headlessStatuses, refreshWatchedPrs } from "./statuses";
import { PassReport, runHeadlessPass } from "./pass";

export interface Args {
  settings?: string;
  dryRun: boolean;
  fetch: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): Args | { error: string } {
  const out: Args = { dryRun: false, fetch: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--no-fetch") out.fetch = false;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--settings") {
      const v = argv[++i];
      if (!v) return { error: "--settings needs a path" };
      out.settings = v;
    } else return { error: `unknown argument ${a}` };
  }
  return out;
}

export const USAGE = `Agent Flow Deck tick — one orchestrator pass, no editor needed

  node dist/tick.js [--settings <path>] [--dry-run] [--no-fetch]

Performs notify rules and already-consented run rules of every armed flow;
leaves launch, seed and ask rules pending and says so. Reads the editor's
settings.json (Code, Code - Insiders, Cursor) unless --settings names one.
--dry-run evaluates and reports without writing or running anything.
--no-fetch skips refreshing PR facts through the forge CLI.`;

/** Turn a report into the lines a person or a cron log reads. */
export function reportLines(r: PassReport, dryRun: boolean): string[] {
  const out: string[] = [];
  if (r.lock === "busy") return ["another Deck or tick holds the flows lock — nothing done this pass"];
  if (r.flows.length === 0) out.push(dryRun ? "no armed flows to judge" : "no armed flows");
  for (const f of r.flows) {
    const head = `${f.name} (${f.id})`;
    const lines: string[] = [];
    for (const x of f.notified) lines.push(`notify: ${x}`);
    for (const x of f.fired) lines.push(`fired: ${x}`);
    for (const x of f.errored) lines.push(`errored: ${x}`);
    for (const x of f.expired) lines.push(`expired: ${x}`);
    for (const x of f.needsEditor) lines.push(`needs an editor, left pending: ${x}`);
    for (const x of f.needsConsent) lines.push(`needs consent in the editor, left pending: ${x}`);
    for (const x of f.answered ?? []) lines.push(`answered on the pull request: ${x}`);
    if (f.disarmedAtCeiling) lines.push(`disarmed at its ceiling: ${f.disarmedAtCeiling}`);
    if (lines.length === 0) lines.push("nothing to do");
    out.push(head, ...lines.map((l) => `  ${l}`));
  }
  return out;
}

/** The token tally for a flow's runs, off the same transcripts the Deck's card
 * reads. A fresh `UsageReader` per tick — there is no next sweep to cache for —
 * and `undefined` when a read throws, which the pass reads as "not measured". */
export function tokenSpendReader(runs: { key: string; repos: { path: string }[] }[], projectsRoot: string, reader = new UsageReader()) {
  return (runKeys: string[]): number | undefined => {
    try {
      let eq = 0;
      for (const key of runKeys) {
        const run = runs.find((r) => r.key === key);
        if (run) eq += weightedEq(reader.readRun(projectsRoot, (run.repos ?? []).map((r) => r.path)));
      }
      return eq;
    } catch {
      return undefined;
    }
  };
}

export async function main(argv: string[], print: (l: string) => void = console.log): Promise<number> {
  const args = parseArgs(argv);
  if ("error" in args) {
    print(args.error);
    print(USAGE);
    return 3;
  }
  if (args.help) {
    print(USAGE);
    return 0;
  }
  const loaded = loadSettings(args.settings);
  if ("error" in loaded) {
    print(loaded.error);
    return 3;
  }
  const { reader } = loaded;
  if (reader.get<boolean>("orchestrator") !== true) {
    print(`agentFlow.orchestrator is off in ${loaded.path} — nothing to do`);
    return 3;
  }
  const log = (m: string) => print(`  ${m}`);
  const nowMs = Date.now();
  const flowsDir = defaultFlowsDir();
  const runs = readRuns(defaultRunsDir());
  const flows = readFlows(nodeFlowIo(), flowsDir);
  const prFacts = reader.get<boolean>("prFacts") ?? true;
  const forge = resolveForge(String(reader.get<string>("forge") ?? "github"), log);
  if (args.fetch && prFacts && !args.dryRun) {
    const ttl = reader.get<number>("prFactsTtlSeconds");
    const n = await refreshWatchedPrs({
      runs, flows, nowMs,
      ttlMs: Math.max(30, typeof ttl === "number" && Number.isFinite(ttl) ? ttl : 120) * 1000,
      prEntries: (key) => readPrEntries(defaultPrFactsDir(), key),
      prEligible,
      fetch: (repoPath, branch, key) => forge.prs.fetch(repoPath, branch, key),
      writePrEntry: (key, repo, entry) => writePrEntry(defaultPrFactsDir(), key, repo, entry),
      log,
    });
    if (n > 0) print(`refreshed PR facts for ${n} ${n === 1 ? "repo" : "repos"}`);
  }
  const projectsRoot = claudeProjectsRoot();
  const statuses = headlessStatuses({
    runs, sessions: readOpenSessionsProbe(defaultSessionsDir()), projectsRoot, nowMs,
    prEntries: (key) => (prFacts ? readPrEntries(defaultPrFactsDir(), key) : {}),
    sessionActivity: (cwd, sessionId) => readSessionActivity(projectsRoot, cwd, sessionId, nowMs),
  });
  const reposRoot = reader.get<string>("reposRoot");
  const blocklist = reader.get<string[]>("repoBlocklist");
  const report = await runHeadlessPass({
    flowIo: nodeFlowIo(), lockIo: nodeLockIo(log), journalIo: nodeJournalIo(), flowsDir,
    statuses,
    settings: { commands: readCommands(reader), neverAutoRun: readNeverAutoRun(reader), commandConsent: readCommandConsent(reader) },
    run: shellCommandRunner,
    discoverRepo: (name) => {
      if (typeof reposRoot !== "string" || reposRoot.trim() === "") return undefined;
      const root = reposRoot.startsWith("~") ? path.join(os.homedir(), reposRoot.slice(1)) : reposRoot;
      if (!fs.existsSync(root)) return undefined;
      return discoverRepos(root, Array.isArray(blocklist) ? blocklist.filter((b): b is string => typeof b === "string") : []).find((r) => r.name === name);
    },
    nowMs, now: () => Date.now(), log,
    dryRun: args.dryRun,
    token: `tick-${process.pid}-${newFlowId(nowMs)}`,
    tokenSpend: tokenSpendReader(runs, projectsRoot),
    // Answers to routed gates are read from the same forge the PR facts come
    // from, fetch or no fetch: reading a thread is not refreshing PR facts.
    ...(forge.gates ? { gateReplies: (repoPath: string, number: number, sinceMs: number) => forge.gates!.replies(repoPath, number, sinceMs) } : {}),
  });
  for (const l of reportLines(report, args.dryRun)) print(l);
  return report.lock === "busy" ? 2 : 0;
}

/* istanbul ignore next -- the process entry; `main` is what the tests drive */
if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.error(e);
    process.exit(1);
  });
}
