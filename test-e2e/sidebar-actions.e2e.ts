import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { expect, test } from "@playwright/test";
import { describeWithHost } from "./_helpers/sharedHost";
import { Pool } from "./_helpers/po/pool";
import { FIXTURE_TASK, FIXTURE_TASK_2 } from "./_helpers/sandbox";
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

  // This is the product's ONLY label surface, not a missing test: there is no
  // `send({ type: "addLabel", ... })` call anywhere in src/webview/App.tsx, no
  // `case "addLabel"` in tasksView.ts's message switch, and the only caller of
  // `caps.labels.add` is the PRIVATE `stampProvenance` helper (tasksView.ts
  // ~line 287), fired automatically as a side effect of every OTHER write
  // (addToMySprint / removeFromSprint / setComponent / moveTo), gated on
  // `agentFlow.stampLabelOnWrite` (default true) and always stamping the FIXED
  // `agentFlow.provenanceLabel` (default "claude-code") — never arbitrary user
  // text. A user cannot type a custom label like "needs-e2e" through this UI;
  // the next test exercises `addLabel` the only honest way there is — as the
  // side effect of a genuine write.

  test("adding to sprint records addToSprint and stamps the provenance label", async ({}, testInfo) => {
    const pool = await Pool.open(ctx.page(), 2);
    await pool.card(FIXTURE_TASK.key).getByRole("button", { name: /add to my sprint/i }).click();
    await expect
      .poll(() => writes(ctx.sb().fixtureDir).filter((w) => w.op === "addToSprint" && w.key === FIXTURE_TASK.key))
      .toHaveLength(1);
    // The provenance stamp — real `addLabel` coverage, via the only path that ever
    // produces one. See the note above the previous test.
    await expect
      .poll(() => writes(ctx.sb().fixtureDir).filter((w) => w.op === "addLabel" && w.key === FIXTURE_TASK.key))
      .toHaveLength(1);
    await shot(ctx.page(), testInfo, "2 · added to sprint");
  });

  test("setting a component records the delta the picker produced", async () => {
    const pool = await Pool.open(ctx.page(), 2);
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
    const pool = await Pool.open(ctx.page(), 2);
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

  // The three tests below need the "My sprint" lens, which the fixture connector
  // now supports (`supportedFilters` gained "mysprint" — see
  // src/tasks/fixture/connector.ts and the report's Ruling A). Both fixture
  // tasks carry `inOpenSprint: true` (sandbox.ts) so this lens has two cards to
  // work with: one to reorder against the other, then remove. Run last, in this
  // order, because removing a card drops the lens to one — a card count no
  // subsequent test needs.

  test("reordering the pool survives a refresh, and reset restores source order", async ({}, testInfo) => {
    const pool = await Pool.open(ctx.page(), 2);
    await pool.frame.getByRole("group", { name: "Task filter" }).getByRole("button", { name: "My sprint" }).click();
    await expect(pool.cards()).toHaveCount(2, { timeout: 15_000 });
    const first = await pool.cards().nth(0).innerText();
    // The card's ticket key, captured separately from `first` above: `.card-top`
    // is `display:flex` (styles.ts), so Chromium blockifies its flex children for
    // `innerText` purposes and the FIRST LINE of every card's `innerText` is
    // always the drag-grip glyph "⠿" (App.tsx's `.grip` span) — identical on
    // every card regardless of which one is actually first. Asserting against
    // `first.split("\n")[0]` after reset would therefore pass no matter which
    // card ended up on top. The `.key` locator (the ticket's own anchor text,
    // e.g. "E2E-1") genuinely distinguishes the cards, so that's what "restores
    // source order" has to check.
    const firstKey = await pool.cards().nth(0).locator(".key").innerText();

    // Not `dragTo` — a sibling task in this plan (Task 5) documents that it does
    // not reliably fire dragstart/dragover/drop in Chromium. A manual mouse
    // sequence on the row's own `.grip` handle (App.tsx:844-849) does instead —
    // confirmed live — but needed two adjustments beyond the ruling's base
    // recipe: a small in-place wiggle plus a short pause right after mousedown
    // (Chromium's own drag-arming needs to see the pointer move a few pixels
    // before treating the gesture as a drag, not just jump straight to the
    // target — a single big step, even split into many `steps`, arrived too
    // fast for it to notice), and landing in the LOWER half of the target card:
    // `dropPos` (App.tsx) resolves "before"/"after" from which half of the
    // hovered card the pointer is in, and dropping "before" the very next card
    // is a no-op — it's already there.
    const from = await pool.cards().nth(0).locator(".grip").boundingBox();
    const to = await pool.cards().nth(1).boundingBox();
    if (!from || !to) throw new Error("drag source .grip or drop-target card did not render a bounding box");
    await pool.page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await pool.page.mouse.down();
    await pool.page.mouse.move(from.x + from.width / 2 + 3, from.y + from.height / 2 + 3, { steps: 3 });
    await pool.page.waitForTimeout(100);
    await pool.page.mouse.move(to.x + to.width / 2, to.y + to.height * 0.75, { steps: 12 });
    await pool.page.mouse.up();

    await expect.poll(async () => (await pool.cards().nth(0).innerText()) !== first, { timeout: 10_000 }).toBe(true);
    await shot(ctx.page(), testInfo, "4 · reordered");

    // Persistence is the point: the manual order lives in workspaceState, outside
    // the webview, so it must survive the panel being refetched. `ControlOrMeta`,
    // not `Control` — the palette is Cmd+Shift+P on macOS (the dev platform) and
    // Ctrl+Shift+P on Linux (CI); the literal `Control` modifier opens nothing on
    // macOS.
    //
    // Palette QUERY: the bare command title ("Refresh Tasks"), not "Agent Flow:
    // Refresh Tasks" — the same trap documented on `marketplace.e2e.ts`'s
    // `openMarketplace()`. Confirmed live: the category-qualified string does
    // not land this command first, because no `"category"` is set on it in
    // package.json, so VS Code's palette fuzzy-ranks an unrelated command (e.g.
    // "Agent Flow Deck: Focus on Tasks View") above "Refresh Tasks" for that
    // query — which the assertion right below this actually verifies now,
    // where it silently didn't before this fix.
    await ctx.page().keyboard.press("ControlOrMeta+Shift+P");
    await ctx.page().keyboard.type("Refresh Tasks");
    await ctx.page().keyboard.press("Enter");

    // Refresh re-fetches with `agentFlow.defaultFilter` ("mine", pinned in
    // sandbox.ts — see the report's Ruling A), which lands the panel back on the
    // "Mine" tab regardless of which lens was active before the refresh
    // (App.tsx's `case "tasks"` calls `setFilter(m.filter)` unconditionally). The
    // manual order is a "mysprint"-only concern (tasksView.ts's `fetch` handler
    // only applies `sortBySavedOrder` for that lens), so re-selecting "My sprint"
    // is what actually proves it survived — not just that the sidebar still shows
    // two cards. `Pool.open` (not `new Pool`): the webview wasn't torn down by
    // the refresh, but it costs nothing to go through the one idempotent entry
    // point uniformly.
    const reopened = await Pool.open(ctx.page(), 2);
    // The palette command itself leaves exactly one observable mark before the
    // next click hides it: the unconditional `setFilter(m.filter)` above snaps
    // the "Mine" button's `aria-pressed` to true, even though "My sprint" was
    // the active tab when the command was invoked. Asserting that here — before
    // clicking "My sprint" ourselves — is what proves "Refresh Tasks" actually
    // ran, rather than the persistence check below merely surviving because the
    // click that follows performs its own refetch regardless of whether the
    // palette command did anything at all.
    await expect(
      reopened.frame.getByRole("group", { name: "Task filter" }).getByRole("button", { name: "Mine" }),
    ).toHaveAttribute("aria-pressed", "true", { timeout: 15_000 });
    await reopened.frame.getByRole("group", { name: "Task filter" }).getByRole("button", { name: "My sprint" }).click();
    await expect(reopened.cards()).toHaveCount(2, { timeout: 15_000 });
    await expect.poll(async () => (await reopened.cards().nth(0).innerText()) !== first).toBe(true);

    await reopened.frame.getByRole("button", { name: /reset order/i }).click();
    await expect.poll(() => reopened.cards().nth(0).locator(".key").innerText()).toBe(firstKey);
  });

  test("removing from sprint records removeFromSprint", async () => {
    // Still on the "My sprint" tab from the previous test — no re-selection needed.
    const pool = await Pool.open(ctx.page(), 2);
    // The icon-only "Remove from sprint" button (App.tsx:880-888), addressed by
    // its aria-label — it carries no visible text, only the icon.
    await pool
      .card(FIXTURE_TASK_2.key)
      .getByRole("button", { name: new RegExp(`Remove ${FIXTURE_TASK_2.key} from your active sprint`) })
      .click();
    await expect
      .poll(() => writes(ctx.sb().fixtureDir).filter((w) => w.op === "removeFromSprint" && w.key === FIXTURE_TASK_2.key))
      .toHaveLength(1);
    await expect(pool.cards()).toHaveCount(1, { timeout: 15_000 });
  });
});
