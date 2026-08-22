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

  /** Every result row. `.row` is the row itself (MarketplaceApp.tsx:454); do NOT
   *  use `.n`, which is a count badge on the filter pills and group headers. */
  results(): Locator {
    return this.frame.locator(".results .row");
  }

  /** One result row, addressed by the display name in its `.nm` span
   *  (MarketplaceApp.tsx:458). Matching the row by its name element rather than
   *  by row text keeps a description or marketplace label from matching too. */
  result(name: string): Locator {
    return this.frame.locator(`.results .row:has(.nm:text-is("${name}"))`);
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
