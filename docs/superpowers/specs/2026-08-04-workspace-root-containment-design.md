# Design: Never add a workspace root that is already reachable

**Date:** 2026-08-04
**Status:** Approved, ready for planning

## Summary

A saved `.code-workspace` can still collect redundant roots. The
[2026-08-02 spec](2026-08-02-no-repo-adds-to-existing-workspace-design.md) made the file
write-only-on-approval and deduped candidates by **repo name**, which closed the case that
motivated it. Name comparison misses a class it was never meant to cover: a candidate whose
path is already *inside* a declared root but whose name matches nothing — a workspace rooted
at a parent directory, or a root the user renamed.

The fix is one predicate, extracted once and shared: **is this path already reachable from a
root this workspace declares?** Path-equal to a root, or nested beneath one. That logic
already exists inside `mentionInWorkspace`; it is promoted to a named export and applied at
merge-planning time, at the write layer, and when repos are derived from a destination.

This change is **prevention only**. It never edits a workspace file that a previous version
polluted — no repair command, no pruning, no automatic rewrite.

## Relationship to the 2026-08-02 spec

That spec's decision table says *"Not path equality (today's rule) and not path
containment."* This design does not reverse it. Name-dedup stays, unchanged, as the primary
guard, for the reason given there: **two roots with one name are indistinguishable in the
explorer and make `@name/…` ambiguous, and that visible harm is what the rule exists to
prevent.** Containment is added *alongside* it, as a second reason to skip, because the two
catch different things:

| Guard | Catches | Misses |
|-------|---------|--------|
| Name (existing) | Same repo name at any path — two separate checkouts of `api` | A root named `At-Bay-Projects` that already contains `centaur` |
| Containment (new) | Anything nested beneath a declared root, whatever it is called | A same-named repo at an unrelated path |

Neither is a superset of the other, so both stay. Where a candidate satisfies both — the
common worktree-inside-its-own-repo case — **name wins**, so today's classification and
today's toast copy are unchanged and every existing test stays green.

That spec also lists `servicesFromExistingDestination` as a non-goal. This design changes
it deliberately, and section *Why the derivation matters* explains what changed: the
pollution turned out to be self-amplifying through that function, which was not known when
the earlier non-goal was written.

## Why the derivation matters

Pollution is not cosmetic — it compounds. When the destination is an existing workspace,
`resolveKickoff` skips the repo picker and derives the task's repos from that workspace's
own folders via `servicesFromExistingDestination`, which falls back to
`{ name: path.basename(p), path: p, isGit: fs.existsSync(path.join(p, ".git")) }` for any
folder it can't match to a discovered repo. `discoverRepos` scans only the top level of
`reposRoot`, so a worktree root is never matched — and a worktree's `.git` is a gitdir
*pointer file*, which passes `existsSync`. Verified against a real worktree:

```
basename → ASM-5885        isGit per discoverRepos rule → true
```

So a root at `centaur/.claude/worktrees/ASM-5885` becomes a phantom repo named `ASM-5885`,
and the next take calls `createWorktrees` on it, producing
`centaur/.claude/worktrees/ASM-5885/.claude/worktrees/ASM-NEW` — a worktree inside a
worktree. Each take makes the next one worse. Preventing the write is necessary but not
sufficient: a root a *user* added by hand triggers the same cascade, so the derivation is
fixed independently.

## Decisions

| Question | Decision |
|----------|----------|
| What counts as "already reachable"? | **Path-equal to a declared root, or nested beneath one.** Deepest root wins, matching VS Code's most-specific-root resolution. |
| Does name-dedup change? | **No.** It stays exactly as specified on 2026-08-02. Containment is an additional reason to skip, never a replacement. |
| When a candidate is both, which bucket? | **`duplicates` (name).** Keeps existing classification, toast copy and tests intact; `redundant` holds only what name-matching misses. |
| Are redundant candidates surfaced? | **No prompt.** They join the existing `skipped` list, so the toast's "already in the workspace" clause covers them with no new copy. |
| Repair already-polluted files? | **No.** Out of scope by explicit decision — see Non-goals. |
| Prune roots whose worktree was deleted? | **No.** Considered and cut: it writes to files this version never polluted, which is the same objection that ruled out repair. |
| How is a worktree root mapped back to its repo? | **By unwinding our own path convention** — the prefix before `/.claude/worktrees/` — not by guessing from discovered repos. Deterministic, and it works for repos outside `reposRoot`. |
| New config key? | **No.** |
| Ever remove or reorder an existing folder? | **Never.** The operation stays additive-or-nothing. |

## Approach rationale

- **One predicate, one reader.** `workspaceFolders` is already documented as the single
  reader for "which folders does this workspace have," precisely so the plan, the merge and
  `prefillPathsForTarget` cannot drift. Containment deserves the same treatment: it is
  currently private to `mentionInWorkspace`, which is why the merge path could not consult
  it. Extracting it is what makes this class of bug structurally impossible rather than
  patched in one caller.
- **Guard at the write layer too.** The 0.1.42 defect was a caller deriving its own folder
  list and a writer that only compared exact paths. Re-checking containment inside
  `mergeReposIntoWorkspace` means a future caller that bypasses merge-planning still cannot
  reintroduce it. Defense in depth *behind* the root-cause fix, not instead of it.
- **A nested root buys brevity, not capability.** `mentionInWorkspace` already emits
  `@centaur/.claude/worktrees/ASM-5885/src/x.ts` for a worktree beneath the `centaur` root,
  deliberately, because the short form would point the agent at the main checkout. Refusing
  the root costs mention length and nothing else — no new code path, no new risk.
- **Unwind the convention, don't infer.** `.claude/worktrees/<KEY>` is Agent Flow's own
  layout constant. Deriving a worktree's repo from that prefix is exact, needs no discovery
  pass, and works for checkouts outside `reposRoot` — where containment against discovered
  repos would find nothing.
- **Prevention beats repair.** Fixing files this version didn't write means writing to the
  user's artifact unprompted, which the 2026-08-02 design exists to refuse.

## Behavior & flow

Unchanged up to merge planning. The new classification step:

```
resolveWorkspaceAdditions(file, candidates)
  plan = planWorkspaceMerge(file, candidates)
        present    ← exact canonical path already declared
        duplicates ← a declared root carries this repo's name (unchanged)
        redundant  ← NEW: path is inside a declared root, and the name matched nothing
        add        ← none of the above
  skipped    = duplicates ∪ redundant        → the toast's "already in the workspace" clause
  no prompt unless plan.add is non-empty     (unchanged)
```

Worked example — a workspace with a single root at the repos parent directory,
`{ "path": "/Users/me/At-Bay-Projects" }`, taking a task across `centaur` + `infra`:

```
centaur  worktree …/At-Bay-Projects/centaur/.claude/worktrees/ASM-1  → inside the root  → redundant, skipped
infra    worktree …/elsewhere/infra/.claude/worktrees/ASM-1          → inside no root   → new, offered
```

Before this change both were offered and, on approval, both written — one of them a root
nested inside a root the workspace already had.

The user's real file is the name-matching case and its classification does not move:

```
centaur         worktree …/centaur/.claude/worktrees/ASM-5885         → name taken → duplicate, skipped
automation_e2e  worktree …/automation_e2e/.claude/worktrees/ASM-5885  → name taken → duplicate, skipped
```

## Surfaces

### `src/engine/workspace.ts`

```ts
/** The declared root that contains `target` — path-equal, or `target` nested beneath it.
 *  Deepest root wins, matching VS Code's most-specific-root resolution. The `+ path.sep`
 *  guard keeps /repos/api from swallowing the sibling /repos/api-gateway. `undefined` when
 *  `target` is inside no root.
 *
 *  Single reader for "is this path already reachable from a root", so merge planning, the
 *  write layer and mention rendering cannot disagree on the answer. `roots` must carry
 *  canonical paths — `workspaceFolders` already returns them; `target` is canonicalized here. */
export function containingRoot(
  roots: WorkspaceFolder[], target: string,
): WorkspaceFolder | undefined;

export interface WorkspaceMergePlan {
  add: MergeCandidate[];
  duplicates: MergeCandidate[];  // a declared root carries this repo's name (unchanged)
  /** Inside a declared root, so already reachable and visible beneath it. Skipped without
   *  asking — adding it would nest a root inside a root for no gain. Distinct from
   *  `duplicates` because the containing root's name may match nothing about this repo. */
  redundant: MergeCandidate[];
  present: MergeCandidate[];
  ok: boolean;
}
```

- **`mentionInWorkspace`** delegates its root-finding to `containingRoot`. Behavior-preserving
  refactor; its own tests are the regression check.
- **`planWorkspaceMerge`** classifies in order: `present` → `duplicates` → `redundant` → `add`.
- **`mergeReposIntoWorkspace`** additionally refuses any folder whose path has a containing
  root. It keeps its own parse — it needs the raw text for `modify` and the error list for
  its `ok:false` contract — and builds `WorkspaceFolder[]` from that already-parsed document
  rather than re-reading the file. Those paths must be resolved against the file's directory
  and canonicalized, exactly as `workspaceFolders` does and as its current `present` set
  already does (`canon(path.resolve(wsDir, p))`); a raw relative `"centaur"` would contain
  nothing.

### `src/engine/worktree.ts`

```ts
/** The repo a worktree path belongs to: the prefix before our `.claude/worktrees/<KEY>`
 *  segment. Splits on the FIRST occurrence, so a nested worktree-inside-a-worktree unwinds
 *  all the way to the outermost real repo in one step. `undefined` for any path that isn't
 *  one of our worktrees. Lives here because this module owns WORKTREE_DIR — the convention
 *  being unwound. */
export function repoRootOfWorktree(p: string): string | undefined;
```

### `src/tasksView.ts`

- **`servicesFromExistingDestination`** maps each prefill path through `repoRootOfWorktree`
  first, then resolves as today (discovered repo by canonical path, else a synthesized
  `ServiceRef`), then dedups by canonical path. A workspace declaring both `centaur` and
  `centaur/.claude/worktrees/ASM-5885` yields one service: `centaur`, the main checkout.
- **`resolveWorkspaceAdditions`** unions `plan.duplicates` and `plan.redundant` into
  `skipped`, still deduped by `repoName`. No copy change: "already in the workspace — not
  added as folders" is true of both.
- `prefillPathsForTarget`, `chooseOpenTarget`, `targetToOpenArgs`, `pickExistingWorkspace` —
  unchanged.

## Edge cases

- **Sibling prefix.** `/repos/api-gateway` is not inside `/repos/api`. The `+ path.sep`
  guard is the reason; it gets its own test.
- **Nested roots.** A path inside two declared roots resolves to the deeper one, so a
  candidate equal to the deeper root lands in `present`, not `redundant`.
- **Candidate equal to a root.** Stays `present` — containment must not swallow the exact-match
  case, or the "nothing to do, nothing to report" bucket would start reporting.
- **Unparseable / unreadable file.** `ok:false` with every bucket empty, including `redundant`.
  Unchanged.
- **Worktree fallback to the main checkout.** `createWorktrees` returns the original ref when
  `git worktree add` fails. The candidate is then the checkout itself: `present` if it's a
  root, `duplicates` if a differently-pathed root shares its name, `redundant` if it sits
  under a parent-directory root. Nothing is written in any of the three.
- **Worktree of a repo outside `reposRoot`.** `repoRootOfWorktree` still unwinds it, because
  it reads the path convention rather than the discovery list. The result may not be a
  discovered repo, so it falls through to a synthesized `ServiceRef` — with the *repo's*
  name and path, not the ticket key's.
- **A root that is a worktree whose repo is gone from disk.** `repoRootOfWorktree` returns
  the prefix regardless; the synthesized `ServiceRef` gets `isGit: false` and the existing
  non-git handling in `createWorktrees` logs and opens it directly.
- **Roots that are neither repos nor worktrees** (e.g. a docs folder the user added). No
  `.claude/worktrees/` segment, no change in behavior.

## Testing

**`test/unit/engine/workspace.test.ts`**

- `containingRoot`: exact match; nested one level; nested several levels; deepest of two
  containing roots wins; `/repos/api-gateway` against root `/repos/api` → `undefined`;
  inside no root → `undefined`; empty roots → `undefined`.
- `planWorkspaceMerge`: a parent-directory root with a differently-named repo → `redundant`;
  a worktree inside a same-named root → still `duplicates` (regression guard on the
  precedence decision); a candidate equal to a root → still `present`; a genuinely
  unrelated path → still `add`; `ok:false` leaves `redundant` empty too.
- `mergeReposIntoWorkspace`: handed a nested path directly, it writes nothing and reports it
  as not added; handed a genuinely new path it still writes; a parse failure still returns
  `ok:false` without writing.
- `mentionInWorkspace`: existing cases pass unchanged after delegating to `containingRoot`.

**`test/unit/engine/worktree.test.ts`**

- `repoRootOfWorktree`: a real worktree path → the repo prefix; a nested-worktree path
  → the outer prefix; a plain repo path → `undefined`; a path merely containing `.claude`
  → `undefined`.

**`test/unit/tasksView.test.ts`** — asserts on the arguments `openWorkspace` receives, not on
file bytes. Two mock updates are mandatory, or every test in the file fails:

- `vi.mock("../../src/engine/worktree", …)` is a **total** factory currently exporting only
  `createWorktrees`. `servicesFromExistingDestination` will import `repoRootOfWorktree` from
  that module, so the factory must export it too — otherwise every test throws on import.
- The `planWorkspaceMerge` mock returns a literal `{ add, duplicates, present, ok }`. It must
  gain `redundant: []`, or `resolveWorkspaceAdditions` unions `undefined` and throws.

The `workspace` mock is deliberately *partial* (4 exports) and stays that way — `tasksView`
never imports `containingRoot`. The real `batchWorkspace` runs against that partial mock, as
its existing comment explains; adding containment inside `mergeReposIntoWorkspace` doesn't
change that, since `folderName` is still the only thing exercised there.

Cases:

- Destination workspace declaring a worktree root → `openWorkspace` receives the parent repo
  as its service, not a phantom named after the ticket key.
- Destination workspace declaring both the repo and a worktree of it → one service.
- A `redundant` candidate shows no add-prompt and reaches the toast's skipped clause.

Repo gates: `npx tsc --noEmit` clean, full suite green, coverage thresholds held, and ≥95%
line coverage on every changed file.

## Non-goals (YAGNI)

- **No repair of already-polluted workspaces** — no palette command, no toast action, no
  automatic rewrite. Explicitly cut.
- **No pruning** of roots whose worktree was later deleted. A root pointing at a deleted
  directory stays, and VS Code renders it as an empty folder.
- No change to name-dedup semantics, the approval prompt, or its copy.
- No new configuration key.
- No removing, reordering or renaming existing workspace folders.
- No change to the `new` / `current` / `live-folder` destinations, the destination picker,
  the repo picker, or the worktree question.
- No `files.exclude` management to hide `.claude/worktrees/` in the explorer.
