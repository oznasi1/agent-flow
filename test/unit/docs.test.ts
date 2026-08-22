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

  // Same property, and same deliberately-unsliced read, as the taskSource
  // assertion above — see its comment for why no slice may be reinstated. That
  // precedent exists precisely to stop a whole new user-facing seam shipping with
  // an empty Unreleased section, which is exactly what happened here.
  it("records the forge setting in the changelog", () => {
    expect(read("CHANGELOG.md")).toContain("agentFlow.forge");
  });

  it("is linked from both CONTRIBUTING and the README, as docs/CONNECTORS.md is", () => {
    expect(read("CONTRIBUTING.md")).toContain("docs/FORGES.md");
    expect(read("README.md")).toContain("docs/FORGES.md");
  });
});

describe("vocabulary note", () => {
  // The session/agent split (test/unit/vocabulary.test.ts) is only durable if the
  // next contributor inherits the convention instead of rediscovering it — the note
  // is meant to be the same words in both files, not just "a mention". A byte-exact
  // check catches one file's copy quietly drifting or being dropped on an edit,
  // the same failure mode this whole suite guards against for settings and forges.
  const NOTE = [
    '- **Vocabulary.** A **session** is one run of a coding tool — one Deck card, one',
    '  row in `run.agents[]`. An **agent** is a worker a session delegates to (the',
    "  Marketplace's Agents tab, `.claude/agents/`). The tool itself is named",
    '  — "Review with Claude Code" — never called "the agent". Identifiers, setting',
    '  ids, stored values and orchestrator condition keys keep their released',
    '  spelling, so the code says `agents` where the UI says sessions.',
    '  `test/unit/vocabulary.test.ts` enforces this; its allowlist records every',
    '  place "agent" is still correct.',
  ].join("\n");

  it("is present, word for word, in both CONTRIBUTING.md and CLAUDE.md", () => {
    expect(read("CONTRIBUTING.md")).toContain(NOTE);
    expect(read("CLAUDE.md")).toContain(NOTE);
  });
});
