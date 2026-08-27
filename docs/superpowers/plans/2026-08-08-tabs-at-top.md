# Tabs at the Top Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `Tasks | Notepad` the first row of the sidebar panel by moving the project name and user into VS Code's own view title bar, and give the Notepad's fields the same focus treatment as every other input in the product.

**Architecture:** Three independent changes. The host sets `WebviewView.title` / `.description` from the values it already posts in `postState()`. The webview deletes its `.header` row and rehouses the gauge and Explore button in a trailing group on the tab bar. The sidebar stylesheet gives the two Notepad field classes a resting border and a `:focus` rule, replacing the global `:focus-visible` outline they currently fall through to.

**Tech Stack:** TypeScript, React 18 (webview, bundled by esbuild), Vitest + @testing-library/react, VS Code extension API.

Design spec: `docs/superpowers/specs/2026-08-08-tabs-at-top-design.md`.

## Global Constraints

- Every behavior change carries a test. Coverage thresholds are enforced by `npm run test:cov` (CONTRIBUTING.md).
- `npm run typecheck`, `npm test`, and `npm run build` must all be clean before the branch is done. **`npm run build` is not optional**: `src/webview/` must not import `fs`, `os`, `path`, or `child_process` even transitively, and the esbuild bundle is the only gate that catches it — `tsc` and the full suite pass regardless.
- Every `font-size` in `src/webview/styles.ts` must be `var(--t-*)`, `var(--vscode-*)`, or one of the allowlisted legacy literals `8px 9px 10px 10.5px 11px 11.5px 12px 12.5px 13px 14px 15px`. Enforced by `test/webview/tokens.test.ts` → "type scale". Prefer a `--t-*` token; a bare literal is legacy tolerance, not a licence.
- `src/webview/styles.ts` must never *declare* a custom property that `tokens.ts` owns (`--t-*`, `--r-*`, `--c-*`, `--k-*`, `--hair`, `--edge`, `--mono`, `--dim`, `--brand`, `--brand-ink`) and must never use one that is declared nowhere. Both directions enforced by `tokens.test.ts`.
- No raw hex colours in the sheets (`tokens.test.ts` → "no raw hex colour"). Use `var(--vscode-*)` or a token.
- User-facing changes get an entry under `## [Unreleased]` in `CHANGELOG.md` (CONTRIBUTING.md).
- Do not bump the version or build a `.vsix`. That happens at merge, not here.

---

### Task 1: The view title carries the project and user

VS Code renders the view's title bar above the webview; its text is `WebviewView.title`, defaulting to the `name` in `package.json` ("Tasks"). Point it at the project instead, with the signed-in user as the dim `description` beside it. This is what frees the webview's header row in Task 2.

**Files:**
- Modify: `src/tasksView.ts:179-186` (`postState`)
- Modify: `test/unit/tasksView.test.ts:266-300` (the `setup()` harness returns the fake view) and the `describe("ready")` block at :349

**Interfaces:**
- Consumes: `this.view` (`vscode.WebviewView | undefined`, assigned in `resolveWebviewView` at :160), `this.connector.info().scopeValue` (the project key, `string`), and `postState`'s own `me: string | null` parameter.
- Produces: nothing other tasks import. Task 2 depends only on the *behaviour* — that the project and user are visible in the title bar — not on any new symbol.

**Why `postState` and not `resolveWebviewView`:** `postState` is the single path that re-runs on every auth, config, and refresh change, and it already computes both values. Setting the title anywhere else means a second code path that can go stale. The webview sends `ready` on mount, which reaches `postState`, so the assignment always lands after `resolveWebviewView` and never races it.

- [ ] **Step 1: Expose the fake view to tests**

`setup()` builds a fake `view` object but does not return it. Add `title` and `description` fields to the literal so the shape matches `WebviewView`, and return it.

In `test/unit/tasksView.test.ts`, change the `view` literal (currently starting at line ~284) to:

```ts
  // `title` / `description` are the VS Code view title bar's text — the panel sets
  // them from the same state it posts, so they are asserted like any other output.
  const view = {
    title: "Tasks",
    description: undefined as string | undefined,
    webview: {
      options: {},
      html: "",
      asWebviewUri: (u: unknown) => u,
      cspSource: "vscode-resource:",
      postMessage: post,
      onDidReceiveMessage: (cb: (m: InboundMessage) => Promise<void>) => {
        handler = cb;
        return { dispose() {} };
      },
    },
  };
```

and add `view` to the returned object:

```ts
  return { provider, post, send, posted, messages, logged, auth, connector, workspaceState, globalState, view };
```

- [ ] **Step 2: Write the failing tests**

Add these three tests at the end of the `describe("ready")` block in `test/unit/tasksView.test.ts` (the block starting at line 349):

```ts
  // The panel's own title bar is the identity row. The fixture connector's scope
  // value is "PROJ" (CFG.project) and the Jira client stub's getMyself returns "Jane".
  it("titles the panel with the project and the signed-in user", async () => {
    const { send, view } = setup({ authed: true });
    await send({ type: "ready" });
    expect(view.title).toBe("PROJ");
    expect(view.description).toBe("Jane");
  });

  it("drops the description when nobody is signed in", async () => {
    const { send, view } = setup({ authed: false });
    await send({ type: "ready" });
    expect(view.title).toBe("PROJ");
    expect(view.description).toBeUndefined();
  });

  // A blank title bar holding three floating action icons reads as a rendering
  // failure, so an unset project keeps the package.json name rather than emptying it.
  it("falls back to the view's own name when no project is configured", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, baseUrl: "", project: "" });
    const { send, view } = setup({ authed: true });
    await send({ type: "ready" });
    expect(view.title).toBe("Tasks");
    expect(view.description).toBeUndefined();
  });
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `npx vitest run test/unit/tasksView.test.ts -t "titles the panel"`
Expected: FAIL — `expected 'Tasks' to be 'PROJ'`. The provider never touches `view.title`, so it still holds the literal's initial value.

- [ ] **Step 4: Set the title in `postState`**

In `src/tasksView.ts`, inside `postState` (line 179), after `const info = this.connector.info();` and before the `this.post({...})` call:

```ts
    // VS Code renders the view's own title bar directly above the webview, so the
    // panel's identity belongs there rather than repeated in the first row of our
    // content. Set here, not in resolveWebviewView: postState is the one path that
    // re-runs on every auth, config and refresh change, so the bar cannot go stale.
    // The fallback matters — an unconfigured first run has no project key, and a
    // blank bar holding nothing but three action icons reads as a broken render.
    if (this.view) {
      this.view.title = info.scopeValue || "Tasks";
      this.view.description = me ?? undefined;
    }
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx vitest run test/unit/tasksView.test.ts`
Expected: PASS, whole file green — the existing `describe("ready")` assertions about the posted `state` message must be untouched.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: clean. `WebviewView.description` is `string | undefined`, so `me ?? undefined` is the correct narrowing of `string | null`.

- [ ] **Step 7: Commit**

```bash
git add src/tasksView.ts test/unit/tasksView.test.ts
git commit -m "feat(sidebar): title the view with the project and signed-in user"
```

---

### Task 2: The tab bar becomes the pane's first row

With the identity in the title bar, the webview's `.header` row is redundant. Delete it and rehouse its two surviving controls — the gauge and Explore — in a trailing group on the tab row.

**Files:**
- Modify: `src/webview/App.tsx:489-506` (the `.header` block and the `.tabbar` block)
- Modify: `src/webview/styles.ts:11-13` (delete the `.header` rules), `:149-155` (`.explore`'s `margin-left`), `:283-287` (the `.tabbar` rules)
- Modify: `test/webview/App.test.tsx:61-76`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `GaugeMark` (`{ live?: number; size?: number }`, from `./GaugeMark`) and `CompassIcon` (from `./icons`) — both already imported by `App.tsx`. React state `liveCount`, `tab`, `setTab` already exist at App.tsx:159 and nearby.
- Produces: the CSS class `.tabbar-trail` on the trailing group. Nothing else consumes it.

**Do not delete the `project` or `me` state variables.** They stop rendering in the header but are still read elsewhere: `project` is passed to `Card` (App.tsx:632) and to the component picker (:879), and `me` drives the `isMe` assignee comparison (:733). Removing them breaks the build.

- [ ] **Step 1: Measure the row at 280px before choosing a font size**

The tab row must hold both labels, the gauge, and the Explore button at a 280px sidebar without wrapping or clipping. Write this file to your scratchpad directory as `tabrow.html`:

```html
<!DOCTYPE html><html><head><meta charset="utf-8"><style>
:root {
  --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --vscode-foreground: #cccccc; --vscode-descriptionForeground: #9d9d9d;
  --vscode-sideBar-background: #181818; --vscode-panel-border: #2b2b2b;
  --vscode-focusBorder: #0078d4;
  --dim: var(--vscode-descriptionForeground);
  --edge: color-mix(in srgb, var(--vscode-foreground) 16%, transparent);
  --t-body: 11px; --t-title: 13px; --r-ctl: 6px;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); }
.pane { width: 280px; padding: 8px; }        /* the narrow sidebar, at our own padding */
.tabbar { display: flex; align-items: center; gap: 2px; margin: 0 0 10px;
  border-bottom: 1px solid var(--vscode-panel-border); }
.tabbar button[role="tab"] { background: none; border: none; border-bottom: 2px solid transparent;
  padding: 5px 10px 7px; cursor: pointer; color: var(--dim); font-weight: 500; }
.tabbar button[role="tab"][aria-selected="true"] { color: var(--vscode-foreground);
  font-weight: 600; border-bottom-color: var(--vscode-focusBorder); }
.tabbar-trail { margin-left: auto; display: inline-flex; align-items: center; gap: 7px; padding-bottom: 4px; }
.explore { display: inline-flex; align-items: center; gap: 5px; font-size: var(--t-body);
  font-weight: 500; height: 24px; padding: 0 10px; border-radius: var(--r-ctl);
  border: 1px solid var(--edge); background: transparent; color: var(--vscode-foreground); }
.a button[role="tab"] { font-size: var(--t-title); }
.b button[role="tab"] { font-size: var(--t-body); }
</style></head><body>
<div class="pane"><div class="tabbar a" id="a">
  <button role="tab" aria-selected="true">Tasks</button><button role="tab">Notepad</button>
  <span class="tabbar-trail">
    <svg width="15" height="15" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="#ccc" stroke-width="1.6" stroke-dasharray="2 2"/></svg>
    <button class="explore">◎ Explore</button>
  </span>
</div></div>
<div class="pane"><div class="tabbar b" id="b">
  <button role="tab" aria-selected="true">Tasks</button><button role="tab">Notepad</button>
  <span class="tabbar-trail">
    <svg width="15" height="15" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="#ccc" stroke-width="1.6" stroke-dasharray="2 2"/></svg>
    <button class="explore">◎ Explore</button>
  </span>
</div></div>
<pre id="out" style="color:#0f0;font:12px monospace;padding:8px"></pre>
<script>
  const fits = (id) => {
    const bar = document.getElementById(id);
    const kids = [...bar.children];
    const right = Math.max(...kids.map((k) => k.getBoundingClientRect().right));
    const tops = new Set(kids.map((k) => Math.round(k.getBoundingClientRect().top)));
    return `${id}: rightmost=${right.toFixed(1)} barRight=${bar.getBoundingClientRect().right.toFixed(1)} rows=${tops.size}`;
  };
  document.getElementById("out").textContent = fits("a") + "\n" + fits("b");
</script>
</body></html>
```

Screenshot it and read the numbers:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
  --hide-scrollbars --force-device-scale-factor=2 --window-size=400,260 \
  --virtual-time-budget=3000 --screenshot=<scratchpad>/tabrow.png "file://<scratchpad>/tabrow.html"
```

Read `tabrow.png`. **Decision rule:** if row `a` reports `rows=1` and `rightmost <= barRight`, tab labels use `var(--t-title)`. Otherwise they use `var(--t-body)`. Record which you got and why in the commit message. Do not let the bar wrap — a wrapped tab bar stops reading as one control.

Everything below writes `TAB_FONT` where that decision goes.

- [ ] **Step 2: Write the failing tests**

In `test/webview/App.test.tsx`, replace the two tests at lines 61-76 — `it("renders the project + user header and the task list when authenticated", ...)` and `it("reports open windows on the header gauge", ...)` — with the four below. Leave `it("falls back to the static mark when the host reports no count", ...)` that follows them untouched; the gauge still renders, only its parent changed.

```ts
  // The project name and the signed-in user moved to the VS Code view title bar
  // (tasksView.postState) — asserting they are ABSENT here is what stops the old
  // header from creeping back in beside the tabs.
  it("renders the task list, with the identity left to the view title bar", () => {
    render(<App />);
    authed();
    host({ type: "tasks", filter: "unassigned", tasks: [mkTask({ key: "PROJ-1", summary: "Fix the bug" })] });
    expect(screen.getByText("PROJ-1")).toBeInTheDocument();
    expect(screen.getByText("Fix the bug")).toBeInTheDocument();
    expect(screen.queryByText("Jane")).not.toBeInTheDocument();
    expect(document.querySelector(".header")).toBeNull();
  });

  it("keeps the gauge and Explore in the tab row on both tabs", () => {
    render(<App />);
    host({ type: "state", sourceLabel: "Jira", caps: JIRA_CAPS, authed: true, configured: true, project: "PROJ", me: "Jane",
           prReviewStatus: "PR initiated", filters: ALL_FILTERS, liveCount: 2 });
    const trail = () => document.querySelector(".tabbar .tabbar-trail") as HTMLElement;
    expect(trail()).not.toBeNull();
    expect(within(trail()).getByRole("img", { name: "2 Agent Flow windows open" })).toBeInTheDocument();
    expect(within(trail()).getByRole("button", { name: /Explore/ })).toBeInTheDocument();

    // Explore starts a session on repos, not on a ticket, and the gauge counts open
    // windows — neither belongs to one tab, so both survive the switch to Notepad.
    fireEvent.click(screen.getByRole("tab", { name: "Notepad" }));
    expect(within(trail()).getByRole("img", { name: "2 Agent Flow windows open" })).toBeInTheDocument();
    expect(within(trail()).getByRole("button", { name: /Explore/ })).toBeInTheDocument();
  });

  it("puts the tab row before the task list in the document", () => {
    render(<App />);
    authed();
    host({ type: "tasks", filter: "unassigned", tasks: [mkTask({ key: "PROJ-1", summary: "Fix the bug" })] });
    const tabbar = document.querySelector(".tabbar")!;
    const lenses = document.querySelector(".lenses")!;
    // Node.DOCUMENT_POSITION_FOLLOWING === 4: `lenses` comes after `tabbar`.
    expect(tabbar.compareDocumentPosition(lenses) & 4).toBeTruthy();
  });
```

Confirm `within` and `fireEvent` are in the file's `@testing-library/react` import at the top; add `within` if it is missing.

- [ ] **Step 3: Run them and confirm they fail**

Run: `npx vitest run test/webview/App.test.tsx -t "tab row"`
Expected: FAIL — `.tabbar-trail` does not exist yet, so `trail()` is null and `within(null)` throws.

- [ ] **Step 4: Rewrite the header and tab bar in `App.tsx`**

In `src/webview/App.tsx`, replace lines 491-506 (the `<div className="header">` block through the closing `</div>` of `<div className="tabbar">`) with:

```tsx
      {/* The panel's first row. The project name and user live in the VS Code view
          title bar above this (tasksView.postState), so the tabs are the first thing
          in our own content. The gauge and Explore trail them on both tabs: Explore
          starts a session on repos rather than on a ticket, and the gauge counts open
          windows — neither is a Tasks-only concern. */}
      <div className="tabbar" role="tablist" aria-label="Panel view">
        <button role="tab" aria-selected={tab === "tasks"} onClick={() => setTab("tasks")}>Tasks</button>
        <button role="tab" aria-selected={tab === "notepad"} onClick={() => setTab("notepad")}>Notepad</button>
        <span className="tabbar-trail">
          <GaugeMark live={liveCount} />
          <button
            className="explore"
            onClick={() => send({ type: "explore" })}
            title="Explore repos with a Claude Code agent — pick repos, no ticket needed"
          >
            <CompassIcon /> Explore
          </button>
        </span>
      </div>
```

- [ ] **Step 5: Update the stylesheet**

In `src/webview/styles.ts`:

Delete the three `.header` rules at lines 11-13.

In the `.explore, .address-pr, .sprint-add, .sprint-remove, .quiet` group at :149-155, delete the standalone line:

```css
  .explore { margin-left: auto; }
```

`.tabbar-trail` now owns the push to the right; leaving `margin-left: auto` on `.explore` would fight it inside the trail's own flex box.

Replace the `.tabbar` rules at :283-287 with:

```css
  /* The panel's first row, and its title element — the VS Code view title bar above
     it carries the project and user (tasksView.postState), so nothing repeats here.
     Tab styling is scoped to [role="tab"] because the trailing group holds a real
     button (Explore) that must keep the shared .explore language, not become a tab. */
  .tabbar { display: flex; align-items: center; gap: 2px; margin: 0 0 10px;
    border-bottom: 1px solid var(--vscode-panel-border); }
  .tabbar button[role="tab"] { background: none; border: none; border-bottom: 2px solid transparent;
    padding: 5px 10px 7px; cursor: pointer; color: var(--dim); font-size: TAB_FONT; font-weight: 500; }
  .tabbar button[role="tab"][aria-selected="true"] { color: var(--vscode-foreground); font-weight: 600;
    border-bottom-color: var(--vscode-focusBorder); }
  .tabbar-trail { margin-left: auto; display: inline-flex; align-items: center; gap: 7px;
    padding-bottom: 4px; }
```

Substitute `TAB_FONT` with `var(--t-title)` or `var(--t-body)` per Step 1's measurement.

- [ ] **Step 6: Run the webview suite**

Run: `npx vitest run test/webview/`
Expected: PASS. `tokens.test.ts` must stay green — if it fails on "every font-size is a token or an allowlisted legacy literal", you substituted a bare literal for `TAB_FONT` instead of a token.

- [ ] **Step 7: Run the full suite, typecheck, and build**

Run: `npm test && npm run typecheck && npm run build`
Expected: all clean. The build is the gate that catches a Node-only import reaching `src/webview/`; nothing here should add one, and a failure means something else went wrong.

- [ ] **Step 8: Add the CHANGELOG entry**

Under `## [Unreleased]` in `CHANGELOG.md`, add:

```markdown
- **Tabs at the top of the sidebar.** `Tasks | Notepad` is now the panel's first row, with the project and signed-in user moved into the view's own title bar. The panel is a row shorter on both tabs, and "Tasks" is no longer said twice.
```

- [ ] **Step 9: Commit**

```bash
git add src/webview/App.tsx src/webview/styles.ts test/webview/App.test.tsx CHANGELOG.md
git commit -m "feat(sidebar): make the tab bar the panel's first row"
```

Name the Step 1 measurement in the commit body, e.g. `Tab labels at --t-title: the row measures one line at 280px.`

---

### Task 3: The Notepad fields join the house focus style

`.np-title-input` and `.np-body-input` carry a transparent resting border, so a focused field falls through to the global `:focus-visible` rule in `tokens.ts:67` — an outline sitting 2px clear of the field, at a 4px radius against the field's own 6px. Every other text input in the panel (`.text-search input`, `.repo-search input`) suppresses that outline and moves focus onto a border instead.

**Files:**
- Modify: `src/webview/styles.ts:296-300`
- Modify: `test/webview/tokens.test.ts` (new `describe` block at the end)
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `ruleBlocks(sheet)` from `test/webview/tokens.test.ts` — already defined there at line ~42, returning `{ selector: string; body: string }[]` with whitespace collapsed in `selector`.
- Produces: nothing other tasks consume.

- [ ] **Step 1: Write the failing test**

Append to `test/webview/tokens.test.ts`:

```ts
describe("notepad fields", () => {
  // The panel has one focus language: suppress the UA outline, move focus onto the
  // control's own border (see .text-search:focus-within). The notepad's two fields
  // were the only ones that skipped it and fell through to the global :focus-visible
  // rule in tokens.ts — a detached halo, 2px off the field, at the wrong radius.
  it("focus on the field's own border, not the global outline", () => {
    const focus = ruleBlocks(CSS).find((r) => r.selector === ".np-title-input:focus, .np-body-input:focus");
    expect(focus).toBeDefined();
    expect(focus!.body).toMatch(/outline:\s*none/);
    expect(focus!.body).toMatch(/border-color:\s*var\(--vscode-focusBorder\)/);
  });

  // Load-bearing: without a resting border the focused one materializes out of
  // nothing, which reads as the field jumping rather than lighting up.
  it("carry a resting border for that focus border to replace", () => {
    const rest = ruleBlocks(CSS).find((r) => r.selector === ".np-title-input, .np-body-input");
    expect(rest).toBeDefined();
    expect(rest!.body).not.toMatch(/border:\s*1px solid var\(--vscode-input-border,\s*transparent\)/);
    expect(rest!.body).toMatch(/border:\s*1px solid var\(--vscode-input-border,\s*var\(--hair\)\)/);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/webview/tokens.test.ts -t "notepad fields"`
Expected: FAIL — both. The `:focus` rule does not exist (`expect(focus).toBeDefined()`), and the resting rule still reads `transparent`.

- [ ] **Step 3: Update the stylesheet**

In `src/webview/styles.ts`, replace the `.np-title-input, .np-body-input` rule at :296-299 with:

```css
  /* One focus language for the whole panel: suppress the UA outline and move focus
     onto the control's own border, exactly as .text-search:focus-within does. The
     resting hairline is load-bearing — without it the border appears out of nothing
     on focus, which reads as the field jumping rather than lighting up. */
  .np-title-input, .np-body-input { width: 100%; padding: 5px 7px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--hair)); border-radius: var(--r-ctl);
    font-family: inherit; font-size: var(--t-body); }
  .np-title-input:focus, .np-body-input:focus { outline: none;
    border-color: var(--vscode-focusBorder); }
```

Both classes are shared with a note row's edit state (`Notepad.tsx:132-133`), so this reaches every field in the Notepad, not just the add form.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run test/webview/tokens.test.ts test/webview/Notepad.test.tsx`
Expected: PASS.

- [ ] **Step 5: Verify it visually**

Write this to your scratchpad as `npfocus.html`. `.is-focused` stands in for `:focus`, since a headless screenshot has no focused element:

```html
<!DOCTYPE html><html><head><meta charset="utf-8"><style>
:root {
  --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --vscode-foreground: #cccccc; --vscode-descriptionForeground: #9d9d9d;
  --vscode-sideBar-background: #181818; --vscode-panel-border: #2b2b2b;
  --vscode-focusBorder: #0078d4; --vscode-input-background: #313131;
  --vscode-input-foreground: #cccccc;
  --hair: var(--vscode-panel-border); --t-body: 11px; --r-ctl: 6px;
}
* { box-sizing: border-box; }
body { margin: 0; padding: 14px; width: 300px; background: var(--vscode-sideBar-background);
  font-family: var(--vscode-font-family); display: flex; flex-direction: column; gap: 12px; }
.np-title-input, .np-body-input { width: 100%; padding: 5px 7px;
  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, var(--hair)); border-radius: var(--r-ctl);
  font-family: inherit; font-size: var(--t-body); }
.is-focused { outline: none; border-color: var(--vscode-focusBorder); }
.text-search { display: flex; align-items: center; gap: 7px; padding: 4px 9px; border-radius: 8px;
  border: 1px solid var(--vscode-panel-border); background: var(--vscode-input-background); }
.text-search.is-focused { border-color: var(--vscode-focusBorder); }
.text-search input { flex: 1; border: none; outline: none; background: transparent;
  color: var(--vscode-input-foreground); font-family: inherit; font-size: 12px; }
label { color: #7d7d7d; font: 10px/1 system-ui; letter-spacing: .06em; text-transform: uppercase; }
</style></head><body>
<label>notepad title — focused</label>
<input class="np-title-input is-focused" value="Chase the flaky poll test">
<label>notepad body — focused</label>
<textarea class="np-body-input is-focused" rows="2">Only fails after a cold cache.</textarea>
<label>task search — focused (the house style)</label>
<div class="text-search is-focused"><span style="opacity:.55">&#9906;</span><input value="rate limit"></div>
<label>notepad title — at rest</label>
<input class="np-title-input" value="Write up the tab redesign">
</body></html>
```

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
  --hide-scrollbars --force-device-scale-factor=2 --window-size=340,320 \
  --virtual-time-budget=3000 --screenshot=<scratchpad>/npfocus.png "file://<scratchpad>/npfocus.html"
```

Read `npfocus.png`. Expected: the two focused Notepad fields and the focused search field all carry a 1px border in the same hue, drawn on the control's own edge — no detached ring, no gap between border and field. The at-rest field shows a visible hairline, so focus reads as a colour change rather than a border appearing.

- [ ] **Step 6: Run the full suite, typecheck, and build**

Run: `npm test && npm run typecheck && npm run build`
Expected: all clean.

- [ ] **Step 7: Add the CHANGELOG entry**

Under `## [Unreleased]` in `CHANGELOG.md`, add:

```markdown
- **Notepad fields focus like every other input.** The title and detail fields lit up with a detached outline in the theme's focus hue; they now move focus onto their own border, matching the task search and repo picker.
```

- [ ] **Step 8: Commit**

```bash
git add src/webview/styles.ts test/webview/tokens.test.ts CHANGELOG.md
git commit -m "fix(notepad): focus fields on their own border, like every other input"
```

---

## Done when

- [ ] `npm test` — full suite green (baseline was 2305 tests across 82 files; the count changes as tests are added, none regress).
- [ ] `npm run test:cov` — thresholds met.
- [ ] `npm run typecheck` — clean.
- [ ] `npm run build` — succeeds.
- [ ] `CHANGELOG.md` carries both entries under `## [Unreleased]`.
- [ ] The panel, checked in an Extension Development Host: the view title bar reads the project key with the user beside it, `Tasks | Notepad` is the first row of the webview with the gauge and Explore trailing it, and focusing a Notepad field draws a border rather than a halo.
