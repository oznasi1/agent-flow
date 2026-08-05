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

function fileFor(dir: string, id: string): string {
  return path.join(dir, `${id}.json`);
}

/** Enough of a shape check to keep a hand-edited or half-written file out of the
 * drawer. Deliberately not a full validation: unknown fields must ride along
 * untouched so a newer build's flow survives an older build rewriting it. */
function looksLikeFlow(v: unknown): v is Flow {
  if (!v || typeof v !== "object") return false;
  const f = v as Partial<Flow>;
  return typeof f.id === "string" && Array.isArray(f.nodes) && Array.isArray(f.edges);
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
    const text = io.readFile(path.join(dir, name));
    if (text === null) continue;
    try {
      const parsed: unknown = JSON.parse(text);
      if (looksLikeFlow(parsed)) flows.push(parsed);
    } catch {
      /* skip a corrupt/half-written flow rather than empty the drawer */
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
