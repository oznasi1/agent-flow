# E2E coverage matrix

Every behaviour the docs claim, and what proves it. `test/unit/e2eCoverage.test.ts`
checks this file both ways: every `e2e:` proof names exactly one `test("…")` title in
`test-e2e/*.e2e.ts` (substring match, the same contract `sabotage/*.expect` uses), and
every E2E title is cited here. `ct:`/`unit:` proofs must exist on disk. `untestable:`
states why the real-host harness cannot honestly prove the claim. Every `agentFlow.*`
setting in the manifest must be named by some row.

Proof grammar: `e2e: <title substring>` · `ct: <path>` · `unit: <path>` · `untestable: <reason>`.

## Backfill in progress

Rows marked `todo` are being written under docs/superpowers/plans/2026-09-03-e2e-doc-coverage.md.
This heading — and every `todo` — is removed in that plan's last task.

## Sidebar / Tasks

| id | doc | claim | proof |
|----|-----|-------|-------|
| `sidebar-two-tabs` | GUIDE § What it does | The sidebar panel has two tabs, Tasks and Notepad; the project key and your name live in the view title bar | todo |
| `sidebar-window-gauge` | GUIDE § What it does | The open-window gauge sits at the end of the tab row | todo |
| `sidebar-explore-button` | GUIDE § What it does | Explore sits at the end of the tab row beside the gauge | todo |
| `task-pool-filter-lenses` | GUIDE § What it does | The pool renders the filter tabs My sprint · Unassigned · Mine · Sprint · Backlog, but only those the connector declares in `caps.supportedFilters` (the fixture connector shows no Unassigned, Sprint or Backlog) | e2e: only the lenses the connector declares render |
| `task-default-filter` | SETTINGS § table | `agentFlow.defaultFilter` picks the lens the panel opens on (`unassigned`, `mysprint`, `mine`, `sprint`, `backlog`) | e2e: defaultFilter picks the lens the panel opens on |
| `task-size-lens` | GUIDE § What it does | A size lens (S/M/L by original estimate, an 8-hour workday) renders only when the connector has estimates and `agentFlow.filters.size` is on | e2e: the size lens renders only when the connector has estimates |
| `task-status-lens` | GUIDE § What it does | The status chip row renders, and `agentFlow.filters.status: false` hides it | e2e: filters.status false hides the status lens |
| `task-repo-search` | GUIDE § What it does | The repo multiselect narrows the pool to tasks inferred onto that repo; `agentFlow.filters.repo: false` hides it | e2e: the repo lens narrows the pool to tasks inferred onto that repo |
| `task-title-search` | README § Tasks — the pool | The fuzzy title search narrows the pool (a misspelt title still matches); `agentFlow.filters.search: false` hides the box | e2e: title search narrows the pool fuzzily |
| `task-card-detail` | README § Tasks — the pool | Clicking a card opens its detail panel with the ticket's description | e2e: the detail panel renders the task's description |
| `task-detail-fetch-failure` | CONNECTORS § 2. `TaskProvider` | A task whose detail cannot be fetched shows an error toast, not a blank panel, and the card stays in the pool | e2e: a task whose detail cannot be fetched shows a toast, not a blank panel |
| `task-repo-chips-inference` | README § Tasks — the pool | The repos a ticket touches are pre-selected from its components, labels and text matched against local checkouts | todo |
| `task-component-push` | CONNECTORS § 3. The capability table | A repo chip not on the ticket is dashed with a `↑` that pushes it as a component; the delta the picker produced is what gets written | e2e: records the delta the picker produced |
| `task-take` | README § Tasks — the pool | Take writes a `.pick-task/TASK.md` brief into each repo, opens a window, and lands the plan handshake | e2e: lands the brief + plan handshake on disk |
| `task-change-status` | GUIDE § What it does | Changing a card's status records the transition through the connector | e2e: records the transition and the claude-code provenance label |
| `task-status-zero-targets` | CONNECTORS § 2. `TaskProvider` | Zero status targets is an info toast ("No status transitions available for {key}"), not an error | e2e: zero status targets is an info toast, not an error |
| `task-status-field-prompt` | CONNECTORS § 2. `TaskProvider` | A status target with a `fields` entry prompts for it and sends the value in `moveTo.values` | e2e: a status target with a field prompts for it and sends the value |
| `task-status-field-retry` | CONNECTORS § 2. `TaskProvider` | A `TaskWriteError` with `retryWith` re-prompts only the field it names, and the second attempt carries the answer | e2e: a rejected write re-prompts only the field it names |
| `task-provenance-label` | GUIDE § What it does | A status change stamps the provenance label (default `claude-code`) when `agentFlow.stampLabelOnWrite` is on | e2e: changing a card's status records the transition and the claude-code provenance label |
| `task-provenance-custom-label` | SETTINGS § table | `agentFlow.provenanceLabel` names the label that is stamped (`set-stamp-label-on-write` covers switching the stamp off) | e2e: provenanceLabel names the label that is stamped |
| `task-assign-to-me` | CONNECTORS § 2. `TaskProvider` | Add to my sprint assigns the task to you first; a connector with no assignment concept accepts the call and does nothing | todo |
| `task-add-to-my-sprint` | CONNECTORS § 3. The capability table | Add to my sprint records `addToSprint` and stamps the provenance label | e2e: records addToSprint and stamps the provenance label |
| `task-add-to-my-sprint-assigned-elsewhere` | CONNECTORS § 3. The capability table | Add to my sprint is absent on a task assigned to someone else | e2e: Add to my sprint is absent on a task assigned to someone else |
| `task-add-to-sprint-name-only-identity` | CONNECTORS § 2. `TaskProvider` | A `me()` with `id: ""` refuses the sprint write with "Couldn't resolve your {label} account." and writes nothing | e2e: a name-only identity refuses the sprint write and says so |
| `task-remove-from-sprint` | CONNECTORS § 3. The capability table | Remove from sprint records `removeFromSprint` | e2e: records removeFromSprint |
| `task-remove-from-sprint-undo` | CONNECTORS § 3. The capability table | Remove from sprint offers Undo in a native notification; Undo re-adds through `addToSprint` and the card comes back | e2e: Remove from sprint offers Undo, and Undo puts the card back |
| `task-my-sprint-reorder` | CONNECTORS § 3. The capability table | Dragging in the My sprint lens reorders the pool, and the order survives a refresh | e2e: reordering the pool survives a refresh |
| `task-reset-order` | GUIDE § What it does | Reset order restores the source order | e2e: reset restores source order |
| `task-address-pr-sidebar` | GUIDE § What it does | The sidebar's Address PR button appears when the task reaches `agentFlow.prReviewStatus` (case-insensitive) and kicks off a session in a fresh worktree | e2e: seeds the PR-review prompt in a forced worktree |
| `task-address-pr-sidebar-gate` | GUIDE § What it does | The sidebar's Address PR button is present only while the task's status equals `agentFlow.prReviewStatus` compared case-insensitively (`to do` matches `To Do`), and is absent from every card on a non-matching status | e2e: Address PR appears only when the status matches prReviewStatus |
| `task-address-pr-behaviour` | GUIDE § What it does | The Address PR session is told to find the PR by Jira key, check out its branch, assess readiness and, with `agentFlow.prReviewAutoFix` on, implement the changes | e2e: Address PR seeds the PR-review prompt |
| `task-address-pr-assess-only` | SETTINGS § table | `agentFlow.prReviewAutoFix: false` seeds an assess-only prompt — the shipped assess wording without the implement clause | e2e: prReviewAutoFix off seeds an assess-only prompt |
| `task-address-pr-custom-prompt` | SETTINGS § table | A custom `agentFlow.prReviewPrompt` is what gets seeded, placeholders substituted, in place of the shipped default | e2e: a custom prReviewPrompt is what gets seeded |
| `task-launch-in-parallel` | GUIDE § What it does | Ticking several cards and Launch in parallel gives every task its own git worktree and branch, one window per task by default | e2e: opens a window per task, each in its own worktree |
| `task-launch-in-parallel-shared-window` | GUIDE § What it does | The one-shared-window layout stacks every task's worktree in one window with a session seeded per task, in the order picked | e2e: a shared-window batch stacks every task |
| `task-launch-in-parallel-no-repo` | GUIDE § What it does | A task touching none of the filtered repos launches in all of them, so no task launches with no repo | e2e: touching none of the filtered repos launches in all of them |
| `task-launch-in-parallel-threshold` | GUIDE § What it does | Batches larger than `agentFlow.batchLaunchConfirmThreshold` (default 6) confirm first | e2e: a batch larger than the threshold asks first |
| `task-explore` | GUIDE § What it does | Explore asks where to open and which repos, then launches and lands a plan file | e2e: Explore launches and lands a plan file |
| `task-explore-actions` | SETTINGS § table | Explore offers six kinds: Open a Jira ticket, Enhance knowledge / flow, Debug, General, Supervise running tasks, Verify on an environment; `agentFlow.exploreMode` pins one and `agentFlow.explorePrompts.*` edits each prompt | e2e: Explore offers the six documented session kinds |
| `explore-verify-environment` | SETTINGS § table | Verify asks which environment from `agentFlow.environments` plus Custom…, and seeds a read-only prompt that inspects logs, metrics, traces and deployed version there | e2e: a verify session is seeded read-only against the chosen environment |
| `prompt-modes` | SETTINGS § table | Taking a task asks how the session should start — Plan first, Implementation, Test-driven, Investigate & root-cause, Orchestrator, Refine the ticket; `agentFlow.promptModes` layers over the built-ins (reuse an `id` to override, `hidden: true` to drop one) and `agentFlow.taskMode` pins one | e2e: listing the six built-in modes |
| `prompt-modes-hidden` | SETTINGS § table | A `promptModes` entry with `hidden: true` drops that built-in from the picker; the other five remain | e2e: a hidden prompt mode is dropped |
| `per-task-worktrees` | SETTINGS § table | Worktree mode takes the task in a real git worktree at `.claude/worktrees/<KEY>` on a per-task branch, git-excluded automatically | e2e: in a real git worktree on a per-task branch |
| `per-task-worktrees-ask` | SETTINGS § table | `agentFlow.worktree: "ask"` offers the choice per take | e2e: worktree "ask" offers the choice |
| `remote-control` | SETTINGS § Remote Control | With `agentFlow.remoteControl` on, the panel is pre-filled with `/remote-control <KEY>` and the task prompt goes to the clipboard; a per-window multi-repo take and any shared-window launch skip it with a toast saying so | e2e: pre-fills the slash command and puts the prompt on the clipboard |
| `remote-control-copilot` | SETTINGS § Remote Control | Under Copilot, `remoteControl: on` refuses the launch with an error toast before any worktree or window exists; `ask` simply skips the picker | e2e: refuses the launch before any worktree exists |
| `remote-control-multi-window-skip` | SETTINGS § Remote Control | A per-window Take across several repos keeps the normal single-Enter seeding — the prompt, not `/remote-control`, lands in each window — and the toast says Remote Control was skipped | e2e: skipped for a multi-repo per-window take and the toast says so |

## Notepad

| id | doc | claim | proof |
|----|-----|-------|-------|
| `notepad-list` | GUIDE § The Notepad | The Notepad is a plain list of notes: title, optional detail, checkbox | e2e: a note added in one view |
| `notepad-global-storage` | GUIDE § The Notepad | Notes live in the editor's global state, so the list survives the view being rebuilt and follows you between repos | e2e: still there after the view is rebuilt |
| `notepad-add-note` | GUIDE § The Notepad | Add note creates a note from the title and detail fields | e2e: a note added in one view is still there |
| `notepad-start` | GUIDE § The Notepad | Start launches a session from a note like Explore does, writes a `## Notepad:` brief and lands a plan file; the note stays in the list | e2e: running a note seeds a session and lands a plan file |
| `notepad-run-badges` | GUIDE § The Notepad | The run lands on the Deck and the note grows a badge: Running while a session is attached, Stale once nothing is, Finished when the Deck records it landed | unit: test/unit/notepad.test.ts |
| `notepad-rerun-replaces` | GUIDE § The Notepad | Re-running a note replaces that note's previous run record rather than piling up a second | todo |
| `notepad-images` | GUIDE § The Notepad | An image pasted or dropped onto a note renders a thumbnail; PNG, JPEG, GIF and WebP up to 10 MB each, an oversize one refused | todo |
| `notepad-images-attach-picker` | GUIDE § The Notepad | Attach image opens the OS file picker beside Add note and in a note's edit form | untestable: native OS dialog |
| `notepad-images-copied-to-brief` | GUIDE § The Notepad | Start copies attachments into `.pick-task/images/<run key>/` beside the brief and names them in the brief and the seeded prompt | unit: test/unit/engine/workspace.test.ts |
| `notepad-drag-order` | GUIDE § The Notepad | Each note has a grip; dragging it puts the list in your order, which persists across reloads and holds under every filter | e2e: a note can be dragged to a new position |
| `notepad-drag-selectable` | GUIDE § The Notepad | A note body is still text-selectable after its row was dragged | e2e: still selectable after its row was dragged |
| `notepad-reset-order` | GUIDE § The Notepad | Reset order appears only once you have dragged something, and puts the list back to newest-first | todo |
| `notepad-filter` | GUIDE § The Notepad | The list opens on Active; All and Done are a click away and filter by the checkbox | todo |
| `notepad-clear-completed` | GUIDE § The Notepad | Clear completed removes every checked note in one action and only appears when there is something to clear | e2e: removes only the done note |
| `notepad-done-checkbox` | GUIDE § The Notepad | The checkbox toggles a note done | e2e: toggling done and clearing completed |
| `notepad-edit-delete` | GUIDE § The Notepad | The quiet edit and delete icons beneath Start save a new title or remove the note | todo |
| `notepad-os-dictation` | GUIDE § The Notepad | The fields are ordinary inputs, so the OS's own dictation types into them; there is no microphone button of its own | untestable: OS dictation |
| `notepad-sections` | GUIDE § The Notepad | Sections can be added and renamed | e2e: sections can be added and renamed |
| `notepad-retire-in-place` | SETTINGS § table | `agentFlow.retireInPlaceAfterHours` (default 0) removes a finished Explore or Notepad card as soon as its session closes, since it ran in the checkout rather than a worktree | unit: test/unit/engine/retire.test.ts |

## Deck

| id | doc | claim | proof |
|----|-----|-------|-------|
| `deck-open` | GUIDE § The Deck | "Open the Deck (in-flight)" opens the board of everything launched | e2e: swept off the board and out of the store |
| `deck-four-columns` | GUIDE § The Deck | Four columns — In progress · Action required · In review · Merge — attention rising left to right | e2e: header tiles count what the columns hold |
| `deck-header-count-tiles` | GUIDE § The Deck | Four header tiles count what the columns hold | e2e: header tiles count what the columns hold |
| `deck-column-hues` | GUIDE § The Deck | Each column carries its own hue in its dot, header rule and tint; cards are monochrome except in Action required, which carries an orange rail | ct: test-ct/Workflow.hues.spec.tsx |
| `deck-merge-lanes` | GUIDE § The Deck | Merge is split into `ready to merge` (approved, mergeable, green) and `merged · wrap up` lanes; only a merged PR makes a card say merged | unit: test/unit/engine/bucket.test.ts |
| `deck-recently-closed` | GUIDE § The Deck | A ticket closed with nothing merged drops into the collapsed Recently closed strip under the board | e2e: a closed run collapses into the Recently closed strip |
| `deck-live-signal` | GUIDE § The Deck | A card reads `working · Ns ago`, `idle`, `ended turn` or `parked` from Claude Code's own transcripts | e2e: a session mid-work reads working |
| `deck-live-signal-parked` | GUIDE § The Deck | `parked` only when the transcript cannot be read or does not exist — the one route back to the git + Jira backbone; the session itself is still on the card | e2e: a run with no transcript reads parked |
| `deck-action-required-semantics` | GUIDE § The Deck | Action required is session signals only — a session that ended its turn, stalled or exited — so Claude's asking and GitHub's asking stay under separate headers | e2e: a session that ended its turn lands the card in Action required |
| `deck-ended-turn-parks` | GUIDE § The Deck | An ended turn reads `ended turn` and parks in In progress's `parked` lane, NOT Action required, which admits only `blocked` and `exited` (`deriveBucket`) — the row above pins the stale doc sentence with `test.fail` | e2e: an ended turn reads ended turn and parks |
| `deck-fixes-needed-lane` | GUIDE § The Deck | A PR with failing required checks, requested changes or a conflict pulls its card into In review's `fixes needed` lane even while the session is still working | e2e: failing required checks pull a working session into fixes needed |
| `deck-open-action` | GUIDE § The Deck | Open focuses the window already running a task rather than opening a duplicate | e2e: Open focuses an already-open window instead of duplicating it |
| `deck-open-action-fresh` | GUIDE § The Deck | Open opens the task's window fresh when none is already holding it | todo |
| `deck-open-action-per-session` | GUIDE § The Deck | On a per-session card Open and Diff act on that session's own directory | todo |
| `deck-diff-action` | GUIDE § The Deck | Diff shows the working diff | e2e: Diff opens the working diff |
| `deck-card-overflow-menu` | GUIDE § The Deck | Forget removes the run's record without touching its neighbour | e2e: forget removes a run's record without touching its neighbour |
| `deck-card-overflow-rows` | GUIDE § The Deck | The card's overflow offers Open in Jira (the task source's own label) and Forget — today the card-detail drawer's `More` disclosure, not a ⋯ on the card | e2e: the overflow menu offers Open in Jira and Forget |
| `deck-grouping-lens` | GUIDE § The Deck | The board opens one card per session; switching the header control to Workspaces gives one card per launched task with sessions nested, and the choice sticks across a reopen (`agentFlow.deckGrouping`) | e2e: the Sessions / Workspaces grouping sticks across a reopen |
| `deck-refresh` | GUIDE § The Deck | The header refresh reports when it last synced (`synced Ns ago`) | e2e: the refresh control reports when it last synced |
| `deck-card-facts` | GUIDE § The Deck | Each card shows its branch and launch time, per-repo diff stats with dirty/ahead markers, the Jira status, and Open / Diff | e2e: the Deck card shows the PR the GitHub forge reports |
| `deck-notepad-marker` | GUIDE § The Deck | A note started from the Notepad sits among the tickets marked `notepad` | todo |
| `deck-run-retirement` | GUIDE § The Deck | Run records retire once a task is provably over; uncommitted or unpushed work always stops retirement, and retirement deletes only the record, never a worktree, branch or commit | e2e: a run past its retire window is swept off the board and out of the store |
| `deck-retire-windows` | SETTINGS § table | `agentFlow.retireFinishedAfterHours`, `agentFlow.retireClosedAfterHours` and `agentFlow.retireAbandonedAfterDays` each set a window, `0` retires on sight or disables | unit: test/unit/engine/retire.test.ts |
| `deck-clear-stale` | GUIDE § The Deck | Clear stale appears in the header when records are only waiting out their window, takes them on the spot, and leaves live runs alone | e2e: clear stale leaves live runs alone |
| `deck-open-agents` | GUIDE § The Deck | The Deck shows every Claude Code session open on this machine, read from `~/.claude/sessions`; sessions attach to the card owning their directory, and a place with no tracked run gets a `local` card that disappears when its last session closes; `agentFlow.openAgents: false` removes them without reopening the panel | e2e: a live session in an untracked directory is a local card |
| `deck-local-card-inference` | GUIDE § The Deck | A local card reads its branch for a ticket key (`PROJ-5641-team-table` → `PROJ-5641`, marked `~inferred`) only when `agentFlow.jira.project` is set, and for its pull request | e2e: shows an inferred key only when a Jira project is set |
| `deck-track-it` | GUIDE § The Deck | ⋯ → Track it pins a local card to the runs store, after which it behaves like a task you took, Forget included | e2e: Track it pins a local card to the runs store |
| `deck-local-card-last-session` | GUIDE § The Deck | A local card disappears the moment its last session closes — the Deck never prunes `~/.claude/sessions`, a dead pid is what removes the card | e2e: a local card disappears when its last session dies |
| `deck-pr-facts` | GUIDE § The Deck | Each card carries the PR state of every repo it touches from the configured forge's CLI: number, CI, review decision with unresolved-thread count, mergeability (`agentFlow.prFacts`) | e2e: shows the PR the GitHub forge reports |
| `deck-pr-facts-off-live` | GUIDE § The Deck | Turning `agentFlow.prFacts` off applies the moment you save: cards fall back to the git + Jira backbone and the review strip goes dark | e2e: turning prFacts off drops PR facts and darkens the review strip live |
| `deck-pr-unread` | FORGES § 4. Conventions | A failing PR read keeps `error: true`, the card leads with `⚠ PR unread`, the footer counts the affected runs, and nothing acts on the carried-forward facts | e2e: a failing PR read shows PR unread and counts it in the footer |
| `deck-merge-button` | SETTINGS § table | With `agentFlow.mergeWrites` on, a card whose one PR is provably ready shows Merge; a modal names the repo, number and strategy (`agentFlow.mergeMethod`) before `gh pr merge` runs; cancel runs nothing; two ready PRs or a sibling repo with an open PR show no button | e2e: Merge confirms with the repo, number and strategy |
| `deck-merge-gitlab-rebase` | SETTINGS § table | On GitLab `agentFlow.mergeMethod: rebase` is refused with a message naming the setting, never substituted | e2e: GitLab refuses a rebase merge naming the setting |
| `deck-merge-failure-surfaced` | PRIVACY | A merge failure reaches the user as a notification and is logged to the Agent Flow Deck output channel | e2e: a merge failure reaches the user and the output channel |
| `deck-merge-cancel` | SETTINGS § table | Cancelling the merge confirmation runs nothing — no merge reaches the forge CLI | e2e: cancelling the merge dialog runs nothing |
| `deck-merge-two-ready` | SETTINGS § table | A card with two provably ready pull requests shows no Merge button — choosing one of a coupled pair is not the Deck's to make | e2e: two ready PRs across repos show no Merge button |
| `deck-merge-sibling-open` | SETTINGS § table | A card whose sibling repo still holds an open pull request shows no Merge button; every other repo's must already be merged | e2e: a sibling repo still holding an open PR blocks Merge |
| `deck-pr-work-buttons` | SETTINGS § table | Fix CI, Resolve conflict and Address review seed a session for the run; `agentFlow.prWorkOpenIn: ask` offers the run's own window, this window, a `.code-workspace` and a live window, and a destination other than the run's own window points one session at the brief by absolute path | e2e: Fix CI seeds a session pointed at the brief by absolute path |
| `deck-address-pr-in-place` | GUIDE § What it does | The Deck card's Address PR re-seeds the workspace the run already has — no new worktree | e2e: the Deck's Address PR re-seeds the run's workspace in place |
| `deck-pr-work-prompts` | SETTINGS § table | Each reason seeds its own prompt: Fix CI names the failing check, Resolve conflict tells the session to rebase onto the base and resolve, Address review sends the PR-review template alone | e2e: Resolve conflict and Address review seed their own prompts |
| `deck-notify-action-required` | SETTINGS § table | `agentFlow.notifyOnActionRequired` raises one notification when a run parks, coalesces several parking in one pass, and does not repeat until answered and parked again | e2e: notifyOnActionRequired raises one notification per park |
| `deck-activity-badge` | SETTINGS § table | The activity-bar badge counts waiting runs whether or not notifications are on and whether or not the Deck is open | e2e: the activity-bar badge counts waiting runs |
| `deck-copilot-no-session` | GUIDE § The Deck | A task launched under `agentFlow.agentProvider: copilot` still gets a card with the git + Jira + PR backbone but no session on it | e2e: a Copilot run gets the backbone but no session |
| `deck-account-footer` | FORGES § 3. What GitLab and Bitbucket cannot answer | On GitHub the footer legend names the active `gh` account and offers a switch; on GitLab (`caps.accounts: false`) it names no identity and offers no switch | unit: test/unit/engine/forge/accounts.test.ts |
| `deck-account-github-com-only` | FORGES § 3. What GitLab and Bitbucket cannot answer | Account enumeration reads only `github.com`, never a GHE host in the same `gh` config | untestable: documented absence |
| `deck-usage-action` | TELEMETRY § Usage events | The card's usage action reads token totals from transcripts on demand; `agentFlow.deck.showTokenTotal` adds a Tokens on board header total (off by default) | unit: test/unit/engine/usage.test.ts |
| `deck-open-external` | TELEMETRY § Usage events | Open in Jira and failing-check links open in the browser | untestable: openExternal into a browser |

## Review strip

| id | doc | claim | proof |
|----|-----|-------|-------|
| `review-queue-strip` | GUIDE § The Deck | Above the columns, the review queue lists every open PR asking for your review, found with one `gh` search; PRs in archived repositories are left out | todo |
| `review-queue-rows` | GUIDE § The Deck | Each row carries repo, number, title, author, age, and size as `+409 −50 · 8 files` and an S/M/L bucket; every row stays visible in a height-capped, independently scrollable list | todo |
| `review-queue-sort` | GUIDE § The Deck | Sort by oldest (what you owe most) or smallest (what you can clear first) | todo |
| `review-row-expand` | GUIDE § The Deck | Expanding a row fetches which checks failed and how many threads are open, alongside decision and mergeability | todo |
| `review-with-tool` | GUIDE § The Deck | Review with … checks the PR out into a worktree, writes a brief and seeds a session to review the diff and write findings to `.pick-task/REVIEW-<number>.md` | e2e: launching a review opens its worktree, brief and plan handshake |
| `review-row-play-glyph` | GUIDE § The Deck | The launch is also a play glyph at the end of every row, so clearing a queue needs no expanding | todo |
| `review-row-in-flight` | GUIDE § The Deck | A row already being reviewed shows the loading mark and cannot be launched twice | todo |
| `review-row-no-checkout` | GUIDE § The Deck | A row whose repo is not checked out locally is greyed but live, and says why on hover | todo |
| `review-open-in` | SETTINGS § table | `agentFlow.reviewOpenIn` ships pinned to a new window; `ask`, `this-window` and `pick-existing` send the session elsewhere while the review still runs in its own worktree, named by absolute path in the prompt | todo |
| `review-modes` | SETTINGS § table | One Full review mode ships; adding an entry to `agentFlow.reviewRequestModes` makes the launch ask which to seed, and `agentFlow.reviewRequestMode` pins one; `agentFlow.reviewRequestPrompt` empty uses the built-in default | todo |
| `review-batch-select` | GUIDE § The Deck | Select turns carets into checkboxes, clicking picks a row, shift-click takes a range, and the bar launches one reviewer per PR with one worktree and one run record each | e2e: one worktree and one run record per PR |
| `review-batch-read-only-mode` | GUIDE § The Deck | The batch offers a read-only review that checks nothing out and cannot run tests; it is never one of `agentFlow.reviewRequestModes` unless you add the `read-only` id yourself | unit: test/unit/engine/review/batch.test.ts |
| `review-batch-layout` | GUIDE § The Deck | Landing in a new window with several PRs asks whether they share one window (a session each) or a window per PR | e2e: a batch review launches one worktree |
| `review-batch-threshold-and-skips` | GUIDE § The Deck | Batches over `agentFlow.batchLaunchConfirmThreshold` confirm and name the cost in sessions; PRs in a repo you have not checked out are named once and skipped | todo |
| `review-writes` | GUIDE § The Deck | With `agentFlow.reviewWrites` on (off by default) the expanded row submits Approve, Comment or Request changes, each behind a confirmation naming verb, repo and number (the halves below carry the rest of the sentence) | e2e: Approve confirms with the verb, repo and number before gh pr review runs |
| `review-writes-cancel` | GUIDE § The Deck | Declining that confirmation sends nothing — the row is released, and no `pr review` reaches the CLI | e2e: cancelling the confirmation sends nothing |
| `review-writes-in-flight` | GUIDE § The Deck | Each of the three verbs is disabled while a submit for that row is already in flight | unit: test/webview/ReviewStrip.test.tsx |
| `review-writes-session-draft` | GUIDE § The Deck | A body loaded from the session's draft (`.pick-task/REVIEW-<n>.md`) is marked as session-drafted when it goes out | e2e: a session's draft loads into the review box and is marked session-drafted |
| `review-writes-unmarked` | GUIDE § The Deck | `agentFlow.stampLabelOnWrite: false` sends that same draft body unmarked | e2e: stampLabelOnWrite off sends the body unmarked |
| `review-writes-gitlab-request-changes` | SETTINGS § table | On GitLab, Request changes posts a note and withdraws any approval, and the confirmation says so | e2e: Request changes on GitLab warns that approval is withdrawn |
| `review-writes-error-never-body` | FORGES § 4. Conventions | A rejected submit shows the CLI's stderr, never the review body | e2e: a rejected submit shows the CLI's stderr, never the body |
| `review-strip-toggle` | GUIDE § The Deck | `agentFlow.reviewRequests: false` hides the strip; it also goes dark whenever `agentFlow.prFacts` is off; `agentFlow.reviewRequestsAlwaysVisible: false` hides it while empty | todo |
| `review-strip-ttl` | SETTINGS § table | `agentFlow.reviewRequestsTtlSeconds` (default 300, minimum 60) governs how stale the cached queue may be; fetched only while the Deck is open | unit: test/unit/engine/review/store.test.ts |

## Marketplace

| id | doc | claim | proof |
|----|-----|-------|-------|
| `marketplace-open` | GUIDE § The Marketplace | "Open the Marketplace" (or the puzzle-piece title button) opens a browser of the agents and commands found in `.claude/` | e2e: lists the agents and commands found in .claude/ |
| `marketplace-scope` | GUIDE § The Marketplace | It reads `~/.claude` — marketplaces, plugins, skills, commands, agents, hooks — plus what you wrote yourself in `~/.claude` or the workspace's `.claude/` | e2e: lists the agents and commands found in |
| `marketplace-claude-specific` | GUIDE § The Marketplace | The Marketplace is Claude-specific whatever `agentFlow.agentProvider` says | todo |
| `marketplace-fuzzy-search` | GUIDE § The Marketplace | Search is fuzzy and ranked (`revw` finds `/review`), narrowing the list with the best match selected as you type | e2e: search narrows the list to the matching asset |
| `marketplace-keyboard-nav` | GUIDE § The Marketplace | From the search box ↑/↓ move the selection and Enter opens its file | todo |
| `marketplace-type-pills` | GUIDE § The Marketplace | Type pills (All, Skills, Commands, Agents, Hooks, Plugins) carry live counts that follow the query, and filter the list | todo |
| `marketplace-scope-pills` | GUIDE § The Marketplace | Scope pills narrow to Installed only and Enabled only | todo |
| `marketplace-plugins-picker` | GUIDE § The Marketplace | The searchable Plugins ▾ picker filters by several plugins at once and clears with one click | todo |
| `marketplace-marketplace-tags` | GUIDE § The Marketplace | Clicking a marketplace tag filters by marketplace | todo |
| `marketplace-filter-and` | GUIDE § The Marketplace | Query, type, scope, category, plugins and marketplace all AND together | todo |
| `marketplace-filter-chips` | GUIDE § The Marketplace | Active selections show as removable chips with Clear; the chip row disappears when nothing is selected | todo |
| `marketplace-category-grouping` | GUIDE § The Marketplace | Without a query the list groups into category sections from each plugin's manifest, Yours first, then by descending size, Uncategorized last; a header click focuses the category | todo |
| `marketplace-disabled-rows` | GUIDE § The Marketplace | Disabled plugins' rows are struck through | todo |
| `marketplace-not-downloaded` | GUIDE § The Marketplace | Plugins a marketplace catalogues but you have not downloaded are listed with their `/plugin install` command | todo |
| `marketplace-detail-render` | GUIDE § The Marketplace | Selecting a row renders its file in the detail pane under the metadata | e2e: selecting an asset shows its body |
| `marketplace-detail-hooks-json` | GUIDE § The Marketplace | A hook renders its `hooks.json` as a fenced JSON block | todo |
| `marketplace-detail-truncation` | GUIDE § The Marketplace | Files over 262,144 characters are truncated, with Open file covering the rest | unit: test/unit/marketplaceView.test.ts |
| `marketplace-detail-safe-links` | GUIDE § The Marketplace | The renderer builds elements from a parsed tree, never injects HTML; only `http`/`https` links become clickable | unit: test/webview/Markdown.test.tsx |
| `marketplace-detail-actions` | GUIDE § The Marketplace | Copy grabs the command you would type and reports through the webview's own toast; Open file opens it in an editor tab | e2e: copy reports success through the webview's own toast |
| `marketplace-detail-open-file` | GUIDE § The Marketplace | Open file opens the asset in an editor tab | todo |
| `marketplace-reveal-in-finder` | GUIDE § The Marketplace | Reveal in Finder shows the file on disk | untestable: native OS dialog |
| `marketplace-read-only-offline` | GUIDE § The Marketplace | The panel never writes to `~/.claude`, never runs `/plugin install`, and makes no network calls | unit: test/unit/marketplaceView.test.ts |
| `marketplace-rescan` | GUIDE § The Marketplace | ⟳ Rescan re-reads the disk, and so does coming back to the panel after a pause | todo |
| `marketplace-add-marketplace` | GUIDE § The Marketplace | + Add a marketplace copies the `/plugin marketplace add owner/repo` command for you to run in Claude Code | todo |
| `marketplace-not-set-up` | TELEMETRY § Usage events | Without a `~/.claude/plugins` directory the panel explains Claude Code is not set up | todo |

## Doctor & Setup

| id | doc | claim | proof |
|----|-----|-------|-------|
| `setup-first-run-wizard` | README § Quick start | First run collects the connector's settings, the repos directory and a credential in a short wizard | todo |
| `setup-welcome-offer` | TELEMETRY § Usage events | The first-activation welcome prompt offers Set up and Later; Later (or dismissing) writes nothing and leaves everything unset | todo |
| `setup-step-numbering` | CONNECTORS § 4. `TaskConnector` | Wizard boxes are titled `Agent Flow Deck Setup (n/total)` where total is `setupSteps + 1 + signInSteps` and the repos-root step comes last | unit: test/unit/setup.test.ts |
| `setup-commit-thunk` | CONNECTORS § 4. `TaskConnector` | A connector collects without writing; the commit thunk runs after the last cancellable step, so cancelling at any step performs zero setting writes | unit: test/unit/compat.test.ts |
| `setup-outcomes` | TELEMETRY § Usage events | Escape during a connector step or at the repos-root box writes nothing and leaves `setupComplete` unset so the offer returns next launch; completing writes the settings and marks setup complete; declining sign-in saves settings and warns | todo |
| `setup-rerun` | README § Quick start | Run Setup… re-runs the wizard on a configured install, and cancelling leaves the configuration untouched | todo |
| `standalone-sign-in` | CONNECTORS § 4. `TaskConnector` | The standalone Sign in command numbers its own boxes (`Jira sign-in (1/2)`) and stores the credential | e2e: signing in round-trips through SecretStorage |
| `sign-out` | CONNECTORS § 4. `TaskConnector` | Signing out deletes the credential and re-gates the pool | e2e: signing out re-gates the pool |
| `doctor-command` | README § Feedback | Doctor probes Jira and the forge CLI for real — two authenticated GETs and `gh auth status` — and catches a revoked token instead of reporting a network problem | unit: test/unit/engine/doctor.test.ts |
| `doctor-rows-from-connector` | CONNECTORS § 4. `TaskConnector` | Doctor's row labels come from the connector's `SourceInfo` (label, scope noun, endpoint) | todo |
| `doctor-probe-skip` | CONNECTORS § 4. `TaskConnector` | A probe a connector deliberately did not run renders as `skip`, never as a silent pass | todo |
| `doctor-provider-rows` | SETTINGS § table | Doctor reports rows for whichever tool is in play — every host tool under `agentFlow.agentProvider: ask` | todo |
| `doctor-forge-mode-row` | FORGES § Bitbucket has two modes | Doctor's Bitbucket group has a mode row reading `passthrough (full)` or `projected (limited — upgrade atlassian-cli for full support)` | todo |
| `doctor-pr-reads-row` | FORGES § 4. Conventions | Doctor's `PR reads` row sits beside a CLI row that is honestly green when the account cannot resolve a repository | todo |
| `doctor-actions` | TELEMETRY § Usage events | Picking a row runs its action — a command, a setting (opens Settings on that id), an extension or a URL; Copy report fills the clipboard and writes nothing else | todo |
| `doctor-gh-where` | ORCHESTRATOR_COMMANDS § Numbers | Doctor says where `gh` was found, the case a bare launchd PATH makes invisible | unit: test/unit/engine/doctor.test.ts |
| `command-refresh` | TELEMETRY § Usage events | Refresh re-fetches the pool for the current lens | e2e: reordering the pool survives a refresh, and reset |
| `command-take-task` | TELEMETRY § Usage events | The `agentFlow.takeTask` palette command takes a task without the card | todo |

## Orchestrator

| id | doc | claim | proof |
|----|-----|-------|-------|
| `orch-feature-gate` | ORCHESTRATOR_COMMANDS § top | The Orchestrator drawer is off by default behind `agentFlow.orchestrator` | e2e: an attached workflow is a real flow in the Workflows drawer |
| `orch-graph-model` | ORCHESTRATOR_COMMANDS § The model | A flow is a graph of nodes joined by rules; what a rule does is derived from the node it points at (planned → launch, place → seed, command → run, notify → notify), never stored | unit: test/unit/engine/orchestrator/evaluate.test.ts |
| `orch-no-action-picker` | ORCHESTRATOR_COMMANDS § The model | There is no action picker anywhere in the drawer or the list | untestable: documented absence |
| `orch-condition-key-spelling` | ORCHESTRATOR_COMMANDS § The model | Condition keys keep their released spelling (`agent-ended-turn`, `agent-idle-over`, `no-agent-left`) while their labels read "session" | unit: test/unit/vocabulary.test.ts |
| `orch-drawer-drag-in` | GUIDE § The Deck | Drag a card into the drawer, connect two nodes, and put a condition on the connection | ct: test-ct/OrchestratorDrawer.nodeDrag.spec.tsx |
| `orch-drawer-resize` | GUIDE § The Deck | The drawer resizes by dragging its edge or pressing Expand | ct: test-ct/DeckDetail.resize.spec.tsx |
| `orch-list-view-keyboard` | GUIDE § The Deck | List view builds, wires, edits and arms the same flow without a pointer | e2e: List view builds and arms a rule without a pointer |
| `orch-header-workflows-button` | ORCHESTRATOR_COMMANDS § Finding them | The Workflows header button is badged `N needs you` once a workflow is waiting-on-you or stopped, else a plain count of every card carrying one | e2e: the Workflows button counts cards and switches to needs-you |
| `orch-header-templates-button` | ORCHESTRATOR_COMMANDS § Finding them | The Templates header button is badged with the total, starters included | e2e: the Templates button counts starters too |
| `orch-three-views` | ORCHESTRATOR_COMMANDS § Finding them | The drawer has three top-level views — Active, Templates, Canvas — and each header button always opens its own: clicking Workflows while Templates shows switches to Active rather than closing, and neither button ever mints a blank flow | e2e: clicking Workflows while Templates shows switches to Active |
| `orch-active-view` | ORCHESTRATOR_COMMANDS § Finding them | Active lists one row per card carrying a workflow, stopped and waiting-on-you first; clicking a row closes the drawer and opens that card | e2e: an Active row closes the drawer and opens that card |
| `orch-canvas-view` | ORCHESTRATOR_COMMANDS § Finding them | Canvas is the editor; with nothing open it shows an explanation instead of a blank panel | e2e: the Canvas explains itself when nothing is open |
| `orch-node-planned-launch` | GUIDE § The Deck | A rule pointed at unstarted work launches that session in a fresh worktree | unit: test/unit/engine/orchestrator/launch.test.ts |
| `orch-node-place-seed` | GUIDE § The Deck | A rule pointed at a place that already exists seeds a second session there | unit: test/unit/engine/orchestrator/runner.test.ts |
| `orch-node-command-run` | GUIDE § The Deck | A rule pointed at a command node runs a shell command from `agentFlow.commands` (`id`, `label`, `run`, optional `detail`) or free text; `{note}` is replaced with the rule's note, spliced in unquoted | todo |
| `orch-node-notify` | GUIDE § The Deck | A notify node pops a VS Code notification in your own window and stamps a receipt — it messages nobody | todo |
| `orch-node-gate` | GUIDE § The Deck | A gate node shows Approve and Reject with an amber dot; it asks once and latches; a later rule fires on you-approved or you-rejected; Reset on the asking rule poses the question again; there is no notification | todo |
| `orch-rule-note` | GUIDE § The Deck | A launch or seed rule's note is folded into the prompt mode it uses | unit: test/unit/engine/orchestrator/launch.test.ts |
| `orch-cond-merged-pr` | GUIDE § The Deck | Condition: a merged PR | unit: test/unit/engine/orchestrator/conditions.test.ts |
| `orch-cond-failing-ci` | GUIDE § The Deck | Condition: failing CI | unit: test/unit/engine/orchestrator/conditions.test.ts |
| `orch-cond-ended-turn` | GUIDE § The Deck | Condition: a session that ended its turn | unit: test/unit/engine/orchestrator/conditions.test.ts |
| `orch-cond-clean-tree` | GUIDE § The Deck | Condition: a clean tree | unit: test/unit/engine/orchestrator/conditions.test.ts |
| `orch-cond-jira-status` | GUIDE § The Deck | Condition: a Jira status (hand-written only, no picker) | unit: test/unit/engine/orchestrator/conditions.test.ts |
| `orch-cond-command-succeeded` | ORCHESTRATOR_COMMANDS § You can | A rule leaving a command node offers "the command succeeded", and the second command inherits the first one's directory | todo |
| `orch-cond-branch-ci-passed` | GUIDE § The Deck | CI passing on a named branch of a named repo reads GitHub's aggregate rollup (skipped folds toward success, no checks reads unknown, an unreadable call reads not-met); it has no picker and is hand-edited only | unit: test/unit/engine/orchestrator/branchCi.test.ts |
| `orch-cond-agent-idle-over` | ORCHESTRATOR_COMMANDS § You cannot | Condition: session idle over N (hand-written only) | unit: test/unit/engine/orchestrator/conditions.test.ts |
| `orch-cond-no-agent-left` | ORCHESTRATOR_COMMANDS § The model | Condition: no session left, read from the session registry rather than a transcript | unit: test/unit/engine/orchestrator/armability.test.ts |
| `orch-cond-changes-requested` | FORGES § 3. What GitLab and Bitbucket cannot answer | On GitLab (and projected Bitbucket) arming names the `changes-requested` rule as unfirable | todo |
| `orch-cond-gate-approved-rejected` | GUIDE § The Deck | Conditions: you approved / you rejected, from a gate node | unit: test/unit/engine/orchestrator/conditions.test.ts |
| `orch-condition-live-status` | GUIDE § The Deck | The drawer says what each condition is waiting on right now | ct: test-ct/OrchestratorDrawer.dryRun.spec.tsx |
| `orch-arm` | GUIDE § The Deck | Arm a flow and it is checked on every Deck refresh; the card's chip turns live | e2e: arming turns the card's chip live |
| `orch-arm-unfirable-warning` | TELEMETRY § Usage events | Arming warns about rules that can never fire as configured — Live signal off, PR facts off, or the forge cannot answer | unit: test/unit/engine/orchestrator/armability.test.ts |
| `orch-fire-once` | GUIDE § The Deck | A rule that is met fires exactly once and tells you, never again on a later pass | unit: test/unit/engine/orchestrator/evaluate.test.ts |
| `orch-fire-once-e2e` | GUIDE § The Deck | A notify rule fires once in a real host and pops exactly one notification across later passes | todo |
| `orch-poll-interval` | ORCHESTRATOR_COMMANDS § One pass | The Deck polls every 6 seconds (`POLL_MS`) | unit: test/unit/deckView.test.ts |
| `orch-lock` | ORCHESTRATOR_COMMANDS § One pass | Flows live in `~/.agentflow/flows` behind a lock (TTL 300 s, stale reaped never stolen); a pass that cannot take it does nothing; two windows cannot fire the same rule twice | unit: test/unit/engine/orchestrator/lock.test.ts |
| `orch-runs-while-hidden` | GUIDE § The Deck | Closing the Deck stops an armed flow advancing, and closing with something armed says so — offering Reopen the Deck, and leaving the flow armed on disk | e2e: closing the Deck with an armed flow says so |
| `orch-runs-while-hidden-poll` | GUIDE § The Deck | An armed flow keeps advancing while the Deck panel is merely hidden; a hidden panel with nothing armed stops polling | unit: test/unit/deckView.test.ts |
| `orch-hold-on-reopen` | ORCHESTRATOR_COMMANDS § One pass | The first evaluation after arming or a restart that finds rules already met reports them and waits for Go | unit: test/unit/engine/orchestrator/runner.test.ts |
| `orch-consent` | ORCHESTRATOR_COMMANDS § One pass | Two separate consents, once each per flow: launches/seeds (naming ticket, repos and prompt mode) and shell (naming the command text); the asking pass performs nothing; approval lets the next pass act; Disarm in the dialog disarms | todo |
| `orch-launch-cap` | GUIDE § The Deck | At most three launches, seeds and commands happen in a single pass, the rest deferred to the next; notify edges are never capped | unit: test/unit/engine/orchestrator/evaluate.test.ts |
| `orch-latch` | ORCHESTRATOR_COMMANDS § The latch | A rule that ran is stamped fired or errored and never re-evaluated until Reset; Reset clears the stamps and keeps the note and mode; a pre-flight read failure is retried, not latched | unit: test/unit/engine/orchestrator/evaluate.test.ts |
| `orch-never-auto-run` | ORCHESTRATOR_COMMANDS § Never, whatever you approved | `agentFlow.neverAutoRun` patterns (`*` any run, `?` one char, case-insensitive, empty by default) are matched after `{note}` is spliced in; a match never reaches consent and is refused again before the shell, with an error naming the pattern | unit: test/unit/engine/orchestrator/neverAutoRun.test.ts |
| `orch-never-auto-run-e2e` | ORCHESTRATOR_COMMANDS § Never, whatever you approved | In a real host a matching pattern outranks a flow's stored approval: the file the command would write never appears | todo |
| `orch-command-which` | ORCHESTRATOR_COMMANDS § Which command | A node carrying both `commandId` and free `run` is refused; an id no longer in settings is refused and the drawer prints `(not configured)` | unit: test/unit/engine/orchestrator/command.test.ts |
| `orch-command-cwd` | ORCHESTRATOR_COMMANDS § In which directory | The command runs in the node's `cwdRepo`, else the source place's repo, else the nearest place through chained commands; with none it is refused, never a fallback checkout | unit: test/unit/engine/orchestrator/command.test.ts |
| `orch-command-process` | ORCHESTRATOR_COMMANDS § Then, the process | The child runs with a 120 s deadline, SIGKILL, a 1 MiB output cap (more is a failure), `windowsHide`; only the shell it started is killed | unit: test/unit/engine/orchestrator/command.test.ts |
| `orch-command-output` | ORCHESTRATOR_COMMANDS § You can | stdout and stderr go to the output channel and the journal; a workflow's done/fail step offers Output, which opens the latest `fired`/`errored` line in an editor tab headed with a pointer back, and toasts (never a blank tab) when nothing is journaled, the edge never ran, or no output was captured | todo |
| `orch-save-to-settings` | ORCHESTRATOR_COMMANDS § Saving a command | Save to settings appends the command to `agentFlow.commands` in the scope that holds it (seeding the shipped example first), leaves the node as free text, then shows `Saved in settings as "…"`; duplicates match on the command, not the name | todo |
| `orch-picker` | ORCHESTRATOR_COMMANDS § The picker | + Add command… and + Add place… are search-and-tick lists that create one node per tick in a single write; free text is a footer action | todo |
| `orch-dry-run` | GUIDE § The Deck | A dry run reports waiting gates in words ("it is waiting on your answer") | ct: test-ct/OrchestratorDrawer.dryRun.spec.tsx |
| `orch-templates` | ORCHESTRATOR_COMMANDS § Templates and workflows | A template is a flow with no ticket, saved for reuse; attaching one instantiates it disarmed against a card, binding the ticket to every planned node | e2e: attaching a template shows it disarmed |
| `orch-templates-save-edit-delete` | ORCHESTRATOR_COMMANDS § Authoring a template directly | Save-as-template writes to `~/.agentflow/templates/` and lists the row by name with its rule count; Edit reopens it on Canvas and Save updates in place; Delete confirms first and never touches an instantiated workflow | todo |
| `orch-templates-built-in` | ORCHESTRATOR_COMMANDS § Built-in starters | Three starters (Ship it, Test & notify, Review only) ship inside the extension with `builtin-` ids, are marked, refuse rename/delete/overwrite ("Duplicate it to make a version you can change"), and ship empty `repos`/`mode` filled at attach time | unit: test/unit/engine/orchestrator/starters.test.ts |
| `orch-templates-built-in-e2e` | ORCHESTRATOR_COMMANDS § Built-in starters | In a real host the built-in rows are marked and carry no delete control | todo |
| `orch-templates-draft` | ORCHESTRATOR_COMMANDS § Authoring a template directly | ＋ New template… opens an in-memory draft with every workflow verb hidden; Cancel discards it, closing the drawer another way keeps it; a built-in has no Edit | ct: test-ct/OrchestratorDrawer.templates.spec.tsx |
| `orch-attach-from-card` | ORCHESTRATOR_COMMANDS § Templates and workflows | A card's attach picker instantiates a template as a disarmed workflow; attaching over an existing one without `replace` is refused; an empty picker offers Open Templates | e2e: attaching a template shows it disarmed, and arming |
| `orch-workflow-detach` | ORCHESTRATOR_COMMANDS § Templates and workflows | Detach deletes the flow's file outright and clears the card; attachment is derived from the graph, never stored | e2e: Detach clears the card |
| `journal-files` | FLOW_JOURNAL § top | Every armed flow keeps `~/.agentflow/flows/<id>.log.jsonl` beside `<id>.json`, one line per event, oldest first | todo |
| `journal-rationale` | FLOW_JOURNAL § top | Reset deletes a rule's receipt so it can fire again; the journal keeps the `reset` event as evidence | unit: test/unit/engine/orchestrator/journal.test.ts |
| `journal-always-on` | FLOW_JOURNAL § top | The journal is written whenever `agentFlow.orchestrator` is on; there is no separate setting | todo |
| `journal-jq-readable` | FLOW_JOURNAL § Reading it | One JSON object per line, so `jq` works directly | unit: test/unit/engine/orchestrator/journal.test.ts |
| `journal-fields` | FLOW_JOURNAL § The fields | Every line has `id` (sortable, lexical order is chronological), `at`, `flow`, `kind`, `sum` | unit: test/unit/engine/orchestrator/journal.test.ts |
| `journal-checksum` | FLOW_JOURNAL § The fields | `sum` guards against torn writes; a line whose checksum does not match is skipped and its neighbours are unaffected | unit: test/unit/engine/orchestrator/journal.test.ts |
| `journal-checksum-e2e` | FLOW_JOURNAL § The fields | In a real host a corrupted line is skipped, new lines still append, and the drawer still renders | todo |
| `journal-event-kinds` | FLOW_JOURNAL § The events | Kinds `armed`, `consent-asked`, `consented`, `fired`, `errored`, `deferred`, `skipped`, `promoted`, `reset` with their extra fields | unit: test/unit/engine/orchestrator/journal.test.ts |
| `journal-event-order-e2e` | FLOW_JOURNAL § The events | A real armed flow journals `armed`, `consent-asked`, `consented`, `fired` in order | todo |
| `journal-output-truncation` | FLOW_JOURNAL § The events | `output` is truncated to the first and last 4 KB with the elided byte count stated between | unit: test/unit/engine/orchestrator/journal.test.ts |
| `journal-outlives-flow` | FLOW_JOURNAL § Lifetime | Deleting a flow removes `<id>.json` and leaves `<id>.log.jsonl` | todo |
| `journal-cap` | FLOW_JOURNAL § Lifetime | The journal is capped at 1 MB per flow; the oldest whole lines drop first; a single oversize event is kept anyway | unit: test/unit/engine/orchestrator/journal.test.ts |
| `journal-trim-race` | FLOW_JOURNAL § Lifetime | A trim can lose a line or two under concurrent appends; it never affects the flow itself | untestable: documented absence |
| `journal-failure-nonfatal` | FLOW_JOURNAL § Lifetime | A journal write failure is said once in the output channel and flows keep running unrecorded | unit: test/unit/engine/orchestrator/journal.test.ts |
| `orch-unproven-shell` | ORCHESTRATOR_COMMANDS § Not yet proven | The command runs through Node's default shell — `/bin/sh` on macOS and Linux | todo |
| `orch-unproven-settings-write` | ORCHESTRATOR_COMMANDS § Not yet proven | Save to settings writes a real `settings.json`, not only a mock configuration | todo |
| `orch-unproven-chain` | ORCHESTRATOR_COMMANDS § Not yet proven | The chained shape `place → deploy.sh → smoke.sh` runs end to end with a real repo, condition and process | todo |
| `orch-command-path-never-run-in-editor` | ORCHESTRATOR_COMMANDS § Not yet proven | A command node's consent dialog names the command, Act runs it and records its output in a real editor | todo |
| `orch-numbers` | ORCHESTRATOR_COMMANDS § Numbers | Poll 6 s, timeout 120 s, lock TTL 300 s, max output 1 MiB, SIGKILL, two consent prompts per flow | unit: test/unit/engine/orchestrator/lock.test.ts |

## Connectors

| id | doc | claim | proof |
|----|-----|-------|-------|
| `connector-selection` | CONNECTORS § 1. What a connector is | `agentFlow.taskSource` selects the active connector by id; `jira` is the shipped default and a change requires a window reload | e2e: reads work items through a real `sf` process |
| `connector-registry` | CONNECTORS § 5. The checklist | `CONNECTOR_IDS` derives from the registry; the manifest `enum` and `enumDescriptions` match it exactly | unit: test/unit/tasks/registry.test.ts |
| `connector-jira` | README § Quick start | The Jira connector signs in with an Atlassian API token stored in SecretStorage and reads the pool over REST | e2e: round-trips through SecretStorage and signing out re-gates the pool |
| `connector-jira-live-api` | CONNECTORS § 7. The inherited assumptions | Jira's JQL ladder, `statusCategory != Done` and board detection behave against a live Jira Cloud site | untestable: live Jira API |
| `connector-agile-accelerator` | CONNECTORS § 9. Connector #2 | The `agileAccelerator` connector reads work items through a real `sf` process, read-only, with `agentFlow.agileAccelerator.instanceUrl`, `agentFlow.agileAccelerator.team` and `agentFlow.agileAccelerator.targetOrg` bounding every query | e2e: the Agile Accelerator connector reads work items |
| `connector-agile-missing-cli` | CONNECTORS § 9. Connector #2 | A missing `sf` gates the panel honestly instead of crashing it | e2e: gates the panel honestly instead of crashing it |
| `connector-agile-error-envelope` | CONNECTORS § 9. Connector #2 | A failing query's JSON envelope on stdout reaches the user, not a generic error | e2e: JSON envelope on stdout reaches the user |
| `connector-agile-live-org` | CONNECTORS § 9. Connector #2 | The describe-driven SOQL and namespace detection behave against a live Salesforce org | untestable: live Agile Accelerator API |
| `connector-fixture` | CONTRIBUTING § The E2E fixture connector | `agentFlow.taskSource: "fixture"` with `AGENT_FLOW_FIXTURE_DIR` set reads `tasks.json` and appends every write to `writes.jsonl`; a real host boots it and renders the fixture task | e2e: the pool renders the fixture task |
| `cap-supported-filters` | CONNECTORS § 3. The capability table | Only lenses in `caps.supportedFilters` render; an unlisted tab never renders, not even disabled; `"all"` is never a sixth tab | e2e: dropping mysprint from supportedFilters removes that lens |
| `cap-sizes` | CONNECTORS § 3. The capability table | The size control renders only with `caps.sizes`; `estimateSeconds` is rendered against an 8-hour workday | e2e: the size lens renders only when the connector has estimates |
| `cap-sprints` | CONNECTORS § 3. The capability table | Without `caps.sprints` the add, remove and reorder affordances all disappear | e2e: without sprints there is no add, remove or reorder affordance |
| `cap-sprints-handler-backstop` | CONNECTORS § 3. The capability table | Without `caps.sprints` a direct handler call reports "{label} doesn't have sprints." rather than throwing | unit: test/unit/tasksView.test.ts |
| `cap-components` | CONNECTORS § 3. The capability table | Without `caps.components` every repo chip renders plain — no dash, no `↑`, no title — while the selection stays editable | unit: test/webview/App.test.tsx |
| `cap-labels` | CONNECTORS § 3. The capability table | Without `caps.labels` provenance stamping is a silent no-op: the status change succeeds with no `addLabel` and no toast | e2e: a labels-less connector accepts a status change with no provenance stamp |
| `cap-children` | CONNECTORS § 3. The capability table | With `caps.children` and `agentFlow.childWorktrees` on, taking a parent offers its tree and creates a worktree for the child | e2e: offers its tree and creates a worktree for the child |
| `cap-refresh-caps` | CONNECTORS § 3. The capability table | `refreshCaps()` is called once per panel init and its result posted as a `caps` message; the Jira connector drops the three sprint lenses when the project has no Scrum board, and a failed probe keeps the optimistic answer | unit: test/unit/tasks/jira/provider.test.ts |
| `cap-in-open-sprint` | CONNECTORS § 3. The capability table | `Task.inOpenSprint` is only ever read behind `caps.sprints` | unit: test/webview/App.test.tsx |
| `connector-field-prompts` | CONNECTORS § 2. `TaskProvider` | Status fields reduce to `pick` / `multipick` / `text` / `number` / `date` / `datetime` / `labels` prompts with input validation | unit: test/unit/tasks/jira/transitionFields.test.ts |
| `connector-me-identity` | CONNECTORS § 2. `TaskProvider` | `me()` with `id: ""` refuses the sprint write with the account message before anything is written | e2e: a name-only identity refuses the sprint write and says so |
| `connector-me-null` | CONNECTORS § 2. `TaskProvider` | `me()` returning `null` is treated as unknown, not a failure: the sprint write reports the account message and stops | unit: test/unit/tasksView.test.ts |
| `connector-status-null` | CONNECTORS § 2. `TaskProvider` | `status()` for an unresolvable key answers `{ status: null, category: null }` rather than throwing behind a rendered card | unit: test/unit/tasks/jira/provider.test.ts |
| `connector-key-from-url` | CONNECTORS § 4. `TaskConnector` | `keyFromUrl` returns `null` for a url not its own; the caller falls back to the run's stored key | unit: test/unit/tasks/jira/connector.test.ts |
| `connector-namespacing-rules` | CONNECTORS § 6. The compatibility rules | Settings and SecretStorage keys are namespaced `agentFlow.<id>.*` and never renamed once released | unit: test/unit/compat.test.ts |
| `connector-branch-inference-jira-shaped` | CONNECTORS § 7. The inherited assumptions | Branch-name inference returns `null` when no project is configured, so a non-Jira source gets no inferred ticket rather than a wrong one | unit: test/unit/engine/localRuns.test.ts |
| `connector-docs-tested` | CONNECTORS § 1. What a connector is | Every registered connector and forge id is documented, asserted by a test | unit: test/unit/docs.test.ts |

## Forges

| id | doc | claim | proof |
|----|-----|-------|-------|
| `forge-selection` | FORGES § 1. What a forge is | `agentFlow.forge` selects `github` (default, via `gh`), `gitlab` (via `glab`) or `bitbucket` (via `atlassian-cli`); a change requires a window reload | e2e: the Deck card shows the PR the GitHub forge |
| `forge-registry` | FORGES § 1. What a forge is | `FORGE_IDS` derives from the registry, and the manifest, telemetry allowlist and registry test all use it | unit: test/unit/engine/forge/registry.test.ts |
| `forge-cli-requirement` | README § Requirements | The forge CLI is optional: without it the Deck falls back to git + Jira | todo |
| `forge-cli-resolution` | FORGES § 4. Conventions | The CLI is located through `resolveBin`, whose Homebrew/MacPorts fallbacks cover the bare launchd PATH | unit: test/unit/engine/pr/which.test.ts |
| `forge-probe` | FORGES § 4. Conventions | `probe()` asks a global question (CLI present, signed in) and cannot see a per-repository answer | unit: test/unit/engine/forge/seam.test.ts |
| `forge-fetch-contract` | FORGES § 4. Conventions | `null` from `reviews.search()` means the attempt failed, `[]` means an empty queue; `{ ok: false }` from `prs.fetch()` means failure and `{ ok: true, facts: null }` means no PR; `branchCi` answers `unknown` rather than throwing, and `unknown` is not green | unit: test/unit/engine/pr/store.failure.test.ts |
| `forge-accounts` | FORGES § 1. What a forge is | `accounts()` reads `gh auth status --json hosts` and `switchAccount` runs `gh auth switch`; the footer names the active account and offers the switch when there are two | unit: test/unit/engine/forge/accounts.test.ts |
| `forge-gitlab-gaps` | FORGES § 3. What GitLab and Bitbucket cannot answer | GitLab never exposes changes-requested or thread outdatedness; the queue has no total (a queue over 50 reads complete); a skipped pipeline reads `unknown`, not green | unit: test/unit/engine/review/glab/provider.test.ts |
| `forge-gitlab-queue-size` | FORGES § 3. What GitLab and Bitbucket cannot answer | GitLab's queue row size is filled on expansion with `additions`/`deletions` 0 and `changes_count` capped at `"20+"`, which renders as `20 files` | todo |
| `forge-gitlab-queue-ci` | FORGES § 3. What GitLab and Bitbucket cannot answer | GitLab's queue CI chip reads `none` until the row is expanded | todo |
| `forge-gitlab-extra-read` | FORGES § The MR list carries no pipeline data | The MR list carries no `head_pipeline`, so the card's CI comes from one extra single-MR read per card, falling back to the list row if it fails | e2e: shows the MR the GitLab forge reports |
| `forge-gitlab-rebase-refused` | FORGES § 3. What GitLab and Bitbucket cannot answer | `agentFlow.mergeMethod: rebase` on GitLab is refused with a message naming the setting; squash/merge go through `PUT …/merge_requests/:iid/merge` via `glab api` | unit: test/unit/engine/pr/glab/provider.test.ts |
| `forge-gitlab-merge-unverified` | FORGES § GitLab merge is untested | The GitLab merge path has never run against a live `glab`; only the argv it produces is covered | untestable: live glab merge |
| `forge-bitbucket-two-modes` | FORGES § Bitbucket has two modes | `atlassian-cli bb api --help` exit 0 means passthrough, a clap "unrecognized subcommand" means projected; probed once per Deck session and memoized | unit: test/unit/engine/pr/bb/provider.test.ts |
| `forge-bitbucket-mode-e2e` | FORGES § Bitbucket has two modes | In a real host the detection drives Doctor's mode row and the projected card shows branch CI and little else | todo |
| `forge-bitbucket-no-review-queue` | FORGES § Bitbucket has two modes | `caps.reviewSearch` is `false` in both Bitbucket modes; the strip is hidden rather than shown empty | todo |
| `forge-bitbucket-projected-answers` | FORGES § What each mode answers | Projected mode synthesizes the PR url, reads draft as always false, mergeable as `unknown`, approval as `none`, threads as `null`, and refuses `rebase` before any CLI call | unit: test/unit/engine/pr/bb/projected.test.ts |
| `forge-bitbucket-merge-unverified` | FORGES § Bitbucket merge is untested | The Bitbucket merge path has never run against a live `atlassian-cli`; wire shapes come from the CLI's source and the OpenAPI spec | untestable: live atlassian-cli merge |
| `forge-bitbucket-live-api` | FORGES § What each mode answers | Passthrough `bb api` shapes (`participants[].state`, `/conflicts`, `/statuses`) behave against a live Bitbucket Cloud workspace | untestable: live Bitbucket API |
| `forge-passthrough-vs-gitlab` | FORGES § What each mode answers | Passthrough beats GitLab on changes-requested and on merge strategy (`rebase_merge` accepted) and matches it elsewhere except the review queue | unit: test/unit/engine/pr/bb/rest.test.ts |
| `forge-caps-resolve` | FORGES § 4. Conventions | A forge whose capability depends on its CLI states the weaker mode in static `caps` and the truth from `resolveCaps()`; only `deckView`'s awaited accessor sees the live one | unit: test/unit/engine/pr/bb/provider.test.ts |
| `forge-webview-import-constraint` | FORGES § 2. The one hard constraint | Nothing under `src/engine/forge/` is reachable from a browser bundle; `conditions.ts`, `branchCi.ts` and `armability.ts` are pinned by walking the real import graph | unit: test/webview/webviewGraph.test.ts |
| `forge-review-body-never-error` | FORGES § 4. Conventions | A rejection's `stderr` is preferred over `.message`, which embeds the body; the timeout branch keeps its distinct wording | unit: test/unit/engine/review/provider.test.ts |

## Providers × Surfaces

| id | doc | claim | proof |
|----|-----|-------|-------|
| `provider-claude-code` | SETTINGS § Where the session opens | `agentFlow.agentProvider: claude-code` (the default) seeds the real Claude Code panel in the opened window | e2e: seeds the real Claude Code panel in the opened window |
| `provider-copilot` | SETTINGS § Where the session opens | `copilot` opens the real Copilot Chat panel in agent mode with the prompt pre-filled | e2e: opens the real chat panel instead of the clipboard fallback |
| `provider-copilot-vscode-only` | SETTINGS § table | `copilot` works only in VS Code and falls back to Claude Code in Cursor | untestable: real Cursor app automation |
| `provider-cursor` | SETTINGS § Where the session opens | On a cursor-scheme host, `cursor` really runs `cursor-agent` in the seeded terminal | e2e: really runs cursor-agent in the seeded terminal |
| `provider-cursor-fallback` | SETTINGS § table | `cursor` degrades to Claude Code on a VS Code host | e2e: degrades to Claude Code on a VS Code host |
| `provider-ask` | SETTINGS § table | `ask` prompts per launch; a batch asks once and uses the answer for every task; Orchestrator rules and the unattended seed use Claude Code | e2e: asks which tool per launch |
| `provider-codex` | SETTINGS § table | `codex` runs the Codex CLI in a terminal in any editor and seeds the prompt unsubmitted | e2e: runs the codex CLI and seeds the prompt unsubmitted |
| `provider-codex-extension` | SETTINGS § table | `codex` under the extension surface still seeds a terminal — there is no panel to pre-fill | e2e: still seeds a terminal — there is no panel to pre-fill |
| `surface-extension` | SETTINGS § Where the session opens | `agentFlow.agentSurface: extension` (default) pre-fills the tool's chat panel | e2e: the take seeds the real Claude Code panel |
| `surface-terminal` | SETTINGS § Where the session opens | `terminal` opens an integrated terminal named `Claude · <KEY>` running the CLI with the prompt pre-typed | e2e: into a real integrated terminal |
| `surface-terminal-no-cli` | SETTINGS § Where the session opens | Without `claude` on PATH the terminal says `command not found` and the prompt is still there to reuse | e2e: no CLI on PATH says command not found |
| `surface-press-enter` | SETTINGS § Where the session opens | Either way the prompt is pre-filled, not submitted — you press Enter | e2e: seeds the real Claude Code panel |
| `surface-copilot-batch` | SETTINGS § Where the session opens | A batch under Copilot's `extension` surface seeds no chat panel (Copilot Chat is single-instance), writes every brief and shows a notification pointing at them | e2e: a Copilot extension-surface batch writes every brief |
| `surface-all-launch-paths` | SETTINGS § Where the session opens | Both surfaces work for every launch path — take, batch, Explore, Notepad, Address PR | e2e: the opened window seeds the agent prompt |
| `provider-x-live-cards` | SETTINGS § table | A Copilot run's card carries no session, because the Deck reads Claude Code's session files and Copilot writes none | e2e: a Copilot run gets the backbone but no session |
| `provider-x-live-cards-cursor` | SETTINGS § table | The same holds for Cursor | untestable: a Cursor session writes no `~/.claude/sessions` record, so the fixture would be the identical empty-registry setup as the Copilot row above — the harness cannot distinguish "Cursor wrote nothing" from "nothing ran" |
| `provider-x-remote-control` | SETTINGS § Remote Control | Remote Control needs Claude Code; under Copilot, `on` refuses the launch and `ask` skips the picker | e2e: Copilot with Remote Control on refuses the launch |
| `provider-x-marketplace` | GUIDE § The Marketplace | The Marketplace browses Claude Code's ecosystem whatever `agentFlow.agentProvider` says | todo |
| `provider-x-review-button-label` | GUIDE § The Deck | The review button names the configured tool: Review with Claude Code / Cursor / Copilot | todo |
| `provider-x-doctor-rows` | SETTINGS § table | Doctor reports rows for whichever provider is in play, every host tool under `ask` | todo |
| `provider-none-fallback` | README § Quick start | With no coding tool installed the task brief is still written and the prompt lands on the documented clipboard fallback | e2e: lands on the documented clipboard fallback |
| `provider-seed-agent-off` | SETTINGS § table | `agentFlow.seedAgent: false` opens the workspace and writes the brief and run record but seeds no session and no plan file | unit: test/unit/engine/workspace.test.ts |
| `provider-seed-time-resolution` | SETTINGS § table | Provider and surface are resolved at seed time in the target window, never from the plan file, so a flipped setting changes plans already on disk | unit: test/unit/engine/workspace.test.ts |

## Settings

| id | doc | claim | proof |
|----|-----|-------|-------|
| `set-task-source` | SETTINGS § table | `agentFlow.taskSource` picks the connector (`jira` default, `agileAccelerator`, `fixture` under the E2E env) and requires a reload | e2e: a real host boots the extension and the pool renders |
| `set-jira-base-url` | README § Settings | `agentFlow.jira.baseUrl` is the Jira Cloud site the connector signs in to and reads from | e2e: signing in round-trips through SecretStorage and signing out |
| `set-jira-project` | README § Settings | `agentFlow.jira.project` is the project key the pool is built from and the key a local card's branch is matched against | todo |
| `set-agile-accelerator-instance-url` | package.json | `agentFlow.agileAccelerator.instanceUrl` is the Lightning URL the connector links work items to | e2e: reads work items through a real `sf` |
| `set-agile-accelerator-team` | package.json | `agentFlow.agileAccelerator.team` bounds every query to your scrum team | e2e: the Agile Accelerator connector reads work items through |
| `set-agile-accelerator-target-org` | package.json | `agentFlow.agileAccelerator.targetOrg` names the `sf` org alias, blank for the default org | e2e: Agile Accelerator connector reads work items through a real |
| `set-stamp-label-on-write` | SETTINGS § table | `agentFlow.stampLabelOnWrite: false` skips the provenance label on a task write (`task-provenance-label` proves the default-on stamp; `review-writes` the session-drafted review marker) | e2e: stampLabelOnWrite off skips the provenance label |
| `set-provenance-label` | SETTINGS § table | `agentFlow.provenanceLabel` (default `claude-code`) is the label stamped on task writes | e2e: provenanceLabel names the label that is stamped |
| `set-repos-root` | SETTINGS § table | `agentFlow.reposRoot` is where repo checkouts are discovered for inference and briefs | e2e: taking a task opens a real window and lands the brief |
| `set-workspace-dir` | SETTINGS § table | `agentFlow.workspaceDir` is where generated `.code-workspace` files go | e2e: writes <KEY>.code-workspace into workspaceDir |
| `set-github-org` | SETTINGS § table | `agentFlow.githubOrg` is reserved — clone support is not implemented | untestable: documented absence |
| `set-repo-blocklist` | SETTINGS § table | `agentFlow.repoBlocklist` names directories under `reposRoot` to exclude from discovery; hidden dirs are always skipped | unit: test/unit/engine/repos.test.ts |
| `set-workspace-mode` | package.json | `agentFlow.workspaceMode` decides how repos open: `auto`, `multiroot` (a `<KEY>.code-workspace` in `workspaceDir`) or per-window | e2e: multiroot mode writes <KEY>.code-workspace |
| `set-open-in` | SETTINGS § Where a task opens | `agentFlow.openIn`: `ask`, `new-window`, `this-window` or `pick-existing` | e2e: openIn "ask" lists a new window |
| `set-worktree` | SETTINGS § table | `agentFlow.worktree` isolates the task in a git worktree at `.claude/worktrees/<KEY>`, git-excluded | e2e: worktree mode takes the task in a real git worktree |
| `set-child-worktrees` | package.json | `agentFlow.childWorktrees` offers a worktree per child or one orchestrator session when a ticket has children | e2e: taking a parent offers its tree |
| `set-track-open-windows` | SETTINGS § table | `agentFlow.trackOpenWindows` lists your open Agent Flow windows as destinations; off, no live windows are read | unit: test/unit/engine/openTarget.test.ts |
| `set-default-filter` | SETTINGS § table | `agentFlow.defaultFilter` is the lens the panel opens on | e2e: defaultFilter picks the lens the panel opens on |
| `set-refetch-interval-minutes` | package.json | `agentFlow.refetchIntervalMinutes` refetches the current lens in the background without a spinner, stops while hidden, `0` turns it off | todo |
| `set-filters-size` | GUIDE § What it does | `agentFlow.filters.size: false` hides the size lens | e2e: filters.size false hides the size lens even when the connector has estimates |
| `set-filters-status` | GUIDE § What it does | `agentFlow.filters.status: false` hides the status chip row | e2e: filters.status false hides the status lens |
| `set-filters-repo` | GUIDE § What it does | `agentFlow.filters.repo: false` hides the repo multiselect | e2e: filters.repo false hides the repo lens |
| `set-filters-search` | package.json | `agentFlow.filters.search: false` hides the fuzzy title search box | e2e: filters.search false hides the search box |
| `set-seed-agent` | SETTINGS § table | `agentFlow.seedAgent` pre-fills the session's panel or terminal after opening | unit: test/unit/engine/workspace.test.ts |
| `set-agent-provider` | SETTINGS § table | `agentFlow.agentProvider`: `claude-code`, `copilot`, `cursor`, `codex` or `ask`, each falling back to Claude Code where the editor cannot run it | e2e: a batch under "ask" asks once |
| `set-agent-surface` | SETTINGS § table | `agentFlow.agentSurface`: `extension` for the chat panel, `terminal` for the CLI | e2e: the opened window seeds the agent prompt into a real integrated terminal |
| `set-task-mode` | SETTINGS § table | `agentFlow.taskMode` pins one prompt mode by `id` so no picker shows | e2e: a custom prompt mode lands its prompt |
| `set-prompt-modes` | SETTINGS § table | `agentFlow.promptModes` layers over the six built-ins: override by `id`, `hidden: true` drops one, a custom mode's prompt is what the take seeds (the plan handshake's prompt — `.pick-task/TASK.md` itself never carries the mode's prompt, brief.ts) | e2e: a promptModes entry overrides a built-in's label |
| `set-remote-control` | SETTINGS § Remote Control | `agentFlow.remoteControl`: `off`, `on` or `ask` | e2e: Remote Control pre-fills the slash command |
| `set-batch-launch-confirm-threshold` | GUIDE § What it does | `agentFlow.batchLaunchConfirmThreshold` (default 6): larger task or review batches confirm first | e2e: a batch larger than the threshold asks first |
| `set-explore-prompt` | package.json | `agentFlow.explorePrompt` is the legacy Explore prompt, migrated into the knowledge action when customized | unit: test/unit/config.test.ts |
| `set-explore-mode` | SETTINGS § table | `agentFlow.exploreMode` pins one Explore action or `ask` shows the picker | e2e: an explorePrompts override lands in the plan |
| `set-explore-prompts-jira-ticket` | package.json | `agentFlow.explorePrompts.jiraTicket` is the prompt for Open a Jira ticket | todo |
| `set-explore-prompts-knowledge` | package.json | `agentFlow.explorePrompts.knowledge` is the prompt for Enhance knowledge / flow | todo |
| `set-explore-prompts-debug` | package.json | `agentFlow.explorePrompts.debug` is the prompt for Debug | todo |
| `set-explore-prompts-general` | package.json | `agentFlow.explorePrompts.general` is the prompt for General, and the one a Notepad run borrows | e2e: an explorePrompts override lands in the plan |
| `set-explore-prompts-supervise` | package.json | `agentFlow.explorePrompts.supervise` is the prompt for Supervise running tasks, whose brief lists your other active tasks | todo |
| `set-explore-prompts-verify` | package.json | `agentFlow.explorePrompts.verify` is the read-only prompt for Verify on an environment with `{env}` | e2e: a verify session is seeded read-only against the chosen environment |
| `set-explore-slack-dm` | package.json | `agentFlow.exploreSlackDm` per action asks the session to send a Slack DM summary when it ends (off by default) | todo |
| `set-environments` | SETTINGS § table | `agentFlow.environments` are offered by Verify on an environment, plus Custom… | e2e: Verify on an environment asks which, from the environments setting plus Custom |
| `set-deck-show-token-total` | package.json | `agentFlow.deck.showTokenTotal` adds a Tokens on board header total (off by default) | todo |
| `set-open-agents` | SETTINGS § table | `agentFlow.openAgents` shows every Claude Code session on this machine, on cards and as `local` cards | e2e: openAgents off removes local cards without reopening the panel |
| `set-deck-grouping` | SETTINGS § table | `agentFlow.deckGrouping`: `agents` (one card per session) or `workspaces`; the board's control writes it | e2e: the Sessions / Workspaces grouping sticks across a reopen |
| `set-retire-finished-after-hours` | SETTINGS § table | `agentFlow.retireFinishedAfterHours` (24) keeps landed work on the board after its last session closes | unit: test/unit/engine/retire.test.ts |
| `set-retire-abandoned-after-days` | SETTINGS § table | `agentFlow.retireAbandonedAfterDays` (7) retires a ticketless, PR-less, clean run; `0` disables | unit: test/unit/engine/retire.test.ts |
| `set-retire-closed-after-hours` | SETTINGS § table | `agentFlow.retireClosedAfterHours` (24) keeps a closed run in Recently closed before its record is deleted | e2e: a run past its retire window is swept off the board |
| `set-retire-in-place-after-hours` | SETTINGS § table | `agentFlow.retireInPlaceAfterHours` (0) is the window for a finished Explore or Notepad card | unit: test/unit/engine/retire.test.ts |
| `set-inflight-show-all` | SETTINGS § table | `agentFlow.inflightShowAll` renders every run record as a card and retires nothing for being closed | e2e: inflightShowAll renders every record as a card |
| `set-notify-on-action-required` | SETTINGS § table | `agentFlow.notifyOnActionRequired` notifies once when a run parks | e2e: coalescing several |
| `set-orchestrator` | SETTINGS § table | `agentFlow.orchestrator` shows the Deck's Orchestrator drawer | e2e: an attached workflow is a real flow in the Workflows drawer, and Detach |
| `set-never-auto-run` | ORCHESTRATOR_COMMANDS § Never, whatever you approved | `agentFlow.neverAutoRun` patterns outrank every approval | unit: test/unit/engine/orchestrator/neverAutoRun.test.ts |
| `set-commands` | GUIDE § The Deck | `agentFlow.commands` entries (`id`, `label`, `run`, `detail`) feed the command picker; Save to settings appends to it | todo |
| `set-forge` | SETTINGS § table | `agentFlow.forge`: `github`, `gitlab` or `bitbucket`; everything that reads a PR goes through it | e2e: the Deck card shows the MR the GitLab forge reports |
| `set-pr-facts` | SETTINGS § table | `agentFlow.prFacts` reads PR state onto Deck cards through the forge CLI | e2e: Deck card shows the PR the GitHub forge reports for the run's branch |
| `set-pr-facts-ttl-seconds` | SETTINGS § table | `agentFlow.prFactsTtlSeconds` (120, minimum 30) is how stale a cached PR fact may be; fetched only while the Deck is open | unit: test/unit/engine/pr/store.test.ts |
| `set-pr-review-status` | SETTINGS § table | `agentFlow.prReviewStatus` (case-insensitive) gates the sidebar's Address PR button, not the Deck's | e2e: Address PR appears only when the status matches prReviewStatus |
| `set-pr-review-auto-fix` | SETTINGS § table | `agentFlow.prReviewAutoFix: false` makes the Address PR session assess only | e2e: prReviewAutoFix off seeds an assess-only prompt |
| `set-pr-review-prompt` | SETTINGS § table | `agentFlow.prReviewPrompt` is the Address PR kick-off prompt, with a fixing instruction appended when auto-fix is on | e2e: a custom prReviewPrompt is what gets seeded |
| `set-review-requests` | SETTINGS § table | `agentFlow.reviewRequests` shows the Deck's review-requests strip | todo |
| `set-review-requests-always-visible` | package.json | `agentFlow.reviewRequestsAlwaysVisible: false` hides the strip while no PR is waiting | todo |
| `set-review-requests-ttl-seconds` | SETTINGS § table | `agentFlow.reviewRequestsTtlSeconds` (300, minimum 60) is how stale the cached queue may be | unit: test/unit/engine/review/store.test.ts |
| `set-review-writes` | SETTINGS § table | `agentFlow.reviewWrites` (off) allows approve / comment / request changes from the Deck | e2e: reviewWrites off shows no submit buttons |
| `set-merge-writes` | SETTINGS § table | `agentFlow.mergeWrites` (off) shows Merge on a provably ready card | e2e: mergeWrites off shows no Merge button on a ready PR |
| `set-merge-method` | SETTINGS § table | `agentFlow.mergeMethod`: `squash`, `merge` or `rebase`, named in the dialog every time | e2e: mergeMethod is named in the dialog and passed to gh |
| `set-review-request-modes` | SETTINGS § table | `agentFlow.reviewRequestModes` layers your review modes over Full review | todo |
| `set-review-request-mode` | SETTINGS § table | `agentFlow.reviewRequestMode` pins one review mode so no picker shows | e2e: launching a review opens its worktree |
| `set-review-open-in` | SETTINGS § table | `agentFlow.reviewOpenIn` ships as `new-window`; `this-window`, `pick-existing` or `ask` | e2e: launching a review opens its worktree, brief |
| `set-pr-work-open-in` | SETTINGS § table | `agentFlow.prWorkOpenIn`: `ask` or `its-window` for Fix CI / Resolve conflict / Address review | e2e: prWorkOpenIn its-window asks nothing |
| `set-review-request-prompt` | package.json | `agentFlow.reviewRequestPrompt` overrides the review prompt; empty uses the built-in default | todo |
| `set-telemetry-enabled` | TELEMETRY § Turning it off | `agentFlow.telemetry.enabled` (true) is re-read per event; off discards the in-memory queue | unit: test/unit/telemetry/telemetry.test.ts |
| `open-in-pick-existing` | SETTINGS § Where a task opens | `pick-existing` opens the task into a chosen `.code-workspace`: same-name folders are skipped and named in the toast, new repos are added only after approval, declining leaves the file byte-identical | e2e: pick-existing adds only approved repos |
| `open-in-this-window` | SETTINGS § Where a task opens | `this-window` never replaces what is open; a window Agent Flow cannot name is not offered This window, and `this-window` opens a new window instead | e2e: this-window in a window it cannot name |
| `open-in-live-windows` | SETTINGS § Where a task opens | Under `ask` the picker lists open windows; a workspace window offers to add new repos, a folder window is focused and seeded without new roots | unit: test/unit/engine/openTarget.test.ts |
| `three-questions-model` | SETTINGS § Where the session opens | `agentFlow.openIn` decides the window, `agentFlow.agentProvider` the tool, `agentFlow.agentSurface` what starts it | e2e: the take seeds the real Claude Code panel in the opened |

## Telemetry & Privacy

| id | doc | claim | proof |
|----|-----|-------|-------|
| `tel-two-switches` | TELEMETRY § Turning it off | Both `agentFlow.telemetry.enabled` and VS Code's `telemetry.telemetryLevel` must allow an event; either off stops all sending | unit: test/unit/telemetry/telemetry.test.ts |
| `tel-own-setting` | TELEMETRY § Turning it off | The setting is re-read for each event; turning it off discards the in-memory queue and the first-run notice offers Turn off | unit: test/unit/telemetry/notice.test.ts |
| `tel-vscode-level` | TELEMETRY § Turning it off | At `"error"` only `operation_failed` and `unhandled_error` are sent; at `"off"` nothing | unit: test/unit/telemetry/posthog.test.ts |
| `tel-destination` | TELEMETRY § Where it goes | Events go to a personal PostHog project at `eu.i.posthog.com` over batched HTTPS; the queue is memory-only | untestable: telemetry delivery |
| `tel-never-collected` | TELEMETRY § What is never collected | No ticket keys, project keys, summaries, repo names, paths, prompt text, error messages or user-authored setting values are ever sent | unit: test/unit/telemetry/settingsSnapshot.test.ts |
| `tel-stack-digest` | TELEMETRY § What is never collected | `stack_digest` keeps only the extension's own frames, truncated to 20 frames and 2,048 bytes | unit: test/unit/telemetry/posthog.test.ts |
| `tel-distinct-id` | TELEMETRY § Identity | `distinct_id` is `vscode.env.machineId`; nothing is minted | unit: test/unit/telemetry/identity.test.ts |
| `tel-session-id` | TELEMETRY § Identity | `session_id` is `vscode.env.sessionId` on every event | unit: test/unit/telemetry/identity.test.ts |
| `tel-task-fingerprint` | TELEMETRY § Identity | `task_fp` is a salted SHA-256 of the ticket key truncated to 16 hex chars; the per-install salt is never transmitted | unit: test/unit/telemetry/identity.test.ts |
| `tel-auto-properties` | TELEMETRY § The event catalog | Every event carries `session_id`, `env_type`, `app_name`, `app_host`, `remote_name`, `ui_kind`, `distinct_id` | unit: test/unit/telemetry/posthog.test.ts |
| `tel-usage-events` | TELEMETRY § Usage events | The 33-event catalog — take, batch, deck, review, merge, explore, flow, marketplace, tasks, notepad, setup, doctor — matches `src/telemetry/events.ts` | unit: test/unit/telemetry/docs.test.ts |
| `tel-error-events` | TELEMETRY § Error events | `operation_failed` carries `op`, `failure_class`, `retryable`; `unhandled_error` carries `error_class` and `stack_digest` | unit: test/unit/telemetry/events.test.ts |
| `tel-failure-class` | TELEMETRY § Error events | `failure_class` derives from `.name` and well-known `.code` fields only, never the message | unit: test/unit/telemetry/telemetry.test.ts |
| `tel-retryable` | TELEMETRY § Error events | `retryable` derives from `failure_class` (`auth`, `not_found`, `permission`, `parse` are not); batch per-key catches and the Deck's catch-all hardcode `false` | unit: test/unit/telemetry/telemetry.test.ts |
| `tel-double-report` | TELEMETRY § A failing Take can report twice | A Deck-started Take failure fires both `take_completed{failed}` and `operation_failed`; a palette Take fires only the former | unit: test/unit/telemetry/telemetryWiring.test.ts |
| `tel-unhandled-error-source` | TELEMETRY § Error events | `unhandled_error` is routed by `vscode.TelemetryLogger`, not called by Agent Flow's own code | untestable: telemetry delivery |
| `tel-settings-snapshot` | TELEMETRY § Settings snapshot | `extension_activated` carries a 43-field reduction of booleans, counts and shipped choices, never a user string | unit: test/unit/telemetry/settingsSnapshot.test.ts |
| `tel-invalid-sentinel` | TELEMETRY § Settings snapshot | Eleven enum fields report the literal `"invalid"` for a hand-edited value, never the raw value or a mapped default | unit: test/unit/telemetry/settingsSnapshot.test.ts |
| `tel-customized-flags` | TELEMETRY § Settings snapshot | `explore_prompts_customized`, `environments_customized`, `pr_review_prompt_customized` say only whether text changed | unit: test/unit/telemetry/settingsSnapshot.test.ts |
| `tel-command-telemetry-limit` | ORCHESTRATOR_COMMANDS § Numbers | Telemetry about commands is `commands_count` only — never an id, label or `run` string | unit: test/unit/telemetry/settingsSnapshot.test.ts |
| `tel-drift-test` | TELEMETRY § Keeping this page true | A drift test asserts every event name in `events.ts` appears in TELEMETRY.md (names only, not row contents) | unit: test/unit/telemetry/docs.test.ts |
| `priv-your-services-only` | PRIVACY | Nothing about your tickets, code or repos is sent to any service that is not already yours | untestable: negative network claim with no sink in the lane |
| `priv-no-forge-credentials` | PRIVACY | Agent Flow stores no forge credentials; every forge call inherits `gh`'s own host, SSO and token | unit: test/unit/compat.test.ts |
| `priv-secretstorage` | PRIVACY | Jira credentials live in VS Code SecretStorage, never in `settings.json` | e2e: signing in round-trips through SecretStorage and signing out re-gates |
| `priv-read-only-default` | README § Privacy | Jira and the forge are read-only by default; the only writes are ones you trigger — with `agentFlow.reviewWrites` off, an expanded review row offers no way to write at all (`set-merge-writes` is the merge half, `priv-read-only-review-modal` the modal) | e2e: reviewWrites off shows no submit buttons |
| `priv-read-only-review-modal` | README § Privacy | With `agentFlow.reviewWrites` on, a review submit reaches the forge only through a modal confirmation | e2e: Approve confirms with the verb, repo and number before gh pr review runs |
| `priv-open-agents-reads` | PRIVACY | With `agentFlow.openAgents` on the Deck reads `~/.claude/sessions`, and with `agentFlow.prFacts` also on runs `gh pr list` in a live session's directory even one you never pointed it at | todo |
| `priv-review-strip-shared-gate` | PRIVACY | `agentFlow.reviewRequests` only produces a forge read while `agentFlow.prFacts` is on | e2e: turning prFacts off drops PR facts and darkens the review strip live |
| `priv-doctor-probes` | PRIVACY | Doctor makes two authenticated GETs and runs `gh auth status`, and writes nothing except the clipboard when asked to copy | todo |
| `priv-pick-task-excluded` | PRIVACY | Briefs go in a git-excluded `.pick-task/`, so they are never committed | e2e: the brief directory is git-excluded |
| `priv-output-channel-log` | PRIVACY | Every review submit that reaches the forge is logged to the Agent Flow Deck output channel (`priv-output-channel-merge` is the merge half, `priv-output-channel-review-failure` the failure half) | e2e: Approve confirms with the verb, repo and number before gh pr review runs |
| `priv-output-channel-review-failure` | PRIVACY | A review submit the forge rejects is logged too, with the CLI's own wording and none of the review body | e2e: a rejected submit shows the CLI's stderr, never the body |
| `priv-output-channel-merge` | PRIVACY | A merge that reaches the forge is logged to the Agent Flow Deck output channel with the strategy it used | e2e: Merge confirms with the repo, number and strategy, then runs gh pr merge |

## Meta

| id | doc | claim | proof |
|----|-----|-------|-------|
| `req-editor-version` | README § Requirements | VS Code or Cursor `^1.90.0`; the lane boots the extension on a pinned real host | e2e: a real host boots the extension |
| `install-paths` | README § Quick start | Install from the Marketplace, Open VSX, `code --install-extension <vsix>`, or Install from VSIX… | untestable: installation runs through the Marketplace or a VSIX outside the harness |
| `no-org-defaults` | README § Quick start | The extension ships no organization-specific defaults; `agentFlow.jira.baseUrl` and `agentFlow.jira.project` default to `""` and the wizard collects them | todo |
| `status-v1-deferred` | README § Status | Deferred: OAuth web sign-in, cloning not-yet-checked-out repos, multi-project | untestable: documented absence |
| `feedback-templates` | README § Feedback | The bug-report form asks for a Doctor report; security issues go through a private advisory | untestable: GitHub issue-form templates are repository metadata, not extension behaviour |
| `reach-dashboard` | REACH § Where the dashboard lives | The reach dashboard is GitHub Pages served from the `reach-data` branch, regenerated on every collection run | untestable: maintainer tooling, not shipped |
| `reach-range-filter` | REACH § The range filter | A preset the store cannot answer is disabled with a title, not hidden; lifetime counters show the change inside the range and need two samples; rankings are a single dated snapshot; ranges count back from the newest recorded day | unit: test/unit/reach/rangeFilter.test.ts |
| `reach-bootstrap-branch` | REACH § Before the first run | The orphan `reach-data` branch must be created once by the owner or every run fails silently | untestable: maintainer tooling, not shipped |
| `reach-collected-sources` | REACH § What is collected | Views, clones, referrers, paths, stars, Open VSX and VS Marketplace downloads, each from its endpoint into its file | unit: test/unit/reach/sources.test.ts |
| `reach-never-write-zero` | REACH § The rules | A failed fetch writes nothing for that run, never `0`; parsers throw on anything unconfirmed | unit: test/unit/reach/collect.test.ts |
| `reach-merge-rule` | REACH § The rules | `mergeDaily` overwrites every date the API returns and keeps every date it does not, so a run inside 14 days loses nothing | unit: test/unit/reach/merge.test.ts |
| `reach-corrupt-loud` | REACH § The rules | A missing store file returns the fallback; an unparseable one throws | unit: test/unit/reach/store.test.ts |
| `reach-downloads-not-people` | REACH § The rules | Download counts include CI installs and updates; the dashboard says so | unit: test/unit/reach/render.test.ts |
| `reach-unrecoverable` | REACH § What cannot be recovered | Views and clones before the first successful run are gone permanently | untestable: maintainer tooling, not shipped |
| `reach-two-tokens` | REACH § Tokens | Traffic endpoints need a PAT with `Administration: read`; stars and marketplaces use the built-in token | untestable: maintainer tooling, not shipped |
| `reach-failure-issue` | REACH § When the collector stops | A failing run opens or comments on a `reach: the collector is failing` issue and closes it on the next success | untestable: maintainer tooling, not shipped |
| `reach-stale-banner` | REACH § When the collector stops | The page shows a warning banner once `meta.lastRun` is two or more days old | unit: test/unit/reach/staleBanner.test.ts |
| `reach-schedule-caveats` | REACH § Scheduling caveats | GitHub disables the cron after 60 quiet days; a daily schedule leaves margin inside the 14-day window | untestable: maintainer tooling, not shipped |
| `gap-no-sixth-tab` | CONNECTORS § 3. The capability table | `"all"` in `supportedFilters` never renders as a sixth tab | e2e: the "all" filter never renders as a sixth tab |
| `gap-no-microphone` | GUIDE § The Notepad | Agent Flow ships no microphone button; a webview cannot reach the microphone | untestable: documented absence |
| `gap-notify-messages-nobody` | GUIDE § The Deck | A notify node sends no Slack DM or email — only a VS Code notification | untestable: documented absence |
| `gap-no-branch-ci-picker` | ORCHESTRATOR_COMMANDS § You cannot | `branch CI passed`, `session idle over…` and `ticket status is…` have no picker and must be hand-written; hand-authored rules render and run | untestable: documented absence |
| `gap-no-cwd-picker` | ORCHESTRATOR_COMMANDS § You cannot | `cwdRepo` has no control in the UI | untestable: documented absence |
| `gap-no-join-all-ui` | ORCHESTRATOR_COMMANDS § You cannot | A node's `join` is always "any" from the drawer; the model's "all" has no UI | unit: test/unit/engine/orchestrator/evaluate.test.ts |
| `gap-no-schedule-outside-editor` | ORCHESTRATOR_COMMANDS § You cannot | Nothing runs on a schedule outside the editor; closing the Deck stops the pass | untestable: documented absence |
| `gap-no-env-control` | ORCHESTRATOR_COMMANDS § You cannot | No env-var editing, shell choice or argument array — one string in the host's environment | untestable: documented absence |
| `gap-act-record-not-atomic` | ORCHESTRATOR_COMMANDS § The latch | If the write after a successful command fails, the command ran but nothing was stamped and the next pass runs it again | untestable: documented absence |
| `gap-windows-shell` | ORCHESTRATOR_COMMANDS § Not yet proven | On Windows the command runs through `cmd.exe` with `windowsHide` | untestable: Windows shell |
| `gap-note-injection-by-design` | ORCHESTRATOR_COMMANDS § With what text | `{note}` is spliced in unquoted; quoting the template does not close it off | unit: test/unit/engine/orchestrator/command.test.ts |
| `gap-ask-brief-names-claude` | SETTINGS § table | Under `agentFlow.agentProvider: ask` a single take, an Orchestrator child task and a one-key own-window batch write the brief before the picker, so it names Claude Code whichever tool was picked | todo |
| `gap-gitlab-no-changes-requested` | FORGES § 3. What GitLab and Bitbucket cannot answer | GitLab exposes no changes-requested state; `review` never reads it | untestable: documented absence |
| `gap-bitbucket-no-review-queue` | FORGES § Bitbucket has two modes | Bitbucket Cloud has no reviewer-side cross-repo query, so no passthrough build fixes the missing strip | untestable: documented absence |
| `gap-in-open-sprint-overload` | CONNECTORS § 3. The capability table | `Task.inOpenSprint` has no honest no-sprint value; a sprintless source reports `false` | untestable: documented absence |
| `gap-status-category-localized` | CONNECTORS § 7. The inherited assumptions | `statusCategory != Done` matches a localized display name; a rejection would surface a raw API error rather than degrade | unit: test/unit/tasks/jira/jql.test.ts |
| `gap-config-shared-surface` | CONNECTORS § 7. The inherited assumptions | `AgentFlowConfig.baseUrl` and `.project` are Jira's despite their generic names; `SourceInfo.endpoint` and `.scopeValue` are the source-agnostic reads | unit: test/unit/config.test.ts |
| `gap-accounts-github-com-only` | FORGES § 3. What GitLab and Bitbucket cannot answer | `accounts()` reads only `github.com`, so a GHE user sees a footer about the wrong host | untestable: documented absence |
