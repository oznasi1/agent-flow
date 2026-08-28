import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { window, ViewColumn, env, commands, workspace } from "../_mocks/vscode";
import { fakeContext } from "../_helpers/factories";
import type { ClaudeAssetsView } from "../../src/types";

const h = vi.hoisted(() => ({
  scanClaudeAssets: vi.fn(),
  readFile: vi.fn<(p: string) => string | null>(() => null),
  fsReader: vi.fn(),
  claudeConfigDir: vi.fn(() => "/home/u/.claude"),
}));
h.fsReader.mockImplementation(() => ({ readFile: h.readFile, readDir: () => [], isDir: () => false }));
vi.mock("../../src/engine/claudeAssets", () => ({ scanClaudeAssets: h.scanClaudeAssets }));
vi.mock("../../src/engine/claudeAssetsFs", () => ({ fsReader: h.fsReader, claudeConfigDir: h.claudeConfigDir }));

// Telemetry: mocked wholesale, same pattern as tasksView/deckView's test files, so the
// marketplace_opened/marketplace_action/operation_failed assertions below observe track()
// calls without a real PostHog singleton.
const trackSpy = vi.fn();
const trackErrorSpy = vi.fn();
vi.mock("../../src/telemetry/telemetry", () => ({
  track: (...a: unknown[]) => trackSpy(...a),
  trackError: (...a: unknown[]) => trackErrorSpy(...a),
}));

import { MarketplacePanel } from "../../src/marketplaceView";

const view = (over: Partial<ClaudeAssetsView> = {}): ClaudeAssetsView => ({
  marketplaces: [{ name: "acme", kind: "github", origin: "org/acme", pluginCount: 1, stale: false }],
  plugins: [],
  assets: [{
    type: "skill", name: "build", description: "d", plugin: "cicd", marketplace: "acme",
    file: "/home/u/.claude/plugins/cache/acme/cicd/1/skills/build/SKILL.md",
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
  h.readFile.mockReset().mockReturnValue(null);
  trackSpy.mockClear();
  trackErrorSpy.mockClear();
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

describe("MarketplacePanel file preview", () => {
  const FILE = "/home/u/.claude/plugins/cache/acme/cicd/1/skills/build/SKILL.md";

  it("returns a listed file's contents", async () => {
    h.readFile.mockReturnValue("# Build\n");
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    await p._fire({ type: "mkt:read", file: FILE });
    expect(posts(p).at(-1)).toEqual({ type: "mkt:file", file: FILE, text: "# Build\n", truncated: false });
  });

  it("returns empty text rather than an error when the file cannot be read", async () => {
    h.readFile.mockReturnValue(null);
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    await p._fire({ type: "mkt:read", file: FILE });
    expect(posts(p).at(-1)).toEqual({ type: "mkt:file", file: FILE, text: "", truncated: false });
  });

  it("refuses a path the last scan never listed", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    await p._fire({ type: "mkt:read", file: "/etc/passwd" });
    expect(posts(p).some((m) => m.type === "mkt:file")).toBe(false);
    expect(posts(p).at(-1).type).toBe("toast");
  });

  it("serves a plugin README, which the scan lists alongside asset files", async () => {
    h.scanClaudeAssets.mockReturnValue(view({
      plugins: [{
        name: "cicd", marketplace: "acme", description: "d", state: "installed", enabled: true,
        scopes: [], version: "", counts: { skill: 0, command: 0, agent: 0, hook: 0 },
        category: "deployment", readme: "/mk/cicd/README.md", installCommand: "",
      }],
    }));
    h.readFile.mockReturnValue("# cicd");
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    await p._fire({ type: "mkt:read", file: "/mk/cicd/README.md" });
    expect(posts(p).at(-1)).toMatchObject({ type: "mkt:file", text: "# cicd" });
  });

  it("truncates at 256 KB and says so", async () => {
    h.readFile.mockReturnValue("x".repeat(262_145));
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    await p._fire({ type: "mkt:read", file: FILE });
    const msg = posts(p).at(-1);
    expect(msg.truncated).toBe(true);
    expect(msg.text).toHaveLength(262_144);
  });

  it("does not flag a file that lands exactly on the boundary", async () => {
    h.readFile.mockReturnValue("x".repeat(262_144));
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    await p._fire({ type: "mkt:read", file: FILE });
    expect(posts(p).at(-1).truncated).toBe(false);
  });
});

describe("MarketplacePanel telemetry", () => {
  const FILE = "/home/u/.claude/plugins/cache/acme/cicd/1/skills/build/SKILL.md";
  const opened = () => trackSpy.mock.calls.flat().filter((e: any) => e.name === "marketplace_opened");
  const actions = () => trackSpy.mock.calls.flat().filter((e: any) => e.name === "marketplace_action");

  it("emits marketplace_opened{revealed:false} with real counts on a fresh open, and does not re-emit on a later re-render", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    expect(opened()).toEqual([
      {
        name: "marketplace_opened", revealed: false,
        asset_count: 1, plugin_count: 0, marketplace_count: 1,
        skills: 1, commands: 0, agents: 0, hooks: 0, not_set_up: false,
      },
    ]);
    // A later refresh re-scans but must not emit a second marketplace_opened.
    await p._fire({ type: "mkt:refresh" });
    expect(opened()).toHaveLength(1);
  });

  it("emits marketplace_opened{revealed:true} with the last-known counts when an already-open panel is refocused", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    trackSpy.mockClear();
    show(); // second show() while `current` is still set -> the reveal branch
    expect(opened()).toEqual([
      {
        name: "marketplace_opened", revealed: true,
        asset_count: 1, plugin_count: 0, marketplace_count: 1,
        skills: 1, commands: 0, agents: 0, hooks: 0, not_set_up: false,
      },
    ]);
    expect(p.reveal).toHaveBeenCalled();
  });

  it("reports zero counts on reveal if somehow refocused before any render completed", async () => {
    show();
    // No mkt:ready fired yet — counts must still be the zeroed default.
    show();
    expect(opened()).toEqual([
      {
        name: "marketplace_opened", revealed: true,
        asset_count: 0, plugin_count: 0, marketplace_count: 0,
        skills: 0, commands: 0, agents: 0, hooks: 0, not_set_up: false,
      },
    ]);
  });

  it("emits marketplace_action{action:'read', truncated:true} for an oversized file", async () => {
    h.readFile.mockReturnValue("x".repeat(262_145));
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    await p._fire({ type: "mkt:read", file: FILE });
    expect(actions()).toContainEqual({ name: "marketplace_action", action: "read", truncated: true });
  });

  it("emits marketplace_action{action:'open', allowed:true/false} for mkt:open", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    await p._fire({ type: "mkt:open", file: FILE });
    await p._fire({ type: "mkt:open", file: "/etc/passwd" });
    expect(actions()).toContainEqual({ name: "marketplace_action", action: "open", allowed: true });
    expect(actions()).toContainEqual({ name: "marketplace_action", action: "open", allowed: false });
  });

  it("emits marketplace_action{action:'reveal', allowed:true/false} for mkt:reveal", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    await p._fire({ type: "mkt:reveal", file: FILE });
    await p._fire({ type: "mkt:reveal", file: "/etc/hosts" });
    expect(actions()).toContainEqual({ name: "marketplace_action", action: "reveal", allowed: true });
    expect(actions()).toContainEqual({ name: "marketplace_action", action: "reveal", allowed: false });
  });

  it("emits marketplace_action{action:'copy'} for mkt:copy", async () => {
    show();
    await lastPanel()._fire({ type: "mkt:copy", text: "/plugin install x@y" });
    expect(actions()).toContainEqual({ name: "marketplace_action", action: "copy" });
  });

  it("reports operation_failed{op:'marketplace_read'} when the scan throws", async () => {
    h.scanClaudeAssets.mockImplementation(() => { throw new Error("boom"); });
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    const ev = trackErrorSpy.mock.calls.flat().find((e: any) => e.name === "operation_failed") as any;
    expect(ev).toMatchObject({ name: "operation_failed", op: "marketplace_read", retryable: true });
    expect(ev.failure_class).toBeTruthy();
  });

  it("does not open a file:// URL — the openExternal scheme guard allows only http(s)", async () => {
    show();
    await lastPanel()._fire({ type: "openExternal", url: "file:///etc/passwd" });
    expect(env.openExternal).not.toHaveBeenCalled();
  });

  it("still opens an https:// URL through the scheme guard", async () => {
    show();
    await lastPanel()._fire({ type: "openExternal", url: "https://example.com" });
    expect(env.openExternal).toHaveBeenCalled();
  });

  it("never leaks a file path, asset name, or URL into a telemetry call", async () => {
    h.readFile.mockReturnValue("secret contents");
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    await p._fire({ type: "mkt:open", file: FILE });
    await p._fire({ type: "mkt:reveal", file: FILE });
    await p._fire({ type: "mkt:read", file: FILE });
    await p._fire({ type: "mkt:copy", text: "/plugin install x@y" });
    await p._fire({ type: "openExternal", url: "https://example.com/secret-path" });
    const serialized = JSON.stringify([...trackSpy.mock.calls.flat(), ...trackErrorSpy.mock.calls.flat()]);
    expect(serialized).not.toContain(FILE);
    expect(serialized).not.toContain("example.com");
    expect(serialized).not.toContain("build");
  });
});

describe("MarketplacePanel post-after-dispose", () => {
  it("mkt:copy still resolves when the panel was disposed during the clipboard await", async () => {
    // A disposed panel's postMessage throws synchronously — the same race
    // deckView's post() already absorbs: the user closes the panel while the
    // `await clipboard.writeText` is still in flight, and the success toast
    // lands on a dead webview. That must not become an unhandled rejection.
    show();
    const p = lastPanel();
    p.webview.postMessage.mockImplementation(() => {
      throw new Error("Webview is disposed");
    });
    await expect(p._fire({ type: "mkt:copy", text: "/plugin install x@y" })).resolves.toBeUndefined();
    expect(env.clipboard.writeText).toHaveBeenCalledWith("/plugin install x@y");
  });

  it("a scan render onto a disposed panel resolves too", async () => {
    show();
    const p = lastPanel();
    p.webview.postMessage.mockImplementation(() => {
      throw new Error("Webview is disposed");
    });
    await expect(p._fire({ type: "mkt:ready" })).resolves.toBeUndefined();
  });
});

describe("MarketplacePanel message handling never dies silently", () => {
  it("toasts an error when a listed file was deleted between scan and click", async () => {
    // The file passed the allow-list at scan time but is gone by click time:
    // openTextDocument rejects, and the discarded promise used to make the row
    // do nothing forever with nothing logged.
    const log = vi.fn();
    MarketplacePanel.show(fakeContext().context as any, log);
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    workspace.openTextDocument.mockRejectedValue(new Error("cannot open file:///gone.md"));
    await expect(p._fire({ type: "mkt:open", file: view().assets[0].file })).resolves.toBeUndefined();
    expect(posts(p).some((m) => m.type === "toast" && m.level === "error")).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("cannot open"));
  });

  it("ignores an openExternal with no url instead of parsing undefined", async () => {
    // The test mock's Uri.parse is lenient; the real one throws on undefined.
    // What is pinned here is the guard: no url, no call.
    show();
    const p = lastPanel();
    await expect(p._fire({ type: "openExternal" })).resolves.toBeUndefined();
    expect(env.openExternal).not.toHaveBeenCalled();
  });

  it("ignores a mkt:copy with no text rather than writing undefined to the clipboard", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:copy" });
    expect(env.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("logs an unknown message type instead of letting it vanish", async () => {
    const log = vi.fn();
    MarketplacePanel.show(fakeContext().context as any, log);
    await lastPanel()._fire({ type: "mkt:definitely-not-a-thing" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("mkt:definitely-not-a-thing"));
  });
});
