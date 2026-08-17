import { describe, it, expect } from "vitest";
import { accumulateUsage, formatEq, UsageLine, weightedEq, zeroUsage } from "../../../src/engine/usage";

/** One assistant line carrying usage. `rid` is the requestId; omit it to test
 * the message.id fallback. */
const line = (
  usage: Partial<{ input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number }>,
  rid?: string,
  id?: string,
): UsageLine => ({ type: "assistant", ...(rid ? { requestId: rid } : {}), message: { ...(id ? { id } : {}), usage } });

const sum = (lines: UsageLine[]) => accumulateUsage(lines, zeroUsage(), new Set<string>());

describe("accumulateUsage", () => {
  it("sums the four classes into their own fields", () => {
    const t = sum([line({ input_tokens: 2, output_tokens: 100, cache_creation_input_tokens: 30, cache_read_input_tokens: 4000 }, "r1")]);
    expect(t).toEqual({ input: 2, output: 100, cacheWrite: 30, cacheRead: 4000 });
  });

  // Claude Code writes one line per content block of a multi-block assistant
  // message, and every line repeats the request's usage. A real 6.1MB transcript
  // had 102 such lines across 51 requestIds — naive summing inflated output 2.44x.
  it("counts a repeated requestId exactly once", () => {
    const dup = line({ output_tokens: 421, cache_creation_input_tokens: 57538 }, "req_A");
    const t = sum([dup, dup, dup, dup]);
    expect(t.output).toBe(421);
    expect(t.cacheWrite).toBe(57538);
  });

  it("still counts distinct requestIds", () => {
    const t = sum([line({ output_tokens: 10 }, "r1"), line({ output_tokens: 5 }, "r2")]);
    expect(t.output).toBe(15);
  });

  it("falls back to message.id when there is no requestId", () => {
    const a = line({ output_tokens: 7 }, undefined, "msg_1");
    const t = sum([a, a]);
    expect(t.output).toBe(7);
  });

  // Cannot be deduplicated, so it must be counted — dropping it would understate
  // spend, which is the one direction this figure must never err in.
  it("counts a line with neither requestId nor message.id every time", () => {
    const a = line({ output_tokens: 3 });
    const t = sum([a, a]);
    expect(t.output).toBe(6);
  });

  it("ignores lines with no usage object", () => {
    const t = sum([{ type: "user" }, { type: "assistant", message: {} }, line({ output_tokens: 9 }, "r1")]);
    expect(t.output).toBe(9);
  });

  it("defaults missing usage fields to 0 rather than NaN", () => {
    const t = sum([line({ output_tokens: 5 }, "r1")]);
    expect(t.input).toBe(0);
    expect(t.cacheRead).toBe(0);
    expect(Number.isNaN(t.cacheWrite)).toBe(false);
  });

  // Transcript lines are written by another program. This guard defends against
  // non-numeric values that TypeScript would not permit but the filesystem can
  // produce: NaN, Infinity, or a string. The entire `num` guard would be removed
  // if this test did not exist.
  it("guards against non-numeric values in usage fields", () => {
    const malformed = {
      type: "assistant",
      requestId: "r1",
      message: {
        usage: {
          input_tokens: NaN,
          output_tokens: Infinity,
          cache_creation_input_tokens: "not a number" as unknown as number,
          cache_read_input_tokens: 5,
        },
      },
    } as unknown as UsageLine;
    const t = sum([malformed]);
    expect(t.input).toBe(0);
    expect(t.output).toBe(0);
    expect(t.cacheWrite).toBe(0);
    expect(t.cacheRead).toBe(5);
    expect(Number.isFinite(t.input)).toBe(true);
    expect(Number.isFinite(t.output)).toBe(true);
    expect(Number.isFinite(t.cacheWrite)).toBe(true);
    expect(Number.isFinite(t.cacheRead)).toBe(true);
  });

  it("accumulates into the totals and seen set it is given, so a caller can resume", () => {
    const into = zeroUsage();
    const seen = new Set<string>();
    accumulateUsage([line({ output_tokens: 4 }, "r1")], into, seen);
    accumulateUsage([line({ output_tokens: 4 }, "r1"), line({ output_tokens: 6 }, "r2")], into, seen);
    expect(into.output).toBe(10);
    expect(seen.size).toBe(2);
  });
});

describe("weightedEq", () => {
  // Ratios between Anthropic's published rates: cache reads are ~0.1x input and
  // 96.7% of raw tokens, so a raw sum ranks cards by conversation length.
  it("weights input 1x, cache-write 1.25x, cache-read 0.1x, output 5x", () => {
    expect(weightedEq({ input: 100, output: 100, cacheWrite: 100, cacheRead: 100 })).toBe(100 + 500 + 125 + 10);
  });

  it("is 0 for zero usage", () => {
    expect(weightedEq(zeroUsage())).toBe(0);
  });

  it("rounds to a whole number", () => {
    expect(weightedEq({ input: 0, output: 0, cacheWrite: 0, cacheRead: 5 })).toBe(1);
  });
});

describe("formatEq", () => {
  it("prints hundreds as-is", () => {
    expect(formatEq(842)).toBe("842");
  });

  it("prints thousands with k", () => {
    expect(formatEq(380_400)).toBe("380k");
  });

  it("prints millions with one decimal", () => {
    expect(formatEq(12_428_708)).toBe("12.4M");
  });

  it("rounds up into k at the boundary", () => {
    expect(formatEq(999_500)).toBe("1000k");
  });

  // Pins the k→M threshold at 1,000,000. The Deck's header total for a busy
  // board lands in the 1M–10M range; changing the threshold to n < 10_000_000
  // would render this as "2400k" instead of "2.4M", a user-visible regression.
  // Without this case, such a threshold mutation survived all tests.
  it("switches to M format at 1M", () => {
    expect(formatEq(2_400_000)).toBe("2.4M");
  });
});
