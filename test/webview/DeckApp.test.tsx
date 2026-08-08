// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as React from "react";
import { render, screen, fireEvent, act, within } from "@testing-library/react";

vi.mock("../../src/webview/vscodeApi", () => ({ send: vi.fn() }));

import { DeckApp } from "../../src/webview/DeckApp";
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
  ...over,
});

const runsMsg = (runs: RunStatus[], prReviewStatus = "PR initiated",
                 grouping: "agents" | "workspaces" = "agents", sourceLabel = "Jira"): OutboundMessage =>
  ({ type: "deck:runs", runs, liveSignal: true, prFacts: true, openAgents: true, reviewQueue: true, ghNote: null, prReviewStatus, grouping, staleCount: 0, sourceLabel });

const mkAgent = (name: string, state: AgentActivity["state"], lastActivityMs: number): CardAgent => ({
  session: { pid: 1, sessionId: name, cwd: "/r/svc", startedAt: Date.now() - 3_600_000, name },
  activity: { state, lastActivityMs, slug: null },
});

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
    host(runsMsg([mkStatus({ ticketStatus: null })]));
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
    fireEvent.click(screen.getByRole("button", { name: "⋯" }));
    expect(screen.getByRole("button", { name: "Track it" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Forget" })).toBeNull();
  });

  it("posts deck:track", () => {
    render(<DeckApp />);
    host(runsMsg([mkLocal()]));
    fireEvent.click(screen.getByRole("button", { name: "⋯" }));
    fireEvent.click(screen.getByRole("button", { name: "Track it" }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:track", key: "local-centaur-1a2b3c4d" });
  });

  it("still offers Forget on a tracked card", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    fireEvent.click(screen.getByRole("button", { name: "⋯" }));
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

  it("keeps the merge row while the PR is open", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ prs: { svc: { facts: prFacts({ mergeable: "behind" }), fetchedAt: 1 } } })]));
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
    expect(screen.queryByText("merge", { selector: ".pr-lbl" })).toBeNull();
    expect(screen.queryByText("unknown")).toBeNull();
    expect(screen.getByText("#4821")).toBeTruthy();
    expect(screen.getByText(/6 passing/)).toBeTruthy();
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

  it("posts deck:setOpenAgents when the toggle is clicked", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    fireEvent.click(screen.getByRole("button", { name: /open agents/i }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:setOpenAgents", on: false });
  });

  it("posts deck:setReviewQueue when the toggle is clicked", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    fireEvent.click(screen.getByRole("button", { name: /review queue/i }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:setReviewQueue", on: false });
  });

  // The host owns this flag — it is seeded from the setting, so a panel opened with
  // reviewRequests already false must show the pill off rather than defaulting to on
  // and lying about it until the user clicks.
  it("reflects the host's review-queue state on the pill", () => {
    render(<DeckApp />);
    host({ ...runsMsg([mkStatus()]), reviewQueue: false } as OutboundMessage);
    expect(screen.getByRole("button", { name: /review queue/i }).className).not.toMatch(/\bon\b/);
    host(runsMsg([mkStatus()]));
    expect(screen.getByRole("button", { name: /review queue/i }).className).toMatch(/\bon\b/);
  });

  it("shows the gh note when the host sends one", () => {
    render(<DeckApp />);
    host({ type: "deck:runs", runs: [mkStatus()], liveSignal: true, prFacts: true, openAgents: true, reviewQueue: true, ghNote: "gh CLI not found — PR facts off", prReviewStatus: "PR initiated", grouping: "agents", staleCount: 0, sourceLabel: "Jira" });
    expect(screen.getByText(/gh CLI not found/)).toBeTruthy();
  });

  // The nested agents row belongs to the Workspaces lens — the Agents lens gives
  // each of these sessions a card of its own instead, so every case below says
  // which grouping it is about rather than relying on the default.
  it("names a single agent instead of counting to one", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ agents: [mkAgent("svc-7e", "working", Date.now())] })], "PR initiated", "workspaces"));
    expect(screen.getByText("svc-7e")).toBeTruthy();
    expect(screen.queryByText(/1 agent/)).toBeNull();
  });

  it("counts several agents and lists them when expanded", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ agents: [mkAgent("svc-7e", "working", Date.now()), mkAgent("svc-fa", "idle", Date.now() - 60_000)] })], "PR initiated", "workspaces"));
    const disclosure = screen.getByRole("button", { name: /2 agents/ });
    expect(screen.queryByText("svc-fa")).toBeNull();
    fireEvent.click(disclosure);
    expect(screen.getByText("svc-fa")).toBeTruthy();
    // Each row carries its OWN state — the whole point of listing them.
    expect(screen.getByText("working")).toBeTruthy();
    expect(screen.getByText("idle")).toBeTruthy();
  });

  it("gives the collapsed label mono only when it is a name, not a count", () => {
    // Mono is for identifiers on this board. A solo agent's collapsed label IS
    // its session name, so it earns .id; "N agents" is prose about a count and
    // must not carry the identifier styling, even though both sit in .ag-label.
    const solo = render(<DeckApp />);
    host(runsMsg([mkStatus({ agents: [mkAgent("svc-7e", "working", Date.now())] })], "PR initiated", "workspaces"));
    const soloLabel = solo.container.querySelector(".ag-label")!;
    expect(soloLabel.classList.contains("id")).toBe(true);
    solo.unmount();

    const many = render(<DeckApp />);
    host(runsMsg([mkStatus({ agents: [mkAgent("svc-7e", "working", Date.now()), mkAgent("svc-fa", "idle", Date.now() - 60_000)] })], "PR initiated", "workspaces"));
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
    host(runsMsg([mkStatus({ agents: [noStart, mkAgent("svc-fa", "idle", Date.now() - 60_000)] })], "PR initiated", "workspaces"));
    fireEvent.click(screen.getByRole("button", { name: /2 agents/ }));
    const rows = [...container.querySelectorAll(".ag-row")];
    const zeroRow = rows.find((r) => r.textContent?.includes("svc-7e"))!;
    expect(zeroRow.querySelector(".ag-open")).toBeNull();
    const knownRow = rows.find((r) => r.textContent?.includes("svc-fa"))!;
    expect(knownRow.querySelector(".ag-open")?.textContent).toMatch(/^open /);
  });

  it("renders no agents row for a card with none", () => {
    // Not screen.queryByRole("button", { name: /agent/ }) — the header's own
    // "Open agents" toggle always renders and its accessible name matches that
    // pattern too, so an unscoped query would pass even if AgentsRow leaked an
    // empty control. Scope to the card's own markup instead.
    const { container } = render(<DeckApp />);
    host(runsMsg([mkStatus({ agents: [] })]));
    expect(container.querySelector(".c-agents")).toBeNull();
  });
});

const reviewsMsg = (requests: ReviewRequest[], issueCount = requests.length): OutboundMessage =>
  ({ type: "deck:reviews", requests, issueCount, sort: "oldest", stale: false, reviewWrites: false, enabled: true, loading: false });

const mkReview = (over: Partial<ReviewRequest> = {}): ReviewRequest => ({
  id: "o/r#1", repo: "o/r", repoName: "r", number: 1, title: "a small fix", url: "https://gh/o/r/pull/1",
  author: "dana", isDraft: false, createdAt: Date.now() - 3_600_000, updatedAt: Date.now(),
  additions: 10, deletions: 2, changedFiles: 1,
  ci: "passing", review: "review_required", mergeable: "clean",
  localPath: null, runKey: null, draftPath: null, ...over,
});

describe("DeckApp review strip", () => {
  it("shows no To review stat until the host posts a queue", () => {
    render(<DeckApp />);
    expect(screen.queryByText("To review")).not.toBeInTheDocument();
    host(reviewsMsg([mkReview()]));
    expect(screen.getByText("To review")).toBeInTheDocument();
  });

  // The strip going off (reviewRequests toggled, PR facts toggled off, gh going
  // unusable) posts `enabled: false` with an emptied queue. This must drop the
  // stat tile entirely, not merely zero it — a "0 To review" tile reads as "the
  // feature is on and you owe nobody a review", which is a different claim than
  // "this feature is off".
  it("drops the To review stat entirely once the host reports the strip disabled", () => {
    render(<DeckApp />);
    host(reviewsMsg([mkReview()]));
    expect(screen.getByText("To review")).toBeInTheDocument();
    host({ ...reviewsMsg([], 0), enabled: false } as OutboundMessage);
    expect(screen.queryByText("To review")).not.toBeInTheDocument();
    expect(screen.queryByText(/waiting on your review/i)).not.toBeInTheDocument();
  });

  // The strip and the stat part company here, deliberately: an empty rail above the
  // board is noise, but a "0" tile is the only thing telling you the feature is alive.
  // Scoped to the "To review" stat itself: with no runs, every other stat tile (In
  // progress, Action required, In review, Total) also reads "0", so a bare
  // screen.getByText("0") matches five elements and throws rather than asserting
  // anything.
  it("keeps the To review stat at zero, while the strip itself disappears", () => {
    render(<DeckApp />);
    host(reviewsMsg([], 0));
    const stat = screen.getByText("To review").closest<HTMLElement>(".stat")!;
    expect(within(stat).getByText("0")).toBeInTheDocument();
    expect(screen.queryByText(/waiting on your review/i)).not.toBeInTheDocument();
  });

  it("renders the strip above the board", () => {
    render(<DeckApp />);
    host(reviewsMsg([mkReview()]));
    expect(screen.getByText("a small fix")).toBeInTheDocument();
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

  // Cold start. The tile has to say *something* — it is the only part of the
  // header that survives the strip being empty — but "0" is a claim about a
  // search that has not come back yet.
  it("spins the To review tile instead of counting zero while loading", () => {
    const { container } = render(<DeckApp />);
    host({ ...reviewsMsg([], 0), loading: true } as OutboundMessage);
    expect(screen.getByText("To review")).toBeInTheDocument();
    expect(container.querySelector(".stat .spin")).toBeInTheDocument();
  });

  it("swaps the spinner for the real count once the search lands", () => {
    const { container } = render(<DeckApp />);
    host({ ...reviewsMsg([], 0), loading: true } as OutboundMessage);
    host(reviewsMsg([mkReview(), mkReview({ id: "o/r#2", number: 2 })]));
    expect(container.querySelector(".stat .spin")).not.toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("passes the loading flag through to the strip", () => {
    render(<DeckApp />);
    host({ ...reviewsMsg([], 0), loading: true } as OutboundMessage);
    expect(screen.getByText(/checking for PRs waiting on your review/i)).toBeInTheDocument();
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
    fireEvent.click(screen.getByText(/Load agent's review/i));
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
    fireEvent.click(screen.getByText(/Load agent's review/i));
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
    fireEvent.click(screen.getByText(/Load agent's review/i));
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
    fireEvent.click(screen.getByText(/Load agent's review/i));
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
    fireEvent.click(screen.getByText(/Load agent's review/i));
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

describe("DeckApp — Address PR", () => {
  const prCard = (over: Partial<RunStatus> = {}) => mkStatus({ ticketStatus: "PR initiated", ...over });

  it("shows the button when the Jira status matches the configured one", () => {
    render(<DeckApp />);
    host(runsMsg([prCard()]));
    expect(screen.getByRole("button", { name: "Address PR" })).toBeInTheDocument();
  });

  it("matches the status case-insensitively and ignores surrounding space", () => {
    render(<DeckApp />);
    host(runsMsg([prCard({ ticketStatus: "  pr initiated  " })]));
    expect(screen.getByRole("button", { name: "Address PR" })).toBeInTheDocument();
  });

  it("hides the button on a card in any other status", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ ticketStatus: "In Progress" })]));
    expect(screen.queryByRole("button", { name: "Address PR" })).not.toBeInTheDocument();
  });

  it("hides the button when the run has no Jira status at all", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ ticketStatus: null })]));
    expect(screen.queryByRole("button", { name: "Address PR" })).not.toBeInTheDocument();
  });

  it("hides the button when the setting is empty", () => {
    render(<DeckApp />);
    host(runsMsg([prCard()], ""));
    expect(screen.queryByRole("button", { name: "Address PR" })).not.toBeInTheDocument();
  });

  it("hides the button on a local card, whose ticket key is only inferred", () => {
    render(<DeckApp />);
    host(runsMsg([prCard({ run: { ...mkStatus().run, kind: "local" } })]));
    expect(screen.queryByRole("button", { name: "Address PR" })).not.toBeInTheDocument();
  });

  it("posts deck:addressPr with the run key on click", () => {
    render(<DeckApp />);
    host(runsMsg([prCard()]));
    fireEvent.click(screen.getByRole("button", { name: "Address PR" }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:addressPr", key: "ASM-1" });
  });

  it("leads the action row, before Open", () => {
    render(<DeckApp />);
    host(runsMsg([prCard()]));
    const labels = Array.from(document.querySelectorAll(".actions .act")).map((b) => b.textContent);
    expect(labels).toEqual(["Address PR", "Open", "Diff"]);
  });
});

describe("Agents view", () => {
  it("renders one card per agent, each with its own state and name", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ agents: [
      { ...mkAgent("agent-flow-2e", "working", 100), repo: "svc" },
      { ...mkAgent("svc-7f", "needs-you", 200), repo: "svc" },
    ] })]));
    expect(screen.getByText("agent-flow-2e")).toBeInTheDocument();
    expect(screen.getByText("svc-7f")).toBeInTheDocument();
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

  it("collapses to one card per run when Open agents is off", () => {
    render(<DeckApp />);
    host({ ...runsMsg([mkStatus({ agents: [] })]), openAgents: false } as OutboundMessage);
    expect(screen.getAllByText("ASM-1")).toHaveLength(1);
  });

  it("shows the workspace view's nested agents row instead when grouping is workspaces", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ agents: [{ ...mkAgent("agent-flow-2e", "working", 100), repo: "svc" }] })],
                 "PR initiated", "workspaces"));
    // The collapsed agents row, not a card per agent.
    expect(screen.getByTitle(/sessions open in this directory/i)).toBeInTheDocument();
    expect(screen.getAllByText("ASM-1")).toHaveLength(1);
  });

  it("shows the session slug as a tooltip on an expanded agent row", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({
      agents: [{ ...mkAgent("agent-flow-2e", "working", 100), activity: { state: "working", lastActivityMs: 100, slug: "export-streaming-fix" } }],
    })], "PR initiated", "workspaces"));
    fireEvent.click(screen.getByTitle(/sessions open in this directory/i));
    expect(screen.getByTitle("export-streaming-fix")).toBeInTheDocument();
  });

  it("has no title on an expanded agent row when no slug is known yet", () => {
    const { container } = render(<DeckApp />);
    host(runsMsg([mkStatus({
      agents: [mkAgent("agent-flow-2e", "working", 100)],
    })], "PR initiated", "workspaces"));
    fireEvent.click(screen.getByTitle(/sessions open in this directory/i));
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
      cards: Array.from(c.querySelectorAll(".c-agent")).map((a) => a.textContent),
    }));
    expect(columns.find((c) => c.name === "In progress")!.cards).toEqual(["a-working"]);
    expect(columns.find((c) => c.name === "Action required")!.cards).toEqual(["a-ended"]);
  });

  it("falls back to the workspace name, not the first repo, when an agent's repo is unresolved", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({
      run: {
        ...mkStatus().run,
        mode: "multiroot",
        workspaceFile: "/Users/x/.agentflow/workspaces/ASM-1+2.code-workspace",
        repos: [
          { name: "svc-api", path: "/r/svc-api", isGit: true, branch: "ASM-1-x" },
          { name: "svc-web", path: "/r/svc-web", isGit: true, branch: "ASM-1-x" },
        ],
      },
      agents: [mkAgent("agent-flow-2e", "working", 100)],
    })]));
    expect(screen.getByTitle(/Claude Code session in ASM-1\+2/)).toBeInTheDocument();
    expect(screen.queryByTitle(/Claude Code session in svc-api/)).not.toBeInTheDocument();
  });

  it("still falls back to the first repo when the run has no workspace file", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({
      agents: [mkAgent("agent-flow-2e", "working", 100)],
    })]));
    expect(screen.getByTitle(/Claude Code session in svc/)).toBeInTheDocument();
  });

  it("extracts workspace name from Windows-style paths", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({
      run: {
        ...mkStatus().run,
        mode: "multiroot",
        workspaceFile: "C:\\Users\\x\\.agentflow\\workspaces\\WIN-1.code-workspace",
        repos: [
          { name: "svc-api", path: "C:\\r\\svc-api", isGit: true, branch: "WIN-1-x" },
        ],
      },
      agents: [mkAgent("agent-flow-2e", "working", 100)],
    })]));
    expect(screen.getByTitle(/Claude Code session in WIN-1/)).toBeInTheDocument();
    expect(screen.queryByTitle(/Claude Code session in C:\\/)).not.toBeInTheDocument();
  });

  it("leads the agent chip tooltip with the session slug when one is known", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({
      agents: [{ ...mkAgent("agent-flow-2e", "working", 100), activity: { state: "working", lastActivityMs: 100, slug: "export-streaming-fix" } }],
    })]));
    expect(screen.getByTitle(/^export-streaming-fix — Claude Code session in svc$/)).toBeInTheDocument();
  });

  it("keeps the repo-only tooltip when no slug is known yet", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({
      agents: [mkAgent("agent-flow-2e", "working", 100)],
    })]));
    expect(screen.getByTitle(/^Claude Code session in svc$/)).toBeInTheDocument();
  });

  it("counts cards, not runs, in the stat tiles", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ agents: [
      { ...mkAgent("a1", "working", 100), repo: "svc" },
      { ...mkAgent("a2", "working", 200), repo: "svc" },
    ] })]));
    const tiles = Array.from(document.querySelectorAll(".stat")).map((s) => [s.querySelector(".l")!.textContent, s.querySelector(".n")!.textContent]);
    expect(tiles).toContainEqual(["In progress", "2"]);
    expect(tiles).toContainEqual(["Total", "2"]);
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
    expect(screen.getByTitle("Best-effort live signal from Claude Code transcripts. Off → git + Jira only.")).toBeInTheDocument();
    expect(screen.getByTitle("Read each task's PR state from GitHub with the gh CLI. Off → git + Jira only.")).toBeInTheDocument();
    expect(screen.getByTitle("Re-read git, Jira and PR state now")).toBeInTheDocument();
    expect(document.querySelector(".note")!.textContent).toBe("git + Jira backbone · best-effort live from ~/.claude/projects");
  });

  it("renders the chrome's Jira strings byte-for-byte once a Jira-labeled deck:runs lands", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    expect(screen.getByTitle("Best-effort live signal from Claude Code transcripts. Off → git + Jira only.")).toBeInTheDocument();
    expect(screen.getByTitle("Read each task's PR state from GitHub with the gh CLI. Off → git + Jira only.")).toBeInTheDocument();
    expect(screen.getByTitle("Re-read git, Jira and PR state now")).toBeInTheDocument();
    expect(document.querySelector(".note")!.textContent).toBe("git + Jira backbone · best-effort live from ~/.claude/projects");
  });

  it("renders a tracked card's Jira strings byte-for-byte: key title, status pill title, overflow menu item", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    expect(screen.getByTitle("Open ASM-1 in Jira")).toBeInTheDocument();
    expect(screen.getByTitle("Jira status: In Progress")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle(/more actions/i));
    expect(screen.getByText("Open in Jira")).toBeInTheDocument();
  });

  it("renders a local/inferred card's key title with Jira byte-for-byte", () => {
    render(<DeckApp />);
    host(runsMsg([localCard()]));
    expect(screen.getByTitle("Open ASM-5641 in Jira")).toBeInTheDocument();
  });

  it("renders the exact parked string with Jira when live signal is off", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    fireEvent.click(screen.getByText(/Live signal/i));
    expect(screen.getByText("parked · git + Jira only")).toBeInTheDocument();
  });

  it("templates every one of those strings off a non-Jira sourceLabel — proving the label actually reaches the render", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()], "PR initiated", "agents", "Acme"));
    expect(screen.getByTitle("Best-effort live signal from Claude Code transcripts. Off → git + Acme only.")).toBeInTheDocument();
    expect(screen.getByTitle("Read each task's PR state from GitHub with the gh CLI. Off → git + Acme only.")).toBeInTheDocument();
    expect(screen.getByTitle("Re-read git, Acme and PR state now")).toBeInTheDocument();
    expect(document.querySelector(".note")!.textContent).toBe("git + Acme backbone · best-effort live from ~/.claude/projects");
    expect(screen.getByTitle("Open ASM-1 in Acme")).toBeInTheDocument();
    expect(screen.getByTitle("Acme status: In Progress")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle(/more actions/i));
    expect(screen.getByText("Open in Acme")).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Live signal/i));
    expect(screen.getByText("parked · git + Acme only")).toBeInTheDocument();
    // No trace of the shipped default anywhere on the rendered board.
    expect(document.body.textContent).not.toMatch(/Jira/);
  });

  it("templates the inferred-key card title off a non-Jira sourceLabel too", () => {
    render(<DeckApp />);
    host(runsMsg([localCard()], "PR initiated", "agents", "Acme"));
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
  ({ type: "deck:flows", flows, enabled, pendingResume: [] });

/** The drawer itself, not the header chip that shares its name. */
const drawer = () => screen.queryByRole("complementary", { name: "Orchestrator" });
const chip = () => screen.getByRole("button", { name: /Orchestrator/ });

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
      flows: [{ ...mkFlow("f1", "Ship the migration"), armed: true }],
      enabled: true,
      pendingResume: [{ flowId: "f1", flowName: "Ship the migration", lines: ["ready"] }],
    });
    fireEvent.click(chip()); // a saved flow no longer auto-opens (Task 7)
    fireEvent.click(screen.getByRole("button", { name: /^go$/i }));
    expect(sent).toHaveBeenCalledWith({ type: "flow:resumeApprove", id: "f1" });
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
