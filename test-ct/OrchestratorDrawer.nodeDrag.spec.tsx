import { test, expect } from "@playwright/experimental-ct-react";
import type { Page } from "@playwright/test";
import * as React from "react";
import { OrchestratorDrawer } from "../src/webview/OrchestratorDrawer";
import { GRID } from "../src/engine/orchestrator/layout";
import type { Flow } from "../src/engine/orchestrator/model";

/**
 * Node dragging corrects BOTH ends by the canvas origin: `startDrag` folds
 * `box.left/top` into the grab offset, and the pointermove handler subtracts it
 * again when computing the new position. The two only cancel while both sites
 * exist and the box holds still — yet under jsdom the origin is (0,0), so
 * deleting either subtraction alone changes nothing any existing test can see.
 * Real Chromium gives the canvas a real origin, making each site individually
 * falsifiable.
 */

const NODE = { id: "n1", kind: "place" as const, x: 24, y: 24, join: "any" as const, runKey: "PROJ-1", repo: "agent-flow" };

const flow: Flow = { id: "f1", name: "Ship the migration", armed: false, createdAt: 1_000, nodes: [NODE], edges: [] };

const noop = () => {};
const props = {
  flows: [flow], openId: { kind: "flow" as const, id: "f1" }, runs: [], pendingResume: [], promptModes: [], commands: [], branchCi: {}, templates: [], draftTemplate: null,
  view: "canvas" as const, onView: noop, rows: [], onOpenCard: noop,
  onClose: noop, onCreate: noop, onOpen: noop, onRename: noop, onDelete: noop,
  onArm: noop, onResumeApprove: noop, onResumeDisarm: noop, onResetEdge: noop,
  onNewTemplate: noop, onCancelTemplate: noop, onEditTemplate: noop,
};

/** The node's box once the drawer's slide-in has finished moving it. */
async function settledBox(page: Page) {
  const node = page.getByTestId("orch-node-n1");
  let last = await node.boundingBox();
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(25);
    const now = await node.boundingBox();
    if (last && now && now.x === last.x && now.y === last.y) return now;
    last = now;
  }
  throw new Error("the node never stopped moving");
}

test("dragging a node lands it at the pointer delta, not at a coordinate skewed by the canvas origin", async ({ mount, page }) => {
  const saves: Flow[] = [];
  await mount(<OrchestratorDrawer {...props} onSave={(f: Flow) => { saves.push(f); }} />);

  const box = await settledBox(page);
  // Guard the premise: at canvas origin (0,0) both subtractions are no-ops and
  // this test degenerates into what jsdom already cannot distinguish.
  expect(box.x + box.y).toBeGreaterThan(0);

  // Grab the node's middle and pull it by exact grid multiples, so the snapped
  // expectation has no rounding ambiguity.
  const dx = GRID * 12; // +96
  const dy = GRID * 8;  // +64
  const grabX = box.x + box.width / 2;
  const grabY = box.y + box.height / 2;
  await page.mouse.move(grabX, grabY);
  await page.mouse.down();
  await page.mouse.move(grabX + dx, grabY + dy, { steps: 8 });
  await page.mouse.up();

  await expect.poll(() => saves.length).toBe(1);
  const moved = saves[0].nodes.find((n) => n.id === "n1")!;
  expect({ x: moved.x, y: moved.y }).toEqual({ x: NODE.x + dx, y: NODE.y + dy });
});
