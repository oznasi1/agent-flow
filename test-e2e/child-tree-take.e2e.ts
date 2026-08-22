import { expect, test, type ElectronApplication } from "@playwright/test";
import { execFileSync } from "child_process";
import { makeSandbox, FIXTURE_TASK, FIXTURE_CHILD, type Sandbox } from "./_helpers/sandbox";
import { launchHost } from "./_helpers/host";
import { Pool } from "./_helpers/po/pool";
import { shot } from "./_helpers/shot";

let sb: Sandbox;
let app: ElectronApplication | undefined;

// `childWorktrees: true` is the ONLY reason this journey can see a tree at
// all — the shared sandbox default is `false` (see sandbox.ts), on purpose,
// because turning it on globally offers a tree picker for every take of
// E2E-1 and breaks the other journeys. This override is load-bearing.
test.beforeEach(() => { sb = makeSandbox({ "agentFlow.childWorktrees": true, "agentFlow.worktree": "always" }); });
test.afterEach(async () => { await app?.close(); app = undefined; sb.dispose(); });

test("taking a parent offers its tree and creates a worktree for the child", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const launched = await launchHost(sb);
  app = launched.app;
  const pool = await Pool.open(launched.page, 2); // the child is NOT a pool card

  await pool.card(FIXTURE_TASK.key).getByRole("button", { name: /take/i }).click();

  // probeTree (src/tasksView.ts) runs under a cancellable notification while it
  // walks the fixture's `children` capability, then — because it found a leaf —
  // offers a QuickPick of HOW to work the tree (chooseTreeMode), not a QuickPick
  // of the children themselves. Its title names the leaf count; "A session per
  // child" (fan-out) is the first, default-highlighted item, so a bare Enter
  // picks it.
  const quickInput = launched.page.locator(".quick-input-widget");
  await expect(quickInput).toBeVisible({ timeout: 120_000 });
  await expect(quickInput).toContainText("leaf under it", { timeout: 120_000 });
  await expect(quickInput).toContainText("A session per child");
  await launched.page.keyboard.press("Enter");

  // THIS is the picker that actually lists the children — chooseLeaves, a
  // canPickMany QuickPick of `${key} — ${summary}` rows, nothing pre-checked.
  // Accepting it means checking the row's checkbox before Enter: a bare Enter
  // over an empty selection is "none of them", which falls through to an
  // ordinary parent-only take and never creates the child's worktree.
  await expect(quickInput).toContainText(FIXTURE_CHILD.summary, { timeout: 30_000 });
  await shot(launched.page, testInfo, "1 · tree offered");
  await quickInput.getByRole("checkbox").first().click();
  await launched.page.keyboard.press("Enter");

  await expect
    .poll(() => execFileSync("git", ["worktree", "list"], { cwd: sb.repoPath, encoding: "utf8" }), { timeout: 180_000 })
    .toContain(FIXTURE_CHILD.key);
  await shot(launched.page, testInfo, "2 · child worktree created");
});
