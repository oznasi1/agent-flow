import { describe, expect, it } from "vitest";
import { buildSchema } from "../../../../src/tasks/agileAccelerator/describe";
import { recordUrl, statusCategoryOf, toDetail, toTask } from "../../../../src/tasks/agileAccelerator/shape";

const schema = buildSchema("agf__ADM_Work__c", {
  name: "agf__ADM_Work__c",
  fields: ["agf__Subject__c", "agf__Status__c", "agf__Assignee__c", "agf__Priority__c"].map((name) => ({ name })),
});

const rec = {
  Id: "a0700000000001AAA",
  Name: "W-1234567",
  LastModifiedDate: "2026-08-01T10:00:00.000+0000",
  agf__Subject__c: "Board does not paint",
  agf__Status__c: "In Progress",
  agf__Priority__c: "P2",
  agf__Assignee__r: { Name: "Ada L" },
};

describe("statusCategoryOf", () => {
  it("treats the closed set git2gus itself uses as done", () => {
    for (const s of ["Fixed", "Closed", "Integrate"]) expect(statusCategoryOf(s)).toBe("done");
  });

  it("treats the intake statuses as new", () => {
    expect(statusCategoryOf("New")).toBe("new");
    expect(statusCategoryOf("Triaged")).toBe("new");
  });

  it("matches case-insensitively, since picklist casing varies by org", () => {
    expect(statusCategoryOf("FIXED")).toBe("done");
    expect(statusCategoryOf("fixed")).toBe("done");
  });

  it("maps an UNKNOWN status to indeterminate, never done", () => {
    // Only "done" retires a run. A wrong "done" silently retires live work,
    // so the conservative default is the whole point of this test.
    expect(statusCategoryOf("Bikeshedding")).toBe("indeterminate");
    expect(statusCategoryOf("")).toBe("indeterminate");
  });
});

describe("recordUrl", () => {
  it("builds a Lightning record url from the 18-char id", () => {
    expect(recordUrl("https://gus.lightning.force.com", "a0700000000001AAA")).toBe(
      "https://gus.lightning.force.com/lightning/r/ADM_Work__c/a0700000000001AAA/view",
    );
  });

  it("tolerates a trailing slash on the configured instance url", () => {
    expect(recordUrl("https://x.lightning.force.com/", "a07")).toBe(
      "https://x.lightning.force.com/lightning/r/ADM_Work__c/a07/view",
    );
  });
});

describe("toTask", () => {
  it("uses the W- name as the key and the record url as the url", () => {
    const t = toTask(rec, schema, "https://gus.lightning.force.com");
    expect(t.key).toBe("W-1234567");
    expect(t.url).toContain("/lightning/r/ADM_Work__c/a0700000000001AAA/view");
  });

  it("carries summary, status, priority and assignee across", () => {
    const t = toTask(rec, schema, "https://x");
    expect(t.summary).toBe("Board does not paint");
    expect(t.status).toBe("In Progress");
    expect(t.statusCategory).toBe("indeterminate");
    expect(t.priority).toBe("P2");
    expect(t.assignee).toBe("Ada L");
  });

  it("reports an unassigned record as Unassigned rather than empty", () => {
    const t = toTask({ ...rec, agf__Assignee__r: null }, schema, "https://x");
    expect(t.assignee).toBe("Unassigned");
  });

  it("reports no estimate and no sprint, because this source declares neither", () => {
    const t = toTask(rec, schema, "https://x");
    expect(t.estimateSeconds).toBeNull();
    expect(t.sprint).toBeNull();
    expect(t.inOpenSprint).toBe(false);
  });

  it("survives a record whose optional fields were never selected", () => {
    const bare = buildSchema("agf__ADM_Work__c", { name: "agf__ADM_Work__c", fields: [] });
    const t = toTask({ Id: "a07", Name: "W-9" }, bare, "https://x");
    expect(t.summary).toBe("");
    expect(t.status).toBe("");
    expect(t.statusCategory).toBe("indeterminate");
    expect(t.priority).toBe("");
    expect(t.assignee).toBe("Unassigned");
  });

  it("normalizes the Salesforce timestamp to an ISO string", () => {
    expect(toTask(rec, schema, "https://x").updated).toBe("2026-08-01T10:00:00.000Z");
  });
});

describe("toDetail", () => {
  it("produces the detail shape with empty labels and components", () => {
    const d = toDetail(rec, schema, "https://x");
    expect(d.key).toBe("W-1234567");
    expect(d.summary).toBe("Board does not paint");
    expect(d.labels).toEqual([]);
    expect(d.components).toEqual([]);
    expect(d.statusCategory).toBe("indeterminate");
  });
});
