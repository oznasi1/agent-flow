import { expect, test, type ElectronApplication } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { makeSandbox, type Sandbox } from "./_helpers/sandbox";
import { launchHost } from "./_helpers/host";
import { seedSession } from "./_helpers/claudeState";
import { Deck } from "./_helpers/po/deck";
import { shot } from "./_helpers/shot";

/** GUIDE § The Deck — "every Claude Code session open on this machine", on a real
 *  host. The Deck reads `~/.claude/sessions` (src/engine/sessions.ts) and turns a
 *  place no tracked run claims into a `local` card (deckView.ts `buildAll` →
 *  engine/localRuns.ts `localRunFor`). HOME is the sandbox, so `seedSession`
 *  writes to the exact directory the extension reads — not a seam.
 *
 *  Each test boots its own Electron: the settings differ per test, one test runs
 *  two hosts back to back, and one kills the process a session record points at,
 *  so nothing can be shared with a sibling. The sandbox is made in the test body
 *  and torn down in `afterEach`, as remote-control.e2e.ts does. */
let sb: Sandbox | undefined;
let app: ElectronApplication | undefined;
/** The stand-in for a Claude Code process in the "session dies" test — killed in
 *  the test, and again here so a failed run never leaks a 10-minute `sleep`. */
let child: ChildProcess | undefined;
test.afterEach(async () => {
  try {
    child?.kill();
    await app?.close();
  } finally {
    child = undefined;
    app = undefined;
    sb?.dispose();
    sb = undefined;
  }
});

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" });

/** A second git repo under the sandbox's reposRoot, checked out on `branch` from
 *  its first commit. Same recipe as `makeSandbox`'s own `rocket`, plus
 *  `symbolic-ref` so the initial branch is named by the test rather than by the
 *  developer's `init.defaultBranch` — the branch name is what `inferTicket`
 *  (engine/localRuns.ts) reads, so it must be deterministic. Returns the path as
 *  the Deck will report it: `groupByPlace` canonicalises through `realpath`, and
 *  macOS's tmpdir is a `/var` → `/private/var` symlink. */
function makeScratch(sandbox: Sandbox, branch: string): string {
  const repo = path.join(sandbox.reposRoot, "scratch");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
  fs.writeFileSync(path.join(repo, "README.md"), "# scratch\n");
  git(repo, ["add", "."]);
  git(repo, ["-c", "user.email=e2e@fixture.invalid", "-c", "user.name=E2E", "commit", "-qm", "init"]);
  return fs.realpathSync(repo);
}

/** Every run record on disk, parsed. The store is `~/.agentflow/runs/<key>.json`
 *  (src/engine/runs.ts), one file per run. */
function readRunFiles(sandbox: Sandbox): { file: string; run: { key: string; kind?: string; repos: { path: string }[] } }[] {
  const dir = path.join(sandbox.home, ".agentflow", "runs");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => ({
    file: path.join(dir, n),
    run: JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")),
  }));
}

// Mutation-checked: deckView.ts buildAll — `unclaimed` filtered to [] so no place ever becomes a local card; the card never appears
test("a live session in an untracked directory is a local card", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = makeSandbox();
  const scratch = makeScratch(sb, "main");

  const launched = await launchHost(sb);
  app = launched.app;
  // The Electron main process is the live pid: `readOpenSessionsProbe` drops any
  // record whose pid `process.kill(pid, 0)` cannot see (sessions.ts), and this
  // one is alive for exactly as long as the host is. Seeded AFTER launch (the pid
  // does not exist before) and BEFORE the Deck opens, so the very first build —
  // fired by `deck:ready`, ahead of any 6s tick — already sees it.
  seedSession(sb, { pid: launched.app.process().pid!, cwd: scratch });
  const deck = await Deck.open(launched.page);

  // No run record exists anywhere in this sandbox, so the ONLY thing that can put
  // a card on this board is the session file above. The key slot of an untracked
  // card renders `keyLabel(run)` — "local" for kind "local" (webview/helpers.ts:260)
  // — and the title is the folder's name (`localFallbackName`, localRuns.ts).
  const card = deck.card("local");
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card).toContainText("scratch");
  await expect(deck.cards()).toHaveCount(1);
  await shot(launched.page, testInfo, "1 · a local card for the untracked scratch repo");
});

// Mutation-checked: DeckApp.tsx Card — `inferredKey` forced to "" (A loses PROJ-5641 and ~inferred); localRuns.ts inferTicket — project gate dropped, `[A-Z]+` in place of the project (B shows PROJ-5641)
test("a local card on a ticket-shaped branch shows an inferred key only when a Jira project is set", async ({}, testInfo) => {
  test.setTimeout(240_000);

  // A — a Jira project is set. `agentFlow.jira.baseUrl` is set too, and to the
  // FIXTURE host: `inferTicket` builds the ticket url off it, and the chip only
  // renders once the connector's own `keyFromUrl` recognises that url
  // (deckView.ts `ticketKeyPatch` → types.ts `ticketKeyFor`). The fixture connector
  // parses `https://fixture.invalid/browse/<key>` (src/tasks/fixture/connector.ts),
  // exactly as the Jira connector parses its own site — same pairing
  // sign-in.e2e.ts uses. With the default empty baseUrl the url would be a bare
  // `/browse/PROJ-5641`, which names no site and no connector could claim.
  sb = makeSandbox({ "agentFlow.jira.project": "PROJ", "agentFlow.jira.baseUrl": "https://fixture.invalid" });
  const scratchA = makeScratch(sb, "PROJ-5641-team-table");
  let launched = await launchHost(sb);
  app = launched.app;
  seedSession(sb, { pid: launched.app.process().pid!, cwd: scratchA });
  let deck = await Deck.open(launched.page);

  // With a ticket inferred, the key slot is a `button.key` reading the key and a
  // `~inferred` chip beside it; the title gains a `local` chip (DeckApp.tsx:429-442
  // on 2026-09-03). The summary is the branch's own tail, "team table" — never
  // fetched (localRuns.ts `inferTicket`).
  const cardA = deck.card("PROJ-5641");
  await expect(cardA).toBeVisible({ timeout: 60_000 });
  await expect(cardA.locator("button.key")).toHaveText("PROJ-5641");
  await expect(cardA.locator(".chip", { hasText: "~inferred" })).toBeVisible();
  await expect(cardA).toContainText("local");
  await expect(cardA).toContainText("team table");
  await shot(launched.page, testInfo, "2 · A: PROJ-5641 inferred from the branch");

  await app.close();
  app = undefined;
  sb.dispose();

  // B — no project. Same branch, same session shape; `inferTicket` returns null on
  // an empty project (CONNECTORS § 7), so the card is a plain local card named
  // after its folder, with no key and no chip.
  sb = makeSandbox({ "agentFlow.jira.project": "", "agentFlow.jira.baseUrl": "https://fixture.invalid" });
  const scratchB = makeScratch(sb, "PROJ-5641-team-table");
  launched = await launchHost(sb);
  app = launched.app;
  seedSession(sb, { pid: launched.app.process().pid!, cwd: scratchB });
  deck = await Deck.open(launched.page);

  const cardB = deck.card("local");
  await expect(cardB).toBeVisible({ timeout: 60_000 });
  await expect(cardB).toContainText("scratch");
  await expect(cardB).not.toContainText("PROJ-5641");
  await expect(cardB.locator(".chip", { hasText: "~inferred" })).toHaveCount(0);
  await expect(cardB.locator("button.key")).toHaveCount(0);
  await shot(launched.page, testInfo, "3 · B: no project, no key");
});

// Mutation-checked: deckView.ts track — the `writeRun(defaultRunsDir(), run)` call removed; no record ever lands
test("Track it pins a local card to the runs store", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = makeSandbox();
  const scratch = makeScratch(sb, "main");
  expect(readRunFiles(sb)).toHaveLength(0);

  const launched = await launchHost(sb);
  app = launched.app;
  seedSession(sb, { pid: launched.app.process().pid!, cwd: scratch });
  const deck = await Deck.open(launched.page);

  const card = deck.card("local");
  await expect(card).toBeVisible({ timeout: 60_000 });
  await card.click();
  // Track it is the local card's "Record" action — the same slot Forget takes on
  // a tracked card — and lives behind the drawer's `More` disclosure
  // (DeckDetail.tsx:336-339, :633 on 2026-09-03), closed by default. The button's
  // accessible name is its explicit aria-label, "Track it", so the hint text
  // ("give this place a ticket") does not fold into it.
  await deck.openMore();
  await shot(launched.page, testInfo, "4 · Track it in the drawer");
  await deck.detail().getByRole("button", { name: "Track it", exact: true }).click();

  // The assertion of record is the durable file, not the card: `track`
  // (deckView.ts) writes the synthetic run it already built to `~/.agentflow/runs`
  // and only then drops it from the in-memory local map. The scratch repo is the
  // record's one repo. No ticket was inferred (no project), so the key stays the
  // place hash and the kind becomes "explore" — the record is read back as a
  // launched run from here on, which is what "behaves like a task you took" means.
  const s = sb;
  await expect
    .poll(() => readRunFiles(s).filter((r) => fs.realpathSync(r.run.repos[0].path) === scratch).length, { timeout: 60_000 })
    .toBe(1);
  const [tracked] = readRunFiles(s).filter((r) => fs.realpathSync(r.run.repos[0].path) === scratch);
  expect(tracked.run.kind).toBe("explore");
  expect(tracked.run.key).toMatch(/^local-scratch-/);
  // …Forget included: the drawer is still open on the same key, and once the
  // rebuild lands the Record slot flips from Track it to Forget.
  await expect(deck.detail().getByRole("button", { name: "Forget", exact: true })).toBeVisible({ timeout: 30_000 });
  await shot(launched.page, testInfo, "5 · tracked — Forget takes the slot");
});

// Mutation-checked: deckView.ts onConfigChanged — the `agentFlow.openAgents` branch removed; the card stays
test("openAgents off removes local cards without reopening the panel", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = makeSandbox();
  const scratch = makeScratch(sb, "main");

  const launched = await launchHost(sb);
  app = launched.app;
  seedSession(sb, { pid: launched.app.process().pid!, cwd: scratch });
  const deck = await Deck.open(launched.page);
  await expect(deck.card("local")).toBeVisible({ timeout: 60_000 });
  await shot(launched.page, testInfo, "6 · local card before the flip");

  // Flip the setting the way a person does — by saving settings.json. The
  // workbench watches the user settings file and raises
  // `onDidChangeConfiguration`; `DeckPanel` re-seeds `openAgents` from it and
  // rebuilds (deckView.ts `onConfigChanged`). The panel is never closed or
  // reopened here — `deck` is the same frame throughout, which is the doc's claim.
  const settingsPath = path.join(sb.userDataDir, "User", "settings.json");
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  settings["agentFlow.openAgents"] = false;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  // Nothing else in this sandbox can render a card, so zero is the whole board.
  await expect(deck.cards()).toHaveCount(0, { timeout: 30_000 });
  // The session file is untouched — hidden, not gone: the retire sweep still
  // reads it (buildAll reads sessions unconditionally; only the display is gated).
  expect(fs.readdirSync(path.join(sb.home, ".claude", "sessions"))).toHaveLength(1);
  await shot(launched.page, testInfo, "7 · openAgents off — board empty, panel never reopened");
});

// Mutation-checked: paths.ts pidAlive — returns true for a dead pid; the card never leaves
test("a local card disappears when its last session dies", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = makeSandbox();
  const scratch = makeScratch(sb, "main");

  // A process that is not the host: the host's own pid dies only when the test
  // ends. `sleep 600` has no side effects and is killed below (and in afterEach
  // if the test fails first).
  child = spawn("sleep", ["600"], { stdio: "ignore" });
  const pid = child.pid!;
  seedSession(sb, { pid, cwd: scratch });

  const launched = await launchHost(sb);
  app = launched.app;
  const deck = await Deck.open(launched.page);
  await expect(deck.card("local")).toBeVisible({ timeout: 60_000 });
  await shot(launched.page, testInfo, "8 · the card while its session lives");

  // Wait for the exit event, not just the kill: until libuv reaps the child it is
  // a zombie that `kill(pid, 0)` still answers for, and the reader would keep the
  // record (sessions.ts → paths.ts `pidAlive`).
  const exited = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
  child.kill();
  await exited;
  child = undefined;

  // The session file is still on disk — Claude Code owns that directory and the
  // Deck never prunes it (sessions.ts). Only the dead pid takes the card off.
  expect(fs.readdirSync(path.join(sb.home, ".claude", "sessions"))).toHaveLength(1);
  await expect(deck.cards()).toHaveCount(0, { timeout: 30_000 });
  await shot(launched.page, testInfo, "9 · gone with its session");
});
