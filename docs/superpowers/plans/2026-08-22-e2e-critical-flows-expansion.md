# E2E Expansion — Batch, Forges, Copilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the real-host E2E lane from the take/seed core to the app's remaining critical flows: batch launch, the Deck's PR surface on both forges (GitHub via `gh`, GitLab via `glab`), and the Copilot provider path.

**Architecture:** Everything rides the existing harness (`test-e2e/_helpers/`). The one new idea is **shim CLIs as fixtures**: the forge shells `gh`/`glab` from PATH (`resolveBin`, `src/engine/pr/provider.ts:59`), and the sandbox already owns the child's PATH — so executable shims that answer canned JSON per argv pattern make forge journeys fully deterministic and offline, the same move that made `open` and `claude` safe. Unknown argv is **self-discovering**: the shim logs it to a file and returns an empty valid answer, so the first run against real code reports exactly what else must be faked instead of failing cryptically.

**Tech Stack:** existing pins only (`@playwright/test@1.49.1`, `@vscode/test-electron@2.4.1`, VS Code 1.96.2). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-15-automated-verify-cycle-design.html` §5b (journeys are additive to the shipped seven). Feasibility findings baked in below, all measured 2026-08-22:
- **Cursor as host is NOT automatable today**: Playwright `_electron.launch` against `/Applications/Cursor.app/Contents/MacOS/Cursor` with `--extensionDevelopmentPath` + fresh user-data never completes the launch handshake (5-minute timeout; the driver's inspector pipe never answers). The lane stays manual. Future experiment, not this plan: drive Cursor over CDP (`--remote-debugging-port`) instead of the inspector pipe.
- **Copilot without the extension is deterministic**: `workbench.action.chat.open` is absent in the sandbox host, so `seedChatPanel` exhausts its 7×700ms poll and lands on the documented clipboard fallback toast (`workspace.ts`, "prompt copied — paste it into the panel"). That fallback IS the assertable contract for phase 1; a pinned `GitHub.copilot-chat` panel journey is phase 2, out of scope here.
- **Batch mode surfaces only when the repo filter selects exactly one repo** (`App.tsx:161`) — the journey must drive the repo filter first.
- **GitLab's list omits `head_pipeline`; only the single-MR GET carries it** (hard-won: doc-derived fixtures once hid an all-CI-blank bug). The `glab` shim MUST mirror that shape or it re-hides the same class of bug.

## Global Constraints

Every task's requirements implicitly include this section.

- **`npm run typecheck` clean** · **`npm test` passes unmodified** (~4,700 tests; Bash timeout 600000; never pipe vitest through tail) · **`npm run build` succeeds** · **`npm run test:cov` thresholds hold** · **`npm run test:ct` passes (8)** · **`npm run test:e2e` passes (7 + new)**.
- **No `src/` changes in this plan.** Every journey asserts shipped behavior. If a journey needs product change, stop and surface it.
- **E2E asserts the built bundle**: rebuild before any sabotage check (`npm run test:e2e` builds; bare `npx playwright test` does not).
- **Every new journey carries a sabotage check** — break the product, watch the journey fail, revert with `git diff --exit-code` proof.
- **Screenshots via `shot(page, testInfo, label)`** so the verify-feature report picks them up.
- **Both required checks (`build-and-test`, `e2e`) must be green on the PR.** Merge via the REST path (see the pr-merge memory) — `gh pr merge` refuses client-side.
- Lockfile hygiene as always: `grep -c codeartifact package-lock.json` → 0.

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `test-e2e/_helpers/forgeShim.ts` | Writes the `gh`/`glab` shim scripts + their canned-answer JSON into the sandbox; exposes the unknown-argv log path |
| `test-e2e/batch-take.e2e.ts` | Batch: filter → select 2 → launch → separate windows → 2 worktrees, 2 briefs, 2 plan files |
| `test-e2e/deck-github.e2e.ts` | Deck board renders a run's PR block from the shimmed `gh` |
| `test-e2e/deck-gitlab.e2e.ts` | Same board on `agentFlow.forge: "gitlab"` via the shimmed `glab`, incl. the head_pipeline shape |
| `test-e2e/copilot-fallback.e2e.ts` | Provider=copilot: seed lands on the documented clipboard-fallback toast |

**Modified:** `test-e2e/_helpers/sandbox.ts` (second fixture task + optional shim install), `docs/superpowers/plans/2026-08-21-real-host-e2e-take-task.md` (ledger only).

---

### Task 1: Batch launch — two tasks, two windows, two worktrees

**Files:**
- Create: `test-e2e/batch-take.e2e.ts`
- Modify: `test-e2e/_helpers/sandbox.ts`

**Interfaces:**
- Consumes: `makeSandbox`, `launchHost`, `openTasksView`, `tasksFrame`, `shot`.
- Produces: `FIXTURE_TASK_2` exported from sandbox.ts (a second record, key `E2E-2`, summary also naming "rocket").

Verified flow (`tasksView.ts` `takeBatch`): authed (fixture: always) → repos resolved from the batch bar's filter → below `batchLaunchConfirmThreshold` (6) so **no confirm** → prompt mode from settings → target from settings (`new-window`) → **layout QuickPick** ("Separate windows" vs "One shared window" — the one prompt the test drives) → worktrees are **forced** per task (batch never uses the bare checkout).

- [ ] **Step 1: Add the second fixture task**

In `test-e2e/_helpers/sandbox.ts`, export alongside `FIXTURE_TASK`:

```ts
/** A second task for the batch journey — same repo hint so inference checks it. */
export const FIXTURE_TASK_2 = {
  ...FIXTURE_TASK,
  key: "E2E-2", summary: "Refit the rocket landing gear",
  url: "https://fixture.invalid/browse/E2E-2",
  descriptionText: "Landing gear misses the pad.",
};
```

and write both into `tasks.json`:

```ts
fs.writeFileSync(path.join(fixtureDir, "tasks.json"), JSON.stringify([FIXTURE_TASK, FIXTURE_TASK_2], null, 2));
```

(Existing journeys select cards by key, so a second card changes nothing for them — but run the full suite in Step 4 to prove that, and fix a journey's locator only if it was sloppy, never by narrowing the fixture back.)

- [ ] **Step 2: Write the journey**

Create `test-e2e/batch-take.e2e.ts`:

```ts
import { test, expect } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { makeSandbox, FIXTURE_TASK, FIXTURE_TASK_2, type Sandbox } from "./_helpers/sandbox";
import { launchHost, openTasksView, tasksFrame } from "./_helpers/host";
import { shot } from "./_helpers/shot";

let sb: Sandbox;
let app: ElectronApplication | undefined;

test.beforeEach(() => { sb = makeSandbox(); });
test.afterEach(async () => { await app?.close(); app = undefined; sb.dispose(); });

/** Batch launch: N tasks in one gesture, each isolated in its own worktree,
 *  one window per task. Worktrees are forced by takeBatch — two tasks sharing
 *  a checkout would clobber each other's brief — so this journey also covers
 *  the batch→worktree contract without a settings override. */
test("launching a batch opens a window per task, each in its own worktree", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;

  await openTasksView(page);
  const frame = tasksFrame(page);
  await expect(frame.locator(".card")).toHaveCount(2, { timeout: 30_000 });

  // Batch mode surfaces only when the repo filter selects exactly ONE repo
  // (App.tsx:161) — drive the filter to "rocket" first.
  await frame.locator(".repo-filter, [class*='repo']").first().click();
  await frame.getByText("rocket", { exact: true }).first().click();
  // The filter is a dropdown/multiselect; if the two lines above do not
  // produce per-card checkboxes, read the real classes from App.tsx's repo
  // filter block and fix the TWO locators here — never the flow.

  const checkboxes = frame.locator(".card input[type='checkbox']");
  await expect(checkboxes).toHaveCount(2, { timeout: 15_000 });
  await checkboxes.nth(0).check();
  await checkboxes.nth(1).check();
  await expect(frame.locator(".batch-bar")).toContainText("2 selected");
  await shot(page, testInfo, "1 · two tasks selected");

  const firstWindow = app.waitForEvent("window", { timeout: 90_000 });
  await frame.locator("button.batch-launch").click();

  // The one live prompt: layout. Pick "Separate windows".
  const quickInput = page.locator(".quick-input-widget");
  await expect(quickInput).toBeVisible({ timeout: 15_000 });
  await expect(quickInput).toContainText("Separate windows");
  await shot(page, testInfo, "2 · layout pick");
  await page.keyboard.press("Enter"); // first item is Separate windows

  // Two REAL windows arrive (plus the original = 3 total).
  await firstWindow;
  await expect.poll(() => app!.windows().length, { timeout: 90_000 }).toBeGreaterThanOrEqual(3);
  await shot(page, testInfo, "3 · both windows open");

  // Each task landed in its OWN git worktree with its OWN brief.
  for (const key of [FIXTURE_TASK.key, FIXTURE_TASK_2.key]) {
    const wt = path.join(sb.repoPath, ".claude", "worktrees", key);
    await expect.poll(() => fs.existsSync(path.join(wt, ".pick-task", "TASK.md")), { timeout: 30_000 }).toBe(true);
  }
  // And the shared checkout stayed clean — the reason worktrees are forced.
  expect(fs.existsSync(path.join(sb.repoPath, ".pick-task"))).toBe(false);

  // One plan file per task, both in the sandbox home.
  const planDir = path.join(sb.home, ".agentflow", "plans");
  await expect.poll(() =>
    fs.existsSync(planDir) ? fs.readdirSync(planDir).filter((f) => /^E2E-[12]-/.test(f)).length : 0,
  { timeout: 30_000 }).toBe(2);
});
```

- [ ] **Step 3: Run it**

Run: `npm run test:e2e -- test-e2e/batch-take.e2e.ts` — wait: the script always runs the full build then ALL specs; to run one spec, `npm run build && npx playwright test -c playwright-e2e.config.ts test-e2e/batch-take.e2e.ts` (timeout: 600000).
Expected: PASS. The repo-filter locators are the likely first failure — fix them from the real DOM (screenshot on failure shows it), not by skipping the filter.

- [ ] **Step 4: Full E2E suite — prove the second fixture task broke nothing**

Run: `npm run test:e2e` (timeout: 900000)
Expected: 8 passed.

- [ ] **Step 5: Sabotage check**

`createWorktrees` collision detection is the batch's load-bearing guarantee. Temporarily break the worktree path in `src/engine/worktree.ts` (`const wtPath = path.join(s.path, WORKTREE_DIR, key)` → `const wtPath = s.path` would collide; instead make createWorktrees return `services` unchanged at the top — batch then writes both briefs into the shared checkout):

```ts
export function createWorktrees(
  services: ServiceRef[],
  ...
): ServiceRef[] {
  return services; // SABOTAGED
```

Run the journey (rebuild first: `npm run build`).
Expected: FAIL — either on the missing per-key worktree brief or on the shared-checkout cleanliness assertion. Revert exactly:

```bash
git checkout src/engine/worktree.ts && git diff --exit-code src/engine/worktree.ts
```

- [ ] **Step 6: Commit**

```bash
git add test-e2e/batch-take.e2e.ts test-e2e/_helpers/sandbox.ts
git commit -m "test(e2e): prove batch launch — window, worktree and plan file per task"
```

---

### Task 2: The forge shim + the Deck's PR block on GitHub

**Files:**
- Create: `test-e2e/_helpers/forgeShim.ts`, `test-e2e/deck-github.e2e.ts`

**Interfaces:**
- Consumes: `Sandbox` (its `root`/`bin` dir and `repoPath`).
- Produces: `installForgeShims(sb, answers: ForgeAnswers): { unknownLog: string }` where `ForgeAnswers = { gh: Record<string, unknown>, glab: Record<string, unknown> }` keyed by a coarse argv signature (`"pr list"`, `"api graphql"`, `"api <path>"`, `"auth status"`, ...).

Verified ground truth: the forge resolves the binary from PATH (`resolveBin("gh")`, `provider.ts:59`) and calls e.g. `gh pr list --head <branch> --state all --limit 10 --json number,url,title,state,isDraft,headRefName,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup` (`provider.ts:111-113`) and `gh api graphql ...` for review threads (`provider.ts:126-127`). The Deck reads PR facts only when `agentFlow.prFacts` is on (`deckView.ts:1653`, seeded from config).

- [ ] **Step 1: Write the shim helper**

Create `test-e2e/_helpers/forgeShim.ts`:

```ts
import * as fs from "fs";
import * as path from "path";
import type { Sandbox } from "./sandbox";

export interface ForgeAnswers {
  gh?: Record<string, string>;   // signature → JSON string to print
  glab?: Record<string, string>;
}

/** Install `gh`/`glab` shims into the sandbox's PATH dir. Each shim matches
 *  the FIRST TWO argv words against its answers file and prints the canned
 *  JSON. Anything unmatched is SELF-DISCOVERING: the shim appends the full
 *  argv to unknown.jsonl and exits 0 with an empty JSON array, so the first
 *  run against real code names exactly what else must be faked — a silent
 *  empty answer is visible in the journey's assertions, a crash is not. */
export function installForgeShims(sb: Sandbox, answers: ForgeAnswers): { unknownLog: string } {
  const bin = path.join(sb.root, "bin");
  const answersDir = path.join(sb.root, "forge-answers");
  fs.mkdirSync(answersDir, { recursive: true });
  const unknownLog = path.join(answersDir, "unknown.jsonl");

  for (const cli of ["gh", "glab"] as const) {
    const map = answers[cli] ?? {};
    for (const [sig, body] of Object.entries(map)) {
      fs.writeFileSync(path.join(answersDir, `${cli}.${sig.replace(/[^a-z0-9]+/gi, "_")}.json`), body);
    }
    // The shim: match on "$1 $2", cat the canned file, else log + empty array.
    fs.writeFileSync(
      path.join(bin, cli),
      [
        "#!/bin/sh",
        `sig="$1_$2"`,
        `f="${answersDir}/${cli}.$(printf '%s' "$sig" | tr -c 'A-Za-z0-9' '_').json"`,
        `if [ -f "$f" ]; then cat "$f"; exit 0; fi`,
        `printf '{"cli":"${cli}","argv":"%s"}\\n' "$*" >> "${unknownLog}"`,
        `echo "[]"`,
      ].join("\n") + "\n",
      { mode: 0o755 },
    );
  }
  return { unknownLog };
}

/** One open PR in gh's --json shape, for the branch the take's worktree is on. */
export function ghPrListAnswer(branch: string): string {
  return JSON.stringify([{
    number: 41, url: "https://github.invalid/oznasi1/rocket/pull/41",
    title: "Fix the rocket telemetry panel", state: "OPEN", isDraft: false,
    headRefName: branch, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }],
  }]);
}
```

The two-word signature is deliberately coarse — `pr list`, `api graphql` — because the point is deterministic rendering, not a gh emulator. If a journey needs finer dispatch (two different `pr list` calls), extend the signature then, not now.

- [ ] **Step 2: Write the Deck journey**

Create `test-e2e/deck-github.e2e.ts`:

```ts
import { test, expect } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { makeSandbox, FIXTURE_TASK, type Sandbox } from "./_helpers/sandbox";
import { launchHost, openTasksView, tasksFrame } from "./_helpers/host";
import { installForgeShims, ghPrListAnswer } from "./_helpers/forgeShim";
import { shot } from "./_helpers/shot";

let sb: Sandbox;
let app: ElectronApplication | undefined;

// The branch a take's worktree lands on: <KEY>-<slug> (engine/worktree.ts).
const BRANCH = "E2E-1-fix-the-rocket-telemetry-panel";

test.beforeEach(() => {
  sb = makeSandbox({ "agentFlow.worktree": "always", "agentFlow.prFacts": true });
  installForgeShims(sb, {
    gh: { "pr list": ghPrListAnswer(BRANCH), "auth status": "{}" },
  });
});
test.afterEach(async () => { await app?.close(); app = undefined; sb.dispose(); });

/** The Deck's PR block, fed by the shimmed gh: after a worktree take, the run's
 *  card shows the open PR the forge reports for its branch. This is the first
 *  real-host coverage of the entire Deck surface. */
test("the Deck card shows the PR the GitHub forge reports for the run's branch", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;

  // A take first — the Deck shows runs, and a run exists once a task is taken.
  await openTasksView(page);
  const frame = tasksFrame(page);
  const card = frame.locator(".card", { hasText: FIXTURE_TASK.key });
  await card.waitFor({ timeout: 30_000 });
  await card.locator("button.take").click();
  const quickInput = page.locator(".quick-input-widget");
  await quickInput.waitFor({ timeout: 15_000 });
  const newWindow = app.waitForEvent("window", { timeout: 60_000 });
  await page.keyboard.press("Enter");
  await (await newWindow).locator(".activitybar").waitFor({ timeout: 60_000 });

  // Open the Deck in the FIRST window (view-title button also works; the
  // command is unambiguous). The Deck is its own webview panel.
  await page.keyboard.press("F1");
  await page.keyboard.type("Open the Deck");
  await page.keyboard.press("Enter");

  // The Deck panel's webview: same double-iframe nesting as the sidebar. The
  // run card carries the task key; the PR block renders number + state from
  // the shim's answer. Poll generously — the Deck refreshes on its own beat.
  const deck = page.frameLocator("iframe.webview").last().frameLocator("#active-frame");
  await expect(deck.locator("text=E2E-1").first()).toBeVisible({ timeout: 60_000 });
  await expect(deck.locator("text=#41").first()).toBeVisible({ timeout: 60_000 });
  await shot(page, testInfo, "1 · Deck card with the forge's PR");
});
```

Locator honesty: `text=#41` is a guess at the PR block's rendering — read `DeckApp.tsx`'s PR block markup at implementation time and anchor on its real class/test-id. The assertion contract is fixed (the shimmed PR's number and the run's key are both visible on the board); only the selectors may move.

- [ ] **Step 3: Run, then read the unknown-argv log**

Run: `npm run build && npx playwright test -c playwright-e2e.config.ts test-e2e/deck-github.e2e.ts` (timeout: 600000)

On the first run, whatever forge calls the Deck ALSO makes (review queue searches, CI polls) land in `<sb.root>/forge-answers/unknown.jsonl` — the sandbox is disposed in afterEach, so on failure re-run with `dispose` temporarily disabled (or log the file's contents from the spec) and add canned answers for the signatures that matter. Iterate until green.

- [ ] **Step 4: Sabotage check**

The journey must be reading the FORGE, not decoration. Change the shim's answer to a different branch (`ghPrListAnswer("some-other-branch")`) — the forge filters PRs by the run's branch, so the PR block must show nothing and `text=#41` must fail. (This sabotages the fixture rather than `src/`, which is exactly right here: the claim under test is "the board renders what the forge says about THIS branch".)
Expected: FAIL on the `#41` assertion. Restore the real branch answer.

- [ ] **Step 5: Commit**

```bash
git add test-e2e/_helpers/forgeShim.ts test-e2e/deck-github.e2e.ts
git commit -m "test(e2e): render the Deck's PR block from a shimmed gh — deterministic forge coverage"
```

---

### Task 3: The same board on GitLab

**Files:**
- Create: `test-e2e/deck-gitlab.e2e.ts`
- Modify: `test-e2e/_helpers/forgeShim.ts` (a `glabMrListAnswer` + single-MR answer)

**Interfaces:**
- Consumes: `installForgeShims`.
- Produces: `glabMrListAnswer(branch: string): string` and `glabMrSingleAnswer(): string`.

The one non-negotiable, from the hard-won GitLab lesson: **the MR list answer must OMIT `head_pipeline`; only the single-MR GET carries it.** A shim that puts the pipeline on the list re-hides the exact bug class the real API shape once hid. Read `src/engine/pr/glab/provider.ts` at implementation time for the list/GET paths (`api <path>` signatures) and the field names the mapper reads, and mirror them from the code, not from GitLab docs.

Steps mirror Task 2 exactly: settings `{"agentFlow.forge": "gitlab", "agentFlow.worktree": "always", "agentFlow.prFacts": true}`, glab shim answers, take → Deck → assert the MR number renders → sabotage via wrong-branch answer → commit as `test(e2e): the Deck's PR block over the glab forge, with the honest head_pipeline shape`.

---

### Task 4: Copilot provider — the deterministic fallback contract

**Files:**
- Create: `test-e2e/copilot-fallback.e2e.ts`

**Interfaces:** consumes existing helpers only.

Verified flow: with `agentFlow.agentProvider: "copilot"` on a VS Code host, the seed goes `seedChatPanel` → polls `workbench.action.chat.open` 7×700ms → absent in the bare sandbox → clipboard fallback: prompt copied + toast `"…Copilot prompt copied — paste it into the panel to start."` (`workspace.ts`, the single-task fallback branch). That fallback is the shipped contract when Copilot isn't present, and it has never been executed by any test in a real host.

- [ ] **Step 1: Write the journey**

Create `test-e2e/copilot-fallback.e2e.ts`:

```ts
import { test, expect } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";
import { makeSandbox, FIXTURE_TASK, type Sandbox } from "./_helpers/sandbox";
import { launchHost, openTasksView, tasksFrame } from "./_helpers/host";
import { shot } from "./_helpers/shot";

let sb: Sandbox;
let app: ElectronApplication | undefined;

test.beforeEach(() => { sb = makeSandbox({ "agentFlow.agentProvider": "copilot" }); });
test.afterEach(async () => { await app?.close(); app = undefined; sb.dispose(); });

/** Copilot provider, phase 1: the documented degradation. Without the Copilot
 *  extension, workbench.action.chat.open never registers, and the seed's
 *  contract is the clipboard fallback — prompt copied, toast says so. The
 *  pinned-extension panel journey is phase 2 (see the plan's out-of-scope). */
test("a Copilot seed without Copilot lands on the documented clipboard fallback", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;

  await openTasksView(page);
  const frame = tasksFrame(page);
  const card = frame.locator(".card", { hasText: FIXTURE_TASK.key });
  await card.waitFor({ timeout: 30_000 });
  await card.locator("button.take").click();
  await page.locator(".quick-input-widget").waitFor({ timeout: 15_000 });
  const newWindow = app.waitForEvent("window", { timeout: 60_000 });
  await page.keyboard.press("Enter");
  const opened = await newWindow;
  await opened.locator(".activitybar").waitFor({ timeout: 60_000 });

  // The fallback toast appears in the OPENED window after the ~5s poll gives
  // up. The exact copy is the contract — it tells the user where their prompt
  // went, and a reworded toast that stops saying so should fail this.
  await expect(opened.locator(".notification-list-item-message", { hasText: "Copilot prompt copied" }))
    .toBeVisible({ timeout: 60_000 });
  await shot(opened, testInfo, "1 · clipboard fallback announced");

  // And the clipboard genuinely carries the prompt — read it inside the host.
  const clip = await opened.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain(`Jira ${FIXTURE_TASK.key}`);
});
```

Clipboard-read caveat: `navigator.clipboard.readText()` inside the workbench renderer may need focus or may be permission-gated even in Electron; if it throws, drop to asserting the toast alone and note it — the toast text already implies the write happened, and `vscode.env.clipboard` has no host-side test hook without a `src/` change (which this plan forbids).

- [ ] **Step 2: Run it** — `npm run build && npx playwright test -c playwright-e2e.config.ts test-e2e/copilot-fallback.e2e.ts` (timeout: 600000). Expected: PASS. The toast wait is ~5s of poll + activation; the 60s ceiling absorbs it.

- [ ] **Step 3: Sabotage check** — in `seedChatPanel` (`src/engine/workspace.ts`), make the fallback unreachable by returning `true` from the function's top (`return true; // SABOTAGED` — the caller then believes the panel opened and shows no toast). Rebuild, run: the toast assertion must FAIL. Revert with `git diff --exit-code`.

- [ ] **Step 4: Commit** — `test(e2e): pin the Copilot clipboard fallback in a real host`.

---

### Task 5: Ship it

- [ ] Full gates: `typecheck` · `npm test` (timeout 600000) · `test:ct` · `test:e2e` (now 11 journeys; timeout 900000) · `build`.
- [ ] Update the 2026-08-21 plan's ledger (batch/forges/copilot rows) and CONTRIBUTING's `test:e2e` row (journey count).
- [ ] Push, open the PR (both required checks must go green — the `e2e` check now runs all 11 on the PR), REST-merge per the memory.

---

## Out of Scope (enumerated, with reasons)

1. **Cursor host lane** — measured dead end for the current driver (see header). Future experiment: CDP `--remote-debugging-port` attach instead of Playwright's inspector pipe.
2. **Copilot phase 2** — pinned `GitHub.copilot` + `copilot-chat` vsix in the sandbox, assert the chat panel opens with the query. Same pattern as the Claude panel journey; do it when the fallback journey has soaked.
3. **Explore / Notepad / setup-wizard journeys** — all drivable with the existing harness (QuickPick/InputBox flows, no new fixtures); next increment after this one lands.
4. **Sprint-lens journeys** (add/remove/reorder round-trip) — needs the fixture connector to grow an honest `sprints` capability writing to `writes.jsonl`; small `src/tasks/fixture/` extension, its own PR.
5. **Orchestrator flow journeys** (arm a flow, watch a rule fire on the 6s beat) — feasible (flows live under the sandbox HOME) but a different scale of scenario setup; own plan.

## Self-Review

- **User's asks covered:** batches (Task 1), GitHub (Task 2), GitLab (Task 3), Copilot (Task 4), Cursor (measured, honestly parked — automating it today would mean shipping a lane that cannot run).
- **Placeholders:** none — every step has runnable code; the two knowingly-soft locators (repo filter, Deck PR block) are flagged with the fix rule (read the real markup, adjust the selector, never the flow/contract).
- **Type consistency:** `installForgeShims(sb, answers)` and `ghPrListAnswer(branch)` defined in Task 2 match Task 3's consumption; `FIXTURE_TASK_2` defined in Task 1 is used only there.
- **No-src-change rule:** all sabotage checks either revert cleanly or mutate fixtures; none of the four tasks ships a `src/` diff.
