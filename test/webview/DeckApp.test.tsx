// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as React from "react";
import { render, screen, fireEvent, act, within } from "@testing-library/react";

vi.mock("../../src/webview/vscodeApi", () => ({ send: vi.fn() }));

import { DeckApp } from "../../src/webview/DeckApp";
import { send } from "../../src/webview/vscodeApi";
import type { OutboundMessage, PrFacts, ReviewRequest, RunStatus } from "../../src/types";

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

const reviewsMsg = (requests: ReviewRequest[], issueCount = requests.length): OutboundMessage =>
  ({ type: "deck:reviews", requests, issueCount, sort: "oldest", stale: false });

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
});
