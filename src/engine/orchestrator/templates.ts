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
  Flow, FlowEdge, FlowNode, isPlace, isPlanned, LaunchDest, nextEdgeId, nextNodeId,
  PlaceNode, PlannedNode, stripHostStamps,
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

/** What `instantiate` cannot read off the template, and must be told.
 *
 * `PlannedNode` carries `repos` and `mode` — a `run.repos[].name` list and a
 * `PromptMode` id — and both are `agentFlow.*` settings. A template saved by a
 * user has them because the save dialog asked; a BUILT-IN starter cannot have
 * them at all, because it ships before the user's configuration exists and
 * baking either in would break the no-hardcoded-organization-values invariant.
 *
 * So they arrive here, from the card being attached to and the config the host
 * already holds. Injected rather than imported for the same reason the flow id
 * and clock are: the whole substitution stays table-testable from fixtures, with
 * no filesystem, no panel and no `getConfig()`. */
export interface InstantiateCtx {
  /** `run.repos[].name` for the card being attached to. */
  repos: string[];
  /** Configured prompt-mode ids, in the user's own order. The first is the
   * fallback for a node whose mode is empty or no longer configured. */
  modes: string[];
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
export function instantiate(
  t: FlowTemplate, ticketKey: string, flowId: string, nowMs: number, ctx: InstantiateCtx,
): Flow {
  if (!t.flow.nodes.some(isPlanned)) {
    throw new Error(`template ${JSON.stringify(t.name)} has no planned step: nothing to bind ${ticketKey} to`);
  }
  // A template that starts itself would start itself again in the child, six
  // seconds later, forever. `MAX_SUBFLOW_DEPTH` (model.ts) bounds the chain at
  // spawn time regardless; this refuses the one shape that is never right.
  if (t.flow.nodes.some((n) => n.kind === "subflow" && n.templateId === t.id)) {
    throw new Error(`template ${JSON.stringify(t.name)} starts itself as a subflow — that would never end`);
  }

  // Build the fresh flow incrementally so `nextNodeId`/`nextEdgeId` see what has
  // already been minted — they answer "unique within THIS flow".
  const out: Flow = { id: flowId, name: t.name, armed: false, createdAt: nowMs, nodes: [], edges: [] };

  // Ids are minted against the flow being BUILT, so an instantiated workflow is
  // numbered n1, n2, … exactly like a hand-drawn one. They are flow-local by
  // design — `outcomes` is per-flow (deckView.ts), the journal is per-flow, and
  // Reset is flow-scoped — so an instance reusing the template's numbering
  // collides with nothing. What must hold is uniqueness WITHIN this flow, which
  // is what `nextNodeId`/`nextEdgeId` answer.
  const remap = new Map<string, string>();
  for (const n of t.flow.nodes) {
    const id = nextNodeId(out);
    remap.set(n.id, id);
    const bound: FlowNode = isPlanned(n) ? { ...n, id, ticketKey, ...boundLaunch(n, ctx) } : { ...n, id };
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
    const fresh: FlowEdge = { ...stripHostStamps(e), id: nextEdgeId(out), from, to };
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

/** `repos` and `mode` for one planned node: the template's own values when it has
 * usable ones, the card's and the config's otherwise.
 *
 * Refuses rather than guessing. An empty `repos` with nothing to fall back on
 * means a launch with no checkout; a mode nothing resolves means a launch with no
 * prompt. `DemotionChoice`'s own comment gives the reason this is a throw and not
 * a default: a guessed destination is a session launched into the window you are
 * working in, months later, on someone else's ticket. */
function boundLaunch(n: PlannedNode, ctx: InstantiateCtx): { repos: string[]; mode: string } {
  const repos = n.repos.length > 0 ? n.repos : ctx.repos;
  if (repos.length === 0) {
    throw new Error("this card has no repo to launch in, and the template names none");
  }
  const mode = ctx.modes.includes(n.mode) ? n.mode : ctx.modes[0];
  if (mode === undefined) {
    throw new Error("no prompt mode is configured: set agentFlow.promptModes before attaching a workflow");
  }
  return { repos, mode };
}

/** What the save dialog must ask about one place it is demoting.
 *
 * `mode` and `dest` are the two fields a `PlaceNode` cannot give back:
 * `promoteToPlace` rewrote a planned node into a place and those two lived on the
 * planned node it destroyed — and a place created by a Take never had them at
 * all. They are asked for, never invented, because a guessed destination means a
 * template that silently launches a session into the window you are working in,
 * months later, on someone else's ticket. */
export interface DemotionChoice {
  nodeId: string;
  mode: string;
  dest: LaunchDest;
}

/** Every place this flow would have to demote, in node order — one row per
 * place for the save dialog to ask about. */
export function placesToDemote(flow: Flow): PlaceNode[] {
  return flow.nodes.filter(isPlace);
}

/** Whether this flow could ever be attached to a ticket once saved.
 *
 * `toTemplate` happily turns a flow made only of command / gate / notify nodes
 * into a template — it demotes zero places and throws only on an empty flow —
 * but `instantiate` then refuses that template at every single future attach,
 * because a template with no `planned` node has nothing to bind the ticket to.
 * The two functions' rules give this predicate directly rather than restating
 * it: `toTemplate` demotes every `isPlace` node into a `planned` one, and a
 * `planned` node it leaves alone stays `planned` — so "will produce a planned
 * node" is exactly "has a place or a planned node right now".
 *
 * Checked on both ends of `flow:saveTemplate`: the drawer disables its button
 * with this before the click, and the host handler refuses the write with it
 * too, since a stale webview open from before this guard shipped can still
 * send the message. */
export function canBindTicket(flow: Flow): boolean {
  return flow.nodes.some((n) => isPlace(n) || isPlanned(n));
}

/** A template's stored inner flow is a SHAPE, never a live workflow's history —
 * so every field that only makes sense on something that has actually run gets
 * cleared here: the flow `id` (not part of the shape; `instantiate` mints a
 * fresh one), `armed` (a template is never armed — `instantiate` always builds
 * its copy disarmed regardless), `createdAt` (this flow was never created, only
 * the template was), and every edge's host stamps — `firedAt`/`firedNote`/
 * `performed`/`error`/`action`/`gateAnswer` — via `stripHostStamps`.
 *
 * The FLOW-level consent stamps, `launchConfirmedAt`/`commandConfirmedAt`, are
 * dropped here too, but NOT by `stripHostStamps` — that function only ever
 * touches a `FlowEdge`, and consent lives on `Flow` itself (`model.ts`).
 * They are dropped structurally instead: the object literal below names
 * exactly six fields, and neither consent stamp is one of them, so a flow
 * carrying either loses it simply by not being copied into the result.
 * Whoever "simplifies" this into a spread of `flow` (keeping only the fields
 * that must change) would carry both straight through — multiplying one
 * approved consent across every card the resulting template is ever attached
 * to, the exact twenty-machines-one-click failure `instantiate`'s own doc
 * comment (below) warns about.
 *
 * `nodes` is taken as given rather than derived from `flow`, because `toTemplate`
 * calls this with place-demoted nodes and deckView's `flow:writeTemplate`
 * handler calls it with the flow's own nodes unchanged — this function only
 * owns the normalization, not the demotion.
 *
 * The ONE normalization rule, shared by both write paths that produce a
 * template's inner flow, so they cannot quietly drift on what "normalized"
 * means: `toTemplate` (converting an existing flow into a new template) and
 * `flow:writeTemplate` (deckView.ts — the canvas's own create/update save). */
export function normalizedTemplateFlow(flow: Flow, name: string, nodes: FlowNode[]): Flow {
  return {
    id: "", name, armed: false, createdAt: 0,
    // A subflow node's `childFlowId` is a host stamp naming a flow that exists
    // on THIS machine's disk; a template must carry the shape, never that.
    nodes: nodes.map((n) => {
      if (n.kind !== "subflow") return n;
      const { childFlowId: _drop, ...rest } = n;
      return rest;
    }),
    edges: flow.edges.map(stripHostStamps),
  };
}

/** A template from a live workflow.
 *
 * The direction here is the one the engine already runs, backwards:
 * `promoteToPlace` rewrites `planned → place` the moment a launch succeeds,
 * keeping the node's `id`, `x`, `y` and `join` precisely so every downstream edge
 * stays pointing at it. This preserves the same four for the same reason. */
export function toTemplate(
  flow: Flow,
  name: string,
  id: string,
  savedAt: number,
  choices: DemotionChoice[],
): FlowTemplate {
  if (flow.nodes.length === 0) throw new Error("this workflow has no steps: nothing to reuse");

  const byNode = new Map(choices.map((c) => [c.nodeId, c]));
  const nodes: FlowNode[] = flow.nodes.map((n) => {
    if (!isPlace(n)) return { ...n };
    const choice = byNode.get(n.id);
    if (!choice) {
      throw new Error(`no prompt mode and destination chosen for step ${n.id} (${n.runKey})`);
    }
    const demoted: PlannedNode = {
      id: n.id, x: n.x, y: n.y, join: n.join,
      kind: "planned",
      // The parameter, and the only field deliberately blank: `instantiate` fills it.
      ticketKey: "",
      // A place is exactly one repo, by construction.
      repos: [n.repo],
      mode: choice.mode,
      dest: choice.dest,
    };
    return demoted;
  });

  return {
    schema: TEMPLATE_SCHEMA,
    id,
    name,
    params: {},
    savedAt,
    flow: normalizedTemplateFlow(flow, name, nodes),
  };
}
