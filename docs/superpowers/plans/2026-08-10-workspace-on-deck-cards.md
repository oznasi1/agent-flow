# Workspace context on Deck cards — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Deck card built from a Claude Code session inside a multi-root workspace names that workspace and unfolds its repos on hover, instead of naming only the folder the session happens to run in.

**Architecture:** The window presence record starts carrying its folder paths, which lets `deckView`'s refresh fold every session place belonging to one multi-root window into a single local `Run` holding every git root. The webview then collapses a multi-repo run's flat chip row into one workspace chip that reveals its repo chips on hover.

**Tech Stack:** TypeScript, VS Code extension host, React 18 webview (no framework CSS — a hand-written sheet in `src/webview/deckStyles.ts`), Vitest + Testing Library, esbuild.

**Spec:** `docs/superpowers/specs/2026-08-10-workspace-on-deck-cards-design.md`

## Global Constraints

- Work in this worktree: `/Users/oznasi/dev/agent-flow/.claude/worktrees/workspace-card`, branch `worktree-workspace-card`. Use absolute paths — other sessions share the root checkout.
- Gates, all four, before any task is called done: `npm run typecheck`, `npm test`, `npm run test:cov` (thresholds enforced), `npm run build`.
- `npm run build` is not optional. `src/webview/` must never import `fs`, `os`, `path` or `child_process`, even transitively — `tsc` and the test suite both pass when it does; only the bundle step fails.
- Every test in this plan must be mutation-checked: after it passes, break the line of implementation it targets, re-run it, confirm it fails, restore. A test that passes against broken code is a defect, not coverage. Say in the task's commit body which mutation you tried.
- The existing suite passes unmodified. The only test file edits allowed are the ones this plan names.
- `src/webview/deckStyles.ts` house rules: monospace is for identifiers only (repo names, branches, counts of things); anything that reads as English is UI font. New CSS may use tokens from `src/webview/tokens.ts` and must never redeclare them — `test/webview/tokens.test.ts` enforces this in both directions.
- Behavior must degrade to exactly today's when the new data is absent: a presence record with no `roots`, a place no live window claims, a single-root window.
- Commit after each task, Conventional Commits, ending with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/engine/presence.ts` | Window identity + the on-disk presence registry | `WindowIdentity` gains `roots: string[]`; `windowIdentity()` fills it |
| `src/engine/localRuns.ts` | Synthesizing a `Run` for a place the Deck never launched | New pure `groupPlacesByWindow`; `localRunFor` takes a group instead of a single place |
| `src/deckView.ts` | The refresh that reconciles runs, sessions, git and tickets | Wires the grouping in: per-root branch reads, per-root agent tagging |
| `src/webview/DeckApp.tsx` | The board and its cards | New `WorkspaceChip`; branch line follows the agent's repo |
| `src/webview/deckStyles.ts` | The Deck sheet | `.c-ws`, `.ws`, `.ws-fold` rules |
| `test/unit/engine/presence.test.ts` | | roots on identity and record |
| `test/unit/engine/localRuns.test.ts` | | grouping and run-shape tests |
| `test/unit/deckView.test.ts` | | refresh integration; its presence mock becomes steerable |
| `test/webview/DeckApp.test.tsx` | | chip rendering, fallbacks, branch line |

Tasks 1→4 are strictly ordered (each consumes the last). Task 5 and Task 6 touch only the webview and depend on nothing but the `Run` shape, which already has `workspaceFile`.

---

### Task 1: Presence records carry their roots

**Files:**
- Modify: `src/engine/presence.ts:7-12` (`WindowIdentity`), `src/engine/presence.ts:28-40` (`windowIdentity`)
- Test: `test/unit/engine/presence.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `WindowIdentity.roots: string[]` — canonicalized folder paths of the window, in `workspaceFolders` order. Empty array for a window with no folders. `PresenceRecord` inherits it, and `src/extension.ts:147` already spreads the whole identity into the record, so no writer changes.

- [ ] **Step 1: Write the failing tests**

In `test/unit/engine/presence.test.ts`, inside the existing `describe("windowIdentity", ...)`, replace the two `toEqual` expectations that pin the identity shape (they will otherwise fail on the new field) and add the roots cases:

```ts
  it("is a workspace identity when a .code-workspace file is open", () => {
    workspace.workspaceFile = { scheme: "file", fsPath: "/ws/team.code-workspace" };
    workspace.workspaceFolders = [{ uri: { fsPath: "/repos/a" } }, { uri: { fsPath: "/repos/b" } }];
    expect(windowIdentity()).toEqual({
      identity: "/ws/team.code-workspace", kind: "workspace", label: "team.code-workspace",
      folders: 2, roots: ["/repos/a", "/repos/b"],
    });
  });

  it("is a folder identity for a single-folder window", () => {
    workspace.workspaceFolders = [{ uri: { fsPath: "/repos/foo" } }];
    expect(windowIdentity()).toEqual({
      identity: "/repos/foo", kind: "folder", label: "foo", folders: 1, roots: ["/repos/foo"],
    });
  });

  it("carries the roots of a workspace whose folders were never opened", () => {
    // A .code-workspace can be open with zero resolved folders; the record must
    // still be writable, and claim nothing.
    workspace.workspaceFile = { scheme: "file", fsPath: "/ws/empty.code-workspace" };
    workspace.workspaceFolders = undefined;
    expect(windowIdentity()?.roots).toEqual([]);
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run test/unit/engine/presence.test.ts`
Expected: FAIL — the returned object has no `roots` key.

- [ ] **Step 3: Add the field**

In `src/engine/presence.ts`, extend the interface:

```ts
export interface WindowIdentity {
  identity: string; // canonical path — a .code-workspace file or a single folder
  kind: "workspace" | "folder";
  label: string; // basename, for display
  folders: number; // folder count in the window
  /** The window's folder paths, canonicalized, in workspaceFolders order. The
   * Deck maps a session's directory back to the window holding it with these;
   * `folders` alone could only ever say how many there were. Absent on a record
   * written by an older extension host — every reader treats that as a window
   * that claims nothing, which is exactly the behavior before this field. */
  roots: string[];
}
```

and fill it in both branches of `windowIdentity`:

```ts
export function windowIdentity(): WindowIdentity | undefined {
  const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => canon(f.uri.fsPath));
  const wf = vscode.workspace.workspaceFile;
  if (wf && wf.scheme === "file") {
    const identity = canon(wf.fsPath);
    return { identity, kind: "workspace", label: path.basename(identity), folders: roots.length, roots };
  }
  if (roots.length === 1) {
    return { identity: roots[0], kind: "folder", label: path.basename(roots[0]), folders: 1, roots };
  }
  return undefined;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/unit/engine/presence.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation-check**

Change `roots` in the workspace branch to `[]`, re-run, confirm the first test fails, restore.

- [ ] **Step 6: Typecheck the whole tree**

Run: `npm run typecheck`
Expected: clean. `PresenceRecord` literals elsewhere may now be missing `roots` — fix them by adding the real value, never by making the field optional.

- [ ] **Step 7: Commit**

```bash
git add src/engine/presence.ts test/unit/engine/presence.test.ts
git commit -m "feat: presence records carry their window's folder paths"
```

---

### Task 2: Group session places by the window that holds them

**Files:**
- Modify: `src/engine/localRuns.ts`
- Test: `test/unit/engine/localRuns.test.ts`

**Interfaces:**
- Consumes: `WindowIdentity` from Task 1 (structurally — this function takes a narrowed shape, not the type, so it stays free of `vscode`).
- Produces:

```ts
export interface LocalGroup {
  /** The .code-workspace this card stands for, or null for a lone place. */
  workspaceFile: string | null;
  /** Every folder the card covers, in window order. `[place]` when standalone. */
  roots: string[];
  /** The session places inside this group, in input order — never empty. */
  places: string[];
}

export function groupPlacesByWindow(
  places: string[],
  windows: { identity: string; kind: "workspace" | "folder"; roots?: string[] }[],
): LocalGroup[]
```

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/engine/localRuns.test.ts`:

```ts
import { groupPlacesByWindow } from "../../../src/engine/localRuns";

const ws = (identity: string, roots: string[]) =>
  ({ identity, kind: "workspace" as const, roots });

describe("groupPlacesByWindow", () => {
  it("folds two places of one multi-root window into a single group", () => {
    expect(groupPlacesByWindow(
      ["/r/automation_e2e", "/r/centaur"],
      [ws("/ws/centaur+e2e.code-workspace", ["/r/centaur", "/r/automation_e2e"])],
    )).toEqual([{
      workspaceFile: "/ws/centaur+e2e.code-workspace",
      roots: ["/r/centaur", "/r/automation_e2e"],
      places: ["/r/automation_e2e", "/r/centaur"],
    }]);
  });

  it("covers a root with no session of its own", () => {
    // The whole point: the card names both repos even though Claude only runs
    // in one of them.
    expect(groupPlacesByWindow(
      ["/r/automation_e2e"],
      [ws("/ws/centaur+e2e.code-workspace", ["/r/centaur", "/r/automation_e2e"])],
    )).toEqual([{
      workspaceFile: "/ws/centaur+e2e.code-workspace",
      roots: ["/r/centaur", "/r/automation_e2e"],
      places: ["/r/automation_e2e"],
    }]);
  });

  it("leaves a place no window lists standing alone", () => {
    expect(groupPlacesByWindow(["/r/lonely"], [ws("/ws/x.code-workspace", ["/r/a", "/r/b"])]))
      .toEqual([{ workspaceFile: null, roots: ["/r/lonely"], places: ["/r/lonely"] }]);
  });

  it("leaves a place alone when the window's record predates roots", () => {
    // An older extension host wrote no roots. Claiming nothing is exactly the
    // behavior before this feature.
    expect(groupPlacesByWindow(
      ["/r/centaur"],
      [{ identity: "/ws/x.code-workspace", kind: "workspace" as const }],
    )).toEqual([{ workspaceFile: null, roots: ["/r/centaur"], places: ["/r/centaur"] }]);
  });

  it("leaves a place alone when its window has a single root", () => {
    // A one-folder window is the place. Grouping it would rename the card after
    // a workspace file that adds nothing.
    expect(groupPlacesByWindow(
      ["/r/centaur"],
      [{ identity: "/r/centaur", kind: "folder" as const, roots: ["/r/centaur"] }],
    )).toEqual([{ workspaceFile: null, roots: ["/r/centaur"], places: ["/r/centaur"] }]);
  });

  it("keeps two windows' places apart, in first-place order", () => {
    expect(groupPlacesByWindow(
      ["/r/b", "/r/solo", "/r/a"],
      [ws("/ws/one.code-workspace", ["/r/a", "/r/b"])],
    ).map((g) => g.places)).toEqual([["/r/b", "/r/a"], ["/r/solo"]]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run test/unit/engine/localRuns.test.ts`
Expected: FAIL — `groupPlacesByWindow is not a function`.

- [ ] **Step 3: Implement it**

Append to `src/engine/localRuns.ts`:

```ts
/** A card's worth of places: one multi-root window's session directories, or a
 * single directory that no live window claims. */
export interface LocalGroup {
  /** The .code-workspace this card stands for, or null for a lone place. */
  workspaceFile: string | null;
  /** Every folder the card covers, in window order. `[place]` when standalone. */
  roots: string[];
  /** The session places inside this group, in input order — never empty. */
  places: string[];
}

/**
 * Fold session places into the multi-root window that holds them.
 *
 * Only a window with a .code-workspace and more than one root groups anything: a
 * single-folder window *is* the place, so grouping it would rename the card after
 * a file that adds no information. A window whose record carries no `roots` was
 * written by an older extension host and claims nothing — that record cannot say
 * which folders it holds, and guessing from the workspace file would mean reading
 * and parsing it on every refresh.
 *
 * Every input place comes back in exactly one group, in first-appearance order,
 * so the board's card order does not shuffle between refreshes.
 */
export function groupPlacesByWindow(
  places: string[],
  windows: { identity: string; kind: "workspace" | "folder"; roots?: string[] }[],
): LocalGroup[] {
  const owner = new Map<string, { identity: string; roots: string[] }>();
  for (const w of windows) {
    const roots = w.roots ?? [];
    if (w.kind !== "workspace" || roots.length < 2) continue;
    for (const root of roots) {
      if (!owner.has(root)) owner.set(root, { identity: w.identity, roots });
    }
  }
  const groups: LocalGroup[] = [];
  const byWorkspace = new Map<string, LocalGroup>();
  for (const place of places) {
    const win = owner.get(place);
    if (!win) {
      groups.push({ workspaceFile: null, roots: [place], places: [place] });
      continue;
    }
    const existing = byWorkspace.get(win.identity);
    if (existing) {
      existing.places.push(place);
      continue;
    }
    const group: LocalGroup = { workspaceFile: win.identity, roots: win.roots, places: [place] };
    byWorkspace.set(win.identity, group);
    groups.push(group);
  }
  return groups;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/unit/engine/localRuns.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation-check**

Change `roots.length < 2` to `roots.length < 1`, re-run, confirm the single-root test fails; restore. Then drop the `if (!owner.has(root))` guard's negation (`owner.set` unconditionally) — the suite should still pass, which is fine; that guard only fixes ties between two windows listing the same root, and the first writer wins by construction.

- [ ] **Step 6: Commit**

```bash
git add src/engine/localRuns.ts test/unit/engine/localRuns.test.ts
git commit -m "feat: group open session places by the multi-root window holding them"
```

---

### Task 3: A local run for a whole group

**Files:**
- Modify: `src/engine/localRuns.ts:53-72` (`localRunFor`)
- Test: `test/unit/engine/localRuns.test.ts`

**Interfaces:**
- Consumes: `LocalGroup` from Task 2.
- Produces:

```ts
export function localRunFor(
  group: LocalGroup,
  sessions: OpenSession[],
  git: (root: string) => { isGit: boolean; branch: string | null },
  ticket: InferredTicket | null,
  nowMs: number,
): Run
```

The old `(place, sessions, git, ticket, nowMs)` signature is replaced, not kept alongside — `src/deckView.ts:639` is its only caller and Task 4 updates it. Key is `localKey(group.workspaceFile ?? group.roots[0])`. `mode` is `"multiroot"` with a workspace file, `"per-window"` without. Summary falls back to the workspace label (basename, `.code-workspace` stripped) or the lone root's basename.

- [ ] **Step 1: Write the failing tests**

Replace the existing `describe("localRunFor", ...)` block's calls with the group form and add the workspace cases:

```ts
const GIT = (root: string) => ({ isGit: true, branch: root === "/r/centaur" ? "ASM-1-x" : "main" });
const solo = (place: string) => ({ workspaceFile: null, roots: [place], places: [place] });

describe("localRunFor", () => {
  it("keeps one repo and a per-window mode for a lone place", () => {
    const run = localRunFor(solo("/r/centaur"), [sess()], GIT, null, NOW);
    expect(run.mode).toBe("per-window");
    expect(run.workspaceFile).toBeUndefined();
    expect(run.repos).toEqual([{ name: "centaur", path: "/r/centaur", isGit: true, branch: "ASM-1-x" }]);
    expect(run.summary).toBe("centaur");
    expect(run.kind).toBe("local");
  });

  it("carries every root of a workspace group, each with its own branch", () => {
    const run = localRunFor(
      { workspaceFile: "/ws/centaur+e2e.code-workspace", roots: ["/r/centaur", "/r/automation_e2e"], places: ["/r/automation_e2e"] },
      [sess({ cwd: "/r/automation_e2e" })], GIT, null, NOW,
    );
    expect(run.repos).toEqual([
      { name: "centaur", path: "/r/centaur", isGit: true, branch: "ASM-1-x" },
      { name: "automation_e2e", path: "/r/automation_e2e", isGit: true, branch: "main" },
    ]);
    expect(run.workspaceFile).toBe("/ws/centaur+e2e.code-workspace");
    expect(run.mode).toBe("multiroot");
  });

  it("names a ticketless workspace card after the workspace, not a folder", () => {
    const run = localRunFor(
      { workspaceFile: "/ws/centaur+e2e.code-workspace", roots: ["/r/centaur", "/r/automation_e2e"], places: ["/r/automation_e2e"] },
      [sess({ cwd: "/r/automation_e2e" })], GIT, null, NOW,
    );
    expect(run.summary).toBe("centaur+e2e");
  });

  it("prefers the inferred ticket's summary and url over the workspace name", () => {
    const run = localRunFor(
      { workspaceFile: "/ws/centaur+e2e.code-workspace", roots: ["/r/centaur"], places: ["/r/centaur"] },
      [sess()], GIT, { key: "ASM-1", url: "https://jira/browse/ASM-1", summary: "team table" }, NOW,
    );
    expect(run.summary).toBe("team table");
    expect(run.url).toBe("https://jira/browse/ASM-1");
  });

  it("keys a workspace group off the workspace file, so both its sessions land on one card", () => {
    const g = { workspaceFile: "/ws/centaur+e2e.code-workspace", roots: ["/r/centaur", "/r/automation_e2e"], places: ["/r/centaur"] };
    expect(localRunFor(g, [sess()], GIT, null, NOW).key)
      .toBe(localRunFor({ ...g, places: ["/r/automation_e2e"] }, [sess()], GIT, null, NOW).key);
  });

  it("omits a branch a root does not have", () => {
    const run = localRunFor(solo("/r/plain"), [sess()], () => ({ isGit: false, branch: null }), null, NOW);
    expect(run.repos).toEqual([{ name: "plain", path: "/r/plain", isGit: false }]);
  });

  it("starts at the earliest session and falls back to now", () => {
    expect(localRunFor(solo("/r/centaur"), [sess({ startedAt: 900 }), sess({ startedAt: 500 })], GIT, null, NOW).createdAt).toBe(500);
    expect(localRunFor(solo("/r/centaur"), [sess({ startedAt: 0 })], GIT, null, NOW).createdAt).toBe(NOW);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run test/unit/engine/localRuns.test.ts`
Expected: FAIL — `localRunFor` still expects a string place, so `run.repos` comes back named after `[object Object]` or the call throws.

- [ ] **Step 3: Rewrite `localRunFor`**

```ts
/** A workspace file's display name — "centaur+e2e.code-workspace" → "centaur+e2e". */
function workspaceName(file: string): string {
  return path.basename(file).replace(/\.code-workspace$/, "");
}

/**
 * The card for a group of places Agent Flow Deck never launched, shaped as a Run so
 * the whole existing pipeline — gitState, deriveBucket, prSignals, presence, Open,
 * Diff — renders it with no special case. Never written to the runs store unless the
 * user picks Track it.
 *
 * A group covering a real .code-workspace keys off that file rather than any one of
 * its folders: two sessions in the same workspace must land on the same card, and
 * the key outlives whichever of them started first. `runTarget` then opens the
 * workspace, which is what the user was actually working in.
 */
export function localRunFor(
  group: LocalGroup,
  sessions: OpenSession[],
  git: (root: string) => { isGit: boolean; branch: string | null },
  ticket: InferredTicket | null,
  nowMs: number,
): Run {
  const started = sessions.map((s) => s.startedAt).filter((n) => n > 0);
  const fallbackName = group.workspaceFile
    ? workspaceName(group.workspaceFile)
    : path.basename(group.roots[0]) || group.roots[0];
  return {
    key: localKey(group.workspaceFile ?? group.roots[0]),
    summary: ticket?.summary ?? fallbackName,
    url: ticket?.url ?? "",
    createdAt: started.length > 0 ? Math.min(...started) : nowMs,
    kind: "local",
    mode: group.workspaceFile ? "multiroot" : "per-window",
    ...(group.workspaceFile ? { workspaceFile: group.workspaceFile } : {}),
    repos: group.roots.map((root) => {
      const g = git(root);
      return {
        name: path.basename(root) || root,
        path: root,
        isGit: g.isGit,
        ...(g.branch ? { branch: g.branch } : {}),
      };
    }),
    briefPaths: [],
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/unit/engine/localRuns.test.ts`
Expected: PASS. `npm run typecheck` will still fail on `src/deckView.ts` — Task 4 fixes that caller.

- [ ] **Step 5: Mutation-check**

Change the key to `localKey(group.roots[0])`, re-run, confirm the "both its sessions land on one card" test fails; restore. Change `mode` to always `"per-window"`, confirm the mode test fails; restore.

- [ ] **Step 6: Commit**

```bash
git add src/engine/localRuns.ts test/unit/engine/localRuns.test.ts
git commit -m "feat: a local run stands for every root of its workspace"
```

---

### Task 4: Wire the grouping into the refresh

**Files:**
- Modify: `src/deckView.ts:596` (keep the records, not just identities), `src/deckView.ts:629-650` (the local-run loop)
- Test: `test/unit/deckView.test.ts:152-155` (steerable presence mock), plus new cases in `describe("DeckPanel local cards", ...)`

**Interfaces:**
- Consumes: `groupPlacesByWindow` and the new `localRunFor` from Tasks 2–3; `PresenceRecord.roots` from Task 1.
- Produces: local `RunStatus`es whose `run.repos` covers the workspace and whose `CardAgent.repo` names the root that agent actually runs in.

- [ ] **Step 1: Make the presence mock steerable and write the failing tests**

In `test/unit/deckView.test.ts`, the `h` fixture object gains a field next to `openSessions` (follow the file's existing style):

```ts
  liveWindows: [] as { identity: string; kind: "workspace" | "folder"; roots?: string[] }[],
```

reset in the same `beforeEach` the other fixtures use (`h.liveWindows = [];`), and the presence mock becomes:

```ts
vi.mock("../../src/engine/presence", () => ({
  readLiveWindows: () => h.liveWindows,
  defaultWindowsDir: () => "/windows",
}));
```

Then add to `describe("DeckPanel local cards", ...)`:

```ts
  const WS = { identity: "/ws/centaur+e2e.code-workspace", kind: "workspace" as const,
    roots: ["/r/centaur", "/r/automation_e2e"] };

  it("makes one card for two sessions in the same workspace", async () => {
    h.runs = [];
    h.liveWindows = [WS];
    h.openSessions = [sess({ cwd: "/r/centaur", name: "centaur-7e" }),
      sess({ sessionId: "s2", cwd: "/r/automation_e2e", name: "e2e-3a" })];
    show();
    await settled();
    expect(h.buildRunStatus).toHaveBeenCalledTimes(1);
    expect(builtLocal().agents.map((a) => a.session.name).sort()).toEqual(["centaur-7e", "e2e-3a"]);
  });

  it("carries every workspace root, including one with no session in it", async () => {
    h.runs = [];
    h.liveWindows = [WS];
    h.openSessions = [sess({ cwd: "/r/automation_e2e", name: "e2e-3a" })];
    show();
    await settled();
    expect(builtLocal().run.repos.map((r) => r.name)).toEqual(["centaur", "automation_e2e"]);
    expect(builtLocal().run.workspaceFile).toBe("/ws/centaur+e2e.code-workspace");
  });

  it("tags each agent with the root it runs in, not the run's first repo", async () => {
    h.runs = [];
    h.liveWindows = [WS];
    h.openSessions = [sess({ cwd: "/r/automation_e2e", name: "e2e-3a" })];
    show();
    await settled();
    expect(builtLocal().agents.map((a) => a.repo)).toEqual(["automation_e2e"]);
  });

  it("infers the ticket from the first root whose branch names one", async () => {
    // h.branch is the branch of /r/centaur; every other path reads "main".
    h.runs = [];
    h.liveWindows = [WS];
    h.openSessions = [sess({ cwd: "/r/automation_e2e", name: "e2e-3a" })];
    show(true);
    await settled();
    expect(builtLocal().run.url).toContain("/browse/ASM-5641");
  });

  it("still makes a per-place card when the window record has no roots", async () => {
    h.runs = [];
    h.liveWindows = [{ identity: "/ws/centaur+e2e.code-workspace", kind: "workspace" }];
    h.openSessions = [sess({ cwd: "/r/centaur", name: "centaur-7e" })];
    show();
    await settled();
    expect(builtLocal().run.repos.map((r) => r.name)).toEqual(["centaur"]);
    expect(builtLocal().run.workspaceFile).toBeUndefined();
  });

  it("does not fold a root a tracked run already owns into a local card", async () => {
    h.runs = [mkRun({ key: "ASM-1", repos: [{ name: "centaur", path: "/r/centaur", isGit: true, branch: "ASM-1-x" }] })];
    h.liveWindows = [WS];
    h.openSessions = [sess({ cwd: "/r/centaur", name: "centaur-7e" })];
    show();
    await settled();
    // The tracked run claimed the only live place: one card, and it is the tracked one.
    expect(h.buildRunStatus).toHaveBeenCalledTimes(1);
    expect(h.buildRunStatus.mock.calls[0][0].run.key).toBe("ASM-1");
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run test/unit/deckView.test.ts -t "local cards"`
Expected: FAIL — one card per place, `repos` naming only the session's own folder.

- [ ] **Step 3: Rewrite the local-run loop**

At `src/deckView.ts:596`, keep the records:

```ts
    const liveWindows = readLiveWindows(defaultWindowsDir());
    const openIdentities = new Set(liveWindows.map((w) => w.identity));
```

and replace the loop at `src/deckView.ts:634-650`:

```ts
    const cfg = getConfig();
    this.localRuns.clear();
    const locals: Run[] = [];
    const unclaimed = [...places.keys()].filter((place) => !claimed.has(place));
    // A window holding two repos is one place to work, not two: fold its session
    // directories into a single card that names the workspace and carries both
    // roots. Anything a live multi-root window does not list — including a place
    // whose window predates presence roots — stays the per-place card it was.
    for (const group of groupPlacesByWindow(unclaimed, liveWindows)) {
      const gitByRoot = new Map(group.roots.map((root) =>
        [root, { isGit: repoRoot(root) !== "", branch: currentBranch(root) }] as const));
      const git = (root: string) => gitByRoot.get(root) ?? { isGit: false, branch: null };
      // First root whose branch names a ticket wins, so a workspace whose two
      // branches disagree still resolves to one card, the same one every refresh.
      const ticket = group.roots
        .map((root) => inferTicket(git(root).branch, cfg.project, cfg.baseUrl))
        .find((t) => t !== null) ?? null;
      const sessions = group.places.flatMap((place) => places.get(place) ?? []);
      const run = localRunFor(group, sessions, git, ticket, now);
      this.localRuns.set(run.key, run);
      agentsByKey.set(
        run.key,
        group.places.flatMap((place) => (places.get(place) ?? []).map((s) => ({
          session: s,
          activity: readSessionActivity(projectsRoot, s.cwd, s.sessionId, now),
          // The root this session runs in — not repos[0], which on a workspace
          // card is a repo the session may never have touched.
          repo: run.repos.find((r) => r.path === place)?.name,
        }))),
      );
      locals.push(run);
    }
```

Update the import at `src/deckView.ts:24`:

```ts
import { groupPlacesByWindow, inferTicket, localRunFor } from "./engine/localRuns";
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: PASS, including every pre-existing local-card test (they run with `h.liveWindows = []`, which groups nothing).

- [ ] **Step 5: Mutation-check**

Set `repo:` back to `run.repos[0]?.name`, re-run, confirm the agent-tagging test fails; restore. Change the ticket `.find` to take the last hit (`.filter(Boolean).at(-1)`), confirm the inference test fails; restore.

- [ ] **Step 6: Full gates**

Run: `npm run typecheck && npm test && npm run build`
Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git add src/deckView.ts test/unit/deckView.test.ts
git commit -m "feat: a workspace's sessions share one local card"
```

---

### Task 5: The workspace chip

**Files:**
- Modify: `src/webview/DeckApp.tsx:121-136` (next to `RepoChip`), `src/webview/DeckApp.tsx:291-295` (the chip row), `src/webview/deckStyles.ts:189-194` (next to `.c-repos`)
- Test: `test/webview/DeckApp.test.tsx`

**Interfaces:**
- Consumes: `RunStatus.run.workspaceFile` and `RunStatus.repos` — both already on the wire.
- Produces: DOM contract the tests pin — `.c-ws` wrapper, `.ws` toggle button, `.ws-fold` holding one `.repo` per repo.

- [ ] **Step 1: Write the failing tests**

Add to `test/webview/DeckApp.test.tsx`:

```ts
const wsStatus = () => mkStatus({
  run: {
    key: "ASM-9", summary: "e2e flake", url: "https://jira/ASM-9", createdAt: 1,
    mode: "multiroot", workspaceFile: "/ws/centaur+e2e.code-workspace",
    repos: [
      { name: "centaur", path: "/r/centaur", isGit: true, branch: "ASM-9-x" },
      { name: "automation_e2e", path: "/r/automation_e2e", isGit: true, branch: "main" },
    ],
    briefPaths: [],
  },
  repos: [
    { name: "centaur", path: "/r/centaur", branch: "ASM-9-x", dirty: true, ahead: 0, added: 0, removed: 0, files: 0 },
    { name: "automation_e2e", path: "/r/automation_e2e", branch: "main", dirty: false, ahead: 1, added: 12, removed: 2, files: 3 },
  ],
});

describe("workspace chip", () => {
  it("names the workspace and counts its repos", () => {
    const { container } = render(<DeckApp />);
    host(runsMsg([wsStatus()]));
    const chip = container.querySelector(".c-ws .ws")!;
    expect(chip.textContent).toContain("centaur+e2e");
    expect(chip.textContent).toContain("2 repos");
    expect(chip.textContent).not.toContain(".code-workspace");
  });

  it("keeps both repo chips in the fold, with their git signal", () => {
    const { container } = render(<DeckApp />);
    host(runsMsg([wsStatus()]));
    const fold = container.querySelector(".c-ws .ws-fold")!;
    expect(Array.from(fold.querySelectorAll(".repo")).map((r) => r.textContent))
      .toEqual(["centaur●", "automation_e2e+12−2↑1"]);
  });

  it("replaces the flat chip row, so the card says the workspace once", () => {
    const { container } = render(<DeckApp />);
    host(runsMsg([wsStatus()]));
    expect(container.querySelector(".c-repos")).toBeNull();
  });

  it("toggles the fold open for keyboard and touch", () => {
    const { container } = render(<DeckApp />);
    host(runsMsg([wsStatus()]));
    const wrap = container.querySelector(".c-ws")!;
    expect(wrap.className).not.toContain("open");
    fireEvent.click(container.querySelector(".ws")!);
    expect(container.querySelector(".c-ws")!.className).toContain("open");
  });

  it("leaves a single-repo run on the plain chip row", () => {
    const { container } = render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    expect(container.querySelector(".c-ws")).toBeNull();
    expect(container.querySelector(".c-repos .repo")!.textContent).toContain("svc");
  });

  it("leaves a multi-repo run with no workspace file on the plain chip row", () => {
    // Nothing to name: two folders opened side by side are not a workspace.
    const s = wsStatus();
    const { container } = render(<DeckApp />);
    host(runsMsg([{ ...s, run: { ...s.run, workspaceFile: undefined, mode: "per-window" } }]));
    expect(container.querySelector(".c-ws")).toBeNull();
    expect(container.querySelectorAll(".c-repos .repo")).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run test/webview/DeckApp.test.tsx -t "workspace chip"`
Expected: FAIL — no `.c-ws` in the DOM.

- [ ] **Step 3: Add the component**

In `src/webview/DeckApp.tsx`, below `RepoChip`:

```tsx
/** The repos of a multi-root run, behind the workspace that holds them. A card
 * for a two-repo task used to spend a line on chips whose names the workspace
 * already implies; at rest this says the one thing that identifies the task, and
 * hovering it gives back every chip with its own git signal.
 *
 * Hover and focus reveal the fold in CSS, with no state to keep in sync. The
 * click toggle exists for touch and for a keyboard user who tabs past: `.open`
 * survives the pointer leaving, which a :hover rule cannot. */
function WorkspaceChip({ label, repos }: { label: string; repos: RepoGit[] }): JSX.Element {
  const [open, setOpen] = React.useState(false);
  return (
    <div className={`c-ws ${open ? "open" : ""}`}>
      <button type="button" className="ws" onClick={() => setOpen((o) => !o)}
        title="The workspace this task runs in — its repos are underneath">
        <span className="wsi">{open ? "▾" : "▸"}</span>
        <span className="n">{label}</span>
        <span className="ct">{repos.length} repos</span>
      </button>
      <div className="ws-fold">
        {repos.map((g) => <RepoChip key={g.name} g={g} />)}
      </div>
    </div>
  );
}
```

Then replace the chip row at `src/webview/DeckApp.tsx:291-295`:

```tsx
      {(() => {
        const ws = workspaceLabel(r.run);
        if (ws && r.repos.length > 1) return <WorkspaceChip label={ws} repos={r.repos} />;
        return r.repos.length > 0 && (
          <div className="c-repos">
            {r.repos.map((g) => <RepoChip key={g.name} g={g} />)}
          </div>
        );
      })()}
```

- [ ] **Step 4: Add the CSS**

In `src/webview/deckStyles.ts`, after the `.repo` rules:

```
  /* The workspace chip and its fold. The name is an identifier, so it is mono;
     "2 repos" is prose, so it is not. The fold is in the DOM at rest and hidden
     with display:none — a card that has to grow anyway on hover should not also
     pay for a mount. */
  .c-ws { margin-top: 7px; }
  .ws { display: inline-flex; align-items: baseline; gap: 5px; font-size: var(--t-data);
    color: var(--dim); background: none; border: 1px solid var(--hair); border-radius: 3px;
    padding: 1px 6px; cursor: pointer; }
  .ws:hover { border-color: color-mix(in srgb, var(--vscode-foreground) 25%, transparent); }
  .ws .wsi { font-size: 9px; color: color-mix(in srgb, var(--vscode-foreground) 40%, transparent); }
  .ws .n { font-family: var(--mono); color: color-mix(in srgb, var(--vscode-foreground) 82%, transparent); }
  .ws-fold { display: none; margin-top: 6px; flex-wrap: wrap; gap: 5px 7px; }
  .c-ws:hover .ws-fold, .c-ws:focus-within .ws-fold, .c-ws.open .ws-fold { display: flex; }
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/webview/DeckApp.test.tsx`
Expected: PASS — the whole file, not just the new block.

- [ ] **Step 6: Mutation-check**

Change the guard to `r.repos.length > 0`, re-run, confirm the single-repo test fails; restore. Drop `.c-ws.open .ws-fold` from the sheet — the toggle test still passes (it asserts the class, not the computed style, which jsdom does not resolve from the sheet), so also confirm by eye in Step 7 that clicking holds the fold open.

- [ ] **Step 7: See it in the real panel**

Run: `npm run build`, then launch the dev host with VS Code's CLI (the Cursor CLI silently drops the flag):

```bash
code --extensionDevelopmentPath=/Users/oznasi/dev/agent-flow/.claude/worktrees/workspace-card
```

Open the In-flight panel on a two-repo task. Confirm: one chip at rest, hover unfolds both repos, click holds it open, single-repo cards unchanged, and the fold's growth does not overlap the Open/Diff row.

- [ ] **Step 8: Commit**

```bash
git add src/webview/DeckApp.tsx src/webview/deckStyles.ts test/webview/DeckApp.test.tsx
git commit -m "feat: a multi-root card names its workspace and unfolds its repos"
```

---

### Task 6: The branch line follows the agent's repo

**Files:**
- Modify: `src/webview/DeckApp.tsx:284-289`
- Test: `test/webview/DeckApp.test.tsx`

**Interfaces:**
- Consumes: `CardAgent.repo` (already set host-side, and correct per-root as of Task 4).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

```ts
  it("shows the branch of the repo this agent runs in", () => {
    // repos[0] is centaur on ASM-9-x; the agent runs in automation_e2e on main.
    const s = wsStatus();
    const agent: CardAgent = {
      session: { pid: 2, sessionId: "s9", cwd: "/r/automation_e2e", startedAt: 1, name: "e2e-3a" },
      activity: { state: "working", lastActivityMs: 2_000, slug: null },
      repo: "automation_e2e",
    };
    // The board mounts on the Agents lens (DeckApp.tsx:364), so this run renders
    // as one card per agent with no toggling.
    const { container } = render(<DeckApp />);
    host(runsMsg([{ ...s, agents: [agent] }]));
    expect(container.querySelector(".c-branch .bn")!.textContent).toContain("main");
  });

  it("falls back to the run's first repo on a card with no agent", () => {
    const { container } = render(<DeckApp />);
    host(runsMsg([wsStatus()]));
    expect(container.querySelector(".c-branch .bn")!.textContent).toContain("ASM-9-x");
  });
```

- [ ] **Step 2: Run them and watch the first fail**

Run: `npx vitest run test/webview/DeckApp.test.tsx -t "branch"`
Expected: the agent case FAILs with "ASM-9-x" — `repos[0]`'s branch.

- [ ] **Step 3: Read the branch off the agent's repo**

Replace the branch line in `Card`:

```tsx
      {/* The agent's own repo, not repos[0]: on a multi-root card the first repo
          may be one this session never touched. */}
      {(() => {
        const own = agent?.repo ? r.run.repos.find((x) => x.name === agent.repo) : undefined;
        const branch = (own ?? r.run.repos[0])?.branch;
        return branch && <span className="bn" title={branch}>⎇ {branch}</span>;
      })()}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/webview/DeckApp.test.tsx`
Expected: PASS.

- [ ] **Step 5: Mutation-check**

Drop the `own ??`, re-run, confirm the agent case fails; restore.

- [ ] **Step 6: Commit**

```bash
git add src/webview/DeckApp.tsx test/webview/DeckApp.test.tsx
git commit -m "fix: an agent card's branch line names that agent's own repo"
```

---

### Task 7: Gates and coverage

**Files:** whatever the coverage report names.

- [ ] **Step 1: Run every gate**

```bash
npm run typecheck && npm test && npm run test:cov && npm run build
```

- [ ] **Step 2: Close any coverage gap**

If `npm run test:cov` reports an uncovered branch in the code this plan added, write a test that reaches it — do not lower a threshold, and do not add a test that only executes the line without asserting on its effect.

- [ ] **Step 3: Commit if anything changed**

```bash
git commit -am "test: cover the remaining workspace-card branches"
```
