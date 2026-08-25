// Projected mode: mapping `atlassian-cli`'s own row structs, for a CLI with no
// `bb api` passthrough. Pure — no process, no filesystem.
//
// Every shape here is what the CLI SERIALIZES, not what Bitbucket sends. The CLI
// deserializes each API response into a narrow hand-written struct and emits
// that, so these types are deliberately much thinner than Bitbucket's own. Read
// `crates/cli/src/commands/bitbucket/` before adding a field: one that the CLI
// does not project can never arrive, however plainly the API docs list it.
import type { BranchCiStatus } from "../../orchestrator/branchCi";
import { BbRepo, bbPrUrl, gradeBbPipeline, mapBbState } from "./pr";
import { PrCheck, PrFacts } from "../../../types";

/** One `bb pr list --format json` row. Every field the command emits, and no
 * others; all `unknown`, because nothing has validated them yet. */
export interface BbProjectedPr {
  id?: unknown;
  title?: unknown;
  state?: unknown;
  author?: unknown;
  source?: unknown;
  destination?: unknown;
}

/** One `bb pipeline list --format json` row. `state` is already flattened by the
 * CLI to `state.result.name` falling back to `state.name`, which is why
 * `gradeBbPipeline` can be shared with the REST path. */
interface BbProjectedPipeline {
  build_number?: unknown;
  state?: unknown;
  ref_name?: unknown;
}

function newestPipeline(rows: unknown): BbProjectedPipeline | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const first: unknown = rows[0];
  return first && typeof first === "object" ? (first as BbProjectedPipeline) : null;
}

/** The newest pipeline's verdict as a CI tally.
 *
 * One check, never a breakdown: projected mode has no per-check data at all, so
 * this is a single synthetic entry standing for the whole pipeline. An
 * unrecognised state tallies to zeros rather than to a failure — inventing a red
 * check from a state we do not know would send the user to a PR that is fine. */
export function projectedCi(rows: unknown): PrFacts["ci"] {
  const none: PrFacts["ci"] = { passing: 0, pending: 0, failing: [] };
  const p = newestPipeline(rows);
  if (!p) return none;
  const verdict = gradeBbPipeline(typeof p.state === "string" ? p.state : null);
  if (verdict === "passed") return { passing: 1, pending: 0, failing: [] };
  if (verdict === "pending") return { passing: 0, pending: 1, failing: [] };
  if (verdict === "failed") {
    const name = typeof p.build_number === "number" ? `Pipeline #${p.build_number}` : "Pipeline";
    const failing: PrCheck[] = [{ name, url: "" }];
    return { passing: 0, pending: 0, failing };
  }
  return none;
}

/** The newest pipeline's verdict for the orchestrator's branch-CI gate. */
export function projectedBranchStatus(rows: unknown): BranchCiStatus {
  const p = newestPipeline(rows);
  return gradeBbPipeline(p && typeof p.state === "string" ? p.state : null);
}

/** One projected row → `PrFacts`, or null when it carries no id to build a url
 * from.
 *
 * Everything this cannot fill is an ABSENCE rather than a value, and each one is
 * pinned by its own assertion in the tests: `isDraft: false` because the CLI
 * emits no draft flag — not because we checked and it is not a draft; `mergeable:
 * "unknown"` because it emits no conflict state; `review: "none"` because
 * `approvals` is a count with no identity attached; `unresolved: null` because
 * `comment_count` is a total with no resolution state.
 *
 * `ciAdvisory` is false in both modes: Bitbucket draws no required/optional line
 * across build statuses, so there is no "everything required passed, something
 * optional did not" for it to mean. */
export function toProjectedFacts(pr: BbProjectedPr, repo: BbRepo, ci: PrFacts["ci"]): PrFacts | null {
  if (typeof pr.id !== "number") return null;
  return {
    number: pr.id,
    url: bbPrUrl(repo, pr.id),
    title: typeof pr.title === "string" ? pr.title : "",
    state: mapBbState(pr.state),
    isDraft: false,
    ci,
    review: "none",
    unresolved: null,
    mergeable: "unknown",
    ciAdvisory: false,
  };
}
