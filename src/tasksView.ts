import * as vscode from "vscode";
import { getConfig, FlowDeckConfig } from "./config";
import { JiraAuth } from "./jira/auth";
import { JiraClient, JiraAuthError } from "./jira/client";
import { discoverRepos } from "./engine/repos";
import { inferServices } from "./engine/infer";
import { openWorkspace } from "./engine/workspace";
import { createWorktrees } from "./engine/worktree";
import { sortBySavedOrder, applyReorder, pruneOrder } from "./engine/order";
import { Filter, InboundMessage, JiraTask, OutboundMessage, PromptMode, ServiceRef, WorkspaceMode } from "./types";

const SPRINT_ORDER_KEY = "flowdeck.sprintOrder";

export class TasksViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "flowdeck.tasks";
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
    const cfg = getConfig();
    await this.onMessage({ type: "fetch", filter: (cfg.defaultFilter as Filter) || "unassigned", size: "any" });
  }

  private async onMessage(m: InboundMessage): Promise<void> {
    const cfg = getConfig();
    this.log(`webview → host: ${m.type}`);
    try {
      switch (m.type) {
        case "ready": {
          const authed = await this.auth.isAuthenticated();
          const me = authed ? await this.client().currentUserName() : null;
          this.post({ type: "state", authed, project: cfg.project, me });
          if (authed) await this.onMessage({ type: "fetch", filter: (cfg.defaultFilter as Filter) || "unassigned", size: "any" });
          break;
        }
        case "signIn": {
          await vscode.commands.executeCommand("flowdeck.signIn");
          break;
        }
        case "openExternal": {
          await vscode.env.openExternal(vscode.Uri.parse(m.url));
          break;
        }
        case "fetch": {
          if (!(await this.auth.isAuthenticated())) {
            this.post({ type: "state", authed: false, project: cfg.project, me: null });
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
        this.post({ type: "state", authed: false, project: cfg.project, me: null });
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
      this.post({ type: "state", authed: false, project: cfg.project, me: null });
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
      this.post({ type: "state", authed: false, project: cfg.project, me: null });
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

  /** Explore flow: pick repos freely (no ticket), open a workspace, and seed a Claude Code
   * agent for investigation/knowledge — a Jira ticket can come out of it later. */
  public async explore(): Promise<void> {
    const cfg = getConfig();
    const repos = discoverRepos(cfg.reposRoot, cfg.repoBlocklist);
    if (repos.length === 0) {
      this.toast("error", `No repos found under ${cfg.reposRoot}. Check flowdeck.reposRoot.`);
      return;
    }

    const raw = await vscode.window.showInputBox({
      title: "Explore — what do you want to dig into?",
      prompt: "A focus for the session (optional). A Jira ticket can come later.",
      placeHolder: "e.g. how the aggregator retries failed scans",
      ignoreFocusOut: true,
    });
    if (raw === undefined) return; // cancelled (empty is allowed → generic focus)
    const topic = raw.trim() || "Codebase exploration";

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
    const services = picks.map((p) => p.repo);

    const mode = await this.chooseWorkspaceMode(services.length, cfg.workspaceMode, "Explore");
    if (!mode) return;

    const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "explore";
    const planMd = `## Exploration: ${topic}\n\n_No Jira ticket yet — a knowledge/exploration session. If it turns into work, open a ticket afterwards._`;
    const result = await openWorkspace({
      ticket: { key: `explore-${slug}`, summary: topic, url: "" },
      planMd,
      descriptionText: "",
      services,
      mode,
      promptTemplate: cfg.explorePrompt,
      workspaceDir: cfg.workspaceDir,
      seedAgent: cfg.seedAgent,
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
    setting: FlowDeckConfig["workspaceMode"],
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

  /** The pick flow: read ticket → infer services → confirm → choose mode → open + seed.
   * `preselected` (from the in-card selection) skips the service QuickPick. */
  public async takeTask(key: string, preselected?: string[]): Promise<void> {
    const cfg = getConfig();
    if (!(await this.auth.isAuthenticated())) {
      const ok = await vscode.commands.executeCommand<boolean>("flowdeck.signIn");
      if (!ok) return;
    }

    const detail = await vscode.window.withProgress(
      { location: { viewId: TasksViewProvider.viewType }, title: `Reading ${key}…` },
      () => this.client().getDetail(key),
    );

    const repos = discoverRepos(cfg.reposRoot, cfg.repoBlocklist);
    if (repos.length === 0) {
      this.toast("error", `No repos found under ${cfg.reposRoot}. Check flowdeck.reposRoot.`);
      return;
    }
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

      // Confirm the service set (inferred ones pre-selected).
      const picks = await vscode.window.showQuickPick<vscode.QuickPickItem & { repo: ServiceRef }>(
        repos.map((r) => ({
          label: r.name,
          description: inferredNames.has(r.name) ? `inferred (${inferred.find((i) => i.service.name === r.name)!.reason})` : "",
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
      if (!picks || picks.length === 0) return;
      services = picks.map((p) => p.repo);
    }
    if (services.length === 0) {
      this.toast("error", "No valid repos selected for this task.");
      return;
    }

    // How should the agent start — pick a prompt mode (or use the configured default).
    const modes = cfg.promptModes;
    let promptMode: PromptMode | undefined = modes.find((m) => m.id === cfg.taskMode);
    if (!promptMode) {
      const p = await vscode.window.showQuickPick(
        modes.map((mm) => ({
          label: mm.label,
          detail: mm.prompt.replace(/\{[a-z]+\}/g, "").replace(/\s+/g, " ").trim().slice(0, 80),
          mode: mm,
        })),
        { title: `${key} — how should the agent start?`, ignoreFocusOut: true },
      );
      if (!p) return;
      promptMode = p.mode;
    }

    // Isolate in a git worktree?
    let useWorktree: boolean;
    if (cfg.worktree === "always") useWorktree = true;
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
      services = createWorktrees(services, detail.key, detail.summary, cfg.worktreeRoot, this.log);
    }

    // Where should it open — a new window, or reuse the current one?
    const openIn = await this.chooseOpenTarget(cfg);
    if (!openIn) return;

    // Workspace model. In the current window everything shares one window, so the
    // multiroot/per-window question only applies when opening a new window.
    let mode: WorkspaceMode;
    if (openIn === "current") {
      mode = services.length === 1 ? "per-window" : "multiroot";
    } else if (services.length === 1 || cfg.workspaceMode === "per-window") {
      mode = "per-window";
    } else if (cfg.workspaceMode === "ask") {
      const p = await vscode.window.showQuickPick(
        [
          { label: "$(window) One multi-root workspace", detail: "Single window, all repos", mode: "multiroot" as WorkspaceMode },
          { label: "$(multiple-windows) One window per repo", detail: "Parallel, one per repo", mode: "per-window" as WorkspaceMode },
        ],
        { title: `${key} — how should I open ${services.length} repos?`, ignoreFocusOut: true },
      );
      if (!p) return;
      mode = p.mode;
    } else {
      mode = "multiroot"; // "auto" (>1 repo) or "multiroot"
    }

    const planMd = this.buildBrief(detail);
    const result = await openWorkspace({
      ticket: { key: detail.key, summary: detail.summary, url: detail.url },
      planMd,
      descriptionText: detail.descriptionText,
      services,
      mode,
      promptTemplate: promptMode.prompt,
      workspaceDir: cfg.workspaceDir,
      seedAgent: cfg.seedAgent,
      openIn,
    });

    const where = result.workspaceFile
      ? `workspace ${result.workspaceFile.split("/").pop()}`
      : `${result.opened.length} window(s)`;
    const seeded = cfg.seedAgent ? " Claude Code pre-seeded — press Enter to start." : "";
    this.toast("success", `Opened ${where} for ${key}. Brief seeded in each repo.${seeded}`);
  }

  /** Where to open a taken task — reuse the current window or spawn a new one. */
  private async chooseOpenTarget(cfg: FlowDeckConfig): Promise<"new" | "current" | undefined> {
    if (cfg.openIn === "new-window") return "new";
    if (cfg.openIn === "this-window") return "current";
    const p = await vscode.window.showQuickPick(
      [
        { label: "$(empty-window) New window", detail: "Open the task in a separate window", val: "new" as const },
        { label: "$(window) This window", detail: "Open it in the current window (replaces what's here)", val: "current" as const },
      ],
      { title: "Open the task where?", placeHolder: "New window, or reuse this one", ignoreFocusOut: true },
    );
    return p?.val;
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
