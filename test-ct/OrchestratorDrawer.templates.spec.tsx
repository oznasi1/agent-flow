import { test, expect } from "@playwright/experimental-ct-react";
import type { Page } from "@playwright/test";
import * as React from "react";
import { OrchestratorDrawer } from "../src/webview/OrchestratorDrawer";
import type { Flow } from "../src/engine/orchestrator/model";
import type { FlowTemplate } from "../src/engine/orchestrator/templates";

/**
 * Two CSS-only fixes on the Templates tab (`OrchestratorDrawer.tsx`'s
 * `TemplateRow`) that no `className` assertion can see, because neither
 * changed a class name — both changed what a rule DOES:
 *
 *  - `.orch-tmpl-row .row` needed `display: flex` and `.orch-tmpl-row .sp`
 *    needed `flex: 1`. Without them the name and the rule count jam together
 *    with no gap (block-level `span`s simply stack), and in the
 *    confirm-delete state Cancel/Confirm drop onto their own line below the
 *    sentence instead of sitting at its end.
 *  - `.orch-kw` is a 40px column sized for "WHEN"/"THEN" (four letters), but
 *    the Save dialog hands it an arbitrary run key (`endLabel` — a place
 *    node's own `runKey`, verbatim). A long one needs to ellipsize rather
 *    than overflow its box or collide with the select beside it.
 *
 * jsdom has no layout engine: every `span` it renders sits at (0,0) with a
 * 0×0 box regardless of `display`, so "on one line" and "stacked on two
 * lines" produce identical jsdom output. Only real Chromium computes a real
 * line box.
 *
 * A mutation-check surfaced something the design doc doesn't mention: every
 * `.orch-tmpl-row` lives INSIDE `.orch-hd` (`OrchestratorDrawer.tsx` never
 * closes that div until after the whole flow-switcher popover), and
 * `.orch-hd .row`/`.orch-hd .sp` — an older, more general pair of rules —
 * already supply `display: flex`/`flex: 1` to any `.row`/`.sp` nested
 * anywhere under it, template rows included. So deleting JUST
 * `.orch-tmpl-row .row`'s own `display: flex` (or `.orch-tmpl-row .sp`'s own
 * `flex: 1`) does NOT reproduce the bug the code comment describes — the
 * ancestor rule quietly covers for it, and the first two tests below still
 * pass. What they DO still catch is the more direct regression: if flex
 * layout is missing from BOTH the specific rule and the general one (e.g. a
 * refactor that also touches `.orch-hd .row`, or moves the Templates tab out
 * from under `.orch-hd` without carrying its own flex rule along), the name
 * and count really do stack and these tests fail. See this file's own git
 * history / the accompanying report for the mutation actually run.
 */

const noop = () => {};

function templateFrom(flow: Flow, name: string): FlowTemplate {
  return { schema: 1, id: `${flow.id}-tmpl`, name, params: {}, savedAt: 1_000, flow };
}

/** A place node feeding a notify terminal — `canBindTicket` needs at least
 *  one place or planned node before `Save as template…` is even enabled
 *  (`OrchestratorDrawer.tsx`'s own guard), and `endLabel` reads a place
 *  node's `runKey` verbatim, which is the field the Save dialog's `.orch-kw`
 *  renders. A long, hyphenated key is the realistic shape this is guarding —
 *  Jira project keys are not bounded to four characters. */
const LONG_KEY = "PROJ-142-super-long-run-key";
const flow: Flow = {
  id: "f1", name: "Ship it", armed: false, createdAt: 1_000,
  nodes: [
    { id: "n1", x: 0, y: 0, join: "any", kind: "place", runKey: LONG_KEY, repo: "webapp" },
    { id: "n2", x: 0, y: 0, join: "any", kind: "notify", message: "" },
  ],
  edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" } }],
};

const props = {
  flows: [flow], openId: "f1", runs: [], pendingResume: [], promptModes: [], commands: [], branchCi: {}, templates: [],
  onClose: noop, onCreate: noop, onOpen: noop, onRename: noop, onSave: noop, onDelete: noop,
  onArm: noop, onResumeApprove: noop, onResumeDisarm: noop, onResetEdge: noop,
};

/** The drawer slides in the same way the card drawer does (`ORCH_ANIM_MS` —
 *  see `OrchestratorDrawer.canvas.spec.tsx`'s own header comment) — settle on
 *  the header row before clicking anything positioned by it. */
async function settled(page: Page, selector: string) {
  const el = page.locator(selector);
  let last = await el.boundingBox();
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(25);
    const now = await el.boundingBox();
    if (last && now && now.x === last.x && now.y === last.y) return now;
    last = now;
  }
  throw new Error(`${selector} never stopped moving`);
}

async function openTemplatesTab(page: Page) {
  await settled(page, ".orch-hd");
  await page.getByRole("button", { name: /^Flows/ }).click();
  await page.getByRole("tab", { name: "Templates" }).click();
}

test("a template row keeps its name and rule count on one line, with a real gap between them", async ({ mount, page }) => {
  await mount(<OrchestratorDrawer {...props} templates={[templateFrom(flow, "Ship it")]} />);
  await openTemplatesTab(page);

  const name = page.locator(".orch-tmpl-row .t", { hasText: "Ship it" });
  const count = page.locator(".orch-tmpl-row .meta", { hasText: "rule" });
  await expect(name).toBeVisible();
  await expect(count).toBeVisible();

  const nameBox = (await name.boundingBox())!;
  const countBox = (await count.boundingBox())!;
  // Same line: within half a line-height of each other vertically.
  expect(Math.abs(nameBox.y - countBox.y)).toBeLessThan(4);
  // A real gap, not merely non-overlapping: `.row`'s own `gap: 6px` plus
  // `.sp`'s `flex: 1` is what pushes the count to the row's far end rather
  // than letting it sit flush against the name.
  expect(countBox.x).toBeGreaterThan(nameBox.x + nameBox.width + 4);
});

test("the delete confirmation keeps Cancel and Confirm on the same line as the sentence", async ({ mount, page }) => {
  await mount(<OrchestratorDrawer {...props} templates={[templateFrom(flow, "Ship it")]} />);
  await openTemplatesTab(page);

  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const sentence = page.getByText(/Delete .Ship it.\?/);
  const cancel = page.getByRole("button", { name: "Cancel" });
  const confirm = page.getByRole("button", { name: "Confirm delete" });
  await expect(sentence).toBeVisible();

  const sentenceBox = (await sentence.boundingBox())!;
  const cancelBox = (await cancel.boundingBox())!;
  const confirmBox = (await confirm.boundingBox())!;
  expect(Math.abs(sentenceBox.y - cancelBox.y)).toBeLessThan(4);
  expect(Math.abs(cancelBox.y - confirmBox.y)).toBeLessThan(4);
  // Reading order left to right, each with daylight between it and the next —
  // the failure mode this guards is EVERYTHING landing at x=0 on its own row.
  expect(cancelBox.x).toBeGreaterThan(sentenceBox.x + sentenceBox.width - 4);
  expect(confirmBox.x).toBeGreaterThan(cancelBox.x + cancelBox.width - 4);
});

test("a long run key in the Save-as-template dialog ellipsizes instead of overflowing or colliding with the select", async ({ mount, page }) => {
  await mount(<OrchestratorDrawer {...props} />);
  await settled(page, ".orch-hd");
  await page.getByRole("button", { name: /Save as template/ }).click();

  const dialog = page.getByTestId("orch-save-template");
  await expect(dialog).toBeVisible();
  const kw = dialog.locator(".orch-kw", { hasText: LONG_KEY });
  await expect(kw).toBeVisible();
  const select = dialog.locator(".orch-sel").first();

  const kwBox = (await kw.boundingBox())!;
  const selectBox = (await select.boundingBox())!;
  const metrics = await kw.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, height: el.getBoundingClientRect().height }));

  // Single line, not wrapped: without `white-space: nowrap` the browser's
  // first instinct for text that doesn't fit a fixed-width box is to WRAP it
  // (Chromium treats a hyphen as a line-break opportunity, so this exact key
  // wraps into ~6 short lines) rather than overflow horizontally — which
  // very nearly defeats the whole point of this test, because a wrapped
  // box's `scrollWidth` comes out only a couple of CSS pixels wider than its
  // `clientWidth` (font-metric rounding), not zero. An assertion that only
  // checked `scrollWidth > clientWidth` passed against BOTH the fixed CSS
  // and a mutant with `white-space: nowrap` deleted — this height check is
  // what tells them apart.
  expect(metrics.height).toBeLessThan(20);
  // Ellipsized, not merely clipped-and-invisible: `scrollWidth` (the text's
  // real, unwrapped width) must exceed `clientWidth` (the box it was
  // actually given) by more than rounding noise — the real fix measures at
  // 87px of overflow here (187 vs 100); the wrapped mutant above measured 2.
  expect(metrics.scrollWidth - metrics.clientWidth).toBeGreaterThan(20);

  // And it never grew past the room the Save dialog's own dialog gives the
  // select beside it — `max-width: 100px` (`.orch-tmpl-dialog .orch-kw`) is
  // exactly the number that keeps this true; the base `.orch-kw`'s 40px
  // would instead collide with (or sit visibly cramped against) the select.
  expect(kwBox.width).toBeLessThanOrEqual(100.5);
  expect(kwBox.x + kwBox.width).toBeLessThanOrEqual(selectBox.x + 0.5);
});
