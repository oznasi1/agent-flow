import { type FrameLocator, type Locator, type Page } from "@playwright/test";

/** The Marketplace webview. It opens as an editor PANEL, not a sidebar view,
 *  so it is the LAST webview iframe in the workbench — same nesting as
 *  `tasksFrame` (an outer `iframe.webview`, an inner `#active-frame`), which is
 *  workbench-internal and can shift between pinned VS Code versions. That is
 *  why the nesting is expressed here and in `host.ts` only.
 *
 *  Selectors read from src/webview/MarketplaceApp.tsx on 2026-08-22. */
export class Marketplace {
  readonly frame: FrameLocator;

  constructor(page: Page) {
    this.frame = page.frameLocator("iframe.webview").last().frameLocator("#active-frame");
  }

  results(): Locator {
    return this.frame.locator(".results .n");
  }

  /** One result row, addressed by its displayed name. */
  result(name: string): Locator {
    return this.frame.locator(".results").getByText(name, { exact: true });
  }

  detail(): Locator {
    return this.frame.locator(".detail");
  }

  copyButton(): Locator {
    return this.frame.locator(".btn.cp");
  }

  openButton(): Locator {
    return this.frame.locator(".btn.pri");
  }

  search(): Locator {
    return this.frame.locator(".search input");
  }
}
