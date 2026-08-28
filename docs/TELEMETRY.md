# Telemetry

Agent Flow Deck can send anonymous **usage** and **error** events to help decide what to
build next — which features get used, where a flow gets abandoned, what fails and
how often. This page is the complete, accurate account of that system: every
claim below is checkable against the three source files it is drawn from —
[`src/telemetry/events.ts`](../src/telemetry/events.ts) (the event catalog),
[`src/telemetry/posthog.ts`](../src/telemetry/posthog.ts) (the sender), and
[`src/telemetry/settingsSnapshot.ts`](../src/telemetry/settingsSnapshot.ts) (the
settings reduction). If this document and the code ever disagree, the code wins —
and a drift test (`test/unit/telemetry/docs.test.ts`) fails the build if a new
event is added here without being documented.

## Turning it off

Two independent switches gate everything below. Either one turned off stops all
sending — telemetry code only runs when **both** are satisfied.

- **`agentFlow.telemetry.enabled`** (default `true`) — Agent Flow Deck's own setting.
  Turn it off in Settings, or click **Turn off** on the first-run notice, and
  nothing further is sent for this install. Turning it off mid-session discards
  whatever is currently queued in memory rather than flushing it first. The check
  sits in the sender's queueing step, which every event crosses — including
  `unhandled_error`, which VS Code hands to the sender itself without Agent Flow Deck's
  own code being involved. Turning the setting back on resumes sending in the same
  window; the setting is re-read for each event rather than captured at startup.
- **`telemetry.telemetryLevel`** — VS Code's own built-in setting, which Agent
  Flow always honours regardless of its own setting above. At `"off"`, nothing is
  sent. At `"error"`, only the two error events below (`operation_failed`,
  `unhandled_error`) are sent — no usage events at all. At `"all"` (the default),
  both usage and error events are sent, subject to `agentFlow.telemetry.enabled`.

## Where it goes

Events are sent to the author's personal PostHog project — not an organization's
project, and not shared with or accessible to any employer — at
`https://eu.i.posthog.com`, batched over
plain HTTPS POST requests. The queue holding not-yet-sent events lives in memory
only — it is never written to disk, so a window close before the next flush loses
whatever was still queued rather than persisting it anywhere.

## What is never collected

Regardless of any setting, Agent Flow Deck never sends:

- Jira ticket keys, Jira project keys, or Jira summaries/descriptions
- Repo names, file paths, folder paths, or anything about your workspace layout
- Prompt text (the text sent to Claude Code)
- Error **messages** (`error.message`) — these routinely embed paths, ticket keys
  and other content, so only an error's class name and a stripped stack are ever
  sent (see [Errors](#errors--operation_failed-and-unhandled_error) below)
- The value of any user-authored setting — `baseUrl`, `project`, `githubOrg`,
  `reposRoot`, `workspaceDir`, `provenanceLabel`, `prReviewStatus`,
  `reviewRequestModes`, `commands`, or any of the `*Prompt` / `promptModes` /
  `explorePrompts.*` content. Where a setting like this matters for the product
  decisions this data informs, only a derived, non-identifying fact is sent — e.g.
  `prompt_modes_overridden: 1`, not the customized text; `repo_blocklist_count:
  3`, not which repos; `commands_count: 2`, never a command's `id`, `label`, or
  `run` string, since a command's `run` is arbitrary shell that can carry
  hostnames, tokens or internal URLs. See
  [`settingsSnapshot.ts`](../src/telemetry/settingsSnapshot.ts) for the exact
  reduction.

On the "no paths" point specifically: nothing is ever sent that names a path to
your files, folders, repos, or workspace. The one string that is path-*shaped* is
`unhandled_error`'s `stack_digest`, which can contain the token
`dist/extension.js` — but that is the extension's own bundled file, identical
across every install of Agent Flow Deck, and carries nothing about you or your
machine. Stack frames from anywhere else (VS Code itself, other extensions, your
code) are filtered out before the digest is built, and what remains is then
truncated to at most 20 frames and 2,048 bytes (`MAX_STACK_FRAMES` /
`MAX_STACK_BYTES` in `posthog.ts`) — see `stackDigest()` in `posthog.ts`.

## Identity

- **`distinct_id`** is `vscode.env.machineId` — VS Code's own anonymous, stable
  per-machine identifier. Agent Flow Deck mints no identifier of its own.
- **`session_id`** is `vscode.env.sessionId` — VS Code's own per-editor-session
  identifier, attached to every event.
- **Fingerprints** (`task_fp` on the Take-funnel events) are a salted SHA-256
  hash of the Jira ticket key, truncated to 16 hex characters. The salt is
  generated once per install (`crypto.randomUUID()`), stored in that install's
  local extension state, and **never transmitted**. Two installs hashing the
  same ticket key produce different fingerprints, so hashes are comparable only
  *within* a single install's event stream (e.g. "did this same ticket's Take
  fail twice?") — cross-user or cross-install aggregation of a fingerprint is
  impossible by construction, not merely avoided by policy.

## The event catalog

Ten event types ship today. Every property not listed under "always attached
automatically" below is specific to the event named.

Attached automatically to **every** event, usage and error alike: `session_id`,
`env_type` (`"production"` or `"development"`), `app_name`, `app_host`,
`remote_name` (or `"local"`), `ui_kind` (`"web"` or `"desktop"`), and
`distinct_id`. These describe the editor environment, never anything about your
project. They are attached by the sender as it queues each event, so the count is
the same for an event Agent Flow Deck sends deliberately and for an `unhandled_error`
VS Code routes to the sender on its own.

### Usage events

Suppressed entirely when `telemetry.telemetryLevel` is `"error"` (or lower).

| Event | Properties | When |
|---|---|---|
| `extension_installed` | *(none)* | Once per machine, on the first activation ever. |
| `extension_activated` | `is_first_ever: boolean`, `has_jira_auth: boolean`, `is_configured: boolean`, plus the full settings snapshot (see [Settings snapshot](#settings-snapshot) below) | Every activation, after the sign-in check resolves. |
| `command_invoked` | `command`: one of `"refresh"`, `"setup"`, `"doctor"`, `"signIn"`, `"signOut"`, `"takeTask"`, `"openDeck"`, `"openMarketplace"` | Whenever one of Agent Flow Deck's commands runs. |
| `take_started` | `flow_id: string` (random UUID), `source`: `"card"` (a Deck card's Take button, expanded or not) \| `"command"` (the `agentFlow.takeTask` palette command) \| `"batch"`, `task_fp: string` | A Take begins. `source` is passed in by whichever entry point started the Take, not inferred. `"batch"` is reserved and unused today: `takeBatch` is not instrumented in Phase 1, so no event carries it. Not every Take emits this: a card **or command** Take that becomes a fan-out or an orchestrator take — possible whenever `agentFlow.childWorktrees` is on, which it is by default — routes away before the funnel opens and emits no funnel events at all, so `take_started` volume falls as that setting is adopted rather than because Takes stopped; the settings snapshot's `child_worktrees` field is how to correlate the two. |
| `take_prompt_mode_picked` | `flow_id`, `prompt_mode`: a stock mode id (`"plan"`, `"implementation"`, `"tdd"`, `"investigate"`, `"orchestrator"`, `"refine"`) or `"custom"`, `is_custom_mode: boolean` | The prompt mode for this Take is resolved. |
| `take_destination_picked` | `flow_id`, `destination`: `"new"` \| `"current"` \| `"existing"` \| `"live-folder"`, `workspace_mode`: `"multiroot"` \| `"per-window"` | The open target for this Take is resolved. |
| `take_repos_picked` | `flow_id`, `repo_count: number`, `repo_source`: `"preselected"` \| `"destination"` \| `"quickpick"`, `accepted_inference?: boolean`, `inferred_count: number` | The repo set for this Take is resolved. `"destination"` covers every destination that already has folders — an existing workspace, another open window, or this window. `accepted_inference` is present only for the `"quickpick"` source, where it's meaningful; omitted (not `false`) otherwise, so "inference never ran" stays distinguishable from a genuine rejection. |
| `take_completed` | `flow_id`, `outcome`: `"launched"` \| `"cancelled"` \| `"failed"`, `destination?`, `prompt_mode?`, `repo_count`, `duration_ms: number`, `used_worktree?: boolean`, `failure_class?` (see [Errors](#errors--operation_failed-and-unhandled_error)), `task_fp` | The Take funnel ends, one way or another — this is the funnel terminator. `used_worktree` is the decision actually applied, which on the shipped `agentFlow.worktree: "ask"` default is the user's answer to a QuickPick; it is omitted (not `false`) when the Take ended before that question was answered, so "never asked" stays distinguishable from "asked, declined". `prompt_mode` is omitted when the Take is cancelled before a mode was chosen, so a genuine `"custom"` pick stays distinguishable from no decision at all. |
| `batch_started` | `flow_id`, `keys_count: number`, `is_fanout: boolean` (a `parent` argument is present — this batch is a fan-out under one ticket), `tree_mode?`: `"fanout"` \| `"orchestrator"` \| `"parent"` (present only when this batch was reached through `chooseTreeMode`'s fan-out picker) | `takeBatch` begins, right after the `keys.length === 0` no-op guard. A plain multi-select batch and a one-key "batch" (really a single launch) omit `tree_mode`, since no tree-mode picker ran for either. |
| `batch_completed` | `flow_id`, `outcome`: `"launched"` \| `"cancelled"` \| `"failed"`, `attempted`, `launched`, `failed: number`, `prompt_mode?`, `destination?`, `layout?`: `"separate"` \| `"shared"`, `layout_asked: boolean`, `duration_ms: number` | The batch funnel's terminator — exactly one fires per `takeBatch` call, from whichever exit it reaches: a declined sign-in, an over-threshold confirmation declined, the prompt-mode/destination/layout/Remote-Control/agent pickers dismissed, and a mid-loop dismissal that abandons the rest of the batch all report `"cancelled"`; no usable repos among the filtered set reports `"failed"`; the ordinary end of the loop reports `"launched"` when at least one task launched, else `"failed"`. `prompt_mode`/`destination`/`layout` are omitted until the corresponding picker has actually resolved — same discipline as `take_completed`. `layout_asked` is `true` only when `target.kind === "new" && keys.length > 1` raised the layout QuickPick; `layout` itself is present only then. Never carries a ticket key or repo name. |
| `deck_opened` | `revealed: boolean` (an already-open Deck refocused vs a freshly built panel), `forge: string` (a registry-validated forge id, or `"invalid"` — same sentinel as the settings snapshot's `forge`), `pr_facts`, `open_agents`, `review_queue`, `orchestrator: boolean`, `flow_count: number`, `has_armed_flow: boolean` | Every time the Deck command opens the panel, whether that reveals the existing one or constructs a new one. |
| `deck_action` | `action`: one of `"refresh"`, `"clear_stale"`, `"switch_account"`, `"set_grouping"`, `"inspect_open"`, `"inspect_diff"`, `"forget"`, `"track"`, `"usage"`, `"open_external"`; `grouping?`: `"agents"` \| `"workspaces"` (present only for `set_grouping`) | Whenever the Deck webview sends a click-shaped message — read-plumbing messages like `deck:reviewExpand` are not actions and emit nothing here. |
| `review_launched` | `outcome`: `"launched"` \| `"cancelled"` \| `"failed"`; `mode`: `"ask"` \| `"stock"` \| `"custom"` (the PromptMode actually picked or pinned for this launch, not merely the raw `reviewRequestMode` setting); `mode_was_pinned: boolean` (`resolveReviewMode` resolved it without asking); `destination?`: `"new"` \| `"current"` \| `"existing"` \| `"live-folder"` (single launches only); `provider?`: `"claude-code"` \| `"copilot"` \| `"cursor"` (single launches only, the agent actually seeded); `seeded_in_place?: boolean` (single, successful launches only); `batch: boolean`; `requested_count`, `launched_count`, `failed_count`, `skipped_count: number`; `layout?`: `"separate"` \| `"shared"` (batch only); `layout_asked?: boolean` (batch only — whether the layout QuickPick was actually raised) | A single review launch ends (one of `LaunchReviewResult`'s three arms, or the mode/destination picker dismissed first) or a batch review launch ends. Exactly one event per user gesture — a batch never emits one per PR. |
| `review_submitted` | `verb`: `"approve"` \| `"comment"` \| `"request-changes"`; `from_draft: boolean`; `outcome`: `"ok"` \| `"cancelled"` \| `"failed"` | Mirrors the outcome already computed for the `deck:reviewSubmitDone` message the webview receives — never the review body itself. |
| `pr_merged` | `outcome`: `"ok"` \| `"cancelled"` \| `"failed"` \| `"refused"`; `merge_method?`: `"squash"` \| `"merge"` \| `"rebase"` (present only once a merge was actually attempted — absent for every refusal and for a declined confirm); `refusal?`: `"writes-off"` \| `"facts-off"` \| `"no-run"` \| `"local"` \| `"target-mismatch"` \| `"no-checkout"` \| `"in-flight"` | A card's Merge button is clicked. Every one of `mergePr`'s own re-checked gates refuses before anything reaches the forge and reports its own `refusal` — never the repo name or PR number the message carried. |
| `pr_work_seeded` | `reason`: `"ci"` \| `"conflict"` \| `"review"`; `source`: `"deck"` \| `"tasks"`; `outcome`: `"seeded"` \| `"seeded-in-place"` \| `"opened-not-seeded"` \| `"open-failed"` \| `"cancelled"` \| `"refused"`; `window_count`, `failed_repo_count: number`; `agent_seeded: boolean` (`cfg.seedAgent`) | A PR-work re-seed (Fix CI / Resolve conflict / Address review, or the sidebar's Address PR) ends. `source` distinguishes the Deck card's `seedPrWork` from the sidebar's `addressPr` — two separate code paths that share no telemetry seam. Never carries the ticket key, repo names, or PR number. |
| `explore_started` | `flow_id`; `mode`: one of `"jiraTicket"`, `"knowledge"`, `"debug"`, `"general"`, `"supervise"`, `"verify"`, or `"custom"` (a user-authored `agentFlow.exploreActions` id collapses to this); `source`: `"command"` (the Explore command/action picker) \| `"notepad"` (a notepad item's Run button, which always carries `mode: "general"`, the topic-agnostic action it borrows) | Fires once a mode actually exists: right after the Explore action picker resolves, or immediately for a notepad run (whose mode is fixed). |
| `explore_completed` | `flow_id`; `outcome`: `"launched"` \| `"cancelled"` \| `"failed"`; `mode` (same vocabulary as `explore_started`); `cancel_point?`: `"remote-control"` \| `"repos"` \| `"action"` \| `"topic"` \| `"env"` \| `"kickoff"` \| `"agent"` (present only for `outcome: "cancelled"`); `env_picked?`: `"listed"` \| `"custom"` (present only when the "verify" action's environment step ran); `destination?`; `provider?`; `seeded_in_place?: boolean`; `repo_count`, `duration_ms: number`; `failure_class?` | The Explore/notepad-run funnel's terminator — exactly one per call, from whichever exit it reaches. The two pre-mode cancels (`"remote-control"`, `"repos"`) report the CONFIGURED mode (`agentFlow.exploreMode`, `"ask"` collapsed to `"custom"`) rather than a picked one, since no mode has been chosen yet — `explore_started` does not fire for those two. The topic, slug, and environment name are user strings and never sent; `env_picked` records only listed-vs-custom, never the name itself. |
| `flow_action` | `action`: one of `"create"`, `"rename"`, `"save"`, `"delete"`, `"add_planned"`, `"reset_edge"`, `"resume_approve"`, `"resume_disarm"`, `"save_command"`, `"dry_run"`; `node_count?`, `edge_count?` (present for `save`); `edge_count?`, `fired_count?`, `blocked_count?` (present for `dry_run`) | One per orchestrator gesture that actually did something — a message naming a flow the host does not hold is refused and emits nothing. For `dry_run`, `blocked_count` is every *pending* rule that would not fire on this pass (waiting, held by the launch cap, unobservable, or configured with a blank parameter), so `fired_count + blocked_count` need not equal `edge_count`: a rule that has already fired is in neither. The flow's id, its name, the command text saved by `save_command` and every rule's own configuration stay on the machine. |
| `flow_armed` | `armed: boolean`; `node_count`, `edge_count: number`; `unfirable_live`, `unfirable_pr_facts`, `unfirable_forge: number`; `source`: `"toggle"` (the drawer's Arm button) \| `"resume-banner"` (Disarm on a held flow) \| `"auto-skip"` | A flow is armed or disarmed. The three `unfirable_*` counts are the split of rules that can never fire as configured — the same numbers the arm warning shows — and are reported only where the code computes them, which is an arm from the toggle; every disarm reports zeroes, because nothing computes armability when a flow is being switched off. `"auto-skip"` is not a gesture: it is a poll in flight noticing that the flow was disarmed under it (from another window, say) and stopping before it spends anything — at most one per flow per pass, however many rules that pass had left to act on. |
| `flow_edge_fired` | `edge_action`: `"launch"` \| `"seed"` \| `"notify"` \| `"run"`; `ok: boolean`; `deferred: boolean`; `dest?`: `"worktree"` \| `"new-window"` \| `"current-window"`; `prompt_mode?` (same vocabulary as `take_prompt_mode_picked`); `repo_count?: number` | One per rule an armed flow actually performed — at most three per six-second pass (the per-pass launch cap), never one per evaluation, and never for a rule merely stamped alongside one that acted. `deferred: true` means a pre-flight read failed, so nothing was spent and a later pass retries; `ok: false` with `deferred: false` is a rule that tried and latched. The launch trio (`dest`, `prompt_mode`, `repo_count`) comes from the planned node the rule points at and is present for launches only. `"notify"` is reserved and unused: a notify spends nothing and is not performed through this seam. Never carries the ticket key, the repo names, the command, or the receipt text. |
| `flow_settled` | `node_count`, `edge_count: number` | The flow has nothing left to do — every rule has fired or errored. Derived rather than stored (the flow model has no terminal state) and emitted on the transition only, so a finished flow left armed on the board does not re-report itself on every poll. |
| `marketplace_opened` | `revealed: boolean`; `asset_count`, `plugin_count`, `marketplace_count: number`; `skills`, `commands`, `agents`, `hooks: number` (`view.assets` grouped by `AssetType`); `not_set_up: boolean` | Every open of the Marketplace panel. `revealed: true` is an already-open panel refocused, reporting the last scan's counts kept on the panel instance; `revealed: false` fires once, at the first `render()` this panel instance completes — never on a later re-render (a stale re-focus, `mkt:refresh`). |
| `marketplace_action` | `action`: one of `"open"`, `"reveal"`, `"read"`, `"copy"`, `"open_external"`; `allowed?: boolean` (present for `"open"`/`"reveal"` — whether the file was on the last scan's allow-list, emitted whether or not the case goes on to act); `truncated?: boolean` (present for `"read"` only, once the file was actually read — a refused read emits nothing) | Every `onMessage` click-shaped gesture on the Marketplace panel. No file path, asset name, or URL is ever a property. |
| `tasks_fetched` | `filter` (requested, same vocabulary as `default_filter`'s non-sentinel values): `"unassigned"` \| `"mine"` \| `"mysprint"` \| `"sprint"` \| `"backlog"` \| `"all"`; `lens` (same vocabulary — what `effectiveFilter` actually clamped `filter` to); `size`: `"any"` \| `"s"` \| `"m"` \| `"l"`; `task_count`, `repo_count: number`; `live_window_count?: number` (present only when `agentFlow.trackOpenWindows` is on); `authed: boolean` | Every `fetch` — this **is** the lens-usage signal, since a lens/tab change re-fetches. `filter` and `lens` differ exactly when a webview left open across a `taskSource` change asks for a lens the new source cannot serve. The unauthenticated early return (no provider to clamp against) reports `lens` equal to the requested `filter`, zero counts, and `authed: false`. |
| `lens_used` | `lens`: `"repo"` \| `"search"` | The webview's own secondary-lens signal — a repo-multiselect pick or a title-search edit — debounced 500ms per lens kind in the webview (one timer for each) so a run of keystrokes or toggles reports once. Sent via the `tasks:lensUsed` wire message; the host validates the enum and silently drops anything else. |
| `card_action` | `action`: one of `"detail"`, `"change_status"`, `"add_to_sprint"`, `"remove_from_sprint"`, `"set_component"`, `"reorder"`, `"reset_order"` | One per card affordance click in the tasksView switch. `"reorder"`/`"reset_order"` fire only once the gesture actually applies (a `reorder` outside the My-sprint lens is ignored and emits nothing). Never carries the ticket key, repo name, or component name. |
| `notepad_action` | `action`: one of `"add"`, `"run"`, `"edit"`, `"remove"`, `"reorder"`, `"image_add"`, `"image_remove"` | One per notepad gesture that maps onto this enum: `notepad:add` → `add`; `notepad:update` → `edit`; `notepad:delete` → `remove`; `notepad:reorder` → `reorder` (only once the drop actually changes the saved order); `notepad:run` → `run` (the notepad's own `explore_started{source:"notepad"}` still fires separately, from inside `runNotepadItem`); `notepad:addImage` and `notepad:pickImage` → `image_add` (paste and file-picker are two paths to the same gesture); `notepad:removeImage` → `image_remove`. `notepad:toggleDone`, `notepad:clearCompleted`, `notepad:resetOrder`, the section messages, and `notepad:openImage` have no corresponding member and emit nothing here. Note text, section names and image names never appear. |

### Error events

Still delivered even at `telemetry.telemetryLevel: "error"`.

| Event | Properties |
|---|---|
| `operation_failed` | `op`: one of `"jira_fetch"`, `"jira_write"`, `"jira_auth"`, `"git_worktree"`, `"repo_inference"`, `"pr_lookup"`, `"review_fetch"`, `"workspace_write"`, `"agent_seed"`, `"marketplace_read"`; `failure_class` (below); `retryable: boolean` |
| `unhandled_error` | `error_class: string` (the thrown value's `Error.name`, e.g. `"TypeError"`), `stack_digest: string` (see [What is never collected](#what-is-never-collected)) |

`failure_class` is one of `"auth"`, `"network"`, `"not_found"`, `"permission"`,
`"conflict"`, `"timeout"`, `"parse"`, `"unknown"` — derived only from a thrown
error's `.name` and well-known `.code` fields (e.g. `ETIMEDOUT`, `ENOTFOUND`),
never from its message.

`retryable` is *derived from* `failure_class` (`auth`, `not_found`,
`permission`, and `parse` are not retryable; everything else is) — it is not an
independent judgement call about the specific failure, just a query
convenience so "was this worth retrying" doesn't need a `failure_class` lookup
table re-derived in every dashboard. It adds no information beyond
`failure_class` itself. The one exception: `takeBatch`'s three internal per-key
catches (resolving a task, the shared-window path, and the per-window launch
loop) always report `retryable: false` — these failures are swallowed
per-task, with no "retry" affordance the button that logged them could offer,
unlike the `onMessage`-level catch the derived value describes.

`unhandled_error` is not something Agent Flow Deck's own code calls explicitly —
it's VS Code's built-in behavior: `vscode.TelemetryLogger` automatically routes
any exception that escapes unhandled from within the extension host process to
the registered logger's error path, with the stack already cleaned of
cross-extension detail by VS Code itself before Agent Flow Deck's own filtering (see
[What is never collected](#what-is-never-collected)) runs on top of that.

### A failing Take can report twice, on purpose

`take_completed{ outcome: "failed", failure_class, task_fp, flow_id }` fires
when a Take fails — it is the funnel terminator, carrying `flow_id` so the whole
Take can be reconstructed. Exactly one `take_completed` follows every
`take_started`, whatever happens in between and however the Take was started:
every step after `take_started` — the prompt-mode pick, the ticket read, the
destination and repo picks, the launch — runs inside the same `try`, so a Jira
failure while reading the ticket terminates the funnel as a *failure* rather than
looking like the user walking away. Whether a second, separate `operation_failed{
op, failure_class, retryable }` also fires for that same failure depends on the
entry point:

- **Started from the Deck** (a card's Take button): the failure is
  thrown back through `TasksViewProvider.onMessage`'s webview dispatcher,
  whose catch block (`tasksView.ts:879-889`) is what emits `operation_failed`,
  attributing the failure to a subsystem (`op`) so failures can be aggregated
  across every code path that can fail that way, not just Takes. **Both**
  events fire for the same failure here — reading them as two separate
  incidents rather than one failure described from two angles would
  over-count.
- **Started from the command palette** (`agentFlow.takeTask` in
  `extension.ts`): the command handler calls `TasksViewProvider.takeTask()`
  directly, with no equivalent try/catch around it. A failure here is
  reported only as `take_completed{ outcome: "failed" }` — `operation_failed`
  does not fire, because nothing on this path calls `trackError`.

### A batch's per-key failures are swallowed, on purpose

`takeBatch` never lets one task's failure abort the rest — its three internal
`catch` blocks (resolving a task, the shared-window path, and the per-window
launch loop) each push the key onto a `failed` list and keep going, so they
never reach `TasksViewProvider.onMessage`'s own catch (`tasksView.ts:879-889`)
— `MESSAGE_OPS.takeBatch`'s mapping to `"workspace_write"` is unreachable for
this per-key path in practice. Each swallowed catch instead emits its own
`operation_failed{ op: "workspace_write", failure_class, retryable: false }`
directly, so a per-task failure is still visible without waiting for
`batch_completed`'s aggregate `failed` count — the same "both fire" doubling
the Take funnel accepts above, not a second classification of a different
failure.

### Settings snapshot

`extension_activated` includes a 43-field reduction of your configuration,
built by `settingsSnapshot()`. Every field is either a boolean, a count, or a
value drawn from a fixed, shipped set of choices — never a user-authored string:

| Field | Values |
|---|---|
| `workspace_mode`, `open_in`, `review_open_in`, `agent_provider`, `agent_surface`, `explore_mode`, `worktree`, `remote_control`, `default_filter`, `task_source`, `forge` | One of that setting's shipped choices, or the literal string `"invalid"` |
| `task_mode`, `review_mode` | `"ask"`, `"stock"` (pinned to a shipped mode), or `"custom"` |
| `merge_method` | One of `"squash"`, `"merge"`, `"rebase"` — never `"invalid"` in practice: `getConfig()` itself already collapses an unrecognized `agentFlow.mergeMethod` to `"squash"` before this snapshot ever sees it |
| `seed_agent`, `filters_size`, `filters_status`, `filters_repo`, `filters_search`, `pr_review_auto_fix`, `pr_facts`, `review_requests`, `open_agents`, `review_writes`, `merge_writes`, `orchestrator`, `child_worktrees`, `stamp_label_on_write`, `track_open_windows` | `true` / `false` |
| `batch_confirm_threshold`, `repo_blocklist_count`, `commands_count`, `prompt_modes_count`, `review_modes_count`, `prompt_modes_overridden`, `prompt_modes_custom`, `prompt_modes_hidden`, `review_modes_overridden`, `review_modes_custom`, `review_modes_hidden` | Numbers |
| `explore_prompts_customized`, `environments_customized`, `pr_review_prompt_customized` | `true` / `false` — *whether* the corresponding user-authored text was changed from the shipped default, never the text itself |

**The `"invalid"` sentinel.** Eleven of the fields above (`workspace_mode`,
`open_in`, `review_open_in`, `agent_provider`, `agent_surface`, `explore_mode`, `worktree`,
`remote_control`, `default_filter`, `task_source`, `forge`) can report the literal
string `"invalid"` instead of a real value. VS Code's settings UI only ever
offers a valid choice for these — the shipped enum for most of them, or, for
`task_source`/`forge`, whichever task connectors/forges are actually registered — but a
hand-edited `settings.json` can hold anything. When it does, the raw value is
**never** transmitted and never silently mapped to a real default (e.g.
`"auto"`) either — `"invalid"` marks it as "this install has an unrecognised
value here" without saying what that value is, so that case stays
distinguishable from a user who genuinely left the setting at its default.

## Keeping this page true

This page describes the event catalog as it stands in this repo, not a particular
release: no version is stamped here, because a hard-coded number goes stale the
moment the next version ships. If the event catalog changes, this file (and the
drift test that checks it, `test/unit/telemetry/docs.test.ts`) must change with it.
