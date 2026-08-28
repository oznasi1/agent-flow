# Usage analytics Phase 2 — design

Successor to [the Phase 1 design](2026-07-31-usage-analytics-design.md), which shipped the
telemetry facade (`src/telemetry/`), the typed event catalog, the PostHog sender, consent
gates, and the single-Take funnel. Phase 1 left the extension blind to everything else:
nothing in `deckView.ts`, `marketplaceView.ts`, `setup.ts`, `doctorView.ts`, or anywhere
under `src/engine/` emits telemetry today.

This phase instruments the remaining surfaces — the eight groups sketched at the end of
[the Phase 1 plan](../plans/2026-07-31-usage-analytics.md#phase-2--sketch-not-part-of-this-plan),
refreshed against today's code and extended to the orchestrator and the newer Deck actions
(merge, batch review, dry run) that shipped since the sketch was written. It also folds in
the four data-fidelity fixes recorded in
[the follow-ups doc](../plans/2026-08-01-usage-analytics-follow-ups.md), so the new events
are born on corrected primitives.

## Goals

Answer, from production data, the questions Phase 1 cannot:

- Do people use the Deck at all, and which of its actions? Is the review queue used, and do
  batch reviews happen?
- Is the orchestrator (a gated flagship feature) adopted — flows created, armed, actually
  firing edges — or only toyed with?
- Where do batch launches and Explores die, and how often do per-key batch failures happen
  (today they are swallowed silently)?
- Does setup complete, and where is it abandoned? What does Doctor find in the wild?
- Which task lenses do people live in, and do they ask for lenses their source cannot serve?

## Non-goals

- PostHog dashboards/insights (analysis happens in PostHog, not in this repo).
- New person-level identity or cohort properties.
- Marketplace tab/filter telemetry (pure webview state; low signal for a wire change —
  recorded as future work).
- Per-pass orchestrator evaluation events. A pass runs every 6 s; an armed-but-idle flow
  must cost zero events. Only fired edges and state changes are events.

## Principles (unchanged from Phase 1)

- Every string-typed property is a literal union; numbers and booleans otherwise. User
  strings — ticket keys, repo names, flow names, node notes, topics, env names, review
  bodies, shell commands, URLs, file paths, error messages — never enter an event. At most
  they pass through `fingerprint()`.
- `OPEN_STRING_PROPS` stays exactly `["flow_id", "error_class", "stack_digest"]`.
  `test/unit/telemetry/events.test.ts` freezes it; that freeze is the design.
- All events ride the existing consent gates (`agentFlow.telemetry.enabled` +
  `vscode.env.isTelemetryEnabled` via the sender and logger). No new setting.
- Everything is additive. The compat-frozen wire literals (`"jira_fetch"`, `"jira_write"`,
  `"jira_auth"`, `has_jira_auth`), the command-id list, and every shipped event's shape are
  untouched except where the follow-ups doc already adjudicated a fix (below).
- Engine modules stay pure. No `src/engine/**` file imports the telemetry facade; emits
  live in the host views that already orchestrate the engine calls.

## Event catalog

~23 new `UsageEvent` variants, hybrid-shaped: bespoke funnel events where a real funnel
exists (start/complete with `flow_id`, `duration_ms`, `outcome`), and one `*_action` event
with a typed action enum per click-shaped surface. Anchors verified against main on
2026-08-28.

### Deck

| Event | Properties | Anchor |
|---|---|---|
| `deck_opened` | `revealed: boolean` (existing panel refocused vs freshly constructed); `forge` (registry-validated id, `"invalid"` sentinel like the snapshot); `pr_facts`, `open_agents`, `review_queue`, `orchestrator: boolean`; `flow_count: number`; `has_armed_flow: boolean` | `DeckPanel.show()` — reveal branch `deckView.ts:485`, fresh `:495` |
| `deck_action` | `action:` `"refresh" \| "clear_stale" \| "switch_account" \| "set_grouping" \| "inspect_open" \| "inspect_diff" \| "forget" \| "track" \| "usage" \| "open_external"`; `grouping?: "agents" \| "workspaces"` (set_grouping only) | `onMessage` switch `deckView.ts:3396` |

`deck:reviewExpand`, `deck:reviewLoadDraft` and other read-plumbing messages are not
actions. Orchestrator (`flow:*`) messages get their own events below. A Deck-close event is
not worth a variant: `deck_opened` plus session boundaries answers dwell questions.

### Review

| Event | Properties | Anchor |
|---|---|---|
| `review_launched` | `outcome: "launched" \| "cancelled" \| "failed"`; `mode: TaskModeProp` (stock `"full"` vs `"custom"` via `modeProp()`); `mode_was_pinned: boolean` (`resolveReviewMode` hit vs picker); `destination?: DestinationProp`; `provider?: "claude-code" \| "copilot" \| "cursor"`; `seeded_in_place?: boolean`; `batch: boolean`; `requested_count: number`; `launched_count: number`; `failed_count: number`; `skipped_count: number`; `layout?: "separate" \| "shared"`; `layout_asked?: boolean` | single: `launchReviewFor` `deckView.ts:2287` (outcome from `LaunchReviewResult`'s three arms, `engine/review/launch.ts:67`); batch: `launchReviewBatch` `:2353`, emitted once at the `reviewBatchToast` terminal `:2528` |
| `review_submitted` | `verb: "approve" \| "comment" \| "request-changes"`; `from_draft: boolean`; `outcome: "ok" \| "cancelled" \| "failed"` | `submitReview` `deckView.ts:2558` — mirrors the `deck:reviewSubmitDone` outcome already computed |

One `review_launched` per user gesture: a batch emits one event with `batch: true` and the
counts, not one per item. The review body never leaves the machine.

### PR

| Event | Properties | Anchor |
|---|---|---|
| `pr_merged` | `outcome: "ok" \| "cancelled" \| "failed" \| "refused"`; `merge_method?: "squash" \| "merge" \| "rebase"`; `refusal?: "writes-off" \| "facts-off" \| "no-run" \| "local" \| "target-mismatch" \| "no-checkout" \| "in-flight"` | `mergePr` `deckView.ts:2693`; the six refusal branches `:2717–2755` |
| `pr_work_seeded` | `reason: "ci" \| "conflict" \| "review"`; `source: "deck" \| "tasks"`; `outcome: "seeded" \| "seeded-in-place" \| "opened-not-seeded" \| "open-failed" \| "cancelled" \| "refused"`; `window_count: number`; `failed_repo_count: number`; `agent_seeded: boolean` (`cfg.seedAgent`) | `seedPrWork` `deckView.ts:4026` (terminals `:4098–4113`); tasksView `addressPr` `:2944` reaches the same seam |

### Batch launch

| Event | Properties | Anchor |
|---|---|---|
| `batch_started` | `flow_id`; `keys_count: number`; `tree_mode?: "fanout" \| "orchestrator" \| "parent"` (from `chooseTreeMode`, present only when the fan-out fork ran); `is_fanout: boolean` (`parent` arg present) | `takeBatch` `tasksView.ts:2209`; fork `chooseTreeMode` `:2677` |
| `batch_completed` | `flow_id`; `outcome: "launched" \| "cancelled" \| "failed"`; `attempted: number`; `launched: number`; `failed: number`; `prompt_mode?: PromptModeProp`; `destination?: DestinationProp`; `layout?: "separate" \| "shared"`; `layout_asked: boolean`; `duration_ms: number` | terminals `tasksView.ts:2371–2383`, `:2509–2519`; the mid-loop `result.cancelled` break `:2483` is `outcome: "cancelled"` with partial counts |

Additionally each of `takeBatch`'s three internal catch blocks (`tasksView.ts:2364`,
`:2440`, `:2495`) emits `operation_failed { op: "workspace_write", failure_class:
classifyFailure(e), retryable }` — these failures are swallowed before reaching
`onMessage`'s catch today, so `MESSAGE_OPS.takeBatch` is currently dead for the per-key
path. `take_started.source: "batch"` stays reserved-unused; the batch funnel is these two
events, not a synthetic Take.

### Explore

| Event | Properties | Anchor |
|---|---|---|
| `explore_started` | `flow_id`; `mode: ExploreModeProp` (`"jiraTicket" \| "knowledge" \| "debug" \| "general" \| "supervise" \| "verify" \| "custom"` — lifted from the `SettingsSnapshot.explore_mode` vocabulary, unrecognised collapses to `"custom"`); `source: "command" \| "notepad"` | `explore()` `tasksView.ts:1288`; `runNotepadItem` `:1389` shares the tail |
| `explore_completed` | `flow_id`; `outcome: "launched" \| "cancelled" \| "failed"`; `cancel_point?: "remote-control" \| "repos" \| "action" \| "topic" \| "env" \| "kickoff" \| "agent"`; `mode: ExploreModeProp`; `env_picked?: "listed" \| "custom"`; `destination?: DestinationProp`; `provider?`; `seeded_in_place?: boolean`; `repo_count: number`; `duration_ms: number`; `failure_class?: FailureClass` | cancel points `tasksView.ts:1290–1371`; success `:1381` |

The topic, slug, and environment name are user strings and never sent; `env_picked`
records only listed-vs-custom.

### Orchestrator

| Event | Properties | Anchor |
|---|---|---|
| `flow_action` | `action: "create" \| "rename" \| "save" \| "delete" \| "add_planned" \| "reset_edge" \| "resume_approve" \| "resume_disarm" \| "save_command" \| "dry_run"`; for `save`: `node_count`, `edge_count`; for `dry_run`: `edge_count`, `fired_count`, `blocked_count` | `flow:*` cases `deckView.ts:3477–3699`; `dry_run` via the new `flow:dryRun` message |
| `flow_armed` | `armed: boolean`; `node_count`, `edge_count: number`; `unfirable_live`, `unfirable_pr_facts`, `unfirable_forge: number` (the `UnfirableRule.needs` split); `source: "toggle" \| "resume-banner" \| "auto-skip"` | `flow:arm` `deckView.ts:3559` (split `:3581`), `flow:resumeDisarm` `:3689`, mid-pass auto-skip `:926` |
| `flow_edge_fired` | `edge_action: "launch" \| "seed" \| "notify" \| "run"`; `ok: boolean`; `deferred: boolean`; `dest?: "worktree" \| "new-window" \| "current-window"`; `prompt_mode?: PromptModeProp`; `repo_count?: number` | `performEdge` dispatch `deckView.ts:1291`; outcome where `applyFired` stamps it `:1002` |
| `flow_settled` | `node_count`, `edge_count: number` | derived at `deckView.ts:1002`: `next.edges.every(isSettled)` transitioning to true — the model has no terminal state, so "settled" is computed, not stored |

Orchestrator flow ids are minted (not random UUIDs), so they are never sent — not even
fingerprinted; counts carry the analysis. `flow_edge_fired` fires at most
`MAX_LAUNCHES_PER_PASS` (3) times per 6 s pass, and only for armed flows with fresh
verdicts, so volume stays negligible.

### Marketplace

| Event | Properties | Anchor |
|---|---|---|
| `marketplace_opened` | `revealed: boolean`; on first render additionally: `asset_count`, `plugin_count`, `marketplace_count: number`; `skills`, `commands`, `agents`, `hooks: number` (by `AssetType`); `not_set_up: boolean` | reveal `marketplaceView.ts:20`, fresh at first `render()` completion `:69–85` |
| `marketplace_action` | `action: "open" \| "reveal" \| "read" \| "copy" \| "open_external"`; `allowed?: boolean`; `truncated?: boolean` | `onMessage` `marketplaceView.ts:96` |

The scan-failure catch at `marketplaceView.ts:74` emits `operation_failed { op:
"marketplace_read" }` — that `Op` member has existed unused since Phase 1. While in the
file: `openExternal` gains the same https/http scheme guard deckView already has
(`deckView.ts:3711`); the missing guard is an adjacent defect, fixed in passing.

### Tasks view

| Event | Properties | Anchor |
|---|---|---|
| `tasks_fetched` | `filter: Filter`-vocabulary (requested); `lens:` same vocabulary (after `effectiveFilter` clamp — requested ≠ lens is the "asked for an unsupported lens" signal); `size: "any" \| "s" \| "m" \| "l"`; `task_count`, `repo_count: number`; `live_window_count?: number`; `authed: boolean` | `fetch` case `tasksView.ts:677`, clamp `:688` |
| `lens_used` | `lens: "repo" \| "search"` | new `tasks:lensUsed` message, webview-debounced 500 ms |
| `card_action` | `action: "detail" \| "change_status" \| "add_to_sprint" \| "remove_from_sprint" \| "set_component" \| "reorder" \| "reset_order"`; `size?: Size` where the message carries it | cases `tasksView.ts:706–873` |
| `notepad_action` | `action: "add" \| "run" \| "edit" \| "remove" \| "reorder" \| "image_add" \| "image_remove"` | notepad cases `tasksView.ts:786–864` |

`tasks_fetched` fires on every lens/tab change by design — that is the lens-usage signal.
Item text and search queries never leave the webview.

### Setup and Doctor

| Event | Properties | Anchor |
|---|---|---|
| `setup_started` | `source: "offer" \| "command"`; `connector_steps: number` | `runSetup` `setup.ts:38`; offer prompt `maybeRunSetup` `:114` |
| `setup_completed` | `outcome: "complete" \| "cancelled-source" \| "cancelled-root" \| "signin-skipped" \| "deferred"`; `signed_in: boolean` | the four `abort()` reasons `setup.ts:16` mapped to the enum; complete `:87`; deferred `:122` |
| `doctor_run` | `fails`, `warns: number`; `outcome: "dismissed" \| "copied" \| "action"`; `action_kind?: "command" \| "setting" \| "extension" \| "external"` | `showDoctor` `doctorView.ts:196`; `summarize` counts `engine/doctor.ts:473`; interaction `doctorView.ts:202–212` |

Setup instrumentation is `track()` calls only — no globalState or config writes.
`test/unit/compat.test.ts:97–133` pins that a cancelled wizard performs zero
`getConfiguration().update` calls and leaves `SETUP_COMPLETE_KEY` unset; the events must
not disturb that. `signIn()` returns a bare boolean (it never throws), so `jira_auth`
outcome telemetry is binary; the compat-frozen `Op` member `"jira_auth"` remains available
for a future classified probe.

## Plumbing

**Deck error seam.** `deckView.onMessage` has no last-resort catch (tasksView's is at
`tasksView.ts:879`). Add one, with a `MESSAGE_OPS`-style map from `m.type` to `Op`, so
Deck failures emit `operation_failed` the way Tasks-view failures already do. The existing
`Op` union covers the needs (`pr_lookup`, `review_fetch`, `workspace_write`,
`marketplace_read`); no new members.

**Naming collision.** `DeckPanel` has a private method `track(key)` (`deckView.ts:3910`,
promotes a card). The telemetry import is aliased: `import { track as trackEvent } from
"./telemetry/telemetry"`.

**Wire additions.** Two new `InboundMessage` variants in `src/types.ts`:
`{ type: "flow:dryRun"; edges: number; fired: number; blocked: number }` posted by
`OrchestratorDrawer` after `previewFlow` (the host never learns a dry run happened today),
and `{ type: "tasks:lensUsed"; lens: "repo" | "search" }`, debounced 500 ms in the
webview. Both are additive; no released message changes shape. The webview payloads are
counts/enums only, and the host validates them (numbers coerced, unknown lens dropped)
before the values reach an event — webview input is untrusted.

**Where emits live.** Host views only, at the moment the outcome is known: `deck_opened`
in `DeckPanel.show()`, `review_launched` at the `LaunchReviewResult` consumer, batch
events at `takeBatch`'s terminals, orchestrator events where `deckView` calls into the
pure engine and gets results back. No engine module gains a telemetry import — the
webview-cannot-reach-Node invariant and the pure/`*Fs` split are unaffected.

## Phase 1 fidelity fixes (folded in)

All four adjudicated in the follow-ups doc:

1. **`take_completed.prompt_mode` becomes optional** and is omitted when the Take was
   cancelled before a mode was chosen — today it reports `"custom"`, inflating exactly the
   bucket meant to judge the stock modes. Same optionality treatment `destination` already
   has.
2. **`inferred_count` is dropped from `take_started`** (hard-coded 0 there; the real value
   stays on `take_repos_picked`). Additive-only removal of a meaningless constant; the
   docs row updates with it.
3. **`startFlow()` uses `performance.now()`** instead of `Date.now()` — monotonic
   `duration_ms` for the Take funnel and every new funnel here.
4. **`classifyFailure` learns `JiraApiError.status`** (`.status === 404` → `"not_found"`),
   and the dead `code === "401" || code === "403"` string branch goes — nothing in `src/`
   sets a string `.code`. The frozen wire literals are untouched.

## Testing

Per new event, the three gates the repo already enforces plus one behavior test:

- **Catalog**: a variant in `events.ts`; a representative literal in
  `test/unit/telemetry/events.test.ts`'s `SAMPLES` (compile-time exhaustiveness via
  `AssertNever`), count bumped from 10 to the new total; the value-shape assertions
  (`/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/`, no slashes, enum membership) apply automatically.
  Event names are lower_snake_case — the docs drift test's regex only sees that shape.
- **Docs**: a row per event in `docs/TELEMETRY.md`'s Usage-events table
  (`test/unit/telemetry/docs.test.ts` enforces presence).
- **Behavior**: per emit site, a test in the owning view's suite asserting the event fires
  with the expected enum values and that no user string reaches any property — mirroring
  the existing tasksView funnel tests. Deck/marketplace tests follow those files' existing
  patterns; anything jsdom-side asserts with `waitFor`, never a bare tick.
- **Mutation-checked**: the follow-ups doc showed five decorative test clusters in
  Phase 1. New emit-site tests must fail when the emit is deleted — verified by mutation
  during review, on committed work only.

Coverage thresholds (90/85) apply to the touched files as usual. The full suite must pass
unmodified except: the events-count assertion, the `SAMPLES` additions, and docs — the
three files whose stated purpose is to grow with the catalog. Any *other* test needing an
edit is the stop signal.

## Docs and hygiene (in passing)

- `docs/TELEMETRY.md`: new event rows; fix the stale `tasksView.ts:330-335` anchor
  (now `:879–889`); reconcile the "41-field" comment in `events.ts:114` with the actual
  43-field snapshot the docs already state.
- `CHANGELOG.md`: one `## [Unreleased]` entry.
- README/notice wording needs no change — the disclosure surface is `docs/TELEMETRY.md`,
  which this updates.

## Rollout

No new setting; new events ship live behind the existing opt-out, matching how Phase 1's
events ship today. Verification before release: a dev-host pass exercising each surface
with telemetry pointed at the real PostHog project, confirming ingestion and that no
property carries a user string — the same end-to-end step Phase 1's plan ended with.
