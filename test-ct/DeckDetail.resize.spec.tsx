import { test, expect } from "@playwright/experimental-ct-react";
import type { Page } from "@playwright/test";
import * as React from "react";
import { DeckApp } from "../src/webview/DeckApp";
import { host } from "./_helpers/host";
import { mkStatus, runsMsg } from "./_helpers/deckFixtures";

/**
 * `test/webview/DeckDetail.test.tsx` already proves the resize arithmetic and
 * the persistence CALL — but only through `fireEvent`'s synthetic
 * pointermove/pointerup pair, fired straight at the grip with no real
 * pointer capture, and a vscodeApi double whose `setState` used to be a
 * no-op. What jsdom cannot see at all:
 *
 *  - that a genuine pointer drag on the grip changes what `.dd` is actually
 *    rendered at, and that the width really does survive as `ddWidth`;
 *  - that `.board`'s own reserved padding — read off a CUSTOM PROPERTY set on
 *    `document.documentElement`, a common ancestor `.board` shares with the
 *    drawer rather than a parent of it — tracks a width that changed after
 *    mount. jsdom's `getComputedStyle` does not reliably resolve `calc()`
 *    over a custom property set imperatively via `style.setProperty`, and
 *    even where it does, `.board` is not rendered by a `DeckDetail`-only
 *    mount at all;
 *  - that the grip is still at the drawer's own edge, not scrolled away with
 *    the content, once `.dd-scroll` (a REAL scrolling element with a REAL
 *    scrollbar) has actually been scrolled. jsdom has no scrolling.
 *
 * `DeckApp` is the smallest mount that renders `.board` and the card whose
 * click opens `DeckDetail` as `.board`'s own sibling — `DeckDetail` alone
 * cannot exercise the second claim, since `.board` lives one level up, in
 * `DeckApp.tsx`.
 */

function grip(page: Page) {
  return page.getByRole("separator", { name: "Resize detail drawer" });
}

/** The drawer's own box once its slide-in (`drawer-in`, `DRAWER_ANIM_MS` —
 *  same shape `OrchestratorDrawer.canvas.spec.tsx`'s `settledCanvasBox`
 *  guards against) has actually finished. `.dd-grip` is a child of `.drawer`
 *  and rides the SAME `translateX` the slide-in animates, so a box read
 *  mid-animation reports the grip partway off the right edge of the
 *  viewport — which is exactly what made a real `page.mouse` drag on it a
 *  silent no-op the first time this file was written: the down/move/up all
 *  land, but at a point the grip had already animated away from. */
async function settledDrawerBox(page: Page) {
  const dd = page.locator(".dd");
  let last = await dd.boundingBox();
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(25);
    const now = await dd.boundingBox();
    if (last && now && now.x === last.x && now.width === last.width) return now;
    last = now;
  }
  throw new Error("the drawer never stopped moving");
}

async function openDrawer(page: Page) {
  await host(page, runsMsg([mkStatus()]));
  await page.locator(".card").click();
  await expect(page.locator(".dd")).toBeVisible();
  await settledDrawerBox(page);
}

/** Grab the grip's own middle and pull it by `dx` — a negative `dx` (further
 *  LEFT) is what grows the drawer, per `DeckDetail.tsx`'s own comment: it is
 *  anchored to the panel's right edge, so pulling the left border further
 *  left widens it. */
async function dragGrip(page: Page, dx: number) {
  const box = (await grip(page).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const widthBefore = await ddWidth(page);
  await page.mouse.move(x, y);
  await page.mouse.down();
  // The `pointermove`/`pointerup` pair are bound in a `useEffect` gated on
  // `resizing`, which only runs after React commits the `pointerdown`
  // handler's `setResizing` — a real browser can paint (and this test's next
  // `mouse.move` can fire) before that commit lands. Rather than guess a
  // fixed delay (this file's one non-condition wait, and its only flake
  // candidate under CI's `retries: 1`), nudge one pixel in the drag's own
  // direction and poll until the rendered width actually moves off its
  // pre-drag value — proof the listener is attached — before committing to
  // the real move.
  const nudge = dx > 0 ? 1 : -1;
  await page.mouse.move(x + nudge, y);
  await expect.poll(() => ddWidth(page)).not.toBe(widthBefore);
  await page.mouse.move(x + dx, y, { steps: 10 });
  await page.mouse.up();
}

const ddWidth = (page: Page) => page.locator(".dd").evaluate((el) => parseFloat(getComputedStyle(el).width));
const boardPadRight = (page: Page) => page.locator(".board").evaluate((el) => parseFloat(getComputedStyle(el).paddingRight));

test("dragging the grip widens the rendered drawer and persists the width under ddWidth", async ({ mount, page }) => {
  await mount(<DeckApp />);
  await openDrawer(page);

  const before = await ddWidth(page);
  expect(before).toBeCloseTo(620, 0); // ddResize's own DEFAULT, and CSS's fallback for --dd-w

  await dragGrip(page, -120); // pull the left border 120px further left

  const after = await ddWidth(page);
  expect(after).toBeCloseTo(before + 120, 0);

  // The persisted value, read back through the vscodeApi double's own state
  // (see test-ct/_doubles/vscodeApi.ts) rather than a mocked call — this is
  // what a real reload would read back.
  await expect.poll(() => page.evaluate(() => (window.__state as { ddWidth?: number } | undefined)?.ddWidth))
    .toBeCloseTo(before + 120, 0);

  // Same shape drawerResize.ts's own header comment warns about: a merge, not
  // a replace. Asserted narrowly on purpose — `stored.ddWidth` and that
  // `orchWidth` (the Orchestrator drawer's own sibling key in the same
  // persisted object) is untouched — rather than pinning the object's
  // COMPLETE key set: `DeckApp` persisting some unrelated bit of state
  // through the same `vscodeApi.setState` in the future is not a bug this
  // test should own, and an earlier version of this assertion would have
  // broken on exactly that. Proving the merge doesn't wipe a SIBLING DRAWER's
  // width needs the Orchestrator drawer open too, which
  // test/webview/DeckDetail.test.tsx already covers over a mocked API.
  const stored = await page.evaluate(() => window.__state as Record<string, unknown>);
  expect(stored.ddWidth).toBeCloseTo(before + 120, 0);
  expect(stored.orchWidth).toBeUndefined();
});

// The important one: `--dd-w` is set on `document.documentElement`, and
// `.board.dd-open`'s `padding-right: calc(var(--dd-w, 620px) + 10px)` is the
// ONLY thing standing between a widened drawer and a board column becoming
// permanently unreachable. `.board` is the drawer's SIBLING in DeckApp.tsx,
// not its descendant, so this only works at all if the property is set on an
// ancestor the two actually share.
test("the board's reserved run-out tracks a dragged drawer width", async ({ mount, page }) => {
  await mount(<DeckApp />);
  await openDrawer(page);

  const widthBefore = await ddWidth(page);
  const padBefore = await boardPadRight(page);
  // Guard the premise: the board must already be reserving space for the
  // drawer before anything is dragged, or the rest of this test would pass
  // trivially against a board that reserves nothing at all.
  expect(padBefore).toBeCloseTo(widthBefore + 10, 0);

  await dragGrip(page, -140);

  const widthAfter = await ddWidth(page);
  expect(widthAfter).toBeCloseTo(widthBefore + 140, 0);
  const padAfter = await boardPadRight(page);
  expect(padAfter).toBeCloseTo(widthAfter + 10, 0);
  expect(padAfter).toBeCloseTo(padBefore + 140, 0);
});

// The other earlier bug this task names: the grip used to live INSIDE
// `.dd-scroll`, so it scrolled away with the content the moment there was
// enough of it to scroll, and `.dd-scroll`'s own `overflow-x: hidden` clipped
// it too. A short viewport is what forces genuine overflow — `More` alone,
// at the CT harness's default viewport, may not be tall enough to scroll.
test("the resize grip stays at the drawer's edge once More is open and the content is scrolled", async ({ mount, page }) => {
  await page.setViewportSize({ width: 1000, height: 340 });
  await mount(<DeckApp />);
  await openDrawer(page);
  await page.getByRole("button", { name: /^More/ }).click();
  await expect(page.getByText("Spend", { exact: true })).toBeVisible();

  const scroller = page.locator(".dd-scroll");
  const gripBoxBefore = (await grip(page).boundingBox())!;

  const scrolledTo = await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return el.scrollTop;
  });
  // Guard the premise: without real overflow this proves nothing about the
  // grip staying put, because nothing would have moved either way.
  expect(scrolledTo).toBeGreaterThan(0);

  const gripBoxAfter = (await grip(page).boundingBox())!;
  expect(gripBoxAfter.y).toBeCloseTo(gripBoxBefore.y, 0);
  expect(gripBoxAfter.height).toBeCloseTo(gripBoxBefore.height, 0);
  // Not merely "didn't move" — still actually reachable inside the viewport,
  // which is the whole complaint the earlier bug describes ("clipped").
  await expect(grip(page)).toBeInViewport();
});
