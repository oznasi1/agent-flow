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

const authed = (prReviewStatus = "PR initiated") =>
  host({ type: "state", authed: true, configured: true, project: "ASM", me: "Jane", prReviewStatus });

beforeEach(() => sent.mockClear());

describe("mount + auth gate", () => {
  it("announces readiness on mount", () => {
    render(<App />);
    expect(sent).toHaveBeenCalledWith({ type: "ready" });
  });

  it("shows the sign-in gate and wires the button when unauthenticated", () => {
    render(<App />);
    host({ type: "state", authed: false, configured: true, project: "", me: null, prReviewStatus: "PR initiated" });
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
    host({ type: "state", authed: false, configured: false, project: "", me: null, prReviewStatus: "PR initiated" });
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
    host({ type: "state", authed: true, configured: true, project: "ASM", me: "Jane", prReviewStatus: "PR initiated" });
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

  it("shows a Review PR button on a card in the configured PR-review status", () => {
    withTask(mkTask({ key: "ASM-9", status: "PR initiated", statusCategory: "indeterminate" }));
    expect(screen.getByRole("button", { name: /Review PR/i })).toBeInTheDocument();
  });

  it("kicks off a PR review with the task key when clicked", () => {
    withTask(mkTask({ key: "ASM-9", status: "PR initiated", statusCategory: "indeterminate" }));
    fireEvent.click(screen.getByRole("button", { name: /Review PR/i }));
    expect(sent).toHaveBeenCalledWith({ type: "reviewPr", key: "ASM-9", services: undefined });
  });

  it("hides the Review PR button when the status does not match", () => {
    withTask(mkTask({ key: "ASM-9", status: "In Progress", statusCategory: "indeterminate" }));
    expect(screen.queryByRole("button", { name: /Review PR/i })).not.toBeInTheDocument();
  });

  it("honors a custom PR-review status, matched case-insensitively", () => {
    render(<App />);
    authed("PR Approved");
    host({ type: "tasks", filter: "mine", tasks: [mkTask({ key: "ASM-9", status: "pr approved", statusCategory: "indeterminate" })] });
    expect(screen.getByRole("button", { name: /Review PR/i })).toBeInTheDocument();
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
