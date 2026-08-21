# Child task worktrees: a worktree per leaf, not one for the parent

_Design — 2026-08-17. Source: a notepad item, "When taking a task with tasks/subtask under
it the worktree should each service to the task or subtask, not the parent task."_

## Goal

Taking a ticket that has children stops producing a single worktree named after the parent.
Instead the leaves of the ticket tree each get their own worktree, branched off a parent
branch, and the user chooses at Take time between two ways of working them:

- **Fan-out** — one agent session per leaf, through the existing batch path.
- **Orchestrator** — one session in the parent, dispatching a subagent per leaf, each
  subagent working inside that leaf's own worktree.

A ticket with no children keeps behaving exactly as it does today, byte for byte.

## Current behavior

`createWorktrees(services, key, summary, log)` creates `<repo>/.claude/worktrees/<KEY>` on
branch `<KEY>-<slug>`, always branched off whatever HEAD the main checkout is on
(`src/engine/worktree.ts`). `KEY` is the key of the ticket that was taken, and there is no
parent/child concept anywhere in the codebase: no provider fetches children, and
`"subtask"` exists only as a display kind in `src/webview/helpers.ts`. So taking a parent
gives one worktree for the parent and nothing for its children.

## Non-goals

- No cleanup of child worktrees. `retire.ts` does not remove worktrees today; child
  worktrees linger exactly like every other one. Follow-up ticket, not this change.
- No auto-merge of children into the parent branch. The topology makes the merge possible;
  performing it is the agent's or the user's job.
- No child status transitions, no assignment writes.
- No linked-issue trees ("blocks", "is part of"). Parent/child only.
- No `children` implementation for any source other than Jira. The capability is optional
  and every other source omits it.
- No per-child diffs in the Deck's poll loop. The drawer lists children; diffing one is a
  drawer-time action, not a refresh-loop cost.

## Decisions

| Decision | Chosen | Why |
|---|---|---|
| Which issues are children | Whole tree, recursive, leaves get the worktrees | The user works leaves, not containers. An epic → stories → subtasks tree flattens to its leaves. |
| Depth / breadth caps | depth 3, 20 leaves | A recursive fetch is N+1 API calls per level and a deep epic could open dozens of sessions. Over cap: take what fits, log what was dropped, name it in the toast. |
| Branch topology | Children branch off a parent branch | Children integrate into the parent branch, and the parent branch is the one thing that merges to main. Matches the orchestrator protocol already in use. |
| Parent in fan-out mode | Branch only — no worktree, no session | Children need a base ref, not a checkout. An integrator session would cost N+1 sessions and duplicate orchestrator mode, which exists for exactly that shape. Taking the parent later with zero leaves selected yields a worktree on the already-existing parent branch. |
| Leaf selection | `canPickMany`, nothing pre-selected | Safest against runaway fan-out; an explicit choice every time. |
| Who creates child worktrees in orchestrator mode | The extension, up front | Deterministic, and the same code path as fan-out. An agent asked to create its own worktrees makes the on-disk layout depend on instruction-following. |
| Where child worktrees live | `<repo>/.claude/worktrees/<CHILD-KEY>` — flat siblings | Same layout as every worktree today, so `repoRootOfWorktree`, diffs, retire and CI keep working unchanged. A worktree nested inside a worktree breaks its gitdir link when the outer one is removed. The parent→child link is recorded on the Run, not implied by the path. |
| Deck representation (orchestrator mode) | One parent card; children listed in its drawer | Children have no sessions of their own, so they are not runs. A card per child would show cards with nothing behind them. |
| Where the child fetch lives | An optional `Capabilities.children` on the provider | Same shape as `labels`/`sprints`/`components`. Keeps Jira's JQL out of `tasksView` and leaves the connector seam intact. |

## Modules

| Module | Change |
|---|---|
| `src/tasks/provider.ts` | New `ChildRef { key, summary, type, statusCategory, parentKey }`. New optional `Capabilities.children?: { of(key: string): Promise<ChildRef[]> }` — one level per call. ~~`SerializedCaps` gains `children: boolean`~~ — **not implemented, deliberately**: nothing in the webview picks children, the choice of mode is host-side, and `serializeCaps`' wire shape is pinned by `toEqual` tests that adding a field would have forced us to edit. `test/unit/tasks/provider.test.ts` pins the absence instead. |
| `src/tasks/jira/childJql.ts` (new) | Pure. `childrenJql(key)` returns the candidate JQL list — `parent = "KEY"` then `"Epic Link" = "KEY"` — for the candidate-fallback loop `client.ts` already uses for list queries. |
| `src/tasks/jira/client.ts` | `childrenOf(key): Promise<ChildRef[]>`, running those candidates through `searchJql` with `LIST_FIELDS`. The connector wires it into `caps.children`. |
| `src/engine/taskTree.ts` (new) | Pure — no `vscode`, no `fs`, no git. `buildTree(rootKey, fetch, opts)` → `{ nodes, leaves, dropped }`; `leafBranches(parentBranch, leaves)`. |
| `src/engine/worktree.ts` | `createWorktrees(services, key, summary, log, opts?: { baseRef?: string })` — a fifth, optional argument, so all four existing call sites produce identical argv. New `ensureBranch(repo, branch, from?)`. |
| `src/engine/brief.ts` | `briefMarkdown` gains an optional `children` argument and renders a Children section when it is present and non-empty. Absent or empty leaves the output byte-identical. |
| `src/tasksView.ts` | `takeTask` gains the tree probe and two pickers; new private `takeOrchestrated`; `takeBatch` gains an optional `baseRef` threaded into its `createWorktrees` call. |
| `src/types.ts` | `Run.parentKey?: string`; `Run.children?: { key, summary, repo, path, branch }[]`. Both optional and absent on every existing record. |
| `src/deckView.ts`, `src/webview/DeckDetail.tsx` | The drawer renders `run.children` when the field is present. |

## Tree fetch

`buildTree` is a breadth-first walk over levels, calling the injected `fetch(key)` once per
node:

- A node with no children is a leaf.
- `maxDepth` (3) stops the walk; nodes at the boundary are treated as leaves.
- `maxLeaves` (20) truncates the leaf list; the dropped keys come back in `dropped` so the
  caller can log and report them. Nothing is truncated silently.
- A `seen` set breaks cycles (a tree where A is reachable from its own descendant); a
  repeat is dropped and reported through `dropped`.
- `fetch` throwing for one node does not fail the walk: that node becomes a leaf and its
  key is reported in `dropped`.

## Take flow

1. `provider().detail(key)` as today.
2. If `caps.children` is absent, nothing below happens — the existing single-ticket path
   runs unchanged.
3. Probe the tree under a progress notification.
4. Zero leaves below the root → today's path, untouched.
5. Picker 1 — *"KEY has N leaves — how do you want to work them?"*: `A session per child` /
   `One orchestrator session, children as subagents` / `Just the parent` (today's behavior,
   and the integrate-later escape hatch).
6. Picker 2 — `canPickMany` over the leaves, nothing pre-selected. Label `KEY — summary`,
   description the status, detail the `PARENT › CHILD` path. An empty selection behaves as
   `Just the parent`.
7. By mode. Exactly one place creates each child worktree — whichever branch of this step
   runs — and every creation is preceded by `ensureBranch(repo, parentBranch)` in the repo
   it is about to write to. `ensureBranch` is idempotent, so repeated calls across children
   sharing a repo cost one `rev-parse`.
   - **fan-out** → the selected keys go into the existing `takeBatch`, now taking an
     optional `baseRef`. `takeBatch` keeps its layout picker (separate windows vs one shared
     window) and its per-key `detail()` → `reposForTask`, so each child lands in its own
     repos, and its own `createWorktrees` call is the one that makes the worktree — passing
     `{ baseRef: parentBranch }` through, after calling `ensureBranch` for each repo in that
     child's set. `takeTask` creates no worktrees itself on this branch. One Run per child,
     each stamped with `parentKey`.
   - **orchestrator** → `takeOrchestrated` resolves the parent's repo set once, calls
     `ensureBranch` per repo, then `createWorktrees(parentRepos, childKey, childSummary,
     log, { baseRef: parentBranch })` per selected leaf → `<repo>/.claude/worktrees/<CHILD-KEY>`
     on `<CHILD-KEY>-<slug>`. A child naming a repo outside the parent's set is logged and
     skipped, not silently dropped. Then one `launch` on the parent with the worktree forced
     and the prompt template forced to the existing orchestrator mode (`config.ts`). One Run
     for the parent, carrying `children`.

Both pickers run before any git write, so cancelling either leaves nothing behind — the
same ordering rule `deckView.ts` already states for its own worktree path.

## Briefs

The parent brief in orchestrator mode gains:

```
## Children — one subagent each

| Ticket | Summary | Worktree | Branch |
|---|---|---|---|
| ABC-12 | fix login timeout | .claude/worktrees/ABC-12 | ABC-12-fix-login-timeout |

Dispatch one subagent per row. Each works ONLY inside its worktree path.
Merge finished children into <parent-branch>; never into main.
```

Each child worktree also gets its own `.pick-task/TASK.md`, written from that child's own
detail — a subagent reads a real brief, not a table row.

## Error handling

| Case | Behavior |
|---|---|
| Children fetch fails (auth, 4xx, timeout) | Log, toast once, fall through to today's single-ticket Take. A tree probe never blocks taking the ticket. |
| Both JQL candidates return nothing | Treated as "no children" — the normal path. Indistinguishable from a real leaf, which is correct. |
| Over depth or leaf cap | Take what fits; log the dropped keys; name the count in the toast. |
| `ensureBranch` fails in a repo | Refuse the fan-out for that repo and say why. Never fall back to branching off main — the topology is the point. |
| `createWorktrees` returns the original ref (worktree creation failed) | Same rule `takeBatch` enforces today: detect path equality, fail that child, keep the rest. No child agent ever runs in the user's main checkout. |
| Cycle in the ticket tree | `buildTree`'s `seen` set drops the repeat and reports it. |
| Child names a repo outside the parent's set (orchestrator mode) | Logged, then skipped. Fan-out mode has no such restriction — each child resolves its own repos. |
| User cancels either picker | Nothing created; both pickers precede every git write. |

## Testing

The pure modules carry the weight and need no mocks:

- `taskTree.ts` — single level; three levels; depth cap; leaf cap with `dropped` populated;
  cycle; empty tree; `fetch` throwing mid-level.
- `leafBranches` — slug collisions, a leaf with an empty summary, the 40-character
  truncation `branchName` already applies.
- `childJql.ts` — candidate order and quoting/escaping of the key.
- `worktree.ts` — `baseRef` arrives as the last argument to `git worktree add`; omitting it
  produces exactly the argv today's four callers get (assert argv, not truthiness);
  `ensureBranch` is a no-op when the branch already exists.
- `brief.ts` — with `children`, the table renders; without it, output is byte-identical to
  the current snapshot.
- `tasksView.ts` — the probe is skipped when `caps.children` is absent; a probe failure
  degrades to a single Take; cancelling at each picker leaves zero git calls; fan-out
  threads `baseRef` into `takeBatch`.
- Deck webview — a run with `children` renders the rows; a run without the field renders as
  it does today.

Gates, all four: `npm run typecheck`, `npm test`, `npm run test:cov` (thresholds 90
statements / 85 branches / 85 functions / 90 lines), and `npm run build` — the build is the
only check that catches an `fs`/`path` import reaching `src/webview/`.

Every new test gets a mutation check: break the line it covers and confirm the test fails.
Assert argv and rendered strings, never truthiness.

## Back-compat

- Every new field and argument is optional. No existing `Run` record is rewritten.
- No connector API becomes required. A source without `caps.children` never sees a new
  picker, a new git call, or a changed prompt.
- The existing test suite must pass unmodified. A current test needing an edit is evidence
  the change leaked, not that the test was wrong.
