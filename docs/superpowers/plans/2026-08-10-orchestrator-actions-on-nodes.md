# Orchestrator Actions-on-Nodes and the Command Node — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the destination node the single home for a rule's action, add a
`command` node that runs a configured or free-text command unattended, and add
the two conditions that makes "wait for master's build, then deploy, then
verify, then message me" expressible — without dropping a single edge from any
flow file already on disk.

**Architecture:** `FlowEdge.action` stops being read. The action is derived from
the target node's `kind` (`planned`→`launch`, `place`→`seed`, `notify`→`notify`,
`command`→`run`) at evaluation time, carried on `FiredEdge` so every consumer
reads the same vintage, and written back into the edge record purely so older
builds can still parse the file. Command execution lives in a new pure module
with an injected runner, matching `launch.ts`'s posture.

**Tech Stack:** TypeScript, React (webview), vitest, esbuild, the `gh` CLI via
the existing `Runner` seam.

## Global Constraints

- `npm run build` must exit 0. Nothing reachable from `src/webview/` may import `fs`, `os`, `path`, or `child_process`, **even transitively** — `tsc` and the full test suite both pass regardless, so only the build catches it. `test/webview/webviewGraph.test.ts` pins the known-dangerous edges.
- `npx tsc --noEmit -p .` must be clean. `lib` is capped at **ES2022**: `Array.prototype.findLast` does not compile.
- Every module in `src/engine/orchestrator/` imports **no** `vscode`. The panel (`src/deckView.ts`) does all I/O.
- `src/engine/orchestrator/model.ts` has **zero imports** and must keep them.
- The full suite must pass. Where a task deliberately changes behaviour an existing test encodes, that test edit is called out in the task and in its commit message.
- New `--brand` spends must be added to `test/webview/tokens.test.ts`'s `PERMITTED_BRAND_SELECTORS` deliberately. New CSS custom properties must be declared in the sheet that uses them or added to `RUNTIME_ONLY`.
- No surface sheet may contain the string `prefers-reduced-motion` or `box-sizing`; `tokens.test.ts` enforces that the shared reset in `tokens.ts` owns both.
- Plain `grep` is shadowed by a shell function in this environment — use `/usr/bin/grep`.
- `String.replace` interprets `$&` and `$1` **in the replacement argument**. Any insertion of user-supplied text must be slice-based. `src/engine/prompt.ts` is the existing precedent.
- Run tests with `npx vitest run <path>`. Never leave a watcher running: stray vitest workers have stalled this repo's agents before.
- **Every new test must be mutation-checked**: break the guard the test claims to pin, run that single test, confirm it fails, restore, confirm it passes. Report both outputs. Plan-authored tests have been this project's dominant defect source — eight across phases 3 and 4, none found by reading.

---

## File Structure

**Created:**
- `src/engine/orchestrator/command.ts` — decide and run one command. Pure logic plus an injected runner; no `vscode`, no `child_process` import of its own.
- `src/engine/orchestrator/branchCi.ts` — turn a `gh` invocation into a branch-CI verdict. Pure mapping plus an injected runner.
- `test/unit/engine/orchestrator/command.test.ts`
- `test/unit/engine/orchestrator/branchCi.test.ts`
- `test/unit/engine/orchestrator/migration.test.ts` — the action-migration and edge-survival guards.

**Modified:**
- `src/engine/orchestrator/model.ts` — `CommandNode`, `actionFor`, `edgeAction`, `FlowAction` gains `"run"`, `FlowEdge.action` becomes optional.
- `src/engine/orchestrator/store.ts` — tolerant `validEdge`, the mismatch latch, the derived-action mirror on write.
- `src/engine/orchestrator/evaluate.ts` — derive the action once per fired edge; carry it on `FiredEdge`.
- `src/engine/orchestrator/runner.ts` — `applyFired` and `notifyLines` read the carried action.
- `src/engine/orchestrator/conditions.ts` — `command-succeeded`, `branch-ci-passed`.
- `src/engine/orchestrator/armability.ts` — branch-CI needs PR facts (the `gh` path).
- `src/deckView.ts` — the `run` case, the spend gate, receipts, the command output.
- `src/config.ts`, `src/types.ts`, `package.json` — `agentFlow.commands`.
- `src/webview/orchestratorRule.ts`, `src/webview/OrchestratorDrawer.tsx`, `src/webview/flowList.tsx`, `src/webview/orchestratorStyles.ts` — building and reading a command node; the notify rename.
- `docs/DECK.md`, `docs/TELEMETRY.md`.

---

### Task 1: The derived action, and a migration that keeps every edge

The riskiest change in the phase, first and alone. `store.ts:56-66`'s `validEdge`
requires `typeof e.action === "string"` and `coerceFlow` **drops** any edge that
fails, so a naive removal silently deletes every rule in every flow file on
disk. Thousands of installs.

**Files:**
- Modify: `src/engine/orchestrator/model.ts`
- Modify: `src/engine/orchestrator/store.ts`
- Test: `test/unit/engine/orchestrator/migration.test.ts` (create)
- Test: `test/unit/engine/orchestrator/model.test.ts` (extend)

**Interfaces:**
- Produces:
  - `export type FlowAction = "launch" | "seed" | "notify" | "run"`
  - `export function actionFor(kind: string): FlowAction | undefined`
  - `export function edgeAction(flow: Flow, e: FlowEdge): FlowAction | undefined`
  - `FlowEdge.action?: FlowAction` (optional; a derived mirror, never read for behaviour)
  - `export const ACTION_MISMATCH_PREFIX = "This rule's action no longer matches where it points"`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/engine/orchestrator/migration.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFlows, writeFlow } from "../../../../src/engine/orchestrator/store";
import { ACTION_MISMATCH_PREFIX } from "../../../../src/engine/orchestrator/model";
import type { Flow } from "../../../../src/engine/orchestrator/model";
import type { FlowIo } from "../../../../src/engine/orchestrator/store";

/** An in-memory FlowIo. `readDir` lists what has been written, so a test can
 * seed a file exactly as a previous build left it on disk. */
function fakeIo(files: Record<string, string> = {}): FlowIo & { files: Record<string, string> } {
  return {
    files,
    readDir: () => Object.keys(files).map((p) => p.split("/").pop()!),
    readFile: (p: string) => files[p] ?? null,
    writeFile: (p: string, text: string) => { files[p] = text; },
    remove: (p: string) => { delete files[p]; },
  };
}

// This is the format the SHIPPING build writes: `action` on every edge. It is
// written out here as a literal rather than built from the current types on
// purpose — the failure mode is silent edge deletion, and a fixture derived
// from the new types would encode this change's own assumptions instead of the
// format already sitting in users' ~/.agentflow/flows.
const LEGACY = JSON.stringify({
  id: "fmsm1way7-7bbm",
  name: "Ship the migration",
  armed: false,
  createdAt: 1_000,
  nodes: [
    { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-1", repo: "agent-flow" },
    { id: "n2", kind: "planned", x: 200, y: 0, join: "any", ticketKey: "ASM-2", repos: ["agent-flow"], mode: "plan", dest: "worktree" },
    { id: "n3", kind: "notify", x: 400, y: 0, join: "any", message: "landed" },
  ],
  edges: [
    { id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "launch" },
    { id: "e2", from: "n2", to: "n3", cond: { kind: "ci-passed" }, action: "notify" },
  ],
});

describe("reading a flow written by the shipping build", () => {
  it("keeps every edge", () => {
    const io = fakeIo({ "/flows/fmsm1way7-7bbm.json": LEGACY });
    const flows = readFlows(io, "/flows");
    expect(flows).toHaveLength(1);
    expect(flows[0].edges.map((e) => e.id)).toEqual(["e1", "e2"]);
  });

  it("keeps every edge of a flow written WITHOUT action", () => {
    const stripped = JSON.parse(LEGACY);
    for (const e of stripped.edges) delete e.action;
    const io = fakeIo({ "/flows/fmsm1way7-7bbm.json": JSON.stringify(stripped) });
    const flows = readFlows(io, "/flows");
    expect(flows[0].edges.map((e) => e.id)).toEqual(["e1", "e2"]);
  });
});

describe("an action that disagrees with where it points", () => {
  // `notify` pointing at a `place` is legal in the shipping build —
  // `actionMismatch` never refused it — and deriving the action from the target
  // would turn it into a `seed`, opening a PAID agent session where the user
  // asked only for a toast. It must latch instead.
  it("latches with an error rather than becoming a seed", () => {
    const doc = JSON.parse(LEGACY);
    doc.edges = [{ id: "e9", from: "n2", to: "n1", cond: { kind: "ci-passed" }, action: "notify" }];
    const io = fakeIo({ "/flows/fmsm1way7-7bbm.json": JSON.stringify(doc) });
    const e = readFlows(io, "/flows")[0].edges[0];
    expect(e.error).toContain(ACTION_MISMATCH_PREFIX);
    // Named both ways round, so the user can see what changed.
    expect(e.error).toContain("notify");
    expect(e.error).toContain("seed");
  });

  it("leaves an already-settled edge alone", () => {
    const doc = JSON.parse(LEGACY);
    doc.edges = [{ id: "e9", from: "n2", to: "n1", cond: { kind: "ci-passed" }, action: "notify", firedAt: 5 }];
    const io = fakeIo({ "/flows/fmsm1way7-7bbm.json": JSON.stringify(doc) });
    expect(readFlows(io, "/flows")[0].edges[0].error).toBeUndefined();
  });

  it("does not latch an edge whose action agrees", () => {
    const io = fakeIo({ "/flows/fmsm1way7-7bbm.json": LEGACY });
    for (const e of readFlows(io, "/flows")[0].edges) expect(e.error).toBeUndefined();
  });

  // A dangling edge is already handled as "gone" by evaluate.ts. Deriving
  // nothing must not be mistaken for deriving something different.
  it("does not latch an edge whose target is missing", () => {
    const doc = JSON.parse(LEGACY);
    doc.edges = [{ id: "e9", from: "n1", to: "nope", cond: { kind: "ci-passed" }, action: "notify" }];
    const io = fakeIo({ "/flows/fmsm1way7-7bbm.json": JSON.stringify(doc) });
    expect(readFlows(io, "/flows")[0].edges[0].error).toBeUndefined();
  });
});

describe("writeFlow's derived-action mirror", () => {
  // An OLDER build's validEdge REQUIRES `action`. A file this build wrote
  // without it would have every edge dropped after a downgrade or a rollback,
  // so the field is still written — derived from the target node, never from
  // whatever the edge happened to be carrying.
  it("writes the action derived from the target node", () => {
    const io = fakeIo();
    const flow = JSON.parse(LEGACY) as Flow;
    flow.edges = flow.edges.map((e) => ({ ...e, action: undefined }));
    writeFlow(io, "/flows", flow);
    const written = JSON.parse(io.files["/flows/fmsm1way7-7bbm.json"]);
    expect(written.edges.map((e: { action: string }) => e.action)).toEqual(["launch", "notify"]);
  });
});
```

Extend `test/unit/engine/orchestrator/model.test.ts`:

```ts
describe("actionFor", () => {
  it("maps every node kind to its action", () => {
    expect(actionFor("planned")).toBe("launch");
    expect(actionFor("place")).toBe("seed");
    expect(actionFor("notify")).toBe("notify");
    expect(actionFor("command")).toBe("run");
  });

  // The store admits an unknown `kind` string on purpose, so a flow written by a
  // NEWER build still renders here. It must derive no action rather than guess.
  it("derives nothing from an unknown kind", () => {
    expect(actionFor("teleport")).toBeUndefined();
    expect(actionFor("")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/orchestrator/migration.test.ts test/unit/engine/orchestrator/model.test.ts`
Expected: FAIL — `actionFor` and `ACTION_MISMATCH_PREFIX` are not exported.

- [ ] **Step 3: Add the derivation to `model.ts`**

Change `FlowAction` and make `action` optional, keeping the existing doc comment's
reasoning and adding why the field survives:

```ts
/** What a rule does when its condition is met, derived from the node it points
 * at — see `actionFor`. `run` executes a command node's command.
 *
 * Nothing here instructs a RUNNING agent; that remains impossible (see the
 * spec's out-of-scope note on `tell`). */
export type FlowAction = "launch" | "seed" | "notify" | "run";

/** The action a node kind implies. This is the single source of truth for "what
 * does this rule do", replacing the copy that used to live on the edge — the
 * drawer already refused every pairing except these, which is the tell that the
 * edge's copy was always redundant.
 *
 * Takes a `string`, not `FlowNode["kind"]`: `store.ts`'s `validNode` admits an
 * unknown kind on purpose so a flow written by a newer build still renders, and
 * such a node must derive NO action rather than fall through to a wrong one. */
export function actionFor(kind: string): FlowAction | undefined {
  switch (kind) {
    case "planned": return "launch";
    case "place": return "seed";
    case "notify": return "notify";
    case "command": return "run";
    default: return undefined;
  }
}

/** The action this edge performs: the one its TARGET implies. `undefined` when
 * the target is missing or of a kind this build does not know. */
export function edgeAction(flow: Flow, e: FlowEdge): FlowAction | undefined {
  return actionFor(findNode(flow, e.to)?.kind ?? "");
}

/** The opening words of the error stamped on an edge whose stored action
 * disagrees with its target. Exported so the migration, the drawer's copy, and
 * the tests all name it once. */
export const ACTION_MISMATCH_PREFIX = "This rule's action no longer matches where it points";
```

On `FlowEdge`, replace the `action` field with:

```ts
  /** DERIVED, and never read to decide behaviour — `edgeAction` is. It stays on
   * the record for one reason: an OLDER build's `validEdge` *requires* it and
   * DROPS any edge without it, so a file this build wrote without the field
   * would lose every rule after a downgrade or a rollback. `writeFlow` keeps it
   * in step with the target node's kind. */
  action?: FlowAction;
```

Add `CommandNode` in Task 4, not here — Task 1 ships the derivation for the
three kinds that already exist plus the `"command"` case in `actionFor`, which
is inert until a command node can be built.

- [ ] **Step 4: Make `store.ts` tolerant, latch mismatches, and mirror on write**

In `validEdge`, replace the `action` requirement:

```ts
    // `action` is deliberately NOT required. It used to be, and an edge failing
    // this check is DROPPED — so requiring a field this build no longer writes
    // would silently delete every rule in every flow file already on disk.
    // When present it must still be a string, so genuine garbage is caught.
    (e.action === undefined || typeof e.action === "string") &&
```

Add above `coerceFlow`:

```ts
/** Latch any edge whose stored action disagrees with the action its target now
 * implies. The collapse is one-to-one for `launch` and `seed` — the drawer
 * refused every other pairing — but NOT for `notify`: nothing ever stopped a
 * notify rule from pointing at a `place`, and deriving the action from the
 * target would silently turn that into a `seed`, opening a paid agent session
 * where the user asked for a toast.
 *
 * The edge is kept, not dropped: the user's wiring is not ours to discard. It is
 * stamped with an `error`, which `isSettled` treats as terminal, so an armed
 * flow will not fire it and the drawer's existing stalled-rule affordance
 * surfaces it. Reset is how the user accepts the new reading. A latched rule
 * costs one click; a migration that spends money on a guess does not come back.
 *
 * Only unsettled edges are touched — an edge that already ran or already failed
 * is history, and rewriting its receipt would blame this migration for it. */
function latchActionMismatches(flow: Flow): Flow {
  return {
    ...flow,
    edges: flow.edges.map((e) => {
      if (e.action === undefined || isSettled(e)) return e;
      const derived = actionFor(flow.nodes.find((n) => n.id === e.to)?.kind ?? "");
      // Nothing derived means a missing or unknown target, which `evaluate.ts`
      // already reports as "gone". Absence is not disagreement.
      if (derived === undefined || derived === e.action) return e;
      return {
        ...e,
        error: `${ACTION_MISMATCH_PREFIX}: it was saved as "${e.action}" but where it points now means "${derived}". Reset the rule to accept that, or point it somewhere else.`,
      };
    }),
  };
}
```

Call it at the end of `coerceFlow`:

```ts
  const shaped = { ...(v as Flow), nodes: f.nodes.filter(validNode), edges: f.edges.filter(validEdge) };
  return latchActionMismatches(shaped);
```

In `writeFlow`, normalise before serialising:

```ts
export function writeFlow(io: FlowIo, dir: string, flow: Flow): void {
  // Keep `action` in step with the node each edge points at. Written for
  // COMPATIBILITY only (see `FlowEdge.action`): an older build requires the
  // field and drops edges that lack it, so a file we wrote without it would
  // lose every rule on a downgrade. Derived from the target, never carried
  // over from the edge, so this cannot preserve a stale disagreement.
  const normalised: Flow = {
    ...flow,
    edges: flow.edges.map((e) => {
      const derived = actionFor(flow.nodes.find((n) => n.id === e.to)?.kind ?? "");
      return derived === undefined ? e : { ...e, action: derived };
    }),
  };
  io.writeFile(fileFor(dir, flow.id), JSON.stringify(normalised, null, 2));
}
```

Import `actionFor`, `isSettled` and `ACTION_MISMATCH_PREFIX` from `./model`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/orchestrator/`
Expected: PASS.

- [ ] **Step 6: Mutation-check each new guard**

For each, break it, run only the affected test, confirm it fails, restore:
1. Make `validEdge` require `action` again → "keeps every edge of a flow written WITHOUT action" must fail.
2. Change `latchActionMismatches` to skip the `isSettled` check → "leaves an already-settled edge alone" must fail.
3. Change `derived === undefined` to fall through and latch → "does not latch an edge whose target is missing" must fail.
4. Make `writeFlow` carry `e.action` through instead of deriving → "writes the action derived from the target node" must fail.

Record each pair of outputs in the task report.

- [ ] **Step 7: Verify the gates and commit**

```bash
npx tsc --noEmit -p . && npm run build && npx vitest run
git add src/engine/orchestrator/model.ts src/engine/orchestrator/store.ts test/unit/engine/orchestrator/
git commit -m "feat(orchestrator): derive a rule's action from the node it points at"
```

---

### Task 2: Carry the derived action on `FiredEdge`

Every consumer must read the action from **one** vintage. `runner.ts:104`'s
comment already establishes this discipline for the current field ("Same
question, same copy") — a `launch` that a concurrent edit turned into something
else between evaluation and the write must not be announced one way and stamped
another. Deriving independently in three places would reintroduce exactly that.

**Files:**
- Modify: `src/engine/orchestrator/evaluate.ts`
- Modify: `src/engine/orchestrator/runner.ts`
- Test: `test/unit/engine/orchestrator/evaluate.test.ts`, `test/unit/engine/orchestrator/runner.test.ts`

**Interfaces:**
- Consumes: `actionFor`, `edgeAction` from Task 1.
- Produces: `FiredEdge` gains `action: FlowAction | undefined`. `notifyLines(flow, fired)` and `applyFired(flow, fired, nowMs, outcomes?)` keep their signatures and read `f.action`.

- [ ] **Step 1: Write the failing tests**

In `test/unit/engine/orchestrator/evaluate.test.ts`:

```ts
it("carries the action derived from each fired edge's target", () => {
  const flow: Flow = {
    id: "f1", name: "f", armed: true, createdAt: 0,
    nodes: [
      { id: "a", kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-1", repo: "agent-flow" },
      { id: "b", kind: "notify", x: 100, y: 0, join: "any", message: "hi" },
    ],
    edges: [{ id: "e1", from: "a", to: "b", cond: { kind: "pr-merged" } }],
  };
  const out = evaluateFlow({ flow, statuses: [mergedStatus("ASM-1", "agent-flow")], nowMs: 1 });
  expect(out.fired).toHaveLength(1);
  expect(out.fired[0].action).toBe("notify");
});
```

In `test/unit/engine/orchestrator/runner.test.ts`:

```ts
// The whole point of carrying the action: `notifyLines` must announce what was
// DECIDED, not re-derive from a copy that may have changed underneath it.
it("announces a notify from the carried action, not the current graph", () => {
  const flow = notifyFlow();                        // a -> b, b is a notify node
  const fired = [{ edge: flow.edges[0], perform: true, action: "notify" as const }];
  // The graph now says b is a place — a concurrent edit. The decision stands.
  const edited: Flow = {
    ...flow,
    nodes: [flow.nodes[0], { id: "b", kind: "place", x: 100, y: 0, join: "any", runKey: "ASM-9", repo: "r" }],
  };
  expect(notifyLines(edited, fired)).toEqual(["f: a rule fired."]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/unit/engine/orchestrator/evaluate.test.ts test/unit/engine/orchestrator/runner.test.ts`
Expected: FAIL — `action` is not on `FiredEdge`.

- [ ] **Step 3: Add the field and read it**

In `evaluate.ts`, extend `FiredEdge`:

```ts
export interface FiredEdge {
  edge: FlowEdge;
  /** Should the runner perform this edge's action, or only stamp it as fired? An
   * "all" junction stamps every incoming edge but acts once. */
  perform: boolean;
  /** The action this edge performs, derived ONCE here from the target node.
   * Carried rather than re-derived downstream so `applyFired`, `notifyLines`
   * and `deckView`'s dispatch all answer the same question against the same
   * copy of the graph — the discipline `notifyLines` already spells out.
   * `undefined` when the target is missing or of an unknown kind. */
  action: FlowAction | undefined;
}
```

Set it wherever a `FiredEdge` is built, using `edgeAction(i.flow, e)`. Replace
`isSpendAction(f.edge.action)` inside `evaluate.ts` with a check on the derived
value.

In `runner.ts`, change `notifyLines`'s loop and drop the now-unneeded `byId` index:

```ts
export function notifyLines(flow: Flow, fired: FiredEdge[]): string[] {
  const out: string[] = [];
  // Reads the action the DECISION carried, not one re-derived from `flow` —
  // `flow` here can be the copy the caller re-read immediately before writing,
  // and re-deriving would let a concurrent edit make this announce one thing
  // while `applyFired` stamps another. Same question, same copy; the copy is
  // now the FiredEdge itself.
  for (const f of fired) {
    if (!f.perform || f.action !== "notify") continue;
    const target = findNode(flow, f.edge.to);
    const message = target && target.kind === "notify" ? target.message : null;
    out.push(message ? `${flow.name}: ${message}` : `${flow.name}: a rule fired.`);
  }
  return out;
}
```

In `applyFired`, replace `hit.edge.action` with `hit.action`, updating the
comment to name the new carrier.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/unit/engine/orchestrator/`
Expected: PASS. Existing tests that construct a `FiredEdge` literal now need
`action`; add it to each, deriving the value the fixture's graph implies. Call
out that edit in the commit.

- [ ] **Step 5: Mutation-check**

1. Re-derive inside `notifyLines` from `flow` instead of reading `f.action` → "announces a notify from the carried action" must fail.
2. Hardcode `action: undefined` in `evaluate.ts` → the evaluate test must fail.

- [ ] **Step 6: Commit**

```bash
npx tsc --noEmit -p . && npm run build && npx vitest run
git add src/engine/orchestrator/evaluate.ts src/engine/orchestrator/runner.ts test/unit/engine/orchestrator/
git commit -m "refactor(orchestrator): carry the derived action on FiredEdge"
```

---

### Task 3: `deckView.ts` dispatches on the derived action

No behaviour change. This task exists so the panel stops reading `edge.action`
before a new action is added to it, keeping Task 6's diff about the command and
nothing else.

**Files:**
- Modify: `src/deckView.ts` (`advanceUnderLock`'s dedupe and dispatch, `spendTarget`, `performEdge`)
- Test: `test/unit/deckView.test.ts`

**Interfaces:**
- Consumes: `FiredEdge.action` from Task 2; `edgeAction` from Task 1.
- Produces: `performEdge(flow, edge, statuses, action)` — the action is now a parameter, so the panel cannot re-derive a different one than was decided.

- [ ] **Step 1: Write the failing test**

In `test/unit/deckView.test.ts`, alongside the existing acting tests:

```ts
// The action now comes from the node. An edge whose stored `action` says
// "notify" but which points at planned work must LAUNCH — the record's copy is
// a mirror, not an instruction.
it("acts on the node's action, not the edge's stored copy", async () => {
  const flow = flowWith({
    nodes: [placeNode("a", "ASM-1", "agent-flow"), plannedNode("b", "ASM-2")],
    edges: [{ id: "e1", from: "a", to: "b", cond: { kind: "pr-merged" }, action: "notify" }],
  });
  // ...arm, seed a merged PR, run one pass...
  expect(openWorkspace).toHaveBeenCalledTimes(1);
});
```

Note for the implementer: this test must be written against the harness already
in `deckView.test.ts` (328 tests) — reuse its existing flow/status builders and
its pass-driving helper rather than inventing new ones. If no builder with these
names exists, use whatever that file actually provides and keep the assertion.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/unit/deckView.test.ts -t "acts on the node's action"`
Expected: FAIL — the stored `notify` wins, so nothing launches.

- [ ] **Step 3: Replace every `edge.action` read in `deckView.ts`**

- `advanceUnderLock`'s per-target dedupe: `isSpendAction(f.edge.action)` → `f.action !== undefined && isSpendAction(f.action)`.
- The dispatch guard, same change.
- `spendTarget(flow, edge)` → `spendTarget(flow, edge, action: FlowAction | undefined)`, branching on the parameter.
- `performEdge(flow, edge, statuses)` → `performEdge(flow, edge, statuses, action)`, branching on the parameter.

Add to `performEdge`, before the existing branches:

```ts
    // An action the target does not imply cannot be performed. Reached when the
    // target is missing or of a kind this build does not know — the same
    // situation `evaluate.ts` reports as "gone", stamped here so the rule
    // settles instead of being re-evaluated every poll forever.
    if (action === undefined) {
      return {
        kind: "done",
        outcome: { ok: false, error: `this rule points at ${edge.to}, which is not a place, planned work, a notification, or a command.` },
      };
    }
```

- [ ] **Step 4: Run the suite**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: PASS, all 329.

- [ ] **Step 5: Mutation-check**

Revert the dispatch to `edge.action` → the new test must fail.

- [ ] **Step 6: Commit**

```bash
npx tsc --noEmit -p . && npm run build && npx vitest run
git add src/deckView.ts test/unit/deckView.test.ts
git commit -m "refactor(deck): dispatch a rule on its node's action"
```

---

### Task 4: The `command` node type and `agentFlow.commands`

**Files:**
- Modify: `src/engine/orchestrator/model.ts`, `src/types.ts`, `src/config.ts`, `package.json`
- Test: `test/unit/config.test.ts`, `test/unit/engine/orchestrator/model.test.ts`

**Interfaces:**
- Produces:
  - `export type CommandNode = NodeBase & { kind: "command"; commandId?: string; run?: string; cwdRepo?: string }`
  - `export function isCommand(n: FlowNode): n is CommandNode`
  - `FlowNode` gains `CommandNode`
  - `src/types.ts`: `export interface FlowCommand { id: string; label: string; run: string; detail?: string }`
  - `src/config.ts`: `AgentFlowConfig.commands: FlowCommand[]`, and `export const DEFAULT_COMMANDS: FlowCommand[] = []`

- [ ] **Step 1: Write the failing tests**

`test/unit/engine/orchestrator/model.test.ts`:

```ts
it("recognises a command node", () => {
  const n: FlowNode = { id: "c", kind: "command", x: 0, y: 0, join: "any", commandId: "deploy" };
  expect(isCommand(n)).toBe(true);
  expect(isCommand({ id: "p", kind: "place", x: 0, y: 0, join: "any", runKey: "K", repo: "r" })).toBe(false);
});

// `run` spends: it executes shell on the user's machine unattended.
// `isSpendAction`'s own comment warns a new action defaults to "free" until
// added deliberately, and free would mean skipping the consent gate.
it("treats run as a spending action", () => {
  expect(isSpendAction("run")).toBe(true);
});
```

`test/unit/config.test.ts`:

```ts
it("reads commands, dropping entries with no id or no run", () => {
  cfg({ commands: [
    { id: "deploy", label: "Deploy to staging", run: "gh workflow run deploy.yml" },
    { id: "", label: "nameless", run: "true" },
    { id: "noRun", label: "No command" },
  ] });
  expect(getConfig().commands).toEqual([
    { id: "deploy", label: "Deploy to staging", run: "gh workflow run deploy.yml" },
  ]);
});

// Unlike promptModes there are no built-ins to layer over — an empty list is a
// legitimate answer, and must not fall back to anything.
it("returns an empty list when the setting is absent", () => {
  cfg({});
  expect(getConfig().commands).toEqual([]);
});

it("falls back to a label when one is missing, never to a blank picker row", () => {
  cfg({ commands: [{ id: "deploy", run: "true" }] });
  expect(getConfig().commands[0].label).toBe("deploy");
});
```

Note: `cfg(...)` is `config.test.ts`'s existing helper for stubbing the
workspace configuration — use whatever that file already provides.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/unit/config.test.ts test/unit/engine/orchestrator/model.test.ts`
Expected: FAIL — `commands` and `isCommand` do not exist.

- [ ] **Step 3: Add the type, the config reader, and the manifest entry**

`model.ts`:

```ts
/** A command to run when a condition is met: a deploy, a webhook call, a
 * smoke test. Either `commandId` (an entry in `agentFlow.commands`) or `run`
 * (typed into the drawer), never both — `commandOf` in command.ts resolves
 * which, and refuses a node carrying neither.
 *
 * A command node is not a place: nothing observes it, and no condition asks
 * what it is "doing". What a LATER rule can ask is whether it succeeded, which
 * is what the `command-succeeded` condition reads off the receipt. */
export type CommandNode = NodeBase & {
  kind: "command";
  commandId?: string;
  run?: string;
  /** Which repo's checkout to run in. Absent means the repo of the place the
   * incoming edge came from — the common case, and the one that needs no
   * configuration. */
  cwdRepo?: string;
};

export function isCommand(n: FlowNode): n is CommandNode {
  return n.kind === "command";
}
```

Add `CommandNode` to the `FlowNode` union and `"run"` to `isSpendAction`'s
allowlist, extending its comment to say why.

`src/types.ts`:

```ts
/** One entry in `agentFlow.commands`: a named command a flow rule can run.
 * `run` may contain `{note}`, substituted with the rule's own free text. */
export interface FlowCommand {
  id: string;
  label: string;
  run: string;
  detail?: string;
}
```

`src/config.ts` — a reader in the shape of `readEnvironments`, NOT
`resolveModes`: there are no built-ins to layer over, so an empty list is a real
answer and must not fall back.

```ts
/** No built-ins to layer over, unlike `promptModes` — so an empty result is
 * returned as-is rather than falling back to defaults. A command list is
 * something the user opts into; inventing entries would put commands in a
 * picker that nobody asked to be able to run.
 *
 * An entry with no usable `id` or no `run` is dropped: the id is how a node
 * refers to it, and a command with nothing to execute is a picker row that
 * fails at the moment it is trusted. A missing `label` falls back to the id
 * rather than rendering a blank row. */
function readCommands(c: vscode.WorkspaceConfiguration): FlowCommand[] {
  const raw = c.get<unknown[]>("commands");
  if (!Array.isArray(raw)) return [];
  const out: FlowCommand[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const e = v as Partial<FlowCommand>;
    const id = typeof e.id === "string" ? e.id.trim() : "";
    const run = typeof e.run === "string" ? e.run.trim() : "";
    if (!id || !run || seen.has(id)) continue;
    seen.add(id);
    const label = typeof e.label === "string" && e.label.trim() ? e.label.trim() : id;
    out.push({ id, label, run, ...(typeof e.detail === "string" && e.detail.trim() ? { detail: e.detail.trim() } : {}) });
  }
  return out;
}
```

Add `commands: readCommands(c)` to `getConfig()`'s returned object and
`commands: FlowCommand[]` to `AgentFlowConfig`.

`package.json`, in `contributes.configuration.properties`, after
`agentFlow.promptModes`:

```jsonc
"agentFlow.commands": {
  "type": "array",
  "default": [],
  "markdownDescription": "Commands an Orchestrator rule can run when its condition is met — a deploy, a webhook call, a smoke test. Each has an `id`, a `label` shown in the picker, the `run` command itself, and an optional `detail` line. `run` may contain `{note}`, replaced with the rule's own free text. **These run unattended on your machine**, so a flow asks once before it runs its first command. Unlike `#agentFlow.promptModes#` there are no built-ins: an empty list means no named commands.",
  "items": {
    "type": "object",
    "required": ["id", "run"],
    "properties": {
      "id": { "type": "string", "description": "Stable id, referenced by a flow's command node." },
      "label": { "type": "string", "description": "Shown in the rule picker. Defaults to the id." },
      "detail": { "type": "string", "description": "Optional line shown under the label." },
      "run": { "type": "string", "description": "The command to run. May contain {note}." }
    }
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/unit/config.test.ts test/unit/engine/orchestrator/`
Expected: PASS.

`test/unit/telemetry/settingsSnapshot.test.ts` asserts on the snapshot's shape.
If `commands` belongs in it, add it and the assertion; if it does not, say so in
the report with the reason. Do not silently leave the snapshot unexamined.

- [ ] **Step 5: Mutation-check**

1. Let `readCommands` keep an entry with an empty `run` → the dropping test must fail.
2. Make it fall back to a non-empty default when absent → the empty-list test must fail.

- [ ] **Step 6: Commit**

```bash
npx tsc --noEmit -p . && npm run build && npx vitest run
git add src/engine/orchestrator/model.ts src/types.ts src/config.ts package.json test/
git commit -m "feat(orchestrator): add the command node type and agentFlow.commands"
```

---

### Task 5: `command.ts` — resolve and run one command

**Files:**
- Create: `src/engine/orchestrator/command.ts`
- Test: `test/unit/engine/orchestrator/command.test.ts` (create)

**Interfaces:**
- Consumes: `CommandNode` (Task 4), `FlowCommand` (Task 4).
- Produces:

```ts
export const COMMAND_TIMEOUT_MS = 120_000;
export interface CommandRunner {
  (command: string, opts: { cwd: string; timeoutMs: number }):
    Promise<{ code: number; stdout: string; stderr: string }>;
}
export interface RunCommandRequest {
  node: CommandNode;
  commands: FlowCommand[];
  note?: string;
  cwd: string;
}
export type CommandOutcome =
  | { ok: true; code: 0; label: string; output: string }
  | { ok: false; message: string; label: string; output?: string };
export function resolveCommand(node: CommandNode, commands: FlowCommand[], note?: string):
  { ok: true; label: string; text: string } | { ok: false; message: string };
export function runCommand(req: RunCommandRequest, deps: { run: CommandRunner; log: (m: string) => void }):
  Promise<CommandOutcome>;
```

`COMMAND_TIMEOUT_MS` is 120 s and must stay well under `LOCK_TTL_MS` (300 s,
`lock.ts`): the flows lock is held across the act, and a command outliving the
TTL would have its own lock reaped mid-flight by another window.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/engine/orchestrator/command.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { COMMAND_TIMEOUT_MS, resolveCommand, runCommand } from "../../../../src/engine/orchestrator/command";
import type { CommandNode } from "../../../../src/engine/orchestrator/model";

const node = (over: Partial<CommandNode> = {}): CommandNode =>
  ({ id: "c1", kind: "command", x: 0, y: 0, join: "any", ...over });

const COMMANDS = [
  { id: "deploy", label: "Deploy to staging", run: "gh workflow run deploy.yml -f env={note}" },
  { id: "plain", label: "Plain", run: "echo hi" },
];

describe("resolveCommand", () => {
  it("substitutes the note into a configured command", () => {
    const r = resolveCommand(node({ commandId: "deploy" }), COMMANDS, "staging-eu");
    expect(r).toEqual({ ok: true, label: "Deploy to staging", text: "gh workflow run deploy.yml -f env=staging-eu" });
  });

  // Unlike a prompt, appending free text to a shell command changes what runs —
  // `echo hi` plus a note must never become `echo hi <note>`.
  it("never appends a note to a template with no placeholder", () => {
    const r = resolveCommand(node({ commandId: "plain" }), COMMANDS, "danger");
    expect(r).toEqual({ ok: true, label: "Plain", text: "echo hi" });
  });

  // `String.replace`'s replacement argument interprets $& and $1. A note is user
  // text and must reach the command verbatim.
  it("inserts a note containing $& and $1 verbatim", () => {
    const r = resolveCommand(node({ commandId: "deploy" }), COMMANDS, "a$&b$1c");
    expect(r).toMatchObject({ ok: true, text: "gh workflow run deploy.yml -f env=a$&b$1c" });
  });

  it("substitutes an absent note with the empty string", () => {
    expect(resolveCommand(node({ commandId: "deploy" }), COMMANDS, undefined))
      .toMatchObject({ text: "gh workflow run deploy.yml -f env=" });
  });

  it("uses a free-text command as written", () => {
    expect(resolveCommand(node({ run: "npm run deploy:staging" }), COMMANDS, "x"))
      .toEqual({ ok: true, label: "npm run deploy:staging", text: "npm run deploy:staging" });
  });

  it("refuses a node naming a command that is not configured", () => {
    const r = resolveCommand(node({ commandId: "gone" }), COMMANDS, undefined);
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toContain("gone");
  });

  it("refuses a node with neither a commandId nor a command", () => {
    expect(resolveCommand(node(), COMMANDS, undefined).ok).toBe(false);
  });

  // Both set is ambiguous, and guessing which wins would make the drawer's
  // display and what actually runs disagree.
  it("refuses a node carrying both", () => {
    expect(resolveCommand(node({ commandId: "plain", run: "rm -rf /" }), COMMANDS, undefined).ok).toBe(false);
  });
});

describe("runCommand", () => {
  it("reports success on exit 0 and keeps the output", async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: "deployed\n", stderr: "" });
    const out = await runCommand(
      { node: node({ commandId: "plain" }), commands: COMMANDS, cwd: "/repo" },
      { run, log: () => {} },
    );
    expect(out).toMatchObject({ ok: true, code: 0, label: "Plain" });
    expect((out as { output: string }).output).toContain("deployed");
    expect(run).toHaveBeenCalledWith("echo hi", { cwd: "/repo", timeoutMs: COMMAND_TIMEOUT_MS });
  });

  it("reports failure on a non-zero exit, naming the code", async () => {
    const run = vi.fn().mockResolvedValue({ code: 3, stdout: "", stderr: "boom" });
    const out = await runCommand(
      { node: node({ commandId: "plain" }), commands: COMMANDS, cwd: "/repo" },
      { run, log: () => {} },
    );
    expect(out.ok).toBe(false);
    expect((out as { message: string }).message).toContain("3");
  });

  // The caller is a poll loop inside the Deck's own refresh. An exception here
  // would take the whole refresh down, not just this rule — the same guarantee
  // launch.ts gives, and for the same reason.
  it("never throws when the runner rejects", async () => {
    const run = vi.fn().mockRejectedValue(new Error("ENOENT"));
    const out = await runCommand(
      { node: node({ commandId: "plain" }), commands: COMMANDS, cwd: "/repo" },
      { run, log: () => {} },
    );
    expect(out.ok).toBe(false);
    expect((out as { message: string }).message).toContain("ENOENT");
  });

  it("never runs anything when the command cannot be resolved", async () => {
    const run = vi.fn();
    const out = await runCommand(
      { node: node({ commandId: "gone" }), commands: COMMANDS, cwd: "/repo" },
      { run, log: () => {} },
    );
    expect(out.ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/unit/engine/orchestrator/command.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write `command.ts`**

No `vscode`, no `child_process` — the runner is injected, exactly as
`launch.ts` injects `openWorkspace`. Substitution is slice-based, reusing
`src/engine/prompt.ts`'s discipline (see its own comment on `$&`).

Key body:

```ts
/** Substitute `{note}` slice-by-slice. NEVER `String.replace`: its replacement
 * argument interprets `$&`, `$1` and friends, and a note is user text that must
 * reach the shell exactly as typed.
 *
 * A template with no `{note}` gets NOTHING appended, which is where this differs
 * from `composeAgentPrompt`. Appending stray words to a prompt adds context;
 * appending them to a command changes what executes. */
function withNote(template: string, note: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const at = template.indexOf("{note}", i);
    if (at === -1) return out + template.slice(i);
    out += template.slice(i, at) + note;
    i = at + "{note}".length;
  }
}
```

`runCommand` wraps its whole body in one `try`, calls `resolveCommand` first and
returns without running on a refusal, and logs the resolved command text plus
the full stdout/stderr through `deps.log`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/unit/engine/orchestrator/command.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Mutation-check**

1. Switch `withNote` to `template.replace("{note}", note)` → the `$&`/`$1` test must fail.
2. Append the note when there is no placeholder → "never appends a note" must fail.
3. Resolve before the `try` so a rejection escapes → "never throws" must fail.
4. Let a both-set node prefer `run` → "refuses a node carrying both" must fail.

- [ ] **Step 6: Commit**

```bash
npx tsc --noEmit -p . && npm run build && npx vitest run
git add src/engine/orchestrator/command.ts test/unit/engine/orchestrator/command.test.ts
git commit -m "feat(orchestrator): resolve and run a rule's command"
```

---

### Task 6: Wire the command into the acting path

**Files:**
- Modify: `src/deckView.ts`
- Test: `test/unit/deckView.test.ts`

**Interfaces:**
- Consumes: `runCommand`, `resolveCommand`, `COMMAND_TIMEOUT_MS`, `CommandOutcome` (Task 5); `SpendTarget` gains a `run` member.
- Produces: nothing later tasks depend on except the drawer's receipt text.

- [ ] **Step 1: Write the failing tests**

In `test/unit/deckView.test.ts`:

```ts
it("runs a command node's command when its condition is met", async () => { /* asserts the injected runner saw the resolved text and the repo cwd */ });

// The latch: a broken deploy must not run every poll forever.
it("latches a failed command and never retries it", async () => { /* two passes, one invocation, edge.error set */ });

// The consent gate. `run` is a spending action, so a flow that has never been
// confirmed must ask before its FIRST command — and that pass performs nothing,
// exactly like launch and seed.
it("asks once before a flow runs its first command, and runs nothing that pass", async () => { /* ... */ });

it("names the command in the confirmation, not just the flow", async () => { /* the modal text contains the resolved command */ });

// A command's output is how a failed deploy is diagnosed at all.
it("writes the command's output to the Deck channel", async () => { /* ... */ });
```

The implementer writes these against `deckView.test.ts`'s existing harness and
its `vscode` mock. Each assertion above is a behaviour, not a mock-call shape:
assert on what the flow file holds and what the injected runner received, not on
`expect.anything()`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/unit/deckView.test.ts -t command`
Expected: FAIL — no `run` case exists.

- [ ] **Step 3: Implement**

- `SpendTarget` gains `| { action: "run"; node: CommandNode; text: string; label: string; note?: string }`.
- `spendTarget` resolves a command node through `resolveCommand`, returning `undefined` when it cannot resolve — matching the existing reasoning that an unresolvable rule spends nothing and is stamped as an error below, so gating on it would ask about a rule that can never run.
- `askFirstSpend` gains a third branch naming the resolved command text (truncated through the existing `notePreview`, which is the same "do not grow the dialog unboundedly" concern) and using `Run` as its action verb.
- `performEdge` gains a `run` case: resolve the cwd (`node.cwdRepo`, else the source place's repo, else defer with a reason), call `runCommand` with a `CommandRunner` built over `child_process` in `deckView.ts` — **not** in `command.ts` — and map the outcome onto `ActOutcome`.
- Success and failure both produce a receipt; failure uses `showErrorMessage`, matching what this branch already does for a failed launch.

- [ ] **Step 4: Run the suite**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation-check**

1. Drop `"run"` from `isSpendAction` → the consent test must fail.
2. Return the outcome without stamping an error → the latch test must fail.
3. Retry rather than latch → the latch test must fail.

- [ ] **Step 6: Commit**

```bash
npx tsc --noEmit -p . && npm run build && npx vitest run
git add src/deckView.ts test/unit/deckView.test.ts
git commit -m "feat(deck): run a command node, gated by the once-per-flow consent"
```

---

### Task 7: The `command-succeeded` condition

**Files:**
- Modify: `src/engine/orchestrator/model.ts`, `src/engine/orchestrator/conditions.ts`, `src/webview/orchestratorRule.ts`
- Test: `test/unit/engine/orchestrator/conditions.test.ts`

**Interfaces:**
- Consumes: the receipt Task 6 stamps.
- Produces: `Condition` gains `{ kind: "command-succeeded" }`; `COND_LABEL` gains `"the command succeeded"`.

A command node is not a place, so `evalCond`'s `CondContext` (which is built
around a `RunStatus`) cannot answer this. The verdict lives on the **incoming
edge's** receipt: the edge that ran the command stamped `firedAt` and either an
`error` or a success note. So this condition is answered in `evaluate.ts`, from
the flow, not in `conditions.ts` from a status.

- [ ] **Step 1: Write the failing test**

```ts
it("is met when the edge into the command node succeeded", () => { /* ... */ });
it("is not met when that edge errored", () => { /* ... */ });
it("is not met before the command has run at all", () => { /* ... */ });
// Two rules into one command node: "succeeded" must mean the one that ran.
it("reads the edge that actually performed, not a stamped-only sibling", () => { /* ... */ });
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run test/unit/engine/orchestrator/`

- [ ] **Step 3: Implement** — add the kind to `Condition`, the label to `COND_LABEL` and `OFFERED_CONDS`, and the evaluation branch in `evaluate.ts` where the flow is in scope. Document why it is not in `conditions.ts`.

- [ ] **Step 4: Run** — full orchestrator suite.

- [ ] **Step 5: Mutation-check** — treat a stamped-only sibling as the performer → the fourth test must fail.

- [ ] **Step 6: Commit** — `feat(orchestrator): add the command-succeeded condition`

---

### Task 8: The `branch-ci-passed` condition

**Files:**
- Create: `src/engine/orchestrator/branchCi.ts`, `test/unit/engine/orchestrator/branchCi.test.ts`
- Modify: `src/engine/orchestrator/model.ts`, `src/engine/orchestrator/conditions.ts`, `src/engine/orchestrator/armability.ts`, `src/deckView.ts`
- Test: `test/unit/engine/orchestrator/conditions.test.ts`, `test/unit/engine/orchestrator/armability.test.ts`

**Interfaces:**
- Produces:
  - `Condition` gains `{ kind: "branch-ci-passed"; repo: string; branch: string }`
  - `export function mapBranchStatus(json: unknown): "passed" | "failed" | "pending" | "unknown"`
  - `export const BRANCH_CI_ARGS: (repo: string, branch: string) => string[]`
  - `CondContext` gains `branchCi?: Record<string, "passed" | "failed" | "pending" | "unknown">`, keyed `` `${repo}#${branch}` ``

- [ ] **Step 1: Write the failing tests**

`branchCi.test.ts` covers the mapping only — pure, no process:

```ts
it("reads success from a combined status", () => { expect(mapBranchStatus({ state: "success" })).toBe("passed"); });
it("reads failure", () => { expect(mapBranchStatus({ state: "failure" })).toBe("failed"); });
it("reads pending", () => { expect(mapBranchStatus({ state: "pending" })).toBe("pending"); });
// Every unreadable shape is "unknown", and unknown must never read as green.
it("is unknown for garbage, null, and a missing state", () => {
  for (const v of [null, undefined, {}, "success", { state: 7 }, []]) expect(mapBranchStatus(v)).toBe("unknown");
});
```

In `conditions.test.ts`:

```ts
it("is met only when that repo and branch passed", () => { /* ... */ });
// The worst outcome available: deploying because an API call failed.
it("is NOT met when the branch status is unknown or absent", () => { /* ... */ });
it("does not confuse two branches of the same repo", () => { /* main passed, release failed */ });
```

In `armability.test.ts`: an unfired `branch-ci-passed` rule reports
`needs: "pr-facts"` when PR facts are off, because it goes through the same `gh`
path that toggle governs.

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Implement**

`branchCi.ts` holds `mapBranchStatus` and `BRANCH_CI_ARGS` and imports nothing
that touches the filesystem, so `conditions.ts` — which the webview bundles —
stays clean. The `gh` invocation itself lives in `deckView.ts`, fetched once per
poll per distinct `repo#branch` (not per node) and passed in via `CondContext`.

`evalCond` gains:

```ts
    case "branch-ci-passed":
      // Unknown is NOT green. An armed flow that deploys because a `gh` call
      // failed is the worst outcome this condition can produce, so anything
      // other than an explicit pass reads as not met — the same posture every
      // other condition here takes toward an unreadable fact.
      return c.branchCi?.[`${cond.repo}#${cond.branch}`] === "passed";
```

- [ ] **Step 4: Run** — full suite.

- [ ] **Step 5: Mutation-check** — make `unknown` return true → the "NOT met when unknown" test must fail. Key the cache by repo alone → the two-branches test must fail.

- [ ] **Step 6: Commit** — `feat(orchestrator): add a branch-CI condition`

---

### Task 9: Build and read a command node in the drawer

**Files:**
- Modify: `src/webview/orchestratorRule.ts`, `src/webview/OrchestratorDrawer.tsx`, `src/webview/orchestratorStyles.ts`, `src/types.ts` (the `deck:flows` message gains `commands: FlowCommand[]`), `src/deckView.ts` (post it)
- Test: `test/webview/OrchestratorDrawer.test.tsx`, `test/webview/tokens.test.ts`

**Interfaces:**
- Consumes: `CommandNode`, `FlowCommand`, `actionFor`, `ACTION_MISMATCH_PREFIX`.
- Produces: `ACTION_LABEL` gains `run: "run"`; `DEST_LABEL` unchanged; `withCommandId`, `withCommandRun`, `addCommandNode`.

- [ ] **Step 1: Write the failing tests**

```tsx
it("adds a command node from the tray", () => { /* onSave carries a kind: "command" node */ });
it("offers every configured command, and a free-text option", () => { /* ... */ });
it("saves a free-text command", () => { /* ... */ });
// The one that matters: nothing in the UI could create a `planned` node in
// phase 3, which made the whole launch path unreachable. A command node with no
// way to be built would repeat that exactly.
it("builds a whole condition -> command rule from the drawer", () => { /* ... */ });
it("shows a migrated rule's mismatch error and offers Reset", () => { /* ... */ });
it("labels the notify action \"Notify me in VS Code\"", () => { /* ... */ });
```

- [ ] **Step 2–6:** implement, run `npx vitest run test/webview/`, mutation-check the tray-add and the free-text save, then commit as `feat(deck): build command rules in the Orchestrator drawer`.

Any new CSS custom property must be declared in `orchestratorStyles.ts` itself
(the `--orch-w` precedent) or added to `RUNTIME_ONLY`. Any new `--brand` spend
goes in `PERMITTED_BRAND_SELECTORS.orchestrator` with a comment.

---

### Task 10: The keyboard path

`flowList.tsx` is the non-pointer route onto the same `Flow`. A command node
reachable only by mouse would reintroduce the gap phase 4 closed.

**Files:**
- Modify: `src/webview/flowList.tsx`
- Test: `test/webview/flowList.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
it("adds a command node from the keyboard", () => { /* ... */ });
it("builds a condition -> command rule from the new-rule bar", () => { /* ... */ });
it("picks a configured command and a free-text one", () => { /* ... */ });
```

- [ ] **Step 2–6:** implement, run `npx vitest run test/webview/flowList.test.tsx`, mutation-check both add paths, commit as `feat(deck): build command rules from the keyboard`.

---

### Task 11: Make the docs true

**Files:**
- Modify: `docs/DECK.md`, `docs/TELEMETRY.md`, `README.md` (only if it names the actions)

- [ ] **Step 1: Read what the docs currently claim**

Run: `/usr/bin/grep -rn "notify\|action\|orchestrator" docs/DECK.md`

- [ ] **Step 2: Correct every claim this phase changed**

The action lives on the node; `notify` is "Notify me in VS Code"; a command node
exists and `agentFlow.commands` configures it; the two new conditions exist; a
flow asks once before its first command. State plainly that a command runs
unattended on the user's machine.

- [ ] **Step 3: Verify no stale claim survives**

Run: `/usr/bin/grep -rn "edge.action\|action on the rule" docs/`
Expected: no hits.

- [ ] **Step 4: Commit** — `docs: the action is the node, and a rule can run a command`

---

## Self-Review

**Spec coverage.** Every section maps to a task: the collapse → 1–3; the
migration hazard and the notify-mismatch case → 1; the command node → 4–6;
`{note}` discipline → 5; the consent gate → 6; `command-succeeded` → 7;
`branch-ci-passed` → 8; the notify rename → 9; the keyboard path → 10 (not in
the spec explicitly, added because phase 4 established it as a standing
requirement); docs → 11. Out-of-scope items (`tell`, a Slack client, the
`armability` live-signal branch) have no tasks, correctly.

**Type consistency.** `actionFor(kind: string)` is used identically in `store.ts`,
`evaluate.ts` and the drawer. `FiredEdge.action` is `FlowAction | undefined`
everywhere. `performEdge` and `spendTarget` both take the action as their last
parameter. `CommandOutcome` is produced only by `runCommand` and consumed only
in `deckView.ts`.

**Known softness, stated rather than hidden.** Tasks 7–10 carry test *names* and
intent rather than full test bodies. Those tests must be written against
harnesses whose exact helpers I did not read (`deckView.test.ts` is 328 tests,
`flowList.test.tsx` and `conditions.test.ts` have their own builders), and
inventing fixture helpers that do not exist is how this project's plan-authored
tests have failed before — a test asserting against a fake I imagined passes
while pinning nothing. Each of those tasks names the behaviour to pin and
requires a mutation check to prove the test earns its place. Tasks 1–6, which
carry the phase's real risk, are complete as written.
