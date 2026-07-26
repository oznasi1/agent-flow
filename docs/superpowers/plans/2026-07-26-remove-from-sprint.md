# Remove from sprint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-card "Remove from sprint" action on the My sprint tab that moves the ticket to the backlog, with a native VS Code Undo notification.

**Architecture:** A new Jira client write (`removeIssueFromSprint`) posts to the Agile backlog endpoint. A host handler (`removeFromSprint`) in `TasksViewProvider` orchestrates the write, provenance-label stamp, saved-order prune, card removal, and the Undo re-add. The webview renders a Remove button gated to the My sprint tab and drops the card when the host confirms.

**Tech Stack:** TypeScript, React (webview), VS Code extension API, Vitest + @testing-library/react.

## Global Constraints

- Runtime dependencies stay `react` + `react-dom` only — no new packages.
- Jira writes stamp `cfg.provenanceLabel` (default `"claude-code"`) when `cfg.stampLabelOnWrite`, best-effort (never fail the operation on a label error).
- Removal is **host-confirmed** (card removed only after the write succeeds), mirroring `addToMySprint`.
- The action is **My sprint tab only** (`filter === "mysprint"`).
- Test runner: `npx vitest run` (single file: `npx vitest run <path>`).

---

### Task 1: Jira client — `removeIssueFromSprint`

**Files:**
- Modify: `src/jira/client.ts` (add method after `addIssueToSprint`, ~line 219)
- Test: `test/unit/jira/client.test.ts` (add to the `describe("write methods", …)` block, ~line 373)

**Interfaces:**
- Produces: `JiraClient.removeIssueFromSprint(key: string): Promise<void>` — POSTs `/rest/agile/1.0/backlog/issue` with body `{ issues: [key] }`.

- [ ] **Step 1: Write the failing test**

Add inside `describe("write methods", …)` in `test/unit/jira/client.test.ts`:

```ts
it("removeIssueFromSprint posts the key to the backlog", async () => {
  const fetchMock = installFetch([emptyResponse()]);
  await client().removeIssueFromSprint("ASM-1");
  expect(urlOf(fetchMock, 0)).toBe(`${BASE}/rest/agile/1.0/backlog/issue`);
  expect(fetchMock.mock.calls[0][1].method).toBe("POST");
  expect(bodyOf(fetchMock, 0)).toEqual({ issues: ["ASM-1"] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/jira/client.test.ts -t "removeIssueFromSprint"`
Expected: FAIL — `client().removeIssueFromSprint is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/jira/client.ts`, immediately after the `addIssueToSprint` method (~line 219):

```ts
/** Move an issue to the backlog — removes it from any active/future sprint (Jira Agile WRITE). */
async removeIssueFromSprint(key: string): Promise<void> {
  await this.request(`/rest/agile/1.0/backlog/issue`, {
    method: "POST",
    body: JSON.stringify({ issues: [key] }),
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/jira/client.test.ts -t "removeIssueFromSprint"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/jira/client.ts test/unit/jira/client.test.ts
git commit -m "feat(jira): removeIssueFromSprint moves an issue to the backlog"
```

---

### Task 2: Message types + host handler + Undo

**Files:**
- Modify: `src/types.ts` (InboundMessage ~line 152, OutboundMessage ~line 176)
- Modify: `src/tasksView.ts` (new `case "removeFromSprint"` in `onMessage` ~line 194; new `removeFromSprint` method after `addToMySprint` ~line 303)
- Test: `test/unit/tasksView.test.ts` (extend `makeClient` ~line 88; new `describe("removeFromSprint", …)` after the `addToMySprint` block ~line 343)

**Interfaces:**
- Consumes: `JiraClient.removeIssueFromSprint` (Task 1); existing `getActiveSprintId`, `addIssueToSprint`, `addLabel`.
- Produces:
  - Inbound message `{ type: "removeFromSprint"; key: string; size: Size }`
  - Outbound message `{ type: "removedFromSprint"; key: string }`
  - `TasksViewProvider.removeFromSprint(key: string, size: Size): Promise<void>`

- [ ] **Step 1: Add the message types**

In `src/types.ts`, add to `InboundMessage` (after the `resetOrder` line ~152):

```ts
  | { type: "removeFromSprint"; key: string; size: Size }
```

Add to `OutboundMessage` (after the `movedToSprint` line ~176):

```ts
  | { type: "removedFromSprint"; key: string }
```

(`Size` is already imported/defined in this file — it is used by `fetch` and `resetOrder`.)

- [ ] **Step 2: Extend the test client stub**

In `test/unit/tasksView.test.ts`, add to the object returned by `makeClient()` (~line 87, alongside `addIssueToSprint`):

```ts
    removeIssueFromSprint: vi.fn(async () => undefined),
```

- [ ] **Step 3: Write the failing tests**

In `test/unit/tasksView.test.ts`, add after the `describe("addToMySprint", …)` block (~line 343):

```ts
describe("removeFromSprint", () => {
  it("moves to backlog, stamps the label, prunes saved order, and posts removedFromSprint", async () => {
    const { provider, posted, workspaceState } = setup({
      workspaceState: { "agentFlow.sprintOrder": ["ASM-1", "ASM-2"] },
    });
    await provider.removeFromSprint("ASM-1", "any");
    expect(clientStub.removeIssueFromSprint).toHaveBeenCalledWith("ASM-1");
    expect(clientStub.addLabel).toHaveBeenCalledWith("ASM-1", "claude-code");
    expect(workspaceState.update).toHaveBeenCalledWith("agentFlow.sprintOrder", ["ASM-2"]);
    expect(posted()).toContainEqual({ type: "removedFromSprint", key: "ASM-1" });
  });

  it("skips the label stamp when stampLabelOnWrite is off", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, stampLabelOnWrite: false });
    const { provider } = setup();
    await provider.removeFromSprint("ASM-1", "any");
    expect(clientStub.addLabel).not.toHaveBeenCalled();
  });

  it("does not remove the card when the backlog write fails", async () => {
    clientStub.removeIssueFromSprint.mockRejectedValue(new Error("boom"));
    const { send, posted } = setup();
    await send({ type: "removeFromSprint", key: "ASM-1", size: "any" });
    expect(posted()).not.toContainEqual(expect.objectContaining({ type: "removedFromSprint" }));
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "error" }));
  });

  it("re-adds to the active sprint and refetches when Undo is chosen", async () => {
    vi.mocked(window.showInformationMessage).mockResolvedValue("Undo");
    const { provider, posted } = setup();
    await provider.removeFromSprint("ASM-1", "any");
    expect(clientStub.getActiveSprintId).toHaveBeenCalled();
    expect(clientStub.addIssueToSprint).toHaveBeenCalledWith(42, "ASM-1");
    expect(posted()).toContainEqual(expect.objectContaining({ type: "tasks", filter: "mysprint" }));
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run test/unit/tasksView.test.ts -t "removeFromSprint"`
Expected: FAIL — `provider.removeFromSprint is not a function` / no `removeFromSprint` case.

- [ ] **Step 5: Add the handler case**

In `src/tasksView.ts` `onMessage`, add after the `case "addToMySprint"` block (~line 194):

```ts
        case "removeFromSprint": {
          await this.removeFromSprint(m.key, m.size);
          break;
        }
```

- [ ] **Step 6: Implement the method**

In `src/tasksView.ts`, add after the `addToMySprint` method (~line 303). Note `Size` must be in the import from `./types` at the top — add it if absent:

```ts
  /** Remove a ticket from the active sprint by moving it to the backlog. Leaves
   * assignee and status untouched. Offers a one-click Undo via a native notification. */
  public async removeFromSprint(key: string, size: Size): Promise<void> {
    const cfg = getConfig();
    this.log(`removeFromSprint ${key}: start`);
    if (!(await this.auth.isAuthenticated())) {
      this.postState(false, !!cfg.baseUrl && !!cfg.project, null);
      return;
    }
    const client = this.client();
    await client.removeIssueFromSprint(key);
    this.log(`removeFromSprint ${key}: moved to backlog`);
    if (cfg.stampLabelOnWrite) {
      try {
        await client.addLabel(key, cfg.provenanceLabel);
      } catch (e) {
        this.log(`label stamp failed for ${key}: ${e}`);
      }
    }
    // Drop it from the saved manual order so no ghost rank lingers.
    const saved = this.savedOrder();
    if (saved.includes(key)) await this.saveOrder(saved.filter((k) => k !== key));
    this.post({ type: "removedFromSprint", key });
    this.toast("success", `${key} → backlog`);
    // Undo: put it back into the active sprint and refetch so the card returns.
    const choice = await vscode.window.showInformationMessage(`${key} removed from your sprint`, "Undo");
    if (choice !== "Undo") return;
    const sprintId = await client.getActiveSprintId();
    if (sprintId == null) {
      this.toast("error", `No active sprint on the ${cfg.project} board.`);
      return;
    }
    await client.addIssueToSprint(sprintId, key);
    this.log(`removeFromSprint ${key}: undo → sprint ${sprintId}`);
    await this.onMessage({ type: "fetch", filter: "mysprint", size });
  }
```

If the top-of-file import does not already list `Size`, update it:

```ts
import { Filter, InboundMessage, JiraTask, OutboundMessage, PromptMode, ServiceRef, Size, WorkspaceMode } from "./types";
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run test/unit/tasksView.test.ts -t "removeFromSprint"`
Expected: PASS (all four).

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/tasksView.ts test/unit/tasksView.test.ts
git commit -m "feat(sprint): host handler to remove a ticket from the sprint with Undo"
```

---

### Task 3: Webview — Remove button + card removal

**Files:**
- Modify: `src/webview/App.tsx` (add `SprintRemoveIcon` ~line 68; `removedFromSprint` case in the message switch ~line 216; `onRemoveFromSprint` prop on the `TaskCard` call ~line 464 and on the `TaskCard` props type ~line 544; render the button in `card-actions` ~line 645)
- Modify: `src/webview/styles.ts` (add `.sprint-remove` rules after `.sprint-add` ~line 163)
- Test: `test/webview/App.test.tsx` (add to `describe("task card actions", …)` ~line 568)

**Interfaces:**
- Consumes: inbound `{ type: "removeFromSprint"; key; size }` and outbound `{ type: "removedFromSprint"; key }` (Task 2); existing `send`, `filter`, `size` state.
- Produces: a `Remove` button gated to `filter === "mysprint"`, and card removal on `removedFromSprint`.

- [ ] **Step 1: Write the failing tests**

In `test/webview/App.test.tsx`, add inside `describe("task card actions", …)` (after the "adds an unassigned task to my sprint" test, ~line 568):

```ts
  it("shows Remove on the My sprint tab and sends removeFromSprint", () => {
    render(<App />);
    authed();
    host({ type: "tasks", filter: "mysprint", tasks: [mkTask({ key: "ASM-1", assignee: "Jane", inOpenSprint: true })] });
    fireEvent.click(screen.getByRole("button", { name: /Remove/i }));
    expect(sent).toHaveBeenCalledWith({ type: "removeFromSprint", key: "ASM-1", size: "any" });
  });

  it("does not show Remove on other tabs", () => {
    render(<App />);
    authed();
    host({ type: "tasks", filter: "mine", tasks: [mkTask({ key: "ASM-1", assignee: "Jane", inOpenSprint: true })] });
    expect(screen.queryByRole("button", { name: /Remove/i })).not.toBeInTheDocument();
  });

  it("drops the card when removedFromSprint arrives", () => {
    render(<App />);
    authed();
    host({ type: "tasks", filter: "mysprint", tasks: [mkTask({ key: "ASM-1" }), mkTask({ key: "ASM-2" })] });
    host({ type: "removedFromSprint", key: "ASM-1" });
    expect(screen.queryByText("ASM-1")).not.toBeInTheDocument();
    expect(screen.getByText("ASM-2")).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/webview/App.test.tsx -t "Remove"`
Expected: FAIL — no Remove button / card not removed.

- [ ] **Step 3: Add the icon**

In `src/webview/App.tsx`, after `SprintAddIcon` (~line 68), add a minus-in-sprint glyph:

```tsx
const SprintRemoveIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
    <path fill="currentColor" d="M3 1.4a.7.7 0 0 1 1.4 0V14.6a.7.7 0 0 1-1.4 0z" />
    <path fill="currentColor" d="M5 2.3h6.4L10.1 4.7l1.3 2.4H5z" />
    <path fill="currentColor" d="M9.3 11.3h5v1.3h-5z" />
  </svg>
);
```

- [ ] **Step 4: Handle `removedFromSprint` in the message switch**

In `src/webview/App.tsx`, add a case after `movedToSprint` (~line 216):

```tsx
        case "removedFromSprint":
          setTasks((prev) => prev.filter((t) => t.key !== m.key));
          break;
```

- [ ] **Step 5: Add the prop to TaskCard and pass it from App**

In the `TaskCard` props type (~line 544, alongside `dnd?: CardDnd;`), add:

```tsx
  onRemoveFromSprint?: () => void;
```

Destructure it (~line 546, in the `const { … } = props;` line): add `onRemoveFromSprint`.

In the `TaskCard` render call in App (~line 464, alongside `dnd={…}`), add:

```tsx
            onRemoveFromSprint={filter === "mysprint" ? () => send({ type: "removeFromSprint", key: t.key, size }) : undefined}
```

- [ ] **Step 6: Render the button**

In `src/webview/App.tsx`, inside `card-actions`, after the `showAddToSprint` button block (~line 645), add:

```tsx
            {onRemoveFromSprint && (
              <button
                className="sprint-remove"
                onClick={(e) => { e.stopPropagation(); onRemoveFromSprint(); }}
                title={`Remove ${task.key} from your active sprint (move it to the backlog)`}
              >
                <SprintRemoveIcon /> Remove
              </button>
            )}
```

- [ ] **Step 7: Add styles**

In `src/webview/styles.ts`, after the `.sprint-add svg` rule (~line 163), add:

```css
  /* Secondary action: remove from my sprint (move to backlog) */
  .sprint-remove { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 500;
    padding: 3px 11px 3px 9px; border-radius: 14px; cursor: pointer; white-space: nowrap;
    border: 1px solid var(--vscode-panel-border); background: transparent;
    color: var(--vscode-descriptionForeground);
    transition: color .12s ease, border-color .12s ease, background .12s ease; }
  .sprint-remove:hover { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder);
    background: var(--vscode-toolbar-hoverBackground); }
  .sprint-remove svg { display: block; }
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run test/webview/App.test.tsx -t "Remove"`
Expected: PASS (all three).

- [ ] **Step 9: Commit**

```bash
git add src/webview/App.tsx src/webview/styles.ts test/webview/App.test.tsx
git commit -m "feat(webview): Remove-from-sprint button on the My sprint tab"
```

---

### Task 4: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: all tests pass (including the three files touched above).

- [ ] **Step 2: Type-check and build**

Run: `npm run typecheck` then `npm run build`.
(`typecheck` is `tsc --noEmit` — the real type gate; `build` is esbuild, which bundles but does **not** type-check.)
Expected: no TypeScript errors — in particular, `Size` resolves in `tasksView.ts` and both new message variants are exhaustively handled; then a clean esbuild bundle.

- [ ] **Step 3: Manual smoke (optional, if a Jira-connected window is available)**

1. On the My sprint tab, click Remove on a card → card slides out; VS Code notification "…removed from your sprint" appears.
2. Click Undo → ticket returns to My sprint (at the bottom, unranked).
3. Let the notification dismiss → ticket stays in the backlog.
4. Confirm no Remove button appears on the Mine / Sprint / All / Unassigned / Backlog tabs.

- [ ] **Step 4: Commit any build artifacts if the repo tracks them**

Per repo convention (see the "Release on merge to main" memory), a fresh `.vsix` may need rebuilding — do this at merge time, not per-task. No commit here unless the build emits tracked files.

---

## Notes for the implementer

- **Why `size` rides on the inbound message:** the Undo path refetches the My sprint list, and it must refetch under the same size lens the user currently has, so the restored view matches. The webview already holds `size` state (default `"any"`); it is threaded through the `onRemoveFromSprint` closure.
- **Why host-confirmed, not optimistic:** a failed backlog write must leave the card in place. The webview removes the card only on the `removedFromSprint` message, which the host posts only after the write succeeds. The `onMessage` try/catch turns any write failure into an error toast/banner.
- **Provenance label:** stamped on the remove write (the ticket is "updated"), consistent with `changeStatus` / `addToMySprint` and gated by `cfg.stampLabelOnWrite`.
