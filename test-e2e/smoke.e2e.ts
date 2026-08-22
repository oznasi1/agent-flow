import { test, expect } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";
import { makeSandbox, FIXTURE_TASK, type Sandbox } from "./_helpers/sandbox";
import { launchHost, openTasksView, tasksFrame } from "./_helpers/host";
import { shot } from "./_helpers/shot";

let sb: Sandbox;
let app: ElectronApplication | undefined;

test.beforeEach(() => { sb = makeSandbox(); });
test.afterEach(async () => { await app?.close(); app = undefined; sb.dispose(); });

test("a real host boots the extension and the pool renders the fixture task", async ({}, testInfo) => {
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;

  await openTasksView(page);
  const frame = tasksFrame(page);

  // The card is real DOM inside the real webview: the fixture's summary can be
  // there only if extension → connector → registry gate → webview all worked.
  const card = frame.locator(".card", { hasText: FIXTURE_TASK.key });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText(FIXTURE_TASK.summary);
  await shot(page, testInfo, "1 · pool loaded");
});
