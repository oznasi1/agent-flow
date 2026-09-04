import { test, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { makeSandbox, type Sandbox } from "./_helpers/sandbox";
import { launchHost } from "./_helpers/host";
import { Deck } from "./_helpers/po/deck";
import {
  expectNoUnknownForgeCalls, forgeCalls, ghAuthStatusAnswer, ghReviewRequestsAnswer,
  glabMrGetAnswer, glabMrListAnswer, glabPipelineId, installForgeShims, type ForgeAnswers,
} from "./_helpers/forgeShim";
import { shot } from "./_helpers/shot";

let sb: Sandbox;
let app: ElectronApplication | undefined;
let unknownLog: string;

/** The one PR asking for a review. `repo` carries the owner because every write
 *  argv does (`gh pr review <n> --repo <owner/name>`), and `repoName` — the half
 *  the dialog and the row show — is its last segment, which is also the name of
 *  the sandbox's single checkout. */
const REQ = {
  number: 41, repo: "oznasi1/rocket", title: "Fix the rocket telemetry panel",
  author: "octo", branch: "fix/telemetry",
};

/** What a session left in `.pick-task/REVIEW-41.md`. Multi-paragraph on purpose:
 *  the provenance line is appended after a blank line, and a one-line draft
 *  could not tell "the marker was appended" from "the body was replaced". */
const DRAFT = "The panel still reads the retired endpoint.\n\nTwo nits inline; neither blocks.";

/** The fixed line `reviewProvenance` appends (deckView.ts:136-137 on 2026-09-04),
 *  with the provider label `agentFlow.agentProvider`'s default resolves to
 *  (`providerLabel("claude-code")`, config.ts:215-217). Deliberately spelled out
 *  here rather than imported: importing it from `src/` would make the assertion
 *  agree with the product by construction. */
const PROVENANCE = "_Drafted with Claude Code via Agent Flow Deck._";

/** The gh answers the review strip needs, plus a `pr review` that succeeds
 *  silently — which is what gh does on a submitted review. `pr list` is answered
 *  even though nothing here should ask for it: an unanswered call is only visible
 *  as an `expectNoUnknownForgeCalls` failure at teardown, and answering it costs
 *  nothing while a card path nobody meant to exercise reaching for it would
 *  otherwise fail a test about something else entirely. */
function ghAnswers(extra: Record<string, unknown> = {}): ForgeAnswers {
  return {
    gh: {
      "api graphql": ghReviewRequestsAnswer([REQ]),
      "auth status": ghAuthStatusAnswer(["octo"]),
      // Row expansion (`GhReviewProvider.detail`) shells `pr view <n> --repo …
      // --json statusCheckRollup`; an empty rollup reads as "no checks", which
      // `mapRollup` renders as passing.
      "pr view": JSON.stringify({ statusCheckRollup: [] }),
      "pr list": JSON.stringify([]),
      "pr review": { body: "" },
      ...extra,
    },
  };
}

/** GitLab's project path, url-encoded exactly as `GlabReviewProvider`'s `enc`
 *  builds it (`src/engine/review/glab/provider.ts:20`) — the shim sees the encoded
 *  form because the product does. */
const FP = "projects/oz%2Frocket";

/** The glab answers the review strip needs: the `reviews_for_me` sweep (the ONE
 *  call the queue rides on), and the three the row's expansion makes — the
 *  single-MR GET (the only route carrying `head_pipeline`), its jobs, and its
 *  discussions. No write answer: the GitLab journey below cancels its dialog, so a
 *  `notes`/`unapprove` POST reaching the shim would be a defect, and leaving it
 *  unanswered is what makes `expectNoUnknownForgeCalls` say so. */
function glabAnswers(): ForgeAnswers {
  return {
    glab: {
      "auth status": "{}",
      "api merge_requests?scope=reviews_for_me&state=opened&per_page=50":
        glabMrListAnswer(REQ.branch, { iid: 7, project: "oz/rocket" }),
      [`api ${FP}/merge_requests/7`]: glabMrGetAnswer(7, { branch: REQ.branch, project: "oz/rocket" }),
      [`api ${FP}/pipelines/${glabPipelineId(7)}/jobs?per_page=100`]: [
        { name: "ci", status: "success", allow_failure: false },
      ],
      [`api ${FP}/merge_requests/7/discussions?per_page=100`]: [],
    },
  };
}

/** The review run a session would have left behind, and the draft it wrote.
 *
 *  `decorateReviews` (deckView.ts:2484-2493 on 2026-09-04) resolves a row's
 *  `draftPath` from the REVIEW run keyed `reviewRunKey(repoName, number)` —
 *  `<run.repos[0].path>/.pick-task/REVIEW-<n>.md` — so the record is what makes a
 *  draft reachable, and the launch the strip's own journey already proves is not
 *  needed to prove the load. Cheaper and steadier than launching: a real review
 *  launch opens a second Electron window this file would then have to await
 *  before teardown (see `review-launch.e2e.ts`'s `waitForWindows`).
 *
 *  The worktree is a plain directory OUTSIDE the checkout: a run record's own
 *  `isGit` is not what drives the board's git reads (deckView re-derives it with
 *  `rev-parse` per root, deckView.ts:3487-3501), so a directory with no git
 *  ancestry keeps this journey clear of every PR-facts path. `createdAt: now`
 *  keeps the record on the live shelf so no retire sweep can delete it mid-test. */
function seedReviewRun(sb: Sandbox, draft: string): void {
  const wt = path.join(sb.root, "review-worktrees", "review-rocket-41");
  fs.mkdirSync(path.join(wt, ".pick-task"), { recursive: true });
  fs.writeFileSync(path.join(wt, ".pick-task", `REVIEW-${REQ.number}.md`), draft);
  const dir = path.join(sb.home, ".agentflow", "runs");
  fs.mkdirSync(dir, { recursive: true });
  const run = {
    key: "review-rocket-41",
    summary: `Review ${REQ.repo}#${REQ.number}: ${REQ.title}`,
    url: `https://github.invalid/${REQ.repo}/pull/${REQ.number}`,
    createdAt: Date.now(), kind: "review", mode: "per-window",
    repos: [{ name: "rocket", path: wt, isGit: false, branch: REQ.branch }],
    briefPaths: [],
  };
  fs.writeFileSync(path.join(dir, "review-rocket-41.json"), JSON.stringify(run, null, 2) + "\n");
}

/** One host per test: `agentFlow.reviewWrites` differs per row, and a submitted
 *  review is a write the next test must not inherit. `window.dialogStyle:
 *  "custom"` renders the modal `showWarningMessage` as workbench DOM
 *  (`.monaco-dialog-box`) on the top-level page instead of a native macOS sheet
 *  Playwright's Electron driver cannot click. */
async function boot(
  settings: Record<string, unknown>,
  answers: ForgeAnswers,
  opts: { draft?: string } = {},
): Promise<{ page: Page; deck: Deck }> {
  sb = makeSandbox({
    "agentFlow.reviewRequests": true,
    "window.dialogStyle": "custom",
    ...settings,
  });
  if (opts.draft !== undefined) seedReviewRun(sb, opts.draft);
  ({ unknownLog } = installForgeShims(sb, answers));
  const launched = await launchHost(sb);
  app = launched.app;
  const deck = await Deck.open(launched.page);
  return { page: launched.page, deck };
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

/** The modal confirmation. Workbench chrome on the top-level page, outside every
 *  `iframe.webview` — `showWarningMessage(\`${label} on ${repo}#${number}?\`,
 *  { modal: true, detail }, label)` (deckView.ts:3152-3156 on 2026-09-04). */
function dialog(page: Page): Locator {
  return page.locator(".monaco-dialog-box");
}

/** Every `gh pr review` argv the shim received, in order. The assertion of record
 *  for this file: a submit is proven to have reached the CLI by the argv it was
 *  called with, never by a toast. */
function reviewCalls(): string[][] {
  return forgeCalls(sb)
    .filter((c) => c.cli === "gh" && c.argv[0] === "pr" && c.argv[1] === "review")
    .map((c) => c.argv);
}

/** Every glab call that would WRITE to the merge request — the note POST and the
 *  approval withdrawal (`GlabReviewProvider.submit`). Empty is the assertion a
 *  cancelled GitLab dialog owes. */
function glabWriteCalls(): string[][] {
  return forgeCalls(sb)
    .filter((c) => c.cli === "glab" && c.argv.includes("--method"))
    .map((c) => c.argv);
}

/** The Agent Flow Deck output channel's text. VS Code backs every extension output
 *  channel with a file under the session's log directory
 *  (`<user-data-dir>/logs/<session>/exthost…/output_logging_…/N-Agent Flow Deck.log`),
 *  which is the durable record PRIVACY.md points at — read as a file, the first
 *  choice of assertion, rather than scraped out of the Output panel's editor.
 *  Empty until the channel has been written to. Same reader `deck-merge.e2e.ts`
 *  uses for the merge half of the same PRIVACY claim; kept local to each journey
 *  because the two files own different sandboxes. */
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

/** The row, expanded, with its detail block actually rendered. Every negative
 *  assertion in this file depends on that last part: `.rv-actions` only exists
 *  inside `{expanded && !selecting && (…)}` (ReviewStrip.tsx:185), so a
 *  `toHaveCount(0)` taken before it mounts would pass for the wrong reason. */
async function openRow(deck: Deck, n: number): Promise<void> {
  await expect(deck.review(n)).toBeVisible({ timeout: 90_000 });
  await deck.expandReview(n);
  await expect(deck.reviewActions(n)).toBeVisible({ timeout: 30_000 });
}

// Mutation-checked: ReviewStrip.tsx:242 `{reviewWrites && (() => {` → `{true && (() => {`, so the three verbs rendered with the setting off; this failed on Approve's toHaveCount(0).
test("reviewWrites off shows no submit buttons", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const { page, deck } = await boot({}, ghAnswers());
  await openRow(deck, REQ.number);
  await shot(page, testInfo, "1 · expanded row with reviewWrites off");

  // The setting ships off, so this is the out-of-the-box row: it can launch a
  // session and open the PR, and it has nowhere to write and nothing to send.
  await expect(deck.reviewSubmit(REQ.number, "Approve")).toHaveCount(0);
  await expect(deck.reviewSubmit(REQ.number, "Comment")).toHaveCount(0);
  await expect(deck.reviewSubmit(REQ.number, "Request changes")).toHaveCount(0);
  await expect(deck.reviewBox(REQ.number)).toHaveCount(0);
  await expect(deck.reviewActions(REQ.number).getByRole("button", { name: "Open PR" })).toBeVisible();
  expect(reviewCalls()).toEqual([]);
});

// Mutation-checked: submitReview's modal (deckView.ts:3152-3156) replaced with `const answer = label;`, so the submit ran unconfirmed; the dialog never appeared and this failed. That break is sabotage/review-writes.patch.
test("Approve confirms with the verb, repo and number before gh pr review runs", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const { page, deck } = await boot({ "agentFlow.reviewWrites": true }, ghAnswers());
  await openRow(deck, REQ.number);

  // Approve is the one verb with no body requirement (ReviewStrip.tsx:249 gates
  // only `submitting`), so an empty box is the honest starting state here.
  await deck.reviewSubmit(REQ.number, "Approve").click();

  const box = dialog(page);
  await expect(box).toBeVisible({ timeout: 30_000 });
  // `Approve on oznasi1/rocket#41?` — the verb, the repo and the number, before
  // anything reaches the forge.
  await expect(box).toContainText("Approve");
  await expect(box).toContainText("rocket");
  await expect(box).toContainText("#41");
  expect(reviewCalls()).toEqual([]);
  await shot(page, testInfo, "2 · the confirmation names verb, repo and number");

  await box.getByRole("button", { name: "Approve", exact: true }).click();
  await expect.poll(() => reviewCalls(), { timeout: 60_000 })
    .toEqual([["pr", "review", "41", "--repo", REQ.repo, "--approve"]]);
  // And the attempt is on the record PRIVACY.md names — the output channel file.
  await expect.poll(() => outputChannelText(), { timeout: 60_000 })
    .toContain(`deck: submitting approve on ${REQ.repo}#${REQ.number}`);
  await shot(page, testInfo, "3 · approved through gh");
});

// Mutation-checked: submitReview's FIRST `if (answer !== label)` (deckView.ts:3158 — the review guard, NOT the identically worded merge guard 175 lines below) → `if (false)`; Cancel approved anyway, and this failed at the button-release wait below rather than at the argv assertion — an approve that lands evicts the row from the queue, so the button it was waiting on stopped existing at all.
test("cancelling the confirmation sends nothing", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const { page, deck } = await boot({ "agentFlow.reviewWrites": true }, ghAnswers());
  await openRow(deck, REQ.number);

  const approve = deck.reviewSubmit(REQ.number, "Approve");
  await approve.click();
  const box = dialog(page);
  await expect(box).toBeVisible({ timeout: 30_000 });
  await shot(page, testInfo, "4 · about to cancel");
  await box.getByRole("button", { name: "Cancel" }).click();

  // Clicking a verb disables the row's buttons until the host answers with a
  // `deck:reviewSubmitDone` for that id (DeckApp.tsx:1259-1261). Waiting for the
  // button to come back is what makes the argv assertion below non-vacuous: the
  // round trip has completed, so "nothing was sent" is a settled fact rather
  // than a race with a submit still on its way to the shim.
  await expect(approve).toBeEnabled({ timeout: 60_000 });
  expect(reviewCalls()).toEqual([]);
  await shot(page, testInfo, "5 · cancelled, nothing sent");
});

// Mutation-checked: submitReview's `fromDraft && cfg.stampLabelOnWrite && body.trim()` (deckView.ts:3165) → `false && …`, so the body went out unmarked; this failed on the --body argv assertion.
test("a session's draft loads into the review box and is marked session-drafted", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const { page, deck } = await boot({ "agentFlow.reviewWrites": true }, ghAnswers(), { draft: DRAFT });
  await openRow(deck, REQ.number);

  // The button exists only because the host found the draft file through the
  // review run record — its presence is already half the claim.
  await deck.reviewLoadDraft(REQ.number).click();
  await expect(deck.reviewBox(REQ.number)).toHaveValue(DRAFT, { timeout: 30_000 });
  await shot(page, testInfo, "6 · the session's draft in the review box");

  await deck.reviewSubmit(REQ.number, "Comment").click();
  const box = dialog(page);
  await expect(box).toBeVisible({ timeout: 30_000 });
  await box.getByRole("button", { name: "Comment", exact: true }).click();

  await expect.poll(() => reviewCalls(), { timeout: 60_000 }).toEqual([
    ["pr", "review", "41", "--repo", REQ.repo, "--comment", "--body", `${DRAFT}\n\n${PROVENANCE}`],
  ]);
  await shot(page, testInfo, "7 · commented with the session-drafted line");
});

// Mutation-checked: submitReview's `cfg.stampLabelOnWrite` conjunct (deckView.ts:3165) dropped, so the marker was appended with the setting off; this failed on the --body argv assertion.
test("stampLabelOnWrite off sends the body unmarked", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const { page, deck } = await boot(
    { "agentFlow.reviewWrites": true, "agentFlow.stampLabelOnWrite": false },
    ghAnswers(),
    { draft: DRAFT },
  );
  await openRow(deck, REQ.number);

  await deck.reviewLoadDraft(REQ.number).click();
  await expect(deck.reviewBox(REQ.number)).toHaveValue(DRAFT, { timeout: 30_000 });
  await deck.reviewSubmit(REQ.number, "Comment").click();
  const box = dialog(page);
  await expect(box).toBeVisible({ timeout: 30_000 });
  await box.getByRole("button", { name: "Comment", exact: true }).click();

  // Byte-for-byte the draft: the same load, the same verb, one setting flipped.
  await expect.poll(() => reviewCalls(), { timeout: 60_000 }).toEqual([
    ["pr", "review", "41", "--repo", REQ.repo, "--comment", "--body", DRAFT],
  ]);
  await shot(page, testInfo, "8 · the draft sent unmarked");
});

// Mutation-checked: submitReview's `verb === "request-changes" && !this.caps().changesRequested` (deckView.ts:3149-3151) → `false`, so the dialog carried no detail; this failed on the approval wording.
test("Request changes on GitLab warns that approval is withdrawn", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const { page, deck } = await boot(
    { "agentFlow.reviewWrites": true, "agentFlow.forge": "gitlab" },
    glabAnswers(),
  );
  // The GitLab queue's row is MR !7 — the iid, not a GitHub number.
  await openRow(deck, 7);

  // Request changes is disabled with an empty box (ReviewStrip.tsx:251), so the
  // note has to exist before the dialog can be reached at all.
  await deck.reviewBox(7).fill("Please rework the retry loop.");
  await deck.reviewSubmit(7, "Request changes").click();

  const box = dialog(page);
  await expect(box).toBeVisible({ timeout: 30_000 });
  // GitLab has no changes-requested review state, so the dialog says what will
  // actually happen instead: the message lands as a comment and any approval of
  // yours is withdrawn.
  await expect(box).toContainText("Request changes");
  await expect(box).toContainText("withdraws your approval");
  await shot(page, testInfo, "9 · GitLab names the withdrawn approval");

  await box.getByRole("button", { name: "Cancel" }).click();
  await expect(deck.reviewSubmit(7, "Request changes")).toBeEnabled({ timeout: 60_000 });
  expect(glabWriteCalls()).toEqual([]);
});

// Mutation-checked: GhReviewProvider.submit's `err.stderr?.trim() || … stripCommandLine(e.message)` (review/provider.ts:129) → `e instanceof Error ? e.message : String(e)`; the toast then read `Review submit: Command failed: … --body REVIEW-BODY-E2E-SENTINEL…` — the exact leak FORGES.md § 4 forbids — and this failed on the toast's exact text.
test("a rejected submit shows the CLI's stderr, never the body", async ({}, testInfo) => {
  test.setTimeout(240_000);
  // A body distinctive enough that its presence anywhere is unmistakable, and
  // long enough that `.message`'s reconstructed argv could not hide it.
  const SECRET = "REVIEW-BODY-E2E-SENTINEL-must-not-appear-in-any-error";
  const { page, deck } = await boot(
    { "agentFlow.reviewWrites": true },
    ghAnswers({ "pr review": { exit: 1, stderr: "Validation Failed" } }),
  );
  await openRow(deck, REQ.number);

  await deck.reviewBox(REQ.number).fill(SECRET);
  await deck.reviewSubmit(REQ.number, "Comment").click();
  const box = dialog(page);
  await expect(box).toBeVisible({ timeout: 30_000 });
  await box.getByRole("button", { name: "Comment", exact: true }).click();

  // The whole message, not a substring: `toContainText` would pass on a toast
  // that carried gh's wording AND the body after it, which is the exact leak
  // FORGES.md § 4 forbids. The toast self-dismisses after 2.6s, so this is
  // asserted first, before any polling.
  await expect(deck.toast("error")).toHaveText("Review submit: Validation Failed", { timeout: 30_000 });
  await shot(page, testInfo, "10 · the forge's own wording, and only that");

  // The durable halves. The body DID reach the CLI, so the message's silence
  // about it is a choice rather than an accident…
  await expect.poll(() => reviewCalls(), { timeout: 60_000 })
    .toEqual([["pr", "review", "41", "--repo", REQ.repo, "--comment", "--body", SECRET]]);
  // …and the failure is on the output-channel record PRIVACY.md names, with
  // gh's wording and none of the review.
  await expect.poll(() => outputChannelText(), { timeout: 60_000 })
    .toContain("deck: review submit failed: Validation Failed");
  expect(outputChannelText()).not.toContain(SECRET);
  // The row keeps a line of its own after a failure — unlike the toast, it does
  // not time out.
  await expect(deck.reviewFail(REQ.number)).toBeVisible({ timeout: 30_000 });
  await shot(page, testInfo, "11 · the row's own failure line");
});
