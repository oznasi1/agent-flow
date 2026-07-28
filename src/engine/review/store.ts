import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ReviewRequest } from "../../types";

/** One file, not a directory: unlike PR facts there is no per-run partition —
 * the review queue is a single list belonging to you. Sits beside `runs/`,
 * `windows/` and `prfacts/`. */
export function defaultReviewsFile(): string {
  return path.join(os.homedir(), ".agentflow", "reviews.json");
}

export interface ReviewCache {
  fetchedAt: number;
  issueCount: number;
  requests: ReviewRequest[];
}

/** Null for missing, unreadable, or structurally wrong — a broken cache must
 * degrade to "we have nothing yet", never to a half-rendered strip. */
export function readReviewCache(file: string): ReviewCache | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ReviewCache> | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.fetchedAt !== "number" || !Array.isArray(parsed.requests)) return null;
    // Filter to values that actually look like a request. The Deck maps over these
    // and reads .repoName/.number off each one; a null or string element would throw
    // out of the refresh and freeze the board, the same failure pr/store.ts guards.
    const requests = (parsed.requests as unknown[]).filter(
      (r): r is ReviewRequest =>
        !!r && typeof r === "object" &&
        typeof (r as ReviewRequest).id === "string" &&
        typeof (r as ReviewRequest).number === "number",
    );
    return {
      fetchedAt: parsed.fetchedAt,
      issueCount: typeof parsed.issueCount === "number" ? parsed.issueCount : requests.length,
      requests,
    };
  } catch {
    return null;
  }
}

/** Atomic (temp + rename), so a failed write leaves the previous list untouched
 * rather than truncating the strip to nothing. Best-effort: a cache write must
 * never fail a refresh. */
export function writeReviewCache(file: string, cache: ReviewCache): void {
  const dir = path.dirname(file);
  const tempFile = path.join(dir, `.reviews.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tempFile, JSON.stringify(cache, null, 2) + "\n");
    fs.renameSync(tempFile, file);
  } catch {
    try {
      fs.rmSync(tempFile, { force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

/** Due for a refetch? A missing cache is stale; exactly at the TTL is stale.
 * Pure — the clock is injected. */
export function isReviewCacheStale(cache: ReviewCache | null, ttlMs: number, nowMs: number): boolean {
  if (!cache) return true;
  return nowMs - cache.fetchedAt >= ttlMs;
}
