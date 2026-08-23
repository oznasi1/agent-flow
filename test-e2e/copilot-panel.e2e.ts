import { expect, test, type ElectronApplication } from "@playwright/test";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { makeSandbox, FIXTURE_TASK, type Sandbox } from "./_helpers/sandbox";
import { VSCODE_VERSION, launchHost } from "./_helpers/host";
import { installCopilotChat } from "./_helpers/copilotChat";
import { Pool } from "./_helpers/po/pool";
import { shot } from "./_helpers/shot";

let sb: Sandbox;
let app: ElectronApplication | undefined;

test.beforeEach(async () => {
  sb = makeSandbox({ "agentFlow.agentProvider": "copilot", "agentFlow.agentSurface": "extension" });
  await installCopilotChat(await downloadAndUnzipVSCode(VSCODE_VERSION), sb);
});
test.afterEach(async () => { await app?.close(); app = undefined; sb.dispose(); });

/** The real-host proof of the OTHER side of copilot-fallback.e2e.ts's branch:
 *  with GitHub Copilot Chat actually installed, seedChatPanel's extension-presence
 *  gate lets the take proceed to `workbench.action.chat.open` instead of the
 *  clipboard fallback. A pinned, unauthenticated Copilot Chat still requires
 *  sign-in to actually chat, so the panel that opens is the extension's own
 *  "Welcome to Copilot" / sign-in view rather than the seeded prompt — that's
 *  the real product's own gate, not this extension's, and it is not what this
 *  journey pins. `.interactive-session` (found by an earlier draft of this
 *  journey) DOES exist in the DOM at this point but stays hidden the entire
 *  180s window — it's a template for an active session, not what's rendered
 *  before sign-in — so asserting on it is a false signal. What this journey
 *  DOES pin, and is exactly the fix's contract: the take reaches a REAL,
 *  visible Copilot Chat panel (proven by its own welcome copy, which only the
 *  extension can render — core VS Code renders nothing for this command with
 *  no chat extension installed, per copilot-fallback.e2e.ts) and never falls
 *  back to the clipboard-copy toast the no-extension case produces. */
test("a copilot take opens the real chat panel instead of the clipboard fallback", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;
  const pool = await Pool.open(page, 2);

  await pool.card(FIXTURE_TASK.key).getByRole("button", { name: /take/i }).click();
  // The repo-confirm QuickPick: wait for it before confirming, same as
  // copilot-fallback.e2e.ts — pressing Enter before it renders dismisses
  // nothing and leaves the picker open, unconfirmed, forever.
  await page.locator(".quick-input-widget").waitFor({ timeout: 15_000 });
  // `openIn: new-window` (the sandbox default) means the seed — and the panel
  // it opens — lands in a NEW Electron window, not this one.
  const newWindow = app.waitForEvent("window", { timeout: 60_000 });
  await page.keyboard.press("Enter");
  const opened = await newWindow;
  await opened.locator(".activitybar").waitFor({ timeout: 60_000 });

  // The contract: with Copilot Chat present, seedChatPanel resolves
  // workbench.action.chat.open and NEVER reaches the clipboard fallback toast.
  await expect(opened.getByText(/welcome to copilot/i).first()).toBeVisible({ timeout: 180_000 });
  await expect(opened.locator(".notifications-toasts")).not.toContainText("prompt copied");
  await shot(opened, testInfo, "1 · copilot panel");
});
