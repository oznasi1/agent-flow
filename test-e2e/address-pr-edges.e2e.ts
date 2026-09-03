import { test, expect } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { makeSandbox, FIXTURE_TASK, type Sandbox } from "./_helpers/sandbox";
import { launchHost } from "./_helpers/host";
import { Pool } from "./_helpers/po/pool";
import { shot } from "./_helpers/shot";

/** The edges around the sidebar's Address PR action that address-pr.e2e.ts does not
 *  reach: the status gate's case-insensitivity and its negative half, the assess-only
 *  prompt, and a user-authored prompt. Every prompt assertion reads the plan file the
 *  session seed consumes (`~/.agentflow/plans/<key>-*.json`, `matches[].prompt`) — the
 *  same record of assertion as the sibling journey, because it is what the launched
 *  window actually seeds.
 *
 *  The wording asserted below is QUOTED from src/config.ts (DEFAULT_PR_REVIEW_PROMPT)
 *  and src/engine/prompt.ts (PR_REVIEW_AUTOFIX_CLAUSE) rather than imported: an
 *  import would make a mutation of the constant itself invisible to the test. */

let sb: Sandbox | undefined;
let app: ElectronApplication | undefined;

async function boot(settings: Record<string, unknown>): Promise<Page> {
  sb = makeSandbox(settings);
  const launched = await launchHost(sb);
  app = launched.app;
  return launched.page;
}

async function teardown(): Promise<void> {
  try {
    await app?.close();
  } finally {
    app = undefined;
    sb?.dispose();
    sb = undefined;
  }
}

test.afterEach(teardown);

/** Drive the card's Address PR through the repo-confirm QuickPick and return the
 *  seeded prompt(s) joined. Mirrors address-pr.e2e.ts step for step; the worktree and
 *  window facts it proves are not re-proven here. */
async function seedAddressPr(page: Page, testInfo: ReturnType<typeof test.info>): Promise<string> {
  const pool = await Pool.open(page, 2);
  const card = pool.card(FIXTURE_TASK.key);
  await expect(card).toBeVisible({ timeout: 30_000 });
  // App.tsx:932 on 2026-09-03 — `button.address-pr`, rendered only while canAddressPr.
  await card.locator("button.address-pr").click();

  const quickInput = page.locator(".quick-input-widget");
  await expect(quickInput).toBeVisible({ timeout: 15_000 });
  await expect(quickInput).toContainText("rocket");
  await shot(page, testInfo, "1 · repos confirmed");
  const newWindow = app!.waitForEvent("window", { timeout: 60_000 });
  await page.keyboard.press("Enter");
  const opened = await newWindow;
  await opened.locator(".activitybar").waitFor({ timeout: 60_000 });

  const planDir = path.join(sb!.home, ".agentflow", "plans");
  await expect.poll(() => (fs.existsSync(planDir) ? fs.readdirSync(planDir) : []), { timeout: 30_000 })
    .not.toHaveLength(0);
  const planFile = fs.readdirSync(planDir).find((f) => f.startsWith(`${FIXTURE_TASK.key}-`));
  expect(planFile).toBeDefined();
  const plan = JSON.parse(fs.readFileSync(path.join(planDir, planFile!), "utf8"));
  expect(plan).toMatchObject({ key: FIXTURE_TASK.key, seedAgent: true });
  await shot(opened, testInfo, "2 · seeded");
  return (plan.matches as { prompt: string }[]).map((m) => m.prompt).join("\n");
}

// Mutation-checked: isPrReviewStatus (webview/helpers.ts) compared without toLowerCase()
// on either side — the "to do" host then rendered 0 buttons against the fixture's "To Do".
test("Address PR appears only when the status matches prReviewStatus, case-insensitively", async ({}, testInfo) => {
  test.setTimeout(240_000);

  // Host 1: the setting is spelt in a different case from the fixture task's own
  // status ("To Do"). isPrReviewStatus lower-cases both sides, so this MUST match —
  // and it is the only difference from the sibling journey's settings, which pin the
  // status verbatim and so never exercise the fold.
  expect(FIXTURE_TASK.status).toBe("To Do");
  const matching = await boot({ "agentFlow.prReviewStatus": "to do" });
  const pool = await Pool.open(matching, 2);
  await expect(pool.card(FIXTURE_TASK.key).locator("button.address-pr")).toHaveCount(1);
  // Both fixture tasks share the status, so the whole pool shows exactly two.
  await expect(pool.frame.locator("button.address-pr")).toHaveCount(2);
  await expect(pool.frame.locator("button.address-pr").first()).toHaveText(/Address PR/);
  await shot(matching, testInfo, "1 · status matches, button present");
  await teardown();

  // Host 2: a status neither task carries. The button must be absent from every card
  // while the card action row itself is rendered — `button.take` sits beside it
  // (App.tsx:938), so its count of 2 is what stops a blank pool from passing this
  // as a false zero.
  const nonMatching = await boot({ "agentFlow.prReviewStatus": "Done" });
  const pool2 = await Pool.open(nonMatching, 2);
  await expect(pool2.frame.locator("button.take")).toHaveCount(2);
  await expect(pool2.frame.locator("button.address-pr")).toHaveCount(0);
  await shot(nonMatching, testInfo, "2 · status differs, button absent");
});

// Mutation-checked: prReviewTemplate (engine/prompt.ts) appended PR_REVIEW_AUTOFIX_CLAUSE
// regardless of autoFix — the seeded prompt then carried the implement instruction.
test("prReviewAutoFix off seeds an assess-only prompt", async ({}, testInfo) => {
  test.setTimeout(240_000);
  // The sandbox contract's `worktree: "never"` stands, as in address-pr.e2e.ts: addressPr
  // forces a worktree regardless, and every other picker is pre-answered.
  const page = await boot({ "agentFlow.prReviewStatus": FIXTURE_TASK.status, "agentFlow.prReviewAutoFix": false });
  const seeded = await seedAddressPr(page, testInfo);

  // The shipped assess wording (DEFAULT_PR_REVIEW_PROMPT, config.ts) is there …
  expect(seeded).toContain(FIXTURE_TASK.key);
  expect(seeded).toContain("gh pr checkout");
  expect(seeded).toContain("assess whether it's ready for us to work on");
  expect(seeded).toContain("Summarize what you find.");
  // … and the auto-fix clause (PR_REVIEW_AUTOFIX_CLAUSE, engine/prompt.ts), which the
  // default `prReviewAutoFix: true` would have inserted before {files}, is not.
  expect(seeded).not.toContain("implement the requested changes");
  expect(seeded).not.toContain("do not push or merge without me");
});

// Mutation-checked: addressPr (tasksView.ts) seeded DEFAULT_PR_REVIEW_PROMPT in place of
// cfg.prReviewPrompt — the marker never reached the plan file.
test("a custom prReviewPrompt is what gets seeded", async ({}, testInfo) => {
  test.setTimeout(240_000);
  // prReviewAutoFix is left at its default (true) on purpose: SETTINGS.md says the
  // fixing instruction is appended to the user's prompt when auto-fix is on, and a
  // template with no {files} placeholder gets it appended at the end
  // (insertBeforeFiles, engine/prompt.ts).
  const page = await boot({ "agentFlow.prReviewStatus": FIXTURE_TASK.status, "agentFlow.prReviewPrompt": "E2E-PR-MARKER {key}" });
  const seeded = await seedAddressPr(page, testInfo);

  // The user's words, with {key} substituted (renderPrompt, engine/prompt.ts) …
  expect(seeded).toContain(`E2E-PR-MARKER ${FIXTURE_TASK.key}`);
  // … followed by the appended auto-fix clause …
  expect(seeded).toContain("If it's ready, go ahead and implement the requested changes on this branch");
  expect(seeded.indexOf("E2E-PR-MARKER")).toBeLessThan(seeded.indexOf("implement the requested changes"));
  // … and none of the shipped default: the custom prompt replaces it rather than
  // being layered on top.
  expect(seeded).not.toContain("gh pr checkout");
  expect(seeded).not.toContain("assess whether it's ready for us to work on");
});
