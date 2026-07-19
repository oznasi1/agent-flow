# My Sprint Drag-and-Drop Reorder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user drag task cards to reorder them on the **My sprint** tab of the Agent Flow sidebar, remembering the order per-workspace with no Jira writes.

**Architecture:** A small pure module (`src/engine/order.ts`) computes ordering; the host (`src/tasksView.ts`) persists the order in `context.workspaceState` and applies it when fetching the My-sprint list; the React webview (`src/webview/App.tsx`) provides handle-gated native HTML5 drag-and-drop and reports the new order to the host.

**Tech Stack:** TypeScript, React 18 (webview), VS Code extension API, esbuild. No new runtime dependencies (native HTML5 drag-and-drop).

## Global Constraints

- No new npm dependencies — webview stays `react` + `react-dom` only; use native HTML5 drag-and-drop.
- No Jira writes for reorder — no Agile rank API, no `claude-code` label stamped.
- Drag-and-drop is enabled **only** when `filter === "mysprint"`; all other tabs keep the default `priority DESC, updated DESC` order untouched.
- Unranked/new tickets sort to the **bottom** in server order.
- Persistence store is the host `context.workspaceState` Memento under key `agentFlow.sprintOrder` (per-workspace).
- Styling uses `var(--vscode-*)` theme variables to match the editor theme (existing convention in `src/webview/styles.ts`).
- All pure logic lives in `src/engine/order.ts` and is unit-tested via the existing `test/engine_check.ts` harness.

## Note on concurrent work (read before editing)

A separate, already-merged feature ("add to my sprint", commit `e9a5df4`) touches the
same files this plan modifies: `src/types.ts`, `src/tasksView.ts`, `src/webview/App.tsx`,
`src/webview/styles.ts`. It is **orthogonal** to reorder and must be preserved. Concretely,
the current code already contains: an `inOpenSprint: boolean` field on `JiraTask`; an
`addToMySprint` inbound message and its host handler; a `me` prop, `isMe`/`inMySprint`
locals, an `addToSprint` handler, a `SprintAddIcon`, and a `sprint-add` button in
`TaskCard`; a `movedToSprint` outbound message + webview handler; and a `.sprint-add`
style. **Do not remove any of it.** All edit steps below are written as
find-this-exact-text → replace-with-that; **line numbers are indicative only — locate the
anchor text.** Every step is additive; if a "find" block does not match, stop and
reconcile rather than overwrite.

---

## Task 1: Pure ordering module + tests + test script

**Files:**
- Create: `src/engine/order.ts`
- Modify: `test/engine_check.ts` (add imports at top; append checks at the end before the summary block at line 134)
- Modify: `package.json` (add a `test` script)

**Interfaces:**
- Consumes: `JiraTask` from `src/types.ts` (existing).
- Produces (later tasks rely on these exact signatures):
  - `sortBySavedOrder(tasks: JiraTask[], saved: string[]): JiraTask[]`
  - `applyReorder(saved: string[], visibleNew: string[], visibleSet: Set<string>): string[]`
  - `pruneOrder(saved: string[], presentKeys: string[]): string[]`

- [ ] **Step 1: Add the `test` script to `package.json`**

In the `"scripts"` block, add a `test` entry (keep the others as-is):

```json
    "test": "esbuild test/engine_check.ts --bundle --platform=node --format=cjs --outfile=dist/test-check.cjs && node dist/test-check.cjs",
```

(`esbuild` resolves to the locally installed `node_modules/.bin/esbuild` when npm runs the script. Output goes to `dist/`, which is git-ignored. This avoids needing a network fetch for a test runner — the npm registry is not reachable in this environment.)

- [ ] **Step 2: Write the failing tests**

At the top of `test/engine_check.ts`, add these imports after the existing import block (after line 7):

```ts
import { sortBySavedOrder, applyReorder, pruneOrder } from "../src/engine/order";
import { JiraTask } from "../src/types";
```

Then, immediately before the final summary block (the `console.log(...)` at line ~134), append:

```ts
// ── sprint reorder: pure ordering helpers ──────────────────────────────────
const mkTasks = (...keys: string[]): JiraTask[] =>
  keys.map((k) => ({
    key: k, summary: k, status: "", statusCategory: "new", priority: "",
    assignee: "Unassigned", labels: [], components: [], sprint: null,
    inOpenSprint: false, updated: "", url: "", estimateSeconds: null,
  }));
const order = (ts: JiraTask[]) => ts.map((t) => t.key);

// sortBySavedOrder
check("saved order ranks known keys first",
  JSON.stringify(order(sortBySavedOrder(mkTasks("A", "B", "C"), ["C", "A"])))
  === JSON.stringify(["C", "A", "B"]));
check("unranked keys land at the bottom in server order",
  JSON.stringify(order(sortBySavedOrder(mkTasks("A", "B", "C", "D"), ["C"])))
  === JSON.stringify(["C", "A", "B", "D"]));
check("empty saved order is a no-op",
  JSON.stringify(order(sortBySavedOrder(mkTasks("A", "B", "C"), [])))
  === JSON.stringify(["A", "B", "C"]));

// applyReorder
check("applyReorder from empty saved = the visible order",
  JSON.stringify(applyReorder([], ["B", "A", "C"], new Set(["B", "A", "C"])))
  === JSON.stringify(["B", "A", "C"]));
check("applyReorder reorders a full visible list",
  JSON.stringify(applyReorder(["A", "B", "C"], ["C", "B", "A"], new Set(["A", "B", "C"])))
  === JSON.stringify(["C", "B", "A"]));
check("applyReorder preserves slots of keys hidden by the size lens",
  // saved A,B,C,D; B is hidden by the lens (visible = A,C,D); user drags D to the top
  JSON.stringify(applyReorder(["A", "B", "C", "D"], ["D", "A", "C"], new Set(["D", "A", "C"])))
  === JSON.stringify(["D", "B", "A", "C"]));

// pruneOrder
check("pruneOrder drops keys no longer present",
  JSON.stringify(pruneOrder(["A", "B", "C"], ["A", "C"])) === JSON.stringify(["A", "C"]));
check("pruneOrder keeps the order of surviving keys",
  JSON.stringify(pruneOrder(["C", "A", "B"], ["A", "B", "C"])) === JSON.stringify(["C", "A", "B"]));
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — esbuild errors resolving `../src/engine/order` (module does not exist yet), e.g. `Could not resolve "../src/engine/order"`.

- [ ] **Step 4: Implement `src/engine/order.ts`**

```ts
import { JiraTask } from "../types";

/** Order tasks so keys present in `saved` come first (in saved order),
 *  then any remaining tasks in their incoming (server) order. Pure. */
export function sortBySavedOrder(tasks: JiraTask[], saved: string[]): JiraTask[] {
  const rank = new Map(saved.map((k, i) => [k, i] as const));
  const ranked = tasks
    .filter((t) => rank.has(t.key))
    .sort((a, b) => rank.get(a.key)! - rank.get(b.key)!);
  const unranked = tasks.filter((t) => !rank.has(t.key)); // preserves server order
  return [...ranked, ...unranked];
}

/** Rebuild the full saved order after the user reorders the *visible* subset.
 *  Keys not currently visible (hidden by the size lens) keep their absolute
 *  slots; brand-new visible keys append at the end. Pure. */
export function applyReorder(saved: string[], visibleNew: string[], visibleSet: Set<string>): string[] {
  const feed = [...visibleNew];
  const out: string[] = [];
  for (const key of saved) {
    if (visibleSet.has(key)) {
      const next = feed.shift();
      if (next !== undefined) out.push(next); // fill this visible slot from the new order
    } else {
      out.push(key); // hidden key keeps its slot
    }
  }
  for (const key of feed) if (!out.includes(key)) out.push(key); // new keys append
  return out;
}

/** Drop saved keys no longer present in the sprint. Only call on a full fetch
 *  (size "any"), so keys merely hidden by a size lens are never pruned. Pure. */
export function pruneOrder(saved: string[], presentKeys: string[]): string[] {
  const present = new Set(presentKeys);
  return saved.filter((k) => present.has(k));
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — the 8 new checks pass, and the summary line reports `0 failed` (e.g. `47 passed, 0 failed`).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/engine/order.ts test/engine_check.ts package.json
git commit -m "feat: pure ordering helpers for sprint reorder

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Host persistence + message wiring

**Files:**
- Modify: `src/types.ts` (add two inbound message variants)
- Modify: `src/tasksView.ts` (import order helpers; add Memento accessors; apply order in `fetch`; handle `reorder` and `resetOrder`)

**Interfaces:**
- Consumes: `sortBySavedOrder`, `applyReorder`, `pruneOrder` from `src/engine/order.ts` (Task 1).
- Produces (webview relies on these message shapes in Task 3):
  - Inbound `{ type: "reorder"; order: string[] }`
  - Inbound `{ type: "resetOrder"; size: Size }`

No unit-test harness exists for host code (it depends on the `vscode` API), so this task is verified by `npm run typecheck` + `npm run build`. Behavioral verification happens end-to-end in Task 3.

- [ ] **Step 1: Add the inbound message variants in `src/types.ts`**

Add two variants to the existing `InboundMessage` union — do NOT rewrite the whole
union (it already contains `addToMySprint` and other variants from other work).
`Size` is already imported/defined in this file. Find the last line of the union:

```ts
  | { type: "signIn" };
```

and replace it with:

```ts
  | { type: "signIn" }
  | { type: "reorder"; order: string[] }
  | { type: "resetOrder"; size: Size };
```

- [ ] **Step 2: Import the order helpers in `src/tasksView.ts`**

After the existing engine imports (after line 8, `import { createWorktrees } ...`), add:

```ts
import { sortBySavedOrder, applyReorder, pruneOrder } from "./engine/order";
```

- [ ] **Step 3: Add a Memento key constant**

Directly below the imports (before `export class TasksViewProvider`), add:

```ts
const SPRINT_ORDER_KEY = "agentFlow.sprintOrder";
```

- [ ] **Step 4: Add Memento accessor methods**

Inside the `TasksViewProvider` class, add these two private methods (place them just after the `private client(): JiraClient { ... }` method, around line 42):

```ts
  private savedOrder(): string[] {
    return this.context.workspaceState.get<string[]>(SPRINT_ORDER_KEY, []);
  }

  private async saveOrder(order: string[]): Promise<void> {
    await this.context.workspaceState.update(SPRINT_ORDER_KEY, order);
  }
```

- [ ] **Step 5: Apply the saved order in the `fetch` handler**

Find these two lines inside the `case "fetch":` block (the `this.lastFilter = m.filter;`
line comes from other work — keep it):

```ts
          for (const t of tasks) t.services = this.guessServices(t, repos);
          this.post({ type: "tasks", filter: m.filter, tasks });
```

and replace them with (inserts the ordering step between them; note `tasks` → `outgoing`
in the post):

```ts
          for (const t of tasks) t.services = this.guessServices(t, repos);
          let outgoing = tasks;
          if (m.filter === "mysprint") {
            if (m.size === "any") {
              // Full sprint view: prune keys that have left the sprint.
              await this.saveOrder(pruneOrder(this.savedOrder(), tasks.map((t) => t.key)));
            }
            outgoing = sortBySavedOrder(tasks, this.savedOrder());
          }
          this.post({ type: "tasks", filter: m.filter, tasks: outgoing });
```

- [ ] **Step 6: Handle `reorder` and `resetOrder`**

In the same `switch (m.type)` inside `onMessage`, add these two cases immediately after
the existing `case "addToMySprint":` block (it is the last case before the switch's
closing `}`). Find:

```ts
        case "addToMySprint": {
          await this.addToMySprint(m.key);
          break;
        }
```

and replace it with:

```ts
        case "addToMySprint": {
          await this.addToMySprint(m.key);
          break;
        }
        case "reorder": {
          const next = applyReorder(this.savedOrder(), m.order, new Set(m.order));
          await this.saveOrder(next);
          break;
        }
        case "resetOrder": {
          await this.saveOrder([]);
          await this.onMessage({ type: "fetch", filter: "mysprint", size: m.size });
          break;
        }
```

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0. (If TypeScript reports a non-exhaustive `switch`, re-check that both new cases were added inside the `switch (m.type)`.)

- [ ] **Step 8: Build**

Run: `npm run build`
Expected: esbuild completes with no errors (host + webview bundles written to `dist/`).

- [ ] **Step 9: Commit**

```bash
git add src/types.ts src/tasksView.ts
git commit -m "feat: persist My-sprint order in workspaceState

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Webview drag-and-drop UI + styles

**Files:**
- Modify: `src/webview/App.tsx` (module-level `moveKey`; DnD state/handlers/refs in `App`; `dnd` prop threaded to `TaskCard`; grip handle + reset button)
- Modify: `src/webview/styles.ts` (grip, dragging/drop-indicator, reorder-bar/reset styles)

**Interfaces:**
- Consumes: inbound messages `{ type: "reorder"; order: string[] }` and `{ type: "resetOrder"; size: Size }` (Task 2).
- Produces: no new outbound message types; reorder is optimistic and reset triggers a normal `tasks` refetch from the host.

Verified by `npm run typecheck` + `npm run build` + the manual end-to-end checklist at the end of this task (no automated UI harness exists in this repo).

- [ ] **Step 1: Add the `moveKey` pure helper to `src/webview/App.tsx`**

Add this module-level function near the top of the file, just after the `fmtEst` function (after line 27):

```tsx
/** Move `fromKey` to sit before/after `toKey` within a task list. Pure. */
function moveKey(list: JiraTask[], fromKey: string, toKey: string, pos: "before" | "after"): JiraTask[] {
  if (fromKey === toKey) return list;
  const from = list.findIndex((t) => t.key === fromKey);
  if (from < 0) return list;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  const to = next.findIndex((t) => t.key === toKey);
  if (to < 0) return list;
  next.splice(pos === "after" ? to + 1 : to, 0, moved);
  return next;
}
```

- [ ] **Step 2: Add the `CardDnd` interface**

Add this interface next to the existing `DetailState` interface (after line 34):

```tsx
interface CardDnd {
  onBegin: () => void;
  onHover: (pos: "before" | "after") => void;
  onDrop: (pos: "before" | "after") => void;
  onEnd: () => void;
  dragging: boolean;
  hint: "before" | "after" | null;
}
```

- [ ] **Step 3: Add DnD state + refs + handlers inside `App`**

Inside the `App` component, after the existing `const [details, ...] = React.useState(...)` line (line 68), add:

```tsx
  const [dragKey, setDragKey] = React.useState<string | null>(null);
  const [dropTarget, setDropTarget] = React.useState<{ key: string; pos: "before" | "after" } | null>(null);
  const dragKeyRef = React.useRef<string | null>(null);
  const tasksRef = React.useRef<JiraTask[]>([]);
  React.useEffect(() => { tasksRef.current = tasks; }, [tasks]);

  const endDrag = () => { dragKeyRef.current = null; setDragKey(null); setDropTarget(null); };
  const beginDrag = (key: string) => { dragKeyRef.current = key; setDragKey(key); };
  const commitDrop = (targetKey: string, pos: "before" | "after") => {
    const dk = dragKeyRef.current;
    if (dk && dk !== targetKey) {
      const next = moveKey(tasksRef.current, dk, targetKey, pos);
      setTasks(next);
      send({ type: "reorder", order: next.map((t) => t.key) });
    }
    endDrag();
  };
```

- [ ] **Step 4: Thread the `dnd` prop into the task list render**

Find the `<TaskCard ... />` render inside `<div className="list">` (it already passes a
`me={me}` prop from other work — keep it) and add a `dnd={...}` prop. Replace this block:

```tsx
      <div className="list">
        {tasks.map((t) => (
          <TaskCard
            key={t.key}
            task={t}
            me={me}
            open={expanded.has(t.key)}
            detail={details[t.key]}
            onToggle={() => toggleExpand(t.key)}
            onSelect={(sel) => setSelected(t.key, sel)}
          />
        ))}
      </div>
```

with:

```tsx
      <div className="list">
        {tasks.map((t) => (
          <TaskCard
            key={t.key}
            task={t}
            me={me}
            open={expanded.has(t.key)}
            detail={details[t.key]}
            onToggle={() => toggleExpand(t.key)}
            onSelect={(sel) => setSelected(t.key, sel)}
            dnd={
              filter === "mysprint"
                ? {
                    onBegin: () => beginDrag(t.key),
                    onHover: (pos) => setDropTarget({ key: t.key, pos }),
                    onDrop: (pos) => commitDrop(t.key, pos),
                    onEnd: endDrag,
                    dragging: dragKey === t.key,
                    hint: dropTarget && dropTarget.key === t.key && dragKey && dragKey !== t.key ? dropTarget.pos : null,
                  }
                : undefined
            }
          />
        ))}
      </div>
```

- [ ] **Step 5: Add the "Reset order" bar (My sprint only)**

Immediately before the `{loading && ...}` line (currently line 176), add:

```tsx
      {filter === "mysprint" && (
        <div className="reorder-bar">
          <button className="reset-order" title="Clear your manual order" onClick={() => send({ type: "resetOrder", size })}>
            Reset order
          </button>
        </div>
      )}
```

- [ ] **Step 6: Extend `TaskCard` to accept and wire the `dnd` prop**

The `TaskCard` function already has a `me` prop plus `isMe`, `inMySprint`, and an
`addToSprint` handler from other work — keep all of it. This step adds the `dnd` prop,
the `armed` ref, the `dropPos`/`cls` helpers, and replaces the wrapping `<div>`.

Find the function header and body up to (and including) the opening `<div>` of the card:

```tsx
function TaskCard(props: {
  task: JiraTask;
  me: string | null;
  open: boolean;
  detail?: DetailState;
  onToggle: () => void;
  onSelect: (selected: string[]) => void;
}): JSX.Element {
  const { task, me, open, detail, onToggle, onSelect } = props;
  const unassigned = !task.assignee || task.assignee.toLowerCase() === "unassigned";
  const isMe = !!me && task.assignee === me;
  const inMySprint = task.inOpenSprint && isMe;

  const take = (e: React.MouseEvent) => {
    e.stopPropagation();
    const services = open && detail?.selected ? detail.selected : undefined;
    send({ type: "take", key: task.key, services });
  };

  const addToSprint = (e: React.MouseEvent) => {
    e.stopPropagation();
    send({ type: "addToMySprint", key: task.key });
  };

  return (
    <div className={`card ${prioClass(task.priority)}${open ? " open" : ""}`}>
```

and replace it with:

```tsx
function TaskCard(props: {
  task: JiraTask;
  me: string | null;
  open: boolean;
  detail?: DetailState;
  onToggle: () => void;
  onSelect: (selected: string[]) => void;
  dnd?: CardDnd;
}): JSX.Element {
  const { task, me, open, detail, onToggle, onSelect, dnd } = props;
  const unassigned = !task.assignee || task.assignee.toLowerCase() === "unassigned";
  const isMe = !!me && task.assignee === me;
  const inMySprint = task.inOpenSprint && isMe;
  const armed = React.useRef(false); // true only while a drag started from the grip

  const take = (e: React.MouseEvent) => {
    e.stopPropagation();
    const services = open && detail?.selected ? detail.selected : undefined;
    send({ type: "take", key: task.key, services });
  };

  const addToSprint = (e: React.MouseEvent) => {
    e.stopPropagation();
    send({ type: "addToMySprint", key: task.key });
  };

  const dropPos = (e: React.DragEvent): "before" | "after" => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return e.clientY < r.top + r.height / 2 ? "before" : "after";
  };

  const cls = [
    "card", prioClass(task.priority),
    open ? "open" : "",
    dnd?.dragging ? "dragging" : "",
    dnd?.hint === "before" ? "drop-before" : dnd?.hint === "after" ? "drop-after" : "",
  ].filter(Boolean).join(" ");

  return (
    <div
      className={cls}
      draggable={!!dnd}
      onDragStart={dnd ? (e) => {
        if (!armed.current) { e.preventDefault(); return; } // only the grip arms a drag
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", task.key);
        dnd.onBegin();
      } : undefined}
      onDragOver={dnd ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; dnd.onHover(dropPos(e)); } : undefined}
      onDrop={dnd ? (e) => { e.preventDefault(); dnd.onDrop(dropPos(e)); armed.current = false; } : undefined}
      onDragEnd={dnd ? () => { armed.current = false; dnd.onEnd(); } : undefined}
      onMouseUp={dnd ? () => { armed.current = false; } : undefined}
    >
```

Note: everything from `<div className="card-main" onClick={onToggle}>` onward (including
the `sprint-add` button) is unchanged — only the wrapping `<div>` and function header change.

- [ ] **Step 7: Add the grip handle inside `card-top`**

In `TaskCard`, inside the `<div className="card-top">`, add the grip as the FIRST child, immediately before the `<span className={`chev...`}>` element (currently line 240):

```tsx
          {dnd && (
            <span
              className="grip"
              title="Drag to reorder"
              onMouseDown={(e) => { e.stopPropagation(); armed.current = true; }}
              onClick={(e) => e.stopPropagation()}
            >⠿</span>
          )}
```

- [ ] **Step 8: Add the styles**

In `src/webview/styles.ts`, add these rules to the `CSS` template string. Put them right after the `.list { ... }` rule (after line 36):

```css
  .reorder-bar { display: flex; justify-content: flex-end; margin: -4px 2px 8px; }
  .reset-order { font-size: 10px; padding: 2px 9px; border-radius: 10px; cursor: pointer;
    background: transparent; border: 1px solid var(--vscode-panel-border);
    color: var(--vscode-descriptionForeground);
    transition: border-color .12s ease, color .12s ease; }
  .reset-order:hover { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); }

  .grip { cursor: grab; color: var(--vscode-descriptionForeground); font-size: 13px; line-height: 1;
    opacity: .4; user-select: none; margin-left: -3px; }
  .grip:hover { opacity: .9; }
  .grip:active { cursor: grabbing; }
  .card.dragging { opacity: .45; }
  .card.drop-before { box-shadow: inset 0 2px 0 0 var(--vscode-focusBorder); }
  .card.drop-after  { box-shadow: inset 0 -2px 0 0 var(--vscode-focusBorder); }
```

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 10: Build**

Run: `npm run build`
Expected: esbuild completes with no errors; `dist/webview.js` rebuilt.

- [ ] **Step 11: Manual end-to-end verification**

Launch the extension (VS Code "Run Extension" / F5, or install the built `.vsix`), open the Agent Flow sidebar, sign in, and go to the **My sprint** tab. Confirm each:

1. A grip (⠿) shows on the left of each card **only** on My sprint (switch to another tab → no grip, no reset bar).
2. Drag a card by the grip to a new position → a blue insertion line appears at the drop slot; on release the order updates.
3. Reload the window (Developer: Reload Window) → the My-sprint order is preserved.
4. Switch to another tab and back to My sprint → order retained.
5. Clicking a card body still expands it; the Take button and the status button still work (dragging only starts from the grip).
6. Apply a size lens (e.g. M), reorder the visible subset, clear the lens → the tickets hidden by the lens kept their relative slots.
7. A ticket newly added to your sprint appears at the **bottom** of the list.
8. Click **Reset order** → list returns to the default `priority/updated` order.

- [ ] **Step 12: Commit**

```bash
git add src/webview/App.tsx src/webview/styles.ts
git commit -m "feat: drag-and-drop reorder for My sprint

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage:** persistence store (Task 2, `workspaceState`), My-sprint-only gating (Tasks 2 & 3), unranked-to-bottom (`sortBySavedOrder`, Task 1), native handle-gated DnD (Task 3), size-lens slot preservation (`applyReorder`, Task 1 + test), prune on full fetch (Task 2), reset control (Task 3), unit tests for the three pure helpers (Task 1). All spec sections map to a task.
- **Type consistency:** helper names/signatures in Task 1 match their call sites in Tasks 2–3 (`sortBySavedOrder`, `applyReorder`, `pruneOrder`, `moveKey`); message shapes `{type:"reorder"; order}` and `{type:"resetOrder"; size}` match between `types.ts` (Task 2) and the webview `send(...)` calls (Task 3); `CardDnd` fields match between the `App` render and the `TaskCard` consumer.
- **No placeholders:** every code step contains complete code; no TBD/TODO.
