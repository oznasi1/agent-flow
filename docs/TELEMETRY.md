# Telemetry

Agent Flow can send anonymous **usage** and **error** events to help decide what to
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

- **`agentFlow.telemetry.enabled`** (default `true`) — Agent Flow's own setting.
  Turn it off in Settings, or click **Turn off** on the first-run notice, and
  nothing further is sent for this install. Turning it off mid-session discards
  whatever is currently queued in memory rather than flushing it first. The check
  sits in the sender's queueing step, which every event crosses — including
  `unhandled_error`, which VS Code hands to the sender itself without Agent Flow's
  own code being involved. Turning the setting back on resumes sending in the same
  window; the setting is re-read for each event rather than captured at startup.
- **`telemetry.telemetryLevel`** — VS Code's own built-in setting, which Agent
  Flow always honours regardless of its own setting above. At `"off"`, nothing is
  sent. At `"error"`, only the two error events below (`operation_failed`,
  `unhandled_error`) are sent — no usage events at all. At `"all"` (the default),
  both usage and error events are sent, subject to `agentFlow.telemetry.enabled`.

## Where it goes

Events are sent to a personal PostHog project (not an At-Bay project, and not
shared with or accessible to At-Bay) at `https://eu.i.posthog.com`, batched over
plain HTTPS POST requests. The queue holding not-yet-sent events lives in memory
only — it is never written to disk, so a window close before the next flush loses
whatever was still queued rather than persisting it anywhere.

## What is never collected

Regardless of any setting, Agent Flow never sends:

- Jira ticket keys, Jira project keys, or Jira summaries/descriptions
- Repo names, file paths, folder paths, or anything about your workspace layout
- Prompt text (the text sent to Claude Code)
- Error **messages** (`error.message`) — these routinely embed paths, ticket keys
  and other content, so only an error's class name and a stripped stack are ever
  sent (see [Errors](#errors--operation_failed-and-unhandled_error) below)
- The value of any user-authored setting — `baseUrl`, `project`, `githubOrg`,
  `reposRoot`, `workspaceDir`, `provenanceLabel`, `prReviewStatus`,
  `reviewRequestModes`, or any of the `*Prompt` / `promptModes` /
  `explorePrompts.*` content. Where a setting like this matters for the product
  decisions this data informs, only a derived, non-identifying fact is sent — e.g.
  `prompt_modes_customized: true`, not the customized text; `repo_blocklist_count:
  3`, not which repos. See [`settingsSnapshot.ts`](../src/telemetry/settingsSnapshot.ts)
  for the exact reduction.

On the "no paths" point specifically: nothing is ever sent that names a path to
your files, folders, repos, or workspace. The one string that is path-*shaped* is
`unhandled_error`'s `stack_digest`, which can contain the token
`dist/extension.js` — but that is the extension's own bundled file, identical
across every install of Agent Flow, and carries nothing about you or your
machine. Stack frames from anywhere else (VS Code itself, other extensions, your
code) are filtered out before the digest is built, and what remains is then
truncated to at most 20 frames and 2,048 bytes (`MAX_STACK_FRAMES` /
`MAX_STACK_BYTES` in `posthog.ts`) — see `stackDigest()` in `posthog.ts`.

## Identity

- **`distinct_id`** is `vscode.env.machineId` — VS Code's own anonymous, stable
  per-machine identifier. Agent Flow mints no identifier of its own.
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
the same for an event Agent Flow sends deliberately and for an `unhandled_error`
VS Code routes to the sender on its own.

### Usage events

Suppressed entirely when `telemetry.telemetryLevel` is `"error"` (or lower).

| Event | Properties | When |
|---|---|---|
| `extension_installed` | *(none)* | Once per machine, on the first activation ever. |
| `extension_activated` | `is_first_ever: boolean`, `has_jira_auth: boolean`, `is_configured: boolean`, plus the full settings snapshot (see [Settings snapshot](#settings-snapshot) below) | Every activation, after the sign-in check resolves. |
| `command_invoked` | `command`: one of `"refresh"`, `"setup"`, `"doctor"`, `"signIn"`, `"signOut"`, `"takeTask"`, `"openDeck"`, `"openMarketplace"` | Whenever one of Agent Flow's commands runs. |
| `take_started` | `flow_id: string` (random UUID), `source`: `"card"` (a Deck card's Take button, expanded or not) \| `"command"` (the `agentFlow.takeTask` palette command) \| `"batch"`, `task_fp: string`, `inferred_count: number` | A Take begins. `source` is passed in by whichever entry point started the Take, not inferred. `"batch"` is reserved and unused today: `takeBatch` is not instrumented in Phase 1, so no event carries it. |
| `take_prompt_mode_picked` | `flow_id`, `prompt_mode`: a stock mode id (`"plan"`, `"implementation"`, `"tdd"`, `"investigate"`, `"orchestrator"`, `"refine"`) or `"custom"`, `is_custom_mode: boolean` | The prompt mode for this Take is resolved. |
| `take_destination_picked` | `flow_id`, `destination`: `"new"` \| `"current"` \| `"existing"` \| `"live-folder"`, `workspace_mode`: `"multiroot"` \| `"per-window"` | The open target for this Take is resolved. |
| `take_repos_picked` | `flow_id`, `repo_count: number`, `repo_source`: `"preselected"` \| `"destination"` \| `"quickpick"`, `accepted_inference?: boolean`, `inferred_count: number` | The repo set for this Take is resolved. `accepted_inference` is present only for the `"quickpick"` source, where it's meaningful; omitted (not `false`) otherwise, so "inference never ran" stays distinguishable from a genuine rejection. |
| `take_completed` | `flow_id`, `outcome`: `"launched"` \| `"cancelled"` \| `"failed"`, `destination?`, `prompt_mode`, `repo_count`, `duration_ms: number`, `used_worktree?: boolean`, `failure_class?` (see [Errors](#errors--operation_failed-and-unhandled_error)), `task_fp` | The Take funnel ends, one way or another — this is the funnel terminator. `used_worktree` is the decision actually applied, which on the shipped `agentFlow.worktree: "ask"` default is the user's answer to a QuickPick; it is omitted (not `false`) when the Take ended before that question was answered, so "never asked" stays distinguishable from "asked, declined". |

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
`failure_class` itself.

`unhandled_error` is not something Agent Flow's own code calls explicitly —
it's VS Code's built-in behavior: `vscode.TelemetryLogger` automatically routes
any exception that escapes unhandled from within the extension host process to
the registered logger's error path, with the stack already cleaned of
cross-extension detail by VS Code itself before Agent Flow's own filtering (see
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
  whose catch block (`tasksView.ts:330-335`) is what emits `operation_failed`,
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

### Settings snapshot

`extension_activated` includes a 29-field reduction of your configuration,
built by `settingsSnapshot()`. Every field is either a boolean, a count, or a
value drawn from a fixed, shipped set of choices — never a user-authored string:

| Field | Values |
|---|---|
| `workspace_mode`, `open_in`, `explore_mode`, `worktree`, `remote_control`, `default_filter` | One of that setting's shipped choices, or the literal string `"invalid"` |
| `task_mode`, `review_mode` | `"ask"`, `"stock"` (pinned to a shipped mode), or `"custom"` |
| `seed_agent`, `filters_size`, `filters_status`, `filters_repo`, `filters_search`, `pr_review_auto_fix`, `pr_facts`, `review_requests`, `open_agents`, `review_writes`, `stamp_label_on_write`, `track_open_windows` | `true` / `false` |
| `batch_confirm_threshold`, `repo_blocklist_count`, `prompt_modes_count`, `review_modes_count` | Numbers |
| `prompt_modes_customized`, `explore_prompts_customized`, `environments_customized`, `pr_review_prompt_customized`, `review_modes_customized` | `true` / `false` — *whether* the corresponding user-authored text was changed from the shipped default, never the text itself |

**The `"invalid"` sentinel.** Six of the fields above (`workspace_mode`,
`open_in`, `explore_mode`, `worktree`, `remote_control`, `default_filter`) can
report the literal string `"invalid"` instead of a real value. VS Code's
settings UI only ever offers the shipped choices for these, but a hand-edited
`settings.json` can hold anything. When it does, the raw value is **never**
transmitted and never silently mapped to a real default (e.g. `"auto"`) either
— `"invalid"` marks it as "this install has an unrecognised value here" without
saying what that value is, so that case stays distinguishable from a user who
genuinely left the setting at its default.

## Keeping this page true

This page describes the event catalog as it stands in this repo, not a particular
release: no version is stamped here, because a hard-coded number goes stale the
moment the next version ships. If the event catalog changes, this file (and the
drift test that checks it, `test/unit/telemetry/docs.test.ts`) must change with it.
