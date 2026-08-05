import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { getConfig, AgentFlowConfig, ExploreAction } from "./config";
import { JiraAuth } from "./jira/auth";
import { JiraClient, JiraAuthError, JiraApiError, JiraDetail, TransitionOption, isJiraNetworkError } from "./jira/client";
import { describeJiraError } from "./jira/errors";
import {
  promptableFields,
  toJiraValue,
  validateFieldInput,
  missingFieldIds,
  mentionsResolution,
  fieldDisplayNames,
  type FieldPrompt,
} from "./jira/transitionFields";
import { discoverRepos } from "./engine/repos";
import { inferServices } from "./engine/infer";
import { mapRepoComponents, resolveComponent } from "./engine/components";
import { applyExploreVars, injectSlackDm, prReviewTemplate } from "./engine/prompt";
import { openWorkspace, listWorkspaceFiles, workspaceFolderPaths, planWorkspaceMerge, type MergeCandidate } from "./engine/workspace";
import { readLiveWindows, windowIdentity, defaultWindowsDir, PresenceRecord } from "./engine/presence";
import { readRuns, defaultRunsDir, describeActiveTasks } from "./engine/runs";
import { defaultSessionsDir, groupByPlace, readOpenSessions } from "./engine/sessions";
import { createWorktrees, repoRootOfWorktree } from "./engine/worktree";
import { openSharedWorkspace, folderName, type BatchTask } from "./engine/batchWorkspace";
import { sortBySavedOrder, applyReorder, pruneOrder } from "./engine/order";
import { Filter, InboundMessage, JiraTask, OutboundMessage, PromptMode, ServiceRef, Size, WorkspaceMode } from "./types";
import { track, trackError, startFlow, fingerprint, Flow } from "./telemetry/telemetry";
import { toPromptModeProp, classifyFailure, DestinationProp, FailureClass, Op, PromptModeProp, RepoSource, TakeSource } from "./telemetry/events";

const SPRINT_ORDER_KEY = "agentFlow.sprintOrder";

/** Which engine operation a webview message represents, for operation_failed.
 * Messages absent from this map report as "jira_fetch" only if they read Jira;
 * anything genuinely unclassifiable is left out and reports nothing. */
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
  runDoctor: "jira_fetch",
};

/** Message types whose Jira interaction is itself a write — the rest that read
 * Jira at all (including `take`/`takeBatch`/`addressPr`, whose primary MESSAGE_OPS
 * entry is a non-Jira op) are reads. Used only by resolveOp() below. */
const JIRA_WRITE_MESSAGES: ReadonlySet<InboundMessage["type"]> = new Set([
  "changeStatus",
  "addToMySprint",
  "removeFromSprint",
  "setComponent",
]);

/** MESSAGE_OPS attributes a failure to a message's own primary purpose — `take` is
 * "workspace_write" because opening/seeding a workspace is what it mostly does.
 * But `take`, `takeBatch`, and `addressPr` all read a ticket via resolveKickoff()
 * before ever touching a workspace, and that Jira read has no try/catch of its
 * own — it is the single most failure-prone step in the flow, and MESSAGE_OPS
 * alone would mislabel its failure a workspace_write / pr_lookup. When the
 * thrown error is identifiably from the Jira client — JiraAuthError, JiraApiError,
 * or a network-level failure inside request() (unreachable host, DNS, timeout;
 * see isJiraNetworkError, src/jira/client.ts) — that origin is trusted over the
 * message-type default: jira_write for the message types whose own Jira
 * interaction is a write, jira_fetch for everything else that reads Jira at all.
 * The network-level case matters most in practice: an unreachable Jira (VPN off,
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
  if (e instanceof JiraAuthError || e instanceof JiraApiError || isJiraNetworkError(e)) {
    return JIRA_WRITE_MESSAGES.has(m.type) ? "jira_write" : "jira_fetch";
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

/** Where to open a taken task — a new window, the current one, merged into an
 * existing .code-workspace file, or focused into an already-open folder window. */
type OpenTarget =
  | { kind: "new" }
  | { kind: "current" }
  | { kind: "existing"; file: string }
  | { kind: "live-folder"; folder: string };

export class TasksViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "agentFlow.tasks";
  private view?: vscode.WebviewView;
  private lastFilter: Filter = "unassigned";

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly auth: JiraAuth,
    private readonly log: (m: string) => void = () => {},
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: InboundMessage) => this.onMessage(m));
  }

  private post(msg: OutboundMessage): void {
    this.view?.webview.postMessage(msg);
  }

  /** Post the panel's `state`, folding in the config-derived fields the webview needs
   * (project name, and the PR-review status string that gates the "Address PR" action). */
  private postState(authed: boolean, configured: boolean, me: string | null): void {
    const cfg = getConfig();
    this.post({ type: "state", authed, configured, project: cfg.project, me,
      prReviewStatus: cfg.prReviewStatus, filters: cfg.filters,
      liveCount: cfg.trackOpenWindows ? this.liveWindows().length : undefined });
  }

  private toast(
    level: "success" | "error" | "info",
    message: string,
    action?: { label: string; url: string },
  ): void {
    this.post({ type: "toast", level, message, ...(action ? { action } : {}) });
  }

  private client(): JiraClient {
    const cfg = getConfig();
    return new JiraClient(cfg.baseUrl, cfg.project, this.auth);
  }

  private savedOrder(): string[] {
    return this.context.workspaceState.get<string[]>(SPRINT_ORDER_KEY, []);
  }

  private async saveOrder(order: string[]): Promise<void> {
    await this.context.workspaceState.update(SPRINT_ORDER_KEY, order);
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
    const configured = !!cfg.baseUrl && !!cfg.project;
    let authed = false;
    try {
      authed = await this.auth.isAuthenticated();
    } catch {
      authed = false;
    }
    this.postState(authed, configured, null);
    if (!configured || !authed) return;

    await Promise.all([
      this.client()
        .currentUserName()
        .then((me) => {
          if (me) this.postState(true, configured, me);
        })
        .catch(() => {
          /* display name is best-effort — the task list is the real payload */
        }),
      this.onMessage({ type: "fetch", filter: (cfg.defaultFilter as Filter) || "mysprint", size: "any" }),
    ]);
  }

  private async onMessage(m: InboundMessage): Promise<void> {
    const cfg = getConfig();
    this.log(`webview → host: ${m.type}`);
    try {
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
          if (!(await this.auth.isAuthenticated())) {
            this.postState(false, !!cfg.baseUrl && !!cfg.project, null);
            return;
          }
          this.post({ type: "loading", loading: true });
          this.lastFilter = m.filter;
          const tasks = await this.client().fetchTasks(m.filter, m.size);
          const repos = discoverRepos(cfg.reposRoot, cfg.repoBlocklist);
          for (const t of tasks) t.services = this.guessServices(t, repos);
          let outgoing = tasks;
          if (m.filter === "mysprint") {
            if (m.size === "any") {
              // Full sprint view: prune keys that have left the sprint.
              await this.saveOrder(pruneOrder(this.savedOrder(), tasks.map((t) => t.key)));
            }
            outgoing = sortBySavedOrder(tasks, this.savedOrder());
          }
          this.post({ type: "tasks", filter: m.filter, tasks: outgoing,
            liveCount: cfg.trackOpenWindows ? this.liveWindows().length : undefined });
          this.post({ type: "loading", loading: false });
          break;
        }
        case "detail": {
          if (!(await this.auth.isAuthenticated())) return;
          const client = this.client();
          const detail = await client.getDetail(m.key);
          const repos = discoverRepos(cfg.reposRoot, cfg.repoBlocklist);
          const inferred = inferServices(
            { summary: detail.summary, descriptionText: detail.descriptionText, labels: detail.labels, components: detail.components },
            repos,
          ).map((r) => r.service.name);
          // After the issue read, never before: listComponents swallows every
          // failure including a 401, so the detail read is what lets a dead token
          // reach the catch below and re-gate the panel.
          const projectComponents = await client.listComponents();
          if (projectComponents === null) {
            // Not toasted: a card expand happening to land while Jira's endpoint is
            // down would toast on every expand. The chips render "unknown" instead;
            // this line is only for tracing it after the fact.
            this.log(`detail ${m.key}: ${cfg.project} component list unavailable`);
          }
          const names = repos.map((r) => r.name);
          this.post({
            type: "detail",
            key: m.key,
            descriptionText: detail.descriptionText,
            inferred,
            repos: names,
            jiraComponents: detail.components,
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
      if (e instanceof JiraAuthError) {
        // Auth failures re-gate to the sign-in screen, which is itself the indication.
        this.postState(false, !!cfg.baseUrl && !!cfg.project, null);
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

  /** Change a ticket's status via a menu of its valid workflow transitions (a Jira WRITE). */
  public async changeStatus(key: string): Promise<void> {
    const cfg = getConfig();
    this.log(`changeStatus ${key}: start`);
    if (!(await this.auth.isAuthenticated())) {
      this.log(`changeStatus ${key}: not authenticated`);
      this.postState(false, !!cfg.baseUrl && !!cfg.project, null);
      return;
    }
    const client = this.client();
    const transitions = await client.getTransitions(key);
    this.log(`changeStatus ${key}: ${transitions.length} transitions`);
    if (transitions.length === 0) {
      this.toast("info", `No status transitions available for ${key}.`);
      return;
    }
    const pick = await vscode.window.showQuickPick(
      transitions.map((t) => ({
        label: `$(arrow-small-right) ${t.toName}`,
        description: t.name !== t.toName ? `via "${t.name}"` : "",
        t,
      })),
      { title: `${key} — change status to…`, placeHolder: "Pick a status", ignoreFocusOut: true },
    );
    this.log(`changeStatus ${key}: picked ${pick ? pick.t.toName : "(cancelled)"}`);
    if (!pick) return;
    const target: TransitionOption = pick.t;

    // `fields` is absent on anything that didn't come from an expanded
    // getTransitions — the metadata is Jira's JSON, not a guarantee.
    const { prompts, skipped } = promptableFields(target.fields ?? {});
    if (skipped.length) {
      this.log(`changeStatus ${key}: can't fill ${skipped.join(", ")} here — letting Jira decide`);
    }
    const fields = await this.collectFields(key, target.toName, prompts);
    if (fields === undefined) {
      this.log(`changeStatus ${key}: cancelled at a field prompt`);
      return;
    }

    try {
      await client.transition(key, target.id, fields);
    } catch (e) {
      if (!(e instanceof JiraApiError)) throw e;
      const recovered = await this.recoverTransition(client, key, target, e, fields);
      if (!recovered) return; // already reported, or the user backed out
    }
    this.log(`changeStatus ${key}: transition POST ok → ${target.toName}`);
    if (cfg.stampLabelOnWrite) {
      try {
        await client.addLabel(key, cfg.provenanceLabel);
      } catch (e) {
        this.log(`label stamp failed for ${key}: ${e}`);
      }
    }
    const removed = target.toCategory === "done";
    this.post({ type: "statusChanged", key, status: target.toName, category: target.toCategory, removed });
    this.toast("success", `${key} → ${target.toName}`);
  }

  /** Run one prompt per field, in order. Returns the collected `fields` payload,
   *  or undefined when the user escaped — a half-filled transition is never worth
   *  writing, so cancelling any prompt cancels the whole thing. */
  private async collectFields(
    key: string,
    toName: string,
    prompts: FieldPrompt[],
  ): Promise<Record<string, unknown> | undefined> {
    const out: Record<string, unknown> = {};
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
        out[p.id] = toJiraValue(p, picked.map((i) => i.label));
      } else if (p.kind === "pick") {
        const picked = await vscode.window.showQuickPick(
          p.choices.map((c) => ({ label: c.name })),
          { title, placeHolder: `Pick ${p.name}`, ignoreFocusOut: true },
        );
        if (!picked) return undefined;
        out[p.id] = toJiraValue(p, picked.label);
      } else {
        const raw = await vscode.window.showInputBox({
          title,
          prompt: p.name,
          placeHolder: p.kind === "date" || p.kind === "datetime" ? "YYYY-MM-DD" : undefined,
          ignoreFocusOut: true,
          validateInput: (v: string) => validateFieldInput(p, v),
        });
        if (raw === undefined) return undefined;
        out[p.id] = toJiraValue(p, raw);
      }
    }
    return out;
  }

  /** One rescue attempt after Jira refuses a transition. Screen metadata can't see
   *  custom workflow validators, so the rejection itself is the only place some
   *  requirements are ever stated. Returns true when the retry succeeded. */
  private async recoverTransition(
    client: JiraClient,
    key: string,
    target: TransitionOption,
    err: JiraApiError,
    already: Record<string, unknown>,
  ): Promise<boolean> {
    const meta = target.fields ?? {};
    const names = fieldDisplayNames(meta);
    const ids = missingFieldIds(meta, err);
    let prompts: FieldPrompt[] = ids.length ? promptableFields(meta, { only: ids }).prompts : [];

    if (!prompts.length && mentionsResolution(err)) {
      const resolutions = await client.listResolutions().catch(() => []);
      if (resolutions.length) {
        prompts = [{ kind: "pick", id: "resolution", name: "Resolution", choices: resolutions }];
      }
    }
    if (!prompts.length) {
      this.reportWriteFailure(key, err, names);
      return false;
    }

    this.log(`changeStatus ${key}: rejected — re-prompting ${prompts.map((p) => p.name).join(", ")}`);
    const extra = await this.collectFields(key, target.toName, prompts);
    if (extra === undefined) return false;
    try {
      await client.transition(key, target.id, { ...already, ...extra });
      return true;
    } catch (e) {
      if (!(e instanceof JiraApiError)) throw e;
      this.reportWriteFailure(key, e, names);
      return false;
    }
  }

  /** A refused write leaves the list valid, so it gets a toast — never the gate —
   *  with a way out to the ticket itself. */
  private reportWriteFailure(key: string, err: JiraApiError, names: Record<string, string>): void {
    const cfg = getConfig();
    const message = `Couldn't update ${key}. ${describeJiraError(err, names)}`;
    this.log(`changeStatus ${key}: ${err.status} — ${message}`);
    this.toast("error", message, { label: "Open in Jira", url: `${cfg.baseUrl}/browse/${key}` });
  }

  /** Add a ticket to the active sprint and assign it to the current user — the two
   * writes that make it show up in the "My sprint" lens. Stamps the provenance label. */
  public async addToMySprint(key: string): Promise<void> {
    const cfg = getConfig();
    this.log(`addToMySprint ${key}: start`);
    if (!(await this.auth.isAuthenticated())) {
      this.postState(false, !!cfg.baseUrl && !!cfg.project, null);
      return;
    }
    const client = this.client();
    const me = await client.getMyself();
    if (!me) {
      this.toast("error", "Couldn't resolve your Jira account.");
      return;
    }
    const sprintId = await client.getActiveSprintId();
    if (sprintId == null) {
      this.toast("error", `No active sprint on the ${cfg.project} board.`);
      return;
    }
    await client.addIssueToSprint(sprintId, key);
    await client.assignIssue(key, me.accountId);
    this.log(`addToMySprint ${key}: sprint ${sprintId} + assigned to ${me.displayName}`);
    if (cfg.stampLabelOnWrite) {
      try {
        await client.addLabel(key, cfg.provenanceLabel);
      } catch (e) {
        this.log(`label stamp failed for ${key}: ${e}`);
      }
    }
    // No longer matches the "unassigned" or "backlog" lenses once it's mine + in a sprint.
    const removed = this.lastFilter === "unassigned" || this.lastFilter === "backlog";
    this.post({ type: "movedToSprint", key, assignee: me.displayName, removed });
    this.toast("success", `${key} → your sprint`);
  }

  /** Remove a ticket from the active sprint by moving it to the backlog. Leaves
   * assignee and status untouched. Offers a one-click Undo via a native notification. */
  public async removeFromSprint(key: string, size: Size): Promise<void> {
    const cfg = getConfig();
    this.log(`removeFromSprint ${key}: start`);
    if (!(await this.auth.isAuthenticated())) {
      this.postState(false, !!cfg.baseUrl && !!cfg.project, null);
      return;
    }
    const client = this.client();
    await client.removeIssueFromSprint(key);
    this.log(`removeFromSprint ${key}: moved to backlog`);
    if (cfg.stampLabelOnWrite) {
      try {
        await client.addLabel(key, cfg.provenanceLabel);
      } catch (e) {
        this.log(`label stamp failed for ${key}: ${e}`);
      }
    }
    // Drop it from the saved manual order so no ghost rank lingers.
    const saved = this.savedOrder();
    if (saved.includes(key)) await this.saveOrder(saved.filter((k) => k !== key));
    this.post({ type: "removedFromSprint", key });
    this.toast("success", `${key} → backlog`);
    // Undo: put it back into the active sprint and refetch so the card returns.
    const choice = await vscode.window.showInformationMessage(`${key} removed from your sprint`, "Undo");
    if (choice !== "Undo") return;
    const sprintId = await client.getActiveSprintId();
    if (sprintId == null) {
      this.toast("error", `No active sprint on the ${cfg.project} board.`);
      return;
    }
    await client.addIssueToSprint(sprintId, key);
    this.log(`removeFromSprint ${key}: undo → sprint ${sprintId}`);
    await this.onMessage({ type: "fetch", filter: "mysprint", size });
  }

  /** Add or remove one component on a ticket, mirroring one chip in the card (a Jira
   * WRITE). Reports its own failures and never throws, so `onMessage`'s catch cannot
   * double-toast; every call posts exactly one `componentsChanged`, which is the
   * webview's cue to keep or undo its optimistic update. */
  public async setComponent(key: string, repo: string, on: boolean, movedChip: boolean): Promise<void> {
    const cfg = getConfig();
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
      if (!(await this.auth.isAuthenticated())) {
        this.postState(false, !!cfg.baseUrl && !!cfg.project, null);
        echo(false);
        return;
      }
      const client = this.client();
      const projectComponents = await client.listComponents();
      if (projectComponents === null) {
        // The read failed — that is not the same claim as "no such component", and
        // blaming the repo name would send the user looking in the wrong place.
        this.log(`setComponent ${key}: ${cfg.project} component list unavailable`);
        echo(false);
        this.toast("error", `Couldn't read ${cfg.project}'s components from Jira. Check the connection and try again.`);
        return;
      }
      const name = resolveComponent(repo, projectComponents);
      if (!name) {
        // The webview only sends repos it believes are components, so the list moved
        // under us. Nothing was written.
        this.log(`setComponent ${key}: no ${cfg.project} component named ${repo}`);
        echo(false);
        this.toast("error", `${cfg.project} has no component named “${repo}”.`);
        return;
      }
      try {
        await client.updateComponents(key, on ? { add: [name] } : { remove: [name] });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.log(`setComponent ${key}: ${on ? "add" : "remove"} ${name} failed — ${msg}`);
        echo(false);
        if (e instanceof JiraAuthError) {
          this.postState(false, !!cfg.baseUrl && !!cfg.project, null);
          return;
        }
        this.toast("error", msg, { label: "Open in Jira", url: `${cfg.baseUrl}/browse/${key}` });
        return;
      }
      this.log(`setComponent ${key}: ${on ? "add" : "remove"} ${name} ok`);
      if (cfg.stampLabelOnWrite) {
        try {
          await client.addLabel(key, cfg.provenanceLabel);
        } catch (e) {
          this.log(`label stamp failed for ${key}: ${e}`);
        }
      }
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

  /** Explore flow: pick repos freely (no ticket), open a workspace, and seed a Claude Code
   * agent for investigation/knowledge — a Jira ticket can come out of it later. */
  public async explore(): Promise<void> {
    const cfg = getConfig();
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
    const target = await this.chooseOpenTarget(cfg);
    if (!target) return;

    let services: ServiceRef[];
    if (target.kind === "existing" || target.kind === "live-folder") {
      services = this.servicesFromExistingDestination(target, repos);
      if (services.length === 0) {
        this.toast("error", "That workspace has no repos to open.");
        return;
      }
    } else {
      const picks = await vscode.window.showQuickPick<vscode.QuickPickItem & { repo: ServiceRef }>(
        repos.map((r) => ({
          label: r.name,
          detail: r.isGit ? r.path : `${r.path}  (not a git repo)`,
          repo: r,
        })),
        {
          canPickMany: true,
          title: "Explore — pick the repos to open",
          placeHolder: "Space to toggle · Enter to open",
          ignoreFocusOut: true,
        },
      );
      if (!picks || picks.length === 0) return;
      services = picks.map((p) => p.repo);
    }

    const args = await this.targetToOpenArgs(target, services.length, "Explore", cfg);
    if (!args) return;

    const wantRemoteControl = await this.resolveRemoteControl(cfg);

    const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    const slug = slugify(topic) || "explore";
    const serviceNames = services.map((s) => s.name).join(", ");
    const key = env ? `verify-${slugify(env) || "env"}-${slug}` : `explore-${slug}`;
    const summary = env ? `${topic} on ${env}` : topic;
    const planMd = env
      ? `## Verify: ${topic} on ${env}\n\n_Verification session — environment: ${env}. Services in scope: ${serviceNames}._`
      : action.id === "supervise"
        ? `## Supervise: ${topic}\n\n_No Jira ticket yet — a supervision session over your other active Agent Flow tasks._\n\n` +
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
      remoteControl: wantRemoteControl,
      kind: "explore",
    });

    const where = result.workspaceFile
      ? `workspace ${result.workspaceFile.split("/").pop()}`
      : `${result.opened.length} window(s)`;
    const seeded = this.seededNote(cfg.seedAgent, result.remoteControl);
    const rcNote = this.remoteControlNote(wantRemoteControl, result.remoteControl);
    const what = env
      ? `to verify on ${env}`
      : action.id === "supervise"
        ? "to check on your other tasks"
        : "to explore";
    this.toast("success", `Opened ${where} ${what}. Brief seeded in each repo.${seeded}${rcNote}`);
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

  private guessServices(t: JiraTask, repos: ServiceRef[]): string[] {
    return inferServices(
      { summary: t.summary, labels: t.labels, components: t.components },
      repos,
    ).map((r) => r.service.name);
  }

  /** Read the ticket and resolve the destination + repo set for a kick-off (Take or
   * Address PR): auth gate, repo discovery, the destination pick, then the confirm-repos
   * QuickPick (pre-checking inferred repos AND repos the destination already contains).
   * `preselected` (the in-card selection) skips the confirm QuickPick. Returns undefined
   * on any abort. */
  private async resolveKickoff(
    key: string,
    preselected?: string[],
    flow?: Flow,
  ): Promise<{ detail: JiraDetail; services: ServiceRef[]; target: OpenTarget } | undefined> {
    const cfg = getConfig();
    if (!(await this.auth.isAuthenticated())) {
      const ok = await vscode.commands.executeCommand<boolean>("agentFlow.signIn");
      if (!ok) return undefined;
    }

    const detail = await vscode.window.withProgress(
      { location: { viewId: TasksViewProvider.viewType }, title: `Reading ${key}…` },
      () => this.client().getDetail(key),
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
    } else {
      // New / this window — confirm the repos the task touches (inferred pre-selected).
      repoSource = "quickpick";
      const inferred = inferServices(
        { summary: detail.summary, descriptionText: detail.descriptionText, labels: detail.labels, components: detail.components },
        repos,
      );
      inferredNames = new Set(inferred.map((r) => r.service.name));
      inferredCount = inferred.length;

      // Pre-checked repos first. A QuickPick renders items in the order it's handed
      // them, so on a reposRoot with dozens of repos the inferred ones — the whole
      // point of the step — sit below the fold and read as "nothing was suggested".
      // Stable partition, so discovery order still holds within each group.
      const ordered = [
        ...repos.filter((r) => inferredNames.has(r.name)),
        ...repos.filter((r) => !inferredNames.has(r.name)),
      ];

      const picks = await vscode.window.showQuickPick<vscode.QuickPickItem & { repo: ServiceRef }>(
        ordered.map((r) => ({
          label: r.name,
          description: inferredNames.has(r.name)
            ? `inferred (${inferred.find((i) => i.service.name === r.name)!.reason})`
            : "",
          detail: r.isGit ? r.path : `${r.path}  (not a git repo)`,
          picked: inferredNames.has(r.name),
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

  /** Canonical paths the chosen destination already contains. New / current windows
   * contribute nothing (nothing to merge into). */
  private prefillPathsForTarget(target: OpenTarget): Set<string> {
    if (target.kind === "existing") return new Set(workspaceFolderPaths(target.file));
    if (target.kind === "live-folder") return new Set([canon(target.folder)]);
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
  private async resolveRemoteControl(cfg: AgentFlowConfig): Promise<boolean> {
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

  /** Which folders (if any) the user wants added to an existing-workspace destination.
   *  Duplicates are skipped without asking — a folder by that name is already there, so
   *  there is no real question, only noise. Only genuinely new repos prompt.
   *
   *  Never returns undefined: dismissing the prompt means "leave the workspace as-is",
   *  not "abort". By the time this runs the worktrees exist and the launch is committed,
   *  so abandoning it over a folder-list question is the worse failure — the same
   *  reasoning resolveRemoteControl documents. `declined` is true only when a prompt
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
   * `openWorkspace` withholds it when the launch opens more than one window. Without
   * this the user waits for a `/remote-control` prompt that never arrives. */
  private remoteControlNote(wanted: boolean, applied: boolean): string {
    return wanted && !applied ? " Remote Control skipped — it needs a single window." : "";
  }

  /** Toast fragment announcing the pre-seed, shared by `launch()` and `explore()`. With
   * Remote Control applied, Enter only connects the bridge — the task itself starts on
   * the later paste + Enter — so the plain "press Enter to start" copy would be wrong. */
  private seededNote(seedAgent: boolean, remoteControl: boolean): string {
    if (!seedAgent) return "";
    return remoteControl
      ? " Claude Code pre-seeded with /remote-control — Enter to connect, then paste."
      : " Claude Code pre-seeded — press Enter to start.";
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
    detail: JiraDetail,
    services: ServiceRef[],
    promptTemplate: string,
    forceWorktree: boolean,
    target: OpenTarget,
    onWorktreeDecision?: (used: boolean) => void,
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
      services = createWorktrees(services, detail.key, detail.summary, this.log);
    }

    const args = await this.targetToOpenArgs(target, services.length, key, cfg);
    if (!args) return false;

    // A saved workspace is the user's own artifact — never write it without approval.
    const additions = args.existingWorkspaceFile
      ? await this.resolveWorkspaceAdditions(
          args.existingWorkspaceFile,
          services.map((s) => ({ label: s.name, repoName: s.name, path: s.path })),
        )
      : { foldersToAdd: [], skipped: [], declined: false };

    const wantRemoteControl = await this.resolveRemoteControl(cfg);

    const planMd = this.buildBrief(detail);
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
      foldersToAdd: additions.foldersToAdd,
      remoteControl: wantRemoteControl,
    });

    const where = result.workspaceFile
      ? `workspace ${result.workspaceFile.split("/").pop()}`
      : `${result.opened.length} window(s)`;
    const seeded = this.seededNote(cfg.seedAgent, result.remoteControl);
    const rcNote = this.remoteControlNote(wantRemoteControl, result.remoteControl);
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
    const cfg = getConfig();
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
      // How should the agent start — pick a prompt mode (or use the configured default) FIRST.
      const promptMode = await this.choosePromptMode(cfg, `${key} — how should the agent start?`);
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
      throw e; // onMessage's existing catch (tasksView.ts:255) still owns the user-facing handling.
    }
  }

  /** Launch several tasks at once, each in its own git worktree with its own seeded
   * Claude session. The prompt mode, destination and layout are asked once and applied
   * to all; one task's failure never aborts the rest. Each task opens worktrees in the
   * repos it's inferred to touch, narrowed to the filtered set. */
  public async takeBatch(keys: string[], repos: string[]): Promise<void> {
    const cfg = getConfig();
    if (!keys.length) return;

    if (!(await this.auth.isAuthenticated())) {
      const ok = await vscode.commands.executeCommand<boolean>("agentFlow.signIn");
      if (!ok) return;
    }

    const filterSet = this.resolveBatchRepos(repos, cfg);
    if (!filterSet.length) return;

    if (keys.length > cfg.batchLaunchConfirmThreshold) {
      const go = await vscode.window.showWarningMessage(
        `Launch ${keys.length} tasks in parallel? That's ${keys.length} Claude Code sessions.`,
        { modal: true },
        "Launch",
      );
      if (go !== "Launch") return;
    }

    const promptMode = await this.choosePromptMode(cfg, `Launch ${keys.length} selected task(s) — how should the agents start?`);
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
    const isBatch = keys.length > 1;
    const rcSkipped = isBatch && cfg.remoteControl !== "off";
    if (rcSkipped) this.log("takeBatch: Remote Control skipped — one clipboard, several sessions");
    const wantRemoteControl = isBatch || shared ? false : await this.resolveRemoteControl(cfg);

    const resolved: { task: BatchTask; key: string }[] = [];
    const failed: string[] = [];
    for (const key of keys) {
      try {
        const detail = await this.client().getDetail(key);
        const wanted = this.reposForTask(detail, filterSet);
        const services = createWorktrees(wanted, detail.key, detail.summary, this.log);
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
            planMd: this.buildBrief(detail),
            descriptionText: detail.descriptionText,
            services,
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
    if (shared && resolved.length) {
      try {
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
          foldersToAdd: additions.foldersToAdd,
        });
        launched = resolved.length;
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
          });
          appliedRemoteControl = result.remoteControl;
          launched++;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          failed.push(`${key} (${msg})`);
          this.log(`takeBatch ${key}: failed — ${msg}`);
        }
        if (i < resolved.length - 1) await delay(BATCH_STAGGER_MS);
      }
      if (!isBatch) extra += this.remoteControlNote(wantRemoteControl, appliedRemoteControl);
    }

    const where = shared ? "in one shared window" : "in parallel";
    const summary = `Launched ${launched} of ${keys.length} ${where}.`;
    const rcNote = isBatch && rcSkipped ? " Remote Control skipped — one clipboard can't serve several sessions." : "";
    if (failed.length) {
      const shown = failed.slice(0, 5).join("; ");
      const more = failed.length > 5 ? ` (and ${failed.length - 5} more)` : "";
      this.toast("error", `${summary} Failed: ${shown}${more}${extra}${rcNote}`);
    } else {
      this.toast("success", `${summary} A worktree + Claude session per task.${extra}${rcNote}`);
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
      this.toast("error", `No git repo among ${names.join(", ")} under ${cfg.reposRoot}. Each task opens a worktree.`);
      return [];
    }
    if (missing.length) this.toast("info", `Skipping ${missing.join(", ")} — not found under ${cfg.reposRoot}.`);
    if (nonGit.length) this.toast("info", `Skipping ${nonGit.join(", ")} — not a git repo, and each task opens a worktree.`);
    return usable;
  }

  /** The repos a batched task opens: its inferred repos narrowed to the filtered set,
   * falling back to the whole set when inference finds nothing there — a task must
   * never launch with no repo at all. */
  private reposForTask(detail: JiraDetail, filterSet: ServiceRef[]): ServiceRef[] {
    const inferred = new Set(
      inferServices(
        { summary: detail.summary, descriptionText: detail.descriptionText, labels: detail.labels, components: detail.components },
        filterSet,
      ).map((r) => r.service.name),
    );
    const narrowed = filterSet.filter((r) => inferred.has(r.name));
    return narrowed.length ? narrowed : filterSet;
  }

  /** PR-review kick-off: the same open+seed flow as Take, but always in a worktree and
   * seeding the PR-review prompt — the agent finds the task's GitHub PR by its Jira key,
   * checks out its branch, assesses readiness, and (when prReviewAutoFix) implements the
   * requested changes. Surfaced on a card whose status matches cfg.prReviewStatus. */
  public async addressPr(key: string, preselected?: string[]): Promise<void> {
    const resolved = await this.resolveKickoff(key, preselected);
    if (!resolved) return;
    const { detail, services, target } = resolved;
    const cfg = getConfig();
    await this.launch(detail, services, prReviewTemplate(cfg.prReviewPrompt, cfg.prReviewAutoFix), true, target);
  }

  /** Where to open a taken task — new window, this window, a saved workspace, or a
   * window you already have open. Live windows appear only in the interactive "ask"
   * flow (a specific open window is inherently a per-take choice). */
  private async chooseOpenTarget(cfg: AgentFlowConfig): Promise<OpenTarget | undefined> {
    if (cfg.openIn === "new-window") return { kind: "new" };
    if (cfg.openIn === "this-window") return { kind: "current" };
    if (cfg.openIn === "pick-existing") return this.pickExistingWorkspace(cfg);

    type PickTarget = OpenTarget | { kind: "existing-pick" };
    const base: { label: string; detail: string; target: PickTarget }[] = [
      { label: "$(empty-window) New window", detail: "Open the task in a separate window", target: { kind: "new" } },
      { label: "$(window) This window", detail: "Open it in the current window (replaces what's here)", target: { kind: "current" } },
      { label: "$(folder-library) Existing workspace…", detail: "Open the task into a .code-workspace you already have", target: { kind: "existing-pick" } },
    ];
    const live = cfg.trackOpenWindows ? this.liveWindowItems() : [];
    const p = await vscode.window.showQuickPick([...base, ...live], {
      title: "Open the task where?",
      placeHolder: "New window, this window, a saved workspace, or a window you have open",
      ignoreFocusOut: true,
    });
    if (!p) return undefined;
    if (p.target.kind === "existing-pick") return this.pickExistingWorkspace(cfg);
    return p.target;
  }

  /** Live Agent-Flow windows other than this one. One source for both the open-target
   * picker and the sidebar's gauge count. */
  private liveWindows(): PresenceRecord[] {
    const self = windowIdentity()?.identity;
    return readLiveWindows(defaultWindowsDir()).filter((w) => w.identity !== self);
  }

  /** Live Agent-Flow windows (excluding the current one) as open-target picks. A
   * workspace window maps to the existing merge+focus path; a folder window focuses
   * and seeds in place. */
  private liveWindowItems(): { label: string; detail: string; target: OpenTarget }[] {
    return this.liveWindows().map((w) => ({
      label: `$(window) ${w.label}`,
      detail: w.kind === "workspace" ? `open now · ${w.folders} folder${w.folders === 1 ? "" : "s"}` : "open now",
      target: w.kind === "workspace" ? { kind: "existing", file: w.identity } : { kind: "live-folder", folder: w.identity },
    }));
  }

  /** Resolve an OpenTarget to the openWorkspace arguments, asking the multiroot-vs-
   * per-window question only for a NEW window with more than one repo. Returns
   * undefined if the user cancels that sub-pick. */
  private async targetToOpenArgs(
    target: OpenTarget,
    count: number,
    label: string,
    cfg: AgentFlowConfig,
  ): Promise<{ mode: WorkspaceMode; openIn: "new" | "current"; existingWorkspaceFile?: string; existingFolder?: string } | undefined> {
    if (target.kind === "existing") return { mode: "multiroot", openIn: "new", existingWorkspaceFile: target.file };
    if (target.kind === "live-folder") return { mode: "per-window", openIn: "new", existingFolder: target.folder };
    if (target.kind === "current") return { mode: count === 1 ? "per-window" : "multiroot", openIn: "current" };
    const mode = await this.chooseWorkspaceMode(count, cfg.workspaceMode, label);
    if (!mode) return undefined;
    return { mode, openIn: "new" };
  }

  /** Pick a `.code-workspace` from `cfg.workspaceDir` (or Browse… for one elsewhere). */
  private async pickExistingWorkspace(cfg: AgentFlowConfig): Promise<OpenTarget | undefined> {
    const BROWSE = "__browse__";
    const files = listWorkspaceFiles(cfg.workspaceDir);
    const items = [
      ...files.map((f) => ({
        label: `$(file-code) ${f.file.split("/").pop()}`,
        detail: `${f.folders} folder${f.folders === 1 ? "" : "s"}`,
        file: f.file,
      })),
      { label: "$(folder-opened) Browse…", detail: "Pick a .code-workspace from anywhere", file: BROWSE },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: "Open into which workspace?",
      placeHolder: files.length ? "Pick a workspace, or Browse…" : "No workspaces found — Browse…",
      ignoreFocusOut: true,
    });
    if (!picked) return undefined;
    if (picked.file !== BROWSE) return { kind: "existing", file: picked.file };
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { "VS Code Workspace": ["code-workspace"] },
      title: "Pick a .code-workspace",
    });
    if (!uris || !uris.length) return undefined;
    return { kind: "existing", file: uris[0].fsPath };
  }

  private buildBrief(detail: { key: string; summary: string; descriptionText: string }): string {
    const desc = detail.descriptionText?.trim();
    const body = desc ? `## Ticket description\n\n${desc}` : "_(No description on the ticket.)_";
    return `## ${detail.key}: ${detail.summary}\n\n${body}\n\n## Plan\n\n_The Claude Code prompt for this task says whether to plan first or implement._`;
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
