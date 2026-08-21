import { describe, it, expect } from "vitest";
import {
  READ_ONLY_REVIEW_MODE_ID,
  batchReviewModes,
  needsWorktrees,
  readOnlyReviewMode,
} from "../../../../src/engine/review/batch";
import { DEFAULT_REVIEW_REQUEST_MODES } from "../../../../src/config";
import type { PromptMode } from "../../../../src/types";

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
