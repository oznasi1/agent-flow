import { test, expect } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";
import { makeSandbox, FIXTURE_TASK, type Sandbox } from "./_helpers/sandbox";
import { launchHost, openTasksView, tasksFrame } from "./_helpers/host";
import { shot } from "./_helpers/shot";

let sb: Sandbox;
let app: ElectronApplication | undefined;

test.beforeEach(() => { sb = makeSandbox({ "agentFlow.agentProvider": "copilot" }); });
test.afterEach(async () => { await app?.close(); app = undefined; sb.dispose(); });

/** The real-host proof of the seedChatPanel fix. Core VS Code >=1.9x registers
 *  workbench.action.chat.open with no chat extension installed, and before the
 *  fix a Copilot seed executed it, logged success, and gave the user NOTHING —
 *  no panel, no clipboard, no toast (found by this journey's first draft).
 *  With the extension-presence gate, the seed lands on the documented
 *  clipboard fallback instead. */
test("a Copilot seed without Copilot lands on the documented clipboard fallback", async ({}, testInfo) => {
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
  const opened = await newWindow;
  await opened.locator(".activitybar").waitFor({ timeout: 60_000 });

  // The fallback toast in the OPENED window. The copy is the contract — it
  // tells the user where their prompt went.
  await expect(opened.locator(".notification-list-item-message", { hasText: "prompt copied" }))
    .toBeVisible({ timeout: 60_000 });
  await shot(opened, testInfo, "1 · clipboard fallback announced");

  // And the clipboard genuinely carries the prompt. The renderer denies
  // navigator.clipboard.readText (no user activation), but the product writes
  // the SYSTEM clipboard — readable from outside the host on macOS. On Linux
  // CI there is no dependable reader under xvfb, so there the toast remains
  // the contract.
  if (process.platform === "darwin") {
    const { execFileSync } = await import("child_process");
    const clip = execFileSync("pbpaste", [], { encoding: "utf8" });
    expect(clip).toContain(`Jira ${FIXTURE_TASK.key}`);
  }
});
