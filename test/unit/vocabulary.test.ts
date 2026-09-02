/** The vocabulary gate. A Deck card is a "session"; an "agent" is a worker a
 * session delegates to; the tool is named, never called "the agent". Every
 * user-facing string in src/ and package.json is scanned, and every surviving
 * agent-word must be in LEGITIMATE with a stated reason. Set equality both
 * ways: an unexpected string fails, and so does a dead allowlist entry — which
 * is what stops this list rotting into a blanket suppression list.
 * See docs/superpowers/specs/2026-08-22-deck-session-semantics-design.md. */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import {
  allUiStrings,
  functionSource,
  hasAgentWord,
  hasFlowWord,
  jsxBlockAround,
  scanManifest,
  scanSources,
  userFacingStrings,
  type Hit,
} from "../_helpers/userFacingStrings";

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

  it("matches the flow-word only on word boundaries", () => {
    // "Workflow"/"Workflows" have no boundary before "flow" — the preceding
    // letter is a word character too — so the UI's correct noun never trips
    // this on its own, the same way "agentProvider" never trips hasAgentWord.
    expect(hasFlowWord("Workflow")).toBe(false);
    expect(hasFlowWord("Workflows")).toBe(false);
    expect(hasFlowWord("flow-templates")).toBe(true); // hyphen IS a boundary
    expect(hasFlowWord("3 flows")).toBe(true);
  });

  it("the flow-word match cannot itself tell a wrong label from a right one — only the allowlist can", () => {
    // The real regression this gate exists to catch: a Templates-tab tablist
    // shipped as `aria-label="Flow list"` (b65f8f4) and was fixed to
    // "Workflow list" only later (8d6ec5b). The pre-existing Canvas/List
    // toggle's `aria-label="Flow view"` is legitimate — a different control,
    // on the flow-graph canvas, that predates this feature entirely. Both
    // strings carry the same bare word, so `hasFlowWord` flags both alike;
    // see the "template/workflow gate" describe below for how FLOW_LEGITIMATE
    // is what actually tells them apart — by requiring a stated reason for
    // "Flow view" while leaving no such entry for "Flow list" to hide behind.
    expect(hasFlowWord("Flow list")).toBe(true);
    expect(hasFlowWord("Flow view")).toBe(true);
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
  // Task 1 (built-in starters): the shipped templates encode the same
  // released condition key, three times over — one per starter that uses it.
  { location: "src/engine/orchestrator/starters.ts", text: "agent-ended-turn", why: "condition key, as above" },
  // Task 7: host-side wire values and subagent references.
  { location: "src/config.ts", text: "agents",
    why: "the agentFlow.deckGrouping value normalized here — the stored setting, not copy" },
  // Fix wave: deck_action.grouping validates a webview-fed value against this
  // same persisted wire value before letting it ride the event — same class of
  // hit as the src/config.ts entry above, just the membership check site.
  { location: "src/deckView.ts", text: "agents",
    why: "the agentFlow.deckGrouping wire value, validated here before deck_action.grouping sends it — not copy" },
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

// ── Task 14: the template/workflow gate ──────────────────────────────────
//
// Card workflows added a second vocabulary rule (design doc
// 2026-09-01-card-workflows-and-drawer-design.md §1): **Template** is the
// reusable shape, **Workflow** is a template attached to one card, and a
// template has no verbs in common with a workflow — it cannot be armed,
// disarmed or detached, because it has no ticket and nothing to watch.
//
// The scan is deliberately NOT repo-wide the way the agent-word gate is.
// `src/webview/OrchestratorDrawer.tsx` is the pre-existing flow-graph canvas —
// it manages `Flow` objects generically, including ones bound to no card at
// all, and its own header literally reads "Orchestrator". Relabelling that
// whole screen is not this feature's job, and every "flow"/"Flow" string in
// it below predates this feature (verified against the branch's merge-base
// with main). What DOES have to hold the new line are the two surfaces this
// feature actually built: the card drawer's workflow block (`WorkflowBlock.tsx`,
// `DeckDetail.tsx`) must never call what it shows a "flow", and the Templates
// tab this feature added to `OrchestratorDrawer.tsx` must never offer a
// template a workflow verb.
const FLOW_WORKFLOW_FILES = ["src/webview/WorkflowBlock.tsx", "src/webview/DeckDetail.tsx"];
const FLOW_SCAN_FILES = [...FLOW_WORKFLOW_FILES, "src/webview/OrchestratorDrawer.tsx"];

const flowHitsIn = (files: string[]): Hit[] => {
  const hits: Hit[] = [];
  for (const location of files) {
    const text = fs.readFileSync(path.join(ROOT, location), "utf8");
    for (const s of allUiStrings(location, text)) if (hasFlowWord(s)) hits.push({ location, text: s });
  }
  return hits;
};

/** Every place the flow-word is correct in the three scanned files, with the
 * reason — same discipline, same set-equality checks, as LEGITIMATE above. */
const FLOW_LEGITIMATE: { location: string; text: string; why: string }[] = [
  // src/webview/DeckDetail.tsx: message-type wire values sent to the host.
  // Same class of hit as the orchestrator condition keys in LEGITIMATE above —
  // a value the code and the host must agree on byte-for-byte, not copy a
  // reader sees. `flow:attach`/`flow:detach`/`flow:openOutput` are new to this
  // feature; `flow:arm`/`flow:answerGate`/`flow:resetEdge` predate it.
  { location: "src/webview/DeckDetail.tsx", text: "flow:arm", why: "message type sent to the host, a wire value" },
  { location: "src/webview/DeckDetail.tsx", text: "flow:detach", why: "message type sent to the host, a wire value" },
  { location: "src/webview/DeckDetail.tsx", text: "flow:answerGate",
    why: "message type sent to the host, a wire value" },
  { location: "src/webview/DeckDetail.tsx", text: "flow:resetEdge",
    why: "message type sent to the host, a wire value" },
  { location: "src/webview/DeckDetail.tsx", text: "flow:attach", why: "message type sent to the host, a wire value" },
  { location: "src/webview/DeckDetail.tsx", text: "flow:openOutput",
    why: "message type sent to the host, a wire value" },
  // src/webview/OrchestratorDrawer.tsx: message-type wire values, same class
  // as above. `flow:saveTemplate`/`flow:duplicateTemplate`/`flow:renameTemplate`/
  // `flow:deleteTemplate` are new to this feature; the rest predate it.
  { location: "src/webview/OrchestratorDrawer.tsx", text: "flow:saveCommand",
    why: "message type sent to the host, a wire value" },
  { location: "src/webview/OrchestratorDrawer.tsx", text: "flow:addPlanned",
    why: "message type sent to the host, a wire value" },
  { location: "src/webview/OrchestratorDrawer.tsx", text: "flow:answerGate",
    why: "message type sent to the host, a wire value" },
  { location: "src/webview/OrchestratorDrawer.tsx", text: "flow:dryRun",
    why: "message type sent to the host, a wire value" },
  { location: "src/webview/OrchestratorDrawer.tsx", text: "flow:saveTemplate",
    why: "message type sent to the host, a wire value" },
  { location: "src/webview/OrchestratorDrawer.tsx", text: "flow:duplicateTemplate",
    why: "message type sent to the host, a wire value" },
  { location: "src/webview/OrchestratorDrawer.tsx", text: "flow:renameTemplate",
    why: "message type sent to the host, a wire value" },
  { location: "src/webview/OrchestratorDrawer.tsx", text: "flow:deleteTemplate",
    why: "message type sent to the host, a wire value" },
  // src/webview/OrchestratorDrawer.tsx: the flow-graph canvas's own
  // pre-existing copy, confirmed present at this branch's merge-base with
  // main — none of it was touched by this feature, and none of it is the
  // card-facing "workflow" surface the new vocabulary rule governs.
  { location: "src/webview/OrchestratorDrawer.tsx", text: "orch-flows",
    why: "CSS class name, an identifier in the stylesheet — renaming it is a style change, not a copy change" },
  { location: "src/webview/OrchestratorDrawer.tsx", text: " Flows · ",
    why: "pre-existing eyebrow toggle on the flow-graph canvas (predates this feature), not the card's workflow block" },
  { location: "src/webview/OrchestratorDrawer.tsx", text: " Delete flow ",
    why: "pre-existing canvas header button (predates this feature) — deletes a Flow object, the canvas's own noun" },
  { location: "src/webview/OrchestratorDrawer.tsx", text: "Flow view",
    why: "pre-existing Canvas/List toggle label (predates this feature); this is the ONE label this task's own code comment " +
      "in OrchestratorDrawer.tsx says is deliberately left alone, distinct from the sibling Templates-tab tablist that " +
      "must say Workflow" },
  { location: "src/webview/OrchestratorDrawer.tsx", text: "Flow name",
    why: "pre-existing rename field on the flow-graph canvas (predates this feature)" },
  { location: "src/webview/OrchestratorDrawer.tsx", text: "+ New flow",
    why: "pre-existing Running-tab button (predates this feature) — creates a bare Flow, not a card workflow" },
];

describe("the template/workflow gate", () => {
  it("the UI never calls a workflow a flow", () => {
    // Same discipline as session/agent: the code says `Flow`, the card's own
    // UI says Workflow. Message names and pre-existing canvas copy are
    // allowlisted with a reason, same mechanism as the agent-word gate.
    const allowed = new Set(FLOW_LEGITIMATE.map(key));
    const unexpected = flowHitsIn(FLOW_SCAN_FILES)
      .filter((h) => !allowed.has(key(h)))
      .map((h) => `${h.location}: ${JSON.stringify(h.text)}`);
    expect(unexpected).toEqual([]);
  });

  it("has no dead entry in the flow-word allowlist", () => {
    const live = new Set(flowHitsIn(FLOW_SCAN_FILES).map(key));
    expect(FLOW_LEGITIMATE.filter((e) => !live.has(key(e))).map((e) => e.location)).toEqual([]);
  });

  it("states a reason for every flow-word allowlist entry", () => {
    expect(FLOW_LEGITIMATE.filter((e) => e.why.trim().length < 10)).toEqual([]);
  });

  it("the UI never offers a template a workflow verb", () => {
    // A Templates row offering Detach, or a template being armed, is a
    // category error the reader has to untangle: a template has no ticket
    // and nothing to watch (design doc §1).
    //
    // A first version of this test looked for one STRING containing both
    // "template" and a verb — which a bare `Detach` button dropped into
    // `TemplateRow` (the component that renders a template's own row of
    // controls) would sail straight through, since neither "Detach" nor any
    // sibling string in that button would need to mention "template" at all.
    // Scoping by REGION instead of by a string's own content is what catches
    // that: everything inside `TemplateRow`'s own render body is per-template
    // controls by construction, so any verb found there is a verb offered to
    // a template, whatever the string itself says.
    //
    // Two regions, because a stray verb button could land either inside the
    // row component or as a sibling of it in the surrounding Templates-tab
    // markup (the `orch-tmpl-list` wrapper — the empty state, or a future
    // tab-level action):
    const location = "src/webview/OrchestratorDrawer.tsx";
    const source = fs.readFileSync(path.join(ROOT, location), "utf8");
    const regions = [
      functionSource(location, source, "TemplateRow"),
      jsxBlockAround(location, source, "orch-tmpl-list"),
    ];
    const offenders = regions.flatMap((region) => allUiStrings(location, region))
      .filter((s) => /\b(arm|disarm|detach)\b/i.test(s));
    expect(offenders).toEqual([]);
  });
});
