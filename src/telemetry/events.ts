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
  if (name === "TaskAuthError" || name === "JiraAuthError" || code === "401" || code === "403") return "auth";
  if (name === "AbortError" || code === "ETIMEDOUT") return "timeout";
  if (code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "ENETUNREACH") return "network";
  if (code === "ENOENT") return "not_found";
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
 * `"batch"` is reserved: takeBatch is not instrumented in Phase 1, so nothing
 * emits it yet. */
export type TakeSource = "card" | "command" | "batch";
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

/** The 34 safe reductions of AgentFlowConfig, built by settingsSnapshot.ts.
 *
 * `"invalid"` on the seven enum-ish fields below (workspace_mode, open_in,
 * agent_surface, explore_mode, worktree, remote_control, default_filter) is a sentinel, not a
 * real setting value: settingsSnapshot.ts emits it whenever the underlying
 * AgentFlowConfig value isn't one of the shipped choices — e.g. a hand-edited
 * settings.json holding a value VS Code's own settings UI would never offer.
 * It exists specifically so that case stays distinguishable from a user who
 * genuinely left the setting at its default; collapsing both to the same
 * shipped-default value would silently inflate the "default configuration"
 * bucket in the resulting analytics. task_mode's "custom" plays the same role
 * for that field and is not part of this six-field sentinel scheme. */
export interface SettingsSnapshot {
  workspace_mode: "auto" | "multiroot" | "per-window" | "ask" | "invalid";
  open_in: "ask" | "new-window" | "this-window" | "pick-existing" | "invalid";
  agent_surface: "extension" | "terminal" | "invalid";
  explore_mode: "ask" | "jiraTicket" | "knowledge" | "debug" | "general" | "supervise" | "verify" | "invalid";
  /** A registered connector id, or "invalid". Validated against the registry, so
   * a contributor's connector is never silently reported as invalid. */
  task_source: string;
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
  stamp_label_on_write: boolean;
  track_open_windows: boolean;
  batch_confirm_threshold: number;
  repo_blocklist_count: number;
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
  | { name: "take_started"; flow_id: string; source: TakeSource; task_fp: string; inferred_count: number }
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
  | { name: "take_completed"; flow_id: string; outcome: Outcome; destination?: DestinationProp; prompt_mode: PromptModeProp; repo_count: number; duration_ms: number; used_worktree?: boolean; failure_class?: FailureClass; task_fp: string };

/** Sent via logError — still delivered at telemetry level "error". */
export type ErrorEvent =
  | { name: "operation_failed"; op: Op; failure_class: FailureClass; retryable: boolean }
  | { name: "unhandled_error"; error_class: string; stack_digest: string };

export type AnalyticsEvent = UsageEvent | ErrorEvent;
export type EventName = AnalyticsEvent["name"];
