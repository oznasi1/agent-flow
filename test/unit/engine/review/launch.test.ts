import { describe, it, expect, vi } from "vitest";
import { reviewRunKey, renderReviewTemplate, launchReview, resolveReviewMode } from "../../../../src/engine/review/launch";
import { branchName } from "../../../../src/engine/worktree";
import type { PromptMode, ReviewRequest } from "../../../../src/types";
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
  openWorkspace: vi.fn(async (_req: OpenRequest): Promise<OpenResult> => ({ mode: "per-window", briefs: [], opened: ["/w"], remoteControl: false, provider: "claude-code" })),
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

  it("pins the (degenerate) behaviour when the name slugifies to nothing", () => {
    expect(reviewRunKey("___", 42)).toBe("review--42");
  });
});

describe("renderReviewTemplate", () => {
  it("substitutes the review-only placeholders and leaves the rest alone", () => {
    const out = renderReviewTemplate(
      "Review {url} — {repo}#{number} by {author}; {summary} stays for renderPrompt, as does {brief}.{files}",
      { repo: "o/r", number: 12, author: "dana" },
    );
    expect(out).toBe("Review {url} — o/r#12 by dana; {summary} stays for renderPrompt, as does {brief}.{files}");
  });

  it("substitutes every occurrence", () => {
    expect(renderReviewTemplate("{number} {number}", { repo: "o/r", number: 3, author: "a" })).toBe("3 3");
  });

  it("treats a $-bearing value literally instead of as a replacement pattern", () => {
    // String.prototype.replace(regex, stringValue) interprets $&, $$, $1 etc. in the
    // second argument. GitHub forbids `$` in usernames/repo names, so this is unreachable
    // via a real ReviewRequest today, but the function must not rely on that.
    expect(renderReviewTemplate("by {author}", { repo: "o/r", number: 1, author: "$&" })).toBe("by $&");
    expect(renderReviewTemplate("by {author}", { repo: "o/r", number: 1, author: "$$" })).toBe("by $$");
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
    // The third argument seeds createWorktrees's own branch-name slug
    // (`${key}-${slug(summary)}`) — passing the full "Review aws-ops#8491: …"
    // summary here would double the key into the branch name, since that
    // summary itself starts with a slugified copy of `key`. The PR title alone
    // is what must reach it.
    expect(d.createWorktrees).toHaveBeenCalledWith(
      [{ name: "aws-ops", path: "/repos/aws-ops", isGit: true }],
      "review-aws-ops-8491",
      "isolate renew queue",
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
    // The whole point of the function: openWorkspace must receive the WORKTREE-mapped
    // services returned by createWorktrees, not the original checkout passed into it.
    expect(arg.services).toEqual([
      { name: "aws-ops", path: "/repos/aws-ops/.claude/worktrees/review-aws-ops-8491", isGit: true },
    ]);
  });

  it("does not double the review key into the worktree branch name", async () => {
    // Regression: createWorktrees derives its own branch name as
    // `${key}-${slug(thirdArg)}`. The old third argument — the full "Review
    // <repoName>#<number>: <title>" summary — itself slugifies to start with
    // `key`, doubling it into every branch. Runs the *real* branchName (not a
    // restated formula) against whatever launchReview actually passed, so a
    // future change to either function still catches a reintroduced doubling.
    const d = deps();
    await launchReview({ req, template: "t", workspaceDir: "/ws", seedAgent: true }, d);
    const [, key, slugSource] = d.createWorktrees.mock.calls[0] as unknown as [unknown, string, string, unknown];
    expect(branchName(key, slugSource)).toBe("review-aws-ops-8491-isolate-renew-queue");
  });

  it("forwards seedAgent rather than assuming it", async () => {
    const dOn = deps();
    await launchReview({ req, template: "t", workspaceDir: "/ws", seedAgent: true }, dOn);
    expect(dOn.openWorkspace.mock.calls[0][0].seedAgent).toBe(true);

    const dOff = deps();
    await launchReview({ req, template: "t", workspaceDir: "/ws", seedAgent: false }, dOff);
    expect(dOff.openWorkspace.mock.calls[0][0].seedAgent).toBe(false);
  });

  it("refuses when createWorktrees falls back to the main checkout", async () => {
    // A stub that returns its input unchanged, exactly like createWorktrees's own
    // failure fallback (non-git repo, or `git worktree add` failing outright).
    const d = deps({ createWorktrees: vi.fn((services) => services) });
    const out = await launchReview({ req, template: "t", workspaceDir: "/ws", seedAgent: true }, d);
    expect(out).toEqual({
      ok: false,
      message: "Couldn't create a git worktree in aws-ops — not reviewing aws-ops#8491 in your main checkout. The Agent Flow Deck output channel has the reason.",
    });
    expect(d.openWorkspace).not.toHaveBeenCalled();
  });

  it("reports a failure from openWorkspace rather than throwing", async () => {
    const d = deps({ openWorkspace: vi.fn(async () => { throw new Error("disk full"); }) });
    const out = await launchReview({ req, template: "t", workspaceDir: "/ws", seedAgent: true }, d);
    expect(out).toEqual({ ok: false, message: "Couldn't open a review worktree for aws-ops#8491: Error: disk full" });
  });
});

describe("resolveReviewMode", () => {
  const backend: PromptMode = { id: "backend", label: "Backend services", prompt: "BE" };
  const frontend: PromptMode = { id: "frontend", label: "Frontend", prompt: "FE" };

  it("uses the mode the setting names, without asking", () => {
    expect(resolveReviewMode([backend, frontend], "frontend")).toBe(frontend);
  });

  it("asks when the setting is 'ask' and there is a real choice", () => {
    expect(resolveReviewMode([backend, frontend], "ask")).toBeNull();
  });

  it("asks when the setting names a mode that does not exist", () => {
    // A typo shows the picker rather than silently seeding a mode the user
    // didn't name — the same reason an unknown id isn't treated as the first one.
    expect(resolveReviewMode([backend, frontend], "backnd")).toBeNull();
  });

  it("never asks when there is only one mode, whatever the setting says", () => {
    // The one-mode short-circuit is what keeps a default install a single click.
    expect(resolveReviewMode([backend], "ask")).toBe(backend);
    expect(resolveReviewMode([backend], "nonsense")).toBe(backend);
    expect(resolveReviewMode([backend], "backend")).toBe(backend);
  });
});
