import { describe, it, expect } from "vitest";
import { boardHtml } from "../../../src/company/boardHtml";

const html = boardHtml();

describe("boardHtml", () => {
  it("is a complete document", () => {
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("</html>");
  });

  it("embeds no token — the page reads the key from its own URL", () => {
    expect(html).toContain("location.search");
    expect(html).not.toContain("__TOKEN__");
  });

  it("escapes artifact content rather than trusting it", () => {
    expect(html).toContain("function esc(");
  });

  it("renders html artifacts in a sandboxed iframe with scripts off", () => {
    expect(html).toMatch(/sandbox\s*=\s*["']["']/);
  });

  it("wires all four verdict actions and the keyboard", () => {
    for (const needle of ["approve", "reject", "revise", "/api/decision", "keydown"]) {
      expect(html).toContain(needle);
    }
  });

  it("supports light and dark", () => {
    expect(html).toContain("prefers-color-scheme: dark");
  });
});
