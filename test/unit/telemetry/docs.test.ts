import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");

/** Event names as declared in the catalog: `{ name: "x"` literals. */
function catalogEventNames(): string[] {
  const src = fs.readFileSync(path.join(ROOT, "src/telemetry/events.ts"), "utf8");
  return [...new Set([...src.matchAll(/\{\s*name:\s*"([a-z_]+)"/g)].map((m) => m[1]))];
}

describe("docs/TELEMETRY.md", () => {
  it("documents every event in the catalog", () => {
    const doc = fs.readFileSync(path.join(ROOT, "docs/TELEMETRY.md"), "utf8");
    const missing = catalogEventNames().filter((n) => !doc.includes(n));
    expect(missing, `undocumented events: ${missing.join(", ")}`).toEqual([]);
  });

  it("finds a non-trivial catalog to check", () => {
    expect(catalogEventNames().length).toBeGreaterThanOrEqual(10);
  });

  it("states the opt-out and names the setting", () => {
    const doc = fs.readFileSync(path.join(ROOT, "docs/TELEMETRY.md"), "utf8");
    expect(doc).toContain("agentFlow.telemetry.enabled");
    expect(doc).toContain("telemetry.telemetryLevel");
  });
});
