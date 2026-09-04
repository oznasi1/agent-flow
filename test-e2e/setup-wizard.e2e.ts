import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { makeSandbox, type Sandbox } from "./_helpers/sandbox";
import { launchHost } from "./_helpers/host";
import { runCommand } from "./_helpers/palette";
import { shot } from "./_helpers/shot";

let sb: Sandbox;
let app: ElectronApplication | undefined;

/** Journey: first-run setup. The one journey that runs the wizard end to end,
 *  which is why it points `agentFlow.taskSource` at the REAL Jira connector like
 *  `sign-in.e2e.ts` does: the fixture connector declares `setupSteps: 0` /
 *  `signInSteps: 0` and `configure: async () => async () => {}`, so it draws no
 *  boxes at all and there would be no numbering, no commit thunk and no
 *  credential prompts to prove anything about.
 *
 *  The sandbox exists to PRE-ANSWER prompts (see `makeSandbox`), so this file has
 *  to un-answer two things:
 *   - `agentFlow.jira.baseUrl`/`.project` set to `""`. `getConfig()`
 *     (src/config.ts:765-766) coerces both with `|| ""`, and
 *     `JiraConnector.isConfigured()` (src/tasks/jira/connector.ts:39-42) trims
 *     before testing truthiness — so `""` reads as unconfigured and
 *     `maybeRunSetup` offers the wizard.
 *   - `agentFlow.setupComplete` is a `globalState` key (setup.ts:6), not a
 *     setting, and it lives in the sandbox's own `--user-data-dir`. A fresh
 *     `makeSandbox` therefore has it absent with nothing to write; the tests
 *     that need it to PERSIST relaunch the same sandbox rather than a new one.
 *
 *  `AGENT_FLOW_FIXTURE_DIR` is still exported by `launchHost`, and `taskSource:
 *  "jira"` must ignore it — the same no-hijack rule the registry's unit tests
 *  pin (src/tasks/registry.ts:30-35).
 */

// The wizard's step count, derived rather than written as "5": CONNECTORS.md §4
// states the total as `setupSteps + 1 + signInSteps`, and `JiraConnector`
// declares 2 and 2 (src/tasks/jira/connector.ts:21-22). The `+1` is Agent Flow's
// own repos-root box, which setup.ts:76 always numbers LAST of the connector's
// own steps and BEFORE the credential pair.
const SETUP_STEPS = 2;
const SIGN_IN_STEPS = 2;
const REPOS_ROOT_STEP = SETUP_STEPS + 1;
const TOTAL = REPOS_ROOT_STEP + SIGN_IN_STEPS;
const step = (n: number) => `Agent Flow Deck Setup (${n}/${TOTAL})`;

/** The file every "writes nothing" assertion here is measured against: the
 *  sandbox's real user `settings.json`, which is where
 *  `ConfigurationTarget.Global` lands. Read as text, compared byte for byte —
 *  `update()` rewrites the document rather than re-serialising it, so a
 *  formatting-only change would be a real change worth failing on. */
const settingsFile = (): string => path.join(sb.userDataDir, "User", "settings.json");
const settings = (): string => fs.readFileSync(settingsFile(), "utf8");
const settingsJson = (): Record<string, unknown> => JSON.parse(settings()) as Record<string, unknown>;

/** The workbench's quick-input widget — every wizard box renders here, on the
 *  TOP-LEVEL page, outside any webview (`vscode.window.showInputBox`).
 *  Selectors read from VS Code 1.96.2's workbench DOM on 2026-09-04, the same
 *  ones `_helpers/palette.ts` and `sign-in.e2e.ts` already lean on. */
const quickInput = (page: Page) => page.locator(".quick-input-widget");

/** The first-activation offer. `showInformationMessage` renders as a workbench
 *  notification — `.notification-list-item` on the top-level page — with one
 *  `.monaco-button` per item action. */
const welcome = (page: Page) => page.locator(".notification-list-item", { hasText: "Welcome to Agent Flow Deck" });

/** Type into a box that came pre-filled (`value: "~/projects"` on the repos-root
 *  step): VS Code does not always select the seeded value, so clear it first. */
async function replace(page: Page, text: string): Promise<void> {
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(text);
}

test.beforeEach(() => {
  sb = makeSandbox({
    "agentFlow.taskSource": "jira",
    "agentFlow.jira.baseUrl": "",
    "agentFlow.jira.project": "",
  });
});
test.afterEach(async () => {
  await app?.close();
  app = undefined;
  sb.dispose();
});

// Mutation-checked: `src/tasks/jira/connector.ts`'s first box titled
// `(${from}/${total + 1})` — the wizard then opens on "(1/6)" and this fails.
test("the welcome offer leads into a numbered wizard", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;

  // The offer is a notification, not a modal, and it names the source through
  // `connector.info().label` (setup.ts:159) — "Jira", not a hardcoded string.
  await expect(welcome(page)).toBeVisible({ timeout: 60_000 });
  await expect(welcome(page)).toContainText("Jira");
  await expect(welcome(page).locator(".monaco-button", { hasText: "Set up" })).toBeVisible();
  await expect(welcome(page).locator(".monaco-button", { hasText: "Later" })).toBeVisible();
  await shot(page, testInfo, "1 · the first-activation welcome offer");

  // Set up runs the real wizard: the connector's own first box, numbered as
  // step 1 of the whole wizard rather than 1 of the connector's two.
  await welcome(page).locator(".monaco-button", { hasText: "Set up" }).click();
  await expect(quickInput(page)).toBeVisible({ timeout: 30_000 });
  await expect(quickInput(page).locator(".quick-input-title")).toHaveText(step(1));
  await expect(quickInput(page)).toContainText("Your Atlassian Jira Cloud site URL");
  await shot(page, testInfo, `2 · ${step(1)} — the connector's own first box`);

  // Step 2 is the connector's second box; step 3 is Agent Flow's own repos root,
  // which CONNECTORS.md §4 says "always comes last" of the collected settings.
  await page.keyboard.type("https://fixture.invalid");
  await page.keyboard.press("Enter");
  await expect(quickInput(page).locator(".quick-input-title")).toHaveText(step(2));
  await expect(quickInput(page)).toContainText("Jira project key to pull tasks from");
  await page.keyboard.type("E2E");
  await page.keyboard.press("Enter");
  await expect(quickInput(page).locator(".quick-input-title")).toHaveText(step(REPOS_ROOT_STEP));
  await expect(quickInput(page)).toContainText("Directory where your repo checkouts live");
  await shot(page, testInfo, `3 · ${step(REPOS_ROOT_STEP)} — the repos root comes last`);

  // And the credential pair is numbered into the SAME total, rather than
  // restarting at "(1/2)" the way the standalone Sign in command does.
  await replace(page, sb.reposRoot);
  await page.keyboard.press("Enter");
  await expect(quickInput(page).locator(".quick-input-title")).toHaveText(step(REPOS_ROOT_STEP + 1));
  await expect(quickInput(page)).toContainText("Your Atlassian account email");
  await page.keyboard.type("e2e@fixture.invalid");
  await page.keyboard.press("Enter");
  await expect(quickInput(page).locator(".quick-input-title")).toHaveText(step(TOTAL));
  await expect(quickInput(page)).toContainText("Atlassian API token");
  await shot(page, testInfo, `4 · ${step(TOTAL)} — the credential pair counts into one total`);
  await page.keyboard.press("Escape");
});

// Mutation-checked: `src/setup.ts`'s `cancelled-source` branch marking
// `SETUP_COMPLETE_KEY` true before `abort()` — the offer then never returns and
// the relaunch assertion fails.
//
// Deliberately NOT the "configure writes inline" mutation used by the two tests
// below: verified by running it here, this test SURVIVES that one, because a
// cancel at the FIRST box returns `null` before either value exists to write.
// The no-write half of this test is therefore the weaker half — the strong
// no-write proof is `Escape at the repos-root step`, which cancels after both
// values were collected — and this test's own load-bearing claim is the flag.
test("Escape during a connector step writes nothing and the offer returns next launch", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;

  await expect(welcome(page)).toBeVisible({ timeout: 60_000 });
  // Baseline taken AFTER the workbench is up, so any launch-time rewrite of the
  // document by VS Code itself is outside the comparison and only the wizard's
  // own writes can move it.
  const before = settings();

  await welcome(page).locator(".monaco-button", { hasText: "Set up" }).click();
  await expect(quickInput(page).locator(".quick-input-title")).toHaveText(step(1));
  // Something typed and then abandoned, so this is a cancel of a box that had a
  // value to commit rather than of an empty one.
  await page.keyboard.type("https://typed-then-abandoned.invalid");
  await page.keyboard.press("Escape");
  await expect(quickInput(page)).toBeHidden({ timeout: 15_000 });
  await shot(page, testInfo, "1 · Escaped at step 1 of the connector's own boxes");

  // The assertion of record: the settings document is byte-identical. It is not
  // a vacuous absence — the same file, read the same way, is what
  // "completing the wizard writes the settings and marks setup complete" below
  // watches change.
  expect(settings()).toBe(before);
  expect(settingsJson()["agentFlow.jira.baseUrl"]).toBe("");

  // And `setupComplete` stayed unset, which is only observable as the offer
  // coming back: a relaunch of the SAME sandbox (same --user-data-dir, so the
  // same globalState) offers the wizard again.
  await app.close();
  const relaunched = await launchHost(sb);
  app = relaunched.app;
  await expect(welcome(relaunched.page)).toBeVisible({ timeout: 60_000 });
  await shot(relaunched.page, testInfo, "2 · the offer returns on the next launch");
});

// Mutation-checked: `src/tasks/jira/connector.ts`'s `configure` writing inline —
// the two `c.update(...)` calls moved out of the returned thunk and awaited
// before `return async () => {}` — so the Escape at the repos-root box leaves
// the site URL and project key behind and the byte compare fails.
test("Escape at the repos-root step writes nothing", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;

  await expect(welcome(page)).toBeVisible({ timeout: 60_000 });
  const before = settings();

  // Both connector boxes ANSWERED — reaching step 3 is the proof they returned
  // values, since `setup.ts` aborts on `null` and never draws this box — and
  // then cancelled at Agent Flow's own step. This is the commit thunk's whole
  // purpose (CONNECTORS.md §4: "collect, don't write").
  await welcome(page).locator(".monaco-button", { hasText: "Set up" }).click();
  await expect(quickInput(page).locator(".quick-input-title")).toHaveText(step(1));
  await page.keyboard.type("https://collected.invalid");
  await page.keyboard.press("Enter");
  await expect(quickInput(page).locator(".quick-input-title")).toHaveText(step(2));
  await page.keyboard.type("COLLECTED");
  await page.keyboard.press("Enter");
  await expect(quickInput(page).locator(".quick-input-title")).toHaveText(step(REPOS_ROOT_STEP));
  await shot(page, testInfo, `1 · both connector boxes answered, at ${step(REPOS_ROOT_STEP)}`);

  await page.keyboard.press("Escape");
  await expect(quickInput(page)).toBeHidden({ timeout: 15_000 });

  expect(settings()).toBe(before);
  expect(settingsJson()["agentFlow.jira.baseUrl"]).toBe("");
  expect(settingsJson()["agentFlow.jira.project"]).toBe("");
  await shot(page, testInfo, "2 · nothing collected reached settings.json");
});

// Mutation-checked: `src/setup.ts`'s commit block with `await commitSource()`
// removed — the site URL and project key never land and the first two
// expectations fail.
test("completing the wizard writes the settings and marks setup complete", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;

  await expect(welcome(page)).toBeVisible({ timeout: 60_000 });
  await welcome(page).locator(".monaco-button", { hasText: "Set up" }).click();

  await expect(quickInput(page).locator(".quick-input-title")).toHaveText(step(1));
  await page.keyboard.type("https://fixture.invalid/");
  await page.keyboard.press("Enter");
  await expect(quickInput(page).locator(".quick-input-title")).toHaveText(step(2));
  // Lower case on purpose: the connector upper-cases the key while normalising
  // it beside its own box (connector.ts:76-77), and the trailing slash above is
  // stripped the same way — both are collected values, so both prove the THUNK
  // wrote what `configure` normalised, not what was typed.
  await page.keyboard.type("e2e");
  await page.keyboard.press("Enter");
  await expect(quickInput(page).locator(".quick-input-title")).toHaveText(step(REPOS_ROOT_STEP));
  await replace(page, `${sb.reposRoot}/`);
  await page.keyboard.press("Enter");
  await expect(quickInput(page).locator(".quick-input-title")).toHaveText(step(REPOS_ROOT_STEP + 1));
  await page.keyboard.type("e2e@fixture.invalid");
  await page.keyboard.press("Enter");
  await expect(quickInput(page).locator(".quick-input-title")).toHaveText(step(TOTAL));
  await page.keyboard.type("not-a-real-token");
  await page.keyboard.press("Enter");

  // The success toast is the wizard reaching its end (setup.ts:143).
  await expect(page.locator(".notification-list-item", { hasText: "Agent Flow Deck is set up" }))
    .toBeVisible({ timeout: 60_000 });
  await shot(page, testInfo, "1 · the wizard completed");

  // The assertion of record: one settings write for the connector's two settings
  // and Agent Flow's own pair, all at global scope, all normalised.
  await expect
    .poll(() => settingsJson()["agentFlow.jira.baseUrl"], { timeout: 30_000 })
    .toBe("https://fixture.invalid");
  expect(settingsJson()["agentFlow.jira.project"]).toBe("E2E");
  expect(settingsJson()["agentFlow.reposRoot"]).toBe(sb.reposRoot);
  // workspaceDir is derived from the repos root to keep the wizard short
  // (setup.ts:96-99), which is why one typed value lands twice.
  expect(settingsJson()["agentFlow.workspaceDir"]).toBe(sb.reposRoot);

  // `setupComplete` is only observable through its effect: the offer does NOT
  // come back on the next launch of the same sandbox — the inverse of the
  // relaunch in the Escape test above, which is this assertion's control.
  await app.close();
  const relaunched = await launchHost(sb);
  app = relaunched.app;
  const page2 = relaunched.page;
  // Wait for something the extension does on EVERY activation before concluding
  // the offer is absent, or the absence would only mean "not yet".
  await expect(page2.locator('.activitybar [aria-label*="Agent Flow"]').first())
    .toBeVisible({ timeout: 60_000 });
  await expect(welcome(page2)).toHaveCount(0);
  await shot(page2, testInfo, "2 · no offer on the next launch — setup is marked complete");
});

// Mutation-checked: `src/setup.ts`'s `maybeRunSetup` else-branch marking
// `SETUP_COMPLETE_KEY` true after "Later" — the offer then never returns and the
// relaunch assertion fails.
test("Later leaves everything unset", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;

  await expect(welcome(page)).toBeVisible({ timeout: 60_000 });
  const before = settings();
  await welcome(page).locator(".monaco-button", { hasText: "Later" }).click();
  await expect(welcome(page)).toHaveCount(0, { timeout: 15_000 });
  // No wizard was started, so no box is on screen to escape from.
  await expect(quickInput(page)).toBeHidden();
  await shot(page, testInfo, "1 · Later dismisses the offer without a wizard");

  expect(settings()).toBe(before);
  expect(settingsJson()["agentFlow.jira.baseUrl"]).toBe("");
  expect(settingsJson()["agentFlow.jira.project"]).toBe("");

  // Declining is explicitly non-nagging-but-not-final: the flag stays unset so
  // the offer comes back (setup.ts:176-179).
  await app.close();
  const relaunched = await launchHost(sb);
  app = relaunched.app;
  await expect(welcome(relaunched.page)).toBeVisible({ timeout: 60_000 });
  await shot(relaunched.page, testInfo, "2 · the offer returns after Later");
});

// Mutation-checked: `src/tasks/jira/connector.ts`'s `configure` writing inline
// (the thunk's two `c.update(...)` calls awaited before the return) — the
// re-run's cancelled boxes then overwrite the configured install and the byte
// compare fails.
test("Run Setup… on a configured install leaves config untouched when cancelled", async ({}, testInfo) => {
  test.setTimeout(180_000);
  // A CONFIGURED install this time, so `isConfigured()` is true: `maybeRunSetup`
  // marks setup complete and stays quiet, and the palette command is the only
  // way in.
  sb.dispose();
  sb = makeSandbox({
    "agentFlow.taskSource": "jira",
    "agentFlow.jira.baseUrl": "https://configured.invalid",
    "agentFlow.jira.project": "CONF",
  });
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;

  // Non-nagging: an install configured outside the wizard is never offered one.
  await expect(page.locator('.activitybar [aria-label*="Agent Flow"]').first())
    .toBeVisible({ timeout: 60_000 });
  await expect(welcome(page)).toHaveCount(0);
  const before = settings();

  // The bare command title, not the category-qualified one — see `runCommand`'s
  // doc comment. `thenTitle` is needed because this command replaces the palette
  // with its own box in the SAME widget, so the palette never goes hidden.
  await runCommand(page, "Run Setup", { thenTitle: step(1) });
  await shot(page, testInfo, "1 · Run Setup… re-runs the wizard on a configured install");

  // Both boxes answered with values DIFFERENT from what is configured, then
  // cancelled. This is the positive control for the byte compare: values the
  // wizard genuinely collected are what must not appear.
  await page.keyboard.type("https://overwritten.invalid");
  await page.keyboard.press("Enter");
  await expect(quickInput(page).locator(".quick-input-title")).toHaveText(step(2));
  await page.keyboard.type("OVER");
  await page.keyboard.press("Enter");
  await expect(quickInput(page).locator(".quick-input-title")).toHaveText(step(REPOS_ROOT_STEP));
  await page.keyboard.press("Escape");
  await expect(quickInput(page)).toBeHidden({ timeout: 15_000 });

  expect(settings()).toBe(before);
  expect(settingsJson()["agentFlow.jira.baseUrl"]).toBe("https://configured.invalid");
  expect(settingsJson()["agentFlow.jira.project"]).toBe("CONF");
  await shot(page, testInfo, "2 · the previous configuration survived the cancel");
});
