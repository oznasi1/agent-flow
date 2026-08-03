import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { FilterVisibility, PromptMode } from "./types";

/** The stock "how should the agent start" modes, in picker order. `detail` is the
 * line shown under the label — written for the user reading the picker, never
 * derived from the prompt. Keep this array identical to the `agentFlow.promptModes`
 * default in package.json; that manifest default is what VS Code serves to users
 * who never touched the setting. A test enforces the two staying in step. */
export const DEFAULT_PROMPT_MODES: PromptMode[] = [
  {
    id: "plan",
    label: "Plan first",
    detail: "Propose a step-by-step plan and wait for approval — no code edits",
    prompt:
      'Jira {key}: "{summary}". Read the task brief at {brief} for context and the repos involved. ' +
      "Propose a step-by-step PLAN for this task and wait for my approval — do not edit any code yet. Ticket: {url}{files}",
  },
  {
    id: "implementation",
    label: "Implementation",
    detail: "Start building; check in only when something's ambiguous",
    prompt:
      'Jira {key}: "{summary}". Read the task brief at {brief} for context and the repos involved. ' +
      "Begin implementing. Confirm your approach with me only if something is ambiguous. Ticket: {url}{files}",
  },
  {
    id: "tdd",
    label: "Test-driven",
    detail: "Write the failing test first, then implement until it's green",
    prompt:
      'Jira {key}: "{summary}". Read the task brief at {brief} for context and the repos involved. ' +
      "Work test-first: write the failing test that captures this ticket's acceptance criteria, confirm it fails " +
      "for the right reason, then implement until it passes. Ticket: {url}{files}",
  },
  {
    id: "investigate",
    label: "Investigate & root-cause",
    detail: "Reproduce, trace to a root cause, propose a fix — no code edits",
    prompt:
      'Jira {key}: "{summary}". Read the task brief at {brief} for context and the repos involved. ' +
      "Reproduce the problem, trace it to a root cause, and explain what's going wrong with evidence from the code. " +
      "Propose a fix, but don't change code unless I ask. Ticket: {url}{files}",
  },
  {
    id: "orchestrator",
    label: "Orchestrator",
    detail: "Split into parallel subtasks, then integrate and verify",
    prompt:
      'Jira {key}: "{summary}". Read the task brief at {brief} for context and the repos involved. ' +
      "Break this into independent subtasks and tell me the breakdown before you start. Then dispatch a subagent " +
      "per subtask so they run in parallel, integrate the results yourself, and verify the whole thing works. " +
      "Ticket: {url}{files}",
  },
  {
    id: "refine",
    label: "Refine the ticket",
    detail: "Sharpen the description and acceptance criteria — no code",
    prompt:
      'Jira {key}: "{summary}". Read the task brief at {brief} for context and the repos involved. ' +
      "This ticket needs sharpening before anyone builds it: dig into the code, then rewrite the description and " +
      "acceptance criteria so they're unambiguous and testable, and list what's still unclear. Update the ticket " +
      "and add the `claude-code` label. Don't implement it. Ticket: {url}{files}",
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

/** Seed for the "Verify on an environment" action — check a feature against a live
 * environment for the picked services. Placeholders: {summary} (the feature), {env},
 * {services}, {brief}, {files}. Deliberately tool-agnostic: which observability tools
 * the agent has is the user's own Claude Code setup, not ours. */
export const DEFAULT_EXPLORE_VERIFY_PROMPT =
  'Verification session — checking a feature in a live environment, not the code in this checkout. Feature: "{summary}". ' +
  "Environment: {env}. Services in scope: {services}. A brief listing the repos in scope is at {brief}. " +
  "Using the observability tools available to you, check these services in {env}: recent logs and error rates, " +
  "the relevant metrics and traces, and which version is actually deployed. Then give a verdict — working, broken, " +
  "or inconclusive — with the evidence behind it and where to look next. " +
  "Read-only: don't change code, and don't mutate the environment.{files}";

/** Environments offered when an Explore action asks which environment to verify
 * against. A bare string list — not an array of objects — so VS Code's settings
 * page renders it as an editable list widget; the same constraint that made each
 * explore prompt its own setting. */
export const DEFAULT_ENVIRONMENTS = ["dev", "staging", "production"];

/** One Explore action as seen by the flow: id + picker label + resolved prompt + Slack toggle. */
export interface ExploreAction {
  id: string;
  label: string;
  prompt: string;
  slackDm: boolean;
  /** This action collects an environment before opening, and its prompt may use {env}. */
  needsEnv: boolean;
}

/** Fixed built-in actions. `settingKey` is the multiline string setting holding the prompt. */
const EXPLORE_ACTION_DEFS: { id: string; label: string; settingKey: string; defaultPrompt: string; needsEnv?: boolean }[] = [
  { id: "jiraTicket", label: "Open a Jira ticket", settingKey: "explorePrompts.jiraTicket", defaultPrompt: DEFAULT_EXPLORE_JIRA_TICKET_PROMPT },
  { id: "knowledge", label: "Enhance knowledge / flow", settingKey: "explorePrompts.knowledge", defaultPrompt: DEFAULT_EXPLORE_PROMPT },
  { id: "debug", label: "Debug", settingKey: "explorePrompts.debug", defaultPrompt: DEFAULT_EXPLORE_DEBUG_PROMPT },
  { id: "general", label: "General", settingKey: "explorePrompts.general", defaultPrompt: DEFAULT_EXPLORE_GENERAL_PROMPT },
  { id: "verify", label: "Verify on an environment", settingKey: "explorePrompts.verify", defaultPrompt: DEFAULT_EXPLORE_VERIFY_PROMPT, needsEnv: true },
];

/** The shipped default explore actions — same ids, labels and order getConfig()
 * always produces (the set of actions is fixed; only each `.prompt` can be
 * customized via its own setting). settingsSnapshot.ts compares against this to
 * detect a customized prompt without ever transmitting the prompt text itself. */
export const DEFAULT_EXPLORE_ACTIONS: ExploreAction[] = EXPLORE_ACTION_DEFS.map((def) => ({
  id: def.id,
  label: def.label,
  prompt: def.defaultPrompt,
  slackDm: false,
  needsEnv: def.needsEnv === true,
}));

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

/** Seed for reviewing a teammate's PR from the Deck's review strip. Distinct from
 * DEFAULT_PR_REVIEW_PROMPT, which addresses feedback on *your own* PR. The agent
 * writes its findings to a file; the human submits the review. Placeholders:
 * {repo} {number} {author} are substituted at launch, then {key} {summary} {url}
 * {brief} {files} by renderPrompt. */
export const DEFAULT_REVIEW_REQUEST_PROMPT =
  'Review pull request {url} — {repo}#{number}, "{summary}", by {author}. ' +
  "Check it out with `gh pr checkout {number} --repo {repo}`, then read the full diff against its base branch. " +
  "Assess correctness, edge cases, tests, and anything that would break in production. " +
  "Write your findings to `.pick-task/REVIEW-{number}.md` as a short prioritised list — most serious first, " +
  "each with the file and line it refers to. Do not post anything to GitHub; the human submits the review.{files}";

/** The stock review modes offered by **Review with agent**, in picker order.
 * One entry by default: a single mode short-circuits the picker, so a fresh
 * install keeps today's one-click launch. Keep this array identical to the
 * `agentFlow.reviewRequestModes` default in package.json; that manifest default
 * is what VS Code serves to users who never touched the setting. A test
 * enforces the two staying in step. */
export const DEFAULT_REVIEW_REQUEST_MODES: PromptMode[] = [
  {
    id: "full",
    label: "Full review",
    detail: "Correctness, edge cases, tests — findings to .pick-task/REVIEW-<n>.md",
    prompt: DEFAULT_REVIEW_REQUEST_PROMPT,
  },
];

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
  // Environments offered by Explore actions that verify against a live env.
  environments: string[];
  prReviewStatus: string; // task status that reveals the "Address PR" card action
  prReviewAutoFix: boolean; // after assessing, proceed to implement the PR's requested changes
  prReviewPrompt: string; // seeded prompt for the PR-review kick-off
  worktree: "ask" | "always" | "never";
  // Offer Claude Code's Remote Control for the session we open: the panel is seeded
  // with /remote-control <KEY> and the task prompt goes to the clipboard.
  remoteControl: "off" | "on" | "ask";
  // Batch sizes strictly greater than this prompt a confirmation before parallel launch.
  batchLaunchConfirmThreshold: number;
  trackOpenWindows: boolean;
  telemetryEnabled: boolean;
  // Read PR/CI state from GitHub via the `gh` CLI and show it on the Deck's cards.
  prFacts: boolean;
  // How stale a cached PR fact may be before the Deck re-fetches it. Floored at 30s.
  prFactsTtlSeconds: number;
  // Show every Claude Code session open on this machine on the Deck: as agents on
  // the card that owns their directory, and as a card of its own for a place
  // Agent Flow Deck never launched. Read from ~/.claude/sessions; off = today's board.
  openAgents: boolean;
  // Show the Deck's review-requests strip: open PRs that ask for your review.
  reviewRequests: boolean;
  // How stale the cached review queue may be before a refetch. Floored at 60s —
  // review requests move on a human timescale, not a CI one.
  reviewRequestsTtlSeconds: number;
  // Allow submitting approve / comment / request-changes from the Deck. The only
  // setting in Agent Flow Deck that lets it write to GitHub.
  reviewWrites: boolean;
  // Seed modes offered by Review with agent, same shape as promptModes. Never
  // empty — an unusable configured value falls back to DEFAULT_REVIEW_REQUEST_MODES.
  reviewRequestModes: PromptMode[];
  // "ask", or a reviewRequestModes id.
  reviewRequestMode: string;
  stampLabelOnWrite: boolean;
  provenanceLabel: string;
  // Which secondary filter controls the task-pool sidebar shows. Each defaults to
  // true; a user hides the ones they don't use. The tab bar is always shown.
  filters: FilterVisibility;
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

/** Trimmed, de-duplicated, non-empty environment names. Falls back to the shipped
 * defaults when the setting is absent, isn't an array, or holds nothing usable —
 * the same empty-means-default behavior `promptModes` has. A `Set` gives dedupe
 * with first-seen order for free. */
function readEnvironments(c: vscode.WorkspaceConfiguration): string[] {
  const raw = c.get<unknown[]>("environments");
  if (!Array.isArray(raw)) return [...DEFAULT_ENVIRONMENTS];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const trimmed = v.trim();
    if (trimmed) seen.add(trimmed);
  }
  return seen.size ? [...seen] : [...DEFAULT_ENVIRONMENTS];
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
    needsEnv: def.needsEnv === true,
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
    environments: readEnvironments(c),
    prReviewStatus: c.get<string>("prReviewStatus") || "PR initiated",
    prReviewAutoFix: c.get<boolean>("prReviewAutoFix") ?? true,
    prReviewPrompt: c.get<string>("prReviewPrompt") || DEFAULT_PR_REVIEW_PROMPT,
    worktree: (c.get<AgentFlowConfig["worktree"]>("worktree")) || "ask",
    remoteControl: (() => {
      const v = c.get<string>("remoteControl");
      return v === "on" || v === "ask" ? v : "off";
    })(),
    batchLaunchConfirmThreshold: Math.max(1, c.get<number>("batchLaunchConfirmThreshold") ?? 6),
    trackOpenWindows: c.get<boolean>("trackOpenWindows") ?? true,
    telemetryEnabled: c.get<boolean>("telemetry.enabled") ?? true,
    prFacts: c.get<boolean>("prFacts") ?? true,
    prFactsTtlSeconds: Math.max(30, c.get<number>("prFactsTtlSeconds") ?? 120),
    openAgents: c.get<boolean>("openAgents") ?? true,
    reviewRequests: c.get<boolean>("reviewRequests") ?? true,
    reviewRequestsTtlSeconds: Math.max(60, c.get<number>("reviewRequestsTtlSeconds") ?? 300),
    reviewWrites: c.get<boolean>("reviewWrites") ?? false,
    reviewRequestModes: (() => {
      // `c.get` would return the manifest default here, which is a non-empty
      // array — that is what VS Code serves to anyone who never touched the
      // setting, and it would make the legacy migration below unreachable.
      // Only an explicitly-set value tells us the user chose a modes list.
      const explicit = explicitConfigValue<PromptMode[]>(c, "reviewRequestModes");
      if (explicit !== undefined) {
        const valid = Array.isArray(explicit) ? explicit.filter((x) => x && x.id && x.label && x.prompt) : [];
        // An explicit modes list is a deliberate replacement and wins over the
        // deprecated string, even when it is unusable and we fall back to stock.
        return valid.length ? valid : DEFAULT_REVIEW_REQUEST_MODES;
      }
      // Migrate a customized legacy reviewRequestPrompt into the stock mode.
      const legacy = explicitConfigValue<string>(c, "reviewRequestPrompt");
      return legacy ? [{ ...DEFAULT_REVIEW_REQUEST_MODES[0], prompt: legacy }] : DEFAULT_REVIEW_REQUEST_MODES;
    })(),
    reviewRequestMode: c.get<string>("reviewRequestMode") || "ask",
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
