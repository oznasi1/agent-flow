# Repo multiselect + fuzzy title search — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single "Filter by repo…" text box in the task-pool sidebar with a repo multiselect dropdown and a fuse.js fuzzy title search, each toggleable via settings.

**Architecture:** This is a VS Code extension. Settings flow host→webview: `config.ts` reads `agentFlow.*` settings into `AgentFlowConfig.filters` (a `FilterVisibility`), `tasksView.ts` forwards it in the `state` message, and `src/webview/App.tsx` (a React app bundled by esbuild) gates each control on its flag. Filtering is entirely client-side in `App.tsx` over the in-memory task pool. The existing per-card `RepoPicker` and the new `RepoMultiSelect` share their command-palette scaffolding through a `useComboFilter` hook.

**Tech Stack:** TypeScript, React 18, esbuild, Vitest + @testing-library/react (jsdom), fuse.js (new runtime dependency).

## Global Constraints

- **fuse.js must resolve from the public npm registry.** This repo is public OSS; the user's global `~/.npmrc` points npm at At-Bay CodeArtifact, which rewrites `package-lock.json` `resolved` URLs and makes CI fail with `E401`. Always install with `--registry https://registry.npmjs.org` and verify the lockfile entry resolves to `registry.npmjs.org`.
- **Settings default to `true`** (control shown), read with a `?? true` fallback — matches every existing `agentFlow.filters.*` setting. Additive only; no migration.
- **Repo trigger label copy is exactly `Filter repos`** (no ellipsis); the combo's inner filter input keeps the placeholder `Filter repos…` (with ellipsis); the fuzzy box placeholder is exactly `Search title…`.
- **Repos combine as OR** (a task passes if it touches any selected repo); the three filter *types* (repo, text, status) combine as AND.
- **The `useComboFilter` refactor must be behaviour-preserving for `RepoPicker`** — `test/webview/RepoPicker.test.tsx` (10 cases) must stay green untouched.
- **Settings apply on refresh/reload** — there is no `onDidChangeConfiguration` watcher, consistent with all current settings.
- **TDD, frequent commits.** Each task ends green (`npm test` for the files it touched, plus `npm run typecheck`) and is committed.

---

## File Structure

- `src/types.ts` — `FilterVisibility` gains `search: boolean`.
- `src/config.ts` — read `filters.search`.
- `package.json` — add `agentFlow.filters.search` contribution; update `agentFlow.filters.repo` description; add `fuse.js` to `dependencies`.
- `src/webview/App.tsx` — `useComboFilter` hook; `RepoPicker` refactored onto it; new `RepoMultiSelect` component + `FilterIcon`; fuzzy search input; new state (`selectedRepos`, `textQuery`), filter/sort logic, `canReorder`, empty-state copy.
- `src/webview/styles.ts` — CSS for `.repo-select` (trigger/popup/checkbox) and `.text-search`; remove the old `.repo-filter` block.
- Tests: `test/unit/config.test.ts`, `test/unit/tasksView.test.ts`, `test/webview/App.test.tsx`. (`test/webview/RepoPicker.test.tsx` stays as the refactor's safety net — do not edit it.)

---

## Task 1: Settings & config plumbing for `filters.search`

Widen `FilterVisibility` with a `search` flag and wire it through config + settings. No UI change yet — the `.repo-filter` box still renders exactly as today, so all existing UI tests stay green. This task's job is to make the whole codebase (and its tests) compile and pass with the new field present.

**Files:**
- Modify: `src/types.ts` (`FilterVisibility`, ~lines 8-12)
- Modify: `src/config.ts` (`getConfig().filters`, ~lines 168-172)
- Modify: `package.json` (`contributes.configuration.properties`, ~lines 158-167)
- Modify: `src/webview/App.tsx` (initial `filters` state default, line 93)
- Test: `test/unit/config.test.ts` (filter-visibility + package.json blocks, ~lines 213-247)
- Test: `test/unit/tasksView.test.ts` (8 `state`-message assertions)
- Test: `test/webview/App.test.tsx` (`ALL_FILTERS` constant, line 22)

**Interfaces:**
- Produces: `FilterVisibility = { size: boolean; status: boolean; repo: boolean; search: boolean }`. Every task and test that constructs a `FilterVisibility` must include `search`.

- [ ] **Step 1: Update the config unit tests to expect `search`**

In `test/unit/config.test.ts`, change the three filter-visibility assertions and the package.json default check to include `search`:

```ts
  it("defaults every filter control to visible when nothing is configured", () => {
    expect(getConfig().filters).toEqual({ size: true, status: true, repo: true, search: true });
  });

  it("honors an explicit false for each control", () => {
    setConfig({ "filters.size": false, "filters.status": false, "filters.repo": false, "filters.search": false });
    expect(getConfig().filters).toEqual({ size: false, status: false, repo: false, search: false });
  });

  it("hides one control independently of the others", () => {
    setConfig({ "filters.search": false });
    expect(getConfig().filters).toEqual({ size: true, status: true, repo: true, search: false });
  });
```

And in the `package.json ⇄ config constants` describe block:

```ts
  it("declares the filter-visibility settings with a default of true", () => {
    expect(props["agentFlow.filters.size"].default).toBe(true);
    expect(props["agentFlow.filters.status"].default).toBe(true);
    expect(props["agentFlow.filters.repo"].default).toBe(true);
    expect(props["agentFlow.filters.search"].default).toBe(true);
  });
```

- [ ] **Step 2: Run the config tests to verify they fail**

Run: `npx vitest run test/unit/config.test.ts`
Expected: FAIL — `filters` lacks `search`; `props["agentFlow.filters.search"]` is `undefined`.

- [ ] **Step 3: Add `search` to the `FilterVisibility` type**

In `src/types.ts`:

```ts
export interface FilterVisibility {
  size: boolean;
  status: boolean;
  repo: boolean;
  search: boolean;
}
```

- [ ] **Step 4: Read `filters.search` in config**

In `src/config.ts`, extend the `filters` object:

```ts
    filters: {
      size: c.get<boolean>("filters.size") ?? true,
      status: c.get<boolean>("filters.status") ?? true,
      repo: c.get<boolean>("filters.repo") ?? true,
      search: c.get<boolean>("filters.search") ?? true,
    },
```

- [ ] **Step 5: Declare the setting in `package.json` and update the repo description**

In `package.json` `contributes.configuration.properties`, update the existing `agentFlow.filters.repo` description and add `agentFlow.filters.search` immediately after it:

```json
        "agentFlow.filters.repo": {
          "type": "boolean",
          "default": true,
          "description": "Show the repo multiselect filter in the task-pool sidebar. Turn off to hide it. Applies on refresh/reload."
        },
        "agentFlow.filters.search": {
          "type": "boolean",
          "default": true,
          "description": "Show the fuzzy title search box in the task-pool sidebar. Turn off to hide it. Applies on refresh/reload."
        },
```

- [ ] **Step 6: Update the webview's initial `filters` default**

In `src/webview/App.tsx` line 93, add `search: true` so the type compiles and nothing flashes hidden before the first `state` message:

```tsx
  const [filters, setFilters] = React.useState<FilterVisibility>({ size: true, status: true, repo: true, search: true });
```

- [ ] **Step 7: Update the two shared test constants**

In `test/webview/App.test.tsx` line 22:

```ts
const ALL_FILTERS = { size: true, status: true, repo: true, search: true };
```

In `test/unit/tasksView.test.ts`, update **every** `filters: { size: true, status: true, repo: true }` (the fixture at ~line 62 and all 7 `state`-message assertions) to `filters: { size: true, status: true, repo: true, search: true }`. Find them with:

Run: `grep -n "size: true, status: true, repo: true" test/unit/tasksView.test.ts`

- [ ] **Step 8: Run the full test suite + typecheck to verify green**

Run: `npm run typecheck && npm test`
Expected: PASS — all suites green; no TS errors.

- [ ] **Step 9: Commit**

```bash
git add src/types.ts src/config.ts package.json src/webview/App.tsx test/unit/config.test.ts test/unit/tasksView.test.ts test/webview/App.test.tsx
git commit -m "feat: add filters.search visibility setting"
```

---

## Task 2: Extract `useComboFilter` hook; refactor `RepoPicker` onto it

Pull the command-palette scaffolding (open/query/active state, focus-on-open, active-reset, click-outside-close, Arrow/Enter/Escape handling) out of `RepoPicker` into a reusable `useComboFilter` hook, and rewrite `RepoPicker` to consume it. This is a **behaviour-preserving refactor** — the existing `test/webview/RepoPicker.test.tsx` (10 cases) is the safety net and must stay green **without edits**. Task 3 will build the multiselect on this hook.

**Files:**
- Modify: `src/webview/App.tsx` (add `useComboFilter`; rewrite `RepoPicker`, ~lines 616-698)
- Safety net (do NOT edit): `test/webview/RepoPicker.test.tsx`

**Interfaces:**
- Produces: `useComboFilter(items: string[], onEnter: (item: string) => void)` returning `{ open, setOpen, q, setQ, active, setActive, filtered, inputRef, rootRef, onKeyDown }` where:
  - `open: boolean`, `setOpen: (v: boolean) => void`
  - `q: string`, `setQ: (v: string) => void`
  - `active: number`, `setActive: React.Dispatch<React.SetStateAction<number>>`
  - `filtered: string[]` — `items` case-insensitively substring-matched by `q`
  - `inputRef: React.RefObject<HTMLInputElement>`, `rootRef: React.RefObject<HTMLDivElement>`
  - `onKeyDown: (e: React.KeyboardEvent) => void` — ArrowUp/Down move `active` (clamped), Enter calls `onEnter(filtered[active])`, Escape sets `open` false.
- `RepoPicker`'s public signature (`{ available, onAdd }`) is unchanged.

- [ ] **Step 1: Run the RepoPicker safety-net suite to confirm the starting point is green**

Run: `npx vitest run test/webview/RepoPicker.test.tsx`
Expected: PASS — 10/10 (this suite must still pass identically after the refactor).

- [ ] **Step 2: Add the `useComboFilter` hook**

In `src/webview/App.tsx`, immediately before the `RepoPicker` definition:

```tsx
/** Shared scaffolding for the inline command-palette combos (RepoPicker,
 * RepoMultiSelect): open/query/active state, focus-on-open, active-reset on
 * change, click-outside-to-close, and Arrow/Enter/Escape handling. The consumer
 * supplies what Enter does via `onEnter`. */
export function useComboFilter(items: string[], onEnter: (item: string) => void) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [active, setActive] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);

  const filtered = React.useMemo(
    () => items.filter((r) => r.toLowerCase().includes(q.toLowerCase())),
    [items, q],
  );

  React.useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  React.useEffect(() => setActive(0), [q, open]);
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); if (filtered[active]) onEnter(filtered[active]); }
    else if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
  };

  return { open, setOpen, q, setQ, active, setActive, filtered, inputRef, rootRef, onKeyDown };
}
```

- [ ] **Step 3: Rewrite `RepoPicker` to consume the hook**

Replace the entire existing `RepoPicker` function (from its doc-comment through its closing brace) with:

```tsx
/** Command-palette-style repo picker: filter-as-you-type, keyboard-navigable,
 * inline (no floating popup to get clipped by the card's overflow). */
export function RepoPicker({ available, onAdd }: { available: string[]; onAdd: (name: string) => void }): JSX.Element | null {
  const { open, setOpen, q, setQ, active, setActive, filtered, inputRef, rootRef, onKeyDown } =
    useComboFilter(available, (name) => choose(name));

  const choose = (name: string) => {
    onAdd(name);
    setQ("");
    setActive(0);
    inputRef.current?.focus();
  };

  if (available.length === 0) return null;

  return (
    <div className="repo-picker" ref={rootRef}>
      {!open ? (
        <button className="repo-add" onClick={() => setOpen(true)}>
          <span className="repo-add-plus">+</span> add repo
        </button>
      ) : (
        <div className="repo-combo">
          <div className="repo-search">
            <SearchIcon />
            <input
              ref={inputRef}
              value={q}
              spellCheck={false}
              placeholder="Filter repos…"
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onKeyDown}
            />
          </div>
          <div className="repo-list" role="listbox">
            {filtered.length === 0 && <div className="repo-empty">No repos match “{q}”</div>}
            {filtered.map((r, i) => (
              <div
                key={r}
                role="option"
                aria-selected={i === active}
                className={`repo-row${i === active ? " active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => { e.preventDefault(); choose(r); }}
              >
                <span className="repo-name">{r}</span>
                <span className="repo-add-hint">add ⏎</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

Note: `useComboFilter(available, (name) => choose(name))` receives a wrapper arrow that references `choose`; `choose` is a closure invoked only on later user interaction, so it is defined by the time Enter fires. `useComboFilter` is called unconditionally before the `available.length === 0` early return (Rules of Hooks).

- [ ] **Step 4: Run the safety-net suite + typecheck to verify behaviour is preserved**

Run: `npm run typecheck && npx vitest run test/webview/RepoPicker.test.tsx`
Expected: PASS — 10/10, unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/webview/App.tsx
git commit -m "refactor: extract useComboFilter hook from RepoPicker"
```

---

## Task 3: Repo multiselect dropdown

Replace the `.repo-filter` text box with a `RepoMultiSelect` dropdown built on `useComboFilter`. Repo filtering changes from substring-on-`services` to OR-membership over a checkbox list built from the pool's repos. `canReorder` and the empty-state message are updated for the new repo state (text search comes in Task 4).

**Files:**
- Modify: `src/webview/App.tsx` (add `FilterIcon` + `RepoMultiSelect`; `App` state + JSX + filter logic)
- Modify: `src/webview/styles.ts` (remove `.repo-filter` block ~lines 53-63; add `.repo-select` styles)
- Test: `test/webview/App.test.tsx`

**Interfaces:**
- Consumes: `useComboFilter` (Task 2); `filters.repo` gates the control.
- Produces:
  - `FilterIcon: () => JSX.Element` (funnel SVG, sibling of `SearchIcon`).
  - `RepoMultiSelect({ repos: string[]; selected: Set<string>; onToggle: (name: string) => void; onClear: () => void }): JSX.Element | null` — renders `null` when `repos` is empty.
  - App state `selectedRepos: Set<string>` replaces `repoQuery: string`.

- [ ] **Step 1: Write the failing tests for the multiselect**

Add this describe block to `test/webview/App.test.tsx` (uses existing `render`, `authed`, `host`, `mkTask`, `fireEvent`, `screen`):

```tsx
describe("repo multiselect", () => {
  const threeRepos = () =>
    host({
      type: "tasks",
      filter: "mine",
      tasks: [
        mkTask({ key: "ASM-1", summary: "alpha", services: ["billing"] }),
        mkTask({ key: "ASM-2", summary: "bravo", services: ["web"] }),
        mkTask({ key: "ASM-3", summary: "charlie", services: ["billing", "worker"] }),
      ],
    });

  it("renders the trigger with the 'Filter repos' label, not the old text box", () => {
    render(<App />);
    authed();
    threeRepos();
    expect(document.querySelector(".repo-filter")).toBeNull();
    expect(document.querySelector(".repo-select")).not.toBeNull();
    expect(screen.getByText("Filter repos")).toBeInTheDocument();
  });

  it("lists the sorted, de-duped union of repos when opened", () => {
    render(<App />);
    authed();
    threeRepos();
    fireEvent.click(screen.getByText("Filter repos"));
    const opts = Array.from(document.querySelectorAll(".repo-opt .repo-name")).map((e) => e.textContent);
    expect(opts).toEqual(["billing", "web", "worker"]);
  });

  it("OR-filters the list to tasks touching any selected repo", () => {
    render(<App />);
    authed();
    threeRepos();
    fireEvent.click(screen.getByText("Filter repos"));
    fireEvent.mouseDown(screen.getByText("billing").closest(".repo-opt")!);
    expect(screen.getByText("ASM-1")).toBeInTheDocument(); // billing
    expect(screen.getByText("ASM-3")).toBeInTheDocument(); // billing + worker
    expect(screen.queryByText("ASM-2")).not.toBeInTheDocument(); // web only
  });

  it("Clear resets the selection and restores the full list", () => {
    render(<App />);
    authed();
    threeRepos();
    fireEvent.click(screen.getByText("Filter repos"));
    fireEvent.mouseDown(screen.getByText("web").closest(".repo-opt")!); // only ASM-2 touches web
    expect(screen.queryByText("ASM-1")).not.toBeInTheDocument();
    fireEvent.mouseDown(screen.getByText("Clear"));
    expect(screen.getByText("ASM-1")).toBeInTheDocument();
    expect(screen.getByText("ASM-2")).toBeInTheDocument();
    expect(screen.getByText("ASM-3")).toBeInTheDocument();
  });

  it("hides the multiselect when filters.repo is off", () => {
    render(<App />);
    authed("PR initiated", { size: true, status: true, repo: false, search: true });
    host({ type: "tasks", filter: "mine", tasks: [mkTask({ key: "ASM-1", services: ["web"] })] });
    expect(document.querySelector(".repo-select")).toBeNull();
  });
});
```

Also update the pre-existing filter-visibility tests that reference `.repo-filter`:
- In `"shows Size, Status, and Repo controls by default"` change `expect(document.querySelector(".repo-filter")).not.toBeNull();` → `expect(document.querySelector(".repo-select")).not.toBeNull();`
- Delete the old `"hides the Repo search box when filters.repo is off"` test (replaced by `"hides the multiselect when filters.repo is off"` above).
- In the remaining `off({ size: false })` and `off({ status: false })` tests, change their `.repo-filter` assertions to `.repo-select`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/webview/App.test.tsx`
Expected: FAIL — `.repo-select` not found; `RepoMultiSelect` undefined.

- [ ] **Step 3: Add the `FilterIcon` next to `SearchIcon`**

In `src/webview/App.tsx`, after the `SearchIcon` definition (~line 52):

```tsx
const FilterIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
    <path fill="currentColor" d="M1 2.5h14L9.4 8.7v4.2l-2.8 1.6V8.7z" />
  </svg>
);
```

- [ ] **Step 4: Swap `repoQuery` state for `selectedRepos` and derive the repo list**

In `App`, replace `const [repoQuery, setRepoQuery] = React.useState("");` (line 96) with:

```tsx
  const [selectedRepos, setSelectedRepos] = React.useState<Set<string>>(new Set());
  const toggleRepo = (name: string) =>
    setSelectedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  const clearRepos = () => setSelectedRepos(new Set());
```

Add a memoized repo list near `availableStatuses` (~line 242):

```tsx
  // The repos in play across the current pool — options for the multiselect.
  const allRepos = React.useMemo(
    () => [...new Set(tasks.flatMap((t) => t.services ?? []))].sort((a, b) => a.localeCompare(b)),
    [tasks],
  );
```

- [ ] **Step 5: Update the visible-task filter, `canReorder`, and empty state**

Replace the repoQuery-based block (lines 253-259) with:

```tsx
  // Narrow the current pool to tasks touching any selected repo (OR), and, if a
  // status lens is active, to the selected statuses.
  const visibleTasks = tasks.filter(
    (t) =>
      (selectedRepos.size === 0 || (t.services ?? []).some((s) => selectedRepos.has(s))) &&
      matchesStatus(t, statuses),
  );
  // Reorder only makes sense on the full My-sprint list, not a filtered subset.
  const canReorder = filter === "mysprint" && selectedRepos.size === 0 && statuses.size === 0;
```

Replace the empty-state message body (lines 388-392) with:

```tsx
          {selectedRepos.size > 0
            ? "No tasks touch the selected repos."
            : statuses.size > 0
              ? "No tasks match the selected status."
              : "No tasks in this view."}
```

- [ ] **Step 6: Replace the `.repo-filter` JSX with the multiselect**

Replace the `{filters.repo && (…)}` block (lines 362-375) with:

```tsx
      {filters.repo && (
        <RepoMultiSelect
          repos={allRepos}
          selected={selectedRepos}
          onToggle={toggleRepo}
          onClear={clearRepos}
        />
      )}
```

- [ ] **Step 7: Add the `RepoMultiSelect` component**

At the end of `src/webview/App.tsx`, after `RepoPicker`:

```tsx
/** Multiselect repo filter: a trigger that opens an inline checkbox list —
 * filter-as-you-type, keyboard-navigable, OR-combining. Inline (no floating
 * popup) so the list overflow can't clip it. Renders nothing when the pool has
 * no repos. Shares its command-palette scaffolding with RepoPicker via
 * useComboFilter; Enter toggles the active repo (the combo stays open). */
export function RepoMultiSelect({
  repos,
  selected,
  onToggle,
  onClear,
}: {
  repos: string[];
  selected: Set<string>;
  onToggle: (name: string) => void;
  onClear: () => void;
}): JSX.Element | null {
  const { open, setOpen, q, setQ, active, setActive, filtered, inputRef, rootRef, onKeyDown } =
    useComboFilter(repos, onToggle);

  if (repos.length === 0) return null;

  return (
    <div className="repo-select" ref={rootRef}>
      <button className="repo-select-trigger" onClick={() => setOpen(!open)}>
        <FilterIcon />
        <span className={`repo-select-label${selected.size ? "" : " placeholder"}`}>Filter repos</span>
        {selected.size > 0 && <span className="repo-count">{selected.size}</span>}
        <span className="repo-select-caret">▾</span>
      </button>
      {open && (
        <div className="repo-pop">
          <div className="repo-search">
            <SearchIcon />
            <input
              ref={inputRef}
              value={q}
              spellCheck={false}
              placeholder="Filter repos…"
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onKeyDown}
            />
          </div>
          <div className="repo-list" role="listbox">
            {filtered.length === 0 && <div className="repo-empty">No repos match “{q}”</div>}
            {filtered.map((r, i) => {
              const on = selected.has(r);
              return (
                <div
                  key={r}
                  role="option"
                  aria-selected={on}
                  className={`repo-opt${i === active ? " active" : ""}${on ? " checked" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => { e.preventDefault(); onToggle(r); }}
                >
                  <span className="repo-box">{on ? "✓" : ""}</span>
                  <span className="repo-name">{r}</span>
                </div>
              );
            })}
          </div>
          <div className="repo-pop-foot">
            <span>{selected.size} selected</span>
            <button className="repo-clear-all" onMouseDown={(e) => { e.preventDefault(); onClear(); }}>Clear</button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Add styles; remove the old `.repo-filter` block**

In `src/webview/styles.ts`, delete the `.repo-filter` … `.repo-filter-clear:hover` block (lines 53-63) and insert:

```css
  .repo-select { position: relative; margin: 0 2px 10px; }
  .repo-select-trigger { display: flex; align-items: center; gap: 7px; width: 100%;
    padding: 5px 9px; border-radius: 8px; border: 1px solid var(--vscode-panel-border);
    background: var(--vscode-input-background, transparent); cursor: pointer;
    color: var(--vscode-input-foreground, var(--vscode-foreground));
    font-family: var(--vscode-font-family); font-size: 12px; text-align: left; }
  .repo-select-trigger:hover { border-color: var(--vscode-focusBorder); }
  .repo-select-trigger svg { flex: none; opacity: .55; }
  .repo-select-label { flex: 1; min-width: 0; }
  .repo-select-label.placeholder { color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground)); }
  .repo-count { flex: none; font-size: 10px; line-height: 1; padding: 1px 6px; border-radius: 9px;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .repo-select-caret { flex: none; opacity: .6; font-size: 10px; }

  .repo-pop { position: absolute; z-index: 10; top: calc(100% + 4px); left: 0; right: 0;
    border: 1px solid var(--vscode-focusBorder); border-radius: 8px; overflow: hidden;
    background: var(--vscode-input-background, var(--vscode-editor-background));
    box-shadow: 0 6px 20px rgba(0,0,0,.35); animation: repo-in .12s ease; }
  .repo-opt { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 5px;
    cursor: pointer; color: var(--vscode-foreground); }
  .repo-opt.active { background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground); }
  .repo-box { flex: none; width: 14px; height: 14px; border-radius: 3px;
    border: 1px solid var(--vscode-checkbox-border, var(--vscode-panel-border));
    display: flex; align-items: center; justify-content: center; font-size: 10px; }
  .repo-opt.checked .repo-box { background: var(--vscode-button-background);
    color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); }
  .repo-pop-foot { display: flex; justify-content: space-between; align-items: center;
    padding: 6px 10px; border-top: 1px solid var(--vscode-panel-border);
    font-size: 11px; color: var(--vscode-descriptionForeground); }
  .repo-clear-all { background: none; border: none; cursor: pointer; padding: 0; font-size: 11px;
    color: var(--vscode-textLink-foreground); }
```

(The `.repo-search`, `.repo-list`, `.repo-empty`, and `repo-in` keyframe already exist and are reused.)

- [ ] **Step 9: Run tests + typecheck to verify green**

Run: `npm run typecheck && npx vitest run test/webview/App.test.tsx test/webview/RepoPicker.test.tsx`
Expected: PASS — all repo-multiselect and visibility tests green; RepoPicker suite still 10/10.

- [ ] **Step 10: Commit**

```bash
git add src/webview/App.tsx src/webview/styles.ts test/webview/App.test.tsx
git commit -m "feat: repo multiselect dropdown replaces repo text filter"
```

---

## Task 4: Fuzzy title search (fuse.js)

Add the `Search title…` box below the multiselect, powered by fuse.js over each task's `summary`. When the box has text, the visible list is ordered by fuse relevance. Finalize `canReorder` and the empty-state priority to account for text search. Install fuse.js from the public registry.

**Files:**
- Modify: `package.json` / `package-lock.json` (add `fuse.js`)
- Modify: `src/webview/App.tsx` (import Fuse, `textQuery` state, Fuse memo, search JSX, sort, `canReorder`, empty state)
- Modify: `src/webview/styles.ts` (add `.text-search`)
- Test: `test/webview/App.test.tsx`

**Interfaces:**
- Consumes: `FilterVisibility.search` gates the box; `selectedRepos` / `statuses` predicates from Task 3.
- Produces: App state `textQuery: string`; visible list ordered by fuse score when `textQuery.trim()` is non-empty.

- [ ] **Step 1: Install fuse.js from the public registry**

Run: `npm install fuse.js --registry https://registry.npmjs.org`

Then verify the lockfile resolves it publicly:

Run: `grep -A3 '"node_modules/fuse.js"' package-lock.json | grep resolved`
Expected: a `"resolved": "https://registry.npmjs.org/fuse.js/-/fuse.js-...tgz"` line. If it points anywhere else (e.g. `codeartifact`), fix `~/.npmrc`/lockfile and reinstall — CI will `E401` otherwise.

- [ ] **Step 2: Write the failing tests for fuzzy search**

Add to `test/webview/App.test.tsx`:

```tsx
describe("fuzzy title search", () => {
  const keys = () => Array.from(document.querySelectorAll("a.key")).map((e) => e.textContent);
  const pool = () =>
    host({
      type: "tasks",
      filter: "mine",
      tasks: [
        mkTask({ key: "ASM-1", summary: "Fix rate limiter dropping bursts", services: ["api"] }),
        mkTask({ key: "ASM-2", summary: "Billing webhook retries", services: ["billing"] }),
        mkTask({ key: "ASM-3", summary: "Rate-limit config per tenant", services: ["api"] }),
      ],
    });

  it("narrows the list to fuzzy title matches", () => {
    render(<App />);
    authed();
    pool();
    fireEvent.change(screen.getByPlaceholderText("Search title…"), { target: { value: "ratelim" } });
    expect(keys()).toEqual(expect.arrayContaining(["ASM-1", "ASM-3"]));
    expect(screen.queryByText("ASM-2")).not.toBeInTheDocument();
  });

  it("shows a text-specific empty state when nothing matches", () => {
    render(<App />);
    authed();
    pool();
    fireEvent.change(screen.getByPlaceholderText("Search title…"), { target: { value: "zzzzz" } });
    expect(screen.getByText(/No titles match/i)).toBeInTheDocument();
  });

  it("combines with the repo multiselect (AND across types)", () => {
    render(<App />);
    authed();
    pool();
    fireEvent.click(screen.getByText("Filter repos"));
    fireEvent.mouseDown(screen.getByText("api").closest(".repo-opt")!);
    fireEvent.change(screen.getByPlaceholderText("Search title…"), { target: { value: "rate" } });
    expect(keys()).toEqual(expect.arrayContaining(["ASM-1", "ASM-3"]));
    expect(screen.queryByText("ASM-2")).not.toBeInTheDocument(); // billing filtered out by repo
  });

  it("hides the search box when filters.search is off", () => {
    render(<App />);
    authed("PR initiated", { size: true, status: true, repo: true, search: false });
    pool();
    expect(screen.queryByPlaceholderText("Search title…")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/webview/App.test.tsx`
Expected: FAIL — no `Search title…` box.

- [ ] **Step 4: Import Fuse and add `textQuery` state**

At the top of `src/webview/App.tsx`:

```tsx
import Fuse from "fuse.js";
```

Add state alongside `selectedRepos`:

```tsx
  const [textQuery, setTextQuery] = React.useState("");
```

- [ ] **Step 5: Build the Fuse index and apply it to the visible list**

Add a memoized Fuse near `allRepos`:

```tsx
  const fuse = React.useMemo(
    () => new Fuse(tasks, { keys: ["summary"], threshold: 0.4, ignoreLocation: true }),
    [tasks],
  );
```

Replace the `visibleTasks` / `canReorder` block from Task 3 with a version that searches first (ordered by score) then applies the repo/status predicates:

```tsx
  const q = textQuery.trim();
  const searched = q ? fuse.search(q).map((r) => r.item) : tasks;
  const visibleTasks = searched.filter(
    (t) =>
      (selectedRepos.size === 0 || (t.services ?? []).some((s) => selectedRepos.has(s))) &&
      matchesStatus(t, statuses),
  );
  const canReorder = filter === "mysprint" && selectedRepos.size === 0 && !q && statuses.size === 0;
```

- [ ] **Step 6: Finalize the empty-state priority (text → repo → status)**

Replace the empty-state message body from Task 3 with:

```tsx
          {q
            ? `No titles match “${q}”.`
            : selectedRepos.size > 0
              ? "No tasks touch the selected repos."
              : statuses.size > 0
                ? "No tasks match the selected status."
                : "No tasks in this view."}
```

- [ ] **Step 7: Add the search box JSX below the multiselect**

Immediately after the `{filters.repo && (…)}` block:

```tsx
      {filters.search && (
        <div className="text-search">
          <SearchIcon />
          <input
            value={textQuery}
            spellCheck={false}
            placeholder="Search title…"
            onChange={(e) => setTextQuery(e.target.value)}
          />
          {textQuery && (
            <span className="text-search-clear" title="Clear search" onClick={() => setTextQuery("")}>×</span>
          )}
        </div>
      )}
```

- [ ] **Step 8: Add `.text-search` styles**

In `src/webview/styles.ts`, after the `.repo-select` styles from Task 3:

```css
  .text-search { display: flex; align-items: center; gap: 7px; margin: 0 2px 10px;
    padding: 4px 9px; border-radius: 8px; border: 1px solid var(--vscode-panel-border);
    background: var(--vscode-input-background, transparent); }
  .text-search:focus-within { border-color: var(--vscode-focusBorder); }
  .text-search svg { flex: none; opacity: .55; }
  .text-search input { flex: 1; min-width: 0; border: none; outline: none; background: transparent;
    color: var(--vscode-input-foreground, var(--vscode-foreground));
    font-family: var(--vscode-font-family); font-size: 12px; }
  .text-search input::placeholder { color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground)); }
  .text-search-clear { cursor: pointer; opacity: .6; font-size: 14px; line-height: 1; padding: 0 2px; }
  .text-search-clear:hover { opacity: 1; }
```

- [ ] **Step 9: Run tests + typecheck + build to verify green**

Run: `npm run typecheck && npm test && npm run build`
Expected: PASS — all suites green; esbuild bundles fuse.js without error.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json src/webview/App.tsx src/webview/styles.ts test/webview/App.test.tsx
git commit -m "feat: fuzzy title search with fuse.js"
```

---

## Self-Review

**Spec coverage:**
- Two controls replacing the single box → Tasks 3 (multiselect) + 4 (search). ✓
- Repo multiselect: funnel icon, "Filter repos" label, count badge, checkbox list, filter-as-you-type, keyboard nav, click-outside, Clear, OR filter, sorted-union options → Task 3. ✓
- Shared scaffolding (DRY, per user decision) → `useComboFilter` in Task 2, consumed by both `RepoPicker` (refactored) and `RepoMultiSelect`. ✓
- Fuzzy title search over `summary` via fuse.js, ordered by relevance, non-search path skips Fuse → Task 4. ✓
- Title-only (description out of scope) → no description code anywhere. ✓
- Settings: `filters.repo` repurposed + new `filters.search`, `FilterVisibility.search`, config read, package.json contribution → Task 1. ✓
- fuse.js public-registry guard → Global Constraints + Task 4 Step 1. ✓
- `canReorder` includes all three filters; empty-state priority text→repo→status → Task 4 Steps 5-6. ✓
- Tests: config defaults, visibility toggles, repo OR-filter, fuzzy narrow+order, combined AND, RepoPicker unchanged → Tasks 1-4. ✓

**Placeholder scan:** No TBD/TODO; every code and test step shows complete content. ✓

**Type consistency:** `FilterVisibility { size, status, repo, search }` used identically in types.ts, config.ts, App default, and all test fixtures. `useComboFilter`'s returned members (`open/setOpen/q/setQ/active/setActive/filtered/inputRef/rootRef/onKeyDown`) are destructured identically in both `RepoPicker` (Task 2) and `RepoMultiSelect` (Task 3). `RepoMultiSelect` prop names (`repos`, `selected`, `onToggle`, `onClear`) match its call site in Task 3 Step 6. `selectedRepos`/`toggleRepo`/`clearRepos`/`textQuery`/`allRepos`/`fuse` names are consistent across steps. ✓
