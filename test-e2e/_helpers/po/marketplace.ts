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

  // ─────────────────────────────────────────────────────────────────────────────
  // Filters, grouping, detail actions and the empty state. Appended for
  // marketplace-filters.e2e.ts / marketplace-detail.e2e.ts; selectors read from
  // src/webview/MarketplaceApp.tsx, PluginPicker.tsx, FilePreview.tsx and
  // marketplaceStyles.ts on 2026-09-04.
  // ─────────────────────────────────────────────────────────────────────────────

  /** One type ("Kind") pill, addressed by its label. The label and its count
   *  badge share the button, so this filters by text rather than matching it
   *  whole — scoped to the Kind group (MarketplaceApp.tsx:346) because the
   *  Plugins ▾ PICKER button says "Plugins" too. */
  kindPill(label: string): Locator {
    return this.frame.locator('[aria-label="Kind"] button').filter({ hasText: label });
  }

  /** The live count badge inside a type pill (`<span className="n">`,
   *  MarketplaceApp.tsx:347-355). */
  kindCount(label: string): Locator {
    return this.kindPill(label).locator(".n");
  }

  /** One scope pill — Everywhere · Installed only · Enabled only
   *  (MarketplaceApp.tsx:359-363). */
  scopePill(label: string): Locator {
    return this.frame.locator('[aria-label="Scope"] button').filter({ hasText: label });
  }

  /** A marketplace tag in the source row (MarketplaceApp.tsx:397-411). Matched on
   *  exact text because a stale source renders as "<name> — stale". */
  marketplaceTag(name: string): Locator {
    return this.frame.locator(`.srcs button.tag:text-is("${name}")`);
  }

  /** The chip row — absent from the DOM entirely when nothing is selected
   *  (MarketplaceApp.tsx:371). */
  chips(): Locator {
    return this.frame.locator(".chips");
  }

  /** The `Clear` chip that drops category, plugin and marketplace selections at
   *  once (MarketplaceApp.tsx:388-394). */
  clearChip(): Locator {
    return this.frame.locator(".chip.clear");
  }

  /** The Plugins ▾ picker's own trigger (PluginPicker.tsx:30) — NOT the Kind
   *  group's Plugins pill. */
  pickerButton(): Locator {
    return this.frame.locator(".picker > .pill");
  }

  /** One checkbox in the open picker. The accessible name folds in the
   *  marketplace (PluginPicker.tsx:52) because plugin names collide across
   *  marketplaces. */
  pickerCheckbox(plugin: string, marketplace: string): Locator {
    return this.frame.getByLabel(`${plugin} (${marketplace})`);
  }

  /** The picker's "Clear <n>" button, rendered only while something is selected
   *  (PluginPicker.tsx:63-67). */
  pickerClear(): Locator {
    return this.frame.locator(".btn.pclear");
  }

  /** The category section headers, in DOM order (MarketplaceApp.tsx:443-452).
   *  `.lb` is the label; the header itself is the clickable focus control. */
  groupHeaders(): Locator {
    return this.frame.locator(".grouphd");
  }

  groupLabels(): Locator {
    return this.frame.locator(".grouphd .lb");
  }

  /** The copyable snippet under the detail metadata — a command's `/name`, or a
   *  not-downloaded plugin's `/plugin install <ref>` (MarketplaceApp.tsx:510-517). */
  snippet(): Locator {
    return this.frame.locator(".snip pre");
  }

  /** The rendered file under the detail block (FilePreview.tsx:23). */
  preview(): Locator {
    return this.frame.locator(".preview");
  }

  /** The truncation note plus its own Open file button (FilePreview.tsx:25-33). */
  truncNote(): Locator {
    return this.frame.locator(".mdtrunc");
  }

  /** The headline of whichever empty state is showing — "nothing matches" inside
   *  the results list, or the not-set-up panel that replaces the whole split
   *  (MarketplaceApp.tsx:416-431). */
  emptyBig(): Locator {
    return this.frame.locator(".empty .big");
  }

  rescanButton(): Locator {
    return this.frame.locator(".hd .btn", { hasText: "Rescan" });
  }

  addMarketplaceButton(): Locator {
    return this.frame.locator(".hd .btn", { hasText: "Add a marketplace" });
  }

  /** The picker's open dropdown (PluginPicker.tsx:34) — absent while closed. */
  pickerPop(): Locator {
    return this.frame.locator(".picker .pop");
  }

  /** A row's clickable plugin name, which toggles that plugin's filter
   *  (MarketplaceApp.tsx:463-469). Asset rows only — a plugin row has no such
   *  button. */
  rowPluginLink(name: string): Locator {
    return this.result(name).locator(".meta.link");
  }
}
