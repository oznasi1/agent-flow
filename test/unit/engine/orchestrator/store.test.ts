import { describe, it, expect } from "vitest";
import * as os from "os";
import * as path from "path";
import {
  FlowIo, defaultFlowsDir, readFlows, writeFlow, removeFlow,
  defaultTemplatesDir, readTemplates, writeTemplate, removeTemplate,
} from "../../../../src/engine/orchestrator/store";
import { Flow, emptyFlow } from "../../../../src/engine/orchestrator/model";
import { FlowTemplate } from "../../../../src/engine/orchestrator/templates";

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

  it("skips a record whose id would escape the store directory", () => {
    // A hand-edited (or malicious) file can claim any id. `id` is turned
    // straight into a path by `writeFlow`/`removeFlow`, so an id like
    // "../../../../.zshrc" must be treated as malformed, exactly like any
    // other bad record — not accepted and handed back to a caller that will
    // eventually round-trip it through `fileFor`.
    const { io } = fakeIo({
      [path.join(DIR, "evil.json")]: JSON.stringify({ ...flow(), id: "../../../../.zshrc" }),
      [path.join(DIR, "slash.json")]: JSON.stringify({ ...flow(), id: "a/b" }),
      [path.join(DIR, "f1.json")]: JSON.stringify(flow()),
    });
    expect(readFlows(io, DIR).map((f) => f.id)).toEqual(["f1"]);
  });

  it("drops an edge with no cond at all, and keeps the rest of the flow", () => {
    // The probe-proved crash: `e.cond.kind` is read unguarded by the drawer (twice),
    // by armability.ts and by evaluate.ts, so an edge with no `cond` threw
    // "TypeError: Cannot read properties of undefined (reading 'kind')" out of
    // render — and with no error boundary anywhere in src/, that blanks the whole
    // Deck panel. One bad edge must cost that edge, not the flow and not the view.
    const p = path.join(DIR, "f1.json");
    const { io } = fakeIo({
      [p]: JSON.stringify({
        ...flow(),
        edges: [
          { id: "e1", from: "a", to: "z", action: "notify" }, // no cond
          { id: "e2", from: "a", to: "z", cond: { kind: "pr-merged" }, action: "notify" },
        ],
      }),
    });
    const read = readFlows(io, DIR);
    expect(read).toHaveLength(1);
    expect(read[0].id).toBe("f1");
    expect(read[0].edges.map((e) => e.id)).toEqual(["e2"]);
  });

  it("drops every other shape of unusable edge", () => {
    const p = path.join(DIR, "f1.json");
    const { io } = fakeIo({
      [p]: JSON.stringify({
        ...flow(),
        edges: [
          { id: "e1", from: "a", to: "z", cond: "pr-merged", action: "notify" }, // cond not an object
          { id: "e2", from: "a", to: "z", cond: { kind: 7 }, action: "notify" }, // kind not a string
          { id: "e3", from: "a", to: "z", cond: {}, action: "notify" }, // no kind
          { from: "a", to: "z", cond: { kind: "pr-merged" }, action: "notify" }, // no id
          { id: "e5", to: "z", cond: { kind: "pr-merged" }, action: "notify" }, // no from
          { id: "e6", from: "a", cond: { kind: "pr-merged" }, action: "notify" }, // no to
          { id: "e8", from: "a", to: "z", cond: { kind: "pr-merged" }, action: null }, // action not a string
          null, // not an object at all
          "e10",
          { id: "keeper", from: "a", to: "z", cond: { kind: "ci-passed" }, action: "notify" },
        ],
      }),
    });
    expect(readFlows(io, DIR)[0].edges.map((e) => e.id)).toEqual(["keeper"]);
  });

  // `action` used to be required here too, and dropping this case silently
  // deleted every rule in every flow file on disk once the shipping build
  // stopped writing it — see migration.test.ts, which owns this behaviour.
  it("keeps an edge with no action at all", () => {
    const p = path.join(DIR, "f1.json");
    const { io } = fakeIo({
      [p]: JSON.stringify({
        ...flow(),
        edges: [{ id: "e7", from: "a", to: "z", cond: { kind: "pr-merged" } }],
      }),
    });
    expect(readFlows(io, DIR)[0].edges.map((e) => e.id)).toEqual(["e7"]);
  });

  it("drops a node the canvas could not place, and keeps the rest", () => {
    const p = path.join(DIR, "f1.json");
    const { io } = fakeIo({
      [p]: JSON.stringify({
        ...flow(),
        nodes: [
          { id: "n1", kind: "place", x: "24", y: 24, join: "any" }, // x not a number
          { id: "n2", kind: "place", y: 24, join: "any" }, // no x
          { id: "n3", kind: "place", x: 24, join: "any" }, // no y
          { id: "n4", x: 24, y: 24, join: "any" }, // no kind
          { kind: "place", x: 24, y: 24, join: "any" }, // no id
          undefined,
          { id: "keeper", kind: "place", x: 24, y: 24, join: "any", runKey: "PROJ-1", repo: "r" },
        ],
      }),
    });
    expect(readFlows(io, DIR)[0].nodes.map((n) => n.id)).toEqual(["keeper"]);
  });

  it("keeps an edge whose cond kind it does not recognise — a newer build's rule must still render", () => {
    // The line between "unusable" and "unknown": every reader of `cond.kind` is a
    // map or set lookup that simply misses on an unknown string. Rejecting one
    // would delete a newer build's rule out of the user's file.
    const p = path.join(DIR, "f1.json");
    const { io } = fakeIo({
      [p]: JSON.stringify({
        ...flow(),
        nodes: [{ id: "n1", kind: "from-the-future", x: 0, y: 0, join: "any" }],
        edges: [{ id: "e1", from: "a", to: "z", cond: { kind: "moon-is-full" }, action: "notify" }],
      }),
    });
    const read = readFlows(io, DIR)[0];
    expect(read.edges.map((e) => e.id)).toEqual(["e1"]);
    expect(read.nodes.map((n) => n.id)).toEqual(["n1"]);
  });

  it("preserves an edge's own unknown fields while validating its shape", () => {
    const p = path.join(DIR, "f1.json");
    const { io } = fakeIo({
      [p]: JSON.stringify({
        ...flow(),
        edges: [{ id: "e1", from: "a", to: "z", cond: { kind: "pr-merged" }, action: "notify", futureEdgeThing: 7 }],
      }),
    });
    expect((readFlows(io, DIR)[0].edges[0] as unknown as { futureEdgeThing: number }).futureEdgeThing).toBe(7);
  });

  it("guarantees every edge it hands back has a string cond.kind — the invariant its consumers read unguarded", () => {
    const p = path.join(DIR, "f1.json");
    const { io } = fakeIo({
      [p]: JSON.stringify({
        ...flow(),
        edges: [
          { id: "bad", from: "a", to: "z", action: "notify" },
          { id: "good", from: "a", to: "z", cond: { kind: "pr-merged" }, action: "notify" },
        ],
      }),
    });
    const edges = readFlows(io, DIR)[0].edges;
    // Length asserted first: `every` on an empty array is vacuously true, which
    // would let a rule that threw the whole flow away pass this test.
    expect(edges).toHaveLength(1);
    expect(edges.every((e) => typeof e.cond.kind === "string")).toBe(true);
  });

  it("still skips a record whose nodes or edges are not arrays at all", () => {
    // Element filtering replaced the old whole-flow check for element SHAPE, not
    // for the two containers: without an array there is nothing to filter, and a
    // caller that maps over `edges` would throw on the first read.
    const { io } = fakeIo({
      [path.join(DIR, "a.json")]: JSON.stringify({ ...flow(), id: "a", edges: null }),
      [path.join(DIR, "b.json")]: JSON.stringify({ ...flow(), id: "b", nodes: "n1" }),
      [path.join(DIR, "f1.json")]: JSON.stringify(flow()),
    });
    expect(readFlows(io, DIR).map((f) => f.id)).toEqual(["f1"]);
  });

  it("readFile throwing for one file (e.g. EACCES, or removed between readDir and readFile) still returns every other flow", () => {
    const { io } = fakeIo({ [path.join(DIR, "f1.json")]: JSON.stringify(flow()) });
    const original = io.readFile;
    io.readFile = (p) => {
      if (p.endsWith("bad.json")) throw new Error("EACCES");
      return original(p);
    };
    // "bad.json" is in readDir's listing but throws on readFile.
    const originalReadDir = io.readDir;
    io.readDir = (dir) => [...originalReadDir(dir), "bad.json"];
    expect(readFlows(io, DIR).map((f) => f.id)).toEqual(["f1"]);
  });
});

describe("writeFlow / removeFlow — refuse an id that could escape the store directory", () => {
  it("writeFlow throws rather than writing outside dir", () => {
    const { io } = fakeIo();
    expect(() => writeFlow(io, DIR, flow({ id: "../../../../.zshrc" }))).toThrow();
  });

  it("removeFlow throws rather than deleting outside dir", () => {
    const { io } = fakeIo();
    expect(() => removeFlow(io, DIR, "../../../../.zshrc")).toThrow();
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

describe("readFlows — a createdAt that is not a number", () => {
  it("sorts it as oldest, deterministically, instead of letting NaN scramble the order", () => {
    // `(b.createdAt ?? 0) - (a.createdAt ?? 0)` with a string createdAt gives a
    // NaN comparison — an inconsistent comparator, so the whole listing's order
    // becomes arbitrary, valid flows included. A record that cannot say when it
    // was created sorts with the ones that never said at all: as oldest.
    const { io } = fakeIo({
      [path.join(DIR, "y.json")]: JSON.stringify({ ...flow({ id: "y" }), createdAt: "yesterday" }),
      [path.join(DIR, "b.json")]: JSON.stringify(flow({ id: "b", createdAt: 5 })),
      [path.join(DIR, "c.json")]: JSON.stringify(flow({ id: "c", createdAt: 9 })),
    });
    expect(readFlows(io, DIR).map((f) => f.id)).toEqual(["c", "b", "y"]);
  });
});

describe("readFlows — a node with no usable join", () => {
  it('reads a missing join as "all" — the junction that cannot fire prematurely', () => {
    // Every released build has written `join` on every node since the model
    // existed, so a join-less node is only ever hand-authored. `evaluate.ts`
    // asks `target.join === "all"`, so absent read as "any" — and an intended
    // wait-for-both junction fired on the FIRST met edge: a paid launch the
    // wiring said to wait on. "all" is the fail-safe reading: a junction that
    // waits too hard costs a look at the drawer, never money.
    const p = path.join(DIR, "f1.json");
    const { io } = fakeIo({
      [p]: JSON.stringify({
        ...flow(),
        nodes: [
          { id: "n1", kind: "notify", x: 0, y: 0, message: "m" }, // no join
          { id: "n2", kind: "notify", x: 0, y: 0, join: "sometimes", message: "m" }, // not a JoinMode
        ],
      }),
    });
    expect(readFlows(io, DIR)[0].nodes.map((n) => n.join)).toEqual(["all", "all"]);
  });

  it("keeps a valid join untouched", () => {
    const p = path.join(DIR, "f1.json");
    const { io } = fakeIo({
      [p]: JSON.stringify({
        ...flow(),
        nodes: [
          { id: "n1", kind: "notify", x: 0, y: 0, join: "any", message: "m" },
          { id: "n2", kind: "notify", x: 0, y: 0, join: "all", message: "m" },
        ],
      }),
    });
    expect(readFlows(io, DIR)[0].nodes.map((n) => n.join)).toEqual(["any", "all"]);
  });
});

describe("readFlows — two edges sharing one id", () => {
  it("keeps only the first, so no per-edge bookkeeping is ever shared", () => {
    // Everything downstream keys per-edge state by `e.id`: evaluate.ts's met
    // memo (the second edge would fire on the FIRST's condition — a silent paid
    // launch), applyFired's stamps and its outcomes map, and Reset. Ids are
    // minted unique by every released build, so a duplicate is only ever a
    // hand-edit or a file merge; the first occurrence wins, like everything
    // else in flow order.
    const p = path.join(DIR, "f1.json");
    const { io } = fakeIo({
      [p]: JSON.stringify({
        ...flow(),
        edges: [
          { id: "e1", from: "a", to: "z", cond: { kind: "pr-merged" }, action: "notify" },
          { id: "e1", from: "b", to: "z", cond: { kind: "ci-passed" }, action: "notify" },
          { id: "e2", from: "c", to: "z", cond: { kind: "ci-failed" }, action: "notify" },
        ],
      }),
    });
    const edges = readFlows(io, DIR)[0].edges;
    expect(edges.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(edges[0].cond).toEqual({ kind: "pr-merged" });
  });
});

describe("readFlows — an armed flag that is not a boolean", () => {
  it("reads every non-boolean armed value back as disarmed", () => {
    // `evaluateFlow` gates on `if (!flow.armed)`, so a truthy non-boolean — the
    // string "false" is the nastiest — would evaluate the flow as ARMED, and an
    // armed flow can launch paid sessions and run shell with no ask. Released
    // builds only ever write the booleans, so only the boolean `true` arms.
    const { io } = fakeIo({
      [path.join(DIR, "a.json")]: JSON.stringify({ ...flow({ id: "a" }), armed: "false" }),
      [path.join(DIR, "b.json")]: JSON.stringify({ ...flow({ id: "b" }), armed: 1 }),
      [path.join(DIR, "c.json")]: JSON.stringify({ ...flow({ id: "c" }), armed: {} }),
    });
    const read = readFlows(io, DIR);
    expect(read).toHaveLength(3);
    expect(read.every((f) => f.armed === false)).toBe(true);
  });

  it("keeps a boolean true armed and a boolean false disarmed", () => {
    const { io } = fakeIo({
      [path.join(DIR, "on.json")]: JSON.stringify(flow({ id: "on", armed: true })),
      [path.join(DIR, "off.json")]: JSON.stringify(flow({ id: "off", armed: false })),
    });
    const byId = new Map(readFlows(io, DIR).map((f) => [f.id, f.armed]));
    expect(byId.get("on")).toBe(true);
    expect(byId.get("off")).toBe(false);
  });
});

describe("readFlows — a filename that does not match the record's own id", () => {
  it("skips a record whose filename is not <id>.json", () => {
    // `cp f1.json f1-backup.json` puts two records claiming the same id in the
    // store, and `removeFlow` only ever deletes `<id>.json` — so without this
    // skip the copy is an ARMED duplicate that resurrects on every 6s pass and
    // cannot be deleted from the UI. The store itself always writes `<id>.json`
    // (`fileFor`), so a mismatched name is never store-authored: treat it as
    // malformed, exactly like the path-escape skip above.
    const { io } = fakeIo({
      [path.join(DIR, "f1.json")]: JSON.stringify(flow({ armed: true })),
      [path.join(DIR, "f1-backup.json")]: JSON.stringify(flow({ armed: true })),
    });
    expect(readFlows(io, DIR).map((f) => f.id)).toEqual(["f1"]);
  });

  it("leaves nothing readable behind after removeFlow, even when a copy existed", () => {
    const { io } = fakeIo({
      [path.join(DIR, "f1.json")]: JSON.stringify(flow({ armed: true })),
      [path.join(DIR, "f1-backup.json")]: JSON.stringify(flow({ armed: true })),
    });
    removeFlow(io, DIR, "f1");
    expect(readFlows(io, DIR)).toEqual([]);
  });
});

describe("a gate flow on disk", () => {
  it("round-trips the node, the ask edge and the answer", () => {
    const { io } = fakeIo();
    const gateFlow: Flow = {
      ...flow({ id: "f1" }),
      nodes: [{ id: "g", kind: "gate", x: 8, y: 8, join: "any", question: "deploy to prod?" }],
      edges: [{
        id: "ask1", from: "a", to: "g", cond: { kind: "pr-merged" },
        firedAt: 1, performed: true, gateAnswer: "approved",
      }],
    };
    writeFlow(io, DIR, gateFlow);
    const back = readFlows(io, DIR)[0];
    expect(back.nodes[0]).toMatchObject({ kind: "gate", question: "deploy to prod?" });
    expect(back.edges[0].gateAnswer).toBe("approved");
  });

  it("derives ask onto an edge into a gate that has no stored action", () => {
    const { io } = fakeIo();
    const gateFlow: Flow = {
      ...flow({ id: "f2" }),
      nodes: [{ id: "g", kind: "gate", x: 0, y: 0, join: "any", question: "q" }],
      edges: [{ id: "ask1", from: "a", to: "g", cond: { kind: "pr-merged" } }],
    };
    writeFlow(io, DIR, gateFlow);
    expect(readFlows(io, DIR)[0].edges[0].action).toBe("ask");
  });

  // The original version of this test stored `action: "ask"` on an UNSETTLED
  // edge — the very value `actionFor("gate")` derives — so `derived ===
  // e.action` and the mismatch branch was never reached at all; the assertion
  // ("no error") held even with `actionFor`'s `"gate"` arm deleted entirely,
  // because `derived === undefined` takes the exact same "return e unchanged"
  // exit `latchActionMismatches` uses for a genuine match. Neither the name
  // ("settled") nor the mismatch this test claims to guard was actually
  // exercised. A stored action that genuinely disagrees with "ask" is what
  // makes the outcome depend on `actionFor`'s gate arm.
  it("latches an action mismatch on an unsettled gate edge whose stored action disagrees with actionFor(\"gate\")", () => {
    const { io } = fakeIo();
    const gateFlow: Flow = {
      ...flow({ id: "f3" }),
      nodes: [{ id: "g", kind: "gate", x: 0, y: 0, join: "any", question: "q" }],
      edges: [{ id: "ask1", from: "a", to: "g", cond: { kind: "pr-merged" }, action: "notify" }],
    };
    writeFlow(io, DIR, gateFlow);
    expect(readFlows(io, DIR)[0].edges[0].error).toContain(
      'it was saved as "notify" but where it points now means "ask"',
    );
  });

  // The other half of the same rule: a SETTLED edge is history, and must not be
  // rewritten even when its stored action genuinely disagrees with what its
  // target now implies (`latchActionMismatches`'s own "only unsettled edges are
  // touched" comment). Paired with the test above so a future edit to the
  // `isSettled` guard shows up as a REGRESSION (an error where none belongs)
  // rather than the previous test's silent no-op.
  it("does not latch a mismatch on a settled gate edge, even when the stored action disagrees", () => {
    const { io } = fakeIo();
    const gateFlow: Flow = {
      ...flow({ id: "f4" }),
      nodes: [{ id: "g", kind: "gate", x: 0, y: 0, join: "any", question: "q" }],
      edges: [{
        id: "ask1", from: "a", to: "g", cond: { kind: "pr-merged" }, action: "notify",
        firedAt: 1, performed: true, gateAnswer: "approved",
      }],
    };
    writeFlow(io, DIR, gateFlow);
    expect(readFlows(io, DIR)[0].edges[0].error).toBeUndefined();
  });
});

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
    const { io } = fakeIo();
    writeTemplate(io, "/tpl", t("k1", "Ship it"));
    expect(readTemplates(io, "/tpl").map((x) => x.name)).toEqual(["Ship it"]);
  });

  it("one corrupt file costs one template, never the whole picker", () => {
    const { io } = fakeIo();
    writeTemplate(io, "/tpl", t("k1", "Ship it"));
    io.writeFile("/tpl/broken.json", "{ not json");
    writeTemplate(io, "/tpl", t("k2", "Review only"));
    expect(readTemplates(io, "/tpl").map((x) => x.name).sort()).toEqual(["Review only", "Ship it"]);
  });

  it("ignores a bare Flow somebody moved into the directory", () => {
    const { io } = fakeIo();
    io.writeFile("/tpl/moved.json", JSON.stringify(t("k1", "Ship it").flow));
    expect(readTemplates(io, "/tpl")).toEqual([]);
  });

  it("refuses to write an id outside the path-safe charset", () => {
    const { io } = fakeIo();
    expect(() => writeTemplate(io, "/tpl", t("../../../.zshrc", "evil"))).toThrow(/invalid template id/i);
  });

  it("removes by id", () => {
    const { io } = fakeIo();
    writeTemplate(io, "/tpl", t("k1", "Ship it"));
    removeTemplate(io, "/tpl", "k1");
    expect(readTemplates(io, "/tpl")).toEqual([]);
  });

  it("reads as empty when the directory does not exist yet", () => {
    const { io } = fakeIo();
    expect(readTemplates(io, "/nope")).toEqual([]);
  });

  it("templates and flows live in sibling directories", () => {
    expect(defaultTemplatesDir()).not.toBe(defaultFlowsDir());
    expect(defaultTemplatesDir().endsWith("templates")).toBe(true);
  });

  it("readFlows pointed at a templates directory returns nothing", () => {
    // Two shapes, two readers, no overlap: an envelope is not a Flow, so a
    // mis-filed template can never be loaded as a real, armable workflow.
    const { io } = fakeIo();
    writeTemplate(io, "/tpl", t("k1", "Ship it"));
    expect(readFlows(io, "/tpl")).toEqual([]);
  });
});
