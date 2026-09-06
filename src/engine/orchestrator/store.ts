// Flow persistence, one file per flow, beside the runs store. IO is injected for
// the same reason `retire.ts` injects `exists`: it keeps this module free of `fs`
// and every rule here testable without a temp directory.
import { randomUUID } from "crypto";
import * as os from "os";
import * as path from "path";
import { ACTION_MISMATCH_PREFIX, edgeAction, Flow, FlowEdge, FlowNode, isSettled } from "./model";
import { isBuiltinTemplateId } from "./starters";
import { FlowTemplate, validTemplate } from "./templates";

/** The only IO surface. Implementations return null / throw only from `readDir`;
 * `readFile` returns null for anything it cannot read, so one unreadable file
 * degrades a single flow rather than the whole drawer. */
export interface FlowIo {
  readDir(dir: string): string[];
  readFile(p: string): string | null;
  writeFile(p: string, text: string): void;
  remove(p: string): void;
}

export function defaultFlowsDir(): string {
  return path.join(os.homedir(), ".agentflow", "flows");
}

/** An id is turned straight into a path below, and `readFlows` is documented to
 * tolerate a hand-edited file — so an id read back off disk is not safe until it
 * is checked against this charset. Without it, an id like "../../../../.zshrc"
 * resolves outside `dir` entirely.
 *
 * Exported so `journal.ts` builds its path from the SAME charset this store
 * builds `<id>.json` from. A second copy of this regex is a second place for a
 * traversal hole to open: the journal turns an id straight into a path too, and
 * two regexes that are equal today drift the moment either is widened. */
export const VALID_FLOW_ID = /^[A-Za-z0-9_-]+$/;

function fileFor(dir: string, id: string): string {
  // A Flow built by a caller directly (bypassing `readFlows`, the only path that
  // validates an id) with a bad id is a programming error, not bad data found on
  // disk — throw rather than silently writing or removing outside `dir`.
  if (!VALID_FLOW_ID.test(id)) throw new Error(`invalid flow id: ${JSON.stringify(id)}`);
  return path.join(dir, `${id}.json`);
}

/** Is this node's shape usable? Every field the canvas positions and labels a node
 * by, and nothing more. `kind` is checked as a string rather than against the
 * three known values so an unknown kind from a newer build still renders (it
 * simply takes no branch), the same tolerance `cond.kind` gets below. */
function validNode(v: unknown): v is FlowNode {
  if (!v || typeof v !== "object") return false;
  const n = v as Partial<FlowNode>;
  return (
    typeof n.id === "string" &&
    typeof n.x === "number" && typeof n.y === "number" &&
    typeof n.kind === "string"
  );
}

/** Is this edge's shape usable? The `cond` object and its string `kind` are the
 * load-bearing part: `e.cond.kind` is read unguarded by the drawer (twice),
 * `armability.ts` and `evaluate.ts`, so an edge with no `cond` at all throws
 * `TypeError: Cannot read properties of undefined (reading 'kind')` out of render.
 * An unrecognised `kind` string is fine — every reader is a map or set lookup
 * that simply misses. */
function validEdge(v: unknown): v is FlowEdge {
  if (!v || typeof v !== "object") return false;
  const e = v as Partial<FlowEdge>;
  return (
    typeof e.id === "string" &&
    typeof e.from === "string" && typeof e.to === "string" &&
    // `action` is deliberately NOT required. It used to be, and an edge failing
    // this check is DROPPED — so requiring a field this build no longer writes
    // would silently delete every rule in every flow file already on disk.
    // When present it must still be a string, so genuine garbage is caught.
    (e.action === undefined || typeof e.action === "string") &&
    !!e.cond && typeof e.cond === "object" &&
    typeof (e.cond as { kind?: unknown }).kind === "string"
  );
}

/** Enough of a shape check to keep a hand-edited or half-written file out of the
 * drawer, returning the flow with any shape-invalid ELEMENT dropped, or null when
 * the record is not a flow at all. Deliberately not a full validation: unknown
 * fields must ride along untouched so a newer build's flow survives an older build
 * rewriting it. The id charset is the one whole-record exception — `fileFor` turns
 * an id straight into a path, so a value like "../../.zshrc" must be rejected
 * here, before it is ever handed back to a caller that trusts this store.
 *
 * Element validation lives HERE, not in the webview, for three reasons:
 *  - this is the only door bad data comes through. Every consumer — the drawer,
 *    `armability.ts`, `evaluate.ts`, `advanceArmedFlows` — reads `e.cond.kind` or
 *    a node's `x`/`y` unguarded, and there is no error boundary anywhere in
 *    `src/`: one malformed edge thrown out of render blanks the whole Deck panel.
 *    Guarding at each reader would mean guarding at every future reader too.
 *  - it keeps the store's own house rule, the one `readFlows` already honours for
 *    a corrupt FILE: one bad record costs one item, never the whole view. So a
 *    bad edge costs that edge — the flow, and every other edge in it, survives.
 *  - the webview cannot fix anything anyway. It has no write path for the store,
 *    so the best it could do is skip the element silently — which is exactly what
 *    happens here, once, for every consumer.
 * The cost is honest: an element dropped on read is dropped for good the next time
 * the flow is written back. A blank panel is worse. */
function coerceFlow(v: unknown): Flow | null {
  if (!v || typeof v !== "object") return null;
  const f = v as Partial<Flow>;
  if (typeof f.id !== "string" || !VALID_FLOW_ID.test(f.id)) return null;
  if (!Array.isArray(f.nodes) || !Array.isArray(f.edges)) return null;
  // Two edges sharing one id (a hand-edit or a file merge — every released build
  // mints ids unique) would share every piece of per-edge bookkeeping downstream:
  // evaluate.ts's met memo (the second fires on the FIRST's condition — silent
  // spend), applyFired's stamps and its outcomes map, and Reset. Dropped HERE, at
  // the one door bad data comes through, so those id-keyed invariants stay true
  // for every consumer. First occurrence wins, like everything else in flow order.
  const seenEdgeIds = new Set<string>();
  const dedupedEdges = f.edges.filter(validEdge).filter((e) => {
    if (seenEdgeIds.has(e.id)) return false;
    seenEdgeIds.add(e.id);
    return true;
  });
  const shaped = {
    ...(v as Flow),
    // Only the boolean `true` a released build writes arms. `evaluateFlow` gates
    // on `!flow.armed`, so a truthy non-boolean — a hand-edited `"false"` is the
    // nastiest shape — would read as ARMED, and an armed flow launches paid
    // sessions and runs shell with no ask. Disarmed is the reading that costs a
    // toggle, not money.
    armed: f.armed === true,
    // A `join` that is not one of the two modes reads as "all". Every released
    // build has written the field on every node since the model existed, so a
    // missing or mangled join is only ever hand-authored — and `evaluate.ts`
    // asks `join === "all"`, so leaving it absent silently means "any": an
    // intended wait-for-both junction firing on the FIRST met edge, a paid
    // launch the wiring said to wait on. "all" is the fail-safe reading — a
    // junction that waits too hard costs a look at the drawer, never money.
    nodes: f.nodes.filter(validNode).map((n) => (n.join === "any" || n.join === "all" ? n : { ...n, join: "all" as const })),
    edges: dedupedEdges,
  };
  return latchActionMismatches(shaped);
}

/** Latch any edge whose stored action disagrees with the action its target now
 * implies. The collapse is one-to-one for `launch` and `seed` — the drawer
 * refused every other pairing — but NOT for `notify`: nothing ever stopped a
 * notify rule from pointing at a `place`, and deriving the action from the
 * target would silently turn that into a `seed`, opening a paid agent session
 * where the user asked for a toast.
 *
 * The edge is kept, not dropped: the user's wiring is not ours to discard. It is
 * stamped with an `error`, which `isSettled` treats as terminal, so an armed
 * flow will not fire it and the drawer's existing stalled-rule affordance
 * surfaces it. Reset is how the user accepts the new reading. A latched rule
 * costs one click; a migration that spends money on a guess does not come back.
 *
 * Only unsettled edges are touched — an edge that already ran or already failed
 * is history, and rewriting its receipt would blame this migration for it. */
function latchActionMismatches(flow: Flow): Flow {
  return {
    ...flow,
    edges: flow.edges.map((e) => {
      if (e.action === undefined || isSettled(e)) return e;
      const derived = edgeAction(flow, e);
      // Nothing derived means a missing or unknown target, which `evaluate.ts`
      // already reports as "gone". Absence is not disagreement.
      if (derived === undefined || derived === e.action) return e;
      return {
        ...e,
        error: `${ACTION_MISMATCH_PREFIX}: it was saved as "${e.action}" but where it points now means "${derived}". Reset the rule to accept that, or point it somewhere else.`,
      };
    }),
  };
}

/** Persist a flow, returning what was actually written — which is not always what
 * was passed: `action` is filled in below, and a flow with no `analyticsId` is
 * given one here. Callers that go on to REPORT on the flow they just wrote must
 * use the return value, or they would send the pre-mint (empty) id.
 *
 * Minting here, on the write, rather than on the read or in a migration, is what
 * keeps it honest three ways: nothing rewrites a file the user has not otherwise
 * touched; a flow gets exactly one id for its whole life, because the field is
 * only ever filled when absent; and TEMPLATES cannot acquire one at all, since
 * they are written by `writeTemplate` and this function is never in their path.
 * (`instantiate` and `normalizedTemplateFlow` build their output from a fresh
 * object literal, so a template's inner flow cannot carry one in either.) */
export function writeFlow(io: FlowIo, dir: string, flow: Flow): Flow {
  // Keep `action` in step with the node each edge points at — EXCEPT where a
  // stored value already disagrees with it. That disagreement must survive
  // the write, not just the read: `latchActionMismatches` only runs in
  // `coerceFlow`, on the NEXT read, and it works by comparing the stored
  // value against the derived one. Overwriting the stored value here, always,
  // would make the two agree before that comparison ever runs again — erasing
  // the mismatch instead of latching it.
  //
  // Concretely: a settled `{ action: "notify", firedAt: ... }` edge left
  // pointing at a `place` is an ORDINARY shape, not a corrupted one —
  // `OrchestratorDrawer.tsx`'s `finishWire` creates every new wire as
  // `notify` regardless of its target's kind. If this function derived over
  // it, the file would say `action: "seed"`; the next read would see stored
  // and derived agree and latch nothing; and a user who then clicked Reset on
  // an armed flow with `launchConfirmedAt` already set would open a PAID
  // agent session where the shipping build only ever showed a toast.
  //
  // `e.action ?? derived` still gives an edge THIS build created (which has
  // no stored action yet) the derived value, which is what keeps an older
  // build's `validEdge` — which still requires the field — from dropping it
  // on a downgrade or a rollback. Only a PRE-EXISTING disagreement survives.
  const normalised: Flow = {
    ...flow,
    // `??`, not a truthiness check: an id already on disk is kept whatever it
    // says, including a hand-typed one. Re-minting would break the one property
    // the field has — that a workflow's events join up over its whole life.
    analyticsId: flow.analyticsId ?? randomUUID(),
    edges: flow.edges.map((e) => ({ ...e, action: e.action ?? edgeAction(flow, e) })),
  };
  io.writeFile(fileFor(dir, flow.id), JSON.stringify(normalised, null, 2) + "\n");
  return normalised;
}


/** Every flow in the store, newest first. Malformed files are skipped, not fatal;
 * a malformed NODE or EDGE inside an otherwise good flow is dropped on its own,
 * so one bad element costs that element rather than the flow — see `coerceFlow`. */
export function readFlows(io: FlowIo, dir: string): Flow[] {
  let names: string[];
  try {
    names = io.readDir(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const flows: Flow[] = [];
  for (const name of names) {
    try {
      // `readFile` is inside the try, not just `JSON.parse`: a file can vanish
      // between `readDir` and here (`removeFlow` deletes files), and an `io`
      // implementation is free to throw rather than return null for anything
      // else unreadable (e.g. EACCES). Either way, one bad file must degrade to
      // "every other flow", not to zero.
      const text = io.readFile(path.join(dir, name));
      if (text === null) continue;
      const flow = coerceFlow(JSON.parse(text) as unknown);
      // The filename must be the one this record's own id resolves to. The store
      // only ever writes `<id>.json` (`fileFor`), so a mismatch is never
      // store-authored — it is a copied file (`cp f1.json f1-backup.json`), and
      // accepting it makes an ARMED duplicate that `removeFlow` (which deletes by
      // id) cannot reach: it resurrects on every pass and can keep launching.
      // Same posture as the id-charset skip in `coerceFlow`: malformed, one item.
      if (flow && name === `${flow.id}.json`) flows.push(flow);
    } catch {
      /* skip a corrupt/half-written/unreadable flow rather than empty the drawer */
    }
  }
  // `Number(...) || 0` rather than trusting the field: a record written before
  // `createdAt` existed, hand-edited without it, or hand-edited into a STRING
  // must sort as oldest and not as NaN — which would make the comparator
  // inconsistent and the whole listing's order arbitrary, valid flows included.
  // (`?? 0` caught only the absent case; `Number(undefined)` and `Number("x")`
  // are both NaN, and `|| 0` folds them with it.)
  return flows.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
}

export function removeFlow(io: FlowIo, dir: string, id: string): void {
  io.remove(fileFor(dir, id));
}

/** Templates sit beside flows, read and written through the same `FlowIo` with
 * the same rules: the same id charset (an id becomes a path, so this is a
 * traversal guard, not cosmetics) and the same tolerance (one unreadable file
 * costs one template, never the whole picker). */
export function defaultTemplatesDir(): string {
  return path.join(os.homedir(), ".agentflow", "templates");
}

function templateFileFor(dir: string, id: string): string {
  if (!VALID_FLOW_ID.test(id)) throw new Error(`invalid template id: ${JSON.stringify(id)}`);
  return path.join(dir, `${id}.json`);
}

export function writeTemplate(io: FlowIo, dir: string, t: FlowTemplate): void {
  io.writeFile(templateFileFor(dir, t.id), JSON.stringify(t, null, 2));
}

export function readTemplates(io: FlowIo, dir: string): FlowTemplate[] {
  let entries: string[];
  try {
    entries = io.readDir(dir);
  } catch {
    // No directory yet is the ordinary first-run case, not an error.
    return [];
  }
  const out: FlowTemplate[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const text = io.readFile(path.join(dir, name));
    if (text === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const t = validTemplate(parsed);
    // The filename must be the one this record's own id resolves to — the same
    // check `readFlows` makes, and for the same reason. The store only ever
    // writes `<id>.json` (`templateFileFor`), so a mismatch is never
    // store-authored: it is a copied file (`cp k1.json k1-backup.json`), and
    // accepting it puts two templates claiming the same id in the picker —
    // duplicate React keys — while `removeTemplate`/`writeTemplate` address by
    // id, so the copy could never be reached to fix or delete it: it would
    // resurrect in the list on every read, permanently stuck. Skip it, one
    // item lost, exactly like every other malformed record this reader
    // tolerates.
    if (!t || name !== `${t.id}.json`) continue;
    // A built-in ships in `starters.ts` and is never written here, so a file
    // claiming one of those ids is a copy, a backup, or a hand-edit — and
    // honouring it would put two templates with the same id in the picker,
    // one of which the user can never delete. Same failure the filename check
    // above exists to stop.
    if (isBuiltinTemplateId(t.id)) continue;
    out.push(t);
  }
  return out;
}

export function removeTemplate(io: FlowIo, dir: string, id: string): void {
  io.remove(templateFileFor(dir, id));
}
