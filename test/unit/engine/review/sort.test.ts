import { describe, it, expect } from "vitest";
import { sizeBucket, linesChanged, sortRequests } from "../../../../src/engine/review/sort";
import type { ReviewRequest } from "../../../../src/types";

const mk = (over: Partial<ReviewRequest> = {}): ReviewRequest => ({
  id: "o/r#1", repo: "o/r", repoName: "r", number: 1, title: "t", url: "u", author: "a",
  isDraft: false, createdAt: 1000, updatedAt: 1000,
  additions: 10, deletions: 0, changedFiles: 1,
  ci: "passing", review: "review_required", mergeable: "clean",
  localPath: null, runKey: null, draftPath: null,
  ...over,
});

describe("sizeBucket", () => {
  it.each([
    [0, "S"], [100, "S"], [101, "M"], [500, "M"], [501, "L"], [5921, "L"],
  ])("buckets %i lines as %s", (lines, bucket) => {
    expect(sizeBucket(lines)).toBe(bucket);
  });
});

describe("linesChanged", () => {
  it("sums additions and deletions", () => {
    expect(linesChanged(mk({ additions: 409, deletions: 50 }))).toBe(459);
  });
});

describe("sortRequests", () => {
  it("orders oldest first", () => {
    const out = sortRequests([mk({ id: "b", createdAt: 200 }), mk({ id: "a", createdAt: 100 })], "oldest");
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("orders smallest first by lines changed, not files", () => {
    const big = mk({ id: "big", additions: 3923, deletions: 1998, changedFiles: 50 });
    const small = mk({ id: "small", additions: 106, deletions: 0, changedFiles: 1 });
    expect(sortRequests([big, small], "smallest").map((r) => r.id)).toEqual(["small", "big"]);
  });

  it("breaks a size tie on age", () => {
    const newer = mk({ id: "newer", additions: 50, deletions: 0, createdAt: 200 });
    const older = mk({ id: "older", additions: 50, deletions: 0, createdAt: 100 });
    expect(sortRequests([newer, older], "smallest").map((r) => r.id)).toEqual(["older", "newer"]);
  });

  it("pins drafts last in both orders", () => {
    const draft = mk({ id: "draft", isDraft: true, createdAt: 1, additions: 1, deletions: 0 });
    const real = mk({ id: "real", createdAt: 999, additions: 900, deletions: 900 });
    expect(sortRequests([draft, real], "oldest").map((r) => r.id)).toEqual(["real", "draft"]);
    expect(sortRequests([draft, real], "smallest").map((r) => r.id)).toEqual(["real", "draft"]);
  });

  it("does not mutate its input", () => {
    const input = [mk({ id: "b", createdAt: 200 }), mk({ id: "a", createdAt: 100 })];
    sortRequests(input, "oldest");
    expect(input.map((r) => r.id)).toEqual(["b", "a"]);
  });
});
