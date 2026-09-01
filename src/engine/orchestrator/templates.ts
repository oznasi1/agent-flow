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
  //
  // `nextNodeId`/`nextEdgeId` answer "unique within THIS flow" over whatever
  // `Flow` they are handed — they know nothing about the template `out` was
  // instantiated from. Handing them `out` alone would let a fresh id collide
  // with an UNPROCESSED template id (a template whose ids start at "n1" mints
  // its own replacement as "n1", since `out.nodes` starts empty) — exactly the
  // cross-flow collision the id remap exists to prevent. Folding the template's
  // own ids into the taken set for each call reserves them without mutating
  // `out`, so the minted ids are disjoint from the template's from the first one.
  const remap = new Map<string, string>();
  for (const n of t.flow.nodes) {
    const id = nextNodeId({ ...out, nodes: [...out.nodes, ...t.flow.nodes] });
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
    const id = nextEdgeId({ ...out, edges: [...out.edges, ...t.flow.edges] });
    const fresh: FlowEdge = { ...stripHostStamps(e), id, from, to };
    out.edges.push(fresh);
  }

  // No consent stamps, ever. `launchConfirmedAt` and `commandConfirmedAt` are per
  // workflow, asked once, and then it spends unattended forever. A template that
  // carried either would multiply one consent by every card it is attached to:
  // twenty workflows from one approved template is twenty machines running
  // deploy.sh on the strength of a single click made about a different ticket.
  // Simply never assigned here — the fresh object above has neither.
  return { ...out, fromTemplate: t.id };
}
