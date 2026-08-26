import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PrEntry, PrEntryMap } from "../../types";

/** ~/.agentflow/prfacts — one file per run, beside `runs/` and `windows/`.
 * Derived and disposable, so it stays out of the durable Run record. */
export function defaultPrFactsDir(): string {
  return path.join(os.homedir(), ".agentflow", "prfacts");
}

function fileFor(dir: string, key: string): string {
  return path.join(dir, `${key}.json`);
}

/** A run's entries, or `{}` for a missing, unreadable or corrupt file — a broken
 * cache must degrade to "no facts", never break the board. */
export function readPrEntries(dir: string, key: string): PrEntryMap {
  try {
    const parsed = JSON.parse(fs.readFileSync(fileFor(dir, key), "utf8")) as unknown;
    // Reject anything that isn't a plain object — an array passes `typeof ===
    // "object"` but `all[repo] = entry` on an array sets a non-index property
    // that JSON.stringify silently drops, leaving the file stuck at "[]" forever.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    // Filter to values that actually look like a PrEntry. A value like `null`
    // (e.g. `{"api": null}`) would otherwise reach prSignals/allMerged, both of
    // which deref `.facts` on it — the TypeError propagates out of buildAll and
    // freezes the whole board, since refresh's catch means no deck:runs at all.
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([, v]) => !!v && typeof v === "object" && typeof (v as PrEntry).fetchedAt === "number",
      ),
    ) as PrEntryMap;
  } catch {
    return {};
  }
}

/** Merge one repo's entry into the run's file. Best-effort — a cache write must
 * never fail a refresh. Uses atomic write (temp + rename) so a failed write
 * never truncates or evicts unrelated repos' entries. */
export function writePrEntry(dir: string, key: string, repo: string, entry: PrEntry): void {
  const target = fileFor(dir, key);
  const tempFile = path.join(
    dir,
    `.${key}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    const all = readPrEntries(dir, key);
    all[repo] = entry;
    fs.mkdirSync(dir, { recursive: true });
    // Write to a temp file first, then atomically rename. On POSIX and
    // same-volume on Windows, rename is atomic: a failed write leaves the
    // previous file completely untouched.
    fs.writeFileSync(tempFile, JSON.stringify(all, null, 2) + "\n");
    fs.renameSync(tempFile, target);
  } catch {
    /* the cache is a convenience — never fail a caller over it */
    try {
      fs.rmSync(tempFile, { force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

/**
 * How the last round of PR reads went, across every run in the cache — the input
 * Doctor's "PR reads" row and the board's footer note both need.
 *
 * The `*Fs` half of the pure `unreadRepos` rule in `engine/bucket.ts`: the rule
 * (an entry with `error: true` cannot be trusted, whether it carries stale facts
 * or none) lives there so the webview can apply it to the runs it already has;
 * this reads the same rule off disk for a caller that has no board — Doctor runs
 * whether or not the Deck was ever opened.
 *
 * Counts RUNS, not repos, because that is the unit the note speaks in and the
 * unit a card maps to. `repos` is the deduped, sorted set of the ones that failed,
 * for the detail line that tells you which to go and try by hand.
 *
 * Best-effort throughout: a cache is a convenience, and a Doctor row must never
 * be the thing that throws.
 */
export function summarisePrReads(dir: string): { runs: number; repos: string[] } {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { runs: 0, repos: [] };
  }
  const repos = new Set<string>();
  let runs = 0;
  for (const name of names) {
    // `.tmp` files are writePrEntry's own, left behind only by a crashed write;
    // anything not `.json` was never one of ours.
    if (name.startsWith(".") || !name.endsWith(".json")) continue;
    const entries = readPrEntries(dir, name.slice(0, -".json".length));
    const failed = Object.entries(entries).filter(([, e]) => e.error === true);
    if (failed.length === 0) continue;
    runs++;
    for (const [repo] of failed) repos.add(repo);
  }
  return { runs, repos: [...repos].sort((a, b) => a.localeCompare(b)) };
}

/** Forget a run's PR facts (called alongside `removeRun`). */
export function removePrEntries(dir: string, key: string): void {
  try {
    fs.rmSync(fileFor(dir, key), { force: true });
  } catch {
    /* best-effort */
  }
}

/** Is this entry due for a refetch? A missing entry is stale; an entry exactly at
 * the TTL is stale. Pure — `nowMs` is injected so callers control the clock.
 *
 * Takes anything carrying a `fetchedAt` rather than a `PrEntry` specifically: the
 * rule is about a timestamp, and `deckView.ts`'s branch-CI cache ages out on the
 * same one (same `gh`, same TTL setting) without being a PR entry. Widening the
 * parameter is what stops that second caller from restating the rule — including
 * the "exactly at the TTL is stale" edge, which is the half a re-implementation
 * gets wrong. */
export function isStale(entry: PrEntry | { fetchedAt: number } | undefined, ttlMs: number, nowMs: number): boolean {
  if (!entry) return true;
  return nowMs - entry.fetchedAt >= ttlMs;
}
