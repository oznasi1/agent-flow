import * as path from "path";
import { describe, expect, it } from "vitest";
import { hasAgentWord, scanManifest, scanSources, userFacingStrings, type Hit } from "../_helpers/userFacingStrings";

describe("the user-facing string extractor", () => {
  it("finds plain strings, template chunks and JSX text", () => {
    const src = `
      const a = "3 agents";
      const b = \`\${n} agents open\`;
      const c = <span>One agent</span>;
    `;
    expect(userFacingStrings("f.tsx", src)).toEqual(
      expect.arrayContaining(["3 agents", " agents open", "One agent"]),
    );
  });

  it("ignores comments — they are developer prose, not UI copy", () => {
    const src = `
      // this agent is not a string
      /* neither is this agent */
      /** @see the agent docs */
      const x = 1;
    `;
    expect(userFacingStrings("f.ts", src)).toEqual([]);
  });

  it("ignores module specifiers", () => {
    expect(userFacingStrings("f.ts", `import { p } from "./agentPick";`)).toEqual([]);
  });

  it("ignores string-literal types — those are wire values, not copy", () => {
    const src = `type G = "agents" | "workspaces"; let g: G = "agents";`;
    // The type positions are skipped; the *value* assignment is still reported,
    // because a value is indistinguishable from copy without reading intent.
    expect(userFacingStrings("f.ts", src)).toEqual(["agents"]);
  });

  it("ignores object keys but keeps object values", () => {
    const src = `const m = { "agent": "Agents" };`;
    expect(userFacingStrings("f.ts", src)).toEqual(["Agents"]);
  });

  it("strips the product name before matching", () => {
    expect(hasAgentWord("Agent Flow Deck is ready")).toBe(false);
    expect(hasAgentWord("Agent Flow Deck started an agent")).toBe(true);
  });

  it("matches the agent-word only on word boundaries", () => {
    expect(hasAgentWord("agentProvider")).toBe(false);
    expect(hasAgentWord("agent-flow-base")).toBe(true); // hyphen IS a boundary
    expect(hasAgentWord("3 Agents")).toBe(true);
  });
});

const ROOT = path.join(__dirname, "../..");

/** Every place the agent-word is CORRECT, with the reason. This list is the
 * durable answer to "why does this still say agent here?" — a design artifact,
 * not test scaffolding. Grows as Tasks 2-9 classify each string. */
const LEGITIMATE: { location: string; text: string; why: string }[] = [];

/** Locations not yet converted. Shrinks to empty over Tasks 2-9; the final task
 * deletes this list and its assertion. A location listed here tolerates ANY
 * agent-word text inside it. */
const PENDING_LOCATIONS: string[] = [
  "package.json#agentFlow.agentProvider.enumDescriptions[3]",
  "package.json#agentFlow.agentProvider.markdownDescription",
  "package.json#agentFlow.agentSurface.description",
  "package.json#agentFlow.agentSurface.enumDescriptions[0]",
  "package.json#agentFlow.agentSurface.enumDescriptions[1]",
  "package.json#agentFlow.batchLaunchConfirmThreshold.markdownDescription",
  "package.json#agentFlow.deckGrouping.enumDescriptions[0]",
  "package.json#agentFlow.deckGrouping.enumDescriptions[1]",
  "package.json#agentFlow.deckGrouping.markdownDescription",
  "package.json#agentFlow.exploreSlackDm.markdownDescription",
  "package.json#agentFlow.openAgents.markdownDescription",
  "package.json#agentFlow.orchestrator.markdownDescription",
  "package.json#agentFlow.prReviewAutoFix.description",
  "package.json#agentFlow.prReviewPrompt.markdownDescription",
  "package.json#agentFlow.prReviewStatus.description",
  "package.json#agentFlow.retireClosedAfterHours.markdownDescription",
  "package.json#agentFlow.retireFinishedAfterHours.markdownDescription",
  "package.json#agentFlow.retireInPlaceAfterHours.markdownDescription",
  "package.json#agentFlow.reviewOpenIn.enumDescriptions[1]",
  "package.json#agentFlow.reviewOpenIn.markdownDescription",
  "package.json#agentFlow.reviewRequestMode.markdownDescription",
  "package.json#agentFlow.reviewRequestModes.markdownDescription",
  "package.json#agentFlow.reviewRequestPrompt.markdownDescription",
  "package.json#agentFlow.seedAgent.description",
  "package.json#agentFlow.stampLabelOnWrite.description",
  "package.json#agentFlow.telemetry.enabled.markdownDescription",
  "src/agentPick.ts",
  "src/config.ts",
  "src/deckView.ts",
  "src/engine/claudeAssets.ts",
  "src/engine/diffView.ts",
  "src/engine/orchestrator/armability.ts",
  "src/engine/orchestrator/conditions.ts",
  "src/engine/orchestrator/evaluate.ts",
  "src/engine/runs.ts",
  "src/engine/workspace.ts",
  "src/modesNotice.ts",
  "src/tasksView.ts",
  "src/telemetry/notice.ts",
  "src/webview/App.tsx",
  "src/webview/ClosedStrip.tsx",
  "src/webview/DeckApp.tsx",
  "src/webview/DeckDetail.tsx",
  "src/webview/MarketplaceApp.tsx",
  "src/webview/Notepad.tsx",
  "src/webview/OrchestratorDrawer.tsx",
  "src/webview/ReviewStrip.tsx",
  "src/webview/deckParts.tsx",
  "src/webview/deckSignal.ts",
  "src/webview/orchestratorRule.ts",
];

// Delimited with a NUL byte, which cannot occur in source text or manifest
// JSON strings, so location+text can never collide with a different pair.
const key = (h: { location: string; text: string }) => `${h.location}\u0000${h.text}`;
const allHits = (): Hit[] => [...scanSources(ROOT), ...scanManifest(ROOT)];

describe("the vocabulary gate", () => {
  it("has no agent-word outside the allowlist", () => {
    const allowed = new Set(LEGITIMATE.map(key));
    const pending = new Set(PENDING_LOCATIONS);
    const unexpected = allHits()
      .filter((h) => !allowed.has(key(h)) && !pending.has(h.location))
      .map((h) => `${h.location}: ${JSON.stringify(h.text)}`);
    // A card is a session. If one of these is genuinely correct, add it to
    // LEGITIMATE with a reason; do not add it to PENDING_LOCATIONS.
    expect(unexpected).toEqual([]);
  });

  it("has no dead allowlist entry", () => {
    // Set equality, not subset: an entry that no longer matches anything is as
    // much a failure as an unexpected string. Without this, the allowlist rots
    // into a blanket suppression list.
    const live = new Set(allHits().map(key));
    expect(LEGITIMATE.filter((e) => !live.has(key(e))).map((e) => e.location)).toEqual([]);
  });

  it("has no dead pending entry", () => {
    // Forces PENDING_LOCATIONS to shrink as strings are converted, instead of
    // silently covering a file that no longer needs covering.
    const locations = new Set(allHits().map((h) => h.location));
    expect(PENDING_LOCATIONS.filter((l) => !locations.has(l))).toEqual([]);
  });

  it("states a reason for every allowlist entry", () => {
    expect(LEGITIMATE.filter((e) => e.why.trim().length < 10)).toEqual([]);
  });
});
