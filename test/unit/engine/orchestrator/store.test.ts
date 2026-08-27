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
