import { describe, it, expect } from "vitest";
import {
  countBbUnresolved, mapBbMergeable, mapBbReview, mapBbStatuses,
  restBranchStatus, toRestFacts,
} from "../../../../../src/engine/pr/bb/rest";

/** One PR as `GET /2.0/repositories/{ws}/{slug}/pullrequests/{id}` sends it.
 * Fields taken from the `pullrequest` schema in Bitbucket's OpenAPI spec. */
const PR = {
  id: 42, title: "Add export", state: "OPEN", draft: false,
  links: { html: { href: "https://bitbucket.org/acme/api-service/pull-requests/42" } },
  source: { branch: { name: "feat/ASM-1" } },
  destination: { branch: { name: "main" } },
  participants: [] as unknown[],
};
const NO_CI = { passing: 0, pending: 0, failing: [] };

describe("toRestFacts", () => {
  it("reads the url and the draft flag the passthrough actually carries", () => {
    const facts = toRestFacts({ ...PR, draft: true }, { ci: NO_CI, mergeable: "clean", unresolved: 0 });
    expect(facts).toMatchObject({
      number: 42,
      url: "https://bitbucket.org/acme/api-service/pull-requests/42",
      state: "OPEN",
      isDraft: true,
      mergeable: "clean",
      unresolved: 0,
    });
  });

  it("pins every field of the returned PrFacts, not a subset", () => {
    // This test uses toEqual with a complete object, not toMatchObject with a
    // subset of keys. It catches mutations that hardcode fields (e.g. review:
    // "approved") because the participants here include a reviewer with
    // changes_requested, which must flow through mapBbReview into the facts.
    const ci = { passing: 1, pending: 0, failing: [] };
    const facts = toRestFacts(
      {
        id: 42,
        title: "Add export",
        state: "OPEN",
        draft: false,
        links: { html: { href: "https://bitbucket.org/acme/api-service/pull-requests/42" } },
        participants: [{ role: "REVIEWER", approved: false, state: "changes_requested" }],
      },
      { ci, mergeable: "conflicting", unresolved: 2 },
    );
    expect(facts).toEqual({
      number: 42,
      url: "https://bitbucket.org/acme/api-service/pull-requests/42",
      title: "Add export",
      state: "OPEN",
      isDraft: false,
      ci,
      review: "changes_requested",
      unresolved: 2,
      mergeable: "conflicting",
      ciAdvisory: false,
    });
  });

  it("returns null without an id or a usable html link", () => {
    expect(toRestFacts({ ...PR, id: "42" }, { ci: NO_CI, mergeable: "unknown", unresolved: null })).toBeNull();
    expect(toRestFacts({ ...PR, links: {} }, { ci: NO_CI, mergeable: "unknown", unresolved: null })).toBeNull();
    expect(toRestFacts({ ...PR, links: { html: { href: "" } } }, { ci: NO_CI, mergeable: "unknown", unresolved: null })).toBeNull();
  });
});

describe("mapBbReview", () => {
  const reviewer = (over: Record<string, unknown>) => ({ role: "REVIEWER", approved: false, state: null, ...over });

  it("reports the PR's review state, not any one person's", () => {
    // PrFacts.review is GitHub's `reviewDecision`: a fact about the pull request.
    // So changes-requested by ANYONE outranks an approval by someone else.
    expect(mapBbReview([reviewer({ approved: true, state: "approved" }), reviewer({ state: "changes_requested" })]))
      .toBe("changes_requested");
    expect(mapBbReview([reviewer({ approved: true, state: "approved" })])).toBe("approved");
    expect(mapBbReview([reviewer({})])).toBe("review_required");
  });

  it("ignores participants who are not reviewers", () => {
    // A commenter is a participant too. Counting one as an outstanding reviewer
    // would leave every commented-on PR reading as review_required forever.
    expect(mapBbReview([{ role: "PARTICIPANT", approved: false, state: null }])).toBe("none");
    expect(mapBbReview([{ role: "PARTICIPANT", approved: true, state: "approved" }])).toBe("none");
  });

  it("says none when there are no reviewers at all", () => {
    expect(mapBbReview([])).toBe("none");
    expect(mapBbReview(null)).toBe("none");
    expect(mapBbReview(undefined)).toBe("none");
  });
});

describe("mapBbStatuses", () => {
  it("tallies build statuses and names the failing ones", () => {
    const json = { values: [
      { state: "SUCCESSFUL", key: "PIPE", name: "Pipeline", url: "https://ci/1" },
      { state: "INPROGRESS", key: "LINT", name: "Lint", url: "" },
      { state: "FAILED", key: "TEST", name: "Tests", url: "https://ci/3" },
    ] };
    expect(mapBbStatuses(json)).toEqual({
      passing: 1, pending: 1, failing: [{ name: "Tests", url: "https://ci/3" }],
    });
  });

  it("falls back to the status key, then to a fixed name", () => {
    expect(mapBbStatuses({ values: [{ state: "FAILED", key: "TEST" }] }).failing)
      .toEqual([{ name: "TEST", url: "" }]);
    expect(mapBbStatuses({ values: [{ state: "FAILED" }] }).failing)
      .toEqual([{ name: "check", url: "" }]);
  });

  it("tallies zeros for a non-list, and skips rows it cannot read", () => {
    expect(mapBbStatuses({ message: "404 Not Found" })).toEqual(NO_CI);
    expect(mapBbStatuses(null)).toEqual(NO_CI);
    expect(mapBbStatuses({ values: [null, "nope", { state: "WHAT" }] })).toEqual(NO_CI);
  });
});

describe("mapBbMergeable", () => {
  it("reads an empty conflicts list as clean and a populated one as conflicting", () => {
    expect(mapBbMergeable({ values: [] })).toBe("clean");
    expect(mapBbMergeable({ values: [{ path: "src/a.ts" }] })).toBe("conflicting");
  });

  it("says unknown when the call gave us no list", () => {
    expect(mapBbMergeable({ message: "404 Not Found" })).toBe("unknown");
    expect(mapBbMergeable(null)).toBe("unknown");
  });
});

describe("countBbUnresolved", () => {
  const thread = (over: Record<string, unknown>) => ({
    id: 1, inline: { path: "src/a.ts", to: 4 }, resolution: null, ...over,
  });

  it("counts unresolved inline threads", () => {
    expect(countBbUnresolved({ values: [thread({ id: 1 }), thread({ id: 2 })] })).toBe(2);
    expect(countBbUnresolved({ values: [thread({ resolution: { type: "resolved" } })] })).toBe(0);
  });

  it("skips replies, deleted comments, and comments that are not review threads", () => {
    // A reply inherits its thread's resolution, so counting it would double-count
    // one conversation. A plain PR comment is not a review thread at all.
    expect(countBbUnresolved({ values: [thread({ parent: { id: 1 } })] })).toBe(0);
    expect(countBbUnresolved({ values: [thread({ deleted: true })] })).toBe(0);
    expect(countBbUnresolved({ values: [thread({ inline: undefined })] })).toBe(0);
  });

  it("returns null when the call gave us no list", () => {
    expect(countBbUnresolved({ message: "404 Not Found" })).toBeNull();
    expect(countBbUnresolved(null)).toBeNull();
  });
});

describe("restBranchStatus", () => {
  it("flattens state.result over state.name, exactly as the CLI does", () => {
    expect(restBranchStatus({ values: [{ state: { name: "COMPLETED", result: { name: "SUCCESSFUL" } } }] })).toBe("passed");
    expect(restBranchStatus({ values: [{ state: { name: "IN_PROGRESS" } }] })).toBe("pending");
    // COMPLETED with no result says the pipeline finished, not that it passed.
    expect(restBranchStatus({ values: [{ state: { name: "COMPLETED" } }] })).toBe("unknown");
  });

  it("says unknown for an empty list, a non-list, or a missing state", () => {
    expect(restBranchStatus({ values: [] })).toBe("unknown");
    expect(restBranchStatus({ message: "404" })).toBe("unknown");
    expect(restBranchStatus(null)).toBe("unknown");
    expect(restBranchStatus({ values: [{}] })).toBe("unknown");
  });
});
