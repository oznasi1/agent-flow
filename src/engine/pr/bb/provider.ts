// PR facts for one repo's one branch, through `atlassian-cli`. The Bitbucket
// counterpart of `../provider.ts` and `../glab/provider.ts`, spawning through the
// same injected `Runner` so no test forks a process.
//
// Two modes, selected by an injected thunk rather than probed here: `passthrough`
// when the CLI has a raw `bb api`, `projected` when it does not. See
// `docs/FORGES.md` and the design spec for why the difference is this large.
import type { BranchCiStatus } from "../../orchestrator/branchCi";
// `import type`, matching `../../forge/types`'s own discipline: it is an
// interfaces-only module whose safety rests on every import of and from it being
// erased at build time (see its header).
import type { ForgeGap } from "../../forge/types";
import { execRunner, stripCommandLine } from "../provider";
import type { FetchResult, Locate, PrProvider, Runner } from "../provider";
import { resolveBin } from "../which";
import { MergeMethod, PrFacts } from "../../../types";
import { BbRepo, parseBitbucketRemote, pickBbPr } from "./pr";
import { BbProjectedPr, projectedBranchStatus, projectedCi, toProjectedFacts } from "./projected";
import {
  BbRestPr, countBbUnresolved, mapBbMergeable, mapBbStatuses, restBranchStatus, toRestFacts,
} from "./rest";

export const BB_TIMEOUT_MS = 10_000;

/** The binary. `bb` is a SUBCOMMAND ALIAS inside `atlassian-cli`, not a second
 * executable — `atlassian-cli bb pr list …` and `atlassian-cli bitbucket pr list …`
 * are the same command. Looking for a `bb` on PATH would find nothing on a
 * correct install, or worse, find `craftamap/bb`, an unrelated tool with an
 * incompatible command surface. */
export const BB_BIN = "atlassian-cli";

const locateBb: Locate = () => resolveBin(BB_BIN);

/** How many open PRs projected mode lists before matching client-side. `bb pr
 * list` has no source-branch filter and no title search, so the selectors run
 * over whatever this returns — a repo with more than this many open PRs can miss
 * one that passthrough mode would have found by direct query. Documented in
 * docs/FORGES.md rather than quietly raised: a bigger number is a slower call for
 * every repo, to fix a case a newer CLI removes entirely. */
const PROJECTED_LIST_LIMIT = 25;

/** Is `atlassian-cli` installed and signed in TO BITBUCKET? `auth test --bitbucket`
 * rather than `auth status`, which renders a table for every configured service
 * and exits zero with Bitbucket unconfigured, or `whoami`, which is Jira-shaped. */
export async function probeBb(run: Runner = execRunner, locate: Locate = locateBb): Promise<ForgeGap | null> {
  const bb = locate() ?? BB_BIN;
  try {
    await run(bb, ["auth", "test", "--bitbucket"], { cwd: process.cwd(), timeoutMs: BB_TIMEOUT_MS });
    return null;
  } catch (e) {
    // ENOENT is the only answer that means "not installed" — anything else came
    // from a CLI that ran, so blaming the install would send the user hunting for
    // a binary they already have.
    const kind = (e as { code?: unknown }).code === "ENOENT" ? "missing" : "signed-out";
    return { kind, detail: `${bb} auth test --bitbucket: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Does this build have a raw `bb api` passthrough?
 *
 * `--help` is handled by clap at parse time, before workspace resolution and
 * before any HTTP, so this costs no network call, needs no repo, and answers
 * correctly while signed out. A build without the subcommand exits non-zero with
 * "unrecognized subcommand", which is the whole signal. */
export async function probeBbApi(run: Runner = execRunner, locate: Locate = locateBb): Promise<boolean> {
  try {
    await run(locate() ?? BB_BIN, ["bb", "api", "--help"], { cwd: process.cwd(), timeoutMs: BB_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

function exec(run: Runner, locate: Locate, repoPath: string, args: string[]): Promise<string> {
  return run(locate() ?? BB_BIN, args, { cwd: repoPath, timeoutMs: BB_TIMEOUT_MS });
}

/** The repo's Bitbucket coordinates, from its git remote.
 *
 * Neither `gh` nor `glab` needs this — both infer the repo themselves — and
 * `atlassian-cli` infers `--workspace`, but `bb pr list <repo>` takes the slug as
 * a REQUIRED POSITIONAL and ignores git context entirely. Passthrough mode needs
 * both coordinates to build a REST path. So the forge resolves them itself and
 * passes both explicitly, which also means no call depends on the CLI's own
 * detection heuristics agreeing with ours. */
async function repoOf(run: Runner, locate: Locate, repoPath: string): Promise<BbRepo | null> {
  try {
    const url = await run("git", ["config", "--get", "remote.origin.url"], {
      cwd: repoPath,
      timeoutMs: BB_TIMEOUT_MS,
    });
    return parseBitbucketRemote(url);
  } catch {
    return null;
  }
}

const listArgs = (repo: BbRepo): string[] => [
  "--workspace", repo.workspace, "bb", "pr", "list", repo.slug,
  "--state", "OPEN", "--limit", String(PROJECTED_LIST_LIMIT), "--format", "json",
];

const pipelineArgs = (repo: BbRepo, branch: string): string[] => [
  "--workspace", repo.workspace, "--repo", repo.slug, "bb", "pipeline", "list",
  "--branch", branch, "--recent", "1", "--format", "json",
];

// `method`/`body` are optional and appended after `path`, so every existing call
// site — `apiArgs(path)`, read-only — produces the exact argv it always did.
// `-X`/`-d` are `bb api`'s own flags for an HTTP method and a JSON body (see
// `ApiArgs` in the CLI's `crates/cli/src/commands/api.rs`).
const apiArgs = (path: string, method?: string, body?: string): string[] => [
  "bb", "api", path,
  ...(method ? ["-X", method] : []),
  ...(body !== undefined ? ["-d", body] : []),
  "--format", "json",
];

// `q` is Bitbucket's own filter-expression syntax (`source.branch.name="…"`),
// so its OPERATORS — the `=`, the `"` quotes, the `&` separating this from
// `state=OPEN&pagelen=10` — must reach the server literally: encoding the whole
// expression would turn them into `%3D`/`%22`/`%26` and the server would read a
// filter it does not recognise as a syntax error, not as "no results".
//
// The INTERPOLATED VALUE is a different matter and must be encoded by the
// caller before it reaches here (see the two call sites in `fetchRest`) — a
// branch or task key is attacker- and user-controlled text, not part of the
// filter grammar. Unescaped, a branch containing `&` injects bogus query
// params and truncates `&state=OPEN&pagelen=10` off the end; one containing `#`
// starts a fragment that strips everything after it client-side, silently
// dropping the state/pagelen constraints; one containing `+` can be read as a
// literal space, turning a real PR into a false "no PR". `pipelinesPath`, two
// lines below, already encodes its own interpolated `branch` for exactly this
// reason — this is that same convention, not an exception to it.
const prSearchPath = (repo: BbRepo, q: string): string =>
  `/2.0/repositories/${repo.workspace}/${repo.slug}/pullrequests?q=${q}&state=OPEN&pagelen=10`;

const prSubPath = (repo: BbRepo, id: number, leaf: string): string =>
  `/2.0/repositories/${repo.workspace}/${repo.slug}/pullrequests/${id}${leaf}`;

const pipelinesPath = (repo: BbRepo, branch: string): string =>
  `/2.0/repositories/${repo.workspace}/${repo.slug}/pipelines?target.ref_name=${encodeURIComponent(branch)}` +
  `&sort=-created_on&pagelen=1`;

const prMergePath = (repo: BbRepo, id: number): string =>
  `/2.0/repositories/${repo.workspace}/${repo.slug}/pullrequests/${id}/merge`;

/** Agent Flow's three merge methods in Bitbucket's own vocabulary.
 *
 * `rebase` maps only on the passthrough path: Bitbucket's REST `merge_strategy`
 * enum carries `rebase_merge`, but `bb pr merge --strategy` documents only
 * `merge_commit`, `squash` and `fast_forward`. Its argument is an untyped
 * `Option<String>` so it might forward `rebase_merge` anyway — that is exactly
 * the kind of undocumented behaviour this project has already shipped a bug on,
 * so projected mode refuses rather than guesses (see `BbProvider.merge`). */
const BB_STRATEGY: Record<MergeMethod, string> = {
  squash: "squash",
  merge: "merge_commit",
  rebase: "rebase_merge",
};

async function jsonList(p: Promise<string>): Promise<unknown[]> {
  const parsed = JSON.parse(await p) as unknown;
  // Bitbucket and the CLI both answer an error with an OBJECT
  // (`{"message":"404 Not Found"}`), which must fail the fetch rather than read
  // as an empty list — "no pull request" and "we could not ask" are different.
  if (!Array.isArray(parsed)) throw new Error(`${BB_BIN}: expected an array`);
  return parsed;
}

/** Branch CI for the orchestrator's gate, in whichever mode is live.
 *
 * A free function rather than a `BbProvider` method: `forge/bitbucket.ts` calls
 * it directly, exactly as the other two forges spawn their branch-CI read
 * themselves. `"unknown"` for every unreadable fact — a failed call, a timeout, a
 * branch with no pipeline — and `"unknown"` is NOT green. */
export async function bbBranchCi(
  run: Runner,
  locate: Locate,
  apiMode: () => Promise<boolean>,
  repoPath: string,
  branch: string,
): Promise<BranchCiStatus> {
  try {
    const repo = await repoOf(run, locate, repoPath);
    if (!repo) return "unknown";
    if (await apiMode()) {
      const out = await exec(run, locate, repoPath, apiArgs(pipelinesPath(repo, branch)));
      return restBranchStatus(JSON.parse(out) as unknown);
    }
    const out = await exec(run, locate, repoPath, pipelineArgs(repo, branch));
    return projectedBranchStatus(JSON.parse(out) as unknown);
  } catch {
    return "unknown";
  }
}

export class BbProvider implements PrProvider {
  constructor(
    private readonly run: Runner = execRunner,
    private readonly locate: Locate = locateBb,
    private readonly apiMode: () => Promise<boolean> = () => probeBbApi(),
  ) {}

  async fetch(repoPath: string, branch: string | null, key: string): Promise<FetchResult> {
    try {
      const repo = await repoOf(this.run, this.locate, repoPath);
      // A remote we cannot read as Bitbucket is a FAILED fetch, not "no PR": the
      // alternative is synthesizing bitbucket.org urls for someone else's forge.
      if (!repo) return { ok: false };
      return (await this.apiMode())
        ? await this.fetchRest(repoPath, repo, branch, key)
        : await this.fetchProjected(repoPath, repo, branch, key);
    } catch {
      // Nothing may throw out of `fetch` — an uncaught throw leaves the caller's
      // cache entry unstamped, which re-arms this repo's fetch on every tick,
      // forever. The mappers are inside this try for the same reason.
      return { ok: false };
    }
  }

  /** Projected mode: one list call, both selectors applied client-side, then one
   * pipeline call for the card's CI. */
  private async fetchProjected(
    repoPath: string, repo: BbRepo, branch: string | null, key: string,
  ): Promise<FetchResult> {
    const rows = (await jsonList(exec(this.run, this.locate, repoPath, listArgs(repo)))) as BbProjectedPr[];
    const byBranch = branch
      ? rows.filter((r) => typeof r.source === "string" && r.source === branch)
      : [];
    // The live branch is exact. The key search only covers a PR opened from a
    // branch Agent Flow did not name.
    const byKey = rows.filter((r) => typeof r.title === "string" && r.title.includes(key));
    const found = pickBbPr(byBranch.length > 0 ? byBranch : byKey);
    if (!found) return { ok: true, facts: null };

    const source = typeof found.source === "string" ? found.source : branch;
    const ci = source ? projectedCi(await this.pipelineRows(repoPath, repo, source)) : { passing: 0, pending: 0, failing: [] };
    return { ok: true, facts: toProjectedFacts(found, repo, ci) };
  }

  /** The newest pipeline for a branch, or null when we cannot read one. A failure
   * costs the CI tally and nothing else — the PR we already found still renders. */
  private async pipelineRows(repoPath: string, repo: BbRepo, branch: string): Promise<unknown> {
    try {
      return JSON.parse(await exec(this.run, this.locate, repoPath, pipelineArgs(repo, branch))) as unknown;
    } catch {
      return null;
    }
  }

  /** Passthrough mode: server-side filtering, then three sub-calls that each
   * degrade on their own. */
  private async fetchRest(
    repoPath: string, repo: BbRepo, branch: string | null, key: string,
  ): Promise<FetchResult> {
    let found: BbRestPr | undefined;
    if (branch) {
      found = pickBbPr(
        await this.search(repoPath, prSearchPath(repo, `source.branch.name="${encodeURIComponent(branch)}"`)),
      );
    }
    if (!found) {
      found = pickBbPr(await this.search(repoPath, prSearchPath(repo, `title~"${encodeURIComponent(key)}"`)));
    }
    if (!found) return { ok: true, facts: null };
    const id = found.id as number; // `pickBbPr` only ever returns a row whose id is a number.

    return {
      ok: true,
      facts: toRestFacts(found, {
        ci: mapBbStatuses(await this.sub(repoPath, repo, id, "/statuses")),
        mergeable: mapBbMergeable(await this.sub(repoPath, repo, id, "/conflicts")),
        unresolved: countBbUnresolved(await this.sub(repoPath, repo, id, "/comments?pagelen=100")),
      }),
    };
  }

  private async search(repoPath: string, path: string): Promise<BbRestPr[]> {
    const parsed = JSON.parse(await exec(this.run, this.locate, repoPath, apiArgs(path))) as unknown;
    const values = (parsed as { values?: unknown } | null)?.values;
    if (!Array.isArray(values)) throw new Error(`${BB_BIN} api: expected a paginated body`);
    return values as BbRestPr[];
  }

  /** One sub-resource, or null when we cannot read it. Each mapper reads null as
   * its own absence — `"unknown"`, a zero tally, `null` — never as a failed fetch. */
  private async sub(repoPath: string, repo: BbRepo, id: number, leaf: string): Promise<unknown> {
    try {
      return JSON.parse(await exec(this.run, this.locate, repoPath, apiArgs(prSubPath(repo, id, leaf)))) as unknown;
    } catch {
      return null;
    }
  }

  /** Merge this repo's pull request. Along with the review write path, one of only
   * two places Agent Flow writes to a forge. The caller confirms with the user
   * first; this refuses only what Bitbucket would refuse anyway.
   *
   * `Object.hasOwn`, not `!BB_STRATEGY[method]`: `agentFlow.mergeMethod` reaches
   * here from settings.json and can be any string, including a prototype key like
   * `"constructor"` that a bare index would resolve to a truthy non-strategy. */
  async merge(
    repoPath: string,
    number: number,
    method: MergeMethod,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    if (!Object.hasOwn(BB_STRATEGY, method)) {
      return { ok: false, message: `Unknown merge method: ${String(method)}` };
    }
    const repo = await repoOf(this.run, this.locate, repoPath);
    if (!repo) return { ok: false, message: "This checkout has no Bitbucket Cloud remote." };
    const passthrough = await this.apiMode();
    // Refused, never substituted: a merge strategy we quietly swapped is the one
    // degradation the user cannot see after the fact — the commit is already made.
    if (method === "rebase" && !passthrough) {
      return {
        ok: false,
        message:
          "This build of atlassian-cli can only merge with squash or merge_commit — `bb pr merge` has no rebase " +
          "strategy. Set agentFlow.mergeMethod to squash or merge, upgrade to a build with `bb api`, or merge from Bitbucket.",
      };
    }
    try {
      await (passthrough
        ? exec(this.run, this.locate, repoPath, apiArgs(
            prMergePath(repo, number), "POST", JSON.stringify({ merge_strategy: BB_STRATEGY[method] }),
          ))
        : exec(this.run, this.locate, repoPath, [
            "--workspace", repo.workspace, "bb", "pr", "merge", repo.slug, String(number),
            "--strategy", BB_STRATEGY[method], "--format", "json",
          ]));
      return { ok: true };
    } catch (e) {
      const err = e as { killed?: boolean; code?: unknown; stderr?: string };
      // A killed-by-timeout rejection has the same shape as any other failure and
      // means something different: the CLI may well have reached Bitbucket before
      // the clock ran out. A merge is NOT idempotent, so "Bitbucket refused" would
      // be a lie about a write that could have landed — and would invite a retry
      // that merges twice.
      if (err.killed || err.code === "ETIMEDOUT") {
        return {
          ok: false,
          message: `Timed out after ${BB_TIMEOUT_MS / 1000}s — the merge may already have gone through. Open the pull request to check.`,
        };
      }
      // stderr is the CLI's own complaint; `.message` is the reconstructed argv.
      return { ok: false, message: err.stderr?.trim() || (e instanceof Error ? stripCommandLine(e.message) : String(e)) };
    }
  }
}
