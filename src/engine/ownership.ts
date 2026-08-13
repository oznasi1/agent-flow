import { OpenSession } from "../types";

/** The slice of a run this module needs. `paths` are ALREADY canonical — the
 * caller applies `canon()`, which keeps this module free of `fs` and testable
 * without a temp directory. */
export interface OwnedRun {
  key: string;
  createdAt: number;
  paths: string[];
}

export interface OwnershipInput {
  /** Tracked runs, any order. Local (untracked) runs are built from the places
   * no tracked run claimed, so they never take part in this. */
  runs: OwnedRun[];
  /** `groupByPlace(readOpenSessions(...))` — canonical place -> its sessions,
   * oldest first. */
  sessionsByPlace: ReadonlyMap<string, OpenSession[]>;
}

export interface Ownership {
  /** sessionId -> the one run key that renders it as an agent. */
  sessionOwner: ReadonlyMap<string, string>;
  /** canonical path -> the one run key whose git state it counts toward. */
  pathOwner: ReadonlyMap<string, string>;
  /** Run keys owning at least one live session. */
  runsWithSession: ReadonlySet<string>;
}

/** Newest first; ties break on key ascending so the board is stable across
 * refreshes rather than depending on directory read order. */
function newestFirst(a: OwnedRun, b: OwnedRun): number {
  return b.createdAt - a.createdAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/**
 * Decide, for every live session and every directory, which single run owns it.
 *
 * Notepad and Explore runs launch in place rather than in a worktree, so several
 * records point at one checkout. Before this, `buildAll` attached every session
 * in a directory to every run holding it: two agents in one repo with four
 * notepad runs rendered as eight cards.
 *
 * A session goes to the newest run created at or before it started — the run
 * that plausibly launched it. If none qualifies (the session predates every run,
 * or `readOpenSessions` defaulted a missing `startedAt` to 0), the newest run
 * holding the place takes it.
 *
 * A path goes to whichever run claimed a live session in it, and only failing
 * that to the newest run holding it. Session first, because the run someone is
 * actually working in is the one whose card should carry that directory's dirty
 * state — not whichever record happens to be newest.
 *
 * Pure. No filesystem access; `paths` arrive canonical.
 */
export function resolveOwnership(i: OwnershipInput): Ownership {
  const byPath = new Map<string, OwnedRun[]>();
  for (const run of i.runs) {
    for (const p of run.paths) {
      const list = byPath.get(p);
      if (list) list.push(run);
      else byPath.set(p, [run]);
    }
  }
  for (const list of byPath.values()) list.sort(newestFirst);

  const sessionOwner = new Map<string, string>();
  const runsWithSession = new Set<string>();
  for (const [place, sessions] of i.sessionsByPlace) {
    const holders = byPath.get(place);
    if (!holders) continue; // nobody tracked holds it — it becomes a local card
    for (const s of sessions) {
      const owner = holders.find((r) => r.createdAt <= s.startedAt) ?? holders[0];
      sessionOwner.set(s.sessionId, owner.key);
      runsWithSession.add(owner.key);
    }
  }

  const pathOwner = new Map<string, string>();
  for (const [p, holders] of byPath) {
    // Sessions arrive oldest first, so a place with two sessions owned by
    // different runs resolves to the older session's owner — deterministic, and
    // the run that has been working there longest.
    const viaSession = (i.sessionsByPlace.get(p) ?? [])
      .map((s) => sessionOwner.get(s.sessionId))
      .find((k): k is string => k !== undefined);
    pathOwner.set(p, viaSession ?? holders[0].key);
  }

  return { sessionOwner, pathOwner, runsWithSession };
}
