import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { makeSandbox, type Sandbox } from "./_helpers/sandbox";
import { launchHost } from "./_helpers/host";
import { Deck } from "./_helpers/po/deck";
import {
  expectNoUnknownForgeCalls, glabMrGetAnswer, glabMrListAnswer, glabPipelineId, installForgeShims,
  type ForgeAnswerMap,
} from "./_helpers/forgeShim";
import { shot } from "./_helpers/shot";

/** What GitLab's review queue cannot answer without a second call, and what
 *  arming says about a rule its forge can never report — docs/FORGES.md § 3 and
 *  § "The MR list carries no pipeline data".
 *
 *  The shape of every fixture here is the load-bearing part: GitLab's MR LIST
 *  route carries no `head_pipeline` and no `changes_count`, and only the
 *  single-MR GET does (`glabMrListAnswer` / `glabMrGetAnswer` enforce that split
 *  between them). A fixture that put either on a list row would re-hide the exact
 *  bug class this project shipped once — every card silently CI-blank, with every
 *  doc-derived test agreeing. */

let sb: Sandbox;
let app: ElectronApplication | undefined;
let unknownLog: string;

const PROJECT = "oz/rocket";
/** The project path as one url segment — GitLab's project-scoped routes take the
 *  full nested path url-encoded (`enc`, src/engine/review/glab/provider.ts:19). */
const ENC = "oz%2Frocket";
const IID = 7;
const BRANCH = "E2E-1-fix-the-rocket-telemetry-panel";
const KEY = "E2E-1";
/** glab substitutes `:fullpath` itself, so the shim sees it literally — the same
 *  placeholder `deck-gitlab.e2e.ts` keys the card's own MR read on. */
const FP = "projects/:fullpath";

/** Every `glab` verb this file's journeys reach for, and nothing else.
 *
 *  - `auth status` is the forge probe (`probeGlab`) every refresh re-checks;
 *    `forgeReady()` is false until it settles, and `reviewsEnabled()` folds it in.
 *  - the `scope=reviews_for_me` sweep is the queue (`REVIEW_MR_PATH`,
 *    review/glab/search.ts:15) — a LIST route, so no pipeline and no size.
 *  - the single-MR GET, its pipeline's jobs and its discussions are what row
 *    EXPANSION adds (`GlabReviewProvider.detail`, review/glab/provider.ts:70-104). */
function glabAnswers(o: { changesCount?: string; pipelineStatus?: "success" | "failed" | null } = {}): ForgeAnswerMap {
  return {
    "auth status": "{}",
    "api merge_requests?scope=reviews_for_me&state=opened&per_page=50": glabMrListAnswer(BRANCH, {
      iid: IID, project: PROJECT,
    }),
    [`api projects/${ENC}/merge_requests/${IID}`]: glabMrGetAnswer(IID, {
      branch: BRANCH, project: PROJECT,
      ...(o.changesCount === undefined ? {} : { changesCount: o.changesCount }),
      ...(o.pipelineStatus === undefined ? {} : { pipelineStatus: o.pipelineStatus }),
    }),
    [`api projects/${ENC}/pipelines/${glabPipelineId(IID)}/jobs?per_page=100`]: [
      { name: "ci", status: "success", allow_failure: false },
    ],
    [`api projects/${ENC}/merge_requests/${IID}/discussions?per_page=100`]: [],
  };
}

function boot(settings: Record<string, unknown> = {}): Sandbox {
  return makeSandbox({
    "agentFlow.forge": "gitlab",
    // `reviewsEnabled()` needs both: the strip's own setting AND `forgeReady()`,
    // which is false while PR facts are off (deckView.ts:2059, 2408-2410).
    "agentFlow.prFacts": true,
    "agentFlow.reviewRequests": true,
    ...settings,
  });
}

/** Wait until the queue has really landed, then assert its size. The loading
 *  Skeleton renders exactly three `.rv-row`s of its own (ReviewStrip.tsx:274-291),
 *  none of them carrying a `.rv-num` — so waiting on a NUMBERED row is what tells
 *  a settled queue from a shimmering one, and every assertion after it follows the
 *  search instead of racing it. `review-strip.e2e.ts`'s `expectQueue`, which was
 *  caught by exactly that. */
async function expectQueue(deck: Deck, first: number, count: number): Promise<void> {
  await expect(deck.review(first)).toBeVisible({ timeout: 90_000 });
  await expect(deck.reviews()).toHaveCount(count);
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

/** One host per test: each row here pins a different single-MR body, and the
 *  detail is read once per expansion and then MERGED into the panel's own review
 *  cache (deckView.ts:2583-2592), so a second test on the same host would inherit
 *  the first's size and CI. */
async function bootDeck(answers: ForgeAnswerMap, settings: Record<string, unknown> = {}): Promise<{ page: Page; deck: Deck }> {
  sb = boot(settings);
  ({ unknownLog } = installForgeShims(sb, { glab: answers }));
  const launched = await launchHost(sb);
  app = launched.app;
  const deck = await Deck.open(launched.page);
  return { page: launched.page, deck };
}

// ── The queue row's size ─────────────────────────────────────────────────────

// Mutation-checked: `readSize`'s `parseInt(raw, 10)` → `Number(raw)`
// (src/engine/review/glab/provider.ts:205) — `Number("20+")` is NaN, so the size read
// as null, nothing was merged into the row, and the count stayed `0 files`; this failed.
// That break is sabotage/forge-gitlab-queue.patch.
test("a GitLab queue row reads 20+ changes as 20 files", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const { page, deck } = await bootDeck(glabAnswers({ changesCount: "20+" }));

  await expectQueue(deck, IID, 1);
  // The list route carries no `changes_count` at all, so the row opens at zero —
  // the positive control for the assertion after the expansion.
  await expect(deck.reviewFiles(IID)).toHaveText("0 files");
  await shot(page, testInfo, "1 · the queue row, size not yet read");

  await deck.expandReview(IID);
  // GitLab caps `changes_count` at the string "20+", and `readSize` reads it as
  // its FLOOR — so an 80-file MR renders exactly like a 20-file one, with nothing
  // marking it approximate (docs/FORGES.md § 3). The merge lands in the panel's
  // cache and reaches the strip on the next `deck:reviews` post, so this polls.
  await expect(deck.reviewFiles(IID)).toHaveText("20 files", { timeout: 60_000 });
  await shot(page, testInfo, "2 · 20+ changes rendered as 20 files");
});

// ── The queue row's CI chip ──────────────────────────────────────────────────

// Mutation-checked: `ci: "none"` → `ci: "passing"` in `toRequest`
// (src/engine/review/glab/search.ts:110) — the collapsed chip was already green and
// the "until expanded" half of this failed.
test("a GitLab row's CI reads none until expanded", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const { page, deck } = await bootDeck(glabAnswers({ pipelineStatus: "success" }));

  await expectQueue(deck, IID, 1);
  // `none` is an ABSENCE, and the strip draws it as an empty chip
  // (`CI_GLYPH.none` is `{ text: "", cls: "" }`, ReviewStrip.tsx:21-26) — so the
  // assertion is the chip's own emptiness, plus the absence of either verdict
  // class. The chip element itself is present, which is what keeps this from
  // being a missing-element pass.
  const chip = deck.reviewCi(IID);
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveText("");
  await expect(chip).not.toHaveClass(/\bpr-ok\b/);
  await expect(chip).not.toHaveClass(/\bpr-bad\b/);
  await shot(page, testInfo, "3 · no CI verdict on the collapsed row");

  // Expanding is what makes the single-MR GET — the only GitLab route carrying
  // `head_pipeline` — and the verdict rides back on `ReviewDetail.ci`.
  await deck.expandReview(IID);
  await expect(chip).toHaveClass(/\bpr-ok\b/, { timeout: 60_000 });
  await expect(chip).toHaveText("✓");
  // The row's own detail line agrees, from the pipeline's jobs.
  await expect(deck.review(IID).locator(".rv-facts")).toContainText("checks passing", { timeout: 30_000 });
  await shot(page, testInfo, "4 · the verdict, once the row is open");
});

// ── The queue row's line counts ──────────────────────────────────────────────

// Mutation-checked: `readSize`'s `{ additions: 0, deletions: 0, changedFiles: n }` →
// `{ additions: 12, deletions: 3, changedFiles: n }` (src/engine/review/glab/provider.ts:206)
// — the row then read `+12 −3` and this failed.
test("GitLab rows carry no line counts", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const { page, deck } = await bootDeck(glabAnswers({ changesCount: "8" }));

  await expectQueue(deck, IID, 1);
  const diff = deck.reviewDiff(IID);
  await expect(diff.locator(".add")).toHaveText("+0");
  await expect(diff.locator(".del")).toHaveText("−0");
  await shot(page, testInfo, "5 · no line counts on the collapsed row");

  await deck.expandReview(IID);
  // The file count is REAL and lands here — which is what makes the zeros beside
  // it a fact rather than an artefact of nothing having been read yet: GitLab's
  // REST API exposes no additions/deletions aggregate, so only `changedFiles` can
  // ever be filled (docs/FORGES.md § 3).
  await expect(deck.reviewFiles(IID)).toHaveText("8 files", { timeout: 60_000 });
  await expect(diff.locator(".add")).toHaveText("+0");
  await expect(diff.locator(".del")).toHaveText("−0");
  await shot(page, testInfo, "6 · the file count is real, the lines stay zero");
});

// ── Arming a rule the forge cannot report ────────────────────────────────────

/** A git checkout the card's place node points at: a real gitlab.com `origin`
 *  (never contacted), `origin/HEAD` so `prEligible` can tell the task branch from
 *  the default, and HEAD on BRANCH. Same fabrication `deck-gitlab.e2e.ts` makes. */
function prepareRepo(dir: string): void {
  const git = (args: string[]): string =>
    execFileSync("git", ["-c", "user.email=e2e@fixture.invalid", "-c", "user.name=E2E", ...args], {
      cwd: dir, encoding: "utf8",
    });
  git(["remote", "add", "origin", `https://gitlab.com/${PROJECT}.git`]);
  const sha = git(["rev-parse", "HEAD"]).trim();
  git(["update-ref", "refs/remotes/origin/main", sha]);
  git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  git(["checkout", "-qb", BRANCH]);
}

/** Run and flow written straight into their stores under the sandbox HOME —
 *  `~/.agentflow/runs/<key>.json` and `~/.agentflow/flows/<id>.json` are the
 *  stores themselves (`runs.ts`, `store.ts`), not a seam around one. No edge
 *  carries an `action`: `writeFlow` derives it from the target, and a stored value
 *  that disagrees is exactly what latches an edge dead — see
 *  `orchestrator-nodes.e2e.ts`'s `seedFlow`. */
function seedRunAndFlow(sandbox: Sandbox): void {
  const runs = path.join(sandbox.home, ".agentflow", "runs");
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(
    path.join(runs, `${KEY}.json`),
    JSON.stringify({
      key: KEY, summary: "Fix the rocket telemetry panel", url: `https://fixture.invalid/browse/${KEY}`,
      createdAt: Date.now(), kind: "task", mode: "per-window",
      repos: [{ name: "rocket", path: sandbox.repoPath, isGit: true, branch: BRANCH }],
      briefPaths: [],
    }, null, 2) + "\n",
  );
  const flows = path.join(sandbox.home, ".agentflow", "flows");
  fs.mkdirSync(flows, { recursive: true });
  fs.writeFileSync(
    path.join(flows, "e2e-cr.json"),
    JSON.stringify({
      id: "e2e-cr", name: "E2E Changes", armed: false, createdAt: Date.now(),
      nodes: [
        { id: "n1", x: 0, y: 0, join: "any", kind: "place", runKey: KEY, repo: "rocket" },
        { id: "n2", x: 220, y: 0, join: "any", kind: "notify", message: "E2E-CR-BLOCKED" },
        { id: "n3", x: 220, y: 120, join: "any", kind: "notify", message: "E2E-CR-DIRTY" },
      ],
      edges: [
        // The rule GitLab can never report: `caps.changesRequested` is false
        // there (src/engine/forge/gitlab.ts:18), which is what
        // `unfirableRules`' "forge-unsupported" branch reads.
        { id: "e1", from: "n1", to: "n2", cond: { kind: "changes-requested" } },
        // A live rule, deliberately UNMET: the checkout is clean, so nothing
        // fires and no resume gate is raised — and its liveness is what makes
        // the count below say ONE rather than "everything".
        { id: "e2", from: "n1", to: "n3", cond: { kind: "has-uncommitted" } },
      ],
    }, null, 2) + "\n",
  );
}

// Mutation-checked: dropped `forge: this.caps()` from the `unfirableRules` call in the
// `flow:setArmed` handler (src/deckView.ts:4256) — `armability` then assumes a fully
// capable forge, the flow armed with no warning at all, and this failed waiting on the
// toast.
test("arming a changes-requested rule on GitLab names it unfirable", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = boot({ "agentFlow.orchestrator": true });
  prepareRepo(sb.repoPath);
  seedRunAndFlow(sb);
  ({ unknownLog } = installForgeShims(sb, {
    glab: {
      ...glabAnswers(),
      // The card's own MR read (`mrListPath`, pr/glab/provider.ts:47-48). Empty:
      // this journey is about what ARMING says, not about a merge request.
      [`api ${FP}/merge_requests?source_branch=${BRANCH}&state=all&per_page=10`]: [],
    },
  }));
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;
  const deck = await Deck.open(page);

  await expect(deck.card(KEY)).toBeVisible({ timeout: 60_000 });
  await deck.card(KEY).click();
  const block = deck.workflowBlock();
  await expect(block).toBeVisible({ timeout: 30_000 });
  await expect(block.locator(".wf-chip")).toHaveText(/disarmed/i, { timeout: 30_000 });
  await shot(page, testInfo, "7 · the flow, disarmed, with one rule GitLab cannot report");

  // Armed, not refused — a flow with one dead rule and one live one is still
  // worth arming, which is why this is a warning and not a rejection.
  await block.getByRole("button", { name: "Arm" }).click();
  const toast = deck.toast("info");
  // The Deck's own toast, and it self-dismisses after 2.6s (DeckApp.tsx:753), so
  // it is asserted on immediately after the click.
  await expect(toast).toContainText("E2E Changes armed", { timeout: 15_000 });
  // ONE rule, not two: the `has-uncommitted` rule beside it is live and unmet, so
  // a warning that counted every rule — or that ignored the forge entirely —
  // could not pass this.
  await expect(toast).toContainText("1 rule's forge cannot report this");
  await expect(toast).toContainText("that rule can never fire");
  await shot(page, testInfo, "8 · armed, with the unfirable rule named");

  // And the arm really landed: the store is the durable record of it.
  const flowFile = path.join(sb.home, ".agentflow", "flows", "e2e-cr.json");
  await expect.poll(() => JSON.parse(fs.readFileSync(flowFile, "utf8")).armed, { timeout: 30_000 }).toBe(true);
});
