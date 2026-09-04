import { expect, test, type ElectronApplication } from "@playwright/test";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { makeSandbox, FIXTURE_TASK, type Sandbox } from "./_helpers/sandbox";
import { launchHost, openTasksView, tasksFrame } from "./_helpers/host";
import { encodeProjectDir, seedSession, seedTranscript } from "./_helpers/claudeState";
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

// Mutation-checked: DeckApp.tsx `const live = runs.filter((r) => r.shelf !== "closed")` → `const live = runs` — the closed run rendered as a card and the count assertion failed
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

// Mutation-checked: deckView.ts's two shelf overrides neutered — `const shelf = showAll ? "board" : shelfFor(…)` → `false ? …`, and `shelf: cfg.inflightShowAll ? "board" : s.shelf` → `s.shelf`; the run went back to the strip and no card ever appeared
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

// Mutation-checked: deckView.ts's `deck:setGrouping` case stripped of its `.update("deckGrouping", …)` — the settings.json poll never saw "workspaces". Same mutation as sabotage/deck-board.patch.
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

// Mutation-checked: deckView.ts `inspect`'s open branch pointed one directory up (`path.dirname(target)`) so Open resolves a folder no window holds — VS Code minted a third window and the count assertion failed
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

// Mutation-checked: diffView.ts `openTaskDiff` iterating `[] as ChangedFile[]` instead of `taskChangedFiles(repo.path)` — it reported "empty", no diff editor opened, and only the toast appeared
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

// Mutation-checked: DeckDetail.tsx's "This task" group gated its `Open in ${sourceLabel}` item on `false` instead of `tracked` — the row vanished and the assertion failed
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

// Mutation-checked twice, once per assertion this test carries: DeckApp.tsx's
// In progress tile counting `c.column === "review"` made it read 0 against a
// column of 1; and reordering COLUMNS so Merge precedes In review broke the
// column-order assertion.
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

// Mutation-checked: DeckApp.tsx's `deck:runs` handler stripped of `setSyncedAt(Date.now())` — the caption stayed "refresh" and never reported a sync
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

// Mutation-checked: deckView.ts `inspect`'s open branch — `openInEditor(target)` → `openInEditor(path.join(target, "..", "nope"))`; `vscode.openFolder` on a path that does not exist opened no window and the window-count assertion failed
test("Open opens the task's window fresh when no window is holding it", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = makeSandbox();
  seedRun(sb, baseRun(sb, "E2E-14", { createdAt: Date.now() }));

  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;
  const deck = await Deck.open(page);
  await expect(deck.card("E2E-14")).toBeVisible({ timeout: 60_000 });

  // Nothing holds the run's repo: this window is empty (launchHost passes no
  // folder), so presence reports no window for it and the button is NOT `live`
  // — the other half of `deck-board`'s focus test above, where it is.
  const open = deck.openButton("E2E-14");
  await expect(open).not.toHaveClass(/\blive\b/);
  expect(app.windows().length).toBe(1);
  await shot(page, testInfo, "14 · Open, with no window holding the run");

  // `openInEditor` (engine/workspace.ts:368) shells `open -a` first — the
  // sandbox's shim makes that fail (sandbox.ts) — and falls back to
  // `vscode.openFolder{forceNewWindow:true}`, which mints a window inside this
  // same Electron app where Playwright can see it.
  const appeared = app.waitForEvent("window", { timeout: 60_000 });
  await open.click();
  const opened = await appeared;
  await opened.locator(".activitybar").waitFor({ timeout: 60_000 });
  expect(app.windows().length).toBe(2);
  // And it is the RUN's own directory: the workbench titles a folder window
  // after its root.
  await expect.poll(() => opened.title(), { timeout: 30_000 }).toContain("rocket");
  await shot(page, testInfo, "15 · a fresh window on the run's repo");
});

// Mutation-checked: DeckApp.tsx:547-552 — the `...(agent?.repo ? { repo: agent.repo } : {})` spread dropped from BOTH the Open and the Diff message; `inspect` fell back to `run.repos[0]` (rocket) and both the diff-title and the window-title assertions failed
test("on a per-session card Open and Diff act on that session's own directory", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = makeSandbox();
  const telemetry = secondRepo(sb, "telemetry");
  // ONE run spanning two repos, `rocket` first — so a card acting on
  // `run.repos[0]` would act on rocket, and only a card reading its own
  // session's `repo` can act on telemetry (types.ts:281-289 `CardAgent.repo`).
  seedRun(sb, baseRun(sb, "E2E-15", {
    createdAt: Date.now(),
    repos: [
      { name: "rocket", path: sb.repoPath, isGit: true, branch: "main" },
      { name: "telemetry", path: telemetry, isGit: true, branch: "main" },
    ],
  }));
  // An uncommitted edit in telemetry ONLY: `openTaskDiff` toasts "no changes"
  // for a clean repo, so this is also what makes a wrong-directory Diff
  // observable rather than merely different.
  fs.appendFileSync(path.join(telemetry, "README.md"), "\nThe feed points at the live endpoint now.\n");

  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;
  // Two sessions in the one run, in two directories AND two columns — the
  // Sessions lens gives one card per column (`projectCards`, deckCards.ts:76-88),
  // so two columns is what makes two per-session cards at all.
  const pid = launched.app.process().pid!;
  seedSession(sb, { pid, cwd: sb.repoPath, id: "e2e-rocket" });
  seedTranscript(sb, { cwd: sb.repoPath, sessionId: "e2e-rocket", shape: "working" });
  seedSession(sb, { pid, cwd: telemetry, id: "e2e-telemetry" });
  seedTranscript(sb, { cwd: telemetry, sessionId: "e2e-telemetry", shape: "pending-tool", ageMs: 800_000 });

  const deck = await Deck.open(page);
  await expect(deck.cards()).toHaveCount(2, { timeout: 60_000 });
  // The telemetry session is the blocked one, so its card is the Action
  // required one; rocket's working session holds the In progress card.
  const card = deck.cardIn("Action required", "E2E-15");
  await expect(card).toBeVisible({ timeout: 60_000 });
  await shot(page, testInfo, "16 · two per-session cards for one two-repo run");

  // Open FIRST, and the order is load-bearing: Diff opens the workbench's
  // multi-file diff editor in THIS window, which takes the editor area from the
  // Deck panel — after that the card's own buttons are no longer visible and the
  // Open click times out (observed live). Open costs the Deck nothing: the window
  // it mints is a second one.
  //
  // The same `repo` rides on the message (DeckApp.tsx:547), so the window lands
  // on telemetry rather than on the run's first repo.
  const appeared = app.waitForEvent("window", { timeout: 60_000 });
  await card.locator(".c-foot2 .act.primary").click();
  const opened = await appeared;
  await opened.locator(".activitybar").waitFor({ timeout: 60_000 });
  await expect.poll(() => opened.title(), { timeout: 30_000 }).toContain("telemetry");
  await shot(page, testInfo, "17 · Open on the telemetry session's own repo");

  // Diff: `diffTitle` names the repos actually being diffed (diffView.ts:56-64),
  // so the tab title is the record of which directory the card acted on.
  await card.locator(".c-foot2 .act", { hasText: "Diff" }).click();
  const tab = page.locator(".tab", { hasText: "Changes in E2E-15" });
  await expect(tab).toBeVisible({ timeout: 30_000 });
  await expect(tab).toContainText("telemetry");
  await expect(tab).not.toContainText("rocket");
  await shot(page, testInfo, "18 · Diff on the telemetry session's own repo");
});

// Mutation-checked: webview/helpers.ts:262 — `if (runKind(run) === "notepad") return "notepad";` removed; the card's key slot fell through to the raw `notepad-…` key and the assertion failed
test("a note started from the Notepad sits among the tickets marked notepad", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = makeSandbox();
  // A ticket run and a notepad run on the same board — "among the tickets" is
  // the claim, so a board with only the note would not prove it.
  seedRun(sb, baseRun(sb, "E2E-16", { createdAt: Date.now() }));
  // The shape `runNotepadItem` writes (tasksView.ts:1688-1696): kind "notepad",
  // an empty url (so `isTicketRun` is false) and a `notepad-<slug>-<id>` key.
  seedRun(sb, baseRun(sb, "notepad-refit-the-strut-n1", {
    createdAt: Date.now(), kind: "notepad", url: "", summary: "Refit the strut assembly",
  }));

  const launched = await launchHost(sb);
  app = launched.app;
  const deck = await Deck.open(launched.page);
  await expect(deck.cards()).toHaveCount(2, { timeout: 60_000 });

  // `keyLabel` (webview/helpers.ts:258-264) puts the word in the key slot,
  // because the record's own key is a slug no reader can use. The ticket run
  // beside it keeps its key — as a `button.key`, since it is tracked.
  const note = deck.card("Refit the strut assembly");
  await expect(note.locator(".hd-k .key")).toHaveText("notepad");
  await expect(deck.card("E2E-16").locator("button.key")).toHaveText("E2E-16");
  await shot(launched.page, testInfo, "19 · a notepad card beside a ticket card");
});

// Mutation-checked: deckView.ts:1976 — `if (getConfig().showTokenTotal) {` → `if (false) {`; the board-wide sweep never ran, `boardEq` stayed 0 and the tile never rendered
test("showTokenTotal adds a Tokens on board total to the header", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = makeSandbox({ "agentFlow.deck.showTokenTotal": true });
  seedRun(sb, baseRun(sb, "E2E-17", { createdAt: Date.now() }));
  // A transcript carrying `message.usage`, which `seedTranscript`'s shapes
  // deliberately do not (claudeState.ts lists only the activity fields). The
  // sweep reads every transcript under the run's repos' project dirs
  // (deckView.ts `sweepUsage` → engine/usageFs.ts `readRun`), with no session
  // record needed, and `accumulateUsage` (engine/usage.ts) sums the four
  // billing classes off exactly these fields.
  const dir = path.join(sb.home, ".claude", "projects", encodeProjectDir(sb.repoPath));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "e2e-spend.jsonl"),
    JSON.stringify({
      type: "assistant", requestId: "req_e2e_1", isSidechain: false, cwd: sb.repoPath,
      message: { role: "assistant", model: "claude-fixture", id: "msg_e2e_1", usage: { input_tokens: 4_000, output_tokens: 2_000, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 40_000 } },
    }) + "\n",
  );

  const launched = await launchHost(sb);
  app = launched.app;
  const deck = await Deck.open(launched.page);
  await expect(deck.card("E2E-17")).toBeVisible({ timeout: 60_000 });

  // A fifth header tile, labelled and effort-weighted (DeckApp.tsx:1125-1136).
  // 4000×1 + 1000×1.25 + 40000×0.1 + 2000×5 = 19,250 eq, which `formatEq`
  // (engine/usage.ts:99-103) rounds to the nearest thousand: "19k", with the
  // unit as a nested span so the slot's text reads "19keq".
  const tile = deck.frame.locator(".stats .stat", { has: deck.frame.locator(".l", { hasText: "Tokens on board" }) });
  await expect(tile).toBeVisible({ timeout: 90_000 });
  await expect(tile.locator(".n")).toHaveText("19keq");
  await shot(launched.page, testInfo, "20 · the Tokens on board tile");
});

// Mutation-checked: deckView.ts `forgeReady` — `return this.forgeGap === null` → `return true`; every PR read was then attempted and ENOENT'd, the card grew a `⚠ PR unread` row and the legend note changed to the unread wording, failing two of the three assertions
test("without the forge CLI the Deck falls back to the git and task-source backbone", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = makeSandbox({ "agentFlow.prFacts": true });
  seedRun(sb, baseRun(sb, "E2E-18", { createdAt: Date.now() }));
  // "Not installed" is a `spawn … ENOENT`, and that is precisely how the
  // product defines it: `probeGh` (engine/pr/provider.ts:105-122) reads
  // `code === "ENOENT"` as `missing` and anything else as `signed-out`. The
  // harness cannot take a CLI off the machine — `resolveBin` (engine/pr/which.ts)
  // searches /opt/homebrew/bin and /usr/local/bin after PATH, absolute paths
  // outside the sandbox — so it puts a `gh` on the sandbox's own PATH dir that
  // cannot execute: a shebang naming an interpreter that does not exist makes
  // execve return ENOENT, exactly as a missing binary does. Verified live on
  // darwin; execve answers the same on linux.
  fs.writeFileSync(path.join(sb.root, "bin", "gh"), "#!/nonexistent/interpreter\n", { mode: 0o755 });

  const launched = await launchHost(sb);
  app = launched.app;
  const deck = await Deck.open(launched.page);
  const card = deck.card("E2E-18");
  await expect(card).toBeVisible({ timeout: 60_000 });

  // The legend says which gap, in the CLI's own name (deckView.ts:90-93
  // FORGE_NOTES, rendered at DeckApp.tsx:1381). Its `missing` wording is what
  // separates "not installed" from "not signed in".
  await expect(deck.frame.locator(".legend .note.warn")).toHaveText("gh CLI not found — PR facts off. Run Doctor", { timeout: 90_000 });
  // And the card is the backbone: its signal line carries the branch git read,
  // and there are no PR failure rows — `forgeReady` false means no fetch was
  // ever queued, so nothing is carried forward as unread either.
  await expect(card.locator(".c-sig")).toContainText("main");
  await expect(card.locator(".c-rows")).toHaveCount(0);
  await shot(launched.page, testInfo, "21 · no gh: the git + Fixture backbone, and the note that says so");
});
