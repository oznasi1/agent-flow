import { describe, it, expect } from "vitest";
import { briefMarkdown } from "../../../src/engine/brief";

describe("briefMarkdown", () => {
  it("renders the ticket description under its own heading", () => {
    const out = briefMarkdown({ key: "ASM-12", summary: "Isolate renew queue", descriptionText: "Split the queue by tenant." });
    expect(out).toBe(
      "## ASM-12: Isolate renew queue\n\n## Ticket description\n\nSplit the queue by tenant.\n\n## Plan\n\n_The Claude Code prompt for this task says whether to plan first or implement._",
    );
  });

  it("falls back to a placeholder when the description is empty", () => {
    const out = briefMarkdown({ key: "ASM-12", summary: "Isolate renew queue", descriptionText: "" });
    expect(out).toContain("_(No description on the ticket.)_");
    expect(out).not.toContain("## Ticket description");
  });

  it("falls back to the placeholder when the description is whitespace-only — the trim is load-bearing", () => {
    const out = briefMarkdown({ key: "ASM-12", summary: "Isolate renew queue", descriptionText: "   \n\t  " });
    expect(out).toContain("_(No description on the ticket.)_");
    expect(out).not.toContain("## Ticket description");
  });

  it("trims surrounding whitespace from a real description rather than including it verbatim", () => {
    const out = briefMarkdown({ key: "ASM-12", summary: "s", descriptionText: "  padded on both sides  " });
    expect(out).toContain("## Ticket description\n\npadded on both sides\n\n## Plan");
  });
});
