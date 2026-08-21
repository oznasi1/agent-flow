# Batch "Review with agent" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Select several PRs in the Deck's review strip and launch one review agent per PR — all in one window or a window each — without checking any branch out unless the chosen mode says to.

**Architecture:** The review strip gains an opt-in selection mode and a batch bar. A new pure module (`src/engine/review/batch.ts`) turns selected `ReviewRequest`s into the shape `openSharedWorkspace` already consumes for a task batch; `openSharedWorkspace` gains three optional passthrough fields so a review can vary what a task hardcodes. A new batch-only "read-only review" mode reads the PR at its own revision instead of checking it out, which is what lets several reviews share one window with no worktrees.

**Tech Stack:** TypeScript on the VS Code extension host, React webviews, esbuild, Vitest (+ jsdom for webview tests), `gh` / `glab` CLIs for forge reads.

**Spec:** [docs/superpowers/specs/2026-08-21-batch-review-with-agents-design.md](../specs/2026-08-21-batch-review-with-agents-design.md) — read it before Task 1. It argues every decision this plan executes.

**Base:** written against `75c8208` (0.33.8). `fd46dbc` landed a per-row play button in the review strip while this plan was being written and restructured the row — Task 8 accounts for it. Re-check `main`'s HEAD at the start of each task; if the strip has moved again, stop and say so rather than guessing.

## Global Constraints

These apply to **every** task. They are the project's rules, not this feature's.

- **The CI gate is exactly four commands, and all four must pass:** `npm ci`, `npm run typecheck`, `npm test`, `npm run build` (`.github/workflows/ci.yml`). `npm run build` is a real gate, not a formality.
- **`npm test` is ~4,500 tests over 122 files and takes 2+ minutes.** It exceeds the default Bash tool timeout and auto-backgrounds at 120s — **pass `timeout: 600000`** when running it through a tool. While iterating, run one file: `npx vitest run test/unit/engine/review/batch.test.ts`, or one test: `npx vitest run test/webview -t "toggles"`.
- **Never pipe vitest through `tail` or `head`** — it discards the failure list you need.
- **A single failure under CPU contention is usually flake, not a regression.** Re-run that one file alone before believing it.
- **Do not edit an existing test to make your change pass.** The released surface is frozen by `test/unit/compat.test.ts`, and a test you had to edit to go green is the signal to STOP and report. Adding new tests and adding new *optional* fields to a shared test factory is fine; changing an existing assertion is not.
- **Never break existing users.** Thousands of installs. New behaviour ships inert: the strip must render byte-identically when the new props are absent, and a *task* batch's plan and run bytes must be unchanged.
- **Coverage thresholds are enforced** (`vitest.config.ts`: 90% lines/statements, 85% branches/functions) by `npm run test:cov`. New pure modules should sit near 100%.
- **Webviews cannot reach Node.** Nothing reachable from `src/webview/*` may import `fs`, `os`, `path`, or `child_process` — even as an unused import; esbuild resolves statically and the build breaks while `tsc` and most of the suite still pass. `test/webview/webviewGraph.test.ts` is the near-gate but follows *relative* imports only.
- **No hardcoded organization values.** Everything configurable goes through `getConfig()` in `src/config.ts`. This feature adds **no new settings** — it reuses `agentFlow.batchLaunchConfirmThreshold` and `agentFlow.reviewRequestMode`.
- **Webview copy and colour rules** (`src/webview/deckStyles.ts` header): monospace is for identifiers and counts only — anything that reads as English is set in the UI font. Saturated colour is attention debt; red is for real failures only.
- **`main` moves fast** — several sessions land on it a day. Work in a git worktree (`superpowers:using-git-worktrees`), and re-check `main`'s HEAD at the start of each task.
- **Commit after every task.** A session can be killed mid-flight; every commit must leave a tree where `npm run typecheck` passes.
- **Mutation-check every test you write.** After a test goes green, break the line of implementation it covers (revert it, flip the boolean, change the string) and confirm the test *fails*. A test that passes against broken code is worse than no test. Restore afterwards.
- **`.claude/` is git-ignored** — never add project guidance there.

---

### Task 1: `BatchTask.kind` reaches the Run record

Without this, a batched review's run records as a **task**: `decorateReviews` looks up a row's run with `runKind(r) === "review"`, so the strip would never show "reviewing", the draft would never be found, and — per the comment on `Run.kind` in `src/types.ts` — a run keyed `review-aws-ops-8491` carrying a PR url would be polled as if it were a Jira ticket. This is the correctness-critical passthrough; do it first and alone.

**Files:**
- Modify: `src/engine/batchWorkspace.ts` (the `BatchTask` interface, ~line 24; the run-writing loop, ~line 196)
- Test: `test/unit/engine/batchWorkspace.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `BatchTask.kind?: Run["kind"]` — Task 4's `toBatchTask` sets it to `"review"`.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe("openSharedWorkspace", …)` block in `test/unit/engine/batchWorkspace.test.ts`. Use the file's existing `baseReq` and `writes` helpers — do not add new ones.

```ts
  // ── review batches: the kind passthrough ──────────────────────────────────
  it("writes each task's kind onto its run record", async () => {
    // decorateReviews finds a row's run with runKind(r) === "review". A batched
    // review whose run says "task" is invisible to the strip AND gets polled as
    // if `review-aws-ops-8491` were a Jira key.
    await openSharedWorkspace(
      baseReq({
        tasks: [
          { ...baseReq().tasks[0], kind: "review" },
          { ...baseReq().tasks[1], kind: "review" },
        ],
      }),
    );
    const runs = writes((p) => p.includes("/runs/")).map((c) => JSON.parse(String(c[1])));
    expect(runs.map((r) => r.kind)).toEqual(["review", "review"]);
  });

  it("leaves kind absent — not null — when a task does not set one", async () => {
    // Absent is how "task" is spelled on every record written before review runs
    // existed. A literal `kind: undefined` would serialize away too, but only by
    // accident of JSON.stringify; this asserts the key is genuinely not there.
    await openSharedWorkspace(baseReq());
    const runs = writes((p) => p.includes("/runs/")).map((c) => JSON.parse(String(c[1])));
    expect(runs.every((r) => !("kind" in r))).toBe(true);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/unit/engine/batchWorkspace.test.ts -t "kind"`
Expected: the first FAILS (`["review","review"]` vs `[undefined, undefined]`); the second already PASSES (nothing writes `kind` yet) — it is the regression guard for Step 3, so confirm it is green now and stays green after.

- [ ] **Step 3: Implement**

In the `BatchTask` interface, after `services`:

```ts
  /** What launched this run, written straight onto the Run record. Reviews pass
   *  "review" — `decorateReviews` matches a row to its run with
   *  `runKind(r) === "review"`, and `Run.kind` is also what keeps a run carrying a
   *  PR url out of Jira polling. Absent means "task", exactly as before. */
  kind?: Run["kind"];
```

`Run` is already imported at the top of the file (`import { Run, ServiceRef } from "../types";`). In the run-writing loop, add one line to the `const run: Run = {…}` literal, directly after `createdAt`:

```ts
      createdAt,
      // Spread-conditional, not `kind: t.kind`: absent is how "task" is spelled on
      // every record a task batch has ever written, and this keeps those bytes identical.
      ...(t.kind ? { kind: t.kind } : {}),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/batchWorkspace.test.ts`
Expected: PASS, including every test that was already in the file.

- [ ] **Step 5: Mutation-check**

Change the new line to `kind: t.kind,` (unconditional) and re-run: the "leaves kind absent" test must FAIL. Restore the spread-conditional and confirm green.

- [ ] **Step 6: Commit**

```bash
git add src/engine/batchWorkspace.ts test/unit/engine/batchWorkspace.test.ts
git commit -m "feat(batch): carry a task's run kind through openSharedWorkspace"
```

---

### Task 2: per-task prompt template and brief sub-directory

`openSharedWorkspace` renders one shared `promptTemplate` for every task, and computes brief paths per *service* (`path.join(s.path, BRIEF_DIR, BRIEF_FILE)`). A review batch breaks both: `{repo}`/`{number}`/`{author}` differ per PR, and two PRs in the same repo with no worktree would both write `.pick-task/TASK.md` — the second silently overwriting the first.

**Files:**
- Modify: `src/engine/batchWorkspace.ts` (the `BatchTask` interface; the brief loop ~line 95; the prompt line ~line 184)
- Test: `test/unit/engine/batchWorkspace.test.ts`

**Interfaces:**
- Consumes: `BatchTask.kind` from Task 1 (same interface, no code dependency).
- Produces: `BatchTask.promptTemplate?: string`, `BatchTask.briefSubdir?: string` — both set by Task 4's `toBatchTask`.

- [ ] **Step 1: Write the failing tests**

```ts
  // ── review batches: per-task prompt and brief path ────────────────────────
  it("prefers a task's own promptTemplate over the shared one", async () => {
    // A review's {repo}/{number}/{author} are rendered per PR before the batch is
    // assembled, so no single shared template can carry them.
    await openSharedWorkspace(
      baseReq({
        tasks: [
          { ...baseReq().tasks[0], promptTemplate: "Review aws-ops#8491 — {key}" },
          baseReq().tasks[1],
        ],
      }),
    );
    const plans = writes((p) => p.includes("/plans/")).map((c) => JSON.parse(String(c[1])));
    expect(plans[0].matches[0].prompt).toContain("Review aws-ops#8491 — ASM-1");
    // The task that set nothing still gets the shared template, rendered as always.
    expect(plans[1].matches[0].prompt).toContain("Start ASM-2");
  });

  it("puts a task's brief in its own sub-directory when it asks for one", async () => {
    // Two PRs of the SAME repo reviewed without worktrees share one checkout, so
    // `.pick-task/TASK.md` would collide and the second would win silently.
    const result = await openSharedWorkspace(
      baseReq({
        tasks: [
          {
            ticket: { key: "review-api-7", summary: "seven", url: "https://gh/7" },
            planMd: "p", descriptionText: "",
            services: [{ name: "api", path: "/repos/api", isGit: true }],
            briefSubdir: "REVIEW-7",
          },
          {
            ticket: { key: "review-api-9", summary: "nine", url: "https://gh/9" },
            planMd: "p", descriptionText: "",
            services: [{ name: "api", path: "/repos/api", isGit: true }],
            briefSubdir: "REVIEW-9",
          },
        ],
      }),
    );
    expect(writes((p) => p.endsWith("TASK.md")).map((c) => String(c[0]))).toEqual([
      "/repos/api/.pick-task/REVIEW-7/TASK.md",
      "/repos/api/.pick-task/REVIEW-9/TASK.md",
    ]);
    // The result's briefs must name the same paths the plans point the agents at.
    expect(result.briefs.map((b) => b.path)).toEqual([
      "/repos/api/.pick-task/REVIEW-7/TASK.md",
      "/repos/api/.pick-task/REVIEW-9/TASK.md",
    ]);
  });

  it("leaves a task batch's brief path exactly where it was", async () => {
    await openSharedWorkspace(baseReq());
    expect(writes((p) => p.endsWith("TASK.md")).map((c) => String(c[0]))).toEqual([
      "/repos/api/.claude/worktrees/ASM-1/.pick-task/TASK.md",
      "/repos/api/.claude/worktrees/ASM-2/.pick-task/TASK.md",
    ]);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/unit/engine/batchWorkspace.test.ts -t "promptTemplate"` then `-t "sub-directory"`
Expected: the first two FAIL (unknown properties are a type error, then wrong paths); the third PASSES already and must keep passing.

- [ ] **Step 3: Implement**

Two more fields on `BatchTask`:

```ts
  /** Overrides the shared `promptTemplate` for this task only. A review batch
   *  pre-renders {repo}/{number}/{author} per PR — placeholders one shared
   *  template cannot carry. Absent uses the shared template, as always. */
  promptTemplate?: string;
  /** Sub-directory under `.pick-task/` for this task's brief. Reviews pass
   *  `REVIEW-<n>` so two PRs sharing one checkout cannot overwrite each other's
   *  brief. Absent keeps `.pick-task/TASK.md`. */
  briefSubdir?: string;
```

In the brief loop, replace the two path lines:

```ts
      // The subdir is part of BRIEF_DIR's tree, so `ensureGitExcluded(s.path, ".pick-task/")`
      // below still covers it — no new exclude rule is needed.
      const dir = t.briefSubdir ? path.join(s.path, BRIEF_DIR, t.briefSubdir) : path.join(s.path, BRIEF_DIR);
      fs.mkdirSync(dir, { recursive: true });
      const briefPath = path.join(dir, BRIEF_FILE);
```

In the seeding loop, replace the `agentPrompt` call's third argument:

```ts
      const prompt = agentPrompt(t.ticket, mentions, t.promptTemplate ?? promptTemplate, briefPathFor.get(t.ticket.key));
```

- [ ] **Step 4: Run the whole file to verify**

Run: `npx vitest run test/unit/engine/batchWorkspace.test.ts`
Expected: PASS, all tests, including every pre-existing one.

- [ ] **Step 5: Mutation-check**

Swap `t.promptTemplate ?? promptTemplate` for `promptTemplate` → the promptTemplate test must FAIL. Drop the `t.briefSubdir ?` branch → the sub-directory test must FAIL. Restore both.

- [ ] **Step 6: Commit**

```bash
git add src/engine/batchWorkspace.ts test/unit/engine/batchWorkspace.test.ts
git commit -m "feat(batch): per-task prompt template and brief sub-directory"
```

---

### Task 3: the read-only review mode

A mode that reads the PR at its own revision instead of checking it out. **It must NOT be added to `DEFAULT_REVIEW_REQUEST_MODES`**: `resolveReviewMode` asks whenever there is more than one mode and none is pinned, and `test/unit/deckView.test.ts:3010` ("does not ask which mode to use when only the stock one is configured") asserts a stock single-row launch shows no picker. It would also shift `shippedReviewRequestModes`, which telemetry's `modeCounts` diffs against.

**Files:**
- Create: `src/engine/review/batch.ts`
- Create: `test/unit/engine/review/batch.test.ts`

**Interfaces:**
- Consumes: `PromptMode` from `src/types.ts`.
- Produces: `READ_ONLY_REVIEW_MODE_ID: string`, `readOnlyReviewMode(forge: string): PromptMode`, `batchReviewModes(modes: PromptMode[], forge: string): PromptMode[]`, `needsWorktrees(mode: PromptMode): boolean`. Task 7 calls all four.

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine/review/batch.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  READ_ONLY_REVIEW_MODE_ID,
  batchReviewModes,
  needsWorktrees,
  readOnlyReviewMode,
} from "../../../../src/engine/review/batch";
import { DEFAULT_REVIEW_REQUEST_MODES } from "../../../../src/config";
import type { PromptMode } from "../../../../src/types";

const backend: PromptMode = { id: "backend", label: "Backend services", prompt: "BE {number}" };

describe("readOnlyReviewMode", () => {
  it("tells the agent not to check the branch out, and how to read it instead", () => {
    const m = readOnlyReviewMode("github");
    expect(m.id).toBe(READ_ONLY_REVIEW_MODE_ID);
    expect(m.prompt).toContain("Do NOT check the branch out");
    expect(m.prompt).toContain("git fetch origin pull/{number}/head");
    expect(m.prompt).toContain("git show FETCH_HEAD:");
    // The findings file is the one the strip already looks for.
    expect(m.prompt).toContain(".pick-task/REVIEW-{number}.md");
    // Never posts: the human submits the review.
    expect(m.prompt).toContain("Do not post anything");
  });

  it("names GitLab's own ref and vocabulary under the gitlab forge", () => {
    const m = readOnlyReviewMode("gitlab");
    expect(m.prompt).toContain("refs/merge-requests/{number}/head");
    expect(m.prompt).toContain("merge request");
    expect(m.prompt).not.toContain("pull request");
  });

  it("is not one of the shipped review modes", () => {
    // A second built-in would raise a QuickPick on every stock single-row launch —
    // see test/unit/deckView.test.ts "does not ask which mode to use…".
    expect(DEFAULT_REVIEW_REQUEST_MODES.some((m) => m.id === READ_ONLY_REVIEW_MODE_ID)).toBe(false);
  });
});

describe("batchReviewModes", () => {
  it("offers read-only first, then the user's own modes", () => {
    expect(batchReviewModes([backend], "github").map((m) => m.id)).toEqual(["read-only", "backend"]);
  });

  it("keeps the user's own entry when they already declared that id", () => {
    // Their wording wins, in their position — the batch adds a mode, never overrides one.
    const mine: PromptMode = { id: "read-only", label: "My read-only", prompt: "MINE" };
    const out = batchReviewModes([backend, mine], "github");
    expect(out.map((m) => m.id)).toEqual(["backend", "read-only"]);
    expect(out[1].prompt).toBe("MINE");
  });
});

describe("needsWorktrees", () => {
  it("is false only for the read-only mode", () => {
    expect(needsWorktrees(readOnlyReviewMode("github"))).toBe(false);
    expect(needsWorktrees(DEFAULT_REVIEW_REQUEST_MODES[0])).toBe(true);
  });

  it("assumes an unknown custom mode checks out", () => {
    // The safe answer: a worktree is the only thing that actually PREVENTS a
    // checkout from landing in the user's own tree, so anything we can't vouch
    // for gets one.
    expect(needsWorktrees(backend)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/engine/review/batch.test.ts`
Expected: FAIL — cannot resolve `src/engine/review/batch`.

- [ ] **Step 3: Implement**

Create `src/engine/review/batch.ts`. **Type-only imports** for anything that reaches `fs`/`vscode`, so this module stays runtime-pure:

```ts
import type { PromptMode } from "../../types";

/** The batch-only read-only mode's id. Deliberately NOT in
 *  `DEFAULT_REVIEW_REQUEST_MODES`: a second shipped mode would make
 *  `resolveReviewMode` raise a picker on every stock single-row launch, which
 *  `test/unit/deckView.test.ts` asserts never happens. A user who wants it per-row
 *  can declare this id in their own `agentFlow.reviewRequestModes`. */
export const READ_ONLY_REVIEW_MODE_ID = "read-only";

/** GitHub wording. `{repo}` `{number}` `{author}` are substituted per PR by
 *  `renderReviewTemplate`; `{key}` `{summary}` `{url}` `{brief}` `{files}` later, by
 *  `renderPrompt` inside the launch — the same two stages the single-row path uses. */
const READ_ONLY_GITHUB_PROMPT =
  'Review pull request {url} — {repo}#{number}, "{summary}", by {author}. ' +
  "Do NOT check the branch out — this repo may be someone's live checkout, and other reviews may be running beside you. " +
  "Fetch the PR's own commit instead: `git fetch origin pull/{number}/head` gives you FETCH_HEAD, and " +
  "`git merge-base HEAD FETCH_HEAD` gives you its base. Read the diff with `git diff <base>...FETCH_HEAD`, and read any " +
  "file at the PR's own revision with `git show FETCH_HEAD:<path>` — never from the working tree, which is on a different commit. " +
  "Assess correctness, edge cases, tests, and anything that would break in production. " +
  "Write your findings to `.pick-task/REVIEW-{number}.md` as a short prioritised list — most serious first, " +
  "each with the file and line it refers to. Do not post anything to GitHub; the human submits the review.{files}";

/** The GitLab wording: substitution-only, exactly the relationship
 *  `GITLAB_REVIEW_REQUEST_PROMPT` already has with its GitHub twin. Three
 *  substitutions — the ref a merge request lives on, "merge request" for "pull
 *  request", and GitLab's own "target branch" for "base branch". */
const READ_ONLY_GITLAB_PROMPT =
  'Review merge request {url} — {repo}!{number}, "{summary}", by {author}. ' +
  "Do NOT check the branch out — this repo may be someone's live checkout, and other reviews may be running beside you. " +
  "Fetch the merge request's own commit instead: `git fetch origin refs/merge-requests/{number}/head` gives you FETCH_HEAD, and " +
  "`git merge-base HEAD FETCH_HEAD` gives you its target branch point. Read the diff with `git diff <target>...FETCH_HEAD`, and read any " +
  "file at the merge request's own revision with `git show FETCH_HEAD:<path>` — never from the working tree, which is on a different commit. " +
  "Assess correctness, edge cases, tests, and anything that would break in production. " +
  "Write your findings to `.pick-task/REVIEW-{number}.md` as a short prioritised list — most serious first, " +
  "each with the file and line it refers to. Do not post anything to GitLab; the human submits the review.{files}";

/** The read-only mode this forge SHIPS. Forge-flavoured for one reason only: the ref
 *  a request lives on is spelled differently. Same shape as
 *  `shippedReviewRequestModes`, and never added to it. */
export function readOnlyReviewMode(forge: string): PromptMode {
  return {
    id: READ_ONLY_REVIEW_MODE_ID,
    label: "Read-only review",
    detail: "Reads the PR without checking it out — several can share one window. Can't run tests.",
    prompt: forge === "gitlab" ? READ_ONLY_GITLAB_PROMPT : READ_ONLY_GITHUB_PROMPT,
  };
}

/** The modes a batch offers: read-only first, then whatever `reviewRequestModes`
 *  resolved to. A single-row launch never sees this list. A user who already declared
 *  the `read-only` id keeps their own entry, in their own position — this adds a mode,
 *  it never overrides one. */
export function batchReviewModes(modes: PromptMode[], forge: string): PromptMode[] {
  if (modes.some((m) => m.id === READ_ONLY_REVIEW_MODE_ID)) return modes;
  return [readOnlyReviewMode(forge), ...modes];
}

/** Whether this mode's prompt checks the branch out, and therefore needs a worktree.
 *  Keyed on the id rather than sniffing the prompt text: the id is a contract, a
 *  substring match is a guess. Anything that is not the read-only mode gets the safe
 *  answer, because the worktree is the only thing that actually PREVENTS a checkout
 *  from landing in the user's own tree. */
export function needsWorktrees(mode: PromptMode): boolean {
  return mode.id !== READ_ONLY_REVIEW_MODE_ID;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/engine/review/batch.test.ts`
Expected: PASS (10 assertions across 7 tests).

- [ ] **Step 5: Mutation-check**

Flip `needsWorktrees` to `return true;` → the read-only case must FAIL. Drop the `modes.some(...)` guard in `batchReviewModes` → "keeps the user's own entry" must FAIL. Restore both.

- [ ] **Step 6: Commit**

```bash
git add src/engine/review/batch.ts test/unit/engine/review/batch.test.ts
git commit -m "feat(review): a read-only review mode for batches"
```

---

### Task 4: planning a batch — `planReviewBatch` and `toBatchTask`

Turn selected rows into the shape `openSharedWorkspace` consumes. **Split into two functions on purpose:** a `BatchTask` requires its `services`, and under a checkout mode those are worktrees that do not exist until the confirm, the mode and the destination have all been answered. Planning therefore stops one step short of a `BatchTask`, and nothing in this module ever touches git.

**Files:**
- Modify: `src/engine/review/batch.ts`
- Modify: `test/unit/engine/review/batch.test.ts`

**Interfaces:**
- Consumes: `readOnlyReviewMode`/`needsWorktrees` (Task 3); `reviewRunKey` and `renderReviewTemplate` from `src/engine/review/launch.ts` (both already exported and runtime-pure); `BatchTask` from `src/engine/batchWorkspace.ts` (Tasks 1–2) as a **type-only** import.
- Produces: `interface ReviewBatchItem`, `planReviewBatch(requests: ReviewRequest[], mode: PromptMode): { items: ReviewBatchItem[]; skipped: string[] }`, `toBatchTask(item: ReviewBatchItem, services: ServiceRef[]): BatchTask`. Task 7 calls both.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/engine/review/batch.test.ts`. Add these imports to the existing import block: `planReviewBatch`, `toBatchTask` from the module; `reviewRunKey` from `../../../../src/engine/review/launch`; and `type ReviewRequest` from `../../../../src/types`.

```ts
const rq = (over: Partial<ReviewRequest> = {}): ReviewRequest => ({
  id: "CyberJackGit/aws-ops#8491", repo: "CyberJackGit/aws-ops", repoName: "aws-ops",
  number: 8491, title: "isolate renew queue", url: "https://github.com/CyberJackGit/aws-ops/pull/8491",
  author: "einavsaad", isDraft: false, createdAt: 1, updatedAt: 2,
  additions: 350, deletions: 4, changedFiles: 7,
  ci: "passing", review: "review_required", mergeable: "clean",
  localPath: "/repos/aws-ops", runKey: null, draftPath: null,
  ...over,
});

describe("planReviewBatch", () => {
  const mode = readOnlyReviewMode("github");

  it("plans one item per reviewable PR, keyed exactly as a single launch would be", () => {
    // The key IS the run key: a batched review and a single one must be the same run,
    // or the strip would show one row as launched and the other as idle.
    const { items, skipped } = planReviewBatch([rq()], mode);
    expect(skipped).toEqual([]);
    expect(items).toHaveLength(1);
    expect(items[0].key).toBe(reviewRunKey("aws-ops", 8491));
    expect(items[0].ticket).toEqual({
      key: reviewRunKey("aws-ops", 8491),
      summary: "Review aws-ops#8491: isolate renew queue",
      url: "https://github.com/CyberJackGit/aws-ops/pull/8491",
    });
    expect(items[0].briefSubdir).toBe("REVIEW-8491");
    expect(items[0].base).toEqual({ name: "aws-ops", path: "/repos/aws-ops", isGit: true });
  });

  it("renders each PR's own review placeholders into its template", () => {
    const { items } = planReviewBatch([rq(), rq({ id: "b#12", repoName: "bite-me", repo: "oz/bite-me", number: 12, author: "sam" })], mode);
    expect(items[0].promptTemplate).toContain("CyberJackGit/aws-ops#8491");
    expect(items[0].promptTemplate).toContain("by einavsaad");
    expect(items[1].promptTemplate).toContain("oz/bite-me#12");
    expect(items[1].promptTemplate).toContain("by sam");
    // The later-stage placeholders are untouched — renderPrompt fills them at launch.
    expect(items[0].promptTemplate).toContain("{summary}");
    expect(items[0].promptTemplate).toContain("{files}");
  });

  it("skips a PR whose repo is not checked out, naming each repo once", () => {
    const { items, skipped } = planReviewBatch(
      [rq(), rq({ id: "x#1", repoName: "ext-svc", localPath: null, number: 1 }), rq({ id: "x#2", repoName: "ext-svc", localPath: null, number: 2 })],
      mode,
    );
    expect(items.map((i) => i.key)).toEqual([reviewRunKey("aws-ops", 8491)]);
    expect(skipped).toEqual(["ext-svc"]);
  });

  it("plans nothing, and skips everything, when no selected repo is checked out", () => {
    const { items, skipped } = planReviewBatch([rq({ localPath: null })], mode);
    expect(items).toEqual([]);
    expect(skipped).toEqual(["aws-ops"]);
  });
});

describe("toBatchTask", () => {
  it("finishes an item into a review-kinded BatchTask with the services it was given", () => {
    const { items } = planReviewBatch([rq()], readOnlyReviewMode("github"));
    const wt = [{ name: "aws-ops", path: "/repos/aws-ops/.claude/worktrees/review-aws-ops-8491", isGit: true }];
    const task = toBatchTask(items[0], wt);
    expect(task.kind).toBe("review");
    expect(task.services).toBe(wt);
    expect(task.promptTemplate).toBe(items[0].promptTemplate);
    expect(task.briefSubdir).toBe("REVIEW-8491");
    expect(task.ticket).toEqual(items[0].ticket);
    // descriptionText drives file-hint matching; a review has no ticket description.
    expect(task.descriptionText).toBe("");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/engine/review/batch.test.ts`
Expected: FAIL — `planReviewBatch` / `toBatchTask` are not exported.

- [ ] **Step 3: Implement**

Add to `src/engine/review/batch.ts`. Note the two new type-only imports at the top:

```ts
import type { PromptMode, ReviewRequest, ServiceRef } from "../../types";
import type { BatchTask } from "../batchWorkspace";
import { renderReviewTemplate, reviewRunKey } from "./launch";
```

```ts
/** One planned review, one step short of a `BatchTask`. Everything here is decided
 *  before the destination is known; only `services` is still missing, because under a
 *  checkout mode that is a worktree nothing has made yet. */
export interface ReviewBatchItem {
  /** The run key — `reviewRunKey(repoName, number)`, the same key a single launch uses,
   *  so a batched review and a single one are the same run. */
  key: string;
  ticket: { key: string; summary: string; url: string };
  planMd: string;
  /** The chosen mode's prompt with the review-only placeholders already filled. */
  promptTemplate: string;
  /** `REVIEW-<n>` — so two PRs sharing one checkout cannot overwrite each other's brief. */
  briefSubdir: string;
  /** The checkout a worktree would be cut from, and the service itself under read-only. */
  base: ServiceRef;
  /** The row this came from, for the caller's toasts. */
  request: ReviewRequest;
}

/** Plan a batch: one item per reviewable PR, and the repo names that could not be
 *  reviewed at all. A PR with no `localPath` is in a repo this machine has not
 *  checked out — its own row's launch already refuses, and a batch says so once per
 *  repo rather than once per PR. Pure: no git, no fs, no vscode. */
export function planReviewBatch(
  requests: ReviewRequest[],
  mode: PromptMode,
): { items: ReviewBatchItem[]; skipped: string[] } {
  const items: ReviewBatchItem[] = [];
  const skipped: string[] = [];
  for (const r of requests) {
    if (!r.localPath) {
      if (!skipped.includes(r.repoName)) skipped.push(r.repoName);
      continue;
    }
    const key = reviewRunKey(r.repoName, r.number);
    items.push({
      key,
      // Summary and planMd mirror `launchReview`'s wording exactly, so a batched
      // review's card and run record are indistinguishable from a single one's.
      ticket: { key, summary: `Review ${r.repoName}#${r.number}: ${r.title}`, url: r.url },
      planMd: `## Review: ${r.repo}#${r.number}\n\n${r.title}\n\nOpened by @${r.author}. ${r.url}`,
      promptTemplate: renderReviewTemplate(mode.prompt, { repo: r.repo, number: r.number, author: r.author }),
      briefSubdir: `REVIEW-${r.number}`,
      base: { name: r.repoName, path: r.localPath, isGit: true },
      request: r,
    });
  }
  return { items, skipped };
}

/** Finish a planned item once its services are known — the worktree under a checkout
 *  mode, the checkout itself under read-only. */
export function toBatchTask(item: ReviewBatchItem, services: ServiceRef[]): BatchTask {
  return {
    ticket: item.ticket,
    planMd: item.planMd,
    descriptionText: "", // a review has no ticket description to mine file hints from
    services,
    kind: "review",
    promptTemplate: item.promptTemplate,
    briefSubdir: item.briefSubdir,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/engine/review/batch.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the module stayed runtime-pure**

Run: `npx vitest run test/webview/webviewGraph.test.ts && npm run build`
Expected: both PASS. (`batch.ts` is host-side, but its only value-level import is `./launch`, which is type-only beyond `types.ts` — keep it that way.)

- [ ] **Step 6: Mutation-check**

Change `briefSubdir` to a constant `"REVIEW"` → the "skips a PR…"/"plans one item…" tests still pass but the Task 2 collision returns, so also assert it here: temporarily make it constant and confirm the `briefSubdir` assertion FAILS. Remove the `if (!skipped.includes(...))` dedupe → the "naming each repo once" test must FAIL. Restore both.

- [ ] **Step 7: Commit**

```bash
git add src/engine/review/batch.ts test/unit/engine/review/batch.test.ts
git commit -m "feat(review): plan a batch of reviews into shared-workspace tasks"
```

---

### Task 5: extract destination picking out of `TasksView`

The Deck has no destination picker today — a review has always opened its own window — and `chooseOpenTarget` plus its `OpenTarget` type are private to `tasksView.ts`. Both views must resolve a destination identically: it honours `agentFlow.openIn`, and it refuses "this window" when the window has no identity (a window with no identity cannot be named by a plan match, so it cannot hold a seeded session). **This task is move-only: no behaviour changes.**

**Files:**
- Create: `src/destination.ts`
- Modify: `src/tasksView.ts` (delete the moved code, import instead — `OpenTarget` ~line 191, `chooseOpenTarget` ~line 2949, `pickExistingWorkspace` ~line 3020, `liveWindowItems` ~line 2987, `liveWindows` ~line 2995; call sites at 246, 658, 1196, 1497, 2214)
- Test: `test/unit/destination.test.ts` (new), and the existing `test/unit/tasksView.test.ts` must pass **unmodified**

**Interfaces:**
- Consumes: `AgentFlowConfig` from `src/config.ts`; `readLiveWindows`, `windowIdentity`, `defaultWindowsDir`, `currentWindow`, `PresenceRecord` from `src/engine/presence.ts`; `listWorkspaceFiles` from `src/engine/workspace.ts`.
- Produces: `export type OpenTarget`, `export function chooseOpenTarget(cfg: AgentFlowConfig, toast: (level: "success" | "error" | "info", message: string) => void): Promise<OpenTarget | undefined>`, `export function liveWindows(): PresenceRecord[]`. Task 7 calls `chooseOpenTarget`.

- [ ] **Step 1: Create the module by moving the code verbatim**

Create `src/destination.ts` containing, moved unchanged except as noted:

- the `OpenTarget` union, now `export type OpenTarget`, with its existing doc comment;
- `liveWindows(): PresenceRecord[]` — exported, body unchanged;
- `liveWindowItems()` — module-level, body unchanged (it already only calls `liveWindows()`);
- `pickExistingWorkspace(cfg: AgentFlowConfig)` — module-level, body unchanged;
- `chooseOpenTarget(cfg, toast)` — body unchanged except `this.toast(...)` becomes `toast(...)`, `this.pickExistingWorkspace(cfg)` becomes `pickExistingWorkspace(cfg)`, and `this.liveWindowItems()` becomes `liveWindowItems()`.

Add this header comment so the next reader knows why it is its own file:

```ts
// Where a launch opens: a new window, this one, a saved .code-workspace, or a window
// already open. Extracted from tasksView.ts when the Deck's review batch needed the
// same four answers — two views resolving a destination differently is a bug waiting
// to happen, and this is the file that stops it. `toast` is injected because each view
// owns its own surface; everything else here is module-level and stateless.
```

In `tasksView.ts`: delete the five moved members, add
`import { chooseOpenTarget, liveWindows, type OpenTarget } from "./destination";`,
and update the call sites — `this.chooseOpenTarget(cfg)` → `chooseOpenTarget(cfg, (l, m) => this.toast(l, m))` (3 sites), `this.liveWindows()` → `liveWindows()` (2 sites). Leave everything else alone.

- [ ] **Step 2: Prove the move changed nothing**

Run: `npm run typecheck` then `npx vitest run test/unit/tasksView.test.ts` (timeout 600000)
Expected: typecheck clean, and **every existing tasksView test passes unmodified**. If any test needed editing, STOP — the move was not behaviour-preserving. Report what diverged.

- [ ] **Step 3: Write the new module's own test**

Create `test/unit/destination.test.ts`. Mirror how `test/unit/tasksView.test.ts` mocks `presence` and drives `window.showQuickPick` — read that file's setup first and reuse its idiom rather than inventing one.

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { window } from "./../_mocks/vscode";
import { chooseOpenTarget } from "../../src/destination";
import type { AgentFlowConfig } from "../../src/config";

const cfg = (over: Partial<AgentFlowConfig> = {}) => ({ openIn: "ask", trackOpenWindows: false, workspaceDir: "/ws", ...over }) as AgentFlowConfig;

beforeEach(() => { window.showQuickPick.mockReset(); });

describe("chooseOpenTarget", () => {
  it("honours openIn: new-window without asking", async () => {
    expect(await chooseOpenTarget(cfg({ openIn: "new-window" }), () => {})).toEqual({ kind: "new" });
    expect(window.showQuickPick).not.toHaveBeenCalled();
  });

  it("falls back to a new window, with a toast, when this window has no identity", async () => {
    // A window with no saved workspace file and no single folder cannot be named by a
    // plan match, so it cannot hold a seeded session — the setting cannot force it.
    const toast = vi.fn();
    expect(await chooseOpenTarget(cfg({ openIn: "this-window" }), toast)).toEqual({ kind: "new" });
    expect(toast).toHaveBeenCalledWith("info", expect.stringContaining("can't hold a session"));
  });

  it("returns undefined when the picker is dismissed", async () => {
    window.showQuickPick.mockResolvedValueOnce(undefined);
    expect(await chooseOpenTarget(cfg(), () => {})).toBeUndefined();
  });
});
```

If the vscode mock's `currentWindow`/presence plumbing makes the second case awkward, follow whatever `tasksView.test.ts` already does for the same branch — do not weaken the assertion to fit.

- [ ] **Step 4: Run it**

Run: `npx vitest run test/unit/destination.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/destination.ts src/tasksView.ts test/unit/destination.test.ts
git commit -m "refactor: extract destination picking so the Deck can share it"
```

---

### Task 6: extract the batch's agent question

A shared window seeds every session from its own plan file and **never calls `openWorkspace`**, so nothing downstream can raise the agent picker. Under `agentFlow.agentProvider: "ask"` a batch that does not resolve the agent up front degrades every session to Claude Code — an agent the user did not pick, minutes after they picked one. `openSharedWorkspace` takes a `provider` pin for exactly this, and `TasksView` has the two private helpers that produce it. The Deck has neither. **Move-only, like Task 5.**

**Files:**
- Create: `src/agentPick.ts`
- Modify: `src/tasksView.ts` (delete `resolveBatchProvider` ~line 2509 and `providerPin` ~line 2539; import instead; call sites ~2188, 2252, 2361)
- Test: `test/unit/agentPick.test.ts` (new); `test/unit/tasksView.test.ts` must pass **unmodified**

**Interfaces:**
- Consumes: `AgentFlowConfig`, `AgentProvider`, `hostProviders`, `providerLabel`, `resolvedProvider` from `src/config.ts`.
- Produces: `resolveBatchProvider(cfg: AgentFlowConfig, isBatch: boolean): Promise<AgentProvider | undefined>`, `providerPin(cfg: AgentFlowConfig, provider: AgentProvider): { provider?: AgentProvider }`. Task 7 calls both.

- [ ] **Step 1: Move both functions verbatim**

Create `src/agentPick.ts` with both bodies unchanged (they reference only `cfg`, `vscode` and the `config.ts` helpers — no `this`), keeping every existing comment: the "one possible agent is not a question" short-circuit, the "SAME title as the picker in openWorkspace" note, and `providerPin`'s reason for returning `{}` under a fixed setting (absent is how "read the setting live" is spelled). Add a header:

```ts
// Which agent a multi-session launch seeds. Extracted from tasksView.ts when the
// Deck's review batch needed the same answer: a shared window seeds from plan files
// and can never ask later, so the question has to be settled before anything opens.
```

In `tasksView.ts`, delete both members and add `import { providerPin, resolveBatchProvider } from "./agentPick";`, then drop the `this.` at the three call sites.

- [ ] **Step 2: Prove the move changed nothing**

Run: `npm run typecheck` then `npx vitest run test/unit/tasksView.test.ts` (timeout 600000)
Expected: clean, and every existing tasksView test passes **unmodified**. If one needed editing, STOP and report.

- [ ] **Step 3: Write the module's own test**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { window, setConfig } from "../_mocks/vscode";
import { providerPin, resolveBatchProvider } from "../../src/agentPick";
import { getConfig } from "../../src/config";

beforeEach(() => { window.showQuickPick.mockReset(); });

describe("resolveBatchProvider", () => {
  it("does not ask when the setting names an agent", async () => {
    setConfig({ agentProvider: "cursor" });
    expect(await resolveBatchProvider(getConfig(), true)).toBe("cursor");
    expect(window.showQuickPick).not.toHaveBeenCalled();
  });

  it("does not ask when seeding is off", async () => {
    setConfig({ agentProvider: "ask", seedAgent: false });
    await resolveBatchProvider(getConfig(), true);
    expect(window.showQuickPick).not.toHaveBeenCalled();
  });

  it("returns undefined when the picker is dismissed, so the caller can abandon", async () => {
    setConfig({ agentProvider: "ask", seedAgent: true });
    window.showQuickPick.mockResolvedValueOnce(undefined);
    expect(await resolveBatchProvider(getConfig(), true)).toBeUndefined();
  });
});

describe("providerPin", () => {
  it("pins only under ask — absent is how 'read the setting live' is spelled", () => {
    setConfig({ agentProvider: "ask" });
    expect(providerPin(getConfig(), "cursor")).toEqual({ provider: "cursor" });
    setConfig({ agentProvider: "claude" });
    expect(providerPin(getConfig(), "cursor")).toEqual({});
  });
});
```

If `hostProviders()` returns a single provider on the test platform, the dismissal case will short-circuit before the picker — check what `test/unit/tasksView.test.ts` does about that (it exercises the same function) and follow it.

- [ ] **Step 4: Run it**

Run: `npx vitest run test/unit/agentPick.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agentPick.ts src/tasksView.ts test/unit/agentPick.test.ts
git commit -m "refactor: extract the batch agent question so the Deck can share it"
```

---

### Task 7: `launchReviewBatch` on the host

The orchestration. Every question that can cancel is asked **before** anything is created, because `createWorktrees` leaves a worktree and a branch behind on every Escape — the same reason `launchReviewFor` resolves its mode up front.

Two shapes, and the split is not the destination alone:

- **Separate windows** — today's single-PR launch, N times over, through `launchReview`. It owns its own worktree and its own refusal to run without one, so this path never pre-creates anything. Read-only's saving is worktrees *within one window*; a window each is already isolated.
- **One window** (this window, one new window, an existing workspace, a live folder) — `openSharedWorkspace`, with worktrees only when the mode checks out.

**Files:**
- Modify: `src/types.ts` (~line 598, beside `deck:reviewLaunch`)
- Modify: `src/deckView.ts` (new method after `launchReviewFor` ~line 2053; new `case` ~line 2756; new imports)
- Test: `test/unit/deckView.test.ts`

**Interfaces:**
- Consumes: `batchReviewModes`, `needsWorktrees`, `planReviewBatch`, `toBatchTask`, `ReviewBatchItem` (Tasks 3–4); `openSharedWorkspace` (Tasks 1–2); `chooseOpenTarget` (Task 5); `resolveBatchProvider`, `providerPin` (Task 6); `resolveReviewMode`, `launchReview`, `createWorktrees`, `openWorkspace`, `currentWindow` — all already imported by `deckView.ts` except `openSharedWorkspace`, `chooseOpenTarget` and the two from Task 6.
- Produces: `{ type: "deck:reviewBatch"; ids: string[] }`, handled by `launchReviewBatch(ids)`. Task 9 sends it.

- [ ] **Step 1: Add `h.openSharedWorkspace` to the suite's mocks**

`test/unit/deckView.test.ts` does not mock `batchWorkspace` yet. Add to the `vi.hoisted` block (~line 111, beside `launchReview`):

```ts
  openSharedWorkspace: vi.fn(async (_req: unknown) => ({ opened: true, briefs: [], seeded: 0 })),
```

and a module mock beside the existing `vi.mock("../../src/engine/review/launch", …)` (~line 418), following that mock's own pattern of passing everything else through:

```ts
vi.mock("../../src/engine/batchWorkspace", async () => {
  const actual = await vi.importActual<typeof import("../../src/engine/batchWorkspace")>("../../src/engine/batchWorkspace");
  return { ...actual, openSharedWorkspace: (...args: Parameters<typeof actual.openSharedWorkspace>) => h.openSharedWorkspace(...args) };
});
```

- [ ] **Step 2: Write the failing tests**

Append to the review `describe` block that holds "does not ask which mode to use…". Import `readOnlyReviewMode` from `../../src/engine/review/batch` and use `DEFAULT_REVIEW_REQUEST_MODES` from `../../src/config` (already imported there for other tests — check before adding).

```ts
  // ── the batch ─────────────────────────────────────────────────────────────
  const pickMode = (mode: unknown) => window.showQuickPick.mockResolvedValueOnce({ label: "m", mode });
  const pickTarget = (target: unknown) => window.showQuickPick.mockResolvedValueOnce({ label: "t", target });
  const pickLayout = (shared: boolean) => window.showQuickPick.mockResolvedValueOnce({ label: "l", shared });

  it("asks the cost, then the mode, then the destination — in that order", async () => {
    setConfig({ batchLaunchConfirmThreshold: 1 });
    const p = await showAndWarm();
    window.showWarningMessage.mockResolvedValueOnce(undefined); // refused
    await p._fire({ type: "deck:reviewBatch", ids: [TWO_IDS[0], TWO_IDS[1]] });
    expect(window.showWarningMessage).toHaveBeenCalled();
    // Nothing else was asked, and nothing was created.
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(h.createWorktrees).not.toHaveBeenCalled();
    expect(h.openSharedWorkspace).not.toHaveBeenCalled();
  });

  it("opens one shared workspace with a review-kinded task per PR", async () => {
    const p = await showAndWarm();
    pickMode(readOnlyReviewMode("github"));
    pickTarget({ kind: "current" });
    await p._fire({ type: "deck:reviewBatch", ids: [TWO_IDS[0]] });
    expect(h.openSharedWorkspace).toHaveBeenCalledTimes(1);
    const req = h.openSharedWorkspace.mock.calls[0][0] as { tasks: { kind?: string; briefSubdir?: string; promptTemplate?: string }[] };
    expect(req.tasks).toHaveLength(1);
    expect(req.tasks[0].kind).toBe("review");
    expect(req.tasks[0].briefSubdir).toBe("REVIEW-8491");
    // Pre-rendered per PR: the shared template could not have carried these.
    expect(req.tasks[0].promptTemplate).toContain("8491");
  });

  it("creates no worktree under the read-only mode", async () => {
    const p = await showAndWarm();
    pickMode(readOnlyReviewMode("github"));
    pickTarget({ kind: "current" });
    await p._fire({ type: "deck:reviewBatch", ids: [TWO_IDS[0]] });
    expect(h.createWorktrees).not.toHaveBeenCalled();
  });

  it("creates one worktree per PR under a mode that checks out", async () => {
    const p = await showAndWarm();
    pickMode(DEFAULT_REVIEW_REQUEST_MODES[0]);
    pickTarget({ kind: "current" });
    await p._fire({ type: "deck:reviewBatch", ids: [TWO_IDS[0]] });
    expect(h.createWorktrees).toHaveBeenCalledTimes(1);
  });

  it("drops a PR whose worktree could not be made rather than using the main checkout", async () => {
    // createWorktrees falls back to the checkout it was given; launchReview refuses
    // that, and a batch must not be laxer than a single launch — a `gh pr checkout`
    // there can cost work in progress.
    const p = await showAndWarm();
    h.createWorktrees.mockImplementationOnce((services: unknown) => services);
    pickMode(DEFAULT_REVIEW_REQUEST_MODES[0]);
    pickTarget({ kind: "current" });
    await p._fire({ type: "deck:reviewBatch", ids: [TWO_IDS[0]] });
    expect(h.openSharedWorkspace).not.toHaveBeenCalled();
    expect(toastText(p)).toMatch(/worktree/i);
  });

  it("asks how to lay out a multi-PR new window, and separate windows goes one at a time", async () => {
    const p = await showAndWarm();
    pickMode(readOnlyReviewMode("github"));
    pickTarget({ kind: "new" });
    pickLayout(false);
    await p._fire({ type: "deck:reviewBatch", ids: [TWO_IDS[0], TWO_IDS[1]] });
    // Separate windows IS the single-PR path, N times — worktree included.
    expect(h.launchReview).toHaveBeenCalledTimes(2);
    expect(h.openSharedWorkspace).not.toHaveBeenCalled();
  });

  it("says nothing and creates nothing when a picker is dismissed", async () => {
    const p = await showAndWarm();
    window.showQuickPick.mockResolvedValueOnce(undefined); // the mode
    await p._fire({ type: "deck:reviewBatch", ids: [TWO_IDS[0]] });
    expect(h.createWorktrees).not.toHaveBeenCalled();
    expect(h.openSharedWorkspace).not.toHaveBeenCalled();
    expect(posts(p).filter((m) => m.type === "toast")).toHaveLength(0);
  });

  it("names an un-checked-out repo once, and reviews the rest", async () => {
    // Build a queue whose second row is in a repo `discoverRepos` does not return —
    // copy the fixture the existing single-launch "isn't checked out" test uses.
    …
    expect(toastText(p)).toContain("ext-svc");
    expect(h.openSharedWorkspace).toHaveBeenCalledTimes(1);
  });

  it("never edits an existing workspace file", async () => {
    // A review batch passes no foldersToAdd, so mergeReposIntoWorkspace finds nothing
    // missing and returns without writing — the user's artifact stays byte-identical.
    const p = await showAndWarm();
    pickMode(readOnlyReviewMode("github"));
    pickTarget({ kind: "existing", file: "/ws/team.code-workspace" });
    await p._fire({ type: "deck:reviewBatch", ids: [TWO_IDS[0]] });
    const req = h.openSharedWorkspace.mock.calls[0][0] as { foldersToAdd?: unknown };
    expect(req.foldersToAdd).toBeUndefined();
  });
```

`TWO_IDS` and `toastText` may not exist in the file — check first. If they do not, define `TWO_IDS` locally from the suite's `reviewFixture()` ids and read toasts through the existing `posts(p)` helper rather than adding a second accessor.

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run test/unit/deckView.test.ts -t "batch"` (timeout 600000)
Expected: FAIL — `deck:reviewBatch` is not in the message union, then not handled.

- [ ] **Step 4: Implement**

`src/types.ts`, beside the other review messages:

```ts
  | { type: "deck:reviewBatch"; ids: string[] }
```

`src/deckView.ts` — the case:

```ts
      case "deck:reviewBatch":
        await this.launchReviewBatch(m.ids);
        break;
```

…and the method, after `launchReviewFor`:

```ts
  /** Review several PRs at once. The ordering below IS the design: every question that
   *  can be cancelled is asked before anything is created, because `createWorktrees`
   *  leaves a worktree and a branch behind on every Escape. */
  private async launchReviewBatch(ids: string[]): Promise<void> {
    const cfg = getConfig();
    const requests = ids.map((id) => this.reviewById(id)).filter((r): r is ReviewRequest => !!r);
    if (!requests.length) return; // the queue moved on before the click landed

    // 1 — the cost. The mode is not known yet, so this names sessions (always true)
    //     rather than worktrees (mode-dependent).
    if (requests.length > cfg.batchLaunchConfirmThreshold) {
      const go = await vscode.window.showWarningMessage(
        `Review ${requests.length} PRs with agents? That's ${requests.length} agent sessions.`,
        { modal: true },
        "Review",
      );
      if (go !== "Review") return;
    }

    // 2 — the mode, once, for the whole batch. This list always holds at least two
    //     modes (read-only plus the stock one), so an unpinned batch always asks:
    //     worktrees-or-not is its one consequential choice.
    const modes = batchReviewModes(cfg.reviewRequestModes, cfg.forge);
    const mode =
      resolveReviewMode(modes, cfg.reviewRequestMode) ??
      (await vscode.window.showQuickPick(
        modes.map((m) => ({ label: m.label, detail: m.detail, mode: m })),
        {
          title: `Review ${requests.length} ${requests.length === 1 ? "PR" : "PRs"} with agents`,
          ignoreFocusOut: true,
        },
      ))?.mode;
    if (!mode) return; // dismissed: nothing created, nothing said

    // 3 — plan. A row with no local checkout is named once per repo, not once per PR.
    const { items, skipped } = planReviewBatch(requests, mode);
    if (!items.length) {
      this.toast(
        "error",
        `${skipped.join(", ")} isn't checked out under your repos root — open those PRs in your browser instead.`,
      );
      return;
    }

    // 4 — where.
    const target = await chooseOpenTarget(cfg, (l, m) => this.toast(l, m));
    if (!target) return;

    // 5 — layout. Only a new window can go either way; every other destination IS a
    //     single window. One PR is an ordinary single launch and needs no layout pick.
    let shared = target.kind !== "new";
    if (target.kind === "new" && items.length > 1) {
      const p = await vscode.window.showQuickPick(
        [
          { label: "$(multiple-windows) Separate windows", detail: "One window per PR", shared: false },
          { label: "$(window) One shared window", detail: `All ${items.length} reviews in one window, a session each`, shared: true },
        ],
        { title: `Review ${items.length} PRs — how should I lay them out?`, ignoreFocusOut: true },
      );
      if (!p) return;
      shared = p.shared;
    }

    // 6 — separate windows is the single-PR path, N times over. launchReview owns its
    //     own worktree and its own refusal to run without one, so nothing is
    //     pre-created here — and read-only's saving is worktrees *within* one window,
    //     which this shape does not need.
    if (!shared) {
      let launched = 0;
      const failures: string[] = [];
      for (const item of items) {
        const res = await launchReview(
          { req: item.request, template: mode.prompt, workspaceDir: cfg.workspaceDir, seedAgent: cfg.seedAgent },
          { createWorktrees, openWorkspace, log: this.log },
        );
        if (res.ok) launched++;
        else if (!("cancelled" in res)) failures.push(res.message);
      }
      this.reviewBatchToast(launched, mode, skipped, failures);
      await this.refreshBusy();
      return;
    }

    // 7 — one window. Worktrees only when the mode checks out; under read-only the
    //     checkout itself is the service, which is exactly what lets several reviews
    //     share it.
    const ready: { item: ReviewBatchItem; services: ServiceRef[] }[] = [];
    const failures: string[] = [];
    for (const item of items) {
      if (!needsWorktrees(mode)) {
        ready.push({ item, services: [item.base] });
        continue;
      }
      const services = createWorktrees([item.base], item.key, item.request.title, this.log);
      if (services.some((s) => s.path === item.base.path)) {
        // createWorktrees falls back to the checkout it was given. This mode's prompt
        // scripts a real checkout, so proceeding would switch the user's OWN checkout
        // to a teammate's branch — the same refusal launchReview makes, per PR.
        failures.push(`couldn't create a worktree for ${item.request.repoName}#${item.request.number}`);
        continue;
      }
      ready.push({ item, services });
    }
    if (!ready.length) {
      this.toast("error", `Couldn't create a git worktree for any of them — the Agent Flow Deck output channel has the reason.`);
      return;
    }

    // 8 — the agent. A shared window seeds from plan files and can never ask later, so
    //     under `ask` this is the only chance to know which agent the user wants.
    const provider = await resolveBatchProvider(cfg, ready.length > 1);
    if (!provider) return; // the picker was dismissed

    // "current" needs this window's identity, and it can be lost between the pick and
    // here. Without it openSharedWorkspace falls through to opening a new window —
    // spawning one nobody asked for — so fail instead, before anything is opened.
    const here = target.kind === "current" ? currentWindow() : undefined;
    if (target.kind === "current" && !here) {
      this.toast("error", "This window can no longer hold a session — nothing was opened.");
      return;
    }

    try {
      await openSharedWorkspace({
        tasks: ready.map((r) => toBatchTask(r.item, r.services)),
        // Every review task carries its own pre-rendered template, so this shared one
        // is never read. The type requires a value; the mode's own prompt is the honest
        // one to give it.
        promptTemplate: mode.prompt,
        workspaceDir: cfg.workspaceDir,
        seedAgent: cfg.seedAgent,
        target,
        currentWindow: here,
        // Deliberately no foldersToAdd: a review batch never edits the user's
        // .code-workspace. mergeReposIntoWorkspace finds nothing missing and returns
        // without writing, so the file stays byte-identical, and the briefs carry
        // absolute paths regardless.
        ...providerPin(cfg, provider),
      });
    } catch (e) {
      this.toast("error", `Couldn't open the review workspace: ${e}`);
      return;
    }
    this.reviewBatchToast(ready.length, mode, skipped, failures);
    await this.refreshBusy(); // picks up the new runs so the rows show "reviewing"
  }

  /** One toast for the whole batch, never one per PR. Says what launched, what could
   *  not be, and — because the answer differs per batch — whether worktrees were made. */
  private reviewBatchToast(launched: number, mode: PromptMode, skipped: string[], failures: string[]): void {
    if (!launched) {
      this.toast("error", `Nothing was reviewed. ${failures.join("; ")}`);
      return;
    }
    const where = needsWorktrees(mode) ? "in a worktree each" : "without checking anything out";
    const parts = [`Reviewing ${launched} ${launched === 1 ? "PR" : "PRs"} ${where}.`];
    if (skipped.length) parts.push(`${skipped.join(", ")} isn't checked out — skipped.`);
    if (failures.length) parts.push(failures.join("; "));
    this.toast("success", parts.join(" "));
  }
```

Add the imports this needs at the top of `deckView.ts`: `openSharedWorkspace` from `./engine/batchWorkspace`, `chooseOpenTarget` from `./destination`, `providerPin`/`resolveBatchProvider` from `./agentPick`, and `batchReviewModes`/`needsWorktrees`/`planReviewBatch`/`toBatchTask`/`type ReviewBatchItem` from `./engine/review/batch`. `currentWindow`, `createWorktrees`, `openWorkspace`, `launchReview`, `resolveReviewMode` and `PromptMode` are already imported — check before adding a duplicate.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/unit/deckView.test.ts` (timeout 600000)
Expected: PASS — including every pre-existing review test, especially "does not ask which mode to use when only the stock one is configured", which proves the single-row path is untouched.

- [ ] **Step 6: Mutation-check**

Move the confirm below the mode picker → "in that order" must FAIL. Force `needsWorktrees` true at its call site → "creates no worktree under the read-only mode" must FAIL. Delete the `services.some(...)` guard → "drops a PR whose worktree could not be made" must FAIL. Restore all three.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/deckView.ts test/unit/deckView.test.ts
git commit -m "feat(deck): launch a review agent on several PRs at once"
```

---

### Task 8: selection in the review strip

Variant B from the mockup: a `select` toggle in the strip header swaps the caret column for checkboxes and raises a batch bar. **Every new prop is optional with a today-identical default**, so the strip renders byte-identically when they are absent and the existing `ReviewStrip.test.tsx` factory needs no edit.

**Files:**
- Modify: `src/webview/ReviewStrip.tsx`
- Modify: `src/webview/deckStyles.ts` (the `rv-` block — find it by the `.rv-strip` selector; `fd46dbc` added `.rv-go` styles there, so line numbers have moved)
- Test: `test/webview/ReviewStrip.test.tsx`

**Interfaces:**
- Consumes: nothing (pure React over props).
- Produces: optional props `selecting?: boolean`, `selected?: string[]`, `onSelectMode?: (next: boolean) => void`, `onToggle?: (id: string, shift: boolean) => void`, `onSelectAll?: () => void`, `onLaunchBatch?: () => void`. Task 9 supplies all six.

**The row's current shape** (as of `fd46dbc`, "start an agent review from a collapsed review row" — read it before you start):

```
.rv-row
  .rv-head            ← flex line
    button.rv-line    ← the whole row, onClick = onExpand
    button.rv-go      ← the per-row play button, onClick = onLaunch (a SIBLING, because
                          .rv-line is itself a button and a nested click would bubble)
  .rv-detail          ← only when expanded
```

**Three traps, all real:**

1. **`.rv-line` is a `<button>`.** A button cannot nest inside a button, so the checkbox must be a **`<span className="rv-chk">`** inside the existing row button — not an `<input>` and not a nested `<button>`. In select mode the row button's own `onClick` toggles instead of expanding.
2. **Hide `.rv-go` while selecting.** It launches a single review for its own row. Left visible mid-selection it invites a click that launches one PR while the user is still building a batch — two competing actions in one gesture. While `selecting`, render the head with `.rv-line` only; the batch bar's button is the sole launch.
3. **jsdom is blind to drag and to real pointer semantics.** Shift-click *is* testable (`fireEvent.click(el, { shiftKey: true })`), but confirm the feel in a real editor window in Task 10.

**Accessible-name collision.** `.rv-go` already carries `aria-label="Review with agent"`. A batch button named "Review 2 with agents" would also match `getByRole("button", { name: /Review . with agent/i })`, so **give the batch button an unambiguous accessible name** — `aria-label={`Review the ${n} selected PRs with agents`}` — and query it by that in tests. Its visible text stays the short `▶ Review 2 with agents`.

- [ ] **Step 1: Write the failing tests**

Append to `test/webview/ReviewStrip.test.tsx`, using its existing `mk` and `props` factories:

```ts
  // ── selection (batch review) ──────────────────────────────────────────────
  it("shows no select control and no batch bar by default", () => {
    render(<ReviewStrip {...props()} />);
    expect(screen.queryByText("select")).not.toBeInTheDocument();
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });

  it("offers select once the host supplies a handler", () => {
    render(<ReviewStrip {...props({ onSelectMode: vi.fn(), onToggle: vi.fn(), onLaunchBatch: vi.fn() })} />);
    expect(screen.getByText("select")).toBeInTheDocument();
  });

  it("toggles a row instead of expanding it while selecting", () => {
    const onToggle = vi.fn();
    const onExpand = vi.fn();
    render(<ReviewStrip {...props({ selecting: true, selected: [], onToggle, onExpand, onSelectMode: vi.fn(), onLaunchBatch: vi.fn() })} />);
    fireEvent.click(screen.getByText("isolate renew queue"));
    expect(onToggle).toHaveBeenCalledWith("CyberJackGit/aws-ops#8491", false);
    expect(onExpand).not.toHaveBeenCalled();
  });

  it("passes the shift key through so the host can extend a range", () => {
    const onToggle = vi.fn();
    render(<ReviewStrip {...props({ selecting: true, selected: [], onToggle, onSelectMode: vi.fn(), onLaunchBatch: vi.fn() })} />);
    fireEvent.click(screen.getByText("isolate renew queue"), { shiftKey: true });
    expect(onToggle).toHaveBeenCalledWith("CyberJackGit/aws-ops#8491", true);
  });

  it("counts the selection and launches it", () => {
    const onLaunchBatch = vi.fn();
    render(<ReviewStrip {...props({
      requests: [mk(), mk({ id: "b#2", number: 2 })], issueCount: 2,
      selecting: true, selected: ["CyberJackGit/aws-ops#8491"],
      onToggle: vi.fn(), onSelectMode: vi.fn(), onSelectAll: vi.fn(), onLaunchBatch,
    })} />);
    expect(screen.getByText(/1 selected/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Review the 1 selected PR with agents/i }));
    expect(onLaunchBatch).toHaveBeenCalled();
  });

  it("hides the per-row play button while selecting", () => {
    // Two competing launches in one gesture: .rv-go starts ONE review, the bar starts
    // the batch. While picking rows, only the bar may launch.
    render(<ReviewStrip {...props({ selecting: true, selected: [], onToggle: vi.fn(), onSelectMode: vi.fn(), onLaunchBatch: vi.fn() })} />);
    expect(screen.queryByRole("button", { name: "Review with agent" })).not.toBeInTheDocument();
  });

  it("cannot launch an empty selection", () => {
    render(<ReviewStrip {...props({ selecting: true, selected: [], onToggle: vi.fn(), onSelectMode: vi.fn(), onLaunchBatch: vi.fn() })} />);
    expect(screen.getByRole("button", { name: /Review the 0 selected PRs with agents/i })).toBeDisabled();
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/webview/ReviewStrip.test.tsx`
Expected: the first PASSES (nothing new rendered yet — it is the inert-by-default guard); the rest FAIL.

- [ ] **Step 3: Implement the strip**

Add the six optional props to `ReviewStripProps` with doc comments explaining the optionality (absent = the strip the Deck shipped before batches). In `Row`, take `selecting`, `picked` and `onToggle`; render `<span className={`rv-chk${picked ? " on" : ""}`}>{picked ? "✓" : ""}</span>` in place of `.rv-caret` while selecting, put `picked` on the row's class list, omit the `.rv-go` branch entirely while `selecting` (trap 2), and branch the row button's `onClick`:

```tsx
        onClick={(e) => (selecting && onToggle ? onToggle(r.id, e.shiftKey) : onExpand(r.id))}
```

While `selecting`, do not render `.rv-detail` at all — a row cannot be both open and being picked. In the strip header, render the `select` toggle only when `onSelectMode` is supplied, styled exactly like the `sort` buttons (`.rv-select` mirroring `.rv-sort`). Below the rows, render the batch bar only while `selecting`:

```tsx
      {p.selecting && (
        <div className="batch-bar">
          <span className="batch-count">{n} selected · shift-click for a range</span>
          <button type="button" className="batch-link" onClick={p.onSelectAll}>Select all {p.requests.length}</button>
          <button type="button" className="batch-link" onClick={() => p.onSelectMode?.(false)}>Done</button>
          <button
            type="button"
            className="batch-launch"
            disabled={n === 0}
            // Unambiguous against .rv-go's own "Review with agent" — see the
            // accessible-name note above.
            aria-label={`Review the ${n} selected PR${n === 1 ? "" : "s"} with agents`}
            onClick={p.onLaunchBatch}
          >
            ▶ Review {n} with agent{n === 1 ? "" : "s"}
          </button>
        </div>
      )}
```

In `deckStyles.ts`, add `.rv-chk`, `.rv-row.picked`, `.rv-select` and the strip's `.batch-bar` — copy the sidebar's `.batch-bar` / `.batch-count` / `.batch-launch` values from `src/webview/styles.ts` so the two batches look like one feature. Keep the house rules: the count and the shift-click hint are English, so **not** monospace; the launch button carries `--brand`, and nothing here is red.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/webview/ReviewStrip.test.tsx`
Expected: PASS, including all pre-existing tests **unmodified**.

- [ ] **Step 5: Prove the strip still cannot reach Node**

Run: `npx vitest run test/webview/webviewGraph.test.ts && npm run build`
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add src/webview/ReviewStrip.tsx src/webview/deckStyles.ts test/webview/ReviewStrip.test.tsx
git commit -m "feat(deck): select several review rows and launch them together"
```

---

### Task 9: wire the strip to the host, and the "review ready" copy

**Files:**
- Modify: `src/webview/DeckApp.tsx` (the `<ReviewStrip …>` block, ~lines 697–730)
- Modify: `src/webview/ReviewStrip.tsx` (the draft chip's wording and the header count)
- Test: `test/webview/DeckApp.test.tsx`, `test/webview/ReviewStrip.test.tsx`

**Interfaces:**
- Consumes: the six optional props (Task 8); the `deck:reviewBatch` message (Task 7).
- Produces: nothing further.

- [ ] **Step 1: Write the failing tests**

Append to the existing `describe("DeckApp review strip", …)` block in `test/webview/DeckApp.test.tsx`, using that file's `render(<DeckApp />)` / `host(reviewsMsg(…))` / `sent` idiom and its `mkReview` factory:

```ts
  const three = () => [
    mkReview(),
    mkReview({ id: "o/r#2", number: 2, title: "second fix" }),
    mkReview({ id: "o/r#3", number: 3, title: "third fix" }),
  ];

  it("posts one reviewBatch message carrying every selected id", () => {
    render(<DeckApp />);
    host(reviewsMsg([mkReview(), mkReview({ id: "o/r#2", number: 2, title: "second fix" })], 2));
    fireEvent.click(screen.getByText("select"));
    fireEvent.click(screen.getByText("a small fix"));
    fireEvent.click(screen.getByText("second fix"));
    fireEvent.click(screen.getByRole("button", { name: /Review the 2 selected PRs with agents/i }));
    // One message for the batch, not one per row — the host asks its questions once.
    expect(sent).toHaveBeenCalledWith({ type: "deck:reviewBatch", ids: ["o/r#1", "o/r#2"] });
  });

  it("extends the selection with shift-click, in queue order", () => {
    render(<DeckApp />);
    host(reviewsMsg(three(), 3));
    fireEvent.click(screen.getByText("select"));
    fireEvent.click(screen.getByText("a small fix"));
    fireEvent.click(screen.getByText("third fix"), { shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: /Review the 3 selected PRs with agents/i }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:reviewBatch", ids: ["o/r#1", "o/r#2", "o/r#3"] });
  });

  it("leaves selection mode once the batch is launched", () => {
    render(<DeckApp />);
    host(reviewsMsg([mkReview()], 1));
    fireEvent.click(screen.getByText("select"));
    fireEvent.click(screen.getByText("a small fix"));
    fireEvent.click(screen.getByRole("button", { name: /Review the 1 selected PR with agents/i }));
    // The bar is gone and the rows expand again — the gesture is over.
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });

  it("drops a selected row that leaves the queue before the launch", () => {
    // A merged PR disappears on the next poll. Launching a stale id would ask the
    // host to review a row that no longer exists.
    render(<DeckApp />);
    host(reviewsMsg([mkReview(), mkReview({ id: "o/r#2", number: 2, title: "second fix" })], 2));
    fireEvent.click(screen.getByText("select"));
    fireEvent.click(screen.getByText("a small fix"));
    fireEvent.click(screen.getByText("second fix"));
    host(reviewsMsg([mkReview()], 1)); // #2 merged
    fireEvent.click(screen.getByRole("button", { name: /Review the 1 selected PR with agents/i }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:reviewBatch", ids: ["o/r#1"] });
  });
```

In `test/webview/ReviewStrip.test.tsx`:

```ts
  it("says a review is ready rather than naming a file", () => {
    render(<ReviewStrip {...props({ requests: [mk({ draftPath: "/repos/aws-ops/.pick-task/REVIEW-8491.md" })] })} />);
    expect(screen.getByText("review ready")).toBeInTheDocument();
  });

  it("counts the ready reviews in the header when there is more than one", () => {
    render(<ReviewStrip {...props({
      requests: [mk({ draftPath: "/a" }), mk({ id: "b#2", number: 2, draftPath: "/b" })], issueCount: 2,
    })} />);
    expect(screen.getByText(/2 agent reviews ready/i)).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/webview/DeckApp.test.tsx test/webview/ReviewStrip.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `DeckApp.tsx`, hold two pieces of state beside the strip's existing ones — `const [selecting, setSelecting] = React.useState(false);` and `const [selected, setSelected] = React.useState<string[]>([]);` plus a ref for the last-toggled id (shift-click needs an anchor). Pass the six props; `onToggle(id, shift)` extends from the anchor across `reviews.requests` order when `shift` is true, otherwise toggles one id; `onLaunchBatch` sends `{ type: "deck:reviewBatch", ids: selected }`, then clears the selection and leaves selection mode. Drop ids from `selected` when a poll removes their row, so a stale id can never be launched.

In `ReviewStrip.tsx`, the chip becomes `review ready` (keep the class name — `.rv-draftchip` or the existing `.rv-draft`, whichever the row already uses, so no CSS churn), and the header gains the ready-count when two or more rows have a `draftPath`. Both are English, so neither is monospace.

- [ ] **Step 4: Run the webview suite**

Run: `npx vitest run test/webview`
Expected: PASS. Remember: assert with `waitFor`, never a bare tick — an async read can outlive a `setTimeout(0)` and land its `postMessage` in the *next* test.

- [ ] **Step 5: Commit**

```bash
git add src/webview/DeckApp.tsx src/webview/ReviewStrip.tsx test/webview
git commit -m "feat(deck): wire the review batch bar to the host"
```

---

### Task 10: docs, changelog, and the real gate

**Files:**
- Modify: `CHANGELOG.md` (under `## [Unreleased]`)
- Modify: `docs/GUIDE.md` (the review-strip section)
- Modify: `package.json` (the `agentFlow.batchLaunchConfirmThreshold` description only)
- Modify: `docs/SETTINGS.md` if it describes that setting

- [ ] **Step 1: Changelog**

One entry under `## [Unreleased]`, in the file's existing voice — what a user can now do, not what was refactored.

- [ ] **Step 2: Widen the threshold setting's description**

Its `markdownDescription` currently says "When you multi-select tasks…". It now also governs review batches. Edit the wording only — **not** the id, type or default, which `test/unit/compat.test.ts` freezes.

- [ ] **Step 3: Document the batch and the read-only mode**

In `docs/GUIDE.md`: selecting rows, the two questions, and — plainly — that read-only does not check the branch out and cannot run tests, while a checkout mode gives every PR its own worktree. Say that the read-only mode is offered by the batch and is not one of `reviewRequestModes` unless the user adds it.

- [ ] **Step 4: Run the full gate**

```bash
npm run typecheck && npm test && npm run build
```
(timeout 600000 on the test run; never pipe it through `tail`.) Then `npm run test:cov` and confirm no threshold regressed.
Expected: all green, with **no existing test edited**. If one had to change, STOP and report it.

- [ ] **Step 5: Verify in a real editor window**

jsdom cannot judge this. Launch the dev host with **VS Code's own** `code --extensionDevelopmentPath=…` (the Cursor CLI silently drops that flag) or press **F5**, then:
1. Turn on `select`, click three rows, shift-click a range — confirm rows toggle and none expands.
2. Launch read-only into "this window" — confirm no worktree appears under `.claude/worktrees/` and each agent gets its own `.pick-task/REVIEW-<n>/TASK.md`.
3. Launch Full review into one new window — confirm one worktree per PR, each a folder in that window.
4. Confirm each row shows "reviewing", then "review ready" once its draft lands, and that **Load agent's review** fills the box.

- [ ] **Step 6: Commit**

```bash
git add CHANGELOG.md docs/GUIDE.md package.json docs/SETTINGS.md
git commit -m "docs: batch review with agents"
```

---

## Plan self-review

- **Spec coverage.** Selection affordance → Tasks 8–9. Batch launch, the four destinations and the layout question → Tasks 5–7. Read-only mode → Task 3. `planReviewBatch`/`toBatchTask` → Task 4. The three `BatchTask` passthroughs → Tasks 1–2. The batch's agent question → Task 6. Confirm threshold → Task 7. Un-cloned repos skipped and named once → Tasks 4 and 7. Strip-only entry point → Task 9 (no command is registered anywhere). "Review ready" copy → Task 9. Docs and changelog → Task 10. The spec's non-goals appear as work in no task: no batch submit, no diff-only mode, no retirement work.
- **Known elisions.** One remains: the queue fixture in Task 7's "names an un-checked-out repo once" test, which needs a row whose repo the suite's `discoverRepos` mock does not return. The existing single-launch "isn't checked out" test already builds one — reuse it rather than inventing a second fixture shape. Every other test body and every line of production code is written out in full.
- **One spec correction this plan makes.** The spec called "a window each" a fifth destination. It is not: `takeBatch` models it as a *layout* answer asked only when the destination is a new window and there is more than one item, and Task 7 follows that existing shape instead. The spec's four `SharedTarget`s are unchanged.
- **One gap this plan closes that the spec missed.** A shared window seeds from plan files and never calls `openWorkspace`, so under `agentFlow.agentProvider: "ask"` a batch that does not resolve the agent up front degrades every session to Claude Code. Task 6 extracts `resolveBatchProvider`/`providerPin` and Task 7 calls them; the spec did not mention the provider at all.
- **Type consistency.** `BatchTask.kind` / `.promptTemplate` / `.briefSubdir` are named identically in Tasks 1, 2 and 4. `ReviewBatchItem` fields used by `toBatchTask` are all declared in Task 4. `needsWorktrees`, `batchReviewModes`, `planReviewBatch`, `toBatchTask`, `chooseOpenTarget` keep one signature from the task that defines them through every later use.
