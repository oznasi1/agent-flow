import { type FrameLocator, type Locator, type Page } from "@playwright/test";

/** The Marketplace webview. It opens as an editor PANEL, not a sidebar view,
 *  with the same outer/inner nesting as `tasksFrame` (an outer `iframe.webview`,
 *  an inner `#active-frame`) — workbench-internal and can shift between pinned
 *  VS Code versions, which is why the nesting is expressed here and in
 *  `host.ts` only.
 *
 *  `.last()` is a POSITIONAL pick and is only safe while it resolves to a
 *  single element. It does here: the marketplace journey never opens the
 *  Tasks sidebar (`openTasksView`), the Marketplace panel is a host-side
 *  singleton (`MarketplacePanel.show`, marketplaceView.ts — a second "Open the
 *  Marketplace" reveals the existing panel instead of minting another), and
 *  `page.locator("iframe.webview").count()` was verified to stay 1 across all
 *  four journey tests in this file's shared Electron boot. `deck-github.e2e.ts`
 *  hits the genuinely ambiguous case — sidebar AND a panel open together — and
 *  resolves its frame by CONTENT (`.stats`) instead of position; reach for that
 *  pattern here too if a future Marketplace journey ever opens the sidebar
 *  first, rather than trusting `.last()` again.
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

  /** `mkt:copy`/`mkt:open`/`mkt:reveal` results surface as a toast the webview
   *  renders ITSELF (`.toasts .toast`, MarketplaceApp.tsx:539-540) from a
   *  `{type:"toast"}` message the host posts back (marketplaceView.ts's
   *  `toast()` helper) — this is NOT `vscode.window.showInformationMessage`,
   *  so it never reaches the workbench's own `.notifications-toasts` overlay.
   *  It also self-dismisses after 2600ms (MarketplaceApp.tsx:185), so assert
   *  on it promptly after the triggering click. */
  toast(): Locator {
    return this.frame.locator(".toast");
  }
}
