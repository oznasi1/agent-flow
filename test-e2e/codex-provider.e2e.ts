import { test, expect } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { makeSandbox, FIXTURE_TASK, type Sandbox } from "./_helpers/sandbox";
import { launchHost, openTasksView, tasksFrame } from "./_helpers/host";
import { shot } from "./_helpers/shot";

let sb: Sandbox;
let app: ElectronApplication | undefined;

// Unlike cursor-provider.e2e.ts — which can only pin the wrong-host degradation,
// because no automatable host makes `isCursorHost()` true — codex is host-independent
// (src/config.ts readAgentProviderSetting passes it through everywhere), so this lane
// runs the REAL codex seeding path: `agentProvider: "codex"` on this VS Code host
// stays codex and drives the sandbox's `codex` shim in a real integrated terminal.
//
// Two contracts pinned, one per surface setting:
//   1. terminal surface — the ordinary provider-CLI seed, mirroring seed-terminal's
//      claude journey: our shim runs (not any real CLI) and the prompt lands typed
//      but unsubmitted.
//   2. extension surface — codex has no chat panel to pre-fill, so the seed must
//      STILL land in a terminal (workspace.ts routes codex to seedViaTerminal under
//      either surface). This is the routing that only a real workbench can prove:
//      unit tests stub the terminal, this watches xterm.js render it.

test.afterEach(async () => { await app?.close(); app = undefined; sb.dispose(); });

/** Everything the integrated terminal currently shows. xterm.js renders the
 *  buffer into .xterm-rows; innerText of that node is the visible screen. */
async function terminalText(win: Page): Promise<string> {
  const rows = win.locator(".terminal .xterm-rows").last();
  return (await rows.count()) ? await rows.innerText() : "";
}

/** Take the fixture task and hand back the newly opened window, seeded. */
async function takeFixtureTask(): Promise<Page> {
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
  return opened;
}

test("codex on the terminal surface runs the codex CLI and seeds the prompt unsubmitted", async ({}, testInfo) => {
  test.setTimeout(180_000);
  sb = makeSandbox({ "agentFlow.agentProvider": "codex", "agentFlow.agentSurface": "terminal" });
  const opened = await takeFixtureTask();

  // The shim marker proves the terminal ran OUR `codex` — not the developer's real
  // CLI, and not claude's shim (whose marker says CLAUDE) — i.e. CLI["codex"].cmd
  // resolved, and the codex value survived this host's setting read.
  await expect.poll(() => terminalText(opened), { timeout: 60_000 }).toContain("CODEX-SHIM-READY");

  // The seeded prompt, typed but NOT submitted — same §5b boundary as the claude
  // journey: fixture → takeTask → plan file → new-window activation → seedViaTerminal.
  await expect.poll(() => terminalText(opened), { timeout: 30_000 }).toContain(`Jira ${FIXTURE_TASK.key}`);
  expect(await terminalText(opened)).toContain("rocket telemetry");
  await shot(opened, testInfo, "1 · codex prompt seeded, unsubmitted");
});

test("codex under the extension surface still seeds a terminal — there is no panel to pre-fill", async ({}, testInfo) => {
  test.setTimeout(180_000);
  // No agentSurface override: the sandbox default is the extension surface, the one
  // every panel-seeding journey relies on (see seed-panel.e2e.ts).
  sb = makeSandbox({ "agentFlow.agentProvider": "codex" });
  const opened = await takeFixtureTask();

  await expect.poll(() => terminalText(opened), { timeout: 60_000 }).toContain("CODEX-SHIM-READY");
  await expect.poll(() => terminalText(opened), { timeout: 30_000 }).toContain(`Jira ${FIXTURE_TASK.key}`);
  await shot(opened, testInfo, "1 · terminal seed under extension surface");
});
