import { ReviewRequest, ServiceRef } from "../../types";
import type { OpenRequest, OpenResult } from "../workspace";

/** A review's synthetic run key, and therefore its worktree directory name under
 * `<repo>/.claude/worktrees/`. Mirrors `explore-<slug>`: not a Jira key, and never
 * mistaken for one. */
export function reviewRunKey(repoName: string, number: number): string {
  const slug = repoName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `review-${slug}-${number}`;
}

/** Fill the review-only placeholders. `renderPrompt` handles {key} {summary}
 * {url} {brief} {files} later, inside openWorkspace — doing these here keeps
 * the shared prompt renderer unaware of a concept only this flow has. */
export function renderReviewTemplate(
  template: string,
  v: { repo: string; number: number; author: string },
): string {
  return template
    .replace(/\{repo\}/g, () => v.repo)
    .replace(/\{number\}/g, () => String(v.number))
    .replace(/\{author\}/g, () => v.author);
}

export interface LaunchReviewRequest {
  req: ReviewRequest;
  template: string;
  workspaceDir: string;
  seedAgent: boolean;
}

export interface LaunchReviewDeps {
  createWorktrees: (services: ServiceRef[], key: string, summary: string, log: (m: string) => void) => ServiceRef[];
  openWorkspace: (req: OpenRequest) => Promise<OpenResult>;
  log: (m: string) => void;
}

/** Open a teammate's PR in its own worktree with a review agent seeded. Always a
 * worktree and always one window: a review is a side errand, and it must not
 * disturb whatever the main checkout is in the middle of. */
export async function launchReview(
  { req, template, workspaceDir, seedAgent }: LaunchReviewRequest,
  deps: LaunchReviewDeps,
): Promise<{ ok: true; runKey: string } | { ok: false; message: string }> {
  if (!req.localPath) {
    return { ok: false, message: `${req.repoName} isn't checked out under your repos root — open the PR on GitHub instead.` };
  }
  const key = reviewRunKey(req.repoName, req.number);
  const summary = `Review ${req.repoName}#${req.number}: ${req.title}`;
  const base: ServiceRef = { name: req.repoName, path: req.localPath, isGit: true };
  const services = deps.createWorktrees([base], key, summary, deps.log);
  // createWorktrees falls back to the main checkout when it cannot create a worktree.
  // For an ordinary task that is merely inconvenient; here the seeded prompt scripts a
  // real `gh pr checkout`, so proceeding would switch the user's OWN checkout to a
  // teammate's branch. Refuse: an un-launched review costs a click, a hijacked checkout
  // can cost work in progress.
  if (services.some((s) => s.path === base.path)) {
    return { ok: false, message: `Couldn't create a git worktree in ${req.repoName} — not reviewing ${req.repoName}#${req.number} in your main checkout. The Agent Flow output channel has the reason.` };
  }
  try {
    await deps.openWorkspace({
      ticket: { key, summary, url: req.url },
      kind: "review",
      planMd: `## Review: ${req.repo}#${req.number}\n\n${req.title}\n\nOpened by @${req.author}. ${req.url}`,
      descriptionText: "",
      services,
      mode: "per-window",
      promptTemplate: renderReviewTemplate(template, { repo: req.repo, number: req.number, author: req.author }),
      workspaceDir,
      seedAgent,
    });
  } catch (e) {
    return { ok: false, message: `Couldn't open a review worktree for ${req.repoName}#${req.number}: ${e}` };
  }
  return { ok: true, runKey: key };
}
