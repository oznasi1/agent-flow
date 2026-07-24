// Shared types across the extension host and webview.

export type Filter = "unassigned" | "mine" | "mysprint" | "sprint" | "backlog" | "all";
export type Size = "any" | "s" | "m" | "l"; // by original time estimate

/** Which secondary filter controls the task-pool sidebar shows. Each defaults to
 * true; a user hides the ones they don't use. The tab bar is always shown. */
export interface FilterVisibility {
  size: boolean;
  status: boolean;
  repo: boolean;
  search: boolean;
}

export interface JiraTask {
  key: string;
  summary: string;
  status: string;
  statusCategory: string; // "new" | "indeterminate" | "done"
  priority: string;
  assignee: string; // display name, or "Unassigned"
  labels: string[];
  components: string[];
  sprint: string | null;
  inOpenSprint: boolean; // is the issue currently in an active sprint?
  updated: string; // ISO
  url: string;
  estimateSeconds: number | null; // original time estimate
  services?: string[]; // lightweight guess for display
}

export interface ServiceRef {
  name: string;
  path: string;
  isGit: boolean;
}

export type WorkspaceMode = "multiroot" | "per-window";

/** A selectable "how should the agent start" mode with a prompt template.
 * Template placeholders: {key} {summary} {url} {brief} {files}. */
export interface PromptMode {
  id: string;
  label: string;
  prompt: string;
}

// ── The Deck: in-flight orchestration board ─────────────────────────────────────

/** Live agent activity, inferred best-effort from the Claude Code session transcript. */
export type AgentState = "working" | "needs-you" | "idle" | "unknown";

/** The board column a run lands in. */
export type DeckColumn = "progress" | "needs" | "review" | "done";

/** A durable record of a task launched via Agent Flow — the Deck's source of truth.
 * Written at take-time; enriched with live status on the fly. */
export interface Run {
  key: string;
  summary: string;
  url: string;
  createdAt: number; // epoch ms
  mode: WorkspaceMode;
  workspaceFile?: string; // multi-root .code-workspace, when mode === "multiroot"
  repos: { name: string; path: string; isGit: boolean; branch?: string }[];
  briefPaths: string[];
}

/** Per-repo git state — the reliable backbone of a run's status. */
export interface RepoGit {
  name: string;
  path: string;
  branch: string | null;
  dirty: boolean;
  ahead: number; // commits ahead of upstream (0 if no upstream)
  added: number; // total insertions in the working diff
  removed: number; // total deletions
  files: number; // files changed
}

/** Best-effort live agent activity from the transcript. */
export interface AgentActivity {
  state: AgentState;
  lastActivityMs: number | null; // transcript file mtime
  slug: string | null; // session slug (title), when known
}

/** A run reconciled with all observable sources — what a card renders. */
export interface RunStatus {
  run: Run;
  column: DeckColumn;
  jiraStatus: string | null;
  jiraCategory: string | null; // "new" | "indeterminate" | "done"
  repos: RepoGit[];
  agent: AgentActivity;
  windowOpen: boolean; // is this run's target window currently open? (from presence)
}

// ── The Marketplace: plugin/skill browser ───────────────────────────────────

/** A named item inside a plugin (skill, agent, or command) + its repo-relative path. */
export interface SkillRef {
  name: string;
  path: string;
}

/** One plugin listed by a marketplace, with its discovered contents. */
export interface PluginView {
  name: string;
  description: string;
  source: string; // repo-relative plugin directory, e.g. "plugins/cicd-plugin"
  skills: SkillRef[];
  agents: SkillRef[];
  commands: SkillRef[];
  installCommand: string; // "/plugin install <name>@<marketplace-name>"
}

export type MarketplaceErrorKind =
  | "gh-missing"
  | "gh-unauthenticated"
  | "repo-not-found"
  | "not-a-marketplace"
  | "parse-error"
  | "unknown";

/** A resolved marketplace repo — either its parsed contents, or a scoped error. */
export interface MarketplaceView {
  repo: string; // canonical "owner/repo"
  name: string; // marketplace.json name (the @handle for installs)
  description: string;
  owner: string;
  addCommand: string; // "/plugin marketplace add owner/repo"
  plugins: PluginView[];
  error?: { kind: MarketplaceErrorKind; message: string };
}

// Messages: webview → host
export type InboundMessage =
  | { type: "ready" }
  | { type: "fetch"; filter: Filter; size: Size }
  | { type: "detail"; key: string }
  | { type: "take"; key: string; services?: string[] }
  | { type: "takeBatch"; keys: string[]; repo: string }
  | { type: "addressPr"; key: string; services?: string[] }
  | { type: "changeStatus"; key: string }
  | { type: "addToMySprint"; key: string }
  | { type: "explore" }
  | { type: "openExternal"; url: string }
  | { type: "signIn" }
  | { type: "runSetup" }
  | { type: "retry" }
  | { type: "reorder"; order: string[] }
  | { type: "resetOrder"; size: Size }
  // The Deck (separate webview panel)
  | { type: "deck:ready" }
  | { type: "deck:refresh" }
  | { type: "deck:setLive"; on: boolean }
  | { type: "deck:inspect"; key: string; action: "open" | "diff"; repo?: string }
  | { type: "deck:forget"; key: string }
  // The Marketplace (separate webview panel)
  | { type: "mkt:ready" }
  | { type: "mkt:refresh" }
  | { type: "mkt:add"; repo: string }
  | { type: "mkt:remove"; repo: string }
  | { type: "mkt:copy"; text: string };

// Messages: host → webview
export type OutboundMessage =
  // `configured` is false until the Jira site URL + project key are set (first-run
  // setup). The webview uses it to show a "run setup" call-to-action rather than a
  // blank/loading panel.
  | { type: "state"; authed: boolean; configured: boolean; project: string; me: string | null; prReviewStatus: string; filters: FilterVisibility }
  | { type: "tasks"; filter: Filter; tasks: JiraTask[] }
  | { type: "detail"; key: string; descriptionText: string; inferred: string[]; repos: string[] }
  | { type: "statusChanged"; key: string; status: string; category: string; removed: boolean }
  | { type: "movedToSprint"; key: string; assignee: string; removed: boolean }
  | { type: "toast"; level: "success" | "error" | "info"; message: string }
  // A persistent, actionable failure banner (unlike a toast, it stays until resolved).
  | { type: "error"; message: string; canRetry: boolean }
  | { type: "loading"; loading: boolean }
  // The Deck
  | { type: "deck:runs"; runs: RunStatus[]; liveSignal: boolean }
  | { type: "deck:loading"; loading: boolean }
  // The Marketplace
  | { type: "mkt:state"; marketplaces: MarketplaceView[] }
  | { type: "mkt:loading"; loading: boolean };
