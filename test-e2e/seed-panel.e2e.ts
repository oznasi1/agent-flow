import { test, expect } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { makeSandbox, FIXTURE_TASK, type Sandbox } from "./_helpers/sandbox";
import { launchHost, openTasksView, tasksFrame, VSCODE_VERSION } from "./_helpers/host";
import { installClaudeCode } from "./_helpers/claudeCode";
import { shot } from "./_helpers/shot";

let sb: Sandbox;
let app: ElectronApplication | undefined;

test.beforeEach(() => { sb = makeSandbox(); });
test.afterEach(async () => { await app?.close(); app = undefined; sb.dispose(); });

/** Journey 2, panel surface, against the REAL pinned Claude Code build. What
 *  this pins is the undocumented command contract the seed rides on
 *  (claude-vscode.primaryEditor.open taking (session, prompt)) — the exact
 *  coupling the spec's risk register flags. The panel opening in the seeded
 *  tab is the extension-side proof: nothing else in this sandbox opens it.
 *
 *  Deliberately NOT asserted: the prompt's text inside the panel. Signed out,
 *  Claude Code shows its login screen (verified by eye against 2.1.238), and
 *  signing in from CI would call Anthropic's API — the spec's hard boundary.
 *  The prompt's correctness is already pinned end-to-end by the terminal-
 *  surface journey, which asserts the identical seedText pipeline. */
test("the take seeds the real Claude Code panel in the opened window", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const exe = await downloadAndUnzipVSCode(VSCODE_VERSION);
  await installClaudeCode(exe, sb);
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
  const newWindow = app.waitForEvent("window", { timeout: 60_000 });
  await page.keyboard.press("Enter");

  const opened = await newWindow;
  await opened.locator(".activitybar").waitFor({ timeout: 60_000 });

  // The seed polls for the command (7 x 700ms) while both extensions ride the
  // same onStartupFinished activation — the generous timeout absorbs that.
  await expect(opened.locator('.tab[aria-label*="Claude Code"]')).toBeVisible({ timeout: 60_000 });
  // And the tab is the real extension's webview, not something else that
  // happens to share the label.
  await expect
    .poll(() => opened.frames().some((f) => f.url().includes("extensionId=Anthropic.claude-code")), { timeout: 30_000 })
    .toBe(true);
  await shot(opened, testInfo, "1 · Claude Code panel opened by the seed");
});
