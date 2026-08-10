import { describe, it, expect } from "vitest";
import { readFlows, writeFlow } from "../../../../src/engine/orchestrator/store";
import { ACTION_MISMATCH_PREFIX } from "../../../../src/engine/orchestrator/model";
import { promoteToPlace } from "../../../../src/engine/orchestrator/promote";
import type { Flow } from "../../../../src/engine/orchestrator/model";
import type { FlowIo } from "../../../../src/engine/orchestrator/store";

/** A fixed clock for the stamps promotion writes — the pass's own `nowMs` in
 * production (see `promoteToPlace`). */
const NOW = 1_800_000_000_000;

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

// The exact scenario Task 9's review MEASURED as the list view's blocker 1, at
// the layer that does the stamping. It is guaranteed by composition today
// (`actionFor("command") === "run"`, plus `writeFlow`'s generic `e.action ??
// derived` mirror), and both halves are pinned elsewhere — but neither store nor
// migration test had a `kind: "command"` fixture at all, so a regression in
// either half would surface two layers away, as a webview test about a select.
describe("a rule wired to a command node, round-tripped", () => {
  /** A place, planned work, a notify terminal AND a command node — LEGACY plus
   * the kind this phase added. Built by mutating the parsed literal rather than
   * from the current types, for the same reason `LEGACY` itself is a literal. */
  const withCommand = (edge: Record<string, unknown>): string => {
    const doc = JSON.parse(LEGACY);
    doc.nodes.push({ id: "n4", kind: "command", x: 600, y: 0, join: "any", commandId: "deploy-staging" });
    doc.edges = [edge];
    return JSON.stringify(doc);
  };

  it("stamps no error, and lands on disk as a run, for the shape the new-rule bar builds", () => {
    // No `action` key at all — what both the list's new-rule bar and the
    // canvas's `finishWire` now create.
    const io = fakeIo();
    const flow = JSON.parse(withCommand(
      { id: "e9", from: "n1", to: "n4", cond: { kind: "ci-passed" } },
    )) as Flow;
    writeFlow(io, "/flows", flow);

    // An older build's `validEdge` requires the field, so the mirror must have
    // filled it — with the verb the TARGET implies, which is what makes the read
    // below find nothing to disagree about.
    const onDisk = JSON.parse(io.files["/flows/fmsm1way7-7bbm.json"]);
    expect(onDisk.edges[0].action).toBe("run");

    const after = readFlows(io, "/flows")[0].edges[0];
    expect(after.error).toBeUndefined();
    // Live, not settled by a stamp of any kind: this is the rule staying usable
    // across the save/poll round trip the user actually sees.
    expect(after.firedAt).toBeUndefined();
    expect(after.action).toBe("run");
  });

  it("latches the shape the bar USED to build, which is why storing no action is the fix", () => {
    // The measured defect: the bar's action `<select>` offered three of the four
    // verbs, so a rule from a place to a command node saved `action: "notify"`,
    // and the round trip stamped it dead on the next poll. The counterfactual is
    // what shows the test above passes because the action is ABSENT rather than
    // because a command target never latches.
    const io = fakeIo({
      "/flows/fmsm1way7-7bbm.json": withCommand(
        { id: "e9", from: "n1", to: "n4", cond: { kind: "ci-passed" }, action: "notify" },
      ),
    });
    const e = readFlows(io, "/flows")[0].edges[0];
    // Asserted before the string matches below, so a build that stamps NOTHING
    // fails as "no error" rather than as an assertion-type complaint about
    // `toContain(undefined)`.
    expect(e.error).toBeDefined();
    expect(e.error).toContain(ACTION_MISMATCH_PREFIX);
    // Named both ways round, the strings the reviewer measured in the drawer.
    expect(e.error).toContain('"notify"');
    expect(e.error).toContain('"run"');
  });
});

describe("Reset accepts the new reading", () => {
  // `latchActionMismatches` tells the user "Reset the rule to accept that". This
  // is the store half of making that true. `deckView.ts`'s `flow:resetEdge`
  // deletes the host's own stamps from a spread of the edge and deliberately
  // drops `action` with them; the shape below is exactly what it hands
  // `writeFlow`.
  //
  // The bug this pins: while the reset carried the stored `action` through, the
  // disagreeing value survived the write, the next read compared it against the
  // derived one again, and stamped the identical error. Reset, re-read, latched,
  // forever — and since `finishWire` creates EVERY new wire as `notify`, wiring a
  // place to planned work produced a rule that could never fire and could never
  // be repaired.
  const resetEdge = (flow: Flow, edgeId: string): Flow => ({
    ...flow,
    edges: flow.edges.map((e) => {
      if (e.id !== edgeId) return e;
      const kept = { ...e };
      delete kept.firedAt;
      delete kept.firedNote;
      delete kept.performed;
      delete kept.error;
      delete kept.action;
      return kept;
    }),
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

describe("a launch that promotes its target", () => {
  // The engine's own edit, not the user's: `promoteToPlace` rewrites a launched
  // `planned` node into a `place` WITH THE SAME ID, so every edge into it means
  // `seed` from that moment on while the file still says `launch`. That is exactly
  // the disagreement `latchActionMismatches` stamps an edge dead for, which is why
  // promotion clears the field itself. Round-tripped through the real store,
  // because the whole defect only appears on the NEXT read.
  const fanIn = (): Flow => {
    const doc = JSON.parse(LEGACY);
    // Two rules into one planned node — the default `join: "any"`, so the first
    // condition met launches and the sibling is left unsettled.
    doc.nodes = [
      { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-1", repo: "agent-flow" },
      { id: "n0", kind: "place", x: 0, y: 90, join: "any", runKey: "ASM-0", repo: "agent-flow" },
      { id: "n2", kind: "planned", x: 200, y: 0, join: "any", ticketKey: "ASM-2", repos: ["agent-flow"], mode: "plan", dest: "worktree" },
    ];
    doc.edges = [
      { id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "launch", firedAt: 500, firedNote: "launched ASM-2 in agent-flow", performed: true },
      { id: "e2", from: "n0", to: "n2", cond: { kind: "ci-passed" }, action: "launch" },
    ];
    const io = fakeIo({ "/flows/fmsm1way7-7bbm.json": JSON.stringify(doc) });
    return readFlows(io, "/flows")[0];
  };

  it("settles the untriggered sibling, so no later pass spends on a verb it never had", () => {
    // Round-tripped, because the shape has to survive `coerceFlow` too: the sibling
    // reads back as FIRED (a receipt, no error) rather than as a live `seed` rule that
    // would open an extra paid session the user never wrote.
    const io = fakeIo();
    writeFlow(io, "/flows", promoteToPlace(fanIn(), "n2", "ASM-2", "agent-flow", NOW));
    const e2 = readFlows(io, "/flows")[0].edges.find((e) => e.id === "e2")!;
    expect(e2.firedAt).toBe(NOW);
    expect(e2.firedNote).toBe("ASM-2 was already launched by another rule");
    expect(e2.performed).toBeUndefined();
    expect(e2.error).toBeUndefined();
  });

  it("does not latch the untriggered sibling of the rule that launched", () => {
    const io = fakeIo();
    writeFlow(io, "/flows", promoteToPlace(fanIn(), "n2", "ASM-2", "agent-flow", NOW));
    const e2 = readFlows(io, "/flows")[0].edges.find((e) => e.id === "e2")!;
    // The user edited nothing, so nothing may be stamped on their behalf.
    expect(e2.error).toBeUndefined();
    // And it now reads as the verb its target implies — a promoted node is a
    // place, so a rule into it seeds.
    expect(e2.action).toBe("seed");
  });

  it("still writes an action for every edge, so an older build keeps the rules", () => {
    // `validEdge` in the shipping build REQUIRES `action` and drops any edge
    // without it. Promotion clears the field in memory; `writeFlow`'s
    // `e.action ?? derived` is what has to put the new value back on disk.
    const io = fakeIo();
    writeFlow(io, "/flows", promoteToPlace(fanIn(), "n2", "ASM-2", "agent-flow", NOW));
    const onDisk = JSON.parse(io.files["/flows/fmsm1way7-7bbm.json"]);
    expect(onDisk.edges.map((e: { action?: string }) => e.action)).toEqual(["seed", "seed"]);
  });

  it("keeps the launched edge's own receipt", () => {
    // Clearing the mirror is not clearing the latch: the rule that actually ran
    // must still read as fired, or the next pass launches the same ticket again.
    const io = fakeIo();
    writeFlow(io, "/flows", promoteToPlace(fanIn(), "n2", "ASM-2", "agent-flow", NOW));
    const e1 = readFlows(io, "/flows")[0].edges.find((e) => e.id === "e1")!;
    expect(e1.firedAt).toBe(500);
    expect(e1.firedNote).toBe("launched ASM-2 in agent-flow");
    expect(e1.performed).toBe(true);
  });
});
