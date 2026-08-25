import { describe, it, expect } from "vitest";
import {
  READ_ONLY_REVIEW_MODE_ID,
  batchReviewModes,
  needsWorktrees,
  planReviewBatch,
  readOnlyReviewMode,
  toBatchTask,
} from "../../../../src/engine/review/batch";
import { reviewRunKey } from "../../../../src/engine/review/launch";
import { DEFAULT_REVIEW_REQUEST_MODES } from "../../../../src/config";
import type { PromptMode, ReviewRequest } from "../../../../src/types";

const backend: PromptMode = { id: "backend", label: "Backend services", prompt: "BE {number}" };

describe("readOnlyReviewMode", () => {
  it("tells the agent not to check the branch out, and how to read it instead", () => {
    const m = readOnlyReviewMode("github");
    expect(m.id).toBe(READ_ONLY_REVIEW_MODE_ID);
    expect(m.prompt).toContain("Do NOT check the branch out");
    expect(m.prompt).toContain("git fetch origin pull/{number}/head");
    expect(m.prompt).toContain("git show FETCH_HEAD:");
    // The findings file is the one the strip already looks for.
    expect(m.prompt).toContain(".pick-task/REVIEW-{number}.md");
    // Never posts: the human submits the review.
    expect(m.prompt).toContain("Do not post anything");
  });

  it("names GitLab's own ref and vocabulary under the gitlab forge", () => {
    const m = readOnlyReviewMode("gitlab");
    expect(m.prompt).toContain("refs/merge-requests/{number}/head");
    expect(m.prompt).toContain("merge request");
    expect(m.prompt).not.toContain("pull request");
  });

  it("names Bitbucket's own ref and vocabulary under the bitbucket forge", () => {
    const m = readOnlyReviewMode("bitbucket");
    // `/from`, not `/head`. All three forges spell this ref differently and the
    // LEAF is the easy half to get wrong: Bitbucket's `refs/pull-requests/`
    // namespace with GitHub's `head` leaf is a ref that exists on no forge at
    // all, so the reviewer's fetch just fails.
    expect(m.prompt).toContain("refs/pull-requests/{number}/from");
    expect(m.prompt).not.toContain("refs/pull-requests/{number}/head");
    expect(m.prompt).toContain("pull request");
    expect(m.prompt).toContain("destination branch");
    expect(m.prompt).not.toContain("merge request");
    expect(m.prompt).toContain("Do not post anything to Bitbucket");
  });

  it("is not one of the shipped review modes", () => {
    // A second built-in would raise a QuickPick on every stock single-row launch —
    // see test/unit/deckView.test.ts "does not ask which mode to use…".
    expect(DEFAULT_REVIEW_REQUEST_MODES.some((m) => m.id === READ_ONLY_REVIEW_MODE_ID)).toBe(false);
  });
});

describe("batchReviewModes", () => {
  it("offers read-only first, then the user's own modes", () => {
    expect(batchReviewModes([backend], "github").map((m) => m.id)).toEqual(["read-only", "backend"]);
  });

  it("keeps the user's own entry when they already declared that id", () => {
    // Their wording wins, in their position — the batch adds a mode, never overrides one.
    const mine: PromptMode = { id: "read-only", label: "My read-only", prompt: "MINE" };
    const out = batchReviewModes([backend, mine], "github");
    expect(out.map((m) => m.id)).toEqual(["backend", "read-only"]);
    expect(out[1].prompt).toBe("MINE");
  });
});

describe("needsWorktrees", () => {
  it("is false only for the read-only mode", () => {
    expect(needsWorktrees(readOnlyReviewMode("github"))).toBe(false);
    expect(needsWorktrees(DEFAULT_REVIEW_REQUEST_MODES[0])).toBe(true);
  });

  it("assumes an unknown custom mode checks out", () => {
    // The safe answer: a worktree is the only thing that actually PREVENTS a
    // checkout from landing in the user's own tree, so anything we can't vouch
    // for gets one.
    expect(needsWorktrees(backend)).toBe(true);
  });
});

const rq = (over: Partial<ReviewRequest> = {}): ReviewRequest => ({
  id: "CyberJackGit/aws-ops#8491", repo: "CyberJackGit/aws-ops", repoName: "aws-ops",
  number: 8491, title: "isolate renew queue", url: "https://github.com/CyberJackGit/aws-ops/pull/8491",
  author: "einavsaad", isDraft: false, createdAt: 1, updatedAt: 2,
  additions: 350, deletions: 4, changedFiles: 7,
  ci: "passing", review: "review_required", mergeable: "clean",
  localPath: "/repos/aws-ops", runKey: null, draftPath: null,
  ...over,
});

describe("planReviewBatch", () => {
  const mode = readOnlyReviewMode("github");

  it("plans one item per reviewable PR, keyed exactly as a single launch would be", () => {
    // The key IS the run key: a batched review and a single one must be the same run,
    // or the strip would show one row as launched and the other as idle.
    const { items, skipped } = planReviewBatch([rq()], mode);
    expect(skipped).toEqual([]);
    expect(items).toHaveLength(1);
    expect(items[0].key).toBe(reviewRunKey("aws-ops", 8491));
    expect(items[0].ticket).toEqual({
      key: reviewRunKey("aws-ops", 8491),
      summary: "Review aws-ops#8491: isolate renew queue",
      url: "https://github.com/CyberJackGit/aws-ops/pull/8491",
    });
    expect(items[0].briefSubdir).toBe("REVIEW-8491");
    expect(items[0].base).toEqual({ name: "aws-ops", path: "/repos/aws-ops", isGit: true });
  });

  it("renders each PR's own review placeholders into its template", () => {
    const { items } = planReviewBatch([rq(), rq({ id: "b#12", repoName: "bite-me", repo: "oz/bite-me", number: 12, author: "sam" })], mode);
    expect(items[0].promptTemplate).toContain("CyberJackGit/aws-ops#8491");
    expect(items[0].promptTemplate).toContain("by einavsaad");
    expect(items[1].promptTemplate).toContain("oz/bite-me#12");
    expect(items[1].promptTemplate).toContain("by sam");
    // The later-stage placeholders are untouched — renderPrompt fills them at launch.
    expect(items[0].promptTemplate).toContain("{summary}");
    expect(items[0].promptTemplate).toContain("{files}");
  });

  it("skips a PR whose repo is not checked out, naming each repo once", () => {
    const { items, skipped } = planReviewBatch(
      [rq(), rq({ id: "x#1", repoName: "ext-svc", localPath: null, number: 1 }), rq({ id: "x#2", repoName: "ext-svc", localPath: null, number: 2 })],
      mode,
    );
    expect(items.map((i) => i.key)).toEqual([reviewRunKey("aws-ops", 8491)]);
    expect(skipped).toEqual(["ext-svc"]);
  });

  it("plans nothing, and skips everything, when no selected repo is checked out", () => {
    const { items, skipped } = planReviewBatch([rq({ localPath: null })], mode);
    expect(items).toEqual([]);
    expect(skipped).toEqual(["aws-ops"]);
  });
});

describe("toBatchTask", () => {
  it("finishes an item into a review-kinded BatchTask with the services it was given", () => {
    const { items } = planReviewBatch([rq()], readOnlyReviewMode("github"));
    const wt = [{ name: "aws-ops", path: "/repos/aws-ops/.claude/worktrees/review-aws-ops-8491", isGit: true }];
    const task = toBatchTask(items[0], wt);
    expect(task.kind).toBe("review");
    expect(task.services).toBe(wt);
    expect(task.promptTemplate).toBe(items[0].promptTemplate);
    expect(task.briefSubdir).toBe("REVIEW-8491");
    expect(task.ticket).toEqual(items[0].ticket);
    // descriptionText drives file-hint matching; a review has no ticket description.
    expect(task.descriptionText).toBe("");
  });
});
