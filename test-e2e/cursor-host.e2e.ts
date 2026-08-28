import { test, expect } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { makeSandbox, FIXTURE_TASK, type Sandbox } from "./_helpers/sandbox";
import { launchHost, openTasksView, tasksFrame } from "./_helpers/host";
import { shot } from "./_helpers/shot";

let sb: Sandbox;
let app: ElectronApplication | undefined;

// The journey cursor-provider.e2e.ts documents as impossible — until now. The real
// Cursor app stays unautomatable, but `isCursorHost()` reads only
// `vscode.env.uriScheme`, and cursorHostExecutable() (host.ts) hands back a stock
// VS Code whose product.json says `urlProtocol: "cursor"`. On that host the `cursor`
// setting survives `readAgentProviderSetting` instead of degrading, and the
// `cursor-agent` launch — UNVERIFIED IN ANY EDITOR since 0.33.0 — finally runs under
// test, against the sandbox's shim.
//
// Terminal surface only, deliberately: on the extension surface a cursor seed calls
// the HOST's own chat (`workbench.action.chat.open`, no extension check — Cursor's
// chat is built in). On this patched host that command is stock VS Code's, so any
// panel assertion would pin the impersonation, not Cursor. The terminal path has no
// such dependency on what the host is — the CLI table row is the whole contract.
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

test("on a cursor-scheme host, the cursor setting really runs cursor-agent in the seeded terminal", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const launched = await launchHost(sb, { host: "cursor" });
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

  // The shim marker is the whole point of this file: `cursor-agent` — not `claude`,
  // which is what this exact setting seeds on a vscode-scheme host
  // (cursor-provider.e2e.ts pins that degradation).
  await expect.poll(() => terminalText(opened), { timeout: 60_000 }).toContain("CURSOR-AGENT-SHIM-READY");

  // The seeded prompt, typed but NOT submitted — the same §5b boundary as the
  // claude and codex terminal journeys.
  await expect.poll(() => terminalText(opened), { timeout: 30_000 }).toContain(`Jira ${FIXTURE_TASK.key}`);
  expect(await terminalText(opened)).toContain("rocket telemetry");
  await shot(opened, testInfo, "1 · cursor-agent seeded on a cursor host");
});
