// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import * as React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { FlowList } from "../../src/webview/flowList";
import {
  COMMAND_FREE_TEXT,
  COMMAND_NOT_SET,
  NOTE_COMMAND_HINT,
  NOTE_COMMAND_PLACEHOLDER,
  NOTE_PLACEHOLDER,
} from "../../src/webview/orchestratorRule";
import { ACTION_MISMATCH_PREFIX } from "../../src/engine/orchestrator/model";
import type { Flow } from "../../src/engine/orchestrator/model";

const flow = (over: Partial<Flow> = {}): Flow => ({
  id: "f1", name: "Ship the migration", armed: false, createdAt: 1_000, nodes: [], edges: [], ...over,
});

const MODES = [
  { id: "quick", label: "Quick pass" },
  { id: "careful", label: "Careful review" },
];

/** `agentFlow.commands`, as the host posts it. The ids are made up for this
 * file on purpose — distinct from the one id `DEFAULT_COMMANDS` ships
 * (`verify-on-dev`) — so a picker showing one of these can only have read the
 * prop, never a hardcoded list. Same fixture and same reasoning as
 * OrchestratorDrawer.test.tsx's own, since one list feeds both
 * presentations. */
const COMMANDS = [
  { id: "deploy-staging", label: "Deploy to staging", run: "deploy.sh --env=staging" },
  { id: "smoke", label: "Smoke test", run: "npm run smoke -- {note}" },
];

const props = (over: Partial<React.ComponentProps<typeof FlowList>> = {}) => ({
  flow: flow(),
  runs: [],
  promptModes: MODES,
  commands: COMMANDS,
  onSave: vi.fn(),
  onResetEdge: vi.fn(),
  ...over,
});

/** Three notify rules into one terminal — enough rows to exercise Up/Down and
 * Delete without every test needing its own bespoke three-node graph. */
const threeRules = () =>
  flow({
    nodes: [
      { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "r" },
      { id: "n2", kind: "place", x: 0, y: 88, join: "any", runKey: "PROJ-2", repo: "r" },
      { id: "n3", kind: "place", x: 0, y: 176, join: "any", runKey: "PROJ-3", repo: "r" },
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
      { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "agent-flow" },
      {
        id: "n2", kind: "planned", x: 320, y: 0, join: "any",
        ticketKey: "PROJ-12", repos: ["agent-flow"], mode: "quick", dest: "worktree",
      },
    ],
    edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "launch", ...edgeOver }],
  });

/** A place feeding a notify terminal — the ONLY pairing that derives `notify`
 * now that the verb comes from the target. A stored `action: "notify"` on any
 * other pairing is a stale value the sentence deliberately ignores (see the
 * "described by its target" tests below), so a test about notify's own wording
 * has to be built on a real notify node. */
const placeAndNotify = (edgeOver: Partial<Flow["edges"][number]> = {}) =>
  flow({
    nodes: [
      { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "agent-flow" },
      { id: "n2", kind: "notify", x: 320, y: 0, join: "any", message: "landed" },
    ],
    edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, ...edgeOver }],
  });

/** Two places — the pairing `seed` derives from. */
const twoPlaces = (edgeOver: Partial<Flow["edges"][number]> = {}) =>
  flow({
    nodes: [
      { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "agent-flow" },
      { id: "n2", kind: "place", x: 320, y: 0, join: "any", runKey: "PROJ-2", repo: "agent-flow" },
    ],
    edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify", ...edgeOver }],
  });

/** A place feeding a command node — the pairing `run` implies (`actionFor`), and
 * the one the new-rule bar can now build end to end (see "adding a rule from the
 * keyboard" below). `commandId` is one of `COMMANDS`, so the open row's Command
 * picker has a real option to match it. */
const placeAndCommand = (
  edgeOver: Partial<Flow["edges"][number]> = {},
  nodeOver: Partial<{ commandId: string; run: string }> = { commandId: "deploy-staging" },
) =>
  flow({
    nodes: [
      { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "agent-flow" },
      { id: "n2", kind: "command", x: 320, y: 0, join: "any", ...nodeOver },
    ],
    edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, ...edgeOver }],
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
    expect(row.textContent).toContain("PROJ-12"); // the target
  });

  it("reads notify's clause as complete on its own, with no bare target after it", () => {
    render(<FlowList {...props({ flow: placeAndNotify() })} />);
    const row = screen.getByTestId("flowlist-row-e1");
    // The spec's rename: "notify me" alone reads as if it messages somebody,
    // which is the confusion that started this phase. Both presentations spend
    // `ACTION_LABEL` for exactly this reason, so the list gets the new wording
    // for free — this assertion is the one place it was hand-typed.
    expect(row.textContent).toContain("Notify me in VS Code");
  });

  // `endLabel` used to fall through to the literal word "notify" for any
  // target that was neither a place nor planned work — honest for a real
  // notify node, but paired with `ACTION_LABEL.run` it read as "THEN run
  // notify": a rule that executes shell, described as if it sends a toast.
  it("labels a command target by its own identifier, not the notify fallthrough", () => {
    render(<FlowList {...props({ flow: placeAndCommand() })} />);
    const row = screen.getByTestId("flowlist-row-e1");
    // The verb read off its own handle and matched EXACTLY, not searched for in
    // the row's text: "run" is a substring of several strings this row can
    // carry (the note hint's "…a note can extend what runs" among them), so a
    // `toContain("run")` passes with no verb rendered at all — measured twice on
    // the canvas side.
    expect(screen.getByTestId("flowlist-then-e1").textContent).toBe("run");
    expect(row.textContent).toContain("deploy-staging"); // the target's own identifier
    expect(row.textContent).not.toContain("notify");
  });

  // Blocker 3. A closed `run` row used to fall through to the launch/seed
  // branch and read "THEN run deploy-staging USING (no mode set)" — a clause
  // about `edge.mode`, which `performEdge` never reads for a command. The whole
  // USING/mode/destination vocabulary belongs to an agent session.
  it("gives a command rule no mode clause and no destination — a command is not an agent session", () => {
    render(<FlowList {...props({ flow: placeAndCommand() })} />);
    const row = screen.getByTestId("flowlist-row-e1");
    expect(row.textContent).not.toContain("(no mode set)");
    expect(row.textContent).not.toContain("USING");
    expect(row.textContent).not.toContain("worktree");
    fireEvent.click(row); // and no such control once opened, either
    expect(within(row).queryByLabelText("Mode")).toBeNull();
    expect(within(row).queryByLabelText("Destination")).toBeNull();
  });

  // `coerceFlow` never fills `action` in, and a bare read never calls
  // `writeFlow` — so an edge with NO stored action, pointing at planned work,
  // is reachable on the ordinary read path, not just a hypothetical. It must
  // read as the launch its target implies, not as a defaulted-to-notify rule:
  // that used to render "notify me" with an empty quoted message, suppress
  // the target identifier, and drop the mode/destination clause entirely —
  // wrong in every particular, not merely incomplete.
  it("derives the action from the target rather than defaulting to notify, when the edge has none stored", () => {
    render(<FlowList {...props({ flow: placeAndPlanned({ action: undefined }) })} />);
    const row = screen.getByTestId("flowlist-row-e1");
    expect(row.textContent).toContain("launch"); // the derived action
    expect(row.textContent).toContain("PROJ-12"); // the target identifier, not suppressed
    expect(row.textContent).not.toContain("notify me");
  });

  it("shows a launch or seed rule's note, truncated, after the mode", () => {
    const longNote = "x".repeat(60);
    render(<FlowList {...props({ flow: placeAndPlanned({ note: longNote }) })} />);
    const row = screen.getByTestId("flowlist-row-e1");
    // Truncated to 40 chars plus an ellipsis — the full 60-char note never
    // reaches a closed row, which is for scanning, not reading.
    expect(row.textContent).toContain(`${"x".repeat(40)}…`);
    expect(row.textContent).not.toContain(longNote);
    const modeIdx = row.textContent!.indexOf("Quick pass");
    const noteIdx = row.textContent!.indexOf("x".repeat(40));
    expect(modeIdx).toBeGreaterThan(-1);
    expect(noteIdx).toBeGreaterThan(modeIdx);
  });

  it("shows a short note in full, with no ellipsis", () => {
    render(<FlowList {...props({ flow: placeAndPlanned({ note: "keep an eye on this" }) })} />);
    const row = screen.getByTestId("flowlist-row-e1");
    expect(row.textContent).toContain("keep an eye on this");
    expect(row.textContent).not.toContain("…");
  });

  it("shows no note text at all on a closed row when the rule carries none", () => {
    render(<FlowList {...props({ flow: placeAndPlanned() })} />);
    const row = screen.getByTestId("flowlist-row-e1");
    expect(row.textContent).not.toContain("…");
    expect(row.textContent).not.toContain("“"); // the opening curly quote a note would be wrapped in
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

  it("the condition, mode and destination controls are ordinary form controls, reachable in order", () => {
    const launching = placeAndPlanned();
    render(<FlowList {...props({ flow: launching })} />);
    const row1 = screen.getByTestId("flowlist-row-e1");
    fireEvent.click(row1);
    const within1 = within(row1);
    expect(within1.getByLabelText("Condition").tagName).toBe("SELECT");
    expect(within1.getByLabelText("Mode").tagName).toBe("SELECT");
    expect(within1.getByLabelText("Destination").tagName).toBe("SELECT");
  });

  // Blocker 2, and the reason there is no Action control above. The verb comes
  // from the target (`edgeAction`), so a `<select>` could not decide anything:
  // its pick was overridden on the next read AND stored, which is exactly the
  // disagreement `latchActionMismatches` stamps an edge dead for. It offered
  // three of the four verbs, so a `run` rule's value matched no option at all —
  // blank in a browser, "launch" under jsdom, and touching it killed the rule.
  it("an open row states the derived verb instead of offering an Action control", () => {
    const onSave = vi.fn();
    render(<FlowList {...props({ flow: placeAndCommand(), onSave })} />);
    const row = screen.getByTestId("flowlist-row-e1");
    fireEvent.click(row);
    expect(within(row).queryByLabelText("Action")).toBeNull();
    // Exact, on the verb's own handle: an open `run` row renders "USING" and the
    // note hint, both of which contain "run" as a substring.
    expect(screen.getByTestId("flowlist-then-e1").textContent).toBe("run");
    // And the command is named ONCE in an open row — by the picker below, which
    // is the control that changes it. The mono identifier a closed row prints
    // after the verb would be the same rule's own name twice in one row.
    expect(row.textContent).not.toContain("deploy-staging");
    // And nothing about opening the row writes a stored action, which is what
    // made the old control fatal rather than merely useless.
    expect(onSave).not.toHaveBeenCalled();
  });

  it("edits the condition through the open row's own select", () => {
    const onSave = vi.fn();
    render(<FlowList {...props({ flow: threeRules(), onSave })} />);
    fireEvent.click(screen.getByTestId("flowlist-row-e1"));
    fireEvent.change(screen.getByLabelText("Condition"), { target: { value: "ci-failed" } });
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.edges.find((e) => e.id === "e1")!.cond).toEqual({ kind: "ci-failed" });
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
    const placeToNotify = placeAndNotify();
    (placeToNotify.nodes[1] as { message: string }).message = "say something";
    render(<FlowList {...props({ flow: placeToNotify, onSave })} />);
    fireEvent.click(screen.getByTestId("flowlist-row-e1"));
    const box = screen.getByLabelText("Notify message");
    fireEvent.change(box, { target: { value: "the migration has landed" } });
    fireEvent.blur(box);
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.nodes.find((n) => n.id === "n2")).toMatchObject({ message: "the migration has landed" });
  });

  it("offers a note for an open launch or seed row, but not for notify", () => {
    const launching = placeAndPlanned();
    const r1 = render(<FlowList {...props({ flow: launching })} />);
    fireEvent.click(screen.getByTestId("flowlist-row-e1"));
    expect(screen.getByLabelText("Note")).toBeTruthy();
    r1.unmount();

    const seeding = twoPlaces({ action: "seed", mode: "quick" });
    const r2 = render(<FlowList {...props({ flow: seeding })} />);
    fireEvent.click(screen.getByTestId("flowlist-row-e1"));
    expect(screen.getByLabelText("Note")).toBeTruthy();
    r2.unmount();

    render(<FlowList {...props({ flow: placeAndNotify() })} />); // derives notify
    fireEvent.click(screen.getByTestId("flowlist-row-e1"));
    expect(screen.queryByLabelText("Note")).toBeNull();
  });

  // Debt 5's second surface. A command's note is spliced into the command string
  // unquoted (`command.ts`'s `withNote`), so `deploy.sh --env={note}` with a note
  // of `prod; rm -rf ~` runs both — and until now that was said at the canvas
  // inspector's note field and nowhere else, i.e. at one of the two places a
  // person actually types one.
  it("a command rule's note field discloses that a note is spliced in unquoted", () => {
    render(<FlowList {...props({ flow: placeAndCommand() })} />);
    const row = screen.getByTestId("flowlist-row-e1");
    fireEvent.click(row);
    expect(row.textContent).toContain(NOTE_COMMAND_HINT);
    // And the placeholder is the command one, not the launch/seed copy that
    // spends its whole width contrasting "note" with a mode this row has not got.
    expect(within(row).getByLabelText("Note")).toHaveAttribute("placeholder", NOTE_COMMAND_PLACEHOLDER);
  });

  it("says nothing about splicing on a launch rule, which composes its note rather than substituting it", () => {
    render(<FlowList {...props({ flow: placeAndPlanned() })} />);
    const row = screen.getByTestId("flowlist-row-e1");
    fireEvent.click(row);
    expect(row.textContent).not.toContain(NOTE_COMMAND_HINT);
    expect(within(row).getByLabelText("Note")).toHaveAttribute("placeholder", NOTE_PLACEHOLDER);
  });

  it("edits the note on blur through the open row's own input", () => {
    const onSave = vi.fn();
    const launching = placeAndPlanned();
    render(<FlowList {...props({ flow: launching, onSave })} />);
    fireEvent.click(screen.getByTestId("flowlist-row-e1"));
    const box = screen.getByLabelText("Note");
    fireEvent.change(box, { target: { value: "watch for the flaky upload test" } });
    fireEvent.blur(box);
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.edges[0].note).toBe("watch for the flaky upload test");
  });

});

// The keyboard half of Task 9's command work: the command a rule runs lives on
// the target node, and the ONLY place it could be chosen or its free text typed
// was the canvas inspector. A command node reachable from the keyboard whose
// command was not is the same one-step-short gap phase 3 shipped for `planned`
// work.
describe("choosing what a command rule runs, from an open row", () => {
  it("offers every configured command and a free-text option, in the host's own order", () => {
    render(<FlowList {...props({ flow: placeAndCommand() })} />);
    fireEvent.click(screen.getByTestId("flowlist-row-e1"));
    const values = Array.from(
      screen.getByLabelText("Command").querySelectorAll("option"),
    ).map((o) => (o as HTMLOptionElement).value);
    expect(values).toEqual(["deploy-staging", "smoke", COMMAND_FREE_TEXT]);
    expect(screen.getByText("Deploy to staging")).toBeTruthy();
  });

  it("picks a configured command, writing it onto the target node and clearing any free text", () => {
    const onSave = vi.fn();
    render(<FlowList {...props({ flow: placeAndCommand({}, { run: "deploy.sh" }), onSave })} />);
    fireEvent.click(screen.getByTestId("flowlist-row-e1"));
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "smoke" } });
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.nodes.find((n) => n.id === "n2")).toMatchObject({ commandId: "smoke" });
    // Never both fields — `resolveCommand` refuses a node carrying a usable
    // `commandId` AND a usable `run` rather than guess which one executes.
    expect((saved.nodes.find((n) => n.id === "n2") as { run?: string }).run).toBeUndefined();
    // And the write lands on the NODE, not the edge: `performEdge` resolves the
    // command from the node it points at.
    expect(saved.edges[0]).not.toHaveProperty("commandId");
  });

  it("picks free text, and typing it lands on the node", () => {
    const onSave = vi.fn();
    const { rerender } = render(<FlowList {...props({ flow: placeAndCommand(), onSave })} />);
    fireEvent.click(screen.getByTestId("flowlist-row-e1"));
    // A configured command has nothing to type, so the field is not there yet.
    expect(screen.queryByLabelText("Command to run")).toBeNull();
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: COMMAND_FREE_TEXT } });
    let saved = onSave.mock.calls.at(-1)![0] as Flow;
    // The "free text, nothing typed yet" shape — blank `run`, no `commandId`.
    expect(saved.nodes.find((n) => n.id === "n2")).toMatchObject({ run: "" });
    expect((saved.nodes.find((n) => n.id === "n2") as { commandId?: string }).commandId).toBeUndefined();

    // Re-rendered on the flow that write actually produced, the same way the
    // real webview re-renders on the host's echo — this is what makes the field
    // appear, and typing into it complete the keyboard path.
    rerender(<FlowList {...props({ flow: saved, onSave })} />);
    const box = screen.getByLabelText("Command to run");
    fireEvent.change(box, { target: { value: "deploy.sh --env=staging" } });
    fireEvent.blur(box);
    saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.nodes.find((n) => n.id === "n2")).toMatchObject({ run: "deploy.sh --env=staging" });
  });

  it("says so, rather than showing the first configured command, for a command that is not configured", () => {
    render(<FlowList {...props({ flow: placeAndCommand({}, { commandId: "gone" }) })} />);
    fireEvent.click(screen.getByTestId("flowlist-row-e1"));
    const select = screen.getByLabelText("Command") as HTMLSelectElement;
    // The value AND the label, not `selectedIndex`: jsdom resolves an unmatched
    // value to the first option, so a browser's blank control shows up here as
    // "Deploy to staging" — a command that would run while `resolveCommand`
    // refuses the one actually on the node.
    expect(select.value).toBe("gone");
    expect(select.selectedOptions[0].textContent).toBe("gone (not configured)");
  });

  it("says a free-text node with nothing typed has no command set, in the closed row's own sentence", () => {
    // `run: ""` is exactly what the Add-command picker's free-text option creates,
    // and `resolveCommand` refuses it — so an armed flow latches this rule errored.
    // The CLOSED row is the reading a scanning user gets, and it used to say
    // "THEN run command", i.e. as though the node were configured. Asserted on the
    // row, not on the open Command select (which already said so).
    render(<FlowList {...props({ flow: placeAndCommand({}, { run: "" }) })} />);
    const row = screen.getByTestId("flowlist-row-e1");
    expect(row.textContent).toContain(COMMAND_NOT_SET);
  });

  it("says '(no command set)' for a hand-edited node carrying neither field", () => {
    render(<FlowList {...props({ flow: placeAndCommand({}, {}) })} />);
    fireEvent.click(screen.getByTestId("flowlist-row-e1"));
    const select = screen.getByLabelText("Command") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(select.selectedOptions[0].textContent).toBe("(no command set)");
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
    render(<FlowList {...props({ flow: placeAndNotify(), onSave })} />);
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
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "agent-flow" },
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
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "agent-flow" },
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

// What used to be the two "an impossible action, refused with a visible reason"
// tests. Under derivation a user cannot MAKE a launch-at-a-place pairing — the
// target IS the verb — so the question is no longer "is the disagreement
// explained" but "does the row describe the rule by its target". A stale stored
// action is a migration matter, and `store.ts` is what surfaces it (see the
// migration-notice tests below). Same rewrite, same wording, as the canvas
// inspector's own pair of these.
describe("a rule described by its target, not by a stale stored action", () => {
  it("describes a rule pointing at a place as a seed, whatever a stale action says", () => {
    render(<FlowList {...props({ flow: twoPlaces({ action: "launch" }) })} />);
    const row = screen.getByTestId("flowlist-row-e1");
    expect(screen.getByTestId("flowlist-then-e1").textContent).toBe("seed");
    fireEvent.click(row);
    // A seed has no destination to pick — the place already exists.
    expect(within(row).queryByLabelText("Destination")).toBeNull();
    // But it does have a mode, which is the thing `performSeed` reads.
    expect(within(row).getByLabelText("Mode")).toBeTruthy();
  });

  it("the mirror: a rule pointing at planned work is a launch, whatever a stale action says", () => {
    render(<FlowList {...props({ flow: placeAndPlanned({ action: "seed" }) })} />);
    const row = screen.getByTestId("flowlist-row-e1");
    expect(screen.getByTestId("flowlist-then-e1").textContent).toBe("launch");
    fireEvent.click(row);
    expect(within(row).getByLabelText("Destination")).toBeTruthy();
  });

  it("does not spend red on a stale action — nothing has tried and failed", () => {
    render(<FlowList {...props({ flow: twoPlaces({ action: "launch" }) })} />);
    const row = screen.getByTestId("flowlist-row-e1");
    expect(row.querySelector(".err")).toBeNull();
  });

  // `store.ts`'s `validNode` admits a node kind this build does not know, on
  // purpose, so a flow written by a NEWER build still renders. There is no verb
  // to state for such a target and no clause to finish, so the row says exactly
  // that — dim, in the inspector's own words, because nothing has failed.
  it("says the action cannot be determined for a target of an unknown kind", () => {
    const fromTheFuture = flow({
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "agent-flow" },
        { id: "n2", kind: "portal", x: 320, y: 0, join: "any" } as unknown as Flow["nodes"][number],
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" } }],
    });
    render(<FlowList {...props({ flow: fromTheFuture })} />);
    expect(screen.getByTestId("flowlist-then-e1").textContent).toContain("can’t be determined");
    fireEvent.click(screen.getByTestId("flowlist-row-e1"));
    // No clause of any kind belongs to a verb nobody can name.
    expect(screen.queryByLabelText("Mode")).toBeNull();
    expect(screen.queryByLabelText("Command")).toBeNull();
    expect(screen.queryByLabelText("Notify message")).toBeNull();
  });
});

/** Two places with no rule between them yet — what building the FIRST rule
 * from the keyboard starts from. */
const twoPlacesNoEdge = () =>
  flow({
    nodes: [
      { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "agent-flow" },
      { id: "n2", kind: "place", x: 320, y: 0, join: "any", runKey: "PROJ-2", repo: "agent-flow" },
    ],
  });

/** A place and a planned node, no rule yet — the pairing a `launch` rule can
 * be built onto. */
const placeAndPlannedNoEdge = () =>
  flow({
    nodes: [
      { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "agent-flow" },
      {
        id: "n2", kind: "planned", x: 320, y: 0, join: "any",
        ticketKey: "PROJ-12", repos: ["agent-flow"], mode: "quick", dest: "worktree",
      },
    ],
  });

// Debt 7's other half: the same blank-select defect the inspector had, in the
// open row — and the closed row, which named the KIND but never the branch.
// The store's migration notice, in the list's own receipt row. Same helper the
// inspector uses, so the two presentations cannot disagree about what counts as
// a failure worth painting red.
describe("a migrated rule's mismatch notice", () => {
  /** Built from `ACTION_MISMATCH_PREFIX` itself — the constant the migration,
   * the drawer's copy and these tests are all meant to name once — so this
   * fixture cannot drift into a string `isMigrationNotice` no longer
   * recognises and quietly pass for the wrong reason. */
  const noticed = () =>
    twoPlaces({
      action: "notify",
      error: `${ACTION_MISMATCH_PREFIX}: it was saved as "notify" but where it points now means "seed".`,
    });

  it("says so without claiming the flow failed", () => {
    const { container } = render(<FlowList {...props({ flow: noticed() })} />);
    fireEvent.click(screen.getByTestId("flowlist-row-e1"));
    expect(container.querySelector(".fl-receipt .err")).toBeNull();
    expect(container.querySelector(".fl-receipt")!.textContent).toContain("no longer matches");
  });

  it("still paints a rule that actually failed red", () => {
    const { container } = render(
      <FlowList {...props({ flow: twoPlaces({ error: "Couldn't seed PROJ-2: no worktree" }) })} />,
    );
    fireEvent.click(screen.getByTestId("flowlist-row-e1"));
    expect(container.querySelector(".fl-receipt .err")!.textContent).toContain("Couldn't seed");
  });
});

describe("a condition the picker does not offer", () => {
  const branchRule = () =>
    flow({
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "agent-flow" },
        { id: "n2", kind: "notify", x: 320, y: 0, join: "any", message: "deploy" },
      ],
      edges: [{
        id: "e1", from: "n1", to: "n2",
        cond: { kind: "branch-ci-passed", repo: "agent-flow", branch: "main" },
      }],
    });

  it("names the branch in a closed row, rather than promising a parameter it never shows", () => {
    render(<FlowList {...props({ flow: branchRule() })} />);
    expect(screen.getByTestId("flowlist-row-e1").textContent).toContain("CI passed on agent-flow#main");
  });

  it("renders it in an open row's select instead of leaving the control blank", () => {
    render(<FlowList {...props({ flow: branchRule() })} />);
    fireEvent.click(screen.getByTestId("flowlist-row-e1"));
    const select = screen.getByLabelText("Condition") as HTMLSelectElement;
    // "shows this rule's condition", not `selectedIndex !== -1`: jsdom resolves
    // an unmatched `value` to the first option rather than to -1, so a real
    // browser's blank control shows up here as the WRONG condition — the same
    // defect, and this is the assertion that catches both.
    expect(select.value).toBe("branch-ci-passed");
    expect(select.selectedOptions[0].textContent).toBe("CI passed on agent-flow#main");
  });

  it("does not offer the command condition on a row out of a place", () => {
    render(<FlowList {...props({ flow: twoPlaces() })} />);
    fireEvent.click(screen.getByTestId("flowlist-row-e1"));
    const values = Array.from(
      screen.getByLabelText("Condition").querySelectorAll("option"),
    ).map((o) => (o as HTMLOptionElement).value);
    expect(values).not.toContain("command-succeeded");
  });

  it("offers only the command condition on a row out of a command node", () => {
    const fromCommand = flow({
      nodes: [
        { id: "n1", kind: "command", x: 0, y: 0, join: "any", commandId: "deploy" },
        { id: "n2", kind: "notify", x: 320, y: 0, join: "any", message: "deployed" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "command-succeeded" } }],
    });
    render(<FlowList {...props({ flow: fromCommand })} />);
    fireEvent.click(screen.getByTestId("flowlist-row-e1"));
    const values = Array.from(
      screen.getByLabelText("Condition").querySelectorAll("option"),
    ).map((o) => (o as HTMLOptionElement).value);
    expect(values).toEqual(["command-succeeded"]);
  });
});

describe("adding a rule from the keyboard", () => {
  it("renders nothing when there is no node that could ever be a rule's source", () => {
    render(<FlowList {...props({ flow: flow() })} />);
    expect(screen.queryByTestId("flowlist-newrule")).toBeNull();
  });

  it("offers From, Condition and To as ordinary form controls, and no action control", () => {
    render(<FlowList {...props({ flow: twoPlacesNoEdge() })} />);
    const bar = screen.getByTestId("flowlist-newrule");
    expect(within(bar).getByLabelText("From node").tagName).toBe("SELECT");
    expect(within(bar).getByLabelText("New rule condition").tagName).toBe("SELECT");
    expect(within(bar).getByLabelText("To node").tagName).toBe("SELECT");
    // Blocker 1. The verb comes from the target, so this control could only ever
    // disagree with it — and it STORED its pick, which is the disagreement
    // `latchActionMismatches` stamps an edge dead for.
    expect(within(bar).queryByLabelText("New rule action")).toBeNull();
  });

  it("states what the drafted rule will do, once a To is chosen and not before", () => {
    render(<FlowList {...props({ flow: twoPlacesNoEdge() })} />);
    const bar = screen.getByTestId("flowlist-newrule");
    fireEvent.change(within(bar).getByLabelText("From node"), { target: { value: "n1" } });
    // Nothing to derive a verb from yet — and "can't be determined" would be a
    // complaint about a rule the user has not finished describing.
    expect(within(bar).queryByTestId("flowlist-newrule-then")).toBeNull();
    fireEvent.change(within(bar).getByLabelText("To node"), { target: { value: "n2" } });
    expect(within(bar).getByTestId("flowlist-newrule-then").textContent).toBe("seed");
  });

  it("reseeds the draft's condition when the source changes to a command node", () => {
    // The offered set depends on the SOURCE (see `offeredConds`), so choosing a
    // command node while `pr-merged` is selected would leave the draft holding a
    // kind its own picker no longer offers — one click from a rule that can
    // never be met.
    const onSave = vi.fn();
    const withCommand = flow({
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "agent-flow" },
        { id: "n2", kind: "command", x: 320, y: 0, join: "any", commandId: "deploy" },
        { id: "n3", kind: "notify", x: 320, y: 88, join: "any", message: "deployed" },
      ],
    });
    render(<FlowList {...props({ flow: withCommand, onSave })} />);
    const bar = screen.getByTestId("flowlist-newrule");
    const cond = within(bar).getByLabelText("New rule condition") as HTMLSelectElement;
    expect(cond.value).toBe("pr-merged");
    fireEvent.change(within(bar).getByLabelText("From node"), { target: { value: "n2" } });
    expect(Array.from(cond.querySelectorAll("option")).map((o) => (o as HTMLOptionElement).value))
      .toEqual(["command-succeeded"]);
    // Asserted on the rule the bar actually BUILDS, not on the select's rendered
    // value: jsdom resolves a value matching no option to the FIRST option, so a
    // draft still holding `pr-merged` would read as "command-succeeded" here
    // while writing the stale kind to disk.
    fireEvent.change(within(bar).getByLabelText("To node"), { target: { value: "n3" } });
    fireEvent.click(within(bar).getByRole("button", { name: "+ Add rule" }));
    expect((onSave.mock.calls.at(-1)![0] as Flow).edges[0].cond).toEqual({ kind: "command-succeeded" });
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

  it("builds a rule with the chosen from, to and condition, and stores no action at all", () => {
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
    expect(saved.edges[0]).toMatchObject({ from: "n1", to: "n2", cond: { kind: "ci-failed" } });
    // An edge with no stored action is the one shape `latchActionMismatches` can
    // never latch (it skips `action === undefined`), and `writeFlow` still puts
    // the derived value on disk for an older build's `validEdge`. This bar used
    // to store its own select's default — `notify` against a place target, which
    // means `seed` — so an ordinary wiring arrived latched on the next poll.
    expect(saved.edges[0].action).toBeUndefined();
  });

  it("the To list excludes the chosen From node and any node it already has a rule to", () => {
    const wired = flow({
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "r" },
        { id: "n2", kind: "place", x: 0, y: 88, join: "any", runKey: "PROJ-2", repo: "r" },
        { id: "n3", kind: "place", x: 0, y: 176, join: "any", runKey: "PROJ-3", repo: "r" },
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

  // The two "an impossible pairing, refused with a visible reason" tests are
  // gone with the control that made the pairing possible: a mismatch was a
  // CHOSEN action disagreeing with a target, and there is no chosen action any
  // more. What replaces them is the pair below — the bar builds whatever verb
  // the target implies, and cannot build any other.
  it("wiring a place to a place builds the seed its target implies, not the old default notify", () => {
    const onSave = vi.fn();
    render(<FlowList {...props({ flow: twoPlacesNoEdge(), onSave })} />);
    const bar = screen.getByTestId("flowlist-newrule");
    fireEvent.change(within(bar).getByLabelText("From node"), { target: { value: "n1" } });
    fireEvent.change(within(bar).getByLabelText("To node"), { target: { value: "n2" } });
    expect(within(bar).getByTestId("flowlist-newrule-then").textContent).toBe("seed");
    fireEvent.click(within(bar).getByRole("button", { name: "+ Add rule" }));
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    // The seed's mode lands on the EDGE, which is what `performSeed` reads — a
    // place has no mode field of its own.
    expect(saved.edges[0]).toMatchObject({ from: "n1", to: "n2", mode: "quick" });
    expect(saved.edges[0].action).toBeUndefined();
  });

  it("builds a launch rule, writing the mode and destination onto the target planned node, not the edge", () => {
    const onSave = vi.fn();
    render(<FlowList {...props({ flow: placeAndPlannedNoEdge(), onSave })} />);
    const bar = screen.getByTestId("flowlist-newrule");
    fireEvent.change(within(bar).getByLabelText("From node"), { target: { value: "n1" } });
    fireEvent.change(within(bar).getByLabelText("To node"), { target: { value: "n2" } });
    expect(within(bar).getByTestId("flowlist-newrule-then").textContent).toBe("launch");
    fireEvent.change(within(bar).getByLabelText("New rule mode"), { target: { value: "careful" } });
    fireEvent.change(within(bar).getByLabelText("New rule destination"), { target: { value: "new-window" } });
    fireEvent.click(within(bar).getByRole("button", { name: "+ Add rule" }));
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.edges[0]).toMatchObject({ from: "n1", to: "n2" });
    expect(saved.edges[0].action).toBeUndefined();
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
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "agent-flow" },
        {
          id: "n2", kind: "planned", x: 320, y: 0, join: "any",
          ticketKey: "PROJ-12", repos: ["agent-flow"], mode: "careful", dest: "new-window",
        },
      ],
    });
    render(<FlowList {...props({ flow: untouched, onSave })} />);
    const bar = screen.getByTestId("flowlist-newrule");
    fireEvent.change(within(bar).getByLabelText("From node"), { target: { value: "n1" } });
    fireEvent.change(within(bar).getByLabelText("To node"), { target: { value: "n2" } });
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
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "agent-flow" },
        {
          id: "n2", kind: "planned", x: 320, y: 0, join: "any",
          ticketKey: "PROJ-12", repos: ["agent-flow"], mode: "careful", dest: "new-window",
        },
        {
          id: "n3", kind: "planned", x: 320, y: 88, join: "any",
          ticketKey: "PROJ-13", repos: ["agent-flow"], mode: "quick", dest: "current-window",
        },
      ],
    });
    const { rerender } = render(<FlowList {...props({ flow: twoPlanned, onSave })} />);
    const bar = screen.getByTestId("flowlist-newrule");
    // First rule: n1 -> n2 (mode "careful", dest "new-window").
    fireEvent.change(within(bar).getByLabelText("From node"), { target: { value: "n1" } });
    fireEvent.change(within(bar).getByLabelText("To node"), { target: { value: "n2" } });
    fireEvent.click(within(bar).getByRole("button", { name: "+ Add rule" }));
    let saved = onSave.mock.calls.at(-1)![0] as Flow;

    // Second rule, built on the flow the first rule actually produced: n1 -> n3.
    rerender(<FlowList {...props({ flow: saved, onSave })} />);
    const bar2 = screen.getByTestId("flowlist-newrule");
    fireEvent.change(within(bar2).getByLabelText("From node"), { target: { value: "n1" } });
    fireEvent.change(within(bar2).getByLabelText("To node"), { target: { value: "n3" } });
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

  it("names a target's unconfigured mode in the new-rule bar instead of showing the first one", () => {
    // `seedModeAndDest` seeds the draft's mode from the target planned node, which
    // can carry an id `agentFlow.promptModes` no longer has. A `<select>` whose
    // value matches no option shows its FIRST option, selected — so the bar read
    // "Quick pass" while "+ Add rule" wrote `gone-mode`, and `modeFor` refuses that
    // at fire time. Asserted on the OPTIONS, deliberately: `toHaveValue` cannot
    // catch it, because jsdom resolves an unmatched value to the first option
    // exactly as a browser does, which is the trap this repo has now hit three
    // times.
    const onSave = vi.fn();
    const goneMode = flow({
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "agent-flow" },
        {
          id: "n2", kind: "planned", x: 320, y: 0, join: "any",
          ticketKey: "PROJ-12", repos: ["agent-flow"], mode: "gone-mode", dest: "worktree",
        },
      ],
    });
    render(<FlowList {...props({ flow: goneMode, onSave })} />);
    const bar = screen.getByTestId("flowlist-newrule");
    fireEvent.change(within(bar).getByLabelText("From node"), { target: { value: "n1" } });
    fireEvent.change(within(bar).getByLabelText("To node"), { target: { value: "n2" } });
    const options = Array.from(
      within(bar).getByLabelText("New rule mode").querySelectorAll("option"),
    ).map((o) => o.textContent);
    // The same words `modeDisplayLabel` gives the closed row and the inspector.
    expect(options).toContain("gone-mode (not configured)");
    // And the value written is the one named, not the first option: the display and
    // the write have to agree about one fact.
    fireEvent.click(within(bar).getByRole("button", { name: "+ Add rule" }));
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect((saved.nodes.find((n) => n.id === "n2") as { mode: string }).mode).toBe("gone-mode");
  });

  it("builds a seed rule, writing the chosen mode onto the edge", () => {
    const onSave = vi.fn();
    render(<FlowList {...props({ flow: twoPlacesNoEdge(), onSave })} />);
    const bar = screen.getByTestId("flowlist-newrule");
    fireEvent.change(within(bar).getByLabelText("From node"), { target: { value: "n1" } });
    fireEvent.change(within(bar).getByLabelText("To node"), { target: { value: "n2" } });
    fireEvent.change(within(bar).getByLabelText("New rule mode"), { target: { value: "careful" } });
    fireEvent.click(within(bar).getByRole("button", { name: "+ Add rule" }));
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.edges[0]).toMatchObject({ from: "n1", to: "n2", mode: "careful" });
    expect(saved.edges[0].action).toBeUndefined();
  });

  it("offers no mode or destination clause before a To is chosen", () => {
    render(<FlowList {...props({ flow: twoPlacesNoEdge() })} />);
    const bar = screen.getByTestId("flowlist-newrule");
    // No target, so no verb, so no clause belonging to one — even though the very
    // next pick (a place) does bring a mode with it.
    expect(within(bar).queryByLabelText("New rule mode")).toBeNull();
    fireEvent.change(within(bar).getByLabelText("From node"), { target: { value: "n1" } });
    expect(within(bar).queryByLabelText("New rule mode")).toBeNull();
    expect(within(bar).queryByLabelText("New rule destination")).toBeNull();
  });

  it("a rule wired to a notify terminal gets no mode or destination clause", () => {
    const placeAndFreeNotify = flow({
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "agent-flow" },
        { id: "n2", kind: "notify", x: 320, y: 0, join: "any", message: "landed" },
      ],
    });
    const onSave = vi.fn();
    render(<FlowList {...props({ flow: placeAndFreeNotify, onSave })} />);
    const bar = screen.getByTestId("flowlist-newrule");
    fireEvent.change(within(bar).getByLabelText("From node"), { target: { value: "n1" } });
    fireEvent.change(within(bar).getByLabelText("To node"), { target: { value: "n2" } });
    expect(within(bar).getByTestId("flowlist-newrule-then").textContent).toBe("Notify me in VS Code");
    expect(within(bar).queryByLabelText("New rule mode")).toBeNull();
    expect(within(bar).queryByLabelText("New rule destination")).toBeNull();
    fireEvent.click(within(bar).getByRole("button", { name: "+ Add rule" }));
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.edges[0].mode).toBeUndefined();
    expect(saved.edges[0].action).toBeUndefined();
  });

  // The task's own deliverable: a whole rule ending in a command node, built
  // from the keyboard. The NODE is added one bar above this one ("+ Add
  // command…", which the drawer renders in the List view too — see
  // OrchestratorDrawer.test.tsx's end-to-end); this is the WIRING half, and the
  // shape it must not produce is a stored `notify` against a command target,
  // which arrived latched and permanently dead on the next poll.
  it("builds a condition -> command rule from the new-rule bar", () => {
    const onSave = vi.fn();
    const placeAndCommandNoEdge = flow({
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "agent-flow" },
        { id: "n2", kind: "command", x: 320, y: 0, join: "any", commandId: "deploy-staging" },
      ],
    });
    render(<FlowList {...props({ flow: placeAndCommandNoEdge, onSave })} />);
    const bar = screen.getByTestId("flowlist-newrule");
    fireEvent.change(within(bar).getByLabelText("From node"), { target: { value: "n1" } });
    fireEvent.change(within(bar).getByLabelText("New rule condition"), { target: { value: "ci-passed" } });
    fireEvent.change(within(bar).getByLabelText("To node"), { target: { value: "n2" } });
    // Exact match on the verb's own handle: "run" is a substring of enough
    // strings that a `toContain` here would pass with no verb rendered at all.
    expect(within(bar).getByTestId("flowlist-newrule-then").textContent).toBe("run");
    // A command is not an agent session: no mode, no destination.
    expect(within(bar).queryByLabelText("New rule mode")).toBeNull();
    expect(within(bar).queryByLabelText("New rule destination")).toBeNull();
    fireEvent.click(within(bar).getByRole("button", { name: "+ Add rule" }));
    const saved = onSave.mock.calls.at(-1)![0] as Flow;
    expect(saved.edges).toHaveLength(1);
    expect(saved.edges[0]).toMatchObject({ from: "n1", to: "n2", cond: { kind: "ci-passed" } });
    // THE blocker: this used to save `action: "notify"` against a `run` target,
    // and the round trip stamped the edge with the migration notice — dead on
    // the next poll, and (before Task 3's Reset fix) unrepairable.
    expect(saved.edges[0].action).toBeUndefined();
    expect(saved.edges[0].mode).toBeUndefined();
    expect(saved.nodes).toEqual(placeAndCommandNoEdge.nodes); // the node is untouched
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
