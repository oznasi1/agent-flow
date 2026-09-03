import { test, expect } from "@playwright/experimental-ct-react";
import type { Page } from "@playwright/test";
import * as React from "react";
import { DeckApp } from "../src/webview/DeckApp";
import { host } from "./_helpers/host";
import { mkStatus, runsMsg, flowsMsg, shipItOn } from "./_helpers/deckFixtures";

/**
 * `deckStyles.ts`'s own comment on `.hd` ("without this it clips its right
 * end off-screen instead of folding") is the property this file exists to
 * check for real: `.hd` is `flex-wrap: wrap` with the two Workflows/Templates
 * buttons (Task 15's own two-button header, replacing the single Orchestrator
 * chip) placed AFTER `.stats` and the `flex:1` spacer in source order. jsdom
 * gives every one of these a 0x0 box regardless of `display`, so "buttons
 * intact on their own line" and "buttons squeezed half off the viewport"
 * produce identical jsdom output -- only a real Chromium layout engine can
 * tell them apart. `OrchestratorDrawer.templates.spec.tsx` established the
 * same "jsdom is blind here" case for a narrower layout bug; this is the
 * header's own version of it.
 *
 * A width of 320px (the narrowest common device viewport) is deliberately
 * chosen to force wrapping -- at the CT harness's default width nothing here
 * would wrap at all, and the test would pass without exercising the fold.
 */

type Box = { x: number; y: number; width: number; height: number };

/** Two boxes are on the same visual line iff their vertical ranges overlap.
 *  Restated from `OrchestratorDrawer.templates.spec.tsx`'s own helper (not
 *  imported -- that file's copy is scoped to its own fixtures): top-edge
 *  proximity is a font-metric-sensitive proxy that measured differently on
 *  Linux CI than locally for that file, while overlap has no such tolerance
 *  to tune. */
function sameLine(a: Box, b: Box): boolean {
  return a.y < b.y + b.height && b.y < a.y + a.height;
}

// `shipItOn` (an advancing, un-badged workflow) rather than `gateOn`: a
// "1 needs you" badge widens the Workflows button enough that it, not
// `.stats`, is the thing that ends up folding onto its own line at 320px --
// a real and harmless flex-wrap outcome, but a different one than what this
// file is pinning. The plain badge-free case is the one the header's own
// `.hd`/`.stats` comments describe.
async function mountNarrow(page: Page, mount: (el: React.ReactElement) => Promise<unknown>) {
  await page.setViewportSize({ width: 320, height: 800 });
  await mount(<DeckApp />);
  await host(page, flowsMsg([shipItOn("PROJ-142")]));
  await host(page, runsMsg([mkStatus({ run: { ...mkStatus().run, key: "PROJ-142" } })]));
}

test("at a narrow width the two header buttons stay intact and the stats wrap first", async ({ mount, page }) => {
  await mountNarrow(page, mount);

  const stats = page.locator(".stats");
  const workflows = page.getByRole("button", { name: /Workflows/ });
  const templates = page.getByRole("button", { name: /Templates/ });
  await expect(stats).toBeVisible();
  await expect(workflows).toBeVisible();
  await expect(templates).toBeVisible();

  const [statsBox, wfBox, tmplBox] = await Promise.all([
    stats.boundingBox(), workflows.boundingBox(), templates.boundingBox(),
  ]) as [Box, Box, Box];

  // Not clipped: both buttons' right edges land inside the 320px viewport --
  // the failure mode the removed `.hd` wrap would produce is a button whose
  // box extends past the visible width, cut off rather than folded.
  expect(wfBox.x + wfBox.width).toBeLessThanOrEqual(320);
  expect(tmplBox.x + tmplBox.width).toBeLessThanOrEqual(320);
  // ...and the document itself never grows a horizontal scrollbar, which is
  // what "clips its right end off-screen" would look like at the page level.
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth,
  }));
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);

  // The two buttons remain a single, unbroken control pair on one line...
  expect(sameLine(wfBox, tmplBox)).toBe(true);
  // ...and `.stats` is the thing that gave way to make room: it sits on a
  // line strictly above the buttons, not sharing their line or pushing them
  // further down still. If the stats tiles instead held their ground and the
  // buttons wrapped below the FOLD of the stats own overflow, or shared a
  // cramped line with them, this would fail.
  expect(statsBox.y + statsBox.height).toBeLessThanOrEqual(wfBox.y);
  expect(sameLine(statsBox, wfBox)).toBe(false);
});
