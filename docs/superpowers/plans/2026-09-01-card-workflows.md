# Card Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Deck card carry a reusable workflow — saved as a template, attached from the card, and shown moving live in the card's own drawer.

**Architecture:** Two new pure engine leaves (`templates.ts` turns a workflow into a reusable template and back; `attach.ts` derives which workflow belongs to a card and what state it is in), a new store directory alongside `flows/`, and a rebuilt card drawer whose new Workflow block is a **third presentation of the existing rule model** — it reads `previewFlow` and the edges' own stamps, which already ride the `deck:flows` post, so no new host message carries live state.

**Tech Stack:** TypeScript, React 18 (webview), esbuild, Vitest. `vscode` is aliased to the hand-written mock in `test/_mocks/vscode.ts`.

**Spec:** [`docs/superpowers/specs/2026-09-01-card-workflows-and-drawer-design.md`](../specs/2026-09-01-card-workflows-and-drawer-design.md) — and the engine decisions it builds on in [`2026-08-26-flow-templates-design.md`](../specs/2026-08-26-flow-templates-design.md). Read both; this plan argues from them.

## Global Constraints

- **Vocabulary is normative.** UI says **Template** (the reusable shape) and **Workflow** (a template attached to one card). The UI never says *flow* or *Orchestrator*. Code keeps `Flow`, `FlowTemplate`, `agentFlow.orchestrator`, `OrchestratorDrawer` and every `flow:*` message name unchanged.
- **Never break existing users.** `test/unit/compat.test.ts` must pass **unmodified**. No change to any setting id, command id, `SecretStorage`/`globalState`/`workspaceState` key, telemetry wire value, or the on-disk run shape. A test you had to edit to go green is the signal to stop and ask.
- **Webviews cannot reach Node.** Any module reachable from `src/webview/index.tsx`, `deck.tsx` or `marketplace.tsx` must not import `fs`, `os`, `path`, `child_process` (etc.) even transitively — esbuild resolves statically, so `npm run build` breaks while `tsc` and most of the suite still pass. `test/webview/webviewGraph.test.ts` is the near-gate and follows **relative imports only**.
- **Engine must not import from `src/webview/`.** Task 2 exists because the id minters currently live there.
- **No hardcoded organization values.** Anything configurable goes through `getConfig()` in `src/config.ts`. Use `PROJ-` in fixtures, never a real project key.
- **Gates, all four, every task:** `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:cov` thresholds (90% lines/statements, 85% branches/functions).
- **Running the suite:** ~6,000 tests / 161 files in about a minute. Pass `timeout: 600000` when running it through a tool. **Never pipe vitest through `tail` or `head`** — it loses the failure list. Prefer `npx vitest run <file>` or `-t "name"` while iterating. A single failure under CPU contention is usually flake: re-run that file alone before believing it.
- **Async reads leak across webview tests.** A `FileReader` can outlive a `setTimeout(0)`, landing its `postMessage` in the *next* test. Assert with `waitFor`, never a bare tick.
- **Webview test files** opt into jsdom with a `// @vitest-environment jsdom` docblock.
- **Commit frequently.** Verify a partial tree with `npm run typecheck`, never by grep.
- **Work in a git worktree** off `main`. `main` moves fast — re-check its HEAD before starting.

---

### Task 1: Extract `stripHostStamps` — all six fields

The strip that `flow:resetEdge` performs inline is about to gain a second caller (`toTemplate`). Extracting it first means a host-owned field added to `FlowEdge` later has one function to update, not two call sites to remember. The 26 Aug spec names four fields; the live handler deletes **six**.

**Files:**
- Modify: `src/engine/orchestrator/model.ts` (add export after `isSettled`)
- Modify: `src/deckView.ts:4326-4336` (the `flow:resetEdge` edge map)
- Test: `test/unit/engine/orchestrator/model.test.ts`

**Interfaces:**
- Consumes: `FlowEdge` from `model.ts`
- Produces: `stripHostStamps(e: FlowEdge): FlowEdge`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/engine/orchestrator/model.test.ts`:

```ts
describe("stripHostStamps", () => {
  const stamped: FlowEdge = {
    id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" },
    action: "run", mode: "plan", note: "my own words",
    firedAt: 1756200000000, firedNote: "ran · exit 0", performed: true,
    gateAnswer: "approved", error: "exit 1",
  };

  it("drops every host-owned stamp", () => {
    const out = stripHostStamps(stamped);
    expect(out.firedAt).toBeUndefined();
    expect(out.firedNote).toBeUndefined();
    expect(out.performed).toBeUndefined();
    expect(out.error).toBeUndefined();
    expect(out.action).toBeUndefined();
    expect(out.gateAnswer).toBeUndefined();
  });

  it("preserves the user's own configuration", () => {
    // An allow-list implementation of this strip once silently dropped `note`
    // on every Reset. `mode` has nowhere else to live for a seed.
    const out = stripHostStamps(stamped);
    expect(out.note).toBe("my own words");
    expect(out.mode).toBe("plan");
    expect(out.cond).toEqual({ kind: "pr-merged" });
    expect(out.id).toBe("e1");
    expect(out.from).toBe("n1");
    expect(out.to).toBe("n2");
  });

  it("does not mutate its argument", () => {
    stripHostStamps(stamped);
    expect(stamped.firedAt).toBe(1756200000000);
  });
});
```

Add `stripHostStamps` and `FlowEdge` to that file's import from `../../../../src/engine/orchestrator/model`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/engine/orchestrator/model.test.ts -t "stripHostStamps"`
Expected: FAIL — `stripHostStamps is not a function`

- [ ] **Step 3: Write minimal implementation**

In `src/engine/orchestrator/model.ts`:

```ts
/** Every field the HOST stamps onto an edge as it acts, removed — so the edge is
 * back to what the user configured. Two callers: `flow:resetEdge` (deckView.ts),
 * putting one rule back in play, and `toTemplate` (templates.ts), saving a shape
 * that must carry no history.
 *
 * Deliberately a DENY-list. It used to be an allow-list that rebuilt the edge
 * from its known non-host fields, and that allow-list silently dropped `note` —
 * the user's own words — every time anyone pressed Reset. A new host-owned field
 * on `FlowEdge` is therefore forgotten in exactly one place, here, rather than in
 * whichever of two call sites nobody remembered.
 *
 * `mode` and `note` survive on purpose: they are the user's configuration, not a
 * mirror of anything the host decided, and a seed's mode has nowhere else to live. */
export function stripHostStamps(e: FlowEdge): FlowEdge {
  const kept: FlowEdge = { ...e };
  delete kept.firedAt;
  delete kept.firedNote;
  delete kept.performed;
  delete kept.error;
  delete kept.action;
  delete kept.gateAnswer;
  return kept;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/engine/orchestrator/model.test.ts -t "stripHostStamps"`
Expected: PASS (3 tests)

- [ ] **Step 5: Point `flow:resetEdge` at the shared helper**

In `src/deckView.ts`, replace the edge map inside the `flow:resetEdge` handler (currently around line 4326):

```ts
          edges: flow.edges.map((e) => (e.id === m.edgeId ? stripHostStamps(e) : e)),
```

Add `stripHostStamps` to that file's existing import from `./engine/orchestrator/model`. Leave the comment block above the map exactly as it is — it explains *why* Reset is a deny-list and why `mode`/`note` survive, and that reasoning now lives in two places on purpose.

- [ ] **Step 6: Run the orchestrator and deckView suites**

Run: `npx vitest run test/unit/engine/orchestrator test/unit/deckView.test.ts`
Expected: PASS, with no test file edited. If a `flow:resetEdge` test fails, the extract changed behaviour — compare the six deletes against the original block before touching the test.

- [ ] **Step 7: Commit**

```bash
git add src/engine/orchestrator/model.ts src/deckView.ts test/unit/engine/orchestrator/model.test.ts
git commit -m "refactor(orchestrator): one deny-list for an edge's host stamps"
```

---

### Task 2: Move the id minters into the engine

`instantiate` must mint fresh node and edge ids, and `nextNodeId`/`nextEdgeId` currently live in `src/webview/orchestratorRule.ts`. An engine leaf importing from `src/webview/` is backwards and would couple the engine to a browser bundle. Move them down; re-export so every existing caller keeps working.

**Files:**
- Modify: `src/engine/orchestrator/model.ts`
- Modify: `src/webview/orchestratorRule.ts:975-996`
- Test: `test/unit/engine/orchestrator/model.test.ts`

**Interfaces:**
- Produces: `nextNodeId(flow: Flow): string`, `nextEdgeId(flow: Flow): string` — both from `model.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/engine/orchestrator/model.test.ts`:

```ts
describe("id minting", () => {
  const flow = (nodeIds: string[], edgeIds: string[]): Flow => ({
    id: "f1", name: "Ship it", armed: false, createdAt: 0,
    nodes: nodeIds.map((id) => ({ id, x: 0, y: 0, join: "any", kind: "notify", message: "" })),
    edges: edgeIds.map((id) => ({ id, from: "n1", to: "n2", cond: { kind: "pr-merged" } })),
  });

  it("mints the first free node id, not length + 1", () => {
    // A flow whose n2 was deleted has n1 and n3; length + 1 would mint n3 again.
    expect(nextNodeId(flow(["n1", "n3"], []))).toBe("n2");
  });

  it("mints the first free edge id", () => {
    expect(nextEdgeId(flow([], ["e1", "e2"]))).toBe("e3");
  });

  it("mints n1 and e1 for an empty flow", () => {
    expect(nextNodeId(flow([], []))).toBe("n1");
    expect(nextEdgeId(flow([], []))).toBe("e1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/engine/orchestrator/model.test.ts -t "id minting"`
Expected: FAIL — `nextNodeId is not a function`

- [ ] **Step 3: Move the three functions into `model.ts`**

Cut `nextId`, `nextNodeId` and `nextEdgeId` (with their comments) from `src/webview/orchestratorRule.ts` and paste them into `src/engine/orchestrator/model.ts`. Keep `nextId` module-private there. Add to the moved `nextNodeId`'s comment:

```ts
/** An id unique within this flow. Node ids are local to a flow.
 *
 * Lives here rather than in `orchestratorRule.ts` because `templates.ts` mints
 * ids too, and an engine leaf must not import from `src/webview/` — the webview
 * bundles for a browser target and the dependency only runs the other way. */
```

- [ ] **Step 4: Re-export from `orchestratorRule.ts`**

In `src/webview/orchestratorRule.ts`, add to the existing import from `../engine/orchestrator/model` and re-export, so the canvas, the list and their tests keep importing from where they always did:

```ts
// Moved to model.ts so `templates.ts` can mint ids without an engine module
// importing from `src/webview/`. Re-exported because both presentations and
// their tests import them from here.
export { nextNodeId, nextEdgeId } from "../engine/orchestrator/model";
```

- [ ] **Step 5: Run the affected suites**

Run: `npx vitest run test/unit/engine/orchestrator/model.test.ts test/webview`
Expected: PASS. No webview test should need editing — the import path they use is unchanged.

- [ ] **Step 6: Verify the build still resolves**

Run: `npm run build`
Expected: four bundles, no error. This is the gate that catches a webview module reaching Node — run it here because Task 2 moved code across that boundary.

- [ ] **Step 7: Commit**

```bash
git add src/engine/orchestrator/model.ts src/webview/orchestratorRule.ts test/unit/engine/orchestrator/model.test.ts
git commit -m "refactor(orchestrator): mint node and edge ids in the engine"
```

---

### Task 3: `templates.ts` — the type, `validTemplate`, and `instantiate`

**Files:**
- Create: `src/engine/orchestrator/templates.ts`
- Test: Create `test/unit/engine/orchestrator/templates.test.ts`

**Interfaces:**
- Consumes: `Flow`, `FlowNode`, `PlannedNode`, `FlowEdge`, `nextNodeId`, `nextEdgeId`, `stripHostStamps`, `isPlanned` from `model.ts`
- Produces:
  - `interface FlowTemplate { schema: 1; id: string; name: string; params: Record<string, never>; savedAt: number; flow: Flow }`
  - `TEMPLATE_SCHEMA = 1`
  - `validTemplate(v: unknown): FlowTemplate | null`
  - `instantiate(t: FlowTemplate, ticketKey: string, flowId: string, nowMs: number): Flow`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/engine/orchestrator/templates.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Flow, FlowEdge, FlowNode } from "../../../../src/engine/orchestrator/model";
import { instantiate, validTemplate, type FlowTemplate } from "../../../../src/engine/orchestrator/templates";

const planned = (id: string, ticketKey = ""): FlowNode => ({
  id, x: 0, y: 0, join: "any", kind: "planned", ticketKey, repos: ["ingest-worker"],
  mode: "plan", dest: "worktree",
});
const notify = (id: string): FlowNode => ({ id, x: 40, y: 0, join: "any", kind: "notify", message: "up" });
const edge = (id: string, from: string, to: string): FlowEdge =>
  ({ id, from, to, cond: { kind: "pr-merged" } });

const template = (over: Partial<FlowTemplate> = {}): FlowTemplate => ({
  schema: 1, id: "k3f9-ship", name: "Ship it", params: {}, savedAt: 1756200000000,
  flow: {
    id: "unused", name: "Ship it", armed: false, createdAt: 0,
    nodes: [planned("n1"), planned("n2"), notify("n3")],
    edges: [edge("e1", "n1", "n3"), edge("e2", "n2", "n3")],
  },
  ...over,
});

describe("instantiate", () => {
  it("binds the chosen ticket to EVERY planned node", () => {
    const f = instantiate(template(), "PROJ-142", "f-new", 1756300000000);
    const keys = f.nodes.filter((n) => n.kind === "planned").map((n) => (n as { ticketKey: string }).ticketKey);
    expect(keys).toEqual(["PROJ-142", "PROJ-142"]);
  });

  it("mints node and edge ids disjoint from the template's", () => {
    const t = template();
    const f = instantiate(t, "PROJ-142", "f-new", 1756300000000);
    // Edge ids key `outcomes` within a pass and are what Reset addresses; two
    // workflows from one template sharing them is a collision waiting for the
    // first cross-flow view.
    expect(f.nodes.map((n) => n.id)).not.toEqual(t.flow.nodes.map((n) => n.id));
    expect(new Set(f.edges.map((e) => e.id)).size).toBe(2);
  });

  it("keeps the wiring after re-minting ids", () => {
    const f = instantiate(template(), "PROJ-142", "f-new", 1756300000000);
    const byId = new Map(f.nodes.map((n) => [n.id, n]));
    // Both planned nodes still point at the one notify node.
    const targets = f.edges.map((e) => byId.get(e.to)?.kind);
    expect(targets).toEqual(["notify", "notify"]);
    expect(f.edges.every((e) => byId.get(e.from)?.kind === "planned")).toBe(true);
  });

  it("carries no host stamps and no consent", () => {
    const t = template();
    t.flow.edges[0] = { ...t.flow.edges[0], firedAt: 1, firedNote: "x", error: "y", performed: true };
    t.flow.launchConfirmedAt = 1;
    t.flow.commandConfirmedAt = 2;
    const f = instantiate(t, "PROJ-142", "f-new", 1756300000000);
    expect(f.edges.every((e) => e.firedAt === undefined && e.error === undefined)).toBe(true);
    expect(f.edges.every((e) => e.firedNote === undefined && e.performed === undefined)).toBe(true);
    expect(f.launchConfirmedAt).toBeUndefined();
    expect(f.commandConfirmedAt).toBeUndefined();
  });

  it("is disarmed, freshly stamped, and takes the given id", () => {
    const f = instantiate(template(), "PROJ-142", "f-new", 1756300000000);
    expect(f.armed).toBe(false);
    expect(f.createdAt).toBe(1756300000000);
    expect(f.id).toBe("f-new");
  });

  it("keeps the template's name verbatim — no {ticket} substitution", () => {
    const f = instantiate(template({ name: "Ship {ticket}" }), "PROJ-142", "f-new", 0);
    expect(f.name).toBe("Ship {ticket}");
  });

  it("refuses a template with no planned nodes", () => {
    const t = template();
    t.flow.nodes = [notify("n3")];
    t.flow.edges = [];
    expect(() => instantiate(t, "PROJ-142", "f-new", 0)).toThrow(/nothing to bind/i);
  });
});

describe("validTemplate", () => {
  it("accepts a well-formed envelope", () => {
    expect(validTemplate(JSON.parse(JSON.stringify(template())))?.name).toBe("Ship it");
  });

  it("rejects a bare Flow — a moved flow file is not a template", () => {
    expect(validTemplate(template().flow)).toBeNull();
  });

  it("rejects a schema this build does not know", () => {
    // A template is executed by being COPIED, so an unrecognised shape would be
    // copied into a live workflow wholesale. Unlike a flow file, where an unknown
    // node kind rides along on purpose.
    expect(validTemplate({ ...template(), schema: 2 })).toBeNull();
  });

  it("rejects an id outside the path-safe charset", () => {
    expect(validTemplate({ ...template(), id: "../../../.zshrc" })).toBeNull();
  });

  it("rejects a missing name or flow", () => {
    expect(validTemplate({ ...template(), name: 42 })).toBeNull();
    expect(validTemplate({ ...template(), flow: null })).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/engine/orchestrator/templates.test.ts`
Expected: FAIL — cannot resolve `../../../../src/engine/orchestrator/templates`

- [ ] **Step 3: Write the implementation**

Create `src/engine/orchestrator/templates.ts`:

```ts
// A template is a workflow's shape with the ticket taken out — the one thing that
// names a piece of work. Everything else the shape encodes (repos, prompt modes,
// launch destinations, commands, notes, join modes, every condition) is a property
// of the shape and travels with it.
//
// PURE LEAF, and that is load-bearing: the Deck's card drawer imports this, the
// webview bundles for a browser target, and esbuild resolves statically — one hop
// into a module that reaches `fs`, `os`, `path` or `child_process` and
// `npm run build` stops resolving while `tsc` and the tests pass regardless. This
// file may import `model.ts` and nothing else.
import {
  Flow, FlowEdge, FlowNode, isPlanned, nextEdgeId, nextNodeId, stripHostStamps,
} from "./model";

/** The one schema this build knows how to copy into a live workflow. */
export const TEMPLATE_SCHEMA = 1;

/** Same charset `store.ts`'s `VALID_FLOW_ID` enforces, and for the same reason:
 * an id is turned straight into a path. Restated rather than imported because
 * `store.ts` reaches `os` and `path`, and this file must stay a leaf. `store.ts`
 * validates again on the way to disk — the two agreeing is asserted in
 * `store.test.ts`. */
const VALID_TEMPLATE_ID = /^[A-Za-z0-9_-]+$/;

/** A template on disk: an envelope, never a bare `Flow`.
 *
 * The envelope earns its keep by making a mis-filed file fail to parse. A bare
 * `Flow` sitting in the templates directory is indistinguishable from a flow
 * somebody moved there, and a reader pointed at either directory would load it
 * into the drawer as a real, armable workflow. Two shapes, two readers, no
 * overlap.
 *
 * `params` is reserved and empty in v1 — the ticket is the only parameter, and
 * the field exists so a second one later is additive rather than a migration. */
export interface FlowTemplate {
  schema: typeof TEMPLATE_SCHEMA;
  id: string;
  name: string;
  params: Record<string, never>;
  savedAt: number;
  flow: Flow;
}

/** Is this parsed JSON a template this build can use? Returns the value rather
 * than a boolean so callers get the narrowed type without a second cast. */
export function validTemplate(v: unknown): FlowTemplate | null {
  if (typeof v !== "object" || v === null) return null;
  const t = v as Partial<FlowTemplate>;
  if (t.schema !== TEMPLATE_SCHEMA) return null;
  if (typeof t.id !== "string" || !VALID_TEMPLATE_ID.test(t.id)) return null;
  if (typeof t.name !== "string") return null;
  if (typeof t.savedAt !== "number") return null;
  if (typeof t.flow !== "object" || t.flow === null) return null;
  const f = t.flow as Partial<Flow>;
  if (!Array.isArray(f.nodes) || !Array.isArray(f.edges)) return null;
  return t as FlowTemplate;
}

/** A live workflow from a template, bound to one ticket.
 *
 * Pure over an injected flow id and clock for the reason `evaluateFlow` is: the
 * whole substitution is table-testable from fixtures, with no filesystem, no
 * panel and no `Date.now()`.
 *
 * Throws rather than returning a workflow that can never launch anything: a
 * template with no planned node has nothing to bind the ticket to, and the result
 * would be a graph of commands and notifications rooted at nothing, waiting
 * forever. */
export function instantiate(t: FlowTemplate, ticketKey: string, flowId: string, nowMs: number): Flow {
  if (!t.flow.nodes.some(isPlanned)) {
    throw new Error(`template ${JSON.stringify(t.name)} has no planned step: nothing to bind ${ticketKey} to`);
  }

  // Build the fresh flow incrementally so `nextNodeId`/`nextEdgeId` see what has
  // already been minted — they answer "unique within THIS flow".
  const out: Flow = { id: flowId, name: t.name, armed: false, createdAt: nowMs, nodes: [], edges: [] };

  // Old id → new id, so every edge can be rewired after the nodes are minted.
  const remap = new Map<string, string>();
  for (const n of t.flow.nodes) {
    const id = nextNodeId(out);
    remap.set(n.id, id);
    const bound: FlowNode = isPlanned(n) ? { ...n, id, ticketKey } : { ...n, id };
    out.nodes.push(bound);
  }

  for (const e of t.flow.edges) {
    const from = remap.get(e.from);
    const to = remap.get(e.to);
    // An edge naming a node the template does not have is hand-edited junk. Drop
    // it rather than carrying a dangling reference into a live workflow —
    // `evaluate.ts` guards a missing target on the read side, but a template is
    // executed by being copied and this is the copy.
    if (from === undefined || to === undefined) continue;
    const fresh: FlowEdge = { ...stripHostStamps(e), id: nextEdgeId(out), from, to };
    out.edges.push(fresh);
  }

  // No consent stamps, ever. `launchConfirmedAt` and `commandConfirmedAt` are per
  // workflow, asked once, and then it spends unattended forever. A template that
  // carried either would multiply one consent by every card it is attached to:
  // twenty workflows from one approved template is twenty machines running
  // deploy.sh on the strength of a single click made about a different ticket.
  // Simply never assigned here — the fresh object above has neither.
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/engine/orchestrator/templates.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 5: Commit**

```bash
git add src/engine/orchestrator/templates.ts test/unit/engine/orchestrator/templates.test.ts
git commit -m "feat(orchestrator): instantiate a workflow from a template"
```

---

### Task 4: `templates.ts` — `toTemplate`, demoting places back to planned

Saving must turn every `place` (a run that exists on this machine) back into a `planned` node. A `PlannedNode` carries four fields a `PlaceNode` does not: `ticketKey` is the parameter and is dropped; `repos` is recoverable as `[place.repo]`; **`mode` and `dest` are not recoverable at all** — they lived on the planned node that promotion destroyed, and a place created by a Take never had them. So the caller supplies them per demoted node. Do not guess.

**Files:**
- Modify: `src/engine/orchestrator/templates.ts`
- Test: `test/unit/engine/orchestrator/templates.test.ts`

**Interfaces:**
- Consumes: `isPlace`, `LaunchDest` from `model.ts`
- Produces:
  - `interface DemotionChoice { nodeId: string; mode: string; dest: LaunchDest }`
  - `placesToDemote(flow: Flow): PlaceNode[]`
  - `toTemplate(flow: Flow, name: string, id: string, savedAt: number, choices: DemotionChoice[]): FlowTemplate`

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/engine/orchestrator/templates.test.ts`:

```ts
import { placesToDemote, toTemplate } from "../../../../src/engine/orchestrator/templates";
import { stripHostStamps } from "../../../../src/engine/orchestrator/model";

const place = (id: string, runKey: string, repo: string): FlowNode =>
  ({ id, x: 7, y: 9, join: "all", kind: "place", runKey, repo });

const ranFlow = (): Flow => ({
  id: "f1", name: "Ship it", armed: true, createdAt: 100,
  launchConfirmedAt: 200, commandConfirmedAt: 300,
  nodes: [place("n1", "PROJ-142", "ingest-worker"), place("n2", "PROJ-142", "api"), notify("n3")],
  edges: [
    { id: "e1", from: "n1", to: "n3", cond: { kind: "pr-merged" }, firedAt: 5, firedNote: "told you", performed: true },
    { id: "e2", from: "n2", to: "n3", cond: { kind: "ci-passed" }, error: "exit 1", gateAnswer: "approved" },
  ],
});

const choices = [
  { nodeId: "n1", mode: "plan", dest: "worktree" as const },
  { nodeId: "n2", mode: "review", dest: "new-window" as const },
];

describe("placesToDemote", () => {
  it("lists every place, so the save dialog can ask about each", () => {
    expect(placesToDemote(ranFlow()).map((n) => n.id)).toEqual(["n1", "n2"]);
  });
});

describe("toTemplate", () => {
  it("demotes every place, preserving id, x, y and join", () => {
    const t = toTemplate(ranFlow(), "Ship it", "k1", 999, choices);
    const n1 = t.flow.nodes.find((n) => n.id === "n1")!;
    expect(n1.kind).toBe("planned");
    expect(n1.x).toBe(7);
    expect(n1.y).toBe(9);
    expect(n1.join).toBe("all");
  });

  it("recovers repos from the place's one repo and takes mode and dest from the choice", () => {
    const t = toTemplate(ranFlow(), "Ship it", "k1", 999, choices);
    const n2 = t.flow.nodes.find((n) => n.id === "n2") as { repos: string[]; mode: string; dest: string };
    expect(n2.repos).toEqual(["api"]);
    expect(n2.mode).toBe("review");
    expect(n2.dest).toBe("new-window");
  });

  it("drops the ticket key — that is the parameter", () => {
    const t = toTemplate(ranFlow(), "Ship it", "k1", 999, choices);
    const planned = t.flow.nodes.filter((n) => n.kind === "planned") as { ticketKey: string }[];
    expect(planned.every((n) => n.ticketKey === "")).toBe(true);
  });

  it("keeps every edge pointing where it pointed", () => {
    const t = toTemplate(ranFlow(), "Ship it", "k1", 999, choices);
    expect(t.flow.edges.map((e) => [e.from, e.to])).toEqual([["n1", "n3"], ["n2", "n3"]]);
  });

  it("strips stamps through the SAME helper Reset uses", () => {
    // Asserted against stripHostStamps itself so the two cannot drift: a new
    // host-owned field is dropped here the moment it is dropped by Reset.
    const flow = ranFlow();
    const t = toTemplate(flow, "Ship it", "k1", 999, choices);
    expect(t.flow.edges[0]).toEqual({ ...stripHostStamps(flow.edges[0]) });
    expect(t.flow.edges[1]).toEqual({ ...stripHostStamps(flow.edges[1]) });
  });

  it("carries no armed state and no consent", () => {
    const t = toTemplate(ranFlow(), "Ship it", "k1", 999, choices);
    expect(t.flow.armed).toBe(false);
    expect(t.flow.launchConfirmedAt).toBeUndefined();
    expect(t.flow.commandConfirmedAt).toBeUndefined();
  });

  it("stamps the envelope", () => {
    const t = toTemplate(ranFlow(), "Ship it", "k1", 999, choices);
    expect(t).toMatchObject({ schema: 1, id: "k1", name: "Ship it", params: {}, savedAt: 999 });
  });

  it("refuses a flow with no nodes — nothing to reuse", () => {
    const empty: Flow = { id: "f1", name: "x", armed: false, createdAt: 0, nodes: [], edges: [] };
    expect(() => toTemplate(empty, "x", "k1", 0, [])).toThrow(/nothing to reuse/i);
  });

  it("refuses when a place has no demotion choice", () => {
    // Guessing a destination means a template that silently launches a session
    // into the window you are working in, months later, on someone else's ticket.
    expect(() => toTemplate(ranFlow(), "Ship it", "k1", 999, [choices[0]]))
      .toThrow(/n2/);
  });

  it("round trips: toTemplate then instantiate keeps the counts and the wiring", () => {
    const t = toTemplate(ranFlow(), "Ship it", "k1", 999, choices);
    const f = instantiate(t, "PROJ-9", "f-new", 1000);
    expect(f.nodes).toHaveLength(3);
    expect(f.edges).toHaveLength(2);
    const byId = new Map(f.nodes.map((n) => [n.id, n]));
    expect(f.edges.every((e) => byId.has(e.from) && byId.has(e.to))).toBe(true);
    expect(f.edges.map((e) => byId.get(e.to)!.kind)).toEqual(["notify", "notify"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/engine/orchestrator/templates.test.ts -t "toTemplate"`
Expected: FAIL — `toTemplate is not a function`

- [ ] **Step 3: Write the implementation**

Append to `src/engine/orchestrator/templates.ts` (and add `isPlace`, `LaunchDest`, `PlaceNode`, `PlannedNode` to the import from `./model`):

```ts
/** What the save dialog must ask about one place it is demoting.
 *
 * `mode` and `dest` are the two fields a `PlaceNode` cannot give back:
 * `promoteToPlace` rewrote a planned node into a place and those two lived on the
 * planned node it destroyed — and a place created by a Take never had them at
 * all. They are asked for, never invented, because a guessed destination means a
 * template that silently launches a session into the window you are working in,
 * months later, on someone else's ticket. */
export interface DemotionChoice {
  nodeId: string;
  mode: string;
  dest: LaunchDest;
}

/** Every place this flow would have to demote, in node order — one row per
 * place for the save dialog to ask about. */
export function placesToDemote(flow: Flow): PlaceNode[] {
  return flow.nodes.filter(isPlace);
}

/** A template from a live workflow.
 *
 * The direction here is the one the engine already runs, backwards:
 * `promoteToPlace` rewrites `planned → place` the moment a launch succeeds,
 * keeping the node's `id`, `x`, `y` and `join` precisely so every downstream edge
 * stays pointing at it. This preserves the same four for the same reason. */
export function toTemplate(
  flow: Flow,
  name: string,
  id: string,
  savedAt: number,
  choices: DemotionChoice[],
): FlowTemplate {
  if (flow.nodes.length === 0) throw new Error("this workflow has no steps: nothing to reuse");

  const byNode = new Map(choices.map((c) => [c.nodeId, c]));
  const nodes: FlowNode[] = flow.nodes.map((n) => {
    if (!isPlace(n)) return { ...n };
    const choice = byNode.get(n.id);
    if (!choice) {
      throw new Error(`no prompt mode and destination chosen for step ${n.id} (${n.runKey})`);
    }
    const demoted: PlannedNode = {
      id: n.id, x: n.x, y: n.y, join: n.join,
      kind: "planned",
      // The parameter, and the only field deliberately blank: `instantiate` fills it.
      ticketKey: "",
      // A place is exactly one repo, by construction.
      repos: [n.repo],
      mode: choice.mode,
      dest: choice.dest,
    };
    return demoted;
  });

  return {
    schema: TEMPLATE_SCHEMA,
    id,
    name,
    params: {},
    savedAt,
    flow: {
      // The flow id is not part of the shape; `instantiate` is given a fresh one.
      id: "", name, armed: false, createdAt: 0,
      nodes,
      edges: flow.edges.map(stripHostStamps),
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/engine/orchestrator/templates.test.ts`
Expected: PASS (23 tests)

- [ ] **Step 5: Commit**

```bash
git add src/engine/orchestrator/templates.ts test/unit/engine/orchestrator/templates.test.ts
git commit -m "feat(orchestrator): save a workflow as a template"
```

---

### Task 5: Template storage — a sibling directory, the same IO

**Files:**
- Modify: `src/engine/orchestrator/store.ts`
- Test: `test/unit/engine/orchestrator/store.test.ts`

**Interfaces:**
- Consumes: `FlowIo`, `VALID_FLOW_ID` (already in this file), `validTemplate`, `FlowTemplate` from `templates.ts`
- Produces: `defaultTemplatesDir(): string`, `readTemplates(io, dir): FlowTemplate[]`, `writeTemplate(io, dir, t): void`, `removeTemplate(io, dir, id): void`

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/engine/orchestrator/store.test.ts`, following the in-memory `FlowIo` fake the existing tests in that file already build (reuse it — do not write a second one):

```ts
describe("templates", () => {
  const t = (id: string, name: string): FlowTemplate => ({
    schema: 1, id, name, params: {}, savedAt: 1,
    flow: {
      id: "", name, armed: false, createdAt: 0,
      nodes: [{ id: "n1", x: 0, y: 0, join: "any", kind: "planned", ticketKey: "", repos: ["r"], mode: "plan", dest: "worktree" }],
      edges: [],
    },
  });

  it("round trips through the same FlowIo", () => {
    const io = memIo();
    writeTemplate(io, "/tpl", t("k1", "Ship it"));
    expect(readTemplates(io, "/tpl").map((x) => x.name)).toEqual(["Ship it"]);
  });

  it("one corrupt file costs one template, never the whole picker", () => {
    const io = memIo();
    writeTemplate(io, "/tpl", t("k1", "Ship it"));
    io.writeFile("/tpl/broken.json", "{ not json");
    writeTemplate(io, "/tpl", t("k2", "Review only"));
    expect(readTemplates(io, "/tpl").map((x) => x.name).sort()).toEqual(["Review only", "Ship it"]);
  });

  it("ignores a bare Flow somebody moved into the directory", () => {
    const io = memIo();
    io.writeFile("/tpl/moved.json", JSON.stringify(t("k1", "Ship it").flow));
    expect(readTemplates(io, "/tpl")).toEqual([]);
  });

  it("refuses to write an id outside the path-safe charset", () => {
    const io = memIo();
    expect(() => writeTemplate(io, "/tpl", t("../../../.zshrc", "evil"))).toThrow(/invalid template id/i);
  });

  it("removes by id", () => {
    const io = memIo();
    writeTemplate(io, "/tpl", t("k1", "Ship it"));
    removeTemplate(io, "/tpl", "k1");
    expect(readTemplates(io, "/tpl")).toEqual([]);
  });

  it("reads as empty when the directory does not exist yet", () => {
    const io = memIo();
    expect(readTemplates(io, "/nope")).toEqual([]);
  });

  it("templates and flows live in sibling directories", () => {
    expect(defaultTemplatesDir()).not.toBe(defaultFlowsDir());
    expect(defaultTemplatesDir().endsWith("templates")).toBe(true);
  });

  it("readFlows pointed at a templates directory returns nothing", () => {
    // Two shapes, two readers, no overlap: an envelope is not a Flow, so a
    // mis-filed template can never be loaded as a real, armable workflow.
    const io = memIo();
    writeTemplate(io, "/tpl", t("k1", "Ship it"));
    expect(readFlows(io, "/tpl")).toEqual([]);
  });
});
```

If the existing file's in-memory IO helper is not called `memIo`, use whatever it is called — do not add a second fake.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/engine/orchestrator/store.test.ts -t "templates"`
Expected: FAIL — `writeTemplate is not a function`

- [ ] **Step 3: Write the implementation**

In `src/engine/orchestrator/store.ts`:

```ts
/** Templates sit beside flows, read and written through the same `FlowIo` with
 * the same rules: the same id charset (an id becomes a path, so this is a
 * traversal guard, not cosmetics) and the same tolerance (one unreadable file
 * costs one template, never the whole picker). */
export function defaultTemplatesDir(): string {
  return path.join(os.homedir(), ".agentflow", "templates");
}

function templateFileFor(dir: string, id: string): string {
  if (!VALID_FLOW_ID.test(id)) throw new Error(`invalid template id: ${JSON.stringify(id)}`);
  return path.join(dir, `${id}.json`);
}

export function writeTemplate(io: FlowIo, dir: string, t: FlowTemplate): void {
  io.writeFile(templateFileFor(dir, t.id), JSON.stringify(t, null, 2));
}

export function readTemplates(io: FlowIo, dir: string): FlowTemplate[] {
  let entries: string[];
  try {
    entries = io.readDir(dir);
  } catch {
    // No directory yet is the ordinary first-run case, not an error.
    return [];
  }
  const out: FlowTemplate[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const text = io.readFile(path.join(dir, name));
    if (text === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const t = validTemplate(parsed);
    if (t) out.push(t);
  }
  return out;
}

export function removeTemplate(io: FlowIo, dir: string, id: string): void {
  io.remove(templateFileFor(dir, id));
}
```

Add `import { FlowTemplate, validTemplate } from "./templates";` to the file's imports.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/engine/orchestrator/store.test.ts`
Expected: PASS, including every pre-existing test in the file unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/engine/orchestrator/store.ts test/unit/engine/orchestrator/store.test.ts
git commit -m "feat(orchestrator): store templates beside flows"
```

---

### Task 6: `attach.ts` — which workflow belongs to this card

**Files:**
- Create: `src/engine/orchestrator/attach.ts`
- Test: Create `test/unit/engine/orchestrator/attach.test.ts`

**Interfaces:**
- Consumes: `Flow`, `isPlace`, `isPlanned` from `model.ts`
- Produces:
  - `bindsRun(flow: Flow, runKey: string, ticketKey: string | undefined): boolean`
  - `attachedWorkflows(flows: Flow[], runKey: string, ticketKey: string | undefined): Flow[]` — every match, in precedence order
  - `attachedWorkflow(flows, runKey, ticketKey, ranked): Flow | undefined` — the first (see Task 7 for `ranked`)

To keep Task 6 free of state ranking, `attachedWorkflows` here returns matches sorted by `createdAt` only; Task 7 adds the state precedence on top.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/engine/orchestrator/attach.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Flow, FlowNode } from "../../../../src/engine/orchestrator/model";
import { attachedWorkflows, bindsRun } from "../../../../src/engine/orchestrator/attach";

const place = (id: string, runKey: string): FlowNode =>
  ({ id, x: 0, y: 0, join: "any", kind: "place", runKey, repo: "ingest-worker" });
const planned = (id: string, ticketKey: string): FlowNode =>
  ({ id, x: 0, y: 0, join: "any", kind: "planned", ticketKey, repos: ["ingest-worker"], mode: "plan", dest: "worktree" });
const notify = (id: string): FlowNode => ({ id, x: 0, y: 0, join: "any", kind: "notify", message: "" });

const flow = (id: string, nodes: FlowNode[], createdAt = 0): Flow =>
  ({ id, name: "Ship it", armed: false, createdAt, nodes, edges: [] });

describe("bindsRun", () => {
  it("binds by a place's run key", () => {
    expect(bindsRun(flow("f1", [place("n1", "PROJ-142")]), "PROJ-142", "PROJ-142")).toBe(true);
  });

  it("binds by a planned node's ticket key", () => {
    expect(bindsRun(flow("f1", [planned("n1", "PROJ-142")]), "local-branch-key", "PROJ-142")).toBe(true);
  });

  it("does not bind a flow that names neither", () => {
    expect(bindsRun(flow("f1", [place("n1", "PROJ-9"), notify("n2")]), "PROJ-142", "PROJ-142")).toBe(false);
  });

  it("does not bind a planned node with a blank ticket key to a card with no ticket", () => {
    // A template's planned node carries "" until instantiate binds it. An
    // undefined ticket key on the card must not match it, or every untracked
    // card would claim every half-built workflow.
    expect(bindsRun(flow("f1", [planned("n1", "")]), "local-key", undefined)).toBe(false);
  });

  it("ignores case-insensitive near-misses — keys are exact", () => {
    expect(bindsRun(flow("f1", [place("n1", "proj-142")]), "PROJ-142", "PROJ-142")).toBe(false);
  });
});

describe("attachedWorkflows", () => {
  it("returns nothing when no flow binds the run", () => {
    expect(attachedWorkflows([flow("f1", [place("n1", "PROJ-9")])], "PROJ-142", "PROJ-142")).toEqual([]);
  });

  it("returns the one flow that binds it", () => {
    const flows = [flow("f1", [place("n1", "PROJ-9")]), flow("f2", [place("n1", "PROJ-142")])];
    expect(attachedWorkflows(flows, "PROJ-142", "PROJ-142").map((f) => f.id)).toEqual(["f2"]);
  });

  it("returns two hand-drawn matches oldest first", () => {
    // Nothing stops somebody hand-drawing two flows that touch one card. The
    // drawer must resolve deterministically rather than pick whichever the
    // filesystem listed first.
    const flows = [flow("f2", [place("n1", "PROJ-142")], 200), flow("f1", [place("n1", "PROJ-142")], 100)];
    expect(attachedWorkflows(flows, "PROJ-142", "PROJ-142").map((f) => f.id)).toEqual(["f1", "f2"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/engine/orchestrator/attach.test.ts`
Expected: FAIL — cannot resolve `attach`

- [ ] **Step 3: Write the implementation**

Create `src/engine/orchestrator/attach.ts`:

```ts
// Which workflow belongs to a card, and what state it is in.
//
// Attachment is DERIVED, never stored. A workflow is attached to a card when its
// flow contains a node bound to that run — a place with the card's run key, or a
// planned node with its ticket key. That binding already exists and is already how
// the engine finds the card.
//
// The alternative, an `attachedTo` field on `Flow`, can disagree with the graph:
// delete the place node and the field still claims attachment. It would also need
// a migration, and would leave every flow drawn before this shipped invisible to
// the card until re-saved. Deriving cannot lie, because it IS the graph.
//
// The cost is that "one workflow per card" is a display rule rather than an
// enforced invariant — hence the precedence ordering below.
//
// PURE LEAF: the card drawer imports this. `model.ts`, `preview.ts` and
// `evaluate.ts` only — no Node builtins, directly or transitively.
import { Flow, isPlace, isPlanned } from "./model";

/** Does this flow name the given run?
 *
 * Both halves are exact string matches on purpose. A card's `runKey` is what a
 * place stores; its ticket key is what a planned node stores, and a planned node
 * whose ticket key is still blank (a shape mid-authoring) binds nothing. */
export function bindsRun(flow: Flow, runKey: string, ticketKey: string | undefined): boolean {
  return flow.nodes.some((n) => {
    if (isPlace(n)) return n.runKey === runKey;
    if (isPlanned(n)) return n.ticketKey !== "" && n.ticketKey === ticketKey;
    return false;
  });
}

/** Every workflow bound to this run, oldest first.
 *
 * Sorted by `createdAt` here and re-ranked by state in `rankByState`
 * (see below) — the two are separate so the ordering rule is testable without a
 * board. */
export function attachedWorkflows(flows: Flow[], runKey: string, ticketKey: string | undefined): Flow[] {
  return flows.filter((f) => bindsRun(f, runKey, ticketKey)).sort((a, b) => a.createdAt - b.createdAt);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/engine/orchestrator/attach.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/engine/orchestrator/attach.ts test/unit/engine/orchestrator/attach.test.ts
git commit -m "feat(orchestrator): derive which workflow a card carries"
```

---

### Task 7: `attach.ts` — the six states and the precedence rule

**Files:**
- Modify: `src/engine/orchestrator/attach.ts`
- Test: `test/unit/engine/orchestrator/attach.test.ts`

**Interfaces:**
- Consumes: `previewFlow`, `RulePreview` from `preview.ts`; `BranchCiStatus` from `branchCi.ts`; `RunStatus` from `../../types`; `isSettled` from `model.ts`
- Produces:
  - `type WorkflowStatus = "disarmed" | "advancing" | "waiting-on-you" | "stopped" | "done"`
  - `interface WorkflowState { status: WorkflowStatus; done: number; total: number; steps: StepState[] }`
  - `interface StepState { edgeId: string; state: "done" | "now" | "waiting" | "you" | "fail"; receipt?: string }`
  - `workflowState(flow, runs, nowMs, branchCi?): WorkflowState`
  - `rankByState(flows, runs, nowMs, branchCi?): Flow[]` — stopped › waiting-on-you › advancing › done, ties by `createdAt`

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/engine/orchestrator/attach.test.ts`:

```ts
import { rankByState, workflowState } from "../../../../src/engine/orchestrator/attach";
import type { FlowEdge } from "../../../../src/engine/orchestrator/model";

const edge = (over: Partial<FlowEdge> & { id: string }): FlowEdge =>
  ({ from: "n1", to: "n2", cond: { kind: "pr-merged" }, ...over });

/** A flow whose place names a run no board has — every condition on it reads
 * nothing, which `evaluate.ts` reports as blocked "gone". */
const withEdges = (edges: FlowEdge[], armed = true, createdAt = 0): Flow => ({
  id: "f1", name: "Ship it", armed, createdAt,
  nodes: [place("n1", "PROJ-142"), notify("n2")],
  edges,
});

describe("workflowState", () => {
  it("is disarmed when the flow is not armed, whatever the rules say", () => {
    const s = workflowState(withEdges([edge({ id: "e1" })], false), [], 1000);
    expect(s.status).toBe("disarmed");
  });

  it("is stopped when any edge carries an error, and names the failed step", () => {
    const s = workflowState(withEdges([
      edge({ id: "e1", firedAt: 1, firedNote: "ran · exit 0" }),
      edge({ id: "e2", error: "exit 1 · 3 assertions failed" }),
    ]), [], 1000);
    expect(s.status).toBe("stopped");
    expect(s.steps.find((x) => x.edgeId === "e2")).toMatchObject({
      state: "fail", receipt: "exit 1 · 3 assertions failed",
    });
  });

  it("prefers stopped over waiting-on-you", () => {
    // A failure the user can act on outranks a question, because the failure is
    // what actually halted the workflow.
    const s = workflowState(withEdges([
      edge({ id: "e1", error: "exit 1" }),
      edge({ id: "e2", cond: { kind: "gate-approved" } }),
    ]), [], 1000);
    expect(s.status).toBe("stopped");
  });

  it("reports a fired edge as done, with its receipt", () => {
    const s = workflowState(withEdges([edge({ id: "e1", firedAt: 5, firedNote: "told you" })]), [], 1000);
    expect(s.steps[0]).toMatchObject({ state: "done", receipt: "told you" });
    expect(s.done).toBe(1);
    expect(s.total).toBe(1);
  });

  it("is done when no rule is left in play", () => {
    // `done` is the ABSENCE of a pending rule, not a stored flag — same
    // reasoning as attachment itself.
    const s = workflowState(withEdges([
      edge({ id: "e1", firedAt: 5 }),
      edge({ id: "e2", firedAt: 6 }),
    ]), [], 1000);
    expect(s.status).toBe("done");
    expect(s.done).toBe(2);
  });

  it("counts done out of total for the header", () => {
    const s = workflowState(withEdges([
      edge({ id: "e1", firedAt: 5 }),
      edge({ id: "e2", firedAt: 6 }),
      edge({ id: "e3" }),
    ]), [], 1000);
    expect([s.done, s.total]).toEqual([2, 3]);
  });
});

describe("rankByState", () => {
  const armedWith = (id: string, edges: FlowEdge[], createdAt: number): Flow =>
    ({ ...withEdges(edges, true, createdAt), id });

  it("puts a stopped workflow ahead of an advancing one", () => {
    const stopped = armedWith("f-stop", [edge({ id: "e1", error: "exit 1" })], 200);
    const advancing = armedWith("f-adv", [edge({ id: "e1" })], 100);
    expect(rankByState([advancing, stopped], [], 1000).map((f) => f.id)).toEqual(["f-stop", "f-adv"]);
  });

  it("puts a done workflow last", () => {
    const done = armedWith("f-done", [edge({ id: "e1", firedAt: 1 })], 100);
    const advancing = armedWith("f-adv", [edge({ id: "e1" })], 200);
    expect(rankByState([done, advancing], [], 1000).map((f) => f.id)).toEqual(["f-adv", "f-done"]);
  });

  it("breaks a tie by createdAt, oldest first", () => {
    const a = armedWith("f-old", [edge({ id: "e1" })], 100);
    const b = armedWith("f-new", [edge({ id: "e1" })], 200);
    expect(rankByState([b, a], [], 1000).map((f) => f.id)).toEqual(["f-old", "f-new"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/engine/orchestrator/attach.test.ts -t "workflowState"`
Expected: FAIL — `workflowState is not a function`

- [ ] **Step 3: Write the implementation**

Append to `src/engine/orchestrator/attach.ts` (adding the imports named in **Interfaces** above):

```ts
/** What the card chip and the block header say. Six states, and each is a
 * different sentence rather than a shade of the same one — see the design doc's
 * state table. `none` is the absence of a workflow and so has no value here. */
export type WorkflowStatus = "disarmed" | "advancing" | "waiting-on-you" | "stopped" | "done";

/** One rule, as the stepper draws it. `receipt` is the engine's own words — the
 * edge's `firedNote` or `error`, or the reason `previewFlow` gives for waiting —
 * never a sentence this module invents. */
export interface StepState {
  edgeId: string;
  state: "done" | "now" | "waiting" | "you" | "fail";
  receipt?: string;
}

export interface WorkflowState {
  status: WorkflowStatus;
  /** Settled rules, and how many there are in total — the block header's "2 of 5". */
  done: number;
  total: number;
  /** Every rule, in `flow.edges` order. */
  steps: StepState[];
}

/** Where this workflow is, right now.
 *
 * Pure and total, like `previewFlow` itself, and safe to call on every render:
 * the card drawer calls it for one workflow, the board calls it once per card
 * with a chip. Everything it reads is already on the wire — the edges' own stamps
 * come with `deck:flows`, and `previewFlow` needs only `runs` and `branchCi`,
 * which `DeckApp` holds. */
export function workflowState(
  flow: Flow,
  runs: RunStatus[],
  nowMs: number,
  branchCi?: Record<string, BranchCiStatus>,
): WorkflowState {
  const previews = new Map<string, RulePreview>();
  // `previewFlow` evaluates as if armed, which is what makes it answer for a
  // disarmed workflow too: the steps still say what WOULD happen, greyed.
  for (const p of previewFlow(flow, runs, nowMs, branchCi)) previews.set(p.edgeId, p);

  let firstPending = true;
  const steps: StepState[] = flow.edges.map((e) => {
    if (e.error !== undefined) return { edgeId: e.id, state: "fail" as const, receipt: e.error };
    if (e.firedAt !== undefined) return { edgeId: e.id, state: "done" as const, receipt: e.firedNote };

    const p = previews.get(e.id);
    if (p?.reason === "awaiting-answer") {
      return { edgeId: e.id, state: "you" as const, receipt: "waiting for your answer" };
    }
    // The first rule still in play is the one the reader is waiting on; the rest
    // are simply "not yet", and marking them all as current would say the
    // workflow is doing five things at once.
    const state = firstPending ? ("now" as const) : ("waiting" as const);
    firstPending = false;
    return { edgeId: e.id, state, receipt: p?.blank ?? undefined };
  });

  const done = flow.edges.filter(isSettled).length;
  const base = { done, total: flow.edges.length, steps };

  // Order matters and is the precedence rule: a failure the user can act on
  // outranks a question, because the failure is what actually halted the
  // workflow. Both outrank "advancing".
  if (steps.some((s) => s.state === "fail")) return { ...base, status: "stopped" };
  if (steps.some((s) => s.state === "you")) return { ...base, status: "waiting-on-you" };
  if (!flow.armed) return { ...base, status: "disarmed" };
  if (steps.every((s) => s.state === "done")) return { ...base, status: "done" };
  return { ...base, status: "advancing" };
}

/** Rank order for the one-workflow-per-card display rule: the workflow that most
 * needs a human comes first, ties broken by `createdAt` so two hand-drawn
 * candidates always resolve the same way. */
const RANK: Record<WorkflowStatus, number> = {
  stopped: 0, "waiting-on-you": 1, advancing: 2, disarmed: 3, done: 4,
};

export function rankByState(
  flows: Flow[],
  runs: RunStatus[],
  nowMs: number,
  branchCi?: Record<string, BranchCiStatus>,
): Flow[] {
  return [...flows].sort((a, b) => {
    const ra = RANK[workflowState(a, runs, nowMs, branchCi).status];
    const rb = RANK[workflowState(b, runs, nowMs, branchCi).status];
    return ra !== rb ? ra - rb : a.createdAt - b.createdAt;
  });
}
```

Note the ordering subtlety the tests pin: a **disarmed** workflow with a failed edge still reads as `stopped`, because the error is a fact about what happened, not about what will.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/engine/orchestrator/attach.test.ts`
Expected: PASS (18 tests)

- [ ] **Step 5: Verify the webview import graph still holds**

Run: `npx vitest run test/webview/webviewGraph.test.ts && npm run build`
Expected: PASS, then four bundles. `attach.ts` now imports `preview.ts` and `types.ts` — both already webview-safe, and this is the check that says so.

- [ ] **Step 6: Commit**

```bash
git add src/engine/orchestrator/attach.ts test/unit/engine/orchestrator/attach.test.ts
git commit -m "feat(orchestrator): a workflow's live state, six ways"
```

---

### Task 8: Host wiring — messages and the templates payload

**Files:**
- Modify: `src/types.ts` (the webview→host union around line 693, and the host→webview `deck:flows` around line 919)
- Modify: `src/deckView.ts`
- Test: `test/unit/deckView.test.ts`

**Interfaces:**
- Produces these webview→host messages:
  - `{ type: "flow:saveTemplate"; id: string; name: string; choices: DemotionChoice[] }`
  - `{ type: "flow:attach"; runKey: string; templateId: string; replace?: true }`
  - `{ type: "flow:detach"; id: string }`
  - `{ type: "flow:renameTemplate"; templateId: string; name: string }`
  - `{ type: "flow:deleteTemplate"; templateId: string }`
  - `{ type: "flow:duplicateTemplate"; templateId: string }`
- And extends `deck:flows` with `templates: FlowTemplate[]`.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/deckView.test.ts`, following that file's existing pattern for posting a message into the view. **Read its `getConfig` mock first**: it silently drops any new `AgentFlowConfig` field, and calling the real config builder per field once made the whole suite 13× slower — add fields to the mock's own object, never a real `getConfig()` call.

```ts
it("flow:attach writes a disarmed workflow bound to the card's ticket", async () => {
  // ...arrange a view with one template on disk and one run on the board
  await post({ type: "flow:attach", runKey: "PROJ-142", templateId: "k1" });
  const written = writtenFlows();
  expect(written).toHaveLength(1);
  expect(written[0].armed).toBe(false);
  expect(written[0].nodes.filter((n) => n.kind === "planned")
    .every((n) => (n as { ticketKey: string }).ticketKey === "PROJ-142")).toBe(true);
  expect(written[0].launchConfirmedAt).toBeUndefined();
});

it("flow:attach refuses when a workflow is already attached and replace is absent", async () => {
  // ...arrange a flow already binding PROJ-142
  await post({ type: "flow:attach", runKey: "PROJ-142", templateId: "k1" });
  expect(writtenFlows()).toHaveLength(0);
  expect(lastWarning()).toMatch(/already/i);
});

it("flow:attach with replace detaches the old workflow first", async () => {
  await post({ type: "flow:attach", runKey: "PROJ-142", templateId: "k1", replace: true });
  expect(removedFlowIds()).toEqual(["f-old"]);
  expect(writtenFlows()).toHaveLength(1);
});

it("flow:saveTemplate demotes places using the choices it was given", async () => {
  await post({
    type: "flow:saveTemplate", id: "f1", name: "Ship it",
    choices: [{ nodeId: "n1", mode: "plan", dest: "worktree" }],
  });
  const t = writtenTemplates()[0];
  expect(t.name).toBe("Ship it");
  expect(t.flow.nodes[0]).toMatchObject({ kind: "planned", mode: "plan", dest: "worktree", ticketKey: "" });
});

it("deck:flows carries templates alongside flows", async () => {
  const post = lastPostOfType("deck:flows");
  expect(post.templates.map((t: { name: string }) => t.name)).toEqual(["Ship it"]);
});

it("flow:deleteTemplate leaves workflows already made from it alone", async () => {
  await post({ type: "flow:deleteTemplate", templateId: "k1" });
  expect(removedTemplateIds()).toEqual(["k1"]);
  expect(removedFlowIds()).toEqual([]);
});
```

Use the helper names that file already has for arranging a view and reading its writes; the names above are placeholders for whatever it calls them.

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run test/unit/deckView.test.ts -t "flow:attach"`
Expected: FAIL — the message is not handled

Name-filter this file. Running it whole under contention is what the `-t` guidance in the constraints is for.

- [ ] **Step 3: Add the message types**

In `src/types.ts`, add to the webview→host union beside the existing `flow:*` members, and extend the `deck:flows` member with `templates: FlowTemplate[]`. Import `FlowTemplate` and `DemotionChoice` as **types only** from `./engine/orchestrator/templates` and re-export `FlowTemplate`, following the pattern the file already uses for `BranchCiStatus`:

```ts
import type { DemotionChoice, FlowTemplate } from "./engine/orchestrator/templates";
export type { DemotionChoice, FlowTemplate };
```

- [ ] **Step 4: Handle them in `deckView.ts`**

Add handlers beside the existing `flow:*` cases, reusing this file's existing lock-and-reread discipline — every write re-reads immediately before writing, under the flows lock, exactly as `flow:resetEdge` and `flow:arm` do. For `flow:attach`:

```ts
      case "flow:attach": {
        const runKey = m.runKey;
        const status = this.statusFor(runKey);
        const ticketKey = status ? ticketKeyOf(status) : undefined;
        const templates = readTemplates(this.flowIo, this.templatesDir);
        const t = templates.find((x) => x.id === m.templateId);
        if (!t) {
          void vscode.window.showWarningMessage(`That template is no longer on disk.`);
          return;
        }
        await this.withFlowsLock(async () => {
          const flows = readFlows(this.flowIo, this.flowsDir);
          const existing = attachedWorkflows(flows, runKey, ticketKey);
          if (existing.length > 0 && !m.replace) {
            void vscode.window.showWarningMessage(
              `${runKey} already has the "${existing[0].name}" workflow attached.`,
            );
            return;
          }
          for (const old of m.replace ? existing : []) removeFlow(this.flowIo, this.flowsDir, old.id);
          // `newFlowId` is still the only place a flow id is minted.
          const fresh = instantiate(t, ticketKey ?? runKey, newFlowId(Date.now()), Date.now());
          writeFlow(this.flowIo, this.flowsDir, fresh);
        });
        this.postFlows();
        return;
      }
```

Wrap `instantiate` in a try/catch and surface its refusal as a warning — a template with no planned step throws, and that message is written for a human.

- [ ] **Step 5: Run tests to verify they pass**

Run: `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run test/unit/deckView.test.ts`
Expected: PASS. If the run reports "156/157 files, 0 failures", that is a worker heap OOM masquerading as success — the heap flag above is why it is on the command.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/deckView.ts test/unit/deckView.test.ts
git commit -m "feat(deck): attach, detach and save a workflow template"
```

---

### Task 9: The drawer's new anatomy — promote a few, bury the rest

No workflow block yet. This task is separable on purpose: the rebuild is worth judging on its own, and it is the phase most likely to reveal that a promoted action was the wrong one.

**Files:**
- Modify: `src/webview/DeckDetail.tsx`
- Modify: `src/webview/deckStyles.ts` (`.dd` width, `.board.dd-open`, `.dd-more`, fact strips)
- Test: `test/webview/deckDetail.test.tsx` (or the existing file that covers `DeckDetail` — find it before creating one)

**Interfaces:**
- Consumes: nothing new
- Produces: no new exports; `DeckDetailProps` unchanged

- [ ] **Step 1: Write the failing tests**

```tsx
// @vitest-environment jsdom

it("promotes exactly four actions out of the list", async () => {
  render(<DeckDetail {...props} />);
  const promoted = screen.getByRole("group", { name: "Actions" });
  expect(within(promoted).getAllByRole("button").map((b) => b.textContent))
    .toEqual(["Open workspace", "Open PR #482", "Diff", "Address PR"]);
});

it("hides every remaining action behind one disclosure", async () => {
  render(<DeckDetail {...props} />);
  expect(screen.queryByText("Copy branch name")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: /^More/ }));
  await waitFor(() => expect(screen.getByText("Copy branch name")).toBeTruthy());
});

it("keeps every action the old drawer had reachable", async () => {
  // Enumerated on purpose: `More` is a disclosure, not a deletion. This test is
  // what stops a rebuild quietly dropping an affordance somebody used.
  render(<DeckDetail {...props} />);
  await userEvent.click(screen.getByRole("button", { name: /^More/ }));
  for (const label of [
    "Open workspace", "Diff — all repos", "Address PR", "Open in Jira",
    "Open PR #482", "Copy branch name", "Copy ticket key", "Copy PR url",
    "Copy worktree path", "Forget",
  ]) {
    await waitFor(() => expect(screen.getByRole("button", { name: label })).toBeTruthy());
  }
});

it("no longer prints an action count", () => {
  render(<DeckDetail {...props} />);
  expect(screen.queryByText(/\d+ actions/)).toBeNull();
});

it("renders Work, Pull request and Sessions as single-line strips", () => {
  render(<DeckDetail {...props} />);
  expect(screen.getByText("⎇ feat/proj-142-retry")).toBeTruthy();
  expect(screen.getByText(/CI green/)).toBeTruthy();
});
```

Assert with `waitFor`, never a bare tick — a `FileReader` can outlive a `setTimeout(0)` and land its post in the next test.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/webview -t "promotes exactly four"`
Expected: FAIL — no `group` named Actions

- [ ] **Step 3: Rebuild the drawer body**

In `DeckDetail.tsx`: keep the header exactly as it is (the two-row identity/title block is measured and its comments explain why). Then, in order — a `<div className="dd-acts" role="group" aria-label="Actions">` of promoted buttons; the Work / Pull request / Sessions strips; and a `<details className="dd-more">` whose `<summary>` reads `More — copy, per-repo diffs, spend breakdown, forget` and whose body holds the existing grouped action list and the spend table, unchanged. Delete the `dd-count` element and the `count` computation.

Keep the `Action` list-as-data shape and the explicit `aria-label` on each row — without it the accessible name folds the hint into the label.

- [ ] **Step 4: Widen and make it resizable**

In `deckStyles.ts`, replace `.dd { width: 460px; … }` with a variable, and make the board's reserved padding track it rather than the hardcoded `470px`:

```css
  .dd { --dd-w: 620px; width: var(--dd-w); overflow: hidden auto; }
  .board.dd-open { padding-right: calc(var(--dd-w, 620px) + 10px); }
```

Reuse the Orchestrator drawer's own resize: `clampOrchWidth`, `DRAG_SEP`, the arrow-key step and the `OrchPersisted` write. Extract them from `OrchestratorDrawer.tsx` into a shared module beside `Drawer.tsx` if that is the smaller change — the two drawers are already one object behind `Drawer.tsx`, and a second copy of the resize is exactly the drift that module exists to prevent.

- [ ] **Step 5: Run the webview suite and the build**

Run: `npx vitest run test/webview && npm run build`
Expected: PASS, four bundles.

- [ ] **Step 6: Verify in a real editor window**

Launch the dev host with **VS Code's own CLI** — the Cursor CLI silently drops the flag:

```bash
code --extensionDevelopmentPath=$(pwd)
```

Open the Deck, select a card, and check: the drawer is wider, drag and arrow-key resize work, the board scrolls clear of it, and `More` opens. **jsdom is blind to drag** — an element with `draggable` cannot be text-selected in Blink and `preventDefault` on `dragstart` does not give the gesture back, so the resize handle has to be seen to be believed.

- [ ] **Step 7: Commit**

```bash
git add src/webview/DeckDetail.tsx src/webview/deckStyles.ts test/webview
git commit -m "feat(deck): a card drawer with priorities"
```

---

### Task 10: `WorkflowBlock` — the live stepper

**Files:**
- Create: `src/webview/WorkflowBlock.tsx`
- Modify: `src/webview/deckStyles.ts`
- Test: Create `test/webview/workflowBlock.test.tsx`

**Interfaces:**
- Consumes: `WorkflowState`, `StepState` from `attach.ts`; `ruleLine` / `endLabel` / `COND_LABEL` from `orchestratorRule.ts` — **reuse them; do not write a second copy of how a rule reads.** A faithful second copy today is the drift "one model, two presentations" warns about.
- Produces: `WorkflowBlock(props: WorkflowBlockProps): JSX.Element`, with

```ts
export interface WorkflowBlockProps {
  flow: Flow | undefined;      // undefined → the empty "no workflow" state
  state: WorkflowState | undefined;
  extraCount: number;          // "+N more" when two flows bind this card
  onAttach: () => void;
  onArm: (armed: boolean) => void;
  onDetach: () => void;
  onAnswerGate: (edgeId: string, answer: "approved" | "rejected") => void;
  onResetEdge: (edgeId: string) => void;
  onOpenInWorkflows: () => void;
}
```

- [ ] **Step 1: Write the failing tests**

```tsx
// @vitest-environment jsdom

it("offers Attach workflow when nothing is attached", async () => {
  render(<WorkflowBlock {...base} flow={undefined} state={undefined} />);
  expect(screen.getByText("No workflow attached")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Attach workflow…" }));
  expect(base.onAttach).toHaveBeenCalled();
});

it("shows Arm and greys the steps when disarmed", () => {
  render(<WorkflowBlock {...base} state={{ status: "disarmed", done: 0, total: 2, steps: twoWaiting }} />);
  expect(screen.getByRole("button", { name: "Arm" })).toBeTruthy();
  expect(screen.getByText("disarmed")).toBeTruthy();
});

it("rings the current step and prints why it waits", () => {
  render(<WorkflowBlock {...base} state={{
    status: "advancing", done: 2, total: 5,
    steps: [...twoDone, { edgeId: "e3", state: "now", receipt: "1 of 2 approvals" }],
  }} />);
  expect(screen.getByText("2 of 5")).toBeTruthy();
  expect(screen.getByText("1 of 2 approvals")).toBeTruthy();
});

it("offers Approve and Reject on a gate, and answers it", async () => {
  render(<WorkflowBlock {...base} state={{
    status: "waiting-on-you", done: 1, total: 3,
    steps: [{ edgeId: "e2", state: "you", receipt: "waiting for your answer" }],
  }} />);
  await userEvent.click(screen.getByRole("button", { name: "Approve" }));
  expect(base.onAnswerGate).toHaveBeenCalledWith("e2", "approved");
});

it("offers Reset on a failed step and prints the error verbatim", async () => {
  render(<WorkflowBlock {...base} state={{
    status: "stopped", done: 1, total: 2,
    steps: [{ edgeId: "e2", state: "fail", receipt: "exit 1 · 3 assertions failed" }],
  }} />);
  expect(screen.getByText("exit 1 · 3 assertions failed")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Reset" }));
  expect(base.onResetEdge).toHaveBeenCalledWith("e2");
});

it("offers Detach when every rule has settled", () => {
  render(<WorkflowBlock {...base} state={{ status: "done", done: 2, total: 2, steps: twoDone }} />);
  expect(screen.getByRole("button", { name: "Detach" })).toBeTruthy();
});

it("says how many other workflows bind this card", () => {
  render(<WorkflowBlock {...base} extraCount={1} />);
  expect(screen.getByText("+1 more")).toBeTruthy();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/webview/workflowBlock.test.tsx`
Expected: FAIL — cannot resolve `WorkflowBlock`

- [ ] **Step 3: Write the component**

One row per rule in `flow.edges` order, each `<div className={"wf-step " + step.state}>` carrying a marker, the rule sentence from `orchestratorRule.ts`, the receipt, and — for `you` and `fail` only — its inline buttons. The header carries the name, a status chip, `done of total`, and `Open in Workflows ↗`.

Hue rules, which the design doc makes non-negotiable: `--c-done` for a settled step, `--c-progress` for the current one, `--c-attn` for a gate, `--c-danger` for a failure, and **nothing loud for a step that is merely not yet**. Register any new `--brand` usage — `tokens.test.ts` asserts set equality per stylesheet, so a new brand rule fails the gate until it is on the allowlist, and a state colour should use `--c-done` and friends rather than `--brand` anyway.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/webview/workflowBlock.test.tsx`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/webview/WorkflowBlock.tsx src/webview/deckStyles.ts test/webview/workflowBlock.test.tsx
git commit -m "feat(deck): a workflow's rules, live, in the card drawer"
```

---

### Task 11: Wire the block into the drawer, with the attach picker

**Files:**
- Modify: `src/webview/DeckDetail.tsx`
- Modify: `src/webview/DeckApp.tsx:1037-1047` (the `DeckDetail` call site)
- Test: `test/webview/deckDetail.test.tsx`

**Interfaces:**
- Consumes: `WorkflowBlock`, `attachedWorkflows`, `rankByState`, `workflowState`
- Produces: `DeckDetailProps` gains `flows: Flow[]`, `templates: FlowTemplate[]`, `runs: RunStatus[]`, `branchCi: Record<string, BranchCiStatus>`, `orchEnabled: boolean`

- [ ] **Step 1: Write the failing tests**

```tsx
it("shows the workflow bound to this card", () => {
  render(<DeckDetail {...props} flows={[shipItOn("PROJ-142")]} orchEnabled />);
  expect(screen.getByText("Ship it")).toBeTruthy();
});

it("shows no Workflow section at all when the orchestrator is off", () => {
  // New behaviour ships inert: agentFlow.orchestrator defaults to false.
  render(<DeckDetail {...props} flows={[shipItOn("PROJ-142")]} orchEnabled={false} />);
  expect(screen.queryByText("Workflow")).toBeNull();
});

it("picks the workflow that most needs a human when two bind the card", () => {
  const stopped = { ...shipItOn("PROJ-142"), id: "f-stop", name: "Hotfix", createdAt: 200,
    edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, error: "exit 1" }] };
  render(<DeckDetail {...props} flows={[shipItOn("PROJ-142"), stopped]} orchEnabled />);
  expect(screen.getByText("Hotfix")).toBeTruthy();
  expect(screen.getByText("+1 more")).toBeTruthy();
});

it("attaching sends flow:attach with the card's run key", async () => {
  render(<DeckDetail {...props} flows={[]} templates={[shipItTemplate]} orchEnabled />);
  await userEvent.click(screen.getByRole("button", { name: "Attach workflow…" }));
  await userEvent.click(await screen.findByRole("button", { name: /Ship it/ }));
  await waitFor(() => expect(sent()).toContainEqual(
    { type: "flow:attach", runKey: "PROJ-142", templateId: "k1" },
  ));
});

it("the picker filters by name", async () => {
  render(<DeckDetail {...props} flows={[]} templates={[shipItTemplate, reviewOnlyTemplate]} orchEnabled />);
  await userEvent.click(screen.getByRole("button", { name: "Attach workflow…" }));
  await userEvent.type(screen.getByPlaceholderText("Choose a template for PROJ-142…"), "review");
  await waitFor(() => expect(screen.queryByText("Ship it")).toBeNull());
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/webview -t "shows the workflow bound"`
Expected: FAIL

- [ ] **Step 3: Implement**

In `DeckDetail`, compute the workflow once and render the block as the section directly under the promoted actions:

```tsx
  const ticketKey = tracked ? key : r.inferredTicketKey;
  const bound = orchEnabled ? rankByState(attachedWorkflows(flows, key, ticketKey), runs, Date.now(), branchCi) : [];
  const wf = bound[0];
  const wfState = wf ? workflowState(wf, runs, Date.now(), branchCi) : undefined;
```

The picker is a search-and-tick list matching `+ Add command…`'s shape, with the placeholder `Choose a template for PROJ-142…`. When `bound.length > 0`, the picker's confirm sends `replace: true`.

In `DeckApp.tsx`, pass `flows`, `templates`, `runs`, `branchCi` and `orchEnabled` — all already in that component's state.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/webview && npm run build`
Expected: PASS, four bundles.

- [ ] **Step 5: Commit**

```bash
git add src/webview/DeckDetail.tsx src/webview/DeckApp.tsx test/webview
git commit -m "feat(deck): attach a workflow from the card that needs it"
```

---

### Task 12: The card chip

**Files:**
- Modify: `src/webview/DeckApp.tsx` (the `Card` component's foot)
- Modify: `src/webview/deckStyles.ts`
- Test: `test/webview/deckApp.test.tsx` (the existing file that renders cards)

**Interfaces:**
- Consumes: `attachedWorkflows`, `rankByState`, `workflowState`
- Produces: no new exports

- [ ] **Step 1: Write the failing tests**

```tsx
it("names the workflow on an advancing card, with no progress count", () => {
  renderBoard({ flows: [shipItOn("PROJ-142")] });
  const chip = screen.getByTitle(/Ship it/);
  expect(chip.textContent).toBe("Ship it");
  expect(chip.textContent).not.toMatch(/\d+ of \d+/);
});

it("says what a waiting workflow wants", () => {
  renderBoard({ flows: [gateOn("PROJ-142")] });
  expect(screen.getByText(/Ship it — approve/)).toBeTruthy();
});

it("says what a stopped workflow hit", () => {
  renderBoard({ flows: [failedOn("PROJ-142")] });
  expect(screen.getByText(/Ship it — smoke test failed/)).toBeTruthy();
});

it("shows no chip when the card has no workflow", () => {
  renderBoard({ flows: [] });
  expect(screen.queryByTitle(/Ship it/)).toBeNull();
});

it("shows no chip when the orchestrator is off", () => {
  renderBoard({ flows: [shipItOn("PROJ-142")], orchEnabled: false });
  expect(screen.queryByTitle(/Ship it/)).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/webview -t "names the workflow on an advancing card"`
Expected: FAIL

- [ ] **Step 3: Implement**

One `<span className={"c-wf " + status}>` in the card's foot. Hues: `--c-progress` for advancing, `--c-attn` for waiting-on-you, `--c-danger` for stopped, `--c-done` for done, and the dim foreground for disarmed.

**The hue rule is load-bearing:** amber on a card already means exactly one thing (the Highest chip) and red already means a real failure, so a workflow that is merely attached and fine takes the quiet blue. Only the two states that genuinely want a human borrow attention.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/webview`
Expected: PASS

- [ ] **Step 5: Verify on a real board**

`code --extensionDevelopmentPath=$(pwd)`, then look at a board of cards at rest: nothing should shout except the card that actually needs you.

- [ ] **Step 6: Commit**

```bash
git add src/webview/DeckApp.tsx src/webview/deckStyles.ts test/webview
git commit -m "feat(deck): a card says which workflow it carries"
```

---

### Task 13: Templates tab and the Save as template dialog

**Files:**
- Modify: `src/webview/OrchestratorDrawer.tsx`
- Modify: `src/webview/orchestratorStyles.ts`
- Test: `test/webview/orchestratorDrawer.test.tsx`

**Interfaces:**
- Consumes: `FlowTemplate`, `placesToDemote`, `DemotionChoice`
- Produces: no new exports

- [ ] **Step 1: Write the failing tests**

```tsx
it("lists templates on the Templates tab with their rule counts", async () => {
  render(<OrchestratorDrawer {...props} templates={[shipItTemplate]} />);
  await userEvent.click(screen.getByRole("button", { name: /Templates/ }));
  expect(await screen.findByText("Ship it")).toBeTruthy();
  expect(screen.getByText("5 rules")).toBeTruthy();
});

it("says how many cards a template is in use on", async () => {
  render(<OrchestratorDrawer {...props} templates={[shipItTemplate]} flows={[shipItOn("PROJ-142")]} />);
  await userEvent.click(screen.getByRole("button", { name: /Templates/ }));
  expect(await screen.findByText("on 1 card")).toBeTruthy();
});

it("offers no way to attach a template from here", async () => {
  // One entry point, and it is the card. A ticket picker in the header is a
  // second, worse way to do what the card already does.
  render(<OrchestratorDrawer {...props} templates={[shipItTemplate]} />);
  await userEvent.click(screen.getByRole("button", { name: /Templates/ }));
  expect(screen.queryByRole("button", { name: /Attach to/ })).toBeNull();
});

it("asks for a mode and destination per demoted place when saving", async () => {
  render(<OrchestratorDrawer {...props} openFlowId="f1" flows={[flowWithTwoPlaces()]} />);
  await userEvent.click(screen.getByRole("button", { name: "Save as template…" }));
  expect(await screen.findByLabelText("Name")).toBeTruthy();
  expect(screen.getAllByLabelText(/prompt mode/i)).toHaveLength(2);
  expect(screen.getAllByLabelText(/destination/i)).toHaveLength(2);
});

it("sends flow:saveTemplate with one choice per place", async () => {
  render(<OrchestratorDrawer {...props} openFlowId="f1" flows={[flowWithTwoPlaces()]} />);
  await userEvent.click(screen.getByRole("button", { name: "Save as template…" }));
  await userEvent.type(await screen.findByLabelText("Name"), "Ship it");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(sent()).toContainEqual({
    type: "flow:saveTemplate", id: "f1", name: "Ship it",
    choices: [
      { nodeId: "n1", mode: "plan", dest: "worktree" },
      { nodeId: "n2", mode: "plan", dest: "worktree" },
    ],
  }));
});

it("deleting a template confirms first", async () => {
  render(<OrchestratorDrawer {...props} templates={[shipItTemplate]} />);
  await userEvent.click(screen.getByRole("button", { name: /Templates/ }));
  await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
  expect(await screen.findByText(/Delete “Ship it”\?/)).toBeTruthy();
});
```

The dialog's dropdowns prefill with the configured default prompt mode and `worktree` — prefilling is fine, **inventing is not**: the value must be visible and changeable before Save.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/webview -t "lists templates on the Templates tab"`
Expected: FAIL

- [ ] **Step 3: Implement**

Two tabs above the existing flow list: `Running` (today's list, unchanged) and `Templates`. Template rows carry name, a rule summary, the rule count, `on N cards` (derived by counting `flows` whose shape came from that template — match on name and rule count, since a workflow does not store its origin), and `Duplicate` / `Rename` / `Delete`. Trailing row: `＋ New template`, which is the existing `onCreate`.

`Save as template…` goes on the open flow's own controls beside the existing Arm/Delete affordances.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/webview && npm run build`
Expected: PASS, four bundles.

- [ ] **Step 5: Commit**

```bash
git add src/webview/OrchestratorDrawer.tsx src/webview/orchestratorStyles.ts test/webview
git commit -m "feat(orchestrator): a Templates tab, and Save as template"
```

---

### Task 14: Vocabulary gate, docs and changelog

**Files:**
- Modify: `test/unit/vocabulary.test.ts`
- Modify: `docs/ORCHESTRATOR_COMMANDS.md`
- Modify: `CHANGELOG.md`
- Modify: `README.md` (only if it names the Orchestrator chip)

- [ ] **Step 1: Write the failing vocabulary test**

Extend `test/unit/vocabulary.test.ts` with the template/workflow rules, following that file's existing allowlist shape:

```ts
it("the UI never calls a workflow a flow", () => {
  // Same discipline as session/agent: the code says `Flow`, the UI says
  // Workflow. Identifiers, message names and setting ids are allowlisted.
  const offenders = uiStringsIn(["src/webview/WorkflowBlock.tsx", "src/webview/DeckDetail.tsx"])
    .filter((s) => /\bflows?\b/i.test(s.text) && !ALLOWED.has(s.id));
  expect(offenders).toEqual([]);
});

it("the UI never offers a template a workflow verb", () => {
  // A Templates row offering Detach, or a template being armed, is a category
  // error the reader has to untangle.
  expect(uiStringsIn(["src/webview/OrchestratorDrawer.tsx"])
    .filter((s) => /template/i.test(s.text) && /\b(arm|disarm|detach)\b/i.test(s.text)))
    .toEqual([]);
});
```

Beware: **the existing gate fires on the repo URL** — the hyphen in `agent-flow` makes "agent" a standalone word, so a settings description carrying the GitHub link fails CI while every obvious test stays green. Check the allowlist before assuming a failure is yours.

- [ ] **Step 2: Run it**

Run: `npx vitest run test/unit/vocabulary.test.ts`
Expected: FAIL first, then PASS once the strings are right.

- [ ] **Step 3: Document the new commands**

Add every `flow:*` message from Task 8 to `docs/ORCHESTRATOR_COMMANDS.md`, which is **authoritative over the spec** — when they disagree, the code wins and this file records it. `test/unit/docs.test.ts` asserts documentation coverage.

- [ ] **Step 4: Changelog**

Under `## [Unreleased]` in `CHANGELOG.md`:

```markdown
### Added
- **Workflows on a card.** Save a workflow you liked as a template, then attach it to any
  card from the card's own drawer — the workflow's rules show live in the drawer, with the
  step it is waiting on, why, and Approve / Reset where you noticed the problem. A chip on
  the card says which workflow it carries and whether it needs you.
- **Templates tab** in the Workflows drawer: rename, duplicate and delete saved shapes.

### Changed
- The card detail drawer is wider and resizable, with its most-used actions promoted and the
  rest behind **More**.
```

- [ ] **Step 5: Run every gate**

```bash
npm run typecheck
npm test                 # timeout: 600000
npm run build
npm run test:cov
```

Expected: all four pass, `compat.test.ts` **unmodified**, coverage at or above 90% lines/statements and 85% branches/functions.

- [ ] **Step 6: Commit and open a PR**

```bash
git add -A
git commit -m "docs(orchestrator): workflows, templates and the card drawer"
git push origin HEAD:refs/heads/feat/card-workflows
gh pr create --title "Workflows on a card" --body "…"
```

Push with a refspec so the shared root checkout is never switched to `main`.

---

## Self-Review

**Spec coverage.** Every decision maps to a task: §1 vocabulary → Tasks 3, 13, 14; §1 fixed name → Task 3's "keeps the template's name verbatim"; §2 derived attachment → Tasks 6, 7, 11; §3 card-only attach → Tasks 8, 11, and Task 13's "offers no way to attach"; §4 webview composition → Tasks 7, 10; §5 six states → Task 7 (engine) and Task 10 (rendering); §6 card chip → Task 12; §7 drawer → Task 9; §8 Templates tab → Task 13; §9 deferrals → nothing to build. The spec's `stripHostStamps` correction → Task 1. Its "engine must not import from `src/webview/`" consequence → Task 2, which the spec did not anticipate and this plan adds.

**Types.** `FlowTemplate`, `DemotionChoice`, `WorkflowState`, `StepState`, `WorkflowStatus` are each defined once, in the task that creates them, and later tasks use those exact names. `instantiate(t, ticketKey, flowId, nowMs)` has the same four parameters in Task 3's definition and Task 8's call. `attachedWorkflows(flows, runKey, ticketKey)` matches between Tasks 6 and 11.

**Known soft spot, flagged rather than hidden.** Task 13's `on N cards` matches a workflow to its template by name and rule count, because a workflow does not record which template it came from. That is a heuristic: rename a template and the count drops to zero. The honest alternatives are a `fromTemplate` id on `Flow` (a stored field, which §2 argues against for attachment but which is *not* the same claim — origin cannot be derived from the graph at all) or dropping the count. **Decide this before starting Task 13**, and if the count survives, prefer the stored origin id and say so in the spec.
