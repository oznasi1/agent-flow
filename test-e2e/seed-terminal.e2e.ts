import { test, expect } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { makeSandbox, FIXTURE_TASK, type Sandbox } from "./_helpers/sandbox";
import { launchHost, openTasksView, tasksFrame } from "./_helpers/host";

let sb: Sandbox;
let app: ElectronApplication | undefined;

// Journey 2, terminal surface: the one seeding path provable without installing
// the Claude Code extension — and without the URI-handler rung, which on a
// developer machine would bounce vscode:// to the REAL installed editor.
test.beforeEach(() => { sb = makeSandbox({ "agentFlow.agentSurface": "terminal" }); });
test.afterEach(async () => { await app?.close(); app = undefined; sb.dispose(); });

/** Everything the integrated terminal currently shows. xterm.js renders the
 *  buffer into .xterm-rows; innerText of that node is the visible screen. */
async function terminalText(win: Page): Promise<string> {
  const rows = win.locator(".terminal .xterm-rows").last();
  return (await rows.count()) ? await rows.innerText() : "";
}

test("the opened window seeds the agent prompt into a real integrated terminal", async () => {
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

  // The NEW window is where seeding happens: the extension activates there,
  // matches the plan file to the window's identity, and drives the terminal.
  const opened = await newWindow;
  await opened.locator(".activitybar").waitFor({ timeout: 60_000 });

  // The shim proves the terminal ran OUR `claude`, not the developer's real
  // CLI — if the marker is missing, the PATH sandbox has failed and the prompt
  // assertion below must not be trusted.
  await expect.poll(() => terminalText(opened), { timeout: 60_000 }).toContain("CLAUDE-SHIM-READY");

  // The seeded prompt, typed but NOT submitted: the extension's actual
  // responsibility ends at a correctly-seeded prompt (the spec's §5b boundary).
  // Its text can only have come from tasks.json through the whole pipeline:
  // fixture → takeTask → plan file → new-window activation → seedViaTerminal.
  await expect.poll(() => terminalText(opened), { timeout: 30_000 }).toContain(`Jira ${FIXTURE_TASK.key}`);
  expect(await terminalText(opened)).toContain("rocket telemetry");
  await opened.screenshot({ path: "test-results/e2e-seed-terminal.png" });
});
