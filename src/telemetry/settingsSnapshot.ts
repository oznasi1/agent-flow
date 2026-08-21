import {
  AgentFlowConfig, DEFAULT_ENVIRONMENTS, DEFAULT_EXPLORE_ACTIONS,
  DEFAULT_PROMPT_MODES, shippedPrReviewPrompt, shippedReviewRequestModes,
} from "../config";
import { PromptMode } from "../types";
import { CONNECTOR_IDS } from "../tasks/registry";
import { FORGE_IDS } from "../engine/forge/registry";
import { SettingsSnapshot, STOCK_PROMPT_MODES, STOCK_REVIEW_MODES, TaskModeProp } from "./events";

/** Collapse an "ask, or a mode id" setting to a shape-only value. A custom id is
 * user-authored text and must never be transmitted; it becomes "custom". */
function modeProp(value: string, stock: readonly string[]): TaskModeProp {
  if (value === "ask") return "ask";
  return stock.includes(value) ? "stock" : "custom";
}

/** Validate a config value against its known set of shipped choices, collapsing
 * anything unrecognised to the `"invalid"` sentinel — never to a real shipped
 * value. Several `AgentFlowConfig` fields are typed as literal unions (or plain
 * `string`) but `getConfig()` only casts the raw setting value through a
 * generic type parameter — it never checks it against the manifest `enum` at
 * runtime. VS Code's settings UI keeps a normal user inside that enum, but a
 * hand-edited `settings.json` can hold anything, so an unvalidated pass-through
 * here would transmit arbitrary user-authored text. Falling back to a real
 * shipped default (e.g. "auto") would be just as wrong in a different way: it
 * would make an invalid setting byte-identical, in the analytics, to a user who
 * genuinely left the setting untouched — see the SettingsSnapshot doc comment
 * in events.ts. */
function enumOrInvalid<T extends string>(value: string, allowed: readonly T[]): T | "invalid" {
  return (allowed as readonly string[]).includes(value) ? (value as T) : "invalid";
}

// Hand-duplicated from each setting's `enum` in package.json's manifest — kept
// honest by a manifest-parity test in test/unit/telemetry/settingsSnapshot.test.ts
// (same pattern as config.ts's DEFAULT_PROMPT_MODES / DEFAULT_PR_REVIEW_PROMPT
// parity tests), so a manifest enum that grows a new option and forgets this
// file doesn't silently collapse that new option to "invalid" forever. Exported
// only so that test can compare against package.json; not part of the public
// module surface otherwise.
export const WORKSPACE_MODES = ["auto", "multiroot", "per-window", "ask"] as const;
export const OPEN_IN_MODES = ["ask", "new-window", "this-window", "pick-existing"] as const;
export const EXPLORE_MODES = ["ask", "jiraTicket", "knowledge", "debug", "general", "supervise", "verify"] as const;
export const WORKTREE_MODES = ["ask", "always", "never"] as const;
export const REMOTE_CONTROL_MODES = ["off", "on", "ask"] as const;
export const AGENT_SURFACES = ["extension", "terminal"] as const;
export const AGENT_PROVIDERS = ["claude-code", "copilot", "cursor", "ask"] as const;
export const DEFAULT_FILTER_VALUES = ["unassigned", "mysprint", "mine", "sprint", "backlog"] as const;

const DEFAULT_ENVIRONMENT_LIST = DEFAULT_ENVIRONMENTS.join(",");

/** Shipped default prompt per explore-action id (the id set never varies, only each
 * action's `.prompt` can be customized). */
const DEFAULT_EXPLORE_PROMPTS = new Map(DEFAULT_EXPLORE_ACTIONS.map((a) => [a.id, a.prompt]));

/** How a resolved mode list differs from the built-ins it layered over: how many
 * built-ins the user overrode, how many modes are their own, how many built-ins
 * they hid. Derived by diffing ids and comparing values — the resolved list is
 * all this function gets, and no label, detail or prompt ever leaves it. */
function modeCounts(
  resolved: PromptMode[],
  builtIns: PromptMode[],
): { overridden: number; custom: number; hidden: number } {
  const byId = new Map(builtIns.map((m) => [m.id, m]));
  let overridden = 0;
  let custom = 0;
  for (const m of resolved) {
    const builtIn = byId.get(m.id);
    if (!builtIn) custom++;
    else if (builtIn.label !== m.label || builtIn.detail !== m.detail || builtIn.prompt !== m.prompt) overridden++;
  }
  const present = new Set(resolved.map((m) => m.id));
  return { overridden, custom, hidden: builtIns.filter((m) => !present.has(m.id)).length };
}

/** Reduce config to shape only. Every setting whose value is user-authored —
 * baseUrl, project, githubOrg, reposRoot, workspaceDir, provenanceLabel,
 * prReviewStatus and every *Prompt — contributes at most a "was it changed
 * from the default" boolean. repoBlocklist and commands each contribute only
 * their length — a command's `run` is arbitrary shell and can carry
 * hostnames, tokens or internal URLs, so nothing beyond a count is ever
 * justified. promptModes and reviewRequestModes each contribute several
 * counts instead (via modeCounts above) — never a label, detail or prompt,
 * which stay user-authored and untransmitted. Every enum-ish setting is
 * validated against its known values and collapsed to the `"invalid"`
 * sentinel when unrecognised, never cast and never a real shipped default —
 * a hand-edited settings.json can hold any string there, and reporting it as
 * e.g. "auto" would be indistinguishable from a genuine default. Tests
 * assert none of the above leak. */
export function settingsSnapshot(cfg: AgentFlowConfig): SettingsSnapshot {
  const promptCounts = modeCounts(cfg.promptModes, DEFAULT_PROMPT_MODES);
  // Against the baseline THIS forge shipped, not the GitHub one. Two of the stock
  // values are forge-flavoured (the PR-review prompt, and the first stock review
  // mode's prompt), so comparing a GitLab install against the GitHub wording made
  // `review_modes_overridden: 1` and `pr_review_prompt_customized: true` fire for
  // the whole GitLab population on a stock install — reporting "the user wrote
  // their own words" for a user who only picked a forge, which is exactly the
  // claim docs/TELEMETRY.md says these two fields make.
  const reviewCounts = modeCounts(cfg.reviewRequestModes, shippedReviewRequestModes(cfg.forge));
  return {
    workspace_mode: enumOrInvalid(cfg.workspaceMode, WORKSPACE_MODES),
    open_in: enumOrInvalid(cfg.openIn, OPEN_IN_MODES),
    review_open_in: enumOrInvalid(cfg.reviewOpenIn, OPEN_IN_MODES),
    agent_provider: enumOrInvalid(cfg.agentProvider, AGENT_PROVIDERS),
    agent_surface: enumOrInvalid(cfg.agentSurface, AGENT_SURFACES),
    explore_mode: enumOrInvalid(cfg.exploreMode, EXPLORE_MODES),
    task_source: enumOrInvalid(cfg.taskSource, CONNECTOR_IDS),
    forge: enumOrInvalid(cfg.forge, FORGE_IDS),
    worktree: enumOrInvalid(cfg.worktree, WORKTREE_MODES),
    remote_control: enumOrInvalid(cfg.remoteControl, REMOTE_CONTROL_MODES),
    default_filter: enumOrInvalid(cfg.defaultFilter, DEFAULT_FILTER_VALUES),
    task_mode: modeProp(cfg.taskMode, STOCK_PROMPT_MODES),
    seed_agent: cfg.seedAgent,
    filters_size: cfg.filters.size,
    filters_status: cfg.filters.status,
    filters_repo: cfg.filters.repo,
    filters_search: cfg.filters.search,
    pr_review_auto_fix: cfg.prReviewAutoFix,
    pr_facts: cfg.prFacts,
    review_requests: cfg.reviewRequests,
    open_agents: cfg.openAgents,
    review_writes: cfg.reviewWrites,
    orchestrator: cfg.orchestrator,
    child_worktrees: cfg.childWorktrees,
    stamp_label_on_write: cfg.stampLabelOnWrite,
    track_open_windows: cfg.trackOpenWindows,
    batch_confirm_threshold: cfg.batchLaunchConfirmThreshold,
    repo_blocklist_count: cfg.repoBlocklist.length,
    // Count only — see the field's own doc comment in events.ts for why the
    // command strings themselves never cross this boundary.
    commands_count: cfg.commands.length,
    prompt_modes_count: cfg.promptModes.length,
    prompt_modes_overridden: promptCounts.overridden,
    prompt_modes_custom: promptCounts.custom,
    prompt_modes_hidden: promptCounts.hidden,
    explore_prompts_customized: cfg.exploreActions.some((a) => DEFAULT_EXPLORE_PROMPTS.get(a.id) !== a.prompt),
    // Order-sensitive, and only ever a boolean — environment names are user-authored
    // and never transmitted.
    environments_customized: cfg.environments.join(",") !== DEFAULT_ENVIRONMENT_LIST,
    pr_review_prompt_customized: cfg.prReviewPrompt !== shippedPrReviewPrompt(cfg.forge),
    review_mode: modeProp(cfg.reviewRequestMode, STOCK_REVIEW_MODES),
    review_modes_count: cfg.reviewRequestModes.length,
    review_modes_overridden: reviewCounts.overridden,
    review_modes_custom: reviewCounts.custom,
    review_modes_hidden: reviewCounts.hidden,
  };
}
