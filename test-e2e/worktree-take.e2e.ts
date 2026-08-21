import { test, expect } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { makeSandbox, FIXTURE_TASK, type Sandbox } from "./_helpers/sandbox";
import { launchHost, openTasksView, tasksFrame } from "./_helpers/host";
import { shot } from "./_helpers/shot";

let sb: Sandbox;
let app: ElectronApplication | undefined;

// Journey 4's one deviation from the shared contract: isolate the take in a
// git worktree instead of the checkout.
test.beforeEach(() => { sb = makeSandbox({ "agentFlow.worktree": "always" }); });
test.afterEach(async () => { await app?.close(); app = undefined; sb.dispose(); });

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

/** Journey 4: worktree mode. The take lands in a REAL `git worktree` with a
 *  per-task branch, and the brief lands in the worktree — the shared checkout
 *  stays untouched, which is the entire point of the mode. */
test("worktree mode takes the task in a real git worktree on a per-task branch", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;

  await openTasksView(page);
  const frame = tasksFrame(page);
  const card = frame.locator(".card", { hasText: FIXTURE_TASK.key });
  await expect(card).toBeVisible({ timeout: 30_000 });

  await card.locator("button.take").click();
  const quickInput = page.locator(".quick-input-widget");
  await expect(quickInput).toBeVisible({ timeout: 15_000 });
  await expect(quickInput).toContainText("rocket");
  const newWindow = app.waitForEvent("window", { timeout: 60_000 });
  await page.keyboard.press("Enter");
  const opened = await newWindow;
  await opened.locator(".activitybar").waitFor({ timeout: 60_000 });
  await shot(opened, testInfo, "1 · worktree window opened");

  // A real worktree, registered with git itself — not merely a directory that
  // looks like one. createWorktrees puts it at <repo>/.claude/worktrees/<KEY>.
  const wtPath = path.join(sb.repoPath, ".claude", "worktrees", FIXTURE_TASK.key);
  await expect.poll(() => fs.existsSync(wtPath), { timeout: 30_000 }).toBe(true);
  // realpath both sides: on macOS the sandbox lives under /var, a symlink to
  // /private/var, and git prints the resolved form.
  expect(git(sb.repoPath, ["worktree", "list", "--porcelain"])).toContain(`worktree ${fs.realpathSync(wtPath)}`);

  // On the per-task branch: <KEY>-<slug-of-summary>.
  const branch = git(wtPath, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  expect(branch).toBe("E2E-1-fix-the-rocket-telemetry-panel");

  // The brief belongs to the worktree; the shared checkout stays clean. This
  // pair is what "isolated" means — a brief in the checkout would be a
  // collision with whatever else is using it.
  await expect.poll(() => fs.existsSync(path.join(wtPath, ".pick-task", "TASK.md")), { timeout: 30_000 }).toBe(true);
  expect(fs.existsSync(path.join(sb.repoPath, ".pick-task"))).toBe(false);
});
