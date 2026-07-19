import { describe, it, expect } from "vitest";
import { renderPrompt, type PromptVars } from "../../../src/engine/prompt";

const V: PromptVars = {
  key: "ASM-5412",
  summary: "Wizer export",
  url: "https://x/ASM-5412",
  brief: ".pick-task/TASK.md",
};

describe("renderPrompt", () => {
  it("substitutes all placeholders", () => {
    expect(renderPrompt("{key}: {summary} @ {brief} — {url}", V, [])).toBe(
      "ASM-5412: Wizer export @ .pick-task/TASK.md — https://x/ASM-5412",
    );
  });

  it("expands {files} into a relevant-files block when mentions exist", () => {
    expect(renderPrompt("do it{files}", V, ["@centaur/a.ts", "@centaur/b.ts"])).toBe(
      "do it\n\nRelevant files: @centaur/a.ts @centaur/b.ts",
    );
  });

  it("expands {files} to nothing when there are no mentions", () => {
    expect(renderPrompt("do it{files}", V, [])).toBe("do it");
  });

  it("replaces every occurrence of a repeated placeholder", () => {
    expect(renderPrompt("{key} {key} — {key}", V, [])).toBe("ASM-5412 ASM-5412 — ASM-5412");
  });

  it("leaves unknown placeholders untouched", () => {
    expect(renderPrompt("{key} {nope}", V, [])).toBe("ASM-5412 {nope}");
  });

  it("renders a custom (debug-style) template", () => {
    expect(renderPrompt("Debug {key}: reproduce then fix. {url}", V, [])).toBe(
      "Debug ASM-5412: reproduce then fix. https://x/ASM-5412",
    );
  });

  it("returns a template with no placeholders verbatim", () => {
    expect(renderPrompt("just start", V, ["@a"])).toBe("just start");
  });
});
