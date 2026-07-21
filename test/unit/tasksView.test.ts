import { describe, it, expect, vi, beforeEach } from "vitest";
import { commands, env, window } from "../_mocks/vscode";
import { fakeAuth, fakeContext, mkRepos } from "../_helpers/factories";

// ── sibling modules the controller depends on ──────────────────────────────
vi.mock("../../src/config", () => ({ getConfig: vi.fn() }));
vi.mock("../../src/engine/repos", () => ({ discoverRepos: vi.fn() }));
vi.mock("../../src/engine/workspace", () => ({ openWorkspace: vi.fn(), listWorkspaceFiles: vi.fn(() => []) }));
vi.mock("../../src/engine/worktree", () => ({ createWorktrees: vi.fn((s: unknown) => s) }));
vi.mock("../../src/jira/client", () => {
  class JiraAuthError extends Error {}
  return { JiraAuthError, JiraClient: vi.fn() };
});

import { getConfig } from "../../src/config";
import { discoverRepos } from "../../src/engine/repos";
import { openWorkspace, listWorkspaceFiles } from "../../src/engine/workspace";
import { createWorktrees } from "../../src/engine/worktree";
import { JiraClient, JiraAuthError } from "../../src/jira/client";
import { TasksViewProvider } from "../../src/tasksView";
import type { InboundMessage, OutboundMessage } from "../../src/types";
import { SLACK_DM_SENTENCE } from "../../src/engine/prompt";

const CFG = {
  baseUrl: "https://jira",
  project: "ASM",
  reposRoot: "/repos",
  workspaceDir: "/ws",
  githubOrg: "org",
  repoBlocklist: [] as string[],
  defaultFilter: "unassigned",
  seedAgent: true,
  workspaceMode: "auto" as const,
  openIn: "new-window" as const,
  taskMode: "plan",
  promptModes: [{ id: "plan", label: "Plan", prompt: "P {key}" }],
  exploreMode: "ask",
  exploreActions: [
    { id: "jiraTicket", label: "Open a Jira ticket", prompt: "JT {summary}{files}", slackDm: false },
    { id: "knowledge", label: "Enhance knowledge / flow", prompt: "Explore {summary}{files}", slackDm: false },
    { id: "debug", label: "Debug", prompt: "DBG {summary}{files}", slackDm: false },
    { id: "general", label: "General", prompt: "GEN {summary}{files}", slackDm: false },
  ],
  worktree: "never" as const,
  stampLabelOnWrite: true,
  provenanceLabel: "claude-code",
};

let clientStub: Record<string, ReturnType<typeof vi.fn>>;

function makeClient() {
  return {
    currentUserName: vi.fn(async () => "Jane"),
    getMyself: vi.fn(async () => ({ accountId: "a1", displayName: "Jane" })),
    fetchTasks: vi.fn(async () => []),
    getDetail: vi.fn(async () => ({
      key: "ASM-1",
      summary: "Do the thing",
      descriptionText: "desc",
      labels: [],
      components: [],
      url: "https://jira/browse/ASM-1",
    })),
    getTransitions: vi.fn(async () => [] as unknown[]),
    transition: vi.fn(async () => undefined),
    addLabel: vi.fn(async () => undefined),
    getActiveSprintId: vi.fn(async () => 42),
    addIssueToSprint: vi.fn(async () => undefined),
    assignIssue: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  clientStub = makeClient();
  vi.mocked(getConfig).mockReturnValue({ ...CFG });
  vi.mocked(discoverRepos).mockReturnValue(mkRepos(["account-service", "centaur"]));
  vi.mocked(JiraClient).mockImplementation(() => clientStub as unknown as JiraClient);
  vi.mocked(openWorkspace).mockResolvedValue({
    mode: "per-window",
    workspaceFile: undefined,
    briefs: [],
    opened: ["/repos/account-service"],
  });
});

/** Instantiate the provider and capture its webview message handler + post spy. */
function setup(opts: { authed?: boolean; workspaceState?: Record<string, unknown> } = {}) {
  const { context, workspaceState, globalState } = fakeContext({ workspaceState: opts.workspaceState });
  const auth = fakeAuth({ authed: opts.authed ?? true });
  const provider = new TasksViewProvider(context, auth);
  const post = vi.fn();
  let handler: (m: InboundMessage) => Promise<void> = async () => {};
  const view = {
    webview: {
      options: {},
      html: "",
      asWebviewUri: (u: unknown) => u,
      cspSource: "vscode-resource:",
      postMessage: post,
      onDidReceiveMessage: (cb: (m: InboundMessage) => Promise<void>) => {
        handler = cb;
        return { dispose() {} };
      },
    },
  };
  provider.resolveWebviewView(view as never);
  const send = (m: InboundMessage) => handler(m);
  const posted = () => post.mock.calls.map((c) => c[0] as OutboundMessage);
  return { provider, post, send, posted, auth, workspaceState, globalState };
}

describe("ready", () => {
  it("reports authed state with the current user and auto-fetches", async () => {
    const { send, posted } = setup({ authed: true });
    await send({ type: "ready" });
    expect(posted()).toContainEqual({ type: "state", authed: true, configured: true, project: "ASM", me: "Jane" });
    expect(clientStub.fetchTasks).toHaveBeenCalled();
  });

  it("reports unauthed state and does not fetch", async () => {
    const { send, posted } = setup({ authed: false });
    await send({ type: "ready" });
    expect(posted()).toContainEqual({ type: "state", authed: false, configured: true, project: "ASM", me: null });
    expect(clientStub.fetchTasks).not.toHaveBeenCalled();
  });

  it("reports not-configured (and does not fetch) when the site URL / project are unset", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, baseUrl: "", project: "" });
    const { send, posted } = setup({ authed: true });
    await send({ type: "ready" });
    expect(posted()).toContainEqual({ type: "state", authed: true, configured: false, project: "", me: null });
    expect(clientStub.fetchTasks).not.toHaveBeenCalled();
  });

  it("posts state up-front and still loads tasks when the display-name lookup fails", async () => {
    clientStub.currentUserName.mockRejectedValue(new Error("myself 500"));
    const { send, posted } = setup({ authed: true });
    await send({ type: "ready" });
    // A state is posted before (and regardless of) the /myself round-trip…
    expect(posted()).toContainEqual({ type: "state", authed: true, configured: true, project: "ASM", me: null });
    // …and the task list — the real payload — still loads.
    expect(clientStub.fetchTasks).toHaveBeenCalled();
  });

  it("re-establishes state and fetches on retry", async () => {
    const { send, posted } = setup({ authed: true });
    await send({ type: "retry" });
    expect(posted()).toContainEqual({ type: "state", authed: true, configured: true, project: "ASM", me: "Jane" });
    expect(clientStub.fetchTasks).toHaveBeenCalled();
  });

  it("routes runSetup to the setup command", async () => {
    const { send } = setup();
    await send({ type: "runSetup" });
    expect(commands.executeCommand).toHaveBeenCalledWith("agentFlow.setup");
  });
});

describe("fetch", () => {
  it("does not fetch when unauthenticated", async () => {
    const { send, posted } = setup({ authed: false });
    await send({ type: "fetch", filter: "mine", size: "any" });
    expect(clientStub.fetchTasks).not.toHaveBeenCalled();
    expect(posted()).toContainEqual({ type: "state", authed: false, configured: true, project: "ASM", me: null });
  });

  it("toggles loading and posts tasks with a services guess", async () => {
    clientStub.fetchTasks.mockResolvedValue([
      { key: "ASM-1", summary: "s", labels: [], components: [] },
    ]);
    const { send, posted } = setup();
    await send({ type: "fetch", filter: "mine", size: "any" });
    expect(clientStub.fetchTasks).toHaveBeenCalledWith("mine", "any");
    const tasksMsg = posted().find((m) => m.type === "tasks");
    expect(tasksMsg).toBeTruthy();
    expect((tasksMsg as { tasks: { services?: string[] }[] }).tasks[0].services).toBeDefined();
    expect(posted().filter((m) => m.type === "loading")).toEqual([
      { type: "loading", loading: true },
      { type: "loading", loading: false },
    ]);
  });

  it("prunes then sorts by saved order in the full My-sprint view", async () => {
    clientStub.fetchTasks.mockResolvedValue([
      { key: "A", summary: "", labels: [], components: [] },
      { key: "B", summary: "", labels: [], components: [] },
      { key: "C", summary: "", labels: [], components: [] },
    ]);
    const { send, posted, workspaceState } = setup({ workspaceState: { "agentFlow.sprintOrder": ["B", "A"] } });
    await send({ type: "fetch", filter: "mysprint", size: "any" });
    // pruneOrder(["B","A"], present) keeps ["B","A"]; persisted back
    expect(workspaceState.update).toHaveBeenCalledWith("agentFlow.sprintOrder", ["B", "A"]);
    const tasksMsg = posted().find((m) => m.type === "tasks") as { tasks: { key: string }[] };
    expect(tasksMsg.tasks.map((t) => t.key)).toEqual(["B", "A", "C"]);
  });

  it("sorts but does not prune under a size lens", async () => {
    clientStub.fetchTasks.mockResolvedValue([{ key: "A", summary: "", labels: [], components: [] }]);
    const { send, workspaceState } = setup({ workspaceState: { "agentFlow.sprintOrder": ["A"] } });
    await send({ type: "fetch", filter: "mysprint", size: "s" });
    expect(workspaceState.update).not.toHaveBeenCalled();
  });
});

describe("reorder", () => {
  it("is ignored outside the My-sprint lens", async () => {
    const { send, workspaceState } = setup();
    await send({ type: "fetch", filter: "unassigned", size: "any" }); // lastFilter = unassigned
    await send({ type: "reorder", order: ["C", "A", "B"] });
    expect(workspaceState.update).not.toHaveBeenCalled();
  });

  it("persists the applied order within the My-sprint lens", async () => {
    const { send, workspaceState } = setup();
    await send({ type: "fetch", filter: "mysprint", size: "any" }); // lastFilter = mysprint
    await send({ type: "reorder", order: ["C", "A", "B"] });
    expect(workspaceState.update).toHaveBeenLastCalledWith("agentFlow.sprintOrder", ["C", "A", "B"]);
  });
});

describe("resetOrder", () => {
  it("clears the saved order and refetches My sprint", async () => {
    const { send, workspaceState } = setup({ workspaceState: { "agentFlow.sprintOrder": ["A", "B"] } });
    await send({ type: "resetOrder", size: "any" });
    expect(workspaceState.update).toHaveBeenCalledWith("agentFlow.sprintOrder", []);
    expect(clientStub.fetchTasks).toHaveBeenCalledWith("mysprint", "any");
  });
});

describe("changeStatus", () => {
  it("shows an info toast when there are no transitions", async () => {
    clientStub.getTransitions.mockResolvedValue([]);
    const { provider, posted } = setup();
    await provider.changeStatus("ASM-1");
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "info" }));
    expect(clientStub.transition).not.toHaveBeenCalled();
  });

  it("does nothing when the pick is cancelled", async () => {
    clientStub.getTransitions.mockResolvedValue([
      { id: "31", name: "Start", toName: "In Progress", toCategory: "indeterminate" },
    ]);
    vi.mocked(window.showQuickPick).mockResolvedValue(undefined);
    const { provider } = setup();
    await provider.changeStatus("ASM-1");
    expect(clientStub.transition).not.toHaveBeenCalled();
  });

  it("transitions, stamps the claude-code label, and reports removal for a done status", async () => {
    clientStub.getTransitions.mockResolvedValue([
      { id: "41", name: "Resolve", toName: "Done", toCategory: "done" },
    ]);
    vi.mocked(window.showQuickPick).mockResolvedValue({
      t: { id: "41", name: "Resolve", toName: "Done", toCategory: "done" },
    } as never);
    const { provider, posted } = setup();
    await provider.changeStatus("ASM-1");
    expect(clientStub.transition).toHaveBeenCalledWith("ASM-1", "41");
    expect(clientStub.addLabel).toHaveBeenCalledWith("ASM-1", "claude-code");
    expect(posted()).toContainEqual({
      type: "statusChanged",
      key: "ASM-1",
      status: "Done",
      category: "done",
      removed: true,
    });
  });

  it("does not stamp the label when disabled", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, stampLabelOnWrite: false });
    clientStub.getTransitions.mockResolvedValue([
      { id: "31", name: "Start", toName: "In Progress", toCategory: "indeterminate" },
    ]);
    vi.mocked(window.showQuickPick).mockResolvedValue({
      t: { id: "31", name: "Start", toName: "In Progress", toCategory: "indeterminate" },
    } as never);
    const { provider } = setup();
    await provider.changeStatus("ASM-1");
    expect(clientStub.addLabel).not.toHaveBeenCalled();
  });

  it("still succeeds when the label stamp fails", async () => {
    clientStub.getTransitions.mockResolvedValue([
      { id: "31", name: "Start", toName: "In Progress", toCategory: "indeterminate" },
    ]);
    clientStub.addLabel.mockRejectedValue(new Error("label denied"));
    vi.mocked(window.showQuickPick).mockResolvedValue({
      t: { id: "31", name: "Start", toName: "In Progress", toCategory: "indeterminate" },
    } as never);
    const { provider, posted } = setup();
    await provider.changeStatus("ASM-1");
    expect(posted()).toContainEqual(expect.objectContaining({ type: "statusChanged", key: "ASM-1" }));
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "success" }));
  });
});

describe("addToMySprint", () => {
  it("errors when the account cannot be resolved", async () => {
    clientStub.getMyself.mockResolvedValue(null);
    const { provider, posted } = setup();
    await provider.addToMySprint("ASM-1");
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "error" }));
    expect(clientStub.addIssueToSprint).not.toHaveBeenCalled();
  });

  it("errors when there is no active sprint", async () => {
    clientStub.getActiveSprintId.mockResolvedValue(null);
    const { provider, posted } = setup();
    await provider.addToMySprint("ASM-1");
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "error" }));
    expect(clientStub.addIssueToSprint).not.toHaveBeenCalled();
  });

  it("adds to sprint, assigns, stamps the label, and reports removal from unassigned", async () => {
    const { provider, posted, send } = setup();
    await send({ type: "fetch", filter: "unassigned", size: "any" }); // lastFilter = unassigned
    await provider.addToMySprint("ASM-1");
    expect(clientStub.addIssueToSprint).toHaveBeenCalledWith(42, "ASM-1");
    expect(clientStub.assignIssue).toHaveBeenCalledWith("ASM-1", "a1");
    expect(clientStub.addLabel).toHaveBeenCalledWith("ASM-1", "claude-code");
    expect(posted()).toContainEqual({ type: "movedToSprint", key: "ASM-1", assignee: "Jane", removed: true });
  });
});

describe("explore", () => {
  it("prompts for an action when exploreMode is 'ask' and seeds the chosen action's prompt", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "ask" });
    const repos = mkRepos(["account-service", "centaur"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("retry logic");
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ action: CFG.exploreActions[2] } as never) // action picker → Debug
      .mockResolvedValueOnce([{ repo: repos[0] }, { repo: repos[1] }] as never); // repo picker
    const { send } = setup();
    await send({ type: "explore" });
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ promptTemplate: "DBG {summary}{files}" }),
    );
  });

  it("uses the configured action directly and skips the action picker", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "jiraTicket" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("focus");
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never); // only the repo picker
    const { send } = setup();
    await send({ type: "explore" });
    expect(window.showQuickPick).toHaveBeenCalledTimes(1);
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ promptTemplate: "JT {summary}{files}" }),
    );
  });

  it("falls back to the action picker when the configured exploreMode id is unknown", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "bogus" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("focus");
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ action: CFG.exploreActions[3] } as never) // picker → General
      .mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { send } = setup();
    await send({ type: "explore" });
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ promptTemplate: "GEN {summary}{files}" }),
    );
  });

  it("aborts before opening a workspace when the action picker is cancelled", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "ask" });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined); // cancel action pick
    const { send } = setup();
    await send({ type: "explore" });
    expect(window.showInputBox).not.toHaveBeenCalled();
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it("appends the Slack-DM sentence before {files} when the action's slackDm is on", async () => {
    const actions = CFG.exploreActions.map((a) => (a.id === "jiraTicket" ? { ...a, slackDm: true } : a));
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "jiraTicket", exploreActions: actions });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("focus");
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { send } = setup();
    await send({ type: "explore" });
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ promptTemplate: `JT {summary} ${SLACK_DM_SENTENCE}{files}` }),
    );
  });
});

describe("passthrough messages", () => {
  it("opens external links via vscode.env", async () => {
    const { send } = setup();
    await send({ type: "openExternal", url: "https://example.test" });
    expect(env.openExternal).toHaveBeenCalled();
  });

  it("routes signIn to the command", async () => {
    const { send } = setup();
    await send({ type: "signIn" });
    expect(commands.executeCommand).toHaveBeenCalledWith("agentFlow.signIn");
  });
});

describe("error handling", () => {
  it("re-gates on a JiraAuthError and surfaces an error toast", async () => {
    clientStub.fetchTasks.mockRejectedValue(new JiraAuthError("expired"));
    const { send, posted } = setup();
    await send({ type: "fetch", filter: "mine", size: "any" });
    expect(posted()).toContainEqual({ type: "state", authed: false, configured: true, project: "ASM", me: null });
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "error" }));
    expect(posted()).toContainEqual({ type: "loading", loading: false });
    // Auth errors re-gate (no persistent error banner — the sign-in screen is the cue).
    expect(posted().some((m) => m.type === "error")).toBe(false);
  });

  it("posts a persistent, retryable error banner on a non-auth failure", async () => {
    clientStub.fetchTasks.mockRejectedValue(new Error("Jira didn't respond within 15s"));
    const { send, posted } = setup();
    await send({ type: "fetch", filter: "mine", size: "any" });
    expect(posted()).toContainEqual(
      expect.objectContaining({ type: "error", canRetry: true, message: expect.stringContaining("15s") }),
    );
    expect(posted()).toContainEqual({ type: "loading", loading: false });
  });
});

describe("takeTask", () => {
  it("opens the workspace for a preselected repo and toasts success", async () => {
    const { provider, posted } = setup();
    await provider.takeTask("ASM-1", ["account-service"]);
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        ticket: expect.objectContaining({ key: "ASM-1" }),
        promptTemplate: "P {key}",
        services: [expect.objectContaining({ name: "account-service" })],
      }),
    );
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "success" }));
  });

  it("errors when no repos are checked out", async () => {
    vi.mocked(discoverRepos).mockReturnValue([]);
    const { provider, posted } = setup();
    await provider.takeTask("ASM-1", ["account-service"]);
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "error" }));
  });

  it("aborts when sign-in is declined", async () => {
    vi.mocked(commands.executeCommand).mockResolvedValue(false);
    const { provider } = setup({ authed: false });
    await provider.takeTask("ASM-1", ["account-service"]);
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it("confirms repos via QuickPick when none are preselected", async () => {
    const repos = mkRepos(["account-service", "centaur"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { provider } = setup();
    await provider.takeTask("ASM-1");
    expect(openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ services: [repos[0]] }));
  });

  it("aborts when the repo QuickPick is cancelled", async () => {
    vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined);
    const { provider } = setup();
    await provider.takeTask("ASM-1");
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it("prompts for a mode when taskMode is 'ask'", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, taskMode: "ask" });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ mode: CFG.promptModes[0] } as never);
    const { provider } = setup();
    await provider.takeTask("ASM-1", ["account-service"]);
    expect(openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ promptTemplate: "P {key}" }));
  });

  it("aborts when the mode prompt is cancelled", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, taskMode: "ask" });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined);
    const { provider } = setup();
    await provider.takeTask("ASM-1", ["account-service"]);
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it("creates worktrees when worktree=always", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, worktree: "always" });
    const { provider } = setup();
    await provider.takeTask("ASM-1", ["account-service"]);
    expect(createWorktrees).toHaveBeenCalled();
  });

  it("creates worktrees when the worktree prompt is accepted", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, worktree: "ask" });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ yes: true } as never);
    const { provider } = setup();
    await provider.takeTask("ASM-1", ["account-service"]);
    expect(createWorktrees).toHaveBeenCalled();
  });

  it("asks how to open multiple repos when workspaceMode is 'ask'", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, workspaceMode: "ask" });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ mode: "multiroot" } as never);
    const { provider } = setup();
    await provider.takeTask("ASM-1", ["account-service", "centaur"]);
    expect(openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ mode: "multiroot" }));
  });

  it("reports the generated workspace file in the success toast", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, workspaceMode: "multiroot" });
    vi.mocked(openWorkspace).mockResolvedValue({
      mode: "multiroot",
      workspaceFile: "/ws/ASM-1.code-workspace",
      briefs: [],
      opened: ["/ws/ASM-1.code-workspace"],
    });
    const { provider, posted } = setup();
    await provider.takeTask("ASM-1", ["account-service", "centaur"]);
    const toast = posted().find((m) => m.type === "toast") as { message: string };
    expect(toast.message).toContain(".code-workspace");
  });

  describe("existing workspace open target", () => {
    it("picks 'New window' from the 3-way picker without touching the workspace picker", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask" });
      vi.mocked(window.showQuickPick).mockResolvedValueOnce({ val: "new" } as never);

      const { provider } = setup();
      await provider.takeTask("ASM-1", ["account-service"]);

      expect(listWorkspaceFiles).not.toHaveBeenCalled();
      expect(openWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ openIn: "new", existingWorkspaceFile: undefined }),
      );
    });

    it("aborts the take when the 3-way open-target picker is cancelled", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask" });
      vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined as never);

      const { provider } = setup();
      await provider.takeTask("ASM-1", ["account-service"]);

      expect(openWorkspace).not.toHaveBeenCalled();
    });

    it("opens into a picked existing workspace", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask" });
      vi.mocked(listWorkspaceFiles).mockReturnValue([
        { file: "/ws/team.code-workspace", folders: 2, mtimeMs: 1 },
      ]);
      // 1st quick-pick → the 3-way open-target picker, choosing "Existing workspace…".
      // 2nd quick-pick → the workspace-file picker, choosing the listed workspace.
      vi.mocked(window.showQuickPick)
        .mockResolvedValueOnce({ val: "existing" } as never)
        .mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never);

      const { provider } = setup();
      await provider.takeTask("ASM-1", ["account-service"]);

      expect(listWorkspaceFiles).toHaveBeenCalledWith("/ws");
      expect(openWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          existingWorkspaceFile: "/ws/team.code-workspace",
          mode: "multiroot",
          openIn: "new",
        }),
      );
    });

    it("falls back to Browse… when chosen, using showOpenDialog", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "pick-existing" }); // skips the 3-way pick
      vi.mocked(listWorkspaceFiles).mockReturnValue([]);
      // Only one quick-pick fires: the workspace-file picker (Browse… item).
      vi.mocked(window.showQuickPick).mockResolvedValueOnce({ file: "__browse__" } as never);
      vi.mocked(window.showOpenDialog).mockResolvedValueOnce([
        { fsPath: "/elsewhere/x.code-workspace" },
      ] as never);

      const { provider } = setup();
      await provider.takeTask("ASM-1", ["account-service"]);

      expect(openWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ existingWorkspaceFile: "/elsewhere/x.code-workspace" }),
      );
    });

    it("aborts the take when the workspace picker is cancelled", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "pick-existing" });
      vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined as never);

      const { provider } = setup();
      await provider.takeTask("ASM-1", ["account-service"]);

      expect(openWorkspace).not.toHaveBeenCalled();
    });

    it("aborts the take when Browse… is chosen but the file dialog is cancelled", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "pick-existing" });
      vi.mocked(window.showQuickPick).mockResolvedValueOnce({ file: "__browse__" } as never);
      vi.mocked(window.showOpenDialog).mockResolvedValueOnce(undefined);

      const { provider } = setup();
      await provider.takeTask("ASM-1", ["account-service"]);

      expect(openWorkspace).not.toHaveBeenCalled();
    });

    it("reuses the current window when the target is 'current' even for an existing workspace", async () => {
      // "current" only reachable via the 3-way pick (openIn config has no "current+existing" combo);
      // this covers the openIn:"current" vs "new" branch in isolation from the existing-workspace flag.
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "this-window" });

      const { provider } = setup();
      await provider.takeTask("ASM-1", ["account-service"]);

      expect(openWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ openIn: "current", existingWorkspaceFile: undefined }),
      );
    });

    it("toasts an info message (not success) when the merge into the existing workspace fails to parse", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "pick-existing" });
      vi.mocked(listWorkspaceFiles).mockReturnValue([
        { file: "/ws/team.code-workspace", folders: 2, mtimeMs: 1 },
      ]);
      vi.mocked(window.showQuickPick).mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never);
      vi.mocked(openWorkspace).mockResolvedValue({
        mode: "multiroot",
        workspaceFile: "/ws/team.code-workspace",
        briefs: [],
        opened: ["/ws/team.code-workspace"],
        mergeFailed: true,
      });

      const { provider, posted } = setup();
      await provider.takeTask("ASM-1", ["account-service"]);

      const toast = posted().find((m) => m.type === "toast") as { level: string; message: string };
      expect(toast.level).toBe("info");
      expect(toast.message).toMatch(/couldn't be parsed/i);
    });

    it("names the merged repos in the success toast when the merge succeeds", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "pick-existing" });
      vi.mocked(listWorkspaceFiles).mockReturnValue([
        { file: "/ws/team.code-workspace", folders: 2, mtimeMs: 1 },
      ]);
      vi.mocked(window.showQuickPick).mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never);
      vi.mocked(openWorkspace).mockResolvedValue({
        mode: "multiroot",
        workspaceFile: "/ws/team.code-workspace",
        briefs: [],
        opened: ["/ws/team.code-workspace"],
        mergedRepos: ["account-service"],
      });

      const { provider, posted } = setup();
      await provider.takeTask("ASM-1", ["account-service"]);

      const toast = posted().find((m) => m.type === "toast") as { level: string; message: string };
      expect(toast.level).toBe("success");
      expect(toast.message).toContain("Added account-service");
    });
  });
});
