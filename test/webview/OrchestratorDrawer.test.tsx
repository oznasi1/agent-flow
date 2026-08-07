// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import * as React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { OrchestratorDrawer, DRAG_SEP } from "../../src/webview/OrchestratorDrawer";
import type { Flow } from "../../src/engine/orchestrator/model";
import { GRID } from "../../src/engine/orchestrator/layout";

// This repo's pinned jsdom has no PointerEvent constructor. Without it, a
// fireEvent.pointer* call falls through to a bare Event with no clientX/clientY,
// and every drag assertion below would see NaN. jsdom's MouseEvent does honour
// clientX/clientY via its init dict, so a thin PointerEvent-shaped subclass of it
// is enough for the drag handlers under test, which only read those two fields.
if (typeof window !== "undefined" && !window.PointerEvent) {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    pointerType: string;
    constructor(type: string, params: MouseEventInit & { pointerId?: number; pointerType?: string } = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 0;
      this.pointerType = params.pointerType ?? "mouse";
    }
  }
  // @ts-expect-error — jsdom's lib.dom types still declare PointerEvent even though
  // the runtime lacks it, so this assignment looks redundant to tsc; it is not.
  window.PointerEvent = PointerEventPolyfill;
}

// Same gap for DragEvent: the canvas drop test needs clientX/clientY on the drop
// event to compute where the card landed. dataTransfer itself does not need any
// help here — testing-library's fireEvent patches that onto the event directly
// regardless of which constructor built it.
if (typeof window !== "undefined" && !window.DragEvent) {
  class DragEventPolyfill extends MouseEvent {
    dataTransfer: DataTransfer | null;
    constructor(type: string, params: MouseEventInit & { dataTransfer?: DataTransfer | null } = {}) {
      super(type, params);
      this.dataTransfer = params.dataTransfer ?? null;
    }
  }
  window.DragEvent = DragEventPolyfill;
}

const flow = (over: Partial<Flow> = {}): Flow => ({
  id: "f1", name: "Ship the migration", armed: false, createdAt: 1_000, nodes: [], edges: [], ...over,
});

const props = (over: Partial<React.ComponentProps<typeof OrchestratorDrawer>> = {}) => ({
  flows: [flow()], openId: "f1", runs: [],
  onClose: vi.fn(), onCreate: vi.fn(), onOpen: vi.fn(),
  onRename: vi.fn(), onSave: vi.fn(), onDelete: vi.fn(),
  ...over,
});

describe("OrchestratorDrawer", () => {
  it("renders nothing when no flow is open", () => {
    const { container } = render(<OrchestratorDrawer {...props({ openId: null })} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the open flow's name in an editable field", () => {
    render(<OrchestratorDrawer {...props()} />);
    expect(screen.getByLabelText("Flow name")).toHaveValue("Ship the migration");
  });

  it("renames on blur, not on every keystroke", () => {
    const onRename = vi.fn();
    render(<OrchestratorDrawer {...props({ onRename })} />);
    const input = screen.getByLabelText("Flow name");
    fireEvent.change(input, { target: { value: "Ship it" } });
    expect(onRename).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onRename).toHaveBeenCalledWith("f1", "Ship it");
  });

  it("does not fire a rename when the name is unchanged", () => {
    const onRename = vi.fn();
    render(<OrchestratorDrawer {...props({ onRename })} />);
    fireEvent.blur(screen.getByLabelText("Flow name"));
    expect(onRename).not.toHaveBeenCalled();
  });

  it("closes", () => {
    const onClose = vi.fn();
    render(<OrchestratorDrawer {...props({ onClose })} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("states that the flow is not armed and that arming comes later", () => {
    render(<OrchestratorDrawer {...props()} />);
    expect(screen.getByText(/not armed/i)).toBeTruthy();
  });

  it("has no Arm control at all — arming is not built yet", () => {
    render(<OrchestratorDrawer {...props()} />);
    expect(screen.queryByRole("button", { name: /^arm/i })).toBeNull();
  });

  it("offers an empty state that explains the first move", () => {
    render(<OrchestratorDrawer {...props()} />);
    // Task 6 replaces the tray-era placeholder with the canvas's own empty hint —
    // the graph itself now explains dragging a card in and wiring two nodes.
    expect(screen.getByText(/add a node/i)).toBeTruthy();
  });

  it("lets you switch to another flow", () => {
    const onOpen = vi.fn();
    render(<OrchestratorDrawer {...props({ onOpen, flows: [flow(), flow({ id: "f2", name: "Second" })] })} />);
    fireEvent.click(screen.getByRole("button", { name: /flows/i }));
    fireEvent.click(screen.getByRole("button", { name: "Second" }));
    expect(onOpen).toHaveBeenCalledWith("f2");
  });

  it("creates a flow from the switcher", () => {
    const onCreate = vi.fn();
    render(<OrchestratorDrawer {...props({ onCreate })} />);
    fireEvent.click(screen.getByRole("button", { name: /flows/i }));
    fireEvent.click(screen.getByRole("button", { name: "+ New flow" }));
    expect(onCreate).toHaveBeenCalled();
  });
});

const drop = (el: Element, payload: string) =>
  fireEvent.drop(el, { dataTransfer: { getData: () => payload, dropEffect: "copy" } });

describe("the tray", () => {
  it("adds a place node when a card is dropped", () => {
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave })} />);
    drop(screen.getByTestId("orch-tray"), `ASM-1${DRAG_SEP}agent-flow`);
    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0] as Flow;
    expect(saved.nodes).toEqual([
      expect.objectContaining({ kind: "place", runKey: "ASM-1", repo: "agent-flow", join: "any" }),
    ]);
  });

  it("gives the new node an id that is unique within the flow", () => {
    const onSave = vi.fn();
    const existing = flow({ nodes: [{ id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-9", repo: "r" }] });
    render(<OrchestratorDrawer {...props({ onSave, flows: [existing] })} />);
    drop(screen.getByTestId("orch-tray"), `ASM-1${DRAG_SEP}agent-flow`);
    const saved = onSave.mock.calls[0][0] as Flow;
    expect(new Set(saved.nodes.map((n) => n.id)).size).toBe(2);
  });

  it("refuses the same run and repo twice", () => {
    const onSave = vi.fn();
    const existing = flow({ nodes: [{ id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-1", repo: "agent-flow" }] });
    render(<OrchestratorDrawer {...props({ onSave, flows: [existing] })} />);
    drop(screen.getByTestId("orch-tray"), `ASM-1${DRAG_SEP}agent-flow`);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("accepts the same run in a different repo", () => {
    const onSave = vi.fn();
    const existing = flow({ nodes: [{ id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-1", repo: "agent-flow" }] });
    render(<OrchestratorDrawer {...props({ onSave, flows: [existing] })} />);
    drop(screen.getByTestId("orch-tray"), `ASM-1${DRAG_SEP}other-repo`);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("ignores a malformed payload", () => {
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave })} />);
    drop(screen.getByTestId("orch-tray"), "nonsense-with-no-separator");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("lists an attached node as a chip, and removes it", () => {
    const onSave = vi.fn();
    const existing = flow({ nodes: [{ id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-1", repo: "agent-flow" }] });
    render(<OrchestratorDrawer {...props({ onSave, flows: [existing] })} />);
    // Scoped to the tray: the same node's key now also renders on its canvas node.
    expect(within(screen.getByTestId("orch-tray")).getByText("ASM-1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove ASM-1" }));
    expect((onSave.mock.calls[0][0] as Flow).nodes).toEqual([]);
  });

  it("removing a node also removes every edge touching it", () => {
    const onSave = vi.fn();
    const existing = flow({
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-1", repo: "r" },
        { id: "n2", kind: "notify", x: 0, y: 0, join: "any", message: "done" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" }],
    });
    render(<OrchestratorDrawer {...props({ onSave, flows: [existing] })} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove ASM-1" }));
    const saved = onSave.mock.calls[0][0] as Flow;
    expect(saved.edges).toEqual([]);
  });

  // The previous test only removes the edge's `from` end. An edge is "touching"
  // a node on either end, so the `to` end needs its own case: a guard that
  // checked only `from` would pass the test above yet leave this edge behind.
  it("removing a node also removes an edge for which it is the target", () => {
    const onSave = vi.fn();
    const existing = flow({
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-1", repo: "r" },
        { id: "n2", kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-2", repo: "r" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" }],
    });
    render(<OrchestratorDrawer {...props({ onSave, flows: [existing] })} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove ASM-2" }));
    const saved = onSave.mock.calls[0][0] as Flow;
    expect(saved.edges).toEqual([]);
  });
});

const twoPlaces = () =>
  flow({
    nodes: [
      { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "ASM-1", repo: "agent-flow" },
      { id: "n2", kind: "place", x: 320, y: 24, join: "any", runKey: "ASM-2", repo: "bite-me" },
    ],
  });

describe("the canvas", () => {
  it("renders one node per flow node, positioned from the model", () => {
    render(<OrchestratorDrawer {...props({ flows: [twoPlaces()] })} />);
    const n1 = screen.getByTestId("orch-node-n1");
    expect(n1.style.left).toBe("24px");
    expect(n1.style.top).toBe("24px");
    expect(screen.getByTestId("orch-node-n2").style.left).toBe("320px");
  });

  it("shows a place node's key and repo", () => {
    render(<OrchestratorDrawer {...props({ flows: [twoPlaces()] })} />);
    const n1 = screen.getByTestId("orch-node-n1");
    expect(n1.textContent).toContain("ASM-1");
    expect(n1.textContent).toContain("agent-flow");
  });

  it("saves a snapped position after a node is dragged", () => {
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave, flows: [twoPlaces()] })} />);
    const n1 = screen.getByTestId("orch-node-n1");
    fireEvent.pointerDown(n1, { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 131, clientY: 100 });
    fireEvent.pointerUp(window);
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    const moved = saved.nodes.find((n) => n.id === "n1")!;
    // 24 + 31 = 55, snapped to the 8px grid.
    expect(moved.x % GRID).toBe(0);
    expect(moved.x).toBe(56);
  });

  it("does not save while the pointer is still down", () => {
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave, flows: [twoPlaces()] })} />);
    fireEvent.pointerDown(screen.getByTestId("orch-node-n1"), { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 40, clientY: 0 });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("does not save when a drag ends where it started", () => {
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave, flows: [twoPlaces()] })} />);
    fireEvent.pointerDown(screen.getByTestId("orch-node-n1"), { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(window);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("Tidy re-lays-out and saves", () => {
    const onSave = vi.fn();
    const messy = flow({
      nodes: [
        { id: "n1", kind: "place", x: 900, y: 900, join: "any", runKey: "ASM-1", repo: "r" },
        { id: "n2", kind: "notify", x: 950, y: 950, join: "any", message: "done" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" }],
    });
    render(<OrchestratorDrawer {...props({ onSave, flows: [messy] })} />);
    fireEvent.click(screen.getByRole("button", { name: "Tidy" }));
    const saved = onSave.mock.calls[0][0] as Flow;
    const a = saved.nodes.find((n) => n.id === "n1")!;
    const b = saved.nodes.find((n) => n.id === "n2")!;
    expect(b.x).toBeGreaterThan(a.x); // the target sits to the right of its source
    expect(a.x).toBeLessThan(900);
  });

  it("adds a notify node", () => {
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave, flows: [twoPlaces()] })} />);
    fireEvent.click(screen.getByRole("button", { name: "+ Notify" }));
    const saved = onSave.mock.calls[0][0] as Flow;
    expect(saved.nodes.filter((n) => n.kind === "notify")).toHaveLength(1);
  });

  it("a card dropped on the canvas lands where it was dropped", () => {
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave, flows: [flow()] })} />);
    const canvas = screen.getByTestId("orch-canvas");
    fireEvent.drop(canvas, {
      dataTransfer: { getData: () => "ASM-7\0centaur", dropEffect: "copy" },
      clientX: 200, clientY: 150,
    });
    const saved = onSave.mock.calls[0][0] as Flow;
    expect(saved.nodes).toHaveLength(1);
    expect(saved.nodes[0].x % GRID).toBe(0);
  });
});
