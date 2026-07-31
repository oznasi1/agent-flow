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

/** `agentFlow.taskMode` holds "ask" or a prompt-mode id, so its raw value is
 * user-authored too. */
export type TaskModeProp = "ask" | "stock" | "custom";

/** Mirrors OpenTarget.kind in tasksView, not the `openIn` setting values: the
 * worktree decision is a separate branch downstream and gets its own boolean. */
export type DestinationProp = "new" | "current" | "existing" | "live-folder";
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

/** The 24 safe reductions of AgentFlowConfig, built by settingsSnapshot.ts. */
export interface SettingsSnapshot {
  workspace_mode: "auto" | "multiroot" | "per-window" | "ask";
  open_in: "ask" | "new-window" | "this-window" | "pick-existing";
  explore_mode: "ask" | "jiraTicket" | "knowledge" | "debug" | "general";
  worktree: "ask" | "always" | "never";
  remote_control: "off" | "on" | "ask";
  default_filter: "unassigned" | "mysprint" | "mine" | "sprint" | "backlog";
  task_mode: TaskModeProp;
  seed_agent: boolean;
  filters_size: boolean;
  filters_status: boolean;
  filters_repo: boolean;
  filters_search: boolean;
  pr_review_auto_fix: boolean;
  pr_facts: boolean;
  review_requests: boolean;
  review_writes: boolean;
  stamp_label_on_write: boolean;
  track_open_windows: boolean;
  batch_confirm_threshold: number;
  repo_blocklist_count: number;
  prompt_modes_count: number;
  prompt_modes_customized: boolean;
  explore_prompts_customized: boolean;
  pr_review_prompt_customized: boolean;
}

/** Sent via logUsage — suppressed entirely at telemetry level "error". */
export type UsageEvent =
  | { name: "extension_installed" }
  | ({ name: "extension_activated"; is_first_ever: boolean; has_jira_auth: boolean; is_configured: boolean } & SettingsSnapshot)
  | { name: "command_invoked"; command: CommandId }
  | { name: "take_started"; flow_id: string; source: "card" | "command" | "batch"; task_fp: string; inferred_count: number }
  | { name: "take_prompt_mode_picked"; flow_id: string; prompt_mode: PromptModeProp; is_custom_mode: boolean }
  | { name: "take_destination_picked"; flow_id: string; destination: DestinationProp; workspace_mode: WorkspaceModeProp; used_worktree: boolean }
  | { name: "take_repos_picked"; flow_id: string; repo_count: number; repo_source: RepoSource; accepted_inference: boolean; inferred_count: number }
  | { name: "take_completed"; flow_id: string; outcome: Outcome; destination?: DestinationProp; prompt_mode: PromptModeProp; repo_count: number; duration_ms: number; failure_class?: FailureClass; task_fp: string };

/** Sent via logError — still delivered at telemetry level "error". */
export type ErrorEvent =
  | { name: "operation_failed"; op: Op; failure_class: FailureClass; retryable: boolean }
  | { name: "unhandled_error"; error_class: string; stack_digest: string };

export type AnalyticsEvent = UsageEvent | ErrorEvent;
export type EventName = AnalyticsEvent["name"];
