// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";

vi.mock("../../src/webview/vscodeApi", () => ({ send: vi.fn() }));

import { DeckApp } from "../../src/webview/DeckApp";
import { send } from "../../src/webview/vscodeApi";
import type { OutboundMessage, RunStatus } from "../../src/types";

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
  ...over,
});

const runsMsg = (runs: RunStatus[]): OutboundMessage => ({ type: "deck:runs", runs, liveSignal: true });

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

  it("labels a done run as merged", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ column: "done", jiraCategory: "done", jiraStatus: "Done" })]));
    expect(screen.getByText(/merged/i)).toBeInTheDocument();
  });

  it("shows a toast message from the host", () => {
    render(<DeckApp />);
    host({ type: "toast", level: "error", message: "Nothing to open for ASM-1." });
    expect(screen.getByText("Nothing to open for ASM-1.")).toBeInTheDocument();
  });
});
