import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { expect, test } from "@playwright/test";
import { describeWithHost } from "./_helpers/sharedHost";
import { Pool } from "./_helpers/po/pool";
import { type Sandbox } from "./_helpers/sandbox";
import { shot } from "./_helpers/shot";

/** The sidebar's own chrome — the two tabs, the view title bar above them, the
 *  open-window gauge and the Explore button that trail them (GUIDE § What it
 *  does) — plus the two pool facts that are read straight off a card rather
 *  than driven through a picker: which repos a ticket arrives with selected
 *  (README § Tasks — the pool) and that Add to my sprint pairs its sprint write
 *  with an assignment (CONNECTORS § 2).
 *
 *  Shared host: every action here is local to the webview or append-only in
 *  `writes.jsonl`, which is exactly the contract `describeWithHost` documents.
 *  Nothing opens a window, makes a worktree or writes a run record. */

/** Read every write the extension has recorded so far, in order. Append-only,
 *  so a test asserts the lines IT caused by op+key. Same helper
 *  `sidebar-actions.e2e.ts` carries. */
function writes(fixtureDir: string): Record<string, unknown>[] {
  const f = path.join(fixtureDir, "writes.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** A real git repo under the sandbox's reposRoot. `discoverRepos` only reports a
 *  directory it can see, and `inferServices` matches on the repo NAME, so a
 *  repo per inference reason is the only way to drive all three. Same recipe
 *  `makeSandbox` uses for rocket. */
function repo(sb: Sandbox, name: string): void {
  const dir = path.join(sb.reposRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync(
    "git",
    ["-c", "user.email=e2e@fixture.invalid", "-c", "user.name=E2E", "commit", "-qm", "init"],
    { cwd: dir },
  );
}

/** One pool card, shaped for exactly one of `inferServices`' three reasons
 *  (src/engine/infer.ts): a component the ticket records, a label it carries,
 *  or the repo's name appearing as a whole word in its text. Unassigned, so
 *  `showAddToSprint` (App.tsx:823) offers the sprint action on every lens but
 *  My sprint. */
const card = (key: string, summary: string, descriptionText: string, extra: Partial<{ labels: string[]; components: string[] }> = {}) => ({
  key, summary, descriptionText,
  status: "To Do", statusCategory: "new", priority: "P2", assignee: "Unassigned",
  labels: [], components: [], sprint: null, inOpenSprint: false,
  updated: "2026-08-21T00:00:00.000Z", url: `https://fixture.invalid/browse/${key}`,
  estimateSeconds: null,
  ...extra,
});

/** The three inference reasons, one card each. Deliberately NOT the shipped
 *  `FIXTURE_TASK` pair: those two both name "rocket" in their summaries, so
 *  neither can isolate a component or a label match. Written over `tasks.json`
 *  in `prepare`, before the host boots.
 *
 *  Each summary and description is checked to mention NO repo name, so the one
 *  reason under test is the only reason that can fire:
 *   - C1's only signal is `components: ["telemetry"]` — "telemetry" is one of
 *     the fixture connector's own project components.
 *   - C2's only signal is `labels: ["landing-gear"]`, the other one.
 *   - C3 carries neither, and names "rocket" in its summary.
 */
const CARDS = [
  card("E2E-C1", "Fix the stale readout numbers", "The readout shows stale numbers.", { components: ["telemetry"] }),
  card("E2E-C2", "Refit the strut assembly", "The struts miss the pad.", { labels: ["landing-gear"] }),
  card("E2E-C3", "Fix the rocket antenna", "The antenna drifts off boresight."),
];

describeWithHost(
  "sidebar chrome",
  {},
  (ctx) => {
    // Mutation-checked: App.tsx:566 — the Notepad `role="tab"` button deleted; the tablist held one tab and the count assertion failed.
    test("the sidebar panel has two tabs, with the source's scope and your name in the view title bar", async ({}, testInfo) => {
      const pool = await Pool.open(ctx.page(), CARDS.length);

      // App.tsx:564 on 2026-09-04: `<span className="tabbar-tabs" role="tablist"
      // aria-label="Panel view">` holding exactly two `role="tab"` buttons. The
      // gauge and Explore sit OUTSIDE it on purpose (the component says why), so
      // the tablist is the honest scope for "two tabs" — a frame-wide role query
      // would be satisfied by any future tab elsewhere on the panel.
      const tabs = pool.frame.getByRole("tablist", { name: "Panel view" }).getByRole("tab");
      await expect(tabs).toHaveCount(2);
      await expect(tabs).toHaveText(["Tasks", "Notepad"]);
      await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");

      // The identity is in VS Code's own view title bar, not in our content:
      // `postState` (tasksView.ts:365-366) sets `view.title` to the connector's
      // `info().scopeValue` and `view.description` to the resolved `me()`. For the
      // fixture connector those are the path to `tasks.json` and "Fixture User"
      // (src/tasks/fixture/connector.ts) — the same two slots a Jira install
      // fills with the project key and your display name. Read on the PAGE: the
      // title bar is workbench chrome above the webview, not inside its frame.
      const sidebar = ctx.page().locator(".part.sidebar");
      await expect(sidebar).toContainText("tasks.json", { timeout: 30_000 });
      await expect(sidebar).toContainText("Fixture User", { timeout: 30_000 });
      await shot(ctx.page(), testInfo, "1 · two tabs under the view title bar");
    });

    // Mutation-checked: App.tsx:569 — `<GaugeMark live={liveCount} />` → `<GaugeMark />`; with no `live` the mark renders `aria-hidden` with no label (GaugeMark.tsx:26-27) and the aria-label assertion failed.
    test("the open-window gauge sits at the end of the tab row", async ({}, testInfo) => {
      const pool = await Pool.open(ctx.page());

      // Position, read off the DOM rather than off a screenshot: `.tabbar`
      // (App.tsx:563) holds exactly the tablist and then the trail, and the
      // gauge is the trail's first child.
      const rowOrder = await pool.frame
        .locator(".tabbar")
        .evaluate((el) => [...el.children].map((c) => c.getAttribute("class")));
      expect(rowOrder).toEqual(["tabbar-tabs", "tabbar-trail"]);

      // It is a GAUGE, not the static lockup: `GaugeMark` only takes
      // `role="img"` and an aria-label once the host hands it a count, which it
      // does whenever `agentFlow.trackOpenWindows` is on — the shipped manifest
      // default, unpinned by this sandbox (GaugeMark.tsx:17-19,
      // tasksView.ts:371).
      const gauge = pool.frame.locator(".tabbar-trail .gauge");
      await expect(gauge).toHaveCount(1);
      await expect(gauge).toHaveAttribute("aria-label", /^\d+ Agent Flow Deck windows? open$/);
      await shot(ctx.page(), testInfo, "2 · the gauge at the end of the tab row");
    });

    // Mutation-checked: App.tsx — the `<button className="explore">` moved inside `.tabbar-tabs`; the trail held only the gauge and the ordering assertion failed.
    test("Explore sits at the end of the tab row beside the gauge", async ({}, testInfo) => {
      const pool = await Pool.open(ctx.page());

      // The trail's own order: the gauge, then Explore (App.tsx:568-576).
      const trailOrder = await pool.frame
        .locator(".tabbar-trail")
        .evaluate((el) => [...el.children].map((c) => `${c.tagName.toLowerCase()}.${c.getAttribute("class")}`));
      expect(trailOrder).toEqual(["svg.gauge", "button.explore"]);
      // And it is the real launcher, not a decoration: its title names the
      // configured tool and says it needs no ticket (App.tsx:573).
      await expect(pool.frame.locator("button.explore")).toHaveAttribute("title", /no ticket needed/);

      // Both trail items live on the Notepad tab too — the component's own
      // reason for keeping them out of the tablist.
      await pool.openNotepad();
      await expect(pool.frame.locator(".tabbar-trail button.explore")).toBeVisible();
      await expect(pool.frame.locator(".tabbar-trail .gauge")).toHaveCount(1);
      await shot(ctx.page(), testInfo, "3 · gauge and Explore, on the Notepad tab too");
      // Leave the UI where the next test expects it (notepad.e2e.ts's contract).
      await pool.openTasksTab();
      await expect(pool.cards()).toHaveCount(CARDS.length, { timeout: 15_000 });
    });

    // Mutation-checked: tasksView.ts:851 — `const inferred = confirmedServices(inferServices(…))` → `const inferred: string[] = []`; every card opened with "none selected" and all three assertions failed.
    test("a card's repos arrive selected from the ticket's components, labels and text", async ({}, testInfo) => {
      const pool = await Pool.open(ctx.page(), CARDS.length);

      /** Expand one card and read the repo chips its detail arrived with. The
       *  chips are `.chips .chip` inside `.detail` (App.tsx:1008-1046); the
       *  selection itself is `inferred` from the host's `detail` post
       *  (tasksView.ts:841-886), which is what "already selected" means. */
      const chipsOf = async (key: string): Promise<string[]> => {
        const c = pool.card(key);
        // `.summary`, not `.card-main`: the handler is on `.card-main`
        // (App.tsx:872) but Playwright clicks an element's CENTRE, and on these
        // short cards that centre lands on the "Add to my sprint" button in
        // `.card-actions` — which stops propagation, so the card never expanded
        // and the sprint write fired instead (observed live). `.summary`
        // (App.tsx:944) is inert text inside the same handler's subtree.
        if (!(await c.locator(".detail").isVisible())) await c.locator(".summary").click();
        await expect(c.locator(".chips")).toBeVisible({ timeout: 30_000 });
        // `.chip` only — `.chip-none` is the "none selected" placeholder and is a
        // different class, so an empty selection reads as [] here rather than [""].
        return (await c.locator(".chips .chip").allInnerTexts()).map((t) => t.replace(/[↑×]/g, "").trim());
      };

      // One reason each (src/engine/infer.ts `inferServices`): a component the
      // ticket records, a label it carries, and the repo's own name in its text.
      // `confirmedServices` prefers component matches where a ticket has any, so
      // each card is shaped to carry exactly one signal — see CARDS above.
      expect(await chipsOf("E2E-C1")).toEqual(["telemetry"]);
      expect(await chipsOf("E2E-C2")).toEqual(["landing-gear"]);
      expect(await chipsOf("E2E-C3")).toEqual(["rocket"]);
      await shot(ctx.page(), testInfo, "4 · one inferred chip per reason");
    });

    // Mutation-checked: tasksView.ts:1238 — the `await provider.assignToMe(key, me.id)` call removed; writes.jsonl carried addToSprint with no assignToMe beside it and the assertion failed.
    test("Add to my sprint pairs the sprint write with an assignment to you", async ({}, testInfo) => {
      const pool = await Pool.open(ctx.page(), CARDS.length);
      const key = "E2E-C2";
      await pool.addToSprintButton(key).click();

      // The assertion of record is `writes.jsonl`. `addToMySprint`
      // (tasksView.ts:1210-1243) resolves `me()` FIRST and refuses before any
      // write when it has no usable id, then writes the sprint add and hands the
      // SAME id to `assignToMe` — which is why the recorded `meId` is the
      // fixture's own identity and not a second lookup's answer.
      const dir = ctx.sb().fixtureDir;
      await expect
        .poll(() => writes(dir).filter((w) => w.key === key && (w.op === "addToSprint" || w.op === "assignToMe")).map((w) => w.op), { timeout: 30_000 })
        .toEqual(["addToSprint", "assignToMe"]);
      expect(writes(dir).find((w) => w.op === "assignToMe" && w.key === key)).toMatchObject({ meId: "fixture-user" });
      await shot(ctx.page(), testInfo, "5 · sprint add and assignment, both recorded");
    });
  },
  (sb) => {
    // Two more checkouts, so `inferServices` has a repo to match per reason.
    // `rocket` is already there (makeSandbox) and carries the text match.
    repo(sb, "telemetry");
    repo(sb, "landing-gear");
    // The pool this file drives. Replaces the shipped fixture list wholesale
    // (see CARDS), which is why every count assertion here reads CARDS.length
    // rather than the 2 the shipped fixture serves.
    fs.writeFileSync(path.join(sb.fixtureDir, "tasks.json"), JSON.stringify(CARDS, null, 2));
  },
);
