# Deck Diff: open the native multi-file diff editor

**Date:** 2026-08-04
**Status:** Approved design, ready for an implementation plan

## The problem

The Deck card's **Diff** button ([DeckApp.tsx:293](../../../src/webview/DeckApp.tsx#L293)) sends
`deck:inspect` with `action: "diff"`. The host handler
([deckView.ts:802-832](../../../src/deckView.ts#L802-L832)) concatenates `taskDiff()` across every
repo in the run and opens the result as one untitled text document with `language: "diff"`.

That gives a single flat wall of unified patch. There is no file list, no side-by-side view, no way
to collapse a file or jump to one, and no hunk navigation. For a two-file fix it is adequate; for a
real agent run touching a dozen files it is unusable, which is the point at which someone most needs
to see what the agent did.

## The decision

Open VS Code's native multi-file diff editor instead of rendering our own.

Two alternatives were considered and rejected:

- **A drawer in the Deck webview.** Rejected. It means reimplementing syntax highlighting,
  side-by-side layout, intra-line word diffing, and large-file virtualization inside a ~400px
  sidebar panel, and the result would be worse than the viewer the editor already ships.
- **Opening the change on GitHub.** Rejected as the primary action. It requires a pushed branch and
  an open PR, so it cannot answer "what has this agent done so far" for an in-flight run — which is
  the common case on the Deck.

The native editor gives a real file tree, per-file collapsing, proper diff rendering, and `F7` hunk
navigation, in the full editor area rather than the sidebar, for close to no rendering code of ours.

## Mechanism

### The command

`vscode.changes` is a built-in command, present since VS Code 1.86; this extension requires
`^1.90.0` ([package.json:27](../../../package.json#L27)).

```ts
vscode.commands.executeCommand(
  "vscode.changes",
  title: string,
  resourceList: [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][],
)
```

Each tuple is `[resource, left, right]`. `resource` is the identity the editor labels and groups by;
`left` is `undefined` for an added file and `right` is `undefined` for a deleted one.

Title: `Changes in <run key>` — e.g. `Changes in PROJ-123`.

### The two sides

**Right** is a plain `file:` URI pointing at the file in the run's worktree. That is the working
tree, which is what `taskDiff` shows today, so uncommitted agent work stays visible.

A `file:` URI is editable, and that is deliberate: a typo spotted in the diff can be fixed in place
and saved into the worktree. The tradeoff accepted here is that an agent may be writing in that same
worktree concurrently, so a manual edit can collide with the agent's next write. The alternative —
routing the right side through a read-only content provider — was rejected because it would cost the
edit-in-place behavior and give the file tree unfamiliar save semantics.

**Left** is the file's content at the run's merge-base. No file on disk holds that, so it comes from
a `TextDocumentContentProvider` registered on a new `agent-flow-base:` scheme, alongside the other
disposables at [extension.ts:59](../../../src/extension.ts#L59). The URI carries the repo path, the
base sha, and the file path; `provideTextDocumentContent` shells out to `git show <sha>:<path>`. A
content provider is read-only by construction, so the left side cannot be edited.

### New functions in `git.ts`

[`taskDiff`](../../../src/engine/git.ts#L74-L78) currently computes the merge-base inline and throws
it away. Two additions expose what the multi-diff editor needs:

- **`taskDiffBase(repoPath): string`** — the merge-base sha `taskDiff` already resolves via
  `defaultRemoteRef`, or `"HEAD"` when there is no base to find. `taskDiff` is refactored to call
  it, so the two cannot drift. It returns a usable ref rather than `""` so every caller has
  something it can hand straight to `git show`.
- **`taskChangedFiles(repoPath): ChangedFile[]`** — `git diff --name-status -M <base>` parsed into
  `{ status, path, oldPath? }`. `-M` matters: without it a rename arrives as an unrelated add plus
  delete, which reads as two changes in the file tree instead of one.

### Status to tuple

| Status | Tuple |
| --- | --- |
| `A` (added) | `[right, undefined, right]` |
| `D` (deleted) | `[right, left, undefined]` |
| `M` (modified) | `[right, left, right]` |
| `R` (renamed) | `[right, left, right]`, `left` built from `oldPath` |

For a deleted file, `right` is the `file:` URI of the path that no longer exists; the editor renders
it as a deletion. This matches how the GitHub PR extension drives the same command.

### Multiple repos

One flat resource list across all of the run's repos, using absolute `file:` URIs. The multi-diff
editor derives its own file tree from those paths, so each repo root becomes a group without any
work on our part. This replaces today's `# reponame` text headers, which only existed because a flat
patch had no other way to separate repos.

The existing `repoName` filter on `inspect()` is preserved: when a card's per-repo action passes a
repo, only that repo's files are listed.

## Edge cases

**Cursor.** This is the material risk. `vscode.changes` is a built-in command, not a typed API —
nothing in `@types/vscode` guarantees a VS Code fork registered it. If Cursor has not, the
`executeCommand` promise rejects and Diff silently does nothing, on the editor this extension is
primarily installed into.

So the current flat-patch document is retained as a `catch` fallback: attempt the multi-diff editor,
and on rejection fall back to `taskDiff` and `openTextDocument`. It costs a handful of lines, keeps
the existing behavior reachable, and degrades instead of breaking. **Cursor support must be verified
by hand before merge, not assumed.**

The fallback is not exposed in the UI. There is one Diff button with one behavior; the flat patch
appears only when the command is unavailable.

**Binary files.** `--name-status` does not identify them; `--numstat` marks them with `-` in both
the added and deleted columns. Piping a binary through a text content provider renders garbage on
the left side, so binaries are filtered out of the resource list. If binaries were the only change
in the run, the toast says so rather than opening an empty editor.

**No changes.** Unchanged from today: the `No changes to show for <key>.` info toast at
[deckView.ts:827](../../../src/deckView.ts#L827).

**No merge-base.** `taskDiffBase` returns `"HEAD"` on a repo with no resolvable default remote ref,
the same degradation `taskDiff` already makes with its `from || "HEAD"`. The left side then reads
from `HEAD`, so uncommitted work still diffs correctly and committed work reads as unchanged —
matching the existing documented behavior rather than inventing a new one.

## Testing

Repo gates that must pass: `npm run typecheck`, `npm test`, and the coverage thresholds in
[vitest.config.ts:40](../../../vitest.config.ts#L40) — statements 90, branches 85, functions 85,
lines 90.

- **[test/unit/engine/git.test.ts](../../../test/unit/engine/git.test.ts)** — `taskChangedFiles`
  against temp repos covering add, delete, modify, and rename; the committed-work case `taskDiff`
  already guards; and the no-merge-base degradation. `taskDiffBase` returning a sha and returning
  `""`.
- **[test/unit/deckView.test.ts](../../../test/unit/deckView.test.ts)** — `inspect(key, "diff")`
  invokes `executeCommand("vscode.changes", …)` with the expected title and tuple shape; falls back
  to `openTextDocument` when the command rejects; toasts when there is nothing to show; toasts when
  only binaries changed; honors the `repoName` filter.
- **The content provider** — `provideTextDocumentContent` returns `git show` output for a URI it
  round-trips, and the URI encoding survives paths containing spaces.

## Out of scope

- Any change to the **Open** action or the rest of the card.
- Reviewing, commenting on, or approving a change from inside the editor. This is a viewer; real
  review stays on GitHub.
- A "copy as patch" affordance. If it turns out to be wanted, the `⋯` menu is where it goes.
