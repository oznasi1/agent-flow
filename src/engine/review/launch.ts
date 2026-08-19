import { PromptMode, ReviewRequest, ServiceRef } from "../../types";
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

/** The review mode to seed without asking, or null when the user must pick.
 * Two ways to skip the picker: `configured` names a real mode, or there is only
 * one mode to offer — a QuickPick with a single item is friction, not a choice.
 * An id that matches nothing falls through to the picker rather than to the
 * first mode: a typo should ask, not quietly seed a prompt nobody named.
 * `modes` is never empty; getConfig guarantees that. */
export function resolveReviewMode(modes: PromptMode[], configured: string): PromptMode | null {
  const pinned = modes.find((m) => m.id === configured);
  if (pinned) return pinned;
  return modes.length === 1 ? modes[0] : null;
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
    // Forge-neutral wording, and routinely reached on either forge: a request for
    // your review may live in a project you have never cloned, which is exactly
    // when `localPath` is null. Naming GitHub here sent a GitLab user to the wrong
    // site; the row's own link already knows where the request lives.
    return { ok: false, message: `${req.repoName} isn't checked out under your repos root — open it in your browser instead.` };
  }
  const key = reviewRunKey(req.repoName, req.number);
  const summary = `Review ${req.repoName}#${req.number}: ${req.title}`;
  const base: ServiceRef = { name: req.repoName, path: req.localPath, isGit: true };
  // createWorktrees slugs its own third argument onto `key` for the branch name
  // (branchName(key, summary) = `${key}-${slug(summary)}`). `summary` above
  // already starts with "Review <repoName>#<number>: …", which itself slugifies
  // to start with `key` — passing it here doubled the key into every branch
  // name (`review-aws-ops-8491-review-aws-ops-8491-…`). The PR title alone is
  // what should seed the slug.
  const services = deps.createWorktrees([base], key, req.title, deps.log);
  // createWorktrees falls back to the main checkout when it cannot create a worktree.
  // For an ordinary task that is merely inconvenient; here the seeded prompt scripts a
  // real checkout of the request's branch (`gh pr checkout` / `glab mr checkout`,
  // depending on the configured forge), so proceeding would switch the user's OWN
  // checkout to a teammate's branch. Refuse: an un-launched review costs a click, a
  // hijacked checkout can cost work in progress.
  if (services.some((s) => s.path === base.path)) {
    return { ok: false, message: `Couldn't create a git worktree in ${req.repoName} — not reviewing ${req.repoName}#${req.number} in your main checkout. The Agent Flow Deck output channel has the reason.` };
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
