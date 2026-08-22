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

  /** Open the sidebar and wait for the pool to render `n` cards. Idempotent, so a
   *  shared-host journey (`describeWithHost`) can call this once per test without
   *  each call fighting the last: VS Code's activity bar TOGGLES a view
   *  container's visibility when its own already-active icon is clicked again,
   *  so unconditionally re-clicking it (as `openTasksView` does) would collapse
   *  an already-open Agent Flow sidebar instead of confirming it's open, and
   *  `pool.cards()` would then time out at 0. Checking first avoids ever sending
   *  that second click. */
  static async open(page: Page, n: number): Promise<Pool> {
    const pool = new Pool(page);
    // Before the sidebar has ever been opened, the outer `iframe.webview` doesn't
    // exist yet — resolving through it to count `.card` throws rather than
    // answering 0, so treat that failure the same as "not open yet".
    const alreadyOpen = await pool
      .cards()
      .count()
      .then((n) => n > 0)
      .catch(() => false);
    if (!alreadyOpen) {
      await openTasksView(page);
    }
    await expect(pool.cards()).toHaveCount(n, { timeout: 30_000 });
    return pool;
  }

  cards(): Locator {
    return this.frame.locator(".card");
  }

  /** One card, addressed by ticket key (the key is rendered inside the card). */
  card(key: string): Locator {
    return this.frame.locator(".card", { hasText: key });
  }

  /** Drive the repo multiselect. Batch mode only surfaces once a repo is
   *  selected (App.tsx) — every batch-shaped journey starts here. */
  async selectRepo(name: string): Promise<void> {
    await this.frame.locator(".repo-select-trigger").click();
    await this.frame.locator(".repo-opt", { hasText: name }).click();
    await this.page.keyboard.press("Escape"); // close the popover; the selection sticks
  }

  /** Switch to the Notepad tab. Role-based, so it survives a class rename. */
  async openNotepad(): Promise<void> {
    await this.frame.getByRole("tab", { name: "Notepad" }).click();
    await expect(this.frame.locator(".notepad")).toBeVisible();
  }

  async openTasksTab(): Promise<void> {
    await this.frame.getByRole("tab", { name: "Tasks" }).click();
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
