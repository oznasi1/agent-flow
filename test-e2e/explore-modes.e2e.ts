import * as fs from "fs";
import * as path from "path";
import { expect, test, type Page } from "@playwright/test";
import { describeWithHost, type HostCtx } from "./_helpers/sharedHost";
import { Pool } from "./_helpers/po/pool";
import { shot } from "./_helpers/shot";

/** Explore's own picker chain — `chooseExploreAction` → topic input box →
 *  `chooseEnvironment` (Verify only) → the shared repo picker — all render in the
 *  workbench's top-level quick-input widget, not inside the sidebar webview
 *  (`vscode.window.showQuickPick` / `showInputBox` in tasksView.ts), so every
 *  locator below is rooted at the PAGE, and only the Explore button lives in
 *  the webview frame. */
function quickInput(page: Page) {
  const widget = page.locator(".quick-input-widget");
  return {
    widget,
    title: widget.locator(".quick-input-title"),
    rows: widget.locator(".quick-input-list .monaco-list-row"),
  };
}

/** Same reduction `tasksView.ts:110 slugify` applies to a topic when it builds
 *  the plan key (`explore-<slug>` / `verify-<env>-<slug>`), copied here so a test
 *  can address the ONE plan file its own topic produced and never the directory. */
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

/** The prompt seeded into the plan file whose key starts with `keyPrefix-`.
 *  `writePlanFile` (engine/workspace.ts) names plans `<key>-<createdAt>.json` and
 *  stores the rendered prompt per repo in `matches[].prompt`; with one repo
 *  ("rocket") there is exactly one match. */
async function seededPrompt(ctx: HostCtx, keyPrefix: string): Promise<string> {
  const plans = path.join(ctx.sb().home, ".agentflow", "plans");
  await expect
    .poll(() => (fs.existsSync(plans) ? fs.readdirSync(plans).filter((f) => f.startsWith(`${keyPrefix}-`)) : []), {
      timeout: 60_000,
    })
    .toHaveLength(1);
  const file = fs.readdirSync(plans).find((f) => f.startsWith(`${keyPrefix}-`))!;
  const plan = JSON.parse(fs.readFileSync(path.join(plans, file), "utf8")) as { matches: { prompt: string }[] };
  expect(plan.matches).toHaveLength(1);
  return plan.matches[0].prompt;
}

/** Click Explore and wait for the first native prompt. Which prompt that is
 *  depends on `agentFlow.exploreMode`: unset ("ask", the manifest default) opens
 *  the kind picker; a pinned id skips straight to the topic box. */
async function clickExplore(ctx: HostCtx): Promise<Pool> {
  const pool = await Pool.open(ctx.page(), 2);
  await pool.frame.getByRole("button", { name: /explore/i }).click();
  await expect(quickInput(ctx.page()).widget).toBeVisible({ timeout: 15_000 });
  return pool;
}

/** Pick "Verify on an environment" and answer its required topic box — the two
 *  steps that stand between the kind picker and the environment picker. */
async function startVerify(ctx: HostCtx, topic: string): Promise<void> {
  const qi = quickInput(ctx.page());
  await expect(qi.title).toHaveText("Explore — what kind of session?");
  await qi.rows.filter({ hasText: "Verify on an environment" }).click();
  await expect(qi.title).toHaveText("Verify — which feature or change?");
  await ctx.page().keyboard.type(topic);
  await ctx.page().keyboard.press("Enter");
  await expect(qi.title).toHaveText("Verify — which environment?");
}

/** Explore's repo picker (`resolveKickoffTarget`, shared with the Notepad
 *  launcher) has no ticket to infer from and pre-checks nothing, so the row must
 *  be CLICKED — a keyboard Space lands in the filter box, not on the list, and
 *  Enter would then confirm an empty pick that opens nothing. */
async function pickRocketRepo(ctx: HostCtx): Promise<void> {
  const qi = quickInput(ctx.page());
  await expect(qi.widget).toBeVisible({ timeout: 15_000 });
  await qi.rows.filter({ hasText: "rocket" }).click();
  await ctx.page().keyboard.press("Enter");
}

// `agentFlow.exploreMode` is deliberately NOT set here: the sandbox pins nothing
// for it, the manifest default is "ask", and getConfig() reads `|| "ask"` — so
// clicking Explore opens the kind picker, which is the documented behaviour the
// first test asserts. `environments` is overridden to a two-item list so the
// environment picker's rows are provably the SETTING's, not the shipped defaults
// (dev / staging / production).
describeWithHost("explore modes", { "agentFlow.environments": ["dev", "qa"] }, (ctx) => {
  // Mutation-checked: removed the "debug" entry from EXPLORE_ACTION_DEFS (config.ts) — the picker rendered 5 rows.
  test("Explore offers the six documented session kinds", async ({}, testInfo) => {
    await clickExplore(ctx);
    const qi = quickInput(ctx.page());
    await expect(qi.title).toHaveText("Explore — what kind of session?");

    // Labels and order from EXPLORE_ACTION_DEFS (src/config.ts) on 2026-09-03.
    await expect(qi.rows).toHaveCount(6);
    await expect(qi.rows.nth(0)).toContainText("Open a Jira ticket");
    await expect(qi.rows.nth(1)).toContainText("Enhance knowledge / flow");
    await expect(qi.rows.nth(2)).toContainText("Debug");
    await expect(qi.rows.nth(3)).toContainText("General");
    await expect(qi.rows.nth(4)).toContainText("Supervise running tasks");
    await expect(qi.rows.nth(5)).toContainText("Verify on an environment");
    await shot(ctx.page(), testInfo, "1 · six session kinds");

    // Cancel: `chooseExploreAction` returns undefined and explore() opens nothing,
    // leaving the host exactly where the next test expects it.
    await ctx.page().keyboard.press("Escape");
    await expect(qi.widget).toBeHidden({ timeout: 15_000 });
  });

  // Mutation-checked: dropped the "$(edit) Custom…" item from chooseEnvironment (tasksView.ts) — the picker rendered 2 rows.
  test("Verify on an environment asks which, from the environments setting plus Custom", async ({}, testInfo) => {
    await clickExplore(ctx);
    await startVerify(ctx, "e2e verify picker probe");
    const qi = quickInput(ctx.page());

    // `chooseEnvironment` (tasksView.ts): cfg.environments in order, then the
    // Custom… escape hatch. The shipped defaults must NOT appear — the setting
    // replaced them, it did not layer over them.
    await expect(qi.rows).toHaveCount(3);
    await expect(qi.rows.nth(0)).toContainText("dev");
    await expect(qi.rows.nth(1)).toContainText("qa");
    await expect(qi.rows.nth(2)).toContainText("Custom…");
    await expect(qi.widget).not.toContainText("staging");
    await expect(qi.widget).not.toContainText("production");
    await shot(ctx.page(), testInfo, "2 · environment picker");

    // Cancel before the destination step: explore() returns at "env" having
    // created and opened nothing.
    await ctx.page().keyboard.press("Escape");
    await expect(qi.widget).toBeHidden({ timeout: 15_000 });
  });

  // Mutation-checked: applyExploreVars (engine/prompt.ts) left `{env}` unreplaced — the seeded prompt read "Environment: {env}".
  test("a verify session is seeded read-only against the chosen environment", async ({}, testInfo) => {
    const topic = `e2e verify probe ${Date.now()}`;
    await clickExplore(ctx);
    await startVerify(ctx, topic);
    const qi = quickInput(ctx.page());
    await qi.rows.filter({ hasText: "qa" }).click();

    // `agentFlow.openIn: "new-window"` (sandbox default) resolves the destination
    // with no picker, so the next prompt is the repo picker.
    await pickRocketRepo(ctx);

    // explore() keys a verify plan `verify-<slugify(env)>-<slugify(topic)>`.
    const prompt = await seededPrompt(ctx, `verify-qa-${slugify(topic)}`);
    // The environment reached the prompt through {env} (applyExploreVars), and the
    // read-only clause is quoted from DEFAULT_EXPLORE_VERIFY_PROMPT (src/config.ts).
    expect(prompt).toContain("Environment: qa.");
    expect(prompt).toContain("Read-only: don't change code, and don't mutate the environment.");
    expect(prompt).not.toContain("{env}");
    await shot(ctx.page(), testInfo, "3 · verify session launched");
  });
});

// A second boot, because a pinned mode and a prompt override are settings the
// host reads at explore() time from settings.json — which the sandbox writes
// once, before launch. Pinning `general` also proves the other half of
// `agentFlow.exploreMode`: the kind picker is skipped and the first prompt is the
// topic box.
describeWithHost(
  "explore modes · pinned general",
  {
    "agentFlow.exploreMode": "general",
    "agentFlow.explorePrompts.general": "E2E-EXPLORE-MARKER focus={summary}",
  },
  (ctx) => {
    // Mutation-checked: getConfig()'s resolvePrompt (config.ts) returned def.defaultPrompt, ignoring the setting — the seeded prompt had no marker.
    test("an explorePrompts override lands in the plan", async ({}, testInfo) => {
      const topic = `e2e general probe ${Date.now()}`;
      await clickExplore(ctx);
      const qi = quickInput(ctx.page());
      // No kind picker: `chooseExploreAction` found the pinned id and returned it.
      await expect(qi.title).toHaveText("Explore — what do you want to dig into?");
      await ctx.page().keyboard.type(topic);
      await ctx.page().keyboard.press("Enter");
      await pickRocketRepo(ctx);

      const prompt = await seededPrompt(ctx, `explore-${slugify(topic)}`);
      // The override replaced the shipped General prompt wholesale, and its
      // {summary} placeholder was filled with the typed topic.
      expect(prompt).toContain(`E2E-EXPLORE-MARKER focus=${topic}`);
      expect(prompt).not.toContain("Working session.");
      await shot(ctx.page(), testInfo, "4 · override seeded");
    });
  },
);
