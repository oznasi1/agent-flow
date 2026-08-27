import { describe, it, expect } from "vitest";
import { childrenJql, jqlKey } from "../../../../src/tasks/jira/childJql";

describe("jqlKey", () => {
  it("passes an ordinary key through", () => {
    expect(jqlKey("PROJ-1234")).toBe("PROJ-1234");
  });

  it("strips the characters that would end the JQL literal early", () => {
    expect(jqlKey('PROJ-1" OR key = "PROJ-2')).toBe("PROJ-1 OR key = PROJ-2");
    expect(jqlKey("PROJ-1\\")).toBe("PROJ-1");
  });
});

describe("childrenJql", () => {
  it("asks `parent` first, then the older Epic Link spelling", () => {
    expect(childrenJql("PROJ-1")).toEqual([
      'parent = "PROJ-1" ORDER BY key ASC',
      '"Epic Link" = "PROJ-1" ORDER BY key ASC',
    ]);
  });

  it("quotes the key through jqlKey", () => {
    expect(childrenJql('PROJ-1"')).toEqual([
      'parent = "PROJ-1" ORDER BY key ASC',
      '"Epic Link" = "PROJ-1" ORDER BY key ASC',
    ]);
  });
});
