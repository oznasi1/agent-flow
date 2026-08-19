import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { CONNECTOR_IDS } from "../../src/tasks/registry";
import { FORGE_IDS } from "../../src/engine/forge/registry";

const read = (p: string) => fs.readFileSync(path.join(__dirname, "../..", p), "utf8");

describe("connector docs", () => {
  it("documents every registered connector", () => {
    const doc = read("docs/CONNECTORS.md");
    for (const id of CONNECTOR_IDS) expect(doc).toContain(`\`${id}\``);
  });

  it("states the compatibility rules a connector author must not break", () => {
    const doc = read("docs/CONNECTORS.md");
    expect(doc).toMatch(/never rename/i);
    expect(doc).toContain("agentFlow.<id>.*");
  });

  it("is linked from CONTRIBUTING", () => {
    expect(read("CONTRIBUTING.md")).toContain("docs/CONNECTORS.md");
  });

  it("records the new setting in the changelog", () => {
    // Deliberately unsliced — the whole file, not the Unreleased section.
    //
    // The property that outlives the release cycle is "the setting is documented in
    // the changelog", not "it currently sits above the topmost version heading". Any
    // slice couples this test to where the entry lives *today*, and this repo's
    // release ritual moves it: `chore: release` inserts `## [0.X.Y] — date` directly
    // below `## [Unreleased]` and leaves the entries beneath the new heading. A slice
    // to a hardcoded `## [0.4.2]` then silently spans the new empty Unreleased plus
    // the shipped section and stops asserting anything; a slice to the next `## [`
    // is worse — it hard-fails inside the release commit itself, plausibly the very
    // commit that ships this work. Do not reinstate either one.
    expect(read("CHANGELOG.md")).toContain("agentFlow.taskSource");
  });

  it("documents every registered forge in docs/FORGES.md", () => {
    const doc = read("docs/FORGES.md");
    for (const id of FORGE_IDS) expect(doc).toContain(`\`${id}\``);
  });
});
