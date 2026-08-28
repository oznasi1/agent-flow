import * as vscode from "vscode";
import { scanClaudeAssets } from "./engine/claudeAssets";
import { claudeConfigDir, fsReader } from "./engine/claudeAssetsFs";
import { InboundMessage, OutboundMessage, ClaudeAssetsView } from "./types";
import { track, trackError } from "./telemetry/telemetry";
import { classifyFailure } from "./telemetry/events";

/** The counts `marketplace_opened` reports — grouped by `AssetType` plus the
 * plugin/marketplace totals and `notSetUp`. Kept on the panel instance across
 * renders (see `MarketplacePanel.counts`) so a reveal of an already-open panel
 * can report the last scan's numbers without re-scanning. */
interface MarketplaceCounts {
  asset_count: number;
  plugin_count: number;
  marketplace_count: number;
  skills: number;
  commands: number;
  agents: number;
  hooks: number;
  not_set_up: boolean;
}

const ZERO_COUNTS: MarketplaceCounts = {
  asset_count: 0, plugin_count: 0, marketplace_count: 0,
  skills: 0, commands: 0, agents: 0, hooks: 0, not_set_up: false,
};

function countsOf(view: ClaudeAssetsView): MarketplaceCounts {
  return {
    asset_count: view.assets.length,
    plugin_count: view.plugins.length,
    marketplace_count: view.marketplaces.length,
    skills: view.assets.filter((a) => a.type === "skill").length,
    commands: view.assets.filter((a) => a.type === "command").length,
    agents: view.assets.filter((a) => a.type === "agent").length,
    hooks: view.assets.filter((a) => a.type === "hook").length,
    not_set_up: view.notSetUp,
  };
}

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
  /** The last scan's counts, for a reveal of an already-open panel — zeroed
   * until this instance's first render() completes. */
  private counts: MarketplaceCounts = ZERO_COUNTS;
  /** Guards `marketplace_opened{revealed:false}` to the first render() this
   * instance ever completes; later re-renders (stale re-focus, mkt:refresh) must
   * not re-emit it. */
  private openedEmitted = false;

  static show(context: vscode.ExtensionContext, log: (m: string) => void): void {
    if (MarketplacePanel.current) {
      track({ name: "marketplace_opened", revealed: true, ...MarketplacePanel.current.counts });
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
    void this.panel.webview.postMessage(msg);
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
      trackError({ name: "operation_failed", op: "marketplace_read", failure_class: classifyFailure(e), retryable: true });
      view = { marketplaces: [], plugins: [], assets: [], notSetUp: true, scannedAt: Date.now() };
    }
    this.lastScan = Date.now();
    this.openable = new Set([
      ...view.assets.map((a) => a.file),
      ...view.plugins.map((p) => p.readme).filter(Boolean),
    ]);
    this.counts = countsOf(view);
    if (!this.openedEmitted) {
      this.openedEmitted = true;
      track({ name: "marketplace_opened", revealed: false, ...this.counts });
    }
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
        const allowed = this.allowed(m.file);
        track({ name: "marketplace_action", action: "open", allowed });
        if (!allowed) return;
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(m.file));
        await vscode.window.showTextDocument(doc, { preview: true });
        break;
      }
      case "mkt:reveal": {
        const allowed = this.allowed(m.file);
        track({ name: "marketplace_action", action: "reveal", allowed });
        if (!allowed) return;
        await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(m.file));
        break;
      }
      case "mkt:read": {
        if (!this.allowed(m.file)) return;
        const raw = fsReader().readFile(m.file) ?? "";
        const truncated = raw.length > MAX_PREVIEW;
        track({ name: "marketplace_action", action: "read", truncated });
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
        track({ name: "marketplace_action", action: "copy" });
        this.toast("success", "Copied to clipboard.");
        break;
      case "openExternal": {
        track({ name: "marketplace_action", action: "open_external" });
        const u = vscode.Uri.parse(m.url);
        // Mirrors deckView's own openExternal guard: a check-run or plugin manifest
        // URL is not a trusted source for a scheme handed straight to the OS (e.g. a
        // vscode://<publisher>.<ext>/… reaching another extension's UriHandler).
        if (u.scheme !== "https" && u.scheme !== "http") break;
        await vscode.env.openExternal(u);
        break;
      }
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
