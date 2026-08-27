# Child Task Worktrees Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Taking a ticket that has children gives every selected leaf its own git worktree branched off a parent branch, with a Take-time choice between one session per leaf and one orchestrator session dispatching a subagent per leaf.

**Architecture:** An optional `Capabilities.children` on the provider fetches one level of children; a pure `engine/taskTree.ts` recurses it into leaves; `createWorktrees` gains an optional `baseRef` so a child worktree branches off the parent branch; `tasksView` adds two pickers and routes fan-out into the existing `takeBatch` and orchestrator mode into a new `takeOrchestrated`. A source without the capability sees none of it.

**Tech Stack:** TypeScript, VS Code extension API, esbuild, Vitest (+ `@testing-library/react` for webview), Preact-style React in `src/webview`.

**Spec:** `docs/superpowers/specs/2026-08-17-child-task-worktrees-design.md`

## Global Constraints

- Gates, all four, before every commit: `npm run typecheck`, `npm test`, `npm run test:cov` (thresholds: statements 90, branches 85, functions 85, lines 90), `npm run build`. `npm run build` is the ONLY check that catches an `fs`/`path`/`child_process` import reaching `src/webview/` — never skip it.
- The existing test suite must pass **unmodified**. If a current test needs editing to go green, the change leaked — fix the change, not the test. The one exception is additive: appending new `it(...)` blocks to an existing test file.
- Every new field, argument and capability is **optional**. A source without `caps.children` must see zero behavior change: no new picker, no new git call, no changed prompt, no new toast.
- `src/webview/**` must not import `fs`, `os`, `path`, or `child_process`, even transitively.
- `src/engine/taskTree.ts` and `src/tasks/jira/childJql.ts` must import nothing — no `vscode`, no `fs`, no git, no connector client. Same rule `src/engine/brief.ts` states in its header comment.
- Every new test gets a mutation check: break the line it covers, re-run, confirm the test fails, restore. Assert argv and rendered strings — never truthiness.
- Commit after every task. Small commits; the review gate is per task.

## Spec deviations (deliberate, do not "fix")

1. **No `SerializedCaps.children`.** The spec listed one. Nothing in the webview reads it, and `test/unit/tasks/provider.test.ts:61` asserts `serializeCaps(...)` with `toEqual` — adding a field would force an edit to an existing test, which the constraints above forbid. Task 3 pins the absence with a test instead.
2. **No `leafBranches()` helper.** The spec listed one with collision tests. `branchName(key, summary)` always prefixes the ticket key, and two leaves never share a key, so branch collisions are unreachable and the helper would be dead code. Callers use `branchName` directly; its slug behavior is already covered in `test/unit/engine/worktree.test.ts`.
3. **No "child names a repo outside the parent's set" log line.** The spec's error table has one. Task 8 gives every child the parent's resolved repo set wholesale and never consults a child's own inference, so the case is unreachable — a log for it would be dead code. Fan-out mode resolves per-child repos, and there the case is not an error at all.
4. **`ChildRef` lives in `src/tasks/jira/client.ts`,** re-exported from `src/tasks/provider.ts` — exactly the arrangement `TaskDetail` already has (`provider.ts:10`, `provider.ts:14`). Defining it in `provider.ts` instead would invert an import direction the repo has already settled.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/engine/taskTree.ts` (new) | Pure BFS over a ticket tree: leaves, caps, cycle-breaking. Zero imports. |
| `test/unit/engine/taskTree.test.ts` (new) | Its tests. No mocks needed. |
| `src/engine/worktree.ts` (modify) | `createWorktrees` gains `opts.baseRef`; new `ensureBranch`. |
| `src/tasks/jira/childJql.ts` (new) | Pure JQL candidate builder + key quoting. |
| `src/tasks/jira/client.ts` (modify) | `ChildRef` type + `childrenOf(key)`. |
| `src/tasks/jira/provider.ts` (modify) | Wires `caps.children`, guarded on the client actually having the method. |
| `src/tasks/provider.ts` (modify) | `Capabilities.children?` + `ChildRef` re-export. |
| `src/engine/brief.ts` (modify) | Optional Children section for the orchestrator brief. |
| `src/types.ts` (modify) | `Run.parentKey?`, `Run.children?`. |
| `src/engine/workspace.ts` (modify) | `OpenRequest.parentKey?` / `.children?` reach the run record. |
| `src/engine/batchWorkspace.ts` (modify) | `BatchTask.parentKey?` reaches the run record on the shared-window path. |
| `src/tasksView.ts` (modify) | Tree probe, two pickers, fan-out routing, `takeOrchestrated`. |
| `src/webview/DeckDetail.tsx` (modify) | Renders `run.children` rows in the drawer. |
| `src/webview/deckStyles.ts` (modify) | Styles for those rows. |

---

### Task 1: Pure ticket-tree walk

**Files:**
- Create: `src/engine/taskTree.ts`
- Test: `test/unit/engine/taskTree.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface ChildLike { key: string; summary: string; statusCategory?: string | null }`
  - `interface TreeLeaf extends ChildLike { depth: number; parentKey: string }`
  - `interface TreeResult { leaves: TreeLeaf[]; dropped: string[] }`
  - `interface TreeLimits { maxDepth?: number; maxLeaves?: number }`
  - `const MAX_TREE_DEPTH = 3`, `const MAX_TREE_LEAVES = 20`
  - `async function buildTree(rootKey: string, fetch: (key: string) => Promise<ChildLike[]>, limits?: TreeLimits): Promise<TreeResult>`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/engine/taskTree.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { buildTree, MAX_TREE_DEPTH, MAX_TREE_LEAVES } from "../../../src/engine/taskTree";

/** A fetch over a literal tree: key → its children. Absent key = no children. */
function fetchFrom(tree: Record<string, { key: string; summary: string }[]>) {
  return vi.fn(async (key: string) => tree[key] ?? []);
}

describe("buildTree", () => {
  it("returns no leaves for a ticket with no children", async () => {
    const out = await buildTree("PROJ-1", fetchFrom({}));
    expect(out).toEqual({ leaves: [], dropped: [] });
  });

  it("never treats the root itself as a leaf", async () => {
    const out = await buildTree("PROJ-1", fetchFrom({}));
    expect(out.leaves.map((l) => l.key)).not.toContain("PROJ-1");
  });

  it("returns direct children as leaves at depth 1", async () => {
    const out = await buildTree("PROJ-1", fetchFrom({
      "PROJ-1": [{ key: "PROJ-2", summary: "a" }, { key: "PROJ-3", summary: "b" }],
    }));
    expect(out.leaves).toEqual([
      { key: "PROJ-2", summary: "a", depth: 1, parentKey: "PROJ-1" },
      { key: "PROJ-3", summary: "b", depth: 1, parentKey: "PROJ-1" },
    ]);
  });

  it("keeps only the leaves of a three-level tree, not the containers", async () => {
    const out = await buildTree("EPIC-1", fetchFrom({
      "EPIC-1": [{ key: "ST-1", summary: "story one" }, { key: "ST-2", summary: "story two" }],
      "ST-1": [{ key: "SUB-1", summary: "sub one" }],
    }));
    expect(out.leaves.map((l) => l.key)).toEqual(["ST-2", "SUB-1"]);
    expect(out.leaves.find((l) => l.key === "SUB-1")).toEqual({
      key: "SUB-1", summary: "sub one", depth: 2, parentKey: "ST-1",
    });
  });

  it("stops at maxDepth and treats the boundary nodes as leaves", async () => {
    const out = await buildTree("A", fetchFrom({
      A: [{ key: "B", summary: "b" }],
      B: [{ key: "C", summary: "c" }],
      C: [{ key: "D", summary: "d" }],
      D: [{ key: "E", summary: "e" }],
    }), { maxDepth: 2 });
    expect(out.leaves.map((l) => l.key)).toEqual(["C"]);
  });

  it("does not fetch below maxDepth", async () => {
    const fetch = fetchFrom({ A: [{ key: "B", summary: "b" }], B: [{ key: "C", summary: "c" }] });
    await buildTree("A", fetch, { maxDepth: 1 });
    expect(fetch).toHaveBeenCalledWith("A");
    expect(fetch).not.toHaveBeenCalledWith("B");
  });

  it("caps the leaf count and reports every leaf it cut", async () => {
    const kids = Array.from({ length: 5 }, (_, i) => ({ key: `K-${i}`, summary: `k${i}` }));
    const out = await buildTree("A", fetchFrom({ A: kids }), { maxLeaves: 3 });
    expect(out.leaves.map((l) => l.key)).toEqual(["K-0", "K-1", "K-2"]);
    expect(out.dropped).toEqual(["K-3", "K-4"]);
  });

  it("breaks a cycle and reports the repeat", async () => {
    const out = await buildTree("A", fetchFrom({
      A: [{ key: "B", summary: "b" }],
      B: [{ key: "A", summary: "a again" }],
    }));
    expect(out.leaves.map((l) => l.key)).toEqual(["B"]);
    expect(out.dropped).toEqual(["A"]);
  });

  it("reports a repeated key once per sighting and never walks it twice", async () => {
    const fetch = fetchFrom({
      A: [{ key: "B", summary: "b" }, { key: "C", summary: "c" }],
      B: [{ key: "D", summary: "d" }],
      C: [{ key: "D", summary: "d" }],
    });
    const out = await buildTree("A", fetch);
    expect(out.leaves.map((l) => l.key)).toEqual(["D"]);
    expect(out.dropped).toEqual(["D"]);
    expect(fetch).toHaveBeenCalledTimes(4); // A, B, C, D — never D twice
  });

  it("keeps the rest of the tree when one node's fetch throws, and reports that node", async () => {
    const fetch = vi.fn(async (key: string) => {
      if (key === "A") return [{ key: "B", summary: "b" }, { key: "C", summary: "c" }];
      if (key === "B") throw new Error("403");
      return [];
    });
    const out = await buildTree("A", fetch);
    // B first: the walk pushes the throwing node as it processes it, and B precedes C
    // in the frontier. C follows as an ordinary childless leaf.
    expect(out.leaves.map((l) => l.key)).toEqual(["B", "C"]);
    expect(out.dropped).toEqual(["B"]);
  });

  it("degrades to no leaves when the ROOT fetch throws", async () => {
    const out = await buildTree("A", vi.fn(async () => { throw new Error("boom"); }));
    expect(out.leaves).toEqual([]);
    expect(out.dropped).toEqual(["A"]);
  });

  it("defaults the limits to the exported constants", async () => {
    expect(MAX_TREE_DEPTH).toBe(3);
    expect(MAX_TREE_LEAVES).toBe(20);
    const kids = Array.from({ length: 25 }, (_, i) => ({ key: `K-${i}`, summary: "x" }));
    const out = await buildTree("A", fetchFrom({ A: kids }));
    expect(out.leaves).toHaveLength(20);
    expect(out.dropped).toHaveLength(5);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/unit/engine/taskTree.test.ts`
Expected: FAIL — `Failed to resolve import "../../../src/engine/taskTree"`.

- [ ] **Step 3: Write the implementation**

Create `src/engine/taskTree.ts`:

```ts
// A leaf module: no `vscode`, no `fs`, no git, no connector client — the same rule
// engine/brief.ts states in its own header, and for the same reason: any host-side
// caller must be able to depend on this, including ones that must stay free of the
// editor API.

/** One child as a source reports it. Structurally typed rather than imported from a
 *  connector, for the reason `engine/orchestrator/launch.ts` gives about
 *  `LaunchTicketDetail`: the engine must not depend on one connector's client, and
 *  `Capabilities.children.of()` returns a superset that satisfies this as-is. */
export interface ChildLike {
  key: string;
  summary: string;
  statusCategory?: string | null;
}

/** A leaf of the tree: a node with no children of its own, or one sitting on the
 *  depth boundary. `depth` is 1 for a direct child of the root. */
export interface TreeLeaf extends ChildLike {
  depth: number;
  parentKey: string;
}

export interface TreeResult {
  leaves: TreeLeaf[];
  /** Every omission the walk made: a subtree left unexplored (fetch failed or depth
   *  ran out), a key seen twice, a leaf the cap cut. The caller logs and reports
   *  this — nothing is ever dropped silently. */
  dropped: string[];
}

/** Three levels covers epic → story → subtask, which is the deepest shape worth
 *  fanning out. */
export const MAX_TREE_DEPTH = 3;
/** Twenty worktrees is already a lot of git and a lot of sessions; past this the
 *  caller reports the overflow instead of creating it. */
export const MAX_TREE_LEAVES = 20;

export interface TreeLimits {
  maxDepth?: number;
  maxLeaves?: number;
}

/**
 * Walk the tree under `rootKey` breadth-first and return its leaves.
 *
 * Breadth-first rather than depth-first so that when `maxLeaves` truncates, what
 * survives is the shallow, coarse work rather than a single deep branch's tail.
 *
 * The root is never a leaf: a ticket with no children yields `{ leaves: [], dropped:
 * [] }`, which is the caller's signal to behave exactly as it did before this module
 * existed.
 */
export async function buildTree(
  rootKey: string,
  fetch: (key: string) => Promise<ChildLike[]>,
  limits: TreeLimits = {},
): Promise<TreeResult> {
  const maxDepth = limits.maxDepth ?? MAX_TREE_DEPTH;
  const maxLeaves = limits.maxLeaves ?? MAX_TREE_LEAVES;
  const seen = new Set<string>([rootKey]);
  const dropped: string[] = [];
  const leaves: TreeLeaf[] = [];
  let frontier: TreeLeaf[] = [{ key: rootKey, summary: "", depth: 0, parentKey: "" }];

  while (frontier.length) {
    const next: TreeLeaf[] = [];
    for (const node of frontier) {
      // On the boundary: this node is as deep as we go, so it IS the work.
      if (node.depth >= maxDepth) {
        leaves.push(node);
        continue;
      }
      let kids: ChildLike[];
      try {
        kids = await fetch(node.key);
      } catch {
        // One unreadable node must not cost us the rest of the tree. It becomes a
        // leaf (the work is still real) and is reported so the caller can say its
        // subtree went unexplored. The root is exempt: it is the ticket being taken,
        // not a child of it.
        if (node.depth > 0) leaves.push(node);
        dropped.push(node.key);
        continue;
      }
      const fresh: ChildLike[] = [];
      for (const k of kids) {
        // Already seen: a cycle, or a diamond where two parents claim one child.
        // Either way it is walked once and the repeat is reported.
        if (seen.has(k.key)) dropped.push(k.key);
        else fresh.push(k);
      }
      if (!fresh.length) {
        if (node.depth > 0) leaves.push(node);
        continue;
      }
      for (const k of fresh) {
        seen.add(k.key);
        next.push({ ...k, depth: node.depth + 1, parentKey: node.key });
      }
    }
    frontier = next;
  }

  if (leaves.length > maxLeaves) {
    for (const cut of leaves.slice(maxLeaves)) dropped.push(cut.key);
    leaves.length = maxLeaves;
  }
  return { leaves, dropped };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run test/unit/engine/taskTree.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Mutation-check three of them**

One at a time, break the line, run, confirm a FAIL, restore:
1. Change `if (node.depth >= maxDepth)` to `>` — "stops at maxDepth" must fail.
2. Delete the `if (seen.has(k.key)) dropped.push(k.key);` branch (keep `fresh.push`) — "breaks a cycle" must fail.
3. Change `if (node.depth > 0) leaves.push(node);` in the empty-children branch to an unconditional push — "never treats the root itself as a leaf" must fail.

- [ ] **Step 6: Gates + commit**

```bash
npm run typecheck && npm test && npm run build
git add src/engine/taskTree.ts test/unit/engine/taskTree.test.ts
git commit -m "feat(engine): walk a ticket tree into its leaves"
```

---

### Task 2: `baseRef` on worktree creation, and `ensureBranch`

**Files:**
- Modify: `src/engine/worktree.ts`
- Test: `test/unit/engine/worktree.test.ts` (append)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `interface WorktreeOptions { baseRef?: string }`
  - `createWorktrees(services: ServiceRef[], key: string, summary: string, log: (m: string) => void, opts?: WorktreeOptions): ServiceRef[]` — a fifth, optional parameter; the four existing call sites keep their exact argv.
  - `function ensureBranch(repo: string, branch: string, from?: string): boolean`

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/engine/worktree.test.ts`. Add `ensureBranch` to the existing import on line 4:

```ts
import { branchName, createWorktrees, ensureBranch, repoRootOfWorktree } from "../../../src/engine/worktree";
```

Then append these blocks:

```ts
describe("createWorktrees with a baseRef", () => {
  const log = vi.fn();

  beforeEach(() => {
    existsSync.mockReset().mockReturnValue(false);
    mkdirSync.mockReset();
    execFileSync.mockReset();
    gitExcluded.mockReset().mockReturnValue(true);
    log.mockReset();
  });

  it("branches the new worktree off the given ref", () => {
    const [repo] = mkRepos(["webapp"]);
    createWorktrees([repo], "PROJ-2", "child work", log, { baseRef: "PROJ-1-parent" });
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["-C", repo.path, "worktree", "add", "/repos/webapp/.claude/worktrees/PROJ-2",
       "-b", "PROJ-2-child-work", "PROJ-1-parent"],
      expect.anything(),
    );
  });

  it("produces the pre-baseRef argv when the option is omitted", () => {
    const [repo] = mkRepos(["webapp"]);
    createWorktrees([repo], "PROJ-2", "child work", log);
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["-C", repo.path, "worktree", "add", "/repos/webapp/.claude/worktrees/PROJ-2",
       "-b", "PROJ-2-child-work"],
      expect.anything(),
    );
  });

  it("produces the pre-baseRef argv for an empty options object", () => {
    const [repo] = mkRepos(["webapp"]);
    createWorktrees([repo], "PROJ-2", "child work", log, {});
    expect(execFileSync).toHaveBeenLastCalledWith(
      "git",
      ["-C", repo.path, "worktree", "add", "/repos/webapp/.claude/worktrees/PROJ-2",
       "-b", "PROJ-2-child-work"],
      expect.anything(),
    );
  });

  it("drops the baseRef when attaching to a branch that already exists", () => {
    // `worktree add <path> <existing-branch>` takes no start point — passing one
    // would make git read it as a second path argument.
    execFileSync.mockImplementationOnce(() => {
      throw new Error("branch already exists");
    });
    const [repo] = mkRepos(["webapp"]);
    createWorktrees([repo], "PROJ-2", "child work", log, { baseRef: "PROJ-1-parent" });
    expect(execFileSync).toHaveBeenLastCalledWith(
      "git",
      ["-C", repo.path, "worktree", "add", "/repos/webapp/.claude/worktrees/PROJ-2", "PROJ-2-child-work"],
      expect.anything(),
    );
  });
});

describe("ensureBranch", () => {
  beforeEach(() => {
    execFileSync.mockReset();
  });

  it("leaves an existing branch exactly where it is", () => {
    // rev-parse resolves: the branch is there, nothing else runs.
    execFileSync.mockReturnValueOnce(Buffer.from("abc123\n"));
    expect(ensureBranch("/repos/webapp", "PROJ-1-parent")).toBe(true);
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["-C", "/repos/webapp", "rev-parse", "--verify", "--quiet", "refs/heads/PROJ-1-parent"],
      expect.anything(),
    );
  });

  it("creates the branch when it does not exist", () => {
    execFileSync.mockImplementationOnce(() => {
      throw new Error("not a valid ref");
    });
    expect(ensureBranch("/repos/webapp", "PROJ-1-parent")).toBe(true);
    expect(execFileSync).toHaveBeenLastCalledWith(
      "git",
      ["-C", "/repos/webapp", "branch", "PROJ-1-parent"],
      expect.anything(),
    );
  });

  it("creates the branch at an explicit start point", () => {
    execFileSync.mockImplementationOnce(() => {
      throw new Error("not a valid ref");
    });
    ensureBranch("/repos/webapp", "PROJ-1-parent", "origin/main");
    expect(execFileSync).toHaveBeenLastCalledWith(
      "git",
      ["-C", "/repos/webapp", "branch", "PROJ-1-parent", "origin/main"],
      expect.anything(),
    );
  });

  it("returns false when the branch cannot be created", () => {
    const boom = () => {
      throw new Error("boom");
    };
    execFileSync.mockImplementationOnce(boom).mockImplementationOnce(boom);
    expect(ensureBranch("/repos/webapp", "PROJ-1-parent")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/unit/engine/worktree.test.ts`
Expected: FAIL — `ensureBranch` is not exported, and the baseRef argv assertions do not match.

- [ ] **Step 3: Write the implementation**

In `src/engine/worktree.ts`, add the options type above `createWorktrees`:

```ts
export interface WorktreeOptions {
  /** The ref the worktree's new branch starts at. Omitted means git's own default —
   *  the main checkout's HEAD — which is what every caller before child worktrees
   *  relied on, so omitting it must keep their argv byte-identical.
   *
   *  Ignored by the "branch already exists" fallback below: `worktree add <path>
   *  <branch>` takes no start point, and an existing branch already has a history
   *  that a start point could only contradict. */
  baseRef?: string;
}
```

Change the signature and the `-b` call:

```ts
export function createWorktrees(
  services: ServiceRef[],
  key: string,
  summary: string,
  log: (m: string) => void,
  opts: WorktreeOptions = {},
): ServiceRef[] {
```

```ts
      try {
        git(s.path, ["worktree", "add", wtPath, "-b", branch, ...(opts.baseRef ? [opts.baseRef] : [])]);
      } catch {
```

Amend that call's log line so the base is visible in the output channel:

```ts
      log(`worktree ${s.name}: created ${wtPath} on ${branch}${opts.baseRef ? ` (off ${opts.baseRef})` : ""}`);
```

Then add `ensureBranch` below `createWorktrees`:

```ts
/**
 * Make sure `branch` exists in `repo`, creating it at `from` (default: the checkout's
 * current HEAD) when it does not. Returns false when it could not be created — the
 * caller must then refuse, because a child worktree that silently branches off the
 * wrong base looks identical to a correct one until the merge.
 *
 * Idempotent, and deliberately so: several children in one repo each call this before
 * their own worktree, and an existing parent branch must never be moved under work
 * that is already on it. `--quiet` keeps a missing ref off stderr, so an absent branch
 * is an ordinary answer rather than noise in the log.
 */
export function ensureBranch(repo: string, branch: string, from?: string): boolean {
  try {
    git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    /* absent — create it below */
  }
  try {
    git(repo, from ? ["branch", branch, from] : ["branch", branch]);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run test/unit/engine/worktree.test.ts`
Expected: PASS — the 8 new tests plus every pre-existing one, unedited.

- [ ] **Step 5: Mutation-check two of them**

1. Make the spread unconditional (`...[opts.baseRef ?? ""]`) — "produces the pre-baseRef argv when the option is omitted" must fail.
2. Make `ensureBranch` return `true` from the final `catch` — "returns false when the branch cannot be created" must fail.

- [ ] **Step 6: Gates + commit**

```bash
npm run typecheck && npm test && npm run build
git add src/engine/worktree.ts test/unit/engine/worktree.test.ts
git commit -m "feat(engine): branch a worktree off a given base ref"
```

---

### Task 3: The `children` capability on the provider seam

**Files:**
- Modify: `src/tasks/provider.ts`
- Test: `test/unit/tasks/provider.test.ts` (append)

**Files (amended):** this task ALSO creates the `ChildRef` declaration in `src/tasks/jira/client.ts` — see Interfaces.

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface ChildRef { key: string; summary: string; type: string; statusCategory: "new" | "indeterminate" | "done" | null }`, declared in `src/tasks/jira/client.ts` **by this task** (Task 4 adds the method that returns it). It is declared here rather than in Task 4 because every task must end with all four gates green, and a `Capabilities.children` referring to an undeclared type leaves `npm run typecheck` red.
  - `Capabilities.children?: { of(key: string): Promise<ChildRef[]> }`
  - `ChildRef` re-exported from `src/tasks/provider.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/tasks/provider.test.ts`:

```ts
describe("children capability", () => {
  it("is absent on a source with no parent/child concept", () => {
    const caps: Capabilities = { supportedFilters: ["all"], sizes: false };
    expect(caps.children).toBeUndefined();
  });

  it("is callable when present, and answers with child refs", async () => {
    const caps: Capabilities = {
      supportedFilters: ["all"],
      sizes: false,
      children: {
        of: async (key) => [{ key: `${key}-1`, summary: "child", type: "Sub-task", statusCategory: "new" }],
      },
    };
    expect(await caps.children!.of("PROJ-1")).toEqual([
      { key: "PROJ-1-1", summary: "child", type: "Sub-task", statusCategory: "new" },
    ]);
  });

  it("stays out of the webview's serialized caps", () => {
    // Deliberate: nothing in the webview picks children, and the wire shape is
    // asserted with toEqual both here and in tasksView's JIRA_CAPS. A source's tree
    // ability is a host-side fact only.
    const serialized = serializeCaps({
      supportedFilters: ["all"],
      sizes: false,
      children: { of: async () => [] },
    });
    expect(serialized).toEqual({
      supportedFilters: ["all"], sizes: false, labels: false, sprints: false, components: false,
    });
    expect("children" in serialized).toBe(false);
  });
});
```

Add `Capabilities` to that file's type import if it is not already there:

```ts
import type { Capabilities, TaskConnector } from "../../../src/tasks/provider";
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run test/unit/tasks/provider.test.ts`
Expected: FAIL — `Object literal may only specify known properties, and 'children' does not exist in type 'Capabilities'` (a type error surfaces as a failed run under Vitest's esbuild transform only if it is a syntax problem; if the run passes, `npm run typecheck` is the failing gate — check it and treat that failure as this step's expected red).

- [ ] **Step 3: Write the implementation**

First declare the type in `src/tasks/jira/client.ts`, beside `TaskDetail`:

```ts
/** One child of a ticket, one level down. Lives here rather than in `../provider`
 *  for the same reason `TaskDetail` does: the connector owns the shape it produces,
 *  and `provider.ts` re-exports it type-only. */
export interface ChildRef {
  key: string;
  summary: string;
  type: string;
  statusCategory: "new" | "indeterminate" | "done" | null;
}
```

Then in `src/tasks/provider.ts`, extend the existing type import and re-export (currently `provider.ts:10` and `provider.ts:14`):

```ts
import type { ChildRef, TaskDetail } from "./jira/client";
```
```ts
export type { ChildRef, FieldPrompt, Task, TaskDetail };
```

Add to `Capabilities`, below `components`:

```ts
  /** The children of a ticket, ONE level down. The caller recurses (see
   *  `engine/taskTree.ts`) so that a source answers only the question it can answer
   *  cheaply. Absent on a source with no parent/child concept — and that absence is
   *  load-bearing: it is the whole reason Take is unchanged for such a source, so a
   *  connector must omit this rather than supply a stub that answers `[]`. */
  children?: { of(key: string): Promise<ChildRef[]> };
```

Leave `SerializedCaps` and `serializeCaps` untouched — see Spec deviation 1.

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/unit/tasks/provider.test.ts && npm run typecheck`
Expected: PASS both.

- [ ] **Step 5: Gates + commit**

```bash
npm run typecheck && npm test && npm run build
git add src/tasks/provider.ts test/unit/tasks/provider.test.ts
git commit -m "feat(tasks): declare an optional children capability"
```

---

### Task 4: Jira reads one level of children

**Files:**
- Create: `src/tasks/jira/childJql.ts`
- Modify: `src/tasks/jira/client.ts`, `src/tasks/jira/provider.ts`
- Test: `test/unit/tasks/jira/childJql.test.ts` (new), `test/unit/tasks/jira/client.test.ts` (append), `test/unit/tasks/jira/provider.test.ts` (append)

**Interfaces:**
- Consumes: `Capabilities.children` from Task 3.
- Produces:
  - `childrenJql(key: string): string[]`, `jqlKey(key: string): string`
  - `interface ChildRef { key: string; summary: string; type: string; statusCategory: "new" | "indeterminate" | "done" | null }` in `client.ts`
  - `JiraClient.childrenOf(key: string): Promise<ChildRef[]>`
  - `JiraProvider.caps.children`, present only when the client has `childrenOf`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/tasks/jira/childJql.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { childrenJql, jqlKey } from "../../../../src/tasks/jira/childJql";

describe("jqlKey", () => {
  it("passes an ordinary key through", () => {
    expect(jqlKey("PROJ-1234")).toBe("PROJ-1234");
  });

  it("strips the characters that would end the JQL literal early", () => {
    expect(jqlKey('PROJ-1" OR key = "PROJ-2')).toBe("PROJ-1 OR key = PROJ-2");
    expect(jqlKey("PROJ-1\\")).toBe("PROJ-1");
  });
});

describe("childrenJql", () => {
  it("asks `parent` first, then the older Epic Link spelling", () => {
    expect(childrenJql("PROJ-1")).toEqual([
      'parent = "PROJ-1" ORDER BY key ASC',
      '"Epic Link" = "PROJ-1" ORDER BY key ASC',
    ]);
  });

  it("quotes the key through jqlKey", () => {
    expect(childrenJql('PROJ-1"')).toEqual([
      'parent = "PROJ-1" ORDER BY key ASC',
      '"Epic Link" = "PROJ-1" ORDER BY key ASC',
    ]);
  });
});
```

Append to `test/unit/tasks/jira/client.test.ts`. **Read that file's first 60 lines before writing anything** and reuse its own fetch stub, its `client` construction and its request-inspection helpers verbatim — the snippets below give the assertions and the response payloads; the arrangement lines must be that file's, not new ones. `lastRequestBody()` / `jqlsAsked()` below stand for whatever it already calls those things (if it has no such helper, read the recorded `fetch` mock's `mock.calls` directly, the way its existing `fetchTasks` tests do).

```ts
describe("childrenOf", () => {
  it("maps issues to child refs", async () => {
    // Stub one POST to /rest/api/3/search/jql answering with two issues.
    const issues = [
      { key: "PROJ-2", fields: { summary: "one", issuetype: { name: "Sub-task" }, status: { statusCategory: { key: "new" } } } },
      { key: "PROJ-3", fields: { summary: "two", issuetype: { name: "Sub-task" }, status: { statusCategory: { key: "done" } } } },
    ];
    // …arrange with this file's own helper…
    expect(await client.childrenOf("PROJ-1")).toEqual([
      { key: "PROJ-2", summary: "one", type: "Sub-task", statusCategory: "new" },
      { key: "PROJ-3", summary: "two", type: "Sub-task", statusCategory: "done" },
    ]);
  });

  it("asks only for the three fields a child row needs", async () => {
    await client.childrenOf("PROJ-1");
    const body = JSON.parse(lastRequestBody());
    expect(body.fields).toEqual(["summary", "issuetype", "status"]);
    expect(body.jql).toBe('parent = "PROJ-1" ORDER BY key ASC');
  });

  it("falls through to the Epic Link candidate when `parent` answers empty", async () => {
    // First response: { issues: [] }. Second: one issue.
    const out = await client.childrenOf("PROJ-1");
    expect(out.map((c) => c.key)).toEqual(["PROJ-9"]);
    expect(jqlsAsked()).toEqual([
      'parent = "PROJ-1" ORDER BY key ASC',
      '"Epic Link" = "PROJ-1" ORDER BY key ASC',
    ]);
  });

  it("returns [] when every candidate answers empty", async () => {
    expect(await client.childrenOf("PROJ-1")).toEqual([]);
  });

  it("moves to the next candidate when one is rejected, and throws only if all fail", async () => {
    // Both responses 400.
    await expect(client.childrenOf("PROJ-1")).rejects.toThrow();
  });

  it("rethrows an auth failure immediately instead of trying the next candidate", async () => {
    // First response 401.
    await expect(client.childrenOf("PROJ-1")).rejects.toBeInstanceOf(JiraAuthError);
    expect(jqlsAsked()).toHaveLength(1);
  });

  it("tolerates an issue with no summary, type or status", async () => {
    // One issue: { key: "PROJ-4" } with no `fields` at all.
    expect(await client.childrenOf("PROJ-1")).toEqual([
      { key: "PROJ-4", summary: "", type: "", statusCategory: null },
    ]);
  });
});
```

Append to `test/unit/tasks/jira/provider.test.ts`:

```ts
describe("caps.children", () => {
  it("is present and delegates to the client when the client can answer", async () => {
    const childrenOf = vi.fn(async () => [
      { key: "PROJ-2", summary: "child", type: "Sub-task", statusCategory: "new" as const },
    ]);
    const provider = new JiraProvider({ ...clientStub, childrenOf } as never);
    expect(await provider.caps.children!.of("PROJ-1")).toEqual([
      { key: "PROJ-2", summary: "child", type: "Sub-task", statusCategory: "new" },
    ]);
    expect(childrenOf).toHaveBeenCalledWith("PROJ-1");
  });

  it("is absent when the client has no childrenOf — a partial client must not claim the capability", () => {
    const { childrenOf: _omit, ...withoutChildren } = { ...clientStub, childrenOf: vi.fn() };
    const provider = new JiraProvider(withoutChildren as never);
    expect(provider.caps.children).toBeUndefined();
  });
});
```

Build `clientStub` the way the rest of that file does; if it has no shared stub, construct a minimal object literal with the members `caps` reads (`shapeSnapshot`, `addLabel`, `listComponents`, `updateComponents`).

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/unit/tasks/jira`
Expected: FAIL — `childJql` module missing, `client.childrenOf is not a function`, `caps.children` undefined in the delegating test.

- [ ] **Step 3: Write the implementation**

Create `src/tasks/jira/childJql.ts`:

```ts
// Pure, and imports nothing — the same contract `jql.ts` keeps, so the candidate
// ladder can be asserted without a client, a site or an auth header.

/** A ticket key as a JQL string literal. Keys are `[A-Z][A-Z0-9_]*-\d+` in practice,
 *  but the value reaches us from a webview message and a stored run record, so the
 *  two characters that could end the literal early are removed rather than trusted. */
export function jqlKey(key: string): string {
  return key.replace(/["\\]/g, "");
}

/** Candidate JQL for "the children of `key`", most modern spelling first.
 *
 *  `parent` covers sub-tasks AND epic children on current Jira Cloud. `"Epic Link"`
 *  is the older company-managed spelling and covers epic children only. The caller
 *  takes the FIRST candidate that answers with a non-empty list — not merely the
 *  first that does not error — because on a site where `parent` is valid but models
 *  nothing, an empty answer is indistinguishable from "no children" and would hide a
 *  populated epic. */
export function childrenJql(key: string): string[] {
  const k = jqlKey(key);
  return [`parent = "${k}" ORDER BY key ASC`, `"Epic Link" = "${k}" ORDER BY key ASC`];
}
```

In `src/tasks/jira/client.ts`, import the builder next to the existing `./jql` import:

```ts
import { childrenJql } from "./childJql";
```

Add the field list beside `DETAIL_FIELDS`:

```ts
/** All a child row needs: what to call it, what kind it is, whether it is already
 *  done. Deliberately narrower than LIST_FIELDS — a tree probe runs once per node. */
const CHILD_FIELDS = ["summary", "issuetype", "status"];
```

`ChildRef` is already declared in this file by Task 3 — do not redeclare it.

Add the method to `JiraClient`, below `getDetail`:

```ts
  /** The children of one issue, one level down. The first candidate JQL with a
   *  non-empty answer wins (see `childrenJql` for why non-empty and not merely
   *  non-failing); a rejected candidate moves to the next; every candidate answering
   *  empty means "no children", which is the common case and not an error. */
  async childrenOf(key: string): Promise<ChildRef[]> {
    let lastErr: unknown;
    for (const jql of childrenJql(key)) {
      try {
        const data = await this.searchJql(jql, CHILD_FIELDS, 100);
        const kids: ChildRef[] = (data?.issues ?? []).map((i: any) => ({
          key: i.key,
          summary: i.fields?.summary ?? "",
          type: i.fields?.issuetype?.name ?? "",
          // Same boundary cast `normalize` documents: a real site's category key is
          // not guaranteed to be one of the three the union names.
          statusCategory: (i.fields?.status?.statusCategory?.key ?? null) as ChildRef["statusCategory"],
        }));
        if (kids.length) return kids;
      } catch (e) {
        if (e instanceof JiraAuthError) throw e;
        lastErr = e;
      }
    }
    if (lastErr) throw lastErr;
    return [];
  }
```

In `src/tasks/jira/provider.ts`, add to the `caps` getter's returned object, after `components`:

```ts
      // Guarded on the method existing rather than declared unconditionally: the
      // wholesale client mock in test/unit/tasksView.test.ts has no `childrenOf`, and
      // a capability that claims to answer but throws on the first call would turn
      // every Take there into the degraded path. Same defensive shape as
      // `this.client.shapeSnapshot?.()` above.
      ...(typeof this.client.childrenOf === "function"
        ? { children: { of: (key: string) => this.client.childrenOf(key) } }
        : {}),
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run test/unit/tasks && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Mutation-check two**

1. Change `if (kids.length) return kids;` to `return kids;` — "falls through to the Epic Link candidate when `parent` answers empty" must fail.
2. Drop the `typeof … === "function"` guard — "is absent when the client has no childrenOf" must fail.

- [ ] **Step 6: Gates + commit**

```bash
npm run typecheck && npm test && npm run build
git add src/tasks/jira/childJql.ts src/tasks/jira/client.ts src/tasks/jira/provider.ts test/unit/tasks
git commit -m "feat(jira): read one level of a ticket's children"
```

---

### Task 5: The Children section in the orchestrator brief

**Files:**
- Modify: `src/engine/brief.ts`
- Test: `test/unit/engine/brief.test.ts` (append)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface BriefChild { key: string; summary: string; path: string; branch: string }`
  - `briefMarkdown(detail, agentName?, orchestration?: { children: readonly BriefChild[]; parentBranch: string }): string`

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/engine/brief.test.ts`:

```ts
describe("briefMarkdown with children", () => {
  const detail = { key: "PROJ-1", summary: "parent work", descriptionText: "do the thing" };
  const children = [
    { key: "PROJ-2", summary: "first bit", path: ".claude/worktrees/PROJ-2", branch: "PROJ-2-first-bit" },
    { key: "PROJ-3", summary: "second bit", path: ".claude/worktrees/PROJ-3", branch: "PROJ-3-second-bit" },
  ];

  it("is byte-identical to the childless brief when no orchestration is passed", () => {
    expect(briefMarkdown(detail, "Claude Code")).toBe(briefMarkdown(detail, "Claude Code", undefined));
  });

  it("adds nothing for an empty child list", () => {
    expect(briefMarkdown(detail, "Claude Code", { children: [], parentBranch: "PROJ-1-parent-work" }))
      .toBe(briefMarkdown(detail, "Claude Code"));
  });

  it("renders a row per child", () => {
    const md = briefMarkdown(detail, "Claude Code", { children, parentBranch: "PROJ-1-parent-work" });
    expect(md).toContain("## Children — one subagent each");
    expect(md).toContain("| Ticket | Summary | Worktree | Branch |");
    expect(md).toContain("| PROJ-2 | first bit | `.claude/worktrees/PROJ-2` | `PROJ-2-first-bit` |");
    expect(md).toContain("| PROJ-3 | second bit | `.claude/worktrees/PROJ-3` | `PROJ-3-second-bit` |");
  });

  it("names the parent branch as the merge target", () => {
    const md = briefMarkdown(detail, "Claude Code", { children, parentBranch: "PROJ-1-parent-work" });
    expect(md).toContain("Merge finished children into `PROJ-1-parent-work`; never into main.");
  });

  it("escapes a pipe in a summary so the table survives it", () => {
    const md = briefMarkdown(detail, "Claude Code", {
      children: [{ key: "PROJ-4", summary: "a | b", path: "p", branch: "br" }],
      parentBranch: "PROJ-1-parent-work",
    });
    expect(md).toContain("| PROJ-4 | a \\| b | `p` | `br` |");
  });

  it("keeps the ticket description above the children", () => {
    const md = briefMarkdown(detail, "Claude Code", { children, parentBranch: "PROJ-1-parent-work" });
    expect(md.indexOf("do the thing")).toBeLessThan(md.indexOf("## Children"));
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/unit/engine/brief.test.ts`
Expected: FAIL — "renders a row per child" cannot find the heading (the third argument is ignored).

- [ ] **Step 3: Write the implementation**

Replace the body of `src/engine/brief.ts`'s `briefMarkdown` and add the type:

```ts
/** One child worktree, as the parent's brief names it. `path` is what the agent
 *  should `cd` into — the caller decides whether that is absolute or repo-relative,
 *  because only the caller knows how many repos the run spans. */
export interface BriefChild {
  key: string;
  summary: string;
  path: string;
  branch: string;
}

export interface BriefOrchestration {
  children: readonly BriefChild[];
  /** The branch every child merges into. Named in the brief because "not main" is
   *  the one instruction a subagent cannot infer from its own worktree. */
  parentBranch: string;
}
```

```ts
export function briefMarkdown(
  detail: { key: string; summary: string; descriptionText: string },
  agentName = "Claude Code",
  orchestration?: BriefOrchestration,
): string {
  const desc = detail.descriptionText?.trim();
  const body = desc ? `## Ticket description\n\n${desc}` : "_(No description on the ticket.)_";
  const base = `## ${detail.key}: ${detail.summary}\n\n${body}\n\n## Plan\n\n_The ${agentName} prompt for this task says whether to plan first or implement._`;
  // Absent or empty children must leave the brief byte-identical: every existing
  // caller passes nothing, and the two paths have to read the same for a run that
  // has no tree under it.
  if (!orchestration?.children.length) return base;
  const rows = orchestration.children
    .map((c) => `| ${c.key} | ${cell(c.summary)} | \`${c.path}\` | \`${c.branch}\` |`)
    .join("\n");
  return `${base}

## Children — one subagent each

| Ticket | Summary | Worktree | Branch |
|---|---|---|---|
${rows}

Dispatch one subagent per row. Each works ONLY inside its worktree path.
Merge finished children into \`${orchestration.parentBranch}\`; never into main.`;
}

/** A summary safe to drop in a markdown table cell: an unescaped pipe would end the
 *  cell early and shift every column after it. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run test/unit/engine/brief.test.ts`
Expected: PASS — new tests plus the existing ones, unedited.

- [ ] **Step 5: Mutation-check one**

Change the guard to `if (!orchestration) return base;` — "adds nothing for an empty child list" must fail.

- [ ] **Step 6: Gates + commit**

```bash
npm run typecheck && npm test && npm run build
git add src/engine/brief.ts test/unit/engine/brief.test.ts
git commit -m "feat(engine): name child worktrees in the parent's brief"
```

---

### Task 6: Runs remember their parent and their children

**Files:**
- Modify: `src/types.ts`, `src/engine/workspace.ts`, `src/engine/batchWorkspace.ts`
- Test: `test/unit/engine/workspace.test.ts` (append), `test/unit/engine/batchWorkspace.test.ts` (append)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `Run.parentKey?: string`
  - `Run.children?: { key: string; summary: string; repo: string; path: string; branch: string }[]`
  - `OpenRequest.parentKey?: string`, `OpenRequest.children?: Run["children"]`
  - `BatchTask.parentKey?: string`

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/engine/workspace.test.ts`, following that file's existing `openWorkspace` arrangement and its run-record assertion helper:

```ts
describe("openWorkspace: parent and children on the run record", () => {
  it("omits both fields when the request carries neither", async () => {
    await openWorkspace(baseRequest());
    const run = lastWrittenRun();
    expect("parentKey" in run).toBe(false);
    expect("children" in run).toBe(false);
  });

  it("stamps parentKey when the take came from a parent's tree", async () => {
    await openWorkspace({ ...baseRequest(), parentKey: "PROJ-1" });
    expect(lastWrittenRun().parentKey).toBe("PROJ-1");
  });

  it("stores the child worktrees an orchestrator run owns", async () => {
    const children = [
      { key: "PROJ-2", summary: "first", repo: "webapp", path: "/repos/webapp/.claude/worktrees/PROJ-2", branch: "PROJ-2-first" },
    ];
    await openWorkspace({ ...baseRequest(), children });
    expect(lastWrittenRun().children).toEqual(children);
  });

  it("omits an empty children array rather than storing one", async () => {
    await openWorkspace({ ...baseRequest(), children: [] });
    expect("children" in lastWrittenRun()).toBe(false);
  });
});
```

Append to `test/unit/engine/batchWorkspace.test.ts`:

```ts
describe("openSharedWorkspace: parentKey on each run", () => {
  it("stamps the parentKey a batch task carries", async () => {
    await openSharedWorkspace(sharedRequestWith([
      { ...task("PROJ-2"), parentKey: "PROJ-1" },
    ]));
    expect(lastWrittenRun().parentKey).toBe("PROJ-1");
  });

  it("omits the field for an ordinary batch", async () => {
    await openSharedWorkspace(sharedRequestWith([task("PROJ-2")]));
    expect("parentKey" in lastWrittenRun()).toBe(false);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run test/unit/engine/workspace.test.ts test/unit/engine/batchWorkspace.test.ts`
Expected: FAIL — unknown properties on the request objects and `undefined` where `parentKey` was expected.

- [ ] **Step 3: Write the implementation**

In `src/types.ts`, inside `Run` (after `briefPaths`):

```ts
  /** The parent ticket this run was taken under, when it came out of a parent's tree
   *  rather than on its own. Absent on every run taken by itself, and on every record
   *  written before child takes existed. */
  parentKey?: string;
  /** The child worktrees this run owns — set only for an orchestrator-mode take, where
   *  one session dispatches a subagent per child. Each row is a real worktree on disk;
   *  the children are NOT runs of their own, which is why they live here rather than as
   *  separate records. */
  children?: { key: string; summary: string; repo: string; path: string; branch: string }[];
```

In `src/engine/workspace.ts`, add to `OpenRequest`:

```ts
  /** Stamped onto the run record verbatim; see `Run.parentKey`. */
  parentKey?: string;
  /** Stamped onto the run record verbatim; see `Run.children`. An empty array is
   *  stored as absent, so "no children" has exactly one representation. */
  children?: Run["children"];
```

and in the run literal (`workspace.ts:414`), after `briefPaths`:

```ts
      ...(req.parentKey ? { parentKey: req.parentKey } : {}),
      ...(req.children?.length ? { children: req.children } : {}),
```

In `src/engine/batchWorkspace.ts`, add to `BatchTask`:

```ts
  /** The parent ticket this task was fanned out from, when it was. Reaches the run
   *  record unchanged; see `Run.parentKey`. */
  parentKey?: string;
```

and in its run literal (`batchWorkspace.ts:181`), after `briefPaths`:

```ts
      ...(t.parentKey ? { parentKey: t.parentKey } : {}),
```

- [ ] **Step 4: Run and watch them pass**

Run: `npx vitest run test/unit/engine && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Mutation-check one**

Change the workspace spread to `parentKey: req.parentKey` unconditionally — "omits both fields when the request carries neither" must fail.

- [ ] **Step 6: Gates + commit**

```bash
npm run typecheck && npm test && npm run build
git add src/types.ts src/engine/workspace.ts src/engine/batchWorkspace.ts test/unit/engine
git commit -m "feat(engine): record a run's parent ticket and child worktrees"
```

---

### Task 7: Take probes the tree, asks twice, and fans out

**Files:**
- Modify: `src/tasksView.ts`
- Test: `test/unit/tasksView.test.ts` (append)

**Interfaces:**
- Consumes: `buildTree`, `TreeLeaf`, `TreeResult` (Task 1); `ensureBranch`, `WorktreeOptions` (Task 2); `caps.children` (Tasks 3–4); `BatchTask.parentKey` (Task 6).
- Produces:
  - `private async probeTree(key: string): Promise<{ detail: TaskDetail; tree: TreeResult } | null>`
  - `private async chooseTreeMode(key: string, leafCount: number): Promise<"fanout" | "orchestrator" | "parent" | undefined>`
  - `private async chooseLeaves(leaves: TreeLeaf[]): Promise<TreeLeaf[] | undefined>`
  - `public async takeBatch(keys: string[], repos: string[], parent?: { key: string; branch: string }): Promise<void>`
  - `private async takeOrchestrated(...)` — declared here, implemented in Task 8. In this task, route to it behind a `this.log` line and a TODO-free stub that throws `new Error("orchestrator mode not wired yet")`; Task 8 replaces the body. Keep the stub unreachable in tests by only asserting the fan-out route here.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/tasksView.test.ts`. Reuse that file's `setup()`, `clientStub` and `getConfig` mock; add `childrenOf` to the client stub **inside these tests only** (a local `clientStub.childrenOf = vi.fn(...)`), so every existing Take test keeps a client without the method and therefore a provider without the capability:

```ts
describe("takeTask: a ticket with children", () => {
  const tree = {
    "PROJ-1": [{ key: "PROJ-2", summary: "first bit", type: "Sub-task", statusCategory: "new" }],
  } as Record<string, { key: string; summary: string; type: string; statusCategory: string }[]>;

  beforeEach(() => {
    clientStub.childrenOf = vi.fn(async (key: string) => tree[key] ?? []);
  });

  it("does not probe at all when the source has no children capability", async () => {
    delete (clientStub as { childrenOf?: unknown }).childrenOf;
    const { view } = setup({ authed: true });
    await view.takeTask("PROJ-1", "card");
    // The old flow: prompt mode asked, no tree pickers.
    expect(quickPickTitles()).not.toContain(expect.stringContaining("how do you want to work them"));
  });

  it("asks how to work the leaves when there are some", async () => {
    const { view } = setup({ authed: true });
    answerQuickPick("cancel"); // bail at the mode picker
    await view.takeTask("PROJ-1", "card");
    expect(quickPickTitles()).toContain("PROJ-1 — 1 leaf under it. How do you want to work them?");
  });

  it("takes nothing when the mode picker is cancelled", async () => {
    const { view } = setup({ authed: true });
    answerQuickPick("cancel");
    await view.takeTask("PROJ-1", "card");
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("pre-selects nothing in the leaf picker", async () => {
    const { view } = setup({ authed: true });
    answerQuickPick({ label: "A session per child" });
    answerQuickPick("cancel");
    await view.takeTask("PROJ-1", "card");
    const items = lastQuickPickItems();
    expect(items.every((i) => !i.picked)).toBe(true);
    expect(items[0].label).toBe("PROJ-2 — first bit");
  });

  it("falls back to the ordinary single take when no leaf is selected", async () => {
    const { view } = setup({ authed: true });
    answerQuickPick({ label: "A session per child" });
    answerQuickPick([]); // picked nothing
    await view.takeTask("PROJ-1", "card");
    expect(takeBatchSpy).not.toHaveBeenCalled();
    expect(openWorkspaceMock).toHaveBeenCalled(); // the plain path ran
  });

  it("routes fan-out into takeBatch with the parent branch as the base", async () => {
    const { view } = setup({ authed: true });
    answerQuickPick({ label: "A session per child" });
    answerQuickPick([{ label: "PROJ-2 — first bit" }]);
    await view.takeTask("PROJ-1", "card");
    expect(takeBatchSpy).toHaveBeenCalledWith(["PROJ-2"], [], {
      key: "PROJ-1",
      branch: "PROJ-1-summary-of-proj-1", // whatever branchName(detail) yields for the stub
    });
  });

  it("degrades to the ordinary take when the children fetch fails", async () => {
    clientStub.childrenOf = vi.fn(async () => {
      throw new Error("500");
    });
    const { view } = setup({ authed: true });
    await view.takeTask("PROJ-1", "card");
    expect(takeBatchSpy).not.toHaveBeenCalled();
    expect(openWorkspaceMock).toHaveBeenCalled();
  });

  it("logs what the tree dropped", async () => {
    clientStub.childrenOf = vi.fn(async (key: string) =>
      key === "PROJ-1"
        ? Array.from({ length: 25 }, (_, i) => ({ key: `K-${i}`, summary: "x", type: "Sub-task", statusCategory: "new" }))
        : [],
    );
    const { view, logLines } = setup({ authed: true });
    answerQuickPick({ label: "A session per child" });
    answerQuickPick([{ label: "K-0 — x" }]);
    await view.takeTask("PROJ-1", "card");
    expect(logLines().join("\n")).toContain("dropped 5");
  });
});

describe("takeBatch with a parent", () => {
  it("makes the parent branch before the child worktree, then branches off it", async () => {
    const { view } = setup({ authed: true });
    await view.takeBatch(["PROJ-2"], [], { key: "PROJ-1", branch: "PROJ-1-parent" });
    expect(ensureBranchMock).toHaveBeenCalledWith(expect.any(String), "PROJ-1-parent");
    expect(createWorktreesMock).toHaveBeenCalledWith(
      expect.anything(), "PROJ-2", expect.any(String), expect.any(Function), { baseRef: "PROJ-1-parent" },
    );
  });

  it("fails that child rather than branching off main when the parent branch cannot be made", async () => {
    ensureBranchMock.mockReturnValue(false);
    const { view, toasts } = setup({ authed: true });
    await view.takeBatch(["PROJ-2"], [], { key: "PROJ-1", branch: "PROJ-1-parent" });
    expect(createWorktreesMock).not.toHaveBeenCalled();
    expect(toasts().join("\n")).toContain("PROJ-1-parent");
  });

  it("stamps parentKey on the batch task", async () => {
    const { view } = setup({ authed: true });
    await view.takeBatch(["PROJ-2"], [], { key: "PROJ-1", branch: "PROJ-1-parent" });
    const task = openSharedWorkspaceMock.mock.calls[0][0].tasks[0];
    expect(task.parentKey).toBe("PROJ-1");
  });

  it("passes an empty options object when there is no parent", async () => {
    const { view } = setup({ authed: true });
    await view.takeBatch(["PROJ-2"], []);
    expect(ensureBranchMock).not.toHaveBeenCalled();
    expect(createWorktreesMock).toHaveBeenCalledWith(
      expect.anything(), "PROJ-2", expect.any(String), expect.any(Function), {},
    );
  });
});
```

**The parent-branch literal.** `"PROJ-1-summary-of-proj-1"` in these tests (and in Task 8's) is a stand-in: the real value is `branchName("PROJ-1", <the summary this file's ticket fixture actually carries>)`. Compute it in the test from `branchName` and the fixture, or read the fixture and write the true slug — never hardcode a guessed one.

Names like `answerQuickPick`, `lastQuickPickItems`, `quickPickTitles`, `takeBatchSpy`, `ensureBranchMock`, `createWorktreesMock`, `openSharedWorkspaceMock`, `toasts`, `logLines` must be wired to whatever that file already uses for the same jobs — read its top 260 lines and reuse its helpers verbatim rather than adding parallel ones. `createWorktrees`/`ensureBranch` are imported values in `tasksView.ts`, so mock the module (`vi.mock("../../src/engine/worktree")`) the way the file already mocks `../../src/engine/workspace`.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run test/unit/tasksView.test.ts`
Expected: FAIL — no tree pickers appear, `takeBatch` rejects a third argument.

- [ ] **Step 3: Write the implementation**

Add imports to `src/tasksView.ts`:

```ts
import { branchName, createWorktrees, ensureBranch, repoRootOfWorktree } from "./engine/worktree";
import { buildTree, TreeLeaf, TreeResult } from "./engine/taskTree";
```

Add the three helpers near `reposForTask`:

```ts
  /** The leaves under `key`, with the detail the probe already had to fetch.
   *
   *  `null` means "behave exactly as Take did before trees existed": this source has
   *  no children concept, or the probe failed. Never throws and never blocks the take
   *  — a tree is an offer, and the ticket must stay takeable when the offer cannot be
   *  made. The `detail` comes back because the parent's branch name needs its summary;
   *  the ordinary path fetches its own again, which is one extra read on a path that
   *  is already several. */
  private async probeTree(key: string): Promise<{ detail: TaskDetail; tree: TreeResult } | null> {
    const children = this.provider().caps.children;
    if (!children) return null;
    try {
      const detail = await this.provider().detail(key);
      const tree = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Looking for work under ${key}…` },
        () => buildTree(key, (k) => children.of(k)),
      );
      return { detail, tree };
    } catch (e) {
      this.log(`probeTree ${key}: failed (${e}) — taking the ticket on its own`);
      return null;
    }
  }

  /** How to work the leaves. `undefined` is a cancel; "parent" is today's behavior,
   *  and doubles as the integrate-later path once the children have landed. */
  private async chooseTreeMode(
    key: string,
    leafCount: number,
  ): Promise<"fanout" | "orchestrator" | "parent" | undefined> {
    const p = await vscode.window.showQuickPick(
      [
        { label: "A session per child", detail: `${leafCount} worktrees, ${leafCount} sessions, each on its own branch`, mode: "fanout" as const },
        { label: "One orchestrator session, children as subagents", detail: `1 session in ${key}, ${leafCount} child worktrees for it to dispatch into`, mode: "orchestrator" as const },
        { label: `Just ${key}`, detail: "One worktree for the parent, as before", mode: "parent" as const },
      ],
      { title: `${key} — ${leafCount} ${leafCount === 1 ? "leaf" : "leaves"} under it. How do you want to work them?`, ignoreFocusOut: true },
    );
    return p?.mode;
  }

  /** Which leaves to take. Nothing is pre-picked: a tree can be large, and every
   *  ticked row costs a worktree and a session. `undefined` is a cancel; an empty
   *  array is a deliberate "none of them", which the caller treats as "just the
   *  parent". */
  private async chooseLeaves(leaves: TreeLeaf[]): Promise<TreeLeaf[] | undefined> {
    const picked = await vscode.window.showQuickPick(
      leaves.map((l) => ({
        label: `${l.key} — ${l.summary}`,
        description: l.statusCategory === "done" ? "done" : undefined,
        detail: `${l.parentKey} › ${l.key}`,
        leaf: l,
      })),
      { title: "Which of these do you want to take?", canPickMany: true, ignoreFocusOut: true },
    );
    return picked?.map((p) => p.leaf);
  }
```

In `takeTask`, immediately after the `remoteControlBlocksLaunch` guard and **before** `startFlow()` — so a take that turns into a fan-out reports through `takeBatch`'s own telemetry rather than opening a funnel it never closes:

```ts
    // A ticket with children is a different question from a ticket without them, and
    // it has to be asked before anything else: fan-out hands the whole take to
    // takeBatch, which asks its own prompt-mode and destination questions.
    const probed = await this.probeTree(key);
    if (probed?.tree.leaves.length) {
      const mode = await this.chooseTreeMode(key, probed.tree.leaves.length);
      if (!mode) return;
      if (mode !== "parent") {
        const picked = await this.chooseLeaves(probed.tree.leaves);
        if (!picked) return;
        if (picked.length) {
          if (probed.tree.dropped.length) {
            this.log(`takeTask ${key}: tree dropped ${probed.tree.dropped.length} (${probed.tree.dropped.join(", ")})`);
          }
          const parent = { key, branch: branchName(key, probed.detail.summary) };
          if (mode === "fanout") {
            await this.takeBatch(picked.map((l) => l.key), [], parent);
          } else {
            await this.takeOrchestrated(probed.detail, picked, parent.branch);
          }
          return;
        }
      }
    }
```

Change `takeBatch`'s signature and its worktree block:

```ts
  public async takeBatch(
    keys: string[],
    repos: string[],
    parent?: { key: string; branch: string },
  ): Promise<void> {
```

```ts
        const wanted = this.reposForTask(detail, filterSet);
        // A child branches off its parent's branch, so that branch must exist first —
        // in every repo this child is about to open. ensureBranch is idempotent, so
        // children sharing a repo cost one rev-parse each.
        if (parent) {
          const noBranch = wanted.filter((r) => !ensureBranch(r.path, parent.branch));
          if (noBranch.length) {
            throw new Error(
              `couldn't create the parent branch ${parent.branch} in ${noBranch.map((r) => r.name).join(", ")}`,
            );
          }
        }
        const services = createWorktrees(
          wanted, detail.key, detail.summary, this.log, parent ? { baseRef: parent.branch } : {},
        );
```

and stamp the task:

```ts
          task: {
            ticket: { key: detail.key, summary: detail.summary, url: detail.url },
            planMd: briefMarkdown(detail, providerLabel(cfg.agentProvider)),
            descriptionText: detail.descriptionText,
            services,
            ...(parent ? { parentKey: parent.key } : {}),
          },
```

Add the stub `takeOrchestrated` that Task 8 fills in:

```ts
  /** Orchestrator-mode take: implemented in the next task. */
  private async takeOrchestrated(
    _detail: TaskDetail,
    _leaves: TreeLeaf[],
    _parentBranch: string,
  ): Promise<void> {
    throw new Error("orchestrator mode not wired yet");
  }
```

Also thread `parentKey` through the separate-windows batch path: wherever `takeBatch` calls `openWorkspace` per task, pass `parentKey: parent?.key` — grep that function for its non-shared branch and add the field with the same `...(parent ? … : {})` spread so the request is unchanged without a parent.

- [ ] **Step 4: Run and watch them pass**

Run: `npx vitest run test/unit/tasksView.test.ts && npm run typecheck`
Expected: PASS — new tests plus every existing Take test, unedited.

- [ ] **Step 5: Mutation-check three**

1. Pre-select every leaf (`picked: true`) — "pre-selects nothing in the leaf picker" must fail.
2. Make `probeTree`'s catch rethrow — "degrades to the ordinary take when the children fetch fails" must fail.
3. Drop the `if (noBranch.length) throw` block — "fails that child rather than branching off main" must fail.

- [ ] **Step 6: Gates + commit**

```bash
npm run typecheck && npm test && npm run build
git add src/tasksView.ts test/unit/tasksView.test.ts
git commit -m "feat(tasks): fan a parent's leaves out into their own worktrees"
```

---

### Task 8: Orchestrator mode

**Files:**
- Modify: `src/tasksView.ts`
- Test: `test/unit/tasksView.test.ts` (append)

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces: a real `takeOrchestrated(detail: TaskDetail, leaves: TreeLeaf[], parentBranch: string): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/tasksView.test.ts`:

```ts
describe("takeTask: orchestrator mode", () => {
  beforeEach(() => {
    clientStub.childrenOf = vi.fn(async (key: string) =>
      key === "PROJ-1"
        ? [{ key: "PROJ-2", summary: "first bit", type: "Sub-task", statusCategory: "new" },
           { key: "PROJ-3", summary: "second bit", type: "Sub-task", statusCategory: "new" }]
        : [],
    );
  });

  async function takeOrchestrated(pick: string[] = ["PROJ-2 — first bit", "PROJ-3 — second bit"]) {
    const { view, ...rest } = setup({ authed: true });
    answerQuickPick({ label: "One orchestrator session, children as subagents" });
    answerQuickPick(pick.map((label) => ({ label })));
    await view.takeTask("PROJ-1", "card");
    return rest;
  }

  it("creates one worktree per selected leaf, each off the parent branch", async () => {
    await takeOrchestrated();
    expect(createWorktreesMock).toHaveBeenCalledWith(
      expect.anything(), "PROJ-2", "first bit", expect.any(Function), { baseRef: "PROJ-1-summary-of-proj-1" },
    );
    expect(createWorktreesMock).toHaveBeenCalledWith(
      expect.anything(), "PROJ-3", "second bit", expect.any(Function), { baseRef: "PROJ-1-summary-of-proj-1" },
    );
  });

  it("makes the parent branch before any child worktree", async () => {
    await takeOrchestrated();
    expect(ensureBranchMock.mock.invocationCallOrder[0])
      .toBeLessThan(createWorktreesMock.mock.invocationCallOrder[0]);
  });

  it("opens exactly one session, on the parent", async () => {
    await takeOrchestrated();
    const calls = openWorkspaceMock.mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0].ticket.key).toBe("PROJ-1");
  });

  it("names every child worktree in the parent's brief", async () => {
    await takeOrchestrated();
    const { planMd } = openWorkspaceMock.mock.calls[0][0];
    expect(planMd).toContain("## Children — one subagent each");
    expect(planMd).toContain("| PROJ-2 | first bit |");
    expect(planMd).toContain("| PROJ-3 | second bit |");
    expect(planMd).toContain("Merge finished children into `PROJ-1-summary-of-proj-1`");
  });

  it("records the child worktrees on the parent's run", async () => {
    await takeOrchestrated();
    const { children } = openWorkspaceMock.mock.calls[0][0];
    expect(children).toEqual([
      expect.objectContaining({ key: "PROJ-2", branch: "PROJ-2-first-bit" }),
      expect.objectContaining({ key: "PROJ-3", branch: "PROJ-3-second-bit" }),
    ]);
  });

  it("writes a brief into each child worktree from that child's own detail", async () => {
    await takeOrchestrated();
    const written = writeFileSyncMock.mock.calls.map(([p]) => String(p));
    expect(written.some((p) => p.includes("PROJ-2") && p.endsWith(".pick-task/TASK.md"))).toBe(true);
    expect(written.some((p) => p.includes("PROJ-3") && p.endsWith(".pick-task/TASK.md"))).toBe(true);
  });

  it("skips a child whose worktree could not be made, and says so", async () => {
    // createWorktrees returns the input ref → creation failed for PROJ-3.
    createWorktreesMock.mockImplementation((services, key) =>
      key === "PROJ-3" ? services : services.map((s: ServiceRef) => ({ ...s, path: `${s.path}/.claude/worktrees/${key}` })),
    );
    const { toasts } = await takeOrchestrated();
    const { children } = openWorkspaceMock.mock.calls[0][0];
    expect(children.map((c: { key: string }) => c.key)).toEqual(["PROJ-2"]);
    expect(toasts().join("\n")).toContain("PROJ-3");
  });

  it("refuses the whole take when the parent branch cannot be made", async () => {
    ensureBranchMock.mockReturnValue(false);
    const { toasts } = await takeOrchestrated();
    expect(createWorktreesMock).not.toHaveBeenCalled();
    expect(openWorkspaceMock).not.toHaveBeenCalled();
    expect(toasts().join("\n")).toContain("PROJ-1-summary-of-proj-1");
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run test/unit/tasksView.test.ts -t "orchestrator mode"`
Expected: FAIL — `orchestrator mode not wired yet`.

- [ ] **Step 3: Write the implementation**

Replace the stub in `src/tasksView.ts`:

```ts
  /**
   * Orchestrator-mode take: one session in the parent's worktree, one worktree per
   * selected leaf for it to dispatch a subagent into.
   *
   * The children get worktrees in the PARENT's resolved repo set, not in their own.
   * An orchestrator can only dispatch into directories its own window can see, and a
   * child's repos are its own ticket's inference — following those would scatter
   * worktrees across repos this session never opens. A child that names something
   * outside the set is said out loud rather than silently narrowed.
   */
  private async takeOrchestrated(
    detail: TaskDetail,
    leaves: TreeLeaf[],
    parentBranch: string,
  ): Promise<void> {
    const cfg = getConfig();
    const resolved = await this.resolveKickoff(detail.key, undefined);
    if (!resolved) return;
    const { services: parentRepos, target } = resolved;

    // The parent branch is the base every child branches off. Without it in a repo,
    // a child worktree there would silently start from main — refuse instead.
    const noBranch = parentRepos.filter((r) => r.isGit && !ensureBranch(r.path, parentBranch));
    if (noBranch.length) {
      this.toast(
        "error",
        `Couldn't create the parent branch ${parentBranch} in ${noBranch.map((r) => r.name).join(", ")} — nothing was taken.`,
      );
      return;
    }

    const children: NonNullable<Run["children"]> = [];
    const failed: string[] = [];
    for (const leaf of leaves) {
      const made = createWorktrees(parentRepos, leaf.key, leaf.summary, this.log, { baseRef: parentBranch });
      // createWorktrees hands back the ORIGINAL ref when it could not create the
      // worktree. Launching a subagent there would put it in the parent's own
      // checkout, so that child is dropped rather than mislocated.
      const usable = made.filter((s, i) => s.path !== parentRepos[i].path);
      if (!usable.length) {
        failed.push(leaf.key);
        continue;
      }
      for (const s of usable) {
        children.push({
          key: leaf.key,
          summary: leaf.summary,
          repo: s.name,
          path: s.path,
          branch: branchName(leaf.key, leaf.summary),
        });
      }
      // Each child worktree gets its own brief, from its own ticket — a subagent
      // reads a real brief, not a row in the parent's table.
      const childDetail = await this.provider().detail(leaf.key).catch(() => null);
      writeBriefInto(usable, childDetail ?? { ...detail, key: leaf.key, summary: leaf.summary },
        providerLabel(cfg.agentProvider), this.log);
    }
    if (failed.length) {
      this.toast("info", `Couldn't create a worktree for ${failed.join(", ")} — dispatch those by hand.`);
    }

    const orchestratorPrompt = orchestratorTemplate(cfg);
    await this.launch(
      detail,
      parentRepos,
      orchestratorPrompt,
      true, // forceWorktree: the parent session works on the parent branch, isolated
      target,
      undefined,
      { children, parentBranch },
    );
  }
```

Two supporting changes:

1. `launch` takes the orchestration through to `openWorkspace`. Add a seventh parameter and use it:

```ts
  private async launch(
    detail: TaskDetail,
    services: ServiceRef[],
    promptTemplate: string,
    forceWorktree: boolean,
    target: OpenTarget,
    onWorktreeDecision?: (used: boolean) => void,
    /** Orchestrator-mode extras: the child worktrees this run owns. Absent for every
     *  other caller, which keeps their brief and their run record unchanged. */
    orchestration?: { children: NonNullable<Run["children"]>; parentBranch: string },
  ): Promise<boolean> {
```
```ts
    const planMd = briefMarkdown(
      detail,
      providerLabel(cfg.agentProvider),
      orchestration?.children.length
        ? { children: orchestration.children.map((c) => ({ key: c.key, summary: c.summary, path: c.path, branch: c.branch })), parentBranch: orchestration.parentBranch }
        : undefined,
    );
```
and in the `openWorkspace({...})` call:
```ts
      ...(orchestration?.children.length ? { children: orchestration.children } : {}),
```

2. `writeBriefInto`, in `src/engine/workspace.ts` — a child worktree needs a brief but must NOT get a window, so it cannot go through `openWorkspace`. It lives in `workspace.ts` beside the brief constants it uses, which also keeps `tasksView.ts` free of `fs` calls of its own.

There is no naming collision to resolve: `workspace.ts` has its own `briefMarkdown(t, planMd, services, thisRepo, files)` (line 187) and does NOT import `engine/brief`'s. This helper takes the rendered `planMd` as an argument, exactly as `openWorkspace` receives it (workspace.ts:293), so a child's brief and a parent's are produced by the same two functions in the same order:

```ts
/** Write `.pick-task/TASK.md` into each of `services` — worktrees that get a brief but
 *  deliberately no window, which is what a child worktree is: its subagent is
 *  dispatched by the parent's session, not opened by us.
 *
 *  `planMd` arrives already rendered (engine/brief's `briefMarkdown`), the same way
 *  `openWorkspace` receives it, so the two paths cannot drift into producing different
 *  briefs. Best-effort per repo: one unwritable worktree must not cost the others
 *  theirs. Returns the files it wrote. */
export function writeBriefInto(
  services: ServiceRef[],
  ticket: TicketRef,
  planMd: string,
  log: (m: string) => void,
): string[] {
  const written: string[] = [];
  for (const s of services) {
    try {
      const dir = path.join(s.path, BRIEF_DIR);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, BRIEF_FILE);
      fs.writeFileSync(file, briefMarkdown(ticket, planMd, [s], s.name, []));
      written.push(file);
    } catch (e) {
      log(`brief ${s.name}: could not write into ${s.path} (${e})`);
    }
  }
  return written;
}
```

   The `takeOrchestrated` call site becomes:

```ts
      writeBriefInto(
        usable,
        { key: leaf.key, summary: leaf.summary, url: childDetail?.url ?? "" },
        briefMarkdown(childDetail ?? { key: leaf.key, summary: leaf.summary, descriptionText: "" },
          providerLabel(cfg.agentProvider)),
        this.log,
      );
```

   Add a `writeBriefInto` block to `test/unit/engine/workspace.test.ts` asserting the written path (`<worktree>/.pick-task/TASK.md`), that the content contains the child's key, and that one repo throwing still writes the other.

3. `orchestratorTemplate` — the prompt already exists as the `orchestrator` prompt mode in `src/config.ts`. Resolve it by id; never duplicate its text:

```ts
/** The orchestrator prompt mode's template. A user can delete or rename modes, so an
 *  absent one falls back to the first configured mode rather than failing the take —
 *  and says so, because the session then gets a prompt that does not mention
 *  subagents while the brief's Children table tells it to dispatch them. */
function orchestratorTemplate(cfg: AgentFlowConfig, log: (m: string) => void): string {
  const mode = cfg.promptModes.find((m) => m.id === "orchestrator");
  if (mode) return mode.prompt;
  log(`orchestrator mode: no "orchestrator" prompt mode configured — falling back to ${cfg.promptModes[0]?.label ?? "the default prompt"}`);
  return cfg.promptModes[0]?.prompt ?? "";
}
```

   Add a test for the fallback: with `promptModes` containing no `orchestrator` entry, the take still opens one session and logs the fallback.

- [ ] **Step 4: Run and watch them pass**

Run: `npx vitest run test/unit/tasksView.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Mutation-check three**

1. Drop the `usable` filter (use `made` directly) — "skips a child whose worktree could not be made" must fail.
2. Return early without the toast on `noBranch` — "refuses the whole take when the parent branch cannot be made" must fail on the toast assertion.
3. Pass `undefined` for `orchestration` in `launch` — "names every child worktree in the parent's brief" must fail.

- [ ] **Step 6: Gates + commit**

```bash
npm run typecheck && npm test && npm run build
git add src/tasksView.ts src/engine/workspace.ts test/unit/tasksView.test.ts test/unit/engine/workspace.test.ts
git commit -m "feat(tasks): take a parent as an orchestrator over child worktrees"
```

---

### Task 9: The drawer lists a run's children

**Files:**
- Modify: `src/webview/DeckDetail.tsx`, `src/webview/deckStyles.ts`
- Test: `test/webview/DeckDetail.test.tsx` (append)

**Interfaces:**
- Consumes: `Run.children` (Task 6). No host change: the Deck already posts whole `RunStatus` objects, so the field arrives with the run. Verify that in Step 1 — if the wire strips unknown fields, add the passthrough in `deckView.ts` and say so in the commit.

- [ ] **Step 1: Write the failing tests**

Append to `test/webview/DeckDetail.test.tsx`, using that file's existing render helper and card factory:

```ts
describe("child worktrees", () => {
  const children = [
    { key: "PROJ-2", summary: "first bit", repo: "webapp", path: "/repos/webapp/.claude/worktrees/PROJ-2", branch: "PROJ-2-first-bit" },
    { key: "PROJ-3", summary: "second bit", repo: "webapp", path: "/repos/webapp/.claude/worktrees/PROJ-3", branch: "PROJ-3-second-bit" },
  ];

  it("renders nothing for a run with no children field", () => {
    renderDetail(cardFor({ key: "PROJ-1" }));
    expect(screen.queryByText("Children")).not.toBeInTheDocument();
  });

  it("renders nothing for a run with an empty children array", () => {
    // Distinct from the case above, and the one that pins the `.length` guard: a
    // truthiness check would render an empty Children section here.
    renderDetail(cardFor({ key: "PROJ-1", children: [] }));
    expect(screen.queryByText("Children")).not.toBeInTheDocument();
  });

  it("lists a row per child worktree", () => {
    renderDetail(cardFor({ key: "PROJ-1", children }));
    expect(screen.getByText("Children")).toBeInTheDocument();
    expect(screen.getByText("PROJ-2")).toBeInTheDocument();
    expect(screen.getByText("first bit")).toBeInTheDocument();
    expect(screen.getByTitle("/repos/webapp/.claude/worktrees/PROJ-2")).toBeInTheDocument();
  });

  it("names the branch each child is on", () => {
    renderDetail(cardFor({ key: "PROJ-1", children }));
    expect(screen.getByText("⎇ PROJ-2-first-bit")).toBeInTheDocument();
  });

  it("copies a child's worktree path on click", async () => {
    renderDetail(cardFor({ key: "PROJ-1", children }));
    await userEvent.click(screen.getByRole("button", { name: "Copy PROJ-2 worktree path" }));
    expect(copySpy).toHaveBeenCalledWith("/repos/webapp/.claude/worktrees/PROJ-2");
  });

  it("renders one row per repo when a child spans two", () => {
    renderDetail(cardFor({ key: "PROJ-1", children: [
      ...children.slice(0, 1),
      { ...children[0], repo: "frontend", path: "/repos/frontend/.claude/worktrees/PROJ-2" },
    ] }));
    expect(screen.getAllByText("PROJ-2")).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run test/webview/DeckDetail.test.tsx`
Expected: FAIL — "Children" is not in the document.

- [ ] **Step 3: Write the implementation**

In `src/webview/DeckDetail.tsx`, add a section after the "Work" section (around line 141), matching the existing `dd-sec` / `dd-lbl` shape:

```tsx
      {(r.run.children?.length ?? 0) > 0 && (
        <div className="dd-sec">
          <div className="dd-lbl">Children</div>
          {r.run.children!.map((c) => (
            <button
              type="button"
              className="dd-child"
              key={`${c.key}:${c.repo}`}
              aria-label={`Copy ${c.key} worktree path`}
              title={c.path}
              onClick={() => copy(c.path)}
            >
              <span className="k">{c.key}</span>
              <span className="t">{c.summary}</span>
              <span className="bn">⎇ {c.branch}</span>
            </button>
          ))}
        </div>
      )}
```

In `src/webview/deckStyles.ts`, add rules beside the existing `.dd-act` block, reusing the same tokens (no new colors — the drawer's own `--vscode-*` variables only):

```css
  .dd-child { display: flex; align-items: baseline; gap: 6px; width: 100%; text-align: left;
    background: none; border: 0; padding: 3px 0; color: inherit; cursor: pointer; }
  .dd-child:hover { background: var(--vscode-list-hoverBackground); }
  .dd-child .k { font-family: var(--vscode-editor-font-family); font-size: 11px; opacity: .85; }
  .dd-child .t { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dd-child .bn { font-family: var(--vscode-editor-font-family); font-size: 11px; opacity: .7; }
```

Mono is for identifiers only (key, branch), never the summary — that is this repo's webview convention.

- [ ] **Step 4: Run and watch them pass**

Run: `npx vitest run test/webview/DeckDetail.test.tsx && npm run build`
Expected: PASS, and the build must stay clean — this file must not gain an `fs`/`path` import.

- [ ] **Step 5: Mutation-check one**

Change the guard to `{r.run.children && (` — "renders nothing for a run with an empty children array" must fail.

- [ ] **Step 6: Full gates + commit**

```bash
npm run typecheck && npm test && npm run test:cov && npm run build
git add src/webview/DeckDetail.tsx src/webview/deckStyles.ts test/webview/DeckDetail.test.tsx
git commit -m "feat(deck): list a run's child worktrees in the drawer"
```

---

### Task 10: The feature ships inert behind a setting

**Added after Task 7's review**, which found that the feature as designed changes a core flow for every existing Jira user: any Take of a ticket with children interposes two mandatory QuickPicks, and every Take of any ticket pays an extra `getDetail` plus a `childrenOf` before the prompt-mode question. Nothing gated it, and this project's standing rule is that new behavior ships inert because of the install base. The spec never discussed a flag; this task adds one.

**Files:**
- Modify: `package.json` (the `agentFlow.childWorktrees` contribution), `src/config.ts` (interface + `getConfig`), `src/tasksView.ts` (`probeTree`'s guard), `src/telemetry/settingsSnapshot.ts` (report the flag), `CHANGELOG.md` (the feature's user-facing entry)
- Test: `test/unit/config.test.ts`, `test/unit/tasksView.test.ts`, `test/unit/telemetry/settingsSnapshot.test.ts` (append to each)

**Interfaces:**
- Consumes: `probeTree` (Task 7), which is the single choke point for the whole feature — every picker, every git write and every extra round trip is downstream of it.
- Produces: `AgentFlowConfig.childWorktrees: boolean`, default `false`.

- [ ] **Step 1: Write the failing tests**

In `test/unit/tasksView.test.ts`, append to the tree describe blocks — reuse their existing `CHILDREN` fixture and `getConfig` mock:

```ts
  it("does not probe for children when the setting is off", async () => {
    // Default-off is the whole point: an existing user's Take must be byte-identical
    // until they opt in. Asserted through observable behavior — one detail read, no
    // tree pickers, one openWorkspace — rather than by spying on probeTree.
    vi.mocked(getConfig).mockReturnValue({ ...CFG, childWorktrees: false });
    const { view } = setup({ authed: true });
    await view.takeTask("PROJ-1", "card");
    expect(clientStub.childrenOf).not.toHaveBeenCalled();
    expect(quickPickTitles()).not.toContain(expect.stringContaining("How do you want to work them"));
    expect(openWorkspace).toHaveBeenCalledTimes(1);
  });

  it("probes when the setting is on", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, childWorktrees: true });
    const { view } = setup({ authed: true });
    answerQuickPick("cancel");
    await view.takeTask("PROJ-1", "card");
    expect(clientStub.childrenOf).toHaveBeenCalledWith("PROJ-1");
  });
```

Every existing tree test in that file must now set `childWorktrees: true` in its own config — do this by adding it to the describe-level `beforeEach` those tests already share, NOT by editing each test's assertions.

In `test/unit/config.test.ts`, append a case asserting the default is `false` when the setting is absent, following that file's existing pattern for booleans. In `test/unit/telemetry/settingsSnapshot.test.ts`, append a case asserting `child_worktrees` is reported.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run test/unit/tasksView.test.ts test/unit/config.test.ts test/unit/telemetry/settingsSnapshot.test.ts`
Expected: FAIL — `childWorktrees` is not a config field, and the probe runs regardless.

- [ ] **Step 3: Implement**

`src/config.ts` — in `AgentFlowConfig`, beside `worktree`:

```ts
  /** Offer the child-worktree flow: a Take of a ticket with children asks whether to
   *  fan out into a worktree per child or run one orchestrator over them. Off by
   *  default, and the default is load-bearing — with it off, `probeTree` returns before
   *  reading anything, so an existing user's Take is byte-identical to what it was
   *  before this feature existed: no extra round trip, no new pickers, no new git. */
  childWorktrees: boolean;
```

and in `getConfig`:

```ts
    childWorktrees: c.get<boolean>("childWorktrees") ?? false,
```

`package.json`, in the same properties block as `agentFlow.worktree`:

```json
        "agentFlow.childWorktrees": {
          "type": "boolean",
          "default": false,
          "markdownDescription": "When you take a ticket that has children, offer to work them as a worktree per child (a session each) or as one orchestrator session dispatching a subagent per child. Off by default: with it off, taking a ticket behaves exactly as it did before this setting existed."
        },
```

`src/tasksView.ts` — the first line of `probeTree`, before the capability read:

```ts
    // The whole feature's off switch, and deliberately the FIRST thing here: every
    // picker, every git write and the extra ticket read are downstream of this method,
    // so returning here is what makes "off" mean byte-identical, not merely quieter.
    if (!getConfig().childWorktrees) return null;
```

`src/telemetry/settingsSnapshot.ts` — beside the other booleans:

```ts
    child_worktrees: cfg.childWorktrees,
```

and add the field to `SettingsSnapshot`.

- [ ] **Step 4: Run them and watch them pass**

Run the three files, then the full suite. Any pre-existing test that fails is a signal the guard is in the wrong place — fix the guard, not the test.

- [ ] **Step 5: Mutation-check**

Invert the guard (`if (getConfig().childWorktrees) return null;`) and confirm BOTH new tests fail. Then remove it entirely and confirm the "does not probe" test fails.

- [ ] **Step 6: CHANGELOG + commit**

Add one entry describing the feature and its default, in this file's existing voice. Then:

```bash
git add -A
git commit -m "feat(tasks): ship child worktrees behind an off-by-default setting"
```

---

## Final verification (after Task 9)

- [ ] `npm run typecheck && npm test && npm run test:cov && npm run build` — all four green, coverage thresholds met.
- [ ] `git diff main --stat` — no file outside the File Structure table above.
- [ ] `git log main..HEAD --oneline` — expect ~34 commits, not one per task: several tasks took fix rounds after review, Tasks 3+4 were squashed into one, Task 10 was added mid-branch, and the whole-branch review's fix wave landed eight of its own.
- [ ] ~~Confirm inertness by running the suite with `caps.children` forced absent — every test must still pass.~~ **Stale, replaced.** That check was written when the capability's absence was the only inertness lever (Tasks 3–7). Task 10 makes the *setting* the lever, and ~40 tests from Tasks 8–9 legitimately require the capability present in order to exercise the flow they built — so forcing it away now tests something the codebase no longer promises. The correct check is the one Task 10's tests already make: **capability present, setting off ⇒ the tree flow does not run** (no `childrenOf` call, no picker, one `openWorkspace`).
- [ ] Manual smoke in a dev host (`code --extensionDevelopmentPath=…`, per the repo's launch note): Take a ticket with subtasks, choose fan-out with two leaves ticked, confirm two worktrees exist on branches whose merge-base is the parent branch:
  `git -C <repo> merge-base --is-ancestor <parent-branch> <child-branch> && echo ok`
- [ ] Take the same parent again with zero leaves ticked; confirm the parent worktree attaches to the already-existing parent branch rather than erroring.
