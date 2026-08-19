// GitLab's wire shapes and the pure mappers that turn them into `PrFacts`. The
// GitLab counterpart of `../facts.ts`, and deliberately a separate module rather
// than a merged shape: GitHub's `mergeable` + `mergeStateStatus` pair and
// GitLab's `has_conflicts` + `detailed_merge_status` pair reach the same verdict
// by different routes, and merging them would hide that.
//
// No process, no filesystem, no clock. Everything optional: GitLab's response
// shape varies by instance version, and a missing field must never throw.
import { PrCheck, PrFacts } from "../../../types";
import { pickByState } from "../facts";

export interface GlabMr {
  /** Project-scoped. THIS is the number — `id` is global and must never be used
   *  for a link or a project-scoped call. */
  iid?: number;
  web_url?: string;
  title?: string;
  state?: string; // opened | closed | merged | locked
  draft?: boolean;
  source_branch?: string;
  has_conflicts?: boolean;
  detailed_merge_status?: string;
  /** When true, there is nothing unresolved — which lets the caller skip the
   *  discussions round trip entirely. */
  blocking_discussions_resolved?: boolean;
  head_pipeline?: { id?: number; status?: string } | null;
  /** e.g. "group/sub/proj!12" — carries the nested project path, so identifying
   *  the project needs no extra call. */
  references?: { full?: string } | null;
  author?: { username?: string } | null;
  created_at?: string;
  updated_at?: string;
  changes_count?: string; // "3", or "20+" when GitLab caps it
}

export interface GlabJob {
  name?: string;
  status?: string;
  web_url?: string;
  allow_failure?: boolean;
}

export interface GlabApprovals {
  approved?: boolean;
  approvals_required?: number;
}

export interface GlabDiscussion {
  notes?: { resolvable?: boolean; resolved?: boolean }[];
}

const PENDING_JOB = new Set(["created", "preparing", "pending", "running", "waiting_for_resource", "scheduled"]);
const BLOCKED_MERGE = new Set(["not_approved", "discussions_not_resolved", "blocked_status"]);

/** GitLab's four MR states in the `PrFacts` vocabulary. `locked` is an OPEN merge
 * request with discussion locked, not a closed one — and an unrecognised state is
 * likewise treated as open rather than quietly retired. */
export function mapMrState(state?: string): PrFacts["state"] {
  if (state === "merged") return "MERGED";
  if (state === "closed") return "CLOSED";
  return "OPEN";
}

/** Tally one pipeline's jobs. `canceled`/`skipped`/`manual` count as neither pass
 * nor fail, matching `mapRollup`'s posture toward GitHub's equivalents: a cancelled
 * job is usually a superseded one, and calling it a failure would drag cards into
 * Needs you on every force-push. */
export function mapJobs(jobs: GlabJob[] | null | undefined): PrFacts["ci"] {
  const failing: PrCheck[] = [];
  let passing = 0;
  let pending = 0;
  for (const j of jobs ?? []) {
    if (j.status === "success") passing++;
    else if (j.status === "failed") failing.push({ name: j.name || "job", url: j.web_url || "" });
    else if (j.status && PENDING_JOB.has(j.status)) pending++;
  }
  return { passing, pending, failing };
}

/** GitHub's `UNSTABLE` — every required check passed and something optional did
 * not — expressed in GitLab's vocabulary: at least one job failed, and every
 * failing job was `allow_failure`. */
export function mapJobsAdvisory(jobs: GlabJob[] | null | undefined): boolean {
  const failed = (jobs ?? []).filter((j) => j.status === "failed");
  return failed.length > 0 && failed.every((j) => j.allow_failure === true);
}

/** GitLab's two mergeability fields collapsed into one verdict. An explicit
 * conflict wins over any detailed status. */
export function mapMrMergeable(hasConflicts?: boolean, detailed?: string): PrFacts["mergeable"] {
  if (hasConflicts === true) return "conflicting";
  if (detailed === "mergeable") return "clean";
  if (detailed === "need_rebase") return "behind";
  if (detailed && BLOCKED_MERGE.has(detailed)) return "blocked";
  return "unknown";
}

/** The approvals endpoint in the `PrFacts` review vocabulary. `changes_requested`
 * is deliberately unreachable: GitLab cannot report it here, and inventing it
 * would send a user to an MR nobody objected to. See docs/FORGES.md. */
export function mapApprovals(a: GlabApprovals | null | undefined): PrFacts["review"] {
  if (!a || typeof a !== "object") return "none";
  if (a.approved === true) return "approved";
  if (typeof a.approvals_required === "number" && a.approvals_required > 0) return "review_required";
  return "none";
}

/** Unresolved discussions in a `discussions` response. A discussion counts when any
 * of its resolvable notes is unresolved. Null means the shape was not one we
 * recognise — a caller must not render that as "0 open", because a wrong count
 * reads as fact and `null` does not.
 *
 * Unlike the GitHub path there is no outdated-thread exclusion: GitLab does not
 * expose the concept here, so this count is slightly more inclusive. Documented
 * rather than papered over. */
export function countUnresolvedDiscussions(json: unknown): number | null {
  if (!Array.isArray(json)) return null;
  if (json.some((d) => !d || typeof d !== "object")) return null;
  let open = 0;
  for (const d of json as GlabDiscussion[]) {
    const notes = Array.isArray(d.notes) ? d.notes : [];
    if (notes.some((n) => n && typeof n === "object" && n.resolvable === true && n.resolved !== true)) open++;
  }
  return open;
}

/** The project path from an MR url. Everything before `/-/`, minus the host —
 * NOT the first two path segments, because GitLab groups nest arbitrarily deep
 * (`group/sub/proj`). Returns one opaque identity the caller passes straight back
 * to `glab api`. */
export function projectFromMrUrl(url: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const cut = pathname.indexOf("/-/");
  if (cut === -1) return null;
  const project = pathname.slice(0, cut).split("/").filter(Boolean).join("/");
  return project === "" ? null : project;
}

/** Normalise one MR into our record, given the facts only the caller could fetch.
 * Null when it lacks an identity we can render or link — read by the caller as
 * "no MR", never as an error. */
export function toMrFacts(
  mr: GlabMr,
  extra: { ci: PrFacts["ci"]; ciAdvisory: boolean; review: PrFacts["review"]; unresolved: number | null },
): PrFacts | null {
  if (typeof mr.iid !== "number" || !mr.web_url) return null;
  return {
    number: mr.iid,
    url: mr.web_url,
    title: mr.title ?? "",
    state: mapMrState(mr.state),
    isDraft: mr.draft === true,
    ci: extra.ci,
    review: extra.review,
    unresolved: extra.unresolved,
    mergeable: mapMrMergeable(mr.has_conflicts, mr.detailed_merge_status),
    ciAdvisory: extra.ciAdvisory,
  };
}

/** One branch can carry several MRs across its history. Same precedence policy as
 * the GitHub path, shared through `pickByState`: prefer the live one, then the one
 * that landed, then the abandoned one; newest iid wins within a state. */
export function pickMr(mrs: GlabMr[]): GlabMr | undefined {
  return pickByState(mrs, (m) => ({ number: m.iid, state: mapMrState(m.state) }));
}
