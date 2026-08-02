import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { commands, env, window } from "../_mocks/vscode";
import { fakeAuth, fakeContext, mkRepos } from "../_helpers/factories";

// ── sibling modules the controller depends on ──────────────────────────────
// Keep the real config constants (DEFAULT_PR_REVIEW_PROMPT, PR_REVIEW_AUTOFIX_CLAUSE,
// …) faithful — only getConfig is stubbed so tests control the resolved settings.
vi.mock("../../src/config", async () => {
  const actual = await vi.importActual<typeof import("../../src/config")>("../../src/config");
  return { ...actual, getConfig: vi.fn() };
});
vi.mock("../../src/engine/repos", () => ({ discoverRepos: vi.fn() }));
vi.mock("../../src/engine/workspace", () => ({
  openWorkspace: vi.fn(),
  listWorkspaceFiles: vi.fn(() => []),
  workspaceFolderPaths: vi.fn(() => []),
  planWorkspaceMerge: vi.fn(() => ({ add: [], duplicates: [], present: [], ok: true })),
}));
vi.mock("../../src/engine/worktree", () => ({ createWorktrees: vi.fn((s: unknown) => s) }));
// folderName is a pure function (no vscode/fs side effects) — keep the real one so
// batch's dedup candidates carry genuine key-qualified labels, and only stub the
// window-opening entrypoint the tests actually drive. This runs the real batchWorkspace
// module against the workspace mock above, which is only PARTIAL (openWorkspace,
// listWorkspaceFiles, workspaceFolderPaths, planWorkspaceMerge — not mergeReposIntoWorkspace,
// workspaceFolders, mentionInWorkspace, etc. that batchWorkspace also imports); that's safe
// only because folderName itself touches none of the omitted exports.
vi.mock("../../src/engine/batchWorkspace", async () => {
  const actual = await vi.importActual<typeof import("../../src/engine/batchWorkspace")>(
    "../../src/engine/batchWorkspace",
  );
  return { ...actual, openSharedWorkspace: vi.fn() };
});
// Telemetry: mocked wholesale so the Take-funnel tests observe track() calls without
// a real singleton — fingerprint() returns "" until initTelemetry() runs (see
// telemetry.ts), which would make every task_fp assertion below meaningless.
const trackSpy = vi.fn();
const trackErrorSpy = vi.fn();
vi.mock("../../src/telemetry/telemetry", () => ({
  track: (...a: unknown[]) => trackSpy(...a),
  trackError: (...a: unknown[]) => trackErrorSpy(...a),
  startFlow: () => ({ id: "flow-1", elapsedMs: () => 42 }),
  fingerprint: () => "0123456789abcdef",
}));
vi.mock("../../src/engine/presence", () => ({
  readLiveWindows: vi.fn(() => []),
  windowIdentity: vi.fn(() => undefined),
  defaultWindowsDir: vi.fn(() => "/win"),
}));
// This file mocks the client wholesale, so `JiraApiError` would be undefined inside
// tasksView and every `instanceof` check would throw. Re-export the genuine class so
// the real parseJiraError produces instances the production code recognises.
vi.mock("../../src/jira/client", async () => {
  const errors = await vi.importActual<typeof import("../../src/jira/errors")>("../../src/jira/errors");
  // The real module, for isJiraNetworkError/markJiraNetworkFailure only — these
  // are pure functions with no vscode-touching side effects at import time, so
  // there's no reason to hand-roll a stand-in the way JiraAuthError needs one
  // below; a duplicate here could silently drift from resolveOp's actual check.
  const real = await vi.importActual<typeof import("../../src/jira/client")>("../../src/jira/client");
  // Mirrors the real class's constructor (src/jira/client.ts): classifyFailure
  // (telemetry/events.ts) checks `e.name === "JiraAuthError"`, and a bare
  // `extends Error {}` here would leave `.name` as the inherited "Error",
  // silently failing that check for every test in this file.
  class JiraAuthError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "JiraAuthError";
    }
  }
  return {
    JiraAuthError,
    JiraApiError: errors.JiraApiError,
    JiraClient: vi.fn(),
    isJiraNetworkError: real.isJiraNetworkError,
    markJiraNetworkFailure: real.markJiraNetworkFailure,
  };
});

import { parseJiraError } from "../../src/jira/errors";
import { getConfig, PR_REVIEW_AUTOFIX_CLAUSE } from "../../src/config";
import { discoverRepos } from "../../src/engine/repos";
import { openWorkspace, listWorkspaceFiles, workspaceFolderPaths, planWorkspaceMerge } from "../../src/engine/workspace";
import { createWorktrees } from "../../src/engine/worktree";
import { openSharedWorkspace } from "../../src/engine/batchWorkspace";
import { readLiveWindows, windowIdentity } from "../../src/engine/presence";
import { JiraClient, JiraAuthError, markJiraNetworkFailure } from "../../src/jira/client";
import { TasksViewProvider } from "../../src/tasksView";
import type { TakeSource } from "../../src/telemetry/events";
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
    { id: "jiraTicket", label: "Open a Jira ticket", prompt: "JT {summary}{files}", slackDm: false, needsEnv: false },
    { id: "knowledge", label: "Enhance knowledge / flow", prompt: "Explore {summary}{files}", slackDm: false, needsEnv: false },
    { id: "debug", label: "Debug", prompt: "DBG {summary}{files}", slackDm: false, needsEnv: false },
    { id: "general", label: "General", prompt: "GEN {summary}{files}", slackDm: false, needsEnv: false },
    { id: "verify", label: "Verify on an environment", prompt: "VER {summary} on {env} for {services}{files}", slackDm: false, needsEnv: true },
  ],
  environments: ["dev", "staging", "production"],
  prReviewStatus: "PR initiated",
  prReviewAutoFix: true,
  prReviewPrompt: "PR {key}{files}",
  worktree: "never" as const,
  remoteControl: "off" as const,
  batchLaunchConfirmThreshold: 6,
  trackOpenWindows: true,
  telemetryEnabled: true,
  prFacts: true,
  prFactsTtlSeconds: 120,
  reviewRequests: true,
  reviewRequestsTtlSeconds: 300,
  reviewWrites: false,
  reviewRequestPrompt: "Review {url}{files}",
  stampLabelOnWrite: true,
  provenanceLabel: "claude-code",
  filters: { size: true, status: true, repo: true, search: true },
  marketplaces: [] as string[],
};

let clientStub: Record<string, ReturnType<typeof vi.fn>>;

function makeClient() {
  return {
    currentUserName: vi.fn(async () => "Jane"),
    getMyself: vi.fn(async () => ({ accountId: "a1", displayName: "Jane" })),
    fetchTasks: vi.fn(async () => []),
    getDetail: vi.fn(async (key: string) => ({
      key,
      summary: "Do the thing",
      descriptionText: "desc",
      labels: [],
      components: [],
      url: `https://jira/browse/${key}`,
    })),
    getTransitions: vi.fn(async () => [] as unknown[]),
    transition: vi.fn(async () => undefined),
    listResolutions: vi.fn(async () => [] as unknown[]),
    addLabel: vi.fn(async () => undefined),
    listComponents: vi.fn(async () => ["account-service", "Infra"]),
    updateComponents: vi.fn(async () => undefined),
    getActiveSprintId: vi.fn(async () => 42),
    addIssueToSprint: vi.fn(async () => undefined),
    removeIssueFromSprint: vi.fn(async () => undefined),
    assignIssue: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  trackSpy.mockClear();
  trackErrorSpy.mockClear();
  clientStub = makeClient();
  vi.mocked(getConfig).mockReturnValue({ ...CFG });
  vi.mocked(discoverRepos).mockReturnValue(mkRepos(["account-service", "centaur"]));
  vi.mocked(JiraClient).mockImplementation(() => clientStub as unknown as JiraClient);
  vi.mocked(openWorkspace).mockResolvedValue({
    mode: "per-window",
    workspaceFile: undefined,
    briefs: [],
    opened: ["/repos/account-service"],
    remoteControl: false,
  });
  vi.mocked(readLiveWindows).mockReturnValue([]);
  vi.mocked(windowIdentity).mockReturnValue(undefined);
  vi.mocked(openSharedWorkspace).mockResolvedValue({
    workspaceFile: "/ws/ASM-1+1.code-workspace",
    opened: true,
    briefs: [],
    seeded: 2,
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
    expect(posted()).toContainEqual({ type: "state", authed: true, configured: true, project: "ASM", me: "Jane", prReviewStatus: "PR initiated", filters: { size: true, status: true, repo: true, search: true } });
    expect(clientStub.fetchTasks).toHaveBeenCalled();
  });

  it("reports unauthed state and does not fetch", async () => {
    const { send, posted } = setup({ authed: false });
    await send({ type: "ready" });
    expect(posted()).toContainEqual({ type: "state", authed: false, configured: true, project: "ASM", me: null, prReviewStatus: "PR initiated", filters: { size: true, status: true, repo: true, search: true } });
    expect(clientStub.fetchTasks).not.toHaveBeenCalled();
  });

  it("reports not-configured (and does not fetch) when the site URL / project are unset", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, baseUrl: "", project: "" });
    const { send, posted } = setup({ authed: true });
    await send({ type: "ready" });
    expect(posted()).toContainEqual({ type: "state", authed: true, configured: false, project: "", me: null, prReviewStatus: "PR initiated", filters: { size: true, status: true, repo: true, search: true } });
    expect(clientStub.fetchTasks).not.toHaveBeenCalled();
  });

  it("posts state up-front and still loads tasks when the display-name lookup fails", async () => {
    clientStub.currentUserName.mockRejectedValue(new Error("myself 500"));
    const { send, posted } = setup({ authed: true });
    await send({ type: "ready" });
    // A state is posted before (and regardless of) the /myself round-trip…
    expect(posted()).toContainEqual({ type: "state", authed: true, configured: true, project: "ASM", me: null, prReviewStatus: "PR initiated", filters: { size: true, status: true, repo: true, search: true } });
    // …and the task list — the real payload — still loads.
    expect(clientStub.fetchTasks).toHaveBeenCalled();
  });

  it("re-establishes state and fetches on retry", async () => {
    const { send, posted } = setup({ authed: true });
    await send({ type: "retry" });
    expect(posted()).toContainEqual({ type: "state", authed: true, configured: true, project: "ASM", me: "Jane", prReviewStatus: "PR initiated", filters: { size: true, status: true, repo: true, search: true } });
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
    expect(posted()).toContainEqual({ type: "state", authed: false, configured: true, project: "ASM", me: null, prReviewStatus: "PR initiated", filters: { size: true, status: true, repo: true, search: true } });
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
    expect(clientStub.transition).toHaveBeenCalledWith("ASM-1", "41", {});
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

  const DONE_WITH_RESOLUTION = {
    id: "41",
    name: "Resolve",
    toName: "Done",
    toCategory: "done",
    fields: {
      resolution: {
        required: true,
        name: "Resolution",
        schema: { type: "resolution", system: "resolution" },
        allowedValues: [{ id: "10000", name: "Done" }, { id: "10001", name: "Won't Do" }],
      },
    },
  };

  /** The status QuickPick answers first, then one answer per field prompt. */
  const answerPicks = (...answers: unknown[]) => {
    const pick = vi.mocked(window.showQuickPick);
    pick.mockReset();
    for (const a of answers) pick.mockResolvedValueOnce(a as never);
    pick.mockResolvedValue(undefined as never);
  };

  it("prompts for a required resolution and sends it with the transition", async () => {
    clientStub.getTransitions.mockResolvedValue([DONE_WITH_RESOLUTION]);
    answerPicks({ t: DONE_WITH_RESOLUTION }, { label: "Won't Do" });
    const { provider } = setup();
    await provider.changeStatus("ASM-1");
    expect(clientStub.transition).toHaveBeenCalledWith("ASM-1", "41", { resolution: { id: "10001" } });
  });

  it("writes nothing when the field prompt is cancelled", async () => {
    clientStub.getTransitions.mockResolvedValue([DONE_WITH_RESOLUTION]);
    answerPicks({ t: DONE_WITH_RESOLUTION }, undefined);
    const { provider, posted } = setup();
    await provider.changeStatus("ASM-1");
    expect(clientStub.transition).not.toHaveBeenCalled();
    expect(posted().filter((p) => p.type === "toast")).toEqual([]);
  });

  it("prompts a required text field through an input box", async () => {
    const t = {
      id: "51",
      name: "Close",
      toName: "Closed",
      toCategory: "done",
      fields: { customfield_1: { required: true, name: "Reason", schema: { type: "string" } } },
    };
    clientStub.getTransitions.mockResolvedValue([t]);
    answerPicks({ t });
    vi.mocked(window.showInputBox).mockResolvedValue("shipped in 0.1.36" as never);
    const { provider } = setup();
    await provider.changeStatus("ASM-1");
    expect(clientStub.transition).toHaveBeenCalledWith("ASM-1", "51", { customfield_1: "shipped in 0.1.36" });
  });

  it("skips unfillable required fields and attempts the write anyway", async () => {
    const t = {
      id: "61",
      name: "Close",
      toName: "Closed",
      toCategory: "done",
      fields: { assignee: { required: true, name: "Assignee", schema: { type: "user", system: "assignee" } } },
    };
    clientStub.getTransitions.mockResolvedValue([t]);
    answerPicks({ t });
    const { provider } = setup();
    await provider.changeStatus("ASM-1");
    expect(clientStub.transition).toHaveBeenCalledWith("ASM-1", "61", {});
  });

  it("does not prompt for optional screen fields", async () => {
    const t = {
      id: "71",
      name: "Start",
      toName: "In Progress",
      toCategory: "indeterminate",
      fields: { comment: { required: false, name: "Comment", schema: { type: "string" } } },
    };
    clientStub.getTransitions.mockResolvedValue([t]);
    answerPicks({ t });
    const { provider } = setup();
    await provider.changeStatus("ASM-1");
    expect(window.showInputBox).not.toHaveBeenCalled();
    expect(clientStub.transition).toHaveBeenCalledWith("ASM-1", "71", {});
  });

  // `src/jira/client` is mocked in this file, but `src/jira/errors` is not — the
  // real parser gives the recovery path a faithful JiraApiError to react to.
  const apiError = (messages: string[], fieldErrors: Record<string, string> = {}) =>
    parseJiraError(400, JSON.stringify({ errorMessages: messages, errors: fieldErrors }));

  it("re-prompts from a workflow validator that names a screen field, then retries once", async () => {
    clientStub.getTransitions.mockResolvedValue([DONE_WITH_RESOLUTION]);
    clientStub.transition
      .mockRejectedValueOnce(apiError(["Ticket cannot be closed unless Resolution will be provided"]))
      .mockResolvedValueOnce(undefined);
    // The upfront pass already asks for Resolution, so answer it twice.
    answerPicks({ t: DONE_WITH_RESOLUTION }, { label: "Done" }, { label: "Won't Do" });
    const { provider, posted } = setup();
    await provider.changeStatus("ASM-1");
    expect(clientStub.transition).toHaveBeenCalledTimes(2);
    expect(clientStub.transition).toHaveBeenLastCalledWith("ASM-1", "41", { resolution: { id: "10001" } });
    expect(posted()).toContainEqual(expect.objectContaining({ type: "statusChanged", key: "ASM-1" }));
  });

  it("re-prompts from explicit field errors even when the field wasn't required", async () => {
    const t = {
      id: "41",
      name: "Resolve",
      toName: "Done",
      toCategory: "done",
      fields: {
        customfield_1: {
          required: false,
          name: "Root Cause",
          schema: { type: "option" },
          allowedValues: [{ id: "9", name: "Config drift" }],
        },
      },
    };
    clientStub.getTransitions.mockResolvedValue([t]);
    clientStub.transition
      .mockRejectedValueOnce(apiError([], { customfield_1: "Field is required" }))
      .mockResolvedValueOnce(undefined);
    answerPicks({ t }, { label: "Config drift" });
    const { provider } = setup();
    await provider.changeStatus("ASM-1");
    expect(clientStub.transition).toHaveBeenLastCalledWith("ASM-1", "41", { customfield_1: { id: "9" } });
  });

  it("falls back to the site resolution list when the screen declared no fields", async () => {
    const t = { id: "41", name: "Resolve", toName: "Done", toCategory: "done", fields: {} };
    clientStub.getTransitions.mockResolvedValue([t]);
    clientStub.listResolutions.mockResolvedValue([{ id: "10000", name: "Done" }]);
    clientStub.transition
      .mockRejectedValueOnce(apiError(["Ticket cannot be closed unless Resolution will be provided"]))
      .mockResolvedValueOnce(undefined);
    answerPicks({ t }, { label: "Done" });
    const { provider } = setup();
    await provider.changeStatus("ASM-1");
    expect(clientStub.listResolutions).toHaveBeenCalled();
    expect(clientStub.transition).toHaveBeenLastCalledWith("ASM-1", "41", { resolution: { id: "10000" } });
  });

  it("reports a readable toast with an Open in Jira action when nothing can be re-prompted", async () => {
    const t = { id: "41", name: "Resolve", toName: "Done", toCategory: "done", fields: {} };
    clientStub.getTransitions.mockResolvedValue([t]);
    clientStub.transition.mockRejectedValue(apiError(["Transition is not valid"]));
    answerPicks({ t });
    const { provider, posted } = setup();
    await provider.changeStatus("ASM-1");
    expect(clientStub.transition).toHaveBeenCalledTimes(1);
    expect(posted()).toContainEqual({
      type: "toast",
      level: "error",
      message: "Couldn't update ASM-1. Transition is not valid.",
      action: { label: "Open in Jira", url: "https://jira/browse/ASM-1" },
    });
    expect(posted().some((p) => p.type === "statusChanged")).toBe(false);
  });

  it("names the field in the message when the rejection is field-scoped", async () => {
    const t = {
      id: "41",
      name: "Resolve",
      toName: "Done",
      toCategory: "done",
      fields: { customfield_1: { required: false, name: "Root Cause", schema: { type: "option-with-child" } } },
    };
    clientStub.getTransitions.mockResolvedValue([t]);
    clientStub.transition.mockRejectedValue(apiError([], { customfield_1: "Field is required" }));
    answerPicks({ t });
    const { provider, posted } = setup();
    await provider.changeStatus("ASM-1");
    expect(posted()).toContainEqual(
      expect.objectContaining({ message: "Couldn't update ASM-1. Root Cause: Field is required." }),
    );
  });

  it("does not retry a second time", async () => {
    clientStub.getTransitions.mockResolvedValue([DONE_WITH_RESOLUTION]);
    clientStub.transition.mockRejectedValue(apiError(["Ticket cannot be closed unless Resolution will be provided"]));
    answerPicks({ t: DONE_WITH_RESOLUTION }, { label: "Done" }, { label: "Done" });
    const { provider, posted } = setup();
    await provider.changeStatus("ASM-1");
    expect(clientStub.transition).toHaveBeenCalledTimes(2);
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "error" }));
  });

  it("stays silent when the recovery prompt is cancelled", async () => {
    clientStub.getTransitions.mockResolvedValue([DONE_WITH_RESOLUTION]);
    clientStub.transition.mockRejectedValue(apiError(["Ticket cannot be closed unless Resolution will be provided"]));
    answerPicks({ t: DONE_WITH_RESOLUTION }, { label: "Done" }, undefined);
    const { provider, posted } = setup();
    await provider.changeStatus("ASM-1");
    expect(clientStub.transition).toHaveBeenCalledTimes(1);
    expect(posted().filter((p) => p.type === "toast")).toEqual([]);
  });
});

/** Forces the (mocked) Jira client to reject a `fetch` message so it reaches the
 * dispatcher's catch, however the existing error tests in this file do it. The
 * default rejection carries a ticket-key-shaped string so the leak test below
 * has something concrete to prove never survives into the emitted event. */
async function fireMessageThatThrows(m: InboundMessage, err: Error = new Error("Couldn't fetch BILL-1234")) {
  clientStub.fetchTasks.mockRejectedValue(err);
  const { send } = setup();
  await send(m);
}

describe("failure routing", () => {
  it("gates the panel when the task fetch fails, and offers Doctor", async () => {
    clientStub.fetchTasks.mockRejectedValue(new Error("Couldn't reach Jira"));
    const { send, posted } = setup();
    await send({ type: "fetch", filter: "mysprint", size: "any" });
    // The gate's remit — unreachable site, bad project key, auth loss — is exactly
    // what Doctor diagnoses, so the banner offers it rather than hoping the user
    // knows the command exists.
    expect(posted()).toContainEqual({
      type: "error",
      message: "Couldn't reach Jira",
      canRetry: true,
      canRunDoctor: true,
    });
  });

  it("runs the Doctor command when the banner's button asks for it", async () => {
    const { send } = setup();
    await send({ type: "runDoctor" });
    expect(commands.executeCommand).toHaveBeenCalledWith("agentFlow.doctor");
  });

  it("leaves the list up when a write fails — toast only", async () => {
    clientStub.getTransitions.mockRejectedValue(new Error("Couldn't reach Jira"));
    const { send, posted } = setup();
    await send({ type: "changeStatus", key: "ASM-1" });
    expect(posted().some((p) => p.type === "error")).toBe(false);
    expect(posted()).toContainEqual({ type: "toast", level: "error", message: "Couldn't reach Jira" });
  });

  it("reports operation_failed when a webview message throws", async () => {
    await fireMessageThatThrows({ type: "fetch", filter: "mysprint", size: "any" });
    const ev = trackErrorSpy.mock.calls.flat().find((e: any) => e.name === "operation_failed") as any;
    expect(ev).toBeDefined();
    expect(ev.op).toBe("jira_fetch");
    expect(JSON.stringify(ev)).not.toContain("BILL");
  });

  it("classifies a JiraAuthError as auth, and marks it non-retryable", async () => {
    await fireMessageThatThrows({ type: "fetch", filter: "mysprint", size: "any" }, new JiraAuthError("nope"));
    const ev = trackErrorSpy.mock.calls.flat().find((e: any) => e.name === "operation_failed") as any;
    expect(ev.failure_class).toBe("auth");
    expect(ev.retryable).toBe(false);
  });

  it("marks an unclassified failure as retryable", async () => {
    await fireMessageThatThrows({ type: "fetch", filter: "mysprint", size: "any" }, new Error("Couldn't reach Jira"));
    const ev = trackErrorSpy.mock.calls.flat().find((e: any) => e.name === "operation_failed") as any;
    expect(ev.failure_class).toBe("unknown");
    expect(ev.retryable).toBe(true);
  });

  it("does not report operation_failed for a message absent from the op map", async () => {
    // `openExternal` has no engine op (it's a bare env.openExternal call) —
    // MESSAGE_OPS deliberately leaves it out, so its catch must report nothing.
    vi.mocked(env.openExternal).mockRejectedValueOnce(new Error("no handler for this URL"));
    const { send } = setup();
    await send({ type: "openExternal", url: "https://example.com" });
    expect(trackErrorSpy.mock.calls.flat().find((e: any) => e.name === "operation_failed")).toBeUndefined();
  });

  it("reports jira_write when changeStatus fails with a real Jira error (resolveOp, not the plain MESSAGE_OPS lookup)", async () => {
    clientStub.getTransitions.mockRejectedValueOnce(parseJiraError(500, JSON.stringify({ errorMessages: ["Jira exploded"] })));
    const { send } = setup();
    await send({ type: "changeStatus", key: "ASM-1" });
    const ev = trackErrorSpy.mock.calls.flat().find((e: any) => e.name === "operation_failed") as any;
    expect(ev).toBeDefined();
    expect(ev.op).toBe("jira_write");
  });
});

describe("detail", () => {
  it("reports the issue's components and the repo → component map for every repo", async () => {
    clientStub.getDetail.mockResolvedValue({
      key: "ASM-1",
      summary: "Do the thing",
      descriptionText: "desc",
      labels: ["centaur"],
      components: ["account-service"],
      url: "https://jira/browse/ASM-1",
    });
    const { send, posted } = setup();
    await send({ type: "detail", key: "ASM-1" });
    expect(posted()).toContainEqual({
      type: "detail",
      key: "ASM-1",
      descriptionText: "desc",
      // account-service from the component, centaur from the label
      inferred: ["account-service", "centaur"],
      repos: ["account-service", "centaur"],
      jiraComponents: ["account-service"],
      // "centaur" is a discovered repo but not a component of ASM → absent
      mappable: { "account-service": "account-service" },
    });
  });

  it("reads the issue before the component list, so a dead token still re-gates the panel", async () => {
    clientStub.getDetail.mockRejectedValue(new JiraAuthError("nope"));
    const { send, posted } = setup();
    await send({ type: "detail", key: "ASM-1" });
    expect(clientStub.listComponents).not.toHaveBeenCalled();
    expect(posted()).toContainEqual(expect.objectContaining({ type: "state", authed: false }));
  });

  it("reports every chip as local-only when the project defines no components", async () => {
    clientStub.listComponents.mockResolvedValue([]);
    const { send, posted } = setup();
    await send({ type: "detail", key: "ASM-1" });
    expect(posted()).toContainEqual(expect.objectContaining({ type: "detail", key: "ASM-1", mappable: {} }));
  });

  // null is a distinct answer from "[]" — the read failed, not "this project has no
  // components" — so the webview must not claim any chip is local-only from it.
  it("reports mappable: null (not {}) when the component list could not be read", async () => {
    clientStub.listComponents.mockResolvedValue(null);
    const { send, posted } = setup();
    await send({ type: "detail", key: "ASM-1" });
    expect(posted()).toContainEqual(expect.objectContaining({ type: "detail", key: "ASM-1", mappable: null }));
  });
});

describe("setComponent", () => {
  it("adds the component under the project's spelling and echoes ok", async () => {
    clientStub.listComponents.mockResolvedValue(["Account-Service"]);
    const { send, posted } = setup();
    await send({ type: "setComponent", key: "ASM-1", repo: "account-service", on: true, movedChip: true });
    expect(clientStub.updateComponents).toHaveBeenCalledWith("ASM-1", { add: ["Account-Service"] });
    expect(posted()).toContainEqual({
      type: "componentsChanged", key: "ASM-1", repo: "account-service", on: true, movedChip: true, ok: true,
    });
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "success", message: "Added Account-Service to ASM-1" }));
  });

  it("removes the component and echoes ok", async () => {
    const { send, posted } = setup();
    await send({ type: "setComponent", key: "ASM-1", repo: "account-service", on: false, movedChip: true });
    expect(clientStub.updateComponents).toHaveBeenCalledWith("ASM-1", { remove: ["account-service"] });
    expect(posted()).toContainEqual({
      type: "componentsChanged", key: "ASM-1", repo: "account-service", on: false, movedChip: true, ok: true,
    });
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "success", message: "Removed account-service from ASM-1" }));
  });

  it("echoes movedChip: false back unchanged (a push leaves the chip where it is)", async () => {
    const { send, posted } = setup();
    await send({ type: "setComponent", key: "ASM-1", repo: "account-service", on: true, movedChip: false });
    expect(posted()).toContainEqual({
      type: "componentsChanged", key: "ASM-1", repo: "account-service", on: true, movedChip: false, ok: true,
    });
  });

  it("stamps the provenance label", async () => {
    const { send } = setup();
    await send({ type: "setComponent", key: "ASM-1", repo: "account-service", on: true, movedChip: true });
    expect(clientStub.addLabel).toHaveBeenCalledWith("ASM-1", "claude-code");
  });

  it("skips the label stamp when stampLabelOnWrite is off", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, stampLabelOnWrite: false });
    const { send } = setup();
    await send({ type: "setComponent", key: "ASM-1", repo: "account-service", on: true, movedChip: true });
    expect(clientStub.addLabel).not.toHaveBeenCalled();
  });

  it("still succeeds when the label stamp fails", async () => {
    clientStub.addLabel.mockRejectedValue(new Error("label 500"));
    const { send, posted } = setup();
    await send({ type: "setComponent", key: "ASM-1", repo: "account-service", on: true, movedChip: true });
    expect(posted()).toContainEqual(expect.objectContaining({ type: "componentsChanged", ok: true }));
  });

  // A 400, not a 403: `JiraClient.request` converts every 401 *and* 403 into
  // JiraAuthError, so a permission refusal re-gates the panel and never reaches
  // this branch. The reachable JiraApiError here is a rejected component name —
  // e.g. one that vanished from the project since the cache was filled.
  it("echoes ok: false with an actionable toast when Jira rejects the write", async () => {
    clientStub.updateComponents.mockRejectedValue(parseJiraError(400, JSON.stringify({ errorMessages: ["Component name is not valid"], errors: {} })));
    const { send, posted } = setup();
    await send({ type: "setComponent", key: "ASM-1", repo: "account-service", on: true, movedChip: true });
    expect(posted()).toContainEqual({
      type: "componentsChanged", key: "ASM-1", repo: "account-service", on: true, movedChip: true, ok: false,
    });
    expect(posted()).toContainEqual(expect.objectContaining({
      type: "toast", level: "error", action: { label: "Open in Jira", url: "https://jira/browse/ASM-1" },
    }));
    expect(clientStub.addLabel).not.toHaveBeenCalled();
  });

  // Covers a permission refusal too: request() converts every 401 and 403 into
  // JiraAuthError, so this is the branch a refused write actually takes.
  it("echoes ok: false and re-gates the panel on an auth failure, posting no toast", async () => {
    clientStub.updateComponents.mockRejectedValue(new JiraAuthError("token dead"));
    const { send, posted } = setup();
    await send({ type: "setComponent", key: "ASM-1", repo: "account-service", on: true, movedChip: true });
    expect(posted()).toContainEqual(expect.objectContaining({ type: "componentsChanged", ok: false }));
    expect(posted()).toContainEqual(expect.objectContaining({ type: "state", authed: false }));
    // Re-gating to the sign-in screen is itself the indication — a toast on top
    // would be noise, and the panel is already replaced.
    expect(posted().filter((p) => p.type === "toast")).toEqual([]);
  });

  it("writes nothing and echoes ok: false when the project has no such component", async () => {
    clientStub.listComponents.mockResolvedValue(["Infra"]);
    const { send, posted } = setup();
    await send({ type: "setComponent", key: "ASM-1", repo: "scratch-tool", on: true, movedChip: true });
    expect(clientStub.updateComponents).not.toHaveBeenCalled();
    expect(posted()).toContainEqual(expect.objectContaining({ type: "componentsChanged", ok: false }));
    expect(posted()).toContainEqual(expect.objectContaining({
      type: "toast", level: "error", message: "ASM has no component named “scratch-tool”.",
    }));
  });

  // An empty list is a real answer under the new contract — the project genuinely
  // defines no components — so an unmapped repo gets the ordinary "no such
  // component" message, same as any other repo the project doesn't recognize.
  it("blames the repo, not the connection, when the project defines no components", async () => {
    clientStub.listComponents.mockResolvedValue([]);
    const { send, posted } = setup();
    await send({ type: "setComponent", key: "ASM-1", repo: "account-service", on: true, movedChip: true });
    expect(clientStub.updateComponents).not.toHaveBeenCalled();
    expect(posted()).toContainEqual(expect.objectContaining({ type: "componentsChanged", ok: false }));
    expect(posted()).toContainEqual(expect.objectContaining({
      type: "toast", level: "error", message: "ASM has no component named “account-service”.",
    }));
  });

  // A `null` list is the failed read — not the same claim as "no such component",
  // and blaming the repo name for it would send the user looking in the wrong place.
  it("blames the connection, not the repo, when the component list could not be read", async () => {
    clientStub.listComponents.mockResolvedValue(null);
    const { send, posted } = setup();
    await send({ type: "setComponent", key: "ASM-1", repo: "account-service", on: true, movedChip: true });
    expect(clientStub.updateComponents).not.toHaveBeenCalled();
    expect(posted()).toContainEqual(expect.objectContaining({ type: "componentsChanged", ok: false }));
    expect(posted()).toContainEqual(expect.objectContaining({
      type: "toast", level: "error",
      message: "Couldn't read ASM's components from Jira. Check the connection and try again.",
    }));
  });

  it("echoes ok: false and re-gates when not signed in, without touching Jira", async () => {
    const { send, posted } = setup({ authed: false });
    await send({ type: "setComponent", key: "ASM-1", repo: "account-service", on: true, movedChip: true });
    expect(clientStub.updateComponents).not.toHaveBeenCalled();
    expect(posted()).toContainEqual(expect.objectContaining({ type: "componentsChanged", ok: false }));
    expect(posted()).toContainEqual(expect.objectContaining({ type: "state", authed: false }));
  });

  // The invariant the whole optimistic-edit design rests on: a SecretStorage
  // rejection reading the stored credential must still resolve the webview's
  // held edit, not strand it for the life of the window.
  it("posts exactly one ok:false componentsChanged when auth itself rejects", async () => {
    const { send, posted, auth } = setup();
    vi.mocked(auth.isAuthenticated).mockRejectedValue(new Error("keychain locked"));
    await send({ type: "setComponent", key: "ASM-1", repo: "account-service", on: true, movedChip: true });
    expect(clientStub.updateComponents).not.toHaveBeenCalled();
    expect(posted().filter((p) => p.type === "componentsChanged")).toEqual([
      { type: "componentsChanged", key: "ASM-1", repo: "account-service", on: true, movedChip: true, ok: false },
    ]);
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "error", message: "keychain locked" }));
  });

  // Pins the idempotent echo guard: a normal successful call must post the verdict
  // exactly once, not merely at least once.
  it("posts exactly one componentsChanged on an ordinary successful call", async () => {
    const { send, posted } = setup();
    await send({ type: "setComponent", key: "ASM-1", repo: "account-service", on: true, movedChip: true });
    expect(posted().filter((p) => p.type === "componentsChanged")).toHaveLength(1);
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

describe("removeFromSprint", () => {
  it("moves to backlog, stamps the label, prunes saved order, and posts removedFromSprint", async () => {
    const { provider, posted, workspaceState } = setup({
      workspaceState: { "agentFlow.sprintOrder": ["ASM-1", "ASM-2"] },
    });
    await provider.removeFromSprint("ASM-1", "any");
    expect(clientStub.removeIssueFromSprint).toHaveBeenCalledWith("ASM-1");
    expect(clientStub.addLabel).toHaveBeenCalledWith("ASM-1", "claude-code");
    expect(workspaceState.update).toHaveBeenCalledWith("agentFlow.sprintOrder", ["ASM-2"]);
    expect(posted()).toContainEqual({ type: "removedFromSprint", key: "ASM-1" });
  });

  it("skips the label stamp when stampLabelOnWrite is off", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, stampLabelOnWrite: false });
    const { provider } = setup();
    await provider.removeFromSprint("ASM-1", "any");
    expect(clientStub.addLabel).not.toHaveBeenCalled();
  });

  it("does not remove the card when the backlog write fails", async () => {
    clientStub.removeIssueFromSprint.mockRejectedValue(new Error("boom"));
    const { send, posted } = setup();
    await send({ type: "removeFromSprint", key: "ASM-1", size: "any" });
    expect(posted()).not.toContainEqual(expect.objectContaining({ type: "removedFromSprint" }));
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "error" }));
  });

  it("re-adds to the active sprint and refetches when Undo is chosen", async () => {
    vi.mocked(window.showInformationMessage).mockResolvedValue("Undo");
    const { provider, posted } = setup();
    await provider.removeFromSprint("ASM-1", "any");
    expect(clientStub.getActiveSprintId).toHaveBeenCalled();
    expect(clientStub.addIssueToSprint).toHaveBeenCalledWith(42, "ASM-1");
    expect(posted()).toContainEqual(expect.objectContaining({ type: "tasks", filter: "mysprint" }));
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
    expect(posted()).toContainEqual({ type: "state", authed: false, configured: true, project: "ASM", me: null, prReviewStatus: "PR initiated", filters: { size: true, status: true, repo: true, search: true } });
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
    await provider.takeTask("ASM-1", "card", ["account-service"]);
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
    await provider.takeTask("ASM-1", "card", ["account-service"]);
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "error" }));
  });

  it("aborts when sign-in is declined", async () => {
    vi.mocked(commands.executeCommand).mockResolvedValue(false);
    const { provider } = setup({ authed: false });
    await provider.takeTask("ASM-1", "card", ["account-service"]);
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it("confirms repos via QuickPick when none are preselected", async () => {
    const repos = mkRepos(["account-service", "centaur"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { provider } = setup();
    await provider.takeTask("ASM-1", "command");
    expect(openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ services: [repos[0]] }));
  });

  it("aborts when the repo QuickPick is cancelled", async () => {
    vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined);
    const { provider } = setup();
    await provider.takeTask("ASM-1", "command");
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it("prompts for a mode when taskMode is 'ask'", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, taskMode: "ask" });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ mode: CFG.promptModes[0] } as never);
    const { provider } = setup();
    await provider.takeTask("ASM-1", "card", ["account-service"]);
    expect(openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ promptTemplate: "P {key}" }));
  });

  it("shows each mode's hand-written detail, and no line at all without one", async () => {
    const modes = [
      { id: "plan", label: "Plan", detail: "Propose a plan and wait", prompt: 'Jira {key}: "{summary}" at {brief}' },
      { id: "raw", label: "Raw", prompt: 'Jira {key}: "{summary}" at {brief}' },
    ];
    vi.mocked(getConfig).mockReturnValue({ ...CFG, taskMode: "ask", promptModes: modes });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ mode: modes[0] } as never);
    const { provider } = setup();
    await provider.takeTask("ASM-1", "card", ["account-service"]);

    const items = vi.mocked(window.showQuickPick).mock.calls[0][0] as { label: string; detail?: string }[];
    expect(items.map((i) => ({ label: i.label, detail: i.detail }))).toEqual([
      { label: "Plan", detail: "Propose a plan and wait" },
      { label: "Raw", detail: undefined },
    ]);
  });

  it("never derives the picker line from the prompt template", async () => {
    const modes = [{ id: "plan", label: "Plan", prompt: 'Jira {key}: "{summary}". Read the task brief at {brief}.' }];
    vi.mocked(getConfig).mockReturnValue({ ...CFG, taskMode: "ask", promptModes: modes });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ mode: modes[0] } as never);
    const { provider } = setup();
    await provider.takeTask("ASM-1", "card", ["account-service"]);

    const items = vi.mocked(window.showQuickPick).mock.calls[0][0] as { detail?: string }[];
    expect(items[0].detail).toBeUndefined();
  });

  it("asks the prompt mode first — a cancel there aborts before the ticket is read", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, taskMode: "ask" });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined); // cancel the prompt-mode pick
    const { provider } = setup();
    await provider.takeTask("ASM-1", "card", ["account-service"]);
    expect(clientStub.getDetail).not.toHaveBeenCalled(); // aborted before resolveKickoff read the ticket
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it("creates worktrees when worktree=always", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, worktree: "always" });
    const { provider } = setup();
    await provider.takeTask("ASM-1", "card", ["account-service"]);
    expect(createWorktrees).toHaveBeenCalled();
  });

  it("creates worktrees when the worktree prompt is accepted", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, worktree: "ask" });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ yes: true } as never);
    const { provider } = setup();
    await provider.takeTask("ASM-1", "card", ["account-service"]);
    expect(createWorktrees).toHaveBeenCalled();
  });

  it("asks how to open multiple repos when workspaceMode is 'ask'", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, workspaceMode: "ask" });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ mode: "multiroot" } as never);
    const { provider } = setup();
    await provider.takeTask("ASM-1", "card", ["account-service", "centaur"]);
    expect(openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ mode: "multiroot" }));
  });

  it("reports the generated workspace file in the success toast", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, workspaceMode: "multiroot" });
    vi.mocked(openWorkspace).mockResolvedValue({
      mode: "multiroot",
      workspaceFile: "/ws/ASM-1.code-workspace",
      briefs: [],
      opened: ["/ws/ASM-1.code-workspace"],
      remoteControl: false,
    });
    const { provider, posted } = setup();
    await provider.takeTask("ASM-1", "card", ["account-service", "centaur"]);
    const toast = posted().find((m) => m.type === "toast") as { message: string };
    expect(toast.message).toContain(".code-workspace");
  });

  describe("existing workspace open target", () => {
    it("picks 'New window' from the 3-way picker without touching the workspace picker", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask" });
      vi.mocked(window.showQuickPick).mockResolvedValueOnce({ target: { kind: "new" } } as never);

      const { provider } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]);

      expect(listWorkspaceFiles).not.toHaveBeenCalled();
      expect(openWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ openIn: "new", existingWorkspaceFile: undefined }),
      );
    });

    it("aborts the take when the 3-way open-target picker is cancelled", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask" });
      vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined as never);

      const { provider } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]);

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
        .mockResolvedValueOnce({ target: { kind: "existing-pick" } } as never)
        .mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never);

      const { provider } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]);

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
      await provider.takeTask("ASM-1", "card", ["account-service"]);

      expect(openWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ existingWorkspaceFile: "/elsewhere/x.code-workspace" }),
      );
    });

    it("aborts the take when the workspace picker is cancelled", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "pick-existing" });
      vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined as never);

      const { provider } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]);

      expect(openWorkspace).not.toHaveBeenCalled();
    });

    it("aborts the take when Browse… is chosen but the file dialog is cancelled", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "pick-existing" });
      vi.mocked(window.showQuickPick).mockResolvedValueOnce({ file: "__browse__" } as never);
      vi.mocked(window.showOpenDialog).mockResolvedValueOnce(undefined);

      const { provider } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]);

      expect(openWorkspace).not.toHaveBeenCalled();
    });

    it("reuses the current window when the target is 'current' even for an existing workspace", async () => {
      // "current" only reachable via the 3-way pick (openIn config has no "current+existing" combo);
      // this covers the openIn:"current" vs "new" branch in isolation from the existing-workspace flag.
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "this-window" });

      const { provider } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]);

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
        remoteControl: false,
      });

      const { provider, posted } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]);

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
        remoteControl: false,
      });

      const { provider, posted } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]);

      const toast = posted().find((m) => m.type === "toast") as { level: string; message: string };
      expect(toast.level).toBe("success");
      expect(toast.message).toContain("Added account-service");
    });

    /** Drive the destination straight to a picked existing workspace. */
    const pickExisting = () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "pick-existing" });
      vi.mocked(listWorkspaceFiles).mockReturnValue([
        { file: "/ws/team.code-workspace", folders: 2, mtimeMs: 1 },
      ]);
    };

    it("does not prompt, and adds nothing, when every repo name is already a folder", async () => {
      pickExisting();
      vi.mocked(planWorkspaceMerge).mockReturnValue({
        add: [],
        duplicates: [{ label: "account-service", repoName: "account-service", path: "/repos/account-service/.claude/worktrees/ASM-1" }],
        present: [],
        ok: true,
      });
      vi.mocked(window.showQuickPick).mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never);

      const { provider } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]);

      // Exactly one quick-pick fired: the workspace-file picker. No add-prompt.
      expect(window.showQuickPick).toHaveBeenCalledTimes(1);
      expect(openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ foldersToAdd: [] }));
    });

    it("adds the approved folders when the user accepts the prompt", async () => {
      pickExisting();
      vi.mocked(planWorkspaceMerge).mockReturnValue({
        add: [{ label: "infra", repoName: "infra", path: "/repos/infra" }],
        duplicates: [],
        present: [],
        ok: true,
      });
      vi.mocked(window.showQuickPick)
        .mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never)
        .mockResolvedValueOnce({ yes: true } as never);

      const { provider } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]);

      expect(openWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ foldersToAdd: [{ name: "infra", path: "/repos/infra" }] }),
      );
    });

    it("adds nothing but still launches when the user declines the prompt", async () => {
      pickExisting();
      vi.mocked(planWorkspaceMerge).mockReturnValue({
        add: [{ label: "infra", repoName: "infra", path: "/repos/infra" }],
        duplicates: [],
        present: [],
        ok: true,
      });
      vi.mocked(window.showQuickPick)
        .mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never)
        .mockResolvedValueOnce({ yes: false } as never);

      const { provider } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]);

      expect(openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ foldersToAdd: [] }));
    });

    it("confirms the file was left unchanged in the toast when the user declines", async () => {
      pickExisting();
      vi.mocked(planWorkspaceMerge).mockReturnValue({
        add: [{ label: "infra", repoName: "infra", path: "/repos/infra" }],
        duplicates: [],
        present: [],
        ok: true,
      });
      vi.mocked(window.showQuickPick)
        .mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never)
        .mockResolvedValueOnce({ yes: false } as never);
      vi.mocked(openWorkspace).mockResolvedValue({
        mode: "multiroot",
        workspaceFile: "/ws/team.code-workspace",
        briefs: [],
        opened: ["/ws/team.code-workspace"],
        remoteControl: false,
      });

      const { provider, posted } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]);

      const toast = posted().find((m) => m.type === "toast") as { message: string };
      expect(toast.message).toContain("Left team.code-workspace unchanged.");
    });

    it("says nothing about the file being unchanged when nothing was ever offered", async () => {
      // declined must stay false when no prompt appeared — this isn't a decline, there
      // was no real question to answer.
      pickExisting();
      vi.mocked(planWorkspaceMerge).mockReturnValue({
        add: [],
        duplicates: [],
        present: [{ label: "account-service", repoName: "account-service", path: "/repos/account-service" }],
        ok: true,
      });
      vi.mocked(window.showQuickPick).mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never);
      vi.mocked(openWorkspace).mockResolvedValue({
        mode: "multiroot",
        workspaceFile: "/ws/team.code-workspace",
        briefs: [],
        opened: ["/ws/team.code-workspace"],
        remoteControl: false,
      });

      const { provider, posted } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]);

      const toast = posted().find((m) => m.type === "toast") as { message: string };
      expect(toast.message).not.toContain("unchanged");
    });

    it("treats a dismissed prompt as 'leave as-is', not as an abort", async () => {
      // The worktrees already exist by now — abandoning the launch is the worse failure.
      pickExisting();
      vi.mocked(planWorkspaceMerge).mockReturnValue({
        add: [{ label: "infra", repoName: "infra", path: "/repos/infra" }],
        duplicates: [],
        present: [],
        ok: true,
      });
      vi.mocked(window.showQuickPick)
        .mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never)
        .mockResolvedValueOnce(undefined as never);

      const { provider } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]);

      expect(openWorkspace).toHaveBeenCalled();
      expect(openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ foldersToAdd: [] }));
    });

    it("does not prompt when the workspace file can't be parsed", async () => {
      pickExisting();
      vi.mocked(planWorkspaceMerge).mockReturnValue({ add: [], duplicates: [], present: [], ok: false });
      vi.mocked(window.showQuickPick).mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never);

      const { provider } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]);

      expect(window.showQuickPick).toHaveBeenCalledTimes(1);
      expect(openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ foldersToAdd: [] }));
    });

    it("names skipped duplicates in the success toast", async () => {
      pickExisting();
      vi.mocked(planWorkspaceMerge).mockReturnValue({
        add: [],
        duplicates: [{ label: "account-service", repoName: "account-service", path: "/repos/account-service/.claude/worktrees/ASM-1" }],
        present: [],
        ok: true,
      });
      vi.mocked(window.showQuickPick).mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never);
      vi.mocked(openWorkspace).mockResolvedValue({
        mode: "multiroot",
        workspaceFile: "/ws/team.code-workspace",
        briefs: [],
        opened: ["/ws/team.code-workspace"],
        remoteControl: false,
      });

      const { provider, posted } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]);

      const toast = posted().find((m) => m.type === "toast") as { level: string; message: string };
      expect(toast.level).toBe("success");
      expect(toast.message).toContain("account-service");
      expect(toast.message).toMatch(/already in the workspace/i);
    });

    it("passes no foldersToAdd for a new-window destination", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "new-window" });
      const { provider } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]);
      expect(planWorkspaceMerge).not.toHaveBeenCalled();
      expect(openWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ existingWorkspaceFile: undefined, foldersToAdd: [] }),
      );
    });

    it("pluralizes the prompt and lists every new repo when more than one is added", async () => {
      pickExisting();
      vi.mocked(planWorkspaceMerge).mockReturnValue({
        add: [
          { label: "infra", repoName: "infra", path: "/repos/infra" },
          { label: "tooling", repoName: "tooling", path: "/repos/tooling" },
        ],
        duplicates: [],
        present: [],
        ok: true,
      });
      vi.mocked(window.showQuickPick)
        .mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never)
        .mockResolvedValueOnce({ yes: true } as never);

      const { provider } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]);

      const addPrompt = vi.mocked(window.showQuickPick).mock.calls[1];
      expect((addPrompt[1] as { title: string }).title).toBe("Add 2 folders to team.code-workspace?");
      expect((addPrompt[0] as { label: string }[])[0].label).toBe("$(add) Add infra, tooling");
      expect(openWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          foldersToAdd: [
            { name: "infra", path: "/repos/infra" },
            { name: "tooling", path: "/repos/tooling" },
          ],
        }),
      );
    });

    it("names every duplicate in the toast when more than one is skipped", async () => {
      pickExisting();
      vi.mocked(planWorkspaceMerge).mockReturnValue({
        add: [],
        duplicates: [
          { label: "api", repoName: "api", path: "/repos/api/.claude/worktrees/ASM-1" },
          { label: "web", repoName: "web", path: "/repos/web/.claude/worktrees/ASM-1" },
        ],
        present: [],
        ok: true,
      });
      vi.mocked(window.showQuickPick).mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never);
      vi.mocked(openWorkspace).mockResolvedValue({
        mode: "multiroot",
        workspaceFile: "/ws/team.code-workspace",
        briefs: [],
        opened: ["/ws/team.code-workspace"],
        remoteControl: false,
      });

      const { provider, posted } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]);

      const toast = posted().find((m) => m.type === "toast") as { message: string };
      expect(toast.message).toContain("api, web already in the workspace");
    });
  });

  describe("existing/live-folder destinations skip the repo picker", () => {
    it("uses the existing workspace's repos and never shows the service pick", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask" });
      vi.mocked(workspaceFolderPaths).mockReturnValue(["/repos/centaur"]);
      vi.mocked(listWorkspaceFiles).mockReturnValue([{ file: "/ws/team.code-workspace", folders: 1, mtimeMs: 1 }]);
      // Destination picks only: open-target pick → workspace-file pick. No service pick follows.
      vi.mocked(window.showQuickPick)
        .mockResolvedValueOnce({ target: { kind: "existing-pick" } } as never)
        .mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never);

      const { provider } = setup();
      await provider.takeTask("ASM-1", "command"); // no preselected repos

      expect(window.showQuickPick).toHaveBeenCalledTimes(2); // no third (service) pick
      expect(openWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          existingWorkspaceFile: "/ws/team.code-workspace",
          services: [expect.objectContaining({ name: "centaur", path: "/repos/centaur" })],
        }),
      );
    });

    it("builds a ServiceRef from a live folder that lives outside reposRoot", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask" });
      vi.mocked(window.showQuickPick).mockResolvedValueOnce(
        { target: { kind: "live-folder", folder: "/other/legacy-app" } } as never,
      );

      const { provider } = setup();
      await provider.takeTask("ASM-1", "command"); // no preselected repos

      expect(window.showQuickPick).toHaveBeenCalledTimes(1); // destination pick only
      expect(openWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          existingFolder: "/other/legacy-app",
          services: [{ name: "legacy-app", path: "/other/legacy-app", isGit: false }],
        }),
      );
    });

    it("honors an in-card preselection over the existing workspace's repos", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask" });
      vi.mocked(workspaceFolderPaths).mockReturnValue(["/repos/centaur"]);
      vi.mocked(listWorkspaceFiles).mockReturnValue([{ file: "/ws/team.code-workspace", folders: 1, mtimeMs: 1 }]);
      vi.mocked(window.showQuickPick)
        .mockResolvedValueOnce({ target: { kind: "existing-pick" } } as never)
        .mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never);

      const { provider } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]); // preselected wins

      expect(openWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          existingWorkspaceFile: "/ws/team.code-workspace",
          services: [expect.objectContaining({ name: "account-service" })],
        }),
      );
    });

    it("aborts when the existing workspace resolves to no repos", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "pick-existing" });
      vi.mocked(workspaceFolderPaths).mockReturnValue([]);
      vi.mocked(listWorkspaceFiles).mockReturnValue([{ file: "/ws/empty.code-workspace", folders: 0, mtimeMs: 1 }]);
      vi.mocked(window.showQuickPick).mockResolvedValueOnce({ file: "/ws/empty.code-workspace" } as never);

      const { provider, posted } = setup();
      await provider.takeTask("ASM-1", "command"); // no preselected repos

      expect(openWorkspace).not.toHaveBeenCalled();
      expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "error" }));
    });
  });
});

describe("Take funnel", () => {
  /** Drives a Take to a successful launch using a realistic ticket key and repo
   * name (not the generic "ASM-1"/"account-service" this file uses elsewhere) so
   * the leak test below has something concrete to check for. Default CFG (openIn
   * "new-window" → target "new", worktree "never", taskMode "plan" → a configured
   * mode, no picker) means the only QuickPick in play is the repo-confirm one —
   * skipped when `preselected` is given (the in-card path), fired otherwise (the
   * quickpick path), mirroring "confirms repos via QuickPick when none are
   * preselected" above. */
  async function takeHappyPath(opts: { preselected?: string[]; source?: TakeSource } = {}) {
    const repos = mkRepos(["acme-billing"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    if (!opts.preselected) {
      vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never);
    }
    const { provider, posted } = setup();
    await provider.takeTask("BILL-1234", opts.source ?? "card", opts.preselected);
    return posted;
  }

  /** Same shape, but openWorkspace (called inside launch()) rejects — proves a
   * thrown launch failure is reported as take_completed{failed} and still
   * propagates, since tasksView.ts:255's existing onMessage catch owns the
   * user-facing handling of that rejection. */
  function takeWithFailingLaunch() {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["acme-billing"]));
    vi.mocked(openWorkspace).mockRejectedValueOnce(new Error("disk full"));
    const { provider } = setup();
    return provider.takeTask("BILL-1234", "card", ["acme-billing"]);
  }

  it("reports the full Take funnel on a successful launch", async () => {
    await takeHappyPath();
    const names = trackSpy.mock.calls.flat().map((e: any) => e.name);
    expect(names).toEqual([
      "take_started",
      "take_prompt_mode_picked",
      "take_destination_picked",
      "take_repos_picked",
      "take_completed",
    ]);
    const started = trackSpy.mock.calls.flat().find((e: any) => e.name === "take_started") as any;
    const done = trackSpy.mock.calls.flat().find((e: any) => e.name === "take_completed") as any;
    expect(started.flow_id).toBe(done.flow_id);
    expect(started.task_fp).toMatch(/^[0-9a-f]{16}$/);
    expect(done.outcome).toBe("launched");
    expect(done.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("never sends a ticket key or repo name", async () => {
    await takeHappyPath();
    const serialized = JSON.stringify(trackSpy.mock.calls.flat());
    expect(serialized).not.toContain("BILL-1234");
    expect(serialized).not.toContain("acme-billing");
  });

  it("reports cancelled when the prompt-mode picker is dismissed", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, taskMode: "ask" });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined);
    const { provider } = setup();
    await provider.takeTask("BILL-1234", "card", ["acme-billing"]);
    const names = trackSpy.mock.calls.flat().map((e: any) => e.name);
    expect(names).toEqual(["take_started", "take_completed"]);
    expect((trackSpy.mock.calls.flat().at(-1) as any).outcome).toBe("cancelled");
  });

  it("reports cancelled with only the step events already fired when resolveKickoff aborts partway (repo QuickPick cancelled)", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["acme-billing"]));
    vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined); // cancel the repo-confirm QuickPick
    const { provider } = setup();
    await provider.takeTask("BILL-1234", "command"); // no preselected repos → reaches the QuickPick branch
    const names = trackSpy.mock.calls.flat().map((e: any) => e.name);
    expect(names).toEqual(["take_started", "take_prompt_mode_picked", "take_destination_picked", "take_completed"]);
    expect((trackSpy.mock.calls.flat().at(-1) as any).outcome).toBe("cancelled");
  });

  it("reports failed with a failure class when the launch throws, and still propagates the error", async () => {
    await expect(takeWithFailingLaunch()).rejects.toThrow("disk full");
    const done = trackSpy.mock.calls.flat().find((e: any) => e.name === "take_completed") as any;
    expect(done.outcome).toBe("failed");
    expect(done.failure_class).toBeDefined();
  });

  it("also reports operation_failed when a failing take reaches the dispatcher (both events fire, deliberately — see tasksView.ts:257)", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["acme-billing"]));
    vi.mocked(openWorkspace).mockRejectedValueOnce(new Error("disk full"));
    const { send } = setup();
    await send({ type: "take", key: "BILL-1234", services: ["acme-billing"] });
    const done = trackSpy.mock.calls.flat().find((e: any) => e.name === "take_completed") as any;
    expect(done.outcome).toBe("failed");
    const opFailed = trackErrorSpy.mock.calls.flat().find((e: any) => e.name === "operation_failed") as any;
    expect(opFailed).toBeDefined();
    expect(opFailed.op).toBe("workspace_write");
  });

  it("reports jira_fetch — not workspace_write — when the ticket read inside a take fails with a real Jira error", async () => {
    // resolveKickoff()'s getDetail() call has no try/catch of its own; MESSAGE_OPS
    // alone would label this "workspace_write" (take's own primary purpose).
    // resolveOp() must recognize the Jira-origin error and override it.
    clientStub.getDetail.mockRejectedValueOnce(parseJiraError(404, JSON.stringify({ errorMessages: ["Issue does not exist"] })));
    const { send } = setup();
    await send({ type: "take", key: "BILL-1234", services: ["acme-billing"] });
    const opFailed = trackErrorSpy.mock.calls.flat().find((e: any) => e.name === "operation_failed") as any;
    expect(opFailed).toBeDefined();
    expect(opFailed.op).toBe("jira_fetch");
  });

  it("reports jira_fetch with failure_class network for an unreachable-host failure during take, and never leaks the site URL", async () => {
    // request()'s network-level catch (src/jira/client.ts) throws a plain Error —
    // not JiraApiError/JiraAuthError — for an unreachable host, tagged via
    // markJiraNetworkFailure so resolveOp() and classifyFailure() both recognize
    // it. The message embeds the user's own Jira site URL; operation_failed must
    // never carry any part of it.
    clientStub.getDetail.mockRejectedValueOnce(
      markJiraNetworkFailure(new Error("Couldn't reach Jira at https://my-secret-org.atlassian.net: fetch failed"), "ENOTFOUND"),
    );
    const { send } = setup();
    await send({ type: "take", key: "BILL-1234", services: ["acme-billing"] });
    const opFailed = trackErrorSpy.mock.calls.flat().find((e: any) => e.name === "operation_failed") as any;
    expect(opFailed).toBeDefined();
    expect(opFailed.op).toBe("jira_fetch");
    expect(opFailed.failure_class).toBe("network");
    expect(JSON.stringify(opFailed)).not.toContain("my-secret-org");
  });

  it("reports jira_fetch with failure_class timeout for a Jira timeout during take, and never leaks the site URL", async () => {
    clientStub.getDetail.mockRejectedValueOnce(
      markJiraNetworkFailure(
        new Error("Jira didn't respond within 15s (https://my-secret-org.atlassian.net). Check agentFlow.jira.baseUrl and your network/VPN."),
        "ETIMEDOUT",
      ),
    );
    const { send } = setup();
    await send({ type: "take", key: "BILL-1234", services: ["acme-billing"] });
    const opFailed = trackErrorSpy.mock.calls.flat().find((e: any) => e.name === "operation_failed") as any;
    expect(opFailed).toBeDefined();
    expect(opFailed.op).toBe("jira_fetch");
    expect(opFailed.failure_class).toBe("timeout");
    expect(JSON.stringify(opFailed)).not.toContain("my-secret-org");
  });

  it("still reports workspace_write when a take fails for a genuine non-Jira reason (launch() throwing an ENOENT)", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["acme-billing"]));
    const enoent = Object.assign(new Error("no such file or directory"), { code: "ENOENT" });
    vi.mocked(openWorkspace).mockRejectedValueOnce(enoent);
    const { send } = setup();
    await send({ type: "take", key: "BILL-1234", services: ["acme-billing"] });
    const opFailed = trackErrorSpy.mock.calls.flat().find((e: any) => e.name === "operation_failed") as any;
    expect(opFailed).toBeDefined();
    expect(opFailed.op).toBe("workspace_write");
    expect(opFailed.failure_class).toBe("not_found");
  });

  it("reports cancelled (not launched) when the worktree picker inside launch() is cancelled — agentFlow.worktree's default ('ask')", async () => {
    // cfg.worktree defaults to "ask" (src/config.ts:252) on a stock install, so this
    // picker — not a rare edge case — fires on every Take unless the user changed the
    // setting. Cancelling it (Escape) aborts launch() without throwing; before the
    // Critical fix this reported outcome:"launched" because launch()'s return value
    // was discarded entirely.
    vi.mocked(getConfig).mockReturnValue({ ...CFG, worktree: "ask" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["acme-billing"]));
    vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined); // cancel launch()'s worktree picker
    const { provider } = setup();
    await provider.takeTask("BILL-1234", "card", ["acme-billing"]); // preselected: resolveKickoff shows no picker of its own
    expect(openWorkspace).not.toHaveBeenCalled();
    const names = trackSpy.mock.calls.flat().map((e: any) => e.name);
    expect(names).toEqual([
      "take_started",
      "take_prompt_mode_picked",
      "take_destination_picked",
      "take_repos_picked",
      "take_completed",
    ]);
    const done = trackSpy.mock.calls.flat().find((e: any) => e.name === "take_completed") as any;
    expect(done.outcome).toBe("cancelled");
  });

  it("reports cancelled (not launched) when the workspace-mode picker inside launch() is cancelled (workspaceMode 'ask', 2+ repos, new window)", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, workspaceMode: "ask" });
    const repos = mkRepos(["acme-billing", "centaur"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined); // cancel launch()'s workspace-mode picker
    const { provider } = setup();
    await provider.takeTask("BILL-1234", "card", ["acme-billing", "centaur"]);
    expect(openWorkspace).not.toHaveBeenCalled();
    const done = trackSpy.mock.calls.flat().find((e: any) => e.name === "take_completed") as any;
    expect(done.outcome).toBe("cancelled");
  });

  it("marks repo_source as preselected when the card supplied repos, and omits accepted_inference (inference never ran)", async () => {
    await takeHappyPath({ preselected: ["acme-billing"] });
    const picked = trackSpy.mock.calls.flat().find((e: any) => e.name === "take_repos_picked") as any;
    expect(picked.repo_source).toBe("preselected");
    expect(picked.accepted_inference).toBeUndefined();
    expect("accepted_inference" in picked).toBe(false);
  });

  it("marks repo_source as destination when an existing/live-folder target fixes the repo set, and omits accepted_inference", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask" });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce(
      { target: { kind: "live-folder", folder: "/other/legacy-app" } } as never,
    );
    const { provider } = setup();
    await provider.takeTask("BILL-1234", "command"); // no preselected repos
    const picked = trackSpy.mock.calls.flat().find((e: any) => e.name === "take_repos_picked") as any;
    expect(picked.repo_source).toBe("destination");
    expect(picked.accepted_inference).toBeUndefined();
    expect("accepted_inference" in picked).toBe(false);
  });

  it("marks repo_source as quickpick and accepted_inference true when the confirmed picks match inference exactly", async () => {
    const repos = mkRepos(["acme-billing"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    clientStub.getDetail.mockResolvedValue({
      key: "BILL-1234",
      summary: "Fix the billing thing",
      descriptionText: "desc",
      labels: [],
      components: ["acme-billing"], // inference matches this repo via component
      url: "https://jira/browse/BILL-1234",
    });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never); // confirms exactly what was inferred
    const { provider } = setup();
    await provider.takeTask("BILL-1234", "command");
    const picked = trackSpy.mock.calls.flat().find((e: any) => e.name === "take_repos_picked") as any;
    expect(picked.repo_source).toBe("quickpick");
    expect(picked.inferred_count).toBe(1);
    expect(picked.accepted_inference).toBe(true);
  });

  it("marks accepted_inference false when the confirmed repo count differs from inference", async () => {
    const repos = mkRepos(["acme-billing", "centaur"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    clientStub.getDetail.mockResolvedValue({
      key: "BILL-1234",
      summary: "Fix the billing thing",
      descriptionText: "desc",
      labels: [],
      components: ["acme-billing"],
      url: "https://jira/browse/BILL-1234",
    });
    // Confirms BOTH repos — one more than the single inferred one.
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }, { repo: repos[1] }] as never);
    const { provider } = setup();
    await provider.takeTask("BILL-1234", "command");
    const picked = trackSpy.mock.calls.flat().find((e: any) => e.name === "take_repos_picked") as any;
    expect(picked.repo_source).toBe("quickpick");
    expect(picked.inferred_count).toBe(1);
    expect(picked.accepted_inference).toBe(false);
  });

  it("marks accepted_inference false on a same-count swap (inferred acme-billing, user picks centaur instead)", async () => {
    const repos = mkRepos(["acme-billing", "centaur"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    clientStub.getDetail.mockResolvedValue({
      key: "BILL-1234",
      summary: "Fix the billing thing",
      descriptionText: "desc",
      labels: [],
      components: ["acme-billing"], // inference proposes acme-billing only
      url: "https://jira/browse/BILL-1234",
    });
    // Confirms centaur instead — same count (1) as inferred, but a different repo.
    // A count-only comparison would (wrongly) call this "accepted".
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[1] }] as never);
    const { provider } = setup();
    await provider.takeTask("BILL-1234", "command");
    const picked = trackSpy.mock.calls.flat().find((e: any) => e.name === "take_repos_picked") as any;
    expect(picked.repo_source).toBe("quickpick");
    expect(picked.inferred_count).toBe(1);
    expect(picked.accepted_inference).toBe(false);
  });

  it("reports take_destination_picked with the resolved destination and workspace_mode, and no worktree claim", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, workspaceMode: "per-window", worktree: "always" });
    await takeHappyPath({ preselected: ["acme-billing"] });
    const picked = trackSpy.mock.calls.flat().find((e: any) => e.name === "take_destination_picked") as any;
    expect(picked.destination).toBe("new");
    expect(picked.workspace_mode).toBe("per-window");
    // The worktree question hasn't been asked yet at this point in the funnel —
    // this event must not pretend to answer it.
    expect("used_worktree" in picked).toBe(false);
  });

  // agentFlow.worktree ships as "ask" (package.json / src/config.ts), so these two
  // cases — not the "always"/"never" ones — are what every Take does by default.
  it("reports used_worktree true on take_completed when the default worktree QuickPick is accepted", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, worktree: "ask" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["acme-billing"]));
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ yes: true } as never); // accept the worktree picker
    const { provider } = setup();
    await provider.takeTask("BILL-1234", "card", ["acme-billing"]);
    expect(createWorktrees).toHaveBeenCalledTimes(1);
    const done = trackSpy.mock.calls.flat().find((e: any) => e.name === "take_completed") as any;
    expect(done.outcome).toBe("launched");
    expect(done.used_worktree).toBe(true);
  });

  it("reports used_worktree false on take_completed when the default worktree QuickPick is declined", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, worktree: "ask" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["acme-billing"]));
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ yes: false } as never); // "work in the repo directly"
    const { provider } = setup();
    await provider.takeTask("BILL-1234", "card", ["acme-billing"]);
    expect(createWorktrees).not.toHaveBeenCalled();
    const done = trackSpy.mock.calls.flat().find((e: any) => e.name === "take_completed") as any;
    expect(done.outcome).toBe("launched");
    expect(done.used_worktree).toBe(false);
  });

  it("omits used_worktree when the Take ends before the worktree question is answered", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, worktree: "ask" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["acme-billing"]));
    vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined); // cancel the worktree picker
    const { provider } = setup();
    await provider.takeTask("BILL-1234", "card", ["acme-billing"]);
    const done = trackSpy.mock.calls.flat().find((e: any) => e.name === "take_completed") as any;
    expect(done.outcome).toBe("cancelled");
    expect("used_worktree" in done).toBe(false);
  });

  it("still reports the worktree decision when the launch throws after it was made", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, worktree: "ask" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["acme-billing"]));
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ yes: true } as never);
    vi.mocked(openWorkspace).mockRejectedValueOnce(new Error("disk full"));
    const { provider } = setup();
    await expect(provider.takeTask("BILL-1234", "card", ["acme-billing"])).rejects.toThrow("disk full");
    const done = trackSpy.mock.calls.flat().find((e: any) => e.name === "take_completed") as any;
    expect(done.outcome).toBe("failed");
    expect(done.used_worktree).toBe(true);
  });

  it("reports source card for a one-click Take from a collapsed card (no in-card selection)", async () => {
    // App.tsx sends `services: undefined` unless the card is expanded WITH a
    // selection, so the common card Take carries no repos — inferring the source
    // from that would call it a palette Take.
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["acme-billing"]));
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: mkRepos(["acme-billing"])[0] }] as never);
    const { send } = setup();
    await send({ type: "take", key: "BILL-1234", services: undefined });
    const started = trackSpy.mock.calls.flat().find((e: any) => e.name === "take_started") as any;
    expect(started.source).toBe("card");
  });

  it("reports source command for a palette Take even when the caller supplies no repos", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["acme-billing"]));
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: mkRepos(["acme-billing"])[0] }] as never);
    const { provider } = setup();
    await provider.takeTask("BILL-1234", "command");
    const started = trackSpy.mock.calls.flat().find((e: any) => e.name === "take_started") as any;
    expect(started.source).toBe("command");
  });

  it("terminates the funnel with take_completed{failed} when the Jira read inside resolveKickoff fails, and still propagates", async () => {
    // resolveKickoff() used to sit outside takeTask's try/catch: a failing ticket
    // read left the funnel with no terminator at all, so a *failure* was
    // indistinguishable from the user walking away. operation_failed is no
    // substitute — it carries no flow_id.
    clientStub.getDetail.mockRejectedValueOnce(
      markJiraNetworkFailure(new Error("Couldn't reach Jira at https://my-secret-org.atlassian.net: fetch failed"), "ENOTFOUND"),
    );
    const { provider } = setup();
    await expect(provider.takeTask("BILL-1234", "card", ["acme-billing"])).rejects.toThrow();
    const events = trackSpy.mock.calls.flat();
    expect(events.map((e: any) => e.name)).toEqual(["take_started", "take_prompt_mode_picked", "take_completed"]);
    const done = events.find((e: any) => e.name === "take_completed") as any;
    expect(done.outcome).toBe("failed");
    expect(done.failure_class).toBe("network");
    // Same flow_id as take_started, which is what makes the failed Take
    // reconstructable — the reason operation_failed can't stand in for this.
    expect(done.flow_id).toBe((events[0] as any).flow_id);
    expect(JSON.stringify(done)).not.toContain("my-secret-org");
  });

  it("terminates the funnel with take_completed{failed} for a 404 on the ticket read too", async () => {
    clientStub.getDetail.mockRejectedValueOnce(parseJiraError(404, JSON.stringify({ errorMessages: ["Issue does not exist"] })));
    const { provider } = setup();
    await expect(provider.takeTask("BILL-1234", "command")).rejects.toThrow();
    const done = trackSpy.mock.calls.flat().find((e: any) => e.name === "take_completed") as any;
    expect(done.outcome).toBe("failed");
    // JiraApiError carries `status`, not a `code` classifyFailure knows, so a 404
    // lands in the catch-all class. The terminator firing at all is the point here.
    expect(done.failure_class).toBe("unknown");
  });

  it("reports take_repos_picked and take_completed with the real repo_count", async () => {
    const repos = mkRepos(["acme-billing", "centaur"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    const { provider } = setup();
    await provider.takeTask("BILL-1234", "card", ["acme-billing", "centaur"]);
    const picked = trackSpy.mock.calls.flat().find((e: any) => e.name === "take_repos_picked") as any;
    const done = trackSpy.mock.calls.flat().find((e: any) => e.name === "take_completed") as any;
    expect(picked.repo_count).toBe(2);
    expect(done.repo_count).toBe(2);
  });

  it("does not instrument addressPr's shared resolveKickoff call — no funnel events fire", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["acme-billing"]));
    const { provider } = setup();
    await provider.addressPr("BILL-1234", ["acme-billing"]);
    expect(trackSpy).not.toHaveBeenCalled();
  });
});

describe("takeBatch", () => {
  const twoKeys = ["ASM-1", "ASM-2"];

  // With the worktree-fallback guard in place, a *successful* worktree must return a
  // path different from the main checkout. Simulate that here; restore the identity
  // default in afterEach so this impl doesn't leak into later describes.
  beforeEach(() => {
    vi.mocked(createWorktrees).mockImplementation((s, key) =>
      s.map((r) => ({ ...r, path: `${r.path}/.claude/worktrees/${key}` })),
    );
    // Default answer for the layout pick; tests that drive the picker themselves
    // shadow this with mockResolvedValueOnce. No afterEach reset needed for this one —
    // the global beforeEach (test/_setup.ts's resetVscodeMocks) already resets
    // showQuickPick before every test, so this default can't leak past this block.
    vi.mocked(window.showQuickPick).mockResolvedValue({ shared: false } as never);
  });
  afterEach(() => {
    // createWorktrees has no global reset, unlike showQuickPick — this restore IS
    // load-bearing, or the identity-mapping impl above would leak into later describes.
    vi.mocked(createWorktrees).mockImplementation((s) => s);
  });

  it("is a no-op for an empty selection", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    const { provider } = setup();
    await provider.takeBatch([], ["api"]);
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(discoverRepos).not.toHaveBeenCalled();
  });

  it("launches when the over-threshold confirmation is accepted", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, batchLaunchConfirmThreshold: 1 });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(window.showWarningMessage).mockResolvedValueOnce("Launch" as never);
    const { provider } = setup();
    await provider.takeBatch(["ASM-1", "ASM-2"], ["api"]); // 2 > 1 → confirm
    expect(window.showWarningMessage).toHaveBeenCalled();
    expect(openWorkspace).toHaveBeenCalledTimes(2);
  });

  it("skips a task whose worktree creation falls back to the main checkout and reports it failed", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(createWorktrees).mockImplementation((s) => s); // fallback: path stays === repoRef.path
    const { provider, posted } = setup();
    await provider.takeBatch(["ASM-1"], ["api"]);
    expect(openWorkspace).not.toHaveBeenCalled();
    const toast = posted().find((m) => m.type === "toast") as { level: string; message: string };
    expect(toast.level).toBe("error");
    expect(toast.message).toContain("Launched 0 of 1");
  });

  it("names the repo whose worktree fell back, so a multi-repo task's failure is actionable", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["billing", "payments"]));
    clientStub.getDetail.mockResolvedValue({
      key: "ASM-1",
      summary: "nothing recognisable here",
      descriptionText: "",
      labels: [],
      components: [],
      url: "https://jira/browse/ASM-1",
    });
    // billing gets its worktree; payments falls back to the main checkout.
    vi.mocked(createWorktrees).mockImplementation((s, key) =>
      s.map((r) => (r.name === "payments" ? r : { ...r, path: `${r.path}/.claude/worktrees/${key}` })),
    );
    const { provider, posted } = setup();
    await provider.takeBatch(["ASM-1"], ["billing", "payments"]);
    expect(openWorkspace).not.toHaveBeenCalled();
    const toast = posted().find((m) => m.type === "toast") as { level: string; message: string };
    expect(toast.message).toContain("payments");
    expect(toast.message).not.toContain("billing");
  });

  it("launches one worktree'd new window per selected task in the filtered repo", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api", "billing"]));
    const { provider } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    expect(vi.mocked(createWorktrees)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(createWorktrees).mock.calls[0][0]).toEqual([expect.objectContaining({ name: "api" })]);
    expect(openWorkspace).toHaveBeenCalledTimes(2);
    expect(openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ mode: "per-window", openIn: "new" }));
  });

  it("uses the configured task prompt mode without prompting", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    const { provider } = setup();
    await provider.takeBatch(["ASM-1"], ["api"]); // CFG.taskMode = "plan" is a known mode
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ promptTemplate: "P {key}" }));
  });

  it("asks the prompt mode once when taskMode is 'ask' and applies it to all", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, taskMode: "ask" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ mode: CFG.promptModes[0] } as never)
      .mockResolvedValueOnce({ shared: false } as never);
    const { provider } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    expect(window.showQuickPick).toHaveBeenCalledTimes(2); // prompt mode + layout, each once — not per task
    expect(openWorkspace).toHaveBeenCalledTimes(2);
  });

  it("aborts when the prompt-mode pick is cancelled", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, taskMode: "ask" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined);
    const { provider } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it("drops a non-git repo from the set and launches on the rest", async () => {
    vi.mocked(discoverRepos).mockReturnValue([
      { name: "api", path: "/repos/api", isGit: true },
      { name: "docs", path: "/repos/docs", isGit: false },
    ]);
    const { provider, posted } = setup();
    await provider.takeBatch(["ASM-1"], ["api", "docs"]);
    expect(openWorkspace).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createWorktrees).mock.calls[0][0]).toEqual([expect.objectContaining({ name: "api" })]);
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "info" }));
  });

  it("drops a name absent from the discovered repos and launches on the rest", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    const { provider, posted } = setup();
    await provider.takeBatch(["ASM-1"], ["api", "ghost"]);
    expect(openWorkspace).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createWorktrees).mock.calls[0][0]).toEqual([expect.objectContaining({ name: "api" })]);
    const toast = posted().find((m) => m.type === "toast" && m.level === "info") as { message: string };
    expect(toast.message).toContain("ghost");
  });

  it("errors when no selected repo resolves to a git repo", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"], { isGit: false }));
    const { provider, posted } = setup();
    await provider.takeBatch(["ASM-1"], ["api"]);
    expect(createWorktrees).not.toHaveBeenCalled();
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "error" }));
  });

  it("continues past a failing task and reports the failure count", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(openWorkspace)
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce({ mode: "per-window", workspaceFile: undefined, briefs: [], opened: ["/x"], remoteControl: false });
    const { provider, posted } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    expect(openWorkspace).toHaveBeenCalledTimes(2);
    const toast = posted().find((m) => m.type === "toast") as { level: string; message: string };
    expect(toast.level).toBe("error");
    expect(toast.message).toContain("Launched 1 of 2");
  });

  it("confirms before launching more than the threshold, and aborts if dismissed", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, batchLaunchConfirmThreshold: 1 });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(window.showWarningMessage).mockResolvedValueOnce(undefined); // dismissed
    const { provider } = setup();
    await provider.takeBatch(twoKeys, ["api"]); // 2 > 1 → confirm
    expect(window.showWarningMessage).toHaveBeenCalled();
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it("routes the takeBatch message through onMessage to the handler", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    const { send } = setup();
    await send({ type: "takeBatch", keys: ["ASM-1"], repos: ["api"] });
    expect(openWorkspace).toHaveBeenCalled();
  });

  it("gives each task the repos it touches, intersected with the filter set", async () => {
    // The summary mentions only ONE of the two filter-set repos, so a correct
    // intersection is a strict subset of the filter set — this fails equally under
    // "always return filterSet" (no real intersection) and under a broken intersection.
    // inferServices ignores repo names under 5 chars as too generic to trust (see
    // src/engine/infer.ts), so keep names 5+ chars.
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["billing", "payments"]));
    clientStub.getDetail.mockResolvedValue({
      key: "ASM-1",
      summary: "fix the billing flow",
      descriptionText: "desc",
      labels: [],
      components: [],
      url: "https://jira/browse/ASM-1",
    });
    const { provider } = setup();
    await provider.takeBatch(["ASM-1"], ["billing", "payments"]);
    const picked = vi.mocked(createWorktrees).mock.calls[0][0].map((r) => r.name);
    expect(picked).toEqual(["billing"]); // payments is in the filter set but not inferred — excluded
  });

  it("falls back to the whole filter set when a task infers no repo in it", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api", "billing"]));
    clientStub.getDetail.mockResolvedValue({
      key: "ASM-1",
      summary: "nothing recognisable here",
      descriptionText: "",
      labels: [],
      components: [],
      url: "https://jira/browse/ASM-1",
    });
    const { provider } = setup();
    await provider.takeBatch(["ASM-1"], ["api", "billing"]);
    const picked = vi.mocked(createWorktrees).mock.calls[0][0].map((r) => r.name);
    expect(picked.sort()).toEqual(["api", "billing"]);
  });

  // The separate-windows layout promises "one window per task". A batched task can now
  // span several repos, so the layout has to be decided per task from its repo count —
  // a fixed per-window mode would fan a two-repo task out into two windows.
  it("gives a multi-repo task ONE multi-root window, not one window per repo", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["billing", "payments"]));
    clientStub.getDetail.mockResolvedValue({
      key: "ASM-1",
      summary: "nothing recognisable here",
      descriptionText: "",
      labels: [],
      components: [],
      url: "https://jira/browse/ASM-1",
    });
    const { provider } = setup();
    await provider.takeBatch(["ASM-1"], ["billing", "payments"]);
    expect(openWorkspace).toHaveBeenCalledTimes(1);
    expect(openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ mode: "multiroot" }));
    const req = vi.mocked(openWorkspace).mock.calls[0][0];
    expect(req.services.map((s) => s.name)).toEqual(["billing", "payments"]);
  });

  it("gives a single-repo task its own plain window", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["billing", "payments"]));
    clientStub.getDetail.mockResolvedValue({
      key: "ASM-1",
      summary: "fix the billing flow",
      descriptionText: "",
      labels: [],
      components: [],
      url: "https://jira/browse/ASM-1",
    });
    const { provider } = setup();
    await provider.takeBatch(["ASM-1"], ["billing", "payments"]);
    expect(openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ mode: "per-window" }));
  });

  it("honours workspaceMode 'per-window' for a multi-repo task", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, workspaceMode: "per-window" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["billing", "payments"]));
    clientStub.getDetail.mockResolvedValue({
      key: "ASM-1",
      summary: "nothing recognisable here",
      descriptionText: "",
      labels: [],
      components: [],
      url: "https://jira/browse/ASM-1",
    });
    const { provider } = setup();
    await provider.takeBatch(["ASM-1"], ["billing", "payments"]);
    expect(openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ mode: "per-window" }));
  });

  it("asks the destination once for the whole batch", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    // 1st pick: destination (new window). 2nd: layout (separate windows).
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ target: { kind: "new" } } as never)
      .mockResolvedValueOnce({ shared: false } as never);
    const { provider } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    expect(window.showQuickPick).toHaveBeenCalledTimes(2); // destination + layout, not per task
    expect(openWorkspace).toHaveBeenCalledTimes(2);
  });

  it("asks the layout only for a new window, and uses the shared path when chosen", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "new-window" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ shared: true } as never);
    const { provider } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(openSharedWorkspace).toHaveBeenCalledTimes(1);
    expect(openSharedWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: "new" } }),
    );
    const req = vi.mocked(openSharedWorkspace).mock.calls[0][0];
    expect(req.tasks.map((t) => t.ticket.key)).toEqual(twoKeys);
  });

  it("aborts when the layout pick is cancelled", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "new-window" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined);
    const { provider } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(openSharedWorkspace).not.toHaveBeenCalled();
  });

  it("skips the layout pick for this-window and goes straight to the shared path", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "this-window" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    const { provider } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(openSharedWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: "current" } }),
    );
  });

  it("skips the layout pick for a one-key batch", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "new-window" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    const { provider } = setup();
    await provider.takeBatch(["ASM-1"], ["api"]);
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(openWorkspace).toHaveBeenCalledTimes(1);
  });

  it("aborts when the destination pick is cancelled", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined);
    const { provider } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(openSharedWorkspace).not.toHaveBeenCalled();
  });

  it("warns about worktrees a live window couldn't take", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({
      target: { kind: "live-folder", folder: "/repos/web" },
    } as never);
    vi.mocked(openSharedWorkspace).mockResolvedValue({
      workspaceFile: undefined,
      opened: true,
      briefs: [],
      unaddedFolders: ["ASM-1-api", "ASM-2-api"],
      seeded: 2,
    });
    const { provider, posted } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    const toast = posted().find((m) => m.type === "toast") as { message: string };
    expect(toast.message).toContain("ASM-1-api");
  });

  it("says so when merging into an existing workspace fails to parse", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({
      target: { kind: "existing", file: "/ws/team.code-workspace" },
    } as never);
    vi.mocked(openSharedWorkspace).mockResolvedValue({
      workspaceFile: "/ws/team.code-workspace",
      opened: true,
      briefs: [],
      mergeFailed: true,
      seeded: 2,
    });
    const { provider, posted } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    const toast = posted().find((m) => m.type === "toast") as { message: string };
    expect(toast.message).toContain("couldn't be parsed");
  });

  it("fails every resolved task when the shared window itself throws", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "new-window" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ shared: true } as never);
    vi.mocked(openSharedWorkspace).mockRejectedValueOnce(new Error("disk full"));
    const { provider, posted } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    const toast = posted().find((m) => m.type === "toast") as { level: string; message: string };
    expect(toast.level).toBe("error");
    expect(toast.message).toContain("Launched 0 of 2");
    expect(toast.message).toContain("ASM-1 (disk full)");
    expect(toast.message).toContain("ASM-2 (disk full)");
  });

  it("skips Remote Control without asking for a one-key batch to a shared (non-new) destination", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "this-window", remoteControl: "ask" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    const { provider, posted } = setup();
    await provider.takeBatch(["ASM-1"], ["api"]);
    expect(window.showQuickPick).not.toHaveBeenCalled(); // resolveRemoteControl's picker never fires
    expect(openSharedWorkspace).toHaveBeenCalledTimes(1);
    const toast = posted().find((m) => m.type === "toast") as { message: string };
    expect(toast.message).toContain("Remote Control skipped — a shared window seeds each session from its own plan file.");
  });

  it("adds nothing to a shared existing workspace when every repo name is present", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "pick-existing" });
    vi.mocked(listWorkspaceFiles).mockReturnValue([
      { file: "/ws/team.code-workspace", folders: 1, mtimeMs: 1 },
    ]);
    vi.mocked(planWorkspaceMerge).mockReturnValue({
      add: [],
      duplicates: [{ label: "ASM-1-account-service", repoName: "account-service", path: "/repos/account-service/.claude/worktrees/ASM-1" }],
      present: [],
      ok: true,
    });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never);
    vi.mocked(openSharedWorkspace).mockResolvedValue({
      opened: true, briefs: [], seeded: 1, workspaceFile: "/ws/team.code-workspace",
    });

    const { provider } = setup();
    await provider.takeBatch(["ASM-1"], ["account-service"]);

    expect(openSharedWorkspace).toHaveBeenCalledWith(expect.objectContaining({ foldersToAdd: [] }));
    // Pins the candidate array itself: if `label` ever regressed from folderName(key, repo)
    // to the bare repo name, this would still pass on `foldersToAdd: []` alone while two
    // tasks in one repo silently became two identically-named roots.
    expect(planWorkspaceMerge).toHaveBeenCalledWith(
      "/ws/team.code-workspace",
      [expect.objectContaining({ label: "ASM-1-account-service", repoName: "account-service" })],
    );
  });

  it("dedups the prompt copy when two tasks would add the same not-yet-present repo", async () => {
    // Both candidates carry repoName "account-service" (distinct key-qualified labels),
    // so the prompt text must say it once — "Add account-service", not "…, account-service"
    // — even though both folders still get added.
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "pick-existing" });
    vi.mocked(listWorkspaceFiles).mockReturnValue([
      { file: "/ws/team.code-workspace", folders: 0, mtimeMs: 1 },
    ]);
    vi.mocked(planWorkspaceMerge).mockReturnValue({
      add: [
        { label: "ASM-1-account-service", repoName: "account-service", path: "/repos/account-service/.claude/worktrees/ASM-1" },
        { label: "ASM-2-account-service", repoName: "account-service", path: "/repos/account-service/.claude/worktrees/ASM-2" },
      ],
      duplicates: [],
      present: [],
      ok: true,
    });
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never)
      .mockResolvedValueOnce({ yes: true } as never);
    vi.mocked(openSharedWorkspace).mockResolvedValue({
      opened: true, briefs: [], seeded: 2, workspaceFile: "/ws/team.code-workspace",
    });

    const { provider } = setup();
    await provider.takeBatch(twoKeys, ["account-service"]);

    const addPrompt = vi.mocked(window.showQuickPick).mock.calls[1];
    expect((addPrompt[0] as { label: string }[])[0].label).toBe("$(add) Add account-service");
    expect(openSharedWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        foldersToAdd: [
          { name: "ASM-1-account-service", path: "/repos/account-service/.claude/worktrees/ASM-1" },
          { name: "ASM-2-account-service", path: "/repos/account-service/.claude/worktrees/ASM-2" },
        ],
      }),
    );
  });

  it("confirms the file was left unchanged in the summary toast when the batch declines the prompt", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "pick-existing" });
    vi.mocked(listWorkspaceFiles).mockReturnValue([
      { file: "/ws/team.code-workspace", folders: 1, mtimeMs: 1 },
    ]);
    vi.mocked(planWorkspaceMerge).mockReturnValue({
      add: [{ label: "ASM-1-account-service", repoName: "account-service", path: "/repos/account-service/.claude/worktrees/ASM-1" }],
      duplicates: [],
      present: [],
      ok: true,
    });
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never)
      .mockResolvedValueOnce({ yes: false } as never);
    vi.mocked(openSharedWorkspace).mockResolvedValue({
      opened: true, briefs: [], seeded: 1, workspaceFile: "/ws/team.code-workspace",
    });

    const { provider, posted } = setup();
    await provider.takeBatch(["ASM-1"], ["account-service"]);

    expect(openSharedWorkspace).toHaveBeenCalledWith(expect.objectContaining({ foldersToAdd: [] }));
    const toast = posted().find((m) => m.type === "toast") as { message: string };
    expect(toast.message).toContain("Left team.code-workspace unchanged.");
  });
});

describe("live-window open targets", () => {
  const askCfg = () => vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask" });

  it("lists an open workspace window and opens the task into it (merge path)", async () => {
    askCfg();
    vi.mocked(readLiveWindows).mockReturnValue([
      { pid: 1, identity: "/ws/team.code-workspace", kind: "workspace", label: "team.code-workspace", folders: 2, updatedAt: 9 },
    ]);
    // The open-target picker returns the live workspace window's mapped target.
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ target: { kind: "existing", file: "/ws/team.code-workspace" } } as never);

    const { provider } = setup();
    await provider.takeTask("ASM-1", "card", ["account-service"]);

    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ existingWorkspaceFile: "/ws/team.code-workspace", mode: "multiroot", openIn: "new" }),
    );
  });

  it("lists an open folder window and opens the task into it (focus + seed)", async () => {
    askCfg();
    vi.mocked(readLiveWindows).mockReturnValue([
      { pid: 1, identity: "/repos/account-service", kind: "folder", label: "account-service", folders: 1, updatedAt: 9 },
    ]);
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ target: { kind: "live-folder", folder: "/repos/account-service" } } as never);

    const { provider } = setup();
    await provider.takeTask("ASM-1", "card", ["account-service"]);

    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ existingFolder: "/repos/account-service", mode: "per-window", openIn: "new" }),
    );
  });

  it("excludes the current window from the live list", async () => {
    askCfg();
    vi.mocked(windowIdentity).mockReturnValue({ identity: "/repos/account-service", kind: "folder", label: "account-service", folders: 1 });
    vi.mocked(readLiveWindows).mockReturnValue([
      { pid: 1, identity: "/repos/account-service", kind: "folder", label: "account-service", folders: 1, updatedAt: 9 },
      { pid: 2, identity: "/repos/centaur", kind: "folder", label: "centaur", folders: 1, updatedAt: 8 },
    ]);
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ target: { kind: "new" } } as never);

    const { provider } = setup();
    await provider.takeTask("ASM-1", "card", ["account-service"]);

    const items = vi.mocked(window.showQuickPick).mock.calls[0][0] as { label: string }[];
    const labels = items.map((i) => i.label);
    expect(labels.some((l) => l.includes("centaur"))).toBe(true);
    expect(labels.some((l) => l.includes("account-service"))).toBe(false); // current window excluded
  });

  it("does not read live windows when tracking is disabled", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask", trackOpenWindows: false });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ target: { kind: "new" } } as never);

    const { provider } = setup();
    await provider.takeTask("ASM-1", "card", ["account-service"]);

    expect(readLiveWindows).not.toHaveBeenCalled();
  });
});

describe("explore — open target", () => {
  const runExplore = async () => {
    const provider = setup().provider;
    await (provider as unknown as { explore: () => Promise<void> }).explore();
  };

  it("routes Explore through the open-target picker and into an existing workspace", async () => {
    // exploreMode set to a real action id so chooseExploreAction returns without a pick,
    // keeping this test focused on the open-target step.
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask", exploreMode: "knowledge" });
    // topic input → open-target pick (existing workspace) → ws pick. No repo pick — the
    // workspace's own folders are used.
    vi.mocked(window.showInputBox).mockResolvedValueOnce("retries");
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ target: { kind: "existing-pick" } } as never)  // open where (first)
      .mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never);   // which workspace
    vi.mocked(workspaceFolderPaths).mockReturnValue(["/repos/account-service"]);
    vi.mocked(listWorkspaceFiles).mockReturnValue([{ file: "/ws/team.code-workspace", folders: 1, mtimeMs: 1 }]);

    await runExplore();

    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ existingWorkspaceFile: "/ws/team.code-workspace", mode: "multiroot", openIn: "new" }),
    );
  });

  it("opens an Explore session into a live folder window", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask", exploreMode: "knowledge" });
    vi.mocked(readLiveWindows).mockReturnValue([
      { pid: 1, identity: "/repos/centaur", kind: "folder", label: "centaur", folders: 1, updatedAt: 9 },
    ]);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("poke around");
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ target: { kind: "live-folder", folder: "/repos/centaur" } } as never) // open where (first)
      .mockResolvedValueOnce([{ repo: mkRepos(["centaur"])[0] }] as never);                            // repos (last)

    await runExplore();

    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ existingFolder: "/repos/centaur", mode: "per-window", openIn: "new" }),
    );
  });

  it("skips the repo pick and uses the existing workspace's repos", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask", exploreMode: "knowledge" });
    vi.mocked(workspaceFolderPaths).mockReturnValue(["/repos/centaur"]);
    vi.mocked(listWorkspaceFiles).mockReturnValue([{ file: "/ws/team.code-workspace", folders: 1, mtimeMs: 1 }]);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("x");
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ target: { kind: "existing-pick" } } as never)
      .mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never);

    await runExplore();

    expect(window.showQuickPick).toHaveBeenCalledTimes(2); // destination picks only, no repo pick
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        existingWorkspaceFile: "/ws/team.code-workspace",
        services: [expect.objectContaining({ name: "centaur", path: "/repos/centaur" })],
      }),
    );
  });

  it("aborts an Explore into an existing workspace that resolves to no repos", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "pick-existing", exploreMode: "knowledge" });
    vi.mocked(workspaceFolderPaths).mockReturnValue([]);
    vi.mocked(listWorkspaceFiles).mockReturnValue([{ file: "/ws/empty.code-workspace", folders: 0, mtimeMs: 1 }]);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("x");
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ file: "/ws/empty.code-workspace" } as never);

    const { provider, posted } = setup();
    await (provider as unknown as { explore: () => Promise<void> }).explore();

    expect(openWorkspace).not.toHaveBeenCalled();
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "error" }));
  });
});

describe("addressPr", () => {
  const promptOf = () => (vi.mocked(openWorkspace).mock.calls[0][0] as { promptTemplate: string }).promptTemplate;

  it("routes the addressPr message to the handler", async () => {
    const { send } = setup();
    await send({ type: "addressPr", key: "ASM-1", services: ["account-service"] });
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ ticket: expect.objectContaining({ key: "ASM-1" }) }),
    );
  });

  it("seeds the PR-review prompt (not a task prompt mode) and never prompts for a mode", async () => {
    const { provider } = setup();
    await provider.addressPr("ASM-1", ["account-service"]);
    expect(promptOf()).toContain("PR {key}"); // from cfg.prReviewPrompt
    expect(window.showQuickPick).not.toHaveBeenCalled(); // openIn=new-window, 1 repo, forced worktree → no picks
  });

  it("always creates a worktree even when worktree = never", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, worktree: "never" });
    const { provider } = setup();
    await provider.addressPr("ASM-1", ["account-service"]);
    expect(createWorktrees).toHaveBeenCalledWith(
      [expect.objectContaining({ name: "account-service" })],
      "ASM-1",
      "Do the thing",
      expect.anything(),
    );
    expect(openWorkspace).toHaveBeenCalled();
  });

  it("appends the auto-fix clause before {files} when prReviewAutoFix is on", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, prReviewAutoFix: true });
    const { provider } = setup();
    await provider.addressPr("ASM-1", ["account-service"]);
    const t = promptOf();
    expect(t).toContain(PR_REVIEW_AUTOFIX_CLAUSE);
    expect(t.indexOf(PR_REVIEW_AUTOFIX_CLAUSE)).toBeLessThan(t.indexOf("{files}"));
  });

  it("omits the auto-fix clause when prReviewAutoFix is off", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, prReviewAutoFix: false });
    const { provider } = setup();
    await provider.addressPr("ASM-1", ["account-service"]);
    expect(promptOf()).toBe(CFG.prReviewPrompt);
    expect(promptOf()).not.toContain(PR_REVIEW_AUTOFIX_CLAUSE);
  });

  it("appends the auto-fix clause at the end when the prompt has no {files}", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, prReviewPrompt: "Review PR for {key}" });
    const { provider } = setup();
    await provider.addressPr("ASM-1", ["account-service"]);
    expect(promptOf()).toBe(`Review PR for {key} ${PR_REVIEW_AUTOFIX_CLAUSE}`);
  });

  it("errors when no repos are checked out", async () => {
    vi.mocked(discoverRepos).mockReturnValue([]);
    const { provider, posted } = setup();
    await provider.addressPr("ASM-1", ["account-service"]);
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "error" }));
  });

  it("aborts before opening when the open-target picker is cancelled", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask" });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined as never);
    const { provider } = setup();
    await provider.addressPr("ASM-1", ["account-service"]);
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it("aborts when sign-in is declined", async () => {
    vi.mocked(commands.executeCommand).mockResolvedValue(false);
    const { provider } = setup({ authed: false });
    await provider.addressPr("ASM-1", ["account-service"]);
    expect(openWorkspace).not.toHaveBeenCalled();
  });
});

describe("remote control", () => {
  const lastOpen = () =>
    vi.mocked(openWorkspace).mock.calls[vi.mocked(openWorkspace).mock.calls.length - 1][0];

  it("passes false and never prompts when the setting is off", async () => {
    const { provider } = setup();
    await provider.takeTask("ASM-1", "card", ["account-service"]);
    expect(lastOpen().remoteControl).toBe(false);
    expect(window.showQuickPick).not.toHaveBeenCalled();
  });

  it("passes true without prompting when the setting is on", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, remoteControl: "on" });
    const { provider } = setup();
    await provider.takeTask("ASM-1", "card", ["account-service"]);
    expect(lastOpen().remoteControl).toBe(true);
    expect(window.showQuickPick).not.toHaveBeenCalled();
  });

  it("ask: choosing Enable passes true", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, remoteControl: "ask" });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ yes: true } as never);
    const { provider } = setup();
    await provider.takeTask("ASM-1", "card", ["account-service"]);
    expect(lastOpen().remoteControl).toBe(true);
  });

  it("ask: dismissing passes false and the launch still proceeds", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, remoteControl: "ask" });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined); // dismissed
    const { provider } = setup();
    await provider.takeTask("ASM-1", "card", ["account-service"]);
    expect(openWorkspace).toHaveBeenCalledTimes(1);
    expect(lastOpen().remoteControl).toBe(false);
  });

  it("asks once per launch, not once per repo", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, remoteControl: "ask" });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ yes: true } as never);
    const { provider } = setup();
    await provider.takeTask("ASM-1", "card", ["account-service", "centaur"]);
    expect(window.showQuickPick).toHaveBeenCalledTimes(1);
  });

  it("ask: never shows the picker when seedAgent is off — no plan file could ever carry the answer", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, remoteControl: "ask", seedAgent: false });
    const { provider } = setup();
    await provider.takeTask("ASM-1", "card", ["account-service"]);
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(lastOpen().remoteControl).toBe(false);
  });

  it("says so when a multi-window launch withheld it", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, remoteControl: "on" });
    vi.mocked(openWorkspace).mockResolvedValue({
      mode: "per-window",
      workspaceFile: undefined,
      briefs: [],
      opened: ["/a", "/b"],
      remoteControl: false, // withheld by the single-window guard
    });
    const { provider, posted } = setup();
    await provider.takeTask("ASM-1", "card", ["account-service", "centaur"]);
    const toast = posted().find((m) => m.type === "toast") as { message: string };
    expect(toast.message).toContain("Remote Control skipped");
  });

  it("explore resolves it once", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, remoteControl: "on", exploreMode: "knowledge" });
    vi.mocked(window.showInputBox).mockResolvedValueOnce("the retry path" as never);
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { send } = setup();
    await send({ type: "explore" });
    expect(lastOpen().remoteControl).toBe(true);
  });

  it("takeBatch never offers it for a real batch (2+ keys), even with the setting on", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, remoteControl: "on" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(createWorktrees).mockImplementation((s, key) =>
      s.map((r) => ({ ...r, path: `${r.path}/.claude/worktrees/${key}` })),
    );
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ shared: false } as never); // layout pick
    const { provider, posted } = setup();
    await provider.takeBatch(["ASM-1", "ASM-2"], ["api"]);
    expect(window.showQuickPick).toHaveBeenCalledTimes(1); // layout pick only — never a remote-control pick
    expect(vi.mocked(openWorkspace).mock.calls.every((c) => !c[0].remoteControl)).toBe(true);
    const toast = posted().find((m) => m.type === "toast") as { message: string };
    expect(toast.message).toContain("Remote Control skipped — one clipboard can't serve several sessions");
    vi.mocked(createWorktrees).mockImplementation((s) => s);
  });

  it("takeBatch offers it for a one-key batch — one window, one clipboard, same as an ordinary launch", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, remoteControl: "on" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(createWorktrees).mockImplementation((s, key) =>
      s.map((r) => ({ ...r, path: `${r.path}/.claude/worktrees/${key}` })),
    );
    vi.mocked(openWorkspace).mockResolvedValue({
      mode: "per-window",
      workspaceFile: undefined,
      briefs: [],
      opened: ["/x"],
      remoteControl: true,
    });
    const { provider, posted } = setup();
    await provider.takeBatch(["ASM-1"], ["api"]);
    expect(window.showQuickPick).not.toHaveBeenCalled(); // "on" resolves without a picker
    expect(lastOpen().remoteControl).toBe(true);
    const toast = posted().find((m) => m.type === "toast") as { message: string };
    expect(toast.message).not.toContain("Remote Control skipped");
    vi.mocked(createWorktrees).mockImplementation((s) => s);
  });
});
