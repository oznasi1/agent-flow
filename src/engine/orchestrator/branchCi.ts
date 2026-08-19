// Is a named branch of a named repo green? The MAPPING half of that question and
// nothing else: this module turns one `gh` response into one verdict and owns no
// process, no filesystem and no clock.
//
// It has to be that austere because of who imports it. `conditions.ts` needs this
// verdict type, and `conditions.ts` is bundled into the webview (see its own header
// comment: one hop into anything holding `child_process`/`fs`/`path`/`os` and
// esbuild stops resolving, which `test/webview/webviewGraph.test.ts` pins). So the
// `gh` invocation itself lives in `deckView.ts`, host-side, which spawns it through
// the same injected `Runner` seam every PR fetch already uses and hands the result
// here to be graded.
//
// `mapRollup` in `../pr/facts.ts` is the precedent, including its posture toward
// states nobody asked about: a shape we did not expect is never quietly rounded
// into a pass.
//
// Where this DIFFERS from `mapRollup`, on purpose, and the difference is worth
// knowing before trusting either: `mapRollup` tallies the individual checks itself
// and counts `CANCELLED`/`NEUTRAL`/`SKIPPED`/`STALE` as neither pass nor fail, so a
// PR whose only check was skipped comes out `passing: 0` — not a pass. GitHub's
// AGGREGATE `statusCheckRollup.state`, which is what this module reads, folds those
// same outcomes toward `SUCCESS`, so a branch whose required build was SKIPPED reads
// as `"passed"` here. That is GitHub's own answer to "is this commit green" (it is
// the state the commit shows in the UI and the one a branch protection rule grades),
// and closing the gap would mean fetching the `contexts` list and tallying it here —
// a second, heavier query, and a second definition of "green" to keep in step with
// the first. Not done: a skipped required build is a repo configuration a user can
// see, whereas the case that would actually be dangerous is already correct — a
// commit with genuinely NO checks has `statusCheckRollup: null`, which is `"unknown"`,
// which is not green.
//
// GitLab is graded from a different fact and lands in a different place, worth
// knowing before trusting either: `mapGlabBranchStatus` reads the newest PIPELINE
// for the ref, which is a whole-pipeline verdict rather than an aggregate over
// checks. That makes it STRICTER than the GitHub arm above — a `skipped` pipeline
// reads `"unknown"` here, where GitHub's rollup would have folded a skipped check
// toward `SUCCESS`. Deliberate: the dangerous direction is a gate that opens on a
// pipeline nobody ran, and `"unknown"` is not green.

/** What we can say about a branch's CI. `unknown` is the honest answer for every
 * unreadable fact — a failed call, a timed-out call, a rate limit, a response shape
 * this build does not recognise, a branch that does not exist — and it is NOT
 * green. `conditions.ts`'s `branch-ci-passed` arm is met by `"passed"` alone. */
export type BranchCiStatus = "passed" | "failed" | "pending" | "unknown";

/** The rollup on the branch's head commit, in one round trip.
 *
 * GraphQL's `statusCheckRollup`, not REST's `commits/{ref}/status`, and that is the
 * whole point of this query rather than a shorter one: the REST combined status
 * grades LEGACY COMMIT STATUSES only. Probed against this repo, whose CI is a
 * GitHub Actions check run, `repos/{owner}/{repo}/commits/main/status` answers
 * `{"state":"pending","total_count":0}` on a branch that is green — a deploy gate
 * built on it would never open for any Actions-only repo, which is nearly all of
 * them. The rollup grades check runs and statuses together, and is the same notion
 * `mapRollup` already reads for a pull request.
 *
 * Owner and name come from gh's own `{owner}`/`{repo}` placeholders, resolved from
 * the git remote of the directory the call runs in — never from the condition's
 * `repo`, which is Agent Flow's name for a CHECKOUT. Those two routinely differ:
 * this product's own worktrees are directories like `bite-me-3a`, and a flow's repo
 * name is the folder, not the GitHub repository. Substitution happens only in
 * `-F` values, which is why owner and name use `-F` while `branch` uses `-f`:
 * `-f` sends the value as an uninterpreted string, so a branch named `123` is not
 * coerced to an Int and a branch starting with `@` is not read as a filename. */
export const BRANCH_CI_QUERY =
  "query($owner:String!,$name:String!,$branch:String!){repository(owner:$owner,name:$name){" +
  "ref(qualifiedName:$branch){target{... on Commit{statusCheckRollup{state}}}}}}";

/** The argv for that call. Takes the branch alone: the repo half of a
 * `repo#branch` key selects the working DIRECTORY the call is made in (the caller's
 * `cwd`), and cannot appear in the argv without overriding the remote-derived name
 * this query deliberately relies on — see `BRANCH_CI_QUERY`. The plan's sketch of
 * this signature took a `repo` too; passing one would have been a lie about where
 * the repository identity comes from. */
export const BRANCH_CI_ARGS = (branch: string): string[] => [
  "api",
  "graphql",
  "-f",
  `query=${BRANCH_CI_QUERY}`,
  "-F",
  "owner={owner}",
  "-F",
  "name={repo}",
  // `-f`, not `-F`: raw string, no type coercion and no `@file` reading.
  "-f",
  `branch=${branch}`,
];

/** The rollup state, wherever it lives in a response we recognise, or `null`.
 *
 * Two shapes are read. The GraphQL one `BRANCH_CI_ARGS` actually asks for, and a
 * bare top-level `{ state }` — the REST combined-status shape — because a verdict
 * mapper that only understands the exact query it ships with is one refactor away
 * from silently answering `unknown` for every branch. Neither path invents a state:
 * anything that is not a string reads as no state at all. */
function readState(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  // A GraphQL response carrying `errors` is not a fact, even when `data` is
  // partially populated: gh exits non-zero on one, so this is belt-and-braces for
  // a caller that ever stops relying on the exit code.
  const errors = (json as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.length > 0) return null;
  const rollup = (
    json as {
      data?: { repository?: { ref?: { target?: { statusCheckRollup?: unknown } } } };
    }
  ).data?.repository?.ref?.target?.statusCheckRollup;
  const nested = rollup && typeof rollup === "object" ? (rollup as { state?: unknown }).state : undefined;
  const state = nested ?? (json as { state?: unknown }).state;
  return typeof state === "string" ? state : null;
}

/**
 * Grade one `gh` response.
 *
 * `SUCCESS` is the ONLY state that becomes `"passed"`. Everything else is graded
 * for the drawer's benefit — `FAILURE`/`ERROR` as `"failed"`, `PENDING`/`EXPECTED`
 * as `"pending"` (an expected-but-uncreated required check has not run, so it is
 * still ahead of us, not behind us) — and anything else at all, including a null
 * rollup (a commit with no checks), a missing branch (`ref: null`), a state this
 * build has never heard of, and every non-object input, is `"unknown"`.
 *
 * Case-insensitive: GraphQL shouts (`SUCCESS`), REST whispers (`success`), and the
 * verdict must not depend on which one answered.
 */
export function mapBranchStatus(json: unknown): BranchCiStatus {
  const state = readState(json);
  if (state === null) return "unknown";
  switch (state.toUpperCase()) {
    case "SUCCESS":
      return "passed";
    case "FAILURE":
    case "ERROR":
      return "failed";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "unknown";
  }
}

/** The `CondContext.branchCi` key for one repo's one branch. Exported so the
 * fetcher (`deckView.ts`) and the reader (`conditions.ts`) cannot drift into
 * writing and looking up two different strings — and keyed by BOTH halves because
 * a flow that waits on `main` and a flow that waits on `release` in the same repo
 * are asking different questions. */
export const branchCiKey = (repo: string, branch: string): string => `${repo}#${branch}`;

/** The newest pipeline for one ref. `per_page=1` because only the head matters,
 * and the ref is url-encoded: a branch name may contain `/`, `&` or `=`, any of
 * which would otherwise rewrite the query string. */
export const GLAB_BRANCH_CI_PATH = (branch: string): string =>
  `projects/:fullpath/pipelines?ref=${encodeURIComponent(branch)}&per_page=1`;

/** The argv for that call. Takes the branch alone, for the same reason
 * `BRANCH_CI_ARGS` does: the repo half of a `repo#branch` key selects the working
 * DIRECTORY the call is made in, and `:fullpath` resolves the project from that
 * directory's git remote. */
export const GLAB_BRANCH_CI_ARGS = (branch: string): string[] => ["api", GLAB_BRANCH_CI_PATH(branch)];

const GLAB_PENDING = new Set(["CREATED", "WAITING_FOR_RESOURCE", "PREPARING", "PENDING", "RUNNING", "SCHEDULED"]);

/** Grade one `glab api pipelines?ref=…` response.
 *
 * `success` is the ONLY status that becomes `"passed"`. Everything else is graded
 * for the drawer's benefit, and anything at all that is not a status we recognise —
 * a non-array payload, an empty list (a ref with no pipeline), `canceled`,
 * `skipped`, `manual`, a status this build has never heard of — is `"unknown"`,
 * which is not green. Case-insensitive, so the verdict does not depend on how a
 * given instance spells its statuses. */
export function mapGlabBranchStatus(json: unknown): BranchCiStatus {
  if (!Array.isArray(json)) return "unknown";
  const status = (json[0] as { status?: unknown } | undefined)?.status;
  if (typeof status !== "string") return "unknown";
  const s = status.toUpperCase();
  if (s === "SUCCESS") return "passed";
  if (s === "FAILED") return "failed";
  if (GLAB_PENDING.has(s)) return "pending";
  return "unknown";
}
