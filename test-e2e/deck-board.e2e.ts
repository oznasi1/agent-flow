import { expect, test, type ElectronApplication } from "@playwright/test";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { makeSandbox, FIXTURE_TASK, type Sandbox } from "./_helpers/sandbox";
import { launchHost, openTasksView, tasksFrame } from "./_helpers/host";
import { seedSession, seedTranscript } from "./_helpers/claudeState";
import { Deck } from "./_helpers/po/deck";
import { shot } from "./_helpers/shot";

/** The Deck as a BOARD: what the docs (GUIDE § The Deck) say about its shape —
 *  four columns and their count tiles, the Recently closed strip, the Sessions /
 *  Workspaces lens, the refresh caption, and the three per-card actions (Open,
 *  Diff, the More menu's Open in … / Forget). `deck-lifecycle.e2e.ts` owns what
 *  happens to a record over time; this file owns what the board shows and does
 *  right now. Per-test hosts: every test seeds a different board. */

let sb: Sandbox;
let app: ElectronApplication | undefined;

const HOUR = 3_600_000;

/** Write a run record straight into the store. HOME is the sandbox, so this is
 *  the same path the extension writes — not a seam. */
function seedRun(sb: Sandbox, run: Record<string, unknown>): string {
  const dir = path.join(sb.home, ".agentflow", "runs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${run.key as string}.json`);
  fs.writeFileSync(file, JSON.stringify(run, null, 2) + "\n");
  return file;
}

/** A tracked task run against a key the fixture connector has never heard of —
 *  see `deck-lifecycle.e2e.ts`'s `baseRun` for why that makes `ticketCategory`
 *  null forever and why `closedAt` (rule 2b, `retireClosedAfterHours`) is the
 *  field to seed for a run meant to be past or inside its closed window.
 *
 *  Default `createdAt` is 72h ago: too old for `JUST_LAUNCHED_MS` (10 min) to
 *  hold the run on the live shelf, so with no live session, no PR and nothing
 *  to lose it reads `shelf: "closed"` (visibility.ts `shelfFor`) and collapses
 *  into the Recently closed strip instead of rendering as a `.card` (DeckApp.tsx:
 *  "a closed run is not a card"). Override `createdAt: Date.now()` for a run
 *  that must appear on the board as a clickable card. */
function baseRun(sb: Sandbox, key: string, extra: Record<string, unknown> = {}) {
  return {
    key, summary: `Run ${key}`, url: `https://fixture.invalid/browse/${key}`,
    createdAt: Date.now() - 72 * HOUR, kind: "task", mode: "per-window",
    repos: [{ name: "rocket", path: sb.repoPath, isGit: true, branch: "main" }],
    briefPaths: [], ...extra,
  };
}

/** A second real git repo under the sandbox's reposRoot, for a run that must
 *  own a DIFFERENT directory from `rocket`: sessions attach to the card that
 *  owns their `cwd`, so two runs that should each carry their own session need
 *  two places. Same recipe `makeSandbox` uses for rocket. */
function secondRepo(sb: Sandbox, name: string): string {
  const dir = path.join(sb.reposRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["-c", "user.email=e2e@fixture.invalid", "-c", "user.name=E2E", "commit", "-qm", "init"], { cwd: dir });
  return dir;
}

test.afterEach(async () => { await app?.close(); app = undefined; sb?.dispose(); });

// Mutation-checked: DeckApp.tsx `const live = runs.filter((r) => r.shelf !== "closed")` → `runs` (a closed run renders as a card again)
test("a closed run collapses into the Recently closed strip", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = makeSandbox({ "agentFlow.retireClosedAfterHours": 24 });
  // Closed an hour ago inside a 24h window: past the board (no session, no PR,
  // nothing uncommitted, not just launched) but not yet past its window, so the
  // strip is where it must sit — not a card, and not retired either.
  const record = seedRun(sb, baseRun(sb, "E2E-7", { closedAt: Date.now() - HOUR }));

  const launched = await launchHost(sb);
  app = launched.app;
  const deck = await Deck.open(launched.page);

  await expect(deck.closedStrip()).toBeVisible({ timeout: 60_000 });
  await expect(deck.cards()).toHaveCount(0);
  // Collapsed is the state that matters (ClosedStrip.tsx): one line, a count,
  // and no rows in the DOM until asked.
  await expect(deck.closedStrip().locator(".rc-ct")).toHaveText("1");
  await expect(deck.closedRows()).toHaveCount(0);
  await shot(launched.page, testInfo, "1 · collapsed strip, no card");

  await deck.closedToggle().click();
  await expect(deck.closedRow("E2E-7")).toBeVisible();
  await expect(deck.closedRow("E2E-7").locator(".rc-when")).toHaveText(/^closed \d+h ago$/);
  // Still in the store: the strip holds a record through its window, it does
  // not stand in for retirement.
  expect(fs.existsSync(record)).toBe(true);
  await shot(launched.page, testInfo, "2 · expanded strip lists the run");
});

// Mutation-checked: deckView.ts `shelf: cfg.inflightShowAll ? "board" : s.shelf` → `s.shelf` AND the buildAll shelf override (line ~3660) dropped — the run went back to the strip
test("inflightShowAll renders every record as a card", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = makeSandbox({ "agentFlow.retireClosedAfterHours": 24, "agentFlow.inflightShowAll": true });
  // The very same record the strip test above collapses — the setting is the
  // only difference between the two boards.
  const record = seedRun(sb, baseRun(sb, "E2E-7", { closedAt: Date.now() - HOUR }));

  const launched = await launchHost(sb);
  app = launched.app;
  const deck = await Deck.open(launched.page);

  await expect(deck.card("E2E-7")).toBeVisible({ timeout: 60_000 });
  await expect(deck.cards()).toHaveCount(1);
  // `return null` when no run is on the closed shelf — count, not visibility.
  await expect(deck.closedStrip()).toHaveCount(0);
  expect(fs.existsSync(record)).toBe(true);
  await shot(launched.page, testInfo, "3 · showAll: the closed run is a card, no strip");
});

// Mutation-checked: deckView.ts `deck:setGrouping` no longer calls `.update("deckGrouping", …)` — the reopened board came back on Sessions with two cards
test("the Sessions / Workspaces grouping sticks across a reopen", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = makeSandbox();
  seedRun(sb, baseRun(sb, "E2E-8", { createdAt: Date.now() }));

  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;
  // Two sessions in the one worktree. On the Sessions lens each is bucketed by
  // its OWN state and sessions that land in the same column share one card
  // (deckCards.ts `projectCards`), so two cards need two columns: one working
  // (In progress — and still In progress once the 45s window lapses into idle)
  // and one whose Bash call has sat unanswered past BLOCKED_AFTER_MS (720s) —
  // `blocked`, which is Action required (bucket.ts `deriveBucket`). Both stay
  // put for the life of the test, which is what a reopen needs.
  const pid = launched.app.process().pid!;
  seedSession(sb, { pid, cwd: sb.repoPath, id: "e2e-working" });
  seedTranscript(sb, { cwd: sb.repoPath, sessionId: "e2e-working", shape: "working" });
  seedSession(sb, { pid, cwd: sb.repoPath, id: "e2e-blocked" });
  seedTranscript(sb, { cwd: sb.repoPath, sessionId: "e2e-blocked", shape: "pending-tool", ageMs: 800_000 });

  const deck = await Deck.open(page);
  await expect(deck.cards()).toHaveCount(2, { timeout: 60_000 });
  await expect(deck.grouping("Sessions")).toHaveClass(/\bon\b/);
  await shot(page, testInfo, "4 · Sessions lens: two cards for one worktree");

  await deck.grouping("Workspaces").click();
  await expect(deck.cards()).toHaveCount(1);
  await expect(deck.grouping("Workspaces")).toHaveClass(/\bon\b/);
  // The record: `deck:setGrouping` writes the setting at Global scope
  // (deckView.ts), which in this sandbox is the user-data settings.json.
  const settingsFile = path.join(sb.userDataDir, "User", "settings.json");
  await expect
    .poll(() => (JSON.parse(fs.readFileSync(settingsFile, "utf8")) as Record<string, unknown>)["agentFlow.deckGrouping"], { timeout: 15_000 })
    .toBe("workspaces");
  await shot(page, testInfo, "5 · Workspaces lens: one card");

  // A genuine reopen — dispose the panel, then open it again through the
  // palette, so `deck:ready` runs a second time against a fresh webview.
  await Deck.closeAll(page);
  const reopened = await Deck.open(page);
  await expect(reopened.cards()).toHaveCount(1, { timeout: 60_000 });
  await expect(reopened.grouping("Workspaces")).toHaveClass(/\bon\b/);
  await shot(page, testInfo, "6 · reopened: still Workspaces, still one card");
});

// Mutation-checked: workspace.ts `openInEditor` fallback → `workbench.action.newWindow` (every Open minted a window)
test("Open focuses an already-open window instead of duplicating it", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = makeSandbox();
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;

  // A real take first, so a second window genuinely holds the run's repo —
  // same steps as take-task.e2e.ts, and the only honest way to have a window
  // for Open to find.
  await openTasksView(page);
  const pool = tasksFrame(page).locator(".card", { hasText: FIXTURE_TASK.key });
  await expect(pool).toBeVisible({ timeout: 30_000 });
  await pool.locator("button.take").click();
  const quickInput = page.locator(".quick-input-widget");
  await expect(quickInput).toBeVisible({ timeout: 15_000 });
  await expect(quickInput).toContainText("rocket");
  const newWindow = app.waitForEvent("window", { timeout: 60_000 });
  await page.keyboard.press("Enter");
  const opened = await newWindow;
  await opened.locator(".activitybar").waitFor({ timeout: 60_000 });
  const before = app.windows().length;
  expect(before).toBe(2);

  // The sidebar is open in this window, so resolve the Deck by content.
  const deck = await Deck.openBesideSidebar(page);
  const open = deck.openButton(FIXTURE_TASK.key);
  await expect(open).toBeVisible({ timeout: 60_000 });
  // The board's own read that the window is open: presence written by the
  // second window's extension host, read back as `windowOpen`, painted as
  // `live` on the very button about to be pressed (DeckApp.tsx:545-546).
  await expect(open).toHaveClass(/\blive\b/, { timeout: 90_000 });
  await shot(page, testInfo, "7 · Open reads live for a run whose window is up");

  // Twice, and a pause after each: `vscode.openFolder` for a folder already
  // open focuses that window, so no `window` event ever fires — the only way
  // to prove a negative here is to give a duplicate the time to appear.
  for (let i = 0; i < 2; i++) {
    await open.click();
    await page.waitForTimeout(6_000);
  }
  expect(app.windows().length).toBe(before);
  await shot(page, testInfo, "8 · still two windows after two Opens");
});

// Mutation-checked: diffView.ts `openTaskDiff` returns "empty" before `vscode.changes` — no editor opened, only the toast
test("Diff opens the working diff", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = makeSandbox();
  seedRun(sb, baseRun(sb, "E2E-9", { createdAt: Date.now() }));
  // An uncommitted change in the run's repo. The sandbox repo has no remote, so
  // `taskDiffBase` resolves to HEAD (git.ts) and the working diff is exactly
  // this edit.
  fs.appendFileSync(path.join(sb.repoPath, "README.md"), "\nThe panel reads the live feed now.\n");

  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;
  const deck = await Deck.open(page);
  await expect(deck.card("E2E-9")).toBeVisible({ timeout: 60_000 });

  await deck.diffButton("E2E-9").click();
  // `vscode.changes` opens the workbench's multi-file diff editor under the
  // title `diffTitle` builds — "Changes in <key> — <repo>" (diffView.ts:56-64).
  // Workbench chrome, on the top-level page, outside every webview.
  const tab = page.locator(".tab", { hasText: "Changes in E2E-9" });
  await expect(tab).toBeVisible({ timeout: 30_000 });
  await expect(tab).toContainText("rocket");
  // And the one changed file is what it shows.
  await expect(page.locator(".editor-instance", { hasText: "README.md" })).toBeVisible({ timeout: 30_000 });
  await shot(page, testInfo, "9 · the multi-file diff editor for the run");
});

// Mutation-checked: DeckDetail.tsx "This task" group's `Open in ${sourceLabel}` item dropped
test("the overflow menu offers Open in Jira and Forget", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = makeSandbox();
  seedRun(sb, baseRun(sb, "E2E-10", { createdAt: Date.now() }));

  const launched = await launchHost(sb);
  app = launched.app;
  const deck = await Deck.open(launched.page);
  await expect(deck.card("E2E-10")).toBeVisible({ timeout: 60_000 });

  // The card carries no ⋯ of its own any more: the card-detail rebuild moved
  // the rarer actions behind the drawer's `More` disclosure (DeckDetail.tsx:633),
  // and that is where both rows the doc names live. "Open in Jira" is "Open in
  // <source label>" — the fixture connector's label is "Fixture"
  // (src/tasks/fixture/connector.ts:159) — with the ticket key as its hint.
  await deck.card("E2E-10").click();
  await deck.openMore();
  const dd = deck.detail();
  const openIn = dd.getByRole("button", { name: /^Open in / });
  await expect(openIn).toBeVisible();
  await expect(openIn.locator(".h")).toHaveText("E2E-10");
  await expect(dd.getByRole("button", { name: "Forget", exact: true })).toBeVisible();
  await shot(launched.page, testInfo, "10 · More menu: Open in …, Forget");
});

// Mutation-checked: DeckApp.tsx In progress tile counts `c.column === "review"` — the tile read 0 against a column of 1
test("header tiles count what the columns hold", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = makeSandbox();
  const telemetry = secondRepo(sb, "telemetry");
  seedRun(sb, baseRun(sb, "E2E-11", { createdAt: Date.now() }));
  seedRun(sb, baseRun(sb, "E2E-12", {
    createdAt: Date.now(),
    repos: [{ name: "telemetry", path: telemetry, isGit: true, branch: "main" }],
  }));

  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;
  // One session per run, in two states that land in two different columns: a
  // working one (In progress, and still In progress once 45s turns it idle)
  // and one blocked on a Bash call older than BLOCKED_AFTER_MS (Action
  // required — bucket.ts `deriveBucket`). See the grouping test for why those
  // two and not "ended turn", which the board files under In progress.
  const pid = launched.app.process().pid!;
  seedSession(sb, { pid, cwd: sb.repoPath, id: "e2e-progress" });
  seedTranscript(sb, { cwd: sb.repoPath, sessionId: "e2e-progress", shape: "working" });
  seedSession(sb, { pid, cwd: telemetry, id: "e2e-needs" });
  seedTranscript(sb, { cwd: telemetry, sessionId: "e2e-needs", shape: "pending-tool", ageMs: 800_000 });

  const deck = await Deck.open(page);
  await expect(deck.cards()).toHaveCount(2, { timeout: 60_000 });
  // Four columns, attention rising left to right.
  await expect(deck.columnNames()).toHaveText(["In progress", "Action required", "In review", "Merge"]);
  // The tiles say what the columns hold — and the columns' own counts agree.
  await expect(deck.tile("In progress")).toHaveText("1", { timeout: 60_000 });
  await expect(deck.tile("Action required")).toHaveText("1");
  await expect(deck.tile("In review")).toHaveText("0");
  await expect(deck.tile("Merge")).toHaveText("0");
  await expect(deck.columnCount("In progress")).toHaveText("1");
  await expect(deck.columnCount("Action required")).toHaveText("1");
  await expect(deck.columnCount("In review")).toHaveText("0");
  await expect(deck.columnCount("Merge")).toHaveText("0");
  await shot(page, testInfo, "11 · tiles 1 · 1 · 0 · 0 over the same columns");
});

// Mutation-checked: DeckApp.tsx `setSyncedAt(Date.now())` on `deck:runs` dropped — the caption stayed "refresh"
test("the refresh control reports when it last synced", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = makeSandbox();
  seedRun(sb, baseRun(sb, "E2E-13", { createdAt: Date.now() }));

  const launched = await launchHost(sb);
  app = launched.app;
  const deck = await Deck.open(launched.page);

  // After the first board build the caption reads `synced Ns ago` and ticks.
  const synced = deck.synced();
  await expect(synced).toHaveText(/^synced \d+s ago$/, { timeout: 60_000 });
  // Let it age past a couple of seconds so a reset is distinguishable from
  // the count simply being small.
  await expect(synced).toHaveText(/^synced ([3-9]|\d\d+)s ago$/, { timeout: 30_000 });
  await shot(launched.page, testInfo, "12 · synced Ns ago, ticking");

  // Pressing it re-syncs: the caption says so in flight, then restarts the count.
  await deck.refresh().click();
  await expect(synced).toHaveText(/^(syncing…|synced [0-2]s ago)$/, { timeout: 30_000 });
  await expect(synced).toHaveText(/^synced \d+s ago$/, { timeout: 60_000 });
  await shot(launched.page, testInfo, "13 · re-synced on demand");
});
