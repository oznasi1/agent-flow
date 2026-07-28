import { PrCheck, PrFacts } from "../../types";

/** The subset of `gh pr list --json …` we read. Everything optional: gh's shape
 * varies by host and version, and a missing field must never throw. */
export interface GhPr {
  number?: number;
  url?: string;
  title?: string;
  state?: string;
  isDraft?: boolean;
  headRefName?: string;
  mergeable?: string;
  mergeStateStatus?: string;
  reviewDecision?: string | null;
  statusCheckRollup?: GhCheck[] | null;
}

/** One rollup entry. `CheckRun` carries status + conclusion + detailsUrl;
 * `StatusContext` (a legacy commit status) carries state + targetUrl instead. */
export interface GhCheck {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  detailsUrl?: string;
  targetUrl?: string;
}

const FAIL_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED"]);
const FAIL_STATES = new Set(["FAILURE", "ERROR"]);
const PENDING_STATUSES = new Set(["QUEUED", "IN_PROGRESS"]);
const CLEAN_MERGE_STATES = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);

/**
 * Tally a `statusCheckRollup`. `CANCELLED`/`NEUTRAL`/`SKIPPED`/`STALE` count as
 * neither pass nor fail: a cancelled run is usually a superseded one, and calling
 * it a failure would drag cards into Needs you on every force-push.
 */
export function mapRollup(rollup: GhCheck[] | null | undefined): PrFacts["ci"] {
  const failing: PrCheck[] = [];
  let passing = 0;
  let pending = 0;
  for (const c of rollup ?? []) {
    const name = c.name || c.context || "check";
    const url = c.detailsUrl || c.targetUrl || "";
    if (c.state) {
      // StatusContext — graded by `state`, which has no pending/queued split.
      if (FAIL_STATES.has(c.state)) failing.push({ name, url });
      else if (c.state === "PENDING") pending++;
      else if (c.state === "SUCCESS") passing++;
      continue;
    }
    // CheckRun — an unfinished run has no meaningful conclusion yet, so status wins.
    if (c.status && PENDING_STATUSES.has(c.status)) pending++;
    else if (c.conclusion && FAIL_CONCLUSIONS.has(c.conclusion)) failing.push({ name, url });
    else if (c.conclusion === "SUCCESS") passing++;
  }
  return { passing, pending, failing };
}

/** Collapse gh's two mergeability fields into one verdict. */
export function mapMergeable(mergeable?: string, mergeState?: string): PrFacts["mergeable"] {
  if (mergeable === "CONFLICTING" || mergeState === "DIRTY") return "conflicting";
  if (mergeState === "BEHIND") return "behind";
  if (mergeState === "BLOCKED") return "blocked";
  if (mergeState && CLEAN_MERGE_STATES.has(mergeState)) return "clean";
  return "unknown";
}

export function mapReview(decision?: string | null): PrFacts["review"] {
  switch (decision) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "REVIEW_REQUIRED":
      return "review_required";
    default:
      return "none";
  }
}

/** Normalise one gh PR into our record. Null when it lacks an identity we can
 * render or link — treated by the caller as "no PR", never as an error. */
export function toPrFacts(pr: GhPr, unresolved: number | null): PrFacts | null {
  if (typeof pr.number !== "number" || !pr.url) return null;
  const state = pr.state === "MERGED" || pr.state === "CLOSED" ? pr.state : "OPEN";
  return {
    number: pr.number,
    url: pr.url,
    title: pr.title ?? "",
    state,
    isDraft: pr.isDraft === true,
    ci: mapRollup(pr.statusCheckRollup),
    review: mapReview(pr.reviewDecision),
    unresolved,
    mergeable: mapMergeable(pr.mergeable, pr.mergeStateStatus),
    ciAdvisory: pr.mergeStateStatus === "UNSTABLE",
  };
}

const STATE_RANK: Record<string, number> = { OPEN: 3, MERGED: 2, CLOSED: 1 };

/** One branch can carry several PRs across its history. Prefer the live one, then
 * the one that landed, then the abandoned one; newest wins within a state. */
export function pickPr(prs: GhPr[]): GhPr | undefined {
  return [...prs]
    .filter((p) => typeof p.number === "number")
    .sort(
      (a, b) =>
        (STATE_RANK[b.state ?? ""] ?? 0) - (STATE_RANK[a.state ?? ""] ?? 0) ||
        (b.number as number) - (a.number as number),
    )[0];
}

/** Owner and repo from a PR url, so the GraphQL call needs no extra lookup.
 * Host-agnostic: the first two path segments, whatever the hostname. */
export function parseRepoFromUrl(url: string): { owner: string; repo: string } | null {
  let parts: string[];
  try {
    parts = new URL(url).pathname.split("/").filter(Boolean);
  } catch {
    return null;
  }
  if (parts.length < 2) return null;
  return { owner: parts[0], repo: parts[1] };
}

/** Unresolved review threads in a `reviewThreads` GraphQL response. Null means the
 * shape was not one we recognise — a caller must not render that as "0 open".
 * An outdated thread is not counted: it refers to code the PR has since replaced. */
export function countUnresolved(json: unknown): number | null {
  const nodes = (json as {
    data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: unknown } } } };
  } | null)?.data?.repository?.pullRequest?.reviewThreads?.nodes;
  if (!Array.isArray(nodes)) return null;
  return (nodes as { isResolved?: boolean; isOutdated?: boolean }[]).filter(
    (n) => !n?.isResolved && !n?.isOutdated,
  ).length;
}
