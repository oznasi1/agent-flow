import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { expect, test } from "@playwright/test";
import { describeWithHost } from "./_helpers/sharedHost";
import { Pool } from "./_helpers/po/pool";
import { FIXTURE_CHILD, FIXTURE_TASK, FIXTURE_TASK_2, writeFixtureConfig, type Sandbox } from "./_helpers/sandbox";
import { shot } from "./_helpers/shot";

// The pool's lens row, proven one host per connector/settings shape. Every block
// is read-only against the pool (no writes, no windows, no worktrees), so one
// Electron boot per `describeWithHost` is the honest unit: the fixture's
// `config.json` caps and the `agentFlow.filters.*` settings are both read ONCE at
// panel init, which is why each shape needs its own boot and the shaping happens
// in `describeWithHost`'s `prepare` hook — before the host is up — never in a
// `beforeAll` inside the block (that fires after launch, too late).
//
// What this file deliberately does NOT claim: that the S/M/L control NARROWS the
// pool. The `TaskProvider.list(lens, size)` seam hands size to the source (the Jira
// client folds it into JQL — src/tasks/jira/client.ts:244-251), and the fixture
// connector's `list()` ignores both arguments (src/tasks/fixture/connector.ts:126).
// The real-host lane can therefore prove the control renders, is pressable, and
// renders estimates against the 8-hour workday the docs promise — the narrowing
// itself is the source's contract, cited to its unit tests in COVERAGE.md.

/** A second discovered repo. Without it the repo lens has exactly one option
 *  ("rocket", which every fixture summary names), so selecting it could never
 *  narrow anything and the lens test would be vacuous. E2E-1's summary names
 *  "telemetry"; E2E-2's does not — the split the repo-lens test asserts on. Same
 *  recipe as `sidebar-actions.e2e.ts`, but in `prepare` rather than `beforeAll`
 *  because services are inferred at list time (tasksView.ts's `guessServices`)
 *  and the first list happens the moment the sidebar opens. */
function addTelemetryRepo(sb: Sandbox): void {
  const telemetryPath = path.join(sb.reposRoot, "telemetry");
  fs.mkdirSync(telemetryPath, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: telemetryPath });
  fs.writeFileSync(path.join(telemetryPath, "README.md"), "# telemetry\n");
  execFileSync("git", ["add", "."], { cwd: telemetryPath });
  execFileSync(
    "git",
    ["-c", "user.email=e2e@fixture.invalid", "-c", "user.name=E2E", "commit", "-qm", "init"],
    { cwd: telemetryPath },
  );
}

describeWithHost("pool lenses · default fixture", {}, (ctx) => {
  // The fixture connector's shipped caps are `supportedFilters: ["mine", "all",
  // "mysprint"]` and `sizes: false` (src/tasks/fixture/connector.ts:41,84). Three of
  // the five tabs must therefore be ABSENT — `toHaveCount(0)`, never "disabled":
  // a greyed-out lens would still be a lens the source cannot answer.
  //
  // The three product-side lenses (status row, repo multiselect, search box) are
  // asserted PRESENT here, in the one block that leaves every `agentFlow.filters.*`
  // at its default. The "filters off" block below can only ever show absence, so
  // this is where its four hide-tests get their positive half.
  // Mutation-checked: App.tsx:586 `visibleFilters(caps.supportedFilters)` → `visibleFilters(DEFAULT_CAPS.supportedFilters)` (every tab rendered regardless of caps) — Unassigned/Sprint/Backlog counts went 0→1.
  test("only the lenses the connector declares render", async ({}, testInfo) => {
    const pool = await Pool.open(ctx.page(), 2);
    await expect(pool.filterGroup()).toBeVisible();
    // Exactly the declared pair, in `FILTER_ORDER` (helpers.ts:63) — not the
    // connector's own array order, and without "all" (never a tab).
    await expect(pool.filterGroup().getByRole("button")).toHaveText(["My sprint", "Mine"]);
    await expect(pool.filterTab("Mine")).toBeVisible();
    await expect(pool.filterTab("My sprint")).toBeVisible();
    await expect(pool.filterTab("Unassigned")).toHaveCount(0);
    await expect(pool.filterTab("Sprint")).toHaveCount(0);
    await expect(pool.filterTab("Backlog")).toHaveCount(0);
    // `sizes: false` → no S/M/L control at all (App.tsx:598).
    await expect(pool.sizeGroup()).toHaveCount(0);
    // The product-side lenses, on by default: the status row derives its chips
    // from the loaded pool (helpers.ts:168) — both fixture tasks are "To Do".
    await expect(pool.statusGroup()).toBeVisible();
    await expect(pool.statusGroup().getByRole("button")).toHaveText(["All", "To Do"]);
    await expect(pool.repoTrigger()).toBeVisible();
    await expect(pool.searchBox()).toBeVisible();
    await shot(ctx.page(), testInfo, "1 · declared lenses only");
  });

  // Fuse.js over `summary` + `key` at threshold 0.4 (App.tsx:463-465). "landng
  // gear" is "landing gear" with a letter dropped: a plain substring match would
  // find nothing, so ONE surviving card is the fuzzy pass at work — and it must
  // be the landing-gear task, not merely "some card".
  // Mutation-checked: App.tsx:464 Fuse `threshold: 0.4` → `threshold: 0` (exact matches only) — the misspelt query left 0 cards.
  test("title search narrows the pool fuzzily", async ({}, testInfo) => {
    const pool = await Pool.open(ctx.page(), 2);
    await pool.searchBox().fill("landng gear");
    await expect(pool.cards()).toHaveCount(1, { timeout: 15_000 });
    await expect(pool.card(FIXTURE_TASK_2.key)).toBeVisible();
    await expect(pool.card(FIXTURE_TASK.key)).toHaveCount(0);
    await shot(ctx.page(), testInfo, "2 · fuzzy title search");
    // Leave the pool where the next test expects it: the "×" clear glyph
    // (App.tsx:662-663) empties the query and both cards come back.
    await pool.frame.locator(".text-search-clear").click();
    await expect(pool.cards()).toHaveCount(2, { timeout: 15_000 });
  });

  // `t.services` is inferred per task at list time from the summary against the
  // discovered repos (tasksView.ts:803-804 → engine/infer.ts): E2E-1 "Fix the
  // rocket telemetry panel" lands on both repos, E2E-2 "Refit the rocket landing
  // gear" on rocket alone. Selecting "telemetry" must keep exactly the first.
  // Mutation-checked: App.tsx:484 `selectedRepos.size === 0 ||` → `true ||` (repo selection ignored) — both cards stayed.
  test("the repo lens narrows the pool to tasks inferred onto that repo", async ({}, testInfo) => {
    const pool = await Pool.open(ctx.page(), 2);
    await pool.selectRepo("telemetry");
    await expect(pool.cards()).toHaveCount(1, { timeout: 15_000 });
    await expect(pool.card(FIXTURE_TASK.key)).toBeVisible();
    await expect(pool.card(FIXTURE_TASK_2.key)).toHaveCount(0);
    // The trigger carries the selection count (App.tsx:1141) — the lens is
    // visibly engaged, not just coincidentally showing one card.
    await expect(pool.repoTrigger().locator(".repo-count")).toHaveText("1");
    await shot(ctx.page(), testInfo, "3 · repo lens on telemetry");
  });
}, addTelemetryRepo);

describeWithHost("pool lenses · mine and all only", {}, (ctx) => {
  // `["mine", "all"]`: the shipped trio minus "mysprint". The tab that goes is
  // the one the fixture normally renders FIRST, so this cannot pass by accident
  // of ordering — and "all" staying in the list adds nothing (see the next block).
  // Mutation-checked: App.tsx:586 `visibleFilters(caps.supportedFilters)` → `visibleFilters(DEFAULT_CAPS.supportedFilters)` — "My sprint" rendered despite the connector dropping it.
  test("dropping mysprint from supportedFilters removes that lens", async ({}, testInfo) => {
    const pool = await Pool.open(ctx.page(), 2);
    await expect(pool.filterGroup().getByRole("button")).toHaveText(["Mine"]);
    await expect(pool.filterTab("My sprint")).toHaveCount(0);
    await expect(pool.filterTab("Mine")).toBeVisible();
    // The one remaining lens is also the active one — `agentFlow.defaultFilter`
    // is "mine" in the sandbox contract (sandbox.ts) and it is still supported.
    await expect(pool.filterTab("Mine")).toHaveAttribute("aria-pressed", "true");
    await shot(ctx.page(), testInfo, "1 · mysprint dropped");
  });
}, (sb) => writeFixtureConfig(sb, { supportedFilters: ["mine", "all"] }));

describeWithHost("pool lenses · every filter, mysprint default", { "agentFlow.defaultFilter": "mysprint" }, (ctx) => {
  // All six `Filter` values declared, "all" included. `FILTER_ORDER`
  // (helpers.ts:63) has five entries and "all" is not one of them, so the group
  // renders five buttons and none is named "All" — `exact: true`, because the
  // status row's own "All" chip (App.tsx:626) lives in a different group.
  // Mutation-checked: helpers.ts:63 `FILTER_ORDER` gained `"all"` — a sixth "All" tab rendered.
  test('the "all" filter never renders as a sixth tab', async ({}, testInfo) => {
    const pool = await Pool.open(ctx.page(), 2);
    await expect(pool.filterGroup().getByRole("button")).toHaveCount(5);
    await expect(pool.filterGroup().getByRole("button"))
      .toHaveText(["My sprint", "Mine", "Sprint", "Backlog", "Unassigned"]);
    await expect(pool.filterTab("All")).toHaveCount(0);
    await shot(ctx.page(), testInfo, "1 · five tabs, no All");
  });

  // The sandbox pins `agentFlow.defaultFilter: "mine"` for every other journey
  // (sandbox.ts); this block overrides it to "mysprint". The first fetch is
  // `{ type: "fetch", filter: cfg.defaultFilter }` (tasksView.ts:728), and the
  // webview highlights whatever lens that fetch answered with.
  // Mutation-checked: tasksView.ts:728 `cfg.defaultFilter as Filter` → `"mine"` — "Mine" opened pressed instead of "My sprint".
  test("defaultFilter picks the lens the panel opens on", async ({}, testInfo) => {
    const pool = await Pool.open(ctx.page(), 2);
    await expect(pool.filterTab("My sprint")).toHaveAttribute("aria-pressed", "true");
    await expect(pool.filterTab("Mine")).toHaveAttribute("aria-pressed", "false");
    await shot(ctx.page(), testInfo, "2 · opens on My sprint");
  });
}, (sb) => writeFixtureConfig(sb, { supportedFilters: ["mine", "all", "mysprint", "unassigned", "sprint", "backlog"] }));

/** Three top-level tasks with original estimates of 1h, 1 workday and 3 workdays.
 *  86400s is a calendar day, but the docs promise an 8-hour workday — so the
 *  card must read "3d", not "1d". The child stays parented, so it stays out of
 *  `list()` and the pool is exactly three. */
const SIZED_TASKS = [
  { ...FIXTURE_TASK, estimateSeconds: 3600 },
  { ...FIXTURE_TASK_2, estimateSeconds: 28800 },
  {
    ...FIXTURE_TASK, key: "E2E-3", summary: "Rebuild the rocket ignition sequencer",
    url: "https://fixture.invalid/browse/E2E-3", descriptionText: "The sequencer skips stage two.",
    estimateSeconds: 86400,
  },
  FIXTURE_CHILD,
];

describeWithHost("pool lenses · connector with estimates", {}, (ctx) => {
  // The other half of the default block's `sizeGroup() → 0`: flip `caps.sizes`
  // on and the S/M/L control appears, with the four `SIZES` (App.tsx:50-55).
  // Mutation-checked: helpers.ts:145 `fmtEst` `h / 8` → `h / 24` (calendar day instead of workday) — E2E-3 read "1d", not "3d".
  test("the size lens renders only when the connector has estimates", async ({}, testInfo) => {
    const pool = await Pool.open(ctx.page(), 3);
    await expect(pool.sizeGroup()).toBeVisible();
    await expect(pool.sizeGroup().getByRole("button")).toHaveText(["Any", "S", "M", "L"]);
    await expect(pool.sizeGroup().getByRole("button", { name: "Any", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    // The 8-hour workday, on the card itself (`.est`, App.tsx:948-949 → `fmtEst`).
    await expect(pool.card("E2E-3").locator(".est")).toHaveText("⏱ 3d");
    await expect(pool.card(FIXTURE_TASK_2.key).locator(".est")).toHaveText("⏱ 1d");
    await expect(pool.card(FIXTURE_TASK.key).locator(".est")).toHaveText("⏱ 1h");
    // Pressing L refetches with `size: "l"` (App.tsx:607 → tasksView.ts:799). The
    // fixture ignores the size argument (see the file header), so the honest
    // assertion is that the control took the press and the pool re-rendered —
    // not a narrowed count this source cannot produce.
    await pool.sizeGroup().getByRole("button", { name: "L", exact: true }).click();
    await expect(pool.sizeGroup().getByRole("button", { name: "L", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    await expect(pool.cards()).toHaveCount(3, { timeout: 15_000 });
    await shot(ctx.page(), testInfo, "1 · size lens, L pressed");
  });
}, (sb) => {
  writeFixtureConfig(sb, { sizes: true });
  fs.writeFileSync(path.join(sb.fixtureDir, "tasks.json"), JSON.stringify(SIZED_TASKS, null, 2));
});

describeWithHost(
  "pool lenses · filters off",
  {
    "agentFlow.filters.status": false,
    "agentFlow.filters.repo": false,
    "agentFlow.filters.search": false,
    "agentFlow.filters.size": false,
  },
  (ctx) => {
    // Every positive half of these four lives in the default block above (same
    // fixture shape, so the same pool would otherwise render all four). Here the
    // connector even declares `sizes: true`, so the size lens is hidden by the
    // SETTING alone, not for want of estimates.
    // Mutation-checked: App.tsx:616 `filters.status && availableStatuses.length > 0` → `availableStatuses.length > 0` — the status row rendered.
    test("filters.status false hides the status lens", async ({}, testInfo) => {
      const pool = await Pool.open(ctx.page(), 2);
      await expect(pool.filterGroup()).toBeVisible(); // the row itself is up; only the status lens is gone
      await expect(pool.statusGroup()).toHaveCount(0);
      await shot(ctx.page(), testInfo, "1 · no status lens");
    });

    // Mutation-checked: App.tsx:641 `{filters.repo && (` → `{true && (` — the repo trigger rendered.
    test("filters.repo false hides the repo lens", async () => {
      const pool = await Pool.open(ctx.page(), 2);
      await expect(pool.repoTrigger()).toHaveCount(0);
    });

    // Mutation-checked: App.tsx:650 `{filters.search && (` → `{true && (` — the search box rendered.
    test("filters.search false hides the search box", async () => {
      const pool = await Pool.open(ctx.page(), 2);
      await expect(pool.searchBox()).toHaveCount(0);
    });

    // Mutation-checked: App.tsx:598 `{caps.sizes && filters.size && (` → `{caps.sizes && (` — the S/M/L control rendered.
    test("filters.size false hides the size lens even when the connector has estimates", async ({}, testInfo) => {
      const pool = await Pool.open(ctx.page(), 2);
      await expect(pool.sizeGroup()).toHaveCount(0);
      await shot(ctx.page(), testInfo, "2 · size lens hidden by setting");
    });
  },
  (sb) => writeFixtureConfig(sb, { sizes: true }),
);
