# Deck (In-flight) Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the Deck's "Working" catch-all to "In progress" with the true live state on each card, make `Open` silently focus an already-open window, and refresh the board (summary strip, richer cards, a Forget / Open-in-Jira overflow menu).

**Architecture:** The Deck is a singleton `WebviewPanel` ([src/deckView.ts](../../../src/deckView.ts)) that polls a runs store + git + Jira + Claude transcripts, reconciles them in a pure engine ([src/engine/status.ts](../../../src/engine/status.ts)), and posts `RunStatus[]` to a React webview ([src/webview/DeckApp.tsx](../../../src/webview/DeckApp.tsx)) styled by [src/webview/deckStyles.ts](../../../src/webview/deckStyles.ts). We change the column taxonomy at the type level, add a presence-derived `windowOpen` flag, and rebuild the webview presentation. Live activity inference ([src/engine/transcript.ts](../../../src/engine/transcript.ts)) is untouched.

**Tech Stack:** TypeScript, React (webview), esbuild, Vitest (+ @testing-library/react, jsdom), VS Code extension API.

## Global Constraints

- VS Code engine floor: `^1.90.0`. No new runtime dependencies.
- Webview styling uses VS Code theme CSS variables (`var(--vscode-*)`) — never hard-coded colors — so light/dark themes both work.
- The runs store, presence registry, and Jira reads are all **best-effort**: a filesystem/permission/auth failure must degrade gracefully (empty result), never throw out of a refresh.
- `RunStatus` is shared across the extension host and the webview ([src/types.ts](../../../src/types.ts)); every field must be serializable (postMessage).
- Commit message trailer on every commit: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Run the full suite with `npm test` (Vitest). Type-check with `npm run typecheck`.

## File Structure

- `src/types.ts` — modify: `DeckColumn` member rename; `RunStatus.windowOpen`; `InboundMessage` gains `deck:forget`.
- `src/engine/runs.ts` — modify: add `runTarget(run)` helper (the path `Open` acts on).
- `src/engine/status.ts` — modify: `deriveBucket` returns `progress`; `buildRunStatus` computes `windowOpen` from open window identities.
- `src/deckView.ts` — modify: pass open identities into `buildRunStatus`; silent-focus `Open`; handle `deck:forget`.
- `src/webview/DeckApp.tsx` — modify: status vocabulary, summary strip, pipeline column order + sort, richer cards, `windowOpen` hint, `⋯` overflow menu.
- `src/webview/deckStyles.ts` — modify: styles for the above; `--c-working` → `--c-progress`.
- Tests: `test/unit/engine/status.test.ts`, `test/unit/deckView.test.ts`, `test/webview/DeckApp.test.tsx`, `test/unit/engine/runs.test.ts`.

---

### Task 1: Rename the `working` column to `progress`

Pure taxonomy rename so "In progress" can mean "in flight, not done/review/needs-you" and the card carries the real state. No behavior change beyond the identifier.

**Files:**
- Modify: `src/types.ts` (the `DeckColumn` type)
- Modify: `src/engine/status.ts:25-31` (`deriveBucket`)
- Test: `test/unit/engine/status.test.ts`

**Interfaces:**
- Produces: `type DeckColumn = "progress" | "needs" | "review" | "done"` — every later task and both webview/host consume this.

- [ ] **Step 1: Update the failing tests to the new column name**

In `test/unit/engine/status.test.ts`, replace the three `deriveBucket` cases and the two `buildRunStatus` cases that expect `"working"`:

```ts
  it("keeps a working agent in In-progress even in a review status (live beats review)", () => {
    expect(deriveBucket({ jiraStatus: "In Review", agentState: "working" })).toBe("progress");
  });
```
```ts
  it("keeps a working agent in In-progress even with an open PR", () => {
    expect(deriveBucket({ prOpen: true, agentState: "working" })).toBe("progress");
  });
```
```ts
  it("falls back to In-progress (in-flight) for an idle, plain in-progress task", () => {
    expect(deriveBucket({ jiraCategory: "indeterminate", jiraStatus: "In Progress", agentState: "idle" })).toBe("progress");
  });
```
```ts
  it("falls back to In-progress for an unknown agent with nothing else", () => {
    expect(deriveBucket({ jiraCategory: "new", agentState: "unknown" })).toBe("progress");
  });
```

And in the `buildRunStatus` describe block, change the two `expect(s.column).toBe("working")` assertions (the "combines a live working agent…" and "keeps the git backbone…" tests) to `toBe("progress")`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/status.test.ts`
Expected: FAIL — assertions expect `"progress"` but `deriveBucket` still returns `"working"`.

- [ ] **Step 3: Rename the type member**

In `src/types.ts`, change:
```ts
export type DeckColumn = "working" | "needs" | "review" | "done";
```
to:
```ts
export type DeckColumn = "progress" | "needs" | "review" | "done";
```

- [ ] **Step 4: Update `deriveBucket`**

In `src/engine/status.ts`, the two `working` returns become `progress`:
```ts
export function deriveBucket(i: BucketInput): DeckColumn {
  if (i.jiraCategory === "done") return "done";
  if (i.agentState === "needs-you") return "needs";
  if (i.agentState === "working") return "progress";
  if (i.prOpen || isReviewStatus(i.jiraStatus)) return "review";
  return "progress";
}
```

- [ ] **Step 5: Update the two webview fixtures so the project type-checks**

In `test/unit/deckView.test.ts`, in `statusFor`, change `column: "working"` → `column: "progress"`.
In `test/webview/DeckApp.test.tsx`, in `mkStatus`, change `column: "working"` → `column: "progress"`.
(These fixtures are typed `RunStatus`; leaving `"working"` is now a type error.)

- [ ] **Step 6: Run the affected tests + type-check**

Run: `npx vitest run test/unit/engine/status.test.ts test/unit/deckView.test.ts test/webview/DeckApp.test.tsx && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/engine/status.ts test/unit/engine/status.test.ts test/unit/deckView.test.ts test/webview/DeckApp.test.tsx
git commit -m "refactor: rename Deck 'working' column to 'progress'

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `runTarget` helper + `windowOpen` on `RunStatus`

Add the shared notion of "the path Open acts on," and compute per-run whether that window is currently open (from the presence registry the caller passes in). Keeps `buildRunStatus` pure and testable.

**Files:**
- Modify: `src/engine/runs.ts` (add `runTarget`)
- Modify: `src/types.ts` (`RunStatus.windowOpen`)
- Modify: `src/engine/status.ts` (`buildRunStatus` signature + `windowOpen`)
- Test: `test/unit/engine/runs.test.ts`, `test/unit/engine/status.test.ts`

**Interfaces:**
- Produces: `runTarget(run: Run): string | undefined` — the multi-root `.code-workspace` file, else the first repo path.
- Produces: `buildRunStatus(run, jira, projectsRoot, nowMs, liveSignal?, openIdentities?: ReadonlySet<string>): RunStatus` — `openIdentities` are **canonicalized** window identities; defaults to an empty set.
- Produces: `RunStatus.windowOpen: boolean`.

- [ ] **Step 1: Write the failing test for `runTarget`**

Append to `test/unit/engine/runs.test.ts`:
```ts
import { runTarget } from "../../../src/engine/runs";

describe("runTarget", () => {
  const base = { key: "K-1", summary: "s", url: "u", createdAt: 1, mode: "per-window" as const, briefPaths: [] };

  it("prefers the multi-root workspace file", () => {
    expect(runTarget({ ...base, mode: "multiroot", workspaceFile: "/ws/K-1.code-workspace",
      repos: [{ name: "a", path: "/r/a", isGit: true }] })).toBe("/ws/K-1.code-workspace");
  });

  it("falls back to the first repo path", () => {
    expect(runTarget({ ...base, repos: [{ name: "a", path: "/r/a", isGit: true }] })).toBe("/r/a");
  });

  it("is undefined when there is nothing to open", () => {
    expect(runTarget({ ...base, repos: [] })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/engine/runs.test.ts`
Expected: FAIL — `runTarget` is not exported.

- [ ] **Step 3: Implement `runTarget`**

Append to `src/engine/runs.ts`:
```ts
/** The path the Deck's "Open" acts on for a run: the multi-root workspace file,
 * else the first repo. Undefined when a run somehow has neither. */
export function runTarget(run: Run): string | undefined {
  return run.workspaceFile ?? run.repos[0]?.path;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/unit/engine/runs.test.ts`
Expected: PASS.

- [ ] **Step 5: Add `windowOpen` to `RunStatus`**

In `src/types.ts`, add the field to `RunStatus`:
```ts
export interface RunStatus {
  run: Run;
  column: DeckColumn;
  jiraStatus: string | null;
  jiraCategory: string | null; // "new" | "indeterminate" | "done"
  repos: RepoGit[];
  agent: AgentActivity;
  windowOpen: boolean; // is this run's target window currently open? (from presence)
}
```

- [ ] **Step 6: Write the failing test for `windowOpen`**

In `test/unit/engine/status.test.ts`, add inside the `buildRunStatus` describe block. `repoPath` is the run's single repo (its `runTarget`), so passing its **canonical** path in the set must set `windowOpen`:
```ts
  it("marks windowOpen when the run's target is an open window identity", () => {
    const ids = new Set([fs.realpathSync(repoPath)]);
    const s = buildRunStatus(run, null, projRoot, NOW, true, ids);
    expect(s.windowOpen).toBe(true);
  });

  it("leaves windowOpen false when no identity matches", () => {
    const s = buildRunStatus(run, null, projRoot, NOW, true, new Set(["/somewhere/else"]));
    expect(s.windowOpen).toBe(false);
  });

  it("defaults windowOpen to false when no identities are passed", () => {
    expect(buildRunStatus(run, null, projRoot, NOW, true).windowOpen).toBe(false);
  });
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run test/unit/engine/status.test.ts`
Expected: FAIL — `windowOpen` is `undefined` / not computed.

- [ ] **Step 8: Compute `windowOpen` in `buildRunStatus`**

In `src/engine/status.ts`:

Add at the top with the other imports:
```ts
import * as fs from "fs";
import { runTarget } from "./runs";
```
Add a canonicalize helper near `UNKNOWN_AGENT`:
```ts
/** Resolve symlinks so a run's target compares equal to a presence identity
 * across /var↔/private/var etc. Presence identities are already canonical. */
function canon(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}
```
Change the signature and body:
```ts
export function buildRunStatus(
  run: Run,
  jira: JiraInfo | null,
  projectsRoot: string,
  nowMs: number,
  liveSignal = true,
  openIdentities: ReadonlySet<string> = new Set(),
): RunStatus {
  const repos = run.repos.map((r) => gitState(r.name, r.path));
  const agent = liveSignal
    ? mostActive(run.repos.map((r) => readAgentActivity(projectsRoot, r.path, r.branch ?? null, nowMs)))
    : UNKNOWN_AGENT;
  const column = deriveBucket({
    jiraCategory: jira?.category ?? null,
    jiraStatus: jira?.status ?? null,
    agentState: agent.state,
  });
  const target = runTarget(run);
  const windowOpen = target ? openIdentities.has(canon(target)) : false;
  return { run, column, jiraStatus: jira?.status ?? null, jiraCategory: jira?.category ?? null, repos, agent, windowOpen };
}
```

- [ ] **Step 9: Run tests + type-check**

Run: `npx vitest run test/unit/engine/status.test.ts test/unit/engine/runs.test.ts && npm run typecheck`
Expected: PASS (both webview fixtures still type-check because `windowOpen` is added in Task 3's fixtures — if `npm run typecheck` flags the two fixtures now, add `windowOpen: false` to them here as part of this task).

- [ ] **Step 10: Commit**

```bash
git add src/engine/runs.ts src/types.ts src/engine/status.ts test/unit/engine/runs.test.ts test/unit/engine/status.test.ts
git commit -m "feat: compute windowOpen on RunStatus from the presence registry

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Presence-aware refresh + silent-focus `Open`

Feed live window identities into `buildRunStatus`, and make `Open` silent on success (it already focuses an open window via `open -a`; we just stop toasting so an already-open window is silently focused).

**Files:**
- Modify: `src/deckView.ts` (`buildAll`, `inspect` open branch)
- Test: `test/unit/deckView.test.ts`

**Interfaces:**
- Consumes: `readLiveWindows`, `defaultWindowsDir` from `src/engine/presence`; `buildRunStatus(…, openIdentities)` from Task 2.

- [ ] **Step 1: Update fixtures + mock presence in the deckView test**

In `test/unit/deckView.test.ts`:

Add `windowOpen: false` to the `statusFor` fixture object.

Mock presence so refresh is deterministic (add next to the other `vi.mock` calls):
```ts
vi.mock("../../src/engine/presence", () => ({
  readLiveWindows: () => [],
  defaultWindowsDir: () => "/windows",
}));
```

Update the `deck:setLive` assertion (it now receives a 6th arg, the identity set):
```ts
    expect(h.buildRunStatus).toHaveBeenCalledWith(expect.anything(), null, expect.any(String), expect.any(Number), false, expect.any(Set));
```

- [ ] **Step 2: Write the failing test for silent Open**

Add to the `DeckPanel` describe block:
```ts
  it("opens without a success toast (silent focus)", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:inspect", key: "ASM-1", action: "open" });
    expect(h.openInEditor).toHaveBeenCalledWith("/r/svc");
    const successToast = posts(p).find((m) => m.type === "toast" && m.level === "success");
    expect(successToast).toBeUndefined();
  });

  it("toasts an error when opening fails", async () => {
    h.openInEditor.mockResolvedValueOnce(false);
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:inspect", key: "ASM-1", action: "open" });
    const errorToast = posts(p).find((m) => m.type === "toast" && m.level === "error");
    expect(errorToast).toBeTruthy();
  });
```

- [ ] **Step 3: Run tests to verify the new ones fail**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: FAIL — the current `inspect` posts a `success` toast on open.

- [ ] **Step 4: Wire presence into `buildAll`**

In `src/deckView.ts`, add to the presence import line at the top:
```ts
import { readLiveWindows, defaultWindowsDir } from "./engine/presence";
```
In `buildAll`, build the identity set once and pass it through:
```ts
  private async buildAll(): Promise<RunStatus[]> {
    const runs = readRuns(defaultRunsDir());
    const projectsRoot = path.join(os.homedir(), ".claude", "projects");
    const now = Date.now();
    const authed = await this.auth.isAuthenticated();
    const openIdentities = new Set(readLiveWindows(defaultWindowsDir()).map((w) => w.identity));
    const out: RunStatus[] = [];
    for (const run of runs) {
      const jira = authed ? await this.jiraStatus(run.key) : null;
      out.push(buildRunStatus(run, jira, projectsRoot, now, this.liveSignal, openIdentities));
    }
    return out;
  }
```

- [ ] **Step 5: Make `Open` silent on success**

In `inspect`, replace the success/error toast in the `action === "open"` branch:
```ts
      const ok = await openInEditor(target);
      if (!ok) this.toast("error", `Couldn't open ${key}.`);
      return;
```
(Delete the previous `this.toast(ok ? "success" : "error", …)` line.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/deckView.ts test/unit/deckView.test.ts
git commit -m "feat: presence-aware Deck refresh + silent-focus Open

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `deck:forget` — remove a run from the board

Give the board a way to drop a stale/merged card. The overflow menu (Task 8) will call it; wire the host side first.

**Files:**
- Modify: `src/types.ts` (`InboundMessage`)
- Modify: `src/deckView.ts` (`onMessage`)
- Test: `test/unit/deckView.test.ts`

**Interfaces:**
- Produces: inbound message `{ type: "deck:forget"; key: string }` → host calls `removeRun(defaultRunsDir(), key)` then refreshes.
- Consumes: `removeRun` from `src/engine/runs`.

- [ ] **Step 1: Add the message to the mock + write the failing test**

In `test/unit/deckView.test.ts`, extend the runs mock to expose `removeRun`:
```ts
const h = vi.hoisted(() => ({
  runs: [] as Run[],
  openInEditor: vi.fn(async (_t: string) => true),
  buildRunStatus: vi.fn(),
  removeRun: vi.fn(),
}));
vi.mock("../../src/engine/runs", () => ({
  defaultRunsDir: () => "/runs",
  readRuns: () => h.runs,
  removeRun: h.removeRun,
}));
```
Clear it in `beforeEach`: add `h.removeRun.mockClear();`
Add the test:
```ts
  it("forgets a run and re-posts the board", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:forget", key: "ASM-1" });
    expect(h.removeRun).toHaveBeenCalledWith("/runs", "ASM-1");
    expect(posts(p).some((m) => m.type === "deck:runs")).toBe(true);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: FAIL — `deck:forget` is not a known message; `removeRun` never called. (This is also a type error until Step 3.)

- [ ] **Step 3: Add the message type**

In `src/types.ts`, extend `InboundMessage`'s Deck section:
```ts
  | { type: "deck:setLive"; on: boolean }
  | { type: "deck:inspect"; key: string; action: "open" | "diff"; repo?: string }
  | { type: "deck:forget"; key: string };
```

- [ ] **Step 4: Handle it in the host**

In `src/deckView.ts`, add `removeRun` to the runs import:
```ts
import { readRuns, defaultRunsDir, removeRun } from "./engine/runs";
```
Add a case in `onMessage`:
```ts
      case "deck:forget":
        removeRun(defaultRunsDir(), m.key);
        await this.refresh();
        break;
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run test/unit/deckView.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/deckView.ts test/unit/deckView.test.ts
git commit -m "feat: deck:forget removes a run record from the board

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Card status vocabulary — state-driven dot + text

Replace the `statusLabel`/`.c-live` split with one status line whose text and dot color come from the agent state, so "idle" reads idle and "parked" reads parked.

**Files:**
- Modify: `src/webview/DeckApp.tsx` (`statusLabel` → `stateView`, `Card`, remove `.c-live` block)
- Modify: `src/webview/deckStyles.ts` (dot tone classes)
- Test: `test/webview/DeckApp.test.tsx`

**Interfaces:**
- Produces: `stateView(r: RunStatus, live: boolean): { text: string; tone: "working" | "idle" | "needs" | "parked" | "merged" }` — Task 7's card body reuses it.

- [ ] **Step 1: Update fixtures + the live-toggle test, add status-vocabulary tests**

In `test/webview/DeckApp.test.tsx`, add `windowOpen: false` to the `mkStatus` fixture object.

Replace the live-toggle assertion (the `.c-live` "no live signal" string is gone; the status line now reads "parked"):
```ts
  it("toggles the live signal and falls back to the parked label", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    fireEvent.click(screen.getByText(/Live signal/i));
    expect(sent).toHaveBeenCalledWith({ type: "deck:setLive", on: false });
    expect(screen.getByText(/parked · git \+ Jira only/i)).toBeInTheDocument();
  });
```
Add:
```ts
  it("labels a working agent with elapsed time", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ agent: { state: "working", lastActivityMs: Date.now(), slug: null } })]));
    expect(screen.getByText(/working ·/i)).toBeInTheDocument();
  });

  it("labels a needs-you agent as ended turn", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ column: "needs", agent: { state: "needs-you", lastActivityMs: Date.now(), slug: null } })]));
    expect(screen.getByText(/ended turn/i)).toBeInTheDocument();
  });

  it("labels an idle agent as idle", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ agent: { state: "idle", lastActivityMs: Date.now(), slug: null } })]));
    expect(screen.getByText(/idle ·/i)).toBeInTheDocument();
  });

  it("labels a done run as merged", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ column: "done", jiraCategory: "done", jiraStatus: "Done" })]));
    expect(screen.getByText(/merged/i)).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run test/webview/DeckApp.test.tsx`
Expected: FAIL — "parked"/"ended turn"/"merged" text does not exist yet.

- [ ] **Step 3: Replace `statusLabel` with `stateView` and simplify the card**

In `src/webview/DeckApp.tsx`, delete the `statusLabel` function and add:
```ts
type Tone = "working" | "idle" | "needs" | "parked" | "merged";

function stateView(r: RunStatus, live: boolean): { text: string; tone: Tone } {
  if (r.column === "done") return { text: "merged", tone: "merged" };
  if (!live || r.agent.state === "unknown") return { text: "parked · git + Jira only", tone: "parked" };
  switch (r.agent.state) {
    case "working": return { text: `working · ${timeAgo(r.agent.lastActivityMs)}`, tone: "working" };
    case "needs-you": return { text: `ended turn · ${timeAgo(r.agent.lastActivityMs)}`, tone: "needs" };
    case "idle": return { text: `idle · ${timeAgo(r.agent.lastActivityMs)}`, tone: "idle" };
    default: return { text: "parked · git + Jira only", tone: "parked" };
  }
}
```
In `Card`, replace the `st`/`dotClass`/`backbone` locals and the `<span className="status">` + `<div className="c-live">` blocks with:
```tsx
function Card({ r, live }: { r: RunStatus; live: boolean }): JSX.Element {
  const col = COLUMNS.find((c) => c.id === r.column)!;
  const accent = `var(${col.varName})`;
  const sv = stateView(r, live);

  return (
    <div className={`card ${r.column === "needs" ? "needs" : ""}`} style={{ ["--accent" as any]: accent }}>
      <div className="c-top">
        <span className="key" title="Open the ticket" onClick={() => send({ type: "openExternal", url: r.run.url })}>
          {r.run.key}
        </span>
        <span className={`status tone-${sv.tone}`}>
          <span className={`sdot tone-${sv.tone} ${sv.tone === "working" ? "pulse" : ""}`} />
          {sv.text}
        </span>
      </div>
      <div className="c-title">{r.run.summary}</div>

      <div className="c-repos">{r.repos.map((g) => <RepoChip key={g.name} g={g} />)}</div>

      <div className="c-foot">
        <span className="pill">{r.jiraStatus ?? "—"}</span>
        <div className="actions">
          <span className="act primary" onClick={() => send({ type: "deck:inspect", key: r.run.key, action: "open" })}>Open</span>
          <span className="act" onClick={() => send({ type: "deck:inspect", key: r.run.key, action: "diff" })}>Diff</span>
        </div>
      </div>
    </div>
  );
}
```
(Task 7 adds the branch chip, launched-ago, and window-open hint; Task 8 adds the `⋯` menu.)

- [ ] **Step 4: Add dot tone styles**

In `src/webview/deckStyles.ts`, replace the `.sdot` / `.sdot.pulse` / `.sdot.unknown` rules with tone-driven ones:
```css
  .status { margin-left: auto; display: flex; align-items: center; gap: 6px;
    font-family: var(--mono); font-size: 10.5px; color: var(--vscode-descriptionForeground); }
  .sdot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); flex: none; }
  .sdot.tone-working { background: var(--c-done); }
  .sdot.tone-idle    { background: var(--c-idle); }
  .sdot.tone-needs   { background: var(--c-needs); }
  .sdot.tone-parked, .sdot.tone-merged { background: transparent; border: 1.5px solid var(--vscode-descriptionForeground); }
  .sdot.pulse { animation: pulse 1.7s ease-out infinite; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 var(--c-done); } 70% { box-shadow: 0 0 0 5px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
```
Add the idle accent to `:root` (alongside the existing accents):
```css
    --c-idle: var(--vscode-charts-yellow, #d7a531);
```

- [ ] **Step 5: Run the webview tests + type-check**

Run: `npx vitest run test/webview/DeckApp.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/webview/DeckApp.tsx src/webview/deckStyles.ts test/webview/DeckApp.test.tsx
git commit -m "feat: state-driven Deck card status (working/idle/needs/parked/merged)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Summary strip + pipeline column order + sort

Add the header summary strip, reorder columns to the equal-weight pipeline, sort within a column by recency, and finish the `--c-working` → `--c-progress` rename.

**Files:**
- Modify: `src/webview/DeckApp.tsx` (`COLUMNS`, header, column sort)
- Modify: `src/webview/deckStyles.ts` (summary strip; `--c-working` → `--c-progress`)
- Test: `test/webview/DeckApp.test.tsx`

**Interfaces:**
- Consumes: `RunStatus.column` values `progress | needs | review | done`.

- [ ] **Step 1: Write the failing tests**

In `test/webview/DeckApp.test.tsx` add:
```ts
  it("shows the In progress column label", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    expect(screen.getByText("In progress")).toBeInTheDocument();
  });

  it("shows a summary strip with the total count", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus(), mkStatus({ run: { ...mkStatus().run, key: "ASM-2" } })]));
    expect(screen.getByText(/Total/i)).toBeInTheDocument();
  });

  it("sorts cards in a column by most-recent activity", () => {
    render(<DeckApp />);
    const older = mkStatus({ run: { ...mkStatus().run, key: "OLD-1" }, agent: { state: "idle", lastActivityMs: 100, slug: null } });
    const newer = mkStatus({ run: { ...mkStatus().run, key: "NEW-1" }, agent: { state: "idle", lastActivityMs: 999, slug: null } });
    host(runsMsg([older, newer]));
    const keys = screen.getAllByText(/-1$/).map((el) => el.textContent);
    expect(keys.indexOf("NEW-1")).toBeLessThan(keys.indexOf("OLD-1"));
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/webview/DeckApp.test.tsx`
Expected: FAIL — "In progress"/"Total" text absent; order not guaranteed.

- [ ] **Step 3: Reorder + relabel `COLUMNS`**

In `src/webview/DeckApp.tsx`:
```ts
const COLUMNS: { id: DeckColumn; label: string; varName: string }[] = [
  { id: "progress", label: "In progress", varName: "--c-progress" },
  { id: "needs", label: "Needs you", varName: "--c-needs" },
  { id: "review", label: "In review", varName: "--c-review" },
  { id: "done", label: "Done", varName: "--c-done" },
];
```

- [ ] **Step 4: Replace the header counts with a summary strip**

In the `DeckApp` return, replace the `<div className="counts">…</div>` block with:
```tsx
        <div className="stats">
          <div className="stat"><span className="n">{runs.filter((r) => r.column === "progress").length}</span><span className="l">In progress</span></div>
          <div className={`stat ${needs > 0 ? "alert" : ""}`}><span className="n">{needs}</span><span className="l">Need you</span></div>
          <div className="stat"><span className="n">{runs.filter((r) => r.column === "review").length}</span><span className="l">In review</span></div>
          <div className="stat"><span className="n">{runs.length}</span><span className="l">Total</span></div>
        </div>
```
(`needs` is already computed: `const needs = runs.filter((r) => r.column === "needs").length;`)

- [ ] **Step 5: Sort within each column**

In the board render, change the per-column list:
```tsx
            const list = runs
              .filter((r) => r.column === c.id)
              .sort((a, b) => (b.agent.lastActivityMs ?? 0) - (a.agent.lastActivityMs ?? 0) || b.run.createdAt - a.run.createdAt);
```

- [ ] **Step 6: Style the summary strip + rename the accent var**

In `src/webview/deckStyles.ts`:

Rename the accent variable in `:root`:
```css
    --c-progress: var(--vscode-charts-blue, #4aa3df);
```
(remove the old `--c-working` line.)

Replace the `.hd .counts …` rules with strip styles:
```css
  .stats { display: flex; align-items: stretch; gap: 8px; }
  .stat { display: flex; flex-direction: column; gap: 2px; padding: 4px 12px 5px; border-radius: 8px;
    border: 1px solid var(--hair); background: var(--vscode-editorWidget-background, transparent); min-width: 62px; }
  .stat .n { font-size: 16px; font-weight: 650; font-variant-numeric: tabular-nums; line-height: 1; }
  .stat .l { font-size: 10px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: .05em; }
  .stat.alert { border-color: var(--c-needs); }
  .stat.alert .n { color: var(--c-needs); }
```

- [ ] **Step 7: Run the tests + type-check**

Run: `npx vitest run test/webview/DeckApp.test.tsx && npm run typecheck`
Expected: PASS. (If the older "groups runs into columns" test asserted `/need you/` from the old counts markup, it still matches the strip's "Need you" label.)

- [ ] **Step 8: Commit**

```bash
git add src/webview/DeckApp.tsx src/webview/deckStyles.ts test/webview/DeckApp.test.tsx
git commit -m "feat: Deck summary strip, pipeline columns, recency sort

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Richer cards — branch, launched-ago, and the window-open hint

Add the branch chip and "launched Xago" to the foot, and the subtle inline hint when the run's window is already open.

**Files:**
- Modify: `src/webview/DeckApp.tsx` (`Card`)
- Modify: `src/webview/deckStyles.ts` (chip + hint + foot styles)
- Test: `test/webview/DeckApp.test.tsx`

**Interfaces:**
- Consumes: `RunStatus.windowOpen`, `run.repos[].branch`, `run.createdAt`.

- [ ] **Step 1: Write the failing tests**

Add to `test/webview/DeckApp.test.tsx`:
```ts
  it("shows the branch and a launched-ago time on a card", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    expect(screen.getByText(/ASM-1-x/)).toBeInTheDocument();
    expect(screen.getByText(/launched/i)).toBeInTheDocument();
  });

  it("hints that Open will focus an already-open window", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ windowOpen: true })]));
    expect(screen.getByText(/open now/i)).toBeInTheDocument();
  });

  it("shows no open-now hint when the window is not open", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ windowOpen: false })]));
    expect(screen.queryByText(/open now/i)).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/webview/DeckApp.test.tsx`
Expected: FAIL — branch/launched/open-now not rendered.

- [ ] **Step 3: Add a branch chip, launched-ago, and the hint to `Card`**

In `src/webview/DeckApp.tsx`, in `Card`, insert a branch line above `.c-repos` (a run may have several repos; show the primary branch — the first repo's):
```tsx
      {r.run.repos[0]?.branch && (
        <div className="c-branch">⎇ {r.run.repos[0].branch}</div>
      )}
```
Add the hint just below `.c-repos`:
```tsx
      {r.windowOpen && <div className="c-openhint">open now — Open will focus this window</div>}
```
Add "launched Xago" into the foot, before `.actions`:
```tsx
      <div className="c-foot">
        <span className="pill">{r.jiraStatus ?? "—"}</span>
        <span className="elapsed">launched {timeAgo(r.run.createdAt)}</span>
        <div className="actions">
```

- [ ] **Step 4: Style them**

In `src/webview/deckStyles.ts`, add:
```css
  .c-branch { margin-top: 8px; font-family: var(--mono); font-size: 10px; color: var(--vscode-descriptionForeground); }
  .c-openhint { margin-top: 9px; font-size: 10px; font-family: var(--mono); color: var(--c-done);
    display: inline-flex; align-items: center; gap: 5px; }
  .c-openhint::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--c-done); }
  .elapsed { font-size: 10.5px; color: var(--vscode-descriptionForeground); font-family: var(--mono); }
```

- [ ] **Step 5: Run the tests + type-check**

Run: `npx vitest run test/webview/DeckApp.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/webview/DeckApp.tsx src/webview/deckStyles.ts test/webview/DeckApp.test.tsx
git commit -m "feat: richer Deck cards — branch, launched-ago, open-now hint

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: `⋯` overflow menu — Forget & Open in Jira

Add the per-card overflow menu that clears a run (`deck:forget`) or opens the ticket.

**Files:**
- Modify: `src/webview/DeckApp.tsx` (`Card` menu state + markup)
- Modify: `src/webview/deckStyles.ts` (menu styles)
- Test: `test/webview/DeckApp.test.tsx`

**Interfaces:**
- Produces: emits `{ type: "deck:forget"; key }` and `{ type: "openExternal"; url }` from the menu.

- [ ] **Step 1: Write the failing tests**

Add to `test/webview/DeckApp.test.tsx`:
```ts
  it("forgets a run from the overflow menu", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    fireEvent.click(screen.getByTitle(/more actions/i));
    fireEvent.click(screen.getByText(/^Forget$/));
    expect(sent).toHaveBeenCalledWith({ type: "deck:forget", key: "ASM-1" });
  });

  it("opens the ticket in Jira from the overflow menu", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    fireEvent.click(screen.getByTitle(/more actions/i));
    fireEvent.click(screen.getByText(/Open in Jira/i));
    expect(sent).toHaveBeenCalledWith({ type: "openExternal", url: "https://jira/ASM-1" });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/webview/DeckApp.test.tsx`
Expected: FAIL — no "more actions" control / menu items.

- [ ] **Step 3: Add menu state + markup to `Card`**

In `src/webview/DeckApp.tsx`, at the top of `Card` add state and a close-on-Escape/outside-click effect:
```tsx
  const [menuOpen, setMenuOpen] = React.useState(false);
  React.useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("click", close); window.removeEventListener("keydown", onKey); };
  }, [menuOpen]);
```
Replace the `.actions` block with one that includes the `⋯` button + popover. `stopPropagation` on the toggle so the window-level close listener doesn't immediately re-close it:
```tsx
        <div className="actions">
          <span className="act primary" onClick={() => send({ type: "deck:inspect", key: r.run.key, action: "open" })}>Open</span>
          <span className="act" onClick={() => send({ type: "deck:inspect", key: r.run.key, action: "diff" })}>Diff</span>
          <span className="more-wrap">
            <span className="more" title="More actions" onClick={(e) => { e.stopPropagation(); setMenuOpen((o) => !o); }}>⋯</span>
            {menuOpen && (
              <div className="menu" onClick={(e) => e.stopPropagation()}>
                <div className="mi" onClick={() => { setMenuOpen(false); send({ type: "openExternal", url: r.run.url }); }}>Open in Jira</div>
                <div className="mi danger" onClick={() => { setMenuOpen(false); send({ type: "deck:forget", key: r.run.key }); }}>Forget</div>
              </div>
            )}
          </span>
        </div>
```

- [ ] **Step 4: Style the menu**

In `src/webview/deckStyles.ts`, add:
```css
  .more-wrap { position: relative; display: inline-flex; }
  .more { width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center;
    border-radius: 7px; color: var(--vscode-descriptionForeground); cursor: pointer; }
  .more:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
  .menu { position: absolute; right: 0; bottom: calc(100% + 4px); z-index: 20; min-width: 130px;
    border: 1px solid var(--hair); border-radius: 8px; padding: 4px;
    background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
    box-shadow: 0 8px 24px -10px rgba(0,0,0,.6); }
  .mi { font-size: 12px; padding: 6px 9px; border-radius: 5px; cursor: pointer; color: var(--vscode-foreground); }
  .mi:hover { background: var(--vscode-list-hoverBackground, var(--vscode-toolbar-hoverBackground)); }
  .mi.danger { color: var(--c-needs); }
```

- [ ] **Step 5: Run the full suite + type-check**

Run: `npm test && npm run typecheck`
Expected: PASS (whole suite green).

- [ ] **Step 6: Commit**

```bash
git add src/webview/DeckApp.tsx src/webview/deckStyles.ts test/webview/DeckApp.test.tsx
git commit -m "feat: Deck card overflow menu — Forget & Open in Jira

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Build + visual verification

No new logic — compile the bundle and eyeball the board against the mockup to confirm the "broader rethink" reads right in a real theme.

**Files:** none (verification only)

- [ ] **Step 1: Full suite, coverage, type-check, build**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green; `dist/deck.js` rebuilt with no esbuild errors.

- [ ] **Step 2: Coverage on changed files**

Run: `npm run test:cov`
Expected: `src/engine/status.ts`, `src/engine/runs.ts`, `src/deckView.ts`, `src/webview/DeckApp.tsx` each ≥95% line coverage. If any is short, add the missing-branch test to that file's suite and re-run.

- [ ] **Step 3: Manual smoke in the extension host**

Use the `run` skill (or press F5 / "Run Extension" in VS Code) to launch the Extension Development Host, then:
- Open the Deck via the **Agent Flow: Open the Deck (in-flight)** command (the `$(dashboard)` title icon).
- Verify: the **In progress** column heading (not "Working"); the **summary strip** counts; a card's status line matches its dot color (working=green pulse, idle=amber, needs=red, parked=hollow); toggling **Live signal** off flips every card to `parked · git + Jira only` while cards still spread across In progress / In review / Done.
- Click **Open** on a task whose window is already open → the existing window is focused, no duplicate, no toast (and that card shows the `open now` hint). Click **Open** on a closed task → it opens.
- Open a card's **⋯** menu → **Forget** removes the card on next refresh; **Open in Jira** opens the ticket. Click outside / press Escape → menu closes.

- [ ] **Step 4: Final commit if coverage tests were added**

```bash
git add -A
git commit -m "test: cover Deck polish edge cases

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Status vocabulary (§1) → Tasks 1, 5. ✅
- Column rename + pipeline order (§2, §3) → Tasks 1, 6. ✅
- Summary strip + sort (§3) → Task 6. ✅
- Richer cards (§4) → Task 7. ✅
- `⋯` Forget / Open in Jira (§4) → Tasks 4 (host), 8 (webview). ✅
- Silent-focus Open + `windowOpen` (§5, §6) → Tasks 2, 3, 7. ✅
- Best-effort degradation (Global Constraints) → Task 3 presence set is empty on failure; `windowOpen` false. ✅
- Deferred PR chip → intentionally not implemented. ✅

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every run step gives an exact command + expected result.

**Type consistency:** `DeckColumn = "progress" | …` (Task 1) used by `COLUMNS` (Task 6), fixtures (Tasks 1, 5), and `deriveBucket` (Task 1). `runTarget` (Task 2) consumed by `buildRunStatus` (Task 2). `buildRunStatus(…, openIdentities?)` 6-arg signature (Task 2) matched by the deckView call (Task 3) and the deckView test assertion `expect.any(Set)` (Task 3). `stateView` tones (Task 5) matched by `.sdot.tone-*` CSS (Task 5). `deck:forget` message (Task 4) emitted by the menu (Task 8). `windowOpen` (Task 2) consumed by the hint (Task 7). Consistent.
