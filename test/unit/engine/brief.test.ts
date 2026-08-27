import { describe, it, expect } from "vitest";
import { briefMarkdown } from "../../../src/engine/brief";

describe("briefMarkdown", () => {
  it("renders the ticket description under its own heading", () => {
    const out = briefMarkdown({ key: "PROJ-12", summary: "Isolate renew queue", descriptionText: "Split the queue by tenant." });
    expect(out).toBe(
      "## PROJ-12: Isolate renew queue\n\n## Ticket description\n\nSplit the queue by tenant.\n\n## Plan\n\n_The Claude Code prompt for this task says whether to plan first or implement._",
    );
  });

  it("falls back to a placeholder when the description is empty", () => {
    const out = briefMarkdown({ key: "PROJ-12", summary: "Isolate renew queue", descriptionText: "" });
    expect(out).toContain("_(No description on the ticket.)_");
    expect(out).not.toContain("## Ticket description");
  });

  it("falls back to the placeholder when the description is whitespace-only — the trim is load-bearing", () => {
    const out = briefMarkdown({ key: "PROJ-12", summary: "Isolate renew queue", descriptionText: "   \n\t  " });
    expect(out).toContain("_(No description on the ticket.)_");
    expect(out).not.toContain("## Ticket description");
  });

  it("trims surrounding whitespace from a real description rather than including it verbatim", () => {
    const out = briefMarkdown({ key: "PROJ-12", summary: "s", descriptionText: "  padded on both sides  " });
    expect(out).toContain("## Ticket description\n\npadded on both sides\n\n## Plan");
  });
});

describe("briefMarkdown with children", () => {
  const detail = { key: "PROJ-1", summary: "parent work", descriptionText: "do the thing" };
  const children = [
    { key: "PROJ-2", summary: "first bit", path: ".claude/worktrees/PROJ-2", branch: "PROJ-2-first-bit" },
    { key: "PROJ-3", summary: "second bit", path: ".claude/worktrees/PROJ-3", branch: "PROJ-3-second-bit" },
  ];

  it("is byte-identical to the childless brief when no orchestration is passed", () => {
    expect(briefMarkdown(detail, "Claude Code")).toBe(briefMarkdown(detail, "Claude Code", undefined));
  });

  it("adds nothing for an empty child list", () => {
    expect(briefMarkdown(detail, "Claude Code", { children: [], parentBranch: "PROJ-1-parent-work" }))
      .toBe(briefMarkdown(detail, "Claude Code"));
  });

  it("renders a row per child", () => {
    const md = briefMarkdown(detail, "Claude Code", { children, parentBranch: "PROJ-1-parent-work" });
    expect(md).toContain("## Children — one subagent each");
    expect(md).toContain("| Ticket | Summary | Worktree | Branch |");
    expect(md).toContain("| PROJ-2 | first bit | `.claude/worktrees/PROJ-2` | `PROJ-2-first-bit` |");
    expect(md).toContain("| PROJ-3 | second bit | `.claude/worktrees/PROJ-3` | `PROJ-3-second-bit` |");
  });

  it("names the parent branch as the merge target", () => {
    const md = briefMarkdown(detail, "Claude Code", { children, parentBranch: "PROJ-1-parent-work" });
    expect(md).toContain("Merge finished children into `PROJ-1-parent-work`; never into main.");
  });

  it("escapes a pipe in a summary so the table survives it", () => {
    const md = briefMarkdown(detail, "Claude Code", {
      children: [{ key: "PROJ-4", summary: "a | b", path: "p", branch: "br" }],
      parentBranch: "PROJ-1-parent-work",
    });
    expect(md).toContain("| PROJ-4 | a \\| b | `p` | `br` |");
  });

  it("keeps the ticket description above the children", () => {
    const md = briefMarkdown(detail, "Claude Code", { children, parentBranch: "PROJ-1-parent-work" });
    expect(md.indexOf("do the thing")).toBeLessThan(md.indexOf("## Children"));
  });

  it("renders the whole Children block verbatim", () => {
    // One exact-block assertion rather than a pile of independent `toContain`
    // checks: those cannot see what sits BETWEEN them, so a missing separator row
    // or a dropped instruction sentence leaves every one of them green while the
    // rendered table is broken.
    const md = briefMarkdown(detail, "Claude Code", { children, parentBranch: "PROJ-1-parent-work" });
    expect(md).toContain(`
## Children — one subagent each

| Ticket | Summary | Worktree | Branch |
|---|---|---|---|
| PROJ-2 | first bit | \`.claude/worktrees/PROJ-2\` | \`PROJ-2-first-bit\` |
| PROJ-3 | second bit | \`.claude/worktrees/PROJ-3\` | \`PROJ-3-second-bit\` |

Dispatch one subagent per row. Each works ONLY inside its worktree path.
Merge finished children into \`PROJ-1-parent-work\`; never into main.`);
  });
});
