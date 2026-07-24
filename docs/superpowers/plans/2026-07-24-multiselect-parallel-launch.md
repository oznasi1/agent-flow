# Multi-select & Parallel Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the repo filter is narrowed to exactly one repo, let the user multi-select tasks and launch them in parallel — each in its own git worktree/branch, in its own new window, with its own seeded Claude Code session.

**Architecture:** A "hoist-and-loop" batch orchestrator. The webview gates a checkbox UI on `selectedRepos.size === 1` and posts a single `takeBatch` message. The host asks the prompt-mode question once, forces per-task worktrees, and loops the existing `openWorkspace` (per-window, new) once per selected task — reusing the launch machinery that already opens+seeds a single task. Each worktree folder is its own window identity, so each opened window self-seeds its own Claude session via the existing plan handshake.

**Tech Stack:** TypeScript, React (webview), VS Code extension API, Vitest + Testing Library.

## Global Constraints

- **VS Code engine:** `^1.90.0` (do not use newer APIs).
- **Public npm registry only:** this repo is public OSS; if you touch `package-lock.json`, every entry must resolve from `registry.npmjs.org`, not a private CodeArtifact mirror, or CI fails `E401`. This plan adds **no** dependencies — do not add any.
- **Test commands:** `npm test` (all), `npx vitest run <path>` (targeted), `npm run typecheck` (tsc `--noEmit`), `npm run build` (esbuild bundle).
- **No new outbound message types** — batch progress/results reuse the existing `toast` message.
- **Worktrees are mandatory for the batch** — they keep each task's `.pick-task/TASK.md` brief and branch isolated in the shared repo.
- **Scope of THIS plan:** the **separate-windows** layout only (one window per selected task). The "one shared window" layout and the destination ("where") question are a deliberate follow-up gated on the seeding spike (see the spec's *Sequencing* section) — do **not** build them here.

---

### Task 1: Config — `batchLaunchConfirmThreshold`

Adds the one new setting: batches larger than this prompt a confirmation before launching.

**Files:**
- Modify: `src/config.ts` (the `AgentFlowConfig` interface + the `getConfig()` return object)
- Modify: `package.json` (`contributes.configuration.properties`)
- Test: `test/unit/config.test.ts`

**Interfaces:**
- Produces: `AgentFlowConfig.batchLaunchConfirmThreshold: number` (default `6`), read in `getConfig()`.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/config.test.ts`. Place the first block after the `getConfig — trackOpenWindows` describe (around line 173):

```ts
describe("getConfig — batch launch", () => {
  it("defaults batchLaunchConfirmThreshold to 6", () => {
    expect(getConfig().batchLaunchConfirmThreshold).toBe(6);
  });

  it("honors an explicit threshold", () => {
    setConfig({ batchLaunchConfirmThreshold: 3 });
    expect(getConfig().batchLaunchConfirmThreshold).toBe(3);
  });
});
```

And add this assertion inside the existing `describe("package.json ⇄ config constants", ...)` block (after the filter-visibility test, around line 248):

```ts
  it("declares batchLaunchConfirmThreshold with a default of 6", () => {
    expect(props["agentFlow.batchLaunchConfirmThreshold"].default).toBe(6);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/config.test.ts`
Expected: FAIL — `batchLaunchConfirmThreshold` is `undefined` (expected `6`), and `props["agentFlow.batchLaunchConfirmThreshold"]` is `undefined`.

- [ ] **Step 3: Add the field to the config interface and reader**

In `src/config.ts`, add to the `AgentFlowConfig` interface (after the `worktree` field, around line 97):

```ts
  worktree: "ask" | "always" | "never";
  // Batch sizes strictly greater than this prompt a confirmation before parallel launch.
  batchLaunchConfirmThreshold: number;
```

In `getConfig()`, add to the returned object (right after the `worktree:` line, around line 164):

```ts
    worktree: (c.get<AgentFlowConfig["worktree"]>("worktree")) || "ask",
    batchLaunchConfirmThreshold: c.get<number>("batchLaunchConfirmThreshold") ?? 6,
```

- [ ] **Step 4: Declare the setting in package.json**

In `package.json`, inside `contributes.configuration.properties`, add this property immediately after the `agentFlow.worktree` entry:

```json
    "agentFlow.batchLaunchConfirmThreshold": {
      "type": "number",
      "default": 6,
      "minimum": 1,
      "markdownDescription": "When you multi-select tasks (with the repo filter narrowed to a single repo) and launch them in parallel, batches **larger than** this number prompt a confirmation first — a guard against accidentally opening a swarm of windows, one per task."
    },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/unit/config.test.ts`
Expected: PASS (all, including the new `batch launch` and `package.json ⇄ config constants` cases).

- [ ] **Step 6: Commit**

```bash
git add src/config.ts package.json test/unit/config.test.ts
git commit -m "feat(config): add agentFlow.batchLaunchConfirmThreshold"
```

---

### Task 2: Webview — selection UI, action bar, and the `takeBatch` message

Adds per-card checkboxes gated on a single filtered repo, a sticky launch bar, and the outbound `takeBatch` message the host will handle in Task 3.

**Files:**
- Modify: `src/types.ts` (add `takeBatch` to `InboundMessage`)
- Modify: `src/webview/App.tsx` (state, `batchMode`, checkbox on `TaskCard`, action bar)
- Modify: `src/webview/styles.ts` (`.card-check`, `.batch-bar` and friends)
- Test: `test/webview/App.test.tsx`

**Interfaces:**
- Consumes: existing `selectedRepos: Set<string>` state and `visibleTasks` in `App.tsx`; the existing `PlayIcon` component; the `send()` helper.
- Produces: `InboundMessage` variant `{ type: "takeBatch"; keys: string[]; repo: string }`, posted when the user clicks **Launch in parallel**. `keys` are the selected tasks that are currently visible; `repo` is the single filtered repo's name.

- [ ] **Step 1: Add the message type**

In `src/types.ts`, add to the `InboundMessage` union (after the `take` line, around line 104):

```ts
  | { type: "take"; key: string; services?: string[] }
  | { type: "takeBatch"; keys: string[]; repo: string }
```

- [ ] **Step 2: Write the failing webview tests**

Add this describe block to `test/webview/App.test.tsx` (after the `"repo multiselect"` describe, around line 287). It reuses the file's existing `render`, `authed`, `host`, `sent`, `within`, `mkTask` helpers:

```tsx
describe("multi-select & parallel launch", () => {
  const apiPool = () =>
    host({
      type: "tasks",
      filter: "mine",
      tasks: [
        mkTask({ key: "ASM-1", summary: "one", services: ["api"] }),
        mkTask({ key: "ASM-2", summary: "two", services: ["api"] }),
        mkTask({ key: "ASM-3", summary: "three", services: ["billing"] }),
      ],
    });
  // Open the repo multiselect popup and toggle a repo option by name.
  const selectRepo = (name: string) => {
    fireEvent.click(screen.getByText("Filter repos"));
    const repoList = document.querySelector(".repo-list") as HTMLElement;
    fireEvent.mouseDown(within(repoList).getByText(name).closest(".repo-opt")!);
  };
  const checks = () => document.querySelectorAll(".card-check");

  it("shows no checkboxes until exactly one repo is filtered", () => {
    render(<App />);
    authed();
    apiPool();
    expect(checks().length).toBe(0);
  });

  it("shows a checkbox on each visible card when one repo is filtered", () => {
    render(<App />);
    authed();
    apiPool();
    selectRepo("api"); // narrows the pool to ASM-1 + ASM-2
    expect(checks().length).toBe(2);
  });

  it("hides checkboxes again once a second repo is added", () => {
    render(<App />);
    authed();
    apiPool();
    // Open the popup ONCE and toggle two repos — re-clicking the trigger would close it.
    fireEvent.click(screen.getByText("Filter repos"));
    const repoList = document.querySelector(".repo-list") as HTMLElement;
    fireEvent.mouseDown(within(repoList).getByText("api").closest(".repo-opt")!);
    fireEvent.mouseDown(within(repoList).getByText("billing").closest(".repo-opt")!);
    expect(checks().length).toBe(0); // 2 repos selected → batch mode off
  });

  it("launches the checked, visible tasks with the filtered repo name", () => {
    render(<App />);
    authed();
    apiPool();
    selectRepo("api");
    fireEvent.click(checks()[0]); // ASM-1
    fireEvent.click(checks()[1]); // ASM-2
    fireEvent.click(screen.getByRole("button", { name: /Launch in parallel/i }));
    expect(sent).toHaveBeenCalledWith({ type: "takeBatch", keys: ["ASM-1", "ASM-2"], repo: "api" });
  });

  it("does not expand a card when its checkbox is clicked", () => {
    render(<App />);
    authed();
    apiPool();
    selectRepo("api");
    sent.mockClear();
    fireEvent.click(checks()[0]);
    expect(sent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "detail" }));
  });

  it("Clear selection empties the batch and hides the action bar", () => {
    render(<App />);
    authed();
    apiPool();
    selectRepo("api");
    fireEvent.click(checks()[0]);
    expect(screen.getByRole("button", { name: /Launch in parallel/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Clear selection/i }));
    expect(screen.queryByRole("button", { name: /Launch in parallel/i })).not.toBeInTheDocument();
  });

  it("clears the batch selection when a fresh pool arrives", () => {
    render(<App />);
    authed();
    apiPool();
    selectRepo("api");
    fireEvent.click(checks()[0]);
    expect(screen.getByRole("button", { name: /Launch in parallel/i })).toBeInTheDocument();
    apiPool(); // new tasks message
    expect(screen.queryByRole("button", { name: /Launch in parallel/i })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/webview/App.test.tsx`
Expected: FAIL — `.card-check` elements don't exist and there's no "Launch in parallel" button.

- [ ] **Step 4: Add batch state and the clear-on-refetch behavior**

In `src/webview/App.tsx`, add state right after the `clearRepos` definition (around line 111):

```tsx
  const clearRepos = () => setSelectedRepos(new Set());
  // Multi-select batch launch (only surfaced when the repo filter is one repo).
  const [batchSelected, setBatchSelected] = React.useState<Set<string>>(new Set());
  const toggleBatch = (key: string) =>
    setBatchSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const clearBatch = () => setBatchSelected(new Set());
```

In the `case "tasks":` handler, clear the batch alongside the existing `setExpanded(new Set());` (around line 176):

```tsx
          setTasks(m.tasks);
          setExpanded(new Set());
          setBatchSelected(new Set());
```

- [ ] **Step 5: Derive batch mode and the launchable selection**

In `src/webview/App.tsx`, right after the `visibleTasks` computation (around line 288, before the `canReorder` line), add:

```tsx
  // Multi-select is offered only when the repo filter resolves to exactly one repo.
  const batchMode = selectedRepos.size === 1;
  const theRepo = batchMode ? [...selectedRepos][0] : null;
  // Only currently-visible tasks are launchable: a status/search filter that hides a
  // selected card silently drops it (state is untouched, just never launched).
  const selectedVisible = batchMode ? visibleTasks.filter((t) => batchSelected.has(t.key)) : [];
```

- [ ] **Step 6: Pass the checkbox prop to each card and render the action bar**

In `src/webview/App.tsx`, in the `visibleTasks.map(...)` that renders `<TaskCard>` (around line 446), add a `batch` prop:

```tsx
          <TaskCard
            key={t.key}
            task={t}
            me={me}
            prReviewStatus={prReviewStatus}
            open={expanded.has(t.key)}
            detail={details[t.key]}
            onToggle={() => toggleExpand(t.key)}
            onSelect={(sel) => setSelected(t.key, sel)}
            batch={batchMode ? { checked: batchSelected.has(t.key), onToggle: () => toggleBatch(t.key) } : undefined}
            dnd={
```

Then insert the action bar **immediately before** the existing final `{toastStack}` (around line 472). The `{toastStack}` line already exists — do NOT re-add it; insert only the `{batchMode && ...}` block above it:

```tsx
      {batchMode && selectedVisible.length > 0 && (
        <div className="batch-bar">
          <span className="batch-count">{selectedVisible.length} selected</span>
          <button
            className="batch-selectall"
            onClick={() => setBatchSelected(new Set(visibleTasks.map((t) => t.key)))}
          >
            Select all visible
          </button>
          <button className="batch-clear" onClick={clearBatch}>Clear selection</button>
          <button
            className="batch-launch"
            title={`Open ${selectedVisible.length} worktrees in ${theRepo}, each with its own Claude Code session`}
            onClick={() => send({ type: "takeBatch", keys: selectedVisible.map((t) => t.key), repo: theRepo! })}
          >
            <PlayIcon /> Launch in parallel
          </button>
        </div>
      )}
      {/* {toastStack} — this line already exists here; leave it in place after the block above */}
```

- [ ] **Step 7: Add the checkbox to `TaskCard`**

In `src/webview/App.tsx`, extend the `TaskCard` props type (around line 498) to accept the `batch` prop:

```tsx
function TaskCard(props: {
  task: JiraTask;
  me: string | null;
  prReviewStatus: string;
  open: boolean;
  detail?: DetailState;
  onToggle: () => void;
  onSelect: (selected: string[]) => void;
  batch?: { checked: boolean; onToggle: () => void };
  dnd?: CardDnd;
}): JSX.Element {
  const { task, me, prReviewStatus, open, detail, onToggle, onSelect, batch, dnd } = props;
```

Then render the checkbox as the first child inside `.card-top` (immediately after `<div className="card-top">`, before the `{dnd && ( ...grip )}` block, around line 563):

```tsx
        <div className="card-top">
          {batch && (
            <input
              type="checkbox"
              className="card-check"
              checked={batch.checked}
              title="Select for parallel launch"
              onClick={(e) => e.stopPropagation()}
              onChange={() => batch.onToggle()}
            />
          )}
          {dnd && (
```

- [ ] **Step 8: Add the styles**

In `src/webview/styles.ts`, append these rules just before the closing backtick of the exported CSS template (after the existing `.text-search` rules):

```css
  .card-check { flex: 0 0 auto; margin: 0 6px 0 0; cursor: pointer;
    accent-color: var(--vscode-button-background); }
  .batch-bar { position: sticky; bottom: 0; z-index: 2; display: flex; align-items: center; gap: 8px;
    margin-top: 6px; padding: 8px 10px;
    background: var(--vscode-sideBar-background);
    border-top: 1px solid var(--vscode-panel-border); }
  .batch-count { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .batch-selectall, .batch-clear { background: none; border: none; cursor: pointer; padding: 0;
    font-size: 11px; color: var(--vscode-textLink-foreground); }
  .batch-launch { margin-left: auto; display: inline-flex; align-items: center; gap: 5px;
    font-size: 12px; padding: 4px 12px; border-radius: 8px; border: none; cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .batch-launch:hover { background: var(--vscode-button-hoverBackground); }
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run test/webview/App.test.tsx`
Expected: PASS (all, including the new `multi-select & parallel launch` block).

- [ ] **Step 10: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add src/types.ts src/webview/App.tsx src/webview/styles.ts test/webview/App.test.tsx
git commit -m "feat(webview): multi-select checkboxes + parallel-launch bar (one filtered repo)"
```

---

### Task 3: Host — `takeBatch` orchestrator

Handles the `takeBatch` message: guards, one prompt-mode pick, then a worktree'd `openWorkspace` per task with a stagger and a summary toast. Also DRYs the prompt-mode picker shared with `takeTask`.

**Files:**
- Modify: `src/tasksView.ts` (module-level `delay`/stagger, `choosePromptMode` helper, `takeBatch` method, `onMessage` case; refactor `takeTask` to use the helper)
- Test: `test/unit/tasksView.test.ts` (add `batchLaunchConfirmThreshold` to `CFG`; add a `takeBatch` describe)

**Interfaces:**
- Consumes: `InboundMessage` variant `{ type: "takeBatch"; keys: string[]; repo: string }` (Task 2); `discoverRepos`, `createWorktrees(services, key, summary, log)`, `openWorkspace(req)` (all already imported in `tasksView.ts`); `AgentFlowConfig.batchLaunchConfirmThreshold` (Task 1); the existing private `buildBrief(detail)` and `this.client().getDetail(key)`.
- Produces: `TasksViewProvider.takeBatch(keys: string[], repo: string): Promise<void>` and a private `choosePromptMode(cfg: AgentFlowConfig, title: string): Promise<PromptMode | undefined>`.

- [ ] **Step 1: Add `batchLaunchConfirmThreshold` to the test CFG**

In `test/unit/tasksView.test.ts`, add the field to the `CFG` literal (right after the `worktree: "never" as const,` line, around line 58) so `CFG` remains assignable to the widened `AgentFlowConfig`:

```ts
  worktree: "never" as const,
  batchLaunchConfirmThreshold: 6,
```

- [ ] **Step 2: Write the failing host tests**

Add this describe block to `test/unit/tasksView.test.ts` (after the `takeTask` describe closes, around line 710). It reuses the file's `setup`, `getConfig`, `discoverRepos`, `createWorktrees`, `openWorkspace`, `window`, `mkRepos`, `CFG` helpers:

```ts
describe("takeBatch", () => {
  const twoKeys = ["ASM-1", "ASM-2"];

  it("launches one worktree'd new window per selected task in the filtered repo", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api", "billing"]));
    const { provider } = setup();
    await provider.takeBatch(twoKeys, "api");
    expect(vi.mocked(createWorktrees)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(createWorktrees).mock.calls[0][0]).toEqual([expect.objectContaining({ name: "api" })]);
    expect(openWorkspace).toHaveBeenCalledTimes(2);
    expect(openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ mode: "per-window", openIn: "new" }));
  });

  it("uses the configured task prompt mode without prompting", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    const { provider } = setup();
    await provider.takeBatch(["ASM-1"], "api"); // CFG.taskMode = "plan" is a known mode
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ promptTemplate: "P {key}" }));
  });

  it("asks the prompt mode once when taskMode is 'ask' and applies it to all", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, taskMode: "ask" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ mode: CFG.promptModes[0] } as never);
    const { provider } = setup();
    await provider.takeBatch(twoKeys, "api");
    expect(window.showQuickPick).toHaveBeenCalledTimes(1); // once, not per task
    expect(openWorkspace).toHaveBeenCalledTimes(2);
  });

  it("aborts when the prompt-mode pick is cancelled", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, taskMode: "ask" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined);
    const { provider } = setup();
    await provider.takeBatch(twoKeys, "api");
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it("errors when the filtered repo is not a git repo", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"], { isGit: false }));
    const { provider, posted } = setup();
    await provider.takeBatch(["ASM-1"], "api");
    expect(createWorktrees).not.toHaveBeenCalled();
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "error" }));
  });

  it("errors when the repo name is not found", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["billing"]));
    const { provider, posted } = setup();
    await provider.takeBatch(["ASM-1"], "api");
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "error" }));
  });

  it("continues past a failing task and reports the failure count", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(openWorkspace)
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce({ mode: "per-window", workspaceFile: undefined, briefs: [], opened: ["/x"] });
    const { provider, posted } = setup();
    await provider.takeBatch(twoKeys, "api");
    expect(openWorkspace).toHaveBeenCalledTimes(2);
    const toast = posted().find((m) => m.type === "toast") as { level: string; message: string };
    expect(toast.level).toBe("error");
    expect(toast.message).toContain("Launched 1 of 2");
  });

  it("confirms before launching more than the threshold, and aborts if dismissed", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, batchLaunchConfirmThreshold: 1 });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(window.showWarningMessage).mockResolvedValueOnce(undefined); // dismissed
    const { provider } = setup();
    await provider.takeBatch(twoKeys, "api"); // 2 > 1 → confirm
    expect(window.showWarningMessage).toHaveBeenCalled();
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it("routes the takeBatch message through onMessage to the handler", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    const { send } = setup();
    await send({ type: "takeBatch", keys: ["ASM-1"], repo: "api" });
    expect(openWorkspace).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/unit/tasksView.test.ts`
Expected: FAIL — `provider.takeBatch` is not a function.

- [ ] **Step 4: Add the module-level stagger helper**

In `src/tasksView.ts`, add after the `SPRINT_ORDER_KEY` constant (around line 15):

```ts
const SPRINT_ORDER_KEY = "agentFlow.sprintOrder";

/** Delay between opening successive batch windows — reduces focus-stealing and
 *  `open -a` thrash when several windows launch back-to-back. */
const BATCH_STAGGER_MS = 250;
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
```

- [ ] **Step 5: Extract the shared prompt-mode picker**

In `src/tasksView.ts`, add this private method (place it just above `takeTask`, around line 562):

```ts
  /** Resolve the task prompt mode: the configured `taskMode` when it names a known
   * mode, otherwise a QuickPick. Returns undefined only when the picker is cancelled. */
  private async choosePromptMode(cfg: AgentFlowConfig, title: string): Promise<PromptMode | undefined> {
    const modes = cfg.promptModes;
    const configured = modes.find((m) => m.id === cfg.taskMode);
    if (configured) return configured;
    const p = await vscode.window.showQuickPick(
      modes.map((mm) => ({
        label: mm.label,
        detail: mm.prompt.replace(/\{[a-z]+\}/g, "").replace(/\s+/g, " ").trim().slice(0, 80),
        mode: mm,
      })),
      { title, ignoreFocusOut: true },
    );
    return p?.mode;
  }
```

Then replace the inline prompt-mode block at the top of `takeTask` (the `const modes = cfg.promptModes; let promptMode ... if (!promptMode) { ... }` block, around lines 567–580) with:

```ts
    // How should the agent start — pick a prompt mode (or use the configured default) FIRST.
    const promptMode = await this.choosePromptMode(cfg, `${key} — how should the agent start?`);
    if (!promptMode) return;
```

(The rest of `takeTask` continues to use `promptMode.prompt` unchanged.)

- [ ] **Step 6: Add the `onMessage` case**

In `src/tasksView.ts`, add to the `onMessage` switch, right after the `case "take":` block (around line 172):

```ts
        case "take": {
          await this.takeTask(m.key, m.services);
          break;
        }
        case "takeBatch": {
          await this.takeBatch(m.keys, m.repo);
          break;
        }
```

- [ ] **Step 7: Implement `takeBatch`**

In `src/tasksView.ts`, add this public method (place it just after `takeTask`, around line 588):

```ts
  /** Launch several tasks in parallel, each in its own git worktree + new window with
   * its own seeded Claude session. Offered by the webview only when the repo filter is
   * one repo; every task opens a worktree in that repo. The prompt mode is asked once
   * and applied to all; one task's failure never aborts the rest. */
  public async takeBatch(keys: string[], repo: string): Promise<void> {
    const cfg = getConfig();
    if (!keys.length) return;

    if (!(await this.auth.isAuthenticated())) {
      const ok = await vscode.commands.executeCommand<boolean>("agentFlow.signIn");
      if (!ok) return;
    }

    const repos = discoverRepos(cfg.reposRoot, cfg.repoBlocklist);
    const repoRef = repos.find((r) => r.name === repo);
    if (!repoRef) {
      this.toast("error", `Repo "${repo}" not found under ${cfg.reposRoot}.`);
      return;
    }
    if (!repoRef.isGit) {
      this.toast("error", `Batch launch needs a git repo — "${repo}" isn't one. Each task opens its own worktree.`);
      return;
    }

    if (keys.length > cfg.batchLaunchConfirmThreshold) {
      const go = await vscode.window.showWarningMessage(
        `Launch ${keys.length} tasks in parallel? That opens ${keys.length} windows, each with its own Claude Code session.`,
        { modal: true },
        "Launch",
      );
      if (go !== "Launch") return;
    }

    const promptMode = await this.choosePromptMode(cfg, `Launch ${keys.length} selected task(s) — how should the agents start?`);
    if (!promptMode) return;

    let ok = 0;
    const failed: string[] = [];
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      try {
        const detail = await this.client().getDetail(key);
        const services = createWorktrees([repoRef], detail.key, detail.summary, this.log);
        await openWorkspace({
          ticket: { key: detail.key, summary: detail.summary, url: detail.url },
          planMd: this.buildBrief(detail),
          descriptionText: detail.descriptionText,
          services,
          mode: "per-window",
          promptTemplate: promptMode.prompt,
          workspaceDir: cfg.workspaceDir,
          seedAgent: cfg.seedAgent,
          openIn: "new",
        });
        ok++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failed.push(`${key} (${msg})`);
        this.log(`takeBatch ${key}: failed — ${msg}`);
      }
      if (i < keys.length - 1) await delay(BATCH_STAGGER_MS);
    }

    const summary = `Launched ${ok} of ${keys.length} in parallel.`;
    if (failed.length) this.toast("error", `${summary} Failed: ${failed.join("; ")}`);
    else this.toast("success", `${summary} A worktree + Claude session per task.`);
  }
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run test/unit/tasksView.test.ts`
Expected: PASS — including the new `takeBatch` block and all existing `takeTask` tests (the prompt-mode refactor preserves their behavior).

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add src/tasksView.ts test/unit/tasksView.test.ts
git commit -m "feat(host): takeBatch — parallel worktree'd launch of selected tasks"
```

---

### Task 4: Full verification & README

Confirms the whole suite is green, the bundle builds, and documents the feature.

**Files:**
- Modify: `README.md` (document the multi-select parallel launch)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS — the entire suite green (config, webview, host, engine).

- [ ] **Step 2: Typecheck and build the bundle**

Run: `npm run typecheck && npm run build`
Expected: no type errors; esbuild produces `dist/` with no errors.

- [ ] **Step 3: Document the feature in the README**

In `README.md`, under the **What it does** list (near the "Open + seed" bullet), add:

```markdown
- **Launch in parallel** — narrow the repo filter to a single repo and a checkbox
  appears on each task. Tick several, then **Launch in parallel**: each task opens
  in its own git worktree (its own branch) in its own window, with its own Claude
  Code session pre-seeded — several agents working the same repo at once. Batches
  larger than `agentFlow.batchLaunchConfirmThreshold` (default 6) ask first.
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document multi-select parallel launch"
```

---

## Notes for the implementer

- **Why worktrees are forced:** every task writes its brief to `<repo>/.pick-task/TASK.md`. Two tasks in the same repo without worktrees would overwrite each other's brief and share a branch. `createWorktrees` remaps each task's path to `.claude/worktrees/<KEY>` (its own branch `<KEY>-<slug>`), so briefs, branches, and window identities are all distinct — which is also what lets each opened window self-seed its own Claude session.
- **Why no engine change for the launch loop:** `openWorkspace(..., mode: "per-window", openIn: "new")` is exactly the single-task path the existing tests cover. The batch just calls it once per task after hoisting the prompt-mode question.
- **Deck:** `openWorkspace` already writes one `Run` per call, so every launched task appears on the Deck automatically — no extra work in `takeBatch`.
- **Test timing:** `takeBatch` awaits `delay(250)` between tasks; multi-task tests therefore take ~250 ms each (well under Vitest's default 5 s timeout). Do not mock it away — it exercises the real loop ordering.

## Out of scope (follow-up plan, after the seeding spike)

The **one-shared-window** layout and the destination ("where") question are deferred, per the spec's *Sequencing* section. They depend on verifying whether `claude-vscode.primaryEditor.open(session, prompt)` can open N distinct sessions in one window. When that spike lands, a follow-up plan adds: the destination pick (separate windows vs one shared window), a multi-root workspace built from N worktrees, N `Run` records for the one window, and `seedManyClaudeSessions` (with the "seed the first + info about the rest" fallback).
