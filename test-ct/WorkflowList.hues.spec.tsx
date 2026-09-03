import { test, expect } from "@playwright/experimental-ct-react";
import * as React from "react";
import { DeckApp } from "../src/webview/DeckApp";
import { host } from "./_helpers/host";
import { tokenColor, elementColor } from "./_helpers/colors";
import { mkStatus, runsMsg, flowsMsg, shipItOn, gateOn, failedOn, doneOn } from "./_helpers/deckFixtures";

/**
 * The Active list (`WorkflowList.tsx`, mounted by `DeckApp` behind the new
 * "Workflows" header button — Task 15's own navigation) reuses `.wf-chip
 * wf-<status>` verbatim on each row, the exact selector `Workflow.hues.spec.tsx`
 * already pins for `WorkflowBlock`'s header chip. `test/webview/workflowList.test.tsx`
 * ("marks a status on each row for the stylesheet to hue") says outright why
 * that file can't finish the job itself: jsdom can assert `data-status` reached
 * the DOM, never what colour the stylesheet actually painted it. A token rule
 * quietly repointed at the wrong `--c-*` variable — `.wf-chip.wf-stopped`
 * spending `--c-attn` instead of `--c-danger`, say — leaves every class-name
 * and `data-status` assertion in the existing suite green while the Active
 * list tells a reader a real failure is merely waiting on them, or the other
 * way around. Reusing the SAME class as the board chip does not make this
 * redundant with `Workflow.hues.spec.tsx`: that file never opens the Active
 * list, so a future refactor that gives `WorkflowList` its own (wrong) rule,
 * or nests it somewhere `.wf-chip`'s selector no longer reaches, would only
 * be caught here.
 *
 * Each case reuses `Workflow.hues.spec.tsx`'s own board fixtures
 * (`shipItOn`/`gateOn`/`failedOn`/`doneOn`) so the Active row is asserted
 * against the exact same flow shapes, and therefore the exact same resolved
 * `WorkflowStatus`, that file already pins on the board chip -- not a second,
 * possibly-drifted idea of what "waiting on you" looks like.
 */

async function openActive(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: /Workflows/ }).click();
  await expect(page.locator(".wfl-row")).toBeVisible();
}

test("an advancing card's Active row is the quiet blue, not amber or red", async ({ mount, page }) => {
  await mount(<DeckApp />);
  await host(page, flowsMsg([shipItOn("PROJ-142")]));
  await host(page, runsMsg([mkStatus({ run: { ...mkStatus().run, key: "PROJ-142" } })]));
  await openActive(page);

  const chip = page.locator(".wfl-row .wf-chip");
  const [got, progress, attn, danger] = await Promise.all([
    elementColor(chip), tokenColor(page, "--c-progress"), tokenColor(page, "--c-attn"), tokenColor(page, "--c-danger"),
  ]);
  expect(got).toBe(progress);
  expect(got).not.toBe(attn);
  expect(got).not.toBe(danger);
});

test("a waiting-on-you card's Active row is amber", async ({ mount, page }) => {
  await mount(<DeckApp />);
  await host(page, flowsMsg([gateOn("PROJ-142")]));
  await host(page, runsMsg([mkStatus({ run: { ...mkStatus().run, key: "PROJ-142" } })]));
  await openActive(page);

  const chip = page.locator(".wfl-row .wf-chip");
  expect(await elementColor(chip)).toBe(await tokenColor(page, "--c-attn"));
});

test("a stopped card's Active row is red", async ({ mount, page }) => {
  await mount(<DeckApp />);
  await host(page, flowsMsg([failedOn("PROJ-142")]));
  await host(page, runsMsg([mkStatus({ run: { ...mkStatus().run, key: "PROJ-142" } })]));
  await openActive(page);

  const chip = page.locator(".wfl-row .wf-chip");
  expect(await elementColor(chip)).toBe(await tokenColor(page, "--c-danger"));
});

test("a done card's Active row is green", async ({ mount, page }) => {
  await mount(<DeckApp />);
  await host(page, flowsMsg([doneOn("PROJ-142")]));
  await host(page, runsMsg([mkStatus({ run: { ...mkStatus().run, key: "PROJ-142" } })]));
  await openActive(page);

  const chip = page.locator(".wfl-row .wf-chip");
  expect(await elementColor(chip)).toBe(await tokenColor(page, "--c-done"));
});
