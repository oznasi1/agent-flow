import type { Page, TestInfo } from "@playwright/test";

/** A labelled step screenshot, attached to the test itself. Attachments travel
 *  in the JSON report with their label and file path, which is what lets the
 *  verify-feature generator (scripts/verify-report.mjs) build the ordered
 *  screenshot strip per journey without any filename conventions. */
export async function shot(page: Page, testInfo: TestInfo, label: string): Promise<void> {
  await testInfo.attach(label, { body: await page.screenshot(), contentType: "image/png" });
}
