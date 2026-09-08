import { describe, it, expect } from "vitest";
import { readCommands, readLaunchesPerPass, SettingsReader } from "../../src/configReaders";
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

describe("readCommands — env and timeoutMs", () => {
  const one = (extra: Record<string, unknown>) => readCommands(reader({ commands: [{ id: "d", run: "deploy.sh", ...extra }] }))[0];

  it("reads a string-valued env object and a positive integer timeoutMs as written", () => {
    expect(one({ env: { AWS_PROFILE: "prod" }, timeoutMs: 600_000 })).toEqual({
      id: "d", label: "d", run: "deploy.sh", env: { AWS_PROFILE: "prod" }, timeoutMs: 600_000,
    });
  });

  // No key at all, not `undefined`: the shape of a command written before these
  // fields existed must be byte-identical to what it was.
  it("leaves both keys off a command that sets neither", () => {
    expect(one({})).toEqual({ id: "d", label: "d", run: "deploy.sh" });
  });

  // A value this reader coerced would reach the shell as something the user never
  // wrote; dropping it is the safer failure.
  it("drops non-string env values and blank names, and reads an env left empty as absent", () => {
    expect(one({ env: { PORT: 8080, OK: "yes", "  ": "blank", FLAG: true } })).toEqual({ id: "d", label: "d", run: "deploy.sh", env: { OK: "yes" } });
    expect(one({ env: { PORT: 8080 } })).toEqual({ id: "d", label: "d", run: "deploy.sh" });
    expect(one({ env: ["A=b"] })).toEqual({ id: "d", label: "d", run: "deploy.sh" });
    expect(one({ env: "A=b" })).toEqual({ id: "d", label: "d", run: "deploy.sh" });
  });

  it.each([
    ["zero", 0],
    ["a negative number", -1],
    ["a fraction", 1.5],
    ["a numeric string", "5000"],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["NaN", Number.NaN],
    ["null", null],
  ])("reads a timeoutMs of %s as unset, so the default deadline applies", (_label, value) => {
    expect(one({ timeoutMs: value })).toEqual({ id: "d", label: "d", run: "deploy.sh" });
  });
});
