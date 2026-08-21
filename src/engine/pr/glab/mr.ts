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

/** The fields of a `merge_requests` row that THIS module's mappers read, and only
 * those. GitLab sends far more; typing a field here that nothing reads would claim
 * a contract with the API that no test can break. The review strip's own
 * `RawMr` (`../../review/glab/search.ts`) types a different, overlapping subset —
 * every field `unknown`, because it validates each one at runtime — and the two are
 * deliberately not merged: this shape is read POST-validation (`pickMr` has already
 * filtered on `typeof iid === "number"`), so concrete-but-optional is honest here
 * and would be an unchecked assertion there. */
export interface GlabMr {
  /** Project-scoped. THIS is the number — `id` is global and must never be used
   *  for a link or a project-scoped call. */
  iid?: number;
  web_url?: string;
  title?: string;
  state?: string; // opened | closed | merged | locked
  draft?: boolean;
  has_conflicts?: boolean;
  detailed_merge_status?: string;
  /** When true, there is nothing unresolved — which lets the caller skip the
   *  discussions round trip entirely. */
  blocking_discussions_resolved?: boolean;
  /** **Only ever present on the SINGLE-MR endpoint — never on the MR list.**
   *  Verified against gitlab.com: a `merge_requests?…` row carries no pipeline
   *  field of any kind, not `head_pipeline` and not a substitute. That absence is
   *  exactly why `GlabProvider.fetch` follows its list call with a `show` call
   *  (`mrShowPath`) and reads the pipeline off THAT record.
   *
   *  Do NOT "optimize away" that extra round trip. Reading this field off a list
   *  row yields `undefined`, the jobs call is then skipped, and every GitLab card
   *  silently reports no CI — no error, no failing test, just a Deck that can never
   *  show a red pipeline. That is the bug this comment exists to prevent recurring;
   *  it shipped once already because a fixture invented this field on a list row.
   *
   *  The id alone: the jobs call is what grades this pipeline, so its `status` is
   *  never read on this path (the review strip reads a status instead — see
   *  `GlabReviewProvider.detail`). */
  head_pipeline?: { id?: number } | null;
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

/** Job statuses that mean "still ahead of us". Uppercase, and every comparison
 * against it normalizes first, so a verdict never depends on how a given instance
 * spells its statuses — the same posture `mapGlabBranchStatus` takes.
 *
 * The same six strings appear in `review/glab/search.ts` (`CI_PENDING`) and
 * `orchestrator/branchCi.ts` (`GLAB_PENDING`), and the duplication is deliberate:
 * these are three DIFFERENT GitLab responses — a job's status, an MR's
 * head-pipeline status, and a ref's newest-pipeline status — that happen to share
 * an enum today. One shared constant would turn a future divergence in any one of
 * them into a cross-module change, and `branchCi.ts` additionally must not import
 * a forge-specific module at all (it is bundled into the webview; see its header). */
const PENDING_JOB = new Set(["CREATED", "PREPARING", "PENDING", "RUNNING", "WAITING_FOR_RESOURCE", "SCHEDULED"]);
/** `detailed_merge_status` values that block the merge button. Case-sensitive,
 * unlike the CI statuses above: this is a documented lowercase REST enum, and
 * nothing has been observed spelling it otherwise. */
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
 * Needs you on every force-push.
 *
 * Case-insensitive on every arm, not just the pending one: a half-normalized
 * comparison would read `SUCCESS` as neither passing nor pending. */
export function mapJobs(jobs: GlabJob[] | null | undefined): PrFacts["ci"] {
  const failing: PrCheck[] = [];
  let passing = 0;
  let pending = 0;
  for (const j of jobs ?? []) {
    const status = j.status?.toUpperCase();
    if (status === "SUCCESS") passing++;
    else if (status === "FAILED") failing.push({ name: j.name || "job", url: j.web_url || "" });
    else if (status && PENDING_JOB.has(status)) pending++;
  }
  return { passing, pending, failing };
}

/** GitHub's `UNSTABLE` — every required check passed and something optional did
 * not — expressed in GitLab's vocabulary: at least one job failed, and every
 * failing job was `allow_failure`. Reads `failed` exactly as `mapJobs` does,
 * case included: these two grade the same list and must not disagree about which
 * jobs failed. */
export function mapJobsAdvisory(jobs: GlabJob[] | null | undefined): boolean {
  const failed = (jobs ?? []).filter((j) => j.status?.toUpperCase() === "FAILED");
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
