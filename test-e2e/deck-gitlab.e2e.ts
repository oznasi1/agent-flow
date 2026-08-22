import { test, expect } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";
import { execFileSync } from "child_process";
import * as fs from "fs";
import { makeSandbox, FIXTURE_TASK, type Sandbox } from "./_helpers/sandbox";
import { launchHost, openTasksView, tasksFrame } from "./_helpers/host";
import { installForgeShims } from "./_helpers/forgeShim";
import { shot } from "./_helpers/shot";

let sb: Sandbox;
let app: ElectronApplication | undefined;
let unknownLog: string;

const BRANCH = "E2E-1-fix-the-rocket-telemetry-panel";
const FP = "projects/:fullpath"; // glab substitutes :fullpath itself; the shim sees it literally

/** The MR as GitLab's LIST endpoint answers — deliberately WITHOUT
 *  head_pipeline. The list route carries no pipeline data on real GitLab, and
 *  a fixture that adds it there re-hides the exact bug class the real shape
 *  once hid (an all-CI-blank Deck that doc-derived fixtures called green). */
const MR_LIST_ROW = {
  iid: 7, web_url: "https://gitlab.invalid/oz/rocket/-/merge_requests/7",
  title: "Fix the rocket telemetry panel", state: "opened", draft: false,
  has_conflicts: false, detailed_merge_status: "mergeable",
};

test.beforeEach(() => {
  sb = makeSandbox({
    "agentFlow.forge": "gitlab",
    "agentFlow.worktree": "always",
    "agentFlow.prFacts": true,
  });
  // Same two fabricated git facts as the GitHub journey: a remote for the
  // forge to read the project from, and origin/HEAD so prEligible can tell
  // the task branch from the default. The URL is never contacted.
  execFileSync("git", ["remote", "add", "origin", "https://gitlab.com/oz/rocket.git"], { cwd: sb.repoPath });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sb.repoPath, encoding: "utf8" }).trim();
  execFileSync("git", ["update-ref", "refs/remotes/origin/main", sha], { cwd: sb.repoPath });
  execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], { cwd: sb.repoPath });

  ({ unknownLog } = installForgeShims(sb, {
    glab: {
      "auth status": "{}",
      // The review queue's sweep — explicitly empty, not left to the default.
      "api merge_requests?scope=reviews_for_me&state=opened&per_page=50": JSON.stringify([]),
      [`api ${FP}/merge_requests?source_branch=${BRANCH}&state=all&per_page=10`]: JSON.stringify([MR_LIST_ROW]),
      // Only the single-MR GET carries the pipeline — the honest GitLab shape.
      [`api ${FP}/merge_requests/7`]: JSON.stringify({ ...MR_LIST_ROW, head_pipeline: { id: 123 } }),
      [`api ${FP}/pipelines/123/jobs?per_page=100`]: JSON.stringify([
        { name: "ci", status: "success", allow_failure: false },
      ]),
      [`api ${FP}/merge_requests/7/approvals`]: JSON.stringify({ approved: true }),
      [`api ${FP}/merge_requests/7/discussions?per_page=100`]: JSON.stringify([]),
    },
  }));
});
test.afterEach(async () => {
  await app?.close();
  app = undefined;
  if (fs.existsSync(unknownLog)) console.log("FORGE UNKNOWN ARGV:\n" + fs.readFileSync(unknownLog, "utf8"));
  sb.dispose();
});

/** The same Deck board over the glab forge: one setting flips the seam, and the
 *  card renders the MR the shimmed glab reports — pipeline read from the
 *  single-MR route, never the list. */
test("the Deck card shows the MR the GitLab forge reports for the run's branch", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;

  await openTasksView(page);
  const frame = tasksFrame(page);
  const card = frame.locator(".card", { hasText: FIXTURE_TASK.key });
  await card.waitFor({ timeout: 30_000 });
  await card.locator("button.take").click();
  await page.locator(".quick-input-widget").waitFor({ timeout: 15_000 });
  const newWindow = app.waitForEvent("window", { timeout: 60_000 });
  await page.keyboard.press("Enter");
  await (await newWindow).locator(".activitybar").waitFor({ timeout: 60_000 });

  await page.keyboard.press("F1");
  await page.keyboard.type("Open the Deck");
  await page.keyboard.press("Enter");

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
  await expect(deck.locator("text=#7").first()).toBeVisible({ timeout: 90_000 });
  await shot(page, testInfo, "1 · Deck card with the glab forge's MR");
});
