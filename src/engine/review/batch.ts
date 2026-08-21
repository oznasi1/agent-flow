import type { PromptMode } from "../../types";

/** The batch-only read-only mode's id. Deliberately NOT in
 *  `DEFAULT_REVIEW_REQUEST_MODES`: a second shipped mode would make
 *  `resolveReviewMode` raise a picker on every stock single-row launch, which
 *  `test/unit/deckView.test.ts` asserts never happens. A user who wants it per-row
 *  can declare this id in their own `agentFlow.reviewRequestModes`. */
export const READ_ONLY_REVIEW_MODE_ID = "read-only";

/** GitHub wording. `{repo}` `{number}` `{author}` are substituted per PR by
 *  `renderReviewTemplate`; `{key}` `{summary}` `{url}` `{brief}` `{files}` later, by
 *  `renderPrompt` inside the launch — the same two stages the single-row path uses. */
const READ_ONLY_GITHUB_PROMPT =
  'Review pull request {url} — {repo}#{number}, "{summary}", by {author}. ' +
  "Do NOT check the branch out — this repo may be someone's live checkout, and other reviews may be running beside you. " +
  "Fetch the PR's own commit instead: `git fetch origin pull/{number}/head` gives you FETCH_HEAD, and " +
  "`git merge-base HEAD FETCH_HEAD` gives you its base. Read the diff with `git diff <base>...FETCH_HEAD`, and read any " +
  "file at the PR's own revision with `git show FETCH_HEAD:<path>` — never from the working tree, which is on a different commit. " +
  "Assess correctness, edge cases, tests, and anything that would break in production. " +
  "Write your findings to `.pick-task/REVIEW-{number}.md` as a short prioritised list — most serious first, " +
  "each with the file and line it refers to. Do not post anything to GitHub; the human submits the review.{files}";

/** The GitLab wording: substitution-only, exactly the relationship
 *  `GITLAB_REVIEW_REQUEST_PROMPT` already has with its GitHub twin. Three
 *  substitutions — the ref a merge request lives on, "merge request" for "pull
 *  request", and GitLab's own "target branch" for "base branch". `{repo}#{number}`
 *  is left alone for the same reason: `GITLAB_REVIEW_REQUEST_PROMPT` spells a
 *  merge request that way too, and a lone `!` here would make the two shipped
 *  GitLab prompts disagree about how GitLab names things. */
const READ_ONLY_GITLAB_PROMPT =
  'Review merge request {url} — {repo}#{number}, "{summary}", by {author}. ' +
  "Do NOT check the branch out — this repo may be someone's live checkout, and other reviews may be running beside you. " +
  "Fetch the merge request's own commit instead: `git fetch origin refs/merge-requests/{number}/head` gives you FETCH_HEAD, and " +
  "`git merge-base HEAD FETCH_HEAD` gives you its target branch point. Read the diff with `git diff <target>...FETCH_HEAD`, and read any " +
  "file at the merge request's own revision with `git show FETCH_HEAD:<path>` — never from the working tree, which is on a different commit. " +
  "Assess correctness, edge cases, tests, and anything that would break in production. " +
  "Write your findings to `.pick-task/REVIEW-{number}.md` as a short prioritised list — most serious first, " +
  "each with the file and line it refers to. Do not post anything to GitLab; the human submits the review.{files}";

/** The read-only mode this forge SHIPS. Forge-flavoured for one reason only: the ref
 *  a request lives on is spelled differently. Same shape as
 *  `shippedReviewRequestModes`, and never added to it. */
export function readOnlyReviewMode(forge: string): PromptMode {
  return {
    id: READ_ONLY_REVIEW_MODE_ID,
    label: "Read-only review",
    detail: "Reads the PR without checking it out — several can share one window. Can't run tests.",
    prompt: forge === "gitlab" ? READ_ONLY_GITLAB_PROMPT : READ_ONLY_GITHUB_PROMPT,
  };
}

/** The modes a batch offers: read-only first, then whatever `reviewRequestModes`
 *  resolved to. A single-row launch never sees this list. A user who already declared
 *  the `read-only` id keeps their own entry, in their own position — this adds a mode,
 *  it never overrides one. */
export function batchReviewModes(modes: PromptMode[], forge: string): PromptMode[] {
  if (modes.some((m) => m.id === READ_ONLY_REVIEW_MODE_ID)) return modes;
  return [readOnlyReviewMode(forge), ...modes];
}

/** Whether this mode's prompt checks the branch out, and therefore needs a worktree.
 *  Keyed on the id rather than sniffing the prompt text: the id is a contract, a
 *  substring match is a guess. Anything that is not the read-only mode gets the safe
 *  answer, because the worktree is the only thing that actually PREVENTS a checkout
 *  from landing in the user's own tree. */
export function needsWorktrees(mode: PromptMode): boolean {
  return mode.id !== READ_ONLY_REVIEW_MODE_ID;
}
