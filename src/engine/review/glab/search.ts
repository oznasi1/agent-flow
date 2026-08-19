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

const CI_PENDING = new Set(["created", "preparing", "pending", "running", "waiting_for_resource", "scheduled"]);

/** A pipeline's status in the strip's vocabulary. Anything unrecognised reads as
 * "no CI" rather than as a failure — inventing a red row from a state we don't
 * know would send the user to an MR that is fine. */
export function mapPipelineStatus(status?: string | null): ReviewRequest["ci"] {
  if (!status) return "none";
  if (status === "success") return "passing";
  if (status === "failed") return "failing";
  if (CI_PENDING.has(status)) return "pending";
  return "none";
}

interface RawMr {
  iid?: unknown;
  title?: unknown;
  web_url?: unknown;
  draft?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  author?: { username?: unknown } | null;
  references?: { full?: unknown } | null;
  has_conflicts?: unknown;
  detailed_merge_status?: unknown;
  head_pipeline?: { status?: unknown } | null;
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
    ci: mapPipelineStatus(typeof raw.head_pipeline?.status === "string" ? raw.head_pipeline.status : null),
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
