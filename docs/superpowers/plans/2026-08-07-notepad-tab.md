# Notepad Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Notepad tab to the Agent Flow Tasks sidebar — a globally-persisted list of freeform items with done/undone state, an Active-by-default filter, speech-to-text dictation, and the ability to kick off an agent whose run appears on the Deck board and reports its status back on the note.

**Architecture:** The Notepad is a second view inside the existing `agentFlow.tasks` webview, selected by a tab bar in `App.tsx`. Notes live in `context.globalState` (not `workspaceState` — they are the user's, not a repo's), owned by `TasksViewProvider`, which round-trips them to the webview over the existing `postMessage` protocol. Kicking off a note reuses the same `createWorktrees`/`openWorkspace` path `explore()` uses, passing a new `kind: "notepad"` — which writes an ordinary `Run` into `~/.agentflow/runs`, the store the Deck already reads, so notepad runs land on the board with no new data path. Each note's status badge is derived read-only from `readRuns()` plus the live-session set.

**Tech Stack:** TypeScript, React 18 (webview), esbuild, Vitest + Testing Library, VS Code extension API.

## Global Constraints

These apply to **every** task. They are the repo's CI gates (`CONTRIBUTING.md`) — a task is not done until they hold.

- `npm test` must pass. Baseline before this plan: **2264 tests, 80 files, 0 failures.**
- `npm run typecheck` (`tsc --noEmit`) must be clean. Run it before every commit — the suite does **not** typecheck for you.
- `npm run build` must succeed (esbuild bundles host + both webviews).
- `npm run test:cov` enforces thresholds: **statements 90, branches 85, functions 85, lines 90.** Add tests for every behavior change.
- Add or update tests for any behavior change. The `vscode` module is mocked in `test/_mocks/vscode.ts`; helpers live in `test/_helpers/factories.ts`.
- **No hardcoded organization values.** Anything user- or org-varying goes through a `agentFlow.*` setting read via `getConfig()` in `src/config.ts`. (This feature introduces no new settings — if you find yourself wanting one, stop and ask.)
- **Never import a task connector directly.** Nothing in this feature touches `src/tasks/jira/`; notepad runs are ticketless by design.
- **Do not run `npm install`.** The user's global `~/.npmrc` points at a private registry and re-pollutes `package-lock.json`, causing CI `E401`. Dependencies are already installed in this worktree. This feature adds **no new dependencies**.
- Add a `## [Unreleased]` entry in `CHANGELOG.md` for user-facing changes (done once, in Task 8).
- Webview code must never import a module that touches `fs` (see the note on `OpenSession` in `src/types.ts:97-100`). All filesystem reads happen host-side and cross the wire as plain data.

---

## File Structure

**Created:**
- `src/webview/Notepad.tsx` — the entire Notepad view: add form, filter bar, note list, mic button. One responsibility: render notes and emit `notepad:*` messages. No `fs`, no host imports beyond types and `send`.
- `src/notepad.ts` — pure, host-side notepad logic: the `NotepadItem` type's storage helpers and the status-derivation function. Pure functions only (no `vscode`, no `fs`), so it is testable without mocks and reusable from `tasksView.ts`.
- `test/unit/notepad.test.ts` — unit tests for `src/notepad.ts`.
- `test/webview/Notepad.test.tsx` — component tests for `Notepad.tsx`.

**Modified:**
- `src/types.ts` — add `"notepad"` to `Run["kind"]` + `RUN_KINDS` + `runKind`'s return type; add `NotepadItem`/`NotepadItemView`/`NotepadRunStatus`; add the six `notepad:*` inbound messages and the one outbound.
- `src/tasksView.ts` — add `NOTEPAD_KEY`, the note CRUD methods, `runNotepadItem`, status computation, `postNotepad`, and the six `onMessage` cases.
- `src/webview/App.tsx` — add the tab bar and render `<Notepad>` when selected; handle the `notepad:state` message.
- `src/webview/styles.ts` — styles for the tab bar, note rows, status badges, and mic button.
- `src/webview/DeckApp.tsx` — label `"notepad"` runs on the untracked-key chip.
- `CHANGELOG.md` — one `## [Unreleased]` entry.

**Why `src/notepad.ts` is separate from `tasksView.ts`:** `tasksView.ts` is already 1705 lines. The status derivation and note-array transforms are pure and independently testable; putting them in a class method would force every test through a `TasksViewProvider` with a mocked `vscode` context. Keep the pure core outside, the `vscode`-touching glue inside.

---

### Task 1: The `"notepad"` run kind

Adds the run kind end-to-end at the type layer so later tasks can write it. Independently valuable: after this task, a hand-written `kind: "notepad"` record survives `runKind()` instead of being silently relabelled `"task"`.

**Files:**
- Modify: `src/types.ts:75` (the `kind` union), `src/types.ts:89` (`RUN_KINDS`), `src/types.ts:93-95` (`runKind`)
- Test: `test/unit/types.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `Run["kind"]` now includes `"notepad"`; `runKind(run): "task" | "explore" | "review" | "local" | "notepad"`

- [ ] **Step 1: Write the failing test**

Add to `test/unit/types.test.ts` (find the existing `describe` for `runKind` and add these inside it; if none exists, add a new `describe("runKind", ...)` block):

```ts
it("keeps a notepad run's kind rather than clamping it to task", () => {
  const run = { key: "notepad-x", summary: "s", url: "", createdAt: 1, kind: "notepad",
    mode: "per-window", repos: [], briefPaths: [] } as unknown as Run;
  expect(runKind(run)).toBe("notepad");
});

it("still clamps an unknown kind to task", () => {
  const run = { key: "k", summary: "s", url: "", createdAt: 1, kind: "nonsense",
    mode: "per-window", repos: [], briefPaths: [] } as unknown as Run;
  expect(runKind(run)).toBe("task");
});
```

Make sure `Run` and `runKind` are imported at the top of the file (`import { Run, runKind } from "../../src/types";` — merge into the existing import if one is already there).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/types.test.ts -t "notepad"`
Expected: FAIL — `expected 'task' to be 'notepad'`

- [ ] **Step 3: Write the implementation**

In `src/types.ts`, change the `kind` field on `Run` (line ~75). Keep the existing doc comment above it and append the new sentence:

```ts
  /** … existing comment text, unchanged …
   * "notepad" is a run launched from the Notepad tab: ticketless like "explore",
   * but distinguishable from it so the board can label it for what it is. */
  kind?: "task" | "explore" | "review" | "local" | "notepad";
```

Then line ~89 and the `runKind` signature:

```ts
const RUN_KINDS = new Set(["task", "explore", "review", "local", "notepad"]);

/** A run's kind, tolerant of an old record with no field and of a hand-edited
 * one with a value we don't know. */
export function runKind(run: Run): "task" | "explore" | "review" | "local" | "notepad" {
  return RUN_KINDS.has(run.kind as string)
    ? (run.kind as "task" | "explore" | "review" | "local" | "notepad")
    : "task";
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run test/unit/types.test.ts && npm run typecheck`
Expected: PASS, and typecheck clean.

`runKind`'s widened return type may surface exhaustiveness errors at its call sites (`src/deckView.ts`, `src/webview/DeckApp.tsx`, `src/engine/runs.ts`). If typecheck reports any, they are real — fix them by treating `"notepad"` like `"explore"` (a ticketless run) at that site. Do not silence with a cast.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, 2264+ tests. `runKind` is widely used; this catches anything the targeted run missed.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts test/unit/types.test.ts
git commit -m "feat(types): add the notepad run kind"
```

---

### Task 2: Pure notepad core (`src/notepad.ts`)

The `NotepadItem` type, its array transforms, and the status derivation — all pure, no `vscode`, no `fs`. This is the piece every later task builds on.

**Files:**
- Create: `src/notepad.ts`
- Create: `test/unit/notepad.test.ts`
- Modify: `src/types.ts` (add the shared types the webview also needs)

**Interfaces:**
- Consumes: `Run` and `runKind` from Task 1
- Produces:
  - `NotepadItem = { id: string; title: string; body: string; done: boolean; createdAt: number; lastRunKey?: string }` (in `src/types.ts`)
  - `NotepadRunStatus = "running" | "stale" | "finished"` (in `src/types.ts`)
  - `NotepadItemView = NotepadItem & { runStatus?: NotepadRunStatus }` (in `src/types.ts`)
  - `noteStatus(note: NotepadItem, runs: Run[], livePlaces: ReadonlySet<string>): NotepadRunStatus | undefined` (in `src/notepad.ts`)
  - `newNote(title: string, body: string, id: string, createdAt: number): NotepadItem` (in `src/notepad.ts`)
  - `sanitizeNotes(raw: unknown): NotepadItem[]` (in `src/notepad.ts`)

- [ ] **Step 1: Add the shared types**

In `src/types.ts`, add this block immediately **before** the `// Messages: webview → host` comment (around line 314):

```ts
// ── The Notepad: local, ticketless scratch items ────────────────────────────

/** One notepad item, exactly as persisted in globalState. Deliberately global
 * rather than per-workspace: these are the user's scratch items, not a repo's.
 * `lastRunKey` is the key of the most recent run launched from this note — the
 * only run-related field stored, since everything else is derived at read time. */
export interface NotepadItem {
  id: string;
  title: string;
  body: string;
  done: boolean;
  createdAt: number; // epoch ms
  lastRunKey?: string;
}

/** A note's most recent run, as far as the two cheap signals can tell:
 * "running" — a Claude Code session is open in one of its repos right now;
 * "stale" — launched, but nothing attached to it at the moment;
 * "finished" — the Deck's retire sweep stamped it landed.
 * Absent entirely when there is no run record to speak for (never launched, or
 * the Deck already retired it — guessing which would be dishonest). */
export type NotepadRunStatus = "running" | "stale" | "finished";

/** What crosses the wire: the stored note plus its derived status. The status is
 * computed host-side per post and never persisted — the webview cannot read the
 * runs store itself (it must not import a module that touches `fs`). */
export type NotepadItemView = NotepadItem & { runStatus?: NotepadRunStatus };
```

- [ ] **Step 2: Write the failing tests**

Create `test/unit/notepad.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { newNote, noteStatus, sanitizeNotes } from "../../src/notepad";
import type { NotepadItem, Run } from "../../src/types";

function run(over: Partial<Run> = {}): Run {
  return { key: "notepad-a", summary: "s", url: "", createdAt: 1, kind: "notepad",
    mode: "per-window", repos: [{ name: "r", path: "/repo", isGit: true }],
    briefPaths: [], ...over } as Run;
}
function note(over: Partial<NotepadItem> = {}): NotepadItem {
  return { id: "n1", title: "t", body: "b", done: false, createdAt: 1, ...over };
}

describe("noteStatus", () => {
  it("is absent for a note that was never run", () => {
    expect(noteStatus(note(), [run()], new Set())).toBeUndefined();
  });

  it("is absent when the run record is gone (the Deck already retired it)", () => {
    expect(noteStatus(note({ lastRunKey: "notepad-gone" }), [run()], new Set())).toBeUndefined();
  });

  it("is finished once the retire sweep stamped finishedAt", () => {
    const runs = [run({ finishedAt: 99 })];
    expect(noteStatus(note({ lastRunKey: "notepad-a" }), runs, new Set(["/repo"]))).toBe("finished");
  });

  it("is running when a session is live in one of the run's repos", () => {
    expect(noteStatus(note({ lastRunKey: "notepad-a" }), [run()], new Set(["/repo"]))).toBe("running");
  });

  it("is stale when the run is live-less and unfinished", () => {
    expect(noteStatus(note({ lastRunKey: "notepad-a" }), [run()], new Set(["/elsewhere"]))).toBe("stale");
  });

  it("tolerates a record whose repos field is missing entirely", () => {
    const runs = [{ key: "notepad-a", summary: "s", url: "", createdAt: 1 } as unknown as Run];
    expect(noteStatus(note({ lastRunKey: "notepad-a" }), runs, new Set(["/repo"]))).toBe("stale");
  });
});

describe("newNote", () => {
  it("trims the title and body and starts undone", () => {
    expect(newNote("  hi  ", "  there  ", "id-1", 7)).toEqual({
      id: "id-1", title: "hi", body: "there", done: false, createdAt: 7,
    });
  });
});

describe("sanitizeNotes", () => {
  it("returns an empty array for anything that is not an array", () => {
    expect(sanitizeNotes(undefined)).toEqual([]);
    expect(sanitizeNotes({ nope: true })).toEqual([]);
  });

  it("drops entries with no usable id and coerces the rest", () => {
    const out = sanitizeNotes([
      { id: "keep", title: "t", body: "b", done: true, createdAt: 5 },
      { title: "no id" },
      { id: "coerce" },
    ]);
    expect(out).toEqual([
      { id: "keep", title: "t", body: "b", done: true, createdAt: 5 },
      { id: "coerce", title: "", body: "", done: false, createdAt: 0 },
    ]);
  });

  it("preserves lastRunKey when present and omits it when not a string", () => {
    const out = sanitizeNotes([
      { id: "a", lastRunKey: "notepad-x" },
      { id: "b", lastRunKey: 42 },
    ]);
    expect(out[0].lastRunKey).toBe("notepad-x");
    expect(out[1].lastRunKey).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/unit/notepad.test.ts`
Expected: FAIL — cannot resolve `../../src/notepad`

- [ ] **Step 4: Write the implementation**

Create `src/notepad.ts`:

```ts
// Pure notepad logic — no `vscode`, no `fs`. Lives outside tasksView.ts so it is
// testable without a mocked extension context, and so the 1700-line controller
// grows only the glue that genuinely needs VS Code.
import { NotepadItem, NotepadRunStatus, Run } from "./types";
import { canon } from "./engine/paths";

/** A note's run status, from the two cheap signals `describeActiveTasks` already
 * uses for the same question — deliberately NOT `retireVerdict`, which needs live
 * git state, `gh` PR facts, and a ticket category that the Tasks panel neither
 * has nor should pay for on every poll.
 *
 * `livePlaces` is the canonicalised repo-root set of directories with a Claude
 * Code session open right now: build it exactly as deckView.ts does —
 * `new Set(groupByPlace(readOpenSessions(dir)).keys())`.
 *
 * Undefined means "nothing to say": either the note was never run, or its record
 * is gone because the Deck's sweep already retired it. Claiming "finished" for a
 * retired record would be a guess — retirement covers unreachable and abandoned
 * too, not just landed work. */
export function noteStatus(
  note: NotepadItem,
  runs: Run[],
  livePlaces: ReadonlySet<string>,
): NotepadRunStatus | undefined {
  if (!note.lastRunKey) return undefined;
  const run = runs.find((r) => r.key === note.lastRunKey);
  if (!run) return undefined;
  if (typeof run.finishedAt === "number") return "finished";
  // `repos` is guarded rather than trusted, for the same reason describeActiveTasks
  // guards it: readRuns only validates that a record has `.key`, so a legacy or
  // hand-edited file can reach here with `repos` missing entirely.
  const repos = run.repos ?? [];
  return repos.some((r) => livePlaces.has(canon(r.path))) ? "running" : "stale";
}

/** A fresh note. `id` and `createdAt` are injected rather than generated here so
 * this stays pure and its tests need no clock or randomness stub. */
export function newNote(title: string, body: string, id: string, createdAt: number): NotepadItem {
  return { id, title: title.trim(), body: body.trim(), done: false, createdAt };
}

/** Notes as read back from globalState, which is untyped storage that a previous
 * version — or a hand-edited state file — may have left in any shape. Anything
 * without a usable id is dropped; everything else is coerced to the current
 * shape rather than trusted, so one bad record cannot break the whole panel. */
export function sanitizeNotes(raw: unknown): NotepadItem[] {
  if (!Array.isArray(raw)) return [];
  const out: NotepadItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || e.id.length === 0) continue;
    const note: NotepadItem = {
      id: e.id,
      title: typeof e.title === "string" ? e.title : "",
      body: typeof e.body === "string" ? e.body : "",
      done: e.done === true,
      createdAt: typeof e.createdAt === "number" ? e.createdAt : 0,
    };
    if (typeof e.lastRunKey === "string") note.lastRunKey = e.lastRunKey;
    out.push(note);
  }
  return out;
}
```

Check that `canon` is exported from `src/engine/paths.ts` (it is — `src/engine/runs.ts:5` imports it the same way). `paths.ts` must not pull in `fs` at module scope; if it does, inline a local `canon` instead rather than dragging `fs` into a module the webview might one day import.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/unit/notepad.test.ts && npm run typecheck`
Expected: PASS (14 tests), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/notepad.ts src/types.ts test/unit/notepad.test.ts
git commit -m "feat(notepad): add pure notepad core — types, status derivation, sanitizer"
```

---

### Task 3: The message protocol

Adds the six inbound and one outbound message variants. Type-only; no behavior yet. Independently reviewable as "is this the right wire shape."

**Files:**
- Modify: `src/types.ts` (`InboundMessage` ~line 315-360, `OutboundMessage` ~line 363-461)

**Interfaces:**
- Consumes: `NotepadItemView` from Task 2
- Produces: the `notepad:*` message variants, consumed by Tasks 4 and 5

- [ ] **Step 1: Add the inbound variants**

In `src/types.ts`, in the `InboundMessage` union, add these lines immediately after the `| { type: "explore" }` line:

```ts
  // The Notepad tab (same webview as the task pool, second view)
  | { type: "notepad:add"; title: string; body: string }
  | { type: "notepad:update"; id: string; title: string; body: string }
  | { type: "notepad:toggleDone"; id: string }
  | { type: "notepad:delete"; id: string }
  | { type: "notepad:clearCompleted" }
  | { type: "notepad:run"; id: string }
```

- [ ] **Step 2: Add the outbound variant**

In the `OutboundMessage` union, add immediately after the `| { type: "loading"; loading: boolean }` line:

```ts
  // Every note, with each one's derived run status. Posted on `ready`, after every
  // mutation, and on a poll tick so a badge cannot go stale while the panel sits
  // open. The whole array every time: it is a handful of small records, and a
  // diff protocol would buy nothing but a chance to desynchronise.
  | { type: "notepad:notes"; notes: NotepadItemView[] }
```

Note the message name is `notepad:notes`, not `notepad:state` — `state` already means the panel's auth/config envelope in this protocol, and reusing the word for a second, unrelated payload would be actively misleading.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean. If `src/webview/App.tsx` or `src/tasksView.ts` has an exhaustive `switch` over these unions, TypeScript will flag the new variants — that is the point, and Tasks 4 and 5 handle them. If it errors **now**, add a `default: break;` only if one is already the file's established pattern; otherwise leave the error and let Task 4/5 resolve it.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS. Type-only changes should not move any test.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): add the notepad message protocol"
```

---

### Task 4: Host-side note storage and CRUD

`TasksViewProvider` owns the notes: reads them from `globalState`, mutates them, and posts them back with derived status. No kickoff yet (Task 6) and no UI yet (Task 5) — this task ends with a fully working, fully tested host half.

**Files:**
- Modify: `src/tasksView.ts` (imports at top; `NOTEPAD_KEY` near `SPRINT_ORDER_KEY` line 36; new methods near `savedOrder`/`saveOrder` lines 216-222; new `onMessage` cases near line 391)
- Test: `test/unit/tasksView.test.ts`

**Interfaces:**
- Consumes: `NotepadItem`, `NotepadItemView` (Task 2); `noteStatus`, `newNote`, `sanitizeNotes` (Task 2); the `notepad:*` messages (Task 3)
- Produces:
  - `TasksViewProvider.postNotepad(): void`
  - private `notes(): NotepadItem[]`, `saveNotes(notes: NotepadItem[]): Promise<void>`
  - `onMessage` handling for `notepad:add`/`update`/`toggleDone`/`delete`/`clearCompleted`

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/tasksView.test.ts`. Put this in a new top-level `describe` at the end of the file.

The file already mocks `../../src/engine/runs` (line ~57) and `../../src/engine/sessions`. Confirm both mocks expose what this needs: `readRuns` and `defaultRunsDir` from runs; `readOpenSessions`, `groupByPlace`, `defaultSessionsDir` from sessions. If the sessions mock is missing any, extend it in place following the existing style.

```ts
describe("notepad", () => {
  // A provider wired to a context whose globalState is a real in-memory map, so
  // these tests assert on what was actually persisted rather than on a spy.
  function mkProvider() {
    const store = new Map<string, unknown>();
    const ctx = {
      ...fakeContext(),
      globalState: {
        get: (k: string, d?: unknown) => (store.has(k) ? store.get(k) : d),
        update: async (k: string, v: unknown) => void store.set(k, v),
      },
    } as unknown as ConstructorParameters<typeof TasksViewProvider>[0];
    const posted: unknown[] = [];
    const provider = new TasksViewProvider(ctx, fixtureConnector(), () => {});
    // The provider posts through its resolved webview; stand one in.
    (provider as unknown as { view: unknown }).view = {
      webview: { postMessage: (m: unknown) => void posted.push(m) },
    };
    // `onMessage` is private on the class — these tests drive it directly because
    // it IS the unit under test. Check how the existing tests in this file reach
    // it first (search for `onMessage`) and match whatever they already do.
    const sendMsg = (m: InboundMessage) =>
      (provider as unknown as { onMessage(m: InboundMessage): Promise<void> }).onMessage(m);
    return { provider, posted, store, sendMsg };
  }

  const notesIn = (store: Map<string, unknown>) =>
    store.get("agentFlow.notepad") as { id: string; title: string; done: boolean }[] | undefined;

  it("adds a note and posts the new list back", async () => {
    const { posted, store, sendMsg } = mkProvider();
    await sendMsg({ type: "notepad:add", title: "Write the thing", body: "details" });
    expect(notesIn(store)!.map((n) => n.title)).toEqual(["Write the thing"]);
    const last = posted.at(-1) as { type: string; notes: { title: string }[] };
    expect(last.type).toBe("notepad:notes");
    expect(last.notes.map((n) => n.title)).toEqual(["Write the thing"]);
  });

  it("ignores an add whose title and body are both blank", async () => {
    const { store, sendMsg } = mkProvider();
    await sendMsg({ type: "notepad:add", title: "   ", body: "  " });
    expect(notesIn(store) ?? []).toEqual([]);
  });

  it("edits a note in place", async () => {
    const { store, sendMsg } = mkProvider();
    await sendMsg({ type: "notepad:add", title: "old", body: "b" });
    const id = notesIn(store)![0].id;
    await sendMsg({ type: "notepad:update", id, title: "new", body: "b2" });
    expect(notesIn(store)![0]).toMatchObject({ id, title: "new", body: "b2" });
  });

  it("toggles done and back", async () => {
    const { store, sendMsg } = mkProvider();
    await sendMsg({ type: "notepad:add", title: "t", body: "" });
    const id = notesIn(store)![0].id;
    await sendMsg({ type: "notepad:toggleDone", id });
    expect(notesIn(store)![0].done).toBe(true);
    await sendMsg({ type: "notepad:toggleDone", id });
    expect(notesIn(store)![0].done).toBe(false);
  });

  it("deletes one note and leaves the rest", async () => {
    const { store, sendMsg } = mkProvider();
    await sendMsg({ type: "notepad:add", title: "a", body: "" });
    await sendMsg({ type: "notepad:add", title: "b", body: "" });
    const id = notesIn(store)!.find((n) => n.title === "a")!.id;
    await sendMsg({ type: "notepad:delete", id });
    expect(notesIn(store)!.map((n) => n.title)).toEqual(["b"]);
  });

  it("clears only the completed notes", async () => {
    const { store, sendMsg } = mkProvider();
    await sendMsg({ type: "notepad:add", title: "keep", body: "" });
    await sendMsg({ type: "notepad:add", title: "drop", body: "" });
    const id = notesIn(store)!.find((n) => n.title === "drop")!.id;
    await sendMsg({ type: "notepad:toggleDone", id });
    await sendMsg({ type: "notepad:clearCompleted" });
    expect(notesIn(store)!.map((n) => n.title)).toEqual(["keep"]);
  });

  it("survives a globalState value that is not an array", async () => {
    const { provider, store, posted } = mkProvider();
    store.set("agentFlow.notepad", { corrupt: true });
    provider.postNotepad();
    expect((posted.at(-1) as { notes: unknown[] }).notes).toEqual([]);
  });
});
```

Check the import line at the top of the file — `fakeContext`, `fixtureConnector`, `TasksViewProvider`, and the `InboundMessage` type must all be imported. Extend the existing imports rather than adding duplicates.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/tasksView.test.ts -t "notepad"`
Expected: FAIL — no `postNotepad`, and unhandled message types.

- [ ] **Step 3: Write the implementation**

In `src/tasksView.ts`:

Add the imports beside the existing ones:

```ts
import { NotepadItem, NotepadItemView } from "./types";  // merge into the existing ./types import
import { newNote, noteStatus, sanitizeNotes } from "./notepad";
```

Add the key beside `SPRINT_ORDER_KEY` (line 36):

```ts
const SPRINT_ORDER_KEY = "agentFlow.sprintOrder";
// globalState, not workspaceState: a notepad belongs to the user, not to whichever
// repo happens to be open. Same storage the install-reported flag uses.
const NOTEPAD_KEY = "agentFlow.notepad";
```

Add these methods immediately after `saveOrder` (line 222):

```ts
  private notes(): NotepadItem[] {
    return sanitizeNotes(this.context.globalState.get<unknown>(NOTEPAD_KEY, []));
  }

  private async saveNotes(notes: NotepadItem[]): Promise<void> {
    await this.context.globalState.update(NOTEPAD_KEY, notes);
    this.postNotepad();
  }

  /** Post every note with its derived run status. Public because the poll tick in
   * extension.ts drives it too — a badge must not sit stale while the panel is open. */
  public postNotepad(): void {
    const notes = this.notes();
    // Skip both directory reads entirely when nothing has ever been launched:
    // the common case is a notepad of plain items with no runs behind them.
    const anyRun = notes.some((n) => n.lastRunKey);
    const runs = anyRun ? readRuns(defaultRunsDir()) : [];
    const livePlaces = anyRun
      ? new Set(groupByPlace(readOpenSessions(defaultSessionsDir())).keys())
      : new Set<string>();
    const view: NotepadItemView[] = notes.map((n) => {
      const runStatus = noteStatus(n, runs, livePlaces);
      return runStatus ? { ...n, runStatus } : { ...n };
    });
    this.post({ type: "notepad:notes", notes: view });
  }

  private async addNote(title: string, body: string): Promise<void> {
    // A note with neither a title nor a body is nothing at all — silently ignored
    // rather than toasted: the webview already disables the button, so reaching
    // here means a stale view, not a user who needs telling.
    if (!title.trim() && !body.trim()) return;
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await this.saveNotes([...this.notes(), newNote(title, body, id, Date.now())]);
  }

  private async updateNote(id: string, title: string, body: string): Promise<void> {
    await this.saveNotes(
      this.notes().map((n) => (n.id === id ? { ...n, title: title.trim(), body: body.trim() } : n)),
    );
  }

  private async toggleNoteDone(id: string): Promise<void> {
    await this.saveNotes(this.notes().map((n) => (n.id === id ? { ...n, done: !n.done } : n)));
  }

  private async deleteNote(id: string): Promise<void> {
    await this.saveNotes(this.notes().filter((n) => n.id !== id));
  }

  private async clearCompletedNotes(): Promise<void> {
    await this.saveNotes(this.notes().filter((n) => !n.done));
  }
```

`readRuns`, `defaultRunsDir`, `groupByPlace`, `readOpenSessions`, `defaultSessionsDir` are all already imported at lines 27-28 — do not add duplicate imports.

Add the cases in `onMessage`, immediately after the `case "explore":` block (line ~394):

```ts
        case "notepad:add": {
          await this.addNote(m.title, m.body);
          break;
        }
        case "notepad:update": {
          await this.updateNote(m.id, m.title, m.body);
          break;
        }
        case "notepad:toggleDone": {
          await this.toggleNoteDone(m.id);
          break;
        }
        case "notepad:delete": {
          await this.deleteNote(m.id);
          break;
        }
        case "notepad:clearCompleted": {
          await this.clearCompletedNotes();
          break;
        }
```

(`notepad:run` is deliberately left out — Task 6 adds it. If the union's exhaustiveness makes typecheck complain about the missing case, add it now as `case "notepad:run": break;` and Task 6 fills it in.)

Finally, post the notes on first paint. Find `postInitialState` (around line 228) and add `this.postNotepad();` right after it posts `state` — the notepad must render with the panel, not after a network round-trip that may never succeed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/tasksView.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tasksView.ts test/unit/tasksView.test.ts
git commit -m "feat(notepad): persist notes in globalState with CRUD over the message protocol"
```

---

### Task 5: The Notepad view and tab bar

The whole webview half: tab bar in `App.tsx`, the `Notepad.tsx` component, and styles. Speech-to-text is Task 7 — build the mic button's *place* here but not its behavior.

**Files:**
- Create: `src/webview/Notepad.tsx`
- Create: `test/webview/Notepad.test.tsx`
- Modify: `src/webview/App.tsx` (imports line 1-10; new state near line 161; message handler near line 296; render near line 500)
- Modify: `src/webview/styles.ts`

**Interfaces:**
- Consumes: `NotepadItemView`, `NotepadRunStatus` (Task 2); `notepad:*` messages (Task 3); host behavior (Task 4)
- Produces: `Notepad` component — `({ notes }: { notes: NotepadItemView[] }) => JSX.Element`

- [ ] **Step 1: Write the failing component tests**

Create `test/webview/Notepad.test.tsx`. Open `test/webview/App.test.tsx` first and copy its exact setup preamble (how it mocks `./vscodeApi`, how it imports Testing Library, whether it uses `@testing-library/user-event` or `fireEvent`) — match it rather than inventing a second convention.

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import * as React from "react";

const sendSpy = vi.fn();
vi.mock("../../src/webview/vscodeApi", () => ({ send: (m: unknown) => sendSpy(m) }));

import { Notepad } from "../../src/webview/Notepad";
import type { NotepadItemView } from "../../src/types";

const note = (over: Partial<NotepadItemView> = {}): NotepadItemView => ({
  id: "n1", title: "Ship the thing", body: "body", done: false, createdAt: 1, ...over,
});

beforeEach(() => sendSpy.mockClear());

describe("Notepad", () => {
  it("defaults the filter to Active", () => {
    render(<Notepad notes={[note({ id: "a", title: "open" }), note({ id: "b", title: "shut", done: true })]} />);
    expect(screen.getByRole("button", { name: "Active" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("open")).toBeTruthy();
    expect(screen.queryByText("shut")).toBeNull();
  });

  it("shows done notes under the Done filter and everything under All", () => {
    render(<Notepad notes={[note({ id: "a", title: "open" }), note({ id: "b", title: "shut", done: true })]} />);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText("open")).toBeNull();
    expect(screen.getByText("shut")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByText("open")).toBeTruthy();
    expect(screen.getByText("shut")).toBeTruthy();
  });

  it("sends notepad:add with the typed title and body, then clears the form", () => {
    render(<Notepad notes={[]} />);
    const title = screen.getByPlaceholderText("What needs doing?");
    const body = screen.getByPlaceholderText("Any detail the agent should know (optional)");
    fireEvent.change(title, { target: { value: "New task" } });
    fireEvent.change(body, { target: { value: "with detail" } });
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:add", title: "New task", body: "with detail" });
    expect((title as HTMLInputElement).value).toBe("");
    expect((body as HTMLTextAreaElement).value).toBe("");
  });

  it("will not add a note with nothing in it", () => {
    render(<Notepad notes={[]} />);
    expect(screen.getByRole("button", { name: "Add note" })).toBeDisabled();
  });

  it("sends notepad:toggleDone from the checkbox", () => {
    render(<Notepad notes={[note()]} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Ship the thing/ }));
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:toggleDone", id: "n1" });
  });

  it("sends notepad:run from Run agent", () => {
    render(<Notepad notes={[note()]} />);
    fireEvent.click(screen.getByRole("button", { name: "Run agent" }));
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:run", id: "n1" });
  });

  it("sends notepad:delete from Delete", () => {
    render(<Notepad notes={[note()]} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete note" }));
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:delete", id: "n1" });
  });

  it("hides Clear completed until something is done", () => {
    const { rerender } = render(<Notepad notes={[note()]} />);
    expect(screen.queryByRole("button", { name: "Clear completed" })).toBeNull();
    rerender(<Notepad notes={[note({ done: true })]} />);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear completed" }));
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:clearCompleted" });
  });

  it("renders each run status as its own badge and none when absent", () => {
    render(<Notepad notes={[
      note({ id: "a", title: "r", runStatus: "running" }),
      note({ id: "b", title: "s", runStatus: "stale" }),
      note({ id: "c", title: "f", runStatus: "finished" }),
      note({ id: "d", title: "n" }),
    ]} />);
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("Stale")).toBeTruthy();
    expect(screen.getByText("Finished")).toBeTruthy();
    expect(screen.getAllByText(/Running|Stale|Finished/)).toHaveLength(3);
  });

  it("edits a note and sends notepad:update", () => {
    render(<Notepad notes={[note()]} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
    const title = screen.getByDisplayValue("Ship the thing");
    fireEvent.change(title, { target: { value: "Ship it better" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:update", id: "n1", title: "Ship it better", body: "body" });
  });

  it("says so when the filter hides everything", () => {
    render(<Notepad notes={[note({ done: true })]} />);
    expect(screen.getByText("Nothing active. Add a note above.")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/webview/Notepad.test.tsx`
Expected: FAIL — cannot resolve `../../src/webview/Notepad`

- [ ] **Step 3: Write the component**

Create `src/webview/Notepad.tsx`:

```tsx
import * as React from "react";
import { send } from "./vscodeApi";
import { NotepadItemView, NotepadRunStatus } from "../types";

/** Which notes the list shows. Local state, defaulting to Active on every mount:
 * a persisted "Done" selection would greet the user with an empty-looking notepad
 * one session later, with no obvious cause. */
type NoteFilter = "active" | "done" | "all";

const FILTERS: { id: NoteFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "done", label: "Done" },
];

const STATUS_LABEL: Record<NotepadRunStatus, string> = {
  running: "Running",
  stale: "Stale",
  finished: "Finished",
};

const EMPTY: Record<NoteFilter, string> = {
  active: "Nothing active. Add a note above.",
  done: "Nothing done yet.",
  all: "No notes yet. Add one above.",
};

export function Notepad({ notes }: { notes: NotepadItemView[] }): JSX.Element {
  const [filter, setFilter] = React.useState<NoteFilter>("active");
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [editing, setEditing] = React.useState<string | null>(null);

  const shown = notes.filter((n) => (filter === "all" ? true : filter === "done" ? n.done : !n.done));
  const anyDone = notes.some((n) => n.done);
  const canAdd = title.trim().length > 0 || body.trim().length > 0;

  const add = () => {
    if (!canAdd) return;
    send({ type: "notepad:add", title, body });
    setTitle("");
    setBody("");
  };

  return (
    <div className="notepad">
      <div className="np-add">
        <input
          className="np-title-input"
          placeholder="What needs doing?"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          // Enter commits from the title, where a newline means nothing anyway.
          // The body deliberately does not: it is multi-line by design.
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
        />
        <div className="np-body-row">
          <textarea
            className="np-body-input"
            placeholder="Any detail the agent should know (optional)"
            rows={2}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </div>
        <button className="btn np-add-btn" disabled={!canAdd} onClick={add}>Add note</button>
      </div>

      <div className="lenses">
        <div className="lens">
          <div className="seg" role="group" aria-label="Note filter">
            {FILTERS.map((f) => (
              <button key={f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
        </div>
        {anyDone && (
          <button className="np-clear" onClick={() => send({ type: "notepad:clearCompleted" })}>
            Clear completed
          </button>
        )}
      </div>

      {shown.length === 0 ? (
        <div className="np-empty">{EMPTY[filter]}</div>
      ) : (
        <ul className="np-list">
          {[...shown].sort((a, b) => b.createdAt - a.createdAt).map((n) => (
            <NoteRow
              key={n.id}
              note={n}
              editing={editing === n.id}
              onEdit={() => setEditing(n.id)}
              onDone={() => setEditing(null)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function NoteRow({ note, editing, onEdit, onDone }: {
  note: NotepadItemView;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
}): JSX.Element {
  const [title, setTitle] = React.useState(note.title);
  const [body, setBody] = React.useState(note.body);
  // Re-sync when the host sends a changed copy of this note while the row sits
  // open — otherwise Save would write back a value the user never saw.
  React.useEffect(() => { setTitle(note.title); setBody(note.body); }, [note.title, note.body]);

  if (editing) {
    return (
      <li className="np-row editing">
        <input className="np-title-input" value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea className="np-body-input" rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="np-actions">
          <button className="btn" onClick={() => { send({ type: "notepad:update", id: note.id, title, body }); onDone(); }}>
            Save
          </button>
          <button className="np-ghost" onClick={() => { setTitle(note.title); setBody(note.body); onDone(); }}>
            Cancel
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className={`np-row ${note.done ? "is-done" : ""}`}>
      <div className="np-head">
        <input
          type="checkbox"
          checked={note.done}
          aria-label={`Done: ${note.title || "untitled note"}`}
          onChange={() => send({ type: "notepad:toggleDone", id: note.id })}
        />
        <span className="np-title">{note.title}</span>
        {note.runStatus && (
          <span className={`np-status st-${note.runStatus}`}>{STATUS_LABEL[note.runStatus]}</span>
        )}
      </div>
      {note.body && <div className="np-body">{note.body}</div>}
      <div className="np-actions">
        <button className="np-ghost" onClick={() => send({ type: "notepad:run", id: note.id })}>Run agent</button>
        <button className="np-ghost" aria-label="Edit note" onClick={onEdit}>Edit</button>
        <button className="np-ghost danger" aria-label="Delete note" onClick={() => send({ type: "notepad:delete", id: note.id })}>
          Delete
        </button>
      </div>
    </li>
  );
}
```

- [ ] **Step 4: Run the component tests**

Run: `npx vitest run test/webview/Notepad.test.tsx`
Expected: PASS (12 tests). If `toBeDisabled`/`toHaveAttribute` are unavailable, the repo does not load `@testing-library/jest-dom` — check `test/_setup.ts` and either use the matchers the repo already uses (e.g. `expect((btn as HTMLButtonElement).disabled).toBe(true)`) or follow whatever `App.test.tsx` does.

- [ ] **Step 5: Wire the tab bar into `App.tsx`**

Add the import beside the others (line ~10):

```tsx
import { Notepad } from "./Notepad";
```

Add `NotepadItemView` to the existing `../types` import on line 8.

Add state beside the other `useState` calls (near line 161):

```tsx
  // Which of the panel's two views is showing. Not persisted: the panel always
  // opens on Tasks, which is what the sidebar is primarily for.
  const [tab, setTab] = React.useState<"tasks" | "notepad">("tasks");
  const [notes, setNotes] = React.useState<NotepadItemView[]>([]);
```

Add the message case in the handler, beside `case "loading"` (near line 296):

```tsx
        case "notepad:notes":
          setNotes(m.notes);
          break;
```

Render the tab bar. In the returned JSX, immediately after the closing `</div>` of `className="header"` (around line 493) and **before** `<div className="lenses">`, insert:

```tsx
      <div className="tabbar" role="tablist" aria-label="Panel view">
        <button role="tab" aria-selected={tab === "tasks"} onClick={() => setTab("tasks")}>Tasks</button>
        <button role="tab" aria-selected={tab === "notepad"} onClick={() => setTab("notepad")}>Notepad</button>
      </div>

      {tab === "notepad" && <Notepad notes={notes} />}
```

Then gate the existing task UI on the tasks tab. The cleanest way that touches the least code: wrap everything from `<div className="lenses">` through the end of the task list in a fragment guarded by `tab === "tasks"`. Read the render body first and place the guard so that **all** task-pool UI (lenses, repo select, batch bar, task list, empty states) is inside it — but leave the toast container outside, since a toast from a notepad action must still appear while the Notepad tab is showing.

- [ ] **Step 6: Add the styles**

In `src/webview/styles.ts`, append to the stylesheet. Match the file's existing conventions — read it first and reuse its VS Code theme variables (`--vscode-*`) rather than literal colors. Per the project's webview conventions: red is reserved for real failures, and monospace only for identifiers.

```css
.tabbar { display: flex; gap: 2px; margin: 8px 0 4px; border-bottom: 1px solid var(--vscode-panel-border); }
.tabbar button { background: none; border: none; border-bottom: 2px solid transparent;
  padding: 6px 10px; cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 12px; }
.tabbar button[aria-selected="true"] { color: var(--vscode-foreground);
  border-bottom-color: var(--vscode-focusBorder); }

.notepad { padding: 4px 0 12px; }
.np-add { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
.np-title-input, .np-body-input { width: 100%; box-sizing: border-box; padding: 5px 7px;
  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; font-family: inherit; }
.np-body-row { display: flex; gap: 6px; align-items: flex-start; }
.np-body-row .np-body-input { flex: 1; resize: vertical; }
.np-add-btn { align-self: flex-start; }
.np-clear { background: none; border: none; cursor: pointer; font-size: 11px;
  color: var(--vscode-descriptionForeground); text-decoration: underline; }
.np-empty { padding: 14px 2px; color: var(--vscode-descriptionForeground); font-size: 12px; }
.np-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.np-row { padding: 7px 8px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
.np-row.is-done .np-title { text-decoration: line-through; opacity: 0.6; }
.np-head { display: flex; align-items: center; gap: 7px; }
.np-title { flex: 1; }
.np-body { margin: 4px 0 0 24px; font-size: 12px; color: var(--vscode-descriptionForeground);
  white-space: pre-wrap; }
.np-actions { display: flex; gap: 8px; margin-top: 6px; }
.np-ghost { background: none; border: none; cursor: pointer; padding: 0; font-size: 11px;
  color: var(--vscode-textLink-foreground); }
.np-ghost.danger { color: var(--vscode-descriptionForeground); }
.np-status { font-size: 10px; padding: 1px 6px; border-radius: 8px;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.np-status.st-running { background: var(--vscode-charts-green); color: var(--vscode-editor-background); }
.np-status.st-stale { background: var(--vscode-charts-yellow); color: var(--vscode-editor-background); }
```

`st-finished` deliberately inherits the neutral badge default — a landed run is not a state that needs a color to shout about.

- [ ] **Step 7: Run everything**

Run: `npm test && npm run typecheck && npm run build`
Expected: all PASS. If `App.test.tsx` breaks because the tab bar shifted the DOM, fix those tests — the new structure is intended, and their assertions should be updated to match, not worked around.

- [ ] **Step 8: Commit**

```bash
git add src/webview/Notepad.tsx src/webview/App.tsx src/webview/styles.ts test/webview/Notepad.test.tsx test/webview/App.test.tsx
git commit -m "feat(notepad): add the Notepad tab, note list, and Active-by-default filter"
```

---

### Task 6: Kick off an agent from a note

`notepad:run` — reuses the `explore()` kickoff tail and records `lastRunKey` on the note so Task 5's badge has something to show.

**Files:**
- Modify: `src/tasksView.ts` (new `runNotepadItem` near `explore()` line 756; the `notepad:run` case; `MESSAGE_OPS` line 45)
- Test: `test/unit/tasksView.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-4
- Produces: `TasksViewProvider.runNotepadItem(id: string): Promise<void>`; runs on disk with `kind: "notepad"` and key `notepad-<slug>`

- [ ] **Step 1: Write the failing tests**

Add inside the `describe("notepad", ...)` block from Task 4. First read how the existing `explore` tests in this file set up `getConfig`, `discoverRepos`, `showQuickPick`, and `openWorkspace` — reuse that exact setup rather than a new one, since `runNotepadItem` walks the same picker path.

```ts
it("launches a run keyed off the note title and records it on the note", async () => {
  const { store, sendMsg } = mkProvider();
  // …arrange exactly as the explore() tests do: getConfig, discoverRepos returning
  // one repo, showQuickPick resolving the repo pick and destination…
  await sendMsg({ type: "notepad:add", title: "Fix the retry banner", body: "it double-fires" });
  const id = notesIn(store)![0].id;
  await sendMsg({ type: "notepad:run", id });

  const call = vi.mocked(openWorkspace).mock.calls.at(-1)![0];
  expect(call.kind).toBe("notepad");
  expect(call.ticket.key).toBe("notepad-fix-the-retry-banner");
  expect(call.ticket.url).toBe("");
  expect(call.planMd).toContain("it double-fires");
  expect((notesIn(store)![0] as { lastRunKey?: string }).lastRunKey).toBe("notepad-fix-the-retry-banner");
});

it("falls back to a generic key when the note has no title", async () => {
  const { store, sendMsg } = mkProvider();
  await sendMsg({ type: "notepad:add", title: "", body: "just a body" });
  const id = notesIn(store)![0].id;
  await sendMsg({ type: "notepad:run", id });
  expect(vi.mocked(openWorkspace).mock.calls.at(-1)![0].ticket.key).toBe("notepad-note");
});

it("does nothing for an id that is not in the list", async () => {
  const { sendMsg } = mkProvider();
  vi.mocked(openWorkspace).mockClear();
  await sendMsg({ type: "notepad:run", id: "ghost" });
  expect(openWorkspace).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/tasksView.test.ts -t "notepad"`
Expected: FAIL — `notepad:run` is unhandled, `openWorkspace` never called.

- [ ] **Step 3: Write the implementation**

Add to `src/tasksView.ts`, immediately after `explore()` (line ~875):

```ts
  /** Launch an agent for one notepad item. Same shape as explore(): pick repos and
   * a destination, open a workspace, seed a brief — the note supplies the topic and
   * the brief body, so there is no input box to show. The run is written with
   * `kind: "notepad"` into the same store the Deck reads, which is the whole of the
   * Deck integration: the board gains a second origin, not a second data path. */
  public async runNotepadItem(id: string): Promise<void> {
    const note = this.notes().find((n) => n.id === id);
    if (!note) {
      this.toast("error", "That note is gone — the list has moved on.");
      return;
    }
    const cfg = getConfig();
    const repos = discoverRepos(cfg.reposRoot, cfg.repoBlocklist);
    if (repos.length === 0) {
      this.toast("error", `No repos found under ${cfg.reposRoot}. Check agentFlow.reposRoot.`);
      return;
    }

    const target = await this.chooseOpenTarget(cfg);
    if (!target) return;

    let services: ServiceRef[];
    if (target.kind === "existing" || target.kind === "live-folder") {
      services = this.servicesFromExistingDestination(target, repos);
      if (services.length === 0) {
        this.toast("error", "That workspace has no repos to open.");
        return;
      }
    } else {
      const picks = await vscode.window.showQuickPick<vscode.QuickPickItem & { repo: ServiceRef }>(
        repos.map((r) => ({
          label: r.name,
          detail: r.isGit ? r.path : `${r.path}  (not a git repo)`,
          repo: r,
        })),
        {
          canPickMany: true,
          title: "Notepad — pick the repos to open",
          placeHolder: "Space to toggle · Enter to open",
          ignoreFocusOut: true,
        },
      );
      if (!picks || picks.length === 0) return;
      services = picks.map((p) => p.repo);
    }

    const args = await this.targetToOpenArgs(target, services.length, "Notepad", cfg);
    if (!args) return;

    const wantRemoteControl = await this.resolveRemoteControl(cfg);

    const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    const topic = note.title.trim() || "Notepad item";
    const key = `notepad-${slugify(topic) || "note"}`;
    const planMd =
      `## Notepad: ${topic}\n\n_No ticket — an item you wrote in the Agent Flow notepad. ` +
      `If it turns into tracked work, open a ticket afterwards._` +
      (note.body.trim() ? `\n\n${note.body.trim()}` : "");

    const result = await openWorkspace({
      ticket: { key, summary: topic, url: "" },
      planMd,
      descriptionText: note.body,
      services,
      mode: args.mode,
      promptTemplate: applyExploreVars(injectSlackDm(cfg.exploreActions[0]?.prompt ?? "", false), {
        env: undefined,
        services: services.map((s) => s.name).join(", "),
      }),
      workspaceDir: cfg.workspaceDir,
      seedAgent: cfg.seedAgent,
      openIn: args.openIn,
      existingWorkspaceFile: args.existingWorkspaceFile,
      existingFolder: args.existingFolder,
      remoteControl: wantRemoteControl,
      kind: "notepad",
    });

    // Point the note at its run so the badge has something to derive from. Written
    // after the launch, not before: a cancelled picker must leave no pointer to a
    // run that was never created.
    await this.saveNotes(this.notes().map((n) => (n.id === id ? { ...n, lastRunKey: key } : n)));

    const where = result.workspaceFile
      ? `workspace ${result.workspaceFile.split("/").pop()}`
      : `${result.opened.length} window(s)`;
    const seeded = this.seededNote(cfg.seedAgent, result.remoteControl);
    const rcNote = this.remoteControlNote(wantRemoteControl, result.remoteControl);
    this.toast("success", `Opened ${where} for “${topic}”. Brief seeded in each repo.${seeded}${rcNote}`);
  }
```

**Verify the prompt-template line before trusting it.** `explore()` picks a template from a chosen `ExploreAction`; a notepad run has no action to choose. Read `src/config.ts`'s `EXPLORE_ACTION_DEFS` and pick the **generic** action's prompt by its `id` (likely `"general"` — confirm), not `exploreActions[0]`, which is order-dependent and will silently drift:

```ts
const generic = cfg.exploreActions.find((a) => a.id === "general");
// …then use `generic?.prompt ?? ""` and `generic?.slackDm ?? false` above.
```

Add the message case beside the others:

```ts
        case "notepad:run": {
          await this.runNotepadItem(m.id);
          break;
        }
```

And add to `MESSAGE_OPS` (line ~45), beside `explore: "workspace_write"`:

```ts
  "notepad:run": "workspace_write",
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/tasksView.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tasksView.ts test/unit/tasksView.test.ts
git commit -m "feat(notepad): kick off an agent from a note as a notepad-kind run"
```

---

### Task 7: Speech-to-text dictation

The mic button's behavior. Isolated deliberately: it is the one piece that depends on a browser API `jsdom` does not implement, so its tests inject a fake.

**Files:**
- Modify: `src/webview/Notepad.tsx` (the `np-body-row`)
- Modify: `src/webview/styles.ts`
- Test: `test/webview/Notepad.test.tsx`

**Interfaces:**
- Consumes: `Notepad` from Task 5
- Produces: no new exports — the mic is internal to `Notepad.tsx`

- [ ] **Step 1: Write the failing tests**

Add to `test/webview/Notepad.test.tsx`:

```tsx
describe("Notepad dictation", () => {
  // A stand-in for the browser's SpeechRecognition: jsdom implements neither the
  // constructor nor the events, so the component is driven through this fake.
  class FakeRecognition {
    static last: FakeRecognition | null = null;
    continuous = false;
    interimResults = false;
    lang = "";
    started = false;
    onresult: ((e: unknown) => void) | null = null;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { FakeRecognition.last = this; }
    start() { this.started = true; }
    stop() { this.started = false; this.onend?.(); }
  }

  beforeEach(() => {
    FakeRecognition.last = null;
    (window as unknown as Record<string, unknown>).SpeechRecognition = FakeRecognition;
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).SpeechRecognition;
    delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
  });

  it("hides the mic when the browser has no SpeechRecognition at all", () => {
    delete (window as unknown as Record<string, unknown>).SpeechRecognition;
    render(<Notepad notes={[]} />);
    expect(screen.queryByRole("button", { name: /Dictate/ })).toBeNull();
  });

  it("appends a final transcript into the body", () => {
    render(<Notepad notes={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Dictate the note body" }));
    FakeRecognition.last!.onresult!({
      resultIndex: 0,
      results: [Object.assign([{ transcript: "check the retry path" }], { isFinal: true })],
    });
    expect((screen.getByPlaceholderText("Any detail the agent should know (optional)") as HTMLTextAreaElement).value)
      .toContain("check the retry path");
  });

  it("stops listening on a second click", () => {
    render(<Notepad notes={[]} />);
    const mic = screen.getByRole("button", { name: "Dictate the note body" });
    fireEvent.click(mic);
    expect(FakeRecognition.last!.started).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Stop dictating" }));
    expect(FakeRecognition.last!.started).toBe(false);
  });

  it("recovers its idle label when recognition errors out", () => {
    render(<Notepad notes={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Dictate the note body" }));
    FakeRecognition.last!.onerror!();
    FakeRecognition.last!.onend!();
    expect(screen.getByRole("button", { name: "Dictate the note body" })).toBeTruthy();
  });
});
```

Add `afterEach` to the vitest import at the top of the file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/webview/Notepad.test.tsx -t "dictation"`
Expected: FAIL — no mic button exists.

- [ ] **Step 3: Write the implementation**

In `src/webview/Notepad.tsx`, add above the `Notepad` component:

```tsx
// The Web Speech API, as the two engines that ship it actually expose it. Typed
// here rather than pulled from `lib.dom` because TypeScript's DOM lib does not
// declare SpeechRecognition at all — it is not a standard, only widely shipped.
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((e: SpeechResultLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}
interface SpeechResultLike {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}

function speechCtor(): (new () => SpeechRecognitionLike) | undefined {
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition) as (new () => SpeechRecognitionLike) | undefined;
}

/** Dictation into a text field. Returns undefined when the engine has no speech
 * recognition — the caller renders no mic at all rather than a button that cannot
 * work. All client-side: no API key, no network call from the extension host, and
 * nothing crosses the message protocol until the note itself is saved. */
function useDictation(append: (text: string) => void): { listening: boolean; toggle: () => void } | undefined {
  const [listening, setListening] = React.useState(false);
  const ref = React.useRef<SpeechRecognitionLike | null>(null);
  const appendRef = React.useRef(append);
  React.useEffect(() => { appendRef.current = append; }, [append]);
  const supported = !!speechCtor();

  // Never leave the microphone open when the view goes away.
  React.useEffect(() => () => ref.current?.stop(), []);

  if (!supported) return undefined;

  const toggle = () => {
    if (ref.current) {
      ref.current.stop();
      ref.current = null;
      setListening(false);
      return;
    }
    const Ctor = speechCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = false; // only settled text lands in the field
    rec.lang = navigator.language || "en-US";
    rec.onresult = (e) => {
      let text = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) text += r[0].transcript;
      }
      if (text.trim()) appendRef.current(text.trim());
    };
    // Both paths land on onend, which is the single place listening is released —
    // an error that did not also end the session would strand the button on "Stop".
    rec.onerror = () => { rec.stop(); };
    rec.onend = () => { ref.current = null; setListening(false); };
    ref.current = rec;
    rec.start();
    setListening(true);
  };

  return { listening, toggle };
}
```

Inside `Notepad`, above the `add` function:

```tsx
  const dictation = useDictation(
    React.useCallback((text: string) => setBody((prev) => (prev ? `${prev} ${text}` : text)), []),
  );
```

And in the `np-body-row`, after the `<textarea>`:

```tsx
          {dictation && (
            <button
              className={`np-mic ${dictation.listening ? "on" : ""}`}
              aria-label={dictation.listening ? "Stop dictating" : "Dictate the note body"}
              title={dictation.listening ? "Stop dictating" : "Dictate the note body"}
              onClick={dictation.toggle}
            >
              {dictation.listening ? "◼" : "🎤"}
            </button>
          )}
```

Add to `src/webview/styles.ts`:

```css
.np-mic { background: none; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: 3px; cursor: pointer; padding: 4px 7px; font-size: 12px; line-height: 1; }
.np-mic.on { border-color: var(--vscode-focusBorder); background: var(--vscode-inputOption-activeBackground); }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/webview/Notepad.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Verify the webview may use the microphone**

The mic needs a real permission grant that no unit test can prove. Build and load the extension, open the Notepad tab, and click the mic:

Run: `npm run build`
Then launch the dev host with **VS Code's** `code` CLI (the Cursor CLI silently drops the flag):

```bash
code --extensionDevelopmentPath=$(pwd) --new-window
```

Expected: clicking the mic prompts for microphone access (or starts listening if already granted), and speech lands in the body field.

If it is **blocked**, the webview's CSP or permission policy is the cause. Fix it in `TasksViewProvider.html()` (`src/tasksView.ts`) — the `<meta http-equiv="Content-Security-Policy">` tag — and nowhere else. Do **not** add a `package.json` capability for this. If it cannot be made to work, stop and report rather than shipping a dead button.

- [ ] **Step 6: Commit**

```bash
git add src/webview/Notepad.tsx src/webview/styles.ts test/webview/Notepad.test.tsx src/tasksView.ts
git commit -m "feat(notepad): dictate note bodies with the Web Speech API"
```

---

### Task 8: Deck labelling, poll refresh, and changelog

The last mile: notepad runs read as notepad runs on the board, badges refresh while the panel sits open, and the change is written down.

**Files:**
- Modify: `src/webview/DeckApp.tsx:213`, `:270`
- Modify: `src/extension.ts` (the notepad poll)
- Modify: `CHANGELOG.md`
- Test: `test/webview/DeckApp.test.tsx`

**Interfaces:**
- Consumes: `runKind` (Task 1), `postNotepad` (Task 4)
- Produces: nothing new

- [ ] **Step 1: Write the failing Deck test**

Add to `test/webview/DeckApp.test.tsx`. Find how the file builds a `RunStatus` fixture (there will be a helper or an inline factory) and reuse it:

```tsx
it("labels a notepad run on the untracked key chip", () => {
  // …render the board with one run: kind "notepad", key "notepad-fix-it", url ""…
  expect(screen.getByText("notepad")).toBeTruthy();
  expect(screen.queryByText("notepad-fix-it")).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/webview/DeckApp.test.tsx -t "notepad"`
Expected: FAIL — the raw key renders instead of the label.

- [ ] **Step 3: Implement the Deck label**

In `src/webview/DeckApp.tsx`, add beside the `explore` const (line ~213):

```tsx
  // Exact, not prefix-matched: unlike `explore` above (whose key prefix is the only
  // signal a Track'd place leaves behind), a notepad run always carries its kind.
  const notepad = runKind(r.run) === "notepad";
```

And extend the untracked chip (line ~270):

```tsx
          <span className="key untracked" title={r.run.key}>
            {local ? "local" : explore ? "explore" : notepad ? "notepad" : r.run.key}
          </span>
```

- [ ] **Step 4: Keep the badges fresh**

The status badge derives from live session state, so it must re-derive without user action. Find where `extension.ts` already refreshes the tasks view (search for `refresh`, `setInterval`, or `onDidChangeWindowState`) and hang the notepad post off the same cadence rather than adding a second timer:

```ts
// Same cadence as the Deck's own poll: a badge that says "running" after the agent
// closed is worse than no badge, and the two directory reads are cheap enough to
// repeat (and are skipped entirely when no note has ever been launched).
setInterval(() => tasksProvider.postNotepad(), 6000);
```

Register the returned handle for disposal the way the file already disposes its other resources (`context.subscriptions.push({ dispose: () => clearInterval(h) })`) — read the file and match. If `extension.ts` has no existing timer, add one, and confirm `test/unit/extension.test.ts` still passes: it may use fake timers.

- [ ] **Step 5: Add the changelog entry**

In `CHANGELOG.md`, under `## [Unreleased]` (create the heading if it is absent, above the newest version heading):

```markdown
### Added
- **Notepad tab.** A second tab in the Tasks panel holding freeform items that
  aren't tied to any ticket, saved globally so the same list follows you across
  every workspace. Notes can be checked off, filtered (Active by default), and
  cleared once done — and dictated, via the microphone button.
- **Kick off an agent from a note.** "Run agent" on a note opens a workspace and
  seeds a brief from it, the same way Explore does. The run appears on the Deck
  board like any other, and the note shows whether it is running, stale, or
  finished.
```

- [ ] **Step 6: Run everything**

Run: `npm test && npm run typecheck && npm run build && npm run test:cov`
Expected: all PASS, coverage thresholds (statements 90 / branches 85 / functions 85 / lines 90) met. If coverage dipped, add the missing tests — do not lower a threshold.

- [ ] **Step 7: Commit**

```bash
git add src/webview/DeckApp.tsx src/extension.ts CHANGELOG.md test/webview/DeckApp.test.tsx test/unit/extension.test.ts
git commit -m "feat(notepad): label notepad runs on the Deck and refresh note status on poll"
```

---

## Manual verification

Automated tests cannot cover the parts that need a real VS Code window. After Task 8, run through this once:

1. `npm run build`, then `code --extensionDevelopmentPath=$(pwd) --new-window` (VS Code's CLI — the Cursor one drops the flag).
2. Open the Agent Flow Deck sidebar. **Tasks** is selected; the task pool looks exactly as it did before.
3. Switch to **Notepad**. Add a note by typing; add another by dictating with the mic.
4. Check one off — it leaves the default Active view. Switch to **Done**: it is there. **Clear completed** removes it and then disappears itself.
5. On a remaining note, click **Run agent**, pick a repo and destination. A window opens with the brief seeded from the note body.
6. The note shows **Running** while the agent's session is open. Open the Deck (`agentFlow.openDeck`): the run is on the board, labelled `notepad`.
7. Close the agent session. Within ~6s the note's badge becomes **Stale**.
8. Open a second VS Code window on a **different repo**. The Notepad shows the same notes — this is the globalState requirement, and it is the one thing no unit test proves.
