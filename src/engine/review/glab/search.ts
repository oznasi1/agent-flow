// The one call the GitLab review strip rides on, and the parser for its response.
// Pure: no process, no filesystem.
import { ReviewRequest } from "../../../types";
import { mapMrMergeable, projectFromMrUrl } from "../../pr/glab/mr";

export const REVIEW_MR_LIMIT = 50;

/** `scope=reviews_for_me` is GitLab's own "asked for my review" lens, so the
 * filtering happens server-side exactly as the GitHub search's does.
 *
 * One honest difference from the GitHub path: GitLab returns no total count in the
 * body, so `issueCount` is however many rows came back. A user with more than
 * REVIEW_MR_LIMIT pending reviews therefore sees a full queue reading as complete
 * rather than as truncated. Documented in docs/FORGES.md. */
export const REVIEW_MR_PATH = `merge_requests?scope=reviews_for_me&state=opened&per_page=${REVIEW_MR_LIMIT}`;

/** Head-pipeline statuses that mean "still ahead of us". Uppercase, normalized at
 * every comparison, so the row's chip never depends on how a given instance spells
 * its statuses.
 *
 * Deliberately its own copy of the six strings that `pr/glab/mr.ts`'s
 * `PENDING_JOB` and `orchestrator/branchCi.ts`'s `GLAB_PENDING` also hold — see
 * `PENDING_JOB`'s comment for why three separate sets beat one shared constant:
 * they grade three different GitLab responses that share an enum today, and
 * `branchCi.ts` must not import a forge-specific module at all. */
const CI_PENDING = new Set(["CREATED", "PREPARING", "PENDING", "RUNNING", "WAITING_FOR_RESOURCE", "SCHEDULED"]);

/** A pipeline's status in the strip's vocabulary. Anything unrecognised reads as
 * "no CI" rather than as a failure — inventing a red row from a state we don't
 * know would send the user to an MR that is fine. Case-insensitive on every arm,
 * for the reason `CI_PENDING` above gives.
 *
 * Exported for `GlabReviewProvider.detail`, which is the only place a GitLab row's
 * CI verdict can come from: the queue call below carries no pipeline status to map. */
export function mapPipelineStatus(status?: string | null): ReviewRequest["ci"] {
  if (!status) return "none";
  const s = status.toUpperCase();
  if (s === "SUCCESS") return "passing";
  if (s === "FAILED") return "failing";
  if (CI_PENDING.has(s)) return "pending";
  return "none";
}

/** One row of the search response exactly as it arrives: every field `unknown`,
 * because nothing has validated it yet and `toRequest` below checks each one it
 * uses. Deliberately not `GlabMr` from `../../pr/glab/mr.ts`, which types an
 * overlapping subset concretely — that shape is read after `pickMr` has filtered,
 * and borrowing it here would turn honest runtime checks into unchecked
 * assertions. */
interface RawMr {
  iid?: unknown;
  title?: unknown;
  web_url?: unknown;
  draft?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  author?: { username?: unknown } | null;
  /** e.g. "group/sub/proj!12" — carries the nested project path, so identifying
   *  the project needs no extra call. See `projectOf`. */
  references?: { full?: unknown } | null;
  has_conflicts?: unknown;
  detailed_merge_status?: unknown;
  // No `head_pipeline` here, deliberately: GitLab's MR LIST endpoint sends no
  // pipeline field of any kind (verified against gitlab.com), so typing one would
  // claim a contract the API does not honour — and a fixture that then invented it
  // would test the mapper against a response that can never arrive. That is exactly
  // how this strip shipped with a CI chip stuck on "none". See `toRequest`.
}

/** Epoch ms, or 0 for anything unparsable — NaN would poison every comparator. */
function ms(iso: unknown): number {
  if (typeof iso !== "string") return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** The project path, from `references.full` ("group/sub/proj!12") when present and
 * from the url otherwise. Never the first two path segments: GitLab groups nest. */
function projectOf(raw: RawMr): string | null {
  const full = raw.references?.full;
  if (typeof full === "string" && full.includes("!")) {
    const path = full.slice(0, full.indexOf("!"));
    if (path) return path;
  }
  return typeof raw.web_url === "string" ? projectFromMrUrl(raw.web_url) : null;
}

/** One MR → a request, or null when it lacks an identity we could render or link. */
function toRequest(raw: RawMr): ReviewRequest | null {
  if (typeof raw.iid !== "number" || typeof raw.web_url !== "string" || !raw.web_url) return null;
  const repo = projectOf(raw);
  if (!repo) return null;
  return {
    id: `${repo}#${raw.iid}`,
    repo,
    repoName: repo.split("/").pop() ?? repo,
    number: raw.iid,
    title: typeof raw.title === "string" ? raw.title : "",
    url: raw.web_url,
    author: typeof raw.author?.username === "string" ? raw.author.username : "unknown",
    isDraft: raw.draft === true,
    createdAt: ms(raw.created_at),
    updatedAt: ms(raw.updated_at),
    // GitLab's list carries no diff stats. `GlabReviewProvider.detail` fills these
    // on row expansion — one call per row the user actually opens, never 50.
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    // GitLab's list carries no pipeline data at all — not a status, not an id, no
    // pipeline field whatsoever — so there is nothing here to grade. `"none"` is an
    // absence, and `GlabReviewProvider.detail` replaces it with the real verdict on
    // row expansion, from the single-MR GET that does carry `head_pipeline`. Same
    // trade as the diff size above: one call per row the user opens, never 50 per
    // refresh.
    ci: "none",
    // GitLab's MR list carries no approval state, and the strip's own row does not
    // need one to be useful. "none" rather than a per-row approvals round trip.
    review: "none",
    mergeable: mapMrMergeable(
      raw.has_conflicts === true,
      typeof raw.detailed_merge_status === "string" ? raw.detailed_merge_status : undefined,
    ),
    localPath: null,
    runKey: null,
    draftPath: null,
  };
}

/** Parse a `glab api merge_requests…` response. Null means "this is not a search
 * result" — an error object, a truncated body, anything the caller must treat as a
 * failed attempt rather than as an empty queue. An empty array is a *success* that
 * says you owe nobody a review, which is a different thing entirely. */
export function parseMrSearch(json: unknown): { issueCount: number; requests: ReviewRequest[] } | null {
  if (!Array.isArray(json)) return null;
  const requests = (json as RawMr[])
    .map((n) => (n && typeof n === "object" ? toRequest(n) : null))
    .filter((r): r is ReviewRequest => r !== null);
  return { issueCount: requests.length, requests };
}
