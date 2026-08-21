# Review several PRs with agents, in one gesture

**Date:** 2026-08-21
**Status:** design, approved in brainstorming
**Mockup:** `docs/mockups/2026-08-21-batch-review-with-agents.html` — local only (`docs/mockups/` is git-ignored). Everything it decided is restated below, so this spec stands on its own.

## What this adds

The Deck's review strip launches one agent on one PR. This adds the batch: select several
rows, answer two questions once, and get a reviewer per PR — either all in one window or a
window each.

Three parts:

1. **Selection in the strip** — a `select` affordance in the strip header that turns the
   caret column into checkboxes and raises a batch bar (mockup variant B).
2. **One batch launch** — the mode asked once for the whole batch, the destination asked
   once, and `openSharedWorkspace` doing the opening, exactly as `takeBatch` already does
   for tasks.
3. **A read-only review mode** — one that reads the PR at its own revision instead of
   checking it out, so several reviews can share a window and none of them can touch your
   working tree.

## Non-goals

- **No batch submit.** Approve / Comment / Request changes stay one row at a time, one
  confirmation at a time. A single click that posts four reviews to GitHub is the one thing
  here that should not exist.
- **No change to a single-row launch.** Clicking `▶ Review with agent` on one row must
  behave byte-identically, including *not* raising a picker on a stock install (see
  "Where the read-only mode lives").
- **No new settings.** The two knobs this needs already exist.
- **No diff-only mode** (the no-clone-needed variant). Deferred; see Follow-ups.
- **No retirement work.** A batch makes the flight-board pile-up more visible but does not
  cause it; see Follow-ups.

## Decisions taken

| Question | Decision |
| --- | --- |
| Selection affordance | Variant B — opt-in `select` in the strip header, plus shift-click ranges. Rows stay as dense as today until asked. |
| Big batches | Soft confirm, no hard cap — reuse `agentFlow.batchLaunchConfirmThreshold`. |
| Mode | Asked once for the whole batch. A pinned `agentFlow.reviewRequestMode` is honoured and skips the ask, exactly as a single launch does. |
| Un-cloned repos | Named once in the summary toast and skipped; the rest launch. |
| Entry points | The review strip only. |

One deliberate deviation: the answer was "confirm above 5", and
`batchLaunchConfirmThreshold` ships as 6 ("batches larger than this"). Reusing it means
the review batch confirms above 6 rather than above 5, and the user can set it to 5. One
threshold with one meaning beats a second setting one PR away from the first.

## Why this is small: the run key is already per-PR

A review run's key is `review-<repo>-<number>` (`reviewRunKey`) — one per PR. N selected
PRs are therefore N distinct runs with N distinct worktrees-or-not, and
`ReviewRequest.runKey` / `ReviewRequest.draftPath` stay singular. **No released type
changes, and the on-disk run shape frozen by `test/unit/compat.test.ts` is untouched.**

## Where the read-only mode lives, and why not in `reviewRequestModes`

The built-in Full review prompt runs `gh pr checkout` — a real checkout. That is the only
reason `launchReview` refuses to proceed without a worktree: without one it would switch
the user's own checkout to a teammate's branch. So "no worktree" is not a flag on the
existing mode; it is a mode that reads the PR instead of checking it out:

```
git fetch origin pull/<n>/head        # or the forge's equivalent ref
git diff <base>...<sha>               # the whole diff
git show <sha>:<path>                 # any file at the PR's own revision
```

The working tree is never written, so several of these can share one window — and the
user's main checkout is safe as a host.

**It must not be added to `DEFAULT_REVIEW_REQUEST_MODES`.** `resolveReviewMode` asks
whenever there is more than one mode and none is pinned, so a second built-in would raise
a QuickPick on every stock single-row launch. `test/unit/deckView.test.ts:3010` ("does not ask which mode to use when only the stock one is configured") asserts
that picker is *not* raised on a stock install — an existing test that would have to be
edited, which CLAUDE.md names as the signal to stop. It would also shift
`shippedReviewRequestModes`, which telemetry's `modeCounts` diffs against.

So the read-only mode is a built-in of the **batch** path:

```ts
// src/engine/review/batch.ts
export const READ_ONLY_REVIEW_MODE_ID = "read-only";

/** The read-only mode this forge SHIPS. Forge-flavoured for one reason only: the ref
 *  a PR lives on is spelled differently (`pull/N/head` vs `refs/merge-requests/N/head`).
 *  Same shape as `shippedReviewRequestModes`, and never added to it. */
export function readOnlyReviewMode(forge: string): PromptMode;

/** The modes a batch offers: the read-only built-in first, then whatever
 *  `reviewRequestModes` resolves to. A single-row launch never sees this list. */
export function batchReviewModes(modes: PromptMode[], forge: string): PromptMode[];
```

The prompt, GitHub wording (the GitLab one substitutes the fetch ref, `merge request`
for `pull request`, and `target branch` for `base branch` — the same substitution-only
relationship `GITLAB_REVIEW_REQUEST_PROMPT` already has with its GitHub twin):

```
Review pull request {url} — {repo}#{number}, "{summary}", by {author}.
Do NOT check the branch out — this repo may be someone's live checkout, and other
reviews may be running beside you. Fetch the PR's own commit instead:
`git fetch origin pull/{number}/head` gives you FETCH_HEAD, and
`git merge-base HEAD FETCH_HEAD` gives you its base. Read the diff with
`git diff <base>...FETCH_HEAD`, and read any file at the PR's own revision with
`git show FETCH_HEAD:<path>` — never from the working tree, which is on a different
commit. Assess correctness, edge cases, tests, and anything that would break in
production. Write your findings to `.pick-task/REVIEW-{number}.md` as a short
prioritised list — most serious first, each with the file and line it refers to. Do
not post anything to GitHub; the human submits the review.{files}
```

`detail`, shown under the label in the picker: *"Reads the PR without checking it out —
several can share one window. Can't run tests."*

Placeholder rendering stays two-stage, exactly as the single-row path: `{repo}`
`{number}` `{author}` are substituted per PR by `renderReviewTemplate` when the
`BatchTask` is built, and `{key}` `{summary}` `{url}` `{brief}` `{files}` by
`agentPrompt`/`renderPrompt` inside `openSharedWorkspace`. Neither stage sees the
other's placeholders.

A user who wants it per-row can add `{"id": "read-only", …}` to their own
`reviewRequestModes`; promoting it to a shipped built-in later is a one-line change, and
`maybeShowModesNotice` already exists to announce exactly that.

Two consequences the batch must state rather than hide:

- A **read-only** mode plus any destination needs no worktree at all.
- A **checkout** mode (Full review, or the user's own) plus a shared destination means each
  PR's worktree becomes a folder in that one window — which is precisely what
  `openSharedWorkspace` already does for a task batch. The destination picker therefore
  greys nothing out; the confirmation copy names which of the two is about to happen.

## Host-side changes

### 1. `BatchTask` gains three passthrough fields

`openSharedWorkspace` was written for tasks and hardcodes three things a review batch
needs to vary. All three are optional, so a task batch's behaviour and its plan/run bytes
are unchanged.

```ts
export interface BatchTask {
  …
  /** Written straight onto the Run record. Reviews pass "review"; absent means
   *  "task", exactly as today. */
  kind?: Run["kind"];
  /** Overrides the shared `promptTemplate` for this task only. Reviews pre-render
   *  {repo}/{number}/{author} per PR, which one shared template cannot carry. */
  promptTemplate?: string;
  /** Sub-directory under `.pick-task/` for this task's brief. Reviews pass
   *  `REVIEW-<n>`; absent keeps `.pick-task/TASK.md`. */
  briefSubdir?: string;
}
```

**`kind` is mandatory, not cosmetic.** `decorateReviews` finds a row's run with
`runKind(r) === "review"`. Without the passthrough, a batched review's run records as a
*task*: the strip would never show "reviewing", the draft would never be found, and — per
the comment on `Run.kind` in `types.ts` — a run keyed `review-aws-ops-8491` carrying a PR
url would be polled as if it were a Jira ticket.

**`briefSubdir` closes a real collision.** Brief paths are computed per *service*
(`path.join(s.path, BRIEF_DIR, BRIEF_FILE)`). With worktrees every PR has its own
directory, but a read-only batch shares one checkout — so two PRs in the same repo would
both write `.pick-task/TASK.md`, the second silently overwriting the first.
`.pick-task/REVIEW-<n>/TASK.md` cannot collide, and `ensureGitExcluded` already excludes
`.pick-task/` wholesale.

### 2. `src/engine/review/batch.ts` — new pure module

Logic only, no `vscode` and no fs, so it tests without an editor and stays importable from
either side:

- `batchReviewModes(modes, forge)` — the offered list (above).
- `needsWorktrees(mode)` — whether the chosen mode checks out. Derived from the mode, so
  the coupling is computed in one place rather than asked about.
- `planReviewBatch(requests, mode)` → `{ items: ReviewBatchItem[]; skipped: string[] }`.
  One item per reviewable PR — its run key (`reviewRunKey`), ticket
  `{ key, summary, url }`, the `promptTemplate` already rendered through
  `renderReviewTemplate`, `briefSubdir: "REVIEW-<n>"`, and the base `ServiceRef` its
  worktree would come from. PRs whose `localPath` is null go to `skipped`, deduped by
  repo name.
- `toBatchTask(item, services)` → `BatchTask`. **Split from `planReviewBatch` on purpose:**
  a `BatchTask` requires its `services`, and under a checkout mode those are worktrees that
  do not exist until step 6 — after the confirm, the mode and the destination have all been
  answered. Planning therefore stops one step short of a `BatchTask`, and the caller
  finishes each one with whatever `services` it ended up with (the worktree, or the plain
  checkout under a read-only mode). Nothing pure ever touches git.

### 3. `deckView.launchReviewBatch(ids)`

The order matters and mirrors `takeBatch`, including why each step precedes the next:

1. Resolve the rows (`reviewById`), drop any the queue has moved past.
2. `planReviewBatch` → tasks + skipped. Nothing selectable? Toast the reason, stop.
3. Confirm if `tasks.length > cfg.batchLaunchConfirmThreshold`, naming the cost — sessions,
   and worktrees when `needsWorktrees`.
4. Resolve the mode:
   `resolveReviewMode(batchReviewModes(cfg.reviewRequestModes, cfg.forge), cfg.reviewRequestMode)`
   or one QuickPick. Cancel = silence, no toast. This list always holds at least two modes
   (read-only plus the stock one), so an unpinned batch always asks — which is the intent:
   worktrees-or-not is the batch's one consequential choice.
5. Destination: the same four `SharedTarget`s the task batch offers. **The Deck has no
   destination picker today** — a review has always opened its own window — and
   `chooseOpenTarget` / its `OpenTarget` type are private to `tasksView.ts`. Extract both
   into a shared host-side module (`src/destination.ts`) and have both views call it, rather
   than mirroring the logic: it honours `agentFlow.openIn`, refuses "this window" when the
   window has no identity, and that behaviour must not fork. The extraction is
   move-only — a task batch's picker must resolve identically after it.
6. Services per PR: under a checkout mode, `createWorktrees` per PR — and a PR whose
   worktree could not be made is dropped from the batch with its reason, never downgraded
   into the main checkout (`launchReview`'s existing refusal, applied per PR). Under
   read-only, the checkout itself is the service and no worktree is made. Then
   `toBatchTask` for each survivor.
7. `openSharedWorkspace` once for a shared destination; `launchReview` per PR for
   "a window each".
8. One summary toast: how many launched, which repos were skipped and why, which agent was
   seeded. `refreshBusy()` so the rows show "reviewing".

### 4. Unchanged on purpose

`decorateReviews`, `reviewRunKey`, `launchReview`, the draft loader, and every write path
(`submitReview` and its gates) are untouched.

## Webview changes

`ReviewStrip.tsx` only, and it must stay free of any Node import
(`test/webview/webviewGraph.test.ts`) — the new module is host-side and pure, so nothing in
the strip imports it.

- New props: `selecting: boolean`, `selected: Set<string>` (or `string[]`),
  `onSelectMode(next)`, `onToggle(id)`, `onSelectAll()`, `onClearSelection()`,
  `onLaunchBatch()`.
- Header gains a `select` toggle beside `sort`, styled like the sort buttons.
- While selecting: `.rv-chk` replaces `.rv-caret`, a row click toggles instead of
  expanding, shift-click extends from the last toggled row.
- `.batch-bar` at the foot of the strip — count, Select all, Done, and the brand-filled
  launch button, mirroring `styles.ts`'s `.batch-bar` for the sidebar.
- The draft chip reads **review ready** rather than `draft`, and the header carries
  `N agent reviews ready` when more than one row has a draft.

New messages in `types.ts` (webview→host `deck:reviewBatch { ids }`; the existing
`deck:reviews` poll already carries everything the strip needs back). Message types are not
part of the frozen compat surface.

## Tests

Add to the existing files; nothing existing should need editing.

- `test/unit/engine/review/batch.test.ts` — `planReviewBatch` shapes one task per PR, skips
  and reports null-`localPath` rows, renders each PR's own placeholders, gives each PR its
  own `briefSubdir`; `batchReviewModes` puts read-only first and keeps the user's modes;
  `needsWorktrees` for a checkout mode vs read-only.
- `test/unit/engine/batchWorkspace.test.ts` — `kind` reaches the Run record;
  `promptTemplate` overrides per task while an absent one keeps the shared template;
  `briefSubdir` moves only that task's brief; **a task batch's plan and run bytes are
  unchanged** when all three are absent.
- `test/unit/deckView.test.ts` — the step order (confirm before mode before destination
  before worktrees), no worktrees created under read-only, a cancelled mode or destination
  creates nothing and says nothing, skipped repos named once, and a run written with
  `kind: "review"` so `decorateReviews` marks the row "reviewing".
- `test/webview/reviewStrip.test.ts` — select mode toggles rows instead of expanding,
  shift-click ranges, the bar's count, launch posts one message with every id. Assert with
  `waitFor`, never a bare tick.
- Coverage thresholds in `vitest.config.ts` are enforced; the new pure module should sit
  near 100%.

## Risks

- **`openSharedWorkspace` is load-bearing for task batches.** Every field added is optional
  and byte-identity for the task path is an explicit test, but this is the one file where a
  regression would be felt by every existing user.
- **A read-only prompt is a prompt, not a sandbox — the biggest risk here.** Under
  read-only there is no worktree, so the agent is working in a real checkout, possibly the
  user's live one, and nothing but the wording stops it from running `git checkout` and
  moving that branch. The worktree is the only thing that ever *enforced* this; that is
  what `launchReview` refuses without today. The design keeps the escape hatch explicit
  rather than hiding it: choosing a checkout mode brings worktrees back automatically
  (`needsWorktrees`), and the mode's `detail` says which one you are getting. Accepting
  this trade is what "worktrees aren't needed for a review" buys.
- **N sessions is N agents' worth of tokens.** The confirmation is the only brake, and it
  is off by default below 7.

## Follow-ups, not in this change

1. **Diff-only mode** (`gh pr diff` / `glab mr diff`) — needs no clone at all, so it makes
   the rows that are un-reviewable today reviewable, and gives the batch something better
   to do than skip them.
2. **Review-run retirement** — a review run whose draft was submitted, or whose PR has left
   the queue, should retire itself. Same shape as the notepad item about explore sessions
   lingering on the flight board.
3. **Promote read-only to a shipped mode** in `reviewRequestModes`, once it has proved
   itself, using `maybeShowModesNotice` to announce it.
