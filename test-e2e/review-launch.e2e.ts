import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { makeSandbox, type Sandbox } from "./_helpers/sandbox";
import { launchHost } from "./_helpers/host";
import { Deck } from "./_helpers/po/deck";
import { ghReviewRequestsAnswer, installForgeShims, expectNoUnknownForgeCalls } from "./_helpers/forgeShim";
import { shot } from "./_helpers/shot";

let sb: Sandbox;
let app: ElectronApplication | undefined;

const REQS = [
  { number: 41, repo: "oznasi1/rocket", title: "Fix the rocket telemetry panel", author: "octo", branch: "fix/telemetry" },
  { number: 42, repo: "oznasi1/rocket", title: "Refit the rocket landing gear", author: "octo", branch: "fix/gear" },
];

test.beforeEach(() => {
  // reviewRequestMode "full" names a real shipped mode, so resolveReviewMode
  // skips the picker — the journey drives the flow, not a QuickPick.
  sb = makeSandbox({
    "agentFlow.forge": "github",
    "agentFlow.reviewRequests": true,
    "agentFlow.reviewRequestMode": "full",
    "agentFlow.reviewOpenIn": "new-window",
  });
  installForgeShims(sb, {
    gh: {
      "api graphql": ghReviewRequestsAnswer(REQS),
      // launchReview's worktree/window setup checks forge auth along the way
      // (as deck-github.e2e.ts's shim also answers) — an empty OK response is
      // all either launch path needs from it.
      "auth status": "{}",
      // Expanding a row (deck:reviewExpand → GhReviewProvider.detail) shells
      // `pr view <n> --repo <repo> --json statusCheckRollup` for the checks
      // line — a different signature than the search's `api graphql`. Empty
      // rollup reads as "no checks", which mapRollup renders as passing.
      "pr view": JSON.stringify({ statusCheckRollup: [] }),
    },
  });
});

test.afterEach(async () => {
  await app?.close();
  app = undefined;
  try {
    expectNoUnknownForgeCalls(sb);
  } finally {
    sb.dispose();
  }
});

/** Every worktree git itself knows about in the fixture repo. Asserting from
 *  `git worktree list` rather than from a directory existing is the difference
 *  between "a folder was created" and "a worktree was registered". */
function worktrees(repoPath: string): string {
  return execFileSync("git", ["worktree", "list"], { cwd: repoPath, encoding: "utf8" });
}

/** A review launch (`reviewOpenIn: "new-window"`) opens a REAL second Electron
 *  window on the worktree, same as a task take does. That window's own boot is
 *  asynchronous and NOT awaited by anything this journey's filesystem polls
 *  touch — the run record and plan file land before the window has even
 *  finished activating. Left unawaited, `electronApplication.close()` in
 *  `afterEach` hangs indefinitely waiting on a window still mid-activation: a
 *  first pass at this journey timed out with no assertion error at all, and
 *  the trace showed the test body had already finished — only
 *  `electronApplication.close` never returned. Collecting every `window`
 *  event from launch onward (rather than a one-shot `waitForEvent`, which can
 *  only ever catch one window and races a second) and waiting for each one's
 *  `.activitybar` before the test ends is what makes the close clean. */
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

test("launching a review opens its worktree, brief and plan handshake", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const launched = await launchHost(sb);
  app = launched.app;
  const windows = collectWindows(app);
  const deck = await Deck.open(launched.page);

  await expect(deck.review(41)).toBeVisible({ timeout: 60_000 });
  await expect(deck.review(41)).toContainText("octo");
  await shot(launched.page, testInfo, "1 · review rail");

  // A collapsed row has no launch button at all (ReviewStrip.tsx:181 gates the
  // whole `.rv-actions` block behind `expanded && !selecting`) — expand first.
  await deck.expandReview(41);
  await deck.reviewLaunch(41).click();

  // reviewRunKey("rocket", 41) → "review-rocket-41": the run key AND the
  // worktree directory name. Never a Jira key, never mistaken for one.
  await expect.poll(() => worktrees(sb.repoPath), { timeout: 120_000 }).toContain("review-rocket-41");

  const wt = path.join(sb.repoPath, ".claude", "worktrees", "review-rocket-41");
  await expect.poll(() => fs.existsSync(path.join(wt, ".pick-task"))).toBe(true);

  const runFile = path.join(sb.home, ".agentflow", "runs", "review-rocket-41.json");
  await expect.poll(() => fs.existsSync(runFile), { timeout: 60_000 }).toBe(true);
  const run = JSON.parse(fs.readFileSync(runFile, "utf8")) as { kind?: string; url: string };
  expect(run.kind).toBe("review");
  expect(run.url).toContain("/pull/41");

  // The plan handshake carries the review-rendered template: {repo}, {number}
  // and {author} are substituted before the shared renderer ever sees it.
  // launchReview independently sets ticket.key to "review-rocket-41", its
  // summary to "Review oznasi1/rocket#41: …" and the planMd heading to the
  // same — all built straight from req.repoName/req.number, with no template
  // substitution involved. So asserting the plan merely CONTAINS
  // "oznasi1/rocket" or "41" would pass even if renderReviewTemplate did
  // nothing at all to the template body. Assert instead on text that exists
  // ONLY in the template's own wording, combined with the substituted value:
  // the `gh pr checkout` line proves {repo} and {number} landed together
  // inside template text, and "by octo" proves {author} did too.
  const plansDir = path.join(sb.home, ".agentflow", "plans");
  await expect.poll(() => (fs.existsSync(plansDir) ? fs.readdirSync(plansDir) : []), { timeout: 60_000 })
    .not.toHaveLength(0);
  const plan = fs.readdirSync(plansDir).map((f) => fs.readFileSync(path.join(plansDir, f), "utf8")).join("\n");
  expect(plan).toContain("gh pr checkout 41 --repo oznasi1/rocket");
  expect(plan).toContain("by octo");
  expect(plan).not.toContain("{repo}");
  expect(plan).not.toContain("{number}");
  expect(plan).not.toContain("{author}");
  await shot(launched.page, testInfo, "2 · review launched");

  // Let the review's own new window finish booting before the test ends and
  // `afterEach` closes the app — see `waitForWindows`'s doc comment.
  await waitForWindows(windows, 1, 90_000);
});

test("a batch review launches one worktree and one run record per PR", async ({}, testInfo) => {
  test.setTimeout(360_000);
  const launched = await launchHost(sb);
  app = launched.app;
  const windows = collectWindows(app);
  const deck = await Deck.open(launched.page);

  await expect(deck.reviews()).toHaveCount(2, { timeout: 60_000 });

  // There is no checkbox (ReviewStrip.tsx has none): selection is a MODE.
  // The header's "select" button (ReviewStrip.tsx:332) turns it on; while
  // selecting, clicking a row's `.rv-line` (the row's own header button,
  // ReviewStrip.tsx:111-119) TOGGLES its pick instead of expanding it
  // (ReviewStrip.tsx:114), and `aria-pressed` reflects the picked state
  // (ReviewStrip.tsx:115). Enter select mode BEFORE touching any row, so no
  // row is ever expanded while picking — DeckApp.tsx's own onSelectMode
  // handler defensively clears `expanded` on entry, but the journey doesn't
  // lean on that: it never expands a row in this test at all.
  await deck.frame.getByRole("button", { name: "select", exact: true }).click();

  const row41 = deck.review(41).locator(".rv-line");
  const row42 = deck.review(42).locator(".rv-line");
  await row41.click();
  await expect(row41).toHaveAttribute("aria-pressed", "true");
  await row42.click();
  await expect(row42).toHaveAttribute("aria-pressed", "true");

  await expect(deck.batchBar()).toContainText("2");
  await shot(launched.page, testInfo, "3 · two reviews selected");

  await deck.batchLaunch().click();

  // Two PRs and `reviewOpenIn: "new-window"` means `chooseOpenTarget` resolves
  // to `{ kind: "new" }` with no picker (deckView.ts's `launchReviewBatch` step
  // 4), but step 5's LAYOUT question — separate windows vs. one shared window —
  // only skips when there is exactly one item. With two, it always asks. Pick
  // "Separate windows" (first item, pre-highlighted): it is the plain N-times
  // repeat of the single-launch path already proven above, one worktree and
  // one window per PR.
  await launched.page.locator(".quick-input-widget").waitFor({ timeout: 15_000 });
  await launched.page.keyboard.press("Enter");

  // Separate windows launches each PR's review fully — worktree, run record
  // AND the new window's openWorkspace — before the next one starts
  // (launchReviewBatch's `for (const item of items)` awaits `launchReview` in
  // full each iteration), so #42's worktree does not exist the instant #41's
  // does. Poll both rather than asserting the second synchronously right
  // after the first resolves.
  await expect.poll(() => worktrees(sb.repoPath), { timeout: 180_000 }).toContain("review-rocket-41");
  await expect.poll(() => worktrees(sb.repoPath), { timeout: 120_000 }).toContain("review-rocket-42");

  const runs = path.join(sb.home, ".agentflow", "runs");
  await expect.poll(() => fs.readdirSync(runs).filter((f) => f.startsWith("review-rocket-")), { timeout: 60_000 })
    .toHaveLength(2);
  await shot(launched.page, testInfo, "4 · batch launched");

  // Both PRs' own new windows, fully booted before `afterEach` closes the app
  // — see `waitForWindows`'s doc comment on the single-launch test.
  await waitForWindows(windows, 2, 120_000);
});
