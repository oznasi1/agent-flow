import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { makeSandbox, type Sandbox } from "./_helpers/sandbox";
import { launchHost, openTasksView } from "./_helpers/host";
import { seedSession, seedTranscript } from "./_helpers/claudeState";
import { Deck } from "./_helpers/po/deck";
import { shot } from "./_helpers/shot";

/**
 * The Deck's live signal, read from Claude Code's own state on disk — the
 * sessions registry (`~/.claude/sessions`) and the transcripts
 * (`~/.claude/projects`), both seeded into the sandbox HOME by
 * `_helpers/claudeState.ts`, which documents every field the readers probe.
 *
 * Per-test hosts: each test builds its own sandbox because the settings differ
 * (`notifyOnActionRequired` on in exactly one), and because a session record
 * must carry a LIVE pid — the launched Electron's own (`app.process().pid`), so
 * the session is seeded after `launchHost`, never before.
 *
 * Which shape means what, from `deriveActivity` (src/engine/transcript.ts) and
 * `deriveBucket` (src/engine/bucket.ts), read on 2026-09-03:
 *   working       transcript touched ≤ 45s ago            → In progress · working
 *   ended-turn    last line `stop_reason: "end_turn"`      → `ended turn`, In progress · parked
 *   pending-tool  an unanswered Bash call aged > 720s      → `blocked · waiting on Bash`, Action required
 *   (none)        no transcript file                       → `parked · git + Fixture only`
 * Action required admits exactly `blocked` and `exited`; the `ended-turn` test
 * below pins where GUIDE.md still says otherwise.
 */

let sb: Sandbox;
let app: ElectronApplication | undefined;
/** A working session keeps writing its transcript; this stands in for that. */
let heartbeat: NodeJS.Timeout | undefined;

/** Write a run record straight into the store. HOME is the sandbox, so this is
 *  the same path the extension writes — not a seam. Copied from
 *  `deck-lifecycle.e2e.ts`'s `seedRun`, as `workflows.e2e.ts` did (not exported
 *  there, and too cheap to be worth a shared module). */
function seedRun(sb: Sandbox, run: Record<string, unknown>): string {
  const dir = path.join(sb.home, ".agentflow", "runs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${run.key as string}.json`);
  fs.writeFileSync(file, JSON.stringify(run, null, 2) + "\n");
  return file;
}

/** A tracked task run in one repo. `createdAt: Date.now()` on purpose — see
 *  `deck-lifecycle.e2e.ts`'s `baseRun` doc comment: a run is only a `.card`
 *  while its shelf is not "closed", and `justLaunched` (visibility.ts,
 *  JUST_LAUNCHED_MS = 10 min) is what holds a run there when it has no live
 *  session, no PR and nothing to lose — the Copilot run below, and every run in
 *  the moments before its session is seeded. The key is one the fixture
 *  connector has never heard of, so `ticketStatus` is null forever and nothing
 *  Jira-shaped can move the card; that is the neutral backbone these tests want. */
function baseRun(sb: Sandbox, key: string, repoPath = sb.repoPath, extra: Record<string, unknown> = {}) {
  return {
    key, summary: `Run ${key}`, url: `https://fixture.invalid/browse/${key}`,
    createdAt: Date.now(), kind: "task", mode: "per-window",
    repos: [{ name: path.basename(repoPath), path: repoPath, isGit: true, branch: "main" }],
    briefPaths: [], ...extra,
  };
}

/** A second real git repo beside `rocket`, for a run that must own a place of
 *  its own — a session is matched to a run by its cwd, and two runs in one
 *  checkout would fight over one session. Same recipe as `sandbox.ts`. */
function addRepo(sb: Sandbox, name: string): string {
  const p = path.join(sb.reposRoot, name);
  fs.mkdirSync(p, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: p });
  fs.writeFileSync(path.join(p, "README.md"), `# ${name}\n`);
  execFileSync("git", ["add", "."], { cwd: p });
  execFileSync("git", ["-c", "user.email=e2e@fixture.invalid", "-c", "user.name=E2E", "commit", "-qm", "init"], { cwd: p });
  return p;
}

/** The launched host's own pid — alive for exactly the test's life, which is
 *  what `readOpenSessions`' `pidAlive` probe needs (see claudeState.ts). */
const pidOf = (a: ElectronApplication): number => a.process().pid!;

/** `BLOCKED_AFTER_MS.Bash` is 720_000 (transcript.ts:50): a Bash call pending
 *  longer than the tool's own 600s timeout cap provably is not a running
 *  command, so the reader calls it `blocked`. 800s clears that with margin and
 *  stays far below anything else that reads a transcript's age. */
const BLOCKED_AGE_MS = 800_000;

/** Workbench toasts live on the top-level page, outside every webview iframe. */
const waitingToasts = (page: Page) => page.locator(".notification-list-item", { hasText: /waiting on you/ });

/** `~/.agentflow/attention.json` — the announcement latch `runAttentionPass`
 *  writes (src/engine/attentionStore.ts). The durable record of what has been
 *  announced: its keys are exactly the runs currently counted as waiting. */
const announcedKeys = (sb: Sandbox): string[] => {
  try {
    return Object.keys(JSON.parse(fs.readFileSync(path.join(sb.home, ".agentflow", "attention.json"), "utf8"))).sort();
  } catch {
    return [];
  }
};

test.afterEach(async () => {
  if (heartbeat) { clearInterval(heartbeat); heartbeat = undefined; }
  await app?.close();
  app = undefined;
  sb?.dispose();
});

// Mutation-checked: inverted the working window in deriveActivity (transcript.ts,
// `age <= WORKING_WINDOW_MS` → `age > WORKING_WINDOW_MS`) — the card read
// `idle · 10s ago`.
test("a session mid-work reads working on its card and sits in In progress", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = makeSandbox();
  seedRun(sb, baseRun(sb, "E2E-WORK"));

  const launched = await launchHost(sb);
  app = launched.app;
  const session = { pid: pidOf(app), cwd: sb.repoPath, id: "e2e-work" };
  seedSession(sb, session);
  // A `working` transcript stays working for 45s from its mtime (claudeState.ts).
  // A real working session keeps writing, so this re-touches the file every 10s
  // for the life of the test rather than racing a cold host against the window.
  const tick = () => seedTranscript(sb, { cwd: session.cwd, sessionId: session.id, shape: "working" });
  tick();
  heartbeat = setInterval(tick, 10_000);

  const deck = await Deck.open(launched.page);
  await expect(deck.card("E2E-WORK")).toBeVisible({ timeout: 60_000 });
  // `working · Ns ago` — stateView's working branch (DeckApp.tsx:163).
  await expect(deck.status("E2E-WORK")).toHaveText(/^working · /, { timeout: 30_000 });
  // Column membership, not just the words: the card is INSIDE the In progress
  // section, under its `working` lane header.
  await expect(deck.cardIn("In progress", "E2E-WORK")).toBeVisible();
  await expect(deck.laneHeader("In progress", "working")).toBeVisible();
  await expect(deck.cardIn("Action required", "E2E-WORK")).toHaveCount(0);
  await shot(launched.page, testInfo, "1 · working card in In progress");
});

/** A tracked run whose one session ended its turn, on the board. Shared by the
 *  two tests below: one pins the doc's claim about the column, the other holds
 *  the product to what it actually does. Returns the opened Deck. */
async function endedTurnBoard(key: string): Promise<{ deck: Deck; page: Page }> {
  sb = makeSandbox();
  seedRun(sb, baseRun(sb, key));
  const launched = await launchHost(sb);
  app = launched.app;
  const session = { pid: pidOf(app), cwd: sb.repoPath, id: `e2e-${key.toLowerCase()}` };
  seedSession(sb, session);
  // `end_turn` on the last line is needs-you at ANY age (transcript.ts:135), so
  // this needs no heartbeat the way a `working` shape does.
  seedTranscript(sb, { cwd: session.cwd, sessionId: session.id, shape: "ended-turn" });
  const deck = await Deck.open(launched.page);
  await expect(deck.card(key)).toBeVisible({ timeout: 60_000 });
  return { deck, page: launched.page };
}

// Mutation-checked: added `|| i.agentState === "needs-you"` to deriveBucket's
// needs rung (bucket.ts:104) — the card moved to Action required, this test
// passed, and Playwright reported it as failed ("expected to fail, but passed"),
// which is what a mutation check on a pinned test looks like.
// Pinned: GUIDE.md § The Deck says Action required is "a session that ended its
// turn, stalled, or exited", but deriveBucket (bucket.ts:100-118) admits only
// `blocked` and `exited`; an ended turn falls through to In progress's `parked`
// lane. The docblock there argues the product's case at length ("just as often a
// session that finished cleanly … it was this column's whole volume problem"), so
// the deliberate behaviour is the code's and the stale sentence is the doc's. The
// sibling test below holds the product to what it does; this one holds the doc to
// what it claims, and fails until the sentence is corrected.
// Deliberately asserts ONE fact and nothing else: a `test.fail` is green whenever
// ANY line in it fails, so an extra assertion here (that the card is in In
// progress, say) would make the pin unfalsifiable — the mutation above could
// never turn it green.
test.fail("a session that ended its turn lands the card in Action required", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const { deck, page } = await endedTurnBoard("E2E-TURN");
  await shot(page, testInfo, "2 · ended turn on the board");
  await expect(deck.cardIn("Action required", "E2E-TURN")).toBeVisible({ timeout: 30_000 });
});

// Mutation-checked: the same `|| i.agentState === "needs-you"` rung in
// deriveBucket (bucket.ts:104) — the card left In progress and this test failed
// on the `parked` lane header.
test("an ended turn reads ended turn and parks in In progress", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const { deck, page } = await endedTurnBoard("E2E-PARKED");
  // `ended turn · Ns ago` — stateView's needs-you branch (DeckApp.tsx:170).
  await expect(deck.status("E2E-PARKED")).toHaveText(/^ended turn · /, { timeout: 30_000 });
  await expect(deck.cardIn("In progress", "E2E-PARKED")).toBeVisible();
  await expect(deck.laneHeader("In progress", "parked")).toBeVisible();
  await expect(deck.cardIn("Action required", "E2E-PARKED")).toHaveCount(0);
  await shot(page, testInfo, "3 · ended turn parks in In progress");
});

// Mutation-checked: made readSessionActivity (transcript.ts) answer `idle` instead
// of UNKNOWN_ACTIVITY for a missing transcript file — the card read `idle · 5s ago`.
test("a run with no transcript reads parked", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = makeSandbox();
  seedRun(sb, baseRun(sb, "E2E-PARK"));

  const launched = await launchHost(sb);
  app = launched.app;
  // A live session and NO transcript for it: the one route back to the git +
  // Jira backbone (GUIDE.md § The Deck). The session itself still attaches.
  seedSession(sb, { pid: pidOf(app), cwd: sb.repoPath, id: "e2e-park" });

  const deck = await Deck.open(launched.page);
  await expect(deck.card("E2E-PARK")).toBeVisible({ timeout: 60_000 });
  // `parked · git + <source> only` — stateView's unknown branch (DeckApp.tsx:161).
  // The source label is the connector's (`Fixture`, src/tasks/fixture/connector.ts).
  await expect(deck.status("E2E-PARK")).toHaveText("parked · git + Fixture only", { timeout: 30_000 });
  await expect(deck.cardIn("In progress", "E2E-PARK")).toBeVisible();
  // The session is on the card even though its transcript is not — "no
  // transcript" and "no session" are different facts, and this is the first.
  // The drawer's Sessions section names it: the session's `name`, which is the
  // cwd's basename (claudeState.ts), in an `.ag-row` reading `open`.
  await deck.card("E2E-PARK").click();
  await expect(deck.sessions().locator(".ag-row")).toHaveCount(1, { timeout: 15_000 });
  await expect(deck.sessions().locator(".ag-row")).toContainText("rocket");
  await shot(launched.page, testInfo, "4 · parked with a session and no transcript");
});

// Mutation-checked: dropped the prune from `nextAnnouncements` (attention.ts —
// `if (live.has(key)) next[key] = at` → `next[key] = at`), which is the mechanism
// behind "one per park": the answered run never left the latch, so the poll for
// `["E2E-B"]` kept seeing both keys and the test failed there.
test("notifyOnActionRequired raises one notification per park, coalescing several", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = makeSandbox({ "agentFlow.notifyOnActionRequired": true });
  const telemetry = addRepo(sb, "telemetry");
  seedRun(sb, baseRun(sb, "E2E-A"));
  seedRun(sb, baseRun(sb, "E2E-B", telemetry));

  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;
  const a = { pid: pidOf(app), cwd: sb.repoPath, id: "e2e-a" };
  const b = { pid: pidOf(app), cwd: telemetry, id: "e2e-b" };
  seedSession(sb, a);
  seedSession(sb, b);
  // Both park in the same pass: a Bash call pending past its ceiling is `blocked`,
  // which is one of the two states Action required admits.
  seedTranscript(sb, { cwd: a.cwd, sessionId: a.id, shape: "pending-tool", ageMs: BLOCKED_AGE_MS });
  seedTranscript(sb, { cwd: b.cwd, sessionId: b.id, shape: "pending-tool", ageMs: BLOCKED_AGE_MS });

  // The attention pass runs every other 6s tick (extension.ts) whether or not the
  // Deck is open — so the Deck stays closed here until the end, and the toast is
  // workbench chrome on the top-level page. ONE toast for two runs: `toHaveCount(1)`
  // keeps waiting through a moment with two and fails, which is the coalescing claim.
  await expect(waitingToasts(page)).toHaveCount(1, { timeout: 90_000 });
  await expect(waitingToasts(page).first()).toContainText("2 sessions are waiting on you");
  expect(announcedKeys(sb)).toEqual(["E2E-A", "E2E-B"]);
  await shot(page, testInfo, "5 · one toast for two parked runs");

  // Answer one: a working session is no longer waiting, and the latch prunes it.
  // Re-touched every 5s so the 45s working window cannot lapse under a slow pass.
  heartbeat = setInterval(() => seedTranscript(sb, { cwd: a.cwd, sessionId: a.id, shape: "working" }), 5_000);
  seedTranscript(sb, { cwd: a.cwd, sessionId: a.id, shape: "working" });
  await expect.poll(() => announcedKeys(sb), { timeout: 90_000 }).toEqual(["E2E-B"]);
  clearInterval(heartbeat);
  heartbeat = undefined;

  // Park it again: new news, announced again — and named, since it is alone.
  seedTranscript(sb, { cwd: a.cwd, sessionId: a.id, shape: "pending-tool", ageMs: BLOCKED_AGE_MS });
  await expect(page.locator(".notification-list-item", { hasText: "E2E-A is waiting on you" })).toBeVisible({ timeout: 90_000 });
  expect(announcedKeys(sb)).toEqual(["E2E-A", "E2E-B"]);
  await shot(page, testInfo, "6 · the re-parked run is announced by name");

  // Both sit in Action required on the board the toast points at.
  const deck = await Deck.open(page);
  await expect(deck.cardIn("Action required", "E2E-A")).toBeVisible({ timeout: 60_000 });
  await expect(deck.cardIn("Action required", "E2E-B")).toBeVisible({ timeout: 60_000 });
  await expect(deck.status("E2E-A")).toHaveText(/^blocked · waiting on Bash · /);
  await shot(page, testInfo, "7 · both cards in Action required");
});

// Mutation-checked: runAttentionPass (attentionJob.ts) `deps.setAttention(keys)` →
// `deps.setAttention([])` — the badge never appeared.
test("the activity-bar badge counts waiting runs whether or not notifications are on", async ({}, testInfo) => {
  test.setTimeout(240_000);
  // Notifications OFF — the manifest default. The badge is the ambient tier.
  sb = makeSandbox({ "agentFlow.notifyOnActionRequired": false });
  seedRun(sb, baseRun(sb, "E2E-WAIT"));

  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;
  const session = { pid: pidOf(app), cwd: sb.repoPath, id: "e2e-wait" };
  seedSession(sb, session);
  seedTranscript(sb, { cwd: session.cwd, sessionId: session.id, shape: "pending-tool", ageMs: BLOCKED_AGE_MS });

  // The badge sits on the view container's activity-bar item, and VS Code only
  // applies a view's badge once the view has been resolved (tasksView.ts
  // `applyAttention`: "A sidebar never opened at all in a window still gets no
  // badge; that is a VS Code constraint"). Opening the sidebar once is that. The
  // Deck is never opened: the pass gathers its own candidates (attentionFs.ts).
  const item = page.locator('.activitybar [aria-label*="Agent Flow"]').first();
  await expect(item).toBeVisible({ timeout: 60_000 });
  await openTasksView(page);
  await expect(page.locator('.activitybar [aria-label*="Agent Flow"] .badge-content').first())
    .toHaveText("1", { timeout: 90_000 });
  // Same pass, same keys: had the setting announced anything, it would be here by now.
  await expect(waitingToasts(page)).toHaveCount(0);
  await shot(page, testInfo, "8 · badge 1, no toast, Deck closed");
});

// Mutation-checked: stateView's unknown branch (DeckApp.tsx:161) returned
// `working · now` — the card claimed a live signal it had no source for.
test("a Copilot run gets the backbone but no session", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = makeSandbox();
  // The record's own provider stamp (Run.provider, types.ts:156). Copilot writes
  // no session record and no transcript, so neither is seeded — that absence IS
  // the fixture: the Deck reads Claude Code's files, and there are none.
  seedRun(sb, baseRun(sb, "E2E-COP", sb.repoPath, { provider: "copilot" }));

  const launched = await launchHost(sb);
  app = launched.app;
  const deck = await Deck.open(launched.page);
  const card = deck.card("E2E-COP");
  await expect(card).toBeVisible({ timeout: 60_000 });
  // The backbone: the branch from the run record (`⎇ main`, deckSignal.ts:103),
  // and the tool driving it on the kind mark (icons.tsx `CardKindIcon`).
  await expect(card.locator(".c-sig .m", { hasText: "main" })).toBeVisible();
  await expect(card.locator('.av[aria-label*="GitHub Copilot"]')).toBeVisible();
  // No live signal: the state line is the parked backbone reading.
  await expect(deck.status("E2E-COP")).toHaveText("parked · git + Fixture only", { timeout: 30_000 });
  await expect(deck.cardIn("In progress", "E2E-COP")).toBeVisible();
  // And no session: the drawer's Sessions section says so in words.
  await card.click();
  await expect(deck.sessions().locator(".dd-none")).toHaveText("No session open — git + Fixture only", { timeout: 15_000 });
  await expect(deck.sessions().locator(".ag-row")).toHaveCount(0);
  await shot(launched.page, testInfo, "9 · Copilot card, backbone only");
});
