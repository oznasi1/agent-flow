import { expect, test, type ElectronApplication, type TestInfo } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { FIXTURE_TASK, makeSandbox, type Sandbox } from "./_helpers/sandbox";
import { launchHost, openTasksView, tasksFrame } from "./_helpers/host";
import { Deck } from "./_helpers/po/deck";
import { expectNoUnknownForgeCalls, ghReviewRequestsAnswer, installForgeShims } from "./_helpers/forgeShim";
import { shot } from "./_helpers/shot";

// What `agentFlow.agentProvider` puts in front of the user, as opposed to which
// binary it starts (cursor-host.e2e.ts, codex-provider.e2e.ts and
// copilot-panel.e2e.ts own that). Two documented claims live here:
//
//  1. the Deck's review button NAMES the configured tool, which means the label
//     has to follow `readAgentProviderSetting` — including its host gates, so
//     `cursor` only reads "Cursor" on a cursor-scheme host; and
//  2. under `ask`, a single take's brief is written BEFORE the picker runs and
//     therefore names Claude Code whichever tool the user then picks. That is
//     the doc's own statement of a gap (docs/SETTINGS.md, `agentFlow.agentProvider`),
//     not a defect this file discovered, so it is asserted positively rather
//     than pinned with `test.fail()`.
//
// Per-test hosts, not `describeWithHost`: the first test boots three of them
// (two schemes, three settings) and the second one takes a task, which opens a
// window and writes a run record.

let app: ElectronApplication | undefined;
let sb: Sandbox | undefined;

/** Safety net only — the ★ test tears each of its three hosts down as it goes,
 *  so that a boot failure on host 2 cannot leave host 1 running. */
test.afterEach(async () => {
  await app?.close();
  app = undefined;
  if (sb) {
    try {
      expectNoUnknownForgeCalls(sb);
    } finally {
      sb.dispose();
      sb = undefined;
    }
  }
});

/** Two review requests, so the strip has a row to expand. Same shape as
 *  `review-launch.e2e.ts`'s — nothing here launches one. */
const REQS = [
  { number: 41, repo: "oznasi1/rocket", title: "Fix the rocket telemetry panel", author: "octo", branch: "fix/telemetry" },
  { number: 42, repo: "oznasi1/rocket", title: "Refit the rocket landing gear", author: "octo", branch: "fix/gear" },
];

/** Boot a host under one `agentProvider` setting and read the review row's own
 *  launch-button label off it, then tear the host down again. The label is
 *  `▶ Review with {agentLabel}` (ReviewStrip.tsx:236), and `agentLabel` reaches
 *  the webview from `deckView.ts:3915` as
 *  `providerLabel(resolvedProvider(getConfig().agentProvider))` — so this reads
 *  the whole resolution chain, host gate included, and not a string in a
 *  component. */
async function reviewButtonLabel(
  provider: string,
  host: "vscode" | "cursor",
  testInfo: TestInfo,
  step: number,
): Promise<string> {
  sb = makeSandbox({
    "agentFlow.forge": "github",
    "agentFlow.reviewRequests": true,
    "agentFlow.agentProvider": provider,
  });
  installForgeShims(sb, {
    gh: {
      "api graphql": ghReviewRequestsAnswer(REQS),
      // The strip's own reads along the way: auth for the account footer, and
      // `pr view … --json statusCheckRollup` for an expanded row's checks line.
      // An empty rollup reads as "no checks", which `mapRollup` renders as green.
      "auth status": "{}",
      "pr view": JSON.stringify({ statusCheckRollup: [] }),
    },
  });
  const launched = await launchHost(sb, { host });
  app = launched.app;
  const deck = await Deck.open(launched.page);

  await expect(deck.review(41)).toBeVisible({ timeout: 60_000 });
  // The whole `.rv-actions` block is gated on `expanded` (ReviewStrip.tsx:181),
  // so a collapsed row carries no labelled button at all.
  await deck.expandReview(41);
  const label = (await deck.reviewLaunch(41).innerText()).trim();
  await shot(launched.page, testInfo, `${step} · ${provider} on the ${host} host`);

  await app.close();
  app = undefined;
  expectNoUnknownForgeCalls(sb);
  sb.dispose();
  sb = undefined;
  return label;
}

// Mutation-checked: hardcoded the label (ReviewStrip.tsx `Review with {agentLabel}`
// → `Review with Claude Code`) — the copilot and cursor cases then read the
// wrong tool.
test("the review button names the configured tool", async ({}, testInfo) => {
  test.setTimeout(600_000);

  const claude = await reviewButtonLabel("claude-code", "vscode", testInfo, 1);
  expect(claude).toContain("Review with Claude Code");
  expect(claude).not.toContain("Copilot");
  expect(claude).not.toContain("Cursor");

  const copilot = await reviewButtonLabel("copilot", "vscode", testInfo, 2);
  expect(copilot).toContain("Review with Copilot");
  expect(copilot).not.toContain("Claude Code");

  // `cursor` only survives `readAgentProviderSetting` on a cursor-scheme host
  // (config.ts:209) — on a stock VS Code host the very same setting degrades to
  // Claude Code, which `cursor-provider.e2e.ts` pins. So the third case needs
  // the patched host, and the label is what says the gate is wired into the
  // Deck's copy and not only into the seed.
  const cursor = await reviewButtonLabel("cursor", "cursor", testInfo, 3);
  expect(cursor).toContain("Review with Cursor");
  expect(cursor).not.toContain("Claude Code");
});

// Mutation-checked: made the brief follow the picked tool
// (tasksView.ts `providerLabel(resolvedProvider(cfg.agentProvider))` →
// `providerLabel("copilot")` at the `briefMarkdown` call) — the brief then names
// Copilot and the documented gap assertion fails.
test("a single take under ask names Claude Code in the brief even when Copilot was picked", async ({}, testInfo) => {
  test.setTimeout(300_000);
  sb = makeSandbox({ "agentFlow.agentProvider": "ask" });
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;

  await openTasksView(page);
  const frame = tasksFrame(page);
  const card = frame.locator(".card", { hasText: FIXTURE_TASK.key });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.locator("button.take").click();

  // Picker 1: the repo confirm, pre-checked because the fixture summary carries
  // the repo name — one Enter, exactly as every other take journey does.
  const quickInput = page.locator(".quick-input-widget");
  await expect(quickInput).toBeVisible({ timeout: 15_000 });
  await expect(quickInput).toContainText("rocket");
  const newWindow = app.waitForEvent("window", { timeout: 120_000 });
  await page.keyboard.press("Enter");

  // Picker 2: `ask`'s own "Which tool?" (engine/workspace.ts:413), raised inside
  // `openWorkspace` — i.e. AFTER `briefMarkdown` has already been rendered by
  // the caller (tasksView.ts:2275-2277). Clicking the row rather than typing:
  // the filter box has focus on open and "Copilot" would also prefix-match
  // nothing else here, but a click is independent of the filter entirely.
  await expect(quickInput).toContainText("Which tool?", { timeout: 30_000 });
  await page.locator(".quick-input-list .quick-input-list-entry", { hasText: "Copilot" }).click();
  await shot(page, testInfo, "4 · Copilot picked for this launch");

  // Copilot really is the provider this launch resolved to: with no Copilot
  // Chat extension installed the seed lands on the documented clipboard
  // fallback, and that notification NAMES the provider
  // (engine/workspace.ts:1227). Without this the brief assertion below would
  // hold just as well against a picker whose answer went nowhere.
  const opened = await newWindow;
  await opened.locator(".activitybar").waitFor({ timeout: 120_000 });
  await expect(opened.locator(".notification-list-item-message", { hasText: "Copilot prompt copied" }))
    .toBeVisible({ timeout: 120_000 });
  await shot(opened, testInfo, "5 · Copilot named in the seed's fallback");

  // …and yet the brief, written before that picker ran, names Claude Code. The
  // sentence is `briefMarkdown`'s own (engine/brief.ts:40), so this is the
  // agentName argument and not incidental prose.
  const brief = path.join(sb.repoPath, ".pick-task", "TASK.md");
  await expect.poll(() => fs.existsSync(brief), { timeout: 60_000 }).toBe(true);
  const text = fs.readFileSync(brief, "utf8");
  expect(text).toContain("The Claude Code prompt for this task");
  expect(text).not.toContain("The Copilot prompt for this task");
});
