import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { CONNECTOR_IDS } from "../../src/tasks/registry";

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

  it("records the new setting under Unreleased", () => {
    const changelog = read("CHANGELOG.md");
    const start = changelog.indexOf("## [Unreleased]");
    // To the NEXT version heading, whatever it is called — not to a hardcoded
    // `## [0.4.2]`. Slicing to a named release makes this assertion stop testing
    // anything the moment Unreleased is cut: the slice would then span the new
    // (empty) Unreleased plus the shipped section that still contains the string,
    // and it would hard-fail the day that heading is pruned from the file.
    const next = changelog.indexOf("\n## [", start + 1);
    const unreleased = changelog.slice(start, next === -1 ? undefined : next);
    expect(unreleased).toContain("agentFlow.taskSource");
  });
});
