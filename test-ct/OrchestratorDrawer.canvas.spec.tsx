import { test, expect } from "@playwright/experimental-ct-react";
import type { Page } from "@playwright/test";
import * as React from "react";
import { OrchestratorDrawer } from "../src/webview/OrchestratorDrawer";
import { NODE_H, NODE_W, snap } from "../src/engine/orchestrator/layout";
import type { Flow } from "../src/engine/orchestrator/model";

/**
 * The drawer's three measured sites all correct a viewport coordinate by the
 * canvas's own origin — `e.clientX - box.left` — with a `?? 0` fallback for the
 * ref not being attached yet. Under jsdom that rect is deterministically 0×0 at
 * (0,0), so the correction and the fallback produce the *same number*: the
 * existing suite cannot tell a working origin correction from a deleted one.
 * Real Chromium puts the canvas at a real offset, which is what makes the
 * subtraction falsifiable.
 */

const flow = (over: Partial<Flow> = {}): Flow => ({
  id: "f1", name: "Ship the migration", armed: false, createdAt: 1_000, nodes: [], edges: [], ...over,
});

const noop = () => {};

/** `DRAG_SEP` restated rather than imported: CT proxies *component* imports in the
 *  Node-side spec, but a plain value import really loads the module — and
 *  `OrchestratorDrawer` pulls in `vscodeApi`, which calls `acquireVsCodeApi()` at
 *  module scope and throws outside a webview. A drift here fails loudly: the drop
 *  stops parsing and no node attaches. */
const DRAG_SEP = "\0";

const props = {
  flows: [flow()], openId: "f1", runs: [], pendingResume: [], promptModes: [], commands: [], branchCi: {},
  onClose: noop, onCreate: noop, onOpen: noop, onRename: noop, onDelete: noop,
  onArm: noop, onResumeApprove: noop, onResumeDisarm: noop, onResetEdge: noop,
};

/** The canvas's box once it has stopped moving. The drawer slides in
 *  (`ORCH_ANIM_MS`), so a box read on the first frame is stale by the time the
 *  drop lands — which showed up as an x that missed by the remaining slide
 *  distance while y, which never animates, was exact. */
async function settledCanvasBox(page: Page) {
  const canvas = page.getByTestId("orch-canvas");
  let last = await canvas.boundingBox();
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(25);
    const now = await canvas.boundingBox();
    if (last && now && now.x === last.x && now.y === last.y) return now;
    last = now;
  }
  throw new Error("the canvas never stopped moving");
}

/** Drop a board card onto the canvas at a viewport point, the way DeckApp's
 *  cards do: `runKey`, a NUL, then the repo. */
async function dropCardAt(page: Page, clientX: number, clientY: number) {
  const payload = `PROJ-7${DRAG_SEP}webapp`;
  const dt = await page.evaluateHandle((raw) => {
    const d = new DataTransfer();
    d.setData("text/plain", raw);
    return d;
  }, payload);
  await page.getByTestId("orch-canvas").dispatchEvent("drop", { dataTransfer: dt, clientX, clientY });
}

test("a dropped card lands at a point corrected for the canvas's own origin", async ({ mount, page }) => {
  const saves: Flow[] = [];
  await mount(<OrchestratorDrawer {...props} onSave={(f: Flow) => { saves.push(f); }} />);

  const box = await settledCanvasBox(page);
  // Guard the premise. At origin (0,0) this test degenerates into the jsdom one:
  // subtracting zero proves nothing about whether the subtraction happens.
  expect(box.x + box.y).toBeGreaterThan(0);

  const clientX = box.x + 200;
  const clientY = box.y + 150;
  await dropCardAt(page, clientX, clientY);

  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0].nodes).toHaveLength(1);
  expect(saves[0].nodes[0]).toMatchObject({
    x: snap(clientX - box.x - NODE_W / 2),
    y: snap(clientY - box.y - NODE_H / 2),
  });
});

test("the landing point is the canvas-relative one, not the raw viewport point", async ({ mount, page }) => {
  const saves: Flow[] = [];
  await mount(<OrchestratorDrawer {...props} onSave={(f: Flow) => { saves.push(f); }} />);

  const box = await settledCanvasBox(page);
  expect(box.x + box.y).toBeGreaterThan(0);

  // Drop on the canvas's own top-left corner: canvas-relative (0,0), which the
  // node's half-box then clamps back to 0. Read as raw viewport coordinates it
  // would instead land at the drawer's offset — a visibly different node.
  await dropCardAt(page, box.x, box.y);

  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0].nodes[0]).toMatchObject({ x: 0, y: 0 });
  expect(saves[0].nodes[0]).not.toMatchObject({ x: snap(box.x - NODE_W / 2), y: snap(box.y - NODE_H / 2) });
});
