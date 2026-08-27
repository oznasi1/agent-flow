import { describe, it, expect } from "vitest";
import {
  BRANCH_CI_ARGS,
  BRANCH_CI_QUERY,
  branchCiKey,
  mapBranchStatus,
  GLAB_BRANCH_CI_ARGS,
  mapGlabBranchStatus,
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

describe("GLAB_BRANCH_CI_ARGS", () => {
  it("asks for the newest pipeline on that ref, in one call", () => {
    const args = GLAB_BRANCH_CI_ARGS("feat/PROJ-1");
    expect(args[0]).toBe("api");
    expect(args[1]).toContain("projects/:fullpath/pipelines");
    expect(args[1]).toContain("ref=feat%2FPROJ-1");
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

  // A non-string status must not be coerced into one: String(["SUCCESS"]) is
  // "SUCCESS", so a naive `String(status).toUpperCase()` would grade this array
  // as passed. The status has to already BE the string "success" — coercion is
  // not reading, and unknown is never green.
  it("rejects a non-string status even when it would coerce to a recognised one", () => {
    expect(mapGlabBranchStatus(pipelines(["SUCCESS"]))).toBe("unknown");
  });
});
