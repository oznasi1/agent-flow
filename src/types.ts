// Shared types across the extension host and webview.
// Type-only: src/tasks/provider.ts imports Filter/Task/Size from here, so a
// value import would be a runtime cycle. `import type` is erased at build time.
import type { SerializedCaps, TaskConnector } from "./tasks/provider";

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

export interface Task {
  key: string;
  summary: string;
  status: string;
  statusCategory: "new" | "indeterminate" | "done";
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

/** A durable record of a task launched via Agent Flow Deck — the Deck's source of truth.
 * Written at take-time; enriched with live status on the fly. */
export interface Run {
  key: string;
  summary: string;
  url: string;
  createdAt: number; // epoch ms
  /** What launched this run. Absent means "task" — every record written before
   * review runs existed. Review runs carry a PR url rather than a Jira one, so
   * this, not the url, is what keeps them out of Jira polling and the columns.
   * "local" is the one kind that is never written to the runs store: it marks a
   * place discovered from an open Claude Code session, and stops being true the
   * moment Track it lands. */
  kind?: "task" | "explore" | "review" | "local";
  mode: WorkspaceMode;
  workspaceFile?: string; // multi-root .code-workspace, when mode === "multiroot"
  repos: { name: string; path: string; isGit: boolean; branch?: string }[];
  briefPaths: string[];
  /** When this run was first observed to have landed — every PR merged, or Jira
   * done with no PR open — and no agent left in it. Stamped by the Deck's retire
   * sweep, not by any launch, and cleared again if the run stops satisfying that
   * condition. It exists because `createdAt` cannot time the grace window: a
   * three-week task would retire the instant it landed. Absent on every record
   * written before this field existed, and on every run still in flight. */
  finishedAt?: number;
}

const RUN_KINDS = new Set(["task", "explore", "review", "local"]);

/** A run's kind, tolerant of an old record with no field and of a hand-edited
 * one with a value we don't know. */
export function runKind(run: Run): "task" | "explore" | "review" | "local" {
  return RUN_KINDS.has(run.kind as string) ? (run.kind as "task" | "explore" | "review" | "local") : "task";
}

/** One open Claude Code session, as ~/.claude/sessions/<pid>.json records it.
 * Only the fields the Deck reads; the file carries more. Declared here rather
 * than in engine/sessions.ts because the webview renders session names and must
 * not import a module that touches `fs`. */
export interface OpenSession {
  pid: number;
  sessionId: string; // names the transcript: <sessionId>.jsonl
  cwd: string;
  startedAt: number; // epoch ms, 0 when the record omits it
  name: string | null; // Claude's derived label, e.g. "agent-flow-2e"
}

/** Is this run attached to a Jira ticket? An Explore session is launched with a
 * synthetic `explore-<slug>` key and no ticket url: there is no Jira issue to
 * poll, and `gh pr list --head <default-branch>` can only return a pull request
 * belonging to somebody else. A **review** run is excluded for the opposite
 * reason — it has a url, but it is a PR's, and polling Jira for
 * `review-centaur-850` would 404 every 30 seconds forever. Tolerates an older or
 * hand-edited record with no url field at all. */
export function isTicketRun(run: Run): boolean {
  if (runKind(run) === "review") return false;
  return typeof run.url === "string" && run.url.trim().length > 0;
}

/** The task key to poll for a run. A task run's key IS its ticket, but a local
 * card Track it saved under its place-hash — because a real run already owned
 * the inferred key — carries the ticket only in its url. The connector owns the
 * url shape; a url it does not recognise (a record from another source, or an
 * Explore run with none) falls back to the record key, which is what every run
 * Agent Flow launched already equals. */
export function ticketKeyFor(run: Run, connector: Pick<TaskConnector, "keyFromUrl">): string {
  const url = typeof run.url === "string" ? run.url : "";
  return connector.keyFromUrl(url) ?? run.key;
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

/** One open Claude Code session attached to a card, with its own live state.
 * `activity` is UNKNOWN_ACTIVITY when the Live signal is off — the registry
 * still knows the session is open, it is only the transcript that goes unread. */
export interface CardAgent {
  session: OpenSession;
  activity: AgentActivity;
  /** The `run.repos[].name` whose directory this session runs in. Set host-side,
   * where the session was matched against that repo's path in the first place —
   * the webview only has a `cwd`, and an agent card's Open and Diff must act on
   * the directory its own agent is in, not the run's first repo. Absent on a
   * local card's agents, which have exactly one repo to act on anyway. */
  repo?: string;
}

/** A run reconciled with all observable sources — what a card renders. */
export interface RunStatus {
  run: Run;
  column: DeckColumn;
  ticketStatus: string | null;
  ticketCategory: string | null; // "new" | "indeterminate" | "done"
  repos: RepoGit[];
  agent: AgentActivity;
  windowOpen: boolean; // is this run's target window currently open? (from presence)
  prs: PrEntryMap; // repo name → observed PR state ({} when prFacts is off)
  agents: CardAgent[]; // every open session in this run's directories
  /** A local card's ticket key, inferred from its branch name rather than from a
   * launch — set only when the run is local and its url resolved to one. The
   * branch could name a ticket somebody else owns, so the status shown on the
   * card would then be theirs; the webview renders this key differently from a
   * launched run's for exactly that reason. Computed host-side, through the
   * connector (see `ticketKeyFor`), because the webview has no connector of its
   * own to parse a url with — this is the one place that value crosses the wire. */
  inferredTicketKey?: string;
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
  // One chip on one ticket. `movedChip` says whether the chip's presence in the
  // list changed too — which is what makes a rejected write exactly undoable.
  | { type: "setComponent"; key: string; repo: string; on: boolean; movedChip: boolean }
  // The Deck (separate webview panel)
  | { type: "deck:ready" }
  | { type: "deck:refresh" }
  | { type: "deck:setLive"; on: boolean }
  | { type: "deck:setPrFacts"; on: boolean }
  | { type: "deck:setOpenAgents"; on: boolean }
  | { type: "deck:setReviewQueue"; on: boolean }
  | { type: "deck:setGrouping"; grouping: "agents" | "workspaces" }
  | { type: "deck:clearStale" }
  | { type: "deck:inspect"; key: string; action: "open" | "diff"; repo?: string }
  | { type: "deck:forget"; key: string }
  | { type: "deck:track"; key: string }
  | { type: "deck:addressPr"; key: string }
  | { type: "deck:setReviewSort"; sort: ReviewSort }
  | { type: "deck:reviewExpand"; id: string }
  | { type: "deck:reviewLaunch"; id: string }
  | { type: "deck:reviewLoadDraft"; id: string }
  | { type: "deck:reviewSubmit"; id: string; verb: ReviewVerb; body: string; fromDraft: boolean }
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
  // liveCount is absent when trackOpenWindows is off: the sidebar then shows the
  // static mark rather than claiming zero windows are open.
  | { type: "state"; authed: boolean; configured: boolean; project: string; me: string | null;
      prReviewStatus: string; filters: FilterVisibility; liveCount?: number;
      /** The task source's user-facing name — every "Sign in to X" string reads
       * this rather than hardcoding a tracker. */
      sourceLabel: string;
      /** Which optional affordances to render. Flat booleans: the capability
       * objects on TaskProvider cannot be structured-cloned. */
      caps: SerializedCaps }
  // Recomputed on every pool refresh (same trackOpenWindows gate and liveWindows()
  // source as `state`'s liveCount), so the header gauge doesn't go stale between
  // `state` posts — it was previously a mount-time snapshot only.
  | { type: "tasks"; filter: Filter; tasks: Task[]; liveCount?: number }
  | { type: "detail"; key: string; descriptionText: string; inferred: string[]; repos: string[];
      // The components actually on the issue, spelled as Jira spells them, and the
      // repo → component map for every discovered repo. Together with `inferred`
      // these classify each chip: on the issue, pushable, or local-only. `mappable`
      // is `null` when the project's component list itself couldn't be read — a
      // distinct case from "maps to nothing", and one no chip state can be claimed for.
      sourceComponents: string[]; mappable: Record<string, string> | null }
  // `category` is always one of Task's three — `StatusTarget.toCategory`'s fourth,
  // uncategorized "" value is folded into "new" before this is posted (see
  // tasksView.ts's changeStatus), the same fallback deriveStatuses/railClass already
  // use for a task whose own category came back empty.
  | { type: "statusChanged"; key: string; status: string; category: Task["statusCategory"]; removed: boolean }
  | { type: "movedToSprint"; key: string; assignee: string; removed: boolean }
  | { type: "removedFromSprint"; key: string }
  // The verdict on one `setComponent`: the request echoed back, plus whether it
  // landed. On `ok: false` the webview undoes exactly what it applied optimistically.
  | { type: "componentsChanged"; key: string; repo: string; on: boolean; movedChip: boolean; ok: boolean }
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
  | { type: "deck:runs"; runs: RunStatus[]; liveSignal: boolean; prFacts: boolean; openAgents: boolean; reviewQueue: boolean; ghNote: string | null; prReviewStatus: string;
      // Which lens to render. Echoed on every post rather than sent once, so a
      // reload or a settings-page edit lands without a separate message.
      grouping: "agents" | "workspaces";
      // How many runs would retire right now if both retirement windows were
      // ignored. Drives the Clear stale button, which is hidden at zero.
      staleCount: number }
  | { type: "deck:loading"; loading: boolean }
  | {
      type: "deck:reviews";
      requests: ReviewRequest[];
      issueCount: number;
      sort: ReviewSort;
      stale: boolean; // the last fetch failed; these are the previous results
      reviewWrites: boolean; // agentFlow.reviewWrites — the strip's box and verbs render only when true
      // false when the strip has been switched off (reviewRequests, PR facts, or
      // gh going unusable) — distinct from a genuine empty queue. Lets the webview
      // drop the "To review" stat tile entirely rather than showing "0 To review",
      // and actively clears any rows it was rendering rather than leaving them
      // frozen (and their write buttons clickable) with nothing ever told to stop.
      enabled: boolean;
      // The strip is on and a first search is still in flight, with nothing cached
      // to render in the meantime. Distinct from `enabled: true` with an empty
      // `requests` — that is a genuinely empty queue, and says so. Only ever true
      // on a cold start: a machine with a cache on disk posts that instead, from
      // `deck:ready`, before the board build has even begun.
      loading: boolean;
    }
  // `detail: null` means the per-PR detail call itself failed (not "no failing
  // checks and unknown thread count", which is what an empty-but-successful
  // result looks like) — the webview tells the two apart to stop showing
  // "loading…" forever on a row whose fetch already gave up.
  | { type: "deck:reviewDetail"; id: string; detail: ReviewDetail | null }
  // The agent's findings, read from the worktree on demand — not carried on
  // every deck:reviews post, since the strip re-posts on every poll tick.
  | { type: "deck:reviewDraft"; id: string; body: string }
  // The explicit outcome of one deck:reviewSubmit, posted at all three exits of
  // submitReview: a declined confirmation ("cancelled"), a provider rejection
  // ("failed"), or a completed write ("ok"). Neither `toast` nor `deck:reviews`
  // carries this id, and both can arrive for unrelated reasons while a submit is
  // still in flight — this is the only message the webview can trust to release
  // that row's disable, or to know a failure was *this* row's.
  | { type: "deck:reviewSubmitDone"; id: string; outcome: "ok" | "failed" | "cancelled" }
  // The Marketplace
  | { type: "mkt:assets"; view: ClaudeAssetsView }
  | { type: "mkt:loading"; loading: boolean }
  // Contents of one previewed file. Never part of the scan payload: 350-odd
  // markdown bodies would bloat every rescan, and the panel rescans on refocus.
  | { type: "mkt:file"; file: string; text: string; truncated: boolean };
