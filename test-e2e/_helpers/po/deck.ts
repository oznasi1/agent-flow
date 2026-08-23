import { expect, type FrameLocator, type Locator, type Page } from "@playwright/test";
import { runCommand } from "../palette";

/** The Deck webview. It opens as an editor PANEL, not a sidebar view, with the
 *  same outer/inner nesting as `tasksFrame` (an outer `iframe.webview`, an
 *  inner `#active-frame`) — workbench-internal and can shift between pinned
 *  VS Code versions, which is why the nesting is expressed here and in
 *  `host.ts` only.
 *
 *  `.last()` is a POSITIONAL pick and is only safe while it resolves to a
 *  single element, same caveat `Marketplace` documents: it holds as long as no
 *  journey using this page object also opens the Tasks sidebar first, since
 *  `DeckPanel.show` (deckView.ts) reveals the existing panel rather than
 *  minting a second one. Resolve by content instead (as `deck-github.e2e.ts`
 *  does, off `.stats`) the moment a Deck journey needs the sidebar open too.
 *
 *  Selectors read from src/webview/DeckApp.tsx, DeckDetail.tsx and
 *  ReviewStrip.tsx on 2026-08-22. */
export class Deck {
  readonly frame: FrameLocator;

  private constructor(readonly page: Page) {
    this.frame = page.frameLocator("iframe.webview").last().frameLocator("#active-frame");
  }

  /** Open through the real command palette, not a seam — see `runCommand` for
   *  why a raw chord+type+Enter loses to a cold-boot host. The command carries
   *  no category (package.json's `commands` entry for `agentFlow.openDeck` has
   *  no `category` key), so the bare title is the only string that matches. */
  static async open(page: Page): Promise<Deck> {
    await runCommand(page, "Open the Deck (in-flight)");
    const deck = new Deck(page);
    await expect(deck.frame.locator("body")).toBeVisible({ timeout: 30_000 });
    return deck;
  }

  /** One card per run (or per session on the Sessions lens). DeckApp.tsx:214. */
  cards(): Locator {
    return this.frame.locator(".card");
  }

  /** One card, addressed by ticket key (rendered inside the card's key chip). */
  card(key: string): Locator {
    return this.frame.locator(".card", { hasText: key });
  }

  /** The detail drawer for the selected card. The class is `.dd`, not
   *  `.deck-detail`/`.detail` — `<aside className="dd" aria-label={\`Detail for
   *  ${key}\`}>` (DeckDetail.tsx:123). */
  detail(): Locator {
    return this.frame.locator(".dd");
  }

  /** Every row in the PR-review rail. `.rv-row` is the row itself
   *  (ReviewStrip.tsx:103); `.rv-box` is NOT the row — it is the optional
   *  comment textarea's wrapper, rendered only when a row is both expanded and
   *  `reviewWrites` is on (ReviewStrip.tsx:217), so it neither exists for a
   *  collapsed row nor ever carries the row's `#<number>` text. The Skeleton
   *  shown while loading also renders `.rv-row` (ReviewStrip.tsx:274), but it
   *  and the real rows are mutually exclusive (`p.loading` gates one branch,
   *  `!p.loading` the other), so this never double-counts. */
  reviews(): Locator {
    return this.frame.locator(".rv-row");
  }

  /** One review row, addressed by PR number. `.rv-num` renders the exact text
   *  `#{r.number}` (ReviewStrip.tsx:125); matching it with `:text-is` (as
   *  `Marketplace.result` does for `.nm`) rather than `hasText` on the whole
   *  row keeps PR #2 from also matching PR #20's row. */
  review(n: number): Locator {
    return this.frame.locator(`.rv-row:has(.rv-num:text-is("#${n}"))`);
  }

  /** Expand one review row. `{expanded && !selecting && (…)}` (ReviewStrip.tsx:181)
   *  gates the ENTIRE detail block — `.rv-facts`, the optional `.rv-box` comment
   *  box, and `.rv-actions` with the "Review with …" button `reviewLaunch` needs
   *  — so a collapsed row has no launch button at all, not a disabled one. The
   *  click target is `.rv-line`, the row's own header button: it wraps the whole
   *  head (caret, repo, number, title, …) as ONE `<button>` whose handler is
   *  `onExpand(r.id)` (ReviewStrip.tsx:111-119; the doc comment right above it —
   *  "the whole line is the checkbox" — confirms the caret span at :119 is
   *  decorative, not a separate target). Waits for `open` on the row's own class
   *  (`` `rv-row ${expanded ? "open" : ""}...` ``, ReviewStrip.tsx:103) rather
   *  than returning immediately, since `.rv-detail` mounts on the re-render that
   *  follows the click, not synchronously with it. */
  async expandReview(n: number): Promise<void> {
    const row = this.review(n);
    await row.locator(".rv-line").click();
    await expect(row).toHaveClass(/\bopen\b/, { timeout: 15_000 });
  }

  /** The row's primary launch action — `▶ Review with {agentLabel}`
   *  (`.rv-actions .act.primary`, ReviewStrip.tsx:225-234). It lives inside the
   *  `{expanded && !selecting && (…)}` block (ReviewStrip.tsx:181), so it does
   *  not exist on a collapsed row — call `expandReview(n)` first. It is not the
   *  always-visible `▶` icon button (`.rv-go`) on the collapsed line. */
  reviewLaunch(n: number): Locator {
    return this.review(n).locator(".rv-actions .act.primary");
  }

  /** The batch-selection bar under the rail, shown once `select` mode picks at
   *  least the mode itself on (ReviewStrip.tsx:362). */
  batchBar(): Locator {
    return this.frame.locator(".batch-bar");
  }

  /** Launches the batch of selected reviews (`.batch-launch`, ReviewStrip.tsx:368). */
  batchLaunch(): Locator {
    return this.frame.locator(".batch-launch");
  }

  /** Retires stale run records; only rendered once there are any
   *  (`staleCount > 0`, DeckApp.tsx:704-712). Role-based so it survives a
   *  class rename — the button has no class of its own beyond the shared `.ctl`. */
  clearStale(): Locator {
    return this.frame.getByRole("button", { name: /clear stale/i });
  }
}
