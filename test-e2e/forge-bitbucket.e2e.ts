import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { makeSandbox, type Sandbox } from "./_helpers/sandbox";
import { launchHost } from "./_helpers/host";
import { Deck } from "./_helpers/po/deck";
import {
  bbHelpAnswer, expectNoUnknownForgeCalls, forgeCalls, installForgeShims, type ForgeAnswerMap,
} from "./_helpers/forgeShim";
import { shot } from "./_helpers/shot";

/** The Bitbucket forge, in a real host — the only forge whose capability set is
 *  decided by which build of its CLI is installed (docs/FORGES.md § "Bitbucket
 *  has two modes"). Every `atlassian-cli` call resolves to the shim, so the two
 *  modes are chosen by ONE answer here — `bb api --help`, exit 0 for passthrough
 *  and clap's exit 2 for projected — exactly as `probeBbApi` reads them
 *  (src/engine/pr/bb/provider.ts:66-72).
 *
 *  Per test, not a shared host: that probe is memoized for a panel's whole life
 *  (`once`, src/engine/forge/bitbucket.ts:16-19), so a test that needs the other
 *  mode needs either its own host or its own panel — and Doctor resolves a fresh
 *  `Forge` per run (doctorView.ts:387-391), which is why the two Doctor rows can
 *  each own a host without contorting anything. */

let sb: Sandbox;
let app: ElectronApplication | undefined;
let unknownLog: string;

const KEY = "E2E-1";
/** The branch a take's worktree lands on. `prEligible` (src/engine/git.ts:205-209)
 *  only fetches for a branch that DIFFERS from the default `origin/HEAD` names, so
 *  this must not be `main`. */
const BRANCH = "E2E-1-fix-the-rocket-telemetry-panel";
/** Bitbucket's two coordinates, which the forge reads off the git remote rather
 *  than off any path (`parseBitbucketRemote`, src/engine/pr/bb/pr.ts:31-53) — the
 *  host check there is load-bearing, so the remote must really be bitbucket.org. */
const WS = "oz";
const SLUG = "rocket";
const PR = 7;

const restBase = `/2.0/repositories/${WS}/${SLUG}/pullrequests`;
/** The two `?q=` searches passthrough mode issues, in the order `fetchRest` makes
 *  them (src/engine/pr/bb/provider.ts:269-277): the live branch first, then the
 *  ticket key in the title. The interpolated value is url-encoded by the product;
 *  neither of these carries a character that changes under encoding, so the key
 *  reads as the argv does. */
const branchSearch = `${restBase}?q=source.branch.name="${BRANCH}"&state=OPEN&pagelen=10`;
const keySearch = `${restBase}?q=title~"${KEY}"&state=OPEN&pagelen=10`;

/** The `atlassian-cli` answers shared by every test here: the sign-in probe
 *  (`auth test --bitbucket`, provider.ts:47-58 — only the exit code is read) and
 *  the mode probe. A key's signature drops leading `--flag value` pairs, so
 *  `--workspace oz bb pr list rocket …` keys on `bb pr list` (see `signatureOf`). */
function bbAnswers(mode: "passthrough" | "projected", extra: ForgeAnswerMap = {}): ForgeAnswerMap {
  return {
    "auth test --bitbucket": "{}",
    "bb api --help": bbHelpAnswer(mode),
    ...extra,
  };
}

/** A git checkout the Deck reads PR facts for: one commit, a real bitbucket.org
 *  `origin` (never contacted — every CLI call resolves to the shim), `origin/HEAD`
 *  for `defaultBranch()`, and HEAD on BRANCH. Same two fabrications
 *  `deck-github.e2e.ts` and `deck-merge.e2e.ts` make. */
function prepareRepo(dir: string): void {
  const git = (args: string[]): string =>
    execFileSync("git", ["-c", "user.email=e2e@fixture.invalid", "-c", "user.name=E2E", ...args], {
      cwd: dir, encoding: "utf8",
    });
  git(["remote", "add", "origin", `https://bitbucket.org/${WS}/${SLUG}.git`]);
  const sha = git(["rev-parse", "HEAD"]).trim();
  git(["update-ref", "refs/remotes/origin/main", sha]);
  git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  git(["checkout", "-qb", BRANCH]);
}

/** Write the run record straight into the store — HOME is the sandbox, so this is
 *  the file the extension itself writes (`deck-lifecycle.e2e.ts`, `deck-merge.e2e.ts`).
 *  `createdAt: Date.now()` is what keeps the run on the live shelf, so it renders
 *  as a `.card` rather than a Recently-closed row. */
function seedRun(sandbox: Sandbox): void {
  const dir = path.join(sandbox.home, ".agentflow", "runs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${KEY}.json`),
    JSON.stringify({
      key: KEY, summary: "Fix the rocket telemetry panel", url: `https://fixture.invalid/browse/${KEY}`,
      createdAt: Date.now(), kind: "task", mode: "per-window",
      repos: [{ name: SLUG, path: sandbox.repoPath, isGit: true, branch: BRANCH }],
      briefPaths: [],
    }, null, 2) + "\n",
  );
}

const prFactsDir = (sandbox: Sandbox): string => path.join(sandbox.home, ".agentflow", "prfacts");

/** The derived PR-fact cache for this run (`defaultPrFactsDir`, pr/store.ts:8-10).
 *  Seeding it is not a seam: the file IS the store, and the Deck reads it back
 *  unconditionally while `prFacts` is on (deckView.ts:3573). */
function seedPrEntry(sandbox: Sandbox, facts: Record<string, unknown>): void {
  const dir = prFactsDir(sandbox);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${KEY}.json`),
    JSON.stringify({ [SLUG]: { fetchedAt: Date.now(), facts } }, null, 2) + "\n",
  );
}

/** Every `atlassian-cli` invocation the shim received, argv by argv. */
function bbCalls(): string[][] {
  return forgeCalls(sb).filter((c) => c.cli === "atlassian-cli").map((c) => c.argv);
}

/** The workbench's QuickPick — top-level page chrome, never inside a webview. */
function quickPick(page: Page): { widget: Locator; rows: Locator } {
  const widget = page.locator(".quick-input-widget");
  return { widget, rows: widget.locator(".quick-input-list .monaco-list-row") };
}

/** Run Doctor and hand back its own QuickPick, resolved by the title
 *  `showDoctor` gives it (`Agent Flow Deck Doctor — <summary>`,
 *  doctorView.ts:277-281). Not `runCommand`: that helper asserts the palette
 *  HIDES after Enter, and Doctor re-opens the same widget with its report a beat
 *  later, so the two race. Waiting for Doctor's own title instead is what tells
 *  the palette and the report apart. */
async function openDoctor(page: Page): Promise<Locator> {
  await expect(page.locator('.activitybar [aria-label*="Agent Flow"]').first()).toBeVisible({ timeout: 60_000 });
  const { widget, rows } = quickPick(page);
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await expect(widget).toBeVisible({ timeout: 15_000 });
  await page.keyboard.type("Agent Flow: Doctor");
  await expect(rows.first()).toContainText("Doctor", { timeout: 15_000 });
  await page.keyboard.press("Enter");
  await expect(widget).toContainText("Agent Flow Deck Doctor", { timeout: 60_000 });
  return widget;
}

/** Doctor's row for the forge CLI. `buildItems` (doctorView.ts:225-238) renders
 *  each check as `<icon> <label>` with `c.detail` as the description, and the
 *  forge's mode is appended to that detail (`signed in — <where> — <mode>`,
 *  engine/doctor.ts:324-334) rather than being a row of its own — so this is the
 *  row the mode is reported on.
 *
 *  Reached by TYPING the label into Doctor's own filter box, not by scrolling to
 *  it: the report is a `monaco-list`, which renders only the rows currently in
 *  view — a dozen checks in, the forge row is not in the DOM at all, and a bare
 *  `.filter({ hasText })` resolves to zero elements whatever the row says. The
 *  filter matches on the item LABEL, which is exactly `c.label` (the CLI's own
 *  name), so this narrows to the one row and leaves its description — where the
 *  mode is — intact. */
async function doctorRow(page: Page, widget: Locator, label: string): Promise<Locator> {
  await page.keyboard.type(label);
  const row = widget.locator(".quick-input-list .monaco-list-row").filter({ hasText: label });
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  return row;
}

function boot(settings: Record<string, unknown> = {}): Sandbox {
  return makeSandbox({
    "agentFlow.forge": "bitbucket",
    "agentFlow.prFacts": true,
    ...settings,
  });
}

test.afterEach(async () => {
  await app?.close();
  app = undefined;
  if (unknownLog && fs.existsSync(unknownLog)) {
    console.log("FORGE UNKNOWN ARGV:\n" + fs.readFileSync(unknownLog, "utf8"));
  }
  const calls = unknownLog?.replace("unknown.jsonl", "calls.jsonl");
  console.log(calls && fs.existsSync(calls) ? "FORGE CALLS:\n" + fs.readFileSync(calls, "utf8") : "FORGE CALLS: none");
  try {
    expectNoUnknownForgeCalls(sb);
  } finally {
    sb.dispose();
  }
});

// ── Doctor's mode row ─────────────────────────────────────────────────────────

// Mutation-checked: inverted probeBbApi's exit-code reading (src/engine/pr/bb/provider.ts:66-72)
// to `try { await run(...); return false } catch { return true }` — Doctor's row then read
// "projected (limited" and this failed. That break is sabotage/forge-bitbucket.patch.
test("Doctor names passthrough mode when bb api answers --help", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = boot();
  ({ unknownLog } = installForgeShims(sb, { "atlassian-cli": bbAnswers("passthrough") }));
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;

  const widget = await openDoctor(page);
  const row = await doctorRow(page, widget, "atlassian-cli");
  // `passthrough (full)` — FORGE_MODE_PASSTHROUGH (engine/doctor.ts:66), the
  // wording docs/FORGES.md quotes.
  await expect(row).toContainText("passthrough (full)");
  await expect(row).not.toContainText("projected");
  await shot(page, testInfo, "1 · Doctor reports passthrough mode");

  // The probe itself, on the argv: `bb api --help` and nothing else decides this.
  expect(bbCalls()).toContainEqual(["bb", "api", "--help"]);
  await page.keyboard.press("Escape");
});

// Mutation-checked: probeBbApi's `catch { return false }` → `catch { return true }`
// (src/engine/pr/bb/provider.ts:71) — the clap error then read as passthrough and
// this failed on the row text.
test("Doctor names projected mode on a clap error", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = boot();
  ({ unknownLog } = installForgeShims(sb, { "atlassian-cli": bbAnswers("projected") }));
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;

  const widget = await openDoctor(page);
  const row = await doctorRow(page, widget, "atlassian-cli");
  // `projected (limited — upgrade atlassian-cli for full support)` —
  // FORGE_MODE_PROJECTED (engine/doctor.ts:67). Matched on the prefix the plan
  // names, so the em dash's rendering cannot decide the test.
  await expect(row).toContainText("projected (limited");
  // Still SIGNED IN: the mode row is a mode, not a failure — the same row carries
  // "signed in" and the check is `ok`, which is the whole point of reporting a
  // mode separately from a gap.
  await expect(row).toContainText("signed in");
  await shot(page, testInfo, "2 · Doctor reports projected mode");
  await page.keyboard.press("Escape");
});

// ── No review queue, in either mode ──────────────────────────────────────────

// Mutation-checked: `caps` and `resolveCaps` in src/engine/forge/bitbucket.ts both set
// `reviewSearch: true` — `BbReviewProvider.search()` returns null, so the strip rendered
// its "couldn't check" shape and `.rv-strip` was 1 in BOTH halves; this failed.
test("the review strip is hidden on Bitbucket in both modes", async ({}, testInfo) => {
  test.setTimeout(300_000);
  // `reviewRequests` and `reviewRequestsAlwaysVisible` both default to true, and
  // both are pinned here: with them on, an EMPTY queue still renders the strip
  // (postReviews' `alwaysVisible`, deckView.ts:2541), so the absence below cannot
  // be explained by "you owe nobody a review".
  sb = boot({ "agentFlow.reviewRequests": true, "agentFlow.reviewRequestsAlwaysVisible": true });
  prepareRepo(sb.repoPath);
  seedRun(sb);
  const answers = (mode: "passthrough" | "projected"): ForgeAnswerMap =>
    bbAnswers(mode, {
      // Projected mode's one list call, and passthrough's two searches. Empty
      // bodies: what this test needs from them is the CALL, not a PR.
      "bb pr list": [],
      [`bb api ${branchSearch}`]: { values: [] },
      [`bb api ${keySearch}`]: { values: [] },
    });
  ({ unknownLog } = installForgeShims(sb, { "atlassian-cli": answers("projected") }));
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;
  let deck = await Deck.open(page);
  await expect(deck.card(KEY)).toBeVisible({ timeout: 60_000 });

  // The positive control, and it is the whole reason this assertion is not
  // vacuous: `reviewsEnabled()` is `reviewQueue && forgeReady() && caps().reviewSearch`
  // (deckView.ts:2408-2410), and a PR FETCH happens only `if (forgeReady && !prLess)`
  // (deckView.ts:3596). So a `bb pr list` in the log proves the setting is on and
  // the probe settled healthy — leaving `caps().reviewSearch` as the only thing
  // the missing strip can be attributed to.
  await expect.poll(() => bbCalls().some((a) => a.join(" ").includes("bb pr list")), { timeout: 90_000 }).toBe(true);
  await expect(deck.reviewStrip()).toHaveCount(0);
  await expect(deck.reviews()).toHaveCount(0);
  await shot(page, testInfo, "3 · projected mode: a live board, no review strip");

  // Now the OTHER mode. The mode probe is memoized per `Forge`, and a `Forge` is
  // built once per panel (deckView.ts:419-429), so a genuine re-probe needs a new
  // panel — `Deck.closeAll` disposes this one. The prfacts file goes with it: the
  // entry the projected pass just wrote is fresh, and a fresh entry is never
  // re-fetched (`isStale`, deckView.ts:3599), which would leave the second half
  // with no forge call to prove anything by. It is a derived cache, so deleting it
  // is what the product's own "disposable" comment on that directory describes.
  installForgeShims(sb, { "atlassian-cli": answers("passthrough") });
  fs.rmSync(path.join(prFactsDir(sb), `${KEY}.json`), { force: true });
  await Deck.closeAll(page);
  deck = await Deck.open(page);
  await expect(deck.card(KEY)).toBeVisible({ timeout: 60_000 });

  // The same control, in the mode's own vocabulary: a `bb api …/pullrequests?q=`
  // call can only come from a panel that probed passthrough AND found the forge
  // ready, so this one call proves both halves of the precondition.
  await expect.poll(() => bbCalls().some((a) => a[0] === "bb" && a[1] === "api" && a[2]?.includes("/pullrequests?q=")), {
    timeout: 90_000,
  }).toBe(true);
  await expect(deck.reviewStrip()).toHaveCount(0);
  await expect(deck.reviews()).toHaveCount(0);
  await shot(page, testInfo, "4 · passthrough mode: still no review strip");
});

// ── Projected mode's refusals and absences ───────────────────────────────────

// Mutation-checked: BbProvider.merge's `if (method === "rebase" && !passthrough)`
// (src/engine/pr/bb/provider.ts:369) → `if (false)`, which fell through to `bb pr merge
// … --strategy rebase_merge`; the argv assertion below found that call and this failed.
test("projected mode refuses a rebase merge before any CLI call", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = boot({
    "agentFlow.mergeWrites": true,
    "agentFlow.mergeMethod": "rebase",
    // `window.dialogStyle: "custom"` renders the modal `showWarningMessage` as
    // workbench DOM Playwright can click instead of a native sheet.
    "window.dialogStyle": "custom",
    // High enough that the seeded entry below is never re-fetched during the
    // test: a projected read would replace it, and the point here is the merge
    // path, not the read.
    "agentFlow.prFactsTtlSeconds": 100000,
  });
  prepareRepo(sb.repoPath);
  seedRun(sb);
  // A merge-ready entry, seeded rather than fetched. Projected mode CANNOT
  // produce one — it reports `review: "none"`, `mergeable: "unknown"` and
  // `unresolved: null` (toProjectedFacts, pr/bb/projected.ts:81-95), none of
  // which `isMergeReady` accepts (engine/bucket.ts:254-264) — so the only way a
  // real user reaches this refusal is exactly what is staged here: facts written
  // while a passthrough build was installed, still inside their TTL, read back by
  // a session whose CLI now has no `bb api`. The refusal is the claim under test;
  // the readiness is its precondition.
  seedPrEntry(sb, {
    number: PR, url: `https://bitbucket.org/${WS}/${SLUG}/pull-requests/${PR}`,
    title: "Fix the rocket telemetry panel", state: "OPEN", isDraft: false,
    ci: { passing: 1, pending: 0, failing: [] },
    review: "approved", unresolved: 0, mergeable: "clean", ciAdvisory: false,
  });
  ({ unknownLog } = installForgeShims(sb, { "atlassian-cli": bbAnswers("projected") }));
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;
  const deck = await Deck.open(page);
  const card = deck.card(KEY);
  await expect(card).toBeVisible({ timeout: 60_000 });

  const button = card.locator("button.act", { hasText: /^Merge$/ });
  await expect(button).toBeVisible({ timeout: 90_000 });
  await button.click();
  const dialog = page.locator(".monaco-dialog-box");
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(dialog).toContainText(/rebase/i);
  await shot(page, testInfo, "5 · rebase requested on a projected build");
  await dialog.getByRole("button", { name: "Rebase and merge" }).click();

  // Refused in words, by the product, naming the setting to change — the Deck's
  // own error toast (DeckApp.tsx:1408; the message is provider.ts:370-376).
  await expect(deck.toast("error")).toContainText("agentFlow.mergeMethod", { timeout: 15_000 });
  await shot(page, testInfo, "6 · refused, naming agentFlow.mergeMethod");
  // BEFORE any CLI call: the shim log holds the two probes and no merge verb.
  const merges = bbCalls().filter((a) => a.includes("merge"));
  expect(merges).toEqual([]);
});

// Mutation-checked: `mergeable: "unknown"` → `"clean"` in toProjectedFacts
// (src/engine/pr/bb/projected.ts:90) — the drawer's merge row then read "clean" and
// this failed. Re-checked with `isDraft: false` → `true` at :86, which rendered the
// `.rv`-style `draft` chip and failed the `.pr-draft` assertion, so neither half of
// this test is a constant.
test("a projected card shows branch CI and little else", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = boot();
  prepareRepo(sb.repoPath);
  seedRun(sb);
  ({ unknownLog } = installForgeShims(sb, {
    "atlassian-cli": bbAnswers("projected", {
      // `bb pr list --format json` emits exactly these fields and no others
      // (`BbProjectedPr`, pr/bb/projected.ts:14-21): no url, no draft flag, no
      // conflict state, no per-PR CI. `source` is what the branch selector
      // matches client-side (provider.ts:240-242).
      "bb pr list": [{ id: PR, title: `${KEY} Fix the rocket telemetry panel`, state: "OPEN", author: "octo", source: BRANCH, destination: "main" }],
      // The newest pipeline for that branch — the ONE fact projected mode can
      // report about CI (`projectedCi`, projected.ts:47-60; `SUCCESSFUL` is the
      // only string `gradeBbPipeline` reads as passed, pr.ts:89-91).
      "bb pipeline list": [{ build_number: 12, state: "SUCCESSFUL", ref_name: BRANCH }],
    }),
  }));
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;
  const deck = await Deck.open(page);
  const card = deck.card(KEY);
  await expect(card).toBeVisible({ timeout: 60_000 });

  // The card's signal line: the PR's number and the pipeline's verdict.
  await expect(card.getByText(`#${PR}`, { exact: true }).first()).toBeVisible({ timeout: 90_000 });
  await expect(card.locator(".c-sig")).toContainText("✓ ci");
  await shot(page, testInfo, "7 · the projected card");

  // The drawer's PR block is where every fact this mode cannot answer shows up as
  // an absence rather than a value (deckParts.tsx:16-63).
  await card.click();
  const block = deck.detail().locator(".pr-block");
  await expect(block).toHaveCount(1, { timeout: 30_000 });
  await expect(block).toContainText(`#${PR}`);
  await expect(block).toContainText("1 passing");
  // Mergeability: `unknown`, never clean or conflicting — the row is present (so
  // this is not a missing-element pass) and reads the absence out loud.
  await expect(block.locator(".pr-line", { hasText: "merge" })).toContainText("unknown");
  // Draft: the CLI projects no draft flag at all, so the chip must not be there.
  // The block's own presence above is the positive control for this count.
  await expect(block.locator(".pr-draft")).toHaveCount(0);
  // Approval: `none`, rendered as "pending" — and no unresolved-thread count,
  // which projected mode reports as null (`unresolved: null` → the `· N open`
  // trailer is not rendered, deckParts.tsx:46).
  await expect(block.locator(".pr-line", { hasText: "review" })).toContainText("pending");
  await expect(block).not.toContainText("open");
  await shot(page, testInfo, "8 · CI, and little else");
});
