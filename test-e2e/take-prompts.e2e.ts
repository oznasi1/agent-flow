import { test, expect } from "@playwright/test";
import type { ElectronApplication, Locator, Page } from "@playwright/test";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { makeSandbox, FIXTURE_TASK, type Sandbox } from "./_helpers/sandbox";
import { launchHost, openTasksView, tasksFrame } from "./_helpers/host";
import { shot } from "./_helpers/shot";

/** The three questions a Take can ask — prompt mode, worktree, destination — and the
 *  two layouts it can write. The sandbox contract pre-answers every one of them
 *  (sandbox.ts: taskMode "implementation", openIn "new-window", worktree "never"), so
 *  each journey here UN-answers exactly the one under test and drives the real
 *  QuickPick that appears. Per-test hosts: every path but the picker-only ones opens
 *  a window, creates a worktree or writes a run record, which a shared host would
 *  hand the next test. */

let sb: Sandbox | undefined;
let app: ElectronApplication | undefined;

test.afterEach(async () => {
  await app?.close();
  app = undefined;
  sb?.dispose();
  sb = undefined;
});

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" });

/** A second real git repo beside `rocket`. Its name is a whole word in the fixture
 *  task's summary ("Fix the rocket telemetry panel"), so `inferServices`
 *  (src/engine/infer.ts) matches it by text exactly as it does `rocket`. */
function addRepo(sandbox: Sandbox, name: string): string {
  const repo = path.join(sandbox.reposRoot, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  fs.writeFileSync(path.join(repo, "README.md"), `# ${name}\n`);
  git(repo, ["add", "."]);
  git(repo, ["-c", "user.email=e2e@fixture.invalid", "-c", "user.name=E2E", "commit", "-qm", "init"]);
  return repo;
}

/** Every window the app opens from launch onward — a one-shot `waitForEvent` can only
 *  catch one and races a second. Each must reach `.activitybar` before `afterEach`
 *  closes the app, or `electronApplication.close()` hangs on a window still
 *  mid-activation (review-launch.e2e.ts learned this the hard way). */
function collectWindows(application: ElectronApplication): Page[] {
  const windows: Page[] = [];
  application.on("window", (w) => windows.push(w));
  return windows;
}

async function settleWindows(windows: Page[], count: number, timeout = 90_000): Promise<void> {
  await expect.poll(() => windows.length, { timeout }).toBeGreaterThanOrEqual(count);
  for (const w of windows.slice(0, count)) {
    await w.locator(".activitybar").waitFor({ timeout: 60_000 });
  }
}

/** Boot a host on `sandbox`, open the sidebar, and hand back the fixture task's card
 *  (`.card`, App.tsx:851 on 2026-09-03) with the window collector already armed. */
async function boot(
  sandbox: Sandbox,
  opts: { folder?: string } = {},
): Promise<{ page: Page; card: Locator; windows: Page[] }> {
  const launched = await launchHost(sandbox, opts);
  app = launched.app;
  const windows = collectWindows(app);
  const page = launched.page;
  await openTasksView(page);
  const card = tasksFrame(page).locator(".card", { hasText: FIXTURE_TASK.key });
  await expect(card).toBeVisible({ timeout: 30_000 });
  return { page, card, windows };
}

/** The workbench's QuickPick: top-level page chrome, never inside the webview. */
function quickPick(page: Page): { widget: Locator; rows: Locator; row: (text: string) => Locator } {
  const widget = page.locator(".quick-input-widget");
  const rows = widget.locator(".quick-input-list .monaco-list-row");
  return { widget, rows, row: (text) => rows.filter({ hasText: text }) };
}

/** The repo-confirm QuickPick Take always asks for a NEW window: "rocket" arrives
 *  pre-checked (the summary names it), so Enter confirms whatever is checked. */
async function confirmRepos(page: Page): Promise<void> {
  const { widget } = quickPick(page);
  await expect(widget).toBeVisible({ timeout: 15_000 });
  await expect(widget).toContainText("rocket");
  await page.keyboard.press("Enter");
}

const BUILT_IN_LABELS = ["Plan first", "Implementation", "Test-driven", "Investigate & root-cause", "Orchestrator", "Refine the ticket"];

const planFileFor = (sandbox: Sandbox, key: string): string | undefined => {
  const dir = path.join(sandbox.home, ".agentflow", "plans");
  if (!fs.existsSync(dir)) return undefined;
  const f = fs.readdirSync(dir).find((n) => n.startsWith(`${key}-`));
  return f ? path.join(dir, f) : undefined;
};

// ── Prompt modes ──────────────────────────────────────────────────────────────

// Mutation-checked: removed the "orchestrator" entry from DEFAULT_PROMPT_MODES (src/config.ts) — the picker showed five rows and "Orchestrator" was absent.
test("taking a task asks how the session should start, listing the six built-in modes", async ({}, testInfo) => {
  test.setTimeout(240_000);
  // `""` is unset: config.ts:786 reads `c.get("taskMode") || "ask"`, and "ask" names no
  // mode, so `choosePromptMode` (tasksView.ts:2357) falls through to the QuickPick.
  sb = makeSandbox({ "agentFlow.taskMode": "" });
  const { page, card } = await boot(sb);

  await card.locator("button.take").click();
  const { widget, rows } = quickPick(page);
  await expect(widget).toBeVisible({ timeout: 15_000 });
  await expect(widget).toContainText("how should the session start");
  await expect(rows).toHaveCount(6);
  for (const label of BUILT_IN_LABELS) await expect(widget).toContainText(label);
  await shot(page, testInfo, "1 · prompt-mode picker with the six built-ins");

  // Cancelling the first question is a cancelled Take: nothing lands on disk.
  await page.keyboard.press("Escape");
  await expect(widget).toBeHidden({ timeout: 15_000 });
  expect(fs.existsSync(path.join(sb.repoPath, ".pick-task"))).toBe(false);
  expect(planFileFor(sb, FIXTURE_TASK.key)).toBeUndefined();
});

// Mutation-checked: made resolveModes (src/config.ts) prefer the built-in label over the entry's — "Just build it" never appeared and "Implementation" did.
test("a promptModes entry overrides a built-in's label without replacing the rest", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = makeSandbox({
    "agentFlow.taskMode": "",
    "agentFlow.promptModes": [{ id: "implementation", label: "Just build it" }],
  });
  const { page, card } = await boot(sb);

  await card.locator("button.take").click();
  const { widget, rows } = quickPick(page);
  await expect(widget).toBeVisible({ timeout: 15_000 });
  await expect(rows).toHaveCount(6);
  await expect(widget).toContainText("Just build it");
  // The label is replaced, not duplicated — and no other detail line carries the word.
  await expect(widget).not.toContainText("Implementation");
  for (const label of BUILT_IN_LABELS.filter((l) => l !== "Implementation")) await expect(widget).toContainText(label);
  await shot(page, testInfo, "1 · Implementation relabelled, five built-ins kept");
  await page.keyboard.press("Escape");
});

// Mutation-checked: made resolveModes (src/config.ts) ignore `hidden: true` — six rows came back with "Test-driven" among them.
test("a hidden prompt mode is dropped from the picker", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = makeSandbox({
    "agentFlow.taskMode": "",
    "agentFlow.promptModes": [{ id: "tdd", hidden: true }],
  });
  const { page, card } = await boot(sb);

  await card.locator("button.take").click();
  const { widget, rows } = quickPick(page);
  await expect(widget).toBeVisible({ timeout: 15_000 });
  await expect(rows).toHaveCount(5);
  await expect(widget).not.toContainText("Test-driven");
  for (const label of BUILT_IN_LABELS.filter((l) => l !== "Test-driven")) await expect(widget).toContainText(label);
  await shot(page, testInfo, "1 · five rows, Test-driven gone");
  await page.keyboard.press("Escape");
});

// Mutation-checked: takeTaskGuarded (src/tasksView.ts) passed DEFAULT_PROMPT_MODES[1].prompt to launch() instead of promptMode.prompt — the plan's prompt lost the marker.
test("a custom prompt mode lands its prompt in the brief", async ({}, testInfo) => {
  test.setTimeout(240_000);
  // A mode of the user's own needs both a label and a prompt (resolveModes, config.ts:632);
  // pinning it by id skips the picker entirely (choosePromptMode, tasksView.ts:2359).
  sb = makeSandbox({
    "agentFlow.taskMode": "e2e",
    "agentFlow.promptModes": [{ id: "e2e", label: "E2E mode", prompt: "E2E-MODE-MARKER for {key}" }],
  });
  const { page, card, windows } = await boot(sb);

  await card.locator("button.take").click();
  // No prompt-mode question: the first QuickPick is straight to the repo confirm.
  await confirmRepos(page);
  await settleWindows(windows, 1);
  await shot(windows[0], testInfo, "1 · window opened under the custom mode");

  // What the session is seeded with is the plan file's prompt (`~/.agentflow/plans`,
  // the handshake the target window consumes — workspace.ts:569 `seedPrompt`). The
  // on-disk `.pick-task/TASK.md` brief deliberately does NOT carry the mode's prompt:
  // brief.ts:40 writes "_The Claude Code prompt for this task says whether to plan
  // first or implement._" and leaves the prompt to the seed. So the brief the session
  // reads is the seeded prompt + TASK.md together, and the marker is asserted where the
  // product puts it.
  await expect.poll(() => planFileFor(sb!, FIXTURE_TASK.key), { timeout: 30_000 }).toBeTruthy();
  const plan = JSON.parse(fs.readFileSync(planFileFor(sb, FIXTURE_TASK.key)!, "utf8")) as { matches: { prompt: string }[] };
  expect(plan.matches).toHaveLength(1);
  expect(plan.matches[0].prompt).toContain(`E2E-MODE-MARKER for ${FIXTURE_TASK.key}`);
  // And the built-in it would otherwise have seeded is nowhere in it.
  expect(plan.matches[0].prompt).not.toContain("Begin implementing");
  await expect.poll(() => fs.existsSync(path.join(sb!.repoPath, ".pick-task", "TASK.md")), { timeout: 30_000 }).toBe(true);
});

// ── Worktrees and the brief ───────────────────────────────────────────────────

// Mutation-checked: dropped the ensureGitExcluded call from createWorktrees (src/engine/worktree.ts) — the worktree still appeared but .git/info/exclude never gained the entry.
test('worktree "ask" offers the choice and "always" lands under .claude/worktrees, git-excluded', async ({}, testInfo) => {
  test.setTimeout(240_000);
  // "ask" is the shipped default (config.ts:813); the sandbox pins "never" so every other
  // journey skips this question. `worktree-take.e2e.ts` proves the "always" setting takes
  // the same path with no question — this journey proves the question itself, and that
  // answering it lands in exactly the place "always" does (launch(), tasksView.ts:2209).
  sb = makeSandbox({ "agentFlow.worktree": "ask" });
  const { page, card, windows } = await boot(sb);

  await card.locator("button.take").click();
  await confirmRepos(page);

  const { widget, rows, row } = quickPick(page);
  await expect(widget).toBeVisible({ timeout: 15_000 });
  await expect(widget).toContainText("isolate this task in a worktree?");
  await expect(rows).toHaveCount(2);
  await expect(row("Work in a git worktree")).toHaveCount(1);
  await expect(row("Work in the repo directly")).toHaveCount(1);
  await shot(page, testInfo, "1 · worktree question");
  await row("Work in a git worktree").click();

  const wtPath = path.join(sb.repoPath, ".claude", "worktrees", FIXTURE_TASK.key);
  await expect.poll(() => fs.existsSync(wtPath), { timeout: 60_000 }).toBe(true);
  // Registered with git, not merely a directory that looks like one.
  expect(git(sb.repoPath, ["worktree", "list", "--porcelain"])).toContain(`worktree ${fs.realpathSync(wtPath)}`);
  // The exclude line worktree.ts:13 writes, verbatim, in the main checkout's info/exclude.
  const exclude = fs.readFileSync(path.join(sb.repoPath, ".git", "info", "exclude"), "utf8");
  expect(exclude.split("\n")).toContain(".claude/worktrees/");
  // The brief belongs to the worktree; the checkout stays clean.
  await expect.poll(() => fs.existsSync(path.join(wtPath, ".pick-task", "TASK.md")), { timeout: 30_000 }).toBe(true);
  expect(fs.existsSync(path.join(sb.repoPath, ".pick-task"))).toBe(false);
  await settleWindows(windows, 1);
});

// Mutation-checked: openWorkspace (src/engine/workspace.ts) stopped calling ensureGitExcluded for the brief dir — `git check-ignore .pick-task/TASK.md` exited 1.
test("the brief directory is git-excluded so it can never be committed", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = makeSandbox();
  const { page, card, windows } = await boot(sb);

  await card.locator("button.take").click();
  await confirmRepos(page);
  await settleWindows(windows, 1);

  const brief = path.join(sb.repoPath, ".pick-task", "TASK.md");
  await expect.poll(() => fs.existsSync(brief), { timeout: 30_000 }).toBe(true);
  await shot(windows[0], testInfo, "1 · task window with the brief on disk");

  // git's own verdict, not ours: `check-ignore` exits 0 when the path is ignored by any
  // rule in force (here `.git/info/exclude`, which is local and never committed) and 1
  // when it is not — execFileSync throws on the latter.
  expect(() => execFileSync("git", ["check-ignore", "-q", ".pick-task/TASK.md"], { cwd: sb!.repoPath })).not.toThrow();
  // And it is the exclude file, not `.gitignore` — nothing tracked was touched.
  expect(fs.readFileSync(path.join(sb.repoPath, ".git", "info", "exclude"), "utf8").split("\n")).toContain(".pick-task/");
  expect(fs.existsSync(path.join(sb.repoPath, ".gitignore"))).toBe(false);
  expect(git(sb.repoPath, ["status", "--porcelain"]).trim()).toBe("");
});

// ── Destinations ──────────────────────────────────────────────────────────────

// Mutation-checked: chooseOpenTarget (src/engine/openTarget.ts) built `thisWindow` as [] regardless of `here` — the picker came back with two rows and no "This window".
test('openIn "ask" lists a new window, this window and a saved workspace', async ({}, testInfo) => {
  test.setTimeout(240_000);
  // "ask" is the shipped default (config.ts:783). The host is opened ON the rocket
  // folder: a window with one folder has an identity (presence.ts:56), and only a window
  // that can be named is offered as "This window" (openTarget.ts). The companion journey
  // below boots the usual empty window and proves the row is withheld there.
  sb = makeSandbox({ "agentFlow.openIn": "ask" });
  const { page, card } = await boot(sb, { folder: sb.repoPath });

  await card.locator("button.take").click();
  const { widget, rows, row } = quickPick(page);
  await expect(widget).toBeVisible({ timeout: 15_000 });
  await expect(widget).toContainText("Open the task where?");
  // The three rows chooseOpenTarget always offers a nameable window, in its order; no
  // live-window rows, because no OTHER Agent Flow window is open.
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("New window");
  await expect(rows.nth(1)).toContainText("This window");
  await expect(rows.nth(2)).toContainText("Existing workspace…");
  await expect(row("This window")).toContainText("keeps this window's folders");
  await shot(page, testInfo, "1 · destination picker with all three rows");
  await page.keyboard.press("Escape");
  await expect(widget).toBeHidden({ timeout: 15_000 });
  expect(fs.existsSync(path.join(sb.repoPath, ".pick-task"))).toBe(false);
});

// Mutation-checked: chooseOpenTarget (src/engine/openTarget.ts) returned { kind: "current" } for an unnameable window instead of toasting and falling back — no toast, no second window, no plan file.
test("this-window in a window it cannot name opens a new window instead", async ({}, testInfo) => {
  test.setTimeout(240_000);
  // The usual empty host: no folder, no workspace file, so `currentWindow()` is undefined
  // and the setting cannot be honoured (openTarget.ts: NO_IDENTITY_TOAST, then "new").
  sb = makeSandbox({ "agentFlow.openIn": "this-window" });
  const { page, card, windows } = await boot(sb);

  await card.locator("button.take").click();
  // The toast fires from chooseOpenTarget, BEFORE the repo-confirm QuickPick a new window
  // needs — so it is on screen by the time the picker is.
  await expect(page.locator(".notifications-toasts")).toContainText("can't hold a session — opening a new window instead", { timeout: 15_000 });
  await shot(page, testInfo, "1 · the no-identity toast");
  await confirmRepos(page);

  // A REAL second BrowserWindow — the "new window" the toast promised.
  await settleWindows(windows, 1);
  expect(app!.windows().length).toBeGreaterThanOrEqual(2);
  await shot(windows[0], testInfo, "2 · the new window");
  await expect.poll(() => planFileFor(sb!, FIXTURE_TASK.key), { timeout: 30_000 }).toBeTruthy();
  const plan = JSON.parse(fs.readFileSync(planFileFor(sb, FIXTURE_TASK.key)!, "utf8")) as { matches: { matchPath: string }[] };
  // Seeded by the repo path — a new per-window launch — never by "this window's" identity.
  expect(plan.matches.map((m) => fs.realpathSync(m.matchPath))).toEqual([fs.realpathSync(sb.repoPath)]);
});

// Mutation-checked: planWorkspaceMerge (src/engine/workspace.ts) stopped classifying a same-name folder as a duplicate — the approve prompt offered 2 folders and the file grew a second "rocket".
test("pick-existing adds only approved repos and skips same-name folders", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = makeSandbox({ "agentFlow.openIn": "pick-existing" });
  // Two repos the task's summary names, so the expanded card pre-selects both and Take
  // sends them as `services` (App.tsx:831) — a pick-existing destination otherwise takes
  // its repo set from the workspace file itself (tasksView.ts: servicesFromExistingDestination).
  addRepo(sb, "telemetry");
  // A saved workspace that already has a folder CALLED rocket — at a different path. By
  // name it is a duplicate (planWorkspaceMerge: `names.has`), so the sandbox's rocket is
  // skipped without asking; telemetry is genuinely new and needs approval.
  const otherRocket = path.join(sb.root, "elsewhere", "rocket");
  fs.mkdirSync(otherRocket, { recursive: true });
  const workspaceDir = path.join(sb.root, "workspaces");
  fs.mkdirSync(workspaceDir, { recursive: true });
  const wsFile = path.join(workspaceDir, "team.code-workspace");
  const original = JSON.stringify({ folders: [{ name: "rocket", path: otherRocket }], settings: {} }, null, 2) + "\n";
  fs.writeFileSync(wsFile, original);
  const folders = () => (JSON.parse(fs.readFileSync(wsFile, "utf8")) as { folders: { name: string; path: string }[] }).folders;

  const { page, card, windows } = await boot(sb);
  // Expand the card (`.card-main`, App.tsx:872) so the take carries the chip selection.
  await card.locator(".card-main").click();
  await expect(card.locator(".chip", { hasText: "telemetry" })).toBeVisible({ timeout: 15_000 });
  await expect(card.locator(".chip", { hasText: "rocket" })).toBeVisible();
  await shot(page, testInfo, "1 · both repos selected on the card");

  const { widget, row } = quickPick(page);
  const toasts = page.locator(".notifications-toasts");

  // Round 1 — decline. The file must come back byte-identical.
  await card.locator("button.take").click();
  await expect(widget).toBeVisible({ timeout: 15_000 });
  await expect(widget).toContainText("Open into which workspace?");
  await expect(row("team.code-workspace")).toContainText("1 folder");
  await expect(row("Browse…")).toHaveCount(1);
  await row("team.code-workspace").click();
  await expect(widget).toContainText("Add telemetry to team.code-workspace?", { timeout: 15_000 });
  await shot(page, testInfo, "2 · approval prompt names only the new repo");
  await row("Leave the workspace as-is").click();
  await expect(toasts).toContainText("Left team.code-workspace unchanged", { timeout: 30_000 });
  expect(fs.readFileSync(wsFile, "utf8")).toBe(original);
  // The briefs were still seeded — declining changes the file, not the take.
  await expect.poll(() => fs.existsSync(path.join(sb!.reposRoot, "telemetry", ".pick-task", "TASK.md")), { timeout: 30_000 }).toBe(true);
  await settleWindows(windows, 1);

  // Round 2 — approve. telemetry is added; the same-name rocket is skipped and named.
  await card.locator("button.take").click();
  await expect(widget).toBeVisible({ timeout: 15_000 });
  await row("team.code-workspace").click();
  await expect(widget).toContainText("Add telemetry to team.code-workspace?", { timeout: 15_000 });
  await row("Add telemetry").click();
  await expect(toasts).toContainText("Added telemetry.", { timeout: 30_000 });
  await expect(toasts).toContainText("rocket already in the workspace — not added as folders");
  await shot(page, testInfo, "3 · toast: added telemetry, skipped rocket");
  await expect.poll(() => folders().length, { timeout: 30_000 }).toBe(2);
  const after = folders();
  expect(after.filter((f) => f.name === "rocket")).toHaveLength(1);
  expect(after[0]).toEqual({ name: "rocket", path: otherRocket }); // the existing folder, untouched
  expect(after[1].name).toBe("telemetry");
  expect(fs.realpathSync(after[1].path)).toBe(fs.realpathSync(path.join(sb.reposRoot, "telemetry")));
  // The rest of the file — settings, formatting — is preserved by the jsonc edit.
  expect(fs.readFileSync(wsFile, "utf8")).toContain('"settings": {}');
  // Opening the same workspace twice may focus the first window rather than open another.
  await settleWindows(windows, 1);
});

// Mutation-checked: openWorkspace's multiroot branch (src/engine/workspace.ts) wrote `services.slice(0, 1)` as folders — the file existed with one folder.
test("multiroot mode writes <KEY>.code-workspace into workspaceDir", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = makeSandbox({ "agentFlow.workspaceMode": "multiroot" });
  addRepo(sb, "telemetry");
  const { page, card, windows } = await boot(sb);

  await card.locator("button.take").click();
  // Both repos arrive pre-checked: neither is a ticket component, so `confirmedServices`
  // (infer.ts:64) falls back to every text match. Enter confirms both.
  const { widget } = quickPick(page);
  await expect(widget).toBeVisible({ timeout: 15_000 });
  await expect(widget).toContainText("rocket");
  await expect(widget).toContainText("telemetry");
  await shot(page, testInfo, "1 · both repos confirmed");
  await page.keyboard.press("Enter");

  // `agentFlow.workspaceDir` is the sandbox's `<root>/workspaces` (sandbox.ts); the file
  // is `<KEY>.code-workspace` (workspace.ts:554) and declares one folder per repo.
  const wsFile = path.join(sb.root, "workspaces", `${FIXTURE_TASK.key}.code-workspace`);
  await expect.poll(() => fs.existsSync(wsFile), { timeout: 60_000 }).toBe(true);
  const doc = JSON.parse(fs.readFileSync(wsFile, "utf8")) as { folders: { name: string; path: string }[] };
  expect(doc.folders.map((f) => f.name).sort()).toEqual(["rocket", "telemetry"]);
  expect(doc.folders.map((f) => fs.realpathSync(f.path)).sort()).toEqual(
    [sb.repoPath, path.join(sb.reposRoot, "telemetry")].map((p) => fs.realpathSync(p)).sort(),
  );
  // One window for the whole workspace, and the plan targets the workspace FILE.
  await settleWindows(windows, 1);
  await shot(windows[0], testInfo, "2 · multi-root window");
  await expect.poll(() => planFileFor(sb!, FIXTURE_TASK.key), { timeout: 30_000 }).toBeTruthy();
  const plan = JSON.parse(fs.readFileSync(planFileFor(sb, FIXTURE_TASK.key)!, "utf8")) as { matches: { matchPath: string }[] };
  expect(plan.matches.map((m) => m.matchPath)).toEqual([wsFile]);
});
