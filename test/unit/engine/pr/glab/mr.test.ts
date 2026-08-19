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

  // Isolated from the mixed-discussion case above: a lone already-resolved note
  // must not count as open. (The mixed case's total is a coincidence that a
  // resolved/unresolved sense-flip would still pass — this pins the direction.)
  it("does not count an already-resolved resolvable note as open", () => {
    expect(countUnresolvedDiscussions([disc([{ resolvable: true, resolved: true }])])).toBe(0);
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
