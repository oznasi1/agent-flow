import { describe, expect, it, vi } from "vitest";
import { makeJiraConnector } from "../../../../src/tasks/jira/connector";

vi.mock("../../../../src/config", () => ({
  getConfig: () => ({ baseUrl: mockBase, project: mockProject }),
}));
let mockBase = "https://x.atlassian.net";
let mockProject = "ABC";

const ctx = { secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} } } as never;

describe("JiraConnector", () => {
  it("describes itself for every UI string", () => {
    const info = makeJiraConnector(ctx).info();
    expect(info.label).toBe("Jira");
    expect(info.scopeNoun).toBe("project");
    expect(info.scopeValue).toBe("ABC");
    expect(info.endpoint).toBe("https://x.atlassian.net");
    expect(info.exampleKey).toBe("ABC-1234");
    expect(info.endpointSetting).toBe("agentFlow.jira.baseUrl");
    expect(info.scopeSetting).toBe("agentFlow.jira.project");
  });

  it("uses a placeholder example key when no project is configured", () => {
    mockProject = "";
    expect(makeJiraConnector(ctx).info().exampleKey).toBe("ABC-1234");
    mockProject = "ABC";
  });

  it("is configured only when both settings are present", () => {
    expect(makeJiraConnector(ctx).isConfigured()).toBe(true);
    mockBase = "";
    expect(makeJiraConnector(ctx).isConfigured()).toBe(false);
    mockBase = "https://x.atlassian.net";
  });

  it("builds a task url on the released /browse/ shape", () => {
    expect(makeJiraConnector(ctx).taskUrl("ABC-7")).toBe("https://x.atlassian.net/browse/ABC-7");
  });

  it("recovers a key from a persisted run url, and declines a foreign one", () => {
    const c = makeJiraConnector(ctx);
    expect(c.keyFromUrl("https://x.atlassian.net/browse/ABC-7")).toBe("ABC-7");
    expect(c.keyFromUrl("https://github.com/o/r/pull/9")).toBeNull();
    expect(c.keyFromUrl("")).toBeNull();
  });

  it("declares one wizard step per collected setting", () => {
    expect(makeJiraConnector(ctx).setupSteps).toBe(2);
  });
});
