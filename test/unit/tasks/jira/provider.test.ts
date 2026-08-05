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

  it("refuses to assign when the account cannot be resolved", async () => {
    const assignIssue = vi.fn(async () => undefined);
    const p = new JiraProvider(client({ assignIssue, getMyself: vi.fn(async () => null) }));
    await expect(p.assignToMe("A-1")).rejects.toThrow(/account/i);
    expect(assignIssue).not.toHaveBeenCalled();
  });
});
