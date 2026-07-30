import { PrFacts, ReviewRequest } from "../../types";
import { mapReview } from "../pr/facts";

/** The one call the whole strip rides on. Verified against gh 2.89.0: returns
 * size, rollup, decision and mergeability for every request in ~3s. The rollup
 * exposes only an aggregate `state` — failing check *names* need a per-PR call,
 * which is what row expansion is for. */
export const REVIEW_SEARCH_QUERY =
  "query($q:String!,$n:Int!){search(query:$q,type:ISSUE,first:$n){issueCount nodes{" +
  "... on PullRequest{number title url isDraft createdAt updatedAt additions deletions changedFiles " +
  "author{login} repository{nameWithOwner} reviewDecision mergeable " +
  "commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}}";

/** `review-requested:` is the superset — it includes requests made to a team you
 * belong to, which `user-review-requested:` excludes.
 *
 * `archived:false` drops requests living in archived repositories. An archived
 * repo is read-only, so GitHub refuses a review on one: those rows could only
 * ever offer verbs that fail, and an agent review nobody can post. They also
 * never age out of the queue, which is what made them the loudest rows in it.
 *
 * Filtered here rather than in `parseSearch` because `issueCount` comes back
 * from this same search: excluding the rows server-side moves the count with
 * them, where a client-side filter would leave a complete queue reading as
 * "showing 9 of 10" — truncation that never happened. */
export const REVIEW_SEARCH_Q = "is:pr is:open review-requested:@me archived:false";

export const REVIEW_SEARCH_LIMIT = 50;

const CI_FAILING = new Set(["FAILURE", "ERROR"]);
const CI_PENDING = new Set(["PENDING", "EXPECTED"]);

/** The rollup's aggregate state. Anything unrecognised reads as "no CI" rather
 * than as a failure — inventing a red row from a state we don't know would send
 * the user to a PR that is fine. */
export function mapRollupState(state?: string | null): ReviewRequest["ci"] {
  if (!state) return "none";
  if (CI_FAILING.has(state)) return "failing";
  if (CI_PENDING.has(state)) return "pending";
  if (state === "SUCCESS") return "passing";
  return "none";
}

/** GraphQL's `mergeable` enum, which is not gh's REST pair — `mapMergeable`
 * would read MERGEABLE as "unknown" because it looks at mergeStateStatus. */
export function mapGraphMergeable(m?: string | null): PrFacts["mergeable"] {
  if (m === "CONFLICTING") return "conflicting";
  if (m === "MERGEABLE") return "clean";
  return "unknown";
}

/** Epoch ms, or 0 for anything unparsable — NaN would poison every comparator. */
function ms(iso: unknown): number {
  if (typeof iso !== "string") return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

function count(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

interface RawNode {
  number?: unknown;
  title?: unknown;
  url?: unknown;
  isDraft?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  additions?: unknown;
  deletions?: unknown;
  changedFiles?: unknown;
  author?: { login?: unknown } | null;
  repository?: { nameWithOwner?: unknown } | null;
  reviewDecision?: unknown;
  mergeable?: unknown;
  commits?: { nodes?: { commit?: { statusCheckRollup?: { state?: unknown } | null } }[] } | null;
}

/** One node → a request, or null when it lacks an identity we could render or
 * link. `type: ISSUE` means issues and non-PR nodes come back as `{}`. */
function toRequest(raw: RawNode): ReviewRequest | null {
  const repo = raw.repository?.nameWithOwner;
  if (typeof raw.number !== "number" || typeof raw.url !== "string" || !raw.url) return null;
  if (typeof repo !== "string" || !repo) return null;
  const rollup = raw.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  return {
    id: `${repo}#${raw.number}`,
    repo,
    repoName: repo.split("/").pop() ?? repo,
    number: raw.number,
    title: typeof raw.title === "string" ? raw.title : "",
    url: raw.url,
    author: typeof raw.author?.login === "string" ? raw.author.login : "unknown",
    isDraft: raw.isDraft === true,
    createdAt: ms(raw.createdAt),
    updatedAt: ms(raw.updatedAt),
    additions: count(raw.additions),
    deletions: count(raw.deletions),
    changedFiles: count(raw.changedFiles),
    ci: mapRollupState(typeof rollup === "string" ? rollup : null),
    review: mapReview(typeof raw.reviewDecision === "string" ? raw.reviewDecision : null),
    mergeable: mapGraphMergeable(typeof raw.mergeable === "string" ? raw.mergeable : null),
    localPath: null,
    runKey: null,
    draftPath: null,
  };
}

/** Parse a `gh api graphql` response. Null means "this is not a search result" —
 * an errors payload, a truncated body, anything the caller must treat as a failed
 * attempt rather than as an empty queue. An empty `nodes` array is a *success*
 * that says you owe nobody a review, which is a different thing entirely. */
export function parseSearch(json: unknown): { issueCount: number; requests: ReviewRequest[] } | null {
  const search = (json as { data?: { search?: { issueCount?: unknown; nodes?: unknown } } } | null)?.data?.search;
  if (!search || !Array.isArray(search.nodes)) return null;
  const requests = (search.nodes as RawNode[])
    .map((n) => (n && typeof n === "object" ? toRequest(n) : null))
    .filter((r): r is ReviewRequest => r !== null);
  const issueCount = typeof search.issueCount === "number" ? search.issueCount : requests.length;
  return { issueCount, requests };
}
