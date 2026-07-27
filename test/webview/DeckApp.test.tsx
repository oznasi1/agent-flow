// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";

vi.mock("../../src/webview/vscodeApi", () => ({ send: vi.fn() }));

import { DeckApp } from "../../src/webview/DeckApp";
import { send } from "../../src/webview/vscodeApi";
import type { OutboundMessage, PrFacts, RunStatus } from "../../src/types";

const sent = vi.mocked(send);

function host(msg: OutboundMessage) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data: msg }));
  });
}

const mkStatus = (over: Partial<RunStatus> = {}): RunStatus => ({
  run: {
    key: "ASM-1", summary: "Export fails on large accounts", url: "https://jira/ASM-1",
    createdAt: 1, mode: "per-window",
    repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "ASM-1-x" }], briefPaths: [],
  },
  column: "progress",
  jiraStatus: "In Progress",
  jiraCategory: "indeterminate",
  repos: [{ name: "svc", path: "/r/svc", branch: "ASM-1-x", dirty: true, ahead: 1, added: 12, removed: 2, files: 3 }],
  agent: { state: "working", lastActivityMs: 1_000, slug: "export-streaming" },
  windowOpen: false,
  prs: {},
  ...over,
});

const runsMsg = (runs: RunStatus[]): OutboundMessage => ({ type: "deck:runs", runs, liveSignal: true, prFacts: true, ghNote: null });

beforeEach(() => sent.mockClear());

describe("DeckApp", () => {
  it("announces readiness on mount", () => {
    render(<DeckApp />);
    expect(sent).toHaveBeenCalledWith({ type: "deck:ready" });
  });

  it("shows the empty state with no runs", () => {
    render(<DeckApp />);
    expect(screen.getByText(/No tasks in flight/i)).toBeInTheDocument();
  });

  it("renders a card with key, summary, Jira status and diff stat", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    expect(screen.getByText("ASM-1")).toBeInTheDocument();
    expect(screen.getByText("Export fails on large accounts")).toBeInTheDocument();
    expect(screen.getByText("In Progress")).toBeInTheDocument();
    expect(screen.getByText(/\+12/)).toBeInTheDocument();
  });

  it("groups runs into columns with counts", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus(), mkStatus({ run: { ...mkStatus().run, key: "ASM-2" }, column: "needs", agent: { state: "needs-you", lastActivityMs: 1, slug: null } })]));
    expect(screen.getByText("ASM-2")).toBeInTheDocument();
    expect(screen.getByText(/need you/i)).toBeInTheDocument(); // summary strip: "Need you"
  });

  it("shows the In progress column label", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    expect(screen.getAllByText("In progress").length).toBeGreaterThan(0);
  });

  it("shows a summary strip with the total count", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus(), mkStatus({ run: { ...mkStatus().run, key: "ASM-2" } })]));
    expect(screen.getByText(/Total/i)).toBeInTheDocument();
  });

  it("sorts cards in a column by most-recent activity", () => {
    render(<DeckApp />);
    const older = mkStatus({ run: { ...mkStatus().run, key: "OLD-1" }, agent: { state: "idle", lastActivityMs: 100, slug: null } });
    const newer = mkStatus({ run: { ...mkStatus().run, key: "NEW-1" }, agent: { state: "idle", lastActivityMs: 999, slug: null } });
    host(runsMsg([older, newer]));
    const keys = screen.getAllByText(/-1$/).map((el) => el.textContent);
    expect(keys.indexOf("NEW-1")).toBeLessThan(keys.indexOf("OLD-1"));
  });

  it("sends deck:inspect open and diff from the card actions", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    fireEvent.click(screen.getByText("Open"));
    expect(sent).toHaveBeenCalledWith({ type: "deck:inspect", key: "ASM-1", action: "open" });
    fireEvent.click(screen.getByText("Diff"));
    expect(sent).toHaveBeenCalledWith({ type: "deck:inspect", key: "ASM-1", action: "diff" });
  });

  it("opens the ticket externally when the key is clicked", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    fireEvent.click(screen.getByText("ASM-1"));
    expect(sent).toHaveBeenCalledWith({ type: "openExternal", url: "https://jira/ASM-1" });
  });

  it("toggles the live signal and falls back to the parked label", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    fireEvent.click(screen.getByText(/Live signal/i));
    expect(sent).toHaveBeenCalledWith({ type: "deck:setLive", on: false });
    expect(screen.getByText(/parked · git \+ Jira only/i)).toBeInTheDocument();
  });

  it("labels a working agent with elapsed time", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ agent: { state: "working", lastActivityMs: Date.now(), slug: null } })]));
    expect(screen.getByText(/working ·/i)).toBeInTheDocument();
  });

  it("labels a needs-you agent as ended turn", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ column: "needs", agent: { state: "needs-you", lastActivityMs: Date.now(), slug: null } })]));
    expect(screen.getByText(/ended turn/i)).toBeInTheDocument();
  });

  it("labels an idle agent as idle", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ agent: { state: "idle", lastActivityMs: Date.now(), slug: null } })]));
    expect(screen.getByText(/idle ·/i)).toBeInTheDocument();
  });

  it("shows the branch and a launched-ago time on a card", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    expect(screen.getByText(/ASM-1-x/)).toBeInTheDocument();
    expect(screen.getByText(/^launched/i)).toBeInTheDocument();
  });

  it("omits the Jira status pill when the run has no Jira status", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ jiraStatus: null })]));
    expect(screen.getByText("Export fails on large accounts")).toBeInTheDocument();
    expect(screen.queryByText("—")).not.toBeInTheDocument();
  });

  it("exposes the card controls as buttons so they are keyboard reachable", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    for (const label of ["ASM-1", "Open", "Diff"]) {
      expect(screen.getByText(label).tagName).toBe("BUTTON");
    }
    expect(screen.getByTitle(/more actions/i).tagName).toBe("BUTTON");
  });

  it("hints that Open will focus an already-open window", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ windowOpen: true })]));
    expect(screen.getByText(/open now/i)).toBeInTheDocument();
  });

  it("shows no open-now hint when the window is not open", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ windowOpen: false })]));
    expect(screen.queryByText(/open now/i)).not.toBeInTheDocument();
  });

  it("forgets a run from the overflow menu", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    fireEvent.click(screen.getByTitle(/more actions/i));
    fireEvent.click(screen.getByText(/^Forget$/));
    expect(sent).toHaveBeenCalledWith({ type: "deck:forget", key: "ASM-1" });
  });

  it("removes a forgotten card immediately, without waiting for the host", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus(), mkStatus({ run: { ...mkStatus().run, key: "ASM-2" } })]));
    fireEvent.click(screen.getAllByTitle(/more actions/i)[0]);
    fireEvent.click(screen.getByText(/^Forget$/));
    // No deck:runs has arrived; the card is gone regardless.
    expect(screen.queryByText("ASM-1")).not.toBeInTheDocument();
    expect(screen.getByText("ASM-2")).toBeInTheDocument();
    expect(sent).toHaveBeenCalledWith({ type: "deck:forget", key: "ASM-1" });
  });

  it("restores an optimistically removed card if the host still reports it", () => {
    // The host post is authoritative — a delete that failed must not vanish the run.
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    fireEvent.click(screen.getByTitle(/more actions/i));
    fireEvent.click(screen.getByText(/^Forget$/));
    expect(screen.queryByText("ASM-1")).not.toBeInTheDocument();
    host(runsMsg([mkStatus()]));
    expect(screen.getByText("ASM-1")).toBeInTheDocument();
  });

  it("shows a syncing indicator while the host is refreshing", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    expect(screen.getByText(/synced/i)).toBeInTheDocument();
    host({ type: "deck:loading", loading: true });
    expect(screen.getByText(/syncing/i)).toBeInTheDocument();
    host({ type: "deck:loading", loading: false });
    expect(screen.getByText(/synced/i)).toBeInTheDocument();
  });

  it("opens the ticket in Jira from the overflow menu", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    fireEvent.click(screen.getByTitle(/more actions/i));
    fireEvent.click(screen.getByText(/Open in Jira/i));
    expect(sent).toHaveBeenCalledWith({ type: "openExternal", url: "https://jira/ASM-1" });
  });

  const untracked = (over: Partial<RunStatus> = {}): RunStatus => {
    const base = mkStatus();
    return {
      ...base,
      run: { ...base.run, key: "explore-retry-logic", summary: "how the aggregator retries", url: "" },
      jiraStatus: null,
      jiraCategory: null,
      ...over,
    };
  };

  it("labels a ticketless run 'explore' rather than showing its synthetic key", () => {
    render(<DeckApp />);
    host(runsMsg([untracked()]));
    expect(screen.getByText("explore")).toBeInTheDocument();
    expect(screen.queryByText("explore-retry-logic")).not.toBeInTheDocument();
    // The full key stays reachable on hover — it names the run in ~/.agentflow/runs.
    expect(screen.getByTitle("explore-retry-logic")).toBeInTheDocument();
  });

  it("does not offer to open a ticketless run in Jira", () => {
    render(<DeckApp />);
    host(runsMsg([untracked()]));
    fireEvent.click(screen.getByTitle(/more actions/i));
    expect(screen.queryByText(/Open in Jira/i)).not.toBeInTheDocument();
    expect(screen.getByText(/^Forget$/)).toBeInTheDocument();
  });

  it("keeps the Jira link on a tracked run", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    fireEvent.click(screen.getByTitle(/Open ASM-1 in Jira/i));
    expect(sent).toHaveBeenCalledWith({ type: "openExternal", url: "https://jira/ASM-1" });
  });

  it("keeps the key on an untracked run that is not an Explore session", () => {
    // isTicketRun only checks the url, so a record with a real key and no url must
    // not be relabelled "explore" — it keeps its identity, minus the dead Jira link.
    render(<DeckApp />);
    host(runsMsg([untracked({ run: { ...mkStatus().run, key: "ASM-9", url: "" } })]));
    expect(screen.getByText("ASM-9")).toBeInTheDocument();
    expect(screen.queryByText("explore")).not.toBeInTheDocument();
  });

  it("shows a toast message from the host", () => {
    render(<DeckApp />);
    host({ type: "toast", level: "error", message: "Nothing to open for ASM-1." });
    expect(screen.getByText("Nothing to open for ASM-1.")).toBeInTheDocument();
  });
});

const prFacts = (over: Partial<PrFacts> = {}): PrFacts => ({
  number: 4821, url: "https://github.com/acme/svc/pull/4821", title: "Fix export",
  state: "OPEN", isDraft: false, ci: { passing: 6, pending: 0, failing: [] },
  review: "none", unresolved: null, mergeable: "clean", ciAdvisory: false, ...over,
});

describe("DeckApp PR block", () => {
  it("renders no block for a run with no PR entries", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    expect(screen.queryByText("pr")).toBeNull();
  });

  it("renders no block for a repo whose entry resolved to no PR", () => {
    const { container } = render(<DeckApp />);
    host(runsMsg([mkStatus({ prs: { svc: { facts: null, fetchedAt: 1 } } })]));
    expect(screen.queryByText("pr")).toBeNull();
    expect(container.querySelector(".pr-block")).toBeNull();
  });

  it("shows the PR number, failing checks, review state and mergeability", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({
      prs: { svc: { facts: prFacts({
        ci: { passing: 4, pending: 0, failing: [{ name: "build-backend", url: "https://ci/1" }, { name: "lint", url: "https://ci/2" }] },
        review: "changes_requested", unresolved: 3, mergeable: "blocked",
      }), fetchedAt: 1 } },
    })]));

    expect(screen.getByText("#4821")).toBeTruthy();
    expect(screen.getByText("build-backend")).toBeTruthy();
    expect(screen.getByText("lint")).toBeTruthy();
    expect(screen.getByText(/changes/)).toBeTruthy();
    expect(screen.getByText(/3 open/)).toBeTruthy();
    expect(screen.getByText("blocked")).toBeTruthy();
  });

  it("omits the thread count when unresolved is null", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ prs: { svc: { facts: prFacts({ review: "changes_requested", unresolved: null }), fetchedAt: 1 } } })]));
    expect(screen.queryByText(/open$/)).toBeNull();
  });

  it("shows a passing-check count when nothing is failing", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ prs: { svc: { facts: prFacts(), fetchedAt: 1 } } })]));
    expect(screen.getByText(/6 passing/)).toBeTruthy();
  });

  it("heads each block with its repo name only when more than one repo has a PR", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ prs: { svc: { facts: prFacts(), fetchedAt: 1 } } })]));
    expect(screen.queryByText("svc", { selector: ".pr-repo" })).toBeNull();

    host(runsMsg([mkStatus({ prs: {
      svc: { facts: prFacts(), fetchedAt: 1 },
      web: { facts: prFacts({ number: 99, url: "https://github.com/acme/web/pull/99" }), fetchedAt: 1 },
    } })]));
    expect(screen.getByText("svc", { selector: ".pr-repo" })).toBeTruthy();
    expect(screen.getByText("web", { selector: ".pr-repo" })).toBeTruthy();
  });

  it("opens the PR externally from its number", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ prs: { svc: { facts: prFacts(), fetchedAt: 1 } } })]));
    fireEvent.click(screen.getByText("#4821"));
    expect(sent).toHaveBeenCalledWith({ type: "openExternal", url: "https://github.com/acme/svc/pull/4821" });
  });

  it("opens a failing check's run externally", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ prs: { svc: { facts: prFacts({ ci: { passing: 0, pending: 0, failing: [{ name: "build", url: "https://ci/run/7" }] } }), fetchedAt: 1 } } })]));
    fireEvent.click(screen.getByText("build"));
    expect(sent).toHaveBeenCalledWith({ type: "openExternal", url: "https://ci/run/7" });
  });

  it("does not linkify a failing check with no url", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ prs: { svc: { facts: prFacts({ ci: { passing: 0, pending: 0, failing: [{ name: "build", url: "" }] } }), fetchedAt: 1 } } })]));
    // Structural: must fail if "build" ever regresses to an <a> or a <button> — not just
    // that clicking it happens to send nothing (a dead <a href=""> or handler-less
    // <button> would pass that check too).
    expect(screen.queryByRole("link", { name: "build" })).toBeNull();
    expect(screen.getByText("build").tagName).toBe("SPAN");
    fireEvent.click(screen.getByText("build"));
    expect(sent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "openExternal" }));
  });
});

describe("DeckApp PR-facts chrome", () => {
  it("says merged only when a PR actually merged", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ column: "done", prs: { svc: { facts: prFacts({ state: "MERGED" }), fetchedAt: 1 } } })]));
    expect(screen.getByText("merged")).toBeTruthy();
  });

  it("says done for a Jira-done run with no merged PR", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ column: "done" })]));
    expect(screen.getByText("done")).toBeTruthy();
    expect(screen.queryByText("merged")).toBeNull();
  });

  it("says done, not merged, when only one of two repos' PRs merged (F2)", () => {
    // The spec's prMerged rule requires EVERY PR-bearing repo to be MERGED — a
    // two-repo run whose backend merged and whose frontend is still open must
    // not claim "merged" just because `.some()` finds one.
    render(<DeckApp />);
    host(runsMsg([mkStatus({
      column: "done",
      prs: {
        svc: { facts: prFacts({ state: "MERGED" }), fetchedAt: 1 },
        web: { facts: prFacts({ number: 99, url: "https://github.com/acme/web/pull/99", state: "OPEN" }), fetchedAt: 1 },
      },
    })]));
    expect(screen.getByText("done")).toBeTruthy();
    expect(screen.queryByText("merged")).toBeNull();
  });

  it("toggles PR facts", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    fireEvent.click(screen.getByText("PR facts"));
    expect(sent).toHaveBeenCalledWith({ type: "deck:setPrFacts", on: false });
  });

  it("shows the gh note when the host sends one", () => {
    render(<DeckApp />);
    host({ type: "deck:runs", runs: [mkStatus()], liveSignal: true, prFacts: true, ghNote: "gh CLI not found — PR facts off" });
    expect(screen.getByText(/gh CLI not found/)).toBeTruthy();
  });
});
