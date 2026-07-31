import { AgentFlowConfig, DEFAULT_EXPLORE_ACTIONS, DEFAULT_PR_REVIEW_PROMPT, DEFAULT_PROMPT_MODES } from "../config";
import { SettingsSnapshot, STOCK_PROMPT_MODES, TaskModeProp } from "./events";

function taskModeProp(taskMode: string): TaskModeProp {
  if (taskMode === "ask") return "ask";
  return (STOCK_PROMPT_MODES as readonly string[]).includes(taskMode) ? "stock" : "custom";
}

/** Validate a config value against its known set of shipped choices, collapsing
 * anything unrecognised to `fallback`. Several `AgentFlowConfig` fields are typed
 * as literal unions (or plain `string`) but `getConfig()` only casts the raw
 * setting value through a generic type parameter — it never checks it against
 * the manifest `enum` at runtime. VS Code's settings UI keeps a normal user
 * inside that enum, but a hand-edited `settings.json` can hold anything, so an
 * unvalidated pass-through here would transmit arbitrary user-authored text. */
function enumOrFallback<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

const WORKSPACE_MODES = ["auto", "multiroot", "per-window", "ask"] as const;
const OPEN_IN_MODES = ["ask", "new-window", "this-window", "pick-existing"] as const;
const EXPLORE_MODES = ["ask", "jiraTicket", "knowledge", "debug", "general"] as const;
const WORKTREE_MODES = ["ask", "always", "never"] as const;
const REMOTE_CONTROL_MODES = ["off", "on", "ask"] as const;
const DEFAULT_FILTER_VALUES = ["unassigned", "mysprint", "mine", "sprint", "backlog"] as const;

const STOCK_PROMPT_MODE_IDS = DEFAULT_PROMPT_MODES.map((m) => m.id).join(",");

/** Shipped default prompt per explore-action id (jiraTicket/knowledge/debug/general —
 * the id set never varies, only each action's `.prompt` can be customized). */
const DEFAULT_EXPLORE_PROMPTS = new Map(DEFAULT_EXPLORE_ACTIONS.map((a) => [a.id, a.prompt]));

/** Reduce config to shape only. Every setting whose value is user-authored —
 * baseUrl, project, githubOrg, reposRoot, workspaceDir, provenanceLabel,
 * prReviewStatus, reviewRequestPrompt and every *Prompt — contributes at most a
 * "was it changed from the default" boolean. repoBlocklist contributes its
 * length. Every enum-ish setting is validated against its known values and
 * collapsed to a safe fallback when unrecognised, never cast — a hand-edited
 * settings.json can hold any string there. Tests assert none of the above leak. */
export function settingsSnapshot(cfg: AgentFlowConfig): SettingsSnapshot {
  return {
    workspace_mode: enumOrFallback(cfg.workspaceMode, WORKSPACE_MODES, "auto"),
    open_in: enumOrFallback(cfg.openIn, OPEN_IN_MODES, "ask"),
    explore_mode: enumOrFallback(cfg.exploreMode, EXPLORE_MODES, "ask"),
    worktree: enumOrFallback(cfg.worktree, WORKTREE_MODES, "ask"),
    remote_control: enumOrFallback(cfg.remoteControl, REMOTE_CONTROL_MODES, "off"),
    default_filter: enumOrFallback(cfg.defaultFilter, DEFAULT_FILTER_VALUES, "mysprint"),
    task_mode: taskModeProp(cfg.taskMode),
    seed_agent: cfg.seedAgent,
    filters_size: cfg.filters.size,
    filters_status: cfg.filters.status,
    filters_repo: cfg.filters.repo,
    filters_search: cfg.filters.search,
    pr_review_auto_fix: cfg.prReviewAutoFix,
    pr_facts: cfg.prFacts,
    review_requests: cfg.reviewRequests,
    review_writes: cfg.reviewWrites,
    stamp_label_on_write: cfg.stampLabelOnWrite,
    track_open_windows: cfg.trackOpenWindows,
    batch_confirm_threshold: cfg.batchLaunchConfirmThreshold,
    repo_blocklist_count: cfg.repoBlocklist.length,
    prompt_modes_count: cfg.promptModes.length,
    prompt_modes_customized: cfg.promptModes.map((m) => m.id).join(",") !== STOCK_PROMPT_MODE_IDS,
    explore_prompts_customized: cfg.exploreActions.some((a) => DEFAULT_EXPLORE_PROMPTS.get(a.id) !== a.prompt),
    pr_review_prompt_customized: cfg.prReviewPrompt !== DEFAULT_PR_REVIEW_PROMPT,
  };
}
