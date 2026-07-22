import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { getConfig } from "./config";
import { JiraAuth } from "./jira/auth";
import { JiraClient, JiraAuthError } from "./jira/client";
import { readRuns, defaultRunsDir, removeRun } from "./engine/runs";
import { buildRunStatus } from "./engine/status";
import { readLiveWindows, defaultWindowsDir } from "./engine/presence";
import { openInEditor } from "./engine/workspace";
import { InboundMessage, OutboundMessage, Run, RunStatus } from "./types";

const POLL_MS = 6000;
const JIRA_TTL_MS = 30_000;

/** The Deck: a full-window board of every task launched via Agent Flow, opened as a
 * singleton editor-area panel. Reuses the Jira client, runs store, and status engine. */
export class DeckPanel {
  private static current: DeckPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private liveSignal = true;
  private readonly jiraCache = new Map<string, { at: number; status: string | null; category: string | null }>();

  static show(context: vscode.ExtensionContext, auth: JiraAuth, log: (m: string) => void): void {
    if (DeckPanel.current) {
      DeckPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "agentFlow.deck",
      "Agent Flow — In-flight",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [context.extensionUri] },
    );
    DeckPanel.current = new DeckPanel(panel, context, auth, log);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly auth: JiraAuth,
    private readonly log: (m: string) => void,
  ) {
    this.panel = panel;
    this.panel.webview.html = this.html(this.panel.webview);
    this.panel.webview.onDidReceiveMessage((m: InboundMessage) => this.onMessage(m), null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.onDidChangeViewState(
      () => (this.panel.visible ? this.startPolling() : this.stopPolling()),
      null,
      this.disposables,
    );
    this.startPolling();
  }

  private post(msg: OutboundMessage): void {
    void this.panel.webview.postMessage(msg);
  }

  private toast(level: "success" | "error" | "info", message: string): void {
    this.post({ type: "toast", level, message });
  }

  private client(): JiraClient {
    const cfg = getConfig();
    return new JiraClient(cfg.baseUrl, cfg.project, this.auth);
  }

  private startPolling(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), POLL_MS);
  }

  private stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async jiraStatus(key: string): Promise<{ status: string | null; category: string | null } | null> {
    const hit = this.jiraCache.get(key);
    if (hit && Date.now() - hit.at < JIRA_TTL_MS) return { status: hit.status, category: hit.category };
    try {
      const s = await this.client().getStatus(key);
      this.jiraCache.set(key, { at: Date.now(), ...s });
      return s;
    } catch (e) {
      if (e instanceof JiraAuthError) return null; // git backbone still renders
      this.log(`deck: jira status ${key} failed: ${e}`);
      return hit ? { status: hit.status, category: hit.category } : null;
    }
  }

  private async buildAll(): Promise<RunStatus[]> {
    const runs = readRuns(defaultRunsDir());
    const projectsRoot = path.join(os.homedir(), ".claude", "projects");
    const now = Date.now();
    const authed = await this.auth.isAuthenticated();
    const openIdentities = new Set(readLiveWindows(defaultWindowsDir()).map((w) => w.identity));
    const out: RunStatus[] = [];
    for (const run of runs) {
      const jira = authed ? await this.jiraStatus(run.key) : null;
      out.push(buildRunStatus(run, jira, projectsRoot, now, this.liveSignal, openIdentities));
    }
    return out;
  }

  private async refresh(): Promise<void> {
    try {
      const runs = await this.buildAll();
      this.post({ type: "deck:runs", runs, liveSignal: this.liveSignal });
    } catch (e) {
      this.log(`deck: refresh failed: ${e}`);
    }
  }

  private async onMessage(m: InboundMessage): Promise<void> {
    switch (m.type) {
      case "deck:ready":
      case "deck:refresh":
        this.post({ type: "deck:loading", loading: true });
        await this.refresh();
        this.post({ type: "deck:loading", loading: false });
        break;
      case "deck:setLive":
        this.liveSignal = m.on;
        await this.refresh();
        break;
      case "deck:inspect":
        await this.inspect(m.key, m.action, m.repo);
        break;
      case "deck:forget":
        removeRun(defaultRunsDir(), m.key);
        await this.refresh();
        break;
      case "openExternal":
        await vscode.env.openExternal(vscode.Uri.parse(m.url));
        break;
    }
  }

  private run(key: string): Run | undefined {
    return readRuns(defaultRunsDir()).find((r) => r.key === key);
  }

  private async inspect(key: string, action: "open" | "diff", repoName?: string): Promise<void> {
    const run = this.run(key);
    if (!run) {
      this.toast("error", `No run record for ${key}.`);
      return;
    }
    if (action === "open") {
      const target = run.workspaceFile ?? (repoName ? run.repos.find((r) => r.name === repoName)?.path : run.repos[0]?.path);
      if (!target) {
        this.toast("error", `Nothing to open for ${key}.`);
        return;
      }
      const ok = await openInEditor(target);
      if (!ok) this.toast("error", `Couldn't open ${key}.`);
      return;
    }
    // diff — show the working-tree changes vs HEAD as a read-only diff document.
    const repos = repoName ? run.repos.filter((r) => r.name === repoName) : run.repos;
    const chunks: string[] = [];
    for (const r of repos) {
      const d = this.gitDiff(r.path);
      if (d.trim()) chunks.push(run.repos.length > 1 ? `# ${r.name}\n${d}` : d);
    }
    if (chunks.length === 0) {
      this.toast("info", `No uncommitted changes for ${key}.`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument({ content: chunks.join("\n\n"), language: "diff" });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  private gitDiff(repoPath: string): string {
    try {
      return execFileSync("git", ["-C", repoPath, "diff", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] }).toString();
    } catch {
      return "";
    }
  }

  private dispose(): void {
    DeckPanel.current = undefined;
    this.stopPolling();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "deck.js"));
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
