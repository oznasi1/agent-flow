import { describe, it, expect } from "vitest";
import { childrenJql, jqlKey } from "../../../../src/tasks/jira/childJql";

describe("jqlKey", () => {
  it("passes an ordinary key through", () => {
    expect(jqlKey("ASM-1234")).toBe("ASM-1234");
  });

  it("strips the characters that would end the JQL literal early", () => {
    expect(jqlKey('ASM-1" OR key = "ASM-2')).toBe("ASM-1 OR key = ASM-2");
    expect(jqlKey("ASM-1\\")).toBe("ASM-1");
  });
});

describe("childrenJql", () => {
  it("asks `parent` first, then the older Epic Link spelling", () => {
    expect(childrenJql("ASM-1")).toEqual([
      'parent = "ASM-1" ORDER BY key ASC',
      '"Epic Link" = "ASM-1" ORDER BY key ASC',
    ]);
  });

  it("quotes the key through jqlKey", () => {
    expect(childrenJql('ASM-1"')).toEqual([
      'parent = "ASM-1" ORDER BY key ASC',
      '"Epic Link" = "ASM-1" ORDER BY key ASC',
    ]);
  });
});
