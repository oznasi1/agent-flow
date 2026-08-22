import { test, expect } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { makeSandbox, FIXTURE_TASK, type Sandbox } from "./_helpers/sandbox";
import { launchHost, openTasksView, tasksFrame } from "./_helpers/host";
import { shot } from "./_helpers/shot";

let sb: Sandbox;
let app: ElectronApplication | undefined;

// NOT coverage of the real Cursor path. `isCursorHost()` (src/config.ts:169-171)
// gates `agentProvider: "cursor"` behind `vscode.env.uriScheme === "cursor"`, and
// this lane's Task 1 CDP spike already proved a real Cursor host is unautomatable
// here (workbench unreachable through the CDP target it hands back). There is no
// host anywhere in this lane that can make `isCursorHost()` true, so the actual
// `cursor-agent` launch has never run under test and remains UNVERIFIED IN ANY
// EDITOR since it shipped in 0.33.0. A future reader must not assume this file
// closes that gap.
//
// What this file DOES pin: `readAgentProviderSetting` (src/config.ts:198-206)
// documents that a `cursor`/`copilot` value read on the wrong host "degrades ...
// instead of failing at seed time." On a VS Code host — the only host this lane
// can run — a `cursor` setting must degrade to Claude Code and seed normally,
// not seed nothing, throw, or try to launch a binary that isn't there. That
// degradation is the shipped, testable contract, mirroring how
// copilot-fallback.e2e.ts pins Copilot's own documented fallback.
test.beforeEach(() => {
  sb = makeSandbox({ "agentFlow.agentProvider": "cursor", "agentFlow.agentSurface": "terminal" });
});
test.afterEach(async () => { await app?.close(); app = undefined; sb.dispose(); });

/** Everything the integrated terminal currently shows. xterm.js renders the
 *  buffer into .xterm-rows; innerText of that node is the visible screen. */
async function terminalText(win: Page): Promise<string> {
  const rows = win.locator(".terminal .xterm-rows").last();
  return (await rows.count()) ? await rows.innerText() : "";
}

test("a cursor provider setting degrades to Claude Code on a VS Code host", async ({}, testInfo) => {
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
  await page.keyboard.press("Enter"); // confirm the pre-checked repo

  // The NEW window is where seeding happens: the extension activates there,
  // matches the plan file to the window's identity, and drives the terminal.
  const opened = await newWindow;
  await opened.locator(".activitybar").waitFor({ timeout: 60_000 });

  // POSITIVE proof of degradation: Claude Code's own shim marker appears — not
  // merely that `cursor-agent`'s marker is absent, which an empty terminal (or
  // no seed at all) would also satisfy.
  await expect.poll(() => terminalText(opened), { timeout: 60_000 }).toContain("CLAUDE-SHIM-READY");

  // And the prompt itself reached that Claude Code terminal, typed but not
  // submitted — the degraded path still carries the real task content through.
  await expect.poll(() => terminalText(opened), { timeout: 30_000 }).toContain(`Jira ${FIXTURE_TASK.key}`);
  expect(await terminalText(opened)).toContain("rocket telemetry");
  await shot(opened, testInfo, "1 · cursor setting degraded to Claude Code");
});
