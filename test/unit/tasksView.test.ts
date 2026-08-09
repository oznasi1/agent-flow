import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { commands, env, window } from "../_mocks/vscode";
import { fakeAuth, fakeContext, mkRepos } from "../_helpers/factories";

// ── sibling modules the controller depends on ──────────────────────────────
// Keep the real config constants (DEFAULT_PR_REVIEW_PROMPT, …) faithful — only
// getConfig is stubbed so tests control the resolved settings.
vi.mock("../../src/config", async () => {
  const actual = await vi.importActual<typeof import("../../src/config")>("../../src/config");
  return { ...actual, getConfig: vi.fn() };
});
vi.mock("../../src/engine/repos", () => ({ discoverRepos: vi.fn() }));
vi.mock("../../src/engine/workspace", () => ({
  openWorkspace: vi.fn(),
  listWorkspaceFiles: vi.fn(() => []),
  workspaceFolderPaths: vi.fn(() => []),
  planWorkspaceMerge: vi.fn(() => ({ add: [], duplicates: [], redundant: [], present: [], ok: true })),
}));
// repoRootOfWorktree is a pure path function (no fs/git side effects) — keep the real one
// so the derivation tests exercise the genuine convention, and stub only createWorktrees,
// the entry point that shells out to git. Same reasoning as the batchWorkspace mock below.
vi.mock("../../src/engine/worktree", async () => {
  const actual = await vi.importActual<typeof import("../../src/engine/worktree")>(
    "../../src/engine/worktree",
  );
  return { ...actual, createWorktrees: vi.fn((s: unknown) => s) };
});
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
  currentWindow: vi.fn(() => undefined),
}));
vi.mock("../../src/engine/runs", async () => {
  const actual = await vi.importActual<typeof import("../../src/engine/runs")>("../../src/engine/runs");
  return { ...actual, readRuns: vi.fn(() => []), defaultRunsDir: vi.fn(() => "/runs") };
});
vi.mock("../../src/engine/sessions", async () => {
  const actual = await vi.importActual<typeof import("../../src/engine/sessions")>("../../src/engine/sessions");
  return { ...actual, readOpenSessions: vi.fn(() => []), defaultSessionsDir: vi.fn(() => "/sessions") };
});
// This file mocks the client wholesale, so `JiraApiError` would be undefined inside
// the Jira provider and every `instanceof` check would throw. Re-export the genuine
// class so the real parseJiraError produces instances the production code recognises.
vi.mock("../../src/tasks/jira/client", async () => {
  const errors = await vi.importActual<typeof import("../../src/tasks/jira/errors")>("../../src/tasks/jira/errors");
  const seam = await vi.importActual<typeof import("../../src/tasks/provider")>("../../src/tasks/provider");
  // Mirrors the real class exactly (src/tasks/jira/client.ts): it extends the seam's
  // TaskAuthError, which is what the view now branches on to re-gate the panel — a
  // bare `extends Error` here would make every re-gate test pass a value production
  // code cannot recognise. `.name` is set for the same reason it is set there:
  // classifyFailure (telemetry/events.ts) checks `e.name === "JiraAuthError"`, and
  // the inherited name would be the base's "TaskAuthError".
  class JiraAuthError extends seam.TaskAuthError {
    constructor(message: string) {
      super(message);
      this.name = "JiraAuthError";
    }
  }
  return {
    JiraAuthError,
    JiraApiError: errors.JiraApiError,
    JiraClient: vi.fn(),
  };
});

import { parseJiraError } from "../../src/tasks/jira/errors";
import { getConfig } from "../../src/config";
import { discoverRepos } from "../../src/engine/repos";
import { openWorkspace, listWorkspaceFiles, workspaceFolderPaths, planWorkspaceMerge } from "../../src/engine/workspace";
import { createWorktrees } from "../../src/engine/worktree";
import { openSharedWorkspace } from "../../src/engine/batchWorkspace";
import { readLiveWindows, windowIdentity, currentWindow } from "../../src/engine/presence";
import { readRuns } from "../../src/engine/runs";
import { readOpenSessions } from "../../src/engine/sessions";
import { JiraClient, JiraAuthError } from "../../src/tasks/jira/client";
import { JiraProvider } from "../../src/tasks/jira/provider";
import {
  markTaskNetworkFailure, SerializedCaps, TaskConnector, TaskProvider, TaskWriteError,
} from "../../src/tasks/provider";
import type { JiraAuth } from "../../src/tasks/jira/auth";
import { makeFixtureConnector } from "../_helpers/fixtureConnector";
import { TasksViewProvider } from "../../src/tasksView";
import type { TakeSource } from "../../src/telemetry/events";
import type { InboundMessage, OutboundMessage } from "../../src/types";
import { SLACK_DM_SENTENCE, PR_REVIEW_AUTOFIX_CLAUSE } from "../../src/engine/prompt";

const CFG = {
  taskSource: "jira",
  baseUrl: "https://jira",
  project: "ASM",
  reposRoot: "/repos",
  workspaceDir: "/ws",
  githubOrg: "org",
  repoBlocklist: [] as string[],
  defaultFilter: "unassigned",
  seedAgent: true,
  agentProvider: "claude-code" as const,
  agentSurface: "extension" as const,
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
    { id: "supervise", label: "Supervise running tasks", prompt: "SUP {summary}{files}", slackDm: false, needsEnv: false },
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
  openAgents: true,
  deckGrouping: "agents" as const,
  retireFinishedAfterHours: 24,
  retireAbandonedAfterDays: 7,
  reviewRequests: true,
  reviewRequestsTtlSeconds: 300,
  reviewWrites: false,
  reviewRequestModes: [{ id: "full", label: "Full review", prompt: "Review {url}{files}" }],
  reviewRequestMode: "ask",
  stampLabelOnWrite: true,
  provenanceLabel: "claude-code",
  filters: { size: true, status: true, repo: true, search: true },
  marketplaces: [] as string[],
};

let clientStub: Record<string, ReturnType<typeof vi.fn>>;

function makeClient() {
  return {
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
  vi.mocked(currentWindow).mockReturnValue(undefined);
  vi.mocked(openSharedWorkspace).mockResolvedValue({
    workspaceFile: "/ws/ASM-1+1.code-workspace",
    opened: true,
    briefs: [],
    seeded: 2,
  });
});

/** What `serializeCaps` makes of the Jira provider's capabilities. Every `state` post
 * carries them now, so they appear in each exact-match state assertion below. Spelled
 * out rather than derived from JiraProvider, so a capability quietly disappearing from
 * the shipped Jira path fails here rather than being echoed back as "correct". */
const JIRA_CAPS: SerializedCaps = {
  supportedFilters: ["unassigned", "mine", "mysprint", "sprint", "backlog", "all"],
  sizes: true,
  labels: true,
  sprints: true,
  components: true,
};

/** A TaskConnector over the mocked JiraClient. `provider()` returns the REAL
 * JiraProvider adapting `clientStub`, and that is the whole point: every assertion in
 * this file about what Jira is asked for — transition bodies, sprint ids, component
 * spellings — stays an assertion about the shipped Jira path rather than about a
 * hand-written double that could drift from it.
 *
 * `info()` / `isConfigured()` / `taskUrl()` mirror src/tasks/jira/connector.ts,
 * reading the same stubbed getConfig(), so the panel's user-facing strings are
 * asserted against the values a real install would produce. */
function jiraConnector(auth: JiraAuth): TaskConnector {
  return {
    id: "jira",
    setupSteps: 2,
    info: () => {
      const cfg = getConfig();
      return {
        label: "Jira",
        scopeNoun: "project",
        scopeValue: cfg.project,
        endpoint: cfg.baseUrl,
        exampleKey: `${cfg.project || "ABC"}-1234`,
        endpointSetting: "agentFlow.jira.baseUrl",
        scopeSetting: "agentFlow.jira.project",
      };
    },
    isConfigured: () => {
      const cfg = getConfig();
      return !!cfg.baseUrl.trim() && !!cfg.project.trim();
    },
    configure: async () => async () => undefined,
    // Delegated, not copied: tests reach for `auth.isAuthenticated` to make the
    // credential read itself reject, and that must still reach the view.
    isAuthenticated: () => auth.isAuthenticated(),
    signIn: () => auth.signIn(),
    signOut: () => auth.signOut(),
    provider: () => new JiraProvider(clientStub as unknown as JiraClient),
    probe: async () => ({}),
    taskUrl: (key) => `${getConfig().baseUrl}/browse/${key}`,
    keyFromUrl: () => null,
  };
}

/** Instantiate the provider and capture its webview message handler + post spy. */
function setup(opts: { authed?: boolean; workspaceState?: Record<string, unknown>; connector?: TaskConnector } = {}) {
  const { context, workspaceState, globalState } = fakeContext({ workspaceState: opts.workspaceState });
  const auth = fakeAuth({ authed: opts.authed ?? true });
  const connector = opts.connector ?? jiraConnector(auth);
  // The output channel is captured, not discarded: two of this panel's diagnostics
  // are the ONLY record of a deliberate decision it made (declining to prompt for an
  // unfillable required field, and the transport status behind a refused write), so
  // they are asserted rather than trusted.
  const logged: string[] = [];
  const provider = new TasksViewProvider(context, connector, (m) => logged.push(m));
  // A live array as well as the spy: the capability tests below read messages after
  // driving an action, which a snapshot taken at mount time could not show.
  const messages: OutboundMessage[] = [];
  const post = vi.fn((m: OutboundMessage) => {
    messages.push(m);
  });
  let handler: (m: InboundMessage) => Promise<void> = async () => {};
  // `title` / `description` are the VS Code view title bar's text — the panel sets
  // them from the same state it posts, so they are asserted like any other output.
  const view = {
    title: "Tasks",
    description: undefined as string | undefined,
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
  return { provider, post, send, posted, messages, logged, auth, connector, workspaceState, globalState, view };
}

/** Mount the panel on a given connector and let it establish its state, the way the
 * webview's `ready` does. `posted` is the live message array, so a test reads it after
 * driving an action. */
async function mountWith(connector: TaskConnector) {
  const s = setup({ connector });
  await s.send({ type: "ready" });
  return { view: s.provider, posted: s.messages, send: s.send, logged: s.logged };
}

/** The fixture connector with individual provider members swapped. Used where the
 * interesting behaviour is what the view does with what a connector throws, not which
 * source threw it — the fixture declares no labels, sprints or components, so these
 * also prove the generic path never depends on an optional capability. */
function withProvider(overrides: Partial<TaskProvider>): TaskConnector {
  const base = makeFixtureConnector();
  return { ...base, provider: () => Object.assign(base.provider(), overrides) };
}

/** Answer the next `showInputBox` calls in order, then undefined (cancelled). */
function stubInputBox(...answers: (string | undefined)[]) {
  const box = vi.mocked(window.showInputBox);
  box.mockReset();
  for (const a of answers) box.mockResolvedValueOnce(a as never);
  box.mockResolvedValue(undefined as never);
}

/** Answer a QuickPick with the first item the view actually offered — never a
 * hand-written stand-in. For the status picker that matters: the item's `t` has to be
 * the StatusTarget the provider produced, so a view that stopped passing one through
 * fails here instead of quietly picking a fabricated object out of the test. */
const pickFirst = (items: unknown[]) => items[0];

/** Answer the QuickPicks of one flow in order: for `changeStatus` the status picker
 * first, then one answer per field prompt. A function answer receives the items the
 * view offered and returns one of them (see `pickFirst`); any other value is returned
 * as-is. Anything past the listed answers reads as cancelled. */
const answerPicks = (...answers: unknown[]) => {
  const pick = vi.mocked(window.showQuickPick);
  pick.mockReset();
  for (const a of answers) {
    pick.mockImplementationOnce(async (items?: unknown) =>
      typeof a === "function" ? (a as (i: unknown[]) => unknown)((await items) as unknown[]) : a,
    );
  }
  pick.mockResolvedValue(undefined as never);
};

describe("ready", () => {
  it("reports authed state with the current user and auto-fetches", async () => {
    const { send, posted } = setup({ authed: true });
    await send({ type: "ready" });
    expect(posted()).toContainEqual({ type: "state", sourceLabel: "Jira", caps: JIRA_CAPS, authed: true, configured: true, project: "ASM", me: "Jane", prReviewStatus: "PR initiated", filters: { size: true, status: true, repo: true, search: true }, liveCount: 0 });
    expect(clientStub.fetchTasks).toHaveBeenCalled();
  });

  it("reports unauthed state and does not fetch", async () => {
    const { send, posted } = setup({ authed: false });
    await send({ type: "ready" });
    expect(posted()).toContainEqual({ type: "state", sourceLabel: "Jira", caps: JIRA_CAPS, authed: false, configured: true, project: "ASM", me: null, prReviewStatus: "PR initiated", filters: { size: true, status: true, repo: true, search: true }, liveCount: 0 });
    expect(clientStub.fetchTasks).not.toHaveBeenCalled();
  });

  it("reports not-configured (and does not fetch) when the site URL / project are unset", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, baseUrl: "", project: "" });
    const { send, posted } = setup({ authed: true });
    await send({ type: "ready" });
    expect(posted()).toContainEqual({ type: "state", sourceLabel: "Jira", caps: JIRA_CAPS, authed: true, configured: false, project: "", me: null, prReviewStatus: "PR initiated", filters: { size: true, status: true, repo: true, search: true }, liveCount: 0 });
    expect(clientStub.fetchTasks).not.toHaveBeenCalled();
  });

  it("still shows the signed-in name when the identity lookup returns no account id", async () => {
    // Jira Server/DC, or a proxy that strips accountId. The name chip in the header —
    // and, through `me`, every "is this task mine?" affordance in the card list,
    // including "Add to my sprint" on the user's own out-of-sprint tasks — is built
    // from this one string, and requiring an accountId for it took all of them away.
    clientStub.getMyself.mockResolvedValue({ accountId: "", displayName: "Jane" });
    const { send, posted } = setup({ authed: true });
    await send({ type: "ready" });
    expect(posted()).toContainEqual(expect.objectContaining({ type: "state", authed: true, me: "Jane" }));
  });

  it("posts state up-front and still loads tasks when the display-name lookup fails", async () => {
    clientStub.getMyself.mockRejectedValue(new Error("myself 500"));
    const { send, posted } = setup({ authed: true });
    await send({ type: "ready" });
    // A state is posted before (and regardless of) the /myself round-trip…
    expect(posted()).toContainEqual({ type: "state", sourceLabel: "Jira", caps: JIRA_CAPS, authed: true, configured: true, project: "ASM", me: null, prReviewStatus: "PR initiated", filters: { size: true, status: true, repo: true, search: true }, liveCount: 0 });
    // …and the task list — the real payload — still loads.
    expect(clientStub.fetchTasks).toHaveBeenCalled();
  });

  it("re-establishes state and fetches on retry", async () => {
    const { send, posted } = setup({ authed: true });
    await send({ type: "retry" });
    expect(posted()).toContainEqual({ type: "state", sourceLabel: "Jira", caps: JIRA_CAPS, authed: true, configured: true, project: "ASM", me: "Jane", prReviewStatus: "PR initiated", filters: { size: true, status: true, repo: true, search: true }, liveCount: 0 });
    expect(clientStub.fetchTasks).toHaveBeenCalled();
  });

  it("routes runSetup to the setup command", async () => {
    const { send } = setup();
    await send({ type: "runSetup" });
    expect(commands.executeCommand).toHaveBeenCalledWith("agentFlow.setup");
  });

  // The panel's own title bar is the identity row. The fixture connector's scope
  // value is "ASM" (CFG.project) and the Jira client stub's getMyself returns "Jane".
  it("titles the panel with the project and the signed-in user", async () => {
    const { send, view } = setup({ authed: true });
    await send({ type: "ready" });
    expect(view.title).toBe("ASM");
    expect(view.description).toBe("Jane");
  });

  it("drops the description when nobody is signed in", async () => {
    const { send, view } = setup({ authed: false });
    await send({ type: "ready" });
    expect(view.title).toBe("ASM");
    expect(view.description).toBeUndefined();
  });

  // A blank title bar holding three floating action icons reads as a rendering
  // failure, so an unset project keeps the package.json name rather than emptying it.
  it("falls back to the view's own name when no project is configured", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, baseUrl: "", project: "" });
    const { send, view } = setup({ authed: true });
    await send({ type: "ready" });
    expect(view.title).toBe("Tasks");
    expect(view.description).toBeUndefined();
  });
});

describe("state — liveCount", () => {
  it("reports the live window count from the same source as the open-target picker", async () => {
    vi.mocked(readLiveWindows).mockReturnValue([
      { pid: 1, identity: "/repos/account-service", kind: "folder", label: "account-service", folders: 1, updatedAt: 9 },
      { pid: 2, identity: "/repos/centaur", kind: "folder", label: "centaur", folders: 1, updatedAt: 8 },
    ]);
    const { send, posted } = setup({ authed: true });
    await send({ type: "ready" });
    expect(posted()).toContainEqual(expect.objectContaining({ type: "state", liveCount: 2 }));
  });

  it("excludes the current window from the count, same as the picker", async () => {
    vi.mocked(windowIdentity).mockReturnValue({ identity: "/repos/account-service", kind: "folder", label: "account-service", folders: 1 });
    vi.mocked(readLiveWindows).mockReturnValue([
      { pid: 1, identity: "/repos/account-service", kind: "folder", label: "account-service", folders: 1, updatedAt: 9 },
      { pid: 2, identity: "/repos/centaur", kind: "folder", label: "centaur", folders: 1, updatedAt: 8 },
    ]);
    const { send, posted } = setup({ authed: true });
    await send({ type: "ready" });
    expect(posted()).toContainEqual(expect.objectContaining({ type: "state", liveCount: 1 }));
  });

  it("omits liveCount from state when window tracking is off, rather than reporting zero", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, trackOpenWindows: false });
    vi.mocked(readLiveWindows).mockReturnValue([
      { pid: 1, identity: "/repos/centaur", kind: "folder", label: "centaur", folders: 1, updatedAt: 8 },
    ]);
    const { send, posted } = setup({ authed: true });
    await send({ type: "ready" });
    expect(posted()).toContainEqual({ type: "state", sourceLabel: "Jira", caps: JIRA_CAPS, authed: true, configured: true, project: "ASM", me: "Jane",
      prReviewStatus: "PR initiated", filters: { size: true, status: true, repo: true, search: true } });
    const stateMsg = posted().find((m) => m.type === "state") as { liveCount?: number };
    expect(stateMsg.liveCount).toBeUndefined();
  });
});

describe("fetch", () => {
  it("does not fetch when unauthenticated", async () => {
    const { send, posted } = setup({ authed: false });
    await send({ type: "fetch", filter: "mine", size: "any" });
    expect(clientStub.fetchTasks).not.toHaveBeenCalled();
    expect(posted()).toContainEqual({ type: "state", sourceLabel: "Jira", caps: JIRA_CAPS, authed: false, configured: true, project: "ASM", me: null, prReviewStatus: "PR initiated", filters: { size: true, status: true, repo: true, search: true }, liveCount: 0 });
  });

  it("toggles loading and posts tasks with a services guess", async () => {
    clientStub.fetchTasks.mockResolvedValue([
      { key: "ASM-1", summary: "s", labels: [], components: [] },
    ]);
    const { send, posted } = setup();
    await send({ type: "fetch", filter: "mine", size: "any" });
    expect(clientStub.fetchTasks).toHaveBeenCalledWith("mine", "any", 50);
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

  it("carries liveCount on tasks too, from the same source as state's, so the gauge is not a mount-time snapshot", async () => {
    vi.mocked(readLiveWindows).mockReturnValue([
      { pid: 1, identity: "/repos/account-service", kind: "folder", label: "account-service", folders: 1, updatedAt: 9 },
    ]);
    const { send, posted } = setup();
    await send({ type: "fetch", filter: "mine", size: "any" });
    const tasksMsg = posted().find((m) => m.type === "tasks");
    expect(tasksMsg).toEqual(expect.objectContaining({ liveCount: 1 }));
  });

  it("omits liveCount from tasks when window tracking is off, same as state's", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, trackOpenWindows: false });
    const { send, posted } = setup();
    await send({ type: "fetch", filter: "mine", size: "any" });
    const tasksMsg = posted().find((m) => m.type === "tasks") as { liveCount?: number };
    expect(tasksMsg.liveCount).toBeUndefined();
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
    expect(clientStub.fetchTasks).toHaveBeenCalledWith("mysprint", "any", 50);
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
    answerPicks(pickFirst);
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
    answerPicks(pickFirst);
    const { provider } = setup();
    await provider.changeStatus("ASM-1");
    expect(clientStub.addLabel).not.toHaveBeenCalled();
  });

  it("still succeeds when the label stamp fails", async () => {
    clientStub.getTransitions.mockResolvedValue([
      { id: "31", name: "Start", toName: "In Progress", toCategory: "indeterminate" },
    ]);
    clientStub.addLabel.mockRejectedValue(new Error("label denied"));
    answerPicks(pickFirst);
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

  it("prompts for a required resolution and sends it with the transition", async () => {
    clientStub.getTransitions.mockResolvedValue([DONE_WITH_RESOLUTION]);
    answerPicks(pickFirst, { label: "Won't Do" });
    const { provider } = setup();
    await provider.changeStatus("ASM-1");
    expect(clientStub.transition).toHaveBeenCalledWith("ASM-1", "41", { resolution: { id: "10001" } });
  });

  it("writes nothing when the field prompt is cancelled", async () => {
    clientStub.getTransitions.mockResolvedValue([DONE_WITH_RESOLUTION]);
    answerPicks(pickFirst, undefined);
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
    answerPicks(pickFirst);
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
    answerPicks(pickFirst);
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
    answerPicks(pickFirst);
    const { provider } = setup();
    await provider.changeStatus("ASM-1");
    expect(window.showInputBox).not.toHaveBeenCalled();
    expect(clientStub.transition).toHaveBeenCalledWith("ASM-1", "71", {});
  });

  // `src/tasks/jira/client` is mocked in this file, but `src/tasks/jira/errors` is not — the
  // real parser gives the recovery path a faithful JiraApiError to react to.
  const apiError = (messages: string[], fieldErrors: Record<string, string> = {}) =>
    parseJiraError(400, JSON.stringify({ errorMessages: messages, errors: fieldErrors }));

  it("re-prompts from a workflow validator that names a screen field, then retries once", async () => {
    clientStub.getTransitions.mockResolvedValue([DONE_WITH_RESOLUTION]);
    clientStub.transition
      .mockRejectedValueOnce(apiError(["Ticket cannot be closed unless Resolution will be provided"]))
      .mockResolvedValueOnce(undefined);
    // The upfront pass already asks for Resolution, so answer it twice.
    answerPicks(pickFirst, { label: "Done" }, { label: "Won't Do" });
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
    answerPicks(pickFirst, { label: "Config drift" });
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
    answerPicks(pickFirst, { label: "Done" });
    const { provider } = setup();
    await provider.changeStatus("ASM-1");
    expect(clientStub.listResolutions).toHaveBeenCalled();
    expect(clientStub.transition).toHaveBeenLastCalledWith("ASM-1", "41", { resolution: { id: "10000" } });
  });

  it("reports a readable toast with an Open in Jira action when nothing can be re-prompted", async () => {
    const t = { id: "41", name: "Resolve", toName: "Done", toCategory: "done", fields: {} };
    clientStub.getTransitions.mockResolvedValue([t]);
    clientStub.transition.mockRejectedValue(apiError(["Transition is not valid"]));
    answerPicks(pickFirst);
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
    answerPicks(pickFirst);
    const { provider, posted } = setup();
    await provider.changeStatus("ASM-1");
    expect(posted()).toContainEqual(
      expect.objectContaining({ message: "Couldn't update ASM-1. Root Cause: Field is required." }),
    );
  });

  it("does not retry a second time", async () => {
    clientStub.getTransitions.mockResolvedValue([DONE_WITH_RESOLUTION]);
    clientStub.transition.mockRejectedValue(apiError(["Ticket cannot be closed unless Resolution will be provided"]));
    answerPicks(pickFirst, { label: "Done" }, { label: "Done" });
    const { provider, posted } = setup();
    await provider.changeStatus("ASM-1");
    expect(clientStub.transition).toHaveBeenCalledTimes(2);
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "error" }));
  });

  // Two log lines, no user-facing surface. Both were lost when this view stopped
  // knowing about Jira transitions, and both are the only trace of something the user
  // cannot otherwise find out — so they are pinned like behaviour.
  it("records the required fields it deliberately did not prompt for", async () => {
    // A rich-text required field: promptableFields cannot build a prompt for ADF, so
    // the write is attempted without it and Jira decides. Nobody is asked, and without
    // this line nobody can tell that was a choice.
    const t = {
      id: "81", name: "Close", toName: "Closed", toCategory: "done",
      fields: {
        description: { required: true, name: "Description", schema: { type: "string", system: "description" } },
        environment: { required: true, name: "Environment", schema: { type: "string", system: "environment" } },
      },
    };
    clientStub.getTransitions.mockResolvedValue([t]);
    answerPicks(pickFirst);
    const { provider, logged } = setup();
    await provider.changeStatus("ASM-1");
    expect(logged).toContain("changeStatus ASM-1: can't fill Description, Environment here — letting Jira decide");
    // Still attempted, exactly as before: refusing to try would be the worse failure.
    expect(clientStub.transition).toHaveBeenCalledWith("ASM-1", "81", {});
  });

  it("says nothing about unfillable fields when every field could be prompted", async () => {
    clientStub.getTransitions.mockResolvedValue([DONE_WITH_RESOLUTION]);
    answerPicks(pickFirst, { label: "Done" });
    const { provider, logged } = setup();
    await provider.changeStatus("ASM-1");
    expect(logged.some((l) => l.includes("can't fill"))).toBe(false);
  });

  it("records the transport status behind a refused write, and keeps it out of the toast", async () => {
    const t = { id: "41", name: "Resolve", toName: "Done", toCategory: "done", fields: {} };
    clientStub.getTransitions.mockResolvedValue([t]);
    clientStub.transition.mockRejectedValue(apiError(["You do not have permission"]));
    answerPicks(pickFirst);
    const { provider, posted, logged } = setup();
    await provider.changeStatus("ASM-1");
    // 403-vs-400 is "you may not" vs "that was malformed"; the prose says neither.
    expect(logged).toContain("changeStatus ASM-1: 400 — Couldn't update ASM-1. You do not have permission.");
    const toast = posted().find((m) => m.type === "toast" && m.level === "error") as { message: string };
    expect(toast.message).toBe("Couldn't update ASM-1. You do not have permission.");
    expect(toast.message).not.toContain("400");
  });

  it("stays silent when the recovery prompt is cancelled", async () => {
    clientStub.getTransitions.mockResolvedValue([DONE_WITH_RESOLUTION]);
    clientStub.transition.mockRejectedValue(apiError(["Ticket cannot be closed unless Resolution will be provided"]));
    answerPicks(pickFirst, { label: "Done" }, undefined);
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
      sourceComponents: ["account-service"],
      // "centaur" is a discovered repo but not a component of ASM → absent
      mappable: { "account-service": "account-service" },
    });
  });

  it("reads the issue before the component list, so a dead token still re-gates the panel", async () => {
    clientStub.getDetail.mockRejectedValue(new JiraAuthError("nope"));
    const { send, posted } = setup();
    await send({ type: "detail", key: "ASM-1" });
    expect(clientStub.listComponents).not.toHaveBeenCalled();
    expect(posted()).toContainEqual(expect.objectContaining({ type: "state", sourceLabel: "Jira", caps: JIRA_CAPS, authed: false }));
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
    expect(posted()).toContainEqual(expect.objectContaining({ type: "state", sourceLabel: "Jira", caps: JIRA_CAPS, authed: false }));
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
    expect(posted()).toContainEqual(expect.objectContaining({ type: "state", sourceLabel: "Jira", caps: JIRA_CAPS, authed: false }));
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

  it("errors before the sprint-add when the identity has no usable id", async () => {
    // `me()` can now answer with a display name and no id (see JiraProvider.me). That
    // is enough to render, not enough to assign with — so this pair has to stop at the
    // toast rather than add to the sprint and then fail the assignment.
    clientStub.getMyself.mockResolvedValue({ accountId: "", displayName: "Jane" });
    const { provider, posted } = setup();
    await provider.addToMySprint("ASM-1");
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "error" }));
    expect(clientStub.addIssueToSprint).not.toHaveBeenCalled();
    expect(clientStub.assignIssue).not.toHaveBeenCalled();
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
    // ONE identity lookup for the pair, not one per write. Two would not merely cost a
    // request: a second lookup answering null after the sprint-add succeeded would
    // throw, leaving the task in the sprint and unassigned — a state one lookup makes
    // unreachable.
    expect(clientStub.getMyself).toHaveBeenCalledTimes(1);
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

  it("offers all six configured actions, in order, from the exploreMode 'ask' picker", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "ask" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("focus");
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ action: CFG.exploreActions[0] } as never) // action picker → Jira ticket
      .mockResolvedValueOnce([{ repo: repos[0] }] as never); // repo picker
    const { send } = setup();
    await send({ type: "explore" });
    const items = vi.mocked(window.showQuickPick).mock.calls[0][0] as { label: string }[];
    expect(items).toHaveLength(6);
    expect(items.map((i) => i.label)).toEqual(CFG.exploreActions.map((a) => a.label));
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

  it("asks for an environment and fills {env} and {services} for the verify action", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "verify" });
    const repos = mkRepos(["account-service", "centaur"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("retry banner");
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ label: "staging", env: "staging" } as never) // env picker
      .mockResolvedValueOnce([{ repo: repos[0] }, { repo: repos[1] }] as never); // repo picker
    const { send } = setup();
    await send({ type: "explore" });
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        promptTemplate: "VER {summary} on staging for account-service, centaur{files}",
        ticket: expect.objectContaining({ key: "verify-staging-retry-banner", summary: "retry banner on staging" }),
      }),
    );
  });

  it("offers the configured environments plus a Custom… entry", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "verify", environments: ["dev", "prod"] });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("focus");
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ label: "dev", env: "dev" } as never)
      .mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { send } = setup();
    await send({ type: "explore" });
    const items = vi.mocked(window.showQuickPick).mock.calls[0][0] as { label: string }[];
    expect(items.map((i) => i.label)).toEqual(["dev", "prod", "$(edit) Custom…"]);
  });

  it("takes a one-off environment through the Custom… input box", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "verify" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox)
      .mockResolvedValueOnce("retry banner") // focus
      .mockResolvedValueOnce("  staging-eu  "); // custom env, untrimmed
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ label: "$(edit) Custom…" } as never) // no `env` → custom
      .mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { send } = setup();
    await send({ type: "explore" });
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ promptTemplate: "VER {summary} on staging-eu for account-service{files}" }),
    );
  });

  it("aborts before the destination step when the environment picker is cancelled", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "verify" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["account-service"]));
    vi.mocked(window.showInputBox).mockResolvedValueOnce("retry banner");
    vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined as never); // cancel env pick
    const { send } = setup();
    await send({ type: "explore" });
    expect(window.showQuickPick).toHaveBeenCalledTimes(1);
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it("aborts when the Custom… environment input is cancelled", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "verify" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["account-service"]));
    vi.mocked(window.showInputBox)
      .mockResolvedValueOnce("retry banner")
      .mockResolvedValueOnce(undefined); // cancel the custom env box
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ label: "$(edit) Custom…" } as never);
    const { send } = setup();
    await send({ type: "explore" });
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it("requires a focus for verify and leaves it optional for the other actions", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "verify" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("retry banner");
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ label: "dev", env: "dev" } as never)
      .mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { send } = setup();
    await send({ type: "explore" });
    const opts = vi.mocked(window.showInputBox).mock.calls[0][0] as {
      title: string;
      validateInput?: (v: string) => string | undefined;
    };
    expect(opts.title).toBe("Verify — which feature or change?");
    expect(opts.validateInput?.("   ")).toBe("Name the feature or change to verify");
    expect(opts.validateInput?.("retry banner")).toBeUndefined();
  });

  it("leaves the other actions' focus box optional and unvalidated", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "knowledge" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("");
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { send } = setup();
    await send({ type: "explore" });
    const opts = vi.mocked(window.showInputBox).mock.calls[0][0] as {
      title: string;
      validateInput?: (v: string) => string | undefined;
    };
    expect(opts.title).toBe("Explore — what do you want to dig into?");
    expect(opts.validateInput).toBeUndefined();
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ ticket: expect.objectContaining({ key: "explore-codebase-exploration" }) }),
    );
  });

  it("applies the Slack sentence before substituting the environment", async () => {
    const actions = CFG.exploreActions.map((a) => (a.id === "verify" ? { ...a, slackDm: true } : a));
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "verify", exploreActions: actions });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("retry banner");
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ label: "prod", env: "prod" } as never)
      .mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { send } = setup();
    await send({ type: "explore" });
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        promptTemplate: `VER {summary} on prod for account-service ${SLACK_DM_SENTENCE}{files}`,
      }),
    );
  });

  it("anchors the Slack sentence on the real {files} placeholder even when a custom environment contains that literal text", async () => {
    // Regression pin for the assembly order: injectSlackDm MUST run before applyExploreVars.
    // With env="prod{files}" this genuinely discriminates the two orders —
    //   correct  (inject then substitute): "VER {summary} on prod{files} for account-service <SENTENCE>{files}"
    //   reversed (substitute then inject): "VER {summary} on prod <SENTENCE>{files} for account-service{files}"
    // — because a reversed order lets injectSlackDm's indexOf("{files}") anchor on the
    // substring smuggled in by the typed environment instead of the template's real placeholder.
    const actions = CFG.exploreActions.map((a) => (a.id === "verify" ? { ...a, slackDm: true } : a));
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "verify", exploreActions: actions });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox)
      .mockResolvedValueOnce("retry banner") // focus
      .mockResolvedValueOnce("prod{files}"); // custom env smuggling the literal placeholder text
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ label: "$(edit) Custom…" } as never) // no `env` → custom
      .mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { send } = setup();
    await send({ type: "explore" });
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        promptTemplate: `VER {summary} on prod{files} for account-service ${SLACK_DM_SENTENCE}{files}`,
      }),
    );
  });

  it("treats a configured environment that shares the Custom… label as a real environment, not the escape hatch", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "verify", environments: ["$(edit) Custom…"] });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("retry banner"); // focus only — no custom-env box expected
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ label: "$(edit) Custom…", env: "$(edit) Custom…" } as never) // carries `env` → real pick
      .mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { send } = setup();
    await send({ type: "explore" });
    expect(window.showInputBox).toHaveBeenCalledTimes(1);
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        promptTemplate: "VER {summary} on $(edit) Custom… for account-service{files}",
      }),
    );
  });

  it("does not ask for an environment for an action that does not need one", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "debug" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("focus");
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { send } = setup();
    await send({ type: "explore" });
    expect(window.showQuickPick).toHaveBeenCalledTimes(1); // the repo picker only
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        promptTemplate: "DBG {summary}{files}",
        ticket: expect.objectContaining({ key: "explore-focus", summary: "focus" }),
      }),
    );
  });

  it("uses supervise-specific topic-box copy and a supervise-specific fallback when left blank", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "supervise" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("");
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { send } = setup();
    await send({ type: "explore" });
    const opts = vi.mocked(window.showInputBox).mock.calls[0][0] as { title: string };
    expect(opts.title).toBe("Supervise — anything specific to prioritize?");
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        ticket: expect.objectContaining({ key: "explore-check-on-active-tasks", summary: "Check on active tasks" }),
      }),
    );
  });

  it("folds the other active tasks into planMd for the supervise action", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "supervise" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(readRuns).mockReturnValue([
      {
        key: "ASM-9",
        summary: "Fix retry bug",
        url: "https://jira/ASM-9",
        createdAt: 1,
        mode: "per-window",
        repos: [{ name: "svc", path: "/repos/svc", isGit: true, branch: "fix/retry" }],
        briefPaths: [],
        kind: "task",
      },
    ]);
    vi.mocked(readOpenSessions).mockReturnValue([]);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("focus");
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { send } = setup();
    await send({ type: "explore" });
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        planMd: expect.stringContaining(
          "- **ASM-9** (task) — Fix retry bug — `/repos/svc` (branch: fix/retry) — idle, no agent attached",
        ),
      }),
    );
  });

  it("regression: leaves the generic-Explore planMd unchanged for a non-supervise action", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "knowledge" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("retry logic");
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { send } = setup();
    await send({ type: "explore" });
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        planMd: "## Exploration: retry logic\n\n_No Jira ticket yet — a knowledge/exploration session. If it turns into work, open a ticket afterwards._",
      }),
    );
  });

  it("regression: leaves the Verify planMd unchanged", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "verify" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("retry banner");
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ label: "staging", env: "staging" } as never)
      .mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { send } = setup();
    await send({ type: "explore" });
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        planMd: "## Verify: retry banner on staging\n\n_Verification session — environment: staging. Services in scope: account-service._",
      }),
    );
  });

  it("stamps kind: 'explore' on every Explore-launched run, regardless of which action was chosen", async () => {
    // Every Explore action has no Jira ticket — kind distinguishes ticket-vs-no-ticket
    // runs, not which of the six actions launched it. Without this, every run opened
    // through Explore persists (and later renders) as kind "task".
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "supervise" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("focus");
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { send } = setup();
    await send({ type: "explore" });
    expect(openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ kind: "explore" }));
  });

  it("gives the supervise action its own completion-toast phrase", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "supervise" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("");
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { send, posted } = setup();
    await send({ type: "explore" });
    expect(posted()).toContainEqual(
      expect.objectContaining({ type: "toast", level: "success", message: expect.stringContaining("to check on your other tasks") }),
    );
  });

  it("leaves the other actions' completion toast reading 'to explore'", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "knowledge" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("focus");
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { send, posted } = setup();
    await send({ type: "explore" });
    expect(posted()).toContainEqual(
      expect.objectContaining({ type: "toast", level: "success", message: expect.stringContaining("to explore") }),
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
    expect(posted()).toContainEqual({ type: "state", sourceLabel: "Jira", caps: JIRA_CAPS, authed: false, configured: true, project: "ASM", me: null, prReviewStatus: "PR initiated", filters: { size: true, status: true, repo: true, search: true }, liveCount: 0 });
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

  it("lists the pre-checked repos first, keeping discovery order within each group", async () => {
    const repos = mkRepos(["aardvark-service", "billing-service", "centaur", "delta-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    clientStub.getDetail.mockResolvedValue({
      key: "ASM-1",
      summary: "Do the thing",
      descriptionText: "desc",
      labels: ["billing-service"],
      components: ["delta-service"],
      url: "https://jira/browse/ASM-1",
    });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[1] }] as never);
    const { provider } = setup();
    await provider.takeTask("ASM-1", "command");
    const items = vi.mocked(window.showQuickPick).mock.calls[0][0] as { label: string; picked: boolean }[];
    // Inference order would put delta-service (component) ahead of billing-service
    // (label); the partition keeps discovery order inside each group instead.
    expect(items.map((i) => i.label)).toEqual(["billing-service", "delta-service", "aardvark-service", "centaur"]);
    expect(items.map((i) => i.picked)).toEqual([true, true, false, false]);
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
      vi.mocked(currentWindow).mockReturnValue({
        identity: "/repos/account-service",
        kind: "folder",
        roots: [{ name: "account-service", path: "/repos/account-service" }],
      });

      const { provider } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]);

      expect(openWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ openIn: "current", existingWorkspaceFile: undefined }),
      );
    });

    const HERE = {
      identity: "/repos/account-service",
      kind: "folder" as const,
      roots: [{ name: "account-service", path: "/repos/account-service" }],
    };

    it("offers This window with copy that promises the folders are kept", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask" });
      vi.mocked(currentWindow).mockReturnValue(HERE);
      vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined as never); // cancel; we only inspect the items

      const { provider } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]);

      const items = vi.mocked(window.showQuickPick).mock.calls[0][0] as { label: string; detail: string }[];
      const item = items.find((i) => i.label.includes("This window"));
      expect(item?.detail).toBe("Start a session here — keeps this window's folders");
    });

    // An empty or untitled multi-root window can't be named by a plan match, so offering
    // it would produce a take that silently seeds nothing.
    it("omits This window when this window has no identity", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask" });
      vi.mocked(currentWindow).mockReturnValue(undefined);
      vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined as never);

      const { provider } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]);

      const items = vi.mocked(window.showQuickPick).mock.calls[0][0] as { label: string }[];
      expect(items.some((i) => i.label.includes("This window"))).toBe(false);
    });

    it("passes this window through to openWorkspace for target 'current'", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "this-window" });
      vi.mocked(currentWindow).mockReturnValue(HERE);

      const { provider } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]);

      expect(openWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ openIn: "current", currentWindow: HERE, mode: "per-window" }),
      );
    });

    it("takes the mode from a workspace window's shape, not the repo count", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "this-window" });
      vi.mocked(currentWindow).mockReturnValue({
        identity: "/ws/team.code-workspace",
        kind: "workspace",
        roots: [{ name: "api", path: "/repos/api" }],
      });

      const { provider } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]);

      expect(openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ mode: "multiroot" }));
    });

    it("falls back to a new window when the this-window setting has no window to use", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "this-window" });
      vi.mocked(currentWindow).mockReturnValue(undefined);

      const { provider, posted } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]);

      expect(openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ openIn: "new" }));
      expect(posted()).toContainEqual(
        expect.objectContaining({
          type: "toast",
          level: "info",
          // Not "no folder open" — an untitled multi-root window has several folders open
          // and still has no identity, so that wording would be plainly false for it.
          message: expect.stringContaining("no saved workspace file and no single folder"),
        }),
      );
    });

    // The picker's currentWindow() read and targetToOpenArgs' later currentWindow()
    // read aren't atomic — the window can lose its identity in between (its last
    // folder closes while the pick is settling). That race must cancel the take
    // rather than open a workspace the user never actually chose.
    it("cancels the take when this window loses its identity between the pick and the resolve", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "this-window" });
      vi.mocked(currentWindow).mockReturnValueOnce(HERE).mockReturnValue(undefined);

      const { provider } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]);

      expect(openWorkspace).not.toHaveBeenCalled();
    });

    it("says the session landed in this window", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "this-window" });
      vi.mocked(currentWindow).mockReturnValue(HERE);
      vi.mocked(openWorkspace).mockResolvedValue({
        mode: "per-window",
        briefs: [],
        opened: ["/repos/account-service"],
        remoteControl: false,
        seededInPlace: true,
      } as never);

      const { provider, posted } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]);

      expect(posted()).toContainEqual(
        expect.objectContaining({ type: "toast", level: "success", message: expect.stringContaining("in this window") }),
      );
    });

    // Seeding into this window with seedAgent off is the one outcome with nothing to
    // show: no window opened, no session started, only briefs on disk. Claiming
    // "Opened in this window" would describe something that never happened.
    it("does not claim a window opened when seeding is off and the destination is this window", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "this-window", seedAgent: false });
      vi.mocked(currentWindow).mockReturnValue(HERE);
      vi.mocked(openWorkspace).mockResolvedValue({
        mode: "per-window",
        briefs: [],
        opened: ["/repos/account-service"],
        remoteControl: false,
        seededInPlace: true,
      } as never);

      const { provider, posted } = setup();
      await provider.takeTask("ASM-1", "card", ["account-service"]);

      const toast = posted().find((m) => m.type === "toast" && m.level === "success") as { message: string };
      expect(toast.message).toContain("Opened nothing");
      expect(toast.message).toContain("agentFlow.seedAgent is off");
      expect(toast.message).not.toContain("Opened in this window");
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
        redundant: [],
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
        redundant: [],
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
        redundant: [],
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
        redundant: [],
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
        redundant: [],
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
        redundant: [],
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
      vi.mocked(planWorkspaceMerge).mockReturnValue({ add: [], duplicates: [], redundant: [], present: [], ok: false });
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
        redundant: [],
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
        redundant: [],
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
        redundant: [],
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
    // request()'s network-level catch (src/tasks/jira/client.ts) throws a plain Error —
    // not JiraApiError/JiraAuthError — for an unreachable host, tagged via
    // markTaskNetworkFailure (src/tasks/provider.ts) so resolveOp() and
    // classifyFailure() both recognize it. The message embeds the user's own
    // Jira site URL; operation_failed must never carry any part of it.
    clientStub.getDetail.mockRejectedValueOnce(
      markTaskNetworkFailure(new Error("Couldn't reach Jira at https://my-secret-org.atlassian.net: fetch failed"), "ENOTFOUND"),
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
      markTaskNetworkFailure(
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
      markTaskNetworkFailure(new Error("Couldn't reach Jira at https://my-secret-org.atlassian.net: fetch failed"), "ENOTFOUND"),
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
    vi.mocked(currentWindow).mockReturnValue({
      identity: "/repos/api",
      kind: "folder",
      roots: [{ name: "api", path: "/repos/api" }],
    });
    const { provider } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(openSharedWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: "current" } }),
    );
  });

  // The gap between the destination pick and the shared open spans the prompt-mode
  // pick, the layout pick and createWorktrees for every task — seconds, not a
  // millisecond. Without the guard openSharedWorkspace has no "current" destination
  // and falls through to the new-window path, spawning a window nobody asked for.
  it("fails the shared batch instead of spawning a window when this window loses its identity", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "this-window" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(currentWindow)
      .mockReturnValueOnce({ identity: "/repos/api", kind: "folder", roots: [{ name: "api", path: "/repos/api" }] })
      .mockReturnValue(undefined);
    const { provider, posted } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    expect(openSharedWorkspace).not.toHaveBeenCalled();
    expect(posted()).toContainEqual(
      expect.objectContaining({
        type: "toast",
        level: "error",
        message: expect.stringContaining("no longer hold a session"),
      }),
    );
  });

  // A batch seeded into this window opened nothing — "in one shared window" would
  // imply one appeared.
  it("says a shared batch landed in this window when it seeded in place", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "this-window" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(currentWindow).mockReturnValue({
      identity: "/repos/api",
      kind: "folder",
      roots: [{ name: "api", path: "/repos/api" }],
    });
    vi.mocked(openSharedWorkspace).mockResolvedValue({
      opened: true,
      briefs: [],
      seeded: 2,
      seededInPlace: true,
    } as never);
    const { provider, posted } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    const toast = posted().find((m) => m.type === "toast" && m.level === "success") as { message: string };
    expect(toast.message).toContain("in this window");
    expect(toast.message).not.toContain("in one shared window");
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

  it("names a redundant repo in the already-in-the-workspace clause", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({
      target: { kind: "existing", file: "/ws/team.code-workspace" },
    } as never);
    // mockReturnValueOnce, not mockReturnValue: vitest's clearMocks resets call history but
    // keeps implementations, so a permanent override would leak into later tests.
    vi.mocked(planWorkspaceMerge).mockReturnValueOnce({
      add: [],
      duplicates: [],
      redundant: [
        { label: "api", repoName: "api", path: "/repos/api/.claude/worktrees/ASM-1" },
      ],
      present: [],
      ok: true,
    });
    vi.mocked(openSharedWorkspace).mockResolvedValue({
      workspaceFile: "/ws/team.code-workspace",
      opened: true,
      briefs: [],
      seeded: 2,
    });

    const { provider, posted } = setup();
    await provider.takeBatch(twoKeys, ["api"]);

    const toast = posted().find((m) => m.type === "toast") as { message: string };
    expect(toast.message).toContain("api already in the workspace");
    // No add-prompt: `add` was empty, so the only quick pick was the destination.
    expect(window.showQuickPick).toHaveBeenCalledTimes(1);
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
    vi.mocked(currentWindow).mockReturnValue({
      identity: "/repos/api",
      kind: "folder",
      roots: [{ name: "api", path: "/repos/api" }],
    });
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
      redundant: [],
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
      redundant: [],
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
      redundant: [],
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

  it("derives the repo, not a phantom, from a workspace folder that is a worktree", async () => {
    // A folder left behind by an older version points at .../worktrees/ASM-5111, whose
    // basename is a ticket key. Taken at face value it becomes a phantom repo — and since a
    // worktree's .git is a pointer FILE it even passes the isGit check, so the next
    // createWorktrees would nest a worktree inside that worktree.
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask", exploreMode: "knowledge" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["centaur"]));
    vi.mocked(workspaceFolderPaths).mockReturnValue(["/repos/centaur/.claude/worktrees/ASM-5111"]);
    vi.mocked(listWorkspaceFiles).mockReturnValue([
      { file: "/ws/team.code-workspace", folders: 1, mtimeMs: 1 },
    ]);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("x");
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ target: { kind: "existing-pick" } } as never)
      .mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never);

    await runExplore();

    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        services: [expect.objectContaining({ name: "centaur", path: "/repos/centaur" })],
      }),
    );
  });

  it("collapses a repo and a worktree of that repo to one service", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask", exploreMode: "knowledge" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["centaur"]));
    vi.mocked(workspaceFolderPaths).mockReturnValue([
      "/repos/centaur",
      "/repos/centaur/.claude/worktrees/ASM-5885",
    ]);
    vi.mocked(listWorkspaceFiles).mockReturnValue([
      { file: "/ws/team.code-workspace", folders: 2, mtimeMs: 1 },
    ]);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("x");
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ target: { kind: "existing-pick" } } as never)
      .mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never);

    await runExplore();

    const services = vi.mocked(openWorkspace).mock.calls.at(-1)![0].services;
    expect(services.map((s) => s.path)).toEqual(["/repos/centaur"]);
  });

  it("collapses two different worktrees of the same repo to one service", async () => {
    // Each worktree's root is independently unwound and (per the fix) canon()'d before
    // the dedup map keys on it — two distinct ticket keys must still land on one entry.
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask", exploreMode: "knowledge" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["centaur"]));
    vi.mocked(workspaceFolderPaths).mockReturnValue([
      "/repos/centaur/.claude/worktrees/ASM-1111",
      "/repos/centaur/.claude/worktrees/ASM-2222",
    ]);
    vi.mocked(listWorkspaceFiles).mockReturnValue([
      { file: "/ws/team.code-workspace", folders: 2, mtimeMs: 1 },
    ]);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("x");
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ target: { kind: "existing-pick" } } as never)
      .mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never);

    await runExplore();

    const services = vi.mocked(openWorkspace).mock.calls.at(-1)![0].services;
    expect(services).toEqual([expect.objectContaining({ name: "centaur", path: "/repos/centaur", isGit: true })]);
  });

  it("collapses a live-folder destination pointed at a worktree to its owning repo", async () => {
    // per-window tracking takes open windows directly at worktree paths, and window
    // presence records that path, so a live folder pointing at .../worktrees/<KEY> is the
    // highest-traffic instance of the unwind — pin it so it can't regress.
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask", exploreMode: "knowledge" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["centaur"]));
    vi.mocked(readLiveWindows).mockReturnValue([
      { pid: 1, identity: "/repos/centaur/.claude/worktrees/ASM-5885", kind: "folder", label: "ASM-5885", folders: 1, updatedAt: 9 },
    ]);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("poke around");
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ target: { kind: "live-folder", folder: "/repos/centaur/.claude/worktrees/ASM-5885" } } as never) // open where (first)
      .mockResolvedValueOnce([{ repo: mkRepos(["centaur"])[0] }] as never);                                                    // repos (last)

    await runExplore();

    const services = vi.mocked(openWorkspace).mock.calls.at(-1)![0].services;
    expect(services.map((s) => s.path)).toEqual(["/repos/centaur"]);
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

// ── Remote Control × the Copilot provider ───────────────────────────────────
// Remote Control seeds `/remote-control <key>`, a Claude Code slash command Copilot
// would take as literal prompt text. The combination is refused pre-flight.
//
// `agentProvider` reaches the view through getConfig(), which this file mocks, so the
// tests set it there rather than through env.uriScheme: readAgentProvider has already
// applied the VS Code host guard by the time getConfig() returns, which is exactly why
// "copilot" here models a real VS Code install and can never arise in Cursor.
//
// The last three cases are REGRESSION GUARDS for the flows that exist today — they
// were green before the block was written and must stay green.
describe("remote control × the Copilot provider", () => {
  const lastOpen = () =>
    vi.mocked(openWorkspace).mock.calls[vi.mocked(openWorkspace).mock.calls.length - 1][0];
  const errorToast = (posted: () => OutboundMessage[]) =>
    posted().find((m) => m.type === "toast" && m.level === "error") as { message: string } | undefined;
  const copilot = (over: Partial<ReturnType<typeof getConfig>> = {}) =>
    vi.mocked(getConfig).mockReturnValue({ ...CFG, agentProvider: "copilot" as const, ...over });

  it("refuses a Take and opens nothing", async () => {
    copilot({ remoteControl: "on" });
    const { provider, posted } = setup();
    await provider.takeTask("ASM-1", "card", ["account-service"]);
    expect(errorToast(posted)?.message).toContain("Remote Control needs Claude Code");
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it("refuses an Explore and opens nothing", async () => {
    // resolveKickoffTarget's call site — the one that must return undefined, not false.
    copilot({ remoteControl: "on", exploreMode: "knowledge" });
    vi.mocked(window.showInputBox).mockResolvedValueOnce("the retry path" as never);
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { send, posted } = setup();
    await send({ type: "explore" });
    expect(errorToast(posted)?.message).toContain("Remote Control needs Claude Code");
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it("refuses a one-key batch and opens nothing", async () => {
    // takeBatch's call site — a one-key batch is the only shape there that resolves
    // Remote Control at all, so it is the only one that can be refused.
    copilot({ remoteControl: "on" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(createWorktrees).mockImplementation((s, key) =>
      s.map((r) => ({ ...r, path: `${r.path}/.claude/worktrees/${key}` })),
    );
    const { provider, posted } = setup();
    await provider.takeBatch(["ASM-1"], ["api"]);
    expect(errorToast(posted)?.message).toContain("Remote Control needs Claude Code");
    expect(openWorkspace).not.toHaveBeenCalled();
    vi.mocked(createWorktrees).mockImplementation((s) => s);
  });

  it("leaves Claude Code + Remote Control alone", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, remoteControl: "on" });
    const { provider, posted } = setup();
    await provider.takeTask("ASM-1", "card", ["account-service"]);
    expect(errorToast(posted)).toBeUndefined();
    expect(openWorkspace).toHaveBeenCalledTimes(1);
    expect(lastOpen().remoteControl).toBe(true);
  });

  it("does not fire when Remote Control is off", async () => {
    copilot({ remoteControl: "off" });
    const { provider, posted } = setup();
    await provider.takeTask("ASM-1", "card", ["account-service"]);
    expect(errorToast(posted)).toBeUndefined();
    expect(openWorkspace).toHaveBeenCalledTimes(1);
    expect(lastOpen().remoteControl).toBe(false);
  });

  it("does not fire for a real batch, which never resolves Remote Control at all", async () => {
    // The `isBatch || shared ? false : …` short-circuit means resolveRemoteControl is
    // never reached — so a Copilot batch with the setting on still launches.
    copilot({ remoteControl: "on" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(createWorktrees).mockImplementation((s, key) =>
      s.map((r) => ({ ...r, path: `${r.path}/.claude/worktrees/${key}` })),
    );
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ shared: false } as never); // layout pick
    const { provider, posted } = setup();
    await provider.takeBatch(["ASM-1", "ASM-2"], ["api"]);
    expect(errorToast(posted)).toBeUndefined();
    expect(openWorkspace).toHaveBeenCalledTimes(2);
    vi.mocked(createWorktrees).mockImplementation((s) => s);
  });
});

// ── capability gating ───────────────────────────────────────────────────────
// Everything above drives the shipped Jira connector, which declares every optional
// capability. These drive the Task 7 fixture connector, which declares none — so a
// view that reaches for sprints, components, labels, estimates or an unsupported
// filter fails here instead of shipping. FX-2 is assigned to "Me" with
// `inOpenSprint: false`, which is exactly the case a missing sprint gate springs.

describe("a source with no optional capabilities", () => {
  it("posts only the filters that source supports", async () => {
    const { posted } = await mountWith(makeFixtureConnector());
    const state = posted.find((m) => m.type === "state") as { caps: SerializedCaps; sourceLabel: string };
    expect(state.caps.supportedFilters).toEqual(["mine", "all"]);
    expect(state.caps.sprints).toBe(false);
    expect(state.caps.components).toBe(false);
    expect(state.caps.labels).toBe(false);
    expect(state.caps.sizes).toBe(false);
    expect(state.sourceLabel).toBe("Fixture");
  });

  it("refuses a sprint write instead of throwing", async () => {
    const { view, posted } = await mountWith(makeFixtureConnector());
    await view.addToMySprint("FX-1");
    expect(posted.some((m) => m.type === "movedToSprint")).toBe(false);
    const toast = posted.find((m) => m.type === "toast" && m.level === "error") as { message: string };
    expect(toast.message).toMatch(/Fixture/);
  });

  it("refuses a sprint removal the same way, and never posts removedFromSprint", async () => {
    const { view, posted } = await mountWith(makeFixtureConnector());
    await view.removeFromSprint("FX-1", "any");
    expect(posted.some((m) => m.type === "removedFromSprint")).toBe(false);
    expect(posted.find((m) => m.type === "toast" && m.level === "error")).toBeDefined();
    // No native Undo notification either — there is nothing to undo.
    expect(window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("refuses a component sync but still releases the webview's optimistic edit", async () => {
    const { view, posted } = await mountWith(makeFixtureConnector());
    await view.setComponent("FX-1", "account-service", true, true);
    // ok:false is what undoes the held chip edit; a silent return would strand it.
    expect(posted).toContainEqual(
      expect.objectContaining({ type: "componentsChanged", key: "FX-1", ok: false }),
    );
    const toast = posted.find((m) => m.type === "toast" && m.level === "error") as { message: string };
    expect(toast.message).toMatch(/Fixture/);
  });

  it("classifies no chip at all, and blames no connection, when the source has no components", async () => {
    const { send, posted, logged } = await mountWith(makeFixtureConnector());
    await send({ type: "detail", key: "FX-1" });
    const detail = posted.find((m) => m.type === "detail") as
      { sourceComponents: string[]; mappable: Record<string, string> | null };
    // `null`, not `{}`: nothing can be claimed about any chip either way.
    expect(detail.mappable).toBeNull();
    expect(detail.sourceComponents).toEqual([]);
    // And the trace must not say a read failed — nothing was read. Blaming the
    // connection for a capability the source never had sends the user looking in
    // exactly the wrong place, which is why setComponent already words these apart.
    expect(logged).toContain("detail FX-1: Fixture doesn't have components");
    expect(logged.some((l) => l.includes("component list unavailable"))).toBe(false);
  });

  it("treats stampLabelOnWrite as a silent no-op, not a crash", async () => {
    // stampLabelOnWrite defaults true (CFG sets it); a label-less source must still complete.
    const { view, posted } = await mountWith(makeFixtureConnector());
    answerPicks(pickFirst);
    await view.changeStatus("FX-1");
    expect(posted.some((m) => m.type === "statusChanged")).toBe(true);
    expect(posted.filter((m) => m.type === "toast").every((t) => t.level !== "error")).toBe(true);
  });

  it("changes status with no field prompts", async () => {
    const { view, posted } = await mountWith(makeFixtureConnector());
    answerPicks(pickFirst);
    await view.changeStatus("FX-1");
    expect(window.showInputBox).not.toHaveBeenCalled();
    // The fixture's first target is Open (category "new") — not a retirement.
    expect(posted).toContainEqual({
      type: "statusChanged", key: "FX-1", status: "Open", category: "new", removed: false,
    });
  });

  it("folds an uncategorized destination's \"\" toCategory into \"new\" on the wire", async () => {
    // A connector may not be able to categorize every destination (toCategory: "").
    // Task.statusCategory has no such member — a task always has one of the three —
    // so the message this posts must not repeat the "" verbatim.
    const statusTargets = vi.fn(async () => [
      { id: "9", toName: "Somewhere", toCategory: "" as const, fields: [] },
    ]);
    const moveTo = vi.fn(async () => {});
    const { view, posted } = await mountWith(withProvider({ statusTargets, moveTo }));
    answerPicks(pickFirst);
    await view.changeStatus("FX-1");
    expect(posted).toContainEqual({
      type: "statusChanged", key: "FX-1", status: "Somewhere", category: "new", removed: false,
    });
  });

  it("never asks the source for the shipped default lens it cannot answer", async () => {
    // agentFlow.defaultFilter ships as "mysprint", and this source has no sprints.
    vi.mocked(getConfig).mockReturnValue({ ...CFG, defaultFilter: "mysprint" });
    const list = vi.fn(async () => []);
    await mountWith(withProvider({ list }));
    expect(list).toHaveBeenCalledWith("mine", "any");
    expect(list.mock.calls.some((c) => (c as unknown[])[0] === "mysprint")).toBe(false);
  });

  it("clamps an inbound fetch carrying a filter the source no longer supports", async () => {
    // A webview left open across an agentFlow.taskSource change sends the old lens.
    const list = vi.fn(async () => []);
    const { send, posted } = setup({ connector: withProvider({ list }) });
    await send({ type: "fetch", filter: "sprint", size: "any" });
    expect(list).toHaveBeenCalledWith("mine", "any");
    // The posted lens is the one actually fetched, so the tab bar cannot highlight a
    // tab whose contents were never requested.
    expect(posted()).toContainEqual(expect.objectContaining({ type: "tasks", filter: "mine" }));
  });
});

describe("a refused write that names fields to retry", () => {
  it("re-prompts exactly the fields the connector asked for, then retries once", async () => {
    const moveTo = vi.fn()
      .mockRejectedValueOnce(new TaskWriteError("needs Impact", [
        { kind: "text", id: "customfield_1", name: "Impact" },
      ]))
      .mockResolvedValueOnce(undefined);
    const connector = withProvider({ moveTo });
    stubInputBox("high"); // the re-prompt answer
    const { view, posted } = await mountWith(connector);
    answerPicks(pickFirst);
    await view.changeStatus("FX-1");
    expect(moveTo).toHaveBeenCalledTimes(2);
    expect(moveTo.mock.calls[1][2]).toEqual({ customfield_1: "high" });
    expect(posted.some((m) => m.type === "statusChanged")).toBe(true);
  });

  it("asks for nothing but the named fields", async () => {
    const moveTo = vi.fn()
      .mockRejectedValueOnce(new TaskWriteError("needs Impact", [
        { kind: "text", id: "customfield_1", name: "Impact" },
      ]))
      .mockResolvedValueOnce(undefined);
    stubInputBox("high");
    const { view } = await mountWith(withProvider({ moveTo }));
    answerPicks(pickFirst);
    await view.changeStatus("FX-1");
    expect(vi.mocked(window.showInputBox).mock.calls).toHaveLength(1);
    expect(vi.mocked(window.showInputBox).mock.calls[0][0]).toEqual(
      expect.objectContaining({ prompt: "Impact" }),
    );
  });

  it("stays silent and writes nothing more when the re-prompt is cancelled", async () => {
    const moveTo = vi.fn().mockRejectedValue(new TaskWriteError("needs Impact", [
      { kind: "text", id: "customfield_1", name: "Impact" },
    ]));
    stubInputBox(undefined);
    const { view, posted } = await mountWith(withProvider({ moveTo }));
    answerPicks(pickFirst);
    await view.changeStatus("FX-1");
    expect(moveTo).toHaveBeenCalledTimes(1);
    expect(posted.filter((m) => m.type === "toast")).toEqual([]);
    expect(posted.some((m) => m.type === "statusChanged")).toBe(false);
  });

  it("reports and stops when retryWith is empty", async () => {
    const moveTo = vi.fn().mockRejectedValue(new TaskWriteError("no permission", []));
    const { view, posted } = await mountWith(withProvider({ moveTo }));
    answerPicks(pickFirst);
    await view.changeStatus("FX-1");
    expect(moveTo).toHaveBeenCalledTimes(1);
    const toast = posted.find((m) => m.type === "toast" && m.level === "error") as
      { message: string; action: { label: string; url: string } };
    expect(toast.message).toContain("no permission");
    expect(toast.action.label).toMatch(/^Open in /);
    expect(toast.action.url).toBe("https://fixture.test/t/FX-1");
    // A refused write keeps the list on screen — it never re-gates the panel.
    expect(posted.some((m) => m.type === "error")).toBe(false);
  });

  it("reports the second refusal rather than retrying forever", async () => {
    const moveTo = vi.fn().mockRejectedValue(new TaskWriteError("still refused", [
      { kind: "text", id: "customfield_1", name: "Impact" },
    ]));
    stubInputBox("high");
    const { view, posted } = await mountWith(withProvider({ moveTo }));
    answerPicks(pickFirst);
    await view.changeStatus("FX-1");
    expect(moveTo).toHaveBeenCalledTimes(2);
    expect(posted.find((m) => m.type === "toast" && m.level === "error")).toBeDefined();
    expect(posted.some((m) => m.type === "statusChanged")).toBe(false);
  });
});

describe("notepad", () => {
  // A provider wired to a context whose globalState is a real in-memory map, so
  // these tests assert on what was actually persisted rather than on a spy.
  function mkProvider() {
    const store = new Map<string, unknown>();
    const ctx = {
      ...fakeContext(),
      globalState: {
        get: (k: string, d?: unknown) => (store.has(k) ? store.get(k) : d),
        update: async (k: string, v: unknown) => void store.set(k, v),
      },
    } as unknown as ConstructorParameters<typeof TasksViewProvider>[0];
    const posted: unknown[] = [];
    const provider = new TasksViewProvider(ctx, makeFixtureConnector(), () => {});
    // The provider posts through its resolved webview; stand one in.
    (provider as unknown as { view: unknown }).view = {
      webview: { postMessage: (m: unknown) => void posted.push(m) },
    };
    // `onMessage` is private on the class — these tests drive it directly because
    // it IS the unit under test, matching how the rest of this file reaches it
    // (see the `send`/`handler` helpers above).
    const sendMsg = (m: InboundMessage) =>
      (provider as unknown as { onMessage(m: InboundMessage): Promise<void> }).onMessage(m);
    return { provider, posted, store, sendMsg };
  }

  const notesIn = (store: Map<string, unknown>) =>
    store.get("agentFlow.notepad") as { id: string; title: string; done: boolean }[] | undefined;

  it("adds a note and posts the new list back", async () => {
    const { posted, store, sendMsg } = mkProvider();
    await sendMsg({ type: "notepad:add", title: "Write the thing", body: "details" });
    expect(notesIn(store)!.map((n) => n.title)).toEqual(["Write the thing"]);
    const last = posted.at(-1) as { type: string; notes: { title: string }[] };
    expect(last.type).toBe("notepad:notes");
    expect(last.notes.map((n) => n.title)).toEqual(["Write the thing"]);
  });

  it("ignores an add whose title and body are both blank", async () => {
    const { store, sendMsg } = mkProvider();
    await sendMsg({ type: "notepad:add", title: "   ", body: "  " });
    expect(notesIn(store) ?? []).toEqual([]);
  });

  it("edits a note in place", async () => {
    const { store, sendMsg } = mkProvider();
    await sendMsg({ type: "notepad:add", title: "old", body: "b" });
    const id = notesIn(store)![0].id;
    await sendMsg({ type: "notepad:update", id, title: "new", body: "b2" });
    expect(notesIn(store)![0]).toMatchObject({ id, title: "new", body: "b2" });
  });

  it("toggles done and back", async () => {
    const { store, sendMsg } = mkProvider();
    await sendMsg({ type: "notepad:add", title: "t", body: "" });
    const id = notesIn(store)![0].id;
    await sendMsg({ type: "notepad:toggleDone", id });
    expect(notesIn(store)![0].done).toBe(true);
    await sendMsg({ type: "notepad:toggleDone", id });
    expect(notesIn(store)![0].done).toBe(false);
  });

  it("deletes one note and leaves the rest", async () => {
    const { store, sendMsg } = mkProvider();
    await sendMsg({ type: "notepad:add", title: "a", body: "" });
    await sendMsg({ type: "notepad:add", title: "b", body: "" });
    const id = notesIn(store)!.find((n) => n.title === "a")!.id;
    await sendMsg({ type: "notepad:delete", id });
    expect(notesIn(store)!.map((n) => n.title)).toEqual(["b"]);
  });

  it("clears only the completed notes", async () => {
    const { store, sendMsg } = mkProvider();
    await sendMsg({ type: "notepad:add", title: "keep", body: "" });
    await sendMsg({ type: "notepad:add", title: "drop", body: "" });
    const id = notesIn(store)!.find((n) => n.title === "drop")!.id;
    await sendMsg({ type: "notepad:toggleDone", id });
    await sendMsg({ type: "notepad:clearCompleted" });
    expect(notesIn(store)!.map((n) => n.title)).toEqual(["keep"]);
  });

  it("survives a globalState value that is not an array", async () => {
    const { provider, store, posted } = mkProvider();
    store.set("agentFlow.notepad", { corrupt: true });
    provider.postNotepad();
    expect((posted.at(-1) as { notes: unknown[] }).notes).toEqual([]);
  });

  it("launches a run keyed off the note title plus the note's own id, and records it on the note", async () => {
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never); // repo picker
    const { store, sendMsg } = mkProvider();
    await sendMsg({ type: "notepad:add", title: "Fix the retry banner", body: "it double-fires" });
    const id = notesIn(store)![0].id;
    await sendMsg({ type: "notepad:run", id });

    const call = vi.mocked(openWorkspace).mock.calls.at(-1)![0];
    expect(call.kind).toBe("notepad");
    expect(call.ticket.key).toBe(`notepad-fix-the-retry-banner-${id}`);
    expect(call.ticket.url).toBe("");
    expect(call.planMd).toContain("it double-fires");
    expect((notesIn(store)![0] as { lastRunKey?: string }).lastRunKey).toBe(`notepad-fix-the-retry-banner-${id}`);
  });

  it("falls back to a generic slug, still suffixed with the note's id, when the note has no title", async () => {
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never); // repo picker
    const { store, sendMsg } = mkProvider();
    await sendMsg({ type: "notepad:add", title: "", body: "just a body" });
    const id = notesIn(store)![0].id;
    await sendMsg({ type: "notepad:run", id });
    expect(vi.mocked(openWorkspace).mock.calls.at(-1)![0].ticket.key).toBe(`notepad-note-${id}`);
  });

  it("gives two distinct untitled notes different run keys", async () => {
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showQuickPick).mockResolvedValue([{ repo: repos[0] }] as never); // repo picker, both runs
    const { store, sendMsg } = mkProvider();
    await sendMsg({ type: "notepad:add", title: "", body: "first" });
    await sendMsg({ type: "notepad:add", title: "", body: "second" });
    const [idA, idB] = notesIn(store)!.map((n) => n.id);
    expect(idA).not.toBe(idB);

    await sendMsg({ type: "notepad:run", id: idA });
    const keyA = vi.mocked(openWorkspace).mock.calls.at(-1)![0].ticket.key;
    await sendMsg({ type: "notepad:run", id: idB });
    const keyB = vi.mocked(openWorkspace).mock.calls.at(-1)![0].ticket.key;

    expect(keyA).not.toBe(keyB);
  });

  it("gives two notes with identical titles different run keys", async () => {
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showQuickPick).mockResolvedValue([{ repo: repos[0] }] as never); // repo picker, both runs
    const { store, sendMsg } = mkProvider();
    await sendMsg({ type: "notepad:add", title: "Fix login", body: "attempt one" });
    await sendMsg({ type: "notepad:add", title: "Fix login", body: "attempt two" });
    const notes = notesIn(store)!;
    const idA = notes.find((n) => n.title === "Fix login")!.id;
    const idB = notes.filter((n) => n.title === "Fix login")[1].id;
    expect(idA).not.toBe(idB);

    await sendMsg({ type: "notepad:run", id: idA });
    const keyA = vi.mocked(openWorkspace).mock.calls.at(-1)![0].ticket.key;
    await sendMsg({ type: "notepad:run", id: idB });
    const keyB = vi.mocked(openWorkspace).mock.calls.at(-1)![0].ticket.key;

    expect(keyA).not.toBe(keyB);
  });

  it("reuses the same run key when the same note is run twice", async () => {
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showQuickPick).mockResolvedValue([{ repo: repos[0] }] as never); // repo picker, both runs
    const { store, sendMsg } = mkProvider();
    await sendMsg({ type: "notepad:add", title: "Re-run me", body: "" });
    const id = notesIn(store)![0].id;

    await sendMsg({ type: "notepad:run", id });
    const key1 = vi.mocked(openWorkspace).mock.calls.at(-1)![0].ticket.key;
    await sendMsg({ type: "notepad:run", id });
    const key2 = vi.mocked(openWorkspace).mock.calls.at(-1)![0].ticket.key;

    expect(key1).toBe(key2);
  });

  it("uses the generic explore action's prompt, selected by id rather than list position", async () => {
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    // Reorder the configured actions so "general" is no longer first — a positional
    // pick (exploreActions[0]) would silently grab "Jira ticket" instead.
    vi.mocked(getConfig).mockReturnValue({
      ...CFG,
      exploreActions: [...CFG.exploreActions].reverse(),
    });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { store, sendMsg } = mkProvider();
    await sendMsg({ type: "notepad:add", title: "check the general prompt", body: "" });
    const id = notesIn(store)![0].id;
    await sendMsg({ type: "notepad:run", id });
    const general = CFG.exploreActions.find((a) => a.id === "general")!;
    expect(vi.mocked(openWorkspace).mock.calls.at(-1)![0].promptTemplate).toBe(general.prompt);
  });

  it("does nothing for an id that is not in the list", async () => {
    const { sendMsg } = mkProvider();
    vi.mocked(openWorkspace).mockClear();
    await sendMsg({ type: "notepad:run", id: "ghost" });
    expect(openWorkspace).not.toHaveBeenCalled();
  });
});
