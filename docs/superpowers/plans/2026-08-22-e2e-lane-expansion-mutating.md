# E2E Lane Expansion — Mutating Journeys, Providers & Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cover the flows that open windows, create worktrees and write run records — PR review, the Deck's lifecycle, Address PR, child-tree takes — land the Cursor and Copilot provider paths that shipped without ever running in an editor, and make the lane's green mean something by failing loudly on unfaked shell calls and surfacing retried passes.

**Architecture:** Every journey is one Electron boot per `test()`, because each mutates state a sibling would inherit — the opposite of Plan 1's shared-host groups, and the reason the split exists. Determinism comes from extending the shim-CLIs-as-fixtures pattern the lane already proves: `gh api graphql` answers the review rail, a `cursor-agent` shim takes the Cursor provider's prompt, and unmatched argv stops being silently forgiven.

**Tech Stack:** existing pins — `@playwright/test@1.49.1`, `@vscode/test-electron@2.4.1`, VS Code 1.96.2, Claude Code 2.1.238 — plus one new pin for GitHub Copilot Chat (Task 8). No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-08-22-e2e-lane-expansion-design.html` (§4.3 shims, §4.4 Copilot, §6.2 journeys, §7.2–§7.3 hardening, §8 spike, §9 CI).

**Depends on:** `docs/superpowers/plans/2026-08-22-e2e-lane-expansion-foundation.md` — Task 3's fixture capabilities (needed by Task 6) and Task 7's `scripts/sabotage.mjs` (every task here adds a patch to it).

## Global Constraints

Every task's requirements implicitly include this section.

- **`npm run typecheck` clean** · **`npm test` passes UNMODIFIED** (~4,700 tests; pass `timeout: 600000`; **never pipe vitest through `tail`/`head`**) · **`npm run build` succeeds** · **`npm run test:cov` thresholds hold** (90% lines/statements, 85% branches/functions) · **`npm run test:ct` passes** · **`npm run test:e2e` passes** (11 existing + Plan 1's 3 files + new).
- **A single failure under CPU contention is usually flake** — re-run that file alone before believing it. Never let two vitest runs overlap.
- **E2E asserts the built bundle.** `npm run test:e2e` builds; a bare `npx playwright test` does not. Always rebuild before a sabotage check.
- **No `src/` changes in this plan.** Every journey asserts shipped behaviour. If a journey needs product change, **stop and surface it** — that is a finding, not a licence to edit.
- **Never break existing users.** `test/unit/compat.test.ts` freezes the released surface. A test you had to edit to go green is the signal to stop.
- **Vocabulary.** A *session* is one run of a coding tool; an *agent* is a worker a session delegates to. `test/unit/vocabulary.test.ts` enforces it; identifiers keep their released spelling.
- **Screenshots via `shot(page, testInfo, label)`.**
- **Every new journey ships its `test-e2e/sabotage/<journey>.patch` in the same commit**, and must be observed failing under it via `npm run sabotage <journey>`.
- **Lockfile hygiene:** `grep -c codeartifact package-lock.json` → 0.
- **Commit per task.** Mutation-checking only means anything against committed work: the `git checkout` that restores a mutant also reverts an uncommitted fix.
- **Merging:** `main` is branch-protected; both required checks (`build-and-test`, `e2e`) must be green, and the merge goes through the REST path — `gh pr merge` refuses client-side.

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `test-e2e/_helpers/po/deck.ts` | Page object for the Deck board, its detail pane and the review strip |
| `test-e2e/_helpers/copilotChat.ts` | Pins and caches GitHub Copilot Chat into the sandbox's extensions dir |
| `test-e2e/review-launch.e2e.ts` | Review rail → single launch and batch launch → review worktrees + run records |
| `test-e2e/deck-lifecycle.e2e.ts` | Auto-retire sweep, forget, track, clear-stale |
| `test-e2e/address-pr.e2e.ts` | Address PR from the sidebar and from the Deck |
| `test-e2e/child-tree-take.e2e.ts` | Taking a parent offers its tree and creates a worktree per child |
| `test-e2e/cursor-provider.e2e.ts` | `agentProvider: "cursor"` seeds the prompt into the `cursor-agent` shim |
| `test-e2e/copilot-panel.e2e.ts` | Real pinned Copilot Chat panel seed (subject to Task 8's go/no-go) |
| `test-e2e/cursor-host.e2e.ts` | Created **only** if Task 1's spike says go |
| `test-e2e/sabotage/*.patch` | One mutation per new journey |
| `.github/workflows/sabotage.yml` | Weekly mutation-check job |

**Modified:** `test-e2e/_helpers/forgeShim.ts` (graphql answer builder + `expectNoUnknownForgeCalls`) · `test-e2e/_helpers/sandbox.ts` (`cursor-agent` shim) · `test-e2e/_helpers/host.ts` (`launchCursorHost`, only on a go) · `scripts/verify-report.mjs` (retry visibility) · `.github/workflows/e2e.yml` (cache key).

---

### Task 1: The Cursor-as-host CDP spike — go/no-go, runs first

**Files:**
- Create: `test-e2e/_helpers/cursorHost.spike.mjs` (throwaway; deleted on a no-go)
- Modify: `docs/superpowers/plans/2026-08-22-e2e-lane-expansion-mutating.md` (record the outcome in this task)

**Interfaces:**
- Produces, **only on a go**: `launchCursorHost(sb): Promise<{ app, page }>` in `host.ts`, consumed by Task 11.

**Why first.** Measured 2026-08-22: Playwright's `_electron.launch` against `/Applications/Cursor.app/Contents/MacOS/Cursor` with `--extensionDevelopmentPath` and a fresh user-data **never completes the launch handshake** — the driver's inspector pipe never answers and it times out at five minutes. CDP was never tried. Running the spike before any task depends on it makes a no-go cost one session instead of a restructured plan. **Timebox: one session.** Nothing else in this plan depends on the outcome.

- [ ] **Step 1: Write the probe**

Create `test-e2e/_helpers/cursorHost.spike.mjs`:

```js
// THROWAWAY. Answers one question: can Playwright drive Cursor over CDP when
// the Electron inspector pipe will not answer? Delete on a no-go.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const APP = "/Applications/Cursor.app/Contents/MacOS/Cursor";
const PORT = 9222;
const root = mkdtempSync(join(tmpdir(), "cursor-spike-"));

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // same trap as launchHost: a child inheriting it boots as plain Node

const child = spawn(APP, [
  `--remote-debugging-port=${PORT}`,
  `--extensionDevelopmentPath=${resolve("..", "..")}`,
  `--user-data-dir=${join(root, "user-data")}`,
  `--extensions-dir=${join(root, "extensions")}`,
  "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes",
  "--disable-updates", "--no-sandbox", "--disable-gpu", "--new-window",
  "--force-disable-user-env", "--password-store=basic",
], { env, stdio: "inherit" });

const deadline = Date.now() + 120_000;
let browser;
while (Date.now() < deadline && !browser) {
  try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); }
  catch { await new Promise((r) => setTimeout(r, 1000)); }
}
if (!browser) { console.error("NO-GO: CDP never accepted a connection"); child.kill(); process.exit(1); }

const pages = browser.contexts().flatMap((c) => c.pages());
console.log("CDP pages:", pages.length, await Promise.all(pages.map((p) => p.title())));
let ok = false;
for (const p of pages) {
  try { await p.locator(".activitybar").waitFor({ timeout: 15_000 }); ok = true; console.log("workbench:", await p.title()); break; }
  catch { /* not the workbench target */ }
}
console.log(ok ? "GO: workbench reachable over CDP" : "NO-GO: no CDP target exposed .activitybar");
child.kill();
process.exit(ok ? 0 : 1);
```

- [ ] **Step 2: Run it**

```bash
node test-e2e/_helpers/cursorHost.spike.mjs; echo "EXIT=$?"
```

Read the **real** exit code from that `echo`, not from a wrapper — a process can be SIGTERMed and still look green.

- [ ] **Step 3: Record the outcome in this file**

Replace this step's text with the measured result — the date, the exit code, the page titles CDP reported, and the verdict. On a **no-go**, add "Task 11 is cancelled" and delete the spike file. On a **go**, keep the file until Task 11 lands `launchCursorHost`, then delete it.

- [ ] **Step 4: Commit**

```bash
git add -A docs/superpowers/plans/2026-08-22-e2e-lane-expansion-mutating.md test-e2e/_helpers/cursorHost.spike.mjs
git commit -m "spike(e2e): probe Cursor-as-host over CDP and record the verdict"
```

---

### Task 2: Forge shim — a GraphQL answer, and unfaked calls that fail loudly

**Files:**
- Modify: `test-e2e/_helpers/forgeShim.ts`

**Interfaces:**
- Consumes: `Sandbox`, the existing `installForgeShims(sb, answers)`.
- Produces: `ghReviewRequestsAnswer(reqs: ReviewReq[]): string` where `interface ReviewReq { number: number; repo: string; title: string; author: string; branch: string }`, and `expectNoUnknownForgeCalls(sb: Sandbox): void`.

**Why §7.2 matters.** The shim's unknown-argv handling is self-discovering by design: log to `unknown.jsonl`, return `[]`, exit 0 — right during development, wrong forever after. Once a journey is green, a product change that starts shelling a new subcommand silently receives an empty answer and the journey keeps passing.

- [ ] **Step 1: Add the GraphQL answer builder**

Append to `test-e2e/_helpers/forgeShim.ts`:

```ts
export interface ReviewReq {
  number: number;
  repo: string;   // "owner/name"
  title: string;
  author: string;
  branch: string;
}

/** The `gh api graphql` answer the review rail parses.
 *
 *  Shape matters more than content: `parseReviewSearch` (src/engine/review/search.ts)
 *  returns NULL for anything that is not `data.search.{issueCount,nodes}`, and a
 *  null parse is indistinguishable from "no review requests" — which would make
 *  the journey pass against a broken product. Both members are mandatory here.
 *
 *  The shim keys on the first two argv words, so this registers under the
 *  signature "api graphql" (tr-mangled to `api_graphql`). */
export function ghReviewRequestsAnswer(reqs: ReviewReq[]): string {
  return JSON.stringify({
    data: {
      search: {
        issueCount: reqs.length,
        nodes: reqs.map((r) => ({
          __typename: "PullRequest",
          number: r.number,
          title: r.title,
          url: `https://github.invalid/${r.repo}/pull/${r.number}`,
          isDraft: false,
          createdAt: "2026-08-20T00:00:00Z",
          updatedAt: "2026-08-21T00:00:00Z",
          author: { login: r.author },
          headRefName: r.branch,
          baseRefName: "main",
          repository: { nameWithOwner: r.repo },
        })),
      },
    },
  });
}

/** Fail when the product shelled a subcommand nobody faked.
 *
 *  Call this in the teardown of every forge journey. Without it the shim's
 *  empty-answer fallback silently absorbs a real behaviour change: the journey
 *  stays green while the product asks a question the test never answered. */
export function expectNoUnknownForgeCalls(sb: Sandbox): void {
  const log = path.join(sb.root, "forge-answers", "unknown.jsonl");
  if (!fs.existsSync(log)) return;
  const lines = fs.readFileSync(log, "utf8").trim();
  if (lines === "") return;
  throw new Error(
    `the product shelled forge subcommands with no canned answer — add them to the shim:\n${lines}`,
  );
}
```

- [ ] **Step 2: Retro-fit the two existing forge journeys**

In `test-e2e/deck-github.e2e.ts` and `test-e2e/deck-gitlab.e2e.ts`, add to the existing `test.afterEach`, **before** `sb.dispose()`:

```ts
  expectNoUnknownForgeCalls(sb);
```

- [ ] **Step 3: Run them**

Run: `npm run test:e2e -- deck-github deck-gitlab` (timeout: 600000)

Expected: **PASS**. If either now fails, the error names the exact unfaked argv — that is a real gap the empty-answer fallback was hiding. Add the missing canned answer to that journey's `installForgeShims` call; do **not** relax the assertion.

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck
git add test-e2e/_helpers/forgeShim.ts test-e2e/deck-github.e2e.ts test-e2e/deck-gitlab.e2e.ts
git commit -m "test(e2e): answer gh api graphql and fail on unfaked forge calls"
```

---

### Task 3: `po/deck.ts` — the Deck page object

**Files:**
- Create: `test-e2e/_helpers/po/deck.ts`

**Interfaces:**
- Produces: `class Deck` with `open(page)`, `cards()`, `card(key)`, `detail()`, `reviews()`, `review(n)`, `reviewLaunch(n)`, `batchBar()`, `batchLaunch()`, `clearStale()`.

**Verified selectors** (read from `src/webview/DeckApp.tsx`, `DeckDetail.tsx`, `ReviewStrip.tsx` on 2026-08-22): `.rv-box` · `.rv-actions` · `.act.primary` · `.rv-author` · `.batch-bar` · `.batch-count` · `.batch-launch`.

- [ ] **Step 1: Write it**

Create `test-e2e/_helpers/po/deck.ts`:

```ts
import { expect, type FrameLocator, type Locator, type Page } from "@playwright/test";

/** The Deck webview. It opens as an editor PANEL, so it is the last webview
 *  iframe in the workbench — same two-deep nesting as `tasksFrame`. */
export class Deck {
  readonly frame: FrameLocator;

  private constructor(readonly page: Page) {
    this.frame = page.frameLocator("iframe.webview").last().frameLocator("#active-frame");
  }

  /** Open through the real command, not a seam. */
  static async open(page: Page): Promise<Deck> {
    await page.keyboard.press("Control+Shift+P");
    await page.keyboard.type("Agent Flow: Open the Deck (in-flight)");
    await page.keyboard.press("Enter");
    const deck = new Deck(page);
    await expect(deck.frame.locator("body")).toBeVisible({ timeout: 30_000 });
    return deck;
  }

  cards(): Locator {
    return this.frame.locator(".card");
  }

  card(key: string): Locator {
    return this.frame.locator(".card", { hasText: key });
  }

  detail(): Locator {
    return this.frame.locator(".deck-detail, .detail").first();
  }

  reviews(): Locator {
    return this.frame.locator(".rv-box");
  }

  /** One review row, addressed by PR number as rendered in the strip. */
  review(n: number): Locator {
    return this.frame.locator(".rv-box", { hasText: `#${n}` });
  }

  /** The row's primary action — "Review with Claude Code". */
  reviewLaunch(n: number): Locator {
    return this.review(n).locator(".rv-actions .act.primary");
  }

  batchBar(): Locator {
    return this.frame.locator(".batch-bar");
  }

  batchLaunch(): Locator {
    return this.frame.locator(".batch-launch");
  }

  clearStale(): Locator {
    return this.frame.getByRole("button", { name: /clear stale/i });
  }
}
```

- [ ] **Step 2: Typecheck and commit**

```bash
npm run typecheck
git add test-e2e/_helpers/po/deck.ts
git commit -m "test(e2e): add the Deck page object"
```

---

### Task 4: `review-launch.e2e.ts` — the review rail, single and batch

**Files:**
- Create: `test-e2e/review-launch.e2e.ts`, `test-e2e/sabotage/review-launch.patch`

**Interfaces:**
- Consumes: `makeSandbox`, `launchHost`, `installForgeShims`, `ghReviewRequestsAnswer`, `expectNoUnknownForgeCalls`, `Deck`, `shot`.

**Verified flow.** `agentFlow.reviewRequests` defaults **true** and `agentFlow.reviewRequestMode` defaults **`"ask"`** — which opens a picker. Setting it to `"full"` (a real id in the shipped `agentFlow.reviewRequestModes` default) makes `resolveReviewMode` skip the picker, so the journey drives no QuickPick. `reviewRunKey(repo, number)` yields `review-<repo-slug>-<number>` → **`review-rocket-41`**, which is both the run key and the worktree directory name under `<repo>/.claude/worktrees/`.

- [ ] **Step 1: Write the journey**

Create `test-e2e/review-launch.e2e.ts`:

```ts
import { expect, test, type ElectronApplication } from "@playwright/test";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { makeSandbox, type Sandbox } from "./_helpers/sandbox";
import { launchHost } from "./_helpers/host";
import { Deck } from "./_helpers/po/deck";
import { ghReviewRequestsAnswer, installForgeShims, expectNoUnknownForgeCalls } from "./_helpers/forgeShim";
import { shot } from "./_helpers/shot";

let sb: Sandbox;
let app: ElectronApplication | undefined;

const REQS = [
  { number: 41, repo: "oznasi1/rocket", title: "Fix the rocket telemetry panel", author: "octo", branch: "fix/telemetry" },
  { number: 42, repo: "oznasi1/rocket", title: "Refit the rocket landing gear", author: "octo", branch: "fix/gear" },
];

test.beforeEach(() => {
  // reviewRequestMode "full" names a real shipped mode, so resolveReviewMode
  // skips the picker — the journey drives the flow, not a QuickPick.
  sb = makeSandbox({
    "agentFlow.forge": "github",
    "agentFlow.reviewRequests": true,
    "agentFlow.reviewRequestMode": "full",
    "agentFlow.reviewOpenIn": "new-window",
  });
  installForgeShims(sb, { gh: { "api graphql": ghReviewRequestsAnswer(REQS) } });
});

test.afterEach(async () => {
  await app?.close();
  app = undefined;
  expectNoUnknownForgeCalls(sb);
  sb.dispose();
});

/** Every worktree git itself knows about in the fixture repo. Asserting from
 *  `git worktree list` rather than from a directory existing is the difference
 *  between "a folder was created" and "a worktree was registered". */
function worktrees(repoPath: string): string {
  return execFileSync("git", ["worktree", "list"], { cwd: repoPath, encoding: "utf8" });
}

test("launching a review opens its worktree, brief and plan handshake", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const launched = await launchHost(sb);
  app = launched.app;
  const deck = await Deck.open(launched.page);

  await expect(deck.review(41)).toBeVisible({ timeout: 60_000 });
  await expect(deck.review(41)).toContainText("octo");
  await shot(launched.page, testInfo, "1 · review rail");

  await deck.reviewLaunch(41).click();

  // reviewRunKey("rocket", 41) → "review-rocket-41": the run key AND the
  // worktree directory name. Never a Jira key, never mistaken for one.
  await expect.poll(() => worktrees(sb.repoPath), { timeout: 120_000 }).toContain("review-rocket-41");

  const wt = path.join(sb.repoPath, ".claude", "worktrees", "review-rocket-41");
  await expect.poll(() => fs.existsSync(path.join(wt, ".pick-task"))).toBe(true);

  const runFile = path.join(sb.home, ".agentflow", "runs", "review-rocket-41.json");
  await expect.poll(() => fs.existsSync(runFile), { timeout: 60_000 }).toBe(true);
  const run = JSON.parse(fs.readFileSync(runFile, "utf8")) as { kind?: string; url: string };
  expect(run.kind).toBe("review");
  expect(run.url).toContain("/pull/41");

  // The plan handshake carries the review-rendered template: {repo}, {number}
  // and {author} are substituted before the shared renderer ever sees it.
  const plansDir = path.join(sb.home, ".agentflow", "plans");
  await expect.poll(() => (fs.existsSync(plansDir) ? fs.readdirSync(plansDir) : []), { timeout: 60_000 })
    .not.toHaveLength(0);
  const plan = fs.readdirSync(plansDir).map((f) => fs.readFileSync(path.join(plansDir, f), "utf8")).join("\n");
  expect(plan).toContain("oznasi1/rocket");
  expect(plan).toContain("41");
  expect(plan).not.toContain("{repo}");
  expect(plan).not.toContain("{number}");
  await shot(launched.page, testInfo, "2 · review launched");
});

test("a batch review launches one worktree and one run record per PR", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const launched = await launchHost(sb);
  app = launched.app;
  const deck = await Deck.open(launched.page);

  await expect(deck.reviews()).toHaveCount(2, { timeout: 60_000 });
  await deck.review(41).locator("input[type=checkbox]").check();
  await deck.review(42).locator("input[type=checkbox]").check();
  await expect(deck.batchBar()).toContainText("2");
  await shot(launched.page, testInfo, "3 · two reviews selected");

  await deck.batchLaunch().click();

  await expect.poll(() => worktrees(sb.repoPath), { timeout: 180_000 }).toContain("review-rocket-41");
  expect(worktrees(sb.repoPath)).toContain("review-rocket-42");

  const runs = path.join(sb.home, ".agentflow", "runs");
  await expect.poll(() => fs.readdirSync(runs).filter((f) => f.startsWith("review-rocket-")), { timeout: 60_000 })
    .toHaveLength(2);
  await shot(launched.page, testInfo, "4 · batch launched");
});
```

- [ ] **Step 2: Run it and repair only locators**

Run: `npm run test:e2e -- review-launch` (timeout: 600000)

If the review strip renders nothing, read `unknown.jsonl` — Task 2's assertion prints the exact unfaked argv. If the checkbox selector does not match, read the real control from `src/webview/ReviewStrip.tsx` and fix **that one locator**. Never weaken an assertion.

- [ ] **Step 3: Author the sabotage patch**

Break `renderReviewTemplate` in `src/engine/review/launch.ts` so `{number}` is left unsubstituted, then:

```bash
git diff > test-e2e/sabotage/review-launch.patch
git checkout src/
npm run sabotage review-launch      # (timeout: 600000)
```

Expected: "correctly FAILED under its mutation" — the `expect(plan).not.toContain("{number}")` assertion kills it.

- [ ] **Step 4: Gate and commit**

```bash
npm run typecheck && npm run test:e2e     # (timeout: 600000)
git add test-e2e/review-launch.e2e.ts test-e2e/sabotage/review-launch.patch
git commit -m "test(e2e): cover the review rail, single launch and batch"
```

---

### Task 5: `deck-lifecycle.e2e.ts` — the retire sweep, forget, track, clear stale

**Files:**
- Create: `test-e2e/deck-lifecycle.e2e.ts`, `test-e2e/sabotage/deck-lifecycle.patch`

**Interfaces:**
- Consumes: `makeSandbox`, `launchHost`, `Deck`, `shot`.

**Verified mechanism — read this before writing a click.** Retire is **not a button**: it is the Deck's sweep, `applyVerdict` in `src/deckView.ts`, which calls `removeRun` when a run qualifies under `agentFlow.retireClosedAfterHours` and friends. The journey therefore **seeds a qualifying run record and asserts the sweep deletes it**. `deck:forget`, `deck:track` and `deck:clearStale` *are* user actions (`DeckApp.tsx`, `DeckDetail.tsx`). Run records live at `<HOME>/.agentflow/runs/<key>.json` — and HOME is the sandbox, so the test can write them directly.

- [ ] **Step 1: Write the journey**

Create `test-e2e/deck-lifecycle.e2e.ts`:

```ts
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

function baseRun(sb: Sandbox, key: string, extra: Record<string, unknown> = {}) {
  return {
    key, summary: `Run ${key}`, url: `https://fixture.invalid/browse/${key}`,
    createdAt: Date.now() - 72 * HOUR, kind: "task", mode: "per-window",
    repos: [{ name: "rocket", path: sb.repoPath, isGit: true, branch: "main" }],
    briefPaths: [], ...extra,
  };
}

test.beforeEach(() => { sb = makeSandbox({ "agentFlow.retireClosedAfterHours": 1 }); });
test.afterEach(async () => { await app?.close(); app = undefined; sb.dispose(); });

test("a run past its retire window is swept off the board and out of the store", async ({}, testInfo) => {
  test.setTimeout(240_000);
  // finishedAt well past retireClosedAfterHours: 1 → the sweep must retire it.
  const doomed = seedRun(sb, baseRun(sb, "E2E-OLD", { finishedAt: Date.now() - 48 * HOUR }));
  const kept = seedRun(sb, baseRun(sb, "E2E-NEW"));

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
  const a = seedRun(sb, baseRun(sb, "E2E-A"));
  const b = seedRun(sb, baseRun(sb, "E2E-B"));

  const launched = await launchHost(sb);
  app = launched.app;
  const deck = await Deck.open(launched.page);

  await expect(deck.card("E2E-A")).toBeVisible({ timeout: 60_000 });
  await deck.card("E2E-A").click();
  await deck.detail().getByRole("button", { name: /forget/i }).click();

  await expect.poll(() => fs.existsSync(a), { timeout: 60_000 }).toBe(false);
  expect(fs.existsSync(b)).toBe(true);
  await shot(launched.page, testInfo, "3 · forgotten");
});

test("clear stale leaves live runs alone", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const live = seedRun(sb, baseRun(sb, "E2E-LIVE", { createdAt: Date.now() }));

  const launched = await launchHost(sb);
  app = launched.app;
  const deck = await Deck.open(launched.page);

  await expect(deck.card("E2E-LIVE")).toBeVisible({ timeout: 60_000 });
  await deck.clearStale().click();
  await launched.page.waitForTimeout(3_000);
  expect(fs.existsSync(live)).toBe(true);
  await shot(launched.page, testInfo, "4 · live run survives clear stale");
});
```

- [ ] **Step 2: Run it**

Run: `npm run test:e2e -- deck-lifecycle` (timeout: 600000)

If a seeded run does not render, the record is missing a field the board requires — read `Run` in `src/types.ts` and add it to `baseRun`. Do **not** stop asserting the record on disk.

- [ ] **Step 3: Sabotage patch**

Make `applyVerdict`'s `case "retire"` skip `removeRun` in `src/deckView.ts`:

```bash
git diff > test-e2e/sabotage/deck-lifecycle.patch
git checkout src/
npm run sabotage deck-lifecycle     # (timeout: 600000)
```

- [ ] **Step 4: Gate and commit**

```bash
npm run typecheck && npm run test:e2e     # (timeout: 600000)
git add test-e2e/deck-lifecycle.e2e.ts test-e2e/sabotage/deck-lifecycle.patch
git commit -m "test(e2e): cover the Deck's retire sweep, forget and clear stale"
```

---

### Task 6: `child-tree-take.e2e.ts` — taking a parent with children

**Files:**
- Create: `test-e2e/child-tree-take.e2e.ts`, `test-e2e/sabotage/child-tree-take.patch`

**Interfaces:**
- Consumes: `FIXTURE_TASK`, `FIXTURE_CHILD` (Plan 1 Task 3), `Pool`, `launchHost`, `shot`.

**Verified flow.** `agentFlow.childWorktrees` defaults **true**. `probeTree` (`src/tasksView.ts:2548`) returns null immediately when the setting is off **or** when `caps.children` is absent — which is exactly why Plan 1 Task 3 had to land first. With the fixture claiming `children`, taking `E2E-1` finds `E2E-1-a` one level down and offers the tree. This journey is per-test, not shared-host: it opens a window and creates worktrees.

- [ ] **Step 1: Write the journey**

Create `test-e2e/child-tree-take.e2e.ts`:

```ts
import { expect, test, type ElectronApplication } from "@playwright/test";
import { execFileSync } from "child_process";
import { makeSandbox, FIXTURE_TASK, FIXTURE_CHILD, type Sandbox } from "./_helpers/sandbox";
import { launchHost } from "./_helpers/host";
import { Pool } from "./_helpers/po/pool";
import { shot } from "./_helpers/shot";

let sb: Sandbox;
let app: ElectronApplication | undefined;

test.beforeEach(() => { sb = makeSandbox({ "agentFlow.childWorktrees": true, "agentFlow.worktree": "always" }); });
test.afterEach(async () => { await app?.close(); app = undefined; sb.dispose(); });

test("taking a parent offers its tree and creates a worktree for the child", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const launched = await launchHost(sb);
  app = launched.app;
  const pool = await Pool.open(launched.page, 2); // the child is NOT a pool card

  await pool.card(FIXTURE_TASK.key).getByRole("button", { name: /take/i }).click();

  // probeTree runs under a cancellable notification; the tree offer is a
  // QuickPick listing the children it found. Accept it.
  await expect(launched.page.getByText(FIXTURE_CHILD.summary)).toBeVisible({ timeout: 120_000 });
  await shot(launched.page, testInfo, "1 · tree offered");
  await launched.page.keyboard.press("Enter");

  await expect
    .poll(() => execFileSync("git", ["worktree", "list"], { cwd: sb.repoPath, encoding: "utf8" }), { timeout: 180_000 })
    .toContain(FIXTURE_CHILD.key);
  await shot(launched.page, testInfo, "2 · child worktree created");
});
```

- [ ] **Step 2: Run it**

Run: `npm run test:e2e -- child-tree-take` (timeout: 600000)

The tree offer's exact affordance (QuickPick vs. modal) is the one thing to verify against `src/tasksView.ts`'s `probeTree` call site. Fix the acceptance gesture here if it differs; **the worktree assertion does not move.**

- [ ] **Step 3: Sabotage patch, gate, commit**

Make `probeTree` return `null` unconditionally, then:

```bash
git diff > test-e2e/sabotage/child-tree-take.patch
git checkout src/
npm run sabotage child-tree-take && npm run typecheck && npm run test:e2e   # (timeout: 600000)
git add test-e2e/child-tree-take.e2e.ts test-e2e/sabotage/child-tree-take.patch
git commit -m "test(e2e): cover taking a parent ticket with a child tree"
```

---

### Task 7: `address-pr.e2e.ts`

**Files:**
- Create: `test-e2e/address-pr.e2e.ts`, `test-e2e/sabotage/address-pr.patch`

**Interfaces:**
- Consumes: `installForgeShims`, `ghPrListAnswer` (already in `forgeShim.ts`), `expectNoUnknownForgeCalls`, `Pool`, `Deck`.

- [ ] **Step 1: Write the journey**

Create `test-e2e/address-pr.e2e.ts`:

```ts
import { expect, test, type ElectronApplication } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { makeSandbox, FIXTURE_TASK, type Sandbox } from "./_helpers/sandbox";
import { launchHost } from "./_helpers/host";
import { Pool } from "./_helpers/po/pool";
import { ghPrListAnswer, installForgeShims, expectNoUnknownForgeCalls } from "./_helpers/forgeShim";
import { shot } from "./_helpers/shot";

let sb: Sandbox;
let app: ElectronApplication | undefined;

test.beforeEach(() => {
  sb = makeSandbox({ "agentFlow.forge": "github", "agentFlow.worktree": "always" });
  installForgeShims(sb, { gh: { "pr list": ghPrListAnswer("agent-flow/E2E-1") } });
});

test.afterEach(async () => {
  await app?.close();
  app = undefined;
  expectNoUnknownForgeCalls(sb);
  sb.dispose();
});

test("Address PR seeds a session that names the pull request", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const launched = await launchHost(sb);
  app = launched.app;
  const pool = await Pool.open(launched.page, 2);

  await pool.card(FIXTURE_TASK.key).getByRole("button", { name: /address pr/i }).click();
  await shot(launched.page, testInfo, "1 · address PR");

  const plans = path.join(sb.home, ".agentflow", "plans");
  await expect.poll(() => (fs.existsSync(plans) ? fs.readdirSync(plans) : []), { timeout: 120_000 })
    .not.toHaveLength(0);
  const seeded = fs.readdirSync(plans).map((f) => fs.readFileSync(path.join(plans, f), "utf8")).join("\n");
  expect(seeded).toContain("41"); // the PR number ghPrListAnswer reports
  await shot(launched.page, testInfo, "2 · seeded");
});
```

- [ ] **Step 2: Run, sabotage, gate, commit**

```bash
npm run test:e2e -- address-pr          # (timeout: 600000)
# then break the PR-number substitution in the address-PR prompt builder:
git diff > test-e2e/sabotage/address-pr.patch
git checkout src/
npm run sabotage address-pr && npm run typecheck && npm run test:e2e   # (timeout: 600000)
git add test-e2e/address-pr.e2e.ts test-e2e/sabotage/address-pr.patch
git commit -m "test(e2e): cover Address PR from the sidebar"
```

`ghPrListAnswer(branch)` takes the branch the take's worktree is on. If the worktree branch differs from `agent-flow/E2E-1`, read the branch from `git worktree list` in the failure output and pass that instead — the shim must match the branch the product actually asks about.

---

### Task 8: `cursor-provider.e2e.ts` — the path that shipped unverified

**Files:**
- Create: `test-e2e/cursor-provider.e2e.ts`, `test-e2e/sabotage/cursor-provider.patch`
- Modify: `test-e2e/_helpers/sandbox.ts` (the `cursor-agent` shim)

**Why this matters most of the six.** The Cursor provider shipped in 0.33.0 and **its manual verification was never run** — no Cursor path in this repo has ever executed in an editor under test. This journey is its first execution in CI.

- [ ] **Step 1: Add the shim**

In `test-e2e/_helpers/sandbox.ts`, beside the existing `claude` shim:

```ts
  // Shadow `cursor-agent` for the same reason as `claude`: terminal-surface
  // seeding runs the provider CLI in a real integrated terminal, and the
  // developer's actual Cursor CLI must never start a session from a test. The
  // marker plus `exec cat` leaves the prompt sitting in a "running" TUI the way
  // the real one would.
  fs.writeFileSync(path.join(bin, "cursor-agent"), "#!/bin/sh\necho CURSOR-SHIM-READY\nexec cat\n", { mode: 0o755 });
```

- [ ] **Step 2: Write the journey**

Create `test-e2e/cursor-provider.e2e.ts`:

```ts
import { expect, test, type ElectronApplication } from "@playwright/test";
import { makeSandbox, FIXTURE_TASK, type Sandbox } from "./_helpers/sandbox";
import { launchHost } from "./_helpers/host";
import { Pool } from "./_helpers/po/pool";
import { shot } from "./_helpers/shot";

let sb: Sandbox;
let app: ElectronApplication | undefined;

test.beforeEach(() => {
  // The seed resolves provider × surface AT SEED TIME in the target window —
  // never from the plan file — so setting both here is the whole contract.
  sb = makeSandbox({
    "agentFlow.agentProvider": "cursor",
    "agentFlow.agentSurface": "terminal",
    "agentFlow.openIn": "new-window",
  });
});
test.afterEach(async () => { await app?.close(); app = undefined; sb.dispose(); });

test("a cursor-provider take seeds the prompt into a real terminal", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const launched = await launchHost(sb);
  app = launched.app;
  const pool = await Pool.open(launched.page, 2);

  await pool.card(FIXTURE_TASK.key).getByRole("button", { name: /take/i }).click();
  await launched.page.keyboard.press("Enter"); // confirm the pre-checked repo

  // Assert from the REAL xterm DOM: the shim's marker proves cursor-agent was
  // the binary launched, and the prompt proves the seed reached it unsubmitted.
  const term = launched.page.locator(".xterm-rows");
  await expect(term).toContainText("CURSOR-SHIM-READY", { timeout: 180_000 });
  await expect(term).toContainText(FIXTURE_TASK.key, { timeout: 60_000 });
  await shot(launched.page, testInfo, "1 · cursor-agent seeded");
});
```

- [ ] **Step 3: Run, sabotage, gate, commit**

```bash
npm run test:e2e -- cursor-provider     # (timeout: 600000)
# then make the provider resolution ignore "cursor" and fall back to claude-code:
git diff > test-e2e/sabotage/cursor-provider.patch
git checkout src/
npm run sabotage cursor-provider && npm run typecheck && npm run test:e2e   # (timeout: 600000)
git add test-e2e/cursor-provider.e2e.ts test-e2e/sabotage/cursor-provider.patch test-e2e/_helpers/sandbox.ts
git commit -m "test(e2e): run the Cursor provider path in a real editor for the first time"
```

If the seed never reaches the terminal, **stop and surface it** — that is a real 0.33.0 defect this journey exists to find, and fixing `src/` is out of this plan's scope.

---

### Task 9: `copilot-panel.e2e.ts` — pinned Copilot Chat, with a go/no-go

**Files:**
- Create: `test-e2e/_helpers/copilotChat.ts`, `test-e2e/copilot-panel.e2e.ts`, `test-e2e/sabotage/copilot-panel.patch`
- Modify: `.github/workflows/e2e.yml` (cache key)

**Interfaces:**
- Consumes: `Sandbox`, `resolveCliArgsFromVSCodeExecutablePath`.
- Produces: `COPILOT_CHAT_VERSION` and `installCopilotChat(vscodeExecutablePath, sb)` — the same signature as `installClaudeCode`.

- [ ] **Step 1: Write the installer**

Create `test-e2e/_helpers/copilotChat.ts` as a copy of `claudeCode.ts` with three changes: the exported constant becomes `COPILOT_CHAT_VERSION` (pin the latest version compatible with VS Code 1.96.2 — check the gallery, then **pin it, never float**), the publisher/extension in the gallery URL becomes `GitHub/vsextensions/copilot-chat`, and the cache dir prefix becomes `copilot-chat-ext-`. Keep the gunzip-on-magic-bytes step, the staging-dir install through VS Code's own CLI, and the `delete env.ELECTRON_RUN_AS_NODE` line — all three are load-bearing.

- [ ] **Step 2: Write the journey**

Create `test-e2e/copilot-panel.e2e.ts`:

```ts
import { expect, test, type ElectronApplication } from "@playwright/test";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { makeSandbox, FIXTURE_TASK, type Sandbox } from "./_helpers/sandbox";
import { VSCODE_VERSION, launchHost } from "./_helpers/host";
import { installCopilotChat } from "./_helpers/copilotChat";
import { Pool } from "./_helpers/po/pool";
import { shot } from "./_helpers/shot";

let sb: Sandbox;
let app: ElectronApplication | undefined;

test.beforeEach(async () => {
  sb = makeSandbox({ "agentFlow.agentProvider": "copilot", "agentFlow.agentSurface": "extension" });
  await installCopilotChat(await downloadAndUnzipVSCode(VSCODE_VERSION), sb);
});
test.afterEach(async () => { await app?.close(); app = undefined; sb.dispose(); });

test("a copilot take opens the real chat panel instead of the clipboard fallback", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const launched = await launchHost(sb);
  app = launched.app;
  const pool = await Pool.open(launched.page, 2);

  await pool.card(FIXTURE_TASK.key).getByRole("button", { name: /take/i }).click();
  await launched.page.keyboard.press("Enter");

  // The contract: with Copilot Chat present, seedChatPanel resolves
  // workbench.action.chat.open and NEVER reaches the clipboard fallback toast.
  await expect(launched.page.locator(".interactive-session, .chat-widget").first())
    .toBeVisible({ timeout: 180_000 });
  await expect(launched.page.locator(".notifications-toasts")).not.toContainText("prompt copied");
  await shot(launched.page, testInfo, "1 · copilot panel");
});
```

- [ ] **Step 3: Run it — and honour the go/no-go**

Run: `npm run test:e2e -- copilot-panel` (timeout: 600000)

**Copilot Chat may refuse to register `workbench.action.chat.open` until signed in.** If it does, the journey cannot assert the panel, and the inverted assertion ("the command is absent, the fallback fires") is already proven by `copilot-fallback.e2e.ts`. In that case the honest outcome is: **delete `copilot-panel.e2e.ts` and `copilotChat.ts`, revert the cache-key change, and record the finding in this task** — shipping a test that asserts nothing is the failure mode this whole plan exists to prevent.

- [ ] **Step 4: On a go, wire the cache key**

In `.github/workflows/e2e.yml`, extend the cache key so the pin and the cache move together:

```yaml
          key: vscode-test-${{ runner.os }}-${{ hashFiles('test-e2e/_helpers/host.ts', 'test-e2e/_helpers/claudeCode.ts', 'test-e2e/_helpers/copilotChat.ts') }}
```

- [ ] **Step 5: Sabotage, gate, commit**

```bash
# break seedChatPanel so it skips the command and takes the fallback:
git diff > test-e2e/sabotage/copilot-panel.patch
git checkout src/
npm run sabotage copilot-panel && npm run typecheck && npm run test:e2e   # (timeout: 600000)
git add test-e2e/copilot-panel.e2e.ts test-e2e/_helpers/copilotChat.ts test-e2e/sabotage/copilot-panel.patch .github/workflows/e2e.yml
git commit -m "test(e2e): seed the real Copilot Chat panel against a pinned build"
```

---

### Task 10: Retry visibility, and the weekly sabotage job

**Files:**
- Modify: `scripts/verify-report.mjs`
- Create: `.github/workflows/sabotage.yml`

**Why.** CI keeps `retries: 1` — dropping it would make a required check hostile — but today a journey that only passes the second time is indistinguishable in the report from one that passes cleanly. That is how an intermittently broken journey becomes permanent background noise.

- [ ] **Step 1: Surface retried passes**

In `scripts/verify-report.mjs`, where each spec's result is read from the Playwright JSON, count `test.results.length > 1` (or a non-empty `test.results[].retry`) and mark those specs. Add to the markdown summary, immediately under the pass/fail counts:

```js
// A retried pass is a flake, not a pass. Naming it here is the whole point:
// `retries: 1` keeps the required check humane, and this line stops it from
// also keeping the flake invisible.
if (retried.length) {
  lines.push("", `⚠️ **Passed on retry:** ${retried.join(", ")} — investigate before this becomes background noise.`);
}
```

- [ ] **Step 2: Verify against a real report**

```bash
npm run test:e2e && npm run e2e:report && cat test-results/verify-report.md   # (timeout: 600000)
```

Expected: the summary renders; with no retries, no warning line appears. To prove the line works, temporarily add `test.describe.configure({ retries: 1 })` and a deliberately flaky assertion in a scratch spec, run, confirm the warning, then delete the scratch spec.

- [ ] **Step 3: Add the weekly job**

Create `.github/workflows/sabotage.yml`:

```yaml
name: Sabotage (mutation-check the E2E lane)

# Weekly, not per-PR: it rebuilds and re-runs per patch, far too slow for a
# required check, and "a journey stopped being able to fail" is a
# standing-health question rather than a merge-blocking one.
on:
  schedule:
    - cron: "0 6 * * 1"
  workflow_dispatch:

jobs:
  sabotage:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - name: Cache the pinned VS Code build
        uses: actions/cache@v4
        with:
          path: .vscode-test
          key: vscode-test-${{ runner.os }}-${{ hashFiles('test-e2e/_helpers/host.ts', 'test-e2e/_helpers/claudeCode.ts', 'test-e2e/_helpers/copilotChat.ts') }}
      - run: xvfb-run -a npm run sabotage
```

- [ ] **Step 4: Gate and commit**

```bash
npm run typecheck && npm test && npm run build      # (timeout: 600000)
git add scripts/verify-report.mjs .github/workflows/sabotage.yml
git commit -m "ci: surface retried passes and mutation-check the lane weekly"
```

---

### Task 11: `cursor-host.e2e.ts` — **only if Task 1 said go**

**Files:**
- Modify: `test-e2e/_helpers/host.ts` (add `launchCursorHost`)
- Create: `test-e2e/cursor-host.e2e.ts`
- Delete: `test-e2e/_helpers/cursorHost.spike.mjs`

**If Task 1 said no-go, skip this task entirely** and confirm the negative result is recorded there. The Cursor *provider* journey (Task 8) runs on the VS Code host and is unaffected either way.

- [ ] **Step 1: Promote the spike into `launchCursorHost`**

Add to `test-e2e/_helpers/host.ts`, beside `launchHost`, a `launchCursorHost(sb)` that spawns Cursor with `--remote-debugging-port`, attaches via `chromium.connectOverCDP`, picks the target whose `.activitybar` resolves, and returns `{ app, page }` with the same shape `launchHost` returns. Carry over every flag `launchHost` documents — `--force-disable-user-env`, `--password-store=basic`, `--use-inmemory-secretstorage`, the sandbox `HOME`/`PATH`/`AGENT_FLOW_FIXTURE_DIR` env, and `delete env.ELECTRON_RUN_AS_NODE` — the reasons in those comments apply identically to Cursor.

- [ ] **Step 2: One journey, deliberately narrow**

Create `test-e2e/cursor-host.e2e.ts` with a **single** test: boot Cursor, open the sidebar, assert the two fixture cards render, take `E2E-1`, and assert the brief lands on disk. The point is that the host boots and the extension activates — **not** to double the lane. Screenshot each step via `shot`.

- [ ] **Step 3: Gate and commit**

```bash
rm test-e2e/_helpers/cursorHost.spike.mjs
npm run typecheck && npm run test:e2e     # (timeout: 600000)
git add -A test-e2e
git commit -m "test(e2e): boot Cursor as a host over CDP and take a task"
```

Note this journey is **macOS-local only** — the GitHub runner has no Cursor install, so it must be excluded from the CI lane (`testIgnore` in `playwright-e2e.config.ts`, or a `test.skip(!!process.env.CI)` guard with the reason in a comment).

---

## Self-Review

- **Spec coverage.** §4.3 → Tasks 2 and 8. §4.4 → Task 9. §6.2 → Tasks 4–9 (plus Task 6, the child-tree journey relocated from §6.1 — see below). §7.2 → Task 2. §7.3 → Task 10. §8 → Tasks 1 and 11. §9 → Tasks 9 and 10. §7.1's runner is Plan 1 Task 7; every task here contributes its patch.
- **The one relocation.** §6.1 grouped "child expansion" with the shared-host sidebar tests. Verified on 2026-08-22: children surface at **Take** time behind `agentFlow.childWorktrees` (`tasksView.ts:2548` `probeTree`), opening windows and creating worktrees — so it cannot share a host. It is Task 6 here; the fixture **capability** stayed in Plan 1 Task 3, where the one-file connector change belongs.
- **Placeholders:** none. Tasks 9 Step 1 and 11 Steps 1–2 describe a file as a delta against a named existing file rather than repeating ~80 lines verbatim; both name every load-bearing detail (the three changes to `claudeCode.ts`; the six flags and the env handling to carry over). Every other step carries runnable code or exact commands.
- **Type consistency.** `ReviewReq {number, repo, title, author, branch}` (Task 2) is the shape Task 4's `REQS` uses. `Deck.review(n)/reviewLaunch(n)/batchBar()/batchLaunch()/clearStale()/card(key)/detail()` (Task 3) matches every call in Tasks 4, 5 and 7. `installCopilotChat(vscodeExecutablePath, sb)` (Task 9 Step 1) matches its Step 2 call site and mirrors `installClaudeCode`. `expectNoUnknownForgeCalls(sb)` is called in Tasks 2, 4 and 7 with the same single argument. Run records are `<HOME>/.agentflow/runs/<key>.json` in both Task 4 and Task 5, matching `fileFor` in `src/engine/runs.ts`.
- **Vacuous-test guard.** Every journey ships a patch and must be seen failing under it. Two tasks (9 and 11) carry an explicit *delete the work* branch, because a journey that cannot assert its contract is worse than no journey.
- **No `src/` changes.** Three tasks (6, 8, 9) name an explicit stop-and-surface if the product turns out to be broken, rather than authorising a fix.
