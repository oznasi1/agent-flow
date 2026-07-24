import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { FilterVisibility, PromptMode } from "./types";

export const DEFAULT_PROMPT_MODES: PromptMode[] = [
  {
    id: "plan",
    label: "Plan first",
    prompt:
      'Jira {key}: "{summary}". Read the task brief at {brief} for context and the repos involved. ' +
      "Propose a step-by-step PLAN for this task and wait for my approval — do not edit any code yet. Ticket: {url}{files}",
  },
  {
    id: "implementation",
    label: "Implementation",
    prompt:
      'Jira {key}: "{summary}". Read the task brief at {brief} for context and the repos involved. ' +
      "Begin implementing. Confirm your approach with me only if something is ambiguous. Ticket: {url}{files}",
  },
];

/** Seed for an Explore session (no ticket). Placeholders: {summary} (your focus), {brief}, {files}. */
export const DEFAULT_EXPLORE_PROMPT =
  'Exploration session — no Jira ticket yet. Focus: "{summary}". A brief listing the repos in scope is at {brief}. ' +
  "Help me understand how this works: map the relevant code paths, explain the flow, and flag anything surprising " +
  "or worth a follow-up ticket. Don't change code unless I ask.{files}";

/** Seed for the "Open a Jira ticket" action — explore, then create a ticket. */
export const DEFAULT_EXPLORE_JIRA_TICKET_PROMPT =
  'Exploration session. Focus: "{summary}". A brief listing the repos in scope is at {brief}. ' +
  "Dig into this, then draft and create a Jira ticket that captures what you found — a clear problem " +
  "statement, the affected code paths, and a proposed approach. Add the `claude-code` label to the ticket, " +
  "and share the ticket key and URL.{files}";

/** Seed for the "Debug" action — reproduce, root-cause, propose a fix. */
export const DEFAULT_EXPLORE_DEBUG_PROMPT =
  'Debugging session — no Jira ticket yet. Focus: "{summary}". A brief listing the repos in scope is at {brief}. ' +
  "Reproduce the problem, trace it to a root cause, and explain what's going wrong with evidence from the code. " +
  "Propose a fix, but don't change code unless I ask.{files}";

/** Seed for the "General" action — open-ended working session. */
export const DEFAULT_EXPLORE_GENERAL_PROMPT =
  'Working session. Focus: "{summary}". A brief listing the repos in scope is at {brief}. ' +
  "Help me make progress on this — ask what I need if it's unclear before diving in. " +
  "Don't change code unless I ask.{files}";

/** One Explore action as seen by the flow: id + picker label + resolved prompt + Slack toggle. */
export interface ExploreAction {
  id: string;
  label: string;
  prompt: string;
  slackDm: boolean;
}

/** Fixed built-in actions. `settingKey` is the multiline string setting holding the prompt. */
const EXPLORE_ACTION_DEFS: { id: string; label: string; settingKey: string; defaultPrompt: string }[] = [
  { id: "jiraTicket", label: "Open a Jira ticket", settingKey: "explorePrompts.jiraTicket", defaultPrompt: DEFAULT_EXPLORE_JIRA_TICKET_PROMPT },
  { id: "knowledge", label: "Enhance knowledge / flow", settingKey: "explorePrompts.knowledge", defaultPrompt: DEFAULT_EXPLORE_PROMPT },
  { id: "debug", label: "Debug", settingKey: "explorePrompts.debug", defaultPrompt: DEFAULT_EXPLORE_DEBUG_PROMPT },
  { id: "general", label: "General", settingKey: "explorePrompts.general", defaultPrompt: DEFAULT_EXPLORE_GENERAL_PROMPT },
];

/** Seed for a PR-review kick-off (a task in the PR-review status). The agent locates
 * the task's GitHub PR by its Jira key, checks out its branch here, and assesses
 * readiness. Placeholders: {key} {summary} {url} {brief} {files}. The auto-fix
 * sentence (below) is appended just before {files} when agentFlow.prReviewAutoFix is on. */
export const DEFAULT_PR_REVIEW_PROMPT =
  'Jira {key} ({url}): "{summary}". This task has an open GitHub PR — all our PRs carry the Jira key in their title and branch. ' +
  "Using `gh` (or the GitHub tools available to you): find the PR for {key}, run `gh pr checkout` to bring its branch " +
  "into this worktree, then assess whether it's ready for us to work on — unresolved review comments and requested " +
  "changes, CI status, merge conflicts, and approval state. Summarize what you find.{files}";

/** Appended to the PR-review prompt (just before {files}) when prReviewAutoFix is on. */
export const PR_REVIEW_AUTOFIX_CLAUSE =
  "If it's ready, go ahead and implement the requested changes on this branch so it's ready for me to review — " +
  "do not push or merge without me.";

export interface AgentFlowConfig {
  baseUrl: string;
  project: string;
  reposRoot: string;
  workspaceDir: string;
  githubOrg: string;
  repoBlocklist: string[];
  defaultFilter: string;
  seedAgent: boolean;
  workspaceMode: "auto" | "multiroot" | "per-window" | "ask";
  openIn: "ask" | "new-window" | "this-window" | "pick-existing";
  taskMode: string; // "ask", or a PromptMode id
  promptModes: PromptMode[];
  exploreMode: string; // "ask", or an ExploreAction id
  exploreActions: ExploreAction[];
  prReviewStatus: string; // task status that reveals the "Address PR" card action
  prReviewAutoFix: boolean; // after assessing, proceed to implement the PR's requested changes
  prReviewPrompt: string; // seeded prompt for the PR-review kick-off
  worktree: "ask" | "always" | "never";
  // Batch sizes strictly greater than this prompt a confirmation before parallel launch.
  batchLaunchConfirmThreshold: number;
  trackOpenWindows: boolean;
  stampLabelOnWrite: boolean;
  provenanceLabel: string;
  // Which secondary filter controls the task-pool sidebar shows. Each defaults to
  // true; a user hides the ones they don't use. The tab bar is always shown.
  filters: FilterVisibility;
  marketplaces: string[];
}

/** Expand a leading `~` to the user's home directory. */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** The user-set value of a setting (folder > workspace > global), or undefined if
 * only the schema default applies. Used to detect an explicit legacy value for migration. */
function explicitConfigValue<T>(c: vscode.WorkspaceConfiguration, key: string): T | undefined {
  const i = c.inspect<T>(key);
  return (i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue) as T | undefined;
}

export function getConfig(): AgentFlowConfig {
  const c = vscode.workspace.getConfiguration("agentFlow");
  const slackRaw = c.get<Record<string, unknown>>("exploreSlackDm") ?? {};
  const resolvePrompt = (def: { id: string; settingKey: string; defaultPrompt: string }): string => {
    if (def.id === "knowledge") {
      // Migrate a customized legacy explorePrompt into the knowledge action.
      return (
        explicitConfigValue<string>(c, def.settingKey) ??
        explicitConfigValue<string>(c, "explorePrompt") ??
        def.defaultPrompt
      );
    }
    return c.get<string>(def.settingKey) || def.defaultPrompt;
  };
  const exploreActions: ExploreAction[] = EXPLORE_ACTION_DEFS.map((def) => ({
    id: def.id,
    label: def.label,
    prompt: resolvePrompt(def),
    slackDm: slackRaw[def.id] === true,
  }));
  return {
    baseUrl: (c.get<string>("jira.baseUrl") || "").replace(/\/+$/, ""),
    project: c.get<string>("jira.project") || "",
    reposRoot: expandHome(c.get<string>("reposRoot") || "~/projects"),
    workspaceDir: expandHome(c.get<string>("workspaceDir") || "~/projects"),
    githubOrg: c.get<string>("githubOrg") || "",
    repoBlocklist: (() => {
      const b = c.get<string[]>("repoBlocklist");
      return Array.isArray(b) ? b.filter((x) => typeof x === "string" && x.length) : [];
    })(),
    marketplaces: (() => {
      const m = c.get<string[]>("marketplaces");
      return Array.isArray(m) ? m.filter((x) => typeof x === "string" && x.length > 0) : [];
    })(),
    defaultFilter: c.get<string>("defaultFilter") || "mysprint",
    seedAgent: c.get<boolean>("seedAgent") ?? true,
    workspaceMode: (c.get<AgentFlowConfig["workspaceMode"]>("workspaceMode")) || "auto",
    openIn: (c.get<AgentFlowConfig["openIn"]>("openIn")) || "ask",
    taskMode: c.get<string>("taskMode") || "ask",
    promptModes: (() => {
      const m = c.get<PromptMode[]>("promptModes");
      return Array.isArray(m) && m.length ? m.filter((x) => x && x.id && x.label && x.prompt) : DEFAULT_PROMPT_MODES;
    })(),
    exploreMode: c.get<string>("exploreMode") || "ask",
    exploreActions,
    prReviewStatus: c.get<string>("prReviewStatus") || "PR initiated",
    prReviewAutoFix: c.get<boolean>("prReviewAutoFix") ?? true,
    prReviewPrompt: c.get<string>("prReviewPrompt") || DEFAULT_PR_REVIEW_PROMPT,
    worktree: (c.get<AgentFlowConfig["worktree"]>("worktree")) || "ask",
    batchLaunchConfirmThreshold: c.get<number>("batchLaunchConfirmThreshold") ?? 6,
    trackOpenWindows: c.get<boolean>("trackOpenWindows") ?? true,
    stampLabelOnWrite: c.get<boolean>("stampLabelOnWrite") ?? true,
    provenanceLabel: c.get<string>("provenanceLabel") || "claude-code",
    filters: {
      size: c.get<boolean>("filters.size") ?? true,
      status: c.get<boolean>("filters.status") ?? true,
      repo: c.get<boolean>("filters.repo") ?? true,
      search: c.get<boolean>("filters.search") ?? true,
    },
  };
}
