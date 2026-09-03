import * as fs from "fs";
import * as path from "path";
import { expect, test } from "@playwright/test";
import { describeWithHost } from "./_helpers/sharedHost";
import { Pool } from "./_helpers/po/pool";
import { FIXTURE_CHILD, FIXTURE_TASK, FIXTURE_TASK_2, writeFixtureConfig, type FixtureConfig, type Sandbox } from "./_helpers/sandbox";
import { shot } from "./_helpers/shot";

/** Read every write the extension has recorded so far. Append-only, so a test
 *  asserts the line IT caused by op+key and ignores its siblings' lines. */
function writes(fixtureDir: string): Record<string, unknown>[] {
  const f = path.join(fixtureDir, "writes.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const moves = (dir: string, key: string) => writes(dir).filter((w) => w.op === "moveTo" && w.key === key);
const labels = (dir: string, key: string) => writes(dir).filter((w) => w.op === "addLabel" && w.key === key);
const sprintAdds = (dir: string, key: string) => writes(dir).filter((w) => w.op === "addToSprint" && w.key === key);

/** The one field prompt these journeys use. `pick` renders as a QuickPick whose
 *  rows are the choice names and whose accepted value is the row's label
 *  (tasksView.ts `collectFields`: `out[p.id] = picked.label`) — so the value
 *  that reaches `moveTo.values.resolution` is the NAME "Fixed", never an id. */
const RESOLUTION = {
  kind: "pick" as const, id: "resolution", name: "Resolution",
  choices: [{ id: "10000", name: "Fixed" }, { id: "10001", name: "Won't Do" }],
};
const DONE = { id: "done", toName: "Done", toCategory: "done" as const, fields: [] };

/** Every per-call knob is written and then cleared by the test that needed it,
 *  so each test below is self-sufficient on a fresh host (run alone with `-g`)
 *  AND leaves nothing for its serial siblings to inherit. */
const resetConfig = (sb: Sandbox) => writeFixtureConfig(sb, {});

// ─── Block 1: no sprint capability ──────────────────────────────────────────
// `caps` reaches the webview once, in the `state` message at init (App.tsx:253),
// so a capability toggle needs its own host — `prepare` runs before launch.

describeWithHost("pool writes · without sprints", {}, (ctx) => {
  // Mutation-checked: dropped the `caps.sprints &&` gate on `onRemoveFromSprint` (App.tsx:725)
  test("without sprints there is no add, remove or reorder affordance", async ({}, testInfo) => {
    const pool = await Pool.open(ctx.page(), 2);
    // The lens itself still renders — `supportedFilters` is untouched — so this is
    // the lens where every sprint affordance WOULD show for a sprint-capable source
    // (sidebar-actions proves each of them there).
    await pool.selectLens("My sprint", 2);
    await expect(pool.addToSprintButton(FIXTURE_TASK.key)).toHaveCount(0);
    await expect(pool.addToSprintButton(FIXTURE_TASK_2.key)).toHaveCount(0);
    await expect(pool.removeFromSprintButton(FIXTURE_TASK.key)).toHaveCount(0);
    await expect(pool.removeFromSprintButton(FIXTURE_TASK_2.key)).toHaveCount(0);
    await expect(pool.grips()).toHaveCount(0);
    // The reorder bar (App.tsx:668) is gated on the same capability.
    await expect(pool.frame.locator(".reset-order")).toHaveCount(0);
    await shot(ctx.page(), testInfo, "1 · My sprint lens without sprint affordances");
  });
}, (sb) => writeFixtureConfig(sb, { caps: { sprints: false } }));

// ─── Block 2: no label capability ───────────────────────────────────────────

describeWithHost("pool writes · without labels", {}, (ctx) => {
  // Mutation-checked: made stampProvenance throw when `provider.caps.labels` is absent (tasksView.ts:416)
  test("a labels-less connector accepts a status change with no provenance stamp", async ({}, testInfo) => {
    const pool = await Pool.open(ctx.page(), 2);
    await pool.statusButton(FIXTURE_TASK.key).click();
    const quickInput = ctx.page().locator(".quick-input-widget");
    await expect(quickInput).toBeVisible({ timeout: 15_000 });
    await expect(quickInput).toContainText("Done");
    await ctx.page().keyboard.type("Done");
    await ctx.page().keyboard.press("Enter");

    // The done-category move retires the card: `statusChanged` is posted only
    // AFTER `stampProvenance` returned, so this is the completion signal that
    // makes the "no addLabel" check below a real absence, not a race.
    await expect(pool.card(FIXTURE_TASK.key)).toHaveCount(0, { timeout: 30_000 });
    await expect(pool.toasts("success", `${FIXTURE_TASK.key} → Done`)).toBeVisible();
    await shot(ctx.page(), testInfo, "1 · status changed without a label stamp");

    expect(moves(ctx.sb().fixtureDir, FIXTURE_TASK.key)).toMatchObject([{ targetId: "done" }]);
    expect(labels(ctx.sb().fixtureDir, FIXTURE_TASK.key)).toHaveLength(0);
    expect(writes(ctx.sb().fixtureDir).filter((w) => w.op === "addLabel")).toHaveLength(0);
    await expect(pool.toasts("error")).toHaveCount(0);
  });
}, (sb) => writeFixtureConfig(sb, { caps: { labels: false } }));

// ─── Block 3: stamping switched off ─────────────────────────────────────────

describeWithHost("pool writes · stampLabelOnWrite off", { "agentFlow.stampLabelOnWrite": false }, (ctx) => {
  // Mutation-checked: stampProvenance ignored `cfg.stampLabelOnWrite` (tasksView.ts:416)
  test("stampLabelOnWrite off skips the provenance label", async ({}, testInfo) => {
    const pool = await Pool.open(ctx.page(), 2);
    await pool.addToSprintButton(FIXTURE_TASK.key).click();
    await expect.poll(() => sprintAdds(ctx.sb().fixtureDir, FIXTURE_TASK.key)).toHaveLength(1);
    // The success toast is posted after the stamp step ran (tasksView.ts
    // `addToMySprint`), so an empty addLabel list here is a settled absence.
    await expect(pool.toasts("success", `${FIXTURE_TASK.key} → your sprint`)).toBeVisible({ timeout: 15_000 });
    expect(labels(ctx.sb().fixtureDir, FIXTURE_TASK.key)).toHaveLength(0);
    await shot(ctx.page(), testInfo, "1 · added to sprint, no label stamped");
  });
});

// ─── Block 4: shipped caps, per-call knobs and a custom provenance label ────
// `me`, `statusTargets`, `reject` and `failDetail` are re-read by the connector
// on every call (src/tasks/fixture/connector.ts), so one host serves them all;
// each test writes the knob it needs and clears it before it ends.

describeWithHost("pool writes · edges", { "agentFlow.provenanceLabel": "e2e-bot" }, (ctx) => {
  // Mutation-checked: `showAddToSprint` reduced to `caps.sprints && !onRemoveFromSprint` — the assignee gate dropped (App.tsx:823)
  test("Add to my sprint is absent on a task assigned to someone else", async ({}, testInfo) => {
    const pool = await Pool.open(ctx.page(), 2);
    await expect(pool.addToSprintButton(FIXTURE_TASK.key)).toBeVisible();
    await expect(pool.card(FIXTURE_TASK_2.key).locator(".assignee")).toHaveText("Someone Else");
    await expect(pool.addToSprintButton(FIXTURE_TASK_2.key)).toHaveCount(0);
    await shot(ctx.page(), testInfo, "1 · add-to-sprint only on the unassigned card");
  });

  // Mutation-checked: the dispatcher's catch skipped `this.toast("error", msg)` for `detail` (tasksView.ts:1064)
  test("a task whose detail cannot be fetched shows a toast, not a blank panel", async ({}, testInfo) => {
    writeFixtureConfig(ctx.sb(), { failDetail: [FIXTURE_TASK_2.key] });
    const pool = await Pool.open(ctx.page(), 2);
    const card = pool.card(FIXTURE_TASK_2.key);
    await card.locator(".card-main").click();
    // The failure surfaces where the user is looking — as an error toast — and the
    // list stays valid: a failed read never re-gates or empties the panel
    // (tasksView.ts's dispatcher catch only replaces the panel for ready/retry/fetch).
    const toast = pool.toasts("error", FIXTURE_TASK_2.key);
    await expect(toast).toBeVisible({ timeout: 15_000 });
    await expect(pool.cards()).toHaveCount(2);
    await expect(card).toBeVisible();
    await shot(ctx.page(), testInfo, "2 · detail failure toast, card still in pool");
    await toast.click(); // errors persist until dismissed
    await card.locator(".card-main").click(); // collapse again
    resetConfig(ctx.sb());
  });

  // Mutation-checked: `if (!me?.id)` → `if (!me)` in addToMySprint (tasksView.ts:1225)
  test("a name-only identity refuses the sprint write and says so", async ({}, testInfo) => {
    writeFixtureConfig(ctx.sb(), { me: { id: "", displayName: "Fixture User" } });
    const pool = await Pool.open(ctx.page(), 2);
    await pool.addToSprintButton(FIXTURE_TASK.key).click();
    // `info.label` for the fixture connector is "Fixture" (connector.ts `info()`).
    const toast = pool.toasts("error", "Couldn't resolve your Fixture account.");
    await expect(toast).toBeVisible({ timeout: 15_000 });
    await shot(ctx.page(), testInfo, "3 · name-only identity refused");
    // Refused BEFORE the first write of the pair: nothing was added to the sprint
    // and nothing was assigned.
    expect(sprintAdds(ctx.sb().fixtureDir, FIXTURE_TASK.key)).toHaveLength(0);
    expect(writes(ctx.sb().fixtureDir).filter((w) => w.op === "assignToMe")).toHaveLength(0);
    // The card is untouched, so the affordance is still there for the next test.
    await expect(pool.addToSprintButton(FIXTURE_TASK.key)).toBeVisible();
    await toast.click();
    resetConfig(ctx.sb());
  });

  // Mutation-checked: `labels.add(key, "claude-code")` instead of `cfg.provenanceLabel` (tasksView.ts:418)
  test("provenanceLabel names the label that is stamped", async ({}, testInfo) => {
    const pool = await Pool.open(ctx.page(), 2);
    await pool.addToSprintButton(FIXTURE_TASK.key).click();
    await expect.poll(() => sprintAdds(ctx.sb().fixtureDir, FIXTURE_TASK.key)).toHaveLength(1);
    await expect.poll(() => labels(ctx.sb().fixtureDir, FIXTURE_TASK.key)).toMatchObject([{ label: "e2e-bot" }]);
    await expect(pool.toasts("success", `${FIXTURE_TASK.key} → your sprint`)).toBeVisible({ timeout: 15_000 });
    await shot(ctx.page(), testInfo, "4 · e2e-bot stamped");
  });

  // Mutation-checked: zero targets toasted at level "error" instead of "info" (tasksView.ts:1082)
  test("zero status targets is an info toast, not an error", async ({}, testInfo) => {
    writeFixtureConfig(ctx.sb(), { statusTargets: [] });
    const pool = await Pool.open(ctx.page(), 2);
    await pool.statusButton(FIXTURE_TASK.key).click();
    const message = `No status transitions available for ${FIXTURE_TASK.key}.`;
    await expect(pool.toasts("info", message)).toBeVisible({ timeout: 15_000 });
    await expect(pool.toasts("error", message)).toHaveCount(0);
    // No QuickPick opened — there was nothing to pick from.
    await expect(ctx.page().locator(".quick-input-widget")).toBeHidden();
    await shot(ctx.page(), testInfo, "5 · zero targets is informational");
    expect(moves(ctx.sb().fixtureDir, FIXTURE_TASK.key)).toHaveLength(0);
    resetConfig(ctx.sb());
  });

  // Mutation-checked: collectFields given `[]` instead of `target.fields` (tasksView.ts:1106)
  test("a status target with a field prompts for it and sends the value", async ({}, testInfo) => {
    writeFixtureConfig(ctx.sb(), { statusTargets: [{ ...DONE, fields: [RESOLUTION] }] });
    const pool = await Pool.open(ctx.page(), 2);
    await pool.statusButton(FIXTURE_TASK_2.key).click();
    const quickInput = ctx.page().locator(".quick-input-widget");
    await expect(quickInput).toBeVisible({ timeout: 15_000 });
    await expect(quickInput).toContainText("Done");
    await ctx.page().keyboard.type("Done");
    await ctx.page().keyboard.press("Enter");

    // The field prompt: a second QuickPick titled "<key> → Done" whose rows are
    // the choice names (tasksView.ts `collectFields`, kind "pick").
    await expect(quickInput.locator(".quick-input-title")).toHaveText(`${FIXTURE_TASK_2.key} → Done`, { timeout: 15_000 });
    await expect(quickInput).toContainText("Fixed");
    await expect(quickInput).toContainText("Won't Do");
    await shot(ctx.page(), testInfo, "6 · the Resolution prompt");
    await quickInput.getByText("Fixed", { exact: true }).click();

    await expect(pool.card(FIXTURE_TASK_2.key)).toHaveCount(0, { timeout: 30_000 });
    expect(moves(ctx.sb().fixtureDir, FIXTURE_TASK_2.key)).toMatchObject([
      { targetId: "done", values: { resolution: "Fixed" } },
    ]);
    resetConfig(ctx.sb());
  });

  // Mutation-checked: `if (!e.retryWith.length)` → `if (true)` so a rejection is reported instead of re-prompted (tasksView.ts:1120)
  test("a rejected write re-prompts only the field it names", async ({}, testInfo) => {
    writeFixtureConfig(ctx.sb(), {
      statusTargets: [DONE],
      reject: { moveTo: { message: "Resolution is required", retryWith: [RESOLUTION] } },
    });
    // No card count: E2E-2 was retired by the previous test in a shared run, and
    // both cards are here under `-g` — `Pool.open` without `n` only guarantees the
    // sidebar is open, which is all the next click needs.
    const pool = await Pool.open(ctx.page());
    await pool.statusButton(FIXTURE_TASK.key).click();
    const quickInput = ctx.page().locator(".quick-input-widget");
    await expect(quickInput).toBeVisible({ timeout: 15_000 });
    // "Done" carries no fields, so the first attempt goes straight to the write…
    await ctx.page().keyboard.type("Done");
    await ctx.page().keyboard.press("Enter");

    // …which the source refuses, naming Resolution. The host re-prompts for
    // exactly that field — the target's own (empty) field list is not re-asked.
    await expect(quickInput.locator(".quick-input-title")).toHaveText(`${FIXTURE_TASK.key} → Done`, { timeout: 15_000 });
    await expect(quickInput).toContainText("Fixed");
    await expect(quickInput.locator(".quick-input-list .monaco-list-row")).toHaveCount(RESOLUTION.choices.length);
    await expect.poll(() => moves(ctx.sb().fixtureDir, FIXTURE_TASK.key)).toMatchObject([
      { targetId: "done", values: {}, rejected: true },
    ]);
    await shot(ctx.page(), testInfo, "7 · re-prompted for Resolution only");

    // Let the second attempt through, then answer the re-prompt.
    writeFixtureConfig(ctx.sb(), { statusTargets: [DONE] });
    await quickInput.getByText("Fixed", { exact: true }).click();

    await expect(pool.card(FIXTURE_TASK.key)).toHaveCount(0, { timeout: 30_000 });
    const attempts = moves(ctx.sb().fixtureDir, FIXTURE_TASK.key);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ targetId: "done", values: {}, rejected: true });
    expect(attempts[1]).toMatchObject({ targetId: "done", values: { resolution: "Fixed" } });
    expect(attempts[1]).not.toHaveProperty("rejected");
    await expect(pool.toasts("error")).toHaveCount(0);
    resetConfig(ctx.sb());
  });

  // Mutation-checked: the Undo branch skipped `ops.add(sprintId, key)` (tasksView.ts:1275)
  test("Remove from sprint offers Undo, and Undo puts the card back", async ({}, testInfo) => {
    // The fixture never mutates tasks.json, so the lens refetch brings back both
    // cards even after the two done-moves above retired them from the webview.
    const pool = await Pool.open(ctx.page());
    await pool.selectLens("My sprint", 2);
    await pool.removeFromSprintButton(FIXTURE_TASK_2.key).click();
    await expect.poll(() => writes(ctx.sb().fixtureDir).filter((w) => w.op === "removeFromSprint" && w.key === FIXTURE_TASK_2.key))
      .toHaveLength(1);
    await expect(pool.cards()).toHaveCount(1, { timeout: 15_000 });

    // Undo is a NATIVE notification (tasksView.ts `removeFromSprint`:
    // `vscode.window.showInformationMessage(…, "Undo")`), so it lives in the
    // workbench chrome on the top-level page, not in the webview.
    const notification = ctx.page().locator(".notification-list-item", { hasText: `${FIXTURE_TASK_2.key} removed from your sprint` });
    await expect(notification).toBeVisible({ timeout: 15_000 });
    await shot(ctx.page(), testInfo, "8 · Undo offered");
    await notification.getByRole("button", { name: "Undo" }).click();

    // Undo re-adds through the same sprint op the add path uses, so it records
    // as `addToSprint` (connector.ts `caps.sprints.add`), then refetches the lens.
    await expect.poll(() => sprintAdds(ctx.sb().fixtureDir, FIXTURE_TASK_2.key)).toHaveLength(1);
    await expect(pool.cards()).toHaveCount(2, { timeout: 15_000 });
    await expect(pool.card(FIXTURE_TASK_2.key)).toBeVisible();
    const ops = writes(ctx.sb().fixtureDir).filter((w) => w.key === FIXTURE_TASK_2.key && (w.op === "removeFromSprint" || w.op === "addToSprint")).map((w) => w.op);
    expect(ops).toEqual(["removeFromSprint", "addToSprint"]);
    await shot(ctx.page(), testInfo, "9 · card back after Undo");
  });
}, (sb) => {
  // E2E-2 belongs to someone else for the whole block: the add affordance keys
  // off the assignee (App.tsx:807/823), and nothing else here reads it.
  fs.writeFileSync(
    path.join(sb.fixtureDir, "tasks.json"),
    JSON.stringify([FIXTURE_TASK, { ...FIXTURE_TASK_2, assignee: "Someone Else" }, FIXTURE_CHILD], null, 2),
  );
  resetConfig(sb);
});

// Keep the imported type in use even if a future edit drops the last annotation.
export type { FixtureConfig };
