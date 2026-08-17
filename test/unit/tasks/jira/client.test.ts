import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeAuth, installFetch, jsonResponse, textResponse, emptyResponse } from "../../../_helpers/factories";
import { isTaskNetworkError } from "../../../../src/tasks/provider";

// The Sprint-field id and the project shape live in module-level maps in
// `shape.ts`. Resetting the registry and re-importing the client gives it a FRESH
// `shape.ts` instance each test, so those maps start empty without an explicit
// clear — and an explicit clear would in fact be a no-op here, since a static
// import at the top of this file would hold the pre-reset instance, not the one
// the client under test is using.
let mod: typeof import("../../../../src/tasks/jira/client");
beforeEach(async () => {
  vi.resetModules();
  mod = await import("../../../../src/tasks/jira/client");
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
    issuetype: { name: "Story" },
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

  // operation_failed's op attribution (tasksView.ts's resolveOp) needs to recognize
  // a network-level failure as Jira-origin without it becoming a JiraApiError/
  // JiraAuthError (other code branches on those types by `instanceof`). These
  // confirm request() itself — not just a hand-built test fixture — tags both
  // network-level failure shapes for isTaskNetworkError (src/tasks/provider.ts)
  // and classifyFailure alike.
  it("marks an unreachable-host failure as a plain, Jira-origin-tagged Error (not JiraApiError/JiraAuthError)", async () => {
    installFetch([]); // the mocked fetch rejects — see installFetch's own doc comment
    const err = await client().getTransitions("ASM-1").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(mod.JiraApiError);
    expect(err).not.toBeInstanceOf(mod.JiraAuthError);
    expect(isTaskNetworkError(err)).toBe(true);
    expect(err.code).toBe("ENOTFOUND");
    expect(err.message).toMatch(/Couldn't reach Jira at/);
  });

  it("marks a timeout (AbortError) failure the same way, with code ETIMEDOUT", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
    (globalThis as { fetch: unknown }).fetch = fetchMock;
    const err = await client().getTransitions("ASM-1").catch((e) => e);
    expect(err).not.toBeInstanceOf(mod.JiraApiError);
    expect(err).not.toBeInstanceOf(mod.JiraAuthError);
    expect(isTaskNetworkError(err)).toBe(true);
    expect(err.code).toBe("ETIMEDOUT");
    expect(err.message).toMatch(/didn't respond within/);
  });
});

describe("getMyself", () => {
  it("returns account id + display name", async () => {
    installFetch([jsonResponse({ accountId: "a-1", displayName: "Jane" })]);
    expect(await client().getMyself()).toEqual({ accountId: "a-1", displayName: "Jane" });
  });

  // Jira Server/DC, or a proxy that strips the field: the response still names the
  // signed-in user, and that name is what the panel's header chip and every
  // "is this mine?" affordance are built from. Returning null here would take both.
  it("returns the display name even when the response carries no account id", async () => {
    installFetch([jsonResponse({ displayName: "Jane Doe" })]);
    expect(await client().getMyself()).toEqual({ accountId: "", displayName: "Jane Doe" });
  });

  it("returns the account id even when the response carries no display name", async () => {
    installFetch([jsonResponse({ accountId: "a-1" })]);
    expect(await client().getMyself()).toEqual({ accountId: "a-1", displayName: "" });
  });

  it("returns null when the response names nobody at all", async () => {
    installFetch([jsonResponse({})]);
    expect(await client().getMyself()).toBeNull();
  });

  it("returns null (swallowing errors) when the request fails", async () => {
    installFetch([textResponse("", 500)]);
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

  it("degrades to a priority-free sort once every other candidate has failed", async () => {
    // A project with priority hidden or unindexed rejects every candidate that sorts by
    // it. The sort-stripped queries sit LAST in the ladder, so this is only reached
    // after the sprint- and size-stripped ones have already been refused.
    const fetchMock = installFetch([
      jsonResponse(FIELD_LIST),
      textResponse("Field 'priority' does not exist", 400),
      jsonResponse({ issues: [rawIssue()] }),
    ]);
    const tasks = await client().fetchTasks("mine");
    expect(tasks).toHaveLength(1);
    expect(bodyOf(fetchMock, 1).jql).toContain("ORDER BY priority DESC");
    expect(bodyOf(fetchMock, 2).jql).toBe(
      "project = ASM AND statusCategory != Done AND assignee = currentUser() ORDER BY updated DESC",
    );
  });

  it("keeps the priority sort for as long as anything with it still works", async () => {
    // The reverse guard: the sort-stripped variants must never pre-empt a candidate
    // that keeps it. A wrong sort is cosmetic; a wrong filter is a wrong list.
    const fetchMock = installFetch([
      jsonResponse(FIELD_LIST),
      textResponse("no board", 400),
      jsonResponse({ issues: [rawIssue()] }),
    ]);
    await client().fetchTasks("mysprint");
    expect(bodyOf(fetchMock, 2).jql).toContain("ORDER BY priority DESC");
    expect(bodyOf(fetchMock, 2).jql).not.toContain("openSprints()");
  });

  it("asks Jira for the issue type alongside the other list fields", async () => {
    const fetchMock = installFetch([jsonResponse(FIELD_LIST), jsonResponse({ issues: [rawIssue()] })]);
    await client().fetchTasks("mine");
    expect(bodyOf(fetchMock, 1).fields).toContain("issuetype");
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
      type: "Story",
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
      type: "",
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

  it("carries a project's own type name through verbatim", async () => {
    const t = await one(rawIssue({ issuetype: { name: "Spike" } }));
    expect(t.type).toBe("Spike");
  });

  it("carries a sub-task through as the source spells it", async () => {
    const t = await one(rawIssue({ issuetype: { name: "Sub-task" } }));
    expect(t.type).toBe("Sub-task");
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

describe("listComponents", () => {
  it("GETs the project's components and returns their names", async () => {
    const fetchMock = installFetch([jsonResponse([{ id: "1", name: "billing-service" }, { id: "2", name: "Infra" }])]);
    await expect(client().listComponents()).resolves.toEqual(["billing-service", "Infra"]);
    expect(urlOf(fetchMock, 0)).toBe(`${BASE}/rest/api/3/project/ASM/components`);
  });

  // Two separate cases on purpose. The cache is module-level and keyed by project,
  // so a second listComponents() in the same test would be served from the first
  // one's result — asserting both in one `it` would force the cache to be scoped
  // per client instance, and `tasksView.client()` builds a new client per call, so
  // that scope would never hit in production. The file's beforeEach resets modules,
  // which gives each `it` a clean cache.
  it("drops entries with no usable name", async () => {
    installFetch([jsonResponse([{ id: "1" }, { id: "2", name: "" }, { id: "3", name: "Infra" }])]);
    await expect(client().listComponents()).resolves.toEqual(["Infra"]);
  });

  it("tolerates a non-array body", async () => {
    installFetch([jsonResponse({ not: "an array" })]);
    await expect(client().listComponents()).resolves.toEqual([]);
  });

  it("caches the list — a second call inside the TTL does not fetch again", async () => {
    const fetchMock = installFetch([jsonResponse([{ name: "billing-service" }])]);
    const c = client();
    await c.listComponents();
    await expect(c.listComponents()).resolves.toEqual(["billing-service"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not serve one site's components to another site with the same project key", async () => {
    // The cache was keyed by project key alone, so two Jira sites that both define a
    // `ASM` project shared one entry for five minutes and the second site was answered
    // with the first's component names — names its own project would then reject on a
    // write. Keyed by site+project, each gets its own read.
    const fetchMock = installFetch([
      jsonResponse([{ name: "billing-service" }]),
      jsonResponse([{ name: "totally-different" }]),
    ]);
    await new mod.JiraClient("https://a.test", "ASM", fakeAuth()).listComponents();
    await expect(new mod.JiraClient("https://b.test", "ASM", fakeAuth()).listComponents())
      .resolves.toEqual(["totally-different"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refetches once the 5-minute TTL has passed", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = installFetch([
        jsonResponse([{ name: "billing-service" }]),
        jsonResponse([{ name: "billing-service" }, { name: "pricing-api" }]),
      ]);
      const c = client();
      await c.listComponents();
      vi.advanceTimersByTime(5 * 60_000 + 1);
      await expect(c.listComponents()).resolves.toEqual(["billing-service", "pricing-api"]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves to null on failure rather than throwing, and does not cache the failure", async () => {
    const fetchMock = installFetch([textResponse("boom", 500), jsonResponse([{ name: "Infra" }])]);
    const c = client();
    await expect(c.listComponents()).resolves.toBeNull();
    await expect(c.listComponents()).resolves.toEqual(["Infra"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("swallows an auth failure too — the caller reads the issue first, which reports it", async () => {
    installFetch([textResponse("", 401)]);
    await expect(client().listComponents()).resolves.toBeNull();
  });
});

describe("updateComponents", () => {
  it("PUTs an additive add", async () => {
    const fetchMock = installFetch([emptyResponse()]);
    await client().updateComponents("ASM-1", { add: ["billing-service"] });
    expect(urlOf(fetchMock, 0)).toBe(`${BASE}/rest/api/3/issue/ASM-1`);
    expect(fetchMock.mock.calls[0][1].method).toBe("PUT");
    expect(bodyOf(fetchMock, 0)).toEqual({ update: { components: [{ add: { name: "billing-service" } }] } });
  });

  it("PUTs a remove", async () => {
    const fetchMock = installFetch([emptyResponse()]);
    await client().updateComponents("ASM-1", { remove: ["pricing-api"] });
    expect(bodyOf(fetchMock, 0)).toEqual({ update: { components: [{ remove: { name: "pricing-api" } }] } });
  });

  it("PUTs adds before removes in one call", async () => {
    const fetchMock = installFetch([emptyResponse()]);
    await client().updateComponents("ASM-1", { add: ["a"], remove: ["b"] });
    expect(bodyOf(fetchMock, 0)).toEqual({
      update: { components: [{ add: { name: "a" } }, { remove: { name: "b" } }] },
    });
  });

  it("never uses the destructive set verb (which would drop components with no local repo)", async () => {
    const fetchMock = installFetch([emptyResponse()]);
    await client().updateComponents("ASM-1", { add: ["a"] });
    expect(JSON.stringify(bodyOf(fetchMock, 0))).not.toContain("set");
    expect(bodyOf(fetchMock, 0)).not.toHaveProperty("fields");
  });

  it("makes no request at all when there is nothing to change", async () => {
    const fetchMock = installFetch([]);
    await client().updateComponents("ASM-1", {});
    await client().updateComponents("ASM-1", { add: [], remove: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("loadShape", () => {
  const BOARDS = { values: [{ id: 7, type: "kanban" }, { id: 2, type: "scrum" }] };

  it("reads the project's boards and reports a scrum project", async () => {
    const fetchMock = installFetch([jsonResponse(BOARDS)]);
    expect(await client().loadShape()).toEqual({ boardId: 2, hasSprints: true, boardCount: 2 });
    expect(urlOf(fetchMock, 0)).toContain("/rest/agile/1.0/board?projectKeyOrId=ASM");
  });

  it("reports a kanban-only project as sprintless", async () => {
    installFetch([jsonResponse({ values: [{ id: 5, type: "kanban" }] })]);
    expect(await client().loadShape()).toEqual({ boardId: 5, hasSprints: false, boardCount: 1 });
  });

  it("caches the shape — a second call makes no request", async () => {
    const fetchMock = installFetch([jsonResponse(BOARDS)]);
    const c = client();
    await c.loadShape();
    await c.loadShape();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shares the cache across client instances for the same site and project", async () => {
    const fetchMock = installFetch([jsonResponse(BOARDS)]);
    await client().loadShape();
    // A fresh client per operation is the connector's contract (`provider()`), so a
    // cache that did not survive the instance would be no cache at all.
    expect(await client().loadShape()).toEqual({ boardId: 2, hasSprints: true, boardCount: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not answer one project with another project's shape", async () => {
    const fetchMock = installFetch([
      jsonResponse(BOARDS),
      jsonResponse({ values: [{ id: 5, type: "kanban" }] }),
    ]);
    await new mod.JiraClient(BASE, "ASM", fakeAuth()).loadShape();
    expect(await new mod.JiraClient(BASE, "OTHER", fakeAuth()).loadShape())
      .toEqual({ boardId: 5, hasSprints: false, boardCount: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("degrades to the optimistic shape when the board list cannot be read, and does not cache it", async () => {
    // A 404 on the Agile API — Jira Software not installed on the site, or a proxy
    // that does not route /rest/agile — must not be remembered as "this project has no
    // sprints": that would silently strip the sprint tabs off a working Scrum project
    // over one failed request. Optimistic here means claim sprints, exactly as the
    // pre-detection code did, and cache nothing so the next call retries.
    const fetchMock = installFetch([textResponse("no such endpoint", 404), jsonResponse(BOARDS)]);
    const c = client();
    expect(await c.loadShape()).toEqual({ boardId: null, hasSprints: true, boardCount: 0 });
    expect(c.shapeSnapshot()).toBeNull();
    expect(await c.loadShape()).toEqual({ boardId: 2, hasSprints: true, boardCount: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("degrades on a network-level failure too", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));
    (globalThis as { fetch: unknown }).fetch = fetchMock;
    expect(await client().loadShape()).toEqual({ boardId: null, hasSprints: true, boardCount: 0 });
  });

  it("lets an auth failure through — a dead token is not a project shape", async () => {
    // Both 401 and 403 land here, because `request()` classifies each as an auth
    // failure for every endpoint. That means an Agile 403 (a user with no Jira
    // Software licence) re-gates the panel rather than degrading — pre-existing
    // behaviour of `request()`, asserted here so a future reader knows the degrade
    // path above is reachable only for non-auth statuses.
    for (const status of [401, 403]) {
      installFetch([textResponse("", status)]);
      await expect(client().loadShape()).rejects.toBeInstanceOf(mod.JiraAuthError);
    }
  });
});

describe("shapeSnapshot — stale but never forgotten", () => {
  it("keeps answering a sprintless project past the re-read interval", async () => {
    // The regression this guards: while the snapshot expired to null, JiraProvider.caps
    // read that as "nothing known" and returned its optimistic every-lens answer, so a
    // Kanban project's three dead sprint tabs reappeared on the next state post.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      installFetch([jsonResponse({ values: [{ id: 5, type: "kanban" }] })]);
      const c = client();
      await c.loadShape();
      vi.setSystemTime(60 * 60_000); // an hour later, well past SHAPE_TTL_MS
      expect(c.shapeSnapshot()).toEqual({ boardId: 5, hasSprints: false, boardCount: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-reads once stale, and adopts a project that has gained a scrum board", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const fetchMock = installFetch([
        jsonResponse({ values: [{ id: 5, type: "kanban" }] }),
        jsonResponse({ values: [{ id: 5, type: "kanban" }, { id: 9, type: "scrum" }] }),
      ]);
      const c = client();
      expect((await c.loadShape()).hasSprints).toBe(false);
      vi.setSystemTime(60 * 60_000);
      expect((await c.loadShape()).hasSprints).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the stale answer when the re-read fails, rather than re-widening to optimistic", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      installFetch([jsonResponse({ values: [{ id: 5, type: "kanban" }] })]);
      const c = client();
      await c.loadShape();
      vi.setSystemTime(60 * 60_000);
      installFetch([textResponse("upstream exploded", 500)]);
      expect(await c.loadShape()).toEqual({ boardId: 5, hasSprints: false, boardCount: 1 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("shapeSnapshot", () => {
  it("is null before any probe and the shape after one, with no request of its own", async () => {
    const fetchMock = installFetch([jsonResponse({ values: [{ id: 2, type: "scrum" }] })]);
    const c = client();
    expect(c.shapeSnapshot()).toBeNull();
    await c.loadShape();
    expect(c.shapeSnapshot()).toEqual({ boardId: 2, hasSprints: true, boardCount: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("childrenOf", () => {
  it("maps issues to child refs", async () => {
    const issues = [
      { key: "ASM-2", fields: { summary: "one", issuetype: { name: "Sub-task" }, status: { statusCategory: { key: "new" } } } },
      { key: "ASM-3", fields: { summary: "two", issuetype: { name: "Sub-task" }, status: { statusCategory: { key: "done" } } } },
    ];
    installFetch([jsonResponse({ issues })]);
    expect(await client().childrenOf("ASM-1")).toEqual([
      { key: "ASM-2", summary: "one", type: "Sub-task", statusCategory: "new" },
      { key: "ASM-3", summary: "two", type: "Sub-task", statusCategory: "done" },
    ]);
  });

  it("asks only for the three fields a child row needs", async () => {
    const fetchMock = installFetch([jsonResponse({ issues: [{ key: "ASM-9" }] })]);
    await client().childrenOf("ASM-1");
    const body = bodyOf(fetchMock, 0);
    expect(body.fields).toEqual(["summary", "issuetype", "status"]);
    expect(body.jql).toBe('parent = "ASM-1" ORDER BY key ASC');
  });

  it("falls through to the Epic Link candidate when `parent` answers empty", async () => {
    const fetchMock = installFetch([
      jsonResponse({ issues: [] }),
      jsonResponse({ issues: [{ key: "ASM-9" }] }),
    ]);
    const out = await client().childrenOf("ASM-1");
    expect(out.map((c) => c.key)).toEqual(["ASM-9"]);
    expect(fetchMock.mock.calls.map((c) => JSON.parse((c[1] as { body: string }).body).jql)).toEqual([
      'parent = "ASM-1" ORDER BY key ASC',
      '"Epic Link" = "ASM-1" ORDER BY key ASC',
    ]);
  });

  it("returns [] when every candidate answers empty", async () => {
    installFetch([jsonResponse({ issues: [] }), jsonResponse({ issues: [] })]);
    expect(await client().childrenOf("ASM-1")).toEqual([]);
  });

  it("moves to the next candidate when one is rejected, and throws only if all fail", async () => {
    const fetchMock = installFetch([textResponse("", 400), textResponse("", 400)]);
    await expect(client().childrenOf("ASM-1")).rejects.toThrow();
    // Both candidates must actually have been attempted — without this the test
    // passes even if the ladder gave up after the first rejection.
    expect(fetchMock.mock.calls).toHaveLength(2);
  });

  it("rethrows an auth failure immediately instead of trying the next candidate", async () => {
    const fetchMock = installFetch([textResponse("", 401)]);
    await expect(client().childrenOf("ASM-1")).rejects.toBeInstanceOf(mod.JiraAuthError);
    expect(fetchMock.mock.calls).toHaveLength(1);
  });

  it("tolerates an issue with no summary, type or status", async () => {
    installFetch([jsonResponse({ issues: [{ key: "ASM-4" }] })]);
    expect(await client().childrenOf("ASM-1")).toEqual([
      { key: "ASM-4", summary: "", type: "", statusCategory: null },
    ]);
  });
});

describe("getActiveSprintId — board reuse", () => {
  it("reuses an already-probed board instead of listing boards again", async () => {
    const fetchMock = installFetch([
      jsonResponse({ values: [{ id: 7, type: "kanban" }, { id: 2, type: "scrum" }] }),
      jsonResponse({ values: [{ id: 99 }] }),
    ]);
    const c = client();
    await c.loadShape();
    expect(await c.getActiveSprintId()).toBe(99);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urlOf(fetchMock, 1)).toContain("/board/2/sprint");
  });

  it("returns null without a sprint request when the project has no board", async () => {
    const fetchMock = installFetch([jsonResponse({ values: [] })]);
    const c = client();
    await c.loadShape();
    expect(await c.getActiveSprintId()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws when the board list cannot be read, rather than reporting 'no active sprint'", async () => {
    // The caller (addToMySprint in tasksView.ts) turns a null into the toast "No
    // active sprint on the X board." Answering null for a request that never arrived
    // would state something confident and false about the user's Jira, so the read
    // failure has to surface here — the pre-detection behaviour.
    installFetch([textResponse("upstream exploded", 500)]);
    await expect(client().getActiveSprintId()).rejects.toThrow();
  });

  it("still reports a genuinely board-less project as null, not an error", async () => {
    installFetch([jsonResponse({ values: [] })]);
    expect(await client().getActiveSprintId()).toBeNull();
  });

  it("does not consume loadShape's degraded answer when it has one", async () => {
    // loadShape swallows a non-auth failure into { boardId: null, hasSprints: true }
    // and caches nothing. getActiveSprintId must not read that as "no board" — it
    // must go and ask, and fail if the answer still is not there.
    const c = client();
    installFetch([textResponse("upstream exploded", 500)]);
    expect(await c.loadShape()).toEqual({ boardId: null, hasSprints: true, boardCount: 0 });
    installFetch([textResponse("upstream exploded", 500)]);
    await expect(c.getActiveSprintId()).rejects.toThrow();
  });
});
