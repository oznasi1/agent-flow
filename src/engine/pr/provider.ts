import { execFile } from "child_process";
import { PrFacts } from "../../types";
import { GhPr, parseRepoFromUrl, pickPr, toPrFacts } from "./facts";

/** Every field we need, in one call. Verified against gh 2.89.0 — `pr list --json`
 * exposes the same rollup and review fields as `pr view --json`. */
export const PR_JSON_FIELDS =
  "number,url,title,state,isDraft,headRefName,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup";

export const GH_TIMEOUT_MS = 10_000;

const THREADS_QUERY =
  "query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){" +
  "reviewThreads(first:100){nodes{isResolved isOutdated}}}}}";

/** `ok: false` means the attempt failed; `ok: true, facts: null` means there is
 * genuinely no PR. The caller needs the difference to decide whether to keep a
 * previous value and flag an error. */
export type FetchResult = { ok: true; facts: PrFacts | null } | { ok: false };

/** Spawning, injected — so tests never fork a process. Resolves stdout, rejects
 * on non-zero exit or timeout. */
export type Runner = (
  file: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<string>;

export const execRunner: Runner = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout.toString()),
    );
  });

export interface PrProvider {
  fetch(repoPath: string, branch: string | null, key: string): Promise<FetchResult>;
}

/** Is `gh` installed and logged in? Probed once per Deck session; a false answer
 * turns PR facts off with a footer note rather than an error. */
export async function ghAvailable(run: Runner = execRunner): Promise<boolean> {
  try {
    await run("gh", ["auth", "status"], { cwd: process.cwd(), timeoutMs: GH_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

export class GhProvider implements PrProvider {
  constructor(private readonly run: Runner = execRunner) {}

  async fetch(repoPath: string, branch: string | null, key: string): Promise<FetchResult> {
    try {
      let chosen: GhPr | undefined;
      // The live branch is exact, and correct for Address PR runs too — the agent
      // checked out the PR's own head. The key search only covers a PR opened from
      // a branch Agent Flow didn't name.
      if (branch) chosen = pickPr(await this.list(repoPath, ["--head", branch]));
      if (!chosen) chosen = pickPr(await this.list(repoPath, ["--search", `${key} in:title`]));
      if (!chosen) return { ok: true, facts: null };

      // toPrFacts (and the rollup mapper inside it) must stay inside this try:
      // a malformed statusCheckRollup entry from gh (e.g. a bare null) must
      // degrade to `{ ok: false }`, never throw out of fetch — an uncaught throw
      // here leaves the caller's cache entry unstamped, which re-arms this
      // repo's fetch on every tick, forever.
      const unresolved = chosen.reviewDecision ? await this.unresolved(repoPath, chosen) : null;
      return { ok: true, facts: toPrFacts(chosen, unresolved) };
    } catch {
      return { ok: false };
    }
  }

  private async list(repoPath: string, selector: string[]): Promise<GhPr[]> {
    const out = await this.run(
      "gh",
      ["pr", "list", ...selector, "--state", "all", "--limit", "10", "--json", PR_JSON_FIELDS],
      { cwd: repoPath, timeoutMs: GH_TIMEOUT_MS },
    );
    const parsed = JSON.parse(out) as unknown;
    if (!Array.isArray(parsed)) throw new Error("gh pr list: expected an array");
    return parsed as GhPr[];
  }

  /** Unresolved review-thread count, or null when we cannot get one. A failure
   * here never discards the PR facts we already have. */
  private async unresolved(repoPath: string, pr: GhPr): Promise<number | null> {
    const loc = pr.url ? parseRepoFromUrl(pr.url) : null;
    if (!loc || typeof pr.number !== "number") return null;
    try {
      const out = await this.run(
        "gh",
        ["api", "graphql", "-f", `query=${THREADS_QUERY}`, "-F", `o=${loc.owner}`, "-F", `r=${loc.repo}`, "-F", `n=${pr.number}`],
        { cwd: repoPath, timeoutMs: GH_TIMEOUT_MS },
      );
      const nodes = (JSON.parse(out) as {
        data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: { isResolved?: boolean; isOutdated?: boolean }[] } } } };
      }).data?.repository?.pullRequest?.reviewThreads?.nodes;
      if (!Array.isArray(nodes)) return null;
      return nodes.filter((n) => !n.isResolved && !n.isOutdated).length;
    } catch {
      return null;
    }
  }
}
