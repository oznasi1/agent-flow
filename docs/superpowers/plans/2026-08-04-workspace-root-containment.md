# Containment-Aware Workspace Root Merging — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Agent Flow adding a `.code-workspace` root that is already reachable from a root the workspace declares, and stop a worktree root being mistaken for a repo of its own.

**Architecture:** Extract the containment predicate that is currently private to `mentionInWorkspace` into an exported `containingRoot`, then consult it at merge-planning time and again at the write layer. Separately, unwind Agent Flow's own `.claude/worktrees/<KEY>` path convention when repos are derived from an existing-workspace destination. Name-based dedup is untouched and keeps precedence.

**Tech Stack:** TypeScript, VS Code extension API, `jsonc-parser` (comment-preserving edits), Vitest with `vi.mock("fs")`, esbuild.

**Spec:** [docs/superpowers/specs/2026-08-04-workspace-root-containment-design.md](../specs/2026-08-04-workspace-root-containment-design.md)

## Global Constraints

Every task's requirements implicitly include this section.

- **Baseline at plan time:** 66 test files, 1895 tests, all passing. No task may reduce the passing count.
- **Typecheck must stay clean:** `npm run typecheck` (`tsc --noEmit`).
- **Full suite must stay green:** `npm test` (`vitest run`).
- **Coverage thresholds are enforced** by `npm run test:cov`: statements 90, branches 85, functions 85, lines 90. Target ≥95% line coverage on every file this plan changes.
- **Build must succeed:** `npm run build`.
- **`vscode` is not a real module** — it is mocked at `test/_mocks/vscode.ts` via a Vitest alias. Never import it in a pure-logic path you want unit-testable without that mock.
- **Comment style:** this codebase explains *why*, not *what*, in block comments above non-obvious logic. Match the density of the surrounding code. Do not add narration comments to obvious lines.
- **No new configuration key.** No new user-facing copy strings.
- **Additive-or-nothing:** no task may remove, reorder or rename an existing workspace folder.
- **Out of scope by explicit decision:** repairing already-polluted workspace files, and pruning roots whose worktree was deleted. Do not implement either.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/engine/workspace.ts` | Workspace file reading, merge planning, writing, mention rendering | Add `containingRoot`; `mentionInWorkspace` delegates to it; `WorkspaceMergePlan` gains `redundant`; `mergeReposIntoWorkspace` refuses nested paths |
| `src/engine/worktree.ts` | Owns the `.claude/worktrees` layout convention | Add `repoRootOfWorktree` — the inverse of the layout it already creates |
| `src/tasksView.ts` | Destination resolution, repo derivation, launch orchestration | `servicesFromExistingDestination` unwinds worktree folders and dedups; `resolveWorkspaceAdditions` folds `redundant` into `skipped` |
| `test/unit/engine/workspace.test.ts` | Unit tests for the above engine module | New `containingRoot` group; new `planWorkspaceMerge` and `mergeReposIntoWorkspace` cases |
| `test/unit/engine/worktree.test.ts` | Unit tests for worktree layout | New `repoRootOfWorktree` group |
| `test/unit/tasksView.test.ts` | Argument-level tests for the view | Two mandatory mock-factory updates + new derivation cases |

`repoRootOfWorktree` lives in `worktree.ts`, not `workspace.ts`, because that module owns `WORKTREE_DIR`. Putting the inverse anywhere else would let the constant and its consumer drift.

---

### Task 1: `containingRoot` + `mentionInWorkspace` delegates to it

**Files:**
- Modify: `src/engine/workspace.ts:465-479` (`mentionInWorkspace`)
- Test: `test/unit/engine/workspace.test.ts`

**Interfaces:**
- Consumes: `WorkspaceFolder` (`{ name?: string; path: string }`, already exported at `workspace.ts:362`), and the module-private `canon(p: string): string` at `workspace.ts:485`.
- Produces: `export function containingRoot(roots: WorkspaceFolder[], target: string): WorkspaceFolder | undefined` — used by Tasks 3 and 4.

This is a behavior-preserving extraction. The existing `mentionInWorkspace` tests are the regression gate: they must keep passing untouched.

- [ ] **Step 1: Write the failing tests**

Add this group to `test/unit/engine/workspace.test.ts`. Put it immediately before the existing `describe("mentionInWorkspace", …)` group. Add `containingRoot` to the import list at the top of the file (line 4).

```ts
describe("containingRoot", () => {
  const roots = (...paths: string[]) => paths.map((p) => ({ path: p }));

  it("matches a root exactly", () => {
    expect(containingRoot(roots("/repos/api"), "/repos/api")?.path).toBe("/repos/api");
  });

  it("matches a path nested one level under a root", () => {
    expect(containingRoot(roots("/repos/api"), "/repos/api/src")?.path).toBe("/repos/api");
  });

  it("matches a worktree several levels under a root", () => {
    expect(
      containingRoot(roots("/repos/api"), "/repos/api/.claude/worktrees/PROJ-1")?.path,
    ).toBe("/repos/api");
  });

  it("picks the deepest of two containing roots", () => {
    // VS Code resolves a path against its most specific root; so must we, or a mention
    // would name the outer root and point at the wrong tree.
    const found = containingRoot(roots("/repos", "/repos/api"), "/repos/api/src/x.ts");
    expect(found?.path).toBe("/repos/api");
  });

  it("does not let a root swallow a sibling that shares its prefix", () => {
    expect(containingRoot(roots("/repos/api"), "/repos/api-gateway")).toBeUndefined();
  });

  it("returns undefined for a path inside no root", () => {
    expect(containingRoot(roots("/repos/api"), "/elsewhere/web")).toBeUndefined();
  });

  it("returns undefined when there are no roots", () => {
    expect(containingRoot([], "/repos/api")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/workspace.test.ts -t "containingRoot"`

Expected: FAIL. Because the import on line 4 names an export that does not exist yet, the whole file fails to collect — the error mentions `containingRoot` is not exported by `src/engine/workspace.ts`. That is the expected failure, not a broken test file.

- [ ] **Step 3: Implement `containingRoot`**

In `src/engine/workspace.ts`, insert this directly **above** `mentionInWorkspace` (before its doc comment at line 459):

```ts
/** The declared root that contains `target` — path-equal, or `target` nested beneath it.
 *  Deepest root wins, matching VS Code's most-specific-root resolution. The `+ path.sep`
 *  guard keeps /repos/api from swallowing the sibling /repos/api-gateway. `undefined` when
 *  `target` is inside no root.
 *
 *  Single reader for "is this path already reachable from a root this workspace has", so
 *  merge planning, the write layer and mention rendering cannot disagree on the answer —
 *  the same reasoning that makes `workspaceFolders` the single reader for the folder list.
 *  `roots` must carry canonical paths (`workspaceFolders` returns them); `target` is
 *  canonicalized here. */
export function containingRoot(
  roots: WorkspaceFolder[],
  target: string,
): WorkspaceFolder | undefined {
  const t = canon(target);
  return roots
    .filter((r) => r.path === t || t.startsWith(r.path + path.sep))
    .sort((a, b) => b.path.length - a.path.length)[0];
}
```

- [ ] **Step 4: Rewrite `mentionInWorkspace` to delegate**

Replace the body of `mentionInWorkspace` (keep its existing doc comment exactly as it is — it documents the mention contract, which has not changed). The two inline comments about deepest-root and the `+ sep` guard move to `containingRoot`, so delete them here:

```ts
export function mentionInWorkspace(
  roots: WorkspaceFolder[],
  repoPath: string,
  rel: string,
): string | undefined {
  const root = containingRoot(roots, repoPath);
  if (!root) return undefined;
  const inner = path.relative(root.path, canon(repoPath));
  return mention("multiroot", root.name ?? path.basename(root.path), inner ? `${inner}/${rel}` : rel);
}
```

- [ ] **Step 5: Run the new tests and the mention regression group**

Run: `npx vitest run test/unit/engine/workspace.test.ts -t "containingRoot"`
Expected: PASS (7 tests).

Run: `npx vitest run test/unit/engine/workspace.test.ts -t "mentionInWorkspace"`
Expected: PASS, with no edits to those tests. If any fail, the extraction changed behavior — fix `containingRoot`, do not edit the mention tests.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/engine/workspace.ts test/unit/engine/workspace.test.ts
git commit -m "refactor(workspace): extract containingRoot from mentionInWorkspace

One reader for 'is this path already reachable from a declared root', so
merge planning and the write layer can consult the same answer instead of
each comparing paths their own way."
```

---

### Task 2: `repoRootOfWorktree`

**Files:**
- Modify: `src/engine/worktree.ts` (add an export after `branchName`, which ends at line 24)
- Test: `test/unit/engine/worktree.test.ts`

**Interfaces:**
- Consumes: the module-private `WORKTREE_DIR` at `worktree.ts:10` (`path.join(".claude", "worktrees")`).
- Produces: `export function repoRootOfWorktree(p: string): string | undefined` — used by Task 5.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/engine/worktree.test.ts`, after the existing `describe("branchName", …)` group. Add `repoRootOfWorktree` to the import on line 4.

```ts
describe("repoRootOfWorktree", () => {
  it("returns the repo a worktree belongs to", () => {
    expect(repoRootOfWorktree("/repos/webapp/.claude/worktrees/PROJ-1")).toBe("/repos/webapp");
  });

  it("keeps any path below the worktree attached to the same repo", () => {
    expect(repoRootOfWorktree("/repos/webapp/.claude/worktrees/PROJ-1/src/x.ts")).toBe(
      "/repos/webapp",
    );
  });

  it("unwinds a worktree nested inside a worktree to the outermost repo", () => {
    // Splitting on the FIRST marker undoes the whole cascade in one step: a polluted
    // workspace could otherwise hand us .../PROJ-1/.claude/worktrees/PROJ-2 and we would
    // treat PROJ-1 as the repo.
    expect(
      repoRootOfWorktree("/repos/webapp/.claude/worktrees/PROJ-1/.claude/worktrees/PROJ-2"),
    ).toBe("/repos/webapp");
  });

  it("returns undefined for a plain repo path", () => {
    expect(repoRootOfWorktree("/repos/webapp")).toBeUndefined();
  });

  it("returns undefined for a .claude path that is not a worktree", () => {
    expect(repoRootOfWorktree("/repos/webapp/.claude/settings.json")).toBeUndefined();
  });

  it("returns undefined for the worktrees directory itself", () => {
    expect(repoRootOfWorktree("/repos/webapp/.claude/worktrees")).toBeUndefined();
  });

  it("returns undefined when there is no repo prefix", () => {
    expect(repoRootOfWorktree("/.claude/worktrees/PROJ-1")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/worktree.test.ts -t "repoRootOfWorktree"`
Expected: FAIL — collection error, `repoRootOfWorktree` is not exported by `src/engine/worktree.ts`.

- [ ] **Step 3: Implement it**

In `src/engine/worktree.ts`, insert after `branchName` (after line 24):

```ts
/** The repo a worktree path belongs to: the prefix before our `.claude/worktrees/<KEY>`
 *  segment. Splits on the FIRST occurrence, so a worktree nested inside a worktree unwinds
 *  all the way to the outermost real repo in one step. `undefined` for any path that isn't
 *  one of our worktrees — including the `worktrees` directory itself, which is not one.
 *
 *  The inverse of the layout createWorktrees writes, and it lives here so the convention
 *  and its reader cannot drift apart. */
export function repoRootOfWorktree(p: string): string | undefined {
  const marker = `${path.sep}${WORKTREE_DIR}${path.sep}`;
  const at = p.indexOf(marker);
  return at > 0 ? p.slice(0, at) : undefined;
}
```

`at > 0` rather than `at !== -1`: a marker at index 0 leaves no repo prefix to return.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/worktree.test.ts`
Expected: PASS, including the pre-existing `branchName` and `createWorktrees` groups.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/engine/worktree.ts test/unit/engine/worktree.test.ts
git commit -m "feat(worktree): add repoRootOfWorktree, the inverse of the layout

A workspace folder pointing at one of our worktrees has a ticket key for a
basename. Callers need the repo it belongs to; the layout constant lives
here, so the reader does too."
```

---

### Task 3: `redundant` bucket in `planWorkspaceMerge`

**Files:**
- Modify: `src/engine/workspace.ts:419-430` (`WorkspaceMergePlan`), `src/engine/workspace.ts:438-457` (`planWorkspaceMerge`)
- Test: `test/unit/engine/workspace.test.ts`

**Interfaces:**
- Consumes: `containingRoot` from Task 1.
- Produces: `WorkspaceMergePlan` gains a required `redundant: MergeCandidate[]` field. Task 5 reads it. Any object literal of this type elsewhere must gain the field or `tsc` fails — that is the intended forcing function.

Classification order is **`present` → `duplicates` → `redundant` → `add`**. Name precedence is deliberate: a worktree inside its own same-named repo stays a `duplicate`, so existing classifications, toast copy and tests do not move. `redundant` holds only what name-matching cannot see.

- [ ] **Step 1: Write the failing tests**

Add these to the existing `describe("planWorkspaceMerge", …)` group in `test/unit/engine/workspace.test.ts`. That group already defines the helper `cand(repoName, p, label = repoName)` — reuse it, do not redefine it.

```ts
  it("skips a candidate nested inside a parent-directory root", () => {
    // The root is the repos parent, so no name matches — only containment can see this.
    readFileSync.mockReturnValue('{ "folders": [{ "path": "/Users/me/projects" }] }');
    const plan = planWorkspaceMerge("/ws/t.code-workspace", [
      cand("webapp", "/Users/me/projects/webapp/.claude/worktrees/PROJ-1"),
    ]);
    expect(plan.redundant.map((c) => c.repoName)).toEqual(["webapp"]);
    expect(plan.add).toEqual([]);
    expect(plan.duplicates).toEqual([]);
  });

  it("skips a candidate nested inside a root the user renamed", () => {
    readFileSync.mockReturnValue(
      '{ "folders": [{ "name": "monorepo", "path": "/Users/me/projects" }] }',
    );
    const plan = planWorkspaceMerge("/ws/t.code-workspace", [
      cand("webapp", "/Users/me/projects/webapp"),
    ]);
    expect(plan.redundant.map((c) => c.repoName)).toEqual(["webapp"]);
    expect(plan.add).toEqual([]);
  });

  it("keeps name precedence: a worktree of a same-named root is still a duplicate", () => {
    // Regression guard on the precedence decision. This candidate satisfies BOTH rules;
    // moving it to `redundant` would change the launch toast's wording.
    readFileSync.mockReturnValue('{ "folders": [{ "path": "/repos/webapp" }] }');
    const plan = planWorkspaceMerge("/ws/t.code-workspace", [
      cand("webapp", "/repos/webapp/.claude/worktrees/PROJ-1"),
    ]);
    expect(plan.duplicates.map((c) => c.repoName)).toEqual(["webapp"]);
    expect(plan.redundant).toEqual([]);
  });

  it("keeps an exact root match in present, not redundant", () => {
    readFileSync.mockReturnValue('{ "folders": [{ "path": "/repos/webapp" }] }');
    const plan = planWorkspaceMerge("/ws/t.code-workspace", [cand("webapp", "/repos/webapp")]);
    expect(plan.present.map((c) => c.repoName)).toEqual(["webapp"]);
    expect(plan.redundant).toEqual([]);
  });

  it("still adds a repo that is inside no root and shares no name", () => {
    readFileSync.mockReturnValue('{ "folders": [{ "path": "/repos/webapp" }] }');
    const plan = planWorkspaceMerge("/ws/t.code-workspace", [
      cand("infra", "/elsewhere/infra/.claude/worktrees/PROJ-1"),
    ]);
    expect(plan.add.map((c) => c.repoName)).toEqual(["infra"]);
    expect(plan.redundant).toEqual([]);
  });

  it("leaves redundant empty when the file cannot be parsed", () => {
    readFileSync.mockReturnValue("{ not json");
    const plan = planWorkspaceMerge("/ws/broken.code-workspace", [cand("api", "/repos/api")]);
    expect(plan.ok).toBe(false);
    expect(plan.redundant).toEqual([]);
    expect(plan.add).toEqual([]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/workspace.test.ts -t "planWorkspaceMerge"`
Expected: FAIL — the new cases fail on `plan.redundant` being `undefined` (`expect(undefined).toEqual([])`). The six pre-existing cases in the group still pass.

- [ ] **Step 3: Add the field to `WorkspaceMergePlan`**

In `src/engine/workspace.ts`, add to the interface, between `duplicates` and `present`:

```ts
  /** Inside a declared root, so already reachable and visible beneath it. Skipped without
   *  asking — adding it would nest a root inside a root and buy nothing. Distinct from
   *  `duplicates` because the containing root's name may match nothing about this repo:
   *  a workspace rooted at the repos parent directory, or a root the user renamed. */
  redundant: MergeCandidate[];
```

- [ ] **Step 4: Classify into it**

Two edits inside `planWorkspaceMerge`. The `ok:false` early return:

```ts
  const folders = workspaceFolders(file);
  if (!folders) return { add: [], duplicates: [], redundant: [], present: [], ok: false };
```

And the loop — note `folders` is already in scope and already carries canonical paths, which is exactly what `containingRoot` requires:

```ts
  const plan: WorkspaceMergePlan = { add: [], duplicates: [], redundant: [], present: [], ok: true };
  for (const c of candidates) {
    if (paths.has(canon(c.path))) plan.present.push(c);
    else if (names.has(c.repoName.toLowerCase())) plan.duplicates.push(c);
    else if (containingRoot(folders, c.path)) plan.redundant.push(c);
    else plan.add.push(c);
  }
```

Also extend the doc comment above `planWorkspaceMerge` with a sentence naming the new bucket, since the existing comment enumerates the rules:

```
 *  A candidate already inside one of the declared roots is `redundant` — reachable and
 *  visible there already, so a root of its own would nest a root inside a root.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/workspace.test.ts -t "planWorkspaceMerge"`
Expected: PASS — 6 pre-existing + 6 new.

Run: `npm run typecheck`
Expected: clean. If it reports a missing `redundant` on an object literal in `src/`, add `redundant: []` there. (Literals in `test/unit/tasksView.test.ts` are handled in Task 5 — leave them for now; the type error surfaces only where a `WorkspaceMergePlan` is constructed in source.)

- [ ] **Step 6: Commit**

```bash
git add src/engine/workspace.ts test/unit/engine/workspace.test.ts
git commit -m "feat(workspace): classify a candidate inside a declared root as redundant

Name dedup cannot see a workspace rooted at the repos parent directory, or
a root the user renamed. Containment can. Name keeps precedence, so the
common worktree case stays a duplicate and its toast copy is unchanged."
```

---

### Task 4: `mergeReposIntoWorkspace` refuses nested paths

**Files:**
- Modify: `src/engine/workspace.ts:307-358` (`mergeReposIntoWorkspace`)
- Test: `test/unit/engine/workspace.test.ts`

**Interfaces:**
- Consumes: `containingRoot` from Task 1.
- Produces: no signature change. `mergeReposIntoWorkspace(file, repos)` keeps returning `{ added: string[]; ok: boolean }`.

This is defense in depth behind Task 3, not a substitute for it. The 0.1.42 defect was a caller deriving its own folder list plus a writer that compared exact paths only; re-checking here means a future caller that skips merge planning still cannot reintroduce it.

- [ ] **Step 1: Write the failing tests**

Add to the existing `describe("mergeReposIntoWorkspace", …)` group in `test/unit/engine/workspace.test.ts`:

```ts
  it("refuses a folder nested inside an existing root, even when handed one directly", () => {
    // The write layer is the last line of defense: a caller that skips planWorkspaceMerge
    // must still not be able to nest a root inside a root.
    readFileSync.mockReturnValue('{ "folders": [{ "path": "/Users/me/projects" }] }');
    const res = mergeReposIntoWorkspace("/ws/t.code-workspace", [
      { name: "webapp", path: "/Users/me/projects/webapp/.claude/worktrees/PROJ-1" },
    ]);
    expect(res).toEqual({ added: [], ok: true });
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("still writes a folder that is inside no existing root", () => {
    readFileSync.mockReturnValue('{ "folders": [{ "path": "/Users/me/projects" }] }');
    const res = mergeReposIntoWorkspace("/ws/t.code-workspace", [
      { name: "infra", path: "/elsewhere/infra" },
    ]);
    expect(res).toEqual({ added: ["infra"], ok: true });
    const written = String(writeFileSync.mock.calls[0][1]);
    expect(written).toContain("/elsewhere/infra");
  });

  it("does not let a root swallow a sibling sharing its prefix", () => {
    readFileSync.mockReturnValue('{ "folders": [{ "path": "/repos/api" }] }');
    const res = mergeReposIntoWorkspace("/ws/t.code-workspace", [
      { name: "api-gateway", path: "/repos/api-gateway" },
    ]);
    expect(res).toEqual({ added: ["api-gateway"], ok: true });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/workspace.test.ts -t "mergeReposIntoWorkspace"`
Expected: the first new test FAILS — it currently returns `{ added: ["webapp"], ok: true }` and `writeFileSync` was called. The other two pass already; they are regression guards.

- [ ] **Step 3: Replace the path-set check with a containment check**

In `mergeReposIntoWorkspace`, widen the parse cast to carry `name`, then swap the `present` set for roots. Replace this block:

```ts
  const doc = jsoncParse(text, errors, { allowTrailingComma: true }) as
    | { folders?: { path?: string }[] }
    | undefined;
```

with:

```ts
  const doc = jsoncParse(text, errors, { allowTrailingComma: true }) as
    | { folders?: { name?: string; path?: string }[] }
    | undefined;
```

and replace this block:

```ts
  const wsDir = path.dirname(file);
  const present = new Set(
    (Array.isArray(doc.folders) ? doc.folders : [])
      .map((f) => f?.path)
      .filter((p): p is string => typeof p === "string")
      .map((p) => canon(path.resolve(wsDir, p))),
  );
  const missing = repos.filter((r) => !present.has(canon(r.path)));
```

with:

```ts
  const wsDir = path.dirname(file);
  // Resolved against the file's directory and canonicalized, exactly as workspaceFolders
  // does — a raw relative "webapp" would contain nothing. Only the path is needed here,
  // so the `name` field is not carried across.
  const roots: WorkspaceFolder[] = (Array.isArray(doc.folders) ? doc.folders : [])
    .map((f) => f?.path)
    .filter((p): p is string => typeof p === "string")
    .map((p) => ({ path: canon(path.resolve(wsDir, p)) }));
  // containingRoot covers path-equality too, so this subsumes the old exact-path check:
  // a folder already declared, or already inside something declared, is not written.
  const missing = repos.filter((r) => !containingRoot(roots, r.path));
```

Leave `startIdx`, the `modify`/`applyEdits` loop, and both `ok:false` returns exactly as they are.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/workspace.test.ts`
Expected: PASS — the whole file, including every pre-existing `mergeReposIntoWorkspace` and `openWorkspace` test.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/engine/workspace.ts test/unit/engine/workspace.test.ts
git commit -m "fix(workspace): refuse to write a folder already inside a root

The write layer compared exact paths only, which is the hole a worktree
path walks straight through. Sharing containingRoot here means a caller
that bypasses merge planning still cannot nest a root inside a root."
```

---

### Task 5: `tasksView` — unwind worktree folders, fold `redundant` into the toast

**Files:**
- Modify: `src/tasksView.ts:952-961` (`servicesFromExistingDestination`), `src/tasksView.ts:1004` (the `skipped` line in `resolveWorkspaceAdditions`)
- Modify: `test/unit/tasksView.test.ts:17` and `test/unit/tasksView.test.ts:19` (mock factories)
- Test: `test/unit/tasksView.test.ts`

**Interfaces:**
- Consumes: `repoRootOfWorktree` (Task 2), `WorkspaceMergePlan.redundant` (Task 3).
- Produces: no new exports. `servicesFromExistingDestination` keeps its signature `(target: OpenTarget, repos: ServiceRef[]) => ServiceRef[]`.

**Do the two mock updates first.** Both are hard failures, not soft ones: the `worktree` mock is a *total* factory, so importing a new symbol from that module throws at collection time and every test in the 100+ test file fails at once.

- [ ] **Step 1: Fix the two mock factories**

In `test/unit/tasksView.test.ts`, line 17, add the new field to the `planWorkspaceMerge` stub — without it, `resolveWorkspaceAdditions` spreads `undefined` and throws:

```ts
  planWorkspaceMerge: vi.fn(() => ({ add: [], duplicates: [], redundant: [], present: [], ok: true })),
```

Replace line 19 entirely. `repoRootOfWorktree` is pure — no `fs`, no `child_process` — so use the real one and stub only the side-effecting entry point. This is the pattern the `batchWorkspace` mock below it already uses, and for the same reason:

```ts
// repoRootOfWorktree is a pure path function (no fs/git side effects) — keep the real one
// so the derivation tests exercise the genuine convention, and stub only createWorktrees,
// the entry point that shells out to git. Same reasoning as the batchWorkspace mock below.
vi.mock("../../src/engine/worktree", async () => {
  const actual = await vi.importActual<typeof import("../../src/engine/worktree")>(
    "../../src/engine/worktree",
  );
  return { ...actual, createWorktrees: vi.fn((s: unknown) => s) };
});
```

- [ ] **Step 2: Run the full tasksView file to confirm the mocks are sound**

Run: `npx vitest run test/unit/tasksView.test.ts`
Expected: PASS, unchanged count. This step exists to isolate mock breakage from behavior changes — if it fails now, the cause is the factory edit, nothing else.

- [ ] **Step 3: Commit the mock fix on its own**

```bash
git add test/unit/tasksView.test.ts
git commit -m "test(tasksView): use the real repoRootOfWorktree, stub only createWorktrees"
```

- [ ] **Step 4a: Write the two derivation tests**

These go in the existing `describe("explore — open target", …)` block (starts at line 2820) and use its `runExplore()` helper. Explore is the cleanest driver for the derivation: it reaches `servicesFromExistingDestination` with no worktree question and no prompt-mode pick to satisfy. Model them on the sibling test *"skips the repo pick and uses the existing workspace's repos"* — same two-pick sequence, same `listWorkspaceFiles` stub.

```ts
  it("derives the repo, not a phantom, from a workspace folder that is a worktree", async () => {
    // A folder left behind by an older version points at .../worktrees/PROJ-5111, whose
    // basename is a ticket key. Taken at face value it becomes a phantom repo — and since a
    // worktree's .git is a pointer FILE it even passes the isGit check, so the next
    // createWorktrees would nest a worktree inside that worktree.
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask", exploreMode: "knowledge" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["webapp"]));
    vi.mocked(workspaceFolderPaths).mockReturnValue(["/repos/webapp/.claude/worktrees/PROJ-5111"]);
    vi.mocked(listWorkspaceFiles).mockReturnValue([
      { file: "/ws/team.code-workspace", folders: 1, mtimeMs: 1 },
    ]);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("x");
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ target: { kind: "existing-pick" } } as never)
      .mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never);

    await runExplore();

    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        services: [expect.objectContaining({ name: "webapp", path: "/repos/webapp" })],
      }),
    );
  });

  it("collapses a repo and a worktree of that repo to one service", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask", exploreMode: "knowledge" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["webapp"]));
    vi.mocked(workspaceFolderPaths).mockReturnValue([
      "/repos/webapp",
      "/repos/webapp/.claude/worktrees/PROJ-5885",
    ]);
    vi.mocked(listWorkspaceFiles).mockReturnValue([
      { file: "/ws/team.code-workspace", folders: 2, mtimeMs: 1 },
    ]);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("x");
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ target: { kind: "existing-pick" } } as never)
      .mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never);

    await runExplore();

    const services = vi.mocked(openWorkspace).mock.calls.at(-1)![0].services;
    expect(services.map((s) => s.path)).toEqual(["/repos/webapp"]);
  });
```

- [ ] **Step 4b: Write the toast test**

This one needs `resolveWorkspaceAdditions`, which explore never calls — only `launch()` and the batch flow do. Use the batch flow, in the same `describe` that holds *"says so when merging into an existing workspace fails to parse"* (around line 2618). Copy that test's setup shape: `discoverRepos`, one `showQuickPick` answering the destination, a resolved `openSharedWorkspace`, then read the toast from `posted()` — **not** from `window.showInformationMessage`; this view posts toasts to its webview.

```ts
  it("names a redundant repo in the already-in-the-workspace clause", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({
      target: { kind: "existing", file: "/ws/team.code-workspace" },
    } as never);
    // mockReturnValueOnce, not mockReturnValue: vitest's clearMocks resets call history but
    // keeps implementations, so a permanent override would leak into later tests.
    vi.mocked(planWorkspaceMerge).mockReturnValueOnce({
      add: [],
      duplicates: [],
      redundant: [
        { label: "api", repoName: "api", path: "/repos/api/.claude/worktrees/PROJ-1" },
      ],
      present: [],
      ok: true,
    });
    vi.mocked(openSharedWorkspace).mockResolvedValue({
      workspaceFile: "/ws/team.code-workspace",
      opened: true,
      briefs: [],
      seeded: 2,
    });

    const { provider, posted } = setup();
    await provider.takeBatch(twoKeys, ["api"]);

    const toast = posted().find((m) => m.type === "toast") as { message: string };
    expect(toast.message).toContain("api already in the workspace");
    // No add-prompt: `add` was empty, so the only quick pick was the destination.
    expect(window.showQuickPick).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npx vitest run test/unit/tasksView.test.ts -t "worktree of that repo"` and `npx vitest run test/unit/tasksView.test.ts -t "not a phantom"`
Expected: FAIL — the first reports a service at `/repos/webapp/.claude/worktrees/PROJ-5111` named `PROJ-5111`; the second reports two services instead of one.

Run: `npx vitest run test/unit/tasksView.test.ts -t "already in the workspace"`
Expected: FAIL — the toast lacks the clause, because `skipped` is still built from `duplicates` alone.

- [ ] **Step 6: Implement the derivation change**

In `src/tasksView.ts`, add `repoRootOfWorktree` to the existing import from `./engine/worktree` (the one that already brings in `createWorktrees`). Then replace `servicesFromExistingDestination` and its doc comment:

```ts
  /** Repos already in an existing / live-folder destination, as ServiceRefs — the set used
   *  when we skip the picker for such destinations. Matches discovered repos by canonical
   *  path where possible; otherwise builds one from the folder path, so workspace folders
   *  outside reposRoot are honored too.
   *
   *  A folder that is one of OUR worktrees is unwound to the repo it belongs to first. Its
   *  basename is a ticket key, so taking it at face value invents a phantom repo — and
   *  because a worktree's `.git` is a pointer FILE, it even passes the isGit check, so the
   *  next createWorktrees would nest a worktree inside that worktree. Deduped by path, so a
   *  workspace declaring both a repo and a worktree of it yields one service. */
  private servicesFromExistingDestination(target: OpenTarget, repos: ServiceRef[]): ServiceRef[] {
    const byPath = new Map(repos.map((r) => [canon(r.path), r]));
    const out = new Map<string, ServiceRef>();
    for (const folder of this.prefillPathsForTarget(target)) {
      // prefillPathsForTarget yields canonical paths, and every prefix of a fully resolved
      // path is itself resolved — so the unwound repo root needs no second canon().
      const p = repoRootOfWorktree(folder) ?? folder;
      if (out.has(p)) continue;
      out.set(
        p,
        byPath.get(p) ?? { name: path.basename(p), path: p, isGit: fs.existsSync(path.join(p, ".git")) },
      );
    }
    return [...out.values()];
  }
```

- [ ] **Step 7: Fold `redundant` into the skipped list**

In `resolveWorkspaceAdditions`, replace the `skipped` line and extend the comment above it:

```ts
    // Two batch tasks in one not-yet-added repo both land in `add` under distinct
    // key-qualified labels but share a repoName — dedup here (both this bucket and the
    // display names below) so neither the toast nor the prompt copy repeats a name.
    // `redundant` joins `duplicates`: "already in the workspace" is true of both, so one
    // clause covers them and no new copy is needed.
    const skipped = [
      ...new Set([...plan.duplicates, ...plan.redundant].map((c) => c.repoName)),
    ];
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run test/unit/tasksView.test.ts`
Expected: PASS — the whole file, new tests included.

- [ ] **Step 9: Typecheck and commit**

```bash
npm run typecheck
git add src/tasksView.ts test/unit/tasksView.test.ts
git commit -m "fix(tasksView): unwind worktree folders when deriving a destination's repos

A folder pointing at .../worktrees/PROJ-1 has a ticket key for a basename and
a .git pointer file, so it passed as a repo and the next take nested a
worktree inside it. Unwind to the owning repo and dedup."
```

---

### Task 6: Full verification and integration

**Files:** none modified except `package.json` at the merge step.

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: 66 files, ≥1895 tests, 0 failures. The count must have grown by roughly the ~25 tests this plan adds; a flat count means tests were skipped rather than added.

- [ ] **Step 2: Check coverage on the changed files**

Run: `npm run test:cov`
Expected: thresholds hold (statements 90 / branches 85 / functions 85 / lines 90). Inspect the rows for `src/engine/workspace.ts`, `src/engine/worktree.ts` and `src/tasksView.ts` in the text report and confirm each is ≥95% lines. If a branch is uncovered, it is most likely `repoRootOfWorktree`'s `at > 0` guard or `containingRoot`'s empty-roots path — both already have tests, so an uncovered branch means a test is not reaching them.

- [ ] **Step 3: Confirm the bundle builds**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 4: Verify the original defect cannot recur**

Confirm by reading, not by running the extension: `mergeReposIntoWorkspace` no longer has any exact-path-equality comparison of its own, and its only skip test is `containingRoot`. This is the assertion that the 0.1.42 shape — a caller passing its own list into a writer that compares exact paths — is gone.

- [ ] **Step 5: Merge step — bump the version and rebuild the vsix**

This repo releases on every merge to `main`. Do this as part of integration, not before:

```bash
npm version patch --no-git-tag-version
npm run package          # removes the old .vsix and builds a fresh one
git add package.json package-lock.json
git commit -m "chore: release <new version>"
```

Then merge to `main`. If `package-lock.json` picks up registry URL changes, discard those — the lockfile must keep pointing at the public npm registry, or CI fails with E401.

---

## Notes for the implementer

- **`vi.mock("fs")` is hoisted** in the engine test files, so `fs.realpathSync` is a mock. `test/unit/engine/workspace.test.ts` sets it to identity in `beforeEach` (`realpathSync.mockReset().mockImplementation((p) => String(p))`), which is why `canon` is a no-op there and the literal paths in these tests compare equal. Do not add a `realpathSync` mock of your own.
- **`test/unit/tasksView.test.ts` does NOT mock `fs`.** `fs.existsSync(path.join(p, ".git"))` runs for real against paths like `/repos/webapp` and returns `false`, so a synthesized `ServiceRef` there gets `isGit: false`. That is expected; don't try to make it `true`.
- **Path separators.** `repoRootOfWorktree` builds its marker from `path.sep`, and `containingRoot` uses `path.sep`. The tests use POSIX literals because the suite runs on macOS/Linux. Do not hardcode `"/"` in `src/`.
- **Do not touch** `prefillPathsForTarget`, `chooseOpenTarget`, `targetToOpenArgs`, `pickExistingWorkspace`, `workspaceFolders`, `workspaceFolderPaths`, the approval prompt or its copy, or anything in `batchWorkspace.ts`. The spec lists them as unchanged and the existing tests will tell you if you drifted.
