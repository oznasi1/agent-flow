// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import * as React from "react";
import { act, render, screen, fireEvent, within } from "@testing-library/react";
import { OrchestratorDrawer, DRAG_SEP } from "../../src/webview/OrchestratorDrawer";
import type { Flow } from "../../src/engine/orchestrator/model";
import { anchor, edgePath, GRID, labelPoint, NODE_H, NODE_W } from "../../src/engine/orchestrator/layout";
import type { PrEntryMap, RunStatus } from "../../src/types";

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
  flows: [flow()], openId: "f1", runs: [], pendingResume: [],
  onClose: vi.fn(), onCreate: vi.fn(), onOpen: vi.fn(),
  onRename: vi.fn(), onSave: vi.fn(), onDelete: vi.fn(),
  onArm: vi.fn(), onResumeApprove: vi.fn(), onResumeDisarm: vi.fn(), onResetEdge: vi.fn(),
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

  it("states that a disarmed flow is not armed", () => {
    render(<OrchestratorDrawer {...props()} />);
    expect(screen.getByText(/not armed/i)).toBeTruthy();
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

  // `onDelete` was declared, wired in DeckApp and never called: a user could create
  // flows forever and delete none, while src/types.ts, deckView.ts and two
  // deckView tests carried a live fs.rmSync path with no caller.
  it("deletes the open flow", () => {
    const onDelete = vi.fn();
    render(<OrchestratorDrawer {...props({ onDelete })} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete flow" }));
    expect(onDelete).toHaveBeenCalledWith("f1");
  });

  it("leaves the drawer showing nothing after deleting the open flow", () => {
    // Not "the host will post deck:flows eventually" — the drawer closes on the
    // spot, so it never renders a flow that has been deleted.
    const onClose = vi.fn();
    render(<OrchestratorDrawer {...props({ onClose })} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete flow" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps the delete quiet — no fill, no accent, no red", () => {
    // A filled or accented control is reserved for Arm, which does not exist yet,
    // and red is reserved for a real failure. `orch-mini` is the quiet style its
    // neighbours use; orchestratorStyles.ts gives it a transparent background and
    // a --dim foreground, and tokens.test.ts pins that --brand never reaches it.
    render(<OrchestratorDrawer {...props()} />);
    const del = screen.getByRole("button", { name: "Delete flow" });
    expect(del.className).toBe("orch-mini");
    expect(del.getAttribute("style")).toBeNull();
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

  // Ids are re-minted to the lowest free value (see `nextId`), so a selection that
  // outlives its node lands on whatever next takes the id. Both of these render
  // against an UNCHANGED flow prop — `onSave` is a mock, so nothing re-renders from
  // the parent — which is the only way to observe the clear itself rather than the
  // list simply having shrunk.
  it("clears the node selection when a node is removed", () => {
    const existing = flow({
      nodes: [{ id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-1", repo: "r" }],
    });
    render(<OrchestratorDrawer {...props({ onSave: vi.fn(), flows: [existing] })} />);
    // Pointer-down is what selects a node; release it so no drag is left in flight.
    fireEvent.pointerDown(screen.getByTestId("orch-node-n1"), { clientX: 0, clientY: 0 });
    fireEvent.pointerUp(window);
    expect(screen.getByTestId("orch-node-n1").classList.contains("sel")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove ASM-1" }));
    expect(screen.getByTestId("orch-node-n1").classList.contains("sel")).toBe(false);
  });

  it("clears the edge selection when a node is removed", () => {
    const existing = flow({
      nodes: [
        { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "ASM-1", repo: "r" },
        { id: "n2", kind: "notify", x: 320, y: 24, join: "any", message: "done" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" }],
    });
    render(<OrchestratorDrawer {...props({ onSave: vi.fn(), flows: [existing] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    expect(screen.queryByText(/select a connection/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove ASM-1" }));
    // A re-minted `e1` would otherwise open the inspector on a rule nobody clicked.
    expect(screen.getByText(/select a connection/i)).toBeTruthy();
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

  // Phase 1's Critical bug, reintroduced in the node badge: `runs.find(...)?.agent
  // .state` is the RUN-level aggregate, `mostActive` over every agent in every repo
  // of the run. A node must read `placeActivity` instead, or a panel makes two
  // contradictory claims about one place — an amber needs-you dot on the node, and
  // "agent state unknown" in the inspector two panes below.
  describe("a node's state dot", () => {
    const dotOf = (id: string) =>
      (screen.getByTestId(`orch-node-${id}`).querySelector(".d") as HTMLElement).style.background;

    /** A run with two worktrees, one agent, and that agent in `agentRepo`. Its
     * run-level `agent` is what `buildRunStatus` would compute: `mostActive` over
     * every repo, i.e. the one agent's own state. */
    const twoRepoRun = (agentRepo: string): RunStatus => ({
      run: {
        key: "ASM-5", summary: "s", url: "https://j/browse/ASM-5", createdAt: 1, mode: "multiroot",
        repos: [
          { name: "web", path: "/r/web", isGit: true },
          { name: "api", path: "/r/api", isGit: true },
        ],
        briefPaths: [],
      },
      column: "needs", ticketStatus: "In Progress", ticketCategory: "indeterminate",
      repos: [
        { name: "web", path: "/r/web", branch: "b", dirty: false, ahead: 0, added: 0, removed: 0, files: 0 },
        { name: "api", path: "/r/api", branch: "b", dirty: false, ahead: 0, added: 0, removed: 0, files: 0 },
      ],
      agent: { state: "needs-you", lastActivityMs: 9, slug: null },
      windowOpen: true, prs: {},
      agents: [{
        session: { pid: 1, sessionId: "s1", cwd: `/r/${agentRepo}`, startedAt: 1, name: "s1" },
        activity: { state: "needs-you", lastActivityMs: 9, slug: null },
        repo: agentRepo,
      }],
    });

    const boundTo = (repo: string): Flow =>
      flow({ nodes: [{ id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "ASM-5", repo }] });

    it("does not borrow another repo's state", () => {
      // The agent that ended its turn is in `web`; this node is bound to `api`,
      // which has no agent at all. Reading `status.agent` would paint it amber.
      render(<OrchestratorDrawer {...props({ runs: [twoRepoRun("web")], flows: [boundTo("api")] })} />);
      expect(dotOf("n1")).not.toBe("var(--c-attn)");
      expect(dotOf("n1")).toBe("var(--dim)"); // unknown — the same thing the inspector says
    });

    it("still shows this place's own agent", () => {
      // The mirror image, so the fix cannot be "always unknown": bind the node to
      // the repo the agent is actually in and the amber dot must appear.
      render(<OrchestratorDrawer {...props({ runs: [twoRepoRun("web")], flows: [boundTo("web")] })} />);
      expect(dotOf("n1")).toBe("var(--c-attn)");
    });

    it("says nothing about a run that is not on the board", () => {
      render(<OrchestratorDrawer {...props({ runs: [], flows: [boundTo("api")] })} />);
      expect(dotOf("n1")).toBe("var(--dim)");
    });
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

  // The save used to live INSIDE the `setDrag` updater. A state updater must be
  // pure: React double-invokes this one under StrictMode, which turned one released
  // drag into two writes of the user's flow file — measured, two `onSave` calls, not
  // a theory. StrictMode is what makes it observable; outside it the eager-state path
  // runs the updater once and the broken version looks fine.
  it("writes the moved position exactly once, even under StrictMode", () => {
    const onSave = vi.fn();
    render(
      <React.StrictMode>
        <OrchestratorDrawer {...props({ onSave, flows: [twoPlaces()] })} />
      </React.StrictMode>,
    );
    fireEvent.pointerDown(screen.getByTestId("orch-node-n1"), { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 131, clientY: 100 });
    fireEvent.pointerUp(window);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect((onSave.mock.calls[0][0] as Flow).nodes.find((n) => n.id === "n1")!.x).toBe(56);
  });

  // pointermove is InputContinuous priority and pointerup is Discrete, so a
  // release can arrive before React has flushed the final move into `drag` —
  // reading `drag` itself in the release handler would then save the position
  // one move stale. snap() hides the gap unless the final move crosses a grid
  // line, which is why this needs two moves, not one.
  //
  // Each `fireEvent.*` call is individually wrapped in `act()`, which flushes
  // state and effects before the next line runs — so two separate calls would
  // never observe the race even against the unfixed handler. Nesting all three
  // dispatches inside one manual `act()` defers that flush until the very end,
  // the same way a real browser can deliver a move and the following release
  // before React gets a chance to reconcile in between.
  it("saves the final drag position even when the release arrives before the last move flushes", () => {
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave, flows: [twoPlaces()] })} />);
    const n1 = screen.getByTestId("orch-node-n1");
    fireEvent.pointerDown(n1, { clientX: 100, clientY: 100 });
    act(() => {
      // Two moves, then an immediate release, all before React reconciles: the
      // saved position must be the LAST move's, not the previous one's.
      fireEvent.pointerMove(window, { clientX: 140, clientY: 100 });
      fireEvent.pointerMove(window, { clientX: 180, clientY: 100 });
      fireEvent.pointerUp(window);
    });
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    // dx = 100 - 0 - 24 = 76 (node.x=24, jsdom's getBoundingClientRect is all 0).
    // Final move: clientX=180 → snap(180 - 0 - 76) = snap(104) = 104.
    expect(saved.nodes.find((n) => n.id === "n1")!.x).toBe(104);
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
    // jsdom's canvas rect is deterministically zero, so the landing point is
    // deterministic too: clientX/Y minus half the node box, snapped to GRID.
    // (200 - 168/2) snapped = snap(116) = 120; (150 - 44/2) snapped = snap(128) = 128.
    expect(saved.nodes[0]).toMatchObject({ x: 120, y: 128 });
  });

  // The tray and the canvas are two independent drop targets; the mockup toggles
  // their highlight independently (tray.classList vs canvas.classList are two
  // separate DOM toggles), so one shared boolean backing both would light up
  // whichever zone you are NOT hovering too. These pin that distinction.
  it("highlights the canvas on drag-over, and not the tray", () => {
    render(<OrchestratorDrawer {...props({ flows: [twoPlaces()] })} />);
    const canvas = screen.getByTestId("orch-canvas");
    const tray = screen.getByTestId("orch-tray");
    fireEvent.dragOver(canvas);
    expect(canvas.classList.contains("over")).toBe(true);
    expect(tray.classList.contains("over")).toBe(false);
  });

  it("highlights the tray on drag-over, and not the canvas", () => {
    render(<OrchestratorDrawer {...props({ flows: [twoPlaces()] })} />);
    const canvas = screen.getByTestId("orch-canvas");
    const tray = screen.getByTestId("orch-tray");
    fireEvent.dragOver(tray);
    expect(tray.classList.contains("over")).toBe(true);
    expect(canvas.classList.contains("over")).toBe(false);
  });
});

const wired = () =>
  flow({
    nodes: [
      { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "ASM-1", repo: "agent-flow" },
      { id: "n2", kind: "notify", x: 320, y: 24, join: "any", message: "landed" },
    ],
    edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" }],
  });

describe("wiring", () => {
  it("draws one connector per edge", () => {
    const { container } = render(<OrchestratorDrawer {...props({ flows: [wired()] })} />);
    expect(container.querySelectorAll("svg path")).toHaveLength(1);
  });

  it("labels the connector with the condition, and the label is clickable", () => {
    render(<OrchestratorDrawer {...props({ flows: [wired()] })} />);
    const label = screen.getByTestId("orch-edge-e1");
    expect(label.textContent).toMatch(/merged/i);
  });

  it("creates a notify edge by dragging from a port onto another node", () => {
    const onSave = vi.fn();
    const two = flow({
      nodes: [
        { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "ASM-1", repo: "r" },
        { id: "n2", kind: "place", x: 320, y: 24, join: "any", runKey: "ASM-2", repo: "r2" },
      ],
    });
    render(<OrchestratorDrawer {...props({ onSave, flows: [two] })} />);
    fireEvent.pointerDown(screen.getByTestId("orch-port-out-n1"));
    fireEvent.pointerUp(screen.getByTestId("orch-node-n2"));
    const saved = onSave.mock.calls[0][0] as Flow;
    expect(saved.edges).toEqual([
      expect.objectContaining({ from: "n1", to: "n2", action: "notify", cond: { kind: "pr-merged" } }),
    ]);
  });

  it("refuses an edge from a node to itself", () => {
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave, flows: [wired()] })} />);
    fireEvent.pointerDown(screen.getByTestId("orch-port-out-n1"));
    fireEvent.pointerUp(screen.getByTestId("orch-node-n1"));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("refuses a duplicate edge between the same two nodes", () => {
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave, flows: [wired()] })} />);
    fireEvent.pointerDown(screen.getByTestId("orch-port-out-n1"));
    fireEvent.pointerUp(screen.getByTestId("orch-node-n2"));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("a notify node has no outgoing port — nothing follows a terminal", () => {
    render(<OrchestratorDrawer {...props({ flows: [wired()] })} />);
    expect(screen.queryByTestId("orch-port-out-n2")).toBeNull();
  });

  it("releasing a wire on empty canvas creates nothing", () => {
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave, flows: [wired()] })} />);
    fireEvent.pointerDown(screen.getByTestId("orch-port-out-n1"));
    fireEvent.pointerUp(screen.getByTestId("orch-canvas"));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("dragging from a port does not also drag the node", () => {
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave, flows: [wired()] })} />);
    fireEvent.pointerDown(screen.getByTestId("orch-port-out-n1"), { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 90, clientY: 60 });
    fireEvent.pointerUp(screen.getByTestId("orch-canvas"));
    // No node moved, so nothing was saved.
    expect(onSave).not.toHaveBeenCalled();
  });

  // Nothing above asserts WHERE a connector actually lands. Every one of those
  // tests would still pass if `anchor`'s "out"/"in" arguments were swapped, or
  // the wrong node's box were passed in — the label would just be wrong, in a
  // place, and every test would stay green. This pins the real numbers.
  //
  // The expected values are computed by calling the SAME layout functions the
  // component calls, not by pasting numbers: this pins that the component wires
  // anchor/edgePath/labelPoint together correctly (right node, right side), not
  // that some other formula happens to agree with layout.ts.
  it("pins the connector's geometry: the label and the path sit exactly where layout.ts puts them", () => {
    // wired(): n1 (place) at (24, 24) is the source, n2 (notify) at (320, 24) is
    // the target. `anchor`'s "in" side never reads a box's width (only "out"
    // does), so the target box's width is irrelevant here — NODE_W is used for
    // both boxes on purpose, to keep that fact visible rather than importing the
    // component's private NOTIFY_W.
    const fromBox = { x: 24, y: 24, w: NODE_W, h: NODE_H };
    const toBox = { x: 320, y: 24, w: NODE_W, h: NODE_H };
    const from = anchor(fromBox, "out");
    const to = anchor(toBox, "in");
    const expectedMid = labelPoint(from, to);
    const expectedPath = edgePath(from, to);

    const { container } = render(<OrchestratorDrawer {...props({ flows: [wired()] })} />);
    const label = screen.getByTestId("orch-edge-e1");
    expect(label.style.left).toBe(`${expectedMid.x}px`);
    expect(label.style.top).toBe(`${expectedMid.y}px`);
    const path = container.querySelector("svg path");
    expect(path?.getAttribute("d")).toBe(expectedPath);
  });

  // "Red only for a real failure" is a house rule (see orchestratorStyles.ts's
  // own comment on .orch-edge.bad); it needs its own test on each side, or the
  // rule erodes the first time someone "simplifies" BAD_CONDS.
  it("tints a connector whose condition is a failure", () => {
    const failing = flow({
      nodes: [
        { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "ASM-1", repo: "r" },
        { id: "n2", kind: "notify", x: 320, y: 24, join: "any", message: "landed" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "ci-failed" }, action: "notify" }],
    });
    render(<OrchestratorDrawer {...props({ flows: [failing] })} />);
    expect(screen.getByTestId("orch-edge-e1").classList.contains("bad")).toBe(true);
  });

  it("does not tint a normal connection", () => {
    render(<OrchestratorDrawer {...props({ flows: [wired()] })} />); // wired()'s condition is pr-merged
    expect(screen.getByTestId("orch-edge-e1").classList.contains("bad")).toBe(false);
  });

  // Minting an edge id from `flow.edges.length + 1` is not collision-safe: three
  // edges [e1, e2, e3], minus the middle one, is a list of length two, so the
  // next id minted the naive way is `e3` — which the untouched third edge
  // already has. `nextNodeId` already scans past what is taken instead of
  // trusting the count; edges need the same treatment.
  const threeIntoNotify = () =>
    flow({
      nodes: [
        { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "ASM-1", repo: "r" },
        { id: "n2", kind: "place", x: 24, y: 112, join: "any", runKey: "ASM-2", repo: "r" },
        { id: "n3", kind: "place", x: 24, y: 200, join: "any", runKey: "ASM-3", repo: "r" },
        { id: "n4", kind: "place", x: 320, y: 24, join: "any", runKey: "ASM-4", repo: "r" },
        { id: "n5", kind: "notify", x: 320, y: 200, join: "any", message: "done" },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n5", cond: { kind: "pr-merged" }, action: "notify" },
        { id: "e2", from: "n2", to: "n5", cond: { kind: "pr-merged" }, action: "notify" },
        { id: "e3", from: "n3", to: "n5", cond: { kind: "pr-merged" }, action: "notify" },
      ],
    });

  it("mints a unique edge id even after a delete leaves a gap", () => {
    const onSave = vi.fn();
    const three = threeIntoNotify();
    // Delete the middle connection first, leaving [e1, e3] — length two, the
    // exact shape that makes `e${length + 1}` collide with the untouched e3.
    const afterDelete: Flow = { ...three, edges: three.edges.filter((e) => e.id !== "e2") };
    render(<OrchestratorDrawer {...props({ onSave, flows: [afterDelete] })} />);
    fireEvent.pointerDown(screen.getByTestId("orch-port-out-n4"));
    fireEvent.pointerUp(screen.getByTestId("orch-node-n5"));
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    const ids = saved.edges.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("deleting one connection removes exactly one, even where a colliding id used to be minted", () => {
    const onSave = vi.fn();
    const three = threeIntoNotify();
    const afterDelete: Flow = { ...three, edges: three.edges.filter((e) => e.id !== "e2") };
    const { rerender } = render(<OrchestratorDrawer {...props({ onSave, flows: [afterDelete] })} />);
    fireEvent.pointerDown(screen.getByTestId("orch-port-out-n4"));
    fireEvent.pointerUp(screen.getByTestId("orch-node-n5"));
    const wired3 = onSave.mock.calls.at(-1)![0] as Flow;

    // Re-render (not a second `render()` — that would leave the first tree
    // mounted too, making every query below ambiguous for reasons unrelated to
    // the bug this test exists to catch) against the flow the wire just
    // produced, then delete the connection that sits where a collision used to
    // land (n3 → n5, originally e3). getAllByTestId rather than getByTestId:
    // under the un-fixed minting this id is not unique in the DOM, and the
    // point of this test is the resulting edge count, not whether the lookup
    // itself is unambiguous.
    const onSave2 = vi.fn();
    rerender(<OrchestratorDrawer {...props({ onSave: onSave2, flows: [wired3] })} />);
    fireEvent.click(screen.getAllByTestId("orch-edge-e3")[0]);
    fireEvent.click(screen.getByRole("button", { name: "Delete connection" }));
    const saved = onSave2.mock.calls.at(-1)![0] as Flow;
    expect(saved.edges).toHaveLength(2);
  });
});

const runStatus = (key: string, repo: string, over: Partial<RunStatus> = {}): RunStatus => {
  const prs: PrEntryMap = {
    [repo]: {
      facts: {
        number: 118, url: "u", title: "t", state: "OPEN", isDraft: false,
        ci: { passing: 4, pending: 3, failing: [] }, review: "none", unresolved: null,
        mergeable: "clean", ciAdvisory: false,
      },
      fetchedAt: 1,
    },
  };
  return {
    run: { key, summary: "s", url: `https://j/browse/${key}`, createdAt: 1, mode: "multiroot",
      repos: [{ name: repo, path: `/r/${repo}`, isGit: true }], briefPaths: [] },
    column: "progress", ticketStatus: "In Progress", ticketCategory: "indeterminate",
    repos: [{ name: repo, path: `/r/${repo}`, branch: "b", dirty: false, ahead: 0, added: 0, removed: 0, files: 0 }],
    agent: { state: "working", lastActivityMs: 1, slug: null },
    windowOpen: true, prs, agents: [], ...over,
  };
};

describe("the inspector", () => {
  const open = (onSave = vi.fn(), runs: RunStatus[] = []) => {
    const r = render(<OrchestratorDrawer {...props({ onSave, runs, flows: [wired()] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    return { r, onSave };
  };

  it("says to select an edge when none is selected", () => {
    render(<OrchestratorDrawer {...props({ flows: [wired()] })} />);
    expect(screen.getByText(/select a connection/i)).toBeTruthy();
  });

  it("names the two ends of the selected edge", () => {
    open();
    const insp = screen.getByTestId("orch-inspector");
    expect(insp.textContent).toContain("ASM-1");
  });

  it("changes the condition", () => {
    const { onSave } = open();
    fireEvent.change(screen.getByLabelText("Condition"), { target: { value: "ci-failed" } });
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.edges[0].cond).toEqual({ kind: "ci-failed" });
  });

  it("offers no launch or seed action — those do not exist yet", () => {
    open();
    const insp = screen.getByTestId("orch-inspector");
    expect(insp.textContent).not.toMatch(/launch|seed/i);
  });

  it("does not offer a condition it has no input for", () => {
    // agent-idle-over needs a minute count and ticket-status-is needs a status
    // name; with no field for either, offering them would build a rule that waits
    // on a hardcoded 10 minutes or on the empty string.
    open();
    const values = Array.from(
      screen.getByLabelText("Condition").querySelectorAll("option"),
    ).map((o) => (o as HTMLOptionElement).value);
    expect(values).not.toContain("agent-idle-over");
    expect(values).not.toContain("ticket-status-is");
    expect(values).toContain("pr-merged");
  });

  it("edits the notify message on blur", () => {
    const { onSave } = open();
    const box = screen.getByLabelText("Notify message");
    fireEvent.change(box, { target: { value: "the migration has landed" } });
    fireEvent.blur(box);
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    const target = saved.nodes.find((n) => n.id === "n2")!;
    expect(target).toMatchObject({ kind: "notify", message: "the migration has landed" });
  });

  it("shows what the place currently looks like, from the board", () => {
    // Deviates from the brief's literal fixture here: wired()'s edge condition
    // is pr-merged, and describeCond's already-tested, off-limits behaviour for
    // pr-merged on an OPEN PR is "PR open" (see
    // test/unit/engine/orchestrator/conditions.test.ts:274) — never CI text, no
    // matter what the inspector does. To show describeCond's CI wording
    // actually reaching the user, this edge needs a CI condition instead; every
    // other node/PR fixture is unchanged.
    const ciWired = flow({
      nodes: wired().nodes,
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "ci-passed" }, action: "notify" }],
    });
    render(<OrchestratorDrawer {...props({ runs: [runStatus("ASM-1", "agent-flow")], flows: [ciWired] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    // 4 of 7 checks reported: describeCond's own wording, reaching a user for
    // the first time.
    expect(screen.getByTestId("orch-inspector").textContent).toContain("CI running, 4 of 7");
  });

  it("says the card is not on the board when the run is absent", () => {
    open(vi.fn(), []);
    expect(screen.getByTestId("orch-inspector").textContent).toMatch(/not on the board/i);
  });

  it("deletes the edge", () => {
    const { onSave } = open();
    fireEvent.click(screen.getByRole("button", { name: "Delete connection" }));
    expect((onSave.mock.calls.at(-1)![0] as Flow).edges).toEqual([]);
  });

  it("clears the selection itself when a connection is deleted, not just because the flow shrank", () => {
    // "stops showing an inspector once the edge is gone" (below) rerenders with
    // a brand-new flow whose edges array already lacks the id, so
    // `flow.edges.find(...) ?? null` returns null regardless of what `selEdge`
    // holds — that test would still pass even if `deleteEdge` never cleared the
    // selection. This one pins the clear itself: no rerender happens, so the
    // component's `flow` prop still carries e1 throughout. The only thing that
    // can make the inspector revert to its empty state is `setSelEdge(null)`
    // actually firing inside `deleteEdge` — a stale `selEdge` would otherwise
    // still resolve against the very same, unchanged edges array.
    open();
    fireEvent.click(screen.getByRole("button", { name: "Delete connection" }));
    expect(screen.getByText(/select a connection/i)).toBeTruthy();
  });

  it("stops showing an inspector once the edge is gone", () => {
    const { r } = open();
    r.rerender(<OrchestratorDrawer {...props({ flows: [flow({ nodes: wired().nodes, edges: [] })] })} />);
    expect(screen.getByText(/select a connection/i)).toBeTruthy();
  });
});

describe("arming", () => {
  it("offers Arm for a disarmed flow", () => {
    const onArm = vi.fn();
    render(<OrchestratorDrawer {...props({ onArm })} />);
    fireEvent.click(screen.getByRole("button", { name: "Arm" }));
    expect(onArm).toHaveBeenCalledWith("f1", true);
  });

  // The brief's own snippet asserted this with `getByText(/armed/i)`, which is
  // ambiguous the moment both controls render: the Arm button reads "Armed ·
  // disarm" and the footer's own span reads "Armed · watching 0 nodes" — both
  // are independent text-node leaves, so a bare /armed/i throws on multiple
  // matches instead of passing. Scoping to the footer's own wording sidesteps
  // that collision without losing the intent.
  it("offers disarm for an armed flow, and says it is armed", () => {
    const onArm = vi.fn();
    render(<OrchestratorDrawer {...props({ onArm, flows: [flow({ armed: true })] })} />);
    expect(screen.getByText(/armed · watching/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /disarm/i }));
    expect(onArm).toHaveBeenCalledWith("f1", false);
  });

  it("no longer claims arming is coming in a later phase", () => {
    render(<OrchestratorDrawer {...props()} />);
    expect(screen.queryByText(/next phase/i)).toBeNull();
  });

  it("Arm is the drawer's only filled control", () => {
    const { container } = render(<OrchestratorDrawer {...props()} />);
    const filled = container.querySelectorAll(".orch-arm");
    expect(filled).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Arm" }).className).toContain("orch-arm");
  });
});

describe("the resume banner", () => {
  const pending = [{ flowId: "f1", flowName: "Ship the migration", lines: ["Ship the migration: the migration has landed"] }];

  it("shows what is ready, and does not act on its own", () => {
    render(<OrchestratorDrawer {...props({ pendingResume: pending, flows: [flow({ armed: true })] })} />);
    const banner = screen.getByTestId("orch-resume");
    expect(banner.textContent).toContain("the migration has landed");
  });

  it("approves", () => {
    const onResumeApprove = vi.fn();
    render(<OrchestratorDrawer {...props({ pendingResume: pending, flows: [flow({ armed: true })], onResumeApprove })} />);
    fireEvent.click(screen.getByRole("button", { name: /^go$/i }));
    expect(onResumeApprove).toHaveBeenCalledWith("f1");
  });

  // Same collision as above, one level worse: with an armed flow AND a pending
  // resume both on screen, the drawer has TWO controls whose accessible name
  // contains "disarm" — the Arm toggle ("Armed · disarm") and the banner's own
  // button ("Disarm"). The brief's `{ name: /disarm/i }` matches both and
  // throws. An exact, case-matched "Disarm" only matches the banner's button.
  it("disarms instead", () => {
    const onResumeDisarm = vi.fn();
    render(<OrchestratorDrawer {...props({ pendingResume: pending, flows: [flow({ armed: true })], onResumeDisarm })} />);
    fireEvent.click(screen.getByRole("button", { name: "Disarm" }));
    expect(onResumeDisarm).toHaveBeenCalledWith("f1");
  });

  it("shows no banner when nothing is pending", () => {
    render(<OrchestratorDrawer {...props({ pendingResume: [] })} />);
    expect(screen.queryByTestId("orch-resume")).toBeNull();
  });

  it("shows no banner for a different flow's pending resume", () => {
    render(<OrchestratorDrawer {...props({ pendingResume: [{ ...pending[0], flowId: "other" }] })} />);
    expect(screen.queryByTestId("orch-resume")).toBeNull();
  });
});

describe("Reset", () => {
  const firedFlow = () => flow({
    nodes: [
      { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "ASM-1", repo: "agent-flow" },
      { id: "n2", kind: "notify", x: 320, y: 24, join: "any", message: "landed" },
    ],
    edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify", firedAt: 5, firedNote: "told you: landed" }],
  });

  it("shows a fired rule's receipt in the inspector", () => {
    render(<OrchestratorDrawer {...props({ flows: [firedFlow()] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    expect(screen.getByTestId("orch-inspector").textContent).toContain("told you: landed");
  });

  it("resets it", () => {
    const onResetEdge = vi.fn();
    render(<OrchestratorDrawer {...props({ flows: [firedFlow()], onResetEdge })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    fireEvent.click(screen.getByRole("button", { name: /reset/i }));
    expect(onResetEdge).toHaveBeenCalledWith("f1", "e1");
  });

  // The brief's own snippet rendered default props() here, whose default flow
  // (flow(), from this file's top-of-file fixture) has NO edges at all — so
  // getByTestId("orch-edge-e1") would throw "unable to find an element" before
  // the real assertion ever runs. wired() is this file's existing fixture with
  // exactly one unfired edge e1, which is what the test actually needs.
  it("offers no Reset for a rule that has not fired", () => {
    render(<OrchestratorDrawer {...props({ flows: [wired()] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    expect(screen.queryByRole("button", { name: /reset/i })).toBeNull();
  });
});
