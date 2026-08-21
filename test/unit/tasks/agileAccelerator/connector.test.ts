import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeAgileAcceleratorConnector } from "../../../../src/tasks/agileAccelerator/connector";
import { window } from "../../../_mocks/vscode";

let cfg = {
  agileAcceleratorInstanceUrl: "https://gus.lightning.force.com",
  agileAcceleratorTeam: "Falcons",
  agileAcceleratorTargetOrg: "",
};
vi.mock("../../../../src/config", () => ({ getConfig: () => cfg }));

const ctx = { secrets: { get: async () => undefined } } as never;

beforeEach(() => {
  cfg = {
    agileAcceleratorInstanceUrl: "https://gus.lightning.force.com",
    agileAcceleratorTeam: "Falcons",
    agileAcceleratorTargetOrg: "",
  };
});

describe("identity and info", () => {
  it("uses the frozen id", () => {
    expect(makeAgileAcceleratorConnector(ctx).id).toBe("agileAccelerator");
  });

  it("describes itself with a team scope and a W- example key", () => {
    const info = makeAgileAcceleratorConnector(ctx).info();
    expect(info.label).toBe("Agile Accelerator");
    expect(info.scopeNoun).toBe("team");
    expect(info.scopeValue).toBe("Falcons");
    expect(info.endpoint).toBe("https://gus.lightning.force.com");
    expect(info.exampleKey).toMatch(/^W-\d+$/);
    expect(info.endpointSetting).toBe("agentFlow.agileAccelerator.instanceUrl");
    expect(info.scopeSetting).toBe("agentFlow.agileAccelerator.team");
  });
});

describe("isConfigured", () => {
  it("is true when both required settings are filled in", () => {
    expect(makeAgileAcceleratorConnector(ctx).isConfigured()).toBe(true);
  });

  it("treats a whitespace-only setting as unconfigured", () => {
    cfg = { ...cfg, agileAcceleratorTeam: "   " };
    expect(makeAgileAcceleratorConnector(ctx).isConfigured()).toBe(false);
  });

  it("does not require the optional target org", () => {
    cfg = { ...cfg, agileAcceleratorTargetOrg: "" };
    expect(makeAgileAcceleratorConnector(ctx).isConfigured()).toBe(true);
  });
});

describe("urls", () => {
  it("returns the instance root for a key it has never seen", () => {
    // Deliberately dull: a guessed deep-link shape that 404s is worse than a
    // landing page, and no search-url shape is verified.
    expect(makeAgileAcceleratorConnector(ctx).taskUrl("W-1")).toBe("https://gus.lightning.force.com");
  });

  it("recovers a key from a url that carries a W- token", () => {
    const c = makeAgileAcceleratorConnector(ctx);
    expect(c.keyFromUrl("https://x/lightning/r/ADM_Work__c/W-42/view")).toBe("W-42");
  });

  it("returns null for our own id-shaped url, rather than guessing a key", () => {
    const c = makeAgileAcceleratorConnector(ctx);
    expect(c.keyFromUrl("https://x/lightning/r/ADM_Work__c/a0700000000001AAA/view")).toBeNull();
  });

  it("returns null for another source's url", () => {
    const c = makeAgileAcceleratorConnector(ctx);
    expect(c.keyFromUrl("https://x.atlassian.net/browse/ABC-1")).toBeNull();
  });
});

describe("the setup wizard", () => {
  it("collects three steps and writes nothing until the thunk runs", async () => {
    vi.mocked(window.showInputBox)
      .mockResolvedValueOnce("https://gus.lightning.force.com")
      .mockResolvedValueOnce("Falcons")
      .mockResolvedValueOnce("");
    const c = makeAgileAcceleratorConnector(ctx);
    expect(c.setupSteps).toBe(3);
    const commit = await c.configure(1, 4);
    expect(typeof commit).toBe("function");
  });

  it("returns null when the user cancels a step, so setup aborts cleanly", async () => {
    vi.mocked(window.showInputBox).mockResolvedValueOnce(undefined);
    expect(await makeAgileAcceleratorConnector(ctx).configure(1, 4)).toBeNull();
  });
});

describe("signOut", () => {
  it("does not log the user out of an org their other tooling depends on", async () => {
    // The connector owns no credential; sign-out is advisory only.
    await expect(makeAgileAcceleratorConnector(ctx).signOut()).resolves.toBeUndefined();
  });
});
