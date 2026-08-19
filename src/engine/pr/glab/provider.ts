// MR facts for one repo's one branch, through `glab api`. The GitLab counterpart
// of `../provider.ts`, spawning through the same injected `Runner` so no test
// forks a process.
//
// `projects/:fullpath` is glab's own placeholder, resolved from the git remote of
// the directory the call runs in — never from Agent Flow's name for a CHECKOUT.
// Those two routinely differ: this product's own worktrees are directories like
// `bite-me-3a`. Same discipline `orchestrator/branchCi.ts` documents for gh's
// `{owner}`/`{repo}`.
import {
  countUnresolvedDiscussions, GlabApprovals, GlabJob, GlabMr,
  mapApprovals, mapJobs, mapJobsAdvisory, pickMr, toMrFacts,
} from "./mr";
import { execRunner } from "../provider";
import type { FetchResult, Locate, PrProvider, Runner } from "../provider";
// `import type`, matching `../../forge/types`'s own discipline: it is an
// interfaces-only module whose safety rests on every import of and from it being
// erased at build time (see its header), and a value import would add a runtime
// edge to reach something that does not exist at runtime.
import type { ForgeGap } from "../../forge/types";
import { resolveBin } from "../which";
import { PrFacts } from "../../../types";

export const GLAB_TIMEOUT_MS = 10_000;

/** The `glab api` flag that sends a field value as an uninterpreted string.
 *
 * `-f` here is `--raw-field`: no JSON parsing, no type coercion, and — the part
 * that matters for a review body — no reading a leading `@` as a filename or `-`
 * as stdin. Those belong to `-F`/`--field`, which is why `-F` must never carry
 * one.
 *
 * Do NOT "fix" this to `-F`. The letter means the same thing on both CLIs — `-f`
 * is `--raw-field` on `gh` too, and `src/engine/review/provider.ts` relies on
 * exactly that, using `-f` for its string fields and `-F` only for a numeric
 * limit. So this is not a glab quirk to be reconciled with the sibling provider;
 * it is the same rule, and `-F` would read a body's leading `@` as a filename on
 * either CLI. */
export const GLAB_FIELD_FLAG = "-f";

const locateGlab: Locate = () => resolveBin("glab");

// The five routes this provider asks for. Module-private: nothing outside reads
// them, and the tests assert on the argv that actually reached the `Runner`, which
// is the honest thing to pin — an exported path helper only lets a test agree with
// itself about a string neither the CLI nor GitLab ever saw.
const mrListPath = (selector: string): string =>
  `projects/:fullpath/merge_requests?${selector}&state=all&per_page=10`;
/** One MR, in full. Not a nicety: the LIST rows this provider searches carry no
 * pipeline data at all, so `head_pipeline` — and with it every card's CI status —
 * exists only on this route. See `GlabMr.head_pipeline`. */
const mrShowPath = (iid: number): string =>
  `projects/:fullpath/merge_requests/${iid}`;
const jobsPath = (pipelineId: number): string =>
  `projects/:fullpath/pipelines/${pipelineId}/jobs?per_page=100`;
const approvalsPath = (iid: number): string =>
  `projects/:fullpath/merge_requests/${iid}/approvals`;
const discussionsPath = (iid: number): string =>
  `projects/:fullpath/merge_requests/${iid}/discussions?per_page=100`;

/** Is `glab` installed and logged in? Probed once per Deck session; a gap turns
 * forge reads off with a footer note rather than an error. `ForgeGap` is the
 * seam's own type, shared with `probeGh` — see its comment there. */
export async function probeGlab(run: Runner = execRunner, locate: Locate = locateGlab): Promise<ForgeGap | null> {
  const glab = locate() ?? "glab";
  try {
    await run(glab, ["auth", "status"], { cwd: process.cwd(), timeoutMs: GLAB_TIMEOUT_MS });
    return null;
  } catch (e) {
    // ENOENT is the only answer that means "not installed" — anything else came
    // from a glab that ran, so blaming the install would send the user hunting
    // for a binary they already have.
    const kind = (e as { code?: unknown }).code === "ENOENT" ? "missing" : "signed-out";
    return { kind, detail: `${glab} auth status: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export class GlabProvider implements PrProvider {
  constructor(
    private readonly run: Runner = execRunner,
    private readonly locate: Locate = locateGlab,
  ) {}

  async fetch(repoPath: string, branch: string | null, key: string): Promise<FetchResult> {
    try {
      let found: GlabMr | undefined;
      // The live branch is exact. The key search only covers an MR opened from a
      // branch Agent Flow didn't name.
      if (branch) found = pickMr(await this.list(repoPath, `source_branch=${encodeURIComponent(branch)}`));
      if (!found) found = pickMr(await this.list(repoPath, `search=${encodeURIComponent(key)}&in=title`));
      if (!found) return { ok: true, facts: null };

      // The list row is not the whole MR: GitLab's list endpoint carries no
      // pipeline data, so `head_pipeline` — the only route to a card's CI status —
      // arrives solely from this per-MR read. `as number` rather than a guard, and
      // provably not a lie: `pickMr` delegates to `pickByState`, which only ever
      // returns a row that passed `typeof iid === "number"`. A defensive re-check
      // here would be dead code.
      //
      // `?? found` is what keeps a failed read a DEGRADATION rather than a loss:
      // identity, state, title, draft flag and mergeability are all already correct
      // in the list row, so falling back to it costs the CI tally and nothing else.
      const mr = (await this.show(repoPath, found.iid as number)) ?? found;

      // Each sub-call degrades on its own: losing a detail must not discard the MR
      // we found, and nothing here may throw out of `fetch` — an uncaught throw
      // leaves the caller's cache entry unstamped, which re-arms this repo's fetch
      // on every tick, forever.
      const jobs = await this.jobs(repoPath, mr);
      return {
        ok: true,
        facts: toMrFacts(mr, {
          ci: mapJobs(jobs),
          ciAdvisory: mapJobsAdvisory(jobs),
          review: mapApprovals(await this.approvals(repoPath, found.iid as number)),
          unresolved: await this.unresolved(repoPath, mr),
        }),
      };
    } catch {
      return { ok: false };
    }
  }

  private api(repoPath: string, path: string): Promise<string> {
    return this.run(this.locate() ?? "glab", ["api", path], { cwd: repoPath, timeoutMs: GLAB_TIMEOUT_MS });
  }

  private async list(repoPath: string, selector: string): Promise<GlabMr[]> {
    const parsed = JSON.parse(await this.api(repoPath, mrListPath(selector))) as unknown;
    // GitLab answers an error with an object (`{"message":"404 Not Found"}`), which
    // must fail the fetch rather than read as an empty list.
    if (!Array.isArray(parsed)) throw new Error("glab merge_requests: expected an array");
    return parsed as GlabMr[];
  }

  /** One MR in full, or null when we cannot get one. The list row this follows up
   * on is missing exactly one thing the Deck needs — `head_pipeline`, which GitLab
   * sends on this route and on no other (see `GlabMr.head_pipeline`) — so this call
   * is what makes a GitLab card's CI status possible at all.
   *
   * Null on anything that is not recognisably an MR, error objects included
   * (`{"message":"404 Not Found"}` parses fine and would otherwise reach
   * `toMrFacts` as a record with no identity, turning a found MR into "no MR").
   * The caller reads null as "keep the list row", never as a failed fetch. */
  private async show(repoPath: string, iid: number): Promise<GlabMr | null> {
    try {
      const parsed = JSON.parse(await this.api(repoPath, mrShowPath(iid))) as GlabMr | null;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      // A NON-EMPTY `web_url`, not merely a string one: `toMrFacts` rejects on
      // `!mr.web_url`, so anything this lets through that it then rejects yields
      // `facts: null` — "there is genuinely no merge request" — which is the exact
      // outcome this guard exists to prevent. Stricter than that falsy test rather
      // than equal to it, since a non-string url would reach `PrFacts.url` otherwise.
      return typeof parsed.iid === "number" && typeof parsed.web_url === "string" && parsed.web_url !== ""
        ? parsed
        : null;
    } catch {
      return null;
    }
  }

  /** The head pipeline's jobs, or null when there is no pipeline or we cannot read
   * one. Null and an empty list both tally to zeros — the same answer GitHub's
   * path gives for a null rollup. */
  private async jobs(repoPath: string, mr: GlabMr): Promise<GlabJob[] | null> {
    const id = mr.head_pipeline?.id;
    if (typeof id !== "number") return null;
    try {
      const parsed = JSON.parse(await this.api(repoPath, jobsPath(id))) as unknown;
      return Array.isArray(parsed) ? (parsed as GlabJob[]) : null;
    } catch {
      return null;
    }
  }

  private async approvals(repoPath: string, iid: number): Promise<GlabApprovals | null> {
    try {
      return JSON.parse(await this.api(repoPath, approvalsPath(iid))) as GlabApprovals;
    } catch {
      return null;
    }
  }

  /** Unresolved discussion count, or null when we cannot get one. The MR's own
   * `blocking_discussions_resolved` answers the common case for free, which saves
   * a round trip on every card whose threads are all settled. */
  private async unresolved(repoPath: string, mr: GlabMr): Promise<PrFacts["unresolved"]> {
    if (mr.blocking_discussions_resolved === true) return 0;
    if (typeof mr.iid !== "number") return null;
    try {
      return countUnresolvedDiscussions(JSON.parse(await this.api(repoPath, discussionsPath(mr.iid))));
    } catch {
      return null;
    }
  }
}
