import { expect, test, type ElectronApplication } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { makeSandbox, type Sandbox } from "./_helpers/sandbox";
import { launchHost } from "./_helpers/host";
import { Deck } from "./_helpers/po/deck";
import { shot } from "./_helpers/shot";

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

/** A tracked task run against a key the fixture connector has never heard of.
 *  `find()` in src/tasks/fixture/connector.ts throws for any key not in
 *  tasks.json; deckView's `ticketStatus` catches that, logs it, and returns
 *  `null`. So every run this file seeds has `ticketCategory: null` forever,
 *  which means `landed()` (src/engine/visibility.ts) is always false for it —
 *  rule 2 ("finished", gated by `retireFinishedAfterHours`, keyed off
 *  `finishedAt`) can never fire, and a seeded `finishedAt` gets stamped straight
 *  back off (`unstamp`) on the very first sweep instead of ever aging out. The
 *  knob this journey actually turns — `agentFlow.retireClosedAfterHours` — is
 *  rule 2b ("closed"), keyed off `closedAt`. Seed that field, not `finishedAt`,
 *  for a run meant to already be past its window.
 *
 *  Default `createdAt` is 72h ago: too old for `JUST_LAUNCHED_MS` (10 min) to
 *  keep the run on the live shelf, so a plain `baseRun` reads as `shelf:
 *  "closed"` (no live session, no PR, nothing to lose, not just launched) and
 *  collapses into the Recently-closed strip's one-line rows instead of
 *  rendering as a `.card` (DeckApp.tsx: "a closed run is not a card").
 *  Override `createdAt: Date.now()` for any run this journey needs to appear
 *  — and stay — on the board as a clickable card. */
function baseRun(sb: Sandbox, key: string, extra: Record<string, unknown> = {}) {
  return {
    key, summary: `Run ${key}`, url: `https://fixture.invalid/browse/${key}`,
    createdAt: Date.now() - 72 * HOUR, kind: "task", mode: "per-window",
    repos: [{ name: "rocket", path: sb.repoPath, isGit: true, branch: "main" }],
    briefPaths: [], ...extra,
  };
}

test.beforeEach(() => {
  sb = makeSandbox({
    "agentFlow.retireClosedAfterHours": 1,
    // Clear stale's confirmation is a modal `showWarningMessage` — "custom"
    // renders it as workbench DOM (`.monaco-dialog-box`) instead of a native
    // OS sheet, which Playwright's Electron driver has no way to click.
    "window.dialogStyle": "custom",
  });
});
test.afterEach(async () => { await app?.close(); app = undefined; sb.dispose(); });

test("a run past its retire window is swept off the board and out of the store", async ({}, testInfo) => {
  test.setTimeout(240_000);
  // closedAt, not finishedAt (see baseRun's doc comment) — 48h stale is well
  // past retireClosedAfterHours: 1, so the very first sweep (fired by
  // deck:ready, before any 6s timer tick) must retire it outright: shelf is
  // already "closed" and the window is already blown.
  const doomed = seedRun(sb, baseRun(sb, "E2E-OLD", { closedAt: Date.now() - 48 * HOUR }));
  // A recent createdAt is justLaunched, which pins this to the live shelf for
  // the life of the test — it renders as a `.card` and has no closed-window to
  // ever blow, unlike the doomed run above.
  const kept = seedRun(sb, baseRun(sb, "E2E-NEW", { createdAt: Date.now() }));

  const launched = await launchHost(sb);
  app = launched.app;
  const deck = await Deck.open(launched.page);
  await shot(launched.page, testInfo, "1 · board on open");

  // The board evaluates on a timer, so poll the STORE — the durable record is
  // the contract; the card leaving is the consequence.
  await expect.poll(() => fs.existsSync(doomed), { timeout: 120_000 }).toBe(false);
  expect(fs.existsSync(kept)).toBe(true);
  await expect(deck.card("E2E-OLD")).toHaveCount(0);
  await expect(deck.card("E2E-NEW")).toBeVisible();
  await shot(launched.page, testInfo, "2 · swept");
});

test("forget removes a run's record without touching its neighbour", async ({}, testInfo) => {
  test.setTimeout(240_000);
  // Both need a recent createdAt — see baseRun's doc comment — or neither ever
  // renders as a `.card` to click in the first place.
  const a = seedRun(sb, baseRun(sb, "E2E-A", { createdAt: Date.now() }));
  const b = seedRun(sb, baseRun(sb, "E2E-B", { createdAt: Date.now() }));

  const launched = await launchHost(sb);
  app = launched.app;
  const deck = await Deck.open(launched.page);

  await expect(deck.card("E2E-A")).toBeVisible({ timeout: 60_000 });
  await deck.card("E2E-A").click();
  // Forget moved behind the drawer's `More` disclosure in the card-detail
  // rebuild (DeckDetail.tsx) — it is closed by default, so the button is not
  // reachable until `openMore()` expands it.
  await deck.openMore();
  // Exact, not /forget/i: the `More` summary's own label also contains
  // "forget" ("...spend breakdown, forget"), and a loose match now resolves
  // two buttons once the disclosure is open.
  await deck.detail().getByRole("button", { name: "Forget", exact: true }).click();

  await expect.poll(() => fs.existsSync(a), { timeout: 60_000 }).toBe(false);
  expect(fs.existsSync(b)).toBe(true);
  await shot(launched.page, testInfo, "3 · forgotten");
});

test("clear stale leaves live runs alone", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const live = seedRun(sb, baseRun(sb, "E2E-LIVE", { createdAt: Date.now() }));
  // "Clear stale" only renders once staleCount > 0 (DeckApp.tsx:704-712) — a
  // run left at baseRun's default 72h-old createdAt reads shelf: "closed" on
  // sight, and the counting pass (deckView.ts's buildAll, overrideGates: true)
  // counts every closed-shelf run as stale from the very first refresh. This
  // run is what makes the button exist at all; asserting it actually gets
  // cleared is what proves the click did something, not just that E2E-LIVE
  // was left alone by an inert button.
  const stale = seedRun(sb, baseRun(sb, "E2E-STALE"));

  const launched = await launchHost(sb);
  app = launched.app;
  const deck = await Deck.open(launched.page);

  await expect(deck.card("E2E-LIVE")).toBeVisible({ timeout: 60_000 });
  await shot(launched.page, testInfo, "4 · live card and one stale row");
  await deck.clearStale().click();

  // Modal-gated (deckView.ts's `clearStale`), unlike per-card Forget. The
  // confirmation is workbench chrome, not webview content — it lives on the
  // top-level `page`, outside every `iframe.webview`.
  const dialog = launched.page.locator(".monaco-dialog-box");
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole("button", { name: /^clear/i }).click();

  await expect.poll(() => fs.existsSync(stale), { timeout: 60_000 }).toBe(false);
  expect(fs.existsSync(live)).toBe(true);
  await shot(launched.page, testInfo, "5 · live run survives clear stale");
});
