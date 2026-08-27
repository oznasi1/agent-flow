// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import * as React from "react";
import { act, render, screen, fireEvent, within } from "@testing-library/react";
import { OrchestratorDrawer, DRAG_SEP } from "../../src/webview/OrchestratorDrawer";
import { ORCH_ANIM_MS, ORCH_CSS, ORCH_EDGE_PAINT_DY } from "../../src/webview/orchestratorStyles";
import type { Flow } from "../../src/engine/orchestrator/model";
// The real store, so the "a new wire is never latched" test below is answered by
// the migration itself rather than by this file restating its rule. Its io is
// injected (see `FlowIo`), so importing it here costs no temp directory.
import { readFlows, writeFlow } from "../../src/engine/orchestrator/store";
import { edgeAction } from "../../src/engine/orchestrator/model";
import { branchCiKey } from "../../src/engine/orchestrator/branchCi";
import {
  ACTION_LABEL,
  COMMAND_FREE_TEXT,
  COMMAND_NONE,
  COMMAND_NONE_LABEL,
  COMMAND_NOT_SET,
  INSPECTOR_NONE,
} from "../../src/webview/orchestratorRule";
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

/** Two configured commands, distinct ids and labels, so a test asserting "the
 * picker offers what the host sent" cannot pass against a coincidence with some
 * hardcoded default — the same reasoning `MODES` above is built on. */
const COMMANDS = [
  { id: "deploy-staging", label: "Deploy to staging", run: "deploy.sh --env=staging" },
  { id: "smoke", label: "Smoke test", run: "npm run smoke -- {note}" },
];

const props = (over: Partial<React.ComponentProps<typeof OrchestratorDrawer>> = {}) => ({
  flows: [flow()], openId: "f1", runs: [], pendingResume: [], promptModes: MODES, commands: COMMANDS, branchCi: {},
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

/** Open one of the Add bar's `MultiCombo`s and hand back its popup. Every combo
 * test starts here, so the trigger's own contract (aria-label, aria-expanded)
 * is exercised by all of them rather than asserted once and then bypassed. */
const openCombo = (ariaLabel: string): HTMLElement => {
  const trigger = screen.getByRole("button", { name: ariaLabel });
  fireEvent.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  return screen.getByRole("listbox", { name: ariaLabel });
};

/** The whole gesture: open, tick each named row, press Add. Rows are addressed
 * by their accessible name — the run key plus its repo, or a command's label
 * plus its detail — which is what the user actually reads.
 *
 * `mouseDown`, not `click`: the rows commit on mousedown so that the search
 * input never loses focus mid-gesture (`preventDefault` on a click would come
 * too late), and firing the event the component listens for is the difference
 * between testing the picker and testing `fireEvent`. */
const pickFromCombo = (ariaLabel: string, rowNames: (string | RegExp)[]): void => {
  const list = openCombo(ariaLabel);
  for (const name of rowNames) {
    const rows = within(list).getAllByRole("option");
    const row = rows.find((r) =>
      typeof name === "string" ? (r.textContent ?? "").includes(name) : name.test(r.textContent ?? ""),
    );
    expect(row, `no row matching ${String(name)} in ${rows.map((r) => r.textContent).join(" | ")}`).toBeTruthy();
    fireEvent.mouseDown(row!);
    expect(row!.getAttribute("aria-selected")).toBe("true");
  }
  fireEvent.mouseDown(screen.getByRole("button", { name: "Add" }));
};

/** The Add-command combo's footer action: a node with an empty `run`, for the
 * inspector to fill in. Its own helper because half this file's flows are built
 * from free text specifically so they depend on nothing being configured. */
const pickFreeTextCommand = (): void => {
  openCombo("Add a command");
  fireEvent.mouseDown(screen.getByRole("button", { name: "Free-text command…" }));
};

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
        { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "PROJ-1", repo: "agent-flow" },
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
        { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "PROJ-1", repo: "r" },
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
    drop(screen.getByTestId("orch-tray"), `PROJ-1${DRAG_SEP}agent-flow`);
    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0] as Flow;
    expect(saved.nodes).toEqual([
      expect.objectContaining({ kind: "place", runKey: "PROJ-1", repo: "agent-flow", join: "any" }),
    ]);
  });

  it("gives the new node an id that is unique within the flow", () => {
    const onSave = vi.fn();
    const existing = flow({ nodes: [{ id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-9", repo: "r" }] });
    render(<OrchestratorDrawer {...props({ onSave, flows: [existing] })} />);
    drop(screen.getByTestId("orch-tray"), `PROJ-1${DRAG_SEP}agent-flow`);
    const saved = onSave.mock.calls[0][0] as Flow;
    expect(new Set(saved.nodes.map((n) => n.id)).size).toBe(2);
  });

  it("refuses the same run and repo twice", () => {
    const onSave = vi.fn();
    const existing = flow({ nodes: [{ id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "agent-flow" }] });
    render(<OrchestratorDrawer {...props({ onSave, flows: [existing] })} />);
    drop(screen.getByTestId("orch-tray"), `PROJ-1${DRAG_SEP}agent-flow`);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("accepts the same run in a different repo", () => {
    const onSave = vi.fn();
    const existing = flow({ nodes: [{ id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "agent-flow" }] });
    render(<OrchestratorDrawer {...props({ onSave, flows: [existing] })} />);
    drop(screen.getByTestId("orch-tray"), `PROJ-1${DRAG_SEP}other-repo`);
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
    expect(screen.getByText(/Drag a card from the board to attach a session/i)).toBeTruthy();
    // Not in THIS tray — the Sessions tray is what a condition can be about. It has
    // its own Remove in the Actions section below (see that describe block); the
    // scope here is what makes this about the tray's membership rather than about
    // whether the node can be deleted at all.
    expect(within(screen.getByTestId("orch-tray")).queryByRole("button", { name: /^Remove/ })).toBeNull();
  });

  it("removes a command node, which nothing could delete before", () => {
    // `removeNode` was reachable from the Sessions tray alone, and that tray is
    // `isAgentNode` — so a command node could not be deleted from either surface,
    // and it is created by a `<select>` that fires on change: one accidental pick
    // was permanent short of hand-editing the flow file.
    const onSave = vi.fn();
    const existing = flow({
      nodes: [{ id: "n1", kind: "command", x: 0, y: 0, join: "any", run: "deploy.sh --env=staging" }],
    });
    render(<OrchestratorDrawer {...props({ onSave, flows: [existing] })} />);
    const actions = screen.getByTestId("orch-actions");
    // Named by `endLabel`, the same words the canvas chip and both rule sentences
    // give this node.
    expect(within(actions).getByText("deploy.sh --env=staging")).toBeTruthy();
    fireEvent.click(within(actions).getByRole("button", { name: "Remove deploy.sh --env=staging" }));
    expect((onSave.mock.calls[0][0] as Flow).nodes).toEqual([]);
  });

  it("removes a notify node too — the same hole, one kind older", () => {
    const onSave = vi.fn();
    const existing = flow({
      nodes: [{ id: "n1", kind: "notify", x: 0, y: 0, join: "any", message: "landed" }],
      edges: [],
    });
    render(<OrchestratorDrawer {...props({ onSave, flows: [existing] })} />);
    fireEvent.click(within(screen.getByTestId("orch-actions")).getByRole("button", { name: "Remove notify" }));
    expect((onSave.mock.calls[0][0] as Flow).nodes).toEqual([]);
  });

  it("drops every edge touching a command node it removes", () => {
    // Same rule the Sessions tray's own delete follows: an edge whose end is gone can
    // never be evaluated. It matters more here — a chained command's rules point at
    // AND out of the node being deleted.
    const onSave = vi.fn();
    const chained = flow({
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "r" },
        { id: "n2", kind: "command", x: 0, y: 0, join: "any", run: "deploy.sh" },
        { id: "n3", kind: "command", x: 0, y: 0, join: "any", run: "smoke.sh" },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" } },
        { id: "e2", from: "n2", to: "n3", cond: { kind: "command-succeeded" } },
      ],
    });
    render(<OrchestratorDrawer {...props({ onSave, flows: [chained] })} />);
    fireEvent.click(within(screen.getByTestId("orch-actions")).getByRole("button", { name: "Remove deploy.sh" }));
    const saved = onSave.mock.calls[0][0] as Flow;
    expect(saved.nodes.map((n) => n.id)).toEqual(["n1", "n3"]);
    expect(saved.edges).toEqual([]);
  });

  it("shows no Actions section at all when a flow has no notify or command node", () => {
    // No empty box for a flow that has none — the Sessions tray earns its empty
    // state because it is a drop target; this list is not.
    const placeOnly = flow({
      nodes: [{ id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "r" }],
    });
    render(<OrchestratorDrawer {...props({ flows: [placeOnly] })} />);
    expect(screen.queryByTestId("orch-actions")).toBeNull();
  });

  it("lists an attached node as a chip, and removes it", () => {
    const onSave = vi.fn();
    const existing = flow({ nodes: [{ id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "agent-flow" }] });
    render(<OrchestratorDrawer {...props({ onSave, flows: [existing] })} />);
    // Scoped to the tray: the same node's key now also renders on its canvas node.
    expect(within(screen.getByTestId("orch-tray")).getByText("PROJ-1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove PROJ-1" }));
    expect((onSave.mock.calls[0][0] as Flow).nodes).toEqual([]);
  });

  it("removing a node also removes every edge touching it", () => {
    const onSave = vi.fn();
    const existing = flow({
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "r" },
        { id: "n2", kind: "notify", x: 0, y: 0, join: "any", message: "done" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" }],
    });
    render(<OrchestratorDrawer {...props({ onSave, flows: [existing] })} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove PROJ-1" }));
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
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "r" },
        { id: "n2", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-2", repo: "r" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" }],
    });
    render(<OrchestratorDrawer {...props({ onSave, flows: [existing] })} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove PROJ-2" }));
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
      nodes: [{ id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "r" }],
    });
    render(<OrchestratorDrawer {...props({ onSave: vi.fn(), flows: [existing] })} />);
    // Pointer-down is what selects a node; release it so no drag is left in flight.
    fireEvent.pointerDown(screen.getByTestId("orch-node-n1"), { clientX: 0, clientY: 0 });
    fireEvent.pointerUp(window);
    expect(screen.getByTestId("orch-node-n1").classList.contains("sel")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove PROJ-1" }));
    expect(screen.getByTestId("orch-node-n1").classList.contains("sel")).toBe(false);
  });

  it("clears the edge selection when a node is removed", () => {
    const existing = flow({
      nodes: [
        { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "PROJ-1", repo: "r" },
        { id: "n2", kind: "notify", x: 320, y: 24, join: "any", message: "done" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" }],
    });
    render(<OrchestratorDrawer {...props({ onSave: vi.fn(), flows: [existing] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    expect(screen.queryByText(/select a connection/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove PROJ-1" }));
    // A re-minted `e1` would otherwise open the inspector on a rule nobody clicked.
    expect(screen.getByText(/select a connection/i)).toBeTruthy();
  });
});

const twoPlaces = () =>
  flow({
    nodes: [
      { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "PROJ-1", repo: "agent-flow" },
      { id: "n2", kind: "place", x: 320, y: 24, join: "any", runKey: "PROJ-2", repo: "bite-me" },
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
    expect(n1.textContent).toContain("PROJ-1");
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
        key: "PROJ-5", summary: "s", url: "https://j/browse/PROJ-5", createdAt: 1, mode: "multiroot",
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
      shelf: "board",
    });

    const boundTo = (repo: string): Flow =>
      flow({ nodes: [{ id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "PROJ-5", repo }] });

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
        { id: "n1", kind: "place", x: 900, y: 900, join: "any", runKey: "PROJ-1", repo: "r" },
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
      dataTransfer: { getData: () => "PROJ-7\0webapp", dropEffect: "copy" },
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
      { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "PROJ-1", repo: "agent-flow" },
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
      { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "PROJ-1", repo: "agent-flow" },
      {
        id: "n2", kind: "planned", x: 320, y: 24, join: "any",
        ticketKey: "PROJ-12", repos: ["agent-flow"], mode: "quick", dest: "worktree",
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

  it("names the branch on a canvas chip, in the same words the list and the inspector use", () => {
    // The canvas was the last surface still spending `COND_LABEL`, a `Record` keyed
    // by KIND alone — which cannot know which branch a rule is about, so the chip
    // read "branch CI passed…" while the list's closed row read "CI passed on
    // agent-flow#main" for the same rule. The trailing ellipsis is this codebase's
    // own mark for "carries a parameter", and wearing it while showing none is the
    // exact defect the list already fixed.
    const branchRule = flow({
      nodes: wired().nodes,
      edges: [{
        id: "e1", from: "n1", to: "n2",
        cond: { kind: "branch-ci-passed", repo: "agent-flow", branch: "main" },
      }],
    });
    render(<OrchestratorDrawer {...props({ flows: [branchRule] })} />);
    const label = screen.getByTestId("orch-edge-e1");
    expect(label.textContent).toBe("CI passed on agent-flow#main");
    expect(label.textContent).not.toContain("…");
  });

  it("creates an edge by dragging from a port onto another node", () => {
    const onSave = vi.fn();
    const two = flow({
      nodes: [
        { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "PROJ-1", repo: "r" },
        { id: "n2", kind: "place", x: 320, y: 24, join: "any", runKey: "PROJ-2", repo: "r2" },
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
  // title (observed as "PROJ-12" rendering as "A_M-12"). n3 sits exactly on
  // the raw chord midpoint between n1 and n2's ports; it is nobody's
  // endpoint on e1, so it must be in the obstacle list and the label must
  // step off of it.
  it("steps a label off an intermediate node the chord passes through", () => {
    const withObstacle = flow({
      nodes: [
        { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "PROJ-1", repo: "r" },
        { id: "n3", kind: "place", x: 344, y: 24, join: "any", runKey: "PROJ-12", repo: "r" },
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
    // `ORCH_EDGE_PAINT_DY`, as the drawer passes it: the chip is painted well
    // above the point it is positioned at, so that is where the obstacle search
    // has to judge the collision.
    const expectedMid = labelPoint(from, to, [obstacleBox], ORCH_EDGE_PAINT_DY);
    // Sanity: this fixture actually exercises the obstacle path — the raw
    // midpoint really does sit on n3, so the expected point must differ from
    // it. If it didn't, the fixture (not the rule) would be at fault.
    expect(expectedMid).not.toEqual(rawMid);

    render(<OrchestratorDrawer {...props({ flows: [withObstacle] })} />);
    const label = screen.getByTestId("orch-edge-e1");
    expect(label.style.left).toBe(`${expectedMid.x}px`);
    expect(label.style.top).toBe(`${expectedMid.y}px`);

    // And directly: what the user SEES must not fall inside n3's box. Judged at
    // the painted position, not at the anchor — checking the anchor is what let
    // every downward escape step clear and then paint itself straight back into
    // the box, over that node's only status word.
    const lx = parseFloat(label.style.left);
    const ly = parseFloat(label.style.top) + ORCH_EDGE_PAINT_DY;
    expect(lx >= obstacleBox.x && lx <= obstacleBox.x + obstacleBox.w &&
      ly >= obstacleBox.y && ly <= obstacleBox.y + obstacleBox.h).toBe(false);
  });

  it("does not paint an escaped label back inside the node it escaped", () => {
    // The mechanism, end to end: `labelPoint` stepped the ANCHOR 8px clear while
    // `.orch-edge`'s `translate(-50%, -150%)` painted the chip ~19px above it, so a
    // DOWNWARD escape deterministically re-entered the box. n3 sits just above the
    // chord, which makes down the nearest way out.
    const above = flow({
      nodes: [
        { id: "n1", kind: "place", x: 24, y: 64, join: "any", runKey: "PROJ-1", repo: "r" },
        { id: "n3", kind: "place", x: 344, y: 24, join: "any", runKey: "PROJ-12", repo: "r" },
        { id: "n2", kind: "notify", x: 624, y: 64, join: "any", message: "landed" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" }],
    });
    const obstacleBox = { x: 344, y: 24, w: NODE_W, h: NODE_H };
    render(<OrchestratorDrawer {...props({ flows: [above] })} />);
    const label = screen.getByTestId("orch-edge-e1");
    const lx = parseFloat(label.style.left);
    const painted = parseFloat(label.style.top) + ORCH_EDGE_PAINT_DY;
    const insideX = lx >= obstacleBox.x && lx <= obstacleBox.x + obstacleBox.w;
    expect(insideX && painted >= obstacleBox.y && painted <= obstacleBox.y + obstacleBox.h).toBe(false);
    // Not vacuous: the fixture really does put the raw midpoint on n3, so
    // something had to move.
    const rawMidY = 64 + NODE_H / 2;
    expect(parseFloat(label.style.top)).not.toBe(rawMidY);
  });

  // Same three-node shape, but the third node sits well clear of the chord
  // (a different row entirely). Its box is still in the obstacle list — this
  // pins that a harmless obstacle leaves the label exactly where it started.
  it("leaves the label at the chord midpoint when no obstacle is in the way", () => {
    const clear = flow({
      nodes: [
        { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "PROJ-1", repo: "r" },
        { id: "n3", kind: "place", x: 344, y: 400, join: "any", runKey: "PROJ-12", repo: "r" },
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
        { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "PROJ-1", repo: "r" },
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
        { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "PROJ-1", repo: "r" },
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
        { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "PROJ-1", repo: "r" },
        { id: "n2", kind: "place", x: 24, y: 112, join: "any", runKey: "PROJ-2", repo: "r" },
        { id: "n3", kind: "place", x: 24, y: 200, join: "any", runKey: "PROJ-3", repo: "r" },
        { id: "n4", kind: "place", x: 320, y: 24, join: "any", runKey: "PROJ-4", repo: "r" },
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
    windowOpen: true, prs, agents: [], shelf: "board", ...over,
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
    expect(insp.textContent).toContain("PROJ-1");
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

  // Task 7 shipped `command-succeeded` offered on every rule regardless of its
  // source. `evaluate.ts`'s guard makes that safe — such a rule is inert, never
  // wrongly true — so this is a UX defect rather than a money one: the picker
  // offered a choice that provably cannot work.
  it("does not offer the command condition on a rule out of a place", () => {
    open();
    const values = Array.from(
      screen.getByLabelText("Condition").querySelectorAll("option"),
    ).map((o) => (o as HTMLOptionElement).value);
    expect(values).not.toContain("command-succeeded");
    expect(values).toContain("pr-merged");
  });

  it("offers only the command condition on a rule out of a command node", () => {
    // The mirror, and the reason the filter is a split rather than a subtraction:
    // `isMet` reads every place-shaped condition off the source's `RunStatus`,
    // which a command node has none of, so all of them are inert here.
    const fromCommand = flow({
      nodes: [
        { id: "n1", kind: "command", x: 24, y: 24, join: "any", commandId: "deploy-staging" },
        { id: "n2", kind: "notify", x: 320, y: 24, join: "any", message: "deployed" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "command-succeeded" } }],
    });
    render(<OrchestratorDrawer {...props({ flows: [fromCommand] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    const values = Array.from(
      screen.getByLabelText("Condition").querySelectorAll("option"),
    ).map((o) => (o as HTMLOptionElement).value);
    expect(values).toEqual(["command-succeeded"]);
  });

  // A `<select>` whose `value` matches none of its options has `selectedIndex`
  // -1 and renders BLANK — not "the first option", which is what the same
  // mistake does to the Mode select. `branch-ci-passed` is not offered (no
  // input for a repo and a branch yet), so a hand-authored rule using it showed
  // an EMPTY Condition control: the one condition built to gate a deploy,
  // displayed as nothing at all.
  it("renders a hand-authored branch-CI condition instead of a blank select", () => {
    const branchRule = flow({
      nodes: wired().nodes,
      edges: [{
        id: "e1", from: "n1", to: "n2",
        cond: { kind: "branch-ci-passed", repo: "agent-flow", branch: "main" },
      }],
    });
    render(<OrchestratorDrawer {...props({ flows: [branchRule] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    const select = screen.getByLabelText("Condition") as HTMLSelectElement;
    // Asserted as "the control shows THIS rule's condition", not as
    // `selectedIndex !== -1`: jsdom resolves an unmatched `value` to the first
    // option instead of -1, so the -1 a real browser reports is not observable
    // here — but the wrong condition being displayed is, and it is the same
    // defect either way (a blank select in Chrome, "PR is merged" under jsdom,
    // and in neither case the branch rule the user wrote).
    expect(select.value).toBe("branch-ci-passed");
    // And it names the branch, which `COND_LABEL` — keyed by kind alone — cannot.
    expect(select.selectedOptions[0].textContent).toBe("CI passed on agent-flow#main");
  });

  it("lets a parameterised condition be swapped for one the picker can build", () => {
    // Selectable, not disabled: dropping the parameters is a real edit, and
    // without this the rule would be uneditable from either presentation.
    const onSave = vi.fn();
    const branchRule = flow({
      nodes: wired().nodes,
      edges: [{
        id: "e1", from: "n1", to: "n2",
        cond: { kind: "branch-ci-passed", repo: "agent-flow", branch: "main" },
      }],
    });
    render(<OrchestratorDrawer {...props({ onSave, flows: [branchRule] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    fireEvent.change(screen.getByLabelText("Condition"), { target: { value: "ci-passed" } });
    expect((onSave.mock.calls.at(-1)![0] as Flow).edges[0].cond).toEqual({ kind: "ci-passed" });
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
    render(<OrchestratorDrawer {...props({ runs: [runStatus("PROJ-1", "agent-flow")], flows: [ciWired] })} />);
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
    // is). This pins that the drawer renders a sentence instead of crashing —
    // and that the sentence names the real problem: this condition can NEVER be
    // met from a place (`commandSucceeded` checks the source's kind first), so it
    // is not a wait, and it is certainly not a missing card.
    const placeSourced = flow({
      nodes: [
        { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "PROJ-1", repo: "agent-flow" },
        { id: "n2", kind: "notify", x: 320, y: 24, join: "any", message: "landed" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "command-succeeded" }, action: "notify" }],
    });
    render(<OrchestratorDrawer {...props({ runs: [runStatus("PROJ-1", "agent-flow")], flows: [placeSourced] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    const insp = screen.getByTestId("orch-inspector");
    expect(insp.textContent).toMatch(/waits on a command, but it does not come from one/i);
    expect(insp.textContent).not.toMatch(/not on the board/i);
  });

  it("says what a waiting command rule is waiting for, not that its card is missing", () => {
    // `observationOf` answers `null` for two different reasons and the drawer used
    // to print one sentence for both. Tasks 9 and 10 made `command-succeeded` the
    // default and ONLY condition offered off a command node, so "this card is not
    // on the board right now" became the guaranteed steady state of this phase's
    // headline shape — a claim that something is missing, on the one rule where
    // nothing is.
    const chained = flow({
      nodes: [
        { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "PROJ-1", repo: "agent-flow" },
        { id: "n2", kind: "command", x: 320, y: 24, join: "any", run: "deploy.sh --env=staging" },
        { id: "n3", kind: "command", x: 620, y: 24, join: "any", run: "smoke.sh" },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" } },
        { id: "e2", from: "n2", to: "n3", cond: { kind: "command-succeeded" } },
      ],
    });
    render(<OrchestratorDrawer {...props({ runs: [runStatus("PROJ-1", "agent-flow")], flows: [chained] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e2"));
    const insp = screen.getByTestId("orch-inspector");
    // Names the command it waits on, in `commandLabel`'s own words — the same
    // string the chip and the sentence use for that node.
    expect(insp.textContent).toContain("waiting for deploy.sh --env=staging to succeed");
    expect(insp.textContent).not.toMatch(/not on the board/i);
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

/** A place feeding a planned node — so the rule DERIVES `launch`, since that
 * is the action a planned target implies (`actionFor`). n2 already carries a
 * real mode/dest, matching a planned node's own invariant that it is never
 * created without one — an armed launch cannot stop to ask.
 *
 * The edge carries NO stored `action`, which is what every edge this build
 * creates looks like (see `finishWire`) and the only shape the store's
 * mismatch migration can never latch. Tests about a STALE stored action set
 * one explicitly. */
const placeAndPlanned = () =>
  flow({
    nodes: [
      { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "PROJ-1", repo: "agent-flow" },
      {
        id: "n2", kind: "planned", x: 320, y: 24, join: "any",
        ticketKey: "PROJ-12", repos: ["agent-flow"], mode: "quick", dest: "worktree",
      },
    ],
    edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" } }],
  });

/** Two places — so the rule derives `seed`, the action a place target implies.
 * Actionless for the same reason `placeAndPlanned` above is. */
const twoPlacesWired = () =>
  flow({
    nodes: [
      { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "PROJ-1", repo: "agent-flow" },
      { id: "n2", kind: "place", x: 320, y: 24, join: "any", runKey: "PROJ-2", repo: "agent-flow" },
    ],
    edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" } }],
  });

describe("the acting verbs", () => {
  const openInspector = (f: Flow, over: Partial<React.ComponentProps<typeof OrchestratorDrawer>> = {}) => {
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave, flows: [f], ...over })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    return onSave;
  };

  // The action is DERIVED from the target node now, so a `<select>` here could
  // not decide anything: the pick was overridden by the target on the next
  // read, and the stored value it left behind is exactly what
  // `latchActionMismatches` stamps an edge dead for. THEN is a statement.
  it("states what the rule does instead of offering a verb to pick", () => {
    openInspector(placeAndPlanned());
    expect(screen.queryByLabelText("Action")).toBeNull();
    // Planned work means launch — and it says so, with the target's own key.
    // Scoped to the THEN clause, so neither half can be satisfied by some other
    // string elsewhere in the panel.
    const then = within(screen.getByTestId("orch-then"));
    expect(then.getByText("launch")).toBeTruthy();
    expect(then.getByText("PROJ-12")).toBeTruthy();
  });

  it("reads the verb off the TARGET, not off a stale stored action", () => {
    // The shape the mismatch migration exists for: an edge saved as "notify"
    // by an older build, pointing at planned work. The drawer must not repeat
    // the stored word — it says what this rule will do once accepted.
    const stale = placeAndPlanned();
    stale.edges[0] = { ...stale.edges[0], action: "notify" };
    openInspector(stale);
    const then = within(screen.getByTestId("orch-then"));
    expect(then.getByText("launch")).toBeTruthy();
    expect(then.queryByText(ACTION_LABEL.notify)).toBeNull();
  });

  // The spec's rename. "notify" alone reads as if it messages somebody, which
  // is the confusion that started this phase; a DM is a command node now.
  it('labels the notify action "Notify me in VS Code"', () => {
    openInspector(wired()); // n2 is a notify node, so the rule derives notify
    // The literal string, not `ACTION_LABEL.notify`: this assertion is the one
    // place the spec's own wording is spelled out, so a rename has to come
    // through here rather than agreeing with itself via the Record.
    expect(within(screen.getByTestId("orch-then")).getByText("Notify me in VS Code")).toBeTruthy();
  });

  it("says so when it cannot tell what the rule does", () => {
    // `store.ts`'s `validNode` admits an unknown `kind` on purpose, so a flow
    // written by a NEWER build still renders here. Such a target derives no
    // action at all, and the drawer must say that rather than fall through to
    // some verb it made up.
    const future = flow({
      nodes: [
        { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "PROJ-1", repo: "agent-flow" },
        { id: "n2", kind: "webhook", x: 320, y: 24, join: "any" } as unknown as Flow["nodes"][number],
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" } }],
    });
    render(<OrchestratorDrawer {...props({ flows: [future] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    const insp = screen.getByTestId("orch-inspector");
    expect(insp.textContent).toMatch(/can\u2019t be determined/);
    // And none of the editing controls a known verb would bring.
    expect(screen.queryByLabelText("Mode")).toBeNull();
    expect(screen.queryByLabelText("Notify message")).toBeNull();
  });

  // Task 1 deferred this here: both helpers keyed off the raw `e.action`, so an
  // edge with no stored action — every edge this build creates — showed
  // "(no mode set)" and defaulted its destination to `worktree`, contradicting
  // the very node `performEdge` reads those two facts from.
  it("reads an actionless launch rule's mode and destination off its target node", () => {
    const launching = placeAndPlanned();
    launching.nodes[1] = { ...(launching.nodes[1] as any), mode: "careful", dest: "new-window" };
    openInspector(launching);
    expect((screen.getByLabelText("Mode") as HTMLSelectElement).value).toBe("careful");
    expect((screen.getByLabelText("Destination") as HTMLSelectElement).value).toBe("new-window");
  });

  it("writes an actionless launch rule's mode onto the target node, where performEdge reads it", () => {
    const onSave = openInspector(placeAndPlanned());
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "careful" } });
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect((saved.nodes.find((n) => n.id === "n2") as { mode: string }).mode).toBe("careful");
    // Not onto the edge, which `performEdge` never looks at for a launch — a
    // mode written there is a choice the launch would silently ignore.
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
    const r1 = render(<OrchestratorDrawer {...props({ flows: [placeAndPlanned()] })} />); // derives launch
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    expect(screen.getByLabelText("Destination")).toBeTruthy();
    r1.unmount();

    const r2 = render(<OrchestratorDrawer {...props({ flows: [twoPlacesWired()] })} />); // derives seed
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    expect(screen.queryByLabelText("Destination")).toBeNull();
    r2.unmount();

    render(<OrchestratorDrawer {...props({ flows: [wired()] })} />); // derives notify
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    expect(screen.queryByLabelText("Destination")).toBeNull();
  });

  it("changing the destination writes it onto the target node, not the edge", () => {
    const onSave = openInspector(placeAndPlanned());
    fireEvent.change(screen.getByLabelText("Destination"), { target: { value: "new-window" } });
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect((saved.nodes.find((n) => n.id === "n2") as { dest: string }).dest).toBe("new-window");
    expect(saved.edges[0]).not.toHaveProperty("dest");
  });

  // What used to be `actionMismatch`'s two "refused with a visible reason"
  // tests. Under derivation a user cannot MAKE a launch-at-a-place pairing —
  // the target is the verb — so the question is no longer "is the disagreement
  // explained" but "does the drawer describe the rule by its target". A stale
  // stored action is a migration matter, and `store.ts` is what surfaces it
  // (see the migration-notice tests further down).
  it("describes a rule pointing at a place as a seed, whatever a stale action says", () => {
    const stale = twoPlacesWired();
    stale.edges[0] = { ...stale.edges[0], action: "launch" };
    render(<OrchestratorDrawer {...props({ flows: [stale] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    expect(within(screen.getByTestId("orch-then")).getByText("seed")).toBeTruthy();
    // A seed has no destination to pick — the place already exists.
    expect(screen.queryByLabelText("Destination")).toBeNull();
    // But it does have a mode, which is the thing `performSeed` reads.
    expect(screen.getByLabelText("Mode")).toBeTruthy();
  });

  it("the mirror: a rule pointing at planned work is a launch, whatever a stale action says", () => {
    const stale = placeAndPlanned();
    stale.edges[0] = { ...stale.edges[0], action: "seed" };
    render(<OrchestratorDrawer {...props({ flows: [stale] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    expect(within(screen.getByTestId("orch-then")).getByText("launch")).toBeTruthy();
    expect(screen.getByLabelText("Destination")).toBeTruthy();
  });

  it("renders the mode list the host sent, not a hardcoded one", () => {
    const hostModes = [{ id: "custom-1", label: "A mode only this test made up" }];
    const launching = flow({
      nodes: [
        { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "PROJ-1", repo: "agent-flow" },
        {
          id: "n2", kind: "planned", x: 320, y: 24, join: "any",
          ticketKey: "PROJ-12", repos: ["agent-flow"], mode: "custom-1", dest: "worktree",
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
    render(<OrchestratorDrawer {...props({ flows: [placeAndPlanned()] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    // "PROJ-12" renders three times — the canvas node's own label (mono via a
    // CSS class, not inline style), the "Connection · A → B" header (already
    // covered by an earlier test), and the THEN clause this test is about.
    // Scoped to the inspector so the canvas node's match — which has no
    // inline style to assert on — is excluded, not silently counted as a pass.
    const matches = within(screen.getByTestId("orch-inspector")).getAllByText("PROJ-12");
    expect(matches.length).toBe(2);
    for (const m of matches) expect(m.getAttribute("style")).toContain("mono");
  });

  it("offers a note for launch and for seed, but not for notify", () => {
    const r1 = render(<OrchestratorDrawer {...props({ flows: [placeAndPlanned()] })} />); // launch
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    expect(screen.getByLabelText("Note")).toBeTruthy();
    r1.unmount();

    const r2 = render(<OrchestratorDrawer {...props({ flows: [twoPlacesWired()] })} />); // seed
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    expect(screen.getByLabelText("Note")).toBeTruthy();
    r2.unmount();

    render(<OrchestratorDrawer {...props({ flows: [wired()] })} />); // notify
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    expect(screen.queryByLabelText("Note")).toBeNull();
  });

  it("typing a note saves it on the edge, on blur", () => {
    const onSave = openInspector(placeAndPlanned());
    const box = screen.getByLabelText("Note");
    fireEvent.change(box, { target: { value: "watch for the flaky upload test" } });
    fireEvent.blur(box);
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.edges[0].note).toBe("watch for the flaky upload test");
  });
});

// Task 9's whole point. Phase 3 shipped a launch path nothing in the UI could
// create a `planned` node for, which made it unreachable; a command node with no
// way to be built would repeat that exactly.
describe("a command node", () => {
  const openInspector = (f: Flow, over: Partial<React.ComponentProps<typeof OrchestratorDrawer>> = {}) => {
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave, flows: [f], ...over })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    return onSave;
  };

  /** A place wired to a command node that names a configured command — the
   * shape "wait for CI, then deploy" actually takes. */
  const placeAndCommand = (over: Partial<{ commandId: string; run: string }> = { commandId: "deploy-staging" }) =>
    flow({
      nodes: [
        { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "PROJ-1", repo: "agent-flow" },
        { id: "n2", kind: "command", x: 320, y: 24, join: "any", ...over },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "ci-passed" } }],
    });

  it("says a free-text node with nothing typed has no command set, on the canvas and in the sentence", () => {
    // The shape the picker actually CREATES ("Free-text command…" writes `run: ""`)
    // and the one `resolveCommand` refuses, so an armed flow latches it errored. It
    // used to read as configured on every surface: the canvas chip and the
    // inspector's title both said the bare word "command", and the rule sentence
    // read "THEN run command". Every value beside it already had a not-set voice.
    const blank = placeAndCommand({ run: "" });
    render(<OrchestratorDrawer {...props({ flows: [blank] })} />);
    expect(within(screen.getByTestId("orch-node-n2")).getByText(COMMAND_NOT_SET)).toBeTruthy();
    // And in the inspector's own title, which names both ends of the rule.
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    expect(screen.getByTestId("orch-inspector").textContent).toContain(COMMAND_NOT_SET);
  });

  it("does not uppercase the command it names in the inspector's eyebrow", () => {
    // `.orch-insp .t` is uppercased for its own word ("CONNECTION"); the two
    // identifiers beside it are not its to shout. A run key survives it, but a
    // free-text command is case-sensitive shell text and this phase routed it
    // through that row: "deploy.sh --env={note}" rendered as
    // "DEPLOY.SH --ENV={NOTE}", which is not the command that runs.
    //
    // The visual half cannot be computed under jsdom (the sheet is never
    // injected), so both halves are pinned together: the identifier really is in a
    // `.k` inside that row, and the sheet really does exempt it.
    render(<OrchestratorDrawer {...props({ flows: [placeAndCommand({ run: "deploy.sh --env={note}" })] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    const eyebrow = screen.getByTestId("orch-inspector").querySelector(".t") as HTMLElement;
    expect(within(eyebrow).getByText("deploy.sh --env={note}").className).toContain("k");
    expect(ORCH_CSS).toContain(".orch-insp .t .k { text-transform: none;");
  });

  it("offers every configured command, and a free-text action", () => {
    render(<OrchestratorDrawer {...props()} />);
    const rows = within(openCombo("Add a command")).getAllByRole("option");
    // The host's own list, in order — never a hardcoded set, which is why
    // COMMANDS' ids are made up for this file.
    expect(rows.map((r) => r.textContent)).toEqual(["Deploy to staging", "Smoke test"]);
    // Free text is an ACTION, not a tickable row: there is nothing to batch about
    // "a command I have not typed yet", so it sits in the footer and fires at once.
    expect(screen.getByRole("button", { name: "Free-text command…" })).toBeTruthy();
  });

  // The visual half, which no computed style can assert under jsdom (the sheet is
  // never injected): what CAN be pinned is the contract the styling depends on —
  // the trigger sits inside an `.orch-bar` beside the quiet `.orch-mini` buttons,
  // and `.combo-trigger` is the rule that gives it their weight. Both halves
  // asserted together, so moving the control out of the bar or dropping the rule
  // each break this.
  it("reads at the same weight as the buttons beside it", () => {
    render(<OrchestratorDrawer {...props()} />);
    const trigger = screen.getByRole("button", { name: "Add a command" });
    const bar = trigger.closest(".orch-bar");
    expect(bar).not.toBeNull();
    // Its neighbours are the quiet `.orch-mini` buttons, and this must not be
    // heavier than them — Arm is this surface's only accented control.
    expect(within(bar as HTMLElement).getByRole("button", { name: "+ Notify" }).className).toBe("orch-mini");
    expect(trigger.className).toBe("combo-trigger");
    expect(ORCH_CSS).toContain(".combo-trigger {");
    // 20px and --t-micro are `.orch-mini`'s own metrics. A trigger that drifted
    // to the inspector's 22px/--t-body would be the heaviest thing in the row.
    expect(ORCH_CSS).toMatch(/\.combo-trigger \{[^}]*height: 20px/);
    expect(ORCH_CSS).toMatch(/\.combo-trigger \{[^}]*font-size: var\(--t-micro\)/);
  });

  it("adds a node for a configured command", () => {
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave })} />);
    pickFromCombo("Add a command", ["Deploy to staging"]);
    const saved = onSave.mock.calls[0][0] as Flow;
    expect(saved.nodes).toEqual([
      expect.objectContaining({ kind: "command", commandId: "deploy-staging" }),
    ]);
    // Never both fields — `resolveCommand` refuses a node carrying a usable
    // `commandId` AND a usable `run` rather than guess which one executes.
    expect(saved.nodes[0]).not.toHaveProperty("run");
  });

  // The reason this picker stopped being a `<select>`: the feature's own headline
  // example is a chain (deploy, then smoke-test), and a select creates exactly one
  // node per trip. Two ticks, ONE save — and the two nodes must not collide on the
  // id or the y that `addCommandNode` mints from the flow it is handed.
  it("adds one node per ticked command, in a single save", () => {
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave })} />);
    pickFromCombo("Add a command", ["Deploy to staging", "Smoke test"]);
    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0] as Flow;
    expect(saved.nodes.map((n) => (n.kind === "command" ? n.commandId : n.kind))).toEqual([
      "deploy-staging",
      "smoke",
    ]);
    expect(new Set(saved.nodes.map((n) => n.id)).size).toBe(2);
    expect(new Set(saved.nodes.map((n) => n.y)).size).toBe(2);
  });

  it("orders a batch by the picker's own list, not by the order they were ticked", () => {
    // Stable output for one set of ticks. Ticking bottom-up is the same batch as
    // ticking top-down, which is what makes the fold above reproducible.
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave })} />);
    pickFromCombo("Add a command", ["Smoke test", "Deploy to staging"]);
    const saved = onSave.mock.calls[0][0] as Flow;
    expect(saved.nodes.map((n) => (n.kind === "command" ? n.commandId : n.kind))).toEqual([
      "deploy-staging",
      "smoke",
    ]);
  });

  it("finds a command by typing part of its label", () => {
    render(<OrchestratorDrawer {...props()} />);
    const list = openCombo("Add a command");
    fireEvent.change(screen.getByPlaceholderText("Filter commands…"), { target: { value: "smo" } });
    expect(within(list).getAllByRole("option").map((r) => r.textContent)).toEqual(["Smoke test"]);
  });

  it("adds nothing when Add is pressed with no row ticked", () => {
    // The button is present from the moment the popup opens (the gesture should be
    // discoverable before it is available), so it has to refuse an empty commit
    // rather than save a flow with no new node in it.
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave })} />);
    openCombo("Add a command");
    const add = screen.getByRole("button", { name: "Add" });
    expect(add).toBeDisabled();
    fireEvent.mouseDown(add);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("forgets what was ticked when the popup is dismissed without adding", () => {
    // Escape is a cancel, not a pause: reopening must not carry a stale tick that
    // the next Add would then commit silently.
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave })} />);
    const list = openCombo("Add a command");
    fireEvent.mouseDown(within(list).getAllByRole("option")[0]);
    fireEvent.keyDown(screen.getByPlaceholderText("Filter commands…"), { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Add a command" })).toBeNull();
    const reopened = openCombo("Add a command");
    expect(within(reopened).getAllByRole("option")[0].getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("adds a node for a free-text command, in the shape that says 'not typed yet'", () => {
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave })} />);
    openCombo("Add a command");
    fireEvent.mouseDown(screen.getByRole("button", { name: "Free-text command…" }));
    const saved = onSave.mock.calls[0][0] as Flow;
    expect(saved.nodes[0]).toMatchObject({ kind: "command", run: "" });
    expect(saved.nodes[0]).not.toHaveProperty("commandId");
  });

  // `commands: []` here is not what an untouched install actually gets any
  // more — `agentFlow.commands` now ships one inert example — but a user can
  // still clear the list to empty on purpose, and that path has to stay
  // reachable and not throw. This prop is the component's own contract, set
  // directly rather than routed through config.ts's DEFAULT_COMMANDS.
  it("stays reachable when commands is cleared to an empty list", () => {
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave, commands: [] })} />);
    const list = openCombo("Add a command");
    // No tickable rows at all — and the two things that are not options survive:
    // the line that says where commands come from, and free text.
    expect(within(list).queryAllByRole("option")).toEqual([]);
    expect(within(list).getByText(COMMAND_NONE_LABEL)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Free-text command…" })).toBeTruthy();
  });

  it("is reachable from the list view too, not only from the canvas", () => {
    // A node kind reachable from one of the two views only is the gap Task 6
    // closed for a place; reopening it for a command would undo that.
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave, flows: [twoPlaces()] })} />);
    fireEvent.click(screen.getByRole("tab", { name: "List" }));
    pickFromCombo("Add a command", ["Smoke test"]);
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.nodes.filter((n) => n.kind === "command")).toEqual([
      expect.objectContaining({ commandId: "smoke" }),
    ]);
  });

  // The list view's own rule rows pick a command too, and they read the list
  // from this file's `commands` prop — the SAME one the inspector reads. Passed
  // down explicitly, so this pins the wiring: without it the keyboard row would
  // offer free text alone while the canvas offered the configured commands, for
  // one flow.
  it("hands the configured commands to the list view's rows as well as the inspector's", () => {
    render(<OrchestratorDrawer {...props({ flows: [placeAndCommand()] })} />);
    fireEvent.click(screen.getByRole("tab", { name: "List" }));
    fireEvent.click(screen.getByTestId("flowlist-row-e1"));
    const values = Array.from(
      screen.getByLabelText("Command").querySelectorAll("option"),
    ).map((o) => (o as HTMLOptionElement).value);
    expect(values).toEqual(["deploy-staging", "smoke", COMMAND_FREE_TEXT]);
  });

  it("reads as a run rule, named by its picker rather than twice over", () => {
    openInspector(placeAndCommand());
    // The verb, from the THEN clause alone and matched exactly — see the e2e's
    // own note below on why an inspector-wide `toContain("run")` is vacuous.
    expect(within(screen.getByTestId("orch-then")).getByText("run")).toBeTruthy();
    // And the target is named ONCE, by the picker rather than also as a label.
    expect(within(screen.getByTestId("orch-then")).queryByText("deploy-staging")).toBeNull();
    expect((screen.getByLabelText("Command") as HTMLSelectElement).value).toBe("deploy-staging");
    // No Mode, no Destination: a command is not an agent session.
    expect(screen.queryByLabelText("Mode")).toBeNull();
    expect(screen.queryByLabelText("Destination")).toBeNull();
  });

  it("switches which configured command a rule runs", () => {
    const onSave = openInspector(placeAndCommand());
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "smoke" } });
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.nodes.find((n) => n.id === "n2")).toMatchObject({ commandId: "smoke" });
  });

  it("saves a free-text command onto the node, on blur", () => {
    const onSave = openInspector(placeAndCommand({ run: "" }));
    const box = screen.getByLabelText("Command to run");
    fireEvent.change(box, { target: { value: "deploy.sh --env=staging" } });
    fireEvent.blur(box);
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    // On the NODE, where `performEdge` resolves it — never on the edge.
    expect(saved.nodes.find((n) => n.id === "n2")).toMatchObject({ run: "deploy.sh --env=staging" });
    expect(saved.edges[0]).not.toHaveProperty("run");
  });

  it("switching to free text clears the configured id, and offers the field to type in", () => {
    const onSave = openInspector(placeAndCommand());
    expect(screen.queryByLabelText("Command to run")).toBeNull(); // a configured command has no free text
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: COMMAND_FREE_TEXT } });
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    const node = saved.nodes.find((n) => n.id === "n2")!;
    expect(node).toMatchObject({ run: "" });
    expect(node).not.toHaveProperty("commandId", expect.anything());
  });

  it("shows a commandId that is not configured, rather than the first one that is", () => {
    // Same defect class as a deleted prompt mode: a `<select>` whose value
    // matches no option falls back to showing its FIRST option selected, so
    // this node would read as "Deploy to staging" while `resolveCommand`
    // refuses it for naming nothing configured.
    openInspector(placeAndCommand({ commandId: "since-deleted" }));
    const select = screen.getByLabelText("Command") as HTMLSelectElement;
    expect(select.value).toBe("since-deleted");
    expect(select.selectedOptions[0].textContent).toContain("not configured");
  });

  it("says a hand-edited node carries no command at all", () => {
    openInspector(placeAndCommand({}));
    const select = screen.getByLabelText("Command") as HTMLSelectElement;
    expect(select.selectedOptions[0].textContent).toBe("(no command set)");
  });

  it("labels a free-text node that has nothing typed yet, rather than rendering a blank chip", () => {
    render(<OrchestratorDrawer {...props({ flows: [placeAndCommand({ run: "" })] })} />);
    expect(screen.getByTestId("orch-node-n2").textContent).toContain("command");
  });

  // Task 5's deferral: the injection surface is stated in command.ts and in the
  // `agentFlow.commands` setting description — i.e. everywhere except the field
  // a user actually types the thing into.
  it("says where the note goes, beside the note itself", () => {
    openInspector(placeAndCommand());
    const hint = screen.getByText(/unquoted/i);
    expect(hint.textContent).toContain("can extend what runs");
    // Not red: nothing has failed, and this is how a feature the user chose
    // works. Red in this drawer is for a rule that tried and failed.
    expect(hint.getAttribute("style")).toContain("--dim");
    expect(hint.getAttribute("style")).not.toContain("--c-danger");
  });

  it("does not put that hint on a launch rule, whose note is appended to a prompt", () => {
    openInspector(placeAndPlanned());
    expect(screen.queryByText(/unquoted/i)).toBeNull();
  });

  it("saves a command rule's note on the edge, where resolveCommand reads it", () => {
    const onSave = openInspector(placeAndCommand());
    const box = screen.getByLabelText("Note");
    fireEvent.change(box, { target: { value: "staging" } });
    fireEvent.blur(box);
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.edges[0].note).toBe("staging");
  });

  // THE one that matters: a condition → command rule, built end to end from
  // this drawer with nothing hand-authored. Every step re-renders with the flow
  // the previous step actually saved, since each control reads the live prop.
  it("builds a whole condition → command rule from the drawer", () => {
    const onSave = vi.fn();
    const initial = props({ onSave, flows: [flow()], runs: [runStatus("PROJ-1", "agent-flow")] });
    const { rerender } = render(<OrchestratorDrawer {...initial} />);
    const rerenderWith = (next: Flow) => rerender(<OrchestratorDrawer {...initial} flows={[next]} />);
    const lastSaved = () => onSave.mock.calls.at(-1)![0] as Flow;

    // A place, dragged off the board onto the tray.
    drop(screen.getByTestId("orch-tray"), `PROJ-1${DRAG_SEP}agent-flow`);
    rerenderWith(lastSaved());

    // A command node, from the picker — free text, so nothing about this test
    // depends on the user having configured anything.
    pickFreeTextCommand();
    rerenderWith(lastSaved());

    // A rule between them, by wiring the ports.
    fireEvent.pointerDown(screen.getByTestId("orch-port-out-n1"));
    fireEvent.pointerUp(screen.getByTestId("orch-node-n2"));
    rerenderWith(lastSaved());

    // Its condition, and the command it runs.
    fireEvent.change(screen.getByLabelText("Condition"), { target: { value: "ci-passed" } });
    rerenderWith(lastSaved());
    const box = screen.getByLabelText("Command to run");
    fireEvent.change(box, { target: { value: "deploy.sh --env=staging" } });
    fireEvent.blur(box);

    const built = lastSaved();
    expect(built.nodes).toEqual([
      expect.objectContaining({ kind: "place", runKey: "PROJ-1", repo: "agent-flow" }),
      expect.objectContaining({ kind: "command", run: "deploy.sh --env=staging" }),
    ]);
    expect(built.edges).toEqual([
      expect.objectContaining({ from: "n1", to: "n2", cond: { kind: "ci-passed" } }),
    ]);
    // No stored action, so nothing for the store's mismatch migration to latch —
    // and the action it derives is the one that executes the command.
    expect(built.edges[0].action).toBeUndefined();
    expect(latchesFor(built)).toEqual([]);
    expect(edgeAction(built, built.edges[0])).toBe("run");
    // And the drawer says so, having kept the new rule selected throughout.
    // Scoped to the THEN clause and matched EXACTLY: "run" is a substring of the
    // note hint's own "…a note can extend what runs", so
    // `inspector.textContent).toContain("run")` passed even with no verb
    // rendered at all — measured, and it was this test's closing claim.
    rerenderWith(built);
    expect(within(screen.getByTestId("orch-then")).getByText("run")).toBeTruthy();
  });
});

// The defect a manual test in a real editor found, after 3328 tests and two
// reviewers: `CommandNode.commandId`/`run` are NODE data, but the only controls
// that wrote them were keyed on `edge.id` and rendered only inside the edge
// inspector. So "+ Add command… → Free-text command…" created a node with `run:
// ""` — deliberately empty, for the user to fill in — and there was nowhere to
// fill it in until a rule pointed at the node. Every fixture and every render in
// this file wired the edge FIRST, which is exactly why nothing here caught it.
//
// The shape each test below is built on is therefore the one shape none of them
// used: a flow with NO EDGES AT ALL.
describe("a selected node's own configuration", () => {
  /** One command node, no rules, nothing else — the flow as it stands the moment
   * the Add-command picker has been used once. */
  const loneCommand = (over: Partial<{ commandId: string; run: string }> = { run: "" }) =>
    flow({ nodes: [{ id: "n1", kind: "command", x: 320, y: 24, join: "any", ...over }] });

  const loneNotify = () =>
    flow({ nodes: [{ id: "n1", kind: "notify", x: 320, y: 24, join: "any", message: "say something" }] });

  /** The shape every existing test in this file starts from, by contrast: the
   * edge already wired. Needed here for the two tests that compare the two edit
   * paths against each other. */
  const wiredCommand = (over: Partial<{ commandId: string; run: string }> = { commandId: "deploy-staging" }) =>
    flow({
      nodes: [
        { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "PROJ-1", repo: "agent-flow" },
        { id: "n2", kind: "command", x: 320, y: 24, join: "any", ...over },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "ci-passed" } }],
    });

  /** Select a node the way a keyboard user reaches it: the Actions chip's own
   * button. `endLabel` names it, so a free-text node with nothing typed is
   * "Configure (no command set)". */
  const selectChip = (name: string) =>
    fireEvent.click(screen.getByRole("button", { name: `Configure ${name}` }));

  it("types a free-text command onto a node in a flow with no edges at all", () => {
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave, flows: [loneCommand()] })} />);
    // There is no rule, and no rule can be selected, so the edge inspector — the
    // only place these controls used to live — can never open here.
    expect(screen.queryByTestId("orch-edge-e1")).toBeNull();
    expect(screen.queryByTestId("orch-inspector")).not.toBeNull();

    selectChip(COMMAND_NOT_SET);
    const box = screen.getByLabelText(`Command to run for ${COMMAND_NOT_SET}`);
    fireEvent.change(box, { target: { value: "deploy.sh --env=staging" } });
    fireEvent.blur(box);

    // Asserted on what gets SAVED, never on a rendered `value`: jsdom resolves an
    // unmatched <select> value to its first option, so a rendered-value assertion
    // in this family of tests can pass vacuously.
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.nodes[0]).toMatchObject({ id: "n1", kind: "command", run: "deploy.sh --env=staging" });
    expect(saved.edges).toEqual([]);
  });

  // "Save it in settings.json for next time" — the drawer's one control whose
  // subject is the SETTING rather than the graph. The write is the host's (a
  // webview has no fs); what these pin is which text is offered, when, and that
  // the graph is left alone.
  describe("keeping a free-text command in settings", () => {
    const saveButton = () => screen.getByRole("button", { name: "Save to settings" });
    const nameField = () => screen.getByLabelText("Name for settings");

    it("posts the command and the name the user typed", () => {
      // Deliberately NOT COMMANDS' own "deploy.sh --env=staging": that text is
      // already a configured command, which is the "already saved" case below.
      render(<OrchestratorDrawer {...props({ flows: [loneCommand({ run: "deploy.sh --env=prod" })] })} />);
      selectChip("deploy.sh --env=prod");
      fireEvent.change(nameField(), { target: { value: "  Deploy to staging  " } });
      fireEvent.click(saveButton());
      // Trimmed here as well as host-side: the label is echoed straight back in a
      // toast, and the host's own trim is what lands in settings.
      expect(send).toHaveBeenCalledWith({
        type: "flow:saveCommand",
        run: "deploy.sh --env=prod",
        label: "Deploy to staging",
      });
    });

    it("saves the command that is ON SCREEN, not the one the flow last committed", () => {
      // The command field is uncontrolled and commits on blur, so the flow's copy
      // is one edit behind whatever was just typed. A Save that read the flow would
      // quietly store the previous command under the new name — and in a real
      // browser the blur would usually mask it, which is exactly the kind of bug
      // that reaches a user and not a test.
      const onSave = vi.fn();
      render(<OrchestratorDrawer {...props({ onSave, flows: [loneCommand({ run: "old.sh" })] })} />);
      selectChip("old.sh");
      fireEvent.change(screen.getByLabelText("Command to run for old.sh"), { target: { value: "new.sh" } });
      fireEvent.change(nameField(), { target: { value: "Deploy" } });
      fireEvent.click(saveButton());
      expect(send).toHaveBeenCalledWith({ type: "flow:saveCommand", run: "new.sh", label: "Deploy" });
    });

    it("touches the flow not at all — saving is about the setting", () => {
      const onSave = vi.fn();
      render(<OrchestratorDrawer {...props({ onSave, flows: [loneCommand({ run: "deploy.sh" })] })} />);
      selectChip("deploy.sh");
      fireEvent.change(nameField(), { target: { value: "Deploy" } });
      fireEvent.click(saveButton());
      // Not rewritten to `{ commandId }` either: `resolveCommand` refuses a node
      // carrying both, so a half-applied pair from one gesture is an errored rule.
      expect(onSave).not.toHaveBeenCalled();
    });

    it("clears the name after a save, so the next one starts empty", () => {
      render(<OrchestratorDrawer {...props({ flows: [loneCommand({ run: "deploy.sh" })] })} />);
      selectChip("deploy.sh");
      fireEvent.change(nameField(), { target: { value: "Deploy" } });
      fireEvent.click(saveButton());
      expect((nameField() as HTMLInputElement).value).toBe("");
    });

    it("saves on Enter in the name field", () => {
      // The gesture a one-field row invites. There is no form to submit, so the key
      // does nothing at all unless it is wired.
      render(<OrchestratorDrawer {...props({ flows: [loneCommand({ run: "deploy.sh" })] })} />);
      selectChip("deploy.sh");
      fireEvent.change(nameField(), { target: { value: "Deploy" } });
      fireEvent.keyDown(nameField(), { key: "Enter" });
      expect(send).toHaveBeenCalledWith({ type: "flow:saveCommand", run: "deploy.sh", label: "Deploy" });
    });

    it("refuses to post without a name", () => {
      render(<OrchestratorDrawer {...props({ flows: [loneCommand({ run: "deploy.sh" })] })} />);
      selectChip("deploy.sh");
      expect(saveButton()).toBeDisabled();
      fireEvent.change(nameField(), { target: { value: "   " } });
      expect(saveButton()).toBeDisabled();
      fireEvent.keyDown(nameField(), { key: "Enter" });
      expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "flow:saveCommand" }));
    });

    it("is not offered for a command with nothing typed yet", () => {
      // `run: ""` is what "Free-text command…" creates. There is nothing to keep.
      render(<OrchestratorDrawer {...props({ flows: [loneCommand({ run: "" })] })} />);
      selectChip(COMMAND_NOT_SET);
      expect(screen.queryByLabelText("Name for settings")).toBeNull();
    });

    it("is not offered for a node that already names a configured command", () => {
      render(<OrchestratorDrawer {...props({ flows: [loneCommand({ commandId: "deploy-staging" })] })} />);
      selectChip("deploy-staging");
      expect(screen.queryByLabelText("Name for settings")).toBeNull();
    });

    it("says a command is already saved instead of offering to save it twice", () => {
      // Matched on the COMMAND, not the name: COMMANDS' own "Smoke test" runs
      // `npm run smoke -- {note}`, and a node carrying that exact text IS that
      // command however it got there.
      render(<OrchestratorDrawer {...props({ flows: [loneCommand({ run: "npm run smoke -- {note}" })] })} />);
      selectChip("npm run smoke -- {note}");
      expect(screen.queryByLabelText("Name for settings")).toBeNull();
      expect(screen.getByTestId("orch-command-saved").textContent).toContain("Smoke test");
    });

    it("does not carry a half-typed name to another node", () => {
      // Two command nodes, one name field. Without the `key`, switching selection
      // would offer the name typed for the first command as the name for the second.
      const twoCommands = flow({
        nodes: [
          { id: "n1", kind: "command", x: 320, y: 24, join: "any", run: "one.sh" },
          { id: "n2", kind: "command", x: 320, y: 112, join: "any", run: "two.sh" },
        ],
      });
      render(<OrchestratorDrawer {...props({ flows: [twoCommands] })} />);
      selectChip("one.sh");
      fireEvent.change(nameField(), { target: { value: "First" } });
      selectChip("two.sh");
      expect((nameField() as HTMLInputElement).value).toBe("");
    });
  });

  it("names a configured command on a node in a flow with no edges at all", () => {
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave, flows: [loneCommand()] })} />);
    selectChip(COMMAND_NOT_SET);
    fireEvent.change(screen.getByLabelText(`Command for ${COMMAND_NOT_SET}`), {
      target: { value: "smoke" },
    });
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    // And never both fields at once — `resolveCommand` refuses that shape rather
    // than guess which one executes.
    expect(saved.nodes[0]).toMatchObject({ commandId: "smoke" });
    expect(saved.nodes[0].kind === "command" && saved.nodes[0].run).toBeUndefined();
  });

  it("offers no free-text field for a node that names a configured command", () => {
    render(<OrchestratorDrawer {...props({ flows: [loneCommand({ commandId: "deploy-staging" })] })} />);
    selectChip("deploy-staging");
    expect(screen.getByLabelText("Command for deploy-staging")).toBeTruthy();
    expect(screen.queryByLabelText("Command to run for deploy-staging")).toBeNull();
  });

  it("selects the node the Add-command picker just created, so the field is there without a further click", () => {
    // The order the user works in — add, configure, wire — with nothing in
    // between. Nothing is clicked between the picker and the field.
    const onSave = vi.fn();
    const initial = props({ onSave, flows: [flow()] });
    const { rerender } = render(<OrchestratorDrawer {...initial} />);
    pickFreeTextCommand();
    rerender(<OrchestratorDrawer {...initial} flows={[onSave.mock.calls.at(-1)![0] as Flow]} />);

    const box = screen.getByLabelText(`Command to run for ${COMMAND_NOT_SET}`);
    fireEvent.change(box, { target: { value: "npm run smoke" } });
    fireEvent.blur(box);
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.nodes[0]).toMatchObject({ kind: "command", run: "npm run smoke" });
  });

  it("reaches the same field from the list view, whose rows are one per rule", () => {
    // The list is the keyboard path, and a fix that worked only on the canvas
    // would reopen for keyboard users the gap this phase closed twice. Its rows
    // are one per RULE, so a node no rule points at appears in none of them —
    // which is why the Actions section and this panel render in both views.
    const onSave = vi.fn();
    const initial = props({ onSave, flows: [flow()] });
    const { rerender } = render(<OrchestratorDrawer {...initial} />);
    fireEvent.click(screen.getByRole("tab", { name: "List" }));
    pickFreeTextCommand();
    rerender(<OrchestratorDrawer {...initial} flows={[onSave.mock.calls.at(-1)![0] as Flow]} />);

    // Still the list view, and it has no rule rows to edit anything through.
    expect(screen.getByTestId("flowlist-empty")).toBeTruthy();
    const box = screen.getByLabelText(`Command to run for ${COMMAND_NOT_SET}`);
    fireEvent.change(box, { target: { value: "deploy.sh --env=prod" } });
    fireEvent.blur(box);
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.nodes[0]).toMatchObject({ kind: "command", run: "deploy.sh --env=prod" });
  });

  it("writes the identical node fields from a selected rule and from the selected node", () => {
    // Both paths stay, because a command node reachable from a selected rule is a
    // reasonable place to see what it runs — and they must not be able to
    // disagree. They cannot: `withCommandId` is one line of `withNodeCommandId`.
    const start = wiredCommand({ run: "" });

    const viaRule = vi.fn();
    const first = render(<OrchestratorDrawer {...props({ onSave: viaRule, flows: [start] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "deploy-staging" } });
    first.unmount();

    const viaNode = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave: viaNode, flows: [start] })} />);
    selectChip(COMMAND_NOT_SET);
    fireEvent.change(screen.getByLabelText(`Command for ${COMMAND_NOT_SET}`), {
      target: { value: "deploy-staging" },
    });

    const a = (viaRule.mock.calls.at(-1)![0] as Flow).nodes;
    const b = (viaNode.mock.calls.at(-1)![0] as Flow).nodes;
    expect(b).toEqual(a);
    expect(b[1]).toMatchObject({ commandId: "deploy-staging" });
  });

  it("shows one Command control at a time — a selection is a rule or a node, never both", () => {
    // Not tidiness: two live selections would put two panels' worth of controls
    // in one slot, and two controls under one accessible name.
    render(<OrchestratorDrawer {...props({ flows: [wiredCommand()] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    expect(screen.getByLabelText("Command")).toBeTruthy();

    selectChip("deploy-staging");
    expect(screen.queryByLabelText("Command")).toBeNull();
    expect(screen.getByLabelText("Command for deploy-staging")).toBeTruthy();

    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    expect(screen.queryByTestId("orch-node-inspector")).toBeNull();
    expect(screen.getByLabelText("Command")).toBeTruthy();
    // And the canvas stops marking the node as selected. Asserted because the
    // inspector alone cannot see it: with both selections live the edge wins the
    // slot either way, so a `sel` left behind by selecting a rule would show up
    // only here — as a highlighted node ring beside a highlighted edge, two
    // claims about one selection.
    expect(screen.getByTestId("orch-node-n2").classList.contains("sel")).toBe(false);
  });

  it("opens on a node clicked on the canvas as well as one picked from the Actions chip", () => {
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave, flows: [loneCommand()] })} />);
    fireEvent.pointerDown(screen.getByTestId("orch-node-n1"), { clientX: 0, clientY: 0 });
    fireEvent.pointerUp(window);
    const box = screen.getByLabelText(`Command to run for ${COMMAND_NOT_SET}`);
    fireEvent.change(box, { target: { value: "make deploy" } });
    fireEvent.blur(box);
    expect((onSave.mock.calls.at(-1)![0] as Flow).nodes[0]).toMatchObject({ run: "make deploy" });
  });

  // A notify node's `message` is node data too, and it was edited through the
  // same edge proxy — the edge inspector's "Notify message" and an open list
  // row's. `addNotify` seeds "say something", so a notify node is never
  // unrunnable the way a blank command node is, but the DEFECT is the same one:
  // add a notify terminal, and there is nowhere to change what it says until a
  // rule points at it. The node inspector covers it with no new mechanism —
  // the same selection, the same panel, the same node-keyed writer.
  it("edits a notify node's message in a flow with no edges at all", () => {
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave, flows: [loneNotify()] })} />);
    selectChip("notify");
    const box = screen.getByLabelText("Message for notify");
    fireEvent.change(box, { target: { value: "the migration landed" } });
    fireEvent.blur(box);
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.nodes[0]).toMatchObject({ kind: "notify", message: "the migration landed" });
    expect(saved.edges).toEqual([]);
  });

  it("keeps the empty state for a node that has nothing this panel edits", () => {
    // A place's conditions and a planned node's mode/destination belong to the
    // RULE that spends them, so selecting one must not open an empty panel.
    render(<OrchestratorDrawer {...props({ flows: [wiredCommand()] })} />);
    expect(screen.getByTestId("orch-inspector").textContent).toBe(INSPECTOR_NONE);
    fireEvent.pointerDown(screen.getByTestId("orch-node-n1"), { clientX: 0, clientY: 0 });
    fireEvent.pointerUp(window);
    expect(screen.queryByTestId("orch-node-inspector")).toBeNull();
    expect(screen.getByTestId("orch-inspector").textContent).toBe(INSPECTOR_NONE);
  });

  it("says a node is selectable, now that one is", () => {
    // The old copy — "Select a connection to set its condition." — was about to
    // become false, and it was worse than incomplete: it told a user who had just
    // added a command node that their only move was to wire something first.
    render(<OrchestratorDrawer {...props({ flows: [loneCommand()] })} />);
    const text = screen.getByTestId("orch-inspector").textContent ?? "";
    expect(text).toBe(INSPECTOR_NONE);
    expect(text).toMatch(/connection/i);
    expect(text).toMatch(/command or notify node/i);
  });
});

describe("the Add-command picker with nothing configured", () => {
  it("says where named commands come from, in a line that is not an option", () => {
    const onSave = vi.fn();
    render(<OrchestratorDrawer {...props({ onSave, commands: [] })} />);
    const list = openCombo("Add a command");
    const hint = within(list).getByText(COMMAND_NONE_LABEL);
    // The actionable half: the setting a user would have to open to have any.
    expect(hint.textContent).toContain("agentFlow.commands");
    // Prose, not a row. The `<select>` this replaced needed a sentinel VALUE for
    // this line and a `disabled` flag to keep it unpickable — and jsdom honoured
    // neither, so the refusal had to be duplicated in the handler. A combo has no
    // value channel to smuggle a sentinel through: the line is a plain div, so
    // clicking it cannot commit anything.
    expect(hint.getAttribute("role")).toBeNull();
    expect(within(list).queryAllByRole("option")).toEqual([]);
    fireEvent.mouseDown(hint);
    fireEvent.mouseDown(screen.getByRole("button", { name: "Add" }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("is absent the moment there is a command to offer", () => {
    render(<OrchestratorDrawer {...props()} />);
    const list = openCombo("Add a command");
    expect(within(list).queryByText(COMMAND_NONE_LABEL)).toBeNull();
    expect(within(list).getAllByRole("option").map((r) => r.textContent)).toEqual([
      "Deploy to staging",
      "Smoke test",
    ]);
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

  it("counts every node it draws, and watches only the ones a condition can be about", () => {
    // `places = nodes.filter(kind !== "notify")` was a fossil from when non-notify
    // meant place: six nodes drawn, header and footer both saying five, and a
    // command node counted as something the flow "watches" — when a command node is
    // a thing a rule points AT and is never observed at all.
    const six = flow({
      armed: true,
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "r" },
        { id: "n2", kind: "place", x: 0, y: 88, join: "any", runKey: "PROJ-2", repo: "r" },
        {
          id: "n3", kind: "planned", x: 320, y: 0, join: "any",
          ticketKey: "PROJ-12", repos: ["r"], mode: "quick", dest: "worktree",
        },
        { id: "n4", kind: "notify", x: 320, y: 88, join: "any", message: "landed" },
        { id: "n5", kind: "command", x: 620, y: 0, join: "any", run: "deploy.sh" },
        { id: "n6", kind: "command", x: 620, y: 88, join: "any", commandId: "deploy-staging" },
      ],
      edges: [],
    });
    render(<OrchestratorDrawer {...props({ flows: [six] })} />);
    // Header and footer both say the same thing, and it is the number drawn.
    expect(screen.getAllByText(/6 nodes · 0 rules/)).toHaveLength(2);
    // Three agent nodes: the two places and the planned work. Not the notify
    // terminal, and not either command node.
    expect(screen.getByText(/armed · watching 3 nodes/i)).toBeTruthy();
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
      { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "PROJ-1", repo: "agent-flow" },
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
      { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "PROJ-1", repo: "agent-flow" },
      { id: "n2", kind: "notify", x: 320, y: 24, join: "any", message: "landed" },
    ],
    edges: [{
      id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "launch",
      error: "Couldn't launch PROJ-12: no worktree",
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
    render(<OrchestratorDrawer {...props({ flows: [erroredFlow()], runs: [runStatus("PROJ-1", "agent-flow")] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    const insp = screen.getByTestId("orch-inspector");
    expect(insp.textContent).toContain("Couldn't launch PROJ-12: no worktree");
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
    expect(err!.textContent).toBe("Couldn't launch PROJ-12: no worktree");
    // And it is NOT wearing the done-coloured receipt class.
    expect(container.querySelector(".orch-obs .fired")).toBeNull();
  });

  it("lets the error win over a receipt when a hand-edited flow carries both", () => {
    const both = erroredFlow({
      edges: [{
        id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "launch",
        firedAt: 5, firedNote: "told you: landed", error: "Couldn't launch PROJ-12: no worktree",
      }],
    });
    render(<OrchestratorDrawer {...props({ flows: [both] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    const insp = screen.getByTestId("orch-inspector");
    expect(insp.textContent).toContain("Couldn't launch PROJ-12: no worktree");
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
// The store's own migration: `latchActionMismatches` stamps an edge whose STORED
// action disagrees with the action its target now implies, so an armed flow
// cannot silently reinterpret a `notify` rule as a paid `seed`. The drawer shows
// it through the same stalled-rule affordance an error uses — which is what
// makes its COLOUR a question, since red in this codebase is for a real failure.
// Task 8's deferral: `observationOf` built its `CondContext` with no `branchCi`,
// so a rule waiting on a branch read "not checked yet" forever — even while the
// host knew the branch was PENDING or FAILED. A rule whose state is invisible.
describe("a branch-CI rule's observation", () => {
  const branchRule = () =>
    flow({
      nodes: [
        { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "PROJ-1", repo: "agent-flow" },
        { id: "n2", kind: "notify", x: 320, y: 24, join: "any", message: "deploy" },
      ],
      edges: [{
        id: "e1", from: "n1", to: "n2",
        cond: { kind: "branch-ci-passed", repo: "agent-flow", branch: "main" },
      }],
    });

  /** Renders, reads the observation line, and UNMOUNTS — so a test that needs
   * two verdicts does not leave two drawers mounted and every query ambiguous. */
  const observationWith = (branchCi: Record<string, "passed" | "failed" | "pending" | "unknown">) => {
    const r = render(<OrchestratorDrawer {...props({
      flows: [branchRule()], runs: [runStatus("PROJ-1", "agent-flow")], branchCi,
    })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    const text = screen.getByTestId("orch-inspector").textContent ?? "";
    r.unmount();
    return text;
  };

  it("says the build is running while the host says pending", () => {
    // Keyed `repo#branch` by `branchCiKey` — the host's own key function, so this
    // test cannot pass against a key format the engine does not use.
    expect(observationWith({ [branchCiKey("agent-flow", "main")]: "pending" })).toContain("main CI running");
  });

  it("says the build failed while the host says failed", () => {
    expect(observationWith({ [branchCiKey("agent-flow", "main")]: "failed" })).toContain("main failed");
  });

  it("says it passed while the host says passed", () => {
    expect(observationWith({ [branchCiKey("agent-flow", "main")]: "passed" })).toContain("main passed");
  });

  it("tells an unreadable branch apart from one nothing has fetched", () => {
    // Two different `unknown`s, deliberately different words: an explicit
    // "unknown" means a call was made and could not be read (worth a look in the
    // log), an absent key means nothing asked yet.
    expect(observationWith({ [branchCiKey("agent-flow", "main")]: "unknown" })).toContain("unreadable");
    expect(observationWith({})).toContain("not checked yet");
  });

  it("does not answer for a different branch's verdict", () => {
    expect(observationWith({ [branchCiKey("agent-flow", "release")]: "passed" })).toContain("not checked yet");
  });
});

describe("a migrated rule's mismatch notice", () => {
  /** An edge saved as `notify` by an older build, pointing at a place — the
   * ordinary leftover shape, since `finishWire` used to create every wire that
   * way — as the store hands it back after latching. `latchesFor` (above) proves
   * the fixture is what the real migration produces rather than a hand-written
   * guess at it. */
  const migrated = (): Flow => {
    const stale = flow({
      nodes: [
        { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "PROJ-1", repo: "agent-flow" },
        { id: "n2", kind: "place", x: 320, y: 24, join: "any", runKey: "PROJ-2", repo: "agent-flow" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" }],
    });
    const files = new Map<string, string>();
    const io = {
      readDir: () => [...files.keys()].map((x) => x.slice(x.lastIndexOf("/") + 1)),
      readFile: (x: string) => files.get(x) ?? null,
      writeFile: (x: string, text: string) => { files.set(x, text); },
      remove: (x: string) => { files.delete(x); },
    };
    writeFlow(io, "/flows", stale);
    return readFlows(io, "/flows")[0];
  };

  it("is really a latched edge, not a hand-written fixture", () => {
    // Guards the two tests below from passing vacuously against a shape the
    // migration does not actually produce.
    expect(migrated().edges[0].error).toContain("no longer matches where it points");
  });

  it("shows the notice and offers Reset — without it the rule is a dead end", () => {
    const onResetEdge = vi.fn();
    render(<OrchestratorDrawer {...props({ flows: [migrated()], onResetEdge })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    expect(screen.getByTestId("orch-inspector").textContent).toContain("Reset the rule to accept that");
    fireEvent.click(screen.getByRole("button", { name: /reset/i }));
    expect(onResetEdge).toHaveBeenCalledWith("f1", "e1");
  });

  it("does not paint it red — nothing ran, and nothing broke", () => {
    // `--c-danger` is this codebase's one claim of "a real failure" (see
    // orchestratorStyles.ts's own comments). A migration notice means this build
    // reads an old file more carefully than the build that wrote it, and the
    // rule is waiting for the user to accept the new reading.
    const { container } = render(<OrchestratorDrawer {...props({ flows: [migrated()] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    expect(container.querySelector(".orch-obs .err")).toBeNull();
    // Still SAID, though — quietly, in the observation row's own dim voice.
    expect(container.querySelector(".orch-obs")!.textContent).toContain("no longer matches");
  });

  it("does not turn the footer's dot red either — the panel makes ONE severity claim", () => {
    // The defect this closes was the two halves disagreeing: the inspector
    // deliberately refused to paint the notice red, and eleven lines below it
    // the footer's dot (`--c-danger`) painted the same edge red anyway. A user
    // reads the footer first, goes hunting for a failure, and the inspector
    // denies there was one.
    const { container } = render(
      <OrchestratorDrawer {...props({ flows: [{ ...migrated(), armed: true }] })} />,
    );
    expect(container.querySelector(".orch-ft .live.stalled")).toBeNull();
    // The SENTENCE still counts it, which is honest: the rule will not fire
    // until Reset, and the footer is the only place that says so at a glance.
    expect(screen.getByText(/armed · 1 rule stalled/i)).toBeTruthy();
  });

  it("still reddens the dot when a real failure stalls the same flow", () => {
    // The other side of the split, so "never red" cannot be the fix: one
    // migration notice AND one genuine failure on one armed flow.
    const both = { ...migrated(), armed: true };
    both.edges = [
      both.edges[0],
      { id: "e2", from: "n1", to: "n2", cond: { kind: "ci-passed" }, error: "Couldn't seed PROJ-2: no worktree" },
    ];
    const { container } = render(<OrchestratorDrawer {...props({ flows: [both] })} />);
    expect(container.querySelector(".orch-ft .live.stalled")).not.toBeNull();
    expect(screen.getByText(/armed · 2 rules stalled/i)).toBeTruthy();
  });

  it("still paints a rule that actually failed red", () => {
    // The other side of the same branch, so "never red" cannot be the fix.
    const failed = flow({
      nodes: migrated().nodes,
      edges: [{
        id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" },
        error: "Couldn't seed PROJ-2: no worktree",
      }],
    });
    const { container } = render(<OrchestratorDrawer {...props({ flows: [failed] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    expect(container.querySelector(".orch-obs .err")!.textContent).toContain("Couldn't seed");
  });
});

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
      nodes: [{ id: "n1", kind: "place", x: 500, y: 24, join: "any", runKey: "PROJ-1", repo: "r" }],
    });
    render(<OrchestratorDrawer {...props({ flows: [wide] })} />);
    expect(screen.getByTestId("orch-graph-fade")).toBeTruthy();
  });

  it("does not appear when every node comfortably fits", () => {
    const fits = flow({
      nodes: [{ id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "PROJ-1", repo: "r" }],
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
      nodes: [{ id: "n1", kind: "place", x: 368, y: 24, join: "any", runKey: "PROJ-1", repo: "r" }],
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
    expect(screen.getByRole("button", { name: "Add a place" })).toBeTruthy();
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

  it("the place picker is an ordinary, keyboard-reachable control", () => {
    openList({ flows: [flow()], runs: [runStatus("PROJ-1", "agent-flow")] });
    const trigger = screen.getByRole("button", { name: "Add a place" });
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger).not.toHaveAttribute("tabindex", "-1");
    expect(trigger).not.toBeDisabled();
    // Closed until asked, and it says so — the only cue a keyboard user has that
    // this control holds a list rather than firing on press.
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
  });

  it("choosing a run from the place picker adds it, through the same attach the drag path uses", () => {
    const onSave = vi.fn();
    openList({ onSave, flows: [flow()], runs: [runStatus("PROJ-1", "agent-flow")] });
    pickFromCombo("Add a place", ["PROJ-1"]);
    const saved = onSave.mock.calls[0][0] as Flow;
    expect(saved.nodes).toEqual([
      expect.objectContaining({ kind: "place", runKey: "PROJ-1", repo: "agent-flow" }),
    ]);
  });

  it("attaches several places in one save", () => {
    // Two repos of one run, both wanted. Through a `<select>` this was two trips;
    // the risk the fold has to answer is that both nodes get their own id and y
    // rather than the second overwriting what the first computed.
    const onSave = vi.fn();
    const twoRepo = runStatus("PROJ-1", "web", {
      repos: [
        { name: "web", path: "/r/web", branch: "b", dirty: false, ahead: 0, added: 0, removed: 0, files: 0 },
        { name: "api", path: "/r/api", branch: "b", dirty: false, ahead: 0, added: 0, removed: 0, files: 0 },
      ],
    });
    openList({ onSave, flows: [flow()], runs: [twoRepo] });
    pickFromCombo("Add a place", ["web", "api"]);
    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0] as Flow;
    expect(saved.nodes.map((n) => (n.kind === "place" ? n.repo : n.kind))).toEqual(["web", "api"]);
    expect(new Set(saved.nodes.map((n) => n.id)).size).toBe(2);
    expect(new Set(saved.nodes.map((n) => n.y)).size).toBe(2);
  });

  it("prints a run key as an identifier, the same way the tray's chips do", () => {
    // Both halves together, since jsdom loads no sheet: the row really does mark
    // its key as mono, and the sheet really does give that class the mono family.
    // A command's label goes through the same component and must NOT — see the
    // per-option `mono` flag.
    openList({ flows: [flow()], runs: [runStatus("PROJ-1", "agent-flow")] });
    const row = within(openCombo("Add a place")).getAllByRole("option")[0];
    expect(row.querySelector(".l")!.className).toBe("l k");
    expect(ORCH_CSS).toContain(".combo-t .l.k { font-family: var(--mono)");
  });

  it("finds a place by typing its repo, which is the row's second line", () => {
    // The repo is printed as the row's detail, so filtering on the run key alone
    // would put a name on screen that cannot be typed.
    const twoRepo = runStatus("PROJ-1", "web", {
      repos: [
        { name: "web", path: "/r/web", branch: "b", dirty: false, ahead: 0, added: 0, removed: 0, files: 0 },
        { name: "api", path: "/r/api", branch: "b", dirty: false, ahead: 0, added: 0, removed: 0, files: 0 },
      ],
    });
    openList({ flows: [flow()], runs: [twoRepo] });
    const list = openCombo("Add a place");
    fireEvent.change(screen.getByPlaceholderText("Filter places…"), { target: { value: "api" } });
    const rows = within(list).getAllByRole("option");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("api");
  });

  it("excludes a run/repo pair already attached to this flow — choosing it again would silently do nothing", () => {
    const already = flow({ nodes: [{ id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "agent-flow" }] });
    openList({ flows: [already], runs: [runStatus("PROJ-1", "agent-flow")] });
    const list = openCombo("Add a place");
    expect(within(list).queryAllByRole("option")).toEqual([]);
    // And it says why, rather than showing an empty box that looks broken.
    expect(within(list).getByText(/Nothing left to attach/)).toBeTruthy();
  });

  it("offers every repo of a multi-repo run, not only whichever one an agent happens to be bound to", () => {
    const twoRepo = runStatus("PROJ-1", "web", {
      repos: [
        { name: "web", path: "/r/web", branch: "b", dirty: false, ahead: 0, added: 0, removed: 0, files: 0 },
        { name: "api", path: "/r/api", branch: "b", dirty: false, ahead: 0, added: 0, removed: 0, files: 0 },
      ],
    });
    openList({ flows: [flow()], runs: [twoRepo] });
    const rows = within(openCombo("Add a place")).getAllByRole("option");
    expect(rows.map((r) => r.textContent)).toEqual(["PROJ-1web", "PROJ-1api"]);
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
    const initial = props({ onSave, flows: [flow()], runs: [runStatus("PROJ-1", "agent-flow")] });
    const { rerender } = render(<OrchestratorDrawer {...initial} />);
    const rerenderWith = (next: Flow) => rerender(<OrchestratorDrawer {...initial} flows={[next]} />);

    fireEvent.click(screen.getByRole("tab", { name: "List" }));

    // A place, from the keyboard picker.
    pickFromCombo("Add a place", ["PROJ-1"]);
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
        expect.objectContaining({ kind: "place", runKey: "PROJ-1", repo: "agent-flow" }),
        expect.objectContaining({ kind: "notify" }),
      ]),
    );
    expect(saved.edges).toHaveLength(1);
    expect(saved.edges[0]).toMatchObject({
      from: place.id, to: notify.id, cond: { kind: "ci-passed" },
    });
    // No stored action, the same shape `finishWire` creates on the canvas: the
    // target IS the verb now, and an edge with no stored action is the one shape
    // `latchActionMismatches` can never latch.
    expect(saved.edges[0].action).toBeUndefined();
  });

  // The other half of the same promise, for the node kind Task 9 added. Phase 3
  // shipped a launch path nothing in the UI could create a `planned` node for,
  // which made it unreachable; a command rule buildable only with a mouse would
  // repeat that for everyone who cannot use one. Every step here is a keyboard
  // control: a select, a select, a button, a select, a text field.
  it("adds a command node, wires a rule to it, and types what it runs — no pointer gesture", () => {
    const onSave = vi.fn();
    const initial = props({ onSave, flows: [flow()], runs: [runStatus("PROJ-1", "agent-flow")] });
    const { rerender } = render(<OrchestratorDrawer {...initial} />);
    const rerenderWith = (next: Flow) => rerender(<OrchestratorDrawer {...initial} flows={[next]} />);

    fireEvent.click(screen.getByRole("tab", { name: "List" }));

    // A place to watch.
    pickFromCombo("Add a place", ["PROJ-1"]);
    let saved = onSave.mock.calls.at(-1)![0] as Flow;
    rerenderWith(saved);

    // A command node, in the free-text shape — offered regardless of what
    // `agentFlow.commands` holds, for a one-off command not worth naming in
    // settings.
    pickFreeTextCommand();
    saved = onSave.mock.calls.at(-1)![0] as Flow;
    rerenderWith(saved);
    const place = saved.nodes.find((n) => n.kind === "place")!;
    const command = saved.nodes.find((n) => n.kind === "command")!;
    expect(command).toMatchObject({ run: "" }); // "free text, nothing typed yet"

    // The rule, from the list's own new-rule bar.
    const bar = screen.getByTestId("flowlist-newrule");
    fireEvent.change(within(bar).getByLabelText("From node"), { target: { value: place.id } });
    fireEvent.change(within(bar).getByLabelText("New rule condition"), { target: { value: "ci-passed" } });
    fireEvent.change(within(bar).getByLabelText("To node"), { target: { value: command.id } });
    fireEvent.click(within(bar).getByRole("button", { name: "+ Add rule" }));
    saved = onSave.mock.calls.at(-1)![0] as Flow;
    rerenderWith(saved);
    expect(saved.edges).toHaveLength(1);
    expect(saved.edges[0]).toMatchObject({ from: place.id, to: command.id, cond: { kind: "ci-passed" } });
    expect(saved.edges[0].action).toBeUndefined();

    // And what it runs, typed into the rule's own open row — the step that used
    // to exist only in the canvas inspector, which is unreachable by keyboard.
    const row = screen.getByTestId(`flowlist-row-${saved.edges[0].id}`);
    fireEvent.keyDown(row, { key: "Enter" });
    const box = within(row).getByLabelText("Command to run");
    fireEvent.change(box, { target: { value: "deploy.sh --env=staging" } });
    fireEvent.blur(box);
    saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.nodes.find((n) => n.id === command.id)).toMatchObject({ run: "deploy.sh --env=staging" });
    // A flow that would actually fire: `resolveCommand` refuses a blank `run`,
    // and this one is no longer blank.
    expect(saved.edges[0].error).toBeUndefined();
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
