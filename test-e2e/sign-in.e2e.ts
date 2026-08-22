import { test, expect } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";
import { makeSandbox, type Sandbox } from "./_helpers/sandbox";
import { launchHost, openTasksView, tasksFrame } from "./_helpers/host";
import { shot } from "./_helpers/shot";

let sb: Sandbox;
let app: ElectronApplication | undefined;

// Journey 5: sign-in/out — the one journey that runs the REAL Jira connector,
// because what it tests is the SecretStorage round-trip, not the HTTP client.
// The planned `__test.signIn` seam turned out to be unnecessary: the gate's
// own button drives the real InputBox flow, and `fixture.invalid` (an
// RFC-guaranteed unresolvable TLD) makes the post-auth fetch fail
// deterministically with no network dependency. AGENT_FLOW_FIXTURE_DIR is
// still set by the sandbox — taskSource "jira" must ignore it, the same
// no-hijack rule the registry's unit tests pin.
test.beforeEach(() => {
  sb = makeSandbox({
    "agentFlow.taskSource": "jira",
    "agentFlow.jira.baseUrl": "https://fixture.invalid",
    "agentFlow.jira.project": "E2E",
  });
});
test.afterEach(async () => { await app?.close(); app = undefined; sb.dispose(); });

test("signing in round-trips through SecretStorage and signing out re-gates the pool", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;

  await openTasksView(page);
  const frame = tasksFrame(page);

  // Fresh host, empty SecretStorage: the pool is gated behind sign-in.
  const signInBtn = frame.locator(".gate button", { hasText: "Sign in" });
  await expect(signInBtn).toBeVisible({ timeout: 30_000 });
  await shot(page, testInfo, "1 · gated — no credentials");

  // The gate's own button runs the real flow: two workbench InputBoxes.
  await signInBtn.click();
  const quickInput = page.locator(".quick-input-widget");
  await expect(quickInput).toBeVisible({ timeout: 15_000 });
  await expect(quickInput).toContainText("Jira sign-in (1/2)");
  await page.keyboard.type("e2e@fixture.invalid");
  await page.keyboard.press("Enter");
  await expect(quickInput).toContainText("Jira sign-in (2/2)");
  await page.keyboard.type("not-a-real-token");
  await page.keyboard.press("Enter");

  // Credentials stored → isAuthenticated() is true → the sign-in gate is gone.
  // The pool's fetch then fails (fixture.invalid never resolves), so the ERROR
  // gate showing is itself the proof the flow got PAST auth to the request —
  // an unauthed panel would never have tried.
  await expect(signInBtn).toHaveCount(0, { timeout: 30_000 });
  await expect(frame.locator(".gate-error")).toBeVisible({ timeout: 30_000 });
  await shot(page, testInfo, "2 · signed in — auth passed, fetch failed as designed");

  // Sign out from the command palette (real workbench, F1 works on all
  // platforms). Today's actual behavior: signOut deletes the secrets and
  // toasts, but does NOT re-post state — the sidebar keeps its last gate until
  // the next refresh. (A real UX gap, worth its own fix; this test pins what
  // ships.) The refresh is what proves the round-trip: the sign-in gate can
  // only return if the secrets are truly gone from SecretStorage.
  await page.keyboard.press("F1");
  await page.keyboard.type("Sign out of Jira");
  await page.keyboard.press("Enter");
  await page.keyboard.press("F1");
  await page.keyboard.type("Refresh Tasks");
  await page.keyboard.press("Enter");
  await expect(frame.locator(".gate button", { hasText: "Sign in" })).toBeVisible({ timeout: 30_000 });
  await shot(page, testInfo, "3 · signed out — gated again after refresh");
});
