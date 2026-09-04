import { test, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { makeSandbox, type Sandbox } from "./_helpers/sandbox";
import { launchHost } from "./_helpers/host";
import { Deck } from "./_helpers/po/deck";
import {
  expectNoUnknownForgeCalls, forgeCalls, ghAuthStatusAnswer, ghPrListAnswer, ghPrViewAnswer,
  ghReviewRequestsAnswer, glabMrGetAnswer, glabMrListAnswer, glabPipelineId, installForgeShims,
  type ForgeAnswers,
} from "./_helpers/forgeShim";
import { shot } from "./_helpers/shot";

let sb: Sandbox;
let app: ElectronApplication | undefined;
let unknownLog: string;

const KEY = "E2E-1";
/** The branch every checkout in this file sits on. `prEligible` (src/engine/git.ts:205-209)
 *  fetches PR facts only for a repo whose `branch` differs from the default the
 *  fabricated `origin/HEAD` names, so this must not be `main`. */
const BRANCH = "E2E-1-fix-the-rocket-telemetry-panel";
const FP = "projects/:fullpath"; // glab's own placeholder; the shim sees it literally

/** A git checkout the Deck will read PR facts for: one commit, an `origin` remote
 *  (never contacted — every forge call resolves to the shim; the forge CLI reads
 *  the project off it), `origin/HEAD` for `defaultBranch()`, and HEAD on BRANCH.
 *  Same two fabrications `deck-github.e2e.ts` makes, applied to any directory so a
 *  card can own two of them. */
function prepareRepo(dir: string, remote: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const git = (args: string[]) =>
    execFileSync("git", ["-c", "user.email=e2e@fixture.invalid", "-c", "user.name=E2E", ...args], { cwd: dir, encoding: "utf8" });
  if (!fs.existsSync(path.join(dir, ".git"))) {
    git(["init", "-q"]);
    fs.writeFileSync(path.join(dir, "README.md"), `# ${path.basename(dir)}\n`);
    git(["add", "."]);
    git(["commit", "-qm", "init"]);
  }
  git(["remote", "add", "origin", remote]);
  const sha = git(["rev-parse", "HEAD"]).trim();
  git(["update-ref", "refs/remotes/origin/main", sha]);
  git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  git(["checkout", "-qb", BRANCH]);
}

/** Write the run record straight into the store — HOME is the sandbox, so this is
 *  the path the extension itself writes (`deck-lifecycle.e2e.ts` does the same).
 *  `createdAt: now` keeps the run on the live shelf (`JUST_LAUNCHED_MS`) so it
 *  renders as a `.card`; the key is a fixture task so `ticketStatus` resolves. */
function seedRun(sb: Sandbox, repos: { name: string; path: string }[]): void {
  const dir = path.join(sb.home, ".agentflow", "runs");
  fs.mkdirSync(dir, { recursive: true });
  const run = {
    key: KEY, summary: "Fix the rocket telemetry panel", url: `https://fixture.invalid/browse/${KEY}`,
    createdAt: Date.now(), kind: "task", mode: repos.length > 1 ? "multiroot" : "per-window",
    repos: repos.map((r) => ({ ...r, isGit: true, branch: BRANCH })),
    briefPaths: [],
  };
  fs.writeFileSync(path.join(dir, `${KEY}.json`), JSON.stringify(run, null, 2) + "\n");
}

/** The gh answers a ready PR needs. `isMergeReady` (src/engine/bucket.ts:255-265)
 *  wants approved + green + `unresolved === 0` + clean: `ghPrListAnswer` is that PR
 *  (#41), and the threads count comes from a SEPARATE `gh api graphql` call
 *  (`GhProvider.unresolved`, provider.ts:163-176) — left unanswered it reads as
 *  `null`, which withholds the button. `ghReviewRequestsAnswer(…, {unresolved: 0})`
 *  folds a zero-thread body into the review search that shares the signature. */
function ghAnswers(extra: Record<string, unknown> = {}): ForgeAnswers {
  return {
    gh: {
      "pr list": ghPrListAnswer(BRANCH),
      "api graphql": ghReviewRequestsAnswer([], { unresolved: 0 }),
      "auth status": ghAuthStatusAnswer(["octo"]),
      // A merge that succeeds: gh prints nothing useful and exits 0.
      "pr merge": { body: "" },
      ...extra,
    },
  };
}

/** The glab answers a ready MR needs, mirroring `deck-gitlab.e2e.ts`: the list row
 *  (no pipeline), the single-MR GET (the only route with `head_pipeline`), its
 *  jobs, an approval, and no open discussions. */
function glabAnswers(): ForgeAnswers {
  return {
    glab: {
      "auth status": "{}",
      "api merge_requests?scope=reviews_for_me&state=opened&per_page=50": JSON.stringify([]),
      [`api ${FP}/merge_requests?source_branch=${BRANCH}&state=all&per_page=10`]: glabMrListAnswer(BRANCH),
      [`api ${FP}/merge_requests/7`]: glabMrGetAnswer(7, { branch: BRANCH }),
      [`api ${FP}/pipelines/${glabPipelineId(7)}/jobs?per_page=100`]: [{ name: "ci", status: "success", allow_failure: false }],
      [`api ${FP}/merge_requests/7/approvals`]: { approved: true },
      [`api ${FP}/merge_requests/7/discussions?per_page=100`]: [],
    },
  };
}

/** One host per test: the settings under test differ per row, and a merge is a
 *  write the next test must not inherit. `window.dialogStyle: "custom"` renders the
 *  modal `showWarningMessage` as workbench DOM (`.monaco-dialog-box`) on the
 *  top-level page instead of a native sheet Playwright cannot click. */
async function boot(
  settings: Record<string, unknown>,
  answers: ForgeAnswers,
  repos: string[] = ["rocket"],
  remote = "https://github.com/oznasi1/",
): Promise<{ page: Page; deck: Deck; card: Locator }> {
  sb = makeSandbox({ "agentFlow.prFacts": true, "window.dialogStyle": "custom", ...settings });
  const seeded = repos.map((name) => {
    const dir = path.join(sb.reposRoot, name);
    prepareRepo(dir, `${remote}${name}.git`);
    return { name, path: dir };
  });
  seedRun(sb, seeded);
  ({ unknownLog } = installForgeShims(sb, answers));
  const launched = await launchHost(sb);
  app = launched.app;
  const deck = await Deck.open(launched.page);
  const card = deck.card(KEY);
  await expect(card).toBeVisible({ timeout: 60_000 });
  return { page: launched.page, deck, card };
}

/** The card's Merge button — `<button className="act">Merge</button>` inside the
 *  merge row (DeckApp.tsx:476-488 on 2026-09-03). Anchored to the exact text: the
 *  problem rows' `.act` buttons read `Fix CI` / `Address review` / …, and the
 *  drawer has its own buttons. */
function mergeButton(card: Locator): Locator {
  return card.locator("button.act", { hasText: /^Merge$/ });
}

/** The modal confirmation — workbench chrome on the top-level page, outside every
 *  `iframe.webview` (deckView.ts:3325-3331 on 2026-09-03: `showWarningMessage(
 *  \`${label} ${repo}#${number}?\`, { modal: true, detail }, label)`). */
function dialog(page: Page): Locator {
  return page.locator(".monaco-dialog-box");
}

/** Every `gh pr merge` / `glab api …/merge` the shim received. */
function mergeCalls(): string[][] {
  return forgeCalls(sb)
    .filter((c) => (c.cli === "gh" && c.argv[0] === "pr" && c.argv[1] === "merge") || (c.cli === "glab" && /\/merge$/.test(c.argv[1] ?? "")))
    .map((c) => c.argv);
}

/** The Agent Flow Deck output channel's text. VS Code backs every extension output
 *  channel with a file under the session's log directory
 *  (`<user-data-dir>/logs/<session>/exthost…/output_logging_…/N-Agent Flow Deck.log`),
 *  which is the durable record the PRIVACY doc points at — read as a file, the
 *  first choice of assertion, rather than scraped out of the Output panel's
 *  editor. Empty until the channel has been written to. */
function outputChannelText(): string {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      const p = path.join(dir, n);
      let st: fs.Stats;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (n.endsWith("Agent Flow Deck.log")) hits.push(p);
    }
  };
  walk(path.join(sb.userDataDir, "logs"));
  return hits.map((p) => fs.readFileSync(p, "utf8")).join("\n");
}

test.afterEach(async () => {
  await app?.close();
  app = undefined;
  if (fs.existsSync(unknownLog)) console.log("FORGE UNKNOWN ARGV:\n" + fs.readFileSync(unknownLog, "utf8"));
  const calls = unknownLog.replace("unknown.jsonl", "calls.jsonl");
  console.log(fs.existsSync(calls) ? "FORGE CALLS:\n" + fs.readFileSync(calls, "utf8") : "FORGE CALLS: none");
  try {
    expectNoUnknownForgeCalls(sb);
  } finally {
    sb.dispose();
  }
});

// Mutation-checked: DeckApp.tsx's `const merge = local || !mergeWrites ? null : cardMerge(r)` → `local ? null : cardMerge(r)`; the button rendered with the setting off and this failed on toHaveCount(0).
test("mergeWrites off shows no Merge button on a ready PR", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const { page, card } = await boot({}, ghAnswers());
  // The facts must have LANDED before the negative means anything: `#41` is the
  // signal line's lead bit (cardSignal), rendered only once the forge answered.
  await expect(card.getByText("#41", { exact: true }).first()).toBeVisible({ timeout: 90_000 });
  await shot(page, testInfo, "1 · ready PR, mergeWrites off");
  await expect(mergeButton(card)).toHaveCount(0);
});

// Mutation-checked: mergePr's modal `showWarningMessage` await replaced with `const answer = label`, so the merge runs unconfirmed; the dialog never appeared and this failed. That break is sabotage/deck-merge.patch.
test("Merge confirms with the repo, number and strategy, then runs gh pr merge", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const { page, card } = await boot({ "agentFlow.mergeWrites": true }, ghAnswers());
  const button = mergeButton(card);
  await expect(button).toBeVisible({ timeout: 90_000 });
  await shot(page, testInfo, "2 · ready card with Merge");
  await button.click();

  const box = dialog(page);
  await expect(box).toBeVisible({ timeout: 15_000 });
  // `Squash and merge rocket#41?` — repo, number, and the strategy by name, before
  // anything reaches the forge.
  await expect(box).toContainText("rocket");
  await expect(box).toContainText("#41");
  await expect(box).toContainText(/squash/i);
  expect(mergeCalls()).toEqual([]);
  await shot(page, testInfo, "3 · the confirmation names repo, number and strategy");

  await box.getByRole("button", { name: "Squash and merge" }).click();
  await expect.poll(() => mergeCalls(), { timeout: 30_000 }).toEqual([["pr", "merge", "41", "--squash"]]);
  // The attempt is logged to the output channel — the strategy by its setting value.
  await expect.poll(() => outputChannelText(), { timeout: 30_000 }).toContain("deck: merging rocket#41 with squash");
  await shot(page, testInfo, "4 · merged through gh");
});

// Mutation-checked: mergePr's `if (answer !== label)` → `if (false)` (deckView.ts:3333 — NOT the identically-worded review-submit guard 175 lines above), so Cancel merged anyway; caught first at the button-release wait below, since an "ok" outcome deliberately leaves the row disabled.
test("cancelling the merge dialog runs nothing", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const { page, card } = await boot({ "agentFlow.mergeWrites": true }, ghAnswers());
  const button = mergeButton(card);
  await expect(button).toBeVisible({ timeout: 90_000 });
  await button.click();
  const box = dialog(page);
  await expect(box).toBeVisible({ timeout: 15_000 });
  await shot(page, testInfo, "5 · about to cancel");
  await box.getByRole("button", { name: "Cancel" }).click();
  await expect(box).toBeHidden({ timeout: 15_000 });
  // The button disables on click and is released only by the host's
  // `deck:mergeDone` (DeckApp.tsx:722-733) — so "enabled again" proves the host
  // finished handling the cancel, and the empty call log below is not a race.
  await expect(button).toBeEnabled({ timeout: 15_000 });
  expect(mergeCalls()).toEqual([]);
  await shot(page, testInfo, "6 · cancelled, nothing ran");
});

// Mutation-checked: MERGE_FLAG's `rebase: "--rebase"` → `"--squash"` (engine/pr/provider.ts), so the dialog said rebase and gh got squash; this failed on the argv.
test("mergeMethod is named in the dialog and passed to gh", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const { page, card } = await boot({ "agentFlow.mergeWrites": true, "agentFlow.mergeMethod": "rebase" }, ghAnswers());
  const button = mergeButton(card);
  await expect(button).toBeVisible({ timeout: 90_000 });
  await button.click();
  const box = dialog(page);
  await expect(box).toBeVisible({ timeout: 15_000 });
  await expect(box).toContainText(/rebase/i);
  await shot(page, testInfo, "7 · the dialog names rebase");
  await box.getByRole("button", { name: "Rebase and merge" }).click();
  await expect.poll(() => mergeCalls(), { timeout: 30_000 }).toEqual([["pr", "merge", "41", "--rebase"]]);
});

// Mutation-checked: BOTH of mergeTarget's plurality refusals dropped — `ready.length !== 1`
// and the `rest.every(… === "MERGED")` line replaced by `if (ready.length === 0) return null`
// and picking `ready[0]`. One alone cannot be checked here and that is a fact about the
// product, not a weakening: a second READY PR is by definition OPEN, so it trips the
// already-merged rule too, and no two-ready card can isolate the count rule. The
// sibling-open test below mutates the merged rule on its own.
// Under the mutation the Merge button appeared and this failed on toHaveCount(0).
test("two ready PRs across repos show no Merge button", async ({}, testInfo) => {
  test.setTimeout(240_000);
  // The shim keys on argv, and both checkouts ask `gh pr list --head <branch>` —
  // so one `pr list` answer gives BOTH repos the same ready #41.
  const { page, deck, card } = await boot({ "agentFlow.mergeWrites": true }, ghAnswers(), ["rocket", "telemetry"]);
  await expect(card.getByText("#41", { exact: true }).first()).toBeVisible({ timeout: 90_000 });
  // Both repos' facts landed: the drawer's Pull requests section lists one block
  // per repo with facts (DeckDetail.tsx:603), naming the repo when there are two.
  await card.click();
  const blocks = deck.detail().locator(".pr-block");
  await expect(blocks).toHaveCount(2, { timeout: 30_000 });
  await expect(blocks.locator(".pr-repo")).toHaveText(["rocket", "telemetry"]);
  await shot(page, testInfo, "8 · two ready PRs, no Merge");
  await expect(mergeButton(card)).toHaveCount(0);
});

// Mutation-checked: mergeTarget's `rest.every((x) => !x.failed && x.facts.state === "MERGED")` → `rest.every(() => true)` (bucket.ts), so rocket#41 became the target with telemetry#52 still open; the button appeared and this failed.
test("a sibling repo still holding an open PR blocks Merge", async ({}, testInfo) => {
  test.setTimeout(240_000);
  // rocket keeps the ready #41; telemetry's `pr list` answers an open #52 that
  // nobody has approved — the per-checkout answer (`splitCwdKey`).
  const sibling = ghPrViewAnswer({ number: 52, passing: 1, decision: "REVIEW_REQUIRED", branch: BRANCH, title: "Repoint the telemetry feed" });
  const { page, deck, card } = await boot(
    { "agentFlow.mergeWrites": true },
    ghAnswers({ "pr list @telemetry": [sibling] }),
    ["rocket", "telemetry"],
  );
  await expect(card.getByText(/#(41|52)/).first()).toBeVisible({ timeout: 90_000 });
  await card.click();
  const blocks = deck.detail().locator(".pr-block");
  await expect(blocks).toHaveCount(2, { timeout: 30_000 });
  await expect(blocks.filter({ hasText: "rocket" })).toContainText("#41");
  await expect(blocks.filter({ hasText: "telemetry" })).toContainText("#52");
  await shot(page, testInfo, "9 · sibling PR still open, no Merge");
  await expect(mergeButton(card)).toHaveCount(0);
});

// Mutation-checked: GlabProvider.merge's `if (method === "rebase")` → `if (false)`, which drops through to the "Unknown merge method: rebase" message — a refusal that names no setting; this failed on the toast.
test("GitLab refuses a rebase merge naming the setting", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const { page, deck, card } = await boot(
    { "agentFlow.forge": "gitlab", "agentFlow.mergeWrites": true, "agentFlow.mergeMethod": "rebase" },
    glabAnswers(),
    ["rocket"],
    "https://gitlab.com/oz/",
  );
  const button = mergeButton(card);
  await expect(button).toBeVisible({ timeout: 90_000 });
  await button.click();
  const box = dialog(page);
  await expect(box).toBeVisible({ timeout: 15_000 });
  await expect(box).toContainText(/rebase/i);
  await shot(page, testInfo, "10 · GitLab, rebase requested");
  await box.getByRole("button", { name: "Rebase and merge" }).click();
  // Refused in words, naming the setting — by the product itself, before any CLI
  // call (glab/provider.ts:216-223). The toast is the Deck's own (DeckApp.tsx:1408).
  const toast = deck.frame.locator(".toast.error");
  await expect(toast).toContainText("agentFlow.mergeMethod", { timeout: 15_000 });
  await shot(page, testInfo, "11 · refused, naming agentFlow.mergeMethod");
  await expect.poll(() => outputChannelText(), { timeout: 30_000 }).toContain("deck: merge failed: GitLab has no per-request rebase merge");
  // Never substituted: no `PUT …/merge` reached glab.
  expect(mergeCalls()).toEqual([]);
});

// Mutation-checked: GhProvider.merge's failure return → a constant `"the merge did not go through"` instead of `err.stderr?.trim() || …`, so gh's own wording reached neither surface; this failed on the toast, and the output-channel line lost it too.
test("a merge failure reaches the user and the output channel", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const { page, deck, card } = await boot(
    { "agentFlow.mergeWrites": true },
    ghAnswers({ "pr merge": { body: "", exit: 1, stderr: "Pull request is not mergeable" } }),
  );
  const button = mergeButton(card);
  await expect(button).toBeVisible({ timeout: 90_000 });
  await button.click();
  const box = dialog(page);
  await expect(box).toBeVisible({ timeout: 15_000 });
  await box.getByRole("button", { name: "Squash and merge" }).click();
  // The forge's own stderr, surfaced as an error toast (deckView.ts:3348-3354).
  const toast = deck.frame.locator(".toast.error");
  await expect(toast).toContainText("Pull request is not mergeable", { timeout: 15_000 });
  await shot(page, testInfo, "12 · the failure toast");
  await expect.poll(() => mergeCalls(), { timeout: 30_000 }).toEqual([["pr", "merge", "41", "--squash"]]);
  await expect.poll(() => outputChannelText(), { timeout: 30_000 }).toContain("deck: merge failed: Pull request is not mergeable");
});
