import { test, expect } from "@playwright/experimental-ct-react";
import type { Page } from "@playwright/test";
import * as React from "react";
import { Notepad } from "../src/webview/Notepad";
import { posted } from "./_helpers/host";
import { mkNote } from "./_helpers/factories";

const notes = [
  mkNote({ id: "a", title: "First" }),
  mkNote({ id: "b", title: "Second" }),
  mkNote({ id: "c", title: "Third" }),
];

/** Drag a note by its grip and release over `toTitle` at `ratio` of that row's
 *  height. Only the grip arms the row (`draggable={armed}`). */
async function dragOnto(page: Page, fromTitle: string, toTitle: string, ratio: number) {
  const from = page.locator(".np-item", { hasText: fromTitle });
  const to = page.locator(".np-item", { hasText: toTitle });

  await from.locator(".grip").hover();
  await page.mouse.down();

  const box = await to.boundingBox();
  if (!box) throw new Error(`no layout box for ${toTitle}`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height * ratio;

  await page.mouse.move(x, y, { steps: 10 });
  await page.mouse.move(x, y + 1, { steps: 5 });
  await page.mouse.up();
}

/** The last reorder the notepad posted, or undefined if it posted none. */
async function lastReorder(page: Page) {
  return (await posted(page)).filter((m) => m.type === "notepad:reorder").at(-1);
}

test("dropping a note on the top half files it BEFORE the target", async ({ mount, page }) => {
  await mount(<Notepad notes={notes} ordered={true} />);
  // Guard the premise: this test only means something with real layout.
  const box = await page.locator(".np-item", { hasText: "Third" }).boundingBox();
  expect(box!.height).toBeGreaterThan(0);

  await dragOnto(page, "First", "Third", 0.15);

  await expect.poll(() => lastReorder(page)).toEqual({ type: "notepad:reorder", order: ["b", "a", "c"] });
});

test("dropping a note on the bottom half files it AFTER the target", async ({ mount, page }) => {
  await mount(<Notepad notes={notes} ordered={true} />);

  await dragOnto(page, "First", "Third", 0.85);

  await expect.poll(() => lastReorder(page)).toEqual({ type: "notepad:reorder", order: ["b", "c", "a"] });
});
