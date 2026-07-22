# Repo multiselect + fuzzy title search

## Problem

The task-pool sidebar has a single free-text "Filter by repo…" box
([`App.tsx`](../../../src/webview/App.tsx) `repo-filter`). It does two jobs
poorly through one control: you type a string, and it substring-matches that
string against each task's inferred `services` (repo guesses). There is no way
to see the set of repos in play and pick from it, and there is no way to search
the task *titles* at all.

Users want two distinct things:

1. Pick one or more repos from a list (a multiselect), rather than remembering
   and typing repo names.
2. Fuzzy-search the task list by title.

## Goal

Replace the single repo text box with two independent, composable controls — a
**repo multiselect dropdown** and a **fuzzy title search** — and let each be
shown/hidden via settings, consistent with the existing filter-visibility
toggles.

## Scope

- Repo multiselect dropdown (OR filter over inferred `services`).
- Fuzzy search over the task **title** (`summary`) only, powered by `fuse.js`.
- One new visibility setting for the search box; the existing repo setting is
  repurposed for the multiselect.

Out of scope (decided during brainstorming):

- **Description search.** Descriptions are not loaded for the list — only
  `summary` is available up front; `descriptionText` is fetched lazily per card
  on expand. Searching descriptions would need either eager fetching of every
  ticket (N extra Jira calls per pool load) or would only cover already-expanded
  cards. We chose **title-only**.
- **A single combined control** that both picks repos and searches text. We
  chose two separate, unambiguous controls.
- **Configurable fuzzy behaviour** (threshold, weighting) as a user setting.
  Only visibility is configurable; fuzz parameters are constants.

## Design

### 1. The two controls (`src/webview/App.tsx`)

Replace the `filters.repo`-gated `.repo-filter` block with two stacked
controls, each behind its own visibility flag:

```
Status  [All] [In Progress] [In Review]

⌕  Filter repos ▾  · 2        ← repo multiselect (gated by filters.repo)
🔍  Search title…        ×     ← fuzzy title search (gated by filters.search)
```

**Repo multiselect** — a new `RepoMultiSelect` component, adapted from the
existing command-palette `RepoPicker` (filter-as-you-type input, keyboard
navigation, click-outside-to-close). Differences from `RepoPicker`:

- A trigger button with a leading **funnel filter icon** (mirroring the search
  box's leading magnifier), the label **"Filter repos"**, a caret, and a
  selected-count badge when any repos are selected.
- Options render as a **checkbox list**; clicking toggles membership instead of
  add-one-and-close. The dropdown stays open across toggles.
- A **Clear** affordance in the dropdown footer resets the selection.
- Options = the **union of every task's `services`** across the loaded pool,
  sorted alphabetically, de-duplicated. Derived with `React.useMemo` over
  `tasks`.

**Fuzzy title search** — the existing text-input treatment (leading
`SearchIcon`, a clear `×`), bound to a new `textQuery` state.

A shared `FilterIcon` SVG (funnel) is added alongside the existing `SearchIcon`.

### 2. State & filtering (`src/webview/App.tsx`)

State changes:

- `repoQuery: string` → **`selectedRepos: Set<string>`**
- add **`textQuery: string`**

A task is visible when it satisfies **all** active filter types (AND across
types):

- **Repos:** `selectedRepos.size === 0` → pass; else pass if any of the task's
  `services` is in `selectedRepos` (**OR within** the repo set).
- **Text:** `textQuery` empty → pass; else the task's `summary` matches the
  fuse.js query (see §3).
- **Status:** unchanged (`matchesStatus(t, statuses)`).

When `textQuery` is non-empty, the visible list is **ordered by fuse.js
relevance** (best match first). When it is empty, the current order/`updated`
sort is preserved untouched (Fuse is not consulted at all — zero cost on the
common path).

### 3. Fuzzy matching (`fuse.js`)

- Add `fuse.js` to `dependencies`. **Verify the `package-lock.json` entry
  resolves from the public npm registry** (`registry.npmjs.org`), not a private
  CodeArtifact mirror — otherwise CI fails `E401`. (See repo memory:
  *Public npm registry for agent-flow*.)
- A single `Fuse` instance, `React.useMemo`'d over `tasks`, rebuilt only when
  `tasks` changes. Config: `{ keys: ["summary"], threshold: 0.4,
  ignoreLocation: true }`.
- Searching path: `fuse.search(textQuery)` returns tasks already ordered by
  score; feed that ordered result through the repo/status predicates.
- Non-searching path: skip Fuse; filter `tasks` directly with the repo/status
  predicates in existing order.

### 4. Reorder guard & empty state (`src/webview/App.tsx`)

- `canReorder` becomes `filter === "mysprint" && selectedRepos.size === 0 &&
  textQuery.trim() === "" && statuses.size === 0`. Manual drag-reorder is only
  meaningful on the unfiltered My-sprint list.
- The empty-state message reflects which filter emptied the list, in priority
  order: text query (`No titles match "…"`), then repos
  (`No tasks touch the selected repos.`), then status
  (`No tasks match the selected status.`), else `No tasks in this view.`

### 5. Settings (`package.json` → `contributes.configuration`)

Follows the existing `filters.*` pattern (booleans defaulting to `true`):

| Setting | Default | Controls |
| --- | --- | --- |
| `agentFlow.filters.repo` | `true` | the **repo multiselect** dropdown (description updated from the old "Filter by repo… box") |
| `agentFlow.filters.search` | `true` | the **fuzzy title search** box (new) |

Applied on refresh/reload, like every other setting today (no live
`onDidChangeConfiguration` watcher).

### 6. Config & message plumbing

- `FilterVisibility` ([`src/types.ts`](../../../src/types.ts)) gains
  `search: boolean`.
- `config.ts` reads `filters.search` with a `?? true` fallback.
- `tasksView.ts` already forwards `cfg.filters` wholesale via the `state`
  message — no change beyond the widened type.
- `App.tsx` seeds `filters` with `{ size: true, status: true, repo: true,
  search: true }` before the first `state` message, so nothing flashes hidden.

**Correctness (hidden control = neutral value):** a hidden multiselect keeps
`selectedRepos` empty (all tasks pass); a hidden search keeps `textQuery` `""`
(all tasks pass, natural order). Neither can be interacted with while hidden, so
no reset logic is needed — matching the pattern established for the other
filters.

## Files touched

- `src/webview/App.tsx` — two controls, `RepoMultiSelect` component, `FilterIcon`,
  new state, filter/sort logic, `canReorder`, empty-state copy.
- `src/webview/styles.ts` — styles for the multiselect trigger/popup/checkboxes
  and the search box (extending/renaming the current `.repo-filter` styles).
- `src/types.ts` — `FilterVisibility.search`.
- `src/config.ts` — read `filters.search`.
- `package.json` — `agentFlow.filters.search` contribution; update
  `agentFlow.filters.repo` description; add `fuse.js` dependency.
- `package-lock.json` — `fuse.js` resolved from the public registry.

## Testing

- **`src/config.ts`** — `filters.search` defaults to `true` when unset, honours
  explicit `false`.
- **`src/webview/App.tsx`** (harness at `test/webview/App.test.tsx`):
  - Repo multiselect: options are the sorted de-duped union of `services`;
    selecting repos OR-filters the list; Clear resets.
  - Fuzzy search: a query narrows to matching titles and orders results by
    relevance (best match first); a non-matching query yields the empty state.
  - Combined: repo selection AND text query AND status lens all apply together.
  - Visibility: each control renders when its flag is `true`, absent when
    `false`; a hidden control does not narrow the list.
  - `canReorder` is false whenever any of the three filters is active.
- **Fuzzy helper** — if the fuse.js call is wrapped in a small helper, unit-test
  ordering/threshold there; otherwise cover via the component tests above.

## Non-goals / YAGNI

- No description search; no eager description fetching.
- No live config-change watcher.
- No user-configurable fuzzy threshold/weighting.
- No migration — `filters.search` is additive; repurposing `filters.repo`
  preserves its default-on behaviour, so existing users see both controls.
