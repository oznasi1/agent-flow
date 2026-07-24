import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { window, ViewColumn, env, workspace, setConfig, ConfigurationTarget } from "../_mocks/vscode";
import { fakeContext } from "../_helpers/factories";
import type { MarketplaceView } from "../../src/types";

const h = vi.hoisted(() => ({
  fetchMarketplace: vi.fn(),
  normalizeRepo: vi.fn((s: string): string | null => s),
}));
vi.mock("../../src/engine/marketplace", () => ({
  fetchMarketplace: h.fetchMarketplace,
  normalizeRepo: h.normalizeRepo,
}));

import { MarketplacePanel } from "../../src/marketplaceView";

const mkView = (over: Partial<MarketplaceView> = {}): MarketplaceView => ({
  repo: "o/r", name: "mkt", description: "", owner: "", addCommand: "/plugin marketplace add o/r", plugins: [], ...over,
});
const lastPanel = () => window.createWebviewPanel.mock.results.at(-1)!.value as ReturnType<typeof import("../_mocks/vscode").makeWebviewPanel>;
const posts = (p: ReturnType<typeof lastPanel>) => p.webview.postMessage.mock.calls.map((c) => c[0] as any);
const show = () => MarketplacePanel.show(fakeContext().context as any, () => {});

beforeEach(() => {
  setConfig({ marketplaces: ["o/r"] });
  h.fetchMarketplace.mockReset().mockResolvedValue(mkView());
  h.normalizeRepo.mockReset().mockImplementation((s: string) => (s.includes("/") ? s : null));
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

  it("posts mkt:state with a fetched view on ready", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    const state = posts(p).reverse().find((m) => m.type === "mkt:state");
    expect(state.marketplaces).toHaveLength(1);
    expect(state.marketplaces[0].name).toBe("mkt");
    expect(h.fetchMarketplace).toHaveBeenCalledWith("o/r");
  });

  it("adds a repo: normalizes, writes global config, fetches, re-posts", async () => {
    setConfig({ marketplaces: [] });
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:add", repo: "new/repo" });
    expect(workspace.getConfiguration("agentFlow").get("marketplaces")).toContain("new/repo");
    expect(h.fetchMarketplace).toHaveBeenCalledWith("new/repo");
    expect(posts(p).some((m) => m.type === "mkt:state")).toBe(true);
  });

  it("rejects an invalid repo with an error toast and no config write", async () => {
    setConfig({ marketplaces: [] });
    h.normalizeRepo.mockReturnValue(null);
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:add", repo: "garbage" });
    expect(posts(p).some((m) => m.type === "toast" && m.level === "error")).toBe(true);
    expect(workspace.getConfiguration("agentFlow").get("marketplaces")).toEqual([]);
  });

  it("does not add a duplicate repo", async () => {
    setConfig({ marketplaces: ["o/r"] });
    show();
    await lastPanel()._fire({ type: "mkt:add", repo: "o/r" });
    expect(workspace.getConfiguration("agentFlow").get("marketplaces")).toEqual(["o/r"]);
  });

  it("removes a repo from config and re-posts", async () => {
    setConfig({ marketplaces: ["o/r", "a/b"] });
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:remove", repo: "o/r" });
    expect(workspace.getConfiguration("agentFlow").get("marketplaces")).toEqual(["a/b"]);
    expect(posts(p).some((m) => m.type === "mkt:state")).toBe(true);
  });

  it("copies text to the clipboard and toasts success", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:copy", text: "/plugin install x@y" });
    expect(env.clipboard.writeText).toHaveBeenCalledWith("/plugin install x@y");
    expect(posts(p).some((m) => m.type === "toast" && m.level === "success")).toBe(true);
  });

  it("opens an external url via the host", async () => {
    show();
    await lastPanel()._fire({ type: "openExternal", url: "https://github.com/o/r" });
    expect(env.openExternal).toHaveBeenCalled();
  });

  it("refresh re-fetches even when cached", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    h.fetchMarketplace.mockClear();
    await p._fire({ type: "mkt:refresh" });
    expect(h.fetchMarketplace).toHaveBeenCalledWith("o/r");
  });

  it("renders a scoped error view without throwing", async () => {
    h.fetchMarketplace.mockResolvedValue(mkView({ error: { kind: "repo-not-found", message: "nope" } }));
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    const state = posts(p).reverse().find((m) => m.type === "mkt:state");
    expect(state.marketplaces[0].error.kind).toBe("repo-not-found");
  });
});
