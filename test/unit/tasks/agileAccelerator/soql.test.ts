import { describe, expect, it } from "vitest";
import { buildSchema } from "../../../../src/tasks/agileAccelerator/describe";
import {
  buildDetailQuery, buildListQuery, buildStatusQuery, soqlEscape,
} from "../../../../src/tasks/agileAccelerator/soql";

const full = buildSchema("agf__ADM_Work__c", {
  name: "agf__ADM_Work__c",
  fields: ["agf__Subject__c", "agf__Status__c", "agf__Assignee__c", "agf__Priority__c", "agf__Scrum_Team__c"]
    .map((name) => ({ name })),
});

const sparse = buildSchema("agf__ADM_Work__c", {
  name: "agf__ADM_Work__c",
  fields: [{ name: "agf__Subject__c" }],
});

const opts = { team: "Falcons", meId: "005000000000001", meName: "Ada L", max: 50 };

describe("soqlEscape", () => {
  it("escapes the quote that would end the literal", () => {
    expect(soqlEscape("O'Hara")).toBe("O\\'Hara");
  });

  it("escapes backslashes before quotes so the escape cannot be escaped away", () => {
    expect(soqlEscape("a\\b")).toBe("a\\\\b");
  });
});

describe("buildListQuery", () => {
  it("always selects Id and Name, since url and key depend on them", () => {
    const q = buildListQuery(full, "all", opts);
    expect(q).toContain("SELECT Id, Name");
  });

  it("selects the assignee's readable name via the __r relationship path", () => {
    // A `__c`-suffixed lookup selects an opaque id; the readable name lives on
    // the `__r` path. Getting this spelling wrong makes the whole query 400.
    expect(buildListQuery(full, "all", opts)).toContain("agf__Assignee__r.Name");
    expect(buildListQuery(full, "all", opts)).not.toContain("agf__Assignee__cr.Name");
  });

  it("bounds the query by team when the org has a team field", () => {
    expect(buildListQuery(full, "all", opts)).toContain("agf__Scrum_Team__r.Name = 'Falcons'");
  });

  it("drops the team clause rather than failing when the org has no team field", () => {
    const q = buildListQuery(sparse, "all", opts);
    expect(q).not.toContain("Scrum_Team");
    expect(q).toContain("LIMIT 50");
  });

  it("filters mine by the resolved user id", () => {
    expect(buildListQuery(full, "mine", opts)).toContain("agf__Assignee__c = '005000000000001'");
  });

  it("falls back to the display name when no id was resolvable", () => {
    const q = buildListQuery(full, "mine", { ...opts, meId: "" });
    expect(q).toContain("agf__Assignee__r.Name = 'Ada L'");
  });

  it("filters unassigned by a null assignee", () => {
    expect(buildListQuery(full, "unassigned", opts)).toContain("agf__Assignee__c = null");
  });

  it("omits any assignee FILTER for the all lens", () => {
    // Careful: the SELECT legitimately contains agf__Assignee__r.Name for any
    // schema that has the field, so this must assert the absence of a WHERE
    // comparison, not the absence of the word "Assignee".
    const q = buildListQuery(full, "all", opts);
    expect(q).not.toContain("agf__Assignee__c =");
    expect(q).not.toContain("agf__Assignee__r.Name =");
  });

  it("escapes a team name containing a quote", () => {
    expect(buildListQuery(full, "all", { ...opts, team: "O'Hara" })).toContain("'O\\'Hara'");
  });

  it("omits an absent field from the SELECT so the query cannot 400", () => {
    const q = buildListQuery(sparse, "all", opts);
    expect(q).toContain("agf__Subject__c");
    expect(q).not.toContain("agf__Priority__c");
  });

  it("caps and orders the result", () => {
    const q = buildListQuery(full, "all", { ...opts, max: 7 });
    expect(q).toContain("ORDER BY LastModifiedDate DESC");
    expect(q).toContain("LIMIT 7");
  });
});

describe("buildDetailQuery / buildStatusQuery", () => {
  it("looks a single work item up by its W- name", () => {
    expect(buildDetailQuery(full, "W-1234567")).toContain("Name = 'W-1234567'");
  });

  it("batches many keys into one IN clause, which is the whole point", () => {
    const q = buildStatusQuery(full, ["W-1", "W-2"]);
    expect(q).toContain("Name IN ('W-1','W-2')");
  });

  it("escapes keys in the IN clause too", () => {
    expect(buildStatusQuery(full, ["W-1'"])).toContain("'W-1\\''");
  });
});
