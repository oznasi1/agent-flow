import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  defaultReviewsFile, readReviewCache, writeReviewCache, isReviewCacheStale,
} from "../../../../src/engine/review/store";
import type { ReviewRequest } from "../../../../src/types";

let renameFails = false;
vi.mock("fs", async (importActual) => {
  const actual = await importActual<typeof import("fs")>();
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (renameFails) throw new Error("EXDEV: cross-device link not permitted");
      return actual.renameSync(...args);
    },
  };
});

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

  it("filters out null and malformed requests, keeping only valid ones", () => {
    fs.writeFileSync(file, JSON.stringify({
      fetchedAt: 5, issueCount: 1, requests: [null, req, "garbage", { id: "bad" }],
    }));
    expect(readReviewCache(file)).toEqual({ fetchedAt: 5, issueCount: 1, requests: [req] });
  });

  it("keeps a readable file whose rows are all unusable, as an empty queue", () => {
    fs.writeFileSync(file, JSON.stringify({ fetchedAt: 5, issueCount: 1, requests: ["garbage"] }));
    expect(readReviewCache(file)).toEqual({ fetchedAt: 5, issueCount: 1, requests: [] });
  });

  it("returns an empty list as a valid readable cache, not null", () => {
    writeReviewCache(file, { fetchedAt: 5, issueCount: 0, requests: [] });
    expect(readReviewCache(file)).toEqual({ fetchedAt: 5, issueCount: 0, requests: [] });
  });

  it("leaves the previous cache intact when the rename fails", () => {
    writeReviewCache(file, { fetchedAt: 1, issueCount: 1, requests: [req] });
    renameFails = true;
    try {
      writeReviewCache(file, { fetchedAt: 2, issueCount: 0, requests: [] });
    } finally {
      renameFails = false;
    }
    // The old content survived a write that got as far as the rename.
    expect(readReviewCache(file)).toEqual({ fetchedAt: 1, issueCount: 1, requests: [req] });
    // And the temp file was cleaned up rather than left as litter.
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
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
