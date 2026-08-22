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
  { location: "src/webview/MarketplaceApp.tsx", text: "agent",
    why: "the AssetType wire value for a subagent" },
  { location: "src/webview/MarketplaceApp.tsx", text: "Agents",
    why: "the Marketplace tab listing subagents — the one correct use of the word" },
  { location: "src/webview/MarketplaceApp.tsx", text: "Search skills, commands, agents, hooks…",
    why: "searches subagents among the other asset types" },
  // Task 8: the manifest has no way to interpolate the configured tool's name
  // into generic prose, so these four review settings name the category of
  // tool instead of a specific one. "agent tool" means "the AI coding tool
  // configured via agentFlow.agentProvider" — a category, not a running
  // session and not a subagent. The Deck's actual button renders the real
  // tool name ("Review with Claude Code"); only this manifest prose is generic.
  { location: "package.json#agentFlow.reviewRequestModes.markdownDescription", text: "Seed modes offered by **Review with your agent tool** on the Deck's review strip. Each has an `id`, `label`, `prompt` template, and an optional `detail` line shown under the label in the picker. Placeholders: `{repo}` `{number}` `{author}` `{key}` `{summary}` `{url}` `{brief}` `{files}`. Add your own — e.g. separate backend and frontend review modes — and clicking **Review with your agent tool** asks which to use, since your entry joins the built-in **Full review** rather than replacing it. Pin one with `#agentFlow.reviewRequestMode#` to skip the question. Your entries **layer over** the built-in modes rather than replacing them: reuse a built-in `id` to override just the fields you set, use a new `id` to add a mode, and `{\"id\": \"full\", \"hidden\": true}` to drop a built-in. Modes you don't list are appended, so built-ins added in a later release still reach you. Under `#agentFlow.forge#: gitlab` the built-in **Full review** mode carries an equivalent GitLab-flavoured prompt, unless you have overridden that mode's `prompt` yourself.",
    why: "\"agent tool\" names the category of tool configured via agentFlow.agentProvider, not a running session or a subagent — see the block comment above" },
  { location: "package.json#agentFlow.reviewRequestMode.markdownDescription", text: "Which review mode to seed when you click **Review with your agent tool**: `ask` to choose each time, or the `id` of one of `#agentFlow.reviewRequestModes#`. A stock install has one mode and shows no picker; add or hide modes so only one is left and the picker stays away.",
    why: "\"agent tool\" names the category of tool configured via agentFlow.agentProvider, not a running session or a subagent — see the block comment above" },
  { location: "package.json#agentFlow.reviewOpenIn.markdownDescription", text: "Where **Review with your agent tool** opens: a new window on the review worktree (the default, and what every release so far did), this window, a `.code-workspace` you already have, or `ask` to choose each time — the same question `#agentFlow.openIn#` asks for a task you take, kept separate because a review is a shorter errand. The review always runs in its own git worktree whichever you pick; a destination other than a new window seeds a session that is told to work in that worktree by absolute path.",
    why: "\"agent tool\" names the category of tool configured via agentFlow.agentProvider, not a running session or a subagent — see the block comment above" },
  { location: "package.json#agentFlow.reviewOpenIn.enumDescriptions[1]", text: "Ask each time you click Review with your agent tool",
    why: "\"agent tool\" names the category of tool configured via agentFlow.agentProvider, not a running session or a subagent — see the block comment above" },
  { location: "package.json#agentFlow.reviewRequestPrompt.markdownDescription", text: "Prompt seeded when you launch **Review with your agent tool** on a review request. Empty uses the built-in default. Placeholders: `{repo}` `{number}` `{author}` `{key}` `{summary}` `{url}` `{brief}` `{files}`.",
    why: "\"agent tool\" names the category of tool configured via agentFlow.agentProvider, not a running session or a subagent — see the block comment above" },
  // Task 8: same repository-URL pattern as the two LEGITIMATE entries above
  // for src/modesNotice.ts and src/telemetry/notice.ts — the hyphen in
  // "agent-flow" bounds "agent" as a standalone word to the regex.
  { location: "package.json#agentFlow.telemetry.enabled.markdownDescription", text: "Send anonymous usage and error events (which features are used, where flows are abandoned, what fails) to help decide what to build next. Never includes repo names, ticket keys, file paths, prompt text or error messages — see [TELEMETRY.md](https://github.com/oznasi1/agent-flow/blob/main/docs/TELEMETRY.md). VS Code's own `#telemetry.telemetryLevel#` setting is honoured regardless of this one.",
    why: "the repository URL (github.com/oznasi1/agent-flow) contains the hyphen-bounded word \"agent\" — same class of hit as the repository-URL entries above" },
];

/** Locations not yet converted. Shrinks to empty over Tasks 2-9; the final task
 * deletes this list and its assertion. A location listed here tolerates ANY
 * agent-word text inside it. */
const PENDING_LOCATIONS: string[] = [];

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
