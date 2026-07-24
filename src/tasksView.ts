import * as vscode from "vscode";
import * as fs from "fs";
import { getConfig, AgentFlowConfig, ExploreAction, PR_REVIEW_AUTOFIX_CLAUSE } from "./config";
import { JiraAuth } from "./jira/auth";
import { JiraClient, JiraAuthError, JiraDetail } from "./jira/client";
import { discoverRepos } from "./engine/repos";
import { inferServices } from "./engine/infer";
import { injectSlackDm, insertBeforeFiles } from "./engine/prompt";
import { openWorkspace, listWorkspaceFiles, workspaceFolderPaths } from "./engine/workspace";
import { readLiveWindows, windowIdentity, defaultWindowsDir } from "./engine/presence";
import { createWorktrees } from "./engine/worktree";
import { sortBySavedOrder, applyReorder, pruneOrder } from "./engine/order";
import { Filter, InboundMessage, JiraTask, OutboundMessage, PromptMode, ServiceRef, WorkspaceMode } from "./types";

const SPRINT_ORDER_KEY = "agentFlow.sprintOrder";

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
    this.post({ type: "state", authed, configured, project: cfg.project, me, prReviewStatus: cfg.prReviewStatus, filters: cfg.filters });
  }

  private toast(level: "success" | "error" | "info", message: string): void {
    this.post({ type: "toast", level, message });
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
          this.post({ type: "tasks", filter: m.filter, tasks: outgoing });
          this.post({ type: "loading", loading: false });
          break;
        }
        case "detail": {
          if (!(await this.auth.isAuthenticated())) return;
          const detail = await this.client().getDetail(m.key);
          const repos = discoverRepos(cfg.reposRoot, cfg.repoBlocklist);
          const inferred = inferServices(
            { summary: detail.summary, descriptionText: detail.descriptionText, labels: detail.labels, components: detail.components },
            repos,
          ).map((r) => r.service.name);
          this.post({
            type: "detail",
            key: m.key,
            descriptionText: detail.descriptionText,
            inferred,
            repos: repos.map((r) => r.name),
          });
          break;
        }
        case "take": {
          await this.takeTask(m.key, m.services);
          break;
        }
        case "takeBatch": {
          await this.takeBatch(m.keys, m.repo);
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
      this.post({ type: "loading", loading: false });
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof JiraAuthError) {
        // Auth failures re-gate to the sign-in screen, which is itself the indication.
        this.postState(false, !!cfg.baseUrl && !!cfg.project, null);
      } else {
        // Everything else (unreachable site, timeout, Jira 5xx, bad project key) gets a
        // persistent banner in the panel — a toast alone vanishes before it's read.
        this.post({ type: "error", message: msg, canRetry: true });
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

    await client.transition(key, pick.t.id);
    this.log(`changeStatus ${key}: transition POST ok → ${pick.t.toName}`);
    if (cfg.stampLabelOnWrite) {
      try {
        await client.addLabel(key, cfg.provenanceLabel);
      } catch (e) {
        this.log(`label stamp failed for ${key}: ${e}`);
      }
    }
    const removed = pick.t.toCategory === "done";
    this.post({ type: "statusChanged", key, status: pick.t.toName, category: pick.t.toCategory, removed });
    this.toast("success", `${key} → ${pick.t.toName}`);
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

    const raw = await vscode.window.showInputBox({
      title: "Explore — what do you want to dig into?",
      prompt: "A focus for the session (optional). A Jira ticket can come later.",
      placeHolder: "e.g. how the aggregator retries failed scans",
      ignoreFocusOut: true,
    });
    if (raw === undefined) return; // cancelled (empty is allowed → generic focus)
    const topic = raw.trim() || "Codebase exploration";

    // Destination first, so the repo picker can pre-check what it already contains.
    const target = await this.chooseOpenTarget(cfg);
    if (!target) return;
    const inWorkspace = this.prefillPathsForTarget(target);
    const tag = target.kind === "live-folder" ? "open here" : "in this workspace";

    const picks = await vscode.window.showQuickPick<vscode.QuickPickItem & { repo: ServiceRef }>(
      repos.map((r) => {
        const present = inWorkspace.has(canon(r.path));
        return {
          label: r.name,
          description: present ? tag : "",
          detail: r.isGit ? r.path : `${r.path}  (not a git repo)`,
          picked: present,
          repo: r,
        };
      }),
      {
        canPickMany: true,
        title: "Explore — pick the repos to open",
        placeHolder: "Space to toggle · Enter to open",
        ignoreFocusOut: true,
      },
    );
    if (!picks || picks.length === 0) return;
    const services = picks.map((p) => p.repo);

    const args = await this.targetToOpenArgs(target, services.length, "Explore", cfg);
    if (!args) return;

    const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "explore";
    const planMd = `## Exploration: ${topic}\n\n_No Jira ticket yet — a knowledge/exploration session. If it turns into work, open a ticket afterwards._`;
    const result = await openWorkspace({
      ticket: { key: `explore-${slug}`, summary: topic, url: "" },
      planMd,
      descriptionText: "",
      services,
      mode: args.mode,
      promptTemplate: injectSlackDm(action.prompt, action.slackDm),
      workspaceDir: cfg.workspaceDir,
      seedAgent: cfg.seedAgent,
      openIn: args.openIn,
      existingWorkspaceFile: args.existingWorkspaceFile,
      existingFolder: args.existingFolder,
    });

    const where = result.workspaceFile
      ? `workspace ${result.workspaceFile.split("/").pop()}`
      : `${result.opened.length} window(s)`;
    const seeded = cfg.seedAgent ? " Claude Code pre-seeded — press Enter to start." : "";
    this.toast("success", `Opened ${where} to explore. Brief seeded in each repo.${seeded}`);
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

    let services: ServiceRef[];
    if (preselected && preselected.length) {
      // Selection already made in the expanded card — resolve names to repos, skip QuickPick.
      const byName = new Map(repos.map((r) => [r.name, r]));
      services = preselected.map((n) => byName.get(n)).filter((r): r is ServiceRef => !!r);
    } else {
      const inferred = inferServices(
        { summary: detail.summary, descriptionText: detail.descriptionText, labels: detail.labels, components: detail.components },
        repos,
      );
      const inferredNames = new Set(inferred.map((r) => r.service.name));
      const inWorkspace = this.prefillPathsForTarget(target);
      const tag = target.kind === "live-folder" ? "open here" : "in this workspace";

      // Confirm the service set (inferred + already-in-destination repos pre-selected).
      const picks = await vscode.window.showQuickPick<vscode.QuickPickItem & { repo: ServiceRef }>(
        repos.map((r) => {
          const present = inWorkspace.has(canon(r.path));
          const inf = inferredNames.has(r.name)
            ? `inferred (${inferred.find((i) => i.service.name === r.name)!.reason})`
            : "";
          return {
            label: r.name,
            description: [inf, present ? tag : ""].filter(Boolean).join(" · "),
            detail: r.isGit ? r.path : `${r.path}  (not a git repo)`,
            picked: inferredNames.has(r.name) || present,
            repo: r,
          };
        }),
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
    return { detail, services, target };
  }

  /** Canonical paths the chosen destination already contains — used to pre-check the
   * service list. New / current windows contribute nothing (nothing to merge into). */
  private prefillPathsForTarget(target: OpenTarget): Set<string> {
    if (target.kind === "existing") return new Set(workspaceFolderPaths(target.file));
    if (target.kind === "live-folder") return new Set([canon(target.folder)]);
    return new Set();
  }

  /** Open + seed a resolved kick-off: worktree decision → workspace mode → brief →
   * openWorkspace → success toast. Shared by Take and Address PR. The destination
   * `target` is resolved earlier in resolveKickoff. `forceWorktree` (Address PR) always
   * isolates in a worktree, ignoring cfg.worktree. */
  private async launch(
    detail: JiraDetail,
    services: ServiceRef[],
    promptTemplate: string,
    forceWorktree: boolean,
    target: OpenTarget,
  ): Promise<void> {
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
      if (!p) return;
      useWorktree = p.yes;
    }
    if (useWorktree) {
      services = createWorktrees(services, detail.key, detail.summary, this.log);
    }

    const args = await this.targetToOpenArgs(target, services.length, key, cfg);
    if (!args) return;

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
    });

    const where = result.workspaceFile
      ? `workspace ${result.workspaceFile.split("/").pop()}`
      : `${result.opened.length} window(s)`;
    const seeded = cfg.seedAgent ? " Claude Code pre-seeded — press Enter to start." : "";
    if (result.mergeFailed) {
      this.toast(
        "info",
        `Opened ${where} for ${key}, but its folders couldn't be parsed — repos weren't added. Brief seeded in each repo.${seeded}`,
      );
    } else {
      const added = result.mergedRepos?.length ? ` Added ${result.mergedRepos.join(", ")}.` : "";
      const unadded = result.unaddedRepos?.length
        ? ` ${result.unaddedRepos.join(", ")} couldn't be added as roots to that window — their briefs are still in place.`
        : "";
      this.toast("success", `Opened ${where} for ${key}. Brief seeded in each repo.${added}${unadded}${seeded}`);
    }
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
        detail: mm.prompt.replace(/\{[a-z]+\}/g, "").replace(/\s+/g, " ").trim().slice(0, 80),
        mode: mm,
      })),
      { title, ignoreFocusOut: true },
    );
    return p?.mode;
  }

  /** The pick flow: prompt mode → read ticket → destination → confirm services → open + seed.
   * `preselected` (from the in-card selection) skips the service QuickPick. */
  public async takeTask(key: string, preselected?: string[]): Promise<void> {
    const cfg = getConfig();

    // How should the agent start — pick a prompt mode (or use the configured default) FIRST.
    const promptMode = await this.choosePromptMode(cfg, `${key} — how should the agent start?`);
    if (!promptMode) return;

    const resolved = await this.resolveKickoff(key, preselected);
    if (!resolved) return;
    const { detail, services, target } = resolved;

    await this.launch(detail, services, promptMode.prompt, false, target);
  }

  /** Launch several tasks in parallel, each in its own git worktree + new window with
   * its own seeded Claude session. Offered by the webview only when the repo filter is
   * one repo; every task opens a worktree in that repo. The prompt mode is asked once
   * and applied to all; one task's failure never aborts the rest. */
  public async takeBatch(keys: string[], repo: string): Promise<void> {
    const cfg = getConfig();
    if (!keys.length) return;

    if (!(await this.auth.isAuthenticated())) {
      const ok = await vscode.commands.executeCommand<boolean>("agentFlow.signIn");
      if (!ok) return;
    }

    const repos = discoverRepos(cfg.reposRoot, cfg.repoBlocklist);
    const repoRef = repos.find((r) => r.name === repo);
    if (!repoRef) {
      this.toast("error", `Repo "${repo}" not found under ${cfg.reposRoot}.`);
      return;
    }
    if (!repoRef.isGit) {
      this.toast("error", `Batch launch needs a git repo — "${repo}" isn't one. Each task opens its own worktree.`);
      return;
    }

    if (keys.length > cfg.batchLaunchConfirmThreshold) {
      const go = await vscode.window.showWarningMessage(
        `Launch ${keys.length} tasks in parallel? That opens ${keys.length} windows, each with its own Claude Code session.`,
        { modal: true },
        "Launch",
      );
      if (go !== "Launch") return;
    }

    const promptMode = await this.choosePromptMode(cfg, `Launch ${keys.length} selected task(s) — how should the agents start?`);
    if (!promptMode) return;

    let launched = 0;
    const failed: string[] = [];
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      try {
        const detail = await this.client().getDetail(key);
        const services = createWorktrees([repoRef], detail.key, detail.summary, this.log);
        // A worktree is mandatory here: two batch tasks sharing the main checkout would
        // clobber each other's .pick-task/TASK.md brief. createWorktrees returns the
        // original (main-checkout) ref when `git worktree add` fails — detect that and
        // fail the task honestly instead of launching into a shared, colliding checkout.
        if (services[0].path === repoRef.path) {
          throw new Error("couldn't create a git worktree (would collide with the shared checkout)");
        }
        await openWorkspace({
          ticket: { key: detail.key, summary: detail.summary, url: detail.url },
          planMd: this.buildBrief(detail),
          descriptionText: detail.descriptionText,
          services,
          mode: "per-window",
          promptTemplate: promptMode.prompt,
          workspaceDir: cfg.workspaceDir,
          seedAgent: cfg.seedAgent,
          openIn: "new",
        });
        launched++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failed.push(`${key} (${msg})`);
        this.log(`takeBatch ${key}: failed — ${msg}`);
      }
      if (i < keys.length - 1) await delay(BATCH_STAGGER_MS);
    }

    const summary = `Launched ${launched} of ${keys.length} in parallel.`;
    if (failed.length) {
      const shown = failed.slice(0, 5).join("; ");
      const more = failed.length > 5 ? ` (and ${failed.length - 5} more)` : "";
      this.toast("error", `${summary} Failed: ${shown}${more}`);
    } else this.toast("success", `${summary} A worktree + Claude session per task.`);
  }

  /** PR-review kick-off: the same open+seed flow as Take, but always in a worktree and
   * seeding the PR-review prompt — the agent finds the task's GitHub PR by its Jira key,
   * checks out its branch, assesses readiness, and (when prReviewAutoFix) implements the
   * requested changes. Surfaced on a card whose status matches cfg.prReviewStatus. */
  public async addressPr(key: string, preselected?: string[]): Promise<void> {
    const resolved = await this.resolveKickoff(key, preselected);
    if (!resolved) return;
    const { detail, services, target } = resolved;
    await this.launch(detail, services, this.prReviewTemplate(getConfig()), true, target);
  }

  /** Assemble the PR-review prompt: the configured base, with the auto-fix clause
   * inserted just before the trailing {files} block when prReviewAutoFix is on.
   * Reuses insertBeforeFiles — the same technique as the Explore Slack-DM sentence. */
  private prReviewTemplate(cfg: AgentFlowConfig): string {
    return cfg.prReviewAutoFix
      ? insertBeforeFiles(cfg.prReviewPrompt, " " + PR_REVIEW_AUTOFIX_CLAUSE)
      : cfg.prReviewPrompt;
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

  /** Live Agent-Flow windows (excluding the current one) as open-target picks. A
   * workspace window maps to the existing merge+focus path; a folder window focuses
   * and seeds in place. */
  private liveWindowItems(): { label: string; detail: string; target: OpenTarget }[] {
    const self = windowIdentity()?.identity;
    return readLiveWindows(defaultWindowsDir())
      .filter((w) => w.identity !== self)
      .map((w) => ({
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
