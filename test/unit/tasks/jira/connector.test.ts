import { describe, expect, it, vi } from "vitest";
import * as vscode from "../../../_mocks/vscode";
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

  // A non-JiraApiError failure on the project lookup — a timeout, a DNS miss —
  // takes the other arm of the same ternary the 404 test above pins: no status
  // to read, so the message passes through verbatim instead of through
  // describeJiraError. Doctor used to test this branch directly (it was the
  // last thing collectInputs still classified); now that classification lives
  // here, this is the branch's only coverage.
  it("classifies a plain network error on the project lookup the same way as the auth probe does", async () => {
    const probeMyself = vi.fn(async () => ({ accountId: "a1", displayName: "Jane" }));
    const getProject = vi.fn(async () => {
      throw new Error("Couldn't reach Jira at https://x.atlassian.net");
    });
    vi.mocked(JiraClient).mockImplementation(() => ({ probeMyself, getProject }) as never);
    const result = await makeJiraConnector(authedCtx()).probe();
    expect(result.scope).toEqual({
      ok: false,
      reason: "error",
      message: "Couldn't reach Jira at https://x.atlassian.net",
    });
  });
});

// This connector's configure() is the ONLY place the baseUrl/project input
// boxes, their validation and their writes exist post-Task-11 — setup.ts's
// former copies were deleted, not kept as a second implementation. Pinning it
// here is what keeps that deletion safe: a regression in the https-only
// check, the trailing-slash strip, or the project-key uppercasing would
// otherwise go completely untested.
describe("JiraConnector — configure()", () => {
  function stubInputBox(...vals: (string | undefined)[]): void {
    const m = vi.mocked(vscode.window.showInputBox);
    for (const v of vals) m.mockResolvedValueOnce(v);
  }

  /** Read an agentFlow setting back out of the mock config store. */
  function readCfg(key: string): unknown {
    return vscode.workspace.getConfiguration("agentFlow").get(key);
  }

  it("numbers its two boxes from and from+1 of the given total", async () => {
    stubInputBox("https://acme.atlassian.net", "abc");
    await makeJiraConnector(ctx).configure(2, 5);
    const calls = vi.mocked(vscode.window.showInputBox).mock.calls;
    expect((calls[0][0] as { title: string }).title).toBe("Agent Flow Deck Setup (2/5)");
    expect((calls[1][0] as { title: string }).title).toBe("Agent Flow Deck Setup (3/5)");
  });

  it("writes the site url trailing-slash-stripped and the project key upper-cased, to Global", async () => {
    stubInputBox("https://acme.atlassian.net/", "abc");

    const ok = await makeJiraConnector(ctx).configure(1, 3);

    expect(ok).toBe(true);
    expect(readCfg("jira.baseUrl")).toBe("https://acme.atlassian.net");
    expect(readCfg("jira.project")).toBe("ABC");
    // The exact `getConfiguration("agentFlow")` handle configure() itself used —
    // not a second, unrelated call from this test — so this also pins the
    // target as Global, which `readCfg` alone cannot distinguish from Workspace.
    const cfgInstance = vi.mocked(vscode.workspace.getConfiguration).mock.results[0].value;
    expect(cfgInstance.update).toHaveBeenCalledWith(
      "jira.baseUrl",
      "https://acme.atlassian.net",
      vscode.ConfigurationTarget.Global,
    );
    expect(cfgInstance.update).toHaveBeenCalledWith("jira.project", "ABC", vscode.ConfigurationTarget.Global);
  });

  it("returns false and writes nothing when the site url step is cancelled", async () => {
    stubInputBox(undefined);

    expect(await makeJiraConnector(ctx).configure(1, 3)).toBe(false);
    expect(vscode.window.showInputBox).toHaveBeenCalledTimes(1); // never reached the project box
    expect(readCfg("jira.baseUrl")).toBeUndefined();
  });

  it("returns false and writes nothing when the project key step is cancelled", async () => {
    stubInputBox("https://acme.atlassian.net", undefined);

    expect(await makeJiraConnector(ctx).configure(1, 3)).toBe(false);
    expect(readCfg("jira.baseUrl")).toBeUndefined();
    expect(readCfg("jira.project")).toBeUndefined();
  });

  it("rejects an empty, non-URL, or non-https site url; accepts https", async () => {
    stubInputBox("https://acme.atlassian.net", "abc");
    await makeJiraConnector(ctx).configure(1, 3);
    const validate = (vi.mocked(vscode.window.showInputBox).mock.calls[0][0] as {
      validateInput: (v: string) => string | undefined;
    }).validateInput;

    expect(validate("")).toBeTruthy();
    expect(validate("not a url")).toBeTruthy();
    expect(validate("http://acme.atlassian.net")).toBeTruthy(); // must be https
    expect(validate("https://acme.atlassian.net")).toBeUndefined();
  });

  it("rejects an empty project key", async () => {
    stubInputBox("https://acme.atlassian.net", "abc");
    await makeJiraConnector(ctx).configure(1, 3);
    const validate = (vi.mocked(vscode.window.showInputBox).mock.calls[1][0] as {
      validateInput: (v: string) => string | undefined;
    }).validateInput;

    expect(validate("  ")).toBeTruthy();
    expect(validate("ABC")).toBeUndefined();
  });
});
