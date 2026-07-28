import { describe, it, expect, vi } from "vitest";
import { reviewRunKey, renderReviewTemplate, launchReview } from "../../../../src/engine/review/launch";
import type { ReviewRequest } from "../../../../src/types";
import type { OpenRequest, OpenResult } from "../../../../src/engine/workspace";

const req: ReviewRequest = {
  id: "CyberJackGit/aws-ops#8491", repo: "CyberJackGit/aws-ops", repoName: "aws-ops",
  number: 8491, title: "isolate renew queue", url: "https://github.com/CyberJackGit/aws-ops/pull/8491",
  author: "einavsaad", isDraft: false, createdAt: 1, updatedAt: 2,
  additions: 350, deletions: 4, changedFiles: 7,
  ci: "passing", review: "review_required", mergeable: "clean",
  localPath: "/repos/aws-ops", runKey: null, draftPath: null,
};

const deps = (over = {}) => ({
  createWorktrees: vi.fn((services) => services.map((s: { name: string; path: string }) => ({ ...s, path: `${s.path}/.claude/worktrees/review-aws-ops-8491` }))),
  openWorkspace: vi.fn(async (_req: OpenRequest): Promise<OpenResult> => ({ mode: "per-window", briefs: [], opened: ["/w"], remoteControl: false })),
  log: vi.fn(),
  ...over,
});

describe("reviewRunKey", () => {
  it("is a filesystem-safe synthetic key", () => {
    expect(reviewRunKey("aws-ops", 8491)).toBe("review-aws-ops-8491");
  });

  it("strips characters that cannot be a directory name", () => {
    expect(reviewRunKey("weird/name repo", 7)).toBe("review-weird-name-repo-7");
  });
});

describe("renderReviewTemplate", () => {
  it("substitutes the review-only placeholders and leaves the rest alone", () => {
    const out = renderReviewTemplate(
      "Review {url} — {repo}#{number} by {author}; {summary} stays for renderPrompt.{files}",
      { repo: "o/r", number: 12, author: "dana" },
    );
    expect(out).toBe("Review {url} — o/r#12 by dana; {summary} stays for renderPrompt.{files}");
  });

  it("substitutes every occurrence", () => {
    expect(renderReviewTemplate("{number} {number}", { repo: "o/r", number: 3, author: "a" })).toBe("3 3");
  });
});

describe("launchReview", () => {
  it("refuses a request with no local checkout", async () => {
    const d = deps();
    const out = await launchReview({ req: { ...req, localPath: null }, template: "t", workspaceDir: "/ws", seedAgent: true }, d);
    expect(out).toEqual({ ok: false, message: "aws-ops isn't checked out under your repos root — open the PR on GitHub instead." });
    expect(d.createWorktrees).not.toHaveBeenCalled();
  });

  it("creates a worktree keyed to the PR", async () => {
    const d = deps();
    await launchReview({ req, template: "t", workspaceDir: "/ws", seedAgent: true }, d);
    expect(d.createWorktrees).toHaveBeenCalledWith(
      [{ name: "aws-ops", path: "/repos/aws-ops", isGit: true }],
      "review-aws-ops-8491",
      "Review aws-ops#8491: isolate renew queue",
      d.log,
    );
  });

  it("opens the worktree as a review run with the PR as its url", async () => {
    const d = deps();
    const out = await launchReview({ req, template: "Review {repo}#{number}", workspaceDir: "/ws", seedAgent: true }, d);
    expect(out).toEqual({ ok: true, runKey: "review-aws-ops-8491" });
    const arg = d.openWorkspace.mock.calls[0][0];
    expect(arg.kind).toBe("review");
    expect(arg.ticket).toEqual({
      key: "review-aws-ops-8491",
      summary: "Review aws-ops#8491: isolate renew queue",
      url: "https://github.com/CyberJackGit/aws-ops/pull/8491",
    });
    expect(arg.promptTemplate).toBe("Review CyberJackGit/aws-ops#8491");
    expect(arg.mode).toBe("per-window");
  });

  it("reports a failure from openWorkspace rather than throwing", async () => {
    const d = deps({ openWorkspace: vi.fn(async () => { throw new Error("disk full"); }) });
    const out = await launchReview({ req, template: "t", workspaceDir: "/ws", seedAgent: true }, d);
    expect(out).toEqual({ ok: false, message: "Couldn't open a review worktree for aws-ops#8491: Error: disk full" });
  });
});
