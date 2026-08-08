# Deck Orchestrator — Phase 3: launch and seed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an armed flow act. A met rule can launch the next agent in a fresh worktree, or seed another agent into a place that already exists — safely: a directory lock so two windows cannot fire the same rule twice, a confirmation the first time a flow ever launches anything, and a chain that keeps advancing because a launched node becomes a real place.

**Architecture:** The risky decisions stay pure and testable. `engine/orchestrator/lock.ts` is a TTL directory lock over injected IO and clock. `engine/orchestrator/launch.ts` turns a planned node plus a resolved ticket into an `openWorkspace` request and returns what happened — following `launchReview`'s injected-deps shape (`{ createWorktrees, openWorkspace, log }`), which is why the Deck can already launch a review without the interactive Take flow. `DeckPanel` does only the impure parts: hold the lock, ask the first-launch question, call the launcher, rewrite the planned node into a place, and toast.

**Tech Stack:** TypeScript, VS Code extension API, Vitest.

## Global Constraints

- Work in the existing worktree `/Users/oznasi/dev/agent-flow/.claude/worktrees/orchestrator-core` on branch `worktree-orchestrator-core`. Never the main checkout.
- **This is the phase that spends money.** A launch opens a window and starts a Claude Code session. Every guard below is load-bearing; if a task seems to need one relaxed, stop and say so rather than relaxing it.
- **`npm run build` must succeed before every commit** — check the **exit code** after `rm -rf dist`, since esbuild does not clear `dist/`. Nothing reachable from `src/webview/` may import `fs`/`os`/`path`/`child_process`, even transitively; `test/webview/webviewGraph.test.ts` guards it but walks relative imports only.
- `npx tsc --noEmit` clean and `npx vitest run` green before each commit. The suite is **2605 tests across 90 files**; it must only grow.
- **≥95% line coverage on every file this plan creates or modifies.**
- **`lib` is capped at ES2022** — `Array.prototype.findLast` and other ES2023 methods fail `tsc`. Use `.filter(...).at(-1)`.
- Do NOT touch the `version` field in `package.json`, `package-lock.json`, or `CHANGELOG.md`. New `contributes.configuration` entries are in scope where a task calls for one.
- **Do not change the meaning of any persisted field.** Adding a field to `Flow` is fine — `store.ts` preserves unknown fields — but a condition-kind string, node kind, or existing edge field must keep its meaning, because these live in users' files.
- A place's agent state comes from `placeActivity`, never `RunStatus.agent` directly.
- House rules: monospace for identifiers and counts only; red only for a real failure; Arm is the drawer's one filled control.
- Conventional commits, scoped `orchestrator`.

## File Structure

| File | Responsibility |
|---|---|
| `src/engine/orchestrator/lock.ts` | *(new)* A TTL directory lock over injected IO + clock. Pure logic, no `fs`. |
| `src/engine/orchestrator/launch.ts` | *(new)* Turn a planned node + resolved ticket into an `openWorkspace` request; report what happened. Injected deps, no `vscode`. |
| `src/engine/orchestrator/promote.ts` | *(new)* Rewrite a planned node into a place node after a successful launch. Pure. |
| `src/engine/orchestrator/flowIo.ts` | *(modify)* The `fs` implementation of the lock's IO. |
| `src/engine/orchestrator/model.ts` | *(modify)* `Flow.launchConfirmedAt?: number`. |
| `src/deckView.ts` | *(modify)* Hold the lock; ask the first-launch question; perform `launch` and `seed`; promote; toast. |
| `src/engine/orchestrator/runner.ts` | *(modify)* Stop treating a non-notify action as unavailable; describe a real launch. |
| `src/webview/OrchestratorDrawer.tsx` | *(modify)* Offer `launch`/`seed` in the inspector, with the prompt mode and destination a launch needs. |
| `README.md` | *(modify)* The Orchestrator paragraph, which currently says notify is all a rule can do. |

Tests mirror each source file; `test/unit/deckView.test.ts` and `test/webview/OrchestratorDrawer.test.tsx` gain cases.

---

## Task 1: The directory lock

**Files:**
- Create: `src/engine/orchestrator/lock.ts`
- Test: `test/unit/engine/orchestrator/lock.test.ts`

**Interfaces:**
- Produces: `LockIo` (`{ tryCreate(path, text): boolean; read(path): string | null; remove(path): void }`), `lockPath(dir)`, `acquire(io, dir, nowMs, ttlMs, token)` returning `boolean`, `release(io, dir, token)`. Task 5's `deckView.ts` wraps a read-evaluate-write in these and supplies a per-panel `token`.

> **Correction applied during execution.** This task originally specified `acquire` *stealing* a dead lock — `remove` then `tryCreate`, returning `true`. Review found that defeats the task's own purpose: `remove`+`tryCreate` is not atomic, so two windows that both judge one stale lock dead interleave their pairs and **both** return `true`. Reaping replaced stealing (see the implementation comment), and a token was added so a window suspended past the TTL cannot release a lock that has since been reaped and retaken. **The implementation block below is the corrected version. The test block below is the original** — its three steal cases (`steals a lock older than the TTL`, `does not steal a lock exactly at the TTL`, `steals a lock whose contents are unreadable`) became reap-then-acquire cases, the `vanished` case was given a small `nowMs` so it actually pins the null branch, and two cases were added: two windows meeting one stale lock never both acquire, and `release` with a foreign token leaves the lock alone. Read `test/unit/engine/orchestrator/lock.test.ts` for what shipped.

**Why this exists.** `defaultFlowsDir()` is the global `~/.agentflow/flows` and `DeckPanel` is per extension host, so two VS Code windows both read an unfired edge and both fire it — proved with a probe in the previous phase: two identical toasts, one window's stamp overwriting the other's. Today that is a duplicate toast. **Once a rule can launch, it is a second paid agent session.** Phase 2b narrowed the window to microseconds; this closes it.

`tryCreate` must be an **atomic exclusive create** — it returns false rather than throwing if the file exists. The `fs` implementation in Task 2 uses the `"wx"` flag, which is atomic on both POSIX and Windows.

The TTL exists only for crash recovery: the critical section is one read, one evaluate and a few small writes, so a lock older than the TTL means the holder died. Keep the TTL far above the critical section and far below a poll interval's usefulness — 30 seconds.

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine/orchestrator/lock.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { acquire, release, lockPath, LockIo, LOCK_TTL_MS } from "../../../../src/engine/orchestrator/lock";

const NOW = 1_800_000_000_000;
const DIR = "/store/flows";

/** An in-memory LockIo with a genuinely exclusive create. */
const fakeIo = (files: Record<string, string> = {}) => {
  const io: LockIo = {
    tryCreate: (p, text) => {
      if (p in files) return false;
      files[p] = text;
      return true;
    },
    read: (p) => files[p] ?? null,
    remove: (p) => { delete files[p]; },
  };
  return { io, files };
};

describe("lockPath", () => {
  it("sits inside the flows directory", () => {
    expect(lockPath(DIR)).toContain(DIR);
  });
});

describe("acquire", () => {
  it("succeeds when no lock exists, and writes one", () => {
    const { io, files } = fakeIo();
    expect(acquire(io, DIR, NOW, LOCK_TTL_MS)).toBe(true);
    expect(files[lockPath(DIR)]).toBeTruthy();
  });

  it("fails when another holder has a fresh lock", () => {
    const { io } = fakeIo();
    expect(acquire(io, DIR, NOW, LOCK_TTL_MS)).toBe(true);
    // A second window, one millisecond later.
    expect(acquire(io, DIR, NOW + 1, LOCK_TTL_MS)).toBe(false);
  });

  it("steals a lock older than the TTL — the holder died", () => {
    const { io } = fakeIo();
    expect(acquire(io, DIR, NOW, LOCK_TTL_MS)).toBe(true);
    expect(acquire(io, DIR, NOW + LOCK_TTL_MS + 1, LOCK_TTL_MS)).toBe(true);
  });

  it("does not steal a lock exactly at the TTL", () => {
    // Strictly older, so a boundary tick cannot let two windows in at once.
    const { io } = fakeIo();
    acquire(io, DIR, NOW, LOCK_TTL_MS);
    expect(acquire(io, DIR, NOW + LOCK_TTL_MS, LOCK_TTL_MS)).toBe(false);
  });

  it("steals a lock whose contents are unreadable", () => {
    // A half-written or hand-mangled lock must not wedge every window forever.
    const { io } = fakeIo({ [lockPath(DIR)]: "not a timestamp" });
    expect(acquire(io, DIR, NOW, LOCK_TTL_MS)).toBe(true);
  });

  it("steals a lock that vanished between the failed create and the read", () => {
    // tryCreate says taken, read says gone: the holder released in between, so the
    // next attempt must be allowed rather than reporting a lock nobody holds.
    const files: Record<string, string> = { [lockPath(DIR)]: String(NOW) };
    const io: LockIo = {
      tryCreate: (p) => { delete files[p]; return false; }, // taken, then vanishes
      read: () => null,
      remove: (p) => { delete files[p]; },
    };
    expect(acquire(io, DIR, NOW, LOCK_TTL_MS)).toBe(true);
  });

  it("is reacquirable after release", () => {
    const { io } = fakeIo();
    acquire(io, DIR, NOW, LOCK_TTL_MS);
    release(io, DIR);
    expect(acquire(io, DIR, NOW + 1, LOCK_TTL_MS)).toBe(true);
  });
});

describe("release", () => {
  it("removes the lock", () => {
    const { io, files } = fakeIo();
    acquire(io, DIR, NOW, LOCK_TTL_MS);
    release(io, DIR);
    expect(files[lockPath(DIR)]).toBeUndefined();
  });

  it("is safe when no lock is held", () => {
    const { io } = fakeIo();
    expect(() => release(io, DIR)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/engine/orchestrator/lock.test.ts`
Expected: FAIL — cannot resolve `lock`.

- [ ] **Step 3: Write the implementation**

Create `src/engine/orchestrator/lock.ts`:

```ts
// A TTL lock over the flows directory, so two VS Code windows cannot advance the
// same flow at once. This is not belt-and-braces: the flows directory is global and
// each window has its own panel, so without it both windows read an unfired edge
// and both fire it — measured, in the previous phase, as two identical toasts with
// one window's stamp overwriting the other's. Once a rule can launch an agent, that
// is a second paid session.
//
// Pure over an injected IO for the same reason every other rule in this directory
// is: the whole contention story is testable from a plain object, with no temp
// directory and no real clock.
import * as path from "path";

/** The only IO surface. `tryCreate` MUST be an atomic exclusive create — return
 * false, do not throw, if the file already exists. */
export interface LockIo {
  tryCreate(p: string, text: string): boolean;
  read(p: string): string | null;
  remove(p: string): void;
}

/** Long enough that a healthy critical section (one read, one evaluate, a few small
 * writes) can never be mistaken for a dead holder; short enough that a crashed
 * window costs at most this much progress. */
export const LOCK_TTL_MS = 30_000;

export function lockPath(dir: string): string {
  return path.join(dir, ".advance.lock");
}

/** The stored value is `<acquiredAt>:<token>`. */
function stamp(nowMs: number, token: string): string {
  return `${nowMs}:${token}`;
}

function tokenOf(raw: string): string {
  return raw.slice(raw.indexOf(":") + 1);
}

/** A lock nobody can be holding: past its TTL, or unparseable — half-written or
 * hand-mangled, which must not wedge every window forever. */
function isDead(raw: string, nowMs: number, ttlMs: number): boolean {
  const heldAt = Number(raw.slice(0, raw.indexOf(":")));
  return !Number.isFinite(heldAt) || nowMs - heldAt > ttlMs;
}

/** Take the lock, or report that someone else holds it.
 *
 * This returns true from exactly one place: a successful exclusive create on an
 * empty path. A lock past its TTL is REAPED, not stolen — we delete it and report
 * failure, letting the next poll's plain create arbitrate. Stealing (remove, then
 * create, then return true) looks equivalent and is not: two windows that both
 * judge one stale lock dead interleave their remove/create pairs and both come
 * away believing they hold it, which is precisely the double-launch this lock
 * exists to prevent. Reaping costs one poll of recovery latency after a crash and
 * cannot double-acquire. */
export function acquire(
  io: LockIo, dir: string, nowMs: number, ttlMs: number, token: string,
): boolean {
  const p = lockPath(dir);
  if (io.tryCreate(p, stamp(nowMs, token))) return true;

  const raw = io.read(p);
  // Vanished between the create and the read: the holder released in the gap, so
  // try once more rather than reporting a lock nobody holds.
  if (raw === null) return io.tryCreate(p, stamp(nowMs, token));

  if (isDead(raw, nowMs, ttlMs)) io.remove(p);
  return false;
}

/** Release our own lock, and only ours. A window suspended past the TTL has its
 * lock reaped and possibly replaced; without the token check its `release` would
 * delete a live holder's lock. */
export function release(io: LockIo, dir: string, token: string): void {
  const p = lockPath(dir);
  const raw = io.read(p);
  if (raw !== null && tokenOf(raw) !== token) return;
  io.remove(p);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/engine/orchestrator/lock.test.ts`
Expected: PASS.

- [ ] **Step 5: All four gates**

`npx tsc --noEmit`; `rm -rf dist && npm run build` (exit 0); `npx vitest run`; `npx vitest run --coverage` — `lock.ts` at 100% lines.

- [ ] **Step 6: Commit**

```bash
git add src/engine/orchestrator/lock.ts test/unit/engine/orchestrator/lock.test.ts
git commit -m "feat(orchestrator): add a TTL lock so two windows cannot fire one rule twice"
```

---

## Task 2: The lock's real IO, and the first-launch field

**Files:**
- Modify: `src/engine/orchestrator/flowIo.ts`
- Modify: `src/engine/orchestrator/model.ts`
- Test: `test/unit/engine/orchestrator/flowIo.test.ts`, `test/unit/engine/orchestrator/model.test.ts`

**Interfaces:**
- Produces: `nodeLockIo(log?: (m: string) => void): LockIo` from `flowIo.ts`, and `Flow.launchConfirmedAt?: number`. Task 5 uses both, passing `this.log`.

> **Correction applied during execution.** `tryCreate` originally caught every error and returned `false`, making a permissions/read-only/ENOSPC failure indistinguishable from "another window holds the lock" — which in an unattended poll loop means a flow that never advances again, with nothing to diagnose. It still fails closed (a throw would escape into the Deck's refresh), but now logs when the error is not `EEXIST`. The optional `log` keeps every existing call site valid.

`flowIo.ts` is the only file in this directory allowed to import `fs`. `tryCreate` must use the `"wx"` flag — an atomic exclusive create on POSIX and Windows — and return `false` on `EEXIST` rather than throwing.

`launchConfirmedAt` records when the user approved this flow's first launch. It is a **new optional field**, which `store.ts` preserves untouched on a round trip, so an existing flow file stays valid and simply has no approval yet.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/engine/orchestrator/flowIo.test.ts`:

```ts
describe("nodeLockIo", () => {
  it("creates a lock exclusively — the second attempt fails rather than throwing", () => {
    const io = nodeLockIo();
    const p = path.join(dir, "x.lock");
    expect(io.tryCreate(p, "1")).toBe(true);
    expect(io.tryCreate(p, "2")).toBe(false);
    // And the first writer's contents survive.
    expect(io.read(p)).toBe("1");
  });

  it("creates the directory if it does not exist yet", () => {
    const io = nodeLockIo();
    expect(io.tryCreate(path.join(dir, "deep", "x.lock"), "1")).toBe(true);
  });

  it("reads null for a missing lock rather than throwing", () => {
    expect(nodeLockIo().read(path.join(dir, "nope.lock"))).toBeNull();
  });

  it("removes a lock, and removing a missing one is not an error", () => {
    const io = nodeLockIo();
    const p = path.join(dir, "x.lock");
    io.tryCreate(p, "1");
    io.remove(p);
    expect(io.read(p)).toBeNull();
    expect(() => io.remove(p)).not.toThrow();
  });
});
```

Add `nodeLockIo` to that file's existing import from `flowIo`.

**The `dir` fixture is not reusable.** `test/unit/engine/orchestrator/flowIo.test.ts` declares `let dir: string` **inside** `describe("nodeFlowIo")`, so a sibling `describe` cannot see it. Give the new block its own identical fixture — copy the `beforeEach`/`afterEach` pair that creates and removes an `os.tmpdir()` directory. (Hoisting the existing one to the file scope instead is also acceptable, and tidier; either way, do not reference `dir` across describes and expect it to resolve.)

Add to `test/unit/engine/orchestrator/model.test.ts`:

```ts
it("emptyFlow has no launch approval yet", () => {
  expect(emptyFlow("f1", "n", 1).launchConfirmedAt).toBeUndefined();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/unit/engine/orchestrator/flowIo.test.ts test/unit/engine/orchestrator/model.test.ts`
Expected: FAIL — `nodeLockIo` is not exported.

- [ ] **Step 3: Implement**

In `src/engine/orchestrator/flowIo.ts`, add the import and the factory:

```ts
import { LockIo } from "./lock";
```

```ts
/** The lock's real IO. `wx` is the whole point: an atomic exclusive create, so two
 * windows racing for the lock cannot both believe they took it. EEXIST means
 * somebody else won — that is an answer, not an error. */
export function nodeLockIo(): LockIo {
  return {
    tryCreate: (p, text) => {
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, text, { flag: "wx" });
        return true;
      } catch {
        return false;
      }
    },
    read: (p) => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    remove: (p) => fs.rmSync(p, { force: true }),
  };
}
```

In `src/engine/orchestrator/model.ts`, add to the `Flow` interface:

```ts
  /** When the user approved this flow's first launch. A flow asks once, naming
   * what it is about to open, then runs unattended — the same reasoning as the
   * resume gate: a mis-wired flow should cost one prompt, not a string of paid
   * sessions. Absent means it has never launched anything. */
  launchConfirmedAt?: number;
```

- [ ] **Step 4: Run them to verify they pass**, then all four gates, then commit

```bash
git add src/engine/orchestrator/flowIo.ts src/engine/orchestrator/model.ts test/unit/engine/orchestrator/flowIo.test.ts test/unit/engine/orchestrator/model.test.ts
git commit -m "feat(orchestrator): add the lock's fs implementation and a first-launch record"
```

---

## Task 3: Promote a planned node into a place

**Files:**
- Create: `src/engine/orchestrator/promote.ts`
- Test: `test/unit/engine/orchestrator/promote.test.ts`

**Interfaces:**
- Produces: `promoteToPlace(flow: Flow, nodeId: string, runKey: string, repo: string): Flow`. Task 5 calls it after a successful launch.

**Why this is what makes a chain work.** A `planned` node has no run to observe, so no condition on it can ever be evaluated. When a launch succeeds, the node must become a `place` bound to the run that was just created — same `id`, same `x`/`y`, same `join` — so every downstream edge keeps pointing at it and starts evaluating on the next pass. Without this, `ASM-1 merged → launch ASM-12 → ASM-12's CI passes → launch ASM-15` can never reach the third step.

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine/orchestrator/promote.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { promoteToPlace } from "../../../../src/engine/orchestrator/promote";
import { Flow, FlowNode, PlannedNode, emptyFlow, isPlace } from "../../../../src/engine/orchestrator/model";

const planned = (id: string, over: Partial<PlannedNode> = {}): PlannedNode => ({
  id, kind: "planned", x: 40, y: 80, join: "all",
  ticketKey: "ASM-12", repos: ["bite-me"], mode: "tdd", dest: "worktree", ...over,
});
const flowWith = (nodes: FlowNode[]): Flow => ({ ...emptyFlow("f1", "f", 0), nodes });

describe("promoteToPlace", () => {
  it("turns the planned node into a place bound to the new run", () => {
    const out = promoteToPlace(flowWith([planned("n3")]), "n3", "ASM-12", "bite-me");
    const n = out.nodes[0];
    expect(isPlace(n)).toBe(true);
    expect(n).toMatchObject({ kind: "place", runKey: "ASM-12", repo: "bite-me" });
  });

  it("keeps the id, position and join so downstream edges still point at it", () => {
    const out = promoteToPlace(flowWith([planned("n3")]), "n3", "ASM-12", "bite-me");
    expect(out.nodes[0]).toMatchObject({ id: "n3", x: 40, y: 80, join: "all" });
  });

  it("drops the planned-only fields", () => {
    const out = promoteToPlace(flowWith([planned("n3")]), "n3", "ASM-12", "bite-me");
    expect(out.nodes[0]).not.toHaveProperty("ticketKey");
    expect(out.nodes[0]).not.toHaveProperty("mode");
    expect(out.nodes[0]).not.toHaveProperty("dest");
    expect(out.nodes[0]).not.toHaveProperty("repos");
  });

  it("does not mutate the flow it is given", () => {
    const flow = flowWith([planned("n3")]);
    const before = JSON.stringify(flow);
    promoteToPlace(flow, "n3", "ASM-12", "bite-me");
    expect(JSON.stringify(flow)).toBe(before);
  });

  it("leaves every other node alone", () => {
    const other: FlowNode = { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-1", repo: "r" };
    const out = promoteToPlace(flowWith([other, planned("n3")]), "n3", "ASM-12", "bite-me");
    expect(out.nodes[0]).toEqual(other);
  });

  it("is a no-op for an id that is not in the flow", () => {
    const flow = flowWith([planned("n3")]);
    expect(promoteToPlace(flow, "nope", "ASM-12", "bite-me")).toEqual(flow);
  });

  it("is a no-op for a node that is not planned", () => {
    // Promoting a place again would rewrite the repo it is bound to, which is a
    // silent change of what every condition on it means.
    const place: FlowNode = { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-1", repo: "api" };
    const out = promoteToPlace(flowWith([place]), "n1", "ASM-9", "web");
    expect(out.nodes[0]).toEqual(place);
  });

  it("leaves the edges untouched", () => {
    const flow: Flow = {
      ...flowWith([planned("n3")]),
      edges: [{ id: "e1", from: "n1", to: "n3", cond: { kind: "pr-merged" }, action: "launch", mode: "tdd" }],
    };
    expect(promoteToPlace(flow, "n3", "ASM-12", "bite-me").edges).toEqual(flow.edges);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**, then implement

Create `src/engine/orchestrator/promote.ts`:

```ts
// A planned node has no run, so no condition on it can be evaluated. The moment a
// launch succeeds it must become a real place, or a chain dies at its second step:
// "ASM-1 merged -> launch ASM-12 -> ASM-12's CI passes -> launch ASM-15" would
// never reach the third link.
//
// Same id, position and join, so every downstream edge keeps pointing at it.
import { Flow, PlaceNode } from "./model";

export function promoteToPlace(flow: Flow, nodeId: string, runKey: string, repo: string): Flow {
  return {
    ...flow,
    nodes: flow.nodes.map((n) => {
      // Only a planned node is promoted. Re-promoting a place would rewrite the
      // repo it is bound to, silently changing what every condition on it means.
      if (n.id !== nodeId || n.kind !== "planned") return n;
      const promoted: PlaceNode = {
        id: n.id, kind: "place", x: n.x, y: n.y, join: n.join, runKey, repo,
      };
      return promoted;
    }),
  };
}
```

- [ ] **Step 3: Run it to verify it passes**, then all four gates, then commit

```bash
git add src/engine/orchestrator/promote.ts test/unit/engine/orchestrator/promote.test.ts
git commit -m "feat(orchestrator): promote a launched planned node into a real place"
```

---

## Task 4: The launcher

**Files:**
- Create: `src/engine/orchestrator/launch.ts`
- Test: `test/unit/engine/orchestrator/launch.test.ts`

**Interfaces:**
- Produces:
```ts
export interface LaunchRequest {
  node: PlannedNode;
  /** The ticket, already read by the caller. A local structural type — do NOT
   * import `TaskDetail` from `src/tasks/jira/client.ts`. The launcher must not
   * depend on one connector's client, and these four fields are all it needs.
   * `provider().detail(key)` returns a superset, so it satisfies this as-is. */
  detail: { key: string; summary: string; url: string; descriptionText: string };
  /** Every repo checkout discovered on this machine, by name. */
  repos: ServiceRef[];
  promptTemplate: string;
  workspaceDir: string;
  seedAgent: boolean;
}
export interface LaunchDeps {
  // createWorktrees lives in engine/worktree.ts, NOT engine/git.ts.
  createWorktrees: typeof import("../worktree").createWorktrees;
  openWorkspace: typeof import("../workspace").openWorkspace;
  log: (m: string) => void;
}
export type LaunchOutcome =
  | { ok: true; runKey: string; repo: string }
  | { ok: false; message: string };
export function launchPlanned(req: LaunchRequest, deps: LaunchDeps): Promise<LaunchOutcome>;
```
Task 5 calls it.

**Follow the existing precedent, do not invent one.** `src/engine/review/launch.ts` (used by `deckView.ts`'s `launchReviewFor`) is the same shape: a function taking a request plus `{ createWorktrees, openWorkspace, log }`, returning an ok/message result, so the panel stays thin and the logic is testable with spies. **Read it first** and mirror its structure, its error posture and its naming. Check its exact exported signature for `createWorktrees` and `openWorkspace` and use those types rather than the sketch above if they differ.

Rules the tests pin:
- A planned node names its repos by **name**; resolve them against the discovered checkouts and **fail with a message** if none resolve — launching into a repo that is not on this machine would create a worktree in the wrong place.
- The node's `dest` decides whether a worktree is created. `"worktree"` creates one; the other two do not.
- On success, report the `runKey` and the **single** repo the new place is bound to. A place node must mean exactly one repo, so when the node names several, bind to the first that resolved and say so in the log.
- Never throw: any failure is `{ ok: false, message }`, because the caller is a poll loop and an exception would take the whole refresh down.

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine/orchestrator/launch.test.ts` with cases for: a happy launch returning the run key and repo; a node whose repos resolve to nothing returning `ok: false` and calling neither dep; `dest: "worktree"` calling `createWorktrees` and the other destinations not; a throwing `openWorkspace` becoming `{ ok: false }` rather than propagating; the prompt template being passed through; and `seedAgent: false` still succeeding. Build the request with a small factory and pass `vi.fn()` deps so each assertion is about what the launcher *asked for*, not about disk. Assert on the actual `openWorkspace` argument object for at least the repo list and the mode, since a launch that opens the wrong repo is the failure that costs money.

- [ ] **Step 2: Run it, confirm red, then implement, then confirm green**

Write `src/engine/orchestrator/launch.ts` mirroring `src/engine/review/launch.ts`. Keep it free of `vscode` — the deps are injected, and `ServiceRef` comes from `../../types`.

- [ ] **Step 3: All four gates, then commit**

```bash
git add src/engine/orchestrator/launch.ts test/unit/engine/orchestrator/launch.test.ts
git commit -m "feat(orchestrator): add the launcher for a planned node"
```

---

## Task 5: Act — under the lock, with a first-launch confirmation

**Files:**
- Modify: `src/deckView.ts`
- Modify: `src/engine/orchestrator/runner.ts`
- Test: `test/unit/deckView.test.ts`, `test/unit/engine/orchestrator/runner.test.ts`

**Interfaces:**
- Consumes: `acquire`/`release`/`LOCK_TTL_MS` (Task 1), `nodeLockIo` (Task 2), `promoteToPlace` (Task 3), `launchPlanned` (Task 4).
- Produces: an armed flow that actually launches and seeds. Task 6 exposes the actions in the drawer.

This is the task that spends money, so it is the one to review hardest. Five things must hold, and each has a test:

1. **Everything happens under the lock.** `advanceArmedFlows` acquires before its read and releases in a `finally`. If the lock is held, the pass does nothing at all and returns — no evaluation, no write, no toast. A window that skips retries on its next poll.

   `acquire`/`release` take a **token** identifying this panel. Mint one per `DeckPanel` instance (any stable unique string — the panel already has state to hang it on) and pass the same token to both calls. It exists so a window suspended past the TTL, whose lock was reaped and retaken by another window, cannot delete the new holder's lock on wake. Because a reaped lock is never stolen in-place, the **first pass after a crash returns false** and the pass that follows acquires — so a test asserting "the lock recovers after a dead holder" must poll twice.
2. **A flow asks once before its first launch.** If `flow.launchConfirmedAt` is absent and this pass would perform a `launch`, do not launch: show a modal naming the ticket, the repo and the prompt mode, with **Launch** and **Disarm**. On Launch, stamp `launchConfirmedAt` and let the next pass act. On Disarm, write `armed: false`. Either way this pass performs nothing. Follow the existing modal idiom — `vscode.window.showWarningMessage(msg, { modal: true }, label)` as used by the Clear-stale confirmation.
3. **A successful launch promotes its node**, in the same write that stamps the edge, so a crash between them cannot leave a launched ticket looking unlaunched.
4. **A failed launch stamps `error` and is never retried.** The drawer already surfaces an errored edge as stalled and offers Reset.
5. **The 3-per-pass cap still holds** — `evaluateFlow` already enforces it; do not bypass it by looping.

Also fix, in `runner.ts`: a performed `launch` or `seed` edge currently records `error: "launch is not available in this build"`. That was correct while nothing could act; now it is wrong. A performed acting edge should be stamped by the caller with what actually happened, so `applyFired` must stop pre-judging it — take the note from the caller instead. Update `runner.test.ts`'s cases accordingly, keeping the one that asserts a note never claims something ran that did not.

- [ ] **Step 1: Write the failing tests**

In `test/unit/deckView.test.ts`, add a `describe` covering all five rules. Use the existing hoisted `h` mocks — add `h.acquire`/`h.release` by mocking `../../src/engine/orchestrator/lock`, and `h.launchPlanned` by mocking `../../src/engine/orchestrator/launch`, following the file's one-`vi.mock`-per-module idiom. The flows-store mock already has real semantics, so a write is visible to the next read. Assert:

- with the lock unavailable, `h.buildRunStatus` may still run (the board still refreshes) but `h.writeFlow` is never called and `h.launchPlanned` is never called;
- `release` is called even when evaluation throws (wrap a throwing `h.launchPlanned`);
- a flow with no `launchConfirmedAt` and a met `launch` rule calls `showWarningMessage` and does **not** call `launchPlanned`;
- answering Launch stamps `launchConfirmedAt` and the **next** pass calls `launchPlanned`;
- answering Disarm writes `armed: false` and no later pass launches;
- a successful launch writes a flow whose node is now a `place` bound to the returned run key **and** whose edge carries `firedAt`;
- a failed launch writes `error` on the edge, no promotion, and no success toast;
- a `notify` rule still fires without any confirmation, because notify spends nothing.

Audit each for vacuity before trusting it: an assertion that `launchPlanned` was not called must not pass merely because no rule was met.

- [ ] **Step 2: Run them, confirm red, then implement, then confirm green**

- [ ] **Step 3: All four gates, then commit**

```bash
git add src/deckView.ts src/engine/orchestrator/runner.ts test/unit/deckView.test.ts test/unit/engine/orchestrator/runner.test.ts
git commit -m "feat(orchestrator): launch and seed under a lock, asking once per flow"
```

---

## Task 6: Offer the acting verbs in the inspector

**Files:**
- Modify: `src/webview/OrchestratorDrawer.tsx`
- Test: `test/webview/OrchestratorDrawer.test.tsx`

The inspector currently states `notify me` as the only action. It must now offer `launch`, `seed` and `notify me`, and for the two acting verbs also the prompt mode and — for `launch` — the destination, since a planned node carries `mode` and `dest` and an armed launch cannot stop to ask.

Keep the WHEN / THEN / USING grammar the mockup established: `THEN launch <target>` with `USING <mode> in a <destination>`. Reuse the existing `OFFERED_CONDS` pattern for the mode list — the six prompt modes come from configuration, so pass them in as a prop rather than hardcoding them, and have `DeckApp` supply them from the `deck:flows` message (add the list to that message in this task, host-side, reading `getConfig().promptModes`).

Tests: selecting `launch` writes the action and mode onto the edge; selecting `notify` clears the mode; a `launch` edge whose target is a place rather than a planned node is refused with a visible reason (a launch needs something not yet launched); the destination selector appears only for `launch`. Prove each bites.

- [ ] **Steps:** failing tests → red → implement → green → all four gates → commit, scoped `orchestrator`.

---

## Task 7: The two carried races, and the docs

**Files:**
- Modify: `src/deckView.ts`
- Modify: `src/engine/orchestrator/runner.ts`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-05-deck-orchestrator-flows-design.md`
- Test: `test/unit/deckView.test.ts`

Three things the previous phase recorded as this phase's work:

**(a) A flow disarmed mid-pass still completes that pass.** Harmless for a toast; not for a launch. Under the lock, re-read the flow immediately before performing an acting edge and skip it if `armed` is now false. Add a test.

**(b) `notifyLines` reads `action` from the stale edge while `applyFired` reads it from the fresh one.** Inert while every edge was `notify`; a real divergence now. Make both read the same copy, and add a test that a rule whose action changed between evaluation and write does not produce a toast for the wrong verb.

**(d) One known limitation, written down rather than fixed.** `openWorkspace` treats its `writeRun` as best-effort and swallows a failure (`src/engine/workspace.ts:282-286`), and `OpenResult` carries no signal about it. So `launchPlanned` can legitimately report `{ok: true, runKey}` for a run that was never recorded — and `evaluate.ts`'s `byKey.get(runKey)` then misses it forever, leaving the promoted place observing nothing and the chain stalled with no explanation. This is **not** a Phase 3 regression: an ordinary Take has the same hole, and it fails the same way. Changing `openWorkspace`'s error posture would touch the Take path and is out of scope here. Record it in the spec's limitations section as a known stall mode, so the next person reads it as a decision rather than an oversight.

**(c) The docs.** `README.md`'s Orchestrator paragraph says notify is all a rule can do — now false. Say what ships: a rule can launch the next agent in a worktree, seed another agent into an existing place, or notify you; a flow asks once before its first launch; at most three launches per pass; and a failed launch stops that rule until you reset it. In the spec, move the concurrency blocker from "must land before money" to resolved, naming the lock and its TTL, and keep the honest note that the TTL is crash recovery rather than mutual exclusion for a hung holder.

- [ ] **Steps:** failing tests → red → implement → green → all four gates → commit, scoped `orchestrator`.

---

## Done when

- Two windows with the Deck open cannot fire the same rule twice — proved by a probe, not by reasoning.
- A flow asks once, naming the ticket, repo and prompt mode, before it ever launches; then runs unattended.
- A met `launch` rule opens a worktree and seeds an agent; the planned node becomes a real place, so the next link in the chain starts evaluating.
- A met `seed` rule opens another agent in an existing place.
- A failed launch stamps `error`, is never retried, shows as stalled, and can be Reset.
- At most three launches happen per pass.
- Disarming mid-pass stops an acting edge that has not yet run.
- All four gates green: `npm run build` exit 0, `tsc --noEmit` clean, `vitest run` green, every touched file ≥95% lines.

## What Phase 4 picks up

Resize and expand for the drawer, and the **keyboard-accessible list view** — the design doc designates it the canvas's keyboard path, and without it a flow is mouse-only, which is the last thing standing between this feature and "ready" by the project owner's own bar.
