// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";

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

const authed = () => host({ type: "state", authed: true, project: "ASM", me: "Jane" });

beforeEach(() => sent.mockClear());

describe("mount + auth gate", () => {
  it("announces readiness on mount", () => {
    render(<App />);
    expect(sent).toHaveBeenCalledWith({ type: "ready" });
  });

  it("shows the sign-in gate and wires the button when unauthenticated", () => {
    render(<App />);
    host({ type: "state", authed: false, project: "", me: null });
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
    expect(screen.getByText(/In Progress/)).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: /To Do/ }));
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
