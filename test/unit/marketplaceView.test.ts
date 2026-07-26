import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { window, ViewColumn, env, commands, workspace } from "../_mocks/vscode";
import { fakeContext } from "../_helpers/factories";
import type { ClaudeAssetsView } from "../../src/types";

const h = vi.hoisted(() => ({
  scanClaudeAssets: vi.fn(),
  fsReader: vi.fn(() => ({})),
  claudeConfigDir: vi.fn(() => "/home/u/.claude"),
}));
vi.mock("../../src/engine/claudeAssets", () => ({ scanClaudeAssets: h.scanClaudeAssets }));
vi.mock("../../src/engine/claudeAssetsFs", () => ({ fsReader: h.fsReader, claudeConfigDir: h.claudeConfigDir }));

import { MarketplacePanel } from "../../src/marketplaceView";

const view = (over: Partial<ClaudeAssetsView> = {}): ClaudeAssetsView => ({
  marketplaces: [{ name: "atbay", kind: "github", origin: "org/atbay", pluginCount: 1, stale: false }],
  plugins: [],
  assets: [{
    type: "skill", name: "build", description: "d", plugin: "cicd", marketplace: "atbay",
    file: "/home/u/.claude/plugins/cache/atbay/cicd/1/skills/build/SKILL.md",
    rel: "skills/build/SKILL.md", enabled: true, state: "installed", category: "deployment",
  }],
  notSetUp: false,
  scannedAt: 1,
  ...over,
});
const lastPanel = () => window.createWebviewPanel.mock.results.at(-1)!.value as ReturnType<typeof import("../_mocks/vscode").makeWebviewPanel>;
const posts = (p: ReturnType<typeof lastPanel>) => p.webview.postMessage.mock.calls.map((c) => c[0] as any);
const show = () => MarketplacePanel.show(fakeContext().context as any, () => {});

beforeEach(() => {
  h.scanClaudeAssets.mockReset().mockReturnValue(view());
});
afterEach(() => {
  const r = window.createWebviewPanel.mock.results.at(-1);
  if (r) (r.value as any)._fireDispose();
});

describe("MarketplacePanel", () => {
  it("creates a singleton panel and wires html", () => {
    show();
    expect(window.createWebviewPanel).toHaveBeenCalledWith("agentFlow.marketplace", expect.any(String), ViewColumn.Active, expect.any(Object));
    expect(lastPanel().webview.html).toContain('<div id="root">');
    show();
    expect(window.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(lastPanel().reveal).toHaveBeenCalled();
  });

  it("posts mkt:assets on ready", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    const msg = posts(p).reverse().find((m) => m.type === "mkt:assets");
    expect(msg.view.assets).toHaveLength(1);
    expect(h.scanClaudeAssets).toHaveBeenCalled();
  });

  it("passes the workspace folder into the scan when one is open", async () => {
    workspace.workspaceFolders = [{ uri: { fsPath: "/ws/my-repo" } }] as any;
    show();
    await lastPanel()._fire({ type: "mkt:ready" });
    expect(h.scanClaudeAssets).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      claudeDir: "/home/u/.claude", workspaceDir: "/ws/my-repo", workspaceName: "my-repo",
    }));
  });

  it("rescans on mkt:refresh", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    h.scanClaudeAssets.mockClear();
    await p._fire({ type: "mkt:refresh" });
    expect(h.scanClaudeAssets).toHaveBeenCalledTimes(1);
  });

  it("brackets each scan with mkt:loading true/false", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    const loads = posts(p).filter((m) => m.type === "mkt:loading").map((m) => m.loading);
    expect(loads[0]).toBe(true);
    expect(loads.at(-1)).toBe(false);
  });

  it("opens a file that the last scan emitted", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    await p._fire({ type: "mkt:open", file: view().assets[0].file });
    expect(workspace.openTextDocument).toHaveBeenCalled();
    expect(window.showTextDocument).toHaveBeenCalled();
  });

  it("refuses to open a path the scan never emitted", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    await p._fire({ type: "mkt:open", file: "/etc/passwd" });
    expect(workspace.openTextDocument).not.toHaveBeenCalled();
    expect(posts(p).some((m) => m.type === "toast" && m.level === "error")).toBe(true);
  });

  it("reveals a known file in the OS file manager", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    await p._fire({ type: "mkt:reveal", file: view().assets[0].file });
    expect(commands.executeCommand).toHaveBeenCalledWith("revealFileInOS", expect.anything());
  });

  it("refuses to reveal an unknown path", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    await p._fire({ type: "mkt:reveal", file: "/etc/hosts" });
    expect(commands.executeCommand).not.toHaveBeenCalledWith("revealFileInOS", expect.anything());
  });

  it("copies text and toasts success", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:copy", text: "/plugin install x@y" });
    expect(env.clipboard.writeText).toHaveBeenCalledWith("/plugin install x@y");
    expect(posts(p).some((m) => m.type === "toast" && m.level === "success")).toBe(true);
  });

  it("opens an external url via the host", async () => {
    show();
    await lastPanel()._fire({ type: "openExternal", url: "https://example.com" });
    expect(env.openExternal).toHaveBeenCalled();
  });

  it("rescans when the panel becomes visible again after the stale window", async () => {
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(0);
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    h.scanClaudeAssets.mockClear();
    nowSpy.mockReturnValue(60_000);
    await p._fireViewState();
    expect(h.scanClaudeAssets).toHaveBeenCalledTimes(1);
    nowSpy.mockRestore();
  });

  it("does not rescan on a visibility change inside the stale window", async () => {
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(0);
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    h.scanClaudeAssets.mockClear();
    nowSpy.mockReturnValue(1_000);
    await p._fireViewState();
    expect(h.scanClaudeAssets).not.toHaveBeenCalled();
    nowSpy.mockRestore();
  });

  it("still posts a view when the scan throws", async () => {
    h.scanClaudeAssets.mockImplementation(() => { throw new Error("boom"); });
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    const msg = posts(p).reverse().find((m) => m.type === "mkt:assets");
    expect(msg.view.assets).toEqual([]);
    expect(msg.view.notSetUp).toBe(true);
  });
});
