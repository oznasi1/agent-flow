import { describe, expect, it, vi } from "vitest";
import { JiraProvider } from "../../../../src/tasks/jira/provider";
import { JiraApiError } from "../../../../src/tasks/jira/errors";
import { TaskWriteError } from "../../../../src/tasks/provider";

const client = (over: Record<string, unknown> = {}) =>
  ({
    fetchTasks: vi.fn(async () => []),
    getDetail: vi.fn(async () => ({ key: "A-1" })),
    getStatus: vi.fn(async () => ({ status: "Open", category: "new" })),
    getTransitions: vi.fn(async () => []),
    transition: vi.fn(async () => undefined),
    getMyself: vi.fn(async () => ({ accountId: "acc", displayName: "Me" })),
    assignIssue: vi.fn(async () => undefined),
    listResolutions: vi.fn(async () => []),
    ...over,
  }) as never;

describe("JiraProvider", () => {
  it("declares every optional capability", () => {
    const caps = new JiraProvider(client()).caps;
    expect(caps.labels).toBeDefined();
    expect(caps.sprints).toBeDefined();
    expect(caps.components).toBeDefined();
    expect(caps.sizes).toBe(true);
    expect([...caps.supportedFilters].sort()).toEqual(
      ["all", "backlog", "mine", "mysprint", "sprint", "unassigned"],
    );
  });

  it("normalizes transitions into StatusTargets with generic field prompts", async () => {
    const c = client({
      getTransitions: vi.fn(async () => [
        {
          id: "31", name: "Start", toName: "In Progress", toCategory: "indeterminate",
          fields: { resolution: { required: true, name: "Resolution", allowedValues: [{ id: "1", name: "Done" }] } },
        },
      ]),
    });
    const [t] = await new JiraProvider(c).statusTargets("A-1");
    expect(t).toMatchObject({ id: "31", toName: "In Progress", toCategory: "indeterminate", via: "Start" });
    expect(t.fields).toEqual([
      { kind: "pick", id: "resolution", name: "Resolution", choices: [{ id: "1", name: "Done" }] },
    ]);
  });

  it("omits `via` when the transition name matches the destination", async () => {
    const c = client({
      getTransitions: vi.fn(async () => [
        { id: "1", name: "Done", toName: "Done", toCategory: "done", fields: {} },
      ]),
    });
    expect((await new JiraProvider(c).statusTargets("A-1"))[0].via).toBeUndefined();
  });

  it("maps raw prompt answers to Jira's wire shape", async () => {
    const transition = vi.fn(async () => undefined);
    const c = client({
      transition,
      getTransitions: vi.fn(async () => [
        {
          id: "31", name: "Go", toName: "Go", toCategory: "",
          fields: { resolution: { required: true, name: "Resolution", allowedValues: [{ id: "9", name: "Fixed" }] } },
        },
      ]),
    });
    const p = new JiraProvider(c);
    await p.statusTargets("A-1"); // caches the field metadata
    await p.moveTo("A-1", "31", { resolution: "Fixed" });
    expect(transition).toHaveBeenCalledWith("A-1", "31", { resolution: { id: "9" } });
  });

  it("turns a rejection naming a known field into a TaskWriteError carrying it", async () => {
    const c = client({
      getTransitions: vi.fn(async () => [
        {
          id: "31", name: "Go", toName: "Go", toCategory: "",
          fields: { customfield_1: { required: false, name: "Impact", schema: { type: "string" } } },
        },
      ]),
      transition: vi.fn(async () => {
        throw new JiraApiError(400, "bad", { customfield_1: "required" }, []);
      }),
    });
    const p = new JiraProvider(c);
    await p.statusTargets("A-1");
    const err = await p.moveTo("A-1", "31", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TaskWriteError);
    expect((err as TaskWriteError).retryWith).toEqual([
      { kind: "text", id: "customfield_1", name: "Impact" },
    ]);
  });

  it("throws an empty-retryWith TaskWriteError when nothing can be re-prompted", async () => {
    const c = client({
      getTransitions: vi.fn(async () => [{ id: "31", name: "Go", toName: "Go", toCategory: "", fields: {} }]),
      transition: vi.fn(async () => {
        throw new JiraApiError(403, "no", {}, ["You lack permission."]);
      }),
    });
    const p = new JiraProvider(c);
    await p.statusTargets("A-1");
    const err = (await p.moveTo("A-1", "31", {}).catch((e: unknown) => e)) as TaskWriteError;
    expect(err).toBeInstanceOf(TaskWriteError);
    expect(err.retryWith).toEqual([]);
    expect(err.message).toContain("You lack permission.");
  });

  it("falls back to the site resolution list when a rejection blames Resolution", async () => {
    const c = client({
      getTransitions: vi.fn(async () => [{ id: "31", name: "Go", toName: "Go", toCategory: "", fields: {} }]),
      transition: vi.fn(async () => {
        throw new JiraApiError(400, "x", {}, ["Resolution is required."]);
      }),
      listResolutions: vi.fn(async () => [{ id: "1", name: "Done" }]),
    });
    const p = new JiraProvider(c);
    await p.statusTargets("A-1");
    const err = (await p.moveTo("A-1", "31", {}).catch((e: unknown) => e)) as TaskWriteError;
    expect(err.retryWith).toEqual([
      { kind: "pick", id: "resolution", name: "Resolution", choices: [{ id: "1", name: "Done" }] },
    ]);
  });

  // The bug this guards: `resolution` is not in the transition's screen metadata,
  // so a moveTo that re-derived its prompts from that metadata would drop the
  // answer and POST the retry without it — asking the user for a Resolution and
  // then failing for the same reason. Asserting the retryWith SHAPE is not
  // enough; the value has to survive the round trip to the wire.
  it("sends the synthesized Resolution on the retry, not just in retryWith", async () => {
    const transition = vi.fn()
      .mockRejectedValueOnce(new JiraApiError(400, "x", {}, ["Resolution is required."]))
      .mockResolvedValueOnce(undefined);
    const c = client({
      transition,
      getTransitions: vi.fn(async () => [{ id: "31", name: "Go", toName: "Go", toCategory: "", fields: {} }]),
      listResolutions: vi.fn(async () => [{ id: "5", name: "Done" }]),
    });
    const p = new JiraProvider(c);
    await p.statusTargets("A-1");

    const err = (await p.moveTo("A-1", "31", {}).catch((e: unknown) => e)) as TaskWriteError;
    expect(err.retryWith[0]).toMatchObject({ id: "resolution", kind: "pick" });

    // The view now re-prompts and retries with the collected answer.
    await p.moveTo("A-1", "31", { resolution: "Done" });
    expect(transition).toHaveBeenCalledTimes(2);
    expect(transition.mock.calls[1][2]).toEqual({ resolution: { id: "5" } });
  });

  it("assigns via the resolved account id", async () => {
    const assignIssue = vi.fn(async () => undefined);
    await new JiraProvider(client({ assignIssue })).assignToMe("A-1");
    expect(assignIssue).toHaveBeenCalledWith("A-1", "acc");
  });

  it("uses a caller's already-resolved id instead of looking the account up again", async () => {
    const assignIssue = vi.fn(async () => undefined);
    const getMyself = vi.fn(async () => ({ accountId: "acc", displayName: "Me" }));
    await new JiraProvider(client({ assignIssue, getMyself })).assignToMe("A-1", "pre-resolved");
    expect(assignIssue).toHaveBeenCalledWith("A-1", "pre-resolved");
    // The point of the parameter: a caller that pairs this with another write must not
    // be exposed to a second lookup answering differently from its first.
    expect(getMyself).not.toHaveBeenCalled();
  });

  it("refuses a blank pre-resolved id rather than unassigning the issue", async () => {
    // Jira reads an empty assignee as "unassign" — the opposite of this method's
    // promise — so a caller's empty string must fail, not fall through to a lookup.
    const assignIssue = vi.fn(async () => undefined);
    const p = new JiraProvider(client({ assignIssue }));
    await expect(p.assignToMe("A-1", "")).rejects.toThrow(/account/i);
    expect(assignIssue).not.toHaveBeenCalled();
  });

  it("carries the required fields it could not turn into prompts, and omits the field when there are none", async () => {
    const c = client({
      getTransitions: vi.fn(async () => [
        {
          id: "81", name: "Close", toName: "Closed", toCategory: "done",
          fields: {
            description: { required: true, name: "Description", schema: { type: "string", system: "description" } },
            resolution: { required: true, name: "Resolution", allowedValues: [{ id: "1", name: "Done" }] },
          },
        },
        { id: "31", name: "Start", toName: "In Progress", toCategory: "indeterminate", fields: {} },
      ]),
    });
    const [closed, start] = await new JiraProvider(c).statusTargets("A-1");
    // Required, unpromptable (a rich-text system field) — declared so the view can log
    // that nobody was asked before the write.
    expect(closed.unfillable).toEqual(["Description"]);
    // …and it is NOT double-counted as a prompt.
    expect(closed.fields.map((f) => f.id)).toEqual(["resolution"]);
    // Absent rather than [] when everything mapped, so the property means one thing.
    expect(start.unfillable).toBeUndefined();
  });

  it("carries the refusal's transport status on the TaskWriteError", async () => {
    const c = client({
      getTransitions: vi.fn(async () => [
        { id: "31", name: "Go", toName: "Go", toCategory: "", fields: {} },
      ]),
      transition: vi.fn(async () => {
        throw new JiraApiError(403, "Forbidden", {}, ["You do not have permission"]);
      }),
    });
    const p = new JiraProvider(c);
    await p.statusTargets("A-1");
    const err = (await p.moveTo("A-1", "31", {}).catch((e: unknown) => e)) as TaskWriteError;
    // 403 vs 400 is "you may not" vs "that was malformed"; the prose says neither.
    expect(err.status).toBe(403);
  });

  it("refuses to assign when the account cannot be resolved", async () => {
    const assignIssue = vi.fn(async () => undefined);
    const p = new JiraProvider(client({ assignIssue, getMyself: vi.fn(async () => null) }));
    await expect(p.assignToMe("A-1")).rejects.toThrow(/account/i);
    expect(assignIssue).not.toHaveBeenCalled();
  });

  it("resolves an identity from a display name alone, and still refuses to assign with it", async () => {
    // A /myself with a name but no accountId — Jira Server/DC, or a proxy that strips
    // the field. The name is what the panel's header chip and the "is this mine?"
    // affordances need, so it must survive; the write side is what has to refuse.
    const assignIssue = vi.fn(async () => undefined);
    const p = new JiraProvider(
      client({ assignIssue, getMyself: vi.fn(async () => ({ accountId: "", displayName: "Jane" })) }),
    );
    expect(await p.me()).toEqual({ id: "", displayName: "Jane" });
    await expect(p.assignToMe("A-1")).rejects.toThrow(/account/i);
    expect(assignIssue).not.toHaveBeenCalled();
  });

  // Transition ids are scoped to a Jira *workflow*, not to an issue: two issues
  // sharing a workflow have the identical id "31". A cache keyed by id alone
  // would let A-1's cached allowedValues answer for B-2's moveTo, silently
  // sending B-2 the wrong wire id for "High" (A-1's "1" instead of B-2's "2").
  // The two issues are given DIFFERENT ids for the same label on purpose: an
  // id-only cache would produce a visibly wrong payload here, not merely an
  // equal one, so a test that only compared shapes could pass under the bug.
  it("does not build one issue's write from another issue's cached mapping on a shared workflow", async () => {
    const transition = vi.fn(async () => undefined);
    const getTransitions = vi.fn(async (key: string) => [
      {
        id: "31", name: "Go", toName: "Go", toCategory: "",
        fields: {
          priority: {
            required: true, name: "Priority",
            allowedValues: [{ id: key === "A-1" ? "1" : "2", name: "High" }],
          },
        },
      },
    ]);
    const p = new JiraProvider(client({ getTransitions, transition }));

    await p.statusTargets("A-1");
    // B-2's own statusTargets() was never called on this instance. Whatever
    // happens, it must not silently transition B-2 using A-1's id "1".
    await expect(p.moveTo("B-2", "31", { priority: "High" })).rejects.toThrow();
    expect(transition).not.toHaveBeenCalled();
  });

  it("throws, naming the issue and transition, when values are supplied but nothing was remembered for them", async () => {
    const p = new JiraProvider(client());
    await expect(p.moveTo("A-1", "31", { priority: "High" })).rejects.toThrow(/A-1/);
    await expect(p.moveTo("A-1", "31", { priority: "High" })).rejects.toThrow(/31/);
  });

  it("succeeds silently on a fieldless transition called with no values", async () => {
    const transition = vi.fn(async () => undefined);
    const c = client({
      transition,
      getTransitions: vi.fn(async () => [{ id: "31", name: "Go", toName: "Go", toCategory: "", fields: {} }]),
    });
    const p = new JiraProvider(c);
    await p.statusTargets("A-1");
    await expect(p.moveTo("A-1", "31", {})).resolves.toBeUndefined();
    expect(transition).toHaveBeenCalledWith("A-1", "31", {});
  });
});

describe("caps — narrowing to the detected project shape", () => {
  const withShape = (shape: unknown) =>
    new JiraProvider(client({ shapeSnapshot: () => shape, loadShape: vi.fn(async () => shape) }));

  it("claims every lens and sprints before any probe has run", () => {
    // The inert case, and the one that matters most: an un-probed provider must be
    // identical to the pre-detection provider, because that is what every other test
    // in the suite — and every first paint — sees.
    const p = withShape(null);
    expect(p.caps.supportedFilters).toEqual(["unassigned", "mine", "mysprint", "sprint", "backlog", "all"]);
    expect(p.caps.sprints).toBeTruthy();
    expect(p.caps.sizes).toBe(true);
    expect(p.caps.labels).toBeTruthy();
    expect(p.caps.components).toBeTruthy();
  });

  it("keeps every lens and sprints on a scrum project", () => {
    const p = withShape({ boardId: 2, hasSprints: true, boardCount: 1 });
    expect(p.caps.supportedFilters).toEqual(["unassigned", "mine", "mysprint", "sprint", "backlog", "all"]);
    expect(p.caps.sprints).toBeTruthy();
  });

  it("drops the sprint-shaped lenses and sprints on a project with no scrum board", () => {
    const p = withShape({ boardId: 5, hasSprints: false, boardCount: 1 });
    expect(p.caps.supportedFilters).toEqual(["unassigned", "mine", "all"]);
    expect(p.caps.sprints).toBeUndefined();
  });

  it("keeps `unassigned` on a sprintless project — stripSprint makes it 'all open, nobody on it'", () => {
    expect(withShape({ boardId: null, hasSprints: false, boardCount: 0 }).caps.supportedFilters)
      .toContain("unassigned");
  });

  it("keeps sizes, labels and components on a sprintless project — none are sprint-shaped", () => {
    const p = withShape({ boardId: null, hasSprints: false, boardCount: 0 });
    expect(p.caps.sizes).toBe(true);
    expect(p.caps.labels).toBeTruthy();
    expect(p.caps.components).toBeTruthy();
  });

  it("re-reads the snapshot on every access, so a probe mid-session is picked up", () => {
    let shape: unknown = null;
    const p = new JiraProvider(client({ shapeSnapshot: () => shape }));
    expect(p.caps.sprints).toBeTruthy();
    shape = { boardId: 5, hasSprints: false, boardCount: 1 };
    expect(p.caps.sprints).toBeUndefined();
  });

  it("still routes the sprint operations to the client when it declares them", async () => {
    // Narrowing must not break the capability it keeps: a scrum project's sprints
    // object has to remain wired to the same three client calls it always was.
    const getActiveSprintId = vi.fn(async () => 42);
    const addIssueToSprint = vi.fn(async () => undefined);
    const removeIssueFromSprint = vi.fn(async () => undefined);
    const p = new JiraProvider(client({
      shapeSnapshot: () => ({ boardId: 2, hasSprints: true, boardCount: 1 }),
      getActiveSprintId, addIssueToSprint, removeIssueFromSprint,
    }));
    expect(await p.caps.sprints!.activeId()).toBe("42");
    await p.caps.sprints!.add("7", "A-1");
    await p.caps.sprints!.remove("A-1");
    expect(addIssueToSprint).toHaveBeenCalledWith(7, "A-1");
    expect(removeIssueFromSprint).toHaveBeenCalledWith("A-1");
  });

  it("reports a null active sprint as null rather than the string 'null'", async () => {
    const p = new JiraProvider(client({
      shapeSnapshot: () => ({ boardId: 2, hasSprints: true, boardCount: 1 }),
      getActiveSprintId: vi.fn(async () => null),
    }));
    expect(await p.caps.sprints!.activeId()).toBeNull();
  });
});

describe("caps.children", () => {
  it("is present and delegates to the client when the client can answer", async () => {
    const childrenOf = vi.fn(async () => [
      { key: "ASM-2", summary: "child", type: "Sub-task", statusCategory: "new" as const },
    ]);
    const provider = new JiraProvider(client({ childrenOf }));
    expect(await provider.caps.children!.of("ASM-1")).toEqual([
      { key: "ASM-2", summary: "child", type: "Sub-task", statusCategory: "new" },
    ]);
    expect(childrenOf).toHaveBeenCalledWith("ASM-1");
  });

  it("is absent when the client has no childrenOf — a partial client must not claim the capability", () => {
    const provider = new JiraProvider(client());
    expect(provider.caps.children).toBeUndefined();
  });
});

describe("refreshCaps", () => {
  it("loads the shape", async () => {
    const loadShape = vi.fn(async () => ({ boardId: 2, hasSprints: true, boardCount: 1 }));
    await new JiraProvider(client({ loadShape, shapeSnapshot: () => null })).refreshCaps();
    expect(loadShape).toHaveBeenCalledTimes(1);
  });

  it("swallows a failure — an unreadable board list must not fail the panel's first paint", async () => {
    const loadShape = vi.fn(async () => { throw new Error("boom"); });
    await expect(
      new JiraProvider(client({ loadShape, shapeSnapshot: () => null })).refreshCaps(),
    ).resolves.toBeUndefined();
  });

  it("survives a client that has no loadShape at all (a wholesale test mock)", async () => {
    await expect(new JiraProvider({} as never).refreshCaps()).resolves.toBeUndefined();
  });

  it("leaves caps optimistic when the client cannot answer", async () => {
    const p = new JiraProvider({} as never);
    await p.refreshCaps();
    expect(p.caps.sprints).toBeTruthy();
    expect(p.caps.supportedFilters).toContain("mysprint");
  });
});
