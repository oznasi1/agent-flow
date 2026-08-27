import * as vscode from "vscode";
import { scanClaudeAssets } from "./engine/claudeAssets";
import { claudeConfigDir, fsReader } from "./engine/claudeAssetsFs";
import { InboundMessage, OutboundMessage, ClaudeAssetsView } from "./types";

const STALE_MS = 30_000; // re-scan on re-focus only if the last scan is older than this
const MAX_PREVIEW = 262_144; // chars, not bytes — bounds parse/render cost, which scales with length

/** The Marketplace: a searchable board of every Claude Code skill, command, agent
 * and hook on this machine. Singleton editor-area panel; strictly read-only. */
export class MarketplacePanel {
  private static current: MarketplacePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  /** Paths the last scan emitted — the allow-list for open/reveal. */
  private openable = new Set<string>();
  private lastScan = 0;

  static show(context: vscode.ExtensionContext, log: (m: string) => void): void {
    if (MarketplacePanel.current) {
      MarketplacePanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "agentFlow.marketplace",
      "Agent Flow Deck — Marketplace",
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
    // Cheap enough (a full scan measured ~0.2s) that re-focus after a pause just rescans.
    this.panel.onDidChangeViewState(
      () => {
        if (this.panel.visible && Date.now() - this.lastScan > STALE_MS) this.render();
      },
      null,
      this.disposables,
    );
  }

  private post(msg: OutboundMessage): void {
    try {
      void this.panel.webview.postMessage(msg);
    } catch {
      // A disposed panel's `postMessage` throws synchronously — a normal race
      // (the user closed the Marketplace while an async step, e.g. mkt:copy's
      // clipboard await, was still in flight), not a bug worth logging. Letting
      // it escape used to strand whatever ran after this call in the caller.
    }
  }
  private toast(level: "success" | "error" | "info", message: string): void {
    this.post({ type: "toast", level, message });
  }

  private scan(): ClaudeAssetsView {
    const workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return scanClaudeAssets(fsReader(), {
      claudeDir: claudeConfigDir(),
      workspaceDir,
      workspaceName: workspaceDir ? workspaceDir.split("/").filter(Boolean).pop() : undefined,
      now: Date.now(),
    });
  }

  private render(): void {
    this.post({ type: "mkt:loading", loading: true });
    let view: ClaudeAssetsView;
    try {
      view = this.scan();
    } catch (e) {
      this.log(`marketplace: scan failed: ${e}`);
      view = { marketplaces: [], plugins: [], assets: [], notSetUp: true, scannedAt: Date.now() };
    }
    this.lastScan = Date.now();
    this.openable = new Set([
      ...view.assets.map((a) => a.file),
      ...view.plugins.map((p) => p.readme).filter(Boolean),
    ]);
    this.post({ type: "mkt:assets", view });
    this.post({ type: "mkt:loading", loading: false });
  }

  /** Only paths the last scan emitted may be opened — the webview must never be
   * able to talk the host into opening an arbitrary file. */
  private allowed(file: string): boolean {
    if (this.openable.has(file)) return true;
    this.log(`marketplace: refused to open unlisted path ${file}`);
    this.toast("error", "That file isn't part of the current scan.");
    return false;
  }

  private async onMessage(m: InboundMessage): Promise<void> {
    switch (m.type) {
      case "mkt:ready":
      case "mkt:refresh":
        this.render();
        break;
      case "mkt:open": {
        if (!this.allowed(m.file)) return;
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(m.file));
        await vscode.window.showTextDocument(doc, { preview: true });
        break;
      }
      case "mkt:reveal":
        if (!this.allowed(m.file)) return;
        await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(m.file));
        break;
      case "mkt:read": {
        if (!this.allowed(m.file)) return;
        const raw = fsReader().readFile(m.file) ?? "";
        const truncated = raw.length > MAX_PREVIEW;
        this.post({
          type: "mkt:file",
          file: m.file,
          text: truncated ? raw.slice(0, MAX_PREVIEW) : raw,
          truncated,
        });
        break;
      }
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
