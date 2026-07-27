import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { window, ViewColumn, env } from "../_mocks/vscode";
import { fakeAuth, fakeContext } from "../_helpers/factories";
import type { Run, RunStatus } from "../../src/types";

// Isolate the panel from the engine: fixtures for runs, a pass-through status
// builder, and a stubbed workspace opener.
const h = vi.hoisted(() => ({
  runs: [] as Run[],
  openInEditor: vi.fn(async (_t: string) => true),
  buildRunStatus: vi.fn(),
  removeRun: vi.fn(),
  getStatus: vi.fn(async (_k: string) => ({ status: "In Review", category: "indeterminate" })),
  prEntries: {} as Record<string, unknown>,
  writePrEntry: vi.fn(),
  removePrEntries: vi.fn(),
  // Typed as the FetchResult union (not narrowed to `{ ok: true }` via inference)
  // so later tests can `mockResolvedValue({ ok: false })` without a type error.
  prFetch: vi.fn(
    async (_p: string, _b: string | null, _k: string): Promise<{ ok: true; facts: null } | { ok: false }> =>
      ({ ok: true, facts: null }),
  ),
  ghAvailable: vi.fn(async () => true),
  prFacts: true as boolean,
  ttlSeconds: 120,
}));
vi.mock("../../src/engine/runs", () => ({
  defaultRunsDir: () => "/runs",
  readRuns: () => h.runs,
  removeRun: h.removeRun,
}));
vi.mock("../../src/engine/status", () => ({ buildRunStatus: h.buildRunStatus }));
vi.mock("../../src/engine/workspace", () => ({ openInEditor: h.openInEditor }));
vi.mock("../../src/engine/presence", () => ({
  readLiveWindows: () => [],
  defaultWindowsDir: () => "/windows",
}));
vi.mock("../../src/engine/pr/store", () => ({
  defaultPrFactsDir: () => "/prfacts",
  readPrEntries: () => h.prEntries,
  writePrEntry: h.writePrEntry,
  removePrEntries: h.removePrEntries,
  // Exercise the real staleness rule rather than restating it here.
  isStale: (e: { fetchedAt: number } | undefined, ttl: number, now: number) => !e || now - e.fetchedAt >= ttl,
}));
vi.mock("../../src/engine/pr/provider", () => ({
  ghAvailable: h.ghAvailable,
  GhProvider: class { fetch = h.prFetch; },
}));
vi.mock("../../src/config", () => ({
  getConfig: () => ({ baseUrl: "https://jira", project: "ASM", prFacts: h.prFacts, prFactsTtlSeconds: h.ttlSeconds }),
}));
vi.mock("../../src/jira/client", () => ({
  JiraAuthError: class JiraAuthError extends Error {},
  JiraClient: class { getStatus = h.getStatus; },
}));

import { DeckPanel } from "../../src/deckView";
import { JiraAuthError } from "../../src/jira/client";

const mkRun = (over: Partial<Run> = {}): Run => ({
  key: "ASM-1", summary: "do it", url: "https://jira/ASM-1", createdAt: 1, mode: "per-window",
  repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "b" }], briefPaths: [], ...over,
});
const statusFor = (run: Run): RunStatus => ({
  run, column: "progress", jiraStatus: null, jiraCategory: null, repos: [],
  agent: { state: "unknown", lastActivityMs: null, slug: null }, windowOpen: false, prs: {},
});

const lastPanel = () => window.createWebviewPanel.mock.results.at(-1)!.value as ReturnType<typeof import("../_mocks/vscode").makeWebviewPanel>;
const posts = (p: ReturnType<typeof lastPanel>) => p.webview.postMessage.mock.calls.map((c) => c[0] as any);
const show = (authed = false) => DeckPanel.show(fakeContext().context as any, fakeAuth({ authed }), () => {});

beforeEach(() => {
  h.runs = [mkRun()];
  h.openInEditor.mockClear().mockResolvedValue(true);
  h.buildRunStatus.mockReset().mockImplementation((run: Run) => statusFor(run));
  h.removeRun.mockClear();
  h.getStatus.mockClear().mockResolvedValue({ status: "In Review", category: "indeterminate" });
  h.prEntries = {};
  h.prFacts = true;
  h.ttlSeconds = 120;
  h.writePrEntry.mockClear();
  h.removePrEntries.mockClear();
  h.prFetch.mockClear().mockResolvedValue({ ok: true, facts: null });
  h.ghAvailable.mockClear().mockResolvedValue(true);
});

afterEach(() => {
  // Dispose any open panel so the DeckPanel singleton resets between tests.
  const r = window.createWebviewPanel.mock.results.at(-1);
  if (r) (r.value as any)._fireDispose();
});

describe("DeckPanel", () => {
  it("creates a panel and wires its html on show", () => {
    show();
    expect(window.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(window.createWebviewPanel).toHaveBeenCalledWith("agentFlow.deck", expect.any(String), ViewColumn.Active, expect.any(Object));
    expect(lastPanel().webview.html).toContain("<div id=\"root\">");
  });

  it("is a singleton — a second show reveals rather than recreating", () => {
    show();
    const first = lastPanel();
    show();
    expect(window.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(first.reveal).toHaveBeenCalled();
  });

  it("posts reconciled runs on refresh", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:refresh" });
    const runsPost = posts(p).find((m) => m.type === "deck:runs");
    expect(runsPost).toBeTruthy();
    expect(runsPost.runs).toHaveLength(1);
    expect(runsPost.runs[0].run.key).toBe("ASM-1");
    expect(runsPost.liveSignal).toBe(true);
  });

  it("re-posts with liveSignal off when toggled", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:setLive", on: false });
    const runsPost = posts(p).reverse().find((m) => m.type === "deck:runs");
    expect(runsPost.liveSignal).toBe(false);
    expect(h.buildRunStatus).toHaveBeenCalledWith(expect.anything(), null, expect.any(String), expect.any(Number), false, expect.any(Set), expect.anything());
  });

  it("inspect open re-opens the repo path via the editor", async () => {
    show();
    await lastPanel()._fire({ type: "deck:inspect", key: "ASM-1", action: "open" });
    expect(h.openInEditor).toHaveBeenCalledWith("/r/svc");
  });

  it("inspect open prefers the multi-root workspace file when present", async () => {
    h.runs = [mkRun({ mode: "multiroot", workspaceFile: "/ws/ASM-1.code-workspace" })];
    show();
    await lastPanel()._fire({ type: "deck:inspect", key: "ASM-1", action: "open" });
    expect(h.openInEditor).toHaveBeenCalledWith("/ws/ASM-1.code-workspace");
  });

  it("opens without a success toast (silent focus)", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:inspect", key: "ASM-1", action: "open" });
    expect(h.openInEditor).toHaveBeenCalledWith("/r/svc");
    const successToast = posts(p).find((m) => m.type === "toast" && m.level === "success");
    expect(successToast).toBeUndefined();
  });

  it("toasts an error when opening fails", async () => {
    h.openInEditor.mockResolvedValueOnce(false);
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:inspect", key: "ASM-1", action: "open" });
    const errorToast = posts(p).find((m) => m.type === "toast" && m.level === "error");
    expect(errorToast).toBeTruthy();
  });

  it("inspect diff on a repo with no changes toasts instead of opening a doc", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:inspect", key: "ASM-1", action: "diff" });
    const toast = posts(p).find((m) => m.type === "toast");
    expect(toast.message).toMatch(/No uncommitted changes/i);
  });

  it("toasts an error when inspecting an unknown run", async () => {
    h.runs = [];
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:inspect", key: "NOPE-9", action: "open" });
    const toast = posts(p).find((m) => m.type === "toast" && m.level === "error");
    expect(toast).toBeTruthy();
    expect(h.openInEditor).not.toHaveBeenCalled();
  });

  it("forgets a run and re-posts the board", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:forget", key: "ASM-1" });
    expect(h.removeRun).toHaveBeenCalledWith("/runs", "ASM-1");
    expect(posts(p).some((m) => m.type === "deck:runs")).toBe(true);
  });

  it("opens an external url via the host (Open in Jira)", async () => {
    show();
    await lastPanel()._fire({ type: "openExternal", url: "https://jira/ASM-1" });
    expect(env.openExternal).toHaveBeenCalled();
  });

  it("toasts when a run has nothing to open", async () => {
    h.runs = [mkRun({ repos: [] })];
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:inspect", key: "ASM-1", action: "open" });
    const toast = posts(p).find((m) => m.type === "toast" && /nothing to open/i.test(m.message));
    expect(toast).toBeTruthy();
    expect(h.openInEditor).not.toHaveBeenCalled();
  });

  it("swallows a build error during refresh (no runs posted, no throw)", async () => {
    h.buildRunStatus.mockReset().mockImplementation(() => { throw new Error("boom"); });
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:refresh" });
    expect(posts(p).some((m) => m.type === "deck:runs")).toBe(false);
  });

  it("fetches Jira status when authenticated and passes it to the builder", async () => {
    show(true);
    const p = lastPanel();
    await p._fire({ type: "deck:refresh" });
    expect(h.getStatus).toHaveBeenCalledWith("ASM-1");
    expect(h.buildRunStatus).toHaveBeenCalledWith(
      expect.anything(), { status: "In Review", category: "indeterminate" },
      expect.any(String), expect.any(Number), true, expect.any(Set), expect.anything(),
    );
  });

  it("degrades to the git backbone on a Jira auth error", async () => {
    h.getStatus.mockRejectedValueOnce(new JiraAuthError("nope"));
    show(true);
    const p = lastPanel();
    await p._fire({ type: "deck:refresh" });
    expect(h.buildRunStatus).toHaveBeenCalledWith(expect.anything(), null, expect.any(String), expect.any(Number), true, expect.any(Set), expect.anything());
  });

  it("keeps rendering when a Jira lookup fails for another reason", async () => {
    h.getStatus.mockRejectedValueOnce(new Error("timeout"));
    show(true);
    const p = lastPanel();
    await p._fire({ type: "deck:refresh" });
    expect(posts(p).some((m) => m.type === "deck:runs")).toBe(true);
  });

  it("pauses and resumes polling on visibility changes without throwing", async () => {
    show();
    const p = lastPanel();
    p.visible = false;
    expect(() => p._fireViewState()).not.toThrow();
    p.visible = true;
    expect(() => p._fireViewState()).not.toThrow();
  });
});

describe("DeckPanel PR facts", () => {
  const settled = () => new Promise<void>((r) => setTimeout(r, 0));

  it("passes cached PR entries to the status builder", async () => {
    h.prEntries = { svc: { facts: null, fetchedAt: Date.now() } };
    show();
    await settled();
    expect(h.buildRunStatus).toHaveBeenCalledWith(
      // `show()` defaults to unauthenticated, so jira is null here — `expect.anything()`
      // excludes null/undefined, so this position must match the literal value.
      expect.anything(), null, expect.any(String), expect.any(Number),
      expect.any(Boolean), expect.any(Set), h.prEntries,
    );
  });

  it("does not await the fetch — a tick posts runs before gh returns", async () => {
    let release!: () => void;
    h.prFetch.mockImplementation(() => new Promise((res) => { release = () => res({ ok: true, facts: null }); }));
    show();
    await settled();
    expect(posts(lastPanel()).some((m) => m.type === "deck:runs")).toBe(true);
    release();
  });

  it("fetches a repo with no cached entry", async () => {
    show();
    await settled();
    expect(h.prFetch).toHaveBeenCalledWith("/r/svc", "b", "ASM-1");
    expect(h.writePrEntry).toHaveBeenCalledWith("/prfacts", "ASM-1", "svc", expect.objectContaining({ facts: null, fetchedAt: expect.any(Number) }));
  });

  it("does not refetch an entry inside its TTL", async () => {
    h.prEntries = { svc: { facts: null, fetchedAt: Date.now() } };
    show();
    await settled();
    expect(h.prFetch).not.toHaveBeenCalled();
  });

  it("refetches an entry past its TTL", async () => {
    h.prEntries = { svc: { facts: null, fetchedAt: Date.now() - 200_000 } };
    show();
    await settled();
    expect(h.prFetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the previous facts and flags an error when a fetch fails", async () => {
    const stale = { number: 5, url: "u", title: "t", state: "OPEN", isDraft: false, ci: { passing: 0, pending: 0, failing: [] }, review: "none", unresolved: null, mergeable: "clean", ciAdvisory: false };
    h.prEntries = { svc: { facts: stale, fetchedAt: Date.now() - 200_000 } };
    h.prFetch.mockResolvedValue({ ok: false });
    show();
    await settled();
    expect(h.writePrEntry).toHaveBeenCalledWith("/prfacts", "ASM-1", "svc", expect.objectContaining({ facts: stale, error: true }));
  });

  it("fetches nothing when prFacts is off, and reports it to the webview", async () => {
    h.prFacts = false;
    show();
    await settled();
    expect(h.prFetch).not.toHaveBeenCalled();
    expect(posts(lastPanel()).find((m) => m.type === "deck:runs")).toMatchObject({ prFacts: false });
  });

  it("fetches nothing and notes why when gh is unavailable", async () => {
    h.ghAvailable.mockResolvedValue(false);
    show();
    await settled();
    expect(h.prFetch).not.toHaveBeenCalled();
    expect(posts(lastPanel()).find((m) => m.type === "deck:runs")!.ghNote).toMatch(/gh/i);
  });

  it("toggles prFacts from the webview", async () => {
    show();
    await settled();
    const p = lastPanel();
    await p._fire({ type: "deck:setPrFacts", on: false });
    expect(posts(p).filter((m) => m.type === "deck:runs").at(-1)).toMatchObject({ prFacts: false });
  });

  it("forgets a run's PR facts alongside its run record", async () => {
    show();
    await settled();
    await lastPanel()._fire({ type: "deck:forget", key: "ASM-1" });
    expect(h.removePrEntries).toHaveBeenCalledWith("/prfacts", "ASM-1");
  });

  it("skips repos with no branch and no key match rather than throwing", async () => {
    h.runs = [mkRun({ repos: [{ name: "svc", path: "/r/svc", isGit: true }] })];
    show();
    await settled();
    expect(h.prFetch).toHaveBeenCalledWith("/r/svc", null, "ASM-1");
  });
});
