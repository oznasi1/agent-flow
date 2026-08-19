import { describe, it, expect } from "vitest";
import { mapPipelineStatus, parseMrSearch, REVIEW_MR_PATH, REVIEW_MR_LIMIT } from "../../../../../src/engine/review/glab/search";

const node = (over: Record<string, unknown> = {}) => ({
  iid: 12, title: "Fix export", web_url: "https://gitlab.com/group/sub/proj/-/merge_requests/12",
  draft: false, created_at: "2026-08-01T10:00:00Z", updated_at: "2026-08-02T10:00:00Z",
  author: { username: "dana" }, references: { full: "group/sub/proj!12" },
  has_conflicts: false, detailed_merge_status: "mergeable",
  head_pipeline: { status: "success" }, ...over,
});

describe("REVIEW_MR_PATH", () => {
  it("asks only for open MRs that want this user's review, at the shared limit", () => {
    expect(REVIEW_MR_PATH).toContain("scope=reviews_for_me");
    expect(REVIEW_MR_PATH).toContain("state=opened");
    expect(REVIEW_MR_PATH).toContain(`per_page=${REVIEW_MR_LIMIT}`);
  });
});

describe("mapPipelineStatus", () => {
  it("maps success to passing and failed to failing", () => {
    expect(mapPipelineStatus("success")).toBe("passing");
    expect(mapPipelineStatus("failed")).toBe("failing");
  });

  it.each(["created", "preparing", "pending", "running", "waiting_for_resource", "scheduled"])(
    "maps %s to pending", (s) => expect(mapPipelineStatus(s)).toBe("pending"));

  // Inventing a red row from a state we don't know would send the user to an MR
  // that is fine.
  it.each(["canceled", "skipped", "manual", "unheard_of", null, undefined])(
    "maps %s to none", (s) => expect(mapPipelineStatus(s)).toBe("none"));
});

describe("parseMrSearch", () => {
  it("turns one MR into a request, keyed by project path and iid", () => {
    const out = parseMrSearch([node()]);
    expect(out?.requests[0]).toMatchObject({
      id: "group/sub/proj#12",
      repo: "group/sub/proj",
      repoName: "proj",
      number: 12,
      title: "Fix export",
      url: "https://gitlab.com/group/sub/proj/-/merge_requests/12",
      author: "dana",
      isDraft: false,
      ci: "passing",
      mergeable: "clean",
      review: "none",
    });
  });

  it("parses timestamps to epoch ms and leaves diff size at zero", () => {
    const r = parseMrSearch([node()])?.requests[0];
    expect(r?.createdAt).toBe(Date.parse("2026-08-01T10:00:00Z"));
    expect(r?.updatedAt).toBe(Date.parse("2026-08-02T10:00:00Z"));
    // GitLab's list carries no diff stats; `detail()` fills these on row expansion.
    expect([r?.additions, r?.deletions, r?.changedFiles]).toEqual([0, 0, 0]);
  });

  it("leaves the locally-observed fields null", () => {
    expect(parseMrSearch([node()])?.requests[0]).toMatchObject({
      localPath: null, runKey: null, draftPath: null,
    });
  });

  it("takes the project path from references.full, which may nest arbitrarily deep", () => {
    const r = parseMrSearch([node({ references: { full: "a/b/c/d!7" }, iid: 7 })])?.requests[0];
    expect(r?.repo).toBe("a/b/c/d");
    expect(r?.repoName).toBe("d");
  });

  it("falls back to the url when references.full is missing", () => {
    const r = parseMrSearch([node({ references: null })])?.requests[0];
    expect(r?.repo).toBe("group/sub/proj");
  });

  it("defaults an unparsable timestamp to 0 rather than NaN", () => {
    const r = parseMrSearch([node({ created_at: "nope", updated_at: 42 })])?.requests[0];
    expect([r?.createdAt, r?.updatedAt]).toEqual([0, 0]);
  });

  it("defaults a missing author to unknown", () => {
    expect(parseMrSearch([node({ author: null })])?.requests[0].author).toBe("unknown");
  });

  it("drops an entry with no identity we could render or link", () => {
    const out = parseMrSearch([node({ iid: undefined }), node({ web_url: "" }), node()]);
    expect(out?.requests).toHaveLength(1);
  });

  // iid and web_url are both present and well-formed here — the only thing
  // missing is a project path: references.full is absent and the url has no
  // "/-/" segment for projectFromMrUrl to key off. Without its own guard this
  // would fall through to a repo of null and crash on `repo.split(...)`
  // rather than drop the row like every other unidentifiable entry.
  it("drops an entry whose project path can't be determined from either references or the url", () => {
    const out = parseMrSearch([
      node({ references: null, web_url: "https://gitlab.com/group/sub/proj" }),
      node(),
    ]);
    expect(out?.requests).toHaveLength(1);
    expect(out?.requests[0].number).toBe(12);
  });

  // An empty list is a SUCCESS meaning you owe nobody a review. That is a
  // different thing entirely from a failed attempt.
  it("reads an empty list as an empty queue, not a failure", () => {
    expect(parseMrSearch([])).toEqual({ issueCount: 0, requests: [] });
  });

  // Null means "this is not a search result" — the caller keeps its cached list
  // and flags it stale rather than emptying the strip.
  it.each([null, undefined, {}, '{"message":"401 Unauthorized"}', "text"])(
    "returns null for the unrecognised payload %s", (json) => {
      expect(parseMrSearch(json)).toBeNull();
    });

  it("counts what it returned, since GitLab's body carries no total", () => {
    expect(parseMrSearch([node(), node({ iid: 13 })])?.issueCount).toBe(2);
  });
});
