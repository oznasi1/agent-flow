# Notepad Bulk Select Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the notepad list a selection — pick several notes, then refile them all into one section, or launch them all as agent sessions in a single window.

**Architecture:** A webview-local Select mode (off by default, so a resting notepad is unchanged) drives two new host messages. `notepad:moveMany` is one storage write. `notepad:runMany` reuses the Tasks tab's shared-window batch engine (`openSharedWorkspace`), one git worktree and one seeded session per note, which needs two small additive changes to that engine first.

**Tech Stack:** TypeScript, React (webview), VS Code extension host, Vitest + @testing-library/react, esbuild.

**Spec:** `docs/superpowers/specs/2026-08-14-notepad-bulk-design.md` — read it before Task 1; it carries the rationale this plan only summarizes.

## Before you start: this work needs its own worktree

At the time of writing, the root checkout sits on `main` at `9d9f98c` (release 0.20.0) **with a large uncommitted feature staged in it** — notepad images: `src/notepadImages.ts`, plus edits to `src/webview/Notepad.tsx` (+231), `src/webview/styles.ts`, `src/types.ts`, `src/tasksView.ts`, `test/webview/Notepad.test.tsx` (+177), `test/unit/tasksView.test.ts` (+254), `src/engine/workspace.ts`. Parallel sessions share this checkout and switch its branch.

Consequences, all load-bearing:

- **Create a fresh git worktree off `main`** and work only there, with absolute paths. Do not build on the root checkout's dirty tree — you would commit another session's unfinished feature.
- **Every file this plan touches except `src/engine/batchWorkspace.ts` is also edited by that in-flight work.** Expect to rebase Tasks 5 and 6 once notepad images lands. If it has already landed when you start, re-read `Notepad.tsx` and `Notepad.test.tsx` before pasting any snippet from this plan — the surrounding code will have moved.
- **Locate code by symbol, not by line number.** This plan names functions (`agentPrompt`, `runNotepadItem`, `takeBatch`, `setNoteSection`); grep for those. Any line number in this document is already stale.
- `agentPrompt`'s own body is untouched by the in-flight work, so Task 2 applies as written.

## Global Constraints

- **Never break existing users.** Every existing test must pass **unmodified**. If a change forces an existing test edit, stop and report — that is a signal the change is wrong, not that the test is.
- **Select mode off is byte-identical to today's notepad.** No new DOM, no new controls, no changed labels when `selectMode === false`.
- **Gates, all four, before any task is called done:** `npm run typecheck`, `npm test`, `npm run test:cov` (coverage thresholds enforced), `npm run build`. The build gate is load-bearing: `src/webview/**` must not import `fs`/`os`/`path`/`child_process`, even transitively, and only the bundle catches it — `tsc` and the full test suite both pass regardless.
- **Test honesty.** After a test goes green, break the implementation line it covers (invert a condition, drop a field) and confirm the test fails. A test that passes against broken code is a defect being committed, not coverage. Revert the break.
- **`vscode` is mocked** at `test/_mocks/vscode.ts`; `test/_setup.ts` resets those mocks before every test.
- **Copy rules:** user-facing strings are sentence case, no emoji. Red is for real failures only. Mono type is for identifiers only.
- **Commit per task**, conventional-commit prefixes (`feat:`, `fix:`, `refactor:`, `test:`).

---

### Task 1: `kind` passthrough in the shared-window engine

Without this, every run a notepad batch writes lands as `kind: "task"`, and the Deck hunts pull requests for it on whatever branch the worktree was cut from — attributing a stranger's PR to a note. `Run["kind"]` already includes `"notepad"`; only the batch path drops it.

**Files:**
- Modify: `src/engine/batchWorkspace.ts` (`SharedOpenRequest`, and the `Run` literal inside the `tasks.forEach` that calls `writeRun`)
- Test: `test/unit/engine/batchWorkspace.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `SharedOpenRequest.kind?: Run["kind"]` — Task 4 passes `"notepad"`.

- [ ] **Step 1: Write the failing tests**

Add inside the existing `describe("openSharedWorkspace", …)` block in `test/unit/engine/batchWorkspace.test.ts`. `baseReq` and `writes` are helpers already defined at the top of that file:

```ts
it("stamps every run record with the caller's kind", async () => {
  await openSharedWorkspace(baseReq({ kind: "notepad" }));
  const runs = writes((p) => p.includes("/runs/")).map((c) => JSON.parse(String(c[1])));
  expect(runs).toHaveLength(2);
  expect(runs.every((r) => r.kind === "notepad")).toBe(true);
});

it("leaves the kind field off when the caller names none, as a task batch does", async () => {
  await openSharedWorkspace(baseReq());
  const runs = writes((p) => p.includes("/runs/")).map((c) => JSON.parse(String(c[1])));
  expect(runs).toHaveLength(2);
  expect(runs.every((r) => r.kind === undefined)).toBe(true);
});
```

- [ ] **Step 2: Run them and watch the first fail**

```bash
npx vitest run test/unit/engine/batchWorkspace.test.ts -t "kind"
```

Expected: the first test FAILS (`r.kind` is `undefined`, not `"notepad"`); the second PASSES already.

- [ ] **Step 3: Implement**

In `src/engine/batchWorkspace.ts`, add the field to `SharedOpenRequest` (after `foldersToAdd`):

```ts
  /** What launched this batch — written onto every Run record. Omitted means a task,
   *  which is what `runKind()` reads a missing field as, so a task batch is unchanged.
   *  A notepad batch MUST pass "notepad": the Deck treats notepad runs as structurally
   *  PR-less, because a note launches onto a branch whose pull request is somebody
   *  else's work. */
  kind?: Run["kind"];
```

In the `tasks.forEach` that builds each `Run`, add one line beside `key`:

```ts
      kind: req.kind,
```

- [ ] **Step 4: Run the file's whole suite**

```bash
npx vitest run test/unit/engine/batchWorkspace.test.ts
```

Expected: PASS, including every pre-existing case.

- [ ] **Step 5: Mutation-check**

Temporarily change `kind: req.kind` to `kind: undefined`; re-run; the first new test must fail. Restore it.

- [ ] **Step 6: Gates and commit**

```bash
npm run typecheck && npm test && npm run build
git add src/engine/batchWorkspace.ts test/unit/engine/batchWorkspace.test.ts
git commit -m "feat(engine): let a shared-window batch stamp its run kind"
```

---

### Task 2: per-task prompt suffix in the shared-window engine

The single-note path feeds the note's body to the agent as `promptSuffix` (`tasksView.ts` ~line 1232) because the generic template carries only `{summary}`: without it, the detail the user typed reaches the agent only if the agent opens `TASK.md` first, which a freshly seeded session is least likely to do. `agentPrompt` has no suffix parameter, so the shared path cannot do this at all.

**Files:**
- Modify: `src/engine/workspace.ts` (`agentPrompt`)
- Modify: `src/engine/batchWorkspace.ts` (`BatchTask`, and the one `agentPrompt` call, inside the `if (seedAgent)` block)
- Test: `test/unit/engine/workspace.test.ts` (the existing `describe("agentPrompt", …)`)
- Test: `test/unit/engine/batchWorkspace.test.ts`

**Interfaces:**
- Consumes: `SharedOpenRequest.kind` from Task 1 (same file; no code dependency).
- Produces: `agentPrompt(t, mentions, template, briefPath?, suffix?)` and `BatchTask.promptSuffix?: string` — Task 4 sets the latter per note.

- [ ] **Step 1: Write the failing `agentPrompt` tests**

In `test/unit/engine/workspace.test.ts`, inside `describe("agentPrompt", …)`. That block already has a `ticket` fixture in scope:

```ts
it("appends a suffix after the rendered template, blank-line separated", () => {
  expect(agentPrompt(ticket, [], "go {summary}", undefined, "Details from the note:\n\nit double-fires"))
    .toBe(`go ${ticket.summary}\n\nDetails from the note:\n\nit double-fires`);
});

it("renders identically to the no-suffix call when the suffix is empty or whitespace", () => {
  const plain = agentPrompt(ticket, [], "go {summary}");
  expect(agentPrompt(ticket, [], "go {summary}", undefined, "")).toBe(plain);
  expect(agentPrompt(ticket, [], "go {summary}", undefined, "   \n ")).toBe(plain);
});

it("never interpolates the suffix — a placeholder inside the user's own words stays literal", () => {
  expect(agentPrompt(ticket, [], "go", undefined, "look at {summary} and {brief}"))
    .toBe("go\n\nlook at {summary} and {brief}");
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
npx vitest run test/unit/engine/workspace.test.ts -t "agentPrompt"
```

Expected: the three new cases FAIL (extra argument ignored, no suffix in output).

- [ ] **Step 3: Implement `agentPrompt`**

Replace the body in `src/engine/workspace.ts`:

```ts
/** `suffix` is appended AFTER rendering, never interpolated into the template — the
 *  user's own words (a note's body, say) must never be read as placeholders. Same
 *  trimming rule as OpenRequest.promptSuffix, so both paths render alike. */
export function agentPrompt(t: TicketRef, mentions: string[], template: string, briefPath?: string, suffix?: string): string {
  const rendered = renderPrompt(
    template,
    { key: t.key, summary: t.summary, url: t.url, brief: briefPath ?? `${BRIEF_DIR}/${BRIEF_FILE}` },
    mentions,
  );
  return suffix?.trim() ? `${rendered}\n\n${suffix.trim()}` : rendered;
}
```

- [ ] **Step 4: Run and confirm green**

```bash
npx vitest run test/unit/engine/workspace.test.ts
```

Expected: PASS, every pre-existing `agentPrompt` case included.

- [ ] **Step 5: Write the failing batch test**

In `test/unit/engine/batchWorkspace.test.ts`:

```ts
it("carries each task's own prompt suffix into that task's seeded plan", async () => {
  const req = baseReq();
  req.tasks[0].promptSuffix = "Details from the note:\n\nfirst detail";
  await openSharedWorkspace(req);
  const plans = writes((p) => p.includes("plans") && p.endsWith(".json"))
    .map((c) => JSON.parse(String(c[1])));
  const promptFor = (key: string) => plans.find((p) => p.key === key)!.matches[0].prompt;
  expect(promptFor("PROJ-1")).toContain("Details from the note:\n\nfirst detail");
  expect(promptFor("PROJ-2")).not.toContain("Details from the note");
});
```

- [ ] **Step 6: Run and watch it fail**

```bash
npx vitest run test/unit/engine/batchWorkspace.test.ts -t "prompt suffix"
```

Expected: FAIL — the suffix appears in neither prompt.

- [ ] **Step 7: Implement the batch side**

Add to `BatchTask` in `src/engine/batchWorkspace.ts`:

```ts
  /** Appended verbatim after the rendered template for THIS task's session only.
   *  A notepad batch puts the note's body here: the generic template carries only
   *  {summary}, so without it the detail reaches the agent only via TASK.md. */
  promptSuffix?: string;
```

and thread it through the existing call:

```ts
      const prompt = agentPrompt(t.ticket, mentions, promptTemplate, briefPathFor.get(t.ticket.key), t.promptSuffix);
```

- [ ] **Step 8: Run both engine suites**

```bash
npx vitest run test/unit/engine/batchWorkspace.test.ts test/unit/engine/workspace.test.ts
```

Expected: PASS.

- [ ] **Step 9: Mutation-check**

Drop `t.promptSuffix` from the `agentPrompt` call; the batch test must fail. Restore.

- [ ] **Step 10: Gates and commit**

```bash
npm run typecheck && npm test && npm run build
git add src/engine/workspace.ts src/engine/batchWorkspace.ts test/unit/engine/workspace.test.ts test/unit/engine/batchWorkspace.test.ts
git commit -m "feat(engine): give each task in a shared batch its own prompt suffix"
```

---

### Task 3: `notepad:moveMany` — refile a selection in one write

**Files:**
- Modify: `src/types.ts` (`InboundMessage` union, beside the other `notepad:*` entries)
- Modify: `src/tasksView.ts` (the `onMessage` switch, beside `case "notepad:setSection"`)
- Test: `test/unit/tasksView.test.ts` (inside the notepad `describe` that owns the `mkProvider` and `notesIn` helpers)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the message `{ type: "notepad:moveMany"; ids: string[]; sectionId?: string }` — Task 6's popover sends it.

- [ ] **Step 1: Write the failing tests**

```ts
it("refiles every named note in one storage write", async () => {
  const { store, sendMsg, posted } = mkProvider();
  await sendMsg({ type: "notepad:addSection", name: "Shipping" });
  await sendMsg({ type: "notepad:add", title: "a", body: "" });
  await sendMsg({ type: "notepad:add", title: "b", body: "" });
  await sendMsg({ type: "notepad:add", title: "c", body: "" });
  const byTitle = (t: string) => notesIn(store)!.find((n) => n.title === t)!.id;
  const sectionId = (store.get("agentFlow.notepadSections") as { id: string }[])[0].id;
  const postsBefore = posted.length;

  await sendMsg({ type: "notepad:moveMany", ids: [byTitle("a"), byTitle("c")], sectionId });

  const filed = notesIn(store)! as unknown as { title: string; sectionId?: string }[];
  expect(filed.find((n) => n.title === "a")!.sectionId).toBe(sectionId);
  expect(filed.find((n) => n.title === "c")!.sectionId).toBe(sectionId);
  expect(filed.find((n) => n.title === "b")!.sectionId).toBeUndefined();
  // One post, not one per note: a per-note loop would re-render the list three times.
  expect(posted.length - postsBefore).toBe(1);
});

it("moves a selection back to ungrouped when no section is named", async () => {
  const { store, sendMsg } = mkProvider();
  await sendMsg({ type: "notepad:addSection", name: "Shipping" });
  await sendMsg({ type: "notepad:add", title: "a", body: "" });
  const id = notesIn(store)![0].id;
  const sectionId = (store.get("agentFlow.notepadSections") as { id: string }[])[0].id;
  await sendMsg({ type: "notepad:moveMany", ids: [id], sectionId });
  await sendMsg({ type: "notepad:moveMany", ids: [id] });
  expect((notesIn(store)![0] as { sectionId?: string }).sectionId).toBeUndefined();
});

it("ignores ids it does not know and still files the ones it does", async () => {
  const { store, sendMsg } = mkProvider();
  await sendMsg({ type: "notepad:addSection", name: "Shipping" });
  await sendMsg({ type: "notepad:add", title: "a", body: "" });
  const id = notesIn(store)![0].id;
  const sectionId = (store.get("agentFlow.notepadSections") as { id: string }[])[0].id;
  await sendMsg({ type: "notepad:moveMany", ids: [id, "ghost"], sectionId });
  expect(notesIn(store)!).toHaveLength(1);
  expect((notesIn(store)![0] as { sectionId?: string }).sectionId).toBe(sectionId);
});
```

The sections storage key is `agentFlow.notepadSections` (`NOTEPAD_SECTIONS_KEY` in `src/tasksView.ts`), and notes live under `agentFlow.notepad` (`NOTEPAD_KEY`). Use those; add no new key.

- [ ] **Step 2: Run and watch them fail**

```bash
npx vitest run test/unit/tasksView.test.ts -t "moveMany"
```

Expected: FAIL — TypeScript rejects the message type, or nothing is refiled.

- [ ] **Step 3: Add the message type**

In `src/types.ts`, beside `notepad:setSection`:

```ts
  | { type: "notepad:moveMany"; ids: string[]; sectionId?: string }
```

- [ ] **Step 4: Handle it**

In `src/tasksView.ts`'s `onMessage` switch, after `case "notepad:setSection"`:

```ts
        case "notepad:moveMany": {
          await this.moveNotesToSection(m.ids, m.sectionId);
          break;
        }
```

and beside `setNoteSection`, the method:

```ts
  /** Refile a whole selection in ONE pass. Not a loop over setNoteSection: that would
   * be N storage writes and N posts, and a half-applied move would leave no single
   * state to reason about. Unknown ids are inert — a webview naming a note another
   * window has since deleted must not throw. */
  private async moveNotesToSection(ids: string[], sectionId?: string): Promise<void> {
    const wanted = new Set(ids);
    const notes = this.notes();
    if (!notes.some((n) => wanted.has(n.id))) return;
    await this.saveNotes(notes.map((n) => (wanted.has(n.id) ? { ...n, sectionId } : n)));
  }
```

No `postNotepad()` call here on purpose: `saveNotes` already posts after it updates `globalState`. Adding one would post twice and fail the "one post" assertion.

- [ ] **Step 5: Run and confirm green**

```bash
npx vitest run test/unit/tasksView.test.ts -t "moveMany"
npx vitest run test/unit/tasksView.test.ts
```

Expected: PASS both.

- [ ] **Step 6: Mutation-check**

Change `{ ...n, sectionId }` to `{ ...n }`; the first test must fail. Restore.

- [ ] **Step 7: Gates and commit**

```bash
npm run typecheck && npm test && npm run build
git add src/types.ts src/tasksView.ts test/unit/tasksView.test.ts
git commit -m "feat(notepad): refile a selection of notes in one write"
```

---

### Task 4: `notepad:runMany` — one window, a session and a worktree per note

**Files:**
- Modify: `src/types.ts` (`InboundMessage`)
- Modify: `src/tasksView.ts` (`MESSAGE_OPS`, the `onMessage` switch, and a new public `runNotepadBatch` beside `runNotepadItem`)
- Test: `test/unit/tasksView.test.ts`

**Interfaces:**
- Consumes: `SharedOpenRequest.kind` (Task 1), `BatchTask.promptSuffix` (Task 2).
- Produces: the message `{ type: "notepad:runMany"; ids: string[] }` and `public async runNotepadBatch(ids: string[]): Promise<void>` — Task 5's bar sends the message.

**Read first:** `takeBatch` in `src/tasksView.ts` for the shape being mirrored, and `runNotepadItem` in the same file for the note-specific parts (key derivation, the generic explore action, `lastRunKey`).

- [ ] **Step 1: Write the failing tests**

Add a `describe("notepad:runMany", …)` inside the notepad block that owns `mkProvider`. Mirror the `takeBatch` describe's `beforeEach`/`afterEach` for `createWorktrees` — without the non-identity implementation, every note trips the worktree-collision guard:

```ts
describe("notepad:runMany", () => {
  beforeEach(() => {
    vi.mocked(createWorktrees).mockImplementation((s, key) =>
      s.map((r) => ({ ...r, path: `${r.path}/.claude/worktrees/${key}` })),
    );
  });
  afterEach(() => {
    vi.mocked(createWorktrees).mockImplementation((s) => s);
  });

  /** Two notes, plus the ids in list order. */
  async function twoNotes() {
    const h = mkProvider();
    await h.sendMsg({ type: "notepad:add", title: "First note", body: "first detail" });
    await h.sendMsg({ type: "notepad:add", title: "Second note", body: "" });
    return { ...h, ids: notesIn(h.store)!.map((n) => n.id) };
  }

  it("opens ONE shared window holding a worktree'd task per note", async () => {
    const repos = mkRepos(["api"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never); // repo picker
    const { sendMsg, ids } = await twoNotes();

    await sendMsg({ type: "notepad:runMany", ids });

    expect(openSharedWorkspace).toHaveBeenCalledTimes(1);
    expect(openWorkspace).not.toHaveBeenCalled();
    const req = vi.mocked(openSharedWorkspace).mock.calls.at(-1)![0];
    expect(req.tasks).toHaveLength(2);
    expect(req.kind).toBe("notepad");
    expect(createWorktrees).toHaveBeenCalledTimes(2);
  });

  it("keys each task off its own note, so two notes never share a run record", async () => {
    const repos = mkRepos(["api"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { sendMsg, ids } = await twoNotes();
    await sendMsg({ type: "notepad:runMany", ids });
    const keys = vi.mocked(openSharedWorkspace).mock.calls.at(-1)![0].tasks.map((t) => t.ticket.key);
    expect(new Set(keys).size).toBe(2);
    for (const id of ids) expect(keys.some((k) => k.endsWith(id))).toBe(true);
  });

  it("carries each note's own detail as that task's prompt suffix, and none for an empty body", async () => {
    const repos = mkRepos(["api"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { sendMsg, ids } = await twoNotes();
    await sendMsg({ type: "notepad:runMany", ids });
    const tasks = vi.mocked(openSharedWorkspace).mock.calls.at(-1)![0].tasks;
    expect(tasks[0].promptSuffix).toBe("Details from the note:\n\nfirst detail");
    expect(tasks[1].promptSuffix).toBeUndefined();
  });

  it("points every launched note at its own run", async () => {
    const repos = mkRepos(["api"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { sendMsg, store, ids } = await twoNotes();
    await sendMsg({ type: "notepad:runMany", ids });
    const keys = vi.mocked(openSharedWorkspace).mock.calls.at(-1)![0].tasks.map((t) => t.ticket.key);
    const saved = notesIn(store)! as unknown as { id: string; lastRunKey?: string }[];
    for (const id of ids) expect(keys).toContain(saved.find((n) => n.id === id)!.lastRunKey);
  });

  it("opens nothing and writes no run pointer when the repo picker is cancelled", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined); // repo picker cancelled
    const { sendMsg, store, ids } = await twoNotes();
    await sendMsg({ type: "notepad:runMany", ids });
    expect(openSharedWorkspace).not.toHaveBeenCalled();
    expect(createWorktrees).not.toHaveBeenCalled();
    const saved = notesIn(store)! as unknown as { lastRunKey?: string }[];
    expect(saved.every((n) => n.lastRunKey === undefined)).toBe(true);
  });

  it("opens nothing when the over-threshold confirmation is declined", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, batchLaunchConfirmThreshold: 1 });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(window.showWarningMessage).mockResolvedValueOnce(undefined as never);
    const { sendMsg, ids } = await twoNotes();
    await sendMsg({ type: "notepad:runMany", ids });
    expect(window.showWarningMessage).toHaveBeenCalled();
    expect(openSharedWorkspace).not.toHaveBeenCalled();
  });

  it("fails only the note whose worktree fell back to the main checkout", async () => {
    const repos = mkRepos(["api"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { sendMsg, posted, ids } = await twoNotes();
    let call = 0;
    vi.mocked(createWorktrees).mockImplementation((s, key) =>
      // First note's worktree fails (path unchanged), second succeeds.
      ++call === 1 ? s : s.map((r) => ({ ...r, path: `${r.path}/.claude/worktrees/${key}` })),
    );
    await sendMsg({ type: "notepad:runMany", ids });
    expect(vi.mocked(openSharedWorkspace).mock.calls.at(-1)![0].tasks).toHaveLength(1);
    const toast = posted.find((m) => (m as { type: string }).type === "toast") as { message: string };
    expect(toast.message).toContain("api");
  });

  it("is a no-op for an empty selection and for ids it does not know", async () => {
    const { sendMsg } = await twoNotes();
    vi.mocked(discoverRepos).mockClear();
    await sendMsg({ type: "notepad:runMany", ids: [] });
    await sendMsg({ type: "notepad:runMany", ids: ["ghost"] });
    expect(openSharedWorkspace).not.toHaveBeenCalled();
    expect(discoverRepos).not.toHaveBeenCalled();
  });
});
```

`CFG.openIn` in this test file is `"new-window"`, so `chooseOpenTarget` returns `{ kind: "new" }` with no picker at all — which is why one `showQuickPick` mock (the repo picker) is enough above, exactly as the existing `notepad:run` tests do it. A test that wants the destination picker must override `getConfig` with `openIn: "ask"` and mock the destination pick *before* the repo pick, in that order.

- [ ] **Step 2: Run and watch them fail**

```bash
npx vitest run test/unit/tasksView.test.ts -t "runMany"
```

Expected: FAIL — unknown message type / `openSharedWorkspace` never called.

- [ ] **Step 3: Add the message type and its op**

`src/types.ts`:

```ts
  | { type: "notepad:runMany"; ids: string[] }
```

`src/tasksView.ts`, in `MESSAGE_OPS` beside `"notepad:run"`:

```ts
  "notepad:runMany": "workspace_write",
```

Leave `notepad:moveMany` out of that map — it touches no engine operation, exactly like `notepad:add` and `notepad:setSection`.

- [ ] **Step 4: Route it**

In the `onMessage` switch, after `case "notepad:run"`:

```ts
        case "notepad:runMany": {
          await this.runNotepadBatch(m.ids);
          break;
        }
```

- [ ] **Step 5: Implement `runNotepadBatch`**

Add beside `runNotepadItem` in `src/tasksView.ts`:

```ts
  /** Launch several notes into ONE window — a Claude session and a git worktree each.
   * The notepad's answer to takeBatch's shared-window path, and it reuses that engine:
   * N notes in one shared checkout would overwrite each other's brief. Single-note Start
   * keeps its no-worktree behaviour; only a batch cuts worktrees. */
  public async runNotepadBatch(ids: string[]): Promise<void> {
    const wanted = new Set(ids);
    // List order, not the order the ids arrived in: the sessions are seeded in the
    // order the user sees, and `notes()` is what the panel renders.
    const notes = this.notes().filter((n) => wanted.has(n.id));
    if (notes.length === 0) return;

    const cfg = getConfig();
    if (this.remoteControlBlocksLaunch(cfg)) return;
    const repos = discoverRepos(cfg.reposRoot, cfg.repoBlocklist);
    if (repos.length === 0) {
      this.toast("error", `No repos found under ${cfg.reposRoot}. Check agentFlow.reposRoot.`);
      return;
    }

    if (notes.length > cfg.batchLaunchConfirmThreshold) {
      const go = await vscode.window.showWarningMessage(
        `Launch ${notes.length} notes in one window? That's ${notes.length} ${providerLabel(cfg.agentProvider)} sessions.`,
        { modal: true },
        "Launch",
      );
      if (go !== "Launch") return;
    }

    const target = await this.chooseOpenTarget(cfg);
    if (!target) return;

    // Asked for every destination, unlike resolveKickoffTarget: worktrees have to be cut
    // from discovered repos, and the folders a destination already holds are checkouts,
    // not somewhere a batch may put N sessions.
    const picks = await vscode.window.showQuickPick<vscode.QuickPickItem & { repo: ServiceRef }>(
      repos.map((r) => ({ label: r.name, detail: r.isGit ? r.path : `${r.path}  (not a git repo)`, repo: r })),
      {
        canPickMany: true,
        title: `Notepad batch — pick the repos to open`,
        placeHolder: "Space to toggle · Enter to open",
        ignoreFocusOut: true,
      },
    );
    if (!picks || picks.length === 0) return;
    const wantedRepos = picks.map((p) => p.repo);

    const generic = cfg.exploreActions.find((a) => a.id === "general");
    const promptTemplate = applyExploreVars(injectSlackDm(generic?.prompt ?? "", generic?.slackDm ?? false), {
      env: undefined,
      services: wantedRepos.map((r) => r.name).join(", "),
    });

    const resolved: { id: string; task: BatchTask }[] = [];
    const failed: string[] = [];
    for (const note of notes) {
      const topic = note.title.trim() || "Notepad item";
      // Same key as the single-note path, so re-running a note replaces its own prior
      // record rather than accumulating orphans.
      const key = `notepad-${slugify(note.title.trim()) || "note"}-${note.id}`;
      try {
        const services = createWorktrees(wantedRepos, key, topic, this.log);
        // createWorktrees returns the original ref when `git worktree add` fails; two
        // notes landing in one checkout would clobber each other's brief, so that is a
        // failure for this note, not a fallback.
        const collided = services.filter((s, i) => s.path === wantedRepos[i].path).map((s) => s.name);
        if (collided.length) {
          throw new Error(`couldn't create a git worktree in ${collided.join(", ")} (would collide with the shared checkout)`);
        }
        const detail = note.body.trim();
        resolved.push({
          id: note.id,
          task: {
            ticket: { key, summary: topic, url: "" },
            planMd:
              `## Notepad: ${topic}\n\n_No ticket — an item you wrote in the Agent Flow notepad. ` +
              `If it turns into tracked work, open a ticket afterwards._` +
              (detail ? `\n\n${detail}` : ""),
            descriptionText: note.body,
            services,
            promptSuffix: detail ? `Details from the note:\n\n${detail}` : undefined,
          },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failed.push(`${topic} (${msg})`);
        this.log(`runNotepadBatch ${key}: failed — ${msg}`);
      }
    }
    if (resolved.length === 0) {
      this.toast("error", `Launched 0 of ${notes.length}: ${failed.join("; ")}`);
      return;
    }

    // This window can lose its identity between the destination pick and here — the repo
    // picker and every createWorktrees call run in between. Without it openSharedWorkspace
    // has no "current" destination and would open a window nobody asked for.
    const here = target.kind === "current" ? currentWindow() : undefined;
    if (target.kind === "current" && !here) {
      this.toast("error", "This window can no longer hold a session — nothing was opened.");
      return;
    }

    let result;
    try {
      result = await openSharedWorkspace({
        tasks: resolved.map((r) => r.task),
        promptTemplate,
        workspaceDir: cfg.workspaceDir,
        seedAgent: cfg.seedAgent,
        target,
        currentWindow: here,
        // Deliberately no foldersToAdd: a notepad batch never edits the user's
        // .code-workspace file. The briefs carry absolute paths regardless.
        kind: "notepad",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`runNotepadBatch: shared window failed — ${msg}`);
      this.toast("error", `Couldn't open the batch: ${msg}`);
      return;
    }

    // After the launch, never before: a failure must leave no pointer to a run that
    // was never created.
    const keyById = new Map(resolved.map((r) => [r.id, r.task.ticket.key]));
    await this.saveNotes(this.notes().map((n) => (keyById.has(n.id) ? { ...n, lastRunKey: keyById.get(n.id) } : n)));

    const seeded = this.seededNote(cfg.seedAgent, false, cfg.agentProvider, result.seededInPlace);
    const failedNote = failed.length ? ` ${failed.length} couldn't start: ${failed.join("; ")}` : "";
    this.toast(
      failed.length ? "error" : "success",
      `Launched ${resolved.length} of ${notes.length} notes in one window, a worktree each.${seeded}${failedNote}`,
    );
  }
```

Every symbol above already exists in `tasksView.ts` — verified: `ServiceRef`, `BatchTask`, `currentWindow`, `createWorktrees`, `openSharedWorkspace`, `providerLabel`, `applyExploreVars`, `injectSlackDm`, `discoverRepos`, and the module-local `slugify`. Add no new import. `this.seededNote`'s signature is `(seedAgent, remoteControl, provider, seededInPlace)`; Remote Control is always `false` here — one clipboard cannot serve N sessions — and it is deliberately never resolved, so there is no `remoteControlNote` in the toast either.

- [ ] **Step 6: Run the new tests, then the file**

```bash
npx vitest run test/unit/tasksView.test.ts -t "runMany"
npx vitest run test/unit/tasksView.test.ts
```

Expected: PASS both. If an existing test broke, stop and report — do not edit it.

- [ ] **Step 7: Mutation-check**

Three checks, each reverted after: (a) drop `kind: "notepad"` — the first test fails; (b) move the `saveNotes` call above `openSharedWorkspace` and make the mock reject — the cancellation test fails; (c) drop the `collided` throw — the per-note failure test fails.

- [ ] **Step 8: Gates and commit**

```bash
npm run typecheck && npm test && npm run build
git add src/types.ts src/tasksView.ts test/unit/tasksView.test.ts
git commit -m "feat(notepad): launch several notes into one window, a worktree each"
```

---

### Task 5: Select mode, the selection, and the batch bar

**Files:**
- Modify: `src/webview/Notepad.tsx`
- Modify: `src/webview/styles.ts` (add `.np-sel`, `.np-item.picked`, `.batch-move`; reuse `.batch-bar`, `.batch-count`, `.batch-selectall`, `.batch-clear`, `.batch-launch` as they stand)
- Test: `test/webview/Notepad.test.tsx`

**Interfaces:**
- Consumes: `{ type: "notepad:runMany"; ids: string[] }` (Task 4).
- Produces: a `Select` toggle button (`aria-pressed`), per-row checkboxes labelled `Select: <title>`, and the batch bar with `Select all` / `Clear` / `Start together`. Task 6 adds `Move to` to that bar.

- [ ] **Step 1: Write the failing tests**

Add to `test/webview/Notepad.test.tsx`, whose `note`/`section` factories and `sendSpy` are already at the top of the file:

```ts
describe("select mode", () => {
  const three = () => [
    note({ id: "a", title: "alpha" }),
    note({ id: "b", title: "beta" }),
    note({ id: "c", title: "gamma", done: true }),
  ];

  it("shows no selection affordance until the mode is on", () => {
    render(<Notepad notes={three()} ordered={false} />);
    expect(screen.queryByRole("checkbox", { name: /^Select:/ })).toBeNull();
    expect(screen.queryByText(/selected/)).toBeNull();
  });

  it("reveals a select checkbox per visible note once on", () => {
    render(<Notepad notes={three()} ordered={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    // Active filter hides the done note, so two rows, not three.
    expect(screen.getAllByRole("checkbox", { name: /^Select:/ })).toHaveLength(2);
  });

  it("raises the bar only once something is picked, and counts what is picked", () => {
    render(<Notepad notes={three()} ordered={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    expect(screen.queryByText(/selected/)).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select: alpha" }));
    expect(screen.getByText("1 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select: beta" }));
    expect(screen.getByText("2 selected")).toBeTruthy();
  });

  it("sends notepad:runMany with the picked ids in display order", () => {
    render(<Notepad notes={three()} ordered={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select: beta" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select: alpha" }));
    fireEvent.click(screen.getByRole("button", { name: /Start together/ }));
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:runMany", ids: ["a", "b"] });
    // Those notes are running now — the bar and the mode stand down.
    expect(screen.queryByText(/selected/)).toBeNull();
    expect(screen.getByRole("button", { name: "Select" })).toHaveAttribute("aria-pressed", "false");
  });

  it("launches a done note that was picked under the All filter", () => {
    render(<Notepad notes={three()} ordered={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select: gamma" }));
    fireEvent.click(screen.getByRole("button", { name: /Start together/ }));
    // Per-row Start already works on a done note; silently excluding it here would be
    // a second, invisible filter.
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:runMany", ids: ["c"] });
  });

  it("Select all picks the visible notes only", () => {
    render(<Notepad notes={three()} ordered={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    fireEvent.click(screen.getByRole("button", { name: /Start together/ }));
    // "gamma" is done, so the Active filter hides it — it must not be launched.
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:runMany", ids: ["a", "b"] });
  });

  it("drops a note from the selection when a filter change hides it", () => {
    render(<Notepad notes={three()} ordered={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select: gamma" }));
    expect(screen.getByText("1 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Active" }));
    expect(screen.queryByText(/selected/)).toBeNull();
  });

  it("Clear empties the selection but stays in the mode", () => {
    render(<Notepad notes={three()} ordered={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select: alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByText(/selected/)).toBeNull();
    expect(screen.getAllByRole("checkbox", { name: /^Select:/ })).toHaveLength(2);
  });

  it("leaving the mode clears the selection and restores the row's grip", () => {
    render(<Notepad notes={three()} ordered={false} />);
    const toggle = screen.getByRole("button", { name: "Select" });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select: alpha" }));
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("checkbox", { name: /^Select:/ })).toBeNull();
    expect(screen.getAllByTitle("Drag to reorder").length).toBe(2);
    fireEvent.click(toggle);
    expect(screen.queryByText(/selected/)).toBeNull();
  });

  it("keeps the done checkbox and the select checkbox separately addressable", () => {
    render(<Notepad notes={[note({ id: "a", title: "alpha" })]} ordered={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Done: alpha" }));
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:toggleDone", id: "a" });
    sendSpy.mockClear();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select: alpha" }));
    // Selecting is webview-local — it must send nothing.
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
npx vitest run test/webview/Notepad.test.tsx -t "select mode"
```

Expected: FAIL — no `Select` button exists.

- [ ] **Step 3: Implement the state and the toggle**

In `src/webview/Notepad.tsx`, beside the existing `filter` state:

```tsx
  // Selection is webview-local and dies with the panel, like `filter` above: a
  // persisted selection would greet the user with actions armed over notes they
  // picked in another session.
  const [selectMode, setSelectMode] = React.useState(false);
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
```

Derive the visible selection next to `shown`:

```tsx
  // Only what the filter shows can be acted on: an action whose count excluded a
  // hidden note must not touch it either.
  const pickedVisible = shown.filter((n) => picked.has(n.id));
  const togglePick = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const leaveSelect = () => { setSelectMode(false); setPicked(new Set()); };
```

Add the toggle to the filter `.lens`, after the `.seg` group:

```tsx
          <button
            className={selectMode ? "quiet np-select-on" : "quiet dim"}
            aria-pressed={selectMode}
            onClick={() => (selectMode ? leaveSelect() : setSelectMode(true))}
          >
            Select
          </button>
```

- [ ] **Step 4: Thread selection into the rows**

`NoteRow` takes one more optional prop; pass it from BOTH call sites (the ungrouped list and the per-section list) — a selection that works in one and not the other is the defect this step exists to avoid:

```tsx
  select?: { checked: boolean; onToggle: () => void };
```

Inside `NoteRow`'s returned `<li>`, replace the grip with the select box while selecting:

```tsx
        {select ? (
          <input
            className="cb np-sel"
            type="checkbox"
            checked={select.checked}
            aria-label={`Select: ${note.title || "untitled note"}`}
            onChange={select.onToggle}
          />
        ) : (
          <span
            className="grip"
            title="Drag to reorder"
            onMouseDown={(e) => { e.stopPropagation(); setArmed(true); }}
          >⠿</span>
        )}
```

and fold `select?.checked` into the row's class list beside `dnd.dragging`:

```tsx
    select?.checked ? "picked" : "",
```

- [ ] **Step 5: Add the bar**

After the `.np-list` block, inside the component's root `<div className="notepad">`:

```tsx
      {selectMode && pickedVisible.length > 0 && (
        <div className="batch-bar">
          <span className="batch-count">{pickedVisible.length} selected</span>
          <button className="batch-selectall" onClick={() => setPicked(new Set(shown.map((n) => n.id)))}>
            Select all
          </button>
          <button className="batch-clear" onClick={() => setPicked(new Set())}>Clear</button>
          <button
            className="batch-launch"
            title={`Open ${pickedVisible.length} ${pickedVisible.length === 1 ? "note" : "notes"} in one window, a session and a git worktree each`}
            onClick={() => { send({ type: "notepad:runMany", ids: pickedVisible.map((n) => n.id) }); leaveSelect(); }}
          >
            <PlayIcon /> Start together
          </button>
        </div>
      )}
```

- [ ] **Step 6: Add the three styles**

In `src/webview/styles.ts`, beside the existing notepad block:

```css
  /* Select mode's box takes the grip's slot, so the row's geometry is unchanged —
     --grip-w still describes the space, and .np-body's margin still lines up. */
  .np-top .np-sel { width: var(--grip-w); }
  /* A picked row reads as picked without borrowing the run rail: that ::before keeps
     saying where the note's run is, and this ::after says the user has it selected. */
  .np-item.picked { background: color-mix(in srgb, var(--brand) 12%, transparent); }
  .np-item.picked::after { content: ""; position: absolute; left: 0; top: 0; bottom: 0;
    width: 2px; background: var(--brand); }
  .np-item.picked .np-acts { opacity: .4; }
  .batch-move { display: inline-flex; align-items: center; gap: 5px; font-size: 11px;
    padding: 3px 9px; border-radius: var(--r-ctl); border: 1px solid var(--edge);
    background: transparent; color: var(--vscode-foreground); cursor: pointer; }
  .np-select-on { border-color: var(--brand);
    background: color-mix(in srgb, var(--brand) 18%, transparent); }
```

`.batch-move` is unused until Task 6 — it ships here so the whole bar's styling lands in one commit.

- [ ] **Step 7: Run the webview suite**

```bash
npx vitest run test/webview/Notepad.test.tsx
```

Expected: PASS, including every pre-existing case. The mode-off cases are the guard: if an existing test broke, mode-off is no longer identical to today, which is a Global Constraint violation — fix the code, not the test.

- [ ] **Step 8: Mutation-check**

Change `pickedVisible` to `[...picked]` in the `runMany` send; the hidden-note tests must fail. Restore.

- [ ] **Step 9: Gates and commit**

```bash
npm run typecheck && npm test && npm run build
git add src/webview/Notepad.tsx src/webview/styles.ts test/webview/Notepad.test.tsx
git commit -m "feat(notepad): add a select mode and a batch bar to the note list"
```

---

### Task 6: `Move to ▾` — refile the selection from the bar

**Files:**
- Modify: `src/webview/Notepad.tsx` (the bar from Task 5)
- Modify: `src/webview/styles.ts` (a popover class, modelled on `.repo-pop` / `.repo-opt`)
- Test: `test/webview/Notepad.test.tsx`

**Interfaces:**
- Consumes: `{ type: "notepad:moveMany"; ids: string[]; sectionId?: string }` (Task 3), the bar and `pickedVisible` (Task 5).
- Produces: nothing later tasks depend on — this is the last task.

- [ ] **Step 1: Write the failing tests**

```ts
describe("move a selection to a section", () => {
  const sections = [section({ id: "s1", name: "Shipping" }), section({ id: "s2", name: "Ideas" })];
  const notes = [
    note({ id: "a", title: "alpha" }),
    note({ id: "b", title: "beta", sectionId: "s1" }),
  ];

  it("offers no Move to button until something is picked", () => {
    render(<Notepad notes={notes} ordered={false} sections={sections} />);
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    expect(screen.queryByRole("button", { name: /Move to/ })).toBeNull();
  });

  it("lists every section plus Ungrouped, and sends the pick", () => {
    render(<Notepad notes={notes} ordered={false} sections={sections} />);
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select: alpha" }));
    fireEvent.click(screen.getByRole("button", { name: /Move to/ }));
    expect(screen.getByRole("button", { name: "Ungrouped" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ideas" }));
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:moveMany", ids: ["a"], sectionId: "s2" });
  });

  it("omits sectionId entirely when Ungrouped is chosen", () => {
    render(<Notepad notes={notes} ordered={false} sections={sections} />);
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select: beta" }));
    fireEvent.click(screen.getByRole("button", { name: /Move to/ }));
    fireEvent.click(screen.getByRole("button", { name: "Ungrouped" }));
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:moveMany", ids: ["b"], sectionId: undefined });
  });

  it("closes the popover and clears the selection after a move", () => {
    render(<Notepad notes={notes} ordered={false} sections={sections} />);
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select: alpha" }));
    fireEvent.click(screen.getByRole("button", { name: /Move to/ }));
    fireEvent.click(screen.getByRole("button", { name: "Shipping" }));
    expect(screen.queryByRole("button", { name: "Ungrouped" })).toBeNull();
    expect(screen.queryByText(/selected/)).toBeNull();
  });

  it("offers no Move to button at all when the notepad has no sections", () => {
    render(<Notepad notes={[note({ id: "a", title: "alpha" })]} ordered={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select: alpha" }));
    expect(screen.queryByRole("button", { name: /Move to/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Start together/ })).toBeTruthy();
  });
});
```

The last case matters: sections are opt-in, and a Move-to menu whose only entry is "Ungrouped" is a control with nothing to do.

- [ ] **Step 2: Run and watch them fail**

```bash
npx vitest run test/webview/Notepad.test.tsx -t "move a selection"
```

Expected: FAIL — no `Move to` button.

- [ ] **Step 3: Implement**

One more piece of state in `Notepad`:

```tsx
  const [moveOpen, setMoveOpen] = React.useState(false);
```

In the bar, between `Clear` and `Start together`:

```tsx
          {sections.length > 0 && (
            <div className="np-move">
              <button className="batch-move" aria-expanded={moveOpen} onClick={() => setMoveOpen((v) => !v)}>
                Move to ▾
              </button>
              {moveOpen && (
                <div className="np-move-pop" role="group" aria-label="Move to section">
                  {[{ id: undefined, name: "Ungrouped" }, ...sections].map((s) => (
                    <button
                      key={s.id ?? "ungrouped"}
                      className="np-move-opt"
                      onClick={() => {
                        send({ type: "notepad:moveMany", ids: pickedVisible.map((n) => n.id), sectionId: s.id });
                        setMoveOpen(false);
                        leaveSelect();
                      }}
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
```

`leaveSelect` must also close this popover, or reopening select mode shows a stale menu:

```tsx
  const leaveSelect = () => { setSelectMode(false); setPicked(new Set()); setMoveOpen(false); };
```

- [ ] **Step 4: Style the popover**

In `src/webview/styles.ts`, following `.repo-pop`'s language (a popover that opens UPWARD — the bar sits at the bottom of the panel):

```css
  .np-move { position: relative; }
  .np-move-pop { position: absolute; z-index: 10; bottom: calc(100% + 4px); left: 0; min-width: 160px;
    border: 1px solid var(--vscode-focusBorder); border-radius: 8px; overflow: hidden;
    background: var(--vscode-dropdown-background, var(--vscode-editorWidget-background, var(--vscode-editor-background)));
    box-shadow: 0 6px 20px rgba(0,0,0,.35); display: flex; flex-direction: column; }
  .np-move-opt { text-align: left; background: none; border: none; cursor: pointer;
    padding: 5px 10px; font-size: 11px; font-family: inherit; color: var(--vscode-foreground); }
  .np-move-opt:hover { background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground); }
```

- [ ] **Step 5: Run the webview suite**

```bash
npx vitest run test/webview/Notepad.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Mutation-check**

Change `sectionId: s.id` to `sectionId: s.id ?? sections[0].id`; the Ungrouped test must fail. Restore.

- [ ] **Step 7: All gates, including coverage**

```bash
npm run typecheck && npm test && npm run test:cov && npm run build
```

Coverage thresholds must pass on the changed files. If a branch is uncovered, add the missing test — do not lower a threshold.

- [ ] **Step 8: Commit**

```bash
git add src/webview/Notepad.tsx src/webview/styles.ts test/webview/Notepad.test.tsx
git commit -m "feat(notepad): move a selection of notes into a section from the batch bar"
```

---

## Verification before calling this done

- [ ] `npm run typecheck`, `npm test`, `npm run test:cov`, `npm run build` all green, output pasted into the report — not summarized.
- [ ] `git diff main --stat` touches only: `src/types.ts`, `src/tasksView.ts`, `src/engine/workspace.ts`, `src/engine/batchWorkspace.ts`, `src/webview/Notepad.tsx`, `src/webview/styles.ts`, and their four test files. Nothing else, and no existing test modified.
- [ ] Manual pass in a dev host (`code --extensionDevelopmentPath=<repo>` — the Cursor CLI silently drops that flag): with select mode off the notepad looks exactly as before; on, pick two notes, move them to a section, then pick two and Start together and confirm one window opens with two worktrees and two seeded sessions.
- [ ] The Deck shows both launched notes as runs with no PR row — that is `kind: "notepad"` arriving intact.

## Known follow-up, deliberately out of scope

The in-flight notepad-images work gives a note attachments and carries them into a launch via `OpenRequest.attachments` (copied into `<repo>/.pick-task/images/`). `BatchTask` has no such field, so once that work lands, a note launched **in a batch** will seed without its images while the same note launched alone gets them. That is a real gap, not a design choice — it needs `attachments` threading through `openSharedWorkspace` the way Task 2 threads `promptSuffix`. It is out of scope here because the field does not exist on `main` yet; open it as its own item once notepad images ships.
