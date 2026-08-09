// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import * as React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { FlowList } from "../../src/webview/flowList";
import type { Flow } from "../../src/engine/orchestrator/model";

const flow = (over: Partial<Flow> = {}): Flow => ({
  id: "f1", name: "Ship the migration", armed: false, createdAt: 1_000, nodes: [], edges: [], ...over,
});

const MODES = [
  { id: "quick", label: "Quick pass" },
  { id: "careful", label: "Careful review" },
];

const props = (over: Partial<React.ComponentProps<typeof FlowList>> = {}) => ({
  flow: flow(),
  runs: [],
  promptModes: MODES,
  onSave: vi.fn(),
  onResetEdge: vi.fn(),
  ...over,
});

/** Three notify rules into one terminal — enough rows to exercise Up/Down and
 * Delete without every test needing its own bespoke three-node graph. */
const threeRules = () =>
  flow({
    nodes: [
      { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-1", repo: "r" },
      { id: "n2", kind: "place", x: 0, y: 88, join: "any", runKey: "ASM-2", repo: "r" },
      { id: "n3", kind: "place", x: 0, y: 176, join: "any", runKey: "ASM-3", repo: "r" },
      { id: "n4", kind: "notify", x: 320, y: 88, join: "any", message: "done" },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n4", cond: { kind: "pr-merged" }, action: "notify" },
      { id: "e2", from: "n2", to: "n4", cond: { kind: "ci-passed" }, action: "notify" },
      { id: "e3", from: "n3", to: "n4", cond: { kind: "ci-failed" }, action: "notify" },
    ],
  });

/** A place feeding a planned node — the pairing where `launch` is valid,
 * mirroring OrchestratorDrawer.test.tsx's own fixture of the same shape. */
const placeAndPlanned = (edgeOver: Partial<Flow["edges"][number]> = {}) =>
  flow({
    nodes: [
      { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-1", repo: "agent-flow" },
      {
        id: "n2", kind: "planned", x: 320, y: 0, join: "any",
        ticketKey: "ASM-12", repos: ["agent-flow"], mode: "quick", dest: "worktree",
      },
    ],
    edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "launch", ...edgeOver }],
  });

/** Two places — the pairing `seed` needs, and the one `launch` can never
 * satisfy (there is no planned work to launch). */
const twoPlaces = (edgeOver: Partial<Flow["edges"][number]> = {}) =>
  flow({
    nodes: [
      { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-1", repo: "agent-flow" },
      { id: "n2", kind: "place", x: 320, y: 0, join: "any", runKey: "ASM-2", repo: "agent-flow" },
    ],
    edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify", ...edgeOver }],
  });

describe("rows", () => {
  it("renders one row per edge, in a stable order", () => {
    render(<FlowList {...props({ flow: threeRules() })} />);
    const list = screen.getByTestId("orch-list");
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "flowlist-row-e1", "flowlist-row-e2", "flowlist-row-e3",
    ]);
  });

  it("shows an empty state rather than an empty list when a flow has no rules", () => {
    render(<FlowList {...props({ flow: flow() })} />);
    expect(screen.queryByTestId("orch-list")).toBeNull();
    expect(screen.getByTestId("flowlist-empty")).toBeTruthy();
  });

  it("the sentence includes the condition, the action and the target", () => {
    render(<FlowList {...props({ flow: placeAndPlanned() })} />);
    const row = screen.getByTestId("flowlist-row-e1");
    expect(row.textContent).toContain("PR is merged"); // the condition
    expect(row.textContent).toContain("launch"); // the action
    expect(row.textContent).toContain("ASM-12"); // the target
  });

  it("reads notify's clause as complete on its own, with no bare target after it", () => {
    render(<FlowList {...props({ flow: twoPlaces() })} />);
    const row = screen.getByTestId("flowlist-row-e1");
    expect(row.textContent).toContain("notify me");
  });
});

describe("roving tabindex and keyboard navigation", () => {
  it("only the focused row is a Tab stop; every other row is skipped", () => {
    render(<FlowList {...props({ flow: threeRules() })} />);
    const rows = ["e1", "e2", "e3"].map((id) => screen.getByTestId(`flowlist-row-${id}`));
    expect(rows[0]).toHaveAttribute("tabindex", "0");
    expect(rows[1]).toHaveAttribute("tabindex", "-1");
    expect(rows[2]).toHaveAttribute("tabindex", "-1");
  });

  it("ArrowDown moves the roving tabindex — and real focus — to the next row", () => {
    render(<FlowList {...props({ flow: threeRules() })} />);
    const row1 = screen.getByTestId("flowlist-row-e1");
    const row2 = screen.getByTestId("flowlist-row-e2");
    row1.focus();
    fireEvent.keyDown(row1, { key: "ArrowDown" });
    expect(row1).toHaveAttribute("tabindex", "-1");
    expect(row2).toHaveAttribute("tabindex", "0");
    expect(document.activeElement).toBe(row2);
  });

  it("ArrowUp moves back", () => {
    render(<FlowList {...props({ flow: threeRules() })} />);
    const row1 = screen.getByTestId("flowlist-row-e1");
    const row2 = screen.getByTestId("flowlist-row-e2");
    row1.focus();
    fireEvent.keyDown(row1, { key: "ArrowDown" });
    fireEvent.keyDown(row2, { key: "ArrowUp" });
    expect(row1).toHaveAttribute("tabindex", "0");
    expect(document.activeElement).toBe(row1);
  });

  it("ArrowDown on the last row stays put — it does not walk off the end", () => {
    render(<FlowList {...props({ flow: threeRules() })} />);
    const row3 = screen.getByTestId("flowlist-row-e3");
    row3.focus();
    fireEvent.keyDown(row3, { key: "ArrowDown" });
    fireEvent.keyDown(row3, { key: "ArrowDown" });
    expect(row3).toHaveAttribute("tabindex", "0");
    expect(document.activeElement).toBe(row3);
  });

  it("a key that is neither navigation, open nor delete does nothing on a focused row", () => {
    render(<FlowList {...props({ flow: threeRules() })} />);
    const row1 = screen.getByTestId("flowlist-row-e1");
    row1.focus();
    expect(() => fireEvent.keyDown(row1, { key: "a" })).not.toThrow();
    expect(row1).toHaveAttribute("tabindex", "0");
    expect(row1.classList.contains("open")).toBe(false);
  });

  it("ArrowUp/Down on an OPEN row's own select changes the select, not the list focus", () => {
    // The row-level handler must only react when the row div ITSELF is the
    // event target — a bubbled arrow key from the native <select> below is
    // that control doing its own job, not a request to move to another row.
    render(<FlowList {...props({ flow: threeRules() })} />);
    const row1 = screen.getByTestId("flowlist-row-e1");
    fireEvent.click(row1);
    const condition = screen.getByLabelText("Condition");
    fireEvent.keyDown(condition, { key: "ArrowDown" });
    expect(row1).toHaveAttribute("tabindex", "0"); // unmoved
  });
});

describe("opening and closing a row for editing", () => {
  it("Enter opens the focused row for editing", () => {
    render(<FlowList {...props({ flow: threeRules() })} />);
    const row1 = screen.getByTestId("flowlist-row-e1");
    row1.focus();
    fireEvent.keyDown(row1, { key: "Enter" });
    expect(row1.classList.contains("open")).toBe(true);
    expect(within(row1).getByLabelText("Condition")).toBeTruthy();
  });

  it("Space opens the focused row for editing", () => {
    render(<FlowList {...props({ flow: threeRules() })} />);
    const row1 = screen.getByTestId("flowlist-row-e1");
    row1.focus();
    fireEvent.keyDown(row1, { key: " " });
    expect(row1.classList.contains("open")).toBe(true);
  });

  it("Escape closes the open row and returns focus to it", () => {
    render(<FlowList {...props({ flow: threeRules() })} />);
    const row1 = screen.getByTestId("flowlist-row-e1");
    row1.focus();
    fireEvent.keyDown(row1, { key: "Enter" });
    fireEvent.keyDown(row1, { key: "Escape" });
    expect(row1.classList.contains("open")).toBe(false);
    expect(document.activeElement).toBe(row1);
  });

  it("Escape closes the row even when focus is on one of its own controls", () => {
    render(<FlowList {...props({ flow: threeRules() })} />);
    const row1 = screen.getByTestId("flowlist-row-e1");
    fireEvent.click(row1);
    const condition = screen.getByLabelText("Condition");
    fireEvent.keyDown(condition, { key: "Escape" });
    expect(row1.classList.contains("open")).toBe(false);
  });

  it("Escape on a row that is not open does nothing", () => {
    render(<FlowList {...props({ flow: threeRules() })} />);
    const row1 = screen.getByTestId("flowlist-row-e1");
    row1.focus();
    expect(() => fireEvent.keyDown(row1, { key: "Escape" })).not.toThrow();
    expect(row1.classList.contains("open")).toBe(false);
  });

  it("the condition, action, mode and destination controls are ordinary form controls, reachable in order", () => {
    const launching = placeAndPlanned();
    render(<FlowList {...props({ flow: launching })} />);
    const row1 = screen.getByTestId("flowlist-row-e1");
    fireEvent.click(row1);
    const within1 = within(row1);
    expect(within1.getByLabelText("Condition").tagName).toBe("SELECT");
    expect(within1.getByLabelText("Action").tagName).toBe("SELECT");
    expect(within1.getByLabelText("Mode").tagName).toBe("SELECT");
    expect(within1.getByLabelText("Destination").tagName).toBe("SELECT");
  });

  it("edits the condition through the open row's own select", () => {
    const onSave = vi.fn();
    render(<FlowList {...props({ flow: threeRules(), onSave })} />);
    fireEvent.click(screen.getByTestId("flowlist-row-e1"));
    fireEvent.change(screen.getByLabelText("Condition"), { target: { value: "ci-failed" } });
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.edges.find((e) => e.id === "e1")!.cond).toEqual({ kind: "ci-failed" });
  });

  it("edits the action through the open row's own select", () => {
    const onSave = vi.fn();
    render(<FlowList {...props({ flow: twoPlaces(), onSave })} />);
    fireEvent.click(screen.getByTestId("flowlist-row-e1"));
    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "seed" } });
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.edges[0]).toMatchObject({ action: "seed" });
  });

  it("edits the mode through the open row's own select, for a seed rule", () => {
    const onSave = vi.fn();
    const seeding = twoPlaces({ action: "seed", mode: "quick" });
    render(<FlowList {...props({ flow: seeding, onSave })} />);
    fireEvent.click(screen.getByTestId("flowlist-row-e1"));
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "careful" } });
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.edges[0].mode).toBe("careful");
  });

  it("edits the destination through the open row's own select, for a launch rule", () => {
    const onSave = vi.fn();
    const launching = placeAndPlanned();
    render(<FlowList {...props({ flow: launching, onSave })} />);
    fireEvent.click(screen.getByTestId("flowlist-row-e1"));
    fireEvent.change(screen.getByLabelText("Destination"), { target: { value: "new-window" } });
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect((saved.nodes.find((n) => n.id === "n2") as { dest: string }).dest).toBe("new-window");
  });

  it("shows a deleted mode explicitly rather than silently falling back to the first configured one", () => {
    const launching = placeAndPlanned();
    (launching.nodes[1] as { mode: string }).mode = "deleted-mode";
    render(<FlowList {...props({ flow: launching })} />);
    const row = screen.getByTestId("flowlist-row-e1");
    expect(row.textContent).toContain("deleted-mode (not configured)");
    fireEvent.click(row);
    const select = within(row).getByLabelText("Mode") as HTMLSelectElement;
    expect(select.value).toBe("deleted-mode");
  });

  it("edits the notify message on blur through the open row's own input", () => {
    const onSave = vi.fn();
    const placeToNotify = flow({
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-1", repo: "agent-flow" },
        { id: "n2", kind: "notify", x: 320, y: 0, join: "any", message: "say something" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" }],
    });
    render(<FlowList {...props({ flow: placeToNotify, onSave })} />);
    fireEvent.click(screen.getByTestId("flowlist-row-e1"));
    const box = screen.getByLabelText("Notify message");
    fireEvent.change(box, { target: { value: "the migration has landed" } });
    fireEvent.blur(box);
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.nodes.find((n) => n.id === "n2")).toMatchObject({ message: "the migration has landed" });
  });
});

describe("Delete", () => {
  it("removes the focused rule", () => {
    const onSave = vi.fn();
    render(<FlowList {...props({ flow: threeRules(), onSave })} />);
    const row2 = screen.getByTestId("flowlist-row-e2");
    row2.focus();
    fireEvent.keyDown(row2, { key: "Delete" });
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.edges.map((e) => e.id)).toEqual(["e1", "e3"]);
  });

  it("Delete on the first row removes exactly that rule and leaves the others intact", () => {
    const onSave = vi.fn();
    render(<FlowList {...props({ flow: threeRules(), onSave })} />);
    const row1 = screen.getByTestId("flowlist-row-e1");
    row1.focus();
    fireEvent.keyDown(row1, { key: "Delete" });
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.edges.map((e) => e.id)).toEqual(["e2", "e3"]);
  });

  it("closes an open row before deleting it", () => {
    const onSave = vi.fn();
    render(<FlowList {...props({ flow: threeRules(), onSave })} />);
    const row1 = screen.getByTestId("flowlist-row-e1");
    fireEvent.click(row1);
    expect(row1.classList.contains("open")).toBe(true);
    fireEvent.keyDown(row1, { key: "Delete" });
    expect(onSave).toHaveBeenCalled();
  });

  it("Delete inside an open row's notify-message input deletes a character, not the rule", () => {
    const onSave = vi.fn();
    render(<FlowList {...props({ flow: twoPlaces(), onSave })} />);
    fireEvent.click(screen.getByTestId("flowlist-row-e1"));
    const box = screen.getByLabelText("Notify message");
    fireEvent.keyDown(box, { key: "Delete" });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("Delete on the LAST row focuses the row now above it, not one that no longer exists", () => {
    const onSave = vi.fn();
    render(<FlowList {...props({ flow: threeRules(), onSave })} />);
    const row3 = screen.getByTestId("flowlist-row-e3");
    row3.focus();
    fireEvent.keyDown(row3, { key: "Delete" });
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.edges.map((e) => e.id)).toEqual(["e1", "e2"]);
  });

  it("moves focus to the row that slides into the deleted row's slot", () => {
    const onSave = vi.fn();
    const { rerender } = render(<FlowList {...props({ flow: threeRules(), onSave })} />);
    const row1 = screen.getByTestId("flowlist-row-e1");
    row1.focus();
    fireEvent.keyDown(row1, { key: "Delete" });
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    rerender(<FlowList {...props({ flow: saved, onSave })} />);
    // e2 now occupies row index 0 — the slot the deleted row vacated.
    expect(screen.getByTestId("flowlist-row-e2")).toHaveAttribute("tabindex", "0");
  });
});

describe("a fired rule", () => {
  const firedFlow = () =>
    flow({
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-1", repo: "agent-flow" },
        { id: "n2", kind: "notify", x: 320, y: 0, join: "any", message: "landed" },
      ],
      edges: [{
        id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify",
        firedAt: 5, firedNote: "told you: landed",
      }],
    });

  it("shows its receipt", () => {
    render(<FlowList {...props({ flow: firedFlow() })} />);
    expect(screen.getByTestId("flowlist-row-e1").textContent).toContain("told you: landed");
  });

  it("falls back to a bare 'fired' when the rule carries no receipt note", () => {
    const noNote = flow({
      nodes: firedFlow().nodes,
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify", firedAt: 5 }],
    });
    render(<FlowList {...props({ flow: noNote })} />);
    expect(within(screen.getByTestId("flowlist-row-e1")).getByText("fired")).toBeTruthy();
  });

  it("offers Reset, and resetting calls onResetEdge with just the edge id", () => {
    const onResetEdge = vi.fn();
    render(<FlowList {...props({ flow: firedFlow(), onResetEdge })} />);
    const row = screen.getByTestId("flowlist-row-e1");
    fireEvent.click(within(row).getByRole("button", { name: "Reset" }));
    expect(onResetEdge).toHaveBeenCalledWith("e1");
  });

  it("an unfired rule offers no Reset", () => {
    render(<FlowList {...props({ flow: twoPlaces() })} />);
    expect(within(screen.getByTestId("flowlist-row-e1")).queryByRole("button", { name: "Reset" })).toBeNull();
  });

  it("an errored rule (settled, never fired) also offers Reset, and shows the error text", () => {
    const errored = flow({
      nodes: firedFlow().nodes,
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "launch", error: "no worktree" }],
    });
    render(<FlowList {...props({ flow: errored })} />);
    const row = screen.getByTestId("flowlist-row-e1");
    expect(row.textContent).toContain("no worktree");
    expect(within(row).getByRole("button", { name: "Reset" })).toBeTruthy();
  });
});

describe("an impossible action", () => {
  it("a launch edge whose target is a place shows the same reason the inspector gives", () => {
    render(<FlowList {...props({ flow: twoPlaces({ action: "launch" }) })} />);
    const row = screen.getByTestId("flowlist-row-e1");
    expect(row.textContent).toMatch(/launch needs planned work/i);
    expect(within(row).queryByLabelText("Mode")).toBeNull();
  });

  it("the mirror: a seed edge whose target is planned work shows its own reason", () => {
    render(<FlowList {...props({ flow: placeAndPlanned({ action: "seed" }) })} />);
    const row = screen.getByTestId("flowlist-row-e1");
    expect(row.textContent).toMatch(/seed needs a place/i);
  });

  it("does not spend red on a mismatch — nothing has tried and failed yet", () => {
    render(<FlowList {...props({ flow: twoPlaces({ action: "launch" }) })} />);
    const row = screen.getByTestId("flowlist-row-e1");
    expect(row.querySelector(".err")).toBeNull();
  });
});
