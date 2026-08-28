/** The vocabulary gate. A Deck card is a "session"; an "agent" is a worker a
 * session delegates to; the tool is named, never called "the agent". Every
 * user-facing string in src/ and package.json is scanned, and every surviving
 * agent-word must be in LEGITIMATE with a stated reason. Set equality both
 * ways: an unexpected string fails, and so does a dead allowlist entry — which
 * is what stops this list rotting into a blanket suppression list.
 * See docs/superpowers/specs/2026-08-22-deck-session-semantics-design.md. */
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
    expect(userFacingStrings("f.ts", `import { p } from "./agent-flow-base";`)).toEqual([]);
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
const LEGITIMATE: { location: string; text: string; why: string }[] = [
  { location: "src/webview/deckParts.tsx", text: "c-agents",
    why: "CSS class name, an identifier in the stylesheet — renaming it is a style change, not a copy change" },
  { location: "src/webview/DeckApp.tsx", text: "agents",
    why: "the value persisted to agentFlow.deckGrouping and read back by every existing install — the UI label beside it says Sessions" },
  // Task 8: the scanManifest `default` extension surfaces this — it's the same
  // wire value as the DeckApp.tsx entry above, just read from the manifest's
  // own default instead of the code path that normalizes it.
  { location: "package.json#agentFlow.deckGrouping.default", text: "agents",
    why: "the manifest's stored default for agentFlow.deckGrouping — the same persisted wire value as the DeckApp.tsx entry above, not copy" },
  // Task 6: orchestrator condition keys. Serialized into flow files under
  // ~/.agentflow/flows and shared across windows — renaming any of them
  // silently breaks every saved flow. Only the labels beside them changed.
  { location: "src/engine/orchestrator/armability.ts", text: "agent-ended-turn",
    why: "condition key serialized into ~/.agentflow/flows — renaming it breaks every saved flow" },
  { location: "src/engine/orchestrator/armability.ts", text: "agent-idle-over", why: "condition key, as above" },
  { location: "src/engine/orchestrator/conditions.ts", text: "agent-ended-turn", why: "condition key, as above" },
  { location: "src/engine/orchestrator/conditions.ts", text: "agent-idle-over", why: "condition key, as above" },
  { location: "src/engine/orchestrator/conditions.ts", text: "no-agent-left", why: "condition key, as above" },
  { location: "src/engine/orchestrator/evaluate.ts", text: "agent-ended-turn", why: "condition key, as above" },
  { location: "src/engine/orchestrator/evaluate.ts", text: "agent-idle-over", why: "condition key, as above" },
  { location: "src/engine/orchestrator/evaluate.ts", text: "agent-state-unknown",
    why: "a blocked-reason code recorded for diagnostics, not rendered to the user — result.blocked has no reader in deckView.ts or any webview" },
  { location: "src/webview/orchestratorRule.ts", text: "agent-idle-over", why: "condition key, as above" },
  { location: "src/webview/CondParams.tsx", text: "agent-idle-over", why: "condition key, as above" },
  // Task 7: host-side wire values and subagent references.
  { location: "src/config.ts", text: "agents",
    why: "the agentFlow.deckGrouping value normalized here — the stored setting, not copy" },
  { location: "src/engine/workspace.ts", text: "cursor-agent",
    why: "the name of Cursor's CLI binary" },
  { location: "src/engine/workspace.ts", text: "agent",
    why: "the chat `mode` argument passed to the editor's own open-chat command" },
  { location: "src/engine/claudeAssets.ts", text: "agents",
    why: "the `.claude/agents` directory name on disk" },
  { location: "src/engine/claudeAssets.ts", text: "agent",
    why: "the AssetType wire value for a subagent" },
  { location: "src/engine/claudeAssets.ts", text: "Skills, commands, agents and hooks outside any plugin.",
    why: "agents in the vocabulary's own sense — subagents a session delegates to" },
  { location: "src/engine/diffView.ts", text: "agent-flow-base",
    why: "a git ref name" },
  { location: "src/modesNotice.ts", text: "https://github.com/oznasi1/agent-flow/blob/main/CHANGELOG.md",
    why: "the repository URL" },
  { location: "src/telemetry/notice.ts", text: "https://github.com/oznasi1/agent-flow/blob/main/docs/TELEMETRY.md",
    why: "the repository URL" },
  { location: "src/tasksView.ts", text: "e.g. the deck-agents-view task",
    why: "an example branch name in a placeholder, not the noun" },
  // Task 6: explore_completed's cancel_point wire value naming the step where
  // openWorkspace's own agent picker was dismissed — a telemetry enum member
  // passed as a value (not a type position), same class of hit as the
  // orchestrator condition keys above.
  { location: "src/tasksView.ts", text: "agent",
    why: "the explore_completed cancel_point wire value for the agent-picker step, not copy" },
  { location: "src/webview/MarketplaceApp.tsx", text: "agent",
    why: "the AssetType wire value for a subagent" },
  // Task 8: marketplace_opened's `agents` count groups view.assets by this same
  // released AssetType wire value — same class of hit as the claudeAssets.ts and
  // MarketplaceApp.tsx entries above, just read from the telemetry counter.
  { location: "src/marketplaceView.ts", text: "agent",
    why: "the AssetType wire value for a subagent, compared in countsOf's marketplace_opened counter" },
  { location: "src/webview/MarketplaceApp.tsx", text: "Agents",
    why: "the Marketplace tab listing subagents — the one correct use of the word" },
  { location: "src/webview/MarketplaceApp.tsx", text: "Search skills, commands, agents, hooks…",
    why: "searches subagents among the other asset types" },
  // Fix round 1: the five "Review with your agent tool" review-setting entries
  // that used to live here are gone. That phrase described a button that does
  // not exist — the real button always names a concrete tool via
  // `providerLabel()` (src/config.ts) and is never a generic phrase. Manifest
  // prose now uses the "Review with …" ellipsis caption instead, which no
  // longer contains the agent-word at all, so those five settings need no
  // allowlist entry any more (confirmed via scanManifest: only
  // deckGrouping.default and telemetry.enabled.markdownDescription remain).
  // Task 8: same repository-URL pattern as the two LEGITIMATE entries above
  // for src/modesNotice.ts and src/telemetry/notice.ts — the hyphen in
  // "agent-flow" bounds "agent" as a standalone word to the regex.
  { location: "package.json#agentFlow.telemetry.enabled.markdownDescription", text: "Send anonymous usage and error events (which features are used, where flows are abandoned, what fails) to help decide what to build next. Never includes repo names, ticket keys, file paths, prompt text or error messages — see [TELEMETRY.md](https://github.com/oznasi1/agent-flow/blob/main/docs/TELEMETRY.md). VS Code's own `#telemetry.telemetryLevel#` setting is honoured regardless of this one.",
    why: "the repository URL (github.com/oznasi1/agent-flow) contains the hyphen-bounded word \"agent\" — same class of hit as the repository-URL entries above" },
];

// Delimited with a NUL byte, which cannot occur in source text or manifest
// JSON strings, so location+text can never collide with a different pair.
const key = (h: { location: string; text: string }) => `${h.location}\u0000${h.text}`;
const allHits = (): Hit[] => [...scanSources(ROOT), ...scanManifest(ROOT)];

describe("the vocabulary gate", () => {
  it("has no agent-word outside the allowlist", () => {
    const allowed = new Set(LEGITIMATE.map(key));
    const unexpected = allHits()
      .filter((h) => !allowed.has(key(h)))
      .map((h) => `${h.location}: ${JSON.stringify(h.text)}`);
    // A card is a session. If one of these is genuinely correct, add it to
    // LEGITIMATE with a reason.
    expect(unexpected).toEqual([]);
  });

  it("has no dead allowlist entry", () => {
    // Set equality, not subset: an entry that no longer matches anything is as
    // much a failure as an unexpected string. Without this, the allowlist rots
    // into a blanket suppression list.
    const live = new Set(allHits().map(key));
    expect(LEGITIMATE.filter((e) => !live.has(key(e))).map((e) => e.location)).toEqual([]);
  });

  it("states a reason for every allowlist entry", () => {
    expect(LEGITIMATE.filter((e) => e.why.trim().length < 10)).toEqual([]);
  });
});
