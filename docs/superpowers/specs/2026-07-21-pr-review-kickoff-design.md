# Design: PR-review kick-off button

**Date:** 2026-07-21
**Status:** Approved, implementing

## Summary

When a task is in a PR-related status (default **"PR initiated"**), show a
**"Review PR"** button on the sidebar task card, next to **Take**. Clicking it
kicks off a Claude Code agent — the same machinery as Take — inside a **git
worktree**. The agent finds the task's GitHub PR by its Jira key (all PRs are
prefixed `ASM-****`), checks out the PR's branch, and **assesses whether the PR
is ready for us to work on** (review comments, CI, merge conflicts, approval
state). By **default it then proceeds to implement the requested changes** on
that branch; a setting gates that fixing step.

Everything stays in the prompt layer: the extension chooses which prompt to seed
and forces a worktree. All GitHub work is done by the **agent** via its own `gh`
/ GitHub connector — no new GitHub or Jira-dev-status integration in the
extension. This matches the division of labor in the configurable-Explore-actions
design.

## Decisions

| Question | Decision |
|----------|----------|
| What does the agent do? | **Always assess** the PR; **by default then start fixing** on the PR branch. Gated by `agentFlow.prReviewAutoFix` (default `true`). Assess-only when off. |
| How does the agent find the PR? | Agent-driven. The extension seeds the Jira `{key}` and repos; the agent uses `gh` / the GitHub connector to find the PR (title/branch prefixed with the key), then `gh pr checkout`s its head branch inside the worktree. No PR URL is resolved by the extension. |
| When does the button appear? | On the sidebar task card when `task.status` matches `agentFlow.prReviewStatus` (default `"PR initiated"`, case-insensitive). Configurable string setting. |
| Where does it appear? | Sidebar task card only (next to Take). Not the Deck (v1). |
| Worktree? | **Always.** `reviewPr` ignores `agentFlow.worktree` and always calls `createWorktrees`, honoring "do this in a worktree". |
| New extension integration? | **None.** No GitHub/Jira-dev-status API calls, no PR URL resolution, no readiness pre-check, no auto-push/merge/transition. All agent-driven. |

## Approach rationale

- **Prompt-layer, reuse the `takeTask` pipeline.** `reviewPr` runs the same flow
  as Take (discover repos → infer/confirm services → choose open target → write
  brief → `openWorkspace(seedAgent: true)`), differing only in: force worktree,
  skip the prompt-mode picker, seed the PR-review prompt with the auto-fix clause
  toggled by the setting. Shared middle extracted into a private `launch()` core
  so the two entry points don't duplicate ~120 lines.
- **Agent-driven GitHub discovery is reliable here** because all PRs are prefixed
  with the Jira key (`ASM-****`). No need for extension-side GitHub integration,
  tokens, or Jira dev-status calls.
- **Configurable status string, not an enum.** Jira statuses are free-form,
  project-specific strings (there is no status enum in the codebase). A single
  string setting matched case-insensitively is robust across projects and renames.
  `"PR initiated"` is an `indeterminate`-category status, so it already appears in
  the `mysprint`/`sprint`/`mine` lenses and the button is reachable (`Done`-category
  tasks are filtered out server-side by the JQL lenses).
- **Settings-page-editable prompt.** `agentFlow.prReviewPrompt` is a `string` with
  `editPresentation: "multilineText"`, so it renders as a textarea in the Settings
  UI — same pattern as `explorePrompt`.

## Settings (`package.json` `contributes.configuration` + `config.ts`)

| Setting | Type | Default | Renders as |
|---------|------|---------|------------|
| `agentFlow.prReviewStatus` | string | `"PR initiated"` | Text field. Status name that reveals the button (case-insensitive match against `task.status`). |
| `agentFlow.prReviewAutoFix` | boolean | `true` | Checkbox. On = agent proceeds from assessment into implementing fixes; off = assess-and-report only. |
| `agentFlow.prReviewPrompt` | string, `multilineText` | default template below | Textarea. Seeded prompt. Placeholders `{key} {summary} {url} {brief} {files}` as elsewhere. |

`AgentFlowConfig` gains `prReviewStatus: string`, `prReviewAutoFix: boolean`,
`prReviewPrompt: string`.

## Default prompt (`config.ts` `DEFAULT_PR_REVIEW_PROMPT`)

Exact wording finalized in implementation; intent:

> This task's PR is open on GitHub — all our PRs carry the Jira key `{key}` in
> their title and branch. Using `gh` (or the GitHub tools available to you): find
> that PR, `gh pr checkout` its head branch into this worktree, then **assess
> whether it's ready for us to work on** — unresolved review comments / requested
> changes, CI status, merge conflicts, and approval state. Summarize what you find.
>
> *(auto-fix clause — included only when `prReviewAutoFix` is true:)* If it's
> ready, implement the requested changes on this branch so it's ready for me to
> review. Do not push or merge without me.
>
> `{files}`

The auto-fix clause is inserted just before the trailing `{files}` block when
`prReviewAutoFix` is true, and omitted otherwise — same append technique as the
Slack-DM sentence in the Explore-actions design.

## Behavior & flow (`tasksView`)

1. Webview renders **Review PR** on a card iff `isPrReviewStatus(task.status,
   cfg.prReviewStatus)`. Click → `send({ type: "reviewPr", key, services? })`
   (same optional-`services`-when-expanded logic as Take).
2. Host `onMessage` → `reviewPr(key, services?)`.
3. `reviewPr` reuses the Take pipeline via shared `launch()`:
   - auth gate → fetch detail → discover repos → resolve service set
     (preselected or infer + confirm) — unchanged.
   - **Always** `createWorktrees(services, key, summary, log)` (ignores
     `cfg.worktree`).
   - **No** prompt-mode picker; `promptTemplate` = assembled PR-review prompt.
   - choose open target → build brief → `openWorkspace({ ..., seedAgent: true })`.
   - success toast.

## Surfaces (types, functions)

- `types.ts`: new `InboundMessage` member `{ type: "reviewPr"; key: string;
  services?: string[] }`. `state` outbound message carries `prReviewStatus` so the
  webview can gate the button.
- `config.ts`: `DEFAULT_PR_REVIEW_PROMPT` constant; `prReviewStatus`,
  `prReviewAutoFix`, `prReviewPrompt` on `AgentFlowConfig` + getters.
- `tasksView.ts`: `reviewPr()` + shared `launch()` core extracted from `takeTask`;
  PR-review prompt assembly (auto-fix clause). `onMessage` case.
- `webview/helpers.ts`: `isPrReviewStatus(status, configured)` (case-insensitive
  equals; empty/undefined → false).
- `webview/App.tsx`: Review PR button in `card-actions`, gated on
  `isPrReviewStatus`. `PrReviewIcon`.

## Testing

- `config.test.ts`: the three settings resolve with correct defaults; non-boolean
  `prReviewAutoFix` ignored (defaults true); custom `prReviewStatus` honored.
- `tasksView.test.ts`: `reviewPr` forces `createWorktrees` even when
  `cfg.worktree === "never"`; seeds the PR-review template (not a prompt mode);
  auto-fix clause present iff `prReviewAutoFix`; cancelling the open-target picker
  aborts before touching the workspace.
- `helpers.test.ts`: `isPrReviewStatus` — exact case-insensitive match true;
  different status false; empty configured/status false.
- `App.test.tsx`: Review PR button rendered iff status matches configured
  `prReviewStatus`; click posts `{ type: "reviewPr", key }`.

## Non-goals (YAGNI)

- No extension-side GitHub or Jira-dev-status calls; no PR URL resolution; no
  readiness pre-check — all agent-driven.
- No auto-push / auto-merge / ticket transition by the extension.
- No Deck button (sidebar card only for v1).
- No status enum — statuses stay free-form strings.
