// Shared types across the extension host and webview.
// Type-only: src/tasks/provider.ts imports Filter/Task/Size from here, so a
// value import would be a runtime cycle. `import type` is erased at build time.
import type { SerializedCaps, TaskConnector } from "./tasks/provider";
import type { Flow } from "./engine/orchestrator/model";
import type { UsageTotals } from "./engine/usage";
// A verdict enum, not a value module — `deck:flows` carries a map of these so the
// drawer can say what a branch-CI rule is waiting on. Re-exported because the
// webview reads it from here: `src/webview/*` may import `branchCi.ts` safely
// today, but every other Deck type it needs already comes from this module and
// one door is easier to keep webview-safe than two.
import type { BranchCiStatus } from "./engine/orchestrator/branchCi";
export type { BranchCiStatus };

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
  /** The source's own type name — "Story", "Sub-task", "Spike". Raw on purpose:
   * a project that renamed its types should have the tooltip say what it renamed
   * them to. `ticketKind()` (webview) is what turns this into a render kind.
   * Optional so nothing that already builds a Task has to change. */
  type?: string;
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

/** The subset of a `PromptMode` the orchestrator inspector needs to list and
 * select one — never the `prompt` text itself, which can be long and is never
 * displayed there. The webview cannot read config directly (it has no fs
 * access), so this is what `deck:flows` carries instead of the full mode. */
export interface FlowPromptMode {
  id: string;
  label: string;
}

/** One entry in `agentFlow.commands`: a named command a flow rule can run.
 * `run` may contain `{note}`, substituted with the rule's own free text. */
export interface FlowCommand {
  id: string;
  label: string;
  run: string;
  detail?: string;
}

// ── The Deck: in-flight orchestration board ─────────────────────────────────────

/** `blocked`, `stalled` and `exited` all mean "look at this", and all three were
 * `idle` before: an agent waiting at a permission prompt and one that died
 * mid-tool used to render in the calmest tone on the board. `stalled` and
 * `blocked` are derived from the transcript alone — `blocked` where the pending
 * tool's name settles what `stalled` can only hedge about (see
 * `deriveActivity`); `exited` needs session liveness and so is assigned by
 * `buildRunStatus` (see AgentActivity.midWork). */
export type AgentState = "working" | "needs-you" | "blocked" | "stalled" | "exited" | "idle" | "unknown";

/** The board column a run lands in, in board order. Attention rises left to
 * right and ends at the merge: something is running, something wants you,
 * something is parked on other people, something is one click from done.
 *
 * `merge` spans the merge itself, both sides of it: a pull request one press from
 * landing, and one that already has. The far side is deliberately still on the
 * board — a merge is where the wrap-up starts (move the ticket, delete the
 * branch, watch the deploy), not where the work ends, and a column you cannot
 * see cannot hold you to any of it. `DeckLane` splits the two.
 *
 * There is deliberately no `done`. A ticket somebody marked done that never
 * merged produced nothing to wrap up, and leaves for the Recently closed strip
 * (see `shelfFor`) with the only two things left to do with it: reopen, forget. */
export type DeckColumn = "progress" | "needs" | "review" | "merge";

/** A band inside a column, for the three columns that hold more than one thing.
 * `null` on `needs`, the one column that means exactly what its name says.
 * Derived, never posted by the host.
 *
 * `progress` splits on whether anybody is home: `working` is a live agent,
 * `parked` is the in-flight catch-all — a run whose agent went quiet, or one
 * with no agent at all. `review` splits on who owes the next move: `fixes` is a
 * PR asking you for something (red CI, changes requested, a conflict), `waiting`
 * is a PR asking somebody else. `merge` splits the two tenses of the same event:
 * a PR still to press, and one already landed with its aftermath to settle. */
export type DeckLane = "working" | "parked" | "fixes" | "waiting" | "ready" | "merged";

/** Where a run sits on the In-flight view: a board column, or the Recently
 * closed strip. Membership only — `DeckColumn` still says which column. */
export type Shelf = "board" | "closed";

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
   * moment Track it lands.
   * "notepad" is a run launched from the Notepad tab: ticketless like "explore",
   * but distinguishable from it so the board can label it for what it is. */
  kind?: "task" | "explore" | "review" | "local" | "notepad";
  /** The agent this run was launched with — the one `openWorkspace` actually resolved
   * and seeded, not the setting, so it names the real agent even under `ask`. Absent on
   * every record written before this field existed, on a `local` run (never launched by
   * Agent Flow at all), and on a launch that seeded no agent — in which case nothing
   * here is driving the run yet and the card must not claim otherwise. */
  provider?: AgentProvider;
  mode: WorkspaceMode;
  workspaceFile?: string; // multi-root .code-workspace, when mode === "multiroot"
  repos: { name: string; path: string; isGit: boolean; branch?: string }[];
  briefPaths: string[];
  /** The parent ticket this run was taken under, when it came out of a parent's tree
   *  rather than on its own. Absent on every run taken by itself, and on every record
   *  written before child takes existed. */
  parentKey?: string;
  /** The child worktrees this run owns — set only for an orchestrator-mode take, where
   *  one session dispatches a subagent per child. Each row is a real worktree on disk;
   *  the children are NOT runs of their own, which is why they live here rather than as
   *  separate records. */
  children?: { key: string; summary: string; repo: string; path: string; branch: string }[];
  /** When this run was first observed to have landed — every PR merged, or Jira
   * done with no PR open — and no agent left in it. Stamped by the Deck's retire
   * sweep, not by any launch, and cleared again if the run stops satisfying that
   * condition. It exists because `createdAt` cannot time the grace window: a
   * three-week task would retire the instant it landed. Absent on every record
   * written before this field existed, and on every run still in flight. */
  finishedAt?: number;
  /** When this run was first observed to have no live work left — no agent of its
   * own open, no PR, nothing uncommitted or unpushed, and past its launch grace.
   * Stamped by
   * the Deck's retire sweep and cleared again the moment any of that comes back, so
   * the Recently-closed window survives a panel reload. Absent on every record
   * written before this field existed, and on every run still on the board. */
  closedAt?: number;
}

const RUN_KINDS = new Set(["task", "explore", "review", "local", "notepad"]);

/** A run's kind, tolerant of an old record with no field and of a hand-edited
 * one with a value we don't know. */
export function runKind(run: Run): "task" | "explore" | "review" | "local" | "notepad" {
  return RUN_KINDS.has(run.kind as string)
    ? (run.kind as "task" | "explore" | "review" | "local" | "notepad")
    : "task";
}

/** Which agent Agent Flow starts a session with. Declared here rather than in
 * config.ts because the webview renders a per-provider mark and must not import a
 * module that touches `vscode`; config.ts re-exports it, so every existing importer
 * keeps working. */
export type AgentProvider = "claude-code" | "copilot" | "cursor";

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
 * `review-webapp-850` would 404 every 30 seconds forever. Tolerates an older or
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
  /** The transcript ends with work owed — an unanswered tool_use, or a user line
   * with no assistant reply. `buildRunStatus` promotes this to state "exited"
   * when no live session claims the run, which is the one thing a per-file
   * reducer cannot know. Optional so every existing AgentActivity literal
   * (the test suite is full of them) still compiles; absent means false. */
  midWork?: boolean;
  /** The name of the tool call a pending turn is waiting on — "Bash", "Edit",
   * "AskUserQuestion" — or null when there is no pending call or the line could
   * not be read. This is what lets a card say WHY it is stopped instead of
   * hedging: `deriveActivity`'s `stalled` is deliberately true of both a
   * permission prompt and a long command, and the tool's name is the only
   * discriminator the transcript offers. Optional so every existing
   * AgentActivity literal (the test suite is full of them) still compiles. */
  pendingTool?: string | null;
  /** The model the last main-chain assistant line answered with, e.g. "claude-opus-5".
   * Null when the tail carries no such line — a transcript whose last 200 lines are all
   * subagent work, or a session that has not answered yet. Optional so every existing
   * AgentActivity literal (the test suite is full of them) still compiles. */
  model?: string | null;
  /** How many DISTINCT main-chain models the tail holds. 1 in the ordinary case, more
   * when the session switched mid-run — which the drawer marks with a "+N". */
  modelCount?: number;
}

/** One open Claude Code session attached to a card, with its own live state.
 * `activity` is UNKNOWN_ACTIVITY when the transcript cannot be read — the registry
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
  /** Which tool is driving this run, for the card's provider mark. The run record's own
   * stamp when it has one; otherwise inferred — a live Claude Code session in this run's
   * directories means `claude-code`, because `~/.claude/sessions` is the only agent
   * registry the Deck can read. Absent when neither answers, and the card then shows no
   * mark rather than guessing from the current setting, which may have changed since the
   * launch or be `ask`. */
  provider?: AgentProvider;
  /** A local card's ticket key, inferred from its branch name rather than from a
   * launch — set only when the run is local and its url resolved to one. The
   * branch could name a ticket somebody else owns, so the status shown on the
   * card would then be theirs; the webview renders this key differently from a
   * launched run's for exactly that reason. Computed host-side, through the
   * connector (see `ticketKeyFor`), because the webview has no connector of its
   * own to parse a url with — this is the one place that value crosses the wire. */
  inferredTicketKey?: string;
  /** Board or Recently-closed strip. Computed host-side because the rule needs
   * path ownership, which needs canonical paths and therefore `fs`. */
  shelf: Shelf;
  /** Cumulative token usage across this run's sessions, absent until the usage
   * sweep has read it. Absent and zero are NOT the same: a run not yet measured
   * must not render like one that cost nothing, so the card shows no figure for
   * `undefined` rather than "0". */
  usage?: UsageTotals;
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

/** Why an agent is being seeded against a PR. Shared vocabulary between
 * `src/webview/deckSignal.ts` (derives it from `PrFacts`) and
 * `src/engine/prompt.ts` (turns it into the seeded prompt's opening clause) —
 * declared here, not in the webview module, because an `engine/` import from
 * `webview/` would invert this codebase's layering. */
export type PrWorkReason = "ci" | "conflict" | "review";

/** What the store holds per repo. The wrapper — not `PrFacts` — carries the
 * timestamp, so that "this repo has no PR" is itself a cacheable answer. */
export interface PrEntry {
  facts: PrFacts | null; // null = resolved, and there is no PR for this repo
  fetchedAt: number; // epoch ms
  error?: boolean; // last attempt failed; `facts` is the previous value, if any
}

/** Repo name → its PR entry, as stored per run and rendered per card. */
export type PrEntryMap = Record<string, PrEntry>;

/** The footer legend's account entry: which CLI, acting as whom. */
export interface AccountSlot {
  cli: string;
  login: string;
  canSwitch: boolean;
  /** How many runs the forge could not read a PR for, 0 when every read
   *  succeeded. Rides on this slot rather than taking a second line: the account
   *  named here is the thing a reader would change to fix it, so the fact and its
   *  remedy belong on one row. `forgeNote` stands down whenever this is showing. */
  unreadRuns?: number;
}

// ── Review requests: PRs waiting on you ─────────────────────────────────────

export type ReviewSize = "S" | "M" | "L";
export type ReviewSort = "oldest" | "smallest";
export type ReviewVerb = "approve" | "comment" | "request-changes";
/** How a merge is performed. One spelling shared by the `agentFlow.mergeMethod`
 * setting, the confirmation dialog, and each forge provider's flag map — a second
 * spelling anywhere is a merge strategy the user did not choose. */
export type MergeMethod = "squash" | "merge" | "rebase";

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

/** What expanding a row adds — the facts the search cannot return. */
export interface ReviewDetail {
  failing: PrCheck[];
  unresolved: number | null;
  /** Diff size, for a forge whose search cannot carry it. Absent on GitHub, whose
   * search already filled `ReviewRequest.additions`/`deletions`/`changedFiles`;
   * `null` when the call failed. GitLab's REST API exposes no additions/deletions
   * aggregate, so its `additions` and `deletions` are 0 and only `changedFiles`
   * is real — see docs/FORGES.md. */
  size?: { additions: number; deletions: number; changedFiles: number } | null;
  /** CI verdict, for a forge whose queue call cannot carry one. Absent on GitHub,
   * whose search already filled `ReviewRequest.ci`; on GitLab the MR list sends no
   * pipeline field at all, so the chip starts as `"none"` and this — read off the
   * single-MR GET `detail` already makes — is the only thing that can correct it.
   * Optional, so no other forge's `ReviewDetail` has to invent a value. */
  ci?: ReviewRequest["ci"];
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

/** An armed flow with rules already met on the first evaluation after the panel
 * was created. Reported rather than acted on: a flow armed last week must not
 * spend anything the moment you reopen the Deck, before you have read what it is
 * about to do. */
export interface PendingResume {
  flowId: string;
  flowName: string;
  /** One line per rule about to fire, in the drawer's own words. */
  lines: string[];
}

// ── The Notepad: local, ticketless scratch items ────────────────────────────

/** One notepad item, exactly as persisted in globalState. Deliberately global
 * rather than per-workspace: these are the user's scratch items, not a repo's.
 * `lastRunKey` is the key of the most recent run launched from this note — the
 * only run-related field stored, since everything else is derived at read time. */
export interface NotepadItem {
  id: string;
  title: string;
  body: string;
  done: boolean;
  createdAt: number; // epoch ms
  lastRunKey?: string;
  /** Which user-defined section this note is filed under. Absent means
   * ungrouped — sections are opt-in, so an existing user's notes need no
   * migration and a note never has to pick one. */
  sectionId?: string;
  /** Images attached to this note's description. Absent means none, which is what
   * every note written before this existed has — so there is no migration to get
   * wrong, and such a note still serialises byte-identically. */
  images?: NotepadImage[];
}

/** One image attached to a note. `ext` comes from the accepted mime type, never
 * from the source filename: a file called `shot.png` that is really a PDF must not
 * end up stored under `.png`, where the webview would ask for an image the editor
 * cannot decode. `name` is the user's own filename, kept for display and for
 * naming the copy that reaches the agent.
 *
 * The bytes live at `<globalStorageUri>/notepad-images/<id>.<ext>` and nothing
 * about them is in globalState, which is serialised into the webview on every
 * poll, rides Settings Sync, and has no eviction. */
export interface NotepadImage {
  id: string;
  ext: string;
  name: string;
}

/** An image the webview holds but the host has not written yet. The add form has
 * no note id to attach to, so its pending bytes ride along with `notepad:add`
 * rather than giving the host a draft store — a second lifetime to reason about,
 * and one that would leak bytes for every note the user starts and abandons. */
export interface PendingImage {
  dataBase64: string;
  mime: string;
  name: string;
}

/** A user-defined group notes can be filed into. Display order is creation
 * order (the array order in storage) — sections are not independently
 * drag-reorderable, only the notes inside (and across) them are. */
export interface NotepadSection {
  id: string;
  name: string;
  createdAt: number; // epoch ms
}

/** What crosses the wire for one section: the stored record plus whether it's
 * collapsed. Collapse state persists (see `agentFlow.notepadCollapsed`) but is
 * never part of the stored section record itself, the same split `runStatus`
 * has on `NotepadItemView` below. */
export type NotepadSectionView = NotepadSection & { collapsed: boolean };

/** A note's most recent run, as far as the two cheap signals can tell:
 * "running" — a Claude Code session is open in one of its repos right now;
 * "stale" — launched, but nothing attached to it at the moment;
 * "finished" — the Deck's retire sweep stamped it landed.
 * Absent entirely when there is no run record to speak for (never launched, or
 * the Deck already retired it — guessing which would be dishonest). */
export type NotepadRunStatus = "running" | "stale" | "finished";

/** What crosses the wire: the stored note plus its derived status. The status is
 * computed host-side per post and never persisted — the webview cannot read the
 * runs store itself (it must not import a module that touches `fs`). */
export type NotepadItemView = NotepadItem & {
  runStatus?: NotepadRunStatus;
  /** Webview-safe URIs for `images`, positionally parallel to it. Derived per post
   * from `asWebviewUri` and never persisted, for the same reason `runStatus` is:
   * the webview has no `vscode.Uri` and must not import a module that touches
   * `fs`. Omitted entirely when the note has no images. */
  imageUris?: string[];
};

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
  // The Notepad tab (same webview as the task pool, second view)
  /** `images` is absent unless the add form actually holds pending attachments, so
   * a plain note's message is byte-identical to what it was before images existed. */
  | { type: "notepad:add"; title: string; body: string; images?: PendingImage[] }
  | { type: "notepad:update"; id: string; title: string; body: string }
  /** Paste or file-drop onto a saved note. Base64 because postMessage is a JSON
   * channel — one message per attachment, never something the poll repeats. */
  | { type: "notepad:addImage"; id: string; dataBase64: string; mime: string; name: string }
  /** The Attach button. The host runs the picker and reads the bytes itself, so
   * nothing is encoded across the wire on this path. */
  | { type: "notepad:pickImage"; id: string }
  | { type: "notepad:removeImage"; id: string; imageId: string }
  /** A thumbnail click. Carries the note id too, so the host can look the record up
   * and learn the extension — the webview only ever holds the derived URI. */
  | { type: "notepad:openImage"; id: string; imageId: string }
  | { type: "notepad:toggleDone"; id: string }
  | { type: "notepad:delete"; id: string }
  | { type: "notepad:clearCompleted" }
  | { type: "notepad:run"; id: string }
  /** The ids of the notes VISIBLE in the panel, in the order the drop produced.
   * Hidden notes are not named and keep their absolute slots (see applyReorder). */
  | { type: "notepad:reorder"; order: string[] }
  | { type: "notepad:resetOrder" }
  | { type: "notepad:addSection"; name: string }
  | { type: "notepad:renameSection"; id: string; name: string }
  | { type: "notepad:deleteSection"; id: string }
  | { type: "notepad:toggleSectionCollapsed"; id: string }
  /** File a note under a section, or drop it back to ungrouped when `sectionId`
   * is undefined. Fired by both the cross-section drag-drop and the edit form's
   * section picker. */
  | { type: "notepad:setSection"; id: string; sectionId?: string }
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
  /** The webview's own lens-usage signal — a search-box edit or a repo-lens
   * pick, debounced 500ms per lens kind (one timer for "search", one for
   * "repo") so a run of keystrokes or toggles reports once. The host validates
   * the enum and drops an unrecognised value silently. */
  | { type: "tasks:lensUsed"; lens: "repo" | "search" }
  // The Deck (separate webview panel)
  | { type: "deck:ready" }
  | { type: "deck:refresh" }
  | { type: "deck:setGrouping"; grouping: "agents" | "workspaces" }
  | { type: "deck:clearStale" }
  | { type: "deck:switchAccount" }
  | { type: "deck:inspect"; key: string; action: "open" | "diff"; repo?: string }
  | { type: "deck:forget"; key: string }
  | { type: "deck:track"; key: string }
  | { type: "deck:addressPr"; key: string }
  // Sent by each per-failure row button (Task 7). `reason` and `detail` let the
  // host build a prompt about the specific thing wrong rather than a generic
  // review pass. Handled alongside `deck:addressPr` in Task 8's dispatch.
  | { type: "deck:seedPrWork"; key: string; reason: PrWorkReason; detail?: string }
  /** Read one run's token usage now. Sent when its detail drawer opens, which is
   * the only thing that displays a per-run figure — so with the header total off
   * (the default) a session that never opens a drawer parses no transcripts at
   * all. The host answers with `deck:usage`. */
  | { type: "deck:usageFor"; key: string }
  | { type: "deck:setReviewSort"; sort: ReviewSort }
  | { type: "deck:reviewExpand"; id: string }
  | { type: "deck:reviewLaunch"; id: string }
  /** Several rows at once. One agent per PR, one mode and one destination asked for
   *  the whole batch — see `launchReviewBatch`. Never a batch *submit*: a single click
   *  that posts four reviews to the forge is the one thing this must not become. */
  | { type: "deck:reviewBatch"; ids: string[] }
  | { type: "deck:reviewLoadDraft"; id: string }
  | { type: "deck:reviewSubmit"; id: string; verb: ReviewVerb; body: string; fromDraft: boolean }
  /** Merge the one PR this card can merge. `repo` and `number` are what the
   * webview believed; the host re-derives them from its own PR store and refuses
   * if they disagree — the webview is a renderer, never the authority for a
   * write. */
  | { type: "deck:mergePr"; key: string; repo: string; number: number }
  // ── Orchestrator flows ──────────────────────────────────────────────
  // `flow:save` carries the WHOLE flow rather than a patch: a graph is small
  // and the drawer is its only editor. The host still merges its own three
  // per-edge fields (firedAt/firedNote/error) back in on receipt — see
  // DeckPanel's flow:save handler — because the drawer's copy can predate a
  // stamp the host wrote during a poll.
  | { type: "flow:create" }
  | { type: "flow:rename"; id: string; name: string }
  | { type: "flow:save"; flow: Flow }
  // The missing ticket picker (Task 4b): the webview cannot build a `planned`
  // node itself — it has no task connector — so this only names WHICH flow to
  // append one to. The host resolves ticket, repos, prompt mode and
  // destination through a sequence of native QuickPicks (fully keyboard-
  // operable for free) and writes the whole node in one go; see deckView.ts's
  // `addPlanned`. Never carries a partial node across the wire — `flow:save`
  // already owns "write a whole flow", and a half-built node would be a
  // second source of truth for the same graph.
  | { type: "flow:addPlanned"; id: string }
  | { type: "flow:delete"; id: string }
  // Arm/disarm a flow (Task 5). Arming warns and names any rule that can never
  // fire with a data source switched off, rather than refusing to arm.
  // Disarming also drops any resume gate the flow is holding.
  | { type: "flow:arm"; id: string; armed: boolean }
  // Clears one edge's latch (firedAt/firedNote/error) so it can fire again.
  | { type: "flow:resetEdge"; id: string; edgeId: string }
  // The resume gate (Task 4): approving clears the gate so the next pass fires
  // normally; disarming turns the flow off instead. Neither message performs
  // anything itself — see DeckPanel.advanceArmedFlows.
  | { type: "flow:resumeApprove"; id: string }
  | { type: "flow:resumeDisarm"; id: string }
  // Keep a free-text command: append it to `agentFlow.commands` under a name, so
  // the next node can pick it from the list instead of retyping it. Carries no
  // flow id and touches no flow — the webview cannot write settings (no fs), and
  // this is the one thing in the drawer whose subject is the SETTING rather than
  // the graph. The host slugs the id, refuses a command it already holds, and
  // writes to the scope that already carries the setting; see deckView.ts's
  // `saveCommand`. The node itself is deliberately left as free text — see that
  // method's own comment.
  | { type: "flow:saveCommand"; run: string; label: string }
  // The dry run happened. Posted once per invocation of the drawer's "What would
  // fire?" toggle, and the ONLY thing the host ever learns about a dry run: the
  // verdicts themselves stay in the webview, which computes them itself and acts
  // on nothing. Counts only — no flow id, no edge ids, no rule text — and the
  // host still validates all three as finite, non-negative numbers before they
  // reach an event, because a webview payload is untrusted whatever this type says.
  | { type: "flow:dryRun"; edges: number; fired: number; blocked: number }
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
      /** The seeded agent's user-facing name — "Claude Code" or "Copilot" — so no
       * tooltip in the webview has to hardcode which agent is configured. Optional
       * so a handcrafted `state` message (tests, older hosts) need not carry it;
       * the webview falls back to its own default when absent. */
      agentLabel?: string;
      /** Which optional affordances to render. Flat booleans: the capability
       * objects on TaskProvider cannot be structured-cloned. */
      caps: SerializedCaps }
  /** Capabilities that changed after `state` was posted, because the source had to ask
   * its server what it can do (`TaskProvider.refreshCaps`) — the Jira connector reads
   * the project's boards and drops the sprint-shaped lenses when there is no Scrum
   * board. Its own message rather than a second `state` post for one reason: `state`
   * also carries `me`, and the caps refresh resolves on a different beat from the
   * identity lookup, so re-posting `state` from here would clobber a display name that
   * had already arrived with `null`. The webview folds this into the same caps state
   * `state` set, so arriving or not arriving are both valid histories. */
  | { type: "caps"; caps: SerializedCaps }
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
  // Every note, with each one's derived run status. Posted on `ready`, after every
  // mutation, and on a poll tick so a badge cannot go stale while the panel sits
  // open. The whole array every time: it is a handful of small records, and a
  // diff protocol would buy nothing but a chance to desynchronise.
  /** `ordered` is true when a manual order exists — the webview shows its
   * "Reset order" control only then, and cannot read the order key itself. */
  | { type: "notepad:notes"; notes: NotepadItemView[]; ordered: boolean; sections: NotepadSectionView[] }
  // The Deck
  /** The lens, seeded once on ready and re-sent only if the setting changes under
   * the panel. Deliberately not a field on deck:runs: that message costs a full
   * board rebuild, so one already in flight when the user flips the lens lands
   * carrying a pre-click value and visibly reverts the control. */
  | { type: "deck:grouping"; grouping: "agents" | "workspaces" }
  /** One run's token usage, answering a `deck:usageFor`. Its own message rather
   * than a field on `deck:runs`: the drawer asks for exactly one run and
   * `deck:runs` costs a full board rebuild, so riding it would make opening a
   * drawer re-render the board. `usage` is null when nothing was readable. */
  | { type: "deck:usage"; key: string; usage: UsageTotals | null }
  | { type: "deck:runs"; runs: RunStatus[]; ghNote: string | null; prReviewStatus: string;
      /** Whether the header's token total is switched on. Rides deck:runs rather
       * than being read once at mount: it is a plain boolean setting a user can
       * flip mid-session, and the board re-posts often enough that this is the
       * whole of keeping it live — the same reasoning as `prReviewStatus`. */
      showTokenTotal: boolean;
      /** `agentFlow.mergeWrites` — the card's Merge row renders only when true.
       * Optional, and read as `?? false` in the webview: an in-flight message
       * posted before this build's host reloads carries no such field, and the
       * safe reading of "I do not know" for a write path is off. Same reasoning
       * as `agentLabel`'s own runtime fallback. Optional also keeps every
       * existing `deck:runs` fixture compiling untouched. */
      mergeWrites?: boolean;
      // How many runs would retire right now if both retirement windows were
      // ignored. Drives the Clear stale button, which is hidden at zero.
      staleCount: number;
      /** The task source's user-facing name — every "Jira"-shaped string on the
       * board reads this rather than hardcoding a tracker. Same field, same intent
       * as `state`'s `sourceLabel` above; the Deck is a separate panel with its
       * own outbound message, so it carries its own copy. */
      sourceLabel: string;
      /** The configured tool's user-facing name — "Claude Code", "Cursor",
       * "Copilot" — so no Deck string has to hardcode which tool is driving.
       * Same field, same intent as `sourceLabel` above: the Deck is a separate
       * panel with its own outbound message, so it carries its own copy. */
      agentLabel: string;
      /** Which account the forge's CLI is reading as, when that is worth saying.
       *
       * OPTIONAL, and it must stay optional. `test/webview/DeckApp.test.tsx`'s
       * `runsMsg` helper builds this message as an object literal typed
       * `Extract<OutboundMessage, { type: "deck:runs" }>`; a required member stops
       * it compiling, and editing an existing test to go green is the signal to
       * stop. It is also what `agentLabel` already does, so that a message posted
       * before the host reloads carries no such field. */
      ghAccount?: AccountSlot | null }
  | { type: "deck:loading"; loading: boolean }
  | {
      type: "deck:reviews";
      requests: ReviewRequest[];
      issueCount: number;
      sort: ReviewSort;
      stale: boolean; // the last fetch failed; these are the previous results
      reviewWrites: boolean; // agentFlow.reviewWrites — the strip's box and verbs render only when true
      // false when the strip has been switched off (reviewRequests, PR facts, or
      // gh going unusable) — distinct from a genuine empty queue, so a future
      // reader can tell "no rows because it's off" from "no rows because the
      // queue is empty." Paired with an emptied requests array, which is what
      // actually clears any rows the strip was rendering rather than leaving them
      // frozen (and their write buttons clickable) with nothing ever told to stop.
      // The webview itself doesn't read this field — DeckApp's handler destructures
      // every other property off this message but not `enabled` — because an empty
      // `requests` array already renders as nothing. It stays on the wire and in the
      // type because host-side tests assert it to pin down *why* the strip is empty.
      enabled: boolean;
      // The strip is on and a first search is still in flight, with nothing cached
      // to render in the meantime. Distinct from `enabled: true` with an empty
      // `requests` — that is a genuinely empty queue, and says so. Only ever true
      // on a cold start: a machine with a cache on disk posts that instead, from
      // `deck:ready`, before the board build has even begun.
      loading: boolean;
      // agentFlow.reviewRequestsAlwaysVisible: keep the strip's header on an
      // empty, resolved queue instead of the strip leaving the board. Posted as
      // false whenever `enabled` is false — an "always visible" strip that has
      // been switched off must still disappear, or the off switch stops meaning
      // off. Optional so a webview served by an older host reads it as absent
      // (hidden-when-empty, the released behavior) rather than crashing.
      alwaysVisible?: boolean;
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
  /** The explicit outcome of one deck:mergePr, posted at every exit that reached
   * the confirmation. A duplicate message rejected by the in-flight guard
   * deliberately gets NO outcome: the real call owns it.
   *
   * The webview releases the row's disable on "failed" and "cancelled" only. On
   * "ok" the PR is merged but the board's own facts still say OPEN for up to a
   * poll window, so the row keeps its disabled button until the refreshed facts
   * retire it from the card — see the handler in DeckApp.tsx for why a symmetric
   * release put a live Merge button on an already-merged PR. */
  | { type: "deck:mergeDone"; key: string; repo: string; number: number; outcome: "ok" | "failed" | "cancelled" }
  // `enabled: false` still posts, with an empty list: the webview must be able
  // to tell "the setting is off" from "not loaded yet", and silence cannot.
  // `pendingResume` is the resume gate's own report — flows with rules already
  // met on the panel's first evaluation, held for approval rather than fired.
  // `promptModes` is the six configured prompt modes, narrowed to what the
  // inspector's USING selector needs — sent unconditionally, even with the
  // setting off, since it is configuration rather than flow data.
  // `commands` is `agentFlow.commands` verbatim, and rides along for the same
  // reason: the drawer builds a command node by naming one of these, and the
  // webview has no fs access to read the setting itself. NOT narrowed the way
  // `promptModes` is — a prompt's template is long and the inspector never
  // shows it, whereas a command's `run` is short and IS what the rule executes,
  // so a future "what would run" line has it without a second round trip.
  // `branchCi` is the branch-CI verdict map this panel has fetched, keyed
  // `repo#branch` by `branchCiKey` — the SAME map `evaluateFlow` is handed, so
  // the drawer's "what is this rule waiting on" line and the engine's own
  // answer cannot disagree. It rides `deck:flows` rather than `deck:runs`
  // because it is flow data (its keys come from the rules themselves) and
  // because `postFlows` runs AFTER the pass that reads the verdicts, whereas
  // the `deck:runs` post happens before it.
  | {
      type: "deck:flows"; flows: Flow[]; enabled: boolean; pendingResume: PendingResume[];
      promptModes: FlowPromptMode[]; commands: FlowCommand[];
      branchCi: Record<string, BranchCiStatus>;
    }
  // The Marketplace
  | { type: "mkt:assets"; view: ClaudeAssetsView }
  | { type: "mkt:loading"; loading: boolean }
  // Contents of one previewed file. Never part of the scan payload: 350-odd
  // markdown bodies would bloat every rescan, and the panel rescans on refocus.
  | { type: "mkt:file"; file: string; text: string; truncated: boolean };
