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

  // `wasEmpty` is seeded from the flow's edge count AT MOUNT, precisely so
  // the effect that focuses the empty state only fires on the TRANSITION
  // into empty (a delete), never on a mount that already starts there —
  // e.g. switching to List view on a flow that has no rules yet. Without
  // that guard, mounting here would yank focus off whatever the user was on
  // (the Canvas/List tab, a header control) for no reason connected to
  // anything the user just did.
  it("mounting on an already-empty flow does not steal focus from whatever the user was on", () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);
    render(<FlowList {...props({ flow: flow() })} />);
    expect(document.activeElement).toBe(outside);
    document.body.removeChild(outside);
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

  it("stops a click inside the sentence from bubbling up to the row's own click handler", () => {
    render(<FlowList {...props({ flow: threeRules() })} />);
    fireEvent.click(screen.getByTestId("flowlist-row-e1")); // open it
    const condition = screen.getByLabelText("Condition");
    const spy = vi.spyOn(Event.prototype, "stopPropagation");
    fireEvent.click(condition);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
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

  it("shows '(no mode set)' for a seed rule that has never had a mode written to it", () => {
    render(<FlowList {...props({ flow: twoPlaces({ action: "seed" }) })} />);
    expect(screen.getByTestId("flowlist-row-e1").textContent).toContain("(no mode set)");
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
  it("removes the focused rule, and moves focus to the row that slides up into its slot", () => {
    const onSave = vi.fn();
    render(<FlowList {...props({ flow: threeRules(), onSave })} />);
    const row2 = screen.getByTestId("flowlist-row-e2");
    const row3 = screen.getByTestId("flowlist-row-e3");
    row2.focus();
    fireEvent.keyDown(row2, { key: "Delete" });
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.edges.map((e) => e.id)).toEqual(["e1", "e3"]);
    // Deleting the MIDDLE row of three: the row that stays focused is the one
    // that slides UP into the deleted row's slot (e3, at index 2 before the
    // delete) — not merely "some row still has tabindex 0", which index 0
    // would satisfy by coincidence even if focus had silently dropped to
    // <body>.
    expect(document.activeElement).toBe(row3);
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
    const row2 = screen.getByTestId("flowlist-row-e2");
    const row3 = screen.getByTestId("flowlist-row-e3");
    row3.focus();
    fireEvent.keyDown(row3, { key: "Delete" });
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.edges.map((e) => e.id)).toEqual(["e1", "e2"]);
    // There is no row below the last one to slide up — the row that stays
    // focused is the one already just above it (e2), not the node being
    // removed and not <body>.
    expect(document.activeElement).toBe(row2);
  });

  it("moves focus to the row that slides into the deleted row's slot", () => {
    const onSave = vi.fn();
    const { rerender } = render(<FlowList {...props({ flow: threeRules(), onSave })} />);
    const row1 = screen.getByTestId("flowlist-row-e1");
    const row2 = screen.getByTestId("flowlist-row-e2");
    row1.focus();
    fireEvent.keyDown(row1, { key: "Delete" });
    // Focus moves imperatively, in the same handler that calls `onSave` —
    // true before React has even re-rendered around the shorter array.
    expect(document.activeElement).toBe(row2);
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    rerender(<FlowList {...props({ flow: saved, onSave })} />);
    // e2 now occupies row index 0 — the slot the deleted row vacated — and is
    // still the exact node focus already landed on, not merely A node with
    // tabindex 0 (which index 0 would carry by default even if focus had
    // silently dropped to <body> instead).
    expect(screen.getByTestId("flowlist-row-e2")).toHaveAttribute("tabindex", "0");
    expect(document.activeElement).toBe(row2);
  });

  it("deleting the only remaining rule moves focus to the empty state, not <body>", () => {
    // The one-row case: `i + 1 < rows.length` and `i - 1` both degenerate to
    // `i` itself, which is the node about to be removed — there is no OTHER
    // row to hand focus to. Without the guard in `onDeleteRule`, this would
    // focus the row being deleted and the browser would drop focus to
    // <body> the instant it unmounted.
    const onSave = vi.fn();
    const single = twoPlaces();
    const { rerender } = render(<FlowList {...props({ flow: single, onSave })} />);
    const row1 = screen.getByTestId("flowlist-row-e1");
    row1.focus();
    fireEvent.keyDown(row1, { key: "Delete" });
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.edges).toEqual([]);
    rerender(<FlowList {...props({ flow: saved, onSave })} />);
    expect(document.activeElement).toBe(screen.getByTestId("flowlist-empty"));
  });

  // The test above alone does not pin the guard (`if (rows.length > 1)`)
  // that skips focusing the row about to be removed when it is the LAST
  // one: the `wasEmpty` effect's own `emptyRef.current?.focus()` refocuses
  // onto the empty state regardless, so the FINAL `document.activeElement`
  // is identical whether or not this guard exists — replacing it with
  // `if (true)` still leaves that test green. What the guard actually
  // decides is whether `onDeleteRule` calls `.focus()` on the doomed row at
  // all before that happens; this pins THAT, directly, with a spy — the one
  // observable difference `if (true)` makes here.
  it("does not call focus on the row it is about to remove when it is the last one", () => {
    const onSave = vi.fn();
    const single = twoPlaces();
    render(<FlowList {...props({ flow: single, onSave })} />);
    const row1 = screen.getByTestId("flowlist-row-e1");
    row1.focus();
    // Attached AFTER the setup `focus()` above, so it counts only whatever
    // `onDeleteRule` itself does next, not the test's own act of giving the
    // row keyboard focus to begin with.
    const focusSpy = vi.spyOn(row1, "focus");
    fireEvent.keyDown(row1, { key: "Delete" });
    expect(focusSpy).not.toHaveBeenCalled();
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

  // Without its own tabIndex, Reset is a native Tab stop on EVERY settled
  // row regardless of which one is current — exactly the cost the roving
  // tabindex exists to avoid (see `rowTabIndex`'s own doc comment): a flow
  // with several fired rules would cost one extra Tab press per row just to
  // get past the list, on top of the single stop the list itself should
  // cost.
  it("a non-current row's Reset is not a Tab stop; the current row's is", () => {
    const twoFired = flow({
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-1", repo: "agent-flow" },
        { id: "n2", kind: "notify", x: 320, y: 0, join: "any", message: "landed" },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify", firedAt: 5, firedNote: "one" },
        { id: "e2", from: "n1", to: "n2", cond: { kind: "ci-passed" }, action: "notify", firedAt: 6, firedNote: "two" },
      ],
    });
    render(<FlowList {...props({ flow: twoFired })} />);
    const row1 = screen.getByTestId("flowlist-row-e1"); // current by default (focusedIndex 0)
    const row2 = screen.getByTestId("flowlist-row-e2");
    expect(within(row1).getByRole("button", { name: "Reset" })).toHaveAttribute("tabindex", "0");
    expect(within(row2).getByRole("button", { name: "Reset" })).toHaveAttribute("tabindex", "-1");
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

/** Two places with no rule between them yet — what building the FIRST rule
 * from the keyboard starts from. */
const twoPlacesNoEdge = () =>
  flow({
    nodes: [
      { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-1", repo: "agent-flow" },
      { id: "n2", kind: "place", x: 320, y: 0, join: "any", runKey: "ASM-2", repo: "agent-flow" },
    ],
  });

/** A place and a planned node, no rule yet — the pairing a `launch` rule can
 * be built onto. */
const placeAndPlannedNoEdge = () =>
  flow({
    nodes: [
      { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-1", repo: "agent-flow" },
      {
        id: "n2", kind: "planned", x: 320, y: 0, join: "any",
        ticketKey: "ASM-12", repos: ["agent-flow"], mode: "quick", dest: "worktree",
      },
    ],
  });

describe("adding a rule from the keyboard", () => {
  it("renders nothing when there is no node that could ever be a rule's source", () => {
    render(<FlowList {...props({ flow: flow() })} />);
    expect(screen.queryByTestId("flowlist-newrule")).toBeNull();
  });

  it("offers From, Condition, Action and To as ordinary form controls", () => {
    render(<FlowList {...props({ flow: twoPlacesNoEdge() })} />);
    const bar = screen.getByTestId("flowlist-newrule");
    expect(within(bar).getByLabelText("From node").tagName).toBe("SELECT");
    expect(within(bar).getByLabelText("New rule condition").tagName).toBe("SELECT");
    expect(within(bar).getByLabelText("New rule action").tagName).toBe("SELECT");
    expect(within(bar).getByLabelText("To node").tagName).toBe("SELECT");
  });

  it("Add rule is disabled until both a from and a to are chosen", () => {
    render(<FlowList {...props({ flow: twoPlacesNoEdge() })} />);
    const bar = screen.getByTestId("flowlist-newrule");
    const addBtn = within(bar).getByRole("button", { name: "+ Add rule" });
    expect(addBtn).toBeDisabled();
    fireEvent.change(within(bar).getByLabelText("From node"), { target: { value: "n1" } });
    expect(addBtn).toBeDisabled();
    fireEvent.change(within(bar).getByLabelText("To node"), { target: { value: "n2" } });
    expect(addBtn).not.toBeDisabled();
  });

  it("builds a rule with the chosen from, to, condition and action", () => {
    const onSave = vi.fn();
    render(<FlowList {...props({ flow: twoPlacesNoEdge(), onSave })} />);
    const bar = screen.getByTestId("flowlist-newrule");
    fireEvent.change(within(bar).getByLabelText("From node"), { target: { value: "n1" } });
    fireEvent.change(within(bar).getByLabelText("To node"), { target: { value: "n2" } });
    fireEvent.change(within(bar).getByLabelText("New rule condition"), { target: { value: "ci-failed" } });
    fireEvent.click(within(bar).getByRole("button", { name: "+ Add rule" }));
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.nodes).toEqual(twoPlacesNoEdge().nodes); // nodes untouched
    expect(saved.edges).toHaveLength(1);
    expect(saved.edges[0]).toMatchObject({ from: "n1", to: "n2", cond: { kind: "ci-failed" }, action: "notify" });
  });

  it("the To list excludes the chosen From node and any node it already has a rule to", () => {
    const wired = flow({
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-1", repo: "r" },
        { id: "n2", kind: "place", x: 0, y: 88, join: "any", runKey: "ASM-2", repo: "r" },
        { id: "n3", kind: "place", x: 0, y: 176, join: "any", runKey: "ASM-3", repo: "r" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" }],
    });
    render(<FlowList {...props({ flow: wired })} />);
    const bar = screen.getByTestId("flowlist-newrule");
    fireEvent.change(within(bar).getByLabelText("From node"), { target: { value: "n1" } });
    const values = Array.from(within(bar).getByLabelText("To node").querySelectorAll("option")).map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(values).not.toContain("n1"); // no self-loop
    expect(values).not.toContain("n2"); // the exact duplicate finishWire itself refuses
    expect(values).toContain("n3");
  });

  it("changing From clears whatever To was already chosen", () => {
    render(<FlowList {...props({ flow: twoPlacesNoEdge() })} />);
    const bar = screen.getByTestId("flowlist-newrule");
    fireEvent.change(within(bar).getByLabelText("From node"), { target: { value: "n1" } });
    fireEvent.change(within(bar).getByLabelText("To node"), { target: { value: "n2" } });
    expect(within(bar).getByLabelText("To node")).toHaveValue("n2");
    fireEvent.change(within(bar).getByLabelText("From node"), { target: { value: "n2" } });
    expect(within(bar).getByLabelText("To node")).toHaveValue("");
  });

  it("resets the whole form once a rule is added", () => {
    render(<FlowList {...props({ flow: twoPlacesNoEdge() })} />);
    const bar = screen.getByTestId("flowlist-newrule");
    fireEvent.change(within(bar).getByLabelText("From node"), { target: { value: "n1" } });
    fireEvent.change(within(bar).getByLabelText("To node"), { target: { value: "n2" } });
    fireEvent.click(within(bar).getByRole("button", { name: "+ Add rule" }));
    expect(within(bar).getByLabelText("From node")).toHaveValue("");
    expect(within(bar).getByLabelText("To node")).toHaveValue("");
  });

  it("a launch rule cannot be created pointing at a place — the same reason the inspector gives", () => {
    const onSave = vi.fn();
    render(<FlowList {...props({ flow: twoPlacesNoEdge(), onSave })} />);
    const bar = screen.getByTestId("flowlist-newrule");
    fireEvent.change(within(bar).getByLabelText("From node"), { target: { value: "n1" } });
    fireEvent.change(within(bar).getByLabelText("To node"), { target: { value: "n2" } });
    fireEvent.change(within(bar).getByLabelText("New rule action"), { target: { value: "launch" } });
    expect(bar.textContent).toMatch(/launch needs planned work/i);
    // Not disabled — see the button's own comment: the refusal is `addRule`'s
    // guard, exercised by clicking, not a control withheld from the user.
    const addBtn = within(bar).getByRole("button", { name: "+ Add rule" });
    expect(addBtn).not.toBeDisabled();
    fireEvent.click(addBtn);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("the mirror: a seed rule cannot be created pointing at planned work", () => {
    const onSave = vi.fn();
    render(<FlowList {...props({ flow: placeAndPlannedNoEdge(), onSave })} />);
    const bar = screen.getByTestId("flowlist-newrule");
    fireEvent.change(within(bar).getByLabelText("From node"), { target: { value: "n1" } });
    fireEvent.change(within(bar).getByLabelText("To node"), { target: { value: "n2" } });
    fireEvent.change(within(bar).getByLabelText("New rule action"), { target: { value: "seed" } });
    expect(bar.textContent).toMatch(/seed needs a place/i);
    fireEvent.click(within(bar).getByRole("button", { name: "+ Add rule" }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("builds a launch rule, writing the mode and destination onto the target planned node, not the edge", () => {
    const onSave = vi.fn();
    render(<FlowList {...props({ flow: placeAndPlannedNoEdge(), onSave })} />);
    const bar = screen.getByTestId("flowlist-newrule");
    fireEvent.change(within(bar).getByLabelText("From node"), { target: { value: "n1" } });
    fireEvent.change(within(bar).getByLabelText("To node"), { target: { value: "n2" } });
    fireEvent.change(within(bar).getByLabelText("New rule action"), { target: { value: "launch" } });
    fireEvent.change(within(bar).getByLabelText("New rule mode"), { target: { value: "careful" } });
    fireEvent.change(within(bar).getByLabelText("New rule destination"), { target: { value: "new-window" } });
    fireEvent.click(within(bar).getByRole("button", { name: "+ Add rule" }));
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.edges[0]).toMatchObject({ from: "n1", to: "n2", action: "launch" });
    expect(saved.edges[0].mode).toBeUndefined();
    const target = saved.nodes.find((n) => n.id === "n2") as { mode: string; dest: string };
    expect(target.mode).toBe("careful");
    expect(target.dest).toBe("new-window");
  });

  // The regression: creating a launch rule used to write NewRuleBar's own
  // generic seed (promptModes[0], "worktree") onto the target node no matter
  // what it already had — silently replacing the mode and destination the
  // user answered four QuickPicks for in Add planned work. `n2` here is
  // deliberately given neither promptModes[0]'s id ("quick") nor the
  // hardcoded "worktree" default, so either one leaking through fails this
  // test. Mode/Destination are never touched — this is exactly the "add a
  // launch rule and don't bother with the USING clause" path, which used to
  // be silent data loss.
  it("creating a launch rule preserves the target's existing mode and destination when neither is touched", () => {
    const onSave = vi.fn();
    const untouched = flow({
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-1", repo: "agent-flow" },
        {
          id: "n2", kind: "planned", x: 320, y: 0, join: "any",
          ticketKey: "ASM-12", repos: ["agent-flow"], mode: "careful", dest: "new-window",
        },
      ],
    });
    render(<FlowList {...props({ flow: untouched, onSave })} />);
    const bar = screen.getByTestId("flowlist-newrule");
    fireEvent.change(within(bar).getByLabelText("From node"), { target: { value: "n1" } });
    fireEvent.change(within(bar).getByLabelText("To node"), { target: { value: "n2" } });
    fireEvent.change(within(bar).getByLabelText("New rule action"), { target: { value: "launch" } });
    // The USING clause's own selects already read back the target's real
    // values, not a generic default — pinning the display half of the fix,
    // not only the write half `addRule` performs below.
    expect(within(bar).getByLabelText("New rule mode")).toHaveValue("careful");
    expect(within(bar).getByLabelText("New rule destination")).toHaveValue("new-window");
    fireEvent.click(within(bar).getByRole("button", { name: "+ Add rule" }));
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    const target = saved.nodes.find((n) => n.id === "n2") as { mode: string; dest: string };
    expect(target.mode).toBe("careful");
    expect(target.dest).toBe("new-window");
  });

  // The other half of the same bug: a SECOND rule must not carry over the
  // first rule's mode/destination onto a different target that has its own.
  it("a second launch rule does not inherit the previous rule's mode and destination", () => {
    const onSave = vi.fn();
    const twoPlanned = flow({
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-1", repo: "agent-flow" },
        {
          id: "n2", kind: "planned", x: 320, y: 0, join: "any",
          ticketKey: "ASM-12", repos: ["agent-flow"], mode: "careful", dest: "new-window",
        },
        {
          id: "n3", kind: "planned", x: 320, y: 88, join: "any",
          ticketKey: "ASM-13", repos: ["agent-flow"], mode: "quick", dest: "current-window",
        },
      ],
    });
    const { rerender } = render(<FlowList {...props({ flow: twoPlanned, onSave })} />);
    const bar = screen.getByTestId("flowlist-newrule");
    // First rule: n1 -> n2 (mode "careful", dest "new-window").
    fireEvent.change(within(bar).getByLabelText("From node"), { target: { value: "n1" } });
    fireEvent.change(within(bar).getByLabelText("To node"), { target: { value: "n2" } });
    fireEvent.change(within(bar).getByLabelText("New rule action"), { target: { value: "launch" } });
    fireEvent.click(within(bar).getByRole("button", { name: "+ Add rule" }));
    let saved = onSave.mock.calls.at(-1)![0] as Flow;

    // Second rule, built on the flow the first rule actually produced: n1 -> n3.
    rerender(<FlowList {...props({ flow: saved, onSave })} />);
    const bar2 = screen.getByTestId("flowlist-newrule");
    fireEvent.change(within(bar2).getByLabelText("From node"), { target: { value: "n1" } });
    fireEvent.change(within(bar2).getByLabelText("To node"), { target: { value: "n3" } });
    fireEvent.change(within(bar2).getByLabelText("New rule action"), { target: { value: "launch" } });
    expect(within(bar2).getByLabelText("New rule mode")).toHaveValue("quick");
    expect(within(bar2).getByLabelText("New rule destination")).toHaveValue("current-window");
    fireEvent.click(within(bar2).getByRole("button", { name: "+ Add rule" }));
    saved = onSave.mock.calls.at(-1)![0] as Flow;
    const n2After = saved.nodes.find((n) => n.id === "n2") as { mode: string; dest: string };
    const n3After = saved.nodes.find((n) => n.id === "n3") as { mode: string; dest: string };
    expect(n2After.mode).toBe("careful"); // untouched by the second rule
    expect(n2After.dest).toBe("new-window");
    expect(n3After.mode).toBe("quick"); // its own, not n2's leftover
    expect(n3After.dest).toBe("current-window");
  });

  it("builds a seed rule, writing the chosen mode onto the edge", () => {
    const onSave = vi.fn();
    render(<FlowList {...props({ flow: twoPlacesNoEdge(), onSave })} />);
    const bar = screen.getByTestId("flowlist-newrule");
    fireEvent.change(within(bar).getByLabelText("From node"), { target: { value: "n1" } });
    fireEvent.change(within(bar).getByLabelText("To node"), { target: { value: "n2" } });
    fireEvent.change(within(bar).getByLabelText("New rule action"), { target: { value: "seed" } });
    fireEvent.change(within(bar).getByLabelText("New rule mode"), { target: { value: "careful" } });
    fireEvent.click(within(bar).getByRole("button", { name: "+ Add rule" }));
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.edges[0]).toMatchObject({ from: "n1", to: "n2", action: "seed", mode: "careful" });
  });

  it("offers no mode or destination clause for a notify rule", () => {
    render(<FlowList {...props({ flow: twoPlacesNoEdge() })} />);
    const bar = screen.getByTestId("flowlist-newrule");
    expect(within(bar).queryByLabelText("New rule mode")).toBeNull();
    expect(within(bar).queryByLabelText("New rule destination")).toBeNull();
  });

  // A stale draft: `from`/`to` are plain component state, so nothing stops
  // them outliving the flow they were chosen from unless something clears
  // them — same shape as Phase 3's Task 6 mode-select bug, where what was
  // shown and what was stored had quietly drifted apart.
  it("switching the open flow clears a part-built draft", () => {
    const flowA = twoPlacesNoEdge(); // id "f1", nodes n1/n2
    const flowB = flow({
      id: "f2",
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "OTHER-1", repo: "other-repo" },
        { id: "n2", kind: "notify", x: 320, y: 0, join: "any", message: "done" },
      ],
    });
    const { rerender } = render(<FlowList {...props({ flow: flowA })} />);
    const bar = screen.getByTestId("flowlist-newrule");
    fireEvent.change(within(bar).getByLabelText("From node"), { target: { value: "n1" } });
    fireEvent.change(within(bar).getByLabelText("To node"), { target: { value: "n2" } });
    expect(within(bar).getByLabelText("From node")).toHaveValue("n1");

    rerender(<FlowList {...props({ flow: flowB })} />);
    const bar2 = screen.getByTestId("flowlist-newrule");
    expect(within(bar2).getByLabelText("From node")).toHaveValue("");
    expect(within(bar2).getByLabelText("To node")).toHaveValue("");
  });

  // The route in without the reset above: `from`/`to` keep naming nodes that
  // WERE in this same flow (same `flow.id`, so the reset effect above never
  // fires) but no longer are — e.g. a node removed from the tray while the
  // draft still points at it. `actionMismatch` has nothing to say about this
  // (notify never mismatches on target kind), so `addRule`'s own guard is the
  // only thing standing between this state and a dangling edge on disk.
  it("addRule refuses when from or to names a node that is not in the current flow, and calls onSave zero times", () => {
    const onSave = vi.fn();
    const original = twoPlacesNoEdge(); // id "f1", nodes n1/n2
    const { rerender } = render(<FlowList {...props({ flow: original, onSave })} />);
    const bar = screen.getByTestId("flowlist-newrule");
    fireEvent.change(within(bar).getByLabelText("From node"), { target: { value: "n1" } });
    fireEvent.change(within(bar).getByLabelText("To node"), { target: { value: "n2" } });

    // n2 is gone — same flow id, fewer nodes. The draft's own state still names it.
    const shrunk: Flow = { ...original, nodes: original.nodes.filter((n) => n.id !== "n2") };
    rerender(<FlowList {...props({ flow: shrunk, onSave })} />);
    const bar2 = screen.getByTestId("flowlist-newrule");
    fireEvent.click(within(bar2).getByRole("button", { name: "+ Add rule" }));
    expect(onSave).toHaveBeenCalledTimes(0);
  });
});
