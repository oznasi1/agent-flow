import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { commands, env, liveToken, noopProgress, ProgressLocation, window } from "../_mocks/vscode";
import { fakeAuth, fakeContext, mkRepos } from "../_helpers/factories";

// ── sibling modules the controller depends on ──────────────────────────────
// Keep the real config constants (DEFAULT_PR_REVIEW_PROMPT, …) faithful — only
// getConfig is stubbed so tests control the resolved settings.
vi.mock("../../src/config", async () => {
  const actual = await vi.importActual<typeof import("../../src/config")>("../../src/config");
  return { ...actual, getConfig: vi.fn() };
});
vi.mock("../../src/engine/repos", () => ({ discoverRepos: vi.fn() }));
// Partial: only the five entry points that open windows or touch the filesystem are
// stubbed. BRIEF_DIR and attachmentFileName stay REAL — they are a constant and a
// pure path function, and the notepad's image handoff names paths with them that the
// engine then copies files to, so a stub here would let the two drift silently.
// `writeBriefInto` is stubbed for the same reason openWorkspace is: it writes into a
// child worktree, and these tests run against fake `/repos` paths. Its real writing
// behaviour is covered in test/unit/engine/workspace.test.ts.
vi.mock("../../src/engine/workspace", async () => {
  const actual = await vi.importActual<typeof import("../../src/engine/workspace")>("../../src/engine/workspace");
  return {
    ...actual,
    openWorkspace: vi.fn(),
    writeBriefInto: vi.fn(() => []),
    listWorkspaceFiles: vi.fn(() => []),
    workspaceFolderPaths: vi.fn(() => []),
    planWorkspaceMerge: vi.fn(() => ({ add: [], duplicates: [], redundant: [], present: [], ok: true })),
  };
});
// repoRootOfWorktree is a pure path function (no fs/git side effects) — keep the real one
// so the derivation tests exercise the genuine convention, and stub only createWorktrees,
// the entry point that shells out to git. Same reasoning as the batchWorkspace mock below.
vi.mock("../../src/engine/worktree", async () => {
  const actual = await vi.importActual<typeof import("../../src/engine/worktree")>(
    "../../src/engine/worktree",
  );
  // ensureBranch shells out to git too, so it is stubbed for the same reason
  // createWorktrees is. It answers true by default — the parent branch exists — so a
  // test only has to script the refusal. branchName stays REAL (it comes from
  // `actual`), which is how the child-worktree tests below compute the parent branch
  // from the fixture's own summary instead of hardcoding a slug.
  return { ...actual, createWorktrees: vi.fn((s: unknown) => s), ensureBranch: vi.fn(() => true) };
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
// Partial, and only `currentBranch`: it shells out to git, and these tests run against
// fake `/repos` paths where the real one would spawn a process per child worktree to
// answer null anyway. `null` is the default because that is what an unreadable path
// really says — the caller then falls back to the computed branch name, which is what
// every assertion below was written against. `gitState` and the rest stay REAL, so the
// engine/workspace module running against this file's partial mock is untouched.
vi.mock("../../src/engine/git", async () => {
  const actual = await vi.importActual<typeof import("../../src/engine/git")>("../../src/engine/git");
  return { ...actual, currentBranch: vi.fn(() => null) };
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
import { getConfig, resolvedProvider } from "../../src/config";
import { discoverRepos } from "../../src/engine/repos";
import { openWorkspace, writeBriefInto, listWorkspaceFiles, workspaceFolderPaths, planWorkspaceMerge } from "../../src/engine/workspace";
import { branchName, createWorktrees, ensureBranch } from "../../src/engine/worktree";
import { currentBranch } from "../../src/engine/git";
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
import { FIXTURE_TASKS, makeFixtureConnector } from "../_helpers/fixtureConnector";
import { TasksViewProvider } from "../../src/tasksView";
import type { TakeSource } from "../../src/telemetry/events";
import type { InboundMessage, OutboundMessage } from "../../src/types";
import { SLACK_DM_SENTENCE, PR_REVIEW_AUTOFIX_CLAUSE } from "../../src/engine/prompt";

const CFG = {
  taskSource: "jira",
  forge: "github",
  baseUrl: "https://jira",
  project: "PROJ",
  agileAcceleratorInstanceUrl: "",
  agileAcceleratorTeam: "",
  agileAcceleratorTargetOrg: "",
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
  reviewOpenIn: "new-window" as const,
  // The sidebar never seeds PR work; present only because AgentFlowConfig is total.
  prWorkOpenIn: "ask" as const,
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
  commands: [] as { id: string; label: string; run: string; detail?: string }[],
  prReviewStatus: "PR initiated",
  showTokenTotal: false, // matches the shipped default; the Deck header total is opt-in
  prReviewAutoFix: true,
  prReviewPrompt: "PR {key}{files}",
  worktree: "never" as const,
  childWorktrees: false,
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
  retireClosedAfterHours: 24,
  retireInPlaceAfterHours: 0,
  inflightShowAll: false,
  notifyOnActionRequired: false,
  reviewRequests: true,
  reviewRequestsAlwaysVisible: false,
  reviewRequestsTtlSeconds: 300,
  reviewWrites: false,
  mergeWrites: false,
  mergeMethod: "squash" as const,
  orchestrator: false,
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
    // `shapeSnapshot` answering null keeps JIRA_CAPS — the constant every `state`
    // assertion below compares against — correct without editing any of them: a null
    // snapshot is specified to mean "claim what the connector claimed before board
    // detection existed". A test that wants the narrowed answer overrides it locally.
    loadShape: vi.fn(async () => ({ boardId: 2, hasSprints: true, boardCount: 1 })),
    shapeSnapshot: vi.fn(() => null as null | { boardId: number | null; hasSprints: boolean; boardCount: number }),
  };
}

beforeEach(() => {
  trackSpy.mockClear();
  trackErrorSpy.mockClear();
  clientStub = makeClient();
  vi.mocked(getConfig).mockReturnValue({ ...CFG });
  vi.mocked(discoverRepos).mockReturnValue(mkRepos(["account-service", "webapp"]));
  vi.mocked(JiraClient).mockImplementation(() => clientStub as unknown as JiraClient);
  // An implementation, not a resolved value: `provider` is what the REAL openWorkspace
  // resolved and seeded, which follows the setting each test installs — and tests set
  // that after this reset, so a value captured here would be stale and every toast
  // would name Claude Code whatever the user configured.
  vi.mocked(openWorkspace).mockImplementation(async () => ({
    mode: "per-window",
    workspaceFile: undefined,
    briefs: [],
    opened: ["/repos/account-service"],
    remoteControl: false,
    provider: resolvedProvider(getConfig().agentProvider),
  }));
  // Restored here, not merely cleared: `clearMocks` drops call history and leaves the
  // implementation in place, so a test that scripts a stale branch would otherwise leak
  // it into every test after it. null is "git cannot answer", which is the truth for
  // these fake paths and the answer every pre-existing assertion was written against.
  vi.mocked(currentBranch).mockImplementation(() => null);
  vi.mocked(readLiveWindows).mockReturnValue([]);
  vi.mocked(windowIdentity).mockReturnValue(undefined);
  vi.mocked(currentWindow).mockReturnValue(undefined);
  vi.mocked(openSharedWorkspace).mockResolvedValue({
    workspaceFile: "/ws/PROJ-1+1.code-workspace",
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
    // VS Code disposes a hidden WebviewView and the provider subscribes to that,
    // so the fake carries the event too — a fake missing it would make
    // resolveWebviewView throw here and nowhere in production.
    onDidDispose: (_cb: () => void) => ({ dispose() {} }),
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

describe("resolveWebviewView", () => {
  it("allows the notepad's image store as a webview resource root", () => {
    const { view } = setup();
    const roots = ((view.webview.options as { localResourceRoots?: { fsPath: string }[] }).localResourceRoots ?? [])
      .map((u) => u.fsPath);
    // Without globalStorage every notepad thumbnail 404s; without the extension
    // root the panel's own bundle does.
    expect(roots).toEqual(["/ext", "/globalstorage"]);
  });
});

describe("ready", () => {
  it("reports authed state with the current user and auto-fetches", async () => {
    const { send, posted } = setup({ authed: true });
    await send({ type: "ready" });
    expect(posted()).toContainEqual({ type: "state", sourceLabel: "Jira", agentLabel: "Claude Code", caps: JIRA_CAPS, authed: true, configured: true, project: "PROJ", me: "Jane", prReviewStatus: "PR initiated", filters: { size: true, status: true, repo: true, search: true }, liveCount: 0 });
    expect(clientStub.fetchTasks).toHaveBeenCalled();
  });

  it("names Copilot in the posted state's agentLabel when configured", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, agentProvider: "copilot" });
    const { send, posted } = setup({ authed: true });
    await send({ type: "ready" });
    expect(posted()).toContainEqual(expect.objectContaining({ type: "state", agentLabel: "Copilot" }));
  });

  it("reports unauthed state and does not fetch", async () => {
    const { send, posted } = setup({ authed: false });
    await send({ type: "ready" });
    expect(posted()).toContainEqual({ type: "state", sourceLabel: "Jira", agentLabel: "Claude Code", caps: JIRA_CAPS, authed: false, configured: true, project: "PROJ", me: null, prReviewStatus: "PR initiated", filters: { size: true, status: true, repo: true, search: true }, liveCount: 0 });
    expect(clientStub.fetchTasks).not.toHaveBeenCalled();
  });

  it("reports not-configured (and does not fetch) when the site URL / project are unset", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, baseUrl: "", project: "" });
    const { send, posted } = setup({ authed: true });
    await send({ type: "ready" });
    expect(posted()).toContainEqual({ type: "state", sourceLabel: "Jira", agentLabel: "Claude Code", caps: JIRA_CAPS, authed: true, configured: false, project: "", me: null, prReviewStatus: "PR initiated", filters: { size: true, status: true, repo: true, search: true }, liveCount: 0 });
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
    expect(posted()).toContainEqual({ type: "state", sourceLabel: "Jira", agentLabel: "Claude Code", caps: JIRA_CAPS, authed: true, configured: true, project: "PROJ", me: null, prReviewStatus: "PR initiated", filters: { size: true, status: true, repo: true, search: true }, liveCount: 0 });
    // …and the task list — the real payload — still loads.
    expect(clientStub.fetchTasks).toHaveBeenCalled();
  });

  it("re-establishes state and fetches on retry", async () => {
    const { send, posted } = setup({ authed: true });
    await send({ type: "retry" });
    expect(posted()).toContainEqual({ type: "state", sourceLabel: "Jira", agentLabel: "Claude Code", caps: JIRA_CAPS, authed: true, configured: true, project: "PROJ", me: "Jane", prReviewStatus: "PR initiated", filters: { size: true, status: true, repo: true, search: true }, liveCount: 0 });
    expect(clientStub.fetchTasks).toHaveBeenCalled();
  });

  it("routes runSetup to the setup command", async () => {
    const { send } = setup();
    await send({ type: "runSetup" });
    expect(commands.executeCommand).toHaveBeenCalledWith("agentFlow.setup");
  });

  // The panel's own title bar is the identity row. The fixture connector's scope
  // value is "PROJ" (CFG.project) and the Jira client stub's getMyself returns "Jane".
  it("titles the panel with the project and the signed-in user", async () => {
    const { send, view } = setup({ authed: true });
    await send({ type: "ready" });
    expect(view.title).toBe("PROJ");
    expect(view.description).toBe("Jane");
  });

  it("drops the description when nobody is signed in", async () => {
    const { send, view } = setup({ authed: false });
    await send({ type: "ready" });
    expect(view.title).toBe("PROJ");
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
      { pid: 1, identity: "/repos/account-service", kind: "folder", label: "account-service", folders: 1, roots: ["/repos/account-service"], updatedAt: 9 },
      { pid: 2, identity: "/repos/webapp", kind: "folder", label: "webapp", folders: 1, roots: ["/repos/webapp"], updatedAt: 8 },
    ]);
    const { send, posted } = setup({ authed: true });
    await send({ type: "ready" });
    expect(posted()).toContainEqual(expect.objectContaining({ type: "state", liveCount: 2 }));
  });

  it("excludes the current window from the count, same as the picker", async () => {
    vi.mocked(windowIdentity).mockReturnValue({ identity: "/repos/account-service", kind: "folder", label: "account-service", folders: 1, roots: ["/repos/account-service"] });
    vi.mocked(readLiveWindows).mockReturnValue([
      { pid: 1, identity: "/repos/account-service", kind: "folder", label: "account-service", folders: 1, roots: ["/repos/account-service"], updatedAt: 9 },
      { pid: 2, identity: "/repos/webapp", kind: "folder", label: "webapp", folders: 1, roots: ["/repos/webapp"], updatedAt: 8 },
    ]);
    const { send, posted } = setup({ authed: true });
    await send({ type: "ready" });
    expect(posted()).toContainEqual(expect.objectContaining({ type: "state", liveCount: 1 }));
  });

  it("omits liveCount from state when window tracking is off, rather than reporting zero", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, trackOpenWindows: false });
    vi.mocked(readLiveWindows).mockReturnValue([
      { pid: 1, identity: "/repos/webapp", kind: "folder", label: "webapp", folders: 1, roots: ["/repos/webapp"], updatedAt: 8 },
    ]);
    const { send, posted } = setup({ authed: true });
    await send({ type: "ready" });
    expect(posted()).toContainEqual({ type: "state", sourceLabel: "Jira", agentLabel: "Claude Code", caps: JIRA_CAPS, authed: true, configured: true, project: "PROJ", me: "Jane",
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
    expect(posted()).toContainEqual({ type: "state", sourceLabel: "Jira", agentLabel: "Claude Code", caps: JIRA_CAPS, authed: false, configured: true, project: "PROJ", me: null, prReviewStatus: "PR initiated", filters: { size: true, status: true, repo: true, search: true }, liveCount: 0 });
  });

  it("toggles loading and posts tasks with a services guess", async () => {
    clientStub.fetchTasks.mockResolvedValue([
      { key: "PROJ-1", summary: "s", labels: [], components: [] },
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

  it("guesses only ticket-confirmed repos when a component matches (label guess dropped)", async () => {
    clientStub.fetchTasks.mockResolvedValue([
      { key: "PROJ-1", summary: "s", labels: ["webapp"], components: ["account-service"] },
    ]);
    const { send, posted } = setup();
    await send({ type: "fetch", filter: "mine", size: "any" });
    const tasksMsg = posted().find((m) => m.type === "tasks") as { tasks: { services?: string[] }[] };
    expect(tasksMsg.tasks[0].services).toEqual(["account-service"]);
  });

  it("keeps label guesses on the card when the ticket confirms no repo", async () => {
    clientStub.fetchTasks.mockResolvedValue([
      { key: "PROJ-1", summary: "s", labels: ["webapp"], components: [] },
    ]);
    const { send, posted } = setup();
    await send({ type: "fetch", filter: "mine", size: "any" });
    const tasksMsg = posted().find((m) => m.type === "tasks") as { tasks: { services?: string[] }[] };
    expect(tasksMsg.tasks[0].services).toEqual(["webapp"]);
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
      { pid: 1, identity: "/repos/account-service", kind: "folder", label: "account-service", folders: 1, roots: ["/repos/account-service"], updatedAt: 9 },
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
    await provider.changeStatus("PROJ-1");
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "info" }));
    expect(clientStub.transition).not.toHaveBeenCalled();
  });

  it("does nothing when the pick is cancelled", async () => {
    clientStub.getTransitions.mockResolvedValue([
      { id: "31", name: "Start", toName: "In Progress", toCategory: "indeterminate" },
    ]);
    vi.mocked(window.showQuickPick).mockResolvedValue(undefined);
    const { provider } = setup();
    await provider.changeStatus("PROJ-1");
    expect(clientStub.transition).not.toHaveBeenCalled();
  });

  it("transitions, stamps the claude-code label, and reports removal for a done status", async () => {
    clientStub.getTransitions.mockResolvedValue([
      { id: "41", name: "Resolve", toName: "Done", toCategory: "done" },
    ]);
    answerPicks(pickFirst);
    const { provider, posted } = setup();
    await provider.changeStatus("PROJ-1");
    expect(clientStub.transition).toHaveBeenCalledWith("PROJ-1", "41", {});
    expect(clientStub.addLabel).toHaveBeenCalledWith("PROJ-1", "claude-code");
    expect(posted()).toContainEqual({
      type: "statusChanged",
      key: "PROJ-1",
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
    await provider.changeStatus("PROJ-1");
    expect(clientStub.addLabel).not.toHaveBeenCalled();
  });

  it("still succeeds when the label stamp fails", async () => {
    clientStub.getTransitions.mockResolvedValue([
      { id: "31", name: "Start", toName: "In Progress", toCategory: "indeterminate" },
    ]);
    clientStub.addLabel.mockRejectedValue(new Error("label denied"));
    answerPicks(pickFirst);
    const { provider, posted } = setup();
    await provider.changeStatus("PROJ-1");
    expect(posted()).toContainEqual(expect.objectContaining({ type: "statusChanged", key: "PROJ-1" }));
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
    await provider.changeStatus("PROJ-1");
    expect(clientStub.transition).toHaveBeenCalledWith("PROJ-1", "41", { resolution: { id: "10001" } });
  });

  it("writes nothing when the field prompt is cancelled", async () => {
    clientStub.getTransitions.mockResolvedValue([DONE_WITH_RESOLUTION]);
    answerPicks(pickFirst, undefined);
    const { provider, posted } = setup();
    await provider.changeStatus("PROJ-1");
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
    await provider.changeStatus("PROJ-1");
    expect(clientStub.transition).toHaveBeenCalledWith("PROJ-1", "51", { customfield_1: "shipped in 0.1.36" });
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
    await provider.changeStatus("PROJ-1");
    expect(clientStub.transition).toHaveBeenCalledWith("PROJ-1", "61", {});
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
    await provider.changeStatus("PROJ-1");
    expect(window.showInputBox).not.toHaveBeenCalled();
    expect(clientStub.transition).toHaveBeenCalledWith("PROJ-1", "71", {});
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
    await provider.changeStatus("PROJ-1");
    expect(clientStub.transition).toHaveBeenCalledTimes(2);
    expect(clientStub.transition).toHaveBeenLastCalledWith("PROJ-1", "41", { resolution: { id: "10001" } });
    expect(posted()).toContainEqual(expect.objectContaining({ type: "statusChanged", key: "PROJ-1" }));
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
    await provider.changeStatus("PROJ-1");
    expect(clientStub.transition).toHaveBeenLastCalledWith("PROJ-1", "41", { customfield_1: { id: "9" } });
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
    await provider.changeStatus("PROJ-1");
    expect(clientStub.listResolutions).toHaveBeenCalled();
    expect(clientStub.transition).toHaveBeenLastCalledWith("PROJ-1", "41", { resolution: { id: "10000" } });
  });

  it("reports a readable toast with an Open in Jira action when nothing can be re-prompted", async () => {
    const t = { id: "41", name: "Resolve", toName: "Done", toCategory: "done", fields: {} };
    clientStub.getTransitions.mockResolvedValue([t]);
    clientStub.transition.mockRejectedValue(apiError(["Transition is not valid"]));
    answerPicks(pickFirst);
    const { provider, posted } = setup();
    await provider.changeStatus("PROJ-1");
    expect(clientStub.transition).toHaveBeenCalledTimes(1);
    expect(posted()).toContainEqual({
      type: "toast",
      level: "error",
      message: "Couldn't update PROJ-1. Transition is not valid.",
      action: { label: "Open in Jira", url: "https://jira/browse/PROJ-1" },
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
    await provider.changeStatus("PROJ-1");
    expect(posted()).toContainEqual(
      expect.objectContaining({ message: "Couldn't update PROJ-1. Root Cause: Field is required." }),
    );
  });

  it("does not retry a second time", async () => {
    clientStub.getTransitions.mockResolvedValue([DONE_WITH_RESOLUTION]);
    clientStub.transition.mockRejectedValue(apiError(["Ticket cannot be closed unless Resolution will be provided"]));
    answerPicks(pickFirst, { label: "Done" }, { label: "Done" });
    const { provider, posted } = setup();
    await provider.changeStatus("PROJ-1");
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
    await provider.changeStatus("PROJ-1");
    expect(logged).toContain("changeStatus PROJ-1: can't fill Description, Environment here — letting Jira decide");
    // Still attempted, exactly as before: refusing to try would be the worse failure.
    expect(clientStub.transition).toHaveBeenCalledWith("PROJ-1", "81", {});
  });

  it("says nothing about unfillable fields when every field could be prompted", async () => {
    clientStub.getTransitions.mockResolvedValue([DONE_WITH_RESOLUTION]);
    answerPicks(pickFirst, { label: "Done" });
    const { provider, logged } = setup();
    await provider.changeStatus("PROJ-1");
    expect(logged.some((l) => l.includes("can't fill"))).toBe(false);
  });

  it("records the transport status behind a refused write, and keeps it out of the toast", async () => {
    const t = { id: "41", name: "Resolve", toName: "Done", toCategory: "done", fields: {} };
    clientStub.getTransitions.mockResolvedValue([t]);
    clientStub.transition.mockRejectedValue(apiError(["You do not have permission"]));
    answerPicks(pickFirst);
    const { provider, posted, logged } = setup();
    await provider.changeStatus("PROJ-1");
    // 403-vs-400 is "you may not" vs "that was malformed"; the prose says neither.
    expect(logged).toContain("changeStatus PROJ-1: 400 — Couldn't update PROJ-1. You do not have permission.");
    const toast = posted().find((m) => m.type === "toast" && m.level === "error") as { message: string };
    expect(toast.message).toBe("Couldn't update PROJ-1. You do not have permission.");
    expect(toast.message).not.toContain("400");
  });

  it("stays silent when the recovery prompt is cancelled", async () => {
    clientStub.getTransitions.mockResolvedValue([DONE_WITH_RESOLUTION]);
    clientStub.transition.mockRejectedValue(apiError(["Ticket cannot be closed unless Resolution will be provided"]));
    answerPicks(pickFirst, { label: "Done" }, undefined);
    const { provider, posted } = setup();
    await provider.changeStatus("PROJ-1");
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
    await send({ type: "changeStatus", key: "PROJ-1" });
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
    await send({ type: "changeStatus", key: "PROJ-1" });
    const ev = trackErrorSpy.mock.calls.flat().find((e: any) => e.name === "operation_failed") as any;
    expect(ev).toBeDefined();
    expect(ev.op).toBe("jira_write");
  });
});

describe("detail", () => {
  it("reports the issue's components and the repo → component map for every repo", async () => {
    clientStub.getDetail.mockResolvedValue({
      key: "PROJ-1",
      summary: "Do the thing",
      descriptionText: "desc",
      labels: ["webapp"],
      components: ["account-service"],
      url: "https://jira/browse/PROJ-1",
    });
    const { send, posted } = setup();
    await send({ type: "detail", key: "PROJ-1" });
    expect(posted()).toContainEqual({
      type: "detail",
      key: "PROJ-1",
      descriptionText: "desc",
      // account-service is confirmed by the ticket's component; the webapp label
      // is only a guess, so it must not ride along as pre-selected.
      inferred: ["account-service"],
      repos: ["account-service", "webapp"],
      sourceComponents: ["account-service"],
      // "webapp" is a discovered repo but not a component of PROJ → absent
      mappable: { "account-service": "account-service" },
    });
  });

  it("keeps label/text guesses in `inferred` when the ticket confirms no repo", async () => {
    clientStub.getDetail.mockResolvedValue({
      key: "PROJ-1",
      summary: "Do the thing",
      descriptionText: "desc",
      labels: ["webapp"],
      components: [],
      url: "https://jira/browse/PROJ-1",
    });
    const { send, posted } = setup();
    await send({ type: "detail", key: "PROJ-1" });
    expect(posted()).toContainEqual(expect.objectContaining({ type: "detail", key: "PROJ-1", inferred: ["webapp"] }));
  });

  it("reads the issue before the component list, so a dead token still re-gates the panel", async () => {
    clientStub.getDetail.mockRejectedValue(new JiraAuthError("nope"));
    const { send, posted } = setup();
    await send({ type: "detail", key: "PROJ-1" });
    expect(clientStub.listComponents).not.toHaveBeenCalled();
    expect(posted()).toContainEqual(expect.objectContaining({ type: "state", sourceLabel: "Jira", caps: JIRA_CAPS, authed: false }));
  });

  it("reports every chip as local-only when the project defines no components", async () => {
    clientStub.listComponents.mockResolvedValue([]);
    const { send, posted } = setup();
    await send({ type: "detail", key: "PROJ-1" });
    expect(posted()).toContainEqual(expect.objectContaining({ type: "detail", key: "PROJ-1", mappable: {} }));
  });

  // null is a distinct answer from "[]" — the read failed, not "this project has no
  // components" — so the webview must not claim any chip is local-only from it.
  it("reports mappable: null (not {}) when the component list could not be read", async () => {
    clientStub.listComponents.mockResolvedValue(null);
    const { send, posted } = setup();
    await send({ type: "detail", key: "PROJ-1" });
    expect(posted()).toContainEqual(expect.objectContaining({ type: "detail", key: "PROJ-1", mappable: null }));
  });
});

describe("setComponent", () => {
  it("adds the component under the project's spelling and echoes ok", async () => {
    clientStub.listComponents.mockResolvedValue(["Account-Service"]);
    const { send, posted } = setup();
    await send({ type: "setComponent", key: "PROJ-1", repo: "account-service", on: true, movedChip: true });
    expect(clientStub.updateComponents).toHaveBeenCalledWith("PROJ-1", { add: ["Account-Service"] });
    expect(posted()).toContainEqual({
      type: "componentsChanged", key: "PROJ-1", repo: "account-service", on: true, movedChip: true, ok: true,
    });
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "success", message: "Added Account-Service to PROJ-1" }));
  });

  it("removes the component and echoes ok", async () => {
    const { send, posted } = setup();
    await send({ type: "setComponent", key: "PROJ-1", repo: "account-service", on: false, movedChip: true });
    expect(clientStub.updateComponents).toHaveBeenCalledWith("PROJ-1", { remove: ["account-service"] });
    expect(posted()).toContainEqual({
      type: "componentsChanged", key: "PROJ-1", repo: "account-service", on: false, movedChip: true, ok: true,
    });
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "success", message: "Removed account-service from PROJ-1" }));
  });

  it("echoes movedChip: false back unchanged (a push leaves the chip where it is)", async () => {
    const { send, posted } = setup();
    await send({ type: "setComponent", key: "PROJ-1", repo: "account-service", on: true, movedChip: false });
    expect(posted()).toContainEqual({
      type: "componentsChanged", key: "PROJ-1", repo: "account-service", on: true, movedChip: false, ok: true,
    });
  });

  it("stamps the provenance label", async () => {
    const { send } = setup();
    await send({ type: "setComponent", key: "PROJ-1", repo: "account-service", on: true, movedChip: true });
    expect(clientStub.addLabel).toHaveBeenCalledWith("PROJ-1", "claude-code");
  });

  it("skips the label stamp when stampLabelOnWrite is off", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, stampLabelOnWrite: false });
    const { send } = setup();
    await send({ type: "setComponent", key: "PROJ-1", repo: "account-service", on: true, movedChip: true });
    expect(clientStub.addLabel).not.toHaveBeenCalled();
  });

  it("still succeeds when the label stamp fails", async () => {
    clientStub.addLabel.mockRejectedValue(new Error("label 500"));
    const { send, posted } = setup();
    await send({ type: "setComponent", key: "PROJ-1", repo: "account-service", on: true, movedChip: true });
    expect(posted()).toContainEqual(expect.objectContaining({ type: "componentsChanged", ok: true }));
  });

  // A 400, not a 403: `JiraClient.request` converts every 401 *and* 403 into
  // JiraAuthError, so a permission refusal re-gates the panel and never reaches
  // this branch. The reachable JiraApiError here is a rejected component name —
  // e.g. one that vanished from the project since the cache was filled.
  it("echoes ok: false with an actionable toast when Jira rejects the write", async () => {
    clientStub.updateComponents.mockRejectedValue(parseJiraError(400, JSON.stringify({ errorMessages: ["Component name is not valid"], errors: {} })));
    const { send, posted } = setup();
    await send({ type: "setComponent", key: "PROJ-1", repo: "account-service", on: true, movedChip: true });
    expect(posted()).toContainEqual({
      type: "componentsChanged", key: "PROJ-1", repo: "account-service", on: true, movedChip: true, ok: false,
    });
    expect(posted()).toContainEqual(expect.objectContaining({
      type: "toast", level: "error", action: { label: "Open in Jira", url: "https://jira/browse/PROJ-1" },
    }));
    expect(clientStub.addLabel).not.toHaveBeenCalled();
  });

  // Covers a permission refusal too: request() converts every 401 and 403 into
  // JiraAuthError, so this is the branch a refused write actually takes.
  it("echoes ok: false and re-gates the panel on an auth failure, posting no toast", async () => {
    clientStub.updateComponents.mockRejectedValue(new JiraAuthError("token dead"));
    const { send, posted } = setup();
    await send({ type: "setComponent", key: "PROJ-1", repo: "account-service", on: true, movedChip: true });
    expect(posted()).toContainEqual(expect.objectContaining({ type: "componentsChanged", ok: false }));
    expect(posted()).toContainEqual(expect.objectContaining({ type: "state", sourceLabel: "Jira", caps: JIRA_CAPS, authed: false }));
    // Re-gating to the sign-in screen is itself the indication — a toast on top
    // would be noise, and the panel is already replaced.
    expect(posted().filter((p) => p.type === "toast")).toEqual([]);
  });

  it("writes nothing and echoes ok: false when the project has no such component", async () => {
    clientStub.listComponents.mockResolvedValue(["Infra"]);
    const { send, posted } = setup();
    await send({ type: "setComponent", key: "PROJ-1", repo: "scratch-tool", on: true, movedChip: true });
    expect(clientStub.updateComponents).not.toHaveBeenCalled();
    expect(posted()).toContainEqual(expect.objectContaining({ type: "componentsChanged", ok: false }));
    expect(posted()).toContainEqual(expect.objectContaining({
      type: "toast", level: "error", message: "PROJ has no component named “scratch-tool”.",
    }));
  });

  // An empty list is a real answer under the new contract — the project genuinely
  // defines no components — so an unmapped repo gets the ordinary "no such
  // component" message, same as any other repo the project doesn't recognize.
  it("blames the repo, not the connection, when the project defines no components", async () => {
    clientStub.listComponents.mockResolvedValue([]);
    const { send, posted } = setup();
    await send({ type: "setComponent", key: "PROJ-1", repo: "account-service", on: true, movedChip: true });
    expect(clientStub.updateComponents).not.toHaveBeenCalled();
    expect(posted()).toContainEqual(expect.objectContaining({ type: "componentsChanged", ok: false }));
    expect(posted()).toContainEqual(expect.objectContaining({
      type: "toast", level: "error", message: "PROJ has no component named “account-service”.",
    }));
  });

  // A `null` list is the failed read — not the same claim as "no such component",
  // and blaming the repo name for it would send the user looking in the wrong place.
  it("blames the connection, not the repo, when the component list could not be read", async () => {
    clientStub.listComponents.mockResolvedValue(null);
    const { send, posted } = setup();
    await send({ type: "setComponent", key: "PROJ-1", repo: "account-service", on: true, movedChip: true });
    expect(clientStub.updateComponents).not.toHaveBeenCalled();
    expect(posted()).toContainEqual(expect.objectContaining({ type: "componentsChanged", ok: false }));
    expect(posted()).toContainEqual(expect.objectContaining({
      type: "toast", level: "error",
      message: "Couldn't read PROJ's components from Jira. Check the connection and try again.",
    }));
  });

  it("echoes ok: false and re-gates when not signed in, without touching Jira", async () => {
    const { send, posted } = setup({ authed: false });
    await send({ type: "setComponent", key: "PROJ-1", repo: "account-service", on: true, movedChip: true });
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
    await send({ type: "setComponent", key: "PROJ-1", repo: "account-service", on: true, movedChip: true });
    expect(clientStub.updateComponents).not.toHaveBeenCalled();
    expect(posted().filter((p) => p.type === "componentsChanged")).toEqual([
      { type: "componentsChanged", key: "PROJ-1", repo: "account-service", on: true, movedChip: true, ok: false },
    ]);
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "error", message: "keychain locked" }));
  });

  // Pins the idempotent echo guard: a normal successful call must post the verdict
  // exactly once, not merely at least once.
  it("posts exactly one componentsChanged on an ordinary successful call", async () => {
    const { send, posted } = setup();
    await send({ type: "setComponent", key: "PROJ-1", repo: "account-service", on: true, movedChip: true });
    expect(posted().filter((p) => p.type === "componentsChanged")).toHaveLength(1);
  });
});

describe("addToMySprint", () => {
  it("errors when the account cannot be resolved", async () => {
    clientStub.getMyself.mockResolvedValue(null);
    const { provider, posted } = setup();
    await provider.addToMySprint("PROJ-1");
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "error" }));
    expect(clientStub.addIssueToSprint).not.toHaveBeenCalled();
  });

  it("errors before the sprint-add when the identity has no usable id", async () => {
    // `me()` can now answer with a display name and no id (see JiraProvider.me). That
    // is enough to render, not enough to assign with — so this pair has to stop at the
    // toast rather than add to the sprint and then fail the assignment.
    clientStub.getMyself.mockResolvedValue({ accountId: "", displayName: "Jane" });
    const { provider, posted } = setup();
    await provider.addToMySprint("PROJ-1");
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "error" }));
    expect(clientStub.addIssueToSprint).not.toHaveBeenCalled();
    expect(clientStub.assignIssue).not.toHaveBeenCalled();
  });

  it("errors when there is no active sprint", async () => {
    clientStub.getActiveSprintId.mockResolvedValue(null);
    const { provider, posted } = setup();
    await provider.addToMySprint("PROJ-1");
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "error" }));
    expect(clientStub.addIssueToSprint).not.toHaveBeenCalled();
  });

  it("adds to sprint, assigns, stamps the label, and reports removal from unassigned", async () => {
    const { provider, posted, send } = setup();
    await send({ type: "fetch", filter: "unassigned", size: "any" }); // lastFilter = unassigned
    await provider.addToMySprint("PROJ-1");
    expect(clientStub.addIssueToSprint).toHaveBeenCalledWith(42, "PROJ-1");
    expect(clientStub.assignIssue).toHaveBeenCalledWith("PROJ-1", "a1");
    // ONE identity lookup for the pair, not one per write. Two would not merely cost a
    // request: a second lookup answering null after the sprint-add succeeded would
    // throw, leaving the task in the sprint and unassigned — a state one lookup makes
    // unreachable.
    expect(clientStub.getMyself).toHaveBeenCalledTimes(1);
    expect(clientStub.addLabel).toHaveBeenCalledWith("PROJ-1", "claude-code");
    expect(posted()).toContainEqual({ type: "movedToSprint", key: "PROJ-1", assignee: "Jane", removed: true });
  });
});

describe("removeFromSprint", () => {
  it("moves to backlog, stamps the label, prunes saved order, and posts removedFromSprint", async () => {
    const { provider, posted, workspaceState } = setup({
      workspaceState: { "agentFlow.sprintOrder": ["PROJ-1", "PROJ-2"] },
    });
    await provider.removeFromSprint("PROJ-1", "any");
    expect(clientStub.removeIssueFromSprint).toHaveBeenCalledWith("PROJ-1");
    expect(clientStub.addLabel).toHaveBeenCalledWith("PROJ-1", "claude-code");
    expect(workspaceState.update).toHaveBeenCalledWith("agentFlow.sprintOrder", ["PROJ-2"]);
    expect(posted()).toContainEqual({ type: "removedFromSprint", key: "PROJ-1" });
  });

  it("skips the label stamp when stampLabelOnWrite is off", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, stampLabelOnWrite: false });
    const { provider } = setup();
    await provider.removeFromSprint("PROJ-1", "any");
    expect(clientStub.addLabel).not.toHaveBeenCalled();
  });

  it("does not remove the card when the backlog write fails", async () => {
    clientStub.removeIssueFromSprint.mockRejectedValue(new Error("boom"));
    const { send, posted } = setup();
    await send({ type: "removeFromSprint", key: "PROJ-1", size: "any" });
    expect(posted()).not.toContainEqual(expect.objectContaining({ type: "removedFromSprint" }));
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "error" }));
  });

  it("re-adds to the active sprint and refetches when Undo is chosen", async () => {
    vi.mocked(window.showInformationMessage).mockResolvedValue("Undo");
    const { provider, posted } = setup();
    await provider.removeFromSprint("PROJ-1", "any");
    expect(clientStub.getActiveSprintId).toHaveBeenCalled();
    expect(clientStub.addIssueToSprint).toHaveBeenCalledWith(42, "PROJ-1");
    expect(posted()).toContainEqual(expect.objectContaining({ type: "tasks", filter: "mysprint" }));
  });
});

describe("explore", () => {
  it("prompts for an action when exploreMode is 'ask' and seeds the chosen action's prompt", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "ask" });
    const repos = mkRepos(["account-service", "webapp"]);
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
    const repos = mkRepos(["account-service", "webapp"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("retry banner");
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ label: "staging", env: "staging" } as never) // env picker
      .mockResolvedValueOnce([{ repo: repos[0] }, { repo: repos[1] }] as never); // repo picker
    const { send } = setup();
    await send({ type: "explore" });
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        promptTemplate: "VER {summary} on staging for account-service, webapp{files}",
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
        key: "PROJ-9",
        summary: "Fix retry bug",
        url: "https://jira/PROJ-9",
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
          "- **PROJ-9** (task) — Fix retry bug — `/repos/svc` (branch: fix/retry) — idle, no session attached",
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

describe("explore telemetry", () => {
  const names = () => trackSpy.mock.calls.flat().map((e: any) => e.name);
  const events = () => trackSpy.mock.calls.flat() as any[];
  const find = (n: string) => events().find((e) => e.name === n);

  it("emits explore_started then explore_completed, sharing one flow_id, with the seeded provider on success", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "jiraTicket" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("focus");
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { send } = setup();
    await send({ type: "explore" });

    expect(find("explore_started")).toMatchObject({ flow_id: "flow-1", mode: "jiraTicket", source: "command" });
    expect(find("explore_completed")).toMatchObject({
      flow_id: "flow-1", outcome: "launched", mode: "jiraTicket",
      provider: "claude-code", repo_count: 1, duration_ms: 42,
    });
  });

  it("emits only explore_completed with cancel_point 'remote-control' and the configured mode when the RC block refuses", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, remoteControl: "on", agentProvider: "copilot", exploreMode: "knowledge" });
    const { send } = setup();
    await send({ type: "explore" });
    expect(names()).not.toContain("explore_started");
    expect(find("explore_completed")).toMatchObject({ outcome: "cancelled", cancel_point: "remote-control", mode: "knowledge", repo_count: 0 });
  });

  it("emits only explore_completed with cancel_point 'repos' and the configured mode when no repos are found", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "debug" });
    vi.mocked(discoverRepos).mockReturnValue([]);
    const { send } = setup();
    await send({ type: "explore" });
    expect(names()).not.toContain("explore_started");
    expect(find("explore_completed")).toMatchObject({ outcome: "cancelled", cancel_point: "repos", mode: "debug", repo_count: 0 });
  });

  it("emits only explore_completed with cancel_point 'action' and mode 'custom' ('ask' collapsed) when the action picker is cancelled", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "ask" });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined); // cancel action pick
    const { send } = setup();
    await send({ type: "explore" });
    expect(names()).not.toContain("explore_started");
    expect(find("explore_completed")).toMatchObject({ outcome: "cancelled", cancel_point: "action", mode: "custom", repo_count: 0 });
  });

  it("fires explore_started only once a mode exists, carrying the picked mode — not the configured one", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "ask" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("focus");
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ action: CFG.exploreActions[2] } as never) // action picker → Debug
      .mockResolvedValueOnce([{ repo: repos[0] }] as never); // repo picker
    const { send } = setup();
    await send({ type: "explore" });

    const startedIdx = events().findIndex((e) => e.name === "explore_started");
    expect(startedIdx).toBeGreaterThan(-1);
    expect(events()[startedIdx].mode).toBe("debug");
    // Nothing before explore_started is an explore_completed — the two pre-mode
    // early exits are the only ones allowed to precede a start, and this run never
    // hits either.
    expect(events().slice(0, startedIdx).some((e) => e.name === "explore_completed")).toBe(false);
  });

  it("cancels with cancel_point 'topic' when the focus input box is dismissed", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "debug" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce(undefined);
    const { send } = setup();
    await send({ type: "explore" });
    expect(find("explore_started")).toMatchObject({ mode: "debug" });
    expect(find("explore_completed")).toMatchObject({ outcome: "cancelled", cancel_point: "topic", mode: "debug", repo_count: 0 });
  });

  it("cancels with cancel_point 'env' when the environment picker is dismissed", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "verify" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("retry banner");
    vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined as never); // cancel env pick
    const { send } = setup();
    await send({ type: "explore" });
    expect(find("explore_completed")).toMatchObject({ outcome: "cancelled", cancel_point: "env", mode: "verify", repo_count: 0 });
  });

  it("cancels with cancel_point 'kickoff' when the open-target picker is dismissed", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask", exploreMode: "knowledge" });
    vi.mocked(window.showInputBox).mockResolvedValueOnce("x");
    vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined as never); // cancel open-target pick
    const { send } = setup();
    await send({ type: "explore" });
    expect(find("explore_completed")).toMatchObject({ outcome: "cancelled", cancel_point: "kickoff", mode: "knowledge", repo_count: 0 });
  });

  it("cancels with cancel_point 'agent' and the resolved repo_count when the agent picker is dismissed", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "knowledge" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("x");
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never);
    vi.mocked(openWorkspace).mockResolvedValue({
      mode: "per-window", briefs: [], opened: [], remoteControl: false, provider: "claude-code", cancelled: true,
    });
    const { send } = setup();
    await send({ type: "explore" });
    expect(find("explore_completed")).toMatchObject({ outcome: "cancelled", cancel_point: "agent", mode: "knowledge", repo_count: 1 });
  });

  it("carries env_picked 'listed' vs 'custom' on a successful verify launch", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "verify" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("retry banner");
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ label: "staging", env: "staging" } as never) // env picker (listed)
      .mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { send } = setup();
    await send({ type: "explore" });
    expect(find("explore_completed")).toMatchObject({ outcome: "launched", env_picked: "listed" });
  });

  it("marks a typed environment as env_picked 'custom'", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "verify" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox)
      .mockResolvedValueOnce("retry banner")
      .mockResolvedValueOnce("staging-eu");
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ label: "$(edit) Custom…" } as never)
      .mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { send } = setup();
    await send({ type: "explore" });
    expect(find("explore_completed")).toMatchObject({ outcome: "launched", env_picked: "custom" });
  });

  it("never sends the typed topic string", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "jiraTicket" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("SECRET-TOPIC");
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { send } = setup();
    await send({ type: "explore" });
    expect(JSON.stringify(events())).not.toContain("SECRET-TOPIC");
  });

  // Mirrors takeWithFailingLaunch / "reports failed with a failure class when the
  // launch throws" (tasksView.test.ts:2842-2906): proves explore()'s own try/catch —
  // added specifically to give the funnel a terminator on a thrown failure, and to
  // guard the reordering fix that made the success track() call the LAST statement
  // in its branch — actually fires exactly once, with outcome "failed" and a
  // failure_class, and that the error still propagates for onMessage's existing
  // catch (tasksView.ts:255) to handle.
  it("reports failed with a failure class when openWorkspace throws, emits explore_completed exactly once, and still propagates the error", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "jiraTicket" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("focus");
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never);
    vi.mocked(openWorkspace).mockRejectedValueOnce(new Error("disk full"));
    const { provider } = setup();

    await expect((provider as unknown as { explore: () => Promise<void> }).explore()).rejects.toThrow("disk full");

    const completedEvents = events().filter((e) => e.name === "explore_completed");
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]).toMatchObject({ flow_id: "flow-1", outcome: "failed", mode: "jiraTicket", repo_count: 1 });
    expect(completedEvents[0].failure_class).toBeDefined();
    // The action WAS picked before openWorkspace threw, so explore_started fired once
    // (and only once) ahead of the single explore_completed above.
    expect(names().filter((n: string) => n === "explore_started")).toHaveLength(1);
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
    expect(posted()).toContainEqual({ type: "state", sourceLabel: "Jira", agentLabel: "Claude Code", caps: JIRA_CAPS, authed: false, configured: true, project: "PROJ", me: null, prReviewStatus: "PR initiated", filters: { size: true, status: true, repo: true, search: true }, liveCount: 0 });
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
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        ticket: expect.objectContaining({ key: "PROJ-1" }),
        promptTemplate: "P {key}",
        services: [expect.objectContaining({ name: "account-service" })],
      }),
    );
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "success" }));
  });

  it("still says Claude Code pre-seeded by default", async () => {
    const { provider, posted } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(posted()).toContainEqual(
      expect.objectContaining({
        type: "toast", level: "success",
        message: expect.stringContaining("Claude Code pre-seeded — press Enter to start."),
      }),
    );
  });

  it("names Claude Code in the pre-seeded toast under `ask`", async () => {
    // The toast reads "<summary>. <agent> pre-seeded — press Enter to start.", so a
    // phrase here lands lowercase at a sentence start: "…window. your coding agent
    // pre-seeded". It has to be a product name.
    vi.mocked(getConfig).mockReturnValue({ ...CFG, agentProvider: "ask" });
    const { provider, posted } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(posted()).toContainEqual(
      expect.objectContaining({
        type: "toast", level: "success",
        message: expect.stringContaining("Claude Code pre-seeded — press Enter to start."),
      }),
    );
  });

  it("names Copilot in the pre-seeded toast", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, agentProvider: "copilot" });
    const { provider, posted } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(posted()).toContainEqual(
      expect.objectContaining({
        type: "toast", level: "success",
        message: expect.stringContaining("Copilot pre-seeded — press Enter to start."),
      }),
    );
  });

  it("errors when no repos are checked out", async () => {
    vi.mocked(discoverRepos).mockReturnValue([]);
    const { provider, posted } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "error" }));
  });

  it("aborts when sign-in is declined", async () => {
    vi.mocked(commands.executeCommand).mockResolvedValue(false);
    const { provider } = setup({ authed: false });
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it("confirms repos via QuickPick when none are preselected", async () => {
    const repos = mkRepos(["account-service", "webapp"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { provider } = setup();
    await provider.takeTask("PROJ-1", "command");
    expect(openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ services: [repos[0]] }));
  });

  it("lists the pre-checked repos first, keeping discovery order within each group", async () => {
    const repos = mkRepos(["aardvark-service", "billing-service", "webapp", "delta-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    clientStub.getDetail.mockResolvedValue({
      key: "PROJ-1",
      summary: "Do the thing",
      descriptionText: "desc",
      labels: ["billing-service"],
      components: ["delta-service"],
      url: "https://jira/browse/PROJ-1",
    });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[1] }] as never);
    const { provider } = setup();
    await provider.takeTask("PROJ-1", "command");
    const items = vi.mocked(window.showQuickPick).mock.calls[0][0] as { label: string; picked: boolean }[];
    // Inference order would put delta-service (component) ahead of billing-service
    // (label); the partition keeps discovery order inside each group instead.
    expect(items.map((i) => i.label)).toEqual(["billing-service", "delta-service", "aardvark-service", "webapp"]);
    // Only delta-service is confirmed on the ticket; the billing-service label is a
    // guess — listed with the inferred group, but not pre-checked.
    expect(items.map((i) => i.picked)).toEqual([false, true, false, false]);
  });

  it("aborts when the repo QuickPick is cancelled", async () => {
    vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined);
    const { provider } = setup();
    await provider.takeTask("PROJ-1", "command");
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it("prompts for a mode when taskMode is 'ask'", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, taskMode: "ask" });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ mode: CFG.promptModes[0] } as never);
    const { provider } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
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
    await provider.takeTask("PROJ-1", "card", ["account-service"]);

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
    await provider.takeTask("PROJ-1", "card", ["account-service"]);

    const items = vi.mocked(window.showQuickPick).mock.calls[0][0] as { detail?: string }[];
    expect(items[0].detail).toBeUndefined();
  });

  it("asks the prompt mode first — a cancel there aborts before the ticket is read", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, taskMode: "ask" });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined); // cancel the prompt-mode pick
    const { provider } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(clientStub.getDetail).not.toHaveBeenCalled(); // aborted before resolveKickoff read the ticket
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it("creates worktrees when worktree=always", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, worktree: "always" });
    const { provider } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(createWorktrees).toHaveBeenCalled();
  });

  it("creates worktrees when the worktree prompt is accepted", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, worktree: "ask" });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ yes: true } as never);
    const { provider } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(createWorktrees).toHaveBeenCalled();
  });

  it("asks how to open multiple repos when workspaceMode is 'ask'", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, workspaceMode: "ask" });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ mode: "multiroot" } as never);
    const { provider } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service", "webapp"]);
    expect(openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ mode: "multiroot" }));
  });

  it("reports the generated workspace file in the success toast", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, workspaceMode: "multiroot" });
    vi.mocked(openWorkspace).mockResolvedValue({
      mode: "multiroot",
      workspaceFile: "/ws/PROJ-1.code-workspace",
      briefs: [],
      opened: ["/ws/PROJ-1.code-workspace"],
      remoteControl: false,
      provider: "claude-code",
    });
    const { provider, posted } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service", "webapp"]);
    const toast = posted().find((m) => m.type === "toast") as { message: string };
    expect(toast.message).toContain(".code-workspace");
  });

  describe("existing workspace open target", () => {
    it("picks 'New window' from the 3-way picker without touching the workspace picker", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask" });
      vi.mocked(window.showQuickPick).mockResolvedValueOnce({ target: { kind: "new" } } as never);

      const { provider } = setup();
      await provider.takeTask("PROJ-1", "card", ["account-service"]);

      expect(listWorkspaceFiles).not.toHaveBeenCalled();
      expect(openWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ openIn: "new", existingWorkspaceFile: undefined }),
      );
    });

    it("aborts the take when the 3-way open-target picker is cancelled", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask" });
      vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined as never);

      const { provider } = setup();
      await provider.takeTask("PROJ-1", "card", ["account-service"]);

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
      await provider.takeTask("PROJ-1", "card", ["account-service"]);

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
      await provider.takeTask("PROJ-1", "card", ["account-service"]);

      expect(openWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ existingWorkspaceFile: "/elsewhere/x.code-workspace" }),
      );
    });

    it("aborts the take when the workspace picker is cancelled", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "pick-existing" });
      vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined as never);

      const { provider } = setup();
      await provider.takeTask("PROJ-1", "card", ["account-service"]);

      expect(openWorkspace).not.toHaveBeenCalled();
    });

    it("aborts the take when Browse… is chosen but the file dialog is cancelled", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "pick-existing" });
      vi.mocked(window.showQuickPick).mockResolvedValueOnce({ file: "__browse__" } as never);
      vi.mocked(window.showOpenDialog).mockResolvedValueOnce(undefined);

      const { provider } = setup();
      await provider.takeTask("PROJ-1", "card", ["account-service"]);

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
      await provider.takeTask("PROJ-1", "card", ["account-service"]);

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
      await provider.takeTask("PROJ-1", "card", ["account-service"]);

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
      await provider.takeTask("PROJ-1", "card", ["account-service"]);

      const items = vi.mocked(window.showQuickPick).mock.calls[0][0] as { label: string }[];
      expect(items.some((i) => i.label.includes("This window"))).toBe(false);
    });

    it("passes this window through to openWorkspace for target 'current'", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "this-window" });
      vi.mocked(currentWindow).mockReturnValue(HERE);

      const { provider } = setup();
      await provider.takeTask("PROJ-1", "card", ["account-service"]);

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
      await provider.takeTask("PROJ-1", "card", ["account-service"]);

      expect(openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ mode: "multiroot" }));
    });

    it("falls back to a new window when the this-window setting has no window to use", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "this-window" });
      vi.mocked(currentWindow).mockReturnValue(undefined);

      const { provider, posted } = setup();
      await provider.takeTask("PROJ-1", "card", ["account-service"]);

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
      await provider.takeTask("PROJ-1", "card", ["account-service"]);

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
      await provider.takeTask("PROJ-1", "card", ["account-service"]);

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
      await provider.takeTask("PROJ-1", "card", ["account-service"]);

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
        provider: "claude-code",
      });

      const { provider, posted } = setup();
      await provider.takeTask("PROJ-1", "card", ["account-service"]);

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
        provider: "claude-code",
      });

      const { provider, posted } = setup();
      await provider.takeTask("PROJ-1", "card", ["account-service"]);

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
        duplicates: [{ label: "account-service", repoName: "account-service", path: "/repos/account-service/.claude/worktrees/PROJ-1" }],
        redundant: [],
        present: [],
        ok: true,
      });
      vi.mocked(window.showQuickPick).mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never);

      const { provider } = setup();
      await provider.takeTask("PROJ-1", "card", ["account-service"]);

      // Exactly one quick-pick fired: the workspace-file picker. No add-prompt.
      expect(window.showQuickPick).toHaveBeenCalledTimes(1);
      expect(openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ foldersToAdd: [] }));
    });

    it("offers a worktree candidate under its <repo>-<KEY> label, not the bare repo name", async () => {
      pickExisting();
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "pick-existing", worktree: "always" });
      // A successful worktree returns a path below the checkout; the identity default
      // this describe inherits would leave the candidate looking like a main checkout.
      vi.mocked(createWorktrees).mockImplementationOnce((s, key) =>
        s.map((r) => ({ ...r, path: `${r.path}/.claude/worktrees/${key}` })),
      );
      vi.mocked(window.showQuickPick).mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never);

      const { provider } = setup();
      await provider.takeTask("PROJ-1", "card", ["account-service"]);

      // `repoName` stays bare: it drives the dedup and the prompt copy, not the row.
      expect(planWorkspaceMerge).toHaveBeenCalledWith("/ws/team.code-workspace", [
        {
          label: "account-service-PROJ-1",
          repoName: "account-service",
          path: "/repos/account-service/.claude/worktrees/PROJ-1",
        },
      ]);
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
      await provider.takeTask("PROJ-1", "card", ["account-service"]);

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
      await provider.takeTask("PROJ-1", "card", ["account-service"]);

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
        provider: "claude-code",
      });

      const { provider, posted } = setup();
      await provider.takeTask("PROJ-1", "card", ["account-service"]);

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
        provider: "claude-code",
      });

      const { provider, posted } = setup();
      await provider.takeTask("PROJ-1", "card", ["account-service"]);

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
      await provider.takeTask("PROJ-1", "card", ["account-service"]);

      expect(openWorkspace).toHaveBeenCalled();
      expect(openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ foldersToAdd: [] }));
    });

    it("does not prompt when the workspace file can't be parsed", async () => {
      pickExisting();
      vi.mocked(planWorkspaceMerge).mockReturnValue({ add: [], duplicates: [], redundant: [], present: [], ok: false });
      vi.mocked(window.showQuickPick).mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never);

      const { provider } = setup();
      await provider.takeTask("PROJ-1", "card", ["account-service"]);

      expect(window.showQuickPick).toHaveBeenCalledTimes(1);
      expect(openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ foldersToAdd: [] }));
    });

    it("names skipped duplicates in the success toast", async () => {
      pickExisting();
      vi.mocked(planWorkspaceMerge).mockReturnValue({
        add: [],
        duplicates: [{ label: "account-service", repoName: "account-service", path: "/repos/account-service/.claude/worktrees/PROJ-1" }],
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
        provider: "claude-code",
      });

      const { provider, posted } = setup();
      await provider.takeTask("PROJ-1", "card", ["account-service"]);

      const toast = posted().find((m) => m.type === "toast") as { level: string; message: string };
      expect(toast.level).toBe("success");
      expect(toast.message).toContain("account-service");
      expect(toast.message).toMatch(/already in the workspace/i);
    });

    it("passes no foldersToAdd for a new-window destination", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "new-window" });
      const { provider } = setup();
      await provider.takeTask("PROJ-1", "card", ["account-service"]);
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
      await provider.takeTask("PROJ-1", "card", ["account-service"]);

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
          { label: "api", repoName: "api", path: "/repos/api/.claude/worktrees/PROJ-1" },
          { label: "web", repoName: "web", path: "/repos/web/.claude/worktrees/PROJ-1" },
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
        provider: "claude-code",
      });

      const { provider, posted } = setup();
      await provider.takeTask("PROJ-1", "card", ["account-service"]);

      const toast = posted().find((m) => m.type === "toast") as { message: string };
      expect(toast.message).toContain("api, web already in the workspace");
    });
  });

  describe("destinations that already have folders skip the repo picker", () => {
    it("uses the existing workspace's repos and never shows the service pick", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask" });
      vi.mocked(workspaceFolderPaths).mockReturnValue(["/repos/webapp"]);
      vi.mocked(listWorkspaceFiles).mockReturnValue([{ file: "/ws/team.code-workspace", folders: 1, mtimeMs: 1 }]);
      // Destination picks only: open-target pick → workspace-file pick. No service pick follows.
      vi.mocked(window.showQuickPick)
        .mockResolvedValueOnce({ target: { kind: "existing-pick" } } as never)
        .mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never);

      const { provider } = setup();
      await provider.takeTask("PROJ-1", "command"); // no preselected repos

      expect(window.showQuickPick).toHaveBeenCalledTimes(2); // no third (service) pick
      expect(openWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          existingWorkspaceFile: "/ws/team.code-workspace",
          services: [expect.objectContaining({ name: "webapp", path: "/repos/webapp" })],
        }),
      );
    });

    it("builds a ServiceRef from a live folder that lives outside reposRoot", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask" });
      vi.mocked(window.showQuickPick).mockResolvedValueOnce(
        { target: { kind: "live-folder", folder: "/other/legacy-app" } } as never,
      );

      const { provider } = setup();
      await provider.takeTask("PROJ-1", "command"); // no preselected repos

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
      vi.mocked(workspaceFolderPaths).mockReturnValue(["/repos/webapp"]);
      vi.mocked(listWorkspaceFiles).mockReturnValue([{ file: "/ws/team.code-workspace", folders: 1, mtimeMs: 1 }]);
      vi.mocked(window.showQuickPick)
        .mockResolvedValueOnce({ target: { kind: "existing-pick" } } as never)
        .mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never);

      const { provider } = setup();
      await provider.takeTask("PROJ-1", "card", ["account-service"]); // preselected wins

      expect(openWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          existingWorkspaceFile: "/ws/team.code-workspace",
          services: [expect.objectContaining({ name: "account-service" })],
        }),
      );
    });

    // "This window" is a promise about where the work happens — the folders already open
    // here ARE the repo set, so a confirm pick would ask a question already answered.
    it("uses this window's folders and never shows the repo confirm pick", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "this-window" });
      vi.mocked(currentWindow).mockReturnValue({
        identity: "/repos/webapp",
        kind: "folder",
        roots: [{ name: "webapp", path: "/repos/webapp" }],
      });

      const { provider } = setup();
      await provider.takeTask("PROJ-1", "command"); // no preselected repos

      expect(window.showQuickPick).not.toHaveBeenCalled();
      expect(openWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          openIn: "current",
          services: [expect.objectContaining({ name: "webapp", path: "/repos/webapp" })],
        }),
      );
    });

    it("takes every folder of a multi-root window, not just the inferred repo", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "this-window" });
      vi.mocked(currentWindow).mockReturnValue({
        identity: "/ws/team.code-workspace",
        kind: "workspace",
        roots: [
          { name: "webapp", path: "/repos/webapp" },
          { name: "account-service", path: "/repos/account-service" },
        ],
      });

      const { provider } = setup();
      await provider.takeTask("PROJ-1", "command");

      const services = vi.mocked(openWorkspace).mock.calls.at(-1)![0].services;
      expect(services.map((s) => s.path)).toEqual(["/repos/webapp", "/repos/account-service"]);
    });

    // The two currentWindow() reads aren't atomic (see the race test above). Losing the
    // identity mid-flight leaves no folders to infer from, so the confirm pick has to
    // come back rather than the take dead-ending on "no valid repos".
    it("falls back to the confirm pick when this window loses its folders after the pick", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "this-window" });
      vi.mocked(currentWindow)
        .mockReturnValueOnce({ identity: "/repos/webapp", kind: "folder", roots: [{ name: "webapp", path: "/repos/webapp" }] })
        .mockReturnValue(undefined);
      vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined as never); // cancel the confirm pick

      const { provider } = setup();
      await provider.takeTask("PROJ-1", "command");

      expect(vi.mocked(window.showQuickPick).mock.calls[0][1]).toEqual(
        expect.objectContaining({ title: "PROJ-1 — confirm the repos this task touches" }),
      );
      expect(openWorkspace).not.toHaveBeenCalled();
    });

    it("aborts when the existing workspace resolves to no repos", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "pick-existing" });
      vi.mocked(workspaceFolderPaths).mockReturnValue([]);
      vi.mocked(listWorkspaceFiles).mockReturnValue([{ file: "/ws/empty.code-workspace", folders: 0, mtimeMs: 1 }]);
      vi.mocked(window.showQuickPick).mockResolvedValueOnce({ file: "/ws/empty.code-workspace" } as never);

      const { provider, posted } = setup();
      await provider.takeTask("PROJ-1", "command"); // no preselected repos

      expect(openWorkspace).not.toHaveBeenCalled();
      expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "error" }));
    });
  });
});

describe("Take funnel", () => {
  /** Drives a Take to a successful launch using a realistic ticket key and repo
   * name (not the generic "PROJ-1"/"account-service" this file uses elsewhere) so
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
    // inferred_count on take_started was Phase 1's fidelity bug (follow-ups doc,
    // item 2): inference hasn't run yet at that point, and hard-coding it to 0
    // silently corrupted any chart grouping by that name across the funnel.
    expect("inferred_count" in started).toBe(false);
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
    // prompt_mode must be ABSENT when the Take was cancelled before a mode was chosen —
    // "custom" here was Phase 1's fidelity bug (follow-ups doc, item 3).
    expect("prompt_mode" in (trackSpy.mock.calls.flat().at(-1) as any)).toBe(false);
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
    const repos = mkRepos(["acme-billing", "webapp"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined); // cancel launch()'s workspace-mode picker
    const { provider } = setup();
    await provider.takeTask("BILL-1234", "card", ["acme-billing", "webapp"]);
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

  it("pre-checks only ticket-confirmed repos in the confirm QuickPick; a label guess stays listed unchecked", async () => {
    const repos = mkRepos(["acme-billing", "webapp"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    clientStub.getDetail.mockResolvedValue({
      key: "BILL-1234",
      summary: "Fix the billing thing",
      descriptionText: "desc",
      labels: ["webapp"], // a guess — must not be pre-checked
      components: ["acme-billing"], // confirmed on the ticket
      url: "https://jira/browse/BILL-1234",
    });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { provider } = setup();
    await provider.takeTask("BILL-1234", "command");
    const call = vi.mocked(window.showQuickPick).mock.calls.find((c) =>
      String((c[1] as { title?: string } | undefined)?.title).includes("confirm the repos"),
    )!;
    const items = (await call[0]) as { label: string; picked: boolean; description: string }[];
    const byLabel = new Map(items.map((i) => [i.label, i]));
    expect(byLabel.get("acme-billing")!.picked).toBe(true);
    expect(byLabel.get("webapp")!.picked).toBe(false);
    // Still surfaced as a suggestion — just not attached without a say-so.
    expect(byLabel.get("webapp")!.description).toBe("inferred (label)");
    // Accepting the pre-checked set as-is counts as accepting the inference.
    const picked = trackSpy.mock.calls.flat().find((e: any) => e.name === "take_repos_picked") as any;
    expect(picked.inferred_count).toBe(1);
    expect(picked.accepted_inference).toBe(true);
  });

  it("marks accepted_inference false when the confirmed repo count differs from inference", async () => {
    const repos = mkRepos(["acme-billing", "webapp"]);
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

  it("marks accepted_inference false on a same-count swap (inferred acme-billing, user picks webapp instead)", async () => {
    const repos = mkRepos(["acme-billing", "webapp"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    clientStub.getDetail.mockResolvedValue({
      key: "BILL-1234",
      summary: "Fix the billing thing",
      descriptionText: "desc",
      labels: [],
      components: ["acme-billing"], // inference proposes acme-billing only
      url: "https://jira/browse/BILL-1234",
    });
    // Confirms webapp instead — same count (1) as inferred, but a different repo.
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
    // JiraApiError carries a numeric `.status`, which classifyFailure now reads
    // arms-length alongside `.code` (follow-ups doc, item 1) — a 404 classifies
    // as not_found rather than falling into the catch-all class.
    expect(done.failure_class).toBe("not_found");
  });

  it("reports take_repos_picked and take_completed with the real repo_count", async () => {
    const repos = mkRepos(["acme-billing", "webapp"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    const { provider } = setup();
    await provider.takeTask("BILL-1234", "card", ["acme-billing", "webapp"]);
    const picked = trackSpy.mock.calls.flat().find((e: any) => e.name === "take_repos_picked") as any;
    const done = trackSpy.mock.calls.flat().find((e: any) => e.name === "take_completed") as any;
    expect(picked.repo_count).toBe(2);
    expect(done.repo_count).toBe(2);
  });

  it("does not instrument addressPr's shared resolveKickoff call — no Take-funnel events fire", async () => {
    // addressPr calls resolveKickoff with no `flow`, so neither
    // take_destination_picked nor take_repos_picked fires from that shared call —
    // pinned here since Task 4 gave addressPr its own separate telemetry
    // (pr_work_seeded), which is expected to fire and is not a funnel event.
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["acme-billing"]));
    const { provider } = setup();
    await provider.addressPr("BILL-1234", ["acme-billing"]);
    const names = trackSpy.mock.calls.flat().map((e: any) => e.name);
    expect(names).toEqual(["pr_work_seeded"]);
  });
});

describe("takeBatch", () => {
  const twoKeys = ["PROJ-1", "PROJ-2"];

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
    await provider.takeBatch(["PROJ-1", "PROJ-2"], ["api"]); // 2 > 1 → confirm
    expect(window.showWarningMessage).toHaveBeenCalled();
    expect(openWorkspace).toHaveBeenCalledTimes(2);
  });

  it("still names Claude Code sessions in the batch confirmation by default", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, batchLaunchConfirmThreshold: 1 });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(window.showWarningMessage).mockResolvedValueOnce("Launch" as never);
    const { provider } = setup();
    await provider.takeBatch(["PROJ-1", "PROJ-2"], ["api"]); // 2 > 1 → confirm
    expect(window.showWarningMessage).toHaveBeenCalledWith(
      "Launch 2 tasks in parallel? That's 2 Claude Code sessions.",
      { modal: true },
      "Launch",
    );
  });

  it("names Copilot in the batch launch confirmation", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, batchLaunchConfirmThreshold: 1, agentProvider: "copilot" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(window.showWarningMessage).mockResolvedValueOnce("Launch" as never);
    const { provider } = setup();
    await provider.takeBatch(["PROJ-1", "PROJ-2"], ["api"]); // 2 > 1 → confirm
    expect(window.showWarningMessage).toHaveBeenCalledWith(
      "Launch 2 tasks in parallel? That's 2 Copilot sessions.",
      { modal: true },
      "Launch",
    );
  });

  // ── Task 6: one question for the whole batch ──────────────────────────────
  // The loop is non-interactive by design, so `ask` has to be resolved once, up
  // front, for all N tasks — N pickers for one click would be unusable, and the
  // stagger between opens means they would not even queue up together.
  /** Answer the provider picker with Cursor and every other picker with the layout
   *  default, by TITLE rather than by call order — the order of this path's pickers
   *  is not what these tests are about. */
  const pickCursorAgent = () =>
    vi.mocked(window.showQuickPick).mockImplementation(
      async (_items: unknown, opts?: unknown) =>
        ((opts as { title?: string } | undefined)?.title === "Which tool?"
          ? { label: "Cursor", provider: "cursor" }
          : { shared: false }) as never,
    );
  const agentPicks = () =>
    vi.mocked(window.showQuickPick).mock.calls.filter(
      (c) => (c[1] as { title?: string } | undefined)?.title === "Which tool?",
    );

  it("asks which agent once for the whole batch, and pins the answer onto every task", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, agentProvider: "ask" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    pickCursorAgent();
    const { provider } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    expect(agentPicks()).toHaveLength(1);
    expect(openWorkspace).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(openWorkspace).mock.calls) expect(call[0].provider).toBe("cursor");
  });

  it("uses the same picker title as a single launch, so the two read identically", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, agentProvider: "ask" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    pickCursorAgent();
    const { provider } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    expect(agentPicks()[0][0]).toEqual([
      { label: "Claude Code", provider: "claude-code" },
      { label: "Cursor", provider: "cursor" },
      { label: "Codex", provider: "codex" },
    ]);
  });

  it("asks a one-key batch about THIS session, not about every task in the batch", async () => {
    // A one-key "batch" to a shared destination is a single launch. It reaches
    // `resolveBatchProvider` only because a shared window seeds from plan files and
    // cannot ask later — the batch placeholder would promise an answer for tasks that
    // do not exist. Word-for-word the single-launch placeholder `openWorkspace` uses.
    vi.mocked(getConfig).mockReturnValue({ ...CFG, agentProvider: "ask", openIn: "this-window" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(currentWindow).mockReturnValue({
      identity: "/repos/api", kind: "folder", roots: [{ name: "api", path: "/repos/api" }],
    });
    pickCursorAgent();
    const { provider } = setup();
    await provider.takeBatch(["PROJ-1"], ["api"]);
    expect(agentPicks()).toHaveLength(1);
    expect(agentPicks()[0][1]).toEqual({
      title: "Which tool?",
      placeHolder: "Pick the tool to start this session with",
      ignoreFocusOut: true,
    });
  });

  it("keeps the batch placeholder for a real multi-task batch", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, agentProvider: "ask" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    pickCursorAgent();
    const { provider } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    expect(agentPicks()[0][1]).toEqual({
      title: "Which tool?",
      placeHolder: "Pick the tool for every session in this batch",
      ignoreFocusOut: true,
    });
  });

  // The stale-brief limitation the README documents, pinned so the doc and the code
  // cannot drift: a one-key batch to its OWN window resolves inside `openWorkspace`,
  // after `briefMarkdown` has already been called, so the brief names the setting's
  // default while the session that reads it is the one the user picked.
  it("writes a one-key own-window batch's brief with the default, not the pick", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, agentProvider: "ask", openIn: "new-window" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(openWorkspace).mockResolvedValue({
      mode: "per-window", workspaceFile: undefined, briefs: [], opened: ["/repos/api"],
      remoteControl: false, provider: "cursor",
    });
    const { provider } = setup();
    await provider.takeBatch(["PROJ-1"], ["api"]);
    expect(agentPicks()).toHaveLength(0); // nothing asked up front — openWorkspace asks
    expect(vi.mocked(openWorkspace).mock.calls[0][0].planMd).toContain("Claude Code");
  });

  it("raises the batch agent picker even on a host with no editor-specific agent", async () => {
    // Codex is on every host's picker, so outside VS Code and Cursor `hostProviders()`
    // is ["claude-code", "codex"] — two real answers, which is a question worth the
    // modal that a one-item list never was.
    vi.mocked(getConfig).mockReturnValue({ ...CFG, agentProvider: "ask" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    env.uriScheme = "windsurf";
    vi.mocked(window.showQuickPick).mockImplementation(
      async (_items: unknown, opts?: unknown) =>
        ((opts as { title?: string } | undefined)?.title === "Which tool?"
          ? { label: "Claude Code", provider: "claude-code" }
          : { shared: false }) as never,
    );
    const { provider } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    expect(agentPicks()[0][0]).toEqual([
      { label: "Claude Code", provider: "claude-code" },
      { label: "Codex", provider: "codex" },
    ]);
    expect(openWorkspace).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(openWorkspace).mock.calls) expect(call[0].provider).toBe("claude-code");
  });

  it("launches nothing when the batch's agent picker is dismissed", async () => {
    // A launch-wide question, dismissed, can only mean the launch — every task in it.
    vi.mocked(getConfig).mockReturnValue({ ...CFG, agentProvider: "ask" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(window.showQuickPick).mockImplementation(
      async (_items: unknown, opts?: unknown) =>
        ((opts as { title?: string } | undefined)?.title === "Which tool?" ? undefined : { shared: false }) as never,
    );
    const { provider, posted } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(posted().filter((m) => m.type === "toast")).toEqual([]);
  });

  it("names the picked agent in each task's brief", async () => {
    // briefMarkdown renders "_The {agentName} prompt for this task says…_", and the
    // batch resolves its agent BEFORE the briefs are built — so unlike the pre-launch
    // copy on the single-take path, this one can be right.
    vi.mocked(getConfig).mockReturnValue({ ...CFG, agentProvider: "ask" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    pickCursorAgent();
    const { provider } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    for (const call of vi.mocked(openWorkspace).mock.calls) {
      expect(call[0].planMd).toContain("_The Cursor prompt for this task says");
    }
  });

  it("carries the picked agent into a shared window's plan files too", async () => {
    // The shared path never calls openWorkspace, so it cannot inherit the answer from
    // there: without the pin its plan files carry no provider and the target window
    // re-reads the setting, which under `ask` degrades to Claude Code — seeding an
    // agent the user did not pick, minutes after they picked one.
    vi.mocked(getConfig).mockReturnValue({ ...CFG, agentProvider: "ask" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(window.showQuickPick).mockImplementation(
      async (_items: unknown, opts?: unknown) =>
        ((opts as { title?: string } | undefined)?.title === "Which tool?"
          ? { label: "Cursor", provider: "cursor" }
          : { shared: true }) as never,
    );
    const { provider } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    expect(openSharedWorkspace).toHaveBeenCalledWith(expect.objectContaining({ provider: "cursor" }));
  });

  // ── Fix round 1: the loop must not claim a launch that was cancelled ──────
  it("reports nothing when a one-key batch is dismissed at openWorkspace's own picker", async () => {
    // A one-key batch to its own window is a single launch: it does NOT resolve the
    // agent up front, so `openWorkspace` raises the picker itself and can come back
    // cancelled. Before the guard, the loop counted it and toasted "Launched 1 of 1 …
    // A worktree + Claude session per task." over a worktree with no window and no
    // session in it — the worst kind of wrong, because the user is told to go look for
    // something that is not there.
    vi.mocked(getConfig).mockReturnValue({ ...CFG, agentProvider: "ask" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(openWorkspace).mockResolvedValue({
      mode: "per-window", briefs: [], opened: [], remoteControl: false,
      provider: "claude-code", cancelled: true,
    });
    const { provider, posted } = setup();
    await provider.takeBatch(["PROJ-1"], ["api"]);
    // It really did reach the launch — otherwise this would pass for a batch that
    // bailed out somewhere earlier and never exercised the guard at all.
    expect(openWorkspace).toHaveBeenCalledTimes(1);
    expect(posted().filter((m) => m.type === "toast")).toEqual([]);
    // The mid-loop cancel with zero launches reports itself as cancelled, not failed —
    // the batch didn't break, the user walked away from a picker.
    const done = trackSpy.mock.calls.flat().find((e: any) => e.name === "batch_completed") as any;
    expect(done).toMatchObject({ outcome: "cancelled", attempted: 1, launched: 0, failed: 0 });
  });

  it("never raises its own agent picker for a one-key batch to a new window", async () => {
    // Why the guard above is the fix rather than "pin it up front like a real batch":
    // one task is one launch, and it asks at exactly the moment a Take does — inside
    // openWorkspace, after the destination and prompt are settled. Nothing extra here.
    vi.mocked(getConfig).mockReturnValue({ ...CFG, agentProvider: "ask" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    const { provider } = setup();
    await provider.takeBatch(["PROJ-1"], ["api"]);
    expect(agentPicks()).toHaveLength(0);
    expect(openWorkspace).toHaveBeenCalledTimes(1);
    expect("provider" in vi.mocked(openWorkspace).mock.calls[0][0]).toBe(false);
  });

  it("resolves the agent for a one-key batch to a shared destination, which cannot ask later", async () => {
    // The exception to "one key asks for itself": a shared destination seeds from plan
    // files and never calls openWorkspace, so there is nothing left downstream to raise
    // the picker. Without this it would seed Claude Code with nobody asked.
    // `openIn: "this-window"` fixes the destination without a picker — the same setup
    // the this-window batch test above uses — so the ONLY picker in this launch is the
    // agent one, and counting it counts exactly the thing under test.
    vi.mocked(getConfig).mockReturnValue({ ...CFG, agentProvider: "ask", openIn: "this-window" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(currentWindow).mockReturnValue({
      identity: "/repos/api",
      kind: "folder",
      roots: [{ name: "api", path: "/repos/api" }],
    });
    pickCursorAgent();
    const { provider } = setup();
    await provider.takeBatch(["PROJ-1"], ["api"]);
    expect(agentPicks()).toHaveLength(1);
    expect(openSharedWorkspace).toHaveBeenCalledWith(expect.objectContaining({ provider: "cursor" }));
  });

  it("sends no provider at all under a fixed setting, on either batch path", async () => {
    // Inertness: a pin is read ONLY under `ask` (see OpenRequest.provider), so sending
    // one under a fixed setting could only invite the request and the setting to
    // disagree. The request has to stay exactly what it always was.
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    const { provider } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    expect(agentPicks()).toHaveLength(0);
    for (const call of vi.mocked(openWorkspace).mock.calls) expect("provider" in call[0]).toBe(false);
  });

  it("skips a task whose worktree creation falls back to the main checkout and reports it failed", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(createWorktrees).mockImplementation((s) => s); // fallback: path stays === repoRef.path
    const { provider, posted } = setup();
    await provider.takeBatch(["PROJ-1"], ["api"]);
    expect(openWorkspace).not.toHaveBeenCalled();
    const toast = posted().find((m) => m.type === "toast") as { level: string; message: string };
    expect(toast.level).toBe("error");
    expect(toast.message).toContain("Launched 0 of 1");
  });

  it("names the repo whose worktree fell back, so a multi-repo task's failure is actionable", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["billing", "payments"]));
    clientStub.getDetail.mockResolvedValue({
      key: "PROJ-1",
      summary: "nothing recognisable here",
      descriptionText: "",
      labels: [],
      components: [],
      url: "https://jira/browse/PROJ-1",
    });
    // billing gets its worktree; payments falls back to the main checkout.
    vi.mocked(createWorktrees).mockImplementation((s, key) =>
      s.map((r) => (r.name === "payments" ? r : { ...r, path: `${r.path}/.claude/worktrees/${key}` })),
    );
    const { provider, posted } = setup();
    await provider.takeBatch(["PROJ-1"], ["billing", "payments"]);
    expect(openWorkspace).not.toHaveBeenCalled();
    const toast = posted().find((m) => m.type === "toast") as { level: string; message: string };
    expect(toast.message).toContain("payments");
    expect(toast.message).not.toContain("billing");
  });

  it("emits the batch funnel with matching flow_ids and honest counts", async () => {
    // 3 keys, PROJ-2's worktree falls back to the main checkout — the resolve-loop
    // catch swallows it and the other two still launch.
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(createWorktrees).mockImplementation((s, key) =>
      key === "PROJ-2" ? s : s.map((r) => ({ ...r, path: `${r.path}/.claude/worktrees/${key}` })),
    );
    const { provider } = setup();
    await provider.takeBatch(["PROJ-1", "PROJ-2", "PROJ-3"], ["api"]);
    const started = trackSpy.mock.calls.flat().find((e: any) => e.name === "batch_started") as any;
    const done = trackSpy.mock.calls.flat().find((e: any) => e.name === "batch_completed") as any;
    expect(started.flow_id).toBe(done.flow_id);
    expect(done).toMatchObject({ attempted: 3, failed: 1 });
    // A plain batch (no parent, no tree_mode arg) reports it as such.
    expect(started).toMatchObject({ keys_count: 3, is_fanout: false });
    expect("tree_mode" in started).toBe(false);
    // No ticket key ever reaches the funnel's serialized properties.
    expect(JSON.stringify([started, done])).not.toContain("PROJ-2");
  });

  it("carries chooseTreeMode's fan-out answer onto batch_started as tree_mode", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    const { provider } = setup();
    await provider.takeBatch(["PROJ-1"], ["api"], { key: "PROJ-9", branch: "PROJ-9-parent" }, "fanout");
    const started = trackSpy.mock.calls.flat().find((e: any) => e.name === "batch_started") as any;
    expect(started).toMatchObject({ tree_mode: "fanout", is_fanout: true });
  });

  it("emits operation_failed per swallowed per-key failure", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(createWorktrees).mockImplementation((s, key) =>
      key === "PROJ-2" ? s : s.map((r) => ({ ...r, path: `${r.path}/.claude/worktrees/${key}` })),
    );
    const { provider } = setup();
    await provider.takeBatch(["PROJ-1", "PROJ-2", "PROJ-3"], ["api"]);
    const errs = trackErrorSpy.mock.calls.flat().filter(
      (e: any) => e.name === "operation_failed" && e.op === "workspace_write",
    );
    expect(errs.length).toBeGreaterThanOrEqual(1);
    // The ticket key never leaks into the error event's properties.
    expect(JSON.stringify(errs)).not.toContain("PROJ-2");
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
    await provider.takeBatch(["PROJ-1"], ["api"]); // CFG.taskMode = "plan" is a known mode
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

  it("a cancelled confirm emits batch_completed{outcome:cancelled} with no prompt_mode", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, taskMode: "ask" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined);
    const { provider } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    const done = trackSpy.mock.calls.flat().find((e: any) => e.name === "batch_completed") as any;
    expect(done.outcome).toBe("cancelled");
    expect("prompt_mode" in done).toBe(false);
    expect(done).toMatchObject({ attempted: 2, launched: 0, failed: 0 });
  });

  it("drops a non-git repo from the set and launches on the rest", async () => {
    vi.mocked(discoverRepos).mockReturnValue([
      { name: "api", path: "/repos/api", isGit: true },
      { name: "docs", path: "/repos/docs", isGit: false },
    ]);
    const { provider, posted } = setup();
    await provider.takeBatch(["PROJ-1"], ["api", "docs"]);
    expect(openWorkspace).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createWorktrees).mock.calls[0][0]).toEqual([expect.objectContaining({ name: "api" })]);
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "info" }));
  });

  it("drops a name absent from the discovered repos and launches on the rest", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    const { provider, posted } = setup();
    await provider.takeBatch(["PROJ-1"], ["api", "ghost"]);
    expect(openWorkspace).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createWorktrees).mock.calls[0][0]).toEqual([expect.objectContaining({ name: "api" })]);
    const toast = posted().find((m) => m.type === "toast" && m.level === "info") as { message: string };
    expect(toast.message).toContain("ghost");
  });

  it("errors when no selected repo resolves to a git repo", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"], { isGit: false }));
    const { provider, posted } = setup();
    await provider.takeBatch(["PROJ-1"], ["api"]);
    expect(createWorktrees).not.toHaveBeenCalled();
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "error" }));
  });

  it("continues past a failing task and reports the failure count", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(openWorkspace)
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce({ mode: "per-window", workspaceFile: undefined, briefs: [], opened: ["/x"], remoteControl: false, provider: "claude-code" });
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
    await send({ type: "takeBatch", keys: ["PROJ-1"], repos: ["api"] });
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
      key: "PROJ-1",
      summary: "fix the billing flow",
      descriptionText: "desc",
      labels: [],
      components: [],
      url: "https://jira/browse/PROJ-1",
    });
    const { provider } = setup();
    await provider.takeBatch(["PROJ-1"], ["billing", "payments"]);
    const picked = vi.mocked(createWorktrees).mock.calls[0][0].map((r) => r.name);
    expect(picked).toEqual(["billing"]); // payments is in the filter set but not inferred — excluded
  });

  it("narrows a batched task to its ticket-confirmed repos, dropping text guesses", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["billing", "payments"]));
    clientStub.getDetail.mockResolvedValue({
      key: "PROJ-1",
      summary: "fix the payments flow", // payments is only a text guess
      descriptionText: "desc",
      labels: [],
      components: ["billing"], // billing is confirmed on the ticket
      url: "https://jira/browse/PROJ-1",
    });
    const { provider } = setup();
    await provider.takeBatch(["PROJ-1"], ["billing", "payments"]);
    const picked = vi.mocked(createWorktrees).mock.calls[0][0].map((r) => r.name);
    expect(picked).toEqual(["billing"]);
  });

  it("falls back to the whole filter set when a task infers no repo in it", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api", "billing"]));
    clientStub.getDetail.mockResolvedValue({
      key: "PROJ-1",
      summary: "nothing recognisable here",
      descriptionText: "",
      labels: [],
      components: [],
      url: "https://jira/browse/PROJ-1",
    });
    const { provider } = setup();
    await provider.takeBatch(["PROJ-1"], ["api", "billing"]);
    const picked = vi.mocked(createWorktrees).mock.calls[0][0].map((r) => r.name);
    expect(picked.sort()).toEqual(["api", "billing"]);
  });

  // The separate-windows layout promises "one window per task". A batched task can now
  // span several repos, so the layout has to be decided per task from its repo count —
  // a fixed per-window mode would fan a two-repo task out into two windows.
  it("gives a multi-repo task ONE multi-root window, not one window per repo", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["billing", "payments"]));
    clientStub.getDetail.mockResolvedValue({
      key: "PROJ-1",
      summary: "nothing recognisable here",
      descriptionText: "",
      labels: [],
      components: [],
      url: "https://jira/browse/PROJ-1",
    });
    const { provider } = setup();
    await provider.takeBatch(["PROJ-1"], ["billing", "payments"]);
    expect(openWorkspace).toHaveBeenCalledTimes(1);
    expect(openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ mode: "multiroot" }));
    const req = vi.mocked(openWorkspace).mock.calls[0][0];
    expect(req.services.map((s) => s.name)).toEqual(["billing", "payments"]);
  });

  it("gives a single-repo task its own plain window", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["billing", "payments"]));
    clientStub.getDetail.mockResolvedValue({
      key: "PROJ-1",
      summary: "fix the billing flow",
      descriptionText: "",
      labels: [],
      components: [],
      url: "https://jira/browse/PROJ-1",
    });
    const { provider } = setup();
    await provider.takeBatch(["PROJ-1"], ["billing", "payments"]);
    expect(openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ mode: "per-window" }));
  });

  it("honours workspaceMode 'per-window' for a multi-repo task", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, workspaceMode: "per-window" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["billing", "payments"]));
    clientStub.getDetail.mockResolvedValue({
      key: "PROJ-1",
      summary: "nothing recognisable here",
      descriptionText: "",
      labels: [],
      components: [],
      url: "https://jira/browse/PROJ-1",
    });
    const { provider } = setup();
    await provider.takeBatch(["PROJ-1"], ["billing", "payments"]);
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
    await provider.takeBatch(["PROJ-1"], ["api"]);
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
      unaddedFolders: ["api-PROJ-1", "api-PROJ-2"],
      seeded: 2,
    });
    const { provider, posted } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    const toast = posted().find((m) => m.type === "toast") as { message: string };
    expect(toast.message).toContain("api-PROJ-1");
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
        { label: "api", repoName: "api", path: "/repos/api/.claude/worktrees/PROJ-1" },
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
    expect(toast.message).toContain("PROJ-1 (disk full)");
    expect(toast.message).toContain("PROJ-2 (disk full)");
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
    await provider.takeBatch(["PROJ-1"], ["api"]);
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
      duplicates: [{ label: "account-service-PROJ-1", repoName: "account-service", path: "/repos/account-service/.claude/worktrees/PROJ-1" }],
      redundant: [],
      present: [],
      ok: true,
    });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ file: "/ws/team.code-workspace" } as never);
    vi.mocked(openSharedWorkspace).mockResolvedValue({
      opened: true, briefs: [], seeded: 1, workspaceFile: "/ws/team.code-workspace",
    });

    const { provider } = setup();
    await provider.takeBatch(["PROJ-1"], ["account-service"]);

    expect(openSharedWorkspace).toHaveBeenCalledWith(expect.objectContaining({ foldersToAdd: [] }));
    // Pins the candidate array itself: if `label` ever regressed from folderName(key, repo)
    // to the bare repo name, this would still pass on `foldersToAdd: []` alone while two
    // tasks in one repo silently became two identically-named roots.
    expect(planWorkspaceMerge).toHaveBeenCalledWith(
      "/ws/team.code-workspace",
      [expect.objectContaining({ label: "account-service-PROJ-1", repoName: "account-service" })],
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
        { label: "account-service-PROJ-1", repoName: "account-service", path: "/repos/account-service/.claude/worktrees/PROJ-1" },
        { label: "account-service-PROJ-2", repoName: "account-service", path: "/repos/account-service/.claude/worktrees/PROJ-2" },
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
          { name: "account-service-PROJ-1", path: "/repos/account-service/.claude/worktrees/PROJ-1" },
          { name: "account-service-PROJ-2", path: "/repos/account-service/.claude/worktrees/PROJ-2" },
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
      add: [{ label: "account-service-PROJ-1", repoName: "account-service", path: "/repos/account-service/.claude/worktrees/PROJ-1" }],
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
    await provider.takeBatch(["PROJ-1"], ["account-service"]);

    expect(openSharedWorkspace).toHaveBeenCalledWith(expect.objectContaining({ foldersToAdd: [] }));
    const toast = posted().find((m) => m.type === "toast") as { message: string };
    expect(toast.message).toContain("Left team.code-workspace unchanged.");
  });

  // Only a shared window on the extension surface actually can't seed a batch: a
  // separate-windows layout gives each window its own single-task plan (multi=false
  // there regardless), and the terminal surface seeds via a real terminal per task
  // ignoring `multi` entirely. The perTaskNote text must track that exactly, not
  // `isBatch` alone — see the four tests below.
  it("says a shared, extension-surface Copilot batch isn't seeded and points at the brief", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, agentProvider: "copilot", openIn: "new-window" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ shared: true } as never);
    const { provider, posted } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    const toast = posted().find((m) => m.type === "toast" && m.level === "success") as { message: string };
    expect(toast.message).toBe(
      "Launched 2 of 2 in one shared window. A worktree + brief per task — Copilot isn't seeded for a batch; open each brief to start it.",
    );
  });

  it("does not claim a separate-windows Copilot batch is unseeded", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, agentProvider: "copilot", openIn: "new-window" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    // The describe block's own beforeEach already answers the layout pick with
    // { shared: false } — separate windows, one per task.
    const { provider, posted } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    const toast = posted().find((m) => m.type === "toast" && m.level === "success") as { message: string };
    expect(toast.message).toBe("Launched 2 of 2 in parallel. A worktree + Copilot session per task.");
    expect(toast.message).not.toContain("isn't seeded");
  });

  it("does not claim a shared, terminal-surface Copilot batch is unseeded", async () => {
    vi.mocked(getConfig).mockReturnValue({
      ...CFG,
      agentProvider: "copilot",
      agentSurface: "terminal",
      openIn: "new-window",
    });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ shared: true } as never);
    const { provider, posted } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    const toast = posted().find((m) => m.type === "toast" && m.level === "success") as { message: string };
    expect(toast.message).toBe("Launched 2 of 2 in one shared window. A worktree + Copilot session per task.");
    expect(toast.message).not.toContain("isn't seeded");
  });

  it("keeps the Claude Code per-task note byte-identical for a shared batch", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "new-window" }); // default agentProvider: claude-code
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ shared: true } as never);
    const { provider, posted } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    const toast = posted().find((m) => m.type === "toast" && m.level === "success") as { message: string };
    expect(toast.message).toBe("Launched 2 of 2 in one shared window. A worktree + Claude session per task.");
  });

  it("keeps the Claude Code per-task note byte-identical across separate windows", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "new-window" }); // default agentProvider: claude-code
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    // Default layout pick answer from the describe's beforeEach: { shared: false }.
    const { provider, posted } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    const toast = posted().find((m) => m.type === "toast" && m.level === "success") as { message: string };
    expect(toast.message).toBe("Launched 2 of 2 in parallel. A worktree + Claude session per task.");
  });

  // A one-key "batch" to a shared, non-"new" destination is `shared === true` with
  // `isBatch === false` — modeled on "skips Remote Control without asking for a
  // one-key batch to a shared (non-new) destination" above. runSeedPass sees only
  // this one task's plan for the window either way, so it seeds regardless of
  // surface — the gate must require isBatch too, or this real single-task launch
  // would wrongly get the multi-task "isn't seeded" claim.
  it("does not claim a one-key batch to a shared (non-new) destination is unseeded under Copilot", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, agentProvider: "copilot", openIn: "this-window" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(currentWindow).mockReturnValue({
      identity: "/repos/api",
      kind: "folder",
      roots: [{ name: "api", path: "/repos/api" }],
    });
    const { provider, posted } = setup();
    await provider.takeBatch(["PROJ-1"], ["api"]);
    const toast = posted().find((m) => m.type === "toast" && m.level === "success") as { message: string };
    expect(toast.message).toBe("Launched 1 of 1 in one shared window. A worktree + Copilot session per task.");
    expect(toast.message).not.toContain("isn't seeded");
  });

  // ── The per-task note must name the agent that actually ran ─────────────────
  // Its else-arm was a pre-branch TWO-value discriminator — "copilot, or else Claude"
  // — so widening the enum to four left a Cursor batch announced as a Claude one. The
  // two tests above pin claude-code and copilot byte-identical; these pin cursor and
  // ask, the two values this branch adds.
  it("names Cursor in the per-task note across separate windows", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, agentProvider: "cursor", openIn: "new-window" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    const { provider, posted } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    const toast = posted().find((m) => m.type === "toast" && m.level === "success") as { message: string };
    expect(toast.message).toBe("Launched 2 of 2 in parallel. A worktree + Cursor session per task.");
  });

  it("names Cursor in the per-task note for a shared window", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, agentProvider: "cursor", openIn: "new-window" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ shared: true } as never);
    const { provider, posted } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    const toast = posted().find((m) => m.type === "toast" && m.level === "success") as { message: string };
    expect(toast.message).toBe("Launched 2 of 2 in one shared window. A worktree + Cursor session per task.");
  });

  it("names Codex in the per-task note across separate windows", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, agentProvider: "codex", openIn: "new-window" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    const { provider, posted } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    const toast = posted().find((m) => m.type === "toast" && m.level === "success") as { message: string };
    expect(toast.message).toBe("Launched 2 of 2 in parallel. A worktree + Codex session per task.");
  });

  it("names the agent the batch's ask picker chose, not Claude", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, agentProvider: "ask", openIn: "new-window" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    pickCursorAgent();
    const { provider, posted } = setup();
    await provider.takeBatch(twoKeys, ["api"]);
    const toast = posted().find((m) => m.type === "toast" && m.level === "success") as { message: string };
    expect(toast.message).toBe("Launched 2 of 2 in parallel. A worktree + Cursor session per task.");
  });

  it("names the agent a one-key ask batch resolved inside openWorkspace", async () => {
    // A one-key batch has no up-front answer to read — `openWorkspace` raises the
    // picker inside the loop — so the note has to take the answer back off the
    // result, which is the one place that choice exists.
    vi.mocked(getConfig).mockReturnValue({ ...CFG, agentProvider: "ask", openIn: "new-window" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(openWorkspace).mockResolvedValue({
      mode: "per-window", workspaceFile: undefined, briefs: [], opened: ["/repos/api"],
      remoteControl: false, provider: "cursor",
    });
    const { provider, posted } = setup();
    await provider.takeBatch(["PROJ-1"], ["api"]);
    const toast = posted().find((m) => m.type === "toast" && m.level === "success") as { message: string };
    expect(toast.message).toBe("Launched 1 of 1 in parallel. A worktree + Cursor session per task.");
  });
});

describe("live-window open targets", () => {
  const askCfg = () => vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask" });

  it("lists an open workspace window and opens the task into it (merge path)", async () => {
    askCfg();
    vi.mocked(readLiveWindows).mockReturnValue([
      { pid: 1, identity: "/ws/team.code-workspace", kind: "workspace", label: "team.code-workspace", folders: 2, roots: ["/repos/account-service", "/repos/webapp"], updatedAt: 9 },
    ]);
    // The open-target picker returns the live workspace window's mapped target.
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ target: { kind: "existing", file: "/ws/team.code-workspace" } } as never);

    const { provider } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service"]);

    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ existingWorkspaceFile: "/ws/team.code-workspace", mode: "multiroot", openIn: "new" }),
    );
  });

  it("lists an open folder window and opens the task into it (focus + seed)", async () => {
    askCfg();
    vi.mocked(readLiveWindows).mockReturnValue([
      { pid: 1, identity: "/repos/account-service", kind: "folder", label: "account-service", folders: 1, roots: ["/repos/account-service"], updatedAt: 9 },
    ]);
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ target: { kind: "live-folder", folder: "/repos/account-service" } } as never);

    const { provider } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service"]);

    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ existingFolder: "/repos/account-service", mode: "per-window", openIn: "new" }),
    );
  });

  it("excludes the current window from the live list", async () => {
    askCfg();
    vi.mocked(windowIdentity).mockReturnValue({ identity: "/repos/account-service", kind: "folder", label: "account-service", folders: 1, roots: ["/repos/account-service"] });
    vi.mocked(readLiveWindows).mockReturnValue([
      { pid: 1, identity: "/repos/account-service", kind: "folder", label: "account-service", folders: 1, roots: ["/repos/account-service"], updatedAt: 9 },
      { pid: 2, identity: "/repos/webapp", kind: "folder", label: "webapp", folders: 1, roots: ["/repos/webapp"], updatedAt: 8 },
    ]);
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ target: { kind: "new" } } as never);

    const { provider } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service"]);

    const items = vi.mocked(window.showQuickPick).mock.calls[0][0] as { label: string }[];
    const labels = items.map((i) => i.label);
    expect(labels.some((l) => l.includes("webapp"))).toBe(true);
    expect(labels.some((l) => l.includes("account-service"))).toBe(false); // current window excluded
  });

  it("does not read live windows when tracking is disabled", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask", trackOpenWindows: false });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ target: { kind: "new" } } as never);

    const { provider } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service"]);

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
      { pid: 1, identity: "/repos/webapp", kind: "folder", label: "webapp", folders: 1, roots: ["/repos/webapp"], updatedAt: 9 },
    ]);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("poke around");
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ target: { kind: "live-folder", folder: "/repos/webapp" } } as never) // open where (first)
      .mockResolvedValueOnce([{ repo: mkRepos(["webapp"])[0] }] as never);                            // repos (last)

    await runExplore();

    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ existingFolder: "/repos/webapp", mode: "per-window", openIn: "new" }),
    );
  });

  it("skips the repo pick and uses the existing workspace's repos", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask", exploreMode: "knowledge" });
    vi.mocked(workspaceFolderPaths).mockReturnValue(["/repos/webapp"]);
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
        services: [expect.objectContaining({ name: "webapp", path: "/repos/webapp" })],
      }),
    );
  });

  it("derives the repo, not a phantom, from a workspace folder that is a worktree", async () => {
    // A folder left behind by an older version points at .../worktrees/PROJ-5111, whose
    // basename is a ticket key. Taken at face value it becomes a phantom repo — and since a
    // worktree's .git is a pointer FILE it even passes the isGit check, so the next
    // createWorktrees would nest a worktree inside that worktree.
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask", exploreMode: "knowledge" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["webapp"]));
    vi.mocked(workspaceFolderPaths).mockReturnValue(["/repos/webapp/.claude/worktrees/PROJ-5111"]);
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
        services: [expect.objectContaining({ name: "webapp", path: "/repos/webapp" })],
      }),
    );
  });

  it("collapses a repo and a worktree of that repo to one service", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask", exploreMode: "knowledge" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["webapp"]));
    vi.mocked(workspaceFolderPaths).mockReturnValue([
      "/repos/webapp",
      "/repos/webapp/.claude/worktrees/PROJ-5885",
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
    expect(services.map((s) => s.path)).toEqual(["/repos/webapp"]);
  });

  it("collapses two different worktrees of the same repo to one service", async () => {
    // Each worktree's root is independently unwound and (per the fix) canon()'d before
    // the dedup map keys on it — two distinct ticket keys must still land on one entry.
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask", exploreMode: "knowledge" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["webapp"]));
    vi.mocked(workspaceFolderPaths).mockReturnValue([
      "/repos/webapp/.claude/worktrees/PROJ-1111",
      "/repos/webapp/.claude/worktrees/PROJ-2222",
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
    expect(services).toEqual([expect.objectContaining({ name: "webapp", path: "/repos/webapp", isGit: true })]);
  });

  it("collapses a live-folder destination pointed at a worktree to its owning repo", async () => {
    // per-window tracking takes open windows directly at worktree paths, and window
    // presence records that path, so a live folder pointing at .../worktrees/<KEY> is the
    // highest-traffic instance of the unwind — pin it so it can't regress.
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask", exploreMode: "knowledge" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["webapp"]));
    vi.mocked(readLiveWindows).mockReturnValue([
      { pid: 1, identity: "/repos/webapp/.claude/worktrees/PROJ-5885", kind: "folder", label: "PROJ-5885", folders: 1, roots: ["/repos/webapp/.claude/worktrees/PROJ-5885"], updatedAt: 9 },
    ]);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("poke around");
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ target: { kind: "live-folder", folder: "/repos/webapp/.claude/worktrees/PROJ-5885" } } as never) // open where (first)
      .mockResolvedValueOnce([{ repo: mkRepos(["webapp"])[0] }] as never);                                                    // repos (last)

    await runExplore();

    const services = vi.mocked(openWorkspace).mock.calls.at(-1)![0].services;
    expect(services.map((s) => s.path)).toEqual(["/repos/webapp"]);
  });

  it("skips the repo pick for this window and uses the folders already open here", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "this-window", exploreMode: "knowledge" });
    vi.mocked(currentWindow).mockReturnValue({
      identity: "/repos/webapp",
      kind: "folder",
      roots: [{ name: "webapp", path: "/repos/webapp" }],
    });
    vi.mocked(window.showInputBox).mockResolvedValueOnce("x");

    await runExplore();

    expect(window.showQuickPick).not.toHaveBeenCalled(); // no destination pick, no repo pick
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        openIn: "current",
        services: [expect.objectContaining({ name: "webapp", path: "/repos/webapp" })],
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
    await send({ type: "addressPr", key: "PROJ-1", services: ["account-service"] });
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ ticket: expect.objectContaining({ key: "PROJ-1" }) }),
    );
  });

  it("seeds the PR-review prompt (not a task prompt mode) and never prompts for a mode", async () => {
    const { provider } = setup();
    await provider.addressPr("PROJ-1", ["account-service"]);
    expect(promptOf()).toContain("PR {key}"); // from cfg.prReviewPrompt
    expect(window.showQuickPick).not.toHaveBeenCalled(); // openIn=new-window, 1 repo, forced worktree → no picks
  });

  it("always creates a worktree even when worktree = never", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, worktree: "never" });
    const { provider } = setup();
    await provider.addressPr("PROJ-1", ["account-service"]);
    expect(createWorktrees).toHaveBeenCalledWith(
      [expect.objectContaining({ name: "account-service" })],
      "PROJ-1",
      "Do the thing",
      expect.anything(),
    );
    expect(openWorkspace).toHaveBeenCalled();
  });

  it("appends the auto-fix clause before {files} when prReviewAutoFix is on", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, prReviewAutoFix: true });
    const { provider } = setup();
    await provider.addressPr("PROJ-1", ["account-service"]);
    const t = promptOf();
    expect(t).toContain(PR_REVIEW_AUTOFIX_CLAUSE);
    expect(t.indexOf(PR_REVIEW_AUTOFIX_CLAUSE)).toBeLessThan(t.indexOf("{files}"));
  });

  it("omits the auto-fix clause when prReviewAutoFix is off", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, prReviewAutoFix: false });
    const { provider } = setup();
    await provider.addressPr("PROJ-1", ["account-service"]);
    expect(promptOf()).toBe(CFG.prReviewPrompt);
    expect(promptOf()).not.toContain(PR_REVIEW_AUTOFIX_CLAUSE);
  });

  it("appends the auto-fix clause at the end when the prompt has no {files}", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, prReviewPrompt: "Review PR for {key}" });
    const { provider } = setup();
    await provider.addressPr("PROJ-1", ["account-service"]);
    expect(promptOf()).toBe(`Review PR for {key} ${PR_REVIEW_AUTOFIX_CLAUSE}`);
  });

  it("errors when no repos are checked out", async () => {
    vi.mocked(discoverRepos).mockReturnValue([]);
    const { provider, posted } = setup();
    await provider.addressPr("PROJ-1", ["account-service"]);
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(posted()).toContainEqual(expect.objectContaining({ type: "toast", level: "error" }));
  });

  it("aborts before opening when the open-target picker is cancelled", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask" });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined as never);
    const { provider } = setup();
    await provider.addressPr("PROJ-1", ["account-service"]);
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it("aborts when sign-in is declined", async () => {
    vi.mocked(commands.executeCommand).mockResolvedValue(false);
    const { provider } = setup({ authed: false });
    await provider.addressPr("PROJ-1", ["account-service"]);
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it("emits pr_work_seeded with source tasks and reason review on a successful launch, with no ticket key in the serialized calls", async () => {
    const { provider } = setup();
    await provider.addressPr("PROJ-1", ["account-service"]);
    expect(trackSpy.mock.calls.flat().find((e: any) => e.name === "pr_work_seeded")).toMatchObject({
      reason: "review", source: "tasks", outcome: "seeded", agent_seeded: true,
    });
    expect(JSON.stringify(trackSpy.mock.calls.flat())).not.toContain("PROJ-1");
  });

  it("emits pr_work_seeded cancelled when the open-target picker is cancelled", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask" });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined as never);
    const { provider } = setup();
    await provider.addressPr("PROJ-1", ["account-service"]);
    expect(trackSpy.mock.calls.flat().find((e: any) => e.name === "pr_work_seeded")).toMatchObject({
      outcome: "cancelled",
    });
  });

  it("emits pr_work_seeded refused when Remote Control blocks the launch", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, remoteControl: "on", agentProvider: "copilot", seedAgent: true });
    const { provider } = setup();
    await provider.addressPr("PROJ-1", ["account-service"]);
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(trackSpy.mock.calls.flat().find((e: any) => e.name === "pr_work_seeded")).toMatchObject({
      outcome: "refused",
    });
  });
});

describe("remote control", () => {
  const lastOpen = () =>
    vi.mocked(openWorkspace).mock.calls[vi.mocked(openWorkspace).mock.calls.length - 1][0];

  it("passes false and never prompts when the setting is off", async () => {
    const { provider } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(lastOpen().remoteControl).toBe(false);
    expect(window.showQuickPick).not.toHaveBeenCalled();
  });

  it("passes true without prompting when the setting is on", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, remoteControl: "on" });
    const { provider } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(lastOpen().remoteControl).toBe(true);
    expect(window.showQuickPick).not.toHaveBeenCalled();
  });

  it("ask: choosing Enable passes true", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, remoteControl: "ask" });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ yes: true } as never);
    const { provider } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(lastOpen().remoteControl).toBe(true);
  });

  it("ask: dismissing passes false and the launch still proceeds", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, remoteControl: "ask" });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined); // dismissed
    const { provider } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(openWorkspace).toHaveBeenCalledTimes(1);
    expect(lastOpen().remoteControl).toBe(false);
  });

  it("asks once per launch, not once per repo", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, remoteControl: "ask" });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ yes: true } as never);
    const { provider } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service", "webapp"]);
    expect(window.showQuickPick).toHaveBeenCalledTimes(1);
  });

  it("ask: never shows the picker when seedAgent is off — no plan file could ever carry the answer", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, remoteControl: "ask", seedAgent: false });
    const { provider } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
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
      provider: "claude-code",
    });
    const { provider, posted } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service", "webapp"]);
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
    await provider.takeBatch(["PROJ-1", "PROJ-2"], ["api"]);
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
      provider: "claude-code",
    });
    const { provider, posted } = setup();
    await provider.takeBatch(["PROJ-1"], ["api"]);
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
// Only `remoteControl: "on"` is refused, and it is refused at the top of each entry
// point — before pickers, worktrees and windows, so a refusal leaves nothing behind.
// `"ask"` is never refused: the picker is simply not offered and the launch proceeds
// without Remote Control, so a Copilot user is never blocked from taking a task.
//
// The "leaves Claude Code alone" / "off" / "real batch" cases are REGRESSION GUARDS for
// the flows that exist today — they were green before the block was written.
describe("remote control × the Copilot provider", () => {
  const lastOpen = () =>
    vi.mocked(openWorkspace).mock.calls[vi.mocked(openWorkspace).mock.calls.length - 1][0];
  const errorToast = (posted: () => OutboundMessage[]) =>
    posted().find((m) => m.type === "toast" && m.level === "error") as { message: string } | undefined;
  const copilot = (over: Partial<ReturnType<typeof getConfig>> = {}) =>
    vi.mocked(getConfig).mockReturnValue({ ...CFG, agentProvider: "copilot" as const, ...over });

  it("refuses a Take before creating any worktree, and before any picker", async () => {
    // The whole point of refusing at the top: no orphan worktrees for a launch that
    // never happens, and no prompts for a launch already known to be impossible.
    copilot({ remoteControl: "on", worktree: "always" });
    const { provider, posted } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(errorToast(posted)?.message).toContain("Remote Control needs Claude Code");
    expect(createWorktrees).not.toHaveBeenCalled();
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(clientStub.getDetail).not.toHaveBeenCalled(); // not even the Jira read
  });

  it("emits no take funnel events for a refused Take", async () => {
    // Refused before take_started, so the funnel gets neither a start nor a
    // terminator — better than a phantom "cancelled" nobody chose.
    copilot({ remoteControl: "on" });
    const { provider } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(trackSpy.mock.calls.map((c) => (c[0] as { name: string }).name)).not.toContain("take_started");
  });

  it("refuses addressPr before creating any worktree", async () => {
    // addressPr forces a worktree (forceWorktree), so it is the flow with the most to
    // leave behind if the refusal lands late.
    copilot({ remoteControl: "on" });
    const { provider, posted } = setup();
    await provider.addressPr("PROJ-1", ["account-service"]);
    expect(errorToast(posted)?.message).toContain("Remote Control needs Claude Code");
    expect(createWorktrees).not.toHaveBeenCalled();
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
    await provider.takeBatch(["PROJ-1"], ["api"]);
    expect(errorToast(posted)?.message).toContain("Remote Control needs Claude Code");
    expect(openWorkspace).not.toHaveBeenCalled();
    vi.mocked(createWorktrees).mockImplementation((s) => s);
  });

  it("never refuses on \"ask\" — it launches without Remote Control instead", async () => {
    // A toggle we could only refuse is a broken offer, so it is not offered. The
    // launch must still happen: an "ask" setting may never block a Copilot user.
    copilot({ remoteControl: "ask" });
    const { provider, posted, logged } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(window.showQuickPick).not.toHaveBeenCalled(); // the picker never appears
    expect(errorToast(posted)).toBeUndefined();
    expect(openWorkspace).toHaveBeenCalledTimes(1); // the launch proceeds
    expect(lastOpen().remoteControl).toBe(false); // …just without Remote Control
    expect(logged.join("\n")).toContain("Remote Control not offered");
  });

  it("still shows the \"ask\" picker under Claude Code", async () => {
    // The guard on the "ask" short-circuit: dropping its `agentProvider` clause would
    // silently stop offering Remote Control to every Claude Code user.
    vi.mocked(getConfig).mockReturnValue({ ...CFG, remoteControl: "ask" });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ yes: true } as never);
    const { provider, logged } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(window.showQuickPick).toHaveBeenCalledTimes(1);
    expect(lastOpen().remoteControl).toBe(true);
    expect(logged.join("\n")).not.toContain("Remote Control not offered");
  });

  it("does not refuse when seedAgent is off — nothing could ever seed the slash command", async () => {
    // The pre-flight predicate has to carry resolveRemoteControlSetting's own
    // precondition (:1291). With seedAgent off no plan file carries the decision, so
    // `/remote-control` can never be seeded and there is nothing to refuse — this user
    // launched fine before the block existed and must still launch now.
    copilot({ remoteControl: "on", seedAgent: false });
    const { provider, posted } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(errorToast(posted)).toBeUndefined();
    expect(openWorkspace).toHaveBeenCalledTimes(1);
    expect(lastOpen().remoteControl).toBe(false);
  });

  it("does not refuse a one-key takeBatch launch when seedAgent is off", async () => {
    // NOTE: this drives only takeBatch, which resolves Remote Control through
    // resolveRemoteControlSetting and never calls remoteControlBlocksLaunch — so it
    // pins takeBatch's OWN seedAgent-off behavior, not agreement between the two
    // pre-flight paths (that cross-path check would need a test that exercises
    // remoteControlBlocksLaunch itself, e.g. via takeTask, alongside this one).
    // Still valid as a regression guard: takeBatch's seedAgent-off handling has
    // always honoured seedAgent, and this is what pins that.
    copilot({ remoteControl: "on", seedAgent: false });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(createWorktrees).mockImplementation((s, key) =>
      s.map((r) => ({ ...r, path: `${r.path}/.claude/worktrees/${key}` })),
    );
    const { provider, posted } = setup();
    await provider.takeBatch(["PROJ-1"], ["api"]);
    expect(errorToast(posted)).toBeUndefined();
    expect(openWorkspace).toHaveBeenCalledTimes(1);
    vi.mocked(createWorktrees).mockImplementation((s) => s);
  });

  it("leaves Claude Code + Remote Control alone", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, remoteControl: "on" });
    const { provider, posted } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(errorToast(posted)).toBeUndefined();
    expect(openWorkspace).toHaveBeenCalledTimes(1);
    expect(lastOpen().remoteControl).toBe(true);
  });

  it("does not fire when Remote Control is off", async () => {
    copilot({ remoteControl: "off" });
    const { provider, posted } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
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
    await provider.takeBatch(["PROJ-1", "PROJ-2"], ["api"]);
    expect(errorToast(posted)).toBeUndefined();
    expect(openWorkspace).toHaveBeenCalledTimes(2);
    vi.mocked(createWorktrees).mockImplementation((s) => s);
  });
});

// Task 2 widened remoteControlBlocksLaunch and resolveRemoteControl from a Copilot-only
// equality test to "any non-Claude agent". The Copilot describe above already pins the
// Copilot side of that; these pin the Cursor side of the SAME three conditions, so a
// revert of any one of them back to `=== "copilot"` (or `!== "copilot"`) shows up here.
describe("remote control × the Cursor provider", () => {
  const lastOpen = () =>
    vi.mocked(openWorkspace).mock.calls[vi.mocked(openWorkspace).mock.calls.length - 1][0];
  const errorToast = (posted: () => OutboundMessage[]) =>
    posted().find((m) => m.type === "toast" && m.level === "error") as { message: string } | undefined;
  const cursor = (over: Partial<ReturnType<typeof getConfig>> = {}) =>
    vi.mocked(getConfig).mockReturnValue({ ...CFG, agentProvider: "cursor" as const, ...over });

  it("refuses a Take before creating any worktree, exactly as it does under Copilot", async () => {
    // remoteControlBlocksLaunch's condition: `agentProvider === "claude-code"` is
    // the only exemption now, so "cursor" must trip it the same way "copilot" does.
    //
    // resolveRemoteControl's OWN "on" refusal (further down the same launch, inside
    // resolveKickoff) would produce the identical toast for "on" + a non-Claude
    // agent, so asserting the toast alone cannot tell the two refusals apart — a
    // mutant that disables ONLY remoteControlBlocksLaunch would still pass a toast
    // assertion here. `take_started` is only tracked AFTER remoteControlBlocksLaunch
    // returns, and well before resolveRemoteControl is ever reached, so its absence
    // is what actually pins this specific pre-flight predicate.
    cursor({ remoteControl: "on", seedAgent: true });
    const { provider, posted } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(errorToast(posted)?.message).toContain("Remote Control needs Claude Code");
    expect(createWorktrees).not.toHaveBeenCalled();
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(trackSpy.mock.calls.map((c) => (c[0] as { name: string }).name)).not.toContain("take_started");
  });

  it("does not refuse when seedAgent is off — nothing could ever seed the slash command", async () => {
    // The `!cfg.seedAgent` clause exists precisely so a user who never opted into
    // seeding is never locked out of every launch by this predicate.
    cursor({ remoteControl: "on", seedAgent: false });
    const { provider, posted } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(errorToast(posted)).toBeUndefined();
    expect(openWorkspace).toHaveBeenCalledTimes(1);
    expect(lastOpen().remoteControl).toBe(false);
  });

  it('never refuses on "ask" — it launches without Remote Control instead', async () => {
    // resolveRemoteControl's "ask" short-circuit: `agentProvider !== "claude-code"`
    // must cover "cursor" too, or this would put up a toggle it could only refuse.
    cursor({ remoteControl: "ask" });
    const { provider, posted, logged } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(window.showQuickPick).not.toHaveBeenCalled(); // the picker never appears
    expect(errorToast(posted)).toBeUndefined();
    expect(openWorkspace).toHaveBeenCalledTimes(1); // the launch proceeds
    expect(lastOpen().remoteControl).toBe(false); // …just without Remote Control
    expect(logged.join("\n")).toContain("Remote Control not offered");
  });

  it("refuses a one-key batch and opens nothing, once the setting resolves on", async () => {
    // takeBatch is the one launch entry point with no remoteControlBlocksLaunch call
    // at the top, so this exercises resolveRemoteControl's OWN refusal
    // (`on && agentProvider !== "claude-code"`) rather than the pre-flight one above.
    cursor({ remoteControl: "on" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(createWorktrees).mockImplementation((s, key) =>
      s.map((r) => ({ ...r, path: `${r.path}/.claude/worktrees/${key}` })),
    );
    const { provider, posted } = setup();
    await provider.takeBatch(["PROJ-1"], ["api"]);
    expect(errorToast(posted)?.message).toContain("Remote Control needs Claude Code");
    expect(openWorkspace).not.toHaveBeenCalled();
    vi.mocked(createWorktrees).mockImplementation((s) => s);
  });
});

// ── Remote Control × the `ask` provider ─────────────────────────────────────
// REGRESSION BLOCK. `ask` is not an agent — it means "pick one per launch" — and while
// it is inert seedProvider degrades it to Claude Code. Three sites used to compare
// `cfg.agentProvider` to "claude-code" directly, so `ask` fell through all three and
// was treated as a non-Claude agent: remoteControlBlocksLaunch HARD-BLOCKED the launch
// with RC_NEEDS_CLAUDE, and resolveRemoteControl both withheld the "ask" toggle and
// refused an "on" batch — refusing a session that would in fact have been Claude Code.
// All three now compare resolvedProvider(cfg.agentProvider).
//
// Each case is written as "ask behaves exactly like claude-code", because that is the
// inertness contract this task ships under, and asserts the launch actually PROCEEDS —
// a test that only checked for the absence of a toast would still pass if the launch
// were silently dropped.
describe("remote control × the `ask` provider", () => {
  const lastOpen = () =>
    vi.mocked(openWorkspace).mock.calls[vi.mocked(openWorkspace).mock.calls.length - 1][0];
  const errorToast = (posted: () => OutboundMessage[]) =>
    posted().find((m) => m.type === "toast" && m.level === "error") as { message: string } | undefined;
  const ask = (over: Partial<ReturnType<typeof getConfig>> = {}) =>
    vi.mocked(getConfig).mockReturnValue({ ...CFG, agentProvider: "ask" as const, ...over });

  // ── site 1: remoteControlBlocksLaunch ──
  it("does NOT block a Take with remoteControl on — the session would be Claude Code", async () => {
    // The Critical defect: this launch was refused outright, with RC_NEEDS_CLAUDE, for
    // an agent that seedProvider resolves to Claude Code.
    ask({ remoteControl: "on" });
    const { provider, posted } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(errorToast(posted)).toBeUndefined();
    expect(openWorkspace).toHaveBeenCalledTimes(1); // the launch really happens
    expect(lastOpen().remoteControl).toBe(true); // …with Remote Control on, as asked
  });

  it("blocks a Take with remoteControl on exactly as claude-code does — i.e. not at all", async () => {
    // The equivalence stated directly: same inputs, same outcome, only the setting
    // differs. If ask ever diverges from claude-code here, this fails.
    const run = async (agentProvider: "ask" | "claude-code") => {
      // Both arms run inside one test, so the shared openWorkspace spy has to be
      // cleared between them — otherwise the second arm counts the first arm's call
      // and the comparison fails on the harness, not on the behaviour.
      vi.mocked(openWorkspace).mockClear();
      vi.mocked(getConfig).mockReturnValue({ ...CFG, agentProvider, remoteControl: "on" });
      const { provider, posted } = setup();
      await provider.takeTask("PROJ-1", "card", ["account-service"]);
      return { toast: errorToast(posted)?.message, opens: vi.mocked(openWorkspace).mock.calls.length, rc: lastOpen().remoteControl };
    };
    expect(await run("ask")).toEqual(await run("claude-code"));
  });

  // ── site 2: resolveRemoteControl's "ask" short-circuit ──
  it("still OFFERS the remoteControl picker — it is not a toggle we could only refuse", async () => {
    // The silent half of the defect: no toast, no error, the toggle simply never
    // appeared, so an ask user could never turn Remote Control on for a launch.
    ask({ remoteControl: "ask" });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ yes: true } as never);
    const { provider, logged } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(window.showQuickPick).toHaveBeenCalledTimes(1); // the picker appears
    expect(lastOpen().remoteControl).toBe(true); // and the answer is honoured
    expect(logged.join("\n")).not.toContain("Remote Control not offered");
  });

  // ── site 3: resolveRemoteControl's post-resolution refusal ──
  it("does NOT refuse a one-key batch with remoteControl on", async () => {
    // takeBatch is the one entry point with no pre-flight predicate, so it reaches the
    // `on && provider !== "claude-code"` refusal directly.
    ask({ remoteControl: "on" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(createWorktrees).mockImplementation((s, key) =>
      s.map((r) => ({ ...r, path: `${r.path}/.claude/worktrees/${key}` })),
    );
    const { provider, posted } = setup();
    await provider.takeBatch(["PROJ-1"], ["api"]);
    expect(errorToast(posted)).toBeUndefined();
    expect(openWorkspace).toHaveBeenCalledTimes(1);
    vi.mocked(createWorktrees).mockImplementation((s) => s);
  });

  // ── site 4: the toast that explains why it didn't happen ──
  it("blames the agent, not the window count, when the pick drops Remote Control", async () => {
    // One window WAS opened. `openWorkspace` withheld Remote Control because the user
    // picked Cursor, so the single-window reason is simply false here.
    ask({ remoteControl: "on" });
    vi.mocked(openWorkspace).mockResolvedValue({
      mode: "per-window", workspaceFile: undefined, briefs: [], opened: ["/repos/account-service"],
      remoteControl: false, provider: "cursor",
    });
    const { provider, posted } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    const toast = posted().find((m) => m.type === "toast" && m.level === "success") as { message: string };
    expect(toast.message).toContain(" Remote Control skipped — it needs Claude Code, and Cursor was picked.");
    expect(toast.message).not.toContain("single window");
  });

  it("keeps the single-window reason byte-identical for the case it really describes", async () => {
    // Claude Code was seeded and Remote Control still didn't apply: the launch opened
    // more than one window, which is the ONLY thing that message has ever meant.
    ask({ remoteControl: "on" });
    vi.mocked(openWorkspace).mockResolvedValue({
      mode: "per-window", workspaceFile: undefined, briefs: [],
      opened: ["/repos/account-service", "/repos/webapp"],
      remoteControl: false, provider: "claude-code",
    });
    const { provider, posted } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    const toast = posted().find((m) => m.type === "toast" && m.level === "success") as { message: string };
    expect(toast.message).toContain(" Remote Control skipped — it needs a single window.");
  });

  // ── the guard rail: copilot and cursor must STILL be refused ──
  it("still refuses copilot and cursor — the fix must not widen into a free pass", async () => {
    for (const agentProvider of ["copilot", "cursor"] as const) {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, agentProvider, remoteControl: "on" });
      const { provider, posted } = setup();
      await provider.takeTask("PROJ-1", "card", ["account-service"]);
      expect(errorToast(posted)?.message).toContain("Remote Control needs Claude Code");
      expect(openWorkspace).not.toHaveBeenCalled();
    }
  });
});

// ── Copy that names an agent, under `ask` ───────────────────────────────────
// Every one of these templates uses the label as a PRODUCT NAME — "a X agent",
// "N X sessions", "The X prompt" — so a label that is a phrase rather than a name
// ("your coding agent") renders as "a your coding agent agent". An earlier revision of
// this task shipped exactly that, in all six rendered sites, past four green gates,
// because nothing pinned the copy under `ask`. These are those pins.
describe("agent-naming copy under the `ask` provider", () => {
  const ask = (over: Partial<ReturnType<typeof getConfig>> = {}) =>
    vi.mocked(getConfig).mockReturnValue({ ...CFG, agentProvider: "ask" as const, ...over });

  it("names Claude Code in the posted state's agentLabel", async () => {
    // Feeds two webview templates: "Explore repos with a {agentLabel} agent" and
    // "…its own {agentLabel} session". Both need a bare product name.
    ask();
    const { send, posted } = setup({ authed: true });
    await send({ type: "ready" });
    expect(posted()).toContainEqual(expect.objectContaining({ type: "state", agentLabel: "Claude Code" }));
  });

  // Task 6 supersedes this one's original form. It used to pin "2 Claude Code
  // sessions" under `ask`, which was the honest reading while `ask` was inert: nothing
  // had been picked by the time the confirmation ran, so it named the degraded default.
  // Now the batch resolves its agent BEFORE confirming, so the confirmation can — and
  // must — name the agent the user actually picked. The assertion is stronger than the
  // one it replaces: it proves the picked answer reaches the copy, which the old
  // "Claude Code" string would have passed with the answer thrown away.
  it("names the agent the user picked in the batch launch confirmation", async () => {
    ask({ batchLaunchConfirmThreshold: 1 });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(window.showQuickPick).mockImplementation(
      async (_items: unknown, opts?: unknown) =>
        ((opts as { title?: string } | undefined)?.title === "Which tool?"
          ? { label: "Cursor", provider: "cursor" }
          : { shared: false }) as never,
    );
    vi.mocked(window.showWarningMessage).mockResolvedValueOnce("Launch" as never);
    const { provider } = setup();
    await provider.takeBatch(["PROJ-1", "PROJ-2"], ["api"]);
    expect(window.showWarningMessage).toHaveBeenCalledWith(
      "Launch 2 tasks in parallel? That's 2 Cursor sessions.",
      { modal: true },
      "Launch",
    );
  });

  it("asks which agent BEFORE confirming, not after", async () => {
    // The ordering is the whole mechanism: a confirmation raised first could only name
    // the setting's default, and this is the one path where an agent-naming line runs
    // ahead of the launch it describes. Asserted on the real call order rather than on
    // the string alone, so a confirmation that happened to read correctly for some
    // other reason would not stand in for it.
    ask({ batchLaunchConfirmThreshold: 1 });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    const order: string[] = [];
    vi.mocked(window.showQuickPick).mockImplementation(async (_items: unknown, opts?: unknown) => {
      const title = (opts as { title?: string } | undefined)?.title;
      if (title === "Which tool?") {
        order.push("agent");
        return { label: "Cursor", provider: "cursor" } as never;
      }
      return { shared: false } as never;
    });
    vi.mocked(window.showWarningMessage).mockImplementation(async () => {
      order.push("confirm");
      return "Launch" as never;
    });
    const { provider } = setup();
    await provider.takeBatch(["PROJ-1", "PROJ-2"], ["api"]);
    expect(order).toEqual(["agent", "confirm"]);
  });

  it("confirms nothing when the agent picker is dismissed", async () => {
    // The other half of asking first: a dismissal now lands before the confirmation,
    // so the user is never asked to authorise a launch that has already been called off.
    ask({ batchLaunchConfirmThreshold: 1 });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(window.showQuickPick).mockResolvedValue(undefined as never);
    const { provider, posted } = setup();
    await provider.takeBatch(["PROJ-1", "PROJ-2"], ["api"]);
    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(posted().filter((m) => m.type === "toast")).toEqual([]);
  });

  it("names Claude Code in the brief handed to the agent", async () => {
    // briefMarkdown renders "_The {agentName} prompt for this task says…_".
    ask();
    const { provider } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    const planMd = vi.mocked(openWorkspace).mock.calls[0][0].planMd;
    expect(planMd).toContain("_The Claude Code prompt for this task says");
    expect(planMd).not.toMatch(/The (your|a|an|the) /i);
  });
});

// ── Task 6: the picker's answer, at the call sites ──────────────────────────
// Task 5 made `openWorkspace` resolve `ask` before anything is created and report the
// answer on its result. Until these, nothing read that answer: every caller still
// asked the SETTING what agent it had, which under `ask` says "Claude Code" no matter
// what the user picked, and a dismissed picker still ran the whole success path.
describe("the `ask` picker's answer, at the call sites", () => {
  const ask = (over: Partial<ReturnType<typeof getConfig>> = {}) =>
    vi.mocked(getConfig).mockReturnValue({ ...CFG, agentProvider: "ask" as const, ...over });
  const toasts = (posted: () => OutboundMessage[]) => posted().filter((m) => m.type === "toast");
  /** What `openWorkspace` returns when its picker was dismissed: nothing opened,
   *  nothing written, nothing seeded. */
  const cancelled = {
    mode: "per-window" as const, briefs: [], opened: [], remoteControl: false,
    provider: "claude-code" as const, cancelled: true as const,
  };

  it("Take reports nothing when the picker is dismissed", async () => {
    ask();
    vi.mocked(openWorkspace).mockResolvedValue(cancelled);
    const { provider, posted } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    // Not "no success toast" — no toast at all. Dismissing a picker is not a failure
    // either, so an error toast would be just as wrong.
    expect(toasts(posted)).toEqual([]);
  });

  it("Take records a dismissed picker as cancelled, not as a completed launch", async () => {
    // The funnel's own reading of the same fact: `false` from launch() is what
    // take_completed maps to "cancelled", and a launch that reported "launched" here
    // would claim a session that does not exist.
    ask();
    vi.mocked(openWorkspace).mockResolvedValue(cancelled);
    const { provider } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(trackSpy).toHaveBeenCalledWith(
      expect.objectContaining({ name: "take_completed", outcome: "cancelled" }),
    );
  });

  it("Take's toast names the agent that actually started, not the setting's default", async () => {
    ask();
    vi.mocked(openWorkspace).mockResolvedValue({
      mode: "per-window", briefs: [], opened: ["/repos/account-service"], remoteControl: false, provider: "cursor",
    });
    const { provider, posted } = setup();
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(posted()).toContainEqual(
      expect.objectContaining({
        type: "toast", level: "success",
        message: expect.stringContaining("Cursor pre-seeded — press Enter to start."),
      }),
    );
  });

  it("Explore reports nothing when the picker is dismissed", async () => {
    ask({ exploreMode: "knowledge" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("focus");
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never);
    vi.mocked(openWorkspace).mockResolvedValue(cancelled);
    const { send, posted } = setup();
    await send({ type: "explore" });
    expect(toasts(posted)).toEqual([]);
  });

  it("Explore's toast names the agent that actually started", async () => {
    ask({ exploreMode: "knowledge" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("focus");
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never);
    vi.mocked(openWorkspace).mockResolvedValue({
      mode: "per-window", briefs: [], opened: ["/repos/account-service"], remoteControl: false, provider: "cursor",
    });
    const { send, posted } = setup();
    await send({ type: "explore" });
    expect(posted()).toContainEqual(
      expect.objectContaining({
        type: "toast", level: "success",
        message: expect.stringContaining("Cursor pre-seeded — press Enter to start."),
      }),
    );
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

  it("reports the requested filter and the clamped lens as distinct properties on tasks_fetched", async () => {
    const list = vi.fn(async () => [{ ...FIXTURE_TASKS[0] }]);
    const { send } = setup({ connector: withProvider({ list }) });
    await send({ type: "fetch", filter: "sprint", size: "any" });
    expect(trackSpy).toHaveBeenCalledWith({
      name: "tasks_fetched", filter: "sprint", lens: "mine", size: "any",
      task_count: 1, repo_count: 2, live_window_count: 0, authed: true,
    });
  });
});

describe("tasks_fetched telemetry", () => {
  it("emits authed:false with zero counts on the unauthenticated early return", async () => {
    const { send } = setup({ authed: false });
    await send({ type: "fetch", filter: "mysprint", size: "any" });
    // No provider was ever asked to clamp anything, so `lens` reports the
    // requested filter verbatim.
    expect(trackSpy).toHaveBeenCalledWith({
      name: "tasks_fetched", filter: "mysprint", lens: "mysprint", size: "any",
      task_count: 0, repo_count: 0, live_window_count: 0, authed: false,
    });
  });

  it("omits live_window_count when trackOpenWindows is off, on both the authed and unauthed paths", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, trackOpenWindows: false });
    const { send } = setup({ authed: false });
    await send({ type: "fetch", filter: "mine", size: "any" });
    const event = trackSpy.mock.calls.flat().find((e: any) => e.name === "tasks_fetched") as any;
    expect("live_window_count" in event).toBe(false);
  });

  it("fires exactly once per fetch — no double emit when the same message is sent twice", async () => {
    const { send } = setup();
    await send({ type: "fetch", filter: "mine", size: "any" });
    await send({ type: "fetch", filter: "mine", size: "any" });
    expect(trackSpy.mock.calls.flat().filter((e: any) => e.name === "tasks_fetched")).toHaveLength(2);
  });

  // `filter`/`size` are typed to their unions at compile time only — a webview
  // message is untyped at runtime, and there is no "invalid" member in
  // `tasks_fetched`'s unions to collapse an unrecognised value onto (unlike
  // SettingsSnapshot's enum-ish fields). The fetch itself must still proceed
  // unaffected; only the telemetry emit is withheld.
  it("emits no tasks_fetched for an out-of-union filter, on the authenticated path", async () => {
    const list = vi.fn(async () => []);
    const { send } = setup({ connector: withProvider({ list }) });
    await send({ type: "fetch", filter: "bogus" as never, size: "any" });
    expect(list).toHaveBeenCalled(); // the fetch itself is unaffected
    expect(trackSpy.mock.calls.flat().some((e: any) => e.name === "tasks_fetched")).toBe(false);
  });

  it("emits no tasks_fetched for an out-of-union size, on the authenticated path", async () => {
    const list = vi.fn(async () => []);
    const { send } = setup({ connector: withProvider({ list }) });
    await send({ type: "fetch", filter: "mine", size: "bogus" as never });
    expect(list).toHaveBeenCalled();
    expect(trackSpy.mock.calls.flat().some((e: any) => e.name === "tasks_fetched")).toBe(false);
  });

  it("emits no tasks_fetched for an out-of-union filter, on the unauthenticated early return", async () => {
    const { send } = setup({ authed: false });
    await send({ type: "fetch", filter: "bogus" as never, size: "any" });
    expect(trackSpy.mock.calls.flat().some((e: any) => e.name === "tasks_fetched")).toBe(false);
  });
});

describe("card_action telemetry", () => {
  it("emits card_action for a changeStatus message, from the dispatcher itself", async () => {
    const { send } = setup();
    await send({ type: "changeStatus", key: "PROJ-1" });
    expect(trackSpy).toHaveBeenCalledWith({ name: "card_action", action: "change_status" });
  });

  it("emits card_action for a detail message", async () => {
    const { send } = setup();
    await send({ type: "detail", key: "PROJ-1" });
    expect(trackSpy).toHaveBeenCalledWith({ name: "card_action", action: "detail" });
  });

  it("emits card_action for addToMySprint, removeFromSprint, and setComponent messages", async () => {
    const { send } = setup();
    await send({ type: "addToMySprint", key: "PROJ-1" });
    await send({ type: "removeFromSprint", key: "PROJ-1", size: "any" });
    await send({ type: "setComponent", key: "PROJ-1", repo: "account-service", on: true, movedChip: false });
    const names = trackSpy.mock.calls.flat().filter((e: any) => e.name === "card_action").map((e: any) => e.action);
    expect(names).toEqual(["add_to_sprint", "remove_from_sprint", "set_component"]);
  });

  it("emits card_action{reorder} only once the drag actually applies within My-sprint", async () => {
    const { send } = setup();
    await send({ type: "fetch", filter: "unassigned", size: "any" }); // lastFilter = unassigned
    await send({ type: "reorder", order: ["C", "A", "B"] });
    expect(trackSpy.mock.calls.flat().some((e: any) => e.name === "card_action")).toBe(false);
    await send({ type: "fetch", filter: "mysprint", size: "any" }); // lastFilter = mysprint
    await send({ type: "reorder", order: ["C", "A", "B"] });
    expect(trackSpy).toHaveBeenCalledWith({ name: "card_action", action: "reorder" });
  });

  it("emits card_action{reset_order}", async () => {
    const { send } = setup();
    await send({ type: "resetOrder", size: "any" });
    expect(trackSpy).toHaveBeenCalledWith({ name: "card_action", action: "reset_order" });
  });
});

describe("tasks:lensUsed", () => {
  it("tracks lens_used for a recognised lens", async () => {
    const { send } = setup();
    await send({ type: "tasks:lensUsed", lens: "search" });
    expect(trackSpy).toHaveBeenCalledWith({ name: "lens_used", lens: "search" });
  });

  it("tracks lens_used for the repo lens", async () => {
    const { send } = setup();
    await send({ type: "tasks:lensUsed", lens: "repo" });
    expect(trackSpy).toHaveBeenCalledWith({ name: "lens_used", lens: "repo" });
  });

  it("silently drops an unrecognised lens value", async () => {
    const { send } = setup();
    await send({ type: "tasks:lensUsed", lens: "bogus" as never });
    expect(trackSpy.mock.calls.flat().some((e: any) => e.name === "lens_used")).toBe(false);
  });
});

describe("notepad_action telemetry", () => {
  it("emits notepad_action for add, edit, and remove", async () => {
    const { send } = setup();
    await send({ type: "notepad:add", title: "First", body: "" });
    await send({ type: "notepad:update", id: "irrelevant", title: "x", body: "y" });
    await send({ type: "notepad:delete", id: "irrelevant" });
    const names = trackSpy.mock.calls.flat().filter((e: any) => e.name === "notepad_action").map((e: any) => e.action);
    expect(names).toEqual(["add", "edit", "remove"]);
  });

  it("emits notepad_action{image_add} for both notepad:addImage and notepad:pickImage", async () => {
    const { send } = setup();
    await send({ type: "notepad:add", title: "note", body: "" });
    await send({ type: "notepad:addImage", id: "ghost", dataBase64: "", mime: "image/png", name: "a.png" });
    expect(trackSpy).toHaveBeenCalledWith({ name: "notepad_action", action: "image_add" });
  });

  it("emits notepad_action{reorder} only once the drop actually changes the order", async () => {
    const { send } = setup();
    // No known notes at all — the reorder is a no-op and must not report a gesture
    // that changed nothing.
    await send({ type: "notepad:reorder", order: ["ghost"] });
    expect(trackSpy.mock.calls.flat().some((e: any) => e.name === "notepad_action")).toBe(false);
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
  // Image stores handed out by mkProvider, removed after each test. This file does
  // NOT mock `fs`, so the notepad's image code writes and unlinks for real here and
  // the assertions read the disk.
  const imageDirs: string[] = [];
  afterEach(() => {
    while (imageDirs.length > 0) fs.rmSync(imageDirs.pop()!, { recursive: true, force: true });
  });

  // A provider wired to a context whose globalState is a real in-memory map, so
  // these tests assert on what was actually persisted rather than on a spy.
  function mkProvider() {
    const store = new Map<string, unknown>();
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "np-store-"));
    imageDirs.push(storageDir);
    const ctx = {
      ...fakeContext(),
      // Top level, not nested: the provider reads `this.context.globalStorageUri`,
      // and what this object spreads in is fakeContext's RESULT, not its context.
      globalStorageUri: { fsPath: storageDir, scheme: "file", toString: () => storageDir },
      globalState: {
        get: (k: string, d?: unknown) => (store.has(k) ? store.get(k) : d),
        update: async (k: string, v: unknown) => void store.set(k, v),
      },
    } as unknown as ConstructorParameters<typeof TasksViewProvider>[0];
    const posted: unknown[] = [];
    const provider = new TasksViewProvider(ctx, makeFixtureConnector(), () => {});
    // The provider posts through its resolved webview; stand one in.
    (provider as unknown as { view: unknown }).view = {
      webview: {
        postMessage: (m: unknown) => void posted.push(m),
        // postNotepad converts each attached image's path through this, so a note
        // with images would throw against a stub that had only postMessage.
        asWebviewUri: (u: unknown) => u,
      },
    };
    // `onMessage` is private on the class — these tests drive it directly because
    // it IS the unit under test, matching how the rest of this file reaches it
    // (see the `send`/`handler` helpers above).
    const sendMsg = (m: InboundMessage) =>
      (provider as unknown as { onMessage(m: InboundMessage): Promise<void> }).onMessage(m);
    return { provider, posted, store, sendMsg, imageDir: path.join(storageDir, "notepad-images") };
  }

  const notesIn = (store: Map<string, unknown>) =>
    store.get("agentFlow.notepad") as { id: string; title: string; done: boolean }[] | undefined;

  const imagesOf = (store: Map<string, unknown>, i = 0) =>
    (store.get("agentFlow.notepad") as { images?: { id: string; ext: string; name: string }[] }[])[i].images;

  const seedNote = (store: Map<string, unknown>, over: Record<string, unknown> = {}) =>
    store.set("agentFlow.notepad", [{ id: "n1", title: "t", body: "", done: false, createdAt: 1, ...over }]);

  /** Put `<name>` files straight into a provider's image store, for the paths that
   * read or delete files the host did not just write. */
  const seedFiles = (imageDir: string, ...names: string[]): void => {
    fs.mkdirSync(imageDir, { recursive: true });
    for (const n of names) fs.writeFileSync(path.join(imageDir, n), "A");
  };

  it("posts one imageUris entry per stored image, and omits the field otherwise", () => {
    const { provider, posted, store } = mkProvider();
    store.set("agentFlow.notepad", [
      { id: "n1", title: "with", body: "", done: false, createdAt: 1,
        images: [{ id: "i1", ext: "png", name: "a.png" }, { id: "i2", ext: "webp", name: "b.webp" }] },
      { id: "n2", title: "without", body: "", done: false, createdAt: 2 },
    ]);
    provider.postNotepad();
    const last = posted.at(-1) as { type: string; notes: { id: string; imageUris?: string[] }[] };
    expect(last.type).toBe("notepad:notes");
    // Found by id, not by position: with no manual order the list posts
    // newest-first, so n2 leads.
    const withImages = last.notes.find((n) => n.id === "n1")!;
    const without = last.notes.find((n) => n.id === "n2")!;
    expect(withImages.imageUris).toHaveLength(2);
    expect(String(withImages.imageUris![0])).toContain("notepad-images/i1.png");
    expect(String(withImages.imageUris![1])).toContain("i2.webp");
    expect(without).not.toHaveProperty("imageUris");
  });

  it("writes a pasted image and stores its record on the note", async () => {
    const { store, sendMsg, imageDir } = mkProvider();
    seedNote(store);
    await sendMsg({ type: "notepad:addImage", id: "n1", dataBase64: Buffer.from("PNGDATA").toString("base64"), mime: "image/png", name: "shot.png" });
    const images = imagesOf(store)!;
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ ext: "png", name: "shot.png" });
    expect(fs.readFileSync(path.join(imageDir, `${images[0].id}.png`), "utf8")).toBe("PNGDATA");
  });

  it("toasts the reason and stores nothing when the type is unsupported", async () => {
    const { store, sendMsg, posted, imageDir } = mkProvider();
    seedNote(store);
    await sendMsg({ type: "notepad:addImage", id: "n1", dataBase64: "AAAA", mime: "application/pdf", name: "paper.pdf" });
    const toast = (posted as { type: string; level?: string; message?: string }[]).find((m) => m.type === "toast");
    expect(toast).toMatchObject({ level: "error" });
    expect(toast!.message).toContain("paper.pdf");
    expect(imagesOf(store)).toBeUndefined();
    expect(fs.existsSync(imageDir)).toBe(false);
  });

  it("ignores an addImage for a note that no longer exists", async () => {
    const { store, sendMsg, imageDir } = mkProvider();
    store.set("agentFlow.notepad", []);
    await sendMsg({ type: "notepad:addImage", id: "gone", dataBase64: "AAAA", mime: "image/png", name: "a.png" });
    expect(fs.existsSync(imageDir)).toBe(false);
  });

  it("attaches the pending images that arrive with notepad:add", async () => {
    const { store, sendMsg } = mkProvider();
    await sendMsg({
      type: "notepad:add",
      title: "New",
      body: "",
      images: [{ dataBase64: Buffer.from("A").toString("base64"), mime: "image/png", name: "a.png" }],
    });
    expect(imagesOf(store)).toHaveLength(1);
  });

  it("adds a note that is nothing but an image", async () => {
    const { store, sendMsg } = mkProvider();
    await sendMsg({
      type: "notepad:add",
      title: "",
      body: "",
      images: [{ dataBase64: Buffer.from("A").toString("base64"), mime: "image/png", name: "a.png" }],
    });
    expect(notesIn(store)).toHaveLength(1);
  });

  it("removes an image from the note and unlinks its file", async () => {
    const { store, sendMsg, imageDir } = mkProvider();
    seedFiles(imageDir, "i1.png", "i2.png");
    seedNote(store, { images: [{ id: "i1", ext: "png", name: "a.png" }, { id: "i2", ext: "png", name: "b.png" }] });
    await sendMsg({ type: "notepad:removeImage", id: "n1", imageId: "i1" });
    expect(imagesOf(store)!.map((i) => i.id)).toEqual(["i2"]);
    expect(fs.existsSync(path.join(imageDir, "i1.png"))).toBe(false);
    expect(fs.existsSync(path.join(imageDir, "i2.png"))).toBe(true);
  });

  it("drops the images key entirely once the last image is removed", async () => {
    const { store, sendMsg, imageDir } = mkProvider();
    seedFiles(imageDir, "i1.png");
    seedNote(store, { images: [{ id: "i1", ext: "png", name: "a.png" }] });
    await sendMsg({ type: "notepad:removeImage", id: "n1", imageId: "i1" });
    expect((store.get("agentFlow.notepad") as object[])[0]).not.toHaveProperty("images");
  });

  it("reads the picked file itself and attaches it", async () => {
    const { store, sendMsg, imageDir } = mkProvider();
    const src = path.join(path.dirname(imageDir), "pick.png");
    fs.writeFileSync(src, "PICKED");
    window.showOpenDialog.mockResolvedValue([{ fsPath: src }]);
    seedNote(store);
    await sendMsg({ type: "notepad:pickImage", id: "n1" });
    expect(imagesOf(store)![0]).toMatchObject({ ext: "png", name: "pick.png" });
  });

  it("does nothing when the picker is cancelled", async () => {
    const { store, sendMsg } = mkProvider();
    window.showOpenDialog.mockResolvedValue(undefined);
    seedNote(store);
    await sendMsg({ type: "notepad:pickImage", id: "n1" });
    expect(imagesOf(store)).toBeUndefined();
  });

  it("opens a thumbnail through the vscode.open command", async () => {
    const { store, sendMsg } = mkProvider();
    seedNote(store, { images: [{ id: "i1", ext: "gif", name: "a.gif" }] });
    await sendMsg({ type: "notepad:openImage", id: "n1", imageId: "i1" });
    expect(commands.executeCommand).toHaveBeenCalledWith(
      "vscode.open",
      expect.objectContaining({ fsPath: expect.stringContaining(path.join("notepad-images", "i1.gif")) }),
    );
  });

  it("unlinks a deleted note's images", async () => {
    const { store, sendMsg, imageDir } = mkProvider();
    seedFiles(imageDir, "i1.png");
    seedNote(store, { images: [{ id: "i1", ext: "png", name: "a.png" }] });
    await sendMsg({ type: "notepad:delete", id: "n1" });
    expect(fs.existsSync(path.join(imageDir, "i1.png"))).toBe(false);
  });

  it("unlinks the images of every note cleared as completed, and only those", async () => {
    const { store, sendMsg, imageDir } = mkProvider();
    seedFiles(imageDir, "i1.png", "i2.png");
    store.set("agentFlow.notepad", [
      { id: "n1", title: "done", body: "", done: true, createdAt: 1, images: [{ id: "i1", ext: "png", name: "a.png" }] },
      { id: "n2", title: "open", body: "", done: false, createdAt: 2, images: [{ id: "i2", ext: "png", name: "b.png" }] },
    ]);
    await sendMsg({ type: "notepad:clearCompleted" });
    expect(fs.existsSync(path.join(imageDir, "i1.png"))).toBe(false);
    expect(fs.existsSync(path.join(imageDir, "i2.png"))).toBe(true);
  });

  it("sweeps image files no note references", () => {
    const { provider, store, imageDir } = mkProvider();
    seedFiles(imageDir, "i1.png", "orphan.png");
    seedNote(store, { images: [{ id: "i1", ext: "png", name: "a.png" }] });
    provider.sweepNotepadImages();
    expect(fs.existsSync(path.join(imageDir, "orphan.png"))).toBe(false);
    expect(fs.existsSync(path.join(imageDir, "i1.png"))).toBe(true);
  });

  it("is a no-op when nothing was ever attached", () => {
    const { provider } = mkProvider();
    expect(() => provider.sweepNotepadImages()).not.toThrow();
  });

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

  it("leaves no lastRunKey on the note when the agent picker is dismissed", async () => {
    // The pointer is written after the launch precisely so a cancelled one leaves
    // nothing pointing at a run that was never created — which only holds if the
    // cancellation is noticed BEFORE the note is saved.
    vi.mocked(getConfig).mockReturnValue({ ...CFG, agentProvider: "ask" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never); // repo picker
    vi.mocked(openWorkspace).mockResolvedValue({
      mode: "per-window", briefs: [], opened: [], remoteControl: false, provider: "claude-code", cancelled: true,
    });
    const { store, posted, sendMsg } = mkProvider();
    await sendMsg({ type: "notepad:add", title: "Fix the retry banner", body: "it double-fires" });
    await sendMsg({ type: "notepad:run", id: notesIn(store)![0].id });
    expect((notesIn(store)![0] as { lastRunKey?: string }).lastRunKey).toBeUndefined();
    expect((posted as { type: string }[]).filter((m) => m.type === "toast")).toEqual([]);
  });

  it("names the agent the launch actually seeded in the note's toast", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, agentProvider: "ask" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never); // repo picker
    vi.mocked(openWorkspace).mockResolvedValue({
      mode: "per-window", briefs: [], opened: ["/repos/account-service"], remoteControl: false, provider: "cursor",
    });
    const { store, posted, sendMsg } = mkProvider();
    await sendMsg({ type: "notepad:add", title: "Fix the retry banner", body: "" });
    await sendMsg({ type: "notepad:run", id: notesIn(store)![0].id });
    expect(posted as { type: string; message?: string }[]).toContainEqual(
      expect.objectContaining({
        type: "toast", level: "success",
        message: expect.stringContaining("Cursor pre-seeded — press Enter to start."),
      }),
    );
  });

  it("carries the note's detail into the seeded prompt, not only into the brief", async () => {
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never); // repo picker
    const { store, sendMsg } = mkProvider();
    await sendMsg({ type: "notepad:add", title: "Fix the retry banner", body: "  it double-fires on 429  " });
    await sendMsg({ type: "notepad:run", id: notesIn(store)![0].id });

    const call = vi.mocked(openWorkspace).mock.calls.at(-1)![0];
    // The agent reads the detail without having to open the brief — the prompt is the
    // only thing it is guaranteed to see.
    expect(call.promptSuffix).toBe("Details from the note:\n\nit double-fires on 429");
    // The template itself stays the configured one: the detail rides beside it, so a
    // customized explorePrompts.general is never rewritten.
    expect(call.promptTemplate).toBe(CFG.exploreActions.find((a) => a.id === "general")!.prompt);
  });

  it("names the note's images in the brief and the prompt, and passes them as attachments", async () => {
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never); // repo picker
    const { store, sendMsg, imageDir } = mkProvider();
    seedFiles(imageDir, "i1.png");
    store.set("agentFlow.notepad", [{ id: "n1", title: "Rail colour", body: "see shots", done: false, createdAt: 1,
      images: [{ id: "i1", ext: "png", name: "before.png" }] }]);
    await sendMsg({ type: "notepad:run", id: "n1" });

    const call = vi.mocked(openWorkspace).mock.calls.at(-1)![0];
    expect(call.attachments).toEqual([
      { path: path.join(imageDir, "i1.png"), name: "before.png" },
    ]);
    expect(call.planMd).toContain("## Attached images");
    // Under this note's own run key, which is what keeps a note taken beside another
    // note's running agent from naming whichever screenshot landed in the checkout last.
    expect(call.planMd).toContain(".pick-task/images/notepad-rail-colour-n1/before.png");
    // Both halves of the suffix: the note's own words AND the images, since an
    // image the agent never opens is one the user typed nothing to replace.
    expect(call.promptSuffix).toContain("Details from the note:");
    expect(call.promptSuffix).toContain(".pick-task/images/notepad-rail-colour-n1/before.png");
  });

  it("leaves the brief and the prompt untouched for a note with no images", async () => {
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never); // repo picker
    const { store, sendMsg } = mkProvider();
    store.set("agentFlow.notepad", [{ id: "n1", title: "Plain", body: "detail", done: false, createdAt: 1 }]);
    await sendMsg({ type: "notepad:run", id: "n1" });

    const call = vi.mocked(openWorkspace).mock.calls.at(-1)![0];
    expect(call.attachments).toBeUndefined();
    expect(call.planMd).not.toContain("Attached images");
  });

  it("sends no prompt suffix for a note with no detail", async () => {
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never); // repo picker
    const { store, sendMsg } = mkProvider();
    await sendMsg({ type: "notepad:add", title: "Title only", body: "" });
    await sendMsg({ type: "notepad:run", id: notesIn(store)![0].id });
    expect(vi.mocked(openWorkspace).mock.calls.at(-1)![0].promptSuffix).toBeUndefined();
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

  const orderIn = (store: Map<string, unknown>) => store.get("agentFlow.notepadOrder") as string[] | undefined;
  const titles = (posted: unknown[]) =>
    (posted.at(-1) as { notes: { title: string }[] }).notes.map((n) => n.title);

  describe("reorder", () => {
    // Three notes, added oldest-first: the panel shows them newest-first (c, b, a).
    async function threeNotes() {
      const h = mkProvider();
      // Three adds this close together can land in the same millisecond, which
      // ties their createdAt and makes the "newest first" ordering this suite
      // asserts on non-deterministic. Force strictly increasing clock reads for
      // the three adds only; real Date.now() resumes for anything added after.
      let tick = 0;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => ++tick);
      await h.sendMsg({ type: "notepad:add", title: "a", body: "" });
      await h.sendMsg({ type: "notepad:add", title: "b", body: "" });
      await h.sendMsg({ type: "notepad:add", title: "c", body: "" });
      clock.mockRestore();
      return { ...h, ids: notesIn(h.store)!.map((n) => n.id) };
    }

    it("posts newest-first and ordered:false while no order exists", async () => {
      const { posted } = await threeNotes();
      expect(titles(posted)).toEqual(["c", "b", "a"]);
      expect((posted.at(-1) as { ordered: boolean }).ordered).toBe(false);
    });

    it("stores a dropped order and posts the notes in it", async () => {
      const { posted, store, sendMsg, ids } = await threeNotes();
      const [a, b, c] = ids;
      await sendMsg({ type: "notepad:reorder", order: [a, c, b] });
      expect(orderIn(store)).toEqual([a, c, b]);
      expect(titles(posted)).toEqual(["a", "c", "b"]);
      expect((posted.at(-1) as { ordered: boolean }).ordered).toBe(true);
    });

    it("keeps a note hidden by the filter in its slot on the first drag", async () => {
      const { store, sendMsg, ids } = await threeNotes();
      const [a, b, c] = ids;
      // The panel shows c, b, a; the user filters to Active with `b` done, so the
      // visible pair is c, a and they drag a above c.
      await sendMsg({ type: "notepad:toggleDone", id: b });
      await sendMsg({ type: "notepad:reorder", order: [a, c] });
      expect(orderIn(store)).toEqual([a, b, c]); // b keeps the middle slot
    });

    it("keeps a note hidden by the filter in its slot on a later drag, once a saved order already exists", async () => {
      const { store, sendMsg, ids } = await threeNotes();
      const [a, b, c] = ids;
      // A first drag (no filter active) establishes a saved order.
      await sendMsg({ type: "notepad:reorder", order: [a, c, b] });
      // Now the user filters to Active with `c` done, so the visible pair is a, b,
      // and they drag b above a — exercising the saved-order seed on a SECOND drag.
      await sendMsg({ type: "notepad:toggleDone", id: c });
      await sendMsg({ type: "notepad:reorder", order: [b, a] });
      expect(orderIn(store)).toEqual([b, c, a]); // c keeps its absolute slot (index 1)
    });

    it("puts a new note on top of an existing order", async () => {
      const { posted, store, sendMsg, ids } = await threeNotes();
      const [a, , c] = ids;
      await sendMsg({ type: "notepad:reorder", order: [a, c, ids[1]] });
      await sendMsg({ type: "notepad:add", title: "fresh", body: "" });
      expect(titles(posted)).toEqual(["fresh", "a", "c", "b"]);
      expect(orderIn(store)![0]).toBe(notesIn(store)!.find((n) => n.title === "fresh")!.id);
    });

    it("drops a deleted note's id from the order", async () => {
      const { store, sendMsg, ids } = await threeNotes();
      const [a, b, c] = ids;
      await sendMsg({ type: "notepad:reorder", order: [a, c, b] });
      await sendMsg({ type: "notepad:delete", id: c });
      expect(orderIn(store)).toEqual([a, b]);
    });

    it("drops cleared-completed ids from the order", async () => {
      const { store, sendMsg, ids } = await threeNotes();
      const [a, b, c] = ids;
      await sendMsg({ type: "notepad:reorder", order: [a, c, b] });
      await sendMsg({ type: "notepad:toggleDone", id: a });
      await sendMsg({ type: "notepad:clearCompleted" });
      expect(orderIn(store)).toEqual([c, b]);
    });

    it("resets to newest-first", async () => {
      const { posted, store, sendMsg, ids } = await threeNotes();
      await sendMsg({ type: "notepad:reorder", order: [ids[0], ids[2], ids[1]] });
      await sendMsg({ type: "notepad:resetOrder" });
      expect(orderIn(store)).toEqual([]);
      expect(titles(posted)).toEqual(["c", "b", "a"]);
      expect((posted.at(-1) as { ordered: boolean }).ordered).toBe(false);
    });

    it("ignores ids that are not notes", async () => {
      const { store, sendMsg, ids } = await threeNotes();
      await sendMsg({ type: "notepad:reorder", order: ["ghost", ids[0]] });
      expect(orderIn(store)).not.toContain("ghost");
    });

    it("ignores a reorder that names no known note", async () => {
      const { store, sendMsg } = await threeNotes();
      await sendMsg({ type: "notepad:reorder", order: ["ghost"] });
      expect(orderIn(store) ?? []).toEqual([]); // nothing written at all
    });

    it("leaves the order alone when a delete removes nothing", async () => {
      const { store, sendMsg, ids } = await threeNotes();
      await sendMsg({ type: "notepad:reorder", order: [ids[0], ids[2], ids[1]] });
      await sendMsg({ type: "notepad:delete", id: "ghost" });
      expect(orderIn(store)).toEqual([ids[0], ids[2], ids[1]]);
    });

    it("emits notepad_action{reorder} once the drop actually applies", async () => {
      const { sendMsg, ids } = await threeNotes();
      trackSpy.mockClear();
      const [a, b, c] = ids;
      await sendMsg({ type: "notepad:reorder", order: [a, c, b] });
      expect(trackSpy).toHaveBeenCalledWith({ name: "notepad_action", action: "reorder" });
    });

    it("does not emit notepad_action for a reorder that names no known note", async () => {
      const { sendMsg } = await threeNotes();
      trackSpy.mockClear();
      await sendMsg({ type: "notepad:reorder", order: ["ghost"] });
      expect(trackSpy.mock.calls.flat().some((e: any) => e.name === "notepad_action")).toBe(false);
    });
  });

  describe("sections", () => {
    const sectionsIn = (store: Map<string, unknown>) =>
      store.get("agentFlow.notepadSections") as { id: string; name: string }[] | undefined;
    const collapsedIn = (store: Map<string, unknown>) =>
      store.get("agentFlow.notepadCollapsed") as string[] | undefined;
    const postedSections = (posted: unknown[]) =>
      (posted.at(-1) as { sections: { id: string; name: string; collapsed: boolean }[] }).sections;

    it("adds a section and posts it back uncollapsed", async () => {
      const { posted, store, sendMsg } = mkProvider();
      await sendMsg({ type: "notepad:addSection", name: "Bugs" });
      expect(sectionsIn(store)!.map((s) => s.name)).toEqual(["Bugs"]);
      const id = sectionsIn(store)![0].id;
      expect(postedSections(posted)).toMatchObject([{ id, name: "Bugs", collapsed: false }]);
    });

    it("ignores an add whose name is blank", async () => {
      const { store, sendMsg } = mkProvider();
      await sendMsg({ type: "notepad:addSection", name: "   " });
      expect(sectionsIn(store) ?? []).toEqual([]);
    });

    it("renames a section in place", async () => {
      const { store, sendMsg } = mkProvider();
      await sendMsg({ type: "notepad:addSection", name: "Bugs" });
      const id = sectionsIn(store)![0].id;
      await sendMsg({ type: "notepad:renameSection", id, name: "Bugs & fixes" });
      expect(sectionsIn(store)![0].name).toBe("Bugs & fixes");
    });

    it("ignores a rename whose name is blank", async () => {
      const { store, sendMsg } = mkProvider();
      await sendMsg({ type: "notepad:addSection", name: "Bugs" });
      const id = sectionsIn(store)![0].id;
      await sendMsg({ type: "notepad:renameSection", id, name: "  " });
      expect(sectionsIn(store)![0].name).toBe("Bugs");
    });

    it("deletes a section and ungroups the notes filed under it", async () => {
      const { store, sendMsg } = mkProvider();
      await sendMsg({ type: "notepad:addSection", name: "Bugs" });
      const sectionId = sectionsIn(store)![0].id;
      await sendMsg({ type: "notepad:add", title: "fix it", body: "" });
      const noteId = notesIn(store)![0].id;
      await sendMsg({ type: "notepad:setSection", id: noteId, sectionId });

      await sendMsg({ type: "notepad:deleteSection", id: sectionId });

      expect(sectionsIn(store)).toEqual([]);
      expect((notesIn(store)![0] as { sectionId?: string }).sectionId).toBeUndefined();
    });

    it("files a note under a section, and clears it back to ungrouped", async () => {
      const { posted, store, sendMsg } = mkProvider();
      await sendMsg({ type: "notepad:addSection", name: "Bugs" });
      const sectionId = sectionsIn(store)![0].id;
      await sendMsg({ type: "notepad:add", title: "fix it", body: "" });
      const noteId = notesIn(store)![0].id;

      await sendMsg({ type: "notepad:setSection", id: noteId, sectionId });
      expect((notesIn(store)![0] as { sectionId?: string }).sectionId).toBe(sectionId);
      expect((posted.at(-1) as { notes: { sectionId?: string }[] }).notes[0].sectionId).toBe(sectionId);

      await sendMsg({ type: "notepad:setSection", id: noteId, sectionId: undefined });
      expect((notesIn(store)![0] as { sectionId?: string }).sectionId).toBeUndefined();
    });

    it("toggles a section collapsed and back, persisting across posts", async () => {
      const { posted, store, sendMsg } = mkProvider();
      await sendMsg({ type: "notepad:addSection", name: "Bugs" });
      const id = sectionsIn(store)![0].id;

      await sendMsg({ type: "notepad:toggleSectionCollapsed", id });
      expect(collapsedIn(store)).toEqual([id]);
      expect(postedSections(posted)[0].collapsed).toBe(true);

      await sendMsg({ type: "notepad:toggleSectionCollapsed", id });
      expect(collapsedIn(store)).toEqual([]);
      expect(postedSections(posted)[0].collapsed).toBe(false);
    });

    it("drops a deleted section's id from the collapsed set", async () => {
      const { store, sendMsg } = mkProvider();
      await sendMsg({ type: "notepad:addSection", name: "Bugs" });
      const id = sectionsIn(store)![0].id;
      await sendMsg({ type: "notepad:toggleSectionCollapsed", id });

      await sendMsg({ type: "notepad:deleteSection", id });
      expect(collapsedIn(store)).toEqual([]);
    });

    it("survives a globalState value that is not an array", async () => {
      const { provider, store, posted } = mkProvider();
      store.set("agentFlow.notepadSections", { corrupt: true });
      provider.postNotepad();
      expect(postedSections(posted)).toEqual([]);
    });
  });

  describe("explore telemetry", () => {
    const names = () => trackSpy.mock.calls.flat().map((e: any) => e.name);
    const events = () => trackSpy.mock.calls.flat() as any[];
    const find = (n: string) => events().find((e) => e.name === n);

    it("emits explore_started with source 'notepad' and mode 'general', then explore_completed on success", async () => {
      const repos = mkRepos(["account-service"]);
      vi.mocked(discoverRepos).mockReturnValue(repos);
      vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never); // repo picker
      const { store, sendMsg } = mkProvider();
      await sendMsg({ type: "notepad:add", title: "Fix the retry banner", body: "" });
      await sendMsg({ type: "notepad:run", id: notesIn(store)![0].id });

      expect(find("explore_started")).toMatchObject({ flow_id: "flow-1", mode: "general", source: "notepad" });
      expect(find("explore_completed")).toMatchObject({
        flow_id: "flow-1", outcome: "launched", mode: "general", provider: "claude-code", repo_count: 1, duration_ms: 42,
      });
      // notepad:run also emits the Task 9 notepad_action{run} click signal —
      // a separate event from the explore funnel above, fired at the dispatcher
      // itself rather than from inside runNotepadItem. `find` above would return
      // the EARLIER notepad_action{add} from the add call, so this reads the last
      // notepad_action instead of the first.
      const notepadActions = events().filter((e) => e.name === "notepad_action");
      expect(notepadActions.at(-1)).toMatchObject({ action: "run" });
    });

    it("emits explore_completed with cancel_point 'remote-control' (no explore_started) when the RC block refuses, but still emits notepad_action{run}", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, remoteControl: "on", agentProvider: "copilot" });
      const { store, sendMsg } = mkProvider();
      await sendMsg({ type: "notepad:add", title: "Fix the retry banner", body: "" });
      await sendMsg({ type: "notepad:run", id: notesIn(store)![0].id });
      expect(names()).not.toContain("explore_started");
      expect(find("explore_completed")).toMatchObject({ outcome: "cancelled", cancel_point: "remote-control", mode: "general", repo_count: 0 });
      // notepad_action{run} is tracked at the dispatcher itself, before runNotepadItem
      // is even called — it must survive a refusal deep inside that method untouched.
      // `find` would return the earlier notepad_action{add} from the add call above,
      // so read the LAST one instead of the first.
      const notepadActions = events().filter((e) => e.name === "notepad_action");
      expect(notepadActions.at(-1)).toMatchObject({ action: "run" });
    });

    it("emits only explore_completed with cancel_point 'repos' when no repos are found", async () => {
      vi.mocked(discoverRepos).mockReturnValue([]);
      const { store, sendMsg } = mkProvider();
      await sendMsg({ type: "notepad:add", title: "Fix the retry banner", body: "" });
      await sendMsg({ type: "notepad:run", id: notesIn(store)![0].id });
      expect(names()).not.toContain("explore_started");
      expect(find("explore_completed")).toMatchObject({ outcome: "cancelled", cancel_point: "repos", mode: "general", repo_count: 0 });
    });

    it("cancels with cancel_point 'kickoff' when the open-target picker is dismissed", async () => {
      vi.mocked(getConfig).mockReturnValue({ ...CFG, openIn: "ask" });
      vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined as never); // cancel open-target pick
      const { store, sendMsg } = mkProvider();
      await sendMsg({ type: "notepad:add", title: "Fix the retry banner", body: "" });
      await sendMsg({ type: "notepad:run", id: notesIn(store)![0].id });
      expect(find("explore_completed")).toMatchObject({ outcome: "cancelled", cancel_point: "kickoff", mode: "general", repo_count: 0 });
    });

    it("cancels with cancel_point 'agent' and the resolved repo_count when the agent picker is dismissed", async () => {
      const repos = mkRepos(["account-service"]);
      vi.mocked(discoverRepos).mockReturnValue(repos);
      vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never);
      vi.mocked(openWorkspace).mockResolvedValue({
        mode: "per-window", briefs: [], opened: [], remoteControl: false, provider: "claude-code", cancelled: true,
      });
      const { store, sendMsg } = mkProvider();
      await sendMsg({ type: "notepad:add", title: "Fix the retry banner", body: "" });
      await sendMsg({ type: "notepad:run", id: notesIn(store)![0].id });
      expect(find("explore_completed")).toMatchObject({ outcome: "cancelled", cancel_point: "agent", mode: "general", repo_count: 1 });
    });

    it("never sends the note title", async () => {
      const repos = mkRepos(["account-service"]);
      vi.mocked(discoverRepos).mockReturnValue(repos);
      vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never);
      const { store, sendMsg } = mkProvider();
      await sendMsg({ type: "notepad:add", title: "SECRET-TOPIC", body: "" });
      await sendMsg({ type: "notepad:run", id: notesIn(store)![0].id });
      expect(JSON.stringify(events())).not.toContain("SECRET-TOPIC");
    });
  });
});

describe("caps refresh", () => {
  it("posts the narrowed caps once the shape probe resolves", async () => {
    // The tab bar renders from the caps in `state`, which is posted before the shape is
    // known. This message is how a Kanban project's panel loses the three tabs it
    // cannot answer, without a second full `state` post — which also carries `me` and
    // would clobber a display name that had already arrived.
    clientStub.shapeSnapshot.mockReturnValue({ boardId: 5, hasSprints: false, boardCount: 1 });
    const { send, posted } = setup({ authed: true });
    await send({ type: "ready" });
    expect(clientStub.loadShape).toHaveBeenCalledTimes(1);
    expect(posted()).toContainEqual({
      type: "caps",
      caps: {
        supportedFilters: ["unassigned", "mine", "all"],
        sizes: true, labels: true, sprints: false, components: true,
      },
    });
  });

  it("still posts caps when the shape changes nothing, so the message is not itself a narrowing signal", async () => {
    // shapeSnapshot stays null (a scrum project, or an unreadable board list): the
    // posted caps must equal the ones `state` already carried, not a narrowed set.
    const { send, posted } = setup({ authed: true });
    await send({ type: "ready" });
    expect(posted()).toContainEqual({ type: "caps", caps: JIRA_CAPS });
  });

  it("posts no caps message for a connector that has no refreshCaps", async () => {
    const { posted } = await mountWith(makeFixtureConnector());
    expect(posted.filter((m) => m.type === "caps")).toEqual([]);
  });

  it("does not fail the first paint when the shape probe rejects", async () => {
    // refreshCaps is specified never to reject, but the host must not depend on a
    // connector honouring that — the task list is the real payload.
    clientStub.loadShape.mockRejectedValue(new Error("boom"));
    const { send, posted } = setup({ authed: true });
    await send({ type: "ready" });
    expect(posted()).toContainEqual(expect.objectContaining({ type: "tasks" }));
  });
});

// ── a ticket with children ─────────────────────────────────────────────────
// The wholesale client mock (makeClient) deliberately has NO `childrenOf`, so the
// Jira provider declares no `children` capability and every Take test above runs the
// pre-tree flow untouched. These blocks add the method locally, which is the only
// thing that turns the probe on.
describe("takeTask: a ticket with children", () => {
  /** One direct child of PROJ-1, which has no children of its own — so buildTree
   *  yields exactly one leaf. */
  const CHILDREN: Record<string, { key: string; summary: string; type: string; statusCategory: string }[]> = {
    "PROJ-1": [{ key: "PROJ-2", summary: "first bit", type: "Sub-task", statusCategory: "new" }],
  };
  /** The parent's branch, computed from the REAL branchName and the summary
   *  makeClient's getDetail actually returns ("Do the thing") — never a guessed slug,
   *  which would fail here as if the routing were wrong. */
  const PARENT_BRANCH = branchName("PROJ-1", "Do the thing");

  beforeEach(() => {
    clientStub.childrenOf = vi.fn(async (key: string) => CHILDREN[key] ?? []);
    // Every test below exercises the tree flow, which is gated off by default (Task
    // 10) — turn it on here, once, rather than in each test.
    vi.mocked(getConfig).mockReturnValue({ ...CFG, childWorktrees: true });
    // A *successful* worktree returns a path different from the main checkout —
    // takeBatch fails a child whose path came back unchanged (see its own describe).
    vi.mocked(createWorktrees).mockImplementation((s, key) =>
      s.map((r) => ({ ...r, path: `${r.path}/.claude/worktrees/${key}` })),
    );
  });
  afterEach(() => {
    // Neither implementation has a global reset (clearMocks only clears call history).
    vi.mocked(createWorktrees).mockImplementation((s) => s);
    vi.mocked(ensureBranch).mockReturnValue(true);
  });

  it("does not probe for children when the setting is off", async () => {
    // Default-off is the whole point: an existing user's Take must be byte-identical
    // until they opt in. Asserted through observable behavior — one detail read, no
    // tree pickers, one openWorkspace — rather than by spying on probeTree.
    vi.mocked(getConfig).mockReturnValue({ ...CFG, childWorktrees: false });
    const { provider } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(clientStub.childrenOf).not.toHaveBeenCalled();
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(openWorkspace).toHaveBeenCalledTimes(1);
  });

  it("probes when the setting is on", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, childWorktrees: true });
    const { provider } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card", ["account-service"]); // cancels at the mode picker
    expect(clientStub.childrenOf).toHaveBeenCalledWith("PROJ-1");
  });

  it("does not probe at all when the source has no children capability", async () => {
    delete (clientStub as { childrenOf?: unknown }).childrenOf;
    const { provider } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    // The pre-tree flow exactly: one ticket read (resolveKickoff's), no picker at all
    // (a preselected repo, taskMode "plan" and worktree "never" answer everything).
    expect(clientStub.getDetail).toHaveBeenCalledTimes(1);
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(openWorkspace).toHaveBeenCalledTimes(1);
  });

  it("asks how to work the leaves, counting them in the title", async () => {
    const { provider } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card", ["account-service"]); // cancels at the mode picker
    expect(vi.mocked(window.showQuickPick).mock.calls[0][1]).toEqual(
      expect.objectContaining({ title: "PROJ-1 — 1 leaf under it. How do you want to work them?" }),
    );
  });

  it("offers exactly the three modes, naming the parent on the third", async () => {
    const { provider } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    const items = vi.mocked(window.showQuickPick).mock.calls[0][0] as { label: string; detail: string }[];
    expect(items.map((i) => i.label)).toEqual([
      "A session per child",
      "One orchestrator session, children as subagents",
      "Just PROJ-1",
    ]);
    expect(items[0].detail).toBe("1 worktree, 1 session, each on its own branch");
    expect(items[1].detail).toBe("1 session in PROJ-1, 1 child worktree for it to dispatch into");
  });

  it("takes nothing when the mode picker is cancelled", async () => {
    const { provider, posted } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    // No git write and no window: cancelling the first question must leave nothing
    // behind, on disk or on screen.
    expect(ensureBranch).not.toHaveBeenCalled();
    expect(createWorktrees).not.toHaveBeenCalled();
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(posted().filter((m) => m.type === "toast")).toEqual([]);
  });

  it("pre-selects nothing in the leaf picker", async () => {
    answerPicks(pickFirst); // fan-out, then cancel the leaf picker
    const { provider } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    const items = vi.mocked(window.showQuickPick).mock.calls[1][0] as {
      label: string; description?: string; detail: string; picked?: boolean;
    }[];
    expect(items.map((i) => i.label)).toEqual(["PROJ-2 — first bit"]);
    // Every ticked row costs a worktree and a session, so nothing arrives ticked.
    expect(items.map((i) => i.picked)).toEqual([undefined]);
    expect(items[0].detail).toBe("PROJ-1 › PROJ-2");
    expect(items[0].description).toBe(undefined);
    expect(vi.mocked(window.showQuickPick).mock.calls[1][1]).toEqual(
      expect.objectContaining({ title: "Which of these do you want to take?", canPickMany: true }),
    );
  });

  it("marks a leaf that is already done", async () => {
    clientStub.childrenOf = vi.fn(async (key: string) =>
      key === "PROJ-1" ? [{ key: "PROJ-2", summary: "first bit", type: "Sub-task", statusCategory: "done" }] : [],
    );
    answerPicks(pickFirst);
    const { provider } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    const items = vi.mocked(window.showQuickPick).mock.calls[1][0] as { description?: string }[];
    expect(items.map((i) => i.description)).toEqual(["done"]);
  });

  it("marks a leaf whose key already has a run, and leaves an untaken one unmarked", async () => {
    // Taking this leaf overwrites the brief in a worktree a live session may be reading,
    // and in fan-out mode discards that child's run timestamps — for a ticket the user
    // never named individually. Labelled, never blocked: re-taking is legitimate.
    clientStub.childrenOf = vi.fn(async (key: string) =>
      key === "PROJ-1"
        ? [
            { key: "PROJ-2", summary: "first bit", type: "Sub-task", statusCategory: "new" },
            { key: "PROJ-9", summary: "untouched", type: "Sub-task", statusCategory: "new" },
          ]
        : [],
    );
    vi.mocked(readRuns).mockReturnValue([
      { key: "PROJ-2", summary: "first bit", url: "", createdAt: 1, repos: [] },
    ] as unknown as ReturnType<typeof readRuns>);
    answerPicks(pickFirst);
    const { provider } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    const items = vi.mocked(window.showQuickPick).mock.calls[1][0] as { label: string; description?: string }[];
    expect(items.map((i) => [i.label, i.description])).toEqual([
      ["PROJ-2 — first bit", "already taken"],
      ["PROJ-9 — untouched", undefined],
    ]);
  });

  it("marks a leaf whose own worktree holds a live session, with no run record at all", async () => {
    vi.mocked(readRuns).mockReturnValue([]);
    vi.mocked(readOpenSessions).mockReturnValue([
      { pid: 1, sessionId: "s1", cwd: "/repos/account-service/.claude/worktrees/PROJ-2", startedAt: 1, name: null },
    ]);
    answerPicks(pickFirst);
    const { provider } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    const items = vi.mocked(window.showQuickPick).mock.calls[1][0] as { description?: string }[];
    expect(items.map((i) => i.description)).toEqual(["already taken"]);
  });

  it("does not mark a leaf for a live session sitting in an ordinary checkout", async () => {
    // A session in `/repos/PROJ-2` is not a per-task worktree, so its directory name says
    // nothing about which ticket is being worked — marking on it would label leaves at
    // random.
    vi.mocked(readOpenSessions).mockReturnValue([
      { pid: 1, sessionId: "s1", cwd: "/repos/PROJ-2", startedAt: 1, name: null },
    ]);
    answerPicks(pickFirst);
    const { provider } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    const items = vi.mocked(window.showQuickPick).mock.calls[1][0] as { description?: string }[];
    expect(items.map((i) => i.description)).toEqual([undefined]);
  });

  it("says both when a leaf is done AND already taken", async () => {
    clientStub.childrenOf = vi.fn(async (key: string) =>
      key === "PROJ-1" ? [{ key: "PROJ-2", summary: "first bit", type: "Sub-task", statusCategory: "done" }] : [],
    );
    vi.mocked(readRuns).mockReturnValue([
      { key: "PROJ-2", summary: "first bit", url: "", createdAt: 1, repos: [] },
    ] as unknown as ReturnType<typeof readRuns>);
    answerPicks(pickFirst);
    const { provider } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    const items = vi.mocked(window.showQuickPick).mock.calls[1][0] as { description?: string }[];
    expect(items.map((i) => i.description)).toEqual(["done · already taken"]);
  });

  it("takes nothing when the leaf picker is cancelled", async () => {
    answerPicks(pickFirst);
    const { provider } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(ensureBranch).not.toHaveBeenCalled();
    expect(createWorktrees).not.toHaveBeenCalled();
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it("falls back to the ordinary single take when no leaf is selected", async () => {
    answerPicks(pickFirst, () => []); // fan-out, then tick nothing
    const { provider } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(ensureBranch).not.toHaveBeenCalled();
    expect(openWorkspace).toHaveBeenCalledTimes(1);
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ ticket: expect.objectContaining({ key: "PROJ-1" }) }),
    );
  });

  it("takes just the parent without asking which leaves", async () => {
    answerPicks((items: unknown[]) => items[2]); // "Just PROJ-1"
    const { provider } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(window.showQuickPick).toHaveBeenCalledTimes(1); // no leaf picker
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ ticket: expect.objectContaining({ key: "PROJ-1" }) }),
    );
  });

  it("routes fan-out into takeBatch with the parent branch as the base", async () => {
    answerPicks(pickFirst, (items: unknown[]) => [items[0]]);
    const { provider } = setup({ authed: true });
    const takeBatch = vi.spyOn(provider, "takeBatch").mockResolvedValue(undefined);
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(takeBatch).toHaveBeenCalledWith(["PROJ-2"], ["account-service"], {
      key: "PROJ-1",
      branch: PARENT_BRANCH,
    }, "fanout");
  });

  it("keeps a non-git folder out of the fan-out's repo set", async () => {
    // A fan-out child MUST have a worktree, so a non-git folder can only fail its task —
    // loudly, with a "Skipping notes — not a git repo" toast naming a folder the user
    // never picked.
    vi.mocked(discoverRepos).mockReturnValue([
      ...mkRepos(["account-service"]),
      ...mkRepos(["notes"], { isGit: false }),
    ]);
    answerPicks(pickFirst, (items: unknown[]) => [items[0]]);
    const { provider } = setup({ authed: true });
    const takeBatch = vi.spyOn(provider, "takeBatch").mockResolvedValue(undefined);
    await provider.takeTask("PROJ-1", "command");
    expect(takeBatch).toHaveBeenCalledWith(["PROJ-2"], ["account-service"], {
      key: "PROJ-1",
      branch: PARENT_BRANCH,
    }, "fanout");
  });

  it("says there is no git repo at all without a blank where names belong", async () => {
    // Every discovered folder is non-git, so the filtered fan-out set is empty and
    // resolveBatchRepos has no names to list.
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["notes", "scratch"], { isGit: false }));
    answerPicks(pickFirst, (items: unknown[]) => [items[0]]);
    const { provider, posted } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "command");
    expect(posted()).toContainEqual({
      type: "toast",
      level: "error",
      message: "No git repo under /repos. Each task opens a worktree.",
    });
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it("widens to every discovered repo only when the parent itself infers none", async () => {
    // takeBatch's repo argument is a FILTER, and an empty one means "nothing usable"
    // (resolveBatchRepos) — so the fan-out has to name a set. With no in-card selection
    // that set is the PARENT's inferred repos (see the test below); this fixture's
    // parent ("Do the thing", no labels or components) infers nothing, which is
    // reposForTask's documented last resort — every discovered repo.
    answerPicks(pickFirst, (items: unknown[]) => [items[0]]);
    const { provider } = setup({ authed: true });
    const takeBatch = vi.spyOn(provider, "takeBatch").mockResolvedValue(undefined);
    await provider.takeTask("PROJ-1", "command");
    expect(takeBatch).toHaveBeenCalledWith(["PROJ-2"], ["account-service", "webapp"], {
      key: "PROJ-1",
      branch: PARENT_BRANCH,
    }, "fanout");
  });

  /** Four repos where the PARENT confirms two of them via components (plus a label
   *  guess that must NOT widen the set) and the child infers none — the exact shape
   *  the fan-out's repo scoping is about. "nothing recognisable here" is the
   *  non-matching summary the takeBatch tests above already use. */
  function parentInfersTwoOfFourRepos(): void {
    vi.mocked(discoverRepos).mockReturnValue(
      mkRepos(["aardvark-service", "billing-service", "webapp", "delta-service"]),
    );
    clientStub.getDetail.mockImplementation(async (key: string) =>
      key === "PROJ-1"
        ? {
            key, summary: "the parent", descriptionText: "",
            labels: ["webapp"], components: ["billing-service", "delta-service"],
            url: `https://jira/browse/${key}`,
          }
        : {
            key, summary: "nothing recognisable here", descriptionText: "",
            labels: [], components: [], url: `https://jira/browse/${key}`,
          },
    );
  }

  it("bounds a child that infers nothing to the parent's own repos", async () => {
    parentInfersTwoOfFourRepos();
    answerPicks(pickFirst, (items: unknown[]) => [items[0]]);
    const { provider } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "command"); // no in-card selection
    // The child's ticket names no repo, so reposForTask widens to the whole filter set
    // it was handed — which is why that set has to be the parent's two repos and not
    // the four on the machine. By name: a count alone would pass on the wrong two.
    expect(
      vi.mocked(createWorktrees).mock.calls.map((c) => (c[0] as { name: string }[]).map((r) => r.name)),
    ).toEqual([["billing-service", "delta-service"]]);
    expect(vi.mocked(ensureBranch).mock.calls.map((c) => c[0])).toEqual([
      "/repos/billing-service",
      "/repos/delta-service",
    ]);
  });

  it("logs the repo set the fan-out resolved", async () => {
    parentInfersTwoOfFourRepos();
    answerPicks(pickFirst, (items: unknown[]) => [items[0]]);
    const { provider, logged } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "command");
    expect(logged).toContain("fan-out PROJ-1: 1 leaf into 2 repo(s) — billing-service, delta-service");
  });

  it("logs that set before any worktree is made, so a refusal still explains itself", async () => {
    parentInfersTwoOfFourRepos();
    vi.mocked(ensureBranch).mockReturnValue(false); // refuses before the first worktree
    answerPicks(pickFirst, (items: unknown[]) => [items[0]]);
    const { provider, logged } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "command");
    expect(createWorktrees).not.toHaveBeenCalled();
    expect(logged).toContain("fan-out PROJ-1: 1 leaf into 2 repo(s) — billing-service, delta-service");
  });

  it("actually branches the child off the parent, end to end", async () => {
    // Not a spy: the routing test above would pass just as happily against a repo
    // filter that makes takeBatch launch nothing at all.
    answerPicks(pickFirst, (items: unknown[]) => [items[0]]);
    const { provider } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(ensureBranch).toHaveBeenCalledWith("/repos/account-service", PARENT_BRANCH);
    expect(createWorktrees).toHaveBeenCalledWith(
      [expect.objectContaining({ name: "account-service" })],
      "PROJ-2",
      "Do the thing",
      expect.any(Function),
      { baseRef: PARENT_BRANCH },
    );
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ ticket: expect.objectContaining({ key: "PROJ-2" }), parentKey: "PROJ-1" }),
    );
  });

  it("opens no funnel for a take that becomes a fan-out", async () => {
    // takeBatch emits no telemetry at all — it is uninstrumented in Phase 1, which is
    // why "batch" sits reserved-but-unused in TakeSource (telemetry/events.ts). So
    // takeTask must not emit take_started and then walk away: nothing downstream would
    // ever terminate that funnel. Fan-out takes are absent from the funnel entirely.
    answerPicks(pickFirst, (items: unknown[]) => [items[0]]);
    const { provider } = setup({ authed: true });
    vi.spyOn(provider, "takeBatch").mockResolvedValue(undefined);
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(trackSpy.mock.calls.map((c) => (c[0] as { name: string }).name)).toEqual([]);
  });

  it("runs the ordinary single-ticket take when a capable source reports no children", async () => {
    // The most common real path once the setting is on, and the one whose absence hid a
    // Critical: capability present, setting on, and the site authoritatively answers
    // "no children". No picker, no toast, one ordinary take.
    clientStub.childrenOf = vi.fn(async () => []);
    const { provider, posted, logged } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(clientStub.childrenOf).toHaveBeenCalledWith("PROJ-1");
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(openWorkspace).toHaveBeenCalledTimes(1);
    // The ordinary take's own success toast and nothing else — in particular not
    // "Couldn't read the work under PROJ-1", which is what the ladder's throw produced
    // for every childless ticket on a team-managed project.
    expect(posted().filter((m) => m.type === "toast")).toEqual([
      {
        type: "toast",
        level: "success",
        message: "Opened 1 window(s) for PROJ-1. Brief seeded in each repo. Claude Code pre-seeded — press Enter to start.",
      },
    ]);
    expect(logged.filter((l) => l.startsWith("probeTree "))).toEqual([]);
    expect(createWorktrees).not.toHaveBeenCalled(); // "worktree: never" — the pre-tree flow exactly
  });

  it("offers the probe a cancel, and takes the ticket on its own when it is used", async () => {
    // A wide tree is hundreds of sequential reads; before this the only way out of the
    // wait was to keep waiting. Asserted on the real options object, because
    // `cancellable` is only honoured for a notification-located progress.
    vi.mocked(window.withProgress).mockImplementationOnce(
      async (_opts: unknown, task: (...a: any[]) => any) => task(noopProgress(), liveToken(true)),
    );
    const { provider, logged } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(vi.mocked(window.withProgress).mock.calls[0][0]).toEqual({
      location: ProgressLocation.Notification,
      title: "Looking for work under PROJ-1…",
      cancellable: true,
    });
    // The cancel routed to the ordinary take, not to an abandoned Take: no picker, and
    // the single-ticket flow ran to its window.
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(openWorkspace).toHaveBeenCalledTimes(1);
    expect(logged).toContain("probeTree PROJ-1: cancelled — taking the ticket on its own");
  });

  it("degrades to the ordinary take when the ticket read behind the probe fails", async () => {
    clientStub.getDetail.mockRejectedValueOnce(new Error("500")); // the probe's read only
    const { provider, logged } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(openWorkspace).toHaveBeenCalledTimes(1);
    expect(logged).toContain("probeTree PROJ-1: failed (Error: 500) — taking the ticket on its own");
  });

  it("says the work under the ticket could not be read, and takes it on its own", async () => {
    clientStub.childrenOf = vi.fn(async () => {
      throw new Error("500");
    });
    const { provider, logged, posted } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    // buildTree reports the unreadable root and yields no leaves — there is nothing to
    // offer, so the ordinary take runs and no picker appears…
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(openWorkspace).toHaveBeenCalledTimes(1);
    // …but the whole subtree has just been discarded, so it is said in both places
    // rather than nowhere: this is the path where the plain take LOOKS like success.
    expect(logged).toContain("probeTree PROJ-1: tree dropped 1 (PROJ-1)");
    expect(posted()).toContainEqual({
      type: "toast",
      level: "info",
      message: "Couldn't read the work under PROJ-1 — taking the ticket on its own.",
    });
  });

  /** 25 children, none with children of their own: 20 leaves survive MAX_TREE_LEAVES and
   *  K-20…K-24 are reported as dropped. */
  function overCapTree(): void {
    clientStub.childrenOf = vi.fn(async (key: string) =>
      key === "PROJ-1"
        ? Array.from({ length: 25 }, (_, i) => ({ key: `K-${i}`, summary: "x", type: "Sub-task", statusCategory: "new" }))
        : [],
    );
  }

  it("logs what the tree dropped", async () => {
    overCapTree();
    answerPicks(pickFirst, (items: unknown[]) => [items[0]]);
    const { provider, logged } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(vi.mocked(window.showQuickPick).mock.calls[0][1]).toEqual(
      expect.objectContaining({ title: "PROJ-1 — 20 leaves under it. How do you want to work them?" }),
    );
    expect(logged).toContain("probeTree PROJ-1: tree dropped 5 (K-20, K-21, K-22, K-23, K-24)");
  });

  it("names the omissions in the leaf picker's title", async () => {
    // On screen, not in a toast: the list is short, and a message that arrives after the
    // choice cannot fix a choice made from a list that looked complete.
    overCapTree();
    answerPicks(pickFirst);
    const { provider } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(vi.mocked(window.showQuickPick).mock.calls[1][1]).toEqual(
      expect.objectContaining({ title: "Which of these do you want to take? (20 of 25 — 5 not shown)" }),
    );
  });

  it("counts nothing as hidden when an offered leaf is the thing that was dropped", async () => {
    // Three children, one of which cannot be read. buildTree keeps that child as a leaf
    // — it is still real work — AND records it in `dropped`, because what went
    // unexplored is its subtree. So `leaves` and `dropped` overlap, all three leaves are
    // on screen, and nothing is hidden: a title claiming "3 of 4 — 1 not shown" would
    // invent a fourth item while the third sat visibly in the list.
    clientStub.childrenOf = vi.fn(async (key: string) => {
      if (key === "PROJ-1") {
        return [
          { key: "PROJ-2", summary: "first bit", type: "Sub-task", statusCategory: "new" },
          { key: "PROJ-3", summary: "second bit", type: "Sub-task", statusCategory: "new" },
          { key: "PROJ-4", summary: "third bit", type: "Sub-task", statusCategory: "new" },
        ];
      }
      if (key === "PROJ-3") throw new Error("500");
      return [];
    });
    answerPicks(pickFirst);
    const { provider, logged } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    const [items, opts] = vi.mocked(window.showQuickPick).mock.calls[1] as [
      { label: string }[],
      { title: string },
    ];
    expect(items.map((i) => i.label)).toEqual([
      "PROJ-2 — first bit",
      "PROJ-3 — second bit",
      "PROJ-4 — third bit",
    ]);
    expect(opts.title).toBe("Which of these do you want to take?");
    // The unexplored subtree is still reported — the overlap changes the arithmetic, not
    // the diagnostic.
    expect(logged).toContain("probeTree PROJ-1: tree dropped 1 (PROJ-3)");
  });

  it("counts and names a doubly-dropped key once", async () => {
    // 25 children, and K-21's own fetch fails: buildTree drops it for the unreadable
    // subtree AND again when the 20-leaf cap cuts it, because it reports one entry per
    // sighting. Undeduped, that read as "dropped 6 (K-21, K-20, K-21, …)" in the log and
    // as one more hidden item than exists in the picker's title.
    clientStub.childrenOf = vi.fn(async (key: string) => {
      if (key === "PROJ-1") {
        return Array.from({ length: 25 }, (_, i) => ({
          key: `K-${i}`, summary: "x", type: "Sub-task", statusCategory: "new",
        }));
      }
      if (key === "K-21") throw new Error("500");
      return [];
    });
    answerPicks(pickFirst);
    const { provider, logged } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(logged).toContain("probeTree PROJ-1: tree dropped 5 (K-21, K-20, K-22, K-23, K-24)");
    expect(vi.mocked(window.showQuickPick).mock.calls[1][1]).toEqual(
      expect.objectContaining({ title: "Which of these do you want to take? (20 of 25 — 5 not shown)" }),
    );
  });

  it("still logs the dropped leaves when the user takes just the parent", async () => {
    // The diagnostic belongs to the probe, not to the fan-out: this path never reaches
    // the leaf picker at all, and the leaves are dropped just the same.
    overCapTree();
    answerPicks((items: unknown[]) => items[2]); // "Just PROJ-1"
    const { provider, logged } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(window.showQuickPick).toHaveBeenCalledTimes(1);
    expect(openWorkspace).toHaveBeenCalledTimes(1);
    expect(logged).toContain("probeTree PROJ-1: tree dropped 5 (K-20, K-21, K-22, K-23, K-24)");
  });

  it("still logs the dropped leaves when the mode picker is cancelled", async () => {
    overCapTree();
    const { provider, logged } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(logged).toContain("probeTree PROJ-1: tree dropped 5 (K-20, K-21, K-22, K-23, K-24)");
  });

  it("does not claim the work was unreadable when the cap simply cut it", async () => {
    // The toast is for "nothing under this ticket could be read", which is not what a
    // 25-leaf tree is — the leaves that survived are on screen.
    overCapTree();
    answerPicks(pickFirst);
    const { provider, posted } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card", ["account-service"]);
    expect(posted().filter((m) => m.type === "toast")).toEqual([]);
  });
});

describe("takeBatch with a parent", () => {
  const PARENT = { key: "PROJ-1", branch: "PROJ-1-parent" };

  beforeEach(() => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    vi.mocked(createWorktrees).mockImplementation((s, key) =>
      s.map((r) => ({ ...r, path: `${r.path}/.claude/worktrees/${key}` })),
    );
  });
  afterEach(() => {
    // Neither implementation has a global reset (clearMocks only clears call history),
    // so both restores are load-bearing for the describes that follow.
    vi.mocked(createWorktrees).mockImplementation((s) => s);
    vi.mocked(ensureBranch).mockReturnValue(true);
  });

  /** A multi-key batch to a new window asks how to lay the tasks out; these tests are
   *  about the confirmation ahead of that, so answer it once here. */
  function answerLayout(): void {
    vi.mocked(window.showQuickPick).mockResolvedValue({ shared: false } as never);
  }

  it("asks before a fan-out over few keys but many repos", async () => {
    answerLayout();
    // 2 keys × 4 repos is 8 worktrees and 8 `git worktree add` calls. Counting keys, 2
    // is under the threshold of 6 and nothing was ever asked.
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api", "web", "jobs", "edge"]));
    vi.mocked(window.showWarningMessage).mockResolvedValueOnce("Launch" as never);
    const { provider } = setup({ authed: true });
    await provider.takeBatch(["PROJ-2", "PROJ-3"], ["api", "web", "jobs", "edge"], PARENT);
    expect(window.showWarningMessage).toHaveBeenCalledWith(
      "Launch 2 tasks in parallel? That's 2 Claude Code sessions and up to 8 git worktrees across 4 repos.",
      { modal: true },
      "Launch",
    );
    expect(openWorkspace).toHaveBeenCalledTimes(2);
  });

  it("launches nothing when that confirmation is declined", async () => {
    answerLayout();
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api", "web", "jobs", "edge"]));
    vi.mocked(window.showWarningMessage).mockResolvedValueOnce(undefined as never);
    const { provider } = setup({ authed: true });
    await provider.takeBatch(["PROJ-2", "PROJ-3"], ["api", "web", "jobs", "edge"], PARENT);
    expect(ensureBranch).not.toHaveBeenCalled();
    expect(createWorktrees).not.toHaveBeenCalled();
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it("says repo, singular, when the fan-out is confined to one", async () => {
    answerLayout();
    vi.mocked(window.showWarningMessage).mockResolvedValueOnce(undefined as never);
    const { provider } = setup({ authed: true });
    // 7 keys × 1 repo is 7 worktrees, over the threshold of 6.
    await provider.takeBatch(["A-1", "A-2", "A-3", "A-4", "A-5", "A-6", "A-7"], ["api"], PARENT);
    expect(window.showWarningMessage).toHaveBeenCalledWith(
      "Launch 7 tasks in parallel? That's 7 Claude Code sessions and up to 7 git worktrees across 1 repo.",
      { modal: true },
      "Launch",
    );
  });

  it("does not ask for the same key count in one repo", async () => {
    answerLayout();
    // The threshold is about worktrees: 2 keys × 1 repo is 2, well under 6.
    const { provider } = setup({ authed: true });
    await provider.takeBatch(["PROJ-2", "PROJ-3"], ["api"], PARENT);
    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(openWorkspace).toHaveBeenCalledTimes(2);
  });

  it("leaves the unparented batch counting keys, not worktrees", async () => {
    answerLayout();
    // Its threshold has meant "tasks" since it shipped, and that set was picked ticket by
    // ticket — 2 keys × 4 repos must still not prompt an existing user who changed nothing.
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api", "web", "jobs", "edge"]));
    const { provider } = setup({ authed: true });
    await provider.takeBatch(["PROJ-2", "PROJ-3"], ["api", "web", "jobs", "edge"]);
    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(openWorkspace).toHaveBeenCalledTimes(2);
  });

  it("makes the parent branch before the child worktree, then branches off it", async () => {
    const { provider } = setup({ authed: true });
    await provider.takeBatch(["PROJ-2"], ["api"], PARENT);
    expect(ensureBranch).toHaveBeenCalledWith("/repos/api", "PROJ-1-parent");
    expect(createWorktrees).toHaveBeenCalledWith(
      [expect.objectContaining({ name: "api" })],
      "PROJ-2",
      "Do the thing",
      expect.any(Function),
      { baseRef: "PROJ-1-parent" },
    );
    // Order matters: a worktree created before its base branch exists would silently
    // start from main.
    expect(vi.mocked(ensureBranch).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(createWorktrees).mock.invocationCallOrder[0],
    );
  });

  it("fails that child rather than branching off main when the parent branch cannot be made", async () => {
    vi.mocked(ensureBranch).mockReturnValue(false);
    const { provider, posted } = setup({ authed: true });
    await provider.takeBatch(["PROJ-2"], ["api"], PARENT);
    expect(createWorktrees).not.toHaveBeenCalled();
    expect(openWorkspace).not.toHaveBeenCalled();
    const toast = posted().find((m) => m.type === "toast") as { level: string; message: string };
    expect(toast.level).toBe("error");
    expect(toast.message).toBe(
      "Launched 0 of 1 in parallel. Failed: PROJ-2 (couldn't create the parent branch PROJ-1-parent in api)",
    );
  });

  it("stamps parentKey on each separate window's request", async () => {
    const { provider } = setup({ authed: true });
    await provider.takeBatch(["PROJ-2"], ["api"], PARENT);
    expect(openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ parentKey: "PROJ-1" }));
  });

  it("stamps parentKey on every task of a shared window", async () => {
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ shared: true } as never); // the layout pick
    const { provider } = setup({ authed: true });
    await provider.takeBatch(["PROJ-2", "PROJ-3"], ["api"], PARENT);
    const req = vi.mocked(openSharedWorkspace).mock.calls[0][0];
    expect(req.tasks.map((t) => t.parentKey)).toEqual(["PROJ-1", "PROJ-1"]);
  });

  it("touches no branch and stamps no parent without one", async () => {
    const { provider } = setup({ authed: true });
    await provider.takeBatch(["PROJ-2"], ["api"]);
    expect(ensureBranch).not.toHaveBeenCalled();
    expect(createWorktrees).toHaveBeenCalledWith(
      [expect.objectContaining({ name: "api" })],
      "PROJ-2",
      "Do the thing",
      expect.any(Function),
      {},
    );
    // Absent, not undefined: the run record must look exactly as it did before parents
    // existed (see Run.parentKey).
    expect("parentKey" in vi.mocked(openWorkspace).mock.calls[0][0]).toBe(false);
  });
});

// ── orchestrator mode ──────────────────────────────────────────────────────────
// One session in the PARENT's worktree, one child worktree per selected leaf for it
// to dispatch a subagent into. The children get worktrees in the parent's resolved
// repo set — an orchestrator can only dispatch into directories its own window sees.
describe("takeTask: orchestrator mode", () => {
  /** Computed from the REAL branchName and the summary the fixture's getDetail
   *  returns, never a guessed slug. */
  const PARENT_BRANCH = branchName("PROJ-1", "Do the thing");
  /** The shipped prompt modes include an `orchestrator` entry (src/config.ts); the
   *  base CFG's list deliberately does not, so the fallback has its own tests below. */
  const WITH_ORCHESTRATOR = [
    { id: "plan", label: "Plan", prompt: "P {key}" },
    { id: "orchestrator", label: "Orchestrator", prompt: "ORCH {key}" },
  ];

  beforeEach(() => {
    clientStub.childrenOf = vi.fn(async (key: string) =>
      key === "PROJ-1"
        ? [
            { key: "PROJ-2", summary: "first bit", type: "Sub-task", statusCategory: "new" },
            { key: "PROJ-3", summary: "second bit", type: "Sub-task", statusCategory: "new" },
          ]
        : [],
    );
    // Each ticket gets its OWN summary and description, so a brief built from the
    // parent's detail instead of the child's is visible rather than identical.
    clientStub.getDetail.mockImplementation(async (key: string) => ({
      key,
      summary: { "PROJ-1": "Do the thing", "PROJ-2": "first bit", "PROJ-3": "second bit" }[key] ?? key,
      descriptionText: `${key} description`,
      labels: [],
      components: [],
      url: `https://jira/browse/${key}`,
    }));
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api"]));
    // childWorktrees: true — every test below exercises the tree flow, gated off by
    // default (Task 10).
    vi.mocked(getConfig).mockReturnValue({ ...CFG, promptModes: WITH_ORCHESTRATOR, childWorktrees: true });
    // A *successful* worktree returns a path different from the main checkout — the
    // path-equality test the implementation uses to drop a child it could not place.
    vi.mocked(createWorktrees).mockImplementation((s, key) =>
      s.map((r) => ({ ...r, path: `${r.path}/.claude/worktrees/${key}` })),
    );
  });
  afterEach(() => {
    // Neither implementation has a global reset (clearMocks only clears call history).
    vi.mocked(createWorktrees).mockImplementation((s) => s);
    vi.mocked(ensureBranch).mockReturnValue(true);
  });

  /** The three pickers this path asks, in order: how to work the leaves, which leaves,
   *  and — from resolveKickoff, for a new window — which repos this task touches. */
  function answerOrchestrator(
    leaves: (items: unknown[]) => unknown = (items) => items,
    repos: (items: unknown[]) => unknown = (items) => items,
  ): void {
    answerPicks((items: unknown[]) => items[1], leaves, repos);
  }

  /** The child worktree rows the parent's run carries, as the mocked createWorktrees
   *  places them. */
  const CHILD_ROWS = [
    { key: "PROJ-2", summary: "first bit", repo: "api", path: "/repos/api/.claude/worktrees/PROJ-2", branch: "PROJ-2-first-bit" },
    { key: "PROJ-3", summary: "second bit", repo: "api", path: "/repos/api/.claude/worktrees/PROJ-3", branch: "PROJ-3-second-bit" },
  ];

  const openArg = () => vi.mocked(openWorkspace).mock.calls[0][0];
  /** Every createWorktrees call as [repo names, key, summary, options]. */
  const worktreeCalls = () =>
    vi.mocked(createWorktrees).mock.calls.map((c) => [
      (c[0] as { name: string }[]).map((r) => r.name),
      c[1],
      c[2],
      c[4],
    ]);

  it("creates one worktree per selected leaf, each off the parent branch", async () => {
    answerOrchestrator();
    const { provider } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card");
    // The children first, off the parent branch; then the parent's own worktree, which
    // takes NO baseRef because it IS the parent branch.
    expect(worktreeCalls()).toEqual([
      [["api"], "PROJ-2", "first bit", { baseRef: PARENT_BRANCH }],
      [["api"], "PROJ-3", "second bit", { baseRef: PARENT_BRANCH }],
      [["api"], "PROJ-1", "Do the thing", undefined],
    ]);
  });

  it("makes the parent branch in every in-scope repo before any child worktree", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api", "web"]));
    answerOrchestrator();
    const { provider } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card");
    expect(vi.mocked(ensureBranch).mock.calls).toEqual([
      ["/repos/api", PARENT_BRANCH],
      ["/repos/web", PARENT_BRANCH],
    ]);
    // Order matters: a worktree created before its base branch exists would silently
    // start from main.
    expect(vi.mocked(ensureBranch).mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(createWorktrees).mock.invocationCallOrder[0],
    );
  });

  it("gives a child one row per repo of the parent's set", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api", "web"]));
    answerOrchestrator((items) => [items[0]]); // one leaf, two repos
    const { provider } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card");
    expect(openArg().children).toEqual([
      { key: "PROJ-2", summary: "first bit", repo: "api", path: "/repos/api/.claude/worktrees/PROJ-2", branch: "PROJ-2-first-bit" },
      { key: "PROJ-2", summary: "first bit", repo: "web", path: "/repos/web/.claude/worktrees/PROJ-2", branch: "PROJ-2-first-bit" },
    ]);
  });

  it("opens exactly one session, on the parent, in a worktree, with the orchestrator prompt", async () => {
    answerOrchestrator();
    const { provider } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card");
    const calls = vi.mocked(openWorkspace).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0].ticket).toEqual({ key: "PROJ-1", summary: "Do the thing", url: "https://jira/browse/PROJ-1" });
    // Forced, even though CFG sets worktree: "never" — the orchestrator works on the
    // parent branch, isolated from the checkout its children branch out of.
    expect(calls[0][0].services.map((s) => s.path)).toEqual(["/repos/api/.claude/worktrees/PROJ-1"]);
    expect(calls[0][0].promptTemplate).toBe("ORCH {key}");
  });

  it("names every child worktree in the parent's brief", async () => {
    answerOrchestrator();
    const { provider } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card");
    const { planMd } = openArg();
    expect(planMd).toContain("## Children — one subagent each");
    expect(planMd).toContain("| PROJ-2 | first bit | `/repos/api/.claude/worktrees/PROJ-2` | `PROJ-2-first-bit` |");
    expect(planMd).toContain("| PROJ-3 | second bit | `/repos/api/.claude/worktrees/PROJ-3` | `PROJ-3-second-bit` |");
    expect(planMd).toContain(`Merge finished children into \`${PARENT_BRANCH}\`; never into main.`);
  });

  it("records the child worktrees on the parent's run", async () => {
    answerOrchestrator();
    const { provider } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card");
    expect(openArg().children).toEqual(CHILD_ROWS);
  });

  it("records the branch a reused worktree is ACTUALLY on, not the one the summary implies", async () => {
    // createWorktrees returns an existing worktree directory unchanged without checking
    // which branch it is on (engine/worktree.ts). After a Jira summary edit the computed
    // name therefore names a branch that does not exist — and that name is what the
    // drawer chip shows, what Run.children[] stores, and what the brief tells the
    // orchestrator to merge. Here every worktree sits on a stale slug.
    vi.mocked(currentBranch).mockImplementation((p: string) =>
      p.endsWith("/PROJ-2") ? "PROJ-2-the-old-summary" : p.endsWith("/PROJ-3") ? "PROJ-3-also-stale" : "PROJ-1-stale-parent",
    );
    answerOrchestrator();
    const { provider } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card");
    expect(vi.mocked(currentBranch).mock.calls.map((c) => c[0])).toEqual([
      "/repos/api/.claude/worktrees/PROJ-2",
      "/repos/api/.claude/worktrees/PROJ-3",
      "/repos/api/.claude/worktrees/PROJ-1",
    ]);
    expect(openArg().children).toEqual([
      { ...CHILD_ROWS[0], branch: "PROJ-2-the-old-summary" },
      { ...CHILD_ROWS[1], branch: "PROJ-3-also-stale" },
    ]);
    // The brief's table and its merge instruction name the observed branches too — the
    // orchestrator is told to merge into the branch its own worktree is on.
    const { planMd } = openArg();
    expect(planMd).toContain("| PROJ-2 | first bit | `/repos/api/.claude/worktrees/PROJ-2` | `PROJ-2-the-old-summary` |");
    expect(planMd).toContain("| PROJ-3 | second bit | `/repos/api/.claude/worktrees/PROJ-3` | `PROJ-3-also-stale` |");
    expect(planMd).toContain("Merge finished children into `PROJ-1-stale-parent`; never into main.");
    // Not the computed names, anywhere.
    expect(planMd).not.toContain("PROJ-2-first-bit");
    expect(planMd).not.toContain(PARENT_BRANCH);
  });

  it("falls back to the computed branch name when git cannot answer", async () => {
    // The default mock: `currentBranch` answers null for a path git cannot read. The
    // rows then read exactly as they did before the observation was added.
    answerOrchestrator();
    const { provider } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card");
    expect(openArg().children).toEqual(CHILD_ROWS);
    expect(openArg().planMd).toContain(`Merge finished children into \`${PARENT_BRANCH}\`; never into main.`);
  });

  it("writes a brief into each child worktree, built from that child's own detail", async () => {
    answerOrchestrator();
    const { provider } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card");
    const calls = vi.mocked(writeBriefInto).mock.calls;
    expect(calls.map((c) => [(c[0] as { path: string }[]).map((s) => s.path), c[1]])).toEqual([
      [["/repos/api/.claude/worktrees/PROJ-2"], { key: "PROJ-2", summary: "first bit", url: "https://jira/browse/PROJ-2" }],
      [["/repos/api/.claude/worktrees/PROJ-3"], { key: "PROJ-3", summary: "second bit", url: "https://jira/browse/PROJ-3" }],
    ]);
    // The child's own ticket text, not the parent's — a subagent reads a real brief,
    // not a row in the parent's table.
    expect(calls[0][2]).toContain("## PROJ-2: first bit");
    expect(calls[0][2]).toContain("PROJ-2 description");
    expect(calls[1][2]).toContain("## PROJ-3: second bit");
    expect(calls[1][2]).toContain("PROJ-3 description");
  });

  it("falls back to the leaf's own key and summary when the child's detail cannot be read", async () => {
    clientStub.getDetail.mockImplementation(async (key: string) => {
      if (key === "PROJ-3") throw new Error("500");
      return {
        key,
        summary: key === "PROJ-1" ? "Do the thing" : "first bit",
        descriptionText: `${key} description`,
        labels: [],
        components: [],
        url: `https://jira/browse/${key}`,
      };
    });
    answerOrchestrator();
    const { provider } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card");
    const calls = vi.mocked(writeBriefInto).mock.calls;
    // A failed detail fetch degrades to what the leaf already knew — it must not cost
    // the child its worktree, its brief, or the take.
    expect(calls[1][1]).toEqual({ key: "PROJ-3", summary: "second bit", url: "" });
    expect(calls[1][2]).toContain("## PROJ-3: second bit");
    expect(calls[1][2]).toContain("_(No description on the ticket.)_");
    expect(openArg().children).toEqual(CHILD_ROWS);
  });

  it("skips a child whose worktree could not be made, and says so", async () => {
    // createWorktrees hands back the ORIGINAL ref when it could not create the
    // worktree — a subagent dispatched there would be in the parent's own checkout.
    vi.mocked(createWorktrees).mockImplementation((s, key) =>
      key === "PROJ-3" ? s : s.map((r) => ({ ...r, path: `${r.path}/.claude/worktrees/${key}` })),
    );
    answerOrchestrator();
    const { provider, posted } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card");
    expect(openArg().children).toEqual([CHILD_ROWS[0]]);
    expect(openArg().planMd).not.toContain("PROJ-3");
    // No brief in the main checkout either: the child is dropped whole.
    expect(vi.mocked(writeBriefInto).mock.calls.map((c) => (c[1] as { key: string }).key)).toEqual(["PROJ-2"]);
    expect(posted()).toContainEqual({
      type: "toast",
      level: "info",
      message: "Couldn't create a worktree for PROJ-3 — dispatch those by hand.",
    });
  });

  it("still opens the orchestrator session when no child worktree could be made", async () => {
    vi.mocked(createWorktrees).mockImplementation((s, key) =>
      key === "PROJ-1" ? s.map((r) => ({ ...r, path: `${r.path}/.claude/worktrees/${key}` })) : s,
    );
    answerOrchestrator();
    const { provider, posted } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card");
    expect(vi.mocked(openWorkspace).mock.calls).toHaveLength(1);
    // Absent, not empty: a run with no children must read exactly like a run taken
    // before children existed (see Run.children), and the brief keeps no table.
    expect("children" in openArg()).toBe(false);
    expect(openArg().planMd).not.toContain("## Children — one subagent each");
    expect(posted()).toContainEqual({
      type: "toast",
      level: "info",
      message: "Couldn't create a worktree for PROJ-2, PROJ-3 — dispatch those by hand.",
    });
  });

  it("still opens when the parent's set includes a non-git repo", async () => {
    // createWorktrees returns the ref UNCHANGED for a non-git repo *by design* — the
    // same shape as its failure return. Mixed sets are supported and resolveKickoff's
    // picker offers non-git repos, so the guard above must not read "nothing to
    // isolate here" as "the worktree failed".
    vi.mocked(discoverRepos).mockReturnValue([
      { name: "api", path: "/repos/api", isGit: true },
      { name: "docs", path: "/repos/docs", isGit: false },
    ]);
    vi.mocked(createWorktrees).mockImplementation((s, key) =>
      s.map((r) => (r.isGit ? { ...r, path: `${r.path}/.claude/worktrees/${key}` } : r)),
    );
    answerOrchestrator();
    const { provider, posted } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card");
    // Nothing failed, so nothing is refused — asserted first, because the refusal's
    // toast is the symptom that names what went wrong.
    expect(posted().filter((m) => m.type === "toast" && m.level === "error")).toEqual([]);
    expect(vi.mocked(openWorkspace).mock.calls).toHaveLength(1);
    // The non-git repo is named here on purpose: it is a legitimate root of this
    // session, so a future filter that silently dropped it fails this assertion.
    expect(openArg().services.map((s) => [s.name, s.path])).toEqual([
      ["api", "/repos/api/.claude/worktrees/PROJ-1"],
      ["docs", "/repos/docs"],
    ]);
    // Only the git repo can hold the parent branch, and only it yields child rows —
    // the per-child `usable` filter drops the non-git one, which is already correct.
    expect(vi.mocked(ensureBranch).mock.calls).toEqual([["/repos/api", PARENT_BRANCH]]);
    expect(openArg().children).toEqual(CHILD_ROWS);
  });

  it("refuses to open the orchestrator in the main checkout when its own worktree fails", async () => {
    // The parent's `-b` attempt ALWAYS fails on this path — ensureBranch has already
    // made the branch — so createWorktrees always takes its attach path, which fails
    // whenever the parent branch is checked out anywhere else. Proceeding would seed a
    // session whose brief says to merge every child into that branch, in the user's own
    // checkout: it would check the branch out over whatever they have open and write
    // merge commits there.
    vi.mocked(createWorktrees).mockImplementation((s, key) =>
      key === "PROJ-1" ? s : s.map((r) => ({ ...r, path: `${r.path}/.claude/worktrees/${key}` })),
    );
    answerOrchestrator();
    const { provider, posted } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card");
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(posted()).toContainEqual({
      type: "toast",
      level: "error",
      message:
        "Couldn't create a git worktree for PROJ-1 in api — not opening an orchestrator in your main checkout. The Agent Flow Deck output channel has the reason.",
    });
  });

  it("refuses the whole take when the parent branch cannot be made", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api", "web"]));
    vi.mocked(ensureBranch).mockReturnValue(false);
    answerOrchestrator();
    const { provider, posted } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card");
    expect(createWorktrees).not.toHaveBeenCalled();
    expect(writeBriefInto).not.toHaveBeenCalled();
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(posted()).toContainEqual({
      type: "toast",
      level: "error",
      message: `Couldn't create the parent branch ${PARENT_BRANCH} in api, web — nothing was taken.`,
    });
  });

  it("honours the in-card repo selection instead of asking for it again", async () => {
    // The selection made on the card is the only repo intent the user has expressed on
    // this take, and a fan-out reached from the SAME picker honours it — asking again
    // here would make one mode ask three questions where the other asks two.
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api", "web"]));
    answerPicks((items: unknown[]) => items[1], (items: unknown[]) => items);
    const { provider } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card", ["web"]);
    // Two pickers, not three: the tree mode and the leaves.
    expect(window.showQuickPick).toHaveBeenCalledTimes(2);
    // By name, in the preselected repo only — `api` is discovered and never touched.
    expect(vi.mocked(ensureBranch).mock.calls).toEqual([["/repos/web", PARENT_BRANCH]]);
    expect(worktreeCalls()).toEqual([
      [["web"], "PROJ-2", "first bit", { baseRef: PARENT_BRANCH }],
      [["web"], "PROJ-3", "second bit", { baseRef: PARENT_BRANCH }],
      [["web"], "PROJ-1", "Do the thing", undefined],
    ]);
    expect(openArg().children).toEqual([
      { key: "PROJ-2", summary: "first bit", repo: "web", path: "/repos/web/.claude/worktrees/PROJ-2", branch: "PROJ-2-first-bit" },
      { key: "PROJ-3", summary: "second bit", repo: "web", path: "/repos/web/.claude/worktrees/PROJ-3", branch: "PROJ-3-second-bit" },
    ]);
  });

  it("takes nothing when the repo picker is cancelled", async () => {
    answerOrchestrator((items) => items, () => undefined);
    const { provider } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card");
    expect(ensureBranch).not.toHaveBeenCalled();
    expect(createWorktrees).not.toHaveBeenCalled();
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it("says which of a child's own repos the parent's set leaves out", async () => {
    // The child works the PARENT's repos: an orchestrator can only dispatch into
    // directories its own window can see. Narrowing silently would leave a subagent
    // working somewhere the ticket never named, with no record of why.
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["api", "web"]));
    clientStub.getDetail.mockImplementation(async (key: string) => ({
      key,
      summary: { "PROJ-1": "Do the thing", "PROJ-2": "first bit", "PROJ-3": "second bit" }[key] ?? key,
      descriptionText: "",
      labels: key === "PROJ-3" ? ["web"] : [],
      components: [],
      url: `https://jira/browse/${key}`,
    }));
    answerOrchestrator((items) => items, (items) => [items[0]]); // api only
    const { provider, logged } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card");
    expect(logged).toContain("orchestrator PROJ-3: skipping web — outside the parent's repos (api)");
    // …and it still gets its worktree, in the parent's set.
    expect(openArg().children).toEqual(CHILD_ROWS);
  });

  it("falls back to the first configured mode, out loud, when no orchestrator mode is configured", async () => {
    // A user can delete or rename prompt modes. Falling back silently would hand the
    // session a prompt that never mentions subagents while the brief's Children table
    // tells it to dispatch them.
    vi.mocked(getConfig).mockReturnValue({ ...CFG, childWorktrees: true });
    answerOrchestrator();
    const { provider, logged } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card");
    expect(openArg().promptTemplate).toBe("P {key}");
    expect(logged).toContain(
      'orchestrator mode: no "orchestrator" prompt mode configured — falling back to Plan',
    );
  });

  it("still takes the parent when the prompt-mode list is empty", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, promptModes: [], childWorktrees: true });
    answerOrchestrator();
    const { provider, logged } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card");
    expect(openArg().promptTemplate).toBe("");
    expect(logged).toContain(
      'orchestrator mode: no "orchestrator" prompt mode configured — falling back to the default prompt',
    );
  });

  it("opens no funnel for a take that becomes an orchestrator run", async () => {
    // Same reason fan-out emits nothing: takeOrchestrated is uninstrumented, so a
    // take_started here would open a funnel nothing ever terminates.
    answerOrchestrator();
    const { provider } = setup({ authed: true });
    await provider.takeTask("PROJ-1", "card");
    expect(trackSpy.mock.calls.map((c) => (c[0] as { name: string }).name)).toEqual([]);
  });
});

describe("setAttention", () => {
  // Deliberately minimal and local: setAttention touches nothing but `view.badge`,
  // and the file's full mount helper builds a webview these tests never use.
  const bareView = () => {
    // `dispose()` fires what the provider subscribed to, which is how VS Code
    // signals a hidden sidebar's view going away.
    const listeners: (() => void)[] = [];
    return {
      title: "Tasks", description: undefined as string | undefined,
      badge: undefined as unknown,
      onDidDispose: (cb: () => void) => {
        listeners.push(cb);
        return { dispose() {} };
      },
      dispose: () => listeners.forEach((l) => l()),
      webview: {
        options: {}, html: "", asWebviewUri: (u: unknown) => u, cspSource: "",
        postMessage: vi.fn(), onDidReceiveMessage: () => ({ dispose() {} }),
      },
    };
  };
  const bareProvider = () =>
    new TasksViewProvider(fakeContext().context as never, makeFixtureConnector() as never, () => {});

  it("badges the count of sessions waiting on you", () => {
    const provider = bareProvider();
    const view = bareView();
    provider.resolveWebviewView(view as never);
    provider.setAttention(["BITE-1", "BITE-2"]);
    expect(view.badge).toEqual({ value: 2, tooltip: "2 sessions are waiting on you — open the Deck" });
  });

  it("says session, singular, for one", () => {
    const provider = bareProvider();
    const view = bareView();
    provider.resolveWebviewView(view as never);
    provider.setAttention(["BITE-1"]);
    expect(view.badge).toEqual({ value: 1, tooltip: "1 session is waiting on you — open the Deck" });
  });

  it("clears the badge to undefined rather than badging a zero", () => {
    const provider = bareProvider();
    const view = bareView();
    provider.resolveWebviewView(view as never);
    provider.setAttention(["BITE-1"]);
    provider.setAttention([]);
    expect(view.badge).toBeUndefined();
  });

  it("applies a count set before the sidebar was ever opened", () => {
    // VS Code resolves a webview view lazily, so the first ticks of a window land
    // before there is any view to badge. Dropping them would mean no badge at all
    // until the count next changed.
    const provider = bareProvider();
    provider.setAttention(["BITE-1", "BITE-2"]);
    const view = bareView();
    provider.resolveWebviewView(view as never);
    expect(view.badge).toEqual({ value: 2, tooltip: "2 sessions are waiting on you — open the Deck" });
  });

  it("does not throw when no view has ever been resolved", () => {
    expect(() => bareProvider().setAttention(["BITE-1"])).not.toThrow();
  });

  it("lets go of a view VS Code disposed, rather than writing to a dead one", () => {
    // A hidden sidebar's WebviewView is disposed, and `.badge` on a disposed view
    // throws. runAttentionPass swallows that (best-effort by design), so the badge
    // would silently stop updating for the rest of the window's life.
    const provider = bareProvider();
    const view = bareView();
    provider.resolveWebviewView(view as never);
    view.dispose();
    Object.defineProperty(view, "badge", {
      get: () => undefined,
      set: () => { throw new Error("Webview is disposed"); },
    });
    expect(() => provider.setAttention(["BITE-1"])).not.toThrow();
  });

  it("replays the count onto the view that resolves after a dispose", () => {
    // The count lives in a field, so nothing is lost while there is no view —
    // the same reason a count set before the first resolve is applied on resolve.
    const provider = bareProvider();
    const first = bareView();
    provider.resolveWebviewView(first as never);
    first.dispose();
    // As VS Code behaves: touching a disposed view throws. Without the handle
    // being dropped, this setAttention is the throw itself.
    Object.defineProperty(first, "badge", {
      get: () => undefined,
      set: () => { throw new Error("Webview is disposed"); },
    });
    provider.setAttention(["BITE-1", "BITE-2"]);
    const second = bareView();
    provider.resolveWebviewView(second as never);
    expect(second.badge).toEqual({ value: 2, tooltip: "2 sessions are waiting on you — open the Deck" });
  });

  it("ignores an older view's dispose once a newer one has resolved", () => {
    // VS Code can resolve the replacement before disposing the old view; clearing
    // `this.view` unconditionally would then drop the badge on a live view.
    const provider = bareProvider();
    const first = bareView();
    provider.resolveWebviewView(first as never);
    const second = bareView();
    provider.resolveWebviewView(second as never);
    first.dispose();
    provider.setAttention(["BITE-1"]);
    expect(second.badge).toEqual({ value: 1, tooltip: "1 session is waiting on you — open the Deck" });
  });
});

describe("take — in-flight guard", () => {
  it("a double-fired Take for one key launches once, not two windows", async () => {
    // A double-click on the card's Take with openIn:"new-window" and worktree
    // settings that need no QuickPick fires two whole takes for one ticket —
    // two windows, two worktrees. The first take holds the key while it runs.
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["acme-billing"]));
    let release!: () => void;
    vi.mocked(openWorkspace).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              mode: "per-window",
              workspaceFile: undefined,
              briefs: [],
              opened: ["/repos/acme-billing"],
              remoteControl: false,
              provider: "claude-code",
            } as never);
        }),
    );
    const { send } = setup();
    const first = send({ type: "take", key: "BILL-1234", services: ["acme-billing"] });
    const second = send({ type: "take", key: "BILL-1234", services: ["acme-billing"] });
    await second; // the duplicate must return without launching anything
    // The first take is still mid-flight — wait until it reaches the (deferred)
    // window open, then let it finish.
    await vi.waitFor(() => expect(vi.mocked(openWorkspace)).toHaveBeenCalled());
    release();
    await first;
    expect(vi.mocked(openWorkspace)).toHaveBeenCalledTimes(1);
  });

  it("covers the palette command source too, and releases the key when the take settles", async () => {
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["acme-billing"]));
    let release!: () => void;
    vi.mocked(openWorkspace).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              mode: "per-window",
              workspaceFile: undefined,
              briefs: [],
              opened: ["/repos/acme-billing"],
              remoteControl: false,
              provider: "claude-code",
            } as never);
        }),
    );
    const { provider } = setup();
    const first = provider.takeTask("BILL-1234", "command", ["acme-billing"]);
    const dup = provider.takeTask("BILL-1234", "command", ["acme-billing"]);
    await dup;
    await vi.waitFor(() => expect(vi.mocked(openWorkspace)).toHaveBeenCalled());
    release();
    await first;
    expect(vi.mocked(openWorkspace)).toHaveBeenCalledTimes(1);
    // Settled: the key is released, so a deliberate second take still works.
    await provider.takeTask("BILL-1234", "command", ["acme-billing"]);
    expect(vi.mocked(openWorkspace)).toHaveBeenCalledTimes(2);
  });
});

describe("takeTask — palette (command) failure surfacing", () => {
  it("toasts and logs when the ticket read fails on a command take, not just the host's generic error", async () => {
    // The palette command is registered as a bare handler in extension.ts, so the
    // rethrow from a command-sourced take surfaces only VS Code's generic
    // "command failed" notification — no toast, no output-channel line. The panel
    // must say what failed before the error propagates. (The rethrow itself is a
    // released behaviour pinned by the Take-funnel tests above, so it stays.)
    clientStub.getDetail.mockRejectedValueOnce(
      parseJiraError(404, JSON.stringify({ errorMessages: ["Issue does not exist"] })),
    );
    const { provider, messages, logged } = setup();
    await expect(provider.takeTask("BILL-1234", "command", ["acme-billing"])).rejects.toThrow();
    expect(messages).toContainEqual(
      expect.objectContaining({ type: "toast", level: "error", message: expect.stringContaining("Issue does not exist") }),
    );
    expect(logged.join("\n")).toContain("Issue does not exist");
    // The Take funnel still gets its terminator exactly as before.
    const done = trackSpy.mock.calls.flat().find((e: any) => e.name === "take_completed") as any;
    expect(done.outcome).toBe("failed");
  });

  it("re-gates the panel instead of toasting when a command take fails on a dead credential", async () => {
    clientStub.getDetail.mockRejectedValueOnce(new JiraAuthError("Jira auth failed (401). Sign in again."));
    const { provider, messages } = setup();
    await expect(provider.takeTask("BILL-1234", "command", ["acme-billing"])).rejects.toThrow();
    expect(messages).toContainEqual(expect.objectContaining({ type: "state", authed: false }));
    expect(messages).not.toContainEqual(expect.objectContaining({ type: "toast", level: "error" }));
  });

  it("keeps the card path byte-identical: a failing card take rethrows without toasting here", async () => {
    // The card path's dispatcher (onMessage's catch) owns its toast; takeTask
    // itself must add nothing, or the user would see two.
    clientStub.getDetail.mockRejectedValueOnce(new Error("boom"));
    const { provider, messages } = setup();
    await expect(provider.takeTask("BILL-1234", "card", ["acme-billing"])).rejects.toThrow("boom");
    expect(messages).not.toContainEqual(expect.objectContaining({ type: "toast" }));
  });
});

describe("no repos found — first-run path", () => {
  // discoverRepos → [] is the first-run state (agentFlow.reposRoot unset or
  // pointing nowhere). Every launch entry point must stop with the actionable
  // toast and open nothing.
  const NO_REPOS_TOAST = "No repos found under /repos. Check agentFlow.reposRoot.";

  it("explore stops with the reposRoot toast and opens nothing", async () => {
    vi.mocked(discoverRepos).mockReturnValue([]);
    const { send, messages } = setup();
    await send({ type: "explore" });
    expect(messages).toContainEqual(
      expect.objectContaining({ type: "toast", level: "error", message: NO_REPOS_TOAST }),
    );
    expect(vi.mocked(openWorkspace)).not.toHaveBeenCalled();
    // It stops before any picker — the action QuickPick never shows.
    expect(vi.mocked(window.showQuickPick)).not.toHaveBeenCalled();
  });

  it("notepad:run stops with the reposRoot toast and opens nothing", async () => {
    vi.mocked(discoverRepos).mockReturnValue([]);
    const { send, messages, globalState } = setup();
    globalState.store.set("agentFlow.notepad", [{ id: "n1", title: "t", body: "", done: false, createdAt: 1 }]);
    await send({ type: "notepad:run", id: "n1" });
    expect(messages).toContainEqual(
      expect.objectContaining({ type: "toast", level: "error", message: NO_REPOS_TOAST }),
    );
    expect(vi.mocked(openWorkspace)).not.toHaveBeenCalled();
    // The note keeps no pointer to a run that was never created.
    const notes = globalState.store.get("agentFlow.notepad") as { lastRunKey?: string }[];
    expect(notes[0].lastRunKey).toBeUndefined();
  });

  it("take stops with the reposRoot toast, opens nothing, and reports the funnel outcome as cancelled", async () => {
    vi.mocked(discoverRepos).mockReturnValue([]);
    const { send, messages } = setup();
    await send({ type: "take", key: "BILL-1234", services: ["acme-billing"] });
    expect(messages).toContainEqual(
      expect.objectContaining({ type: "toast", level: "error", message: NO_REPOS_TOAST }),
    );
    expect(vi.mocked(openWorkspace)).not.toHaveBeenCalled();
    // resolveKickoff answering undefined reports as a cancellation, not a failure —
    // pinning what the code actually tracks today.
    const done = trackSpy.mock.calls.flat().find((e: any) => e.name === "take_completed") as any;
    expect(done).toBeDefined();
    expect(done.outcome).toBe("cancelled");
  });
});

describe("fetch — truncated My-sprint pool (known limitation)", () => {
  it("documents that a truncated fetch prunes saved order (known limitation)", async () => {
    // fetchTasks caps at maxResults=50 with no pagination. On a sprint of 60
    // tasks the fetch silently truncates to 50, and the full-view prune runs
    // against that truncated list — so the manual order of every task past #50
    // is PERMANENTLY discarded from workspaceState, even though those tasks are
    // still in the sprint. Pagination is feature work; this pin exists so the
    // data loss is named, not rediscovered.
    const allKeys = Array.from({ length: 60 }, (_, i) => `PROJ-${i + 1}`);
    const fetched = allKeys.slice(0, 50); // what a truncated fetch actually returns
    clientStub.fetchTasks.mockResolvedValue(
      fetched.map((key) => ({ key, summary: "", labels: [], components: [] })),
    );
    const { send, workspaceState } = setup({
      workspaceState: { "agentFlow.sprintOrder": [...allKeys] },
    });
    await send({ type: "fetch", filter: "mysprint", size: "any" });
    // Today's behaviour: the saved order is pruned to the 50 fetched keys —
    // PROJ-51…PROJ-60 lose their manual rank for good.
    expect(workspaceState.update).toHaveBeenCalledWith("agentFlow.sprintOrder", fetched);
    const savedNow = workspaceState.store.get("agentFlow.sprintOrder") as string[];
    expect(savedNow).toHaveLength(50);
    expect(savedNow).not.toContain("PROJ-51");
    expect(savedNow).not.toContain("PROJ-60");
  });
});

describe("onMessage — throwing log fn", () => {
  it("a fetch still settles, posts the error, and clears loading when the output channel's log throws", async () => {
    // A disposed output channel makes the injected log throw. getConfig() and
    // this.log() sat ABOVE onMessage's try, so the rejection escaped the handler
    // unhandled and the panel got nothing — no error post, no loading:false.
    const { context } = fakeContext();
    const auth = fakeAuth({ authed: true });
    const provider = new TasksViewProvider(context, jiraConnector(auth), () => {
      throw new Error("Channel has been closed");
    });
    const messages: OutboundMessage[] = [];
    let handler: (m: InboundMessage) => Promise<void> = async () => {};
    provider.resolveWebviewView({
      title: "Tasks",
      description: undefined,
      onDidDispose: () => ({ dispose() {} }),
      webview: {
        options: {},
        html: "",
        asWebviewUri: (u: unknown) => u,
        cspSource: "vscode-resource:",
        postMessage: (m: OutboundMessage) => void messages.push(m),
        onDidReceiveMessage: (cb: (m: InboundMessage) => Promise<void>) => {
          handler = cb;
          return { dispose() {} };
        },
      },
    } as never);
    await expect(handler({ type: "fetch", filter: "mine", size: "any" })).resolves.toBeUndefined();
    expect(messages).toContainEqual({ type: "loading", loading: false });
    expect(messages).toContainEqual(
      expect.objectContaining({ type: "error", message: "Channel has been closed" }),
    );
  });
});

describe("removeFromSprint — failed Undo", () => {
  it("says the undo failed and refetches when the sprint re-add write rejects", async () => {
    // The remove itself succeeded — the ticket really is out of the sprint. A
    // throwing undo used to escape into the dispatcher's generic catch: raw
    // error toast, no refetch, and the panel read as an undone removal.
    vi.mocked(window.showInformationMessage).mockResolvedValue("Undo" as never);
    clientStub.addIssueToSprint.mockRejectedValueOnce(new Error("sprint write refused"));
    const { send, messages } = setup();
    await send({ type: "removeFromSprint", key: "PROJ-1", size: "any" });
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "toast",
        level: "error",
        message: expect.stringMatching(/undo failed/i),
      }),
    );
    // The refetch still runs, so the list shows reality (ticket out of the sprint).
    expect(clientStub.fetchTasks).toHaveBeenCalledWith("mysprint", "any", 50);
  });

  it("treats a throwing active-sprint lookup during undo the same way", async () => {
    vi.mocked(window.showInformationMessage).mockResolvedValue("Undo" as never);
    clientStub.getActiveSprintId.mockRejectedValueOnce(new Error("board list unreadable"));
    const { send, messages } = setup();
    await send({ type: "removeFromSprint", key: "PROJ-1", size: "any" });
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "toast",
        level: "error",
        message: expect.stringMatching(/undo failed/i),
      }),
    );
    expect(clientStub.addIssueToSprint).not.toHaveBeenCalled();
    expect(clientStub.fetchTasks).toHaveBeenCalledWith("mysprint", "any", 50);
  });
});

describe("fetch — overlapping fetches", () => {
  it("lets the later-started lens win when an earlier fetch resolves last, and honors a subsequent sprint reorder", async () => {
    // Without a sequence token, an older fetch resolving late posts its (stale)
    // list over the newer one AND leaves lastFilter pointing at the newer lens —
    // or, started the other way round, leaves lastFilter pointing at the OLD lens
    // while the sprint list is on screen, so the user's next drag is silently
    // discarded by the reorder guard.
    let resolveBacklog!: (t: unknown) => void;
    let resolveSprint!: (t: unknown) => void;
    clientStub.fetchTasks
      .mockImplementationOnce(() => new Promise((r) => { resolveBacklog = r; }))
      .mockImplementationOnce(() => new Promise((r) => { resolveSprint = r; }));
    const { send, messages, workspaceState } = setup();
    const backlogFetch = send({ type: "fetch", filter: "backlog", size: "any" });
    const sprintFetch = send({ type: "fetch", filter: "mysprint", size: "any" });
    await vi.waitFor(() => expect(clientStub.fetchTasks).toHaveBeenCalledTimes(2));
    // Out of order: the later-started (mysprint) fetch completes first…
    resolveSprint([
      { key: "A", summary: "", labels: [], components: [] },
      { key: "B", summary: "", labels: [], components: [] },
    ]);
    await sprintFetch;
    // …and the stale backlog fetch lands last.
    resolveBacklog([{ key: "Z", summary: "", labels: [], components: [] }]);
    await backlogFetch;
    const taskPosts = messages.filter((m) => m.type === "tasks") as { filter: string; tasks: { key: string }[] }[];
    expect(taskPosts.at(-1)!.filter).toBe("mysprint");
    expect(taskPosts.at(-1)!.tasks.map((t) => t.key)).toEqual(["A", "B"]);
    // The panel is on My sprint, so a drag there must be honored.
    await send({ type: "reorder", order: ["B", "A"] });
    expect(workspaceState.update).toHaveBeenLastCalledWith("agentFlow.sprintOrder", ["B", "A"]);
  });

  it("keeps lastFilter on the rendered lens when the stale fetch was the sprint one", async () => {
    // The drag-discard direction: mysprint started first, backlog started second;
    // the stale mysprint completion must not post its list over the backlog view.
    let resolveSprint!: (t: unknown) => void;
    let resolveBacklog!: (t: unknown) => void;
    clientStub.fetchTasks
      .mockImplementationOnce(() => new Promise((r) => { resolveSprint = r; }))
      .mockImplementationOnce(() => new Promise((r) => { resolveBacklog = r; }));
    const { send, messages, workspaceState } = setup();
    const sprintFetch = send({ type: "fetch", filter: "mysprint", size: "any" });
    const backlogFetch = send({ type: "fetch", filter: "backlog", size: "any" });
    await vi.waitFor(() => expect(clientStub.fetchTasks).toHaveBeenCalledTimes(2));
    resolveBacklog([{ key: "Z", summary: "", labels: [], components: [] }]);
    await backlogFetch;
    resolveSprint([{ key: "A", summary: "", labels: [], components: [] }]);
    await sprintFetch;
    const taskPosts = messages.filter((m) => m.type === "tasks") as { filter: string; tasks: { key: string }[] }[];
    expect(taskPosts.at(-1)!.filter).toBe("backlog");
    // Backlog is the rendered lens, so a (stale-webview) reorder must stay ignored.
    await send({ type: "reorder", order: ["A"] });
    expect(workspaceState.update).not.toHaveBeenCalledWith("agentFlow.sprintOrder", ["A"]);
  });
});
