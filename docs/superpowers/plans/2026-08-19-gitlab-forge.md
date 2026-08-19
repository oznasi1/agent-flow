# GitLab Forge Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a GitLab user get the same Agent Flow Deck a GitHub user gets — MR facts on cards, a review-requests strip, review submission, the orchestrator's branch-CI gate, and Doctor — selected by one global setting that defaults to GitHub so no existing install changes behavior.

**Architecture:** A `Forge` interface in `src/engine/forge/` selected by a registry that mirrors `src/tasks/registry.ts`. GitHub's existing `GhProvider` / `GhReviewProvider` are wrapped unchanged; GitLab gets sibling `GlabProvider` / `GlabReviewProvider` that talk to `glab api <rest-path>` through the same injected `Runner`. `PrProvider` and `ReviewProvider` do not change. All GitLab wire-shape knowledge lives in pure mapper modules that produce the existing host-neutral `PrFacts` / `ReviewRequest` types.

**Tech Stack:** TypeScript, VS Code extension API, React webviews bundled by esbuild, Vitest. `glab` CLI (GitLab's official CLI) spawned via `child_process.execFile` through the existing `Runner` seam.

**Spec:** [`docs/superpowers/specs/2026-08-19-gitlab-forge-design.md`](../specs/2026-08-19-gitlab-forge-design.md)

## Global Constraints

- **Default `agentFlow.forge` is `"github"`.** Every existing install must be byte-identically unaffected until a user opts in.
- **`npm run typecheck` must be clean** after every task.
- **`npm test` must pass after every task.** Existing test files pass **unmodified** except for the three additive/rename edits explicitly sanctioned in Tasks 7 and 8. Any other edit to an existing test is a defect in your change, not in the test.
- **`npm run test:cov` thresholds are enforced.** New modules need real coverage.
- **`npm run build` must succeed.** This is the **only** gate that catches a webview module reaching `child_process`. `tsc` and the full suite pass regardless of a violation.
- **`src/engine/forge/*`, `src/engine/pr/glab/*`, and `src/engine/review/glab/*` import `child_process`.** They must never be imported — even transitively — by `src/webview/*`, `src/engine/orchestrator/conditions.ts`, `src/engine/orchestrator/branchCi.ts`, or `src/engine/orchestrator/armability.ts`.
- **Never rename** an existing setting key, `PrFacts`/`ReviewRequest`/`BranchCiStatus` field, or orchestrator condition kind. Condition kinds are persisted in users' flow files.
- **A review body must never appear in an error message.** Prefer a rejection's `stderr` over its `.message`; `.message` is `Command failed: <file> <argv joined>` and embeds the body.
- **`unknown` is never green.** `branch-ci-passed` is satisfied by `"passed"` alone.
- Commit after every task. Conventional-commit prefixes (`feat:`, `test:`, `refactor:`, `docs:`).

---

## File Structure

**Create:**

| File | Responsibility |
|---|---|
| `src/engine/pr/glab/mr.ts` | GitLab MR/job/approval/discussion wire shapes + pure mappers → `PrFacts`. No IO. |
| `src/engine/pr/glab/provider.ts` | `GlabProvider implements PrProvider`, `probeGlab`, `GLAB_TIMEOUT_MS`, `GLAB_FIELD_FLAG`. |
| `src/engine/review/glab/search.ts` | Pure parser: GitLab MR list JSON → `ReviewRequest[]`. No IO. |
| `src/engine/review/glab/provider.ts` | `GlabReviewProvider implements ReviewProvider` (search/detail/submit). |
| `src/engine/forge/types.ts` | `Forge`, `ForgeGap`, `ForgeCaps`. Interfaces only, no runtime code. |
| `src/engine/forge/github.ts` | `makeGithubForge()` — wraps the existing `Gh*` providers, `probeGh`, gh branch-CI spawn. |
| `src/engine/forge/gitlab.ts` | `makeGitlabForge()` — wraps the `Glab*` providers, `probeGlab`, glab branch-CI spawn. |
| `src/engine/forge/registry.ts` | `FORGES`, `FORGE_IDS`, `resolveForge()`. |
| `docs/FORGES.md` | The honest per-forge capability doc. |

**Modify:** `src/types.ts` (`ReviewDetail.size`), `src/config.ts` (`forge` + GitLab prompt selection), `package.json` (`agentFlow.forge` + GitLab prompt defaults), `src/engine/pr/facts.ts` (extract `pickByState`), `src/engine/orchestrator/branchCi.ts` (GitLab mapper arm + glab argv), `src/engine/orchestrator/armability.ts` (forge-capability arm), `src/engine/doctor.ts` (`forgeChecks`), `src/doctorView.ts` (wiring), `src/deckView.ts` (single `forge` field), `src/telemetry/settingsSnapshot.ts` + `src/telemetry/events.ts` (`forge` prop), `test/webview/webviewGraph.test.ts` (boundary guard).

---

## Task 1: GitLab MR mappers

Pure functions turning GitLab's wire shapes into the existing `PrFacts`. No process, no filesystem, no clock — the same austerity `src/engine/pr/facts.ts` has, and for the same reason: this is where the two hosts' differences honestly live.

**Files:**
- Create: `src/engine/pr/glab/mr.ts`
- Modify: `src/engine/pr/facts.ts` (extract `pickByState`, reimplement `pickPr` on it)
- Test: `test/unit/engine/pr/glab/mr.test.ts`

**Interfaces:**
- Consumes: `PrFacts`, `PrCheck` from `src/types.ts`.
- Produces:
  - `interface GlabMr`, `GlabJob`, `GlabApprovals`, `GlabDiscussion` (all fields optional)
  - `mapMrState(state?: string): "OPEN" | "MERGED" | "CLOSED"`
  - `mapJobs(jobs: GlabJob[] | null | undefined): PrFacts["ci"]`
  - `mapJobsAdvisory(jobs: GlabJob[] | null | undefined): boolean`
  - `mapMrMergeable(hasConflicts?: boolean, detailed?: string): PrFacts["mergeable"]`
  - `mapApprovals(a: GlabApprovals | null | undefined): PrFacts["review"]`
  - `countUnresolvedDiscussions(json: unknown): number | null`
  - `projectFromMrUrl(url: string): string | null`
  - `toMrFacts(mr: GlabMr, extra: { ci: PrFacts["ci"]; ciAdvisory: boolean; review: PrFacts["review"]; unresolved: number | null }): PrFacts | null`
  - `pickMr(mrs: GlabMr[]): GlabMr | undefined`
  - From `facts.ts`: `pickByState<T>(items: T[], read: (t: T) => { number?: number; state?: string }): T | undefined`

- [ ] **Step 1: Write the failing test file**

Create `test/unit/engine/pr/glab/mr.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  mapMrState, mapJobs, mapJobsAdvisory, mapMrMergeable, mapApprovals,
  countUnresolvedDiscussions, projectFromMrUrl, toMrFacts, pickMr,
} from "../../../../../src/engine/pr/glab/mr";
import type { GlabJob, GlabMr } from "../../../../../src/engine/pr/glab/mr";

const job = (over: Partial<GlabJob> = {}): GlabJob => ({
  name: "build", status: "success", web_url: "https://gl/j/1", allow_failure: false, ...over,
});

const mr = (over: Partial<GlabMr> = {}): GlabMr => ({
  iid: 12, web_url: "https://gitlab.com/group/sub/proj/-/merge_requests/12",
  title: "Fix export", state: "opened", draft: false, source_branch: "feat/ASM-1",
  has_conflicts: false, detailed_merge_status: "mergeable",
  blocking_discussions_resolved: true, ...over,
});

const noExtra = { ci: { passing: 0, pending: 0, failing: [] }, ciAdvisory: false, review: "none" as const, unresolved: null };

describe("mapMrState", () => {
  it("maps merged and closed to their own states", () => {
    expect(mapMrState("merged")).toBe("MERGED");
    expect(mapMrState("closed")).toBe("CLOSED");
  });

  // `locked` is an OPEN merge request with discussion locked, not a closed one.
  it.each(["opened", "locked", "something_new", undefined])("treats %s as OPEN", (state) => {
    expect(mapMrState(state)).toBe("OPEN");
  });
});

describe("mapJobs", () => {
  it("counts an empty or missing job list as all zeros", () => {
    expect(mapJobs([])).toEqual({ passing: 0, pending: 0, failing: [] });
    expect(mapJobs(null)).toEqual({ passing: 0, pending: 0, failing: [] });
    expect(mapJobs(undefined)).toEqual({ passing: 0, pending: 0, failing: [] });
  });

  it("counts a successful job as passing", () => {
    expect(mapJobs([job()])).toEqual({ passing: 1, pending: 0, failing: [] });
  });

  it("reports a failed job with its name and url", () => {
    expect(mapJobs([job({ status: "failed", name: "lint", web_url: "https://gl/j/lint" })]).failing)
      .toEqual([{ name: "lint", url: "https://gl/j/lint" }]);
  });

  it.each(["created", "preparing", "pending", "running", "waiting_for_resource", "scheduled"])(
    "counts status %s as pending", (status) => {
      expect(mapJobs([job({ status })])).toEqual({ passing: 0, pending: 1, failing: [] });
    });

  // Same posture as mapRollup's CANCELLED/NEUTRAL/SKIPPED/STALE: a cancelled job
  // is usually a superseded one, and calling it a failure would drag cards into
  // Needs you on every force-push.
  it.each(["canceled", "skipped", "manual", "unheard_of"])("ignores status %s entirely", (status) => {
    expect(mapJobs([job({ status })])).toEqual({ passing: 0, pending: 0, failing: [] });
  });

  it("falls back to a placeholder name and an empty url", () => {
    expect(mapJobs([job({ status: "failed", name: undefined, web_url: undefined })]).failing)
      .toEqual([{ name: "job", url: "" }]);
  });
});

describe("mapJobsAdvisory", () => {
  it("is false when nothing is failing", () => {
    expect(mapJobsAdvisory([job()])).toBe(false);
    expect(mapJobsAdvisory([])).toBe(false);
    expect(mapJobsAdvisory(null)).toBe(false);
  });

  it("is true when every failing job is allowed to fail", () => {
    expect(mapJobsAdvisory([job(), job({ status: "failed", allow_failure: true })])).toBe(true);
  });

  it("is false when any failing job is required", () => {
    expect(mapJobsAdvisory([
      job({ status: "failed", allow_failure: true }),
      job({ status: "failed", allow_failure: false }),
    ])).toBe(false);
  });
});

describe("mapMrMergeable", () => {
  it("reads an explicit conflict first, whatever the detailed status says", () => {
    expect(mapMrMergeable(true, "mergeable")).toBe("conflicting");
  });

  it("maps mergeable to clean and need_rebase to behind", () => {
    expect(mapMrMergeable(false, "mergeable")).toBe("clean");
    expect(mapMrMergeable(false, "need_rebase")).toBe("behind");
  });

  it.each(["not_approved", "discussions_not_resolved", "blocked_status"])("maps %s to blocked", (d) => {
    expect(mapMrMergeable(false, d)).toBe("blocked");
  });

  it.each(["ci_still_running", "draft_status", "checking", undefined])("maps %s to unknown", (d) => {
    expect(mapMrMergeable(false, d)).toBe("unknown");
  });
});

describe("mapApprovals", () => {
  it("reads an approved MR as approved", () => {
    expect(mapApprovals({ approved: true, approvals_required: 2 })).toBe("approved");
  });

  it("reads an unapproved MR that requires approval as review_required", () => {
    expect(mapApprovals({ approved: false, approvals_required: 1 })).toBe("review_required");
  });

  it("reads an unapproved MR that requires nothing as none", () => {
    expect(mapApprovals({ approved: false, approvals_required: 0 })).toBe("none");
  });

  // GitLab cannot report changes_requested here; never invent it.
  it.each([null, undefined, {}])("reads %s as none rather than guessing", (a) => {
    expect(mapApprovals(a as never)).toBe("none");
  });
});

describe("countUnresolvedDiscussions", () => {
  const disc = (notes: { resolvable?: boolean; resolved?: boolean }[]) => ({ notes });

  it("counts a discussion with any unresolved resolvable note", () => {
    expect(countUnresolvedDiscussions([
      disc([{ resolvable: true, resolved: false }]),
      disc([{ resolvable: true, resolved: true }]),
      disc([{ resolvable: false, resolved: false }]),
    ])).toBe(1);
  });

  it("counts an empty list as zero open threads", () => {
    expect(countUnresolvedDiscussions([])).toBe(0);
  });

  // A wrong count reads as fact; null does not.
  it.each([null, undefined, {}, "nope", [null], [1]])("returns null for the unrecognised shape %s", (json) => {
    expect(countUnresolvedDiscussions(json)).toBeNull();
  });
});

describe("projectFromMrUrl", () => {
  it("returns the full nested group path, which may be more than two segments", () => {
    expect(projectFromMrUrl("https://gitlab.com/group/sub/proj/-/merge_requests/12"))
      .toBe("group/sub/proj");
  });

  it("handles a single-group project", () => {
    expect(projectFromMrUrl("https://gitlab.com/acme/api/-/merge_requests/3")).toBe("acme/api");
  });

  it("handles a self-managed host with a path prefix", () => {
    expect(projectFromMrUrl("https://git.acme.internal/team/api/-/merge_requests/9")).toBe("team/api");
  });

  it.each([
    "https://gitlab.com/group/proj/merge_requests/12", // no /-/ separator
    "https://gitlab.com/-/merge_requests/12",          // nothing before the separator
    "not a url",
    "",
  ])("returns null for %s", (url) => {
    expect(projectFromMrUrl(url)).toBeNull();
  });
});

describe("toMrFacts", () => {
  // iid, never id: iid is what the web URL and every project-scoped call use, so a
  // swap here yields a plausible-looking link to the WRONG merge request.
  it("uses iid as the number, ignoring a global id entirely", () => {
    const facts = toMrFacts({ ...mr({ iid: 12 }), id: 98765 } as GlabMr & { id: number }, noExtra);
    expect(facts?.number).toBe(12);
  });

  it("carries the mapped state, draft flag, title and url", () => {
    expect(toMrFacts(mr({ state: "merged", draft: true, title: "T" }), noExtra)).toMatchObject({
      state: "MERGED", isDraft: true, title: "T",
      url: "https://gitlab.com/group/sub/proj/-/merge_requests/12",
    });
  });

  it("passes the caller's observed ci, advisory, review and unresolved through untouched", () => {
    const ci = { passing: 2, pending: 1, failing: [{ name: "lint", url: "u" }] };
    expect(toMrFacts(mr(), { ci, ciAdvisory: true, review: "approved", unresolved: 3 }))
      .toMatchObject({ ci, ciAdvisory: true, review: "approved", unresolved: 3 });
  });

  it("defaults a missing title to an empty string and a missing draft to false", () => {
    expect(toMrFacts(mr({ title: undefined, draft: undefined }), noExtra))
      .toMatchObject({ title: "", isDraft: false });
  });

  // Null is "no MR", which the caller renders as no PR — never as an error.
  it.each([{ iid: undefined }, { web_url: undefined }, { web_url: "" }])(
    "returns null without an identity we can render or link (%s)", (over) => {
      expect(toMrFacts(mr(over), noExtra)).toBeNull();
    });
});

describe("pickMr", () => {
  it("prefers the open MR over the merged one and the merged over the closed", () => {
    expect(pickMr([
      mr({ iid: 1, state: "closed" }), mr({ iid: 2, state: "merged" }), mr({ iid: 3, state: "opened" }),
    ])?.iid).toBe(3);
    expect(pickMr([mr({ iid: 1, state: "closed" }), mr({ iid: 2, state: "merged" })])?.iid).toBe(2);
  });

  it("prefers the newest iid within one state", () => {
    expect(pickMr([mr({ iid: 4, state: "opened" }), mr({ iid: 9, state: "opened" })])?.iid).toBe(9);
  });

  it("skips entries with no iid, and returns undefined for an empty list", () => {
    expect(pickMr([mr({ iid: undefined })])).toBeUndefined();
    expect(pickMr([])).toBeUndefined();
  });

  it("does not mutate its input", () => {
    const list = [mr({ iid: 1, state: "closed" }), mr({ iid: 2, state: "opened" })];
    pickMr(list);
    expect(list.map((m) => m.iid)).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/engine/pr/glab/mr.test.ts`
Expected: FAIL — `Failed to resolve import ".../src/engine/pr/glab/mr"`.

- [ ] **Step 3: Extract `pickByState` in `src/engine/pr/facts.ts`**

The MR precedence policy (open beats merged beats closed; newest wins within a state) must live in exactly one place. Replace the existing `pickPr` body — do **not** touch `STATE_RANK` or the doc comment above `pickPr`:

```ts
/** Pick the most relevant item by state rank, then by descending number. Shared by
 * both forges so the precedence policy lives once: `pickPr` reads gh's `number`
 * and SHOUTED state, `pickMr` reads GitLab's `iid` and normalized state, and both
 * mean the same thing by "most relevant". Never mutates its input. */
export function pickByState<T>(items: T[], read: (t: T) => { number?: number; state?: string }): T | undefined {
  return [...items]
    .map((t) => ({ t, r: read(t) }))
    .filter((x) => typeof x.r.number === "number")
    .sort(
      (a, b) =>
        (STATE_RANK[b.r.state ?? ""] ?? 0) - (STATE_RANK[a.r.state ?? ""] ?? 0) ||
        (b.r.number as number) - (a.r.number as number),
    )[0]?.t;
}

export function pickPr(prs: GhPr[]): GhPr | undefined {
  return pickByState(prs, (p) => ({ number: p.number, state: p.state }));
}
```

- [ ] **Step 4: Verify the extraction changed no GitHub behavior**

Run: `npx vitest run test/unit/engine/pr/facts.test.ts`
Expected: PASS, with **no edits to that file**. This is the proof that the refactor is behaviour-preserving; if it fails, revert Step 3 and reconcile before continuing.

- [ ] **Step 5: Write `src/engine/pr/glab/mr.ts`**

```ts
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
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/pr/glab/mr.test.ts test/unit/engine/pr/facts.test.ts`
Expected: PASS — both files, with `facts.test.ts` unmodified.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/engine/pr/glab/mr.ts src/engine/pr/facts.ts test/unit/engine/pr/glab/mr.test.ts
git commit -m "feat(forge): map GitLab merge requests onto PrFacts"
```

---

## Task 2: `GlabProvider` — MR facts through `glab api`

**Files:**
- Create: `src/engine/pr/glab/provider.ts`
- Test: `test/unit/engine/pr/glab/provider.test.ts`

**Interfaces:**
- Consumes: Task 1's mappers; `PrProvider`, `FetchResult`, `Runner`, `Locate`, `execRunner` from `src/engine/pr/provider.ts`; `resolveBin` from `src/engine/pr/which.ts`.
- Produces:
  - `GLAB_TIMEOUT_MS: number` (10_000)
  - `GLAB_FIELD_FLAG: string` — the flag that sends an uninterpreted string field to `glab api`
  - `probeGlab(run?: Runner, locate?: Locate): Promise<ForgeGap | null>` — typed as the existing `GhGap` shape until Task 6 renames it
  - `mrListPath(selector: string): string`, `jobsPath(pipelineId: number): string`, `approvalsPath(iid: number): string`, `discussionsPath(iid: number): string`
  - `class GlabProvider implements PrProvider` with `constructor(run?: Runner, locate?: Locate)`

- [ ] **Step 1: Verify `glab api`'s field flags and pin the choice**

`glab` is not installed in the dev environment by default. Install it and read its help — do not guess, because the wrong flag lets a review body be type-coerced or read as a filename:

```bash
brew install glab   # or: see https://gitlab.com/gitlab-org/cli
glab api --help
```

Record which of `-f/--field`, `-F`, and `--raw-field` exist. Set `GLAB_FIELD_FLAG` to the flag documented as sending the value **as an uninterpreted string** (no type coercion, no `@file` reading). If `glab api --help` shows **no** such flag, stop and escalate: the review body must not go into argv unsafely, and the fallback is to add a stdin path to `Runner`, which is a change to a shared seam and needs its own review.

Every test below asserts on `GLAB_FIELD_FLAG` rather than a literal, so either outcome keeps them valid.

- [ ] **Step 2: Write the failing test file**

Create `test/unit/engine/pr/glab/provider.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { GlabProvider, probeGlab, GLAB_TIMEOUT_MS } from "../../../../../src/engine/pr/glab/provider";
import type { Runner } from "../../../../../src/engine/pr/provider";

/** An absolute path, as a real lookup returns: nothing here may depend on the bare
 * name `glab` being resolvable from the test process's own PATH. */
const GLAB = "/opt/homebrew/bin/glab";
const provider = (run: Runner) => new GlabProvider(run, () => GLAB);

const MR = {
  iid: 12, web_url: "https://gitlab.com/group/sub/proj/-/merge_requests/12",
  title: "Fix export", state: "opened", draft: false, source_branch: "feat/ASM-1",
  has_conflicts: false, detailed_merge_status: "mergeable",
  blocking_discussions_resolved: true, head_pipeline: null,
};

/** A Runner that replies by matching the request path, so a test states what each
 * endpoint returns instead of depending on call order. An unmatched path throws,
 * which is what the real `glab` does for a bad route. */
function routed(routes: Record<string, string | Error>): { run: Runner; calls: { args: string[]; cwd: string }[] } {
  const calls: { args: string[]; cwd: string }[] = [];
  const run: Runner = async (file, args, opts) => {
    calls.push({ args, cwd: opts.cwd });
    expect(file).toBe(GLAB);
    const hit = Object.entries(routes).find(([frag]) => args.some((a) => a.includes(frag)));
    if (!hit) throw new Error(`no route for ${args.join(" ")}`);
    if (hit[1] instanceof Error) throw hit[1];
    return hit[1];
  };
  return { run, calls };
}

describe("GlabProvider.fetch — argv", () => {
  it("asks for the source branch first, in the repo directory", async () => {
    const { run, calls } = routed({ source_branch: JSON.stringify([MR]), approvals: "{}" });
    await provider(run).fetch("/r/api", "feat/ASM-1", "ASM-1");

    expect(calls[0].cwd).toBe("/r/api");
    expect(calls[0].args[0]).toBe("api");
    expect(calls[0].args[1]).toContain("projects/:fullpath/merge_requests");
    expect(calls[0].args[1]).toContain("source_branch=feat%2FASM-1");
    expect(calls[0].args[1]).toContain("state=all");
  });

  it("falls back to a key title search when the branch has no MR", async () => {
    const { run, calls } = routed({ source_branch: "[]", search: JSON.stringify([MR]), approvals: "{}" });
    const res = await provider(run).fetch("/r/api", "feat/ASM-1", "ASM-1");

    expect(calls[1].args[1]).toContain("search=ASM-1");
    expect(calls[1].args[1]).toContain("in=title");
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({ number: 12 }) });
  });

  it("searches by key alone when there is no branch", async () => {
    const { run, calls } = routed({ search: JSON.stringify([MR]), approvals: "{}" });
    await provider(run).fetch("/r/api", null, "ASM-1");
    expect(calls).toHaveLength(2); // the search, then approvals — no branch call
    expect(calls[0].args[1]).toContain("search=ASM-1");
  });

  it("url-encodes a branch containing a slash and a key containing a space", async () => {
    const { run, calls } = routed({ merge_requests: "[]" });
    await provider(run).fetch("/r/api", "feat/a b", "A B");
    expect(calls[0].args[1]).toContain("source_branch=feat%2Fa%20b");
    expect(calls[1].args[1]).toContain("search=A%20B");
  });

  it("uses the shared 10s timeout", async () => {
    let seen = 0;
    const run: Runner = async (_f, _a, opts) => { seen = opts.timeoutMs; return "[]"; };
    await new GlabProvider(run, () => GLAB).fetch("/r/api", "b", "K");
    expect(seen).toBe(GLAB_TIMEOUT_MS);
  });

  it("falls back to the bare name when the binary cannot be located", async () => {
    let file = "";
    const run: Runner = async (f) => { file = f; return "[]"; };
    await new GlabProvider(run, () => null).fetch("/r/api", "b", "K");
    expect(file).toBe("glab");
  });
});

describe("GlabProvider.fetch — assembly", () => {
  it("reports no MR — not a failure — when both lookups come back empty", async () => {
    const { run } = routed({ merge_requests: "[]" });
    expect(await provider(run).fetch("/r/api", "b", "K")).toEqual({ ok: true, facts: null });
  });

  it("skips the discussions call when blocking discussions are resolved, and reports 0", async () => {
    const { run, calls } = routed({ source_branch: JSON.stringify([MR]), approvals: "{}" });
    const res = await provider(run).fetch("/r/api", "feat/ASM-1", "ASM-1");

    expect(calls.some((c) => c.args[1].includes("discussions"))).toBe(false);
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({ unresolved: 0 }) });
  });

  it("fetches discussions when blocking discussions are NOT resolved", async () => {
    const mr = { ...MR, blocking_discussions_resolved: false };
    const { run } = routed({
      source_branch: JSON.stringify([mr]),
      approvals: "{}",
      discussions: JSON.stringify([{ notes: [{ resolvable: true, resolved: false }] }]),
    });
    const res = await provider(run).fetch("/r/api", "feat/ASM-1", "ASM-1");
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({ unresolved: 1 }) });
  });

  it("fetches the pipeline's jobs by head_pipeline id, and maps them", async () => {
    const mr = { ...MR, head_pipeline: { id: 777, status: "failed" } };
    const { run, calls } = routed({
      source_branch: JSON.stringify([mr]),
      approvals: "{}",
      jobs: JSON.stringify([
        { name: "build", status: "success" },
        { name: "lint", status: "failed", web_url: "https://gl/j/lint", allow_failure: false },
      ]),
    });
    const res = await provider(run).fetch("/r/api", "feat/ASM-1", "ASM-1");

    expect(calls.some((c) => c.args[1].includes("pipelines/777/jobs"))).toBe(true);
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({
      ci: { passing: 1, pending: 0, failing: [{ name: "lint", url: "https://gl/j/lint" }] },
      ciAdvisory: false,
    }) });
  });

  it("skips the jobs call entirely when the MR has no pipeline", async () => {
    const { run, calls } = routed({ source_branch: JSON.stringify([MR]), approvals: "{}" });
    await provider(run).fetch("/r/api", "feat/ASM-1", "ASM-1");
    expect(calls.some((c) => c.args[1].includes("jobs"))).toBe(false);
  });

  it("maps approvals into the review verdict", async () => {
    const { run } = routed({
      source_branch: JSON.stringify([MR]),
      approvals: JSON.stringify({ approved: true, approvals_required: 1 }),
    });
    const res = await provider(run).fetch("/r/api", "feat/ASM-1", "ASM-1");
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({ review: "approved" }) });
  });
});

describe("GlabProvider.fetch — degradation", () => {
  it("fails the whole fetch when the MR lookup itself fails", async () => {
    const { run } = routed({ merge_requests: new Error("boom") });
    expect(await provider(run).fetch("/r/api", "b", "K")).toEqual({ ok: false });
  });

  it("fails the whole fetch on unparseable MR-list output", async () => {
    const { run } = routed({ merge_requests: "not json" });
    expect(await provider(run).fetch("/r/api", "b", "K")).toEqual({ ok: false });
  });

  it("fails the whole fetch when the MR list is not an array", async () => {
    const { run } = routed({ merge_requests: '{"message":"404 Not Found"}' });
    expect(await provider(run).fetch("/r/api", "b", "K")).toEqual({ ok: false });
  });

  // A sub-call is a detail, not the answer. Losing one must never discard the MR
  // we already found — and must never throw out of fetch, because an uncaught
  // throw leaves the caller's cache entry unstamped, which re-arms this repo's
  // fetch on every tick, forever.
  it("still returns facts when the approvals call fails, with review none", async () => {
    const { run } = routed({ source_branch: JSON.stringify([MR]), approvals: new Error("403") });
    const res = await provider(run).fetch("/r/api", "feat/ASM-1", "ASM-1");
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({ number: 12, review: "none" }) });
  });

  it("still returns facts when the jobs call fails, with an empty ci tally", async () => {
    const mr = { ...MR, head_pipeline: { id: 777 } };
    const { run } = routed({ source_branch: JSON.stringify([mr]), approvals: "{}", jobs: new Error("500") });
    const res = await provider(run).fetch("/r/api", "feat/ASM-1", "ASM-1");
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({
      ci: { passing: 0, pending: 0, failing: [] }, ciAdvisory: false,
    }) });
  });

  it("still returns facts when the discussions call fails, with unresolved null", async () => {
    const mr = { ...MR, blocking_discussions_resolved: false };
    const { run } = routed({ source_branch: JSON.stringify([mr]), approvals: "{}", discussions: new Error("500") });
    const res = await provider(run).fetch("/r/api", "feat/ASM-1", "ASM-1");
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({ unresolved: null }) });
  });
});

describe("probeGlab", () => {
  it("returns null when auth status succeeds", async () => {
    const run: Runner = async (_f, args) => { expect(args).toEqual(["auth", "status"]); return "ok"; };
    expect(await probeGlab(run, () => GLAB)).toBeNull();
  });

  // ENOENT is the only answer that means "not installed" — anything else came from
  // a glab that ran, so blaming the install would send the user hunting for a
  // binary they already have.
  it("reports missing only on ENOENT", async () => {
    const enoent = Object.assign(new Error("spawn glab ENOENT"), { code: "ENOENT" });
    expect(await probeGlab(async () => { throw enoent; }, () => GLAB)).toMatchObject({ kind: "missing" });
  });

  it("reports signed-out for any other failure", async () => {
    const gap = await probeGlab(async () => { throw new Error("no token"); }, () => GLAB);
    expect(gap).toMatchObject({ kind: "signed-out" });
    expect(gap?.detail).toContain(GLAB);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/unit/engine/pr/glab/provider.test.ts`
Expected: FAIL — cannot resolve `.../glab/provider`.

- [ ] **Step 4: Write `src/engine/pr/glab/provider.ts`**

```ts
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
import { resolveBin } from "../which";
import { PrFacts } from "../../../types";

export const GLAB_TIMEOUT_MS = 10_000;

/** The `glab api` flag that sends a field value as an uninterpreted string — no
 * type coercion, and no reading a leading `@` as a filename. Pinned in one place
 * and verified against the installed `glab` (see the plan's Task 2 Step 1);
 * every caller and every test reads it from here rather than hardcoding a flag. */
export const GLAB_FIELD_FLAG = "-f";

const locateGlab: Locate = () => resolveBin("glab");

/** Why forge reads are off. Structurally identical to `GhGap`, and unified into
 * one `ForgeGap` in the forge registry. */
export type GlabGap = { kind: "missing" | "signed-out"; detail: string };

export const mrListPath = (selector: string): string =>
  `projects/:fullpath/merge_requests?${selector}&state=all&per_page=10`;
export const jobsPath = (pipelineId: number): string =>
  `projects/:fullpath/pipelines/${pipelineId}/jobs?per_page=100`;
export const approvalsPath = (iid: number): string =>
  `projects/:fullpath/merge_requests/${iid}/approvals`;
export const discussionsPath = (iid: number): string =>
  `projects/:fullpath/merge_requests/${iid}/discussions?per_page=100`;

/** Is `glab` installed and logged in? Probed once per Deck session; a gap turns
 * forge reads off with a footer note rather than an error. */
export async function probeGlab(run: Runner = execRunner, locate: Locate = locateGlab): Promise<GlabGap | null> {
  const glab = locate() ?? "glab";
  try {
    await run(glab, ["auth", "status"], { cwd: process.cwd(), timeoutMs: GLAB_TIMEOUT_MS });
    return null;
  } catch (e) {
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
      let chosen: GlabMr | undefined;
      // The live branch is exact. The key search only covers an MR opened from a
      // branch Agent Flow didn't name.
      if (branch) chosen = pickMr(await this.list(repoPath, `source_branch=${encodeURIComponent(branch)}`));
      if (!chosen) chosen = pickMr(await this.list(repoPath, `search=${encodeURIComponent(key)}&in=title`));
      if (!chosen) return { ok: true, facts: null };

      // Each sub-call degrades on its own: losing a detail must not discard the MR
      // we found, and nothing here may throw out of `fetch` — an uncaught throw
      // leaves the caller's cache entry unstamped, which re-arms this repo's fetch
      // on every tick, forever.
      const jobs = await this.jobs(repoPath, chosen);
      return {
        ok: true,
        facts: toMrFacts(chosen, {
          ci: mapJobs(jobs),
          ciAdvisory: mapJobsAdvisory(jobs),
          review: mapApprovals(await this.approvals(repoPath, chosen.iid as number)),
          unresolved: await this.unresolved(repoPath, chosen),
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/pr/glab/`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/engine/pr/glab/provider.ts test/unit/engine/pr/glab/provider.test.ts
git commit -m "feat(forge): fetch GitLab MR facts through glab api"
```

---

## Task 3: GitLab review-search parser

**Files:**
- Create: `src/engine/review/glab/search.ts`
- Test: `test/unit/engine/review/glab/search.test.ts`

**Interfaces:**
- Consumes: `ReviewRequest` from `src/types.ts`; `mapApprovals` is **not** used here (the search carries no approvals — see below).
- Produces:
  - `REVIEW_MR_PATH: string`
  - `REVIEW_MR_LIMIT: number` (50)
  - `mapPipelineStatus(status?: string | null): ReviewRequest["ci"]`
  - `parseMrSearch(json: unknown): { issueCount: number; requests: ReviewRequest[] } | null`

- [ ] **Step 1: Write the failing test file**

Create `test/unit/engine/review/glab/search.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mapPipelineStatus, parseMrSearch, REVIEW_MR_PATH, REVIEW_MR_LIMIT } from "../../../../../src/engine/review/glab/search";

const node = (over: Record<string, unknown> = {}) => ({
  iid: 12, title: "Fix export", web_url: "https://gitlab.com/group/sub/proj/-/merge_requests/12",
  draft: false, created_at: "2026-08-01T10:00:00Z", updated_at: "2026-08-02T10:00:00Z",
  author: { username: "dana" }, references: { full: "group/sub/proj!12" },
  has_conflicts: false, detailed_merge_status: "mergeable",
  head_pipeline: { status: "success" }, ...over,
});

describe("REVIEW_MR_PATH", () => {
  it("asks only for open MRs that want this user's review, at the shared limit", () => {
    expect(REVIEW_MR_PATH).toContain("scope=reviews_for_me");
    expect(REVIEW_MR_PATH).toContain("state=opened");
    expect(REVIEW_MR_PATH).toContain(`per_page=${REVIEW_MR_LIMIT}`);
  });
});

describe("mapPipelineStatus", () => {
  it("maps success to passing and failed to failing", () => {
    expect(mapPipelineStatus("success")).toBe("passing");
    expect(mapPipelineStatus("failed")).toBe("failing");
  });

  it.each(["created", "preparing", "pending", "running", "waiting_for_resource", "scheduled"])(
    "maps %s to pending", (s) => expect(mapPipelineStatus(s)).toBe("pending"));

  // Inventing a red row from a state we don't know would send the user to an MR
  // that is fine.
  it.each(["canceled", "skipped", "manual", "unheard_of", null, undefined])(
    "maps %s to none", (s) => expect(mapPipelineStatus(s)).toBe("none"));
});

describe("parseMrSearch", () => {
  it("turns one MR into a request, keyed by project path and iid", () => {
    const out = parseMrSearch([node()]);
    expect(out?.requests[0]).toMatchObject({
      id: "group/sub/proj#12",
      repo: "group/sub/proj",
      repoName: "proj",
      number: 12,
      title: "Fix export",
      url: "https://gitlab.com/group/sub/proj/-/merge_requests/12",
      author: "dana",
      isDraft: false,
      ci: "passing",
      mergeable: "clean",
      review: "none",
    });
  });

  it("parses timestamps to epoch ms and leaves diff size at zero", () => {
    const r = parseMrSearch([node()])?.requests[0];
    expect(r?.createdAt).toBe(Date.parse("2026-08-01T10:00:00Z"));
    expect(r?.updatedAt).toBe(Date.parse("2026-08-02T10:00:00Z"));
    // GitLab's list carries no diff stats; `detail()` fills these on row expansion.
    expect([r?.additions, r?.deletions, r?.changedFiles]).toEqual([0, 0, 0]);
  });

  it("leaves the locally-observed fields null", () => {
    expect(parseMrSearch([node()])?.requests[0]).toMatchObject({
      localPath: null, runKey: null, draftPath: null,
    });
  });

  it("takes the project path from references.full, which may nest arbitrarily deep", () => {
    const r = parseMrSearch([node({ references: { full: "a/b/c/d!7" }, iid: 7 })])?.requests[0];
    expect(r?.repo).toBe("a/b/c/d");
    expect(r?.repoName).toBe("d");
  });

  it("falls back to the url when references.full is missing", () => {
    const r = parseMrSearch([node({ references: null })])?.requests[0];
    expect(r?.repo).toBe("group/sub/proj");
  });

  it("defaults an unparsable timestamp to 0 rather than NaN", () => {
    const r = parseMrSearch([node({ created_at: "nope", updated_at: 42 })])?.requests[0];
    expect([r?.createdAt, r?.updatedAt]).toEqual([0, 0]);
  });

  it("defaults a missing author to unknown", () => {
    expect(parseMrSearch([node({ author: null })])?.requests[0].author).toBe("unknown");
  });

  it("drops an entry with no identity we could render or link", () => {
    const out = parseMrSearch([node({ iid: undefined }), node({ web_url: "" }), node()]);
    expect(out?.requests).toHaveLength(1);
  });

  // An empty list is a SUCCESS meaning you owe nobody a review. That is a
  // different thing entirely from a failed attempt.
  it("reads an empty list as an empty queue, not a failure", () => {
    expect(parseMrSearch([])).toEqual({ issueCount: 0, requests: [] });
  });

  // Null means "this is not a search result" — the caller keeps its cached list
  // and flags it stale rather than emptying the strip.
  it.each([null, undefined, {}, '{"message":"401 Unauthorized"}', "text"])(
    "returns null for the unrecognised payload %s", (json) => {
      expect(parseMrSearch(json)).toBeNull();
    });

  it("counts what it returned, since GitLab's body carries no total", () => {
    expect(parseMrSearch([node(), node({ iid: 13 })])?.issueCount).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/engine/review/glab/search.test.ts`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write `src/engine/review/glab/search.ts`**

```ts
// The one call the GitLab review strip rides on, and the parser for its response.
// Pure: no process, no filesystem.
import { ReviewRequest } from "../../../types";
import { mapMrMergeable, projectFromMrUrl } from "../../pr/glab/mr";

export const REVIEW_MR_LIMIT = 50;

/** `scope=reviews_for_me` is GitLab's own "asked for my review" lens, so the
 * filtering happens server-side exactly as the GitHub search's does.
 *
 * One honest difference from the GitHub path: GitLab returns no total count in the
 * body, so `issueCount` is however many rows came back. A user with more than
 * REVIEW_MR_LIMIT pending reviews therefore sees a full queue reading as complete
 * rather than as truncated. Documented in docs/FORGES.md. */
export const REVIEW_MR_PATH = `merge_requests?scope=reviews_for_me&state=opened&per_page=${REVIEW_MR_LIMIT}`;

const CI_PENDING = new Set(["created", "preparing", "pending", "running", "waiting_for_resource", "scheduled"]);

/** A pipeline's status in the strip's vocabulary. Anything unrecognised reads as
 * "no CI" rather than as a failure — inventing a red row from a state we don't
 * know would send the user to an MR that is fine. */
export function mapPipelineStatus(status?: string | null): ReviewRequest["ci"] {
  if (!status) return "none";
  if (status === "success") return "passing";
  if (status === "failed") return "failing";
  if (CI_PENDING.has(status)) return "pending";
  return "none";
}

interface RawMr {
  iid?: unknown;
  title?: unknown;
  web_url?: unknown;
  draft?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  author?: { username?: unknown } | null;
  references?: { full?: unknown } | null;
  has_conflicts?: unknown;
  detailed_merge_status?: unknown;
  head_pipeline?: { status?: unknown } | null;
}

/** Epoch ms, or 0 for anything unparsable — NaN would poison every comparator. */
function ms(iso: unknown): number {
  if (typeof iso !== "string") return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** The project path, from `references.full` ("group/sub/proj!12") when present and
 * from the url otherwise. Never the first two path segments: GitLab groups nest. */
function projectOf(raw: RawMr): string | null {
  const full = raw.references?.full;
  if (typeof full === "string" && full.includes("!")) {
    const path = full.slice(0, full.indexOf("!"));
    if (path) return path;
  }
  return typeof raw.web_url === "string" ? projectFromMrUrl(raw.web_url) : null;
}

/** One MR → a request, or null when it lacks an identity we could render or link. */
function toRequest(raw: RawMr): ReviewRequest | null {
  if (typeof raw.iid !== "number" || typeof raw.web_url !== "string" || !raw.web_url) return null;
  const repo = projectOf(raw);
  if (!repo) return null;
  return {
    id: `${repo}#${raw.iid}`,
    repo,
    repoName: repo.split("/").pop() ?? repo,
    number: raw.iid,
    title: typeof raw.title === "string" ? raw.title : "",
    url: raw.web_url,
    author: typeof raw.author?.username === "string" ? raw.author.username : "unknown",
    isDraft: raw.draft === true,
    createdAt: ms(raw.created_at),
    updatedAt: ms(raw.updated_at),
    // GitLab's list carries no diff stats. `GlabReviewProvider.detail` fills these
    // on row expansion — one call per row the user actually opens, never 50.
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    ci: mapPipelineStatus(typeof raw.head_pipeline?.status === "string" ? raw.head_pipeline.status : null),
    // GitLab's MR list carries no approval state, and the strip's own row does not
    // need one to be useful. "none" rather than a per-row approvals round trip.
    review: "none",
    mergeable: mapMrMergeable(
      raw.has_conflicts === true,
      typeof raw.detailed_merge_status === "string" ? raw.detailed_merge_status : undefined,
    ),
    localPath: null,
    runKey: null,
    draftPath: null,
  };
}

/** Parse a `glab api merge_requests…` response. Null means "this is not a search
 * result" — an error object, a truncated body, anything the caller must treat as a
 * failed attempt rather than as an empty queue. An empty array is a *success* that
 * says you owe nobody a review, which is a different thing entirely. */
export function parseMrSearch(json: unknown): { issueCount: number; requests: ReviewRequest[] } | null {
  if (!Array.isArray(json)) return null;
  const requests = (json as RawMr[])
    .map((n) => (n && typeof n === "object" ? toRequest(n) : null))
    .filter((r): r is ReviewRequest => r !== null);
  return { issueCount: requests.length, requests };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/review/glab/search.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/engine/review/glab/search.ts test/unit/engine/review/glab/search.test.ts
git commit -m "feat(forge): parse the GitLab review-requests queue"
```

---

## Task 4: `GlabReviewProvider` — the review strip and the one write

**Files:**
- Create: `src/engine/review/glab/provider.ts`
- Modify: `src/types.ts` (`ReviewDetail.size`)
- Test: `test/unit/engine/review/glab/provider.test.ts`

**Interfaces:**
- Consumes: Task 3's `REVIEW_MR_PATH` / `parseMrSearch`; Task 1's `mapJobs` / `countUnresolvedDiscussions`; Task 2's `GLAB_TIMEOUT_MS` / `GLAB_FIELD_FLAG`; `ReviewProvider` from `src/engine/review/provider.ts`.
- Produces:
  - `ReviewDetail.size?: { additions: number; deletions: number; changedFiles: number } | null` in `src/types.ts`
  - `class GlabReviewProvider implements ReviewProvider` with `constructor(run?: Runner, locate?: Locate)`

- [ ] **Step 1: Add the optional `size` field to `ReviewDetail`**

In `src/types.ts`, replace the `ReviewDetail` interface:

```ts
/** What expanding a row adds — the facts the search cannot return. */
export interface ReviewDetail {
  failing: PrCheck[];
  unresolved: number | null;
  /** Diff size, for a forge whose search cannot carry it. Absent on GitHub, whose
   * search already filled `ReviewRequest.additions`/`deletions`/`changedFiles`;
   * `null` when the call failed. GitLab's REST API exposes no additions/deletions
   * aggregate, so its `additions` and `deletions` are 0 and only `changedFiles`
   * is real — see docs/FORGES.md. */
  size?: { additions: number; deletions: number; changedFiles: number } | null;
}
```

Optional, so every existing construction of a `ReviewDetail` — in `GhReviewProvider` and in every existing test — still typechecks and still passes unmodified.

- [ ] **Step 2: Write the failing test file**

Create `test/unit/engine/review/glab/provider.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { GlabReviewProvider } from "../../../../../src/engine/review/glab/provider";
import { GLAB_FIELD_FLAG } from "../../../../../src/engine/pr/glab/provider";
import type { Runner } from "../../../../../src/engine/pr/provider";

const GLAB = "/opt/homebrew/bin/glab";
const provider = (run: Runner) => new GlabReviewProvider(run, () => GLAB);
const REPO = "group/sub/proj";
const ENC = "group%2Fsub%2Fproj"; // every project-scoped path must be url-encoded

function routed(routes: Record<string, string | Error>): { run: Runner; calls: { args: string[]; cwd: string }[] } {
  const calls: { args: string[]; cwd: string }[] = [];
  const run: Runner = async (_file, args, opts) => {
    calls.push({ args, cwd: opts.cwd });
    const hit = Object.entries(routes).find(([frag]) => args.some((a) => a.includes(frag)));
    if (!hit) throw new Error(`no route for ${args.join(" ")}`);
    if (hit[1] instanceof Error) throw hit[1];
    return hit[1];
  };
  return { run, calls };
}

const MR = {
  iid: 12, title: "T", web_url: "https://gitlab.com/group/sub/proj/-/merge_requests/12",
  draft: false, author: { username: "dana" }, references: { full: "group/sub/proj!12" },
  head_pipeline: { status: "success" }, detailed_merge_status: "mergeable",
};

describe("GlabReviewProvider.search", () => {
  it("makes one repo-independent call from the home directory", async () => {
    const { run, calls } = routed({ reviews_for_me: JSON.stringify([MR]) });
    const out = await provider(run).search();

    expect(calls).toHaveLength(1);
    expect(calls[0].args[0]).toBe("api");
    // An MR wanting your review may live in a project you have never cloned, so
    // the cwd is only somewhere that exists for `glab` to run in.
    expect(calls[0].cwd).not.toBe("");
    expect(out?.requests[0].id).toBe("group/sub/proj#12");
  });

  it("returns null on failure — never an empty queue", async () => {
    const { run } = routed({ reviews_for_me: new Error("401") });
    expect(await provider(run).search()).toBeNull();
  });

  it("returns null on unparseable output", async () => {
    const { run } = routed({ reviews_for_me: "not json" });
    expect(await provider(run).search()).toBeNull();
  });

  it("returns an empty queue when nothing wants your review", async () => {
    const { run } = routed({ reviews_for_me: "[]" });
    expect(await provider(run).search()).toEqual({ issueCount: 0, requests: [] });
  });
});

describe("GlabReviewProvider.detail", () => {
  it("returns failing jobs, unresolved discussions, and the changed-file count", async () => {
    const { run, calls } = routed({
      [`merge_requests/12?`]: JSON.stringify({ head_pipeline: { id: 5 }, changes_count: "3" }),
      "pipelines/5/jobs": JSON.stringify([
        { name: "build", status: "success" },
        { name: "lint", status: "failed", web_url: "https://gl/j/lint" },
      ]),
      discussions: JSON.stringify([{ notes: [{ resolvable: true, resolved: false }] }]),
    });

    expect(await provider(run).detail(REPO, 12)).toEqual({
      failing: [{ name: "lint", url: "https://gl/j/lint" }],
      unresolved: 1,
      size: { additions: 0, deletions: 0, changedFiles: 3 },
    });
    expect(calls.every((c) => !c.args[1].includes("/-/"))).toBe(true);
    expect(calls[0].args[1]).toContain(`projects/${ENC}/merge_requests/12`);
  });

  it('parses a capped changes_count like "20+" as its numeric prefix', async () => {
    const { run } = routed({
      [`merge_requests/12?`]: JSON.stringify({ changes_count: "20+" }),
      discussions: "[]",
    });
    expect((await provider(run).detail(REPO, 12))?.size?.changedFiles).toBe(20);
  });

  it("returns null when the MR itself cannot be read", async () => {
    const { run } = routed({ [`merge_requests/12?`]: new Error("404") });
    expect(await provider(run).detail(REPO, 12)).toBeNull();
  });

  it("keeps the jobs it got when the discussions call fails", async () => {
    const { run } = routed({
      [`merge_requests/12?`]: JSON.stringify({ head_pipeline: { id: 5 }, changes_count: "1" }),
      "pipelines/5/jobs": JSON.stringify([{ name: "lint", status: "failed", web_url: "u" }]),
      discussions: new Error("500"),
    });
    expect(await provider(run).detail(REPO, 12)).toEqual({
      failing: [{ name: "lint", url: "u" }],
      unresolved: null,
      size: { additions: 0, deletions: 0, changedFiles: 1 },
    });
  });

  it("reports no failing jobs when the MR has no pipeline", async () => {
    const { run } = routed({ [`merge_requests/12?`]: JSON.stringify({ changes_count: "2" }), discussions: "[]" });
    expect((await provider(run).detail(REPO, 12))?.failing).toEqual([]);
  });

  it("reports a null size when changes_count is missing or unparsable", async () => {
    const { run } = routed({ [`merge_requests/12?`]: JSON.stringify({ changes_count: "?" }), discussions: "[]" });
    expect((await provider(run).detail(REPO, 12))?.size).toBeNull();
  });
});

describe("GlabReviewProvider.submit", () => {
  const ok = { approve: "{}", unapprove: "{}", notes: "{}" };

  it("approves with a POST to the approve endpoint", async () => {
    const { run, calls } = routed(ok);
    expect(await provider(run).submit(REPO, 12, "approve", "")).toEqual({ ok: true });
    expect(calls[0].args).toContain("--method");
    expect(calls[0].args).toContain("POST");
    expect(calls[0].args.some((a) => a.includes(`projects/${ENC}/merge_requests/12/approve`))).toBe(true);
  });

  it("posts an approval body as a note as well, so the words are not lost", async () => {
    const { run, calls } = routed(ok);
    await provider(run).submit(REPO, 12, "approve", "looks good");
    expect(calls.some((c) => c.args.some((a) => a.includes("/notes")))).toBe(true);
    expect(calls.some((c) => c.args.includes("body=looks good"))).toBe(true);
  });

  it("sends a comment as a note, through the raw-string field flag", async () => {
    const { run, calls } = routed(ok);
    expect(await provider(run).submit(REPO, 12, "comment", "a note")).toEqual({ ok: true });
    const note = calls.find((c) => c.args.some((a) => a.includes("/notes")))!;
    expect(note.args).toContain(GLAB_FIELD_FLAG);
    expect(note.args).toContain("body=a note");
  });

  // GitLab has no stable REST verb for this: the note carries the words and the
  // unapprove withdraws any standing approval.
  it("requests changes by posting a note and then unapproving", async () => {
    const { run, calls } = routed(ok);
    expect(await provider(run).submit(REPO, 12, "request-changes", "please fix")).toEqual({ ok: true });
    const paths = calls.map((c) => c.args.find((a) => a.includes("merge_requests/12")) ?? "");
    expect(paths.some((p) => p.endsWith("/notes"))).toBe(true);
    expect(paths.some((p) => p.endsWith("/unapprove"))).toBe(true);
  });

  it("still succeeds when there was no approval to withdraw", async () => {
    const { run } = routed({ notes: "{}", unapprove: new Error("404 Not Found") });
    expect(await provider(run).submit(REPO, 12, "request-changes", "please fix")).toEqual({ ok: true });
  });

  it("fails when the note itself cannot be posted", async () => {
    const { run } = routed({ notes: Object.assign(new Error("x"), { stderr: "403 Forbidden" }) });
    expect(await provider(run).submit(REPO, 12, "request-changes", "please fix"))
      .toEqual({ ok: false, message: "403 Forbidden" });
  });

  it("refuses a verb outside the union before building any argv", async () => {
    const { run, calls } = routed(ok);
    const res = await provider(run).submit(REPO, 12, "constructor" as never, "x");
    expect(res).toEqual({ ok: false, message: "Unknown review verb: constructor" });
    expect(calls).toHaveLength(0);
  });

  it.each(["comment", "request-changes"] as const)("refuses %s with an empty body", async (verb) => {
    const { run, calls } = routed(ok);
    const res = await provider(run).submit(REPO, 12, verb, "   ");
    expect(res).toEqual({ ok: false, message: "GitLab requires a message for this kind of review." });
    expect(calls).toHaveLength(0);
  });

  it("survives a body that is not a string at runtime", async () => {
    const { run } = routed(ok);
    expect(await provider(run).submit(REPO, 12, "approve", undefined as never)).toEqual({ ok: true });
  });

  it("says the write may have landed when the call is killed by the timeout", async () => {
    const killed = Object.assign(new Error("Command failed: glab api ... body=SECRET"), { killed: true });
    const { run } = routed({ notes: killed });
    const res = await provider(run).submit(REPO, 12, "comment", "SECRET");
    expect(res.ok).toBe(false);
    expect((res as { message: string }).message).toMatch(/may already have gone through/);
    expect((res as { message: string }).message).not.toContain("SECRET");
  });

  // The last line of defense: execFile's `.message` is `Command failed: <file>
  // <argv joined>`, which embeds the whole body.
  it("never returns the review body, with or without stderr", async () => {
    for (const err of [
      new Error("Command failed: glab api ... body=SECRET"),
      Object.assign(new Error("Command failed: glab api ... body=SECRET"), { stderr: "  " }),
      Object.assign(new Error("Command failed: glab api ... body=SECRET\n409 Conflict"), {}),
    ]) {
      const { run } = routed({ notes: err });
      const res = await provider(run).submit(REPO, 12, "comment", "SECRET");
      expect((res as { message: string }).message).not.toContain("SECRET");
    }
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/unit/engine/review/glab/provider.test.ts`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 4: Write `src/engine/review/glab/provider.ts`**

```ts
// The GitLab review strip's provider: the queue, one row's detail, and the only
// command in Agent Flow that writes to someone else's merge request.
import * as os from "os";
import { ReviewDetail, ReviewRequest, ReviewVerb } from "../../../types";
import { countUnresolvedDiscussions, mapJobs } from "../../pr/glab/mr";
import { GLAB_FIELD_FLAG, GLAB_TIMEOUT_MS } from "../../pr/glab/provider";
import { execRunner } from "../../pr/provider";
import type { Locate, Runner } from "../../pr/provider";
import { resolveBin } from "../../pr/which";
// `import type`, load-bearing: `test/unit/deckView.test.ts` mocks this module with
// a non-spreading factory returning only `GhReviewProvider`, so a VALUE import of
// `ReviewProvider` from here would resolve to `undefined` under that mock.
import type { ReviewProvider } from "../provider";
import { parseMrSearch, REVIEW_MR_PATH } from "./search";

const locateGlab: Locate = () => resolveBin("glab");

/** Node's execFile error `.message` is always `Command failed: <file> <full argv
 * joined>`, optionally followed by a `\n` and stderr's own text — for a review
 * submission, that first line embeds the entire body verbatim. Used only when a
 * rejection carries no `stderr` of its own, it keeps whatever follows the first
 * newline and falls back to a fixed, argv-free string when there is nothing
 * there — never the reconstructed command. */
function stripCommandLine(message: string): string {
  const nl = message.indexOf("\n");
  const rest = nl === -1 ? "" : message.slice(nl + 1).trim();
  return rest || "glab failed without further detail — check the merge request directly.";
}

/** A project path as one url path segment. GitLab's project-scoped routes take the
 * full nested path url-encoded, so `group/sub/proj` becomes `group%2Fsub%2Fproj`. */
const enc = (repo: string): string => encodeURIComponent(repo);

/** Every call here is project-independent in the same sense the GitHub provider's
 * are: an MR requesting your review may live in a project you have never cloned,
 * so the path carries the target and the home directory is only somewhere that
 * exists for `glab` to run in. */
export class GlabReviewProvider implements ReviewProvider {
  constructor(
    private readonly run: Runner = execRunner,
    private readonly locate: Locate = locateGlab,
  ) {}

  private exec(args: string[]): Promise<string> {
    return this.run(this.locate() ?? "glab", args, { cwd: os.homedir(), timeoutMs: GLAB_TIMEOUT_MS });
  }

  private get(path: string): Promise<string> {
    return this.exec(["api", path]);
  }

  private post(path: string, field?: string): Promise<string> {
    const args = ["api", path, "--method", "POST"];
    if (field !== undefined) args.push(GLAB_FIELD_FLAG, field);
    return this.exec(args);
  }

  /** Null means the attempt failed — never "you owe nobody a review". The caller
   * keeps its cached list and flags it stale rather than emptying the strip. */
  async search(): Promise<{ issueCount: number; requests: ReviewRequest[] } | null> {
    try {
      return parseMrSearch(JSON.parse(await this.get(REVIEW_MR_PATH)) as unknown);
    } catch {
      return null;
    }
  }

  /** The three things the queue call cannot return: which jobs failed, how many
   * discussions are still open, and the diff size. A failure in either of the
   * last two degrades to `null` rather than discarding what we did get. */
  async detail(repo: string, number: number): Promise<ReviewDetail | null> {
    let mr: { head_pipeline?: { id?: number } | null; changes_count?: unknown };
    try {
      mr = JSON.parse(await this.get(`projects/${enc(repo)}/merge_requests/${number}?`)) as typeof mr;
    } catch {
      return null;
    }

    let failing: ReviewDetail["failing"] = [];
    const pipelineId = mr.head_pipeline?.id;
    if (typeof pipelineId === "number") {
      try {
        const jobs = JSON.parse(await this.get(`projects/${enc(repo)}/pipelines/${pipelineId}/jobs?per_page=100`));
        failing = mapJobs(Array.isArray(jobs) ? jobs : null).failing;
      } catch {
        failing = [];
      }
    }

    let unresolved: number | null = null;
    try {
      const path = `projects/${enc(repo)}/merge_requests/${number}/discussions?per_page=100`;
      unresolved = countUnresolvedDiscussions(JSON.parse(await this.get(path)));
    } catch {
      unresolved = null;
    }

    return { failing, unresolved, size: readSize(mr.changes_count) };
  }

  /** The only command here that writes to GitLab. The caller confirms first; this
   * only refuses what GitLab would refuse anyway, and reports the rejection —
   * GitLab's own wording is more useful than ours.
   *
   * `verb` is not to be trusted just because the type says `ReviewVerb`:
   * `Object.hasOwn` — not a truthiness check, which a prototype key like
   * `"constructor"` would sail through — fails closed before a single argv is
   * built. `body` likewise arrives from a webview message, untyped at runtime.
   *
   * `request-changes` is the one verb whose meaning differs by forge: GitLab has
   * no stable REST equivalent, so it becomes a note plus a withdrawal of any
   * standing approval. `deckView` discloses that in the confirmation dialog. */
  async submit(
    repo: string, number: number, verb: ReviewVerb, body: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const VERBS: Record<ReviewVerb, true> = { approve: true, comment: true, "request-changes": true };
    if (!Object.hasOwn(VERBS, verb)) return { ok: false, message: `Unknown review verb: ${String(verb)}` };
    const text = String(body ?? "").trim();
    if (verb !== "approve" && !text) {
      return { ok: false, message: "GitLab requires a message for this kind of review." };
    }

    const base = `projects/${enc(repo)}/merge_requests/${number}`;
    try {
      // The note goes first for every verb that has words: if the state change
      // then fails, the reviewer's text is already on the MR rather than lost.
      if (text) await this.post(`${base}/notes`, `body=${text}`);
      if (verb === "approve") await this.post(`${base}/approve`);
      if (verb === "request-changes") {
        // There may be no approval to withdraw, which GitLab answers with an
        // error. That is not a failed review.
        try {
          await this.post(`${base}/unapprove`);
        } catch {
          /* nothing to withdraw */
        }
      }
      return { ok: true };
    } catch (e) {
      const err = e as { killed?: boolean; code?: unknown; stderr?: string };
      // A killed-by-timeout rejection has the same shape as any other execFile
      // failure but means something different: `glab` may well have reached GitLab
      // before the clock ran out, so "GitLab refused" would be a flat lie about a
      // write that could have succeeded server-side.
      if (err.killed || err.code === "ETIMEDOUT") {
        return {
          ok: false,
          message: `Timed out after ${GLAB_TIMEOUT_MS / 1000}s — the review may already have gone through. Open the merge request to check.`,
        };
      }
      // `stderr` is GitLab's actual wording, with none of the reconstructed argv
      // `.message` carries. This catch must never return the body, stderr present
      // or not.
      const msg = err.stderr?.trim() || (e instanceof Error ? stripCommandLine(e.message) : String(e));
      return { ok: false, message: msg };
    }
  }
}

/** `changes_count` is a string, and GitLab caps it ("20+"). Null when there is no
 * number in it at all: a zero would read as "no files changed", which is a claim,
 * where `null` is an absence. GitLab's REST API exposes no additions/deletions
 * aggregate, so those stay 0. */
function readSize(raw: unknown): ReviewDetail["size"] {
  if (typeof raw !== "string") return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? { additions: 0, deletions: 0, changedFiles: n } : null;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/review/`
Expected: PASS — including `test/unit/engine/review/provider.test.ts` (GitHub) unmodified.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/engine/review/glab/provider.ts src/types.ts test/unit/engine/review/glab/provider.test.ts
git commit -m "feat(forge): read and write GitLab merge-request reviews"
```

---

## Task 5: GitLab branch-CI verdict

The mapper and the argv builder both live in `src/engine/orchestrator/branchCi.ts` — **which is bundled into the webview**. Add nothing to that file but pure strings and pure functions. No imports.

**Files:**
- Modify: `src/engine/orchestrator/branchCi.ts`
- Test: `test/unit/engine/orchestrator/branchCi.test.ts` (append; do not alter existing cases)

**Interfaces:**
- Produces:
  - `GLAB_BRANCH_CI_PATH(branch: string): string`
  - `GLAB_BRANCH_CI_ARGS(branch: string): string[]`
  - `mapGlabBranchStatus(json: unknown): BranchCiStatus`

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/engine/orchestrator/branchCi.test.ts`:

```ts
describe("GLAB_BRANCH_CI_ARGS", () => {
  it("asks for the newest pipeline on that ref, in one call", () => {
    const args = GLAB_BRANCH_CI_ARGS("feat/ASM-1");
    expect(args[0]).toBe("api");
    expect(args[1]).toContain("projects/:fullpath/pipelines");
    expect(args[1]).toContain("ref=feat%2FASM-1");
    expect(args[1]).toContain("per_page=1");
  });

  it("url-encodes a ref that would otherwise break the query string", () => {
    expect(GLAB_BRANCH_CI_ARGS("fix/a&b=c")[1]).toContain("ref=fix%2Fa%26b%3Dc");
  });
});

describe("mapGlabBranchStatus", () => {
  const pipelines = (status: unknown) => [{ id: 1, status }];

  it("reads success as passed — the only state that is green", () => {
    expect(mapGlabBranchStatus(pipelines("success"))).toBe("passed");
  });

  it("reads failed as failed", () => {
    expect(mapGlabBranchStatus(pipelines("failed"))).toBe("failed");
  });

  it.each(["created", "waiting_for_resource", "preparing", "pending", "running", "scheduled"])(
    "reads %s as pending", (s) => expect(mapGlabBranchStatus(pipelines(s))).toBe("pending"));

  // Stricter than the GitHub arm on purpose: GitHub's aggregate rollup folds
  // SKIPPED toward SUCCESS, GitLab's per-ref pipeline status does not, and a
  // skipped pipeline must not open a deploy gate.
  it.each(["canceled", "skipped", "manual", "unheard_of", null, undefined, 42])(
    "reads %s as unknown, which is not green", (s) => expect(mapGlabBranchStatus(pipelines(s))).toBe("unknown"));

  it("reads a branch with no pipeline at all as unknown", () => {
    expect(mapGlabBranchStatus([])).toBe("unknown");
  });

  it.each([null, undefined, {}, '{"message":"404"}', "text", 0])(
    "reads the non-array payload %s as unknown", (json) => expect(mapGlabBranchStatus(json)).toBe("unknown"));

  it("is case-insensitive, so an instance that shouts is still graded", () => {
    expect(mapGlabBranchStatus(pipelines("SUCCESS"))).toBe("passed");
  });
});
```

Add `GLAB_BRANCH_CI_ARGS` and `mapGlabBranchStatus` to that file's existing import from `../../../../src/engine/orchestrator/branchCi`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/orchestrator/branchCi.test.ts`
Expected: FAIL — `GLAB_BRANCH_CI_ARGS is not a function`.

- [ ] **Step 3: Extend `src/engine/orchestrator/branchCi.ts`**

First, append this paragraph to the module's existing header comment, after the paragraph that explains the GitHub rollup's treatment of `SKIPPED`:

```
// GitLab is graded from a different fact and lands in a different place, worth
// knowing before trusting either: `mapGlabBranchStatus` reads the newest PIPELINE
// for the ref, which is a whole-pipeline verdict rather than an aggregate over
// checks. That makes it STRICTER than the GitHub arm above — a `skipped` pipeline
// reads `"unknown"` here, where GitHub's rollup would have folded a skipped check
// toward `SUCCESS`. Deliberate: the dangerous direction is a gate that opens on a
// pipeline nobody ran, and `"unknown"` is not green.
```

Then append at the end of the file:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/orchestrator/branchCi.test.ts`
Expected: PASS — every pre-existing case in that file included, unmodified.

- [ ] **Step 5: Verify the webview boundary still holds**

Run: `npm run build`
Expected: success. If esbuild reports an unresolved `child_process`/`fs`/`path`/`os`, you added an import to `branchCi.ts` — remove it; everything in this task is pure.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/engine/orchestrator/branchCi.ts test/unit/engine/orchestrator/branchCi.test.ts
git commit -m "feat(forge): grade a GitLab branch's newest pipeline"
```

---

## Task 6: The `Forge` interface and registry

**Files:**
- Create: `src/engine/forge/types.ts`, `src/engine/forge/github.ts`, `src/engine/forge/gitlab.ts`, `src/engine/forge/registry.ts`
- Test: `test/unit/engine/forge/registry.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–5; `GhProvider`/`probeGh`/`GH_TIMEOUT_MS`/`BRANCH_CI_ARGS`/`mapBranchStatus`; `GhReviewProvider`.
- Produces:
  - `type ForgeGap = { kind: "missing" | "signed-out"; detail: string }`
  - `interface ForgeCaps { changesRequested: boolean }`
  - `interface Forge` (as in the spec, plus `readonly caps: ForgeCaps`)
  - `makeGithubForge(run?: Runner): Forge`, `makeGitlabForge(run?: Runner): Forge`
  - `FORGES: Record<string, (run?: Runner) => Forge>`, `FORGE_IDS: string[]`, `resolveForge(id: string, log: (m: string) => void, run?: Runner): Forge`

- [ ] **Step 1: Write the failing test file**

Create `test/unit/engine/forge/registry.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { FORGE_IDS, resolveForge } from "../../../../src/engine/forge/registry";
import type { Runner } from "../../../../src/engine/pr/provider";
import pkg from "../../../../package.json";

const never: Runner = async () => { throw new Error("no call expected"); };

describe("FORGE_IDS", () => {
  it("lists both shipped forges, github first", () => {
    expect(FORGE_IDS).toEqual(["github", "gitlab"]);
  });

  // The same guard `test/unit/tasks/registry.test.ts` keeps over taskSource: the
  // manifest enum and the registry must not drift, or a contributor's forge reads
  // as "invalid" forever in telemetry while working fine at runtime.
  it("stays equal to agentFlow.forge's manifest enum", () => {
    const prop = (pkg.contributes.configuration.properties as Record<string, { enum?: string[] }>)["agentFlow.forge"];
    expect([...(prop.enum ?? [])].sort()).toEqual([...FORGE_IDS].sort());
  });
});

describe("resolveForge", () => {
  it("returns the GitHub forge, which describes itself with gh's own name and install url", () => {
    const f = resolveForge("github", () => {}, never);
    expect(f.id).toBe("github");
    expect(f.label).toBe("GitHub");
    expect(f.cli).toEqual({ name: "gh", installUrl: "https://cli.github.com" });
    expect(f.caps.changesRequested).toBe(true);
  });

  it("returns the GitLab forge, which cannot report changes_requested", () => {
    const f = resolveForge("gitlab", () => {}, never);
    expect(f.id).toBe("gitlab");
    expect(f.label).toBe("GitLab");
    expect(f.cli).toEqual({ name: "glab", installUrl: "https://gitlab.com/gitlab-org/cli" });
    expect(f.caps.changesRequested).toBe(false);
  });

  it("falls back to github, and says so, for an unknown id", () => {
    const log = vi.fn();
    expect(resolveForge("bitbucket", log, never).id).toBe("github");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("bitbucket"));
  });

  // `agentFlow.forge` comes from settings.json and can be any string. A bare index
  // would resolve a prototype key to a truthy non-factory and then call it.
  it.each(["constructor", "__proto__", "toString", ""])("falls back to github for the prototype key %s", (id) => {
    expect(resolveForge(id, () => {}, never).id).toBe("github");
  });
});

describe("Forge.branchCi", () => {
  it("grades a GitHub rollup response", async () => {
    const run: Runner = async (_f, args) => {
      expect(args[0]).toBe("api");
      expect(args).toContain("graphql");
      return JSON.stringify({ data: { repository: { ref: { target: { statusCheckRollup: { state: "SUCCESS" } } } } } });
    };
    expect(await resolveForge("github", () => {}, run).branchCi("/r/api", "main")).toBe("passed");
  });

  it("grades a GitLab pipelines response", async () => {
    const run: Runner = async (_f, args) => {
      expect(args[1]).toContain("pipelines");
      return JSON.stringify([{ id: 1, status: "failed" }]);
    };
    expect(await resolveForge("gitlab", () => {}, run).branchCi("/r/api", "main")).toBe("failed");
  });

  it.each(["github", "gitlab"] as const)("answers unknown for %s when the call fails", async (id) => {
    const run: Runner = async () => { throw new Error("boom"); };
    expect(await resolveForge(id, () => {}, run).branchCi("/r/api", "main")).toBe("unknown");
  });

  it.each(["github", "gitlab"] as const)("answers unknown for %s on unparseable output", async (id) => {
    const run: Runner = async () => "not json";
    expect(await resolveForge(id, () => {}, run).branchCi("/r/api", "main")).toBe("unknown");
  });

  it("runs the call in the given repo directory", async () => {
    let cwd = "";
    const run: Runner = async (_f, _a, opts) => { cwd = opts.cwd; return "[]"; };
    await resolveForge("gitlab", () => {}, run).branchCi("/r/api", "main");
    expect(cwd).toBe("/r/api");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/engine/forge/registry.test.ts`
Expected: FAIL — cannot resolve `.../forge/registry`.

- [ ] **Step 3: Write `src/engine/forge/types.ts`**

```ts
// The seam between Agent Flow and whichever forge holds its pull/merge requests.
// Interfaces only: no runtime code, so nothing here can drag a dependency
// anywhere. The implementations DO import `child_process` — see this directory's
// other files, and the constraint in docs/FORGES.md.
//
// `import type` on all three, deliberately and load-bearing: it is erased at build
// time, so this module adds no runtime edge to anything. It also survives
// `test/unit/deckView.test.ts`'s mock of `../review/provider`, which is a
// non-spreading factory returning only `GhReviewProvider` — a value import of
// `ReviewProvider` from there would resolve to `undefined` under that mock.
import type { BranchCiStatus } from "../orchestrator/branchCi";
import type { PrProvider } from "../pr/provider";
import type { ReviewProvider } from "../review/provider";

/** Why forge reads are off. `missing`: there was no binary to spawn.
 * `signed-out`: a CLI we did find refused `auth status` — no token, or one it
 * could not validate. `detail` is for the log; the Deck shows only the kind. */
export type ForgeGap = { kind: "missing" | "signed-out"; detail: string };

/** What a forge can answer, for the questions where they genuinely differ. Held
 * as data rather than probed, because the consumers are pure modules that must
 * not import this directory. */
export interface ForgeCaps {
  /** Can a reviewer's "changes requested" state be read back? GitHub reports it
   *  in `reviewDecision`; GitLab exposes no equivalent, which makes the
   *  `changes-requested` orchestrator condition unfirable there. */
  changesRequested: boolean;
}

export interface Forge {
  readonly id: string;
  /** The forge's own name, for every user-visible label. */
  readonly label: string;
  readonly cli: { name: string; installUrl: string };
  readonly caps: ForgeCaps;
  /** Is the CLI installed and logged in? Probed once per Deck session. */
  probe(): Promise<ForgeGap | null>;
  readonly prs: PrProvider;
  readonly reviews: ReviewProvider;
  /** Is this branch green? `"unknown"` for every unreadable fact — a failed call,
   *  a timeout, a rate limit, a shape this build does not recognise, a branch that
   *  does not exist — and `"unknown"` is NOT green. */
  branchCi(repoPath: string, branch: string): Promise<BranchCiStatus>;
}
```

- [ ] **Step 4: Write `src/engine/forge/github.ts`**

```ts
// GitHub as a Forge. Every provider here already existed and is wrapped
// unchanged: this file adds a description and a branch-CI spawn, nothing else.
// That is deliberate — it is what makes "GitHub still works" structural rather
// than a promise backed by tests.
import { BRANCH_CI_ARGS, BranchCiStatus, mapBranchStatus } from "../orchestrator/branchCi";
import { execRunner, GH_TIMEOUT_MS, GhProvider, probeGh } from "../pr/provider";
import type { Runner } from "../pr/provider";
import { resolveBin } from "../pr/which";
import { GhReviewProvider } from "../review/provider";
import type { Forge } from "./types";

export function makeGithubForge(run: Runner = execRunner): Forge {
  return {
    id: "github",
    label: "GitHub",
    cli: { name: "gh", installUrl: "https://cli.github.com" },
    caps: { changesRequested: true },
    probe: () => probeGh(run),
    prs: new GhProvider(run),
    reviews: new GhReviewProvider(run),
    async branchCi(repoPath, branch) {
      try {
        const out = await run(resolveBin("gh") ?? "gh", BRANCH_CI_ARGS(branch), {
          cwd: repoPath,
          timeoutMs: GH_TIMEOUT_MS,
        });
        return mapBranchStatus(JSON.parse(out) as unknown);
      } catch {
        // A non-zero exit, a timeout, a rate limit, unparseable output: all the
        // same answer, and it is not green.
        return "unknown" as BranchCiStatus;
      }
    },
  };
}
```

- [ ] **Step 5: Write `src/engine/forge/gitlab.ts`**

```ts
// GitLab as a Forge.
import { BranchCiStatus, GLAB_BRANCH_CI_ARGS, mapGlabBranchStatus } from "../orchestrator/branchCi";
import { GLAB_TIMEOUT_MS, GlabProvider, probeGlab } from "../pr/glab/provider";
import { execRunner } from "../pr/provider";
import type { Runner } from "../pr/provider";
import { resolveBin } from "../pr/which";
import { GlabReviewProvider } from "../review/glab/provider";
import type { Forge } from "./types";

export function makeGitlabForge(run: Runner = execRunner): Forge {
  return {
    id: "gitlab",
    label: "GitLab",
    cli: { name: "glab", installUrl: "https://gitlab.com/gitlab-org/cli" },
    // GitLab exposes no reviewer "changes requested" state we can read back.
    // `armability.ts` uses this to name the `changes-requested` rule as unfirable
    // rather than letting a flow wait on it forever.
    caps: { changesRequested: false },
    probe: () => probeGlab(run),
    prs: new GlabProvider(run),
    reviews: new GlabReviewProvider(run),
    async branchCi(repoPath, branch) {
      try {
        const out = await run(resolveBin("glab") ?? "glab", GLAB_BRANCH_CI_ARGS(branch), {
          cwd: repoPath,
          timeoutMs: GLAB_TIMEOUT_MS,
        });
        return mapGlabBranchStatus(JSON.parse(out) as unknown);
      } catch {
        return "unknown" as BranchCiStatus;
      }
    },
  };
}
```

- [ ] **Step 6: Write `src/engine/forge/registry.ts`**

```ts
import type { Runner } from "../pr/provider";
import { makeGithubForge } from "./github";
import { makeGitlabForge } from "./gitlab";
import type { Forge } from "./types";

/** Every forge Agent Flow can read from. Adding one is this line plus a file —
 * see docs/FORGES.md. */
const FORGES: Record<string, (run?: Runner) => Forge> = {
  github: makeGithubForge,
  gitlab: makeGitlabForge,
};

/** The registered ids. Exported so the telemetry snapshot's allowlist and the
 * manifest-parity test both derive from the registry instead of a hand-written
 * literal that would report a contributor's forge as "invalid" forever. */
export const FORGE_IDS: string[] = Object.keys(FORGES);

export function resolveForge(id: string, log: (m: string) => void, run?: Runner): Forge {
  // `Object.hasOwn`, not `FORGES[id]`: `agentFlow.forge` comes from settings.json
  // and can be any string, including a prototype key like "constructor" — which a
  // bare index resolves to a truthy non-factory that would then be called.
  if (!Object.hasOwn(FORGES, id)) {
    log(`forge "${id}" is not a known forge — falling back to github`);
    return FORGES.github(run);
  }
  return FORGES[id](run);
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/forge/registry.test.ts`
Expected: PASS.

- [ ] **Step 8: Verify the webview boundary, typecheck, and commit**

```bash
npm run build
npm run typecheck
git add src/engine/forge test/unit/engine/forge
git commit -m "feat(forge): add a Forge seam with github and gitlab behind a registry"
```

---

## Task 7: The `agentFlow.forge` setting

**Files:**
- Modify: `package.json`, `src/config.ts`, `src/telemetry/events.ts`, `src/telemetry/settingsSnapshot.ts`
- Test: `test/unit/config.test.ts` (add cases), `test/unit/telemetry/settingsSnapshot.test.ts` (**sanctioned additive edit**)

**Interfaces:**
- Consumes: `FORGE_IDS` from Task 6.
- Produces: `DeckConfig.forge: string`; `SettingsSnapshot.forge`.

- [ ] **Step 1: Add the setting to `package.json`**

In `contributes.configuration.properties`, immediately after `agentFlow.taskSource`:

```jsonc
"agentFlow.forge": {
  "type": "string",
  "enum": ["github", "gitlab"],
  "enumDescriptions": [
    "GitHub, through the `gh` CLI.",
    "GitLab, through the `glab` CLI."
  ],
  "default": "github",
  "description": "Which forge Agent Flow reads pull/merge requests, CI, and review requests from. Each forge needs its own CLI installed and signed in — run Doctor to check. Requires a window reload."
}
```

- [ ] **Step 2: Write the failing config test**

Append to `test/unit/config.test.ts`:

```ts
describe("forge", () => {
  it("defaults to github", () => {
    expect(getConfig().forge).toBe("github");
  });

  it("reads an explicit gitlab", () => {
    setConfig({ forge: "gitlab" });
    expect(getConfig().forge).toBe("gitlab");
  });

  // Validation belongs to resolveForge, which falls back and logs. getConfig's job
  // is only to report what the user actually wrote.
  it("passes an unknown value through untouched", () => {
    setConfig({ forge: "bitbucket" });
    expect(getConfig().forge).toBe("bitbucket");
  });

  it("treats an empty string as the default", () => {
    setConfig({ forge: "" });
    expect(getConfig().forge).toBe("github");
  });
});
```

`setConfig` is already imported in that file from `../_mocks/vscode` — use it, and do not introduce a new helper.

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run test/unit/config.test.ts`
Expected: FAIL — `forge` is `undefined`.

- [ ] **Step 4: Add `forge` to `DeckConfig` and `getConfig`**

In `src/config.ts`, beside the `taskSource` declaration in the config interface:

```ts
  // Which forge holds our pull/merge requests: "github" (via `gh`) or "gitlab"
  // (via `glab`). Validated by `resolveForge`, not here — an unknown value falls
  // back to github with a log line rather than being silently rewritten.
  forge: string;
```

and beside the `taskSource` read in `getConfig`:

```ts
    forge: c.get<string>("forge") || "github",
```

- [ ] **Step 5: Add the telemetry property**

In `src/telemetry/events.ts`, add to `SettingsSnapshot` beside `task_source`:

```ts
  forge: string;
```

In `src/telemetry/settingsSnapshot.ts`, import the registry ids and add the property beside `task_source`:

```ts
import { FORGE_IDS } from "../engine/forge/registry";
```
```ts
    forge: enumOrInvalid(cfg.forge, FORGE_IDS),
```

**Sanctioned edit:** `test/unit/telemetry/settingsSnapshot.test.ts` asserts the whole snapshot object with `toEqual`, so add `forge: "github"` to its expected object(s). This is additive — change no existing key or value.

While in that file, add the sibling of its existing `CONNECTOR_IDS` parity case (which asserts `CONNECTOR_IDS` equals `agentFlow.taskSource`'s manifest enum):

```ts
it("keeps FORGE_IDS equal to agentFlow.forge's manifest enum", () => {
  expect([...FORGE_IDS]).toEqual(props["agentFlow.forge"].enum);
});
```

and one case proving an unknown forge is reported as shape, never as the user's own text:

```ts
it("reports an unregistered forge as invalid rather than transmitting it", () => {
  expect(snapshot({ ...cfg, forge: "our-internal-thing" }).forge).toBe("invalid");
});
```

Match that file's existing `props` binding and snapshot-building helper rather than introducing new ones.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/unit/config.test.ts test/unit/telemetry/`
Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add package.json src/config.ts src/telemetry/events.ts src/telemetry/settingsSnapshot.ts test/unit/config.test.ts test/unit/telemetry/settingsSnapshot.test.ts
git commit -m "feat(forge): add the agentFlow.forge setting, defaulting to github"
```

---

## Task 8: Doctor reports the configured forge

**Files:**
- Modify: `src/engine/doctor.ts`, `src/doctorView.ts`
- Test: `test/unit/engine/doctor.test.ts` (add cases), `test/unit/doctorView.test.ts` + `test/unit/doctorView.deps.test.ts` (**sanctioned rename edit**)

**Interfaces:**
- Consumes: `Forge` from Task 6.
- Produces: `DoctorInputs.forge: { label: string; cli: string; installUrl: string; gap: ForgeGap | null; foundAt: string | null }` **replacing** `DoctorInputs.gh`. Required, not optional — every construction site must name a forge, and the compiler is what guarantees none is missed.

The existing `test/unit/engine/doctor.test.ts` uses `runChecks`, a `healthy()` fixture, and a `find(inputs, label)` helper. Its GitHub expectations — group `"GitHub"`, label `"gh"`, the install URL, and the found-at path in the detail — are exactly what must keep passing, so `forgeChecks` is designed so that a GitHub forge reproduces them byte-for-byte.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/engine/doctor.test.ts`, reusing that file's own `healthy()` and `find()`:

```ts
describe("runChecks — a GitLab forge", () => {
  const gitlab = {
    label: "GitLab", cli: "glab", installUrl: "https://gitlab.com/gitlab-org/cli",
    gap: null, foundAt: "/opt/homebrew/bin/glab",
  };

  it("groups the row under GitLab and labels it with glab, naming where it was found", () => {
    const c = find({ ...healthy(), forge: gitlab }, "glab");
    expect(c.group).toBe("GitLab");
    expect(c.status).toBe("ok");
    // Naming WHERE the binary was found is the most valuable line in the report: a
    // Homebrew CLI invisible to the extension host's bare launchd PATH reads, to a
    // signed-in user, as the Deck simply being broken.
    expect(c.detail).toContain("/opt/homebrew/bin/glab");
  });

  it("offers GitLab's own install link when glab is missing", () => {
    const c = find({ ...healthy(), forge: { ...gitlab, gap: { kind: "missing" as const, detail: "spawn ENOENT" }, foundAt: null } }, "glab");
    expect(c.status).toBe("fail");
    expect(c.action).toEqual({ kind: "external", url: "https://gitlab.com/gitlab-org/cli", label: "Install glab" });
  });

  it("skips under the forge's own group and label when PR facts are off", () => {
    const c = find({ ...healthy(), prFacts: false, forge: gitlab }, "glab");
    expect(c.group).toBe("GitLab");
    expect(c.status).toBe("skip");
    expect(c.detail).toContain("prFacts");
  });

  it("replaces the GitHub group entirely — a GitLab user sees no GitHub row", () => {
    const groups = new Set(runChecks({ ...healthy(), forge: gitlab }).map((c) => c.group));
    expect(groups.has("GitLab")).toBe(true);
    expect(groups.has("GitHub")).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/unit/engine/doctor.test.ts`
Expected: FAIL — `forge` is not a `DoctorInputs` field, and no check is labelled `glab`.

- [ ] **Step 3: Replace the `gh` field and `ghChecks` in `src/engine/doctor.ts`**

Replace the `gh?:` field in `DoctorInputs`:

```ts
  /** The configured forge, and whether its CLI is usable. `gap` is null both when
   *  the CLI is healthy and when `prFacts` is off (nothing was probed) — `prFacts`
   *  is what distinguishes those, and it is read separately. */
  forge: {
    label: string;
    cli: string;
    installUrl: string;
    gap: { kind: "missing" | "signed-out"; detail: string } | null;
    foundAt: string | null;
  };
```

Replace `ghChecks` (and its call site in this file's row assembly) with:

```ts
function forgeChecks(i: DoctorInputs): Check[] {
  const f = i.forge;
  // The skip row still carries the forge's own group and label: a row that named
  // no forge would read as a row about nothing, and the group set is what tells a
  // GitLab user their Deck is pointed where they think it is.
  if (!i.prFacts) {
    return [{ group: f.label, label: f.cli, status: "skip", detail: "agentFlow.prFacts is off" }];
  }
  const where = f.foundAt ?? f.cli;
  if (!f.gap) {
    return [{ group: f.label, label: f.cli, status: "ok", detail: `signed in — ${where}` }];
  }
  return [
    {
      group: f.label,
      label: f.cli,
      status: "fail",
      detail:
        f.gap.kind === "missing"
          ? "not installed, or not on a PATH the extension host can see"
          : `signed out — ${where}`,
      action: { kind: "external", url: f.installUrl, label: `Install ${f.cli}` },
    },
  ];
}
```

- [ ] **Step 4: Wire it in `src/doctorView.ts`**

Change the `DoctorDeps` member from `gh` to two members — describing the forge is cheap (config plus a registry lookup), probing it is not:

```ts
  forge: () => { label: string; cli: string; installUrl: string };
  forgeProbe: () => Promise<{ kind: "missing" | "signed-out"; detail: string } | null>;
```

Above the `DoctorInputs` object literal, hoist the resolution — it needs an `await`, and the probe must stay conditional so a Deck with PR facts off does not pay for an `auth status`:

```ts
  const f = d.forge();
  const forge = { ...f, gap: cfg.prFacts ? await d.forgeProbe() : null, foundAt: d.which(f.cli) };
```

and replace the old `gh:` line in the literal with `forge,`. In the real deps object at the bottom of the file, replace `gh: () => probeGh()` with:

```ts
    forge: () => {
      const { label, cli } = resolveForge(getConfig().forge, () => {});
      return { label, cli: cli.name, installUrl: cli.installUrl };
    },
    forgeProbe: () => resolveForge(getConfig().forge, () => {}).probe(),
```

`() => {}` for the logger because this file has none in scope and a fallback-to-github line is already reported by the Deck panel's own `resolveForge` call. Note that in the commit body.

**Sanctioned edit — a mechanical field rename, nothing more.** These five sites in `test/unit/engine/doctor.test.ts` pass `gh:` and must pass `forge:` with the three descriptive fields added (`label: "GitHub"`, `cli: "gh"`, `installUrl: "https://cli.github.com"`):

- the `healthy()` fixture (`gh: { gap: null, foundAt: "/opt/homebrew/bin/gh" }`)
- the missing-gh case
- the signed-out case
- the "skips gh entirely when PR facts are switched off" case — drop `gh: undefined`, keep `prFacts: false`
- the ordering case (`prFacts: false, gh: undefined`) — same

**Change no assertion**: the group set including `"GitHub"`, the label `"gh"`, `Install gh`, `https://cli.github.com`, and every detail substring stay exactly as written. Those untouched assertions are the proof that a GitHub user's Doctor report is byte-identical. Apply the same rename in `test/unit/doctorView.test.ts` and `test/unit/doctorView.deps.test.ts` (`gh` → `forge`/`forgeProbe`).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/doctor.test.ts test/unit/doctorView.test.ts test/unit/doctorView.deps.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/engine/doctor.ts src/doctorView.ts test/unit/engine/doctor.test.ts test/unit/doctorView.test.ts test/unit/doctorView.deps.test.ts
git commit -m "feat(forge): report the configured forge's CLI in Doctor"
```

---

## Task 9: Arming names a rule the forge can never satisfy

`armability.ts` is reachable from the webview bundle. The forge fact arrives as **plain data** — never an import of `src/engine/forge/`.

**Files:**
- Modify: `src/engine/orchestrator/armability.ts`
- Test: `test/unit/engine/orchestrator/armability.test.ts` (append)

**Interfaces:**
- Produces: `SourceState.forge?: { changesRequested: boolean }`; `UnfirableRule.needs` gains `"forge-unsupported"`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/engine/orchestrator/armability.test.ts` (reuse that file's existing flow/edge factory):

```ts
describe("forge capability", () => {
  const live = { liveSignal: true, prFacts: true };

  it("names changes-requested as unfirable on a forge that cannot report it", () => {
    const flow = flowWith(edge("changes-requested"));
    expect(unfirableRules(flow, { ...live, forge: { changesRequested: false } })).toEqual([
      { edgeId: "e1", needs: "forge-unsupported", label: "changes requested" },
    ]);
  });

  it("says nothing when the forge can report it", () => {
    const flow = flowWith(edge("changes-requested"));
    expect(unfirableRules(flow, { ...live, forge: { changesRequested: true } })).toEqual([]);
  });

  // Absent means GitHub, which is the default and can report it. This keeps every
  // pre-existing caller and test valid without modification.
  it("assumes a capable forge when none is supplied", () => {
    expect(unfirableRules(flowWith(edge("changes-requested")), live)).toEqual([]);
  });

  // PR facts being off is the bigger, more actionable fact, and reporting both for
  // one edge would put the same rule in the warning twice.
  it("prefers the PR-facts reason when both apply", () => {
    const flow = flowWith(edge("changes-requested"));
    const out = unfirableRules(flow, { liveSignal: true, prFacts: false, forge: { changesRequested: false } });
    expect(out).toEqual([{ edgeId: "e1", needs: "pr-facts", label: "changes requested" }]);
  });

  it("leaves every other condition kind alone on an incapable forge", () => {
    const flow = flowWith(edge("pr-merged"), edge("ci-passed"), edge("tree-clean"));
    expect(unfirableRules(flow, { ...live, forge: { changesRequested: false } })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/unit/engine/orchestrator/armability.test.ts`
Expected: FAIL — the `changes-requested` edge produces no rule.

- [ ] **Step 3: Extend `src/engine/orchestrator/armability.ts`**

Add to `SourceState`:

```ts
  /** What the configured forge can answer. Plain data, deliberately: this module
   *  is bundled into the webview and must not import `../forge/`. Absent means a
   *  fully capable forge — which is GitHub, the default — so every pre-existing
   *  caller keeps its meaning. */
  forge?: { changesRequested: boolean };
```

Widen `UnfirableRule.needs`:

```ts
  needs: "live-signal" | "pr-facts" | "forge-unsupported";
```

In `unfirableRules`, insert one arm between the `prFacts` check and the `liveSignal` check:

```ts
    if (!sources.prFacts && NEEDS_PR.has(e.cond.kind)) out.push({ edgeId: e.id, needs: "pr-facts", label });
    // Ordered after pr-facts on purpose: with PR facts off, that is the bigger and
    // more actionable reason, and reporting both for one edge would list the same
    // rule in the warning twice.
    else if (sources.forge?.changesRequested === false && e.cond.kind === "changes-requested") {
      out.push({ edgeId: e.id, needs: "forge-unsupported", label });
    }
    else if (!sources.liveSignal && NEEDS_LIVE.has(e.cond.kind)) out.push({ edgeId: e.id, needs: "live-signal", label });
```

- [ ] **Step 4: Handle the new `needs` value wherever it is rendered**

Run: `grep -rn '"pr-facts"\|needs ===\|needs\.' src/ --include=*.ts --include=*.tsx`

Every place that maps `needs` to user-facing words needs a `forge-unsupported` arm. Its wording: `` `your forge cannot report this` `` — the forge's own label is not in scope in a webview module, and naming the capability is the actionable part. If `needs` is only used in a template that prints it raw, leave it and note that in the commit message.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/orchestrator/ && npm run build`
Expected: PASS, and a successful build — the build proves `armability.ts` still imports nothing host-only.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/engine/orchestrator/armability.ts test/unit/engine/orchestrator/armability.test.ts
git commit -m "feat(forge): warn when arming a rule the forge cannot satisfy"
```

---

## Task 10: `deckView` runs on one `Forge`

**Files:**
- Modify: `src/deckView.ts`
- Test: `test/unit/deckView.test.ts` (add cases)

**Interfaces:**
- Consumes: `resolveForge`, `Forge` from Task 6; `ReviewDetail.size` from Task 4.
- Produces: no new exports; `FORGE_NOTES` replaces `GH_NOTES` internally.

- [ ] **Step 1: Replace the three GitHub fields with one forge**

At `src/deckView.ts:264-291`, replace `pr`, `ghRun` and `reviewProvider` with:

```ts
  /** The configured forge. One object, resolved once per panel: `agentFlow.forge`
   * is documented as needing a window reload, and a panel that swapped providers
   * mid-session would leave a half-GitHub, half-GitLab cache behind. */
  private readonly forge: Forge = resolveForge(getConfig().forge, (m) => this.log(m));
```

Then update the four call sites to read through it:

- `this.pr.fetch(...)` → `this.forge.prs.fetch(...)`
- `this.reviewProvider.search()` / `.detail(...)` / `.submit(...)` → `this.forge.reviews.…`
- `probeGh()` → `this.forge.probe()`
- the `enqueueBranchCi` body's spawn+map → `status = await this.forge.branchCi(want.cwd, want.branch)`

`enqueueBranchCi` keeps everything else exactly as it is — the always-stamp behavior, the `"unknown"` default, and the `deck: branch CI <key> unreadable` log line. `Forge.branchCi` already answers `"unknown"` rather than throwing, so the `try/catch` around it becomes redundant; leave the stamping in place.

Rename the field `ghGap` → `forgeGap` and `ghProbe` → `forgeProbe`, and `ghReady()` → `forgeReady()`, updating all references. `ghReady`'s meaning does not change.

- [ ] **Step 2: Make the footer note name the forge**

Replace `GH_NOTES` (line 71) with a function, since the CLI name is no longer a constant:

```ts
const FORGE_NOTES: Record<ForgeGap["kind"], (cli: string) => string> = {
  missing: (cli) => `${cli} CLI not found — PR facts off. Run Doctor`,
  "signed-out": (cli) => `${cli} is not signed in — PR facts off. Run Doctor`,
};
```

and at the post site (line 2548):

```ts
        ghNote: this.prFacts && this.forgeGap ? FORGE_NOTES[this.forgeGap.kind](this.forge.cli.name) : null,
```

Keep the wire field name `ghNote`: it is a webview message key, and renaming it would need a matching webview change for no user-visible gain. Note that in the commit body.

- [ ] **Step 3: Disclose what `request-changes` does on this forge**

In the submit confirmation (around line 2087), replace the modal with:

```ts
      const label = VERB_LABEL[verb];
      // GitLab has no stable "request changes" verb, so ours is a note plus a
      // withdrawal of any standing approval. That is materially different from
      // GitHub's, and the person clicking deserves to know before they click.
      const detail =
        verb === "request-changes" && !this.forge.caps.changesRequested
          ? `${this.forge.label} has no "request changes" review, so this posts your message as a comment and withdraws your approval if you had one.`
          : undefined;
      const answer = await vscode.window.showWarningMessage(
        `${label} on ${req.repo}#${req.number}?`,
        { modal: true, detail },
        label,
      );
```

- [ ] **Step 4: Merge a detail-supplied size into the cached request**

In `reviewDetail` (around line 1968), after a successful fetch and before the post:

```ts
    // A forge whose queue call carries no diff stats fills them here instead. Merged
    // into the cached request rather than posted separately, so the strip's existing
    // size chip renders it with no webview change at all.
    if (detail.size) {
      const cached = this.reviewCache?.requests.find((r) => r.id === id);
      if (cached) Object.assign(cached, detail.size);
    }
    this.post({ type: "deck:reviewDetail", id, detail });
```

- [ ] **Step 5: Pass the forge's capabilities to arming**

At line 2799:

```ts
          const dead = unfirableRules(flow, {
            liveSignal: true,
            prFacts: this.prFacts,
            forge: this.forge.caps,
          });
```

- [ ] **Step 6: Write tests for the two new behaviors**

The existing harness already gives you everything needed, and understanding why saves an hour: `test/unit/deckView.test.ts` mocks `src/engine/pr/provider` with a **spreading** factory that replaces `execRunner` with `h.ghRun`. `makeGitlabForge` passes that same `execRunner` into `GlabProvider`, so with `forge: "gitlab"` the real GitLab provider runs against the existing spawn stub — **no new mock is required**, and `h.ghRun`'s recorded argv is the proof of which forge is live.

`resolveBin("glab")` returns null on a machine without `glab`, so the spawned file is the bare name — assert on the argv, not the path.

Append to `test/unit/deckView.test.ts`, using its existing panel-construction helper:

```ts
describe("forge selection", () => {
  it("reads PR facts through glab, not gh, when the forge is gitlab", async () => {
    setConfig({ forge: "gitlab", prFacts: true });
    h.ghRun.mockResolvedValue("[]"); // an empty MR list — the argv is the assertion
    await openPanelAndSettle(); // this file's existing helper

    const paths = h.ghRun.mock.calls.map(([, args]: [string, string[]]) => args.join(" "));
    expect(paths.some((a) => a.includes("api") && a.includes("merge_requests"))).toBe(true);
    expect(paths.some((a) => a.includes("pr list"))).toBe(false);
  });

  it("still reads PR facts through gh when the forge is left at its default", async () => {
    setConfig({ prFacts: true });
    await openPanelAndSettle();
    // h.prFetch is the mocked GhProvider.fetch — the GitHub path must be untouched.
    expect(h.prFetch).toHaveBeenCalled();
  });

  it("names the configured forge's CLI in the footer note", async () => {
    setConfig({ forge: "gitlab", prFacts: true });
    h.ghRun.mockRejectedValue(Object.assign(new Error("spawn glab ENOENT"), { code: "ENOENT" }));
    await openPanelAndSettle();

    const note = lastPostOfType("deck:state")?.ghNote as string | null;
    expect(note).toContain("glab");
    expect(note).not.toContain("gh CLI");
  });
});
```

Replace `openPanelAndSettle()` and `lastPostOfType()` with this file's actual helpers — read the top of an existing `describe` block and reuse exactly what it uses. If the GitLab branch turns out not to be reachable through this harness for a reason you can state, assert the same three facts at the `resolveForge` level in `test/unit/engine/forge/registry.test.ts` instead, and say which and why in the commit body — but do not leave a test with an empty body.

- [ ] **Step 7: Run the whole suite, build, typecheck, commit**

```bash
npx vitest run
npm run build
npm run typecheck
git add src/deckView.ts test/unit/deckView.test.ts
git commit -m "feat(forge): run the Deck on the configured forge"
```

Expected: the full suite passes. Any failure in a pre-existing GitHub test means a call site was rewired wrongly — fix the code, not the test.

---

## Task 11: GitLab-flavoured seeded prompts

**Files:**
- Modify: `src/config.ts`, `package.json`
- Test: `test/unit/config.test.ts` (add cases)

**Interfaces:**
- Consumes: `explicitConfigValue` (already in `config.ts`), `DeckConfig.forge` from Task 7.
- Produces: `GITLAB_PR_REVIEW_PROMPT`, `GITLAB_REVIEW_REQUEST_PROMPT` constants in `src/config.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/config.test.ts`:

```ts
describe("forge-flavoured prompts", () => {
  it("keeps the GitHub prompt verbatim on github", () => {
    expect(getConfig().prReviewPrompt).toContain("gh pr checkout");
  });

  it("seeds the GitLab wording on gitlab", () => {
    setConfig({ forge: "gitlab" });
    const p = getConfig().prReviewPrompt;
    expect(p).toContain("glab mr checkout");
    expect(p).not.toContain("gh pr checkout");
    expect(p).toContain("merge request");
  });

  // A user who wrote their own prompt keeps it on either forge: we do not know
  // better than they do what their prompt should say.
  it("never clobbers a customized prompt", () => {
    setConfig({ forge: "gitlab", prReviewPrompt: "my own words" });
    expect(getConfig().prReviewPrompt).toBe("my own words");
  });

  it("preserves every placeholder the GitHub prompt offers", () => {
    setConfig({ forge: "gitlab" });
    for (const ph of ["{key}", "{summary}", "{url}", "{brief}", "{files}"]) {
      expect(getConfig().prReviewPrompt).toContain(ph);
    }
  });

  it("swaps the first review mode's prompt too, and keeps its placeholders", () => {
    setConfig({ forge: "gitlab" });
    const first = getConfig().reviewRequestModes[0].prompt;
    expect(first).toContain("glab mr checkout");
    for (const ph of ["{repo}", "{number}", "{author}", "{files}"]) {
      expect(first).toContain(ph);
    }
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/unit/config.test.ts`
Expected: FAIL — the GitLab cases still see `gh pr checkout`.

- [ ] **Step 3: Add the GitLab prompt constants to `src/config.ts`**

Beside the existing GitHub constants, keeping every placeholder and every instruction identical apart from the forge mechanics:

```ts
/** The GitLab wording of `DEFAULT_PR_REVIEW_PROMPT`. Differs only in the mechanics
 * it scripts — `glab mr checkout`, "merge request", "GitLab" — so the two stay
 * legible as variants of one prompt rather than drifting apart over time. */
export const GITLAB_PR_REVIEW_PROMPT =
  'Jira {key} ({url}): "{summary}". This task has an open GitLab merge request — all our MRs carry the Jira key in their title and branch. ' +
  "Using `glab` (or the GitLab tools available to you): find the MR for {key}, run `glab mr checkout` to bring its branch " +
  "into this worktree, then assess whether it's ready for us to work on — unresolved review comments and requested " +
  "changes first, then failing pipelines.{brief}{files}";

/** The GitLab wording of the first stock review mode's prompt. */
export const GITLAB_REVIEW_REQUEST_PROMPT =
  "Review merge request {number} in {repo}, opened by {author}. " +
  "Check it out with `glab mr checkout {number} --repo {repo}`, then read the full diff against its target branch. " +
  "Write your findings to `.pick-task/REVIEW-{number}.md` as a short verdict followed by specific comments, " +
  "each with the file and line it refers to. Do not post anything to GitLab; the human submits the review.{files}";
```

Copy the exact tail of each GitHub constant (`{brief}{files}` / `{files}`, and the `.pick-task/REVIEW-{number}.md` path) from the current values rather than retyping them — the tests above assert every placeholder.

- [ ] **Step 4: Select by forge, only when uncustomized**

In `getConfig`, replace the `prReviewPrompt` read:

```ts
    // A user who customized their prompt keeps it on either forge; only the
    // untouched default is forge-flavoured. `explicitConfigValue` is the same
    // "did the user actually write this?" test the reviewRequestModes migration
    // below already uses.
    prReviewPrompt:
      explicitConfigValue<string>(c, "prReviewPrompt") ??
      (forge === "gitlab" ? GITLAB_PR_REVIEW_PROMPT : DEFAULT_PR_REVIEW_PROMPT),
```

Hoist `const forge = c.get<string>("forge") || "github";` above the returned literal so both this and the `forge:` property read it.

For `reviewRequestModes`, inside the existing branch that returns `DEFAULT_REVIEW_REQUEST_MODES`, substitute the GitLab prompt into the first mode when `forge === "gitlab"`:

```ts
      const stock = forge === "gitlab"
        ? DEFAULT_REVIEW_REQUEST_MODES.map((m, i) =>
            i === 0 ? { ...m, prompt: GITLAB_REVIEW_REQUEST_PROMPT } : m)
        : DEFAULT_REVIEW_REQUEST_MODES;
```

and use `stock` wherever that branch currently uses `DEFAULT_REVIEW_REQUEST_MODES`. Leave the legacy-`reviewRequestPrompt` migration path untouched: a user with a legacy custom prompt keeps it.

- [ ] **Step 5: Update the manifest description**

In `package.json`, extend `agentFlow.prReviewPrompt`'s `markdownDescription` with one sentence:

```
Under `#agentFlow.forge#: gitlab` an equivalent GitLab-flavoured default is used instead, unless you have customized this setting.
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/unit/config.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/config.ts package.json test/unit/config.test.ts
git commit -m "feat(forge): seed GitLab-flavoured prompts when the forge is gitlab"
```

---

## Task 12: The webview boundary guard and `docs/FORGES.md`

**Files:**
- Modify: `test/webview/webviewGraph.test.ts`
- Create: `docs/FORGES.md`

- [ ] **Step 1: Understand what the guard already does**

`test/webview/webviewGraph.test.ts` is **not** a list of forbidden paths — it walks the real import graph from each browser entry and fails on any reachable Node builtin, naming the builtin and every hop that reached it. So the three new host-only directories are already covered the moment anything webview-reachable imports them. **There is no list to extend.**

What it lacks is a negative control proving that coverage for *this* seam. That file already carries exactly such a case for a past regression ("would catch the import that broke this branch", synthesizing a `conditions.ts → status.ts` import). Add the sibling case for the forge seam, in the same style — synthesizing the import rather than committing it:

```ts
// The forge modules spawn processes, and `armability.ts` is bundled into the
// webview while needing a forge FACT — which is why that fact is passed in as
// plain data. This proves the guard would catch it if someone "simplified" that
// into an import instead.
it("would catch armability.ts importing the forge registry", () => {
  const rel = "src/engine/orchestrator/armability.ts";
  const original = fs.readFileSync(path.join(REPO, rel), "utf8");
  expect(original).not.toContain("../forge/"); // the correct state
  const broken = `import { resolveForge } from "../forge/registry";\n${original}`;
  const hit = findBuiltin("src/webview/deck.tsx", { [rel]: broken });
  expect(hit).not.toBeNull();
  expect(hit!.chain.some((f) => f.startsWith("src/engine/forge/"))).toBe(true);
  expect(NODE_BUILTINS).toContain(hit!.builtin);
});
```

Note in a comment that `src/engine/forge/types.ts` holds only interfaces yet still reaches `child_process` through `../pr/provider`, so it is no safer to import than the rest of the directory — a later reader must not "fix" that apparent inconsistency.

- [ ] **Step 2: Run it to verify the guard is real**

Run: `npx vitest run test/webview/webviewGraph.test.ts`
Expected: PASS — including the new case, which fails the walk on a synthesized import while every other file is read from disk. If the new case does not find a builtin, the walker is not reaching the forge directory and the guard is hollow: fix that before continuing.

- [ ] **Step 3: Confirm the build agrees**

Run: `npm run build`
Expected: success.

- [ ] **Step 4: Write `docs/FORGES.md`**

```markdown
# Adding a forge

Agent Flow reads pull requests, CI and review requests through a seam, not a
hardwired dependency on GitHub. This guide is for whoever writes forge #3: what
the seam requires, what degrades gracefully when a forge can't answer something,
and where the seam doesn't reach — so you find those here instead of in a bug
report.

This guide is meant to be true, not encouraging.

## What a forge is

One interface, `Forge`, declared in `src/engine/forge/types.ts`: an id, a label, a
CLI to locate and probe, a capability record, and three providers — `prs`
(`PrProvider`), `reviews` (`ReviewProvider`), and `branchCi`.

`agentFlow.forge` selects the active forge by id. **`github` is the shipped
default.** `src/engine/forge/registry.ts`'s `FORGES` map is the full list;
`FORGE_IDS` is exported so the manifest, the telemetry allowlist and the registry
test all derive from it instead of a second hand-written list that can drift.

## The one hard constraint

`src/engine/forge/*` imports `child_process`. It must never be imported — even
transitively — by `src/webview/*`, `conditions.ts`, `branchCi.ts`, or
`armability.ts`, all of which are bundled into the webview. A violation is caught
**only** by `npm run build`: `npm run typecheck` and the full Vitest suite pass
regardless. `test/webview/webviewGraph.test.ts` pins the boundary.

This is why a forge's capabilities reach `armability.ts` as a plain
`{ changesRequested: boolean }` rather than as an imported `Forge`.

## What GitLab cannot answer

| Question | GitHub | GitLab | What the Deck does |
|---|---|---|---|
| Has a reviewer requested changes? | `reviewDecision` | not exposed | `review` never reads `changes_requested`; arming names the `changes-requested` rule as unfirable |
| Is a review thread outdated? | `isOutdated` | not exposed | the unresolved count is slightly more inclusive |
| Submit "request changes" | one verb | no stable verb | posts a note and withdraws any standing approval, disclosed in the confirmation dialog |
| Diff size in the review queue | in the search | not in the list | filled on row expansion; `additions`/`deletions` stay 0 because GitLab's REST API exposes no aggregate, so only the file count is real |
| How many reviews are waiting in total? | `issueCount` | no total in the body | the count is however many rows came back, so a queue longer than 50 reads as complete rather than truncated |
| Is a skipped required check green? | folded toward `SUCCESS` | `skipped` → `unknown` | GitLab is stricter; a skipped pipeline does not open a deploy gate |

## Conventions a new forge must keep

- **`null` from `reviews.search()` means the attempt failed**, never "you owe
  nobody a review". An empty array is a success meaning the queue is empty.
- **`{ ok: false }` from `prs.fetch()` means the attempt failed**;
  `{ ok: true, facts: null }` means there is genuinely no PR. Nothing may throw
  out of `fetch` — an uncaught throw leaves the caller's cache entry unstamped,
  which re-arms that repo's fetch on every tick, forever.
- **`branchCi` answers `"unknown"` rather than throwing**, and `"unknown"` is not
  green.
- **A review body must never reach an error message.** Prefer a rejection's
  `stderr` over its `.message`, which is `Command failed: <file> <argv joined>`
  and embeds the body. Keep the timeout branch's distinct wording: a killed
  process may already have reached the server.
- **Spawn through the injected `Runner`**, so no test forks a process, and locate
  the CLI through `resolveBin`, whose Homebrew/MacPorts fallbacks cover the bare
  launchd PATH the extension host inherits when the editor gives up resolving the
  user's shell environment.
```

- [ ] **Step 5: Make the docs test cover the new guide**

`test/unit/docs.test.ts` already asserts that every `CONNECTOR_IDS` entry is mentioned in `docs/CONNECTORS.md`, so a registered connector can never go undocumented. Add the sibling case, in the same shape:

```ts
it("documents every registered forge in docs/FORGES.md", () => {
  const doc = fs.readFileSync(path.join(REPO, "docs/FORGES.md"), "utf8");
  for (const id of FORGE_IDS) expect(doc).toContain(`\`${id}\``);
});
```

Import `FORGE_IDS` from `../../src/engine/forge/registry` and match that file's existing path/read helpers. This is why `docs/FORGES.md` above wraps `github` and `gitlab` in backticks.

- [ ] **Step 6: Run the whole suite once more and commit**

```bash
npx vitest run
npm run test:cov
npm run typecheck
npm run build
git add test/webview/webviewGraph.test.ts test/unit/docs.test.ts docs/FORGES.md
git commit -m "docs(forge): document the forge seam and pin its webview boundary"
```

Expected: all four green. `test:cov` thresholds must hold — if a new module is under-covered, add the missing cases rather than lowering a threshold.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §3 `Forge` seam, `ForgeGap` | 6 |
| §3.1 webview bundling constraint | 5 (Step 5), 6 (Step 8), 9 (Step 5), 12 |
| §4 `agentFlow.forge`, no renames | 7 |
| §4.1 seeded prompts | 11 |
| §5 two wire shapes, `projectFromUrl`, `iid` | 1 |
| §6.1 MR facts | 1, 2 |
| §6.2 `changes_requested` gap + armability | 6 (caps), 9 |
| §6.3 unresolved threads differ | 1 |
| §6.4 review strip + size chip | 3, 4, 10 (Step 4) |
| §6.5 review submit + disclosure | 4, 10 (Step 3) |
| §6.6 branch CI | 5, 6 |
| §6.7 Doctor | 8 |
| §7 capability table | 12 |
| §8 gates | Global Constraints; every task's final steps |
| §9 rollout + `docs/FORGES.md` | 7 (default), 12 |

**Deviations from the spec, both narrowings, both deliberate:**

1. **§6.4's size chip is partial.** GitLab's REST API exposes no
   additions/deletions aggregate anywhere cheap, so `detail()` fills only
   `changedFiles` (from `changes_count`) and leaves additions/deletions at 0. A
   GraphQL `diffStatsSummary` upgrade would close it; that is a follow-up, and
   `docs/FORGES.md` says so.
2. **`ReviewRequest.review` is always `"none"` on GitLab rows.** GitLab's MR list
   carries no approval state, and fetching it would cost one call per row on
   every refresh — the exact cost the size-chip decision rejected. The card-level
   `PrFacts.review` is unaffected and does read approvals (Task 2).

Both are named in `docs/FORGES.md`'s table rather than left for a user to
discover.

**Repo facts verified against the tree while writing this plan**, so no task points at a fiction:

- `test/unit/engine/doctor.test.ts` exports no `runDoctor`/`inputs`; it uses `runChecks`, a `healthy()` fixture and `find(inputs, label)`. Task 8 uses those names, and lists the five `gh:` sites its rename touches.
- `test/unit/config.test.ts` seeds settings with `setConfig` from `../_mocks/vscode` (there is no `setSettings`), and already imports `pkg` for manifest parity.
- `test/webview/webviewGraph.test.ts` is an import-graph **walker**, not a list of forbidden paths — new host-only directories are covered automatically, so Task 12 adds a negative-control case instead of extending a list that does not exist.
- Three parity guards already exist for `taskSource` (registry↔manifest enum, telemetry allowlist, `docs/CONNECTORS.md` mentions every id). Tasks 6, 7 and 12 add the `forge` sibling of each.
- `explicitConfigValue` is module-private in `src/config.ts`; Task 11 only uses it from inside that file.
- `test/unit/deckView.test.ts` mocks `src/engine/pr/provider` with a **spreading** factory (replacing `execRunner` with `h.ghRun`) but mocks `src/engine/review/provider` with a **non-spreading** one returning only `GhReviewProvider`. Two consequences, both handled: every interface import from those modules is `import type` so it is erased rather than resolving to `undefined`; and because `makeGitlabForge` passes that same mocked `execRunner` into `GlabProvider`, Task 10's tests exercise the real GitLab path against the existing spawn stub with no new mock.

**Type consistency checked:** `GLAB_FIELD_FLAG`, `GLAB_TIMEOUT_MS`,
`projectFromMrUrl`, `mapJobs`, `countUnresolvedDiscussions`, `pickByState`,
`mapGlabBranchStatus`, `GLAB_BRANCH_CI_ARGS`, `ForgeCaps.changesRequested`, and
`ReviewDetail.size` are each defined in exactly one task and referenced by that
same name everywhere after.
