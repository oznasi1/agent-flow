import { describe, it, expect } from "vitest";
import {
  bbPrUrl, gradeBbPipeline, mapBbState, parseBitbucketRemote, pickBbPr,
} from "../../../../../src/engine/pr/bb/pr";

describe("parseBitbucketRemote", () => {
  it("reads https, scp-style and ssh:// remotes, with or without .git", () => {
    const want = { workspace: "acme", slug: "api-service" };
    expect(parseBitbucketRemote("https://bitbucket.org/acme/api-service.git")).toEqual(want);
    expect(parseBitbucketRemote("https://bitbucket.org/acme/api-service")).toEqual(want);
    expect(parseBitbucketRemote("git@bitbucket.org:acme/api-service.git")).toEqual(want);
    expect(parseBitbucketRemote("ssh://git@bitbucket.org/acme/api-service.git")).toEqual(want);
    expect(parseBitbucketRemote("https://someone@bitbucket.org/acme/api-service.git")).toEqual(want);
    expect(parseBitbucketRemote("  https://bitbucket.org/acme/api-service.git\n")).toEqual(want);
  });

  it("refuses any host that is not bitbucket.org", () => {
    // Not defensive trivia: pointing the Bitbucket forge at a GitHub checkout
    // would synthesize bitbucket.org URLs for GitHub PRs (see bbPrUrl).
    expect(parseBitbucketRemote("https://github.com/acme/api-service.git")).toBeNull();
    expect(parseBitbucketRemote("git@gitlab.com:acme/api-service.git")).toBeNull();
  });

  it("returns null for anything without a workspace and a slug", () => {
    expect(parseBitbucketRemote("https://bitbucket.org/acme")).toBeNull();
    expect(parseBitbucketRemote("not a url at all")).toBeNull();
    expect(parseBitbucketRemote("")).toBeNull();
    expect(parseBitbucketRemote("   ")).toBeNull();
  });
});

describe("bbPrUrl", () => {
  it("builds the Cloud pull-request url", () => {
    expect(bbPrUrl({ workspace: "acme", slug: "api-service" }, 42))
      .toBe("https://bitbucket.org/acme/api-service/pull-requests/42");
  });
});

describe("mapBbState", () => {
  it("maps Bitbucket's four states onto the Deck's three", () => {
    expect(mapBbState("OPEN")).toBe("OPEN");
    expect(mapBbState("MERGED")).toBe("MERGED");
    expect(mapBbState("DECLINED")).toBe("CLOSED");
    expect(mapBbState("SUPERSEDED")).toBe("CLOSED");
    expect(mapBbState("open")).toBe("OPEN");
    expect(mapBbState(undefined)).toBe("CLOSED");
    expect(mapBbState(7)).toBe("CLOSED");
  });
});

describe("gradeBbPipeline", () => {
  it("grades the vocabulary both modes share", () => {
    expect(gradeBbPipeline("SUCCESSFUL")).toBe("passed");
    expect(gradeBbPipeline("successful")).toBe("passed");
    for (const s of ["FAILED", "ERROR", "STOPPED", "EXPIRED"]) {
      expect(gradeBbPipeline(s)).toBe("failed");
    }
    for (const s of ["PENDING", "IN_PROGRESS", "BUILDING", "PAUSED", "HALTED"]) {
      expect(gradeBbPipeline(s)).toBe("pending");
    }
  });

  it("calls anything it does not recognise unknown, and unknown is not green", () => {
    // COMPLETED is a `state.name` with no `state.result` — terminal, but it does
    // not say whether the pipeline passed. Reading it as green would open a
    // deploy gate on a pipeline that may have failed.
    expect(gradeBbPipeline("COMPLETED")).toBe("unknown");
    expect(gradeBbPipeline("SOMETHING_NEW")).toBe("unknown");
    expect(gradeBbPipeline("")).toBe("unknown");
    expect(gradeBbPipeline(null)).toBe("unknown");
    expect(gradeBbPipeline(undefined)).toBe("unknown");
  });
});

describe("pickBbPr", () => {
  it("prefers the live PR, then the merged one, then the declined one", () => {
    const prs = [
      { id: 1, state: "MERGED" }, { id: 2, state: "DECLINED" }, { id: 3, state: "OPEN" },
    ];
    expect(pickBbPr(prs)?.id).toBe(3);
    expect(pickBbPr([{ id: 1, state: "MERGED" }, { id: 2, state: "DECLINED" }])?.id).toBe(1);
  });

  it("takes the newest id within a state, and skips rows with no numeric id", () => {
    expect(pickBbPr([{ id: 4, state: "OPEN" }, { id: 9, state: "OPEN" }])?.id).toBe(9);
    expect(pickBbPr([{ id: "x", state: "OPEN" }])).toBeUndefined();
    expect(pickBbPr([])).toBeUndefined();
  });
});
