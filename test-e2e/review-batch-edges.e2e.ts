import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { makeSandbox, type Sandbox } from "./_helpers/sandbox";
import { launchHost } from "./_helpers/host";
import { Deck } from "./_helpers/po/deck";
import {
  expectNoUnknownForgeCalls, ghReviewRequestsAnswer, installForgeShims,
  type ForgeAnswers, type ReviewReq,
} from "./_helpers/forgeShim";
import { shot } from "./_helpers/shot";

let sb: Sandbox;
let app: ElectronApplication | undefined;

/** Two PRs in `rocket` — the one checkout `makeSandbox` creates — so both resolve a
 *  `localPath` and neither is skipped. `createdAt` ascending by number, because the
 *  strip opens on the `oldest` sort (deckView.ts:450) and the range test below reads
 *  rows by position: #41 first, #42 second, #43 third. */
const REQ = (n: number, o: { repo?: string; month?: number } = {}): ReviewReq => ({
  number: n,
  repo: `oznasi1/${o.repo ?? "rocket"}`,
  title: `Change number ${n}`,
  author: "octo",
  branch: `fix/${n}`,
  createdAt: `2026-0${o.month ?? n - 40}-01T00:00:00Z`,
  additions: 30, deletions: 10, changedFiles: 2,
});

const TWO = [REQ(41), REQ(42)];

/** The two gh verbs this file's queue reaches for. `api graphql` is the review
 *  search; `auth status` is the forge probe every launch path re-checks
 *  (`probeGh`, src/engine/pr/provider.ts:108-117). No `pr view`: no test here
 *  expands a row — selection mode hides `.rv-detail` outright
 *  (ReviewStrip.tsx:181), which is the whole point of the batch.
 *
 *  No `pr list` either, deliberately: the fixture repo has no remote, so
 *  `defaultBranch` reads `""` and `prEligible` (src/engine/git.ts:205-209) refuses
 *  every repo of every run this file creates — the Deck never fetches PR facts for
 *  them. If that ever changes, `expectNoUnknownForgeCalls` will say so rather than
 *  a pre-canned `[]` hiding it. */
function ghAnswers(reqs: ReviewReq[]): ForgeAnswers {
  return { gh: { "api graphql": ghReviewRequestsAnswer(reqs), "auth status": "{}" } };
}

/** One host per test: every row pins a different setting, and a batch launch leaves
 *  worktrees, run records and windows the next test must not inherit. Settings land
 *  on top of the sandbox contract, which already pre-answers every mid-launch prompt.
 *
 *  `window.dialogStyle: "custom"` renders the batch's modal cost-confirm as
 *  workbench DOM (`.monaco-dialog-box`) on the top-level page instead of a native
 *  macOS sheet Playwright's Electron driver cannot click — same reason
 *  `deck-merge.e2e.ts` and `review-writes.e2e.ts` set it. */
async function boot(
  settings: Record<string, unknown> = {},
  reqs: ReviewReq[] = TWO,
): Promise<{ page: Page; deck: Deck; windows: Page[] }> {
  sb = makeSandbox({
    "agentFlow.forge": "github",
    "agentFlow.reviewRequests": true,
    "agentFlow.reviewOpenIn": "new-window",
    "window.dialogStyle": "custom",
    ...settings,
  });
  installForgeShims(sb, ghAnswers(reqs));
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
 *  between "a folder was created" and "a worktree was registered". The ★ test's
 *  assertion of record reads this for an ABSENCE, which is only honest beside the
 *  positive facts it asserts in the same breath (two run records, two briefs, two
 *  plan files): the launch demonstrably ran, and cut nothing. */
function worktrees(repoPath: string): string {
  return execFileSync("git", ["worktree", "list"], { cwd: repoPath, encoding: "utf8" });
}

/** A review launch opens REAL extra Electron windows, whose boot nothing this
 *  journey polls ever awaits — left unawaited, `electronApplication.close()` in
 *  `afterEach` hangs on a window still mid-activation. Collected from launch onward
 *  (not a one-shot `waitForEvent`, which races a second window) and awaited before
 *  the test ends; `review-launch.e2e.ts` documents the pair at length. */
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

/** Wait until the queue has really landed, then assert its size.
 *
 *  `Deck.reviews()` counts `.rv-row`, and the LOADING SKELETON renders exactly three
 *  of those (ReviewStrip.tsx:274-291) with no `.rv-num` — so a bare `toHaveCount(3)`
 *  is satisfied by a strip that is still shimmering, and every assertion after it
 *  races the search instead of following it. Waiting on a NUMBERED row first is what
 *  tells the two apart; copied from `review-strip.e2e.ts`, which was caught by it. */
async function expectQueue(deck: Deck, first: number, count: number): Promise<void> {
  await expect(deck.review(first)).toBeVisible({ timeout: 60_000 });
  await expect(deck.reviews()).toHaveCount(count);
}

/** Enter selection mode and pick rows by number, the way a person does: the header's
 *  `select` button, then each row's own `.rv-line`. Selection is a MODE, not a
 *  checkbox column (`ReviewStrip.tsx` has no `<input>`): while selecting, clicking
 *  `.rv-line` toggles the pick instead of expanding the row (ReviewStrip.tsx:114)
 *  and `aria-pressed` reflects it (ReviewStrip.tsx:115). Mode first, then rows, so
 *  no row is ever expanded while picking. */
async function pick(deck: Deck, numbers: number[]): Promise<void> {
  await deck.reviewSelectMode().click();
  for (const n of numbers) {
    const line = deck.reviewLine(n);
    await line.click();
    await expect(line).toHaveAttribute("aria-pressed", "true");
  }
}

/** The workbench QuickPick — top-level page chrome, never inside the webview. */
function quickPick(page: Page): { widget: Locator; rows: Locator; row: (t: string) => Locator } {
  const widget = page.locator(".quick-input-widget");
  const rows = widget.locator(".quick-input-list .monaco-list-row");
  return { widget, rows, row: (t) => rows.filter({ hasText: t }) };
}

/** The batch's layout question, answered "One shared window" — the second item, so
 *  it is clicked by name rather than by Enter on the pre-highlighted first
 *  ("Separate windows", which `review-launch.e2e.ts` already drives). Only raised
 *  when the destination is a new window AND there is more than one PR
 *  (deckView.ts's step 5). */
async function chooseSharedWindow(page: Page): Promise<void> {
  const qp = quickPick(page);
  await expect(qp.widget).toBeVisible({ timeout: 60_000 });
  await expect(qp.widget).toContainText("how should I lay them out?");
  await qp.row("One shared window").click();
  await expect(qp.widget).toBeHidden({ timeout: 30_000 });
}

const runsDir = (): string => path.join(sb.home, ".agentflow", "runs");

function reviewRuns(): string[] {
  const dir = runsDir();
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith("review-")).sort() : [];
}

function readRun(key: string): { kind?: string; mode?: string; workspaceFile?: string; repos: { name: string; path: string }[] } {
  return JSON.parse(fs.readFileSync(path.join(runsDir(), `${key}.json`), "utf8"));
}

/** Every plan file's text, joined. The plan handshake is what the target window's
 *  seed consumes, so the prompt a batch actually seeded is recorded here and nowhere
 *  else. */
function plans(): string {
  const dir = path.join(sb.home, ".agentflow", "plans");
  if (!fs.existsSync(dir)) return "";
  return fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
}

// Mutation-checked: made `needsWorktrees` return `true` unconditionally
// (src/engine/review/batch.ts), so the read-only batch cut a worktree per PR anyway
// — `review-rocket-41` appeared in `git worktree list` and this failed. That break is
// sabotage/review-batch-edges.patch.
test("a read-only batch review checks nothing out", async ({}, testInfo) => {
  test.setTimeout(360_000);
  // `reviewRequestMode: "ask"` matches no mode id, and the batch's list always holds
  // at least two (read-only plus the stock Full review), so `resolveReviewMode`
  // returns null and the mode question is really asked — which is the only place
  // read-only is offered at all.
  const { page, deck, windows } = await boot({ "agentFlow.reviewRequestMode": "ask" });

  await expectQueue(deck, 41, 2);
  await pick(deck, [41, 42]);
  await expect(deck.batchBar()).toContainText("2 selected");
  await shot(page, testInfo, "1 · two PRs picked");

  await deck.batchLaunch().click();

  // The mode question, once for the batch. Read-only is FIRST and the stock mode
  // second (`batchReviewModes`, src/engine/review/batch.ts) — exactly two rows, so
  // the doc's "the batch offers a read-only review" is a list of two, not a list
  // that happens to contain one.
  const qp = quickPick(page);
  await expect(qp.widget).toBeVisible({ timeout: 60_000 });
  await expect(qp.widget).toContainText("Review 2 PRs with sessions");
  await expect(qp.rows).toHaveCount(2);
  await expect(qp.row("Read-only review")).toBeVisible();
  await expect(qp.row("Full review")).toBeVisible();
  await shot(page, testInfo, "2 · read-only offered by the batch");
  await qp.row("Read-only review").click();

  // Read-only's saving is several reviews sharing ONE checkout, so the layout has to
  // be the shared window for the claim to mean anything.
  await chooseSharedWindow(page);

  // The positive half, first: the launch really ran. Two run records under the same
  // keys a single review launch writes, and — the fact that carries the claim — each
  // one's repo is the CHECKOUT ITSELF, not a worktree under it.
  await expect.poll(() => reviewRuns(), { timeout: 180_000 })
    .toEqual(["review-rocket-41.json", "review-rocket-42.json"]);
  for (const n of [41, 42]) {
    const run = readRun(`review-rocket-${n}`);
    expect(run.kind).toBe("review");
    expect(run.repos).toHaveLength(1);
    expect(run.repos[0].path).toBe(sb.repoPath);
  }

  // Two briefs in that one checkout, under `REVIEW-<n>` subdirs — which is what keeps
  // two reviews sharing a tree from overwriting each other's brief.
  for (const n of [41, 42]) {
    expect(fs.existsSync(path.join(sb.repoPath, ".pick-task", `REVIEW-${n}`, "TASK.md"))).toBe(true);
  }

  // The seeded prompt is the read-only one, and it is per-PR rendered: the fetch line
  // names each PR's own number, which no substitution-free template could.
  const seeded = plans();
  expect(seeded).toContain("Do NOT check the branch out");
  expect(seeded).toContain("git fetch origin pull/41/head");
  expect(seeded).toContain("git fetch origin pull/42/head");

  // And the negative half, now that the above proves there was something to check
  // out: git knows about exactly ONE worktree in this repo — the checkout — and none
  // of the `review-rocket-*` ones a checkout mode would have cut.
  const listed = worktrees(sb.repoPath).trim().split("\n").filter((l) => l !== "");
  expect(listed).toHaveLength(1);
  expect(listed[0]).toContain(sb.repoPath);
  expect(worktrees(sb.repoPath)).not.toContain("review-rocket");
  expect(fs.existsSync(path.join(sb.repoPath, ".claude", "worktrees"))).toBe(false);
  await shot(page, testInfo, "3 · two read-only reviews, no worktree");

  // The one window the shared layout opens, fully booted before `afterEach` closes
  // the app — see `waitForWindows`.
  await waitForWindows(windows, 1, 120_000);
});

// Mutation-checked: deleted the `if (shift && anchor && …)` range branch from
// DeckApp.tsx's `onToggle` (src/webview/DeckApp.tsx:1285-1289), leaving the plain
// toggle — the shift-click picked only #43 and the bar read "2 selected".
test("shift-click selects a range of rows", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const { page, deck } = await boot({ "agentFlow.reviewRequestMode": "full" }, [REQ(41), REQ(42), REQ(43)]);

  await expectQueue(deck, 41, 3);
  // Oldest first is the shipped default, so the rows are in number order and the
  // range drawn below is #41 → #43 with #42 in the middle — never a neighbour pair,
  // which a plain toggle could also have produced.
  await expect(deck.reviewNumbers()).toHaveText(["#41", "#42", "#43"]);

  await deck.reviewSelectMode().click();
  // Selecting turns the caret into a checkbox — the row's own `.rv-chk`
  // (ReviewStrip.tsx:122 on 2026-09-04), which does not exist outside the mode.
  // Asserted as ATTACHED, not visible: an unpicked box holds no text and no `on`
  // class, so it has zero size and Playwright calls it hidden.
  await expect(deck.review(41).locator(".rv-chk")).toBeAttached();
  await expect(deck.review(41).locator(".rv-caret")).toHaveCount(0);

  await deck.reviewLine(41).click();
  await expect(deck.batchBar()).toContainText("1 selected");
  await shot(page, testInfo, "4 · one row picked, the anchor");

  // The whole span between the anchor and this row, in QUEUE order — #42 was never
  // clicked at all.
  await deck.reviewLine(43).click({ modifiers: ["Shift"] });

  for (const n of [41, 42, 43]) {
    await expect(deck.reviewLine(n)).toHaveAttribute("aria-pressed", "true");
    await expect(deck.review(n).locator(".rv-chk")).toHaveClass(/\bon\b/);
  }
  await expect(deck.batchBar()).toContainText("3 selected");
  // The bar's own count and the launch button agree — the button is what spends the
  // sessions, so a count that only lived in the label would be the one to trust.
  await expect(deck.batchLaunch()).toContainText("Review 3");
  await shot(page, testInfo, "5 · the range #41–#43");
});

// Mutation-checked: changed the cost gate to `if (requests.length > 1000)`
// (src/deckView.ts:2783), so a 2-PR batch launched unconfirmed — the dialog never
// appeared and this failed on it.
test("a batch over the threshold names its cost in sessions", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const { page, deck } = await boot({
    "agentFlow.reviewRequestMode": "full",
    // One, so two PRs are already "over" it. The shipped default is 6.
    "agentFlow.batchLaunchConfirmThreshold": 1,
  });

  await expectQueue(deck, 41, 2);
  await pick(deck, [41, 42]);
  await deck.batchLaunch().click();

  // Modal workbench DOM on the top-level page, outside every `iframe.webview`. It
  // names the cost in SESSIONS rather than worktrees — the mode has not been picked
  // yet at this point, so whether anything gets checked out is still unknown, but a
  // session per PR is true either way.
  const box = page.locator(".monaco-dialog-box");
  await expect(box).toBeVisible({ timeout: 60_000 });
  await expect(box).toContainText("Review 2 PRs with sessions? That's 2 sessions.");
  await shot(page, testInfo, "6 · the cost, before anything is created");

  // Confirm FIRST means nothing has been created yet — the mode question has not even
  // been asked, so declining leaves no worktree, no run record and no window.
  await box.getByRole("button", { name: "Cancel" }).click();
  await expect(box).toBeHidden({ timeout: 30_000 });
  await expect(quickPick(page).widget).toBeHidden();
  // Two full board passes (one every 6s) after the decline: an absence asserted as a
  // hold, with the launch path demonstrably reachable — the same click confirmed
  // would have run it.
  await page.waitForTimeout(15_000);
  expect(reviewRuns()).toEqual([]);
  expect(worktrees(sb.repoPath)).not.toContain("review-rocket");
  await shot(page, testInfo, "7 · declined, nothing created");
});

// Mutation-checked: dropped `planReviewBatch`'s `if (!skipped.includes(r.repoName))`
// guard (src/engine/review/batch.ts), so the repo was named once per PR — the toast
// read "telemetry, telemetry isn't checked out" and this failed on the single-name
// assertion.
test("PRs in a repo you have not checked out are named once and skipped", async ({}, testInfo) => {
  test.setTimeout(360_000);
  // TWO PRs in `telemetry`, which `makeSandbox` never creates. One would satisfy
  // "once" by accident; two is what makes "once per repo, not once per PR" the claim
  // under test. #41 is in `rocket` and launches, so the rest of the gesture is proven
  // to have run.
  const { page, deck, windows } = await boot({ "agentFlow.reviewRequestMode": "full" }, [
    REQ(41),
    REQ(44, { repo: "telemetry", month: 4 }),
    REQ(45, { repo: "telemetry", month: 5 }),
  ]);

  await expectQueue(deck, 41, 3);
  await pick(deck, [41, 44, 45]);
  await expect(deck.batchBar()).toContainText("3 selected");
  await shot(page, testInfo, "8 · one warm PR and two cold ones picked");

  await deck.batchLaunch().click();

  // One reviewable PR is an ordinary single launch: no layout question (that only
  // comes up above one item), so the next thing to happen is the worktree.
  await expect(quickPick(page).widget).toBeHidden();

  // The Deck's own toast, in its webview (`this.toast`, deckView.ts:693-695) — the
  // one place the skip is reported. `toHaveText`, not `toContainText`: the claim is
  // that `telemetry` is named ONCE, which a containment check could not tell from
  // "telemetry, telemetry".
  await expect(deck.toast("success")).toHaveText(
    "Reviewing 1 PR in a worktree each. telemetry isn't checked out — skipped.",
    { timeout: 90_000 },
  );
  await shot(page, testInfo, "9 · the skip, named once");

  // "the rest launch": the warm PR got its worktree and its run record, and the cold
  // ones got neither.
  await expect.poll(() => reviewRuns(), { timeout: 60_000 }).toEqual(["review-rocket-41.json"]);
  const listed = worktrees(sb.repoPath).split("\n").filter((l) => l.includes("review-"));
  expect(listed).toHaveLength(1);
  expect(listed[0]).toContain("review-rocket-41");

  await waitForWindows(windows, 1, 120_000);
});

// Mutation-checked: replaced `shared = p.shared` with `shared = false`
// (src/deckView.ts:2871), so picking "One shared window" ran the separate-windows
// path — no `.code-workspace` was written and this failed on it.
test("a shared-window batch review opens one window", async ({}, testInfo) => {
  test.setTimeout(360_000);
  // The stock Full review mode, pinned: it checks the branch out, so this is the
  // shared window WITH worktrees — the layout question and the mode question are
  // independent, and the ★ test above already covers the read-only pairing.
  const { page, deck, windows } = await boot({ "agentFlow.reviewRequestMode": "full" });

  await expectQueue(deck, 41, 2);
  await pick(deck, [41, 42]);
  await deck.batchLaunch().click();

  // No mode question (pinned) and no destination question (`reviewOpenIn` is
  // `new-window`), so the layout question is the only one — and it is asked, because
  // a new window with more than one PR can go either way.
  await chooseSharedWindow(page);
  await shot(page, testInfo, "10 · one shared window chosen");

  // The durable record of "one window": both runs name the SAME `.code-workspace`,
  // and their mode is `multiroot` — a window per PR would have written neither.
  await expect.poll(() => reviewRuns(), { timeout: 180_000 })
    .toEqual(["review-rocket-41.json", "review-rocket-42.json"]);
  const first = readRun("review-rocket-41");
  const second = readRun("review-rocket-42");
  expect(first.mode).toBe("multiroot");
  expect(second.mode).toBe("multiroot");
  expect(first.workspaceFile).toBeTruthy();
  expect(second.workspaceFile).toBe(first.workspaceFile);

  // A session each: the workspace declares one folder per PR, and each is that PR's
  // own worktree — the checkout mode's half of the layout question.
  const ws = JSON.parse(fs.readFileSync(first.workspaceFile as string, "utf8")) as { folders: { path: string }[] };
  expect(ws.folders).toHaveLength(2);
  expect(ws.folders.map((f) => path.basename(f.path)).sort()).toEqual(["review-rocket-41", "review-rocket-42"]);

  // And one real window, not two. Awaited first (so the count below is not just "the
  // second one has not opened yet"), then held for two board passes.
  await waitForWindows(windows, 1, 120_000);
  await page.waitForTimeout(15_000);
  expect(windows).toHaveLength(1);
  await shot(page, testInfo, "11 · two reviews in one window");
});
