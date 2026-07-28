import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeAuth, installFetch, jsonResponse, textResponse, emptyResponse } from "../../_helpers/factories";

// The Sprint-field id is cached in a module-level variable; reset the whole module
// between tests so the cache never leaks across cases.
let mod: typeof import("../../../src/jira/client");
beforeEach(async () => {
  vi.resetModules();
  mod = await import("../../../src/jira/client");
});

const BASE = "https://jira.test";
const client = (auth = fakeAuth()) => new mod.JiraClient(BASE, "ASM", auth);

/** The greenhopper Sprint field descriptor `/rest/api/3/field` returns. */
const FIELD_LIST = [{ id: "customfield_10020", schema: { custom: "com.pyxis.greenhopper.jira:gh-sprint" } }];

const rawIssue = (over: Record<string, any> = {}) => ({
  key: "ASM-1",
  fields: {
    summary: "Do the thing",
    status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
    priority: { name: "High" },
    assignee: { displayName: "Jane Doe" },
    labels: ["backend"],
    components: [{ name: "account-service" }],
    updated: "2026-07-01T00:00:00.000Z",
    timeoriginalestimate: 3600,
    ...over,
  },
});

const bodyOf = (fetchMock: ReturnType<typeof installFetch>, callIdx: number) =>
  JSON.parse(fetchMock.mock.calls[callIdx][1].body);
const urlOf = (fetchMock: ReturnType<typeof installFetch>, callIdx: number) =>
  fetchMock.mock.calls[callIdx][0] as string;

describe("request — error & response mapping", () => {
  it("throws JiraAuthError on 401", async () => {
    installFetch([textResponse("", 401)]);
    await expect(client().getTransitions("ASM-1")).rejects.toBeInstanceOf(mod.JiraAuthError);
  });

  it("throws JiraAuthError on 403", async () => {
    installFetch([textResponse("", 403)]);
    await expect(client().getTransitions("ASM-1")).rejects.toBeInstanceOf(mod.JiraAuthError);
  });

  it("throws a JiraApiError carrying the parsed envelope on other non-2xx", async () => {
    installFetch([
      textResponse(
        JSON.stringify({ errorMessages: ["Ticket cannot be closed unless Resolution will be provided"], errors: {} }),
        400,
      ),
    ]);
    const err = await client().getTransitions("ASM-1").catch((e) => e);
    expect(err).toBeInstanceOf(mod.JiraApiError);
    expect(err.status).toBe(400);
    expect(err.messages).toEqual(["Ticket cannot be closed unless Resolution will be provided"]);
    expect(err.message).toBe("Ticket cannot be closed unless Resolution will be provided.");
  });

  it("does not leak a non-JSON error body into the message", async () => {
    installFetch([textResponse("server boom", 500)]);
    await expect(client().getTransitions("ASM-1")).rejects.toThrow("Jira is having trouble (500) — try again shortly.");
  });

  it("throws JiraAuthError (without fetching) when not signed in", async () => {
    const fetchMock = installFetch([]);
    await expect(client(fakeAuth({ authed: false })).getTransitions("ASM-1")).rejects.toBeInstanceOf(
      mod.JiraAuthError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a 204/empty body as null (no JSON parse)", async () => {
    installFetch([emptyResponse(204)]);
    await expect(client().transition("ASM-1", "31")).resolves.toBeUndefined();
  });

  it("sends the Authorization header from the auth provider", async () => {
    const fetchMock = installFetch([jsonResponse({ transitions: [] })]);
    await client(fakeAuth({ header: "Basic Zm9v" })).getTransitions("ASM-1");
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ Authorization: "Basic Zm9v" });
  });
});

describe("currentUserName / getMyself", () => {
  it("returns the display name", async () => {
    installFetch([jsonResponse({ displayName: "Jane Doe" })]);
    expect(await client().currentUserName()).toBe("Jane Doe");
  });

  it("returns null (swallowing errors) when the request fails", async () => {
    installFetch([textResponse("", 500)]);
    expect(await client().currentUserName()).toBeNull();
  });

  it("getMyself returns account id + display name", async () => {
    installFetch([jsonResponse({ accountId: "a-1", displayName: "Jane" })]);
    expect(await client().getMyself()).toEqual({ accountId: "a-1", displayName: "Jane" });
  });

  it("getMyself returns null when there is no account id", async () => {
    installFetch([jsonResponse({})]);
    expect(await client().getMyself()).toBeNull();
  });
});

describe("fetchTasks", () => {
  it("resolves the sprint field, then searches, and normalizes issues", async () => {
    const fetchMock = installFetch([jsonResponse(FIELD_LIST), jsonResponse({ issues: [rawIssue()] })]);
    const tasks = await client().fetchTasks("mine");
    expect(urlOf(fetchMock, 0)).toBe(`${BASE}/rest/api/3/field`);
    expect(urlOf(fetchMock, 1)).toBe(`${BASE}/rest/api/3/search/jql`);
    // the resolved custom field is requested alongside the list fields
    expect(bodyOf(fetchMock, 1).fields).toContain("customfield_10020");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ key: "ASM-1", summary: "Do the thing", url: `${BASE}/browse/ASM-1` });
  });

  it("caches the sprint field across calls (fetches /field only once)", async () => {
    const fetchMock = installFetch([
      jsonResponse(FIELD_LIST),
      jsonResponse({ issues: [] }),
      jsonResponse({ issues: [] }),
    ]);
    const c = client();
    await c.fetchTasks("mine");
    await c.fetchTasks("mine");
    const fieldCalls = fetchMock.mock.calls.filter((c2) => (c2[0] as string).endsWith("/field"));
    expect(fieldCalls).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("degrades to the sprint-stripped query when the first search fails", async () => {
    const fetchMock = installFetch([
      jsonResponse(FIELD_LIST),
      textResponse("no board", 400), // full query fails
      jsonResponse({ issues: [rawIssue()] }), // stripSprint query succeeds
    ]);
    const tasks = await client().fetchTasks("mysprint");
    expect(tasks).toHaveLength(1);
    // two distinct search bodies were tried
    expect(bodyOf(fetchMock, 1).jql).toContain("openSprints()");
    expect(bodyOf(fetchMock, 2).jql).not.toContain("openSprints()");
  });

  it("re-throws a JiraAuthError immediately without trying the next candidate", async () => {
    const fetchMock = installFetch([jsonResponse(FIELD_LIST), textResponse("", 401)]);
    await expect(client().fetchTasks("mysprint")).rejects.toBeInstanceOf(mod.JiraAuthError);
    expect(fetchMock).toHaveBeenCalledTimes(2); // field + one search, then stop
  });

  it("works with sprint detection off when the field lookup fails", async () => {
    const fetchMock = installFetch([textResponse("", 500), jsonResponse({ issues: [rawIssue()] })]);
    const tasks = await client().fetchTasks("mine");
    expect(bodyOf(fetchMock, 1).fields).not.toContain("customfield_10020");
    expect(tasks[0].sprint).toBeNull();
  });
});

describe("normalize (via fetchTasks)", () => {
  const one = async (issue: any) => {
    installFetch([jsonResponse(FIELD_LIST), jsonResponse({ issues: [issue] })]);
    return (await client().fetchTasks("mine"))[0];
  };

  it("maps a fully-populated issue", async () => {
    const t = await one(rawIssue());
    expect(t).toEqual({
      key: "ASM-1",
      summary: "Do the thing",
      status: "In Progress",
      statusCategory: "indeterminate",
      priority: "High",
      assignee: "Jane Doe",
      labels: ["backend"],
      components: ["account-service"],
      sprint: null,
      inOpenSprint: false,
      updated: "2026-07-01T00:00:00.000Z",
      url: `${BASE}/browse/ASM-1`,
      estimateSeconds: 3600,
    });
  });

  it("applies null-safe defaults for a sparse issue", async () => {
    const t = await one({ key: "ASM-2", fields: {} });
    expect(t).toMatchObject({
      summary: "",
      status: "",
      statusCategory: "new",
      priority: "",
      assignee: "Unassigned",
      labels: [],
      components: [],
      estimateSeconds: null,
    });
  });

  it("coerces a non-numeric estimate to null", async () => {
    const t = await one(rawIssue({ timeoriginalestimate: "3h" }));
    expect(t.estimateSeconds).toBeNull();
  });

  it("reads the active sprint into name + inOpenSprint", async () => {
    const t = await one(
      rawIssue({ customfield_10020: [{ state: "active", name: "Sprint 12" }] }),
    );
    expect(t.sprint).toBe("Sprint 12");
    expect(t.inOpenSprint).toBe(true);
  });
});

describe("parseSprints", () => {
  it("returns nulls for a non-array value", () => {
    expect(mod.parseSprints(null)).toEqual({ sprintName: null, inOpenSprint: false });
  });

  it("returns nulls for an empty array", () => {
    expect(mod.parseSprints([])).toEqual({ sprintName: null, inOpenSprint: false });
  });

  it("reads an active object sprint", () => {
    expect(mod.parseSprints([{ state: "active", name: "Sprint 5" }])).toEqual({
      sprintName: "Sprint 5",
      inOpenSprint: true,
    });
  });

  it("keeps a closed sprint's name but flags it not-open", () => {
    expect(mod.parseSprints([{ state: "closed", name: "Sprint 4" }])).toEqual({
      sprintName: "Sprint 4",
      inOpenSprint: false,
    });
  });

  it("lets an active sprint take precedence over an earlier closed one", () => {
    expect(
      mod.parseSprints([
        { state: "closed", name: "Sprint 4" },
        { state: "active", name: "Sprint 5" },
      ]),
    ).toEqual({ sprintName: "Sprint 5", inOpenSprint: true });
  });

  it("parses the legacy toString form", () => {
    const legacy = "com.atlassian.greenhopper.service.sprint.Sprint@1[id=7,state=ACTIVE,name=Sprint 9,startDate=x]";
    expect(mod.parseSprints([legacy])).toEqual({ sprintName: "Sprint 9", inOpenSprint: true });
  });
});

describe("adfToText", () => {
  it("returns empty string for null/undefined", () => {
    expect(mod.adfToText(null)).toBe("");
    expect(mod.adfToText(undefined)).toBe("");
  });

  it("returns a raw string node as-is", () => {
    expect(mod.adfToText("plain")).toBe("plain");
  });

  it("flattens nested content into space-joined text", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Hello" }, { type: "text", text: "world" }] },
        { type: "paragraph", content: [{ type: "text", text: "again" }] },
      ],
    };
    expect(mod.adfToText(doc)).toContain("Hello");
    expect(mod.adfToText(doc)).toContain("world");
    expect(mod.adfToText(doc)).toContain("again");
  });
});

describe("getDetail", () => {
  it("maps fields and flattens the ADF description", async () => {
    installFetch([
      jsonResponse({
        key: "ASM-9",
        fields: {
          summary: "Detail summary",
          description: { type: "doc", content: [{ type: "text", text: "the body" }] },
          labels: ["l1"],
          components: [{ name: "centaur" }],
          status: { name: "In Review", statusCategory: { key: "indeterminate" } },
        },
      }),
    ]);
    const d = await client().getDetail("ASM-9");
    expect(d).toEqual({
      key: "ASM-9",
      summary: "Detail summary",
      descriptionText: "the body",
      labels: ["l1"],
      components: ["centaur"],
      url: `${BASE}/browse/ASM-9`,
      status: "In Review",
      statusCategory: "indeterminate",
    });
  });

  it("maps status to null when the ticket has none", async () => {
    installFetch([jsonResponse({ key: "ASM-9", fields: { summary: "s" } })]);
    const d = await client().getDetail("ASM-9");
    expect(d.status).toBeNull();
    expect(d.statusCategory).toBeNull();
  });
});

describe("getStatus", () => {
  it("returns the status name and category", async () => {
    installFetch([jsonResponse({ fields: { status: { name: "In Progress", statusCategory: { key: "indeterminate" } } } })]);
    expect(await client().getStatus("ASM-9")).toEqual({ status: "In Progress", category: "indeterminate" });
  });

  it("degrades to nulls when status is absent", async () => {
    installFetch([jsonResponse({ fields: {} })]);
    expect(await client().getStatus("ASM-9")).toEqual({ status: null, category: null });
  });
});

describe("getTransitions", () => {
  it("maps transition + target-status metadata", async () => {
    installFetch([
      jsonResponse({
        transitions: [{ id: "31", name: "Start Progress", to: { name: "In Progress", statusCategory: { key: "indeterminate" } } }],
      }),
    ]);
    expect(await client().getTransitions("ASM-1")).toEqual([
      { id: "31", name: "Start Progress", toName: "In Progress", toCategory: "indeterminate", fields: {} },
    ]);
  });

  it("returns an empty list when there are no transitions", async () => {
    installFetch([jsonResponse({ transitions: [] })]);
    expect(await client().getTransitions("ASM-1")).toEqual([]);
  });
});

describe("getActiveSprintId", () => {
  it("prefers a scrum board and returns its active sprint id", async () => {
    installFetch([
      jsonResponse({ values: [{ id: 1, type: "kanban" }, { id: 2, type: "scrum" }] }),
      jsonResponse({ values: [{ id: 99 }] }),
    ]);
    const fetchMock = (globalThis.fetch as unknown) as ReturnType<typeof installFetch>;
    expect(await client().getActiveSprintId()).toBe(99);
    expect((fetchMock.mock.calls[1][0] as string)).toContain("/board/2/sprint");
  });

  it("returns null when there is no board", async () => {
    const fetchMock = installFetch([jsonResponse({ values: [] })]);
    expect(await client().getActiveSprintId()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1); // no sprint lookup
  });

  it("returns null when the board has no active sprint", async () => {
    installFetch([jsonResponse({ values: [{ id: 1, type: "scrum" }] }), jsonResponse({ values: [] })]);
    expect(await client().getActiveSprintId()).toBeNull();
  });
});

describe("write methods", () => {
  it("transition posts the transition id", async () => {
    const fetchMock = installFetch([emptyResponse()]);
    await client().transition("ASM-1", "31");
    expect(urlOf(fetchMock, 0)).toBe(`${BASE}/rest/api/3/issue/ASM-1/transitions`);
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    expect(bodyOf(fetchMock, 0)).toEqual({ transition: { id: "31" } });
  });

  it("addLabel PUTs an additive label update", async () => {
    const fetchMock = installFetch([emptyResponse()]);
    await client().addLabel("ASM-1", "claude-code");
    expect(fetchMock.mock.calls[0][1].method).toBe("PUT");
    expect(bodyOf(fetchMock, 0)).toEqual({ update: { labels: [{ add: "claude-code" }] } });
  });

  it("addIssueToSprint posts the issue key to the sprint", async () => {
    const fetchMock = installFetch([emptyResponse()]);
    await client().addIssueToSprint(99, "ASM-1");
    expect(urlOf(fetchMock, 0)).toBe(`${BASE}/rest/agile/1.0/sprint/99/issue`);
    expect(bodyOf(fetchMock, 0)).toEqual({ issues: ["ASM-1"] });
  });

  it("assignIssue PUTs the account id", async () => {
    const fetchMock = installFetch([emptyResponse()]);
    await client().assignIssue("ASM-1", "acc-1");
    expect(urlOf(fetchMock, 0)).toBe(`${BASE}/rest/api/3/issue/ASM-1/assignee`);
    expect(bodyOf(fetchMock, 0)).toEqual({ accountId: "acc-1" });
  });

  it("removeIssueFromSprint posts the key to the backlog", async () => {
    const fetchMock = installFetch([emptyResponse()]);
    await client().removeIssueFromSprint("ASM-1");
    expect(urlOf(fetchMock, 0)).toBe(`${BASE}/rest/agile/1.0/backlog/issue`);
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    expect(bodyOf(fetchMock, 0)).toEqual({ issues: ["ASM-1"] });
  });
});

describe("transitions", () => {
  const TRANSITIONS = {
    transitions: [
      {
        id: "41",
        name: "Resolve",
        to: { name: "Done", statusCategory: { key: "done" } },
        fields: {
          resolution: {
            required: true,
            name: "Resolution",
            schema: { type: "resolution", system: "resolution" },
            allowedValues: [{ id: "10000", name: "Done" }],
          },
        },
      },
    ],
  };

  it("asks Jira to expand the transition screen fields", async () => {
    const fetchMock = installFetch([jsonResponse(TRANSITIONS)]);
    await client().getTransitions("ASM-1");
    expect(urlOf(fetchMock, 0)).toBe(`${BASE}/rest/api/3/issue/ASM-1/transitions?expand=transitions.fields`);
  });

  it("surfaces the field metadata alongside the status names", async () => {
    installFetch([jsonResponse(TRANSITIONS)]);
    const [t] = await client().getTransitions("ASM-1");
    expect(t).toMatchObject({ id: "41", name: "Resolve", toName: "Done", toCategory: "done" });
    expect(t.fields.resolution.allowedValues).toEqual([{ id: "10000", name: "Done" }]);
  });

  it("defaults fields to an empty record when Jira omits them", async () => {
    installFetch([jsonResponse({ transitions: [{ id: "31", name: "Start", to: { name: "In Progress" } }] })]);
    const [t] = await client().getTransitions("ASM-1");
    expect(t.fields).toEqual({});
  });

  it("posts only the transition id when there are no fields", async () => {
    const fetchMock = installFetch([emptyResponse(204)]);
    await client().transition("ASM-1", "41");
    expect(bodyOf(fetchMock, 0)).toEqual({ transition: { id: "41" } });
  });

  it("omits an empty fields object rather than sending `fields: {}`", async () => {
    const fetchMock = installFetch([emptyResponse(204)]);
    await client().transition("ASM-1", "41", {});
    expect(bodyOf(fetchMock, 0)).toEqual({ transition: { id: "41" } });
  });

  it("includes collected fields in the transition body", async () => {
    const fetchMock = installFetch([emptyResponse(204)]);
    await client().transition("ASM-1", "41", { resolution: { id: "10000" } });
    expect(bodyOf(fetchMock, 0)).toEqual({ transition: { id: "41" }, fields: { resolution: { id: "10000" } } });
  });
});

describe("listResolutions", () => {
  it("maps the site resolution list to id + name", async () => {
    installFetch([jsonResponse([{ id: "10000", name: "Done" }, { id: "10001", name: "Won't Do" }])]);
    await expect(client().listResolutions()).resolves.toEqual([
      { id: "10000", name: "Done" },
      { id: "10001", name: "Won't Do" },
    ]);
  });

  it("drops entries without a name and tolerates a non-array body", async () => {
    installFetch([jsonResponse([{ id: "1" }, { id: "2", name: "Done" }])]);
    await expect(client().listResolutions()).resolves.toEqual([{ id: "2", name: "Done" }]);
    installFetch([jsonResponse({ nope: true })]);
    await expect(client().listResolutions()).resolves.toEqual([]);
  });
});

describe("probeMyself — the non-swallowing credential probe", () => {
  it("returns the account when Jira accepts the token", async () => {
    installFetch([jsonResponse({ accountId: "a1", displayName: "Jane Doe" })]);
    await expect(client().probeMyself()).resolves.toEqual({ accountId: "a1", displayName: "Jane Doe" });
  });

  it("falls back to the email when Jira sends no display name", async () => {
    installFetch([jsonResponse({ accountId: "a1", emailAddress: "jane@test" })]);
    await expect(client().probeMyself()).resolves.toEqual({ accountId: "a1", displayName: "jane@test" });
  });

  // The whole reason Doctor can't reuse getMyself: it collapses a rejected token, a
  // timeout and an unreachable host into the same `null`.
  it("propagates JiraAuthError on 401 where getMyself returns null", async () => {
    installFetch([textResponse("", 401)]);
    await expect(client().probeMyself()).rejects.toBeInstanceOf(mod.JiraAuthError);
    installFetch([textResponse("", 401)]);
    await expect(client().getMyself()).resolves.toBeNull();
  });

  it("propagates JiraAuthError on 403", async () => {
    installFetch([textResponse("", 403)]);
    await expect(client().probeMyself()).rejects.toBeInstanceOf(mod.JiraAuthError);
  });

  it("propagates the reachability error rather than reporting bad credentials", async () => {
    installFetch([]);
    await expect(client().probeMyself()).rejects.toThrow(/Couldn't reach Jira at/);
  });
});

describe("getProject", () => {
  it("maps a resolved project to key and name", async () => {
    const fetchMock = installFetch([jsonResponse({ id: "10001", key: "ASM", name: "Assembly" })]);
    await expect(client().getProject("ASM")).resolves.toEqual({ id: "10001", key: "ASM", name: "Assembly" });
    expect(urlOf(fetchMock, 0)).toBe(`${BASE}/rest/api/3/project/ASM`);
  });

  it("throws a 404 JiraApiError for a key Jira can't see", async () => {
    installFetch([textResponse(JSON.stringify({ errorMessages: ["No project could be found"], errors: {} }), 404)]);
    const err = await client().getProject("NOPE").catch((e) => e);
    expect(err).toBeInstanceOf(mod.JiraApiError);
    expect(err.status).toBe(404);
  });

  it("encodes the key it was given", async () => {
    const fetchMock = installFetch([jsonResponse({ id: "1", key: "A B", name: "Spaced" })]);
    await client().getProject("A B");
    expect(urlOf(fetchMock, 0)).toBe(`${BASE}/rest/api/3/project/A%20B`);
  });
});
