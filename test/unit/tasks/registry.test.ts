import { describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { CONNECTOR_IDS, resolveConnector } from "../../../src/tasks/registry";

vi.mock("../../../src/config", () => ({ getConfig: () => ({ taskSource: mockSource }) }));
let mockSource = "jira";

const ctx = { secrets: { get: async () => undefined } } as never;

describe("resolveConnector", () => {
  it("resolves the shipped default", () => {
    mockSource = "jira";
    expect(resolveConnector(ctx, () => {}).id).toBe("jira");
  });

  it("falls back to jira and logs for an unknown id", () => {
    mockSource = "notARealTracker";
    const log = vi.fn();
    expect(resolveConnector(ctx, log).id).toBe("jira");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("notARealTracker"));
  });

  it("falls back for an empty id rather than rendering an empty board", () => {
    mockSource = "";
    expect(resolveConnector(ctx, () => {}).id).toBe("jira");
  });

  it("does not resolve a prototype key to a connector", () => {
    // settings.json can hold any string; a bare CONNECTORS[id] lookup would
    // return Object.prototype.constructor here and call it as a factory.
    mockSource = "constructor";
    expect(resolveConnector(ctx, () => {}).id).toBe("jira");
  });
});

describe("the manifest and the registry agree", () => {
  const taskSourceProp = () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../package.json"), "utf8"));
    return pkg.contributes.configuration.properties["agentFlow.taskSource"];
  };

  it("offers exactly the registered connectors in the taskSource enum", () => {
    const prop = taskSourceProp();
    expect(prop.default).toBe("jira");
    expect([...prop.enum].sort()).toEqual([...CONNECTOR_IDS].sort());
    expect(prop.enumDescriptions).toHaveLength(prop.enum.length);
  });

  it("tells the reader the setting needs a window reload", () => {
    // Nothing listens for a change to this one: the connector is resolved once, at
    // activation (`resolveConnector`), so editing the setting does nothing visible
    // until the window reloads. The description is the only place a user can learn
    // that, and without it the setting reads as broken.
    expect(taskSourceProp().description).toMatch(/reload/i);
  });
});
