# Notepad Drag-to-Reorder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user drag a Notepad note by its grip to set a manual order that persists, exactly as the Tasks tab's My-sprint cards already do.

**Architecture:** The order lives in its own `globalState` key (`agentFlow.notepadOrder`) as a list of note ids; `NotepadItem` is untouched and an empty order means today's newest-first list, so the feature ships inert. The host sorts before posting (`postNotepad`), reusing `sortBySavedOrder` / `applyReorder` / `pruneOrder` from `src/engine/order.ts`; the webview copies the Tasks card's drag affordance (grip arms the drag, before/after hint from the pointer half) and posts the visible ids in their new order.

**Tech Stack:** TypeScript, React 18 webview bundled by esbuild, Vitest + @testing-library/react (jsdom), VS Code extension API.

Design spec: [docs/superpowers/specs/2026-08-12-notepad-drag-reorder-design.md](../specs/2026-08-12-notepad-drag-reorder-design.md)

## Global Constraints

- `npm run typecheck` (`tsc --noEmit`) must be clean at every commit.
- `npm test` (`vitest run`) must pass — the existing suite unmodified except where this plan explicitly updates it.
- `npm run build` must succeed. It is the ONLY check that catches a webview module importing a host-only module; `tsc` and the full test suite pass regardless.
- **The webview must never import `fs`/`os`/`path`/`child_process`, even transitively.** `src/webview/*` may import `src/types.ts` and `src/webview/helpers.ts`. It must NOT import `src/engine/order.ts` or `src/notepad.ts`.
- Coverage: `npm run test:cov` enforces thresholds; the changed files must stay at or above the repo's ≥95% bar.
- No hardcoded organization values; nothing new belongs in settings for this feature.
- Every user-facing change gets a `## [Unreleased]` entry in `CHANGELOG.md` (Task 4).
- Existing users must see no behaviour change until they drag: with an empty order the list renders newest-first, exactly as today.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/engine/order.ts` | Pure order maths (host-side) | Modify — `sortBySavedOrder` becomes generic over the item |
| `src/webview/helpers.ts` | Pure webview helpers | Modify — `moveKey` becomes generic over the item |
| `src/types.ts` | Wire message types | Modify — two inbound messages, one field on `notepad:notes` |
| `src/tasksView.ts` | Host controller: storage, sorting, message handlers | Modify — order key, ordered read, four handler paths |
| `src/webview/Notepad.tsx` | Notepad UI | Modify — grip, drag handlers, Reset order, drop local sort |
| `src/webview/App.tsx` | Hosts `<Notepad>`, routes `notepad:notes` | Modify — carry the new `ordered` flag through |
| `src/webview/styles.ts` | Sidebar stylesheet | Modify — `.np-item.dragging` / `.drop-before` / `.drop-after`, grip placement |
| `test/unit/engine/order.test.ts` | Order maths tests | Modify — `keyOf` argument, note-shaped cases |
| `test/webview/helpers.test.ts` | Helper tests | Modify — `keyOf` argument, note-shaped case |
| `test/unit/tasksView.test.ts` | Host behaviour tests | Modify — new `describe("notepad reorder")` block |
| `test/webview/Notepad.test.tsx` | Notepad UI tests | Modify — drag, grip-gating, Reset order |
| `CHANGELOG.md` | Release notes | Modify — `## [Unreleased]` entry |

---

### Task 1: Make the two order helpers generic

Both helpers are hardcoded to `Task` and read `.key`. Notes are keyed by `.id`. One implementation each, parameterised by an accessor — no second copy.

**Files:**
- Modify: `src/engine/order.ts:5-12` (`sortBySavedOrder`)
- Modify: `src/webview/helpers.ts:100-111` (`moveKey`)
- Modify: `src/tasksView.ts:406` (only `sortBySavedOrder` call site)
- Modify: `src/webview/App.tsx:188` (only `moveKey` call site)
- Test: `test/unit/engine/order.test.ts`, `test/webview/helpers.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `sortBySavedOrder<T>(items: T[], saved: string[], keyOf: (item: T) => string): T[]`
  - `moveKey<T>(list: T[], fromKey: string, toKey: string, pos: "before" | "after", keyOf: (item: T) => string): T[]`
  - `applyReorder(saved: string[], visibleNew: string[], visibleSet: Set<string>): string[]` — unchanged
  - `pruneOrder(saved: string[], presentKeys: string[]): string[]` — unchanged

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/engine/order.test.ts`, inside the existing `describe("sortBySavedOrder", …)`:

```ts
  it("orders any keyed item, not just tasks", () => {
    const notes = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(sortBySavedOrder(notes, ["c", "a"], (n) => n.id).map((n) => n.id)).toEqual(["c", "a", "b"]);
  });
```

Add to `test/webview/helpers.test.ts`, inside the existing `describe("moveKey", …)`:

```ts
  it("moves any keyed item, not just tasks", () => {
    const notes = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(moveKey(notes, "c", "a", "before", (n) => n.id).map((n) => n.id)).toEqual(["c", "a", "b"]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/unit/engine/order.test.ts test/webview/helpers.test.ts`
Expected: FAIL — `Expected 2 arguments, but got 3` at runtime the extra argument is ignored, so the assertions fail on order (`["a","b","c"]` vs `["c","a","b"]`).

- [ ] **Step 3: Make both helpers generic**

`src/engine/order.ts` — replace the body of `sortBySavedOrder` (keep the existing doc comment, extend its first line):

```ts
/** Order items so keys present in `saved` come first (in saved order),
 *  then any remaining items in their incoming order. `keyOf` reads the item's
 *  identity — `t => t.key` for a task, `n => n.id` for a note. Pure. */
export function sortBySavedOrder<T>(items: T[], saved: string[], keyOf: (item: T) => string): T[] {
  const rank = new Map(saved.map((k, i) => [k, i] as const));
  const ranked = items
    .filter((t) => rank.has(keyOf(t)))
    .sort((a, b) => rank.get(keyOf(a))! - rank.get(keyOf(b))!);
  const unranked = items.filter((t) => !rank.has(keyOf(t))); // preserves incoming order
  return [...ranked, ...unranked];
}
```

`src/engine/order.ts` no longer needs its `Task` import if nothing else uses it — check the file and delete `import { Task } from "../types";` only if `Task` is unreferenced.

`src/webview/helpers.ts` — same treatment for `moveKey`:

```ts
/** Move `fromKey` to sit before/after `toKey` within a list. `keyOf` reads the
 *  item's identity — `t => t.key` for a task, `n => n.id` for a note. Pure. */
export function moveKey<T>(
  list: T[], fromKey: string, toKey: string, pos: "before" | "after", keyOf: (item: T) => string,
): T[] {
  if (fromKey === toKey) return list;
  const from = list.findIndex((t) => keyOf(t) === fromKey);
  if (from < 0) return list;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  const to = next.findIndex((t) => keyOf(t) === toKey);
  if (to < 0) return list;
  next.splice(pos === "after" ? to + 1 : to, 0, moved);
  return next;
}
```

- [ ] **Step 4: Update the two call sites and the existing tests**

`src/tasksView.ts:406`:

```ts
            outgoing = sortBySavedOrder(tasks, this.savedOrder(), (t) => t.key);
```

`src/webview/App.tsx:188`:

```ts
      const next = moveKey(tasksRef.current, dk, targetKey, pos, (t) => t.key);
```

In `test/unit/engine/order.test.ts`, add `, (t) => t.key` to every existing `sortBySavedOrder(...)` call (lines 10, 14, 18, 22, 26, 32). For the empty-list case on line 26 the array literal needs a type so the generic can infer: `sortBySavedOrder<{ key: string }>([], ["A", "B"], (t) => t.key)`.

In `test/webview/helpers.test.ts`, add `, (t) => t.key` to every existing `moveKey(...)` call (lines 123, 127, 132, 137, 142, 148).

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/engine/order.ts src/webview/helpers.ts src/tasksView.ts src/webview/App.tsx test/unit/engine/order.test.ts test/webview/helpers.test.ts
git commit -m "refactor: order helpers take a key accessor so notes can reuse them"
```

---

### Task 2: Persist and apply a notepad order (host)

**Files:**
- Modify: `src/types.ts` — `InboundMessage` (after `notepad:run`, ~line 363) and the `notepad:notes` outbound (~line 451)
- Modify: `src/tasksView.ts` — key constant (~line 51), notepad storage helpers (~lines 262-268), `postNotepad` (~line 272), `addNote` / `deleteNote` / `clearCompletedNotes` (~lines 289-314), `onMessage` notepad cases (~line 508)
- Test: `test/unit/tasksView.test.ts` (new `describe` block after the existing `describe("notepad", …)`)

**Interfaces:**
- Consumes: `sortBySavedOrder(items, saved, keyOf)`, `applyReorder(saved, visibleNew, visibleSet)`, `pruneOrder(saved, presentKeys)` from Task 1 / `src/engine/order.ts`.
- Produces:
  - Inbound messages `{ type: "notepad:reorder"; order: string[] }` and `{ type: "notepad:resetOrder" }`
  - Outbound `{ type: "notepad:notes"; notes: NotepadItemView[]; ordered: boolean }` — `ordered` is true when a manual order exists
  - Persisted key `agentFlow.notepadOrder: string[]` in `globalState`

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/tasksView.test.ts`, immediately after the closing brace of the existing `describe("notepad", …)` block. It reuses that block's `mkProvider` helper, so put it INSIDE the `describe("notepad", …)` block as a nested describe rather than a sibling:

```ts
  const orderIn = (store: Map<string, unknown>) => store.get("agentFlow.notepadOrder") as string[] | undefined;
  const titles = (posted: unknown[]) =>
    (posted.at(-1) as { notes: { title: string }[] }).notes.map((n) => n.title);

  describe("reorder", () => {
    // Three notes, added oldest-first: the panel shows them newest-first (c, b, a).
    async function threeNotes() {
      const h = mkProvider();
      await h.sendMsg({ type: "notepad:add", title: "a", body: "" });
      await h.sendMsg({ type: "notepad:add", title: "b", body: "" });
      await h.sendMsg({ type: "notepad:add", title: "c", body: "" });
      return { ...h, ids: notesIn(h.store)!.map((n) => n.id) };
    }

    it("posts newest-first and ordered:false while no order exists", async () => {
      const { posted } = await threeNotes();
      expect(titles(posted)).toEqual(["c", "b", "a"]);
      expect((posted.at(-1) as { ordered: boolean }).ordered).toBe(false);
    });

    it("stores a dropped order and posts the notes in it", async () => {
      const { posted, store, sendMsg, ids } = await threeNotes();
      const [a, b, c] = ids;
      await sendMsg({ type: "notepad:reorder", order: [a, c, b] });
      expect(orderIn(store)).toEqual([a, c, b]);
      expect(titles(posted)).toEqual(["a", "c", "b"]);
      expect((posted.at(-1) as { ordered: boolean }).ordered).toBe(true);
    });

    it("keeps a note hidden by the filter in its slot on the first drag", async () => {
      const { store, sendMsg, ids } = await threeNotes();
      const [a, b, c] = ids;
      // The panel shows c, b, a; the user filters to Active with `b` done, so the
      // visible pair is c, a and they drag a above c.
      await sendMsg({ type: "notepad:toggleDone", id: b });
      await sendMsg({ type: "notepad:reorder", order: [a, c] });
      expect(orderIn(store)).toEqual([a, b, c]); // b keeps the middle slot
    });

    it("puts a new note on top of an existing order", async () => {
      const { posted, store, sendMsg, ids } = await threeNotes();
      const [a, , c] = ids;
      await sendMsg({ type: "notepad:reorder", order: [a, c, ids[1]] });
      await sendMsg({ type: "notepad:add", title: "fresh", body: "" });
      expect(titles(posted)).toEqual(["fresh", "a", "c", "b"]);
      expect(orderIn(store)![0]).toBe(notesIn(store)!.find((n) => n.title === "fresh")!.id);
    });

    it("drops a deleted note's id from the order", async () => {
      const { store, sendMsg, ids } = await threeNotes();
      const [a, b, c] = ids;
      await sendMsg({ type: "notepad:reorder", order: [a, c, b] });
      await sendMsg({ type: "notepad:delete", id: c });
      expect(orderIn(store)).toEqual([a, b]);
    });

    it("drops cleared-completed ids from the order", async () => {
      const { store, sendMsg, ids } = await threeNotes();
      const [a, b, c] = ids;
      await sendMsg({ type: "notepad:reorder", order: [a, c, b] });
      await sendMsg({ type: "notepad:toggleDone", id: a });
      await sendMsg({ type: "notepad:clearCompleted" });
      expect(orderIn(store)).toEqual([c, b]);
    });

    it("resets to newest-first", async () => {
      const { posted, store, sendMsg, ids } = await threeNotes();
      await sendMsg({ type: "notepad:reorder", order: [ids[0], ids[2], ids[1]] });
      await sendMsg({ type: "notepad:resetOrder" });
      expect(orderIn(store)).toEqual([]);
      expect(titles(posted)).toEqual(["c", "b", "a"]);
      expect((posted.at(-1) as { ordered: boolean }).ordered).toBe(false);
    });

    it("ignores ids that are not notes", async () => {
      const { store, sendMsg, ids } = await threeNotes();
      await sendMsg({ type: "notepad:reorder", order: ["ghost", ids[0]] });
      expect(orderIn(store)).not.toContain("ghost");
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/unit/tasksView.test.ts -t "reorder"`
Expected: FAIL — TypeScript rejects `notepad:reorder` / `notepad:resetOrder` as `InboundMessage` types, and `ordered` is missing from the posted message.

- [ ] **Step 3: Add the wire types**

`src/types.ts`, in `InboundMessage`, directly after the `notepad:run` line:

```ts
  /** The ids of the notes VISIBLE in the panel, in the order the drop produced.
   * Hidden notes are not named and keep their absolute slots (see applyReorder). */
  | { type: "notepad:reorder"; order: string[] }
  | { type: "notepad:resetOrder" }
```

and change the outbound notes message:

```ts
  /** `ordered` is true when a manual order exists — the webview shows its
   * "Reset order" control only then, and cannot read the order key itself. */
  | { type: "notepad:notes"; notes: NotepadItemView[]; ordered: boolean }
```

- [ ] **Step 4: Add the storage helpers and the ordered read**

`src/tasksView.ts`, beside `NOTEPAD_KEY` (~line 51):

```ts
// The manual note order: ids, most important first. globalState, like the notes
// themselves — an order over the user's own notepad is not a workspace's business.
// Empty (the default) means "no manual order", which is what every install starts
// with and what makes this feature inert until the first drag.
const NOTEPAD_ORDER_KEY = "agentFlow.notepadOrder";
```

Extend the import on line 31 to keep `pruneOrder` (already imported) and add nothing new — `sortBySavedOrder`, `applyReorder` and `pruneOrder` are all already imported there.

Beside `notes()` / `saveNotes()` (~line 262):

```ts
  private noteOrder(): string[] {
    return this.context.globalState.get<string[]>(NOTEPAD_ORDER_KEY, []);
  }

  private async saveNoteOrder(order: string[]): Promise<void> {
    await this.context.globalState.update(NOTEPAD_ORDER_KEY, order);
  }

  /** Notes in display order: the manual order first where one exists, then
   * anything unranked newest-first — which is exactly the whole list when no
   * manual order exists, i.e. what the panel showed before this feature. */
  private orderedNotes(): NotepadItem[] {
    const newestFirst = [...this.notes()].sort((a, b) => b.createdAt - a.createdAt);
    return sortBySavedOrder(newestFirst, this.noteOrder(), (n) => n.id);
  }

  /** Forget ids that are no longer notes. Called on every path that removes one,
   * so the order cannot grow unbounded behind the panel. */
  private async pruneNoteOrder(remaining: NotepadItem[]): Promise<void> {
    const saved = this.noteOrder();
    if (saved.length === 0) return;
    const next = pruneOrder(saved, remaining.map((n) => n.id));
    if (next.length !== saved.length) await this.saveNoteOrder(next);
  }
```

- [ ] **Step 5: Sort in `postNotepad` and carry `ordered`**

`src/tasksView.ts`, in `postNotepad`: replace `const notes = this.notes();` with

```ts
    const notes = this.orderedNotes();
```

and the post at the end of the method with

```ts
    this.post({ type: "notepad:notes", notes: view, ordered: this.noteOrder().length > 0 });
```

- [ ] **Step 6: Update the three mutators**

`addNote` — put a new note on top of an existing order (with no order, newest-first already does):

```ts
  private async addNote(title: string, body: string): Promise<void> {
    // A note with neither a title nor a body is nothing at all — silently ignored
    // rather than toasted: the webview already disables the button, so reaching
    // here means a stale view, not a user who needs telling.
    if (!title.trim() && !body.trim()) return;
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    // Rank it first, so a manual order does not bury the note just written. Write
    // the order before the notes: saveNotes posts, and the post must already see it.
    const order = this.noteOrder();
    if (order.length > 0) await this.saveNoteOrder([id, ...order]);
    await this.saveNotes([...this.notes(), newNote(title, body, id, Date.now())]);
  }
```

`deleteNote`:

```ts
  private async deleteNote(id: string): Promise<void> {
    const remaining = this.notes().filter((n) => n.id !== id);
    await this.pruneNoteOrder(remaining);
    await this.saveNotes(remaining);
  }
```

`clearCompletedNotes`:

```ts
  private async clearCompletedNotes(): Promise<void> {
    const remaining = this.notes().filter((n) => !n.done);
    await this.pruneNoteOrder(remaining);
    await this.saveNotes(remaining);
  }
```

- [ ] **Step 7: Handle the two new messages**

`src/tasksView.ts`, in `onMessage`, after the `case "notepad:run"` block:

```ts
        case "notepad:reorder": {
          const known = new Set(this.notes().map((n) => n.id));
          const visible = m.order.filter((id) => known.has(id));
          if (visible.length === 0) break;
          // Seed from the CURRENT display order, not from the (possibly empty)
          // saved one: applyReorder only preserves the slots of ids it can see in
          // `saved`, so a first drag under a filter would otherwise push every
          // hidden note to the bottom.
          const saved = this.noteOrder();
          const base = saved.length > 0 ? saved : this.orderedNotes().map((n) => n.id);
          await this.saveNoteOrder(applyReorder(base, visible, new Set(visible)));
          this.postNotepad();
          break;
        }
        case "notepad:resetOrder": {
          await this.saveNoteOrder([]);
          this.postNotepad();
          break;
        }
```

- [ ] **Step 8: Run the tests**

Run: `npm test -- test/unit/tasksView.test.ts && npm run typecheck`
Expected: PASS. If other tests in the file assert on a posted `notepad:notes` object with `toEqual`, add `ordered: false` to those expectations — they are the only legitimate breakages.

- [ ] **Step 9: Commit**

```bash
git add src/types.ts src/tasksView.ts test/unit/tasksView.test.ts
git commit -m "feat(notepad): persist a manual note order and post notes in it"
```

---

### Task 3: Drag a note by its grip (webview)

**Files:**
- Modify: `src/webview/Notepad.tsx`
- Modify: `src/webview/App.tsx:169` (state), `:309` (message case), `:525` (render)
- Modify: `src/webview/styles.ts` (notepad block, ~line 318-357)
- Test: `test/webview/Notepad.test.tsx`

**Interfaces:**
- Consumes: `moveKey(list, fromKey, toKey, pos, keyOf)` from Task 1; `{ type: "notepad:reorder"; order: string[] }` and `{ type: "notepad:resetOrder" }` and the `ordered` field from Task 2.
- Produces: `<Notepad notes={NotepadItemView[]} ordered={boolean} />`.

- [ ] **Step 1: Write the failing tests**

Add to `test/webview/Notepad.test.tsx`, at the end of the file. Note the existing `note()` factory defaults `createdAt: 1`; these tests pass explicit ids and rely on render order following the prop array.

```ts
describe("drag to reorder", () => {
  const dt = () => ({ setData: vi.fn(), getData: vi.fn(), effectAllowed: "", dropEffect: "" });
  const three = () => [
    note({ id: "n1", title: "first" }),
    note({ id: "n2", title: "second" }),
    note({ id: "n3", title: "third" }),
  ];

  it("renders notes in the order given, not by createdAt", () => {
    const { container } = render(
      <Notepad ordered notes={[note({ id: "old", title: "old", createdAt: 1 }),
                               note({ id: "new", title: "new", createdAt: 99 })]} />,
    );
    const titles = [...container.querySelectorAll(".np-title")].map((e) => e.textContent);
    expect(titles).toEqual(["old", "new"]);
  });

  it("commits a grip drag as notepad:reorder", () => {
    const { container } = render(<Notepad ordered={false} notes={three()} />);
    const items = container.querySelectorAll(".np-item");
    const first = items[0] as HTMLElement;
    const second = items[1] as HTMLElement;
    const dataTransfer = dt();

    fireEvent.mouseDown(first.querySelector(".grip") as HTMLElement); // arm the drag
    fireEvent.dragStart(first, { dataTransfer });
    fireEvent.dragOver(second, { dataTransfer, clientY: 5 });
    fireEvent.drop(second, { dataTransfer, clientY: 5 });

    // getBoundingClientRect is 0×0 in jsdom → the drop resolves to "after".
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:reorder", order: ["n2", "n1", "n3"] });
  });

  it("does not arm a drag that did not start on the grip", () => {
    const { container } = render(<Notepad ordered={false} notes={three()} />);
    const items = container.querySelectorAll(".np-item");
    fireEvent.dragStart(items[0] as HTMLElement, { dataTransfer: dt() });
    fireEvent.drop(items[1] as HTMLElement, { dataTransfer: dt(), clientY: 5 });
    expect(sendSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: "notepad:reorder" }));
  });

  it("sends only the visible ids when a filter hides notes", () => {
    const { container } = render(
      <Notepad ordered={false} notes={[note({ id: "n1", title: "first" }),
                                       note({ id: "n2", title: "done one", done: true }),
                                       note({ id: "n3", title: "third" })]} />,
    );
    // Default filter is Active, so only n1 and n3 are on screen.
    const items = container.querySelectorAll(".np-item");
    expect(items.length).toBe(2);
    const dataTransfer = dt();
    fireEvent.mouseDown(items[0].querySelector(".grip") as HTMLElement);
    fireEvent.dragStart(items[0], { dataTransfer });
    fireEvent.dragOver(items[1], { dataTransfer, clientY: 5 });
    fireEvent.drop(items[1], { dataTransfer, clientY: 5 });
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:reorder", order: ["n3", "n1"] });
  });

  it("marks the dragged row and the drop edge", () => {
    const { container } = render(<Notepad ordered={false} notes={three()} />);
    const items = container.querySelectorAll(".np-item");
    const dataTransfer = dt();
    fireEvent.mouseDown(items[0].querySelector(".grip") as HTMLElement);
    fireEvent.dragStart(items[0], { dataTransfer });
    fireEvent.dragOver(items[1], { dataTransfer, clientY: 5 });
    expect(items[0].className).toContain("dragging");
    expect(items[1].className).toContain("drop-after");
    fireEvent.dragEnd(items[0]);
    expect(items[0].className).not.toContain("dragging");
  });

  it("shows Reset order only once an order exists, and sends it", () => {
    const { rerender } = render(<Notepad ordered={false} notes={three()} />);
    expect(screen.queryByRole("button", { name: "Reset order" })).toBeNull();
    rerender(<Notepad ordered notes={three()} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset order" }));
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:resetOrder" });
  });

  it("does not offer a grip while a note is being edited", () => {
    const { container } = render(<Notepad ordered={false} notes={[note({ id: "n1" })]} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
    expect(container.querySelector(".grip")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/webview/Notepad.test.tsx`
Expected: FAIL — `Notepad` has no `ordered` prop, `.grip` is null, and the list still sorts by `createdAt`.

- [ ] **Step 3: Rewrite the Notepad list to carry drag state**

`src/webview/Notepad.tsx` — add the `moveKey` import, take the new prop, hold the drag state, drop the sort:

```tsx
import { moveKey } from "./helpers";
```

```tsx
export function Notepad({ notes, ordered }: { notes: NotepadItemView[]; ordered: boolean }): JSX.Element {
  const [filter, setFilter] = React.useState<NoteFilter>("active");
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [editing, setEditing] = React.useState<string | null>(null);
  const [dragId, setDragId] = React.useState<string | null>(null);
  const [dropTarget, setDropTarget] = React.useState<{ id: string; pos: "before" | "after" } | null>(null);
  // The id also lives in a ref: onDrop fires in the same tick as the state update
  // that would otherwise still read null.
  const dragIdRef = React.useRef<string | null>(null);

  const shown = notes.filter((n) => (filter === "all" ? true : filter === "done" ? n.done : !n.done));
  const anyDone = notes.some((n) => n.done);
  const canAdd = title.trim().length > 0 || body.trim().length > 0;

  const endDrag = () => { dragIdRef.current = null; setDragId(null); setDropTarget(null); };
  const beginDrag = (id: string) => { dragIdRef.current = id; setDragId(id); };
  const commitDrop = (targetId: string, pos: "before" | "after") => {
    const from = dragIdRef.current;
    if (from && from !== targetId) {
      // Only the visible notes are named: the host keeps every hidden note in its
      // own slot, so a drop under a filter cannot disturb what it cannot see.
      const next = moveKey(shown, from, targetId, pos, (n) => n.id);
      send({ type: "notepad:reorder", order: next.map((n) => n.id) });
    }
    endDrag();
  };
```

The list itself renders the array as given and hands each row its drag wiring:

```tsx
        <ul
          className="np-list"
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(null); }}
        >
          {shown.map((n) => (
            <NoteRow
              key={n.id}
              note={n}
              editing={editing === n.id}
              onEdit={() => setEditing(n.id)}
              onDone={() => setEditing(null)}
              dnd={{
                onBegin: () => beginDrag(n.id),
                onHover: (pos) => setDropTarget({ id: n.id, pos }),
                onDrop: (pos) => commitDrop(n.id, pos),
                onEnd: endDrag,
                dragging: dragId === n.id,
                hint: dropTarget && dropTarget.id === n.id && dragId && dragId !== n.id ? dropTarget.pos : null,
              }}
            />
          ))}
        </ul>
```

Add the Reset control to the lens row, beside "Clear completed":

```tsx
        {ordered && (
          <button className="quiet dim np-clear" onClick={() => send({ type: "notepad:resetOrder" })}>
            Reset order
          </button>
        )}
```

- [ ] **Step 4: Give `NoteRow` the grip and the drag handlers**

`src/webview/Notepad.tsx` — the same shape the Tasks card uses, so the two surfaces stay one design:

```tsx
interface NoteDnd {
  onBegin: () => void;
  onHover: (pos: "before" | "after") => void;
  onDrop: (pos: "before" | "after") => void;
  onEnd: () => void;
  dragging: boolean;
  hint: "before" | "after" | null;
}

function NoteRow({ note, editing, onEdit, onDone, dnd }: {
  note: NotepadItemView;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
  dnd: NoteDnd;
}): JSX.Element {
  const [title, setTitle] = React.useState(note.title);
  const [body, setBody] = React.useState(note.body);
  const armed = React.useRef(false); // true only while a drag started from the grip
```

(keep the existing `React.useEffect` re-sync and the whole `if (editing)` branch unchanged — an open editor has no grip and is not draggable, which is what the last test asserts).

The resting row:

```tsx
  const railClass = note.runStatus ? RAIL_CLASS[note.runStatus] : "";
  const dropPos = (e: React.DragEvent): "before" | "after" => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return e.clientY < r.top + r.height / 2 ? "before" : "after";
  };
  const cls = [
    "np-item", railClass, note.done ? "is-done" : "",
    dnd.dragging ? "dragging" : "",
    dnd.hint === "before" ? "drop-before" : dnd.hint === "after" ? "drop-after" : "",
  ].filter(Boolean).join(" ");

  return (
    <li
      className={cls}
      draggable
      onMouseDown={() => { armed.current = false; }}
      onDragStart={(e) => {
        if (!armed.current) { e.preventDefault(); return; } // only the grip arms a drag
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", note.id);
        dnd.onBegin();
      }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; dnd.onHover(dropPos(e)); }}
      onDrop={(e) => { e.preventDefault(); dnd.onDrop(dropPos(e)); }}
      onDragEnd={() => { armed.current = false; dnd.onEnd(); }}
    >
      <div className="np-top">
        <span
          className="grip"
          title="Drag to reorder"
          onMouseDown={(e) => { e.stopPropagation(); armed.current = true; }}
        >⠿</span>
        <input
          className="cb"
          type="checkbox"
          checked={note.done}
          aria-label={`Done: ${note.title || "untitled note"}`}
          onChange={() => send({ type: "notepad:toggleDone", id: note.id })}
        />
```

(the rest of the row — title, status, body, actions — is unchanged).

- [ ] **Step 5: Wire the prop through App**

`src/webview/App.tsx:169` — hold the flag beside the notes:

```tsx
  const [notesOrdered, setNotesOrdered] = React.useState(false);
```

`:309` — the message case:

```tsx
        case "notepad:notes":
          setNotes(m.notes);
          setNotesOrdered(m.ordered);
          break;
```

`:525` — the render:

```tsx
      {tab === "notepad" && <Notepad notes={notes} ordered={notesOrdered} />}
```

- [ ] **Step 6: Style the drag**

`src/webview/styles.ts`, inside the notepad block after the `.np-item.r-done` line:

```css
  /* Same drag language as the Tasks card (.card.dragging / .drop-*): the source
     row dims, the row under the pointer shows the edge the note lands on. The
     grip sits inside .np-top, so the rail keeps its own 2px column. */
  .np-item.dragging { opacity: .45; }
  .np-item.drop-before { box-shadow: inset 0 2px 0 0 var(--vscode-focusBorder); }
  .np-item.drop-after  { box-shadow: inset 0 -2px 0 0 var(--vscode-focusBorder); }
  .np-top .grip { margin-left: 0; }
```

(`.grip`'s own rules — `cursor: grab`, `opacity: .4`, `:hover`, `:active` — already exist at line 85 and are reused unchanged; only its Tasks-specific `margin-left: -3px` is neutralised here.)

- [ ] **Step 7: Run the webview tests**

Run: `npm test -- test/webview/ && npm run typecheck`
Expected: PASS. Existing `Notepad.test.tsx` cases that render `<Notepad notes={…} />` now need `ordered={false}` — update them; that is the only legitimate breakage.

- [ ] **Step 8: Build — the only check that catches a webview importing host-only code**

Run: `npm run build`
Expected: succeeds. If it fails on an `fs`/`path` resolution, the cause is an import added to `Notepad.tsx` that reaches `src/engine/*` or `src/notepad.ts`; only `./helpers` and `../types` are allowed.

- [ ] **Step 9: Commit**

```bash
git add src/webview/Notepad.tsx src/webview/App.tsx src/webview/styles.ts test/webview/Notepad.test.tsx
git commit -m "feat(notepad): drag a note by its grip to reorder the list"
```

---

### Task 4: Coverage and release notes

**Files:**
- Modify: `CHANGELOG.md`
- Possibly modify: `test/unit/tasksView.test.ts`, `test/webview/Notepad.test.tsx` (only to close coverage gaps)

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: a releasable branch.

- [ ] **Step 1: Run coverage**

Run: `npm run test:cov`
Expected: thresholds pass. Read the report for `src/tasksView.ts`, `src/webview/Notepad.tsx`, `src/engine/order.ts`, `src/webview/helpers.ts` — the lines this plan added must be ≥95% covered.

- [ ] **Step 2: Close any gap with a real test**

If a line is uncovered, add a test that would FAIL if that line were deleted or inverted — never a test that merely executes it. The likely gaps and the tests that close them:

```ts
    it("ignores a reorder that names no known note", async () => {
      const { store, sendMsg } = await threeNotes();
      await sendMsg({ type: "notepad:reorder", order: ["ghost"] });
      expect(orderIn(store) ?? []).toEqual([]); // nothing written at all
    });

    it("leaves the order alone when a delete removes nothing", async () => {
      const { store, sendMsg, ids } = await threeNotes();
      await sendMsg({ type: "notepad:reorder", order: [ids[0], ids[2], ids[1]] });
      await sendMsg({ type: "notepad:delete", id: "ghost" });
      expect(orderIn(store)).toEqual([ids[0], ids[2], ids[1]]);
    });
```

- [ ] **Step 3: Add the changelog entry**

`CHANGELOG.md`, under `## [Unreleased]` (create the heading if the last release consumed it), in the existing style of the file:

```markdown
### Added
- **Notepad: drag to reorder.** Each note has a grip — drag it to put the list in the order you want. The order is yours, persists across reloads, and applies under every filter; "Reset order" puts the list back to newest-first. A notepad you never drag looks exactly as it did.
```

- [ ] **Step 4: Full gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: all three pass.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md test/unit/tasksView.test.ts test/webview/Notepad.test.tsx
git commit -m "docs: note the Notepad drag-to-reorder in the changelog"
```

---

## Manual verification (after Task 4)

The webview tests run in jsdom, where `getBoundingClientRect` is 0×0 and no real drag occurs. Confirm the real thing once in an Extension Development Host — launch it with VS Code's `code` CLI (the Cursor CLI silently drops `--extensionDevelopmentPath`):

1. Open the Notepad tab, add three notes.
2. Drag the bottom note to the top by its grip. The row dims, a line shows the landing edge, and the list settles in the new order.
3. Reload the window — the order holds.
4. Add a note — it appears on top.
5. Mark one done, filter to Active, reorder the visible pair, then switch to All — the done note is still where it was.
6. Click "Reset order" — the list returns to newest-first and the button disappears.
7. Select text in a note's title and press Start / edit / delete — none of them start a drag.
