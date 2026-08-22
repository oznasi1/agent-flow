import { expect, test } from "@playwright/test";
import { describeWithHost } from "./_helpers/sharedHost";
import { Marketplace } from "./_helpers/po/marketplace";
import { shot } from "./_helpers/shot";

/** Open the Marketplace panel through the real command, not a seam.
 *
 *  Palette binding: `ControlOrMeta+Shift+P`, never `Control+Shift+P` — Cmd on
 *  macOS (the dev platform), Ctrl on Linux (CI).
 *
 *  Palette QUERY: the bare command title ("Open the Marketplace"), not
 *  "Agent Flow: Open the Marketplace". Typing the category prefix does not
 *  land the intended command first: VS Code's palette fuzzy-ranks "Agent Flow
 *  Deck: Focus on Tasks View" above "Open the Marketplace" for that string
 *  (an exact prefix match on "Agent Flow" outranks a scattered fuzzy match),
 *  so pressing Enter after typing the category-qualified string opens the
 *  Tasks sidebar instead — confirmed by capturing the palette and the
 *  resulting webview's frame URL (no Marketplace panel, a `purpose=webviewView`
 *  frame instead). The bare title has no such competitor and resolves first. */
async function openMarketplace(page: import("@playwright/test").Page): Promise<Marketplace> {
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.keyboard.type("Open the Marketplace");
  await page.keyboard.press("Enter");
  const mkt = new Marketplace(page);
  await expect(mkt.results().first()).toBeVisible({ timeout: 30_000 });
  return mkt;
}

describeWithHost("marketplace", {}, (ctx) => {
  test("lists the agents and commands found in .claude/", async ({}, testInfo) => {
    const mkt = await openMarketplace(ctx.page());
    await expect(mkt.result("telemetry-auditor")).toBeVisible();
    // Commands render with their `/` prefix (MarketplaceApp.tsx:83's
    // `display: a.type === "command" ? \`/${a.name}\` : a.name`), which is what
    // the `.nm` span actually shows — "refit" alone never matches.
    await expect(mkt.result("/refit")).toBeVisible();
    await shot(ctx.page(), testInfo, "1 · assets listed");
  });

  test("selecting an asset shows its body", async ({}, testInfo) => {
    const mkt = await openMarketplace(ctx.page());
    await mkt.result("telemetry-auditor").click();
    await expect(mkt.detail()).toContainText("Check the feed endpoint");
    await shot(ctx.page(), testInfo, "2 · detail");
  });

  test("copy reports success through the webview's own toast", async () => {
    const mkt = await openMarketplace(ctx.page());
    await mkt.result("telemetry-auditor").click();
    await mkt.copyButton().click();
    // `mkt:copy` reaches the REAL system clipboard (vscode.env.clipboard),
    // which this sandbox does not contain, so the assertion is on the success
    // signal instead: a toast the Marketplace webview renders ITSELF from the
    // host's `{type:"toast"}` reply (MarketplaceApp.tsx:539-540), not
    // `vscode.window.showInformationMessage` — it never reaches the workbench's
    // `.notifications-toasts` overlay, confirmed by capturing the DOM after the
    // click (a `.toasts` box inside the panel's own content, no workbench toast
    // at all). It also self-dismisses after 2600ms, so this asserts right after
    // the click that produces it.
    await expect(mkt.toast()).toContainText("Copied to clipboard", { timeout: 5_000 });
  });

  test("search narrows the list to the matching asset", async () => {
    const mkt = await openMarketplace(ctx.page());
    await mkt.search().fill("refit");
    await expect(mkt.result("/refit")).toBeVisible();
    await expect(mkt.result("telemetry-auditor")).toHaveCount(0);
  });
});
