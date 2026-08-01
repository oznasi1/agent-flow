# Never Silently Add Repos To An Existing Workspace — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user's existing `.code-workspace` file is never written without explicit approval, and a repo is never added when the workspace already has a folder by that name.

**Architecture:** Three new pure readers in `src/engine/workspace.ts` (`workspaceFolders`, `planWorkspaceMerge`, `mentionInWorkspace`) do the classifying. `openWorkspace` stops deriving the merge list from `services` and merges only a caller-supplied `foldersToAdd`. `tasksView` owns the QuickPick that fills that list. `batchWorkspace` gets the same treatment.

**Tech Stack:** TypeScript, VS Code extension API, `jsonc-parser` (comment-preserving edits), Vitest with `vi.mock("fs")`.

**Spec:** [`docs/superpowers/specs/2026-08-02-no-repo-adds-to-existing-workspace-design.md`](../specs/2026-08-02-no-repo-adds-to-existing-workspace-design.md)

## Global Constraints

- **Never destructive.** The merge stays additive-or-nothing. No task removes, reorders or rewrites an existing workspace folder.
- **No new configuration key.** The prompt is unconditional when something new would be added.
- **Name dedup is case-insensitive** and compares against **both** a declared folder's `name` field **and** its path's basename.
- **Dedup keys off the bare repo name**, never the folder label. Batch labels are key-qualified (`ASM-1-api`) and must still dedup against a folder called `api`.
- **Dismissing the add-prompt means "leave as-is", not "abort".** Worktrees already exist by then; the precedent is `resolveRemoteControl` in `src/tasksView.ts`.
- **Run the whole suite before each commit:** `npm test`. Baseline on this branch is 62 files / 1618 tests passing.
- Repo style: comments explain *why*, not *what*. Match the surrounding density in `src/engine/workspace.ts`.

---

### Task 1: `workspaceFolders` — one reader for a workspace's declared folders

Today `mergeReposIntoWorkspace` and `workspaceFolderPaths` each parse the file with their own copy of the same logic, and neither exposes folder **names** — which name-dedup needs. This task extracts one reader. No behavior change.

The return type is `WorkspaceFolder[] | undefined`: `undefined` means "couldn't read or parse", `[]` means "a valid file that declares no folders". Task 2 depends on that distinction to report `ok`.

**Files:**
- Modify: `src/engine/workspace.ts` (add `WorkspaceFolder` + `workspaceFolders`; rewrite `workspaceFolderPaths:347-366` to delegate)
- Test: `test/unit/engine/workspace.test.ts` (new `describe` block; the existing `workspaceFolderPaths` block at `:908` must keep passing untouched)

**Interfaces:**
- Consumes: nothing new. Uses the file's existing `canon`, `jsoncParse`, `ParseError` imports.
- Produces: `export interface WorkspaceFolder { name?: string; path: string }` and `export function workspaceFolders(file: string): WorkspaceFolder[] | undefined`. Tasks 2, 3 and 4 all consume both.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/engine/workspace.test.ts`, immediately before the existing `describe("workspaceFolderPaths", …)` block. Also add `workspaceFolders` to the import list on line 4.

```ts
describe("workspaceFolders", () => {
  it("returns each folder's name and canonical path, resolved against the file's dir", () => {
    readFileSync.mockReturnValue(
      '{ "folders": [{ "name": "API", "path": "api" }, { "path": "/repos/centaur" }] }',
    );
    expect(workspaceFolders("/repos/team.code-workspace")).toEqual([
      { name: "API", path: "/repos/api" },
      { path: "/repos/centaur" },
    ]);
  });

  it("skips folders with no string path", () => {
    readFileSync.mockReturnValue('{ "folders": [{ "name": "nameless" }, { "path": "/repos/centaur" }] }');
    expect(workspaceFolders("/ws/t.code-workspace")).toEqual([{ path: "/repos/centaur" }]);
  });

  it("distinguishes a valid empty folders array from a parse failure", () => {
    readFileSync.mockReturnValue('{ "folders": [] }');
    expect(workspaceFolders("/ws/empty.code-workspace")).toEqual([]);
  });

  it("returns undefined when the file is unparseable", () => {
    readFileSync.mockReturnValue("{ this is : not json");
    expect(workspaceFolders("/ws/bad.code-workspace")).toBeUndefined();
  });

  it("returns undefined when the file can't be read", () => {
    readFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
    expect(workspaceFolders("/ws/missing.code-workspace")).toBeUndefined();
  });

  it("returns undefined when folders is the wrong shape", () => {
    readFileSync.mockReturnValue('{ "folders": "nope" }');
    expect(workspaceFolders("/ws/bad-shape.code-workspace")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/workspace.test.ts -t "workspaceFolders"`
Expected: FAIL — `workspaceFolders is not a function` (and a TS error on the import).

- [ ] **Step 3: Implement**

In `src/engine/workspace.ts`, replace the whole existing `workspaceFolderPaths` function (currently `:343-366`, including its doc comment) with:

```ts
/** A folder declared by a `.code-workspace`: its canonical absolute path, and its
 *  `name` field when the file sets one. */
export interface WorkspaceFolder {
  name?: string;
  path: string;
}

/** The folders `file` declares, canonical and resolved against the file's directory.
 *  `undefined` when the file can't be read or safely parsed — deliberately distinct
 *  from `[]` (a valid file declaring no folders), because planWorkspaceMerge has to
 *  tell "nothing can be added safely" from "empty, so add everything".
 *
 *  Single reader for "which folders does this workspace have", so the merge, the plan
 *  and prefillPathsForTarget can't drift apart on the answer. */
export function workspaceFolders(file: string): WorkspaceFolder[] | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const errors: ParseError[] = [];
  const doc = jsoncParse(text, errors, { allowTrailingComma: true }) as
    | { folders?: { name?: string; path?: string }[] }
    | undefined;
  if (errors.length || !doc || typeof doc !== "object" || Array.isArray(doc) || !Array.isArray(doc.folders)) {
    return undefined;
  }
  const wsDir = path.dirname(file);
  return doc.folders
    .filter((f): f is { name?: string; path: string } => typeof f?.path === "string")
    .map((f) => ({
      ...(typeof f.name === "string" ? { name: f.name } : {}),
      path: canon(path.resolve(wsDir, f.path)),
    }));
}

/** Canonical absolute paths of the folders declared in a `.code-workspace` file.
 *  `[]` if the file can't be read or safely parsed. */
export function workspaceFolderPaths(file: string): string[] {
  return workspaceFolders(file) ?? [];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/workspace.test.ts`
Expected: PASS — the new `workspaceFolders` block **and** the pre-existing `workspaceFolderPaths` block (its `[]`-on-failure contract is preserved by the `?? []`).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: 62 files / 1624 tests passing, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add src/engine/workspace.ts test/unit/engine/workspace.test.ts
git commit -m "refactor(workspace): one reader for a workspace's declared folders

Name-based dedup needs each folder's name, not just its path, and both
mergeReposIntoWorkspace and workspaceFolderPaths carried their own copy of
the parse. Extract workspaceFolders and derive the paths reader from it.

It returns undefined rather than [] on a parse failure so the caller can
tell 'nothing can be added safely' from 'empty, add everything'."
```

---

### Task 2: `planWorkspaceMerge` — classify candidates against the workspace

The classifier that implements the dedup rule. Pure and read-only; it never writes.

**Files:**
- Modify: `src/engine/workspace.ts` (add after `workspaceFolders` from Task 1; **also amend `workspaceFolders`' shape guard** — see Step 0)
- Test: `test/unit/engine/workspace.test.ts`

**Step 0 — first, fix a guard Task 1 inherited from an under-specified brief.**

Task 1 shipped `if (errors.length || … || !Array.isArray(doc.folders)) return undefined;`, which returns `undefined` for a `.code-workspace` whose `folders` key is **absent**. That file is perfectly parseable, and `mergeReposIntoWorkspace:304-312` has always treated it as fine (`doc.folders !== undefined && !Array.isArray(doc.folders)`). Left as-is, `planWorkspaceMerge` would report `ok:false` for it → no prompt and nothing added, contradicting this plan's own empty-folders behavior ("every candidate is `new` and the prompt lists them all").

Reserve `undefined` for "cannot be read or safely parsed". In `src/engine/workspace.ts`, change `workspaceFolders`' guard to match the merge's, and default the list:

```ts
  if (
    errors.length ||
    !doc ||
    typeof doc !== "object" ||
    Array.isArray(doc) ||
    (doc.folders !== undefined && !Array.isArray(doc.folders))
  ) {
    return undefined;
  }
  const wsDir = path.dirname(file);
  return (doc.folders ?? [])
    .filter(/* …unchanged from Task 1… */)
```

Task 1's existing tests all still hold: `'{ "folders": "nope" }'` is present-but-not-an-array, so it still returns `undefined`. `workspaceFolderPaths`' `[]`-on-failure contract is unaffected either way, so the pre-existing `nofolders.code-workspace` test keeps passing.

Lock the new case in with one test added to Task 1's existing `describe("workspaceFolders", …)` block:

```ts
  it("treats an absent folders key as an empty workspace, not a parse failure", () => {
    readFileSync.mockReturnValue('{ "settings": {} }');
    expect(workspaceFolders("/ws/nofolders.code-workspace")).toEqual([]);
  });
```

plus the `planWorkspaceMerge` counterpart in Step 1 below.

**Interfaces:**
- Consumes: `workspaceFolders(file): WorkspaceFolder[] | undefined` (Task 1).
- Produces:
  ```ts
  export interface MergeCandidate { label: string; repoName: string; path: string }
  export interface WorkspaceMergePlan {
    add: MergeCandidate[]; duplicates: MergeCandidate[]; present: MergeCandidate[]; ok: boolean;
  }
  export function planWorkspaceMerge(file: string, candidates: MergeCandidate[]): WorkspaceMergePlan
  ```
  Tasks 5 and 6 call `planWorkspaceMerge` and read `.add`, `.duplicates` and `.ok`.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/engine/workspace.test.ts` after the `workspaceFolders` block. Add `planWorkspaceMerge` and `type MergeCandidate` to the line-4 import.

```ts
describe("planWorkspaceMerge", () => {
  const cand = (repoName: string, p: string, label = repoName): MergeCandidate => ({
    label,
    repoName,
    path: p,
  });

  it("buckets an already-declared path as present", () => {
    readFileSync.mockReturnValue('{ "folders": [{ "path": "/repos/centaur" }] }');
    const plan = planWorkspaceMerge("/ws/t.code-workspace", [cand("centaur", "/repos/centaur")]);
    expect(plan.present.map((c) => c.repoName)).toEqual(["centaur"]);
    expect(plan.add).toEqual([]);
    expect(plan.duplicates).toEqual([]);
    expect(plan.ok).toBe(true);
  });

  it("buckets a worktree of an already-declared repo as a duplicate, not an addition", () => {
    // The core case: same repo NAME, different path. A second root called `centaur`
    // is indistinguishable in the explorer and makes @centaur/… ambiguous.
    readFileSync.mockReturnValue('{ "folders": [{ "path": "/repos/centaur" }] }');
    const plan = planWorkspaceMerge("/ws/t.code-workspace", [
      cand("centaur", "/repos/centaur/.claude/worktrees/ASM-1"),
    ]);
    expect(plan.duplicates.map((c) => c.repoName)).toEqual(["centaur"]);
    expect(plan.add).toEqual([]);
  });

  it("buckets a repo the workspace has by neither path nor name as an addition", () => {
    readFileSync.mockReturnValue('{ "folders": [{ "path": "/repos/centaur" }] }');
    const plan = planWorkspaceMerge("/ws/t.code-workspace", [cand("infra", "/repos/infra")]);
    expect(plan.add.map((c) => c.repoName)).toEqual(["infra"]);
    expect(plan.duplicates).toEqual([]);
  });

  it("dedups against a folder's custom name field", () => {
    readFileSync.mockReturnValue('{ "folders": [{ "name": "centaur", "path": "/elsewhere/c" }] }');
    const plan = planWorkspaceMerge("/ws/t.code-workspace", [cand("centaur", "/repos/centaur")]);
    expect(plan.duplicates.map((c) => c.repoName)).toEqual(["centaur"]);
  });

  it("dedups against a folder's path basename even when a custom name differs", () => {
    // servicesFromExistingDestination derives an unmatched folder's service name from
    // the BASENAME, so comparing only the `name` field would let a custom name defeat
    // the rule against the service derived from that very folder.
    readFileSync.mockReturnValue('{ "folders": [{ "name": "Custom Label", "path": "/repos/centaur" }] }');
    const plan = planWorkspaceMerge("/ws/t.code-workspace", [
      cand("centaur", "/repos/centaur/.claude/worktrees/ASM-1"),
    ]);
    expect(plan.duplicates.map((c) => c.repoName)).toEqual(["centaur"]);
  });

  it("compares names case-insensitively", () => {
    readFileSync.mockReturnValue('{ "folders": [{ "name": "API", "path": "/elsewhere/a" }] }');
    const plan = planWorkspaceMerge("/ws/t.code-workspace", [cand("api", "/repos/api")]);
    expect(plan.duplicates.map((c) => c.repoName)).toEqual(["api"]);
  });

  it("dedups a key-qualified batch label against the bare repo name", () => {
    // The label written into the file is ASM-1-api, but dedup must compare `api`.
    readFileSync.mockReturnValue('{ "folders": [{ "path": "/repos/api" }] }');
    const plan = planWorkspaceMerge("/ws/t.code-workspace", [
      cand("api", "/repos/api/.claude/worktrees/ASM-1", "ASM-1-api"),
    ]);
    expect(plan.duplicates.map((c) => c.label)).toEqual(["ASM-1-api"]);
    expect(plan.add).toEqual([]);
  });

  it("offers everything when the workspace declares no folders", () => {
    readFileSync.mockReturnValue('{ "folders": [] }');
    const plan = planWorkspaceMerge("/ws/empty.code-workspace", [
      cand("api", "/repos/api"),
      cand("centaur", "/repos/centaur"),
    ]);
    expect(plan.add.map((c) => c.repoName)).toEqual(["api", "centaur"]);
    expect(plan.ok).toBe(true);
  });

  it("offers everything when the folders key is absent entirely", () => {
    // A parseable file with no folders key is not a failure — mergeReposIntoWorkspace
    // has always accepted it. ok:false here would mean no prompt and no add at all.
    readFileSync.mockReturnValue('{ "settings": {} }');
    const plan = planWorkspaceMerge("/ws/nofolders.code-workspace", [cand("api", "/repos/api")]);
    expect(plan.add.map((c) => c.repoName)).toEqual(["api"]);
    expect(plan.ok).toBe(true);
  });

  it("reports ok:false with empty buckets when the file is unparseable", () => {
    readFileSync.mockReturnValue("{ broken");
    const plan = planWorkspaceMerge("/ws/bad.code-workspace", [cand("api", "/repos/api")]);
    expect(plan).toEqual({ add: [], duplicates: [], present: [], ok: false });
  });

  it("never writes", () => {
    readFileSync.mockReturnValue('{ "folders": [] }');
    planWorkspaceMerge("/ws/t.code-workspace", [cand("api", "/repos/api")]);
    expect(writeFileSync).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/workspace.test.ts -t "planWorkspaceMerge"`
Expected: FAIL — `planWorkspaceMerge is not a function`.

- [ ] **Step 3: Implement**

In `src/engine/workspace.ts`, add immediately after `workspaceFolderPaths`:

```ts
/** A folder that might be added to an existing workspace. `label` is the folder name
 *  written into the file; `repoName` is the bare repo name dedup compares on — batch
 *  labels are key-qualified (`ASM-1-api`) but must still dedup against a folder the
 *  workspace already calls `api`. */
export interface MergeCandidate {
  label: string;
  repoName: string;
  path: string;
}

export interface WorkspaceMergePlan {
  /** In the workspace by neither path nor name — safe to offer. */
  add: MergeCandidate[];
  /** A folder with this repo's name already exists at a DIFFERENT path. Skipped without
   *  asking: two roots by one name are indistinguishable in the explorer and make
   *  `@name/…` ambiguous, which is the harm this whole change exists to prevent. */
  duplicates: MergeCandidate[];
  /** Already a declared folder by canonical path — nothing to do, nothing to report. */
  present: MergeCandidate[];
  /** false when the file can't be read or safely parsed; every bucket is empty. */
  ok: boolean;
}

/** Classify `candidates` against the folders `file` already declares. Read-only.
 *
 *  Name comparison is case-insensitive and covers BOTH a folder's `name` field and its
 *  path's basename: servicesFromExistingDestination derives an unmatched folder's
 *  service name from the basename, so comparing only `name` would let a custom `name`
 *  field defeat the rule against the service derived from that very folder. */
export function planWorkspaceMerge(file: string, candidates: MergeCandidate[]): WorkspaceMergePlan {
  const folders = workspaceFolders(file);
  if (!folders) return { add: [], duplicates: [], present: [], ok: false };

  const paths = new Set(folders.map((f) => f.path));
  const names = new Set(
    folders
      .flatMap((f) => [f.name, path.basename(f.path)])
      .filter((n): n is string => !!n)
      .map((n) => n.toLowerCase()),
  );

  const plan: WorkspaceMergePlan = { add: [], duplicates: [], present: [], ok: true };
  for (const c of candidates) {
    if (paths.has(canon(c.path))) plan.present.push(c);
    else if (names.has(c.repoName.toLowerCase())) plan.duplicates.push(c);
    else plan.add.push(c);
  }
  return plan;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/workspace.test.ts -t "planWorkspaceMerge"`
Expected: PASS (11 tests).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: 0 failures.

- [ ] **Step 6: Commit**

```bash
git add src/engine/workspace.ts test/unit/engine/workspace.test.ts
git commit -m "feat(workspace): classify merge candidates by repo name, not path

A worktree lives at <repo>/.claude/worktrees/<KEY> and keeps the bare repo
name, so path-based dedup sees it as new and appends a SECOND root also
called 'api' — nested inside the first, and another on the next take.

planWorkspaceMerge buckets candidates present / duplicate / new, deduping on
the repo name against both a folder's name field and its path basename."
```

---

### Task 3: `mentionInWorkspace` — resolve `@mentions` against real roots

`mention()` emits `@api/src/foo.ts` for every repo in multiroot mode. Once worktrees stop being added as roots, that form resolves against whatever root *is* called `api` — the **main checkout** — silently pointing the agent at the wrong tree and defeating the worktree isolation the user asked for.

A worktree lives *inside* its repo, so when the main checkout is a root the correct mention exists and is precise: `@api/.claude/worktrees/ASM-1/src/foo.ts`.

**Files:**
- Modify: `src/engine/workspace.ts` (add after `planWorkspaceMerge`)
- Test: `test/unit/engine/workspace.test.ts`

**Interfaces:**
- Consumes: `WorkspaceFolder` (Task 1); the existing `mention` import from `./files`.
- Produces: `export function mentionInWorkspace(roots: WorkspaceFolder[], repoPath: string, rel: string): string | undefined`. Tasks 4 and 6 consume it.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/engine/workspace.test.ts`. Add `mentionInWorkspace` to the line-4 import.

```ts
describe("mentionInWorkspace", () => {
  it("uses the root's own name when the repo IS a root", () => {
    const roots = [{ path: "/repos/centaur" }];
    expect(mentionInWorkspace(roots, "/repos/centaur", "src/x.ts")).toBe("@centaur/src/x.ts");
  });

  it("prefers a root's custom name field over its basename", () => {
    const roots = [{ name: "Centaur Service", path: "/repos/centaur" }];
    expect(mentionInWorkspace(roots, "/repos/centaur", "src/x.ts")).toBe("@Centaur Service/src/x.ts");
  });

  it("routes a worktree through its containing root", () => {
    // The whole point: the worktree is not a root, but it IS inside one, so the
    // mention can name it precisely instead of resolving to the main checkout.
    const roots = [{ path: "/repos/centaur" }];
    expect(mentionInWorkspace(roots, "/repos/centaur/.claude/worktrees/ASM-1", "src/x.ts")).toBe(
      "@centaur/.claude/worktrees/ASM-1/src/x.ts",
    );
  });

  it("picks the deepest containing root, matching VS Code's most-specific resolution", () => {
    const roots = [{ path: "/repos" }, { path: "/repos/centaur" }];
    expect(mentionInWorkspace(roots, "/repos/centaur/.claude/worktrees/ASM-1", "src/x.ts")).toBe(
      "@centaur/.claude/worktrees/ASM-1/src/x.ts",
    );
  });

  it("returns undefined when the repo is inside no root", () => {
    // Emitting @centaur/src/x.ts here would point the agent at a DIFFERENT checkout.
    const roots = [{ path: "/repos/centaur" }];
    expect(mentionInWorkspace(roots, "/repos/infra", "src/x.ts")).toBeUndefined();
  });

  it("returns undefined when there are no roots at all", () => {
    expect(mentionInWorkspace([], "/repos/centaur", "src/x.ts")).toBeUndefined();
  });

  it("does not treat a sibling with a shared prefix as containment", () => {
    const roots = [{ path: "/repos/api" }];
    expect(mentionInWorkspace(roots, "/repos/api-gateway", "src/x.ts")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/workspace.test.ts -t "mentionInWorkspace"`
Expected: FAIL — `mentionInWorkspace is not a function`.

- [ ] **Step 3: Implement**

In `src/engine/workspace.ts`, add after `planWorkspaceMerge`:

```ts
/** The `@mention` for `rel` (relative to the repo at `repoPath`) in a window whose roots
 *  are `roots`. The repo is a root → `@<root>/<rel>`. The repo is INSIDE a root →
 *  `@<root>/<repo's path from that root>/<rel>`, which is the worktree case, since
 *  worktrees live at `<repo>/.claude/worktrees/<KEY>`. Inside no root → undefined, and
 *  the caller drops the mention: `@centaur/src/x.ts` when the root named `centaur` is
 *  the MAIN checkout would send the agent to the wrong tree. */
export function mentionInWorkspace(
  roots: WorkspaceFolder[],
  repoPath: string,
  rel: string,
): string | undefined {
  const target = canon(repoPath);
  // Deepest root wins, matching VS Code's most-specific-root resolution. The `+ sep`
  // guard keeps /repos/api from swallowing the sibling /repos/api-gateway.
  const root = roots
    .filter((r) => r.path === target || target.startsWith(r.path + path.sep))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (!root) return undefined;
  const inner = path.relative(root.path, target);
  return mention("multiroot", root.name ?? path.basename(root.path), inner ? `${inner}/${rel}` : rel);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/workspace.test.ts -t "mentionInWorkspace"`
Expected: PASS (7 tests).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: 0 failures.

- [ ] **Step 6: Commit**

```bash
git add src/engine/workspace.ts test/unit/engine/workspace.test.ts
git commit -m "feat(workspace): resolve @mentions against the window's real roots

mention() emits @api/rel for every repo in multiroot mode. Once worktrees
stop being added as roots, that form resolves to whatever root IS called
'api' — the main checkout — silently editing the wrong tree.

A worktree is inside its repo, so when the checkout is a root the precise
mention exists: @api/.claude/worktrees/ASM-1/rel. Inside no root, return
undefined so the caller drops the mention rather than emit a wrong one."
```

---

### Task 4: `openWorkspace` merges only what the caller approved

The behavioral core in the engine. `openWorkspace` stops deriving the merge list from `services`; it merges exactly `req.foldersToAdd`, so an absent or empty list leaves the file byte-identical.

Two existing tests in `describe("openWorkspace — existing workspace")` assert the old derive-from-`services` behavior and **must be updated** — that is the change, not a regression.

**Files:**
- Modify: `src/engine/workspace.ts` (`OpenRequest:36-50`; `mergeReposIntoWorkspace:290-293` signature; the `req.existingWorkspaceFile` branch at `:200-208`)
- Test: `test/unit/engine/workspace.test.ts` (update `:757-794`; add new cases)

**Interfaces:**
- Consumes: `planWorkspaceMerge` is *not* used here — the decision arrives pre-made. Uses `workspaceFolders` (Task 1) and `mentionInWorkspace` (Task 3).
- Produces: `OpenRequest.foldersToAdd?: { name: string; path: string }[]`. Task 5 sets it; Task 6 adds the same field to `SharedOpenRequest`.

- [ ] **Step 1: Write the failing tests**

First **update** the two existing tests in `describe("openWorkspace — existing workspace")` (`test/unit/engine/workspace.test.ts:758` and `:776`). Replace the first one entirely:

```ts
  it("merges exactly foldersToAdd — never anything derived from services", async () => {
    // services names two repos; only the approved one may reach the file.
    readFileSync.mockImplementation((p) =>
      String(p).endsWith(".code-workspace") ? '{ "folders": [{ "path": "/repos/centaur" }] }' : "",
    );

    const result = await openWorkspace(
      baseReq({
        existingWorkspaceFile: "/ws/team.code-workspace",
        foldersToAdd: [{ name: "account-service", path: "/repos/account-service" }],
      }),
    );

    expect(result.mode).toBe("multiroot");
    expect(result.workspaceFile).toBe("/ws/team.code-workspace");
    expect(result.mergedRepos).toEqual(["account-service"]);
    expect(result.mergeFailed).toBeUndefined();
    expect(writeArg((p) => p.endsWith("ASM-1.code-workspace"))).toBeUndefined();
    expect(result.opened).toContain("/ws/team.code-workspace");
  });
```

Then add these new tests inside the same `describe` block:

```ts
  it("leaves the file untouched when foldersToAdd is absent", async () => {
    // The user's workspace is their artifact: no approval, no write.
    readFileSync.mockImplementation((p) =>
      String(p).endsWith(".code-workspace") ? '{ "folders": [{ "path": "/repos/centaur" }] }' : "",
    );

    const result = await openWorkspace(baseReq({ existingWorkspaceFile: "/ws/team.code-workspace" }));

    expect(writeArg((p) => p.endsWith(".code-workspace"))).toBeUndefined();
    expect(result.mergedRepos).toEqual([]);
    expect(result.mergeFailed).toBeUndefined();
    expect(result.opened).toContain("/ws/team.code-workspace");
  });

  it("leaves the file untouched when foldersToAdd is empty", async () => {
    readFileSync.mockImplementation((p) =>
      String(p).endsWith(".code-workspace") ? '{ "folders": [{ "path": "/repos/centaur" }] }' : "",
    );
    await openWorkspace(baseReq({ existingWorkspaceFile: "/ws/team.code-workspace", foldersToAdd: [] }));
    expect(writeArg((p) => p.endsWith(".code-workspace"))).toBeUndefined();
  });

  it("routes a worktree's mentions through its containing root", async () => {
    execSync.mockReturnValue("src/export.py\n"); // git ls-files
    readFileSync.mockImplementation((p) =>
      String(p).endsWith(".code-workspace") ? '{ "folders": [{ "path": "/repos/centaur" }] }' : "",
    );

    await openWorkspace(
      baseReq({
        services: [{ name: "centaur", path: "/repos/centaur/.claude/worktrees/ASM-1", isGit: true }],
        descriptionText: "fix `src/export.py`",
        existingWorkspaceFile: "/ws/team.code-workspace",
      }),
    );

    const planWrite = writeArg((p) => p.includes("/.agentflow/plans/"));
    const plan = JSON.parse(String(planWrite![1]));
    expect(plan.matches[0].prompt).toContain("@centaur/.claude/worktrees/ASM-1/src/export.py");
  });

  it("drops mentions for a repo that is inside no root", async () => {
    execSync.mockReturnValue("src/export.py\n");
    readFileSync.mockImplementation((p) =>
      String(p).endsWith(".code-workspace") ? '{ "folders": [{ "path": "/repos/centaur" }] }' : "",
    );

    await openWorkspace(
      baseReq({
        services: mkRepos(["infra"]),
        descriptionText: "fix `src/export.py`",
        existingWorkspaceFile: "/ws/team.code-workspace",
      }),
    );

    const plan = JSON.parse(String(writeArg((p) => p.includes("/.agentflow/plans/"))![1]));
    expect(plan.matches[0].prompt).not.toContain("Relevant files:");
    expect(plan.matches[0].prompt).not.toContain("@infra");
  });

  it("uses an absolute {brief} path, which a non-root repo's relative form can't provide", async () => {
    readFileSync.mockImplementation((p) =>
      String(p).endsWith(".code-workspace") ? '{ "folders": [] }' : "",
    );

    await openWorkspace(
      baseReq({
        services: mkRepos(["centaur"]),
        promptTemplate: "brief at {brief}",
        existingWorkspaceFile: "/ws/team.code-workspace",
      }),
    );

    const plan = JSON.parse(String(writeArg((p) => p.includes("/.agentflow/plans/"))![1]));
    expect(plan.matches[0].prompt).toBe("brief at /repos/centaur/.pick-task/TASK.md");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/workspace.test.ts -t "existing workspace"`
Expected: FAIL — TS rejects `foldersToAdd` (not on `OpenRequest`); the untouched-file tests fail because the merge still derives from `services`.

- [ ] **Step 3: Implement**

**3a.** In `src/engine/workspace.ts`, add to `OpenRequest` (after `existingWorkspaceFile` on line 46):

```ts
  /** Folders the user approved adding to `existingWorkspaceFile` — the ONLY thing
   *  merged. Absent or empty leaves that file byte-identical. Never derived from
   *  `services`: a saved workspace is the user's own artifact, and a taken ticket is
   *  not consent to rewrite it. */
  foldersToAdd?: { name: string; path: string }[];
```

**3b.** Widen `mergeReposIntoWorkspace`'s parameter (line 290-293). `ServiceRef` is structurally assignable to the new type, so both existing call sites compile unchanged:

```ts
export function mergeReposIntoWorkspace(
  file: string,
  repos: { name: string; path: string }[],
): { added: string[]; ok: boolean } {
```

**3c.** Replace the `req.existingWorkspaceFile` branch (lines 200-208) with:

```ts
  if (req.existingWorkspaceFile) {
    // Only the approved folders. An empty list still calls through, so an unparseable
    // file is still reported as mergeFailed — it changes the mention mode below.
    const merge = mergeReposIntoWorkspace(req.existingWorkspaceFile, req.foldersToAdd ?? []);
    mergedRepos = merge.added;
    mergeFailed = merge.ok ? undefined : true;
    workspaceFile = req.existingWorkspaceFile;
    // Roots read AFTER the merge: a repo that is not a root of this window has no valid
    // `@name/rel` form, and emitting one anyway resolves against a different checkout.
    const roots = workspaceFolders(workspaceFile) ?? [];
    const mentions = services.flatMap((s) =>
      (filesByRepo.get(s.name) ?? [])
        .map((f) => mentionInWorkspace(roots, s.path, f))
        .filter((m): m is string => !!m),
    );
    // Absolute: {brief}'s default relative form names nothing when the repo isn't a root
    // of the window (batchWorkspace does the same, for the same reason).
    matches.push({
      matchPath: workspaceFile,
      prompt: agentPrompt(ticket, mentions, promptTemplate, briefs[0]?.path),
    });
  } else if (req.existingFolder) {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/workspace.test.ts`
Expected: PASS, including the pre-existing `mergeFailed` and `matchPath` tests at `:776` and `:785`.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: `test/unit/tasksView.test.ts` still passes (it mocks `openWorkspace`, so the new field is inert there). 0 failures.

- [ ] **Step 6: Commit**

```bash
git add src/engine/workspace.ts test/unit/engine/workspace.test.ts
git commit -m "feat(workspace): merge only the folders the caller approved

openWorkspace derived the merge list from \`services\`, so taking a ticket
into a saved .code-workspace rewrote it every time. It now merges exactly
req.foldersToAdd; absent or empty leaves the file byte-identical.

Not adding roots breaks two things that relied on the merge, both fixed
here: @mentions now resolve against the window's real roots, and {brief}
becomes absolute since a non-root repo has no valid relative form."
```

---

### Task 5: The approval prompt in `tasksView.launch()`

Wires the classifier to a QuickPick and reports duplicates in the toast.

**Files:**
- Modify: `src/tasksView.ts` (import `planWorkspaceMerge` + `MergeCandidate`; add `resolveWorkspaceAdditions`; call it in `launch():993-1012`; extend the success toast at `:1024-1029`)
- Test: `test/unit/tasksView.test.ts` (extend the `vi.mock` factory on line 13; add cases to `describe("existing workspace open target")` at `:1157`)

**Interfaces:**
- Consumes: `planWorkspaceMerge(file, candidates)` and `MergeCandidate` (Task 2); `OpenRequest.foldersToAdd` (Task 4).
- Produces: `private async resolveWorkspaceAdditions(file: string, candidates: MergeCandidate[]): Promise<{ foldersToAdd: { name: string; path: string }[]; skipped: string[] }>`. Task 6 reuses it for batch.

- [ ] **Step 1: Write the failing tests**

**1a.** Extend the mock factory on `test/unit/tasksView.test.ts:13` — without this, every test in the file throws once `tasksView` imports `planWorkspaceMerge`:

```ts
vi.mock("../../src/engine/workspace", () => ({
  openWorkspace: vi.fn(),
  listWorkspaceFiles: vi.fn(() => []),
  workspaceFolderPaths: vi.fn(() => []),
  planWorkspaceMerge: vi.fn(() => ({ add: [], duplicates: [], present: [], ok: true })),
}));
```

Add `planWorkspaceMerge` to the import on line 64.

**1b.** Add these tests inside `describe("existing workspace open target", …)`:

```ts
    /** Drive the destination straight to a picked existing workspace. */
    const pickExisting = () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "pick-existing" });
      vi.mocked(listWorkspaceFiles).mockReturnValue([
        { file: "/ws/team.code-workspace", folders: 2, mtimeMs: 1 },
      ]);
    };

    it("does not prompt, and adds nothing, when every repo name is already a folder", async () => {
      pickExisting();
      vi.mocked(planWorkspaceMerge).mockReturnValue({
        add: [],
        duplicates: [{ label: "account-service", repoName: "account-service", path: "/repos/account-service/.claude/worktrees/ASM-1" }],
        present: [],
        ok: true,
      });
      vi.mocked(window.showQuickPick).mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never);

      const { provider } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]);

      // Exactly one quick-pick fired: the workspace-file picker. No add-prompt.
      expect(window.showQuickPick).toHaveBeenCalledTimes(1);
      expect(openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ foldersToAdd: [] }));
    });

    it("adds the approved folders when the user accepts the prompt", async () => {
      pickExisting();
      vi.mocked(planWorkspaceMerge).mockReturnValue({
        add: [{ label: "infra", repoName: "infra", path: "/repos/infra" }],
        duplicates: [],
        present: [],
        ok: true,
      });
      vi.mocked(window.showQuickPick)
        .mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never)
        .mockResolvedValueOnce({ yes: true } as never);

      const { provider } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]);

      expect(openWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ foldersToAdd: [{ name: "infra", path: "/repos/infra" }] }),
      );
    });

    it("adds nothing but still launches when the user declines the prompt", async () => {
      pickExisting();
      vi.mocked(planWorkspaceMerge).mockReturnValue({
        add: [{ label: "infra", repoName: "infra", path: "/repos/infra" }],
        duplicates: [],
        present: [],
        ok: true,
      });
      vi.mocked(window.showQuickPick)
        .mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never)
        .mockResolvedValueOnce({ yes: false } as never);

      const { provider } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]);

      expect(openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ foldersToAdd: [] }));
    });

    it("treats a dismissed prompt as 'leave as-is', not as an abort", async () => {
      // The worktrees already exist by now — abandoning the launch is the worse failure.
      pickExisting();
      vi.mocked(planWorkspaceMerge).mockReturnValue({
        add: [{ label: "infra", repoName: "infra", path: "/repos/infra" }],
        duplicates: [],
        present: [],
        ok: true,
      });
      vi.mocked(window.showQuickPick)
        .mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never)
        .mockResolvedValueOnce(undefined as never);

      const { provider } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]);

      expect(openWorkspace).toHaveBeenCalled();
      expect(openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ foldersToAdd: [] }));
    });

    it("does not prompt when the workspace file can't be parsed", async () => {
      pickExisting();
      vi.mocked(planWorkspaceMerge).mockReturnValue({ add: [], duplicates: [], present: [], ok: false });
      vi.mocked(window.showQuickPick).mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never);

      const { provider } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]);

      expect(window.showQuickPick).toHaveBeenCalledTimes(1);
      expect(openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ foldersToAdd: [] }));
    });

    it("names skipped duplicates in the success toast", async () => {
      pickExisting();
      vi.mocked(planWorkspaceMerge).mockReturnValue({
        add: [],
        duplicates: [{ label: "account-service", repoName: "account-service", path: "/repos/account-service/.claude/worktrees/ASM-1" }],
        present: [],
        ok: true,
      });
      vi.mocked(window.showQuickPick).mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never);
      vi.mocked(openWorkspace).mockResolvedValue({
        mode: "multiroot",
        workspaceFile: "/ws/team.code-workspace",
        briefs: [],
        opened: ["/ws/team.code-workspace"],
        remoteControl: false,
      });

      const { provider, posted } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]);

      const toast = posted().find((m) => m.type === "toast") as { level: string; message: string };
      expect(toast.level).toBe("success");
      expect(toast.message).toContain("account-service");
      expect(toast.message).toMatch(/already in the workspace/i);
    });

    it("passes no foldersToAdd for a new-window destination", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "new-window" });
      const { provider } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]);
      expect(planWorkspaceMerge).not.toHaveBeenCalled();
      expect(openWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ existingWorkspaceFile: undefined, foldersToAdd: [] }),
      );
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/tasksView.test.ts -t "existing workspace open target"`
Expected: FAIL — `openWorkspace` receives no `foldersToAdd`, and the add-prompt never fires.

- [ ] **Step 3: Implement**

**3a.** In `src/tasksView.ts`, extend the workspace import on line 21:

```ts
import { openWorkspace, listWorkspaceFiles, workspaceFolderPaths, planWorkspaceMerge, type MergeCandidate } from "./engine/workspace";
```

**3b.** Add this method immediately after `resolveRemoteControl` (which ends at `:928`):

```ts
  /** Which folders (if any) the user wants added to an existing-workspace destination.
   *  Duplicates are skipped without asking — a folder by that name is already there, so
   *  there is no real question, only noise. Only genuinely new repos prompt.
   *
   *  Never returns undefined: dismissing the prompt means "leave the workspace as-is",
   *  not "abort". By the time this runs the worktrees exist and the launch is committed,
   *  so abandoning it over a folder-list question is the worse failure — the same
   *  reasoning resolveRemoteControl documents. */
  private async resolveWorkspaceAdditions(
    file: string,
    candidates: MergeCandidate[],
  ): Promise<{ foldersToAdd: { name: string; path: string }[]; skipped: string[] }> {
    const plan = planWorkspaceMerge(file, candidates);
    const skipped = plan.duplicates.map((c) => c.repoName);
    // ok:false → nothing can be added safely; openWorkspace reports mergeFailed.
    if (!plan.ok || !plan.add.length) return { foldersToAdd: [], skipped };

    const names = plan.add.map((c) => c.repoName).join(", ");
    const short = file.split("/").pop() ?? file;
    const p = await vscode.window.showQuickPick(
      [
        { label: `$(add) Add ${names}`, detail: `Becomes a folder in ${short}`, yes: true },
        {
          label: "$(circle-slash) Leave the workspace as-is",
          detail: "Opens in its worktree; the brief uses absolute paths",
          yes: false,
        },
      ],
      {
        title:
          plan.add.length === 1
            ? `Add ${names} to ${short}?`
            : `Add ${plan.add.length} folders to ${short}?`,
        ignoreFocusOut: true,
      },
    );
    if (p?.yes !== true) return { foldersToAdd: [], skipped };
    return { foldersToAdd: plan.add.map((c) => ({ name: c.label, path: c.path })), skipped };
  }
```

**3c.** In `launch()`, insert between `targetToOpenArgs` and `resolveRemoteControl` (after line 994):

```ts
    // A saved workspace is the user's own artifact — never write it without approval.
    const additions = args.existingWorkspaceFile
      ? await this.resolveWorkspaceAdditions(
          args.existingWorkspaceFile,
          services.map((s) => ({ label: s.name, repoName: s.name, path: s.path })),
        )
      : { foldersToAdd: [], skipped: [] };
```

**3d.** Add to the `openWorkspace({…})` call (after `existingFolder: args.existingFolder,`):

```ts
      foldersToAdd: additions.foldersToAdd,
```

**3e.** Extend the success toast (replace lines 1025-1029):

```ts
      const added = result.mergedRepos?.length ? ` Added ${result.mergedRepos.join(", ")}.` : "";
      const skipped = additions.skipped.length
        ? ` ${additions.skipped.join(", ")} already in the workspace — not added as folders.`
        : "";
      const unadded = result.unaddedRepos?.length
        ? ` ${result.unaddedRepos.join(", ")} couldn't be added as roots to that window — their briefs are still in place.`
        : "";
      this.toast("success", `Opened ${where} for ${key}. Brief seeded in each repo.${added}${skipped}${unadded}${seeded}${rcNote}`);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/tasksView.test.ts`
Expected: PASS — the new cases and all pre-existing ones (the mock factory addition keeps them alive).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: 0 failures.

- [ ] **Step 6: Commit**

```bash
git add src/tasksView.ts test/unit/tasksView.test.ts
git commit -m "feat(take): ask before adding folders to an existing workspace

Take into a saved .code-workspace now classifies each repo first: a name
already in the workspace is skipped silently and named in the toast, and
only genuinely new repos raise a prompt.

Dismissing it means 'leave as-is', not 'abort' — the worktrees already
exist by then, so dropping the launch over a folder question is worse."
```

---

### Task 6: The same guarantee for batch take

Batch appends one key-qualified worktree folder per task on every launch. Same fix, plus the mention correction for its `existing` target.

**Files:**
- Modify: `src/engine/batchWorkspace.ts` (`SharedOpenRequest:33-39`; export `folderName:54`; the `existing` branch at `:104-112`; `mentionMode`/mentions at `:132` and `:145-149`)
- Modify: `src/tasksView.ts` (the batch flow's `openSharedWorkspace` call at `:1199-1213`)
- Test: `test/unit/engine/batchWorkspace.test.ts`, `test/unit/tasksView.test.ts`

**Interfaces:**
- Consumes: `planWorkspaceMerge`, `workspaceFolders`, `mentionInWorkspace` (Tasks 1-3); `resolveWorkspaceAdditions` (Task 5).
- Produces: `SharedOpenRequest.foldersToAdd?: { name: string; path: string }[]`; `export function folderName(key: string, repo: string): string`.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/engine/batchWorkspace.test.ts` (add `folderName` to the line-4 import):

```ts
describe("openSharedWorkspace — existing workspace", () => {
  const existing = () => {
    readFileSync.mockImplementation((p) =>
      String(p).endsWith(".code-workspace") ? '{ "folders": [{ "path": "/repos/api" }] }' : "",
    );
  };

  it("leaves the file untouched when foldersToAdd is absent", async () => {
    existing();
    const result = await openSharedWorkspace(
      baseReq({ target: { kind: "existing", file: "/ws/team.code-workspace" } }),
    );
    expect(writes((p) => p.endsWith(".code-workspace"))).toHaveLength(0);
    expect(result.mergedFolders).toEqual([]);
    expect(result.workspaceFile).toBe("/ws/team.code-workspace");
  });

  it("merges exactly foldersToAdd", async () => {
    existing();
    const result = await openSharedWorkspace(
      baseReq({
        target: { kind: "existing", file: "/ws/team.code-workspace" },
        foldersToAdd: [{ name: "ASM-1-infra", path: "/repos/infra/.claude/worktrees/ASM-1" }],
      }),
    );
    expect(result.mergedFolders).toEqual(["ASM-1-infra"]);
  });

  it("routes a worktree's mentions through its containing root", async () => {
    execSync.mockReturnValue("src/export.py\n");
    existing();
    await openSharedWorkspace(
      baseReq({
        tasks: [
          {
            ticket: { key: "ASM-1", summary: "one", url: "" },
            planMd: "p",
            descriptionText: "fix `src/export.py`",
            services: [{ name: "api", path: "/repos/api/.claude/worktrees/ASM-1", isGit: true }],
          },
        ],
        target: { kind: "existing", file: "/ws/team.code-workspace" },
      }),
    );
    const plan = JSON.parse(String(writes((p) => p.includes("/.agentflow/plans/"))[0][1]));
    expect(plan.matches[0].prompt).toContain("@api/.claude/worktrees/ASM-1/src/export.py");
  });
});

describe("folderName", () => {
  it("key-qualifies so two tasks in one repo stay distinct roots", () => {
    expect(folderName("ASM-1", "api")).toBe("ASM-1-api");
    expect(folderName("ASM-2", "api")).toBe("ASM-2-api");
  });
});
```

**First**, close a coverage gap Task 5's review found. Task 5 shipped the pluralized multi-repo prompt title and the `join(", ")` name lists, but every one of its tests used a single-item `add`/`duplicates` array, so those branches are untested. Add this to the **`describe("existing workspace open target", …)`** block (not the batch block), beside Task 5's tests:

```ts
    it("pluralizes the prompt and lists every new repo when more than one is added", async () => {
      pickExisting();
      vi.mocked(planWorkspaceMerge).mockReturnValue({
        add: [
          { label: "infra", repoName: "infra", path: "/repos/infra" },
          { label: "tooling", repoName: "tooling", path: "/repos/tooling" },
        ],
        duplicates: [],
        present: [],
        ok: true,
      });
      vi.mocked(window.showQuickPick)
        .mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never)
        .mockResolvedValueOnce({ yes: true } as never);

      const { provider } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]);

      const addPrompt = vi.mocked(window.showQuickPick).mock.calls[1];
      expect((addPrompt[1] as { title: string }).title).toBe("Add 2 folders to team.code-workspace?");
      expect((addPrompt[0] as { label: string }[])[0].label).toBe("$(add) Add infra, tooling");
      expect(openWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          foldersToAdd: [
            { name: "infra", path: "/repos/infra" },
            { name: "tooling", path: "/repos/tooling" },
          ],
        }),
      );
    });

    it("names every duplicate in the toast when more than one is skipped", async () => {
      pickExisting();
      vi.mocked(planWorkspaceMerge).mockReturnValue({
        add: [],
        duplicates: [
          { label: "api", repoName: "api", path: "/repos/api/.claude/worktrees/ASM-1" },
          { label: "web", repoName: "web", path: "/repos/web/.claude/worktrees/ASM-1" },
        ],
        present: [],
        ok: true,
      });
      vi.mocked(window.showQuickPick).mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never);
      vi.mocked(openWorkspace).mockResolvedValue({
        mode: "multiroot",
        workspaceFile: "/ws/team.code-workspace",
        briefs: [],
        opened: ["/ws/team.code-workspace"],
        remoteControl: false,
      });

      const { provider, posted } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]);

      const toast = posted().find((m) => m.type === "toast") as { message: string };
      expect(toast.message).toContain("api, web already in the workspace");
    });
```

**Then** add to `test/unit/tasksView.test.ts`, in the batch describe block (find it with `grep -n "takeBatch" test/unit/tasksView.test.ts`):

```ts
    it("adds nothing to a shared existing workspace when every repo name is present", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "pick-existing" });
      vi.mocked(listWorkspaceFiles).mockReturnValue([
        { file: "/ws/team.code-workspace", folders: 1, mtimeMs: 1 },
      ]);
      vi.mocked(planWorkspaceMerge).mockReturnValue({
        add: [],
        duplicates: [{ label: "ASM-1-account-service", repoName: "account-service", path: "/repos/account-service/.claude/worktrees/ASM-1" }],
        present: [],
        ok: true,
      });
      vi.mocked(window.showQuickPick).mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never);
      vi.mocked(openSharedWorkspace).mockResolvedValue({
        opened: true, briefs: [], seeded: 1, workspaceFile: "/ws/team.code-workspace",
      });

      const { provider } = setup();
      await provider.takeBatch(["ASM-1"], ["account-service"]);

      expect(openSharedWorkspace).toHaveBeenCalledWith(expect.objectContaining({ foldersToAdd: [] }));
    });
```

`takeBatch(keys: string[], repos: string[])` — both arguments are required; the existing
batch tests call it as `provider.takeBatch(["ASM-1"], ["api"])` (see `:1826`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/batchWorkspace.test.ts test/unit/tasksView.test.ts`
Expected: FAIL — `foldersToAdd` is not on `SharedOpenRequest`; `folderName` is not exported.

- [ ] **Step 3: Implement**

**3a.** In `src/engine/batchWorkspace.ts`, extend the import from `./workspace` (lines 8-17) with `workspaceFolders` and `mentionInWorkspace`.

**3b.** Add to `SharedOpenRequest`:

```ts
  /** Folders the user approved adding to an `existing` target — the ONLY thing merged.
   *  Absent or empty leaves that workspace file byte-identical. */
  foldersToAdd?: { name: string; path: string }[];
```

**3c.** Export `folderName` (line 54): change `function folderName(` to `export function folderName(`.

**3d.** Replace the `target.kind === "existing"` branch (lines 104-112):

```ts
  if (target.kind === "existing") {
    const merge = mergeReposIntoWorkspace(target.file, req.foldersToAdd ?? []);
    mergedFolders = merge.added;
    mergeFailed = merge.ok ? undefined : true;
    workspaceFile = target.file;
    openTarget = target.file;
  } else if (target.kind === "live-folder") {
```

**3e.** Replace the `mentionMode` line (`:132`) and the mention construction inside the `writePlanFile` loop (`:145-149`). Delete the `const mentionMode: WorkspaceMode = …` line and its comment, and replace with a per-task mention resolver:

```ts
  // A `@<folder>/<rel>` mention only resolves against a root the window actually has.
  // For an existing workspace the roots are whatever it declares plus whatever was just
  // merged, so resolve each repo against them: a worktree inside a declared root gets a
  // precise mention, and a repo inside none gets no mention at all rather than one that
  // silently names a different checkout. The live-folder destination never gets the
  // worktrees, and a freshly written workspace has every folder as a root.
  const roots = target.kind === "existing" ? workspaceFolders(target.file) ?? [] : undefined;
  const mentionsFor = (key: string, s: ServiceRef, files: string[]): string[] =>
    roots
      ? files.map((f) => mentionInWorkspace(roots, s.path, f)).filter((m): m is string => !!m)
      : files.map((f) => mention(workspaceFile ? "multiroot" : "per-window", folderName(key, s.name), f));
```

Then inside the `tasks.forEach` that writes plans (`:144-155`), replace the `mentions` assignment with:

```ts
      const mentions = t.services.flatMap((s) =>
        mentionsFor(t.ticket.key, s, filesByPair.get(`${t.ticket.key}:${s.name}`) ?? []),
      );
```

Line 132 is `WorkspaceMode`'s **only** use in this file (`Run.mode` at `:164` is assigned string literals directly), so also drop it from the line-3 import: `import { Run, ServiceRef } from "../types";`.

**3f.** In `src/tasksView.ts`'s batch flow, resolve additions before `openSharedWorkspace`. Insert immediately before the `const result = await openSharedWorkspace({` line (`:1201`):

```ts
        // Same guarantee as a single take: the workspace file is the user's artifact.
        const additions =
          target.kind === "existing"
            ? await this.resolveWorkspaceAdditions(
                target.file,
                resolved.flatMap((r) =>
                  r.task.services.map((s) => ({
                    label: folderName(r.task.ticket.key, s.name),
                    repoName: s.name,
                    path: s.path,
                  })),
                ),
              )
            : { foldersToAdd: [], skipped: [] };
```

Add `foldersToAdd: additions.foldersToAdd,` to the `openSharedWorkspace({…})` argument, and import `folderName` alongside `openSharedWorkspace` on line 22-ish (`import { openSharedWorkspace, folderName, type BatchTask } from "./engine/batchWorkspace";` — check the existing import shape first).

Extend the batch `extra` message (after the `unaddedFolders` branch at `:1211-1213`):

```ts
        if (additions.skipped.length) {
          extra += ` ${[...new Set(additions.skipped)].join(", ")} already in the workspace — the worktrees weren't added as folders.`;
        }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/batchWorkspace.test.ts test/unit/tasksView.test.ts`
Expected: PASS. Pre-existing batch tests for the `new` target must be untouched — a freshly written workspace still names every folder `<KEY>-<repo>` and mentions it as `@<KEY>-<repo>/rel`.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: 0 test failures, 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add src/engine/batchWorkspace.ts src/tasksView.ts test/unit/engine/batchWorkspace.test.ts test/unit/tasksView.test.ts
git commit -m "feat(batch): ask before adding worktree folders to an existing workspace

Batch appended one key-qualified worktree folder per task on every launch.
It now merges only approved folders, and resolves each task's mentions
against the window's real roots so a skipped worktree is still reachable
through its containing root instead of being mentioned wrongly."
```

---

### Task 7: Changelog

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Read the top of the file to match its format**

Run: `head -30 CHANGELOG.md`

- [ ] **Step 2: Add the entry**

Add under the current unreleased/next-version heading, matching the surrounding bullet style:

```markdown
- **Existing workspaces are no longer modified without asking.** Taking a task into a saved
  `.code-workspace` used to append every repo that wasn't already a folder — and because a
  worktree keeps its repo's name, a workspace with `api` grew a second root also called
  `api`, then a third. Repos whose name the workspace already has are now skipped, and
  anything genuinely new is added only after you approve it. The task still opens in its
  worktree either way, and its `@mentions` now resolve through the containing root instead
  of silently naming the main checkout.
```

- [ ] **Step 3: Full suite**

No test asserts on `CHANGELOG.md` (the `telemetry/docs.test.ts` drift guard covers the
telemetry docs only), so this is just a regression check.

Run: `npm test`
Expected: 0 failures.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): note that existing workspaces are no longer modified silently"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| `workspaceFolders` / `workspaceFolderPaths` single reader | 1 |
| `planWorkspaceMerge` buckets + `ok:false` | 2 |
| Name dedup: `name` field **and** basename, case-insensitive | 2 |
| Dedup on bare repo name, not the label | 2 (test), 6 (batch labels) |
| `mentionInWorkspace`, deepest root, `undefined` outside | 3 |
| `mergeReposIntoWorkspace` param widening | 4 |
| `OpenRequest.foldersToAdd`, merge only that | 4 |
| Absolute `{brief}` for the existing-workspace branch | 4 |
| The approval prompt + multi-repo copy | 5 |
| Dismissal = "leave as-is", not abort | 5 |
| Duplicates in the toast | 5 |
| Batch: `foldersToAdd`, `folderName` export, mentions | 6 |
| Never destructive / no new config key | Global Constraints; no task adds either |
| Explore unaffected | No task touches `explore()` — its services come from the destination, so every candidate is `present`; covered by the Task 5 "new-window destination" regression test and the untouched existing suite |

**Placeholder scan:** No TBD/TODO. Every code step carries the actual code. The one soft instruction is Task 6 Step 1's note about matching `takeBatch`'s real call shape, and Task 6 Step 3e's "check before deleting" on the `WorkspaceMode` import — both are verify-then-act, not unspecified work.

**Type consistency:** `MergeCandidate { label, repoName, path }` is used identically in Tasks 2, 5, 6. `WorkspaceMergePlan { add, duplicates, present, ok }` likewise. `foldersToAdd` is `{ name: string; path: string }[]` on `OpenRequest` (Task 4) and `SharedOpenRequest` (Task 6), and `resolveWorkspaceAdditions` returns exactly that type (Task 5). `workspaceFolders` returns `WorkspaceFolder[] | undefined` in Task 1 and every consumer applies `?? []`.
