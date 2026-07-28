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
 * Template placeholders: {key} {summary} {url} {brief} {files}.
 * `detail` is the line shown under the label in the picker — written for the
 * user, not derived from the prompt. Modes without one render label-only. */
export interface PromptMode {
  id: string;
  label: string;
  detail?: string;
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

/** Is this run attached to a Jira ticket? An Explore session is launched with a
 * synthetic `explore-<slug>` key, no ticket url, and no branch Agent Flow named:
 * there is no Jira issue to poll, and `gh pr list --head <default-branch>` can
 * only return a pull request belonging to somebody else. Tolerates an older or
 * hand-edited run record with no url field at all. */
export function isTicketRun(run: Run): boolean {
  return typeof run.url === "string" && run.url.trim().length > 0;
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
  prs: PrEntryMap; // repo name → observed PR state ({} when prFacts is off)
}

// ── PR & CI observation ─────────────────────────────────────────────────────

/** One CI check, named and linkable. */
export interface PrCheck {
  name: string;
  url: string; // "" when gh reports no details URL
}

/** One repo's observed pull-request state. Every field derived, none required. */
export interface PrFacts {
  number: number;
  url: string;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  ci: { passing: number; pending: number; failing: PrCheck[] };
  review: "approved" | "changes_requested" | "review_required" | "none";
  unresolved: number | null; // null = the GraphQL call was skipped
  mergeable: "clean" | "conflicting" | "behind" | "blocked" | "unknown";
  /** Every required check passed and something optional did not
   * (`mergeStateStatus === "UNSTABLE"`). Failing checks render, but do not block. */
  ciAdvisory: boolean;
}

/** What the store holds per repo. The wrapper — not `PrFacts` — carries the
 * timestamp, so that "this repo has no PR" is itself a cacheable answer. */
export interface PrEntry {
  facts: PrFacts | null; // null = resolved, and there is no PR for this repo
  fetchedAt: number; // epoch ms
  error?: boolean; // last attempt failed; `facts` is the previous value, if any
}

/** Repo name → its PR entry, as stored per run and rendered per card. */
export type PrEntryMap = Record<string, PrEntry>;

// ── Review requests: PRs waiting on you ─────────────────────────────────────

export type ReviewSize = "S" | "M" | "L";
export type ReviewSort = "oldest" | "smallest";
export type ReviewVerb = "approve" | "comment" | "request-changes";

/** One PR asking for your review — everything the strip renders unexpanded.
 * `localPath`, `runKey` and `draftPath` are observed locally on every refresh and
 * never persisted: a cached path to a worktree since forgotten would render an
 * action that cannot work. */
export interface ReviewRequest {
  id: string; // "owner/repo#number" — stable across refreshes
  repo: string; // nameWithOwner
  repoName: string; // short name, for matching a local checkout
  number: number;
  title: string;
  url: string;
  author: string;
  isDraft: boolean;
  createdAt: number; // epoch ms
  updatedAt: number; // epoch ms
  additions: number;
  deletions: number;
  changedFiles: number;
  ci: "passing" | "failing" | "pending" | "none";
  review: PrFacts["review"];
  mergeable: PrFacts["mergeable"];
  localPath: string | null; // matched checkout; null disables the agent action
  runKey: string | null; // a review run in flight for this PR
  draftPath: string | null; // .pick-task/REVIEW-<n>.md, once the agent writes it
}

/** What expanding a row adds — the two things the search cannot return. */
export interface ReviewDetail {
  failing: PrCheck[];
  unresolved: number | null;
}

// ── The Marketplace: local asset browser ────────────────────────────────────

export type AssetType = "skill" | "command" | "agent" | "hook";

/** Where a plugin's content came from. "user" = yours, not from a plugin at all
 * (covers both ~/.claude and the open workspace). */
export type PluginState = "installed" | "clone" | "manifest" | "user";

/** One discoverable thing: a skill, slash command, subagent, or hook. */
export interface AssetView {
  type: AssetType;
  name: string;
  description: string;
  plugin: string; // "(user)" for ~/.claude, "(workspace)" for the open folder
  marketplace: string; // "~/.claude" or the workspace folder name, for those two
  file: string; // absolute path, for open/reveal
  rel: string; // shown in the detail pane
  enabled: boolean | null; // null = not declared in any settings file
  state: PluginState;
  /** The plugin manifest's `category`, lower-cased; "yours" for your own assets,
   * "uncategorized" when the manifest omits it. Groups the browse list. */
  category: string;
}

/** A plugin row — shown under the "Plugins" filter, including ones not on disk. */
export interface PluginRowView {
  name: string;
  marketplace: string;
  description: string;
  state: PluginState;
  enabled: boolean | null;
  scopes: string[];
  version: string;
  counts: Record<AssetType, number>;
  category: string; // same vocabulary as AssetView.category
  readme: string; // absolute path to the README in the content dir, or ""
  installCommand: string; // "/plugin install <plugin>@<marketplace>"
}

export interface MarketplaceSourceView {
  name: string;
  kind: "github" | "directory" | "user";
  origin: string; // "owner/repo", an absolute path, or "~/.claude"
  pluginCount: number;
  stale: boolean; // installLocation is gone from disk
}

export interface ClaudeAssetsView {
  marketplaces: MarketplaceSourceView[];
  plugins: PluginRowView[];
  assets: AssetView[];
  notSetUp: boolean; // no ~/.claude/plugins at all
  scannedAt: number;
}

// Messages: webview → host
export type InboundMessage =
  | { type: "ready" }
  | { type: "fetch"; filter: Filter; size: Size }
  | { type: "detail"; key: string }
  | { type: "take"; key: string; services?: string[] }
  | { type: "takeBatch"; keys: string[]; repos: string[] }
  | { type: "addressPr"; key: string; services?: string[] }
  | { type: "changeStatus"; key: string }
  | { type: "addToMySprint"; key: string }
  | { type: "explore" }
  | { type: "openExternal"; url: string }
  | { type: "signIn" }
  | { type: "runSetup" }
  | { type: "retry" }
  | { type: "runDoctor" }
  | { type: "reorder"; order: string[] }
  | { type: "resetOrder"; size: Size }
  | { type: "removeFromSprint"; key: string; size: Size }
  // The Deck (separate webview panel)
  | { type: "deck:ready" }
  | { type: "deck:refresh" }
  | { type: "deck:setLive"; on: boolean }
  | { type: "deck:setPrFacts"; on: boolean }
  | { type: "deck:inspect"; key: string; action: "open" | "diff"; repo?: string }
  | { type: "deck:forget"; key: string }
  | { type: "deck:setReviewSort"; sort: ReviewSort }
  | { type: "deck:reviewExpand"; id: string }
  // The Marketplace (separate webview panel)
  | { type: "mkt:ready" }
  | { type: "mkt:refresh" }
  | { type: "mkt:copy"; text: string }
  | { type: "mkt:open"; file: string }
  | { type: "mkt:reveal"; file: string }
  | { type: "mkt:read"; file: string };

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
  | { type: "removedFromSprint"; key: string }
  // `action` renders a button beside the message — a refused write can hand the user
  // straight to the ticket, which is the only place left to resolve it.
  | { type: "toast"; level: "success" | "error" | "info"; message: string; action?: { label: string; url: string } }
  // A persistent, actionable failure banner (unlike a toast, it stays until resolved).
  // `canRunDoctor` offers the diagnostic on exactly the failures Doctor covers —
  // unreachable site, bad project key, auth loss — instead of hoping the user knows
  // the command exists.
  | { type: "error"; message: string; canRetry: boolean; canRunDoctor?: boolean }
  | { type: "loading"; loading: boolean }
  // The Deck
  | { type: "deck:runs"; runs: RunStatus[]; liveSignal: boolean; prFacts: boolean; ghNote: string | null }
  | { type: "deck:loading"; loading: boolean }
  | {
      type: "deck:reviews";
      requests: ReviewRequest[];
      issueCount: number;
      sort: ReviewSort;
      stale: boolean; // the last fetch failed; these are the previous results
    }
  | { type: "deck:reviewDetail"; id: string; detail: ReviewDetail }
  // The Marketplace
  | { type: "mkt:assets"; view: ClaudeAssetsView }
  | { type: "mkt:loading"; loading: boolean }
  // Contents of one previewed file. Never part of the scan payload: 350-odd
  // markdown bodies would bloat every rescan, and the panel rescans on refocus.
  | { type: "mkt:file"; file: string; text: string; truncated: boolean };
