/** The event catalog. This file IS the privacy guarantee.
 *
 * Every string-typed property is a literal union. That guarantee holds for
 * *values* everywhere: a variable whose type has widened to plain `string` (a
 * repo name, ticket key, file path, prompt) is rejected wherever it flows into
 * an AnalyticsEvent-typed slot — TS2345, unconditionally, no matter how it got
 * there. There is deliberately no `track(name: string, props: Record<string,
 * unknown>)` anywhere in this module — an escape hatch would quietly undo the
 * whole design.
 *
 * TypeScript's *excess-property* check — the part that would catch an extra
 * `repo: "acme-billing"` key tacked onto an otherwise-valid event — only fires
 * for a fresh object literal assigned (or passed) directly where an
 * AnalyticsEvent is expected. It does not fire once the literal has been
 * bound to a variable or spread first:
 *   const built = { name: "extension_installed" as const, repo: "acme" };
 *   const ev: AnalyticsEvent = built;              // no error — `built` isn't fresh
 * Callers of this catalog must therefore construct events as literals at the
 * call site, not build them up in an intermediate object first. Closing that
 * gap with a no-excess-props generic belongs on the sending facade a later
 * task adds, not here.
 *
 * The only opaque string properties are listed in OPEN_STRING_PROPS, and
 * test/unit/telemetry/events.test.ts fails if that list grows. */

export type FailureClass =
  | "auth" | "network" | "not_found" | "permission"
  | "conflict" | "timeout" | "parse" | "unknown";

/** Map a thrown value to a failure class. Reads only the error's `name` and
 * well-known `code` fields — never its `message`, which we do not send.
 *
 * Deliberately checks `.name`, not `instanceof TaskAuthError` / `instanceof
 * JiraAuthError` — this module has no dependency on tasks/provider.ts or
 * jira/client.ts (which transitively imports `vscode` via jira/auth.ts) and
 * must stay that way, a leaf module importable in isolation. That only works
 * because every task-error constructor explicitly sets its own `.name` as a
 * string literal — the base `TaskAuthError` sets `"TaskAuthError"`
 * (src/tasks/provider.ts), and `JiraAuthError` overrides it with
 * `"JiraAuthError"` after calling `super()` (src/tasks/jira/client.ts), exactly
 * like its sibling `JiraApiError` (src/tasks/jira/errors.ts) already did. Both
 * names are accepted here: a bare `TaskAuthError` (thrown by a future connector
 * with no Jira-specific subclass) sets the base name, while Jira's own errors
 * still set the Jira one. A bare `class X extends Error {}` with no constructor
 * override would inherit `.name` from `Error.prototype` (`"Error"`), and the
 * class identifier itself is not a safe substitute for the same check:
 * esbuild's production build (esbuild.js, minify:true, no keepNames) renames
 * it, so `e.constructor.name` would not survive a real bundle either —
 * verified against the actual minified dist/extension.js. Native error types
 * (AbortError as thrown by fetch/AbortController, SyntaxError) set `.name` on
 * their own, immune to both of these problems, so no special casing is needed
 * for those. */
export function classifyFailure(e: unknown): FailureClass {
  const name = e instanceof Error ? e.name : "";
  const code = (e as { code?: string } | null)?.code ?? "";
  // JiraApiError carries a numeric `.status` (src/tasks/jira/errors.ts) — read it the
  // same arms-length way as `.code`, never the message.
  const status = (e as { status?: number } | null)?.status;
  if (name === "TaskAuthError" || name === "JiraAuthError" || status === 401 || status === 403) return "auth";
  if (name === "AbortError" || code === "ETIMEDOUT") return "timeout";
  if (code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "ENETUNREACH") return "network";
  if (code === "ENOENT" || status === 404) return "not_found";
  if (code === "EACCES" || code === "EPERM") return "permission";
  if (name === "SyntaxError") return "parse";
  return "unknown";
}

export type Op =
  | "jira_fetch" | "jira_write" | "jira_auth" | "git_worktree" | "repo_inference"
  | "pr_lookup" | "review_fetch" | "workspace_write" | "agent_seed" | "marketplace_read";

/** The six modes shipped in DEFAULT_PROMPT_MODES. `agentFlow.promptModes` is
 * user-configurable, so a custom mode's id is a user-authored string and must never
 * be sent — toPromptModeProp() collapses anything unrecognised to "custom". */
export const STOCK_PROMPT_MODES = ["plan", "implementation", "tdd", "investigate", "orchestrator", "refine"] as const;
export type StockPromptMode = (typeof STOCK_PROMPT_MODES)[number];
export type PromptModeProp = StockPromptMode | "custom";

export function toPromptModeProp(id: string): PromptModeProp {
  return (STOCK_PROMPT_MODES as readonly string[]).includes(id) ? (id as StockPromptMode) : "custom";
}

/** The six stock Explore actions (EXPLORE_ACTION_DEFS in config.ts). A user-authored
 * action id must never be sent — toExploreModeProp collapses it to "custom". */
export const STOCK_EXPLORE_MODES = ["jiraTicket", "knowledge", "debug", "general", "supervise", "verify"] as const;
export type ExploreModeProp = (typeof STOCK_EXPLORE_MODES)[number] | "custom";

export function toExploreModeProp(id: string): ExploreModeProp {
  return (STOCK_EXPLORE_MODES as readonly string[]).includes(id) ? (id as ExploreModeProp) : "custom";
}

/** The single review mode shipped in DEFAULT_REVIEW_REQUEST_MODES.
 * `agentFlow.reviewRequestModes` is user-configurable, so a custom mode's id is
 * a user-authored string and must never be sent — modeProp() in
 * settingsSnapshot.ts collapses anything unrecognised to "custom". */
export const STOCK_REVIEW_MODES = ["full"] as const;

/** `agentFlow.taskMode` holds "ask" or a prompt-mode id, so its raw value is
 * user-authored too. */
export type TaskModeProp = "ask" | "stock" | "custom";

/** Mirrors OpenTarget.kind in tasksView, not the `openIn` setting values: the
 * worktree decision is a separate branch downstream and gets its own boolean. */
export type DestinationProp = "new" | "current" | "existing" | "live-folder";

/** How a Take was started. Passed explicitly by the call site that knows —
 * `onMessage`'s "take" case for a Deck card, `agentFlow.takeTask` for the command
 * palette — never inferred from the shape of the arguments: a one-click Take from a
 * collapsed card carries no repo selection and is still a card Take.
 * `"batch"` is reserved: takeBatch reports through its own batch_started/
 * batch_completed funnel instead, never through take_started, so nothing
 * emits this member. */
export type TakeSource = "card" | "command" | "batch";
/** The Deck's `onMessage` click-shaped actions, one enum member per case that
 * counts as a user gesture rather than read-plumbing (`deck:reviewExpand`,
 * `deck:reviewLoadDraft`, and similar are not actions — see docs/TELEMETRY.md). */
export type DeckAction =
  | "refresh" | "clear_stale" | "switch_account" | "set_grouping"
  | "inspect_open" | "inspect_diff" | "forget" | "track" | "usage" | "open_external";

/** The orchestrator's user gestures, one member per `flow:*` message the Deck's
 * `onMessage` treats as an action. A flow's own id is NOT one of these events'
 * properties and never will be: unlike `flow_id` (a random UUID minted per Take),
 * an orchestrator flow id is minted from a clock plus a short salt (`newFlowId`),
 * so it is neither random nor ours to send — not even fingerprinted. The counts
 * carry the analysis instead. Flow names, node ticket keys, run keys, repo names
 * and receipt messages are user strings and never appear here either. */
export type FlowActionKind =
  | "create" | "rename" | "save" | "delete" | "add_planned" | "reset_edge"
  | "resume_approve" | "resume_disarm" | "save_command" | "dry_run";

export type WorkspaceModeProp = "multiroot" | "per-window";
export type RepoSource = "preselected" | "destination" | "quickpick";
export type Outcome = "launched" | "cancelled" | "failed";
export type CommandId =
  | "refresh" | "setup" | "doctor" | "signIn" | "signOut"
  | "takeTask" | "openDeck" | "openMarketplace";

/** Property names permitted to hold a value that is not an enum member.
 * `flow_id` is a random UUID; `error_class` is an Error's constructor name;
 * `stack_digest` is our own bundled stack with paths stripped (see stackDigest()).
 * `*_fp` properties are matched by suffix and must be 16-char hex. */
export const OPEN_STRING_PROPS = ["flow_id", "error_class", "stack_digest"] as const;

/** The 43 safe reductions of AgentFlowConfig, built by settingsSnapshot.ts.
 *
 * `"invalid"` on the eleven enum-ish fields below (workspace_mode, open_in,
 * review_open_in, agent_provider, agent_surface, explore_mode, worktree, remote_control,
 * default_filter, task_source, forge) is a sentinel, not a
 * real setting value: settingsSnapshot.ts emits it whenever the underlying
 * AgentFlowConfig value isn't one of the shipped choices — e.g. a hand-edited
 * settings.json holding a value VS Code's own settings UI would never offer.
 * It exists specifically so that case stays distinguishable from a user who
 * genuinely left the setting at its default; collapsing both to the same
 * shipped-default value would silently inflate the "default configuration"
 * bucket in the resulting analytics. task_mode's "custom" plays the same role
 * for that field and is not part of this sentinel scheme. */
export interface SettingsSnapshot {
  workspace_mode: "auto" | "multiroot" | "per-window" | "ask" | "invalid";
  open_in: "ask" | "new-window" | "this-window" | "pick-existing" | "invalid";
  /** Where **Review with agent** opens. Same vocabulary as `open_in` and reported
   *  separately: the interesting question is whether people answer it differently for a
   *  five-minute review than for a day's work. */
  review_open_in: "ask" | "new-window" | "this-window" | "pick-existing" | "invalid";
  agent_provider: "claude-code" | "copilot" | "cursor" | "ask" | "invalid";
  agent_surface: "extension" | "terminal" | "invalid";
  explore_mode: "ask" | "jiraTicket" | "knowledge" | "debug" | "general" | "supervise" | "verify" | "invalid";
  /** A registered connector id, or "invalid". Validated against the registry, so
   * a contributor's connector is never silently reported as invalid. */
  task_source: string;
  /** A registered forge id, or "invalid". Validated against the registry, so
   * a contributor's forge is never silently reported as invalid. */
  forge: string;
  worktree: "ask" | "always" | "never" | "invalid";
  remote_control: "off" | "on" | "ask" | "invalid";
  default_filter: "unassigned" | "mysprint" | "mine" | "sprint" | "backlog" | "invalid";
  task_mode: TaskModeProp;
  seed_agent: boolean;
  filters_size: boolean;
  filters_status: boolean;
  filters_repo: boolean;
  filters_search: boolean;
  pr_review_auto_fix: boolean;
  pr_facts: boolean;
  review_requests: boolean;
  open_agents: boolean;
  review_writes: boolean;
  merge_writes: boolean;
  merge_method: "squash" | "merge" | "rebase" | "invalid";
  orchestrator: boolean;
  child_worktrees: boolean;
  stamp_label_on_write: boolean;
  track_open_windows: boolean;
  batch_confirm_threshold: number;
  repo_blocklist_count: number;
  // How many named commands are configured under `agentFlow.commands`. Count
  // only — the command strings themselves are user-authored shell and can
  // carry hostnames, tokens or internal URLs, and never leave this machine.
  commands_count: number;
  prompt_modes_count: number;
  // How the resolved prompt-mode list differs from the built-ins it layered
  // over. Counts only — labels, details and prompts are user-authored text.
  prompt_modes_overridden: number;
  prompt_modes_custom: number;
  prompt_modes_hidden: number;
  explore_prompts_customized: boolean;
  environments_customized: boolean;
  pr_review_prompt_customized: boolean;
  review_mode: TaskModeProp;
  review_modes_count: number;
  review_modes_overridden: number;
  review_modes_custom: number;
  review_modes_hidden: number;
}

/** Sent via logUsage — suppressed entirely at telemetry level "error". */
export type UsageEvent =
  | { name: "extension_installed" }
  | ({ name: "extension_activated"; is_first_ever: boolean; has_jira_auth: boolean; is_configured: boolean } & SettingsSnapshot)
  | { name: "command_invoked"; command: CommandId }
  | { name: "take_started"; flow_id: string; source: TakeSource; task_fp: string }
  | { name: "take_prompt_mode_picked"; flow_id: string; prompt_mode: PromptModeProp; is_custom_mode: boolean }
  | { name: "take_destination_picked"; flow_id: string; destination: DestinationProp; workspace_mode: WorkspaceModeProp }
  // `accepted_inference` is optional: it's only meaningful in the "quickpick"
  // repo_source (inference doesn't run for "preselected"/"destination"), and
  // omitting it there keeps a genuine `false` (the quickpick branch rejecting
  // inference) distinguishable from "inference never ran".
  | { name: "take_repos_picked"; flow_id: string; repo_count: number; repo_source: RepoSource; accepted_inference?: boolean; inferred_count: number }
  // `used_worktree` lives here, not on take_destination_picked: the decision is
  // made later, inside launch(), and on the shipped default (`agentFlow.worktree:
  // "ask"`) it is the user's answer to a QuickPick — not something the setting
  // alone determines. Optional because a Take can end before that QuickPick is
  // answered (cancelled at the prompt-mode or destination step, or a Jira failure
  // in between), and omitting it there keeps "no decision was made" distinct from
  // a genuine "no worktree".
  // `prompt_mode` is optional: it's only known once the prompt-mode picker has been
  // answered, and omitting it for a Take cancelled before then keeps a genuine
  // "custom" distinguishable from "no mode was ever chosen" — the latter is not a
  // vote for "custom" (Phase 1's fidelity bug, follow-ups doc, item 3).
  | { name: "take_completed"; flow_id: string; outcome: Outcome; destination?: DestinationProp; prompt_mode?: PromptModeProp; repo_count: number; duration_ms: number; used_worktree?: boolean; failure_class?: FailureClass; task_fp: string }
  // `takeBatch`'s own funnel — separate from the Take funnel above, since a card or
  // command Take that becomes a fan-out routes away before take_started ever fires
  // (see TakeSource's "batch" note) and takeBatch asks its own questions from here.
  // `tree_mode` is present only when this batch was reached through the fan-out
  // picker (`chooseTreeMode`'s "fanout" answer) — a plain multi-select batch, and the
  // one-key "batch" that is really a single launch, omit it rather than reporting a
  // picker that never ran.
  | { name: "batch_started"; flow_id: string; keys_count: number; is_fanout: boolean; tree_mode?: "fanout" | "orchestrator" | "parent" }
  // `attempted`/`launched`/`failed` are honest at every exit, including the ones
  // before the loop ever runs (0/0/0). `prompt_mode`/`destination`/`layout` are
  // omitted (not defaulted) until the corresponding picker actually resolves, same
  // discipline as `take_completed`. `layout_asked` is unconditional: it is only ever
  // true when `target.kind === "new" && keys.length > 1` put the layout QuickPick up,
  // and `layout` itself is present only then — a batch that never asked has nothing
  // honest to report there.
  | {
      name: "batch_completed"; flow_id: string; outcome: Outcome; attempted: number; launched: number;
      failed: number; prompt_mode?: PromptModeProp; destination?: DestinationProp;
      layout?: "separate" | "shared"; layout_asked: boolean; duration_ms: number;
    }
  // `forge` is a registry-validated id or "invalid" — same sentinel scheme as
  // SettingsSnapshot.forge; never the raw setting string. `revealed` distinguishes
  // an already-open panel refocused from one freshly constructed.
  | { name: "deck_opened"; revealed: boolean; forge: string; pr_facts: boolean; open_agents: boolean; review_queue: boolean; orchestrator: boolean; flow_count: number; has_armed_flow: boolean }
  | { name: "deck_action"; action: DeckAction; grouping?: "agents" | "workspaces" }
  // One per user gesture: a batch review launch emits ONE of these with `batch: true`
  // and the aggregate counts, never one per PR. `mode`/`mode_was_pinned` mirror
  // `settingsSnapshot`'s `review_mode` vocabulary but reflect the mode actually used
  // for THIS launch (the picked/pinned PromptMode's id), not merely the raw setting —
  // the two diverge whenever `resolveReviewMode` falls back to the sole configured
  // mode without asking. `destination`/`provider`/`seeded_in_place` are single-launch
  // only (batch's shared-window path answers the same destination question once for
  // everyone, but a per-PR provider/seeded-in-place would be batch-only information
  // this event doesn't carry); `layout`/`layout_asked` are batch-only, since a single
  // launch never lays anything out. The review body never reaches this event.
  | {
      name: "review_launched"; outcome: Outcome; mode: TaskModeProp; mode_was_pinned: boolean;
      destination?: DestinationProp; provider?: "claude-code" | "copilot" | "cursor";
      seeded_in_place?: boolean; batch: boolean; requested_count: number; launched_count: number;
      failed_count: number; skipped_count: number; layout?: "separate" | "shared"; layout_asked?: boolean;
    }
  // Mirrors the outcome already computed for `deck:reviewSubmitDone` — never a second
  // classification of the same write. The review body is never a property here.
  | { name: "review_submitted"; verb: "approve" | "comment" | "request-changes"; from_draft: boolean; outcome: "ok" | "cancelled" | "failed" }
  // `mergePr`'s own re-checked gates, each refusing before anything reaches the forge —
  // never the repo name or PR number the message carried (`repo`/`number` stay
  // webview-only, in the `deck:mergeDone` post, not here). `merge_method` is present
  // only once a merge was actually attempted (past the confirm modal), so it is absent
  // for every refusal and for a declined confirm.
  | {
      name: "pr_merged"; outcome: "ok" | "cancelled" | "failed" | "refused"; merge_method?: "squash" | "merge" | "rebase";
      refusal?: "writes-off" | "facts-off" | "no-run" | "local" | "target-mismatch" | "no-checkout" | "in-flight";
    }
  // One emit per terminal, from whichever of the two separate re-seed paths reached
  // one: the Deck card's `seedPrWork` (`source: "deck"`) or the sidebar's `addressPr`
  // (`source: "tasks"`), which launches through the ordinary Take machinery
  // (`launch()`) rather than sharing seedPrWork's code. `window_count`/`failed_repo_count`
  // are always present (0 where nothing was attempted); no PR/ticket/repo name ever
  // rides along.
  | {
      name: "pr_work_seeded"; reason: "ci" | "conflict" | "review"; source: "deck" | "tasks";
      outcome: "seeded" | "seeded-in-place" | "opened-not-seeded" | "open-failed" | "cancelled" | "refused";
      window_count: number; failed_repo_count: number; agent_seeded: boolean;
    }
  // Fires once a mode actually exists: right after chooseExploreAction resolves in
  // explore() (source "command"), or immediately in runNotepadItem, whose mode is
  // always the fixed "general" action it borrows (source "notepad"). The two
  // pre-mode early exits (the Remote Control refusal, no repos found) therefore
  // emit only explore_completed below — never this event — which is expected, not
  // a bug: nobody has picked a mode yet to report.
  | { name: "explore_started"; flow_id: string; mode: ExploreModeProp; source: "command" | "notepad" }
  // The funnel terminator — exactly one per explore()/runNotepadItem call, from
  // whichever exit it reaches. `cancel_point` is present only for `outcome:
  // "cancelled"`; the two pre-mode cancels ("remote-control", "repos") still report
  // the CONFIGURED mode (`cfg.exploreMode` via toExploreModeProp — "ask" collapses
  // to "custom") since no picked mode exists yet. `env_picked` is present only when
  // the environment step actually ran (the "verify" action). The topic, slug, and
  // environment name are user strings and never sent — env_picked records only
  // listed-vs-custom, never the name itself.
  | {
      name: "explore_completed"; flow_id: string; outcome: Outcome; mode: ExploreModeProp;
      cancel_point?: "remote-control" | "repos" | "action" | "topic" | "env" | "kickoff" | "agent";
      env_picked?: "listed" | "custom"; destination?: DestinationProp;
      provider?: "claude-code" | "copilot" | "cursor"; seeded_in_place?: boolean;
      repo_count: number; duration_ms: number; failure_class?: FailureClass;
    }
  // One per `flow:*` gesture that actually did something — the membership checks
  // those cases make (an id the store does not hold) refuse before this. The
  // counts are per action: `save` carries the graph it just wrote, `dry_run` the
  // three the drawer computed, and the rest carry none, because a create or a
  // delete says nothing about the shape of a graph.
  | {
      name: "flow_action"; action: FlowActionKind; node_count?: number; edge_count?: number;
      fired_count?: number; blocked_count?: number;
    }
  // Every arm and disarm, from all three seams that can perform one. The
  // `unfirable_*` split is `unfirableRules`' own `needs` breakdown — how many
  // rules can never fire as configured — and is reported only where the code
  // genuinely computes it, which is the arming half of the `toggle` source. A
  // disarm computes no armability at all (there is nothing to warn about), so
  // the three counts are zero on every disarm, including `resume-banner` and
  // `auto-skip`. `"auto-skip"` is not a gesture: it is this window noticing,
  // mid-pass, that the flow was disarmed under it — at most once per flow per
  // pass, never once per skipped rule.
  | {
      name: "flow_armed"; armed: boolean; node_count: number; edge_count: number;
      unfirable_live: number; unfirable_pr_facts: number; unfirable_forge: number;
      source: "toggle" | "resume-banner" | "auto-skip";
    }
  // One per edge this pass actually performed — never one per evaluation pass,
  // and never for a rule merely stamped as a sibling. `deferred` is a pre-flight
  // read that failed, so nothing was spent and the next pass retries; `ok: false`
  // with `deferred: false` is a rule that tried and latched. The launch trio
  // (`dest`/`prompt_mode`/`repo_count`) is present only for a launch, whose
  // planned node carries all three. `"notify"` is reserved: a notify spends
  // nothing and is not performed through this seam, so nothing emits it today.
  | {
      name: "flow_edge_fired"; edge_action: "launch" | "seed" | "notify" | "run"; ok: boolean;
      deferred: boolean; dest?: "worktree" | "new-window" | "current-window";
      prompt_mode?: PromptModeProp; repo_count?: number;
    }
  // The flow has nothing left to do: every edge is stamped or errored. Derived,
  // not stored — the model has no terminal state — and emitted on the TRANSITION
  // only, so a settled flow left armed on the board does not re-report it every
  // six seconds.
  | { name: "flow_settled"; node_count: number; edge_count: number }
  // Fires on every open of the Marketplace panel. `revealed: true` is an
  // already-open panel refocused — its counts are the last scan's, kept on the
  // panel instance (zero before that instance has ever rendered, which cannot
  // happen here since a panel only exists after its first render). `revealed:
  // false` fires once, at the first `render()` this panel instance completes —
  // never on a later re-render (re-focus after the stale window, `mkt:refresh`) —
  // with the real counts of that scan: `asset_count`/`plugin_count`/
  // `marketplace_count` are `view.assets/plugins/marketplaces.length`; `skills`/
  // `commands`/`agents`/`hooks` are `view.assets` grouped by `AssetType`.
  | {
      name: "marketplace_opened"; revealed: boolean; asset_count: number; plugin_count: number;
      marketplace_count: number; skills: number; commands: number; agents: number; hooks: number;
      not_set_up: boolean;
    }
  // One per `onMessage` click-shaped gesture on the Marketplace panel. `allowed`
  // is present for `"open"`/`"reveal"` — whether the file was on the last scan's
  // allow-list, emitted whether or not the case goes on to act. `truncated` is
  // present for `"read"` only, once the file was actually read — a refused read
  // emits no event at all, unlike open/reveal. `"copy"` and `"open_external"`
  // carry neither property — a copy has nothing to refuse, and
  // `open_external`'s scheme guard is a silent drop, mirroring `deck_action`'s
  // own `"open_external"` member. No file path, asset name, or URL is ever a
  // property here.
  | { name: "marketplace_action"; action: "open" | "reveal" | "read" | "copy" | "open_external"; allowed?: boolean; truncated?: boolean }
  // Fires on every `fetch` (that IS the lens-usage signal, not a separate click
  // event) — the tasksView case tracked at tasksView.ts:677. `filter` is the
  // REQUESTED value the webview asked for; `lens` is what `effectiveFilter`
  // actually clamped it to, which is the same value unless the connector cannot
  // serve the requested lens. The unauthenticated early return (no provider to
  // clamp against) reports `lens` equal to the requested `filter` and zero
  // counts, `authed: false`; every other exit reports the real counts with
  // `authed: true`. `live_window_count` is present only when
  // `agentFlow.trackOpenWindows` is on, mirroring the `state`/`tasks` messages'
  // own `liveCount` gating.
  | {
      name: "tasks_fetched";
      filter: "unassigned" | "mine" | "mysprint" | "sprint" | "backlog" | "all";
      lens: "unassigned" | "mine" | "mysprint" | "sprint" | "backlog" | "all";
      size: "any" | "s" | "m" | "l";
      task_count: number; repo_count: number; live_window_count?: number; authed: boolean;
    }
  // The webview-only signal for a lens the fetch-driven `tasks_fetched` above
  // cannot see: which secondary lens (repo multiselect, title search) someone is
  // actually using, debounced 500ms in App.tsx so a keystroke run or a run of
  // toggles reports once, not once per keystroke/click. Sent via the new
  // `tasks:lensUsed` wire message; the host validates the enum and drops an
  // unrecognised value silently.
  | { name: "lens_used"; lens: "repo" | "search" }
  // One per card affordance click in the tasksView switch (`detail`,
  // `changeStatus`, `addToMySprint`, `removeFromSprint`, `setComponent`) plus the
  // two manual-order gestures (`reorder`, `resetOrder`) — never the ticket key,
  // repo name, or search text.
  | {
      name: "card_action";
      action: "detail" | "change_status" | "add_to_sprint" | "remove_from_sprint" | "set_component" | "reorder" | "reset_order";
    }
  // One per notepad gesture that maps onto this enum — `notepad:add` (add),
  // `notepad:update` (edit), `notepad:delete` (remove), `notepad:reorder` (reorder,
  // emitted only once the drop actually changes the saved order), `notepad:run`
  // (run — the notepad's own Task 6 `explore_started{source:"notepad"}` still
  // fires separately, from inside runNotepadItem), and `notepad:addImage` /
  // `notepad:pickImage` (both `image_add` — paste and file-picker are two paths to
  // the same gesture) / `notepad:removeImage` (`image_remove`). Note text, section
  // names and image names never appear here.
  | { name: "notepad_action"; action: "add" | "run" | "edit" | "remove" | "reorder" | "image_add" | "image_remove" }
  // Fires right after `runSetup` computes its step total. `source` is passed in by
  // the caller that knows: `maybeRunSetup`'s welcome offer passes "offer", the
  // `agentFlow.setup` palette command passes "command" — never inferred from the
  // arguments. `connector_steps` is `connector.setupSteps`, the source's own step
  // count, not the wizard's grand total (which also counts the repos-root step
  // this module owns) — so a Jira wizard and a future connector's wizard are
  // comparable on the part that is actually theirs.
  | { name: "setup_started"; source: "offer" | "command"; connector_steps: number }
  // The setup funnel's terminator — exactly one per `runSetup`/`maybeRunSetup` call,
  // from whichever exit it reaches. `abort()` itself stays telemetry-free (it is a
  // log-and-return helper); each call site maps its own reason onto the enum here.
  // `signed_in` is true only for `"complete"` — every other outcome means the wizard
  // ended before (or without) a successful sign-in.
  | {
      name: "setup_completed";
      outcome: "complete" | "cancelled-source" | "cancelled-root" | "signin-skipped" | "deferred";
      signed_in: boolean;
    }
  // Fires once per `showDoctor` call, after the QuickPick resolves. `fails`/`warns`
  // are the same counts `summarize(checks)` bases its title on. `outcome` is
  // `"dismissed"` for an Escape *and* for picking a passing row with nothing to
  // fix (both leave nothing applied), `"copied"` for the Copy-report row, and
  // `"action"` for a check's own fix — `action_kind` is that check's
  // `DoctorAction.kind`, present only then. No check label, detail, path or URL
  // is ever a property here.
  | {
      name: "doctor_run";
      fails: number;
      warns: number;
      outcome: "dismissed" | "copied" | "action";
      action_kind?: "command" | "setting" | "extension" | "external";
    };

/** Sent via logError — still delivered at telemetry level "error". */
export type ErrorEvent =
  | { name: "operation_failed"; op: Op; failure_class: FailureClass; retryable: boolean }
  | { name: "unhandled_error"; error_class: string; stack_digest: string };

export type AnalyticsEvent = UsageEvent | ErrorEvent;
export type EventName = AnalyticsEvent["name"];
