import { describe, expect, it, vi } from "vitest";
import { makeJiraConnector } from "../../../../src/tasks/jira/connector";

vi.mock("../../../../src/config", () => ({
  getConfig: () => ({ baseUrl: mockBase, project: mockProject }),
}));
let mockBase = "https://x.atlassian.net";
let mockProject = "ABC";

// probe() builds its own JiraClient from the (mocked) config above, so only the
// constructor needs mocking here — JiraAuthError/JiraApiError stay the real
// classes so connector.ts's own `instanceof` checks (and describeJiraError) see
// exactly the class a test throws, the same pattern tasksView.test.ts uses.
vi.mock("../../../../src/tasks/jira/client", async () => {
  const actual = await vi.importActual<typeof import("../../../../src/tasks/jira/client")>(
    "../../../../src/tasks/jira/client",
  );
  return { ...actual, JiraClient: vi.fn() };
});

import { JiraApiError, JiraAuthError, JiraClient } from "../../../../src/tasks/jira/client";

const ctx = { secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} } } as never;

/** An ExtensionContext whose SecretStorage holds credentials, so
 *  isAuthenticated() resolves true and probe()'s self-gate lets the rest run. */
function authedCtx() {
  const store: Record<string, string> = {
    "agentFlow.jira.email": "me@example.com",
    "agentFlow.jira.token": "tok",
  };
  return {
    secrets: {
      get: async (key: string) => store[key],
      store: async () => {},
      delete: async () => {},
    },
  } as never;
}

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

describe("JiraConnector — probe()", () => {
  it("does not probe at all when there are no stored credentials, and reports nothing to diagnose", async () => {
    const probeMyself = vi.fn();
    const getProject = vi.fn();
    vi.mocked(JiraClient).mockImplementation(() => ({ probeMyself, getProject }) as never);
    const result = await makeJiraConnector(ctx).probe();
    expect(result).toEqual({});
    expect(probeMyself).not.toHaveBeenCalled();
    expect(getProject).not.toHaveBeenCalled();
  });

  it("records a successful probe with the display name and project name", async () => {
    const probeMyself = vi.fn(async () => ({ accountId: "a1", displayName: "Jane Doe" }));
    const getProject = vi.fn(async () => ({ id: "1", key: "ABC", name: "Assembly" }));
    vi.mocked(JiraClient).mockImplementation(() => ({ probeMyself, getProject }) as never);
    const result = await makeJiraConnector(authedCtx()).probe();
    expect(result.auth).toEqual({ ok: true, displayName: "Jane Doe" });
    expect(result.scope).toEqual({ ok: true, name: "Assembly" });
  });

  it("falls back to the account id when the display name is empty", async () => {
    const probeMyself = vi.fn(async () => ({ accountId: "a1", displayName: "" }));
    vi.mocked(JiraClient).mockImplementation(() => ({ probeMyself, getProject: vi.fn() }) as never);
    const result = await makeJiraConnector(authedCtx()).probe();
    expect(result.auth).toEqual({ ok: true, displayName: "a1" });
  });

  it("classifies a JiraAuthError as the credentials' fault", async () => {
    const probeMyself = vi.fn(async () => {
      throw new JiraAuthError("Jira auth failed (401). Sign in again.");
    });
    vi.mocked(JiraClient).mockImplementation(() => ({ probeMyself, getProject: vi.fn() }) as never);
    const result = await makeJiraConnector(authedCtx()).probe();
    expect(result.auth).toEqual({ ok: false, reason: "auth", message: "Jira auth failed (401). Sign in again." });
  });

  it("classifies any other error as a reachability problem, verbatim", async () => {
    const probeMyself = vi.fn(async () => {
      throw new Error("Jira didn't respond within 15s (https://x.atlassian.net).");
    });
    vi.mocked(JiraClient).mockImplementation(() => ({ probeMyself, getProject: vi.fn() }) as never);
    const result = await makeJiraConnector(authedCtx()).probe();
    expect(result.auth).toEqual({
      ok: false,
      reason: "network",
      message: "Jira didn't respond within 15s (https://x.atlassian.net).",
    });
  });

  it("skips the project lookup when the credentials were rejected — it cannot succeed", async () => {
    const getProject = vi.fn();
    const probeMyself = vi.fn(async () => {
      throw new JiraAuthError("nope");
    });
    vi.mocked(JiraClient).mockImplementation(() => ({ probeMyself, getProject }) as never);
    const result = await makeJiraConnector(authedCtx()).probe();
    expect(getProject).not.toHaveBeenCalled();
    expect(result.scope).toBeUndefined();
  });

  it("skips the project lookup when no project is configured", async () => {
    const getProject = vi.fn();
    const probeMyself = vi.fn(async () => ({ accountId: "a1", displayName: "Jane" }));
    vi.mocked(JiraClient).mockImplementation(() => ({ probeMyself, getProject }) as never);
    mockProject = "";
    const result = await makeJiraConnector(authedCtx()).probe();
    expect(getProject).not.toHaveBeenCalled();
    expect(result.scope).toBeUndefined();
    mockProject = "ABC";
  });

  it("falls back to the key when the project name is empty", async () => {
    const probeMyself = vi.fn(async () => ({ accountId: "a1", displayName: "Jane" }));
    const getProject = vi.fn(async () => ({ id: "1", key: "ABC", name: "" }));
    vi.mocked(JiraClient).mockImplementation(() => ({ probeMyself, getProject }) as never);
    const result = await makeJiraConnector(authedCtx()).probe();
    expect(result.scope).toEqual({ ok: true, name: "ABC" });
  });

  it("reads a 404 as a key that isn't there, through describeJiraError", async () => {
    const probeMyself = vi.fn(async () => ({ accountId: "a1", displayName: "Jane" }));
    const getProject = vi.fn(async () => {
      throw new JiraApiError(404, "No project could be found.", {}, ["No project could be found"]);
    });
    vi.mocked(JiraClient).mockImplementation(() => ({ probeMyself, getProject }) as never);
    const result = await makeJiraConnector(authedCtx()).probe();
    expect(result.scope).toEqual({ ok: false, reason: "not-found", message: "No project could be found." });
  });

  it("reads any other JiraApiError as an error, not a missing key", async () => {
    const probeMyself = vi.fn(async () => ({ accountId: "a1", displayName: "Jane" }));
    const getProject = vi.fn(async () => {
      throw new JiraApiError(500, "Jira is having trouble (500) — try again shortly.", {}, []);
    });
    vi.mocked(JiraClient).mockImplementation(() => ({ probeMyself, getProject }) as never);
    const result = await makeJiraConnector(authedCtx()).probe();
    expect(result.scope).toEqual({
      ok: false,
      reason: "error",
      message: "Jira is having trouble (500) — try again shortly.",
    });
  });
});
