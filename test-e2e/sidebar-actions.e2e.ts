import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { expect, test } from "@playwright/test";
import { describeWithHost } from "./_helpers/sharedHost";
import { Pool } from "./_helpers/po/pool";
import { FIXTURE_TASK } from "./_helpers/sandbox";
import { shot } from "./_helpers/shot";

/** Read every write the extension has recorded so far. Append-only, so a test
 *  asserts the line IT caused by op+key and ignores its siblings' lines. */
function writes(fixtureDir: string): Record<string, unknown>[] {
  const f = path.join(fixtureDir, "writes.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// `agentFlow.exploreMode: "general"` pre-answers the "Explore — what kind of
// session?" QuickPick the same way the sandbox's other settings pre-answer
// every other mid-take prompt (see sandbox.ts) — without it, clicking Explore
// opens a picker this journey would otherwise have to drive blind.
describeWithHost("sidebar actions", { "agentFlow.exploreMode": "general" }, (ctx) => {
  // The fixture's only repo is "rocket" (sandbox.ts), which matches none of the
  // fixture connector's components ("landing-gear", "telemetry" — see
  // src/tasks/fixture/connector.ts's `caps.components.list`). `resolveComponent`
  // (src/engine/components.ts) matches a chip to a component by exact repo-name
  // fold, so no chip could ever produce a `setComponents` write without a repo
  // actually named after one of them. This adds that repo — not a capability the
  // product lacks, just test fixture data the earlier task didn't provide — so the
  // component test below exercises the REAL push affordance instead of a fabricated
  // one. Added before any test runs (a `beforeAll` registered after
  // `describeWithHost`'s own, so `ctx.sb()` is already populated when it fires),
  // because `discoverRepos` is read fresh per "detail" request but the webview
  // caches `details[key]` for the life of the session (see App.tsx's
  // `toggleExpand`) — added later would miss the first, and only, detail fetch.
  test.beforeAll(() => {
    const telemetryPath = path.join(ctx.sb().reposRoot, "telemetry");
    fs.mkdirSync(telemetryPath, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: telemetryPath });
    fs.writeFileSync(path.join(telemetryPath, "README.md"), "# telemetry\n");
    execFileSync("git", ["add", "."], { cwd: telemetryPath });
    execFileSync(
      "git",
      ["-c", "user.email=e2e@fixture.invalid", "-c", "user.name=E2E", "commit", "-qm", "init"],
      { cwd: telemetryPath },
    );
  });

  test("the detail panel renders the task's description", async ({}, testInfo) => {
    const pool = await Pool.open(ctx.page(), 2);
    await pool.card(FIXTURE_TASK.key).click();
    await expect(pool.frame.getByText(FIXTURE_TASK.descriptionText)).toBeVisible({ timeout: 15_000 });
    await shot(ctx.page(), testInfo, "1 · detail panel");
  });

  // BLOCKER (not implemented) — "adding a label" per the brief's script assumes a
  // direct affordance (a "label" button, then typed free text) that does not exist
  // anywhere in src/webview/App.tsx: there is no `send({ type: "addLabel", ... })`
  // call, no `case "addLabel"` in tasksView.ts's message switch, and the only
  // caller of `caps.labels.add` is the PRIVATE `stampProvenance` helper
  // (tasksView.ts ~line 287), fired automatically as a side effect of every OTHER
  // write (addToMySprint / removeFromSprint / setComponent / moveTo), gated on
  // `agentFlow.stampLabelOnWrite` (default true) and always stamping the FIXED
  // `agentFlow.provenanceLabel` (default "claude-code") — never arbitrary user
  // text. A user cannot type "needs-e2e" through this UI because no control
  // accepts free-form label text. This is a capability gap in the product (or in
  // an earlier task's fixture wiring), not a locator to repair — see the report.
  //
  // The one honest way to exercise `addLabel` for real is as the side effect of a
  // genuine write, which the next test does (it asserts BOTH `addToSprint` and the
  // `addLabel` provenance stamp that follows it).

  test("adding to sprint records addToSprint and stamps the provenance label", async ({}, testInfo) => {
    // Not `Pool.open`: `openTasksView` clicks the activity-bar icon unconditionally,
    // and VS Code TOGGLES a view container's visibility on a second click of its
    // own icon — since test 1 already left Agent Flow focused, re-clicking here
    // collapses the sidebar instead of opening it, and `pool.cards()` then times
    // out at 0. Every test after the first constructs `Pool` directly against the
    // still-open webview instead. See the report.
    const pool = new Pool(ctx.page());
    await expect(pool.cards()).toHaveCount(2, { timeout: 30_000 });
    await pool.card(FIXTURE_TASK.key).getByRole("button", { name: /add to my sprint/i }).click();
    await expect
      .poll(() => writes(ctx.sb().fixtureDir).filter((w) => w.op === "addToSprint" && w.key === FIXTURE_TASK.key))
      .toHaveLength(1);
    // The provenance stamp — real `addLabel` coverage, via the only path that ever
    // produces one. See the blocker note above the previous test.
    await expect
      .poll(() => writes(ctx.sb().fixtureDir).filter((w) => w.op === "addLabel" && w.key === FIXTURE_TASK.key))
      .toHaveLength(1);
    await shot(ctx.page(), testInfo, "2 · added to sprint");
  });

  // BLOCKER (not implemented) — the brief's second half ("click sprint again to
  // remove") and the whole reorder/reset-order journey both require the
  // "mysprint" filter tab to be selectable. It never is for this fixture:
  // src/tasks/fixture/connector.ts's `caps.supportedFilters` is `["mine", "all"]`
  // (verbatim from Task 3's brief, reviewed and committed as e23930a), and
  // `visibleFilters`/`effectiveFilter` (src/webview/helpers.ts) only ever render a
  // "My sprint" tab when "mysprint" is in that list — it isn't, so the tab never
  // renders. Two features are gated behind exactly that tab:
  //   - The "Remove from sprint" icon button: App.tsx's `onRemoveFromSprint` prop
  //     is only ever passed `filter === "mysprint" && caps.sprints ? … : undefined`
  //     (App.tsx ~line 684) — with no "mysprint" tab reachable, it is always
  //     `undefined` and the button never renders on any card, in any lens.
  //   - The whole reorder feature: `canReorder = filter === "mysprint" && …`
  //     (App.tsx ~line 460), and the `.reorder-bar` / "Reset order" button render
  //     only inside `{filter === "mysprint" && caps.sprints && …}` (App.tsx ~line
  //     627). No drag handle (`.grip`) and no "Reset order" button exist outside
  //     that lens.
  // This is a genuine "capability still hidden" case per the task's own policy —
  // see the report for the recommended fix (add "mysprint" to the fixture's
  // `supportedFilters`).

  test("setting a component records the delta the picker produced", async () => {
    // Not `Pool.open` — see the comment on the sprint test above.
    const pool = new Pool(ctx.page());
    await expect(pool.cards()).toHaveCount(2, { timeout: 30_000 });
    const card = pool.card(FIXTURE_TASK.key);
    // The card may already be expanded (test 1 opened it in this shared session);
    // only click to expand if the detail panel isn't showing yet.
    if (!(await card.locator(".detail").isVisible())) {
      await card.locator(".card-main").click();
    }
    // The brief imagined a QuickPick with checkable "component" options — the real
    // affordance (src/webview/App.tsx ~line 998) is a "↑" push glyph on the repo
    // chip itself, shown only for a repo whose name resolves to an actual project
    // component (src/engine/components.ts's `resolveComponent`, exact fold match).
    // "telemetry" is a project component (src/tasks/fixture/connector.ts) and now
    // also a discovered repo (this file's own `beforeAll`), and it gets inferred
    // onto E2E-1 by `inferServices` because the summary contains the word
    // "telemetry" (sandbox.ts's FIXTURE_TASK.summary) — so its chip renders with
    // the push glyph with no extra setup.
    const telemetryChip = card.locator(".chip", { hasText: "telemetry" });
    await expect(telemetryChip).toBeVisible({ timeout: 15_000 });
    await telemetryChip.locator(".up").click();
    await expect
      .poll(() => writes(ctx.sb().fixtureDir).find((w) => w.op === "setComponents" && w.key === FIXTURE_TASK.key))
      .toMatchObject({ add: ["telemetry"] });
  });

  test("Explore launches and lands a plan file", async ({}, testInfo) => {
    // Not `Pool.open` — see the comment on the previous test.
    const pool = new Pool(ctx.page());
    await expect(pool.cards()).toHaveCount(2, { timeout: 30_000 });
    await pool.frame.getByRole("button", { name: /explore/i }).click();

    // `agentFlow.exploreMode: "general"` (this describe's own settings override)
    // skips the "Explore — what kind of session?" QuickPick, so the first native
    // prompt is straight to the topic input box (tasksView.ts's `chooseExploreAction`).
    const quickInput = ctx.page().locator(".quick-input-widget");
    await expect(quickInput).toBeVisible({ timeout: 15_000 });
    await ctx.page().keyboard.type("look at the telemetry panel");
    await ctx.page().keyboard.press("Enter");

    // `agentFlow.openIn: "new-window"` resolves the destination with no picker
    // (engine/openTarget.ts's `chooseOpenTarget`), but Explore's own repo picker
    // (tasksView.ts's `resolveKickoffTarget`, shared with the Notepad launcher)
    // has no ticket to infer from and so pre-checks nothing — unlike Take's
    // repo-confirm QuickPick, this one needs an explicit selection or it submits
    // zero repos and `explore()` returns having opened nothing ("0 Selected"
    // stays 0, confirmed by driving this live). `Space` does not toggle a
    // canPickMany row here — clicking the row itself does, which is also what a
    // real user does with a mouse.
    await expect(quickInput).toBeVisible({ timeout: 15_000 });
    await quickInput.getByText("rocket", { exact: true }).click();
    await ctx.page().keyboard.press("Enter");

    const plans = path.join(ctx.sb().home, ".agentflow", "plans");
    await expect.poll(
      () => (fs.existsSync(plans) ? fs.readdirSync(plans).filter((f) => f.includes("explore")) : []),
      { timeout: 60_000 },
    ).not.toHaveLength(0);
    await shot(ctx.page(), testInfo, "3 · explore launched");
  });
});
