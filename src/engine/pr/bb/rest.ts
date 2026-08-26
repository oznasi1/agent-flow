// Passthrough mode: mapping Bitbucket Cloud's own REST payloads, reached through
// `bb api <path>`. Pure — no process, no filesystem.
//
// Shapes here come from Bitbucket's OpenAPI spec (`pullrequest`, `participant`,
// `pullrequest_comment`, `commitstatus`, `pipeline`), which is the real contract
// on this path — unlike `projected.ts`, whose shapes are the CLI's own structs.
// Keep the two straight: a field that exists here may well not exist there.
import type { BranchCiStatus } from "../../orchestrator/branchCi";
import { gradeBbPipeline, mapBbState } from "./pr";
import { PrCheck, PrFacts } from "../../../types";

interface BbRestParticipant {
  role?: unknown;
  approved?: unknown;
  state?: unknown;
}

/** One PR as the SINGLE-PR route sends it. Every field `unknown` or narrowly
 * shaped: nothing has validated it, and each reader below checks what it uses.
 *
 * `participants` and `draft` belong to this route alone. Bitbucket Cloud answers
 * `…/pullrequests?q=…` with its PARTIAL representation, which carries neither —
 * so `toRestFacts` must never be handed a list row, or every card reports
 * `review: "none"` and `isDraft: false` no matter the truth. `BbProvider.show`
 * is the read that makes those two fields real; see its comment. */
export interface BbRestPr {
  id?: unknown;
  title?: unknown;
  state?: unknown;
  draft?: unknown;
  links?: { html?: { href?: unknown } | null } | null;
  participants?: unknown;
}

function values(json: unknown): unknown[] | null {
  const v = (json as { values?: unknown } | null | undefined)?.values;
  return Array.isArray(v) ? v : null;
}

/** The PR's review state, in the Deck's vocabulary.
 *
 * A fact about the PULL REQUEST, not about the viewer — the same thing GitHub's
 * `reviewDecision` reports. That is why nothing here needs to know who we are,
 * and why no `/2.0/user` call is required on this path.
 *
 * Changes-requested outranks an approval: one reviewer blocking is the state of
 * the pull request even when another has approved. Only `REVIEWER` participants
 * count — a commenter is a participant too, and counting one as an outstanding
 * reviewer would leave every commented-on PR reading `review_required` forever. */
export function mapBbReview(participants: unknown): PrFacts["review"] {
  if (!Array.isArray(participants)) return "none";
  let reviewers = 0;
  let approved = false;
  for (const raw of participants) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as BbRestParticipant;
    if (typeof p.role !== "string" || p.role.toUpperCase() !== "REVIEWER") continue;
    reviewers++;
    const state = typeof p.state === "string" ? p.state.toLowerCase() : "";
    if (state === "changes_requested") return "changes_requested";
    if (state === "approved" || p.approved === true) approved = true;
  }
  if (reviewers === 0) return "none";
  return approved ? "approved" : "review_required";
}

const BB_STATUS_FAIL = new Set(["FAILED", "STOPPED", "ERROR"]);

/** Build statuses on a PR as a CI tally. Unlike projected mode, this is a real
 * per-check breakdown, so a failing card names the checks that failed.
 *
 * An unrecognised state is skipped rather than counted as failing: inventing a
 * red check from a state we do not know would send the user to a PR that is fine. */
export function mapBbStatuses(json: unknown): PrFacts["ci"] {
  const failing: PrCheck[] = [];
  let passing = 0;
  let pending = 0;
  for (const raw of values(json) ?? []) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as { state?: unknown; name?: unknown; key?: unknown; url?: unknown };
    const s = typeof c.state === "string" ? c.state.toUpperCase() : "";
    if (s === "SUCCESSFUL") {
      passing++;
    } else if (s === "INPROGRESS") {
      pending++;
    } else if (BB_STATUS_FAIL.has(s)) {
      const name =
        (typeof c.name === "string" && c.name) || (typeof c.key === "string" && c.key) || "check";
      failing.push({ name, url: typeof c.url === "string" ? c.url : "" });
    }
  }
  return { passing, pending, failing };
}

/** The conflicts route as a mergeability verdict. An empty list is a real
 * "clean"; anything that is not a list at all — an error object, a truncated
 * body — is `"unknown"`, which is not clean. */
export function mapBbMergeable(json: unknown): PrFacts["mergeable"] {
  const v = values(json);
  if (v === null) return "unknown";
  return v.length > 0 ? "conflicting" : "clean";
}

/** Unresolved review threads, or null when we could not get a list.
 *
 * Counts thread ROOTS only, and only inline ones, which is what makes this
 * comparable to GitHub's `reviewThreads`: a reply inherits its thread's
 * resolution, so counting replies would count one conversation several times,
 * and a plain PR comment is not a review thread at all. */
export function countBbUnresolved(json: unknown): number | null {
  const v = values(json);
  if (v === null) return null;
  let n = 0;
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as { parent?: unknown; deleted?: unknown; inline?: unknown; resolution?: unknown };
    if (c.deleted === true) continue;
    if (c.parent) continue;
    if (!c.inline) continue;
    if (c.resolution == null) n++;
  }
  return n;
}

/** The newest pipeline for a ref, graded.
 *
 * The flattening — `state.result.name`, falling back to `state.name` — is the
 * same one the CLI performs before emitting its projected `state` string, which
 * is what lets both modes share `gradeBbPipeline`. */
export function restBranchStatus(json: unknown): BranchCiStatus {
  const first = values(json)?.[0];
  if (!first || typeof first !== "object") return "unknown";
  const state = (first as { state?: { name?: unknown; result?: { name?: unknown } | null } | null }).state;
  const result = state?.result?.name;
  if (typeof result === "string") return gradeBbPipeline(result);
  return gradeBbPipeline(typeof state?.name === "string" ? state.name : null);
}

/** One REST PR → `PrFacts`, or null when it carries no identity we could render
 * or link. Stricter than a falsy test on the url: a non-string href would
 * otherwise reach `PrFacts.url`. */
export function toRestFacts(
  pr: BbRestPr,
  extra: { ci: PrFacts["ci"]; mergeable: PrFacts["mergeable"]; unresolved: number | null },
): PrFacts | null {
  if (typeof pr.id !== "number") return null;
  const href = pr.links?.html?.href;
  if (typeof href !== "string" || !href) return null;
  return {
    number: pr.id,
    url: href,
    title: typeof pr.title === "string" ? pr.title : "",
    state: mapBbState(pr.state),
    isDraft: pr.draft === true,
    ci: extra.ci,
    review: mapBbReview(pr.participants),
    unresolved: extra.unresolved,
    mergeable: extra.mergeable,
    // Bitbucket draws no required/optional line across build statuses, so there
    // is no "everything required passed, something optional did not" to report.
    ciAdvisory: false,
  };
}
