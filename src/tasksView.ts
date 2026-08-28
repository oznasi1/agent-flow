import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { getConfig, providerLabel, resolvedProvider, AgentFlowConfig, AgentProvider, ExploreAction } from "./config";
import {
  isTaskNetworkError,
  serializeCaps,
  TaskApiError,
  TaskAuthError,
  TaskWriteError,
  type FieldPrompt,
  type TaskConnector,
  type TaskDetail,
  type TaskProvider,
} from "./tasks/provider";
// A pure function over the seam's own prompt vocabulary (`FieldPrompt`), which is
// why it lives beside the seam and not under any one source's directory — this
// file reaches into no connector.
import { validateFieldInput } from "./tasks/fields";
import { effectiveFilter } from "./webview/helpers";
import { discoverRepos } from "./engine/repos";
import { confirmedServices, inferServices } from "./engine/infer";
import { mapRepoComponents, resolveComponent } from "./engine/components";
import { applyExploreVars, injectSlackDm, prReviewTemplate } from "./engine/prompt";
import { openWorkspace, writeBriefInto, listWorkspaceFiles, workspaceFolderPaths, planWorkspaceMerge, attachmentFileName, attachmentRelPath, BRIEF_DIR, type MergeCandidate } from "./engine/workspace";
import { briefMarkdown } from "./engine/brief";
import { readLiveWindows, windowIdentity, defaultWindowsDir, currentWindow, PresenceRecord, type CurrentWindow } from "./engine/presence";
// The destination question, lifted so **Review with agent** on the Deck asks it in
// exactly the same words (src/engine/openTarget.ts). The private methods below are now
// thin adapters over it: they bind the settings, the copy, and the `vscode` pickers.
import { chooseOpenTarget, targetToOpenArgs, type OpenArgs, type OpenTarget } from "./engine/openTarget";
import { liveWindowsElsewhere, openTargetDeps } from "./openTargetHost";
import { readRuns, defaultRunsDir, describeActiveTasks } from "./engine/runs";
import { defaultSessionsDir, groupByPlace, readOpenSessions } from "./engine/sessions";
import { branchName, createWorktrees, ensureBranch, folderName, repoRootOfWorktree, serviceFolderName } from "./engine/worktree";
// `currentBranch`, not `gitState`: the only thing asked here is which branch a worktree
// is on, and that is one `rev-parse` rather than the four subprocesses gitState spends
// on dirtiness, ahead-count and a numstat diff nobody reads. A fan-out of 20 children
// across 3 repos would otherwise pay 240 git spawns for 60 answers. Same observation
// `engine/workspace.ts` makes for `repos[].branch`, at the price of the question.
import { currentBranch } from "./engine/git";
import { buildTree, type TreeLeaf, type TreeResult } from "./engine/taskTree";
import { openSharedWorkspace, type BatchTask } from "./engine/batchWorkspace";
import { providerPin, resolveBatchProvider } from "./agentPick";
import { sortBySavedOrder, applyReorder, pruneOrder } from "./engine/order";
import { newNote, newSection, noteStatus, sanitizeNotes, sanitizeSections } from "./notepad";
import { IMAGE_DIR, deleteImages, imageFileName, imagePath, saveImage, sweepOrphans } from "./notepadImages";
import {
  Filter,
  InboundMessage,
  NotepadImage,
  NotepadItem,
  NotepadItemView,
  NotepadSection,
  PendingImage,
  Task,
  OutboundMessage,
  PromptMode,
  Run,
  ServiceRef,
  Size,
  WorkspaceMode,
} from "./types";
import { track, trackError, startFlow, fingerprint, Flow } from "./telemetry/telemetry";
import { toPromptModeProp, classifyFailure, DestinationProp, FailureClass, Op, PromptModeProp, RepoSource, TakeSource } from "./telemetry/events";

const SPRINT_ORDER_KEY = "agentFlow.sprintOrder";
// globalState, not workspaceState: a notepad belongs to the user, not to whichever
// repo happens to be open. Same storage the install-reported flag uses.
const NOTEPAD_KEY = "agentFlow.notepad";
// The manual note order: ids, most important first. globalState, like the notes
// themselves — an order over the user's own notepad is not a workspace's business.
// Empty (the default) means "no manual order", which is what every install starts
// with and what makes this feature inert until the first drag.
const NOTEPAD_ORDER_KEY = "agentFlow.notepadOrder";
// User-defined groups notes can be filed under. Sections are opt-in — this list
// starts empty on every install, same as notepadOrder starting empty.
const NOTEPAD_SECTIONS_KEY = "agentFlow.notepadSections";
// Which section ids are collapsed right now. globalState, so a collapsed
// section stays collapsed across a reload rather than resetting to expanded.
const NOTEPAD_COLLAPSED_KEY = "agentFlow.notepadCollapsed";

// The inverse of the image store's own mime map, for the one attach path that
// starts from a file path instead of a clipboard item. Kept here rather than
// exported from the store so the store's whitelist stays the single gate — this
// only PROPOSES a mime, which saveImage is still free to refuse.
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** A note with no images left keeps NO `images` key, so it serialises exactly like
 * a note that never had one — the shape every pre-existing install stores. */
function stripImages(note: NotepadItem): NotepadItem {
  const { images: _images, ...rest } = note;
  return rest;
}

/** Said in two places — the pre-flight refusal at the top of every launch, and the
 * `resolveRemoteControl` backstop behind it. One constant so the two can never drift. */
const RC_NEEDS_CLAUDE =
  "Remote Control needs Claude Code. Set agentFlow.agentProvider to claude-code, or turn agentFlow.remoteControl off.";

/** Shared by `explore()` and `runNotepadItem` for turning free text into a run
 * key fragment: lowercase, dashes for anything non-alphanumeric, capped at 40
 * chars so a long topic or title can't produce an unbounded filename. */
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

/** Which engine operation a webview message represents, for operation_failed.
 * Messages absent from this map report as "jira_fetch" only if they read the task
 * source; anything genuinely unclassifiable is left out and reports nothing.
 *
 * The `jira_*` values are TRANSMITTED analytics strings, frozen by
 * test/unit/compat.test.ts — the code around them is source-agnostic now, the wire
 * values are not. Renaming one breaks a live series. */
const MESSAGE_OPS: Partial<Record<InboundMessage["type"], Op>> = {
  ready: "jira_fetch",
  retry: "jira_fetch",
  fetch: "jira_fetch",
  detail: "jira_fetch",
  take: "workspace_write",
  takeBatch: "workspace_write",
  addressPr: "pr_lookup",
  changeStatus: "jira_write",
  addToMySprint: "jira_write",
  removeFromSprint: "jira_write",
  setComponent: "jira_write",
  explore: "workspace_write",
  "notepad:run": "workspace_write",
  runDoctor: "jira_fetch",
};

/** Message types whose task-source interaction is itself a write — the rest that
 * read the source at all (including `take`/`takeBatch`/`addressPr`, whose primary
 * MESSAGE_OPS entry is a non-source op) are reads. Used only by resolveOp() below. */
const SOURCE_WRITE_MESSAGES: ReadonlySet<InboundMessage["type"]> = new Set([
  "changeStatus",
  "addToMySprint",
  "removeFromSprint",
  "setComponent",
]);

/** MESSAGE_OPS attributes a failure to a message's own primary purpose — `take` is
 * "workspace_write" because opening/seeding a workspace is what it mostly does.
 * But `take`, `takeBatch`, and `addressPr` all read a ticket via resolveKickoff()
 * before ever touching a workspace, and that task-source read has no try/catch of
 * its own — it is the single most failure-prone step in the flow, and MESSAGE_OPS
 * alone would mislabel its failure a workspace_write / pr_lookup. When the
 * thrown error is identifiably from the task source — TaskAuthError, TaskApiError,
 * or a network-level failure inside the connector's transport (unreachable host,
 * DNS, timeout; see isTaskNetworkError, src/tasks/provider.ts) — that origin is
 * trusted over the message-type default: jira_write for the message types whose own
 * source interaction is a write, jira_fetch for everything else that reads it at all.
 * The network-level case matters most in practice: an unreachable source (VPN off,
 * bad site URL, firewall) is the single most common real-world failure this
 * extension sees, and it is exactly what Doctor exists to diagnose — misattributing
 * it to workspace_write/pr_lookup would send debugging effort at the wrong
 * subsystem for the failure that happens most. A message absent from MESSAGE_OPS
 * (e.g. openExternal, reorder) still reports nothing regardless of the error's
 * origin — this override only ever narrows an op that MESSAGE_OPS already
 * assigned, never invents one for a message MESSAGE_OPS left out. Stateless by
 * design: a pure function of the one error and message already in hand, not a
 * mutable "current op" field, which would be wrong the moment two messages are
 * in flight concurrently. */
function resolveOp(m: InboundMessage, e: unknown): Op | undefined {
  const messageOp = MESSAGE_OPS[m.type];
  if (!messageOp) return undefined;
  if (e instanceof TaskAuthError || e instanceof TaskApiError || isTaskNetworkError(e)) {
    return SOURCE_WRITE_MESSAGES.has(m.type) ? "jira_write" : "jira_fetch";
  }
  return messageOp;
}

/** Whether retrying the same operation, with nothing else changed, could plausibly
 * succeed. Derived from `failure_class` — not a bespoke `instanceof` check — so it
 * can never contradict the failure_class already on the same event. Auth needs
 * re-authentication first; not_found and permission point at a state retrying
 * alone won't change; parse means the response shape itself was unexpected, and
 * retrying the identical request reproduces it deterministically. Network blips,
 * timeouts, conflicts, and anything unclassified are presumed transient. */
function isRetryable(failureClass: FailureClass): boolean {
  return failureClass !== "auth" && failureClass !== "not_found" && failureClass !== "permission" && failureClass !== "parse";
}

/** Delay between opening successive batch windows — reduces focus-stealing and
 *  `open -a` thrash when several windows launch back-to-back. */
const BATCH_STAGGER_MS = 250;
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class TasksViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "agentFlow.tasks";
  private view?: vscode.WebviewView;
  private lastFilter: Filter = "unassigned";
  /** The last attention count, held so a tick that fires before VS Code has
   * resolved this view is not simply lost — see `setAttention`. */
  private attention = 0;
  /** Task keys with a Take currently running. A double-click on a card's Take (or a
   * card Take racing the palette command) fired two whole takes for one ticket —
   * two windows, two worktrees — whenever the settings needed no QuickPick to slow
   * the second one down. Checked and set synchronously at the top of `takeTask`,
   * before its first await, so the duplicate can never slip in between. */
  private readonly takesInFlight = new Set<string>();
  /** Monotonic id of the latest-started `fetch`. Only the fetch holding the
   * current value may post its list, prune the saved order, set `lastFilter`,
   * or clear the loading bar — a slower, older fetch resolving after a newer one
   * would otherwise render a stale lens the reorder guard then contradicts. */
  private fetchSeq = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connector: TaskConnector,
    private readonly log: (m: string) => void = () => {},
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      // globalStorage as well as the bundle: the notepad's attached images live
      // there, and without this root every thumbnail resolves to nothing. The CSP
      // itself needs no change — `img-src` already allows `webview.cspSource`.
      localResourceRoots: [this.context.extensionUri, this.context.globalStorageUri],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: InboundMessage) => this.onMessage(m));
    // VS Code disposes a WebviewView when the sidebar is hidden, and writing
    // `.badge` on a disposed view throws. The attention pass swallows that throw
    // (best-effort by design), so the badge would silently stop updating for the
    // rest of the window's life — until the view happened to resolve again. The
    // count itself survives in `this.attention`, so a later resolve replays it.
    // Guarded on identity: a dispose arriving after a NEWER view resolved must
    // not clear the live one.
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
    this.applyAttention();
  }

  private post(msg: OutboundMessage): void {
    this.view?.webview.postMessage(msg);
  }

  /**
   * Badge the view with how many sessions are waiting on you. Driven by the
   * attention job in extension.ts, which outlives the Deck panel — the whole
   * point of the badge is that it is there when the Deck is not.
   *
   * `undefined` rather than `{ value: 0 }` for an empty count: VS Code renders a
   * zero badge, and "0" on the activity bar reads as a broken feature.
   *
   * The value is held in a field as well as applied, because VS Code resolves a
   * webview view lazily — a window whose sidebar has not been opened has no
   * `this.view` to badge, and the first ticks of every window land there.
   * `resolveWebviewView` replays it. A sidebar never opened at all in a window
   * still gets no badge; that is a VS Code constraint, not something to work
   * around here.
   *
   * "sessions", not "agents": a session is one run of a coding tool, which is
   * what this counts. test/unit/vocabulary.test.ts enforces the distinction.
   */
  public setAttention(keys: readonly string[]): void {
    this.attention = keys.length;
    this.applyAttention();
  }

  private applyAttention(): void {
    if (!this.view) return;
    const n = this.attention;
    this.view.badge =
      n === 0
        ? undefined
        : { value: n, tooltip: `${n} session${n === 1 ? " is" : "s are"} waiting on you — open the Deck` };
  }

  /** Post the panel's `state`, folding in the config-derived fields the webview needs
   * (the source's scope name, and the PR-review status string that gates the
   * "Address PR" action) plus what the source can and cannot do — `sourceLabel` so
   * no string in the webview has to name a tracker, and the serialized capabilities
   * so it renders only affordances this source can honour. */
  private postState(authed: boolean, configured: boolean, me: string | null): void {
    const cfg = getConfig();
    const info = this.connector.info();
    // VS Code renders the view's own title bar directly above the webview, so the
    // panel's identity belongs there rather than repeated in the first row of our
    // content. Set here, not in resolveWebviewView: postState is the one path that
    // re-runs on every auth, config and refresh change, so the bar cannot go stale.
    // The fallback matters — an unconfigured first run has no project key, and a
    // blank bar holding nothing but three action icons reads as a broken render.
    if (this.view) {
      this.view.title = info.scopeValue || "Tasks";
      this.view.description = me ?? undefined;
    }
    this.post({ type: "state", authed, configured, project: info.scopeValue, me,
      prReviewStatus: cfg.prReviewStatus, filters: cfg.filters,
      sourceLabel: info.label, agentLabel: providerLabel(resolvedProvider(cfg.agentProvider)), caps: serializeCaps(this.provider().caps),
      liveCount: cfg.trackOpenWindows ? this.liveWindows().length : undefined });
  }

  private toast(
    level: "success" | "error" | "info",
    message: string,
    action?: { label: string; url: string },
  ): void {
    this.post({ type: "toast", level, message, ...(action ? { action } : {}) });
  }

  /** Built from current settings, per operation — exactly as `client()` did, and for
   * the same reason: a settings edit must take effect without a window reload.
   *
   * Call it ONCE per operation and pass the result around. A provider may hold
   * per-operation state — JiraProvider remembers the field prompts it issued so it
   * can map the answers back — and a second instance would not have it. */
  private provider(): TaskProvider {
    return this.connector.provider();
  }

  /** The sprint operations, or null with the user told why. A source without sprints
   * should never have surfaced the affordance — the webview hides it on
   * `caps.sprints` — so this is the backstop for a stale webview or a command
   * invoked from the palette. Reporting beats throwing: the list on screen is still
   * valid, and an unsupported action is not a failure to diagnose. */
  private sprints(provider: TaskProvider): NonNullable<TaskProvider["caps"]["sprints"]> | null {
    const ops = provider.caps.sprints;
    if (!ops) {
      this.toast("error", `${this.connector.info().label} doesn't have sprints.`);
      return null;
    }
    return ops;
  }

  /** Stamp the provenance label, when the source has labels at all and the user
   * wants it. A source without them is a silent no-op, never an error: the write
   * that mattered already succeeded, and failing the whole operation over
   * unavailable provenance stamping would be the wrong trade.
   *
   * Takes the caller's provider rather than building its own, for the reason
   * `provider()` gives: one provider per operation, so a stamp can never be issued
   * by an instance that knows nothing about the write it is stamping. */
  private async stampProvenance(provider: TaskProvider, key: string): Promise<void> {
    const cfg = getConfig();
    const labels = provider.caps.labels;
    if (!cfg.stampLabelOnWrite || !labels) return;
    try {
      await labels.add(key, cfg.provenanceLabel);
    } catch (e) {
      this.log(`label stamp failed for ${key}: ${e}`);
    }
  }

  private savedOrder(): string[] {
    return this.context.workspaceState.get<string[]>(SPRINT_ORDER_KEY, []);
  }

  private async saveOrder(order: string[]): Promise<void> {
    await this.context.workspaceState.update(SPRINT_ORDER_KEY, order);
  }

  private notes(): NotepadItem[] {
    return sanitizeNotes(this.context.globalState.get<unknown>(NOTEPAD_KEY, []));
  }

  private async saveNotes(notes: NotepadItem[]): Promise<void> {
    await this.context.globalState.update(NOTEPAD_KEY, notes);
    this.postNotepad();
  }

  /** Absolute path of the notepad's image store. One place computes it so the
   * attach paths, the sweep, and the run handoff cannot drift onto different
   * directories — a drift the sweep would then read as "every file is an orphan". */
  private imageDir(): string {
    return path.join(this.context.globalStorageUri.fsPath, IMAGE_DIR);
  }

  private noteOrder(): string[] {
    return this.context.globalState.get<string[]>(NOTEPAD_ORDER_KEY, []);
  }

  private async saveNoteOrder(order: string[]): Promise<void> {
    await this.context.globalState.update(NOTEPAD_ORDER_KEY, order);
  }

  private sections(): NotepadSection[] {
    return sanitizeSections(this.context.globalState.get<unknown>(NOTEPAD_SECTIONS_KEY, []));
  }

  private async saveSections(sections: NotepadSection[]): Promise<void> {
    await this.context.globalState.update(NOTEPAD_SECTIONS_KEY, sections);
    this.postNotepad();
  }

  private collapsedSectionIds(): string[] {
    return this.context.globalState.get<string[]>(NOTEPAD_COLLAPSED_KEY, []);
  }

  private async saveCollapsedSectionIds(ids: string[]): Promise<void> {
    await this.context.globalState.update(NOTEPAD_COLLAPSED_KEY, ids);
    this.postNotepad();
  }

  /** Notes in display order: the manual order first where one exists, then
   * anything unranked newest-first — which is exactly the whole list when no
   * manual order exists, i.e. what the panel showed before this feature. */
  private orderedNotes(): NotepadItem[] {
    const newestFirst = [...this.notes()].sort((a, b) => b.createdAt - a.createdAt);
    return sortBySavedOrder(newestFirst, this.noteOrder(), (n) => n.id);
  }

  /** Forget ids that are no longer notes. Called on every path that removes one,
   * so the order cannot grow unbounded behind the panel. */
  private async pruneNoteOrder(remaining: NotepadItem[]): Promise<void> {
    const saved = this.noteOrder();
    if (saved.length === 0) return;
    const next = pruneOrder(saved, remaining.map((n) => n.id));
    if (next.length !== saved.length) await this.saveNoteOrder(next);
  }

  /** Post every note with its derived run status. Public because the poll tick in
   * extension.ts drives it too — a badge must not sit stale while the panel is open. */
  public postNotepad(): void {
    const notes = this.orderedNotes();
    // Skip both directory reads entirely when nothing has ever been launched:
    // the common case is a notepad of plain items with no runs behind them.
    const anyRun = notes.some((n) => n.lastRunKey);
    const runs = anyRun ? readRuns(defaultRunsDir()) : [];
    const livePlaces = anyRun
      ? new Set(groupByPlace(readOpenSessions(defaultSessionsDir())).keys())
      : new Set<string>();
    const webview = this.view?.webview;
    const view: NotepadItemView[] = notes.map((n) => {
      const runStatus = noteStatus(n, runs, livePlaces);
      const base: NotepadItemView = runStatus ? { ...n, runStatus } : { ...n };
      const images = n.images ?? [];
      // One entry per STORED image, positionally parallel to `images`: a file that
      // vanished under us renders as a broken thumbnail rather than shifting every
      // later index onto the wrong record. Pruning records is the activate-time
      // sweep's job, never the poll's — a poll that raced a half-written state file
      // would drop images a note still points at. Without a webview there is
      // nothing to convert against, and the post is a no-op in that state anyway.
      if (images.length === 0 || !webview) return base;
      return {
        ...base,
        imageUris: images.map((img) =>
          webview
            .asWebviewUri(vscode.Uri.joinPath(this.context.globalStorageUri, IMAGE_DIR, imageFileName(img)))
            .toString(),
        ),
      };
    });
    const collapsed = new Set(this.collapsedSectionIds());
    const sections = this.sections().map((s) => ({ ...s, collapsed: collapsed.has(s.id) }));
    this.post({ type: "notepad:notes", notes: view, ordered: this.noteOrder().length > 0, sections });
  }

  private async addNote(title: string, body: string, pending?: PendingImage[]): Promise<void> {
    // A note with neither a title nor a body is nothing at all — silently ignored
    // rather than toasted: the webview already disables the button, so reaching
    // here means a stale view, not a user who needs telling. A note carrying only
    // an image IS something, though: the screenshot is the content.
    if (!title.trim() && !body.trim() && !(pending && pending.length > 0)) return;
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    // Written before the note, so the single saveNotes below (which posts) already
    // carries them — the add form's thumbnails must not blink out and back in.
    const images: NotepadImage[] = [];
    for (const p of pending ?? []) {
      const imageId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const saved = saveImage(this.imageDir(), Buffer.from(p.dataBase64, "base64"), p.mime, p.name, imageId);
      if (saved.ok) images.push(saved.image);
      else this.toast("error", saved.reason);
    }
    // Rank it first, so a manual order does not bury the note just written. Write
    // the order before the notes: saveNotes posts, and the post must already see it.
    const order = this.noteOrder();
    if (order.length > 0) await this.saveNoteOrder([id, ...order]);
    const note = newNote(title, body, id, Date.now());
    await this.saveNotes([...this.notes(), images.length > 0 ? { ...note, images } : note]);
  }

  /** Attach one image to a saved note. A refusal is toasted with the store's own
   * reason rather than swallowed: the user just pasted something and is owed an
   * answer. Unlike title and body — a draft that waits on Save — an attachment is
   * immediate, like toggleDone: it is on disk the moment it lands, and Cancel in
   * the edit form does not take it back. */
  private async attachImage(id: string, bytes: Uint8Array, mime: string, name: string): Promise<void> {
    // A stale view can name a note the store no longer has. There is nothing to
    // attach to, and writing the file anyway would hand the sweep an instant orphan.
    if (!this.notes().some((n) => n.id === id)) return;
    const imageId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const saved = saveImage(this.imageDir(), bytes, mime, name, imageId);
    if (!saved.ok) {
      this.toast("error", saved.reason);
      return;
    }
    await this.saveNotes(
      this.notes().map((n) => (n.id === id ? { ...n, images: [...(n.images ?? []), saved.image] } : n)),
    );
  }

  private async pickImage(id: string): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: "Attach",
      filters: { Images: ["png", "jpg", "jpeg", "gif", "webp"] },
    });
    const file = picked?.[0];
    if (!file) return;
    // A picker hands back a path, not a type, so the mime comes from the extension
    // here. The filter above is a hint the user can defeat ("All Files"), which is
    // why an unlisted extension still has to fail the store's own whitelist.
    const mime = MIME_BY_EXT[path.extname(file.fsPath).slice(1).toLowerCase()] ?? "";
    await this.attachImage(id, fs.readFileSync(file.fsPath), mime, path.basename(file.fsPath));
  }

  private async removeImage(id: string, imageId: string): Promise<void> {
    const note = this.notes().find((n) => n.id === id);
    const image = note?.images?.find((i) => i.id === imageId);
    if (!note || !image) return;
    deleteImages(this.imageDir(), [image]);
    const images = (note.images ?? []).filter((i) => i.id !== imageId);
    await this.saveNotes(
      this.notes().map((n) => (n.id === id ? (images.length > 0 ? { ...n, images } : stripImages(n)) : n)),
    );
  }

  private async openImage(id: string, imageId: string): Promise<void> {
    const image = this.notes().find((n) => n.id === id)?.images?.find((i) => i.id === imageId);
    if (!image) return;
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(imagePath(this.imageDir(), image)));
  }

  private async updateNote(id: string, title: string, body: string): Promise<void> {
    await this.saveNotes(
      this.notes().map((n) => (n.id === id ? { ...n, title: title.trim(), body: body.trim() } : n)),
    );
  }

  private async toggleNoteDone(id: string): Promise<void> {
    await this.saveNotes(this.notes().map((n) => (n.id === id ? { ...n, done: !n.done } : n)));
  }

  private async deleteNote(id: string): Promise<void> {
    const gone = this.notes().find((n) => n.id === id);
    const remaining = this.notes().filter((n) => n.id !== id);
    if (gone?.images?.length) deleteImages(this.imageDir(), gone.images);
    await this.pruneNoteOrder(remaining);
    await this.saveNotes(remaining);
  }

  private async clearCompletedNotes(): Promise<void> {
    const remaining = this.notes().filter((n) => !n.done);
    const images = this.notes().filter((n) => n.done).flatMap((n) => n.images ?? []);
    if (images.length > 0) deleteImages(this.imageDir(), images);
    await this.pruneNoteOrder(remaining);
    await this.saveNotes(remaining);
  }

  /** Delete image files no note references. Called once on activate. Every other
   * cleanup path is a best-effort write that a crash — or an older version, or a
   * hand-edited state file — can leave half-done, so without this the store only
   * grows. It is also the only writer that deletes on the strength of the notes
   * alone, which is why it never runs on the poll: a poll racing a half-written
   * state file would delete files a note still points at. */
  public sweepNotepadImages(): void {
    try {
      const keep = new Set(this.notes().flatMap((n) => (n.images ?? []).map((i) => i.id)));
      sweepOrphans(this.imageDir(), keep);
    } catch (e) {
      this.log(`notepad: image sweep failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async addSection(name: string): Promise<void> {
    if (!name.trim()) return;
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await this.saveSections([...this.sections(), newSection(name, id, Date.now())]);
  }

  private async renameSection(id: string, name: string): Promise<void> {
    if (!name.trim()) return;
    await this.saveSections(this.sections().map((s) => (s.id === id ? { ...s, name: name.trim() } : s)));
  }

  /** The section goes away; its notes do not — they fall back to ungrouped,
   * same as a note whose section was never set. */
  private async deleteSection(id: string): Promise<void> {
    await this.saveSections(this.sections().filter((s) => s.id !== id));
    await this.saveNotes(this.notes().map((n) => (n.sectionId === id ? { ...n, sectionId: undefined } : n)));
    const collapsed = this.collapsedSectionIds();
    if (collapsed.includes(id)) await this.saveCollapsedSectionIds(collapsed.filter((c) => c !== id));
  }

  private async setNoteSection(id: string, sectionId: string | undefined): Promise<void> {
    await this.saveNotes(this.notes().map((n) => (n.id === id ? { ...n, sectionId } : n)));
  }

  private async toggleSectionCollapsed(id: string): Promise<void> {
    const collapsed = this.collapsedSectionIds();
    await this.saveCollapsedSectionIds(
      collapsed.includes(id) ? collapsed.filter((c) => c !== id) : [...collapsed, id],
    );
  }

  public async refresh(): Promise<void> {
    await this.postInitialState();
  }

  /** Establish (and broadcast) the panel's state, then load tasks. Posts `state`
   * up-front — before any network round-trip — so the webview always has something
   * to render (setup CTA / sign-in gate / task list) instead of a blank panel while
   * a request is in flight. The display name is fetched alongside the task list, so
   * a slow or unreachable `/myself` never delays (or blocks) the UI. */
  private async postInitialState(): Promise<void> {
    const cfg = getConfig();
    const configured = this.connector.isConfigured();
    let authed = false;
    try {
      authed = await this.connector.isAuthenticated();
    } catch {
      authed = false;
    }
    this.postState(authed, configured, null);
    this.postNotepad();
    if (!configured || !authed) return;

    const provider = this.provider();
    await Promise.all([
      provider
        .me()
        .then((me) => {
          if (me?.displayName) this.postState(true, configured, me.displayName);
        })
        .catch(() => {
          /* display name is best-effort — the task list is the real payload */
        }),
      // Best-effort, and its own message on purpose — see the `caps` message in
      // types.ts. A source whose capabilities are static has no refreshCaps and
      // nothing is posted; a source that has one but cannot answer keeps whatever it
      // already claimed, because refreshCaps is specified never to reject. The catch
      // is a backstop for a connector that breaks that promise: a board list nobody
      // asked for must not take out the panel's first paint.
      (async () => {
        if (!provider.refreshCaps) return;
        await provider.refreshCaps();
        this.post({ type: "caps", caps: serializeCaps(provider.caps) });
      })().catch(() => {
        /* a source that cannot learn its own shape keeps the caps it already posted */
      }),
      // The configured lens goes through unclamped ON PURPOSE: the `fetch` case is
      // the single choke point where a filter reaches a provider, and it clamps
      // there — see `effectiveFilter` in that handler. A second clamp here would be
      // unreachable by any test, since the first thing this value meets is that one.
      // (It matters that it IS clamped: `agentFlow.defaultFilter` ships as
      // "mysprint", which a source without sprints cannot answer.)
      this.onMessage({ type: "fetch", filter: cfg.defaultFilter as Filter, size: "any" }),
    ]);
  }

  private async onMessage(m: InboundMessage): Promise<void> {
    try {
      // Inside the try, not above it: a disposed output channel makes `this.log`
      // throw, and getConfig can throw on a malformed settings value. Either
      // landing outside the try rejected out of the message handler unhandled —
      // nothing posted, no error surfaced, and any spinner already on stayed on.
      const cfg = getConfig();
      this.log(`webview → host: ${m.type}`);
      switch (m.type) {
        case "ready":
        case "retry": {
          await this.postInitialState();
          break;
        }
        case "runDoctor": {
          await vscode.commands.executeCommand("agentFlow.doctor");
          break;
        }
        case "signIn": {
          await vscode.commands.executeCommand("agentFlow.signIn");
          break;
        }
        case "runSetup": {
          await vscode.commands.executeCommand("agentFlow.setup");
          break;
        }
        case "openExternal": {
          await vscode.env.openExternal(vscode.Uri.parse(m.url));
          break;
        }
        case "fetch": {
          if (!(await this.connector.isAuthenticated())) {
            this.postState(false, this.connector.isConfigured(), null);
            return;
          }
          this.post({ type: "loading", loading: true });
          // Overlapping fetches resolve in any order, and only the latest-started
          // one may speak for the panel: a stale completion that posted its list,
          // pruned the saved order, or set lastFilter would desync the rendered
          // lens from the reorder guard below and silently discard the next drag.
          const seq = ++this.fetchSeq;
          const provider = this.provider();
          // A webview left open across a `taskSource` change can send a filter the
          // current source no longer supports — clamp rather than ask for it. Both
          // `lastFilter` and the posted `filter` carry the clamped lens, so the tab
          // the webview highlights is the one that was actually fetched.
          const lens = effectiveFilter(m.filter, provider.caps.supportedFilters);
          const tasks = await provider.list(lens, m.size);
          if (seq !== this.fetchSeq) break; // a newer fetch owns the panel now
          this.lastFilter = lens;
          const repos = discoverRepos(cfg.reposRoot, cfg.repoBlocklist);
          for (const t of tasks) t.services = this.guessServices(t, repos);
          let outgoing = tasks;
          if (lens === "mysprint") {
            if (m.size === "any") {
              // Full sprint view: prune keys that have left the sprint.
              await this.saveOrder(pruneOrder(this.savedOrder(), tasks.map((t) => t.key)));
            }
            outgoing = sortBySavedOrder(tasks, this.savedOrder(), (t) => t.key);
          }
          this.post({ type: "tasks", filter: lens, tasks: outgoing,
            liveCount: cfg.trackOpenWindows ? this.liveWindows().length : undefined });
          this.post({ type: "loading", loading: false });
          break;
        }
        case "detail": {
          if (!(await this.connector.isAuthenticated())) return;
          const provider = this.provider();
          const info = this.connector.info();
          const detail = await provider.detail(m.key);
          const repos = discoverRepos(cfg.reposRoot, cfg.repoBlocklist);
          // Confirmed repos only: a label/text guess must not arrive pre-selected —
          // taking the card as-is would attach a repo the ticket never recorded.
          // The guesses stay reachable through the card's picker.
          const inferred = confirmedServices(
            inferServices(
              { summary: detail.summary, descriptionText: detail.descriptionText, labels: detail.labels, components: detail.components },
              repos,
            ),
          ).map((r) => r.service.name);
          // After the issue read, never before: the component list swallows every
          // failure including a 401, so the detail read is what lets a dead token
          // reach the catch below and re-gate the panel. A source with no components
          // at all yields the same `null` — no chip can be classified either way,
          // which is exactly what `mappable: null` means to the webview.
          const components = provider.caps.components;
          const projectComponents = components ? await components.list() : null;
          // Not toasted: a card expand happening to land while the source's endpoint
          // is down would toast on every expand. The chips render "unknown" instead;
          // these lines are only for tracing it after the fact. The two cases get
          // different wording on purpose, matching setComponent's: "unavailable"
          // claims a read was attempted and failed, which is untrue of a source that
          // has no components to read — and sending someone to check a connection
          // over a capability the source never had is a wasted hour.
          if (!components) {
            this.log(`detail ${m.key}: ${info.label} doesn't have components`);
          } else if (projectComponents === null) {
            this.log(`detail ${m.key}: ${info.scopeValue} component list unavailable`);
          }
          const names = repos.map((r) => r.name);
          this.post({
            type: "detail",
            key: m.key,
            descriptionText: detail.descriptionText,
            inferred,
            repos: names,
            sourceComponents: detail.components,
            mappable: projectComponents === null ? null : mapRepoComponents(names, projectComponents),
          });
          break;
        }
        case "take": {
          // A card Take, whether or not the card was expanded with a repo selection:
          // this dispatcher only ever handles webview messages.
          await this.takeTask(m.key, "card", m.services);
          break;
        }
        case "takeBatch": {
          await this.takeBatch(m.keys, m.repos);
          break;
        }
        case "addressPr": {
          await this.addressPr(m.key, m.services);
          break;
        }
        case "changeStatus": {
          await this.changeStatus(m.key);
          break;
        }
        case "addToMySprint": {
          await this.addToMySprint(m.key);
          break;
        }
        case "removeFromSprint": {
          await this.removeFromSprint(m.key, m.size);
          break;
        }
        case "setComponent": {
          await this.setComponent(m.key, m.repo, m.on, m.movedChip);
          break;
        }
        case "explore": {
          await this.explore();
          break;
        }
        case "notepad:add": {
          await this.addNote(m.title, m.body, m.images);
          break;
        }
        case "notepad:update": {
          await this.updateNote(m.id, m.title, m.body);
          break;
        }
        case "notepad:addImage": {
          await this.attachImage(m.id, Buffer.from(m.dataBase64, "base64"), m.mime, m.name);
          break;
        }
        case "notepad:pickImage": {
          await this.pickImage(m.id);
          break;
        }
        case "notepad:removeImage": {
          await this.removeImage(m.id, m.imageId);
          break;
        }
        case "notepad:openImage": {
          await this.openImage(m.id, m.imageId);
          break;
        }
        case "notepad:toggleDone": {
          await this.toggleNoteDone(m.id);
          break;
        }
        case "notepad:delete": {
          await this.deleteNote(m.id);
          break;
        }
        case "notepad:clearCompleted": {
          await this.clearCompletedNotes();
          break;
        }
        case "notepad:run": {
          await this.runNotepadItem(m.id);
          break;
        }
        case "notepad:reorder": {
          const known = new Set(this.notes().map((n) => n.id));
          const visible = m.order.filter((id) => known.has(id));
          if (visible.length === 0) break;
          // Seed from the CURRENT display order, not from the (possibly empty)
          // saved one: applyReorder only preserves the slots of ids it can see in
          // `saved`, so a first drag under a filter would otherwise push every
          // hidden note to the bottom.
          const saved = this.noteOrder();
          const base = saved.length > 0 ? saved : this.orderedNotes().map((n) => n.id);
          await this.saveNoteOrder(applyReorder(base, visible, new Set(visible)));
          this.postNotepad();
          break;
        }
        case "notepad:resetOrder": {
          await this.saveNoteOrder([]);
          this.postNotepad();
          break;
        }
        case "notepad:addSection": {
          await this.addSection(m.name);
          break;
        }
        case "notepad:renameSection": {
          await this.renameSection(m.id, m.name);
          break;
        }
        case "notepad:deleteSection": {
          await this.deleteSection(m.id);
          break;
        }
        case "notepad:setSection": {
          await this.setNoteSection(m.id, m.sectionId);
          break;
        }
        case "notepad:toggleSectionCollapsed": {
          await this.toggleSectionCollapsed(m.id);
          break;
        }
        case "reorder": {
          // Defense-in-depth: reorder is a My-sprint-only affordance (the webview only
          // sends it from that tab). Ignore it in any other view.
          if (this.lastFilter !== "mysprint") break;
          const next = applyReorder(this.savedOrder(), m.order, new Set(m.order));
          await this.saveOrder(next);
          break;
        }
        case "resetOrder": {
          await this.saveOrder([]);
          await this.onMessage({ type: "fetch", filter: "mysprint", size: m.size });
          break;
        }
      }
    } catch (e) {
      const op = resolveOp(m, e);
      if (op) {
        const failure_class = classifyFailure(e);
        trackError({ name: "operation_failed", op, failure_class, retryable: isRetryable(failure_class) });
      }
      this.post({ type: "loading", loading: false });
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof TaskAuthError) {
        // Auth failures re-gate to the sign-in screen, which is itself the indication.
        this.postState(false, this.connector.isConfigured(), null);
      } else if (m.type === "ready" || m.type === "retry" || m.type === "fetch") {
        // Only the messages that populate the panel may replace it: if the list
        // never loaded there is nothing to preserve. A failed write keeps its
        // list on screen and settles for a toast.
        // The gate covers exactly Doctor's remit — unreachable site, bad project
        // key, auth loss — so it is the right place to offer the diagnostic.
        this.post({ type: "error", message: msg, canRetry: true, canRunDoctor: true });
      }
      this.toast("error", msg);
    }
  }

  /** Change a task's status via a menu of the moves its source allows (a source WRITE). */
  public async changeStatus(key: string): Promise<void> {
    this.log(`changeStatus ${key}: start`);
    if (!(await this.connector.isAuthenticated())) {
      this.log(`changeStatus ${key}: not authenticated`);
      this.postState(false, this.connector.isConfigured(), null);
      return;
    }
    // One provider for the whole operation: it is what remembers the prompts it
    // issued for this target, and moveTo needs that to map the answers back.
    const provider = this.provider();
    const targets = await provider.statusTargets(key);
    this.log(`changeStatus ${key}: ${targets.length} targets`);
    if (targets.length === 0) {
      this.toast("info", `No status transitions available for ${key}.`);
      return;
    }
    const pick = await vscode.window.showQuickPick(
      targets.map((t) => ({
        label: `$(arrow-small-right) ${t.toName}`,
        description: t.via ? `via "${t.via}"` : "",
        t,
      })),
      { title: `${key} — change status to…`, placeHolder: "Pick a status", ignoreFocusOut: true },
    );
    this.log(`changeStatus ${key}: picked ${pick ? pick.t.toName : "(cancelled)"}`);
    if (!pick) return;
    const target = pick.t;
    if (target.unfillable?.length) {
      // The one place the extension silently decides for the user. When the write is
      // refused for a field nobody was asked about, this line is the only way to
      // learn the omission was deliberate. `info.label` rather than a literal, so the
      // sentence stays true for a non-Jira source — for Jira it is the same words the
      // pre-seam view logged.
      this.log(
        `changeStatus ${key}: can't fill ${target.unfillable.join(", ")} here — letting ${this.connector.info().label} decide`,
      );
    }

    const values = await this.collectFields(key, target.toName, target.fields);
    if (values === undefined) {
      this.log(`changeStatus ${key}: cancelled at a field prompt`);
      return;
    }

    try {
      await provider.moveTo(key, target.id, values);
    } catch (e) {
      if (!(e instanceof TaskWriteError)) throw e;
      // One rescue attempt, and only when the connector named something to ask
      // for. Anything else is reported in place — a refused write leaves the
      // list valid, so it never re-gates the panel.
      if (!e.retryWith.length) {
        this.reportWriteFailure(key, e);
        return;
      }
      this.log(`changeStatus ${key}: rejected — re-prompting ${e.retryWith.map((p) => p.name).join(", ")}`);
      const extra = await this.collectFields(key, target.toName, e.retryWith);
      if (extra === undefined) return;
      try {
        await provider.moveTo(key, target.id, { ...values, ...extra });
      } catch (e2) {
        if (!(e2 instanceof TaskWriteError)) throw e2;
        this.reportWriteFailure(key, e2);
        return;
      }
    }
    this.log(`changeStatus ${key}: move ok → ${target.toName}`);
    await this.stampProvenance(provider, key);
    const removed = target.toCategory === "done";
    // toCategory's "" (uncategorized destination) has no place in a Task's
    // statusCategory, which always has one of the three — fold it into "new",
    // same as an empty category already reads on a fetched task (deriveStatuses,
    // railClass in webview/helpers.ts).
    const category = target.toCategory || "new";
    this.post({ type: "statusChanged", key, status: target.toName, category, removed });
    this.toast("success", `${key} → ${target.toName}`);
  }

  /** Run one prompt per field, in order. Returns the user's RAW answers — the
   *  connector maps them to its own wire shape — or undefined when the user
   *  escaped: a half-filled move is never worth writing, so cancelling any prompt
   *  cancels the whole thing. */
  private async collectFields(
    key: string,
    toName: string,
    prompts: FieldPrompt[],
  ): Promise<Record<string, string | string[]> | undefined> {
    const out: Record<string, string | string[]> = {};
    for (const p of prompts) {
      const title = `${key} → ${toName}`;
      // The two QuickPick calls are kept separate on purpose: `canPickMany` only
      // selects the array-returning overload when it's the literal `true`.
      if (p.kind === "multipick") {
        const picked = await vscode.window.showQuickPick(
          p.choices.map((c) => ({ label: c.name })),
          { title, placeHolder: `Pick ${p.name}`, canPickMany: true, ignoreFocusOut: true },
        );
        if (!picked || picked.length === 0) return undefined;
        out[p.id] = picked.map((i) => i.label);
      } else if (p.kind === "pick") {
        const picked = await vscode.window.showQuickPick(
          p.choices.map((c) => ({ label: c.name })),
          { title, placeHolder: `Pick ${p.name}`, ignoreFocusOut: true },
        );
        if (!picked) return undefined;
        out[p.id] = picked.label;
      } else {
        const raw = await vscode.window.showInputBox({
          title,
          prompt: p.name,
          placeHolder: p.kind === "date" || p.kind === "datetime" ? "YYYY-MM-DD" : undefined,
          ignoreFocusOut: true,
          validateInput: (v: string) => validateFieldInput(p, v),
        });
        if (raw === undefined) return undefined;
        out[p.id] = raw;
      }
    }
    return out;
  }

  /** A refused write leaves the list valid, so it gets a toast — never the gate —
   *  with a way out to the task itself. The message is the connector's own: it knows
   *  what its refusal meant, and re-phrasing it here would only lose detail.
   *
   *  The transport status goes to the log and NOT to the toast: "403" tells a
   *  maintainer reading the output channel whether the write was forbidden or merely
   *  malformed, and tells a user nothing they can act on. Sources without one log the
   *  message alone rather than an empty prefix. */
  private reportWriteFailure(key: string, err: TaskWriteError): void {
    const info = this.connector.info();
    const text = `Couldn't update ${key}. ${err.message}`;
    this.log(`changeStatus ${key}: ${err.status === undefined ? "" : `${err.status} — `}${text}`);
    this.toast("error", text, {
      label: `Open in ${info.label}`,
      url: this.connector.taskUrl(key),
    });
  }

  /** Add a task to the active sprint and assign it to the current user — the two
   * writes that make it show up in the "My sprint" lens. Stamps the provenance label. */
  public async addToMySprint(key: string): Promise<void> {
    this.log(`addToMySprint ${key}: start`);
    if (!(await this.connector.isAuthenticated())) {
      this.postState(false, this.connector.isConfigured(), null);
      return;
    }
    const provider = this.provider();
    const ops = this.sprints(provider);
    if (!ops) return;
    const info = this.connector.info();
    const me = await provider.me();
    // `!me.id`, not just `!me`: a source may name the user without a usable id (see
    // `TaskProvider.me`), and this method pairs a sprint-add with an assignment. An
    // identity that can't be assigned to has to stop the pair BEFORE the first write,
    // not fail at the second and leave the task in the sprint but unassigned.
    if (!me?.id) {
      this.toast("error", `Couldn't resolve your ${info.label} account.`);
      return;
    }
    const sprintId = await ops.activeId();
    if (sprintId == null) {
      this.toast("error", `No active sprint on the ${info.scopeValue} board.`);
      return;
    }
    await ops.add(sprintId, key);
    // The id from the `me()` above, not a second lookup: one /myself per sprint-add,
    // and — the part that matters — the sprint-add cannot be left standing with the
    // assignment failing because a re-resolve answered differently.
    await provider.assignToMe(key, me.id);
    this.log(`addToMySprint ${key}: sprint ${sprintId} + assigned to ${me.displayName}`);
    await this.stampProvenance(provider, key);
    // No longer matches the "unassigned" or "backlog" lenses once it's mine + in a sprint.
    const removed = this.lastFilter === "unassigned" || this.lastFilter === "backlog";
    this.post({ type: "movedToSprint", key, assignee: me.displayName, removed });
    this.toast("success", `${key} → your sprint`);
  }

  /** Remove a task from the active sprint by moving it to the backlog. Leaves
   * assignee and status untouched. Offers a one-click Undo via a native notification. */
  public async removeFromSprint(key: string, size: Size): Promise<void> {
    this.log(`removeFromSprint ${key}: start`);
    if (!(await this.connector.isAuthenticated())) {
      this.postState(false, this.connector.isConfigured(), null);
      return;
    }
    const provider = this.provider();
    const ops = this.sprints(provider);
    if (!ops) return;
    await ops.remove(key);
    this.log(`removeFromSprint ${key}: moved to backlog`);
    await this.stampProvenance(provider, key);
    // Drop it from the saved manual order so no ghost rank lingers.
    const saved = this.savedOrder();
    if (saved.includes(key)) await this.saveOrder(saved.filter((k) => k !== key));
    this.post({ type: "removedFromSprint", key });
    this.toast("success", `${key} → backlog`);
    // Undo: put it back into the active sprint and refetch so the card returns.
    const choice = await vscode.window.showInformationMessage(`${key} removed from your sprint`, "Undo");
    if (choice !== "Undo") return;
    try {
      const sprintId = await ops.activeId();
      if (sprintId == null) {
        this.toast("error", `No active sprint on the ${this.connector.info().scopeValue} board.`);
        return;
      }
      await ops.add(sprintId, key);
      this.log(`removeFromSprint ${key}: undo → sprint ${sprintId}`);
    } catch (e) {
      // The remove already succeeded — the ticket really is out of the sprint. A
      // throwing undo used to escape into the dispatcher's generic catch: a raw
      // error toast with no refetch, and the card already gone read as an undone
      // removal. Say what failed, then refetch below so the list shows reality.
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`removeFromSprint ${key}: undo failed — ${msg}`);
      this.toast("error", `Undo failed — ${key} is still out of the sprint. ${msg}`);
    }
    await this.onMessage({ type: "fetch", filter: "mysprint", size });
  }

  /** Add or remove one component on a task, mirroring one chip in the card (a source
   * WRITE). Reports its own failures and never throws, so `onMessage`'s catch cannot
   * double-toast; every call posts exactly one `componentsChanged`, which is the
   * webview's cue to keep or undo its optimistic update. */
  public async setComponent(key: string, repo: string, on: boolean, movedChip: boolean): Promise<void> {
    // Exactly one verdict per call, structurally: the webview holds an optimistic
    // edit until it hears back, so zero echoes strand it wrong for the life of the
    // window, and two would double-apply the undo.
    let echoed = false;
    const echo = (ok: boolean) => {
      if (echoed) return;
      echoed = true;
      this.post({ type: "componentsChanged", key, repo, on, movedChip, ok });
    };
    try {
      if (!(await this.connector.isAuthenticated())) {
        this.postState(false, this.connector.isConfigured(), null);
        echo(false);
        return;
      }
      const info = this.connector.info();
      // The webview hides the chips on `caps.components`; this is the backstop for a
      // stale webview. `ok: false` is what releases its held optimistic edit — a
      // silent return would strand the chip for the life of the window.
      const provider = this.provider();
      const components = provider.caps.components;
      if (!components) {
        this.log(`setComponent ${key}: ${info.label} doesn't have components`);
        echo(false);
        this.toast("error", `${info.label} doesn't have components.`);
        return;
      }
      const projectComponents = await components.list();
      if (projectComponents === null) {
        // The read failed — that is not the same claim as "no such component", and
        // blaming the repo name would send the user looking in the wrong place.
        this.log(`setComponent ${key}: ${info.scopeValue} component list unavailable`);
        echo(false);
        this.toast("error", `Couldn't read ${info.scopeValue}'s components from ${info.label}. Check the connection and try again.`);
        return;
      }
      const name = resolveComponent(repo, projectComponents);
      if (!name) {
        // The webview only sends repos it believes are components, so the list moved
        // under us. Nothing was written.
        this.log(`setComponent ${key}: no ${info.scopeValue} component named ${repo}`);
        echo(false);
        this.toast("error", `${info.scopeValue} has no component named “${repo}”.`);
        return;
      }
      try {
        await components.update(key, on ? { add: [name] } : { remove: [name] });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.log(`setComponent ${key}: ${on ? "add" : "remove"} ${name} failed — ${msg}`);
        echo(false);
        if (e instanceof TaskAuthError) {
          this.postState(false, this.connector.isConfigured(), null);
          return;
        }
        this.toast("error", msg, { label: `Open in ${info.label}`, url: this.connector.taskUrl(key) });
        return;
      }
      this.log(`setComponent ${key}: ${on ? "add" : "remove"} ${name} ok`);
      await this.stampProvenance(provider, key);
      echo(true);
      this.toast("success", on ? `Added ${name} to ${key}` : `Removed ${name} from ${key}`);
    } catch (e) {
      // Nothing above is expected to throw — this is the backstop that guarantees
      // the verdict, e.g. if reading the stored credential itself rejects.
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`setComponent ${key}: unexpected failure — ${msg}`);
      echo(false);
      this.toast("error", msg);
    }
  }

  /** Pick which Explore action to run. Uses cfg.exploreMode directly when it names a
   * known action; otherwise ("ask" or an unknown id) shows a QuickPick. Returns
   * undefined when the user cancels the picker. */
  private async chooseExploreAction(cfg: AgentFlowConfig): Promise<ExploreAction | undefined> {
    const configured = cfg.exploreActions.find((a) => a.id === cfg.exploreMode);
    if (configured) return configured;
    const pick = await vscode.window.showQuickPick(
      cfg.exploreActions.map((a) => ({ label: a.label, action: a })),
      { title: "Explore — what kind of session?", placeHolder: "Pick an action", ignoreFocusOut: true },
    );
    return pick?.action;
  }

  /** Pick the environment for an action that needs one: the configured list plus a
   * Custom… escape hatch for a one-off value. The item carries its own `env` rather
   * than reusing `label`, so an environment literally named like the Custom… entry
   * can't be mistaken for it. Returns undefined when the user cancels either step. */
  private async chooseEnvironment(cfg: AgentFlowConfig): Promise<string | undefined> {
    const pick = await vscode.window.showQuickPick<vscode.QuickPickItem & { env?: string }>(
      [...cfg.environments.map((e) => ({ label: e, env: e })), { label: "$(edit) Custom…" }],
      { title: "Verify — which environment?", placeHolder: "Pick an environment", ignoreFocusOut: true },
    );
    if (!pick) return undefined;
    if (pick.env) return pick.env;
    const typed = await vscode.window.showInputBox({
      title: "Verify — environment name",
      prompt: "The environment to verify against.",
      placeHolder: "e.g. staging-eu",
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : "Name the environment"),
    });
    return typed?.trim() || undefined;
  }

  /** Shared kickoff tail for `explore()` and `runNotepadItem`: pick a destination,
   * resolve the repo set for it (skipping the picker for a destination that already
   * fixes its own repos — an existing/live-folder window, or this one), turn it into
   * `openWorkspace` args, and resolve the Remote Control toggle. `pickerLabel` and
   * `argsLabel` are the only two points where the two callers' copy differs.
   * Returns undefined on any cancellation, at which point the caller must open
   * nothing. */
  private async resolveKickoffTarget(
    cfg: AgentFlowConfig,
    repos: ServiceRef[],
    pickerLabel: string,
    argsLabel: string,
  ): Promise<
    | {
        target: OpenTarget;
        services: ServiceRef[];
        args: { mode: WorkspaceMode; openIn: "new" | "current"; existingWorkspaceFile?: string; existingFolder?: string; currentWindow?: CurrentWindow };
        wantRemoteControl: boolean;
      }
    | undefined
  > {
    const target = await this.chooseOpenTarget(cfg);
    if (!target) return undefined;

    let services: ServiceRef[];
    // "This window" already names its repos — the folders open here (see resolveKickoff).
    const openHere = target.kind === "current" ? this.servicesFromExistingDestination(target, repos) : [];
    if (target.kind === "existing" || target.kind === "live-folder") {
      services = this.servicesFromExistingDestination(target, repos);
      if (services.length === 0) {
        this.toast("error", "That workspace has no repos to open.");
        return undefined;
      }
    } else if (openHere.length) {
      services = openHere;
    } else {
      const picks = await vscode.window.showQuickPick<vscode.QuickPickItem & { repo: ServiceRef }>(
        repos.map((r) => ({
          label: r.name,
          detail: r.isGit ? r.path : `${r.path}  (not a git repo)`,
          repo: r,
        })),
        {
          canPickMany: true,
          title: `${pickerLabel} — pick the repos to open`,
          placeHolder: "Space to toggle · Enter to open",
          ignoreFocusOut: true,
        },
      );
      if (!picks || picks.length === 0) return undefined;
      services = picks.map((p) => p.repo);
    }

    const args = await this.targetToOpenArgs(target, services.length, argsLabel, cfg);
    if (!args) return undefined;

    const wantRemoteControl = await this.resolveRemoteControl(cfg);
    if (wantRemoteControl === null) return undefined; // refused — the caller opens nothing

    return { target, services, args, wantRemoteControl };
  }

  /** Explore flow: pick repos freely (no ticket), open a workspace, and seed a Claude Code
   * agent for investigation/knowledge — a Jira ticket can come out of it later. */
  public async explore(): Promise<void> {
    const cfg = getConfig();
    if (this.remoteControlBlocksLaunch(cfg)) return;
    const repos = discoverRepos(cfg.reposRoot, cfg.repoBlocklist);
    if (repos.length === 0) {
      this.toast("error", `No repos found under ${cfg.reposRoot}. Check agentFlow.reposRoot.`);
      return;
    }

    const action = await this.chooseExploreAction(cfg);
    if (!action) return; // picker cancelled

    const raw = await vscode.window.showInputBox(
      action.needsEnv
        ? {
            title: "Verify — which feature or change?",
            prompt: "The feature or change to verify on the environment.",
            placeHolder: "e.g. the new retry banner on checkout",
            ignoreFocusOut: true,
            validateInput: (v) => (v.trim() ? undefined : "Name the feature or change to verify"),
          }
        : action.id === "supervise"
          ? {
              title: "Supervise — anything specific to prioritize?",
              prompt: "Optional — a priority among your other active tasks. Leave blank to check on all of them.",
              placeHolder: "e.g. the deck-agents-view task",
              ignoreFocusOut: true,
            }
          : {
              title: "Explore — what do you want to dig into?",
              prompt: "A focus for the session (optional). A Jira ticket can come later.",
              placeHolder: "e.g. how the aggregator retries failed scans",
              ignoreFocusOut: true,
            },
    );
    if (raw === undefined) return; // cancelled (empty is allowed → generic focus)
    const topic = raw.trim() || (action.id === "supervise" ? "Check on active tasks" : "Codebase exploration");

    // Verify needs to know where; the other actions never ask. Before the destination
    // step, so cancelling here has created and opened nothing.
    let env: string | undefined;
    if (action.needsEnv) {
      env = await this.chooseEnvironment(cfg);
      if (!env) return; // environment pick cancelled
    }

    // Destination first — an existing workspace / live folder already fixes its repos.
    const kickoff = await this.resolveKickoffTarget(cfg, repos, "Explore", "Explore");
    if (!kickoff) return;
    const { services, args, wantRemoteControl } = kickoff;

    const slug = slugify(topic) || "explore";
    const serviceNames = services.map((s) => s.name).join(", ");
    const key = env ? `verify-${slugify(env) || "env"}-${slug}` : `explore-${slug}`;
    const summary = env ? `${topic} on ${env}` : topic;
    const planMd = env
      ? `## Verify: ${topic} on ${env}\n\n_Verification session — environment: ${env}. Services in scope: ${serviceNames}._`
      : action.id === "supervise"
        ? `## Supervise: ${topic}\n\n_No Jira ticket yet — a supervision session over your other active Agent Flow Deck tasks._\n\n` +
          describeActiveTasks(readRuns(defaultRunsDir()), new Set(groupByPlace(readOpenSessions(defaultSessionsDir())).keys()))
        : `## Exploration: ${topic}\n\n_No Jira ticket yet — a knowledge/exploration session. If it turns into work, open a ticket afterwards._`;
    const result = await openWorkspace({
      ticket: { key, summary, url: "" },
      planMd,
      descriptionText: "",
      services,
      mode: args.mode,
      // Slack sentence first: it anchors on {files} in the *authored* template, so a
      // typed environment containing "{files}" can never become that anchor.
      promptTemplate: applyExploreVars(injectSlackDm(action.prompt, action.slackDm), { env, services: serviceNames }),
      workspaceDir: cfg.workspaceDir,
      seedAgent: cfg.seedAgent,
      openIn: args.openIn,
      existingWorkspaceFile: args.existingWorkspaceFile,
      existingFolder: args.existingFolder,
      currentWindow: args.currentWindow,
      remoteControl: wantRemoteControl,
      kind: "explore",
    });
    // The agent picker was dismissed, which dismisses the launch: nothing was opened,
    // written or seeded, so there is nothing to report. Not an error toast either — a
    // cancellation is the user's own decision, and every other picker on this path
    // returns just as quietly.
    if (result.cancelled) return;

    const where = this.openedWhere(result, cfg.seedAgent);
    const seeded = this.seededNote(cfg.seedAgent, result.remoteControl, result.provider, result.seededInPlace);
    const rcNote = this.remoteControlNote(wantRemoteControl, result.remoteControl, result.provider);
    const what = env
      ? `to verify on ${env}`
      : action.id === "supervise"
        ? "to check on your other tasks"
        : "to explore";
    this.toast("success", `Opened ${where} ${what}. Brief seeded in each repo.${seeded}${rcNote}`);
  }

  /** Launch an agent for one notepad item. Same shape as explore(): pick repos and
   * a destination, open a workspace, seed a brief — the note supplies the topic and
   * the brief body, so there is no input box to show. The run is written with
   * `kind: "notepad"` into the same store the Deck reads, which is the whole of the
   * Deck integration: the board gains a second origin, not a second data path. */
  public async runNotepadItem(id: string): Promise<void> {
    const note = this.notes().find((n) => n.id === id);
    if (!note) return;

    const cfg = getConfig();
    if (this.remoteControlBlocksLaunch(cfg)) return;
    const repos = discoverRepos(cfg.reposRoot, cfg.repoBlocklist);
    if (repos.length === 0) {
      this.toast("error", `No repos found under ${cfg.reposRoot}. Check agentFlow.reposRoot.`);
      return;
    }

    const kickoff = await this.resolveKickoffTarget(cfg, repos, "Notepad", "Notepad");
    if (!kickoff) return;
    const { services, args, wantRemoteControl } = kickoff;

    // The generic explore action's prompt/slackDm — a notepad run has no action to
    // choose (there is no Explore-style picker for it), so it borrows the one action
    // meant to be topic-agnostic. Selected by stable id, not list position, so
    // reordering agentFlow.exploreActions can never silently swap in a different
    // template here.
    const generic = cfg.exploreActions.find((a) => a.id === "general");
    const topic = note.title.trim() || "Notepad item";
    // Slugged from the note's own title, not from the display fallback above — an
    // untitled note must key as "notepad-note-<id>", not "notepad-notepad-item-<id>".
    // The note's own id is included (not just the title slug) because two notes can
    // share a title — or both be untitled — and would otherwise collide on the same
    // run-store key, silently overwriting each other's run record. Re-running the
    // SAME note still reuses this exact key, which is intended: it replaces that
    // note's own previous run rather than accumulating orphaned records.
    const key = `notepad-${slugify(note.title.trim()) || "note"}-${note.id}`;
    // Where each attached image will sit once openWorkspace has copied it, and under
    // which name — the same `attachmentFileName` the copy itself uses, so the paths
    // named below cannot drift from the files that land.
    const attachments = (note.images ?? []).map((img, i, all) => ({
      path: imagePath(this.imageDir(), img),
      name: attachmentFileName(all.map((im) => ({ path: imagePath(this.imageDir(), im), name: im.name })), i),
    }));
    // Repo-relative, not relative to the brief: the agent's cwd is the repo root, so a
    // bare `images/foo.png` names no file from there — the trap batchWorkspace.ts
    // already records for brief-relative references. Run-keyed via `attachmentRelPath`,
    // the same helper the copy uses, so a note taken beside another note's running agent
    // names its OWN screenshot rather than whichever landed in the checkout last.
    const imageLines = attachments
      .map((_, i) => `- \`${BRIEF_DIR}/images/${attachmentRelPath(key, attachments, i)}\``)
      .join("\n");
    const planMd =
      `## Notepad: ${topic}\n\n_No ticket — an item you wrote in the Agent Flow Deck notepad. ` +
      `If it turns into tracked work, open a ticket afterwards._` +
      (note.body.trim() ? `\n\n${note.body.trim()}` : "") +
      (attachments.length > 0 ? `\n\n## Attached images\n\n${imageLines}` : "");
    // The detail goes into the prompt as well as the brief. The generic template
    // carries only {summary} — the note's title — so everything the user typed under
    // it reached the agent only if it went and opened TASK.md, which is exactly what a
    // seeded session is least likely to do first. Passed as a suffix rather than folded
    // into the template so the user's own words are never read as placeholders. The
    // images are named for the same reason, doubly: one the agent never opens is one
    // the user typed nothing to replace.
    const imageNote = attachments.length > 0
      ? `The user attached ${attachments.length === 1 ? "an image" : "images"} to this note. ` +
        `Read ${attachments.length === 1 ? "it" : "them"} before starting:\n${imageLines}`
      : undefined;
    const details = [
      note.body.trim() ? `Details from the note:\n\n${note.body.trim()}` : undefined,
      imageNote,
    ].filter(Boolean).join("\n\n") || undefined;

    const result = await openWorkspace({
      ticket: { key, summary: topic, url: "" },
      planMd,
      descriptionText: note.body,
      attachments: attachments.length > 0 ? attachments : undefined,
      services,
      mode: args.mode,
      promptTemplate: applyExploreVars(injectSlackDm(generic?.prompt ?? "", generic?.slackDm ?? false), {
        env: undefined,
        services: services.map((s) => s.name).join(", "),
      }),
      promptSuffix: details,
      workspaceDir: cfg.workspaceDir,
      seedAgent: cfg.seedAgent,
      openIn: args.openIn,
      existingWorkspaceFile: args.existingWorkspaceFile,
      existingFolder: args.existingFolder,
      currentWindow: args.currentWindow,
      remoteControl: wantRemoteControl,
      kind: "notepad",
    });
    // Dismissed at the agent picker: no window, no brief, no plan, no run. Returning
    // HERE — before saveNotes below — is what makes that comment true.
    if (result.cancelled) return;

    // Point the note at its run so the badge has something to derive from. Written
    // after the launch, not before: a cancelled picker must leave no pointer to a
    // run that was never created.
    await this.saveNotes(this.notes().map((n) => (n.id === id ? { ...n, lastRunKey: key } : n)));

    const where = this.openedWhere(result, cfg.seedAgent);
    const seeded = this.seededNote(cfg.seedAgent, result.remoteControl, result.provider, result.seededInPlace);
    const rcNote = this.remoteControlNote(wantRemoteControl, result.remoteControl, result.provider);
    this.toast("success", `Opened ${where} for “${topic}”. Brief seeded in each repo.${seeded}${rcNote}`);
  }

  /** One repo → its own window; multiple → per the workspaceMode setting (asking if configured). */
  private async chooseWorkspaceMode(
    count: number,
    setting: AgentFlowConfig["workspaceMode"],
    label: string,
  ): Promise<WorkspaceMode | undefined> {
    if (count === 1 || setting === "per-window") return "per-window";
    if (setting !== "ask") return "multiroot"; // "auto" (>1 repo) or "multiroot"
    const p = await vscode.window.showQuickPick(
      [
        { label: "$(window) One multi-root workspace", detail: "Single window, all repos", mode: "multiroot" as WorkspaceMode },
        { label: "$(multiple-windows) One window per repo", detail: "Parallel, one per repo", mode: "per-window" as WorkspaceMode },
      ],
      { title: `${label} — how should I open ${count} repos?`, ignoreFocusOut: true },
    );
    return p?.mode;
  }

  private guessServices(t: Task, repos: ServiceRef[]): string[] {
    // Collapsed-card chips claim "this task touches X", so only ticket-confirmed
    // repos may make that claim; guesses show only when nothing is confirmed.
    return confirmedServices(
      inferServices({ summary: t.summary, labels: t.labels, components: t.components }, repos),
    ).map((r) => r.service.name);
  }

  /** Read the ticket and resolve the destination + repo set for a kick-off (Take or
   * Address PR): auth gate, repo discovery, the destination pick, then — only for a NEW
   * window — the confirm-repos QuickPick (pre-checking inferred repos). A destination
   * that already has folders (an existing/live-folder window, or this one) supplies its
   * own repo set, and `preselected` (the in-card selection) skips the QuickPick too.
   * Returns undefined on any abort. */
  private async resolveKickoff(
    key: string,
    preselected?: string[],
    flow?: Flow,
  ): Promise<{ detail: TaskDetail; services: ServiceRef[]; target: OpenTarget } | undefined> {
    const cfg = getConfig();
    if (!(await this.connector.isAuthenticated())) {
      const ok = await vscode.commands.executeCommand<boolean>("agentFlow.signIn");
      if (!ok) return undefined;
    }

    const detail = await vscode.window.withProgress(
      { location: { viewId: TasksViewProvider.viewType }, title: `Reading ${key}…` },
      () => this.provider().detail(key),
    );

    const repos = discoverRepos(cfg.reposRoot, cfg.repoBlocklist);
    if (repos.length === 0) {
      this.toast("error", `No repos found under ${cfg.reposRoot}. Check agentFlow.reposRoot.`);
      return undefined;
    }

    // Destination first — where the task lands drives which repos the list pre-checks.
    const target = await this.chooseOpenTarget(cfg);
    if (!target) return undefined;

    if (flow) {
      // No `used_worktree` here: the worktree decision happens later, in launch(),
      // and on the shipped `agentFlow.worktree: "ask"` default it is a QuickPick
      // answer this step cannot see. It rides on take_completed instead.
      track({
        name: "take_destination_picked",
        flow_id: flow.id,
        // No cast: OpenTarget["kind"] and DestinationProp are the same union, and
        // this is the one place an internal union feeds a wire enum — a 5th
        // OpenTarget kind must fail to compile here, not silently transmit.
        destination: target.kind,
        workspace_mode: cfg.workspaceMode === "per-window" ? "per-window" : "multiroot",
      });
    }

    // "This window" means "work where I already am", so the folders already open here
    // ARE the repo set — asking again would make the choice mean less than it says.
    // Empty only in the race where the window lost its identity after the pick; that
    // falls through to the confirm QuickPick rather than dead-ending the take.
    const openHere = target.kind === "current" ? this.servicesFromExistingDestination(target, repos) : [];

    let services: ServiceRef[];
    let repoSource: RepoSource;
    let inferredCount = 0;
    // Populated only in the QuickPick branch; used below to compare the actual
    // *set* the user confirmed against what was inferred (not just its size —
    // swapping one inferred repo for a different one must not read as "accepted").
    let inferredNames = new Set<string>();
    if (preselected && preselected.length) {
      // Selection already made in the expanded card — resolve names to repos, skip QuickPick.
      repoSource = "preselected";
      const byName = new Map(repos.map((r) => [r.name, r]));
      services = preselected.map((n) => byName.get(n)).filter((r): r is ServiceRef => !!r);
    } else if (target.kind === "existing" || target.kind === "live-folder") {
      // The destination already fixes its repo set — use it as-is, no service pick.
      repoSource = "destination";
      services = this.servicesFromExistingDestination(target, repos);
    } else if (openHere.length) {
      repoSource = "destination";
      services = openHere;
    } else {
      // New window — confirm the repos the task touches (inferred pre-selected).
      repoSource = "quickpick";
      const inferred = inferServices(
        { summary: detail.summary, descriptionText: detail.descriptionText, labels: detail.labels, components: detail.components },
        repos,
      );
      // Only ticket-confirmed repos arrive pre-checked: Enter-through-the-default
      // must not attach a repo the ticket never recorded. The label/text guesses
      // still surface — listed on top with their reason — just unchecked, and the
      // telemetry proposal below is the pre-checked set for the same reason.
      const proposedNames = new Set(confirmedServices(inferred).map((r) => r.service.name));
      const mentioned = new Set(inferred.map((r) => r.service.name));
      inferredNames = proposedNames;
      inferredCount = proposedNames.size;

      // Pre-checked repos first. A QuickPick renders items in the order it's handed
      // them, so on a reposRoot with dozens of repos the inferred ones — the whole
      // point of the step — sit below the fold and read as "nothing was suggested".
      // Stable partition, so discovery order still holds within each group.
      const ordered = [
        ...repos.filter((r) => mentioned.has(r.name)),
        ...repos.filter((r) => !mentioned.has(r.name)),
      ];

      const picks = await vscode.window.showQuickPick<vscode.QuickPickItem & { repo: ServiceRef }>(
        ordered.map((r) => ({
          label: r.name,
          description: mentioned.has(r.name)
            ? `inferred (${inferred.find((i) => i.service.name === r.name)!.reason})`
            : "",
          detail: r.isGit ? r.path : `${r.path}  (not a git repo)`,
          picked: proposedNames.has(r.name),
          repo: r,
        })),
        {
          canPickMany: true,
          title: `${key} — confirm the repos this task touches`,
          placeHolder: "Space to toggle · Enter to confirm",
          ignoreFocusOut: true,
        },
      );
      if (!picks || picks.length === 0) return undefined;
      services = picks.map((p) => p.repo);
    }
    if (services.length === 0) {
      this.toast("error", "No valid repos selected for this task.");
      return undefined;
    }
    if (flow) {
      // Set comparison, not a count comparison: swapping one inferred repo for a
      // different one leaves the count unchanged but is a real rejection of the
      // suggestion. Only meaningful for the QuickPick branch — inference never
      // runs for "preselected"/"destination", so the property is omitted there
      // rather than reporting a misleading `false`.
      const pickedNames = new Set(services.map((s) => s.name));
      const acceptedInference =
        repoSource === "quickpick"
          ? pickedNames.size === inferredNames.size && [...pickedNames].every((n) => inferredNames.has(n))
          : undefined;
      track({
        name: "take_repos_picked",
        flow_id: flow.id,
        repo_count: services.length,
        repo_source: repoSource,
        ...(acceptedInference !== undefined ? { accepted_inference: acceptedInference } : {}),
        inferred_count: inferredCount,
      });
    }
    return { detail, services, target };
  }

  /** Canonical paths the chosen destination already contains — for "current", the folders
   * open in this window right now. A new window contributes nothing. */
  private prefillPathsForTarget(target: OpenTarget): Set<string> {
    if (target.kind === "existing") return new Set(workspaceFolderPaths(target.file));
    if (target.kind === "live-folder") return new Set([canon(target.folder)]);
    // Already canonical (currentWindow canonicalizes its roots), and empty when the
    // window has lost its identity since the destination pick.
    if (target.kind === "current") return new Set(currentWindow()?.roots.map((r) => r.path) ?? []);
    return new Set();
  }

  /** Repos already in an existing / live-folder destination, as ServiceRefs — the set used
   *  when we skip the picker for such destinations. Matches discovered repos by canonical
   *  path where possible; otherwise builds one from the folder path, so workspace folders
   *  outside reposRoot are honored too.
   *
   *  A folder that is one of OUR worktrees is unwound to the repo it belongs to first. Its
   *  basename is a ticket key, so taking it at face value invents a phantom repo — and
   *  because a worktree's `.git` is a pointer FILE, it even passes the isGit check, so the
   *  next createWorktrees would nest a worktree inside that worktree. Deduped by path, so a
   *  workspace declaring both a repo and a worktree of it yields one service. */
  private servicesFromExistingDestination(target: OpenTarget, repos: ServiceRef[]): ServiceRef[] {
    const byPath = new Map(repos.map((r) => [canon(r.path), r]));
    const out = new Map<string, ServiceRef>();
    for (const folder of this.prefillPathsForTarget(target)) {
      // A folder that exists is already canonical (prefillPathsForTarget resolved it), but
      // an unwound root might not — canon() falls back to the raw path when realpathSync
      // throws, exactly what happens for a stale root whose worktree is gone.
      const un = repoRootOfWorktree(folder);
      const p = un ? canon(un) : folder;
      if (out.has(p)) continue;
      out.set(
        p,
        byPath.get(p) ?? { name: path.basename(p), path: p, isGit: fs.existsSync(path.join(p, ".git")) },
      );
    }
    return [...out.values()];
  }

  /** Whether this launch offers Claude Code's Remote Control. Resolved once per launch
   * action. Dismissing the picker means "no", not "cancel": by the time this runs, the
   * destination (and any worktrees) are already settled and the launch is committed —
   * abandoning it over an optional toggle would be the worse failure. */
  private async resolveRemoteControlSetting(cfg: AgentFlowConfig): Promise<boolean> {
    if (cfg.remoteControl === "off") return false;
    // seedAgent off means no plan file ever carries the decision (openWorkspace's guard),
    // so nothing could ever seed /remote-control — asking would promise what can't be kept.
    if (!cfg.seedAgent) return false;
    if (cfg.remoteControl === "on") return true;
    const p = await vscode.window.showQuickPick(
      [
        {
          label: "$(radio-tower) Enable Remote Control",
          detail: "Connect first, then paste the task prompt to start",
          yes: true,
        },
        { label: "$(circle-slash) Local only", detail: "Seed the task prompt as usual", yes: false },
      ],
      { title: "Enable Remote Control for this session?", ignoreFocusOut: true },
    );
    return p?.yes === true;
  }

  /** Remote Control seeds `/remote-control <key>`, a Claude Code slash command neither
   * Copilot nor Cursor has an equivalent for — either would take it as literal prompt
   * text and start a session that silently does the wrong thing. `remoteControl: "on"`
   * under any non-Claude agent is therefore refused, rather than silently dropping one
   * of the two things the user turned on.
   *
   * Refused HERE, at the very top of a launch entry point: this is a settings-only
   * synchronous check, so it lands ahead of every picker, every worktree and every
   * window. Refusing later (which is what the resolveRemoteControl backstop does)
   * would already have created worktrees for a launch that never happens.
   *
   * Only `"on"` is refused. `"ask"` is handled in resolveRemoteControl, which declines
   * to offer a toggle it could not honour and proceeds without Remote Control — a
   * non-Claude user is never blocked from taking a task by an "ask" setting. `"off"`
   * and every Claude Code configuration return false here before anything else is
   * read, so those paths are untouched. This predicate runs on every host, Cursor
   * included: `cfg.agentProvider` reads back `"cursor"` there once it's selected, so
   * this is exactly what fires under it.
   *
   * The `seedAgent` clause mirrors resolveRemoteControlSetting's own precondition
   * above, and has to: with seeding off, no plan file ever carries the decision, so
   * `/remote-control` could never reach a non-Claude agent in the first place and
   * there is nothing to refuse. Without the clause this predicate would be stricter
   * than the resolver it stands in front of, and a non-Claude user with seeding off —
   * who never opted into any of this — would be locked out of every launch. */
  private remoteControlBlocksLaunch(cfg: AgentFlowConfig): boolean {
    // `resolvedProvider`, not a bare `=== "claude-code"`: `ask` is not an agent, and
    // while it is inert seedProvider degrades it to Claude Code — so refusing an `ask`
    // launch here would block a session that WOULD have been Claude Code, and this
    // predicate would contradict the seeding path it stands in front of.
    // TASK 5: once the picker is real the launch resolves its own agent before this
    // runs, and this must test THAT answer rather than degrading the setting.
    if (resolvedProvider(cfg.agentProvider) === "claude-code" || cfg.remoteControl !== "on" || !cfg.seedAgent) {
      return false;
    }
    this.toast("error", RC_NEEDS_CLAUDE);
    return true;
  }

  /** The Remote Control answer for this launch, or null when the launch must not
   * proceed.
   *
   * The null is reached in normal operation, from takeBatch: that is the one launch
   * entry point with no `remoteControlBlocksLaunch` call at the top, because whether
   * it resolves Remote Control at all depends on `shared`, which is not known until
   * after the destination pick. Everywhere else the pre-flight predicate has already
   * refused the pair, so the null is also the backstop that keeps a future entry point
   * added without a pre-flight call from seeding a broken session. */
  private async resolveRemoteControl(cfg: AgentFlowConfig): Promise<boolean | null> {
    // Both tests resolve the setting for the same reason remoteControlBlocksLaunch
    // does: an `ask` agentProvider seeds Claude Code while `ask` is inert, so it must
    // be OFFERED the toggle here, not silently denied one. See that predicate's
    // comment, including its TASK 5 note — this pair moves with it.
    const provider = resolvedProvider(cfg.agentProvider);
    // "ask" under a non-Claude agent: putting up a toggle we could only refuse is a
    // broken offer, so the picker never appears and the launch simply proceeds
    // without it.
    if (provider !== "claude-code" && cfg.remoteControl === "ask") {
      this.log("Remote Control not offered — it needs Claude Code; launching without it");
      return false;
    }
    const on = await this.resolveRemoteControlSetting(cfg);
    if (on && provider !== "claude-code") {
      this.toast("error", RC_NEEDS_CLAUDE);
      return null;
    }
    return on;
  }

  /** Which folders (if any) the user wants added to an existing-workspace destination.
   *  Duplicates are skipped without asking — a folder by that name is already there, so
   *  there is no real question, only noise. Only genuinely new repos prompt.
   *
   *  Never returns undefined: dismissing the prompt means "leave the workspace as-is",
   *  not "abort". By the time this runs the worktrees exist and the launch is committed,
   *  so abandoning it over a folder-list question is the worse failure — the same
   *  reasoning resolveRemoteControlSetting documents. `declined` is true only when a prompt
   *  actually appeared and the answer wasn't yes — never when there was nothing to ask. */
  private async resolveWorkspaceAdditions(
    file: string,
    candidates: MergeCandidate[],
  ): Promise<{ foldersToAdd: { name: string; path: string }[]; skipped: string[]; declined: boolean }> {
    const plan = planWorkspaceMerge(file, candidates);
    // Two batch tasks in one not-yet-added repo both land in `add` under distinct
    // key-qualified labels but share a repoName — dedup here (both this bucket and the
    // display names below) so neither the toast nor the prompt copy repeats a name.
    // `redundant` joins `duplicates`: "already in the workspace" is true of both, so one
    // clause covers them and no new copy is needed.
    const skipped = [
      ...new Set([...plan.duplicates, ...plan.redundant].map((c) => c.repoName)),
    ];
    // ok:false → nothing can be added safely; openWorkspace reports mergeFailed.
    if (!plan.ok || !plan.add.length) return { foldersToAdd: [], skipped, declined: false };

    const names = [...new Set(plan.add.map((c) => c.repoName))].join(", ");
    const short = file.split("/").pop() ?? file;
    const p = await vscode.window.showQuickPick(
      [
        {
          label: `$(add) Add ${names}`,
          detail: `Becomes a folder in ${short}, pointing at this task's worktree`,
          yes: true,
        },
        {
          label: "$(circle-slash) Leave the workspace as-is",
          detail: "Opens in its worktree; the brief uses absolute paths",
          yes: false,
        },
      ],
      {
        title:
          plan.add.length === 1
            ? `Add ${names} to ${short}?`
            : `Add ${plan.add.length} folders to ${short}?`,
        ignoreFocusOut: true,
      },
    );
    if (p?.yes !== true) return { foldersToAdd: [], skipped, declined: true };
    return { foldersToAdd: plan.add.map((c) => ({ name: c.label, path: c.path })), skipped, declined: false };
  }

  /** Toast fragment for a launch that asked for Remote Control and didn't get it —
   * `openWorkspace` withholds it when the launch opens more than one window, and, under
   * `ask`, when the agent picked isn't Claude Code. Without this the user waits for a
   * `/remote-control` prompt that never arrives.
   *
   * `seeded` names the agent that actually ran, so the note can give the reason that
   * applies. Reachable with a non-Claude agent under `ask` alone: a fixed `copilot` or
   * `cursor` setting never gets `wanted` past `resolveRemoteControl`, so the
   * single-window sentence is byte-identical to what those users have always seen. */
  private remoteControlNote(wanted: boolean, applied: boolean, seeded: AgentProvider = "claude-code"): string {
    if (!wanted || applied) return "";
    return seeded === "claude-code"
      ? " Remote Control skipped — it needs a single window."
      : ` Remote Control skipped — it needs Claude Code, and ${providerLabel(seeded)} was picked.`;
  }

  /** Toast fragment announcing the pre-seed, shared by `launch()` and `explore()`. With
   * Remote Control applied, Enter only connects the bridge — the task itself starts on
   * the later paste + Enter — so the plain "press Enter to start" copy would be wrong. */
  private seededNote(
    seedAgent: boolean,
    remoteControl: boolean,
    provider: AgentProvider,
    seededInPlace = false,
  ): string {
    // Seeding into this window with seeding off is the one destination that ends with
    // NOTHING to show: no window opened, no session started, only briefs on disk. Every
    // other destination at least leaves a window behind, so silence reads as success.
    if (!seedAgent) {
      return seededInPlace
        ? " This window is untouched — agentFlow.seedAgent is off, so no session was seeded."
        : "";
    }
    const agent = providerLabel(provider);
    return remoteControl
      ? ` ${agent} pre-seeded with /remote-control — Enter to connect, then paste.`
      : ` ${agent} pre-seeded — press Enter to start.`;
  }

  /** Where a completed open put the session, for the success toast. "This window" is
   *  its own case because nothing was opened — reporting "1 window(s)" would imply one
   *  appeared. With seeding off it opened nothing AND seeded nothing, so even "in this
   *  window" overclaims; seededNote carries the explanation. */
  private openedWhere(
    result: { seededInPlace?: boolean; workspaceFile?: string; opened: string[] },
    seedAgent: boolean,
  ): string {
    if (result.seededInPlace) return seedAgent ? "in this window" : "nothing";
    if (result.workspaceFile) return `workspace ${result.workspaceFile.split("/").pop()}`;
    return `${result.opened.length} window(s)`;
  }

  /** Open + seed a resolved kick-off: worktree decision → workspace mode → brief →
   * openWorkspace → success toast. Shared by Take and Address PR. The destination
   * `target` is resolved earlier in resolveKickoff. `forceWorktree` (Address PR) always
   * isolates in a worktree, ignoring cfg.worktree. Returns whether the launch actually
   * happened — `false` means the caller backed out at one of this function's own
   * pickers (worktree isolation, or workspace-mode when opening a new window with
   * 2+ repos) rather than anything failing; `addressPr` ignores the return value,
   * `takeTask` maps it to `take_completed`'s `outcome`.
   *
   * `onWorktreeDecision` is how the real worktree answer gets back to the caller's
   * analytics. A return value could not carry it: the decision is interesting
   * precisely when what follows *throws* (a failed worktree creation or workspace
   * write), and a throw discards the return value. Called at most once, as soon as
   * the decision is settled and before it is acted on. */
  private async launch(
    detail: TaskDetail,
    services: ServiceRef[],
    promptTemplate: string,
    forceWorktree: boolean,
    target: OpenTarget,
    onWorktreeDecision?: (used: boolean) => void,
    /** Orchestrator-mode extras: the child worktrees this run owns. Absent for every
     *  other caller, which keeps their brief and their run record byte-identical. */
    orchestration?: { children: NonNullable<Run["children"]>; parentBranch: string },
  ): Promise<boolean> {
    const cfg = getConfig();
    const key = detail.key;

    // Isolate in a git worktree?
    let useWorktree: boolean;
    if (forceWorktree || cfg.worktree === "always") useWorktree = true;
    else if (cfg.worktree === "never") useWorktree = false;
    else {
      const p = await vscode.window.showQuickPick(
        [
          { label: "$(git-branch) Work in a git worktree", detail: "Per-task branch + worktree per repo (isolated)", yes: true },
          { label: "$(repo) Work in the repo directly", detail: "No worktree", yes: false },
        ],
        { title: `${key} — isolate this task in a worktree?`, ignoreFocusOut: true },
      );
      // Cancelled: no decision was made, so nothing is reported.
      if (!p) return false;
      useWorktree = p.yes;
    }
    onWorktreeDecision?.(useWorktree);
    if (useWorktree) {
      const made = createWorktrees(services, detail.key, detail.summary, this.log);
      // createWorktrees falls back to the main checkout when it cannot create a
      // worktree. Only the orchestrator path refuses that: its brief instructs the
      // agent to merge every finished child into the parent branch, so a session that
      // landed in the main checkout would check that branch out over whatever the user
      // has open and write merge commits there. engine/orchestrator/launch.ts refuses
      // on this same condition for the same reason.
      //
      // Gated on `orchestration`, NOT on `forceWorktree`: addressPr forces a worktree
      // too, and its behaviour for existing users must stay exactly as it is.
      //
      // Refusing costs nothing already on disk: createWorktrees reuses an existing
      // worktree directory, so a retry adopts the child worktrees this take made.
      if (orchestration) {
        // `base.isGit` matters: createWorktrees returns the ref UNCHANGED for a non-git
        // repo by design ("not a git repo — opening the checkout directly"), which is
        // shaped exactly like its failure return. Without this, a supported mixed repo
        // set would be refused for a failure that never happened.
        const stuck = services.find((base, i) => base.isGit && made[i]?.path === base.path);
        if (stuck) {
          this.toast(
            "error",
            `Couldn't create a git worktree for ${key} in ${stuck.name} — not opening an orchestrator in your main checkout. The Agent Flow Deck output channel has the reason.`,
          );
          return false;
        }
      }
      services = made;
    }

    const args = await this.targetToOpenArgs(target, services.length, key, cfg);
    if (!args) return false;

    // A saved workspace is the user's own artifact — never write it without approval.
    const additions = args.existingWorkspaceFile
      ? await this.resolveWorkspaceAdditions(
          args.existingWorkspaceFile,
          services.map((s) => ({ label: serviceFolderName(detail.key, s), repoName: s.name, path: s.path })),
        )
      : { foldersToAdd: [], skipped: [], declined: false };

    const wantRemoteControl = await this.resolveRemoteControl(cfg);
    // Refused. `false` is this function's "the user backed out at one of my own
    // pickers" answer, which is what a refusal is from the caller's point of view:
    // nothing opened, and take_completed records it as cancelled rather than failed.
    if (wantRemoteControl === null) return false;

    // The Children table is built from the rows that were actually created, never from
    // the leaves that were intended: a subagent dispatched at a worktree that is not
    // there would land in whatever the path resolves to instead.
    const planMd = briefMarkdown(
      detail,
      providerLabel(resolvedProvider(cfg.agentProvider)),
      orchestration?.children.length
        ? {
            children: orchestration.children.map((c) => ({
              key: c.key, summary: c.summary, path: c.path, branch: c.branch,
            })),
            // Observed for the same reason each child row's branch is, and observable
            // only here: `services` has just been replaced by createWorktrees' answer
            // (above), which is the first point at which the parent's actual worktree
            // exists. A reused parent worktree sits on whatever branch it was already
            // on, so the computed name would tell the orchestrator to merge every
            // finished child into a branch nothing is on. The first git service answers
            // — createWorktrees puts every repo on one branch per key — and the computed
            // name stands in when git cannot say.
            parentBranch: this.observedParentBranch(services, orchestration.parentBranch),
          }
        : undefined,
    );
    const result = await openWorkspace({
      ticket: { key: detail.key, summary: detail.summary, url: detail.url },
      planMd,
      descriptionText: detail.descriptionText,
      services,
      mode: args.mode,
      promptTemplate,
      workspaceDir: cfg.workspaceDir,
      seedAgent: cfg.seedAgent,
      openIn: args.openIn,
      existingWorkspaceFile: args.existingWorkspaceFile,
      existingFolder: args.existingFolder,
      currentWindow: args.currentWindow,
      foldersToAdd: additions.foldersToAdd,
      remoteControl: wantRemoteControl,
      // Absent rather than empty for every non-orchestrator caller: a run record with
      // no children has to look exactly as it did before children existed.
      ...(orchestration?.children.length ? { children: orchestration.children } : {}),
    });
    // Dismissed at the agent picker — one of this function's own pickers, as far as the
    // caller is concerned, so it gets this function's own "the user backed out" answer:
    // `takeTask` records take_completed as cancelled rather than launched, and nothing
    // is toasted. Nothing was opened, written or seeded either.
    if (result.cancelled) return false;

    const where = this.openedWhere(result, cfg.seedAgent);
    const seeded = this.seededNote(cfg.seedAgent, result.remoteControl, result.provider, result.seededInPlace);
    const rcNote = this.remoteControlNote(wantRemoteControl, result.remoteControl, result.provider);
    if (result.mergeFailed) {
      this.toast(
        "info",
        `Opened ${where} for ${key}, but its folders couldn't be parsed — repos weren't added. Brief seeded in each repo.${seeded}${rcNote}`,
      );
    } else {
      const added = result.mergedRepos?.length ? ` Added ${result.mergedRepos.join(", ")}.` : "";
      const skipped = additions.skipped.length
        ? ` ${additions.skipped.join(", ")} already in the workspace — not added as folders.`
        : "";
      const unadded = result.unaddedRepos?.length
        ? ` ${result.unaddedRepos.join(", ")} couldn't be added as roots to that window — their briefs are still in place.`
        : "";
      // Confirming the file was left alone is the point of asking — without this, a
      // decline reads identically to there being nothing new to offer.
      const declined =
        additions.declined && result.workspaceFile ? ` Left ${result.workspaceFile.split("/").pop()} unchanged.` : "";
      this.toast("success", `Opened ${where} for ${key}. Brief seeded in each repo.${added}${skipped}${unadded}${declined}${seeded}${rcNote}`);
    }
    return true;
  }

  /** The branch the parent's worktree is ACTUALLY on, for the brief's "merge finished
   *  children into X". The first git service answers for the set: createWorktrees puts
   *  every repo of one key on one branch, and a non-git repo has no branch to read.
   *  `computed` — `branchName(key, summary)` — stands in when git cannot answer, which
   *  is what this line named unconditionally before. */
  private observedParentBranch(services: ServiceRef[], computed: string): string {
    const git = services.find((s) => s.isGit);
    return (git && currentBranch(git.path)) || computed;
  }

  /** Resolve the task prompt mode: the configured `taskMode` when it names a known
   * mode, otherwise a QuickPick. Returns undefined only when the picker is cancelled. */
  private async choosePromptMode(cfg: AgentFlowConfig, title: string): Promise<PromptMode | undefined> {
    const modes = cfg.promptModes;
    const configured = modes.find((m) => m.id === cfg.taskMode);
    if (configured) return configured;
    const p = await vscode.window.showQuickPick(
      modes.map((mm) => ({
        label: mm.label,
        detail: mm.detail,
        mode: mm,
      })),
      { title, ignoreFocusOut: true },
    );
    return p?.mode;
  }

  /** The pick flow: prompt mode → read ticket → destination → confirm services → open + seed.
   * `preselected` (from the in-card selection) skips the service QuickPick.
   *
   * `source` is supplied by the caller that knows how the Take was started — the
   * webview dispatcher for a Deck card, the `agentFlow.takeTask` command for the
   * palette. It is deliberately not inferred from `preselected`: a one-click Take
   * from a collapsed card sends no selection and is still a card Take. */
  public async takeTask(key: string, source: TakeSource, preselected?: string[]): Promise<void> {
    // Synchronous, ahead of every await: a second Take for a key already being
    // taken is a duplicate gesture, not a second intent — ignore it rather than
    // open a second window and a second set of worktrees for one ticket.
    if (this.takesInFlight.has(key)) {
      this.log(`take ${key}: already in flight — ignoring the duplicate`);
      return;
    }
    this.takesInFlight.add(key);
    try {
      await this.takeTaskGuarded(key, source, preselected);
    } finally {
      this.takesInFlight.delete(key);
    }
  }

  private async takeTaskGuarded(key: string, source: TakeSource, preselected?: string[]): Promise<void> {
    const cfg = getConfig();
    // Ahead of take_started deliberately: the take never begins, so the funnel gets
    // neither a start nor a terminator rather than a phantom "cancelled".
    if (this.remoteControlBlocksLaunch(cfg)) return;

    // A ticket with children is a different question from a ticket without them, and it
    // has to be asked before anything else: fan-out hands the whole take to takeBatch,
    // which asks its own prompt-mode and destination questions.
    //
    // Ahead of take_started for the same reason the guard above is, though for the
    // opposite cause: takeBatch emits no telemetry at all — it is deliberately
    // uninstrumented in Phase 1, which is why `"batch"` sits reserved-but-unused in the
    // TakeSource union (see telemetry/events.ts). So a take that becomes a fan-out must
    // get neither a start nor a terminator; emitting take_started here would open a
    // funnel nothing ever closes. The consequence is real and intended: fan-out takes
    // are absent from the Take funnel entirely, and instrumenting takeBatch is its own
    // piece of work, not this one.
    //
    // Both pickers also resolve before any git write: cancelling either leaves nothing
    // on disk.
    const probed = await this.probeTree(key);
    if (probed?.tree.leaves.length) {
      const mode = await this.chooseTreeMode(key, probed.tree.leaves.length);
      if (!mode) return;
      if (mode !== "parent") {
        const picked = await this.chooseLeaves(probed.tree);
        if (!picked) return;
        // Ticking nothing is "just the parent" said the long way round — fall through
        // to the ordinary take rather than launching an empty fan-out.
        if (picked.length) {
          const parent = { key, branch: branchName(key, probed.detail.summary) };
          if (mode === "fanout") {
            const leafKeys = picked.map((l) => l.key);
            const repos = this.fanOutRepos(cfg, probed.detail, preselected);
            // Said out loud before any worktree exists: a child whose own ticket infers
            // no repo lands in every repo of this set, so when the worktree count
            // surprises someone the set that produced it has to be findable.
            this.log(
              `fan-out ${key}: ${leafKeys.length} ${leafKeys.length === 1 ? "leaf" : "leaves"} into ${repos.length} repo(s) — ${repos.join(", ")}`,
            );
            await this.takeBatch(leafKeys, repos, parent);
          } else {
            // `preselected` rides along for the same reason the fan-out passes it to
            // fanOutRepos: it is the only repo intent the user has expressed on this
            // take, and re-asking for it would make this flow ask three questions
            // where the other mode reached from the same picker asks two.
            await this.takeOrchestrated(probed.detail, picked, parent.branch, preselected);
          }
          return;
        }
      }
    }

    const flow = startFlow();
    const taskFp = fingerprint(key);
    let destination: DestinationProp | undefined;
    let repoCount = 0;
    let promptModeProp: PromptModeProp = "custom";
    // Set only once launch() has settled the worktree question; stays undefined for
    // a Take that ends before then, so take_completed omits the property rather
    // than reporting a decision nobody made.
    let usedWorktree: boolean | undefined;
    const worktreeProp = () => (usedWorktree === undefined ? {} : { used_worktree: usedWorktree });

    track({ name: "take_started", flow_id: flow.id, source, task_fp: taskFp, inferred_count: 0 });

    // Everything after take_started runs inside this try, so the funnel always gets
    // its terminator: a Jira read failing inside resolveKickoff is a *failure*, and
    // without this it looked identical to the user walking away. operation_failed is
    // no substitute — it carries no flow_id, so the Take can't be reconstructed.
    try {
      // How should the session start — pick a prompt mode (or use the configured default) FIRST.
      const promptMode = await this.choosePromptMode(cfg, `${key} — how should the session start?`);
      if (!promptMode) {
        track({ name: "take_completed", flow_id: flow.id, outcome: "cancelled", prompt_mode: promptModeProp, repo_count: 0, duration_ms: flow.elapsedMs(), task_fp: taskFp });
        return;
      }
      promptModeProp = toPromptModeProp(promptMode.id);
      track({ name: "take_prompt_mode_picked", flow_id: flow.id, prompt_mode: promptModeProp, is_custom_mode: promptModeProp === "custom" });

      const resolved = await this.resolveKickoff(key, preselected, flow);
      if (!resolved) {
        track({ name: "take_completed", flow_id: flow.id, outcome: "cancelled", destination, prompt_mode: promptModeProp, repo_count: repoCount, duration_ms: flow.elapsedMs(), task_fp: taskFp });
        return;
      }
      const { detail, services, target } = resolved;
      // No cast: OpenTarget["kind"] is DestinationProp, and keeping it
      // compiler-checked is the point (see take_destination_picked above).
      destination = target.kind;
      repoCount = services.length;

      const launched = await this.launch(detail, services, promptMode.prompt, false, target, (used) => {
        usedWorktree = used;
      });
      track({ name: "take_completed", flow_id: flow.id, outcome: launched ? "launched" : "cancelled", destination, prompt_mode: promptModeProp, repo_count: repoCount, duration_ms: flow.elapsedMs(), ...worktreeProp(), task_fp: taskFp });
    } catch (e) {
      track({ name: "take_completed", flow_id: flow.id, outcome: "failed", destination, prompt_mode: promptModeProp, repo_count: repoCount, duration_ms: flow.elapsedMs(), ...worktreeProp(), failure_class: classifyFailure(e), task_fp: taskFp });
      // A palette Take has no webview dispatcher above it — extension.ts registers
      // the command as a bare handler, so for source "command" the rethrow below
      // surfaces only VS Code's generic "command failed" notification: no toast,
      // no output-channel line, no re-gate. Give it the same user-facing handling
      // the card path's dispatcher applies — the sign-in gate for a dead
      // credential, a toast for everything else — before the error propagates.
      if (source === "command") {
        const msg = e instanceof Error ? e.message : String(e);
        this.log(`take ${key}: failed — ${msg}`);
        if (e instanceof TaskAuthError) {
          this.postState(false, this.connector.isConfigured(), null);
        } else {
          this.toast("error", msg);
        }
      }
      throw e; // onMessage's existing catch (tasksView.ts:255) still owns the card path's user-facing handling.
    }
  }

  /** Launch several tasks at once, each in its own git worktree with its own seeded
   * Claude session. The prompt mode, destination and layout are asked once and applied
   * to all; one task's failure never aborts the rest. Each task opens worktrees in the
   * repos it's inferred to touch, narrowed to the filtered set.
   *
   * `parent` turns the batch into a fan-out under one ticket: every child branches off
   * the parent's branch instead of the checkout's HEAD, and carries `parentKey` onto
   * its run record. Omitting it must leave every existing caller's behaviour
   * byte-identical — no `ensureBranch` call, no `baseRef`, no `parentKey`. */
  public async takeBatch(
    keys: string[],
    repos: string[],
    parent?: { key: string; branch: string },
  ): Promise<void> {
    const cfg = getConfig();
    if (!keys.length) return;

    if (!(await this.connector.isAuthenticated())) {
      const ok = await vscode.commands.executeCommand<boolean>("agentFlow.signIn");
      if (!ok) return;
    }

    const filterSet = this.resolveBatchRepos(repos, cfg);
    if (!filterSet.length) return;

    // A fan-out authorises WORKTREES, not keys: `reposForTask` widens to the whole filter
    // set for a child whose ticket infers nothing, so 3 leaves across 12 repos is 36
    // worktrees and 36 `git worktree add` calls with no confirmation at all under a
    // key-only comparison. `keys.length * filterSet.length` is the upper bound — a child
    // that DOES infer repos opens fewer — and an upper bound is the right thing to ask
    // about before the first one exists.
    //
    // Only for the parented case. The unparented batch path is a set of tickets the user
    // picked one by one, and its threshold has meant "tasks" since it shipped; changing
    // that would re-prompt existing users who changed nothing.
    // A real batch resolves its agent HERE — before the confirmation below, which
    // counts the sessions it is about to start and therefore has to name them ("That's
    // 3 Cursor sessions"). Under the three fixed settings this is a plain read and no
    // picker appears; under `ask` it is one question, asked once, whose answer is then
    // pinned onto every task so the loop never asks again. Nothing has been created at
    // this point, so a dismissal costs nothing: dismissing a launch-wide question
    // abandons the whole batch, which is the only thing it can mean.
    //
    // A ONE-key batch deliberately does not resolve here. It is a single launch —
    // `openWorkspace` asks for it inside the loop at exactly the moment a Take does,
    // and the loop honours the answer — with one exception picked up once the
    // destination is known (see the `shared` re-resolution below).
    const isBatch = keys.length > 1;
    let batchProvider = isBatch ? await resolveBatchProvider(cfg, true) : undefined;
    if (isBatch && !batchProvider) return;
    // The agent for copy written BEFORE the launch: the resolved answer when there is
    // one, and otherwise the setting's own — a single launch resolves inside
    // `openWorkspace`, after this copy has already been written.
    const namedProvider = () => providerLabel(batchProvider ?? resolvedProvider(cfg.agentProvider));

    const authorising = parent ? keys.length * filterSet.length : keys.length;
    if (authorising > cfg.batchLaunchConfirmThreshold) {
      const go = await vscode.window.showWarningMessage(
        parent
          ? `Launch ${keys.length} tasks in parallel? That's ${keys.length} ${namedProvider()} sessions and up to ${authorising} git worktrees across ${filterSet.length} repo${filterSet.length === 1 ? "" : "s"}.`
          : `Launch ${keys.length} tasks in parallel? That's ${keys.length} ${namedProvider()} sessions.`,
        { modal: true },
        "Launch",
      );
      if (go !== "Launch") return;
    }

    const promptMode = await this.choosePromptMode(cfg, `Launch ${keys.length} selected task(s) — how should the sessions start?`);
    if (!promptMode) return;

    const target = await this.chooseOpenTarget(cfg);
    if (!target) return;

    // Only a new window can go either way; the other destinations ARE a single window.
    // A one-key batch is an ordinary single-window launch, so it needs no layout pick.
    let shared = target.kind !== "new";
    if (target.kind === "new" && keys.length > 1) {
      const p = await vscode.window.showQuickPick(
        [
          { label: "$(multiple-windows) Separate windows", detail: "One window per task", shared: false },
          { label: "$(window) One shared window", detail: `All ${keys.length} tasks in one window, a session each`, shared: true },
        ],
        { title: `Launch ${keys.length} tasks — how should I lay them out?`, ignoreFocusOut: true },
      );
      if (!p) return;
      shared = p.shared;
    }

    // One clipboard can't serve several sessions — but a one-key "batch" is a single
    // launch, so it resolves Remote Control exactly like Take does. A shared window
    // seeds every session straight from its own plan file rather than a clipboard
    // paste, so it can't carry the answer either — don't even ask when shared.
    const rcSkipped = isBatch && cfg.remoteControl !== "off";
    if (rcSkipped) this.log("takeBatch: Remote Control skipped — one clipboard, several sessions");
    const wantRemoteControl = isBatch || shared ? false : await this.resolveRemoteControl(cfg);
    // Refused. This is the ONE launch entry point with no `remoteControlBlocksLaunch`
    // call at the top, and deliberately so: a real batch, and a one-key batch to a
    // shared destination, never resolve Remote Control at all, so a blanket refusal
    // would block Copilot launches that work fine today. Refusing here instead costs
    // nothing — the worktree loop below has not run yet, so there is still no side
    // effect to leave behind.
    if (wantRemoteControl === null) return;

    // The shared path seeds every session from a plan file and never calls
    // `openWorkspace` at all, so nothing downstream of here can ask: a one-key batch
    // that lands there has to resolve now, or seed an agent nobody picked. A real batch
    // already resolved above, before its confirmation. Still before the first worktree,
    // so a dismissal here costs nothing either.
    if (shared && !batchProvider) {
      batchProvider = await resolveBatchProvider(cfg, isBatch);
      if (!batchProvider) return;
    }

    const resolved: { task: BatchTask; key: string }[] = [];
    const failed: string[] = [];
    for (const key of keys) {
      try {
        const detail = await this.provider().detail(key);
        const wanted = this.reposForTask(detail, filterSet);
        // A child branches off its parent's branch, so that branch has to exist first —
        // in every repo this child is about to open, before any worktree is made there.
        // ensureBranch is idempotent, so children sharing a repo cost one rev-parse
        // each. A repo where it cannot be made fails this child rather than letting it
        // branch off main, which would look identical to a correct worktree until the
        // merge.
        if (parent) {
          const noBranch = wanted.filter((r) => !ensureBranch(r.path, parent.branch));
          if (noBranch.length) {
            throw new Error(
              `couldn't create the parent branch ${parent.branch} in ${noBranch.map((r) => r.name).join(", ")}`,
            );
          }
        }
        const services = createWorktrees(
          wanted,
          detail.key,
          detail.summary,
          this.log,
          parent ? { baseRef: parent.branch } : {},
        );
        // A worktree is mandatory: two tasks sharing a checkout would clobber each
        // other's brief. createWorktrees returns the original ref when `git worktree
        // add` fails — detect that and fail the task rather than launch into a collision.
        // Name the repos: a task spans several now, and this message is all the user gets
        // in the summary toast, so without them there's nothing to go and fix.
        const collided = services.filter((s, i) => s.path === wanted[i].path).map((s) => s.name);
        if (collided.length) {
          throw new Error(
            `couldn't create a git worktree in ${collided.join(", ")} (would collide with the shared checkout)`,
          );
        }
        resolved.push({
          key,
          task: {
            ticket: { key: detail.key, summary: detail.summary, url: detail.url },
            // `namedProvider()`, not a bare read of the setting: when the batch has
            // resolved its own answer, this is one pre-launch copy site that can name
            // the agent that will actually read the brief.
            planMd: briefMarkdown(detail, namedProvider()),
            descriptionText: detail.descriptionText,
            services,
            ...(parent ? { parentKey: parent.key } : {}),
          },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failed.push(`${key} (${msg})`);
        this.log(`takeBatch ${key}: failed — ${msg}`);
      }
    }

    let launched = 0;
    let extra = "";
    let seededInPlace = false;
    // Set by the per-window loop below from the one place the truth lives — see the
    // assignment's own comment. `undefined` until a launch reports one, at which point
    // the summary copy falls back to `namedProvider()`.
    let seededProvider: AgentProvider | undefined;
    // The user dismissed `openWorkspace`'s own agent picker. Only the one-key,
    // own-window shape can get here — every other shape resolved the agent up front and
    // pinned it, which is exactly what stops that picker from ever being raised — but
    // this loop does not get to assume that, because it is the thing that counts the
    // launches it claims in the summary toast.
    let dismissed = false;
    if (shared && resolved.length) {
      try {
        // This window can lose its identity between the destination pick and here: the
        // prompt-mode pick, the layout pick and createWorktrees for every task all run
        // in between. openSharedWorkspace has no "current" destination without it and
        // would fall through to the new-window path, spawning a window nobody asked for
        // — so fail the batch the way the catch below does. A single take cancels at the
        // same point, for the same reason.
        const here = target.kind === "current" ? currentWindow() : undefined;
        if (target.kind === "current" && !here) throw new Error("this window can no longer hold a session");

        // Same guarantee as a single take: the workspace file is the user's artifact.
        const additions =
          target.kind === "existing"
            ? await this.resolveWorkspaceAdditions(
                target.file,
                resolved.flatMap((r) =>
                  r.task.services.map((s) => ({
                    label: folderName(r.task.ticket.key, s.name),
                    repoName: s.name,
                    path: s.path,
                  })),
                ),
              )
            : { foldersToAdd: [], skipped: [], declined: false };

        const result = await openSharedWorkspace({
          tasks: resolved.map((r) => r.task),
          promptTemplate: promptMode.prompt,
          workspaceDir: cfg.workspaceDir,
          seedAgent: cfg.seedAgent,
          // OpenTarget and SharedTarget are the same four shapes — no cast needed.
          target,
          // The shared-window batch needs the same "here" the single take does.
          currentWindow: here,
          foldersToAdd: additions.foldersToAdd,
          ...(batchProvider ? providerPin(cfg, batchProvider) : {}),
        });
        launched = resolved.length;
        seededInPlace = !!result.seededInPlace;
        if (result.mergeFailed) extra = " That workspace's folders couldn't be parsed — the worktrees weren't added.";
        else if (result.unaddedFolders?.length) {
          extra = ` ${result.unaddedFolders.join(", ")} couldn't be added as roots to that window — the briefs are still in place.`;
        }
        if (additions.skipped.length) {
          // Already deduped inside resolveWorkspaceAdditions — nothing to dedup again here.
          extra += ` ${additions.skipped.join(", ")} already in the workspace — the worktrees weren't added as folders.`;
        }
        if (additions.declined && result.workspaceFile) {
          extra += ` Left ${result.workspaceFile.split("/").pop()} unchanged.`;
        }
        // A shared window seeds every session straight from its plan file — there's no
        // single clipboard paste for Remote Control to attach to, even for one task.
        if (!isBatch && cfg.remoteControl !== "off") {
          extra += " Remote Control skipped — a shared window seeds each session from its own plan file.";
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        for (const r of resolved) failed.push(`${r.key} (${msg})`);
        this.log(`takeBatch: shared window failed — ${msg}`);
      }
    } else {
      let appliedRemoteControl = false;
      for (let i = 0; i < resolved.length; i++) {
        const { key, task } = resolved[i];
        try {
          const result = await openWorkspace({
            ticket: task.ticket,
            planMd: task.planMd,
            descriptionText: task.descriptionText,
            services: task.services,
            // A batched task can span repos now (reposForTask keeps every filtered repo
            // when inference finds none), and this layout promised one window per TASK —
            // so the layout is per task's repo count, the same call chooseWorkspaceMode
            // makes for a single Take. Fixing it to "per-window" would open one window,
            // worktree and agent per repo, several of them unaware of each other on the
            // same ticket. The loop stays non-interactive, so the "ask" setting can't be
            // honoured here; it means "one window for a multi-repo task", like "auto".
            mode: task.services.length === 1 || cfg.workspaceMode === "per-window" ? "per-window" : "multiroot",
            promptTemplate: promptMode.prompt,
            workspaceDir: cfg.workspaceDir,
            seedAgent: cfg.seedAgent,
            openIn: "new",
            remoteControl: wantRemoteControl,
            // Spread rather than `parentKey: parent?.key`, so a parentless batch sends
            // the request it always sent — the run record has one representation of
            // "no parent", and that is the field's absence (see Run.parentKey).
            ...(parent ? { parentKey: parent.key } : {}),
            ...(batchProvider ? providerPin(cfg, batchProvider) : {}),
          });
          // Cancelled: nothing was opened, written or seeded for this task, so it is
          // neither launched nor failed — a dismissal is the user's own decision, not
          // something that went wrong, and counting it would put a window in the
          // summary toast that does not exist.
          //
          // It abandons the REST of the batch rather than skipping one task: the agent
          // is a launch-wide question, and re-asking it for task i+1 is precisely the
          // N-pickers-for-one-click this path resolves up front to avoid. Same answer
          // the up-front resolution gives to the same gesture.
          if (result.cancelled) {
            dismissed = true;
            break;
          }
          appliedRemoteControl = result.remoteControl;
          // The agent `openWorkspace` actually seeded. Only load-bearing for a ONE-key
          // batch under `ask`, which has no up-front answer — `openWorkspace` raised
          // the picker inside this call, so its result is the only record of that
          // choice. The shared branch above needs no equivalent: both routes into it
          // resolve `batchProvider` before the first worktree.
          seededProvider = result.provider;
          launched++;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          failed.push(`${key} (${msg})`);
          this.log(`takeBatch ${key}: failed — ${msg}`);
        }
        if (i < resolved.length - 1) await delay(BATCH_STAGGER_MS);
      }
      if (!isBatch) extra += this.remoteControlNote(wantRemoteControl, appliedRemoteControl, seededProvider);
    }

    // Dismissed before anything opened: report exactly as a cancelled single launch
    // does — silently. `launched > 0` means earlier tasks really did open, and those
    // are still worth reporting, so the summary below runs and its "N of M" count tells
    // the truth about the ones that were abandoned.
    if (dismissed && launched === 0) return;

    // A batch seeded into this window opened nothing — "in one shared window" would
    // imply one appeared.
    const where = !shared ? "in parallel" : seededInPlace ? "in this window" : "in one shared window";
    const summary = `Launched ${launched} of ${keys.length} ${where}.`;
    const rcNote = isBatch && rcSkipped ? " Remote Control skipped — one clipboard can't serve several sessions." : "";
    if (failed.length) {
      const shown = failed.slice(0, 5).join("; ");
      const more = failed.length > 5 ? ` (and ${failed.length - 5} more)` : "";
      this.toast("error", `${summary} Failed: ${shown}${more}${extra}${rcNote}`);
    } else {
      // Claude Code gets a live session per task either way. Copilot's chat panel is
      // single-instance, so seedCopilotPanel refuses to seed more than one session into
      // the SAME window (see that function's comment) — but that only bites a shared
      // window on the extension surface, and only when there's actually more than one
      // task sharing it. Separate windows each get their own panel (runSeedPass there
      // only ever sees that one window's plan), the terminal surface seeds via a real
      // terminal per task regardless of `multi`, and a one-key "batch" landing in a
      // shared window is really a single-task launch — runSeedPass sees just its own
      // plan there too. All three still get a live session per task; only a real
      // multi-task batch sharing a window on the extension surface actually can't.
      //
      // The else-arm is deliberately keyed on `cursor`/`ask` rather than on "not
      // claude-code": those two values are new on this branch, and everything else —
      // `claude-code` and any unrecognized value that degrades to it — must keep the
      // exact string it has always had.
      //
      // `batchProvider` first: when the launch resolved an answer up front it was
      // pinned onto every task, so that IS what every window seeded. Only a one-key
      // batch to its own window leaves it unset, and there `seededProvider` — the
      // answer `openWorkspace` reached inside the loop — is the only record of the
      // choice. `resolvedProvider` is the floor for a launch that reported neither.
      const perTaskNote =
        cfg.agentProvider === "copilot"
          ? isBatch && shared && cfg.agentSurface !== "terminal"
            ? `A worktree + brief per task — ${providerLabel(cfg.agentProvider)} isn't seeded for a batch; open each brief to start it.`
            : `A worktree + ${providerLabel(cfg.agentProvider)} session per task.`
          : cfg.agentProvider === "cursor" || cfg.agentProvider === "codex" || cfg.agentProvider === "ask"
            ? `A worktree + ${providerLabel(batchProvider ?? seededProvider ?? resolvedProvider(cfg.agentProvider))} session per task.`
            : "A worktree + Claude session per task.";
      this.toast("success", `${summary} ${perTaskNote}${extra}${rcNote}`);
    }
  }



  /** The filtered repo names as git ServiceRefs. Names that don't resolve, and repos
   * that aren't git, are dropped with a note rather than aborting the batch — with
   * several repos filtered, one bad entry shouldn't block the others. Returns [] (and
   * has already toasted) when nothing usable remains. */
  private resolveBatchRepos(names: string[], cfg: AgentFlowConfig): ServiceRef[] {
    const discovered = discoverRepos(cfg.reposRoot, cfg.repoBlocklist);
    const byName = new Map(discovered.map((r) => [r.name, r]));
    const missing = names.filter((n) => !byName.has(n));
    const found = names.map((n) => byName.get(n)).filter((r): r is ServiceRef => !!r);
    const nonGit = found.filter((r) => !r.isGit).map((r) => r.name);
    const usable = found.filter((r) => r.isGit);

    if (!usable.length) {
      // `names` can be empty — a fan-out whose repo set was already filtered to git repos
      // hands one in when `reposRoot` holds none — and "No git repo among  under /repos"
      // reads as a bug in the sentence rather than a fact about the machine.
      this.toast(
        "error",
        names.length
          ? `No git repo among ${names.join(", ")} under ${cfg.reposRoot}. Each task opens a worktree.`
          : `No git repo under ${cfg.reposRoot}. Each task opens a worktree.`,
      );
      return [];
    }
    if (missing.length) this.toast("info", `Skipping ${missing.join(", ")} — not found under ${cfg.reposRoot}.`);
    if (nonGit.length) this.toast("info", `Skipping ${nonGit.join(", ")} — not a git repo, and each task opens a worktree.`);
    return usable;
  }

  /** The repos a batched task opens: its inferred repos narrowed to the filtered set,
   * falling back to the whole set when inference finds nothing there — a task must
   * never launch with no repo at all. */
  private reposForTask(detail: TaskDetail, filterSet: ServiceRef[]): ServiceRef[] {
    // Same rule as a single take: ticket-confirmed repos only, guesses as fallback —
    // a batch must not open a worktree the ticket never recorded.
    const inferred = new Set(
      confirmedServices(
        inferServices(
          { summary: detail.summary, descriptionText: detail.descriptionText, labels: detail.labels, components: detail.components },
          filterSet,
        ),
      ).map((r) => r.service.name),
    );
    const narrowed = filterSet.filter((r) => inferred.has(r.name));
    return narrowed.length ? narrowed : filterSet;
  }

  /** The leaves under `key`, with the detail the probe already had to fetch.
   *
   *  `null` means "behave exactly as Take did before trees existed": this source has no
   *  children concept, or the probe failed. Never throws and never blocks the take — a
   *  tree is an offer, and the ticket must stay takeable when the offer cannot be made.
   *  The `detail` comes back because the parent's branch name needs its summary; the
   *  ordinary path fetches its own again, which is one extra read on a path that is
   *  already several. */
  private async probeTree(key: string): Promise<{ detail: TaskDetail; tree: TreeResult } | null> {
    // The whole feature's off switch, and deliberately the FIRST thing here: every
    // picker, every git write and the extra ticket read are downstream of this method,
    // so returning here is what makes "off" mean byte-identical, not merely quieter.
    if (!getConfig().childWorktrees) return null;
    const children = this.provider().caps.children;
    if (!children) return null;
    try {
      const detail = await this.provider().detail(key);
      // Cancellable, and the walk actually consults the token: a wide tree is hundreds of
      // sequential reads, and before this the only way out of the wait was to keep
      // waiting. A cancel returns null, which every caller already treats as "take the
      // ticket on its own" — the same degradation an unreadable tree gets.
      //
      // Notification rather than this view's own progress bar — the one place in this
      // file that does not follow `resolveKickoff`'s viewId location — because VS Code
      // renders a cancel button ONLY for a notification. `cancellable: true` on a
      // view-located progress is accepted and then ignored, which would have made this
      // fix inert for exactly the user it is for.
      let cancelled = false;
      const tree = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Looking for work under ${key}…`, cancellable: true },
        (_p, token) =>
          buildTree(key, (k) => children.of(k), {
            // Latched: once cancelled the walk must stay cancelled, and the flag has to
            // outlive the token for the check below.
            cancelled: () => {
              cancelled ||= token.isCancellationRequested;
              return cancelled;
            },
          }),
      );
      if (cancelled) {
        this.log(`probeTree ${key}: cancelled — taking the ticket on its own`);
        return null;
      }
      // Reported here rather than at the routing block, because every one of the four
      // ways a take can continue from here drops the same leaves: a cancelled picker,
      // "just the parent", a fan-out, and the plain take that runs when nothing was
      // readable. Nothing is ever omitted silently, so the keys are named and not just
      // counted.
      if (tree.dropped.length) {
        // Deduped for the log: buildTree reports one entry per sighting, so a key whose
        // own fetch failed AND which the cap then cut appeared twice, inflating the count
        // and naming itself twice. The engine's answer is left as it is — the duplication
        // is meaningful there, just not in a diagnostic listing keys.
        const dropped = [...new Set(tree.dropped)];
        this.log(`probeTree ${key}: tree dropped ${dropped.length} (${dropped.join(", ")})`);
        // Leaves empty with omissions recorded means the root's own children could not
        // be read (buildTree keeps an unreadable *child* as a leaf — the work is still
        // real — and exempts only the root). The take degrades to the ordinary one, and
        // saying so is the same "degrade, but out loud" contract the catch below
        // follows for a total failure.
        if (!tree.leaves.length) {
          this.toast("info", `Couldn't read the work under ${key} — taking the ticket on its own.`);
        }
      }
      return { detail, tree };
    } catch (e) {
      this.log(`probeTree ${key}: failed (${e}) — taking the ticket on its own`);
      return null;
    }
  }

  /** How to work the leaves. `undefined` is a cancel; "parent" is today's behaviour,
   *  and doubles as the integrate-later path once the children have landed. */
  private async chooseTreeMode(
    key: string,
    leafCount: number,
  ): Promise<"fanout" | "orchestrator" | "parent" | undefined> {
    const p = await vscode.window.showQuickPick(
      [
        {
          label: "A session per child",
          detail: `${leafCount} worktree${leafCount === 1 ? "" : "s"}, ${leafCount} session${leafCount === 1 ? "" : "s"}, each on its own branch`,
          mode: "fanout" as const,
        },
        {
          label: "One orchestrator session, children as subagents",
          detail: `1 session in ${key}, ${leafCount} child worktree${leafCount === 1 ? "" : "s"} for it to dispatch into`,
          mode: "orchestrator" as const,
        },
        {
          label: `Just ${key}`,
          detail: "One worktree for the parent, as before",
          mode: "parent" as const,
        },
      ],
      {
        title: `${key} — ${leafCount} ${leafCount === 1 ? "leaf" : "leaves"} under it. How do you want to work them?`,
        ignoreFocusOut: true,
      },
    );
    return p?.mode;
  }

  /** Which leaves to take. Nothing is pre-picked: a tree can be large, and every ticked
   *  row costs a worktree and a session. `undefined` is a cancel; an empty array is a
   *  deliberate "none of them", which the caller treats as "just the parent".
   *
   *  The title carries the omissions, because truncation is a fact about the list on
   *  screen: a toast would arrive after the user had already chosen from a list that
   *  looked complete. */
  private async chooseLeaves(tree: TreeResult): Promise<TreeLeaf[] | undefined> {
    // `dropped` and `leaves` are NOT disjoint: buildTree keeps an unreadable node as a
    // leaf (it is still real work) while also reporting it, because what was dropped
    // there is that node's SUBTREE, not the node. Counting the raw sum would claim a
    // hidden item that is sitting visibly in the list below — so only the dropped keys
    // that are nowhere in the list count as not shown.
    // Deduped against itself first: a key can land in `dropped` twice — its own fetch
    // failed AND the cap later cut it — which inflated "not shown" by one and named the
    // same key twice.
    const hidden = [...new Set(tree.dropped)].filter((k) => !tree.leaves.some((l) => l.key === k)).length;
    const shortfall = hidden
      ? ` (${tree.leaves.length} of ${tree.leaves.length + hidden} — ${hidden} not shown)`
      : "";
    const taken = this.alreadyTakenKeys();
    const picked = await vscode.window.showQuickPick(
      tree.leaves.map((l) => ({
        label: `${l.key} — ${l.summary}`,
        // Both facts when both hold: "done" is the ticket's status, "already taken" is
        // this machine's. Neither blocks the row — re-taking a child is legitimate, and
        // the point is only that a take which will overwrite a live session's brief and
        // discard that child's run timestamps says so before the tick, not after.
        description: [l.statusCategory === "done" ? "done" : "", taken.has(l.key) ? "already taken" : ""]
          .filter(Boolean)
          .join(" · ") || undefined,
        detail: `${l.parentKey} › ${l.key}`,
        leaf: l,
      })),
      {
        title: `Which of these do you want to take?${shortfall}`,
        canPickMany: true,
        ignoreFocusOut: true,
      },
    );
    return picked?.map((p) => p.leaf);
  }

  /** Ticket keys this machine has already taken: one with a run record, or one whose own
   *  per-task worktree currently holds a live session.
   *
   *  Why it matters at the leaf picker: taking a leaf writes `.pick-task/TASK.md` into a
   *  worktree a live session may be reading from, and in fan-out mode `writeRun`
   *  overwrites that child's run record, discarding its createdAt/finishedAt/closedAt —
   *  for a ticket the user never named individually. This only labels; the decision
   *  stays the user's.
   *
   *  A finished run counts: what would be discarded is precisely its timestamps. The
   *  live half needs no run record at all — a session's place is a git worktree root, so
   *  a path with the worktree marker in it is named after the key it belongs to
   *  (`repoRootOfWorktree` is the same convention `createWorktrees` writes). */
  private alreadyTakenKeys(): Set<string> {
    const keys = new Set(readRuns(defaultRunsDir()).map((r) => r.key));
    for (const place of groupByPlace(readOpenSessions(defaultSessionsDir())).keys()) {
      if (repoRootOfWorktree(place)) keys.add(path.basename(place));
    }
    return keys;
  }

  /** The repo names a fan-out hands `takeBatch` as its filter set.
   *
   *  `takeBatch`'s `repos` is a filter, not a suggestion: `resolveBatchRepos` reads an
   *  empty list as "nothing usable here", toasts, and launches nothing — so the fan-out
   *  has to name a set.
   *
   *  The in-card selection wins when there is one: it is the only repo intent the user
   *  has actually expressed on this take. Otherwise the set is the PARENT ticket's own
   *  inferred repos. Not every discovered repo: `reposForTask` widens to the whole
   *  filter set for a child whose ticket infers nothing, so an unbounded set would let
   *  one such child open a worktree in every repo on the machine. Scoping to the parent
   *  bounds that to the work the user chose by taking this ticket, and makes fan-out
   *  agree with orchestrator mode, which confines children to the parent's set too.
   *  `detail` is the probe's own read, so this costs no extra round trip.
   *
   *  A parent that itself infers nothing still widens to every discovered repo — that is
   *  `reposForTask`'s documented last resort, and the caller logs the resolved set so an
   *  unexpected worktree count is explicable rather than mysterious. */
  private fanOutRepos(cfg: AgentFlowConfig, detail: TaskDetail, preselected?: string[]): string[] {
    if (preselected?.length) return preselected;
    // Git repos only. A fan-out child MUST have a worktree, so a non-git folder under
    // `reposRoot` can only fail its task — and it fails it loudly: an unsolicited
    // "Skipping … not a git repo" toast naming folders the user never picked, and, when
    // a misconfigured `reposRoot` has no git repo at all, `"No git repo among  under
    // /repos"` with a blank where the names belong.
    const repos = discoverRepos(cfg.reposRoot, cfg.repoBlocklist).filter((r) => r.isGit);
    return this.reposForTask(detail, repos).map((r) => r.name);
  }

  /**
   * Orchestrator-mode take: one session in the parent's worktree, one worktree per
   * selected leaf for it to dispatch a subagent into.
   *
   * The children get worktrees in the PARENT's resolved repo set, not in their own.
   * An orchestrator can only dispatch into directories its own window can see, and a
   * child's repos are its own ticket's inference — following those would scatter
   * worktrees across repos this session never opens. A child that names something
   * outside the set is said out loud rather than silently narrowed.
   *
   * No telemetry, for the same reason a fan-out emits none: this path never opened a
   * funnel (see `takeTask`), so there is nothing here to terminate.
   */
  private async takeOrchestrated(
    detail: TaskDetail,
    leaves: TreeLeaf[],
    parentBranch: string,
    preselected?: string[],
  ): Promise<void> {
    const cfg = getConfig();
    // No prompt-mode question: the mode is forced to `orchestrator` below. The
    // destination and repo questions are resolveKickoff's own, and neither the tree-mode
    // nor the leaf picker asked them, so this is the first time either is put up — and
    // an in-card selection skips the repo one entirely, exactly as a fan-out's does.
    const resolved = await this.resolveKickoff(detail.key, preselected);
    if (!resolved) return;
    const { services: parentRepos, target } = resolved;

    // The parent branch is the base every child branches off. Without it in a repo, a
    // child worktree there would silently start from main — refuse instead. Resolved
    // for EVERY repo before any worktree is created, so a refusal leaves nothing behind.
    const noBranch = parentRepos.filter((r) => r.isGit && !ensureBranch(r.path, parentBranch));
    if (noBranch.length) {
      this.toast(
        "error",
        `Couldn't create the parent branch ${parentBranch} in ${noBranch.map((r) => r.name).join(", ")} — nothing was taken.`,
      );
      return;
    }

    const inScope = new Set(parentRepos.map((r) => r.name));
    const discovered = discoverRepos(cfg.reposRoot, cfg.repoBlocklist);
    const children: NonNullable<Run["children"]> = [];
    const failed: string[] = [];
    for (const leaf of leaves) {
      const made = createWorktrees(parentRepos, leaf.key, leaf.summary, this.log, { baseRef: parentBranch });
      // createWorktrees hands back the ORIGINAL ref when it could not create the
      // worktree. Launching a subagent there would put it in the parent's own
      // checkout, so that child is dropped rather than mislocated. Index-aligned
      // because createWorktrees maps one result per service it was handed.
      const usable = made.filter((s, i) => s.path !== parentRepos[i].path);
      if (!usable.length) {
        failed.push(leaf.key);
        continue;
      }
      for (const s of usable) {
        children.push({
          key: leaf.key,
          summary: leaf.summary,
          repo: s.name,
          path: s.path,
          // OBSERVED, not computed. createWorktrees hands back an existing worktree
          // directory without checking which branch it is on, so after a Jira summary
          // edit `branchName(leaf.key, leaf.summary)` names a branch that does not
          // exist — and that name is what the drawer chip shows, what Run.children[]
          // stores, and what the brief tells the orchestrator to merge. Falling back to
          // the computed name only when git cannot answer at all keeps a non-git or
          // unreadable path behaving as it did.
          branch: currentBranch(s.path) ?? branchName(leaf.key, leaf.summary),
        });
      }
      // Each child worktree gets its own brief, from its own ticket — a subagent reads a
      // real brief, not a row in the parent's table. A failed read degrades to what the
      // leaf already told us rather than costing the child its worktree or the take.
      const childDetail = await this.provider().detail(leaf.key).catch(() => null);
      if (childDetail) this.logReposOutsideParent(childDetail, discovered, inScope);
      writeBriefInto(
        usable,
        { key: leaf.key, summary: leaf.summary, url: childDetail?.url ?? "" },
        briefMarkdown(
          childDetail ?? { key: leaf.key, summary: leaf.summary, descriptionText: "" },
          providerLabel(resolvedProvider(cfg.agentProvider)),
        ),
        this.log,
      );
    }
    if (failed.length) {
      this.toast("info", `Couldn't create a worktree for ${failed.join(", ")} — dispatch those by hand.`);
    }

    // `parentBranch` is NOT passed to launch as a branch to use: launch's own
    // createWorktrees call re-derives it as branchName(detail.key, detail.summary).
    // The two agree only because `detail` is the object `parentBranch` was computed
    // from in takeTask — keep it that way. Divergence would sit the orchestrator on one
    // branch while its brief told it to merge children into another, silently.
    await this.launch(
      detail,
      parentRepos,
      this.orchestratorTemplate(cfg),
      true, // forceWorktree: the parent session works on the parent branch, isolated
      target,
      undefined,
      { children, parentBranch },
    );
  }

  /** Say which repos a child's own ticket names that the parent's set does not cover.
   *  Logged, not acted on: the child works the parent's repos either way (see
   *  `takeOrchestrated`), and a subagent quietly working somewhere its ticket never
   *  named is the kind of surprise that has to be findable afterwards. */
  private logReposOutsideParent(
    childDetail: TaskDetail,
    discovered: ServiceRef[],
    inScope: Set<string>,
  ): void {
    const outside = inferServices(
      { summary: childDetail.summary, descriptionText: childDetail.descriptionText, labels: childDetail.labels, components: childDetail.components },
      discovered,
    )
      .map((r) => r.service.name)
      .filter((n) => !inScope.has(n));
    if (!outside.length) return;
    this.log(
      `orchestrator ${childDetail.key}: skipping ${outside.join(", ")} — outside the parent's repos (${[...inScope].join(", ")})`,
    );
  }

  /** The orchestrator prompt mode's template. A user can delete or rename modes, so an
   *  absent one falls back to the first configured mode rather than failing the take —
   *  and says so, because the session then gets a prompt that does not mention
   *  subagents while the brief's Children table tells it to dispatch them. */
  private orchestratorTemplate(cfg: AgentFlowConfig): string {
    const mode = cfg.promptModes.find((m) => m.id === "orchestrator");
    if (mode) return mode.prompt;
    this.log(
      `orchestrator mode: no "orchestrator" prompt mode configured — falling back to ${cfg.promptModes[0]?.label ?? "the default prompt"}`,
    );
    return cfg.promptModes[0]?.prompt ?? "";
  }

  /** PR-review kick-off: the same open+seed flow as Take, but always in a worktree and
   * seeding the PR-review prompt — the agent finds the task's GitHub PR by its Jira key,
   * checks out its branch, assesses readiness, and (when prReviewAutoFix) implements the
   * requested changes. Surfaced on a card whose status matches cfg.prReviewStatus. */
  public async addressPr(key: string, preselected?: string[]): Promise<void> {
    // Its own read rather than hoisting the `const cfg` below: that one is deliberately
    // taken AFTER resolveKickoff's pickers, and moving it would change which settings
    // snapshot the Claude Code path sees.
    if (this.remoteControlBlocksLaunch(getConfig())) return;
    const resolved = await this.resolveKickoff(key, preselected);
    if (!resolved) return;
    const { detail, services, target } = resolved;
    const cfg = getConfig();
    await this.launch(detail, services, prReviewTemplate(cfg.prReviewPrompt, cfg.prReviewAutoFix), true, target);
  }

  /** Where to open a taken task — new window, this window, a saved workspace, or a
   * window you already have open. The picker itself is engine/openTarget's; this binds
   * the take flow's copy, its settings and the `vscode` pickers to it. */
  private chooseOpenTarget(cfg: AgentFlowConfig): Promise<OpenTarget | undefined> {
    return chooseOpenTarget(
      {
        openIn: cfg.openIn,
        trackOpenWindows: cfg.trackOpenWindows,
        title: "Open the task where?",
        placeHolder: "New window, this window, a saved workspace, or a window you have open",
      },
      openTargetDeps(cfg.workspaceDir, (m) => this.toast("info", m)),
    );
  }

  /** Live Agent-Flow windows other than this one — the sidebar's gauge count. */
  private liveWindows(): PresenceRecord[] {
    return liveWindowsElsewhere();
  }

  /** Resolve an OpenTarget to the openWorkspace arguments (engine/openTarget), binding
   * the take flow's own multiroot-vs-per-window question to it. */
  private targetToOpenArgs(
    target: OpenTarget,
    count: number,
    label: string,
    cfg: AgentFlowConfig,
  ): Promise<OpenArgs | undefined> {
    return targetToOpenArgs(target, count, {
      currentWindow,
      chooseWorkspaceMode: (n) => this.chooseWorkspaceMode(n, cfg.workspaceMode, label),
    });
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js"));
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let s = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

/** Resolve symlinks so a destination's folder paths compare equal to discovered repo
 * paths (matches engine/workspace.ts's canon). */
function canon(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}
