import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { makeSandbox, type Sandbox } from "./_helpers/sandbox";
import { launchHost } from "./_helpers/host";
import {
  expectNoUnknownForgeCalls, forgeCalls, ghPrViewAnswer, ghReviewRequestsAnswer, installForgeShims,
  type ForgeAnswerMap,
} from "./_helpers/forgeShim";
import { seedSession, seedTranscript } from "./_helpers/claudeState";
import { Deck } from "./_helpers/po/deck";
import { shot } from "./_helpers/shot";

/**
 * What a Deck card lets you DO about a pull request that needs a human: the
 * `fixes needed` lane it lands in, the three buttons on it (Fix CI, Resolve
 * conflict, Address review), the drawer's Address PR, the `⚠ PR unread` a failed
 * read leads with, and what `agentFlow.prWorkOpenIn` / `agentFlow.prFacts` do to
 * all of it.
 *
 * Per-test hosts, `deck-github.e2e.ts`'s fixture: `agentFlow.worktree: "always"`
 * and `agentFlow.prFacts: true`, an `origin` remote and a fabricated
 * `refs/remotes/origin/HEAD` (see `prRepo` below), and every `gh` call answered by
 * the PATH shim. Each test builds its own sandbox because the settings under test
 * differ per test and because a click here writes a plan file the next test would
 * inherit.
 *
 * The PR-bearing card is a SEEDED run record on a real, checked-out branch rather
 * than a take through the sidebar (the route `deck-github.e2e.ts` takes): the two
 * facts the PR fetch needs are `repos[].branch` (fed to `gh pr list --head` and to
 * `prEligible`, src/engine/git.ts:205) and a resolvable default branch, and seeding
 * them costs one git command instead of a whole window. `createdAt: Date.now()` is
 * load-bearing — see `deck-lifecycle.e2e.ts`'s `baseRun`.
 *
 * The assertion of record for every seed is `~/.agentflow/plans/<key>-<ts>.json`:
 * the handshake the target window consumes, written by `writePlanFile`
 * (workspace.ts:356) and never deleted by a successful seed (`runSeedPass` only
 * clears unparseable and expired plans, workspace.ts:917/929), so it can be read
 * after the fact.
 */

let sb: Sandbox;
let app: ElectronApplication | undefined;
/** A working session keeps writing its transcript; this stands in for that. */
let heartbeat: NodeJS.Timeout | undefined;
/** Every window the app opens from launch onward. Each must reach `.activitybar`
 *  before `afterEach` closes the app, or `close()` hangs on a window still
 *  mid-activation (review-launch.e2e.ts learned this the hard way). */
let windows: Page[] = [];

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" });

/** The branch the seeded run sits on — anything but the repo's default, which
 *  `prEligible` refuses (a `--head main` search matches every PR ever opened from
 *  main). The shim ignores `--head` entirely, so the name only has to differ. */
const BRANCH = "E2E-PR-fix-the-rocket-telemetry-panel";

/** Make `sb.repoPath` a repo the Deck will read a PR for, and check out `BRANCH`.
 *  The two git facts are `deck-github.e2e.ts`'s, fabricated locally (the URL is
 *  never contacted — every gh call resolves to the shim): an `origin` remote, which
 *  the forge reads the project from, and `refs/remotes/origin/HEAD`, which
 *  `defaultBranch()` derives from. */
function prRepo(sandbox: Sandbox): void {
  git(sandbox.repoPath, ["remote", "add", "origin", "https://github.com/oznasi1/rocket.git"]);
  const sha = git(sandbox.repoPath, ["rev-parse", "HEAD"]).trim();
  git(sandbox.repoPath, ["update-ref", "refs/remotes/origin/main", sha]);
  git(sandbox.repoPath, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  git(sandbox.repoPath, ["checkout", "-q", "-b", BRANCH]);
}

/** The brief a take writes into each repo, written here by hand so the absolute
 *  path a seeded prompt renders points at a file that exists. Returns it. */
function writeBrief(sandbox: Sandbox): string {
  const dir = path.join(sandbox.repoPath, ".pick-task");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "TASK.md");
  fs.writeFileSync(file, "# E2E brief\n\nThe rocket panel shows stale numbers.\n");
  return file;
}

/** Write a run record straight into the store. HOME is the sandbox, so this is the
 *  same path the extension writes — not a seam. Copied from `deck-lifecycle.e2e.ts`
 *  as `deck-signal.e2e.ts` did (not exported there, and too cheap for a module). */
function seedRun(sandbox: Sandbox, run: Record<string, unknown>): string {
  const dir = path.join(sandbox.home, ".agentflow", "runs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${run.key as string}.json`);
  fs.writeFileSync(file, JSON.stringify(run, null, 2) + "\n");
  return file;
}

/** A tracked one-repo run on `BRANCH`, with the brief a take would have left. The
 *  key is one the fixture connector has never heard of, so `ticketStatus` is null
 *  forever and nothing Jira-shaped can move the card — the PR facts decide alone. */
function baseRun(sandbox: Sandbox, key: string, extra: Record<string, unknown> = {}) {
  return {
    key, summary: `Run ${key}`, url: `https://fixture.invalid/browse/${key}`,
    createdAt: Date.now(), kind: "task", mode: "per-window",
    repos: [{ name: "rocket", path: sandbox.repoPath, isGit: true, branch: BRANCH }],
    briefPaths: [path.join(sandbox.repoPath, ".pick-task", "TASK.md")], ...extra,
  };
}

/** The `gh` answers every test here needs, plus whatever the test adds.
 *  - `pr list` is the card's PR (an ARRAY — `GhProvider.list` throws on anything else).
 *  - `auth status` "{}" is `deck-github.e2e.ts`'s: `probeGh` reads only the exit code,
 *    and `parseGhAccounts` reads no `hosts` out of it, so the footer's account slot
 *    stays down and `forgeNote` owns the legend's one slot.
 *  - `api graphql` is shared by the review-queue search and the per-PR threads query;
 *    `ghReviewRequestsAnswer` folds both into one body.
 */
function ghAnswers(prList: unknown, o: { reviews?: string } = {}): ForgeAnswerMap {
  return {
    "pr list": prList,
    "auth status": "{}",
    "api graphql": o.reviews ?? ghReviewRequestsAnswer([], { unresolved: 0 }),
  };
}

/** The launched host's own pid — alive for exactly the test's life, which is what
 *  `readOpenSessions`' `pidAlive` probe needs (see claudeState.ts). */
const pidOf = (a: ElectronApplication): number => a.process().pid!;

/** Every plan file written for `key`, oldest first. `~/.agentflow/plans` under the
 *  sandbox HOME (workspace.ts:19), named `<key>-<createdAt>.json`. */
function plans(sandbox: Sandbox, key: string): { matches: { matchPath: string; prompt: string }[] }[] {
  const dir = path.join(sandbox.home, ".agentflow", "plans");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.startsWith(`${key}-`) && n.endsWith(".json"))
    .sort()
    .map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")));
}

/** One of the card's problem rows' buttons — `<button className="act">{a.label}</button>`
 *  inside `.c-row` (DeckApp.tsx:459-472 on 2026-09-04). The label is `prWorkLabel`'s
 *  (prompt.ts:159): "Fix CI", "Resolve conflict", "Address review". Local to this
 *  file: no other journey drives these rows. */
const prWorkButton = (deck: Deck, key: string, label: string): Locator =>
  deck.card(key).locator(".c-row button.act", { hasText: label });

/** The workbench's QuickPick — top-level page chrome, never inside the webview. */
function quickPick(page: Page): { widget: Locator; rows: Locator; row: (t: string) => Locator } {
  const widget = page.locator(".quick-input-widget");
  const rows = widget.locator(".quick-input-list .monaco-list-row");
  return { widget, rows, row: (t) => rows.filter({ hasText: t }) };
}

/** A prompt template that renders the brief, so a journey can see WHICH brief path
 *  a seed used. `agentFlow.prReviewPrompt` is the user's own PR-work template and
 *  the shipped default (config.ts:273) carries no `{brief}` placeholder at all —
 *  which is exactly why the absolute-brief contract is invisible without this. */
const BRIEF_PROMPT = 'PR-WORK {key} ({url}) "{summary}" — brief at {brief}.{files}';

test.afterEach(async () => {
  if (heartbeat) { clearInterval(heartbeat); heartbeat = undefined; }
  for (const w of windows) await w.locator(".activitybar").waitFor({ timeout: 60_000 }).catch(() => {});
  windows = [];
  await app?.close();
  app = undefined;
  try {
    // Self-discovery: a forge subcommand nobody faked is named here rather than
    // silently absorbed by the shim's empty-answer fallback.
    expectNoUnknownForgeCalls(sb);
  } finally {
    sb?.dispose();
  }
});

/** Boot a host on `sandbox` with the window collector armed, and open the Deck. */
async function boot(sandbox: Sandbox, opts: { folder?: string } = {}): Promise<{ page: Page; deck: Deck }> {
  const launched = await launchHost(sandbox, opts);
  app = launched.app;
  windows = [];
  app.on("window", (w) => windows.push(w));
  return { page: launched.page, deck: await Deck.open(launched.page) };
}

// ── The lane ──────────────────────────────────────────────────────────────────

// Mutation-checked: gated deriveBucket's blocked-PR rung on the session
// (bucket.ts:113, `if (i.prBlocked)` → `if (i.prBlocked && i.agentState !== "working")`)
// — the card moved to In progress's `working` lane and this test failed on both the
// column and the lane header.
test("failing required checks pull a working session into fixes needed", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = makeSandbox({ "agentFlow.worktree": "always", "agentFlow.prFacts": true });
  prRepo(sb);
  writeBrief(sb);
  seedRun(sb, baseRun(sb, "E2E-CI"));
  // One failing required check and one passing one: `mapRollup` (facts.ts:41) grades
  // the FAILURE into `ci.failing`, which is what `prSignals.blocked` reads
  // (bucket.ts) — and `ciAdvisory` stays false because `mergeStateStatus` is CLEAN,
  // so the failure is one that actually blocks.
  installForgeShims(sb, {
    gh: ghAnswers([ghPrViewAnswer({ number: 41, failing: ["build"], passing: 1, decision: "REVIEW_REQUIRED" })]),
  });

  const { page, deck } = await boot(sb);
  const session = { pid: pidOf(app!), cwd: sb.repoPath, id: "e2e-ci" };
  seedSession(sb, session);
  // A `working` transcript stays working for only 45s from its mtime
  // (claudeState.ts), and a real working session keeps writing — so re-touch it
  // every 10s rather than racing a cold host against the window.
  const tick = () => seedTranscript(sb, { cwd: session.cwd, sessionId: session.id, shape: "working" });
  tick();
  heartbeat = setInterval(tick, 10_000);

  await expect(deck.card("E2E-CI")).toBeVisible({ timeout: 60_000 });
  // The session IS working — without this the lane claim would be vacuous: a card
  // with no live session reaches `fixes needed` too, and the doc's point is that the
  // PR outranks a session that is mid-work.
  await expect(deck.status("E2E-CI")).toHaveText(/^working · /, { timeout: 30_000 });
  // The PR facts arrived: the failing check's own name on the card.
  await expect(deck.card("E2E-CI").locator(".c-row .lbl")).toContainText("build", { timeout: 90_000 });
  // Column membership, then the lane sub-header inside it. A lane is a sibling of
  // the cards it heads, not a wrapper (po/deck.ts `laneHeader`), so this is the
  // honest pair: the card is in In review, and In review is showing `fixes needed`.
  await expect(deck.cardIn("In review", "E2E-CI")).toBeVisible({ timeout: 30_000 });
  await expect(deck.laneHeader("In review", "fixes needed")).toBeVisible();
  await expect(deck.cardIn("In progress", "E2E-CI")).toHaveCount(0);
  // And the button the lane exists to offer.
  await expect(prWorkButton(deck, "E2E-CI", "Fix CI")).toBeVisible();
  await shot(page, testInfo, "1 · a working session in fixes needed");
});

// ── The three buttons and where they open ─────────────────────────────────────

// Mutation-checked: prWorkPlan's `elsewhere` (engine/prWork.ts) dropped the
// briefPath (`seats: [{ matchPath: path }]`) — the seeded prompt rendered the
// relative `.pick-task/TASK.md` and this test failed on the absolute path.
test("Fix CI seeds a session pointed at the brief by absolute path", async ({}, testInfo) => {
  test.setTimeout(240_000);
  // `prWorkOpenIn` takes only `ask` or `its-window` (config.ts:448) — there is no
  // "this window" SETTING, so the way to reach a destination other than the run's
  // own window is the `ask` picker's "This window" row, which is the documented
  // route (SETTINGS § `agentFlow.prWorkOpenIn`). The host therefore opens ON the
  // repo folder: only a window with an identity is offered that row
  // (openTarget.ts:117-119, presence.ts:56).
  sb = makeSandbox({
    "agentFlow.worktree": "always", "agentFlow.prFacts": true,
    "agentFlow.prWorkOpenIn": "ask", "agentFlow.prReviewPrompt": BRIEF_PROMPT,
  });
  prRepo(sb);
  const brief = writeBrief(sb);
  seedRun(sb, baseRun(sb, "E2E-BRIEF"));
  installForgeShims(sb, {
    gh: ghAnswers([ghPrViewAnswer({ number: 41, failing: ["build"], passing: 1, decision: "REVIEW_REQUIRED" })]),
  });

  const { page, deck } = await boot(sb, { folder: sb.repoPath });
  await expect(prWorkButton(deck, "E2E-BRIEF", "Fix CI")).toBeVisible({ timeout: 90_000 });
  await prWorkButton(deck, "E2E-BRIEF", "Fix CI").click();

  // The destination question, titled with the same verb the button carried
  // (prWorkLabel, prompt.ts:159) — and its rows are the four the doc lists.
  const { widget, rows, row } = quickPick(page);
  await expect(widget).toBeVisible({ timeout: 30_000 });
  await expect(widget).toContainText("Fix CI for E2E-BRIEF — open where?");
  await expect(row("Its own window")).toHaveCount(1);
  await expect(row("This window")).toHaveCount(1);
  await expect(row("Existing workspace")).toHaveCount(1);
  // "an Agent Flow window that is already open": this window's own presence record
  // (`agentFlow.trackOpenWindows` defaults on), listed with `liveWindowItems`'
  // "open now" detail (openTarget.ts:66-70).
  await expect(rows.filter({ hasText: "open now" })).not.toHaveCount(0);
  await shot(page, testInfo, "2 · Fix CI asks where");
  await row("This window").click();

  // One seat for the whole run, pointed at the run's ABSOLUTE brief — the relative
  // `.pick-task/TASK.md` a `stay` seat renders would resolve only in the repo, and
  // this window is a destination the user picked.
  await expect.poll(() => plans(sb, "E2E-BRIEF").length, { timeout: 60_000 }).toBe(1);
  const [plan] = plans(sb, "E2E-BRIEF");
  expect(plan.matches).toHaveLength(1);
  expect(fs.realpathSync(plan.matches[0].matchPath)).toBe(fs.realpathSync(sb.repoPath));
  expect(plan.matches[0].prompt).toContain(fs.realpathSync(brief));
  expect(plan.matches[0].prompt).toMatch(/^PR-WORK E2E-BRIEF /);
  // And what is wrong leads the prompt, naming the check by name (prWorkClause,
  // prompt.ts:136-141) — the seeded session is told the situation, not just the ticket.
  expect(plan.matches[0].prompt).toContain("CI is failing on this PR (build)");
  await shot(page, testInfo, "3 · seeded in this window");
});

// Mutation-checked: made prWorkClause (prompt.ts:142-145) answer the conflict case
// with `""` like the review case — the two prompts became byte-identical and this
// test failed on the conflict sentence.
test("Resolve conflict and Address review seed their own prompts", async ({}, testInfo) => {
  test.setTimeout(240_000);
  // One PR that is BOTH conflicting and changes-requested, so `cardActions`
  // (deckSignal.ts:149-181) offers both rows at once and the two seeds can be
  // compared under one fixture. `ask` + "This window" for both clicks: it opens no
  // window (prWorkPlan's `current` case has an empty `toOpen`), which keeps the two
  // plan files the only thing that moves.
  sb = makeSandbox({
    "agentFlow.worktree": "always", "agentFlow.prFacts": true, "agentFlow.prWorkOpenIn": "ask",
  });
  prRepo(sb);
  writeBrief(sb);
  seedRun(sb, baseRun(sb, "E2E-BOTH"));
  installForgeShims(sb, {
    gh: ghAnswers([
      ghPrViewAnswer({ number: 41, passing: 1, mergeable: "CONFLICTING", decision: "CHANGES_REQUESTED" }),
    ]),
  });

  const { page, deck } = await boot(sb, { folder: sb.repoPath });
  await expect(prWorkButton(deck, "E2E-BOTH", "Resolve conflict")).toBeVisible({ timeout: 90_000 });
  await expect(prWorkButton(deck, "E2E-BOTH", "Address review")).toBeVisible();
  await shot(page, testInfo, "4 · both problem rows on one card");

  const pick = async () => {
    const { widget, row } = quickPick(page);
    await expect(widget).toBeVisible({ timeout: 30_000 });
    await row("This window").click();
    await expect(widget).toBeHidden({ timeout: 15_000 });
  };
  await prWorkButton(deck, "E2E-BOTH", "Resolve conflict").click();
  await pick();
  await expect.poll(() => plans(sb, "E2E-BOTH").length, { timeout: 60_000 }).toBe(1);
  await prWorkButton(deck, "E2E-BOTH", "Address review").click();
  await pick();
  await expect.poll(() => plans(sb, "E2E-BOTH").length, { timeout: 60_000 }).toBe(2);

  // Sorted by filename, which is `<key>-<createdAt>` — so the conflict click first.
  const [conflict, review] = plans(sb, "E2E-BOTH").map((p) => p.matches[0].prompt);
  expect(conflict).not.toBe(review);
  // Each names its own situation: the conflict clause is prWorkClause's
  // (prompt.ts:142-143); the review reason has no clause of its own, so its prompt is
  // the PR-review template alone (deckView.ts `seedPrWorkHeld`) — which is what
  // Address PR has always sent, and which names the review it is going to read.
  expect(conflict).toContain("This PR conflicts with its base branch");
  expect(review).not.toContain("This PR conflicts with its base branch");
  for (const p of [conflict, review]) {
    expect(p).toContain("unresolved review comments and requested");
  }
  await shot(page, testInfo, "5 · two seeds, two prompts");
});

// Mutation-checked: made prWorkTarget (deckView.ts:5337) ask regardless of the
// setting (`if (cfg.prWorkOpenIn !== "ask")` → `if (false)`) — the picker opened,
// no plan file ever landed, and the poll below failed.
test("prWorkOpenIn its-window asks nothing", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = makeSandbox({
    "agentFlow.worktree": "always", "agentFlow.prFacts": true,
    "agentFlow.prWorkOpenIn": "its-window", "agentFlow.prReviewPrompt": BRIEF_PROMPT,
  });
  prRepo(sb);
  writeBrief(sb);
  seedRun(sb, baseRun(sb, "E2E-QUIET"));
  installForgeShims(sb, {
    gh: ghAnswers([ghPrViewAnswer({ number: 41, failing: ["build"], passing: 1, decision: "REVIEW_REQUIRED" })]),
  });

  const { page, deck } = await boot(sb);
  await expect(prWorkButton(deck, "E2E-QUIET", "Fix CI")).toBeVisible({ timeout: 90_000 });
  await prWorkButton(deck, "E2E-QUIET", "Fix CI").click();

  // The plan file landing IS the proof that nothing asked: a picker parks
  // `seedPrWorkHeld` before anything is written (deckView.ts — "asked BEFORE
  // anything is written"), so a plan file cannot exist while a question is open.
  await expect.poll(() => plans(sb, "E2E-QUIET").length, { timeout: 60_000 }).toBe(1);
  await expect(quickPick(page).widget).toBeHidden();
  // `its-window` re-seeds where the run already lives: one seat per repo, and the
  // relative brief, which resolves because the window IS the repo — the contrast
  // that makes the absolute-brief journey above mean something.
  const [plan] = plans(sb, "E2E-QUIET");
  expect(plan.matches).toHaveLength(1);
  expect(fs.realpathSync(plan.matches[0].matchPath)).toBe(fs.realpathSync(sb.repoPath));
  expect(plan.matches[0].prompt).toContain("brief at .pick-task/TASK.md.");
  expect(plan.matches[0].prompt).not.toContain(path.join(fs.realpathSync(sb.repoPath), ".pick-task"));
  await shot(page, testInfo, "6 · seeded with no question asked");
});

// Mutation-checked: prWorkPlan's `stay` case (engine/prWork.ts) returned
// `elsewhere(run.repos[0].path + "-wt")` — the plan's matchPath was a path the run
// does not own and this test failed on the matchPath equality.
test("the Deck's Address PR re-seeds the run's workspace in place", async ({}, testInfo) => {
  test.setTimeout(240_000);
  // `agentFlow.worktree: "always"` is the strong fixture here, not "never": the
  // sidebar's Address PR forces a worktree whatever the setting says
  // (address-pr.e2e.ts), so proving the DECK's Address PR creates none while the
  // setting demands one is what separates the two surfaces (GUIDE § What it does).
  sb = makeSandbox({
    "agentFlow.worktree": "always", "agentFlow.prFacts": true, "agentFlow.prWorkOpenIn": "its-window",
  });
  prRepo(sb);
  writeBrief(sb);
  seedRun(sb, baseRun(sb, "E2E-APR"));
  // An open PR nobody has decided on: `REVIEW_REQUIRED` with clean mergeability and
  // a green check is neither `blocked` nor `ready` (bucket.ts `prSignals`), so the
  // card sits in In review's `waiting on review` lane — which is what the Deck gates
  // its Address PR on (DeckDetail.tsx:288, `card.column === "review" && prSignals.open`).
  installForgeShims(sb, {
    gh: ghAnswers([ghPrViewAnswer({ number: 41, passing: 2, decision: "REVIEW_REQUIRED" })]),
  });

  const { page, deck } = await boot(sb);
  await expect(deck.cardIn("In review", "E2E-APR")).toBeVisible({ timeout: 90_000 });
  await expect(deck.laneHeader("In review", "waiting on review")).toBeVisible();
  await deck.card("E2E-APR").click();
  // Promoted above the drawer's `More` fold, in `.dd-acts` (DeckDetail.tsx:491-495).
  const addressPr = deck.detail().getByRole("button", { name: "Address PR", exact: true });
  await expect(addressPr).toBeVisible({ timeout: 15_000 });
  await shot(page, testInfo, "7 · Address PR on a waiting card");
  await addressPr.click();

  await expect.poll(() => plans(sb, "E2E-APR").length, { timeout: 60_000 }).toBe(1);
  const [plan] = plans(sb, "E2E-APR");
  expect(plan.matches).toHaveLength(1);
  // The workspace the run already has — the repo itself.
  expect(fs.realpathSync(plan.matches[0].matchPath)).toBe(fs.realpathSync(sb.repoPath));
  expect(plan.matches[0].prompt).toContain("find the PR for E2E-APR");
  // No new worktree anywhere: neither the per-task directory a take would create
  // (`<repo>/.claude/worktrees`, engine/worktree.ts) nor a registration in git's own
  // list, which is the record that would survive a directory being moved.
  expect(fs.existsSync(path.join(sb.repoPath, ".claude", "worktrees"))).toBe(false);
  expect(git(sb.repoPath, ["worktree", "list", "--porcelain"]).match(/^worktree /gm)).toHaveLength(1);
  await shot(page, testInfo, "8 · seeded in place, no worktree");
});

// ── When the read fails, and when it is switched off ──────────────────────────

// Mutation-checked: dropped the `error: true` stamp from the failed-fetch entry
// (deckView.ts:2233) — `unreadRepos` saw nothing wrong, the card lost the warning
// and the legend lost the count.
test("a failing PR read shows PR unread and counts it in the footer", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = makeSandbox({ "agentFlow.worktree": "always", "agentFlow.prFacts": true });
  prRepo(sb);
  writeBrief(sb);
  seedRun(sb, baseRun(sb, "E2E-UNREAD"));
  // `probe()` passing does not promise the reads will work (FORGES § 4): `auth
  // status` is healthy and `pr list` fails — the per-repository answer a global
  // probe cannot see. `execRunner` rejects on any non-zero exit, so `fetch` returns
  // `{ ok: false }` and the entry keeps `error: true` with null facts.
  installForgeShims(sb, {
    gh: {
      ...ghAnswers([]),
      "pr list": { exit: 1, stderr: "gh: Could not resolve to a Repository with the name 'oznasi1/rocket'.\n" },
    },
  });

  const { page, deck } = await boot(sb);
  const card = deck.card("E2E-UNREAD");
  await expect(card).toBeVisible({ timeout: 60_000 });
  // The card LEADS with it — `cardSignal` (deckSignal.ts:64-67) pushes the warning
  // ahead of every fact, which is what makes it survive the three-bit cap.
  await expect(card.locator(".c-sig")).toContainText("⚠ PR unread", { timeout: 90_000 });
  await expect(card.locator(".c-sig")).toContainText("rocket"); // the repo it could not read
  // And the board's footer counts the runs, in the legend's one note slot
  // (`forgeNote`, deckView.ts:114-129 — the account slot stands down here because
  // the `auth status` answer names no logins).
  await expect(deck.frame.locator(".legend .note.warn"))
    .toContainText("could not read the PR state for 1 run", { timeout: 30_000 });
  // Nothing acts on the carried-forward facts: `cardActions` refuses a failed entry
  // outright (deckSignal.ts:150-160), so the card offers no problem row to click.
  await expect(card.locator(".c-row")).toHaveCount(0);
  await shot(page, testInfo, "9 · PR unread, counted in the footer");
});

// Mutation-checked: made onConfigChanged ignore the setting (deckView.ts:3952,
// `if (e.affectsConfiguration("agentFlow.prFacts"))` → `if (false)`) — the card kept
// #41 and the review strip kept its row, both live in the panel that was never reopened.
test("turning prFacts off drops PR facts and darkens the review strip live", async ({}, testInfo) => {
  test.setTimeout(300_000);
  // The review TTL at its floor (60s, config.ts:837): with the strip's shared gate
  // honoured, no further search may be issued after the flip — and 60s is short
  // enough for the wait below to prove that rather than merely outrun the clock.
  sb = makeSandbox({
    "agentFlow.worktree": "always", "agentFlow.prFacts": true, "agentFlow.reviewRequestsTtlSeconds": 60,
  });
  prRepo(sb);
  writeBrief(sb);
  seedRun(sb, baseRun(sb, "E2E-OFF"));
  installForgeShims(sb, {
    gh: ghAnswers([ghPrViewAnswer({ number: 41, passing: 2, decision: "REVIEW_REQUIRED" })], {
      reviews: ghReviewRequestsAnswer(
        [{ number: 42, repo: "oznasi1/telemetry", title: "Refit the landing gear", author: "octo" }],
        { unresolved: 1 },
      ),
    }),
  });

  const { page, deck } = await boot(sb);
  const card = deck.card("E2E-OFF");
  await expect(card).toBeVisible({ timeout: 60_000 });
  // Both halves of the gate are live first, or "it went dark" proves nothing.
  await expect(card.locator(".c-sig")).toContainText("#41", { timeout: 90_000 });
  await expect(deck.reviews()).toHaveCount(1, { timeout: 90_000 });
  await shot(page, testInfo, "10 · PR facts and the strip, both live");

  // Flipped the way a person does — by saving settings.json. The workbench watches
  // the user settings file and raises `onDidChangeConfiguration`; the panel is never
  // closed or reopened here, which is the doc's "applied the moment you save".
  const settingsPath = path.join(sb.userDataDir, "User", "settings.json");
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  settings["agentFlow.prFacts"] = false;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  // The cards fall back to the git + Jira backbone: the PR store stops being read at
  // all (deckView.ts:3573), so the number goes with it.
  await expect(card.locator(".c-sig")).not.toContainText("#41", { timeout: 30_000 });
  // And the strip goes dark — not merely empty: `postReviews` posts `enabled: false`
  // and `alwaysVisible: false` (deckView.ts:2510-2525), so the whole strip unmounts
  // rather than leaving live write buttons on frozen rows.
  await expect(deck.reviews()).toHaveCount(0, { timeout: 30_000 });
  await expect(deck.frame.locator(".rv-strip")).toHaveCount(0);
  await shot(page, testInfo, "11 · facts dropped, strip dark");

  // The strip's forge read is gated on PR facts too, not just its own setting
  // (PRIVACY): `agentFlow.reviewRequests` is still on, and the search TTL has since
  // elapsed — with the gate broken, another `api graphql` would have been issued.
  const searches = () => forgeCalls(sb).filter((c) => c.argv[0] === "api" && c.argv[1] === "graphql").length;
  const before = searches();
  expect(before).toBeGreaterThan(0);
  await page.waitForTimeout(75_000);
  expect(searches()).toBe(before);
});
