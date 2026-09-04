import { expect, test, type Page } from "@playwright/test";
import { describeWithHost } from "./_helpers/sharedHost";
import { Marketplace } from "./_helpers/po/marketplace";
import { runCommand } from "./_helpers/palette";
import { seedClaudeAssets } from "./_helpers/sandbox";
import { shot } from "./_helpers/shot";

// The Marketplace's filter row, against a seeded marketplace catalog rich enough
// that every dimension has a positive AND a negative case: type, scope, plugin,
// marketplace, category, query. See `seedRichPlugins` in _helpers/sandbox.ts for
// the exact tree and the table of what each plugin carries.
//
// One Electron boot for the whole file: the panel is strictly read-only (it never
// writes to ~/.claude, marketplaceView.ts) and the disk never changes here, so
// the only shared state is the webview's own React filter state — which is why
// every test ends by restoring All · Everywhere · no query · no chips through
// `afterEach`, and why the block is serial (describeWithHost configures that).
//
// The rich seed is applied in `prepare`, before the host launches: the panel
// scans on `mkt:ready`, so anything written after launch would need a Rescan
// (which is marketplace-detail.e2e.ts's job, not this file's).

/** Every asset the rich seed produces: 3 skills, 2 commands, 1 agent, 1 hook. */
const TOTAL_ASSETS = 7;
/** Every plugin row: the five catalog entries plus `(user)` for ~/.claude. */
const TOTAL_PLUGINS = 6;

/** Open the Marketplace panel through the real command, not a seam.
 *
 *  `runCommand` carries the palette's three races and the bare-title rule (see
 *  test-e2e/_helpers/palette.ts); the Marketplace panel is a host-side singleton
 *  (`MarketplacePanel.show`), so a later call reveals the same panel — which is
 *  what keeps the page object's `.last()` frame pick resolving to one element. */
async function openMarketplace(page: Page): Promise<Marketplace> {
  await runCommand(page, "Open the Marketplace");
  const mkt = new Marketplace(page);
  await expect(mkt.results().first()).toBeVisible({ timeout: 30_000 });
  return mkt;
}

describeWithHost(
  "marketplace filters",
  {},
  (ctx) => {
    // Leave the panel where the next test expects it. Serial mode means a
    // failure skips the rest, so this only ever runs after a green test.
    test.afterEach(async () => {
      const mkt = new Marketplace(ctx.page());
      if (await mkt.pickerPop().count()) await mkt.pickerButton().click();
      await mkt.search().fill("");
      await mkt.kindPill("All").click();
      await mkt.scopePill("Everywhere").click();
      if (await mkt.chips().count()) await mkt.clearChip().click();
      await expect(mkt.chips()).toHaveCount(0);
      await expect(mkt.results()).toHaveCount(TOTAL_ASSETS);
    });

    // Mutation-checked: MarketplaceApp.tsx:230 `if (r.type) c[r.type]++` → `if (r.type && r.type !== "agent") c[r.type]++` (the Agents pill miscounts to 0) — the count assertion failed while every other test in the file stayed green.
    test("type pills carry live counts and filter the list", async ({}, testInfo) => {
      const mkt = await openMarketplace(ctx.page());
      // The counts are what the scan actually found — the pills tally the rows
      // that survive query and scope (MarketplaceApp.tsx:228-232), so with no
      // query they are the whole seed.
      await expect(mkt.kindCount("All")).toHaveText(String(TOTAL_ASSETS));
      await expect(mkt.kindCount("Skills")).toHaveText("3");
      await expect(mkt.kindCount("Commands")).toHaveText("2");
      await expect(mkt.kindCount("Agents")).toHaveText("1");
      await expect(mkt.kindCount("Hooks")).toHaveText("1");
      await expect(mkt.kindCount("Plugins")).toHaveText(String(TOTAL_PLUGINS));

      // "the type tallies following the query" (GUIDE § The Marketplace): the
      // query is applied BEFORE the type dimension, so the numbers move as you
      // type. "flight" keeps flight-log (name), /preflight (name contains it)
      // and the hook (its `where` names flight-recorder) — and drops the agent.
      await mkt.search().fill("flight");
      await expect(mkt.kindCount("All")).toHaveText("3");
      await expect(mkt.kindCount("Skills")).toHaveText("1");
      await expect(mkt.kindCount("Agents")).toHaveText("0");
      await shot(ctx.page(), testInfo, "1 · counts follow the query");

      await mkt.search().fill("");
      await mkt.kindPill("Agents").click();
      await expect(mkt.results()).toHaveCount(1);
      await expect(mkt.result("telemetry-auditor")).toBeVisible();
      await expect(mkt.result("flight-log")).toHaveCount(0);
      await shot(ctx.page(), testInfo, "2 · agents only");
    });

    // Mutation-checked, once per half: MarketplaceApp.tsx:204 `r.state !== "installed" && r.state !== "user"` → `false` (Installed only keeps everything) — the launch-pad absence assertion failed; and :205 `r.enabled === false` → `false` (Enabled only keeps everything) — the gantry-check absence assertion failed.
    test("scope pills narrow to installed and enabled", async ({}, testInfo) => {
      const mkt = await openMarketplace(ctx.page());
      // Installed only, proven on the plugin rows: launch-pad is catalogued but
      // has no content directory, so `resolveContentDir` gives it state
      // "manifest" (claudeAssets.ts:300-316) and the scope drops it.
      await mkt.kindPill("Plugins").click();
      await expect(mkt.result("launch-pad")).toBeVisible(); // positive control
      await mkt.scopePill("Installed only").click();
      await expect(mkt.result("launch-pad")).toHaveCount(0);
      await expect(mkt.result("flight-recorder")).toBeVisible();
      await shot(ctx.page(), testInfo, "1 · installed only");

      // Enabled only, proven on the assets: gantry-lights is the one ref
      // `~/.claude/settings.json` marks `false`, so its skill is the one asset
      // with `enabled === false` (claudeAssets.ts:235).
      await mkt.scopePill("Everywhere").click();
      await mkt.kindPill("All").click();
      await expect(mkt.result("gantry-check")).toBeVisible(); // positive control
      await mkt.scopePill("Enabled only").click();
      await expect(mkt.result("gantry-check")).toHaveCount(0);
      await expect(mkt.result("flight-log")).toBeVisible();
      await shot(ctx.page(), testInfo, "2 · enabled only");
    });

    // Mutation-checked, once per half: MarketplaceApp.tsx:207 `!pluginSel.includes(pluginKey(r))` → `false` (the selection stops narrowing) — the telemetry-auditor absence assertion failed; and :368 `onClear={() => { setPluginSel([]); setSel(0); }}` → `onClear={() => { setSel(0); }}` (Clear 2 clears nothing) — the restored-row-count assertion failed.
    test("the Plugins picker filters by several plugins at once and clears with one click", async ({}, testInfo) => {
      const mkt = await openMarketplace(ctx.page());
      await mkt.pickerButton().click();
      await mkt.pickerCheckbox("flight-recorder", "rocket-tools").check();
      await mkt.pickerCheckbox("hangar-checks", "rocket-tools").check();
      // Both plugins' rows, and nothing else: flight-log + its hook, plus
      // /preflight — the two `~/.claude` assets are gone.
      await expect(mkt.results()).toHaveCount(3);
      await expect(mkt.result("flight-log")).toBeVisible();
      await expect(mkt.result("/preflight")).toBeVisible();
      await expect(mkt.result("telemetry-auditor")).toHaveCount(0);
      await shot(ctx.page(), testInfo, "1 · two plugins picked");

      // One click clears both — the button names how many it will drop.
      await expect(mkt.pickerClear()).toHaveText("Clear 2");
      await mkt.pickerClear().click();
      await expect(mkt.results()).toHaveCount(TOTAL_ASSETS);
      await expect(mkt.result("telemetry-auditor")).toBeVisible();
      await shot(ctx.page(), testInfo, "2 · cleared");
    });

    // Mutation-checked: MarketplaceApp.tsx:208 `!mktSel.includes(r.marketplace)` → `false` (the marketplace tag stops narrowing) — the refit absence assertion failed.
    test("clicking a marketplace tag filters by marketplace", async ({}, testInfo) => {
      const mkt = await openMarketplace(ctx.page());
      // Two sources: the seeded catalog, and `~/.claude` for what you wrote
      // yourself (claudeAssets.ts's `own`).
      await expect(mkt.marketplaceTag("rocket-tools")).toBeVisible();
      await expect(mkt.result("/refit")).toBeVisible(); // positive control
      await mkt.marketplaceTag("rocket-tools").click();
      await expect(mkt.result("/refit")).toHaveCount(0);
      await expect(mkt.result("telemetry-auditor")).toHaveCount(0);
      await expect(mkt.result("flight-log")).toBeVisible();
      await expect(mkt.results()).toHaveCount(5);
      await shot(ctx.page(), testInfo, "1 · one marketplace");
    });

    // Mutation-checked: MarketplaceApp.tsx:208 `if (mktSel.length && …) continue` → `if (false && …) continue` (marketplace stops ANDing with the rest) — the "no rows left" assertion failed while the tag-only test above still passed.
    test("filters AND together", async ({}, testInfo) => {
      const mkt = await openMarketplace(ctx.page());
      // Query alone: three rows across two plugins and two types.
      await mkt.search().fill("flight");
      await expect(mkt.results()).toHaveCount(3);
      // ∧ type: only the skill survives.
      await mkt.kindPill("Skills").click();
      await expect(mkt.results()).toHaveCount(1);
      await expect(mkt.result("flight-log")).toBeVisible();
      await shot(ctx.page(), testInfo, "1 · query and type");
      // ∧ marketplace: flight-log came from rocket-tools, so asking for
      // ~/.claude leaves nothing — an intersection, not a union.
      await mkt.marketplaceTag("~/.claude").click();
      await expect(mkt.results()).toHaveCount(0);
      await expect(mkt.emptyBig()).toContainText("Nothing matches");
      await shot(ctx.page(), testInfo, "2 · intersection is empty");
    });

    // Mutation-checked: MarketplaceApp.tsx:371 `{(cat || pluginSel.length > 0 || mktSel.length > 0) && (` → `{(true) && (` (the chip row is always mounted) — the toHaveCount(0) assertion failed.
    test("the chip row disappears when nothing is selected", async ({}, testInfo) => {
      const mkt = await openMarketplace(ctx.page());
      // Nothing selected: the row is not in the DOM at all, not merely empty.
      await expect(mkt.chips()).toHaveCount(0);
      // A row's plugin name is itself a filter control (MarketplaceApp.tsx:463).
      await mkt.rowPluginLink("flight-log").click();
      await expect(mkt.chips()).toBeVisible();
      await expect(mkt.chips()).toContainText("flight-recorder");
      await shot(ctx.page(), testInfo, "1 · chips");
      await mkt.clearChip().click();
      await expect(mkt.chips()).toHaveCount(0);
      await shot(ctx.page(), testInfo, "2 · no chips");
    });

    // Mutation-checked: sections.ts:41 `rank = (c) => (c === FIRST ? -1 : c === LAST ? 1 : 0)` → `() => 0` (Yours and Uncategorized lose their pinned ends) — the header-order assertion failed.
    test("categories group Yours first and Uncategorized last", async ({}, testInfo) => {
      const mkt = await openMarketplace(ctx.page());
      // Yours (2) pinned first; then by descending size — monitoring (3) before
      // deployment (1); Uncategorized (1) pinned last despite the tie.
      await expect(mkt.groupLabels()).toHaveText(["Yours", "Monitoring", "Deployment", "Uncategorized"]);
      await shot(ctx.page(), testInfo, "1 · sections");
      // A header click focuses that category: the chip says which one, and the
      // headers go away because the chip already answers "which".
      await mkt.groupHeaders().filter({ hasText: "Monitoring" }).click();
      await expect(mkt.chips()).toContainText("Monitoring");
      await expect(mkt.results()).toHaveCount(3);
      await expect(mkt.groupHeaders()).toHaveCount(0);
      await shot(ctx.page(), testInfo, "2 · one category");
    });

    // Mutation-checked: marketplaceStyles.ts:50 `.tag.off { text-decoration: line-through; }` → `.row:has(.tag.off) { … }` (the row really is struck through) — the pin then PASSED, which Playwright reports as a failure of a `test.fail`, so this pin is sensitive to the product and not merely to itself. Asserted on the row element, not on its `.nm` child: `text-decoration` is painted over descendants but is not inherited, so a child's computed `textDecorationLine` reads "none" under a row-level rule and could never tell the two designs apart.
    // Pinned: the doc claims the disabled ROW is struck through; the product
    // strikes through only the little "disabled" badge itself
    // (marketplaceStyles.ts:50 `.tag.off { text-decoration: line-through; }`),
    // so the row's own computed text-decoration-line is "none" and its name and
    // blurb render exactly like an enabled row's. The shipped behaviour is
    // proven by the companion test below.
    test.fail("disabled assets are struck through", async ({}, testInfo) => {
      const mkt = await openMarketplace(ctx.page());
      const row = mkt.result("gantry-check");
      await expect(row).toBeVisible();
      await shot(ctx.page(), testInfo, "1 · a disabled row");
      const decoration = await row.evaluate((el) => getComputedStyle(el).textDecorationLine);
      expect(decoration).toContain("line-through");
    });

    // The shipped behaviour the pin above cannot assert: the row IS marked
    // disabled, and the mark itself is what carries the strike-through. Without
    // this the whole disabled dimension would be covered only by a test.fail().
    // Mutation-checked: MarketplaceApp.tsx:475 `{r.enabled === false && <span className="tag off">disabled</span>}` → `{false && …}` — the badge assertion failed.
    test("a disabled plugin's row carries a struck-through disabled badge", async ({}, testInfo) => {
      const mkt = await openMarketplace(ctx.page());
      const badge = mkt.result("gantry-check").locator(".tag.off");
      await expect(badge).toHaveText("disabled");
      expect(await badge.evaluate((el) => getComputedStyle(el).textDecorationLine)).toContain("line-through");
      // The positive control: an enabled row carries no such badge, so the
      // badge is a fact about gantry-lights, not about every row.
      await expect(mkt.result("flight-log").locator(".tag.off")).toHaveCount(0);
      await shot(ctx.page(), testInfo, "1 · the disabled badge");
    });

    // Mutation-checked: claudeAssets.ts:409 `installCommand: \`/plugin install ${ref}\`` → `installCommand: ""` (the row loses its command) — the snippet assertion failed.
    test("not-downloaded plugins carry their install command", async ({}, testInfo) => {
      const mkt = await openMarketplace(ctx.page());
      await mkt.kindPill("Plugins").click();
      const row = mkt.result("launch-pad");
      // The state the scan derived for a catalogued-but-absent plugin.
      await expect(row).toContainText("not downloaded");
      await row.click();
      // The command you would type in Claude Code, with the `@<marketplace>`
      // half that disambiguates a plugin name shared across catalogs.
      await expect(mkt.snippet()).toHaveText("/plugin install launch-pad@rocket-tools");
      await shot(ctx.page(), testInfo, "1 · install command");
    });
  },
  (sb) => seedClaudeAssets(sb.home, { rich: true }),
);
