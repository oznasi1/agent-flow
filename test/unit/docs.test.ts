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

/** The `### You cannot` list in docs/ORCHESTRATOR_COMMANDS.md, asserted against the
 * code it describes. The page opens by promising it is the complete, accurate
 * account and that the code wins when they disagree — and five of its entries once
 * described limits four releases had already removed, talking users out of features
 * that existed. Each assertion below pairs a code fact (read from source, the way
 * suggestions.test.ts pins message literals) with the sentence the list may no
 * longer say while that fact holds. Removing the feature fails the premise line,
 * so the test says which half moved. */
describe("orchestrator cannot-list", () => {
  const doc = read("docs/ORCHESTRATOR_COMMANDS.md");
  const section = (from: string, to: string) => {
    const start = doc.indexOf(from);
    const end = doc.indexOf(to, start);
    expect(start, from).toBeGreaterThan(-1);
    expect(end, to).toBeGreaterThan(start);
    return doc.slice(start, end);
  };
  const cannot = section("### You cannot", "## Numbers");
  const can = section("### You can", "### You cannot");

  it("no longer says the parameterised conditions have no picker, while CondParams renders one", () => {
    const params = read("src/webview/CondParams.tsx");
    for (const kind of ["branch-ci-passed", "agent-idle-over", "ticket-status-is"]) expect(params).toContain(`case "${kind}"`);
    expect(cannot).not.toMatch(/no picker asks/i);
    expect(cannot).not.toMatch(/hand-written in the flow file/i);
    expect(can).toMatch(/branch CI passed/);
  });

  it("no longer says the directory cannot be chosen, while the node inspector has a cwdRepo control", () => {
    expect(read("src/webview/OrchestratorDrawer.tsx")).toContain("value={nodeInsp.cwdRepo ?? \"\"}");
    expect(cannot).not.toMatch(/choose the directory/i);
    expect(can).toMatch(/cwdRepo/);
  });

  it("no longer says join is always any, while the model has all and the drawer a JOINS select", () => {
    expect(read("src/engine/orchestrator/model.ts")).toContain('export type JoinMode = "any" | "all";');
    expect(read("src/webview/OrchestratorDrawer.tsx")).toContain("JOIN_LABEL[j]");
    expect(cannot).not.toMatch(/join.*always/i);
    expect(cannot).not.toMatch(/wait for several conditions/i);
    expect(can).toMatch(/several conditions/i);
  });

  it("no longer says a command returns nothing to the flow, while printed… and reported… exist", () => {
    const model = read("src/engine/orchestrator/model.ts");
    expect(model).toMatch(/kind: "command-printed"/);
    expect(model).toMatch(/kind: "command-result"/);
    expect(cannot).not.toMatch(/return data to the flow/i);
    expect(cannot).not.toMatch(/see only succeeded or failed/i);
    expect(can).toMatch(/the command printed/);
  });

  it("no longer says a failed rule is never retried, while FlowEdge carries an opt-in retry", () => {
    expect(read("src/engine/orchestrator/model.ts")).toMatch(/^\s*retry\?:/m);
    expect(cannot).not.toMatch(/retry automatically/i);
    expect(can).toMatch(/RETRY/);
  });

  it("no longer says the environment and the deadline are fixed, while FlowCommand carries env and timeoutMs", () => {
    const types = read("src/types.ts");
    expect(types).toMatch(/env\?: Record<string, string>;/);
    expect(types).toMatch(/timeoutMs\?: number;/);
    expect(cannot).not.toMatch(/control the environment/i);
    expect(cannot).not.toMatch(/exceed two minutes/i);
    expect(can).toMatch(/timeoutMs/);
    expect(can).toMatch(/\benv\b/);
  });

  it("still lists the limits the code does have", () => {
    // `dist/tick.js` refuses launch, seed and ask (src/headless/main.ts).
    expect(read("src/headless/main.ts")).toMatch(/needs an editor, left pending/);
    expect(cannot).toMatch(/with the Deck closed/i);
    // One holder per pass (lock.ts).
    expect(cannot).toMatch(/two windows share the work/i);
    // Env and the deadline live on a CONFIGURED command only (command.ts).
    expect(read("src/engine/orchestrator/command.ts")).toMatch(/Only a CONFIGURED command carries these/);
    expect(cannot).toMatch(/free-text/i);
  });
});
