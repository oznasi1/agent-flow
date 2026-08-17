// The leaf of the spend graph: what a run's token usage IS, how to sum it, and
// how to print it. Types and arithmetic only — no I/O, no other module.
//
// The webview bundles for a BROWSER target and esbuild resolves imports
// statically, so any module the webview's graph can reach must never touch a
// Node builtin. `weightedEq` and `formatEq` are called from DeckApp, which is
// why they live here rather than beside the reader in ./usageFs. Same split as
// ./claudeAssets and ./claudeAssetsFs.
//
// Keep this file importing nothing. test/webview/webviewGraph.test.ts walks the
// real import graph from each webview entry point and fails the moment anything
// reachable from it imports a Node builtin.

/** Token usage, kept in its four billing classes rather than pre-summed. The
 * classes have wildly different rates, so a single total cannot be un-mixed
 * later — and the detail drawer needs the breakdown. */
export interface UsageTotals {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** The subset of a transcript line this module reads. Declared here rather than
 * imported from ./transcript because that module owns `fs`. */
export interface UsageLine {
  type?: string;
  /** Claude Code's per-request id — the dedup key. */
  requestId?: string;
  message?: {
    id?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

/** A fresh zero. A shared constant would be a mutable global that
 * `accumulateUsage` writes through. */
export function zeroUsage(): UsageTotals {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
}

/** The rate ratios between the four classes, not absolute prices. Ratios are
 * stable across Anthropic models, so this never goes stale the way a dollar
 * table would — and it does not claim a dollar amount for a subscription user
 * who paid none. */
const W_INPUT = 1;
const W_CACHE_WRITE = 1.25;
const W_CACHE_READ = 0.1;
const W_OUTPUT = 5;

const num = (v: number | undefined): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Sum usage across `lines` into `into`, skipping any request already in `seen`.
 *
 * Deduplication is a correctness requirement, not a nicety: Claude Code writes
 * one line per content block of a multi-block assistant message and repeats the
 * request's usage on every one of them. On a real 6.1MB transcript, 102 lines
 * carried usage across only 51 unique requestIds — 37 of them repeated up to
 * 4x — and summing naively inflated output tokens 2.44x.
 *
 * `into` and `seen` are mutated and returned so an incremental reader can carry
 * dedup state across chunk boundaries: the duplicate lines of one request are
 * not guaranteed to land in the same read.
 */
export function accumulateUsage(lines: UsageLine[], into: UsageTotals, seen: Set<string>): UsageTotals {
  for (const l of lines) {
    const u = l.message?.usage;
    if (!u) continue;
    // A line with neither id is counted every time. It cannot be deduplicated,
    // and understating spend is the one error this figure must not make.
    const key = l.requestId ?? l.message?.id ?? null;
    if (key !== null) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    into.input += num(u.input_tokens);
    into.output += num(u.output_tokens);
    into.cacheWrite += num(u.cache_creation_input_tokens);
    into.cacheRead += num(u.cache_read_input_tokens);
  }
  return into;
}

/** The one number a card prints: usage re-expressed as input-token equivalents.
 * Not a token count — the unit label is "eq", never "tok". */
export function weightedEq(t: UsageTotals): number {
  return Math.round(
    t.input * W_INPUT + t.cacheWrite * W_CACHE_WRITE + t.cacheRead * W_CACHE_READ + t.output * W_OUTPUT,
  );
}

/** Compact, at most five characters wide so it never pushes a card's footer. */
export function formatEq(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
