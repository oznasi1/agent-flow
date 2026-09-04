import { test, expect } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { makeSandbox, FIXTURE_TASK, type Sandbox } from "./_helpers/sandbox";
import { launchHost, openTasksView, tasksFrame } from "./_helpers/host";
import { runCommand } from "./_helpers/palette";
import { shot } from "./_helpers/shot";

let sb: Sandbox;
let app: ElectronApplication | undefined;

test.beforeEach(() => { sb = makeSandbox(); });
test.afterEach(async () => { await app?.close(); app = undefined; sb.dispose(); });

test("taking a task opens a real window and lands the brief + plan handshake on disk", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;

  await openTasksView(page);
  const frame = tasksFrame(page);
  const card = frame.locator(".card", { hasText: FIXTURE_TASK.key });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await shot(page, testInfo, "1 · pool loaded");

  // Take. Every downstream prompt except the repo confirm is pre-answered by
  // the sandbox settings (mode, destination, worktree, remote control).
  await card.locator("button.take").click();

  // The repo-confirm QuickPick is real workbench DOM. "rocket" arrives
  // pre-checked because the task summary names it (inferServices), so Enter
  // confirms. This is deliberate coverage of real take UX, not a shortcut.
  const quickInput = page.locator(".quick-input-widget");
  await expect(quickInput).toBeVisible({ timeout: 15_000 });
  await expect(quickInput).toContainText("rocket");
  await shot(page, testInfo, "2 · repos confirmed");
  const newWindow = app.waitForEvent("window", { timeout: 60_000 });
  await page.keyboard.press("Enter");

  // A REAL second window — the openFolder fallback runs in-process, so the
  // same Electron app gains a BrowserWindow. This is the "verify the host is
  // working" assertion: no mock can produce this event.
  const opened = await newWindow;
  await opened.locator(".activitybar").waitFor({ timeout: 60_000 });
  await shot(opened, testInfo, "3 · window opened");

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

// Mutation-checked: extension.ts:122-131 — the `agentFlow.takeTask` registration's body replaced with `return;`; the palette still ran the command, nothing was created, and the brief never landed
test("the takeTask palette command takes a task without the card", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;

  // No sidebar at all — that is the claim. `runCommand` deliberately never
  // clicks the activity-bar item (see its own doc comment), so the pool webview
  // is never mounted in this test and the take can only have come from the
  // palette.
  await runCommand(page, "Take Task…");

  // The command's own input box asks for the key (extension.ts:124-128), titled
  // from the connector's label and hinting its example key.
  const quickInput = page.locator(".quick-input-widget");
  await expect(quickInput).toBeVisible({ timeout: 15_000 });
  await expect(quickInput).toContainText("Take a Fixture task");
  await page.keyboard.type(FIXTURE_TASK.key);
  await page.keyboard.press("Enter");
  await shot(page, testInfo, "5 · the palette's own key prompt");

  // From here it is the ordinary take: the repo-confirm QuickPick with "rocket"
  // pre-checked, then the window, the brief and the plan handshake.
  await expect(quickInput).toContainText("rocket", { timeout: 30_000 });
  const newWindow = app.waitForEvent("window", { timeout: 60_000 });
  await page.keyboard.press("Enter");
  await (await newWindow).locator(".activitybar").waitFor({ timeout: 60_000 });

  const brief = path.join(sb.repoPath, ".pick-task", "TASK.md");
  await expect.poll(() => fs.existsSync(brief), { timeout: 60_000 }).toBe(true);
  expect(fs.readFileSync(brief, "utf8")).toContain(FIXTURE_TASK.summary);
  const runFile = path.join(sb.home, ".agentflow", "runs", `${FIXTURE_TASK.key}.json`);
  await expect.poll(() => fs.existsSync(runFile), { timeout: 60_000 }).toBe(true);
  // The sidebar really never came up: no pool webview was ever mounted.
  await expect(page.locator("iframe.webview")).toHaveCount(0);
  await shot(page, testInfo, "6 · brief and run record, with no sidebar ever opened");
});
