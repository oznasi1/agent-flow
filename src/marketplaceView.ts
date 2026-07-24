import * as vscode from "vscode";
import { fetchMarketplace, normalizeRepo } from "./engine/marketplace";
import { InboundMessage, OutboundMessage, MarketplaceView } from "./types";

const CACHE_TTL_MS = 60 * 60 * 1000; // 1h — marketplace contents are effectively static

/** The Marketplace: a full-window board of registered plugin-marketplace repos and
 * their plugins/skills. Singleton editor-area panel; read-only (browse + copy). */
export class MarketplacePanel {
  private static current: MarketplacePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly cache = new Map<string, { at: number; view: MarketplaceView }>();

  static show(context: vscode.ExtensionContext, log: (m: string) => void): void {
    if (MarketplacePanel.current) {
      MarketplacePanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "agentFlow.marketplace",
      "Agent Flow — Marketplace",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [context.extensionUri] },
    );
    MarketplacePanel.current = new MarketplacePanel(panel, context, log);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly log: (m: string) => void,
  ) {
    this.panel = panel;
    this.panel.webview.html = this.html(this.panel.webview);
    this.panel.webview.onDidReceiveMessage((m: InboundMessage) => this.onMessage(m), null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private post(msg: OutboundMessage): void {
    void this.panel.webview.postMessage(msg);
  }
  private toast(level: "success" | "error" | "info", message: string): void {
    this.post({ type: "toast", level, message });
  }

  private repos(): string[] {
    const v = vscode.workspace.getConfiguration("agentFlow").get<string[]>("marketplaces");
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    for (const x of v) {
      if (typeof x !== "string" || !x.length) continue;
      const n = normalizeRepo(x);
      if (n && !out.includes(n)) out.push(n);
    }
    return out;
  }
  private async writeRepos(next: string[]): Promise<void> {
    await vscode.workspace.getConfiguration("agentFlow").update("marketplaces", next, vscode.ConfigurationTarget.Global);
  }

  private async view(repo: string, force: boolean): Promise<MarketplaceView> {
    const hit = this.cache.get(repo);
    if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.view;
    const view = await fetchMarketplace(repo);
    this.cache.set(repo, { at: Date.now(), view });
    return view;
  }

  private async render(force: boolean): Promise<void> {
    this.post({ type: "mkt:loading", loading: true });
    const repos = this.repos();
    const marketplaces: MarketplaceView[] = [];
    for (const repo of repos) {
      try {
        marketplaces.push(await this.view(repo, force));
      } catch (e) {
        this.log(`marketplace: unexpected failure for ${repo}: ${e}`);
        marketplaces.push({ repo, name: repo, description: "", owner: "", addCommand: `/plugin marketplace add ${repo}`, plugins: [], error: { kind: "unknown", message: "Couldn't load this marketplace." } });
      }
    }
    this.post({ type: "mkt:state", marketplaces });
    this.post({ type: "mkt:loading", loading: false });
  }

  private async onMessage(m: InboundMessage): Promise<void> {
    switch (m.type) {
      case "mkt:ready":
        await this.render(false);
        break;
      case "mkt:refresh":
        this.cache.clear();
        await this.render(true);
        break;
      case "mkt:add": {
        const repo = normalizeRepo(m.repo);
        if (!repo) {
          this.toast("error", `"${m.repo}" isn't a GitHub repo (use owner/repo or a github.com URL).`);
          return;
        }
        const current = this.repos();
        if (!current.includes(repo)) await this.writeRepos([...current, repo]);
        await this.render(false);
        break;
      }
      case "mkt:remove":
        await this.writeRepos(this.repos().filter((r) => r !== m.repo));
        this.cache.delete(m.repo);
        await this.render(false);
        break;
      case "mkt:copy":
        await vscode.env.clipboard.writeText(m.text);
        this.toast("success", "Copied to clipboard.");
        break;
      case "openExternal":
        await vscode.env.openExternal(vscode.Uri.parse(m.url));
        break;
    }
  }

  private dispose(): void {
    MarketplacePanel.current = undefined;
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "marketplace.js"));
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
