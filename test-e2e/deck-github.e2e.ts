import { test, expect } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";
import { execFileSync } from "child_process";
import * as fs from "fs";
import { makeSandbox, FIXTURE_TASK, type Sandbox } from "./_helpers/sandbox";
import { launchHost, openTasksView, tasksFrame } from "./_helpers/host";
import { installForgeShims, ghPrListAnswer, expectNoUnknownForgeCalls } from "./_helpers/forgeShim";
import { shot } from "./_helpers/shot";

let sb: Sandbox;
let app: ElectronApplication | undefined;
let unknownLog: string;

// The branch a take's worktree lands on: <KEY>-<slug> (engine/worktree.ts).
// Note: branch FILTERING is delegated to gh itself (--head); the provider
// trusts the answer as-is, so the shim's headRefName is decorative. The
// vacuousness check for this journey is therefore an empty answer, which
// must blank the PR block — verified, not assumed.
const BRANCH = "E2E-1-fix-the-rocket-telemetry-panel";

test.beforeEach(() => {
  sb = makeSandbox({ "agentFlow.worktree": "always", "agentFlow.prFacts": true });
  // Two git facts the PR block depends on, fabricated locally (the URL is
  // never contacted — every gh call resolves to the shim):
  //  - a remote, which the forge reads the project from (deckView.ts:1716);
  //  - origin/HEAD, which defaultBranch() derives from — prEligible() only
  //    fetches for a branch that DIFFERS from the default, and a repo whose
  //    default cannot be resolved is treated as having no PRs at all.
  execFileSync("git", ["remote", "add", "origin", "https://github.com/oznasi1/rocket.git"], { cwd: sb.repoPath });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sb.repoPath, encoding: "utf8" }).trim();
  execFileSync("git", ["update-ref", "refs/remotes/origin/main", sha], { cwd: sb.repoPath });
  execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], { cwd: sb.repoPath });
  ({ unknownLog } = installForgeShims(sb, {
    gh: {
      "pr list": ghPrListAnswer(BRANCH),
      "auth status": "{}",
      // The review queue's search and the per-PR threads query share this
      // signature; an empty search result serves both harmlessly here.
      "api graphql": JSON.stringify({ data: { search: { issueCount: 0, nodes: [] } } }),
    },
  }));
});
test.afterEach(async () => {
  await app?.close();
  app = undefined;
  // Self-discovery: any forge call the shim did not recognize is named here,
  // so a red run says what else to fake instead of failing cryptically.
  if (fs.existsSync(unknownLog)) console.log("FORGE UNKNOWN ARGV:\n" + fs.readFileSync(unknownLog, "utf8"));
  const calls = unknownLog.replace("unknown.jsonl", "calls.jsonl");
  if (fs.existsSync(calls)) console.log("FORGE CALLS:\n" + fs.readFileSync(calls, "utf8"));
  else console.log("FORGE CALLS: none");
  expectNoUnknownForgeCalls(sb);
  sb.dispose();
});

/** The Deck's PR block, fed by the shimmed gh: after a worktree take, the run's
 *  card shows the open PR the forge reports for its branch. First real-host
 *  coverage of the Deck surface. */
test("the Deck card shows the PR the GitHub forge reports for the run's branch", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;

  // A take first — the Deck shows runs, and a run exists once a task is taken.
  await openTasksView(page);
  const frame = tasksFrame(page);
  const card = frame.locator(".card", { hasText: FIXTURE_TASK.key });
  await card.waitFor({ timeout: 30_000 });
  await card.locator("button.take").click();
  await page.locator(".quick-input-widget").waitFor({ timeout: 15_000 });
  const newWindow = app.waitForEvent("window", { timeout: 60_000 });
  await page.keyboard.press("Enter");
  await (await newWindow).locator(".activitybar").waitFor({ timeout: 60_000 });

  // Open the Deck in the FIRST window.
  await page.keyboard.press("F1");
  await page.keyboard.type("Open the Deck");
  await page.keyboard.press("Enter");

  // The Deck's frame, found by CONTENT: the window now holds two of our
  // webviews, both containing "E2E-1", and the workbench parks their iframes
  // in an overlay container outside the .part DOM — so neither structure nor
  // order can disambiguate. Only the Deck renders the .stats header.
  await expect(page.locator('.tab[aria-label*="Agent Flow Deck"]')).toBeVisible({ timeout: 30_000 });
  const deckFrame = async () => {
    for (const f of page.frames()) {
      if (await f.locator(".stats").count().catch(() => 0)) return f;
    }
    return null;
  };
  await expect.poll(async () => (await deckFrame()) !== null, { timeout: 30_000 }).toBe(true);
  const deck = (await deckFrame())!;

  await expect(deck.locator(`text=${FIXTURE_TASK.key}`).first()).toBeVisible({ timeout: 60_000 });
  // The PR block renders #number from the shim's answer (DeckApp.tsx, a `.m`
  // span). Poll generously — PR facts arrive on the Deck's own refresh beat.
  await expect(deck.locator("text=#41").first()).toBeVisible({ timeout: 90_000 });
  await shot(page, testInfo, "1 · Deck card with the forge's PR");
});
