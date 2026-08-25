// The pure half of the Bitbucket forge: everything both modes share. No process,
// no filesystem — `provider.ts` beside this file does the spawning.
//
// `import type` on BranchCiStatus, deliberately: `orchestrator/branchCi.ts` is on
// the webview import graph, and a value import from it here would be a runtime
// edge from a forge module into a module the Deck bundle also compiles.
import type { BranchCiStatus } from "../../orchestrator/branchCi";
import { pickByState } from "../facts";
import { PrFacts } from "../../../types";

/** A Bitbucket Cloud repo's two coordinates. Agent Flow's name for a CHECKOUT is
 * never the repo's name — this product's own worktrees are directories like
 * `bite-me-3a` — so these always come from the git remote, never from a path. */
export interface BbRepo {
  workspace: string;
  slug: string;
}

const BB_HOST = "bitbucket.org";

/** Workspace and slug from a git remote url, or null when this is not a
 * Bitbucket Cloud remote.
 *
 * The host check is load-bearing rather than defensive: `bbPrUrl` synthesizes a
 * bitbucket.org url from whatever this returns, so a GitHub remote sailing
 * through here would put a bitbucket.org link on a GitHub pull request's card.
 *
 * Bitbucket workspaces do not nest the way GitLab groups do, so the first two
 * path segments are the whole answer — no `projectFromMrUrl`-style walk needed. */
export function parseBitbucketRemote(url: string): BbRepo | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  let host = "";
  let path = "";
  // scp-style (`git@bitbucket.org:ws/slug.git`) is not a URL: `new URL` reads the
  // whole thing as a `git:` scheme with an empty host, so it must be matched first.
  const scp = /^[^@\s/]+@([^:\s]+):(.+)$/.exec(trimmed);
  if (scp) {
    host = scp[1];
    path = scp[2];
  } else {
    try {
      const u = new URL(trimmed);
      host = u.hostname;
      path = u.pathname;
    } catch {
      return null;
    }
  }
  if (host.toLowerCase() !== BB_HOST) return null;
  const parts = path.replace(/\.git$/i, "").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return { workspace: parts[0], slug: parts[1] };
}

/** The Cloud url for one pull request.
 *
 * In passthrough mode this is unused — `links.html.href` is on the PR object. In
 * projected mode it is the only url there is, because `bb pr list`/`pr get` emit
 * none and `PrFacts.url` is required. It matches the CLI's own convention: its
 * `get_pr_diff` builds this exact string. The day `pr get` starts emitting a
 * url, prefer it and delete this. */
export function bbPrUrl(repo: BbRepo, id: number): string {
  return `https://${BB_HOST}/${repo.workspace}/${repo.slug}/pull-requests/${id}`;
}

/** Bitbucket's four PR states onto the Deck's three. `DECLINED` and `SUPERSEDED`
 * both mean "abandoned", which is what CLOSED means here, and so does anything
 * unrecognised — a state we cannot read must not rank as OPEN in `pickBbPr`. */
export function mapBbState(state: unknown): PrFacts["state"] {
  const s = typeof state === "string" ? state.toUpperCase() : "";
  if (s === "OPEN") return "OPEN";
  if (s === "MERGED") return "MERGED";
  return "CLOSED";
}

const BB_FAILED = new Set(["FAILED", "ERROR", "STOPPED", "EXPIRED"]);
const BB_PENDING = new Set(["PENDING", "IN_PROGRESS", "BUILDING", "PAUSED", "HALTED"]);

/** One pipeline status string in the Deck's vocabulary.
 *
 * Shared by both modes, and that is not a coincidence worth refactoring apart
 * later: the CLI's projected `state` field is `state.result.name` falling back to
 * `state.name`, which is exactly the flattening `restBranchStatus` does itself.
 * One grader, two extractors.
 *
 * `COMPLETED` grades as `unknown`, not `passed`: it is a `state.name` that
 * arrives when `state.result` is absent, so it says the pipeline finished and
 * says nothing about whether it succeeded. `"unknown"` is NOT green, and this is
 * the one place that rule could be quietly broken. */
export function gradeBbPipeline(status: string | null | undefined): BranchCiStatus {
  if (!status) return "unknown";
  const s = status.toUpperCase();
  if (s === "SUCCESSFUL") return "passed";
  if (BB_FAILED.has(s)) return "failed";
  if (BB_PENDING.has(s)) return "pending";
  return "unknown";
}

/** One branch can carry several PRs across its history. Same precedence policy as
 * the other two forges, shared through `pickByState`: prefer the live one, then
 * the one that landed, then the abandoned one; newest id wins within a state. */
export function pickBbPr<T extends { id?: unknown; state?: unknown }>(prs: T[]): T | undefined {
  return pickByState(prs, (p) => ({
    number: typeof p.id === "number" ? p.id : undefined,
    state: mapBbState(p.state),
  }));
}
