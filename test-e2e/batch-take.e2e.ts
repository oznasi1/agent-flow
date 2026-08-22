import { test, expect } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { makeSandbox, FIXTURE_TASK, FIXTURE_TASK_2, type Sandbox } from "./_helpers/sandbox";
import { launchHost, openTasksView, tasksFrame } from "./_helpers/host";
import { shot } from "./_helpers/shot";

let sb: Sandbox;
let app: ElectronApplication | undefined;

test.beforeEach(() => { sb = makeSandbox(); });
test.afterEach(async () => { await app?.close(); app = undefined; sb.dispose(); });

/** Batch launch: N tasks in one gesture, each isolated in its own worktree,
 *  one window per task. Worktrees are forced by takeBatch — two tasks sharing
 *  a checkout would clobber each other's brief — so this journey also covers
 *  the batch→worktree contract without a settings override. */
test("launching a batch opens a window per task, each in its own worktree", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;

  await openTasksView(page);
  const frame = tasksFrame(page);
  await expect(frame.locator(".card")).toHaveCount(2, { timeout: 30_000 });

  // Batch mode surfaces only once the repo filter selects a repo
  // (App.tsx: batchMode = selectedRepos.size >= 1) — drive the multiselect.
  await frame.locator(".repo-select-trigger").click();
  await frame.locator(".repo-opt", { hasText: "rocket" }).click();
  await page.keyboard.press("Escape"); // close the popover; the selection sticks

  const checkboxes = frame.locator(".card-check");
  await expect(checkboxes).toHaveCount(2, { timeout: 15_000 });
  await checkboxes.nth(0).check();
  await checkboxes.nth(1).check();
  await expect(frame.locator(".batch-bar")).toContainText("2 selected");
  await shot(page, testInfo, "1 · two tasks selected");

  const firstWindow = app.waitForEvent("window", { timeout: 90_000 });
  await frame.locator("button.batch-launch").click();

  // The one live prompt: layout — "Separate windows" is the first item.
  const quickInput = page.locator(".quick-input-widget");
  await expect(quickInput).toBeVisible({ timeout: 15_000 });
  await expect(quickInput).toContainText("Separate windows");
  await shot(page, testInfo, "2 · layout pick");
  await page.keyboard.press("Enter");

  // Two REAL windows arrive (plus the original = 3 total).
  await firstWindow;
  await expect.poll(() => app!.windows().length, { timeout: 90_000 }).toBeGreaterThanOrEqual(3);
  await shot(page, testInfo, "3 · both windows open");

  // Each task landed in its OWN git worktree with its OWN brief.
  for (const key of [FIXTURE_TASK.key, FIXTURE_TASK_2.key]) {
    const wt = path.join(sb.repoPath, ".claude", "worktrees", key);
    await expect.poll(() => fs.existsSync(path.join(wt, ".pick-task", "TASK.md")), { timeout: 30_000 }).toBe(true);
  }
  // And the shared checkout stayed clean — the reason worktrees are forced.
  expect(fs.existsSync(path.join(sb.repoPath, ".pick-task"))).toBe(false);

  // One plan file per task, both in the sandbox home.
  const planDir = path.join(sb.home, ".agentflow", "plans");
  await expect.poll(() =>
    fs.existsSync(planDir) ? fs.readdirSync(planDir).filter((f) => /^E2E-[12]-/.test(f)).length : 0,
  { timeout: 30_000 }).toBe(2);
});
