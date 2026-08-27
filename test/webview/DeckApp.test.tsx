// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as React from "react";
import { render, screen, fireEvent, act, within, waitFor } from "@testing-library/react";

vi.mock("../../src/webview/vscodeApi", () => ({ send: vi.fn() }));

import { DeckApp } from "../../src/webview/DeckApp";
import { DECK_CSS, DRAWER_ANIM_MS } from "../../src/webview/deckStyles";
import { DRAG_SEP } from "../../src/webview/OrchestratorDrawer";
import { send } from "../../src/webview/vscodeApi";
import type { AgentActivity, CardAgent, OutboundMessage, PrFacts, RepoGit, ReviewRequest, RunStatus } from "../../src/types";
import type { Flow } from "../../src/engine/orchestrator/model";

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
  ticketStatus: "In Progress",
  ticketCategory: "indeterminate",
  repos: [{ name: "svc", path: "/r/svc", branch: "ASM-1-x", dirty: true, ahead: 1, added: 12, removed: 2, files: 3 }],
  agent: { state: "working", lastActivityMs: 1_000, slug: "export-streaming" },
  windowOpen: false,
  prs: {},
  agents: [],
  shelf: "board",
  ...over,
});

// showTokenTotal defaults to false here, mirroring the shipped setting default, so
// every pre-existing test renders a board with no header token tile — which is what
// they were written against. A test that wants the tile passes it explicitly.
//
// Return type is the narrowed `deck:runs` member, not the full `OutboundMessage`
// union — every existing call site still compiles untouched (it's a subtype), but
// `{ ...runsMsg(...), mergeWrites: true }` now spreads a single known shape rather
// than a ~24-member union, which is what let a call adding `mergeWrites` (absent
// from every other member) satisfy tsc's excess-property check.
const runsMsg = (
  runs: RunStatus[],
  prReviewStatus = "PR initiated",
  sourceLabel = "Jira",
  showTokenTotal = false,
  agentLabel = "Claude Code",
): Extract<OutboundMessage, { type: "deck:runs" }> =>
  ({ type: "deck:runs", runs, ghNote: null, prReviewStatus, showTokenTotal, staleCount: 0, sourceLabel, agentLabel });

const mkAgent = (name: string, state: AgentActivity["state"], lastActivityMs: number): CardAgent => ({
  session: { pid: 1, sessionId: name, cwd: "/r/svc", startedAt: Date.now() - 3_600_000, name },
  activity: { state, lastActivityMs, slug: null },
});

/** A PR with every problem at once — the card the per-signal actions exist for. */
const failingPr = (): PrFacts => ({
  number: 3181, url: "https://gh/pr/3181", title: "t", state: "OPEN", isDraft: false,
  ci: { passing: 4, pending: 0, failing: [{ name: "integration", url: "" }, { name: "lint", url: "" }] },
  review: "changes_requested", unresolved: null, mergeable: "conflicting", ciAdvisory: false,
});

const healthyPr = (): PrFacts => ({
  number: 2044, url: "https://gh/pr/2044", title: "t", state: "OPEN", isDraft: false,
  ci: { passing: 8, pending: 0, failing: [] },
  review: "approved", unresolved: null, mergeable: "clean", ciAdvisory: false,
});

const withPr = (f: PrFacts, over: Partial<RunStatus> = {}): RunStatus =>
  mkStatus({ prs: { svc: { facts: f, fetchedAt: 1 } }, ...over } as Partial<RunStatus>);

/** Renders the board with exactly one run and returns its card element, found by
 * the run's own key (rendered as button text regardless of column or agent). Reuses
 * mkStatus/host/runsMsg rather than adding a second render harness. */
function renderOneCard(opts: { key: string; repos: { name: string }[]; agents?: CardAgent[] }): HTMLElement {
  render(<DeckApp />);
  const repos: RepoGit[] = opts.repos.map((r) => ({
    name: r.name, path: `/r/${r.name}`, branch: null, dirty: false, ahead: 0, added: 0, removed: 0, files: 0,
  }));
  const status = mkStatus({
    run: { ...mkStatus().run, key: opts.key, repos: repos.map((r) => ({ name: r.name, path: r.path, isGit: true })) },
    repos,
    agents: opts.agents ?? [],
  });
  host(runsMsg([status]));
  return screen.getByText(opts.key).closest(".card") as HTMLElement;
}

beforeEach(() => sent.mockClear());

describe("DeckApp", () => {
  it("announces readiness on mount", () => {
    render(<DeckApp />);
    expect(sent).toHaveBeenCalledWith({ type: "deck:ready" });
  });

  it("shows the empty state once an empty deck:runs has actually landed", () => {
    render(<DeckApp />);
    host(runsMsg([]));
    expect(screen.getByText(/No tasks in flight/i)).toBeInTheDocument();
  });

  it("shows a loading state, not the empty state, before the first deck:runs lands", () => {
    render(<DeckApp />);
    expect(screen.queryByText(/No tasks in flight/i)).not.toBeInTheDocument();
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("runs the animated logo in the first-load state instead of the old glyph", () => {
    const { container } = render(<DeckApp />);
    expect(container.querySelector(".empty svg.lmark")).toBeInTheDocument();
    expect(container.querySelector(".empty .spin")).not.toBeInTheDocument();
  });

  it("replaces the loading state once deck:runs lands, even with cards present", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
    expect(screen.getByText("ASM-1")).toBeInTheDocument();
  });

  it("renders a card with key, summary and a diff stat, and the Jira status in its drawer", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    expect(screen.getByText("ASM-1")).toBeInTheDocument();
    expect(screen.getByText("Export fails on large accounts")).toBeInTheDocument();
    expect(screen.getByText(/\+12/)).toBeInTheDocument();
    // The Jira status pill moved off the card's own footer into the drawer.
    fireEvent.click(document.querySelector(".card") as HTMLElement);
    expect(within(document.querySelector(".dd") as HTMLElement).getByText("In Progress")).toBeInTheDocument();
  });

  it("marks the card with the tool driving the run", () => {
    const { container } = render(<DeckApp />);
    host(runsMsg([mkStatus({ provider: "cursor" })]));
    expect(container.querySelector(".pv.p-cursor")).toBeTruthy();
  });

  it("leaves the tile bare when no provider is known", () => {
    // The board as it looked before this feature: every run record written before the
    // provider was recorded, with nothing running in it.
    const { container } = render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    expect(container.querySelector(".pv")).toBeNull();
  });

  it("groups runs into columns with counts", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus(), mkStatus({ run: { ...mkStatus().run, key: "ASM-2" }, column: "needs", agent: { state: "needs-you", lastActivityMs: 1, slug: null } })]));
    expect(screen.getByText("ASM-2")).toBeInTheDocument();
    // "Action required" names the same thing in the summary tile, the column header and
    // the legend — one name for one thing, so all three match.
    expect(screen.getAllByText(/action required/i).length).toBeGreaterThan(0);
  });

  it("labels the attention column and its summary tile identically", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ column: "needs" })]));
    expect(screen.getAllByText("Action required")).toHaveLength(3); // tile, column header, legend
    expect(screen.queryByText(/needs you/i)).not.toBeInTheDocument();
  });

  it("marks the attention card and its summary tile with the attn class, not a danger one", () => {
    const { container } = render(<DeckApp />);
    host(runsMsg([mkStatus({ column: "needs" })]));
    expect(container.querySelector(".card.attn")).not.toBeNull();
    expect(container.querySelector(".stat.attn")).not.toBeNull();
  });

  it("shows the In progress column label", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    expect(screen.getAllByText("In progress").length).toBeGreaterThan(0);
  });

  it("shows a summary tile with the aggregate count across runs", () => {
    // There is no longer a Total tile — this is really about whether the header
    // adds two separate runs into one tile's count, not about any one label.
    render(<DeckApp />);
    host(runsMsg([mkStatus(), mkStatus({ run: { ...mkStatus().run, key: "ASM-2" } })]));
    const tiles = Array.from(document.querySelectorAll(".stat")).map((s) => [s.querySelector(".l")!.textContent, s.querySelector(".n")!.textContent]);
    expect(tiles).toContainEqual(["In progress", "2"]);
  });

  it("shows one tile per board column, in board order", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ column: "progress" }), mkStatus({ run: { ...mkStatus().run, key: "ASM-2" }, column: "needs" })]));
    const labels = screen.getAllByText(/./, { selector: ".stat .l" }).map((n) => n.textContent);
    expect(labels).toEqual(["In progress", "Action required", "In review", "Merge"]);
  });

  it("lights the Merge tile only when something is at the merge", () => {
    const lit = () => (document.querySelector(".stat.up") as HTMLElement | null)?.querySelector(".l")?.textContent ?? null;
    render(<DeckApp />);
    host(runsMsg([mkStatus({ column: "progress" })]));
    expect(lit()).toBeNull();
    host(runsMsg([mkStatus({ column: "merge" })]));
    expect(lit()).toBe("Merge");
  });

  it("drops the To review and Total tiles", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));

    // Both restated something already on screen: the review strip renders its own
    // count directly below, and Total is the sum of the three tiles beside it.
    expect(screen.queryByText("To review")).not.toBeInTheDocument();
    expect(screen.queryByText("Total")).not.toBeInTheDocument();
  });

  it("accents Action required only when something is asking for you", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ column: "progress" })]));
    expect(document.querySelector(".stat.attn")).toBeNull();

    host(runsMsg([mkStatus({ column: "needs" })]));
    expect(document.querySelector(".stat.attn")).not.toBeNull();
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

  // Extra pair authorized beyond the brief: nothing pinned a wrong tone or label
  // on either new agent state before this — both would have passed every test
  // in the suite.
  it("labels a stalled agent as stalled, with the attention tone", () => {
    const { container } = render(<DeckApp />);
    host(runsMsg([mkStatus({ column: "needs", agent: { state: "stalled", lastActivityMs: Date.now(), slug: null } })]));
    expect(screen.getByText(/stalled ·/i)).toBeInTheDocument();
    expect(container.querySelector(".status.tone-attn")).not.toBeNull();
  });

  it("labels an exited agent as exited, with the attention tone", () => {
    const { container } = render(<DeckApp />);
    host(runsMsg([mkStatus({ column: "needs", agent: { state: "exited", lastActivityMs: Date.now(), slug: null } })]));
    expect(screen.getByText(/exited ·/i)).toBeInTheDocument();
    expect(container.querySelector(".status.tone-attn")).not.toBeNull();
  });

  // Coverage the design's own test plan called for and nothing pinned before
  // this fix wave: "both label maps render the new arm, with and without
  // pendingTool." Before this test, deleting the onTool(...) call from
  // stateView's `blocked`/`stalled` arms would still pass the whole suite.
  it("labels a blocked agent and names the tool it is waiting on", () => {
    const { container } = render(<DeckApp />);
    host(runsMsg([mkStatus({
      column: "needs",
      agent: { state: "blocked", lastActivityMs: Date.now(), slug: null, pendingTool: "Bash" },
    })]));
    expect(screen.getByText(/blocked · waiting on Bash ·/i)).toBeInTheDocument();
    expect(container.querySelector(".status.tone-attn")).not.toBeNull();
  });

  it("labels a blocked agent with no dangling separator when the tool name could not be read", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({
      column: "needs",
      agent: { state: "blocked", lastActivityMs: Date.now(), slug: null, pendingTool: null },
    })]));
    // No "waiting on" phrase, and no leftover " · ·" from a blank onTool() result.
    expect(screen.queryByText(/waiting on/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/undefined/i)).not.toBeInTheDocument();
    expect(screen.getByText(/^blocked ·/i)).toBeInTheDocument();
    expect(screen.queryByText(/blocked · ·/i)).not.toBeInTheDocument();
  });

  it("labels a stalled agent and names its tool too", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({
      column: "needs",
      agent: { state: "stalled", lastActivityMs: Date.now(), slug: null, pendingTool: "Agent" },
    })]));
    expect(screen.getByText(/stalled · waiting on Agent ·/i)).toBeInTheDocument();
  });

  it("labels a stalled agent with no dangling separator when there is no pendingTool", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({
      column: "needs",
      agent: { state: "stalled", lastActivityMs: Date.now(), slug: null, pendingTool: undefined },
    })]));
    expect(screen.queryByText(/waiting on/i)).not.toBeInTheDocument();
    expect(screen.getByText(/^stalled ·/i)).toBeInTheDocument();
  });

  it("shows the branch on the card's signal line, and a launched-ago time in its drawer", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    expect(screen.getByText(/ASM-1-x/)).toBeInTheDocument();
    fireEvent.click(document.querySelector(".card") as HTMLElement);
    expect(within(document.querySelector(".dd") as HTMLElement).getByText(/^launched/i)).toBeInTheDocument();
  });

  it("omits the Jira status pill when the run has no Jira status", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ ticketStatus: null })]));
    expect(screen.getByText("Export fails on large accounts")).toBeInTheDocument();
    fireEvent.click(document.querySelector(".card") as HTMLElement);
    expect(document.querySelector(".dd .pill")).toBeNull();
  });

  it("exposes the card controls as buttons so they are keyboard reachable", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    for (const label of ["ASM-1", "Open", "Diff"]) {
      expect(screen.getByText(label).tagName).toBe("BUTTON");
    }
    // The overflow menu's "more actions" toggle is gone — its former contents are
    // now the drawer's always-visible action list, itself real buttons.
    fireEvent.click(document.querySelector(".card") as HTMLElement);
    expect(screen.getByRole("button", { name: "Open workspace" }).tagName).toBe("BUTTON");
  });

  // The hint is the Open button's tooltip plus a marker on the button, not a line of
  // body text on every such card — so it costs nothing until the pointer asks for it.
  it("hints on the Open button's tooltip that it will focus an already-open window", () => {
    const { container } = render(<DeckApp />);
    host(runsMsg([mkStatus({ windowOpen: true })]));
    expect(screen.getByTitle(/open now/i).textContent).toBe("Open");
    expect(container.querySelector(".act.primary.live")).not.toBeNull();
  });

  it("never renders the open-now hint as visible text", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ windowOpen: true })]));
    expect(screen.queryByText(/open now/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/will focus this window/i)).not.toBeInTheDocument();
  });

  it("shows no open-now hint or marker when the window is not open", () => {
    const { container } = render(<DeckApp />);
    host(runsMsg([mkStatus({ windowOpen: false })]));
    expect(screen.queryByTitle(/open now/i)).not.toBeInTheDocument();
    expect(container.querySelector(".act.primary.live")).toBeNull();
  });

  it("forgets a run from the drawer's action list", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    fireEvent.click(document.querySelector(".card") as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:forget", key: "ASM-1" });
  });

  it("removes a forgotten card immediately, without waiting for the host", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus(), mkStatus({ run: { ...mkStatus().run, key: "ASM-2" } })]));
    fireEvent.click(document.querySelectorAll(".card")[0]);
    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    // No deck:runs has arrived; the card is gone regardless.
    expect(screen.queryByText("ASM-1")).not.toBeInTheDocument();
    expect(screen.getByText("ASM-2")).toBeInTheDocument();
    expect(sent).toHaveBeenCalledWith({ type: "deck:forget", key: "ASM-1" });
  });

  it("restores an optimistically removed card if the host still reports it", () => {
    // The host post is authoritative — a delete that failed must not vanish the run.
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    fireEvent.click(document.querySelector(".card") as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    expect(screen.queryByText("ASM-1")).not.toBeInTheDocument();
    host(runsMsg([mkStatus()]));
    expect(screen.getByText("ASM-1")).toBeInTheDocument();
  });

  // The refresh button keeps its ⟳ at rest: a static logo on a button reads as
  // branding, not as something you can press. The mark takes over only in flight.
  it("swaps the refresh glyph for the animated logo while syncing, and back after", () => {
    const { container } = render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    expect(container.querySelector(".hd svg.lmark")).not.toBeInTheDocument();
    expect(container.querySelector(".hd .spin")).toBeInTheDocument();
    host({ type: "deck:loading", loading: true });
    expect(container.querySelector(".hd svg.lmark")).toBeInTheDocument();
    expect(container.querySelector(".hd .spin")).not.toBeInTheDocument();
    host({ type: "deck:loading", loading: false });
    expect(container.querySelector(".hd svg.lmark")).not.toBeInTheDocument();
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

  it("opens the ticket in Jira from the drawer's action list", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    fireEvent.click(document.querySelector(".card") as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Open in Jira" }));
    expect(sent).toHaveBeenCalledWith({ type: "openExternal", url: "https://jira/ASM-1" });
  });

  const untracked = (over: Partial<RunStatus> = {}): RunStatus => {
    const base = mkStatus();
    return {
      ...base,
      run: { ...base.run, key: "explore-retry-logic", summary: "how the aggregator retries", url: "" },
      ticketStatus: null,
      ticketCategory: null,
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
    fireEvent.click(document.querySelector(".card") as HTMLElement);
    expect(screen.queryByText(/Open in Jira/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Forget" })).toBeInTheDocument();
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

  it("labels a notepad run on the untracked key chip", () => {
    render(<DeckApp />);
    host(runsMsg([untracked({
      run: { ...mkStatus().run, key: "notepad-fix-it", summary: "fix it", url: "", kind: "notepad" },
    })]));
    expect(screen.getByText("notepad")).toBeInTheDocument();
    expect(screen.queryByText("notepad-fix-it")).not.toBeInTheDocument();
  });

  it("shows a toast message from the host", () => {
    render(<DeckApp />);
    host({ type: "toast", level: "error", message: "Nothing to open for ASM-1." });
    expect(screen.getByText("Nothing to open for ASM-1.")).toBeInTheDocument();
  });

  const mkLocal = (over: Partial<RunStatus> = {}) => mkStatus({
    run: { key: "local-centaur-1a2b3c4d", summary: "team table new design",
      url: "https://jira/browse/ASM-5641", createdAt: 1, kind: "local", mode: "per-window",
      repos: [{ name: "centaur", path: "/r/centaur", isGit: true, branch: "ASM-5641-team-table" }], briefPaths: [] },
    // The host computes this from run.url through the connector (see
    // src/deckView.ts's buildAll) — the webview only ever reads it off the
    // wire, never parses a url itself.
    inferredTicketKey: "ASM-5641",
    ...over,
  });

  it("marks a local card and flags an inferred key", () => {
    render(<DeckApp />);
    host(runsMsg([mkLocal()]));
    expect(screen.getByText("local")).toBeTruthy();
    expect(screen.getByText("~inferred")).toBeTruthy();
    expect(screen.getByText("ASM-5641")).toBeTruthy();
  });

  it("shows the place's name when nothing was inferred", () => {
    const { container } = render(<DeckApp />);
    // No inferredTicketKey on the wire — exactly what the host sends for a
    // local card whose url resolved to nothing, or has none at all.
    host(runsMsg([mkLocal({ run: { ...mkLocal().run, url: "", summary: "centaur" }, inferredTicketKey: undefined })]));
    expect(screen.queryByText("~inferred")).toBeNull();
    expect(screen.getByText("centaur")).toBeTruthy();
    // The requirement is that the key slot itself shows "local" — scope to
    // that element rather than screen.getByText("local"), which the
    // beside-summary chip would also satisfy in the inferred-key scenario.
    expect(container.querySelector(".key")?.textContent).toBe("local");
  });

  it("renders the inferred key strictly from the wire field, never by parsing the url itself", () => {
    // The url still looks like a real ticket url (mkLocal's default), but the
    // host declined to set inferredTicketKey. If the webview ever fell back to
    // parsing r.run.url on its own — the exact coupling this field exists to
    // remove — "ASM-5641" would render anyway. It must not: that parsing is the
    // connector's job, host-side, and nowhere else.
    render(<DeckApp />);
    host(runsMsg([mkLocal({ inferredTicketKey: undefined })]));
    expect(screen.queryByText("~inferred")).toBeNull();
    expect(screen.queryByText("ASM-5641")).toBeNull();
  });

  it("offers Track it and no Forget", () => {
    render(<DeckApp />);
    host(runsMsg([mkLocal()]));
    fireEvent.click(document.querySelector(".card") as HTMLElement);
    expect(screen.getByRole("button", { name: "Track it" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Forget" })).toBeNull();
  });

  it("posts deck:track", () => {
    render(<DeckApp />);
    host(runsMsg([mkLocal()]));
    fireEvent.click(document.querySelector(".card") as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Track it" }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:track", key: "local-centaur-1a2b3c4d" });
  });

  it("still offers Forget on a tracked card", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    fireEvent.click(document.querySelector(".card") as HTMLElement);
    expect(screen.getByRole("button", { name: "Forget" })).toBeTruthy();
  });

  it("labels a Track'd ticketless place 'explore', not its raw place-hash key", () => {
    // After Track it on a place with no inferred ticket, the record survives as
    // kind: "explore" but keeps the local-<hash> key it always had (track()
    // never renames it) — the key slot should say what the record now is.
    render(<DeckApp />);
    host(runsMsg([mkStatus({
      run: {
        key: "local-centaur-1a2b3c4d", summary: "centaur", url: "", createdAt: 1,
        kind: "explore", mode: "per-window",
        repos: [{ name: "centaur", path: "/r/centaur", isGit: true }], briefPaths: [],
      },
      ticketStatus: null, ticketCategory: null,
    })]));
    expect(screen.getByText("explore")).toBeInTheDocument();
    expect(screen.queryByText("local-centaur-1a2b3c4d")).not.toBeInTheDocument();
  });
});

const prFacts = (over: Partial<PrFacts> = {}): PrFacts => ({
  number: 4821, url: "https://github.com/acme/svc/pull/4821", title: "Fix export",
  state: "OPEN", isDraft: false, ci: { passing: 6, pending: 0, failing: [] },
  review: "none", unresolved: null, mergeable: "clean", ciAdvisory: false, ...over,
});

describe("DeckApp PR block", () => {
  // The PR block moved off the card into the drawer, so every case here selects
  // the card first — none of these assert anything about the card's own DOM.
  it("renders no block in the drawer for a run with no PR entries", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    fireEvent.click(document.querySelector(".card") as HTMLElement);
    const dd = document.querySelector(".dd") as HTMLElement;
    expect(within(dd).queryByText("pr", { selector: ".pr-lbl" })).toBeNull();
    expect(within(dd).getByText("No pull request yet")).toBeInTheDocument();
  });

  it("renders no block for a repo whose entry resolved to no PR", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ prs: { svc: { facts: null, fetchedAt: 1 } } })]));
    fireEvent.click(document.querySelector(".card") as HTMLElement);
    const dd = document.querySelector(".dd") as HTMLElement;
    expect(dd.querySelector(".pr-block")).toBeNull();
    expect(within(dd).getByText("No pull request yet")).toBeInTheDocument();
  });

  it("shows the PR number, failing checks, review state and mergeability", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({
      prs: { svc: { facts: prFacts({
        ci: { passing: 4, pending: 0, failing: [{ name: "build-backend", url: "https://ci/1" }, { name: "lint", url: "https://ci/2" }] },
        review: "changes_requested", unresolved: 3, mergeable: "blocked",
      }), fetchedAt: 1 } },
    })]));
    fireEvent.click(document.querySelector(".card") as HTMLElement);

    // The card's own signal line now shares some of these words ("#4821",
    // "changes") — scope to the drawer's PR block, the fact this test is
    // actually about.
    const dd = within(document.querySelector(".dd") as HTMLElement);
    expect(dd.getByRole("button", { name: "#4821" })).toBeTruthy();
    expect(dd.getByText("build-backend")).toBeTruthy();
    expect(dd.getByText("lint")).toBeTruthy();
    expect(dd.getByText(/changes/)).toBeTruthy();
    expect(dd.getByText(/3 open/)).toBeTruthy();
    expect(dd.getByText("blocked")).toBeTruthy();
  });

  it("keeps the merge row while the PR is open", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ prs: { svc: { facts: prFacts({ mergeable: "behind" }), fetchedAt: 1 } } })]));
    fireEvent.click(document.querySelector(".card") as HTMLElement);
    expect(screen.getByText("merge", { selector: ".pr-lbl" })).toBeTruthy();
    expect(screen.getByText("behind")).toBeTruthy();
  });

  it.each(["MERGED", "CLOSED"] as const)("drops the merge row on a %s PR", (state) => {
    // GitHub stops computing mergeability the moment a PR leaves OPEN: `mergeable`
    // and `mergeStateStatus` both come back UNKNOWN, so `mapMergeable` can only
    // say "unknown". Rendering that asks "can this merge?" about a question that
    // no longer has an answer — the rows that kept their meaning stay.
    render(<DeckApp />);
    host(runsMsg([mkStatus({ prs: { svc: { facts: prFacts({ state, mergeable: "unknown" }), fetchedAt: 1 } } })]));
    fireEvent.click(document.querySelector(".card") as HTMLElement);
    expect(screen.queryByText("merge", { selector: ".pr-lbl" })).toBeNull();
    expect(screen.queryByText("unknown")).toBeNull();
    expect(within(document.querySelector(".dd") as HTMLElement).getByRole("button", { name: "#4821" })).toBeTruthy();
    expect(screen.getByText(/6 passing/)).toBeTruthy();
  });

  it("omits the thread count when unresolved is null", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ prs: { svc: { facts: prFacts({ review: "changes_requested", unresolved: null }), fetchedAt: 1 } } })]));
    fireEvent.click(document.querySelector(".card") as HTMLElement);
    expect(screen.queryByText(/open$/)).toBeNull();
  });

  it("shows a passing-check count when nothing is failing", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ prs: { svc: { facts: prFacts(), fetchedAt: 1 } } })]));
    fireEvent.click(document.querySelector(".card") as HTMLElement);
    expect(screen.getByText(/6 passing/)).toBeTruthy();
  });

  it("heads each block with its repo name only when more than one repo has a PR", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ prs: { svc: { facts: prFacts(), fetchedAt: 1 } } })]));
    fireEvent.click(document.querySelector(".card") as HTMLElement);
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
    fireEvent.click(document.querySelector(".card") as HTMLElement);
    fireEvent.click(within(document.querySelector(".dd") as HTMLElement).getByRole("button", { name: "#4821" }));
    expect(sent).toHaveBeenCalledWith({ type: "openExternal", url: "https://github.com/acme/svc/pull/4821" });
  });

  it("opens a failing check's run externally", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ prs: { svc: { facts: prFacts({ ci: { passing: 0, pending: 0, failing: [{ name: "build", url: "https://ci/run/7" }] } }), fetchedAt: 1 } } })]));
    fireEvent.click(document.querySelector(".card") as HTMLElement);
    fireEvent.click(screen.getByText("build"));
    expect(sent).toHaveBeenCalledWith({ type: "openExternal", url: "https://ci/run/7" });
  });

  it("does not linkify a failing check with no url", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ prs: { svc: { facts: prFacts({ ci: { passing: 0, pending: 0, failing: [{ name: "build", url: "" }] } }), fetchedAt: 1 } } })]));
    fireEvent.click(document.querySelector(".card") as HTMLElement);
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
  it("says ready to merge, or merged, on a merge card with nobody home", () => {
    // The column and the PRs are the only things that know: the agent read on a
    // parked card says "unknown", which would otherwise render the grey parked
    // line on the one column that means press this, or wrap this up.
    const parkedMerge = (over: Partial<PrFacts>) => mkStatus({
      column: "merge", agents: [], agent: { state: "unknown", lastActivityMs: null, slug: null },
      prs: { svc: { facts: prFacts(over), fetchedAt: 1 } },
    });
    const { container } = render(<DeckApp />);
    host(runsMsg([parkedMerge({ review: "approved" })]));
    const status = () => container.querySelector(".status") as HTMLElement;
    expect(within(status()).getByText("ready to merge")).toBeTruthy();
    expect(status().className).toContain("tone-merged");
    host(runsMsg([parkedMerge({ state: "MERGED" })]));
    expect(within(status()).getByText("merged")).toBeTruthy();
  });

  it("says merged only when every PR-bearing repo actually merged", () => {
    // A two-repo run whose backend landed and whose frontend is still open has
    // not merged, and its parked line must not claim it did. Scoped to the state
    // line: the signal line's own lead-PR bit can legitimately say "merged" about
    // the one repo that did, which is a different claim.
    const { container } = render(<DeckApp />);
    host(runsMsg([mkStatus({
      column: "merge", agents: [], agent: { state: "unknown", lastActivityMs: null, slug: null },
      prs: {
        svc: { facts: prFacts({ state: "MERGED" }), fetchedAt: 1 },
        web: { facts: prFacts({ number: 99, url: "https://github.com/acme/web/pull/99", state: "OPEN" }), fetchedAt: 1 },
      },
    })]));
    const status = within(container.querySelector(".status") as HTMLElement);
    expect(status.getByText("ready to merge")).toBeTruthy();
    expect(status.queryByText("merged")).toBeNull();
  });

  it("still lets a live agent's own state speak on a merge card", () => {
    // Only the parked case is overridden. An agent working in a run whose PR is
    // already green — or already landed, running the wrap-up — is doing
    // something, and the line must say so.
    const { container } = render(<DeckApp />);
    host(runsMsg([mkStatus({
      column: "merge", agent: { state: "working", lastActivityMs: Date.now(), slug: null },
      prs: { svc: { facts: prFacts({ review: "approved" }), fetchedAt: 1 } },
    })]));
    expect((container.querySelector(".status") as HTMLElement).textContent).toContain("working");
  });

  it("shows the gh note when the host sends one", () => {
    render(<DeckApp />);
    host({ type: "deck:runs", runs: [mkStatus()], ghNote: "gh CLI not found — PR facts off", prReviewStatus: "PR initiated", showTokenTotal: false, staleCount: 0, sourceLabel: "Jira", agentLabel: "Claude Code" });
    expect(screen.getByText(/gh CLI not found/)).toBeTruthy();
  });

  // The nested agents row belongs to the Workspaces lens — the Agents lens gives
  // each of these sessions a card of its own instead, so every case below says
  // which grouping it is about rather than relying on the default.
  it("names a single agent instead of counting to one", () => {
    render(<DeckApp />);
    host({ type: "deck:grouping", grouping: "workspaces" });
    host(runsMsg([mkStatus({ agents: [mkAgent("svc-7e", "working", Date.now())] })]));
    // The agents fold moved off the card into the drawer's Agents section,
    // which ships expanded by default — the name appears both on the toggle
    // and on the row it discloses, so getAllByText rather than getByText.
    fireEvent.click(document.querySelector(".card") as HTMLElement);
    expect(screen.getAllByText("svc-7e").length).toBeGreaterThan(0);
    expect(screen.queryByText(/1 agent/)).toBeNull();
  });

  // The drawer's AgentsRow ships expanded (Task: the design doc requires it —
  // "there is room; the fold existed because the card had none"), so this no
  // longer needs a click to see every row, unlike the card-level fold
  // AgentsRow still defaults to for any other caller (see deckParts.test.tsx).
  it("counts several agents and shows every row without expanding", () => {
    render(<DeckApp />);
    host({ type: "deck:grouping", grouping: "workspaces" });
    host(runsMsg([mkStatus({ agents: [mkAgent("svc-7e", "working", Date.now()), mkAgent("svc-fa", "idle", Date.now() - 60_000)] })]));
    fireEvent.click(document.querySelector(".card") as HTMLElement);
    expect(screen.getByRole("button", { name: /2 sessions/ })).toBeTruthy();
    expect(screen.getByText("svc-fa")).toBeTruthy();
    // Each row carries its OWN state — the whole point of listing them. Scoped to
    // .ag-state because "working" is also the name of an In-progress lane header
    // now, and an unscoped match would pick up the sub-header instead of the row.
    expect(screen.getByText("working", { selector: ".ag-state" })).toBeTruthy();
    expect(screen.getByText("idle", { selector: ".ag-state" })).toBeTruthy();
  });

  it("gives the collapsed label mono only when it is a name, not a count", () => {
    // Mono is for identifiers on this board. A solo agent's collapsed label IS
    // its session name, so it earns .id; "N agents" is prose about a count and
    // must not carry the identifier styling, even though both sit in .ag-label.
    const solo = render(<DeckApp />);
    host({ type: "deck:grouping", grouping: "workspaces" });
    host(runsMsg([mkStatus({ agents: [mkAgent("svc-7e", "working", Date.now())] })]));
    fireEvent.click(solo.container.querySelector(".card") as HTMLElement);
    const soloLabel = solo.container.querySelector(".ag-label")!;
    expect(soloLabel.classList.contains("id")).toBe(true);
    solo.unmount();

    const many = render(<DeckApp />);
    host({ type: "deck:grouping", grouping: "workspaces" });
    host(runsMsg([mkStatus({ agents: [mkAgent("svc-7e", "working", Date.now()), mkAgent("svc-fa", "idle", Date.now() - 60_000)] })]));
    fireEvent.click(many.container.querySelector(".card") as HTMLElement);
    const manyLabel = many.container.querySelector(".ag-label")!;
    expect(manyLabel.classList.contains("id")).toBe(false);
  });

  it("suppresses the open-since label when a session's startedAt is unknown (0)", () => {
    // readOpenSessions defaults a missing startedAt to 0; timeAgo(0) returns ""
    // (a falsy ms short-circuits it), which would otherwise render a bare "open"
    // with nothing after it.
    const { container } = render(<DeckApp />);
    const noStart: CardAgent = {
      session: { pid: 1, sessionId: "svc-7e", cwd: "/r/svc", startedAt: 0, name: "svc-7e" },
      activity: { state: "working", lastActivityMs: Date.now(), slug: null },
    };
    host({ type: "deck:grouping", grouping: "workspaces" });
    host(runsMsg([mkStatus({ agents: [noStart, mkAgent("svc-fa", "idle", Date.now() - 60_000)] })]));
    // The drawer's AgentsRow ships expanded by default — no click needed.
    fireEvent.click(container.querySelector(".card") as HTMLElement);
    const rows = [...container.querySelectorAll(".ag-row")];
    const zeroRow = rows.find((r) => r.textContent?.includes("svc-7e"))!;
    expect(zeroRow.querySelector(".ag-open")).toBeNull();
    const knownRow = rows.find((r) => r.textContent?.includes("svc-fa"))!;
    expect(knownRow.querySelector(".ag-open")?.textContent).toMatch(/^open /);
  });

  it("renders no agents row for a card with none", () => {
    // Not screen.queryByRole("button", { name: /session/ }) — the header's own
    // grouping lens always renders a "Sessions" button, whose accessible name
    // matches that pattern too, so an unscoped query would pass even if
    // AgentsRow leaked an empty control. Scope to the card's own markup instead.
    const { container } = render(<DeckApp />);
    host(runsMsg([mkStatus({ agents: [] })]));
    expect(container.querySelector(".c-agents")).toBeNull();
  });
});

const reviewsMsg = (requests: ReviewRequest[], issueCount = requests.length, over: Partial<Extract<OutboundMessage, { type: "deck:reviews" }>> = {}): OutboundMessage =>
  ({ type: "deck:reviews", requests, issueCount, sort: "oldest", stale: false, reviewWrites: false, enabled: true, loading: false, ...over });

const mkReview = (over: Partial<ReviewRequest> = {}): ReviewRequest => ({
  id: "o/r#1", repo: "o/r", repoName: "r", number: 1, title: "a small fix", url: "https://gh/o/r/pull/1",
  author: "dana", isDraft: false, createdAt: Date.now() - 3_600_000, updatedAt: Date.now(),
  additions: 10, deletions: 2, changedFiles: 1,
  ci: "passing", review: "review_required", mergeable: "clean",
  localPath: null, runKey: null, draftPath: null, ...over,
});

describe("DeckApp review strip", () => {
  // Not a tile assertion: the strip renders nothing of its own — no header line,
  // no rows — for an empty, resolved queue (not loading, not stale). Kept from
  // two tests that used to bundle this together with the now-removed "To review"
  // tile; this is the part of each that was really about the strip.
  it("renders nothing for an empty, resolved queue", () => {
    render(<DeckApp />);
    host(reviewsMsg([], 0));
    expect(screen.queryByText(/waiting on your review/i)).not.toBeInTheDocument();
  });

  it("renders the strip above the board", () => {
    render(<DeckApp />);
    host(reviewsMsg([mkReview()]));
    expect(screen.getByText("a small fix")).toBeInTheDocument();
  });

  // agentFlow.reviewRequestsAlwaysVisible rides the deck:reviews message as
  // `alwaysVisible`: an empty, resolved queue keeps its header instead of the
  // strip vanishing from the board.
  it("keeps the strip header on an empty queue when the host says always visible", () => {
    render(<DeckApp />);
    host(reviewsMsg([], 0, { alwaysVisible: true }));
    expect(screen.getByText(/0 PRs waiting on your review/i)).toBeInTheDocument();
  });

  // An in-flight deck:runs posted by an older host build has no agentLabel field
  // at all (see the `?? DEFAULT_AGENT_LABEL` comment in DeckApp.tsx) — this is
  // the one path that ever observes the fallback, since every other test's
  // runsMsg() supplies "Claude Code" explicitly.
  it("falls back to the default agent label when deck:runs omits agentLabel", async () => {
    render(<DeckApp />);
    host({
      type: "deck:runs", runs: [], ghNote: null, prReviewStatus: "PR initiated",
      showTokenTotal: false, staleCount: 0, sourceLabel: "Jira",
    } as unknown as OutboundMessage);
    host(reviewsMsg([mkReview()]));
    fireEvent.click(screen.getByText("a small fix"));
    await waitFor(() => {
      expect(screen.getByText(/Review with Claude Code/i)).toBeInTheDocument();
    });
  });

  it("sends the new sort to the host", () => {
    render(<DeckApp />);
    host(reviewsMsg([mkReview()]));
    fireEvent.click(screen.getByText("smallest"));
    expect(sent).toHaveBeenCalledWith({ type: "deck:setReviewSort", sort: "smallest" });
  });

  // A long queue must arrive VISIBLE. Height is bounded by the rows container's own
  // scroller, so the board is protected without hiding the thing the strip exists for.
  it("shows every row of a long queue rather than collapsing it", () => {
    const { container } = render(<DeckApp />);
    host(reviewsMsg(Array.from({ length: 9 }, (_, i) => mkReview({ id: `o/r#${i}`, number: i, title: `pr ${i}` }))));
    expect(screen.getByText(/9 PRs waiting on your review/i)).toBeInTheDocument();
    expect(screen.getByText("pr 0")).toBeInTheDocument();
    expect(screen.getByText("pr 8")).toBeInTheDocument();
    // The header count and the two end titles alone would still pass a "render only
    // the first and last row" bug — count the actual rows rendered.
    expect(container.querySelectorAll(".rv-line").length).toBe(9);
  });

  it("stays collapsed across a refresh once the user collapses it", () => {
    render(<DeckApp />);
    const six = Array.from({ length: 6 }, (_, i) => mkReview({ id: `o/r#${i}`, number: i, title: `pr ${i}` }));
    host(reviewsMsg(six));
    fireEvent.click(screen.getByText(/waiting on your review/i)); // the user hides it
    expect(screen.queryByText("pr 0")).not.toBeInTheDocument();
    host(reviewsMsg(six)); // a later poll must not re-open what the user closed
    expect(screen.queryByText("pr 0")).not.toBeInTheDocument();
  });

  it("asks the host for a row's detail on expand, and renders it", () => {
    render(<DeckApp />);
    host(reviewsMsg([mkReview()]));
    fireEvent.click(screen.getByText("a small fix"));
    expect(sent).toHaveBeenCalledWith({ type: "deck:reviewExpand", id: "o/r#1" });
    host({ type: "deck:reviewDetail", id: "o/r#1", detail: { failing: [{ name: "e2e", url: "" }], unresolved: 0 } });
    expect(screen.getByText("e2e")).toBeInTheDocument();
  });

  it("does not re-ask for a detail it already has, and still renders it once re-expanded", () => {
    render(<DeckApp />);
    host(reviewsMsg([mkReview()]));
    fireEvent.click(screen.getByText("a small fix"));
    host({ type: "deck:reviewDetail", id: "o/r#1", detail: { failing: [], unresolved: null } });
    fireEvent.click(screen.getByText("a small fix")); // collapse
    sent.mockClear();
    fireEvent.click(screen.getByText("a small fix")); // expand again
    expect(sent).not.toHaveBeenCalledWith({ type: "deck:reviewExpand", id: "o/r#1" });
    // The held detail must still render, not just "no re-fetch" — a guard that
    // skipped the fetch but also dropped the stored detail on collapse would
    // pass the assertion above while leaving the row stuck on "loading…".
    expect(screen.getByText("✓ checks passing")).toBeInTheDocument();
  });

  // No test anywhere in the repo had ever expanded two different rows before —
  // `setExpanded((cur) => (cur === id ? null : id))` reads correctly, but a
  // regression to "let both stay open" (e.g. a Set instead of a single id)
  // would have passed the entire suite. The two rows' failing-check names are
  // deliberately distinct so the assertion cannot pass by accident.
  it("single-select: expanding a second row collapses the first", () => {
    render(<DeckApp />);
    const a = mkReview({ id: "o/r#1", number: 1, title: "a small fix" });
    const b = mkReview({ id: "o/r#2", number: 2, title: "a bigger fix" });
    host(reviewsMsg([a, b]));

    fireEvent.click(screen.getByText("a small fix"));
    host({ type: "deck:reviewDetail", id: "o/r#1", detail: { failing: [{ name: "check-a", url: "" }], unresolved: 0 } });
    expect(screen.getByText("check-a")).toBeInTheDocument();

    fireEvent.click(screen.getByText("a bigger fix"));
    host({ type: "deck:reviewDetail", id: "o/r#2", detail: { failing: [{ name: "check-b", url: "" }], unresolved: 0 } });

    expect(screen.queryByText("check-a")).not.toBeInTheDocument();
    expect(screen.getByText("check-b")).toBeInTheDocument();
  });

  it("passes the loading flag through to the strip", () => {
    render(<DeckApp />);
    host({ ...reviewsMsg([], 0), loading: true } as OutboundMessage);
    expect(screen.getByText(/checking for PRs waiting on your review/i)).toBeInTheDocument();
  });

  // ── the batch ─────────────────────────────────────────────────────────────
  const three = () => [
    mkReview(),
    mkReview({ id: "o/r#2", number: 2, title: "second fix" }),
    mkReview({ id: "o/r#3", number: 3, title: "third fix" }),
  ];

  it("posts one reviewBatch message carrying every selected id", () => {
    render(<DeckApp />);
    host(reviewsMsg([mkReview(), mkReview({ id: "o/r#2", number: 2, title: "second fix" })], 2));
    fireEvent.click(screen.getByText("select"));
    fireEvent.click(screen.getByText("a small fix"));
    fireEvent.click(screen.getByText("second fix"));
    fireEvent.click(screen.getByRole("button", { name: /Review the 2 selected PRs with Claude Code/i }));
    // One message for the batch, not one per row — the host asks its questions once.
    expect(sent).toHaveBeenCalledWith({ type: "deck:reviewBatch", ids: ["o/r#1", "o/r#2"] });
  });

  it("extends the selection with shift-click, in queue order", () => {
    render(<DeckApp />);
    host(reviewsMsg(three(), 3));
    fireEvent.click(screen.getByText("select"));
    fireEvent.click(screen.getByText("a small fix"));
    fireEvent.click(screen.getByText("third fix"), { shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: /Review the 3 selected PRs with Claude Code/i }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:reviewBatch", ids: ["o/r#1", "o/r#2", "o/r#3"] });
  });

  it("extends a range picked bottom-up in queue order too", () => {
    // The ids go out in the order the queue shows them, never the order they were
    // clicked — the host names repos and worktrees off this list.
    render(<DeckApp />);
    host(reviewsMsg(three(), 3));
    fireEvent.click(screen.getByText("select"));
    fireEvent.click(screen.getByText("third fix"));
    fireEvent.click(screen.getByText("a small fix"), { shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: /Review the 3 selected PRs with Claude Code/i }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:reviewBatch", ids: ["o/r#1", "o/r#2", "o/r#3"] });
  });

  it("selects every shown row from the bar", () => {
    render(<DeckApp />);
    host(reviewsMsg(three(), 3));
    fireEvent.click(screen.getByText("select"));
    fireEvent.click(screen.getByText("Select all 3"));
    fireEvent.click(screen.getByRole("button", { name: /Review the 3 selected PRs with Claude Code/i }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:reviewBatch", ids: ["o/r#1", "o/r#2", "o/r#3"] });
  });

  it("sends ids in queue order even when they were clicked out of order", () => {
    // Not the shift-range path: two plain clicks, bottom row first. The host names
    // repos and worktrees off this list, so it must read like the queue does.
    render(<DeckApp />);
    host(reviewsMsg(three(), 3));
    fireEvent.click(screen.getByText("select"));
    fireEvent.click(screen.getByText("third fix"));
    fireEvent.click(screen.getByText("a small fix"));
    fireEvent.click(screen.getByRole("button", { name: /Review the 2 selected PRs with Claude Code/i }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:reviewBatch", ids: ["o/r#1", "o/r#3"] });
  });

  it("clicking a picked row again unpicks it", () => {
    render(<DeckApp />);
    host(reviewsMsg(three(), 3));
    fireEvent.click(screen.getByText("select"));
    fireEvent.click(screen.getByText("a small fix"));
    fireEvent.click(screen.getByText("second fix"));
    fireEvent.click(screen.getByText("a small fix"));
    fireEvent.click(screen.getByRole("button", { name: /Review the 1 selected PR with Claude Code/i }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:reviewBatch", ids: ["o/r#2"] });
  });

  it("leaves selection mode once the batch is launched", () => {
    render(<DeckApp />);
    host(reviewsMsg([mkReview()], 1));
    fireEvent.click(screen.getByText("select"));
    fireEvent.click(screen.getByText("a small fix"));
    fireEvent.click(screen.getByRole("button", { name: /Review the 1 selected PR with Claude Code/i }));
    // The bar is gone and the rows expand again — the gesture is over.
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
    // And the selection went with it: coming back to select mode starts from zero,
    // rather than re-offering the rows that were just launched.
    fireEvent.click(screen.getByText("select"));
    expect(screen.getByText(/0 selected/)).toBeInTheDocument();
  });

  it("drops the selection when selection mode is left without launching", () => {
    render(<DeckApp />);
    host(reviewsMsg(three(), 3));
    fireEvent.click(screen.getByText("select"));
    fireEvent.click(screen.getByText("a small fix"));
    fireEvent.click(screen.getByText("Done"));
    fireEvent.click(screen.getByText("select"));
    expect(screen.getByText(/0 selected/)).toBeInTheDocument();
  });

  it("drops a selected row that leaves the queue before the launch", () => {
    // A merged PR disappears on the next poll. Launching a stale id would ask the
    // host to review a row that no longer exists.
    render(<DeckApp />);
    host(reviewsMsg([mkReview(), mkReview({ id: "o/r#2", number: 2, title: "second fix" })], 2));
    fireEvent.click(screen.getByText("select"));
    fireEvent.click(screen.getByText("a small fix"));
    fireEvent.click(screen.getByText("second fix"));
    host(reviewsMsg([mkReview()], 1)); // #2 merged
    fireEvent.click(screen.getByRole("button", { name: /Review the 1 selected PR with Claude Code/i }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:reviewBatch", ids: ["o/r#1"] });
  });

  it("closes an open row when selection starts", () => {
    render(<DeckApp />);
    host(reviewsMsg([mkReview()], 1));
    fireEvent.click(screen.getByText("a small fix")); // expands
    fireEvent.click(screen.getByText("select"));
    fireEvent.click(screen.getByText("Done"));
    // Back out of selection and the row is shut — not silently still open underneath.
    expect(document.querySelector(".rv-detail")).toBeNull();
  });

});

describe("DeckApp review writes", () => {
  // Three places carry reviewWrites in DeckApp: the reviews state's type, its
  // initial value, and the deck:reviews handler's assignment — missing any one
  // leaves the verbs permanently hidden (safe) or permanently shown (not).
  // reviewsMsg's own default omits the field (false), so this pins the "off by
  // default, before any message says otherwise" half; the brief's own tests
  // below pin the "on once told so" half.
  it("keeps the box and verbs hidden until a deck:reviews message turns writes on", () => {
    render(<DeckApp />);
    host(reviewsMsg([mkReview()]));
    fireEvent.click(screen.getByText("a small fix"));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByText("Approve")).not.toBeInTheDocument();
  });

  it("submits with fromDraft true only after loading the agent's draft", () => {
    render(<DeckApp />);
    host({ ...reviewsMsg([mkReview({ draftPath: "/wt/REVIEW-1.md" })]), reviewWrites: true } as OutboundMessage);
    fireEvent.click(screen.getByText("a small fix"));
    fireEvent.click(screen.getByText(/Load the session's review/i));
    host({ type: "deck:reviewDraft", id: "o/r#1", body: "1. unbounded retry" });
    fireEvent.click(screen.getByText("Comment"));
    expect(sent).toHaveBeenCalledWith({
      type: "deck:reviewSubmit", id: "o/r#1", verb: "comment", body: "1. unbounded retry", fromDraft: true,
    });
  });

  it("submits with fromDraft false for a hand-typed body", () => {
    render(<DeckApp />);
    host({ ...reviewsMsg([mkReview()]), reviewWrites: true } as OutboundMessage);
    fireEvent.click(screen.getByText("a small fix"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "mine" } });
    fireEvent.click(screen.getByText("Comment"));
    expect(sent).toHaveBeenCalledWith({
      type: "deck:reviewSubmit", id: "o/r#1", verb: "comment", body: "mine", fromDraft: false,
    });
  });

  it("keeps fromDraft set when a loaded draft is edited", () => {
    render(<DeckApp />);
    host({ ...reviewsMsg([mkReview({ draftPath: "/wt/REVIEW-1.md" })]), reviewWrites: true } as OutboundMessage);
    fireEvent.click(screen.getByText("a small fix"));
    fireEvent.click(screen.getByText(/Load the session's review/i));
    host({ type: "deck:reviewDraft", id: "o/r#1", body: "1. unbounded retry" });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "1. the retry budget is unbounded" } });
    fireEvent.click(screen.getByText("Comment"));
    expect(sent).toHaveBeenCalledWith({
      type: "deck:reviewSubmit", id: "o/r#1", verb: "comment",
      body: "1. the retry budget is unbounded", fromDraft: true,
    });
  });

  it("clears fromDraft when the box is emptied", () => {
    render(<DeckApp />);
    host({ ...reviewsMsg([mkReview({ draftPath: "/wt/REVIEW-1.md" })]), reviewWrites: true } as OutboundMessage);
    fireEvent.click(screen.getByText("a small fix"));
    fireEvent.click(screen.getByText(/Load the session's review/i));
    host({ type: "deck:reviewDraft", id: "o/r#1", body: "1. unbounded retry" });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "all mine now" } });
    fireEvent.click(screen.getByText("Comment"));
    expect(sent).toHaveBeenCalledWith({
      type: "deck:reviewSubmit", id: "o/r#1", verb: "comment", body: "all mine now", fromDraft: false,
    });
  });

  // The old design cleared `submitting` on the next `toast` or `deck:reviews`
  // post; the coordinator found that both arrive far more often, and for
  // reasons unrelated to any one submit, than the real outcome does — a 6s
  // poll tick or an unrelated toast would release (or wrongly fail) a row
  // that was still genuinely waiting on `gh`. `deck:reviewSubmitDone` is the
  // only thing that carries the id, so it is the only thing these tests (and
  // the implementation) trust.
  it("disables Approve for a row once its submit is posted, until deck:reviewSubmitDone arrives", () => {
    render(<DeckApp />);
    host({ ...reviewsMsg([mkReview()]), reviewWrites: true } as OutboundMessage);
    fireEvent.click(screen.getByText("a small fix"));
    fireEvent.click(screen.getByText("Approve"));
    expect((screen.getByText("Approve") as HTMLButtonElement).disabled).toBe(true);
    host({ type: "deck:reviewSubmitDone", id: "o/r#1", outcome: "ok" });
    expect((screen.getByText("Approve") as HTMLButtonElement).disabled).toBe(false);
  });

  // The regression this pins: a routine poll tick (deck:reviews arrives roughly
  // every 6s while the cache is fresh) must NOT release the disable — only
  // `deck:reviewSubmitDone` may. Run against the pre-fix implementation (which
  // released on every `deck:reviews`), this fails at the first assertion below.
  it("does not release the in-flight disable on a routine reviews poll", () => {
    render(<DeckApp />);
    host({ ...reviewsMsg([mkReview()]), reviewWrites: true } as OutboundMessage);
    fireEvent.click(screen.getByText("a small fix"));
    fireEvent.click(screen.getByText("Approve"));
    expect((screen.getByText("Approve") as HTMLButtonElement).disabled).toBe(true);
    host({ ...reviewsMsg([mkReview()]), reviewWrites: true } as OutboundMessage); // a routine poll tick
    expect((screen.getByText("Approve") as HTMLButtonElement).disabled).toBe(true);
    host({ type: "deck:reviewSubmitDone", id: "o/r#1", outcome: "ok" });
    expect((screen.getByText("Approve") as HTMLButtonElement).disabled).toBe(false);
  });

  it("re-enables a row without marking it failed when the submit is cancelled (declined)", () => {
    render(<DeckApp />);
    host({ ...reviewsMsg([mkReview()]), reviewWrites: true } as OutboundMessage);
    fireEvent.click(screen.getByText("a small fix"));
    fireEvent.click(screen.getByText("Approve"));
    expect((screen.getByText("Approve") as HTMLButtonElement).disabled).toBe(true);
    host({ type: "deck:reviewSubmitDone", id: "o/r#1", outcome: "cancelled" });
    expect((screen.getByText("Approve") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/check the pr before trying again/i)).not.toBeInTheDocument();
  });

  // Keyed by id in DeckApp's own state, not just in ReviewStrip's props — a single
  // shared boolean ("something, somewhere, is submitting") would also pass every
  // test above but would wrongly freeze every other row's buttons too.
  it("leaves a different row's verbs enabled while one row's submit is in flight", () => {
    render(<DeckApp />);
    const a = mkReview({ id: "o/r#1", number: 1, title: "a small fix" });
    const b = mkReview({ id: "o/r#2", number: 2, title: "a bigger fix" });
    host({ ...reviewsMsg([a, b]), reviewWrites: true } as OutboundMessage);
    fireEvent.click(screen.getByText("a small fix"));
    fireEvent.click(screen.getByText("Approve"));
    fireEvent.click(screen.getByText("a small fix")); // collapse row 1, still mid-submit
    fireEvent.click(screen.getByText("a bigger fix")); // expand row 2
    expect((screen.getByText("Approve") as HTMLButtonElement).disabled).toBe(false);
  });

  // The poll-interleave regression, for the failure warning specifically: a
  // deck:reviews tick lands *between* the click and the outcome, and must
  // change nothing. Against the pre-fix implementation this fails at the first
  // assertion (the interleaved poll cleared `submitting` early, so the box was
  // already re-enabled and unwarned well before the real outcome landed).
  it("shows the failed-submit warning only once deck:reviewSubmitDone says failed, surviving an interleaved poll", () => {
    render(<DeckApp />);
    host({ ...reviewsMsg([mkReview()]), reviewWrites: true } as OutboundMessage);
    fireEvent.click(screen.getByText("a small fix"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "lgtm" } });
    fireEvent.click(screen.getByText("Comment"));
    host({ ...reviewsMsg([mkReview()]), reviewWrites: true } as OutboundMessage); // interleaved poll tick
    expect((screen.getByText("Comment") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/check the pr before trying again/i)).not.toBeInTheDocument();
    host({ type: "deck:reviewSubmitDone", id: "o/r#1", outcome: "failed" });
    expect(screen.getByText(/check the pr before trying again/i)).toBeInTheDocument();
    // Re-enabled, not locked out: a repeat is meant to be an informed click, not a
    // blocked one.
    expect((screen.getByText("Comment") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByText("Comment"));
    host({ type: "deck:reviewSubmitDone", id: "o/r#1", outcome: "ok" });
    expect(screen.queryByText(/check the pr before trying again/i)).not.toBeInTheDocument();
  });

  it("clears the row's box and fromDraft flag after a successful submit", () => {
    render(<DeckApp />);
    host({ ...reviewsMsg([mkReview({ draftPath: "/wt/REVIEW-1.md" })]), reviewWrites: true } as OutboundMessage);
    fireEvent.click(screen.getByText("a small fix"));
    fireEvent.click(screen.getByText(/Load the session's review/i));
    host({ type: "deck:reviewDraft", id: "o/r#1", body: "1. unbounded retry" });
    fireEvent.click(screen.getByText("Comment"));
    host({ type: "deck:reviewSubmitDone", id: "o/r#1", outcome: "ok" });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    // Not just visually empty — fromDraft must have cleared too, or a fresh,
    // hand-typed follow-up would wrongly submit as agent-drafted.
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "second look" } });
    fireEvent.click(screen.getByText("Comment"));
    expect(sent).toHaveBeenCalledWith({
      type: "deck:reviewSubmit", id: "o/r#1", verb: "comment", body: "second look", fromDraft: false,
    });
  });

  it("leaves the box alone after a cancelled submit", () => {
    render(<DeckApp />);
    host({ ...reviewsMsg([mkReview()]), reviewWrites: true } as OutboundMessage);
    fireEvent.click(screen.getByText("a small fix"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "lgtm" } });
    fireEvent.click(screen.getByText("Comment"));
    host({ type: "deck:reviewSubmitDone", id: "o/r#1", outcome: "cancelled" });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("lgtm");
  });

  // Nothing anywhere pinned that `bodies` is truly per-id rather than, say, a
  // single shared value — a mutation to `Object.values(p.bodies)[0]` would have
  // passed every test above (all of them use exactly one row's box at a time).
  it("keeps each row's typed body separate from every other row's", () => {
    render(<DeckApp />);
    const a = mkReview({ id: "o/r#1", number: 1, title: "a small fix" });
    const b = mkReview({ id: "o/r#2", number: 2, title: "a bigger fix" });
    host({ ...reviewsMsg([a, b]), reviewWrites: true } as OutboundMessage);
    fireEvent.click(screen.getByText("a small fix"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "row one text" } });
    fireEvent.click(screen.getByText("a small fix")); // collapse row 1
    fireEvent.click(screen.getByText("a bigger fix")); // expand row 2
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "row two text" } });
    fireEvent.click(screen.getByText("a bigger fix")); // collapse row 2
    fireEvent.click(screen.getByText("a small fix")); // re-expand row 1
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("row one text");
  });

  // Requirement is "empty OR whitespace-only" — every other fromDraft test uses
  // `""` or a real word, so mutating the `!body.trim()` guard to `!body` would
  // pass all of them.
  it("also clears fromDraft when the box is edited down to whitespace only", () => {
    render(<DeckApp />);
    host({ ...reviewsMsg([mkReview({ draftPath: "/wt/REVIEW-1.md" })]), reviewWrites: true } as OutboundMessage);
    fireEvent.click(screen.getByText("a small fix"));
    fireEvent.click(screen.getByText(/Load the session's review/i));
    host({ type: "deck:reviewDraft", id: "o/r#1", body: "1. unbounded retry" });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "   " } });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "all mine now" } });
    fireEvent.click(screen.getByText("Comment"));
    expect(sent).toHaveBeenCalledWith({
      type: "deck:reviewSubmit", id: "o/r#1", verb: "comment", body: "all mine now", fromDraft: false,
    });
  });

  it("renders a toast's Open PR action and opens it externally", () => {
    render(<DeckApp />);
    host({ type: "toast", level: "error", message: "GitHub refused: nope", action: { label: "Open PR", url: "https://gh/o/r/pull/1" } });
    fireEvent.click(screen.getByText("Open PR"));
    expect(sent).toHaveBeenCalledWith({ type: "openExternal", url: "https://gh/o/r/pull/1" });
  });

  it("renders no action button for a toast that carries none", () => {
    render(<DeckApp />);
    host({ type: "toast", level: "info", message: "just fyi" });
    expect(screen.queryByRole("button", { name: /open pr/i })).not.toBeInTheDocument();
  });
});

// This block used to pin a lane-driven gate (`canAddressPr`): one generic
// "Address PR" button, shown on the review column's waiting lane regardless
// of whether anything was actually wrong with the PR. The design replaces
// that with cardActions() naming each real problem with its own row and
// verb — a failing check, a conflict, or changes requested — so a lane can no
// longer say "there is something to address" on its own; only a genuine
// problem can. Every test below is converted, not deleted: the old
// button-presence assertions become "no action row at all" assertions (most
// of these fixtures have nothing wrong with their PR, so cardActions
// correctly returns nothing), and the local-card case is strengthened to
// prove the guard holds under real pressure. The original lane-gated
// assertions live in git history at commit daff687.
describe("DeckApp — per-failure PR actions", () => {
  // Still waiting on a human, but nothing actually WRONG with it: review
  // pending, CI clean, nothing conflicting. Under the old lane-driven rule
  // this alone earned "Address PR"; cardActions earns it nothing.
  const waitingPr = (over: Partial<RunStatus> = {}) => mkStatus({
    column: "review",
    prs: { svc: { facts: prFacts({ review: "review_required" }), fetchedAt: 1 } },
    ...over,
  });

  // The sharpest behavioural change in this task: an unapproved PR is not a PR
  // with a problem. cardActions produces a row only for a failing check, a
  // conflict, or changes_requested — none of which review_required + clean CI
  // + clean mergeability has, however long it has been sitting on the lane.
  it("shows no action row for a waiting PR with nothing actually wrong with it", () => {
    render(<DeckApp />);
    host(runsMsg([waitingPr()]));
    expect(document.querySelector(".c-rows")).toBeNull();
    expect(screen.queryByRole("button", { name: "Fix CI" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resolve conflict" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Address review" })).toBeNull();
  });

  it("shows no action row on the review column's ready lane either", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({
      column: "review",
      prs: { svc: { facts: prFacts({ review: "approved", mergeable: "clean" }), fetchedAt: 1 } },
    })]));
    expect(document.querySelector(".c-rows")).toBeNull();
  });

  it("shows no action row on a card outside the review column", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ column: "progress" })]));
    expect(document.querySelector(".c-rows")).toBeNull();
  });

  // Proves the old ticket-status path is actually dead, not just superseded
  // in the common case: a Jira status that exactly matched the configured
  // prReviewStatus used to be sufficient on its own, from any column.
  // cardActions never reads `ticketStatus` at all.
  it("shows no action row from a matching Jira status alone, off the review column", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ ticketStatus: "PR initiated", column: "progress" })], "PR initiated"));
    expect(document.querySelector(".c-rows")).toBeNull();
  });

  // deriveBucket's isReviewStatus (`/review|qa|verif/i`) can land a run in the
  // review column off a Jira status alone, with no PR entries at all —
  // cardActions' own `!f` guard (leadPr returns null with no PR facts) is
  // what keeps this card silent, not any lane check.
  it("shows no action row on the review column with no PR at all (prs: {})", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ column: "review", ticketStatus: "In QA", prs: {} })]));
    expect(document.querySelector(".c-rows")).toBeNull();
  });

  // The most important case in this block. The `local` guard exists because a
  // local card's ticket is inferred from a branch name that may belong to
  // somebody else's ticket, and seeding an agent against that inference on
  // one click is what this must never do. Strengthened from a healthy PR (the
  // old fixture) to one with every kind of problem at once — failing CI,
  // changes requested, and a conflict — so this pins the guard against real
  // pressure, not against a PR that would show nothing anyway.
  it("shows no action row on a local card even when its PR is failing outright", () => {
    render(<DeckApp />);
    host(runsMsg([waitingPr({
      run: { ...mkStatus().run, key: "local-a", url: "", kind: "local" } as never,
      prs: { svc: { facts: failingPr(), fetchedAt: 1 } },
    })]));
    expect(document.querySelector(".c-rows")).toBeNull();
    expect(screen.queryByRole("button", { name: "Fix CI" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resolve conflict" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Address review" })).toBeNull();
  });

  it("sends deck:seedPrWork with reason review when Address review is clicked", () => {
    render(<DeckApp />);
    host(runsMsg([waitingPr({ prs: { svc: { facts: prFacts({ review: "changes_requested" }), fetchedAt: 1 } } })]));
    fireEvent.click(screen.getByRole("button", { name: "Address review" }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:seedPrWork", key: "ASM-1", reason: "review" });
  });

  it("moves the named action off the footer into .c-rows, leaving Open and Diff as the only footer buttons", () => {
    render(<DeckApp />);
    host(runsMsg([waitingPr({ prs: { svc: { facts: prFacts({ review: "changes_requested" }), fetchedAt: 1 } } })]));
    const footerLabels = Array.from(document.querySelectorAll(".card .c-foot2 .act")).map((b) => b.textContent);
    expect(footerLabels).toEqual(["Open", "Diff"]);
    const reviewBtn = screen.getByRole("button", { name: "Address review" });
    expect(document.querySelector(".c-foot2")!.contains(reviewBtn)).toBe(false);
    expect(document.querySelector(".c-rows")!.contains(reviewBtn)).toBe(true);
  });

  // Open is always the footer's one primary now — the design drops the old
  // swap where Address PR took that weight instead. One card, one primary,
  // decided the same way whether or not an action row is also there.
  it("keeps Open primary even when the card also has action rows", () => {
    render(<DeckApp />);
    host(runsMsg([waitingPr({ prs: { svc: { facts: prFacts({ review: "changes_requested" }), fetchedAt: 1 } } })]));
    expect(screen.getByRole("button", { name: "Open" })).toHaveClass("primary");
    expect(screen.getByRole("button", { name: "Address review" })).not.toHaveClass("primary");
  });

  it("leaves Open the primary on a card with no action rows", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ ticketStatus: "In Progress" })]));
    expect(screen.getByRole("button", { name: "Open" })).toHaveClass("primary");
  });
});

// An In-review card with no agent open and a blocked PR is the fixes-needed lane's
// normal inhabitant — the PR wants something and there is nobody in the run to ask.
// Its state line used to read the parked grey, which says "nothing is happening" on
// a card that is the whole reason the lane exists, and with no agents anywhere that
// made the lane read as uniformly disabled.
describe("DeckApp — an agentless In review card with a blocked PR", () => {
  const blocked = (over: Partial<PrFacts> = {}) => mkStatus({
    column: "review",
    agent: { state: "unknown", lastActivityMs: null, slug: null },
    agents: [],
    prs: { svc: { facts: prFacts({ review: "changes_requested", ...over }), fetchedAt: 1 } },
  });

  it("names the block in the attn tone instead of the parked grey", () => {
    const { container } = render(<DeckApp />);
    host(runsMsg([blocked()]));
    const status = container.querySelector(".status") as HTMLElement;
    expect(status.textContent).toContain("pr blocked");
    expect(status.className).toContain("tone-attn");
    expect(status.className).not.toContain("tone-parked");
    expect(screen.queryByText(/parked · git \+ Jira only/)).not.toBeInTheDocument();
  });

  it("carries the attn dot, so the column's leading edge scans as one signal", () => {
    const { container } = render(<DeckApp />);
    host(runsMsg([blocked()]));
    expect(container.querySelector(".sdot.tone-attn")).not.toBeNull();
  });

  it("reaches the line through a failing check too, not only a review", () => {
    const { container } = render(<DeckApp />);
    host(runsMsg([blocked({ review: "none", ci: { passing: 1, pending: 0, failing: [{ name: "unit", url: "" }] } })]));
    expect((container.querySelector(".status") as HTMLElement).textContent).toContain("pr blocked");
  });

  // The guard matters: `needs` with no agent and nothing blocking is a state the
  // ladder shouldn't produce, and inventing "pr blocked" for it would be a lie.
  it("keeps the parked line when nothing about the PR is actually blocking", () => {
    render(<DeckApp />);
    host(runsMsg([blocked({ review: "approved" })]));
    expect(screen.getByText(/parked · git \+ Jira only/)).toBeInTheDocument();
  });

  it("leaves an agentless card in another column parked", () => {
    // The line is scoped to the column that owns PR trouble. In progress does not:
    // a card there is described by its agent read, whatever a stale PR fact says.
    render(<DeckApp />);
    host(runsMsg([mkStatus({
      column: "progress",
      agent: { state: "unknown", lastActivityMs: null, slug: null },
      agents: [],
      prs: { svc: { facts: prFacts({ review: "changes_requested" }), fetchedAt: 1 } },
    })]));
    expect(screen.getByText(/parked · git \+ Jira only/)).toBeInTheDocument();
  });
});

describe("Agents view", () => {
  it("renders one card per agent when their states put them in different columns", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ agents: [
      { ...mkAgent("agent-flow-2e", "working", 100), repo: "svc" },
      { ...mkAgent("svc-7f", "needs-you", 200), repo: "svc" },
    ] })]));
    // Claude's own session name/slug never renders on a card — it's not a
    // user-facing name, it's CLI-internal (e.g. "agent-flow-2e").
    expect(screen.queryByText("agent-flow-2e")).not.toBeInTheDocument();
    expect(screen.queryByText("svc-7f")).not.toBeInTheDocument();
    expect(screen.getByText(/working ·/)).toBeInTheDocument();
    expect(screen.getByText(/ended turn ·/)).toBeInTheDocument();
    // One run, two cards, so the ticket appears twice.
    expect(screen.getAllByText("ASM-1")).toHaveLength(2);
  });

  it("sends the agent's own repo with Open, so each opens its own directory", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ agents: [{ ...mkAgent("a1", "working", 100), repo: "web" }] })]));
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:inspect", key: "ASM-1", action: "open", repo: "web" });
  });

  it("sends the agent's own repo with Diff too, so the diff editor opens that directory", () => {
    // The Diff line is shared ground with the multi-file diff editor work: that
    // change rewrote it without the repo argument, and losing the argument here
    // un-scopes an agent card's Diff to the run's first repo with nothing failing.
    render(<DeckApp />);
    host(runsMsg([mkStatus({ agents: [{ ...mkAgent("a1", "working", 100), repo: "web" }] })]));
    fireEvent.click(screen.getByRole("button", { name: "Diff" }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:inspect", key: "ASM-1", action: "diff", repo: "web" });
  });

  it("renders one parked card with no agent name for an agentless run", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ agents: [], agent: { state: "unknown", lastActivityMs: null, slug: null } })]));
    expect(screen.getByText(/parked · git \+ Jira only/)).toBeInTheDocument();
    expect(screen.getAllByText("ASM-1")).toHaveLength(1);
  });

  it("collapses to one card per run when there are no agents to show", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ agents: [] })]));
    expect(screen.getAllByText("ASM-1")).toHaveLength(1);
  });

  it("shows the workspace view's nested agents row instead when grouping is workspaces", () => {
    render(<DeckApp />);
    host({ type: "deck:grouping", grouping: "workspaces" });
    host(runsMsg([mkStatus({ agents: [{ ...mkAgent("agent-flow-2e", "working", 100), repo: "svc" }] })]));
    expect(screen.getAllByText("ASM-1")).toHaveLength(1);
    // The collapsed agents row moved into the drawer's Agents section.
    fireEvent.click(document.querySelector(".card") as HTMLElement);
    expect(screen.getByTitle(/sessions open in this directory/i)).toBeInTheDocument();
  });

  it("shows the session slug as a tooltip on an expanded agent row", () => {
    render(<DeckApp />);
    host({ type: "deck:grouping", grouping: "workspaces" });
    host(runsMsg([mkStatus({
      agents: [{ ...mkAgent("agent-flow-2e", "working", 100), activity: { state: "working", lastActivityMs: 100, slug: "export-streaming-fix" } }],
    })]));
    // The drawer's AgentsRow ships expanded by default — no click needed.
    fireEvent.click(document.querySelector(".card") as HTMLElement);
    expect(screen.getByTitle("export-streaming-fix")).toBeInTheDocument();
  });

  it("has no title on an expanded agent row when no slug is known yet", () => {
    const { container } = render(<DeckApp />);
    host({ type: "deck:grouping", grouping: "workspaces" });
    host(runsMsg([mkStatus({
      agents: [mkAgent("agent-flow-2e", "working", 100)],
    })]));
    // The drawer's AgentsRow ships expanded by default — no click needed.
    fireEvent.click(container.querySelector(".card") as HTMLElement);
    expect(container.querySelector(".ag-name")).not.toHaveAttribute("title");
  });

  it("splits one run's agents across the columns their own states put them in", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ agents: [
      { ...mkAgent("a-working", "working", 100), repo: "svc" },
      { ...mkAgent("a-ended", "needs-you", 200), repo: "svc" },
    ] })]));
    const columns = Array.from(document.querySelectorAll(".col")).map((c) => ({
      name: c.querySelector(".nm")!.textContent,
      cardCount: c.querySelectorAll(".card").length,
    }));
    expect(columns.find((c) => c.name === "In progress")!.cardCount).toBe(1);
    expect(columns.find((c) => c.name === "Action required")!.cardCount).toBe(1);
  });

  it("merges same-column agents into one card instead of showing look-alike duplicates", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ agents: [
      { ...mkAgent("a-working-1", "working", 100), repo: "svc" },
      { ...mkAgent("a-working-2", "working", 200), repo: "svc" },
    ] })]));
    const inProgress = Array.from(document.querySelectorAll(".col")).find((c) => c.querySelector(".nm")!.textContent === "In progress")!;
    expect(inProgress.querySelectorAll(".card")).toHaveLength(1);
    // The merged card lists both sessions in its collapsed agents row.
    expect(screen.getByText("2 sessions")).toBeInTheDocument();
  });

  it("counts cards, not runs, in the stat tiles", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ agents: [
      { ...mkAgent("a1", "working", 100), repo: "svc" },
      { ...mkAgent("a2", "needs-you", 200), repo: "svc" },
    ] })]));
    const tiles = Array.from(document.querySelectorAll(".stat")).map((s) => [s.querySelector(".l")!.textContent, s.querySelector(".n")!.textContent]);
    // One run, one agent per column — two cards total, not one per run.
    expect(tiles).toContainEqual(["In progress", "1"]);
    expect(tiles).toContainEqual(["Action required", "1"]);
  });

  it("offers Clear stale only when something is actually stale", () => {
    render(<DeckApp />);
    host({ ...runsMsg([mkStatus()]), staleCount: 0 } as OutboundMessage);
    expect(screen.queryByRole("button", { name: /clear stale/i })).not.toBeInTheDocument();
    host({ ...runsMsg([mkStatus()]), staleCount: 2 } as OutboundMessage);
    fireEvent.click(screen.getByRole("button", { name: /clear stale \(2\)/i }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:clearStale" });
  });

  it("asks the host to persist the grouping when the control is clicked", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    fireEvent.click(screen.getByRole("button", { name: "Workspaces" }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:setGrouping", grouping: "workspaces" });
  });

  it("takes the lens from its own seed message and keeps it across board posts", () => {
    render(<DeckApp />);
    host({ type: "deck:grouping", grouping: "workspaces" });
    host(runsMsg([mkStatus()]));

    expect(screen.getByText("Workspaces").closest("button")).toHaveClass("on");
  });
});

// The Deck's own copy of Task 13's promise: every "Jira"-shaped string on the
// board reads sourceLabel rather than hardcoding a tracker, so connector #2's
// author never has to touch this file. Byte-identity for Jira (the default) is
// the bar — full literals, not toContain fragments, which would pass on drifted
// wording — plus a non-Jira mutation proving the label actually reaches render
// rather than a hardcoded default silently surviving underneath it.
describe("DeckApp — source label", () => {
  const localCard = (): RunStatus => mkStatus({
    run: {
      key: "local-centaur-1a2b3c4d", summary: "team table new design",
      url: "https://jira/browse/ASM-5641", createdAt: 1, kind: "local", mode: "per-window",
      repos: [{ name: "centaur", path: "/r/centaur", isGit: true, branch: "ASM-5641-team-table" }], briefPaths: [],
    },
    inferredTicketKey: "ASM-5641",
  });

  it("renders the chrome's Jira strings byte-for-byte before any deck:runs arrives — the defaulted first paint", () => {
    render(<DeckApp />);
    expect(screen.getByTitle("Re-read git, Jira and PR state now")).toBeInTheDocument();
    expect(document.querySelector(".note")!.textContent).toBe("git + Jira backbone · best-effort live from ~/.claude/projects");
  });

  it("renders the chrome's Jira strings byte-for-byte once a Jira-labeled deck:runs lands", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    expect(screen.getByTitle("Re-read git, Jira and PR state now")).toBeInTheDocument();
    expect(document.querySelector(".note")!.textContent).toBe("git + Jira backbone · best-effort live from ~/.claude/projects");
  });

  it("renders a tracked card's Jira strings byte-for-byte: key title, status pill title, drawer action item", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    expect(screen.getByTitle("Open ASM-1 in Jira")).toBeInTheDocument();
    // The status pill and the "Open in <source>" action both moved into the drawer.
    fireEvent.click(document.querySelector(".card") as HTMLElement);
    expect(screen.getByTitle("Jira status: In Progress")).toBeInTheDocument();
    expect(screen.getByText("Open in Jira")).toBeInTheDocument();
  });

  it("renders a local/inferred card's key title with Jira byte-for-byte", () => {
    render(<DeckApp />);
    host(runsMsg([localCard()]));
    expect(screen.getByTitle("Open ASM-5641 in Jira")).toBeInTheDocument();
  });

  it("templates every one of those strings off a non-Jira sourceLabel — proving the label actually reaches the render", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()], "PR initiated", "Acme"));
    expect(screen.getByTitle("Re-read git, Acme and PR state now")).toBeInTheDocument();
    expect(document.querySelector(".note")!.textContent).toBe("git + Acme backbone · best-effort live from ~/.claude/projects");
    expect(screen.getByTitle("Open ASM-1 in Acme")).toBeInTheDocument();
    // The status pill and the "Open in <source>" action both moved into the drawer.
    fireEvent.click(document.querySelector(".card") as HTMLElement);
    expect(screen.getByTitle("Acme status: In Progress")).toBeInTheDocument();
    expect(screen.getByText("Open in Acme")).toBeInTheDocument();
    // A fresh deck:runs post with an unknown agent activity is the only way left
    // to reach the parked string — the live signal is unconditional now, so
    // there is no toggle to click.
    host(runsMsg([mkStatus({ agent: { state: "unknown", lastActivityMs: null, slug: null } })], "PR initiated", "Acme"));
    expect(screen.getByText("parked · git + Acme only")).toBeInTheDocument();
    // No trace of the shipped default anywhere on the rendered board.
    expect(document.body.textContent).not.toMatch(/Jira/);
  });

  it("templates the inferred-key card title off a non-Jira sourceLabel too", () => {
    render(<DeckApp />);
    host(runsMsg([localCard()], "PR initiated", "Acme"));
    expect(screen.getByTitle("Open ASM-5641 in Acme")).toBeInTheDocument();
    expect(screen.queryByTitle(/in Jira/)).not.toBeInTheDocument();
  });
});

// A place node resolves to exactly one repo — the invariant the whole node model
// rests on. If a multi-repo card became draggable, it would produce a node whose
// `repo` matches nothing, and every condition on it would silently never fire.
describe("the drag source", () => {
  it("makes a single-repo card draggable, carrying its run key and repo", () => {
    const card = renderOneCard({ key: "ASM-1", repos: [{ name: "agent-flow" }] });
    expect(card.getAttribute("draggable")).toBe("true");
    const dt = { setData: vi.fn() };
    fireEvent.dragStart(card, { dataTransfer: dt });
    expect(dt.setData).toHaveBeenCalledWith("text/plain", `ASM-1${DRAG_SEP}agent-flow`);
  });

  it("does not make a multi-repo card draggable — a place node must mean one repo", () => {
    const card = renderOneCard({
      key: "ASM-2",
      repos: [{ name: "api" }, { name: "web" }],
    });
    expect(card.getAttribute("draggable")).not.toBe("true");
  });

  it("a two-repo run's agent card is draggable when the agent names its own repo", () => {
    const agent: CardAgent = { ...mkAgent("sess-1", "working", 1_000), repo: "api" };
    const card = renderOneCard({ key: "ASM-3", repos: [{ name: "api" }, { name: "web" }], agents: [agent] });
    expect(card.getAttribute("draggable")).toBe("true");
    const dt = { setData: vi.fn() };
    fireEvent.dragStart(card, { dataTransfer: dt });
    expect(dt.setData).toHaveBeenCalledWith("text/plain", `ASM-3${DRAG_SEP}api`);
  });
});

// The DeckApp↔drawer seam. `setOrchEnabled` is the only writer of `orchEnabled`
// and `deck:flows` is its only source, so before these tests nothing in the suite
// ever put the board in its orchestrator-enabled state: the chip, the auto-open
// logic and all seven drawer callbacks were unexercised, and a mistyped
// `flow:*` message name would have shipped green. The assertions below name the
// literal `type` strings on purpose — a typo is the failure mode.
const mkFlow = (id: string, name: string): Flow => ({
  id, name, armed: false, createdAt: 1_000, nodes: [], edges: [],
});

/** A flow whose single edge `e1` has already fired — for the reset-through-
 * DeckApp test below, which needs a real fired edge to click Reset on. */
const firedFlow = (): Flow => ({
  ...mkFlow("f1", "Ship the migration"),
  nodes: [
    { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "ASM-1", repo: "agent-flow" },
    { id: "n2", kind: "notify", x: 320, y: 24, join: "any", message: "landed" },
  ],
  edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify", firedAt: 5, firedNote: "told you: landed" }],
});

// `pendingResume` defaults empty: the resume gate (Task 4) is host-side state
// with no rendering yet (Task 6 wires the banner) — every existing fixture here
// predates the field and has nothing to hold.
const flowsMsg = (flows: Flow[], enabled = true): OutboundMessage =>
  ({ type: "deck:flows", commands: [], branchCi: {}, flows, enabled, pendingResume: [], promptModes: [] });

/** The drawer itself, not the header chip that shares its name. */
const drawer = () => screen.queryByRole("complementary", { name: "Orchestrator" });
const chip = () => screen.getByRole("button", { name: /Orchestrator/ });

// The host and this webview ship in one .vsix, so a real post always carries
// every list on this message. What makes a missing one worth defending anyway is
// the blast radius: each lands in a prop the drawer dereferences on its next
// render, there is no error boundary anywhere in `src/`, and a throw out of
// render leaves the ROOT EMPTY — board and drawer both gone, with nothing on
// screen to say why. Measured against a harness whose `postFlows` predated the
// `commands` field.
describe("a deck:flows payload missing a field a newer webview reads", () => {
  /** A payload from a build that predates one of these fields, which is exactly
   * what a `delete` models — cast because `OutboundMessage` (correctly) says the
   * field is required, and the point of the test is a message that does not obey
   * the current type. */
  /** A flow with a real RULE in it, not a bare one: `promptModes` is dereferenced
   * only by an open rule's USING select, so a payload carrying an empty flow
   * never touches it and could not tell a missing list from a defended one. Two
   * places, so the rule derives `seed` and that select renders. */
  const withARule = (): Flow => ({
    ...mkFlow("f1", "Ship the migration"),
    nodes: [
      { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "ASM-1", repo: "agent-flow" },
      { id: "n2", kind: "place", x: 320, y: 24, join: "any", runKey: "ASM-2", repo: "agent-flow" },
    ],
    edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" } }],
  });

  const without = (field: "flows" | "commands" | "pendingResume" | "promptModes" | "branchCi"): OutboundMessage => {
    const msg = { ...flowsMsg([withARule()]) } as Record<string, unknown>;
    delete msg[field];
    return msg as unknown as OutboundMessage;
  };

  it("still renders the board and the drawer with no commands", () => {
    render(<DeckApp />);
    host(without("commands"));
    // The chip is the board's own control, so its presence IS "the panel
    // rendered" — under the unfixed version this query finds nothing at all,
    // because the whole tree threw.
    expect(chip()).toBeInTheDocument();
    fireEvent.click(chip());
    expect(drawer()).not.toBeNull();
    // And the picker the missing field feeds still opens, saying what an empty
    // list means rather than showing a blank popup.
    fireEvent.click(screen.getByRole("button", { name: "Add a command" }));
    const list = screen.getByRole("listbox", { name: "Add a command" });
    expect(within(list).queryAllByRole("option")).toEqual([]);
    expect(within(list).getByText(/set agentFlow.commands/)).toBeTruthy();
    // Free text stays offered, so a build that received no commands is still a
    // build you can add one in.
    expect(screen.getByRole("button", { name: "Free-text command…" })).toBeTruthy();
  });

  it("survives every other missing list on that message too", () => {
    // One `it` per field would pin the same guard four times; what matters is
    // that no member of the set is the odd one out.
    //
    // The drawer is OPENED for each, deliberately: `promptModes` and
    // `pendingResume` are dereferenced by the drawer alone, so a version of this
    // test that only looked for the chip passed with their defaults removed —
    // measured, and it was this test's first draft.
    //
    // `branchCi` is in the list for completeness, not because this can catch it:
    // it is the one field nothing dereferences unguarded (`describeCond` reads
    // `c.branchCi?.[key]`), so removing ITS default leaves this green. Said out
    // loud rather than left to look like coverage it is not.
    for (const field of ["flows", "pendingResume", "promptModes", "branchCi"] as const) {
      const r = render(<DeckApp />);
      host(without(field));
      expect(screen.queryByRole("button", { name: /Orchestrator/ })).not.toBeNull();
      fireEvent.click(chip());
      // With `flows` missing there is no flow to open, so the drawer stays shut;
      // every other case must actually render it — and then render a RULE, since
      // `promptModes` is reached only by an open rule's USING select.
      if (field !== "flows") {
        expect(drawer()).not.toBeNull();
        fireEvent.click(screen.getByTestId("orch-edge-e1"));
        expect(screen.getByLabelText("Mode")).toBeTruthy();
      }
      r.unmount();
    }
  });
});

describe("the Orchestrator chip", () => {
  it("appears once the host says the feature is on", () => {
    render(<DeckApp />);
    expect(screen.queryByRole("button", { name: /Orchestrator/ })).toBeNull();
    host(flowsMsg([]));
    expect(chip()).toBeInTheDocument();
  });

  it("renders no chip when the host says the feature is off", () => {
    render(<DeckApp />);
    host(flowsMsg([mkFlow("f1", "Ship it")], false));
    expect(screen.queryByRole("button", { name: /Orchestrator/ })).toBeNull();
    expect(drawer()).toBeNull();
  });

  it("counts the flows beside the label, and only when there are some", () => {
    render(<DeckApp />);
    host(flowsMsg([]));
    expect(chip().querySelector(".ct")).toBeNull();
    host(flowsMsg([mkFlow("f1", "a"), mkFlow("f2", "b")]));
    expect(chip().querySelector(".ct")!.textContent).toBe("2");
  });

  // With arming real, the count that matters is how many flows are armed — not
  // how many merely exist. Both directions of the condition are proved here so
  // inverting either branch of `armedCount > 0 ? ... : ...` fails one of them.
  it("reports the armed count on the chip, not the flow count", () => {
    render(<DeckApp />);
    host(flowsMsg([{ ...mkFlow("f1", "a"), armed: true }, mkFlow("f2", "b")]));
    expect(chip().textContent).toContain("1 armed");
  });

  it("shows a plain count when nothing is armed", () => {
    render(<DeckApp />);
    host(flowsMsg([mkFlow("f1", "a"), mkFlow("f2", "b")]));
    const text = chip().textContent ?? "";
    expect(text).not.toContain("armed");
    expect(text).toContain("2");
  });

  it("asks the host to create one when there are none", () => {
    render(<DeckApp />);
    host(flowsMsg([]));
    fireEvent.click(chip());
    expect(sent).toHaveBeenCalledWith({ type: "flow:create" });
  });

  it("opens the drawer via the chip when there is a flow", () => {
    render(<DeckApp />);
    host(flowsMsg([mkFlow("f1", "Ship the migration")]));
    // A saved flow no longer auto-opens on the post (Task 7) — only the chip does.
    expect(drawer()).toBeNull();
    fireEvent.click(chip());
    expect(drawer()).toBeInTheDocument();
    expect(screen.getByLabelText("Flow name")).toHaveValue("Ship the migration");
  });

  // The bug this phase carried over: on the first post the previous list is `[]`,
  // so every saved flow reads as "fresh" and popped the drawer open for anyone
  // who has one, every time they opened the Deck.
  it("does not open the drawer by itself when a saved flow arrives", () => {
    render(<DeckApp />);
    host(flowsMsg([mkFlow("f1", "Ship the migration")]));
    expect(drawer()).toBeNull();
  });

  // The behaviour the auto-open exists for, proved alongside the fix above so the
  // seen-set guard cannot be the kind of fix that also breaks what it must keep.
  it("still opens the drawer for a flow that was just created", () => {
    render(<DeckApp />);
    host(flowsMsg([]));
    fireEvent.click(chip());
    expect(sent).toHaveBeenCalledWith({ type: "flow:create" });
    host(flowsMsg([mkFlow("f1", "New flow")]));
    expect(drawer()).toBeInTheDocument();
  });

  it("does not ask the host for anything when it only toggles the drawer", () => {
    render(<DeckApp />);
    host(flowsMsg([mkFlow("f1", "Ship it")]));
    sent.mockClear();
    fireEvent.click(chip());
    fireEvent.click(chip());
    expect(sent).not.toHaveBeenCalled();
  });
});

describe("the deck:flows handler", () => {
  it("opens a flow it has not seen before — the answer to pressing the chip with none", () => {
    render(<DeckApp />);
    host(flowsMsg([]));
    fireEvent.click(chip());
    expect(sent).toHaveBeenCalledWith({ type: "flow:create" });
    expect(drawer()).toBeNull();
    // The host's answer to that create.
    host(flowsMsg([mkFlow("f1", "New flow")]));
    expect(drawer()).toBeInTheDocument();
  });

  // `setOpenFlowId` used to be called INSIDE `setFlows`'s updater — a side effect in
  // a state updater, which React's contract forbids because it may replay one. The
  // fix reads the previous list from a ref and calls both setters at the top level.
  //
  // Honest limit of this test: React 18.3.1's eager-state path calls a `useState`
  // updater exactly once when the hook's queue is empty and reuses the eagerly
  // computed result during render, so the nested version produces the same open flow
  // here and this test passes against both. It is StrictMode double-rendering the
  // whole board through the create round trip, which is worth having either way, and
  // it will start biting if React ever replays the updater for real.
  it("keeps a newly created flow open under StrictMode's double render", () => {
    render(<React.StrictMode><DeckApp /></React.StrictMode>);
    host(flowsMsg([]));
    fireEvent.click(chip());
    host(flowsMsg([mkFlow("f1", "New flow")]));
    expect(drawer()).toBeInTheDocument();
  });

  // Two posts landing before React re-renders — the host calls postFlows from more
  // than one place, so this is reachable. Batched, the nested version queued a
  // second `setOpenFlowId` whose `m.flows` was the later message's, which is exactly
  // the interleaving a side effect in an updater makes unpredictable.
  it("survives two posts arriving in one batch", () => {
    render(<DeckApp />);
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: flowsMsg([]) }));
      window.dispatchEvent(new MessageEvent("message", { data: flowsMsg([mkFlow("f1", "New flow")]) }));
    });
    expect(drawer()).toBeInTheDocument();
    expect(screen.getByLabelText("Flow name")).toHaveValue("New flow");
  });

  it("keeps the open flow open across an unrelated post", () => {
    render(<DeckApp />);
    host(flowsMsg([mkFlow("f1", "One")]));
    fireEvent.click(chip()); // a saved flow no longer auto-opens (Task 7)
    expect(drawer()).toBeInTheDocument();
    host(flowsMsg([mkFlow("f1", "One"), mkFlow("f2", "Two")]));
    // f2 is new, but f1 is still open and an open flow wins over a fresh one.
    expect(screen.getByLabelText("Flow name")).toHaveValue("One");
  });

  it("closes the drawer when the open flow is deleted elsewhere", () => {
    render(<DeckApp />);
    host(flowsMsg([mkFlow("f1", "One"), mkFlow("f2", "Two")]));
    fireEvent.click(chip()); // opens flows[0] ("One") — no longer automatic
    expect(drawer()).toBeInTheDocument();
    host(flowsMsg([mkFlow("f2", "Two")]));
    expect(drawer()).toBeNull();
  });

  // The two drawers share one fixed slot at z-index 40 (.dd and .orch in
  // deckStyles.ts) — reachable in practice because postFlows fires on every
  // refresh, so a flow created in a second VS Code window can land here while a
  // card is selected in this one, with no click on this window's own chip.
  it("closes a selected card's detail when a flow it has not seen before arrives", () => {
    render(<DeckApp />);
    host(flowsMsg([])); // establishes seenFlowsRef, previous list []
    host(runsMsg([mkStatus()]));
    fireEvent.click(document.querySelector(".card") as HTMLElement);
    expect(document.querySelector(".dd")).not.toBeNull();
    host(flowsMsg([mkFlow("f1", "New flow")])); // a fresh flow, not from this chip
    // `.dd.closing`, not absence: both drawers now leave the slot through the
    // same slide-out (Drawer.tsx's useDrawerExit), so the detail stays mounted
    // and inert for the length of it rather than vanishing in this frame. The
    // Orchestrator's own half of this pairing has read that way since it grew
    // an exit — see "closes the Orchestrator drawer when a card is selected".
    expect(document.querySelector(".dd.closing")).not.toBeNull();
    expect(document.querySelector(".orch")).not.toBeNull();
  });
});

describe("the drawer's callbacks", () => {
  /** Board with the feature on and one flow open in the drawer. */
  const open = (flows: Flow[] = [mkFlow("f1", "Ship the migration")]) => {
    render(<DeckApp />);
    host(flowsMsg(flows));
    fireEvent.click(chip()); // a saved flow no longer auto-opens (Task 7)
    sent.mockClear();
  };

  it("onSave posts flow:save with the whole flow", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "+ Notify" }));
    const call = sent.mock.calls.find((c) => c[0].type === "flow:save");
    expect(call).toBeDefined();
    expect(call![0]).toMatchObject({
      type: "flow:save",
      flow: { id: "f1", nodes: [expect.objectContaining({ kind: "notify" })] },
    });
  });

  it("onRename posts flow:rename with the id and the new name", () => {
    open();
    const input = screen.getByLabelText("Flow name");
    fireEvent.change(input, { target: { value: "Land it" } });
    fireEvent.blur(input);
    expect(sent).toHaveBeenCalledWith({ type: "flow:rename", id: "f1", name: "Land it" });
  });

  it("onDelete posts flow:delete with the id", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Delete flow" }));
    expect(sent).toHaveBeenCalledWith({ type: "flow:delete", id: "f1" });
    // And the drawer stops pointing at a flow that is gone.
    expect(drawer()).toBeNull();
  });

  it("onCreate posts flow:create from the drawer's own switcher", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: /^Flows/ }));
    fireEvent.click(screen.getByRole("button", { name: "+ New flow" }));
    expect(sent).toHaveBeenCalledWith({ type: "flow:create" });
  });

  it("onOpen switches flows locally, with no message to the host", () => {
    open([mkFlow("f1", "One"), mkFlow("f2", "Two")]);
    fireEvent.click(screen.getByRole("button", { name: /^Flows/ }));
    fireEvent.click(screen.getByRole("button", { name: "Two" }));
    expect(screen.getByLabelText("Flow name")).toHaveValue("Two");
    expect(sent).not.toHaveBeenCalled();
  });

  it("onClose closes the drawer locally, with no message to the host", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(drawer()).toBeNull();
    expect(sent).not.toHaveBeenCalled();
  });

  it("hands the drawer the board's runs, so a node can show its own state", () => {
    // The seventh prop. Without `runs` reaching the drawer, a node's state dot is
    // permanently dim and the inspector can never say what it is waiting on.
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    host(flowsMsg([{ ...mkFlow("f1", "One"),
      nodes: [{ id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-1", repo: "svc" }] }]));
    fireEvent.click(chip()); // a saved flow no longer auto-opens (Task 7)
    const dot = screen.getByTestId("orch-node-n1").querySelector(".d") as HTMLElement;
    // mkStatus's single-repo run has a working agent.
    expect(dot.style.background).toBe("var(--c-progress)");
  });

  // The point of these three is the exact `type` string on the wire — a typo in
  // any of them is the failure mode, and nothing else in the suite would catch
  // it: OrchestratorDrawer's own tests only see the callback, never the message
  // DeckApp turns it into.
  it("passes an arm through as flow:arm", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Arm" }));
    expect(sent).toHaveBeenCalledWith({ type: "flow:arm", id: "f1", armed: true });
  });

  it("passes a resume approval through as flow:resumeApprove", () => {
    render(<DeckApp />);
    host({
      type: "deck:flows",
      commands: [],
      branchCi: {},
      flows: [{ ...mkFlow("f1", "Ship the migration"), armed: true }],
      enabled: true,
      pendingResume: [{ flowId: "f1", flowName: "Ship the migration", lines: ["ready"] }],
      promptModes: [],
    });
    fireEvent.click(chip()); // a saved flow no longer auto-opens (Task 7)
    fireEvent.click(screen.getByRole("button", { name: /^go$/i }));
    expect(sent).toHaveBeenCalledWith({ type: "flow:resumeApprove", id: "f1" });
  });

  // The eighth prop, added alongside the acting verbs: without it reaching the
  // drawer, `USING` would have nothing to offer but an empty select — this pins
  // that the host's own list (not a hardcoded one) is what renders.
  it("hands the drawer the host's prompt modes, not a hardcoded list", () => {
    render(<DeckApp />);
    host({
      type: "deck:flows",
      commands: [],
      branchCi: {},
      flows: [{
        ...mkFlow("f1", "Ship the migration"),
        nodes: [
          { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "ASM-1", repo: "agent-flow" },
          { id: "n2", kind: "planned", x: 320, y: 24, join: "any", ticketKey: "ASM-12", repos: ["agent-flow"], mode: "quick", dest: "worktree" },
        ],
        edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "launch", mode: "quick" }],
      }],
      enabled: true,
      pendingResume: [],
      promptModes: [{ id: "quick", label: "Quick pass from the host" }],
    });
    fireEvent.click(chip());
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    const options = Array.from(screen.getByLabelText("Mode").querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toEqual(["Quick pass from the host"]);
  });

  it("passes a reset through as flow:resetEdge", () => {
    render(<DeckApp />);
    host(flowsMsg([firedFlow()]));
    fireEvent.click(chip()); // a saved flow no longer auto-opens (Task 7)
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    fireEvent.click(screen.getByRole("button", { name: /reset/i }));
    expect(sent).toHaveBeenCalledWith({ type: "flow:resetEdge", id: "f1", edgeId: "e1" });
  });
});

const wsStatus = () => mkStatus({
  run: {
    key: "ASM-9", summary: "e2e flake", url: "https://jira/ASM-9", createdAt: 1,
    mode: "multiroot", workspaceFile: "/ws/centaur+e2e.code-workspace",
    repos: [
      { name: "centaur", path: "/r/centaur", isGit: true, branch: "ASM-9-x" },
      { name: "automation_e2e", path: "/r/automation_e2e", isGit: true, branch: "main" },
    ],
    briefPaths: [],
  },
  repos: [
    { name: "centaur", path: "/r/centaur", branch: "ASM-9-x", dirty: true, ahead: 0, added: 0, removed: 0, files: 0 },
    { name: "automation_e2e", path: "/r/automation_e2e", branch: "main", dirty: false, ahead: 1, added: 12, removed: 2, files: 3 },
  ],
});

// The workspace label and its repo chips live in the drawer's Work section —
// every case here selects the card first.
describe("the drawer's workspace block", () => {
  it("names the workspace and counts its repos", () => {
    const { container } = render(<DeckApp />);
    host(runsMsg([wsStatus()]));
    fireEvent.click(container.querySelector(".card") as HTMLElement);
    const chip = container.querySelector(".c-ws .ws")!;
    expect(chip.textContent).toContain("centaur+e2e");
    expect(chip.textContent).toContain("2 repos");
    expect(chip.textContent).not.toContain(".code-workspace");
  });

  it("tooltips the label with the workspace file's own path, not a generic sentence", () => {
    // The path is the only thing that tells apart two open .code-workspace files
    // sharing a label — a generic sentence can't disambiguate them.
    const { container } = render(<DeckApp />);
    host(runsMsg([wsStatus()]));
    fireEvent.click(container.querySelector(".card") as HTMLElement);
    const chip = container.querySelector(".c-ws .ws")!;
    expect(chip.getAttribute("title")).toBe("/ws/centaur+e2e.code-workspace");
  });

  it("shows every repo chip under the label, with its git signal", () => {
    const { container } = render(<DeckApp />);
    host(runsMsg([wsStatus()]));
    fireEvent.click(container.querySelector(".card") as HTMLElement);
    const row = container.querySelector(".c-ws .c-repos")!;
    expect(Array.from(row.querySelectorAll(".repo")).map((r) => r.textContent))
      .toEqual(["centaur●", "automation_e2e+12−2↑1"]);
  });

  it("has nothing to expand — no fold, and a label rather than a toggle", () => {
    // The drawer is the surface with room to spare, so a reader who opened it to
    // find out which repos a task spans must not have to hover or click. Both
    // halves matter: a leftover .ws-fold rule would hide the chips with
    // display:none even though the markup renders them.
    const { container } = render(<DeckApp />);
    host(runsMsg([wsStatus()]));
    fireEvent.click(container.querySelector(".card") as HTMLElement);
    expect(container.querySelector(".c-ws .ws-fold")).toBeNull();
    expect(container.querySelector(".c-ws button")).toBeNull();
    expect(DECK_CSS).not.toContain("ws-fold");
  });

  it("leaves a single-repo run on the plain chip row", () => {
    const { container } = render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    fireEvent.click(container.querySelector(".card") as HTMLElement);
    expect(container.querySelector(".c-ws")).toBeNull();
    expect(container.querySelector(".c-repos .repo")!.textContent).toContain("svc");
  });

  it("leaves a multi-repo run with no workspace file on the plain chip row", () => {
    // Nothing to name: two folders opened side by side are not a workspace.
    const s = wsStatus();
    const { container } = render(<DeckApp />);
    host(runsMsg([{ ...s, run: { ...s.run, workspaceFile: undefined, mode: "per-window" } }]));
    fireEvent.click(container.querySelector(".card") as HTMLElement);
    expect(container.querySelector(".c-ws")).toBeNull();
    expect(container.querySelectorAll(".c-repos .repo")).toHaveLength(2);
  });
});

// The branch/launched row moved off the card into the drawer's Work section.
describe("branch line", () => {
  it("shows the branch of the repo this agent runs in", () => {
    // repos[0] is centaur on ASM-9-x; the agent runs in automation_e2e on main.
    const s = wsStatus();
    const agent: CardAgent = {
      session: { pid: 2, sessionId: "s9", cwd: "/r/automation_e2e", startedAt: 1, name: "e2e-3a" },
      activity: { state: "working", lastActivityMs: 2_000, slug: null },
      repo: "automation_e2e",
    };
    // The board mounts on the Agents lens (DeckApp.tsx:364), so this run renders
    // as one card per agent with no toggling.
    const { container } = render(<DeckApp />);
    host(runsMsg([{ ...s, agents: [agent] }]));
    fireEvent.click(container.querySelector(".card") as HTMLElement);
    expect(container.querySelector(".c-branch .bn")!.textContent).toContain("main");
  });

  it("falls back to the run's first repo on a card with no agent", () => {
    const { container } = render(<DeckApp />);
    host(runsMsg([wsStatus()]));
    fireEvent.click(container.querySelector(".card") as HTMLElement);
    expect(container.querySelector(".c-branch .bn")!.textContent).toContain("ASM-9-x");
  });
});

describe("Recently closed strip", () => {
  const closed = (key: string, summary: string) => mkStatus({
    shelf: "closed",
    run: { key, summary, url: "", kind: "notepad", createdAt: 1, mode: "per-window",
      repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "main" }], briefPaths: [],
      closedAt: Date.now() - 2 * 3_600_000 },
    repos: [], agents: [], column: "progress", ticketStatus: null, ticketCategory: null,
  });

  it("shows no strip when every run is on the board", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    expect(screen.getByText("Export fails on large accounts")).toBeInTheDocument();
    expect(screen.queryByText("Recently closed")).not.toBeInTheDocument();
  });

  it("moves a closed run off the board and into the strip, collapsed", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus(), closed("notepad-a", "Add drag and drop to the notepad")]));
    expect(screen.getByText("Recently closed")).toBeInTheDocument();
    expect(screen.queryByText("Add drag and drop to the notepad")).not.toBeInTheDocument();
  });

  it("leaves a closed run out of the column count and the stat tile", () => {
    render(<DeckApp />);
    // Both are column "progress"; only the board one may be counted.
    host(runsMsg([mkStatus(), closed("notepad-a", "Add drag and drop to the notepad")]));
    // "In progress" names both the stat tile and the column header, so the tile
    // is addressed through .stats rather than by its label alone.
    const tile = document.querySelector(".stats .stat");
    expect(tile?.querySelector(".l")?.textContent).toBe("In progress");
    expect(tile?.querySelector(".n")?.textContent).toBe("1");
    // ...and the column header agrees: one card, not two.
    const col = [...document.querySelectorAll(".col-hd")]
      .find((h) => h.querySelector(".nm")?.textContent === "In progress");
    expect(col?.querySelector(".ct")?.textContent).toBe("1");
  });

  it("reopens a strip row by its run key", () => {
    render(<DeckApp />);
    host(runsMsg([closed("notepad-a", "Add drag and drop to the notepad")]));
    fireEvent.click(screen.getByText("Recently closed"));
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:inspect", key: "notepad-a", action: "open" });
  });

  it("forgets a strip row through the same optimistic path as a card", () => {
    render(<DeckApp />);
    host(runsMsg([closed("notepad-a", "Add drag and drop to the notepad")]));
    fireEvent.click(screen.getByText("Recently closed"));
    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:forget", key: "notepad-a" });
    // Optimistic: the row leaves now, before any deck:runs comes back.
    expect(screen.queryByText("Add drag and drop to the notepad")).not.toBeInTheDocument();
  });

  it("clears every closed record at once", () => {
    render(<DeckApp />);
    host(runsMsg([closed("notepad-a", "one"), closed("notepad-b", "two")]));
    fireEvent.click(screen.getByText("Recently closed"));
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:forget", key: "notepad-a" });
    expect(sent).toHaveBeenCalledWith({ type: "deck:forget", key: "notepad-b" });
    expect(screen.queryByText("Recently closed")).not.toBeInTheDocument();
  });

  it("shows the strip rather than the empty state when nothing is live but something closed", () => {
    render(<DeckApp />);
    host(runsMsg([closed("notepad-a", "Add drag and drop to the notepad")]));
    expect(screen.queryByText("No tasks in flight")).not.toBeInTheDocument();
    expect(screen.getByText("Recently closed")).toBeInTheDocument();
  });

  it("still shows the empty state when nothing has been launched at all", () => {
    render(<DeckApp />);
    host(runsMsg([]));
    expect(screen.getByText("No tasks in flight")).toBeInTheDocument();
  });
});

describe("board zones", () => {
  /** The `.col` section whose header carries `label`. */
  const column = (label: string): HTMLElement =>
    [...document.querySelectorAll<HTMLElement>(".col")]
      .find((c) => c.querySelector(".col-hd .nm")?.textContent === label)!;

  const keys = (label: string) =>
    [...column(label).querySelectorAll(".card .key")].map((n) => n.textContent);

  /** A parked, PR-bearing run, on whichever column its PR facts earn it — the
   * host would have derived exactly this via deriveBucket. */
  const inReview = (key: string, over: Partial<PrFacts>): RunStatus => mkStatus({
    run: { ...mkStatus().run, key },
    column: over.review === "approved" || over.state === "MERGED" ? "merge" : "review",
    agents: [], agent: { state: "unknown", lastActivityMs: null, slug: null },
    prs: { svc: { facts: prFacts(over), fetchedAt: 1 } },
  });

  it("runs four zones left to right, ending at the merge", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    expect([...document.querySelectorAll(".col-hd .nm")].map((n) => n.textContent))
      .toEqual(["In progress", "Action required", "In review", "Merge"]);
  });

  it("gives a ready-to-merge run the merge column, apart from the ones still waiting", () => {
    render(<DeckApp />);
    host(runsMsg([inReview("ASM-2", { review: "none" }), inReview("ASM-1", { review: "approved" })]));
    expect(keys("Merge")).toEqual(["ASM-1"]);
    expect(keys("In review")).toEqual(["ASM-2"]);
    expect(column("Merge").querySelector(".col-hd .ct")?.textContent).toBe("1");
  });

  it("has no Done column at all — a merged run is not a stage of work", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    expect(document.querySelector(".col-hd .nm")).toBeTruthy();
    expect([...document.querySelectorAll(".col-hd .nm")].map((n) => n.textContent)).not.toContain("Done");
  });

  it("glows the dot on the live zones only — In review is a queue, not an activity", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    const glowing = [...document.querySelectorAll<HTMLElement>(".col")]
      .filter((c) => c.querySelector(".col-hd .dot.glow"))
      .map((c) => c.querySelector(".col-hd .nm")?.textContent);
    expect(glowing).toEqual(["In progress", "Action required", "Merge"]);
  });

  it("hands each zone its own hue through one custom property", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    expect(column("Merge").style.getPropertyValue("--zone")).toBe("var(--c-done)");
    expect(column("In review").style.getPropertyValue("--zone")).toBe("var(--c-review)");
  });

  it("puts the count after the rule, so every column's count aligns right", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    expect([...column("In progress").querySelectorAll(".col-hd > *")].map((n) => n.className))
      .toEqual(["dot glow", "nm", "rule", "ct"]);
  });

  /** Every lane header and card key in the column, in render order — the one
   * assertion that catches a lane header sitting above the wrong cards. */
  const flow = (label: string) =>
    [...column(label).querySelectorAll(".lane-hd .nm, .card .key")].map((n) => n.textContent);

  const lanes = (label: string) =>
    [...column(label).querySelectorAll(".lane-hd")].map((h) => [
      h.querySelector(".nm")?.textContent,
      h.querySelector(".ct")?.textContent,
    ]);

  it("splits the merge column into the press and its aftermath, press first", () => {
    render(<DeckApp />);
    host(runsMsg([inReview("ASM-9", { state: "MERGED" }), inReview("ASM-1", { review: "approved" })]));
    expect(lanes("Merge")).toEqual([["ready to merge", "1"], ["merged · wrap up", "1"]]);
    expect(flow("Merge")).toEqual(["ready to merge", "ASM-1", "merged · wrap up", "ASM-9"]);
  });

  it("still names the lane when every card in the column is on one side", () => {
    render(<DeckApp />);
    host(runsMsg([inReview("ASM-9", { state: "MERGED" })]));
    expect(lanes("Merge")).toEqual([["merged · wrap up", "1"]]);
  });

  it("keeps the column header counting both lanes", () => {
    render(<DeckApp />);
    host(runsMsg([inReview("ASM-9", { state: "MERGED" }), inReview("ASM-1", { review: "approved" })]));
    expect(column("Merge").querySelector(".col-hd .ct")?.textContent).toBe("2");
  });

  /** A parked run in the In-progress column: no agents, and a run-level read
   * that says nobody is home. */
  const quiet = (key: string): RunStatus => mkStatus({
    run: { ...mkStatus().run, key },
    column: "progress", agents: [], agent: { state: "unknown", lastActivityMs: null, slug: null },
  });

  it("splits In progress into the live agents and the parked ones, live first", () => {
    render(<DeckApp />);
    host(runsMsg([quiet("ASM-2"), mkStatus()]));
    expect(lanes("In progress")).toEqual([["working", "1"], ["parked", "1"]]);
    expect(flow("In progress")).toEqual(["working", "ASM-1", "parked", "ASM-2"]);
  });

  it("splits In review into the PRs that want you and the ones that want somebody else", () => {
    render(<DeckApp />);
    host(runsMsg([inReview("ASM-2", { review: "none" }), inReview("ASM-3", { mergeable: "conflicting" })]));
    expect(lanes("In review")).toEqual([["fixes needed", "1"], ["waiting on review", "1"]]);
    expect(flow("In review")).toEqual(["fixes needed", "ASM-3", "waiting on review", "ASM-2"]);
  });

  it("leaves Action required without sub-headers — it is the one column that means one thing", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({
      column: "needs", agents: [], agent: { state: "needs-you", lastActivityMs: 1_000, slug: null },
    })]));
    expect(lanes("Action required")).toEqual([]);
  });

  it("keeps the In-progress header counting both of its lanes", () => {
    render(<DeckApp />);
    host(runsMsg([quiet("ASM-2"), mkStatus()]));
    expect(column("In progress").querySelector(".col-hd .ct")?.textContent).toBe("2");
  });
});

describe("card selection", () => {
  const card = () => document.querySelector(".card") as HTMLElement;

  it("mounts no drawer until a card is selected", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    expect(document.querySelector(".dd")).toBeNull();
  });

  it("selects on click and opens the drawer for that card", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    fireEvent.click(card());
    expect(document.querySelector(".dd")).not.toBeNull();
    expect(document.querySelector(".dd-hd .k")!.textContent).toBe("ASM-1");
    expect(card().className).toContain("sel");
  });

  it("does not select when a card action is clicked", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    fireEvent.click(within(card()).getByRole("button", { name: /^open$/i }));
    expect(document.querySelector(".dd")).toBeNull();
  });

  it("clicking the selected card again clears it", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    fireEvent.click(card());
    fireEvent.click(card());
    // Dismissed, so it is sliding out rather than gone — see the note on
    // "closes a selected card's detail when a flow it has not seen before
    // arrives". The unmount at the end of that slide has its own tests in
    // "the card detail's open and close animation" below.
    expect(document.querySelector(".dd.closing")).not.toBeNull();
  });

  it("re-targets the drawer when a second card is selected", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus(), mkStatus({ run: { ...mkStatus().run, key: "ASM-2" } })]));
    const cards = document.querySelectorAll(".card");
    fireEvent.click(cards[0]);
    fireEvent.click(cards[1]);
    expect(document.querySelectorAll(".dd")).toHaveLength(1);
    expect(document.querySelector(".dd-hd .k")!.textContent).toBe("ASM-2");
  });

  it("clears the selection on Escape", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    fireEvent.click(card());
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(document.querySelector(".dd.closing")).not.toBeNull();
  });

  it("drops a selection whose card is gone from the next post", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    fireEvent.click(card());
    expect(document.querySelector(".dd")).not.toBeNull();
    host(runsMsg([mkStatus({ run: { ...mkStatus().run, key: "ASM-9" } })]));
    expect(document.querySelector(".dd")).toBeNull();
    // The `selId` state itself must clear, not just this render's recomputed
    // `selected` — otherwise a stale selId that outlived the card's absence
    // would silently reopen the drawer the moment a card with that same id
    // (e.g. the same run, ASM-1) reappears in a later post, with no click.
    host(runsMsg([mkStatus()]));
    expect(document.querySelector(".dd")).toBeNull();
  });

  it("gives the board scroll run-out so a covered column stays reachable", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    expect(document.querySelector(".board")!.className).not.toContain("dd-open");
    fireEvent.click(card());
    expect(document.querySelector(".board")!.className).toContain("dd-open");
  });

  it("closes the Orchestrator drawer when a card is selected", () => {
    render(<DeckApp />);
    host({ type: "deck:flows", flows: [{ id: "f1", name: "F", nodes: [], edges: [], armed: false } as never],
      enabled: true, pendingResume: [], promptModes: [], commands: [], branchCi: {} } as OutboundMessage);
    host(runsMsg([mkStatus()]));
    fireEvent.click(screen.getByRole("button", { name: /orchestrator/i }));
    expect(document.querySelector(".orch")).not.toBeNull();
    fireEvent.click(document.querySelector(".card") as HTMLElement);
    expect(document.querySelector(".dd")).not.toBeNull();
    // The two drawers share the slot: selecting a card must set `openFlowId`
    // to null so the Orchestrator drawer starts its slide-out — it stays
    // mounted (as `.orch.closing`) for its exit animation rather than
    // vanishing in the same frame, so `.closing` rather than absence is the
    // proof `onSelect` actually closed it. Selecting a card always opens
    // `.dd` regardless of `openFlowId` (they are independent state), so the
    // `.dd` assertion above alone cannot tell "closed" from "never closed."
    expect(document.querySelector(".orch.closing")).not.toBeNull();
  });

  // The reverse direction of the test above: the spec asks for mutual exclusion
  // both ways, and only "selecting a card closes the Orchestrator" had a test.
  it("closes the card detail drawer when the Orchestrator chip is clicked", () => {
    render(<DeckApp />);
    host({ type: "deck:flows", flows: [{ id: "f1", name: "F", nodes: [], edges: [], armed: false } as never],
      enabled: true, pendingResume: [], promptModes: [], commands: [], branchCi: {} } as OutboundMessage);
    host(runsMsg([mkStatus()]));
    fireEvent.click(document.querySelector(".card") as HTMLElement);
    expect(document.querySelector(".dd")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /orchestrator/i }));
    expect(document.querySelector(".dd.closing")).not.toBeNull();
  });

  // "does not select when a PR link is clicked" is deleted here, not re-pointed:
  // the PR block no longer renders on an unselected card at all (it only exists
  // inside `.dd`, which is itself proof the card is already selected), so there
  // is no longer a scenario where a PR link is clickable before selection. The
  // card's own click-guard on `.c-foot2` is exercised instead by "does not
  // select when a card action is clicked" above.
});

describe("the card at rest", () => {
  it("renders the signal line and no PR block, repo chips or branch row", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({
      prs: { svc: { facts: {
        number: 5, url: "u", title: "t", state: "OPEN", isDraft: false,
        ci: { passing: 1, pending: 0, failing: [] }, review: "approved",
        unresolved: 0, mergeable: "clean", ciAdvisory: false,
      }, fetchedAt: 1 } } as never,
    })]));
    const card = document.querySelector(".card")!;
    expect(card.querySelector(".c-sig")).not.toBeNull();
    expect(card.querySelector(".pr-block")).toBeNull();
    expect(card.querySelector(".c-repos")).toBeNull();
    expect(card.querySelector(".c-branch")).toBeNull();
    expect(card.querySelector(".c-agents")).toBeNull();
    expect(card.querySelector(".pill")).toBeNull();
  });

  it("names the repos behind the \"N repos\" bit in its tooltip, one per line", () => {
    // The card has no room to list them and must not grow to: the count says how
    // many, the tooltip says which. Newline-separated, which a native title honors.
    render(<DeckApp />);
    host(runsMsg([wsStatus()]));
    const bits = Array.from(document.querySelectorAll(".card .c-sig span"));
    const count = bits.find((b) => b.textContent === "2 repos")!;
    expect(count.getAttribute("title")).toBe("centaur\nautomation_e2e");
  });

  it("shows Open and Diff in the footer, and no overflow menu", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    const labels = Array.from(document.querySelectorAll(".card .c-foot2 .act")).map((b) => b.textContent);
    expect(labels).toEqual(["Open", "Diff"]);
    expect(document.querySelector(".card .more")).toBeNull();
  });

  // Converted from a lane-gated "Address PR" assertion (see the git history
  // at commit daff687): review_required with clean CI and clean mergeability
  // is a PR still waiting on a human, but nothing about it is actually WRONG,
  // so cardActions() gives it no row — the signal line stays instead, which
  // is what "the card at rest" describes.
  it("shows no action row and keeps the signal line for a waiting PR with nothing wrong", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({
      column: "review",
      prs: { svc: { facts: {
        number: 5, url: "u", title: "t", state: "OPEN", isDraft: false,
        ci: { passing: 1, pending: 0, failing: [] }, review: "review_required",
        unresolved: 0, mergeable: "clean", ciAdvisory: false,
      }, fetchedAt: 1 } } as never,
    })]));
    const card = document.querySelector(".card")!;
    expect(card.querySelector(".c-rows")).toBeNull();
    expect(card.querySelector(".c-sig")).not.toBeNull();
    const footerLabels = Array.from(card.querySelectorAll(".c-foot2 .act")).map((b) => b.textContent);
    expect(footerLabels).toEqual(["Open", "Diff"]);
  });

  it("shows no action row on the review column's ready lane", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({
      column: "review",
      prs: { svc: { facts: {
        number: 5, url: "u", title: "t", state: "OPEN", isDraft: false,
        ci: { passing: 1, pending: 0, failing: [] }, review: "approved",
        unresolved: 0, mergeable: "clean", ciAdvisory: false,
      }, fetchedAt: 1 } } as never,
    })]));
    expect(document.querySelector(".card .c-rows")).toBeNull();
  });

  // Strengthened per the same reasoning as the local-card test above: a PR
  // with every kind of problem at once (failing CI, changes requested, a
  // conflict) still produces nothing on a local card. The `local` guard must
  // hold against real pressure — a local card's ticket is only inferred from
  // its branch name, which may belong to somebody else's ticket.
  it("keeps every action row off a local card even when its PR is failing outright", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({
      column: "review", run: { ...mkStatus().run, key: "local-a", url: "", kind: "local" } as never,
      prs: { svc: { facts: failingPr(), fetchedAt: 1 } },
    })]));
    expect(document.querySelector(".card .c-rows")).toBeNull();
  });

  it("renders a diff bit as two distinct elements, each with a color rule of its own in the stylesheet", () => {
    // jsdom has no CSS cascade, so a resolved computed color can't be asserted
    // here — that's exactly why a prior version of this test (asserting only
    // textContent) passed against a real gray-on-gray bug: .c-diff had no color
    // rules at all, and every bit inherited .c-sig's dim gray. The structural
    // half (two distinct elements, one carrying .add and one .del) is what the
    // CSS rules below actually key off; the stylesheet half is the only way this
    // suite can catch either rule going missing.
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    const sig = document.querySelector(".card .c-sig")!;
    const add = sig.querySelector(".add")!;
    const del = sig.querySelector(".del")!;
    expect(add).not.toBe(del);
    expect(add.textContent).toBe("+12");
    expect(del.textContent).toBe("−2");
    // The counts are no longer hued — green on this board means a live agent or a
    // mergeable branch, not "lines added" — so the assertion moved off the specific
    // hue tokens and onto what the gray-on-gray bug actually was. Each rule must
    // exist, and each must resolve somewhere near the foreground rather than to the
    // dim gray .c-sig passes down. This is strictly stronger than pinning the old
    // hues: it still catches a missing rule, and it now also catches a rule that is
    // present but faint, which a hue-pinned regex would have let through.
    const addRule = /\.c-diff\s+\.add\s*\{\s*color:\s*([^;]+);/.exec(DECK_CSS);
    const delRule = /\.c-diff\s+\.del\s*\{\s*color:\s*([^;]+);/.exec(DECK_CSS);
    expect(addRule).not.toBeNull();
    expect(delRule).not.toBeNull();
    for (const rule of [addRule![1], delRule![1]]) {
      expect(rule).not.toBe("var(--dim)");
      expect(rule).not.toBe("var(--vscode-descriptionForeground)");
      expect(rule).toContain("var(--vscode-foreground)");
    }
  });
});

describe("DeckApp card anatomy", () => {
  beforeEach(() => sent.mockClear());

  it("shows a named button for each PR failure", () => {
    render(<DeckApp />);
    host(runsMsg([withPr(failingPr(), { column: "needs" })]));
    expect(screen.getByRole("button", { name: "Fix CI" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resolve conflict" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Address review" })).toBeTruthy();
    // The rows REPLACE the signal line rather than joining it — a card showing
    // both would restate the very facts the rows already name.
    expect(document.querySelector(".card .c-sig")).toBeNull();
  });

  it("no longer offers a generic Address PR", () => {
    render(<DeckApp />);
    host(runsMsg([withPr(failingPr(), { column: "review" })]));
    expect(screen.queryByRole("button", { name: "Address PR" })).toBeNull();
  });

  it("sends deck:seedPrWork with the reason for the button pressed", () => {
    render(<DeckApp />);
    host(runsMsg([withPr(failingPr(), { column: "needs" })]));
    fireEvent.click(screen.getByRole("button", { name: "Resolve conflict" }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:seedPrWork", key: "ASM-1", reason: "conflict" });
  });

  it("carries the failing check names as the ci action's detail", () => {
    render(<DeckApp />);
    host(runsMsg([withPr(failingPr(), { column: "needs" })]));
    fireEvent.click(screen.getByRole("button", { name: "Fix CI" }));
    expect(sent).toHaveBeenCalledWith({
      type: "deck:seedPrWork", key: "ASM-1", reason: "ci", detail: "integration, lint",
    });
  });

  it("keeps the ordinary signal line on a healthy card", () => {
    render(<DeckApp />);
    host(runsMsg([withPr(healthyPr())]));
    expect(screen.getByText(/✓ ci/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Fix CI" })).toBeNull();
  });

  // Spend was removed from the card by request: it lives only in the detail
  // drawer now (see test/webview/DeckDetail.test.tsx's "DeckDetail — Spend"
  // block, which carries over the eq-label and unread-vs-zero invariants these
  // card tests used to protect). The card must show no figure for ANY usage
  // value — including a large one, which is the case that would regress if the
  // footer span were ever reinstated.
  it("never shows a spend figure on the card, whatever the usage", () => {
    render(<DeckApp />);
    host(runsMsg([withPr(healthyPr(), { usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 3_804_000 } })]));
    expect(screen.getByText(/✓ ci/)).toBeTruthy(); // the card did render
    expect(document.querySelector(".c-foot2 .spend")).toBeNull();
    expect(screen.queryByText("380k")).toBeNull();
    expect(screen.queryByText(/\beq\b/)).toBeNull();
  });

  it("totals the board's spend in the header", () => {
    render(<DeckApp />);
    const a = withPr(healthyPr(), { usage: { input: 0, output: 20_000, cacheWrite: 0, cacheRead: 0 } });
    const b = withPr(healthyPr(), {
      run: { ...mkStatus().run, key: "ASM-2" },
      usage: { input: 0, output: 20_000, cacheWrite: 0, cacheRead: 0 },
    });
    // 4th arg turns the setting on: the tile is opt-in and absent by default, so
    // every other test on this board renders without it.
    host(runsMsg([a, b], "PR initiated", "Jira", true));
    // 2 × (20,000 × 5) = 200,000 → "200k"
    expect(screen.getByText("200k")).toBeTruthy();
  });

  // I2: the header total used to reduce over every run the host ever posted
  // (live and closed alike), while every sibling tile in the same header —
  // "In progress", "Action required", "In review" — reduces over the live
  // cards only. A closed run's card leaves the board, but its tokens used to
  // linger in "Tokens on board" forever.
  // The setting is off by default, so the tile must be absent on a board whose
  // runs carry real usage — otherwise "off by default" is only true of the
  // package.json default and not of the code.
  it("hides the header total when the setting is off", () => {
    render(<DeckApp />);
    host(runsMsg([withPr(healthyPr(), { usage: { input: 0, output: 20_000, cacheWrite: 0, cacheRead: 0 } })]));
    expect(screen.queryByText("Tokens on board")).toBeNull();
    expect(screen.queryByText("100k")).toBeNull();
  });

  it("shows the header total once the setting is on", () => {
    render(<DeckApp />);
    host(runsMsg([withPr(healthyPr(), { usage: { input: 0, output: 20_000, cacheWrite: 0, cacheRead: 0 } })], "PR initiated", "Jira", true));
    expect(screen.getByText("Tokens on board")).toBeTruthy();
  });

  // With the board sweep off by default, opening a drawer is the ONLY thing that
  // makes the host read transcripts. If this request stopped being sent, the
  // drawer would sit on "Reading transcripts…" forever and nothing else would fail.
  it("asks the host for the selected run's usage when its drawer opens, and not before", () => {
    render(<DeckApp />);
    host(runsMsg([withPr(healthyPr())]));
    expect(sent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "deck:usageFor" }));
    fireEvent.click(document.querySelector(".card") as HTMLElement);
    expect(sent).toHaveBeenCalledWith({ type: "deck:usageFor", key: "ASM-1" });
  });

  it("feeds a deck:usage reply into the open drawer", () => {
    render(<DeckApp />);
    host(runsMsg([withPr(healthyPr())]));
    fireEvent.click(document.querySelector(".card") as HTMLElement);
    expect(screen.getByText(/Reading transcripts/)).toBeTruthy();
    host({ type: "deck:usage", key: "ASM-1", usage: { input: 0, output: 20_000, cacheWrite: 0, cacheRead: 0 } });
    expect(document.querySelector(".dd-spend")).not.toBeNull();
    expect(screen.queryByText(/Reading transcripts/)).toBeNull();
  });

  // A reply can land after the user has moved on. Keying by run rather than
  // holding one "current" slot is what stops the new drawer showing the old
  // run's figure.
  it("ignores a deck:usage reply for a run other than the open one", () => {
    render(<DeckApp />);
    host(runsMsg([withPr(healthyPr())]));
    fireEvent.click(document.querySelector(".card") as HTMLElement);
    host({ type: "deck:usage", key: "SOMEONE-ELSE", usage: { input: 0, output: 99_000, cacheWrite: 0, cacheRead: 0 } });
    expect(screen.getByText(/Reading transcripts/)).toBeTruthy();
    expect(document.querySelector(".dd-spend")).toBeNull();
  });

  it("excludes a closed run's tokens from the header total", () => {
    render(<DeckApp />);
    const a = withPr(healthyPr(), { usage: { input: 0, output: 20_000, cacheWrite: 0, cacheRead: 0 } });
    const b = withPr(healthyPr(), {
      run: { ...mkStatus().run, key: "ASM-2" },
      shelf: "closed",
      usage: { input: 0, output: 20_000, cacheWrite: 0, cacheRead: 0 },
    });
    host(runsMsg([a, b], "PR initiated", "Jira", true));
    // Only `a`'s spend counts: 20,000 × 5 = 100,000 → "100k". The card no longer
    // prints a figure of its own, so the header is the only place it can appear;
    // if the closed run's tokens were still folded in it would read "200k".
    const hd = document.querySelector(".hd") as HTMLElement;
    expect(within(hd).getByText("100k")).toBeTruthy();
    expect(within(hd).queryByText("200k")).toBeNull();
  });

  // I4: the header figure is effort-weighted, so it must carry the `eq` unit and
  // the formula tooltip — "Tokens on board" with no qualifier understates real
  // tokens by ~6.6x and reads as a raw count. (This originally said "same as the
  // card"; the card's own figure has since been removed, so the header and the
  // drawer's weighted row are now the only two places the unit appears.)
  it("carries the eq unit and formula tooltip on the header total", () => {
    render(<DeckApp />);
    host(runsMsg([withPr(healthyPr(), { usage: { input: 0, output: 20_000, cacheWrite: 0, cacheRead: 0 } })], "PR initiated", "Jira", true));
    const stat = screen.getByText("Tokens on board").closest(".stat") as HTMLElement;
    expect(within(stat).getByText("eq")).toBeTruthy();
    expect(stat.title).toMatch(/input×1.*cache-write×1\.25.*cache-read×0\.1.*output×5/);
  });

  describe("card avatar and state row", () => {
    /** The board with exactly one run, and that run's card. */
    const oneCard = (over: Partial<RunStatus> = {}): HTMLElement => {
      const { container } = render(<DeckApp />);
      host(runsMsg([mkStatus(over)]));
      return container.querySelector(".card") as HTMLElement;
    };

    it("leads the card with its kind, and keeps the ticket key whole beside the title", () => {
      const card = oneCard();
      const hd = card.querySelector(".c-hd")!;
      // The avatar is the header's FIRST child: the whole point is that every card
      // starts at the same x with the same kind of mark.
      expect(hd.firstElementChild!.className).toBe("av k-task");
      expect(hd.querySelector(".hd-t .c-title")!.textContent).toContain("Export fails on large accounts");
      // Its own slot, not sharing a row with the branch and the diff: a truncated
      // ticket key is the one identifier on this card nobody can reconstruct.
      expect(hd.querySelector(".hd-k .key")!.textContent).toBe("ASM-1");
    });

    it("gives a notepad card the notepad mark, not the ticket one", () => {
      const card = oneCard({ run: { ...mkStatus().run, kind: "notepad" } });
      expect(card.querySelector(".c-hd .av")!.className).toBe("av k-notepad");
    });

    it("gives an explore card the explore mark", () => {
      const card = oneCard({ run: { ...mkStatus().run, kind: "explore" } });
      expect(card.querySelector(".c-hd .av")!.className).toBe("av k-explore");
    });

    it("selects the card when the title is clicked, as it did before the header existed", () => {
      const card = oneCard();
      fireEvent.click(card.querySelector(".c-hd .c-title")!);
      // The header must NOT stop propagation as a whole — only its key slot does.
      // Clicking the summary has always selected the card.
      expect(card.className).toContain("sel");
    });

    it("does not select the card when its key is clicked", () => {
      const card = oneCard();
      fireEvent.click(card.querySelector(".hd-k .key")!);
      expect(card.className).not.toContain("sel");
      expect(sent).toHaveBeenCalledWith({ type: "openExternal", url: "https://jira/ASM-1" });
    });

    it("puts the state on its own row under a hairline, with the age in mono", () => {
      const card = oneCard({
        run: { ...mkStatus().run, createdAt: Date.now() - 2 * 3_600_000 },
        usage: { input: 2_000, output: 40_000, cacheWrite: 100_000, cacheRead: 4_000_000 },
      });
      // One hairline, and only one: a second rule would stop it meaning anything.
      expect(card.querySelectorAll(".c-hr").length).toBe(1);
      const st = card.querySelector(".c-st")!;
      expect(st.querySelector(".sdot")!.className).toContain("tone-working");
      expect(st.querySelector(".status")!.textContent).toContain("working");
      const meta = st.querySelector(".c-meta")!;
      // The age, and only the age — even for a run whose usage the host HAS read.
      // a66c543 took spend off the card on purpose; the drawer owns it.
      expect(meta.textContent).toBe("2h ago");
      expect(meta.querySelector(".age")!.textContent).toBe("2h ago");
      // The age carries its own title in words: the state text beside it also ends
      // in a duration (the last activity), and the two are different clocks.
      expect(meta.querySelector(".age")!.getAttribute("title")).toBe("launched 2h ago");
    });

    it("keeps the new state row clear of any spend figure, measured or not", () => {
      // Both directions of the invariant a66c543 established: an unread run and a
      // read one look the same on the card, because the card never carries spend.
      for (const over of [{}, { usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } }]) {
        const card = oneCard(over);
        expect(card.querySelector(".c-meta")!.textContent).not.toContain("eq");
        expect(card.querySelector(".c-meta .age")).not.toBeNull();
      }
    });
  });
});

// The card detail slides in and out along the right edge it is anchored to, the
// same way the Orchestrator drawer does and through the same code — see the
// mirror of this describe in OrchestratorDrawer.test.tsx. The exit is the half
// that needs more than a stylesheet: dismissing drops `selId`, which would
// unmount the aside in the same frame and leave nothing to animate, so the
// drawer holds the card it last had for exactly DRAWER_ANIM_MS.
describe("the card detail's open and close animation", () => {
  const dd = () => document.querySelector(".dd") as HTMLElement | null;
  const openOne = () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    fireEvent.click(document.querySelector(".card") as HTMLElement);
  };

  it("arrives with the shared drawer shell, not the closing state", () => {
    openOne();
    // `.drawer` is the assertion that matters: the shell is one rule and one
    // element for both drawers, so a detail drawer that grew its own geometry
    // again would fail here rather than merely look slightly different.
    expect(dd()!.className).toContain("drawer");
    expect(dd()!.className).not.toContain("closing");
  });

  it("keeps painting the card while it slides out, then drops it", () => {
    vi.useFakeTimers();
    try {
      openOne();
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      // Still in the DOM, or there would be nothing for the CSS to animate, and
      // still drawing the card it held — this is the drawer the user just
      // dismissed, not a blank shell.
      expect(dd()!.className).toContain("closing");
      expect(dd()!.querySelector(".dd-hd .k")!.textContent).toBe("ASM-1");

      // Just short of the animation's end it is still there; one tick past it,
      // gone. Both halves are asserted so a timer that never fires and a timer
      // that fires instantly are each caught.
      act(() => { vi.advanceTimersByTime(DRAWER_ANIM_MS - 1); });
      expect(dd()).not.toBeNull();
      act(() => { vi.advanceTimersByTime(1); });
      expect(dd()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is hidden from the accessibility tree while closing", () => {
    vi.useFakeTimers();
    try {
      openOne();
      const named = { name: "Detail for ASM-1" };
      expect(screen.queryByRole("complementary", named)).not.toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      // Inert for those milliseconds: a drawer already dismissed must not answer
      // a role query, a screen reader, or a Tab. `queryByRole` honours
      // aria-hidden, which is what keeps every "the drawer is closed" assertion
      // in this file that reads through a role query true across this change.
      expect(dd()).not.toBeNull();
      expect(dd()!.getAttribute("aria-hidden")).toBe("true");
      expect(screen.queryByRole("complementary", named)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // While OPEN the attribute must be absent, not "false": this element is the
  // drawer's own landmark, and `aria-hidden="false"` is not the same as absent
  // to every screen reader.
  it("carries no aria-hidden at all while open", () => {
    openOne();
    expect(dd()!.hasAttribute("aria-hidden")).toBe(false);
  });

  // The counterpart of "drops a selection whose card is gone from the next post"
  // above, stated as the animation rule it is: a card that disappears from under
  // an open drawer is not a dismissal, so there is nothing to slide out and no
  // card left to draw. The drawer must not come back for the length of a slide
  // it never earned, which is what advancing past one asserts.
  it("vanishes at once when the open card leaves the board", () => {
    vi.useFakeTimers();
    try {
      openOne();
      host(runsMsg([mkStatus({ run: { ...mkStatus().run, key: "ASM-9" } })]));
      expect(dd()).toBeNull();
      act(() => { vi.advanceTimersByTime(DRAWER_ANIM_MS * 2); });
      expect(dd()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

/** The card the Merge button exists for: approved, green, threads readable and clear. */
const mergeablePr = (): PrFacts => ({
  number: 2044, url: "https://gh/pr/2044", title: "t", state: "OPEN", isDraft: false,
  ci: { passing: 8, pending: 0, failing: [] },
  review: "approved", unresolved: 0, mergeable: "clean", ciAdvisory: false,
});

describe("the card's Merge row", () => {
  it("is absent when mergeWrites is off, even on a fully green card", () => {
    render(<DeckApp />);
    host(runsMsg([withPr(mergeablePr())]));
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
  });

  it("renders on a green card once mergeWrites is on", async () => {
    render(<DeckApp />);
    host({ ...runsMsg([withPr(mergeablePr())]), mergeWrites: true });
    // waitFor, never a bare tick: an async read from an earlier test can land its
    // postMessage in this one.
    await waitFor(() => expect(screen.getByRole("button", { name: "Merge" })).toBeTruthy());
  });

  it("is absent when the thread count is unreadable — healthyPr's own case", () => {
    render(<DeckApp />);
    host({ ...runsMsg([withPr(healthyPr())]), mergeWrites: true });
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
  });

  it("is absent on a card with a problem row, which wins", () => {
    render(<DeckApp />);
    host({ ...runsMsg([withPr(failingPr())]), mergeWrites: true });
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
    expect(screen.getByRole("button", { name: "Fix CI" })).toBeTruthy();
  });

  it("sends deck:mergePr with the run key, repo and number", async () => {
    render(<DeckApp />);
    host({ ...runsMsg([withPr(mergeablePr())]), mergeWrites: true });
    const btn = await waitFor(() => screen.getByRole("button", { name: "Merge" }));
    fireEvent.click(btn);
    expect(sent).toHaveBeenCalledWith({ type: "deck:mergePr", key: "ASM-1", repo: "svc", number: 2044 });
  });

  it("disables the button until deck:mergeDone comes back", async () => {
    render(<DeckApp />);
    host({ ...runsMsg([withPr(mergeablePr())]), mergeWrites: true });
    const btn = await waitFor(() => screen.getByRole("button", { name: "Merge" }));
    fireEvent.click(btn);
    await waitFor(() => expect((screen.getByRole("button", { name: "Merge" }) as HTMLButtonElement).disabled).toBe(true));
    host({ type: "deck:mergeDone", key: "ASM-1", repo: "svc", number: 2044, outcome: "cancelled" });
    await waitFor(() => expect((screen.getByRole("button", { name: "Merge" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("is absent on a local card even with mergeWrites on", async () => {
    // The `local ||` short-circuit is otherwise only ever exercised with the
    // setting OFF, where `!mergeWrites` alone would withhold the row — so the
    // guard could be deleted and the suite would stay green. A local card's
    // ticket is inferred from a branch name that may belong to somebody else's
    // ticket, and merging off that inference on one click is what must never
    // ship. Same shape, and same reasoning, as the action-row local tests.
    render(<DeckApp />);
    host({
      ...runsMsg([mkStatus({
        run: { ...mkStatus().run, key: "local-a", url: "", kind: "local" } as never,
        prs: { svc: { facts: mergeablePr(), fetchedAt: 1 } },
      })]),
      mergeWrites: true,
    });
    // waitFor over a bare tick, then assert the absence: an async read from an
    // earlier test can land its postMessage in this one, and a queryBy that ran
    // before this test's own message rendered would pass for the wrong reason.
    await waitFor(() => expect(screen.getByText("local")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
    expect(document.querySelector(".card .c-rows")).toBeNull();
  });

  it("keeps the button disabled after a successful merge, and drops the row once the facts catch up", async () => {
    // The re-arm window. `deck:mergeDone` releases on "failed" and "cancelled" but
    // NOT on "ok", because `r.prs` still holds the pre-merge OPEN facts for up to a
    // poll window after the merge landed — so a symmetric release would put a live
    // Merge button back on an already-merged PR, and a second click would reach the
    // forge. The host stales the entry on success; when the refetched facts say
    // MERGED the row goes away on its own.
    render(<DeckApp />);
    host({ ...runsMsg([withPr(mergeablePr())]), mergeWrites: true });
    const btn = await waitFor(() => screen.getByRole("button", { name: "Merge" }));
    fireEvent.click(btn);
    host({ type: "deck:mergeDone", key: "ASM-1", repo: "svc", number: 2044, outcome: "ok" });
    await waitFor(() => expect((screen.getByRole("button", { name: "Merge" }) as HTMLButtonElement).disabled).toBe(true));
    // Still disabled after a fresh board post that carries the STALE open facts —
    // the exact poll that used to re-arm it.
    host({ ...runsMsg([withPr(mergeablePr())]), mergeWrites: true });
    await waitFor(() => expect((screen.getByRole("button", { name: "Merge" }) as HTMLButtonElement).disabled).toBe(true));
    // And gone once the refetch lands the truth.
    host({ ...runsMsg([withPr({ ...mergeablePr(), state: "MERGED" })]), mergeWrites: true });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Merge" })).toBeNull());
  });

  it("re-enables the button after a failed merge — the PR is still open", async () => {
    // The other half of the asymmetry: "failed" means nothing landed, so the row
    // must come back for a second try.
    render(<DeckApp />);
    host({ ...runsMsg([withPr(mergeablePr())]), mergeWrites: true });
    const btn = await waitFor(() => screen.getByRole("button", { name: "Merge" }));
    fireEvent.click(btn);
    await waitFor(() => expect((screen.getByRole("button", { name: "Merge" }) as HTMLButtonElement).disabled).toBe(true));
    host({ type: "deck:mergeDone", key: "ASM-1", repo: "svc", number: 2044, outcome: "failed" });
    await waitFor(() => expect((screen.getByRole("button", { name: "Merge" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("clicking Merge does not select the card", async () => {
    // The problem rows already stopPropagation for this reason and the merge row
    // shares their container; this pins that it kept the behaviour. Asserting on
    // the `sel` class rather than on a message the click might not emit at all —
    // an assertion about an absent message would pass either way.
    render(<DeckApp />);
    host({ ...runsMsg([withPr(mergeablePr())]), mergeWrites: true });
    const btn = await waitFor(() => screen.getByRole("button", { name: "Merge" }));
    const card = btn.closest(".card")!;
    expect(card.className).not.toContain("sel");
    fireEvent.click(btn);
    expect(card.className).not.toContain("sel");
  });
});

describe("the forge account in the legend", () => {
  const slot = { cli: "gh", login: "oznasi1", canSwitch: true };

  it("names the CLI and the account it is reading as", () => {
    render(<DeckApp />);
    host({ ...runsMsg([mkStatus()]), ghAccount: slot });
    expect(screen.getByText("oznasi1")).toBeTruthy();
    expect(screen.getByText(/gh as/)).toBeTruthy();
  });

  it("asks the host to switch when the link is pressed", () => {
    render(<DeckApp />);
    host({ ...runsMsg([mkStatus()]), ghAccount: slot });
    fireEvent.click(screen.getByRole("button", { name: "switch" }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:switchAccount" });
  });

  it("shows no switch link when there is nothing to switch to", () => {
    render(<DeckApp />);
    host({ ...runsMsg([mkStatus()]), ghAccount: { ...slot, canSwitch: false } });
    expect(screen.getByText("oznasi1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "switch" })).toBeNull();
  });

  // One slot, and the warning owns it: "gh is not signed in" and "gh as X" are
  // mutually exclusive by construction, but the webview must not render both
  // even if a future host sends both.
  it("yields the slot to the forge warning", () => {
    render(<DeckApp />);
    host({ ...runsMsg([mkStatus()]), ghNote: "gh is not signed in — PR facts off. Run Doctor", ghAccount: slot });
    expect(screen.getByText(/not signed in/)).toBeTruthy();
    expect(screen.queryByText("oznasi1")).toBeNull();
  });

  // The field is optional on the wire, so a host that never sends it — an older
  // build, mid-reload — must render exactly today's legend.
  it("renders nothing when the host says nothing", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    expect(screen.queryByRole("button", { name: "switch" })).toBeNull();
    expect(screen.queryByText(/ as /)).toBeNull();
  });

  it("clears the account when a later post drops it", () => {
    render(<DeckApp />);
    host({ ...runsMsg([mkStatus()]), ghAccount: slot });
    expect(screen.getByText("oznasi1")).toBeTruthy();
    host({ ...runsMsg([mkStatus()]), ghAccount: null });
    expect(screen.queryByText("oznasi1")).toBeNull();
  });
});
