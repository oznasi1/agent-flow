import { describe, it, expect } from "vitest";
import {
  BRANCH_CI_ARGS,
  BRANCH_CI_QUERY,
  branchCiKey,
  mapBranchStatus,
} from "../../../../src/engine/orchestrator/branchCi";

/** The shape `BRANCH_CI_ARGS`'s own query actually returns, built around a state. */
const rollup = (state: unknown): unknown => ({
  data: { repository: { ref: { target: { statusCheckRollup: { state } } } } },
});

describe("mapBranchStatus", () => {
  it("reads success from a combined status", () => {
    expect(mapBranchStatus({ state: "success" })).toBe("passed");
  });

  it("reads failure", () => {
    expect(mapBranchStatus({ state: "failure" })).toBe("failed");
  });

  it("reads pending", () => {
    expect(mapBranchStatus({ state: "pending" })).toBe("pending");
  });

  // Every unreadable shape is "unknown", and unknown must never read as green.
  it("is unknown for garbage, null, and a missing state", () => {
    for (const v of [null, undefined, {}, "success", { state: 7 }, [], 0, true]) {
      expect(mapBranchStatus(v)).toBe("unknown");
    }
  });

  it("grades the GraphQL rollup this module's own query returns", () => {
    // Uppercase, and nested — the shape probed against a real repo.
    expect(mapBranchStatus(rollup("SUCCESS"))).toBe("passed");
    expect(mapBranchStatus(rollup("FAILURE"))).toBe("failed");
    // An errored check run rolls up as ERROR, which is a failure, not a mystery.
    expect(mapBranchStatus(rollup("ERROR"))).toBe("failed");
    expect(mapBranchStatus(rollup("PENDING"))).toBe("pending");
    // A required check that has not been created yet is still ahead of us.
    expect(mapBranchStatus(rollup("EXPECTED"))).toBe("pending");
  });

  it("is unknown for a commit with no rollup and for a branch that does not exist", () => {
    // A commit nothing has ever checked. "No checks at all" is not "CI passed" —
    // the same call `ci-passed` makes with its `passing > 0` requirement.
    expect(mapBranchStatus({ data: { repository: { ref: { target: { statusCheckRollup: null } } } } })).toBe("unknown");
    expect(mapBranchStatus({ data: { repository: { ref: null } } })).toBe("unknown");
    expect(mapBranchStatus({ data: { repository: null } })).toBe("unknown");
  });

  it("is unknown for a state no build here has heard of", () => {
    expect(mapBranchStatus(rollup("QUEUED_MAYBE"))).toBe("unknown");
    expect(mapBranchStatus({ state: "neutral" })).toBe("unknown");
  });

  it("refuses a response carrying GraphQL errors, even beside a green state", () => {
    // A partial response is not a fact. Without this, a rate-limited call that
    // still echoes a stale `data` block could open a deploy gate.
    expect(mapBranchStatus({ ...(rollup("SUCCESS") as object), errors: [{ message: "rate limited" }] })).toBe("unknown");
  });
});

describe("BRANCH_CI_ARGS", () => {
  it("asks the GraphQL rollup, not the REST combined status", () => {
    const args = BRANCH_CI_ARGS("main");
    expect(args.slice(0, 2)).toEqual(["api", "graphql"]);
    // The whole reason for this query: REST's commits/{ref}/status ignores check
    // runs and answers "pending" on a green Actions-only branch.
    expect(args.join(" ")).not.toContain("commits/");
    expect(BRANCH_CI_QUERY).toContain("statusCheckRollup");
  });

  it("takes owner and name from gh's placeholders, so the checkout's remote decides", () => {
    // Never the flow's repo name: Agent Flow's worktree directories are not
    // GitHub repository names.
    expect(BRANCH_CI_ARGS("main")).toContain("owner={owner}");
    expect(BRANCH_CI_ARGS("main")).toContain("name={repo}");
  });

  it("sends the branch as a raw string, so no branch name is coerced or read as a file", () => {
    const args = BRANCH_CI_ARGS("123");
    // -f, not -F: `-F branch=123` would send an Int for a String! variable, and
    // `-F branch=@x` would read a file.
    expect(args[args.indexOf("branch=123") - 1]).toBe("-f");
    expect(BRANCH_CI_ARGS("release/2026-08")).toContain("branch=release/2026-08");
  });
});

describe("branchCiKey", () => {
  it("keys by repo AND branch, so one repo's two branches cannot collide", () => {
    expect(branchCiKey("bite-me", "main")).toBe("bite-me#main");
    expect(branchCiKey("bite-me", "main")).not.toBe(branchCiKey("bite-me", "release"));
    expect(branchCiKey("bite-me", "main")).not.toBe(branchCiKey("api", "main"));
  });
});
