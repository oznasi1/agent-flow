import { PromptMode, ReviewRequest, ServiceRef } from "../../types";
import type { OpenRequest, OpenResult } from "../workspace";
import type { OpenArgs } from "../openTarget";

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
  /** Where the session lands, already resolved by the caller from
   *  `agentFlow.reviewOpenIn` (engine/openTarget). Absent means what every release
   *  before it did: a new window on the review worktree. The worktree is NOT optional
   *  either way — only the window is. */
  openTarget?: OpenArgs;
}

export interface LaunchReviewDeps {
  createWorktrees: (services: ServiceRef[], key: string, summary: string, log: (m: string) => void) => ServiceRef[];
  openWorkspace: (req: OpenRequest) => Promise<OpenResult>;
  log: (m: string) => void;
}

/** What a review launch answers with. Three cases, not two: a dismissed `ask` picker
 *  is neither a success nor a failure. Giving it its own arm — rather than a
 *  `{ ok: false }` carrying an empty message — is what lets the caller stay SILENT
 *  about it; a message field, empty or not, is something the Deck would have to decide
 *  whether to show, and every wrong answer to that reports the user's own Escape key
 *  as something going wrong.
 *
 *  `provider` on the success arm is the agent that was actually seeded, straight off
 *  `OpenResult`. The caller's toast names it: under `ask` the setting names nobody, so
 *  this is the only place the answer exists. Typed through `OpenResult` so this module
 *  keeps its distance from `config.ts` (which imports `vscode`). */
export type LaunchReviewResult =
  | { ok: true; runKey: string; provider: OpenResult["provider"]; seededInPlace?: true }
  | { ok: false; cancelled: true }
  | { ok: false; message: string };

/** Open a teammate's PR in its own worktree with a review agent seeded. Always a
 * worktree — a review is a side errand, and it must not disturb whatever the main
 * checkout is in the middle of — but not always its own window: `openTarget` can send
 * the session to this window or one already open instead. */
export async function launchReview(
  { req, template, workspaceDir, seedAgent, openTarget }: LaunchReviewRequest,
  deps: LaunchReviewDeps,
): Promise<LaunchReviewResult> {
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
  // A destination other than a new window means the seeded session's cwd is NOT the
  // worktree — it is whatever the destination window is rooted on, which for "this
  // window" is typically the user's own main checkout. The shipped prompts are
  // cwd-relative (`gh pr checkout {number}` / `glab mr checkout {number}`), so landing
  // one there unnamed is the same branch hijack the refusal above exists to prevent.
  // Prefixed rather than appended, and prefixed onto the RENDERED template so a user's
  // own reviewRequestModes prompt gets the same guarantee without being rewritten.
  const landsElsewhere =
    !!openTarget && (openTarget.openIn === "current" || !!openTarget.existingFolder || !!openTarget.existingWorkspaceFile);
  const rendered = renderReviewTemplate(template, { repo: req.repo, number: req.number, author: req.author });
  const promptTemplate = landsElsewhere
    ? `Work in \`${services[0].path}\` — the git worktree made for this review. Run every command below there.\n\n${rendered}`
    : rendered;
  let result: OpenResult;
  try {
    result = await deps.openWorkspace({
      ticket: { key, summary, url: req.url },
      kind: "review",
      planMd: `## Review: ${req.repo}#${req.number}\n\n${req.title}\n\nOpened by @${req.author}. ${req.url}`,
      descriptionText: "",
      services,
      mode: openTarget?.mode ?? "per-window",
      promptTemplate,
      workspaceDir,
      seedAgent,
      openIn: openTarget?.openIn,
      currentWindow: openTarget?.currentWindow,
      existingFolder: openTarget?.existingFolder,
      existingWorkspaceFile: openTarget?.existingWorkspaceFile,
      // Deliberately no `foldersToAdd`: a review's worktree is throwaway, and a saved
      // .code-workspace is the user's own artifact. Absent leaves that file
      // byte-identical (see OpenRequest.foldersToAdd).
      //
      // The review's brief lives in the worktree and is named absolutely, so a
      // destination window that belongs to other work keeps the brief its own agent is
      // reading — see the absoluteBrief arm in engine/workspace.
      absoluteBrief: true,
    });
  } catch (e) {
    return { ok: false, message: `Couldn't open a review worktree for ${req.repoName}#${req.number}: ${e}` };
  }
  // The user dismissed the agent picker. openWorkspace resolves it before anything is
  // created, so there is no window, no brief and no plan to report on — and no run
  // either, which is why this returns before the runKey the caller would go looking
  // for one with. The worktree above is already made; that is the existing cost of
  // this path's ordering (createWorktrees comes first by design, so a `gh pr checkout`
  // can never land in the main checkout) and a retry reuses it.
  if (result.cancelled) return { ok: false, cancelled: true };
  // Present only when it happened: the caller's toast has to say so (no window opens on
  // that path, so silence reads as nothing having happened), and an always-present
  // `false` would make every other launch answer a question it wasn't asked.
  return { ok: true, runKey: key, provider: result.provider, ...(result.seededInPlace ? { seededInPlace: true } : {}) };
}
