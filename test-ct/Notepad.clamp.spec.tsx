import { test, expect } from "@playwright/experimental-ct-react";
import type { Page } from "@playwright/test";
import * as React from "react";
import { Notepad } from "../src/webview/Notepad";
import { mkNote } from "./_helpers/factories";

/** Long enough to run past four lines at any sidebar width these tests use. */
const LONG = "The Deck relaunch path resolves agentProvider and agentSurface at seed time "
  + "in the target window, never from the plan file, so flipping the setting also changes "
  + "plans already on disk. That is the whole reason the chokepoint exists in workspace.ts.";

const SHORT = "One line.";

/** How tall the body renders, and how much of it the clamp is holding back. jsdom
 *  reports 0 for both of these, which is why the clamp is pinned here instead. */
async function box(page: Page, title: string) {
  return page.locator(".np-item", { hasText: title }).locator(".np-body").evaluate((el) => ({
    client: el.clientHeight,
    scroll: el.scrollHeight,
  }));
}

test("clamps a long body to four lines and offers to reveal the rest", async ({ mount, page }) => {
  await page.setViewportSize({ width: 340, height: 700 });
  // The one-line note rides along so a line box can be measured rather than
  // derived: .np-body's line-height computes to `normal`, which does not parse.
  await mount(<Notepad ordered={false} notes={[
    mkNote({ id: "a", title: "Long", body: LONG }),
    mkNote({ id: "b", title: "Short", body: SHORT }),
  ]} />);

  const long = await box(page, "Long");
  // Guard the premise: without real layout every number here is 0 and the test
  // would pass while asserting nothing.
  expect(long.client).toBeGreaterThan(0);
  expect(long.scroll).toBeGreaterThan(long.client);
  await expect(page.getByRole("button", { name: "Show more" })).toBeVisible();

  const line = (await box(page, "Short")).client;
  expect(Math.round(long.client / line)).toBe(4);
});

test("offers no control when the whole body already fits", async ({ mount, page }) => {
  await page.setViewportSize({ width: 340, height: 700 });
  await mount(<Notepad ordered={false} notes={[mkNote({ id: "b", title: "Short", body: SHORT })]} />);

  const short = await box(page, "Short");
  expect(short.client).toBeGreaterThan(0);
  expect(short.scroll).toBe(short.client);
  await expect(page.getByRole("button", { name: "Show more" })).toHaveCount(0);
});

test("reveals the whole body when expanded, and keeps the control to put it back", async ({ mount, page }) => {
  await page.setViewportSize({ width: 340, height: 700 });
  await mount(<Notepad ordered={false} notes={[mkNote({ id: "a", title: "Long", body: LONG })]} />);

  await page.getByRole("button", { name: "Show more" }).click();

  // Nothing held back any more — this is the invariant the clamp is allowed to
  // exist under: the user's own text stays readable in place.
  await expect.poll(async () => {
    const b = await box(page, "Long");
    return b.scroll - b.client;
  }).toBe(0);
  await expect(page.getByRole("button", { name: "Show less" })).toBeVisible();
});

test("offers the control once a narrowing panel starts clipping a body that fitted", async ({ mount, page }) => {
  await page.setViewportSize({ width: 600, height: 700 });
  // Wraps to under four lines at 600px and past them at 240px — the case a
  // character-count estimate gets wrong, hiding text with no way to reach it.
  const medium = "Flows are global and shared across windows behind a lock, and the Deck evaluates one pass every six seconds.";
  await mount(<Notepad ordered={false} notes={[mkNote({ id: "m", title: "Medium", body: medium })]} />);
  await expect(page.getByRole("button", { name: "Show more" })).toHaveCount(0);

  await page.setViewportSize({ width: 240, height: 700 });

  // No re-render happens here: only the ResizeObserver can notice this.
  await expect(page.getByRole("button", { name: "Show more" })).toBeVisible();
});
