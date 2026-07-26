import { describe, it, expect } from "vitest";
import { parseInline, parseMarkdown } from "../../../src/engine/markdown";

const text = (t: string) => ({ kind: "text", text: t });

describe("parseInline", () => {
  it("returns bare prose as one text span", () => {
    expect(parseInline("just words")).toEqual([text("just words")]);
  });

  it("reads code, bold, italic and links", () => {
    expect(parseInline("a `c` b")).toEqual([text("a "), { kind: "code", text: "c" }, text(" b")]);
    expect(parseInline("**b**")).toEqual([{ kind: "strong", children: [text("b")] }]);
    expect(parseInline("*i*")).toEqual([{ kind: "em", children: [text("i")] }]);
    expect(parseInline("_i_")).toEqual([{ kind: "em", children: [text("i")] }]);
    expect(parseInline("[go](https://x.dev)")).toEqual([
      { kind: "link", href: "https://x.dev", children: [text("go")] },
    ]);
  });

  it("prefers bold over italic for a doubled marker", () => {
    expect(parseInline("**b**")[0].kind).toBe("strong");
  });

  // Security: this content comes from arbitrary third-party marketplaces.
  it("renders a non-http link as inert text, keeping only its label", () => {
    expect(parseInline("[click](javascript:alert(1))")).toEqual([text("click")]);
    expect(parseInline("[open](file:///etc/passwd)")).toEqual([text("open")]);
  });

  it("keeps a balanced paren inside an href", () => {
    expect(parseInline("[wiki](https://x.dev/a_(b))")).toEqual([
      { kind: "link", href: "https://x.dev/a_(b)", children: [text("wiki")] },
    ]);
  });

  it("leaves raw HTML as literal characters", () => {
    expect(parseInline("<script>alert(1)</script>")).toEqual([text("<script>alert(1)</script>")]);
  });

  it("leaves an unclosed marker literal", () => {
    expect(parseInline("a * b")).toEqual([text("a * b")]);
    expect(parseInline("`unclosed")).toEqual([text("`unclosed")]);
  });
});

describe("parseMarkdown", () => {
  it("drops a leading frontmatter block", () => {
    expect(parseMarkdown("---\nname: a\ndescription: b\n---\n# Head\n")).toEqual([
      { kind: "heading", level: 1, children: [text("Head")] },
    ]);
  });

  it("reads headings at every level", () => {
    expect(parseMarkdown("### Three")).toEqual([
      { kind: "heading", level: 3, children: [text("Three")] },
    ]);
  });

  it("joins wrapped lines into one paragraph and splits on a blank line", () => {
    const b = parseMarkdown("one\ntwo\n\nthree");
    expect(b).toEqual([
      { kind: "para", children: [text("one two")] },
      { kind: "para", children: [text("three")] },
    ]);
  });

  it("reads a fenced block with its language, verbatim", () => {
    expect(parseMarkdown("```bash\nls -la\n# not a heading\n```")).toEqual([
      { kind: "fence", lang: "bash", text: "ls -la\n# not a heading" },
    ]);
  });

  it("keeps the rest of the file when a fence is never closed", () => {
    expect(parseMarkdown("```\nstill here")).toEqual([{ kind: "fence", lang: "", text: "still here" }]);
  });

  it("reads unordered and ordered lists", () => {
    expect(parseMarkdown("- a\n- b")).toEqual([
      { kind: "list", ordered: false, items: [[text("a")], [text("b")]] },
    ]);
    expect(parseMarkdown("1. a\n2. b")).toEqual([
      { kind: "list", ordered: true, items: [[text("a")], [text("b")]] },
    ]);
  });

  it("flattens a nested list into its parent — documented subset behaviour", () => {
    expect(parseMarkdown("- a\n  - b")).toEqual([
      { kind: "list", ordered: false, items: [[text("a")], [text("b")]] },
    ]);
  });

  it("reads a blockquote and a horizontal rule", () => {
    expect(parseMarkdown("> quoted\n> more")).toEqual([
      { kind: "quote", children: [text("quoted more")] },
    ]);
    expect(parseMarkdown("***")).toEqual([{ kind: "rule" }]);
  });

  it("reads a pipe table", () => {
    expect(parseMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |")).toEqual([
      {
        kind: "table",
        head: [[text("a")], [text("b")]],
        rows: [[[text("1")], [text("2")]]],
      },
    ]);
  });

  it("treats a pipe line with no divider as a paragraph", () => {
    expect(parseMarkdown("| a | b |")).toEqual([{ kind: "para", children: [text("| a | b |")] }]);
  });

  it("tolerates CRLF line endings", () => {
    expect(parseMarkdown("# Head\r\n\r\nbody\r\n")).toEqual([
      { kind: "heading", level: 1, children: [text("Head")] },
      { kind: "para", children: [text("body")] },
    ]);
  });

  it("returns nothing for empty input", () => {
    expect(parseMarkdown("")).toEqual([]);
  });

  it("terminates on a 300 KB body", () => {
    const src = "para line\n\n".repeat(30_000);
    expect(src.length).toBeGreaterThan(300_000);
    expect(parseMarkdown(src)).toHaveLength(30_000);
  });
});
