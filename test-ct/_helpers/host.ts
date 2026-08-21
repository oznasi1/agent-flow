import type { Page } from "@playwright/test";
import type { InboundMessage, OutboundMessage } from "../../src/types";

/** Deliver a host→webview message the way the real postMessage bridge does. */
export async function host(page: Page, msg: OutboundMessage): Promise<void> {
  await page.evaluate((m) => {
    window.dispatchEvent(new MessageEvent("message", { data: m }));
  }, msg);
}

/** Every message the webview posted back to the host, in order. */
export async function posted(page: Page): Promise<InboundMessage[]> {
  return page.evaluate(() => window.__posted);
}
