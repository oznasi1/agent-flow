# Open Into Existing Workspace — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third "open target" when taking a task — pick an existing `.code-workspace`, merge in the task's inferred repos non-destructively, open it, and seed the Claude Code agent even when that workspace is already open.

**Architecture:** Two new pure helpers in `engine/workspace.ts` (`listWorkspaceFiles`, `mergeReposIntoWorkspace`) do the file work; `openWorkspace` gains an `existingWorkspaceFile` branch that skips workspace generation and runs the merge; `tasksView.chooseOpenTarget` gains the third quick-pick option plus a workspace picker; and a `fs.watch` on the plan dir (`watchPlansAndSeed`) lets already-open windows seed live. `.code-workspace` files are edited with `jsonc-parser`'s format-preserving `modify`/`applyEdits` so comments and settings survive.

**Tech Stack:** TypeScript, VS Code extension API, `jsonc-parser` (new dep), Vitest with a hand-written `vscode` mock and `vi.mock("fs")`.

## Global Constraints

- **VS Code / Cursor `^1.90.0`** — no newer API.
- **Runtime deps stay minimal.** The only new runtime dependency permitted by the spec is **`jsonc-parser`** (used for safe, format-preserving edits of `.code-workspace` files). Add nothing else.
- **`.code-workspace` files are JSONC** — never `JSON.parse` them; always parse/edit via `jsonc-parser`. On any parse failure, **do not write** the file.
- **Merge is additive and idempotent** — only append missing folders; re-taking a task already in the workspace changes nothing; preserve existing folders, ordering, comments, and `settings`.
- **Platform: darwin** — `fs.watch` on the plan dir is acceptable.
- **Coverage thresholds** (`vitest.config.ts`): statements 90, branches 85, functions 85, lines 90. New code must keep the suite above these.
- **Tests mock `fs` wholesale** (`vi.mock("fs")`) and import the `vscode` mock from `test/_mocks/vscode.ts`. Follow the patterns in `test/unit/engine/workspace.test.ts`.

---

## File Structure

- `package.json` — add `jsonc-parser` dependency; extend the `agentFlow.openIn` enum.
- `src/config.ts` — widen `AgentFlowConfig["openIn"]` with `"pick-existing"`.
- `src/engine/workspace.ts` — add `listWorkspaceFiles`, `mergeReposIntoWorkspace`, `watchPlansAndSeed`; extend `OpenRequest`/`OpenResult`; add the `existingWorkspaceFile` branch to `openWorkspace`.
- `src/extension.ts` — register the plan-dir watcher.
- `src/tasksView.ts` — add the third open target + `pickExistingWorkspace`; thread `existingWorkspaceFile` into `openWorkspace`; toast merge outcome.
- `test/_mocks/vscode.ts` — add `window.showOpenDialog`.
- `README.md` — document the new `openIn` value + the "Existing workspace" flow.
- Tests: `test/unit/engine/workspace.test.ts`, `test/unit/tasksView.test.ts`, `test/unit/extension.test.ts`, `test/unit/config.test.ts`.

---

## Task 1: `jsonc-parser` dependency + `listWorkspaceFiles`

**Files:**
- Modify: `package.json` (dependencies)
- Modify: `src/engine/workspace.ts` (new export + imports)
- Test: `test/unit/engine/workspace.test.ts`

**Interfaces:**
- Produces: `interface WorkspaceListItem { file: string; folders: number; mtimeMs: number }` and `function listWorkspaceFiles(dir: string): WorkspaceListItem[]` (newest first; skips non-`.code-workspace`; tolerant of unreadable/unparseable files).

- [ ] **Step 1: Install the dependency**

Run: `npm install jsonc-parser`
Expected: `jsonc-parser` appears under `dependencies` in `package.json`; install exits 0.

- [ ] **Step 2: Write the failing test**

Add to `test/unit/engine/workspace.test.ts` (it already has `vi.mock("fs")` and the mocked `fs` handles):

```ts
import { listWorkspaceFiles } from "../../../src/engine/workspace";

describe("listWorkspaceFiles", () => {
  it("lists only .code-workspace files, newest first, with folder counts", () => {
    readdirSync.mockReturnValue(["b.code-workspace", "notes.txt", "a.code-workspace"] as never);
    statSync.mockImplementation((p) =>
      ({ isFile: () => true, mtimeMs: String(p).endsWith("a.code-workspace") ? 200 : 100 }) as unknown as fs.Stats,
    );
    readFileSync.mockImplementation((p) =>
      String(p).endsWith("a.code-workspace")
        ? '{ "folders": [{ "path": "x" }] }'
        : '{ /* c */ "folders": [{ "path": "y" }, { "path": "z" }] }',
    );

    const items = listWorkspaceFiles("/ws");

    expect(items.map((i) => i.file.split("/").pop())).toEqual(["a.code-workspace", "b.code-workspace"]);
    expect(items[0].folders).toBe(1);
    expect(items[1].folders).toBe(2);
  });

  it("returns [] when the directory can't be read", () => {
    readdirSync.mockImplementation(() => { throw new Error("ENOENT"); });
    expect(listWorkspaceFiles("/nope")).toEqual([]);
  });

  it("tolerates an unparseable workspace file (folders = 0)", () => {
    readdirSync.mockReturnValue(["broken.code-workspace"] as never);
    statSync.mockReturnValue({ isFile: () => true, mtimeMs: 1 } as unknown as fs.Stats);
    readFileSync.mockReturnValue("{ not json");
    expect(listWorkspaceFiles("/ws")[0].folders).toBe(0);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/unit/engine/workspace.test.ts -t "listWorkspaceFiles"`
Expected: FAIL — `listWorkspaceFiles is not a function`.

- [ ] **Step 4: Implement `listWorkspaceFiles`**

At the top of `src/engine/workspace.ts`, add to the imports:

```ts
import { parse as jsoncParse, modify, applyEdits, type ParseError } from "jsonc-parser";
```

Add near the other exports:

```ts
export interface WorkspaceListItem {
  file: string;
  folders: number;
  mtimeMs: number;
}

/** List `*.code-workspace` files under `dir`, newest first. Best-effort: an
 * unreadable dir yields []; an unparseable file yields a 0 folder count. */
export function listWorkspaceFiles(dir: string): WorkspaceListItem[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const items: WorkspaceListItem[] = [];
  for (const n of names) {
    if (!n.endsWith(".code-workspace")) continue;
    const file = path.join(dir, n);
    let mtimeMs = 0;
    let folders = 0;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      /* keep 0 */
    }
    try {
      const doc = jsoncParse(fs.readFileSync(file, "utf8")) as { folders?: unknown[] } | undefined;
      folders = Array.isArray(doc?.folders) ? doc!.folders.length : 0;
    } catch {
      /* keep 0 */
    }
    items.push({ file, folders, mtimeMs });
  }
  return items.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/unit/engine/workspace.test.ts -t "listWorkspaceFiles"`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add package.json package-lock.json src/engine/workspace.ts test/unit/engine/workspace.test.ts
git commit -m "feat: listWorkspaceFiles + jsonc-parser dependency"
```

---

## Task 2: `mergeReposIntoWorkspace`

**Files:**
- Modify: `src/engine/workspace.ts` (new export)
- Test: `test/unit/engine/workspace.test.ts`

**Interfaces:**
- Consumes: `ServiceRef` (`{ name, path, isGit }` from `../types`); the module-private `canon(p)` helper already defined in `workspace.ts`.
- Produces: `function mergeReposIntoWorkspace(file: string, repos: ServiceRef[]): { added: string[]; ok: boolean }`. `ok:false` means the file was left untouched (unreadable/unparseable); `added` is the repo names appended (empty when all were already present).

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/engine/workspace.test.ts`:

```ts
import { mergeReposIntoWorkspace } from "../../../src/engine/workspace";

describe("mergeReposIntoWorkspace", () => {
  const repos = mkRepos(["account-service", "centaur"]); // paths: /repos/account-service, /repos/centaur

  it("appends only missing repos and preserves comments + settings", () => {
    readFileSync.mockReturnValue(
      '{\n  // my workspace\n  "folders": [{ "name": "centaur", "path": "/repos/centaur" }],\n  "settings": { "editor.tabSize": 2 }\n}\n',
    );
    let written = "";
    writeFileSync.mockImplementation((_p, data) => { written = String(data); });

    const res = mergeReposIntoWorkspace("/ws/ASM-1.code-workspace", repos);

    expect(res).toEqual({ added: ["account-service"], ok: true });
    expect(written).toContain("// my workspace");            // comment preserved
    expect(written).toContain('"editor.tabSize": 2');        // settings preserved
    expect(written).toContain('"path": "/repos/account-service"'); // repo added
    // centaur present exactly once (not duplicated)
    expect(written.match(/\/repos\/centaur/g)?.length).toBe(1);
  });

  it("is idempotent — no write when all repos already present", () => {
    readFileSync.mockReturnValue(
      '{ "folders": [{ "path": "/repos/account-service" }, { "path": "/repos/centaur" }] }',
    );
    const res = mergeReposIntoWorkspace("/ws/ASM-1.code-workspace", repos);
    expect(res).toEqual({ added: [], ok: true });
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("resolves relative existing-folder paths against the workspace dir", () => {
    // workspace lives in /repos, folder path "centaur" → /repos/centaur (already present)
    readFileSync.mockReturnValue('{ "folders": [{ "path": "centaur" }] }');
    writeFileSync.mockImplementation(() => {});
    const res = mergeReposIntoWorkspace("/repos/team.code-workspace", repos);
    expect(res.added).toEqual(["account-service"]); // centaur matched via relative resolution
  });

  it("does NOT write on unparseable input (ok:false)", () => {
    readFileSync.mockReturnValue("{ this is : not json");
    const res = mergeReposIntoWorkspace("/ws/bad.code-workspace", repos);
    expect(res).toEqual({ added: [], ok: false });
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("does NOT write when the file can't be read (ok:false)", () => {
    readFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
    const res = mergeReposIntoWorkspace("/ws/missing.code-workspace", repos);
    expect(res).toEqual({ added: [], ok: false });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/workspace.test.ts -t "mergeReposIntoWorkspace"`
Expected: FAIL — `mergeReposIntoWorkspace is not a function`.

- [ ] **Step 3: Implement `mergeReposIntoWorkspace`**

Add to `src/engine/workspace.ts` (the `canon` and `jsoncParse`/`modify`/`applyEdits`/`ParseError` symbols are already available from earlier):

```ts
/** Additively merge `repos` into an existing `.code-workspace` file, preserving
 * comments/formatting/settings via jsonc-parser. Returns ok:false WITHOUT writing
 * if the file can't be read or safely parsed (caller opens it as-is + warns). */
export function mergeReposIntoWorkspace(
  file: string,
  repos: ServiceRef[],
): { added: string[]; ok: boolean } {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { added: [], ok: false };
  }
  const errors: ParseError[] = [];
  const doc = jsoncParse(text, errors, { allowTrailingComma: true }) as
    | { folders?: { path?: string }[] }
    | undefined;
  if (errors.length || !doc || typeof doc !== "object") return { added: [], ok: false };

  const wsDir = path.dirname(file);
  const present = new Set(
    (Array.isArray(doc.folders) ? doc.folders : [])
      .map((f) => f?.path)
      .filter((p): p is string => typeof p === "string")
      .map((p) => canon(path.resolve(wsDir, p))),
  );
  const missing = repos.filter((r) => !present.has(canon(r.path)));
  if (!missing.length) return { added: [], ok: true };

  const startIdx = Array.isArray(doc.folders) ? doc.folders.length : 0;
  let updated = text;
  missing.forEach((r, i) => {
    const edits = modify(
      updated,
      ["folders", startIdx + i],
      { name: r.name, path: r.path },
      { isArrayInsertion: true, formattingOptions: { insertSpaces: true, tabSize: 2 } },
    );
    updated = applyEdits(updated, edits);
  });
  fs.writeFileSync(file, updated);
  return { added: missing.map((r) => r.name), ok: true };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/workspace.test.ts -t "mergeReposIntoWorkspace"`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add src/engine/workspace.ts test/unit/engine/workspace.test.ts
git commit -m "feat: mergeReposIntoWorkspace — additive, format-preserving"
```

---

## Task 3: `openWorkspace` existing-workspace branch

**Files:**
- Modify: `src/engine/workspace.ts` (`OpenRequest`, `OpenResult`, `openWorkspace`)
- Test: `test/unit/engine/workspace.test.ts`

**Interfaces:**
- Consumes: `mergeReposIntoWorkspace` (Task 2).
- Produces: `OpenRequest` gains `existingWorkspaceFile?: string`. `OpenResult` gains `mergedRepos?: string[]` and `mergeFailed?: boolean`. When `existingWorkspaceFile` is set, `openWorkspace` forces multiroot semantics, does NOT generate a `<KEY>.code-workspace`, merges repos, sets `workspaceFile` + the plan `matchPath` to the picked file, and opens it in a new window.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/engine/workspace.test.ts`:

```ts
describe("openWorkspace — existing workspace", () => {
  it("merges repos into the picked file and does not generate a new one", async () => {
    // Picked workspace already contains centaur; account-service is missing.
    readFileSync.mockImplementation((p) =>
      String(p).endsWith(".code-workspace") ? '{ "folders": [{ "path": "/repos/centaur" }] }' : "",
    );

    const result = await openWorkspace(baseReq({ existingWorkspaceFile: "/ws/team.code-workspace" }));

    expect(result.mode).toBe("multiroot");
    expect(result.workspaceFile).toBe("/ws/team.code-workspace");
    expect(result.mergedRepos).toEqual(["account-service"]);
    expect(result.mergeFailed).toBeUndefined();
    // No generated <KEY>.code-workspace was written.
    expect(writeArg((p) => p.endsWith("ASM-1.code-workspace"))).toBeUndefined();
    // It opened the picked file.
    expect(result.opened).toContain("/ws/team.code-workspace");
  });

  it("reports mergeFailed when the picked file is unparseable and still opens it", async () => {
    readFileSync.mockImplementation((p) =>
      String(p).endsWith(".code-workspace") ? "{ broken" : "",
    );
    const result = await openWorkspace(baseReq({ existingWorkspaceFile: "/ws/bad.code-workspace" }));
    expect(result.mergeFailed).toBe(true);
    expect(result.opened).toContain("/ws/bad.code-workspace");
  });

  it("seeds a plan whose matchPath is the picked workspace", async () => {
    readFileSync.mockImplementation((p) =>
      String(p).endsWith(".code-workspace") ? '{ "folders": [] }' : "",
    );
    await openWorkspace(baseReq({ existingWorkspaceFile: "/ws/team.code-workspace" }));
    const planCall = writeArg((p) => p.includes("/.agentflow/plans/"));
    expect(planCall).toBeDefined();
    expect(String(planCall![1])).toContain('"matchPath": "/ws/team.code-workspace"');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/workspace.test.ts -t "existing workspace"`
Expected: FAIL — `existingWorkspaceFile` is ignored, so a `<KEY>.code-workspace` is generated and `result.mergedRepos` is `undefined`.

- [ ] **Step 3: Extend the interfaces**

In `src/engine/workspace.ts`, add to `OpenRequest`:

```ts
  existingWorkspaceFile?: string; // when set: open the task into this .code-workspace
```

Add to `OpenResult`:

```ts
  mergedRepos?: string[]; // repos appended to an existing workspace
  mergeFailed?: boolean;  // existing workspace could not be parsed; opened as-is
```

- [ ] **Step 4: Add the branch to `openWorkspace`**

In `openWorkspace`, the briefs step (`// 1 — briefs + git-exclude`) is unchanged. Replace the workspace-target step (`// 2 — build the workspace target + the seed matches`) so the existing-file case is handled first. The current block is:

```ts
  // 2 — build the workspace target + the seed matches
  let workspaceFile: string | undefined;
  const matches: PlanFile["matches"] = [];
  if (mode === "multiroot") {
```

Change it to:

```ts
  // 2 — build the workspace target + the seed matches
  let workspaceFile: string | undefined;
  let mergedRepos: string[] | undefined;
  let mergeFailed: boolean | undefined;
  const matches: PlanFile["matches"] = [];
  const effMode: WorkspaceMode = req.existingWorkspaceFile ? "multiroot" : mode;
  if (req.existingWorkspaceFile) {
    const merge = mergeReposIntoWorkspace(req.existingWorkspaceFile, services);
    mergedRepos = merge.added;
    mergeFailed = merge.ok ? undefined : true;
    workspaceFile = req.existingWorkspaceFile;
    const mentions = services.flatMap((s) =>
      (filesByRepo.get(s.name) ?? []).map((f) => mention("multiroot", s.name, f)),
    );
    matches.push({ matchPath: workspaceFile, prompt: agentPrompt(ticket, mentions, promptTemplate) });
  } else if (mode === "multiroot") {
```

Then, in the durable-writes / run-record / open steps below, replace every remaining use of the destructured `mode` with `effMode`, and add the new fields to the return. Concretely:

- The `Run` record's `mode:` becomes `mode: effMode`.
- The open step `if (mode === "multiroot")` becomes `if (effMode === "multiroot")`.
- The final `return` becomes:

```ts
  return { mode: effMode, workspaceFile, briefs, opened, mergedRepos, mergeFailed };
```

(The existing `const newWindow = (req.openIn ?? "new") !== "current";` already yields a new window when `openIn` is unset, which is what the existing-workspace path passes — see Task 6.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/workspace.test.ts -t "existing workspace"`
Expected: PASS (3 tests).

- [ ] **Step 6: Run the whole workspace suite (guard against regressions)**

Run: `npx vitest run test/unit/engine/workspace.test.ts`
Expected: PASS (all, including the pre-existing multiroot/per-window/seed tests).

- [ ] **Step 7: Typecheck + commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add src/engine/workspace.ts test/unit/engine/workspace.test.ts
git commit -m "feat: openWorkspace opens+merges into an existing workspace"
```

---

## Task 4: Plan-dir watcher for live seeding

**Files:**
- Modify: `src/engine/workspace.ts` (new export `watchPlansAndSeed`)
- Modify: `src/extension.ts` (register the watcher)
- Test: `test/unit/engine/workspace.test.ts`, `test/unit/extension.test.ts`

**Interfaces:**
- Consumes: existing `maybeSeedAgent(context, log)`; module-private `PLAN_DIR`.
- Produces: `function watchPlansAndSeed(context: vscode.ExtensionContext, log: (m: string) => void): vscode.Disposable` — debounced `fs.watch` on `PLAN_DIR` that re-runs `maybeSeedAgent` on change; `dispose()` clears the timer and closes the watcher.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/engine/workspace.test.ts` (uses fake timers; mocks `fs.watch`):

```ts
import { watchPlansAndSeed } from "../../../src/engine/workspace";

describe("watchPlansAndSeed", () => {
  it("debounces plan-dir changes and re-runs seeding, and disposes cleanly", () => {
    vi.useFakeTimers();
    const close = vi.fn();
    let fire: (() => void) | undefined;
    vi.mocked(fs.watch).mockImplementation(((_dir: string, cb: () => void) => {
      fire = cb;
      return { close } as unknown as fs.FSWatcher;
    }) as never);
    // Make maybeSeedAgent bail immediately (no single-workspace identity).
    workspace.workspaceFile = undefined;
    workspace.workspaceFolders = undefined;

    const disp = watchPlansAndSeed(fakeContext(), () => {});
    expect(fs.mkdirSync).toHaveBeenCalled();       // ensured PLAN_DIR exists
    fire!(); fire!();                               // two rapid changes
    vi.advanceTimersByTime(300);
    expect(readdirSync).toHaveBeenCalledTimes(1);   // maybeSeedAgent read the plan dir once (debounced)

    disp.dispose();
    expect(close).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
```

Add `const watch = vi.mocked(fs.watch);` alongside the other `fs` handles, and `watch.mockReset();` is not required (each test sets its own impl), but ensure `fs.watch` is mockable — `vi.mock("fs")` already auto-mocks it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/engine/workspace.test.ts -t "watchPlansAndSeed"`
Expected: FAIL — `watchPlansAndSeed is not a function`.

- [ ] **Step 3: Implement `watchPlansAndSeed`**

Add to `src/engine/workspace.ts`:

```ts
/** Watch the plan dir so an ALREADY-OPEN window seeds itself when a matching task
 * is taken (activation-time seeding only covers windows that (re)open). Debounced;
 * dispose() closes the watcher. The per-window `seeded:` guard prevents re-seeding. */
export function watchPlansAndSeed(
  context: vscode.ExtensionContext,
  log: (m: string) => void,
): vscode.Disposable {
  fs.mkdirSync(PLAN_DIR, { recursive: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watcher = fs.watch(PLAN_DIR, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void maybeSeedAgent(context, log), 300);
  });
  log(`watching plan dir ${PLAN_DIR} for live seeding`);
  return {
    dispose: () => {
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/engine/workspace.test.ts -t "watchPlansAndSeed"`
Expected: PASS.

- [ ] **Step 5: Wire it into activation**

In `src/extension.ts`, update the import:

```ts
import { maybeSeedAgent, watchPlansAndSeed } from "./engine/workspace";
```

Replace the final seeding line:

```ts
  // If this window was opened by a recent "take", pre-seed its Claude Code agent.
  void maybeSeedAgent(context, log);
```

with:

```ts
  // If this window was opened by a recent "take", pre-seed its Claude Code agent…
  void maybeSeedAgent(context, log);
  // …and keep watching so an already-open window seeds when a task is taken later.
  context.subscriptions.push(watchPlansAndSeed(context, log));
```

- [ ] **Step 6: Update the activation test**

In `test/unit/extension.test.ts`, add an assertion that activation registers the watcher. Follow the file's existing `vi.mock("../../src/engine/workspace", …)` (add `watchPlansAndSeed: vi.fn(() => ({ dispose: vi.fn() }))` to that mock's factory) and assert it was called once after `activate(context)`:

```ts
import { watchPlansAndSeed } from "../../src/engine/workspace";
// …in the activation test:
expect(watchPlansAndSeed).toHaveBeenCalledTimes(1);
```

If `extension.test.ts` does not already mock `../../src/engine/workspace`, add the mock factory:

```ts
vi.mock("../../src/engine/workspace", () => ({
  maybeSeedAgent: vi.fn(async () => {}),
  watchPlansAndSeed: vi.fn(() => ({ dispose: vi.fn() })),
}));
```

- [ ] **Step 7: Run the extension tests**

Run: `npx vitest run test/unit/extension.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck + commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add src/engine/workspace.ts src/extension.ts test/unit/engine/workspace.test.ts test/unit/extension.test.ts
git commit -m "feat: watch plan dir so already-open windows seed live"
```

---

## Task 5: Config — `pick-existing` open mode

**Files:**
- Modify: `src/config.ts` (`AgentFlowConfig["openIn"]` union)
- Modify: `package.json` (`agentFlow.openIn` enum + enumDescriptions)
- Modify: `README.md` (settings note)
- Test: `test/unit/config.test.ts`

**Interfaces:**
- Produces: `AgentFlowConfig["openIn"]` is `"ask" | "new-window" | "this-window" | "pick-existing"`.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/config.test.ts` (follow its existing `setConfig`/`getConfig` pattern):

```ts
it("passes through openIn: pick-existing", () => {
  setConfig({ "agentFlow.openIn": "pick-existing" });
  expect(getConfig().openIn).toBe("pick-existing");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/config.test.ts -t "pick-existing"`
Expected: FAIL — TypeScript widening aside, this fails only if the value isn't returned; if it already passes at runtime, still complete steps 3-4 for the type + schema. (If it passes, note it and continue — the schema/type changes below are still required.)

- [ ] **Step 3: Widen the type**

In `src/config.ts`, change:

```ts
  openIn: "ask" | "new-window" | "this-window";
```

to:

```ts
  openIn: "ask" | "new-window" | "this-window" | "pick-existing";
```

- [ ] **Step 4: Update the package.json schema**

In `package.json`, find `agentFlow.openIn` and change its `enum` + `enumDescriptions` to include the new value:

```json
"enum": ["ask", "new-window", "this-window", "pick-existing"],
"enumDescriptions": [
  "Ask each time you take a task",
  "Always open a task in a new window",
  "Always open a task in the current window (replaces what's here)",
  "Always pick an existing .code-workspace to open the task into"
],
```

- [ ] **Step 5: Update the README**

In `README.md`, in the paragraph after the settings table that lists `agentFlow.openIn` values, add `pick-existing` and mention the "Existing workspace" flow (repos are merged into the picked workspace non-destructively).

- [ ] **Step 6: Run the config test + typecheck**

Run: `npx vitest run test/unit/config.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts package.json README.md test/unit/config.test.ts
git commit -m "feat: add pick-existing openIn mode + docs"
```

---

## Task 6: tasksView — third open target + workspace picker

**Files:**
- Modify: `src/tasksView.ts` (`chooseOpenTarget`, new `pickExistingWorkspace`, take flow, toast)
- Modify: `test/_mocks/vscode.ts` (add `window.showOpenDialog`)
- Test: `test/unit/tasksView.test.ts`

**Interfaces:**
- Consumes: `listWorkspaceFiles` (Task 1); `openWorkspace` `existingWorkspaceFile` + `OpenResult.mergedRepos`/`mergeFailed` (Task 3).
- Produces: local `type OpenTarget = { kind: "new" } | { kind: "current" } | { kind: "existing"; file: string }`; `chooseOpenTarget(cfg): Promise<OpenTarget | undefined>`.

- [ ] **Step 1: Add `showOpenDialog` to the vscode mock**

In `test/_mocks/vscode.ts`, add to the `window` object:

```ts
  showOpenDialog: vi.fn(async (_opts?: unknown): Promise<any[] | undefined> => undefined),
```

and in `resetVscodeMocks()` add:

```ts
  window.showOpenDialog.mockReset().mockResolvedValue(undefined);
```

- [ ] **Step 2: Write the failing tests**

In `test/unit/tasksView.test.ts`, mock `listWorkspaceFiles` alongside the existing `openWorkspace` mock. Update the workspace mock factory to:

```ts
vi.mock("../../src/engine/workspace", () => ({
  openWorkspace: vi.fn(),
  listWorkspaceFiles: vi.fn(() => []),
}));
```

and import it:

```ts
import { openWorkspace, listWorkspaceFiles } from "../../src/engine/workspace";
import { window } from "../_mocks/vscode";
```

Add tests (drive the take flow the same way the existing "take" tests do; `CFG.openIn` defaults to `"ask"`):

```ts
it("opens into a picked existing workspace", async () => {
  vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask" });
  vi.mocked(listWorkspaceFiles).mockReturnValue([
    { file: "/ws/team.code-workspace", folders: 2, mtimeMs: 1 },
  ]);
  // 1st quick-pick → "Existing workspace…"; 2nd → the team workspace.
  vi.mocked(window.showQuickPick)
    .mockResolvedValueOnce({ val: "existing" } as never)
    .mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never);

  await takeThroughToOpen(); // whatever the file's existing helper is to run a take

  expect(openWorkspace).toHaveBeenCalledWith(
    expect.objectContaining({ existingWorkspaceFile: "/ws/team.code-workspace", mode: "multiroot" }),
  );
});

it("falls back to Browse… when chosen", async () => {
  vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "pick-existing" }); // skips 1st pick
  vi.mocked(listWorkspaceFiles).mockReturnValue([]);
  vi.mocked(window.showQuickPick).mockResolvedValueOnce({ file: "__browse__" } as never);
  vi.mocked(window.showOpenDialog).mockResolvedValueOnce([{ fsPath: "/elsewhere/x.code-workspace" }] as never);

  await takeThroughToOpen();

  expect(openWorkspace).toHaveBeenCalledWith(
    expect.objectContaining({ existingWorkspaceFile: "/elsewhere/x.code-workspace" }),
  );
});

it("aborts the take when the workspace picker is cancelled", async () => {
  vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "pick-existing" });
  vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined as never);
  await takeThroughToOpen();
  expect(openWorkspace).not.toHaveBeenCalled();
});
```

> Match the existing test's mechanism for running a take end-to-end (message dispatch or a helper); `takeThroughToOpen()` above is a stand-in — reuse whatever the current "opens a … workspace" tests use, and keep the `showQuickPick` ordering in mind (worktree/workspaceMode picks may consume calls first depending on `CFG`; the sample `CFG` uses `worktree:"never"` and single/`auto` paths — verify against the file and use `mockResolvedValueOnce` in the right order).

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/unit/tasksView.test.ts -t "existing workspace"`
Expected: FAIL — `chooseOpenTarget` doesn't offer the third option / doesn't return a file.

- [ ] **Step 4: Implement the picker + target union**

In `src/tasksView.ts`, add the import:

```ts
import { openWorkspace, listWorkspaceFiles } from "./engine/workspace";
```

Add the type near the top of the file (below imports):

```ts
type OpenTarget = { kind: "new" } | { kind: "current" } | { kind: "existing"; file: string };
```

Replace `chooseOpenTarget` with:

```ts
  /** Where to open a taken task — new window, this window, or an existing workspace. */
  private async chooseOpenTarget(cfg: AgentFlowConfig): Promise<OpenTarget | undefined> {
    if (cfg.openIn === "new-window") return { kind: "new" };
    if (cfg.openIn === "this-window") return { kind: "current" };
    if (cfg.openIn === "pick-existing") return this.pickExistingWorkspace(cfg);
    const p = await vscode.window.showQuickPick(
      [
        { label: "$(empty-window) New window", detail: "Open the task in a separate window", val: "new" as const },
        { label: "$(window) This window", detail: "Open it in the current window (replaces what's here)", val: "current" as const },
        { label: "$(folder-library) Existing workspace…", detail: "Open the task into a .code-workspace you already have", val: "existing" as const },
      ],
      { title: "Open the task where?", placeHolder: "New window, this window, or an existing workspace", ignoreFocusOut: true },
    );
    if (!p) return undefined;
    if (p.val === "existing") return this.pickExistingWorkspace(cfg);
    return { kind: p.val };
  }

  /** Pick a .code-workspace from workspaceDir (or Browse… for one elsewhere). */
  private async pickExistingWorkspace(cfg: AgentFlowConfig): Promise<OpenTarget | undefined> {
    const BROWSE = "__browse__";
    const files = listWorkspaceFiles(cfg.workspaceDir);
    const items = [
      ...files.map((f) => ({
        label: `$(file-code) ${f.file.split("/").pop()}`,
        detail: `${f.folders} folder${f.folders === 1 ? "" : "s"}`,
        file: f.file,
      })),
      { label: "$(folder-opened) Browse…", detail: "Pick a .code-workspace from anywhere", file: BROWSE },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: "Open into which workspace?",
      placeHolder: files.length ? "Pick a workspace, or Browse…" : "No workspaces found — Browse…",
      ignoreFocusOut: true,
    });
    if (!picked) return undefined;
    if (picked.file !== BROWSE) return { kind: "existing", file: picked.file };
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { "VS Code Workspace": ["code-workspace"] },
      title: "Pick a .code-workspace",
    });
    if (!uris || !uris.length) return undefined;
    return { kind: "existing", file: uris[0].fsPath };
  }
```

- [ ] **Step 5: Thread the target through the take flow**

In the take method, replace the `const openIn = await this.chooseOpenTarget(cfg);` block and the `mode` derivation. The current code is:

```ts
    const openIn = await this.chooseOpenTarget(cfg);
    if (!openIn) return;

    let mode: WorkspaceMode;
    if (openIn === "current") {
      mode = services.length === 1 ? "per-window" : "multiroot";
    } else if (services.length === 1 || cfg.workspaceMode === "per-window") {
```

Change it to:

```ts
    const target = await this.chooseOpenTarget(cfg);
    if (!target) return;

    let mode: WorkspaceMode;
    if (target.kind === "existing") {
      mode = "multiroot";
    } else if (target.kind === "current") {
      mode = services.length === 1 ? "per-window" : "multiroot";
    } else if (services.length === 1 || cfg.workspaceMode === "per-window") {
```

Then update the `openWorkspace` call's `openIn` argument (currently `openIn,`) to:

```ts
      openIn: target.kind === "current" ? "current" : "new",
      existingWorkspaceFile: target.kind === "existing" ? target.file : undefined,
```

- [ ] **Step 6: Reflect merge outcome in the toast**

Replace the success toast block at the end of the take method:

```ts
    const where = result.workspaceFile
      ? `workspace ${result.workspaceFile.split("/").pop()}`
      : `${result.opened.length} window(s)`;
    const seeded = cfg.seedAgent ? " Claude Code pre-seeded — press Enter to start." : "";
    this.toast("success", `Opened ${where} for ${key}. Brief seeded in each repo.${seeded}`);
```

with:

```ts
    const where = result.workspaceFile
      ? `workspace ${result.workspaceFile.split("/").pop()}`
      : `${result.opened.length} window(s)`;
    const seeded = cfg.seedAgent ? " Claude Code pre-seeded — press Enter to start." : "";
    if (result.mergeFailed) {
      this.toast(
        "info",
        `Opened ${where} for ${key}, but its folders couldn't be parsed — repos weren't added. Brief seeded in each repo.${seeded}`,
      );
    } else {
      const added = result.mergedRepos?.length ? ` Added ${result.mergedRepos.join(", ")}.` : "";
      this.toast("success", `Opened ${where} for ${key}. Brief seeded in each repo.${added}${seeded}`);
    }
```

- [ ] **Step 7: Run the tasksView tests**

Run: `npx vitest run test/unit/tasksView.test.ts`
Expected: PASS (new + pre-existing).

- [ ] **Step 8: Typecheck + commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add src/tasksView.ts test/_mocks/vscode.ts test/unit/tasksView.test.ts
git commit -m "feat: offer 'Existing workspace' as a third open target"
```

---

## Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: PASS, all files.

- [ ] **Step 2: Coverage above thresholds**

Run: `npm run test:cov`
Expected: PASS; statements ≥90, branches ≥85, functions ≥85, lines ≥90. If the new branches in `openWorkspace`/`tasksView` dropped a metric, add a focused test (e.g. the "all repos already present → no merge, no added" path through `openWorkspace`) rather than lowering thresholds.

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0.

- [ ] **Step 4: Manual smoke (VS Code Extension Development Host)**

Press **F5**, take a task, choose **Existing workspace…**, pick a `.code-workspace`. Verify: the inferred repos are added to that workspace's `folders` (comments/settings intact), the window opens/focuses, and the Claude Code panel seeds (including when that workspace was already open — the plan-dir watcher path).

- [ ] **Step 5: Final commit (if any docs/cleanup remain)**

```bash
git add -A
git commit -m "chore: verify open-into-existing-workspace end to end"
```

---

## Self-Review

**Spec coverage:**
- Third target listing `.code-workspace` files under `workspaceDir` + Browse — Task 1 (`listWorkspaceFiles`), Task 6 (picker).
- Add missing repos non-destructively (jsonc-parser, comments/settings preserved, idempotent, safety valve) — Task 2.
- Multiroot semantics + plan matchPath on the picked file + Run record — Task 3.
- Plan-dir watcher for already-open windows, single-seed guard, disposed on deactivate — Task 4.
- `agentFlow.openIn: pick-existing` sticky default + schema + README — Task 5.
- `OpenTarget` union, `chooseOpenTarget`, merge-outcome toast — Task 6.
- Tests + coverage + build + manual smoke — throughout + Task 7.

**Placeholder scan:** No TBD/TODO in code steps; every code step shows real code. The one stand-in — `takeThroughToOpen()` in Task 6 — is explicitly flagged as "reuse the file's existing take-driving mechanism," because the exact harness lives in `tasksView.test.ts` and must be matched to its current form (message dispatch + `showQuickPick` ordering) rather than guessed here.

**Type consistency:** `existingWorkspaceFile` (OpenRequest), `mergedRepos`/`mergeFailed` (OpenResult), `WorkspaceListItem`, `mergeReposIntoWorkspace(...) → { added, ok }`, and the `OpenTarget` union are used identically across Tasks 1-6. `effMode` is local to `openWorkspace`. `listWorkspaceFiles` is imported by `tasksView.ts` from `engine/workspace.ts` — same module it's exported from.
