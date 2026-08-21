import { describe, expect, it, vi } from "vitest";
import { buildSchema } from "../../../../src/tasks/agileAccelerator/describe";
import { AgileAcceleratorProvider, ProviderDeps } from "../../../../src/tasks/agileAccelerator/provider";
import { TaskProvider, TaskWriteError } from "../../../../src/tasks/provider";

const schema = buildSchema("agf__ADM_Work__c", {
  name: "agf__ADM_Work__c",
  fields: ["agf__Subject__c", "agf__Status__c", "agf__Assignee__c"].map((name) => ({ name })),
});

const REC = {
  Id: "a0700000000001AAA",
  Name: "W-1",
  LastModifiedDate: "2026-08-01T10:00:00.000+0000",
  agf__Subject__c: "A thing",
  agf__Status__c: "New",
};

function deps(over: Partial<ProviderDeps> = {}) {
  const query = vi.fn(async (_soql: string) => [REC]);
  const base: ProviderDeps = {
    cli: { query } as unknown as ProviderDeps["cli"],
    schema: async () => schema,
    identity: async () => ({ id: "005", displayName: "Ada L" }),
    statusOf: async () => ({ status: "New", category: "new" }),
    rememberIds: vi.fn(),
    team: "Falcons",
    instanceUrl: "https://gus.lightning.force.com",
    ...over,
  };
  return { deps: base, query };
}

describe("caps", () => {
  it("declares three lenses and no optional capability", () => {
    const { deps: d } = deps();
    const caps = new AgileAcceleratorProvider(d).caps;
    expect([...caps.supportedFilters]).toEqual(["mine", "unassigned", "all"]);
    expect(caps.sizes).toBe(false);
    expect(caps.labels).toBeUndefined();
    expect(caps.sprints).toBeUndefined();
    expect(caps.components).toBeUndefined();
    expect(caps.children).toBeUndefined();
  });

  it("has no refreshCaps, because its capabilities are static", () => {
    const { deps: d } = deps();
    const provider: TaskProvider = new AgileAcceleratorProvider(d);
    expect(provider.refreshCaps).toBeUndefined();
  });
});

describe("list", () => {
  it("returns mapped tasks", async () => {
    const { deps: d } = deps();
    const tasks = await new AgileAcceleratorProvider(d).list("all", "any");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].key).toBe("W-1");
    expect(tasks[0].url).toContain("/lightning/r/ADM_Work__c/a0700000000001AAA/view");
  });

  it("memoizes key to id so taskUrl can answer later", async () => {
    const { deps: d } = deps();
    await new AgileAcceleratorProvider(d).list("all", "any");
    expect(d.rememberIds).toHaveBeenCalledWith([["W-1", "a0700000000001AAA"]]);
  });

  it("refuses the mine lens with no resolvable identity rather than showing everything", async () => {
    const { deps: d, query } = deps({ identity: async () => null });
    expect(await new AgileAcceleratorProvider(d).list("mine", "any")).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("honours the max argument", async () => {
    const { deps: d, query } = deps();
    await new AgileAcceleratorProvider(d).list("all", "any", 7);
    expect(query.mock.calls[0][0]).toContain("LIMIT 7");
  });
});

describe("detail", () => {
  it("returns the detail shape for a key", async () => {
    const { deps: d } = deps();
    const detail = await new AgileAcceleratorProvider(d).detail("W-1");
    expect(detail.key).toBe("W-1");
    expect(detail.summary).toBe("A thing");
  });

  it("throws for a key the source cannot resolve, since it is a foreground action", async () => {
    const { deps: d } = deps({ cli: { query: async () => [] } as unknown as ProviderDeps["cli"] });
    await expect(new AgileAcceleratorProvider(d).detail("W-404")).rejects.toThrow(/W-404/);
  });
});

describe("the read-only surface", () => {
  it("offers no status transitions, which the seam treats as fully supported", async () => {
    const { deps: d } = deps();
    expect(await new AgileAcceleratorProvider(d).statusTargets("W-1")).toEqual([]);
  });

  it("refuses moveTo with an empty retryWith, so no retry is offered", async () => {
    const { deps: d } = deps();
    // Both assertions go through `rejects`. An assertion inside a bare
    // `.catch()` would silently pass if moveTo ever started resolving, which is
    // the exact regression this test exists to catch.
    const attempt = () => new AgileAcceleratorProvider(d).moveTo("W-1", "x", {});
    await expect(attempt()).rejects.toBeInstanceOf(TaskWriteError);
    await expect(attempt()).rejects.toHaveProperty("retryWith", []);
  });

  it("accepts assignToMe and does nothing, as the seam requires", async () => {
    const { deps: d, query } = deps();
    await expect(new AgileAcceleratorProvider(d).assignToMe("W-1")).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it("delegates status to the connector's batched memo", async () => {
    const statusOf = vi.fn(async () => ({ status: "Fixed", category: "done" }));
    const { deps: d } = deps({ statusOf });
    expect(await new AgileAcceleratorProvider(d).status("W-1")).toEqual({ status: "Fixed", category: "done" });
    expect(statusOf).toHaveBeenCalledWith("W-1");
  });

  it("returns the resolved identity", async () => {
    const { deps: d } = deps();
    expect(await new AgileAcceleratorProvider(d).me()).toEqual({ id: "005", displayName: "Ada L" });
  });
});
