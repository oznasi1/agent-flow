import { test, expect } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { makeSandbox, FIXTURE_TASK, type Sandbox } from "./_helpers/sandbox";
import { launchHost, openTasksView, tasksFrame } from "./_helpers/host";
import { shot } from "./_helpers/shot";

/** SETTINGS § Remote Control, on a real host. Each test boots its own Electron: every
 *  journey here either opens windows or must prove that none opened, so nothing can be
 *  shared with a sibling. The settings differ per test, so the sandbox is made in the
 *  test body rather than a `beforeEach`. */
let sb: Sandbox | undefined;
let app: ElectronApplication | undefined;
test.afterEach(async () => {
  try {
    await app?.close();
  } finally {
    app = undefined;
    sb?.dispose();
    sb = undefined;
  }
});

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" });

/** A second git repo under the sandbox's reposRoot. `inferServices` (src/engine/infer.ts)
 *  matches whole-word repo names in the task text, and FIXTURE_TASK's summary is "Fix
 *  the rocket telemetry panel" — so a repo named `telemetry` is inferred onto E2E-1
 *  beside `rocket`, and the repo-confirm QuickPick opens with BOTH pre-checked. Same
 *  recipe as sidebar-actions.e2e.ts's `beforeAll`. */
function addRepo(sandbox: Sandbox, name: string): string {
  const repo = path.join(sandbox.reposRoot, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  fs.writeFileSync(path.join(repo, "README.md"), `# ${name}\n`);
  git(repo, ["add", "."]);
  git(repo, ["-c", "user.email=e2e@fixture.invalid", "-c", "user.name=E2E", "commit", "-qm", "init"]);
  return repo;
}

/** Everything an integrated terminal currently shows: xterm.js renders its buffer into
 *  `.terminal .xterm-rows` (same read as seed-terminal.e2e.ts's `terminalText`). */
async function terminalText(win: Page): Promise<string> {
  const rows = win.locator(".terminal .xterm-rows").last();
  return (await rows.count()) ? await rows.innerText() : "";
}

/** The plan files the take wrote into the SANDBOX home (never the developer's). */
function planFiles(sandbox: Sandbox): string[] {
  const dir = path.join(sandbox.home, ".agentflow", "plans");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith(`${FIXTURE_TASK.key}-`)) : [];
}

/** Open the sidebar and click Take on E2E-1. Returns the card's frame. */
async function takeFixtureTask(page: Page) {
  await openTasksView(page);
  const frame = tasksFrame(page);
  const card = frame.locator(".card", { hasText: FIXTURE_TASK.key });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.locator("button.take").click();
  return frame;
}

// Mutation-checked: `remoteControlBlocksLaunch` made to return false unconditionally
// (tasksView.ts) — the take ran on to the repo-confirm picker and the refusal toast
// never came; the backstop in `resolveRemoteControl` would only have fired after the
// worktree existed, which is exactly what this test's title forbids.
test("Copilot with Remote Control on refuses the launch before any worktree exists", async ({}, testInfo) => {
  test.setTimeout(240_000);
  // `worktree: "always"` is the point: with the refusal in place, the launch must end
  // before `createWorktrees` — a worktree appearing is the doc's claim being broken.
  sb = makeSandbox({
    "agentFlow.agentProvider": "copilot",
    "agentFlow.remoteControl": "on",
    "agentFlow.worktree": "always",
  });
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;

  const worktreesBefore = git(sb.repoPath, ["worktree", "list", "--porcelain"]);
  const frame = await takeFixtureTask(page);

  // The refusal is the webview's own toast (`tasksView.toast("error", …)` posts
  // `{type:"toast"}`, rendered by App.tsx's ToastStack as `.toast.toast--error` on
  // 2026-09-03), not a workbench notification. Errors stay until dismissed.
  await expect(frame.locator(".toast--error")).toContainText("Remote Control needs Claude Code", { timeout: 30_000 });
  await shot(page, testInfo, "1 · refused with an error toast");

  // The assertion of record is what did NOT happen. The refusal is synchronous and
  // ahead of every picker, so no QuickPick may have opened either.
  await expect(page.locator(".quick-input-widget")).toBeHidden();
  expect(git(sb.repoPath, ["worktree", "list", "--porcelain"])).toBe(worktreesBefore);
  expect(fs.existsSync(path.join(sb.repoPath, ".claude", "worktrees"))).toBe(false);
  expect(planFiles(sb)).toEqual([]);
  expect(app.windows().length).toBe(1);
});

// Mutation-checked: the single-window guard in `openWorkspace` (workspace.ts,
// `matches.length === 1`) loosened to `>= 1` — the plan file carried
// `remoteControl: true`, the toast lost its "skipped" note and both terminals were
// seeded with `/remote-control`.
test("Remote Control is skipped for a multi-repo per-window take and the toast says so", async ({}, testInfo) => {
  test.setTimeout(240_000);
  // Two repos, one window each: `workspaceMode: "per-window"` answers the layout
  // question without a picker (tasksView.ts `chooseWorkspaceMode`), and two windows is
  // the shape SETTINGS.md says keeps the normal seeding — one clipboard cannot carry a
  // different prompt for each.
  sb = makeSandbox({
    "agentFlow.remoteControl": "on",
    "agentFlow.agentSurface": "terminal",
    "agentFlow.workspaceMode": "per-window",
  });
  const telemetryPath = addRepo(sb, "telemetry");
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;

  const frame = await takeFixtureTask(page);

  // Both repos arrive pre-checked (inferred from the summary), so Enter confirms both.
  const quickInput = page.locator(".quick-input-widget");
  await expect(quickInput).toBeVisible({ timeout: 15_000 });
  await expect(quickInput).toContainText("rocket");
  await expect(quickInput).toContainText("telemetry");
  await shot(page, testInfo, "1 · two repos confirmed");
  await page.keyboard.press("Enter");

  // The toast is posted once `openWorkspace` returns, and a success toast dismisses
  // itself after 4.2s (App.tsx) — so it is asserted FIRST, before any wait on the new
  // windows. The copy is `remoteControlNote`'s single-window sentence (tasksView.ts).
  const toast = frame.locator(".toast", { hasText: "Remote Control skipped" });
  await expect(toast).toContainText("Remote Control skipped — it needs a single window.", { timeout: 90_000 });
  await shot(page, testInfo, "2 · toast says Remote Control was skipped");

  // The durable record: one plan file, two matches, Remote Control withheld.
  await expect.poll(() => planFiles(sb!).length, { timeout: 30_000 }).toBe(1);
  const plan = JSON.parse(fs.readFileSync(path.join(sb.home, ".agentflow", "plans", planFiles(sb)[0]), "utf8"));
  expect(plan).toMatchObject({ key: FIXTURE_TASK.key, seedAgent: true, remoteControl: false });
  expect(plan.matches).toHaveLength(2);

  // Two REAL windows (plus the original), one per repo.
  await expect.poll(() => app!.windows().length, { timeout: 90_000 }).toBeGreaterThanOrEqual(3);
  const opened = app.windows().filter((w) => w !== page);
  expect(opened.length).toBe(2);

  // Each window's terminal ran the `claude` shim and got the ordinary prompt — the
  // task text, not the slash command.
  for (const win of opened) {
    await win.locator(".activitybar").waitFor({ timeout: 60_000 });
    await expect.poll(() => terminalText(win), { timeout: 60_000 }).toContain("CLAUDE-SHIM-READY");
    await expect.poll(() => terminalText(win), { timeout: 30_000 }).toContain(`Jira ${FIXTURE_TASK.key}`);
    expect(await terminalText(win)).not.toContain("/remote-control");
  }
  await shot(opened[0], testInfo, "3 · ordinary prompt seeded, no /remote-control");

  // And both repos really were opened — the briefs landed in each.
  expect(fs.existsSync(path.join(sb.repoPath, ".pick-task", "TASK.md"))).toBe(true);
  expect(fs.existsSync(path.join(telemetryPath, ".pick-task", "TASK.md"))).toBe(true);
});

// Mutation-checked: `seedText` in `seedAgentSession` (workspace.ts) pinned to `prompt`
// regardless of `remoteControl` — the terminal got the task prompt instead of the
// slash command.
test("Remote Control pre-fills the slash command and puts the prompt on the clipboard", async ({}, testInfo) => {
  // The renderer denies navigator.clipboard.readText (no user activation), and under
  // xvfb on Linux CI there is no dependable system-clipboard reader. `pbpaste` is the
  // one honest read, so this journey runs on macOS only.
  test.skip(process.platform !== "darwin", "the system clipboard is read with pbpaste, which only macOS has");
  test.setTimeout(240_000);
  sb = makeSandbox({
    "agentFlow.remoteControl": "on",
    "agentFlow.agentSurface": "terminal",
  });
  // A sentinel on the clipboard first, so a stale prompt from an earlier run can never
  // satisfy the assertion below.
  execFileSync("pbcopy", { input: "E2E-CLIPBOARD-SENTINEL" });

  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;

  await takeFixtureTask(page);
  const quickInput = page.locator(".quick-input-widget");
  await expect(quickInput).toBeVisible({ timeout: 15_000 });
  await expect(quickInput).toContainText("rocket");
  const newWindow = app.waitForEvent("window", { timeout: 60_000 });
  await page.keyboard.press("Enter");

  const opened = await newWindow;
  await opened.locator(".activitybar").waitFor({ timeout: 60_000 });

  // The plan file carries the decision the opened window seeds from.
  await expect.poll(() => planFiles(sb!).length, { timeout: 30_000 }).toBe(1);
  const plan = JSON.parse(fs.readFileSync(path.join(sb.home, ".agentflow", "plans", planFiles(sb)[0]), "utf8"));
  expect(plan).toMatchObject({ key: FIXTURE_TASK.key, remoteControl: true });

  // The terminal got the slash command, unsubmitted, and NOT the task prompt: the
  // prompt travels on the clipboard because Claude Code cannot take a slash command
  // and a prompt in one submission.
  await expect.poll(() => terminalText(opened), { timeout: 60_000 }).toContain("CLAUDE-SHIM-READY");
  await expect.poll(() => terminalText(opened), { timeout: 30_000 }).toContain(`/remote-control ${FIXTURE_TASK.key}`);
  expect(await terminalText(opened)).not.toContain(`Jira ${FIXTURE_TASK.key}`);

  // The two-step instruction lands in the OPENED window (`announceRemoteControl`,
  // workspace.ts) — a real workbench notification this time.
  await expect(opened.locator(".notification-list-item-message", { hasText: "connect Remote Control" }))
    .toBeVisible({ timeout: 30_000 });
  await shot(opened, testInfo, "1 · /remote-control seeded, prompt on the clipboard");

  // And the system clipboard genuinely carries the task prompt now.
  const clip = execFileSync("pbpaste", [], { encoding: "utf8" });
  expect(clip).not.toContain("E2E-CLIPBOARD-SENTINEL");
  expect(clip).toContain(`Jira ${FIXTURE_TASK.key}`);
});
