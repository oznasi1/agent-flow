import { test, expect } from "@playwright/experimental-ct-react";
import type { Page } from "@playwright/test";
import * as React from "react";
import { App } from "../src/webview/App";
import { host, posted } from "./_helpers/host";
import { ALL_FILTERS, JIRA_CAPS, mkTask } from "./_helpers/factories";

/** Sign the panel in and give it three ordered cards under the my-sprint filter,
 *  which is the only filter that enables drag (App.tsx gates on
 *  `filter === "mysprint" && caps.sprints`). */
async function threeCards(page: Page) {
  await host(page, {
    type: "state", sourceLabel: "Jira", caps: JIRA_CAPS, authed: true, configured: true,
    project: "ASM", me: "Jane", prReviewStatus: "PR initiated", filters: ALL_FILTERS,
  });
  await host(page, {
    type: "tasks", filter: "mysprint",
    tasks: [mkTask({ key: "A" }), mkTask({ key: "B" }), mkTask({ key: "C" })],
  });
  await expect(page.locator(".card")).toHaveCount(3);
}

/** The one card whose key link is exactly `key`. Matching on the card's whole
 *  text would be ambiguous — every card carries an "Add to sprint" button, so a
 *  bare `hasText: "A"` matches all three. */
function card(page: Page, key: string) {
  return page.locator(".card").filter({ has: page.locator(".key", { hasText: new RegExp(`^${key}$`) }) });
}

/** Drag the card by its grip and release over `target` at `ratio` of the target's
 *  height (0 = top edge, 1 = bottom edge). The grip is what arms the drag
 *  (`armed.current`); a dragstart from anywhere else is preventDefault'd. */
async function dragOnto(page: Page, fromKey: string, toKey: string, ratio: number) {
  const from = card(page, fromKey);
  const to = card(page, toKey);

  await from.locator(".grip").hover();
  await page.mouse.down();

  // The whole point of this file: a real box with a real height, so
  // `clientY < top + height / 2` can actually go both ways.
  const box = await to.boundingBox();
  if (!box) throw new Error(`no layout box for ${toKey}`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height * ratio;

  // Chromium needs more than one move for a native HTML5 drag to start.
  await page.mouse.move(x, y, { steps: 10 });
  await page.mouse.move(x, y + 1, { steps: 5 });
  await page.mouse.up();
}

/** The last reorder the webview posted, or undefined if it posted none. */
async function lastReorder(page: Page) {
  return (await posted(page)).filter((m) => m.type === "reorder").at(-1);
}

test("dropping on the top half reorders BEFORE the target", async ({ mount, page }) => {
  await mount(<App />);
  await threeCards(page);
  // Guard the premise: without real layout this test proves nothing.
  const box = await card(page, "C").boundingBox();
  expect(box!.height).toBeGreaterThan(0);

  await dragOnto(page, "A", "C", 0.15);

  await expect.poll(() => lastReorder(page)).toEqual({ type: "reorder", order: ["B", "A", "C"] });
});

test("dropping on the bottom half reorders AFTER the target", async ({ mount, page }) => {
  await mount(<App />);
  await threeCards(page);

  await dragOnto(page, "A", "C", 0.85);

  await expect.poll(() => lastReorder(page)).toEqual({ type: "reorder", order: ["B", "C", "A"] });
});
