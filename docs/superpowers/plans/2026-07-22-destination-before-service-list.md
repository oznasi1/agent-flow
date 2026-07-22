# Destination-Before-Service-List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the Take and Explore flows, choose the open destination *before* the service list, pre-check the repos the destination already contains, and move Take's prompt-mode question to the top.

**Architecture:** `chooseOpenTarget` moves ahead of the service pick — into `resolveKickoff` (shared by Take and Address PR) and inline in `explore()`. A new pure engine helper `workspaceFolderPaths(file)` plus a tasksView helper `prefillPathsForTarget(target)` supply the set of canonical paths the destination already holds, which the service/repo quick-picks use to pre-check items. `launch` receives the resolved `target` as a parameter instead of asking for it.

**Tech Stack:** TypeScript, VS Code extension API, `jsonc-parser`, Vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-22-destination-before-service-list-design.md`.
- No new configuration keys; no `types.ts` message changes.
- No change to `chooseOpenTarget`, `targetToOpenArgs`, `chooseWorkspaceMode`, `pickExistingWorkspace`, or `mergeReposIntoWorkspace` behavior.
- No prefill for `new` / `current` destinations (nothing to merge into).
- Multi-root-vs-per-window question keeps its existing trigger (new window + >1 repo only) — only its position relative to the service list changes.
- Prompt-mode pick is shown only when `agentFlow.taskMode` is `"ask"` (a configured fixed mode skips it); Explore has no prompt-mode pick.
- Follow the codebase's existing per-module private `canon()` convention (matches `engine/workspace.ts`, `engine/presence.ts`, `engine/status.ts`).
- Test commands run from the worktree root; `npm test` must stay green (baseline: 486 passing).

---

### Task 1: `workspaceFolderPaths` engine helper

**Files:**
- Modify: `src/engine/workspace.ts` (add exported function after `mergeReposIntoWorkspace`, ~line 317)
- Test: `test/unit/engine/workspace.test.ts` (add a `describe` block; extend the import on line 4)

**Interfaces:**
- Consumes: existing module-private `canon(p: string): string` (hoisted, defined later in the same file); `jsoncParse`, `ParseError` (already imported); `fs`, `path` (already imported).
- Produces: `export function workspaceFolderPaths(file: string): string[]` — canonical absolute paths of the folders declared in a `.code-workspace` file; `[]` on unreadable/unparseable input or a missing/non-array `folders`.

- [ ] **Step 1: Write the failing tests**

Add to the top-of-file import on line 4 of `test/unit/engine/workspace.test.ts` (append `workspaceFolderPaths`):

```ts
import { openWorkspace, maybeSeedAgent, watchPlansAndSeed, listWorkspaceFiles, mergeReposIntoWorkspace, workspaceFolderPaths, type OpenRequest } from "../../../src/engine/workspace";
```

Append this `describe` block to the end of `test/unit/engine/workspace.test.ts`:

```ts
describe("workspaceFolderPaths", () => {
  it("returns canonical folder paths, resolving relative paths against the file dir", () => {
    // realpathSync is mocked to identity in beforeEach, so canon() returns its input.
    readFileSync.mockReturnValue('{ "folders": [{ "path": "/repos/centaur" }, { "path": "account-service" }] }');
    const paths = workspaceFolderPaths("/repos/team.code-workspace");
    expect(paths).toEqual(["/repos/centaur", "/repos/account-service"]);
  });

  it("returns [] on unparseable input", () => {
    readFileSync.mockReturnValue("{ not json");
    expect(workspaceFolderPaths("/ws/bad.code-workspace")).toEqual([]);
  });

  it("returns [] when the file can't be read", () => {
    readFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
    expect(workspaceFolderPaths("/ws/missing.code-workspace")).toEqual([]);
  });

  it("returns [] when folders is missing or not an array", () => {
    readFileSync.mockReturnValue('{ "settings": {} }');
    expect(workspaceFolderPaths("/ws/nofolders.code-workspace")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/unit/engine/workspace.test.ts`
Expected: FAIL — `workspaceFolderPaths` is not exported (`workspaceFolderPaths is not a function`).

- [ ] **Step 3: Implement the helper**

In `src/engine/workspace.ts`, immediately after the closing brace of `mergeReposIntoWorkspace` (currently line 317, just before `const delay = ...`), add:

```ts
/** Canonical absolute paths of the folders declared in a `.code-workspace` file,
 * resolved against the file's directory. `[]` if the file can't be read or safely
 * parsed. Mirrors the existing-folder resolution in mergeReposIntoWorkspace so the
 * "which repos does this workspace already have" check stays consistent with the merge. */
export function workspaceFolderPaths(file: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const errors: ParseError[] = [];
  const doc = jsoncParse(text, errors, { allowTrailingComma: true }) as
    | { folders?: { path?: string }[] }
    | undefined;
  if (errors.length || !doc || typeof doc !== "object" || Array.isArray(doc) || !Array.isArray(doc.folders)) {
    return [];
  }
  const wsDir = path.dirname(file);
  return doc.folders
    .map((f) => f?.path)
    .filter((p): p is string => typeof p === "string")
    .map((p) => canon(path.resolve(wsDir, p)));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/unit/engine/workspace.test.ts`
Expected: PASS (all `workspaceFolderPaths` tests plus the untouched existing ones).

- [ ] **Step 5: Commit**

```bash
git add src/engine/workspace.ts test/unit/engine/workspace.test.ts
git commit -m "feat: workspaceFolderPaths helper — canonical folders of a .code-workspace"
```

---

### Task 2: Take + Address PR — destination first, prompt-mode first, prefilled service list

**Files:**
- Modify: `src/tasksView.ts` — add `fs` import (line 1 area) and `workspaceFolderPaths` to the workspace import (line 8); rework `resolveKickoff`, `launch`, `takeTask`, `addressPr`; add `prefillPathsForTarget` and a module-level `canon`.
- Test: `test/unit/tasksView.test.ts` — add `workspaceFolderPaths` to the workspace mock (line 13) and its import (line 27); add two new tests; strengthen one existing test.

**Interfaces:**
- Consumes: `workspaceFolderPaths(file)` (Task 1); existing `OpenTarget` union (tasksView line 18), `chooseOpenTarget`, `targetToOpenArgs`, `inferServices`, `createWorktrees`.
- Produces:
  - `resolveKickoff(key, preselected?)` now returns `{ detail: JiraDetail; services: ServiceRef[]; target: OpenTarget } | undefined` (was without `target`) and performs the destination pick internally.
  - `launch(detail: JiraDetail, services: ServiceRef[], promptTemplate: string, forceWorktree: boolean, target: OpenTarget): Promise<void>` (new trailing `target` param; no longer calls `chooseOpenTarget`).
  - `private prefillPathsForTarget(target: OpenTarget): Set<string>`.
  - module-level `function canon(p: string): string`.

- [ ] **Step 1: Write the failing / updated tests**

In `test/unit/tasksView.test.ts`, extend the workspace mock (currently line 13) and its import (line 27):

```ts
vi.mock("../../src/engine/workspace", () => ({ openWorkspace: vi.fn(), listWorkspaceFiles: vi.fn(() => []), workspaceFolderPaths: vi.fn(() => []) }));
```
```ts
import { openWorkspace, listWorkspaceFiles, workspaceFolderPaths } from "../../src/engine/workspace";
```

Replace the existing test `"aborts when the mode prompt is cancelled"` (currently lines 502–508) with a version that also proves the prompt-mode pick happens *before* the ticket read:

```ts
  it("asks the prompt mode first — a cancel there aborts before the ticket is read", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, taskMode: "ask" });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined); // cancel the prompt-mode pick
    const { provider } = setup();
    await provider.takeTask("ASM-1", ["account-service"]);
    expect(clientStub.getDetail).not.toHaveBeenCalled(); // aborted before resolveKickoff read the ticket
    expect(openWorkspace).not.toHaveBeenCalled();
  });
```

Add, at the end of the `describe("takeTask", ...)` block (just before its closing `});` at line ~690, after the `existing workspace open target` sub-describe), a prefill test:

```ts
  it("pre-checks repos the chosen existing workspace already contains", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask" }); // no preselection → service pick shows
    vi.mocked(workspaceFolderPaths).mockReturnValue(["/repos/centaur"]);
    vi.mocked(listWorkspaceFiles).mockReturnValue([{ file: "/ws/team.code-workspace", folders: 1, mtimeMs: 1 }]);
    // Destination is chosen first: open-target pick → workspace-file pick → service pick.
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ target: { kind: "existing-pick" } } as never)
      .mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never)
      .mockResolvedValueOnce([{ repo: mkRepos(["centaur"])[0] }] as never);

    const { provider } = setup();
    await provider.takeTask("ASM-1"); // no preselected repos

    // 3rd quick-pick is the service pick; centaur is pre-checked because it's in the workspace.
    const items = vi.mocked(window.showQuickPick).mock.calls[2][0] as Array<{ label: string; picked: boolean }>;
    expect(items.find((i) => i.label === "centaur")?.picked).toBe(true);
    expect(items.find((i) => i.label === "account-service")?.picked).toBe(false);
  });
```

> Note: `inferServices` and `fs` are NOT mocked in this test file. Real inference over summary "Do the thing" (no matching tokens) returns nothing, so `picked` comes only from prefill. Real `fs.realpathSync("/repos/centaur")` throws (path absent) so `canon` returns the path unchanged — matching the mocked `workspaceFolderPaths` value exactly.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/unit/tasksView.test.ts`
Expected: FAIL — the new prefill test fails (`resolveKickoff` doesn't compute `picked` from the target yet; also `workspaceFolderPaths` unused), and the prompt-mode-first test fails (`getDetail` currently runs before the prompt-mode pick because the pick lives after `resolveKickoff`).

- [ ] **Step 3: Add the `fs` import and `workspaceFolderPaths` import in `src/tasksView.ts`**

Change line 1 region to include `fs` and extend the workspace import (line 8):

```ts
import * as vscode from "vscode";
import * as fs from "fs";
```
```ts
import { openWorkspace, listWorkspaceFiles, workspaceFolderPaths } from "./engine/workspace";
```

- [ ] **Step 4: Rework `resolveKickoff` to pick the destination first and prefill the service list**

Replace the entire `resolveKickoff` method (currently lines 398–457) with:

```ts
  /** Read the ticket and resolve the destination + repo set for a kick-off (Take or
   * Address PR): auth gate, repo discovery, the destination pick, then the confirm-repos
   * QuickPick (pre-checking inferred repos AND repos the destination already contains).
   * `preselected` (the in-card selection) skips the confirm QuickPick. Returns undefined
   * on any abort. */
  private async resolveKickoff(
    key: string,
    preselected?: string[],
  ): Promise<{ detail: JiraDetail; services: ServiceRef[]; target: OpenTarget } | undefined> {
    const cfg = getConfig();
    if (!(await this.auth.isAuthenticated())) {
      const ok = await vscode.commands.executeCommand<boolean>("agentFlow.signIn");
      if (!ok) return undefined;
    }

    const detail = await vscode.window.withProgress(
      { location: { viewId: TasksViewProvider.viewType }, title: `Reading ${key}…` },
      () => this.client().getDetail(key),
    );

    const repos = discoverRepos(cfg.reposRoot, cfg.repoBlocklist);
    if (repos.length === 0) {
      this.toast("error", `No repos found under ${cfg.reposRoot}. Check agentFlow.reposRoot.`);
      return undefined;
    }

    // Destination first — where the task lands drives which repos the list pre-checks.
    const target = await this.chooseOpenTarget(cfg);
    if (!target) return undefined;

    let services: ServiceRef[];
    if (preselected && preselected.length) {
      // Selection already made in the expanded card — resolve names to repos, skip QuickPick.
      const byName = new Map(repos.map((r) => [r.name, r]));
      services = preselected.map((n) => byName.get(n)).filter((r): r is ServiceRef => !!r);
    } else {
      const inferred = inferServices(
        { summary: detail.summary, descriptionText: detail.descriptionText, labels: detail.labels, components: detail.components },
        repos,
      );
      const inferredNames = new Set(inferred.map((r) => r.service.name));
      const inWorkspace = this.prefillPathsForTarget(target);
      const tag = target.kind === "live-folder" ? "open here" : "in this workspace";

      // Confirm the service set (inferred + already-in-destination repos pre-selected).
      const picks = await vscode.window.showQuickPick<vscode.QuickPickItem & { repo: ServiceRef }>(
        repos.map((r) => {
          const present = inWorkspace.has(canon(r.path));
          const inf = inferredNames.has(r.name)
            ? `inferred (${inferred.find((i) => i.service.name === r.name)!.reason})`
            : "";
          return {
            label: r.name,
            description: [inf, present ? tag : ""].filter(Boolean).join(" · "),
            detail: r.isGit ? r.path : `${r.path}  (not a git repo)`,
            picked: inferredNames.has(r.name) || present,
            repo: r,
          };
        }),
        {
          canPickMany: true,
          title: `${key} — confirm the repos this task touches`,
          placeHolder: "Space to toggle · Enter to confirm",
          ignoreFocusOut: true,
        },
      );
      if (!picks || picks.length === 0) return undefined;
      services = picks.map((p) => p.repo);
    }
    if (services.length === 0) {
      this.toast("error", "No valid repos selected for this task.");
      return undefined;
    }
    return { detail, services, target };
  }

  /** Canonical paths the chosen destination already contains — used to pre-check the
   * service list. New / current windows contribute nothing (nothing to merge into). */
  private prefillPathsForTarget(target: OpenTarget): Set<string> {
    if (target.kind === "existing") return new Set(workspaceFolderPaths(target.file));
    if (target.kind === "live-folder") return new Set([canon(target.folder)]);
    return new Set();
  }
```

- [ ] **Step 5: Update `launch` to receive the target instead of asking for it**

Replace the `launch` doc comment (lines 459–461) and signature + the "Where should it open" block. The doc comment becomes:

```ts
  /** Open + seed a resolved kick-off: worktree decision → workspace mode → brief →
   * openWorkspace → success toast. Shared by Take and Address PR. The destination
   * `target` is resolved earlier in resolveKickoff. `forceWorktree` (Address PR) always
   * isolates in a worktree, ignoring cfg.worktree. */
```

Change the signature (currently lines 462–467) to add `target`:

```ts
  private async launch(
    detail: JiraDetail,
    services: ServiceRef[],
    promptTemplate: string,
    forceWorktree: boolean,
    target: OpenTarget,
  ): Promise<void> {
```

Delete these three lines (currently ~490–492):

```ts
    // Where should it open — new window, this window, a saved workspace, or a live window?
    const target = await this.chooseOpenTarget(cfg);
    if (!target) return;
```

The next line, `const args = await this.targetToOpenArgs(target, services.length, key, cfg);`, stays and now consumes the parameter. Leave the rest of `launch` unchanged.

- [ ] **Step 6: Move the prompt-mode pick to the top of `takeTask` and thread `target`**

Replace the entire `takeTask` method (currently lines 529–554) with:

```ts
  /** The pick flow: prompt mode → read ticket → destination → confirm services → open + seed.
   * `preselected` (from the in-card selection) skips the service QuickPick. */
  public async takeTask(key: string, preselected?: string[]): Promise<void> {
    const cfg = getConfig();

    // How should the agent start — pick a prompt mode (or use the configured default) FIRST.
    const modes = cfg.promptModes;
    let promptMode: PromptMode | undefined = modes.find((m) => m.id === cfg.taskMode);
    if (!promptMode) {
      const p = await vscode.window.showQuickPick(
        modes.map((mm) => ({
          label: mm.label,
          detail: mm.prompt.replace(/\{[a-z]+\}/g, "").replace(/\s+/g, " ").trim().slice(0, 80),
          mode: mm,
        })),
        { title: `${key} — how should the agent start?`, ignoreFocusOut: true },
      );
      if (!p) return;
      promptMode = p.mode;
    }

    const resolved = await this.resolveKickoff(key, preselected);
    if (!resolved) return;
    const { detail, services, target } = resolved;

    await this.launch(detail, services, promptMode.prompt, false, target);
  }
```

- [ ] **Step 7: Thread `target` through `addressPr`**

Replace the body of `addressPr` (currently lines 560–565) with:

```ts
  public async addressPr(key: string, preselected?: string[]): Promise<void> {
    const resolved = await this.resolveKickoff(key, preselected);
    if (!resolved) return;
    const { detail, services, target } = resolved;
    await this.launch(detail, services, this.prReviewTemplate(getConfig()), true, target);
  }
```

- [ ] **Step 8: Add the module-level `canon` helper**

At the bottom of `src/tasksView.ts` (next to the existing `getNonce` helper, outside the class), add:

```ts
/** Resolve symlinks so a destination's folder paths compare equal to discovered repo
 * paths (matches engine/workspace.ts's canon). */
function canon(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}
```

- [ ] **Step 9: Run the full test file to verify it passes**

Run: `npm test -- test/unit/tasksView.test.ts`
Expected: PASS — the two new/updated tests pass; every existing takeTask / existing-workspace / live-window / addressPr test still passes (they use `openIn:"new-window"` or preselected repos, so the reorder produces the same quick-pick sequence).

- [ ] **Step 10: Typecheck + commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add src/tasksView.ts test/unit/tasksView.test.ts
git commit -m "feat: destination chosen before service list for Take/Address PR, prompt-mode first, prefill from destination"
```

---

### Task 3: Explore — destination first, prefilled repo picker

**Files:**
- Modify: `src/tasksView.ts` — rework `explore()` (currently lines 307–371): move `chooseOpenTarget` above the repo pick and pre-check repos the destination contains (reusing `prefillPathsForTarget` + `canon` from Task 2).
- Test: `test/unit/tasksView.test.ts` — reorder the two `describe("explore — open target", ...)` tests to the new quick-pick sequence; add a prefill test.

**Interfaces:**
- Consumes: `prefillPathsForTarget(target)` and `canon` (Task 2); `chooseExploreAction`, `chooseOpenTarget`, `targetToOpenArgs`, `injectSlackDm`, `openWorkspace`.
- Produces: no new signatures.

- [ ] **Step 1: Update the order-sensitive Explore tests and add the prefill test**

In `test/unit/tasksView.test.ts`, the `describe("explore — open target", ...)` block: the destination pick now runs **before** the repo pick. Replace the two tests' quick-pick mock chains.

For `"routes Explore through the open-target picker and into an existing workspace"` (currently lines 761–778), the mock chain becomes:

```ts
    vi.mocked(window.showInputBox).mockResolvedValueOnce("retries");
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ target: { kind: "existing-pick" } } as never)  // open where (first)
      .mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never)    // which workspace
      .mockResolvedValueOnce([{ repo: mkRepos(["account-service"])[0] }] as never); // repos (last)
    vi.mocked(listWorkspaceFiles).mockReturnValue([{ file: "/ws/team.code-workspace", folders: 1, mtimeMs: 1 }]);
```

For `"opens an Explore session into a live folder window"` (currently lines 780–795), the mock chain becomes:

```ts
    vi.mocked(window.showInputBox).mockResolvedValueOnce("poke around");
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ target: { kind: "live-folder", folder: "/repos/centaur" } } as never) // open where (first)
      .mockResolvedValueOnce([{ repo: mkRepos(["centaur"])[0] }] as never);                            // repos (last)
```

Add a prefill test inside the same `describe("explore — open target", ...)` block:

```ts
  it("pre-checks repos the chosen existing workspace already contains", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask", exploreMode: "knowledge" });
    vi.mocked(workspaceFolderPaths).mockReturnValue(["/repos/centaur"]);
    vi.mocked(listWorkspaceFiles).mockReturnValue([{ file: "/ws/team.code-workspace", folders: 1, mtimeMs: 1 }]);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("x");
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ target: { kind: "existing-pick" } } as never)
      .mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never)
      .mockResolvedValueOnce([{ repo: mkRepos(["centaur"])[0] }] as never);

    await runExplore();

    // 3rd quick-pick is the repo picker; centaur is pre-checked (present in the workspace).
    const items = vi.mocked(window.showQuickPick).mock.calls[2][0] as Array<{ label: string; picked: boolean }>;
    expect(items.find((i) => i.label === "centaur")?.picked).toBe(true);
    expect(items.find((i) => i.label === "account-service")?.picked).toBe(false);
  });
```

- [ ] **Step 2: Run the Explore tests to verify they fail**

Run: `npm test -- test/unit/tasksView.test.ts -t "explore — open target"`
Expected: FAIL — with the current source the repo pick still fires first, so the reordered chains and the new prefill assertion don't match.

- [ ] **Step 3: Rework `explore()`**

Replace the body of `explore()` from the repo-pick section onward. Specifically, replace everything from the `const picks = ...` repo QuickPick (currently line 329) up to and including `const args = await this.targetToOpenArgs(...)` (currently line 347). The section that currently reads:

```ts
    const picks = await vscode.window.showQuickPick<vscode.QuickPickItem & { repo: ServiceRef }>(
      repos.map((r) => ({
        label: r.name,
        detail: r.isGit ? r.path : `${r.path}  (not a git repo)`,
        repo: r,
      })),
      {
        canPickMany: true,
        title: "Explore — pick the repos to open",
        placeHolder: "Space to toggle · Enter to open",
        ignoreFocusOut: true,
      },
    );
    if (!picks || picks.length === 0) return;
    const services = picks.map((p) => p.repo);

    const target = await this.chooseOpenTarget(cfg);
    if (!target) return;
    const args = await this.targetToOpenArgs(target, services.length, "Explore", cfg);
    if (!args) return;
```

becomes (destination first, repo picker pre-checks what the destination holds):

```ts
    // Destination first, so the repo picker can pre-check what it already contains.
    const target = await this.chooseOpenTarget(cfg);
    if (!target) return;
    const inWorkspace = this.prefillPathsForTarget(target);
    const tag = target.kind === "live-folder" ? "open here" : "in this workspace";

    const picks = await vscode.window.showQuickPick<vscode.QuickPickItem & { repo: ServiceRef }>(
      repos.map((r) => {
        const present = inWorkspace.has(canon(r.path));
        return {
          label: r.name,
          description: present ? tag : "",
          detail: r.isGit ? r.path : `${r.path}  (not a git repo)`,
          picked: present,
          repo: r,
        };
      }),
      {
        canPickMany: true,
        title: "Explore — pick the repos to open",
        placeHolder: "Space to toggle · Enter to open",
        ignoreFocusOut: true,
      },
    );
    if (!picks || picks.length === 0) return;
    const services = picks.map((p) => p.repo);

    const args = await this.targetToOpenArgs(target, services.length, "Explore", cfg);
    if (!args) return;
```

Leave everything below (`const slug = ...`, `planMd`, `openWorkspace({...})`, the success toast) unchanged.

- [ ] **Step 4: Run the full test file to verify it passes**

Run: `npm test -- test/unit/tasksView.test.ts`
Expected: PASS — reordered Explore tests, the new prefill test, and all other Explore tests (which use `openIn:"new-window"`, so `chooseOpenTarget` doesn't prompt and the `[action?, repos]` sequence is unchanged) pass.

- [ ] **Step 5: Run the whole suite + typecheck**

Run: `npm test`
Expected: PASS — all files green (≥ the 486 baseline, plus the new tests).

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/tasksView.ts test/unit/tasksView.test.ts
git commit -m "feat: destination chosen before repo list in Explore, prefill repos from destination"
```

---

## Self-Review

**1. Spec coverage:**
- "Whole `chooseOpenTarget` picker moves ahead of the service list (both flows)" → Task 2 (resolveKickoff), Task 3 (explore). ✓
- "Reorder + prefill from destination (existing workspace / live folder)" → Task 1 (`workspaceFolderPaths`), Task 2 & 3 (`prefillPathsForTarget` + `picked`). ✓
- "Take's prompt-mode question first; only when `taskMode` is `ask`; Explore unchanged" → Task 2 Step 6 (moved above `resolveKickoff`, still gated on `find(...)` miss). ✓
- "Multi-root-vs-per-window trigger unchanged" → `targetToOpenArgs`/`chooseWorkspaceMode` untouched; only its call site moved after the service pick, which it already was. ✓
- "No prefill for New/This window" → `prefillPathsForTarget` returns empty for `new`/`current`. ✓
- "Merge non-destructive; picker contents unchanged; no new config" → no edits to `mergeReposIntoWorkspace`, `chooseOpenTarget`, config. ✓
- Testing bullets (workspaceFolderPaths cases; destination-before-service; prefill; cancelled-destination abort; preselected path; prompt-mode-first cancel; mode-question trigger) → covered across Tasks 1–3. Cancelled-destination abort is exercised by the existing `"aborts the take when the 3-way open-target picker is cancelled"` and `"aborts the take when the workspace picker is cancelled"` tests, which still pass because `chooseOpenTarget` now runs inside `resolveKickoff`. ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to". Every code and test step shows full content. ✓

**3. Type consistency:** `resolveKickoff` returns `{ detail, services, target }` and every caller (`takeTask`, `addressPr`) destructures `target` and passes it to `launch(..., target)`, whose signature adds the matching `target: OpenTarget`. `prefillPathsForTarget(target: OpenTarget): Set<string>` is called in both `resolveKickoff` and `explore`; `canon(p: string): string` is defined once at module scope and used in both. `workspaceFolderPaths(file: string): string[]` is defined in Task 1 and consumed in `prefillPathsForTarget`. Names are consistent across tasks. ✓
