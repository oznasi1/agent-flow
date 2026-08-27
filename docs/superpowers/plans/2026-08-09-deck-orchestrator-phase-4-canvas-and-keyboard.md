# Deck Orchestrator — Phase 4: canvas polish and the keyboard path — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the drawer usable — a label that never covers a node, a drawer you can widen or expand so a graph stops hiding nodes silently, and a list view that lets you build and arm a flow **without a mouse**. This is the last phase before the feature can merge.

**Architecture:** The geometry stays pure in `engine/orchestrator/layout.ts` so label avoidance is testable without a DOM. Width is one CSS custom property declared in the sheet and overridden inline, persisted through the webview's own `setState` — no new host protocol. The list view renders the **same** `Flow` from the same store as the canvas: one model, two presentations, and every mutation goes through the existing `flow:*` messages.

**Tech Stack:** TypeScript, React (webview), VS Code extension API, Vitest + Testing Library.

## Global Constraints

- Work in the existing worktree `/Users/oznasi/dev/agent-flow/.claude/worktrees/orchestrator-core` on branch `worktree-orchestrator-core`. Never the main checkout, and do not switch branches.
- `npx tsc --noEmit` clean.
- `rm -rf dist && npm run build` must exit **0** — check the **exit code**, not whether files appeared; esbuild does not clear `dist/`.
- `npx vitest run` green. Baseline is **2818 tests across 96 files** and it must only grow.
- **≥95% line coverage** on every file this plan creates or modifies.
- **Nothing reachable from `src/webview/` may import `fs`/`os`/`path`/`child_process`**, even transitively, even on a path that never runs. `test/webview/webviewGraph.test.ts` guards it but follows relative imports only, and `npm run build` is the only gate that catches a violation.
- `lib` is capped at **ES2022** — `Array.prototype.findLast` and other ES2023 methods fail `tsc`.
- Do NOT touch the `version` field in `package.json`, `package-lock.json`, or `CHANGELOG.md`.
- **Do not change the meaning of any persisted field.** Flow files live in users' home directories: node kinds, action strings, condition kinds and edge fields keep their meanings. Adding an optional field is fine.
- House rules, from the design doc and non-negotiable: monospace for **identifiers and counts only**, never prose; **red only for a real failure**, never a hint, empty state or disabled control; **one primary (filled) control per surface** — in this drawer that is **Arm**; no persistent hint lines on cards.
- Conventional commits, scoped `orchestrator`.

## Decisions already taken (do not re-open)

- **Label placement:** offset along the curve's own normal by the **minimum** needed to clear, so the label stays visually attached to its line. Rejected: hover-only (it merely defers the collision — selecting the offending edge reproduces it) and orthogonal lane routing (needs a real router; the widened drawer makes the collision rare).
- **Width:** **resize is the everyday answer and the fix for the clipping**; **expand** ships alongside as the escape hatch for a large graph. Rejected as the primary fix: horizontal scroll, because dragging port-to-port across a scroll boundary fights the main thing you do here.
- **Canvas stays the default view**; the list view is a toggle.

## File Structure

| File | Responsibility |
|---|---|
| `src/engine/orchestrator/layout.ts` | *(modify)* `labelPoint` gains obstacle avoidance. Stays pure. |
| `src/webview/orchestratorStyles.ts` | *(modify)* `--orch-w`, the resizer, expanded state, list-view styles. Replace the stale "cut from Phase 2a" comment. |
| `src/webview/OrchestratorDrawer.tsx` | *(modify)* resizer, expand toggle, view toggle, and the list view itself. |
| `src/webview/flowList.tsx` | *(new)* the list view — rules as WHEN/THEN/USING rows, keyboard-operable. Split out because the drawer is already ~40KB. |
| `src/types.ts` | *(modify)* one new inbound message, `flow:addPlanned`. |
| `src/deckView.ts` | *(modify)* the `flow:addPlanned` handler and its QuickPicks. |
| `README.md` | *(modify)* one line: the list view is the keyboard path. |
| `docs/superpowers/specs/2026-08-05-deck-orchestrator-flows-design.md` | *(modify)* mark Phase 4 done; record what shipped. |

Tests mirror each file; `test/webview/OrchestratorDrawer.test.tsx` and a new `test/webview/flowList.test.tsx` carry the UI cases.

---

## Task 1: A label never covers a node

**Files:**
- Modify: `src/engine/orchestrator/layout.ts`
- Test: `test/unit/engine/orchestrator/layout.test.ts`

**Interfaces:**
- Produces: `labelPoint(a: Point, b: Point, obstacles?: Box[]): Point`. The third argument is optional so every existing call site keeps compiling; Task 2 passes the node boxes.

**Why.** `labelPoint` currently returns the chord midpoint (`layout.ts:32-34`) and knows nothing about nodes. When an edge reaches a farther column its midpoint lands on an intermediate node in the same row and the pill covers that node's title — observed in the real UI as `PROJ-12` rendering as `A_M-12`.

Geometry already in the file: `NODE_W = 168`, `NODE_H = 44`, `COL_GAP = 296`, `ROW_GAP = 88`, `GRID = 8`.

The rule: start at the chord midpoint; while that point lies inside any obstacle box (inflated by a small margin), step along the chord's **normal** by a fixed increment, alternating sign so the label stays as close to its line as possible, and stop at a bounded number of steps. Bounded, not "until clear" — an unbounded loop in a render path is how you hang a webview, and `tidy` in this same file is already bounded for that reason.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/engine/orchestrator/layout.test.ts`:

```ts
import { labelPoint, NODE_W, NODE_H, Box } from "../../../../src/engine/orchestrator/layout";

const boxAt = (x: number, y: number): Box => ({ x, y, w: NODE_W, h: NODE_H });
const inside = (p: { x: number; y: number }, b: Box) =>
  p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;

describe("labelPoint", () => {
  it("is the chord midpoint when nothing is in the way", () => {
    expect(labelPoint({ x: 0, y: 0 }, { x: 100, y: 40 })).toEqual({ x: 50, y: 20 });
  });

  it("is the chord midpoint when no obstacles are given at all", () => {
    // The argument is optional so existing callers keep working unchanged.
    expect(labelPoint({ x: 0, y: 0 }, { x: 200, y: 0 }, [])).toEqual({ x: 100, y: 0 });
  });

  it("steps off a node that sits on the midpoint", () => {
    // A long edge passing a same-row node: the midpoint lands inside it.
    const blocker = boxAt(60, -22); // straddles y=0, centred near x=144
    const p = labelPoint({ x: 0, y: 0 }, { x: 288, y: 0 }, [blocker]);
    expect(inside(p, blocker)).toBe(false);
  });

  it("stays as close to its own line as clearing allows", () => {
    // Nudged, not relocated: the whole point is the label still reads as
    // belonging to this edge. One node's height is the ceiling on the detour.
    const blocker = boxAt(60, -22);
    const p = labelPoint({ x: 0, y: 0 }, { x: 288, y: 0 }, [blocker]);
    expect(Math.abs(p.y)).toBeLessThanOrEqual(NODE_H + 16);
    expect(p.x).toBe(144); // unchanged along the chord
  });

  it("clears every obstacle, not just the first", () => {
    // Stepping off one node must not land on its neighbour.
    const a = boxAt(60, -22);
    const b = boxAt(60, -22 - NODE_H - 8);
    const p = labelPoint({ x: 0, y: 0 }, { x: 288, y: 0 }, [a, b]);
    expect(inside(p, a)).toBe(false);
    expect(inside(p, b)).toBe(false);
  });

  it("ignores obstacles the midpoint was never on", () => {
    const far = boxAt(1000, 1000);
    expect(labelPoint({ x: 0, y: 0 }, { x: 100, y: 0 }, [far])).toEqual({ x: 50, y: 0 });
  });

  it("terminates on a pathological pile of obstacles rather than looping", () => {
    // A render path must not hang. Boxed in on purpose: it returns SOMETHING,
    // promptly. `tidy` in this file is bounded for the same reason.
    const wall = Array.from({ length: 40 }, (_, i) => boxAt(60, -22 - i * 8));
    const p = labelPoint({ x: 0, y: 0 }, { x: 288, y: 0 }, wall);
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
  });

  it("offsets perpendicular to a diagonal chord, not merely vertically", () => {
    // The normal of a sloped edge is sloped: a vertical-only nudge would drift
    // off the line and orphan the label, which is the defect being fixed.
    const p = labelPoint({ x: 0, y: 0 }, { x: 200, y: 200 }, [boxAt(16, 78)]);
    expect(p.x).not.toBe(100);
  });
});
```

`test/unit/engine/orchestrator/layout.test.ts` already exists — add to it. Do not move existing cases between files in this task.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/unit/engine/orchestrator/layout.test.ts`
Expected: FAIL — `labelPoint` takes two arguments and ignores obstacles.

- [ ] **Step 3: Implement**

Rewrite `labelPoint` in `src/engine/orchestrator/layout.ts`. Keep it pure and keep the two-argument call shape working. Document *why* it is bounded and why the offset follows the normal.

- [ ] **Step 4: Confirm green, then all four gates**

`npx tsc --noEmit`; `rm -rf dist && npm run build` (exit 0); `npx vitest run`; `npx vitest run --coverage` — `layout.ts` ≥95% lines.

- [ ] **Step 5: Commit**

```bash
git commit -m "fix(orchestrator): keep an edge label off the nodes it passes"
```

---

## Task 2: Feed the nodes to the label, and see it in the canvas

**Files:**
- Modify: `src/webview/OrchestratorDrawer.tsx`
- Test: `test/webview/OrchestratorDrawer.test.tsx`

**Interfaces:**
- Consumes: `labelPoint(a, b, obstacles)` from Task 1.

Task 1 is inert until the drawer passes the node boxes. Find where the drawer calls `labelPoint` and pass every node's box **except the edge's own two endpoints** — an edge's label is allowed to sit near the nodes it connects, and excluding them keeps a short edge's label where it belongs.

Build the boxes from the same `NODE_W`/`NODE_H` the canvas already uses; do not hardcode 168/44 here.

Tests: with a node positioned on an edge's midpoint, the rendered label's coordinates are not inside that node's box; with nothing in the way the label is unmoved; and the endpoint-exclusion holds (a label between two adjacent nodes does not get pushed away from them). jsdom gives a zero-origin rect so exact coordinates are deterministic — assert on them rather than on a rendered class.

- [ ] **Steps:** failing tests → confirm red → implement → green → all four gates → commit, scoped `orchestrator`.

---

## Task 3: Resize the drawer

**Files:**
- Modify: `src/webview/orchestratorStyles.ts`
- Modify: `src/webview/OrchestratorDrawer.tsx`
- Test: `test/webview/OrchestratorDrawer.test.tsx`

**The constraint that governs this task.** `orchestratorStyles.ts:11-15` currently says:

> Width is a fixed 560px in this phase: resize and expand were cut from Phase 2a and tracked as a known gap, not built here. Do not reintroduce a `var(--orch-w, 560px)` indirection speculatively — nothing sets that variable yet, and `tokens.test.ts`'s orphan-usage check is what caught it last time. A real resize task can add the variable back once something actually sets it inline.

**This is that task.** Replace that comment with what now exists — do not leave a comment saying the feature was cut.

`test/webview/tokens.test.ts` fails on a custom property that is *used* in a sheet but declared nowhere (`only uses custom properties that are declared somewhere`, around line 74). A property set only inline is invisible to it — that is why `--accent` sits in a `RUNTIME_ONLY` allowlist. **Prefer not to touch that allowlist:** declare the default in the sheet itself, so it is locally declared and the check passes on its own terms:

```css
.orch { --orch-w: 560px; width: var(--orch-w); … }
```

An inline `style={{ "--orch-w": `${w}px` }}` on the drawer element then overrides it.

Behaviour:
- A grip on the drawer's **left** border, dragged with pointer events. Follow the existing pointer-drag idiom in this file (the canvas already drags nodes and wires); do not add a new gesture library.
- Clamp to a sensible range — a floor that keeps the header controls usable and a ceiling that keeps some board visible. Derive the ceiling from the viewport rather than hardcoding a pixel, and state the reasoning in a comment.
- **Persist the width** with `vscodeApi.setState` / `getState` (both are already typed in `src/webview/vscodeApi.ts` and nothing uses them yet, so you are establishing the pattern — keep it to a single small object and read it defensively, since a stored value from a future version must not break the drawer).
- Keyboard: the grip must be focusable and resizable with arrow keys. This drawer's whole point in Phase 4 is that it works without a mouse, so a mouse-only resizer would be a contradiction. `role="separator"` with `aria-orientation="vertical"` and an `aria-label` is the right shape; follow the ARIA idiom already used in `src/webview/App.tsx` (`role="tablist"`, `aria-selected`, `role="group"`, `aria-pressed`).

Tests: dragging the grip changes the width; the width is clamped at both ends; arrow keys resize; the width survives a remount (a `getState` returning a stored width is honoured); a corrupt or absent stored value falls back to the default rather than throwing. Mutation-check the clamp and the persistence.

- [ ] **Steps:** failing tests → confirm red → implement → green → all four gates → commit, scoped `orchestrator`.

---

## Task 4: Expand to full width

**Files:**
- Modify: `src/webview/orchestratorStyles.ts`, `src/webview/OrchestratorDrawer.tsx`
- Test: `test/webview/OrchestratorDrawer.test.tsx`

**Interfaces:**
- Consumes: Task 3's width plumbing. Expand is a state on top of it, not a second mechanism.

A toggle in the drawer header takes the drawer to the full panel width; toggling back restores the **previous resized width**, not the default — a user who widened to 700px and expanded should not lose that on collapse.

It must not become a second primary control: **Arm is the only filled control on this surface.** Use the same quiet control language as `Tidy` and `+ Notify`, with `aria-pressed` for the toggle state.

Tests: expanding sets the full width; collapsing restores the prior custom width (not the default); the toggle reports its state with `aria-pressed`; and expanding while already expanded is idempotent. Mutation-check the restore-previous-width behaviour — the obvious wrong implementation restores the default and no naive test would notice.

- [ ] **Steps:** failing tests → confirm red → implement → green → all four gates → commit, scoped `orchestrator`.

---

## Task 4b: Make planned work creatable at all — the missing ticket picker

**Files:**
- Modify: `src/types.ts` (one new inbound message), `src/deckView.ts`, `src/webview/OrchestratorDrawer.tsx`
- Test: `test/unit/deckView.test.ts`, `test/webview/OrchestratorDrawer.test.tsx`

**Do this task before Tasks 5 and 6.** Discovered while planning this phase, and it is the most consequential item in it.

**Nothing in the UI can create a `planned` node.** The drawer builds a `place` from a dropped Deck card (`OrchestratorDrawer.tsx:278`) and a `notify` terminal from the `+ Notify` button (`:343`). Grep the webview for `kind: "planned"` and there is no third case. The design settled on "Deck cards **plus a ticket picker**" and only the cards were built.

The consequence: **Phase 3's entire `launch` capability is unreachable.** A `launch` rule must target planned work, so a user cannot build one — the engine, the spend confirmation, the worktree creation and the promote-to-place chain are all correct and all unusable. This is not polish; without it Phase 3 ships dead code.

**Build the picker host-side, not in the webview.** The webview cannot reach a connector, and a native `vscode.window.showQuickPick` is fully keyboard-operable for free — which is exactly what this phase is about. There is a precedent at `src/deckView.ts:1115`, and several in `src/tasksView.ts` (`:562`, `:639`, `:839`). `this.connector.provider().list(lens, size, max)` supplies the candidates and `detail(key)` is already used by Phase 3's launcher.

Shape:
- A new inbound message — `{ type: "flow:addPlanned"; id: string }` — sent by an **Add planned work** control in the drawer's tray, beside `+ Notify`.
- `deckView.ts` handles it by asking, in sequence: which ticket (from `provider().list`), which repos, which prompt mode (from `getConfig().promptModes`), and which destination (`worktree` / `new-window` / `current-window`). Each is a QuickPick. Cancelling any step aborts the whole thing and writes nothing.
- The host then appends the `PlannedNode` to the flow and writes it, then `postFlows()`. Do **not** round-trip a partial node through the webview — `flow:save` carries a whole flow, and a half-built node crossing the wire is a second source of truth.
- Position the new node the way the tray's drop path already does, so it does not land on top of an existing one.
- If the connector is not authenticated, or `list` returns nothing, say so with a toast and write nothing. An unauthenticated source must not produce an empty picker with no explanation.

Tests (host): the message opens the pickers and appends a node carrying the chosen `ticketKey`, `repos`, `mode` and `dest`; cancelling at **each** step writes nothing (one test per step — a single "cancel" test would pass while three of four steps leak); an unauthenticated connector toasts and writes nothing; the appended node does not overlap an existing node's position. Tests (webview): the control is present, keyboard-reachable, and sends `flow:addPlanned` with the open flow's id.

Mutation-check the cancel paths — the naive implementation writes a node with `undefined` fields when a pick is cancelled, and that is precisely what Phase 3's launcher would then refuse at spend time with a confusing message.

- [ ] **Steps:** failing tests → confirm red → implement → green → all four gates → commit, scoped `orchestrator`.

---

## Task 5: The list view — rendering and navigation

**Files:**
- Create: `src/webview/flowList.tsx`
- Modify: `src/webview/OrchestratorDrawer.tsx`, `src/webview/orchestratorStyles.ts`
- Test: `test/webview/flowList.test.tsx`

**Interfaces:**
- Produces: `FlowList(props)` rendering a `Flow`'s rules as rows. Task 6 adds creation.

**Why this exists, in the design doc's words:** *"A button that renders the same graph as the WHEN/THEN/USING list… This is the keyboard path — a canvas built from divs and pointer events has no usable keyboard story, and shipping the graph as the only way to edit a flow would make the feature unreachable without a mouse. Same store, no second model."*

So: **one model, two presentations.** `FlowList` takes the same `Flow` and the same callbacks the canvas already uses, and every mutation goes through the existing `flow:*` messages. Do not add a parallel state shape, and do not persist anything new about the list.

A canvas ⇄ list toggle in the drawer header. Canvas stays the default. Follow `App.tsx`'s `role="tablist"` / `role="tab"` / `aria-selected` idiom — that is this project's established pattern for exactly this.

Each row reads as the sentence the inspector already uses: `WHEN <condition> THEN <action> <target> USING <mode> in a <destination>`, with the same fixed-width keywords so rows scan as a column. A row for a fired rule shows its receipt and offers **Reset**, matching the inspector. A row whose action is impossible for its target's kind shows the same visible reason the inspector gives.

Keyboard, and this is the point of the task:
- the list is reachable by Tab, and rows are traversable with Up/Down
- Enter (or Space) opens a row for editing; Escape leaves it
- the controls inside a row — condition, action, mode, destination — are ordinary form controls, reachable in order
- Delete removes the focused rule, with the same confirmation the canvas uses if it has one
- focus never becomes trapped, and never lands on a hidden element

Use a **roving tabindex** for the rows rather than making every row tabbable, and say so in a comment — a 20-rule flow should not cost twenty Tab presses to get past.

Tests: rows render one per edge, in a stable order; the sentence includes the condition, action and target; Up/Down moves the focused row; Enter opens editing and Escape closes it; Delete removes the focused rule; a fired rule offers Reset; an impossible action shows its reason; the toggle switches views and reports `aria-selected`. RTL queries throw on multiple matches, so be specific. Mutation-check the roving tabindex (breaking it should fail a test, not silently degrade) and the row ordering.

- [ ] **Steps:** failing tests → confirm red → implement → green → all four gates → commit, scoped `orchestrator`.

---

## Task 6: Build a whole flow from the keyboard

**Files:**
- Modify: `src/webview/flowList.tsx`, `src/webview/OrchestratorDrawer.tsx`
- Test: `test/webview/flowList.test.tsx`

**Why this is a separate task and not polish.** Task 5 makes existing rules *editable* by keyboard. That is not yet the keyboard path: if adding a node still requires dragging a card from the tray, and adding a rule still requires dragging port to port, a keyboard user cannot create a flow at all — only edit one someone else built with a mouse. The claim the design doc makes ("the feature would be unreachable without a mouse") is only answered when a flow can be **built and armed** from the keyboard.

So the list view must offer, without any pointer gesture:
- **Add a node** — a place, planned work, or a notify terminal. Planned work reuses **Task 4b's** `flow:addPlanned` message, which opens native QuickPicks and is therefore already keyboard-operable; do not build a second picker in the webview. A notify terminal already has its button. A **place** is the one that currently requires a pointer — it can only arrive by dragging a Deck card — so it needs a keyboard equivalent here: a control that lists the Deck's current runs and adds the chosen one, using the same run keys the drag path passes through `attachAt`.
- **Add a rule** — choose the from-node, the to-node, the condition, the action, and where the action needs it the mode and destination. All ordinary controls.
- **Arm** — already a button in the header; confirm it is reachable and operable by keyboard, and that the spend confirmation modal it can trigger is too (VS Code owns that modal, so this is a check, not a change).

Tests: a complete flow can be constructed through the list — add two nodes, add a rule between them, set its condition and action — asserting on the `flow:save` payloads rather than on internal state; the node picker is keyboard-navigable; a rule cannot be created pointing an action at a target kind that cannot accept it (the same guard the inspector has); and Arm is reachable by keyboard. For the end-to-end construction test, assert the resulting `Flow` has the nodes and edge you built, since that is the claim the task makes.

- [ ] **Steps:** failing tests → confirm red → implement → green → all four gates → commit, scoped `orchestrator`.

---

## Task 7: Make the docs true, and close the phase

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-05-deck-orchestrator-flows-design.md`
- Modify: `src/webview/orchestratorStyles.ts` (if Task 3 left any stale comment)

- **README:** one line, in the existing Orchestrator paragraph's voice — the drawer can be widened or expanded, and a list view gives the same flow a keyboard path. No feature-list padding.
- **Spec:** mark Phase 4's items done and record what shipped: the minimum-normal label offset (and that hover-only and lane routing were rejected, with the reasons — a future reader will otherwise re-propose them); resize plus expand, with width persisted in webview state; the list view as the keyboard path with one model behind both presentations.
- **Spec limitations:** re-read the Known limitations section added in Phase 3 and check each entry is still true after this phase. The clipping entry in particular describes a defect this phase fixes — leaving it would be worse than never having written it.
- Grep the whole repo for comments claiming resize/expand or the list view is "cut", "deferred", or "a known gap" and correct every one. At least `orchestratorStyles.ts` had such a comment; there may be more.

- [ ] **Steps:** make the changes → `npx vitest run` (a doc change can still break a test that asserts on copy) → all four gates → commit, `docs(orchestrator)`.

---

## Done when

- No edge label overlaps a node, in the real rendered drawer — verified by a screenshot, not by a unit test alone.
- The drawer can be widened by drag **and** by arrow keys, the width survives a remount, and the whole three-column chain fits.
- Expand fills the panel; collapsing restores the width the user had chosen, not the default.
- **Planned work can be created at all** — the gap that made Phase 3's `launch` unreachable is closed, and a launch rule can be built end to end.
- A flow can be **created, wired, edited and armed** using only the keyboard, through the list view.
- Arm is still the only filled control on the surface; red still appears only for real failures; monospace still only on identifiers and counts.
- All four gates: `npm run build` exit 0, `tsc --noEmit` clean, `vitest run` green and grown from 2818, every touched file ≥95% lines.
- A visual verification pass has rendered the real bundle and someone has **looked at** the result, dark and light.

## After this phase

Phase 4 is the last planned phase. When it is green, the whole feature — engine and UI — is ready to merge to `main` as one landing, which is the standing decision for this branch.
