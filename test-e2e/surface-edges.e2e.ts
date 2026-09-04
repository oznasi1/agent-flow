import { test, expect } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import * as fs from "fs";
import * as path from "path";
import { makeSandbox, FIXTURE_TASK, FIXTURE_TASK_2, FIXTURE_CHILD, type Sandbox } from "./_helpers/sandbox";
import { VSCODE_VERSION, launchHost } from "./_helpers/host";
import { installCopilotChat } from "./_helpers/copilotChat";
import { Pool } from "./_helpers/po/pool";
import { shot } from "./_helpers/shot";

// The edges of "where the session opens" (SETTINGS § Where the session opens) and
// of the batch launch (GUIDE § What it does · Launch in parallel): the terminal
// surface with no CLI behind it, `agentProvider: "ask"` for one launch and for a
// batch, the Copilot batch, the confirmation threshold, the no-repo fallback and the
// shared-window layout. Per-test hosts — every test flips a setting the sandbox
// default pre-answers, so nothing here can share a window.
//
// The batch journeys run on the TERMINAL surface even where the plan's settings
// column says "default". Two reasons, both about the harness rather than the
// product: (1) the extension surface with no Claude Code extension installed falls
// through to the `vscode://Anthropic.claude-code/open` URI rung, which
// `openExternal` hands to the OS — on a developer machine that bounces into the
// REAL installed editor (see seed-terminal.e2e.ts); and (2) a terminal named
// `Claude · <KEY>` per task is the one observable proof that a shared window
// really did seed a session per task, which the extension surface cannot show
// without the panel. Neither is a seam: the surface is an ordinary setting.

let sb: Sandbox;
let app: ElectronApplication | undefined;

test.afterEach(async () => { await app?.close(); app = undefined; sb.dispose(); });

/** Everything the integrated terminal currently shows. xterm.js renders the
 *  buffer into .xterm-rows; innerText of that node is the visible screen. */
async function terminalText(win: Page): Promise<string> {
  const rows = win.locator(".terminal .xterm-rows").last();
  return (await rows.count()) ? await rows.innerText() : "";
}

/** The same screen with the terminal's own hard wrap taken back out.
 *
 *  xterm wraps at the terminal's width and `innerText` gives every VISUAL row its
 *  own line, so a phrase arrives split by a newline that is nowhere in the text.
 *  Where the split falls is decided by the shell prompt in front of it —
 *  `runner@<hostname>:<sandbox>/repos/rocket$ ` — so it moves with the hostname of
 *  whichever machine ran the job, and a phrase can sit safely mid-line for months
 *  before a runner with a name one character longer breaks it in half. Assertions
 *  about what the terminal SAYS go through here; the raw screen is still what you
 *  want for anything about its layout. The rows are joined with nothing because
 *  that is what a hard wrap is: no character was inserted to make it. */
function unwrapped(screen: string): string {
  return screen.replace(/\n/g, "");
}

/** Collect every window the app opens from launch onward. A one-shot
 *  `waitForEvent("window")` can only catch one window and races a second; and
 *  every window has to be awaited to its `.activitybar` before `afterEach`
 *  closes the app, or `electronApplication.close()` hangs on a window still
 *  mid-activation (review-launch.e2e.ts learned this the hard way). */
function collectWindows(app: ElectronApplication): Page[] {
  const windows: Page[] = [];
  app.on("window", (w) => windows.push(w));
  return windows;
}

async function waitForWindows(windows: Page[], count: number, timeout: number): Promise<void> {
  await expect.poll(() => windows.length, { timeout }).toBeGreaterThanOrEqual(count);
  for (const w of windows.slice(0, count)) {
    await w.locator(".activitybar").waitFor({ timeout: 60_000 });
  }
}

/** The workbench's quick-input widget — pickers live on the top-level page,
 *  outside every `iframe.webview`. Selectors are VS Code 1.96.2 workbench DOM
 *  (`.quick-input-widget`, `.quick-input-title`, `.quick-input-list .monaco-list-row`),
 *  the same ones palette.ts and batch-take.e2e.ts already lean on. */
const quickInput = (win: Page) => win.locator(".quick-input-widget");
const quickRows = (win: Page) => quickInput(win).locator(".quick-input-list .monaco-list-row");
const quickTitle = (win: Page) => quickInput(win).locator(".quick-input-title");

/** Click Take on one card and confirm the repo QuickPick (pre-checked with
 *  `rocket`, because the fixture summaries name it). Returns once Enter has been
 *  sent — what comes next depends on the test's settings. */
async function takeAndConfirmRepo(pool: Pool, key: string): Promise<void> {
  await pool.card(key).locator("button.take").click();
  await expect(quickInput(pool.page)).toBeVisible({ timeout: 15_000 });
  await expect(quickInput(pool.page)).toContainText("rocket");
  await pool.page.keyboard.press("Enter");
}

/** Select the repo lens (batch mode only surfaces then — App.tsx:489
 *  `batchMode = selectedRepos.size >= 1` on 2026-09-03), tick the given cards
 *  (`.card-check`, App.tsx:877) and confirm the bar counts them. */
async function tickForBatch(pool: Pool, keys: string[]): Promise<void> {
  await pool.selectRepo("rocket");
  for (const key of keys) {
    const box = pool.card(key).locator(".card-check");
    await expect(box).toBeVisible({ timeout: 15_000 });
    await box.check();
  }
  await expect(pool.frame.locator(".batch-bar")).toContainText(`${keys.length} selected`);
}

const worktreeBrief = (key: string) => path.join(sb.repoPath, ".claude", "worktrees", key, ".pick-task", "TASK.md");
const planDir = () => path.join(sb.home, ".agentflow", "plans");
const planFiles = () => (fs.existsSync(planDir()) ? fs.readdirSync(planDir()).filter((f) => /^E2E-\d-/.test(f)) : []);

/** A terminal profile with a PATH that holds nothing but the system directories.
 *  The claim under test is "no `claude` on PATH", and deleting the sandbox shim
 *  is only half of that: the terminal's PATH is the runner's own with the sandbox
 *  `bin` prepended, and on a developer machine with the real Claude Code CLI
 *  installed the shell would find THAT next and start a real session — the one
 *  thing the sandbox exists to prevent. A non-login bash (login shells re-add
 *  /usr/local/bin and Homebrew via path_helper on macOS) with an explicit PATH
 *  makes "not on PATH" true by construction on any machine. bash rather than sh:
 *  Linux's /bin/sh is dash, whose message is `not found`, not `command not found`. */
function noCliTerminalProfile(): Record<string, unknown> {
  const profile = { path: "/bin/bash", args: [], env: { PATH: "/usr/bin:/bin" } };
  return {
    "terminal.integrated.profiles.osx": { "af-no-cli": profile },
    "terminal.integrated.defaultProfile.osx": "af-no-cli",
    "terminal.integrated.profiles.linux": { "af-no-cli": profile },
    "terminal.integrated.defaultProfile.linux": "af-no-cli",
  };
}

// Mutation-checked: seedViaTerminal (workspace.ts) gated the prompt paste on the CLI
// resolving on the extension host's PATH — the terminal then showed `command not
// found` with no `Jira E2E-1` after it, and the test failed on the prompt poll.
test("a terminal surface with no CLI on PATH says command not found and keeps the prompt", async ({}, testInfo) => {
  test.setTimeout(180_000);
  sb = makeSandbox({ "agentFlow.agentSurface": "terminal", ...noCliTerminalProfile() });
  // The sandbox shims `claude` so the terminal surface never runs a real CLI; this
  // journey is about the terminal WITHOUT one, so the shim goes before launch.
  fs.rmSync(path.join(sb.root, "bin", "claude"));

  const launched = await launchHost(sb);
  app = launched.app;
  const pool = await Pool.open(launched.page, 2);

  const newWindow = app.waitForEvent("window", { timeout: 60_000 });
  await takeAndConfirmRepo(pool, FIXTURE_TASK.key);
  const opened = await newWindow;
  await opened.locator(".activitybar").waitFor({ timeout: 60_000 });

  // The shell reports the missing binary — SETTINGS § Where the session opens:
  // "the terminal says `command not found`".
  await expect.poll(() => terminalText(opened), { timeout: 60_000 }).toContain("command not found");
  // "…and the prompt is still sitting there to reuse": seedViaTerminal types it
  // after the boot pause regardless of what the CLI did, so the task prompt lands
  // on the shell line under the error.
  await expect.poll(() => terminalText(opened), { timeout: 30_000 }).toContain(`Jira ${FIXTURE_TASK.key}`);
  const screen = await terminalText(opened);
  expect(unwrapped(screen)).toContain("rocket telemetry");
  // And it really was no CLI at all — not the shim, and not a developer's real one.
  expect(screen).not.toContain("CLAUDE-SHIM-READY");
  await shot(opened, testInfo, "1 · command not found, prompt kept");
});

// Mutation-checked: openWorkspace (workspace.ts) took `hostProviders()[0]` whenever
// the list was non-empty instead of only when it held one entry — no picker
// appeared, the window opened on Claude Code, and the test failed on the "Which
// tool?" title.
test('agentProvider "ask" asks which tool per launch', async ({}, testInfo) => {
  test.setTimeout(180_000);
  sb = makeSandbox({ "agentFlow.agentProvider": "ask", "agentFlow.agentSurface": "terminal" });
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;
  const pool = await Pool.open(page, 2);

  await takeAndConfirmRepo(pool, FIXTURE_TASK.key);

  // The repo pick closes and the tool pick opens — same widget, new title
  // (workspace.ts openWorkspace: `title: "Which tool?"`).
  await expect(quickTitle(page)).toHaveText("Which tool?", { timeout: 15_000 });
  // hostProviders() on a VS Code host (config.ts): Claude Code, Copilot, Codex —
  // Cursor's row exists only where `vscode.env.uriScheme === "cursor"`.
  await expect(quickRows(page)).toHaveCount(3);
  await expect(quickRows(page).nth(0)).toContainText("Claude Code");
  await expect(quickRows(page).nth(1)).toContainText("Copilot");
  await expect(quickRows(page).nth(2)).toContainText("Codex");
  await expect(quickInput(page)).not.toContainText("Cursor");
  await shot(page, testInfo, "1 · which tool picker");

  const newWindow = app.waitForEvent("window", { timeout: 60_000 });
  await quickRows(page).filter({ hasText: "Claude Code" }).click();
  const opened = await newWindow;
  await opened.locator(".activitybar").waitFor({ timeout: 60_000 });

  // The answer is what the window seeds: our `claude` shim ran, with the prompt.
  await expect.poll(() => terminalText(opened), { timeout: 60_000 }).toContain("CLAUDE-SHIM-READY");
  await expect.poll(() => terminalText(opened), { timeout: 30_000 }).toContain(`Jira ${FIXTURE_TASK.key}`);
  await shot(opened, testInfo, "2 · picked tool seeded");
});

// Mutation-checked: resolveBatchProvider (agentPick.ts) returned `"claude-code"`
// instead of the picked row — both windows ran the claude shim, and the test failed
// on the plan files' `provider` and the CODEX marker.
test('a batch under "ask" asks once and uses the answer for every task', async ({}, testInfo) => {
  test.setTimeout(300_000);
  sb = makeSandbox({ "agentFlow.agentProvider": "ask", "agentFlow.agentSurface": "terminal" });
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;
  const windows = collectWindows(app);
  const pool = await Pool.open(page, 2);

  await tickForBatch(pool, [FIXTURE_TASK.key, FIXTURE_TASK_2.key]);
  await pool.frame.locator("button.batch-launch").click();

  // The FIRST question a real batch asks is the tool — before the threshold
  // confirm, the prompt mode, the destination and the layout (tasksView.ts
  // takeBatch: `resolveBatchProvider` runs ahead of them all). Its placeholder is
  // the batch-wide one (agentPick.ts).
  await expect(quickTitle(page)).toHaveText("Which tool?", { timeout: 15_000 });
  await expect(quickInput(page).getByPlaceholder("Pick the tool for every session in this batch")).toBeVisible();
  await shot(page, testInfo, "1 · asked once, for the batch");
  // Codex, not Claude Code: the sandbox's degradation default IS Claude Code, so
  // only a non-default answer can prove the answer travelled rather than the
  // default. Both shims print a distinct marker.
  await quickRows(page).filter({ hasText: "Codex" }).click();

  // Next question is the layout — not the tool again.
  await expect(quickTitle(page)).toContainText("how should I lay them out", { timeout: 15_000 });
  await expect(quickInput(page)).toContainText("Separate windows");
  await page.keyboard.press("Enter");

  await waitForWindows(windows, 2, 120_000);
  // Both windows run the CODEX shim: the one answer was pinned onto every task's
  // plan and seeded in each window.
  for (const w of windows.slice(0, 2)) {
    await expect.poll(() => terminalText(w), { timeout: 90_000 }).toContain("CODEX-SHIM-READY");
    expect(await terminalText(w)).not.toContain("CLAUDE-SHIM-READY");
  }
  // The record: each plan file carries the pinned provider (workspace.ts writes
  // `provider` into the plan only when `ask` resolved it).
  await expect.poll(() => planFiles().length, { timeout: 30_000 }).toBe(2);
  for (const f of planFiles()) {
    const plan = JSON.parse(fs.readFileSync(path.join(planDir(), f), "utf8")) as { provider?: string };
    expect(plan.provider, f).toBe("codex");
  }
  // And nobody was asked a second time: a re-raised picker (`ignoreFocusOut`) would
  // still be standing on the source window.
  await expect(quickInput(page)).toBeHidden();
  await shot(windows[1], testInfo, "2 · second window seeded with the same answer");
});

// Pinned: the doc (SETTINGS § Where the session opens) says a Copilot batch on the
// extension surface "does not seed the chat panel at all" and shows a notification
// pointing at the briefs. The product does that only when the batch SHARES one
// window: `multi` (workspace.ts runSeedPass) is per-window, so in the default
// separate-windows layout each window seeds exactly one plan, `seedChatPanel` sees
// `multi === false`, and every window opens its own Copilot Chat panel (the
// `perTaskNote` in tasksView.ts takeBatch keys the "isn't seeded for a batch" copy
// on `shared` for the same reason). The briefs ARE all written; the "seeds no
// panel" half is what fails here.
// Mutation-checked: n/a — pinned with test.fail(); the failing assertion is the doc's.
test.fail("a Copilot extension-surface batch writes every brief, seeds no panel, and says why", async ({}, testInfo) => {
  test.setTimeout(300_000);
  sb = makeSandbox({ "agentFlow.agentProvider": "copilot", "agentFlow.agentSurface": "extension" });
  await installCopilotChat(await downloadAndUnzipVSCode(VSCODE_VERSION), sb);
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;
  const windows = collectWindows(app);
  const pool = await Pool.open(page, 2);

  await tickForBatch(pool, [FIXTURE_TASK.key, FIXTURE_TASK_2.key]);
  await pool.frame.locator("button.batch-launch").click();
  // Layout: the first row, "Separate windows" — the doc's default ("one window per
  // task by default", GUIDE § What it does).
  await expect(quickInput(page)).toContainText("Separate windows", { timeout: 15_000 });
  await page.keyboard.press("Enter");
  await waitForWindows(windows, 2, 120_000);

  // Doc, part one — holds: every brief is written.
  for (const key of [FIXTURE_TASK.key, FIXTURE_TASK_2.key]) {
    await expect.poll(() => fs.existsSync(worktreeBrief(key)), { timeout: 30_000 }).toBe(true);
  }

  // Observe what the product does in each window before asserting the doc: the
  // welcome copy is the discriminator copilot-panel.e2e.ts established — only the
  // real Copilot Chat panel can render it, and an unauthenticated pinned build
  // renders it instead of the seeded prompt.
  const welcome = (w: Page) => w.getByText(/welcome to copilot/i);
  await welcome(windows[0]).first().waitFor({ state: "visible", timeout: 180_000 }).catch(() => undefined);
  await shot(windows[0], testInfo, "1 · first batch window");

  // Doc, part two — "does not seed the chat panel at all": no panel in either window…
  await expect(welcome(windows[0])).toHaveCount(0);
  await expect(welcome(windows[1])).toHaveCount(0);
  // …and a notification pointing at the briefs instead (workspace.ts's `multi`
  // fallback copy).
  await expect(windows[0].locator(".notification-list-item-message", { hasText: "Its brief is in" })).toBeVisible({ timeout: 30_000 });
});

// Mutation-checked: takeBatch (tasksView.ts) compared `authorising` against
// `Number.MAX_SAFE_INTEGER` instead of the setting — no dialog appeared and the
// layout picker came up instead, so the test failed on `.monaco-dialog-box`.
test("a batch larger than the threshold asks first", async ({}, testInfo) => {
  test.setTimeout(180_000);
  sb = makeSandbox({
    "agentFlow.batchLaunchConfirmThreshold": 1,
    // The confirm is a modal `showWarningMessage`; "custom" renders it as workbench
    // DOM (`.monaco-dialog-box`) instead of a native OS sheet Playwright cannot
    // reach (same reason as deck-lifecycle.e2e.ts).
    "window.dialogStyle": "custom",
  });
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;
  const pool = await Pool.open(page, 2);

  await tickForBatch(pool, [FIXTURE_TASK.key, FIXTURE_TASK_2.key]);
  await pool.frame.locator("button.batch-launch").click();

  // Two tasks over a threshold of one: the modal names the batch and its cost in
  // sessions (tasksView.ts takeBatch) before any other question.
  const dialog = page.locator(".monaco-dialog-box");
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(dialog).toContainText("Launch 2 tasks in parallel?");
  await expect(dialog).toContainText("2 Claude Code sessions");
  await shot(page, testInfo, "1 · threshold confirm");

  await dialog.getByRole("button", { name: /^cancel$/i }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });

  // Cancel means nothing happened: no further question, no window, no worktree, no
  // brief, no plan. A negative needs a settled moment to be worth anything, so
  // give the host longer than a launch would take to open its first window.
  await page.waitForTimeout(8_000);
  await expect(quickInput(page)).toBeHidden();
  expect(app.windows().length).toBe(1);
  expect(fs.existsSync(path.join(sb.repoPath, ".claude", "worktrees"))).toBe(false);
  expect(fs.existsSync(path.join(sb.repoPath, ".pick-task"))).toBe(false);
  expect(planFiles()).toEqual([]);
  await shot(page, testInfo, "2 · cancelled, nothing launched");
});

// Pinned: GUIDE § What it does says a task whose ticket names none of the filtered
// repos launches in all of them, "so no task launches with no repo". The sidebar
// never lets such a task into a batch: the repo lens hides every card whose
// inferred services miss the selected repo (App.tsx:484 on 2026-09-03 —
// `(t.services ?? []).some((s) => selectedRepos.has(s))`), and the checkbox only
// exists under that lens. The all-filtered-repos fallback (tasksView.ts
// `reposForTask`: `narrowed.length ? narrowed : filterSet`) is real, but reachable
// only through a fan-out or the Orchestrator, never by ticking the card the doc
// describes.
// Mutation-checked: n/a — pinned with test.fail(); the failing assertion is the doc's.
test.fail("a task touching none of the filtered repos launches in all of them", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = makeSandbox({ "agentFlow.agentSurface": "terminal" });
  // A third top-level task whose text names no repo at all (the only repo is
  // `rocket`; `inferServices` matches whole repo names ≥ 5 letters against the
  // summary and description).
  const NO_REPO_TASK = {
    ...FIXTURE_TASK,
    key: "E2E-3", summary: "Tidy the launch checklist",
    url: "https://fixture.invalid/browse/E2E-3",
    descriptionText: "The checklist has stale steps.",
  };
  fs.writeFileSync(
    path.join(sb.fixtureDir, "tasks.json"),
    JSON.stringify([FIXTURE_TASK, FIXTURE_TASK_2, FIXTURE_CHILD, NO_REPO_TASK], null, 2),
  );
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;
  const windows = collectWindows(app);
  const pool = await Pool.open(page, 3);
  await expect(pool.card("E2E-3")).toBeVisible();

  await pool.selectRepo("rocket");
  await expect(pool.card(FIXTURE_TASK.key).locator(".card-check")).toBeVisible({ timeout: 15_000 });
  await shot(page, testInfo, "1 · repo lens on rocket");
  // The doc's journey: the no-repo task is still there to tick under the lens.
  await expect(pool.card("E2E-3")).toBeVisible({ timeout: 10_000 });

  await pool.card("E2E-3").locator(".card-check").check();
  await pool.card(FIXTURE_TASK.key).locator(".card-check").check();
  await expect(pool.frame.locator(".batch-bar")).toContainText("2 selected");
  await pool.frame.locator("button.batch-launch").click();
  await expect(quickInput(page)).toContainText("Separate windows", { timeout: 15_000 });
  await page.keyboard.press("Enter");
  await waitForWindows(windows, 2, 120_000);

  // "…or in all of them": the no-repo task gets a worktree and a brief in rocket.
  await expect.poll(() => fs.existsSync(worktreeBrief("E2E-3")), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => fs.existsSync(worktreeBrief(FIXTURE_TASK.key)), { timeout: 30_000 }).toBe(true);
});

// Mutation-checked: openSharedWorkspace (batchWorkspace.ts) wrote a plan for
// `tasks.slice(0, 1)` only — one plan file, one terminal, and the test failed on
// the plan count.
test("a shared-window batch stacks every task in one window", async ({}, testInfo) => {
  test.setTimeout(300_000);
  sb = makeSandbox({ "agentFlow.agentSurface": "terminal" });
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;
  const windows = collectWindows(app);
  const pool = await Pool.open(page, 2);

  await tickForBatch(pool, [FIXTURE_TASK.key, FIXTURE_TASK_2.key]);
  await pool.frame.locator("button.batch-launch").click();

  // Layout: the SECOND row (tasksView.ts takeBatch: "$(window) One shared window").
  await expect(quickInput(page)).toContainText("One shared window", { timeout: 15_000 });
  await page.keyboard.press("ArrowDown");
  await expect(quickRows(page).filter({ hasText: "One shared window" })).toHaveClass(/focused/);
  await shot(page, testInfo, "1 · one shared window picked");
  await page.keyboard.press("Enter");

  // Exactly one new window.
  await waitForWindows(windows, 1, 120_000);
  const shared = windows[0];

  // Both worktrees, both briefs — in the shared checkout's own worktree dir, the
  // shared checkout itself untouched.
  for (const key of [FIXTURE_TASK.key, FIXTURE_TASK_2.key]) {
    await expect.poll(() => fs.existsSync(worktreeBrief(key)), { timeout: 30_000 }).toBe(true);
  }
  expect(fs.existsSync(path.join(sb.repoPath, ".pick-task"))).toBe(false);

  // One workspace file holding both worktrees as roots, named after the first task
  // plus how many more it carries (batchWorkspace.ts: `${first}+${n-1}.code-workspace`).
  const wsFile = path.join(sb.root, "workspaces", `${FIXTURE_TASK.key}+1.code-workspace`);
  await expect.poll(() => fs.existsSync(wsFile), { timeout: 30_000 }).toBe(true);
  const ws = JSON.parse(fs.readFileSync(wsFile, "utf8")) as { folders: { name: string; path: string }[] };
  expect(ws.folders.map((f) => f.name)).toEqual([`rocket-${FIXTURE_TASK.key}`, `rocket-${FIXTURE_TASK_2.key}`]);

  // Two plan files, both naming that one window.
  await expect.poll(() => planFiles().length, { timeout: 30_000 }).toBe(2);
  for (const f of planFiles()) {
    const plan = JSON.parse(fs.readFileSync(path.join(planDir(), f), "utf8")) as { matches: { matchPath: string }[] };
    expect(plan.matches.map((m) => m.matchPath), f).toEqual([wsFile]);
  }

  // A session per task, stacked in the one window: two terminals, `Claude · E2E-1`
  // and `Claude · E2E-2`, in the order the tasks were picked. With more than one
  // terminal the workbench renders a tabs list beside the terminal — read off the
  // real DOM of this very journey's shared window on 2026-09-03: the terminal
  // pane body carries `.integrated-terminal`, its `.tabs-list` is a monaco list
  // with one `.monaco-list-row` per terminal, and each row's
  // `.terminal-tabs-entry` holds the terminal's name as text. Scoped to
  // `.integrated-terminal` because `.tabs-list` alone is generic workbench chrome.
  const tabs = shared.locator(".integrated-terminal .tabs-list .monaco-list-row");
  await expect(tabs).toHaveCount(2, { timeout: 90_000 });
  await expect(tabs.nth(0)).toContainText(`Claude · ${FIXTURE_TASK.key}`);
  await expect(tabs.nth(1)).toContainText(`Claude · ${FIXTURE_TASK_2.key}`);
  await expect.poll(() => terminalText(shared), { timeout: 60_000 }).toContain("CLAUDE-SHIM-READY");

  // Still exactly one new window after everything has settled.
  expect(app.windows().length).toBe(2);
  await shot(shared, testInfo, "2 · both sessions in one window");
});
