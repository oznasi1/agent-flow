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
