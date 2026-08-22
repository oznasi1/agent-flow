import { expect, type Page } from "@playwright/test";

/** Run a contributed command through the real command palette.
 *
 *  Every step here exists because its absence produced a CI failure. The naive
 *  version — press the chord, type, press Enter — passes locally and on a warm
 *  runner, then fails on a cold one, which is the worst kind of test:
 *
 *  1. **The extension must have ACTIVATED** before its command exists in the
 *     palette at all. On a freshly booted host the first journey can reach the
 *     palette before activation finishes, and the palette then honestly reports
 *     no matching command — Enter does nothing and the journey times out 30s
 *     later on a locator that was never going to appear. The activity-bar item
 *     is the cheapest proof of activation, because it only exists once the
 *     extension has contributed its view container.
 *
 *     We assert it is THERE, and deliberately never click it: opening the
 *     sidebar mounts a second `iframe.webview`, and the Marketplace page object
 *     resolves its frame with `.last()`.
 *
 *  2. **The palette must be focused before typing.** Keystrokes sent while the
 *     quick-input widget is still opening are dropped, so the filter ends up
 *     holding a truncated query that matches something else — or nothing.
 *
 *  3. **The list must have settled on the intended command before Enter.** The
 *     palette re-ranks as it filters; pressing Enter mid-settle runs whatever
 *     happened to be first at that instant.
 *
 *  Pass the BARE command title, not the category-qualified one: typing
 *  "Agent Flow: Open the Marketplace" fuzzy-ranks "Agent Flow Deck: Focus on
 *  Tasks View" first (an exact prefix match on the category outranks a
 *  scattered match on the title) and opens the sidebar instead.
 *
 *  The chord is `ControlOrMeta+Shift+P` — Cmd on macOS (the dev platform), Ctrl
 *  on Linux (CI). A literal `Control` modifier opens nothing on macOS. */
export async function runCommand(page: Page, title: string): Promise<void> {
  await expect(page.locator('.activitybar [aria-label*="Agent Flow"]').first())
    .toBeVisible({ timeout: 60_000 });

  const palette = page.locator(".quick-input-widget");
  const rows = palette.locator(".quick-input-list .monaco-list-row");

  await page.keyboard.press("ControlOrMeta+Shift+P");
  await expect(palette).toBeVisible({ timeout: 15_000 });
  await page.keyboard.type(title);
  await expect(rows.first()).toContainText(title, { timeout: 15_000 });
  await page.keyboard.press("Enter");
  // The palette closing is the signal the command was actually accepted; without
  // it a journey can race ahead and assert against the pre-command UI.
  await expect(palette).toBeHidden({ timeout: 15_000 });
}
