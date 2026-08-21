import { test, expect } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { makeSandbox, FIXTURE_TASK, type Sandbox } from "./_helpers/sandbox";
import { launchHost, openTasksView, tasksFrame } from "./_helpers/host";

let sb: Sandbox;
let app: ElectronApplication | undefined;

test.beforeEach(() => { sb = makeSandbox(); });
test.afterEach(async () => { await app?.close(); app = undefined; sb.dispose(); });

test("taking a task opens a real window and lands the brief + plan handshake on disk", async () => {
  test.setTimeout(180_000);
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;

  await openTasksView(page);
  const frame = tasksFrame(page);
  const card = frame.locator(".card", { hasText: FIXTURE_TASK.key });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: "test-results/e2e-take-1-pool.png" });

  // Take. Every downstream prompt except the repo confirm is pre-answered by
  // the sandbox settings (mode, destination, worktree, remote control).
  await card.locator("button.take").click();

  // The repo-confirm QuickPick is real workbench DOM. "rocket" arrives
  // pre-checked because the task summary names it (inferServices), so Enter
  // confirms. This is deliberate coverage of real take UX, not a shortcut.
  const quickInput = page.locator(".quick-input-widget");
  await expect(quickInput).toBeVisible({ timeout: 15_000 });
  await expect(quickInput).toContainText("rocket");
  await page.screenshot({ path: "test-results/e2e-take-2-repo-pick.png" });
  const newWindow = app.waitForEvent("window", { timeout: 60_000 });
  await page.keyboard.press("Enter");

  // A REAL second window — the openFolder fallback runs in-process, so the
  // same Electron app gains a BrowserWindow. This is the "verify the host is
  // working" assertion: no mock can produce this event.
  const opened = await newWindow;
  await opened.locator(".activitybar").waitFor({ timeout: 60_000 });
  await opened.screenshot({ path: "test-results/e2e-take-3-new-window.png" });

  // The brief, with content that can only have come from tasks.json through
  // the connector → takeTask → briefMarkdown → fs pipeline.
  const brief = path.join(sb.repoPath, ".pick-task", "TASK.md");
  await expect.poll(() => fs.existsSync(brief), { timeout: 30_000 }).toBe(true);
  const briefText = fs.readFileSync(brief, "utf8");
  expect(briefText).toContain(FIXTURE_TASK.key);
  expect(briefText).toContain(FIXTURE_TASK.summary);

  // The seed handshake, in the SANDBOX home — proof both that the plan file is
  // written and that the HOME override isolates it from the developer's machine.
  const planDir = path.join(sb.home, ".agentflow", "plans");
  await expect.poll(() => fs.existsSync(planDir) && fs.readdirSync(planDir).length, { timeout: 30_000 }).toBeTruthy();
  const planFile = fs.readdirSync(planDir).find((f) => f.startsWith(`${FIXTURE_TASK.key}-`));
  expect(planFile).toBeDefined();
  const plan = JSON.parse(fs.readFileSync(path.join(planDir, planFile!), "utf8"));
  expect(plan).toMatchObject({ key: FIXTURE_TASK.key, seedAgent: true });

  // And nothing leaked into the real home.
  expect(fs.existsSync(path.join(process.env.HOME ?? "", ".agentflow", "plans", planFile!))).toBe(false);
});
