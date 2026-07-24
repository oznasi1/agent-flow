// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as React from "react";
import { render, screen, fireEvent, act, within } from "@testing-library/react";

vi.mock("../../src/webview/vscodeApi", () => ({ send: vi.fn() }));

import { App } from "../../src/webview/App";
import { send } from "../../src/webview/vscodeApi";
import type { OutboundMessage } from "../../src/types";
import { mkTask } from "../_helpers/factories";

const sent = vi.mocked(send);

/** Deliver a host→webview message the way the real postMessage bridge would. */
function host(msg: OutboundMessage) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data: msg }));
  });
}

const ALL_FILTERS = { size: true, status: true, repo: true, search: true };
const authed = (prReviewStatus = "PR initiated", filters = ALL_FILTERS) =>
  host({ type: "state", authed: true, configured: true, project: "ASM", me: "Jane", prReviewStatus, filters });

beforeEach(() => sent.mockClear());

describe("mount + auth gate", () => {
  it("announces readiness on mount", () => {
    render(<App />);
    expect(sent).toHaveBeenCalledWith({ type: "ready" });
  });

  it("shows the sign-in gate and wires the button when unauthenticated", () => {
    render(<App />);
    host({ type: "state", authed: false, configured: true, project: "", me: null, prReviewStatus: "PR initiated", filters: ALL_FILTERS });
    const button = screen.getByRole("button", { name: /Sign in to Jira/i });
    fireEvent.click(button);
    expect(sent).toHaveBeenCalledWith({ type: "signIn" });
  });

  it("renders the project + user header and the task list when authenticated", () => {
    render(<App />);
    authed();
    host({ type: "tasks", filter: "unassigned", tasks: [mkTask({ key: "ASM-1", summary: "Fix the bug" })] });
    expect(screen.getByText(/📋\s*ASM/)).toBeInTheDocument(); // header title, not the card key
    expect(screen.getByText("Jane")).toBeInTheDocument();
    expect(screen.getByText("ASM-1")).toBeInTheDocument();
    expect(screen.getByText("Fix the bug")).toBeInTheDocument();
  });
});

describe("problem indication", () => {
  it("shows a Connecting… indicator before any state arrives (never blank)", () => {
    render(<App />);
    expect(screen.getByText(/Connecting to Jira/i)).toBeInTheDocument();
  });

  it("shows a Run setup call-to-action when not configured", () => {
    render(<App />);
    host({ type: "state", authed: false, configured: false, project: "", me: null, prReviewStatus: "PR initiated", filters: ALL_FILTERS });
    expect(screen.queryByText(/Sign in to Jira/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Run setup/i }));
    expect(sent).toHaveBeenCalledWith({ type: "runSetup" });
  });

  it("shows a persistent error banner and retries on click", () => {
    render(<App />);
    host({ type: "error", message: "Jira didn't respond within 15s", canRetry: true });
    expect(screen.getByText(/didn't respond within 15s/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));
    expect(sent).toHaveBeenCalledWith({ type: "retry" });
  });

  it("clears the error once fresh state arrives", () => {
    render(<App />);
    host({ type: "error", message: "boom", canRetry: true });
    expect(screen.getByText(/boom/)).toBeInTheDocument();
    host({ type: "state", authed: true, configured: true, project: "ASM", me: "Jane", prReviewStatus: "PR initiated", filters: ALL_FILTERS });
    expect(screen.queryByText(/boom/)).not.toBeInTheDocument();
  });
});

describe("filter + size lenses", () => {
  it("requests a fetch when a filter tab is clicked", () => {
    render(<App />);
    authed();
    fireEvent.click(screen.getByRole("button", { name: "My sprint" }));
    expect(sent).toHaveBeenCalledWith({ type: "fetch", filter: "mysprint", size: "any" });
  });

  it("requests a fetch when a size chip is clicked", () => {
    render(<App />);
    authed();
    fireEvent.click(screen.getByRole("button", { name: "S" }));
    expect(sent).toHaveBeenCalledWith({ type: "fetch", filter: "mysprint", size: "s" });
  });
});

describe("status filter lens", () => {
  const twoStatuses = () =>
    host({
      type: "tasks",
      filter: "mine",
      tasks: [
        mkTask({ key: "ASM-1", summary: "todo one", status: "To Do", statusCategory: "new" }),
        mkTask({ key: "ASM-2", summary: "wip one", status: "In Progress", statusCategory: "indeterminate" }),
      ],
    });
  // The filter chips live in the .statuses row — scope queries there so they don't
  // collide with the same-labelled status button on each card.
  const chip = (name: string) =>
    within(document.querySelector(".statuses") as HTMLElement).getByRole("button", { name });

  it("shows a chip per distinct status and narrows the pool by the selected ones", () => {
    render(<App />);
    authed();
    twoStatuses();
    expect(screen.getByText("ASM-1")).toBeInTheDocument();
    expect(screen.getByText("ASM-2")).toBeInTheDocument();

    fireEvent.click(chip("In Progress"));
    expect(screen.queryByText("ASM-1")).not.toBeInTheDocument();
    expect(screen.getByText("ASM-2")).toBeInTheDocument();
  });

  it("is multi-select: adding a second status widens the view", () => {
    render(<App />);
    authed();
    twoStatuses();
    fireEvent.click(chip("In Progress"));
    fireEvent.click(chip("To Do"));
    expect(screen.getByText("ASM-1")).toBeInTheDocument();
    expect(screen.getByText("ASM-2")).toBeInTheDocument();
  });

  it("All clears the selection", () => {
    render(<App />);
    authed();
    twoStatuses();
    fireEvent.click(chip("In Progress"));
    expect(screen.queryByText("ASM-1")).not.toBeInTheDocument();
    fireEvent.click(chip("All"));
    expect(screen.getByText("ASM-1")).toBeInTheDocument();
    expect(screen.getByText("ASM-2")).toBeInTheDocument();
  });

  it("shows no status row when the pool has no statuses", () => {
    render(<App />);
    authed();
    host({ type: "tasks", filter: "mine", tasks: [mkTask({ key: "ASM-1", status: "" })] });
    expect(document.querySelector(".statuses")).toBeNull();
  });

  it("prunes a selected status that is absent after a refetch (no invisible filter)", () => {
    render(<App />);
    authed();
    twoStatuses();
    fireEvent.click(chip("In Progress")); // filter down to ASM-2
    expect(screen.queryByText("ASM-1")).not.toBeInTheDocument();
    // New pool has no "In Progress" — the stale selection must be dropped, not hide everything.
    host({ type: "tasks", filter: "mine", tasks: [mkTask({ key: "ASM-3", summary: "todo two", status: "To Do", statusCategory: "new" })] });
    expect(screen.getByText("ASM-3")).toBeInTheDocument();
  });
});

describe("configurable filter visibility", () => {
  const off = (overrides: Partial<typeof ALL_FILTERS>) => ({ ...ALL_FILTERS, ...overrides });
  // Includes a service so the repo multiselect (which renders nothing when the
  // pool has no repos) has something to show in these visibility-gating tests.
  const oneTask = () =>
    host({
      type: "tasks",
      filter: "mine",
      tasks: [mkTask({ key: "ASM-1", status: "To Do", statusCategory: "new", services: ["billing"] })],
    });

  it("shows Size, Status, and Repo controls by default", () => {
    render(<App />);
    authed();
    oneTask();
    expect(document.querySelector(".sizes")).not.toBeNull();
    expect(document.querySelector(".statuses")).not.toBeNull();
    expect(document.querySelector(".repo-select")).not.toBeNull();
  });

  it("hides the Size lens when filters.size is off, leaving the others", () => {
    render(<App />);
    authed("PR initiated", off({ size: false }));
    oneTask();
    expect(document.querySelector(".sizes")).toBeNull();
    expect(document.querySelector(".statuses")).not.toBeNull();
    expect(document.querySelector(".repo-select")).not.toBeNull();
  });

  it("hides the Status lens when filters.status is off, even with statuses present", () => {
    render(<App />);
    authed("PR initiated", off({ status: false }));
    oneTask();
    expect(document.querySelector(".statuses")).toBeNull();
    expect(document.querySelector(".sizes")).not.toBeNull();
    expect(document.querySelector(".repo-select")).not.toBeNull();
  });

  it("a hidden Status lens does not narrow the visible task list", () => {
    render(<App />);
    authed("PR initiated", off({ status: false }));
    host({
      type: "tasks",
      filter: "mine",
      tasks: [
        mkTask({ key: "ASM-1", summary: "todo one", status: "To Do", statusCategory: "new" }),
        mkTask({ key: "ASM-2", summary: "wip one", status: "In Progress", statusCategory: "indeterminate" }),
      ],
    });
    expect(screen.getByText("ASM-1")).toBeInTheDocument();
    expect(screen.getByText("ASM-2")).toBeInTheDocument();
  });
});

describe("repo multiselect", () => {
  const threeRepos = () =>
    host({
      type: "tasks",
      filter: "mine",
      tasks: [
        mkTask({ key: "ASM-1", summary: "alpha", services: ["billing"] }),
        mkTask({ key: "ASM-2", summary: "bravo", services: ["web"] }),
        mkTask({ key: "ASM-3", summary: "charlie", services: ["billing", "worker"] }),
      ],
    });

  it("renders the trigger with the 'Filter repos' label, not the old text box", () => {
    render(<App />);
    authed();
    threeRepos();
    expect(document.querySelector(".repo-filter")).toBeNull();
    expect(document.querySelector(".repo-select")).not.toBeNull();
    expect(screen.getByText("Filter repos")).toBeInTheDocument();
  });

  it("lists the sorted, de-duped union of repos when opened", () => {
    render(<App />);
    authed();
    threeRepos();
    fireEvent.click(screen.getByText("Filter repos"));
    const opts = Array.from(document.querySelectorAll(".repo-opt .repo-name")).map((e) => e.textContent);
    expect(opts).toEqual(["billing", "web", "worker"]);
  });

  it("OR-filters the list to tasks touching any selected repo", () => {
    render(<App />);
    authed();
    threeRepos();
    fireEvent.click(screen.getByText("Filter repos"));
    // Scoped to the popup list — "billing" also appears as a service chip on the
    // ASM-1/ASM-3 cards, so an unscoped getByText would match multiple nodes.
    const repoList = document.querySelector(".repo-list") as HTMLElement;
    fireEvent.mouseDown(within(repoList).getByText("billing").closest(".repo-opt")!);
    expect(screen.getByText("ASM-1")).toBeInTheDocument(); // billing
    expect(screen.getByText("ASM-3")).toBeInTheDocument(); // billing + worker
    expect(screen.queryByText("ASM-2")).not.toBeInTheDocument(); // web only
  });

  it("Clear resets the selection and restores the full list", () => {
    render(<App />);
    authed();
    threeRepos();
    fireEvent.click(screen.getByText("Filter repos"));
    // Scoped to the popup list — "web" also appears as a service chip on the
    // ASM-2 card, so an unscoped getByText would match multiple nodes.
    const repoList = document.querySelector(".repo-list") as HTMLElement;
    fireEvent.mouseDown(within(repoList).getByText("web").closest(".repo-opt")!); // only ASM-2 touches web
    expect(screen.queryByText("ASM-1")).not.toBeInTheDocument();
    fireEvent.mouseDown(screen.getByText("Clear"));
    expect(screen.getByText("ASM-1")).toBeInTheDocument();
    expect(screen.getByText("ASM-2")).toBeInTheDocument();
    expect(screen.getByText("ASM-3")).toBeInTheDocument();
  });

  it("hides the multiselect when filters.repo is off", () => {
    render(<App />);
    authed("PR initiated", { size: true, status: true, repo: false, search: true });
    host({ type: "tasks", filter: "mine", tasks: [mkTask({ key: "ASM-1", services: ["web"] })] });
    expect(document.querySelector(".repo-select")).toBeNull();
  });
});

describe("multi-select & parallel launch", () => {
  const apiPool = () =>
    host({
      type: "tasks",
      filter: "mine",
      tasks: [
        mkTask({ key: "ASM-1", summary: "one", services: ["api"] }),
        mkTask({ key: "ASM-2", summary: "two", services: ["api"] }),
        mkTask({ key: "ASM-3", summary: "three", services: ["billing"] }),
      ],
    });
  // Open the repo multiselect popup and toggle a repo option by name.
  const selectRepo = (name: string) => {
    fireEvent.click(screen.getByText("Filter repos"));
    const repoList = document.querySelector(".repo-list") as HTMLElement;
    fireEvent.mouseDown(within(repoList).getByText(name).closest(".repo-opt")!);
  };
  const checks = () => document.querySelectorAll(".card-check");

  it("shows no checkboxes until exactly one repo is filtered", () => {
    render(<App />);
    authed();
    apiPool();
    expect(checks().length).toBe(0);
  });

  it("shows a checkbox on each visible card when one repo is filtered", () => {
    render(<App />);
    authed();
    apiPool();
    selectRepo("api"); // narrows the pool to ASM-1 + ASM-2
    expect(checks().length).toBe(2);
  });

  it("hides checkboxes again once a second repo is added", () => {
    render(<App />);
    authed();
    apiPool();
    // Open the popup ONCE and toggle two repos — re-clicking the trigger would close it.
    fireEvent.click(screen.getByText("Filter repos"));
    const repoList = document.querySelector(".repo-list") as HTMLElement;
    fireEvent.mouseDown(within(repoList).getByText("api").closest(".repo-opt")!);
    fireEvent.mouseDown(within(repoList).getByText("billing").closest(".repo-opt")!);
    expect(checks().length).toBe(0); // 2 repos selected → batch mode off
  });

  it("launches the checked, visible tasks with the filtered repo name", () => {
    render(<App />);
    authed();
    apiPool();
    selectRepo("api");
    fireEvent.click(checks()[0]); // ASM-1
    fireEvent.click(checks()[1]); // ASM-2
    fireEvent.click(screen.getByRole("button", { name: /Launch in parallel/i }));
    expect(sent).toHaveBeenCalledWith({ type: "takeBatch", keys: ["ASM-1", "ASM-2"], repo: "api" });
  });

  it("does not expand a card when its checkbox is clicked", () => {
    render(<App />);
    authed();
    apiPool();
    selectRepo("api");
    sent.mockClear();
    fireEvent.click(checks()[0]);
    expect(sent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "detail" }));
  });

  it("Clear selection empties the batch and hides the action bar", () => {
    render(<App />);
    authed();
    apiPool();
    selectRepo("api");
    fireEvent.click(checks()[0]);
    expect(screen.getByRole("button", { name: /Launch in parallel/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Clear selection/i }));
    expect(screen.queryByRole("button", { name: /Launch in parallel/i })).not.toBeInTheDocument();
  });

  it("clears the batch selection when a fresh pool arrives", () => {
    render(<App />);
    authed();
    apiPool();
    selectRepo("api");
    fireEvent.click(checks()[0]);
    expect(screen.getByRole("button", { name: /Launch in parallel/i })).toBeInTheDocument();
    apiPool(); // new tasks message
    expect(screen.queryByRole("button", { name: /Launch in parallel/i })).not.toBeInTheDocument();
  });
});

describe("fuzzy title search", () => {
  const keys = () => Array.from(document.querySelectorAll("a.key")).map((e) => e.textContent);
  const pool = () =>
    host({
      type: "tasks",
      filter: "mine",
      tasks: [
        mkTask({ key: "ASM-1", summary: "Fix rate limiter dropping bursts", services: ["api"] }),
        mkTask({ key: "ASM-2", summary: "Billing webhook retries", services: ["billing"] }),
        mkTask({ key: "ASM-3", summary: "Rate-limit config per tenant", services: ["api"] }),
      ],
    });

  it("narrows the list to fuzzy title matches", () => {
    render(<App />);
    authed();
    pool();
    fireEvent.change(screen.getByPlaceholderText("Search title…"), { target: { value: "ratelim" } });
    expect(keys()).toEqual(expect.arrayContaining(["ASM-1", "ASM-3"]));
    expect(screen.queryByText("ASM-2")).not.toBeInTheDocument();
  });

  it("orders fuzzy matches best-match-first", () => {
    render(<App />);
    authed();
    pool();
    // Under the app's fuse config (keys: ["summary"], threshold: 0.4, ignoreLocation: true),
    // "ratelim" scores "Rate-limit config per tenant" (ASM-3, ~0.378) closer than
    // "Fix rate limiter dropping bursts" (ASM-1, ~0.419) — verified empirically by running
    // fuse.search("ratelim") against this exact pool. The visible list must reflect that order.
    fireEvent.change(screen.getByPlaceholderText("Search title…"), { target: { value: "ratelim" } });
    expect(keys()).toEqual(["ASM-3", "ASM-1"]);
  });

  it("shows a text-specific empty state when nothing matches", () => {
    render(<App />);
    authed();
    pool();
    fireEvent.change(screen.getByPlaceholderText("Search title…"), { target: { value: "zzzzz" } });
    expect(screen.getByText(/No titles match/i)).toBeInTheDocument();
  });

  it("combines with the repo multiselect (AND across types)", () => {
    render(<App />);
    authed();
    host({
      type: "tasks",
      filter: "mine",
      tasks: [
        mkTask({ key: "ASM-1", summary: "Fix rate limiter dropping bursts", services: ["api"] }),
        mkTask({ key: "ASM-2", summary: "Billing webhook retries", services: ["billing"] }),
        mkTask({ key: "ASM-3", summary: "Rate-limit config per tenant", services: ["api"] }),
        // In the selected repo ("api") but its title doesn't fuzzy-match "rate" — correct AND
        // must exclude it; a buggy repo-OR-text combination would wrongly include it.
        mkTask({ key: "ASM-4", summary: "Deploy pipeline", services: ["api"] }),
      ],
    });
    fireEvent.click(screen.getByText("Filter repos"));
    // Scoped to the popup list — "api" also appears as a service chip on the
    // ASM-1/ASM-3 cards, so an unscoped getByText would match multiple nodes
    // (same ambiguity already guarded against in the "repo multiselect" tests above).
    const repoList = document.querySelector(".repo-list") as HTMLElement;
    fireEvent.mouseDown(within(repoList).getByText("api").closest(".repo-opt")!);
    fireEvent.change(screen.getByPlaceholderText("Search title…"), { target: { value: "rate" } });
    expect(keys()).toEqual(expect.arrayContaining(["ASM-1", "ASM-3"]));
    expect(screen.queryByText("ASM-2")).not.toBeInTheDocument(); // billing filtered out by repo
    expect(screen.queryByText("ASM-4")).not.toBeInTheDocument(); // api but no "rate" match — AND must exclude it
  });

  it("hides the search box when filters.search is off", () => {
    render(<App />);
    authed("PR initiated", { size: true, status: true, repo: true, search: false });
    pool();
    expect(screen.queryByPlaceholderText("Search title…")).not.toBeInTheDocument();
  });
});

describe("My-sprint reorder bar", () => {
  it("shows Reset order only in the My-sprint lens and wires it", () => {
    render(<App />);
    authed();
    host({ type: "tasks", filter: "unassigned", tasks: [mkTask({ key: "A" })] });
    expect(screen.queryByText("Reset order")).not.toBeInTheDocument();
    host({ type: "tasks", filter: "mysprint", tasks: [mkTask({ key: "A" })] });
    fireEvent.click(screen.getByText("Reset order"));
    expect(sent).toHaveBeenCalledWith({ type: "resetOrder", size: "any" });
  });
});

describe("optimistic list updates", () => {
  it("removes a card when a status change reports removal", () => {
    render(<App />);
    authed();
    host({ type: "tasks", filter: "mine", tasks: [mkTask({ key: "ASM-1", status: "To Do" })] });
    host({ type: "statusChanged", key: "ASM-1", status: "Done", category: "done", removed: true });
    expect(screen.queryByText("ASM-1")).not.toBeInTheDocument();
  });

  it("updates a card's status in place when not removed", () => {
    render(<App />);
    authed();
    host({ type: "tasks", filter: "mine", tasks: [mkTask({ key: "ASM-1", status: "To Do" })] });
    host({ type: "statusChanged", key: "ASM-1", status: "In Progress", category: "indeterminate", removed: false });
    // Target the card's status button (a status-filter chip now shares the "In Progress" label).
    expect(screen.getByTitle("Change status")).toHaveTextContent("In Progress");
  });

  it("reflects a moved-to-sprint assignee update", () => {
    render(<App />);
    authed();
    host({ type: "tasks", filter: "unassigned", tasks: [mkTask({ key: "ASM-1", assignee: "Unassigned" })] });
    host({ type: "movedToSprint", key: "ASM-1", assignee: "Jane Doe", removed: false });
    expect(screen.getByText("Jane Doe")).toBeInTheDocument();
  });
});

describe("toasts", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows a toast and auto-dismisses it", () => {
    render(<App />);
    host({ type: "toast", level: "success", message: "Saved!" });
    expect(screen.getByText("Saved!")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(4300));
    expect(screen.queryByText("Saved!")).not.toBeInTheDocument();
  });
});

describe("task card actions", () => {
  const withTask = (task: ReturnType<typeof mkTask>) => {
    render(<App />);
    authed();
    host({ type: "tasks", filter: "mine", tasks: [task] });
  };

  it("takes a task", () => {
    withTask(mkTask({ key: "ASM-1", summary: "Fix bug" }));
    fireEvent.click(screen.getByRole("button", { name: "Take" }));
    expect(sent).toHaveBeenCalledWith({ type: "take", key: "ASM-1", services: undefined });
  });

  it("shows an Address PR button on a card in the configured PR-review status", () => {
    withTask(mkTask({ key: "ASM-9", status: "PR initiated", statusCategory: "indeterminate" }));
    expect(screen.getByRole("button", { name: /Address PR/i })).toBeInTheDocument();
  });

  it("kicks off a PR review with the task key when clicked", () => {
    withTask(mkTask({ key: "ASM-9", status: "PR initiated", statusCategory: "indeterminate" }));
    fireEvent.click(screen.getByRole("button", { name: /Address PR/i }));
    expect(sent).toHaveBeenCalledWith({ type: "addressPr", key: "ASM-9", services: undefined });
  });

  it("hides the Address PR button when the status does not match", () => {
    withTask(mkTask({ key: "ASM-9", status: "In Progress", statusCategory: "indeterminate" }));
    expect(screen.queryByRole("button", { name: /Address PR/i })).not.toBeInTheDocument();
  });

  it("honors a custom PR-review status, matched case-insensitively", () => {
    render(<App />);
    authed("PR Approved");
    host({ type: "tasks", filter: "mine", tasks: [mkTask({ key: "ASM-9", status: "pr approved", statusCategory: "indeterminate" })] });
    expect(screen.getByRole("button", { name: /Address PR/i })).toBeInTheDocument();
  });

  it("adds an unassigned task to my sprint", () => {
    withTask(mkTask({ key: "ASM-1", assignee: "Unassigned" }));
    fireEvent.click(screen.getByRole("button", { name: /Add to my sprint/i }));
    expect(sent).toHaveBeenCalledWith({ type: "addToMySprint", key: "ASM-1" });
  });

  it("hides Add-to-my-sprint for a task assigned to someone else", () => {
    withTask(mkTask({ key: "ASM-1", assignee: "Someone Else" }));
    expect(screen.queryByText(/Add to my sprint/i)).not.toBeInTheDocument();
  });

  it("shows Add-to-my-sprint for my own task that is not yet in a sprint", () => {
    // current user is "Jane" (set by authed()); own task, not in an open sprint
    withTask(mkTask({ key: "ASM-1", assignee: "Jane", inOpenSprint: false }));
    fireEvent.click(screen.getByRole("button", { name: /Add to my sprint/i }));
    expect(sent).toHaveBeenCalledWith({ type: "addToMySprint", key: "ASM-1" });
  });

  it("hides Add-to-my-sprint for my own task already in a sprint", () => {
    withTask(mkTask({ key: "ASM-1", assignee: "Jane", inOpenSprint: true }));
    expect(screen.queryByText(/Add to my sprint/i)).not.toBeInTheDocument();
  });

  it("opens the status menu", () => {
    withTask(mkTask({ key: "ASM-1", status: "To Do", statusCategory: "new" }));
    // getByTitle targets the card's status button, not the same-labelled filter chip.
    fireEvent.click(screen.getByTitle("Change status"));
    expect(sent).toHaveBeenCalledWith({ type: "changeStatus", key: "ASM-1" });
  });

  it("requests ticket detail when a card is expanded", () => {
    withTask(mkTask({ key: "ASM-1", summary: "Fix bug" }));
    fireEvent.click(screen.getByText("Fix bug"));
    expect(sent).toHaveBeenCalledWith({ type: "detail", key: "ASM-1" });
  });

  it("renders the estimate and service chips", () => {
    withTask(mkTask({ key: "ASM-1", estimateSeconds: 3600, services: ["centaur"] }));
    expect(screen.getByText(/1h/)).toBeInTheDocument();
    expect(screen.getByText("centaur")).toBeInTheDocument();
  });

  it("shows ticket detail once it arrives", () => {
    withTask(mkTask({ key: "ASM-1", summary: "Fix bug" }));
    fireEvent.click(screen.getByText("Fix bug"));
    host({ type: "detail", key: "ASM-1", descriptionText: "The full description", inferred: [], repos: ["centaur"] });
    expect(screen.getByText("The full description")).toBeInTheDocument();
  });
});

describe("drag-and-drop reorder", () => {
  it("commits a grip drag as a reorder message", () => {
    const { container } = render(<App />);
    authed();
    host({
      type: "tasks",
      filter: "mysprint",
      tasks: [mkTask({ key: "A" }), mkTask({ key: "B" })],
    });
    const cards = container.querySelectorAll(".card");
    const cardA = cards[0] as HTMLElement;
    const cardB = cards[1] as HTMLElement;
    const grip = cardA.querySelector(".grip") as HTMLElement;
    const dataTransfer = { setData: vi.fn(), getData: vi.fn(), effectAllowed: "", dropEffect: "" };

    fireEvent.mouseDown(grip); // arm the drag (grip-only)
    fireEvent.dragStart(cardA, { dataTransfer });
    fireEvent.dragOver(cardB, { dataTransfer, clientY: 5 });
    fireEvent.drop(cardB, { dataTransfer, clientY: 5 });

    // getBoundingClientRect is 0×0 in jsdom → drop resolves to "after" → [B, A]
    expect(sent).toHaveBeenCalledWith({ type: "reorder", order: ["B", "A"] });
  });

  it("does not arm a drag without the grip (card body is not draggable)", () => {
    const { container } = render(<App />);
    authed();
    host({ type: "tasks", filter: "mysprint", tasks: [mkTask({ key: "A" }), mkTask({ key: "B" })] });
    sent.mockClear();
    const cardA = container.querySelectorAll(".card")[0] as HTMLElement;
    const dataTransfer = { setData: vi.fn(), getData: vi.fn(), effectAllowed: "", dropEffect: "" };
    // dragStart without a preceding grip mousedown → preventDefault, no begin
    fireEvent.dragStart(cardA, { dataTransfer });
    expect(sent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "reorder" }));
  });
});
