import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { makeSandbox, type Sandbox } from "./_helpers/sandbox";
import { launchHost } from "./_helpers/host";
import { Deck } from "./_helpers/po/deck";
import {
  expectNoUnknownForgeCalls, forgeCalls, ghPrViewAnswer, ghReviewRequestsAnswer,
  installForgeShims, type ForgeAnswers, type ReviewReq,
} from "./_helpers/forgeShim";
import { shot } from "./_helpers/shot";

let sb: Sandbox;
let app: ElectronApplication | undefined;

/** The queue every test in this file reads, built so that OLDEST and SMALLEST
 *  disagree on which row comes first. That is the whole point of the numbers:
 *  with the plan's original "#41 old and small, #42 new and big" pair, both sort
 *  assertions would have read "first row is #41" and a sort control that did
 *  nothing at all would have passed them both.
 *
 *  | PR  | repo      | created    | lines | bucket | oldest rank | smallest rank |
 *  |-----|-----------|------------|-------|--------|-------------|---------------|
 *  | 41  | rocket    | 2026-06-01 |  1200 | L      | 1st         | 3rd           |
 *  | 44  | telemetry | 2026-07-01 |   300 | M      | 2nd         | 2nd           |
 *  | 42  | rocket    | 2026-08-25 |    40 | S      | 3rd         | 1st           |
 *  | 43  | retired   | archived — never arrives (see `ghReviewRequestsAnswer`)  |
 *
 *  `rocket` is the one checkout `makeSandbox` creates, so #41/#42 resolve a
 *  `localPath` and #44's `telemetry` deliberately does not — that absence is
 *  what the greyed-row test reads. */
const REQS: ReviewReq[] = [
  {
    number: 41, repo: "oznasi1/rocket", title: "Fix the rocket telemetry panel", author: "octo",
    branch: "fix/telemetry", createdAt: "2026-06-01T00:00:00Z",
    additions: 900, deletions: 300, changedFiles: 24,
  },
  {
    number: 42, repo: "oznasi1/rocket", title: "Refit the rocket landing gear", author: "octo",
    branch: "fix/gear", createdAt: "2026-08-25T00:00:00Z",
    additions: 30, deletions: 10, changedFiles: 2,
  },
  {
    number: 43, repo: "oznasi1/retired", title: "Retire the old launch pad", author: "octo",
    branch: "fix/pad", createdAt: "2026-05-01T00:00:00Z",
    additions: 5, deletions: 5, changedFiles: 1, isArchived: true,
  },
  {
    number: 44, repo: "oznasi1/telemetry", title: "Re-point the telemetry feed", author: "octo",
    branch: "fix/feed", createdAt: "2026-07-01T00:00:00Z",
    additions: 200, deletions: 100, changedFiles: 8,
  },
];

/** The three gh verbs the strip reaches for, and nothing else — `installForgeShims`
 *  writes all three CLIs regardless, so an unfaked subcommand still lands in
 *  unknown.jsonl for `expectNoUnknownForgeCalls`.
 *
 *  `api graphql` carries BOTH the review search and (folded in by
 *  `ghReviewRequestsAnswer`'s `unresolved` option) the per-PR threads query the
 *  row expansion follows it with: one signature, one body, two readers.
 *  `auth status` is the forge probe every launch path re-checks. `pr view` is the
 *  row-expansion checks call. */
function ghAnswers(reqs: ReviewReq[], o: { unresolved?: number; prView?: unknown } = {}): ForgeAnswers {
  return {
    gh: {
      "api graphql": ghReviewRequestsAnswer(reqs, o.unresolved === undefined ? {} : { unresolved: o.unresolved }),
      "auth status": "{}",
      "pr view": o.prView ?? JSON.stringify({ statusCheckRollup: [] }),
    },
  };
}

/** One host per test: every row in the plan's table pins a different setting or a
 *  different queue, and a launch is a worktree the next test must not inherit.
 *  Settings land on top of the sandbox contract, which already pre-answers every
 *  mid-launch prompt a take would raise. */
async function boot(
  settings: Record<string, unknown> = {},
  answers: ForgeAnswers = ghAnswers(REQS),
): Promise<{ page: Page; deck: Deck; windows: Page[] }> {
  sb = makeSandbox({
    "agentFlow.forge": "github",
    "agentFlow.reviewRequests": true,
    // "full" names a real shipped mode, so `resolveReviewMode` skips the picker
    // everywhere except the one test that deliberately re-opens it.
    "agentFlow.reviewRequestMode": "full",
    "agentFlow.reviewOpenIn": "new-window",
    ...settings,
  });
  installForgeShims(sb, answers);
  const launched = await launchHost(sb);
  app = launched.app;
  const windows = collectWindows(launched.app);
  const deck = await Deck.open(launched.page);
  return { page: launched.page, deck, windows };
}

test.afterEach(async () => {
  await app?.close();
  app = undefined;
  try {
    expectNoUnknownForgeCalls(sb);
  } finally {
    sb.dispose();
  }
});

/** Every worktree git itself knows about in the fixture repo — the difference
 *  between "a folder was created" and "a worktree was registered". */
function worktrees(repoPath: string): string {
  return execFileSync("git", ["worktree", "list"], { cwd: repoPath, encoding: "utf8" });
}

/** A review launch with `reviewOpenIn: "new-window"` opens a REAL second Electron
 *  window, whose boot nothing this journey polls ever awaits — left unawaited,
 *  `electronApplication.close()` in `afterEach` hangs on a window still
 *  mid-activation. Collected from launch onward (not a one-shot `waitForEvent`,
 *  which races a second window) and awaited before the test ends; see
 *  `review-launch.e2e.ts`, where the same pair is documented at length. */
function collectWindows(app: ElectronApplication): Page[] {
  const windows: Page[] = [];
  app.on("window", (w) => windows.push(w));
  return windows;
}

async function waitForWindows(windows: Page[], count: number, timeout: number): Promise<void> {
  await expect.poll(() => windows.length, { timeout }).toBeGreaterThanOrEqual(count);
  for (const w of windows.slice(0, count)) {
    await w.locator(".activitybar").waitFor({ timeout: 60_000 });
  }
}

/** The `q=` argument of the review search's own `gh api graphql` invocation, read
 *  off the shim's argv log. The assertion of record for a SERVER-SIDE filter: the
 *  rows the product never receives cannot prove anything about the query it sent,
 *  and `ghReviewRequestsAnswer` drops archived rows whatever the product does. */
function searchQueries(): string[] {
  return forgeCalls(sb)
    .filter((c) => c.cli === "gh" && c.argv[0] === "api" && c.argv[1] === "graphql")
    .flatMap((c) => c.argv.filter((a) => a.startsWith("q=")));
}

// Mutation-checked: dropped `archived:false` from REVIEW_SEARCH_Q (src/engine/review/search.ts:26).
test("the strip omits requests from archived repositories", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const { page, deck } = await boot();

  await expect(deck.review(41)).toBeVisible({ timeout: 60_000 });
  await expect(deck.review(42)).toBeVisible();
  await expect(deck.review(44)).toBeVisible();
  // #43 lives in an archived repository. Its absence alone proves nothing — the
  // answer builder drops such rows itself, exactly as GitHub would — so it is
  // asserted only as the shape the argv assertion below is consistent with.
  await expect(deck.review(43)).toHaveCount(0);
  await expect(deck.reviews()).toHaveCount(3);
  // `issueCount` travels back from the same search, which is why the filter is
  // server-side: a client-side one would leave the header reading "showing 3 of 4".
  await expect(deck.reviewStrip()).toContainText("3 PRs waiting on your review");
  await expect(deck.reviewStrip()).not.toContainText("showing 3 of");

  // The proof: the query the product actually sent. One search, one `q=`.
  const queries = searchQueries();
  expect(queries).toHaveLength(1);
  expect(queries[0]).toContain("archived:false");
  expect(queries[0]).toContain("is:pr is:open review-requested:@me");
  await shot(page, testInfo, "1 · three live rows, the archived one never arrives");
});

// Mutation-checked: reversed the age tie-break in sortRequests (src/engine/review/sort.ts:27)
// to `b.createdAt - a.createdAt`.
test("sort by oldest puts what you owe longest first", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const { page, deck } = await boot();

  await expect(deck.reviews()).toHaveCount(3, { timeout: 60_000 });
  // `oldest` is the shipped default (`reviewSort = "oldest"`, deckView.ts:450), so
  // this is the order the strip opens on — no click.
  await expect(deck.reviewSort("oldest")).toHaveClass(/\bon\b/);
  await expect(deck.reviewNumbers()).toHaveText(["#41", "#44", "#42"]);
  await shot(page, testInfo, "2 · oldest first");
});

// Mutation-checked: deleted the `if (sort === "smallest")` size comparison from
// sortRequests (src/engine/review/sort.ts:23-26), leaving age the only key.
test("sort by smallest puts the quickest review first", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const { page, deck } = await boot();

  await expect(deck.reviews()).toHaveCount(3, { timeout: 60_000 });
  await expect(deck.reviewNumbers()).toHaveText(["#41", "#44", "#42"]);

  await deck.reviewSort("smallest").click();

  // 40 lines, then 300, then 1200 — the exact reverse of the age order above, so
  // a control that changed nothing could not pass this.
  await expect(deck.reviewSort("smallest")).toHaveClass(/\bon\b/, { timeout: 30_000 });
  await expect(deck.reviewNumbers()).toHaveText(["#42", "#44", "#41"], { timeout: 30_000 });
  await shot(page, testInfo, "3 · smallest first");
});

// Mutation-checked: made the row's play control always `className="rv-go"`
// (src/webview/ReviewStrip.tsx:169), dropping the ` cold` case.
test("a row whose repo is not checked out is greyed but live, and says why", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const { page, deck } = await boot();

  await expect(deck.reviews()).toHaveCount(3, { timeout: 60_000 });

  // #44 is in `telemetry`, which `makeSandbox` never creates — `decorateReviews`
  // finds no checkout for it, so `localPath` is null.
  const cold = deck.reviewGo(44);
  await expect(cold).toHaveClass(/\bcold\b/);
  // Greyed but LIVE: still a `<button>`, still enabled — the host explains on
  // click rather than the row refusing it (ReviewStrip.tsx:13-19).
  await expect(cold).toBeEnabled();
  await expect(cold).toHaveAttribute(
    "title",
    "telemetry isn't checked out under your repos root — clicking will explain what to do",
  );
  // The accessible name stays the bare action either way: the caveat is a caveat,
  // not a different action.
  await expect(cold).toHaveAttribute("aria-label", "Review with Claude Code");

  // #41 is in `rocket`, which is checked out — same control, neither greyed nor
  // caveated. Asserted so the class above cannot be a constant.
  const warm = deck.reviewGo(41);
  await expect(warm).not.toHaveClass(/\bcold\b/);
  await expect(warm).toHaveAttribute("title", "Review with Claude Code");
  await shot(page, testInfo, "4 · #44 greyed, #41 not");
});

// Mutation-checked: forced ReviewStrip's play cell to the button branch regardless
// of `r.runKey` (src/webview/ReviewStrip.tsx:162), so a row under review still
// offered a second launch.
test("a row already being reviewed cannot be launched twice", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const { page, deck, windows } = await boot();

  await expect(deck.reviews()).toHaveCount(3, { timeout: 60_000 });

  // Launched from the LINE's play glyph, not the expanded row's labelled button:
  // clearing a queue is not supposed to mean opening every row to reach the action.
  await expect(deck.reviewGo(41)).toBeVisible();
  await deck.reviewGo(41).click();

  await expect.poll(() => worktrees(sb.repoPath), { timeout: 180_000 }).toContain("review-rocket-41");

  // The run record is what `decorateReviews` reads back onto the row, so the next
  // post flips the cell from a button to a loading mark. Same class, different
  // element: `.rv-go.busy` is a <span> (ReviewStrip.tsx:162-165), which is the
  // point — a dimmed play glyph would read as an action worth retrying, and a
  // retry here is a second paid session on one PR.
  await expect(deck.review(41).locator(".rv-go.busy")).toBeVisible({ timeout: 60_000 });
  await expect(deck.review(41)).toContainText("reviewing");
  await expect(deck.review(41).locator("button.rv-go")).toHaveCount(0);
  // The sibling rows keep theirs, so "no button" is this row's state and not the
  // strip having stopped rendering them.
  await expect(deck.review(42).locator("button.rv-go")).toHaveCount(1);

  // One worktree for one PR, however many times the cell was pressed. `git
  // worktree list` names it once.
  const listed = worktrees(sb.repoPath).split("\n").filter((l) => l.includes("review-rocket-41"));
  expect(listed).toHaveLength(1);
  await shot(page, testInfo, "5 · #41 under review");

  await waitForWindows(windows, 1, 120_000);
});

// Mutation-checked: removed `max-height`/`overflow-y` from `.rv-rows`
// (src/webview/deckStyles.ts:501-502), which let the list grow to its content and
// made scrollHeight equal clientHeight.
test("every row stays visible in a scrollable list", async ({}, testInfo) => {
  test.setTimeout(240_000);
  // Nine requests: the doc's own example of the queue that must stay a scroll
  // rather than being collapsed into a count. `rocket` is the only checkout, so
  // the rest are cold rows — irrelevant here, and deliberately not asserted on.
  const nine: ReviewReq[] = Array.from({ length: 9 }, (_, i) => ({
    number: 41 + i, repo: i === 0 ? "oznasi1/rocket" : `oznasi1/svc-${i}`,
    title: `Change number ${41 + i}`, author: "octo", branch: `fix/${41 + i}`,
    createdAt: `2026-0${1 + (i % 8)}-01T00:00:00Z`,
    additions: 200, deletions: 100, changedFiles: 8,
  }));
  const { page, deck } = await boot({}, ghAnswers(nine));

  await expect(deck.reviews()).toHaveCount(9, { timeout: 60_000 });

  // The row's own fields, read off one row rather than nine: repo, number, title,
  // author, age, the `+a −d` pair, the file count and the S/M/L bucket.
  const row = deck.review(45);
  await expect(row.locator(".rv-repo")).toHaveText("svc-4");
  await expect(row.locator(".rv-num")).toHaveText("#45");
  await expect(row.locator(".rv-title")).toHaveText("Change number 45");
  await expect(row.locator(".rv-author")).toHaveText("@octo");
  await expect(row.locator(".rv-age")).toHaveText(/^\d+d$/);
  await expect(row.locator(".rv-diff .add")).toHaveText("+200");
  await expect(row.locator(".rv-diff .del")).toHaveText("−100");
  await expect(row.locator(".rv-files")).toHaveText("8 files");
  // 300 lines changed → M (sizeBucket, src/engine/review/sort.ts:11-15).
  await expect(row.locator(".rv-size")).toHaveText("M");

  // Bounded, not hidden: the list owns a nested scroller, so all nine rows are in
  // the DOM and reachable while the board keeps its share of the window.
  const box = await deck.reviewList().evaluate((el) => ({
    scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
    overflowY: getComputedStyle(el).overflowY,
  }));
  expect(box.overflowY).toBe("auto");
  expect(box.scrollHeight).toBeGreaterThan(box.clientHeight);
  await shot(page, testInfo, "6 · nine rows in a capped scroller");
});

// Mutation-checked: made GhReviewProvider.detail return `failing: []`
// (src/engine/review/provider.ts:63), so the failed check's name never reached the row.
test("expanding a row fetches failed checks and open threads", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const { page, deck } = await boot(
    {},
    // `pr view` carries the rollup the checks line reads; the thread count comes
    // from a separate `api graphql` that shares the search's signature, so it is
    // folded into the same body.
    ghAnswers(REQS, { unresolved: 2, prView: ghPrViewAnswer({ number: 41, failing: ["lint"], passing: 1 }) }),
  );

  await expect(deck.reviews()).toHaveCount(3, { timeout: 60_000 });
  await deck.expandReview(41);

  const facts = deck.review(41).locator(".rv-facts");
  // The two things the cross-repo search cannot answer, both fetched on expand.
  await expect(facts).toContainText("lint", { timeout: 60_000 });
  await expect(facts).toContainText("2 open");
  // Alongside the decision and mergeability, which come off the row's own
  // search-level facts and render whether the detail call has landed or not.
  await expect(facts).toContainText("review required");
  await expect(facts).toContainText("clean");
  await shot(page, testInfo, "7 · lint failing, two threads open");
});

// Mutation-checked: made resolveReviewMode fall back to `modes[0]`
// (src/engine/review/launch.ts:35) instead of null, so the launch never asked.
test("a custom review mode makes the launch ask which to seed", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const { page, deck } = await boot({
    // `resolveModes` layers a user entry OVER the built-ins rather than replacing
    // them (src/config.ts:638), so the picker offers two.
    "agentFlow.reviewRequestModes": [
      { id: "quick", label: "Quick look", prompt: "Skim {repo}#{number} by {author} for anything obvious." },
    ],
    "agentFlow.reviewRequestMode": "ask",
  });

  await expect(deck.reviews()).toHaveCount(3, { timeout: 60_000 });
  await deck.reviewGo(41).click();

  // The QuickPick is workbench chrome on the top-level page, outside every
  // `iframe.webview`.
  const picker = page.locator(".quick-input-widget");
  await expect(picker).toBeVisible({ timeout: 60_000 });
  await expect(picker).toContainText("Review rocket#41");
  await expect(picker).toContainText("Quick look");
  await expect(picker).toContainText("Full review");

  // Escaped before `createWorktrees` runs — the mode question is raised first for
  // exactly this reason, so a dismissal leaves no worktree and no branch behind.
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden({ timeout: 30_000 });
  expect(worktrees(sb.repoPath)).not.toContain("review-rocket-41");
  await shot(page, testInfo, "8 · two review modes offered");
});

// Mutation-checked: dropped `this.reviewQueue` from reviewsEnabled
// (src/deckView.ts:2409), so the strip came up with the setting off.
test("reviewRequests off hides the strip", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const { page, deck } = await boot({ "agentFlow.reviewRequests": false });

  // The board itself is up — otherwise "no strip" would just be "nothing has
  // rendered yet". `.stats` is the header's own sync line (DeckApp.tsx:1216-1222).
  await expect(deck.frame.locator(".stats")).toBeVisible({ timeout: 60_000 });

  // The forge probe has RUN — `forgeReady()` returns false until `forge.probe()`
  // settles (deckView.ts:2058-2063), and `gh auth status` is that probe
  // (`probeGh`, src/engine/pr/provider.ts:108-117). Without waiting for it,
  // "no strip" would be indistinguishable from "the probe has not come back
  // yet", and this test would pass against a product with no gate at all —
  // which is exactly what a first pass of it did.
  await expect
    .poll(() => forgeCalls(sb).filter((c) => c.cli === "gh" && c.argv[0] === "auth").length, { timeout: 60_000 })
    .toBeGreaterThan(0);
  // Two full board passes (one every 6s) after the probe settled. A hold rather
  // than a poll because the claim is an absence; the live flip below is what
  // makes the hold meaningful — it proves the queue, the CLI and the search were
  // all in place the whole time, so nothing but the setting was withholding them.
  await page.waitForTimeout(15_000);
  await expect(deck.reviewStrip()).toHaveCount(0);
  await expect(deck.reviews()).toHaveCount(0);
  // A read gate, not just a render one: with the setting off the search is never
  // queued, so no `gh api graphql` is spent on it.
  expect(searchQueries()).toHaveLength(0);
  await shot(page, testInfo, "9 · no strip, no search");

  // The control. Flipped the way a person does it, by saving settings.json: the
  // workbench raises `onDidChangeConfiguration` and `DeckPanel.onConfigChanged`
  // re-seeds `reviewQueue` (deckView.ts:3969). The panel is never reopened.
  const settingsPath = path.join(sb.userDataDir, "User", "settings.json");
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  settings["agentFlow.reviewRequests"] = true;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  await expect(deck.reviews()).toHaveCount(3, { timeout: 60_000 });
  expect(searchQueries()).toHaveLength(1);
  await shot(page, testInfo, "10 · flipped back on, the same panel");
});
