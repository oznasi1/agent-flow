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

  private constructor(readonly page: Page, frame?: FrameLocator) {
    this.frame = frame ?? page.frameLocator("iframe.webview").last().frameLocator("#active-frame");
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

  /** Open the Deck in a window whose Tasks sidebar is ALREADY showing — the
   *  case the class comment above says `.last()` cannot handle. The window then
   *  holds two of our webviews, and the workbench parks both iframes in an
   *  overlay container outside the `.part` DOM, so neither structure nor order
   *  tells them apart; only the Deck renders the `.stats` header (DeckApp.tsx:1120
   *  on 2026-09-03). Same resolution `deck-github.e2e.ts` does by hand off
   *  `page.frames()`, expressed here as a FrameLocator so every accessor on the
   *  class keeps working. Polls because the Deck's inner frame mounts a beat
   *  after the command is accepted. */
  static async openBesideSidebar(page: Page): Promise<Deck> {
    await runCommand(page, "Open the Deck (in-flight)");
    let found: FrameLocator | undefined;
    await expect.poll(async () => {
      const n = await page.locator("iframe.webview").count();
      for (let i = 0; i < n; i++) {
        const f = page.frameLocator("iframe.webview").nth(i).frameLocator("#active-frame");
        if (await f.locator(".stats").count().catch(() => 0)) { found = f; return true; }
      }
      return false;
    }, { timeout: 30_000 }).toBe(true);
    return new Deck(page, found);
  }

  /** Close every editor, the Deck panel included, through the real palette —
   *  `DeckPanel.show` (deckView.ts:574-577) only REVEALS a live panel, so a
   *  journey that needs a genuine reopen (fresh webview, `deck:ready` again)
   *  has to dispose it first. Waits for the webview iframes to leave the DOM:
   *  the tab can be gone a beat before the iframe is, and `open()`'s `.last()`
   *  would otherwise pick the dying one. Only safe while no sidebar webview is
   *  open, for the same reason. */
  static async closeAll(page: Page): Promise<void> {
    await runCommand(page, "View: Close All Editors");
    await expect(page.locator("iframe.webview")).toHaveCount(0, { timeout: 15_000 });
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

  /** Opens the drawer's `More` disclosure — `<details className="dd-more">`
   *  whose `<summary role="button">` reads "More — copy, per-repo diffs, spend
   *  breakdown, forget" (DeckDetail.tsx:598-599). The drawer rebuild moved
   *  every Copy row, the per-repo diffs, the spend table and Track it/Forget
   *  behind this disclosure, closed by default — a caller after any of those
   *  (`forget()` in `deck-lifecycle.e2e.ts` included) must call this first or
   *  the target is not in the accessibility tree to click.
   *
   *  Waits for "Spend" (`.dd-lbl` text, unconditional inside the body) rather
   *  than the `<details>` element's own `open` attribute — the same reasoning
   *  `DeckDetail.test.tsx`'s own `openMore` helper states: the browser flips
   *  `open` as part of the click's default action, a tick BEFORE the `toggle`
   *  event that actually renders the body fires, so asserting on `open` alone
   *  can resolve before the content exists. Spend's heading is present the
   *  instant the body renders at all, whatever the card's PR/local/tracked
   *  state, so it is a stable thing to wait on here too. */
  async openMore(): Promise<void> {
    const dd = this.detail();
    await dd.getByRole("button", { name: /^More/ }).click();
    // `exact: true` matters: the summary's own label text ("...spend
    // breakdown, forget") also contains "spend" case-insensitively, so a
    // loose match resolves to two elements (the summary plus this heading)
    // and Playwright's strict mode rejects it.
    await expect(dd.getByText("Spend", { exact: true })).toBeVisible({ timeout: 15_000 });
  }

  /** Every row in the PR-review rail. `.rv-row` is the row itself
   *  (ReviewStrip.tsx:103); `.rv-box` is NOT the row — it is the optional
   *  comment textarea's wrapper, rendered only when a row is both expanded and
   *  `reviewWrites` is on (ReviewStrip.tsx:217), so it neither exists for a
   *  collapsed row nor ever carries the row's `#<number>` text. The Skeleton
   *  shown while loading also renders `.rv-row` (ReviewStrip.tsx:274), but it
   *  and the real rows are mutually exclusive (`p.loading` gates one branch,
   *  `!p.loading` the other), so this never double-counts.
   *
   *  It does, however, COLLIDE at three: the skeleton is exactly three rows, so
   *  `toHaveCount(3)` is satisfied by a strip that is still shimmering and every
   *  assertion chained after it then races the search rather than following it.
   *  A skeleton row carries no `.rv-num`, so wait on `review(n)` for a row you
   *  expect before trusting a count of three (`review-strip.e2e.ts`'s
   *  `expectQueue` does exactly that, after being caught by it). */
  reviews(): Locator {
    return this.frame.locator(".rv-row");
  }

  /** The whole review rail — `.rv-strip` (ReviewStrip.tsx:311). `toHaveCount(0)`
   *  on this is the honest "there is no rail at all": `ReviewStrip` returns null
   *  outright when the queue is empty and neither loading, stale nor
   *  `showWhenEmpty` (ReviewStrip.tsx:302), so a hidden rail leaves no header
   *  behind for `reviews()` to under-count. Also the scope for the header's own
   *  copy — the `N PRs waiting on your review` line and the `showing N of M`
   *  note both live in `.rv-hd` inside it. */
  reviewStrip(): Locator {
    return this.frame.locator(".rv-strip");
  }

  /** The scroller the rows live in — `.rv-rows` (ReviewStrip.tsx:351), which owns
   *  a `max-height` of ~6.5 rows and `overflow-y: auto` (deckStyles.ts:501-502).
   *  The strip is the one place on this panel with a nested scroller, so this is
   *  the element to measure `scrollHeight` against `clientHeight` on. Note the
   *  skeleton renders its own `.rv-rows` (ReviewStrip.tsx:276) — mutually
   *  exclusive with the real one, same as `reviews()`. */
  reviewList(): Locator {
    return this.frame.locator(".rv-rows");
  }

  /** Every row's PR-number chip in queue order — `.rv-num` (ReviewStrip.tsx:129).
   *  `toHaveText([...])` on this asserts the ORDER, which is what the sort
   *  control changes; `reviews()` only ever counts. */
  reviewNumbers(): Locator {
    return this.frame.locator(".rv-row .rv-num");
  }

  /** One of the header's two sort buttons — `.rv-sort button`, labelled `oldest`
   *  and `smallest` (ReviewStrip.tsx:341-346). The active one carries class `on`.
   *  Neither is rendered while `loading` (there is nothing to sort yet), so a
   *  caller waits on rows first. */
  reviewSort(which: "oldest" | "smallest"): Locator {
    return this.frame.locator(`.rv-sort button:text-is("${which}")`);
  }

  /** One row's play control on the line itself — `.rv-go` (ReviewStrip.tsx:162-181).
   *  Distinct from `reviewLaunch(n)`, which is the labelled button INSIDE an
   *  expanded row: this one needs no expanding, which is the point of it.
   *
   *  Two shapes share the class, and the difference is load-bearing: a launchable
   *  row renders a `<button class="rv-go">` (plus ` cold` when its repo is not
   *  checked out), while a row already under review renders a `<span class="rv-go
   *  busy">` holding the loading mark — a span, not a disabled button, so it takes
   *  no click at all. Match `button.rv-go` when the distinction matters. Absent
   *  entirely while the strip is in select mode. */
  reviewGo(n: number): Locator {
    return this.review(n).locator(".rv-go");
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

  /** The card drawer's Workflow block — `.wf-block` (`WorkflowBlock.tsx:190`,
   *  rendered by `DeckDetail.tsx` under the `orchEnabled` gate). Present in
   *  either its "none" shape (`.wf-none`, an "Attach workflow…" button) or its
   *  attached shape (header name/status chip, a greyed-or-live stepper) — callers
   *  distinguish the two the way `WorkflowBlock.tsx` itself does, by what is
   *  inside, not by a second locator. Scoped to `detail()`: the board's OWN
   *  workflow chip (`.c-wf`, see `boardWorkflowChip`) lives on the card, not in
   *  this drawer, and the two must never be confused for one another. */
  workflowBlock(): Locator {
    return this.detail().locator(".wf-block");
  }

  /** The board's own workflow chip on one card's foot — `.c-wf`
   *  (`DeckApp.tsx`'s `Card`, ~line 433). Absent entirely while nothing is
   *  attached to that card (the span only renders `{workflow && (…)}`), which is
   *  distinct from the drawer's `.wf-none` dash: the card has no "nothing here"
   *  placeholder of its own. */
  boardWorkflowChip(key: string): Locator {
    return this.card(key).locator(".c-wf");
  }

  /** One board column, addressed by the label its header shows. A column is a
   *  `<section className="col">` whose `.col-hd .nm` holds `COLUMNS[].label`
   *  (DeckApp.tsx:93-98 and :1333-1337 on 2026-09-03) — "In progress",
   *  "Action required", "In review", "Merge". The lane sub-headers (`.lane-hd
   *  .nm`, lowercase — "working", "parked", …) are siblings of the cards inside
   *  `.col-body`, not wrappers around them, so a card's LANE cannot be scoped the
   *  way its column can; `laneHeader` below is the honest half of that. */
  column(label: "In progress" | "Action required" | "In review" | "Merge"): Locator {
    return this.frame.locator("section.col", { has: this.frame.locator(".col-hd .nm", { hasText: label }) });
  }

  /** One card, addressed by ticket key, but only if it sits inside the named
   *  column — `toHaveCount(0)` on this is "the card is not in that column", and
   *  `toBeVisible` is "it is". Membership, not just presence of the text
   *  somewhere on the board. */
  cardIn(column: "In progress" | "Action required" | "In review" | "Merge", key: string): Locator {
    return this.column(column).locator(".card", { hasText: key });
  }

  /** A lane's sub-header inside a column — rendered only while the lane holds at
   *  least one card (`if (inLane.length === 0) return []`, DeckApp.tsx:1343). */
  laneHeader(column: "In progress" | "Action required" | "In review" | "Merge", lane: string): Locator {
    return this.column(column).locator(".lane-hd .nm", { hasText: lane });
  }

  /** The card's live-signal line — `.c-st .status`, the text `stateView` renders
   *  (`working · 3s ago`, `ended turn · …`, `parked · git + Fixture only`, …;
   *  DeckApp.tsx:135-176 and :511-513 on 2026-09-03). The `.sdot` beside it
   *  carries the tone class; this is the words. */
  status(key: string): Locator {
    return this.card(key).locator(".c-st .status");
  }

  /** The drawer's Sessions section — `<div className="dd-sec">` whose `.dd-lbl`
   *  reads "Sessions" (DeckDetail.tsx:607-618 on 2026-09-03). Holds an
   *  `AgentsRow` (`.c-agents`, one `.ag-row` per open session naming it) when the
   *  card has sessions, else the `.dd-none` line "No session open — git + <source>
   *  only". Scoped to the drawer because the CARD does not name its sessions at
   *  all: `Card` in DeckApp.tsx renders no `AgentsRow` — the state line is the
   *  session's, but the name lives here. Open the drawer (click the card) first. */
  sessions(): Locator {
    return this.detail().locator(".dd-sec", { has: this.frame.locator(".dd-lbl", { hasText: "Sessions" }) });
  }

  /** One card's Open button — `.c-foot2 .act.primary`, which also carries `live`
   *  while presence says the run's window is open (DeckApp.tsx:544-550 on
   *  2026-09-03). Scoped to the card so a board with several cards resolves one. */
  openButton(key: string): Locator {
    return this.card(key).locator(".c-foot2 .act.primary");
  }

  /** One card's Diff button — the `.c-foot2 .act` whose text is exactly "Diff"
   *  (DeckApp.tsx:551-554 on 2026-09-03). `hasText` rather than `:text-is` so a
   *  future glyph beside the word does not break the lookup. */
  diffButton(key: string): Locator {
    return this.card(key).locator(".c-foot2 .act", { hasText: "Diff" });
  }

  /** One header count tile's number — `.stats .stat` whose `.l` label is the
   *  column name; `.n` holds the count (DeckApp.tsx:1120-1124 on 2026-09-03).
   *  Matched by the label text, not position, so the optional Tokens tile that
   *  `agentFlow.deck.showTokenTotal` appends cannot shift it. */
  tile(label: "In progress" | "Action required" | "In review" | "Merge"): Locator {
    return this.frame.locator(".stats .stat", { has: this.frame.locator(".l", { hasText: label }) }).locator(".n");
  }

  /** Every column header's name, in board order — `.col-hd .nm`
   *  (DeckApp.tsx:1334-1336 on 2026-09-03). */
  columnNames(): Locator {
    return this.frame.locator(".col .col-hd .nm");
  }

  /** One column's own count, `.col-hd .ct` (DeckApp.tsx:1338), addressed by
   *  the header name. */
  columnCount(label: "In progress" | "Action required" | "In review" | "Merge"): Locator {
    return this.frame.locator(".col", { has: this.frame.locator(".col-hd .nm", { hasText: label }) }).locator(".col-hd .ct");
  }

  /** The Sessions / Workspaces lens control — the `.ctls.seg .ctl` whose text is
   *  the visible label (DeckApp.tsx:1191-1204 on 2026-09-03); the chosen side
   *  carries the `on` class. */
  grouping(label: "Sessions" | "Workspaces"): Locator {
    return this.frame.locator(".ctls.seg .ctl", { hasText: label });
  }

  /** The header refresh button, resolved by the `.synced` caption it alone
   *  carries (DeckApp.tsx:1215-1222 on 2026-09-03) — it has no class of its own
   *  beyond the shared `.ctl`. */
  refresh(): Locator {
    return this.frame.locator(".ctl", { has: this.frame.locator(".synced") });
  }

  /** The refresh button's caption: "refresh" before the first sync, "syncing…"
   *  in flight, `synced Ns ago` after (DeckApp.tsx:1221 on 2026-09-03). */
  synced(): Locator {
    return this.frame.locator(".synced");
  }

  /** The Recently closed strip, `.rc` (ClosedStrip.tsx:37 on 2026-09-03). Not
   *  rendered at all — `return null` — while no run is on the closed shelf, so
   *  its absence is a `toHaveCount(0)`, never a hidden element. */
  closedStrip(): Locator {
    return this.frame.locator(".rc");
  }

  /** The strip's own disclosure button (`.rc-toggle`, ClosedStrip.tsx:39). The
   *  strip starts collapsed, with only the caret, the name and the count. */
  closedToggle(): Locator {
    return this.closedStrip().locator(".rc-toggle");
  }

  /** Expanded rows, one per closed run (`.rc-row`, ClosedStrip.tsx:57). Zero
   *  while collapsed — the rows are not in the DOM, not merely hidden. */
  closedRows(): Locator {
    return this.closedStrip().locator(".rc-row");
  }

  /** One closed row, by the key its `.rc-key` chip shows (ClosedStrip.tsx:59). */
  closedRow(key: string): Locator {
    return this.closedRows().filter({ has: this.frame.locator(".rc-key", { hasText: key }) });
  }

  /** The expanded row's action strip — `.rv-actions` (ReviewStrip.tsx:229 on
   *  2026-09-04). Inside `{expanded && !selecting && (…)}`, so it exists only on
   *  an expanded row: waiting for it is how a journey proves the detail block
   *  rendered at all before asserting that something inside it is ABSENT, which
   *  a bare `toHaveCount(0)` on a collapsed row would satisfy vacuously. */
  reviewActions(n: number): Locator {
    return this.review(n).locator(".rv-actions");
  }

  /** One of the three write buttons in an expanded row — rendered only while
   *  `agentFlow.reviewWrites` is on (ReviewStrip.tsx:249-251 on 2026-09-04).
   *  Addressed by the exact visible label so `Comment` cannot also resolve the
   *  neighbouring `Request changes`, and so `Approve` cannot resolve the row's
   *  `▶ Review with …` primary. */
  reviewSubmit(n: number, verb: "Approve" | "Comment" | "Request changes"): Locator {
    return this.reviewActions(n).getByRole("button", { name: verb, exact: true });
  }

  /** The row's review-body textarea. `.rv-box` is the WRAPPER (ReviewStrip.tsx:221
   *  on 2026-09-04) and is itself gated on `reviewWrites`, so its own
   *  `toHaveCount(0)` is the honest "there is nowhere to write" assertion; this
   *  accessor is the field you type into. */
  reviewBox(n: number): Locator {
    return this.review(n).locator(".rv-box textarea");
  }

  /** The row's "Load the session's review" button — rendered only when the host
   *  found a draft for this PR (`{r.draftPath && (…)}`, ReviewStrip.tsx:239 on
   *  2026-09-04), which means a review run record whose worktree holds
   *  `.pick-task/REVIEW-<n>.md`. Absent, not disabled, when there is no draft. */
  reviewLoadDraft(n: number): Locator {
    return this.reviewActions(n).getByRole("button", { name: "Load the session's review" });
  }

  /** The row's post-failure line, `.rv-fail` (ReviewStrip.tsx:261 on 2026-09-04).
   *  Rendered only after a submit for this row came back failed, and unlike the
   *  toast it does not time out — so it is the durable DOM record that a
   *  rejection reached the user. */
  reviewFail(n: number): Locator {
    return this.review(n).locator(".rv-fail");
  }

  /** The Deck's own toast stack — `.toast <level>` with the words in `.toast-msg`
   *  (DeckApp.tsx:1408-1411 on 2026-09-04). NOT a VS Code notification: the Deck
   *  posts these into its own webview. They self-dismiss after 2.6s
   *  (DeckApp.tsx:753), so assert on one immediately after the action that raises
   *  it and prefer a durable record (a log file, a `calls.jsonl` line) for
   *  anything the test needs to check later. */
  toast(level: "success" | "error" | "info" | "warn"): Locator {
    return this.frame.locator(`.toast.${level} .toast-msg`);
  }

  /** The strip header's selection-mode toggle — `.rv-select button`, labelled
   *  `select` (ReviewStrip.tsx:335-337 on 2026-09-04). Rendered only while the strip
   *  is NOT loading and the host wired `onSelectMode`, so a caller waits on a
   *  numbered row first. Carries class `on` while selecting. Scoped to `.rv-select`
   *  rather than matched by name alone: the sort buttons beside it are the same
   *  shape, and the Marketplace's own controls share the workbench frame. */
  reviewSelectMode(): Locator {
    return this.frame.locator(".rv-select button");
  }

  /** One row's own header button — `.rv-line` (ReviewStrip.tsx:117). One button with
   *  two jobs: outside selection mode it expands the row (which `expandReview` uses
   *  it for), and while selecting it TOGGLES the row's pick (ReviewStrip.tsx:114),
   *  with `aria-pressed` reflecting the picked state (ReviewStrip.tsx:115) and
   *  `undefined` — so the attribute is absent, not `"false"` — outside the mode.
   *  `click({ modifiers: ["Shift"] })` on it draws a range from the last row toggled
   *  (DeckApp.tsx:1274-1291 on 2026-09-04). */
  reviewLine(n: number): Locator {
    return this.review(n).locator(".rv-line");
  }
  /** One of the two Orchestrator header buttons — `.ctl.orch-chip`, rendered
   *  only while `agentFlow.orchestrator` is on (DeckApp.tsx:1144-1189 on
   *  2026-09-04). Both carry the same classes and the same icon, so they are
   *  told apart by the `<span>` naming them, which is the only thing that
   *  differs. `Workflows` also gains the `armed` class while its badge reads
   *  "N needs you" — see `orchChipCount`. */
  orchChip(which: "Workflows" | "Templates"): Locator {
    return this.frame.locator(".ctl.orch-chip", { has: this.frame.locator("span", { hasText: which }) });
  }
  /** One header button's badge — `.ct` inside it (DeckApp.tsx:1169-1171 and
   *  :1186 on 2026-09-04). Absent, not zero, when there is nothing to count:
   *  Workflows renders no `.ct` with no card carrying a workflow, and Templates
   *  renders none with no templates at all. So "no badge" is a
   *  `toHaveCount(0)`, never an empty string. */
  orchChipCount(which: "Workflows" | "Templates"): Locator {
    return this.orchChip(which).locator(".ct");
  }
  /** The Orchestrator drawer itself — `.orch` (`Drawer surface="orch"`,
   *  Drawer.tsx:35). Its absence is a `toHaveCount(0)`: the drawer unmounts
   *  rather than hiding. */
  orch(): Locator {
    return this.frame.locator(".orch");
  }
  /** One of the drawer's three top-level views, addressed by the tab that
   *  reaches it — `role="tab"` inside `role="tablist" aria-label="Orchestrator"`
   *  (OrchestratorDrawer.tsx:760-769 on 2026-09-04). Scoped to that tablist
   *  because Canvas ALSO renders a second, nested one (`aria-label="Flow view"`,
   *  :1785) whose tabs are named `Canvas` and `List` — a frame-wide query for
   *  the tab named "Canvas" resolves to two elements the moment a flow is open.
   *  `selected: true` on the role query is how a caller asks which view is
   *  showing; `aria-selected` is set on all three, never removed. */
  orchTab(name: "Active" | "Templates" | "Canvas"): Locator {
    return this.orch()
      .getByRole("tablist", { name: "Orchestrator" })
      .getByRole("tab", { name, exact: true });
  }
  /** All three top-level tabs, in header order — the whole
   *  `aria-label="Orchestrator"` tablist. `toHaveText([...])` on this is how a
   *  caller asserts there are exactly three views and what they are named,
   *  which no per-tab lookup can say. */
  orchTabs(): Locator {
    return this.orch().getByRole("tablist", { name: "Orchestrator" }).getByRole("tab");
  }
  /** The Canvas-only Canvas/List toggle — the nested `aria-label="Flow view"`
   *  tablist (OrchestratorDrawer.tsx:1785-1802 on 2026-09-04), which exists
   *  only while `view === "canvas"`. Distinct from `orchTab` above: these two
   *  pick a PRESENTATION of one flow, not one of the drawer's three screens. */
  orchFlowViewTab(name: "Canvas" | "List"): Locator {
    return this.orch()
      .getByRole("tablist", { name: "Flow view" })
      .getByRole("tab", { name, exact: true });
  }
  /** Every row on the Active view — `.wfl-row`, one per card carrying a
   *  workflow (WorkflowList.tsx:45 on 2026-09-04). Zero rows renders
   *  `.wfl-empty` instead, so a count of 0 here is the honest "nothing
   *  attached anywhere". */
  activeRows(): Locator {
    return this.orch().locator(".wfl-row");
  }
  /** One Active row's own button — the whole row is one `<button className=
   *  "wfl-open">` (WorkflowList.tsx:46), so this is both the row's text and its
   *  click target. Addressed by the ticket key its `.wfl-ticket` span holds,
   *  matched with `:text-is` (as `review` does for `.rv-num`) so `E2E-D1`
   *  cannot also resolve `E2E-D10`'s row. */
  activeRow(key: string): Locator {
    return this.orch().locator(`.wfl-row:has(.wfl-ticket:text-is("${key}")) .wfl-open`);
  }
  /** The drawer's Arm control — `.orch-arm`, the one filled button on the
   *  surface (OrchestratorDrawer.tsx:2012-2018 on 2026-09-04). Canvas-only, and
   *  hidden entirely while a TEMPLATE is being edited (a template has no card to
   *  watch). Its text is the state: "Arm" when disarmed, "Armed · disarm" when
   *  armed. */
  orchArm(): Locator {
    return this.orch().locator(".orch-arm");
  }
  /** The drawer's resize handle — `.orch-grip`, a `role="separator"` with
   *  `tabIndex={0}` and `aria-valuenow` carrying the current width
   *  (OrchestratorDrawer.tsx:783-797 on 2026-09-04). Hidden entirely while
   *  Expand is on, so its absence is a `toHaveCount(0)`. It is the drawer's
   *  FIRST focusable element in both renders, which is what makes it the honest
   *  starting point for walking the drawer's Tab order. */
  orchGrip(): Locator {
    return this.orch().locator(".orch-grip");
  }

  /** One row's file-count chip — `.rv-files`, the exact text `{changedFiles} files`
   *  (ReviewStrip.tsx:145 on 2026-09-04). Renders on every row whether or not a
   *  size has been read, so `0 files` is the honest "not filled in yet" and a
   *  `toHaveText` on it is a value assertion, never a presence one. */
  reviewFiles(n: number): Locator {
    return this.review(n).locator(".rv-files");
  }
  /** One row's line-count pair — `.rv-diff`, holding `.add` (`+{additions}`) and
   *  `.del` (`−{deletions}`) as separate elements (ReviewStrip.tsx:141-144 on
   *  2026-09-04). Two nodes rather than one string so each is queryable, which is
   *  what lets a forge that can only fill the file count be asserted on. */
  reviewDiff(n: number): Locator {
    return this.review(n).locator(".rv-diff");
  }
  /** One row's CI chip — `.rv-ci` (ReviewStrip.tsx:146 on 2026-09-04). Always
   *  present; the VERDICT is in its text and its class, and `none` is drawn as an
   *  EMPTY chip with no class at all (`CI_GLYPH`, ReviewStrip.tsx:21-26). So "no
   *  CI" is `toHaveText("")` plus the absence of `pr-ok`/`pr-bad`, never a
   *  `toHaveCount(0)` — the element does not go away. */
  reviewCi(n: number): Locator {
    return this.review(n).locator(".rv-ci");
  }

}
