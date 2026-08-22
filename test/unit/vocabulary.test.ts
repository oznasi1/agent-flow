import { describe, expect, it } from "vitest";
import { hasAgentWord, userFacingStrings } from "../_helpers/userFacingStrings";

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
