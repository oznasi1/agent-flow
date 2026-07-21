# Open a task into an already-open window — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a taken task (and an Explore session) open into a VS Code window you already have open — a bare-repo folder window or a saved-workspace window — not only a new window or a saved `.code-workspace` file.

**Architecture:** Each window records its presence (its *seed identity* + pid) to `~/.agentflow/windows/<pid>.json`. The take/Explore flows read that registry to list live windows in the "Open where?" picker. Picking a live **workspace** window reuses the existing merge+focus path; picking a live **folder** window focuses it and seeds the agent there (a folder window can't gain root folders remotely). Staleness self-heals via pid-liveness.

**Tech Stack:** TypeScript, VS Code extension API, Vitest. The `vscode` module is aliased to `test/_mocks/vscode.ts` at test time; `fs`/`child_process` are `vi.mock`ed per suite.

## Global Constraints

- No new runtime dependencies. (deps today: `jsonc-parser`, `react`, `react-dom`.)
- VS Code engine floor: `^1.90.0`. `window.onDidChangeWindowState` is well within that.
- Presence and all cross-window IO is **best-effort**: a failure must never throw out of `activate()` or fail a take/explore. Follow the existing guard style in `extension.ts` and `workspace.ts`.
- Follow existing patterns: pure/testable engine functions in `src/engine/*`, `vi.mock` sibling modules in controller tests, TDD (failing test first), one commit per task.
- A window's **identity** is exactly what `maybeSeedAgent` matches on: canonical `.code-workspace` file path, else a lone folder path, else undefined. This must stay single-sourced.

---

### Task 1: `agentFlow.trackOpenWindows` setting

**Files:**
- Modify: `package.json` (contributes.configuration.properties)
- Modify: `src/config.ts` (`AgentFlowConfig` + `getConfig`)
- Test: `test/unit/config.test.ts`

**Interfaces:**
- Produces: `AgentFlowConfig.trackOpenWindows: boolean` (default `true`).

- [ ] **Step 1: Write the failing test**

Add to `test/unit/config.test.ts` (inside the existing top-level `describe`):

```ts
it("defaults trackOpenWindows to true and reads an override", () => {
  expect(getConfig().trackOpenWindows).toBe(true);
  setConfig({ trackOpenWindows: false });
  expect(getConfig().trackOpenWindows).toBe(false);
});
```

Ensure `setConfig` is imported at the top of the file alongside the existing mock import:
`import { setConfig } from "../_mocks/vscode";` (add only if not already present).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/config.test.ts -t "trackOpenWindows"`
Expected: FAIL — `getConfig().trackOpenWindows` is `undefined`.

- [ ] **Step 3: Add the setting to `package.json`**

In `contributes.configuration.properties`, after `agentFlow.worktree`, add:

```jsonc
"agentFlow.trackOpenWindows": {
  "type": "boolean",
  "default": true,
  "description": "Track your open Agent Flow windows so a task can be opened into a window you already have open (shown as extra choices in the “Open the task where?” picker)."
},
```

- [ ] **Step 4: Add it to `AgentFlowConfig` and `getConfig`**

In `src/config.ts`, add to the `AgentFlowConfig` interface (after `worktree`):

```ts
  trackOpenWindows: boolean;
```

And in the `getConfig()` return object (after the `worktree:` line):

```ts
    trackOpenWindows: c.get<boolean>("trackOpenWindows") ?? true,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/config.test.ts -t "trackOpenWindows"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json src/config.ts test/unit/config.test.ts
git commit -m "feat: add agentFlow.trackOpenWindows setting"
```

---

### Task 2: `presence.ts` — the window registry

**Files:**
- Create: `src/engine/presence.ts`
- Test: `test/unit/engine/presence.test.ts`

**Interfaces:**
- Produces:
  - `interface WindowIdentity { identity: string; kind: "workspace" | "folder"; label: string; folders: number }`
  - `interface PresenceRecord extends WindowIdentity { pid: number; updatedAt: number }`
  - `windowIdentity(): WindowIdentity | undefined` — reads `vscode.workspace`, canonicalizes.
  - `defaultWindowsDir(): string` → `~/.agentflow/windows`
  - `writePresence(dir: string, rec: PresenceRecord): void`
  - `removePresence(dir: string, pid: number): void`
  - `readLiveWindows(dir: string): PresenceRecord[]` — drops+prunes dead pids and unparseable files, dedupes by identity, newest first.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/engine/presence.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import { windowIdentity, writePresence, removePresence, readLiveWindows, type PresenceRecord } from "../../../src/engine/presence";
import { workspace } from "../../_mocks/vscode";

vi.mock("fs");

const readdirSync = vi.mocked(fs.readdirSync);
const readFileSync = vi.mocked(fs.readFileSync);
const writeFileSync = vi.mocked(fs.writeFileSync);
const mkdirSync = vi.mocked(fs.mkdirSync);
const rmSync = vi.mocked(fs.rmSync);
const realpathSync = vi.mocked(fs.realpathSync);

const rec = (over: Partial<PresenceRecord> = {}): PresenceRecord => ({
  pid: 111, identity: "/repos/foo", kind: "folder", label: "foo", folders: 1, updatedAt: 10, ...over,
});

beforeEach(() => {
  readdirSync.mockReset().mockReturnValue([] as never);
  readFileSync.mockReset().mockReturnValue("");
  writeFileSync.mockReset();
  mkdirSync.mockReset();
  rmSync.mockReset();
  realpathSync.mockReset().mockImplementation((p) => String(p)); // identity canon
  workspace.workspaceFile = undefined;
  workspace.workspaceFolders = undefined;
});

describe("windowIdentity", () => {
  it("is a workspace identity when a .code-workspace file is open", () => {
    workspace.workspaceFile = { scheme: "file", fsPath: "/ws/team.code-workspace" };
    workspace.workspaceFolders = [{ uri: { fsPath: "/repos/a" } }, { uri: { fsPath: "/repos/b" } }];
    expect(windowIdentity()).toEqual({ identity: "/ws/team.code-workspace", kind: "workspace", label: "team.code-workspace", folders: 2 });
  });

  it("is a folder identity for a single-folder window", () => {
    workspace.workspaceFolders = [{ uri: { fsPath: "/repos/foo" } }];
    expect(windowIdentity()).toEqual({ identity: "/repos/foo", kind: "folder", label: "foo", folders: 1 });
  });

  it("is undefined for an empty window", () => {
    expect(windowIdentity()).toBeUndefined();
  });

  it("is undefined for an untitled (non-file) workspace", () => {
    workspace.workspaceFile = { scheme: "untitled", fsPath: "/x" };
    workspace.workspaceFolders = [{ uri: { fsPath: "/repos/a" } }, { uri: { fsPath: "/repos/b" } }];
    expect(windowIdentity()).toBeUndefined();
  });
});

describe("writePresence / removePresence", () => {
  it("writes <pid>.json under the dir", () => {
    writePresence("/win", rec({ pid: 222 }));
    expect(mkdirSync).toHaveBeenCalledWith("/win", { recursive: true });
    const call = writeFileSync.mock.calls.find((c) => String(c[0]) === "/win/222.json");
    expect(call).toBeTruthy();
    expect(JSON.parse(String(call![1])).identity).toBe("/repos/foo");
  });

  it("never throws when the write fails", () => {
    writeFileSync.mockImplementation(() => { throw new Error("EACCES"); });
    expect(() => writePresence("/win", rec())).not.toThrow();
  });

  it("removes <pid>.json", () => {
    removePresence("/win", 222);
    expect(rmSync).toHaveBeenCalledWith("/win/222.json", { force: true });
  });
});

describe("readLiveWindows", () => {
  it("returns [] when the dir can't be read", () => {
    readdirSync.mockImplementation(() => { throw new Error("ENOENT"); });
    expect(readLiveWindows("/win")).toEqual([]);
  });

  it("keeps live pids, prunes dead ones, dedupes identity, newest first", () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid: number) => {
      if (pid === 999) { const e: NodeJS.ErrnoException = new Error("dead"); e.code = "ESRCH"; throw e; }
      return true as never;
    });
    readdirSync.mockReturnValue(["111.json", "222.json", "999.json", "notes.txt"] as never);
    readFileSync.mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith("111.json")) return JSON.stringify(rec({ pid: 111, identity: "/repos/a", updatedAt: 5 }));
      if (s.endsWith("222.json")) return JSON.stringify(rec({ pid: 222, identity: "/repos/b", updatedAt: 9 }));
      if (s.endsWith("999.json")) return JSON.stringify(rec({ pid: 999, identity: "/repos/c", updatedAt: 9 }));
      return "";
    });

    const live = readLiveWindows("/win");

    expect(live.map((w) => w.identity)).toEqual(["/repos/b", "/repos/a"]); // dead 999 pruned, newest first
    expect(rmSync).toHaveBeenCalledWith("/win/999.json", { force: true });
    killSpy.mockRestore();
  });

  it("prunes an unparseable record file", () => {
    vi.spyOn(process, "kill").mockReturnValue(true as never);
    readdirSync.mockReturnValue(["bad.json"] as never);
    readFileSync.mockReturnValue("{ not json");
    expect(readLiveWindows("/win")).toEqual([]);
    expect(rmSync).toHaveBeenCalledWith("/win/bad.json", { force: true });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/unit/engine/presence.test.ts`
Expected: FAIL — `Cannot find module '../../../src/engine/presence'`.

- [ ] **Step 3: Implement `src/engine/presence.ts`**

```ts
import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface WindowIdentity {
  identity: string; // canonical path — a .code-workspace file or a single folder
  kind: "workspace" | "folder";
  label: string; // basename, for display
  folders: number; // folder count in the window
}

export interface PresenceRecord extends WindowIdentity {
  pid: number; // the window's extension-host process id
  updatedAt: number; // epoch ms, stamped by the caller
}

/** ~/.agentflow/windows — the presence registry directory. */
export function defaultWindowsDir(): string {
  return path.join(os.homedir(), ".agentflow", "windows");
}

/** Resolve symlinks so identities compare equal across /var↔/private/var etc. */
function canon(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** This window's seed identity — the SAME value maybeSeedAgent matches on. A saved
 * .code-workspace file wins; else a lone folder; else undefined (empty windows and
 * untitled multi-root windows are neither trackable nor seedable). */
export function windowIdentity(): WindowIdentity | undefined {
  const wf = vscode.workspace.workspaceFile;
  if (wf && wf.scheme === "file") {
    const identity = canon(wf.fsPath);
    return { identity, kind: "workspace", label: path.basename(identity), folders: vscode.workspace.workspaceFolders?.length ?? 0 };
  }
  const folders = vscode.workspace.workspaceFolders;
  if (folders?.length === 1) {
    const identity = canon(folders[0].uri.fsPath);
    return { identity, kind: "folder", label: path.basename(identity), folders: 1 };
  }
  return undefined;
}

/** Write (or refresh) this window's presence record. Best-effort — never throws. */
export function writePresence(dir: string, rec: PresenceRecord): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${rec.pid}.json`), JSON.stringify(rec, null, 2));
  } catch {
    /* presence is a convenience — never fail a caller over it */
  }
}

/** Delete this window's presence record (deactivate cleanup). Best-effort. */
export function removePresence(dir: string, pid: number): void {
  try {
    fs.rmSync(path.join(dir, `${pid}.json`), { force: true });
  } catch {
    /* best-effort */
  }
}

/** `kill(pid, 0)` sends no signal — it only probes: it throws ESRCH for a dead pid
 * and EPERM for a live process we don't own. Either "no error" or EPERM ⇒ alive. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Read all presence records, pruning any whose process is dead and any that fail
 * to parse. Deduped by identity, newest first. */
export function readLiveWindows(dir: string): PresenceRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir) as unknown as string[];
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: PresenceRecord[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const file = path.join(dir, n);
    let rec: PresenceRecord;
    try {
      rec = JSON.parse(fs.readFileSync(file, "utf8")) as PresenceRecord;
    } catch {
      fs.rmSync(file, { force: true });
      continue;
    }
    if (typeof rec.pid !== "number" || !rec.identity || !pidAlive(rec.pid)) {
      fs.rmSync(file, { force: true });
      continue;
    }
    if (seen.has(rec.identity)) continue;
    seen.add(rec.identity);
    out.push(rec);
  }
  return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/unit/engine/presence.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/engine/presence.ts test/unit/engine/presence.test.ts
git commit -m "feat: window-presence registry (identity, read/write, pid-liveness prune)"
```

---

### Task 3: Wire presence lifecycle into activation

**Files:**
- Modify: `src/extension.ts` (`activate`, `deactivate`)
- Modify: `test/_mocks/vscode.ts` (add `window.onDidChangeWindowState`)
- Test: `test/unit/extension.test.ts`

**Interfaces:**
- Consumes: `windowIdentity`, `writePresence`, `removePresence`, `defaultWindowsDir` from `./engine/presence`; `getConfig().trackOpenWindows`.

- [ ] **Step 1: Add `onDidChangeWindowState` to the vscode mock**

In `test/_mocks/vscode.ts`, add to the `window` object (after `showOpenDialog`):

```ts
  onDidChangeWindowState: vi.fn((_cb: (e: unknown) => void) => ({ dispose: vi.fn() })),
```

And in `resetVscodeMocks()`, after the `showOpenDialog` reset line:

```ts
  window.onDidChangeWindowState.mockReset().mockImplementation(() => ({ dispose: vi.fn() }));
```

- [ ] **Step 2: Write the failing tests**

In `test/unit/extension.test.ts`, extend the workspace mock and add a presence mock + assertions.

Add a presence mock next to the other `vi.mock` calls (top of file):

```ts
vi.mock("../../src/engine/presence", () => ({
  windowIdentity: vi.fn(() => ({ identity: "/ws/team.code-workspace", kind: "workspace", label: "team.code-workspace", folders: 2 })),
  writePresence: vi.fn(),
  removePresence: vi.fn(),
  defaultWindowsDir: vi.fn(() => "/win"),
}));
```

Add to the imports:

```ts
import { windowIdentity, writePresence, removePresence } from "../../src/engine/presence";
import { deactivate } from "../../src/extension";
```

Add these tests inside `describe("activate", ...)`:

```ts
it("writes this window's presence on activation", () => {
  const { context } = fakeContext();
  activate(context);
  expect(writePresence).toHaveBeenCalledWith(
    "/win",
    expect.objectContaining({ identity: "/ws/team.code-workspace", pid: expect.any(Number) }),
  );
});

it("does not write presence for a window with no identity", () => {
  vi.mocked(windowIdentity).mockReturnValueOnce(undefined);
  const { context } = fakeContext();
  activate(context);
  expect(writePresence).not.toHaveBeenCalled();
});

it("removes this window's presence on deactivate", () => {
  deactivate();
  expect(removePresence).toHaveBeenCalledWith("/win", expect.any(Number));
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run test/unit/extension.test.ts -t "presence"`
Expected: FAIL — `writePresence`/`removePresence` never called.

- [ ] **Step 4: Implement the wiring in `src/extension.ts`**

Add imports near the top:

```ts
import { windowIdentity, writePresence, removePresence, defaultWindowsDir } from "./engine/presence";
```

Inside the existing best-effort `try { ... }` block in `activate` (after the `watchPlansAndSeed` subscription push), add:

```ts
    // Record this window's presence so a later "take" can open a task into it.
    if (getConfig().trackOpenWindows) {
      const stamp = () => {
        const id = windowIdentity();
        if (id) writePresence(defaultWindowsDir(), { ...id, pid: process.pid, updatedAt: Date.now() });
      };
      stamp();
      context.subscriptions.push(vscode.window.onDidChangeWindowState(stamp));
    }
```

Replace `deactivate`:

```ts
export function deactivate(): void {
  // Best-effort: drop this window's presence record so it stops being offered.
  try {
    removePresence(defaultWindowsDir(), process.pid);
  } catch {
    /* best-effort */
  }
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run test/unit/extension.test.ts`
Expected: PASS (new + existing activation tests, including "survives a live-seeding failure").

- [ ] **Step 6: Commit**

```bash
git add src/extension.ts test/_mocks/vscode.ts test/unit/extension.test.ts
git commit -m "feat: record window presence on activation, clear it on deactivate"
```

---

### Task 4: `openWorkspace` — open into an existing folder window

**Files:**
- Modify: `src/engine/workspace.ts` (`OpenRequest`, `OpenResult`, `openWorkspace`, and refactor `maybeSeedAgent` to use `windowIdentity`)
- Test: `test/unit/engine/workspace.test.ts`

**Interfaces:**
- Consumes: `windowIdentity` from `./presence`.
- Produces: `OpenRequest.existingFolder?: string`; `OpenResult.unaddedRepos?: string[]`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/engine/workspace.test.ts`:

```ts
describe("openWorkspace — existing folder window", () => {
  it("focuses the folder, seeds a matching plan, and reports repos not added as roots", async () => {
    // Two services; the open folder window is /repos/account-service.
    const result = await openWorkspace(
      baseReq({ existingFolder: "/repos/account-service" }),
    );

    expect(result.mode).toBe("per-window");
    expect(result.workspaceFile).toBeUndefined();
    expect(result.opened).toEqual(["/repos/account-service"]);
    // account-service IS the open folder; centaur can't be added as a root.
    expect(result.unaddedRepos).toEqual(["centaur"]);

    const planWrite = writeArg((p) => p.includes(".agentflow") && p.includes("plans") && p.endsWith(".json"));
    const plan = JSON.parse(String(planWrite![1]));
    expect(plan.matches).toHaveLength(1);
    expect(plan.matches[0].matchPath).toBe("/repos/account-service");
  });

  it("writes a brief into the target folder when it is not one of the repos", async () => {
    await openWorkspace(baseReq({ services: mkRepos(["solo"]), existingFolder: "/other/open-window" }));
    const brief = writeArg((p) => p === "/other/open-window/.pick-task/TASK.md");
    expect(brief).toBeTruthy();
    expect(String(brief![1])).toContain("ASM-1");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/unit/engine/workspace.test.ts -t "existing folder window"`
Expected: FAIL — `existingFolder` is ignored; falls through to per-window over `services`, so `opened` and `matchPath` are wrong.

- [ ] **Step 3: Refactor `maybeSeedAgent` to share the identity helper**

At the top of `src/engine/workspace.ts`, add to imports:

```ts
import { windowIdentity } from "./presence";
```

In `maybeSeedAgent`, replace the identity block (the `let identity` computation through the `if (!identity) return;`) with:

```ts
  const identity = windowIdentity()?.identity;
  log(`activation: window identity = ${identity ?? "(no single workspace)"}`);
  if (!identity) return;
```

- [ ] **Step 4: Add the request/result fields**

In `OpenRequest`, after `existingWorkspaceFile?: string;`:

```ts
  existingFolder?: string; // when set: focus this already-open folder window + seed it
```

In `OpenResult`, after `mergeFailed?: boolean;`:

```ts
  unaddedRepos?: string[]; // repos that couldn't be added as roots to a folder window
```

- [ ] **Step 5: Handle `existingFolder` in `openWorkspace`**

Change the `effMode` line to account for a folder target:

```ts
  const effMode: WorkspaceMode = req.existingWorkspaceFile ? "multiroot" : req.existingFolder ? "per-window" : mode;
```

Declare an `unaddedRepos` holder near `mergedRepos`/`mergeFailed`:

```ts
  let unaddedRepos: string[] | undefined;
```

Add a new branch to the build-target if-chain, **between** the `if (req.existingWorkspaceFile)` block and the `else if (mode === "multiroot")` block:

```ts
  } else if (req.existingFolder) {
    const folder = req.existingFolder;
    // Focus an already-open folder window and seed there. VS Code offers no way to
    // inject roots into a folder window remotely, so its folder set is unchanged;
    // ensure a brief exists IN that folder so the seeded relative {brief} resolves.
    if (!services.some((s) => canon(s.path) === canon(folder))) {
      const dir = path.join(folder, BRIEF_DIR);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, BRIEF_FILE), briefMarkdown(ticket, planMd, services, path.basename(folder), []));
      ensureGitExcluded(folder, `${BRIEF_DIR}/`);
    }
    unaddedRepos = services.filter((s) => canon(s.path) !== canon(folder)).map((s) => s.name);
    const mentions = services.flatMap((s) => (filesByRepo.get(s.name) ?? []).map((f) => mention("per-window", s.name, f)));
    matches.push({ matchPath: folder, prompt: agentPrompt(ticket, mentions, promptTemplate) });
```

Change the open step (step 4) to focus the folder when set:

```ts
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

Add `unaddedRepos` to the returned object:

```ts
  return { mode: effMode, workspaceFile, briefs, opened, mergedRepos, mergeFailed, unaddedRepos };
```

- [ ] **Step 6: Run to verify all workspace tests pass**

Run: `npx vitest run test/unit/engine/workspace.test.ts`
Expected: PASS — new folder-window tests plus all existing `maybeSeedAgent`/multiroot/per-window/existing-workspace tests (the identity refactor preserves behavior).

- [ ] **Step 7: Commit**

```bash
git add src/engine/workspace.ts test/unit/engine/workspace.test.ts
git commit -m "feat: openWorkspace can focus + seed an already-open folder window"
```

---

### Task 5: Offer live windows in the take flow's "Open where?" picker

**Files:**
- Modify: `src/tasksView.ts` (`OpenTarget`, `chooseOpenTarget`, new `liveWindowItems` + `targetToOpenArgs`, `takeTask`)
- Test: `test/unit/tasksView.test.ts`

**Interfaces:**
- Consumes: `readLiveWindows`, `windowIdentity`, `defaultWindowsDir` from `./engine/presence`; `OpenRequest.existingFolder` + `OpenResult.unaddedRepos` from Task 4; `cfg.trackOpenWindows` from Task 1.
- Produces: `OpenTarget` gains `{ kind: "live-folder"; folder: string }`. New private methods `liveWindowItems()` and `targetToOpenArgs(target, count, label, cfg)`.

- [ ] **Step 1: Update the test harness (mock + config)**

In `test/unit/tasksView.test.ts`:

Add a presence mock alongside the other `vi.mock` calls:

```ts
vi.mock("../../src/engine/presence", () => ({
  readLiveWindows: vi.fn(() => []),
  windowIdentity: vi.fn(() => undefined),
  defaultWindowsDir: vi.fn(() => "/win"),
}));
```

Add to the imports block:

```ts
import { readLiveWindows, windowIdentity } from "../../src/engine/presence";
```

Add `trackOpenWindows: true,` to the `CFG` object.

**Migrate the existing 3-way-picker items from `val` to `target`** in the `describe("existing workspace open target", ...)` block:
- `{ val: "new" }` → `{ target: { kind: "new" } }`
- `{ val: "existing" }` → `{ target: { kind: "existing-pick" } }`

(The `.mockResolvedValueOnce({ file: ... })` workspace-picker calls are unchanged.)

- [ ] **Step 2: Write the failing tests**

Add a new describe block to `test/unit/tasksView.test.ts`:

```ts
describe("live-window open targets", () => {
  const askCfg = () => vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask" });

  it("lists an open workspace window and opens the task into it (merge path)", async () => {
    askCfg();
    vi.mocked(readLiveWindows).mockReturnValue([
      { pid: 1, identity: "/ws/team.code-workspace", kind: "workspace", label: "team.code-workspace", folders: 2, updatedAt: 9 },
    ]);
    // The open-target picker returns the live workspace window's mapped target.
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ target: { kind: "existing", file: "/ws/team.code-workspace" } } as never);

    const { provider } = setup();
    await provider.takeTask("ASM-1", ["account-service"]);

    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ existingWorkspaceFile: "/ws/team.code-workspace", mode: "multiroot", openIn: "new" }),
    );
  });

  it("lists an open folder window and opens the task into it (focus + seed)", async () => {
    askCfg();
    vi.mocked(readLiveWindows).mockReturnValue([
      { pid: 1, identity: "/repos/account-service", kind: "folder", label: "account-service", folders: 1, updatedAt: 9 },
    ]);
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ target: { kind: "live-folder", folder: "/repos/account-service" } } as never);

    const { provider } = setup();
    await provider.takeTask("ASM-1", ["account-service"]);

    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ existingFolder: "/repos/account-service", mode: "per-window", openIn: "new" }),
    );
  });

  it("excludes the current window from the live list", async () => {
    askCfg();
    vi.mocked(windowIdentity).mockReturnValue({ identity: "/repos/account-service", kind: "folder", label: "account-service", folders: 1 });
    vi.mocked(readLiveWindows).mockReturnValue([
      { pid: 1, identity: "/repos/account-service", kind: "folder", label: "account-service", folders: 1, updatedAt: 9 },
      { pid: 2, identity: "/repos/centaur", kind: "folder", label: "centaur", folders: 1, updatedAt: 8 },
    ]);
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ target: { kind: "new" } } as never);

    const { provider } = setup();
    await provider.takeTask("ASM-1", ["account-service"]);

    const items = vi.mocked(window.showQuickPick).mock.calls[0][0] as { label: string }[];
    const labels = items.map((i) => i.label);
    expect(labels.some((l) => l.includes("centaur"))).toBe(true);
    expect(labels.some((l) => l.includes("account-service"))).toBe(false); // current window excluded
  });

  it("does not read live windows when tracking is disabled", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask", trackOpenWindows: false });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ target: { kind: "new" } } as never);

    const { provider } = setup();
    await provider.takeTask("ASM-1", ["account-service"]);

    expect(readLiveWindows).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run test/unit/tasksView.test.ts -t "live-window"`
Expected: FAIL — `chooseOpenTarget` doesn't add live items; `showQuickPick` items still use `val`; `existingFolder` never passed.

- [ ] **Step 4: Update `OpenTarget` and imports in `src/tasksView.ts`**

Add to imports:

```ts
import { openWorkspace, listWorkspaceFiles } from "./engine/workspace";
import { readLiveWindows, windowIdentity, defaultWindowsDir } from "./engine/presence";
```

(The `openWorkspace, listWorkspaceFiles` import line already exists — add the second line beneath it.)

Extend the `OpenTarget` type:

```ts
type OpenTarget =
  | { kind: "new" }
  | { kind: "current" }
  | { kind: "existing"; file: string }
  | { kind: "live-folder"; folder: string };
```

- [ ] **Step 5: Rewrite `chooseOpenTarget` and add `liveWindowItems`**

Replace the existing `chooseOpenTarget` method with:

```ts
  /** Where to open a taken task — new window, this window, a saved workspace, or a
   * window you already have open. Live windows appear only in the interactive "ask"
   * flow (a specific open window is inherently a per-take choice). */
  private async chooseOpenTarget(cfg: AgentFlowConfig): Promise<OpenTarget | undefined> {
    if (cfg.openIn === "new-window") return { kind: "new" };
    if (cfg.openIn === "this-window") return { kind: "current" };
    if (cfg.openIn === "pick-existing") return this.pickExistingWorkspace(cfg);

    type Pick = OpenTarget | { kind: "existing-pick" };
    const base: { label: string; detail: string; target: Pick }[] = [
      { label: "$(empty-window) New window", detail: "Open the task in a separate window", target: { kind: "new" } },
      { label: "$(window) This window", detail: "Open it in the current window (replaces what's here)", target: { kind: "current" } },
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

  /** Live Agent-Flow windows (excluding the current one) as open-target picks. A
   * workspace window maps to the existing merge+focus path; a folder window focuses
   * and seeds in place. */
  private liveWindowItems(): { label: string; detail: string; target: OpenTarget }[] {
    const self = windowIdentity()?.identity;
    return readLiveWindows(defaultWindowsDir())
      .filter((w) => w.identity !== self)
      .map((w) => ({
        label: `$(window) ${w.label}`,
        detail: w.kind === "workspace" ? `open now · ${w.folders} folder${w.folders === 1 ? "" : "s"}` : "open now",
        target: w.kind === "workspace" ? { kind: "existing", file: w.identity } : { kind: "live-folder", folder: w.identity },
      }));
  }
```

- [ ] **Step 6: Add `targetToOpenArgs` and simplify `takeTask`**

Add this helper (place it just after `chooseOpenTarget`/`liveWindowItems`):

```ts
  /** Resolve an OpenTarget to the openWorkspace arguments, asking the multiroot-vs-
   * per-window question only for a NEW window with more than one repo. Returns
   * undefined if the user cancels that sub-pick. */
  private async targetToOpenArgs(
    target: OpenTarget,
    count: number,
    label: string,
    cfg: AgentFlowConfig,
  ): Promise<{ mode: WorkspaceMode; openIn: "new" | "current"; existingWorkspaceFile?: string; existingFolder?: string } | undefined> {
    if (target.kind === "existing") return { mode: "multiroot", openIn: "new", existingWorkspaceFile: target.file };
    if (target.kind === "live-folder") return { mode: "per-window", openIn: "new", existingFolder: target.folder };
    if (target.kind === "current") return { mode: count === 1 ? "per-window" : "multiroot", openIn: "current" };
    const mode = await this.chooseWorkspaceMode(count, cfg.workspaceMode, label);
    if (!mode) return undefined;
    return { mode, openIn: "new" };
  }
```

In `takeTask`, replace everything from `// Where should it open …` through the end of the big `let mode: WorkspaceMode; … ` block and the `openWorkspace({ … })` call (the current lines that compute `target`, `mode`, and call `openWorkspace`) with:

```ts
    // Where should it open — new window, this window, a saved workspace, or a live window?
    const target = await this.chooseOpenTarget(cfg);
    if (!target) return;
    const args = await this.targetToOpenArgs(target, services.length, key, cfg);
    if (!args) return;

    const planMd = this.buildBrief(detail);
    const result = await openWorkspace({
      ticket: { key: detail.key, summary: detail.summary, url: detail.url },
      planMd,
      descriptionText: detail.descriptionText,
      services,
      mode: args.mode,
      promptTemplate: promptMode.prompt,
      workspaceDir: cfg.workspaceDir,
      seedAgent: cfg.seedAgent,
      openIn: args.openIn,
      existingWorkspaceFile: args.existingWorkspaceFile,
      existingFolder: args.existingFolder,
    });
```

Then update the success-toast tail (the `else` branch of `if (result.mergeFailed)`) to mention repos that couldn't be added as roots:

```ts
    } else {
      const added = result.mergedRepos?.length ? ` Added ${result.mergedRepos.join(", ")}.` : "";
      const unadded = result.unaddedRepos?.length
        ? ` ${result.unaddedRepos.join(", ")} couldn't be added as roots to that window — their briefs are still in place.`
        : "";
      this.toast("success", `Opened ${where} for ${key}. Brief seeded in each repo.${added}${unadded}${seeded}`);
    }
```

- [ ] **Step 7: Run the full tasksView suite**

Run: `npx vitest run test/unit/tasksView.test.ts`
Expected: PASS — new live-window tests plus the migrated existing-workspace tests.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/tasksView.ts test/unit/tasksView.test.ts
git commit -m "feat: offer already-open windows as task open targets"
```

---

### Task 6: Explore-flow parity

**Files:**
- Modify: `src/tasksView.ts` (`explore`)
- Test: `test/unit/tasksView.test.ts`

**Interfaces:**
- Consumes: `chooseOpenTarget` + `targetToOpenArgs` (Task 5).

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/tasksView.test.ts`:

```ts
describe("explore — open target", () => {
  const runExplore = async () => {
    const provider = setup().provider;
    await (provider as unknown as { explore: () => Promise<void> }).explore();
  };

  it("routes Explore through the open-target picker and into an existing workspace", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask" });
    // topic input → repo multi-pick → open-target pick (existing workspace) → ws pick
    vi.mocked(window.showInputBox).mockResolvedValueOnce("retries");
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce([{ repo: mkRepos(["account-service"])[0] }] as never) // repos
      .mockResolvedValueOnce({ target: { kind: "existing-pick" } } as never)        // open where
      .mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never);         // which workspace
    vi.mocked(listWorkspaceFiles).mockReturnValue([{ file: "/ws/team.code-workspace", folders: 1, mtimeMs: 1 }]);

    await runExplore();

    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ existingWorkspaceFile: "/ws/team.code-workspace", mode: "multiroot", openIn: "new" }),
    );
  });

  it("opens an Explore session into a live folder window", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask" });
    vi.mocked(readLiveWindows).mockReturnValue([
      { pid: 1, identity: "/repos/centaur", kind: "folder", label: "centaur", folders: 1, updatedAt: 9 },
    ]);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("poke around");
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce([{ repo: mkRepos(["centaur"])[0] }] as never)
      .mockResolvedValueOnce({ target: { kind: "live-folder", folder: "/repos/centaur" } } as never);

    await runExplore();

    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ existingFolder: "/repos/centaur", mode: "per-window", openIn: "new" }),
    );
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/unit/tasksView.test.ts -t "explore — open target"`
Expected: FAIL — `explore()` still uses `chooseWorkspaceMode` and never passes `existingWorkspaceFile`/`existingFolder`/`openIn`.

- [ ] **Step 3: Update `explore()` in `src/tasksView.ts`**

Replace the block from `const mode = await this.chooseWorkspaceMode(...)` through the `openWorkspace({ ... })` call with:

```ts
    const target = await this.chooseOpenTarget(cfg);
    if (!target) return;
    const args = await this.targetToOpenArgs(target, services.length, "Explore", cfg);
    if (!args) return;

    const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "explore";
    const planMd = `## Exploration: ${topic}\n\n_No Jira ticket yet — a knowledge/exploration session. If it turns into work, open a ticket afterwards._`;
    const result = await openWorkspace({
      ticket: { key: `explore-${slug}`, summary: topic, url: "" },
      planMd,
      descriptionText: "",
      services,
      mode: args.mode,
      promptTemplate: cfg.explorePrompt,
      workspaceDir: cfg.workspaceDir,
      seedAgent: cfg.seedAgent,
      openIn: args.openIn,
      existingWorkspaceFile: args.existingWorkspaceFile,
      existingFolder: args.existingFolder,
    });
```

(The `slug`/`planMd`/`result` lines already exist — this replaces the `mode` computation and folds `openIn`/`existing*` into the same `openWorkspace` call. Keep the existing success-toast lines that follow.)

- [ ] **Step 4: Run the full tasksView suite**

Run: `npx vitest run test/unit/tasksView.test.ts`
Expected: PASS — new Explore tests plus all prior tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/tasksView.ts test/unit/tasksView.test.ts
git commit -m "feat: Explore flow honors the same open-where choice as taking a task"
```

---

### Task 7: Document the feature

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the "open where" docs**

Find the paragraph describing `agentFlow.openIn` (around the "pick an existing `.code-workspace`" text) and add, after it:

```markdown
When taking a task (or starting an Explore session) with `agentFlow.openIn` set to
`ask`, Agent Flow also lists the windows you already have open — a repo folder or a
saved workspace — so you can drop the task straight into one of them. Choosing an open
**workspace** window merges the task's repos into it; choosing an open **folder** window
focuses it and seeds the agent there (a folder window can't gain root folders, so any
other repos the task touches keep their briefs but aren't added as roots). Set
`agentFlow.trackOpenWindows` to `false` to turn this off.
```

- [ ] **Step 2: Verify the settings table mentions the new setting**

Ensure the settings section lists `agentFlow.trackOpenWindows` (add a row/line matching the style used for `agentFlow.worktree`, e.g. "Track open windows so a task can open into one you already have open (default `true`).").

- [ ] **Step 3: Full test + typecheck + build**

```bash
npm test && npm run typecheck && npm run build
```
Expected: all suites pass, no type errors, esbuild succeeds.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document opening a task into an already-open window"
```

---

## Self-Review

**1. Spec coverage:**
- Gap #1 (open into a live window): Tasks 2 (registry), 3 (presence lifecycle), 4 (folder-window open path), 5 (picker + workspace-window reuse). ✓
- Gap #3 (Explore parity): Task 6. ✓
- Constraint (no window-enumeration API → own registry): Task 2 pid-liveness, filesystem registry. ✓
- Behavior table (workspace → merge+focus; folder → focus+seed, no root injection; toast un-added repos): Tasks 4 + 5. ✓
- Edge cases: unparseable/dead records pruned (Task 2 tests), tracking-off hides section (Task 5 test), current window excluded (Task 5 test), target folder ≠ selected repo writes a brief (Task 4 test). ✓
- Setting `agentFlow.trackOpenWindows`: Task 1. ✓
- Shared identity helper (no drift with `maybeSeedAgent`): Task 4 Step 3 + Task 2 `windowIdentity` (tested both ways). ✓
- README: Task 7. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows full code; commands have expected output. ✓

**3. Type consistency:** `windowIdentity()` returns `WindowIdentity`; `PresenceRecord extends WindowIdentity`; `readLiveWindows` returns `PresenceRecord[]`; `OpenTarget` live variant is `{ kind: "live-folder"; folder }`; `targetToOpenArgs` returns `{ mode; openIn; existingWorkspaceFile?; existingFolder? }`; `OpenRequest.existingFolder?` and `OpenResult.unaddedRepos?` are consumed exactly as produced. Live **workspace** windows are represented as the existing `{ kind: "existing"; file }` target (no new open code). ✓
