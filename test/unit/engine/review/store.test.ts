import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  defaultReviewsFile, readReviewCache, writeReviewCache, isReviewCacheStale,
} from "../../../../src/engine/review/store";
import type { ReviewRequest } from "../../../../src/types";

const req: ReviewRequest = {
  id: "o/r#1", repo: "o/r", repoName: "r", number: 1, title: "t", url: "https://gh/o/r/pull/1",
  author: "a", isDraft: false, createdAt: 1, updatedAt: 2,
  additions: 3, deletions: 4, changedFiles: 5,
  ci: "passing", review: "review_required", mergeable: "clean",
  localPath: null, runKey: null, draftPath: null,
};

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-reviews-"));
  file = path.join(dir, "reviews.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("defaultReviewsFile", () => {
  it("sits beside the other agentflow stores", () => {
    expect(defaultReviewsFile()).toBe(path.join(os.homedir(), ".agentflow", "reviews.json"));
  });
});

describe("readReviewCache / writeReviewCache", () => {
  it("round-trips a cache", () => {
    writeReviewCache(file, { fetchedAt: 111, issueCount: 9, requests: [req] });
    expect(readReviewCache(file)).toEqual({ fetchedAt: 111, issueCount: 9, requests: [req] });
  });

  it("creates the directory when it is missing", () => {
    const nested = path.join(dir, "deep", "reviews.json");
    writeReviewCache(nested, { fetchedAt: 1, issueCount: 0, requests: [] });
    expect(readReviewCache(nested)).not.toBeNull();
  });

  it("returns null for a missing file", () => {
    expect(readReviewCache(path.join(dir, "nope.json"))).toBeNull();
  });

  it("returns null for corrupt JSON rather than throwing", () => {
    fs.writeFileSync(file, "{ half-writ");
    expect(readReviewCache(file)).toBeNull();
  });

  it("returns null when requests is not an array", () => {
    fs.writeFileSync(file, JSON.stringify({ fetchedAt: 1, issueCount: 0, requests: {} }));
    expect(readReviewCache(file)).toBeNull();
  });

  it("returns null when fetchedAt is missing", () => {
    fs.writeFileSync(file, JSON.stringify({ issueCount: 0, requests: [] }));
    expect(readReviewCache(file)).toBeNull();
  });

  it("leaves the previous cache intact when a write fails", () => {
    writeReviewCache(file, { fetchedAt: 1, issueCount: 1, requests: [req] });
    // A directory where the temp file wants to go: the rename can never land.
    writeReviewCache(path.join(dir), { fetchedAt: 2, issueCount: 0, requests: [] });
    expect(readReviewCache(file)!.fetchedAt).toBe(1);
  });
});

describe("isReviewCacheStale", () => {
  it("treats a missing cache as stale", () => {
    expect(isReviewCacheStale(null, 1000, 5000)).toBe(true);
  });

  it("is stale exactly at the TTL", () => {
    expect(isReviewCacheStale({ fetchedAt: 4000, issueCount: 0, requests: [] }, 1000, 5000)).toBe(true);
  });

  it("is fresh below the TTL", () => {
    expect(isReviewCacheStale({ fetchedAt: 4001, issueCount: 0, requests: [] }, 1000, 5000)).toBe(false);
  });
});
