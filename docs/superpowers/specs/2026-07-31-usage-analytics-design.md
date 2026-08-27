# Design: Usage analytics

**Date:** 2026-07-31
**Status:** Approved, ready to plan

## Summary

Agent Flow ships dozens of user-facing behaviours across three webviews, eight commands and
a dozen engine paths, and today we know nothing about which of them anyone uses. Install
counts on the Marketplace are the only signal, and they say nothing about whether a user
ever completed a single **Take**.

This design adds a **usage analytics layer** that reports anonymous, shape-only events to
**PostHog** (a personal project, not an employer's). It answers four questions: which
features get used at all, where multi-step flows are abandoned, whether a fresh install
ever reaches a successful Take and comes back, and what fails for real users.

The privacy posture is the design's central constraint, not an afterthought. Properties are
enums, counts, booleans and durations. **No repo name, ticket key, Jira project, file path,
prompt text, or error message ever leaves the machine** — and that guarantee is enforced by
the type system and a failing test, not by reviewer discipline.

## Why this, and why now

Every feature shipped since `0.1.0` was justified by intuition. The Marketplace, the size
lens, the four Explore modes, `remoteControl`, the six prompt modes — each was built
because it seemed useful, and none has ever been measured. Several are plausibly dead
weight that could be deleted, and there is no way to tell which.

The extension is also now used by people who are not the author. When their `git worktree`
creation fails or repo inference finds nothing, nobody hears about it. The Doctor command
is purely reactive: it tells a user who already suspects a problem what is wrong. Failure
events make the same information available before anyone files an issue.

## Decisions

Settled during brainstorming, recorded so the plan does not relitigate them:

| Question | Decision |
|---|---|
| Which backend? | **PostHog**, the author's personal project. Not an employer's Mixpanel — this is not a company product. |
| Consent model? | **On by default with a kill switch.** Honours VS Code's `telemetry.telemetryLevel` *and* a dedicated `agentFlow.telemetry.enabled`. One-time non-blocking first-run notice. |
| How much detail in properties? | **Shape only** — enums, counts, booleans, durations. Salted hashes only where grouping is genuinely needed. |
| Unhandled errors? | **Class + path-stripped stack, never the message.** Messages embed paths and ticket keys; stacks of a single bundled file do not. |
| SDK or hand-rolled? | **Hand-rolled `TelemetrySender`, zero new dependencies.** The typed catalog is the privacy guarantee, and it only works if there is no generic `capture()` to bypass it. |
| Wrap `createTelemetryLogger`? | **Yes.** VS Code then enforces the telemetry level and scrubs PII-shaped data for us, and `logUsage` vs `logError` maps exactly onto the `"error"` telemetry level. |
| Injected or singleton? | **Module-level singleton.** Threading it through ~30 engine signatures alongside `log` is worse code for a genuinely ambient concern. Tests get `resetTelemetryForTests()`. |
| Identity? | **Borrowed, never minted** — `env.machineId` as `distinct_id`, `env.sessionId` as `session_id`. |
| Disk persistence of the queue? | **No.** Nothing writes a record of the user's activity to their own machine. |

## Scope

**In scope**

- A `src/telemetry/` module: typed event catalog, PostHog sender, identity/hashing, facade, first-run notice.
- One new setting, `agentFlow.telemetry.enabled` (boolean, default `true`).
- 30 events (see catalog), delivered in two phases.
- `docs/TELEMETRY.md` — the public, complete disclosure, kept honest by a drift test.
- A README section, and an amendment wherever the README implies nothing is sent anywhere.
- Test-mock additions for the VS Code telemetry APIs.

**Out of scope (non-goals)**

- Feature flags, A/B tests, session replay, PostHog's error-tracking product.
- EU / self-hosted endpoint configuration.
- Per-event or per-category opt-out granularity — one switch, all or nothing.
- Any cross-user aggregation of hashed values. Impossible by construction: the salt is per install.
- Instrumenting Claude Code itself, or anything about what an agent does after it is seeded.

## Architecture

Five files, each with one purpose:

```
src/telemetry/
  events.ts      the catalog — a discriminated union of every event and its exact properties
  posthog.ts     the TelemetrySender — batching, retry, POST to /batch/
  identity.ts    machineId / sessionId, the per-install salt, fingerprint()
  telemetry.ts   the facade: initTelemetry / track / trackError / flow / dispose
  notice.ts      the one-time first-run disclosure
```

### `events.ts` — the load-bearing piece

Every event is a variant of one union. Property values are constrained to
`string | number | boolean`, and every string position is a **literal union**, never a bare
`string`:

```ts
export type AnalyticsEvent =
  | { name: "take_completed"; flow_id: string; outcome: "launched" | "cancelled" | "failed";
      destination: Destination; prompt_mode: PromptModeId; repo_count: number;
      duration_ms: number; failure_class?: FailureClass }
  | ...
```

There is deliberately **no** `track(name: string, props: Record<string, unknown>)` overload.
Adding a repo name to an event is therefore a compile error. This is the single most
important decision in the design: it is why the module is hand-rolled rather than
`posthog-node`, because an SDK's generic `capture()` would sit next to the catalog and
quietly undo it.

`flow_id` correlates the events of one multi-step flow. It is a random id minted per flow —
not derived from anything about the user — and it is what makes funnel analysis possible
when two Takes overlap.

### `telemetry.ts` — the facade

Wraps `vscode.env.createTelemetryLogger(sender, { additionalCommonProperties })`. Exposes:

- `initTelemetry(context, log)` — called once from `activate()`.
- `track(event)` → `logger.logUsage`. Every event in the catalog except the two below.
- `trackError(event)` → `logger.logError`, used by exactly `operation_failed` and
  `unhandled_error`, so a user on `telemetry.telemetryLevel: "error"` sends failures only and
  no usage at all. This falls out of the VS Code API for free.
- `flow()` → returns a `flow_id` plus a monotonic elapsed-ms reader for `duration_ms`.
- `dispose()` — disposes the logger, which calls the sender's `flush()`.

Common properties, set once: `env_type` (from `context.extensionMode`, so the author's own
development events are filterable in PostHog), `ext_version`, `app_name` (finally answering
the VS Code / Cursor split), `app_host`, `remote_name`, `ui_kind`. VS Code injects os and
version itself; we do not pass `ignoreBuiltInCommonProperties`.

### `posthog.ts` — the sender

`POST https://us.i.posthog.com/batch/` with
`{ api_key, batch: [{ event, properties: { distinct_id, ... }, timestamp }] }`. The project
API key is a build-time constant in the bundle. This is correct and normal — PostHog project
keys are write-only ingestion keys, public by design in every browser SDK — but it *is*
world-readable in an OSS repo, so it must never be treated as a secret elsewhere.

`fetch` and a clock are injected for testability.

### Wiring points — six

1. `activate()` — `initTelemetry`, register the config/enablement listeners, push to `subscriptions`.
2–4. The three `onMessage` dispatchers ([tasksView.ts:61](../../../src/tasksView.ts#L61),
[deckView.ts:121](../../../src/deckView.ts#L121),
[marketplaceView.ts:40](../../../src/marketplaceView.ts#L40)) — one `track` each at the top.
5. Engine failure sites — `trackError`.
6. `deactivate()` — best-effort flush.

The `InboundMessage` union at [types.ts:256](../../../src/types.ts#L256) is already a
complete inventory of webview user actions, and `{ type: "fetch" }` even carries the active
filter and size lens. Instrumenting at the dispatcher therefore covers most of the adoption
surface from three call sites rather than from three React apps. Only genuinely
webview-local interactions — the repo lens, the search box, card expansion, Marketplace
category filters — need explicit events posted up from the webview.

## Consent, identity, privacy

**Two independent gates**, both must be on:

1. VS Code's `telemetry.telemetryLevel`, enforced inside `TelemetryLogger`. No code of ours.
2. `agentFlow.telemetry.enabled`, default `true`, enforced in the **sender's queueing step**
   — not in the `track()` / `trackError()` facade alone. Corrected during the whole-branch
   review: `TelemetryLoggerOptions.ignoreUnhandledErrors` defaults to `false`, so VS Code
   forwards errors escaping the extension host straight to `sender.sendErrorData`, a path
   that never passes through the facade. The queueing step is the one choke point every
   path crosses, so the gate belongs there.

Both are live-reactive (`onDidChangeEnableStates` plus a config listener) and re-read per
event, never cached, so re-enabling either mid-session resumes sending. Flipping either
off **drops the queued batch rather than flushing it** — turning it off mid-session means
the preceding minutes never leave the machine — and deliberately does *not* dispose the
sender, which would be a permanent off switch for the rest of the window.

**First-run notice.** Non-modal `showInformationMessage`, shown once ever (keyed in
`globalState`): *"Agent Flow sends anonymous usage events to help decide what to build
next."* with **What's collected** → `docs/TELEMETRY.md` on GitHub, and **Turn off** → writes
the setting globally. Deferred past `maybeRunSetup` so it never competes with the first-run
wizard for attention.

**Identity is borrowed.** `distinct_id` = `env.machineId`, VS Code's own anonymous stable
machine id. `session_id` = `env.sessionId`. We mint no user identifier.

**Fingerprints, narrowly.** One `crypto.randomUUID()` salt stored in `globalState` and never
transmitted; `fingerprint(s) = sha256(salt + ":" + s).slice(0, 16)`. Used in exactly two
positions: `task_fp` on task-flow events and `repo_fp` on single-repo events. They are the
only 16-char-hex property values in the catalog. `task_fp`
earns its place — the same ticket taken three times in a day is a friction signal, and it is
invisible without it. Multi-repo cases get `repo_count` and nothing more.

Because the salt is per install, hashes are comparable **within** one user and meaningless
across users. Cross-user aggregation of repo or ticket identity is not merely disallowed, it
is impossible.

## Event catalog

30 events. Common properties on all of them: `distinct_id`, `session_id`, `env_type`,
`ext_version`, `app_name`, `app_host`, `remote_name`, `ui_kind`, plus VS Code's own os and
version.

### Lifecycle — activation & retention

| Event | Properties |
|---|---|
| `extension_installed` | *(once ever)* |
| `extension_activated` | `is_first_ever`, `has_jira_auth`, `is_configured`, + settings snapshot |
| `setup_started` | `source`: first_run · command · cta |
| `setup_completed` | `outcome`, `steps_completed`, `duration_ms` |
| `jira_auth` | `action`: sign_in · sign_out, `outcome`, `failure_class?` |

"Activated user" is **derived** in PostHog from the first
`take_completed { outcome: "launched" }`. It needs no event of its own.

### Take funnel — all share `flow_id`

| Event | Properties |
|---|---|
| `take_started` | `source`: card · command · batch, `task_fp`, `inferred_count` |
| `take_repos_picked` | `repo_count`, `repo_source`: preselected · destination · quickpick, `accepted_inference`, `inferred_count` |
| `take_destination_picked` | `destination`: new · current · existing · live-folder, `workspace_mode`: multiroot · per-window |
| `take_prompt_mode_picked` | `prompt_mode`, `is_custom_mode` |
| `take_layout_picked` | `layout`: separate · shared *(batch flows only)* |
| `take_completed` | `outcome`: launched · cancelled · failed, `destination?`, `prompt_mode`, `repo_count`, `duration_ms`, `used_worktree?`, `failure_class?`, `task_fp` |

`repo_source` and `destination` are named for what the code can actually observe.
`resolveKickoff` reaches its repo set three ways — an in-card preselection, a destination
that already fixes its folders, or the confirm QuickPick — and only the third can accept or
reject inference, so `accepted_inference` is meaningful only when
`repo_source: "quickpick"`. A QuickPick exposes no search signal at all, so there is no
`used_search` to report. Likewise `destination` mirrors `OpenTarget.kind`
(new · current · existing · live-folder) rather than the `openIn` setting values, because
the worktree decision is a separate branch downstream — hence its own `used_worktree`
boolean. `destination` is absent on a `take_completed` that was cancelled before the
destination pick.

**`used_worktree` rides on `take_completed`, not `take_destination_picked`** (corrected
during the whole-branch review: `take_destination_picked` fires inside `resolveKickoff`,
before the decision exists, and on the shipped `agentFlow.worktree: "ask"` default the
decision is a QuickPick answered later, inside `launch()` — reading the setting at
destination time reported the wrong value for every Take on a stock install). It is
optional and omitted when a Take ends before that question is answered, so "never asked"
stays distinguishable from "asked, declined".

**`source` is passed in by the entry point that knows it** — the webview dispatcher for a
card Take, the `agentFlow.takeTask` command for a palette Take — never inferred from
whether the call carried an in-card repo selection: a one-click Take from a collapsed card
carries none and is still a card Take. `batch` is reserved; `takeBatch` is uninstrumented
in Phase 1.

**`prompt_mode` is not the raw id.** `agentFlow.promptModes` is user-configurable, so a
custom mode's id is a user-authored string — someone could name one `acme-billing-hotfix`.
`prompt_mode` is therefore a literal union of the **six shipped ids** (`plan`,
`implementation`, `tdd`, `investigate`, `orchestrator`, `refine`) plus `"custom"`, and any id
not in that set maps to `"custom"`. `is_custom_mode` carries the rest of the signal. The same
reduction applies to `taskMode` in the settings snapshot.

### Other flows — same started/completed shape, each with `flow_id`

| Event | Properties |
|---|---|
| `batch_started` / `batch_completed` | `task_count`, `repo_filter_count`, `hit_confirm_threshold`, `worktree_count`, `outcome`, `duration_ms`, `failure_class?` |
| `explore_started` / `explore_completed` | `mode`: jiraTicket · knowledge · debug · general, `slack_dm`, `repo_count`, `outcome`, `duration_ms` |
| `pr_address_started` / `pr_address_completed` | `task_fp`, `auto_fix`, `outcome`, `duration_ms`, `failure_class?` |
| `review_launched` | `outcome`, `duration_ms` |
| `review_submitted` | `verb`: approve · comment · request-changes, `from_draft`, `outcome` — **standalone, no `flow_id`**: a review can be submitted without ever launching an agent |

### Adoption surface

| Event | Properties |
|---|---|
| `tasks_fetched` | `filter`: unassigned · mine · mysprint · sprint · backlog · all, `size`: any · s · m · l, `task_count`, `duration_ms` |
| `lens_used` | `lens`: filter_tab · size · status · repo · search, `active` |
| `card_action` | `action`: change_status · add_to_sprint · remove_from_sprint · set_component · reorder · reset_order · detail_expand, `outcome` |
| `deck_opened` | `run_count`, `live`, `pr_facts` |
| `deck_action` | `action`: open · diff · forget · refresh · toggle_live · toggle_pr_facts · review_expand · load_draft |
| `marketplace_opened` | `asset_count` |
| `marketplace_action` | `action`: search · filter_category · preview · copy · open · reveal · read, `asset_type?`, `result_count?` |
| `command_invoked` | `command`: the eight ids registered in [extension.ts](../../../src/extension.ts) |

`lens_used` is the event that answers *"does anyone touch the size lens, or can it be
deleted"* — the question that motivated this whole design. It fires on a **committed** lens
change, never per render: tab, size, status and repo fire on selection, and `search` fires
once per search session after 500 ms of keyboard idle, so a nine-character query is one
event and not nine.

### Failure

| Event | Properties |
|---|---|
| `operation_failed` | `op`: jira_fetch · jira_write · jira_auth · git_worktree · repo_inference · pr_lookup · review_fetch · workspace_write · agent_seed · marketplace_read, `failure_class`: auth · network · not_found · permission · conflict · timeout · parse · unknown, `retryable` |
| `unhandled_error` | `error_class`, `stack_digest` |
| `doctor_opened` | `source`: command · cta · setup, `checks_failed` |

`operation_failed` is the primary failure channel: every class is an enum we chose, so no
incidental data can reach it. `unhandled_error` is the safety net for what we did not
predict. Its `stack_digest` is the stack reduced to `dist/extension.js:line:col` frames —
our own bundled code, absolute paths stripped, frames above the first of ours dropped,
truncated to 20 frames or 2 KB, and **never** `error.message`.

`unhandled_error` carries the common properties (`env_type`, `session_id`, …) like every
other event, which is only true because the **sender** attaches them as it queues. The
host's `additionalCommonProperties` reaches the `logUsage` / `logError(name, data)` payloads
only, never the `logError(Error)` → `sendErrorData` path VS Code drives itself — so relying
on it would have left the crash stream without `env_type`, and development crashes
unfilterable. Corrected during the whole-branch review.

### Settings snapshot on `extension_activated`

~27 properties, all enums, booleans or counts:

- Six manifest enums, **validated against the manifest's allowed values and collapsed to the
  literal `"invalid"` when unrecognised** — never cast: `workspaceMode`, `openIn`,
  `exploreMode`, `worktree`, `remoteControl`, `defaultFilter`.

  > **Correction, made during implementation.** This section originally said these six were
  > "sent verbatim because every allowed value is fixed in `package.json`". That was wrong on
  > both counts. `defaultFilter` and `exploreMode` are typed as bare `string` in
  > `AgentFlowConfig`, and VS Code's settings *UI* constrains a manifest `enum` while a
  > hand-edited `settings.json` does not — so a blind cast would have transmitted arbitrary
  > user-authored text. Each of the six is now membership-checked. A distinct `"invalid"`
  > sentinel is used rather than falling back to the shipped default, because falling back
  > would make garbage configuration indistinguishable from a genuine default choice and
  > silently inflate the "default configuration" bucket in the very numbers this design
  > exists to produce. Six manifest-parity tests guard the whitelists against drift.
- One reduced enum: `taskMode` → ask · stock · custom. Its manifest type is a bare string
  holding either `"ask"` or a prompt-mode id, so the raw value can be user-authored.
- Ten booleans: `seedAgent`, the four `filters.*`, `prReviewAutoFix`, `prFacts`, `reviewRequests`, `reviewWrites`, `stampLabelOnWrite`, `trackOpenWindows`.
- Two counts: `batchLaunchConfirmThreshold`, `repoBlocklist.length`.
- The prompt/URL strings reduced to `*_customized` booleans plus `prompt_modes_count`.

No setting whose value is a user-authored string is ever sent — only whether it differs
from the shipped default. `jira.baseUrl`, `jira.project`, `githubOrg`, `reposRoot`,
`workspaceDir`, `provenanceLabel` and every `*Prompt` are excluded on exactly this ground;
`repoBlocklist` contributes its length only.

## Failure handling

The analytics layer's own failures are invisible by construction:

- Every facade entry point is wrapped so it **cannot throw into a caller**. A flow must
  never break because analytics broke.
- Transport: 5s `AbortController` timeout; one retry after 2s on network error or 5xx;
  immediate permanent drop on 4xx, because a bad API key must not retry forever.
- Queue capped at 100 events, oldest dropped first.
- Everything reports to the "Agent Flow" Output channel and nowhere else. No notification,
  no status bar, no thrown error ever originates here.

**One honest limitation.** VS Code's `deactivate()` is synchronous and will not await a
`fetch`, so the final flush is genuinely best-effort and tail events at window close will
sometimes be lost. This is *why* retention rides on `extension_activated` rather than a
`session_ended` event, and why every duration is measured and sent at completion time
instead of being derived from session boundaries. The data model does not depend on the
unreliable moment.

## Testing

Vitest, into the existing `test/unit/` layout, against the current 90/85/85/90 coverage
thresholds.

| File | What it pins |
|---|---|
| `posthog.test.ts` | The PostHog `/batch/` body contract; batch-at-20; flush-at-10s; retry-once-then-drop; 4xx no retry; abort at 5s; queue cap drops oldest; the consent gate blocking even `sendErrorData`, and re-enabling resuming; common properties on every queued event. Injected `fetch` + clock. |
| `telemetry.test.ts` | Both gates independently: VS Code level off → silence; setting off → silence; flip off mid-session → queue dropped, not flushed; a throwing sender never reaches the caller. |
| `telemetryWiring.test.ts` | What `initTelemetry` hands the sender: a live (per-event, uncached) consent gate and the common properties — the two things the facade no longer does itself. Uses a stub sender, since the shipped placeholder key makes a real one no-op before it reads its deps. |
| `identity.test.ts` | Salt created once, reused, and **asserted absent from every serialized payload**. Fingerprints stable per salt, divergent across salts. |
| `events.test.ts` | The privacy guarantee. Runtime: walk sample events, assert every string value is a declared literal-union member or a 16-char hex fingerprint. Compile-time: `@ts-expect-error` on `track({ name: "take_completed", repo: "acme-billing" })`. |
| `notice.test.ts` | Shown once ever; suppressed while setup runs; *Turn off* writes the global setting. |
| `telemetryDocs.test.ts` | Every event name in the catalog appears in `docs/TELEMETRY.md`. |

Two wiring notes:

- `test/_mocks/vscode.ts` needs `env.machineId`, `env.sessionId`, `env.isTelemetryEnabled`,
  `env.onDidChangeTelemetryEnabled`, `env.createTelemetryLogger` and `ExtensionMode`. That
  mock is shared by every test file, so it is a blast-radius change and should land first.
- The three existing dispatcher test files each gain one event assertion. No new test file
  per event.

The disclosure-drift test mirrors the trick [config.ts:9](../../../src/config.ts#L9)
already uses to keep `DEFAULT_PROMPT_MODES` in step with the manifest default. It exists so
the public disclosure in `docs/TELEMETRY.md` cannot silently go stale as events are added.

## Phasing

**Phase 1 — plumbing, proven end to end.** All five module files, both consent gates, the
first-run notice, the `agentFlow.telemetry.enabled` setting, `docs/TELEMETRY.md`, the README
amendment, the mock additions, and 10 events: `extension_installed`,
`extension_activated`, `command_invoked`, `operation_failed`, `unhandled_error`, and the
complete Take funnel minus `take_layout_picked`. Verified by watching real events land in
PostHog from a development build, filtered on `env_type: "development"`.

**Phase 2 — breadth.** The remaining 20 events: batch, explore, PR-address, review, the
Deck, the Marketplace, the tasks view and its lenses, setup, and `doctor_opened`.

The split exists so 20 call sites are never wired against an unverified transport.

## Risks

| Risk | Mitigation |
|---|---|
| A future contributor adds a property carrying a user string. | `events.test.ts` fails to compile. The guarantee has a test, not a convention. |
| `docs/TELEMETRY.md` drifts from what is actually sent. | The drift test fails on any unlisted event name. |
| The notice is perceived as insufficient disclosure by an OSS user. | Non-modal notice on first run, a README section, a complete public catalog, a one-click off switch, and VS Code's global telemetry setting honoured with no action required. |
| Events from the author's own daily use dominate the numbers. | `distinct_id` is per machine and `env_type` separates development from production; the author's installs are identifiable and excludable in PostHog. |
| PostHog's free-tier event ceiling is exceeded. | The two noisiest candidates (`setup_step`, `review_queue_rendered`) were cut during design; `lens_used` is the remaining volume risk and is debounced per interaction, not per render. |
