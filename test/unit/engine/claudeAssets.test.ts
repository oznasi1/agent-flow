import { describe, it, expect } from "vitest";
import { parseFrontmatter } from "../../../src/engine/claudeAssets";

describe("parseFrontmatter", () => {
  it("reads flat name and description", () => {
    const fm = parseFrontmatter("---\nname: build\ndescription: Builds the thing\n---\nbody");
    expect(fm.name).toBe("build");
    expect(fm.description).toBe("Builds the thing");
  });

  it("folds a multi-line description into one value", () => {
    const text = [
      "---",
      "name: wrap-up",
      "description: Wrap up the branch —",
      "  verify coverage,",
      "  then review.",
      "---",
    ].join("\n");
    expect(parseFrontmatter(text).description).toBe("Wrap up the branch — verify coverage, then review.");
  });

  it("strips surrounding quotes", () => {
    expect(parseFrontmatter(`---\nname: "quoted"\ndescription: 'single'\n---`).name).toBe("quoted");
    expect(parseFrontmatter(`---\nname: "quoted"\ndescription: 'single'\n---`).description).toBe("single");
  });

  it("returns an empty object when there is no frontmatter", () => {
    expect(parseFrontmatter("# Just a heading\n")).toEqual({});
  });

  it("ignores a --- that appears after the body has started", () => {
    const fm = parseFrontmatter("---\nname: a\n---\nbody\n---\nname: b\n---");
    expect(fm.name).toBe("a");
  });

  it("tolerates CRLF line endings", () => {
    expect(parseFrontmatter("---\r\nname: crlf\r\n---\r\n").name).toBe("crlf");
  });

  it("ignores keys with no value and unparseable lines", () => {
    const fm = parseFrontmatter("---\nname: ok\nnot a key value line\n---");
    expect(fm.name).toBe("ok");
  });
});
