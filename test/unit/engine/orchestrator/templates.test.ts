import { describe, expect, it } from "vitest";
import * as path from "path";
import type { Flow, FlowEdge, FlowNode } from "../../../../src/engine/orchestrator/model";
import { stripHostStamps } from "../../../../src/engine/orchestrator/model";
import {
  canBindTicket, instantiate, normalizedTemplateFlow, placesToDemote, toTemplate, validTemplate, type FlowTemplate,
} from "../../../../src/engine/orchestrator/templates";
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

// A context that never triggers the fallback: every fixture's planned node
// already carries a non-empty repos and mode "plan", so this only needs to
// satisfy the type and the two refusal guards.
const defaultCtx = { repos: ["ingest-worker"], modes: ["plan"] };

describe("instantiate", () => {
  it("binds the chosen ticket to EVERY planned node", () => {
    const f = instantiate(template(), "PROJ-142", "f-new", 1756300000000, defaultCtx);
    const keys = f.nodes.filter((n) => n.kind === "planned").map((n) => (n as { ticketKey: string }).ticketKey);
    expect(keys).toEqual(["PROJ-142", "PROJ-142"]);
  });

  it("mints ids unique within the instantiated flow", () => {
    const f = instantiate(template(), "PROJ-142", "f-new", 1756300000000, defaultCtx);
    expect(new Set(f.nodes.map((n) => n.id)).size).toBe(f.nodes.length);
    expect(new Set(f.edges.map((e) => e.id)).size).toBe(f.edges.length);
  });

  it("numbers an instantiated workflow like a hand-drawn one", () => {
    // Ids are flow-local: `outcomes` is per-flow, the journal is per-flow, and
    // Reset is flow-scoped. So there is nothing to avoid colliding with, and an
    // instance numbered n1, n2, … is exactly what every other flow looks like.
    const f = instantiate(template(), "PROJ-142", "f-new", 1756300000000, defaultCtx);
    expect(f.nodes.map((n) => n.id)).toEqual(["n1", "n2", "n3"]);
    expect(f.edges.map((e) => e.id)).toEqual(["e1", "e2"]);
  });

  it("keeps the wiring after re-minting ids", () => {
    const f = instantiate(template(), "PROJ-142", "f-new", 1756300000000, defaultCtx);
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
    const f = instantiate(t, "PROJ-142", "f-new", 1756300000000, defaultCtx);
    expect(f.edges.every((e) => e.firedAt === undefined && e.error === undefined)).toBe(true);
    expect(f.edges.every((e) => e.firedNote === undefined && e.performed === undefined)).toBe(true);
    expect(f.launchConfirmedAt).toBeUndefined();
    expect(f.commandConfirmedAt).toBeUndefined();
  });

  it("is disarmed, freshly stamped, and takes the given id", () => {
    const f = instantiate(template(), "PROJ-142", "f-new", 1756300000000, defaultCtx);
    expect(f.armed).toBe(false);
    expect(f.createdAt).toBe(1756300000000);
    expect(f.id).toBe("f-new");
  });

  it("keeps the template's name verbatim — no {ticket} substitution", () => {
    const f = instantiate(template({ name: "Ship {ticket}" }), "PROJ-142", "f-new", 0, defaultCtx);
    expect(f.name).toBe("Ship {ticket}");
  });

  it("refuses a template with no planned nodes", () => {
    const t = template();
    t.flow.nodes = [notify("n3")];
    t.flow.edges = [];
    expect(() => instantiate(t, "PROJ-142", "f-new", 0, defaultCtx)).toThrow(/nothing to bind/i);
  });

  it("records which template it came from", () => {
    const f = instantiate(template(), "PROJ-142", "f-new", 1756300000000, defaultCtx);
    expect(f.fromTemplate).toBe("k3f9-ship");
  });

  it("drops a dangling edge rather than carrying a broken reference into a live workflow", () => {
    // A template is executed by being COPIED, so an edge naming a node that is not
    // there cannot ride along the way `coerceFlow` lets an unknown node kind ride
    // along on read. The rest of the shape must survive it — one bad element costs
    // that element, the same posture the flow store takes.
    const t = template();
    t.flow.edges = [edge("e1", "n1", "n3"), edge("e2", "n1", "n-gone")];
    const f = instantiate(t, "PROJ-142", "f-new", 1756300000000, defaultCtx);
    expect(f.edges).toHaveLength(1);
    const byId = new Map(f.nodes.map((n) => [n.id, n]));
    expect(byId.get(f.edges[0].to)?.kind).toBe("notify");
    expect(f.nodes).toHaveLength(3);
  });

  it("survives a write and read round trip through the store", () => {
    // The field is only useful if it is still there after the host writes the
    // workflow to disk and reads it back. `writeFlow` spreads the whole flow and
    // `coerceFlow` spreads the parsed object, so an unknown-to-them field rides
    // along — this test is what stops either growing a field allow-list later
    // and silently dropping it.
    const io = memIo();
    const f = instantiate(template(), "PROJ-142", "f-new", 1756300000000, defaultCtx);
    writeFlow(io, "/flows", f);
    expect(readFlows(io, "/flows")[0].fromTemplate).toBe("k3f9-ship");
  });
});

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
    const f = instantiate(t, "PROJ-9", "f-new", 1000, { repos: ["ingest-worker", "api"], modes: ["plan", "review"] });
    expect(f.nodes).toHaveLength(3);
    expect(f.edges).toHaveLength(2);
    const byId = new Map(f.nodes.map((n) => [n.id, n]));
    expect(f.edges.every((e) => byId.has(e.from) && byId.has(e.to))).toBe(true);
    expect(f.edges.map((e) => byId.get(e.to)!.kind)).toEqual(["notify", "notify"]);
  });
});

describe("canBindTicket", () => {
  const command = (id: string): FlowNode => ({ id, x: 0, y: 0, join: "any", kind: "command", run: "echo hi" });
  const gate = (id: string): FlowNode => ({ id, x: 0, y: 0, join: "any", kind: "gate", question: "ok?" });

  it("refuses a flow built only of command / gate / notify nodes", () => {
    // This is exactly the shape `toTemplate` would save cleanly (it only
    // throws on an empty flow) but `instantiate` would then refuse forever —
    // nothing here would ever become a `planned` node to bind a ticket to.
    const flow: Flow = {
      id: "f1", name: "x", armed: false, createdAt: 0,
      nodes: [command("n1"), gate("n2"), notify("n3")],
      edges: [edge("e1", "n1", "n2"), edge("e2", "n2", "n3")],
    };
    expect(canBindTicket(flow)).toBe(false);
  });

  it("accepts a flow with a place — toTemplate demotes it to planned", () => {
    const flow: Flow = {
      id: "f1", name: "x", armed: false, createdAt: 0,
      nodes: [place("n1", "PROJ-142", "ingest-worker"), notify("n2")],
      edges: [edge("e1", "n1", "n2")],
    };
    expect(canBindTicket(flow)).toBe(true);
  });

  it("accepts a flow with a planned node", () => {
    const flow: Flow = {
      id: "f1", name: "x", armed: false, createdAt: 0,
      nodes: [planned("n1"), notify("n2")],
      edges: [edge("e1", "n1", "n2")],
    };
    expect(canBindTicket(flow)).toBe(true);
  });

  it("refuses an empty flow", () => {
    expect(canBindTicket({ id: "f1", name: "x", armed: false, createdAt: 0, nodes: [], edges: [] })).toBe(false);
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

describe("instantiate resolving repos and mode", () => {
  const bare = (id: string): FlowNode => ({
    id, x: 0, y: 0, join: "any", kind: "planned", ticketKey: "", repos: [], mode: "", dest: "worktree",
  });
  const bareTemplate = (): FlowTemplate => template({
    flow: {
      id: "unused", name: "Starter", armed: false, createdAt: 0,
      nodes: [bare("n1"), notify("n2")], edges: [edge("e1", "n1", "n2")],
    },
  });
  const ctx = { repos: ["portal", "worker"], modes: ["plan", "build"] };

  it("fills an empty repos list from the card", () => {
    const f = instantiate(bareTemplate(), "PROJ-1", "f1", 1, ctx);
    const n = f.nodes.find((x) => x.kind === "planned")!;
    expect((n as { repos: string[] }).repos).toEqual(["portal", "worker"]);
  });

  it("fills an empty mode from the first configured prompt mode", () => {
    const f = instantiate(bareTemplate(), "PROJ-1", "f1", 1, ctx);
    const n = f.nodes.find((x) => x.kind === "planned")!;
    expect((n as { mode: string }).mode).toBe("plan");
  });

  it("leaves a populated repos list alone, so a saved template is unchanged", () => {
    // The backward-compatibility guarantee: every template saved before this
    // change must instantiate exactly as it did.
    const t = template(); // its planned nodes carry repos ["ingest-worker"], mode "plan"
    const f = instantiate(t, "PROJ-1", "f1", 1, { repos: ["other"], modes: ["build"] });
    for (const n of f.nodes.filter((x) => x.kind === "planned")) {
      expect((n as { repos: string[] }).repos).toEqual(["ingest-worker"]);
    }
  });

  it("leaves a mode the user has configured alone", () => {
    const t = template(); // mode "plan"
    const f = instantiate(t, "PROJ-1", "f1", 1, { repos: ["x"], modes: ["plan", "build"] });
    const n = f.nodes.find((x) => x.kind === "planned")!;
    expect((n as { mode: string }).mode).toBe("plan");
  });

  it("replaces a mode the user no longer has configured", () => {
    // A template saved against a prompt mode since deleted from settings would
    // otherwise launch with an id nothing resolves.
    const t = template(); // mode "plan"
    const f = instantiate(t, "PROJ-1", "f1", 1, { repos: ["x"], modes: ["build"] });
    const n = f.nodes.find((x) => x.kind === "planned")!;
    expect((n as { mode: string }).mode).toBe("build");
  });

  it("refuses rather than guessing when no prompt mode is configured at all", () => {
    expect(() => instantiate(bareTemplate(), "PROJ-1", "f1", 1, { repos: ["x"], modes: [] }))
      .toThrow(/prompt mode/i);
  });

  it("refuses rather than guessing when the card has no repos", () => {
    expect(() => instantiate(bareTemplate(), "PROJ-1", "f1", 1, { repos: [], modes: ["plan"] }))
      .toThrow(/repo/i);
  });

  it("still refuses a template with no planned step", () => {
    // The pre-existing guard, re-asserted: the new parameter must not have
    // moved the order of the checks.
    const t = template({
      flow: { id: "u", name: "n", armed: false, createdAt: 0, nodes: [notify("n1")], edges: [] },
    });
    expect(() => instantiate(t, "PROJ-1", "f1", 1, ctx)).toThrow(/no planned step/);
  });
});

describe("subflows in templates", () => {
  it("instantiate refuses a template that starts itself", () => {
    const self = template({ flow: {
      id: "unused", name: "Ship it", armed: false, createdAt: 0,
      nodes: [planned("n1"), { id: "s", kind: "subflow", x: 0, y: 0, join: "any", templateId: "k3f9-ship" }],
      edges: [edge("e1", "n1", "s")],
    } });
    expect(() => instantiate(self, "PROJ-1", "f-new", 1, defaultCtx)).toThrow(/starts itself/);
  });

  it("instantiate carries a subflow node pointing at ANOTHER template through, with fresh ids", () => {
    const t = template({ flow: {
      id: "unused", name: "Ship it", armed: false, createdAt: 0,
      nodes: [planned("n1"), { id: "s", kind: "subflow", x: 0, y: 0, join: "any", templateId: "other" }],
      edges: [edge("e1", "n1", "s")],
    } });
    const f = instantiate(t, "PROJ-1", "f-new", 1, defaultCtx);
    expect(f.nodes.find((n) => n.kind === "subflow")).toMatchObject({ templateId: "other" });
  });

  it("normalizedTemplateFlow strips a subflow node's childFlowId — a template carries the shape, never this machine's child", () => {
    const flow: Flow = {
      id: "f1", name: "n", armed: true, createdAt: 0, edges: [],
      nodes: [{ id: "s", kind: "subflow", x: 0, y: 0, join: "any", templateId: "other", childFlowId: "c9" }],
    };
    const out = normalizedTemplateFlow(flow, "n", flow.nodes);
    expect(out.nodes[0]).toEqual({ id: "s", kind: "subflow", x: 0, y: 0, join: "any", templateId: "other" });
  });
});
