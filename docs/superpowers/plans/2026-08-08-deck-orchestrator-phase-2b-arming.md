# Deck Orchestrator — Phase 2b: arming — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make arming mean something. An armed flow is evaluated on every Deck poll, a met rule fires exactly once and says so, and the flow keeps advancing while the panel is hidden — but it never acts on conditions that went true while you were away without your approval, and it tells you up front which of its rules can never fire.

**Architecture:** Phase 1's `evaluateFlow` finally gets a caller. A new pure module, `engine/orchestrator/runner.ts`, turns an `EvalResult` into two things — the flow with its latches stamped, and the sentences to show the user — so all of the decision-making stays testable from fixtures. `DeckPanel` does the impure part: it calls `evaluateFlow` at the end of `refresh()`, where the statuses already exist, then `writeFlow`s the stamped flow and posts the toasts. Arming, the resume gate and Reset are four new inbound messages. The only action that exists is `notify`; `launch` and `seed` are Phase 3.

**Tech Stack:** TypeScript, VS Code extension API, React (classic JSX runtime), Vitest, @testing-library/react with jsdom.

## Global Constraints

- Work in the existing worktree `/Users/oznasi/dev/agent-flow/.claude/worktrees/orchestrator-core` on branch `worktree-orchestrator-core`. Never the main checkout — `vsce package` packages the working directory.
- **`npm run build` must succeed before every commit**, in addition to typecheck and tests. The webview bundles for a BROWSER target, so nothing reachable from `src/webview/` may import `fs`, `os`, `path` or `child_process`, even transitively and even on a path that never runs — esbuild resolves statically. `test/webview/webviewGraph.test.ts` guards this; it walks **relative imports only**, so it will not catch a bare npm specifier that requires `fs`. Check the build's **exit code**, not the presence of `dist/deck.js` — esbuild does not clear `dist/`.
- `npx tsc --noEmit` clean and `npx vitest run` green before each commit. The suite is **2494 tests across 88 files** at the start of this phase; it must only grow.
- **≥95% line coverage on every file this plan creates or modifies.**
- **Do not touch** the `version` field in `package.json`, any version field in `package-lock.json`, or `CHANGELOG.md`. The `contributes.configuration` hunk of `package.json` is not needed by this phase either — no new setting.
- **`launch` and `seed` must remain unreachable.** The only action a rule can perform in this phase is `notify`. Nothing here may open a window, create a worktree or start an agent session. If a task seems to need one, stop and say so.
- **A place's agent state comes from `placeActivity`, never from `RunStatus.agent` directly.** This rule was broken once already, in the node badge, and produced contradictory claims in one panel. Grep for `.agent.state` before adding any status display.
- Do not change the persisted shape of a `Flow`, a node, an edge, or any condition-kind string — those live in users' files on disk.
- The Deck's house rules, which a reviewer will check: monospace for identifiers and counts only (English prose in the UI font); saturated colour is attention debt, so red only for a real failure; no persistent hint lines on cards; one primary per surface.
- **The drawer's one filled control is now Arm** — this is the phase that earns it. Nothing else in the drawer may be filled.
- Visual reference: `/Users/oznasi/dev/agent-flow/docs/mockups/2026-08-05-deck-orchestrator-drawer.html` (`?v=canvas`). Git-ignored, so read it at that absolute path in the primary checkout. It shows the armed footer and the `Armed · disarm` control.
- Conventional commits, scoped `orchestrator`.

## File Structure

| File | Responsibility |
|---|---|
| `src/engine/orchestrator/runner.ts` | *(new)* Pure. Turns an `EvalResult` into the stamped flow plus the user-facing sentences. No I/O, no `vscode`. |
| `src/engine/orchestrator/armability.ts` | *(new)* Pure. Given a flow and which data sources are on, which rules can never fire and why. |
| `src/deckView.ts` | *(modify)* Evaluate at the end of `refresh()`; own the resume gate; keep polling while armed; confirm on close; handle four new messages; merge host-owned edge fields on save. |
| `src/types.ts` | *(modify)* Four inbound messages, and the resume-gate fields on `deck:flows`. |
| `src/webview/OrchestratorDrawer.tsx` | *(modify)* Arm/disarm, the armed footer, the resume banner, Reset on a fired rule, and the two carried fixes. |
| `src/webview/orchestratorStyles.ts` | *(modify)* The Arm control, the armed footer state, the resume banner. |
| `src/webview/DeckApp.tsx` | *(modify)* Pass the new props through; fix the auto-open quirk. |
| `README.md` | *(modify)* The Deck's prose paragraph, which currently says nothing runs on its own yet. |

Tests: `test/unit/engine/orchestrator/runner.test.ts`, `test/unit/engine/orchestrator/armability.test.ts`, and additions to `test/unit/deckView.test.ts`, `test/webview/OrchestratorDrawer.test.tsx`, `test/webview/DeckApp.test.tsx`.

---

## Task 1: The runner — stamp the latches, say what happened

**Files:**
- Create: `src/engine/orchestrator/runner.ts`
- Test: `test/unit/engine/orchestrator/runner.test.ts`

**Interfaces:**
- Consumes: `Flow`, `FlowEdge`, `FlowNode`, `findNode` from `./model`; `FiredEdge`, `EvalResult` from `./evaluate`.
- Produces, both used by Task 3's `deckView.ts`:
  - `applyFired(flow: Flow, fired: FiredEdge[], nowMs: number): Flow` — a NEW flow with `firedAt` and `firedNote` stamped on every fired edge. Never mutates its input.
  - `notifyLines(flow: Flow, fired: FiredEdge[]): string[]` — one sentence per *performed* `notify` edge, for a toast.

This module is where "what happened" is decided, and it is pure so that decision is testable from fixtures without a panel, a filesystem or a clock.

`applyFired` stamps **every** fired edge, including the `perform: false` ones — an `all` junction stamps its whole set and only acts once, and an unstamped sibling would be re-evaluated forever. The note distinguishes the two: a performed edge records what it did, a stamped-only one records that its junction closed.

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine/orchestrator/runner.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { applyFired, notifyLines } from "../../../../src/engine/orchestrator/runner";
import { Flow, FlowEdge, FlowNode, JoinMode, NotifyNode, PlaceNode, emptyFlow } from "../../../../src/engine/orchestrator/model";
import { FiredEdge } from "../../../../src/engine/orchestrator/evaluate";

const NOW = 1_800_000_000_000;

const place = (id: string, runKey: string, join: JoinMode = "any"): PlaceNode =>
  ({ id, kind: "place", x: 0, y: 0, join, runKey, repo: `repo-${runKey}` });
const notify = (id: string, message: string, join: JoinMode = "any"): NotifyNode =>
  ({ id, kind: "notify", x: 0, y: 0, join, message });
const edge = (id: string, from: string, to: string, over: Partial<FlowEdge> = {}): FlowEdge =>
  ({ id, from, to, cond: { kind: "pr-merged" }, action: "notify", ...over });

const flowWith = (nodes: FlowNode[], edges: FlowEdge[]): Flow =>
  ({ ...emptyFlow("f1", "Ship the migration", 0), armed: true, nodes, edges });

describe("applyFired", () => {
  it("stamps firedAt and a note on a performed edge", () => {
    const flow = flowWith([place("a", "ASM-1"), notify("z", "the migration has landed")], [edge("e1", "a", "z")]);
    const out = applyFired(flow, [{ edge: flow.edges[0], perform: true }], NOW);
    expect(out.edges[0].firedAt).toBe(NOW);
    expect(out.edges[0].firedNote).toBeTruthy();
  });

  it("does not mutate the flow it is given", () => {
    const flow = flowWith([place("a", "ASM-1"), notify("z", "done")], [edge("e1", "a", "z")]);
    const before = JSON.stringify(flow);
    applyFired(flow, [{ edge: flow.edges[0], perform: true }], NOW);
    expect(JSON.stringify(flow)).toBe(before);
  });

  it("stamps a perform:false edge too — an unstamped junction sibling re-evaluates forever", () => {
    const flow = flowWith(
      [place("a", "ASM-1"), place("b", "ASM-2"), notify("z", "both landed", "all")],
      [edge("e1", "a", "z"), edge("e2", "b", "z")],
    );
    const out = applyFired(
      flow,
      [{ edge: flow.edges[0], perform: true }, { edge: flow.edges[1], perform: false }],
      NOW,
    );
    expect(out.edges.map((e) => e.firedAt)).toEqual([NOW, NOW]);
  });

  it("distinguishes a performed note from a stamped-only one", () => {
    const flow = flowWith(
      [place("a", "ASM-1"), place("b", "ASM-2"), notify("z", "both landed", "all")],
      [edge("e1", "a", "z"), edge("e2", "b", "z")],
    );
    const out = applyFired(
      flow,
      [{ edge: flow.edges[0], perform: true }, { edge: flow.edges[1], perform: false }],
      NOW,
    );
    expect(out.edges[0].firedNote).not.toBe(out.edges[1].firedNote);
    // The stamped-only one must not claim it did something.
    expect(out.edges[1].firedNote).toMatch(/junction|closed|with/i);
  });

  it("leaves an edge that did not fire completely alone", () => {
    const flow = flowWith([place("a", "ASM-1"), notify("y", "one"), notify("z", "two")], [edge("e1", "a", "y"), edge("e2", "a", "z")]);
    const out = applyFired(flow, [{ edge: flow.edges[0], perform: true }], NOW);
    expect(out.edges[1].firedAt).toBeUndefined();
    expect(out.edges[1].firedNote).toBeUndefined();
  });

  it("keeps every other field of the flow and of each edge", () => {
    const flow = flowWith([place("a", "ASM-1"), notify("z", "done")], [edge("e1", "a", "z", { cond: { kind: "ci-failed" } })]);
    const out = applyFired(flow, [{ edge: flow.edges[0], perform: true }], NOW);
    expect(out.name).toBe("Ship the migration");
    expect(out.armed).toBe(true);
    expect(out.edges[0].cond).toEqual({ kind: "ci-failed" });
    expect(out.nodes).toEqual(flow.nodes);
  });

  it("returns an equal flow when nothing fired", () => {
    const flow = flowWith([place("a", "ASM-1"), notify("z", "done")], [edge("e1", "a", "z")]);
    expect(applyFired(flow, [], NOW)).toEqual(flow);
  });

  it("ignores a fired edge whose id is not in the flow", () => {
    // Defensive: the runner is handed edges by the evaluator, but a stale
    // EvalResult must not be able to invent an edge.
    const flow = flowWith([place("a", "ASM-1"), notify("z", "done")], [edge("e1", "a", "z")]);
    const out = applyFired(flow, [{ edge: edge("ghost", "a", "z"), perform: true }], NOW);
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0].firedAt).toBeUndefined();
  });
});

describe("notifyLines", () => {
  it("names the flow and the notify node's own message", () => {
    const flow = flowWith([place("a", "ASM-1"), notify("z", "the migration has landed")], [edge("e1", "a", "z")]);
    const lines = notifyLines(flow, [{ edge: flow.edges[0], perform: true }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Ship the migration");
    expect(lines[0]).toContain("the migration has landed");
  });

  it("says nothing for a stamped-only edge — it performed nothing", () => {
    const flow = flowWith([place("a", "ASM-1"), notify("z", "done", "all")], [edge("e1", "a", "z")]);
    expect(notifyLines(flow, [{ edge: flow.edges[0], perform: false }])).toEqual([]);
  });

  it("says nothing for an action that is not notify", () => {
    // launch and seed do not exist in this phase; if one appears in a
    // hand-edited flow it must not produce a toast claiming it ran.
    const flow = flowWith([place("a", "ASM-1"), place("b", "ASM-2")], [edge("e1", "a", "b", { action: "launch" })]);
    expect(notifyLines(flow, [{ edge: flow.edges[0], perform: true }])).toEqual([]);
  });

  it("falls back gracefully when the target is not a notify node", () => {
    const flow = flowWith([place("a", "ASM-1"), place("b", "ASM-2")], [edge("e1", "a", "b")]);
    // action is notify but the target is a place — a hand-edited flow. One line,
    // no crash, and no invented message.
    const lines = notifyLines(flow, [{ edge: flow.edges[0], perform: true }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Ship the migration");
  });

  it("returns one line per performed notify edge", () => {
    const flow = flowWith(
      [place("a", "ASM-1"), notify("y", "first"), notify("z", "second")],
      [edge("e1", "a", "y"), edge("e2", "a", "z")],
    );
    const lines = notifyLines(flow, [
      { edge: flow.edges[0], perform: true },
      { edge: flow.edges[1], perform: true },
    ]);
    expect(lines).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/engine/orchestrator/runner.test.ts`
Expected: FAIL — cannot resolve `runner`.

- [ ] **Step 3: Write the implementation**

Create `src/engine/orchestrator/runner.ts`:

```ts
// What an armed flow's fired edges MEAN: the latches to stamp, and the sentences
// to show. Pure and total, so both decisions are testable from fixtures without a
// panel, a filesystem or a clock — the panel does the I/O.
import { FiredEdge } from "./evaluate";
import { Flow, findNode } from "./model";

/** Stamp `firedAt` and a receipt on every fired edge. Returns a new flow.
 *
 * Every fired edge is stamped, including the `perform: false` ones: an "all"
 * junction stamps its whole set and acts once, and a sibling left unstamped would
 * be re-evaluated on every pass forever. The note distinguishes them, because
 * "this ran" and "this junction closed" are different claims and the drawer shows
 * whichever it is told. */
export function applyFired(flow: Flow, fired: FiredEdge[], nowMs: number): Flow {
  if (fired.length === 0) return { ...flow, edges: flow.edges.map((e) => ({ ...e })) };
  const byId = new Map(fired.map((f) => [f.edge.id, f]));
  return {
    ...flow,
    edges: flow.edges.map((e) => {
      const hit = byId.get(e.id);
      if (!hit) return { ...e };
      return {
        ...e,
        firedAt: nowMs,
        firedNote: hit.perform ? performedNote(flow, hit) : "closed with its junction",
      };
    }),
  };
}

function performedNote(flow: Flow, hit: FiredEdge): string {
  if (hit.edge.action !== "notify") return `${hit.edge.action} — not available in this build`;
  const target = findNode(flow, hit.edge.to);
  return target && target.kind === "notify" ? `told you: ${target.message}` : "told you";
}

/** One sentence per PERFORMED notify edge, for a toast. A stamped-only edge did
 * nothing, so it says nothing — a toast for it would claim an action that never
 * happened. */
export function notifyLines(flow: Flow, fired: FiredEdge[]): string[] {
  const out: string[] = [];
  for (const f of fired) {
    if (!f.perform || f.edge.action !== "notify") continue;
    const target = findNode(flow, f.edge.to);
    const message = target && target.kind === "notify" ? target.message : null;
    out.push(message ? `${flow.name}: ${message}` : `${flow.name}: a rule fired.`);
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/engine/orchestrator/runner.test.ts`
Expected: PASS.

- [ ] **Step 5: All four gates**

Run: `npx tsc --noEmit`
Run: `rm -rf dist && npm run build` — expect exit 0
Run: `npx vitest run`
Run: `npx vitest run --coverage` — `runner.ts` at 100% lines

- [ ] **Step 6: Commit**

```bash
git add src/engine/orchestrator/runner.ts test/unit/engine/orchestrator/runner.test.ts
git commit -m "feat(orchestrator): decide what a fired edge stamps and says"
```

---

## Task 2: Armability — which rules can never fire, and why

**Files:**
- Create: `src/engine/orchestrator/armability.ts`
- Test: `test/unit/engine/orchestrator/armability.test.ts`

**Interfaces:**
- Consumes: `Flow`, `FlowEdge`, `Condition` from `./model`.
- Produces, used by Task 5's arm handler and Task 6's drawer:
  - `type SourceState = { liveSignal: boolean; prFacts: boolean }`
  - `interface UnfirableRule { edgeId: string; needs: "live-signal" | "pr-facts"; label: string }`
  - `unfirableRules(flow: Flow, sources: SourceState): UnfirableRule[]`

You decided arming should warn and name the rules rather than refuse. This module decides *which* rules, and it is pure so the wording is testable without a panel.

Which conditions depend on which source:
- **`live-signal`** — `agent-ended-turn` and `agent-idle-over`. They read transcript-derived state, which is `unknown` for everything when the Live signal is off, and an unknown state can never satisfy either. **`no-agent-left` is NOT in this set** — it counts sessions in the registry, which is populated regardless of the toggle.
- **`pr-facts`** — `pr-merged`, `ci-passed`, `ci-failed`, `review-approved`, `changes-requested`, `threads-resolved`, `pr-conflicting`. With PR facts off, `prs` is `{}` for every run and all seven read a missing entry.
- Nothing else depends on a toggle: git and ticket conditions always have their data.

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine/orchestrator/armability.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { unfirableRules, SourceState } from "../../../../src/engine/orchestrator/armability";
import { Condition, Flow, FlowEdge, emptyFlow } from "../../../../src/engine/orchestrator/model";

const edge = (id: string, cond: Condition): FlowEdge =>
  ({ id, from: "a", to: "z", cond, action: "notify" });
const flowOf = (...edges: FlowEdge[]): Flow => ({ ...emptyFlow("f1", "f", 0), edges });
const ALL_ON: SourceState = { liveSignal: true, prFacts: true };

describe("unfirableRules", () => {
  it("is empty when every source is on", () => {
    const flow = flowOf(edge("e1", { kind: "pr-merged" }), edge("e2", { kind: "agent-ended-turn" }));
    expect(unfirableRules(flow, ALL_ON)).toEqual([]);
  });

  it("names an agent rule when the Live signal is off", () => {
    const flow = flowOf(edge("e1", { kind: "agent-ended-turn" }));
    expect(unfirableRules(flow, { liveSignal: false, prFacts: true })).toEqual([
      { edgeId: "e1", needs: "live-signal", label: expect.any(String) },
    ]);
  });

  it("names agent-idle-over too", () => {
    const flow = flowOf(edge("e1", { kind: "agent-idle-over", minutes: 10 }));
    expect(unfirableRules(flow, { liveSignal: false, prFacts: true }).map((r) => r.edgeId)).toEqual(["e1"]);
  });

  it("does NOT name no-agent-left — it reads the session registry, not a transcript", () => {
    const flow = flowOf(edge("e1", { kind: "no-agent-left" }));
    expect(unfirableRules(flow, { liveSignal: false, prFacts: true })).toEqual([]);
  });

  it("names every PR condition when PR facts is off", () => {
    const kinds: Condition["kind"][] = [
      "pr-merged", "ci-passed", "ci-failed", "review-approved",
      "changes-requested", "threads-resolved", "pr-conflicting",
    ];
    const flow = flowOf(...kinds.map((k, i) => edge(`e${i}`, { kind: k } as Condition)));
    const out = unfirableRules(flow, { liveSignal: true, prFacts: false });
    expect(out).toHaveLength(kinds.length);
    expect(out.every((r) => r.needs === "pr-facts")).toBe(true);
  });

  it("never names a git or ticket condition — their data is always there", () => {
    const flow = flowOf(
      edge("e1", { kind: "tree-clean" }),
      edge("e2", { kind: "has-uncommitted" }),
      edge("e3", { kind: "nothing-to-push" }),
      edge("e4", { kind: "ticket-done" }),
      edge("e5", { kind: "ticket-status-is", status: "Done" }),
    );
    expect(unfirableRules(flow, { liveSignal: false, prFacts: false })).toEqual([]);
  });

  it("reports both kinds at once, in flow order", () => {
    const flow = flowOf(edge("e1", { kind: "pr-merged" }), edge("e2", { kind: "agent-ended-turn" }));
    const out = unfirableRules(flow, { liveSignal: false, prFacts: false });
    expect(out.map((r) => [r.edgeId, r.needs])).toEqual([
      ["e1", "pr-facts"],
      ["e2", "live-signal"],
    ]);
  });

  it("skips an edge that has already fired — it is not waiting on anything", () => {
    const flow = flowOf({ ...edge("e1", { kind: "pr-merged" }), firedAt: 1 });
    expect(unfirableRules(flow, { liveSignal: true, prFacts: false })).toEqual([]);
  });

  it("gives each rule a human label naming its condition", () => {
    const flow = flowOf(edge("e1", { kind: "ci-failed" }));
    const [only] = unfirableRules(flow, { liveSignal: true, prFacts: false });
    expect(only.label.toLowerCase()).toContain("ci");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/engine/orchestrator/armability.test.ts`
Expected: FAIL — cannot resolve `armability`.

- [ ] **Step 3: Write the implementation**

Create `src/engine/orchestrator/armability.ts`:

```ts
// Which of a flow's rules cannot fire given what the board is currently allowed to
// observe. Arming warns and names them rather than refusing: a flow with one dead
// rule and three live ones is still worth arming, and silence is how a user ends up
// waiting forever on something that can never happen.
import { Condition, Flow } from "./model";

/** The two Deck toggles a condition can depend on. */
export interface SourceState {
  liveSignal: boolean;
  prFacts: boolean;
}

export interface UnfirableRule {
  edgeId: string;
  needs: "live-signal" | "pr-facts";
  /** The condition, in the words the drawer uses. */
  label: string;
}

/** Conditions that read transcript-derived agent activity. With the Live signal
 * off, every activity is `unknown`, which neither of these can ever satisfy.
 * `no-agent-left` is deliberately absent: it counts sessions in the registry,
 * which is populated whether or not any transcript is read. */
const NEEDS_LIVE = new Set<Condition["kind"]>(["agent-ended-turn", "agent-idle-over"]);

/** Conditions that read a pull request. With PR facts off, `prs` is `{}` for every
 * run, so all of these read a missing entry and stay false forever. */
const NEEDS_PR = new Set<Condition["kind"]>([
  "pr-merged",
  "ci-passed",
  "ci-failed",
  "review-approved",
  "changes-requested",
  "threads-resolved",
  "pr-conflicting",
]);

/** The drawer's own wording, kept here so the warning reads like the rule does.
 * Deliberately a plain record rather than an import from the webview: this module
 * must stay free of anything a browser bundle cannot take. */
const LABEL: Record<Condition["kind"], string> = {
  "pr-merged": "PR is merged",
  "ci-passed": "CI passed",
  "ci-failed": "CI failed",
  "review-approved": "review approved",
  "changes-requested": "changes requested",
  "threads-resolved": "0 unresolved threads",
  "pr-conflicting": "branch conflicts",
  "agent-ended-turn": "agent ended its turn",
  "agent-idle-over": "agent idle over…",
  "no-agent-left": "no agent left",
  "tree-clean": "tree is clean",
  "has-uncommitted": "has uncommitted work",
  "nothing-to-push": "nothing to push",
  "ticket-done": "ticket reached done",
  "ticket-status-is": "ticket status is…",
};

export function unfirableRules(flow: Flow, sources: SourceState): UnfirableRule[] {
  const out: UnfirableRule[] = [];
  for (const e of flow.edges) {
    // An edge that already fired is not waiting on anything.
    if (e.firedAt !== undefined) continue;
    const label = LABEL[e.cond.kind];
    if (!sources.prFacts && NEEDS_PR.has(e.cond.kind)) out.push({ edgeId: e.id, needs: "pr-facts", label });
    else if (!sources.liveSignal && NEEDS_LIVE.has(e.cond.kind)) out.push({ edgeId: e.id, needs: "live-signal", label });
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/engine/orchestrator/armability.test.ts`
Expected: PASS.

- [ ] **Step 5: All four gates**

Run: `npx tsc --noEmit`; `rm -rf dist && npm run build` (exit 0); `npx vitest run`; `npx vitest run --coverage` — `armability.ts` at 100% lines.

- [ ] **Step 6: Commit**

```bash
git add src/engine/orchestrator/armability.ts test/unit/engine/orchestrator/armability.test.ts
git commit -m "feat(orchestrator): report which rules cannot fire with a source switched off"
```

---

## Task 3: Evaluate on every poll, and stamp what fired

**Files:**
- Modify: `src/types.ts`
- Modify: `src/deckView.ts`
- Test: `test/unit/deckView.test.ts`

**Interfaces:**
- Consumes: `evaluateFlow` from `./engine/orchestrator/evaluate`; `applyFired`, `notifyLines` from `./engine/orchestrator/runner`; `readFlows`, `writeFlow` from `./engine/orchestrator/store`.
- Produces: an armed flow advances on every `refresh()`. Task 4 adds the resume gate in front of this; Task 5 adds the arm message.

`refresh()` already builds `runs: RunStatus[]` and ends by calling `postFlows()` — that is where evaluation belongs, because the statuses already exist and cost nothing extra.

`test/unit/deckView.test.ts` mocks engine modules through a hoisted `h` object (see `vi.mock("../../src/engine/runs", …)` around line 92) and already mocks the flows store with `h.flows` / `h.writeFlow`. Use those. It has `lastPanel()`, `posts(p)`, `setConfig({ … })` and a `_fire`-based way to deliver an inbound message — follow the file's own idiom.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/deckView.test.ts`, in a new `describe` block:

```ts
describe("an armed flow advances on refresh", () => {
  /** A place node plus a notify terminal, wired with one condition. */
  const armedFlow = (over: Partial<Flow> = {}): Flow => ({
    ...mkFlow("f1", "Ship the migration"),
    armed: true,
    nodes: [
      { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-1", repo: "aws-ops" },
      { id: "n2", kind: "notify", x: 0, y: 0, join: "any", message: "the migration has landed" },
    ],
    edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" }],
    ...over,
  });

  it("stamps a met rule and posts a toast naming the flow", async () => {
    setConfig({ orchestrator: true });
    h.flows = [armedFlow()];
    // The status the evaluator will see: ASM-1's aws-ops PR is merged.
    h.buildRunStatus.mockReturnValue(mergedStatus("ASM-1", "aws-ops"));
    const { p } = await openPanel();
    await settle();
    const written = h.writeFlow.mock.calls.at(-1)?.[2] as Flow | undefined;
    expect(written?.edges[0].firedAt).toBeTypeOf("number");
    const toast = posts(p).find((m) => m.type === "toast" && /Ship the migration/.test(m.message));
    expect(toast).toBeTruthy();
  });

  it("fires once and not again on the next refresh", async () => {
    setConfig({ orchestrator: true });
    h.flows = [armedFlow()];
    h.buildRunStatus.mockReturnValue(mergedStatus("ASM-1", "aws-ops"));
    const { p } = await openPanel();
    await settle();
    // The store now returns the stamped flow, as it would on disk.
    h.flows = [h.writeFlow.mock.calls.at(-1)![2] as Flow];
    h.writeFlow.mockClear();
    await settle();
    expect(h.writeFlow).not.toHaveBeenCalled();
  });

  it("does nothing for a disarmed flow whose condition is met", async () => {
    setConfig({ orchestrator: true });
    h.flows = [armedFlow({ armed: false })];
    h.buildRunStatus.mockReturnValue(mergedStatus("ASM-1", "aws-ops"));
    await openPanel();
    await settle();
    expect(h.writeFlow).not.toHaveBeenCalled();
  });

  it("does nothing when the setting is off, even for an armed flow", async () => {
    setConfig({ orchestrator: false });
    h.flows = [armedFlow()];
    h.buildRunStatus.mockReturnValue(mergedStatus("ASM-1", "aws-ops"));
    await openPanel();
    await settle();
    expect(h.writeFlow).not.toHaveBeenCalled();
  });

  it("does not fire when the condition is not met", async () => {
    setConfig({ orchestrator: true });
    h.flows = [armedFlow()];
    h.buildRunStatus.mockReturnValue(openStatus("ASM-1", "aws-ops"));
    await openPanel();
    await settle();
    expect(h.writeFlow).not.toHaveBeenCalled();
  });

  it("never performs a launch or a seed — they do not exist in this build", async () => {
    // A hand-edited flow can hold action: "launch". It must be stamped so it does
    // not re-evaluate forever, but nothing may be opened or started.
    setConfig({ orchestrator: true });
    h.flows = [armedFlow({
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "launch" }],
    })];
    h.buildRunStatus.mockReturnValue(mergedStatus("ASM-1", "aws-ops"));
    const { p } = await openPanel();
    await settle();
    expect(h.openInEditor).not.toHaveBeenCalled();
    expect(h.writePlanFile).not.toHaveBeenCalled();
    // And no toast claims it ran.
    expect(posts(p).some((m) => m.type === "toast" && /launched/i.test(m.message ?? ""))).toBe(false);
  });
});
```

Add these three helpers near `mkFlow` in that file:

```ts
/** A RunStatus whose one repo's PR is in the given state, so a place node bound to
 * `{ runKey: key, repo }` resolves and its PR conditions have data. */
const prStatus = (key: string, repo: string, state: "OPEN" | "MERGED"): RunStatus => ({
  run: {
    key, summary: "s", url: `https://j/browse/${key}`, createdAt: 1, mode: "multiroot",
    repos: [{ name: repo, path: `/r/${repo}`, isGit: true }], briefPaths: [],
  },
  column: "progress",
  ticketStatus: "In Progress",
  ticketCategory: "indeterminate",
  repos: [{ name: repo, path: `/r/${repo}`, branch: "b", dirty: false, ahead: 0, added: 0, removed: 0, files: 0 }],
  agent: { state: "working", lastActivityMs: 1, slug: null },
  windowOpen: true,
  prs: {
    [repo]: {
      facts: {
        number: 1, url: "u", title: "t", state, isDraft: false,
        ci: { passing: 2, pending: 0, failing: [] }, review: "none", unresolved: null,
        mergeable: "clean", ciAdvisory: false,
      },
      fetchedAt: 1,
    },
  },
  agents: [],
});
const mergedStatus = (key: string, repo: string) => prStatus(key, repo, "MERGED");
const openStatus = (key: string, repo: string) => prStatus(key, repo, "OPEN");

/** Let the panel's in-flight refresh land. Two microtask drains is enough with
 * these mocks — nothing here does real I/O. */
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
```

Check the `RunStatus` field names against `src/types.ts` before trusting this fixture — the fields are `ticketStatus` and `ticketCategory` (they were renamed from `jiraStatus`/`jiraCategory`), and a stale name is a compile error. If the file already has a `RunStatus` builder for its PR-facts tests, extend that instead of adding a second one.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: FAIL — nothing evaluates, so `writeFlow` is never called.

- [ ] **Step 3: Evaluate at the end of `refresh()`**

Add the imports to `src/deckView.ts`:

```ts
import { evaluateFlow } from "./engine/orchestrator/evaluate";
import { applyFired, notifyLines } from "./engine/orchestrator/runner";
```

Add a method, and call it from `refresh()` immediately before `this.postFlows()` — passing the `runs` it already has:

```ts
  /** Advance every armed flow against the statuses this pass already built.
   *
   * Deliberately here rather than on its own timer: the statuses are the expensive
   * part and they exist by now, so evaluation is free. Each flow is evaluated,
   * stamped and written independently — one flow that throws must not stop the
   * others, the same posture `readFlows` takes with a corrupt file. */
  private advanceArmedFlows(runs: RunStatus[], nowMs: number): void {
    if (!getConfig().orchestrator) return;
    for (const flow of readFlows(this.flowIo, this.flowsDir)) {
      if (!flow.armed) continue;
      try {
        const result = evaluateFlow({ flow, statuses: runs, nowMs });
        if (result.fired.length === 0) continue;
        writeFlow(this.flowIo, this.flowsDir, applyFired(flow, result.fired, nowMs));
        for (const line of notifyLines(flow, result.fired)) {
          this.post({ type: "toast", level: "info", message: line });
        }
      } catch (e) {
        this.log(`deck: flow ${flow.id} failed to advance: ${e}`);
      }
    }
  }
```

In `refresh()`, immediately before `this.postFlows();`:

```ts
      this.advanceArmedFlows(runs, Date.now());
```

Because `advanceArmedFlows` writes before `postFlows()` reads, the webview receives the stamped flow in the same pass.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: PASS.

- [ ] **Step 5: All four gates**

Run: `npx tsc --noEmit`; `rm -rf dist && npm run build` (exit 0); `npx vitest run`; `npx vitest run --coverage` — the new `deckView.ts` lines ≥95%.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/deckView.ts test/unit/deckView.test.ts
git commit -m "feat(orchestrator): advance every armed flow on the Deck's own poll"
```

---

## Task 4: The resume gate — never act on stale conditions unasked

**Files:**
- Modify: `src/types.ts`
- Modify: `src/deckView.ts`
- Test: `test/unit/deckView.test.ts`

**Interfaces:**
- Consumes: `evaluateFlow`, `applyFired` (Tasks 1 and 3).
- Produces: the outbound `deck:flows` gains `pendingResume: PendingResume[]`, and two new inbound messages. Task 6's drawer renders the banner.

```ts
/** An armed flow with rules already met on the first pass after a (re)start. */
export interface PendingResume {
  flowId: string;
  flowName: string;
  /** One line per rule about to fire, in the drawer's own words. */
  lines: string[];
}
```
Inbound: `{ type: "flow:resumeApprove"; id: string }` and `{ type: "flow:resumeDisarm"; id: string }`.

**Why this exists.** An armed flow persists across restarts. Without a gate, opening the Deck after a week acts immediately on every condition that became true while you were away — and once Phase 3 lands, that means paid agent sessions starting before you have read anything. So the **first** evaluation pass after the panel is created does not act: it reports what it is about to do and waits for approval. Every pass after that fires normally, because by then you have seen the flow.

The gate is per panel, not persisted: it exists to protect the moment you come back, and re-arming ceremony on every poll would defeat arming.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/deckView.test.ts`:

```ts
describe("the resume gate", () => {
  const armedFlow = (): Flow => ({
    ...mkFlow("f1", "Ship the migration"),
    armed: true,
    nodes: [
      { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-1", repo: "aws-ops" },
      { id: "n2", kind: "notify", x: 0, y: 0, join: "any", message: "the migration has landed" },
    ],
    edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" }],
  });

  it("does not act on the first pass — it reports what is ready", async () => {
    setConfig({ orchestrator: true });
    h.flows = [armedFlow()];
    h.buildRunStatus.mockReturnValue(mergedStatus("ASM-1", "aws-ops"));
    const { p } = await openPanel();
    await settle();
    expect(h.writeFlow).not.toHaveBeenCalled();
    const msg = posts(p).findLast((m) => m.type === "deck:flows");
    expect(msg.pendingResume).toEqual([
      { flowId: "f1", flowName: "Ship the migration", lines: [expect.any(String)] },
    ]);
  });

  it("fires on the pass after approval", async () => {
    setConfig({ orchestrator: true });
    h.flows = [armedFlow()];
    h.buildRunStatus.mockReturnValue(mergedStatus("ASM-1", "aws-ops"));
    const { send } = await openPanel();
    await settle();
    await send({ type: "flow:resumeApprove", id: "f1" });
    await settle();
    expect((h.writeFlow.mock.calls.at(-1)![2] as Flow).edges[0].firedAt).toBeTypeOf("number");
  });

  it("disarms instead, if that is what you choose", async () => {
    setConfig({ orchestrator: true });
    h.flows = [armedFlow()];
    h.buildRunStatus.mockReturnValue(mergedStatus("ASM-1", "aws-ops"));
    const { send } = await openPanel();
    await settle();
    await send({ type: "flow:resumeDisarm", id: "f1" });
    expect((h.writeFlow.mock.calls.at(-1)![2] as Flow).armed).toBe(false);
    h.writeFlow.mockClear();
    await settle();
    // And nothing fires afterwards.
    expect(h.writeFlow).not.toHaveBeenCalled();
  });

  it("holds the gate across several passes until you answer", async () => {
    setConfig({ orchestrator: true });
    h.flows = [armedFlow()];
    h.buildRunStatus.mockReturnValue(mergedStatus("ASM-1", "aws-ops"));
    await openPanel();
    await settle();
    await settle();
    await settle();
    expect(h.writeFlow).not.toHaveBeenCalled();
  });

  it("does not gate a flow with nothing ready — there is nothing to approve", async () => {
    setConfig({ orchestrator: true });
    h.flows = [armedFlow()];
    h.buildRunStatus.mockReturnValue(openStatus("ASM-1", "aws-ops"));
    const { p } = await openPanel();
    await settle();
    expect(posts(p).findLast((m) => m.type === "deck:flows").pendingResume).toEqual([]);
  });

  it("fires without a gate once a rule becomes met later in the same session", async () => {
    // The gate protects the moment you come back, not every future firing.
    setConfig({ orchestrator: true });
    h.flows = [armedFlow()];
    h.buildRunStatus.mockReturnValue(openStatus("ASM-1", "aws-ops"));
    await openPanel();
    await settle();
    h.buildRunStatus.mockReturnValue(mergedStatus("ASM-1", "aws-ops"));
    await settle();
    expect((h.writeFlow.mock.calls.at(-1)![2] as Flow).edges[0].firedAt).toBeTypeOf("number");
  });

  it("ignores an approval for an id it is not holding", async () => {
    setConfig({ orchestrator: true });
    h.flows = [armedFlow()];
    h.buildRunStatus.mockReturnValue(mergedStatus("ASM-1", "aws-ops"));
    const { send } = await openPanel();
    await settle();
    await send({ type: "flow:resumeApprove", id: "nope" });
    await settle();
    expect(h.writeFlow).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: FAIL — the first pass fires, and `pendingResume` is not a field.

- [ ] **Step 3: Add the message shapes to `src/types.ts`**

Add above `InboundMessage`:

```ts
/** An armed flow with rules already met on the first evaluation after the panel
 * was created. Reported rather than acted on: a flow armed last week must not
 * spend anything the moment you reopen the Deck, before you have read what it is
 * about to do. */
export interface PendingResume {
  flowId: string;
  flowName: string;
  /** One line per rule about to fire, in the drawer's own words. */
  lines: string[];
}
```

Add to `InboundMessage`:

```ts
  | { type: "flow:resumeApprove"; id: string }
  | { type: "flow:resumeDisarm"; id: string }
```

And add the field to the `deck:flows` variant: `pendingResume: PendingResume[];`

- [ ] **Step 4: Implement the gate in `src/deckView.ts`**

Add two fields:

```ts
  /** Flow ids whose first post-start evaluation found rules already met, and which
   * are waiting for the user to approve or disarm. Per panel, deliberately not
   * persisted: the gate exists to protect the moment you come back, and asking on
   * every poll would defeat arming. */
  private readonly pendingResume = new Map<string, PendingResume>();
  /** Flow ids that have completed their first evaluation in this panel's life. */
  private readonly resumeCleared = new Set<string>();
```

Rewrite `advanceArmedFlows` to consult the gate:

```ts
  private advanceArmedFlows(runs: RunStatus[], nowMs: number): void {
    if (!getConfig().orchestrator) return;
    for (const flow of readFlows(this.flowIo, this.flowsDir)) {
      if (!flow.armed) {
        // A disarmed flow holds no gate — re-arming starts the cycle over.
        this.pendingResume.delete(flow.id);
        this.resumeCleared.delete(flow.id);
        continue;
      }
      try {
        const result = evaluateFlow({ flow, statuses: runs, nowMs });
        if (result.fired.length === 0) {
          // Nothing ready means nothing to approve: clear the gate so a rule that
          // becomes met later in this session fires without ceremony.
          this.pendingResume.delete(flow.id);
          this.resumeCleared.add(flow.id);
          continue;
        }
        if (!this.resumeCleared.has(flow.id)) {
          this.pendingResume.set(flow.id, {
            flowId: flow.id,
            flowName: flow.name,
            lines: notifyLines(flow, result.fired).length > 0
              ? notifyLines(flow, result.fired)
              : result.fired.filter((f) => f.perform).map((f) => `${flow.name}: a rule is ready.`),
          });
          continue;
        }
        writeFlow(this.flowIo, this.flowsDir, applyFired(flow, result.fired, nowMs));
        for (const line of notifyLines(flow, result.fired)) {
          this.post({ type: "toast", level: "info", message: line });
        }
      } catch (e) {
        this.log(`deck: flow ${flow.id} failed to advance: ${e}`);
      }
    }
  }
```

Include the gate in `postFlows`:

```ts
    this.post({ type: "deck:flows", flows, enabled, pendingResume: [...this.pendingResume.values()] });
```

Handle the two messages in `onMessage`:

```ts
      case "flow:resumeApprove": {
        if (!getConfig().orchestrator) return;
        if (!this.pendingResume.has(m.id)) return;
        this.pendingResume.delete(m.id);
        // Clearing the gate is all this does: the next poll fires normally.
        this.resumeCleared.add(m.id);
        void this.refreshBusy();
        return;
      }
      case "flow:resumeDisarm": {
        if (!getConfig().orchestrator) return;
        const flow = readFlows(this.flowIo, this.flowsDir).find((f) => f.id === m.id);
        if (!flow) return;
        this.pendingResume.delete(m.id);
        this.resumeCleared.add(m.id);
        writeFlow(this.flowIo, this.flowsDir, { ...flow, armed: false });
        this.postFlows();
        return;
      }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: PASS.

- [ ] **Step 6: All four gates, then commit**

Run: `npx tsc --noEmit`; `rm -rf dist && npm run build` (exit 0); `npx vitest run`; `npx vitest run --coverage`.

```bash
git add src/types.ts src/deckView.ts test/unit/deckView.test.ts
git commit -m "feat(orchestrator): hold the first pass after a restart for approval"
```

---

## Task 5: Arm, disarm, Reset, and the stale-latch merge

**Files:**
- Modify: `src/types.ts`
- Modify: `src/deckView.ts`
- Test: `test/unit/deckView.test.ts`

**Interfaces:**
- Consumes: `unfirableRules`, `SourceState` from `./engine/orchestrator/armability` (Task 2).
- Produces, for Task 6's drawer: `{ type: "flow:arm"; id: string; armed: boolean }` and `{ type: "flow:resetEdge"; id: string; edgeId: string }`.

Three things in one task because they are all one-handler-each on the same file and a reviewer would accept or reject them together.

**The stale-latch merge is the important one.** `flow:save` currently writes whatever the drawer sends. From this phase on the host stamps `firedAt`, `firedNote` and `error` onto the same file during its poll — so a drawer holding a `flow` prop from before a stamp would write those fields back out as absent, **clearing the latch and re-firing a rule that already ran**. In Phase 3 that means paying for a second agent session. The host must preserve its own per-edge fields on receipt.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/deckView.test.ts`:

```ts
describe("arm, disarm and reset", () => {
  it("flow:arm sets armed and reports nothing when both sources are on", async () => {
    setConfig({ orchestrator: true, liveSignal: true, prFacts: true });
    h.flows = [mkFlow("f1", "n")];
    const { p, send } = await openPanel();
    await send({ type: "flow:arm", id: "f1", armed: true });
    expect((h.writeFlow.mock.calls.at(-1)![2] as Flow).armed).toBe(true);
    expect(posts(p).some((m) => m.type === "toast" && /can never fire/i.test(m.message ?? ""))).toBe(false);
  });

  it("flow:arm names the rules that can never fire with a source off", async () => {
    setConfig({ orchestrator: true, prFacts: false });
    h.flows = [{
      ...mkFlow("f1", "n"),
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" }],
    }];
    const { p, send } = await openPanel();
    await send({ type: "flow:arm", id: "f1", armed: true });
    // Armed anyway — a flow with one dead rule is still worth arming.
    expect((h.writeFlow.mock.calls.at(-1)![2] as Flow).armed).toBe(true);
    const toast = posts(p).find((m) => m.type === "toast" && /PR facts/i.test(m.message ?? ""));
    expect(toast).toBeTruthy();
  });

  it("flow:arm with armed:false disarms", async () => {
    setConfig({ orchestrator: true });
    h.flows = [{ ...mkFlow("f1", "n"), armed: true }];
    const { send } = await openPanel();
    await send({ type: "flow:arm", id: "f1", armed: false });
    expect((h.writeFlow.mock.calls.at(-1)![2] as Flow).armed).toBe(false);
  });

  it("flow:arm ignores an unknown id", async () => {
    setConfig({ orchestrator: true });
    h.flows = [mkFlow("f1", "n")];
    const { send } = await openPanel();
    await send({ type: "flow:arm", id: "nope", armed: true });
    expect(h.writeFlow).not.toHaveBeenCalled();
  });

  it("flow:resetEdge clears firedAt, firedNote and error for one edge only", async () => {
    setConfig({ orchestrator: true });
    h.flows = [{
      ...mkFlow("f1", "n"),
      edges: [
        { id: "e1", from: "a", to: "z", cond: { kind: "pr-merged" }, action: "notify", firedAt: 5, firedNote: "told you", error: "boom" },
        { id: "e2", from: "a", to: "y", cond: { kind: "pr-merged" }, action: "notify", firedAt: 7 },
      ],
    }];
    const { send } = await openPanel();
    await send({ type: "flow:resetEdge", id: "f1", edgeId: "e1" });
    const w = h.writeFlow.mock.calls.at(-1)![2] as Flow;
    expect(w.edges[0].firedAt).toBeUndefined();
    expect(w.edges[0].firedNote).toBeUndefined();
    expect(w.edges[0].error).toBeUndefined();
    expect(w.edges[1].firedAt).toBe(7);
  });

  it("flow:save preserves the host's own firedAt when the drawer's copy is stale", async () => {
    // The hazard: the host stamped e1 during a poll; the drawer still holds the
    // pre-stamp flow and saves a node move. Writing its copy verbatim would clear
    // the latch and re-fire a rule that already ran.
    setConfig({ orchestrator: true });
    h.flows = [{
      ...mkFlow("f1", "n"),
      edges: [{ id: "e1", from: "a", to: "z", cond: { kind: "pr-merged" }, action: "notify", firedAt: 5, firedNote: "told you" }],
    }];
    const stale: Flow = {
      ...mkFlow("f1", "n"),
      nodes: [{ id: "n1", kind: "place", x: 99, y: 99, join: "any", runKey: "ASM-1", repo: "r" }],
      edges: [{ id: "e1", from: "a", to: "z", cond: { kind: "pr-merged" }, action: "notify" }],
    };
    const { send } = await openPanel();
    await send({ type: "flow:save", flow: stale });
    const w = h.writeFlow.mock.calls.at(-1)![2] as Flow;
    expect(w.edges[0].firedAt).toBe(5);
    expect(w.edges[0].firedNote).toBe("told you");
    // The drawer's actual edit still lands.
    expect(w.nodes[0].x).toBe(99);
  });

  it("flow:save keeps an error the host recorded", async () => {
    setConfig({ orchestrator: true });
    h.flows = [{
      ...mkFlow("f1", "n"),
      edges: [{ id: "e1", from: "a", to: "z", cond: { kind: "pr-merged" }, action: "notify", error: "worktree exists" }],
    }];
    const stale: Flow = {
      ...mkFlow("f1", "n"),
      edges: [{ id: "e1", from: "a", to: "z", cond: { kind: "pr-merged" }, action: "notify" }],
    };
    const { send } = await openPanel();
    await send({ type: "flow:save", flow: stale });
    expect((h.writeFlow.mock.calls.at(-1)![2] as Flow).edges[0].error).toBe("worktree exists");
  });

  it("flow:save does not resurrect host fields for an edge the drawer deleted", async () => {
    setConfig({ orchestrator: true });
    h.flows = [{
      ...mkFlow("f1", "n"),
      edges: [{ id: "e1", from: "a", to: "z", cond: { kind: "pr-merged" }, action: "notify", firedAt: 5 }],
    }];
    const { send } = await openPanel();
    await send({ type: "flow:save", flow: { ...mkFlow("f1", "n"), edges: [] } });
    expect((h.writeFlow.mock.calls.at(-1)![2] as Flow).edges).toEqual([]);
  });

  it("flow:save lets the drawer's condition edit win over the host's copy", async () => {
    // Only the three host-owned fields are preserved. Everything else is the
    // drawer's to change.
    setConfig({ orchestrator: true });
    h.flows = [{
      ...mkFlow("f1", "n"),
      edges: [{ id: "e1", from: "a", to: "z", cond: { kind: "pr-merged" }, action: "notify", firedAt: 5 }],
    }];
    const edited: Flow = {
      ...mkFlow("f1", "n"),
      edges: [{ id: "e1", from: "a", to: "z", cond: { kind: "ci-failed" }, action: "notify" }],
    };
    const { send } = await openPanel();
    await send({ type: "flow:save", flow: edited });
    const w = h.writeFlow.mock.calls.at(-1)![2] as Flow;
    expect(w.edges[0].cond).toEqual({ kind: "ci-failed" });
    expect(w.edges[0].firedAt).toBe(5);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: FAIL — `flow:arm` is not a known message, and `flow:save` overwrites the latch.

- [ ] **Step 3: Add the message shapes**

In `src/types.ts`, add to `InboundMessage`:

```ts
  | { type: "flow:arm"; id: string; armed: boolean }
  | { type: "flow:resetEdge"; id: string; edgeId: string }
```

- [ ] **Step 4: Implement the three handlers**

Add the import to `src/deckView.ts`:

```ts
import { unfirableRules } from "./engine/orchestrator/armability";
```

Add the handlers in `onMessage`:

```ts
      case "flow:arm": {
        if (!getConfig().orchestrator) return;
        const flow = readFlows(this.flowIo, this.flowsDir).find((f) => f.id === m.id);
        if (!flow) return;
        writeFlow(this.flowIo, this.flowsDir, { ...flow, armed: m.armed });
        if (m.armed) {
          // Warn and name, rather than refuse: a flow with one dead rule and three
          // live ones is still worth arming, and silence is how a user ends up
          // waiting forever on something that can never happen.
          const dead = unfirableRules(flow, { liveSignal: this.liveSignal, prFacts: this.prFacts });
          if (dead.length > 0) {
            const live = dead.filter((d) => d.needs === "live-signal").length;
            const pr = dead.filter((d) => d.needs === "pr-facts").length;
            const parts: string[] = [];
            if (pr > 0) parts.push(`${pr} need${pr === 1 ? "s" : ""} PR facts`);
            if (live > 0) parts.push(`${live} need${live === 1 ? "s" : ""} the Live signal`);
            this.post({
              type: "toast",
              level: "info",
              message: `${flow.name} armed — but ${parts.join(" and ")}, which ${
                parts.length > 1 ? "are" : "is"
              } off, so ${dead.length === 1 ? "that rule" : "those rules"} can never fire.`,
            });
          }
        } else {
          this.pendingResume.delete(m.id);
          this.resumeCleared.delete(m.id);
        }
        this.postFlows();
        return;
      }
      case "flow:resetEdge": {
        if (!getConfig().orchestrator) return;
        const flow = readFlows(this.flowIo, this.flowsDir).find((f) => f.id === m.id);
        if (!flow) return;
        writeFlow(this.flowIo, this.flowsDir, {
          ...flow,
          edges: flow.edges.map((e) =>
            e.id === m.edgeId ? { id: e.id, from: e.from, to: e.to, cond: e.cond, action: e.action, mode: e.mode } : e,
          ),
        });
        this.postFlows();
        return;
      }
```

Note the Reset handler rebuilds the edge from its non-host fields rather than deleting three keys, so a future host-owned field cannot be forgotten here.

Now change the existing `flow:save` handler to merge. Replace its `writeFlow(...)` call with:

```ts
        // Preserve the fields the HOST owns. From this phase on the host stamps
        // firedAt/firedNote/error during its poll, and the drawer may be holding a
        // flow from before that stamp — writing its copy verbatim would clear the
        // latch and re-fire a rule that already ran.
        const mine = new Map(existing.edges.map((e) => [e.id, e]));
        writeFlow(this.flowIo, this.flowsDir, {
          ...m.flow,
          edges: m.flow.edges.map((e) => {
            const host = mine.get(e.id);
            if (!host) return e;
            return { ...e, firedAt: host.firedAt, firedNote: host.firedNote, error: host.error };
          }),
        });
```

The existing handler already reads the store to check membership; name that value `existing` (it currently uses `known` as a boolean — change it to hold the flow itself, and keep the refusal when it is absent).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: PASS.

- [ ] **Step 6: All four gates, then commit**

```bash
git add src/types.ts src/deckView.ts test/unit/deckView.test.ts
git commit -m "feat(orchestrator): arm, disarm, reset a rule, and stop a stale save clearing a latch"
```

---

## Task 6: The drawer earns its primary — Arm, the armed footer, the resume banner, Reset

**Files:**
- Modify: `src/webview/OrchestratorDrawer.tsx`
- Modify: `src/webview/orchestratorStyles.ts`
- Modify: `src/webview/DeckApp.tsx`
- Test: `test/webview/OrchestratorDrawer.test.tsx`, `test/webview/DeckApp.test.tsx`

**Interfaces:**
- Consumes: `PendingResume` from `../types`; the messages from Tasks 4 and 5.
- Produces: `OrchestratorDrawerProps` gains `pendingResume: PendingResume[]`, `onArm(id, armed)`, `onResumeApprove(id)`, `onResumeDisarm(id)`, `onResetEdge(id, edgeId)`.

This is the phase where the drawer's **one filled control** appears. Arm is it — nothing else in the drawer may be filled. The mockup at `/Users/oznasi/dev/agent-flow/docs/mockups/2026-08-05-deck-orchestrator-drawer.html` (`?v=canvas`) shows the filled Arm and the `Armed · disarm` state it becomes; match it.

Also delete the footer's `arming arrives in the next phase` line — it described a temporary state that no longer exists, and leaving it would be a persistent lie.

- [ ] **Step 1: Write the failing tests**

Add to `test/webview/OrchestratorDrawer.test.tsx` (extend the existing `props()` helper with the four new callbacks and `pendingResume: []`):

```tsx
describe("arming", () => {
  it("offers Arm for a disarmed flow", () => {
    const onArm = vi.fn();
    render(<OrchestratorDrawer {...props({ onArm })} />);
    fireEvent.click(screen.getByRole("button", { name: "Arm" }));
    expect(onArm).toHaveBeenCalledWith("f1", true);
  });

  it("offers disarm for an armed flow, and says it is armed", () => {
    const onArm = vi.fn();
    render(<OrchestratorDrawer {...props({ onArm, flows: [flow({ armed: true })] })} />);
    expect(screen.getByText(/armed/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /disarm/i }));
    expect(onArm).toHaveBeenCalledWith("f1", false);
  });

  it("no longer claims arming is coming in a later phase", () => {
    render(<OrchestratorDrawer {...props()} />);
    expect(screen.queryByText(/next phase/i)).toBeNull();
  });

  it("Arm is the drawer's only filled control", () => {
    const { container } = render(<OrchestratorDrawer {...props()} />);
    const filled = container.querySelectorAll(".orch-arm");
    expect(filled).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Arm" }).className).toContain("orch-arm");
  });
});

describe("the resume banner", () => {
  const pending = [{ flowId: "f1", flowName: "Ship the migration", lines: ["Ship the migration: the migration has landed"] }];

  it("shows what is ready, and does not act on its own", () => {
    render(<OrchestratorDrawer {...props({ pendingResume: pending, flows: [flow({ armed: true })] })} />);
    const banner = screen.getByTestId("orch-resume");
    expect(banner.textContent).toContain("the migration has landed");
  });

  it("approves", () => {
    const onResumeApprove = vi.fn();
    render(<OrchestratorDrawer {...props({ pendingResume: pending, flows: [flow({ armed: true })], onResumeApprove })} />);
    fireEvent.click(screen.getByRole("button", { name: /^go$/i }));
    expect(onResumeApprove).toHaveBeenCalledWith("f1");
  });

  it("disarms instead", () => {
    const onResumeDisarm = vi.fn();
    render(<OrchestratorDrawer {...props({ pendingResume: pending, flows: [flow({ armed: true })], onResumeDisarm })} />);
    fireEvent.click(screen.getByRole("button", { name: /disarm/i }));
    expect(onResumeDisarm).toHaveBeenCalledWith("f1");
  });

  it("shows no banner when nothing is pending", () => {
    render(<OrchestratorDrawer {...props({ pendingResume: [] })} />);
    expect(screen.queryByTestId("orch-resume")).toBeNull();
  });

  it("shows no banner for a different flow's pending resume", () => {
    render(<OrchestratorDrawer {...props({ pendingResume: [{ ...pending[0], flowId: "other" }] })} />);
    expect(screen.queryByTestId("orch-resume")).toBeNull();
  });
});

describe("Reset", () => {
  const firedFlow = () => flow({
    nodes: [
      { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "ASM-1", repo: "agent-flow" },
      { id: "n2", kind: "notify", x: 320, y: 24, join: "any", message: "landed" },
    ],
    edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify", firedAt: 5, firedNote: "told you: landed" }],
  });

  it("shows a fired rule's receipt in the inspector", () => {
    render(<OrchestratorDrawer {...props({ flows: [firedFlow()] })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    expect(screen.getByTestId("orch-inspector").textContent).toContain("told you: landed");
  });

  it("resets it", () => {
    const onResetEdge = vi.fn();
    render(<OrchestratorDrawer {...props({ flows: [firedFlow()], onResetEdge })} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    fireEvent.click(screen.getByRole("button", { name: /reset/i }));
    expect(onResetEdge).toHaveBeenCalledWith("f1", "e1");
  });

  it("offers no Reset for a rule that has not fired", () => {
    render(<OrchestratorDrawer {...props()} />);
    fireEvent.click(screen.getByTestId("orch-edge-e1"));
    expect(screen.queryByRole("button", { name: /reset/i })).toBeNull();
  });
});
```

That last test needs the default `props()` flow to have an unfired edge `e1`; if the existing `wired()` fixture provides that, use it instead of `flow()`.

Add to `test/webview/DeckApp.test.tsx`. Phase 2a added tests there that post `deck:flows` and assert on the mocked `send`; reuse those helpers rather than adding new ones. The point of these three is the exact `type` string — a typo is the failure mode, and nothing else would catch it:

```tsx
it("passes an arm through as flow:arm", () => {
  postFlows({ enabled: true, flows: [oneFlow()] });   // this file's existing helper
  openDrawer();                                       // press the chip
  fireEvent.click(screen.getByRole("button", { name: "Arm" }));
  expect(send).toHaveBeenCalledWith({ type: "flow:arm", id: "f1", armed: true });
});

it("passes a resume approval through as flow:resumeApprove", () => {
  postFlows({
    enabled: true,
    flows: [{ ...oneFlow(), armed: true }],
    pendingResume: [{ flowId: "f1", flowName: "Ship the migration", lines: ["ready"] }],
  });
  openDrawer();
  fireEvent.click(screen.getByRole("button", { name: /^go$/i }));
  expect(send).toHaveBeenCalledWith({ type: "flow:resumeApprove", id: "f1" });
});

it("passes a reset through as flow:resetEdge", () => {
  postFlows({ enabled: true, flows: [firedFlow()] }); // a flow whose e1 has firedAt
  openDrawer();
  fireEvent.click(screen.getByTestId("orch-edge-e1"));
  fireEvent.click(screen.getByRole("button", { name: /reset/i }));
  expect(send).toHaveBeenCalledWith({ type: "flow:resetEdge", id: "f1", edgeId: "e1" });
});
```

`postFlows`, `openDrawer`, `oneFlow` and `send` stand for whatever that file actually calls them — read its Phase 2a `deck:flows` tests first and use those names. `firedFlow()` is a flow whose single edge `e1` carries `firedAt`; add it beside `oneFlow`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/webview/OrchestratorDrawer.test.tsx test/webview/DeckApp.test.tsx`
Expected: FAIL — no Arm control, no resume banner.

- [ ] **Step 3: Add the styles**

Append to `ORCH_CSS`. **The Arm button is the one place in this drawer that spends `--brand` as a fill** — add `.orch-arm` to `test/webview/tokens.test.ts`'s brand-selector allowlist, and confirm the usage is real by removing it and watching that test fail.

```css
  /* The drawer's ONE filled control, and the phase that earns it: Arm is the
     consent point for everything a flow does. Nothing else here may be filled. */
  .orch-arm { height: 26px; padding: 0 13px; border-radius: var(--r-ctl);
    border: 1px solid var(--brand); background: var(--brand); color: var(--brand-ink);
    font-size: var(--t-body); font-weight: 600; cursor: pointer; }
  .orch-arm:hover { filter: brightness(1.08); }
  /* Armed is a state, not an invitation: the fill goes away and the control
     becomes the quiet way back out. */
  .orch-arm.on { background: transparent; color: var(--vscode-foreground);
    border-color: color-mix(in srgb, var(--brand) 50%, var(--edge)); font-weight: 500; }

  .orch-ft .live { display: inline-flex; align-items: center; gap: 6px; }
  .orch-ft .live .d { width: 6px; height: 6px; border-radius: 50%; background: var(--dim); }
  .orch-ft .live.on .d { background: var(--brand); }

  /* The resume gate. Not red — nothing failed; a flow is waiting to be told to go. */
  .orch-resume { flex: none; margin-bottom: 12px; padding: 10px 12px;
    border: 1px solid color-mix(in srgb, var(--c-attn) 34%, var(--hair));
    border-left: 2px solid var(--c-attn); border-radius: var(--r-card);
    background: color-mix(in srgb, var(--c-attn) 5%, transparent); }
  .orch-resume .t { font-size: var(--t-body); font-weight: 600; margin-bottom: 5px; }
  .orch-resume ul { margin: 0 0 8px; padding-left: 18px; font-size: var(--t-micro); color: var(--dim); }
  .orch-resume .row { display: flex; gap: 6px; }
```

- [ ] **Step 4: Implement in the drawer**

Add the four callbacks and `pendingResume` to `OrchestratorDrawerProps`. Inside the component:

```tsx
  const resume = p.pendingResume.find((r) => r.flowId === flow.id) ?? null;
```

Add the Arm control to the header row that currently holds the counts:

```tsx
        <button
          type="button"
          className={`orch-arm${flow.armed ? " on" : ""}`}
          onClick={() => p.onArm(flow.id, !flow.armed)}
        >
          {flow.armed ? "Armed · disarm" : "Arm"}
        </button>
```

Add the banner as the first child of `.orch-body`:

```tsx
        {resume && (
          <div className="orch-resume" data-testid="orch-resume">
            <div className="t">
              {resume.lines.length === 1 ? "1 rule is ready" : `${resume.lines.length} rules are ready`}
            </div>
            <ul>{resume.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
            <div className="row">
              <button type="button" className="orch-mini" onClick={() => p.onResumeApprove(flow.id)}>Go</button>
              <button type="button" className="orch-mini" onClick={() => p.onResumeDisarm(flow.id)}>Disarm</button>
            </div>
          </div>
        )}
```

Replace the footer's two spans with:

```tsx
        <span className={`live${flow.armed ? " on" : ""}`}>
          <span className="d" />
          {flow.armed ? `Armed · watching ${places} ${places === 1 ? "node" : "nodes"}` : "Not armed"}
        </span>
        <div className="sp" />
        <span>
          {places} {places === 1 ? "node" : "nodes"} · {flow.edges.length}{" "}
          {flow.edges.length === 1 ? "rule" : "rules"}
        </span>
```

In the inspector, when the selected edge has `firedAt`, show `firedNote` and a Reset button instead of the waiting line:

```tsx
              {edge.firedAt !== undefined ? (
                <>
                  <span className="fired">{edge.firedNote ?? "fired"}</span>
                  <div className="sp" />
                  <button type="button" className="orch-mini" onClick={() => p.onResetEdge(flow.id, edge.id)}>Reset</button>
                </>
              ) : (
                <span>{observation(edge) ?? "this card is not on the board right now"}</span>
              )}
```

- [ ] **Step 5: Wire `DeckApp.tsx`**

Add `pendingResume` to the `deck:flows` handler's state, and pass the four callbacks:

```tsx
          onArm={(id, armed) => send({ type: "flow:arm", id, armed })}
          onResumeApprove={(id) => send({ type: "flow:resumeApprove", id })}
          onResumeDisarm={(id) => send({ type: "flow:resumeDisarm", id })}
          onResetEdge={(id, edgeId) => send({ type: "flow:resetEdge", id, edgeId })}
```

- [ ] **Step 6: Run the tests, then all four gates, then commit**

```bash
git add src/webview/OrchestratorDrawer.tsx src/webview/orchestratorStyles.ts src/webview/DeckApp.tsx test/webview/OrchestratorDrawer.test.tsx test/webview/DeckApp.test.tsx test/webview/tokens.test.ts
git commit -m "feat(orchestrator): add Arm, the armed footer, the resume banner and Reset"
```

---

## Task 7: Keep polling while armed, confirm on close, and clear the two carried defects

**Files:**
- Modify: `src/deckView.ts`
- Modify: `src/webview/OrchestratorDrawer.tsx`
- Modify: `src/webview/DeckApp.tsx`
- Modify: `README.md`
- Test: `test/unit/deckView.test.ts`, `test/webview/OrchestratorDrawer.test.tsx`, `test/webview/DeckApp.test.tsx`

**Interfaces:** none produced; this is the last task.

Four things, all of which the spec or the ledger already names as this phase's work.

**(a) The poll must survive the panel being hidden while a flow is armed.** `DeckPanel` currently stops polling on `onDidChangeViewState` when `this.panel.visible` is false. An armed flow that only advances while you are looking at the board is not armed.

**(b) Closing the panel with a flow armed must ask first**, because closing genuinely does stop evaluation — the panel owns the poll.

**(c) The drawer must stop auto-opening.** It currently opens on the first `deck:flows` post that carries any flow, because the previous list is `[]` so every flow reads as "fresh". Seed the seen-set from the first post.

**(d) A `pointerup` must not save a one-event-stale node position.** `pointermove` is InputContinuous priority and `pointerup` is Discrete, so a release arriving before React flushes the final move saves the previous position. Keep the live position in a ref and read that in the release handler.

- [ ] **Step 1: Write the failing tests**

For (a) and (b), add to `test/unit/deckView.test.ts`:

```ts
describe("the poll and the close confirmation", () => {
  const armed = (): Flow => ({ ...mkFlow("f1", "Ship the migration"), armed: true });

  it("keeps polling when the panel is hidden and a flow is armed", async () => {
    setConfig({ orchestrator: true });
    h.flows = [armed()];
    const { p } = await openPanel();
    const before = h.buildRunStatus.mock.calls.length;
    hide(p);                    // drive onDidChangeViewState with visible: false
    await advanceTimers(POLL_MS + 1);
    expect(h.buildRunStatus.mock.calls.length).toBeGreaterThan(before);
  });

  it("stops polling when hidden with nothing armed", async () => {
    setConfig({ orchestrator: true });
    h.flows = [mkFlow("f1", "n")];
    const { p } = await openPanel();
    const before = h.buildRunStatus.mock.calls.length;
    hide(p);
    await advanceTimers(POLL_MS + 1);
    expect(h.buildRunStatus.mock.calls.length).toBe(before);
  });

  it("asks before closing with a flow armed", async () => {
    setConfig({ orchestrator: true });
    h.flows = [armed()];
    const { p } = await openPanel();
    await close(p);             // drive onDidDispose
    expect(window.showWarningMessage).toHaveBeenCalled();
  });

  it("does not ask when nothing is armed", async () => {
    setConfig({ orchestrator: true });
    h.flows = [mkFlow("f1", "n")];
    const { p } = await openPanel();
    await close(p);
    expect(window.showWarningMessage).not.toHaveBeenCalled();
  });
});
```

`hide(p)`, `close(p)` and `advanceTimers(ms)` must follow whatever this file already does to drive `onDidChangeViewState`, `onDidDispose` and the poll timer — it already tests polling behaviour, so those mechanisms exist. Use them; do not add fake timers if the file drives the timer another way.

**`POLL_MS` is a module-level `const` in `deckView.ts` and is NOT exported**, so a test cannot import it. Use the literal the file already uses in its own polling tests, or export the constant if that is what the file already does for other values — do not add a second source of truth for the interval.

For (c), add to `test/webview/DeckApp.test.tsx`, using the same helpers as Task 6:

```tsx
it("does not open the drawer by itself when a saved flow arrives", () => {
  // The bug: on the first post the previous list is [], so every saved flow reads
  // as "fresh" and pops the drawer open for anyone who has one.
  postFlows({ enabled: true, flows: [oneFlow()] });
  expect(screen.queryByLabelText("Orchestrator")).toBeNull();
});

it("still opens the drawer for a flow that was just created", () => {
  // The behaviour the auto-open exists for: press the chip with none, and the
  // flow the host creates in response opens.
  postFlows({ enabled: true, flows: [] });
  fireEvent.click(screen.getByRole("button", { name: /orchestrator/i }));
  expect(send).toHaveBeenCalledWith({ type: "flow:create" });
  postFlows({ enabled: true, flows: [oneFlow()] });
  expect(screen.getByLabelText("Orchestrator")).toBeTruthy();
});
```

`aria-label="Orchestrator"` is the drawer's own label from Phase 2a — confirm it is still that before relying on it.

For (d), add to `test/webview/OrchestratorDrawer.test.tsx`:

```tsx
it("saves the final drag position even when the release arrives before the last move flushes", () => {
  const onSave = vi.fn();
  render(<OrchestratorDrawer {...props({ flows: [twoPlaces()] })} onSave={onSave} />);
  const n1 = screen.getByTestId("orch-node-n1");
  fireEvent.pointerDown(n1, { clientX: 100, clientY: 100 });
  // Two moves, then an immediate release: the saved position must be the LAST
  // move's, not the previous one's.
  fireEvent.pointerMove(window, { clientX: 140, clientY: 100 });
  fireEvent.pointerMove(window, { clientX: 180, clientY: 100 });
  fireEvent.pointerUp(window);
  const saved = onSave.mock.calls.at(-1)![0] as Flow;
  expect(saved.nodes.find((n) => n.id === "n1")!.x).toBe(104);
});
```

Confirm `104` against your implementation (24 + 80, snapped) before trusting it; derive it rather than pasting mine.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/unit/deckView.test.ts test/webview/DeckApp.test.tsx test/webview/OrchestratorDrawer.test.tsx`

- [ ] **Step 3: Implement (a) and (b) in `src/deckView.ts`**

```ts
  /** Is any flow armed right now? Read from the store rather than cached: arming
   * is a disk write, and this is asked only on a visibility change or a close. */
  private hasArmedFlow(): boolean {
    if (!getConfig().orchestrator) return false;
    try {
      return readFlows(this.flowIo, this.flowsDir).some((f) => f.armed);
    } catch {
      return false;
    }
  }
```

Change the visibility handler so a hidden panel keeps polling while something is armed:

```ts
    this.panel.onDidChangeViewState(
      () => {
        // An armed flow that only advances while you are looking at the board is
        // not armed. Closing the panel does stop it — that is what the close
        // confirmation is for.
        if (this.panel.visible || this.hasArmedFlow()) this.startPolling();
        else this.stopPolling();
      },
```

Now the close notice. **The spec asked for a dialog before closing, with Disarm / Keep it open / Close anyway. That is not implementable and the spec has been corrected.** VS Code exposes no cancellable close for a webview panel: `onDidDispose` fires *after* disposal and there is no `onWillDispose`, so a close cannot be intercepted or vetoed. Do not try to build the three-option dialog; do not add a wrapper command that "closes" the panel so a dialog can gate it, because the user closes it with the editor tab's × and the keyboard, not through a command.

What is implementable, and what to build: on dispose, if anything was armed, say so plainly and offer to reopen. The flow stays armed on disk deliberately — the intent is preserved, and the resume gate from Task 4 is what makes coming back safe.

```ts
    this.panel.onDidDispose(() => {
      const wasArmed = this.hasArmedFlow();
      this.dispose();
      if (!wasArmed) return;
      const reopen = "Reopen the Deck";
      void vscode.window
        .showWarningMessage(
          "A flow is armed, and closing the Deck stops it advancing.",
          reopen,
          "Leave it closed",
        )
        .then((answer) => {
          if (answer === reopen) void vscode.commands.executeCommand("agentFlow.openDeck");
        });
    }, null, this.disposables);
```

Check the real command id for opening the Deck in `package.json`'s `contributes.commands` and use it verbatim. If the existing `onDidDispose` registration differs from this shape, adapt rather than duplicating it.

- [ ] **Step 4: Implement (c) in `DeckApp.tsx`**

The `deck:flows` handler currently treats any flow absent from the previous list as fresh, and on the first post the previous list is `[]`. Track whether a post has been seen:

```tsx
  /** True once a `deck:flows` post has landed. Before that, every flow looks
   * "fresh" against an empty previous list, which would pop the drawer open for
   * anyone with a saved flow. */
  const seenFlowsRef = React.useRef(false);
```

and in the handler, only auto-open when `seenFlowsRef.current` is already true; set it to true at the end. Keep the auto-close behaviour for a flow that vanished.

- [ ] **Step 5: Implement (d) in the drawer**

Hold the in-flight drag position in a ref alongside the state, write it on every move, and read the ref in the release handler:

```tsx
  const dragRef = React.useRef<{ id: string; x: number; y: number } | null>(null);
```

Set it in the same place `setDrag` is updated on a move, clear it on release, and have the release handler compare and save from `dragRef.current` rather than from the state value it closed over.

- [ ] **Step 6: Update the README**

The Deck's Orchestrator paragraph currently ends by saying nothing runs on its own yet. Replace that sentence — it is now false. Say what is true: an armed flow is checked on every refresh, a met rule fires once and tells you, the flow keeps advancing while the Deck is hidden, closing the Deck stops it, and coming back after a restart shows you what is ready before anything happens. Also state plainly that the only thing a rule can do in this build is notify you — launching the next agent comes later.

- [ ] **Step 7: All four gates, then commit**

```bash
git add src/deckView.ts src/webview/OrchestratorDrawer.tsx src/webview/DeckApp.tsx README.md test/unit/deckView.test.ts test/webview/OrchestratorDrawer.test.tsx test/webview/DeckApp.test.tsx
git commit -m "feat(orchestrator): keep advancing while hidden, warn on close, and clear two carried defects"
```

---

## Done when

- Arming a flow makes it advance on every Deck refresh; a met rule fires exactly once, stamps a receipt, and posts a toast naming the flow.
- Arming a flow whose rules depend on a switched-off source arms it anyway and names those rules.
- Reopening the Deck with an armed flow whose rules are already met **shows what is ready and waits**; Go fires on the next pass, Disarm turns it off.
- A fired rule shows its receipt in the inspector and can be Reset.
- A stale save from the drawer cannot clear a latch the host stamped.
- The panel keeps polling while hidden if anything is armed, and closing it with something armed says so.
- The drawer never opens by itself, and a drag saves the position you released at.
- `launch` and `seed` are still unreachable: nothing in this phase opens a window or starts a session.
- All four gates green: `npm run build` exit 0, `npx tsc --noEmit` clean, `npx vitest run` green, every touched file ≥95% lines.

## What Phase 3 picks up

`launch` and `seed` — the two acting verbs, the planned→place rewrite so chains advance, the 3-launch-per-pass cap, and the toasts that name what was opened. The seam is `evaluateFlow`'s `EvalResult`, which already distinguishes `perform` from stamp-only and already caps acting edges. Two things this phase leaves for it: an errored edge stamps `error` and is never retried, so the drawer must surface `flow.edges.some(e => e.error)` as a stalled flow; and the resume gate becomes materially more important once approval means spending money rather than showing a toast.
