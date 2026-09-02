// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import * as React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkflowList, type WorkflowRow } from "../../src/webview/WorkflowList";
import type { Flow, FlowNode } from "../../src/engine/orchestrator/model";
import type { CardWorkflow, WorkflowStatus } from "../../src/engine/orchestrator/attach";

const notify = (id: string): FlowNode => ({ id, x: 0, y: 0, join: "any", kind: "notify", message: "" });

const wf = (name: string, status: WorkflowStatus, done = 1, total = 2): CardWorkflow => ({
  flow: { id: `f-${name}`, name, armed: true, createdAt: 0, nodes: [notify("n1")], edges: [] } as Flow,
  state: { status, done, total, steps: [] },
  extraCount: 0,
});

const row = (cardId: string, ticketKey: string, title: string, w: CardWorkflow): WorkflowRow =>
  ({ cardId, ticketKey, title, workflow: w });

describe("WorkflowList", () => {
  it("renders one row per card, in the order given", () => {
    render(<WorkflowList onOpen={() => {}} rows={[
      row("c1", "PROJ-1", "First thing", wf("Ship it", "waiting-on-you")),
      row("c2", "PROJ-2", "Second thing", wf("Test & merge", "stopped")),
    ]} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("PROJ-1");
    expect(items[1]).toHaveTextContent("PROJ-2");
  });

  it("names the workflow each card carries", () => {
    render(<WorkflowList onOpen={() => {}} rows={[
      row("c1", "PROJ-1", "First thing", wf("Ship it", "advancing")),
    ]} />);
    expect(screen.getByText("Ship it")).toBeTruthy();
  });

  it("says how far along a workflow is", () => {
    render(<WorkflowList onOpen={() => {}} rows={[
      row("c1", "PROJ-1", "x", wf("Ship it", "advancing", 2, 5)),
    ]} />);
    expect(screen.getByText(/2 of 5/)).toBeTruthy();
  });

  it("marks a status on each row for the stylesheet to hue", () => {
    // The hue itself is a token and is asserted as COMPUTED COLOUR in a
    // Playwright CT spec (Task 15) -- a class assertion here would stay green
    // with the token pointing at the wrong hue. This only pins that the status
    // reaches the DOM at all.
    render(<WorkflowList onOpen={() => {}} rows={[
      row("c1", "PROJ-1", "x", wf("Ship it", "stopped")),
    ]} />);
    expect(screen.getByRole("listitem").getAttribute("data-status")).toBe("stopped");
  });

  it("shows the humanized status label, not the raw status string", () => {
    // Pins the reuse decision this task was built around: the chip must show
    // WorkflowBlock's own STATUS_LABEL wording ("waiting on you"), never the
    // raw WorkflowStatus id ("waiting-on-you") a careless rewrite could print
    // instead. data-status on the <li> is a separate hook for the stylesheet
    // and is asserted elsewhere -- this is the one test on the VISIBLE text.
    render(<WorkflowList onOpen={() => {}} rows={[
      row("c1", "PROJ-1", "x", wf("Ship it", "waiting-on-you")),
    ]} />);
    expect(screen.getByText("waiting on you")).toBeTruthy();
    expect(screen.queryByText("waiting-on-you")).toBeNull();
  });

  it("opens the card the row belongs to", async () => {
    const onOpen = vi.fn();
    render(<WorkflowList onOpen={onOpen} rows={[
      row("c7", "PROJ-9", "x", wf("Ship it", "done")),
    ]} />);
    await userEvent.click(screen.getByRole("button", { name: /PROJ-9/ }));
    expect(onOpen).toHaveBeenCalledWith("c7");
  });

  it("says so when nothing is attached anywhere", () => {
    render(<WorkflowList onOpen={() => {}} rows={[]} />);
    expect(screen.getByText(/no workflows attached/i)).toBeTruthy();
  });

  it("does not sort -- the caller owns order", () => {
    // Pinning the contract, not the behaviour: a future edit that adds a sort
    // here would make the board and this list disagree about precedence.
    render(<WorkflowList onOpen={() => {}} rows={[
      row("c1", "PROJ-1", "x", wf("A", "done")),
      row("c2", "PROJ-2", "x", wf("B", "stopped")),
    ]} />);
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("PROJ-1");
  });
});
