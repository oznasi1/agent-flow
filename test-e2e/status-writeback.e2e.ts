import { test, expect } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { makeSandbox, FIXTURE_TASK, type Sandbox } from "./_helpers/sandbox";
import { launchHost, openTasksView, tasksFrame } from "./_helpers/host";

let sb: Sandbox;
let app: ElectronApplication | undefined;

test.beforeEach(() => { sb = makeSandbox(); });
test.afterEach(async () => { await app?.close(); app = undefined; sb.dispose(); });

/** Journey 3: a status change from a card reaches the task source, and the
 *  provenance label rides with it. The fixture records both writes to
 *  writes.jsonl — the request-recorder that replaced the fake Jira. */
test("changing a card's status records the transition and the claude-code provenance label", async () => {
  test.setTimeout(180_000);
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;

  await openTasksView(page);
  const frame = tasksFrame(page);
  const card = frame.locator(".card", { hasText: FIXTURE_TASK.key });
  await expect(card).toBeVisible({ timeout: 30_000 });

  // The card's status button opens the host's transition QuickPick, listing the
  // fixture's statusTargets (In Progress / Done).
  await card.locator("button.status").click();
  const quickInput = page.locator(".quick-input-widget");
  await expect(quickInput).toBeVisible({ timeout: 15_000 });
  await expect(quickInput).toContainText("Done");
  await page.screenshot({ path: "test-results/e2e-status-1-targets.png" });

  // Filter to the one target and confirm. The fixture's "Done" target carries
  // no field prompts, so the move fires immediately.
  await page.keyboard.type("Done");
  await page.keyboard.press("Enter");

  // A done-category move removes the card from the pool — DOM proof the
  // statusChanged message round-tripped back into the webview.
  await expect(card).toHaveCount(0, { timeout: 30_000 });
  await page.screenshot({ path: "test-results/e2e-status-2-card-gone.png" });

  // The writes, in order: the transition, then the provenance stamp — with the
  // shipped defaults (stampLabelOnWrite: true, provenanceLabel: "claude-code").
  const writesPath = path.join(sb.fixtureDir, "writes.jsonl");
  await expect.poll(() => {
    if (!fs.existsSync(writesPath)) return 0;
    return fs.readFileSync(writesPath, "utf8").trim().split("\n").length;
  }, { timeout: 30_000 }).toBe(2);
  const writes = fs.readFileSync(writesPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(writes[0]).toMatchObject({ op: "moveTo", key: FIXTURE_TASK.key, targetId: "done" });
  expect(writes[1]).toMatchObject({ op: "addLabel", key: FIXTURE_TASK.key, label: "claude-code" });
});
