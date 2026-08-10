// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import * as React from "react";
import { act, render, screen, fireEvent, within } from "@testing-library/react";
import { OrchestratorDrawer, DRAG_SEP } from "../../src/webview/OrchestratorDrawer";
import { ORCH_ANIM_MS } from "../../src/webview/orchestratorStyles";
import type { Flow } from "../../src/engine/orchestrator/model";
// The real store, so the "a new wire is never latched" test below is answered by
// the migration itself rather than by this file restating its rule. Its io is
// injected (see `FlowIo`), so importing it here costs no temp directory.
import { readFlows, writeFlow } from "../../src/engine/orchestrator/store";
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

// The grip persists its width through vscodeApi.getState/setState — the first
// consumer of either in this webview. Mocked the same way `send` is mocked in
// DeckApp.test.tsx etc: a plain vi.fn() pair, so each resize test can script
// exactly what a prior session left behind (or nothing, or garbage) without a
// real acquireVsCodeApi() (which does not exist under jsdom).
vi.mock("../../src/webview/vscodeApi", () => ({
  vscodeApi: { getState: vi.fn(() => undefined), setState: vi.fn() },
  // The missing ticket picker (Task 4b): unlike every other node this drawer
  // builds, a `planned` node needs a task connector the webview cannot reach,
  // so its control sends a message directly (via `send`) rather than going
  // through `onSave` like `addNotify` does. A plain vi.fn(), the same way
  // `send` is mocked in DeckApp.test.tsx.
  send: vi.fn(),
}));

import { vscodeApi, send } from "../../src/webview/vscodeApi";

const flow = (over: Partial<Flow> = {}): Flow => ({
  id: "f1", name: "Ship the migration", armed: false, createdAt: 1_000, nodes: [], edges: [], ...over,
});

/** Two modes, distinct ids and labels, so a test asserting "the option list is
 * the one the host sent" cannot pass against a coincidence with some other
 * hardcoded default. */
const MODES = [
  { id: "quick", label: "Quick pass" },
  { id: "careful", label: "Careful review" },
];

const props = (over: Partial<React.ComponentProps<typeof OrchestratorDrawer>> = {}) => ({
  flows: [flow()], openId: "f1", runs: [], pendingResume: [], promptModes: MODES,
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

// Task 5: the keyboard path. The toggle itself lives in this file (it is
// part of the drawer's own header, not flowList.tsx's concern); flowList.tsx
// and its own test file cover what the list view renders and how its rows
// behave once it is showing.
describe("the canvas/list view toggle", () => {
  it("defaults to the canvas — the toggle only ever narrows what a mouse user already had", () => {
    render(<OrchestratorDrawer {...props()} />);
    expect(screen.getByTestId("orch-canvas")).toBeTruthy();
    expect(screen.queryByTestId("orch-list")).toBeNull();
    expect(screen.getByRole("tab", { name: "Canvas" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "List" })).toHaveAttribute("aria-selected", "false");
  });

  it("switches to the list view and reports aria-selected on both tabs", () => {
    render(<OrchestratorDrawer {...props({ flows: [twoPlaces()] })} />);
    fireEvent.click(screen.getByRole("tab", { name: "List" }));
    expect(screen.queryByTestId("orch-canvas")).toBeNull();
    expect(screen.getByRole("tab", { name: "List" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Canvas" })).toHaveAttribute("aria-selected", "false");
  });

  it("renders the same flow's rules in the list — one model, two presentations", () => {
    render(<OrchestratorDrawer {...props({ flows: [wired()] })} />);
    fireEvent.click(screen.getByRole("tab", { name: "List" }));
    expect(screen.getByTestId("flowlist-row-e1")).toBeTruthy();
  });

  it("switches back to the canvas", () => {
    render(<OrchestratorDrawer {...props({ flows: [twoPlaces()] })} />);
    fireEvent.click(screen.getByRole("tab", { name: "List" }));
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    expect(screen.getByTestId("orch-canvas")).toBeTruthy();
    expect(screen.queryByTestId("orch-list")).toBeNull();
  });

  it("a rule reset from the list goes through the same onResetEdge the canvas uses", () => {
    const onResetEdge = vi.fn();
    const fired = flow({
      nodes: [
        { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "ASM-1", repo: "agent-flow" },
        { id: "n2", kind: "notify", x: 320, y: 24, join: "any", message: "landed" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify", firedAt: 5, firedNote: "told you" }],
    });
    render(<OrchestratorDrawer {...props({ flows: [fired], onResetEdge })} />);
    fireEvent.click(screen.getByRole("tab", { name: "List" }));
    fireEvent.click(within(screen.getByTestId("flowlist-row-e1")).getByRole("button", { name: "Reset" }));
    expect(onResetEdge).toHaveBeenCalledWith("f1", "e1");
  });

  // `removeNode`'s own guard already clears `selEdge` for the identical
  // hazard (a re-minted id landing a stale selection on a rule nobody
  // clicked, see its own comment) — but only for the canvas's OWN delete
  // paths. FlowList's Delete key calls `onSave` directly, bypassing that
  // guard entirely, until `onListSave`. `onSave` stays a mock (unchanged
  // `flow` prop) so switching back to Canvas renders e1 exactly as it was —
  // the only way to see the SELECTION itself cleared, not merely the row
  // having disappeared from a shrunk list.
  it("clears the canvas's edge selection when the list deletes that same rule", () => {
    const wired = flow({
      nodes: [
        { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "ASM-1", repo: "r" },
        { id: "n2", kind: "notify", x: 320, y: 24, join: "any", message: "done" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" }],
    });
    render(<OrchestratorDrawer {...props({ onSave: vi.fn(), flows: [wired] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    expect(screen.queryByText(/select a connection/i)).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "List" }));
    const row1 = screen.getByTestId("flowlist-row-e1");
    row1.focus();
    fireEvent.keyDown(row1, { key: "Delete" });
    fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
    expect(screen.getByText(/select a connection/i)).toBeTruthy();
  });
});

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

  // `isAgentNode` used to assert `n is PlaceNode | PlannedNode` from a body
  // that only checked `!== "notify"` — TypeScript never checks a predicate's
  // body against its claim, so a command node passed the guard and was
  // narrowed (wrongly) to PlannedNode, rendering a chip with a blank key,
  // "not taken" as its sub, and `aria-label="Remove undefined"`.
  it("excludes a command node from the agent tray, not just notify", () => {
    const existing = flow({
      nodes: [{ id: "n1", kind: "command", x: 0, y: 0, join: "any", commandId: "deploy" }],
    });
    render(<OrchestratorDrawer {...props({ flows: [existing] })} />);
    expect(screen.getByText(/Drag a card from the board to attach an agent/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
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

  // The top label used to fall through a `place ? … : planned ? … : "notify"`
  // ternary that gave every other kind the literal word "notify" — honest for
  // a real notify node, but a lie for a command, which `actionFor` derives as
  // `run`. Pins both the identifier (via `endLabel`) and the status line.
  it("labels a command node by its identifier, and says what it does rather than reading as notify", () => {
    const existing = flow({
      nodes: [{ id: "n1", kind: "command", x: 0, y: 0, join: "any", commandId: "deploy" }],
    });
    render(<OrchestratorDrawer {...props({ flows: [existing] })} />);
    const n1 = screen.getByTestId("orch-node-n1");
    expect(n1.textContent).toContain("deploy");
    expect(n1.textContent).not.toContain("notify");
    expect(n1.textContent).toContain("runs a command");
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

  // The missing ticket picker (Task 4b). Unlike every node above, a `planned`
  // node needs a task connector this webview cannot reach — nothing reachable
  // from src/webview/ may import fs/os/path/child_process, even transitively —
  // so this control only names the open flow to the host and lets deckView.ts's
  // native QuickPick sequence resolve the rest. It is an ordinary <button>, the
  // same as "+ Notify" beside it, which is what makes it keyboard-reachable for
  // free: no custom tab handling, no non-default tabIndex, nothing a screen
  // reader or a Tab key would treat differently from any other control on this
  // bar.
  it("offers an Add planned work control beside + Notify, as an ordinary keyboard-reachable button", () => {
    render(<OrchestratorDrawer {...props({ flows: [twoPlaces()] })} />);
    const btn = screen.getByRole("button", { name: "+ Add planned work" });
    expect(btn.tagName).toBe("BUTTON");
    expect(btn).not.toHaveAttribute("tabindex", "-1");
    expect(btn).not.toBeDisabled();
  });

  it("sends flow:addPlanned with the open flow's id — the host builds the node, not this webview", () => {
    render(<OrchestratorDrawer {...props({ flows: [twoPlaces()] })} />);
    fireEvent.click(screen.getByRole("button", { name: "+ Add planned work" }));
    expect(send).toHaveBeenCalledWith({ type: "flow:addPlanned", id: "f1" });
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

/** A place and planned work, with NOTHING wired between them yet — the fixture
 * the wiring tests need, as opposed to `placeAndPlanned()` further down, which
 * already carries the edge. */
const placeAndPlanned0 = () =>
  flow({
    nodes: [
      { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "ASM-1", repo: "agent-flow" },
      {
        id: "n2", kind: "planned", x: 320, y: 24, join: "any",
        ticketKey: "ASM-12", repos: ["agent-flow"], mode: "quick", dest: "worktree",
      },
    ],
  });

/** Which of this flow's rules the STORE latches — the ids of every edge that
 * comes back carrying an `error` after a real round trip through `writeFlow`
 * (which mirrors the derived action onto disk for an older build's sake) and
 * `readFlows` (whose `latchActionMismatches` stamps any stored action that
 * disagrees with its target). The real store, injected with an in-memory io,
 * rather than this file restating the migration's rule and then agreeing with
 * itself. */
const latchesFor = (f: Flow): string[] => {
  const files = new Map<string, string>();
  const io = {
    readDir: () => [...files.keys()].map((p) => p.slice(p.lastIndexOf("/") + 1)),
    readFile: (p: string) => files.get(p) ?? null,
    writeFile: (p: string, text: string) => { files.set(p, text); },
    remove: (p: string) => { files.delete(p); },
  };
  writeFlow(io, "/flows", f);
  return readFlows(io, "/flows").flatMap((x) =>
    x.edges.filter((e) => e.error !== undefined).map((e) => e.id),
  );
};

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

  it("creates an edge by dragging from a port onto another node", () => {
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
      expect.objectContaining({ from: "n1", to: "n2", cond: { kind: "pr-merged" } }),
    ]);
  });

  // The phase defect this closes: `finishWire` hardcoded `action: "notify"` for
  // every new wire regardless of its target, so wiring a place to planned work
  // produced an edge whose STORED action ("notify") disagreed with the action
  // its target implies ("launch") — which is exactly what
  // `latchActionMismatches` stamps with an error on the next read. The rule was
  // dead the moment it was drawn. An edge with NO stored action is the one shape
  // that migration can never latch (it skips `action === undefined`), and
  // `writeFlow` still puts the derived value on disk for an older build.
  it("records no action on a new wire, so the migration cannot latch it", () => {
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave, flows: [placeAndPlanned0()] })} />);
    fireEvent.pointerDown(screen.getByTestId("orch-port-out-n1"));
    fireEvent.pointerUp(screen.getByTestId("orch-node-n2"));
    const saved = onSave.mock.calls[0][0] as Flow;
    expect(saved.edges[0].action).toBeUndefined();
    expect(saved.edges[0]).not.toHaveProperty("action");
    // And the same edge, read back through the store's own migration, is not
    // latched — the guarantee the assertion above exists for.
    expect(latchesFor(saved)).toEqual([]);
  });

  // A rule out of a command node can only ever ask one thing: did that command
  // succeed. `evaluate.ts`'s `isMet` answers every OTHER kind from the source
  // place's `RunStatus`, and a command node has none — so a new wire seeded
  // with `pr-merged` here would be inert from the moment it was drawn.
  it("seeds a wire out of a command node with the one condition it can ask", () => {
    const onSave = vi.fn();
    const fromCommand = flow({
      nodes: [
        { id: "n1", kind: "command", x: 24, y: 24, join: "any", commandId: "deploy" },
        { id: "n2", kind: "notify", x: 320, y: 24, join: "any", message: "landed" },
      ],
    });
    render(<OrchestratorDrawer {...props({ onSave, flows: [fromCommand] })} />);
    fireEvent.pointerDown(screen.getByTestId("orch-port-out-n1"));
    fireEvent.pointerUp(screen.getByTestId("orch-node-n2"));
    const saved = onSave.mock.calls[0][0] as Flow;
    expect(saved.edges[0].cond).toEqual({ kind: "command-succeeded" });
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

  // The defect this fixes: an edge reaching a farther column had its label
  // land on an intermediate node in the same row, covering that node's own
  // title (observed as "ASM-12" rendering as "A_M-12"). n3 sits exactly on
  // the raw chord midpoint between n1 and n2's ports; it is nobody's
  // endpoint on e1, so it must be in the obstacle list and the label must
  // step off of it.
  it("steps a label off an intermediate node the chord passes through", () => {
    const withObstacle = flow({
      nodes: [
        { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "ASM-1", repo: "r" },
        { id: "n3", kind: "place", x: 344, y: 24, join: "any", runKey: "ASM-12", repo: "r" },
        { id: "n2", kind: "notify", x: 624, y: 24, join: "any", message: "landed" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" }],
    });

    const fromBox = { x: 24, y: 24, w: NODE_W, h: NODE_H };
    const toBox = { x: 624, y: 24, w: NODE_W, h: NODE_H };
    const obstacleBox = { x: 344, y: 24, w: NODE_W, h: NODE_H };
    const from = anchor(fromBox, "out");
    const to = anchor(toBox, "in");
    const rawMid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    const expectedMid = labelPoint(from, to, [obstacleBox]);
    // Sanity: this fixture actually exercises the obstacle path — the raw
    // midpoint really does sit on n3, so the expected point must differ from
    // it. If it didn't, the fixture (not the rule) would be at fault.
    expect(expectedMid).not.toEqual(rawMid);

    render(<OrchestratorDrawer {...props({ flows: [withObstacle] })} />);
    const label = screen.getByTestId("orch-edge-e1");
    expect(label.style.left).toBe(`${expectedMid.x}px`);
    expect(label.style.top).toBe(`${expectedMid.y}px`);

    // And directly: the rendered point must not fall inside n3's box.
    const lx = parseFloat(label.style.left);
    const ly = parseFloat(label.style.top);
    expect(lx >= obstacleBox.x && lx <= obstacleBox.x + obstacleBox.w &&
      ly >= obstacleBox.y && ly <= obstacleBox.y + obstacleBox.h).toBe(false);
  });

  // Same three-node shape, but the third node sits well clear of the chord
  // (a different row entirely). Its box is still in the obstacle list — this
  // pins that a harmless obstacle leaves the label exactly where it started.
  it("leaves the label at the chord midpoint when no obstacle is in the way", () => {
    const clear = flow({
      nodes: [
        { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "ASM-1", repo: "r" },
        { id: "n3", kind: "place", x: 344, y: 400, join: "any", runKey: "ASM-12", repo: "r" },
        { id: "n2", kind: "notify", x: 624, y: 24, join: "any", message: "landed" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" }],
    });

    const fromBox = { x: 24, y: 24, w: NODE_W, h: NODE_H };
    const toBox = { x: 624, y: 24, w: NODE_W, h: NODE_H };
    const from = anchor(fromBox, "out");
    const to = anchor(toBox, "in");
    const rawMid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };

    render(<OrchestratorDrawer {...props({ flows: [clear] })} />);
    const label = screen.getByTestId("orch-edge-e1");
    expect(label.style.left).toBe(`${rawMid.x}px`);
    expect(label.style.top).toBe(`${rawMid.y}px`);
  });

  // The design rule: an edge's own two endpoints are never obstacles for its
  // own label. n1 and n2 are placed close enough that the raw chord midpoint
  // sits inside BOTH of their boxes — if the endpoints were wrongly included
  // in the obstacle list, the label would be pushed off of it. Since they
  // are excluded, the label stays exactly on the raw midpoint.
  it("does not push a short edge's label away from its own endpoints", () => {
    const adjacent = flow({
      nodes: [
        { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "ASM-1", repo: "r" },
        { id: "n2", kind: "notify", x: 80, y: 24, join: "any", message: "landed" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" }],
    });

    const fromBox = { x: 24, y: 24, w: NODE_W, h: NODE_H };
    const toBox = { x: 80, y: 24, w: NODE_W, h: NODE_H };
    const from = anchor(fromBox, "out");
    const to = anchor(toBox, "in");
    const rawMid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    // Sanity: the raw midpoint really does land inside both endpoint boxes,
    // so this fixture actually exercises the exclusion rule rather than
    // passing vacuously.
    const inBox = (p: { x: number; y: number }, b: { x: number; y: number; w: number; h: number }) =>
      p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
    expect(inBox(rawMid, fromBox)).toBe(true);
    expect(inBox(rawMid, toBox)).toBe(true);

    render(<OrchestratorDrawer {...props({ flows: [adjacent] })} />);
    const label = screen.getByTestId("orch-edge-e1");
    expect(label.style.left).toBe(`${rawMid.x}px`);
    expect(label.style.top).toBe(`${rawMid.y}px`);
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

  it("survives a command-succeeded rule wired off a PLACE instead of a command node", () => {
    // The picker does not filter a rule's condition by its source node kind
    // (Tasks 9/10's job) — so nothing stops "command-succeeded" from landing
    // on an edge out of a place, same as `n1` below, which has a perfectly
    // real, fetched run status. `describeCond`'s own arm for this kind
    // throws rather than silently answering wrong (see conditions.ts) —
    // deliberately, since it should never be reachable — so `observationOf`
    // must refuse the CONDITION KIND itself before ever calling it, not only
    // guard on the source failing to be a place (which this fixture's source
    // is). This pins that the drawer renders the same "not on the board"
    // fallback instead of crashing.
    const placeSourced = flow({
      nodes: [
        { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "ASM-1", repo: "agent-flow" },
        { id: "n2", kind: "notify", x: 320, y: 24, join: "any", message: "landed" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "command-succeeded" }, action: "notify" }],
    });
    render(<OrchestratorDrawer {...props({ runs: [runStatus("ASM-1", "agent-flow")], flows: [placeSourced] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
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

/** A place feeding a planned node — the only pairing where BOTH acting verbs
 * have somewhere valid to land: `launch` at n2 (planned), or, symmetrically,
 * a `seed` edge could target n1 (place). n2 already carries a real mode/dest,
 * matching a planned node's own invariant that it is never created without
 * one — an armed launch cannot stop to ask. */
const placeAndPlanned = () =>
  flow({
    nodes: [
      { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "ASM-1", repo: "agent-flow" },
      {
        id: "n2", kind: "planned", x: 320, y: 24, join: "any",
        ticketKey: "ASM-12", repos: ["agent-flow"], mode: "quick", dest: "worktree",
      },
    ],
    edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" }],
  });

/** Two places — the pairing `seed` needs. */
const twoPlacesWired = () =>
  flow({
    nodes: [
      { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "ASM-1", repo: "agent-flow" },
      { id: "n2", kind: "place", x: 320, y: 24, join: "any", runKey: "ASM-2", repo: "agent-flow" },
    ],
    edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" }],
  });

describe("the acting verbs", () => {
  const openInspector = (f: Flow, over: Partial<React.ComponentProps<typeof OrchestratorDrawer>> = {}) => {
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave, flows: [f], ...over })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    return onSave;
  };

  it("offers launch, seed and notify — not just notify", () => {
    openInspector(placeAndPlanned());
    const values = Array.from(screen.getByLabelText("Action").querySelectorAll("option")).map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(values).toEqual(["launch", "seed", "notify"]);
  });

  it("selecting launch does not carry a mode onto the edge — it already lives on the target node", () => {
    // deckView.ts's performEdge reads a launch's mode from the target PLANNED
    // node (`node.mode`), never from `edge.mode` — that field is `seed`'s
    // alone (see FlowEdge.mode's own doc comment). Mirroring the value onto
    // the edge too would give a launch two sources of truth for one fact,
    // the exact bug class a reviewer already caught once in this plan.
    const before = placeAndPlanned();
    const onSave = openInspector(before);
    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "launch" } });
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.edges[0].action).toBe("launch");
    expect(saved.edges[0].mode).toBeUndefined();
    // The node already carried both — switching the verb doesn't need to
    // touch them, but they must still be there for the USING clause to show.
    const target = saved.nodes.find((n) => n.id === "n2") as { mode: string; dest: string };
    expect(target.mode).toBe("quick");
    expect(target.dest).toBe("worktree");
  });

  it("selecting seed writes the action and a mode onto the edge", () => {
    const onSave = openInspector(twoPlacesWired());
    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "seed" } });
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    // Neither node here carries a mode of its own (a place has none), so the
    // fallback is the first configured mode — MODES[0].
    expect(saved.edges[0]).toMatchObject({ action: "seed", mode: "quick" });
  });

  it("selecting notify clears the mode", () => {
    const withSeedMode = twoPlacesWired();
    withSeedMode.edges[0] = { ...withSeedMode.edges[0], action: "seed", mode: "careful" };
    const onSave = openInspector(withSeedMode);
    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "notify" } });
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.edges[0].action).toBe("notify");
    expect(saved.edges[0].mode).toBeUndefined();
  });

  it("changing the mode for a launch writes only to the target node, never the edge", () => {
    const launching = placeAndPlanned(); // edge action is "notify"; give it "launch" with no edge.mode
    launching.edges[0] = { ...launching.edges[0], action: "launch" };
    const onSave = openInspector(launching);
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "careful" } });
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    // Written where deckView.ts's performEdge actually reads a launch's
    // mode from — the target planned node's own field.
    expect((saved.nodes.find((n) => n.id === "n2") as { mode: string }).mode).toBe("careful");
    // And NOT mirrored onto the edge — one field, one meaning, no second copy
    // that could later diverge from the node's.
    expect(saved.edges[0].mode).toBeUndefined();
  });

  it("changing the mode for a seed does not touch any node", () => {
    const seeding = twoPlacesWired();
    seeding.edges[0] = { ...seeding.edges[0], action: "seed", mode: "quick" };
    const onSave = openInspector(seeding);
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "careful" } });
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.edges[0].mode).toBe("careful");
    expect(saved.nodes).toBe(seeding.nodes); // the exact same array — nothing was mapped
  });

  it("the destination selector appears for launch and not for seed or notify", () => {
    const launching = placeAndPlanned();
    launching.edges[0] = { ...launching.edges[0], action: "launch" }; // a launch edge carries no mode of its own
    const r1 = render(<OrchestratorDrawer {...props({ flows: [launching] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    expect(screen.getByLabelText("Destination")).toBeTruthy();
    r1.unmount();

    const seeding = twoPlacesWired();
    seeding.edges[0] = { ...seeding.edges[0], action: "seed", mode: "quick" };
    const r2 = render(<OrchestratorDrawer {...props({ flows: [seeding] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    expect(screen.queryByLabelText("Destination")).toBeNull();
    r2.unmount();

    render(<OrchestratorDrawer {...props({ flows: [twoPlacesWired()] })} />); // action: notify
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    expect(screen.queryByLabelText("Destination")).toBeNull();
  });

  it("changing the destination writes it onto the target node, not the edge", () => {
    const launching = placeAndPlanned();
    launching.edges[0] = { ...launching.edges[0], action: "launch" };
    const onSave = openInspector(launching);
    fireEvent.change(screen.getByLabelText("Destination"), { target: { value: "new-window" } });
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect((saved.nodes.find((n) => n.id === "n2") as { dest: string }).dest).toBe("new-window");
    expect(saved.edges[0]).not.toHaveProperty("dest");
  });

  it("a launch edge whose target is a place is refused with a visible reason", () => {
    const misWired = twoPlacesWired();
    misWired.edges[0] = { ...misWired.edges[0], action: "launch" };
    render(<OrchestratorDrawer {...props({ flows: [misWired] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    const insp = screen.getByTestId("orch-inspector");
    expect(insp.textContent).toMatch(/launch needs planned work/i);
    // And it does not render the USING controls a valid pairing would.
    expect(screen.queryByLabelText("Mode")).toBeNull();
    expect(screen.queryByLabelText("Destination")).toBeNull();
  });

  it("the mirror: a seed edge whose target is planned work is refused with a visible reason", () => {
    const misWired = placeAndPlanned();
    misWired.edges[0] = { ...misWired.edges[0], action: "seed" };
    render(<OrchestratorDrawer {...props({ flows: [misWired] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    const insp = screen.getByTestId("orch-inspector");
    expect(insp.textContent).toMatch(/seed needs a place/i);
    expect(screen.queryByLabelText("Mode")).toBeNull();
  });

  it("does not spend red on a mis-wired verb — nothing has tried and failed yet", () => {
    const misWired = twoPlacesWired();
    misWired.edges[0] = { ...misWired.edges[0], action: "launch" };
    const { container } = render(<OrchestratorDrawer {...props({ flows: [misWired] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    expect(container.querySelector(".orch-obs .err")).toBeNull();
    const reason = screen.getByText(/launch needs planned work/i);
    expect(reason.getAttribute("style")).toContain("--dim");
    expect(reason.getAttribute("style")).not.toContain("--c-danger");
  });

  it("renders the mode list the host sent, not a hardcoded one", () => {
    const hostModes = [{ id: "custom-1", label: "A mode only this test made up" }];
    const launching = flow({
      nodes: [
        { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "ASM-1", repo: "agent-flow" },
        {
          id: "n2", kind: "planned", x: 320, y: 24, join: "any",
          ticketKey: "ASM-12", repos: ["agent-flow"], mode: "custom-1", dest: "worktree",
        },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "launch" }],
    });
    render(<OrchestratorDrawer {...props({ flows: [launching], promptModes: hostModes })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    const options = Array.from(screen.getByLabelText("Mode").querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toEqual(["A mode only this test made up"]);
  });

  it("shows a deleted mode explicitly, rather than silently displaying the first configured one", () => {
    // A `<select>` whose `value` matches none of its `<option>`s does not render
    // blank — the browser falls back to its FIRST option, selected. Without an
    // option for the actual stored value, the inspector would show "Quick pass"
    // for a target node whose mode is really "deleted-mode" — a launch `modeFor`
    // will in fact refuse, described here as if it will run.
    const launching = placeAndPlanned();
    launching.edges[0] = { ...launching.edges[0], action: "launch" };
    launching.nodes[1] = { ...(launching.nodes[1] as any), mode: "deleted-mode" };
    render(<OrchestratorDrawer {...props({ flows: [launching] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    const select = screen.getByLabelText("Mode") as HTMLSelectElement;
    expect(select.value).toBe("deleted-mode");
    expect(select.selectedOptions[0].textContent).toContain("deleted-mode");
    // The real, configured modes are still all there, just not what's selected.
    const options = Array.from(select.querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toEqual(
      expect.arrayContaining(MODES.map((m) => m.label)),
    );
  });

  it("shows the target's identifier in mono, house style for an identifier", () => {
    const launching = placeAndPlanned();
    launching.edges[0] = { ...launching.edges[0], action: "launch" };
    render(<OrchestratorDrawer {...props({ flows: [launching] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    // "ASM-12" renders three times — the canvas node's own label (mono via a
    // CSS class, not inline style), the "Connection · A → B" header (already
    // covered by an earlier test), and the THEN clause this test is about.
    // Scoped to the inspector so the canvas node's match — which has no
    // inline style to assert on — is excluded, not silently counted as a pass.
    const matches = within(screen.getByTestId("orch-inspector")).getAllByText("ASM-12");
    expect(matches.length).toBe(2);
    for (const m of matches) expect(m.getAttribute("style")).toContain("mono");
  });

  it("offers a note for launch and for seed, but not for notify", () => {
    const launching = placeAndPlanned();
    launching.edges[0] = { ...launching.edges[0], action: "launch" };
    const r1 = render(<OrchestratorDrawer {...props({ flows: [launching] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    expect(screen.getByLabelText("Note")).toBeTruthy();
    r1.unmount();

    const seeding = twoPlacesWired();
    seeding.edges[0] = { ...seeding.edges[0], action: "seed", mode: "quick" };
    const r2 = render(<OrchestratorDrawer {...props({ flows: [seeding] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    expect(screen.getByLabelText("Note")).toBeTruthy();
    r2.unmount();

    render(<OrchestratorDrawer {...props({ flows: [twoPlacesWired()] })} />); // action: notify
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    expect(screen.queryByLabelText("Note")).toBeNull();
  });

  it("typing a note saves it on the edge, on blur", () => {
    const launching = placeAndPlanned();
    launching.edges[0] = { ...launching.edges[0], action: "launch" };
    const onSave = openInspector(launching);
    const box = screen.getByLabelText("Note");
    fireEvent.change(box, { target: { value: "watch for the flaky upload test" } });
    fireEvent.blur(box);
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.edges[0].note).toBe("watch for the flaky upload test");
  });

  it("selecting notify clears the note, the same way it already clears the mode", () => {
    const withNote = twoPlacesWired();
    withNote.edges[0] = { ...withNote.edges[0], action: "seed", mode: "careful", note: "keep an eye on this one" };
    const onSave = openInspector(withNote);
    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "notify" } });
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.edges[0].action).toBe("notify");
    expect(saved.edges[0].mode).toBeUndefined();
    expect(saved.edges[0].note).toBeUndefined();
  });

  it("switching from seed to launch leaves an existing note alone", () => {
    // twoPlacesWired's target is a place, so switching to `launch` here is
    // itself a mismatch (see `actionMismatch`) — irrelevant to this test,
    // which is only about whether `withAction`'s own edge write drops the
    // note, not about what the inspector renders for a mismatched pairing.
    const seeding = twoPlacesWired();
    seeding.edges[0] = { ...seeding.edges[0], action: "seed", mode: "careful", note: "keep an eye on this one" };
    const onSave = openInspector(seeding);
    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "launch" } });
    const afterLaunch = onSave.mock.calls.at(-1)![0] as Flow;
    expect(afterLaunch.edges[0].action).toBe("launch");
    expect(afterLaunch.edges[0].note).toBe("keep an eye on this one");
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

describe("an errored rule", () => {
  /** The same graph as `firedFlow`, but the edge tried and FAILED: `error` with no
   * `firedAt`. `evaluate.ts` settles on that, so this edge never fires again. */
  const erroredFlow = (over: Partial<Flow> = {}) => flow({
    nodes: [
      { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "ASM-1", repo: "agent-flow" },
      { id: "n2", kind: "notify", x: 320, y: 24, join: "any", message: "landed" },
    ],
    edges: [{
      id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "launch",
      error: "Couldn't launch ASM-12: no worktree",
    }],
    ...over,
  });

  it("offers Reset — it is settled, so without one it is a dead end", () => {
    const onResetEdge = vi.fn();
    render(<OrchestratorDrawer {...props({ flows: [erroredFlow()], onResetEdge })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    fireEvent.click(screen.getByRole("button", { name: /reset/i }));
    expect(onResetEdge).toHaveBeenCalledWith("f1", "e1");
  });

  it("shows the error text rather than the waiting line", () => {
    // `runs` is deliberately non-empty and matching, so `observation()` WOULD
    // return a real waiting sentence here. Without that, an empty `runs` array
    // makes the drawer fall back to "this card is not on the board right now" and
    // the test could pass while still rendering the waiting branch.
    render(<OrchestratorDrawer {...props({ flows: [erroredFlow()], runs: [runStatus("ASM-1", "agent-flow")] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    const insp = screen.getByTestId("orch-inspector");
    expect(insp.textContent).toContain("Couldn't launch ASM-12: no worktree");
    expect(insp.textContent).not.toContain("not on the board");
    // "PR open" is exactly what describeCond returns for pr-merged against this
    // fixture's OPEN pull request — i.e. the waiting line this branch replaces.
    expect(insp.textContent).not.toContain("PR open");
  });

  it("spends --c-danger on it — a rule that tried and failed is a real failure", () => {
    const { container } = render(<OrchestratorDrawer {...props({ flows: [erroredFlow()] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    const err = container.querySelector(".orch-obs .err");
    expect(err).not.toBeNull();
    expect(err!.textContent).toBe("Couldn't launch ASM-12: no worktree");
    // And it is NOT wearing the done-coloured receipt class.
    expect(container.querySelector(".orch-obs .fired")).toBeNull();
  });

  it("lets the error win over a receipt when a hand-edited flow carries both", () => {
    const both = erroredFlow({
      edges: [{
        id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "launch",
        firedAt: 5, firedNote: "told you: landed", error: "Couldn't launch ASM-12: no worktree",
      }],
    });
    render(<OrchestratorDrawer {...props({ flows: [both] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    const insp = screen.getByTestId("orch-inspector");
    expect(insp.textContent).toContain("Couldn't launch ASM-12: no worktree");
    expect(insp.textContent).not.toContain("told you: landed");
  });

  it("says so in the footer rather than claiming an armed flow is watching", () => {
    render(<OrchestratorDrawer {...props({ flows: [erroredFlow({ armed: true })] })} />);
    expect(screen.getByText(/armed · 1 rule stalled/i)).toBeTruthy();
    expect(screen.queryByText(/watching/i)).toBeNull();
  });

  it("counts the stalled rules", () => {
    const two = erroredFlow({
      armed: true,
      edges: [
        { id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "launch", error: "boom" },
        { id: "e2", from: "n1", to: "n2", cond: { kind: "ci-passed" }, action: "seed", error: "bang" },
      ],
    });
    render(<OrchestratorDrawer {...props({ flows: [two] })} />);
    expect(screen.getByText(/armed · 2 rules stalled/i)).toBeTruthy();
  });

  it("marks the footer dot as stalled, not as healthy", () => {
    const { container } = render(<OrchestratorDrawer {...props({ flows: [erroredFlow({ armed: true })] })} />);
    expect(container.querySelector(".orch-ft .live.stalled")).not.toBeNull();
  });

  it("still says it is watching when an armed flow has no errored rule", () => {
    // The other side of the same branch: a fired-but-not-errored edge is not a
    // stall, and the footer must not start crying failure over a rule that ran.
    const fired = erroredFlow({
      armed: true,
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify", firedAt: 5, firedNote: "told you: landed" }],
    });
    const { container } = render(<OrchestratorDrawer {...props({ flows: [fired] })} />);
    expect(screen.getByText(/armed · watching/i)).toBeTruthy();
    expect(screen.queryByText(/stalled/i)).toBeNull();
    expect(container.querySelector(".orch-ft .live.stalled")).toBeNull();
  });

  it("leaves a disarmed flow's footer alone — 'Not armed' makes no claim to correct", () => {
    render(<OrchestratorDrawer {...props({ flows: [erroredFlow({ armed: false })] })} />);
    expect(screen.getByText("Not armed")).toBeTruthy();
    expect(screen.queryByText(/stalled/i)).toBeNull();
  });
});

// The grip that resizes the drawer. `.orch`'s width lives in `--orch-w`, set as
// an inline style on the `<aside>` — reading `orch.style.getPropertyValue` is
// the width itself, not a proxy for it.
describe("resizing", () => {
  const grip = () => screen.getByRole("separator", { name: /resize/i });
  const widthOf = (container: HTMLElement) =>
    (container.querySelector(".orch") as HTMLElement).style.getPropertyValue("--orch-w");

  it("exposes the grip as a focusable vertical separator", () => {
    render(<OrchestratorDrawer {...props()} />);
    const g = grip();
    expect(g).toHaveAttribute("aria-orientation", "vertical");
    expect(g.tabIndex).toBe(0);
  });

  it("starts at the 560px default when nothing is stored", () => {
    const { container } = render(<OrchestratorDrawer {...props()} />);
    expect(widthOf(container)).toBe("560px");
  });

  // pointerDown is fired on its own (its implicit act() flush is what lets the
  // resize effect above actually attach its window listeners), and the move +
  // up pair is driven inside one manual act() together — the same split the
  // node-drag tests above use for their StrictMode and stale-ref races. Not
  // exercising either race here (there is no async gap between this grip's
  // move and up), but matching the split keeps the listener attached before
  // the move it needs to observe, rather than dispatching a move no listener
  // is there yet to catch.
  it("dragging the grip changes the width", () => {
    const { container } = render(<OrchestratorDrawer {...props()} />);
    fireEvent.pointerDown(grip(), { clientX: 300 });
    act(() => {
      // Left border pulled 40px further left grows the (right-anchored) drawer
      // by 40px: 560 + (300 - 260) = 600.
      fireEvent.pointerMove(window, { clientX: 260 });
      fireEvent.pointerUp(window);
    });
    expect(widthOf(container)).toBe("600px");
  });

  it("persists the width via vscodeApi.setState once the drag ends", () => {
    render(<OrchestratorDrawer {...props()} />);
    fireEvent.pointerDown(grip(), { clientX: 300 });
    act(() => {
      fireEvent.pointerMove(window, { clientX: 260 });
      fireEvent.pointerUp(window);
    });
    expect(vscodeApi.setState).toHaveBeenCalledWith({ orchWidth: 600 });
  });

  it("clamps the width at the floor", () => {
    const { container } = render(<OrchestratorDrawer {...props()} />);
    fireEvent.pointerDown(grip(), { clientX: 300 });
    act(() => {
      // Dragged hugely toward "narrower" — far past the 420px floor.
      fireEvent.pointerMove(window, { clientX: 900 });
      fireEvent.pointerUp(window);
    });
    expect(widthOf(container)).toBe("420px");
  });

  // The ceiling is read from window.innerWidth at drag time (not baked in at
  // mount), so this shrinks the viewport AFTER mounting at the default width,
  // then drags hugely toward "wider" — isolating the live clamp from whatever
  // clamping mounting itself might also apply.
  it("clamps the width at the ceiling, derived from the viewport", () => {
    const { container } = render(<OrchestratorDrawer {...props()} />);
    const prevWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    try {
      fireEvent.pointerDown(grip(), { clientX: 300 });
      act(() => {
        fireEvent.pointerMove(window, { clientX: -900 });
        fireEvent.pointerUp(window);
      });
      // Ceiling = max(420, innerWidth - 340) = max(420, 460) = 460.
      expect(widthOf(container)).toBe("460px");
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: prevWidth });
    }
  });

  it("resizes with arrow keys — ArrowLeft grows, ArrowRight shrinks", () => {
    const { container } = render(<OrchestratorDrawer {...props()} />);
    fireEvent.keyDown(grip(), { key: "ArrowLeft" });
    expect(widthOf(container)).toBe("576px");
    fireEvent.keyDown(grip(), { key: "ArrowRight" });
    fireEvent.keyDown(grip(), { key: "ArrowRight" });
    expect(widthOf(container)).toBe("544px");
    expect(vscodeApi.setState).toHaveBeenLastCalledWith({ orchWidth: 544 });
  });

  it("ignores keys other than the two arrow keys", () => {
    const { container } = render(<OrchestratorDrawer {...props()} />);
    fireEvent.keyDown(grip(), { key: "Enter" });
    expect(widthOf(container)).toBe("560px");
  });

  it("honours a stored width from a previous session on mount", () => {
    vi.mocked(vscodeApi.getState).mockReturnValueOnce({ orchWidth: 620 });
    const { container } = render(<OrchestratorDrawer {...props()} />);
    expect(widthOf(container)).toBe("620px");
  });

  it("falls back to the default width when the stored value is corrupt", () => {
    // A future version's shape, or a hand-edited value — either way, not the
    // number this version expects.
    vi.mocked(vscodeApi.getState).mockReturnValueOnce({ orchWidth: "wide" } as never);
    expect(() => render(<OrchestratorDrawer {...props()} />)).not.toThrow();
    expect(widthOf(document.body)).toBe("560px");
  });

  it("falls back to the default width when getState itself throws", () => {
    vi.mocked(vscodeApi.getState).mockImplementationOnce(() => {
      throw new Error("state store unavailable");
    });
    expect(() => render(<OrchestratorDrawer {...props()} />)).not.toThrow();
    expect(widthOf(document.body)).toBe("560px");
  });

  it("does not throw when persisting the width fails", () => {
    vi.mocked(vscodeApi.setState).mockImplementationOnce(() => {
      throw new Error("state store unavailable");
    });
    render(<OrchestratorDrawer {...props()} />);
    expect(() => fireEvent.keyDown(grip(), { key: "ArrowLeft" })).not.toThrow();
  });
});

// Resize and Expand fix a graph too wide for the drawer to FIT; neither says
// anything when one still doesn't fit, which was half of the original
// defect ("clips with no affordance"). This cue is the other half.
describe("the clipped-edge fade", () => {
  const grip = () => screen.getByRole("separator", { name: /resize/i });

  it("appears when a node's own right edge falls past the graph's visible width", () => {
    // Default width is 560px (see "resizing" above); GRAPH_H_INSET (34) puts
    // the graph's own inner width at 526. A place node is NODE_W (168) wide,
    // so x=500 puts its right edge at 668 — comfortably past the fold.
    const wide = flow({
      nodes: [{ id: "n1", kind: "place", x: 500, y: 24, join: "any", runKey: "ASM-1", repo: "r" }],
    });
    render(<OrchestratorDrawer {...props({ flows: [wide] })} />);
    expect(screen.getByTestId("orch-graph-fade")).toBeTruthy();
  });

  it("does not appear when every node comfortably fits", () => {
    const fits = flow({
      nodes: [{ id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "ASM-1", repo: "r" }],
    });
    render(<OrchestratorDrawer {...props({ flows: [fits] })} />);
    expect(screen.queryByTestId("orch-graph-fade")).toBeNull();
  });

  it("does not appear on an empty flow — never decoration on a graph with nothing to clip", () => {
    render(<OrchestratorDrawer {...props()} />);
    expect(screen.queryByTestId("orch-graph-fade")).toBeNull();
  });

  it("disappears once the drawer is widened enough to clear the node it was warning about", () => {
    // x=368 + NODE_W (168) = 536, ten pixels past the default 526px inner
    // width — clipped at the default width, cleared by a single ArrowLeft
    // (+16px, see RESIZE_STEP): 542 >= 536.
    const barelyClipped = flow({
      nodes: [{ id: "n1", kind: "place", x: 368, y: 24, join: "any", runKey: "ASM-1", repo: "r" }],
    });
    render(<OrchestratorDrawer {...props({ flows: [barelyClipped] })} />);
    expect(screen.getByTestId("orch-graph-fade")).toBeTruthy();
    fireEvent.keyDown(grip(), { key: "ArrowLeft" });
    expect(screen.queryByTestId("orch-graph-fade")).toBeNull();
  });
});

// The Expand toggle: a state on top of Task 3's width plumbing, not a second
// mechanism — see OrchestratorDrawer.tsx's own comment on `renderWidth`.
describe("expanding", () => {
  const grip = () => screen.queryByRole("separator", { name: /resize/i });
  const toggle = () => screen.getByRole("button", { name: "Expand" });
  const widthOf = (container: HTMLElement) =>
    (container.querySelector(".orch") as HTMLElement).style.getPropertyValue("--orch-w");

  it("expanding sets the full (viewport) width", () => {
    const { container } = render(<OrchestratorDrawer {...props()} />);
    fireEvent.click(toggle());
    expect(widthOf(container)).toBe(`${window.innerWidth}px`);
  });

  it("reports its state via aria-pressed", () => {
    render(<OrchestratorDrawer {...props()} />);
    expect(toggle()).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute("aria-pressed", "true");
  });

  // Resized first to a width distinct from the 560px default (three
  // ArrowLeft presses: 560 + 3*16 = 608), so a wrong implementation that
  // collapses back to the DEFAULT rather than the user's own prior width
  // cannot pass by coincidence.
  it("collapsing restores the prior custom width, not the default", () => {
    const { container } = render(<OrchestratorDrawer {...props()} />);
    const g = grip()!;
    fireEvent.keyDown(g, { key: "ArrowLeft" });
    fireEvent.keyDown(g, { key: "ArrowLeft" });
    fireEvent.keyDown(g, { key: "ArrowLeft" });
    expect(widthOf(container)).toBe("608px");
    fireEvent.click(toggle()); // expand
    expect(widthOf(container)).toBe(`${window.innerWidth}px`);
    fireEvent.click(toggle()); // collapse
    expect(widthOf(container)).toBe("608px");
  });

  // "Expanding while already expanded" cannot be reached by clicking the
  // SAME toggle twice through two separately-flushed fireEvent calls — the
  // second click reads the now-updated state and collapses, which is
  // correct toggle behaviour, not a re-expand. What CAN legitimately expand
  // "again" is two activations landing in the same React batch (e.g. a
  // rapid double click before a re-render) — driven here inside one act(),
  // per this file's own convention for pointer/keyboard sequences whose
  // ordering matters. The functional-updater form in `toggleExpanded`
  // (`setExpanded(v => !v)`) makes two same-batch clicks a correct, complete
  // round trip: expand then collapse, landing back on the exact prior
  // custom width — not some drifted value a stale-closure implementation
  // (`setExpanded(!expanded)`) would produce by having both clicks read the
  // same pre-batch `false` and both "expand".
  it("two activations landing in the same tick cancel out — no width drift", () => {
    const { container } = render(<OrchestratorDrawer {...props()} />);
    const g = grip()!;
    fireEvent.keyDown(g, { key: "ArrowLeft" });
    fireEvent.keyDown(g, { key: "ArrowLeft" });
    expect(widthOf(container)).toBe("592px"); // 560 + 2*16
    act(() => {
      fireEvent.click(toggle());
      fireEvent.click(toggle());
    });
    expect(widthOf(container)).toBe("592px");
  });

  // Decision: the grip does not make sense while expanded — there is
  // nothing further to drag to — so it is removed from the DOM entirely
  // (see OrchestratorDrawer.tsx's comment on the grip's conditional
  // rendering), not merely disabled. It reappears the moment the drawer
  // collapses.
  it("hides the resize grip while expanded, and restores it on collapse", () => {
    render(<OrchestratorDrawer {...props()} />);
    expect(grip()).not.toBeNull();
    fireEvent.click(toggle());
    expect(grip()).toBeNull();
    fireEvent.click(toggle());
    expect(grip()).not.toBeNull();
  });

  // Decision: `expanded` is session-only and is NOT part of what
  // `persistWidth`/`readPersistedWidth` write or read — only the resized
  // width is durable. A remount always starts collapsed, even when a
  // custom width was persisted, so a past session left mid-review of one
  // large flow can never silently reopen with the board hidden.
  it("does not persist the expanded flag across a remount — only the width does", () => {
    vi.mocked(vscodeApi.getState)
      .mockReturnValueOnce({ orchWidth: 640 })
      .mockReturnValueOnce({ orchWidth: 640 });
    const first = render(<OrchestratorDrawer {...props()} />);
    fireEvent.click(within(first.container).getByRole("button", { name: "Expand" }));
    expect(widthOf(first.container)).toBe(`${window.innerWidth}px`);
    first.unmount();

    const second = render(<OrchestratorDrawer {...props()} />);
    expect(widthOf(second.container)).toBe("640px");
    expect(within(second.container).getByRole("button", { name: "Expand" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(within(second.container).queryByRole("separator", { name: /resize/i })).not.toBeNull();
  });
});

// Task 6: the keyboard path can build a flow, not just edit one someone else
// wired with a mouse. Adding a notify terminal and planned work already had
// ordinary buttons (Task 4b) — they only ever rendered in the canvas branch,
// so the gap this closes is that they now render in the List view too, plus
// the one node kind with NO keyboard route at all until now: a place, which
// could previously only arrive by dragging a Deck card onto the tray or
// canvas.
describe("the list view's add-node controls", () => {
  const openList = (over: Partial<React.ComponentProps<typeof OrchestratorDrawer>> = {}) => {
    render(<OrchestratorDrawer {...props(over)} />);
    fireEvent.click(screen.getByRole("tab", { name: "List" }));
  };

  it("offers + Notify, + Add planned work and a place picker in the list view", () => {
    openList({ flows: [twoPlaces()] });
    expect(screen.getByRole("button", { name: "+ Notify" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ Add planned work" })).toBeTruthy();
    expect(screen.getByLabelText("Add a place")).toBeTruthy();
  });

  it("+ Notify works from the list view too, through the same addNotify the canvas uses", () => {
    const onSave = vi.fn();
    openList({ onSave, flows: [twoPlaces()] });
    fireEvent.click(screen.getByRole("button", { name: "+ Notify" }));
    const saved = onSave.mock.calls[0][0] as Flow;
    expect(saved.nodes.filter((n) => n.kind === "notify")).toHaveLength(1);
  });

  it("+ Add planned work sends flow:addPlanned from the list view too", () => {
    openList({ flows: [twoPlaces()] });
    fireEvent.click(screen.getByRole("button", { name: "+ Add planned work" }));
    expect(send).toHaveBeenCalledWith({ type: "flow:addPlanned", id: "f1" });
  });

  it("the place picker is an ordinary, keyboard-navigable select", () => {
    openList({ flows: [flow()], runs: [runStatus("ASM-1", "agent-flow")] });
    const select = screen.getByLabelText("Add a place") as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    expect(select).not.toHaveAttribute("tabindex", "-1");
    expect(select).not.toBeDisabled();
  });

  it("choosing a run from the place picker adds it, through the same attachAt the drag path uses", () => {
    const onSave = vi.fn();
    openList({ onSave, flows: [flow()], runs: [runStatus("ASM-1", "agent-flow")] });
    fireEvent.change(screen.getByLabelText("Add a place"), { target: { value: `ASM-1${DRAG_SEP}agent-flow` } });
    const saved = onSave.mock.calls[0][0] as Flow;
    expect(saved.nodes).toEqual([
      expect.objectContaining({ kind: "place", runKey: "ASM-1", repo: "agent-flow" }),
    ]);
  });

  it("excludes a run/repo pair already attached to this flow — choosing it again would silently do nothing", () => {
    const already = flow({ nodes: [{ id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-1", repo: "agent-flow" }] });
    openList({ flows: [already], runs: [runStatus("ASM-1", "agent-flow")] });
    const options = Array.from(screen.getByLabelText("Add a place").querySelectorAll("option")).map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(options).not.toContain(`ASM-1${DRAG_SEP}agent-flow`);
  });

  it("offers every repo of a multi-repo run, not only whichever one an agent happens to be bound to", () => {
    const twoRepo = runStatus("ASM-1", "web", {
      repos: [
        { name: "web", path: "/r/web", branch: "b", dirty: false, ahead: 0, added: 0, removed: 0, files: 0 },
        { name: "api", path: "/r/api", branch: "b", dirty: false, ahead: 0, added: 0, removed: 0, files: 0 },
      ],
    });
    openList({ flows: [flow()], runs: [twoRepo] });
    const options = Array.from(screen.getByLabelText("Add a place").querySelectorAll("option")).map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(options).toContain(`ASM-1${DRAG_SEP}web`);
    expect(options).toContain(`ASM-1${DRAG_SEP}api`);
  });
});

describe("Arm is reachable by keyboard", () => {
  // The spend confirmation Arm can trigger (`showWarningMessage(..., { modal:
  // true }, ...)` in deckView.ts) is a native VS Code modal — VS Code owns its
  // own keyboard handling for that, so there is nothing for THIS webview to
  // prove about it beyond Arm itself being an ordinary, reachable control.
  it("Arm is a real button, not styled inert", () => {
    render(<OrchestratorDrawer {...props()} />);
    const btn = screen.getByRole("button", { name: "Arm" });
    expect(btn.tagName).toBe("BUTTON");
    expect(btn).not.toHaveAttribute("tabindex", "-1");
    expect(btn).not.toBeDisabled();
  });
});

describe("building a whole flow from the keyboard", () => {
  // The claim the task makes: a place, a rule and its condition and action —
  // constructed with no pointer gesture at all, from the List view alone.
  // Every step below re-renders with the flow the previous step actually
  // saved (the same pattern flowList.test.tsx's own delete tests use), since
  // each control here reads the live `flow` prop, not a store this test fakes.
  it("adds a place, adds a notify node, and wires a rule between them", () => {
    const onSave = vi.fn();
    const initial = props({ onSave, flows: [flow()], runs: [runStatus("ASM-1", "agent-flow")] });
    const { rerender } = render(<OrchestratorDrawer {...initial} />);
    const rerenderWith = (next: Flow) => rerender(<OrchestratorDrawer {...initial} flows={[next]} />);

    fireEvent.click(screen.getByRole("tab", { name: "List" }));

    // A place, from the keyboard picker.
    fireEvent.change(screen.getByLabelText("Add a place"), { target: { value: `ASM-1${DRAG_SEP}agent-flow` } });
    let saved = onSave.mock.calls.at(-1)![0] as Flow;
    rerenderWith(saved);

    // A notify terminal, from + Notify.
    fireEvent.click(screen.getByRole("button", { name: "+ Notify" }));
    saved = onSave.mock.calls.at(-1)![0] as Flow;
    rerenderWith(saved);

    expect(saved.nodes).toHaveLength(2);
    const place = saved.nodes.find((n) => n.kind === "place")!;
    const notify = saved.nodes.find((n) => n.kind === "notify")!;

    // A rule between them, from FlowList's own NewRuleBar.
    const bar = screen.getByTestId("flowlist-newrule");
    fireEvent.change(within(bar).getByLabelText("From node"), { target: { value: place.id } });
    fireEvent.change(within(bar).getByLabelText("New rule condition"), { target: { value: "ci-passed" } });
    fireEvent.change(within(bar).getByLabelText("To node"), { target: { value: notify.id } });
    fireEvent.click(within(bar).getByRole("button", { name: "+ Add rule" }));

    saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.nodes).toHaveLength(2);
    expect(saved.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "place", runKey: "ASM-1", repo: "agent-flow" }),
        expect.objectContaining({ kind: "notify" }),
      ]),
    );
    expect(saved.edges).toHaveLength(1);
    expect(saved.edges[0]).toMatchObject({
      from: place.id, to: notify.id, cond: { kind: "ci-passed" }, action: "notify",
    });
  });
});

// The drawer slides in and out along the right edge it is anchored to. The exit
// is the half that needs code rather than a stylesheet: closing drops `openId`,
// which would unmount the aside in the same frame and leave nothing to animate,
// so the drawer holds the flow it last had for exactly ORCH_ANIM_MS.
describe("the open and close animation", () => {
  const aside = (c: HTMLElement) => c.querySelector(".orch") as HTMLElement | null;

  it("arrives with the slide-in animation, not the closing one", () => {
    const { container } = render(<OrchestratorDrawer {...props()} />);
    expect(aside(container)!.className).not.toContain("closing");
  });

  it("keeps painting the drawer while it slides out, then drops it", () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = render(<OrchestratorDrawer {...props()} />);
      expect(aside(container)).not.toBeNull();

      rerender(<OrchestratorDrawer {...props({ openId: null })} />);
      // Still in the DOM, or there would be nothing for the CSS to animate.
      const closing = aside(container);
      expect(closing).not.toBeNull();
      expect(closing!.className).toContain("closing");

      // Just short of the animation's end it is still there; one tick past it,
      // gone. Both halves are asserted so a timer that never fires and a timer
      // that fires instantly are each caught.
      act(() => { vi.advanceTimersByTime(ORCH_ANIM_MS - 1); });
      expect(aside(container)).not.toBeNull();
      act(() => { vi.advanceTimersByTime(1); });
      expect(aside(container)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // The name field is the flow's, and it must still read correctly through the
  // slide-out: this is the drawer the user just dismissed, not a blank shell.
  it("draws the flow it last held, not an empty drawer", () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = render(<OrchestratorDrawer {...props()} />);
      rerender(<OrchestratorDrawer {...props({ openId: null })} />);
      expect(within(aside(container)!).getByLabelText("Flow name")).toHaveValue("Ship the migration");
    } finally {
      vi.useRealTimers();
    }
  });

  // Inert for those milliseconds: a drawer already dismissed must not answer a
  // role query, a screen reader, or a Tab. `queryByRole` honours aria-hidden,
  // so this is also what keeps every existing "the drawer is closed" assertion
  // in DeckApp.test.tsx true across this change.
  it("is hidden from the accessibility tree while closing", () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = render(<OrchestratorDrawer {...props()} />);
      expect(screen.queryByRole("complementary", { name: "Orchestrator" })).not.toBeNull();
      rerender(<OrchestratorDrawer {...props({ openId: null })} />);
      expect(aside(container)).not.toBeNull();
      expect(aside(container)!.getAttribute("aria-hidden")).toBe("true");
      expect(screen.queryByRole("complementary", { name: "Orchestrator" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // While OPEN the attribute must be absent, not "false": this element is the
  // drawer's own landmark, and `aria-hidden="false"` is not equivalent to no
  // attribute at all for every screen reader.
  it("carries no aria-hidden at all while open", () => {
    const { container } = render(<OrchestratorDrawer {...props()} />);
    expect(aside(container)!.hasAttribute("aria-hidden")).toBe(false);
  });

  // A flow that disappears from under the drawer — another window deleted it,
  // and the host posts a list without it — is not a close. `openId` still
  // names it, so there is no dismissal to animate and nothing on disk to draw.
  it("vanishes at once when the open flow disappears from the list", () => {
    const { container, rerender } = render(<OrchestratorDrawer {...props()} />);
    rerender(<OrchestratorDrawer {...props({ flows: [] })} />);
    expect(aside(container)).toBeNull();
  });
});
