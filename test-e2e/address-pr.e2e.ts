import { test, expect } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { makeSandbox, FIXTURE_TASK, type Sandbox } from "./_helpers/sandbox";
import { launchHost } from "./_helpers/host";
import { Pool } from "./_helpers/po/pool";
import { shot } from "./_helpers/shot";

let sb: Sandbox;
let app: ElectronApplication | undefined;

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" });

// `prReviewStatus` must match the fixture task's own status ("To Do") for the
// "Address PR" card action to render at all — isPrReviewStatus (webview/helpers.ts)
// gates it on task.status === cfg.prReviewStatus, and the shipped default
// ("PR initiated") never matches the fixture. `worktree: "never"` (rather than
// "always") is deliberate too: addressPr() in tasksView.ts always forces a
// worktree regardless of agentFlow.worktree (`launch(..., forceWorktree=true, ...)`),
// so pinning the general setting to its OPPOSITE is what makes the worktree
// assertion below prove that override rather than merely agree with the setting.
test.beforeEach(() => {
  sb = makeSandbox({ "agentFlow.worktree": "never", "agentFlow.prReviewStatus": FIXTURE_TASK.status });
});
test.afterEach(async () => {
  await app?.close();
  app = undefined;
  sb.dispose();
});

test("Address PR seeds the PR-review prompt in a forced worktree", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;

  const pool = await Pool.open(page, 2);
  const card = pool.card(FIXTURE_TASK.key);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await shot(page, testInfo, "1 · pool loaded");

  // The affordance is a plain, unlabeled button (App.tsx) whose accessible name
  // comes from its text node — the icon beside it is aria-hidden. `.address-pr`
  // is the class the component renders it under, the same style every sibling
  // journey uses for the card actions (`button.take`, `button.sprint-add`, …).
  await card.locator("button.address-pr").click();

  // The repo-confirm QuickPick — real workbench DOM, same as an ordinary Take.
  // "rocket" arrives pre-checked because the task summary names it.
  const quickInput = page.locator(".quick-input-widget");
  await expect(quickInput).toBeVisible({ timeout: 15_000 });
  await expect(quickInput).toContainText("rocket");
  await shot(page, testInfo, "2 · repos confirmed");
  const newWindow = app.waitForEvent("window", { timeout: 60_000 });
  await page.keyboard.press("Enter");

  // A real second window, exactly like an ordinary Take.
  const opened = await newWindow;
  await opened.locator(".activitybar").waitFor({ timeout: 60_000 });
  await shot(opened, testInfo, "3 · window opened");

  // Address PR isolates in a git worktree unconditionally — createWorktrees ran
  // even though agentFlow.worktree is "never" here. The branch is the same
  // <key>-<slug> convention an ordinary worktree Take gets (engine/worktree.ts's
  // branchName), which is also the branch a real PR's headRefName would carry
  // once the agent runs `gh pr checkout` against it.
  const wtPath = path.join(sb.repoPath, ".claude", "worktrees", FIXTURE_TASK.key);
  await expect.poll(() => fs.existsSync(wtPath), { timeout: 30_000 }).toBe(true);
  expect(git(sb.repoPath, ["worktree", "list", "--porcelain"])).toContain(`worktree ${fs.realpathSync(wtPath)}`);
  const branch = git(wtPath, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  expect(branch).toBe("E2E-1-fix-the-rocket-telemetry-panel");

  // The seed handshake carries the PR-review prompt (DEFAULT_PR_REVIEW_PROMPT),
  // not the ordinary Take prompt: it names the ticket and instructs the agent to
  // find and check out the PR itself — Address PR never looks up the PR's own
  // number at seed time (no `gh` call happens here at all; that is left entirely
  // to the agent once it starts), so there is no PR number to assert on, only
  // the substituted ticket fields and the checkout instruction.
  const planDir = path.join(sb.home, ".agentflow", "plans");
  await expect.poll(() => (fs.existsSync(planDir) ? fs.readdirSync(planDir) : []), { timeout: 30_000 })
    .not.toHaveLength(0);
  const planFile = fs.readdirSync(planDir).find((f) => f.startsWith(`${FIXTURE_TASK.key}-`));
  expect(planFile).toBeDefined();
  const plan = JSON.parse(fs.readFileSync(path.join(planDir, planFile!), "utf8"));
  expect(plan).toMatchObject({ key: FIXTURE_TASK.key, seedAgent: true });
  const seeded = (plan.matches as { prompt: string }[]).map((m) => m.prompt).join("\n");
  expect(seeded).toContain(FIXTURE_TASK.key);
  expect(seeded).toContain(FIXTURE_TASK.summary);
  expect(seeded).toContain("gh pr checkout");
  await shot(opened, testInfo, "4 · seeded");

  // And nothing leaked into the real home.
  expect(fs.existsSync(path.join(process.env.HOME ?? "", ".agentflow", "plans", planFile!))).toBe(false);
});
