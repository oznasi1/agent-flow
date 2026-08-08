# "This window" Seeds In Place — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the "This window" open target start a Claude session in the current window without replacing its folders or reloading the extension host.

**Architecture:** `{ kind: "current" }` stops calling `vscode.openFolder` and instead writes a plan file whose single match is this window's own identity, so the plan watcher already running in this extension host seeds it — the same handshake the `existing` and `live-folder` targets use. The window's folder set is never touched. `openInEditor`'s same-window reuse branch is then deleted, making the folder-replacing reload unreachable.

**Tech Stack:** TypeScript, VS Code extension API, esbuild, Vitest (with a hand-written `vscode` mock).

**Spec:** [docs/superpowers/specs/2026-08-08-this-window-seeds-in-place-design.md](../specs/2026-08-08-this-window-seeds-in-place-design.md)

## Global Constraints

Every task's requirements implicitly include this section.

- **Branch:** `this-window-seeds-in-place`, already created off `origin/main` at `ab67abe` (release 0.6.0). Do all work there.
- **Do NOT bump the version, do NOT build a `.vsix`, do NOT merge to `main`.** The release happens after this plan completes, as a separate step the user drives.
- **Gates that must pass before any commit** (these are the repo's CI gates; they are not optional and are not discoverable from the task text alone):
  - `npm run typecheck` — `tsc --noEmit`, must be clean.
  - `npm test` — `vitest run`, all tests green.
  - `npm run test:cov` — V8 coverage with **enforced thresholds**; changed files must be at **≥95%**.
  - `npm run build` — esbuild bundle of the extension host + both webviews. Run it even for host-only changes; `tsc` and the test suite both pass on code that `npm run build` rejects.
- **The `vscode` module is mocked** in `test/_mocks/vscode.ts` and aliased by `vitest.config.ts`. Source code type-checks against the real `@types/vscode`; only runtime values come from the mock. Tests import the mock by relative path to get `vi.Mock`-typed handles.
- **Commit style:** Conventional Commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`). End every commit message with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- **Comment style:** this codebase writes comments that explain *why*, often several lines, on non-obvious decisions. Match the surrounding density — do not add narration to obvious code, and do not leave a non-obvious choice unexplained.
- **Copy rules:** the picker item's detail text is exactly `Start a session here — keeps this window's folders` (em dash, not a hyphen). The toast fragment is exactly `in this window`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/engine/presence.ts` | Window identity + presence registry | **Add** `CurrentWindow` type and `currentWindow()` — this window's identity plus its root folders |
| `src/engine/workspace.ts` | Single-task open + seed, plan handshake | **Add** the current-window branch to `openWorkspace`; **remove** `openInEditor`'s `newWindow` parameter |
| `src/engine/batchWorkspace.ts` | Multi-task shared-window open + seed | **Add** the current-window branch to `openSharedWorkspace` |
| `src/tasksView.ts` | Picker, target resolution, toasts | Picker copy + omission, `this-window` fallback, `targetToOpenArgs`, `currentWindow` passthrough, shared toast helper |
| `README.md` | User-facing docs | Describe the new "This window" behavior |

`presence.ts` must not import from `workspace.ts` — `workspace.ts` already imports `presence.ts`, and the reverse would be a cycle. That is why `CurrentWindow.roots` is typed structurally (`{ name?: string; path: string }[]`) rather than reusing `workspace.ts`'s exported `WorkspaceFolder`. The two are structurally identical, so `mentionInWorkspace(here.roots, …)` type-checks without a cast.

---

### Task 1: `openWorkspace` seeds the current window in place

**Files:**
- Modify: `src/engine/presence.ts` (append after `windowIdentity`, ~line 40)
- Modify: `src/engine/workspace.ts:13` (import), `:45` (`OpenRequest.openIn` + new field), `:57-66` (`OpenResult`), `:183-184`, `:204-205`, `:289-301`
- Test: `test/unit/engine/presence.test.ts`, `test/unit/engine/workspace.test.ts`

**Interfaces:**
- Consumes: `windowIdentity()` and `canon` (already imported in `presence.ts`); `mentionInWorkspace(roots, repoPath, rel)` and `agentPrompt(ticket, mentions, template, briefPath?)` (already in `workspace.ts`).
- Produces:
  - `export interface CurrentWindow { identity: string; kind: "workspace" | "folder"; roots: { name?: string; path: string }[] }` in `presence.ts`
  - `export function currentWindow(): CurrentWindow | undefined` in `presence.ts`
  - `OpenRequest.currentWindow?: CurrentWindow`
  - `OpenResult.seededInPlace?: boolean`

- [ ] **Step 1: Write the failing test for `currentWindow()`**

Append to `test/unit/engine/presence.test.ts`. Check the top of that file first — if it does not already import `currentWindow`, add it to the existing import from `../../../src/engine/presence`.

```ts
describe("currentWindow", () => {
  it("returns the workspace identity with every root folder", () => {
    workspace.workspaceFile = { scheme: "file", fsPath: "/ws/team.code-workspace" } as never;
    workspace.workspaceFolders = [
      { name: "api", uri: { fsPath: "/repos/api" } },
      { name: "web", uri: { fsPath: "/repos/web" } },
    ] as never;

    expect(currentWindow()).toEqual({
      identity: "/ws/team.code-workspace",
      kind: "workspace",
      roots: [
        { name: "api", path: "/repos/api" },
        { name: "web", path: "/repos/web" },
      ],
    });
  });

  it("returns the folder identity for a single-folder window", () => {
    workspace.workspaceFile = undefined as never;
    workspace.workspaceFolders = [{ name: "api", uri: { fsPath: "/repos/api" } }] as never;

    expect(currentWindow()).toEqual({
      identity: "/repos/api",
      kind: "folder",
      roots: [{ name: "api", path: "/repos/api" }],
    });
  });

  // An empty window can't be named by a plan match, so it can't be a seed destination —
  // the picker relies on this undefined to hide "This window" entirely.
  it("returns undefined for a window with no identity", () => {
    workspace.workspaceFile = undefined as never;
    workspace.workspaceFolders = undefined as never;

    expect(currentWindow()).toBeUndefined();
  });
});
```

Match the existing file's setup: it already resets `workspace.workspaceFile` / `workspace.workspaceFolders` and mocks `fs.realpathSync` as identity for `canon`. If it does not reset them in a `beforeEach`, add the resets inside each test above rather than restructuring the file.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/unit/engine/presence.test.ts -t "currentWindow"`
Expected: FAIL — `currentWindow is not a function` (or a TS/import error naming `currentWindow`).

- [ ] **Step 3: Implement `currentWindow()`**

In `src/engine/presence.ts`, immediately after the `windowIdentity` function (which ends at line 40):

```ts
/** This window as a seed destination: its identity plus the roots it actually has.
 *  Everything the "This window" open path needs, resolved in one place so the picker,
 *  the target resolver and the open path can't disagree about what "here" is.
 *
 *  `undefined` whenever `windowIdentity` is — an empty or untitled multi-root window
 *  can't be named by a plan match, so it can't be seeded, so it must not be offered.
 *
 *  Roots are canonicalized to match `workspaceFolders()`, whose output feeds the same
 *  `mentionInWorkspace` / `containingRoot` comparisons. */
export interface CurrentWindow {
  identity: string;
  kind: "workspace" | "folder";
  roots: { name?: string; path: string }[];
}

export function currentWindow(): CurrentWindow | undefined {
  const id = windowIdentity();
  if (!id) return undefined;
  const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => ({
    name: f.name,
    path: canon(f.uri.fsPath),
  }));
  return { identity: id.identity, kind: id.kind, roots };
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run test/unit/engine/presence.test.ts`
Expected: PASS, including the pre-existing tests.

- [ ] **Step 5: Write the failing tests for the `openWorkspace` current-window branch**

Append to `test/unit/engine/workspace.test.ts`. Add `type CurrentWindow` to the existing `../../../src/engine/presence` import if the file imports from it; otherwise write the object literals inline as shown (they are structurally typed, so no import is needed).

```ts
describe("openWorkspace — this window", () => {
  const folderWindow = { identity: "/repos/account-service", kind: "folder" as const, roots: [{ name: "account-service", path: "/repos/account-service" }] };

  it("seeds this window without opening or reloading anything", async () => {
    const result = await openWorkspace(
      baseReq({ openIn: "current", currentWindow: folderWindow }),
    );

    // The whole point: no `open -a`, and no vscode.openFolder in either direction.
    expect(exec).not.toHaveBeenCalled();
    expect(commands.executeCommand).not.toHaveBeenCalledWith("vscode.openFolder", expect.anything(), expect.anything());

    expect(result.seededInPlace).toBe(true);
    expect(result.opened).toEqual(["/repos/account-service"]);
  });

  it("names this window's identity as the single plan match", async () => {
    await openWorkspace(baseReq({ openIn: "current", currentWindow: folderWindow }));
    const planWrite = writeArg((p) => p.includes(".agentflow") && p.includes("plans") && p.endsWith(".json"));
    const plan = JSON.parse(String(planWrite![1]));
    expect(plan.matches).toHaveLength(1);
    expect(plan.matches[0].matchPath).toBe("/repos/account-service");
  });

  // Two repos would normally be laid out as a multiroot workspace file. Here the window
  // already exists and is not being laid out, so nothing is written and nothing is opened.
  it("writes no .code-workspace even for a multi-repo take", async () => {
    const result = await openWorkspace(
      baseReq({ openIn: "current", currentWindow: folderWindow }),
    );
    expect(writeArg((p) => p.endsWith(".code-workspace"))).toBeUndefined();
    expect(result.workspaceFile).toBeUndefined();
  });

  it("takes the mode from the window's own shape, not the repo count", async () => {
    const wsWindow = { identity: "/ws/team.code-workspace", kind: "workspace" as const, roots: [{ name: "api", path: "/repos/api" }] };
    const folder = await openWorkspace(baseReq({ openIn: "current", currentWindow: folderWindow }));
    const ws = await openWorkspace(baseReq({ openIn: "current", currentWindow: wsWindow }));
    expect(folder.mode).toBe("per-window");
    expect(ws.mode).toBe("multiroot");
  });

  // One match means the single-window guard passes, so a multi-repo take can offer
  // Remote Control here — it couldn't when "current" produced one match per repo.
  it("keeps Remote Control available for a multi-repo take", async () => {
    const result = await openWorkspace(
      baseReq({ openIn: "current", currentWindow: folderWindow, remoteControl: true }),
    );
    expect(result.remoteControl).toBe(true);
  });

  it("uses an absolute brief path so {brief} resolves outside this window's roots", async () => {
    await openWorkspace(
      baseReq({
        openIn: "current",
        currentWindow: folderWindow,
        promptTemplate: "Brief: {brief}",
      }),
    );
    const planWrite = writeArg((p) => p.includes(".agentflow") && p.includes("plans") && p.endsWith(".json"));
    const plan = JSON.parse(String(planWrite![1]));
    expect(plan.matches[0].prompt).toContain("/repos/account-service/.pick-task/TASK.md");
  });

  it("mentions files under a root and drops files outside every root", async () => {
    execSync.mockReturnValue("src/export.py\n"); // git ls-files result
    await openWorkspace(
      baseReq({
        openIn: "current",
        currentWindow: folderWindow, // only account-service is a root; centaur is not
        descriptionText: "fix `src/export.py`",
        promptTemplate: "Go{files}",
      }),
    );
    const planWrite = writeArg((p) => p.includes(".agentflow") && p.includes("plans") && p.endsWith(".json"));
    const prompt = String(JSON.parse(String(planWrite![1])).matches[0].prompt);
    expect(prompt).toContain("@account-service/src/export.py");
    expect(prompt).not.toContain("@centaur/");
  });
});
```

- [ ] **Step 6: Run them and confirm they fail**

Run: `npx vitest run test/unit/engine/workspace.test.ts -t "this window"`
Expected: FAIL — `currentWindow` is not a known property of `OpenRequest`, and `result.seededInPlace` is `undefined`.

- [ ] **Step 7: Extend the request/result types**

In `src/engine/workspace.ts`, change the import on line 13:

```ts
import { windowIdentity, type CurrentWindow } from "./presence";
```

Replace line 45:

```ts
  openIn?: "new" | "current"; // "current" reuses the running window; default "new"
```

with:

```ts
  openIn?: "new" | "current"; // "current" seeds THIS window in place; default "new"
  /** This window's identity + roots, supplied by the caller so the engine stays free of
   *  ambient window state (the same reason presence.ts takes its clock as an argument).
   *  REQUIRED when `openIn` is "current": a window with no identity can't be named by a
   *  plan match, so it can't be seeded, and the call falls back to the normal open path. */
  currentWindow?: CurrentWindow;
```

In `OpenResult`, after the `remoteControl` line (line 65):

```ts
  seededInPlace?: boolean; // "current": this window was seeded as-is; nothing was opened
```

- [ ] **Step 8: Add the current-window branch**

In `openWorkspace`, replace line 184:

```ts
  const newWindow = (req.openIn ?? "new") !== "current";
```

with:

```ts
  // "This window" only means anything if this window can be named by a plan match.
  // Without an identity there is nothing to seed, so the request degrades to the
  // normal open path rather than silently doing nothing.
  const here = req.openIn === "current" ? req.currentWindow : undefined;
```

Replace line 204:

```ts
  const effMode: WorkspaceMode = req.existingWorkspaceFile ? "multiroot" : req.existingFolder ? "per-window" : mode;
```

with:

```ts
  // For "this window" the mode DESCRIBES the window rather than choosing a layout for
  // one — nothing is being laid out, so the repo count has no say.
  const effMode: WorkspaceMode = here
    ? here.kind === "workspace"
      ? "multiroot"
      : "per-window"
    : req.existingWorkspaceFile
      ? "multiroot"
      : req.existingFolder
        ? "per-window"
        : mode;
```

Replace line 205's `if (req.existingWorkspaceFile) {` with a new leading branch:

```ts
  if (here) {
    // The window is left exactly as it is: no folder change, no reload, nothing opened.
    // One match named for this window's identity is enough — the plan watcher already
    // running in this extension host picks it up, the same handshake that seeds any
    // other live window.
    //
    // Mentions resolve against THIS window's roots and are dropped for anything outside
    // them: `@centaur/src/x.ts` when centaur isn't a root here would send the agent to a
    // different checkout, which is worse than no mention at all. `{brief}` is absolute
    // for the same reason its relative form can't be trusted off-root.
    const mentions = services.flatMap((s) =>
      (filesByRepo.get(s.name) ?? [])
        .map((f) => mentionInWorkspace(here.roots, s.path, f))
        .filter((m): m is string => !!m),
    );
    matches.push({
      matchPath: here.identity,
      prompt: agentPrompt(ticket, mentions, promptTemplate, briefs[0]?.path),
    });
  } else if (req.existingWorkspaceFile) {
```

- [ ] **Step 9: Skip the open, and drop the now-unused `newWindow`**

Replace the open block at lines 289-299:

```ts
  // 4 — open (new window, or reuse the current one)
  const opened: string[] = [];
  if (effMode === "multiroot") {
    if (await openInEditor(workspaceFile!, newWindow)) opened.push(workspaceFile!);
  } else if (req.existingFolder) {
    if (await openInEditor(req.existingFolder, newWindow)) opened.push(req.existingFolder);
  } else {
    for (const s of services) {
      if (await openInEditor(s.path, newWindow)) opened.push(s.path);
    }
  }
```

with:

```ts
  // 4 — open, unless the destination is the window we're already in
  const opened: string[] = [];
  if (here) {
    opened.push(here.identity); // nothing to open; report where the session lands
  } else if (effMode === "multiroot") {
    if (await openInEditor(workspaceFile!)) opened.push(workspaceFile!);
  } else if (req.existingFolder) {
    if (await openInEditor(req.existingFolder)) opened.push(req.existingFolder);
  } else {
    for (const s of services) {
      if (await openInEditor(s.path)) opened.push(s.path);
    }
  }
```

The `here` check must come first: a workspace-kind current window has `effMode === "multiroot"` but no `workspaceFile`, so the multiroot branch would dereference `workspaceFile!` as `undefined`.

Then extend the return on line 301:

```ts
  return { mode: effMode, workspaceFile, briefs, opened, mergedRepos, mergeFailed, unaddedRepos, remoteControl, seededInPlace: !!here };
```

- [ ] **Step 10: Run the full engine suite**

Run: `npx vitest run test/unit/engine/workspace.test.ts test/unit/engine/presence.test.ts`
Expected: PASS — all new tests plus every pre-existing one.

- [ ] **Step 11: Run the gates**

Run: `npm run typecheck && npm test && npm run build`
Expected: clean typecheck, all tests green, successful bundle.

- [ ] **Step 12: Commit**

```bash
git add src/engine/presence.ts src/engine/workspace.ts test/unit/engine/presence.test.ts test/unit/engine/workspace.test.ts
git commit -m "feat(workspace): seed this window in place instead of replacing it

The \"current\" open target called vscode.openFolder against the running
window, swapping its folder set and reloading the extension host. It now
writes a single plan match naming this window's identity and opens nothing,
so the plan watcher already running here seeds it — the handshake the
live-window targets have always used.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `openSharedWorkspace` seeds the current window in place

**Files:**
- Modify: `src/engine/batchWorkspace.ts:35-44` (`SharedOpenRequest`), `:46-54` (`SharedOpenResult`), `:103-141`, `:165-199`
- Test: `test/unit/engine/batchWorkspace.test.ts:212-224` (replace the existing "reloads the current window" test)

**Interfaces:**
- Consumes: `CurrentWindow` from `src/engine/presence` (Task 1); `mentionInWorkspace` and `workspaceFolders` (already imported in `batchWorkspace.ts`).
- Produces: `SharedOpenRequest.currentWindow?: CurrentWindow`; `SharedOpenResult.seededInPlace?: boolean`.

- [ ] **Step 1: Replace the existing current-window test with the new expectation**

In `test/unit/engine/batchWorkspace.test.ts`, delete this test at lines 212-224 (the comment above it describes behavior that no longer exists):

```ts
  // `target.kind !== "current"` is the whole this-window flow: the current window has to
  // be replaced in place (which reloads it, firing the seed handshake), never spawned.
  it("reloads the current window instead of spawning one for target 'current'", async () => {
    const result = await openSharedWorkspace(baseReq({ target: { kind: "current" } }));
    expect(exec).not.toHaveBeenCalled();
    expect(commands.executeCommand).toHaveBeenCalledWith(
      "vscode.openFolder",
      expect.objectContaining({ fsPath: "/ws/ASM-1+1.code-workspace" }),
      { forceNewWindow: false },
    );
    expect(result.opened).toBe(true);
  });
```

and put this in its place:

```ts
  // "This window" is the one destination that changes nothing about the window it
  // targets: every task's plan names it, and no window is opened or reloaded.
  describe("target 'current'", () => {
    const here = { identity: "/repos/api", kind: "folder" as const, roots: [{ name: "api", path: "/repos/api" }] };

    it("seeds this window without opening or reloading anything", async () => {
      const result = await openSharedWorkspace(
        baseReq({ target: { kind: "current" }, currentWindow: here }),
      );
      expect(exec).not.toHaveBeenCalled();
      expect(commands.executeCommand).not.toHaveBeenCalledWith("vscode.openFolder", expect.anything(), expect.anything());
      expect(result.seededInPlace).toBe(true);
      expect(result.opened).toBe(true);
    });

    it("points every task's plan at this window and writes no workspace file", async () => {
      const result = await openSharedWorkspace(
        baseReq({ target: { kind: "current" }, currentWindow: here }),
      );
      const plans = writes((p) => p.includes(".agentflow") && p.includes("plans") && p.endsWith(".json"));
      expect(plans).toHaveLength(2);
      for (const p of plans) {
        expect(JSON.parse(String(p[1])).matches[0].matchPath).toBe("/repos/api");
      }
      expect(writes((p) => p.endsWith(".code-workspace"))).toHaveLength(0);
      expect(result.workspaceFile).toBeUndefined();
    });

    // The worktrees live at /repos/api/.claude/worktrees/<KEY>, i.e. inside the root
    // this window has, so each one earns a precise mention through that root.
    it("resolves mentions against this window's roots", async () => {
      execSync.mockReturnValue("src/export.py\n");
      await openSharedWorkspace(
        baseReq({
          target: { kind: "current" },
          currentWindow: here,
          promptTemplate: "Go{files}",
          tasks: [
            {
              ticket: { key: "ASM-1", summary: "one", url: "https://jira/ASM-1" },
              planMd: "## Plan\n\na",
              descriptionText: "fix `src/export.py`",
              services: [{ name: "api", path: "/repos/api/.claude/worktrees/ASM-1", isGit: true }],
            },
          ],
        }),
      );
      const plan = JSON.parse(String(writes((p) => p.includes("plans") && p.endsWith(".json"))[0][1]));
      expect(String(plan.matches[0].prompt)).toContain("@api/.claude/worktrees/ASM-1/src/export.py");
    });
  });
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run test/unit/engine/batchWorkspace.test.ts -t "current"`
Expected: FAIL — `currentWindow` is not a known property of `SharedOpenRequest`; a `.code-workspace` is still written and `exec` is still called.

- [ ] **Step 3: Extend the request/result types**

In `src/engine/batchWorkspace.ts`, add to the existing import from `./presence` (create the import if the file has none):

```ts
import { type CurrentWindow } from "./presence";
```

In `SharedOpenRequest`, after the `target` field:

```ts
  /** This window's identity + roots. REQUIRED when `target.kind` is "current" — without
   *  it there is no plan match that names this window, so nothing would seed. */
  currentWindow?: CurrentWindow;
```

In `SharedOpenResult`, after `seeded`:

```ts
  seededInPlace?: boolean; // "current": this window was seeded as-is; nothing was opened
```

- [ ] **Step 4: Add the current-window branch to the destination resolution**

In `openSharedWorkspace`, destructure the new field by changing line 71:

```ts
  const { tasks, promptTemplate, workspaceDir, seedAgent, target } = req;
```

to:

```ts
  const { tasks, promptTemplate, workspaceDir, seedAgent, target } = req;
  const here = target.kind === "current" ? req.currentWindow : undefined;
```

Then in the step-3 destination chain (line 109), add a leading branch before `if (target.kind === "existing")`:

```ts
  if (here) {
    // Seed this window as it stands — no workspace file, nothing opened. The worktrees
    // aren't roots here unless they happen to sit inside one, exactly as with any other
    // already-open destination; the absolute brief paths carry the context regardless.
    openTarget = here.identity;
  } else if (target.kind === "existing") {
```

- [ ] **Step 5: Resolve mentions against this window's roots**

Replace line 137:

```ts
  const roots = target.kind === "existing" ? workspaceFolders(target.file) ?? [] : undefined;
```

with:

```ts
  // "current" resolves against the roots this window actually has, for the same reason
  // "existing" resolves against the file's: a mention naming a root the window doesn't
  // have silently points at a different checkout.
  const roots = here ? here.roots : target.kind === "existing" ? workspaceFolders(target.file) ?? [] : undefined;
```

- [ ] **Step 6: Take the Run mode from the window's shape, and skip the open**

Replace line 171 inside the Run construction:

```ts
      mode: workspaceFile ? "multiroot" : "per-window",
```

with:

```ts
      mode: here ? (here.kind === "workspace" ? "multiroot" : "per-window") : workspaceFile ? "multiroot" : "per-window",
```

Replace the open at lines 188-198:

```ts
  // 5 — open once.
  const opened = await openInEditor(openTarget, target.kind !== "current");
  return {
    workspaceFile,
    opened,
    briefs,
    mergedFolders,
    mergeFailed,
    unaddedFolders,
    seeded: seedAgent ? tasks.length : 0,
  };
```

with:

```ts
  // 5 — open once, unless the destination is the window we're already in.
  const opened = here ? true : await openInEditor(openTarget);
  return {
    workspaceFile,
    opened,
    briefs,
    mergedFolders,
    mergeFailed,
    unaddedFolders,
    seeded: seedAgent ? tasks.length : 0,
    seededInPlace: !!here,
  };
```

- [ ] **Step 7: Run them and confirm they pass**

Run: `npx vitest run test/unit/engine/batchWorkspace.test.ts`
Expected: PASS — the three new tests plus every pre-existing one.

- [ ] **Step 8: Run the gates**

Run: `npm run typecheck && npm test && npm run build`
Expected: clean typecheck, all tests green, successful bundle.

- [ ] **Step 9: Commit**

```bash
git add src/engine/batchWorkspace.ts test/unit/engine/batchWorkspace.test.ts
git commit -m "feat(batch): seed this window in place for a shared-window batch

A 'current' batch built a .code-workspace and reloaded the running window
into it. Every task's plan now names this window's identity instead, and
nothing is opened — matching the single-take path.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Remove `openInEditor`'s same-window reuse

**Files:**
- Modify: `src/engine/workspace.ts:161-179`
- Test: `test/unit/engine/workspace.test.ts`

**Interfaces:**
- Consumes: nothing new. After Tasks 1 and 2 no caller passes `newWindow`; verify with `rg -n "openInEditor\(" src/` before editing — every remaining call site must pass exactly one argument.
- Produces: `export function openInEditor(target: string): Promise<boolean>`.

- [ ] **Step 1: Confirm there are no `false` callers left**

Run: `rg -n "openInEditor\(" src/`
Expected: every hit passes a single argument. If any call still passes a second argument, stop — Task 1 or Task 2 is incomplete.

- [ ] **Step 2: Write the failing test**

Append to the `describe("openWorkspace — multiroot", …)` block in `test/unit/engine/workspace.test.ts`, next to the existing "falls back to openFolder when `open -a` fails" test:

```ts
  // The same-window reuse branch is gone: openFolder is only ever reached as the
  // fallback for a failed `open -a`, and only ever with forceNewWindow: true.
  it("never asks openFolder to reuse the current window", async () => {
    exec.mockImplementation(((_cmd: string, cb: (e: unknown) => void) => cb(new Error("no app"))) as never);
    await openWorkspace(baseReq());
    const reuse = commands.executeCommand.mock.calls.filter(
      (c) => c[0] === "vscode.openFolder" && (c[2] as { forceNewWindow?: boolean })?.forceNewWindow === false,
    );
    expect(reuse).toEqual([]);
  });
```

- [ ] **Step 3: Run it**

Run: `npx vitest run test/unit/engine/workspace.test.ts -t "never asks openFolder to reuse"`
Expected: PASS already — Task 1 removed the only path that reached it. This test is the regression guard that keeps the branch from coming back; a passing result here is the expected outcome, not a reason to skip the next step.

- [ ] **Step 4: Delete the parameter and the branch**

In `src/engine/workspace.ts`, replace lines 161-169:

```ts
// ── opening ───────────────────────────────────────────────────────────────────
export function openInEditor(target: string, newWindow = true): Promise<boolean> {
  // Reuse the current window: replace its folder(s) in place. This reloads the window,
  // so the seed-on-activation handshake fires here. (`open -a` can't target this window.)
  if (!newWindow) {
    return Promise.resolve(
      vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(target), { forceNewWindow: false }),
    ).then(() => true, () => false);
  }
  const app = vscode.env.appName || "Cursor";
```

with:

```ts
// ── opening ───────────────────────────────────────────────────────────────────
/** Open `target` in a separate window, or focus the window that already holds it —
 *  `open -a` does both, and falls back to openFolder when the app can't be shelled to.
 *
 *  There is deliberately no same-window mode. Replacing the running window's folders
 *  reloads the extension host and destroys whatever was open in it; "this window" is a
 *  seed destination now (see the `currentWindow` path in openWorkspace), not a reload. */
export function openInEditor(target: string): Promise<boolean> {
  const app = vscode.env.appName || "Cursor";
```

- [ ] **Step 5: Run the gates**

Run: `npm run typecheck && npm test && npm run build`
Expected: clean typecheck (no caller passes a second argument), all tests green, successful bundle.

- [ ] **Step 6: Commit**

```bash
git add src/engine/workspace.ts test/unit/engine/workspace.test.ts
git commit -m "refactor(workspace): drop openInEditor's same-window reuse

Nothing reaches it now that 'this window' seeds in place. Deleting the
branch rather than leaving it unused is what makes the folder-replacing
reload unreachable.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Wire the picker, the setting, and the toasts

**Files:**
- Modify: `src/tasksView.ts:872` (args type), `:986-988` / `:1058-1060` / `:1429-1431` (three `openWorkspace` call sites), `:993-995` / `:1070-1072` / `:1436-1438` (three `where` blocks), `:1645-1652` (`openSharedWorkspace` call), `:1774-1794` (`chooseOpenTarget`), `:1817-1829` (`targetToOpenArgs`)
- Test: `test/unit/tasksView.test.ts`

**Interfaces:**
- Consumes: `currentWindow()` and `type CurrentWindow` from `src/engine/presence` (Task 1); `OpenResult.seededInPlace` (Task 1); `SharedOpenRequest.currentWindow` (Task 2).
- Produces: `targetToOpenArgs` now returns `{ mode: WorkspaceMode; openIn: "new" | "current"; existingWorkspaceFile?: string; existingFolder?: string; currentWindow?: CurrentWindow }`.

- [ ] **Step 1: Add `currentWindow` to the presence mock**

`test/unit/tasksView.test.ts:52-54` mocks the whole presence module, so an unmocked export is `undefined` at runtime and every test that reaches the picker throws. Extend the factory:

```ts
vi.mock("../../src/engine/presence", () => ({
  readLiveWindows: vi.fn(() => []),
  windowIdentity: vi.fn(() => undefined),
  currentWindow: vi.fn(() => undefined),
}));
```

Add `currentWindow` to the value import at line 96:

```ts
import { readLiveWindows, windowIdentity, currentWindow } from "../../src/engine/presence";
```

and reset it alongside the others at line 201-202:

```ts
  vi.mocked(currentWindow).mockReturnValue(undefined);
```

- [ ] **Step 2: Write the failing tests**

Append to `test/unit/tasksView.test.ts`, in the describe block that already covers `chooseOpenTarget` (the one around lines 1773-1870):

```ts
    const HERE = { identity: "/repos/account-service", kind: "folder" as const, roots: [{ name: "account-service", path: "/repos/account-service" }] };

    it("offers This window with copy that promises the folders are kept", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask" });
      vi.mocked(currentWindow).mockReturnValue(HERE);
      window.showQuickPick.mockResolvedValueOnce(undefined); // cancel; we only inspect the items

      await view.takeTask("ASM-1");

      const items = window.showQuickPick.mock.calls[0][0] as { label: string; detail: string }[];
      const item = items.find((i) => i.label.includes("This window"));
      expect(item?.detail).toBe("Start a session here — keeps this window's folders");
    });

    // An empty or untitled multi-root window can't be named by a plan match, so offering
    // it would produce a take that silently seeds nothing.
    it("omits This window when this window has no identity", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask" });
      vi.mocked(currentWindow).mockReturnValue(undefined);
      window.showQuickPick.mockResolvedValueOnce(undefined);

      await view.takeTask("ASM-1");

      const items = window.showQuickPick.mock.calls[0][0] as { label: string }[];
      expect(items.some((i) => i.label.includes("This window"))).toBe(false);
    });

    it("passes this window through to openWorkspace for target 'current'", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "this-window" });
      vi.mocked(currentWindow).mockReturnValue(HERE);

      await view.takeTask("ASM-1");

      expect(openWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ openIn: "current", currentWindow: HERE, mode: "per-window" }),
      );
    });

    it("takes the mode from a workspace window's shape, not the repo count", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "this-window" });
      vi.mocked(currentWindow).mockReturnValue({
        identity: "/ws/team.code-workspace",
        kind: "workspace",
        roots: [{ name: "api", path: "/repos/api" }],
      });

      await view.takeTask("ASM-1");

      expect(openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ mode: "multiroot" }));
    });

    it("falls back to a new window when the this-window setting has no window to use", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "this-window" });
      vi.mocked(currentWindow).mockReturnValue(undefined);

      await view.takeTask("ASM-1");

      expect(openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ openIn: "new" }));
      expect(posted()).toContainEqual(
        expect.objectContaining({ type: "toast", level: "info", message: expect.stringContaining("no folder open") }),
      );
    });
```

Match the surrounding tests' setup for `view.takeTask("ASM-1")` — the existing block already stubs the connector, `openWorkspace`, and the repo picker. Reuse whatever helper those tests use rather than building a new fixture; if they call a differently named entry point (e.g. a `take` helper), use that instead.

Then, next to the toast assertions (the block around line 2440):

```ts
    it("says the session landed in this window", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "this-window" });
      vi.mocked(currentWindow).mockReturnValue(HERE);
      vi.mocked(openWorkspace).mockResolvedValue({
        mode: "per-window",
        briefs: [],
        opened: ["/repos/account-service"],
        remoteControl: false,
        seededInPlace: true,
      } as never);

      await view.takeTask("ASM-1");

      expect(posted()).toContainEqual(
        expect.objectContaining({ type: "toast", level: "success", message: expect.stringContaining("in this window") }),
      );
    });
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `npx vitest run test/unit/tasksView.test.ts -t "this window"`
Expected: FAIL — the detail text is still "replaces what's here", `currentWindow` is not passed to `openWorkspace`, and the toast reads "1 window(s)".

- [ ] **Step 4: Import `currentWindow` in `tasksView.ts`**

Extend the existing import from `./engine/presence`:

```ts
import { readLiveWindows, windowIdentity, currentWindow, type CurrentWindow } from "./engine/presence";
```

- [ ] **Step 5: Rewrite `chooseOpenTarget`**

Replace lines 1774-1794 with:

```ts
  private async chooseOpenTarget(cfg: AgentFlowConfig): Promise<OpenTarget | undefined> {
    // A window with no identity can't be named by a plan match, so it can't hold a
    // seeded session — "this window" is not offered, and the setting can't force it.
    const here = currentWindow();
    if (cfg.openIn === "new-window") return { kind: "new" };
    if (cfg.openIn === "this-window") {
      if (here) return { kind: "current" };
      this.toast(
        "info",
        "This window has no folder open, so it can't hold a session — opening a new window instead.",
      );
      return { kind: "new" };
    }
    if (cfg.openIn === "pick-existing") return this.pickExistingWorkspace(cfg);

    type PickTarget = OpenTarget | { kind: "existing-pick" };
    const thisWindow: { label: string; detail: string; target: PickTarget }[] = here
      ? [{ label: "$(window) This window", detail: "Start a session here — keeps this window's folders", target: { kind: "current" } }]
      : [];
    const base: { label: string; detail: string; target: PickTarget }[] = [
      { label: "$(empty-window) New window", detail: "Open the task in a separate window", target: { kind: "new" } },
      ...thisWindow,
      { label: "$(folder-library) Existing workspace…", detail: "Open the task into a .code-workspace you already have", target: { kind: "existing-pick" } },
    ];
    const live = cfg.trackOpenWindows ? this.liveWindowItems() : [];
    const p = await vscode.window.showQuickPick([...base, ...live], {
      title: "Open the task where?",
      placeHolder: "New window, this window, a saved workspace, or a window you have open",
      ignoreFocusOut: true,
    });
    if (!p) return undefined;
    if (p.target.kind === "existing-pick") return this.pickExistingWorkspace(cfg);
    return p.target;
  }
```

- [ ] **Step 6: Rewrite `targetToOpenArgs`**

Replace the signature's return type at line 1822 and the `current` line at 1825:

```ts
  private async targetToOpenArgs(
    target: OpenTarget,
    count: number,
    label: string,
    cfg: AgentFlowConfig,
  ): Promise<
    | { mode: WorkspaceMode; openIn: "new" | "current"; existingWorkspaceFile?: string; existingFolder?: string; currentWindow?: CurrentWindow }
    | undefined
  > {
    if (target.kind === "existing") return { mode: "multiroot", openIn: "new", existingWorkspaceFile: target.file };
    if (target.kind === "live-folder") return { mode: "per-window", openIn: "new", existingFolder: target.folder };
    if (target.kind === "current") {
      // The window's own shape is the mode — nothing is being laid out, so the repo
      // count has no say. A window that lost its identity between the pick and here
      // has no seed destination left, so the take cancels rather than opening something
      // the user didn't choose.
      const here = currentWindow();
      if (!here) return undefined;
      return { mode: here.kind === "workspace" ? "multiroot" : "per-window", openIn: "current", currentWindow: here };
    }
    const mode = await this.chooseWorkspaceMode(count, cfg.workspaceMode, label);
    if (!mode) return undefined;
    return { mode, openIn: "new" };
  }
```

Apply the same return-type widening to the `args` field of the `resolveKickoff`-style helper at line 872:

```ts
        args: { mode: WorkspaceMode; openIn: "new" | "current"; existingWorkspaceFile?: string; existingFolder?: string; currentWindow?: CurrentWindow };
```

- [ ] **Step 7: Pass `currentWindow` at all four call sites**

At each of the three `openWorkspace({ … })` calls (lines ~986, ~1058, ~1429), add one line directly after `existingFolder: args.existingFolder,`:

```ts
      currentWindow: args.currentWindow,
```

At the `openSharedWorkspace({ … })` call (line ~1645), add after `target,`:

```ts
          // The shared-window batch needs the same "here" the single take does.
          currentWindow: currentWindow(),
```

- [ ] **Step 8: Replace the three duplicated `where` blocks with one helper**

Add this private method next to `seededNote`:

```ts
  /** Where a completed open put the session, for the success toast. "This window" is
   *  its own case because nothing was opened — reporting "1 window(s)" would imply one
   *  appeared. */
  private openedWhere(result: { seededInPlace?: boolean; workspaceFile?: string; opened: string[] }): string {
    if (result.seededInPlace) return "in this window";
    if (result.workspaceFile) return `workspace ${result.workspaceFile.split("/").pop()}`;
    return `${result.opened.length} window(s)`;
  }
```

Then replace each of the three blocks (lines ~993-995, ~1070-1072, ~1436-1438), which are byte-identical:

```ts
    const where = result.workspaceFile
      ? `workspace ${result.workspaceFile.split("/").pop()}`
      : `${result.opened.length} window(s)`;
```

with:

```ts
    const where = this.openedWhere(result);
```

The surrounding sentences are unchanged: `Opened ${where} …` reads "Opened in this window for ASM-1."

- [ ] **Step 9: Run the tasksView suite**

Run: `npx vitest run test/unit/tasksView.test.ts`
Expected: PASS — the new tests plus every pre-existing one. Pre-existing tests asserting `openIn: "current"` (around lines 1857-1866 and 2948-2954) now also need `currentWindow` mocked; if one fails because `currentWindow()` returned `undefined`, add `vi.mocked(currentWindow).mockReturnValue(HERE)` to that test rather than loosening the assertion.

- [ ] **Step 10: Run the gates**

Run: `npm run typecheck && npm test && npm run build && npm run test:cov`
Expected: clean typecheck, all tests green, successful bundle, coverage thresholds met with the changed files at ≥95%.

- [ ] **Step 11: Commit**

```bash
git add src/tasksView.ts test/unit/tasksView.test.ts
git commit -m "feat(tasks): offer This window only where it can seed, and say so

The picker item promises the folders are kept, is hidden when this window
has no identity to seed, and the this-window setting falls back to a new
window with an explanation. The success toast says 'in this window' rather
than claiming a window was opened.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Document the behavior and sweep the gates

**Files:**
- Modify: `README.md`
- Test: none new — this task verifies the whole change together.

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Correct the `openIn` value description**

The passage lives under `### Where a task opens`, around README line 340. Replace:

```markdown
`agentFlow.openIn` controls where a task you take gets opened: `ask` (ask each time),
`new-window`, `this-window` (reuse the current window), or `pick-existing` — pick an
existing `.code-workspace` file to open the task into.
```

with:

```markdown
`agentFlow.openIn` controls where a task you take gets opened: `ask` (ask each time),
`new-window`, `this-window` (start a session in the window you're already in), or
`pick-existing` — pick an existing `.code-workspace` file to open the task into.
```

Leave the rest of that paragraph (skip-and-approve, preserved settings, multi-root) exactly as it is.

- [ ] **Step 2: Add the paragraph that states the guarantee**

Insert a new paragraph immediately after that first paragraph — before the one beginning "When taking a task (or starting an Explore session)…":

```markdown
`this-window` never replaces what's open. The window keeps its folders, its editors and
any session already running in it, and the task's agent starts alongside them. A window
with no folder open can't hold a seeded session, so **This window** isn't offered there
and `this-window` opens a new window instead.
```

- [ ] **Step 3: Verify no stale references to the old behavior survive**

Run: `rg -n -i "replaces what's here|reloads? the current window|reuse the current window" src/ test/ README.md docs/superpowers/plans docs/superpowers/specs`
Expected: hits only inside `docs/superpowers/specs/2026-08-08-this-window-seeds-in-place-design.md` and this plan, where they describe the old behavior on purpose. Any hit in `src/`, `test/`, or `README.md` is a leftover — fix it.

- [ ] **Step 4: Full gate sweep**

Run: `npm run typecheck && npm test && npm run build && npm run test:cov`
Expected: all four clean. Record the coverage numbers for `src/engine/workspace.ts`, `src/engine/batchWorkspace.ts`, `src/engine/presence.ts` and `src/tasksView.ts` — each must be ≥95%. If any fell below, add the missing tests before committing.

- [ ] **Step 5: Manual smoke test in the dev host**

Launch the extension development host with **VS Code's** `code` CLI (the Cursor CLI silently drops `--extensionDevelopmentPath`):

```bash
code --extensionDevelopmentPath="$PWD" "$PWD"
```

In the dev host: open a task, pick **This window**, and confirm the window does **not** reload, its folders are unchanged, your open editors survive, and a Claude session appears with the prompt pre-filled.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: This window keeps its folders instead of being replaced

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: Report, do not merge**

Summarize for the user: what changed, the coverage numbers from Step 4, and the smoke-test result. The version bump, `.vsix` build and merge to `main` are a separate step the user drives — do not perform them.

---

## Notes for the implementer

- **`here` is checked before every other branch** in both `openWorkspace` and `openSharedWorkspace`. A workspace-kind current window has `effMode === "multiroot"` but no `workspaceFile`; putting the check later dereferences `workspaceFile!` as `undefined`.
- **`prefillPathsForTarget` is deliberately untouched.** A current window contributes nothing to prefill because nothing is merged into it — that was already true and stays true.
- **Telemetry is untouched.** `DestinationProp` already carries `"current"`, and it still names the same destination.
- **Remote Control becoming available for multi-repo current-window takes is intended**, not an accident of the refactor. It follows from the single match, and the spec calls it out.
