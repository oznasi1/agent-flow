// Flow persistence, one file per flow, beside the runs store. IO is injected for
// the same reason `retire.ts` injects `exists`: it keeps this module free of `fs`
// and every rule here testable without a temp directory.
import * as os from "os";
import * as path from "path";
import { Flow } from "./model";

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

/** Enough of a shape check to keep a hand-edited or half-written file out of the
 * drawer. Deliberately not a full validation: unknown fields must ride along
 * untouched so a newer build's flow survives an older build rewriting it. The id
 * charset is the one exception — `fileFor` turns an id straight into a path, so
 * a value like "../../.zshrc" must be rejected here, before it is ever handed
 * back to a caller that trusts this store. */
function looksLikeFlow(v: unknown): v is Flow {
  if (!v || typeof v !== "object") return false;
  const f = v as Partial<Flow>;
  return (
    typeof f.id === "string" && VALID_FLOW_ID.test(f.id) &&
    Array.isArray(f.nodes) && Array.isArray(f.edges)
  );
}

export function writeFlow(io: FlowIo, dir: string, flow: Flow): void {
  io.writeFile(fileFor(dir, flow.id), JSON.stringify(flow, null, 2) + "\n");
}

/** Every flow in the store, newest first. Malformed files are skipped, not fatal. */
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
      const parsed: unknown = JSON.parse(text);
      if (looksLikeFlow(parsed)) flows.push(parsed);
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
