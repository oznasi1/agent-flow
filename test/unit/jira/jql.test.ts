import { describe, it, expect } from "vitest";
import { buildJql, stripSprint } from "../../../src/jira/jql";

const ORDER = "ORDER BY priority DESC, updated DESC";

describe("buildJql — filter lenses", () => {
  it("mysprint = open sprint AND currentUser (exact)", () => {
    expect(buildJql("ASM", "mysprint")).toBe(
      `project = ASM AND sprint in openSprints() AND assignee = currentUser() AND statusCategory != Done ${ORDER}`,
    );
  });

  it("unassigned = open sprint AND empty assignee", () => {
    const q = buildJql("ASM", "unassigned");
    expect(q).toContain("sprint in openSprints()");
    expect(q).toContain("assignee IS EMPTY");
    expect(q).toContain("statusCategory != Done");
  });

  it("mine = currentUser with no sprint clause", () => {
    const q = buildJql("ASM", "mine");
    expect(q).toContain("assignee = currentUser()");
    expect(q).not.toContain("openSprints()");
  });

  it("sprint = open sprint, no assignee constraint", () => {
    expect(buildJql("ASM", "sprint")).toBe(
      `project = ASM AND sprint in openSprints() AND statusCategory != Done ${ORDER}`,
    );
  });

  it("backlog = not in an open sprint", () => {
    expect(buildJql("ASM", "backlog")).toBe(
      `project = ASM AND (sprint IS EMPTY OR sprint NOT IN openSprints()) AND statusCategory != Done ${ORDER}`,
    );
  });

  it("all = just the project + not-done", () => {
    expect(buildJql("ASM", "all")).toBe(`project = ASM AND statusCategory != Done ${ORDER}`);
  });

  it("interpolates the project key", () => {
    expect(buildJql("PROJ", "mine")).toContain("project = PROJ");
  });

  it("always ends with the ORDER BY clause", () => {
    for (const f of ["unassigned", "mine", "mysprint", "sprint", "backlog", "all"] as const) {
      expect(buildJql("ASM", f).endsWith(ORDER)).toBe(true);
    }
  });
});

describe("buildJql — size buckets", () => {
  it("size any adds no estimate clause", () => {
    expect(buildJql("ASM", "mine", "any")).not.toContain("originalEstimate");
  });

  it("size S → <= 4h", () => {
    expect(buildJql("ASM", "mine", "s")).toContain('AND originalEstimate <= "4h" ORDER BY');
  });

  it("size M → 4h..2d range", () => {
    expect(buildJql("ASM", "mine", "m")).toContain(
      'AND (originalEstimate > "4h" AND originalEstimate <= "2d") ORDER BY',
    );
  });

  it("size L → > 2d", () => {
    expect(buildJql("ASM", "mine", "l")).toContain('AND originalEstimate > "2d" ORDER BY');
  });

  it("combines the size clause with a sprint lens", () => {
    const q = buildJql("ASM", "mysprint", "s");
    expect(q).toContain("openSprints()");
    expect(q).toContain('originalEstimate <= "4h"');
  });

  it("defaults to size any when omitted", () => {
    expect(buildJql("ASM", "mine")).toBe(buildJql("ASM", "mine", "any"));
  });
});

describe("stripSprint — no-board fallback", () => {
  it("removes the sprint clause from mysprint", () => {
    expect(stripSprint(buildJql("ASM", "mysprint"))).toBe(
      `project = ASM AND assignee = currentUser() AND statusCategory != Done ${ORDER}`,
    );
  });

  it("removes the sprint clause from unassigned", () => {
    const stripped = stripSprint(buildJql("ASM", "unassigned"));
    expect(stripped).not.toContain("openSprints()");
    expect(stripped).toContain("assignee IS EMPTY");
  });

  it("removes the backlog sprint disjunction", () => {
    const stripped = stripSprint(buildJql("ASM", "backlog"));
    expect(stripped).not.toContain("openSprints()");
    expect(stripped).not.toContain("sprint IS EMPTY");
  });

  it("leaves 'mine' unchanged (no sprint clause to strip)", () => {
    expect(stripSprint(buildJql("ASM", "mine"))).toBe(buildJql("ASM", "mine"));
  });

  it("keeps the size clause intact while stripping sprint", () => {
    const stripped = stripSprint(buildJql("ASM", "mysprint", "s"));
    expect(stripped).not.toContain("openSprints()");
    expect(stripped).toContain('originalEstimate <= "4h"');
  });
});
