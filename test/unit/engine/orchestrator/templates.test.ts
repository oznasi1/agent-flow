import { describe, expect, it } from "vitest";
import * as path from "path";
import type { Flow, FlowEdge, FlowNode } from "../../../../src/engine/orchestrator/model";
import { instantiate, validTemplate, type FlowTemplate } from "../../../../src/engine/orchestrator/templates";
import { FlowIo, readFlows, writeFlow } from "../../../../src/engine/orchestrator/store";

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

// An in-memory FlowIo — a test-local fake, not production code. Copied from
// test/unit/engine/orchestrator/store.test.ts's `fakeIo` (not exported from
// there) rather than written fresh, per the task brief.
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
const memIo = () => fakeIo().io;

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

  it("records which template it came from", () => {
    const f = instantiate(template(), "PROJ-142", "f-new", 1756300000000);
    expect(f.fromTemplate).toBe("k3f9-ship");
  });

  it("survives a write and read round trip through the store", () => {
    // The field is only useful if it is still there after the host writes the
    // workflow to disk and reads it back. `writeFlow` spreads the whole flow and
    // `coerceFlow` spreads the parsed object, so an unknown-to-them field rides
    // along — this test is what stops either growing a field allow-list later
    // and silently dropping it.
    const io = memIo();
    const f = instantiate(template(), "PROJ-142", "f-new", 1756300000000);
    writeFlow(io, "/flows", f);
    expect(readFlows(io, "/flows")[0].fromTemplate).toBe("k3f9-ship");
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
