import { describe, it, expect } from "vitest";
import {
  projectedBranchStatus, projectedCi, toProjectedFacts,
} from "../../../../../src/engine/pr/bb/projected";

const REPO = { workspace: "acme", slug: "api-service" };

/** One `bb pr list --format json` row, with EVERY field that command emits and
 * no others. Taken from `Row` in `crates/cli/src/commands/bitbucket/pullrequests.rs`
 * at omar16100/atlassian-cli@main — NOT from Bitbucket's API docs, which describe
 * a far richer object this command never passes through. Adding a field here that
 * the CLI does not emit would test the mapper against a response that can never
 * arrive. */
const ROW = {
  id: 42, title: "Add export", state: "OPEN",
  author: "Ada Lovelace", source: "feat/PROJ-1", destination: "main",
};

describe("toProjectedFacts", () => {
  it("fills what the CLI emits and synthesizes the url", () => {
    const facts = toProjectedFacts(ROW, REPO, { passing: 1, pending: 0, failing: [] });
    expect(facts).toMatchObject({
      number: 42,
      url: "https://bitbucket.org/acme/api-service/pull-requests/42",
      title: "Add export",
      state: "OPEN",
      ci: { passing: 1, pending: 0, failing: [] },
    });
  });

  it("reports every unreadable field as an ABSENCE, never as a value", () => {
    // Pinned one by one on purpose. Each of these is a fact `bb pr list` does not
    // carry, and the failure mode this guards is a later change that starts
    // inventing one — a card claiming "no conflicts" or "not a draft" from a
    // response that said neither.
    const facts = toProjectedFacts(ROW, REPO, { passing: 0, pending: 0, failing: [] });
    expect(facts?.isDraft).toBe(false);
    expect(facts?.mergeable).toBe("unknown");
    expect(facts?.review).toBe("none");
    expect(facts?.unresolved).toBeNull();
    expect(facts?.ciAdvisory).toBe(false);
  });

  it("returns null without a numeric id, since there is no url to build", () => {
    expect(toProjectedFacts({ ...ROW, id: "42" }, REPO, { passing: 0, pending: 0, failing: [] })).toBeNull();
    expect(toProjectedFacts({}, REPO, { passing: 0, pending: 0, failing: [] })).toBeNull();
  });

  it("survives a missing title rather than throwing", () => {
    expect(toProjectedFacts({ id: 7 }, REPO, { passing: 0, pending: 0, failing: [] })?.title).toBe("");
  });
});

describe("projectedCi", () => {
  it("turns the newest pipeline row into a one-check tally", () => {
    expect(projectedCi([{ build_number: 12, state: "SUCCESSFUL" }]))
      .toEqual({ passing: 1, pending: 0, failing: [] });
    expect(projectedCi([{ build_number: 12, state: "IN_PROGRESS" }]))
      .toEqual({ passing: 0, pending: 1, failing: [] });
    expect(projectedCi([{ build_number: 12, state: "FAILED" }]))
      .toEqual({ passing: 0, pending: 0, failing: [{ name: "Pipeline #12", url: "" }] });
  });

  it("tallies zeros for no pipeline, an unknown state, or a non-array", () => {
    const none = { passing: 0, pending: 0, failing: [] };
    expect(projectedCi([])).toEqual(none);
    expect(projectedCi([{ build_number: 1, state: "COMPLETED" }])).toEqual(none);
    expect(projectedCi({ message: "404 Not Found" })).toEqual(none);
    expect(projectedCi(null)).toEqual(none);
  });

  it("names a failing pipeline without a build number", () => {
    expect(projectedCi([{ state: "FAILED" }]))
      .toEqual({ passing: 0, pending: 0, failing: [{ name: "Pipeline", url: "" }] });
  });
});

describe("projectedBranchStatus", () => {
  it("grades the newest row, and calls anything unreadable unknown", () => {
    expect(projectedBranchStatus([{ state: "SUCCESSFUL" }])).toBe("passed");
    expect(projectedBranchStatus([{ state: "FAILED" }])).toBe("failed");
    expect(projectedBranchStatus([])).toBe("unknown");
    expect(projectedBranchStatus({ message: "404" })).toBe("unknown");
    expect(projectedBranchStatus(null)).toBe("unknown");
  });
});
