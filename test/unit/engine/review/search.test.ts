import { describe, it, expect } from "vitest";
import { mapRollupState, mapGraphMergeable, parseSearch, REVIEW_SEARCH_Q } from "../../../../src/engine/review/search";

const node = (over: Record<string, unknown> = {}) => ({
  number: 8491,
  title: "[ASM-5752] isolate renew queue",
  url: "https://github.com/CyberJackGit/aws-ops/pull/8491",
  isDraft: false,
  createdAt: "2026-07-23T07:28:26Z",
  updatedAt: "2026-07-23T16:33:30Z",
  additions: 350,
  deletions: 4,
  changedFiles: 7,
  author: { login: "einavsaad" },
  repository: { nameWithOwner: "CyberJackGit/aws-ops" },
  reviewDecision: "APPROVED",
  mergeable: "MERGEABLE",
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
  ...over,
});
const payload = (nodes: unknown[], issueCount = nodes.length) => ({ data: { search: { issueCount, nodes } } });

describe("REVIEW_SEARCH_Q", () => {
  it("is the exact qualifier set, including team requests", () => {
    expect(REVIEW_SEARCH_Q).toBe("is:pr is:open review-requested:@me");
  });
});

describe("mapRollupState", () => {
  it.each([
    ["SUCCESS", "passing"], ["FAILURE", "failing"], ["ERROR", "failing"],
    ["PENDING", "pending"], ["EXPECTED", "pending"],
  ])("maps %s to %s", (state, expected) => {
    expect(mapRollupState(state)).toBe(expected);
  });

  it("reports no CI for a null rollup or an unknown state", () => {
    expect(mapRollupState(null)).toBe("none");
    expect(mapRollupState(undefined)).toBe("none");
    expect(mapRollupState("WAT")).toBe("none");
  });
});

describe("mapGraphMergeable", () => {
  it.each([
    ["MERGEABLE", "clean"], ["CONFLICTING", "conflicting"], ["UNKNOWN", "unknown"],
  ])("maps %s to %s", (m, expected) => {
    expect(mapGraphMergeable(m)).toBe(expected);
  });

  it("treats a missing value as unknown — GitHub computes it lazily", () => {
    expect(mapGraphMergeable(undefined)).toBe("unknown");
  });
});

describe("parseSearch", () => {
  it("maps a full node", () => {
    const out = parseSearch(payload([node()]));
    expect(out).not.toBeNull();
    expect(out!.issueCount).toBe(1);
    expect(out!.requests[0]).toMatchObject({
      id: "CyberJackGit/aws-ops#8491",
      repo: "CyberJackGit/aws-ops",
      repoName: "aws-ops",
      number: 8491,
      author: "einavsaad",
      additions: 350,
      deletions: 4,
      changedFiles: 7,
      ci: "passing",
      review: "approved",
      mergeable: "clean",
      isDraft: false,
      localPath: null,
      runKey: null,
      draftPath: null,
    });
    expect(out!.requests[0].createdAt).toBe(Date.parse("2026-07-23T07:28:26Z"));
  });

  it("keeps issueCount when it exceeds the returned nodes", () => {
    expect(parseSearch(payload([node()], 73))!.issueCount).toBe(73);
  });

  it("drops a node with no number or no url, and keeps the rest", () => {
    const out = parseSearch(payload([node({ number: undefined }), node({ url: "" }), node({ number: 12 })]));
    expect(out!.requests.map((r) => r.number)).toEqual([12]);
  });

  it("drops a non-PullRequest node — the search type is ISSUE", () => {
    expect(parseSearch(payload([{}, node()]))!.requests).toHaveLength(1);
  });

  it("survives a missing author, rollup, counts and decision", () => {
    const out = parseSearch(payload([
      node({ author: null, commits: null, additions: undefined, deletions: undefined, changedFiles: undefined, reviewDecision: null }),
    ]));
    expect(out!.requests[0]).toMatchObject({
      author: "unknown", ci: "none", additions: 0, deletions: 0, changedFiles: 0, review: "none",
    });
  });

  it("survives an empty commits list", () => {
    expect(parseSearch(payload([node({ commits: { nodes: [] } })]))!.requests[0].ci).toBe("none");
  });

  it("zeroes an unparsable timestamp rather than yielding NaN", () => {
    expect(parseSearch(payload([node({ createdAt: "not a date" })]))!.requests[0].createdAt).toBe(0);
  });

  it("returns null for a shape that is not a search response", () => {
    expect(parseSearch({ errors: [{ message: "Bad credentials" }] })).toBeNull();
    expect(parseSearch(null)).toBeNull();
    expect(parseSearch({ data: { search: { nodes: "nope" } } })).toBeNull();
  });

  it("returns a non-null successful result for an empty nodes array", () => {
    const out = parseSearch(payload([]));
    expect(out).not.toBeNull();
    expect(out).toEqual({ issueCount: 0, requests: [] });
  });

  it("drops a node with no repository or empty nameWithOwner, and keeps the rest", () => {
    const out = parseSearch(payload([node({ repository: null }), node({ repository: {} }), node({ number: 12 })]));
    expect(out!.requests.map((r) => r.number)).toEqual([12]);
  });
});
