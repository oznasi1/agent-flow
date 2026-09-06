import { describe, it, expect } from "vitest";
import { readLaunchesPerPass, SettingsReader } from "../../src/configReaders";
import { MAX_LAUNCHES_PER_PASS } from "../../src/engine/orchestrator/evaluate";

/** A reader over one `agentFlow.*` value — the shape `readerFor` (headless) and
 * `vscode.WorkspaceConfiguration` (editor) both present. */
const reader = (values: Record<string, unknown>): SettingsReader => ({
  get: <T>(key: string) => values[key] as T | undefined,
});

describe("readLaunchesPerPass", () => {
  it("returns a positive integer as written", () => {
    expect(readLaunchesPerPass(reader({ launchesPerPass: 1 }))).toBe(1);
    expect(readLaunchesPerPass(reader({ launchesPerPass: 7 }))).toBe(7);
  });

  it("reads an absent value as the shipped cap, so an existing install changes nothing", () => {
    expect(readLaunchesPerPass(reader({}))).toBe(MAX_LAUNCHES_PER_PASS);
    expect(MAX_LAUNCHES_PER_PASS).toBe(3);
  });

  // The safer value is the one a bad value lands in: a hand-edited settings.json
  // must never widen the cap to "unbounded" or collapse it to "never fires".
  it.each([
    ["zero", 0],
    ["a negative number", -2],
    ["a fraction", 1.5],
    ["a numeric string", "5"],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["NaN", Number.NaN],
    ["null", null],
    ["a boolean", true],
    ["an array", [4]],
  ])("reads %s as the shipped cap", (_label, value) => {
    expect(readLaunchesPerPass(reader({ launchesPerPass: value }))).toBe(MAX_LAUNCHES_PER_PASS);
  });
});
