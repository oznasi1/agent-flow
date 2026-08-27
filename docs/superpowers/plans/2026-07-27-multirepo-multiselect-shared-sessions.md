# Multi-repo multi-select & N sessions at the chosen destination — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user multi-select tasks with any number of repos filtered, and have the batch honour the destination pick — seeding one Claude Code session per task in the chosen window.

**Architecture:** The webview gate widens from `=== 1` to `>= 1` repos and sends the whole filter set. `takeBatch` in the host gains the standard destination chain plus a layout pick, resolves each task's repos by intersecting inference with the filter set, and dispatches to either today's one-window-per-task loop or a new `openSharedWorkspace` engine path. That path builds one workspace holding every task's worktrees as roots, writes one plan file per task all pointing at the same window, and the seeder — changed to seed *every* matching plan rather than the first — opens N Claude tabs in it.

**Tech Stack:** TypeScript, VS Code extension API, React (webview, classic JSX runtime), vitest + @testing-library/react, esbuild.

## Global Constraints

- **Repo:** `/Users/oznasi/dev/agent-flow`. Branch `multirepo-multiselect-shared-sessions` already exists and holds the spec commit. Work on it.
- **Spec:** [`docs/superpowers/specs/2026-07-27-multirepo-multiselect-shared-sessions-design.md`](../specs/2026-07-27-multirepo-multiselect-shared-sessions-design.md). Read it before starting.
- **Tests:** `npm test` (vitest). A single file: `npx vitest run test/unit/tasksView.test.ts`. A single test: `npx vitest run test/unit/tasksView.test.ts -t "name"`.
- **Typecheck:** `npm run typecheck` must pass before every commit.
- **Coverage floors** (vitest.config.ts): statements 90, branches 85, functions 85, lines 90. `npm run test:cov` must stay above them.
- **`vscode` is mocked**, not installed. Host-side tests import the hand-written mock via a relative path: `import { window, commands } from "../_mocks/vscode"`.
- **No new settings.** Do not touch `contributes.configuration` in `package.json`.
- **Do not bump the version or build a `.vsix`.** That happens at merge time, separately.
- **Comment style:** this codebase explains *why*, not *what*, in prose sentences above the code. Match it. Do not add comments that restate the line below them.
- **Worktree folder name format:** `` `${key}-${repoName}` `` — e.g. `PROJ-1-api`. Exact, no spaces (it is what `@`-mentions resolve against).
- **Shared workspace filename format:** `` `${keys[0]}+${keys.length - 1}.code-workspace` `` — e.g. `PROJ-1+2.code-workspace`.
- **Seed stagger:** `SEED_STAGGER_MS = 400`.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/types.ts` | Shared host/webview message types | Modify: `takeBatch` carries `repos: string[]` |
| `src/webview/App.tsx` | Task pool UI | Modify: gate `>= 1`, send `repos[]`, button title |
| `src/engine/workspace.ts` | Single-task open + seed handshake | Modify: export helpers, `PlanFile.seq`, seed-all loop, multi-session command |
| `src/engine/batchWorkspace.ts` | **New.** Shared-window batch assembly | Create: `openSharedWorkspace` |
| `src/tasksView.ts` | Webview controller / launch orchestration | Modify: `takeBatch` rewrite |

`batchWorkspace.ts` is a separate module rather than more of `workspace.ts` because `workspace.ts` is already ~500 lines with two distinct jobs (opening, and the seed handshake); the batch path is a third. It imports the brief/prompt/plan helpers rather than duplicating them.

**Task order and why:** Task 1 (types) unblocks everything. Task 2 (webview) and Task 3 (seeder) are independent of each other. Task 4 (`batchWorkspace`) depends on Task 3's exports. Task 5 (`takeBatch`) depends on Tasks 1, 3, and 4.

---

### Task 1: Widen the `takeBatch` message to carry a repo set

**Files:**
- Modify: `src/types.ts:160`

**Interfaces:**
- Consumes: nothing.
- Produces: `{ type: "takeBatch"; keys: string[]; repos: string[] }` in `InboundMessage`. Tasks 2 and 5 both depend on this exact shape.

This task alone breaks the build (two call sites still use `repo`). That is expected and is fixed in Tasks 2 and 5; commit it anyway so the type change is one reviewable atom, and run typecheck only at the end of Task 5.

- [ ] **Step 1: Change the message type**

In `src/types.ts`, in the `InboundMessage` union, replace:

```ts
  | { type: "takeBatch"; keys: string[]; repo: string }
```

with:

```ts
  | { type: "takeBatch"; keys: string[]; repos: string[] }
```

- [ ] **Step 2: Commit**

```bash
git add src/types.ts
git commit -m "refactor(types): takeBatch carries a repo set, not one repo"
```

---

### Task 2: Offer multi-select with any number of repos filtered

**Files:**
- Modify: `src/webview/App.tsx:312-317`, `src/webview/App.tsx:503-521`
- Test: `test/webview/App.test.tsx:289-395`

**Interfaces:**
- Consumes: `InboundMessage` `takeBatch` from Task 1.
- Produces: nothing consumed by later tasks (the host side is Task 5).

- [ ] **Step 1: Update the three existing tests that assert the old behaviour**

In `test/webview/App.test.tsx`, in the `describe("multi-select & parallel launch")` block:

Replace the test named `"hides checkboxes again once a second repo is added"` with:

```tsx
  it("keeps checkboxes when a second repo is added, showing both repos' tasks", () => {
    render(<App />);
    authed();
    apiPool();
    // Open the popup ONCE and toggle two repos — re-clicking the trigger would close it.
    fireEvent.click(screen.getByText("Filter repos"));
    const repoList = document.querySelector(".repo-list") as HTMLElement;
    fireEvent.mouseDown(within(repoList).getByText("api").closest(".repo-opt")!);
    fireEvent.mouseDown(within(repoList).getByText("billing").closest(".repo-opt")!);
    expect(checks().length).toBe(3); // PROJ-1, PROJ-2 (api) + PROJ-3 (billing)
  });
```

In the test named `"launches the checked, visible tasks with the filtered repo name"`, change the final assertion to:

```tsx
    expect(sent).toHaveBeenCalledWith({ type: "takeBatch", keys: ["PROJ-1", "PROJ-2"], repos: ["api"] });
```

In the test named `"drops a checked task from the launch once a search filter hides it"`, change the final assertion to:

```tsx
    expect(sent).toHaveBeenCalledWith({ type: "takeBatch", keys: ["PROJ-1"], repos: ["api"] });
```

- [ ] **Step 2: Add a test for the multi-repo launch payload**

Append inside the same `describe` block:

```tsx
  it("sends every selected repo when two are filtered", () => {
    render(<App />);
    authed();
    apiPool();
    fireEvent.click(screen.getByText("Filter repos"));
    const repoList = document.querySelector(".repo-list") as HTMLElement;
    fireEvent.mouseDown(within(repoList).getByText("api").closest(".repo-opt")!);
    fireEvent.mouseDown(within(repoList).getByText("billing").closest(".repo-opt")!);
    fireEvent.click(checks()[0]); // PROJ-1 (api)
    fireEvent.click(checks()[2]); // PROJ-3 (billing)
    fireEvent.click(screen.getByRole("button", { name: /Launch in parallel/i }));
    expect(sent).toHaveBeenCalledWith({
      type: "takeBatch",
      keys: ["PROJ-1", "PROJ-3"],
      repos: ["api", "billing"],
    });
  });
```

Also update the first test's name and body so it asserts the surviving gate (zero repos):

```tsx
  it("shows no checkboxes until at least one repo is filtered", () => {
    render(<App />);
    authed();
    apiPool();
    expect(checks().length).toBe(0);
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/webview/App.test.tsx -t "multi-select"`
Expected: FAIL — the two-repo tests find 0 checkboxes, and the payload assertions see `repo: "api"` instead of `repos: [...]`.

- [ ] **Step 4: Widen the gate and send the repo set**

In `src/webview/App.tsx`, replace lines 312–317:

```tsx
  // Multi-select is offered only when the repo filter resolves to exactly one repo.
  const batchMode = selectedRepos.size === 1;
  const theRepo = batchMode ? [...selectedRepos][0] : null;
  // Only currently-visible tasks are launchable: a status/search filter that hides a
  // selected card silently drops it (state is untouched, just never launched).
  const selectedVisible = batchMode ? visibleTasks.filter((t) => batchSelected.has(t.key)) : [];
```

with:

```tsx
  // Multi-select needs a repo filter — without one there is no bounded repo set to
  // map each task onto, and the host has nothing to intersect its inference against.
  const batchMode = selectedRepos.size >= 1;
  const batchRepos = [...selectedRepos];
  // Only currently-visible tasks are launchable: a status/search filter that hides a
  // selected card silently drops it (state is untouched, just never launched).
  const selectedVisible = batchMode ? visibleTasks.filter((t) => batchSelected.has(t.key)) : [];
```

- [ ] **Step 5: Update the launch button**

In the same file, replace the `title` and `onClick` of the `.batch-launch` button (lines ~513–517):

```tsx
          <button
            className="batch-launch"
            title={`Open ${selectedVisible.length} task(s) across ${batchRepos.join(", ")}, each with its own Claude Code session`}
            onClick={() => send({ type: "takeBatch", keys: selectedVisible.map((t) => t.key), repos: batchRepos })}
          >
            <PlayIcon /> Launch in parallel
          </button>
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/webview/App.test.tsx`
Expected: PASS, all tests in the file.

- [ ] **Step 7: Commit**

```bash
git add src/webview/App.tsx test/webview/App.test.tsx
git commit -m "feat(webview): offer multi-select with any number of repos filtered"
```

---

### Task 3: Seed every matching plan, not just the first

**Files:**
- Modify: `src/engine/workspace.ts:56-62`, `src/engine/workspace.ts:366-406`, `src/engine/workspace.ts:439-501`
- Test: `test/unit/engine/workspace.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, all exported from `src/engine/workspace.ts` for Task 4:
  - `export const BRIEF_DIR = ".pick-task"` and `export const BRIEF_FILE = "TASK.md"`
  - `export interface PlanFile { key: string; createdAt: number; seedAgent: boolean; remoteControl?: boolean; seq?: number; matches: { matchPath: string; prompt: string }[] }`
  - `export function briefMarkdown(t: TicketRef, planMd: string, services: ServiceRef[], thisRepo: string, files: string[]): string`
  - `export function agentPrompt(t: TicketRef, mentions: string[], template: string, briefPath?: string): string`
  - `export function writePlanFile(plan: PlanFile): void`
  - `openInEditor` and `mergeReposIntoWorkspace` are already exported.

`agentPrompt` gains an optional fourth parameter: when `briefPath` is given it is used verbatim as `{brief}`, otherwise the existing relative `` `${BRIEF_DIR}/${BRIEF_FILE}` `` is used. The shared window needs an absolute path because N worktree roots each hold that same relative path.

- [ ] **Step 1: Write the failing tests for multi-plan seeding**

In `test/unit/engine/workspace.test.ts`, inside `describe("maybeSeedAgent")`, append these tests. Note the fake-timer pattern — `seedClaudeCode` polls with `await delay(700)` and the new stagger also sleeps, so real timers would make these slow and flaky.

```ts
  it("seeds every plan matching this window, in (createdAt, seq) order", async () => {
    withWorkspaceFile();
    readdirSync.mockReturnValue(["PROJ-2-1.json", "PROJ-1-1.json"] as never);
    readFileSync.mockImplementation((p) =>
      String(p).includes("PROJ-1")
        ? planJson({ key: "PROJ-1", seq: 0, matches: [{ matchPath: "/ws/PROJ-1.code-workspace", prompt: "first" }] })
        : planJson({ key: "PROJ-2", seq: 1, matches: [{ matchPath: "/ws/PROJ-1.code-workspace", prompt: "second" }] }),
    );
    commands.getCommands.mockResolvedValue(["claude-vscode.editor.open", CLAUDE_OPEN_CMD]);
    const { context } = fakeContext();

    vi.useFakeTimers();
    const pending = maybeSeedAgent(context, () => {});
    await vi.runAllTimersAsync();
    await pending;
    vi.useRealTimers();

    const seeds = commands.executeCommand.mock.calls.filter((c) => String(c[0]).startsWith("claude-vscode."));
    expect(seeds.map((c) => c[2])).toEqual(["first", "second"]);
  });

  it("uses the new-tab command when seeding more than one session", async () => {
    withWorkspaceFile();
    readdirSync.mockReturnValue(["PROJ-1-1.json", "PROJ-2-1.json"] as never);
    readFileSync.mockImplementation((p) =>
      String(p).includes("PROJ-1")
        ? planJson({ key: "PROJ-1", seq: 0 })
        : planJson({ key: "PROJ-2", seq: 1 }),
    );
    commands.getCommands.mockResolvedValue(["claude-vscode.editor.open", CLAUDE_OPEN_CMD]);
    const { context } = fakeContext();

    vi.useFakeTimers();
    const pending = maybeSeedAgent(context, () => {});
    await vi.runAllTimersAsync();
    await pending;
    vi.useRealTimers();

    expect(commands.executeCommand).toHaveBeenCalledWith("claude-vscode.editor.open", undefined, "do it");
    expect(commands.executeCommand).not.toHaveBeenCalledWith(CLAUDE_OPEN_CMD, undefined, "do it");
  });

  it("falls back to the primary-editor command when the new-tab command is unregistered", async () => {
    withWorkspaceFile();
    readdirSync.mockReturnValue(["PROJ-1-1.json", "PROJ-2-1.json"] as never);
    readFileSync.mockImplementation((p) =>
      String(p).includes("PROJ-1") ? planJson({ key: "PROJ-1", seq: 0 }) : planJson({ key: "PROJ-2", seq: 1 }),
    );
    commands.getCommands.mockResolvedValue([CLAUDE_OPEN_CMD]);
    const { context } = fakeContext();

    vi.useFakeTimers();
    const pending = maybeSeedAgent(context, () => {});
    await vi.runAllTimersAsync();
    await pending;
    vi.useRealTimers();

    expect(commands.executeCommand).toHaveBeenCalledWith(CLAUDE_OPEN_CMD, undefined, "do it");
  });

  it("seeds the remaining plans when one is already consumed", async () => {
    withWorkspaceFile();
    readdirSync.mockReturnValue(["PROJ-1-1.json", "PROJ-2-1.json"] as never);
    readFileSync.mockImplementation((p) =>
      String(p).includes("PROJ-1")
        ? planJson({ key: "PROJ-1", seq: 0, matches: [{ matchPath: "/ws/PROJ-1.code-workspace", prompt: "first" }] })
        : planJson({ key: "PROJ-2", seq: 1, matches: [{ matchPath: "/ws/PROJ-1.code-workspace", prompt: "second" }] }),
    );
    commands.getCommands.mockResolvedValue(["claude-vscode.editor.open", CLAUDE_OPEN_CMD]);
    const { context } = fakeContext({
      globalState: { "seeded:PROJ-1:/ws/PROJ-1.code-workspace": true },
    });

    vi.useFakeTimers();
    const pending = maybeSeedAgent(context, () => {});
    await vi.runAllTimersAsync();
    await pending;
    vi.useRealTimers();

    const seeds = commands.executeCommand.mock.calls.filter((c) => String(c[0]).startsWith("claude-vscode."));
    expect(seeds.map((c) => c[2])).toEqual(["second"]);
  });

  it("skips the clipboard fallback when seeding several sessions", async () => {
    withWorkspaceFile();
    readdirSync.mockReturnValue(["PROJ-1-1.json", "PROJ-2-1.json"] as never);
    readFileSync.mockImplementation((p) =>
      String(p).includes("PROJ-1") ? planJson({ key: "PROJ-1", seq: 0 }) : planJson({ key: "PROJ-2", seq: 1 }),
    );
    commands.getCommands.mockResolvedValue([]); // no Claude command at all
    env.openExternal.mockResolvedValue(false); // URI handler fails too
    const { context } = fakeContext();

    vi.useFakeTimers();
    const pending = maybeSeedAgent(context, () => {});
    await vi.runAllTimersAsync();
    await pending;
    vi.useRealTimers();

    expect(env.clipboard.writeText).not.toHaveBeenCalled();
    expect(window.showInformationMessage).toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/workspace.test.ts -t "maybeSeedAgent"`
Expected: FAIL — the ordering test sees only one seed (the loop returns after the first), and the `claude-vscode.editor.open` assertions fail because that command is never tried.

- [ ] **Step 3: Export the helpers and add `PlanFile.seq`**

In `src/engine/workspace.ts`:

Add `export` to the two brief constants:

```ts
export const BRIEF_DIR = ".pick-task";
export const BRIEF_FILE = "TASK.md";
```

Export `PlanFile` and add `seq`:

```ts
export interface PlanFile {
  key: string;
  createdAt: number;
  seedAgent: boolean;
  remoteControl?: boolean;
  /** Position in a batch. Several plans written in one loop can share a
   * createdAt millisecond; this keeps the seeded tabs in selection order. */
  seq?: number;
  matches: { matchPath: string; prompt: string }[];
}
```

Add `export` to `briefMarkdown` and `writePlanFile`, and give `agentPrompt` its optional brief override:

```ts
export function agentPrompt(t: TicketRef, mentions: string[], template: string, briefPath?: string): string {
  return renderPrompt(
    template,
    { key: t.key, summary: t.summary, url: t.url, brief: briefPath ?? `${BRIEF_DIR}/${BRIEF_FILE}` },
    mentions,
  );
}
```

- [ ] **Step 4: Make `maybeSeedAgent` seed every match**

Replace the body of `maybeSeedAgent` after the `identity` guard (the `for (const f of files)` loop, lines ~379–405) with a collect-then-seed pass:

```ts
  const now = Date.now();
  const due: PlanFile[] = [];
  for (const f of files) {
    const full = path.join(PLAN_DIR, f);
    let plan: PlanFile;
    try {
      plan = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch {
      continue;
    }
    if (now - plan.createdAt > PLAN_TTL_MS) {
      fs.rmSync(full, { force: true });
      continue;
    }
    if (!plan.seedAgent) continue;
    const match = plan.matches.find((m) => canon(m.matchPath) === identity);
    log(`plan ${plan.key}: ${match ? "MATCHED this window" : "no match"}`);
    if (!match) continue;
    if (context.globalState.get<boolean>(`seeded:${plan.key}:${identity}`)) {
      log(`plan ${plan.key}: already seeded this window — skipping`);
      continue;
    }
    due.push(plan);
  }
  if (!due.length) return;

  // A batch lands N plans on one window. Order them the way the user selected them:
  // plans written in one loop can share a createdAt millisecond, so seq breaks the tie.
  due.sort((a, b) => a.createdAt - b.createdAt || (a.seq ?? 0) - (b.seq ?? 0));

  const multi = due.length > 1;
  for (let i = 0; i < due.length; i++) {
    const plan = due[i];
    const match = plan.matches.find((m) => canon(m.matchPath) === identity)!;
    await context.globalState.update(`seeded:${plan.key}:${identity}`, true);
    await seedClaudeCode(match.prompt, plan.key, log, plan.remoteControl === true, multi);
    // Claude Code picks a session's column by scanning the tab groups for an existing
    // Claude group, and that model doesn't update synchronously — without this pause
    // consecutive sessions each decide there is no group yet and land in separate columns.
    if (i < due.length - 1) await delay(SEED_STAGGER_MS);
  }
```

Add the constant next to `PLAN_TTL_MS` at the top of the file:

```ts
/** Pause between sessions when one window seeds a whole batch (see maybeSeedAgent). */
const SEED_STAGGER_MS = 400;
```

- [ ] **Step 5: Teach `seedClaudeCode` the multi-session path**

Add the new-tab command constant beside `CLAUDE_OPEN_CMD`:

```ts
// Claude Code's "Open in New Tab". Unlike primaryEditor.open it joins the existing
// Claude tab group, so a batch's sessions stack in one column instead of one per launch.
const CLAUDE_NEW_TAB_CMD = "claude-vscode.editor.open";
```

Change the signature and the command-poll loop:

```ts
async function seedClaudeCode(
  prompt: string,
  key: string,
  log: (m: string) => void,
  remoteControl = false,
  multi = false,
): Promise<void> {
```

In the poll loop, prefer the new-tab command when `multi`:

```ts
  const preferred = multi ? [CLAUDE_NEW_TAB_CMD, CLAUDE_OPEN_CMD] : [CLAUDE_OPEN_CMD];
  for (let attempt = 1; attempt <= 7; attempt++) {
    try {
      const cmds = await vscode.commands.getCommands(true);
      const cmd = preferred.find((c) => cmds.includes(c));
      if (cmd) {
        await vscode.commands.executeCommand(cmd, undefined, seedText);
        log(`seed ${key}: opened Claude Code via ${cmd} (attempt ${attempt})${remoteControl ? " + Remote Control" : ""}`);
        announceRemoteControl();
        return;
      }
    } catch (e) {
      log(`seed ${key}: command attempt ${attempt} threw: ${e}`);
    }
    await delay(700);
  }
  log(`seed ${key}: no Claude Code open command registered — trying URI handler`);
```

Replace the clipboard fallback at the end of the function:

```ts
  // 3 — fallback. One clipboard can't carry N prompts, so a batch gets a pointer to
  // the briefs instead — they hold the same context and sit in the window's roots.
  if (multi) {
    vscode.window.showInformationMessage(
      `Agent Flow: couldn't start Claude Code for ${key}. Its brief is in ${BRIEF_DIR}/${BRIEF_FILE} — open it to start the task.`,
    );
    log(`seed ${key}: no Claude Code available — pointed at the brief (batch, clipboard withheld)`);
    return;
  }
  if (remoteControl) log(`seed ${key}: Remote Control dropped — the clipboard is needed for the prompt`);
  await vscode.env.clipboard.writeText(prompt);
  vscode.window.showInformationMessage(
    `Agent Flow: opened workspace for ${key}. Claude Code prompt copied — paste it into the panel to start.`,
  );
  log(`seed ${key}: fell back to clipboard`);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/workspace.test.ts`
Expected: PASS, including every pre-existing test in the file (the single-plan path is unchanged: one due plan → `multi` false → `CLAUDE_OPEN_CMD`).

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/engine/workspace.ts test/unit/engine/workspace.test.ts
git commit -m "feat(engine): seed every plan matching a window, not just the first"
```

---

### Task 4: Shared-window batch assembly

**Files:**
- Create: `src/engine/batchWorkspace.ts`
- Test: `test/unit/engine/batchWorkspace.test.ts`

**Interfaces:**
- Consumes, from `src/engine/workspace.ts` (Task 3): `BRIEF_DIR`, `BRIEF_FILE`, `briefMarkdown`, `agentPrompt`, `writePlanFile`, `openInEditor`, `mergeReposIntoWorkspace`, `TicketRef`, `PlanFile`.
- Produces, for Task 5:

```ts
export interface BatchTask {
  ticket: TicketRef;
  planMd: string;
  descriptionText: string;
  services: ServiceRef[]; // already worktrees
}

export type SharedTarget =
  | { kind: "new" }
  | { kind: "current" }
  | { kind: "existing"; file: string }
  | { kind: "live-folder"; folder: string };

export interface SharedOpenRequest {
  tasks: BatchTask[];
  promptTemplate: string;
  workspaceDir: string;
  seedAgent: boolean;
  target: SharedTarget;
}

export interface SharedOpenResult {
  workspaceFile?: string;
  opened: boolean;
  briefs: { key: string; repo: string; path: string; gitExcluded: boolean; files: number }[];
  mergedFolders?: string[];
  mergeFailed?: boolean;
  unaddedFolders?: string[];
  seeded: number;
}

export async function openSharedWorkspace(req: SharedOpenRequest): Promise<SharedOpenResult>;
```

- [ ] **Step 1: Write the failing tests**

Create `test/unit/engine/batchWorkspace.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as childProcess from "child_process";
import { openSharedWorkspace, type SharedOpenRequest } from "../../../src/engine/batchWorkspace";

vi.mock("fs");
vi.mock("child_process");

const existsSync = vi.mocked(fs.existsSync);
const readFileSync = vi.mocked(fs.readFileSync);
const writeFileSync = vi.mocked(fs.writeFileSync);
const realpathSync = vi.mocked(fs.realpathSync);
const execSync = vi.mocked(childProcess.execSync);
const exec = vi.mocked(childProcess.exec);

beforeEach(() => {
  vi.mocked(fs).mkdirSync.mockReset();
  writeFileSync.mockReset();
  vi.mocked(fs).appendFileSync.mockReset();
  existsSync.mockReset().mockImplementation((p) => String(p).endsWith("/.git"));
  readFileSync.mockReset().mockReturnValue("");
  realpathSync.mockReset().mockImplementation((p) => String(p));
  execSync.mockReset().mockReturnValue(""); // git ls-files → no files
  exec.mockReset().mockImplementation(((_c: string, cb: (e: unknown) => void) => cb(null)) as never);
});

/** Two tasks, each with one worktree in `api`. */
const baseReq = (over: Partial<SharedOpenRequest> = {}): SharedOpenRequest => ({
  tasks: [
    {
      ticket: { key: "PROJ-1", summary: "one", url: "https://jira/PROJ-1" },
      planMd: "## Plan\n\na",
      descriptionText: "",
      services: [{ name: "api", path: "/repos/api/.claude/worktrees/PROJ-1", isGit: true }],
    },
    {
      ticket: { key: "PROJ-2", summary: "two", url: "https://jira/PROJ-2" },
      planMd: "## Plan\n\nb",
      descriptionText: "",
      services: [{ name: "api", path: "/repos/api/.claude/worktrees/PROJ-2", isGit: true }],
    },
  ],
  promptTemplate: "Start {key} — brief at {brief}{files}",
  workspaceDir: "/ws",
  seedAgent: true,
  target: { kind: "new" },
  ...over,
});

const writes = (predicate: (p: string) => boolean) =>
  writeFileSync.mock.calls.filter((c) => predicate(String(c[0])));

describe("openSharedWorkspace", () => {
  it("writes one brief per task-service pair, none overwriting another", async () => {
    const result = await openSharedWorkspace(baseReq());
    const briefs = writes((p) => p.endsWith("TASK.md"));
    expect(briefs.map((c) => String(c[0]))).toEqual([
      "/repos/api/.claude/worktrees/PROJ-1/.pick-task/TASK.md",
      "/repos/api/.claude/worktrees/PROJ-2/.pick-task/TASK.md",
    ]);
    expect(result.briefs).toHaveLength(2);
  });

  it("names each folder <KEY>-<repo> so two worktrees of one repo stay distinct", async () => {
    await openSharedWorkspace(baseReq());
    const ws = JSON.parse(String(writes((p) => p.endsWith(".code-workspace"))[0][1]));
    expect(ws.folders).toEqual([
      { name: "PROJ-1-api", path: "/repos/api/.claude/worktrees/PROJ-1" },
      { name: "PROJ-2-api", path: "/repos/api/.claude/worktrees/PROJ-2" },
    ]);
  });

  it("names the workspace file after the first key and the remaining count", async () => {
    const result = await openSharedWorkspace(baseReq());
    expect(result.workspaceFile).toBe("/ws/PROJ-1+1.code-workspace");
  });

  it("writes one plan and one run per task, all pointing at the same window", async () => {
    await openSharedWorkspace(baseReq());
    const plans = writes((p) => p.includes("/plans/")).map((c) => JSON.parse(String(c[1])));
    expect(plans.map((p) => p.key)).toEqual(["PROJ-1", "PROJ-2"]);
    expect(plans.map((p) => p.seq)).toEqual([0, 1]);
    expect(plans.every((p) => p.matches[0].matchPath === "/ws/PROJ-1+1.code-workspace")).toBe(true);

    const runs = writes((p) => p.includes("/runs/")).map((c) => JSON.parse(String(c[1])));
    expect(runs.map((r) => r.key)).toEqual(["PROJ-1", "PROJ-2"]);
    expect(runs.every((r) => r.workspaceFile === "/ws/PROJ-1+1.code-workspace")).toBe(true);
    expect(runs.every((r) => r.mode === "multiroot")).toBe(true);
  });

  it("seeds each prompt with that task's absolute brief path", async () => {
    await openSharedWorkspace(baseReq());
    const plans = writes((p) => p.includes("/plans/")).map((c) => JSON.parse(String(c[1])));
    expect(plans[0].matches[0].prompt).toContain("/repos/api/.claude/worktrees/PROJ-1/.pick-task/TASK.md");
    expect(plans[1].matches[0].prompt).toContain("/repos/api/.claude/worktrees/PROJ-2/.pick-task/TASK.md");
  });

  it("qualifies file mentions with the folder name so they resolve to the right root", async () => {
    execSync.mockReturnValue("src/foo.ts\n");
    await openSharedWorkspace(
      baseReq({
        tasks: [
          {
            ticket: { key: "PROJ-1", summary: "one", url: "" },
            planMd: "p",
            descriptionText: "look at `src/foo.ts`",
            services: [{ name: "api", path: "/repos/api/.claude/worktrees/PROJ-1", isGit: true }],
          },
        ],
      }),
    );
    const plan = JSON.parse(String(writes((p) => p.includes("/plans/"))[0][1]));
    expect(plan.matches[0].prompt).toContain("@PROJ-1-api/src/foo.ts");
  });

  it("writes no plan file when seeding is off", async () => {
    const result = await openSharedWorkspace(baseReq({ seedAgent: false }));
    expect(writes((p) => p.includes("/plans/"))).toHaveLength(0);
    expect(result.seeded).toBe(0);
  });

  it("merges the folders into an existing workspace instead of writing a new one", async () => {
    readFileSync.mockReturnValue(JSON.stringify({ folders: [{ path: "/repos/web" }] }));
    const result = await openSharedWorkspace(baseReq({ target: { kind: "existing", file: "/ws/team.code-workspace" } }));
    expect(result.workspaceFile).toBe("/ws/team.code-workspace");
    expect(result.mergedFolders).toEqual(["PROJ-1-api", "PROJ-2-api"]);
    expect(writes((p) => p === "/ws/PROJ-1+1.code-workspace")).toHaveLength(0);
  });

  it("reports mergeFailed and writes nothing when the existing workspace is unparseable", async () => {
    readFileSync.mockReturnValue("{ not json");
    const result = await openSharedWorkspace(baseReq({ target: { kind: "existing", file: "/ws/team.code-workspace" } }));
    expect(result.mergeFailed).toBe(true);
    expect(result.mergedFolders ?? []).toEqual([]);
  });

  it("adds no folders to a live folder window and reports them unadded", async () => {
    const result = await openSharedWorkspace(baseReq({ target: { kind: "live-folder", folder: "/repos/web" } }));
    expect(result.workspaceFile).toBeUndefined();
    expect(result.unaddedFolders).toEqual(["PROJ-1-api", "PROJ-2-api"]);
    const plans = writes((p) => p.includes("/plans/")).map((c) => JSON.parse(String(c[1])));
    expect(plans.every((p) => p.matches[0].matchPath === "/repos/web")).toBe(true);
  });

  it("opens the destination exactly once", async () => {
    await openSharedWorkspace(baseReq());
    expect(exec).toHaveBeenCalledTimes(1);
    expect(String(exec.mock.calls[0][0])).toContain("/ws/PROJ-1+1.code-workspace");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/batchWorkspace.test.ts`
Expected: FAIL — `Failed to resolve import "../../../src/engine/batchWorkspace"`.

- [ ] **Step 3: Create the module**

Create `src/engine/batchWorkspace.ts`:

```ts
import * as fs from "fs";
import * as path from "path";
import { Run, ServiceRef } from "../types";
import { extractFileHints, resolveFilesInRepo, mention } from "./files";
import { ensureGitExcluded } from "./gitExclude";
import { gitState } from "./git";
import { writeRun, defaultRunsDir } from "./runs";
import {
  BRIEF_DIR,
  BRIEF_FILE,
  TicketRef,
  agentPrompt,
  briefMarkdown,
  mergeReposIntoWorkspace,
  openInEditor,
  writePlanFile,
} from "./workspace";

export interface BatchTask {
  ticket: TicketRef;
  planMd: string;
  descriptionText: string;
  /** Already resolved to per-task worktrees by the caller. */
  services: ServiceRef[];
}

export type SharedTarget =
  | { kind: "new" }
  | { kind: "current" }
  | { kind: "existing"; file: string }
  | { kind: "live-folder"; folder: string };

export interface SharedOpenRequest {
  tasks: BatchTask[];
  promptTemplate: string;
  workspaceDir: string;
  seedAgent: boolean;
  target: SharedTarget;
}

export interface SharedOpenResult {
  workspaceFile?: string;
  opened: boolean;
  briefs: { key: string; repo: string; path: string; gitExcluded: boolean; files: number }[];
  mergedFolders?: string[]; // folders appended to an existing workspace
  mergeFailed?: boolean; // existing workspace couldn't be parsed; opened as-is
  unaddedFolders?: string[]; // live-folder: roots VS Code can't inject remotely
  seeded: number; // plan files written
}

/** A task's worktree as a workspace folder. The key qualifier is load-bearing: two
 * tasks in one repo would otherwise present as two identically-named roots, and the
 * folder name is what an `@mention` resolves against. */
function folderName(key: string, repo: string): string {
  return `${key}-${repo}`;
}

/**
 * Open ONE window holding every task's worktrees, with a Claude session seeded per
 * task. `openWorkspace` can't do this by being called N times — each call would
 * rewrite and reopen the same destination — so the whole batch is assembled here and
 * opened once. The N plan files all name the same matchPath; `maybeSeedAgent` seeds
 * every one of them in that window.
 */
export async function openSharedWorkspace(req: SharedOpenRequest): Promise<SharedOpenResult> {
  const { tasks, promptTemplate, workspaceDir, seedAgent, target } = req;

  // 1 — a brief per task-service pair. Every service is a per-task worktree, so no
  //     two tasks share a brief path.
  const briefs: SharedOpenResult["briefs"] = [];
  const briefPathFor = new Map<string, string>(); // task key → its first brief, for {brief}
  const filesByPair = new Map<string, string[]>(); // `${key}:${repo}` → matched files
  for (const t of tasks) {
    const hints = extractFileHints(t.descriptionText);
    for (const s of t.services) {
      const files = resolveFilesInRepo(s.path, hints);
      filesByPair.set(`${t.ticket.key}:${s.name}`, files);
      const dir = path.join(s.path, BRIEF_DIR);
      fs.mkdirSync(dir, { recursive: true });
      const briefPath = path.join(dir, BRIEF_FILE);
      fs.writeFileSync(briefPath, briefMarkdown(t.ticket, t.planMd, t.services, s.name, files));
      if (!briefPathFor.has(t.ticket.key)) briefPathFor.set(t.ticket.key, briefPath);
      briefs.push({
        key: t.ticket.key,
        repo: s.name,
        path: briefPath,
        gitExcluded: ensureGitExcluded(s.path, `${BRIEF_DIR}/`),
        files: files.length,
      });
    }
  }

  // 2 — every worktree as a workspace folder, key-qualified.
  const folders = tasks.flatMap((t) =>
    t.services.map((s) => ({ name: folderName(t.ticket.key, s.name), path: s.path })),
  );

  // 3 — resolve the destination into a single match path.
  let workspaceFile: string | undefined;
  let mergedFolders: string[] | undefined;
  let mergeFailed: boolean | undefined;
  let unaddedFolders: string[] | undefined;
  let openTarget: string;
  if (target.kind === "existing") {
    const merge = mergeReposIntoWorkspace(
      target.file,
      folders.map((f) => ({ name: f.name, path: f.path, isGit: true })),
    );
    mergedFolders = merge.added;
    mergeFailed = merge.ok ? undefined : true;
    workspaceFile = target.file;
    openTarget = target.file;
  } else if (target.kind === "live-folder") {
    // VS Code offers no way to inject roots into another window, so the worktrees
    // stay out of it. The seeded prompts carry absolute brief paths, so the agents
    // can still read their context from there.
    unaddedFolders = folders.map((f) => f.name);
    openTarget = target.folder;
  } else {
    fs.mkdirSync(workspaceDir, { recursive: true });
    const first = tasks[0].ticket.key;
    workspaceFile = path.join(workspaceDir, `${first}+${tasks.length - 1}.code-workspace`);
    fs.writeFileSync(workspaceFile, JSON.stringify({ folders, settings: {} }, null, 2) + "\n");
    openTarget = workspaceFile;
  }
  const matchPath = workspaceFile ?? openTarget;

  // 4 — one plan + one run per task, all naming the same window. Durable writes come
  //     before the open: reusing the current window reloads this extension host.
  const createdAt = Date.now();
  let seeded = 0;
  tasks.forEach((t, i) => {
    if (seedAgent) {
      const mentions = t.services.flatMap((s) =>
        (filesByPair.get(`${t.ticket.key}:${s.name}`) ?? []).map((f) =>
          mention("multiroot", folderName(t.ticket.key, s.name), f),
        ),
      );
      // Absolute, not the usual relative path: N worktree roots each hold
      // `.pick-task/TASK.md`, so a relative reference names no file in particular.
      const prompt = agentPrompt(t.ticket, mentions, promptTemplate, briefPathFor.get(t.ticket.key));
      // Remote Control is never offered here — one clipboard can't serve N sessions.
      writePlanFile({ key: t.ticket.key, createdAt, seedAgent: true, seq: i, matches: [{ matchPath, prompt }] });
      seeded++;
    }
    const run: Run = {
      key: t.ticket.key,
      summary: t.ticket.summary,
      url: t.ticket.url,
      createdAt,
      mode: workspaceFile ? "multiroot" : "per-window",
      workspaceFile,
      repos: t.services.map((s) => ({
        name: s.name,
        path: s.path,
        isGit: s.isGit,
        branch: gitState(s.name, s.path).branch ?? undefined,
      })),
      briefPaths: briefs.filter((b) => b.key === t.ticket.key).map((b) => b.path),
    };
    try {
      writeRun(defaultRunsDir(), run);
    } catch {
      /* the Deck record is best-effort — never fail a launch over it */
    }
  });

  // 5 — open once.
  const opened = await openInEditor(openTarget, target.kind !== "current");
  return { workspaceFile, opened, briefs, mergedFolders, mergeFailed, unaddedFolders, seeded };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/batchWorkspace.test.ts`
Expected: PASS, all 11 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/engine/batchWorkspace.ts test/unit/engine/batchWorkspace.test.ts
git commit -m "feat(engine): assemble a shared window holding a whole batch"
```

---

### Task 5: Route a batch through the destination and layout picks

**Files:**
- Modify: `src/tasksView.ts:179-181`, `src/tasksView.ts:704-793`
- Test: `test/unit/tasksView.test.ts:811-938`

**Interfaces:**
- Consumes: the `takeBatch` message shape (Task 1), `openSharedWorkspace` / `BatchTask` / `SharedTarget` (Task 4), and the existing private methods `choosePromptMode`, `chooseOpenTarget`, `remoteControlNote`, `buildBrief`, `toast`, `log`.
- Produces: `public async takeBatch(keys: string[], repos: string[]): Promise<void>`.

- [ ] **Step 1: Update the existing `takeBatch` tests to the new signature and the new picker**

In `test/unit/tasksView.test.ts`, the `describe("takeBatch")` block calls `provider.takeBatch(keys, "api")`. Change every call to pass an array: `provider.takeBatch(keys, ["api"])`. There are nine such calls plus one message-routing test.

A two-key batch to a new window now hits the layout QuickPick, which the existing tests do not answer — an unanswered pick returns `undefined` and aborts the launch. Give the block a default answer, and reset it afterwards so it cannot leak into `describe("live-window open targets")`, which follows and drives `showQuickPick` itself. In that block's existing `beforeEach` / `afterEach`:

```ts
  beforeEach(() => {
    vi.mocked(createWorktrees).mockImplementation((s, key) =>
      s.map((r) => ({ ...r, path: `${r.path}/.claude/worktrees/${key}` })),
    );
    // Default answer for the layout pick; tests that drive the picker themselves
    // shadow this with mockResolvedValueOnce.
    vi.mocked(window.showQuickPick).mockResolvedValue({ shared: false } as never);
  });
  afterEach(() => {
    vi.mocked(createWorktrees).mockImplementation((s) => s);
    vi.mocked(window.showQuickPick).mockReset();
  });
```

The test named `"asks the prompt mode once when taskMode is 'ask' and applies it to all"` now sees two picks, not one. Update its assertion:

```ts
    expect(window.showQuickPick).toHaveBeenCalledTimes(2); // prompt mode + layout, each once — not per task
```

Update the routing test's payload:

```ts
  it("routes the takeBatch message through onMessage to the handler", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    const { send } = setup();
    await send({ type: "takeBatch", keys: ["PROJ-1"], repos: ["api"] });
    expect(openWorkspace).toHaveBeenCalled();
  });
```

Rename and rewrite the two guard tests, which no longer abort:

```ts
  it("drops a non-git repo from the set and launches on the rest", async () => {
    vi.mocked(discoverRepos).mockReturnValue([
      { name: "api", path: "/repos/api", isGit: true },
      { name: "docs", path: "/repos/docs", isGit: false },
    ]);
    const { provider, posted } = setup();
    await provider.takeBatch(["PROJ-1"], ["api", "docs"]);
    expect(openWorkspace).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createWorktrees).mock.calls[0][0]).toEqual([expect.objectContaining({ name: "api" })]);
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "info" }));
  });

  it("errors when no selected repo resolves to a git repo", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"], { isGit: false }));
    const { provider, posted } = setup();
    await provider.takeBatch(["PROJ-1"], ["api"]);
    expect(createWorktrees).not.toHaveBeenCalled();
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "error" }));
  });
```

- [ ] **Step 2: Add the mock for the new engine module**

Near the other `vi.mock` calls at the top of `test/unit/tasksView.test.ts`, add:

```ts
vi.mock("../../src/engine/batchWorkspace", () => ({ openSharedWorkspace: vi.fn() }));
```

and import it beside the others:

```ts
import { openSharedWorkspace } from "../../src/engine/batchWorkspace";
```

In the top-level `beforeEach`, give it a default resolution:

```ts
  vi.mocked(openSharedWorkspace).mockResolvedValue({
    workspaceFile: "/ws/PROJ-1+1.code-workspace",
    opened: true,
    briefs: [],
    seeded: 2,
  });
```

- [ ] **Step 3: Write the failing tests for the new behaviour**

Append inside `describe("takeBatch")`:

```ts
  it("gives each task the repos it touches, intersected with the filter set", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api", "billing", "web"]));
    clientStub.getDetail.mockResolvedValue({
      key: "PROJ-1",
      summary: "fix the billing api",
      descriptionText: "desc",
      labels: [],
      components: [],
      url: "https://jira/browse/PROJ-1",
    });
    const { provider } = setup();
    await provider.takeBatch(["PROJ-1"], ["api", "billing"]);
    const picked = vi.mocked(createWorktrees).mock.calls[0][0].map((r) => r.name);
    expect(picked.sort()).toEqual(["api", "billing"]);
    expect(picked).not.toContain("web"); // outside the filter set, even if inferred
  });

  it("falls back to the whole filter set when a task infers no repo in it", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api", "billing"]));
    clientStub.getDetail.mockResolvedValue({
      key: "PROJ-1",
      summary: "nothing recognisable here",
      descriptionText: "",
      labels: [],
      components: [],
      url: "https://jira/browse/PROJ-1",
    });
    const { provider } = setup();
    await provider.takeBatch(["PROJ-1"], ["api", "billing"]);
    const picked = vi.mocked(createWorktrees).mock.calls[0][0].map((r) => r.name);
    expect(picked.sort()).toEqual(["api", "billing"]);
  });

  it("asks the destination once for the whole batch", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    // 1st pick: destination (new window). 2nd: layout (separate windows).
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ target: { kind: "new" } } as never)
      .mockResolvedValueOnce({ shared: false } as never);
    const { provider } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    expect(window.showQuickPick).toHaveBeenCalledTimes(2); // destination + layout, not per task
    expect(openWorkspace).toHaveBeenCalledTimes(2);
  });

  it("asks the layout only for a new window, and uses the shared path when chosen", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "new-window" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ shared: true } as never);
    const { provider } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(openSharedWorkspace).toHaveBeenCalledTimes(1);
    expect(openSharedWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: "new" } }),
    );
    const req = vi.mocked(openSharedWorkspace).mock.calls[0][0];
    expect(req.tasks.map((t) => t.ticket.key)).toEqual(twoKeys);
  });

  it("skips the layout pick for this-window and goes straight to the shared path", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "this-window" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    const { provider } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(openSharedWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: "current" } }),
    );
  });

  it("skips the layout pick for a one-key batch", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "new-window" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    const { provider } = setup();
    await provider.takeBatch(["PROJ-1"], ["api"]);
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(openWorkspace).toHaveBeenCalledTimes(1);
  });

  it("aborts when the destination pick is cancelled", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined);
    const { provider } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(openSharedWorkspace).not.toHaveBeenCalled();
  });

  it("warns about worktrees a live window couldn't take", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({
      target: { kind: "live-folder", folder: "/repos/web" },
    } as never);
    vi.mocked(openSharedWorkspace).mockResolvedValue({
      workspaceFile: undefined,
      opened: true,
      briefs: [],
      unaddedFolders: ["PROJ-1-api", "PROJ-2-api"],
      seeded: 2,
    });
    const { provider, posted } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    const toast = posted().find((m) => m.type === "toast") as { message: string };
    expect(toast.message).toContain("PROJ-1-api");
  });
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run test/unit/tasksView.test.ts -t "takeBatch"`
Expected: FAIL — TypeScript rejects the array argument, and the new destination/layout tests fail because `takeBatch` never calls `chooseOpenTarget`.

- [ ] **Step 5: Rewrite `takeBatch`**

In `src/tasksView.ts`, replace the whole `takeBatch` method (lines 704–793) with:

```ts
  /** Launch several tasks at once, each in its own git worktree with its own seeded
   * Claude session. The prompt mode, destination and layout are asked once and applied
   * to all; one task's failure never aborts the rest. Each task opens worktrees in the
   * repos it's inferred to touch, narrowed to the filtered set. */
  public async takeBatch(keys: string[], repos: string[]): Promise<void> {
    const cfg = getConfig();
    if (!keys.length) return;

    if (!(await this.auth.isAuthenticated())) {
      const ok = await vscode.commands.executeCommand<boolean>("agentFlow.signIn");
      if (!ok) return;
    }

    const filterSet = this.resolveBatchRepos(repos, cfg);
    if (!filterSet.length) return;

    if (keys.length > cfg.batchLaunchConfirmThreshold) {
      const go = await vscode.window.showWarningMessage(
        `Launch ${keys.length} tasks in parallel? That's ${keys.length} Claude Code sessions.`,
        { modal: true },
        "Launch",
      );
      if (go !== "Launch") return;
    }

    const promptMode = await this.choosePromptMode(cfg, `Launch ${keys.length} selected task(s) — how should the agents start?`);
    if (!promptMode) return;

    const target = await this.chooseOpenTarget(cfg);
    if (!target) return;

    // Only a new window can go either way; the other destinations ARE a single window.
    // A one-key batch is an ordinary single-window launch, so it needs no layout pick.
    let shared = target.kind !== "new";
    if (target.kind === "new" && keys.length > 1) {
      const p = await vscode.window.showQuickPick(
        [
          { label: "$(multiple-windows) Separate windows", detail: "One window per task", shared: false },
          { label: "$(window) One shared window", detail: `All ${keys.length} tasks in one window, a session each`, shared: true },
        ],
        { title: `Launch ${keys.length} tasks — how should I lay them out?`, ignoreFocusOut: true },
      );
      if (!p) return;
      shared = p.shared;
    }

    // One clipboard can't serve several sessions — but a one-key "batch" is a single
    // launch, so it resolves Remote Control exactly like Take does.
    const isBatch = keys.length > 1;
    const rcSkipped = isBatch && cfg.remoteControl !== "off";
    if (rcSkipped) this.log("takeBatch: Remote Control skipped — one clipboard, several sessions");
    const wantRemoteControl = isBatch ? false : await this.resolveRemoteControl(cfg);

    const resolved: { task: BatchTask; key: string }[] = [];
    const failed: string[] = [];
    for (const key of keys) {
      try {
        const detail = await this.client().getDetail(key);
        const wanted = this.reposForTask(detail, filterSet);
        const services = createWorktrees(wanted, detail.key, detail.summary, this.log);
        // A worktree is mandatory: two tasks sharing a checkout would clobber each
        // other's brief. createWorktrees returns the original ref when `git worktree
        // add` fails — detect that and fail the task rather than launch into a collision.
        if (services.some((s, i) => s.path === wanted[i].path)) {
          throw new Error("couldn't create a git worktree (would collide with the shared checkout)");
        }
        resolved.push({
          key,
          task: {
            ticket: { key: detail.key, summary: detail.summary, url: detail.url },
            planMd: this.buildBrief(detail),
            descriptionText: detail.descriptionText,
            services,
          },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failed.push(`${key} (${msg})`);
        this.log(`takeBatch ${key}: failed — ${msg}`);
      }
    }

    let launched = 0;
    let extra = "";
    if (shared && resolved.length) {
      try {
        const result = await openSharedWorkspace({
          tasks: resolved.map((r) => r.task),
          promptTemplate: promptMode.prompt,
          workspaceDir: cfg.workspaceDir,
          seedAgent: cfg.seedAgent,
          // OpenTarget and SharedTarget are the same four shapes — no cast needed.
          target,
        });
        launched = resolved.length;
        if (result.mergeFailed) extra = " That workspace's folders couldn't be parsed — the worktrees weren't added.";
        else if (result.unaddedFolders?.length) {
          extra = ` ${result.unaddedFolders.join(", ")} couldn't be added as roots to that window — the briefs are still in place.`;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        for (const r of resolved) failed.push(`${r.key} (${msg})`);
        this.log(`takeBatch: shared window failed — ${msg}`);
      }
    } else {
      let appliedRemoteControl = false;
      for (let i = 0; i < resolved.length; i++) {
        const { key, task } = resolved[i];
        try {
          const result = await openWorkspace({
            ticket: task.ticket,
            planMd: task.planMd,
            descriptionText: task.descriptionText,
            services: task.services,
            // Per task, not fixed: a batched task can now span repos, and a fixed
            // "per-window" makes openWorkspace open one window PER REPO per task.
            mode: task.services.length === 1 || cfg.workspaceMode === "per-window" ? "per-window" : "multiroot",
            promptTemplate: promptMode.prompt,
            workspaceDir: cfg.workspaceDir,
            seedAgent: cfg.seedAgent,
            openIn: "new",
            remoteControl: wantRemoteControl,
          });
          appliedRemoteControl = result.remoteControl;
          launched++;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          failed.push(`${key} (${msg})`);
          this.log(`takeBatch ${key}: failed — ${msg}`);
        }
        if (i < resolved.length - 1) await delay(BATCH_STAGGER_MS);
      }
      if (!isBatch) extra += this.remoteControlNote(wantRemoteControl, appliedRemoteControl);
    }

    const where = shared ? "in one shared window" : "in parallel";
    const summary = `Launched ${launched} of ${keys.length} ${where}.`;
    const rcNote = isBatch && rcSkipped ? " Remote Control skipped — one clipboard can't serve several sessions." : "";
    if (failed.length) {
      const shown = failed.slice(0, 5).join("; ");
      const more = failed.length > 5 ? ` (and ${failed.length - 5} more)` : "";
      this.toast("error", `${summary} Failed: ${shown}${more}${extra}${rcNote}`);
    } else {
      this.toast("success", `${summary} A worktree + Claude session per task.${extra}${rcNote}`);
    }
  }

  /** The filtered repo names as git ServiceRefs. Names that don't resolve, and repos
   * that aren't git, are dropped with a note rather than aborting the batch — with
   * several repos filtered, one bad entry shouldn't block the others. Returns [] (and
   * has already toasted) when nothing usable remains. */
  private resolveBatchRepos(names: string[], cfg: AgentFlowConfig): ServiceRef[] {
    const discovered = discoverRepos(cfg.reposRoot, cfg.repoBlocklist);
    const byName = new Map(discovered.map((r) => [r.name, r]));
    const missing = names.filter((n) => !byName.has(n));
    const found = names.map((n) => byName.get(n)).filter((r): r is ServiceRef => !!r);
    const nonGit = found.filter((r) => !r.isGit).map((r) => r.name);
    const usable = found.filter((r) => r.isGit);

    if (!usable.length) {
      this.toast("error", `No git repo among ${names.join(", ")} under ${cfg.reposRoot}. Each task opens a worktree.`);
      return [];
    }
    if (missing.length) this.toast("info", `Skipping ${missing.join(", ")} — not found under ${cfg.reposRoot}.`);
    if (nonGit.length) this.toast("info", `Skipping ${nonGit.join(", ")} — not a git repo, and each task opens a worktree.`);
    return usable;
  }

  /** The repos a batched task opens: its inferred repos narrowed to the filtered set,
   * falling back to the whole set when inference finds nothing there — a task must
   * never launch with no repo at all. */
  private reposForTask(detail: JiraDetail, filterSet: ServiceRef[]): ServiceRef[] {
    const inferred = new Set(
      inferServices(
        { summary: detail.summary, descriptionText: detail.descriptionText, labels: detail.labels, components: detail.components },
        filterSet,
      ).map((r) => r.service.name),
    );
    const narrowed = filterSet.filter((r) => inferred.has(r.name));
    return narrowed.length ? narrowed : filterSet;
  }
```

- [ ] **Step 6: Update the imports and the message dispatch**

At the top of `src/tasksView.ts`, add one import — this is the only one needed. `AgentFlowConfig`, `ServiceRef`, `JiraDetail`, `inferServices`, `discoverRepos`, `createWorktrees`, `delay` and `BATCH_STAGGER_MS` are all already imported or defined in the file (lines 4–20).

```ts
import { openSharedWorkspace, type BatchTask } from "./engine/batchWorkspace";
```

Change the dispatch at line 179–181:

```ts
        case "takeBatch": {
          await this.takeBatch(m.keys, m.repos);
          break;
        }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/unit/tasksView.test.ts`
Expected: PASS, the whole file.

- [ ] **Step 8: Full suite, typecheck, coverage**

```bash
npm run typecheck
npm test
npm run test:cov
```
Expected: all green; coverage above statements 90 / branches 85 / functions 85 / lines 90. If a new branch is uncovered, add a test for it rather than lowering the threshold.

- [ ] **Step 9: Commit**

```bash
git add src/tasksView.ts test/unit/tasksView.test.ts
git commit -m "feat: route a batch through the destination pick and seed a session per task"
```

---

### Task 6: Verify end-to-end in a real window

Automated tests mock `vscode` and `fs`; the two things they cannot prove are that Claude Code actually opens N tabs in one column, and that the seeded prompts resolve their absolute briefs. Do this by hand.

**Files:** none — verification only.

- [ ] **Step 1: Build and install**

```bash
npm run build
npm run package
```

Install the produced `.vsix` in Cursor (Extensions → `…` → Install from VSIX), then reload the window.

- [ ] **Step 2: Shared-window path**

In the Agent Flow sidebar: filter to **two** repos, check **three** tasks across them, click **Launch in parallel**, pick a prompt mode, choose **New window**, then **One shared window**.

Expected: one new window opens on `<KEY1>+2.code-workspace`; its Explorer shows one root per task-repo pair named `<KEY>-<repo>`; three Claude Code tabs appear in a single editor column, each pre-filled with its own task's prompt naming an absolute `.pick-task/TASK.md`.

- [ ] **Step 3: Separate-windows path (regression)**

Repeat with **Separate windows**. Expected: three windows, one Claude session each — unchanged from before this work.

- [ ] **Step 4: This-window path**

Repeat with two tasks and **This window**. Expected: no layout modal; the current window reloads onto the generated workspace and seeds two sessions.

- [ ] **Step 5: Deck**

Open the Deck. Expected: one card per launched task, including all three from the shared window.

- [ ] **Step 6: Record the result**

If everything passes, nothing to commit. If a step fails, stop and report which one with the observed behaviour — do not paper over it with a test change.

---

## Notes for the reviewer

- **`Run.mode` for a shared window** is `"multiroot"` and every task's `Run` carries the same `workspaceFile`. The Deck's `runTarget` returns that file for all of them, so "Open" on any card focuses the shared window. That is intended.
- **`seedAgent: false`** short-circuits plan writing in `openSharedWorkspace`, so the window opens with folders and briefs but no sessions — same contract as `openWorkspace`.
- **The stagger** in `maybeSeedAgent` is not cosmetic; see the comment in Task 3 Step 4. Do not remove it to speed up tests — use fake timers.
