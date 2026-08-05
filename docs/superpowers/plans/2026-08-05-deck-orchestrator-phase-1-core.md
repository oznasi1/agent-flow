# Deck Orchestrator — Phase 1: the pure core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and fully test the five pure modules a Deck flow needs — the model, the condition vocabulary, the human description of a condition's current state, the fire-once evaluator, and the canvas geometry — with no UI, no wiring, and nothing user-visible.

**Architecture:** Five new files under `src/engine/orchestrator/`, none of which import `vscode` or `fs`. `model.ts` holds types and guards. `conditions.ts` evaluates one predicate against one `RunStatus` — the snapshot `buildRunStatus` already produces — and describes where that predicate currently stands. `evaluate.ts` is a pure verdict function in the shape of the existing `engine/retire.ts`: it takes a flow plus every status and returns which edges should fire, never mutating and never acting. `store.ts` persists flows over an injected IO interface. `layout.ts` holds the canvas geometry as pure functions so it is testable without a DOM.

**Tech Stack:** TypeScript, Vitest.

## Global Constraints

- Follow the approved spec exactly: `docs/superpowers/specs/2026-08-05-deck-orchestrator-flows-design.md`.
- **None of these five modules may import `vscode`, or `fs` directly, or perform any I/O.** `path` and `os` are permitted in `store.ts` only, for `defaultFlowsDir()` — the same latitude `engine/runs.ts` takes.
  - The point of this rule is that every rule here is testable from plain fixtures with no temp directory. **`conditions.ts` importing the pure `mostActive` from `engine/status.ts` is explicitly allowed**, even though `status.ts` transitively imports `fs` via `./runs` and `./transcript`: nothing on that call path is executed, and reimplementing the agent-state ranking here instead would duplicate semantics that must not drift from the board's.
- `npx tsc --noEmit` must be clean before every commit.
- `npx vitest run` must be green before moving to the next task.
- **≥95% line coverage on every file this plan creates.** Check with `npx vitest run --coverage`. The repo's configured thresholds (90/85/85/90) are floors for the whole project, not the bar for new code.
- Nothing in this phase is reachable by a user. Do not add a setting, a command, a message type, or a `package.json` entry. Do not modify `src/deckView.ts`, `src/webview/`, or `src/types.ts`.
- **Do not touch** the `version` field in `package.json`, any version field in `package-lock.json`, or `CHANGELOG.md`. The orchestrator session owns those.
- Work in a git worktree, never the main checkout — `vsce package` packages the working directory, so a stray file there ships inside the extension.
- Conventional commits, scoped `orchestrator`: `feat(orchestrator): …`.
- **`main` moves fast — re-check it before starting.** `docs/superpowers/specs/2026-08-05-pluggable-task-connectors-design.md` landed alongside this one and renames `RunStatus.jiraCategory` → `ticketCategory` (and `JiraTask` → `Task`). `conditions.ts` reads `status.jiraCategory` and `status.jiraStatus`, so:
  - If the connectors work has already landed, read `status.ticketCategory` instead and update the two fixtures in `conditions.test.ts`. Nothing else in this plan is affected.
  - If it has not, write `jiraCategory` as this plan does; it is one more call site for that rename to sweep.
  - Either way the **condition kinds stay `ticket-done` / `ticket-status-is`** — deliberately connector-neutral, because a condition kind is persisted inside a saved flow and renaming one later would need a migration of every user's flow files.

## File Structure

| File | Responsibility |
|---|---|
| `src/engine/orchestrator/model.ts` | Types for a flow, its nodes, its edges and its conditions; node guards and small lookups. No behaviour beyond shape. |
| `src/engine/orchestrator/conditions.ts` | `evalCond` — is this condition true of this place right now — and `describeCond` — what does this place look like with respect to it. |
| `src/engine/orchestrator/evaluate.ts` | The verdict: given an armed flow and every status, which edges fire this pass, which nodes are blocked, how many launches were deferred. |
| `src/engine/orchestrator/store.ts` | Flow persistence over injected IO. |
| `src/engine/orchestrator/layout.ts` | Canvas geometry: anchors, the edge path, the label point, `tidy`. |

Tests mirror the source at `test/unit/engine/orchestrator/<name>.test.ts`.

---

## Task 1: The flow model and its guards

**Files:**
- Create: `src/engine/orchestrator/model.ts`
- Test: `test/unit/engine/orchestrator/model.test.ts`

**Interfaces:**
- Produces, and every later task imports from here: `Flow`, `FlowNode`, `PlaceNode`, `PlannedNode`, `NotifyNode`, `FlowEdge`, `Condition`, `CondKind`, `FlowAction`, `JoinMode`, `LaunchDest`, `emptyFlow(id, name, nowMs)`, `isPlace(n)`, `isPlanned(n)`, `isNotify(n)`, `findNode(flow, id)`, `incomingEdges(flow, nodeId)`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine/orchestrator/model.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  emptyFlow, isPlace, isPlanned, isNotify, findNode, incomingEdges,
  Flow, FlowEdge, FlowNode, PlaceNode, PlannedNode, NotifyNode,
} from "../../../../src/engine/orchestrator/model";

const place = (id: string, over: Partial<PlaceNode> = {}): PlaceNode => ({
  id, kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-1", repo: "agent-flow", ...over,
});
const planned = (id: string, over: Partial<PlannedNode> = {}): PlannedNode => ({
  id, kind: "planned", x: 0, y: 0, join: "any",
  ticketKey: "ASM-12", repos: ["bite-me"], mode: "tdd", dest: "worktree", ...over,
});
const notify = (id: string, over: Partial<NotifyNode> = {}): NotifyNode => ({
  id, kind: "notify", x: 0, y: 0, join: "any", message: "landed", ...over,
});
const edge = (id: string, from: string, to: string, over: Partial<FlowEdge> = {}): FlowEdge => ({
  id, from, to, cond: { kind: "pr-merged" }, action: "notify", ...over,
});

describe("emptyFlow", () => {
  it("is disarmed, named, and empty", () => {
    const f = emptyFlow("f1", "Ship the migration", 1_000);
    expect(f).toEqual({
      id: "f1", name: "Ship the migration", armed: false, createdAt: 1_000, nodes: [], edges: [],
    });
  });
});

describe("node guards", () => {
  it("identifies each kind and rejects the others", () => {
    const p = place("n1"), pl = planned("n2"), nt = notify("n3");
    expect([isPlace(p), isPlanned(p), isNotify(p)]).toEqual([true, false, false]);
    expect([isPlace(pl), isPlanned(pl), isNotify(pl)]).toEqual([false, true, false]);
    expect([isPlace(nt), isPlanned(nt), isNotify(nt)]).toEqual([false, false, true]);
  });
});

describe("findNode", () => {
  const flow: Flow = { ...emptyFlow("f1", "f", 0), nodes: [place("n1"), notify("n2")] };

  it("finds a node by id", () => {
    expect(findNode(flow, "n2")?.kind).toBe("notify");
  });

  it("is undefined for an id that is not in the flow", () => {
    expect(findNode(flow, "nope")).toBeUndefined();
  });
});

describe("incomingEdges", () => {
  const nodes: FlowNode[] = [place("a"), place("b"), notify("z")];
  const flow: Flow = {
    ...emptyFlow("f1", "f", 0),
    nodes,
    edges: [edge("e1", "a", "z"), edge("e2", "b", "z"), edge("e3", "a", "b")],
  };

  it("returns every edge pointing at the node, in flow order", () => {
    expect(incomingEdges(flow, "z").map((e) => e.id)).toEqual(["e1", "e2"]);
  });

  it("is empty for a node nothing points at", () => {
    expect(incomingEdges(flow, "a")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/engine/orchestrator/model.test.ts`
Expected: FAIL — cannot resolve `../../../../src/engine/orchestrator/model`.

- [ ] **Step 3: Write the implementation**

Create `src/engine/orchestrator/model.ts`:

```ts
// The shape of a Deck flow. Types and shape-level helpers only — no evaluation,
// no persistence, no geometry, and deliberately no imports at all, so every other
// module in this directory can depend on it without dragging anything in.

/** What several incoming edges mean at their meeting point. "any" fires on the
 * first one met; "all" waits for every one. It lives on the target node rather
 * than the edge because it is a property of the junction, not of one arrow. A
 * node with fewer than two incoming edges is unaffected by it. */
export type JoinMode = "any" | "all";

/** Where an autonomous launch puts the work. The flow's own vocabulary, not
 * `WorkspaceMode` — that type is only "multiroot" | "per-window" and cannot
 * express the worktree choice a Take offers. Phase 3's runner maps these onto the
 * take path's arguments. */
export type LaunchDest = "worktree" | "new-window" | "current-window";

interface NodeBase {
  id: string;
  x: number;
  y: number;
  join: JoinMode;
}

/** A place on disk that already exists: a run, narrowed to one of its repos. It
 * stores `runKey` and `repo` and never a pid or session id — sessions come and go
 * inside a worktree, and the worktree is what a condition can be about. */
export type PlaceNode = NodeBase & { kind: "place"; runKey: string; repo: string };

/** Work that has not started. It carries its whole launch configuration, because
 * an armed launch cannot stop to ask which repo, which prompt or where it goes. */
export type PlannedNode = NodeBase & {
  kind: "planned";
  ticketKey: string;
  repos: string[];
  mode: string; // a PromptMode id
  dest: LaunchDest;
};

/** A terminal that tells you something. Not a place, so nothing observes it. */
export type NotifyNode = NodeBase & { kind: "notify"; message: string };

export type FlowNode = PlaceNode | PlannedNode | NotifyNode;

/** Every condition kind that needs no parameter. */
export type CondKind =
  | "pr-merged"
  | "ci-passed"
  | "ci-failed"
  | "review-approved"
  | "changes-requested"
  | "threads-resolved"
  | "pr-conflicting"
  | "agent-ended-turn"
  | "no-agent-left"
  | "tree-clean"
  | "has-uncommitted"
  | "nothing-to-push"
  | "ticket-done";

/** Parameterised where it has to be, a bare kind everywhere else. */
export type Condition =
  | { kind: CondKind }
  | { kind: "agent-idle-over"; minutes: number }
  | { kind: "ticket-status-is"; status: string };

/** What an edge does when its condition is met. `launch` starts a planned node;
 * `seed` opens another agent in a place that already exists; `notify` only tells
 * you. Nothing here instructs a running agent — that is impossible. */
export type FlowAction = "launch" | "seed" | "notify";

export interface FlowEdge {
  id: string;
  from: string; // node id
  to: string; // node id
  cond: Condition;
  action: FlowAction;
  /** A PromptMode id, for `launch` and `seed`. */
  mode?: string;
  /** Set once this edge has fired. Its presence IS the latch: an edge with a
   * `firedAt` is never evaluated again until Reset clears it. */
  firedAt?: number;
  /** The receipt the drawer shows, e.g. "opened bite-me-3a". */
  firedNote?: string;
  /** The action threw. Never retried until Reset — retrying a launch that failed
   * every poll is how you end up with twenty windows. */
  error?: string;
}

export interface Flow {
  id: string;
  name: string;
  armed: boolean;
  createdAt: number;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export function emptyFlow(id: string, name: string, nowMs: number): Flow {
  return { id, name, armed: false, createdAt: nowMs, nodes: [], edges: [] };
}

export function isPlace(n: FlowNode): n is PlaceNode {
  return n.kind === "place";
}

export function isPlanned(n: FlowNode): n is PlannedNode {
  return n.kind === "planned";
}

export function isNotify(n: FlowNode): n is NotifyNode {
  return n.kind === "notify";
}

export function findNode(flow: Flow, id: string): FlowNode | undefined {
  return flow.nodes.find((n) => n.id === id);
}

/** Every edge pointing at `nodeId`, in flow order. Flow order is what makes a
 * join deterministic: an "all" junction performs the action of its first incoming
 * edge, and "first" has to mean something stable. */
export function incomingEdges(flow: Flow, nodeId: string): FlowEdge[] {
  return flow.edges.filter((e) => e.to === nodeId);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/engine/orchestrator/model.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/engine/orchestrator/model.ts test/unit/engine/orchestrator/model.test.ts
git commit -m "feat(orchestrator): add the flow model, node guards and edge lookups"
```

---

## Task 2: `evalCond` — the condition vocabulary

**Files:**
- Create: `src/engine/orchestrator/conditions.ts`
- Test: `test/unit/engine/orchestrator/conditions.test.ts`

**Interfaces:**
- Consumes: `Condition` from Task 1.
- Produces: `CondContext { status: RunStatus; repo: string; nowMs: number }` and `evalCond(cond: Condition, c: CondContext): boolean`. Task 4 calls `evalCond`; Task 3 adds `describeCond` to this same file.

Note on one design point: agent conditions are about **the node's place**, not the whole run, so they read the agents whose `repo` matches the node (an agent with no `repo` belongs to a single-repo run and always matches) and reduce them with the existing `mostActive` from `engine/status.ts`. When no agent is there at all, they fall back to the run-level `status.agent`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine/orchestrator/conditions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { evalCond, CondContext } from "../../../../src/engine/orchestrator/conditions";
import { Condition } from "../../../../src/engine/orchestrator/model";
import { AgentState, CardAgent, PrEntryMap, PrFacts, RepoGit, Run, RunStatus } from "../../../../src/types";

const NOW = 1_800_000_000_000;
const REPO = "agent-flow";

const facts = (over: Partial<PrFacts> = {}): PrFacts => ({
  number: 1, url: "https://github.com/o/r/pull/1", title: "t", state: "OPEN", isDraft: false,
  ci: { passing: 2, pending: 0, failing: [] }, review: "none", unresolved: null,
  mergeable: "clean", ciAdvisory: false, ...over,
});

const git = (over: Partial<RepoGit> = {}): RepoGit => ({
  name: REPO, path: `/r/${REPO}`, branch: "main", dirty: false, ahead: 0,
  added: 0, removed: 0, files: 0, ...over,
});

const cardAgent = (state: AgentState, lastActivityMs: number | null, repo?: string): CardAgent => ({
  session: { pid: 1, sessionId: `s-${state}`, cwd: `/r/${REPO}`, startedAt: 1, name: "af-7e" },
  activity: { state, lastActivityMs, slug: null },
  repo,
});

const run: Run = {
  key: "ASM-1", summary: "s", url: "https://j/browse/ASM-1", createdAt: 1,
  mode: "multiroot", repos: [{ name: REPO, path: `/r/${REPO}`, isGit: true }], briefPaths: [],
};

const ctx = (over: Partial<RunStatus> = {}, prs: PrEntryMap = {}): CondContext => ({
  repo: REPO,
  nowMs: NOW,
  status: {
    run, column: "progress", jiraStatus: null, jiraCategory: null,
    repos: [git()], agent: { state: "unknown", lastActivityMs: null, slug: null },
    windowOpen: false, prs, agents: [], ...over,
  },
});

const pr = (over: Partial<PrFacts> = {}): PrEntryMap => ({ [REPO]: { facts: facts(over), fetchedAt: NOW } });
const met = (cond: Condition, c: CondContext) => evalCond(cond, c);

describe("evalCond — PR and CI", () => {
  it("pr-merged is true only for a merged PR", () => {
    expect(met({ kind: "pr-merged" }, ctx({}, pr({ state: "MERGED" })))).toBe(true);
    expect(met({ kind: "pr-merged" }, ctx({}, pr({ state: "OPEN" })))).toBe(false);
  });

  it("pr-merged is false when the repo has no PR at all", () => {
    expect(met({ kind: "pr-merged" }, ctx())).toBe(false);
    expect(met({ kind: "pr-merged" }, ctx({}, { [REPO]: { facts: null, fetchedAt: NOW } }))).toBe(false);
  });

  it("ci-passed needs at least one passing check and nothing failing or pending", () => {
    expect(met({ kind: "ci-passed" }, ctx({}, pr({ ci: { passing: 7, pending: 0, failing: [] } })))).toBe(true);
    expect(met({ kind: "ci-passed" }, ctx({}, pr({ ci: { passing: 4, pending: 3, failing: [] } })))).toBe(false);
    expect(met({ kind: "ci-passed" }, ctx({}, pr({ ci: { passing: 7, pending: 0, failing: [{ name: "lint", url: "" }] } })))).toBe(false);
  });

  it("ci-passed is false when no check has reported yet", () => {
    expect(met({ kind: "ci-passed" }, ctx({}, pr({ ci: { passing: 0, pending: 0, failing: [] } })))).toBe(false);
  });

  it("ci-failed fires on a required failure", () => {
    expect(met({ kind: "ci-failed" }, ctx({}, pr({ ci: { passing: 1, pending: 0, failing: [{ name: "build", url: "" }] } })))).toBe(true);
  });

  it("ci-failed does NOT fire when the only failures are advisory", () => {
    // Every required check passed and something optional did not. It does not
    // block a merge, so it must not trigger a fix agent.
    const c = ctx({}, pr({ ci: { passing: 9, pending: 0, failing: [{ name: "flaky-e2e", url: "" }] }, ciAdvisory: true }));
    expect(met({ kind: "ci-failed" }, c)).toBe(false);
  });

  it("review-approved and changes-requested read the review decision", () => {
    expect(met({ kind: "review-approved" }, ctx({}, pr({ review: "approved" })))).toBe(true);
    expect(met({ kind: "review-approved" }, ctx({}, pr({ review: "review_required" })))).toBe(false);
    expect(met({ kind: "changes-requested" }, ctx({}, pr({ review: "changes_requested" })))).toBe(true);
    expect(met({ kind: "changes-requested" }, ctx({}, pr({ review: "approved" })))).toBe(false);
  });

  it("threads-resolved is true at zero and false when the count was never fetched", () => {
    expect(met({ kind: "threads-resolved" }, ctx({}, pr({ unresolved: 0 })))).toBe(true);
    expect(met({ kind: "threads-resolved" }, ctx({}, pr({ unresolved: 2 })))).toBe(false);
    // null means the GraphQL call was skipped — absence of evidence, not zero.
    expect(met({ kind: "threads-resolved" }, ctx({}, pr({ unresolved: null })))).toBe(false);
  });

  it("pr-conflicting reads mergeability", () => {
    expect(met({ kind: "pr-conflicting" }, ctx({}, pr({ mergeable: "conflicting" })))).toBe(true);
    expect(met({ kind: "pr-conflicting" }, ctx({}, pr({ mergeable: "clean" })))).toBe(false);
  });

  it("reads the node's own repo, not the run's first PR", () => {
    const prs: PrEntryMap = {
      other: { facts: facts({ state: "MERGED" }), fetchedAt: NOW },
      [REPO]: { facts: facts({ state: "OPEN" }), fetchedAt: NOW },
    };
    expect(met({ kind: "pr-merged" }, ctx({}, prs))).toBe(false);
  });
});

describe("evalCond — agent state", () => {
  it("agent-ended-turn is true when the place's agent needs you", () => {
    expect(met({ kind: "agent-ended-turn" }, ctx({ agents: [cardAgent("needs-you", NOW, REPO)] }))).toBe(true);
    expect(met({ kind: "agent-ended-turn" }, ctx({ agents: [cardAgent("working", NOW, REPO)] }))).toBe(false);
  });

  it("an agent with no repo belongs to the place anyway", () => {
    expect(met({ kind: "agent-ended-turn" }, ctx({ agents: [cardAgent("needs-you", NOW)] }))).toBe(true);
  });

  it("ignores an agent that belongs to a different repo", () => {
    expect(met({ kind: "agent-ended-turn" }, ctx({ agents: [cardAgent("needs-you", NOW, "elsewhere")] }))).toBe(false);
  });

  it("falls back to the run-level state when no agent is attached to the place", () => {
    const c = ctx({ agents: [], agent: { state: "needs-you", lastActivityMs: NOW, slug: null } });
    expect(met({ kind: "agent-ended-turn" }, c)).toBe(true);
  });

  it("agent-idle-over compares against the parameterised window", () => {
    const idleFor = (ms: number) => ctx({ agents: [cardAgent("idle", NOW - ms, REPO)] });
    expect(met({ kind: "agent-idle-over", minutes: 10 }, idleFor(11 * 60_000))).toBe(true);
    expect(met({ kind: "agent-idle-over", minutes: 10 }, idleFor(9 * 60_000))).toBe(false);
  });

  it("agent-idle-over is false for an agent that is working, however long ago", () => {
    expect(met({ kind: "agent-idle-over", minutes: 1 }, ctx({ agents: [cardAgent("working", NOW - 99 * 60_000, REPO)] }))).toBe(false);
  });

  it("agent-idle-over is false when the last activity is unknown", () => {
    expect(met({ kind: "agent-idle-over", minutes: 1 }, ctx({ agents: [cardAgent("idle", null, REPO)] }))).toBe(false);
  });

  it("no agent condition can fire while the state is unknown", () => {
    // What the Live signal toggle being off looks like from here.
    const off = ctx({ agents: [cardAgent("unknown", null, REPO)] });
    expect(met({ kind: "agent-ended-turn" }, off)).toBe(false);
    expect(met({ kind: "agent-idle-over", minutes: 0 }, off)).toBe(false);
  });

  it("no-agent-left does not need the Live signal — it reads the session registry", () => {
    // The registry knows a session is open whether or not its transcript is read,
    // so this condition is meaningful even when every state is unknown.
    expect(met({ kind: "no-agent-left" }, ctx({ agents: [cardAgent("unknown", null, REPO)] }))).toBe(false);
    expect(met({ kind: "no-agent-left" }, ctx({ agents: [] }))).toBe(true);
  });

  it("no-agent-left is true only when the place has no session", () => {
    expect(met({ kind: "no-agent-left" }, ctx({ agents: [] }))).toBe(true);
    expect(met({ kind: "no-agent-left" }, ctx({ agents: [cardAgent("idle", NOW, REPO)] }))).toBe(false);
    expect(met({ kind: "no-agent-left" }, ctx({ agents: [cardAgent("idle", NOW, "elsewhere")] }))).toBe(true);
  });
});

describe("evalCond — git", () => {
  it("tree-clean and has-uncommitted are opposites over a known repo", () => {
    expect(met({ kind: "tree-clean" }, ctx({ repos: [git({ dirty: false })] }))).toBe(true);
    expect(met({ kind: "has-uncommitted" }, ctx({ repos: [git({ dirty: false })] }))).toBe(false);
    expect(met({ kind: "tree-clean" }, ctx({ repos: [git({ dirty: true })] }))).toBe(false);
    expect(met({ kind: "has-uncommitted" }, ctx({ repos: [git({ dirty: true })] }))).toBe(true);
  });

  it("both are false when the node's repo is not in the status at all", () => {
    const c = ctx({ repos: [git({ name: "elsewhere" })] });
    expect(met({ kind: "tree-clean" }, c)).toBe(false);
    expect(met({ kind: "has-uncommitted" }, c)).toBe(false);
  });

  it("nothing-to-push is true at zero commits ahead", () => {
    expect(met({ kind: "nothing-to-push" }, ctx({ repos: [git({ ahead: 0 })] }))).toBe(true);
    expect(met({ kind: "nothing-to-push" }, ctx({ repos: [git({ ahead: 2 })] }))).toBe(false);
  });
});

describe("evalCond — Jira", () => {
  it("ticket-done reads the category", () => {
    expect(met({ kind: "ticket-done" }, ctx({ jiraCategory: "done" }))).toBe(true);
    expect(met({ kind: "ticket-done" }, ctx({ jiraCategory: "indeterminate" }))).toBe(false);
    expect(met({ kind: "ticket-done" }, ctx({ jiraCategory: null }))).toBe(false);
  });

  it("ticket-status-is matches the exact status", () => {
    expect(met({ kind: "ticket-status-is", status: "PR initiated" }, ctx({ jiraStatus: "PR initiated" }))).toBe(true);
    expect(met({ kind: "ticket-status-is", status: "PR initiated" }, ctx({ jiraStatus: "In Progress" }))).toBe(false);
    expect(met({ kind: "ticket-status-is", status: "PR initiated" }, ctx({ jiraStatus: null }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/engine/orchestrator/conditions.test.ts`
Expected: FAIL — cannot resolve `conditions`.

- [ ] **Step 3: Write the implementation**

Create `src/engine/orchestrator/conditions.ts`:

```ts
// One condition, one place, one answer. Every predicate here is a pure function of
// a single `RunStatus` — the snapshot `buildRunStatus` already builds for the board
// — so the whole vocabulary is table-testable and adds no I/O of its own. Adding a
// condition that needs a new fact means teaching the Deck to observe it first.
import { AgentActivity, PrFacts, RepoGit, RunStatus } from "../../types";
import { mostActive } from "../status";
import { Condition } from "./model";

export interface CondContext {
  status: RunStatus;
  /** The node's repo. A place node always resolves to exactly one, so no
   * condition is ever ambiguous about which repo's git or PR it means. */
  repo: string;
  nowMs: number;
}

function facts(c: CondContext): PrFacts | null {
  return c.status.prs[c.repo]?.facts ?? null;
}

function git(c: CondContext): RepoGit | undefined {
  return c.status.repos.find((r) => r.name === c.repo);
}

/** The sessions running in this node's place. `repo` is absent on a local card's
 * agents, which have exactly one repo to belong to — so absent matches. */
function agentsHere(c: CondContext) {
  return c.status.agents.filter((a) => a.repo === undefined || a.repo === c.repo);
}

/** Live state of this place, not of the whole run: a two-worktree run can have one
 * agent working and one waiting on you, and a rule about one must not read the
 * other. Falls back to the run-level aggregate when nothing is attached here. */
function activity(c: CondContext): AgentActivity {
  const here = agentsHere(c);
  return here.length > 0 ? mostActive(here.map((a) => a.activity)) : c.status.agent;
}

export function evalCond(cond: Condition, c: CondContext): boolean {
  switch (cond.kind) {
    case "pr-merged":
      return facts(c)?.state === "MERGED";
    case "ci-passed": {
      const f = facts(c);
      // `passing > 0` matters: a PR whose checks have not reported yet has nothing
      // failing and nothing pending, and "no checks at all" is not "CI passed".
      return !!f && f.ci.failing.length === 0 && f.ci.pending === 0 && f.ci.passing > 0;
    }
    case "ci-failed": {
      const f = facts(c);
      // Advisory failures are excluded: every required check passed and something
      // optional did not, which does not block a merge and must not launch a fix.
      return !!f && f.ci.failing.length > 0 && !f.ciAdvisory;
    }
    case "review-approved":
      return facts(c)?.review === "approved";
    case "changes-requested":
      return facts(c)?.review === "changes_requested";
    case "threads-resolved":
      // Strictly zero. `null` means the GraphQL call was skipped — absence of
      // evidence, which is not evidence of zero.
      return facts(c)?.unresolved === 0;
    case "pr-conflicting":
      return facts(c)?.mergeable === "conflicting";
    case "agent-ended-turn":
      return activity(c).state === "needs-you";
    case "agent-idle-over": {
      const a = activity(c);
      if (a.state !== "idle" || a.lastActivityMs === null) return false;
      return c.nowMs - a.lastActivityMs > cond.minutes * 60_000;
    }
    case "no-agent-left":
      return agentsHere(c).length === 0;
    case "tree-clean":
      // `!!g &&` rather than `!g?.dirty`: a repo missing from the status is not a
      // clean repo, it is a repo we know nothing about.
      return !!git(c) && !git(c)!.dirty;
    case "has-uncommitted":
      return git(c)?.dirty === true;
    case "nothing-to-push": {
      const g = git(c);
      // `ahead` is 0 both when everything is pushed and when there is no upstream
      // at all. The condition is named for what it can actually prove.
      return !!g && g.ahead === 0;
    }
    case "ticket-done":
      return c.status.jiraCategory === "done";
    case "ticket-status-is":
      return c.status.jiraStatus === cond.status;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/engine/orchestrator/conditions.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, then check this file's coverage**

Run: `npx tsc --noEmit`
Run: `npx vitest run --coverage test/unit/engine/orchestrator/conditions.test.ts`
Expected: `conditions.ts` at 100% lines. If any branch is uncovered, add the case rather than lowering the bar.

- [ ] **Step 6: Commit**

```bash
git add src/engine/orchestrator/conditions.ts test/unit/engine/orchestrator/conditions.test.ts
git commit -m "feat(orchestrator): evaluate a flow condition against one place's status"
```

---

## Task 3: `describeCond` — where a condition currently stands

**Files:**
- Modify: `src/engine/orchestrator/conditions.ts`
- Modify: `test/unit/engine/orchestrator/conditions.test.ts`

**Interfaces:**
- Consumes: `CondContext` and the fixtures from Task 2.
- Produces: `describeCond(cond: Condition, c: CondContext): string` — the phrase the drawer puts after `waiting · `. Phase 4's inspector renders it; nothing in Phase 1 calls it.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/engine/orchestrator/conditions.test.ts`, and add `describeCond` to the existing import from `conditions`:

```ts
describe("describeCond", () => {
  it("describes CI progress rather than the condition's name", () => {
    expect(describeCond({ kind: "ci-passed" }, ctx({}, pr({ ci: { passing: 4, pending: 3, failing: [] } }))))
      .toBe("CI running, 4 of 7");
  });

  it("names the failing checks", () => {
    const c = ctx({}, pr({ ci: { passing: 5, pending: 0, failing: [{ name: "build", url: "" }, { name: "lint", url: "" }] } }));
    expect(describeCond({ kind: "ci-failed" }, c)).toBe("build, lint failing");
  });

  it("counts passing checks when nothing is failing or pending", () => {
    expect(describeCond({ kind: "ci-passed" }, ctx({}, pr({ ci: { passing: 7, pending: 0, failing: [] } }))))
      .toBe("7 checks passing");
  });

  it("says so when there is no PR to describe", () => {
    expect(describeCond({ kind: "pr-merged" }, ctx())).toBe("no PR yet");
  });

  it("describes a PR's state and review", () => {
    expect(describeCond({ kind: "pr-merged" }, ctx({}, pr({ state: "MERGED" })))).toBe("merged");
    expect(describeCond({ kind: "pr-merged" }, ctx({}, pr({ state: "OPEN" })))).toBe("PR open");
    expect(describeCond({ kind: "review-approved" }, ctx({}, pr({ review: "approved" })))).toBe("approved");
    expect(describeCond({ kind: "review-approved" }, ctx({}, pr({ review: "review_required" })))).toBe("review required");
    expect(describeCond({ kind: "changes-requested" }, ctx({}, pr({ review: "changes_requested" })))).toBe("changes requested");
  });

  it("describes threads and mergeability", () => {
    expect(describeCond({ kind: "threads-resolved" }, ctx({}, pr({ unresolved: 2 })))).toBe("2 unresolved");
    expect(describeCond({ kind: "threads-resolved" }, ctx({}, pr({ unresolved: 0 })))).toBe("no unresolved threads");
    expect(describeCond({ kind: "threads-resolved" }, ctx({}, pr({ unresolved: null })))).toBe("threads not checked");
    expect(describeCond({ kind: "pr-conflicting" }, ctx({}, pr({ mergeable: "conflicting" })))).toBe("conflicting");
    expect(describeCond({ kind: "pr-conflicting" }, ctx({}, pr({ mergeable: "clean" })))).toBe("mergeable: clean");
  });

  it("describes agent state, and admits when it cannot see one", () => {
    expect(describeCond({ kind: "agent-ended-turn" }, ctx({ agents: [cardAgent("working", NOW, REPO)] }))).toBe("working");
    expect(describeCond({ kind: "agent-ended-turn" }, ctx({ agents: [cardAgent("needs-you", NOW, REPO)] }))).toBe("ended turn");
    expect(describeCond({ kind: "agent-idle-over", minutes: 10 }, ctx({ agents: [cardAgent("idle", NOW - 4 * 60_000, REPO)] })))
      .toBe("idle 4m of 10m");
    expect(describeCond({ kind: "agent-idle-over", minutes: 10 }, ctx({ agents: [cardAgent("idle", null, REPO)] })))
      .toBe("last activity unknown");
    expect(describeCond({ kind: "agent-ended-turn" }, ctx({ agents: [cardAgent("unknown", null, REPO)] })))
      .toBe("agent state unknown");
  });

  it("describes how many agents are in the place", () => {
    expect(describeCond({ kind: "no-agent-left" }, ctx({ agents: [] }))).toBe("no agent");
    expect(describeCond({ kind: "no-agent-left" }, ctx({ agents: [cardAgent("idle", NOW, REPO)] }))).toBe("1 agent open");
    expect(describeCond({ kind: "no-agent-left" }, ctx({ agents: [cardAgent("idle", NOW, REPO), cardAgent("working", NOW, REPO)] })))
      .toBe("2 agents open");
  });

  it("describes git state", () => {
    expect(describeCond({ kind: "tree-clean" }, ctx({ repos: [git({ dirty: false })] }))).toBe("clean");
    expect(describeCond({ kind: "has-uncommitted" }, ctx({ repos: [git({ dirty: true, added: 412, removed: 38, files: 9 })] })))
      .toBe("+412 −38 · 9 files");
    expect(describeCond({ kind: "nothing-to-push" }, ctx({ repos: [git({ ahead: 2 })] }))).toBe("2 to push");
    expect(describeCond({ kind: "nothing-to-push" }, ctx({ repos: [git({ ahead: 0 })] }))).toBe("nothing to push");
    expect(describeCond({ kind: "tree-clean" }, ctx({ repos: [git({ name: "elsewhere" })] }))).toBe("repo not found");
  });

  it("describes Jira", () => {
    expect(describeCond({ kind: "ticket-done" }, ctx({ jiraStatus: "In Progress" }))).toBe("In Progress");
    expect(describeCond({ kind: "ticket-status-is", status: "PR initiated" }, ctx({ jiraStatus: "In Progress" }))).toBe("In Progress");
    expect(describeCond({ kind: "ticket-done" }, ctx({ jiraStatus: null }))).toBe("no Jira status");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/engine/orchestrator/conditions.test.ts`
Expected: FAIL — `describeCond` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/engine/orchestrator/conditions.ts`:

```ts
/** What this place looks like with respect to this condition, right now. The
 * drawer renders it after "waiting · ", so it describes the OBSERVATION, not the
 * rule: "CI running, 4 of 7" tells you why nothing has fired, where "CI passed"
 * would only repeat the condition back at you.
 *
 * Prose, not identifiers — the Deck sets English in the UI font and keeps
 * monospace for keys, branches and counts. */
export function describeCond(cond: Condition, c: CondContext): string {
  switch (cond.kind) {
    case "pr-merged": {
      const f = facts(c);
      if (!f) return "no PR yet";
      return f.state === "MERGED" ? "merged" : f.state === "CLOSED" ? "PR closed" : "PR open";
    }
    case "ci-passed":
    case "ci-failed": {
      const f = facts(c);
      if (!f) return "no PR yet";
      const { passing, pending, failing } = f.ci;
      if (failing.length > 0) return `${failing.map((k) => k.name).join(", ")} failing`;
      if (pending > 0) return `CI running, ${passing} of ${passing + pending}`;
      return passing > 0 ? `${passing} checks passing` : "no checks yet";
    }
    case "review-approved":
    case "changes-requested": {
      const f = facts(c);
      if (!f) return "no PR yet";
      const words: Record<PrFacts["review"], string> = {
        approved: "approved",
        changes_requested: "changes requested",
        review_required: "review required",
        none: "no review yet",
      };
      return words[f.review];
    }
    case "threads-resolved": {
      const f = facts(c);
      if (!f) return "no PR yet";
      if (f.unresolved === null) return "threads not checked";
      return f.unresolved === 0 ? "no unresolved threads" : `${f.unresolved} unresolved`;
    }
    case "pr-conflicting": {
      const f = facts(c);
      if (!f) return "no PR yet";
      return f.mergeable === "conflicting" ? "conflicting" : `mergeable: ${f.mergeable}`;
    }
    case "agent-ended-turn": {
      const a = activity(c);
      if (a.state === "unknown") return "agent state unknown";
      return a.state === "needs-you" ? "ended turn" : a.state;
    }
    case "agent-idle-over": {
      const a = activity(c);
      if (a.state === "unknown") return "agent state unknown";
      if (a.lastActivityMs === null) return "last activity unknown";
      if (a.state !== "idle") return a.state === "needs-you" ? "ended turn" : a.state;
      return `idle ${Math.floor((c.nowMs - a.lastActivityMs) / 60_000)}m of ${cond.minutes}m`;
    }
    case "no-agent-left": {
      const n = agentsHere(c).length;
      return n === 0 ? "no agent" : n === 1 ? "1 agent open" : `${n} agents open`;
    }
    case "tree-clean":
    case "has-uncommitted": {
      const g = git(c);
      if (!g) return "repo not found";
      // The same minus sign the Deck's diff chips use, not a hyphen.
      return g.dirty ? `+${g.added} −${g.removed} · ${g.files} files` : "clean";
    }
    case "nothing-to-push": {
      const g = git(c);
      if (!g) return "repo not found";
      return g.ahead === 0 ? "nothing to push" : `${g.ahead} to push`;
    }
    case "ticket-done":
    case "ticket-status-is":
      return c.status.jiraStatus ?? "no Jira status";
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/engine/orchestrator/conditions.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and coverage**

Run: `npx tsc --noEmit`
Run: `npx vitest run --coverage test/unit/engine/orchestrator/conditions.test.ts`
Expected: `conditions.ts` ≥95% lines.

- [ ] **Step 6: Commit**

```bash
git add src/engine/orchestrator/conditions.ts test/unit/engine/orchestrator/conditions.test.ts
git commit -m "feat(orchestrator): describe where a condition currently stands"
```

---

## Task 4: `evaluate.ts` — the latch, the join and the cap

**Files:**
- Create: `src/engine/orchestrator/evaluate.ts`
- Test: `test/unit/engine/orchestrator/evaluate.test.ts`

**Interfaces:**
- Consumes: `Flow`, `FlowEdge`, `isPlace`, `findNode`, `incomingEdges` from Task 1; `evalCond`, `CondContext` from Task 2.
- Produces: `EvalInput`, `FiredEdge`, `BlockedNote`, `EvalResult`, `MAX_LAUNCHES_PER_PASS`, and `evaluateFlow(input: EvalInput): EvalResult`. Phase 2's runner consumes `EvalResult`.

The rules this function encodes, all of which the tests pin:

1. A disarmed flow yields nothing.
2. An edge with `firedAt` or `error` is never evaluated — that is the latch.
3. An edge whose source is a planned node cannot be evaluated; there is no run to observe yet. Not blocked, just not ready.
4. An edge whose source is a place node with no matching status is **blocked** (`gone`), so an armed flow reports it instead of waiting forever.
5. An agent condition over a place whose agent state is `unknown` is **blocked** (`agent-state-unknown`) — it can never become true, and silence would look like patience.
6. `join: "all"` on a target fires only when every incoming edge is settled or met, and then performs the action of the **first still-pending edge in flow order** while stamping all the pending ones. A settled edge cannot perform again, which is why the performer is the first *pending* edge and not simply the first incoming one. Two corollaries the review of Task 4 forced out:
   - **An `error` on any incoming edge stops the junction dead** until that edge is reset. Otherwise a failed performer's junction silently re-routes its action through a sibling, violating "a failed action is never retried until Reset".
   - **A junction whose performer the cap would defer fires nothing at all**, and counts as one deferred. Stamping the siblings while holding the performer back strands the junction the moment its condition stops holding: the siblings stay stamped, the performer never runs, and nothing is reported.
   `join: "any"`, or a target with one incoming edge, fires each met edge independently.
7. At most `MAX_LAUNCHES_PER_PASS` acting edges (`launch` or `seed`) fire per pass, in flow order; the rest are counted in `deferred`. `notify` is never capped — it costs a toast.

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine/orchestrator/evaluate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { evaluateFlow, MAX_LAUNCHES_PER_PASS } from "../../../../src/engine/orchestrator/evaluate";
import {
  Flow, FlowEdge, FlowNode, JoinMode, NotifyNode, PlaceNode, PlannedNode, emptyFlow,
} from "../../../../src/engine/orchestrator/model";
import { CardAgent, PrEntryMap, PrFacts, RepoGit, Run, RunStatus } from "../../../../src/types";

const NOW = 1_800_000_000_000;

const facts = (over: Partial<PrFacts> = {}): PrFacts => ({
  number: 1, url: "u", title: "t", state: "OPEN", isDraft: false,
  ci: { passing: 2, pending: 0, failing: [] }, review: "none", unresolved: null,
  mergeable: "clean", ciAdvisory: false, ...over,
});

/** A status for `key` whose single repo is named after the key, merged or not. */
const status = (key: string, over: { merged?: boolean; agents?: CardAgent[]; unknownAgent?: boolean } = {}): RunStatus => {
  const repo = `repo-${key}`;
  const git: RepoGit = { name: repo, path: `/r/${repo}`, branch: "b", dirty: false, ahead: 0, added: 0, removed: 0, files: 0 };
  const run: Run = { key, summary: "s", url: `https://j/browse/${key}`, createdAt: 1, mode: "multiroot",
    repos: [{ name: repo, path: `/r/${repo}`, isGit: true }], briefPaths: [] };
  const prs: PrEntryMap = { [repo]: { facts: facts({ state: over.merged ? "MERGED" : "OPEN" }), fetchedAt: NOW } };
  return {
    run, column: "progress", jiraStatus: null, jiraCategory: null, repos: [git],
    agent: { state: over.unknownAgent ? "unknown" : "working", lastActivityMs: NOW, slug: null },
    windowOpen: false, prs, agents: over.agents ?? [],
  };
};

// Concrete node types with an explicit join, so no test needs a cast to reach it.
const place = (id: string, runKey: string, join: JoinMode = "any"): PlaceNode =>
  ({ id, kind: "place", x: 0, y: 0, join, runKey, repo: `repo-${runKey}` });
const planned = (id: string, join: JoinMode = "any"): PlannedNode =>
  ({ id, kind: "planned", x: 0, y: 0, join, ticketKey: "ASM-99", repos: ["r"], mode: "tdd", dest: "worktree" });
const notify = (id: string, join: JoinMode = "any"): NotifyNode =>
  ({ id, kind: "notify", x: 0, y: 0, join, message: "done" });

const edge = (id: string, from: string, to: string, over: Partial<FlowEdge> = {}): FlowEdge =>
  ({ id, from, to, cond: { kind: "pr-merged" }, action: "notify", ...over });

const flowWith = (nodes: FlowNode[], edges: FlowEdge[], armed = true): Flow =>
  ({ ...emptyFlow("f1", "f", 0), armed, nodes, edges });

const run = (flow: Flow, statuses: RunStatus[], maxLaunches?: number) =>
  evaluateFlow({ flow, statuses, nowMs: NOW, maxLaunches });

describe("evaluateFlow — arming and the latch", () => {
  it("yields nothing for a disarmed flow, even when the condition is met", () => {
    const flow = flowWith([place("a", "ASM-1"), notify("z")], [edge("e1", "a", "z")], false);
    expect(run(flow, [status("ASM-1", { merged: true })])).toEqual({ fired: [], blocked: [], deferred: 0 });
  });

  it("fires a met edge exactly once", () => {
    const flow = flowWith([place("a", "ASM-1"), notify("z")], [edge("e1", "a", "z")]);
    const first = run(flow, [status("ASM-1", { merged: true })]);
    expect(first.fired.map((f) => f.edge.id)).toEqual(["e1"]);

    // The runner stamps firedAt; the next pass must skip it.
    flow.edges[0].firedAt = NOW;
    expect(run(flow, [status("ASM-1", { merged: true })]).fired).toEqual([]);
  });

  it("never re-evaluates an edge whose action errored", () => {
    const flow = flowWith([place("a", "ASM-1"), notify("z")], [edge("e1", "a", "z", { error: "worktree exists" })]);
    expect(run(flow, [status("ASM-1", { merged: true })]).fired).toEqual([]);
  });

  it("does not fire an unmet edge", () => {
    const flow = flowWith([place("a", "ASM-1"), notify("z")], [edge("e1", "a", "z")]);
    expect(run(flow, [status("ASM-1", { merged: false })]).fired).toEqual([]);
  });
});

describe("evaluateFlow — nodes it cannot evaluate", () => {
  it("blocks an edge whose source run is gone", () => {
    const flow = flowWith([place("a", "ASM-1"), notify("z")], [edge("e1", "a", "z")]);
    const r = run(flow, []); // no status for ASM-1 — the run was forgotten
    expect(r.fired).toEqual([]);
    expect(r.blocked).toEqual([{ nodeId: "a", reason: "gone" }]);
  });

  it("does not block an edge from a planned node — it is simply not launched yet", () => {
    const flow = flowWith([planned("p"), notify("z")], [edge("e1", "p", "z")]);
    expect(run(flow, [])).toEqual({ fired: [], blocked: [], deferred: 0 });
  });

  it("blocks an agent condition when the agent state is unknown", () => {
    const flow = flowWith([place("a", "ASM-1"), notify("z")],
      [edge("e1", "a", "z", { cond: { kind: "agent-ended-turn" } })]);
    const r = run(flow, [status("ASM-1", { unknownAgent: true })]);
    expect(r.fired).toEqual([]);
    expect(r.blocked).toEqual([{ nodeId: "a", reason: "agent-state-unknown" }]);
  });

  it("does not block a non-agent condition when the agent state is unknown", () => {
    const flow = flowWith([place("a", "ASM-1"), notify("z")], [edge("e1", "a", "z")]);
    const r = run(flow, [status("ASM-1", { merged: true, unknownAgent: true })]);
    expect(r.blocked).toEqual([]);
    expect(r.fired.map((f) => f.edge.id)).toEqual(["e1"]);
  });

  it("reports a gone node once, not once per edge leaving it", () => {
    const flow = flowWith([place("a", "ASM-1"), notify("y"), notify("z")],
      [edge("e1", "a", "y"), edge("e2", "a", "z")]);
    expect(run(flow, []).blocked).toEqual([{ nodeId: "a", reason: "gone" }]);
  });

  it("ignores an edge whose target does not exist", () => {
    const flow = flowWith([place("a", "ASM-1")], [edge("e1", "a", "missing")]);
    expect(run(flow, [status("ASM-1", { merged: true })]).fired).toEqual([]);
  });
});

describe("evaluateFlow — join", () => {
  const twoIn = (join: "any" | "all") =>
    flowWith([place("a", "ASM-1"), place("b", "ASM-2"), notify("z", join)],
      [edge("e1", "a", "z"), edge("e2", "b", "z")]);

  it("with join any, each met edge fires on its own", () => {
    const r = run(twoIn("any"), [status("ASM-1", { merged: true }), status("ASM-2", { merged: false })]);
    expect(r.fired.map((f) => f.edge.id)).toEqual(["e1"]);
  });

  it("with join all, one met edge fires nothing", () => {
    const r = run(twoIn("all"), [status("ASM-1", { merged: true }), status("ASM-2", { merged: false })]);
    expect(r.fired).toEqual([]);
  });

  it("with join all, every edge fires once the last one is met", () => {
    const r = run(twoIn("all"), [status("ASM-1", { merged: true }), status("ASM-2", { merged: true })]);
    expect(r.fired.map((f) => f.edge.id)).toEqual(["e1", "e2"]);
  });

  it("with join all, an already-fired edge counts as met", () => {
    const flow = twoIn("all");
    flow.edges[0].firedAt = NOW - 1;
    const r = run(flow, [status("ASM-1", { merged: false }), status("ASM-2", { merged: true })]);
    expect(r.fired.map((f) => f.edge.id)).toEqual(["e2"]);
  });

  it("with join all, the action performed is the first incoming edge's", () => {
    const flow = flowWith([place("a", "ASM-1"), place("b", "ASM-2"), planned("z", "all")],
      [edge("e1", "a", "z", { action: "launch", mode: "tdd" }),
       edge("e2", "b", "z", { action: "seed", mode: "plan" })]);
    const r = run(flow, [status("ASM-1", { merged: true }), status("ASM-2", { merged: true })]);
    expect(r.fired.map((f) => ({ id: f.edge.id, perform: f.perform }))).toEqual([
      { id: "e1", perform: true },
      { id: "e2", perform: false },
    ]);
  });

  it("join is irrelevant to a target with a single incoming edge", () => {
    const flow = flowWith([place("a", "ASM-1"), notify("z", "all")], [edge("e1", "a", "z")]);
    expect(run(flow, [status("ASM-1", { merged: true })]).fired.map((f) => f.edge.id)).toEqual(["e1"]);
  });
});

describe("evaluateFlow — the launch cap", () => {
  const manyLaunches = (n: number) => {
    const nodes: FlowNode[] = [];
    const edges: FlowEdge[] = [];
    for (let i = 0; i < n; i++) {
      nodes.push(place(`a${i}`, `ASM-${i}`), planned(`p${i}`));
      edges.push(edge(`e${i}`, `a${i}`, `p${i}`, { action: "launch", mode: "tdd" }));
    }
    return { flow: flowWith(nodes, edges), statuses: Array.from({ length: n }, (_, i) => status(`ASM-${i}`, { merged: true })) };
  };

  it("caps acting edges at the default and counts the rest as deferred", () => {
    const { flow, statuses } = manyLaunches(MAX_LAUNCHES_PER_PASS + 2);
    const r = run(flow, statuses);
    expect(r.fired).toHaveLength(MAX_LAUNCHES_PER_PASS);
    expect(r.deferred).toBe(2);
  });

  it("caps in flow order, so a deferred edge is the last one", () => {
    const { flow, statuses } = manyLaunches(MAX_LAUNCHES_PER_PASS + 1);
    const r = run(flow, statuses);
    expect(r.fired.map((f) => f.edge.id)).toEqual(
      Array.from({ length: MAX_LAUNCHES_PER_PASS }, (_, i) => `e${i}`));
  });

  it("honours an explicit cap", () => {
    const { flow, statuses } = manyLaunches(3);
    const r = run(flow, statuses, 1);
    expect(r.fired).toHaveLength(1);
    expect(r.deferred).toBe(2);
  });

  it("never caps notify edges", () => {
    const nodes: FlowNode[] = [];
    const edges: FlowEdge[] = [];
    for (let i = 0; i < MAX_LAUNCHES_PER_PASS + 3; i++) {
      nodes.push(place(`a${i}`, `ASM-${i}`), notify(`z${i}`));
      edges.push(edge(`e${i}`, `a${i}`, `z${i}`));
    }
    const statuses = Array.from({ length: MAX_LAUNCHES_PER_PASS + 3 }, (_, i) => status(`ASM-${i}`, { merged: true }));
    const r = run(flowWith(nodes, edges), statuses);
    expect(r.fired).toHaveLength(MAX_LAUNCHES_PER_PASS + 3);
    expect(r.deferred).toBe(0);
  });

  it("counts a capped all-join's non-performing edges against nothing", () => {
    // Only the performing edge of an "all" junction consumes a launch slot.
    const flow = flowWith([place("a", "ASM-1"), place("b", "ASM-2"), planned("z", "all")],
      [edge("e1", "a", "z", { action: "launch", mode: "tdd" }),
       edge("e2", "b", "z", { action: "launch", mode: "tdd" })]);
    const r = run(flow, [status("ASM-1", { merged: true }), status("ASM-2", { merged: true })], 1);
    expect(r.fired.map((f) => f.edge.id)).toEqual(["e1", "e2"]);
    expect(r.deferred).toBe(0);
  });

  it("a deferred all-join performer still performs on the next pass", () => {
    // The cap can strand a junction half-stamped: its performer is deferred while
    // its siblings are stamped fired. That must resolve on a later pass, not leave
    // a junction that is fully stamped and never acted on.
    const flow = flowWith(
      [place("a", "ASM-1"), planned("p", "any"),
       place("b", "ASM-2"), place("c", "ASM-3"), planned("z", "all")],
      [edge("e0", "a", "p", { action: "launch", mode: "tdd" }),
       edge("e1", "b", "z", { action: "launch", mode: "tdd" }),
       edge("e2", "c", "z", { action: "launch", mode: "tdd" })]);
    const statuses = [status("ASM-1", { merged: true }), status("ASM-2", { merged: true }), status("ASM-3", { merged: true })];

    const first = run(flow, statuses, 1);
    expect(first.fired.filter((f) => f.perform).map((f) => f.edge.id)).toEqual(["e0"]);
    expect(first.deferred).toBe(1);
    // e2 was stamped without performing; e1, the performer, was held back.
    expect(first.fired.map((f) => f.edge.id)).toEqual(["e0", "e2"]);

    // The runner stamps what fired. Next pass, with the slot free:
    for (const id of ["e0", "e2"]) flow.edges.find((e) => e.id === id)!.firedAt = NOW;
    const second = run(flow, statuses, 1);
    expect(second.fired.map((f) => ({ id: f.edge.id, perform: f.perform }))).toEqual([{ id: "e1", perform: true }]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/engine/orchestrator/evaluate.test.ts`
Expected: FAIL — cannot resolve `evaluate`.

- [ ] **Step 3: Write the implementation**

Create `src/engine/orchestrator/evaluate.ts`:

```ts
// The verdict function, in the shape of `engine/retire.ts`: pure, total, and
// acting on nothing. It answers one question per pass — which edges should fire
// right now — and leaves performing them, and stamping `firedAt`, to the runner.
// Keeping the decision separate from the action is what makes the latch, the join
// and the cap testable without launching a window.
import { RunStatus } from "../../types";
import { CondContext, evalCond } from "./conditions";
import { Flow, FlowEdge, findNode, incomingEdges, isPlace } from "./model";

/** How many acting edges (`launch` or `seed`) may fire in one pass. A badly wired
 * graph should not be able to storm your window manager; the remainder is reported
 * as `deferred` and fires on later passes. */
export const MAX_LAUNCHES_PER_PASS = 3;

/** Conditions that can only ever be true when the Live signal is readable, because
 * they ask what an agent is *doing*. `no-agent-left` is deliberately NOT here: it
 * counts sessions in the registry, which is populated whether or not any transcript
 * is read — and it is exactly the condition that should fire when nothing is there,
 * so blocking it on an unknown state would invert it. */
const AGENT_CONDS = new Set(["agent-ended-turn", "agent-idle-over"]);

export interface EvalInput {
  flow: Flow;
  /** Every status the Deck built this pass, in any order. */
  statuses: RunStatus[];
  nowMs: number;
  /** Defaults to `MAX_LAUNCHES_PER_PASS`. */
  maxLaunches?: number;
}

export interface FiredEdge {
  edge: FlowEdge;
  /** Should the runner perform this edge's action, or only stamp it as fired? An
   * "all" junction stamps every incoming edge but acts once. */
  perform: boolean;
}

/** Why an armed flow is not advancing — surfaced in the drawer's footer, because
 * a flow that silently waits on something impossible looks like patience. */
export interface BlockedNote {
  nodeId: string;
  reason: "gone" | "agent-state-unknown";
}

export interface EvalResult {
  fired: FiredEdge[];
  blocked: BlockedNote[];
  deferred: number;
}

/** Has this edge already run? Either verdict is terminal until Reset clears it. */
function settled(e: FlowEdge): boolean {
  return e.firedAt !== undefined || e.error !== undefined;
}

export function evaluateFlow(i: EvalInput): EvalResult {
  // A fresh object rather than a shared constant: a caller that mutates the result
  // must not be able to poison every later disarmed pass.
  if (!i.flow.armed) return { fired: [], blocked: [], deferred: 0 };

  const byKey = new Map(i.statuses.map((s) => [s.run.key, s]));
  const blocked: BlockedNote[] = [];
  const seenBlocked = new Set<string>();
  const note = (nodeId: string, reason: BlockedNote["reason"]) => {
    // One note per node, not per edge leaving it: two edges from a forgotten run
    // are one problem, and the footer should say it once.
    const at = `${nodeId}:${reason}`;
    if (seenBlocked.has(at)) return;
    seenBlocked.add(at);
    blocked.push({ nodeId, reason });
  };

  /** Is this edge's condition true right now? `undefined` means "cannot say". */
  const isMet = (e: FlowEdge): boolean | undefined => {
    const from = findNode(i.flow, e.from);
    // A planned source has no run to observe yet. Not a problem — just not ready.
    if (!from || !isPlace(from)) return undefined;
    const status = byKey.get(from.runKey);
    if (!status) {
      note(from.id, "gone");
      return undefined;
    }
    const c: CondContext = { status, repo: from.repo, nowMs: i.nowMs };
    if (AGENT_CONDS.has(e.cond.kind) && status.agent.state === "unknown"
        && status.agents.every((a) => a.activity.state === "unknown")) {
      note(from.id, "agent-state-unknown");
      return undefined;
    }
    return evalCond(e.cond, c);
  };

  // Memoised so an "all" junction re-reading its siblings costs nothing and cannot
  // record a blocked note twice.
  const metCache = new Map<string, boolean | undefined>();
  const met = (e: FlowEdge): boolean | undefined => {
    if (!metCache.has(e.id)) metCache.set(e.id, isMet(e));
    return metCache.get(e.id);
  };

  const candidates: FiredEdge[] = [];
  const handledTargets = new Set<string>();

  for (const edge of i.flow.edges) {
    if (settled(edge)) continue;
    const target = findNode(i.flow, edge.to);
    if (!target) continue;

    const incoming = incomingEdges(i.flow, edge.to);
    const isAllJoin = target.join === "all" && incoming.length > 1;

    if (!isAllJoin) {
      if (met(edge) === true) candidates.push({ edge, perform: true });
      continue;
    }

    // An "all" junction is decided once, for the whole junction.
    if (handledTargets.has(edge.to)) continue;
    handledTargets.add(edge.to);
    // Already-fired siblings count as met: the junction closes over time, not in
    // one instant, and a flow that forgot its earlier arrivals would never close.
    const allMet = incoming.every((e) => e.firedAt !== undefined || met(e) === true);
    if (!allMet) continue;
    const pending = incoming.filter((e) => !settled(e));
    // The first incoming edge in flow order performs; the rest are only stamped.
    // Flow order is stable, which is what makes this deterministic.
    pending.forEach((e, idx) => candidates.push({ edge: e, perform: idx === 0 }));
  }

  // Cap only what costs something. A notify is a toast; a launch is a window.
  const cap = i.maxLaunches ?? MAX_LAUNCHES_PER_PASS;
  const fired: FiredEdge[] = [];
  let acting = 0;
  let deferred = 0;
  for (const c of candidates) {
    const costs = c.perform && (c.edge.action === "launch" || c.edge.action === "seed");
    if (costs && acting >= cap) {
      deferred++;
      continue;
    }
    if (costs) acting++;
    fired.push(c);
  }

  return { fired, blocked, deferred };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/engine/orchestrator/evaluate.test.ts`
Expected: PASS, including the two-pass deferred-performer case — a junction the cap stranded half-stamped resolves on the next pass rather than staying fully stamped and never acted on.

- [ ] **Step 5: Typecheck and coverage**

Run: `npx tsc --noEmit`
Run: `npx vitest run --coverage test/unit/engine/orchestrator/evaluate.test.ts`
Expected: `evaluate.ts` ≥95% lines.

- [ ] **Step 6: Commit**

```bash
git add src/engine/orchestrator/evaluate.ts test/unit/engine/orchestrator/evaluate.test.ts
git commit -m "feat(orchestrator): decide which flow edges fire, with a latch and a cap"
```

---

## Task 5: `store.ts` — flow persistence

**Files:**
- Create: `src/engine/orchestrator/store.ts`
- Test: `test/unit/engine/orchestrator/store.test.ts`

**Interfaces:**
- Consumes: `Flow` from Task 1.
- Produces: `FlowIo`, `defaultFlowsDir()`, `readFlows(io, dir)`, `writeFlow(io, dir, flow)`, `removeFlow(io, dir, id)`. Phase 2 supplies a real `fs`-backed `FlowIo` from the host side.

`FlowIo` is injected for the same reason `retire.ts` injects `exists`: it keeps this module free of `fs` and every rule testable without a temp directory.

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine/orchestrator/store.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import * as os from "os";
import * as path from "path";
import { FlowIo, defaultFlowsDir, readFlows, writeFlow, removeFlow } from "../../../../src/engine/orchestrator/store";
import { Flow, emptyFlow } from "../../../../src/engine/orchestrator/model";

/** An in-memory FlowIo. `files` is the whole store; `removed` records deletions. */
const fakeIo = (files: Record<string, string> = {}) => {
  const removed: string[] = [];
  const io: FlowIo = {
    readDir: (dir) => Object.keys(files).filter((p) => p.startsWith(dir + "/")).map((p) => path.basename(p)),
    readFile: (p) => files[p] ?? null,
    writeFile: (p, text) => { files[p] = text; },
    remove: (p) => { removed.push(p); delete files[p]; },
  };
  return { io, files, removed };
};

const DIR = "/store/flows";
const flow = (over: Partial<Flow> = {}): Flow => ({ ...emptyFlow("f1", "Ship it", 1_000), ...over });

describe("defaultFlowsDir", () => {
  it("sits beside the runs store under the home directory", () => {
    expect(defaultFlowsDir()).toBe(path.join(os.homedir(), ".agentflow", "flows"));
  });
});

describe("writeFlow / readFlows", () => {
  it("round-trips a flow", () => {
    const { io, files } = fakeIo();
    writeFlow(io, DIR, flow());
    expect(Object.keys(files)).toEqual([path.join(DIR, "f1.json")]);
    expect(readFlows(io, DIR)).toEqual([flow()]);
  });

  it("writes pretty JSON with a trailing newline, like the runs store", () => {
    const { io, files } = fakeIo();
    writeFlow(io, DIR, flow());
    const text = files[path.join(DIR, "f1.json")];
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('\n  "id": "f1"');
  });

  it("overwrites a flow with the same id", () => {
    const { io } = fakeIo();
    writeFlow(io, DIR, flow({ name: "first" }));
    writeFlow(io, DIR, flow({ name: "second" }));
    expect(readFlows(io, DIR).map((f) => f.name)).toEqual(["second"]);
  });

  it("persists the armed flag", () => {
    const { io } = fakeIo();
    writeFlow(io, DIR, flow({ armed: true }));
    expect(readFlows(io, DIR)[0].armed).toBe(true);
  });

  it("returns flows newest first", () => {
    const { io } = fakeIo();
    writeFlow(io, DIR, flow({ id: "old", createdAt: 100 }));
    writeFlow(io, DIR, flow({ id: "new", createdAt: 900 }));
    expect(readFlows(io, DIR).map((f) => f.id)).toEqual(["new", "old"]);
  });

  it("preserves a field it does not know about", () => {
    // A newer build's field must survive an older build reading and rewriting it.
    const p = path.join(DIR, "f1.json");
    const { io, files } = fakeIo({ [p]: JSON.stringify({ ...flow(), futureThing: 42 }) });
    const read = readFlows(io, DIR);
    writeFlow(io, DIR, read[0]);
    expect(JSON.parse(files[p]).futureThing).toBe(42);
  });
});

describe("readFlows — a store it cannot trust", () => {
  it("is empty when the directory cannot be listed", () => {
    const io: FlowIo = {
      readDir: () => { throw new Error("ENOENT"); },
      readFile: () => null, writeFile: () => {}, remove: () => {},
    };
    expect(readFlows(io, DIR)).toEqual([]);
  });

  it("skips a corrupt file rather than blowing up the whole drawer", () => {
    const { io } = fakeIo({
      [path.join(DIR, "bad.json")]: "{ not json",
      [path.join(DIR, "f1.json")]: JSON.stringify(flow()),
    });
    expect(readFlows(io, DIR).map((f) => f.id)).toEqual(["f1"]);
  });

  it("skips a file that parses but is not a flow", () => {
    const { io } = fakeIo({
      [path.join(DIR, "a.json")]: JSON.stringify({ id: "a" }), // no nodes/edges arrays
      [path.join(DIR, "b.json")]: JSON.stringify({ nodes: [], edges: [] }), // no id
      [path.join(DIR, "c.json")]: "null",
      [path.join(DIR, "f1.json")]: JSON.stringify(flow()),
    });
    expect(readFlows(io, DIR).map((f) => f.id)).toEqual(["f1"]);
  });

  it("ignores anything that is not a .json file", () => {
    const { io } = fakeIo({
      [path.join(DIR, "notes.txt")]: "hello",
      [path.join(DIR, "f1.json")]: JSON.stringify(flow()),
    });
    expect(readFlows(io, DIR).map((f) => f.id)).toEqual(["f1"]);
  });

  it("treats a missing createdAt as oldest rather than sorting by NaN", () => {
    const { io } = fakeIo({
      [path.join(DIR, "a.json")]: JSON.stringify({ id: "a", name: "a", armed: false, nodes: [], edges: [] }),
      [path.join(DIR, "b.json")]: JSON.stringify(flow({ id: "b", createdAt: 5 })),
    });
    expect(readFlows(io, DIR).map((f) => f.id)).toEqual(["b", "a"]);
  });
});

describe("removeFlow", () => {
  it("removes the file for one id", () => {
    const { io, removed } = fakeIo({ [path.join(DIR, "f1.json")]: JSON.stringify(flow()) });
    removeFlow(io, DIR, "f1");
    expect(removed).toEqual([path.join(DIR, "f1.json")]);
    expect(readFlows(io, DIR)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/engine/orchestrator/store.test.ts`
Expected: FAIL — cannot resolve `store`.

- [ ] **Step 3: Write the implementation**

Create `src/engine/orchestrator/store.ts`:

```ts
// Flow persistence, one file per flow, beside the runs store. IO is injected for
// the same reason `retire.ts` injects `exists`: it keeps this module free of `fs`
// and every rule here testable without a temp directory.
import * as os from "os";
import * as path from "path";
import { Flow } from "./model";

/** The only IO surface. Implementations return null / throw only from `readDir`;
 * `readFile` returns null for anything it cannot read, so one unreadable file
 * degrades a single flow rather than the whole drawer. */
export interface FlowIo {
  readDir(dir: string): string[];
  readFile(p: string): string | null;
  writeFile(p: string, text: string): void;
  remove(p: string): void;
}

export function defaultFlowsDir(): string {
  return path.join(os.homedir(), ".agentflow", "flows");
}

function fileFor(dir: string, id: string): string {
  return path.join(dir, `${id}.json`);
}

/** Enough of a shape check to keep a hand-edited or half-written file out of the
 * drawer. Deliberately not a full validation: unknown fields must ride along
 * untouched so a newer build's flow survives an older build rewriting it. */
function looksLikeFlow(v: unknown): v is Flow {
  if (!v || typeof v !== "object") return false;
  const f = v as Partial<Flow>;
  return typeof f.id === "string" && Array.isArray(f.nodes) && Array.isArray(f.edges);
}

export function writeFlow(io: FlowIo, dir: string, flow: Flow): void {
  io.writeFile(fileFor(dir, flow.id), JSON.stringify(flow, null, 2) + "\n");
}

/** Every flow in the store, newest first. Malformed files are skipped, not fatal. */
export function readFlows(io: FlowIo, dir: string): Flow[] {
  let names: string[];
  try {
    names = io.readDir(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const flows: Flow[] = [];
  for (const name of names) {
    const text = io.readFile(path.join(dir, name));
    if (text === null) continue;
    try {
      const parsed: unknown = JSON.parse(text);
      if (looksLikeFlow(parsed)) flows.push(parsed);
    } catch {
      /* skip a corrupt/half-written flow rather than empty the drawer */
    }
  }
  // `?? 0` rather than trusting the field: a record written before `createdAt`
  // existed, or hand-edited without it, must sort as oldest and not as NaN —
  // which would make the comparator inconsistent and the order arbitrary.
  return flows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export function removeFlow(io: FlowIo, dir: string, id: string): void {
  io.remove(fileFor(dir, id));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/engine/orchestrator/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and coverage**

Run: `npx tsc --noEmit`
Run: `npx vitest run --coverage test/unit/engine/orchestrator/store.test.ts`
Expected: `store.ts` at 100% lines.

- [ ] **Step 6: Commit**

```bash
git add src/engine/orchestrator/store.ts test/unit/engine/orchestrator/store.test.ts
git commit -m "feat(orchestrator): persist flows over an injected IO surface"
```

---

## Task 6: `layout.ts` — canvas geometry

**Files:**
- Create: `src/engine/orchestrator/layout.ts`
- Test: `test/unit/engine/orchestrator/layout.test.ts`

**Interfaces:**
- Consumes: `Flow`, `FlowNode` from Task 1.
- Produces: `Point`, `Box`, `NODE_W`, `NODE_H`, `COL_GAP`, `ROW_GAP`, `GRID`, `anchor(box, side)`, `edgePath(a, b)`, `labelPoint(a, b)`, `snap(v)`, `tidy(flow)`. Phase 4's canvas imports all of them.

Keeping this out of the component is what makes the canvas testable at all: the geometry is where the bugs live, and none of it needs a DOM.

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine/orchestrator/layout.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  anchor, edgePath, labelPoint, snap, tidy, NODE_W, NODE_H, COL_GAP, ROW_GAP, GRID, Box,
} from "../../../../src/engine/orchestrator/layout";
import { Flow, FlowEdge, FlowNode, emptyFlow } from "../../../../src/engine/orchestrator/model";

const box = (x: number, y: number, w = NODE_W, h = NODE_H): Box => ({ x, y, w, h });

const node = (id: string, x = 0, y = 0): FlowNode =>
  ({ id, kind: "place", x, y, join: "any", runKey: id, repo: "r" });
const edge = (id: string, from: string, to: string): FlowEdge =>
  ({ id, from, to, cond: { kind: "pr-merged" }, action: "notify" });
const flowWith = (nodes: FlowNode[], edges: FlowEdge[]): Flow =>
  ({ ...emptyFlow("f1", "f", 0), nodes, edges });

describe("anchor", () => {
  it("puts the out port on the right edge, vertically centred", () => {
    expect(anchor(box(10, 20), "out")).toEqual({ x: 10 + NODE_W, y: 20 + NODE_H / 2 });
  });

  it("puts the in port on the left edge, vertically centred", () => {
    expect(anchor(box(10, 20), "in")).toEqual({ x: 10, y: 20 + NODE_H / 2 });
  });

  it("uses the box's own height, not the constant", () => {
    expect(anchor(box(0, 0, NODE_W, 100), "in").y).toBe(50);
  });
});

describe("edgePath", () => {
  it("is a cubic bezier from a to b with horizontal control points", () => {
    expect(edgePath({ x: 0, y: 0 }, { x: 200, y: 100 })).toBe("M0,0 C100,0 100,100 200,100");
  });

  it("keeps a minimum horizontal reach so a short hop still curves", () => {
    // dx would be 10; the floor keeps the curve readable instead of a kink.
    expect(edgePath({ x: 0, y: 0 }, { x: 20, y: 60 })).toBe("M0,0 C28,0 -8,60 20,60");
  });

  it("handles a backwards edge by swinging its control points outward", () => {
    expect(edgePath({ x: 300, y: 0 }, { x: 0, y: 0 })).toBe("M300,0 C450,0 -150,0 0,0");
  });
});

describe("labelPoint", () => {
  it("is the midpoint of the two anchors", () => {
    expect(labelPoint({ x: 0, y: 0 }, { x: 100, y: 50 })).toEqual({ x: 50, y: 25 });
  });
});

describe("snap", () => {
  it("rounds to the grid and never goes negative", () => {
    expect(snap(11)).toBe(8);
    expect(snap(13)).toBe(16);
    expect(snap(-40)).toBe(0);
    expect(snap(GRID * 3)).toBe(GRID * 3);
  });
});

describe("tidy", () => {
  it("puts a root in the first column", () => {
    const [n] = tidy(flowWith([node("a", 999, 999)], []));
    expect(n).toMatchObject({ id: "a", x: GRID * 3, y: GRID * 3 });
  });

  it("puts a target one column right of its source", () => {
    const out = tidy(flowWith([node("a"), node("b")], [edge("e1", "a", "b")]));
    const [a, b] = out;
    expect(b.x - a.x).toBe(COL_GAP);
    expect(b.y).toBe(a.y);
  });

  it("stacks siblings in the same column", () => {
    const out = tidy(flowWith([node("a"), node("b"), node("c")],
      [edge("e1", "a", "b"), edge("e2", "a", "c")]));
    const b = out.find((n) => n.id === "b")!;
    const c = out.find((n) => n.id === "c")!;
    expect(b.x).toBe(c.x);
    expect(c.y - b.y).toBe(ROW_GAP);
  });

  it("uses the longest path, so a node behind two hops lands in column three", () => {
    const out = tidy(flowWith([node("a"), node("b"), node("z")],
      [edge("e1", "a", "b"), edge("e2", "b", "z"), edge("e3", "a", "z")]));
    const a = out.find((n) => n.id === "a")!;
    const z = out.find((n) => n.id === "z")!;
    expect(z.x - a.x).toBe(COL_GAP * 2);
  });

  it("terminates on a cycle and still assigns finite coordinates", () => {
    const out = tidy(flowWith([node("a"), node("b")], [edge("e1", "a", "b"), edge("e2", "b", "a")]));
    expect(out).toHaveLength(2);
    for (const n of out) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });

  it("returns new node objects and leaves the flow untouched", () => {
    const flow = flowWith([node("a", 999, 999)], []);
    const out = tidy(flow);
    expect(flow.nodes[0]).toMatchObject({ x: 999, y: 999 });
    expect(out[0]).not.toBe(flow.nodes[0]);
  });

  it("preserves every non-positional field", () => {
    const flow = flowWith([node("a", 5, 5)], []);
    expect(tidy(flow)[0]).toMatchObject({ id: "a", kind: "place", join: "any", runKey: "a", repo: "r" });
  });

  it("is empty for an empty flow", () => {
    expect(tidy(flowWith([], []))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/engine/orchestrator/layout.test.ts`
Expected: FAIL — cannot resolve `layout`.

- [ ] **Step 3: Write the implementation**

Create `src/engine/orchestrator/layout.ts`:

```ts
// Canvas geometry, kept out of the component on purpose: this is where the bugs
// live, and none of it needs a DOM. The drawer's canvas imports all of it.
import { Flow, FlowNode } from "./model";

export interface Point { x: number; y: number }
export interface Box { x: number; y: number; w: number; h: number }

/** Wide enough for a state dot, a ticket key and the one fact the rules read.
 * Narrower and a node degenerates into a bare key. */
export const NODE_W = 168;
/** The two-line default. `anchor` reads the measured box instead wherever a real
 * element is available, so a taller node still ports from its own middle. */
export const NODE_H = 44;
/** Column pitch. Wider than NODE_W by enough that a condition label sitting over
 * the connector does not span the whole gap. */
export const COL_GAP = 296;
export const ROW_GAP = 88;
export const GRID = 8;

export function anchor(b: Box, side: "in" | "out"): Point {
  return { x: side === "out" ? b.x + b.w : b.x, y: b.y + b.h / 2 };
}

/** A cubic bezier with horizontal control points, so every edge leaves and enters
 * its ports level. The floor on the reach keeps a short hop curved rather than
 * kinked — two nodes in adjacent columns are the common case. */
export function edgePath(a: Point, b: Point): string {
  const dx = Math.max(28, Math.abs(b.x - a.x) * 0.5);
  return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
}

export function labelPoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Snap a dragged coordinate to the grid, clamped at the canvas edge. */
export function snap(v: number): number {
  return Math.max(0, Math.round(v / GRID) * GRID);
}

/**
 * Auto-layout: depth-major columns, siblings stacked. Depth is the LONGEST path
 * to a node, so a node reachable in one hop and in two sits in column three and
 * no edge ever points backwards.
 *
 * The relaxation is bounded by the node count rather than run to a fixed point,
 * which is what makes a cycle terminate: a graph the drawer should not have let
 * you build still gets finite coordinates instead of hanging the webview.
 *
 * Returns new nodes; the flow is untouched, so the caller decides whether a tidy
 * is a saved change.
 */
export function tidy(flow: Flow): FlowNode[] {
  const depth = new Map<string, number>(flow.nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass < flow.nodes.length; pass++) {
    let moved = false;
    for (const e of flow.edges) {
      if (!depth.has(e.from) || !depth.has(e.to)) continue;
      const want = depth.get(e.from)! + 1;
      if (want > depth.get(e.to)!) {
        depth.set(e.to, want);
        moved = true;
      }
    }
    if (!moved) break;
  }

  const filled = new Map<number, number>();
  return flow.nodes.map((n) => {
    const d = depth.get(n.id) ?? 0;
    const row = filled.get(d) ?? 0;
    filled.set(d, row + 1);
    return { ...n, x: GRID * 3 + d * COL_GAP, y: GRID * 3 + row * ROW_GAP };
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/engine/orchestrator/layout.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and full-suite check**

Run: `npx tsc --noEmit`
Run: `npx vitest run`
Expected: the whole suite green — this phase touched no existing module, so nothing else may change.

- [ ] **Step 6: Coverage gate for the phase**

Run: `npx vitest run --coverage`
Expected: every file under `src/engine/orchestrator/` at ≥95% lines. Paste the five rows into the status file.

- [ ] **Step 7: Commit**

```bash
git add src/engine/orchestrator/layout.ts test/unit/engine/orchestrator/layout.test.ts
git commit -m "feat(orchestrator): add canvas geometry and auto-layout as pure functions"
```

---

## Done when

- Five files exist under `src/engine/orchestrator/`, none importing `vscode` or `fs`.
- `npx vitest run` is green and `npx tsc --noEmit` is silent.
- `npx vitest run --coverage` shows every new file ≥95% lines.
- `git diff main --stat` touches nothing outside `src/engine/orchestrator/` and `test/unit/engine/orchestrator/`.
- Nothing a user can reach has changed: no setting, no command, no message, no webview.

## What Phase 2 picks up

The runner (`src/orchestratorRunner.ts`), the `agentFlow.orchestrator` setting, the poll change and close confirmation in `deckView.ts`, and a drawer that can attach nodes and wire **notify** edges only. Arming will do something real, and nothing it can do will launch anything. `evaluateFlow`'s `EvalResult` is the seam: the runner consumes `fired`, stamps `firedAt` via `writeFlow`, and renders `blocked` in the footer.
