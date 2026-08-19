import { execFile } from "child_process";
import { PrFacts } from "../../types";
import { countUnresolved, GhPr, parseRepoFromUrl, pickPr, toPrFacts } from "./facts";
import { resolveBin } from "./which";
// `import type`, and it must stay that way: `../forge/types` type-imports
// `PrProvider` from THIS file, so a value import either way round would make a
// runtime cycle out of what is currently two erased edges.
import type { ForgeGap } from "../forge/types";

/** Every field we need, in one call. Verified against gh 2.89.0 — `pr list --json`
 * exposes the same rollup and review fields as `pr view --json`. */
export const PR_JSON_FIELDS =
  "number,url,title,state,isDraft,headRefName,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup";

export const GH_TIMEOUT_MS = 10_000;

export const THREADS_QUERY =
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
    execFile(file, args, { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        // execFile's own error carries only code/killed/signal/cmd, and its
        // message is `Command failed: <file> <full argv joined>` — which for
        // `gh pr review` embeds the reviewer's entire --body text verbatim.
        // Attach stderr (gh's own complaint, never a reconstructed argv) so
        // callers — review/provider.ts's submit() in particular — can prefer
        // it over that message instead of the leak that shipped without this.
        (err as NodeJS.ErrnoException & { stderr?: string }).stderr = stderr?.toString();
        reject(err);
        return;
      }
      resolve(stdout.toString());
    });
  });

export interface PrProvider {
  fetch(repoPath: string, branch: string | null, key: string): Promise<FetchResult>;
}

/** Where `gh` is, injected — the fallback to the bare name keeps a platform
 * whose install dirs `which` does not list working exactly as before. */
export type Locate = () => string | null;
const locateGh: Locate = () => resolveBin("gh");

/** Is `gh` installed and logged in? Probed once per Deck session; a gap turns PR
 * facts off with a footer note rather than an error. `ForgeGap` — the seam's own
 * type, not a per-CLI copy of the same two kinds: every probe answers the same
 * question, and three structurally identical types were three places for the
 * `kind` union to drift. */
export async function probeGh(run: Runner = execRunner, locate: Locate = locateGh): Promise<ForgeGap | null> {
  const gh = locate() ?? "gh";
  try {
    await run(gh, ["auth", "status"], { cwd: process.cwd(), timeoutMs: GH_TIMEOUT_MS });
    return null;
  } catch (e) {
    // ENOENT is the only answer that means "not installed" — anything else came
    // from a gh that ran, so blaming the install would send the user hunting for
    // a binary they already have.
    const kind = (e as { code?: unknown }).code === "ENOENT" ? "missing" : "signed-out";
    return { kind, detail: `${gh} auth status: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export class GhProvider implements PrProvider {
  constructor(
    private readonly run: Runner = execRunner,
    private readonly locate: Locate = locateGh,
  ) {}

  async fetch(repoPath: string, branch: string | null, key: string): Promise<FetchResult> {
    try {
      let chosen: GhPr | undefined;
      // The live branch is exact, and correct for Address PR runs too — the agent
      // checked out the PR's own head. The key search only covers a PR opened from
      // a branch Agent Flow Deck didn't name.
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
      this.locate() ?? "gh",
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
        this.locate() ?? "gh",
        ["api", "graphql", "-f", `query=${THREADS_QUERY}`, "-F", `o=${loc.owner}`, "-F", `r=${loc.repo}`, "-F", `n=${pr.number}`],
        { cwd: repoPath, timeoutMs: GH_TIMEOUT_MS },
      );
      return countUnresolved(JSON.parse(out));
    } catch {
      return null;
    }
  }
}
