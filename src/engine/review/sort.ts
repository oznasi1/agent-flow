import { ReviewRequest, ReviewSize, ReviewSort } from "../../types";

/** Lines changed, the size signal the strip sorts and buckets on. Files changed
 * alone would call a 3,000-line single-file rewrite "small". */
export function linesChanged(r: ReviewRequest): number {
  return r.additions + r.deletions;
}

/** S/M/L by lines changed — the same vocabulary the task pool's size lens uses,
 * so one mental model covers both panels. */
export function sizeBucket(lines: number): ReviewSize {
  if (lines <= 100) return "S";
  if (lines <= 500) return "M";
  return "L";
}

/** Order the strip. Drafts pin last in both modes — a draft asking for review is
 * still not the thing you should pick up first. Ties break on age, so "smallest"
 * stays deterministic across refreshes. Pure: returns a new array. */
export function sortRequests(reqs: ReviewRequest[], sort: ReviewSort): ReviewRequest[] {
  return [...reqs].sort((a, b) => {
    if (a.isDraft !== b.isDraft) return a.isDraft ? 1 : -1;
    if (sort === "smallest") {
      const bySize = linesChanged(a) - linesChanged(b);
      if (bySize !== 0) return bySize;
    }
    return a.createdAt - b.createdAt;
  });
}
