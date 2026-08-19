import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { FilterVisibility, FlowCommand, PromptMode } from "./types";

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

/** Seed for the "Supervise running tasks" action — check on Agent Flow's other
 * active runs rather than the current focus. Placeholders: {summary} (optional
 * priority), {brief} (includes the active-tasks list), {files}. */
export const DEFAULT_EXPLORE_SUPERVISE_PROMPT =
  "Supervision session — checking on your other active Agent Flow tasks. A brief listing them, and whether each " +
  "still has an agent attached, is at {brief}. Read it, judge which ones are stalled, blocked, or waiting on you, " +
  "and tell me what needs attention. Where it's safe and unambiguous, help unblock or integrate one yourself; " +
  "flag anything you're unsure about rather than guessing.{files}";

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

/** Exactly one built-in ships for `agentFlow.commands`, and it is inert by
 * construction: `echo` cannot fail or mutate anything, so a user who never
 * configured this setting still gets a real row in the picker — one that
 * demonstrates `{note}` substitution — instead of a picker that looks empty
 * and gives no sign named commands are even a thing. See `readCommands`'
 * doc comment for the rule this single entry has to satisfy. */
export const DEFAULT_COMMANDS: FlowCommand[] = [
  {
    id: "verify-on-dev",
    label: "Verify on dev",
    detail: "Example — replace the command with your own check",
    run: "echo verify the feature on {note}",
  },
];

/** Where Agent Flow starts a session. */
export type AgentSurface = "extension" | "terminal";

/** Read the session surface. Anything unrecognized — including undefined — means
 * the extension panel, so a typo in settings.json degrades to the default rather
 * than breaking seeding. Takes the configuration so getConfig() can share its
 * handle; called with no argument from the seeding path, which reads at seed time
 * rather than capturing at activation. */
export function readAgentSurface(
  c: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("agentFlow"),
): AgentSurface {
  return c.get<string>("agentSurface") === "terminal" ? "terminal" : "extension";
}

/** Which agent Agent Flow starts a session with. */
export type AgentProvider = "claude-code" | "copilot" | "cursor";

/** The VS Code family, by uri scheme: `vscode`, `vscode-insiders`, and any other
 * `vscode*` build. Cursor is `cursor`, Windsurf is `windsurf`. Preferred over
 * `env.appName`, which is localized, and it is the signal the seeding path already
 * reads. */
export function isVSCodeHost(): boolean {
  return (vscode.env.uriScheme ?? "").startsWith("vscode");
}

/** Cursor, by the same signal. Exact match, not a prefix: unlike the VS Code family
 * there are no `cursor-*` sibling builds, and a prefix test would claim any future
 * scheme that merely starts with those six letters. */
export function isCursorHost(): boolean {
  return (vscode.env.uriScheme ?? "") === "cursor";
}

/** Read the agent. Anything unrecognized — including undefined — means Claude Code,
 * so a typo in settings.json degrades rather than breaking seeding. `copilot` and
 * `cursor` each additionally require their own host: settings sync carries values
 * between editors, so each value degrades in the wrong editor instead of failing at
 * seed time. This runtime guard — not the manifest — is what makes the behavior
 * correct, and it is now the reason the manifest needs no `when` clause at all.
 * Called with no argument from the seeding path, which reads at seed time rather
 * than capturing at activation. */
export function readAgentProvider(
  c: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("agentFlow"),
): AgentProvider {
  const raw = c.get<string>("agentProvider");
  if (raw === "copilot" && isVSCodeHost()) return "copilot";
  if (raw === "cursor" && isCursorHost()) return "cursor";
  return "claude-code";
}

/** The agent's name, for copy that tells the user what was just seeded. */
export function providerLabel(p: AgentProvider): string {
  return p === "copilot" ? "Copilot" : p === "cursor" ? "Cursor" : "Claude Code";
}

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
  { id: "supervise", label: "Supervise running tasks", settingKey: "explorePrompts.supervise", defaultPrompt: DEFAULT_EXPLORE_SUPERVISE_PROMPT },
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
 * sentence is appended just before {files} when agentFlow.prReviewAutoFix is on —
 * see PR_REVIEW_AUTOFIX_CLAUSE and prReviewTemplate in engine/prompt.ts. */
export const DEFAULT_PR_REVIEW_PROMPT =
  'Jira {key} ({url}): "{summary}". This task has an open GitHub PR — all our PRs carry the Jira key in their title and branch. ' +
  "Using `gh` (or the GitHub tools available to you): find the PR for {key}, run `gh pr checkout` to bring its branch " +
  "into this worktree, then assess whether it's ready for us to work on — unresolved review comments and requested " +
  "changes, CI status, merge conflicts, and approval state. Summarize what you find.{files}";

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
  // Which task source to read from — an id in src/tasks/registry.ts. An
  // unregistered value resolves to Jira with a log line, never an empty board.
  taskSource: string;
  baseUrl: string;
  project: string;
  reposRoot: string;
  workspaceDir: string;
  githubOrg: string;
  repoBlocklist: string[];
  defaultFilter: string;
  seedAgent: boolean;
  // Which agent a seeded session starts: Claude Code, GitHub Copilot, or Cursor.
  // `copilot` is VS Code only and `cursor` is Cursor only; each degrades to
  // claude-code in the other host — see readAgentProvider.
  agentProvider: AgentProvider;
  // Where a seeded session opens: the Claude Code extension panel, or the `claude`
  // CLI in an integrated terminal.
  agentSurface: AgentSurface;
  workspaceMode: "auto" | "multiroot" | "per-window" | "ask";
  openIn: "ask" | "new-window" | "this-window" | "pick-existing";
  taskMode: string; // "ask", or a PromptMode id
  promptModes: PromptMode[];
  exploreMode: string; // "ask", or an ExploreAction id
  exploreActions: ExploreAction[];
  // Environments offered by Explore actions that verify against a live env.
  environments: string[];
  // Named commands an Orchestrator command node can run. No built-ins — an
  // empty list means the user hasn't opted into any.
  commands: FlowCommand[];
  /** Show the Deck header's "Tokens on board" total. Off by default: the figure
   * costs a board-wide transcript sweep, and the per-run breakdown in the detail
   * drawer is read lazily instead, so a default install parses nothing until a
   * drawer is opened. */
  showTokenTotal: boolean;
  prReviewStatus: string; // task status that reveals the "Address PR" card action
  prReviewAutoFix: boolean; // after assessing, proceed to implement the PR's requested changes
  prReviewPrompt: string; // seeded prompt for the PR-review kick-off
  worktree: "ask" | "always" | "never";
  /** Offer the child-worktree flow: a Take of a ticket with children asks whether to
   *  fan out into a worktree per child or run one orchestrator over them. Off by
   *  default, and the default is load-bearing — with it off, `probeTree` returns before
   *  reading anything, so an existing user's Take is byte-identical to what it was
   *  before this feature existed: no extra round trip, no new pickers, no new git. */
  childWorktrees: boolean;
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
  // Which lens the Deck's In-flight board opens in: one card per Claude Code
  // agent ("agents"), or today's one card per launched run with its agents
  // nested ("workspaces"). Written by the board's own segmented control.
  deckGrouping: "agents" | "workspaces";
  // How long a landed run (every PR merged, or Jira done with no PR open) stays
  // on the board with no agent in it before its record is retired. 0 = retire as
  // soon as it lands.
  retireFinishedAfterHours: number;
  // How long an abandoned run (no ticket, no PR, nothing uncommitted) may sit
  // untouched before its record is retired. 0 = never.
  retireAbandonedAfterDays: number;
  // How long a closed run stays in the Recently closed strip before its record
  // is deleted. 0 retires on sight.
  retireClosedAfterHours: number;
  // Show every run record on the board, pre-strip behaviour. The escape hatch.
  inflightShowAll: boolean;
  // Show the Deck's review-requests strip: open PRs that ask for your review.
  reviewRequests: boolean;
  // How stale the cached review queue may be before a refetch. Floored at 60s —
  // review requests move on a human timescale, not a CI one.
  reviewRequestsTtlSeconds: number;
  // Allow submitting approve / comment / request-changes from the Deck. The only
  // setting in Agent Flow Deck that lets it write to GitHub.
  reviewWrites: boolean;
  /** Show the Deck's Orchestrator chip and drawer. Off by default, like
   * `reviewWrites`: a flow eventually launches agents on a timer, so the whole
   * feature stays invisible until you ask for it. */
  orchestrator: boolean;
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

/** One entry of a mode-list setting exactly as settings.json may hold it: every
 * field unknown, because a hand-edited file can put anything here. Only `id` is
 * meaningful on its own — the rest are optional so an entry can override one
 * field of a built-in, or hide it, without restating the whole mode. */
interface ModeEntry {
  id?: unknown;
  label?: unknown;
  detail?: unknown;
  prompt?: unknown;
  hidden?: unknown;
}

/** The value if it is a string with something other than whitespace in it. */
function nonBlank(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** Resolve a mode-list setting into the list the picker shows. The setting is a
 * *layer* over `builtIns`, never a replacement for it: an entry whose `id` names
 * a built-in overrides that built-in field by field, an unknown `id` adds a mode
 * of the user's own, and `hidden: true` drops a built-in. Built-ins the user
 * never listed are appended in shipped order, which is the whole point — before
 * this, a customized list froze at the modes that existed the day it was written
 * and every later addition was invisible, silently, with nothing in the UI to
 * suggest anything was missing.
 *
 * The user's own entries stay first, in their order, so a deliberate reordering
 * survives; new built-ins land at the end, the one position that never disturbs
 * an existing arrangement. `hidden` wins over an override of the same id
 * wherever the two appear.
 *
 * Reads the *explicit* value only. `c.get` cannot tell a user's array from the
 * manifest default, and layering that default over itself would leave `hidden`
 * with nothing to hide for a user who never touched the setting. */
function resolveModes(
  c: vscode.WorkspaceConfiguration,
  key: string,
  builtIns: PromptMode[],
): PromptMode[] {
  const explicit = explicitConfigValue<unknown>(c, key);
  if (!Array.isArray(explicit)) return builtIns;

  const byId = new Map(builtIns.map((m) => [m.id, m]));
  const hidden = new Set<string>();
  const listed: PromptMode[] = [];
  const seen = new Set<string>();

  for (const raw of explicit) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as ModeEntry;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) continue;
    if (entry.hidden === true) {
      hidden.add(id);
      continue;
    }
    if (seen.has(id)) continue;
    const builtIn = byId.get(id);
    // Trimmed, unlike prompt below: a label is picker chrome, and padding in it
    // would render literally, while padding in a prompt template can be
    // intentional.
    const label = nonBlank(entry.label)?.trim() ?? builtIn?.label;
    const prompt = nonBlank(entry.prompt) ?? builtIn?.prompt;
    // A mode of the user's own has no built-in to inherit from, so it needs both.
    if (!label || !prompt) continue;
    const detail = nonBlank(entry.detail) ?? builtIn?.detail;
    seen.add(id);
    listed.push({ id, label, prompt, ...(detail !== undefined ? { detail } : {}) });
  }

  const appended = builtIns.filter((m) => !seen.has(m.id));
  const resolved = [...listed, ...appended].filter((m) => !hidden.has(m.id));
  // An empty picker is a dead end with no in-product way out of it.
  return resolved.length ? resolved : builtIns;
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

/** Unlike `promptModes`, the built-in here isn't a menu of real options to
 * layer a customization over — it's a single example, `DEFAULT_COMMANDS`,
 * shown so a user who never configured this setting can see that named
 * commands are a thing and how `{note}` reaches one. That is only safe
 * because the rule survives from this comment's earlier shape: a command
 * list is something the user opts into running, so no default entry may
 * have real effects — inventing (or shipping) anything that could act would
 * put a runnable command into a picker nobody configured. The one example
 * is `echo`, which cannot fail or mutate anything; the next built-in added
 * here has to clear the same bar, not just be plausible-looking.
 *
 * An entry with no usable `id` or no `run` is dropped: the id is how a node
 * refers to it, and a command with nothing to execute is a picker row that
 * fails at the moment it is trusted. A missing `label` falls back to the id
 * rather than rendering a blank row. */
function readCommands(c: vscode.WorkspaceConfiguration): FlowCommand[] {
  const raw = c.get<unknown[]>("commands");
  // Spread from DEFAULT_COMMANDS, not a bare `[]` literal — same wiring
  // readEnvironments gives DEFAULT_ENVIRONMENTS, so the exported constant is
  // what a missing setting actually resolves to, not a decorative export a
  // mutation to could change with nothing here noticing.
  if (!Array.isArray(raw)) return [...DEFAULT_COMMANDS];
  const out: FlowCommand[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const e = v as Partial<FlowCommand>;
    const id = typeof e.id === "string" ? e.id.trim() : "";
    const run = typeof e.run === "string" ? e.run.trim() : "";
    if (!id || !run || seen.has(id)) continue;
    seen.add(id);
    const label = typeof e.label === "string" && e.label.trim() ? e.label.trim() : id;
    out.push({ id, label, run, ...(typeof e.detail === "string" && e.detail.trim() ? { detail: e.detail.trim() } : {}) });
  }
  return out;
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
    taskSource: c.get<string>("taskSource") || "jira",
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
    agentProvider: readAgentProvider(c),
    agentSurface: readAgentSurface(c),
    workspaceMode: (c.get<AgentFlowConfig["workspaceMode"]>("workspaceMode")) || "auto",
    openIn: (c.get<AgentFlowConfig["openIn"]>("openIn")) || "ask",
    taskMode: c.get<string>("taskMode") || "ask",
    promptModes: resolveModes(c, "promptModes", DEFAULT_PROMPT_MODES),
    exploreMode: c.get<string>("exploreMode") || "ask",
    exploreActions,
    environments: readEnvironments(c),
    commands: readCommands(c),
    // `?? false` rather than `|| false`: an explicit `false` and an unset value
    // must both read false, and neither may be silently coerced by a truthiness
    // check the way the string settings above are.
    showTokenTotal: c.get<boolean>("deck.showTokenTotal") ?? false,
    prReviewStatus: c.get<string>("prReviewStatus") || "PR initiated",
    prReviewAutoFix: c.get<boolean>("prReviewAutoFix") ?? true,
    prReviewPrompt: c.get<string>("prReviewPrompt") || DEFAULT_PR_REVIEW_PROMPT,
    worktree: (c.get<AgentFlowConfig["worktree"]>("worktree")) || "ask",
    childWorktrees: c.get<boolean>("childWorktrees") ?? true,
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
    deckGrouping: c.get<string>("deckGrouping") === "workspaces" ? "workspaces" : "agents",
    // Floored, not defaulted: 0 is meaningful (disable the window) and must
    // survive, while a negative value is a typo that would retire on a clock
    // running backwards.
    retireFinishedAfterHours: Math.max(0, c.get<number>("retireFinishedAfterHours") ?? 24),
    retireAbandonedAfterDays: Math.max(0, c.get<number>("retireAbandonedAfterDays") ?? 7),
    retireClosedAfterHours: Math.max(0, c.get<number>("retireClosedAfterHours") ?? 24),
    inflightShowAll: c.get<boolean>("inflightShowAll") ?? false,
    reviewRequests: c.get<boolean>("reviewRequests") ?? true,
    reviewRequestsTtlSeconds: Math.max(60, c.get<number>("reviewRequestsTtlSeconds") ?? 300),
    reviewWrites: c.get<boolean>("reviewWrites") ?? false,
    orchestrator: c.get<boolean>("orchestrator") ?? false,
    reviewRequestModes: (() => {
      // An explicit modes list is a deliberate layer over the built-ins and wins
      // over the deprecated string, even when it holds nothing usable.
      if (explicitConfigValue<unknown>(c, "reviewRequestModes") !== undefined) {
        return resolveModes(c, "reviewRequestModes", DEFAULT_REVIEW_REQUEST_MODES);
      }
      // Migrate a customized legacy reviewRequestPrompt into the first built-in,
      // carrying the rest of DEFAULT_REVIEW_REQUEST_MODES along with `slice(1)`
      // rather than hand-building a one-element array — so if a second stock
      // review mode ever ships, legacy-prompt users still receive it instead of
      // freezing at just the one mode this migration patches.
      const legacy = explicitConfigValue<string>(c, "reviewRequestPrompt");
      return legacy
        ? [{ ...DEFAULT_REVIEW_REQUEST_MODES[0], prompt: legacy }, ...DEFAULT_REVIEW_REQUEST_MODES.slice(1)]
        : DEFAULT_REVIEW_REQUEST_MODES;
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
