// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as React from "react";
import { render, screen, fireEvent, act, within } from "@testing-library/react";

vi.mock("../../src/webview/vscodeApi", () => ({ send: vi.fn() }));

import { App } from "../../src/webview/App";
import { send } from "../../src/webview/vscodeApi";
import type { OutboundMessage } from "../../src/types";
import type { SerializedCaps } from "../../src/tasks/provider";
import { mkTask } from "../_helpers/factories";

const sent = vi.mocked(send);

/** Deliver a host→webview message the way the real postMessage bridge would. */
function host(msg: OutboundMessage) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data: msg }));
  });
}

const ALL_FILTERS = { size: true, status: true, repo: true, search: true };
// `state` carries the source's label and capabilities since the panel moved onto the
// connector seam. These are what the shipped Jira connector reports — the webview
// renders every optional affordance under them, so a fixture that understated them
// would hide controls these tests then couldn't find.
const JIRA_CAPS: SerializedCaps = {
  supportedFilters: ["unassigned", "mine", "mysprint", "sprint", "backlog", "all"],
  sizes: true, labels: true, sprints: true, components: true,
};
// Shape of what test/_helpers/fixtureConnector.ts's FixtureProvider actually
// serializes: no sprint-shaped lens, no per-task estimate, no labels/sprints/
// components at all. Used to prove the webview gates on capability, not on the
// source's name — the fixture's own FX-1 (Unassigned) and FX-2 (assigned to "Me",
// not in the open sprint) are the two shapes that reach App.tsx:683's
// `unassigned || (isMe && !task.inOpenSprint)`.
const FIXTURE_CAPS: SerializedCaps = {
  supportedFilters: ["mine", "all"],
  sizes: false, labels: false, sprints: false, components: false,
};
const authed = (prReviewStatus = "PR initiated", filters = ALL_FILTERS) =>
  host({ type: "state", sourceLabel: "Jira", caps: JIRA_CAPS, authed: true, configured: true, project: "ASM", me: "Jane", prReviewStatus, filters });

beforeEach(() => sent.mockClear());

describe("mount + auth gate", () => {
  it("announces readiness on mount", () => {
    render(<App />);
    expect(sent).toHaveBeenCalledWith({ type: "ready" });
  });

  it("shows the sign-in gate and wires the button when unauthenticated", () => {
    render(<App />);
    host({ type: "state", sourceLabel: "Jira", caps: JIRA_CAPS, authed: false, configured: true, project: "", me: null, prReviewStatus: "PR initiated", filters: ALL_FILTERS });
    const button = screen.getByRole("button", { name: /Sign in to Jira/i });
    fireEvent.click(button);
    expect(sent).toHaveBeenCalledWith({ type: "signIn" });
  });

  // The project name and the signed-in user moved to the VS Code view title bar
  // (tasksView.postState) — asserting they are ABSENT here is what stops the old
  // header from creeping back in beside the tabs.
  it("renders the task list, with the identity left to the view title bar", () => {
    render(<App />);
    authed();
    host({ type: "tasks", filter: "unassigned", tasks: [mkTask({ key: "ASM-1", summary: "Fix the bug" })] });
    expect(screen.getByText("ASM-1")).toBeInTheDocument();
    expect(screen.getByText("Fix the bug")).toBeInTheDocument();
    expect(screen.queryByText("Jane")).not.toBeInTheDocument();
    expect(document.querySelector(".header")).toBeNull();
  });

  it("keeps the gauge and Explore in the tab row on both tabs", () => {
    render(<App />);
    host({ type: "state", sourceLabel: "Jira", caps: JIRA_CAPS, authed: true, configured: true, project: "ASM", me: "Jane",
           prReviewStatus: "PR initiated", filters: ALL_FILTERS, liveCount: 2 });
    const trail = () => document.querySelector(".tabbar .tabbar-trail") as HTMLElement;
    expect(trail()).not.toBeNull();
    expect(within(trail()).getByRole("img", { name: "2 Agent Flow windows open" })).toBeInTheDocument();
    expect(within(trail()).getByRole("button", { name: /Explore/ })).toBeInTheDocument();

    // Explore starts a session on repos, not on a ticket, and the gauge counts open
    // windows — neither belongs to one tab, so both survive the switch to Notepad.
    fireEvent.click(screen.getByRole("tab", { name: "Notepad" }));
    expect(within(trail()).getByRole("img", { name: "2 Agent Flow windows open" })).toBeInTheDocument();
    expect(within(trail()).getByRole("button", { name: /Explore/ })).toBeInTheDocument();
  });

  it("puts the tab bar first, with nothing rendered before it", () => {
    const { container } = render(<App />);
    authed();
    host({ type: "tasks", filter: "unassigned", tasks: [mkTask({ key: "ASM-1", summary: "Fix the bug" })] });
    // The panel's own root element — App's top-level <div> — must open on the tab
    // bar now that the header above it is gone.
    const panelRoot = container.firstElementChild as HTMLElement;
    expect(panelRoot.firstElementChild).toHaveClass("tabbar");
  });

  it("falls back to the static mark when the host reports no count", () => {
    render(<App />);
    authed();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});

describe("problem indication", () => {
  it("shows a Connecting… indicator before any state arrives (never blank)", () => {
    render(<App />);
    expect(screen.getByText(/Connecting to Jira/i)).toBeInTheDocument();
  });

  it("shows a Run setup call-to-action when not configured", () => {
    render(<App />);
    host({ type: "state", sourceLabel: "Jira", caps: JIRA_CAPS, authed: false, configured: false, project: "", me: null, prReviewStatus: "PR initiated", filters: ALL_FILTERS });
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
    host({ type: "state", sourceLabel: "Jira", caps: JIRA_CAPS, authed: true, configured: true, project: "ASM", me: "Jane", prReviewStatus: "PR initiated", filters: ALL_FILTERS });
    expect(screen.queryByText(/boom/)).not.toBeInTheDocument();
  });

  it("offers Run Doctor on a gated failure and asks the host for it", () => {
    render(<App />);
    host({ type: "error", message: "Couldn't reach Jira", canRetry: true, canRunDoctor: true });
    fireEvent.click(screen.getByRole("button", { name: /Run Doctor/i }));
    expect(sent).toHaveBeenCalledWith({ type: "runDoctor" });
  });

  it("shows no Doctor button on a failure it can't diagnose", () => {
    render(<App />);
    host({ type: "error", message: "Agent Flow Deck isn't responding.", canRetry: true });
    expect(screen.queryByRole("button", { name: /Run Doctor/i })).not.toBeInTheDocument();
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

  it("exposes the filter lens as a pressed-state group", () => {
    render(<App />);
    authed();
    const mine = screen.getByRole("button", { name: "Mine" });
    expect(mine).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(mine);
    expect(sent).toHaveBeenCalledWith(expect.objectContaining({ type: "fetch", filter: "mine" }));
  });

  it("groups all three lenses for assistive tech", () => {
    render(<App />);
    authed();
    // The Status lens only renders once the pool has a status to show — deliver
    // that the way the neighbouring "status filter lens" tests do.
    host({ type: "tasks", filter: "mine", tasks: [mkTask({ key: "ASM-1", status: "To Do", statusCategory: "new" })] });
    for (const name of ["Task filter", "Size", "Status"]) {
      expect(screen.getByRole("group", { name })).toBeInTheDocument();
    }
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
  // The filter chips live in the Status segmented group — scope queries there so
  // they don't collide with the same-labelled status button on each card.
  const chip = (name: string) =>
    within(document.querySelector('[role="group"][aria-label="Status"]') as HTMLElement).getByRole("button", { name });

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
    expect(document.querySelector('[aria-label="Status"]')).toBeNull();
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
    expect(document.querySelector('[aria-label="Size"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Status"]')).not.toBeNull();
    expect(document.querySelector(".repo-select")).not.toBeNull();
  });

  it("hides the Size lens when filters.size is off, leaving the others", () => {
    render(<App />);
    authed("PR initiated", off({ size: false }));
    oneTask();
    expect(document.querySelector('[aria-label="Size"]')).toBeNull();
    expect(document.querySelector('[aria-label="Status"]')).not.toBeNull();
    expect(document.querySelector(".repo-select")).not.toBeNull();
  });

  it("hides the Status lens when filters.status is off, even with statuses present", () => {
    render(<App />);
    authed("PR initiated", off({ status: false }));
    oneTask();
    expect(document.querySelector('[aria-label="Status"]')).toBeNull();
    expect(document.querySelector('[aria-label="Size"]')).not.toBeNull();
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

  it("shows no checkboxes until at least one repo is filtered", () => {
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

  it("keeps checkboxes when a second repo is added, showing both repos' tasks", () => {
    render(<App />);
    authed();
    apiPool();
    // Open the popup ONCE and toggle two repos — re-clicking the trigger would close it.
    fireEvent.click(screen.getByText("Filter repos"));
    const repoList = document.querySelector(".repo-list") as HTMLElement;
    fireEvent.mouseDown(within(repoList).getByText("api").closest(".repo-opt")!);
    fireEvent.mouseDown(within(repoList).getByText("billing").closest(".repo-opt")!);
    expect(checks().length).toBe(3); // ASM-1, ASM-2 (api) + ASM-3 (billing)
  });

  it("launches the checked, visible tasks with the filtered repo name", () => {
    render(<App />);
    authed();
    apiPool();
    selectRepo("api");
    fireEvent.click(checks()[0]); // ASM-1
    fireEvent.click(checks()[1]); // ASM-2
    fireEvent.click(screen.getByRole("button", { name: /Launch in parallel/i }));
    expect(sent).toHaveBeenCalledWith({ type: "takeBatch", keys: ["ASM-1", "ASM-2"], repos: ["api"] });
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

  it("drops a checked task from the launch once a search filter hides it", () => {
    render(<App />);
    authed();
    host({
      type: "tasks",
      filter: "mine",
      tasks: [
        mkTask({ key: "ASM-1", summary: "alpha rate", services: ["api"] }),
        mkTask({ key: "ASM-2", summary: "beta cache", services: ["api"] }),
      ],
    });
    selectRepo("api");
    fireEvent.click(checks()[0]); // ASM-1
    fireEvent.click(checks()[1]); // ASM-2
    // Search narrows the visible list to ASM-1; ASM-2 is still checked in state but hidden.
    fireEvent.change(screen.getByPlaceholderText("Search title…"), { target: { value: "alpha" } });
    fireEvent.click(screen.getByRole("button", { name: /Launch in parallel/i }));
    expect(sent).toHaveBeenCalledWith({ type: "takeBatch", keys: ["ASM-1"], repos: ["api"] });
  });

  it("titles the launch button with a properly pluralised task count", () => {
    render(<App />);
    authed();
    apiPool();
    selectRepo("api");
    fireEvent.click(checks()[0]);
    const launch = () => screen.getByRole("button", { name: /Launch in parallel/i });
    expect(launch().title).toContain("Open 1 task across api");
    fireEvent.click(checks()[1]);
    expect(launch().title).toContain("Open 2 tasks across api");
  });

  it("sends every selected repo when two are filtered", () => {
    render(<App />);
    authed();
    apiPool();
    fireEvent.click(screen.getByText("Filter repos"));
    const repoList = document.querySelector(".repo-list") as HTMLElement;
    fireEvent.mouseDown(within(repoList).getByText("api").closest(".repo-opt")!);
    fireEvent.mouseDown(within(repoList).getByText("billing").closest(".repo-opt")!);
    fireEvent.click(checks()[0]); // ASM-1 (api)
    fireEvent.click(checks()[2]); // ASM-3 (billing)
    fireEvent.click(screen.getByRole("button", { name: /Launch in parallel/i }));
    expect(sent).toHaveBeenCalledWith({
      type: "takeBatch",
      keys: ["ASM-1", "ASM-3"],
      repos: ["api", "billing"],
    });
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

describe("notepad message routing", () => {
  // App.tsx's "notepad:notes" handler stores both the notes and whether the
  // host reports them as manually ordered — the latter drives Notepad's own
  // "Reset order" affordance. Nothing else in the suite posts this message,
  // so without this test the handler's two lines have no coverage at all.
  it("renders the notes and shows Reset order once the host reports a saved order", () => {
    render(<App />);
    authed();
    fireEvent.click(screen.getByRole("tab", { name: "Notepad" }));
    host({
      type: "notepad:notes",
      notes: [{ id: "n1", title: "Buy milk", body: "", done: false, createdAt: 1 }],
      ordered: true,
    });
    expect(screen.getByText("Buy milk")).toBeInTheDocument();
    expect(screen.getByText("Reset order")).toBeInTheDocument();
  });

  // Drives the flag through both directions rather than asserting against
  // React.useState(false)'s initial value: the previous version of this test
  // posted straight to `ordered: false` and passed even when the whole
  // handler was gutted, because the false-when-untouched initial state looks
  // identical to a genuinely-updated false. Going true → false first forces
  // the update to have happened at all.
  it("hides Reset order again once the host reports the order was reset", () => {
    render(<App />);
    authed();
    fireEvent.click(screen.getByRole("tab", { name: "Notepad" }));
    host({
      type: "notepad:notes",
      notes: [{ id: "n1", title: "Buy milk", body: "", done: false, createdAt: 1 }],
      ordered: true,
    });
    expect(screen.getByText("Reset order")).toBeInTheDocument();
    host({
      type: "notepad:notes",
      notes: [{ id: "n1", title: "Buy milk", body: "", done: false, createdAt: 1 }],
      ordered: false,
    });
    expect(screen.queryByText("Reset order")).not.toBeInTheDocument();
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

  it("keeps an error toast up past the auto-dismiss window", () => {
    render(<App />);
    host({ type: "toast", level: "error", message: "Couldn't update ASM-1. Resolution is required." });
    act(() => vi.advanceTimersByTime(30000));
    expect(screen.getByText("Couldn't update ASM-1. Resolution is required.")).toBeInTheDocument();
  });

  it("dismisses an error toast on click", () => {
    render(<App />);
    host({ type: "toast", level: "error", message: "Nope." });
    fireEvent.click(screen.getByText("Nope."));
    expect(screen.queryByText("Nope.")).not.toBeInTheDocument();
  });

  it("opens the ticket from the toast action without dismissing it", () => {
    render(<App />);
    host({
      type: "toast",
      level: "error",
      message: "Couldn't update ASM-1.",
      action: { label: "Open in Jira", url: "https://jira/browse/ASM-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open in Jira" }));
    expect(sent).toHaveBeenCalledWith({ type: "openExternal", url: "https://jira/browse/ASM-1" });
    expect(screen.getByText("Couldn't update ASM-1.")).toBeInTheDocument();
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

  it("marks a card with its ticket type", () => {
    withTask(mkTask({ key: "ASM-1", type: "Bug" }));
    expect(screen.getByRole("img", { name: "Type: Bug" })).toHaveClass("ty-bug");
  });

  // A project's own type still gets a marker, named for what the project calls it.
  it("marks a type it does not recognise, under the source's own name", () => {
    withTask(mkTask({ key: "ASM-1", type: "Spike" }));
    expect(screen.getByRole("img", { name: "Type: Spike" })).toHaveClass("ty-other");
  });

  it("still marks a task whose source named no type", () => {
    withTask(mkTask({ key: "ASM-1" }));
    expect(screen.getByRole("img", { name: "Type: unknown" })).toHaveClass("ty-other");
  });

  // Left of the key, and inside the top row — not floated into the action cluster.
  it("puts the marker before the key in the card's top row", () => {
    withTask(mkTask({ key: "ASM-1", summary: "Fix the bug", type: "Story", url: "https://jira/browse/ASM-1" }));
    const keyLink = screen.getByRole("link", { name: "ASM-1" });
    const top = keyLink.closest(".card-top")!;
    const marker = within(top as HTMLElement).getByRole("img", { name: "Type: Story" });
    expect(marker.compareDocumentPosition(keyLink)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("rails a card by its status category, not its priority", () => {
    render(<App />);
    authed();
    host({ type: "tasks", filter: "mine", tasks: [
      mkTask({ key: "ASM-1", summary: "Moving", statusCategory: "indeterminate", priority: "Highest" }),
      mkTask({ key: "ASM-2", summary: "Not started", statusCategory: "new", priority: "Low" }),
    ] });
    expect(screen.getByText("Moving").closest(".card")).toHaveClass("s-progress");
    expect(screen.getByText("Not started").closest(".card")).toHaveClass("s-new");
  });

  it("chips only the highest priority", () => {
    render(<App />);
    authed();
    host({ type: "tasks", filter: "mine", tasks: [
      mkTask({ key: "ASM-1", summary: "Urgent", priority: "Highest" }),
      mkTask({ key: "ASM-2", summary: "Ordinary", priority: "High" }),
    ] });
    expect(within(screen.getByText("Urgent").closest(".card")!).getByText("Highest")).toBeInTheDocument();
    expect(within(screen.getByText("Ordinary").closest(".card")!).queryByText("Highest")).not.toBeInTheDocument();
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

  it("shows Remove on the My sprint tab and sends removeFromSprint", () => {
    render(<App />);
    authed();
    host({ type: "tasks", filter: "mysprint", tasks: [mkTask({ key: "ASM-1", assignee: "Jane", inOpenSprint: true })] });
    fireEvent.click(screen.getByRole("button", { name: /Remove/i }));
    expect(sent).toHaveBeenCalledWith({ type: "removeFromSprint", key: "ASM-1", size: "any" });
  });

  it("keeps Remove reachable by name once its label goes", () => {
    render(<App />);
    authed();
    host({ type: "tasks", filter: "mysprint", tasks: [mkTask({ key: "ASM-1", summary: "In sprint" })] });
    const remove = screen.getByRole("button", { name: /Remove ASM-1 from your active sprint/i });
    expect(remove).toBeInTheDocument();
    expect(remove).toHaveTextContent("");
    expect(remove).toHaveAttribute("aria-label", expect.stringContaining("ASM-1"));
  });

  it("does not show Remove on other tabs", () => {
    render(<App />);
    authed();
    host({ type: "tasks", filter: "mine", tasks: [mkTask({ key: "ASM-1", assignee: "Jane", inOpenSprint: true })] });
    expect(screen.queryByRole("button", { name: /Remove/i })).not.toBeInTheDocument();
  });

  it("drops the card when removedFromSprint arrives", () => {
    render(<App />);
    authed();
    host({
      type: "tasks",
      filter: "mysprint",
      tasks: [mkTask({ key: "ASM-1", summary: "First card" }), mkTask({ key: "ASM-2", summary: "Second card" })],
    });
    host({ type: "removedFromSprint", key: "ASM-1" });
    expect(screen.queryByText("First card")).not.toBeInTheDocument();
    expect(screen.getByText("Second card")).toBeInTheDocument();
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
    // ~ marks it as inferred, matching the Deck's ~inferred convention.
    expect(screen.getByText("~centaur")).toBeInTheDocument();
  });

  it("shows ticket detail once it arrives", () => {
    withTask(mkTask({ key: "ASM-1", summary: "Fix bug" }));
    fireEvent.click(screen.getByText("Fix bug"));
    host({ type: "detail", key: "ASM-1", descriptionText: "The full description", inferred: [], repos: ["centaur"], sourceComponents: [], mappable: {} });
    expect(screen.getByText("The full description")).toBeInTheDocument();
  });

  /** Expand ASM-1 and deliver a detail. `sourceComponents` / `mappable` decide the
   *  chip states: account-service is on the ticket (A), pricing-api maps but is not
   *  on it (B), scratch-tool maps to nothing (C). `mappable` is checked for
   *  presence, not just truthiness — an explicit `null` (the unreadable-list case)
   *  must not fall back to the default map the way an omitted override would. */
  const withChips = (over: Partial<{ inferred: string[]; sourceComponents: string[]; mappable: Record<string, string> | null }> = {}) => {
    withTask(mkTask({ key: "ASM-1", summary: "Fix bug" }));
    fireEvent.click(screen.getByText("Fix bug"));
    host({
      type: "detail",
      key: "ASM-1",
      descriptionText: "desc",
      repos: ["account-service", "pricing-api", "scratch-tool", "centaur"],
      inferred: over.inferred ?? ["account-service", "pricing-api", "scratch-tool"],
      sourceComponents: over.sourceComponents ?? ["Account-Service"],
      mappable:
        "mappable" in over
          ? over.mappable ?? null
          : { "account-service": "Account-Service", "pricing-api": "Pricing-Api", centaur: "Centaur" },
    });
  };

  const chipFor = (name: string): HTMLElement =>
    [...document.querySelectorAll(".chips .chip")].find((c) => c.textContent?.startsWith(name)) as HTMLElement;

  it("renders a chip that is on the ticket as solid, with a Jira-removing × ", () => {
    withChips();
    const chip = chipFor("account-service");
    expect(chip.className).not.toContain("off-ticket");
    expect(chip).not.toHaveAttribute("title");
    expect(within(chip).getByTitle("Remove Account-Service from ASM-1")).toBeInTheDocument();
    expect(within(chip).queryByText("↑")).not.toBeInTheDocument();
  });

  it("renders a mappable chip that is not on the ticket as dashed", () => {
    withChips();
    const chip = chipFor("pricing-api");
    expect(chip.className).toContain("off-ticket");
    expect(chip).toHaveAttribute("title", "Not on ASM-1 in Jira — ↑ adds it");
    // The × is local-only here: there is no component on the ticket to remove.
    expect(within(chip).getByTitle("Remove")).toBeInTheDocument();
  });

  it("renders an unmappable chip as dashed with no push, and says why", () => {
    withChips();
    const chip = chipFor("scratch-tool");
    expect(chip.className).toContain("off-ticket");
    expect(chip).toHaveAttribute("title", "No ASM component named “scratch-tool” — this selection stays local");
    expect(within(chip).queryByText("↑")).not.toBeInTheDocument();
    expect(within(chip).getByTitle("Remove")).toBeInTheDocument();
  });

  // mappable: null means the project's component list couldn't be read — no chip
  // state (on-ticket, pushable, local-only) can be claimed, so every chip must fall
  // back to its plain, neutral appearance rather than asserting any of the three.
  it("renders every chip plain (no off-ticket, no ↑) when the component list couldn't be read", () => {
    withChips({ mappable: null });
    for (const name of ["account-service", "pricing-api", "scratch-tool"]) {
      const chip = chipFor(name);
      expect(chip.className).not.toContain("off-ticket");
      expect(chip).toHaveAttribute("title", "Couldn't read ASM's components — can't tell which are on ASM-1");
      expect(within(chip).queryByText("↑")).not.toBeInTheDocument();
    }
    sent.mockClear();
    fireEvent.click(within(chipFor("account-service")).getByTitle("Remove"));
    expect(sent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "setComponent" }));
  });

  it("collapsed service chips follow the edited list, not the original guess", () => {
    withChips({ inferred: ["pricing-api"] });
    fireEvent.click(screen.getByText("Fix bug")); // collapse
    const meta = document.querySelector(".meta") as HTMLElement;
    // The ~ prefix marks it as inferred, matching the Deck's ~inferred convention.
    expect(within(meta).getByText("~pricing-api")).toBeInTheDocument();
  });

  /** Add a repo the way a user does: open the RepoPicker, filter to one match,
   *  press Enter. Its rows commit on mouseDown rather than click, so filtering and
   *  Enter is both simpler and closer to real use. */
  const pick = (repo: string) => {
    fireEvent.click(screen.getByText(/add repo/i));
    const input = screen.getByPlaceholderText(/Filter repos/i);
    fireEvent.change(input, { target: { value: repo } });
    fireEvent.keyDown(input, { key: "Enter" });
  };

  it("writes an add when a mappable repo is picked, moving the chip too", () => {
    withChips();
    sent.mockClear();
    pick("centaur");
    expect(sent).toHaveBeenCalledWith({ type: "setComponent", key: "ASM-1", repo: "centaur", on: true, movedChip: true });
    // Optimistic: the new chip is already solid, before any verdict.
    expect(chipFor("centaur").className).not.toContain("off-ticket");
  });

  it("sends nothing when an unmappable repo is picked, and marks it local-only", () => {
    withChips({ inferred: [], mappable: { centaur: "Centaur" } });
    sent.mockClear();
    pick("scratch-tool");
    expect(sent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "setComponent" }));
    expect(chipFor("scratch-tool").className).toContain("off-ticket");
  });

  it("pushes a state-B chip without moving it, and shows it solid at once", () => {
    withChips();
    sent.mockClear();
    fireEvent.click(within(chipFor("pricing-api")).getByTitle("Add Pricing-Api to ASM-1"));
    expect(sent).toHaveBeenCalledWith({ type: "setComponent", key: "ASM-1", repo: "pricing-api", on: true, movedChip: false });
    expect(chipFor("pricing-api").className).not.toContain("off-ticket");
  });

  it("writes a remove when a state-A chip is dismissed", () => {
    withChips();
    sent.mockClear();
    fireEvent.click(within(chipFor("account-service")).getByTitle("Remove Account-Service from ASM-1"));
    expect(sent).toHaveBeenCalledWith({ type: "setComponent", key: "ASM-1", repo: "account-service", on: false, movedChip: true });
    expect(chipFor("account-service")).toBeUndefined();
  });

  it("sends nothing when a state-B or state-C chip is dismissed", () => {
    withChips();
    sent.mockClear();
    fireEvent.click(within(chipFor("pricing-api")).getByTitle("Remove"));
    fireEvent.click(within(chipFor("scratch-tool")).getByTitle("Remove"));
    expect(sent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "setComponent" }));
    expect(chipFor("pricing-api")).toBeUndefined();
    expect(chipFor("scratch-tool")).toBeUndefined();
  });

  it("keeps the optimistic state when the host reports ok", () => {
    withChips();
    fireEvent.click(within(chipFor("pricing-api")).getByTitle("Add Pricing-Api to ASM-1"));
    host({ type: "componentsChanged", key: "ASM-1", repo: "pricing-api", on: true, movedChip: false, ok: true });
    expect(chipFor("pricing-api").className).not.toContain("off-ticket");
  });

  it("undoes a rejected push — the chip goes dashed again but stays in the list", () => {
    withChips();
    fireEvent.click(within(chipFor("pricing-api")).getByTitle("Add Pricing-Api to ASM-1"));
    host({ type: "componentsChanged", key: "ASM-1", repo: "pricing-api", on: true, movedChip: false, ok: false });
    expect(chipFor("pricing-api").className).toContain("off-ticket");
  });

  it("undoes a rejected picker add — the chip disappears again", () => {
    withChips();
    pick("centaur");
    host({ type: "componentsChanged", key: "ASM-1", repo: "centaur", on: true, movedChip: true, ok: false });
    expect(chipFor("centaur")).toBeUndefined();
  });

  it("undoes a rejected remove — the chip comes back solid", () => {
    withChips();
    fireEvent.click(within(chipFor("account-service")).getByTitle("Remove Account-Service from ASM-1"));
    host({ type: "componentsChanged", key: "ASM-1", repo: "account-service", on: false, movedChip: true, ok: false });
    expect(chipFor("account-service")).toBeDefined();
    expect(chipFor("account-service").className).not.toContain("off-ticket");
  });

  it("ignores a verdict for a ticket with no loaded detail", () => {
    withChips();
    expect(() =>
      host({ type: "componentsChanged", key: "ASM-99", repo: "centaur", on: true, movedChip: true, ok: false }),
    ).not.toThrow();
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

describe("capability gating", () => {
  const fixtureState = (over: Partial<{ me: string | null; filters: typeof ALL_FILTERS }> = {}) =>
    host({
      type: "state", sourceLabel: "Fixture", caps: FIXTURE_CAPS, authed: true, configured: true,
      project: "FX", me: over.me ?? "Me", prReviewStatus: "", filters: over.filters ?? ALL_FILTERS,
    });

  // `Task.inOpenSprint` is a required boolean, so a source with no sprint concept
  // has to report `false` — which makes `unassigned || (isMe && !task.inOpenSprint)`
  // (App.tsx:683) true and would render a button with no working action behind it.
  // FX-2 (assigned to "Me", inOpenSprint: false) and FX-1 (Unassigned) are the two
  // fixture tasks built to exercise exactly that, per test/_helpers/fixtureConnector.ts.
  describe("sprint actions", () => {
    it("shows no Add-to-my-sprint for a Me-assigned task not in the open sprint, on a source with no sprints (FX-2 shape)", () => {
      render(<App />);
      fixtureState();
      host({ type: "tasks", filter: "mine", tasks: [mkTask({ key: "FX-2", summary: "Second fixture task", assignee: "Me", inOpenSprint: false })] });
      expect(screen.queryByRole("button", { name: /Add to my sprint/i })).not.toBeInTheDocument();
    });

    it("shows no Add-to-my-sprint for an unassigned task either, on a source with no sprints (FX-1 shape)", () => {
      render(<App />);
      fixtureState();
      host({ type: "tasks", filter: "mine", tasks: [mkTask({ key: "FX-1", summary: "First fixture task", assignee: "Unassigned" })] });
      expect(screen.queryByRole("button", { name: /Add to my sprint/i })).not.toBeInTheDocument();
    });

    it("shows no Remove-from-sprint action on a source with no sprints, even on the mysprint lens", () => {
      render(<App />);
      fixtureState();
      host({ type: "tasks", filter: "mysprint", tasks: [mkTask({ key: "FX-2", assignee: "Me", inOpenSprint: true })] });
      expect(screen.queryByRole("button", { name: /Remove/i })).not.toBeInTheDocument();
    });
  });

  it("hides the Size control on a source that reports no per-task estimate", () => {
    render(<App />);
    fixtureState();
    host({ type: "tasks", filter: "mine", tasks: [mkTask({ key: "FX-2", assignee: "Me" })] });
    expect(document.querySelector('[aria-label="Size"]')).toBeNull();
  });

  // Which repos a task touches is what `take` sends as `services` — core function,
  // and inferred from summary/description/labels as much as from components. It must
  // survive a source with no components: the chips are the only place an expanded card
  // shows the selection (the collapsed ~chips are hidden while open), and the picker is
  // the only place it can be edited. Only the component-derived state on a chip needs
  // the capability.
  it("still shows the repo selection and its picker on a source with no components", () => {
    render(<App />);
    fixtureState();
    host({ type: "tasks", filter: "mine", tasks: [mkTask({ key: "FX-1", summary: "First fixture task" })] });
    fireEvent.click(screen.getByText("First fixture task"));
    host({
      type: "detail", key: "FX-1", descriptionText: "A fixture task.", inferred: ["centaur"],
      repos: ["centaur", "pricing-api"], sourceComponents: [], mappable: null,
    });

    expect(screen.getByText("Repos this task touches")).toBeInTheDocument();
    expect(screen.getByText(/add repo/i)).toBeInTheDocument();
    const chip = [...document.querySelectorAll(".chips .chip")].find((c) => c.textContent?.startsWith("centaur")) as HTMLElement;
    // Plain: no dashed "not on the ticket" state, no push affordance, and no title
    // blaming an unreadable component list for a capability the source never had.
    expect(chip.className).not.toContain("off-ticket");
    expect(chip).not.toHaveAttribute("title");
    expect(within(chip).queryByText("↑")).not.toBeInTheDocument();
    // …and the selection is still editable: removing sends no component write.
    sent.mockClear();
    fireEvent.click(within(chip).getByTitle("Remove"));
    expect(sent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "setComponent" }));
    expect(document.querySelector(".chips .chip")).toBeNull();
  });

  describe("tab bar", () => {
    // The fixture's own supportedFilters is ["mine", "all"] (test/_helpers/
    // fixtureConnector.ts) — but "all" has never been a rendered tab (see
    // FILTER_ORDER's comment in helpers.ts: it is the JQL fallback default, not a
    // UI tab the pre-seam FILTERS array, agentFlow.defaultFilter's manifest enum,
    // or DEFAULT_FILTER_VALUES ever exposed). So this renders as a single tab, and
    // it must still be a genuinely usable one — active by default, and wired.
    it("renders only the tabs the source supports and the UI has ever shown, never a tab for 'all'", () => {
      render(<App />);
      fixtureState();
      const group = document.querySelector('[role="group"][aria-label="Task filter"]') as HTMLElement;
      const buttons = within(group).getAllByRole("button");
      expect(buttons.map((b) => b.textContent)).toEqual(["Mine"]);
      expect(buttons[0]).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(buttons[0]);
      expect(sent).toHaveBeenCalledWith({ type: "fetch", filter: "mine", size: "any" });
    });

    it("highlights a supported tab as active even when the configured default (My sprint) is not supported", () => {
      render(<App />);
      fixtureState();
      // No `tasks` message has arrived yet — this is the pre-fetch render, where
      // `filter` state is still the hardcoded "mysprint" default. Without routing
      // the active tab through `effectiveFilter`, no rendered tab would be pressed.
      const mine = screen.getByRole("button", { name: "Mine" });
      expect(mine).toHaveAttribute("aria-pressed", "true");
    });
  });

  it("names the configured source on the ticket-open title and the off-ticket chip title, not Jira", () => {
    render(<App />);
    host({
      type: "state", sourceLabel: "Acme", caps: JIRA_CAPS, authed: true, configured: true,
      project: "ASM", me: "Jane", prReviewStatus: "PR initiated", filters: ALL_FILTERS,
    });
    host({ type: "tasks", filter: "mine", tasks: [mkTask({ key: "ASM-1", summary: "Fix bug" })] });
    expect(screen.getByText("ASM-1")).toHaveAttribute("title", "Open in Acme");
    fireEvent.click(screen.getByText("Fix bug"));
    host({
      type: "detail", key: "ASM-1", descriptionText: "desc", repos: ["pricing-api"],
      inferred: ["pricing-api"], sourceComponents: [], mappable: { "pricing-api": "Pricing-Api" },
    });
    const chip = [...document.querySelectorAll(".chips .chip")].find((c) => c.textContent?.startsWith("pricing-api")) as HTMLElement;
    expect(chip).toHaveAttribute("title", "Not on ASM-1 in Acme — ↑ adds it");
  });

  it("names the configured source on every gate screen, not Jira", () => {
    render(<App />);
    host({ type: "state", sourceLabel: "Fixture", caps: FIXTURE_CAPS, authed: false, configured: false, project: "", me: null, prReviewStatus: "", filters: ALL_FILTERS });
    expect(screen.getByText(
      "Agent Flow Deck isn't connected to Fixture yet — add your site URL and project to get started.",
    )).toBeInTheDocument();
    host({ type: "state", sourceLabel: "Fixture", caps: FIXTURE_CAPS, authed: false, configured: true, project: "FX", me: null, prReviewStatus: "", filters: ALL_FILTERS });
    expect(screen.getByText("Connect Agent Flow Deck to your Fixture to see your task pool.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in to Fixture" })).toBeInTheDocument();
  });
});
