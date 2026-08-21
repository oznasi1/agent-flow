// test/unit/tasks/agileAccelerator/describe.test.ts
import { describe as suite, expect, it } from "vitest";
import {
  buildSchema, prefixOf, TEAM_FIELD_CANDIDATES, WANTED_FIELDS, WORK_OBJECT_CANDIDATES,
} from "../../../../src/tasks/agileAccelerator/describe";

const d = (object: string, fields: string[]) => ({ name: object, fields: fields.map((name) => ({ name })) });

suite("prefixOf", () => {
  it("reads the managed-package namespace off the object name", () => {
    expect(prefixOf("agf__ADM_Work__c")).toBe("agf__");
  });

  it("reads an empty prefix for the bare object GUS itself uses", () => {
    expect(prefixOf("ADM_Work__c")).toBe("");
  });
});

suite("buildSchema", () => {
  it("prefixes logical field names with the object's namespace", () => {
    const s = buildSchema("agf__ADM_Work__c", d("agf__ADM_Work__c", ["agf__Subject__c"]));
    expect(s.field("Subject__c")).toBe("agf__Subject__c");
    expect(s.prefix).toBe("agf__");
  });

  it("leaves field names bare when the object is bare (GUS)", () => {
    const s = buildSchema("ADM_Work__c", d("ADM_Work__c", ["Subject__c"]));
    expect(s.field("Subject__c")).toBe("Subject__c");
    expect(s.has("Subject__c")).toBe(true);
  });

  it("reports a field the org does not have as absent", () => {
    const s = buildSchema("agf__ADM_Work__c", d("agf__ADM_Work__c", ["agf__Subject__c"]));
    expect(s.has("Subject__c")).toBe(true);
    expect(s.has("Priority__c")).toBe(false);
  });

  it("selectable() drops absent fields instead of failing the query", () => {
    const s = buildSchema("agf__ADM_Work__c", d("agf__ADM_Work__c", ["agf__Subject__c", "agf__Status__c"]));
    expect(s.selectable(["Subject__c", "Priority__c", "Status__c"])).toEqual([
      "agf__Subject__c",
      "agf__Status__c",
    ]);
  });

  it("resolves the team field to the first candidate that exists", () => {
    const s = buildSchema("agf__ADM_Work__c", d("agf__ADM_Work__c", ["agf__Team__c"]));
    expect(s.teamField).toBe("agf__Team__c");
  });

  it("prefers the earlier candidate when an org has more than one", () => {
    const s = buildSchema("agf__ADM_Work__c", d("agf__ADM_Work__c", ["agf__Team__c", "agf__Scrum_Team__c"]));
    expect(s.teamField).toBe(`agf__${TEAM_FIELD_CANDIDATES[0]}`);
  });

  it("reports no team field rather than guessing one", () => {
    const s = buildSchema("agf__ADM_Work__c", d("agf__ADM_Work__c", ["agf__Subject__c"]));
    expect(s.teamField).toBeNull();
  });
});

suite("the candidate lists", () => {
  it("tries the packaged object before the bare GUS one", () => {
    expect([...WORK_OBJECT_CANDIDATES]).toEqual(["agf__ADM_Work__c", "ADM_Work__c"]);
  });

  it("wants only unprefixed logical names, so buildSchema can prefix them", () => {
    for (const f of WANTED_FIELDS) expect(f.startsWith("agf__")).toBe(false);
  });
});
