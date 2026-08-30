// An append-only record of what an armed flow did, one line per event, beside
// the flow file it describes. This exists because the flow file IS the history:
// a rule's receipt lives on the edge that fired it, and `flow:resetEdge` clears
// exactly those fields so the rule can fire again. Reset a failed 2am deploy and
// the only evidence it ever ran is gone, along with everything it printed.
//
// Pure over an injected IO for the same reason `store.ts` is: the whole
// trim-and-recover story is testable from a plain object, with no temp directory
// and no real clock. `path` is the only import, exactly as in `store.ts` — this
// module is host-side and never reachable from a webview entry point.
import * as path from "path";
import { VALID_FLOW_ID } from "./store";

/** The only IO surface. `append` MUST open with `O_APPEND` so two windows writing
 * at once cannot overwrite each other's offset; `replace` MUST be atomic
 * (tmp-then-rename) so a crash mid-trim leaves the OLD complete journal rather
 * than a half-written one. `size` and `readFile` return null for anything they
 * cannot read — a journal that is missing reads as empty, never as an error. */
export interface JournalIo {
  append(p: string, text: string): void;
  size(p: string): number | null;
  readFile(p: string): string | null;
  replace(p: string, text: string): void;
}

/** How large one flow's journal may grow. A `run` edge can emit output every six
 * seconds and the journal deliberately OUTLIVES its flow (`removeFlow` deletes
 * `<id>.json` only), so "append-only, forever" is a disk leak on an unattended
 * machine. The trade-off is stated rather than hidden: a sufficiently chatty flow
 * does lose its oldest history.
 *
 * Capped by BYTES rather than by line count because a single command output can
 * be larger than a hundred ordinary events — a line cap would bound the wrong
 * quantity and leave the real one unbounded. */
export const JOURNAL_CAP_BYTES = 1_000_000;

/** What a trim cuts the journal back TO, not merely under. Without a low-water
 * mark the file settles exactly AT `JOURNAL_CAP_BYTES` and every later append
 * pays a full read-rewrite-rename — about 2 MB of synchronous IO per line, on
 * the extension host, for as long as the flow keeps journalling. Cutting to 75%
 * amortizes that over roughly 250 KB of appends instead. */
export const JOURNAL_TRIM_TO_BYTES = Math.floor(JOURNAL_CAP_BYTES * 0.75);

/** How much of a command's output each end of a truncated record keeps. The head
 * carries which command actually ran; the tail carries the failure. The middle is
 * what a person scrolls past. */
export const OUTPUT_HEAD_BYTES = 4_000;
export const OUTPUT_TAIL_BYTES = 4_000;

/** What happened, without the fields every event gets. One member per thing a
 * pass can decide — including the three ways a rule can fail to fire, which are
 * the half of the story the flow file has never recorded at all. */
export type JournalEventInput =
  | { kind: "armed"; armed: boolean; source: string }
  | { kind: "consent-asked"; action: string; target: string }
  | { kind: "consented"; answer: string }
  | { kind: "fired"; edge: string; from: string; to: string; action: string; note: string; output?: string }
  | { kind: "errored"; edge: string; from: string; to: string; action: string; error: string; output?: string }
  | { kind: "deferred"; edge: string; reason: string }
  | { kind: "skipped"; edge: string; reason: "disarmed-mid-pass" | "lock-lost" }
  | { kind: "promoted"; node: string; runKey: string; repo: string }
  | { kind: "reset"; edge: string }
  /** A gate's Approve/Reject, stamped as `gateAnswer` on the performer edge.
   * `answer` is a user decision exactly like `consented`'s, so it types the same
   * way: `string`, not the literal union the webview sends, because this module
   * outlives whatever answers a future build adds. Reset deletes `gateAnswer`
   * from the flow file — the journal is the only place the answer survives it. */
  | { kind: "answered"; edge: string; answer: string };

/** An event as it sits on disk, minus `sum` — which is a property of the LINE,
 * not of the event, and is consumed by `readJournal` rather than handed on. */
export type JournalEvent = JournalEventInput & { id: string; at: number; flow: string };

/** Crockford base32 — no I, L, O or U, so an id read aloud or copied out of a log
 * cannot be transcribed into a different one. */
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function b32(n: number, width: number): string {
  let out = "";
  let v = Math.max(0, Math.floor(n));
  for (let i = 0; i < width; i++) {
    out = B32[v % 32] + out;
    v = Math.floor(v / 32);
  }
  return out;
}

/** Mint sortable ids. ULID-shaped: a fixed-width millisecond timestamp, then a
 * within-millisecond sequence, then a random tail.
 *
 * FIXED WIDTH is the load-bearing part — lexical order is only numeric order when
 * every id is the same length, and a shorter id for an earlier clock would sort
 * AFTER a longer one for a later clock.
 *
 * The sequence is why this is a factory returning a closure rather than a plain
 * function: two events in the same millisecond are ordinary (a pass stamps a whole
 * junction at once) and `at` alone cannot order them. Module-level counter state
 * would make every test order-dependent on every other; a closure is state the
 * caller owns and a test can create fresh. */
export function createIdMinter(rand: () => number = Math.random): (nowMs: number) => string {
  let lastMs = -1;
  let seq = 0;
  return (nowMs: number) => {
    const ms = Math.max(0, Math.floor(nowMs));
    if (ms === lastMs) seq += 1;
    else {
      lastMs = ms;
      seq = 0;
    }
    return b32(ms, 10) + b32(seq, 4) + b32(Math.floor(rand() * 1024), 2);
  };
}

/** The panel's minter. One per process, so the sequence actually counts across
 * every flow this window journals. */
const defaultMint = createIdMinter();

/** The fields a line writes first, in this order, so the common ones line up when
 * a human reads the file. Anything NOT listed still rides along, sorted, after
 * them — a line written by a newer build with a field this one has never heard of
 * must still checksum correctly here, or an older build would silently discard
 * every event a newer one wrote. */
const FIELD_ORDER = [
  "id", "at", "flow", "kind",
  "armed", "source", "action", "target", "answer",
  "edge", "from", "to", "note", "error", "reason",
  "node", "runKey", "repo", "output",
];

/** The line's payload, with keys in a deterministic order. Both the writer and
 * the verifier build the string this way, which is what makes the checksum
 * reproducible without depending on JSON key order surviving a parse. */
function canonicalJson(ev: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const k of FIELD_ORDER) if (ev[k] !== undefined) out[k] = ev[k];
  for (const k of Object.keys(ev).sort()) if (!(k in out) && ev[k] !== undefined) out[k] = ev[k];
  return JSON.stringify(out);
}

/** FNV-1a, 32-bit, hex. NOT a tamper defence — a TORN-WRITE defence. `O_APPEND`
 * makes the write OFFSET atomic but not an 8 KB payload, so two windows appending
 * a large command output can interleave their bytes and leave a line that parses
 * as JSON while describing an event that never happened. A line whose checksum
 * does not match its content is skipped on read, which is the posture `readFlows`
 * already takes toward a corrupt flow file: one bad record costs that record. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Where a flow's journal lives. `.log.jsonl` and not `.jsonl` alone so the file
 * is obviously paired with `<id>.json`, and — checked by a test — so it does not
 * end in `.json`, which is the extension `readFlows` scans for. If that ever
 * changed, every journal would be parsed as a flow and dropped as malformed.
 *
 * The id charset check is the same one `fileFor` (store.ts) makes, from the same
 * exported regex, because this function turns an id straight into a path too. */
export function journalPath(dir: string, flowId: string): string {
  if (!VALID_FLOW_ID.test(flowId)) throw new Error(`invalid flow id: ${JSON.stringify(flowId)}`);
  return path.join(dir, `${flowId}.log.jsonl`);
}

/** A command's stdout+stderr, cut to fit. Without this one verbose deploy evicts
 * a flow's entire history under `JOURNAL_CAP_BYTES`, which would make the cap
 * self-defeating: the point of trimming is to keep MORE history, not to spend it
 * all on one run.
 *
 * The elision is explicit in the stored text so nobody mistakes a truncated log
 * for a complete one and concludes the command printed nothing in between. */
export function truncateOutput(s: string): string {
  if (s.length <= OUTPUT_HEAD_BYTES + OUTPUT_TAIL_BYTES) return s;
  const elided = s.length - OUTPUT_HEAD_BYTES - OUTPUT_TAIL_BYTES;
  return `${s.slice(0, OUTPUT_HEAD_BYTES)}\n… ${elided} bytes elided …\n${s.slice(s.length - OUTPUT_TAIL_BYTES)}`;
}

/** Make room for `incoming` bytes by dropping WHOLE lines from the front.
 *
 * A trim STARTS at `JOURNAL_CAP_BYTES` but cuts all the way down to
 * `JOURNAL_TRIM_TO_BYTES`. Trimming to the cap alone would leave the file
 * sitting exactly at it, so every subsequent append would read, rewrite and
 * rename the whole megabyte again; the low-water mark buys roughly 250 KB of
 * plain appends between rewrites instead.
 *
 * Whole lines only: half a JSON object at the head of the file is a line
 * `readJournal` would skip anyway, so cutting mid-line would silently cost an
 * extra event on top of the ones the cap already claims.
 *
 * `replace` rather than a truncating write, because it is atomic: a crash between
 * emptying the file and refilling it would otherwise destroy the entire journal
 * to save a few kilobytes.
 *
 * An incoming line larger than the budget ALL BY ITSELF empties the file and is
 * then appended anyway. That is deliberate — exceeding the cap for one line is better
 * than dropping an event on the floor, and the alternative (refusing the write)
 * would silently lose exactly the enormous failure someone most wants to read. */
function trimFor(io: JournalIo, p: string, incoming: number): void {
  const size = io.size(p);
  if (size === null || size + incoming <= JOURNAL_CAP_BYTES) return;
  const text = io.readFile(p);
  if (text === null) return;
  const lines = text.split("\n").filter((l) => l.length > 0);
  let bytes = lines.reduce((n, l) => n + l.length + 1, 0);
  let first = 0;
  while (first < lines.length && bytes + incoming > JOURNAL_TRIM_TO_BYTES) {
    bytes -= lines[first].length + 1;
    first += 1;
  }
  const kept = lines.slice(first);
  io.replace(p, kept.length > 0 ? kept.join("\n") + "\n" : "");
}

function serialize(ev: Record<string, unknown>): string {
  const body = canonicalJson(ev);
  // Spliced in rather than added to the object, so `sum` is always last and the
  // canonical form it was computed over never contains itself.
  return `${body.slice(0, -1)},"sum":"${fnv1a(body)}"}`;
}

/** Record one event. Appends a single newline-terminated line.
 *
 * `mint` is injectable so a test gets deterministic, assertable ids; production
 * uses the one process-wide minter. */
export function appendEvent(
  io: JournalIo,
  dir: string,
  flowId: string,
  ev: JournalEventInput,
  nowMs: number,
  mint: (nowMs: number) => string = defaultMint,
): void {
  const p = journalPath(dir, flowId);
  const line = serialize({ id: mint(nowMs), at: nowMs, flow: flowId, ...ev }) + "\n";
  trimFor(io, p, line.length);
  io.append(p, line);
}

/** Every event in a flow's journal, oldest first — which is simply write order,
 * because the file is append-only.
 *
 * A line that does not parse, or whose checksum does not match, is SKIPPED rather
 * than fatal: the point of a post-mortem record is to survive the crash that
 * produced it, and a torn final line must not cost the hundred good lines above
 * it. Same house rule as `readFlows`: one bad record costs one record. */
export function readJournal(io: JournalIo, dir: string, flowId: string): JournalEvent[] {
  const text = io.readFile(journalPath(dir, flowId));
  if (text === null) return [];
  const out: JournalEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const { sum, ...rest } = parsed;
      if (typeof sum !== "string" || fnv1a(canonicalJson(rest)) !== sum) continue;
      out.push(rest as unknown as JournalEvent);
    } catch {
      /* a torn or hand-mangled line costs that line, never the journal */
    }
  }
  return out;
}
