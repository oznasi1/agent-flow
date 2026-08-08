// Flow persistence, one file per flow, beside the runs store. IO is injected for
// the same reason `retire.ts` injects `exists`: it keeps this module free of `fs`
// and every rule here testable without a temp directory.
import * as os from "os";
import * as path from "path";
import { Flow, FlowEdge, FlowNode } from "./model";

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
 * resolves outside `dir` entirely. */
const VALID_FLOW_ID = /^[A-Za-z0-9_-]+$/;

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
    typeof e.action === "string" &&
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
  return { ...(v as Flow), nodes: f.nodes.filter(validNode), edges: f.edges.filter(validEdge) };
}

export function writeFlow(io: FlowIo, dir: string, flow: Flow): void {
  io.writeFile(fileFor(dir, flow.id), JSON.stringify(flow, null, 2) + "\n");
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
      if (flow) flows.push(flow);
    } catch {
      /* skip a corrupt/half-written/unreadable flow rather than empty the drawer */
    }
  }
  // `?? 0` rather than trusting the field: a record written before `createdAt`
  // existed, or hand-edited without it, must sort as oldest and not as NaN —
  // which would make the comparator inconsistent and the order arbitrary.
  return flows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export function removeFlow(io: FlowIo, dir: string, id: string): void {
  io.remove(fileFor(dir, id));
}
