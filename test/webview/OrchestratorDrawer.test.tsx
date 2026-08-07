// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { OrchestratorDrawer, DRAG_SEP } from "../../src/webview/OrchestratorDrawer";
import type { Flow } from "../../src/engine/orchestrator/model";

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
    expect(screen.getByText(/add it to this flow/i)).toBeTruthy();
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
    expect(screen.getByText("ASM-1")).toBeTruthy();
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
