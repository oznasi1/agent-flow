// Building `RunStatus`es with no editor. `buildRunStatus` (engine/status.ts) never
// needed one — it reads git, the transcript, the sessions registry and the PR
// cache — but the Deck fed it two things this module has to source itself: which
// live sessions belong to which run (ownership), and PR facts fresh enough to act
// on. The ticket tracker is the one input that IS editor-bound (its credentials
// live in SecretStorage), so a headless status carries `ticket: null` and every
// ticket-shaped condition reads as not met — stated in the docs, not hidden.
import { CardAgent, PrEntry, PrEntryMap, Run, RunStatus, runKind } from "../types";
import { Flow, isPlace } from "../engine/orchestrator/model";
import { resolveOwnership } from "../engine/ownership";
import { canon } from "../engine/paths";
import { buildRunStatus } from "../engine/status";
import { groupByPlace, SessionsProbe } from "../engine/sessions";
import { isStale } from "../engine/pr/store";
import type { FetchResult } from "../engine/pr/provider";

export interface StatusDeps {
  runs: Run[];
  sessions: SessionsProbe;
  projectsRoot: string;
  nowMs: number;
  prEntries: (key: string) => PrEntryMap;
  sessionActivity: (cwd: string, sessionId: string) => CardAgent["activity"];
}

/** One status per tracked run, the way the Deck builds them minus the parts an
 * editor supplies. Sessions are attributed to runs with the same `resolveOwnership`
 * the board uses, so a place's "session ended its turn" reads the same here. */
export function headlessStatuses(d: StatusDeps): RunStatus[] {
  const tracked = d.runs.filter((r) => runKind(r) !== "review");
  const byPlace = groupByPlace(d.sessions.sessions);
  const ownership = resolveOwnership({
    runs: tracked.map((r) => ({ key: r.key, createdAt: r.createdAt, paths: r.repos.map((x) => canon(x.path)) })),
    sessionsByPlace: byPlace,
  });
  return tracked.map((run) => {
    const agents: CardAgent[] = [];
    for (const repo of run.repos) {
      for (const s of byPlace.get(canon(repo.path)) ?? []) {
        if (ownership.sessionOwner.get(s.sessionId) !== run.key) continue;
        agents.push({ session: s, activity: d.sessionActivity(s.cwd, s.sessionId), repo: repo.name });
      }
    }
    return buildRunStatus({
      run, ticket: null, projectsRoot: d.projectsRoot, nowMs: d.nowMs,
      prs: d.prEntries(run.key), agents, sessionsReadable: d.sessions.readable,
    });
  });
}

export interface RefreshDeps {
  runs: Run[];
  flows: Flow[];
  nowMs: number;
  ttlMs: number;
  prEntries: (key: string) => PrEntryMap;
  prEligible: (repo: { path: string; isGit: boolean; branch?: string }) => boolean;
  fetch: (repoPath: string, branch: string | null, key: string) => Promise<FetchResult>;
  writePrEntry: (key: string, repo: string, entry: PrEntry) => void;
  log: (m: string) => void;
}

/** Refresh the PR cache for exactly the runs an ARMED flow watches, and only where
 * the cached entry is stale — the same TTL rule the Deck applies, applied to the
 * same store, so the Deck and the tick never disagree about a PR. Bounded on
 * purpose: a machine with a hundred runs and one armed flow makes one forge call
 * per watched repo, not a hundred. Awaited, unlike the Deck's queue, because a
 * one-shot pass has no later tick for a fetch to land in. A provider must never
 * throw, but a throw here still stamps the entry — an unstamped entry is stale
 * forever. Returns how many fetches were made. */
export async function refreshWatchedPrs(d: RefreshDeps): Promise<number> {
  const watched = new Set<string>();
  for (const f of d.flows) {
    if (!f.armed) continue;
    for (const n of f.nodes) if (isPlace(n)) watched.add(n.runKey);
  }
  let fetched = 0;
  for (const run of d.runs) {
    if (!watched.has(run.key) || runKind(run) === "review") continue;
    const stored = d.prEntries(run.key);
    for (const repo of run.repos) {
      if (!d.prEligible(repo) || !isStale(stored[repo.name], d.ttlMs, d.nowMs)) continue;
      let res: FetchResult;
      try {
        res = await d.fetch(repo.path, repo.branch ?? null, run.key);
      } catch {
        res = { ok: false };
      }
      fetched++;
      if (!res.ok) d.log(`pr fetch ${run.key}/${repo.name} failed`);
      const previous = stored[repo.name];
      d.writePrEntry(run.key, repo.name, res.ok
        ? { facts: res.facts, fetchedAt: d.nowMs }
        : { facts: previous?.facts ?? null, fetchedAt: d.nowMs, error: true });
    }
  }
  return fetched;
}
