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

  // `finishWire` in OrchestratorDrawer.tsx creates every new wire as `notify`
  // regardless of its target's kind, so "a settled notify rule pointing at a
  // place" is an ordinary leftover shape, not a corrupted one. If `writeFlow`
  // derived over a stored value that disagrees with its target, the file
  // would say the target's action instead — and the NEXT read would see
  // stored and derived agree, latching nothing. `latchActionMismatches` can
  // only ever catch a disagreement that `writeFlow` let survive.
  it("preserves a stored action that disagrees with its target, rather than overwriting it", () => {
    const io = fakeIo();
    const flow = JSON.parse(LEGACY) as Flow;
    // n1 is a `place`; a `notify` edge pointing at it disagrees with the
    // `seed` its target implies. Settled, so `latchActionMismatches` itself
    // would not touch it either — this is purely about what `writeFlow` does
    // to the stored value.
    flow.edges = [{ id: "e9", from: "n2", to: "n1", cond: { kind: "ci-passed" }, action: "notify", firedAt: 5 }];
    writeFlow(io, "/flows", flow);
    const written = JSON.parse(io.files["/flows/fmsm1way7-7bbm.json"]);
    expect(written.edges[0].action).toBe("notify");
  });
});

describe("Reset accepts the new reading", () => {
  // `latchActionMismatches` tells the user "Reset the rule to accept that". This
  // is the store half of making that true. `deckView.ts`'s `flow:resetEdge`
  // rebuilds the edge from its non-host fields and deliberately does NOT carry
  // `action` over; the shape below is exactly what it hands `writeFlow`.
  //
  // The bug this pins: while the reset carried the stored `action` through, the
  // disagreeing value survived the write, the next read compared it against the
  // derived one again, and stamped the identical error. Reset, re-read, latched,
  // forever — and since `finishWire` creates EVERY new wire as `notify`, wiring a
  // place to planned work produced a rule that could never fire and could never
  // be repaired.
  const resetEdge = (flow: Flow, edgeId: string): Flow => ({
    ...flow,
    edges: flow.edges.map((e) =>
      e.id === edgeId ? { id: e.id, from: e.from, to: e.to, cond: e.cond, mode: e.mode } : e),
  });

  /** A `notify` edge pointing at planned work — the ordinary leftover shape,
   * since `finishWire` wires everything as `notify` whatever it points at. */
  const mismatched = (): string => {
    const doc = JSON.parse(LEGACY);
    doc.edges = [{ id: "e9", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" }];
    return JSON.stringify(doc);
  };

  it("reads back clean after a reset, instead of re-latching the same error", () => {
    const io = fakeIo({ "/flows/fmsm1way7-7bbm.json": mismatched() });
    // Latched on the way in — without this the test could pass on a flow that
    // never disagreed with its target in the first place.
    const latched = readFlows(io, "/flows")[0];
    expect(latched.edges[0].error).toContain(ACTION_MISMATCH_PREFIX);

    writeFlow(io, "/flows", resetEdge(latched, "e9"));

    const after = readFlows(io, "/flows")[0].edges[0];
    expect(after.error).toBeUndefined();
    // And the rule is live again — not settled by a stamp of any kind.
    expect(after.firedAt).toBeUndefined();
    // It is now the verb its target implies, which is what accepting the new
    // reading means: n2 is planned work, so this is a launch.
    expect(after.action).toBe("launch");
  });

  it("still lands on disk with an action, so an older build does not drop the edge", () => {
    // The reset hands `writeFlow` an edge with NO action at all. `writeFlow`'s
    // `e.action ?? derived` is what has to fill it — an OLDER build's `validEdge`
    // requires the field and drops any edge lacking it, so a reset that left it
    // absent would lose the rule on a downgrade or a rollback.
    const io = fakeIo({ "/flows/fmsm1way7-7bbm.json": mismatched() });
    writeFlow(io, "/flows", resetEdge(readFlows(io, "/flows")[0], "e9"));
    const onDisk = JSON.parse(io.files["/flows/fmsm1way7-7bbm.json"]);
    expect(onDisk.edges[0].action).toBe("launch");
  });

  it("does not re-derive over an edge the user did NOT reset", () => {
    // The escape hatch stays shut for everything else: only the reset edge loses
    // its stored action, so a mismatch on a sibling is still latched and still
    // needs its own Reset. Deriving over every edge here is the migration that
    // spends money on a guess.
    const doc = JSON.parse(LEGACY);
    doc.edges = [
      { id: "e9", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" },
      { id: "e8", from: "n2", to: "n1", cond: { kind: "ci-passed" }, action: "notify" },
    ];
    const io = fakeIo({ "/flows/fmsm1way7-7bbm.json": JSON.stringify(doc) });
    writeFlow(io, "/flows", resetEdge(readFlows(io, "/flows")[0], "e9"));
    const after = readFlows(io, "/flows")[0].edges;
    expect(after.find((e) => e.id === "e9")!.error).toBeUndefined();
    // e8 is a `notify` pointing at a `place`, which means `seed` — still latched,
    // and still NOT silently turned into a paid session.
    expect(after.find((e) => e.id === "e8")!.error).toContain(ACTION_MISMATCH_PREFIX);
    expect(after.find((e) => e.id === "e8")!.action).toBe("notify");
  });
});
