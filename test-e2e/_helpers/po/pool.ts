import { expect, type FrameLocator, type Locator, type Page } from "@playwright/test";
import { openTasksView, tasksFrame } from "../host";

/** The sidebar webview, addressed by intent rather than by CSS class.
 *
 *  Every selector the journeys used to inline lives HERE and nowhere else: a
 *  webview class rename is then a one-file repair instead of a nine-file hunt.
 *  When a locator stops matching, fix it here and read the real class from the
 *  component named in the comment — never work around it in a journey. */
export class Pool {
  readonly frame: FrameLocator;

  /** Journeys need the raw page for keyboard and mouse gestures the page object does not wrap. */
  constructor(readonly page: Page) {
    this.frame = tasksFrame(page);
  }

  /** Open the sidebar and, when `n` is given, wait for the pool to render `n`
   *  cards. Idempotent, so a shared-host journey (`describeWithHost`) can call
   *  this once per test without each call fighting the last: VS Code's activity
   *  bar TOGGLES a view container's visibility when its own already-active icon
   *  is clicked again, so unconditionally re-clicking it (as `openTasksView`
   *  does) would collapse an already-open Agent Flow sidebar instead of
   *  confirming it's open, and `pool.cards()` would then time out at 0.
   *  Checking first avoids ever sending that second click.
   *
   *  "Already open" is read from the Tasks tab (App.tsx:565 `role="tab"` on
   *  2026-09-03), not from the card count: a pool the journey itself has just
   *  emptied (every card retired by a done-move) is still an open sidebar, and
   *  counting cards there would send the collapsing click. Omit `n` for exactly
   *  that state — the journey then asserts whatever count it expects itself. */
  static async open(page: Page, n?: number): Promise<Pool> {
    const pool = new Pool(page);
    // Before the sidebar has ever been opened, the outer `iframe.webview` doesn't
    // exist yet — resolving through it to count the tab throws rather than
    // answering 0, so treat that failure the same as "not open yet".
    const alreadyOpen = await pool.frame
      .getByRole("tab", { name: "Tasks" })
      .count()
      .then((c) => c > 0)
      .catch(() => false);
    if (!alreadyOpen) {
      await openTasksView(page);
    }
    if (n !== undefined) await expect(pool.cards()).toHaveCount(n, { timeout: 30_000 });
    return pool;
  }

  cards(): Locator {
    return this.frame.locator(".card");
  }

  /** One card, addressed by ticket key (the key is rendered inside the card). */
  card(key: string): Locator {
    return this.frame.locator(".card", { hasText: key });
  }

  /** One lens button in the filter row — App.tsx:585 `role="group"
   *  aria-label="Task filter"` on 2026-09-03. */
  lens(name: string): Locator {
    return this.frame.getByRole("group", { name: "Task filter" }).getByRole("button", { name });
  }

  /** Switch lens and wait for the refetch to settle on `n` cards. */
  async selectLens(name: string, n: number): Promise<void> {
    await this.lens(name).click();
    await expect(this.cards()).toHaveCount(n, { timeout: 15_000 });
  }

  /** The card's status button, which opens the host's transition QuickPick —
   *  App.tsx:903 `button.status.status-btn` on 2026-09-03. */
  statusButton(key: string): Locator {
    return this.card(key).locator("button.status");
  }

  /** "Add to my sprint" — App.tsx:913 `button.sprint-add`, visible text, gated
   *  on `caps.sprints` and the card's assignee (App.tsx:823) on 2026-09-03. */
  addToSprintButton(key: string): Locator {
    return this.card(key).getByRole("button", { name: /add to my sprint/i });
  }

  /** The icon-only "Remove from sprint" button — App.tsx:922 `button.sprint-remove`,
   *  addressed by its aria-label because it carries no visible text (2026-09-03). */
  removeFromSprintButton(key: string): Locator {
    return this.card(key).getByRole("button", { name: new RegExp(`Remove ${key} from your active sprint`) });
  }

  /** Every drag handle in the pool — App.tsx:886 `span.grip`, rendered only when
   *  the lens can reorder (`canReorder`, App.tsx:498) on 2026-09-03. */
  grips(): Locator {
    return this.frame.locator(".grip");
  }

  /** The webview's own toasts — App.tsx:768 `.toast.toast--<level>` on 2026-09-03.
   *  These are NOT workbench notifications: `tasksView.ts`'s `toast()` posts a
   *  `{type:"toast", level}` message and the webview renders it. Only the
   *  removal's Undo goes through `vscode.window.showInformationMessage`. Errors
   *  stay until clicked; success/info vanish after 4.2s, so assert them promptly. */
  toasts(level: "success" | "error" | "info", text?: string | RegExp): Locator {
    return this.frame.locator(`.toast--${level}`, text === undefined ? {} : { hasText: text });
  }

  /** Drive the repo multiselect. Batch mode only surfaces once a repo is
   *  selected (App.tsx) — every batch-shaped journey starts here. */
  async selectRepo(name: string): Promise<void> {
    await this.repoTrigger().click();
    await this.frame.locator(".repo-opt", { hasText: name }).click();
    await this.page.keyboard.press("Escape"); // close the popover; the selection sticks
  }

  // ---- The lens row. Every locator below is read from src/webview/App.tsx on
  // 2026-09-03; the line cited is where the element is rendered. Role + accessible
  // name where the component gives one, so a class rename in `styles.ts` cannot
  // silently detach a journey from the control it thinks it is driving.

  /** The filter-tab group — `<div className="seg" role="group" aria-label="Task filter">`
   *  (App.tsx:585). Its buttons are the lenses `visibleFilters(caps.supportedFilters)`
   *  chose to render (App.tsx:586-593), labelled from `FILTER_LABELS` (App.tsx:22). */
  filterGroup(): Locator {
    return this.frame.getByRole("group", { name: "Task filter" });
  }

  /** One filter tab by its visible label ("Mine", "My sprint", …). `exact` so
   *  "Sprint" cannot match "My sprint". `aria-pressed` (App.tsx:589) says which is
   *  active. */
  filterTab(label: string): Locator {
    return this.filterGroup().getByRole("button", { name: label, exact: true });
  }

  /** The S/M/L estimate control — `role="group" aria-label="Size"` (App.tsx:601),
   *  rendered only under `caps.sizes && filters.size` (App.tsx:598). */
  sizeGroup(): Locator {
    return this.frame.getByRole("group", { name: "Size" });
  }

  /** The status chip row — `role="group" aria-label="Status"` (App.tsx:619),
   *  rendered only under `filters.status && availableStatuses.length > 0`
   *  (App.tsx:616). Its first button is "All", then one per distinct status. */
  statusGroup(): Locator {
    return this.frame.getByRole("group", { name: "Status" });
  }

  /** The repo multiselect's trigger — `<button className="repo-select-trigger">`
   *  (App.tsx:1138). `RepoMultiSelect` itself mounts only under `filters.repo`
   *  (App.tsx:641) and returns null when the pool infers no repos (App.tsx:1134). */
  repoTrigger(): Locator {
    return this.frame.locator(".repo-select-trigger");
  }

  /** The fuzzy title/key search box — `<input placeholder="Search title or ticket…">`
   *  inside `.text-search` (App.tsx:650-657), rendered only under `filters.search`. */
  searchBox(): Locator {
    return this.frame.getByPlaceholder("Search title or ticket…");
  }

  /** Switch to the Notepad tab. Role-based, so it survives a class rename. */
  async openNotepad(): Promise<void> {
    await this.frame.getByRole("tab", { name: "Notepad" }).click();
    await expect(this.frame.locator(".notepad")).toBeVisible();
  }

  async openTasksTab(): Promise<void> {
    await this.frame.getByRole("tab", { name: "Tasks" }).click();
  }

  /** The text currently selected inside the webview.
   *
   *  Read INSIDE the frame on purpose. The webview is served from
   *  `vscode-webview://…` while the workbench page is `vscode-file://vscode-app`,
   *  so walking `iframe.webview` → `#active-frame` → `contentDocument` from a
   *  `page.evaluate()` is a cross-origin read: it hands back `null`, always, for
   *  every selection. A journey that did that walk read the resulting `""` as
   *  "nothing is selected" and pinned a product defect that did not exist.
   *  `FrameLocator`-rooted `evaluate` runs in the webview's own realm, where
   *  `getSelection()` is the real thing. */
  async selection(): Promise<string> {
    return await this.frame.locator("body").evaluate(() => document.getSelection()?.toString() ?? "");
  }

  notes(): Locator {
    return this.frame.locator(".np-item");
  }

  note(title: string): Locator {
    return this.frame.locator(".np-item", { hasText: title });
  }

  sections(): Locator {
    return this.frame.locator(".np-section");
  }
}
