# In-flight Session Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the In-flight board show a card only while its work is actually moving, attribute every live Claude Code session to exactly one run, and collapse everything else into a Recently-closed strip that retires itself after 24h.

**Architecture:** Two new pure engine modules — `ownership.ts` decides which single run owns each session and each directory, `visibility.ts` decides whether a run belongs on the board or the strip. `deckView.buildAll` consults both, stamps a `shelf` on every `RunStatus`, and threads it into the existing retire sweep as a new rule. The webview partitions on `shelf` and renders a new `ClosedStrip` between the board and the legend.

**Tech Stack:** TypeScript, React 18 (webview), vitest + @testing-library/react, esbuild, VS Code extension API.

**Spec:** [`docs/superpowers/specs/2026-08-12-inflight-session-cleanup-design.md`](../specs/2026-08-12-inflight-session-cleanup-design.md) — read it before Task 1.

## Global Constraints

Every task's requirements implicitly include this section.

- **Baseline:** branch from `3db28ea` (0.15.0) or later `main`. `main` moves several times a day from parallel sessions — re-check `git log --oneline -1` at the start of each task.
- **Gates — every task must pass all four before its commit:**
  | Command | Catches |
  |---|---|
  | `npm run typecheck` | `tsc --noEmit` clean |
  | `npm test` | vitest, full suite |
  | `npm run test:cov` | coverage thresholds are **enforced** and will fail the task |
  | `npm run build` | the **only** gate that catches an `fs`/`os`/`path`/`child_process` import leaking into a webview bundle. `tsc` and the full test suite both pass regardless. |
- **`src/webview/` must never import `fs`, `os`, `path` or `child_process`, even transitively.** Anything the webview imports from `src/engine/` must import only `../types`.
- **Mutation-check every test you write.** After a test passes, break the implementation line it targets (flip a comparison, return the opposite constant), re-run, and confirm the test *fails*. Restore. A test that passes against a broken implementation is worse than no test. This is called out explicitly per step; do not skip it.
- **Never widen scope.** Do not touch `deriveBucket`, the four board columns, the Review strip, the Orchestrator drawer, or any worktree/branch/commit cleanup.
- **Commit after every task.** Sessions get killed mid-flight; an uncommitted tree is lost work. Verify a partial tree with `npm run typecheck`, never with `grep`.
- **Existing-test breakage is expected in Tasks 4 and 7 only.** If a test outside those tasks starts failing, you have a real regression — do not "fix" the test.

## File Structure

**Create:**
- `src/engine/visibility.ts` — the board-vs-strip rule, plus the shared `landed()` predicate. Imports only `../types`.
- `src/engine/ownership.ts` — one run per session, one run per path. Pure, fs-free.
- `src/webview/ClosedStrip.tsx` — the collapsed/expanded strip.
- `test/unit/engine/visibility.test.ts`, `test/unit/engine/ownership.test.ts`, `test/webview/ClosedStrip.test.tsx`

**Modify:**
- `src/types.ts` — `Run.closedAt?`, `RunStatus.shelf`
- `src/engine/retire.ts` — rule 2b, `stampClosed`/`unstampClosed`, reason `"closed"`; its private `landed` is replaced by the shared one
- `src/deckView.ts` — ownership in the agent-attach loop, `shelf` computation, `applyVerdict`, `verdictFor`, `sweepReviewRuns`
- `src/config.ts` + `package.json` — two settings
- `src/webview/DeckApp.tsx` — partition on `shelf`, render `ClosedStrip`
- `src/webview/deckStyles.ts` — strip CSS
- `README.md`, `CHANGELOG.md`

---

### Task 1: The visibility rule

**Files:**
- Create: `src/engine/visibility.ts`
- Create: `test/unit/engine/visibility.test.ts`
- Modify: `src/engine/retire.ts:38-48` (delete its private `landed`, import the shared one)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  // in src/types.ts, beside DeckColumn:
  export type Shelf = "board" | "closed";
  // in src/engine/visibility.ts:
  export interface VisibilityInput {
    hasLiveSession: boolean;
    prOpen: boolean;
    landed: boolean;
    ticketActive: boolean;
    hasWorkToLose: boolean;
  }
  export function shelfFor(i: VisibilityInput): Shelf;
  export function landed(prs: PrEntryMap, ticketCategory: string | null): boolean;
  ```

- [ ] **Step 1: Declare `Shelf` in `src/types.ts`**

`Shelf` lives in `types.ts` beside `DeckColumn`, **not** in `visibility.ts`. `types.ts` is what every layer already imports, `RunStatus` (Task 4) needs the type, and `visibility.ts` imports `../types` — putting `Shelf` in `visibility.ts` and importing it back into `types.ts` would be a cycle. Directly below `DeckColumn` (line 60):

```ts
/** Where a run sits on the In-flight view: a board column, or the Recently
 * closed strip. Membership only — `DeckColumn` still says which column. */
export type Shelf = "board" | "closed";
```

- [ ] **Step 2: Write the failing test**

Create `test/unit/engine/visibility.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { landed, shelfFor, VisibilityInput } from "../../../src/engine/visibility";
import { PrEntryMap, PrFacts } from "../../../src/types";

const facts = (over: Partial<PrFacts> = {}): PrFacts => ({
  number: 1, url: "https://github.com/o/r/pull/1", title: "t", state: "OPEN", isDraft: false,
  ci: { passing: 1, pending: 0, failing: [] }, review: "none", unresolved: null,
  mergeable: "clean", ciAdvisory: false, ...over,
});
const prs = (...f: (PrFacts | null)[]): PrEntryMap =>
  Object.fromEntries(f.map((x, i) => [`repo${i}`, { facts: x, fetchedAt: 0 }]));

const input = (over: Partial<VisibilityInput> = {}): VisibilityInput => ({
  hasLiveSession: false, prOpen: false, landed: false,
  ticketActive: false, hasWorkToLose: false, ...over,
});

describe("visibility.ts is webview-safe", () => {
  it("imports nothing but ../types, so the browser bundle can include it", () => {
    const src = fs.readFileSync(path.join(__dirname, "../../../src/engine/visibility.ts"), "utf8");
    const specifiers = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(specifiers).toEqual(["../types"]);
  });
});

describe("shelfFor", () => {
  it("closes a run with no signal at all", () => {
    expect(shelfFor(input())).toBe("closed");
  });

  it("keeps a run with a live session on the board", () => {
    expect(shelfFor(input({ hasLiveSession: true }))).toBe("board");
  });

  it("keeps a run with an open PR on the board after its agent closed", () => {
    expect(shelfFor(input({ prOpen: true }))).toBe("board");
  });

  it("keeps landed work on the board so it reaches the Done column", () => {
    expect(shelfFor(input({ landed: true }))).toBe("board");
  });

  it("keeps an active ticket on the board with nothing else going on", () => {
    expect(shelfFor(input({ ticketActive: true }))).toBe("board");
  });

  it("keeps a run with uncommitted or unpushed work on the board", () => {
    expect(shelfFor(input({ hasWorkToLose: true }))).toBe("board");
  });
});

describe("landed", () => {
  it("is false when no PR has been observed at all", () => {
    expect(landed({}, "indeterminate")).toBe(false);
  });

  it("is true when every PR-bearing repo merged", () => {
    expect(landed(prs(facts({ state: "MERGED" }), facts({ state: "MERGED" })), null)).toBe(true);
  });

  it("is false when one repo merged and another is still open", () => {
    expect(landed(prs(facts({ state: "MERGED" }), facts({ state: "OPEN" })), null)).toBe(false);
  });

  it("is true for a done ticket with no PR still open", () => {
    expect(landed(prs(facts({ state: "CLOSED" })), "done")).toBe(true);
  });

  it("is false for a done ticket whose PR is still open", () => {
    expect(landed(prs(facts({ state: "OPEN" })), "done")).toBe(false);
  });

  it("ignores null facts — a repo whose PR was never fetched", () => {
    expect(landed(prs(null), "done")).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/unit/engine/visibility.test.ts`
Expected: FAIL — `Failed to resolve import "../../../src/engine/visibility"`.

- [ ] **Step 4: Write the implementation**

Create `src/engine/visibility.ts`:

```ts
import { PrEntryMap, PrFacts, Shelf } from "../types";

/**
 * Has this run's work landed? Either every PR-bearing repo merged, or the ticket
 * is done and no PR is still open. `state === "OPEN"` deliberately rather than
 * `prSignals().open`, which excludes drafts: a draft PR is unmerged work.
 *
 * Lifted out of retire.ts so the board rule and the retire sweep cannot drift
 * apart — "landed" must mean one thing.
 */
export function landed(prs: PrEntryMap, ticketCategory: string | null): boolean {
  const all = Object.values(prs)
    .map((e) => e.facts)
    .filter((f): f is PrFacts => f !== null);
  if (all.length > 0 && all.every((f) => f.state === "MERGED")) return true;
  return ticketCategory === "done" && !all.some((f) => f.state === "OPEN");
}

/** Every field observable, none required. */
export interface VisibilityInput {
  /** A Claude Code session open in a path this run OWNS. Ownership-scoped on
   * purpose — see the note in retire.ts about why the retire veto is not. */
  hasLiveSession: boolean;
  /** Any PR still OPEN, draft included: a draft is unmerged work in flight. */
  prOpen: boolean;
  /** `landed()` above. */
  landed: boolean;
  /** A ticket run whose category is not "done". */
  ticketActive: boolean;
  /** dirty || ahead > 0, counted on OWNED paths only. Without the ownership
   * scope, one dirty checkout shared by four notepad runs reads as live work on
   * all four and nothing ever leaves the board. */
  hasWorkToLose: boolean;
}

/**
 * Board or strip. Any single signal of live work is enough — this decides
 * *membership* only. `deriveBucket` still decides which of the four columns a
 * board card lands in, and is untouched.
 *
 * `landed` keeps finished work on the board so it sits in Done until the retire
 * sweep's grace window elapses, rather than skipping straight to the strip.
 *
 * Keep this file free of `fs`-touching imports — visibility.test.ts enforces it.
 */
export function shelfFor(i: VisibilityInput): Shelf {
  return i.hasLiveSession || i.prOpen || i.landed || i.ticketActive || i.hasWorkToLose
    ? "board"
    : "closed";
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/unit/engine/visibility.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 6: Mutation-check the tests**

Temporarily change `shelfFor`'s body to `return "board";`. Re-run — at least the "closes a run with no signal at all" test must FAIL. Restore.

Then temporarily change `landed`'s `all.every` to `all.some`. Re-run — "is false when one repo merged and another is still open" must FAIL. Restore.

If either mutation leaves the suite green, the test is vacuous — fix the test, not the implementation.

- [ ] **Step 7: Point retire.ts at the shared `landed`**

In `src/engine/retire.ts`, delete the private `landed` function (currently lines 38-48, the one taking `RetireInput`) and its doc comment, then add the import and update the one call site:

```ts
import { landed } from "./visibility";
```

The call inside `retireVerdict` changes from `landed(i)` to:

```ts
  if (landed(i.prs, i.ticketCategory) && !hasWorkToLose) {
```

`PrFacts` may become an unused import in retire.ts — remove it if `tsc` complains.

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS. `test/unit/engine/retire.test.ts` must be green **without modification** — the extracted `landed` is behaviour-identical. If a retire test fails here, the extraction changed behaviour: re-read both versions rather than editing the test.

- [ ] **Step 9: Gates**

Run: `npm run typecheck && npm test && npm run test:cov && npm run build`
Expected: all four pass.

- [ ] **Step 10: Commit**

```bash
git add src/types.ts src/engine/visibility.ts src/engine/retire.ts test/unit/engine/visibility.test.ts
git commit -m "feat(engine): add the board-vs-strip visibility rule

shelfFor decides whether a run belongs on the In-flight board or in the
Recently-closed strip. retire.ts's private landed() moves here so the board
rule and the retire sweep cannot drift on what 'landed' means."
```

---

### Task 2: Session and path ownership

**Files:**
- Create: `src/engine/ownership.ts`
- Create: `test/unit/engine/ownership.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  ```ts
  export interface OwnedRun { key: string; createdAt: number; paths: string[] }
  export interface OwnershipInput {
    runs: OwnedRun[];
    sessionsByPlace: ReadonlyMap<string, OpenSession[]>;
  }
  export interface Ownership {
    sessionOwner: ReadonlyMap<string, string>;  // sessionId -> run key
    pathOwner: ReadonlyMap<string, string>;     // canonical path -> run key
    runsWithSession: ReadonlySet<string>;       // run keys owning >= 1 session
  }
  export function resolveOwnership(i: OwnershipInput): Ownership;
  ```
  `OwnedRun.paths` are **already canonical** — the caller applies `canon()`. This keeps the module fs-free and testable without a temp directory.

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine/ownership.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { OwnedRun, resolveOwnership } from "../../../src/engine/ownership";
import { OpenSession } from "../../../src/types";

describe("ownership.ts is fs-free", () => {
  it("imports nothing but ../types, so every rule is testable without a temp directory", () => {
    const src = fs.readFileSync(path.join(__dirname, "../../../src/engine/ownership.ts"), "utf8");
    const specifiers = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(specifiers).toEqual(["../types"]);
  });
});

const NOW = 1_700_000_000_000;
const MIN = 60_000;

const run = (key: string, createdAt: number, ...paths: string[]): OwnedRun => ({ key, createdAt, paths });
const sess = (sessionId: string, startedAt: number): OpenSession => ({
  pid: 1, sessionId, cwd: "/w/agent-flow", startedAt, name: null,
});
const places = (m: Record<string, OpenSession[]>) => new Map(Object.entries(m));

describe("resolveOwnership — sessions", () => {
  it("gives a session to the newest run created at or before it started", () => {
    const o = resolveOwnership({
      runs: [
        run("notepad-a", NOW - 90 * MIN, "/w/agent-flow"),
        run("notepad-b", NOW - 30 * MIN, "/w/agent-flow"),
        run("notepad-c", NOW - 5 * MIN, "/w/agent-flow"),
      ],
      sessionsByPlace: places({ "/w/agent-flow": [sess("s1", NOW - 60 * MIN)] }),
    });
    expect(o.sessionOwner.get("s1")).toBe("notepad-a");
  });

  it("renders two sessions in one checkout as two runs, not eight cards", () => {
    // The defect this module exists for: four notepad runs on one directory used
    // to each claim both sessions.
    const o = resolveOwnership({
      runs: [
        run("notepad-a", NOW - 90 * MIN, "/w/agent-flow"),
        run("notepad-b", NOW - 60 * MIN, "/w/agent-flow"),
        run("notepad-c", NOW - 30 * MIN, "/w/agent-flow"),
        run("notepad-d", NOW - 10 * MIN, "/w/agent-flow"),
      ],
      sessionsByPlace: places({
        "/w/agent-flow": [sess("s1", NOW - 45 * MIN), sess("s2", NOW - 5 * MIN)],
      }),
    });
    expect(o.sessionOwner.get("s1")).toBe("notepad-b");
    expect(o.sessionOwner.get("s2")).toBe("notepad-d");
    expect([...o.runsWithSession].sort()).toEqual(["notepad-b", "notepad-d"]);
  });

  it("falls back to the newest run when the session predates every run", () => {
    const o = resolveOwnership({
      runs: [run("a", NOW - 10 * MIN, "/w/x"), run("b", NOW - 5 * MIN, "/w/x")],
      sessionsByPlace: places({ "/w/x": [sess("s1", NOW - 60 * MIN)] }),
    });
    expect(o.sessionOwner.get("s1")).toBe("b");
  });

  it("falls back to the newest run for startedAt: 0, which the reader defaults", () => {
    const o = resolveOwnership({
      runs: [run("a", NOW - 10 * MIN, "/w/x"), run("b", NOW - 5 * MIN, "/w/x")],
      sessionsByPlace: places({ "/w/x": [sess("s1", 0)] }),
    });
    expect(o.sessionOwner.get("s1")).toBe("b");
  });

  it("breaks a createdAt tie on the key, so the board is stable refresh to refresh", () => {
    const o = resolveOwnership({
      runs: [run("zzz", NOW - 10 * MIN, "/w/x"), run("aaa", NOW - 10 * MIN, "/w/x")],
      sessionsByPlace: places({ "/w/x": [sess("s1", NOW)] }),
    });
    expect(o.sessionOwner.get("s1")).toBe("aaa");
  });

  it("leaves a session in a path no run holds unclaimed, so local cards still build", () => {
    const o = resolveOwnership({
      runs: [run("a", NOW - 10 * MIN, "/w/x")],
      sessionsByPlace: places({ "/w/elsewhere": [sess("s1", NOW)] }),
    });
    expect(o.sessionOwner.has("s1")).toBe(false);
    expect(o.runsWithSession.size).toBe(0);
  });

  it("attributes a multi-repo run's session through whichever repo it runs in", () => {
    const o = resolveOwnership({
      runs: [run("ASM-1", NOW - 60 * MIN, "/w/api", "/w/web")],
      sessionsByPlace: places({ "/w/web": [sess("s1", NOW - 30 * MIN)] }),
    });
    expect(o.sessionOwner.get("s1")).toBe("ASM-1");
  });
});

describe("resolveOwnership — paths", () => {
  it("gives a path to the run that owns a live session in it", () => {
    const o = resolveOwnership({
      runs: [run("old", NOW - 90 * MIN, "/w/x"), run("new", NOW - 5 * MIN, "/w/x")],
      sessionsByPlace: places({ "/w/x": [sess("s1", NOW - 60 * MIN)] }),
    });
    // "old" launched the session, so the dirty checkout is attributed to it —
    // not to "new", which merely happens to be the newest record.
    expect(o.pathOwner.get("/w/x")).toBe("old");
  });

  it("gives a session-free path to the newest run holding it", () => {
    const o = resolveOwnership({
      runs: [run("old", NOW - 90 * MIN, "/w/x"), run("new", NOW - 5 * MIN, "/w/x")],
      sessionsByPlace: new Map(),
    });
    expect(o.pathOwner.get("/w/x")).toBe("new");
  });

  it("gives every repo of a sole holder to that run", () => {
    const o = resolveOwnership({
      runs: [run("ASM-1", NOW, "/w/api", "/w/web")],
      sessionsByPlace: new Map(),
    });
    expect(o.pathOwner.get("/w/api")).toBe("ASM-1");
    expect(o.pathOwner.get("/w/web")).toBe("ASM-1");
  });

  it("records no owner for a path no run holds", () => {
    const o = resolveOwnership({ runs: [run("a", NOW, "/w/x")], sessionsByPlace: new Map() });
    expect(o.pathOwner.has("/w/elsewhere")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/engine/ownership.test.ts`
Expected: FAIL — `Failed to resolve import "../../../src/engine/ownership"`.

- [ ] **Step 3: Write the implementation**

Create `src/engine/ownership.ts`:

```ts
import { OpenSession } from "../types";

/** The slice of a run this module needs. `paths` are ALREADY canonical — the
 * caller applies `canon()`, which keeps this module free of `fs` and testable
 * without a temp directory. */
export interface OwnedRun {
  key: string;
  createdAt: number;
  paths: string[];
}

export interface OwnershipInput {
  /** Tracked runs, any order. Local (untracked) runs are built from the places
   * no tracked run claimed, so they never take part in this. */
  runs: OwnedRun[];
  /** `groupByPlace(readOpenSessions(...))` — canonical place -> its sessions,
   * oldest first. */
  sessionsByPlace: ReadonlyMap<string, OpenSession[]>;
}

export interface Ownership {
  /** sessionId -> the one run key that renders it as an agent. */
  sessionOwner: ReadonlyMap<string, string>;
  /** canonical path -> the one run key whose git state it counts toward. */
  pathOwner: ReadonlyMap<string, string>;
  /** Run keys owning at least one live session. */
  runsWithSession: ReadonlySet<string>;
}

/** Newest first; ties break on key ascending so the board is stable across
 * refreshes rather than depending on directory read order. */
function newestFirst(a: OwnedRun, b: OwnedRun): number {
  return b.createdAt - a.createdAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/**
 * Decide, for every live session and every directory, which single run owns it.
 *
 * Notepad and Explore runs launch in place rather than in a worktree, so several
 * records point at one checkout. Before this, `buildAll` attached every session
 * in a directory to every run holding it: two agents in one repo with four
 * notepad runs rendered as eight cards.
 *
 * A session goes to the newest run created at or before it started — the run
 * that plausibly launched it. If none qualifies (the session predates every run,
 * or `readOpenSessions` defaulted a missing `startedAt` to 0), the newest run
 * holding the place takes it.
 *
 * A path goes to whichever run claimed a live session in it, and only failing
 * that to the newest run holding it. Session first, because the run someone is
 * actually working in is the one whose card should carry that directory's dirty
 * state — not whichever record happens to be newest.
 *
 * Pure. No filesystem access; `paths` arrive canonical.
 */
export function resolveOwnership(i: OwnershipInput): Ownership {
  const byPath = new Map<string, OwnedRun[]>();
  for (const run of i.runs) {
    for (const p of run.paths) {
      const list = byPath.get(p);
      if (list) list.push(run);
      else byPath.set(p, [run]);
    }
  }
  for (const list of byPath.values()) list.sort(newestFirst);

  const sessionOwner = new Map<string, string>();
  const runsWithSession = new Set<string>();
  for (const [place, sessions] of i.sessionsByPlace) {
    const holders = byPath.get(place);
    if (!holders) continue; // nobody tracked holds it — it becomes a local card
    for (const s of sessions) {
      const owner = holders.find((r) => r.createdAt <= s.startedAt) ?? holders[0];
      sessionOwner.set(s.sessionId, owner.key);
      runsWithSession.add(owner.key);
    }
  }

  const pathOwner = new Map<string, string>();
  for (const [p, holders] of byPath) {
    // Sessions arrive oldest first, so a place with two sessions owned by
    // different runs resolves to the older session's owner — deterministic, and
    // the run that has been working there longest.
    const viaSession = (i.sessionsByPlace.get(p) ?? [])
      .map((s) => sessionOwner.get(s.sessionId))
      .find((k): k is string => k !== undefined);
    pathOwner.set(p, viaSession ?? holders[0].key);
  }

  return { sessionOwner, pathOwner, runsWithSession };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/engine/ownership.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Mutation-check the tests**

1. Change `holders.find((r) => r.createdAt <= s.startedAt) ?? holders[0]` to just `holders[0]`. Re-run — "gives a session to the newest run created at or before it started" and the four-notepad-runs test must FAIL. Restore.
2. Change `newestFirst`'s tie-break to `0`. Re-run — the tie-break test must FAIL. (If it passes by luck of `Array.prototype.sort` stability, reverse the two runs in that test's array and confirm it still passes — the assertion must hold both ways.) Restore.
3. Change `viaSession ?? holders[0].key` to `holders[0].key`. Re-run — "gives a path to the run that owns a live session in it" must FAIL. Restore.

- [ ] **Step 6: Gates**

Run: `npm run typecheck && npm test && npm run test:cov && npm run build`
Expected: all four pass. Nothing imports this module yet, so no existing test may change.

- [ ] **Step 7: Commit**

```bash
git add src/engine/ownership.ts test/unit/engine/ownership.test.ts
git commit -m "feat(engine): attribute each session and path to exactly one run

Notepad and Explore runs launch in place, so several records point at one
checkout and every one of them used to claim every session in it. resolveOwnership
picks a single owner per session and per path."
```

---

### Task 3: Kill the duplicate cards

**Files:**
- Modify: `src/deckView.ts:2086-2109` (the agent-attach loop) and its imports
- Modify: `test/unit/deckView.test.ts` (add cases; change none)

**Interfaces:**
- Consumes: `resolveOwnership`, `OwnedRun`, `Ownership` from Task 2.
- Produces: a local `ownership` binding inside `buildAll`, in scope for Task 4.

- [ ] **Step 1: Read the current loop**

Read `src/deckView.ts:2080-2115`. The loop attaches `places.get(place)` to every run holding `place`. Note that `allPlaces` is read unconditionally while `places` is gated on `this.openAgents` — that distinction is load-bearing and Task 4 depends on it.

- [ ] **Step 2: Write the failing test**

`buildRunStatus` is **mocked** in this suite, so agent assertions go through what `buildAll` *passed* it — the file's existing `builtFor(key)` helper (line ~537) returns the last input for a run key. Add this describe block near the other open-agents tests, using the file's existing `mkRun`, `sess`, `h.runs`, `h.openSessions` and `openPanel()` helpers:

```ts
describe("session ownership — one agent, one card", () => {
  const NOW = Date.now();
  const MIN = 60_000;
  // Four notepad runs launched in place, all on one checkout. This is the real
  // shape: two live agents used to render as 4 x 2 = 8 cards.
  const notepad = (key: string, createdAt: number): Run =>
    mkRun({ key, kind: "notepad", url: "", createdAt, summary: key,
      repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "main" }] });

  beforeEach(() => {
    h.runs = [
      notepad("notepad-a", NOW - 90 * MIN),
      notepad("notepad-b", NOW - 60 * MIN),
      notepad("notepad-c", NOW - 30 * MIN),
      notepad("notepad-d", NOW - 10 * MIN),
    ];
    h.openSessions = [
      sess({ sessionId: "s1", cwd: "/r/svc", startedAt: NOW - 45 * MIN }),
      sess({ sessionId: "s2", cwd: "/r/svc", startedAt: NOW - 5 * MIN }),
    ];
  });

  it("attaches each session exactly once across every run sharing the checkout", async () => {
    await openPanel();
    const attached = ["notepad-a", "notepad-b", "notepad-c", "notepad-d"]
      .flatMap((k) => builtFor(k).agents.map((a) => a.session.sessionId));
    expect(attached.sort()).toEqual(["s1", "s2"]);
  });

  it("gives each session to the newest run created at or before it started", async () => {
    await openPanel();
    expect(builtFor("notepad-b").agents.map((a) => a.session.sessionId)).toEqual(["s1"]);
    expect(builtFor("notepad-d").agents.map((a) => a.session.sessionId)).toEqual(["s2"]);
    expect(builtFor("notepad-a").agents).toEqual([]);
    expect(builtFor("notepad-c").agents).toEqual([]);
  });

  it("still claims the place, so it does not also become a local card", async () => {
    await openPanel();
    // builtLocal() throws / returns undefined when no local run was built —
    // the place belongs to a tracked run, ownership or not.
    const localCalls = h.buildRunStatus.mock.calls
      .map((c) => c[0] as { run: Run }).filter((i) => i.run.kind === "local");
    expect(localCalls).toEqual([]);
  });
});
```

`openPanel()` is this file's own helper for mounting the panel and awaiting the refresh — confirm its exact name with `grep -n "openPanel\|const show" test/unit/deckView.test.ts` and use whatever the neighbouring `describe` blocks use. Do **not** copy fixtures from Task 2, which tests the pure module without going through `deckView`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: FAIL — the first test reports 8 attached sessions where 2 were expected.

- [ ] **Step 4: Implement**

Add the import at the top of `src/deckView.ts`:

```ts
import { OwnedRun, resolveOwnership } from "./engine/ownership";
```

In `buildAll`, immediately after `const livePlaces = new Set(allPlaces.keys());`, insert:

```ts
    // Ownership is resolved from `allPlaces`, NOT `places`: `openAgents` is a
    // display toggle, and a run whose agents are merely hidden must not read as
    // a run with nobody working in it. Task 4's shelf rule depends on this.
    const ownedRuns: OwnedRun[] = tracked.map((r) => ({
      key: r.key,
      createdAt: r.createdAt,
      paths: r.repos.map((repo) => canon(repo.path)),
    }));
    const ownership = resolveOwnership({ runs: ownedRuns, sessionsByPlace: allPlaces });
```

Then, in the attach loop, skip any session this run does not own:

```ts
        for (const s of sessions) {
          // One session, one card. Several runs can hold the same in-place
          // checkout; only its owner renders it as an agent.
          if (ownership.sessionOwner.get(s.sessionId) !== run.key) continue;
          mine.push({
            session: s,
            // Addressed by sessionId, so two sessions in one worktree report
            // their own states rather than sharing the newest transcript's.
            activity: readSessionActivity(projectsRoot, s.cwd, s.sessionId, now),
            repo: repo.name,
          });
        }
```

**Leave `claimed.add(place)` exactly where it is, above the loop.** It marks a place as belonging to *some* tracked run so local-run building skips it. Moving it inside the ownership check would resurrect a place as a duplicate local card the moment a non-owner run was the only one iterating it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: PASS, including every pre-existing test in the file **unmodified**. A pre-existing failure here means the `claimed` placement changed — re-read Step 4.

- [ ] **Step 6: Mutation-check**

Delete the `if (ownership.sessionOwner.get(...)) continue;` line. Re-run — both new tests must FAIL. Restore.

- [ ] **Step 7: Gates**

Run: `npm run typecheck && npm test && npm run test:cov && npm run build`

- [ ] **Step 8: Commit**

```bash
git add src/deckView.ts test/unit/deckView.test.ts
git commit -m "fix(deck): render one card per agent, not one per run holding its directory

Four notepad runs launched in the same checkout turned two live agents into
eight cards. Each session now attaches only to the run that owns it."
```

---

### Task 4: Shelf every run, and the two settings

**Files:**
- Modify: `src/types.ts` (`Run.closedAt?`, `RunStatus.shelf`)
- Modify: `src/config.ts:270-310` (interface) and `:520-540` (getConfig)
- Modify: `package.json` (`contributes.configuration.properties`)
- Modify: `src/deckView.ts` (`buildAll` — compute and attach `shelf`)
- Modify: `README.md` (settings table, ~line 400)
- Modify: `test/unit/config.test.ts`, `test/unit/deckView.test.ts`

**Interfaces:**
- Consumes: `shelfFor`, `landed`, `Shelf` (Task 1); `ownership` (Task 3).
- Produces: `RunStatus.shelf: Shelf` on every status `buildAll` returns, and `cfg.inflightShowAll` / `cfg.retireClosedAfterHours`.

- [ ] **Step 1: Add the types**

In `src/types.ts`, add to `Run` directly below `finishedAt`:

```ts
  /** When this run was first observed to have no live work left — no agent of its
   * own open, no PR, no active ticket, nothing uncommitted or unpushed. Stamped by
   * the Deck's retire sweep and cleared again the moment any of that comes back, so
   * the Recently-closed window survives a panel reload. Absent on every record
   * written before this field existed, and on every run still on the board. */
  closedAt?: number;
```

Add to `RunStatus`, below `inferredTicketKey`:

```ts
  /** Board or Recently-closed strip. Computed host-side because the rule needs
   * path ownership, which needs canonical paths and therefore `fs`. */
  shelf: Shelf;
```

and import the type: `import { Shelf } from "./engine/visibility";` — **check first** whether `src/types.ts` already imports from `src/engine/`. It must not: `engine/visibility.ts` imports `../types`, and a mutual import is a cycle. If it does not, **declare `Shelf` in `types.ts` instead** and have `visibility.ts` import it from there, matching how `DeckColumn` already lives in `types.ts`. Update Task 1's `visibility.ts` accordingly and re-run its test.

- [ ] **Step 2: Write the failing config test**

In `test/unit/config.test.ts`, inside `describe("package.json ⇄ config constants")`:

```ts
  it("declares inflightShowAll defaulting to false and retireClosedAfterHours to 24", () => {
    expect(props["agentFlow.inflightShowAll"].default).toBe(false);
    const closed = props["agentFlow.retireClosedAfterHours"] as { default?: unknown; minimum?: unknown };
    expect(closed.default).toBe(24);
    expect(closed.minimum).toBe(0);
  });
```

Also update the existing `getConfig — defaults` test ("applies the documented defaults when nothing is configured", ~line 46) to include `inflightShowAll: false` and `retireClosedAfterHours: 24`. **This is one of the two tasks where changing an existing test is expected.**

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/unit/config.test.ts`
Expected: FAIL — `Cannot read properties of undefined (reading 'default')`.

- [ ] **Step 4: Add the settings**

In `package.json`, directly after the `agentFlow.retireAbandonedAfterDays` entry:

```json
        "agentFlow.retireClosedAfterHours": {
          "type": "number",
          "default": 24,
          "minimum": 0,
          "markdownDescription": "How long a closed run stays in the In-flight board's **Recently closed** strip — no agent of its own open, no pull request, no active ticket, and nothing uncommitted or unpushed. When the window elapses the run record is deleted (never the worktree, branch, or commits). `0` retires it as soon as it closes."
        },
        "agentFlow.inflightShowAll": {
          "type": "boolean",
          "default": false,
          "markdownDescription": "Show **every** run record on the In-flight board, the way Agent Flow Deck did before the Recently closed strip existed — nothing is moved off the board and nothing is retired for being closed. Leave this off unless you used stale cards as a to-do list."
        },
```

In `src/config.ts`, add to the `AgentFlowConfig` interface beside the other retire fields:

```ts
  // How long a closed run stays in the Recently closed strip before its record
  // is deleted. 0 retires on sight.
  retireClosedAfterHours: number;
  // Show every run record on the board, pre-strip behaviour. The escape hatch.
  inflightShowAll: boolean;
```

and to `getConfig()`, beside the other retire reads:

```ts
    retireClosedAfterHours: Math.max(0, c.get<number>("retireClosedAfterHours") ?? 24),
    inflightShowAll: c.get<boolean>("inflightShowAll") ?? false,
```

In `README.md`'s settings table, directly after the `agentFlow.retireFinishedAfterHours` row:

```markdown
| `agentFlow.retireClosedAfterHours` | `24` | How long a closed run stays in the board's **Recently closed** strip before its record is deleted. `0` retires on sight. |
| `agentFlow.inflightShowAll` | `false` | Show every run record on the board, the way it worked before the Recently closed strip. |
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/unit/config.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing shelf test**

`shelf` is attached by `deckView` *after* the mocked `buildRunStatus` returns, so it is only visible on the real posted message — use the file's existing `lastRunsPost()` helper, not `builtFor()`. Two fixture helpers need updating first:

- `statusFor` (line ~463) gains `shelf: "board" as const` — `RunStatus` now requires it. **This is an expected existing-test change.**
- The `getConfig` mock (line ~400) gains `inflightShowAll: h.inflightShowAll` and `retireClosedAfterHours: actual.getConfig().retireClosedAfterHours`, plus `inflightShowAll: false as boolean` in the `vi.hoisted` block and `h.inflightShowAll = false;` in `beforeEach`, matching how `h.openAgents` is already steered.

```ts
describe("shelf", () => {
  const NOW = Date.now();
  const MIN = 60_000;
  const shelfOf = (key: string) => lastRunsPost().runs.find((r) => r.run.key === key)?.shelf;
  const notepad = (key: string, createdAt: number): Run =>
    mkRun({ key, kind: "notepad", url: "", createdAt, summary: key,
      repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "main" }] });

  it("keeps an active ticket run on the board with no agent and no PR", async () => {
    h.runs = [mkRun()]; // mkRun's url is a real Jira url, so isTicketRun is true
    await openPanel();
    expect(shelfOf("ASM-1")).toBe("board");
  });

  it("closes a notepad run with no agent, no PR and a clean tree", async () => {
    h.runs = [notepad("notepad-a", NOW - 90 * MIN)];
    h.openSessions = [];
    await openPanel();
    expect(shelfOf("notepad-a")).toBe("closed");
  });

  it("keeps a notepad run with a live agent on the board", async () => {
    h.runs = [notepad("notepad-a", NOW - 90 * MIN)];
    h.openSessions = [sess({ sessionId: "s1", cwd: "/r/svc", startedAt: NOW - 10 * MIN })];
    await openPanel();
    expect(shelfOf("notepad-a")).toBe("board");
  });

  it("counts a shared checkout's dirty state only for the run that owns it", async () => {
    // Without path ownership this one dirty tree reads as work to lose on BOTH
    // runs and neither ever leaves the board — the defect this exists for.
    h.runs = [notepad("notepad-old", NOW - 90 * MIN), notepad("notepad-new", NOW - 10 * MIN)];
    h.openSessions = [];
    h.buildRunStatus.mockReset().mockImplementation((i: { run: Run; ticket: { category: string | null } | null }) => ({
      ...statusFor(i.run, i.ticket?.category ?? null),
      repos: [{ name: "svc", path: "/r/svc", branch: "main", dirty: true, ahead: 0, added: 1, removed: 0, files: 1 }],
    }));
    await openPanel();
    expect(shelfOf("notepad-new")).toBe("board");   // newest holder owns the path
    expect(shelfOf("notepad-old")).toBe("closed");
  });

  it("does not close a run merely because openAgents hides its agents", async () => {
    // openAgents is a DISPLAY toggle. Ownership reads allPlaces regardless, so a
    // run with somebody working in it must not shelve as closed.
    h.openAgents = false;
    h.runs = [notepad("notepad-a", NOW - 90 * MIN)];
    h.openSessions = [sess({ sessionId: "s1", cwd: "/r/svc", startedAt: NOW - 10 * MIN })];
    await openPanel();
    expect(shelfOf("notepad-a")).toBe("board");
  });

  it("keeps every run on the board when inflightShowAll is on", async () => {
    h.inflightShowAll = true;
    h.runs = [notepad("notepad-a", NOW - 90 * MIN)];
    h.openSessions = [];
    await openPanel();
    expect(shelfOf("notepad-a")).toBe("board");
  });
});
```

- [ ] **Step 7: Run to verify it fails**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: FAIL — `shelf` is `undefined`.

- [ ] **Step 8: Implement the shelf computation**

In `src/deckView.ts`, add the imports:

```ts
import { landed, shelfFor } from "./engine/visibility";
```

In `buildAll`, replace the `out.push(status)` at the end of the tracked-run loop (currently line 2271, after the `verdictFor` calls) with a shelved status. Insert directly above it:

```ts
      // Which shelf this run sits on. `hasLiveSession` comes from `ownership`
      // rather than `status.agents`, because `agents` is gated on the openAgents
      // display toggle and a hidden agent is still an agent.
      const ownsPath = (p: string) => ownership.pathOwner.get(canon(p)) === run.key;
      const shelf = getConfig().inflightShowAll ? "board" : shelfFor({
        hasLiveSession: ownership.runsWithSession.has(run.key),
        prOpen: Object.values(status.prs).some((e) => e.facts?.state === "OPEN"),
        landed: landed(status.prs, status.ticketCategory),
        ticketActive: isTicketRun(run) && status.ticketCategory !== "done",
        hasWorkToLose: status.repos.some((r) => ownsPath(r.path) && (r.dirty || r.ahead > 0)),
      });
      out.push({ ...status, shelf });
```

A **local** run returns earlier in the loop (the `runKind(run) === "local"` branch at line 2258). Give it `shelf: "board"` there — a local card exists only because a session is open in it, so it is on the board by construction:

```ts
        out.push(run.url
          ? { ...status, shelf: "board" as const, inferredTicketKey: ticketKeyFor(run, this.connector) }
          : { ...status, shelf: "board" as const });
```

`isTicketRun` is already imported in `deckView.ts`; confirm with `grep -n "isTicketRun" src/deckView.ts` and add it to the `../types` import if not.

- [ ] **Step 9: Run to verify it passes**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: PASS.

- [ ] **Step 10: Mutation-check**

1. Change `hasLiveSession` to `false`. Re-run — the openAgents test must FAIL. Restore.
2. Change `ownsPath(r.path) && (...)` to just `(...)`. Re-run — the shared-dirty-checkout test must FAIL. Restore.
3. Change `getConfig().inflightShowAll ? "board" : ...` to always take the `shelfFor` branch. Re-run — the `inflightShowAll` test must FAIL. Restore.

- [ ] **Step 11: Gates**

Run: `npm run typecheck && npm test && npm run test:cov && npm run build`
Expected: pass. `tsc` will flag every place that constructs a `RunStatus` without `shelf` — fix each by supplying the value, never by making the field optional.

- [ ] **Step 12: Commit**

```bash
git add src/types.ts src/config.ts src/deckView.ts package.json README.md test/unit/config.test.ts test/unit/deckView.test.ts
git commit -m "feat(deck): shelf every run as board or closed

Adds RunStatus.shelf, Run.closedAt, and the two settings that govern them:
agentFlow.retireClosedAfterHours (24) and agentFlow.inflightShowAll (off)."
```

---

### Task 5: Retire rule 2b

**Files:**
- Modify: `src/engine/retire.ts`
- Modify: `src/deckView.ts:2279-2300` (`applyVerdict`), `:2331-2350` (`verdictFor`), `:2376-2396` (`reviewVerdictFor`)
- Modify: `test/unit/engine/retire.test.ts`

**Interfaces:**
- Consumes: `Shelf` (Task 1), `cfg.retireClosedAfterHours` and `RunStatus.shelf` (Task 4).
- Produces: `RetireVerdict` gains `{ action: "stampClosed"; closedAt: number }` and `{ action: "unstampClosed" }`; `RetireReason` gains `"closed"`; `RetireInput` gains `shelf: Shelf` and `closedAfterMs: number`.

- [ ] **Step 1: Write the failing tests**

In `test/unit/engine/retire.test.ts`, extend the `input` helper with the two new fields (`shelf: "board"`, `closedAfterMs: 24 * HOUR`) and add:

```ts
describe("rule 2b — closed", () => {
  it("stamps closedAt the first time a run shelves as closed", () => {
    expect(retireVerdict(input({ shelf: "closed" })))
      .toEqual({ action: "stampClosed", closedAt: NOW });
  });

  it("keeps a stamped run until its window elapses", () => {
    expect(retireVerdict(input({ shelf: "closed", run: run({ closedAt: NOW - 1 * HOUR }) })))
      .toEqual({ action: "keep" });
  });

  it("retires once the window elapses", () => {
    expect(retireVerdict(input({ shelf: "closed", run: run({ closedAt: NOW - 25 * HOUR }) })))
      .toEqual({ action: "retire", reason: "closed" });
  });

  it("retires on sight when the window is zero", () => {
    expect(retireVerdict(input({ shelf: "closed", closedAfterMs: 0 })))
      .toEqual({ action: "retire", reason: "closed" });
  });

  it("unstamps a run that came back to the board", () => {
    expect(retireVerdict(input({ shelf: "board", run: run({ closedAt: NOW - 1 * HOUR }) })))
      .toEqual({ action: "unstampClosed" });
  });

  it("never fires for a run with uncommitted work, however long it has been closed", () => {
    // The veto is the safety property: a record is the only pointer to its worktree.
    expect(retireVerdict(input({
      shelf: "closed", run: run({ closedAt: NOW - 40 * HOUR }), repos: [repo({ dirty: true })],
    }))).toEqual({ action: "keep" });
  });

  it("never fires for a run with unpushed commits", () => {
    expect(retireVerdict(input({
      shelf: "closed", run: run({ closedAt: NOW - 40 * HOUR }), repos: [repo({ ahead: 2 })],
    }))).toEqual({ action: "keep" });
  });

  it("keeps a non-owner run with somebody working in its directory", () => {
    // shelf is ownership-scoped (one card per agent); the retire veto is not
    // (never delete a record out from under a live session). Both hold at once:
    // the run sits in the strip and refuses to retire.
    expect(retireVerdict(input({
      shelf: "closed", hasLiveSession: true, run: run({ closedAt: NOW - 40 * HOUR }),
    }))).toEqual({ action: "unstamp" });
  });

  it("lets rule 2 win for landed work, which belongs in Done not the strip", () => {
    expect(retireVerdict(input({
      shelf: "board", prs: prs(facts({ state: "MERGED" })), finishedAfterMs: 24 * HOUR,
    }))).toEqual({ action: "stamp", finishedAt: NOW });
  });
});
```

Note the eighth test's expectation: the live-session veto sits above every rule and, because that run carries a `closedAt` and no `finishedAt`, it returns `unstamp`… **which is wrong** — `unstamp` clears `finishedAt`, not `closedAt`. Step 3 resolves this; write the test asserting `{ action: "unstampClosed" }` and let it drive the fix.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/unit/engine/retire.test.ts`
Expected: FAIL — `shelf` is not a known property of `RetireInput`; `stampClosed` never returned.

- [ ] **Step 3: Implement**

In `src/engine/retire.ts`:

```ts
import { Shelf, landed } from "./visibility";

export type RetireReason = "unreachable" | "finished" | "abandoned" | "closed";

export type RetireVerdict =
  | { action: "keep" }
  | { action: "stamp"; finishedAt: number }
  | { action: "unstamp" }
  | { action: "stampClosed"; closedAt: number }
  | { action: "unstampClosed" }
  | { action: "retire"; reason: RetireReason };
```

Add to `RetireInput`:

```ts
  /** Which shelf the board put this run on. Passed in rather than recomputed, so
   * exactly one place decides what "closed" means. Always "board" for a review
   * run, which never renders a card and keeps its pre-existing rules. */
  shelf: Shelf;
  /** `agentFlow.retireClosedAfterHours` in ms. 0 retires on sight. */
  closedAfterMs: number;
```

Inside `retireVerdict`, add alongside the existing `stamped`:

```ts
  const closedStamp = typeof i.run.closedAt === "number" ? i.run.closedAt : null;
```

Extend the live-session veto so it clears whichever stamp is set — `finishedAt` first, since rule 2 outranks 2b:

```ts
  // Somebody is working in here. Clear any stamp: a window that started while
  // the run sat idle should not keep running once you reopen an agent in it.
  if (i.hasLiveSession) {
    if (stamped !== null) return { action: "unstamp" };
    if (closedStamp !== null) return { action: "unstampClosed" };
    return { action: "keep" };
  }
```

Then insert rule 2b **after** rule 2's `unstamp` line and **before** rule 3:

```ts
  // Rule 2b — closed. No agent of its own, no PR, no active ticket, nothing to
  // lose. The dirty/ahead veto below rule 2 already guarantees `hasWorkToLose`
  // is false whenever the board shelved this run as closed, but the test is
  // repeated here rather than assumed: the two rules must not be coupled by an
  // invariant that lives in another file.
  if (i.shelf === "closed" && !hasWorkToLose) {
    if (i.closedAfterMs <= 0) return { action: "retire", reason: "closed" };
    if (closedStamp === null) return { action: "stampClosed", closedAt: i.nowMs };
    if (i.nowMs - closedStamp >= i.closedAfterMs) return { action: "retire", reason: "closed" };
    return { action: "keep" };
  }
  // Back on the board: the window restarts from scratch next time.
  if (closedStamp !== null) return { action: "unstampClosed" };
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/unit/engine/retire.test.ts`
Expected: PASS, including every pre-existing test in the file — they all pass `shelf: "board"` through the updated `input` helper, so rules 1, 2 and 3 behave exactly as before.

- [ ] **Step 5: Mutation-check**

1. Change `i.nowMs - closedStamp >= i.closedAfterMs` to `>`. Re-run — with the boundary values used, confirm at least one test fails; if none does, add a test at exactly `NOW - 24 * HOUR` that asserts `retire`. Restore.
2. Delete `&& !hasWorkToLose` from rule 2b. Re-run — both veto tests must FAIL. Restore.
3. Move rule 2b **above** rule 2. Re-run — the "lets rule 2 win for landed work" test must FAIL. Restore.

- [ ] **Step 6: Wire the verdict into deckView**

In `applyVerdict`, add two cases beside `stamp`/`unstamp`:

```ts
      case "stampClosed":
        writeRun(dir, { ...run, closedAt: v.closedAt });
        return false;
      case "unstampClosed": {
        const { closedAt: _dropped, ...rest } = run;
        writeRun(dir, rest);
        return false;
      }
```

`verdictFor` takes the shelf from the status it is already given, and honours the escape hatch:

```ts
  private verdictFor(
    s: RunStatus,
    livePlaces: ReadonlySet<string>,
    nowMs: number,
    overrideGates = false,
  ): RetireVerdict {
    const cfg = getConfig();
    return retireVerdict({
      run: s.run,
      repos: s.repos,
      ticketCategory: s.ticketCategory,
      prs: s.prs,
      hasLiveSession: s.run.repos.some((r) => livePlaces.has(canon(r.path))),
      prsAuthoritative: this.prFacts,
      // `inflightShowAll` already forces every shelf to "board" in buildAll, so
      // this is belt and braces — and it keeps the setting's promise ("nothing is
      // retired for being closed") true even if a caller hands over a stale status.
      shelf: cfg.inflightShowAll ? "board" : s.shelf,
      finishedAfterMs: overrideGates ? 0 : cfg.retireFinishedAfterHours * 3_600_000,
      abandonedAfterMs: overrideGates ? 1 : cfg.retireAbandonedAfterDays * 86_400_000,
      closedAfterMs: overrideGates ? 0 : cfg.retireClosedAfterHours * 3_600_000,
      nowMs,
      exists: (p) => fs.existsSync(p),
    });
  }
```

`reviewVerdictFor` gets the two new fields with rule 2b switched off — a review run never renders a card, so it has no shelf and keeps exactly today's rules:

```ts
      // A review run never renders a card, so it has no shelf. "board" keeps
      // rule 2b inert and leaves rules 1, 2 and 3 to sweep it as they always have.
      shelf: "board",
      closedAfterMs: 0,
```

Note that `verdictFor` passes `closedAfterMs: 0` under `overrideGates` — that is deliberate and matches `finishedAfterMs`: **Clear stale** ignores both time windows, so a closed run is takeable by it immediately. The dirty/ahead veto still protects it.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Gates**

Run: `npm run typecheck && npm test && npm run test:cov && npm run build`

- [ ] **Step 9: Commit**

```bash
git add src/engine/retire.ts src/deckView.ts test/unit/engine/retire.test.ts
git commit -m "feat(deck): retire a closed run after its window elapses

Rule 2b stamps closedAt when the board shelves a run as closed and deletes the
record 24h later. The dirty/ahead veto and the live-session veto both still
outrank it, so no record is ever deleted out from under real work."
```

---

### Task 6: The ClosedStrip component

**Files:**
- Create: `src/webview/ClosedStrip.tsx`
- Create: `test/webview/ClosedStrip.test.tsx`
- Modify: `src/webview/deckStyles.ts` (append CSS before the closing backtick)
- Modify: `src/webview/helpers.ts` (receives `timeAgo`), `src/webview/DeckApp.tsx` (imports it instead of declaring it)

**Interfaces:**
- Consumes: `RunStatus` (Task 4, for the `shelf` field — though the component takes only the rows it needs).
- Produces:
  ```ts
  export interface ClosedRow {
    key: string;        // run key
    title: string;      // run summary
    label: string;      // "notepad" | "explore" | a ticket key
    closedAt: number | null;
  }
  export function ClosedStrip(props: {
    rows: ClosedRow[];
    collapsed: boolean;
    onCollapse: (collapsed: boolean) => void;
    onReopen: (key: string) => void;
    onForget: (key: string) => void;
    onClearAll: () => void;
  }): JSX.Element | null;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/webview/ClosedStrip.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { ClosedRow, ClosedStrip } from "../../src/webview/ClosedStrip";

const NOW = Date.now();
const row = (over: Partial<ClosedRow> = {}): ClosedRow => ({
  key: "notepad-a", title: "Add drag and drop to the notepad", label: "notepad",
  closedAt: NOW - 2 * 3_600_000, ...over,
});

const props = (over: Partial<React.ComponentProps<typeof ClosedStrip>> = {}) => ({
  rows: [row()], collapsed: true, onCollapse: vi.fn(),
  onReopen: vi.fn(), onForget: vi.fn(), onClearAll: vi.fn(), ...over,
});

describe("ClosedStrip", () => {
  it("renders nothing when nothing has closed", () => {
    const { container } = render(<ClosedStrip {...props({ rows: [] })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("heads the strip with the count when collapsed", () => {
    render(<ClosedStrip {...props({ rows: [row(), row({ key: "b" })] })} />);
    expect(screen.getByText("Recently closed")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("hides the rows when collapsed", () => {
    render(<ClosedStrip {...props()} />);
    expect(screen.queryByText(/Add drag and drop/)).not.toBeInTheDocument();
  });

  it("shows a row per closed run when expanded", () => {
    render(<ClosedStrip {...props({ collapsed: false })} />);
    expect(screen.getByText("Add drag and drop to the notepad")).toBeInTheDocument();
    expect(screen.getByText("notepad")).toBeInTheDocument();
    expect(screen.getByText(/closed 2h ago/)).toBeInTheDocument();
  });

  it("asks to toggle rather than toggling itself — the parent owns the state", () => {
    const onCollapse = vi.fn();
    render(<ClosedStrip {...props({ onCollapse })} />);
    fireEvent.click(screen.getByText("Recently closed"));
    expect(onCollapse).toHaveBeenCalledWith(false);
  });

  it("reopens a row by its run key", () => {
    const onReopen = vi.fn();
    render(<ClosedStrip {...props({ collapsed: false, onReopen })} />);
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(onReopen).toHaveBeenCalledWith("notepad-a");
  });

  it("forgets a row by its run key", () => {
    const onForget = vi.fn();
    render(<ClosedStrip {...props({ collapsed: false, onForget })} />);
    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    expect(onForget).toHaveBeenCalledWith("notepad-a");
  });

  it("offers Clear all only when expanded", () => {
    const { rerender } = render(<ClosedStrip {...props()} />);
    expect(screen.queryByRole("button", { name: "Clear all" })).not.toBeInTheDocument();
    rerender(<ClosedStrip {...props({ collapsed: false })} />);
    expect(screen.getByRole("button", { name: "Clear all" })).toBeInTheDocument();
  });

  it("omits the age on a row with no closedAt rather than rendering an empty gap", () => {
    render(<ClosedStrip {...props({ collapsed: false, rows: [row({ closedAt: null })] })} />);
    expect(screen.queryByText(/closed /)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/webview/ClosedStrip.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Lift `timeAgo` into the shared helpers**

`DeckApp.tsx` declares `timeAgo` module-locally at line 56 and the strip needs the same function. Move it — do not write a second copy.

Cut it out of `src/webview/DeckApp.tsx` verbatim, **signature unchanged**, and paste it into `src/webview/helpers.ts` as an export:

```ts
/** "4m ago" from an epoch-ms stamp. `null` and 0 both render "" — a session
 * record with no startedAt must not read as "open 56y ago". */
export function timeAgo(ms: number | null): string {
  if (!ms) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
```

Then add `timeAgo` to `DeckApp.tsx`'s existing `import { isPrReviewStatus } from "./helpers";`. Keep the `number | null` signature exactly: `DeckApp.tsx:230` relies on `timeAgo(0)` returning `""`, and narrowing the parameter to `number` would break that guard's intent.

Run `npm test` before continuing — every existing DeckApp test must still pass, since nothing about the function changed.

- [ ] **Step 4: Write the component**

Create `src/webview/ClosedStrip.tsx`. It imports `timeAgo` rather than declaring one:

```tsx
import * as React from "react";
import { timeAgo } from "./helpers";

/** One run that has left the board: no agent of its own, no PR, no active
 * ticket, nothing uncommitted. It retires on its own after
 * `agentFlow.retireClosedAfterHours`. */
export interface ClosedRow {
  key: string;
  title: string;
  /** What the card's key chip said — a ticket key, or "notepad" / "explore". */
  label: string;
  /** null on a record written before `closedAt` existed. */
  closedAt: number | null;
}

/**
 * Everything that left the board, on one line until you ask for more.
 *
 * Collapsed by default, and collapsed is the state that matters: the strip
 * exists so a closed run costs one line instead of a card. The parent owns the
 * collapse flag so it survives a `deck:runs` re-render.
 *
 * Row actions are hover-and-focus only, in CSS — a row is something to glance
 * past, not a control panel. They stay reachable by keyboard because `:focus`
 * reveals them too.
 */
export function ClosedStrip({ rows, collapsed, onCollapse, onReopen, onForget, onClearAll }: {
  rows: ClosedRow[];
  collapsed: boolean;
  onCollapse: (collapsed: boolean) => void;
  onReopen: (key: string) => void;
  onForget: (key: string) => void;
  onClearAll: () => void;
}): JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <div className="rc">
      <div className="rc-hd">
        <button type="button" className="rc-toggle" onClick={() => onCollapse(!collapsed)}
          title="Runs that left the board — no agent, no pull request, nothing uncommitted">
          <span className="rc-caret">{collapsed ? "▸" : "▾"}</span>
          <span className="rc-nm">Recently closed</span>
          <span className="rc-ct">{rows.length}</span>
        </button>
        <span className="rc-sp" />
        {!collapsed && (
          <button type="button" className="rc-clear" onClick={onClearAll}
            title="Retire every record listed here. Worktrees, branches and commits are left untouched.">
            Clear all
          </button>
        )}
      </div>
      {!collapsed && (
        <div className="rc-rows">
          {rows.map((r) => (
            <div className="rc-row" key={r.key}>
              <span className="sdot tone-parked" />
              <span className="rc-key" title={r.key}>{r.label}</span>
              <span className="rc-ttl" title={r.title}>{r.title}</span>
              {r.closedAt !== null && <span className="rc-when">closed {timeAgo(r.closedAt)}</span>}
              <button type="button" className="rc-act" onClick={() => onReopen(r.key)}
                title="Open this task's workspace again">Reopen</button>
              <button type="button" className="rc-act" onClick={() => onForget(r.key)}
                title="Delete the run record now. The worktree, branch and commits are left untouched.">Forget</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Add the CSS**

In `src/webview/deckStyles.ts`, append inside the `DECK_CSS` template literal, before the closing backtick. Reuse the existing `.sdot` and `tone-parked` rules — do not redefine them.

```css
  /* ── Recently closed ──────────────────────────────────────────────────
     Everything that left the board. Quiet by construction: no accent, no
     saturated color, row actions revealed only on hover or focus. Saturated
     color is spent on attention debt, and a closed run owes nothing. */
  .rc { margin: 10px 14px 0; border-top: 1px solid var(--vscode-panel-border); }
  .rc-hd { display: flex; align-items: center; padding: 3px 0; }
  .rc-toggle { display: flex; align-items: center; gap: 8px; background: none;
    border: 0; padding: 6px 2px; cursor: pointer; font: inherit; text-align: left;
    color: var(--vscode-descriptionForeground); }
  .rc-toggle:hover { color: var(--vscode-foreground); }
  .rc-caret { font-size: 9px; opacity: .8; }
  .rc-nm { color: var(--vscode-foreground); }
  /* A count is a number, so it earns the mono treatment; the label beside it is
     prose and must not. */
  .rc-ct { font-family: var(--vscode-editor-font-family); font-size: 11px; opacity: .75; }
  .rc-sp { flex: 1; }
  .rc-clear { background: none; border: 0; color: var(--vscode-descriptionForeground);
    font: inherit; font-size: 11px; cursor: pointer; padding: 2px 6px; border-radius: 4px; }
  .rc-clear:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
  .rc-rows { display: flex; flex-direction: column; padding-bottom: 8px; }
  .rc-row { display: flex; align-items: center; gap: 10px; padding: 5px 4px;
    border-radius: 4px; font-size: 12px; }
  .rc-row:hover { background: var(--vscode-list-hoverBackground); }
  .rc-row .sdot { flex: none; }
  .rc-key { font-family: var(--vscode-editor-font-family); font-size: 11px;
    color: var(--vscode-descriptionForeground); flex: none; min-width: 84px; }
  .rc-ttl { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rc-when { color: var(--vscode-descriptionForeground); font-size: 11px; flex: none; }
  .rc-act { background: none; border: 1px solid var(--vscode-panel-border);
    border-radius: 4px; color: var(--vscode-descriptionForeground); font: inherit;
    font-size: 11px; padding: 1px 7px; cursor: pointer; flex: none; opacity: 0; }
  .rc-row:hover .rc-act, .rc-act:focus { opacity: 1; }
  .rc-act:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run test/webview/ClosedStrip.test.tsx`
Expected: PASS, 9 tests.

- [ ] **Step 7: Mutation-check**

1. Change `if (rows.length === 0) return null;` to `if (false)`. Re-run — "renders nothing when nothing has closed" must FAIL. Restore.
2. Change `onCollapse(!collapsed)` to `onCollapse(collapsed)`. Re-run — the toggle test must FAIL. Restore.
3. Change `onReopen(r.key)` to `onReopen(r.title)`. Re-run — the reopen test must FAIL. Restore.

- [ ] **Step 8: Gates**

Run: `npm run typecheck && npm test && npm run test:cov && npm run build`
Expected: pass. `npm run build` is the gate that matters here — if `ClosedStrip.tsx` pulled in anything Node-only, this is the only command that says so.

- [ ] **Step 9: Commit**

```bash
git add src/webview/ClosedStrip.tsx src/webview/helpers.ts src/webview/DeckApp.tsx src/webview/deckStyles.ts test/webview/ClosedStrip.test.tsx
git commit -m "feat(webview): add the Recently closed strip

One collapsed line for everything that left the board, expanding to a row per
run with Reopen and Forget on hover."
```

---

### Task 7: Wire the strip into the board

**Files:**
- Modify: `src/webview/DeckApp.tsx` (partition, render, handlers)
- Modify: `test/webview/DeckApp.test.tsx`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `ClosedStrip`, `ClosedRow` (Task 6); `RunStatus.shelf` (Task 4).
- Produces: the finished feature. Nothing depends on this task.

- [ ] **Step 1: Write the failing test**

First, add `shelf: "board" as const` to `mkStatus` (line ~22) — `RunStatus` now requires it, and `"board"` is the value that preserves what every pre-existing test in the file asserts. **This is the second and last place where changing an existing test is expected.**

Then add, using the file's existing `mkStatus`, `runsMsg` and `host` helpers:

```tsx
describe("Recently closed strip", () => {
  const closed = (key: string, summary: string) => mkStatus({
    shelf: "closed",
    run: { key, summary, url: "", kind: "notepad", createdAt: 1, mode: "per-window",
      repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "main" }], briefPaths: [],
      closedAt: Date.now() - 2 * 3_600_000 },
    repos: [], agents: [], column: "progress", ticketStatus: null, ticketCategory: null,
  });

  it("shows no strip when every run is on the board", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    expect(screen.getByText("Export fails on large accounts")).toBeInTheDocument();
    expect(screen.queryByText("Recently closed")).not.toBeInTheDocument();
  });

  it("moves a closed run off the board and into the strip, collapsed", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus(), closed("notepad-a", "Add drag and drop to the notepad")]));
    expect(screen.getByText("Recently closed")).toBeInTheDocument();
    expect(screen.queryByText("Add drag and drop to the notepad")).not.toBeInTheDocument();
  });

  it("leaves a closed run out of the column count and the stat tile", () => {
    render(<DeckApp />);
    // Both are column "progress"; only the board one may be counted.
    host(runsMsg([mkStatus(), closed("notepad-a", "Add drag and drop to the notepad")]));
    const tile = screen.getByText("In progress").closest(".stat");
    expect(tile?.querySelector(".n")?.textContent).toBe("1");
  });

  it("reopens a strip row by its run key", () => {
    render(<DeckApp />);
    host(runsMsg([closed("notepad-a", "Add drag and drop to the notepad")]));
    fireEvent.click(screen.getByText("Recently closed"));
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:inspect", key: "notepad-a", action: "open" });
  });

  it("forgets a strip row through the same optimistic path as a card", () => {
    render(<DeckApp />);
    host(runsMsg([closed("notepad-a", "Add drag and drop to the notepad")]));
    fireEvent.click(screen.getByText("Recently closed"));
    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:forget", key: "notepad-a" });
    // Optimistic: the row leaves now, before any deck:runs comes back.
    expect(screen.queryByText("Add drag and drop to the notepad")).not.toBeInTheDocument();
  });

  it("shows the strip rather than the empty state when nothing is live but something closed", () => {
    render(<DeckApp />);
    host(runsMsg([closed("notepad-a", "Add drag and drop to the notepad")]));
    expect(screen.queryByText("No tasks in flight")).not.toBeInTheDocument();
    expect(screen.getByText("Recently closed")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/webview/DeckApp.test.tsx`
Expected: FAIL — "Recently closed" never appears.

- [ ] **Step 3: Implement**

In `src/webview/DeckApp.tsx`:

```tsx
import { ClosedRow, ClosedStrip } from "./ClosedStrip";
```

Add state beside `reviewsCollapsed`:

```tsx
  const [closedCollapsed, setClosedCollapsed] = React.useState(true);
```

Partition the runs **before** `cards` is projected, so a closed run reaches neither the columns nor the stat tiles. Replace the existing `const cards: DeckCard[] = ...` block with:

```tsx
  // A closed run is not a card. Partitioning here rather than filtering the
  // columns keeps the stat tiles, the column counts and the board reading from
  // one list, which is what they already promise each other.
  const live = runs.filter((r) => r.shelf !== "closed");
  const closed = runs.filter((r) => r.shelf === "closed");
  const cards: DeckCard[] = grouping === "agents"
    ? projectCards(live)
    : live.map((r) => ({ id: `w:${r.run.key}`, status: r, agent: null, column: r.column }));
```

Every other reference to `runs` in the render body must be re-pointed at `live` — **except** the `runs.length === 0` empty-state test, which becomes `live.length === 0 && closed.length === 0`: a board with nothing live but something closed should show the strip, not "No tasks in flight". Search the file for `runs` and check each hit.

Build the rows. The label mirrors the card's own key chip, so the strip and the board name the same run the same way:

```tsx
  const closedRows: ClosedRow[] = closed.map((r) => ({
    key: r.run.key,
    title: r.run.summary,
    label: isTicketRun(r.run) ? r.run.key : runKind(r.run) === "notepad" ? "notepad" : "explore",
    closedAt: r.run.closedAt ?? null,
  }));
```

Render it between the board and the legend — after the `runs.length === 0 ? ... : ...` expression closes, before `<div className="legend">`:

```tsx
      <ClosedStrip
        rows={closedRows}
        collapsed={closedCollapsed}
        onCollapse={(c) => setClosedCollapsed(c)}
        onReopen={(key) => send({ type: "deck:inspect", key, action: "open" })}
        onForget={forget}
        onClearAll={() => closedRows.forEach((r) => forget(r.key))}
      />
```

`forget` is the existing optimistic callback — it drops the run locally and posts `deck:forget`, and the next `deck:runs` is authoritative. Reuse it rather than writing a second path.

Confirm `runKind` is imported in `DeckApp.tsx` (it is, for the `notepad` chip) with `grep -n "runKind" src/webview/DeckApp.tsx`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/webview/DeckApp.test.tsx`
Expected: PASS.

- [ ] **Step 5: Mutation-check**

1. Change `runs.filter((r) => r.shelf !== "closed")` to `runs`. Re-run — the strip/board partition tests must FAIL. Restore.
2. Change `useState(true)` to `useState(false)` for `closedCollapsed`. Re-run — "collapsed by default" must FAIL. Restore.

- [ ] **Step 6: Update the changelog**

Add under `## [Unreleased]` in `CHANGELOG.md`:

```markdown
### Changed

- **In-flight board shows only work that is moving.** A card stays while it has an
  agent open, a pull request, an active ticket, or uncommitted work. Everything else
  collapses into a new **Recently closed** strip below the board and retires on its
  own after `agentFlow.retireClosedAfterHours` (default 24). Set
  `agentFlow.inflightShowAll` to `true` for the previous behaviour.

### Fixed

- **One agent, one card.** Notepad and Explore runs launch in place rather than in a
  worktree, so several run records could point at the same checkout — and every one
  of them claimed every Claude Code session running there. Four notepad runs over one
  repo rendered two live agents as eight cards. Each session now belongs to exactly
  one run.
```

- [ ] **Step 7: Look at it in a real editor**

Run: `npm run build`, then launch the dev host with **VS Code's** `code` CLI (the Cursor CLI silently drops `--extensionDevelopmentPath`):

```bash
code --extensionDevelopmentPath="$PWD" --new-window
```

Open the In-flight panel and confirm: the strip sits below the board, collapsed, with a count; expanding shows one row per closed run; hovering a row reveals Reopen and Forget; the board no longer shows a card per notepad run.

- [ ] **Step 8: Gates**

Run: `npm run typecheck && npm test && npm run test:cov && npm run build`
Expected: all four pass.

- [ ] **Step 9: Commit**

```bash
git add src/webview/DeckApp.tsx test/webview/DeckApp.test.tsx CHANGELOG.md
git commit -m "feat(webview): partition the In-flight board on shelf

Closed runs leave the columns, the counts and the stat tiles for the Recently
closed strip. The empty state now distinguishes 'nothing launched' from
'nothing live, some closed'."
```

---

## Verification

After Task 7, the whole feature is in. Confirm against the spec:

- [ ] Four notepad runs over one checkout with two agents render **two** cards, not eight.
- [ ] Closing every agent on a notepad run with no PR moves it to the strip on the next refresh.
- [ ] That run's record is gone ~24h later, and its worktree, branch and commits are not.
- [ ] A run with uncommitted work stays on the board however long its agent has been closed.
- [ ] A task whose agent is closed but whose PR is open stays in **In review**.
- [ ] `agentFlow.inflightShowAll: true` restores the old board and hides the strip.
- [ ] `npm run typecheck && npm test && npm run test:cov && npm run build` all pass.
