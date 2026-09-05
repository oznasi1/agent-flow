import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { window, ViewColumn, env, workspace, commands, setConfig, setConfigScope, configUpdateTargets, ConfigurationTarget, fireConfigurationChanged } from "../_mocks/vscode";
import { DEFAULT_COMMANDS, DEFAULT_PROMPT_MODES } from "../../src/config";
import { composeAgentPrompt } from "../../src/engine/prompt";
import { fakeContext } from "../_helpers/factories";
import type { ChangedFile } from "../../src/engine/git";
import type { AgentActivity, CardAgent, OpenSession, PrEntryMap, PrFacts, RepoGit, ReviewDetail, ReviewRequest, ReviewVerb, Run, RunStatus, ServiceRef, Task } from "../../src/types";
import type { FetchResult } from "../../src/engine/pr/provider";
import type { ForgeGap } from "../../src/engine/forge/types";
import type { TaskConnector, TaskProvider } from "../../src/tasks/provider";
import type { CommandNode, Flow, FlowEdge, FlowNode } from "../../src/engine/orchestrator/model";
import { BRANCH_CI_ARGS, branchCiKey } from "../../src/engine/orchestrator/branchCi";
import { STARTERS } from "../../src/engine/orchestrator/starters";
import { GH_TIMEOUT_MS } from "../../src/engine/pr/provider";
import type { AgentProvider, AgentProviderSetting } from "../../src/config";
import type { DemotionChoice, FlowCommand, FlowTemplate } from "../../src/types";
import { attentionKeys } from "../../src/engine/attention";
import { forgeNote } from "../../src/deckView";

// Telemetry: mocked wholesale so the deck_opened/deck_action/operation_failed
// assertions below observe track()/trackError() calls without a real singleton —
// same pattern as tasksView.test.ts's Take-funnel mock.
const trackSpy = vi.fn();
const trackErrorSpy = vi.fn();
vi.mock("../../src/telemetry/telemetry", () => ({
  track: (...a: unknown[]) => trackSpy(...a),
  trackError: (...a: unknown[]) => trackErrorSpy(...a),
  startFlow: () => ({ id: "flow-1", elapsedMs: () => 42 }),
  fingerprint: () => "0123456789abcdef",
}));

/** The shape `child_process.exec`'s callback is invoked with, narrowed to the four
 * fields `shellCommandRunner` actually branches on. A real `ExecException` carries
 * more, but a test that built one would be asserting against Node's own class
 * rather than against the runner's mapping of exit code, string code, and signal. */
type ExecError = Error & { code?: number | string; killed?: boolean; signal?: string };
type ExecCallback = (err: ExecError | null, stdout: string, stderr: string) => void;

// Isolate the panel from the engine: fixtures for runs, a pass-through status
// builder, and a stubbed workspace opener.
const h = vi.hoisted(() => ({
  runs: [] as Run[],
  openInEditor: vi.fn(async (_t: string) => true),
  // A seed edge's launcher (Task 5b) — stubbed so no test opens a real window.
  // Typed loosely (the mock never inspects its own argument) so the module's
  // real OpenRequest/OpenResult shapes stay the single source of truth; the
  // tests assert on what `deckView.ts` PASSED it, not on what it returns.
  openWorkspace: vi.fn(async (_req: unknown) => ({ mode: "per-window", briefs: [], opened: [], remoteControl: false })),
  writePlanFile: vi.fn(),
  prReviewPrompt: "Assess the PR for {key}.{files}" as string,
  prReviewAutoFix: false as boolean,
  taskDiff: vi.fn((_p: string) => ""),
  taskDiffBase: vi.fn((_p: string) => "base-sha"),
  taskChangedFiles: vi.fn((_p: string): ChangedFile[] => []),
  buildRunStatus: vi.fn(),
  removeRun: vi.fn(),
  writeRun: vi.fn(),
  getStatus: vi.fn(async (_k: string) => ({ status: "In Review", category: "indeterminate" })),
  prEntries: {} as Record<string, unknown>,
  writePrEntry: vi.fn(),
  removePrEntries: vi.fn(),
  // Typed as the real FetchResult union (not narrowed via inference) so later
  // tests can resolve `{ ok: false }` or a genuine `PrFacts` payload without a
  // type error — a narrower type would make "facts is written through" and
  // "facts is hardcoded null" indistinguishable.
  prFetch: vi.fn(async (_p: string, _b: string | null, _k: string): Promise<FetchResult> => ({ ok: true, facts: null })),
  // Typed as the real union so a test can resolve a gap as well as the null that
  // means "gh is usable".
  probeGh: vi.fn(async (): Promise<ForgeGap | null> => null),
  // The branch-CI fetch's spawn (Task 8), standing in for `execRunner`: resolves
  // the raw stdout of one `gh api graphql` call. Green by default, so a test about
  // the fetch's SHAPE (argv, cwd, how many calls) needs no payload of its own; a
  // test about an unreadable branch rejects or resolves garbage instead.
  ghRun: vi.fn(
    async (_file: string, _args: string[], _opts: { cwd: string; timeoutMs: number }): Promise<string> =>
      JSON.stringify({ data: { repository: { ref: { target: { statusCheckRollup: { state: "SUCCESS" } } } } } }),
  ),
  prFacts: true as boolean,
  ttlSeconds: 120,
  openAgents: true as boolean,
  inflightShowAll: false as boolean,
  // Review-requests strip (Task 7): a gh-backed search, an on-disk cache, and the
  // repos discoverable on this machine — independent of the PR-facts fixtures above.
  reviewSearch: vi.fn(async (): Promise<{ issueCount: number; requests: ReviewRequest[] } | null> => ({
    issueCount: 1,
    requests: [reviewFixture()],
  })),
  reviewCache: null as { fetchedAt: number; issueCount: number; requests: ReviewRequest[] } | null,
  writeReviewCache: vi.fn(),
  // Row expansion (Task 9): the two facts the search cannot return.
  reviewDetail: vi.fn(async (_repo: string, _number: number): Promise<ReviewDetail | null> => ({ failing: [], unresolved: null })),
  // The review write path (Task 14): the setting that lets the Deck post a review to
  // GitHub — one of the two write settings, alongside `mergeWrites` below — the
  // Jira-provenance toggle reused for a review body, and the submit call itself.
  reviewWrites: false as boolean,
  reviewRequestsAlwaysVisible: true as boolean,
  stampLabelOnWrite: true as boolean,
  seedAgent: true as boolean,
  agentProvider: "claude-code" as AgentProviderSetting,
  reviewSubmit: vi.fn(async (_repo: string, _number: number, _verb: ReviewVerb, _body: string): Promise<{ ok: true } | { ok: false; message: string }> => ({ ok: true })),
  // The merge path (Task 5): the one setting that lets the Deck merge anything, the
  // strategy it merges with, and the forge call itself. Steered exactly the way
  // `reviewWrites`/`reviewSubmit` above are — a merge test flips the setting the way
  // a user would rather than reaching past getConfig().
  mergeWrites: false as boolean,
  mergeMethod: "squash" as "squash" | "merge" | "rebase",
  // Typed as the real union rather than narrowed by inference, for the same reason
  // `reviewSubmit` is: a test that resolves `{ ok: false, message }` must not need a
  // cast, or "the forge's own wording reaches the toast" and "a message this file
  // made up reaches it" become indistinguishable.
  prMerge: vi.fn(async (_p: string, _n: number, _m: string) => ({ ok: true }) as { ok: true } | { ok: false; message: string }),
  repos: [{ name: "aws-ops", path: "/repos/aws-ops", isGit: true }] as ServiceRef[],
  reviewRequests: true as boolean,
  // Every Claude Code session open on this machine (Task 8) — the registry
  // readOpenSessions reads, stubbed here rather than touching real ~/.claude/sessions.
  openSessions: [] as OpenSession[],
  // Whether the sessions registry could be read this pass (the guardrail —
  // a failed read is not "nothing is running"). True by default so every
  // existing test's reading of `openSessions` is unaffected.
  openSessionsReadable: true as boolean,
  // Every window presence knows about (Task 1/4) — steerable per test so a
  // multi-root workspace window can be asserted to fold its sessions into one
  // card. Empty by default, which groups nothing: every pre-existing
  // local-card test keeps producing its old one-place-one-card shape.
  // `label`/`folders` are what the destination picker renders a row from; the card
  // grouping tests that predate it only ever needed identity/kind/roots.
  liveWindows: [] as { identity: string; kind: "workspace" | "folder"; roots?: string[]; label?: string; folders?: number }[],
  // This window's identity, for the destination question Review with agent asks.
  // Undefined by default: a window that can't hold a seeded session.
  currentWindow: undefined as { identity: string; kind: "workspace" | "folder"; roots: { name?: string; path: string }[] } | undefined,
  // The `.code-workspace` files the destination question's pick-existing arm lists.
  workspaceFiles: [] as { file: string; folders: number }[],
  // Per-session live activity (Task 8) — stubbed so a test can assert a real,
  // known AgentActivity is threaded through to the right CardAgent, without
  // this suite re-testing readSessionActivity's own parsing of a real
  // transcript file (engine/transcript.test.ts already does that).
  sessionActivity: vi.fn((_projectsRoot: string, _cwd: string, _sessionId: string, _nowMs: number): AgentActivity => (
    { state: "working", lastActivityMs: 4242, slug: "svc-7e-slug" }
  )),
  // Review launch + draft handoff (Task 12): the worktree launcher and the two
  // fs primitives decorateReviews/loadReviewDraft need — kept in the hoisted
  // block like every other side effect this suite stubs out.
  // Typed as the real union (not narrowed via inference) so a test can resolve
  // `{ ok: false, message }` as well as the success shape without a type error.
  // Rest-params rather than the real (req, deps) signature: the mock never
  // inspects its arguments, only the launch/launch.ts wrapper below forwards them.
  // `provider` is the field Task 6 added to the success arm — the agent openWorkspace
  // actually seeded, which the launch toast names. `{ ok: false, cancelled }` is its
  // third arm: a dismissed picker, which is neither a success nor a failure.
  launchReview: vi.fn(async (..._args: unknown[]): Promise<
    | { ok: true; runKey: string; provider: AgentProvider; seededInPlace?: true }
    | { ok: false; cancelled: true }
    | { ok: false; message: string }
  > => ({
    ok: true,
    runKey: "review-aws-ops-8491",
    provider: "claude-code",
  })),
  // The shared-window opener a review BATCH goes through, stubbed for the same
  // reason openWorkspace above is: the tests assert on what deckView PASSED it.
  openSharedWorkspace: vi.fn(async (_req: unknown) => ({ opened: true, briefs: [], seeded: 0 })),
  // True by default, unlike every other stub here: the retire sweep asks
  // existsSync whether a run's repo directories are still on disk, and a blanket
  // false would make every fixture run "unreachable" — retiring the very cards
  // these tests assert on. A test that needs a path *missing* says so per case.
  existsSync: vi.fn((_p: string) => true),
  readFileSync: vi.fn((_p: string, _e?: string) => ""),
  // Per-repo git state for the review-run sweep. Clean and pushed, so the veto
  // stays out of the way unless a test asks for it.
  gitState: vi.fn((name: string, path: string) => ({
    name, path, branch: "b", dirty: false, ahead: 0, added: 0, removed: 0, files: 0,
  })),
  // Local cards (Task 11): the branch `currentBranch` reports for /r/webapp —
  // steerable per test, unlike repoRoot below, because the branch is exactly the
  // thing a local card's ticket inference and "no card twice" tests need to vary.
  branch: "PROJ-5641-team-table" as string | null,
  // Orchestrator flows (Task 3): the on-disk store, replaced wholesale so this
  // suite never touches a real ~/.agentflow/flows. writeFlow's default
  // implementation (set in beforeEach) actually updates `flows`, so a read
  // that follows a write in the same test — postFlows() after
  // advanceArmedFlows, in particular — sees what was just written, the same
  // way the real file-backed store would. A bare spy here would make the
  // write-then-read ordering in advanceArmedFlows untestable: readFlows would
  // never be able to see a write that "landed" a moment earlier.
  flows: [] as Flow[],
  // A spy, not a bare `() => h.flows` arrow, for one reason: `advanceArmedFlows`
  // reads the store TWICE per pass — once to evaluate, once immediately before it
  // writes, to drop any edge another VS Code window stamped in between. A test of
  // that guard has to make the second read differ from the first, which needs a
  // per-call implementation. Its default (set in beforeEach) is the honest
  // `() => h.flows`, so every other flow test is unaffected.
  readFlows: vi.fn((): Flow[] => []),
  writeFlow: vi.fn(),
  removeFlow: vi.fn(),
  // Templates (Task 8): the on-disk store beside flows, mocked the same honest
  // way — a write actually updates `templates`, so a read that follows a write
  // in the same test sees it, exactly as the real file-per-id store would.
  templates: [] as FlowTemplate[],
  readTemplates: vi.fn((): FlowTemplate[] => []),
  writeTemplate: vi.fn(),
  removeTemplate: vi.fn(),
  // The flows-directory lock (Task 5). Granted by default, so every flow test
  // that is not about contention behaves as it did before the lock existed; a
  // test about a busy directory says so with mockReturnValue(false).
  acquire: vi.fn((..._args: unknown[]) => true),
  // The mid-pass ownership check (Task 6). Still ours by default, so a pass runs
  // to completion exactly as it did before renewal existed; a test about a lock
  // reaped mid-pass says so with mockReturnValue(false). Mocked rather than run
  // for real against the `nodeLockIo` stub below for the same reason `acquire` and
  // `release` are — that stub's `read` answers null, which is indistinguishable
  // from "another window reaped us".
  renew: vi.fn((..._args: unknown[]) => true),
  // Whatever logger the panel handed nodeLockIo, so a test can prove it passed one
  // and that it reaches the output channel.
  lockIoLog: undefined as ((m: string) => void) | undefined,
  // Every journal line this pass wrote, in order. A recording fake rather than a
  // spy on the module: the panel is meant to survive a journal that throws, and
  // that is only testable if the IO itself is the thing under the test's control.
  journalLines: [] as string[],
  journalThrows: false,
  discoverRepos: vi.fn((_root: string, _blocklist: string[]) => [] as ServiceRef[]),
  release: vi.fn(),
  // The launcher (Task 4), stubbed so no test opens a window or a worktree. The
  // default answers FROM THE REQUEST rather than with a constant: a pass can
  // launch up to three planned nodes, and a constant run key would make "each
  // node was promoted to its own run" indistinguishable from "they all collapsed
  // onto one". Typed as the real union so a test can resolve a failure too.
  launchPlanned: vi.fn(
    async (req: { node: { ticketKey: string; repos: string[] } }): Promise<
      { ok: true; runKey: string; repo: string } | { ok: false; message: string }
    > => ({ ok: true, runKey: req.node.ticketKey, repo: req.node.repos[0] }),
  ),
  // The ticket read a launch needs. A superset of the four fields LaunchRequest
  // wants, exactly as the real provider().detail returns.
  getDetail: vi.fn(async (key: string) => ({
    key, summary: "do it", url: `https://jira/browse/${key}`, descriptionText: "the description",
    labels: [], components: [], status: null, statusCategory: null,
  })),
  // A counter, not a constant: deterministic so ids are assertable, but varying
  // so the re-mint-on-collision path is reachable. A constant would make the
  // retry loop indistinguishable from a refusal.
  idSeq: 0,
  // `agentFlow.commands` (Task 4). Empty here by fixture choice, not because
  // that's what a real install gets any more (`DEFAULT_COMMANDS` ships one
  // inert example) — a free-text `run` node needs none, and the cases about a
  // configured command set `h.commands` themselves.
  commands: [] as FlowCommand[],
  // The ONE call in this feature that would reach a real shell (Task 6). Succeeds
  // silently by default with output on both streams, so every case that is not
  // about failure still proves the output path. Deliberately callback-style rather
  // than a stubbed CommandRunner: `shellCommandRunner`'s whole job is the mapping
  // between exec's callback contract (a null error, a numeric code, a string code,
  // a kill signal) and CommandOutcome, and a stubbed runner would skip it — which
  // is exactly where the timeout enforcement lives.
  exec: vi.fn((_command: string, _opts: unknown, cb: ExecCallback) => {
    cb(null, "deployed 3 services", "warning: slow");
  }),
  // The candidate list the missing ticket picker (Task 4b) reads from
  // `provider().list(...)`. One ticket by default — enough for the picker to
  // have something to show without a test having to name a task it never uses.
  taskList: vi.fn(async (_lens: string, _size: string, _max?: number): Promise<Task[]> => [
    {
      key: "PROJ-9", summary: "Ship the migration", status: "", statusCategory: "new", priority: "",
      assignee: "Unassigned", labels: [], components: [], sprint: null, inOpenSprint: false,
      updated: "", url: "https://jira/browse/PROJ-9", estimateSeconds: null,
    },
  ]),
  // The branch for /r/e2e_suite (Task 4) — a second steerable path so a
  // multi-root workspace card's "first root's ticket wins" rule can be tested
  // against a real conflict, not just one root that has a ticket and one that
  // never can. Defaults to "main", same as every other path already did.
  branch2: "main" as string | null,
  // A third steerable path (F1's own-root-vs-sibling coverage needs three roots
  // to pin "first hit wins" independently of "the session's own root wins").
  branch3: "main" as string | null,
  // repoRoot (F5): a path in here answers "" — a plain, non-git directory — and
  // every other path defaults to identity (its own git root), matching the
  // suite's original hardcoded stub. A path in `repoRootRemap` answers with the
  // mapped value instead, for the "nested folder normalizes to its containing
  // repo" case — identity can't express that on its own.
  nonGitRoots: new Set<string>(),
  repoRootRemap: new Map<string, string>(),
  // The usage sweep's reader (Task 5): stubbed so a test can assert which runs
  // it was called for without touching a real ~/.claude/projects. Zeroed by
  // default so every existing test's postedRuns stay exactly as they were
  // before this field existed; a test that cares about the sweep's coverage
  // overrides one call with `.mockReturnValueOnce`.
  usageReadRun: vi.fn((_root: string, _cwds: string[]) => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 })),
  /** Mirrors `agentFlow.deck.showTokenTotal`. True by default HERE only — the
   * shipped default is false, and the "sweep stays off" case below sets it false
   * explicitly. Kept true so the sweep tests written before the setting existed
   * still exercise the eager path they were built to cover. */
  showTokenTotal: true,
}));
vi.mock("../../src/engine/runs", () => ({
  defaultRunsDir: () => "/runs",
  readRuns: () => h.runs,
  removeRun: h.removeRun,
  writeRun: h.writeRun,
}));
vi.mock("../../src/engine/status", () => ({ buildRunStatus: h.buildRunStatus }));
vi.mock("../../src/engine/workspace", () => ({
  openInEditor: h.openInEditor,
  // Invoked directly by a met `seed` rule (Task 5b) — see h.openWorkspace above.
  // launchReview itself is mocked below, so it never calls through to this.
  openWorkspace: h.openWorkspace,
  BRIEF_DIR: ".pick-task",
  writePlanFile: h.writePlanFile,
  // The `pick-existing` arm of the destination question (openTargetHost).
  listWorkspaceFiles: () => h.workspaceFiles,
  // A stub that encodes its brief argument in the output, so a test can assert
  // which brief a match was rendered against without re-testing renderPrompt —
  // engine/prompt.test.ts already owns that.
  agentPrompt: (t: { key: string }, _mentions: string[], template: string, briefPath?: string) =>
    `${template} [key=${t.key} brief=${briefPath ?? "(relative)"}]`,
}));
// Partial mock: `repoRootOfWorktree` stays REAL. It is pure string work over the
// `.claude/worktrees/` layout (no git, no fs), and `checkoutFor` uses it to tell a
// second worktree of one repo apart from a second repo that merely shares a name —
// a stub would make that distinction this file's opinion instead of the layout's.
vi.mock("../../src/engine/worktree", async (importActual) => {
  const actual = await importActual<typeof import("../../src/engine/worktree")>();
  return { ...actual, createWorktrees: vi.fn() };
});
// repoRoot stubbed alongside the real taskDiff: groupByPlace (engine/sessions)
// calls the real repoRoot, which would shell out to git for a fixture path like
// "/r/svc" and get "" back rather than the fixtures' own place key. Identity by
// default (a path's own git root is itself) — the same answer the suite's old
// hardcoded `(p) => p` gave for every path — but steerable per test via
// `h.nonGitRoots` (F5's "drop a non-repo folder" case) and `h.repoRootRemap`
// (F5's "a nested folder normalizes to its containing repo" case).
// prEligible: a faithful-enough stand-in for the real branch-vs-origin/HEAD
// check (Task 2) — "master" plays the role of "this repo's default branch" so
// a test can choose the answer just by naming a branch, without a real repo.
// gitState: the review-run sweep's only source of the dirty/unpushed veto. This
// mock replaces engine/git wholesale, so an unstubbed gitState would be
// `undefined` at runtime the moment the sweep calls it. Clean by default —
// a test that wants the veto to bite steers h.gitState.
vi.mock("../../src/engine/git", () => ({
  taskDiff: h.taskDiff,
  taskDiffBase: h.taskDiffBase,
  taskChangedFiles: h.taskChangedFiles,
  repoRoot: (p: string) => (h.nonGitRoots.has(p) ? "" : h.repoRootRemap.get(p) ?? p),
  currentBranch: (p: string) =>
    p === "/r/webapp" ? h.branch : p === "/r/e2e_suite" ? h.branch2 : p === "/r/third" ? h.branch3 : "main",
  prEligible: (r: { isGit: boolean; branch?: string }) => r.isGit && !!r.branch && r.branch !== "master",
  gitState: (name: string, path: string) => h.gitState(name, path),
}));
// groupByPlace and canon stay real — only the functions that touch the real
// filesystem (~/.claude/sessions) are replaced. `readOpenSessionsProbe` mirrors
// `readOpenSessions` (Task 4's guardrail: buildAll now takes the probe, not the
// bare list, so it must be stubbed too or it would hit the real, absent
// "/sessions" and read every existing test as an unreadable registry).
// `h.openSessionsReadable` defaults true, matching every caller's default.
vi.mock("../../src/engine/sessions", async (importActual) => ({
  ...(await importActual<typeof import("../../src/engine/sessions")>()),
  readOpenSessions: () => h.openSessions,
  readOpenSessionsProbe: () => ({ sessions: h.openSessions, readable: h.openSessionsReadable }),
  defaultSessionsDir: () => "/sessions",
}));
// UNKNOWN_ACTIVITY stays real (deckView.ts imports it directly, and it is the
// exact value the unreadable-transcript case asserts against) — only the
// transcript read itself, which would otherwise hit a real (absent) file, is
// replaced.
vi.mock("../../src/engine/transcript", async (importActual) => ({
  ...(await importActual<typeof import("../../src/engine/transcript")>()),
  readSessionActivity: (projectsRoot: string, cwd: string, sessionId: string, nowMs: number) =>
    h.sessionActivity(projectsRoot, cwd, sessionId, nowMs),
}));
vi.mock("../../src/engine/presence", () => ({
  readLiveWindows: () => h.liveWindows,
  defaultWindowsDir: () => "/windows",
  // Read by the destination question Review with agent now asks (openTargetHost) — the
  // single-row launch and the batch both go through it. Undefined by default: the shape
  // of a window that can't hold a session, which keeps "This window" out of the picker
  // unless a test asks for it.
  currentWindow: () => h.currentWindow,
  windowIdentity: () => (h.currentWindow ? { ...h.currentWindow, label: "here", folders: 1 } : undefined),
}));
// The usage sweep's reader (Task 5): a class instantiated once and held for the
// panel's lifetime in deckView.ts, so the mock has to be a class too — a plain
// object export would not survive `new UsageReader()`. Its one method forwards
// to `h.usageReadRun`, the same indirection every other engine stub here uses.
vi.mock("../../src/engine/usageFs", () => ({
  UsageReader: vi.fn().mockImplementation(() => ({ readRun: h.usageReadRun })),
}));
vi.mock("../../src/engine/pr/store", () => ({
  defaultPrFactsDir: () => "/prfacts",
  readPrEntries: () => h.prEntries,
  writePrEntry: h.writePrEntry,
  removePrEntries: h.removePrEntries,
  // Exercise the real staleness rule rather than restating it here.
  isStale: (e: { fetchedAt: number } | undefined, ttl: number, now: number) => !e || now - e.fetchedAt >= ttl,
}));
// Partial mock: `GH_TIMEOUT_MS` stays real (the panel passes it to the branch-CI
// fetch, and a test asserting on it should not assert against a number this file
// made up), and so does everything else in the module. Only the two spawning
// members are replaced — `GhProvider` for PR facts, `execRunner` for the branch-CI
// call, which deckView.ts takes as its `ghRun` seam.
vi.mock("../../src/engine/pr/provider", async (importActual) => {
  const actual = await importActual<typeof import("../../src/engine/pr/provider")>();
  return {
    ...actual,
    probeGh: h.probeGh,
    // `merge` alongside `fetch`: it is the second member of the real PrProvider,
    // and without it `forge.prs.merge` resolves to `undefined` and the merge
    // handler calls it.
    GhProvider: class { fetch = h.prFetch; merge = h.prMerge; },
    execRunner: (file: string, args: string[], opts: { cwd: string; timeoutMs: number }) => h.ghRun(file, args, opts),
  };
});
vi.mock("../../src/engine/review/provider", () => ({
  GhReviewProvider: class {
    search = h.reviewSearch;
    detail = h.reviewDetail;
    submit = h.reviewSubmit;
  },
}));
vi.mock("../../src/engine/review/store", () => ({
  defaultReviewsFile: () => "/reviews.json",
  readReviewCache: () => h.reviewCache,
  writeReviewCache: h.writeReviewCache,
  // Exercise the real staleness rule rather than restating it here.
  isReviewCacheStale: (c: { fetchedAt: number } | null, ttl: number, now: number) => !c || now - c.fetchedAt >= ttl,
}));
// A spy over the arguments, not a bare `() => h.repos`: the real signature is
// (reposRoot, blocklist), and a caller that passed them the other way round would
// discover repos under a blocklist entry. An arg-ignoring mock cannot tell.
vi.mock("../../src/engine/repos", () => ({
  discoverRepos: (root: string, blocklist: string[]) => h.discoverRepos(root, blocklist),
}));
vi.mock("../../src/engine/orchestrator/store", async (importActual) => {
  const actual = await importActual<typeof import("../../src/engine/orchestrator/store")>();
  return {
    defaultFlowsDir: () => "/flows",
    readFlows: () => h.readFlows(),
    writeFlow: h.writeFlow,
    removeFlow: h.removeFlow,
    defaultTemplatesDir: () => "/templates",
    readTemplates: () => h.readTemplates(),
    writeTemplate: h.writeTemplate,
    removeTemplate: h.removeTemplate,
    // `journal.ts` turns a flow id straight into a path and checks it against the
    // SAME charset regex `fileFor` uses, from this module. It is re-exported real
    // rather than restated, because a second copy of that rule here could drift
    // from the one the store enforces — and it is not stubbed at all, since a
    // journal path is derived, never read back through `h`.
    VALID_FLOW_ID: actual.VALID_FLOW_ID,
  };
});
// Partial mock: LOCK_TTL_MS and lockPath stay real (the panel passes the real TTL,
// and a test asserting on it should not be asserting on a number this file made
// up) — only the two side-effecting calls are replaced.
vi.mock("../../src/engine/orchestrator/lock", async (importActual) => {
  const actual = await importActual<typeof import("../../src/engine/orchestrator/lock")>();
  return {
    ...actual,
    acquire: (...args: Parameters<typeof actual.acquire>) => h.acquire(...args),
    release: (...args: Parameters<typeof actual.release>) => h.release(...args),
    renew: (...args: Parameters<typeof actual.renew>) => h.renew(...args),
  };
});
vi.mock("../../src/engine/orchestrator/launch", () => ({
  launchPlanned: (...args: unknown[]) => h.launchPlanned(args[0] as { node: { ticketKey: string; repos: string[] } }),
}));
vi.mock("../../src/engine/orchestrator/flowIo", () => ({
  nodeFlowIo: () => ({ readDir: () => [], readFile: () => null, writeFile: () => {}, remove: () => {} }),
  // Records the logger it was given. `log` is OPTIONAL on the real nodeLockIo, so
  // dropping the argument compiles and every arity-ignoring mock stays green — while
  // an unexpected filesystem failure silently becomes indistinguishable from ordinary
  // contention, stranding an armed flow with nothing in the log to explain it.
  nodeLockIo: (log?: (m: string) => void) => {
    h.lockIoLog = log;
    return { tryCreate: () => true, read: () => null, remove: () => {} };
  },
  // A counter, not a constant: deterministic so ids are assertable, but varying so
  // the re-mint-on-collision path is reachable. A constant would make the retry
  // loop indistinguishable from a refusal.
  newFlowId: () => `fTEST-${++h.idSeq}`,
  nodeJournalIo: () => ({
    append: (_p: string, text: string) => {
      if (h.journalThrows) throw new Error("ENOSPC");
      h.journalLines.push(text.trimEnd());
    },
    size: () => null,
    // Reflects back whatever `h.journalLines` holds — real lines, checksum and
    // all, whether they arrived via this same `append` or were seeded directly
    // by a test with the real `appendEvent` (see `seedJournal` below) — so
    // `flow:openOutput`'s real `readJournal` call has something honest to
    // read. `null` (not `""`) when there is nothing, matching `JournalIo`'s own
    // contract that a missing journal reads as empty, never as an error.
    readFile: () => (h.journalLines.length > 0 ? `${h.journalLines.join("\n")}\n` : null),
    replace: () => {},
  }),
}));
// Partial mock: deckView.ts and everything it pulls in (engine/worktree,
// engine/gitExclude, jsonc-parser's consumers, etc.) use far more of `fs` than
// the two functions this suite stubs — a bare vi.mock("fs") would blank the
// rest and break every real (unmocked) module transitively imported here.
vi.mock("fs", async (importActual) => {
  const actual = await importActual<typeof import("fs")>();
  return { ...actual, existsSync: (p: string) => h.existsSync(p), readFileSync: (p: string, e: string) => h.readFileSync(p, e) };
});
// Partial mock: `exec` is the only member replaced, and everything else in
// `child_process` stays real for the same reason the `fs` mock above spreads the
// actual module — deckView.ts's own graph reaches `execFileSync`/`execSync` through
// several real modules, and blanking them would break imports that have nothing to
// do with a flow's command. This is what makes a met `run` rule assertable at all:
// `shellCommandRunner` is built over `exec` and is the only participant in the
// feature holding a process handle.
vi.mock("child_process", async (importActual) => {
  const actual = await importActual<typeof import("child_process")>();
  return { ...actual, exec: h.exec };
});
// Partial mock: reviewRunKey is real (its slugging is exactly what decorateReviews
// relies on to match a run to a queued PR); only launchReview — the side-effecting
// half — is replaced.
vi.mock("../../src/engine/review/launch", async (importActual) => {
  const actual = await importActual<typeof import("../../src/engine/review/launch")>();
  return { ...actual, launchReview: (...args: Parameters<typeof actual.launchReview>) => h.launchReview(...args) };
});
// Same shape, same reason: the pure half of batchWorkspace (its types, and the
// BatchTask shape a review batch fills in) stays real; only the opener is replaced.
vi.mock("../../src/engine/batchWorkspace", async (importActual) => {
  const actual = await importActual<typeof import("../../src/engine/batchWorkspace")>();
  return { ...actual, openSharedWorkspace: (...args: Parameters<typeof actual.openSharedWorkspace>) => h.openSharedWorkspace(...args) };
});
vi.mock("../../src/config", async (importActual) => {
  const actual = await importActual<typeof import("../../src/config")>();
  return {
    ...actual,
    // ONE real getConfig() per call, not one per field. Seventeen fields below are
    // forwarded from the real, vscode-configStore-backed config so a test can steer
    // them with setConfig — but `actual.getConfig()` rebuilds prompt modes, commands,
    // environments and the legacy-prompt migrations every time, and this mock is
    // invoked constantly by the poll loop. Reading it seventeen times per call was
    // pure waste in the slowest file in the suite. One snapshot is also strictly
    // more correct: every field now comes from the same read.
    getConfig: () => {
      const real = actual.getConfig();
      return {
      baseUrl: "https://jira", project: "PROJ", prFacts: h.prFacts, prFactsTtlSeconds: h.ttlSeconds,
      openAgents: h.openAgents,
      reviewRequests: h.reviewRequests, reviewRequestsTtlSeconds: 300, reposRoot: "/repos", repoBlocklist: ["vendored"],
      reviewRequestsAlwaysVisible: h.reviewRequestsAlwaysVisible,
      reviewWrites: h.reviewWrites, stampLabelOnWrite: h.stampLabelOnWrite,
      // Steered per test the way reviewWrites is: the merge path's own gate, and the
      // strategy the confirmation names and the forge is asked for.
      mergeWrites: h.mergeWrites, mergeMethod: h.mergeMethod,
      prReviewPrompt: h.prReviewPrompt, prReviewAutoFix: h.prReviewAutoFix, seedAgent: h.seedAgent,
      agentProvider: h.agentProvider,
      prReviewStatus: "PR initiated",
      // Steered per test: the board-wide usage sweep is opt-in (the shipped default
      // is false), so a test that wants the eager sweep has to switch it on the way
      // a user would. Default here is `true` to keep the sweep tests that predate
      // the setting reading as they were written; the "off" case sets it false.
      showTokenTotal: h.showTokenTotal,
      // The named commands a `run` rule's node can point at by `commandId`. Steered
      // per test rather than sourced from the real getConfig(): the real default is
      // now DEFAULT_COMMANDS' single inert example, which would make "the runner got
      // the CONFIGURED command's text, not its label" untestable against a fixed id.
      commands: h.commands,
      // Sourced from the real getConfig(), like `forge` below and for the same
      // reason: a test steers the denylist with setConfig({ neverAutoRun }), and
      // hardcoding it here would make the setting unreachable from a test. Every
      // test that never sets it gets the shipped default — an empty list, which
      // blocks nothing.
      neverAutoRun: real.neverAutoRun,
      // Sourced from the real getConfig() (itself driven by the globally-mocked
      // vscode module) rather than hardcoded here, so a test's setConfig({
      // reviewRequestModes / reviewRequestMode }) actually reaches launchReviewFor.
      reviewRequestModes: real.reviewRequestModes,
      reviewRequestMode: real.reviewRequestMode,
      // Same reason: a test steers which forge the panel resolves through
      // setConfig({ forge }) — the real getConfig() applies the same "" → default
      // fallback the shipped setting does, so a test that never sets it keeps
      // exercising the GitHub path every other fixture in this file assumes.
      forge: real.forge,
      // Same reason: the retire sweep reads both windows, and the grouping is a
      // persisted setting — a test steers all three through setConfig, so they
      // must come from the real getConfig() rather than being frozen here.
      deckGrouping: real.deckGrouping,
      retireFinishedAfterHours: real.retireFinishedAfterHours,
      retireAbandonedAfterDays: real.retireAbandonedAfterDays,
      retireClosedAfterHours: real.retireClosedAfterHours,
      retireInPlaceAfterHours: real.retireInPlaceAfterHours,
      // Steered per test the way openAgents is: the shelf rule's escape hatch has
      // to be flippable without going through the real config store.
      inflightShowAll: h.inflightShowAll,
      // Same reason: a test steers this through setConfig({ orchestrator }),
      // which only reaches deckView.ts if this mock forwards the real,
      // vscode-configStore-backed value rather than a field frozen here.
      orchestrator: real.orchestrator,
      // The three settings an armed launch resolves for itself. Sourced from the
      // real getConfig() for the same reason as the block above: `promptModes` in
      // particular is what a flow node's `mode` id is matched against, so a test
      // about a mode that is no longer configured has to be able to steer it.
      promptModes: real.promptModes,
      workspaceMode: real.workspaceMode,
      workspaceDir: real.workspaceDir,
      // Where Review with agent opens, and whether the picker lists open windows.
      // Both from the real getConfig() so a test steers them with setConfig — and so
      // the shipped default (`new-window`: no picker at all) is what a test that never
      // mentions them exercises.
      reviewOpenIn: real.reviewOpenIn,
      // Where a card's PR work opens. From the real getConfig() for the same reason
      // reviewOpenIn is: a test steers it with setConfig, and the shipped default
      // (`ask`: the destination picker) is what a test that never mentions it gets.
      prWorkOpenIn: real.prWorkOpenIn,
      // What a review BATCH reads on top: how big a batch confirms first.
      batchLaunchConfirmThreshold: real.batchLaunchConfirmThreshold,
      trackOpenWindows: real.trackOpenWindows,
      };
    },
  };
});
import {
  DeckPanel, POLL_MS, USAGE_POLL_MS, noChangesRequestedDetail, reviewProvenance, shellCommandRunner,
} from "../../src/deckView";
// The real ceiling, not a number restated here: a call site that passed a literal
// (or nothing at all) would still satisfy a test that hardcoded 120_000.
import { COMMAND_TIMEOUT_MS } from "../../src/engine/orchestrator/command";
// The real constant, through the partial mock above (which spreads the actual module):
// a test that restated the number could not catch the call site passing a literal.
// The real thresholds `truncateOutput` elides at — restating them here could not
// catch the call site dropping the call.
import { OUTPUT_HEAD_BYTES, OUTPUT_TAIL_BYTES, appendEvent, JournalEventInput } from "../../src/engine/orchestrator/journal";
import { LOCK_TTL_MS } from "../../src/engine/orchestrator/lock";
import { ACTION_MISMATCH_PREFIX } from "../../src/engine/orchestrator/model";
import { PR_REVIEW_AUTOFIX_CLAUSE } from "../../src/engine/prompt";
// The batch-only read-only mode, and the stock one: a batch test that restated either
// prompt could not catch the batch offering a mode it never built.
import { readOnlyReviewMode } from "../../src/engine/review/batch";
import { DEFAULT_REVIEW_REQUEST_MODES } from "../../src/config";
// Through the module mock above, so a batch test can steer what a worktree attempt
// answers with — including the fallback-to-the-main-checkout a batch must refuse.
import { createWorktrees } from "../../src/engine/worktree";
import { TaskAuthError } from "../../src/tasks/provider";
// Not mocked (only the GitHub-flavored `pr/provider` and `review/provider`
// modules are, above): Bitbucket's real classes are what the forge selection
// tests below drive through `setConfig({ forge: "bitbucket" })`, exactly as the
// gitlab tests already drive the real GlabProvider/GlabReviewProvider.
import { BbReviewProvider } from "../../src/engine/review/bb/provider";

describe("reviewProvenance", () => {
  it("stamps the drafting agent's name", () => {
    expect(reviewProvenance("claude-code")).toBe("_Drafted with Claude Code via Agent Flow Deck._");
    expect(reviewProvenance("copilot")).toBe("_Drafted with Copilot via Agent Flow Deck._");
  });
});

// createdAt is *now*, not the epoch: a run minted in 1970 is older than any
// abandonment window, so the retire sweep would carry off every fixture that
// has no ticket. A test about an old run gives its own createdAt.
const mkRun = (over: Partial<Run> = {}): Run => ({
  key: "PROJ-1", summary: "do it", url: "https://jira/PROJ-1", createdAt: Date.now(), mode: "per-window",
  repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "b" }], briefPaths: [], ...over,
});
const statusFor = (run: Run, ticketCategory: string | null = null): RunStatus => ({
  run, column: "progress", ticketStatus: null, ticketCategory, repos: [],
  agent: { state: "unknown", lastActivityMs: null, slug: null }, windowOpen: false, prs: {}, agents: [],
  shelf: "board" as const,
});
const reviewFixture = (): ReviewRequest => ({
  id: "CyberJackGit/aws-ops#8491", repo: "CyberJackGit/aws-ops", repoName: "aws-ops",
  number: 8491, title: "isolate renew queue", url: "https://github.com/CyberJackGit/aws-ops/pull/8491",
  author: "einavsaad", isDraft: false, createdAt: 1, updatedAt: 2,
  additions: 350, deletions: 4, changedFiles: 7,
  ci: "passing" as const, review: "review_required" as const, mergeable: "clean" as const,
  localPath: null, runKey: null, draftPath: null,
});

/** A TaskConnector standing in for Jira. The Deck's polling path only ever calls
 * `provider().status(key)`, `provider().detail(key)` (a flow's launch, Task 5),
 * `isAuthenticated()`, and `keyFromUrl()` (through
 * `ticketKeyFor`) — see src/deckView.ts — so nothing else here needs to do
 * anything real. `keyFromUrl` mirrors the real Jira connector's own /browse/
 * parsing (src/tasks/jira/connector.ts) rather than a stub that always answers
 * null: several fixtures below (a local card's inferred ticket, a promoted
 * local card's place-hash key) depend on that url shape actually resolving to
 * a key, exactly as it does against the shipped Jira connector. */
function fakeConnector(authed = false, label = "Jira"): TaskConnector {
  const BROWSE = "/browse/";
  return {
    id: "jira",
    setupSteps: 2,
    signInSteps: 2,
    info: () => ({
      label, scopeNoun: "project", scopeValue: "PROJ", endpoint: "https://jira",
      exampleKey: "PROJ-1234", endpointSetting: "agentFlow.jira.baseUrl", scopeSetting: "agentFlow.jira.project",
    }),
    isConfigured: () => true,
    configure: async () => async () => undefined,
    isAuthenticated: async () => authed,
    signIn: async () => true,
    signOut: async () => undefined,
    provider: () => ({ status: h.getStatus, detail: h.getDetail, list: h.taskList }) as unknown as TaskProvider,
    probe: async () => ({}),
    taskUrl: (key: string) => `https://jira${BROWSE}${key}`,
    keyFromUrl: (url: string) => {
      const i = typeof url === "string" ? url.indexOf(BROWSE) : -1;
      if (i < 0) return null;
      const key = url.slice(i + BROWSE.length).trim();
      return key || null;
    },
  };
}

const lastPanel = () => window.createWebviewPanel.mock.results.at(-1)!.value as ReturnType<typeof import("../_mocks/vscode").makeWebviewPanel>;
const posts = (p: ReturnType<typeof lastPanel>) => p.webview.postMessage.mock.calls.map((c) => c[0] as any);
const show = (authed = false, label = "Jira") => DeckPanel.show(fakeContext().context as any, fakeConnector(authed, label), () => {});
const settled = () => new Promise<void>((r) => setTimeout(r, 0));

/** The journal events this pass recorded, parsed. Order is write order. */
const journal = () => h.journalLines.map((l) => JSON.parse(l) as Record<string, unknown>);

/** Seeds `h.journalLines` with a real, correctly checksummed line — through the
 * REAL `appendEvent`, not a hand-built JSON string — so `flow:openOutput`'s own
 * `readJournal` call (also the real function, via the mocked `nodeJournalIo`
 * above) has genuine lines to parse rather than something only shaped like
 * one. `dir` and `mint` do not matter here: the mocked `append` ignores its
 * path argument, and this suite does not assert on ids. */
const seedJournal = (flowId: string, ev: JournalEventInput, nowMs: number): void => {
  appendEvent(
    { append: (_p, text) => h.journalLines.push(text.trimEnd()), size: () => null, readFile: () => null, replace: () => {} },
    "/unused", flowId, ev, nowMs,
  );
};

/** The gh probe is kicked off inside the very tick that reads it, so it can
 * never be resolved by the time that same tick's `ghReady()` call returns —
 * a promise can't settle synchronously with the statement that created it.
 * Every assertion about fetch- or search-triggering behavior therefore needs a
 * second, "warmed" tick: one to start (and let resolve) the one-time probe, and
 * an explicit `deck:refresh` after it to actually observe the resolved value.
 * Shared by the PR-facts and review-strip suites — both gate on `ghReady()`. */
const showAndWarm = async (authed = false): Promise<ReturnType<typeof lastPanel>> => {
  show(authed);
  await settled();
  const p = lastPanel();
  await p._fire({ type: "deck:refresh" });
  await settled();
  return p;
};

/** buildRunStatus is mocked in this suite, so open-agents assertions have to go
 * through what buildAll *passes* it — the same way the PR-facts cases already
 * do. `.at(-1)` matches the last call for this run's key, since the
 * constructor's own unawaited refresh can race the explicit one a test fires. */
const builtFor = (key: string) =>
  h.buildRunStatus.mock.calls.map((c) => c[0] as { run: Run; agents: CardAgent[]; prs: PrEntryMap }).filter((i) => i.run.key === key).at(-1)!;

/** Every local card's key is a hash (engine/localRuns.ts's localKey) — read it off
 * the built input rather than hard-coding one. */
const builtLocal = () =>
  h.buildRunStatus.mock.calls.map((c) => c[0] as { run: Run; agents: CardAgent[]; prs: PrEntryMap })
    .filter((i) => i.run.kind === "local").at(-1)!;

/** The last `deck:runs` message actually posted to the webview — the real,
 * host-computed output, as opposed to `builtLocal`/`builtFor` above, which only
 * see what was *passed into* the mocked buildRunStatus. Anything deckView.ts
 * layers on afterward (e.g. inferredTicketKey) only ever shows up here. */
const lastRunsPost = () => posts(lastPanel()).filter((m) => m.type === "deck:runs").at(-1)!;

const sess = (over: Partial<OpenSession> = {}): OpenSession => ({
  pid: 1, sessionId: "s1", cwd: "/r/svc", startedAt: 100, name: "svc-7e", ...over,
});

beforeEach(() => {
  trackSpy.mockClear();
  trackErrorSpy.mockClear();
  h.runs = [mkRun()];
  h.openInEditor.mockClear().mockResolvedValue(true);
  h.openWorkspace.mockClear().mockResolvedValue({ mode: "per-window", briefs: [], opened: [], remoteControl: false });
  h.writePlanFile.mockClear();
  h.prReviewPrompt = "Assess the PR for {key}.{files}";
  h.prReviewAutoFix = false;
  h.seedAgent = true;
  h.showTokenTotal = true; // see the field's own comment: eager sweep on unless a test opts out
  h.usageReadRun.mockClear();
  h.taskDiff.mockClear().mockReturnValue("");
  h.taskDiffBase.mockClear().mockReturnValue("base-sha");
  h.taskChangedFiles.mockClear().mockReturnValue([]);
  // Threads the Jira answer through the way the real buildRunStatus does. The
  // retire sweep reads `status.ticketCategory`, so a stub that dropped it would
  // make "this ticket is done" untestable from the outside.
  h.buildRunStatus.mockReset().mockImplementation(
    (i: { run: Run; ticket: { category: string | null } | null }) => statusFor(i.run, i.ticket?.category ?? null),
  );
  h.removeRun.mockClear();
  h.writeRun.mockClear();
  h.getStatus.mockClear().mockResolvedValue({ status: "In Review", category: "indeterminate" });
  h.prEntries = {};
  h.prFacts = true;
  h.ttlSeconds = 120;
  h.openAgents = true;
  h.inflightShowAll = false;
  h.writePrEntry.mockClear();
  h.removePrEntries.mockClear();
  h.prFetch.mockClear().mockResolvedValue({ ok: true, facts: null });
  h.probeGh.mockClear().mockResolvedValue(null);
  h.ghRun.mockClear().mockResolvedValue(
    JSON.stringify({ data: { repository: { ref: { target: { statusCheckRollup: { state: "SUCCESS" } } } } } }),
  );
  h.reviewSearch.mockClear().mockResolvedValue({ issueCount: 1, requests: [reviewFixture()] });
  h.reviewCache = null;
  h.writeReviewCache.mockClear();
  h.reviewDetail.mockClear().mockResolvedValue({ failing: [], unresolved: null });
  h.repos = [{ name: "aws-ops", path: "/repos/aws-ops", isGit: true }];
  h.reviewRequests = true;
  h.openSessions = [];
  h.openSessionsReadable = true;
  h.liveWindows = [];
  h.currentWindow = undefined;
  h.workspaceFiles = [];
  h.sessionActivity.mockClear().mockReturnValue({ state: "working", lastActivityMs: 4242, slug: "svc-7e-slug" });
  // An implementation, not a resolved value: the real launchReview reports the agent
  // it seeded, which follows whatever `h.agentProvider` is when the launch RUNS — and
  // tests set that after this reset. A value captured here would be stale.
  h.launchReview.mockClear().mockImplementation(async () => ({
    ok: true,
    runKey: "review-aws-ops-8491",
    provider: h.agentProvider === "ask" ? "claude-code" : h.agentProvider,
  }));
  h.openSharedWorkspace.mockClear().mockResolvedValue({ opened: true, briefs: [], seeded: 0 });
  vi.mocked(createWorktrees).mockReset();
  h.existsSync.mockClear().mockReturnValue(true);
  h.readFileSync.mockClear().mockReturnValue("");
  h.gitState.mockClear().mockImplementation((name: string, path: string) => ({
    name, path, branch: "b", dirty: false, ahead: 0, added: 0, removed: 0, files: 0,
  }));
  h.reviewWrites = false;
  h.reviewRequestsAlwaysVisible = true;
  h.stampLabelOnWrite = true;
  h.agentProvider = "claude-code";
  h.reviewSubmit.mockClear().mockResolvedValue({ ok: true });
  h.mergeWrites = false;
  h.mergeMethod = "squash";
  h.prMerge.mockClear().mockResolvedValue({ ok: true });
  h.branch = "PROJ-5641-team-table";
  h.flows = [];
  h.idSeq = 0;
  // The honest default: every read sees whatever is "on disk" right now, including
  // a write this same pass just made. Only the two-window race tests override it.
  h.readFlows.mockClear().mockImplementation(() => h.flows);
  // Honest, not just recorded: replaces the entry sharing this id, or appends
  // when it's new — exactly what the real file-per-id store does. A test that
  // wants the store's OWN write to be visible on a later read (e.g. a second
  // refresh, or postFlows() right after advanceArmedFlows) needs this; a test
  // that only inspects `h.writeFlow.mock.calls` is unaffected either way.
  h.writeFlow.mockClear().mockImplementation((_io: unknown, _dir: string, flow: Flow) => {
    const i = h.flows.findIndex((f) => f.id === flow.id);
    h.flows = i >= 0 ? h.flows.map((f, idx) => (idx === i ? flow : f)) : [...h.flows, flow];
  });
  h.removeFlow.mockClear();
  h.templates = [];
  h.readTemplates.mockClear().mockImplementation(() => h.templates);
  h.writeTemplate.mockClear().mockImplementation((_io: unknown, _dir: string, t: FlowTemplate) => {
    const i = h.templates.findIndex((x) => x.id === t.id);
    h.templates = i >= 0 ? h.templates.map((x, idx) => (idx === i ? t : x)) : [...h.templates, t];
  });
  h.removeTemplate.mockClear();
  h.commands = [];
  h.exec.mockClear().mockImplementation((_command: string, _opts: unknown, cb: ExecCallback) => {
    cb(null, "deployed 3 services", "warning: slow");
  });
  h.acquire.mockClear().mockReturnValue(true);
  h.renew.mockClear().mockReturnValue(true);
  h.lockIoLog = undefined;
  h.journalLines = [];
  h.journalThrows = false;
  h.discoverRepos.mockClear().mockImplementation(() => h.repos);
  h.release.mockClear();
  h.launchPlanned.mockClear().mockImplementation(
    async (req: { node: { ticketKey: string; repos: string[] } }) =>
      ({ ok: true, runKey: req.node.ticketKey, repo: req.node.repos[0] }),
  );
  h.getDetail.mockClear().mockImplementation(async (key: string) => ({
    key, summary: "do it", url: `https://jira/browse/${key}`, descriptionText: "the description",
    labels: [], components: [], status: null, statusCategory: null,
  }));
  h.taskList.mockClear().mockResolvedValue([
    {
      key: "PROJ-9", summary: "Ship the migration", status: "", statusCategory: "new", priority: "",
      assignee: "Unassigned", labels: [], components: [], sprint: null, inOpenSprint: false,
      updated: "", url: "https://jira/browse/PROJ-9", estimateSeconds: null,
    },
  ]);
  h.branch2 = "main";
  h.branch3 = "main";
  h.nonGitRoots = new Set();
  h.repoRootRemap = new Map();
  // Confirm by default: resolve the label passed as the modal's sole action item,
  // rather than vscode's own mock default of `undefined` (which reads as "declined"
  // for every other suite in this file). Individual tests override this per case.
  (window.showWarningMessage as ReturnType<typeof vi.fn>).mockImplementation(
    async (_message: string, _options: unknown, ...items: string[]) => items[0],
  );
});

afterEach(() => {
  // Dispose any open panel so the DeckPanel singleton resets between tests.
  const r = window.createWebviewPanel.mock.results.at(-1);
  if (r) (r.value as any)._fireDispose();
});

describe("DeckPanel", () => {
  it("creates a panel and wires its html on show", () => {
    show();
    expect(window.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(window.createWebviewPanel).toHaveBeenCalledWith("agentFlow.deck", expect.any(String), ViewColumn.Active, expect.any(Object));
    expect(lastPanel().webview.html).toContain("<div id=\"root\">");
  });

  it("is a singleton — a second show reveals rather than recreating", () => {
    show();
    const first = lastPanel();
    show();
    expect(window.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(first.reveal).toHaveBeenCalled();
  });

  it("posts reconciled runs on refresh", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:refresh" });
    const runsPost = posts(p).find((m) => m.type === "deck:runs");
    expect(runsPost).toBeTruthy();
    expect(runsPost.runs).toHaveLength(1);
    expect(runsPost.runs[0].run.key).toBe("PROJ-1");
  });

  it("posts the configured PR-review status so cards can gate the button", async () => {
    show();
    await settled();
    const msg = posts(lastPanel()).find((m) => m.type === "deck:runs");
    expect(msg.prReviewStatus).toBe("PR initiated");
  });

  it("posts the connector's own label as sourceLabel on deck:runs", async () => {
    show();
    await settled();
    expect(lastRunsPost().sourceLabel).toBe("Jira");
  });

  it("posts a different connector's label as sourceLabel, proving it is read off the connector rather than hardcoded", async () => {
    show(true, "Acme");
    await settled();
    expect(lastRunsPost().sourceLabel).toBe("Acme");
  });

  it("sends the resolved provider label on deck:runs so Deck copy can name the tool", async () => {
    h.agentProvider = "cursor";
    show();
    await settled();
    expect(lastRunsPost().agentLabel).toBe("Cursor");
  });

  it("keeps review runs off the board — only the ticket run reaches it", async () => {
    h.runs = [
      mkRun(),
      mkRun({ key: "review-aws-ops-8491", summary: "review", url: "https://gh/pr/8491", createdAt: 2, kind: "review" }),
    ];
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:refresh" });
    const msg = posts(p).find((m) => m.type === "deck:runs");
    // Asserting the count, not merely that PROJ-1 is present, is what actually
    // catches the filter being removed — buildRunStatus is a pass-through stub
    // that would happily produce a card for the review run too.
    expect(msg.runs).toHaveLength(1);
    expect(msg.runs[0].run.key).toBe("PROJ-1");
  });

  it("inspect open re-opens the repo path via the editor", async () => {
    show();
    await lastPanel()._fire({ type: "deck:inspect", key: "PROJ-1", action: "open" });
    expect(h.openInEditor).toHaveBeenCalledWith("/r/svc");
  });

  it("inspect open prefers the multi-root workspace file when present", async () => {
    h.runs = [mkRun({ mode: "multiroot", workspaceFile: "/ws/PROJ-1.code-workspace" })];
    show();
    await lastPanel()._fire({ type: "deck:inspect", key: "PROJ-1", action: "open" });
    expect(h.openInEditor).toHaveBeenCalledWith("/ws/PROJ-1.code-workspace");
  });

  it("opens without a success toast (silent focus)", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:inspect", key: "PROJ-1", action: "open" });
    expect(h.openInEditor).toHaveBeenCalledWith("/r/svc");
    const successToast = posts(p).find((m) => m.type === "toast" && m.level === "success");
    expect(successToast).toBeUndefined();
  });

  it("toasts an error when opening fails", async () => {
    h.openInEditor.mockResolvedValueOnce(false);
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:inspect", key: "PROJ-1", action: "open" });
    const errorToast = posts(p).find((m) => m.type === "toast" && m.level === "error");
    expect(errorToast).toBeTruthy();
  });

  it("inspect diff on a repo with no changes toasts instead of opening a doc", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:inspect", key: "PROJ-1", action: "diff" });
    const toast = posts(p).find((m) => m.type === "toast");
    expect(toast.message).toMatch(/No changes to show/i);
    expect(workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it("inspect diff opens the native multi-file editor titled with the run key and the repo", async () => {
    h.taskChangedFiles.mockReturnValue([{ status: "M", path: "a.txt", binary: false }]);
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:inspect", key: "PROJ-1", action: "diff" });
    const call = commands.executeCommand.mock.calls.at(-1)!;
    expect(call[0]).toBe("vscode.changes");
    expect(call[1]).toBe("Changes in PROJ-1 — svc");
    expect(workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it("falls back to the flat patch document when the editor has no such command", async () => {
    // Cursor and other forks may not have registered vscode.changes. Losing the
    // Diff button entirely there would be worse than the old rendering.
    h.taskChangedFiles.mockReturnValue([{ status: "M", path: "a.txt", binary: false }]);
    h.taskDiff.mockReturnValue("diff --git a/a.txt b/a.txt\n+committed\n");
    commands.executeCommand.mockRejectedValueOnce(new Error("no such command"));
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:inspect", key: "PROJ-1", action: "diff" });
    expect(workspace.openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("+committed"), language: "diff" }),
    );
  });

  it("labels each repo's chunk in the fallback document when a run spans more than one", async () => {
    h.runs = [mkRun({ repos: [
      { name: "svc", path: "/r/svc", isGit: true, branch: "b" },
      { name: "web", path: "/r/web", isGit: true, branch: "b" },
    ] })];
    h.taskChangedFiles.mockReturnValue([{ status: "M", path: "a.txt", binary: false }]);
    h.taskDiff.mockReturnValue("diff --git a/a.txt b/a.txt\n+x\n");
    commands.executeCommand.mockRejectedValueOnce(new Error("no such command"));
    // A run spanning repos asks which one first; this is the "all of them" answer.
    window.showQuickPick.mockImplementationOnce(async (items: unknown) => (items as unknown[])[0]);
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:inspect", key: "PROJ-1", action: "diff" });
    const arg = workspace.openTextDocument.mock.calls.at(-1)![0] as { content: string };
    expect(arg.content).toContain("# svc");
    expect(arg.content).toContain("# web");
  });

  it("toasts instead of opening a blank fallback document when the patch comes back empty", async () => {
    // The changed-file list and the patch are two separate git reads; if they ever
    // disagree, an empty document is the one outcome worse than a toast.
    h.taskChangedFiles.mockReturnValue([{ status: "M", path: "a.txt", binary: false }]);
    h.taskDiff.mockReturnValue("");
    commands.executeCommand.mockRejectedValueOnce(new Error("no such command"));
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:inspect", key: "PROJ-1", action: "diff" });
    const toast = posts(p).find((m) => m.type === "toast");
    expect(toast.message).toMatch(/No changes to show/i);
    expect(workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it("toasts rather than opening an empty editor when only binaries changed", async () => {
    h.taskChangedFiles.mockReturnValue([{ status: "M", path: "pic.bin", binary: true }]);
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:inspect", key: "PROJ-1", action: "diff" });
    const toast = posts(p).find((m) => m.type === "toast");
    expect(toast.message).toMatch(/binary/i);
    expect(commands.executeCommand).not.toHaveBeenCalled();
  });

  it("diffs only the named repo when a card acts on one", async () => {
    h.runs = [mkRun({ repos: [
      { name: "svc", path: "/r/svc", isGit: true, branch: "b" },
      { name: "web", path: "/r/web", isGit: true, branch: "b" },
    ] })];
    h.taskChangedFiles.mockReturnValue([{ status: "M", path: "a.txt", binary: false }]);
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:inspect", key: "PROJ-1", action: "diff", repo: "web" });
    expect(h.taskChangedFiles).toHaveBeenCalledWith("/r/web");
    expect(h.taskChangedFiles).not.toHaveBeenCalledWith("/r/svc");
  });

  // ── which repo am I looking at? (multi-repo diff scoping) ──────────────────
  const twoRepoRun = (over: Partial<Run> = {}) => mkRun({ repos: [
    { name: "svc", path: "/r/svc", isGit: true, branch: "b" },
    { name: "web", path: "/r/web", isGit: true, branch: "b" },
  ], ...over });
  /** The picker's items, as the host offered them. */
  const pickItems = () => (window.showQuickPick.mock.calls.at(-1)![0] as { label: string }[]).map((i) => i.label);
  /** Answer the repo picker with the item whose label matches. */
  const pickRepo = (label: string) =>
    window.showQuickPick.mockImplementationOnce(async (items: unknown) =>
      (items as { label: string }[]).find((i) => i.label === label));

  it("asks which repo to diff when a run spans more than one", async () => {
    h.runs = [twoRepoRun()];
    h.taskChangedFiles.mockReturnValue([{ status: "M", path: "a.txt", binary: false }]);
    pickRepo("web");
    show();
    await lastPanel()._fire({ type: "deck:inspect", key: "PROJ-1", action: "diff" });
    expect(pickItems()).toEqual(["All repos", "svc", "web"]);
    expect(h.taskChangedFiles).toHaveBeenCalledWith("/r/web");
    expect(h.taskChangedFiles).not.toHaveBeenCalledWith("/r/svc");
  });

  it("names the picked repo in the diff editor's title", async () => {
    h.runs = [twoRepoRun()];
    h.taskChangedFiles.mockReturnValue([{ status: "M", path: "a.txt", binary: false }]);
    pickRepo("web");
    show();
    await lastPanel()._fire({ type: "deck:inspect", key: "PROJ-1", action: "diff" });
    expect(commands.executeCommand.mock.calls.at(-1)![1]).toBe("Changes in PROJ-1 — web");
  });

  it("diffs every repo and names the workspace when All repos is picked", async () => {
    h.runs = [twoRepoRun({ mode: "multiroot", workspaceFile: "/ws/pay-stack.code-workspace" })];
    h.taskChangedFiles.mockReturnValue([{ status: "M", path: "a.txt", binary: false }]);
    pickRepo("All repos");
    show();
    await lastPanel()._fire({ type: "deck:inspect", key: "PROJ-1", action: "diff" });
    expect(h.taskChangedFiles).toHaveBeenCalledWith("/r/svc");
    expect(h.taskChangedFiles).toHaveBeenCalledWith("/r/web");
    expect(commands.executeCommand.mock.calls.at(-1)![1]).toBe("Changes in PROJ-1 — pay-stack");
  });

  it("offers the workspace's name as the All repos detail so the picker says what all means", async () => {
    h.runs = [twoRepoRun({ mode: "multiroot", workspaceFile: "/ws/pay-stack.code-workspace" })];
    h.taskChangedFiles.mockReturnValue([{ status: "M", path: "a.txt", binary: false }]);
    pickRepo("All repos");
    show();
    await lastPanel()._fire({ type: "deck:inspect", key: "PROJ-1", action: "diff" });
    const items = window.showQuickPick.mock.calls.at(-1)![0] as { label: string; detail?: string }[];
    expect(items[0].detail).toContain("pay-stack");
  });

  it("does not ask when the run has only one repo", async () => {
    h.taskChangedFiles.mockReturnValue([{ status: "M", path: "a.txt", binary: false }]);
    show();
    await lastPanel()._fire({ type: "deck:inspect", key: "PROJ-1", action: "diff" });
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(commands.executeCommand.mock.calls.at(-1)![1]).toBe("Changes in PROJ-1 — svc");
  });

  it("does not ask when the card already acts on one repo", async () => {
    h.runs = [twoRepoRun()];
    h.taskChangedFiles.mockReturnValue([{ status: "M", path: "a.txt", binary: false }]);
    show();
    await lastPanel()._fire({ type: "deck:inspect", key: "PROJ-1", action: "diff", repo: "web" });
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(commands.executeCommand.mock.calls.at(-1)![1]).toBe("Changes in PROJ-1 — web");
  });

  it("opens nothing and says nothing when the repo picker is dismissed", async () => {
    h.runs = [twoRepoRun()];
    h.taskChangedFiles.mockReturnValue([{ status: "M", path: "a.txt", binary: false }]);
    show(); // the mock's showQuickPick resolves undefined by default — a dismissal
    const p = lastPanel();
    await p._fire({ type: "deck:inspect", key: "PROJ-1", action: "diff" });
    expect(commands.executeCommand).not.toHaveBeenCalledWith("vscode.changes", expect.anything(), expect.anything());
    expect(workspace.openTextDocument).not.toHaveBeenCalled();
    expect(posts(p).find((m) => m.type === "toast")).toBeUndefined();
  });

  it("labels no chunk in the fallback document once the diff is scoped to one repo", async () => {
    // The header exists to tell two repos' patches apart; with one repo picked it
    // is noise above the only patch there is.
    h.runs = [twoRepoRun()];
    h.taskChangedFiles.mockReturnValue([{ status: "M", path: "a.txt", binary: false }]);
    h.taskDiff.mockReturnValue("diff --git a/a.txt b/a.txt\n+x\n");
    commands.executeCommand.mockRejectedValueOnce(new Error("no such command"));
    pickRepo("web");
    show();
    await lastPanel()._fire({ type: "deck:inspect", key: "PROJ-1", action: "diff" });
    const arg = workspace.openTextDocument.mock.calls.at(-1)![0] as { content: string };
    expect(arg.content).not.toContain("# web");
  });

  it("toasts an error when inspecting an unknown run", async () => {
    h.runs = [];
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:inspect", key: "NOPE-9", action: "open" });
    const toast = posts(p).find((m) => m.type === "toast" && m.level === "error");
    expect(toast).toBeTruthy();
    expect(h.openInEditor).not.toHaveBeenCalled();
  });

  it("forgets a run and re-posts the board", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:forget", key: "PROJ-1" });
    expect(h.removeRun).toHaveBeenCalledWith("/runs", "PROJ-1");
    expect(posts(p).some((m) => m.type === "deck:runs")).toBe(true);
  });

  it("does not look up Jira for a run with no ticket", async () => {
    h.runs = [mkRun({ key: "explore-retry-logic", url: "" })];
    show(true);
    const p = lastPanel();
    await p._fire({ type: "deck:refresh" });
    // The key is synthetic — every lookup 404s, logs, and returns null anyway.
    expect(h.getStatus).not.toHaveBeenCalled();
  });

  it("still looks up Jira for a tracked run sharing the board with an untracked one", async () => {
    h.runs = [mkRun(), mkRun({ key: "explore-retry-logic", url: "" })];
    show(true);
    const p = lastPanel();
    await p._fire({ type: "deck:refresh" });
    // Asserted by argument, not by count: the constructor's unawaited first refresh
    // races this one, and whether the second finds a warm ticketCache depends on
    // microtask ordering. Which keys are looked up at all is the actual contract.
    expect(h.getStatus).toHaveBeenCalledWith("PROJ-1");
    expect(h.getStatus).not.toHaveBeenCalledWith("explore-retry-logic");
  });

  it("hands an untracked run an empty PR map even when the store has entries for its key", async () => {
    // A stale prfacts file left by an earlier version must not render: the PR it
    // names was matched off the repo's default branch and belongs to another task.
    h.prEntries = { svc: { facts: null, fetchedAt: Date.now() } };
    h.runs = [mkRun({ key: "explore-retry-logic", url: "", repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "master" }] })];
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:refresh" });
    const prs = h.buildRunStatus.mock.calls.at(-1)![0].prs;
    expect(prs).toEqual({});
  });

  it("opens an external url via the host (Open in Jira)", async () => {
    show();
    await lastPanel()._fire({ type: "openExternal", url: "https://jira/PROJ-1" });
    expect(env.openExternal).toHaveBeenCalled();
  });

  it("refuses a non-http(s) scheme from the webview (F5)", async () => {
    // f.url and every failing check's detailsUrl/targetUrl now come from GitHub's
    // API, which a check-run producer controls — a vscode://<publisher>.<ext>/…
    // url must never reach openExternal.
    show();
    await lastPanel()._fire({ type: "openExternal", url: "vscode://malicious.ext/handler" });
    expect(env.openExternal).not.toHaveBeenCalled();
  });

  it("opens an https url from the webview (F5)", async () => {
    show();
    await lastPanel()._fire({ type: "openExternal", url: "https://github.com/acme/api/pull/4821" });
    expect(env.openExternal).toHaveBeenCalled();
  });

  it("toasts when a run has nothing to open", async () => {
    h.runs = [mkRun({ repos: [] })];
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:inspect", key: "PROJ-1", action: "open" });
    const toast = posts(p).find((m) => m.type === "toast" && /nothing to open/i.test(m.message));
    expect(toast).toBeTruthy();
    expect(h.openInEditor).not.toHaveBeenCalled();
  });

  it("swallows a build error during refresh (no runs posted, no throw)", async () => {
    h.buildRunStatus.mockReset().mockImplementation(() => { throw new Error("boom"); });
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:refresh" });
    expect(posts(p).some((m) => m.type === "deck:runs")).toBe(false);
  });

  it("fetches Jira status when authenticated and passes it to the builder", async () => {
    show(true);
    const p = lastPanel();
    await p._fire({ type: "deck:refresh" });
    expect(h.getStatus).toHaveBeenCalledWith("PROJ-1");
    expect(h.buildRunStatus).toHaveBeenCalledWith(expect.objectContaining({
      ticket: { status: "In Review", category: "indeterminate" },
      projectsRoot: expect.any(String), nowMs: expect.any(Number),
      openIdentities: expect.any(Set), prs: {},
    }));
  });

  it("degrades to the git backbone on a Jira auth error, without logging it as a failure", async () => {
    // `ticket: null` alone can't tell this branch apart from the generic catch
    // right below it: with no cache primed, that branch's own fallback
    // (`return hit ? … : null`) also lands on null, so the assertion below would
    // pass even if the `instanceof TaskAuthError` check were deleted outright.
    // What genuinely distinguishes the two: the generic branch logs the failure
    // before falling back, and this one is silent by design — an auth lapse is
    // routine, not a failure worth a log line every 6s poll tick. Asserting on
    // the log is what makes this test fail if that branch ever stops being
    // entered.
    h.getStatus.mockRejectedValueOnce(new TaskAuthError("nope"));
    const log = vi.fn();
    DeckPanel.show(fakeContext().context as any, fakeConnector(true), log);
    const p = lastPanel();
    await p._fire({ type: "deck:refresh" });
    expect(h.buildRunStatus).toHaveBeenCalledWith(expect.objectContaining({
      ticket: null, projectsRoot: expect.any(String), nowMs: expect.any(Number),
      openIdentities: expect.any(Set), prs: {},
    }));
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("ticket status"));
  });

  it("keeps rendering when a Jira lookup fails for another reason", async () => {
    h.getStatus.mockRejectedValueOnce(new Error("timeout"));
    show(true);
    const p = lastPanel();
    await p._fire({ type: "deck:refresh" });
    expect(posts(p).some((m) => m.type === "deck:runs")).toBe(true);
  });

  it("pauses and resumes polling on visibility changes without throwing", async () => {
    show();
    const p = lastPanel();
    p.visible = false;
    expect(() => p._fireViewState()).not.toThrow();
    p.visible = true;
    expect(() => p._fireViewState()).not.toThrow();
  });

  it("brackets a forget with the busy indicator", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:forget", key: "PROJ-1" });
    const loads = posts(p).filter((m) => m.type === "deck:loading").map((m) => m.loading);
    expect(loads).toContain(true);
    expect(loads.at(-1)).toBe(false);
  });

  it("brackets a prFacts change with the busy indicator", async () => {
    show();
    const p = lastPanel();
    h.prFacts = false;
    setConfig({ prFacts: false });
    fireConfigurationChanged("agentFlow.prFacts");
    await settled();
    const loads = posts(p).filter((m) => m.type === "deck:loading").map((m) => m.loading);
    expect(loads).toContain(true);
    expect(loads.at(-1)).toBe(false);
  });

  it("issues every run's Jira lookup at once rather than one at a time", async () => {
    // Serially, a cold board of six runs costs six round trips before anything
    // paints — and Forget waits on that whole pass.
    h.runs = [mkRun(), mkRun({ key: "PROJ-2", url: "https://jira/PROJ-2" }), mkRun({ key: "PROJ-3", url: "https://jira/PROJ-3" })];
    let inFlight = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.getStatus.mockImplementation(async () => {
      inFlight++;
      await gate;
      return { status: "In Review", category: "indeterminate" };
    });
    // show() alone: the constructor starts polling with an unawaited refresh, which
    // is the pass under test. Firing a second deck:refresh on top would put six
    // lookups in flight (nothing has resolved, so nothing is cached yet) and the
    // count below would not distinguish serial from parallel.
    show(true);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(inFlight).toBe(3); // all three started before any resolved
    release();
    // Let the released pass finish here rather than leaking pending Jira work into
    // whichever test runs next.
    await new Promise<void>((r) => setTimeout(r, 0));
  });

  it("does not post a board an overtaken refresh built", async () => {
    // The snapshot of an older pass predates whatever the newer one read: a poll that
    // listed the runs directory before a Forget deleted from it would otherwise put
    // the forgotten card straight back on the board.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.getStatus.mockImplementationOnce(async () => {
      await gate;
      return { status: "In Review", category: "indeterminate" };
    });
    // The constructor's unawaited refresh hangs on the gate, so the explicit refresh
    // below overtakes it. Nothing is cached while the first pass is stuck, so the
    // second makes its own getStatus call and runs to completion.
    show(true);
    const p = lastPanel();
    await p._fire({ type: "deck:refresh" });
    release();
    await settled();
    expect(posts(p).filter((m) => m.type === "deck:runs")).toHaveLength(1);
  });

  it("posts one busy pair for overlapping refreshes, not one per refresh", async () => {
    // Two busy-triggering messages in quick succession: the earlier one's `finally`
    // must not stop the spinner while the later refresh is still working.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.getStatus.mockImplementation(async () => {
      await gate;
      return { status: "In Review", category: "indeterminate" };
    });
    show(true);
    const p = lastPanel();
    const first = p._fire({ type: "deck:refresh" });
    const second = p._fire({ type: "deck:refresh" });
    await settled(); // both refreshes are now in flight, both stuck on the gate
    release();
    await Promise.all([first, second]);
    const loads = posts(p).filter((m) => m.type === "deck:loading").map((m) => m.loading);
    expect(loads).toEqual([true, false]);
  });
});

describe("deck telemetry", () => {
  const openPanel = async () => {
    show();
    await settled();
    const p = lastPanel();
    return { p, send: async (m: unknown) => { await p._fire(m); await settled(); } };
  };

  it("emits deck_opened once on a fresh open, with revealed:false", async () => {
    await openPanel();
    const opened = trackSpy.mock.calls.flat().filter((e: any) => e.name === "deck_opened");
    expect(opened).toHaveLength(1);
    expect(opened[0].revealed).toBe(false);
    expect(typeof opened[0].flow_count).toBe("number");
  });

  it("emits deck_opened with revealed:true when an already-open panel is revealed instead of recreated", async () => {
    await openPanel();
    trackSpy.mockClear();
    show(); // second show() on an existing panel takes the reveal branch
    const opened = trackSpy.mock.calls.flat().filter((e: any) => e.name === "deck_opened");
    expect(opened).toHaveLength(1);
    expect(opened[0].revealed).toBe(true);
  });

  it("emits deck_action for a grouping change, carrying the grouping enum", async () => {
    const { send } = await openPanel();
    trackSpy.mockClear();
    await send({ type: "deck:setGrouping", grouping: "workspaces" });
    const act = trackSpy.mock.calls.flat().find((e: any) => e.name === "deck_action");
    expect(act).toMatchObject({ action: "set_grouping", grouping: "workspaces" });
  });

  // `grouping` is typed "agents" | "workspaces" at compile time only — a webview
  // message is untyped at runtime. The gesture still counts (deck_action fires
  // either way); only the unrecognised value is withheld.
  it("still counts the gesture but omits grouping when the value is out of union", async () => {
    const { send } = await openPanel();
    trackSpy.mockClear();
    await send({ type: "deck:setGrouping", grouping: "not-a-real-grouping" as never });
    const act = trackSpy.mock.calls.flat().find((e: any) => e.name === "deck_action");
    expect(act).toMatchObject({ action: "set_grouping" });
    expect(act).not.toHaveProperty("grouping");
  });

  it("emits deck_action inspect_open / inspect_diff from the same deck:inspect message, keyed by payload", async () => {
    const { send } = await openPanel();
    trackSpy.mockClear();
    await send({ type: "deck:inspect", key: "PROJ-1", action: "open" });
    await send({ type: "deck:inspect", key: "PROJ-1", action: "diff" });
    const actions = trackSpy.mock.calls.flat().filter((e: any) => e.name === "deck_action").map((e: any) => e.action);
    expect(actions).toEqual(["inspect_open", "inspect_diff"]);
    // The event carries only the action enum, never the key the message was sent with.
    expect(JSON.stringify(trackSpy.mock.calls.flat())).not.toContain("PROJ-1");
  });

  it("emits deck_action for refresh, clear stale, forget, and open external", async () => {
    const { send } = await openPanel();
    trackSpy.mockClear();
    await send({ type: "deck:refresh" });
    await send({ type: "deck:clearStale" });
    await send({ type: "deck:forget", key: "PROJ-1" });
    await send({ type: "openExternal", url: "https://example.com" });
    const actions = trackSpy.mock.calls.flat().filter((e: any) => e.name === "deck_action").map((e: any) => e.action);
    expect(actions).toEqual(["refresh", "clear_stale", "forget", "open_external"]);
  });

  it("emits no deck_action for read-plumbing messages like deck:reviewExpand", async () => {
    const { send } = await openPanel();
    trackSpy.mockClear();
    await send({ type: "deck:reviewExpand", id: "PROJ-1" });
    expect(trackSpy.mock.calls.flat().find((e: any) => e.name === "deck_action")).toBeUndefined();
  });

  it("emits operation_failed from the new onMessage catch and never a user string", async () => {
    const { send } = await openPanel();
    const panel = (DeckPanel as any).current;
    vi.spyOn(panel, "refreshBusy").mockRejectedValueOnce(new Error("boom"));
    trackErrorSpy.mockClear();
    await send({ type: "deck:refresh" });
    const err = trackErrorSpy.mock.calls.flat().find((e: any) => e.name === "operation_failed") as any;
    expect(err).toBeDefined();
    expect(err.op).toBe("pr_lookup");
    expect(err.retryable).toBe(false);
  });

  // Unlike the case above, `deck:refresh` carries no key — so a leak check against it
  // is true no matter what the emit does, and would not catch a real regression. Force
  // the failure on a message that DOES carry a real key (`deck:forget`, key "PROJ-1"),
  // by making the engine call that case makes first (`removeRun`) throw, and check the
  // key never reaches either spy's serialized calls.
  it("never leaks the message's key into operation_failed or any deck_action, even when the failing handler was given one", async () => {
    const { send } = await openPanel();
    h.removeRun.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    trackSpy.mockClear();
    trackErrorSpy.mockClear();
    await send({ type: "deck:forget", key: "PROJ-1" });
    const err = trackErrorSpy.mock.calls.flat().find((e: any) => e.name === "operation_failed") as any;
    expect(err).toBeDefined();
    // "deck:forget" is absent from DECK_MESSAGE_OPS, so it falls back to the default op.
    expect(err.op).toBe("workspace_write");
    expect(err.retryable).toBe(false);
    expect(JSON.stringify(trackSpy.mock.calls.flat())).not.toContain("PROJ-1");
    expect(JSON.stringify(trackErrorSpy.mock.calls.flat())).not.toContain("PROJ-1");
  });

  it("does not report operation_failed for a message absent from the op map, falling back to workspace_write", async () => {
    const { send } = await openPanel();
    const panel = (DeckPanel as any).current;
    vi.spyOn(panel as any, "switchForgeAccount").mockRejectedValueOnce(new Error("boom"));
    trackErrorSpy.mockClear();
    await send({ type: "deck:switchAccount" });
    const err = trackErrorSpy.mock.calls.flat().find((e: any) => e.name === "operation_failed") as any;
    expect(err).toBeDefined();
    expect(err.op).toBe("workspace_write");
  });
});

describe("DeckPanel open agents", () => {
  it("attaches every open session in a run's repo to that run's card", async () => {
    h.runs = [mkRun({ key: "PROJ-1", repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "PROJ-1-x" }] })];
    h.openSessions = [sess(), sess({ pid: 2, sessionId: "s2", startedAt: 200, name: "svc-fa" })];
    show();
    await settled();
    expect(builtFor("PROJ-1").agents.map((a) => a.session.name)).toEqual(["svc-7e", "svc-fa"]);
  });

  it("gives a run with no session open an empty agents list", async () => {
    h.runs = [mkRun({ key: "PROJ-1" })];
    h.openSessions = [];
    show();
    await settled();
    expect(builtFor("PROJ-1").agents).toEqual([]);
  });

  it("does not attach a session running somewhere else", async () => {
    h.runs = [mkRun({ key: "PROJ-1", repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "b" }] })];
    h.openSessions = [sess({ cwd: "/r/other", name: "other-1" })];
    show();
    await settled();
    expect(builtFor("PROJ-1").agents).toEqual([]);
  });

  it("still lists an attached session when its transcript is unreadable", async () => {
    // The registry knows the session is open; only the transcript goes unread.
    // That is now the sole route to an unknown activity, and it must not drop the
    // session from the card.
    h.runs = [mkRun({ key: "PROJ-1", repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "b" }] })];
    h.openSessions = [sess()];
    h.sessionActivity.mockReturnValue({ state: "unknown", lastActivityMs: null, slug: null });
    show();
    await settled();
    const agents = builtFor("PROJ-1").agents;
    expect(agents).toHaveLength(1);
    expect(agents[0].session.name).toBe("svc-7e");
    expect(agents[0].activity).toEqual({ state: "unknown", lastActivityMs: null, slug: null });
  });

  it("reads the session's own live activity when the live signal is on, keyed to that session", async () => {
    h.runs = [mkRun({ key: "PROJ-1", repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "b" }] })];
    h.openSessions = [sess()];
    show();
    await settled();
    // Called with the session's own cwd and sessionId, not the run's repo path
    // or the place key — a session started in a subdirectory has its transcript
    // filed under that subdirectory, which only the session's own cwd names.
    expect(h.sessionActivity).toHaveBeenCalledWith(expect.any(String), "/r/svc", "s1", expect.any(Number));
    expect(builtFor("PROJ-1").agents[0].activity).toEqual({ state: "working", lastActivityMs: 4242, slug: "svc-7e-slug" });
  });

  it("reads no sessions at all with open agents off", async () => {
    h.openAgents = false;
    h.runs = [mkRun({ key: "PROJ-1", repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "b" }] })];
    h.openSessions = [sess()];
    show();
    await settled();
    expect(builtFor("PROJ-1").agents).toEqual([]);
  });

  it("re-reads when the toggle comes back on", async () => {
    h.openAgents = false;
    h.runs = [mkRun({ key: "PROJ-1", repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "b" }] })];
    h.openSessions = [sess()];
    show();
    await settled();
    h.openAgents = true;
    setConfig({ openAgents: true });
    fireConfigurationChanged("agentFlow.openAgents");
    await settled();
    expect(builtFor("PROJ-1").agents).toHaveLength(1);
  });

  it("tags each agent with the run repo whose directory it runs in", async () => {
    h.runs = [mkRun({
      key: "PROJ-9",
      repos: [
        { name: "api", path: "/repos/api", isGit: true, branch: "PROJ-9-x" },
        { name: "web", path: "/repos/web", isGit: true, branch: "PROJ-9-x" },
      ],
    })];
    h.openSessions = [
      sess({ pid: 11, sessionId: "s-api", cwd: "/repos/api", startedAt: 1, name: "api-1a" }),
      sess({ pid: 12, sessionId: "s-web", cwd: "/repos/web", startedAt: 2, name: "web-2b" }),
    ];
    show();
    await settled();
    expect(builtFor("PROJ-9").agents.map((a) => [a.session.sessionId, a.repo])).toEqual([
      ["s-api", "api"],
      ["s-web", "web"],
    ]);
  });

  it("tags a local card's agent with the synthetic run's only repo name", async () => {
    h.runs = [];
    h.openSessions = [sess({ cwd: "/r/webapp", name: "webapp-7e" })];
    show();
    await settled();
    const built = builtLocal();
    expect(built.agents.map((a) => a.repo)).toEqual([built.run.repos[0].name]);
  });
});

describe("session ownership — one agent, one card", () => {
  const NOW = Date.now();
  const MIN = 60_000;
  // Four notepad runs launched in place, all on one checkout. This is the real
  // shape: two live agents used to render as 4 x 2 = 8 cards.
  const notepad = (key: string, createdAt: number): Run =>
    mkRun({ key, kind: "notepad", url: "", createdAt, summary: key,
      repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "main" }] });

  beforeEach(() => {
    h.runs = [
      notepad("notepad-a", NOW - 90 * MIN),
      notepad("notepad-b", NOW - 60 * MIN),
      notepad("notepad-c", NOW - 30 * MIN),
      notepad("notepad-d", NOW - 10 * MIN),
    ];
    h.openSessions = [
      sess({ sessionId: "s1", cwd: "/r/svc", startedAt: NOW - 45 * MIN }),
      sess({ pid: 2, sessionId: "s2", cwd: "/r/svc", startedAt: NOW - 5 * MIN }),
    ];
  });

  it("attaches each session exactly once across every run sharing the checkout", async () => {
    show();
    await settled();
    const attached = ["notepad-a", "notepad-b", "notepad-c", "notepad-d"]
      .flatMap((k) => builtFor(k).agents.map((a) => a.session.sessionId));
    expect(attached.sort()).toEqual(["s1", "s2"]);
  });

  it("gives each session to the newest run created at or before it started", async () => {
    show();
    await settled();
    expect(builtFor("notepad-b").agents.map((a) => a.session.sessionId)).toEqual(["s1"]);
    expect(builtFor("notepad-d").agents.map((a) => a.session.sessionId)).toEqual(["s2"]);
    expect(builtFor("notepad-a").agents).toEqual([]);
    expect(builtFor("notepad-c").agents).toEqual([]);
  });

  it("still claims the place, so it does not also become a local card", async () => {
    show();
    await settled();
    // The place belongs to a tracked run whether or not that run owns the
    // session in it, so no synthetic local card may be built for it.
    const localCalls = h.buildRunStatus.mock.calls
      .map((c) => c[0] as { run: Run }).filter((i) => i.run.kind === "local");
    expect(localCalls).toEqual([]);
  });
});

describe("shelf", () => {
  const NOW = Date.now();
  const MIN = 60_000;
  // shelf is attached AFTER the mocked buildRunStatus returns, so it is only
  // visible on the real posted message — not on what was passed in.
  const shelfOf = (key: string) => lastRunsPost().runs.find((r: RunStatus) => r.run.key === key)?.shelf;
  const notepad = (key: string, createdAt: number): Run =>
    mkRun({ key, kind: "notepad", url: "", createdAt, summary: key,
      repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "main" }] });
  // A ticket run sharing that same checkout — what `agentFlow.worktree: "never"`
  // produces, and the only kind for which the dirty tree is still its own.
  const dirtyShare = (key: string, createdAt: number): Run =>
    mkRun({ key, createdAt, summary: key,
      repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "main" }] });

  it("keeps a just-launched run on the board with no agent and no PR", async () => {
    // mkRun's createdAt is now, and the launch grace is what holds this one: the
    // window is still opening and Claude Code has not written a transcript for
    // the new worktree yet, so every other signal is false.
    h.runs = [mkRun()];
    show();
    await settled();
    expect(shelfOf("PROJ-1")).toBe("board");
  });

  it("closes an aged ticket run whose open ticket is the only thing left", async () => {
    // The signal that stopped counting. An open Jira ticket is somebody else's
    // status field, not work in flight: no agent, no PR, nothing uncommitted or
    // unpushed means there is nothing on this card to act on.
    h.runs = [mkRun({ createdAt: NOW - 90 * MIN })];
    h.openSessions = [];
    show();
    await settled();
    expect(shelfOf("PROJ-1")).toBe("closed");
  });

  it("keeps an aged ticket run with a live agent on the board", async () => {
    h.runs = [mkRun({ createdAt: NOW - 90 * MIN })];
    h.openSessions = [sess({ sessionId: "s1", cwd: "/r/svc", startedAt: NOW - 10 * MIN })];
    show();
    await settled();
    expect(shelfOf("PROJ-1")).toBe("board");
  });

  it("closes a notepad run with no agent, no PR and a clean tree", async () => {
    // The window is what keeps the record alive long enough to HAVE a shelf: on the
    // shipped `retireInPlaceAfterHours: 0` the sweep retires this run on sight, so
    // there would be no posted card to read a shelf off. `shelfFor` is the subject
    // here, and rule 0 reads its answer rather than the other way round.
    setConfig({ retireInPlaceAfterHours: 24 });
    h.runs = [notepad("notepad-a", NOW - 90 * MIN)];
    h.openSessions = [];
    show();
    await settled();
    expect(shelfOf("notepad-a")).toBe("closed");
  });

  it("keeps a notepad run with a live agent on the board", async () => {
    h.runs = [notepad("notepad-a", NOW - 90 * MIN)];
    h.openSessions = [sess({ sessionId: "s1", cwd: "/r/svc", startedAt: NOW - 10 * MIN })];
    show();
    await settled();
    expect(shelfOf("notepad-a")).toBe("board");
  });

  it("counts a shared checkout's dirty state only for the run that owns it", async () => {
    // Without path ownership this one dirty tree reads as work to lose on BOTH
    // runs and neither ever leaves the board — the defect this exists for.
    // Task runs rather than notepad ones: an in-place run ignores the checkout's
    // dirty state outright (the test below), so ownership only decides this for a
    // run that owns its branch — which is what `agentFlow.worktree: "never"` makes.
    h.runs = [dirtyShare("PROJ-old", NOW - 90 * MIN), dirtyShare("PROJ-new", NOW - 10 * MIN)];
    h.openSessions = [];
    h.buildRunStatus.mockReset().mockImplementation((i: { run: Run; ticket: { category: string | null } | null }) => ({
      ...statusFor(i.run, i.ticket?.category ?? null),
      repos: [{ name: "svc", path: "/r/svc", branch: "main", dirty: true, ahead: 0, added: 1, removed: 0, files: 1 }],
    }));
    show();
    await settled();
    expect(shelfOf("PROJ-new")).toBe("board");   // newest holder owns the path
    expect(shelfOf("PROJ-old")).toBe("closed");
  });

  it("closes an in-place run whose only claim is the checkout's dirty state", async () => {
    // The other half of the same defect. This run OWNS /r/svc — it is the only
    // record holding it — so ownership scoping cannot help: counting the dirty tree
    // pinned the card for as long as the checkout stayed dirty, which for a repo
    // you work in is forever. An Explore session did not make that mess.
    setConfig({ retireInPlaceAfterHours: 24 }); // keeps the record observable; see above
    h.runs = [notepad("explore-a", NOW - 90 * MIN)];
    h.openSessions = [];
    h.buildRunStatus.mockReset().mockImplementation((i: { run: Run; ticket: { category: string | null } | null }) => ({
      ...statusFor(i.run, i.ticket?.category ?? null),
      repos: [{ name: "svc", path: "/r/svc", branch: "main", dirty: true, ahead: 4, added: 9, removed: 1, files: 3 }],
    }));
    show();
    await settled();
    expect(shelfOf("explore-a")).toBe("closed");
  });

  it("closes every in-place run sharing one dirty checkout, not just the losers", async () => {
    // The reported symptom, and the coverage the ownership test above gave up when it
    // moved to task runs: a repo you work in every day collects one record per Explore
    // and per note. Ownership hands the dirty path to exactly one of them — the newest —
    // so scoping alone still left that one pinned, and the pile shrank by all-but-one
    // rather than emptying. None of these sessions made that mess; all of them go.
    setConfig({ retireInPlaceAfterHours: 24 }); // keeps the records observable; see above
    h.runs = [
      notepad("notepad-old", NOW - 90 * MIN),
      notepad("notepad-mid", NOW - 40 * MIN),
      mkRun({
        key: "explore-new", kind: "explore", url: "", createdAt: NOW - 20 * MIN,
        summary: "explore-new",
        repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "main" }],
      }),
    ];
    h.openSessions = [];
    h.buildRunStatus.mockReset().mockImplementation((i: { run: Run; ticket: { category: string | null } | null }) => ({
      ...statusFor(i.run, i.ticket?.category ?? null),
      repos: [{ name: "svc", path: "/r/svc", branch: "main", dirty: true, ahead: 2, added: 5, removed: 0, files: 2 }],
    }));
    show();
    await settled();
    expect(shelfOf("notepad-old")).toBe("closed");
    expect(shelfOf("notepad-mid")).toBe("closed");
    // The path's owner, and closed all the same — the assertion that fails if the
    // in-place guard on `hasWorkToLose` is reverted.
    expect(shelfOf("explore-new")).toBe("closed");
  });

  it("keeps a ticket-bearing run in place, whose dirty tree is its own", async () => {
    // The guard on the rule above. A record claiming kind "explore" but carrying a
    // ticket is not something Explore can produce — it is hand-edited or from a
    // source we do not know — so it keeps the ordinary veto and holds the board.
    h.runs = [mkRun({
      key: "explore-ticketed", kind: "explore", createdAt: NOW - 90 * MIN, summary: "s",
      repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "main" }],
    })];
    h.openSessions = [];
    h.buildRunStatus.mockReset().mockImplementation((i: { run: Run; ticket: { category: string | null } | null }) => ({
      ...statusFor(i.run, i.ticket?.category ?? null),
      repos: [{ name: "svc", path: "/r/svc", branch: "main", dirty: true, ahead: 0, added: 1, removed: 0, files: 1 }],
    }));
    show();
    await settled();
    expect(shelfOf("explore-ticketed")).toBe("board");
  });

  it("keeps a ticketless task run in place — the kind test is the discriminator", async () => {
    // The other guard. A legacy record with no url reads as ticketless, but a task
    // run owns its branch whether or not a url survived, so its dirty tree still
    // counts. Only the kind test separates this from an Explore session.
    h.runs = [mkRun({
      key: "PROJ-nourl", url: "", createdAt: NOW - 90 * MIN, summary: "s",
      repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "main" }],
    })];
    h.openSessions = [];
    h.buildRunStatus.mockReset().mockImplementation((i: { run: Run; ticket: { category: string | null } | null }) => ({
      ...statusFor(i.run, i.ticket?.category ?? null),
      repos: [{ name: "svc", path: "/r/svc", branch: "main", dirty: true, ahead: 0, added: 1, removed: 0, files: 1 }],
    }));
    show();
    await settled();
    expect(shelfOf("PROJ-nourl")).toBe("board");
  });

  it("does not close a run merely because openAgents hides its agents", async () => {
    // openAgents is a DISPLAY toggle. Ownership reads allPlaces regardless, so a
    // run with somebody working in it must not shelve as closed.
    h.openAgents = false;
    h.runs = [notepad("notepad-a", NOW - 90 * MIN)];
    h.openSessions = [sess({ sessionId: "s1", cwd: "/r/svc", startedAt: NOW - 10 * MIN })];
    show();
    await settled();
    expect(shelfOf("notepad-a")).toBe("board");
  });

  it("keeps every run on the board when inflightShowAll is on", async () => {
    h.inflightShowAll = true;
    h.runs = [notepad("notepad-a", NOW - 90 * MIN)];
    h.openSessions = [];
    show();
    await settled();
    expect(shelfOf("notepad-a")).toBe("board");
  });

  it("puts a local card on the board — it exists only because a session is open", async () => {
    h.runs = [];
    h.openSessions = [sess({ cwd: "/r/webapp", name: "webapp-7e" })];
    show();
    await settled();
    expect(lastRunsPost().runs.map((r: RunStatus) => r.shelf)).toEqual(["board"]);
  });
});

describe("DeckPanel settings without a reload", () => {
  it("re-seeds prFacts from the setting and re-probes gh when it turns on", async () => {
    h.prFacts = false;
    show();
    await settled();
    h.probeGh.mockClear();

    h.prFacts = true;
    setConfig({ prFacts: true });
    fireConfigurationChanged("agentFlow.prFacts");
    await settled();

    // The re-probe is the point: the user may have run `gh auth login` since the
    // last check, which is exactly why the removed deck:setPrFacts handler reset
    // ghGap/ghProbe on the way on.
    expect(h.probeGh).toHaveBeenCalled();
  });

  it("re-seeds openAgents from the setting", async () => {
    h.openAgents = false;
    h.runs = [mkRun({ key: "PROJ-1", repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "b" }] })];
    h.openSessions = [sess()];
    show();
    await settled();
    expect(builtFor("PROJ-1").agents).toEqual([]);

    h.openAgents = true;
    setConfig({ openAgents: true });
    fireConfigurationChanged("agentFlow.openAgents");
    await settled();

    expect(builtFor("PROJ-1").agents).toHaveLength(1);
  });

  it("clears the review strip immediately when reviewRequests goes off", async () => {
    show();
    await settled();
    const p = lastPanel();
    h.reviewSearch.mockClear();

    h.reviewRequests = false;
    setConfig({ reviewRequests: false });
    fireConfigurationChanged("agentFlow.reviewRequests");
    await settled();

    // Posted before the rebuild, not through it: switching off must empty the
    // strip now rather than seconds later, which is why the removed
    // deck:setReviewQueue handler called postCachedReviews() ahead of the refresh.
    expect(posts(p).filter((m) => m.type === "deck:reviews").at(-1)).toMatchObject({ enabled: false });
    expect(h.reviewSearch).not.toHaveBeenCalled();
  });

  it("ignores a configuration change that touches none of its keys", async () => {
    show();
    await settled();
    const p = lastPanel();
    const before = posts(p).length;

    fireConfigurationChanged("agentFlow.somethingElse");
    await settled();

    expect(posts(p)).toHaveLength(before);
  });
});

describe("retire sweep", () => {
  /** The cards on the last board the panel posted. */
  const lastRuns = (): { run: Run }[] =>
    posts(lastPanel()).filter((m) => m.type === "deck:runs").at(-1)!.runs;
  /** Authed, so a ticket's Jira category actually reaches the sweep. */
  const sweep = async () => {
    show(true);
    await settled();
  };

  it("drops an unreachable run from the board and deletes its record and PR cache", async () => {
    h.runs = [mkRun({ key: "PROJ-GONE", repos: [{ name: "api", path: "/gone/api", isGit: true, branch: "b" }] })];
    h.existsSync.mockImplementation((p: string) => !p.startsWith("/gone"));
    await sweep();
    expect(lastRuns().map((r) => r.run.key)).not.toContain("PROJ-GONE");
    expect(h.removeRun).toHaveBeenCalledWith(expect.any(String), "PROJ-GONE");
    expect(h.removePrEntries).toHaveBeenCalledWith(expect.any(String), "PROJ-GONE");
  });

  it("stamps a landed run, keeps rendering it, and does not delete it", async () => {
    h.runs = [mkRun({ key: "PROJ-DONE" })];
    h.getStatus.mockResolvedValue({ status: "Done", category: "done" });
    await sweep();
    expect(h.writeRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ key: "PROJ-DONE", finishedAt: expect.any(Number) }),
    );
    expect(h.removeRun).not.toHaveBeenCalled();
    expect(lastRuns().map((r) => r.run.key)).toContain("PROJ-DONE");
  });

  it("retires a landed run once its stamp is older than the window", async () => {
    setConfig({ retireFinishedAfterHours: 1 });
    h.runs = [mkRun({ key: "PROJ-OLD", finishedAt: Date.now() - 2 * 3_600_000 })];
    h.getStatus.mockResolvedValue({ status: "Done", category: "done" });
    await sweep();
    expect(h.removeRun).toHaveBeenCalledWith(expect.any(String), "PROJ-OLD");
    expect(lastRuns().map((r) => r.run.key)).not.toContain("PROJ-OLD");
  });

  it("stamps closedAt on a run the board shelved as closed, and keeps rendering it", async () => {
    // An aged TASK run, not a notepad one: rule 0 now retires an in-place run on
    // sight, so rule 2b — the rule under test — is only reachable for a run that
    // owns a worktree. The neighbouring shelf test proves an aged task run with no
    // agent and no PR shelves as closed, which is the state this needs.
    h.runs = [mkRun({ key: "PROJ-CLOSED", createdAt: Date.now() - 3_600_000 })];
    await sweep();
    expect(h.writeRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ key: "PROJ-CLOSED", closedAt: expect.any(Number) }),
    );
    expect(h.removeRun).not.toHaveBeenCalled();
    expect(lastRuns().map((r) => r.run.key)).toContain("PROJ-CLOSED");
  });

  it("retires a finished Explore session on sight, the shipped default", async () => {
    // The defect this exists for: an Explore run launches in the checkout, so the
    // sweep's `hasLiveSession` was any agent anywhere in that repo and its `repos`
    // carried the checkout's permanent dirty state. Either one pinned the record
    // forever. Both are supplied here, and the run must still go.
    h.runs = [mkRun({
      key: "explore-retries", kind: "explore", url: "", createdAt: Date.now() - 90 * 60_000,
      repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "main" }],
    })];
    h.openSessions = [sess({ sessionId: "s1", cwd: "/r/other", startedAt: Date.now() - 60_000 })];
    h.buildRunStatus.mockReset().mockImplementation((i: { run: Run; ticket: { category: string | null } | null }) => ({
      ...statusFor(i.run, i.ticket?.category ?? null),
      repos: [{ name: "svc", path: "/r/svc", branch: "main", dirty: true, ahead: 2, added: 1, removed: 0, files: 1 }],
    }));
    await sweep();
    expect(h.removeRun).toHaveBeenCalledWith(expect.any(String), "explore-retries");
    expect(lastRuns().map((r) => r.run.key)).not.toContain("explore-retries");
  });

  it("retires a closed run once its stamp is older than the window", async () => {
    setConfig({ retireClosedAfterHours: 1 });
    h.runs = [mkRun({
      key: "notepad-old", kind: "notepad", url: "",
      createdAt: Date.now() - 3_600_000, closedAt: Date.now() - 2 * 3_600_000,
    })];
    await sweep();
    expect(h.removeRun).toHaveBeenCalledWith(expect.any(String), "notepad-old");
    expect(lastRuns().map((r) => r.run.key)).not.toContain("notepad-old");
  });

  it("clears closedAt when a run comes back to the board", async () => {
    // An agent reopened in its checkout: the window must restart from scratch
    // rather than resume mid-count.
    h.runs = [mkRun({
      key: "notepad-live", kind: "notepad", url: "", createdAt: Date.now() - 3_600_000,
      closedAt: Date.now() - 3_600_000, repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "main" }],
    })];
    h.openSessions = [sess({ sessionId: "s1", cwd: "/r/svc", startedAt: Date.now() })];
    await sweep();
    const written = h.writeRun.mock.calls.at(-1)![1] as Run;
    expect(written.key).toBe("notepad-live");
    expect("closedAt" in written).toBe(false);
    expect(h.removeRun).not.toHaveBeenCalled();
  });

  it("clears the stamp when a run stops being finished", async () => {
    h.runs = [mkRun({ key: "PROJ-BACK", finishedAt: Date.now() - 3_600_000 })];
    await sweep();
    const written = h.writeRun.mock.calls.at(-1)![1] as Run;
    expect(written.key).toBe("PROJ-BACK");
    expect("finishedAt" in written).toBe(false);
    expect(h.removeRun).not.toHaveBeenCalled();
  });

  it("still sees open sessions with the Open agents toggle off, so it cannot retire live work", async () => {
    h.openAgents = false;
    h.runs = [mkRun({ key: "PROJ-LIVE", repos: [{ name: "api", path: "/repos/api", isGit: true, branch: "b" }] })];
    h.openSessions = [sess({ pid: 3, sessionId: "s1", cwd: "/repos/api", startedAt: 1, name: "api-1a" })];
    h.existsSync.mockReturnValue(false); // rule 1 would fire but for the live session
    await sweep();
    expect(h.removeRun).not.toHaveBeenCalled();
    // The toggle still does its own job: no agents are attached to the card.
    expect(builtFor("PROJ-LIVE").agents).toEqual([]);
  });

  it("never writes a record for a local card, which has none on disk", async () => {
    h.runs = [];
    h.openSessions = [sess({ pid: 4, sessionId: "s2", cwd: "/r/loose", startedAt: 1, name: "loose-1a" })];
    await sweep();
    expect(h.writeRun).not.toHaveBeenCalled();
    expect(h.removeRun).not.toHaveBeenCalled();
  });

  it("sweeps review runs, which never render as cards", async () => {
    h.runs = [mkRun({ key: "review-svc-1", kind: "review", url: "https://github.com/o/r/pull/1",
      repos: [{ name: "svc", path: "/gone/svc", isGit: true, branch: "b" }] })];
    h.existsSync.mockReturnValue(false);
    await sweep();
    expect(h.removeRun).toHaveBeenCalledWith(expect.any(String), "review-svc-1");
  });

  it("spares a review run whose worktree still holds unpushed commits", async () => {
    h.runs = [mkRun({ key: "review-svc-2", kind: "review", url: "https://github.com/o/r/pull/2",
      createdAt: 1, repos: [{ name: "svc", path: "/r/review-svc-2", isGit: true, branch: "b" }] })];
    h.gitState.mockImplementation((name: string, path: string) => ({
      name, path, branch: "b", dirty: false, ahead: 2, added: 0, removed: 0, files: 0,
    }));
    await sweep();
    expect(h.removeRun).not.toHaveBeenCalled();
  });
});

describe("board grouping", () => {
  it("seeds the lens on ready, ahead of the board build", async () => {
    // Asserted without settling, same idiom as the cached-reviews test above:
    // the seed post happens synchronously inside onMessage, before its first
    // await, so at this instant a board post cannot have happened yet.
    setConfig({ deckGrouping: "workspaces" });
    show();
    await settled();
    const p = lastPanel();
    p.webview.postMessage.mockClear();
    const ready = p._fire({ type: "deck:ready" });

    const early = posts(p);
    expect(early.find((m) => m.type === "deck:grouping")).toEqual({ type: "deck:grouping", grouping: "workspaces" });
    expect(early.find((m) => m.type === "deck:runs")).toBeUndefined();

    await ready;
    await settled();
  });

  it("persists a lens change without rebuilding the board", async () => {
    show();
    await settled();
    const p = lastPanel();
    const boardsBefore = posts(p).filter((m) => m.type === "deck:runs").length;

    await p._fire({ type: "deck:setGrouping", grouping: "workspaces" });
    await settled();

    // getConfiguration hands out a fresh stub per call, so the write is asserted
    // across every stub this pass produced rather than against one of them.
    const updates = workspace.getConfiguration.mock.results
      .flatMap((r) => (r.value as { update: { mock: { calls: unknown[][] } } }).update.mock.calls);
    expect(updates).toContainEqual(["deckGrouping", "workspaces", ConfigurationTarget.Global]);
    // deckGrouping is display-only — the webview draws both lenses from the run
    // list it already holds, so a rebuild here spends git per repo and a connector
    // round trip per run to produce the identical board.
    expect(posts(p).filter((m) => m.type === "deck:runs")).toHaveLength(boardsBefore);
  });

  it("re-posts the lens when the setting changes under the panel", async () => {
    show();
    await settled();
    const p = lastPanel();

    setConfig({ deckGrouping: "workspaces" });
    fireConfigurationChanged("agentFlow.deckGrouping");
    await settled();

    expect(posts(p).at(-1)).toEqual({ type: "deck:grouping", grouping: "workspaces" });
  });

  it("no longer carries the lens on the board post", async () => {
    // Control state on deck:runs is what made every toggle flip back before it
    // settled: that message costs a full rebuild, so one already in flight when
    // the user clicks lands carrying a pre-click snapshot.
    show();
    await settled();
    expect(posts(lastPanel()).find((m) => m.type === "deck:runs")).not.toHaveProperty("grouping");
  });
});

describe("Clear stale", () => {
  /** A landed run the automatic sweep will only stamp: its window is far off. */
  const landedRun = (key: string) => {
    setConfig({ retireFinishedAfterHours: 999 });
    h.runs = [mkRun({ key })];
    h.getStatus.mockResolvedValue({ status: "Done", category: "done" });
  };

  it("counts runs that would retire if both windows were ignored", async () => {
    landedRun("PROJ-DONE");
    show(true);
    await settled();
    expect(lastRunsPost().staleCount).toBe(1);
    expect(h.removeRun).not.toHaveBeenCalled(); // counted, not cleared
  });

  it("clears them on request, after the user confirms", async () => {
    landedRun("PROJ-DONE");
    show(true);
    await settled();
    const p = lastPanel();
    (window.showWarningMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Clear 1");
    await p._fire({ type: "deck:clearStale" });
    await settled();
    expect(h.removeRun).toHaveBeenCalledWith(expect.any(String), "PROJ-DONE");
  });

  it("clears nothing when the user declines", async () => {
    landedRun("PROJ-DONE");
    show(true);
    await settled();
    const p = lastPanel();
    (window.showWarningMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    await p._fire({ type: "deck:clearStale" });
    await settled();
    expect(h.removeRun).not.toHaveBeenCalled();
  });

  it("still respects the veto — dirty work is never cleared in bulk", async () => {
    landedRun("PROJ-DIRTY");
    h.buildRunStatus.mockImplementation((i: { run: Run; ticket: { category: string | null } | null }) => ({
      ...statusFor(i.run, i.ticket?.category ?? null),
      repos: [{ name: "svc", path: "/r/svc", branch: "b", dirty: true, ahead: 0, added: 1, removed: 0, files: 1 }],
    }));
    show(true);
    await settled();
    expect(lastRunsPost().staleCount).toBe(0);
    const p = lastPanel();
    await p._fire({ type: "deck:clearStale" });
    await settled();
    expect(h.removeRun).not.toHaveBeenCalled();
  });

  it("counts a review run nobody is in, which has no card to clear it from", async () => {
    // Young enough that the automatic sweep leaves it alone — only the
    // gate-ignoring pass reaches it, which is the whole point of the count.
    // Give it a createdAt slightly in the past to avoid timing-dependent test flake
    // when the verdict is computed within 1ms of run creation.
    const reviewRunCreatedAt = Date.now() - 10;
    h.runs = [mkRun({ key: "review-svc-9", kind: "review", url: "https://github.com/o/r/pull/9", createdAt: reviewRunCreatedAt })];
    show(true);
    await settled();
    expect(lastRunsPost().staleCount).toBe(1);
    expect(h.removeRun).not.toHaveBeenCalled();
  });
});

describe("DeckPanel local cards", () => {
  it("makes a card for a place no tracked run owns", async () => {
    h.runs = [];
    h.openSessions = [sess({ cwd: "/r/webapp", name: "webapp-7e" })];
    show();
    await settled();
    expect(h.buildRunStatus).toHaveBeenCalledTimes(1);
    expect(builtLocal().agents.map((a) => a.session.name)).toEqual(["webapp-7e"]);
  });

  it("infers the ticket a branch names, and polls Jira for it", async () => {
    h.runs = [];
    h.openSessions = [sess({ cwd: "/r/webapp", name: "webapp-7e" })];
    show(true);
    await settled();
    expect(builtLocal().run.url).toContain("/browse/PROJ-5641");
    expect(h.getStatus).toHaveBeenCalledWith("PROJ-5641");
  });

  it("infers nothing from a default branch, and polls no Jira", async () => {
    h.runs = [];
    h.branch = "main";
    h.openSessions = [sess({ cwd: "/r/webapp", name: "webapp-7e" })];
    show(true);
    await settled();
    expect(builtLocal().run.url).toBe("");
    expect(h.getStatus).not.toHaveBeenCalled();
  });

  it("sends the inferred ticket key on the wire, so the webview never has to parse a url itself", async () => {
    h.runs = [];
    h.openSessions = [sess({ cwd: "/r/webapp", name: "webapp-7e" })];
    show(true);
    await settled();
    const local = lastRunsPost().runs.find((r: RunStatus) => r.run.kind === "local")!;
    expect(local.inferredTicketKey).toBe("PROJ-5641");
  });

  it("omits the inferred ticket key when the branch names no ticket", async () => {
    h.runs = [];
    h.branch = "main";
    h.openSessions = [sess({ cwd: "/r/webapp", name: "webapp-7e" })];
    show(true);
    await settled();
    const local = lastRunsPost().runs.find((r: RunStatus) => r.run.kind === "local")!;
    expect(local.inferredTicketKey).toBeUndefined();
  });

  // A TRACKED run, not a local one, but the same field and the same reason: the
  // wire has to carry the ticket key wherever the record's own key is not it, or
  // the webview — which has no connector to parse a url with — binds a workflow
  // by a hash while `flow:attach` binds it by the ticket. `track()` produces
  // exactly this record: a promoted local card keeps its place-hash key when a
  // real run already owned the inferred key, and its ticket then lives only in
  // the url. See attach.ts's `boundTicketKeyOf`, which is `inferredTicketKey ??
  // run.key`, and is only equal to `ticketKeyFor` because of this.
  it("sends the ticket key for a Track-it run still keyed by its place hash", async () => {
    h.runs = [mkRun({ key: "local-webapp-9f2c1a4", url: "https://jira/browse/PROJ-5641" })];
    h.openSessions = [];
    show(true);
    await settled();
    const tracked = lastRunsPost().runs.find((r: RunStatus) => r.run.key === "local-webapp-9f2c1a4")!;
    expect(tracked.inferredTicketKey).toBe("PROJ-5641");
  });

  it("omits it on a launched run, whose own key already IS its ticket", async () => {
    h.runs = [mkRun({ key: "PROJ-1", url: "https://jira/browse/PROJ-1" })];
    h.openSessions = [];
    show(true);
    await settled();
    const tracked = lastRunsPost().runs.find((r: RunStatus) => r.run.key === "PROJ-1")!;
    expect(tracked.inferredTicketKey).toBeUndefined();
  });

  it("does not make a second card for a place a tracked run already owns", async () => {
    h.runs = [mkRun({ key: "PROJ-1", repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "PROJ-1-x" }] })];
    h.openSessions = [sess()];
    show();
    await settled();
    expect(h.buildRunStatus).toHaveBeenCalledTimes(1);
  });

  it("makes no local cards with the toggle off", async () => {
    h.openAgents = false;
    h.runs = [];
    h.openSessions = [sess({ cwd: "/r/webapp" })];
    show();
    await settled();
    expect(h.buildRunStatus).not.toHaveBeenCalled();
  });

  it("still makes local cards when a transcript is unreadable", async () => {
    // The registry knows a session is open without its transcript being read, so
    // the card appears — its agent just reports unknown.
    h.runs = [];
    h.openSessions = [sess({ cwd: "/r/webapp", name: "webapp-7e" })];
    h.sessionActivity.mockReturnValue({ state: "unknown", lastActivityMs: null, slug: null });
    show();
    await settled();
    const built = builtLocal();
    expect(built.agents).toHaveLength(1);
    expect(built.agents[0].activity.state).toBe("unknown");
  });

  it("opens a local card's directory", async () => {
    h.runs = [];
    h.openSessions = [sess({ cwd: "/r/webapp" })];
    show();
    await settled();
    const p = lastPanel();
    await p._fire({ type: "deck:inspect", key: builtLocal().run.key, action: "open" });
    expect(h.openInEditor).toHaveBeenCalledWith("/r/webapp");
  });

  const WS = { identity: "/ws/webapp+e2e.code-workspace", kind: "workspace" as const,
    roots: ["/r/webapp", "/r/e2e_suite"] };

  it("makes one card for two sessions in the same workspace", async () => {
    h.runs = [];
    h.liveWindows = [WS];
    h.openSessions = [sess({ cwd: "/r/webapp", name: "webapp-7e" }),
      sess({ sessionId: "s2", cwd: "/r/e2e_suite", name: "e2e-3a" })];
    show();
    await settled();
    expect(h.buildRunStatus).toHaveBeenCalledTimes(1);
    expect(builtLocal().agents.map((a) => a.session.name).sort()).toEqual(["e2e-3a", "webapp-7e"]);
  });

  it("carries every workspace root, including one with no session in it", async () => {
    h.runs = [];
    h.liveWindows = [WS];
    h.openSessions = [sess({ cwd: "/r/e2e_suite", name: "e2e-3a" })];
    show();
    await settled();
    expect(builtLocal().run.repos.map((r) => r.name)).toEqual(["webapp", "e2e_suite"]);
    expect(builtLocal().run.workspaceFile).toBe("/ws/webapp+e2e.code-workspace");
  });

  it("tags each agent with the root it runs in, not the run's first repo", async () => {
    h.runs = [];
    h.liveWindows = [WS];
    h.openSessions = [sess({ cwd: "/r/e2e_suite", name: "e2e-3a" })];
    show();
    await settled();
    expect(builtLocal().agents.map((a) => a.repo)).toEqual(["e2e_suite"]);
  });

  it("falls through to a sibling root when the session's own root names no ticket", async () => {
    // The session sits in /r/e2e_suite ("main" — no ticket); /r/webapp
    // names one. The session's own root gets first say (F1, human ruling), but
    // when it has nothing to say the remaining roots are still checked.
    h.runs = [];
    h.liveWindows = [WS];
    h.openSessions = [sess({ cwd: "/r/e2e_suite", name: "e2e-3a" })];
    show(true);
    await settled();
    expect(builtLocal().run.url).toContain("/browse/PROJ-5641");
  });

  it("prefers the session's own root's ticket over a sibling's, even one earlier in window order (F1, test 6)", async () => {
    // /r/webapp is FIRST in WS.roots and names a ticket of its own — the old,
    // window-order rule would pick it. The session sits in /r/e2e_suite,
    // which also names a ticket: the human ruling says the session's own root
    // wins regardless of where it falls in the workspace's folder list.
    h.runs = [];
    h.branch = "PROJ-9999-sibling"; // /r/webapp — earlier in window order, but not the session's root
    h.branch2 = "PROJ-5641-team-table"; // /r/e2e_suite — the session's own root
    h.liveWindows = [WS];
    h.openSessions = [sess({ cwd: "/r/e2e_suite", name: "e2e-3a" })];
    show(true);
    await settled();
    expect(builtLocal().run.url).toContain("/browse/PROJ-5641");
    expect(builtLocal().run.url).not.toContain("/browse/PROJ-9999");
  });

  it("prefers an earlier sibling root's ticket over a later one, when the session's own root names nothing", async () => {
    // Three roots: the session's own (/r/third, "main" — no ticket) gets first
    // say and has none, so the remaining two are checked in their OWN window
    // order. Both name a ticket — the point that actually distinguishes "first
    // hit wins" from "last hit wins": with only one of them able to carry a
    // ticket, .find and a `.filter(Boolean).at(-1)` mutation would agree.
    const WS3 = { identity: "/ws/three.code-workspace", kind: "workspace" as const,
      roots: ["/r/webapp", "/r/e2e_suite", "/r/third"] };
    h.runs = [];
    h.branch = "PROJ-1111-first"; // /r/webapp
    h.branch2 = "PROJ-2222-second"; // /r/e2e_suite
    h.liveWindows = [WS3];
    h.openSessions = [sess({ cwd: "/r/third", name: "third-1a" })];
    show(true);
    await settled();
    expect(builtLocal().run.url).toContain("/browse/PROJ-1111");
  });

  it("still makes a per-place card when the window record has no roots", async () => {
    h.runs = [];
    h.liveWindows = [{ identity: "/ws/webapp+e2e.code-workspace", kind: "workspace" }];
    h.openSessions = [sess({ cwd: "/r/webapp", name: "webapp-7e" })];
    show();
    await settled();
    expect(builtLocal().run.repos.map((r) => r.name)).toEqual(["webapp"]);
    expect(builtLocal().run.workspaceFile).toBeUndefined();
  });

  it("does not fold a root a tracked run already owns into a local card", async () => {
    // /r/webapp has a session too, but PROJ-1 already tracks it — its diff and
    // dirty state belong on PROJ-1's own card. /r/e2e_suite's session is not
    // owned by anything: it still gets a local card, and that card must name
    // only the root nobody tracks, not the one PROJ-1 already owns.
    h.runs = [mkRun({ key: "PROJ-1", repos: [{ name: "webapp", path: "/r/webapp", isGit: true, branch: "PROJ-1-x" }] })];
    h.liveWindows = [WS];
    h.openSessions = [sess({ cwd: "/r/webapp", name: "webapp-7e" }),
      sess({ sessionId: "s2", cwd: "/r/e2e_suite", name: "e2e-3a" })];
    show();
    await settled();
    // Two cards on the board: the tracked run keeps its own, and a local card
    // for the leftover place — not one merged card carrying both roots.
    expect(h.buildRunStatus).toHaveBeenCalledTimes(2);
    expect(h.buildRunStatus.mock.calls[0][0].run.key).toBe("PROJ-1");
    expect(builtLocal().run.repos.map((r) => r.name)).toEqual(["e2e_suite"]);
  });

  it("makes no local card when a tracked run already owns every live root in the window", async () => {
    h.runs = [mkRun({ key: "PROJ-1", repos: [
      { name: "webapp", path: "/r/webapp", isGit: true, branch: "PROJ-1-x" },
      { name: "e2e_suite", path: "/r/e2e_suite", isGit: true, branch: "PROJ-1-x" },
    ] })];
    h.liveWindows = [WS];
    h.openSessions = [sess({ cwd: "/r/webapp", name: "webapp-7e" }),
      sess({ sessionId: "s2", cwd: "/r/e2e_suite", name: "e2e-3a" })];
    show();
    await settled();
    // Both roots are claimed by the one tracked run: nothing is left over for a
    // local card, not even an empty one. This does NOT exercise deckView.ts's
    // own "if (roots.length === 0) continue" guard — with both places claimed,
    // `unclaimed` is already empty and groupPlacesByWindow([], liveWindows)
    // returns [] before the loop body (and that guard) ever runs. It stands on
    // its own merits regardless: no card for a place nothing is left to render.
    expect(h.buildRunStatus).toHaveBeenCalledTimes(1);
    expect(h.buildRunStatus.mock.calls[0][0].run.key).toBe("PROJ-1");
  });

  it("drops a non-git workspace root that has no session in it (F5)", async () => {
    // /r/e2e_suite is a plain docs/ folder here (repoRoot answers ""), and
    // nobody is working in it — Spec §2 says `repos` is the roots that ARE git
    // repos, and a folder that is neither must not inflate the chip's "N repos"
    // count or spend four extra git calls on nothing. Steers the real repoRoot
    // seam (h.nonGitRoots), not localRunFor's injected `git` function.
    h.runs = [];
    h.nonGitRoots.add("/r/e2e_suite");
    h.liveWindows = [WS];
    h.openSessions = [sess({ cwd: "/r/webapp", name: "webapp-7e" })];
    show();
    await settled();
    expect(builtLocal().run.repos.map((r) => r.name)).toEqual(["webapp"]);
  });

  it("keeps a non-git workspace root that DOES have a live session in it (F5)", async () => {
    // Same non-git folder as above, but this time a session is open in it — a
    // session running in a plain directory is a legitimate card today, and F5
    // dropping every non-git folder unconditionally would delete it. That would
    // be a regression, not a cleanup.
    h.runs = [];
    h.nonGitRoots.add("/r/e2e_suite");
    h.liveWindows = [WS];
    h.openSessions = [sess({ cwd: "/r/webapp", name: "webapp-7e" }),
      sess({ sessionId: "s2", cwd: "/r/e2e_suite", name: "e2e-3a" })];
    show();
    await settled();
    const repos = builtLocal().run.repos;
    expect(repos.map((r) => r.name)).toEqual(["webapp", "e2e_suite"]);
    expect(repos.find((r) => r.name === "e2e_suite")?.isGit).toBe(false);
  });

  it("normalizes a workspace root nested inside a repo to that repo's root, so a tracked run claims it (F5)", async () => {
    // The exact double-count the human ruling was meant to prevent. PROJ-1 owns
    // /r/monorepo, with its own live session cd'd exactly into it (that live
    // session is what puts /r/monorepo in `claimed` at all). A SEPARATE window
    // declares monorepo/packages/api — a folder nested INSIDE that same repo —
    // as one of its own roots, alongside an unrelated /r/other where a second,
    // untracked session actually is. Comparing raw paths, PROJ-1's claim would
    // never match the nested path, and monorepo would render (and vote its
    // diff/dirty) a second time on the local card built for /r/other.
    // Normalizing first (repoRoot(nested) -> /r/monorepo) is what makes the
    // claimed-root filter actually catch it.
    const nested = "/r/monorepo/packages/api";
    h.repoRootRemap.set(nested, "/r/monorepo");
    h.runs = [mkRun({ key: "PROJ-1", repos: [{ name: "monorepo", path: "/r/monorepo", isGit: true, branch: "main" }] })];
    h.liveWindows = [{ identity: "/ws/mono+other.code-workspace", kind: "workspace", roots: [nested, "/r/other"] }];
    h.openSessions = [
      sess({ cwd: "/r/monorepo", name: "monorepo-7e" }),
      sess({ sessionId: "s2", cwd: "/r/other", name: "other-1a" }),
    ];
    show();
    await settled();
    expect(h.buildRunStatus).toHaveBeenCalledTimes(2); // PROJ-1's own card, and one local card
    expect(builtLocal().run.repos.map((r) => r.path)).toEqual(["/r/other"]);
  });
});

describe("DeckPanel PR facts for a local grouped run (F2)", () => {
  const WS = { identity: "/ws/webapp+e2e.code-workspace", kind: "workspace" as const,
    roots: ["/r/webapp", "/r/e2e_suite"] };

  it("does not enqueue a PR fetch for a sibling root with no live session", async () => {
    h.runs = [];
    h.liveWindows = [WS];
    // Session only in /r/webapp — /r/e2e_suite is a sibling nobody is
    // working in, carried on the card only because F5 keeps every git root.
    h.openSessions = [sess({ cwd: "/r/webapp", name: "webapp-7e" })];
    await showAndWarm();
    expect(h.prFetch).not.toHaveBeenCalledWith("/r/e2e_suite", expect.anything(), expect.anything());
  });

  it("does not read a sibling root's cached PR facts back onto the card, even a merged one", async () => {
    // The regression this pass reopens (commit 536b3bd, through a different
    // door): a merged PR cached for the idle sibling must not render as this
    // card's PrBlock or vote it into Done through prSignals. Excluding it from
    // the `prs` map handed to buildRunStatus is what keeps prSignals from ever
    // seeing it — status.test.ts already pins that a merged entry in that map
    // moves the column to Done, so together the two prove the sibling can't.
    const merged: PrFacts = {
      number: 42, url: "https://github.com/o/r/pull/42", title: "unrelated work", state: "MERGED",
      isDraft: false, ci: { passing: 1, pending: 0, failing: [] }, review: "approved", unresolved: 0,
      mergeable: "clean", ciAdvisory: false,
    };
    h.prEntries = { e2e_suite: { facts: merged, fetchedAt: Date.now() } };
    h.runs = [];
    h.liveWindows = [WS];
    h.openSessions = [sess({ cwd: "/r/webapp", name: "webapp-7e" })];
    await showAndWarm(true);
    expect(builtLocal().prs).toEqual({});
  });

  it("still reads and fetches PR facts for the session's own root", async () => {
    h.runs = [];
    h.liveWindows = [WS];
    h.openSessions = [sess({ cwd: "/r/webapp", name: "webapp-7e" })];
    await showAndWarm(true);
    expect(h.prFetch).toHaveBeenCalledWith("/r/webapp", "PROJ-5641-team-table", "PROJ-5641");
  });
});

describe("DeckPanel track it", () => {
  /** Build one local card, track it, and hand back the record that was written. */
  const trackLocal = async (): Promise<Run> => {
    h.openSessions = [sess({ cwd: "/r/webapp", name: "webapp-7e" })];
    show();
    await settled();
    const p = lastPanel();
    await p._fire({ type: "deck:track", key: builtLocal().run.key });
    await settled();
    return h.writeRun.mock.calls.at(-1)![1] as Run;
  };

  it("writes an inferred ticket's key as a task run", async () => {
    h.runs = [];
    const written = await trackLocal();
    expect(written).toMatchObject({ key: "PROJ-5641", kind: "task" });
    expect(written.url).toContain("/browse/PROJ-5641");
  });

  it("keeps the local key when a tracked run already owns the inferred one", async () => {
    // Writing PROJ-5641.json here would silently replace a real launch record.
    h.runs = [mkRun({ key: "PROJ-5641" })];
    const written = await trackLocal();
    expect(written.key).toMatch(/^local-/);
    expect(written.kind).toBe("task");
    expect(written.url).toContain("/browse/PROJ-5641");
  });

  it("polls the real ticket, not the place-hash, for a record Track it saved under its local key", async () => {
    // Exactly what the previous test just wrote to disk: on the *next* refresh
    // this is a tracked run (`readRuns` would return it), so it is no longer
    // synthesized as a local card and `localTickets`-style bookkeeping never
    // sees it. The ticket must still come from its own url, not its key —
    // otherwise every tick polls Jira for "local-webapp-1a2b3c4d", which 404s
    // forever.
    h.runs = [mkRun({
      key: "local-webapp-1a2b3c4d", url: "https://jira/browse/PROJ-5641", kind: "task",
      repos: [{ name: "webapp", path: "/r/webapp", isGit: true, branch: "PROJ-5641-team-table" }],
    })];
    show(true);
    const p = lastPanel();
    await p._fire({ type: "deck:refresh" });
    expect(h.getStatus).toHaveBeenCalledWith("PROJ-5641");
    expect(h.getStatus).not.toHaveBeenCalledWith("local-webapp-1a2b3c4d");
  });

  it("writes a place with no ticket as an explore run", async () => {
    h.runs = [];
    h.branch = "main";
    const written = await trackLocal();
    expect(written).toMatchObject({ kind: "explore", url: "" });
    expect(written.key).toMatch(/^local-/);
  });

  it("drops the local key's cached PR facts, which the new key refetches", async () => {
    h.runs = [];
    const written = await trackLocal();
    expect(h.removePrEntries).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/^local-/));
    expect(written.key).not.toMatch(/^local-/);
  });

  it("ignores a track for a key that is not a local card", async () => {
    h.runs = [mkRun({ key: "PROJ-1" })];
    h.openSessions = [];
    show();
    await settled();
    await lastPanel()._fire({ type: "deck:track", key: "PROJ-1" });
    await settled();
    expect(h.writeRun).not.toHaveBeenCalled();
  });
});

describe("DeckPanel PR facts", () => {
  it("does not read stored PR facts for a repo sitting on its default branch", async () => {
    // The Explore defect: prfacts/explore-*.json was left on disk as inert, and a
    // looser gate brings a stranger's closed PR straight back onto the card.
    h.runs = [mkRun({ key: "explore-x", url: "", repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "master" }] })];
    h.prEntries = { svc: { fetchedAt: Date.now(), facts: null } };
    await showAndWarm(true);
    expect(builtFor("explore-x").prs).toEqual({});
  });

  it("fetches a PR for an Explore run whose agent made a branch", async () => {
    h.runs = [mkRun({ key: "explore-x", url: "", repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "explore-x-fix" }] })];
    h.prEntries = {};
    await showAndWarm(true);
    expect(h.prFetch).toHaveBeenCalled();
  });

  it("still fetches a PR for a tracked run on its task branch", async () => {
    h.runs = [mkRun({ key: "PROJ-1", repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "PROJ-1-x" }] })];
    h.prEntries = {};
    await showAndWarm(true);
    expect(h.prFetch).toHaveBeenCalled();
  });

  it("passes cached PR entries to the status builder", async () => {
    h.prEntries = { svc: { facts: null, fetchedAt: Date.now() } };
    show();
    await settled();
    expect(h.buildRunStatus).toHaveBeenCalledWith(
      // `show()` defaults to unauthenticated, so ticket is null here — `objectContaining`
      // still requires this key to match the literal value.
      expect.objectContaining({
        ticket: null, projectsRoot: expect.any(String), nowMs: expect.any(Number),
        openIdentities: expect.any(Set), prs: h.prEntries,
      }),
    );
  });

  it("does not await the fetch — a tick posts runs before gh returns", async () => {
    let release!: () => void;
    h.prFetch.mockImplementation(() => new Promise((res) => { release = () => res({ ok: true, facts: null }); }));
    show();
    await settled(); // first tick: only warms the gh probe, no fetch yet
    const p = lastPanel();
    await p._fire({ type: "deck:refresh" }); // second tick: the fetch is now in flight, unresolved
    expect(posts(p).some((m) => m.type === "deck:runs")).toBe(true);
    release();
    // Let the now-resolved fetch's write settle here, inside this test, rather
    // than leaking a pending `writePrEntry` call into whichever test runs next.
    await settled();
  });

  it("fetches a repo with no cached entry", async () => {
    await showAndWarm();
    expect(h.prFetch).toHaveBeenCalledWith("/r/svc", "b", "PROJ-1");
    expect(h.writePrEntry).toHaveBeenCalledWith("/prfacts", "PROJ-1", "svc", expect.objectContaining({ facts: null, fetchedAt: expect.any(Number) }));
  });

  it("searches by the inferred ticket key, not the local place-hash, for an untracked place", async () => {
    // The provider's `--head` search already covers the common case; this is
    // the fallback `--search "<key> in:title"` term specifically. A local
    // card's own key (a place-hash) could never match a PR title — the ticket
    // a branch names is the one string that stands a chance.
    h.runs = [];
    h.openSessions = [sess({ cwd: "/r/webapp", name: "webapp-7e" })];
    await showAndWarm(true);
    expect(h.prFetch).toHaveBeenCalledWith("/r/webapp", "PROJ-5641-team-table", "PROJ-5641");
  });

  it("does not refetch an entry inside its TTL", async () => {
    h.prEntries = { svc: { facts: null, fetchedAt: Date.now() } };
    await showAndWarm();
    expect(h.prFetch).not.toHaveBeenCalled();
  });

  it("refetches an entry past its TTL", async () => {
    h.prEntries = { svc: { facts: null, fetchedAt: Date.now() - 200_000 } };
    await showAndWarm();
    expect(h.prFetch).toHaveBeenCalledTimes(1);
  });

  it("does not refetch when the entry is fresh relative to a shorter configured TTL", async () => {
    // Discriminates a dropped seconds→ms conversion: with the correct `* 1000`,
    // ttlMs = 60_000 and this 1s-old entry is fresh. Without it, ttlMs = 60 and
    // the same entry reads as stale (1000 >= 60), so this would wrongly fetch.
    h.ttlSeconds = 60;
    h.prEntries = { svc: { facts: null, fetchedAt: Date.now() - 1_000 } };
    await showAndWarm();
    expect(h.prFetch).not.toHaveBeenCalled();
  });

  it("treats an entry exactly at a configured TTL as stale", async () => {
    // Pins isStale's `>=`: an entry aged exactly the TTL must still be refetched.
    h.ttlSeconds = 60;
    h.prEntries = { svc: { facts: null, fetchedAt: Date.now() - 60_000 } };
    await showAndWarm();
    expect(h.prFetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the previous facts and flags an error when a fetch fails", async () => {
    const stale = { number: 5, url: "u", title: "t", state: "OPEN", isDraft: false, ci: { passing: 0, pending: 0, failing: [] }, review: "none", unresolved: null, mergeable: "clean", ciAdvisory: false };
    h.prEntries = { svc: { facts: stale, fetchedAt: Date.now() - 200_000 } };
    h.prFetch.mockResolvedValue({ ok: false });
    await showAndWarm();
    expect(h.writePrEntry).toHaveBeenCalledWith("/prfacts", "PROJ-1", "svc", expect.objectContaining({ facts: stale, error: true }));
  });

  it("writes exactly what the provider returned on success, with no error flag", async () => {
    // An implementation that always writes `{ facts: previous?.facts ?? null,
    // fetchedAt, error: true }` regardless of `res` would pass every other test
    // in this file — the mock's old type narrowed `facts` to `null`, so "facts
    // written through" and "facts hardcoded null" were indistinguishable, and
    // the success case never pinned `error`'s absence. An exact match (not
    // `objectContaining`) catches a stray `error: true` on the success path.
    const facts: PrFacts = {
      number: 7, url: "https://github.com/o/r/pull/7", title: "t", state: "OPEN", isDraft: false,
      ci: { passing: 2, pending: 0, failing: [] }, review: "approved", unresolved: 0,
      mergeable: "clean", ciAdvisory: false,
    };
    h.prFetch.mockResolvedValue({ ok: true, facts });
    await showAndWarm();
    expect(h.writePrEntry).toHaveBeenCalledWith("/prfacts", "PROJ-1", "svc", { facts, fetchedAt: expect.any(Number) });
  });

  it("does not fetch a repo that is not a git checkout", async () => {
    // worktree.ts can hand a non-git service through unchanged, and it lands in
    // Run.repos with isGit: false — `gh pr list` there would just fail forever.
    h.runs = [mkRun({ repos: [{ name: "svc", path: "/r/svc", isGit: false, branch: "b" }] })];
    await showAndWarm();
    expect(h.prFetch).not.toHaveBeenCalled();
  });

  it("does not fetch a PR for a run sitting on its default branch", async () => {
    // Previously asserted with the run's default (feature) branch, which — now
    // that the gate is branch-based, not ticket-based — correctly enqueues.
    // "master" is the actual Explore defect: an untracked run's repo left on
    // the branch it started on.
    h.runs = [mkRun({ key: "explore-retry-logic", url: "", repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "master" }] })];
    await showAndWarm();
    expect(h.prFetch).not.toHaveBeenCalled();
  });

  it("fetches the tracked run's PR and skips the untracked one on the same board", async () => {
    h.runs = [mkRun(), mkRun({ key: "explore-retry-logic", url: "", repos: [{ name: "other", path: "/r/other", isGit: true, branch: "master" }] })];
    await showAndWarm();
    expect(h.prFetch).toHaveBeenCalledTimes(1);
    expect(h.prFetch).toHaveBeenCalledWith("/r/svc", "b", "PROJ-1");
  });

  it("does not fetch a PR for a notepad run, whatever branch it sits on", async () => {
    // A notepad run is launched into whatever window and branch you already had
    // open, so its branch is PR-eligible (not the default branch) while any PR on
    // it belongs to that branch's own work. Nothing to fetch, and nothing that
    // could be honestly rendered if we did.
    h.runs = [mkRun({
      key: "notepad-dm-dean-n1", url: "", kind: "notepad",
      repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "docs/login-flow" }],
    })];
    await showAndWarm();
    expect(h.prFetch).not.toHaveBeenCalled();
  });

  it("keeps a notepad run PR-less even with entries already cached on disk", async () => {
    // The gate has to cover the read as well as the fetch: entries written before
    // this rule existed (or by another run in the same repo) would otherwise still
    // render as this note's pr / ci / review rows and vote in prSignals — which is
    // how a notepad card reached Done reading "merged" off a stranger's merge.
    const facts: PrFacts = {
      number: 860, url: "https://github.com/o/r/pull/860", title: "login flow docs",
      state: "MERGED", isDraft: false,
      ci: { passing: 10, pending: 0, failing: [] }, review: "approved", unresolved: 1,
      mergeable: "clean", ciAdvisory: false,
    };
    h.prEntries = { svc: { facts, fetchedAt: Date.now() } };
    h.runs = [mkRun({
      key: "notepad-dm-dean-n1", url: "", kind: "notepad",
      repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "docs/login-flow" }],
    })];
    await showAndWarm();
    expect(builtFor("notepad-dm-dean-n1").prs).toEqual({});
  });

  it("does not let an in-flight fetch resurrect a forgotten run's cache file", async () => {
    let release!: () => void;
    h.prFetch.mockImplementation(() => new Promise((res) => { release = () => res({ ok: true, facts: null }); }));
    show();
    await settled(); // first tick: only warms the gh probe, no fetch yet
    const p = lastPanel();
    await p._fire({ type: "deck:refresh" }); // second tick: the fetch is now in flight, unresolved
    await p._fire({ type: "deck:forget", key: "PROJ-1" }); // forgotten mid-flight
    release(); // resolves *after* the run was forgotten
    await settled();
    expect(h.writePrEntry).not.toHaveBeenCalled();
  });

  it("fetches nothing when prFacts is off and keeps the map empty", async () => {
    h.prFacts = false;
    h.prEntries = { svc: { facts: null, fetchedAt: Date.now() } };
    show();
    await settled();
    expect(h.prFetch).not.toHaveBeenCalled();
    expect(h.probeGh).not.toHaveBeenCalled();
    expect(h.buildRunStatus).toHaveBeenCalledWith(
      // `show()` defaults to unauthenticated, so ticket is null here (see the
      // "passes cached PR entries" test above for why `objectContaining`
      // still pins that key to the literal value).
      expect.objectContaining({
        ticket: null, projectsRoot: expect.any(String), nowMs: expect.any(Number),
        openIdentities: expect.any(Set), prs: {},
      }),
    );
  });

  it("fetches nothing and notes a missing gh", async () => {
    h.probeGh.mockResolvedValue({ kind: "missing", detail: "gh auth status: spawn gh ENOENT" });
    const p = await showAndWarm();
    expect(h.prFetch).not.toHaveBeenCalled();
    const note = posts(p).filter((m) => m.type === "deck:runs").at(-1)?.ghNote;
    expect(note).toMatch(/not found/i);
  });

  it("notes a signed-out gh differently from a missing one", async () => {
    // A signed-in user whose extension host cannot see their gh was told "not
    // found or not signed in" and could only conclude the Deck was broken. The
    // note has to name the gap the probe actually found.
    h.probeGh.mockResolvedValue({ kind: "signed-out", detail: "/opt/homebrew/bin/gh auth status: exit 1" });
    const p = await showAndWarm();
    const note = posts(p).filter((m) => m.type === "deck:runs").at(-1)?.ghNote;
    expect(note).toMatch(/not signed in/i);
    expect(note).not.toMatch(/not found/i);
  });

  it("logs which gh it tried and what that gh said", async () => {
    // The note names only the kind, so without this line a gap is undiagnosable:
    // nothing else records the path probed or the underlying spawn error.
    const log = vi.fn();
    h.probeGh.mockResolvedValue({ kind: "missing", detail: "gh auth status: spawn gh ENOENT" });
    DeckPanel.show(fakeContext().context as any, fakeConnector(false), log);
    await settled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("spawn gh ENOENT"));
  });

  it("re-probes gh when prFacts is toggled back on", async () => {
    // The user may have run `gh auth login` between turning it off and back on
    // — the cached probe result must not survive the round trip.
    show();
    await settled();
    h.prFacts = false;
    setConfig({ prFacts: false });
    fireConfigurationChanged("agentFlow.prFacts");
    await settled();
    h.probeGh.mockClear();
    h.prFacts = true;
    setConfig({ prFacts: true });
    fireConfigurationChanged("agentFlow.prFacts");
    await settled();
    expect(h.probeGh).toHaveBeenCalled();
  });

  it("applies a prFacts change from settings", async () => {
    // prFacts no longer has a payload field of its own on deck:runs — ghNote is
    // the one field left that reads this.prFacts on the host, so it stands in
    // for the removed field as the observable proof the change landed.
    h.probeGh.mockResolvedValue({ kind: "signed-out", detail: "not signed in" });
    show();
    await settled();
    const p = lastPanel();
    expect(posts(p).filter((m) => m.type === "deck:runs").at(-1)?.ghNote).toMatch(/not signed in/i);

    h.prFacts = false;
    setConfig({ prFacts: false });
    fireConfigurationChanged("agentFlow.prFacts");
    await settled();

    expect(posts(p).filter((m) => m.type === "deck:runs").at(-1)?.ghNote).toBeNull();
  });

  it("forgets a run's PR facts alongside its run record", async () => {
    show();
    await settled();
    await lastPanel()._fire({ type: "deck:forget", key: "PROJ-1" });
    expect(h.removePrEntries).toHaveBeenCalledWith("/prfacts", "PROJ-1");
  });

  it("skips a repo with no known branch, without throwing", async () => {
    // prEligible (Task 2) requires a branch to say a repo can own a PR — a repo
    // whose branch is unknown can no longer be told apart from one sitting on
    // its default branch, so it no longer gets a fetch, but it must not throw.
    h.runs = [mkRun({ repos: [{ name: "svc", path: "/r/svc", isGit: true }] })];
    await showAndWarm();
    expect(h.prFetch).not.toHaveBeenCalled();
  });

  it("drains the refresh queue when the panel is hidden — a dropped job never fetches", async () => {
    // 5 stale repos against the queue's default concurrency cap of 4: one is
    // left merely queued, never started, when the panel is hidden.
    const repos = Array.from({ length: 5 }, (_, i) => ({ name: `svc${i}`, path: `/r/svc${i}`, isGit: true, branch: "b" }));
    h.runs = [mkRun({ repos })];
    const releases: (() => void)[] = [];
    h.prFetch.mockImplementation(() => new Promise((res) => { releases.push(() => res({ ok: true, facts: null })); }));
    show();
    await settled(); // first tick: only warms the gh probe, no fetches queued yet
    const p = lastPanel();
    await p._fire({ type: "deck:refresh" }); // second tick: actually enqueues the 5 repos
    await settled();
    expect(h.prFetch).toHaveBeenCalledTimes(4);

    p.visible = false;
    p._fireViewState(); // stopPolling → prQueue.clear(): drops the 5th, queued job

    releases.forEach((r) => r());
    await settled();
    // If the queue had merely paused rather than dropped the queued job, a 5th
    // call would show up here once the active slots freed up.
    expect(h.prFetch).toHaveBeenCalledTimes(4);
  });

  it("stamps an error entry when the fetch itself rejects, rather than leaving nothing written (F1)", async () => {
    // RefreshQueue.pump swallows a rejected job (the queue owns the slot, not the
    // error) — so if enqueuePr doesn't catch this itself, writePrEntry is never
    // reached, the entry is never stamped, and isStale(undefined, …) re-enqueues
    // the same repo forever.
    h.prFetch.mockRejectedValue(new Error("gh exploded"));
    await showAndWarm();
    expect(h.writePrEntry).toHaveBeenCalledWith("/prfacts", "PROJ-1", "svc", expect.objectContaining({ error: true }));
  });

  it("drops a stored PR entry for a repo that has left the run (F4)", async () => {
    // Re-taking a task with a different repo selection can leave an entry behind
    // for a repo no longer in run.repos. It must never reach buildRunStatus —
    // rendering and voting on an orphaned entry can pin a card in Needs you (or
    // out of Done) with Forget as the only escape.
    const svcEntry = { facts: null, fetchedAt: Date.now() };
    h.prEntries = { svc: svcEntry, ghost: { facts: null, fetchedAt: Date.now() } };
    show();
    await settled();
    expect(h.buildRunStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        ticket: null, projectsRoot: expect.any(String), nowMs: expect.any(Number),
        openIdentities: expect.any(Set), prs: { svc: svcEntry },
      }),
    );
  });

  it("does not let a probe orphaned by a toggle overwrite a fresher one (F6)", async () => {
    // Two probes end up in flight: the one this test lets resolve late must not
    // win over the one started by the re-probe when prFacts comes back on
    // through a settings change.
    let resolveFirst!: (v: ForgeGap | null) => void;
    let resolveSecond!: (v: ForgeGap | null) => void;
    h.probeGh
      .mockImplementationOnce(() => new Promise((res) => { resolveFirst = res; }))
      .mockImplementationOnce(() => new Promise((res) => { resolveSecond = res; }));
    show();
    await settled(); // starts the first probe (left pending)
    const p = lastPanel();
    h.prFacts = false;
    setConfig({ prFacts: false });
    fireConfigurationChanged("agentFlow.prFacts");
    await settled();
    h.prFacts = true;
    setConfig({ prFacts: true });
    fireConfigurationChanged("agentFlow.prFacts"); // resets ghProbe, starts a second probe
    await settled();

    resolveSecond(null); // the fresh probe: the user just ran `gh auth login`
    await settled();
    resolveFirst({ kind: "signed-out", detail: "stale" }); // the orphaned probe, resolving late
    await settled();

    await p._fire({ type: "deck:refresh" });
    const note = posts(p).filter((m) => m.type === "deck:runs").at(-1)?.ghNote;
    expect(note).toBeNull();
  });
});

// Task 10: deckView reads everything through one `Forge`, resolved once from
// `agentFlow.forge`. `GhProvider` is replaced wholesale by the module mock
// above (`fetch = h.prFetch`), but `GlabProvider` is not — it is the REAL class,
// spawning through the same `execRunner` seam that mock's `execRunner` member
// replaces with `h.ghRun`. So with `forge: "gitlab"` the real GitLab provider
// runs against the existing spawn stub with no new mock at all, and `h.ghRun`'s
// recorded argv is the proof of which forge is actually live.
describe("forge selection", () => {
  it("reads PR facts through glab, not gh, when the forge is gitlab", async () => {
    setConfig({ forge: "gitlab" });
    h.ghRun.mockResolvedValue("[]"); // an empty MR list — the argv is the assertion
    await showAndWarm();
    // `GhProvider` never ran at all — the GitHub path's own mock proves it.
    expect(h.prFetch).not.toHaveBeenCalled();
    const calls = h.ghRun.mock.calls.map((call) => call[1].join(" "));
    expect(calls.some((a) => a.includes("api") && a.includes("merge_requests"))).toBe(true);
    expect(calls.some((a) => a.includes("pr list"))).toBe(false);
  });

  it("still reads PR facts through gh when the forge is left at its default", async () => {
    // No setConfig({ forge }) at all — the shipped default, and the path every
    // other fixture in this file already exercises.
    await showAndWarm();
    expect(h.prFetch).toHaveBeenCalled();
  });

  it("names the configured forge's CLI in the footer note", async () => {
    setConfig({ forge: "gitlab" });
    // `resolveBin("glab")` returns null on a machine with no `glab` installed
    // (this one, in CI), so the spawned file is the bare name "glab" — the same
    // shape a real ENOENT would produce.
    h.ghRun.mockRejectedValue(Object.assign(new Error("spawn glab ENOENT"), { code: "ENOENT" }));
    const p = await showAndWarm();
    const note = posts(p).filter((m) => m.type === "deck:runs").at(-1)?.ghNote;
    expect(note).toContain("glab");
    expect(note).not.toContain("gh CLI");
  });

  // Task 7 gives `caps()` its first REAL `resolveCaps()` to fall back from.
  // Bitbucket's `reviewSearch` is false in both of its modes (see
  // src/engine/forge/bitbucket.ts), so `reviewsEnabled()` must stay false
  // regardless of which mode the (mocked) probe resolves to, and the strip's
  // own sweep must never reach the provider at all.
  it("hides the review strip entirely on bitbucket, and never asks its provider to search", async () => {
    setConfig({ forge: "bitbucket" });
    const search = vi.spyOn(BbReviewProvider.prototype, "search");
    try {
      const p = await showAndWarm();
      expect(posts(p).filter((m) => m.type === "deck:reviews").at(-1)).toMatchObject({ enabled: false });
      expect(search).not.toHaveBeenCalled();
    } finally {
      search.mockRestore();
    }
  });

  // The other half of the same fallback: github has no `resolveCaps` at all
  // (registry.test.ts pins this), so `caps()` must keep reading `forge.caps`
  // statically on every tick this suite's other fixtures rely on — Task 1's
  // addition of `resolveCaps`/`caps()` must be a no-op for a forge that never
  // had one.
  it("still reads github's static caps with no resolveCaps to fall back from", async () => {
    const p = await showAndWarm();
    await p._fire({ type: "deck:refresh" });
    await settled();
    expect(posts(p).filter((m) => m.type === "deck:reviews").at(-1)).toMatchObject({ enabled: true });
    expect(h.reviewSearch).toHaveBeenCalled();
  });
});

describe("DeckPanel review strip", () => {
  it("posts the review queue after a search", async () => {
    const p = await showAndWarm();
    const msg = posts(p).find((m) => m.type === "deck:reviews");
    expect(msg).toMatchObject({ issueCount: 1, sort: "oldest", stale: false });
    expect(msg.requests).toHaveLength(1);
    expect(msg.requests[0].id).toBe("CyberJackGit/aws-ops#8491");
  });

  it("carries reviewWrites off by default", async () => {
    const p = await showAndWarm();
    expect(posts(p).find((m) => m.type === "deck:reviews").reviewWrites).toBe(false);
  });

  it("carries reviewWrites on when the setting is on", async () => {
    h.reviewWrites = true;
    const p = await showAndWarm();
    expect(posts(p).find((m) => m.type === "deck:reviews").reviewWrites).toBe(true);
  });

  it("carries alwaysVisible on by default and off when the setting is switched off", async () => {
    let p = await showAndWarm();
    expect(posts(p).filter((m) => m.type === "deck:reviews").at(-1).alwaysVisible).toBe(true);
    h.reviewRequestsAlwaysVisible = false;
    p = await showAndWarm();
    expect(posts(p).filter((m) => m.type === "deck:reviews").at(-1).alwaysVisible).toBe(false);
  });

  // The disabled post must not carry the setting through: an "always visible"
  // strip that has been switched off (reviewRequests, PR facts, the forge CLI)
  // must still leave the board, or the off switch stops meaning off.
  it("posts alwaysVisible false when the strip is off, even with the setting on", async () => {
    h.reviewRequestsAlwaysVisible = true;
    h.reviewRequests = false;
    const p = await showAndWarm();
    expect(posts(p).filter((m) => m.type === "deck:reviews").at(-1)).toMatchObject({
      enabled: false, alwaysVisible: false,
    });
  });

  it("resolves a local checkout for a repo under reposRoot", async () => {
    const p = await showAndWarm();
    const msg = posts(p).find((m) => m.type === "deck:reviews");
    expect(msg.requests[0].localPath).toBe("/repos/aws-ops");
  });

  it("leaves localPath null for a repo that is not checked out", async () => {
    h.repos = [];
    const p = await showAndWarm();
    expect(posts(p).find((m) => m.type === "deck:reviews").requests[0].localPath).toBeNull();
  });

  it("does not treat a non-git directory sharing the repo's name as a checkout", async () => {
    // `local?.isGit ? local.path : null` vs. `local ? local.path : null`: only a
    // fixture with `isGit: false` tells these apart. A plain directory here would
    // otherwise be offered as a checkout, and "review with agent" would later
    // land in something that isn't a repo at all.
    h.repos = [{ name: "aws-ops", path: "/repos/aws-ops", isGit: false }];
    const p = await showAndWarm();
    expect(posts(p).find((m) => m.type === "deck:reviews").requests[0].localPath).toBeNull();
  });

  it("persists the search result as returned, not the machine-decorated copy", async () => {
    // decorateReviews recomputes `localPath` on every post and deliberately never
    // persists it (a checkout can appear or vanish between refreshes). Writing
    // `decorateReviews(res.requests)` instead of `res.requests` would still pass
    // every other test here, but would bake this machine's `localPath` into
    // ~/.agentflow/reviews.json — exactly what that non-persistence guarantee
    // forbids.
    await showAndWarm();
    expect(h.writeReviewCache).toHaveBeenCalledWith("/reviews.json", {
      fetchedAt: expect.any(Number),
      issueCount: 1,
      requests: [expect.objectContaining({ id: "CyberJackGit/aws-ops#8491", localPath: null })],
    });
  });

  it("re-posts on every refresh once the cache is fresh, without re-searching", async () => {
    // Nothing in the tests above ever observes the "already fresh" branch of
    // enqueueReviews — every one of them only sees the post that comes from the
    // settled search job. Deleting that branch's `postReviews()` call leaves all
    // of them green, but the strip would then never pick up a newly appeared
    // checkout's `localPath` (or anything else decorateReviews recomputes) until
    // the cache aged out again, up to reviewRequestsTtlSeconds later.
    const p = await showAndWarm();
    const before = posts(p).filter((m) => m.type === "deck:reviews").length;
    expect(before).toBeGreaterThan(0);
    h.reviewSearch.mockClear();
    await p._fire({ type: "deck:refresh" });
    await settled();
    expect(posts(p).filter((m) => m.type === "deck:reviews").length).toBeGreaterThan(before);
    expect(h.reviewSearch).not.toHaveBeenCalled();
  });

  it("keeps the cached queue and flags it stale when the search fails", async () => {
    // A broken implementation that empties the queue (or drops the cache) on a
    // failed search instead of preserving it would still satisfy an assertion
    // that only checks `stale` — pin the previous issueCount *and* the previous
    // requests array too, and confirm the bad result is never persisted to disk.
    h.reviewCache = { fetchedAt: 0, issueCount: 4, requests: [reviewFixture()] };
    // Persistent (not `Once`): whether one or two refresh passes end up racing to
    // search — the queue dedupes concurrent attempts for the same key, but not
    // necessarily sequential ones — every attempt in this test must fail, so the
    // cache is never overwritten with a spurious success.
    h.reviewSearch.mockResolvedValue(null);
    const p = await showAndWarm();
    const msg = posts(p).find((m) => m.type === "deck:reviews");
    expect(msg.stale).toBe(true);
    expect(msg.issueCount).toBe(4);
    expect(msg.requests).toHaveLength(1);
    expect(msg.requests[0].id).toBe("CyberJackGit/aws-ops#8491");
    expect(h.writeReviewCache).not.toHaveBeenCalled();
  });

  it("does not retry a failing search on every poll tick within the TTL", async () => {
    // A failed search deliberately leaves `reviewCache.fetchedAt` untouched (the
    // stale marker depends on it), so `isReviewCacheStale` alone would re-arm on
    // every 6s poll forever once `gh` starts failing — hammering `gh api graphql`
    // and holding a queue slot for up to GH_TIMEOUT_MS on each attempt.
    h.reviewSearch.mockResolvedValue(null);
    const p = await showAndWarm(); // one attempt: fails
    expect(h.reviewSearch).toHaveBeenCalledTimes(1);
    await p._fire({ type: "deck:refresh" }); // a second poll, well inside the 300s TTL
    await settled();
    expect(h.reviewSearch).toHaveBeenCalledTimes(1);
  });

  it("does not search while the review strip is disabled, but actively clears it instead of staying silent", async () => {
    h.reviewRequests = false;
    show();
    await settled();
    expect(h.reviewSearch).not.toHaveBeenCalled();
    // Task 2: silence here used to mean "the webview keeps whatever it last had"
    // — a stale queue with its write buttons still live. Disabled must still
    // post, with an empty queue and `enabled: false`.
    expect(posts(lastPanel()).find((m) => m.type === "deck:reviews")).toMatchObject({
      requests: [], issueCount: 0, enabled: false,
    });
  });

  it("does not search while PR facts are off", async () => {
    h.prFacts = false;
    show();
    await settled();
    expect(h.reviewSearch).not.toHaveBeenCalled();
  });

  it("does not search while gh is unusable", async () => {
    h.probeGh.mockResolvedValue({ kind: "missing", detail: "no gh" });
    await showAndWarm();
    expect(h.reviewSearch).not.toHaveBeenCalled();
  });

  it("carries enabled: true while the strip is on", async () => {
    const p = await showAndWarm();
    expect(posts(p).find((m) => m.type === "deck:reviews")).toMatchObject({ enabled: true });
  });

  it("stops searching and clears the strip when the review queue is toggled off", async () => {
    const p = await showAndWarm();
    expect(h.reviewSearch).toHaveBeenCalledTimes(1);

    h.reviewRequests = false;
    setConfig({ reviewRequests: false });
    fireConfigurationChanged("agentFlow.reviewRequests");
    await settled();
    expect(posts(p).filter((m) => m.type === "deck:reviews").at(-1)).toMatchObject({
      requests: [], issueCount: 0, enabled: false,
    });
    expect(h.reviewSearch).toHaveBeenCalledTimes(1);
  });

  // The regression this guards: reading `getConfig().reviewRequests` inside
  // reviewsEnabled() rather than the session field. A routine refresh must not
  // re-seed it — only a configuration event does — so a poll tick cannot
  // silently undo what the user last set.
  it("re-reads reviewRequests on a configuration change but not on a routine refresh", async () => {
    h.reviewRequests = true;
    const p = await showAndWarm();

    h.reviewRequests = false;
    setConfig({ reviewRequests: false });
    await p._fire({ type: "deck:refresh" });
    expect(posts(p).filter((m) => m.type === "deck:reviews").at(-1)).toMatchObject({ enabled: true });

    fireConfigurationChanged("agentFlow.reviewRequests");
    await settled();
    expect(posts(p).filter((m) => m.type === "deck:reviews").at(-1)).toMatchObject({ enabled: false });
    expect(h.reviewSearch).toHaveBeenCalledTimes(1);
  });

  // Back on puts the queue up again from cache rather than re-running the search:
  // `reviewLastAttemptAt` still holds from before the toggle, and the attempt
  // clock is deliberately independent of the strip being switched off and on —
  // flipping the pill twice is not a reason to spend another `gh api graphql`.
  it("restores the queue from cache when toggled back on, without a fresh search", async () => {
    const p = await showAndWarm();
    h.reviewRequests = false;
    setConfig({ reviewRequests: false });
    fireConfigurationChanged("agentFlow.reviewRequests");
    await settled();
    h.reviewRequests = true;
    setConfig({ reviewRequests: true });
    fireConfigurationChanged("agentFlow.reviewRequests");
    await settled();
    expect(h.reviewSearch).toHaveBeenCalledTimes(1);
    const last = posts(p).filter((m) => m.type === "deck:reviews").at(-1);
    expect(last).toMatchObject({ enabled: true, loading: false });
    expect(last.requests).toHaveLength(1);
  });

  // The point of the whole cache-first path: `refresh()` only reaches
  // enqueueReviews after `buildAll()` — git per repo and Jira per run — so a
  // queue already on disk used to wait out the entire board for no reason.
  // Asserted without settling: postCachedReviews runs before onMessage's first
  // await, so at this instant a board post cannot have happened yet.
  it("posts the cached queue on deck:ready without waiting for the board build", async () => {
    // Fresh on disk, so no search is even queued — the cache alone is what the
    // strip should be showing.
    h.reviewCache = { fetchedAt: Date.now(), issueCount: 1, requests: [reviewFixture()] };
    show();
    await settled(); // let the gh probe resolve; without it the strip reads as off
    const p = lastPanel();
    p.webview.postMessage.mockClear();
    const ready = p._fire({ type: "deck:ready" });

    const early = posts(p);
    expect(early.find((m) => m.type === "deck:reviews")).toMatchObject({ enabled: true, loading: false });
    expect(early.find((m) => m.type === "deck:reviews").requests).toHaveLength(1);
    expect(early.find((m) => m.type === "deck:runs")).toBeUndefined();

    await ready;
    await settled();
  });

  it("says it is still checking when there is nothing cached to show yet", async () => {
    h.reviewCache = null;
    h.reviewSearch.mockImplementation(() => new Promise(() => {})); // never settles
    show();
    await settled();
    const p = lastPanel();
    await p._fire({ type: "deck:ready" });
    await settled();
    expect(posts(p).filter((m) => m.type === "deck:reviews").at(-1)).toMatchObject({
      requests: [], issueCount: 0, enabled: true, loading: true, stale: false,
    });
  });

  // A first search that fails leaves the cache null and `stale` set. That pair
  // must read as "couldn't check", not as a search still running — the webview
  // would otherwise shimmer forever waiting on something that already gave up.
  it("stops claiming to be loading once the first search has failed", async () => {
    h.reviewCache = null;
    h.reviewSearch.mockResolvedValue(null);
    const p = await showAndWarm();
    expect(posts(p).filter((m) => m.type === "deck:reviews").at(-1)).toMatchObject({
      requests: [], enabled: true, loading: false, stale: true,
    });
  });

  // Task 2 (blocking): toggling PR facts off while the Deck is open used to
  // leave the webview's last-posted rows exactly as they were — frozen, but
  // with Approve/Comment/Request changes still clickable, since nothing ever
  // told the webview the strip had gone off. Also pins the submitReview-level
  // gate: a submit for a row from that same, now-disabled strip must not reach
  // the provider even though the row is technically still sitting in memory.
  it("clears the strip and refuses a queued row's submit once PR facts (and therefore the strip) go off", async () => {
    h.reviewWrites = true;
    const p = await showAndWarm();
    expect(posts(p).find((m) => m.type === "deck:reviews").requests).toHaveLength(1);

    h.prFacts = false;
    setConfig({ prFacts: false });
    fireConfigurationChanged("agentFlow.prFacts");
    await settled();
    const cleared = posts(p).filter((m) => m.type === "deck:reviews").at(-1);
    expect(cleared).toMatchObject({ requests: [], issueCount: 0, enabled: false });

    await p._fire({
      type: "deck:reviewSubmit", id: "CyberJackGit/aws-ops#8491", verb: "approve", body: "", fromDraft: false,
    });
    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(h.reviewSubmit).not.toHaveBeenCalled();
    expect(posts(p)).toContainEqual({
      type: "deck:reviewSubmitDone", id: "CyberJackGit/aws-ops#8491", outcome: "cancelled",
    });
  });

  it("re-sorts without re-searching when the sort changes", async () => {
    // Two requests whose size-order differs from their age-order, so switching
    // sorts is only observable as a genuine reorder of the request list — not
    // just an echoed `sort` field a stub could satisfy without truly re-sorting.
    const older = reviewFixture(); // createdAt 1, 354 lines changed
    const newerButSmaller = { ...reviewFixture(), id: "CyberJackGit/aws-ops#9000", number: 9000, createdAt: 10, additions: 10, deletions: 0 };
    h.reviewSearch.mockResolvedValue({ issueCount: 2, requests: [older, newerButSmaller] });
    const p = await showAndWarm();
    const byOldest = posts(p).find((m) => m.type === "deck:reviews");
    expect(byOldest.requests.map((r: ReviewRequest) => r.number)).toEqual([8491, 9000]);

    h.reviewSearch.mockClear();
    await p._fire({ type: "deck:setReviewSort", sort: "smallest" });
    const bySmallest = posts(p).at(-1);
    expect(bySmallest).toMatchObject({ type: "deck:reviews", sort: "smallest" });
    expect(bySmallest.requests.map((r: ReviewRequest) => r.number)).toEqual([9000, 8491]);
    expect(h.reviewSearch).not.toHaveBeenCalled();
  });
});

describe("DeckPanel review detail", () => {
  it("fetches a row's detail and posts it", async () => {
    const p = await showAndWarm();
    await p._fire({ type: "deck:reviewExpand", id: "CyberJackGit/aws-ops#8491" });
    // Routed through prQueue (see the "shared refresh queue" test below): onMessage
    // no longer awaits the fetch itself, only enqueues it — a settled() tick is
    // needed for the queued job to actually run and post.
    await settled();
    // The mock resolves the same canned value regardless of its arguments, so
    // without this the row's own repo/number could be swapped or dropped
    // entirely (e.g. calling detail(id, 0)) and every other assertion here
    // would still pass. Only this pins "the right PR was fetched."
    expect(h.reviewDetail).toHaveBeenCalledWith("CyberJackGit/aws-ops", 8491);
    expect(posts(p).at(-1)).toMatchObject({
      type: "deck:reviewDetail",
      id: "CyberJackGit/aws-ops#8491",
      detail: { failing: [], unresolved: null },
    });
  });

  // Task 10: GitLab's REST API carries no diff-stats aggregate in the queue call
  // the way GitHub's search does — and no pipeline field either, verified against
  // gitlab.com — so a forge that needs them fills them in here instead, merged into
  // the cached request rather than posted separately, so the strip's existing size
  // and CI chips render them with no webview change at all.
  it("merges a detail-supplied size and ci verdict into the cached request", async () => {
    h.reviewDetail.mockResolvedValueOnce({
      failing: [], unresolved: null,
      size: { additions: 12, deletions: 3, changedFiles: 4 },
      ci: "failing",
    });
    const p = await showAndWarm();
    await p._fire({ type: "deck:reviewExpand", id: "CyberJackGit/aws-ops#8491" });
    await settled();
    // reviewDetail() itself only posts deck:reviewDetail — force a re-post of
    // deck:reviews (the cache is fresh, so this re-serves it rather than
    // re-searching) to observe the merge landed on the cached row itself.
    await p._fire({ type: "deck:refresh" });
    await settled();
    const row = (posts(p).filter((m) => m.type === "deck:reviews").at(-1) as {
      requests: ReviewRequest[];
    }).requests.find((r) => r.id === "CyberJackGit/aws-ops#8491");
    expect(row).toMatchObject({ additions: 12, deletions: 3, changedFiles: 4, ci: "failing" });
  });

  // `ci` is OPTIONAL on ReviewDetail: GitHub's search already filled the chip, so its
  // detail sends none, and an unguarded `cached.ci = detail.ci` would overwrite a real
  // verdict with `undefined` — a row whose CI chip renders as nothing at all.
  it("leaves the row's own ci alone when the detail carries none", async () => {
    h.reviewSearch.mockResolvedValue({ issueCount: 1, requests: [{ ...reviewFixture(), ci: "passing" }] });
    h.reviewDetail.mockResolvedValueOnce({
      failing: [], unresolved: null, size: { additions: 1, deletions: 0, changedFiles: 1 },
    });
    const p = await showAndWarm();
    await p._fire({ type: "deck:reviewExpand", id: "CyberJackGit/aws-ops#8491" });
    await settled();
    await p._fire({ type: "deck:refresh" });
    await settled();
    const row = (posts(p).filter((m) => m.type === "deck:reviews").at(-1) as {
      requests: ReviewRequest[];
    }).requests.find((r) => r.id === "CyberJackGit/aws-ops#8491");
    expect(row).toMatchObject({ ci: "passing", changedFiles: 1 });
  });

  it("ignores an id that is not in the queue", async () => {
    const p = await showAndWarm();
    const before = posts(p).length;
    await p._fire({ type: "deck:reviewExpand", id: "who/what#1" });
    await settled();
    expect(posts(p)).toHaveLength(before);
    // A guard that merely happened not to post (rather than never looking the id
    // up at all) would still pass an assertion on posts() alone — pin that the
    // provider itself was never reached for an id outside the current queue.
    expect(h.reviewDetail).not.toHaveBeenCalled();
  });

  it("posts a null detail and logs when the detail fetch fails, instead of leaving the row loading forever", async () => {
    // Mirrors "logs which gh it tried and what that gh said" above: a custom
    // log spy passed straight into DeckPanel.show, so both halves of the
    // requirement — the failure marker, and a trace of the failed id — are
    // pinned in one test. A row with nothing ever posted for it renders
    // "loading…" forever; `detail: null` is what tells the webview to stop.
    h.reviewDetail.mockResolvedValueOnce(null);
    const log = vi.fn();
    DeckPanel.show(fakeContext().context as any, fakeConnector(false), log);
    await settled();
    const p = lastPanel();
    await p._fire({ type: "deck:refresh" });
    await settled();
    await p._fire({ type: "deck:reviewExpand", id: "CyberJackGit/aws-ops#8491" });
    await settled();
    expect(posts(p).at(-1)).toMatchObject({
      type: "deck:reviewDetail", id: "CyberJackGit/aws-ops#8491", detail: null,
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("CyberJackGit/aws-ops#8491"));
  });

  // Task 5: every other `gh` invocation on this panel goes through prQueue,
  // capped at 4 concurrent — row expansion used to be awaited directly in
  // onMessage, bypassing that cap entirely. Five simultaneous expansions
  // against the cap of 4: a reverted fix would call the provider all five
  // times at once.
  it("routes row expansion through the shared refresh queue instead of forking unboundedly", async () => {
    const ids = Array.from({ length: 5 }, (_, i) => `o/r#${i}`);
    const requests = ids.map((id, i) => ({ ...reviewFixture(), id, repo: "o/r", number: i }));
    h.reviewSearch.mockResolvedValue({ issueCount: ids.length, requests });
    const releases: (() => void)[] = [];
    h.reviewDetail.mockImplementation(
      () => new Promise((res) => releases.push(() => res({ failing: [], unresolved: null }))),
    );
    const p = await showAndWarm();
    for (const id of ids) await p._fire({ type: "deck:reviewExpand", id });
    await settled();
    expect(h.reviewDetail).toHaveBeenCalledTimes(4);

    releases.forEach((r) => r());
    await settled();
    expect(h.reviewDetail).toHaveBeenCalledTimes(5);
  });
});

describe("DeckPanel review launch", () => {
  const TWO_MODES = [
    { id: "backend", label: "Backend services", detail: "Backend review skill", prompt: "BE {number}" },
    { id: "frontend", label: "Frontend", detail: "Frontend review skill", prompt: "FE {number}" },
  ];

  it("does not ask which mode to use when only the stock one is configured", async () => {
    // The no-regression guard: an install that never touched the setting must
    // still launch a review in one click.
    const p = await showAndWarm();
    await p._fire({ type: "deck:reviewLaunch", id: "CyberJackGit/aws-ops#8491" });
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(h.launchReview).toHaveBeenCalled();
  });

  it("asks which mode to use and seeds the one picked", async () => {
    setConfig({ reviewRequestModes: TWO_MODES });
    window.showQuickPick.mockResolvedValueOnce({ label: "Frontend", mode: TWO_MODES[1] });
    const p = await showAndWarm();
    await p._fire({ type: "deck:reviewLaunch", id: "CyberJackGit/aws-ops#8491" });
    expect(window.showQuickPick).toHaveBeenCalledTimes(1);
    // The picked mode's own template, not merely some template: an
    // implementation that always seeded modes[0] would pass a looser check.
    expect(h.launchReview).toHaveBeenCalledWith(
      expect.objectContaining({ template: "FE {number}" }),
      expect.anything(),
    );
  });

  it("offers every configured mode, label and detail, plus the stock mode the list didn't mention", async () => {
    setConfig({ reviewRequestModes: TWO_MODES });
    const p = await showAndWarm();
    await p._fire({ type: "deck:reviewLaunch", id: "CyberJackGit/aws-ops#8491" });
    expect(window.showQuickPick).toHaveBeenCalledWith(
      [
        expect.objectContaining({ label: "Backend services", detail: "Backend review skill" }),
        expect.objectContaining({ label: "Frontend", detail: "Frontend review skill" }),
        // reviewRequestModes now layers over the built-ins rather than replacing
        // them, so the stock "Full review" mode this list never mentioned is
        // still offered, appended after the user's own two.
        expect.objectContaining({ label: "Full review" }),
      ],
      expect.objectContaining({ title: "Review aws-ops#8491" }),
    );
  });

  it("raises a picker with exactly one custom review mode configured, offering it alongside the stock mode", async () => {
    // The layering consequence finding 1 flags: a single custom entry used to
    // keep the zero-friction launch (modes.length === 1 short-circuited the
    // picker in resolveReviewMode). Layering now appends stock "full", making
    // it 2, so the picker appears where it didn't before.
    const ONE_MODE = [{ id: "backend", label: "Backend services", detail: "Backend review skill", prompt: "BE {number}" }];
    setConfig({ reviewRequestModes: ONE_MODE });
    const p = await showAndWarm();
    await p._fire({ type: "deck:reviewLaunch", id: "CyberJackGit/aws-ops#8491" });
    expect(window.showQuickPick).toHaveBeenCalledWith(
      [
        expect.objectContaining({ label: "Backend services", detail: "Backend review skill" }),
        expect.objectContaining({ label: "Full review" }),
      ],
      expect.objectContaining({ title: "Review aws-ops#8491" }),
    );
  });

  it("creates nothing when the mode picker is cancelled", async () => {
    setConfig({ reviewRequestModes: TWO_MODES });
    window.showQuickPick.mockResolvedValueOnce(undefined);
    const p = await showAndWarm();
    const before = posts(p).length;
    await p._fire({ type: "deck:reviewLaunch", id: "CyberJackGit/aws-ops#8491" });
    // launchReview is what creates the worktree and opens the window, so
    // asserting it was never reached is asserting no side effect happened —
    // stronger than checking for the absence of a toast.
    expect(h.launchReview).not.toHaveBeenCalled();
    expect(posts(p).slice(before).some((m) => m.type === "toast")).toBe(false);
  });

  it("skips the picker when a mode is pinned, and seeds that one", async () => {
    setConfig({ reviewRequestModes: TWO_MODES, reviewRequestMode: "backend" });
    const p = await showAndWarm();
    await p._fire({ type: "deck:reviewLaunch", id: "CyberJackGit/aws-ops#8491" });
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(h.launchReview).toHaveBeenCalledWith(
      expect.objectContaining({ template: "BE {number}" }),
      expect.anything(),
    );
  });

  it("launches a review and toasts", async () => {
    const p = await showAndWarm();
    await p._fire({ type: "deck:reviewLaunch", id: "CyberJackGit/aws-ops#8491" });
    expect(h.launchReview).toHaveBeenCalled();
    expect(posts(p).some((m) => m.type === "toast" && m.level === "success")).toBe(true);
  });

  it("emits review_launched with outcome launched for a single review", async () => {
    const p = await showAndWarm();
    await p._fire({ type: "deck:reviewLaunch", id: "CyberJackGit/aws-ops#8491" });
    const ev = trackSpy.mock.calls.flat().find((e: any) => e.name === "review_launched") as any;
    expect(ev).toMatchObject({
      outcome: "launched", mode: "stock", mode_was_pinned: true, destination: "new",
      provider: "claude-code", seeded_in_place: false, batch: false,
      requested_count: 1, launched_count: 1, failed_count: 0, skipped_count: 0,
    });
  });

  it("emits review_launched with outcome cancelled when the mode picker is dismissed", async () => {
    setConfig({ reviewRequestModes: TWO_MODES });
    window.showQuickPick.mockResolvedValueOnce(undefined);
    const p = await showAndWarm();
    await p._fire({ type: "deck:reviewLaunch", id: "CyberJackGit/aws-ops#8491" });
    const ev = trackSpy.mock.calls.flat().find((e: any) => e.name === "review_launched") as any;
    expect(ev.outcome).toBe("cancelled");
    expect(ev.batch).toBe(false);
    expect(ev.requested_count).toBe(1);
  });

  it("emits review_launched with outcome failed when this window loses identity between the destination pick and the launch", async () => {
    // Same loss `targetToOpenArgs` documents for "current": the window vanishes
    // between the destination QuickPick answering "This window" and the second,
    // fresh `currentWindow()` read just before `launchReview`. Simulated inside the
    // picker's own resolution, the one async gap between the two reads.
    setConfig({ reviewOpenIn: "ask" });
    const HERE = { identity: "/repos/aws-ops", kind: "folder" as const, roots: [{ path: "/repos/aws-ops" }] };
    h.currentWindow = HERE;
    window.showQuickPick.mockImplementationOnce(async (items: unknown) => {
      const row = (items as { label: string }[]).find((i) => i.label.includes("This window"));
      h.currentWindow = undefined;
      return row;
    });
    const p = await showAndWarm();
    await p._fire({ type: "deck:reviewLaunch", id: "CyberJackGit/aws-ops#8491" });
    expect(h.launchReview).not.toHaveBeenCalled();
    const ev = trackSpy.mock.calls.flat().find((e: any) => e.name === "review_launched") as any;
    expect(ev).toMatchObject({
      outcome: "failed", batch: false, requested_count: 1, launched_count: 0, failed_count: 1, skipped_count: 0,
    });
  });

  it("still names Claude Code pre-seeded in the launch toast by default", async () => {
    const p = await showAndWarm();
    await p._fire({ type: "deck:reviewLaunch", id: "CyberJackGit/aws-ops#8491" });
    expect(posts(p)).toContainEqual(
      expect.objectContaining({
        type: "toast", level: "success",
        message: expect.stringContaining("Claude Code pre-seeded — press Enter to start."),
      }),
    );
  });

  it("names Claude Code in the launch toast under `ask`", async () => {
    // Same sentence-start problem as the Tasks-panel toast: this one reads
    // "Reviewing acme#8491 in a worktree. <agent> pre-seeded — …".
    h.agentProvider = "ask";
    const p = await showAndWarm();
    await p._fire({ type: "deck:reviewLaunch", id: "CyberJackGit/aws-ops#8491" });
    expect(posts(p)).toContainEqual(
      expect.objectContaining({
        type: "toast", level: "success",
        message: expect.stringContaining("Claude Code pre-seeded — press Enter to start."),
      }),
    );
  });

  it("names Copilot in the launch toast when Copilot is configured", async () => {
    h.agentProvider = "copilot";
    const p = await showAndWarm();
    await p._fire({ type: "deck:reviewLaunch", id: "CyberJackGit/aws-ops#8491" });
    expect(posts(p)).toContainEqual(
      expect.objectContaining({
        type: "toast", level: "success",
        message: expect.stringContaining("Copilot pre-seeded — press Enter to start."),
      }),
    );
  });

  // ── Task 6: the review path under `ask` ───────────────────────────────────
  it("names the agent the launch actually seeded, not the one the setting names", async () => {
    // Under `ask` the setting names nobody: the answer exists only on what
    // launchReview returned. Reading the setting here says "Claude Code" while a
    // Cursor session is what is starting in the worktree the toast is about.
    h.agentProvider = "ask";
    h.launchReview.mockResolvedValueOnce({ ok: true, runKey: "review-aws-ops-8491", provider: "cursor" });
    const p = await showAndWarm();
    await p._fire({ type: "deck:reviewLaunch", id: "CyberJackGit/aws-ops#8491" });
    expect(posts(p)).toContainEqual(
      expect.objectContaining({
        type: "toast", level: "success",
        message: expect.stringContaining("Cursor pre-seeded — press Enter to start."),
      }),
    );
  });

  it("says nothing at all when the agent picker is dismissed", async () => {
    // A dismissal is the user's own decision, not a failure: an error toast here
    // would report their Escape key as something going wrong. The mode-picker
    // cancellation above is silent for the same reason.
    h.agentProvider = "ask";
    h.launchReview.mockResolvedValueOnce({ ok: false, cancelled: true });
    const p = await showAndWarm();
    const before = posts(p).length;
    await p._fire({ type: "deck:reviewLaunch", id: "CyberJackGit/aws-ops#8491" });
    expect(posts(p).slice(before).some((m) => m.type === "toast")).toBe(false);
  });

  it("refreshes after a successful launch, so the row picks up its new run", async () => {
    // The busy-indicator pair is this file's existing signal for "a refresh ran"
    // (see "brackets a forget/prFacts toggle with the busy indicator" above) — reused
    // here rather than invented fresh, so this matches local convention. showAndWarm's
    // own explicit deck:refresh already posts one true/false pair before the launch;
    // a real post-launch refresh must add another, on top of that baseline.
    const p = await showAndWarm();
    const before = posts(p).filter((m) => m.type === "deck:loading").length;
    await p._fire({ type: "deck:reviewLaunch", id: "CyberJackGit/aws-ops#8491" });
    const loads = posts(p).filter((m) => m.type === "deck:loading");
    expect(loads.length).toBeGreaterThan(before);
    expect(loads.at(-1)?.loading).toBe(false);
  });

  it("toasts the reason when a launch is refused, verbatim", async () => {
    // An exact match, not merely a truthy error toast: a broken implementation
    // that toasts a canned "couldn't launch" string regardless of what
    // launchReview actually said would still pass a looser assertion.
    h.launchReview.mockResolvedValueOnce({ ok: false, message: "no checkout" });
    const p = await showAndWarm();
    await p._fire({ type: "deck:reviewLaunch", id: "CyberJackGit/aws-ops#8491" });
    expect(posts(p).some((m) => m.type === "toast" && m.level === "error" && m.message === "no checkout")).toBe(true);
  });

  it("ignores a launch for an id that is not in the queue", async () => {
    const p = await showAndWarm();
    await p._fire({ type: "deck:reviewLaunch", id: "who/what#1" });
    // Pinning that launchReview itself was never reached, not merely that
    // nothing got posted — a guard that looked the id up, found nothing, but
    // still called through with an undefined req would pass a posts()-only check.
    expect(h.launchReview).not.toHaveBeenCalled();
  });

  it("reports a review run and its draft file on the row", async () => {
    h.runs = [{
      key: "review-aws-ops-8491", summary: "Review", url: "https://gh/pr/8491", createdAt: 1, kind: "review",
      mode: "per-window", repos: [{ name: "aws-ops", path: "/repos/aws-ops/.claude/worktrees/review-aws-ops-8491", isGit: true }],
      briefPaths: [],
    }];
    h.existsSync.mockReturnValue(true);
    const p = await showAndWarm();
    const row = posts(p).find((m) => m.type === "deck:reviews").requests[0];
    expect(row.runKey).toBe("review-aws-ops-8491");
    expect(row.draftPath).toBe("/repos/aws-ops/.claude/worktrees/review-aws-ops-8491/.pick-task/REVIEW-8491.md");
  });

  it("does not leak a review run's runKey/draftPath onto another row in the same queue", async () => {
    // Two queued PRs, a review run for only one of them. reviewRunKey keys the
    // match per-row, so this is unlikely to leak by accident — but every other
    // test above only ever queues one row, so nothing actually proved isolation
    // until now.
    const other = { ...reviewFixture(), id: "CyberJackGit/other-repo#123", repo: "CyberJackGit/other-repo", repoName: "other-repo", number: 123 };
    h.reviewSearch.mockResolvedValue({ issueCount: 2, requests: [reviewFixture(), other] });
    h.runs = [{
      key: "review-aws-ops-8491", summary: "Review", url: "https://gh/pr/8491", createdAt: 1, kind: "review",
      mode: "per-window", repos: [{ name: "aws-ops", path: "/repos/aws-ops/.claude/worktrees/review-aws-ops-8491", isGit: true }],
      briefPaths: [],
    }];
    h.existsSync.mockReturnValue(true);
    const p = await showAndWarm();
    const rows = posts(p).find((m) => m.type === "deck:reviews").requests;
    const aws = rows.find((r: ReviewRequest) => r.id === "CyberJackGit/aws-ops#8491");
    const untouched = rows.find((r: ReviewRequest) => r.id === "CyberJackGit/other-repo#123");
    expect(aws.runKey).toBe("review-aws-ops-8491");
    expect(untouched.runKey).toBeNull();
    expect(untouched.draftPath).toBeNull();
  });

  it("leaves draftPath null when the agent hasn't written a file yet", async () => {
    // Same review run as above, but existsSync says the file isn't there —
    // an implementation that ignores existsSync (always offering the computed
    // path) would pass every other test here yet render a Load button pointing
    // at nothing.
    h.runs = [{
      key: "review-aws-ops-8491", summary: "Review", url: "https://gh/pr/8491", createdAt: 1, kind: "review",
      mode: "per-window", repos: [{ name: "aws-ops", path: "/repos/aws-ops/.claude/worktrees/review-aws-ops-8491", isGit: true }],
      briefPaths: [],
    }];
    h.existsSync.mockReturnValue(false);
    const p = await showAndWarm();
    const row = posts(p).find((m) => m.type === "deck:reviews").requests[0];
    expect(row.runKey).toBe("review-aws-ops-8491");
    expect(row.draftPath).toBeNull();
  });

  it("posts the draft body when asked to load it", async () => {
    h.runs = [{
      key: "review-aws-ops-8491", summary: "Review", url: "https://gh/pr/8491", createdAt: 1, kind: "review",
      mode: "per-window", repos: [{ name: "aws-ops", path: "/wt", isGit: true }], briefPaths: [],
    }];
    h.existsSync.mockReturnValue(true);
    h.readFileSync.mockReturnValue("1. The retry budget is unbounded.");
    const p = await showAndWarm();
    await p._fire({ type: "deck:reviewLoadDraft", id: "CyberJackGit/aws-ops#8491" });
    expect(posts(p).at(-1)).toMatchObject({
      type: "deck:reviewDraft",
      id: "CyberJackGit/aws-ops#8491",
      body: "1. The retry budget is unbounded.",
    });
  });

  it("ignores a load-draft request for an id that is not in the queue", async () => {
    const p = await showAndWarm();
    const before = posts(p).length;
    await p._fire({ type: "deck:reviewLoadDraft", id: "who/what#1" });
    expect(posts(p)).toHaveLength(before);
    expect(h.readFileSync).not.toHaveBeenCalled();
  });

  it("toasts when the draft file can't be read", async () => {
    h.runs = [{
      key: "review-aws-ops-8491", summary: "Review", url: "https://gh/pr/8491", createdAt: 1, kind: "review",
      mode: "per-window", repos: [{ name: "aws-ops", path: "/wt", isGit: true }], briefPaths: [],
    }];
    h.existsSync.mockReturnValue(true);
    h.readFileSync.mockImplementation(() => { throw new Error("EACCES"); });
    const p = await showAndWarm();
    await p._fire({ type: "deck:reviewLoadDraft", id: "CyberJackGit/aws-ops#8491" });
    expect(posts(p).some((m) => m.type === "deck:reviewDraft")).toBe(false);
    expect(posts(p).some((m) => m.type === "toast" && m.level === "error")).toBe(true);
  });

  // ── the batch ─────────────────────────────────────────────────────────────
  const ID_A = "CyberJackGit/aws-ops#8491";
  const ID_B = "CyberJackGit/aws-ops#9000";
  /** Two queued PRs of the same repo — the case that makes a shared brief path collide,
   *  and the only way to reach the layout question. */
  const twoQueued = () => {
    h.reviewCache = {
      fetchedAt: Date.now(),
      issueCount: 2,
      requests: [reviewFixture(), { ...reviewFixture(), id: ID_B, number: 9000, title: "drain the retry queue" }],
    };
  };
  const pickMode = (mode: unknown) => window.showQuickPick.mockResolvedValueOnce({ label: "m", mode });
  const pickLayout = (shared: boolean) => window.showQuickPick.mockResolvedValueOnce({ label: "l", shared });
  /** The batch asks the destination question with the same setting and the same pickers
   *  the single-row launch does (`agentFlow.reviewOpenIn`, engine/openTarget). Pinning
   *  it to this window is how a test reaches the shared-window path without a picker;
   *  the stock default is a new window, which for one PR is the ordinary single launch. */
  const HERE = { identity: "/repos/aws-ops", kind: "folder" as const, roots: [{ path: "/repos/aws-ops" }] };
  const shareThisWindow = () => { setConfig({ reviewOpenIn: "this-window" }); h.currentWindow = HERE; };
  const toastText = (p: ReturnType<typeof lastPanel>) =>
    posts(p).filter((m) => m.type === "toast").map((m) => m.message).join(" | ");
  const sharedReq = () =>
    h.openSharedWorkspace.mock.calls[0][0] as unknown as {
      tasks: { kind?: string; briefSubdir?: string; promptTemplate?: string; services: { path: string }[] }[];
      foldersToAdd?: unknown;
      target: { kind: string };
    };

  it("asks the cost, then the mode, then the destination — in that order", async () => {
    setConfig({ batchLaunchConfirmThreshold: 1, reviewOpenIn: "ask" });
    twoQueued();
    const p = await showAndWarm();
    window.showWarningMessage.mockResolvedValueOnce(undefined); // refused
    await p._fire({ type: "deck:reviewBatch", ids: [ID_A, ID_B] });
    expect(window.showWarningMessage).toHaveBeenCalled();
    // Nothing else was asked, and nothing was created.
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(createWorktrees).not.toHaveBeenCalled();
    expect(h.openSharedWorkspace).not.toHaveBeenCalled();
  });

  it("reports mode_was_pinned:true when the cost confirm is declined for a genuinely pinned mode", async () => {
    // resolveReviewMode(modes, cfg.reviewRequestMode) is a pure function of config —
    // whether it finds a pin has nothing to do with whether the cost-confirm dialog
    // even ran. A pinned mode declined here must still report true, not the "nothing
    // was resolved yet" false the mode/destination pickers' own dismissals report.
    setConfig({ batchLaunchConfirmThreshold: 1, reviewRequestMode: "full" });
    twoQueued();
    const p = await showAndWarm();
    window.showWarningMessage.mockResolvedValueOnce(undefined); // refused
    await p._fire({ type: "deck:reviewBatch", ids: [ID_A, ID_B] });
    const ev = trackSpy.mock.calls.flat().find((e: any) => e.name === "review_launched") as any;
    expect(ev).toMatchObject({ outcome: "cancelled", mode_was_pinned: true, batch: true, requested_count: 2 });
  });

  it("does not confirm a batch at or below the threshold", async () => {
    twoQueued();
    shareThisWindow();
    const p = await showAndWarm();
    pickMode(readOnlyReviewMode("github"));
    await p._fire({ type: "deck:reviewBatch", ids: [ID_A, ID_B] });
    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(h.openSharedWorkspace).toHaveBeenCalledTimes(1);
  });

  it("opens one shared workspace with a review-kinded task per PR", async () => {
    twoQueued();
    shareThisWindow();
    const p = await showAndWarm();
    pickMode(readOnlyReviewMode("github"));
    await p._fire({ type: "deck:reviewBatch", ids: [ID_A, ID_B] });
    expect(h.openSharedWorkspace).toHaveBeenCalledTimes(1);
    const req = sharedReq();
    expect(req.tasks).toHaveLength(2);
    expect(req.tasks.map((t) => t.kind)).toEqual(["review", "review"]);
    // Its own brief sub-directory each: both PRs are in ONE checkout here, so a shared
    // `.pick-task/TASK.md` would have let the second overwrite the first.
    expect(req.tasks.map((t) => t.briefSubdir)).toEqual(["REVIEW-8491", "REVIEW-9000"]);
    // Pre-rendered per PR: the shared template could not have carried these.
    expect(req.tasks[0].promptTemplate).toContain("8491");
    expect(req.tasks[1].promptTemplate).toContain("9000");
  });

  it("creates no worktree under the read-only mode, and reviews in the checkout itself", async () => {
    // A shared destination on purpose: one PR into a NEW window is the ordinary
    // single launch (launchReview owns its own worktree), and read-only's whole point
    // is worktrees saved *within* one window.
    shareThisWindow();
    const p = await showAndWarm();
    pickMode(readOnlyReviewMode("github"));
    await p._fire({ type: "deck:reviewBatch", ids: [ID_A] });
    expect(createWorktrees).not.toHaveBeenCalled();
    expect(sharedReq().tasks[0].services[0].path).toBe("/repos/aws-ops");
    expect(toastText(p)).toContain("without checking anything out");
  });

  it("creates one worktree per PR under a mode that checks out", async () => {
    twoQueued();
    shareThisWindow();
    vi.mocked(createWorktrees).mockImplementation((services: ServiceRef[], key: string) =>
      services.map((s) => ({ ...s, path: `${s.path}/.claude/worktrees/${key}` })),
    );
    const p = await showAndWarm();
    pickMode(DEFAULT_REVIEW_REQUEST_MODES[0]);
    await p._fire({ type: "deck:reviewBatch", ids: [ID_A, ID_B] });
    expect(createWorktrees).toHaveBeenCalledTimes(2);
    expect(sharedReq().tasks.map((t) => t.services[0].path)).toEqual([
      "/repos/aws-ops/.claude/worktrees/review-aws-ops-8491",
      "/repos/aws-ops/.claude/worktrees/review-aws-ops-9000",
    ]);
    expect(toastText(p)).toContain("in a worktree each");
  });

  it("drops a PR whose worktree could not be made rather than using the main checkout", async () => {
    // createWorktrees falls back to the checkout it was given; launchReview refuses
    // that, and a batch must not be laxer than a single launch — a `gh pr checkout`
    // there can cost work in progress.
    shareThisWindow();
    const p = await showAndWarm();
    vi.mocked(createWorktrees).mockImplementation((services: ServiceRef[]) => services);
    pickMode(DEFAULT_REVIEW_REQUEST_MODES[0]);
    await p._fire({ type: "deck:reviewBatch", ids: [ID_A] });
    expect(h.openSharedWorkspace).not.toHaveBeenCalled();
    // Not merely "a toast mentioning worktrees" — the refusal, and nothing launched.
    expect(h.launchReview).not.toHaveBeenCalled();
    expect(toastText(p)).toMatch(/Couldn't create a git worktree/i);
    // Every worktree in the batch failed, so this terminal must count as a real
    // failure — not a silent no-op the way a dismissed picker is.
    const ev = trackSpy.mock.calls.flat().find((e: any) => e.name === "review_launched") as any;
    expect(ev).toMatchObject({
      outcome: "failed", batch: true, requested_count: 1, launched_count: 0, failed_count: 1, skipped_count: 0,
    });
  });

  it("asks how to lay out a multi-PR new window, and separate windows goes one at a time", async () => {
    twoQueued();
    const p = await showAndWarm(); // stock reviewOpenIn: a new window, asked nothing
    pickMode(readOnlyReviewMode("github"));
    pickLayout(false);
    await p._fire({ type: "deck:reviewBatch", ids: [ID_A, ID_B] });
    // Separate windows IS the single-PR path, N times — worktree included.
    expect(h.launchReview).toHaveBeenCalledTimes(2);
    expect(h.openSharedWorkspace).not.toHaveBeenCalled();
  });

  it("emits review_launched with outcome cancelled when the layout picker is dismissed", async () => {
    twoQueued();
    const p = await showAndWarm(); // stock reviewOpenIn: a new window, asked nothing
    pickMode(readOnlyReviewMode("github"));
    window.showQuickPick.mockResolvedValueOnce(undefined); // the layout picker
    await p._fire({ type: "deck:reviewBatch", ids: [ID_A, ID_B] });
    expect(h.launchReview).not.toHaveBeenCalled();
    expect(h.openSharedWorkspace).not.toHaveBeenCalled();
    const ev = trackSpy.mock.calls.flat().find((e: any) => e.name === "review_launched") as any;
    expect(ev).toMatchObject({
      outcome: "cancelled", batch: true, requested_count: 2, launched_count: 0, failed_count: 0, skipped_count: 0,
    });
  });

  it("asks no layout question when the destination is already one window", async () => {
    twoQueued();
    setConfig({ reviewOpenIn: "ask" });
    h.currentWindow = HERE;
    const p = await showAndWarm();
    pickMode(readOnlyReviewMode("github"));
    window.showQuickPick.mockResolvedValueOnce({ target: { kind: "current" } });
    await p._fire({ type: "deck:reviewBatch", ids: [ID_A, ID_B] });
    expect(window.showQuickPick).toHaveBeenCalledTimes(2); // mode, destination — no layout
    expect(sharedReq().target).toEqual({ kind: "current" });
  });

  it("opens nothing into a window that lost its identity between the pick and the launch", async () => {
    // Without an identity openSharedWorkspace falls through to a NEW window — one
    // nobody asked for. Fail before anything is opened instead.
    shareThisWindow();
    // The window goes away between the destination answer and the open — simulated at
    // the one step that sits between them, cutting the worktrees.
    vi.mocked(createWorktrees).mockImplementation((services: ServiceRef[], key: string) => {
      h.currentWindow = undefined;
      return services.map((s) => ({ ...s, path: `${s.path}/.claude/worktrees/${key}` }));
    });
    const p = await showAndWarm();
    pickMode(DEFAULT_REVIEW_REQUEST_MODES[0]);
    await p._fire({ type: "deck:reviewBatch", ids: [ID_A] });
    expect(h.openSharedWorkspace).not.toHaveBeenCalled();
    expect(toastText(p)).toMatch(/no longer hold a session/i);
    // Not a user gesture — the window vanished out from under the launch — so
    // "failed", not "cancelled", and the one ready item counts as failed too.
    const ev = trackSpy.mock.calls.flat().find((e: any) => e.name === "review_launched") as any;
    expect(ev).toMatchObject({
      outcome: "failed", batch: true, requested_count: 1, launched_count: 0, failed_count: 1, skipped_count: 0,
    });
  });

  it("emits review_launched with outcome cancelled when the agent picker is dismissed", async () => {
    // Read-only needs no worktree, so `ready` fills without touching createWorktrees
    // (reset to a bare `vi.fn()` between tests) — isolating this from the picker.
    shareThisWindow();
    h.agentProvider = "ask";
    const p = await showAndWarm();
    pickMode(readOnlyReviewMode("github"));
    window.showQuickPick.mockResolvedValueOnce(undefined); // "Which tool?"
    await p._fire({ type: "deck:reviewBatch", ids: [ID_A] });
    expect(h.openSharedWorkspace).not.toHaveBeenCalled();
    const ev = trackSpy.mock.calls.flat().find((e: any) => e.name === "review_launched") as any;
    expect(ev).toMatchObject({
      outcome: "cancelled", batch: true, requested_count: 1, launched_count: 0, failed_count: 0, skipped_count: 0,
    });
  });

  it("emits review_launched with outcome failed when opening the shared workspace throws", async () => {
    shareThisWindow();
    h.openSharedWorkspace.mockRejectedValueOnce(new Error("disk full"));
    const p = await showAndWarm();
    pickMode(readOnlyReviewMode("github"));
    await p._fire({ type: "deck:reviewBatch", ids: [ID_A] });
    expect(toastText(p)).toMatch(/Couldn't open the review workspace/i);
    const ev = trackSpy.mock.calls.flat().find((e: any) => e.name === "review_launched") as any;
    expect(ev).toMatchObject({
      outcome: "failed", batch: true, requested_count: 1, launched_count: 0, failed_count: 1, skipped_count: 0,
    });
  });

  it("treats one PR into a new window as the ordinary single launch", async () => {
    // No layout question, no shared workspace: launchReview is exactly this, and it
    // owns its own worktree and its own refusal to run without one.
    const p = await showAndWarm(); // stock reviewOpenIn: a new window, asked nothing
    pickMode(readOnlyReviewMode("github"));
    await p._fire({ type: "deck:reviewBatch", ids: [ID_A] });
    expect(window.showQuickPick).toHaveBeenCalledTimes(1); // the mode, and nothing else
    expect(h.launchReview).toHaveBeenCalledTimes(1);
    // And it hands the resolved destination down, exactly as a single launch does.
    expect((h.launchReview.mock.calls[0][0] as { openTarget?: unknown }).openTarget)
      .toEqual({ mode: "per-window", openIn: "new" });
    expect(h.openSharedWorkspace).not.toHaveBeenCalled();
    // And it says a worktree was made, because one WAS — launchReview always cuts one,
    // whatever the read-only mode would have preferred.
    expect(toastText(p)).toContain("in a worktree each");
  });

  it("says nothing and creates nothing when a picker is dismissed", async () => {
    const p = await showAndWarm();
    window.showQuickPick.mockResolvedValueOnce(undefined); // the mode
    await p._fire({ type: "deck:reviewBatch", ids: [ID_A] });
    expect(createWorktrees).not.toHaveBeenCalled();
    expect(h.openSharedWorkspace).not.toHaveBeenCalled();
    expect(posts(p).filter((m) => m.type === "toast")).toHaveLength(0);
  });

  it("emits review_launched with outcome cancelled when the queue moved on before every id in the batch", async () => {
    h.reviewCache = { fetchedAt: Date.now(), issueCount: 0, requests: [] };
    const p = await showAndWarm();
    await p._fire({ type: "deck:reviewBatch", ids: [ID_A, ID_B] });
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(h.openSharedWorkspace).not.toHaveBeenCalled();
    const ev = trackSpy.mock.calls.flat().find((e: any) => e.name === "review_launched") as any;
    expect(ev).toMatchObject({
      outcome: "cancelled", batch: true, requested_count: 0, launched_count: 0, failed_count: 0, skipped_count: 0,
    });
  });

  it("names an un-checked-out repo once, and reviews the rest", async () => {
    h.reviewCache = {
      fetchedAt: Date.now(),
      issueCount: 3,
      requests: [
        reviewFixture(),
        { ...reviewFixture(), id: "x/ext-svc#1", repo: "x/ext-svc", repoName: "ext-svc", number: 1 },
        { ...reviewFixture(), id: "x/ext-svc#2", repo: "x/ext-svc", repoName: "ext-svc", number: 2 },
      ],
    };
    shareThisWindow();
    const p = await showAndWarm();
    pickMode(readOnlyReviewMode("github"));
    await p._fire({ type: "deck:reviewBatch", ids: [ID_A, "x/ext-svc#1", "x/ext-svc#2"] });
    expect(sharedReq().tasks).toHaveLength(1);
    expect(toastText(p).match(/ext-svc/g)).toHaveLength(1);
  });

  it("emits ONE review_launched for a batch, with counts", async () => {
    h.reviewCache = {
      fetchedAt: Date.now(),
      issueCount: 3,
      requests: [
        reviewFixture(),
        { ...reviewFixture(), id: "x/ext-svc#1", repo: "x/ext-svc", repoName: "ext-svc", number: 1 },
        { ...reviewFixture(), id: "x/ext-svc#2", repo: "x/ext-svc", repoName: "ext-svc", number: 2 },
      ],
    };
    shareThisWindow();
    const p = await showAndWarm();
    pickMode(readOnlyReviewMode("github"));
    await p._fire({ type: "deck:reviewBatch", ids: [ID_A, "x/ext-svc#1", "x/ext-svc#2"] });
    const evs = trackSpy.mock.calls.flat().filter((e: any) => e.name === "review_launched");
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      batch: true, requested_count: 3, launched_count: 1, failed_count: 0, skipped_count: 1,
    });
  });

  it("reviews nothing, and says why once, when no selected repo is checked out", async () => {
    h.reviewCache = {
      fetchedAt: Date.now(),
      issueCount: 1,
      requests: [{ ...reviewFixture(), id: "x/ext-svc#1", repo: "x/ext-svc", repoName: "ext-svc", number: 1 }],
    };
    const p = await showAndWarm();
    pickMode(readOnlyReviewMode("github"));
    await p._fire({ type: "deck:reviewBatch", ids: ["x/ext-svc#1"] });
    expect(h.openSharedWorkspace).not.toHaveBeenCalled();
    expect(toastText(p)).toContain("ext-svc");
    // Asked the mode, then stopped: no destination question for a batch with nothing in it.
    expect(window.showQuickPick).toHaveBeenCalledTimes(1);
    // Every request was skipped for want of a checkout — a real failure, not a
    // no-op: nothing was ever going to launch out of this batch.
    const ev = trackSpy.mock.calls.flat().find((e: any) => e.name === "review_launched") as any;
    expect(ev).toMatchObject({
      outcome: "failed", batch: true, requested_count: 1, launched_count: 0, failed_count: 0, skipped_count: 1,
    });
  });

  it("never edits an existing workspace file", async () => {
    // A review batch passes no foldersToAdd, so mergeReposIntoWorkspace finds nothing
    // missing and returns without writing — the user's artifact stays byte-identical.
    setConfig({ reviewOpenIn: "pick-existing" });
    const p = await showAndWarm();
    pickMode(readOnlyReviewMode("github"));
    // listWorkspaceFiles is stubbed empty, so the only row is Browse…
    window.showQuickPick.mockImplementationOnce(async (items: unknown) => (items as unknown[])[0]);
    window.showOpenDialog.mockResolvedValueOnce([{ fsPath: "/ws/team.code-workspace" }]);
    await p._fire({ type: "deck:reviewBatch", ids: [ID_A] });
    expect(sharedReq().target).toEqual({ kind: "existing", file: "/ws/team.code-workspace" });
    expect(sharedReq().foldersToAdd).toBeUndefined();
  });

  it("does nothing at all when the queue moved on before the click landed", async () => {
    const p = await showAndWarm();
    await p._fire({ type: "deck:reviewBatch", ids: ["gone/repo#1"] });
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(posts(p).filter((m) => m.type === "toast")).toHaveLength(0);
  });
});

describe("DeckPanel review submit", () => {
  const submitMsg = (over: Partial<{ id: string; verb: ReviewVerb; body: string; fromDraft: boolean }> = {}) =>
    ({ type: "deck:reviewSubmit" as const, id: "CyberJackGit/aws-ops#8491", verb: "approve" as ReviewVerb, body: "", fromDraft: false, ...over });

  it("refuses to submit while reviewWrites is off, without asking or spawning", async () => {
    h.reviewWrites = false;
    const p = await showAndWarm();
    await p._fire(submitMsg());
    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(h.reviewSubmit).not.toHaveBeenCalled();
  });

  // Fix round 2: this gate (and the invalid-verb and row-missing gates below) used
  // to return silently, which left the webview's row disabled forever — nothing else
  // was ever going to arrive to release it (the toast/deck:reviews release the
  // coordinator's round-1 fix removed on purpose). "cancelled" is honest here: no
  // write was ever attempted, so there is nothing to warn about, only a disable to lift.
  it("posts deck:reviewSubmitDone(cancelled) when reviewWrites is off", async () => {
    h.reviewWrites = false;
    const p = await showAndWarm();
    await p._fire(submitMsg());
    expect(posts(p)).toContainEqual({
      type: "deck:reviewSubmitDone", id: "CyberJackGit/aws-ops#8491", outcome: "cancelled",
    });
  });

  // An invalid verb must be withheld from `review_submitted` even on an exit that
  // runs BEFORE the dedicated `Object.hasOwn` guard — verb validity is checked once,
  // up front, rather than relying on this gate happening to run first.
  it("emits no review_submitted for an out-of-union verb even when reviewWrites is off", async () => {
    h.reviewWrites = false;
    const p = await showAndWarm();
    await p._fire(submitMsg({ verb: "merge" as unknown as ReviewVerb }));
    expect(trackSpy.mock.calls.flat().find((e: any) => e.name === "review_submitted")).toBeUndefined();
  });

  it("asks for confirmation naming the verb, repo and number", async () => {
    h.reviewWrites = true;
    const p = await showAndWarm();
    await p._fire(submitMsg({ verb: "request-changes" }));
    expect(window.showWarningMessage).toHaveBeenCalledWith(
      "Request changes on CyberJackGit/aws-ops#8491?",
      { modal: true },
      "Request changes",
    );
  });

  // Task 10: GitLab has no stable "request changes" verb, so ours degrades to a
  // comment plus withdrawing any standing approval — gated on
  // `this.caps().changesRequested` (Task 7: preferring a resolved value over the
  // static record when a forge has one), the one capability that differs by
  // forge. The person clicking deserves to know before they click, not after.
  it("discloses GitLab's request-changes semantics in the confirmation modal", async () => {
    setConfig({ forge: "gitlab" });
    h.reviewWrites = true;
    // Fresh on disk, so `reviewsEnabled()`'s cache-first path never has to reach
    // the real (unmocked) `GlabReviewProvider.search()` for this test to see the
    // queued row — see "posts the cached queue on deck:ready…" above for the
    // same reasoning.
    h.reviewCache = { fetchedAt: Date.now(), issueCount: 1, requests: [reviewFixture()] };
    const p = await showAndWarm();
    await p._fire(submitMsg({ verb: "request-changes" }));
    expect(window.showWarningMessage).toHaveBeenCalledWith(
      "Request changes on CyberJackGit/aws-ops#8491?",
      { modal: true, detail: expect.stringContaining('GitLab has no "request changes" review') },
      "Request changes",
    );
  });

  // The Bitbucket half of the same disclosure, unit-tested directly because the
  // review strip is hidden on Bitbucket (`caps.reviewSearch` is false in both
  // modes), so the modal above cannot be reached through a panel there today —
  // and the wording must still be right the day it can. GitLab DEGRADES; a
  // projected atlassian-cli REFUSES, before it builds a single argv. Telling a
  // Bitbucket user we would post their message as a comment describes a write
  // that never happens.
  describe("noChangesRequestedDetail", () => {
    it("does not promise Bitbucket a mechanism its projected mode refuses outright", () => {
      const detail = noChangesRequestedDetail({ id: "bitbucket", label: "Bitbucket" });
      expect(detail).not.toContain("posts your message as a comment");
      expect(detail).not.toContain("withdraws your approval");
      expect(detail).toContain("refused");
      // Names the way out, the same way the provider's own refusal does.
      expect(detail).toContain("bb api");
    });

    it("keeps GitLab's degradation wording, which its provider really performs", () => {
      expect(noChangesRequestedDetail({ id: "gitlab", label: "GitLab" }))
        .toBe('GitLab has no "request changes" review, so this posts your message as a comment ' +
          "and withdraws your approval if you had one.");
    });

    it("gives an unregistered forge the generic wording rather than another forge's", () => {
      // `Object.hasOwn`, not a bare index: `constructor` must not resolve to a
      // truthy non-string and be shown to a user as a confirmation detail.
      for (const id of ["not-a-forge", "constructor", "__proto__"]) {
        expect(noChangesRequestedDetail({ id, label: "Gitea" })).toContain('Gitea has no "request changes" review');
      }
    });
  });

  // The other side of that disclosure: `approve` and `comment` mean exactly what
  // they say on GitLab, so a `detail` line there would be noise on the two verbs
  // people use most — and a modal that always explains something teaches the
  // reader to click through it, which is precisely how the request-changes
  // disclosure stops being read.
  it.each(["approve", "comment"] as const)("adds no disclosure for %s on gitlab", async (verb) => {
    setConfig({ forge: "gitlab" });
    h.reviewWrites = true;
    h.reviewCache = { fetchedAt: Date.now(), issueCount: 1, requests: [reviewFixture()] };
    const p = await showAndWarm();
    await p._fire(submitMsg({ verb, body: "lgtm" }));
    expect(window.showWarningMessage).toHaveBeenCalledWith(
      expect.any(String),
      { modal: true },
      expect.any(String),
    );
  });

  it("spawns nothing when the confirmation is declined", async () => {
    h.reviewWrites = true;
    (window.showWarningMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    const p = await showAndWarm();
    await p._fire(submitMsg());
    expect(h.reviewSubmit).not.toHaveBeenCalled();
  });

  // The webview's disable-until-outcome relies on this exact message, at exactly
  // these three exits — nothing else in the outbound protocol carries this id
  // alongside a definite "it's over" signal (a toast doesn't carry an id at all,
  // and deck:reviews posts on an unrelated 6s timer as well as on this outcome).
  it("posts deck:reviewSubmitDone(cancelled) when the confirmation is declined", async () => {
    h.reviewWrites = true;
    (window.showWarningMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    const p = await showAndWarm();
    await p._fire(submitMsg());
    expect(posts(p)).toContainEqual({
      type: "deck:reviewSubmitDone", id: "CyberJackGit/aws-ops#8491", outcome: "cancelled",
    });
  });

  it("submits and toasts on success", async () => {
    h.reviewWrites = true;
    const p = await showAndWarm();
    await p._fire(submitMsg({ verb: "approve", body: "lgtm" }));
    expect(h.reviewSubmit).toHaveBeenCalledWith("CyberJackGit/aws-ops", 8491, "approve", "lgtm");
    expect(posts(p).some((m) => m.type === "toast" && m.level === "success")).toBe(true);
  });

  it("posts deck:reviewSubmitDone(ok) on a successful submit", async () => {
    h.reviewWrites = true;
    const p = await showAndWarm();
    await p._fire(submitMsg({ verb: "approve", body: "lgtm" }));
    expect(posts(p)).toContainEqual({
      type: "deck:reviewSubmitDone", id: "CyberJackGit/aws-ops#8491", outcome: "ok",
    });
  });

  it("emits review_submitted mirroring deck:reviewSubmitDone and never the body", async () => {
    h.reviewWrites = true;
    const p = await showAndWarm();
    await p._fire(submitMsg({ verb: "approve", body: "SECRET-BODY", fromDraft: true }));
    expect(trackSpy.mock.calls.flat().find((e: any) => e.name === "review_submitted")).toMatchObject({
      verb: "approve", from_draft: true, outcome: "ok",
    });
    expect(JSON.stringify(trackSpy.mock.calls.flat())).not.toContain("SECRET-BODY");
  });

  it("appends the provenance line to an agent-drafted body", async () => {
    h.reviewWrites = true;
    h.stampLabelOnWrite = true;
    const p = await showAndWarm();
    await p._fire(submitMsg({ verb: "comment", body: "the retry budget is unbounded", fromDraft: true }));
    expect(h.reviewSubmit.mock.calls[0][3]).toBe(
      "the retry budget is unbounded\n\n_Drafted with Claude Code via Agent Flow Deck._",
    );
  });

  it("names Copilot in the provenance line when Copilot is configured", async () => {
    h.reviewWrites = true;
    h.stampLabelOnWrite = true;
    h.agentProvider = "copilot";
    const p = await showAndWarm();
    await p._fire(submitMsg({ verb: "comment", body: "the retry budget is unbounded", fromDraft: true }));
    expect(h.reviewSubmit.mock.calls[0][3]).toBe(
      "the retry budget is unbounded\n\n_Drafted with Copilot via Agent Flow Deck._",
    );
  });

  it("leaves a hand-typed body alone", async () => {
    h.reviewWrites = true;
    h.stampLabelOnWrite = true;
    const p = await showAndWarm();
    await p._fire(submitMsg({ verb: "comment", body: "mine, all mine", fromDraft: false }));
    expect(h.reviewSubmit.mock.calls[0][3]).toBe("mine, all mine");
  });

  it("omits provenance when stamping is off", async () => {
    h.reviewWrites = true;
    h.stampLabelOnWrite = false;
    const p = await showAndWarm();
    await p._fire(submitMsg({ verb: "comment", body: "b", fromDraft: true }));
    expect(h.reviewSubmit.mock.calls[0][3]).toBe("b");
  });

  it("toasts GitHub's message with an Open PR action on rejection", async () => {
    h.reviewWrites = true;
    h.reviewSubmit.mockResolvedValueOnce({ ok: false, message: "Can not approve your own pull request" });
    const p = await showAndWarm();
    await p._fire(submitMsg());
    const toast = posts(p).find((m) => m.type === "toast" && m.level === "error");
    expect(toast.message).toContain("Can not approve your own pull request");
    expect(toast.action).toEqual({ label: "Open PR", url: "https://github.com/CyberJackGit/aws-ops/pull/8491" });
  });

  it("posts deck:reviewSubmitDone(failed) when the provider rejects the write", async () => {
    h.reviewWrites = true;
    h.reviewSubmit.mockResolvedValueOnce({ ok: false, message: "Can not approve your own pull request" });
    const p = await showAndWarm();
    await p._fire(submitMsg());
    expect(posts(p)).toContainEqual({
      type: "deck:reviewSubmitDone", id: "CyberJackGit/aws-ops#8491", outcome: "failed",
    });
  });

  // Beyond the brief's own list — the fourth of the gates now in submitReview
  // ("the row must still be in the queue") has no case above; every other write-ish
  // message in this file (reviewExpand, reviewLaunch, reviewLoadDraft) pins this
  // symmetrically, and the confirm gate is the one place a stale id must never even
  // reach a dialog, let alone the provider.
  it("ignores a submit for an id that is not in the queue", async () => {
    h.reviewWrites = true;
    const p = await showAndWarm();
    await p._fire(submitMsg({ id: "who/what#1" }));
    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(h.reviewSubmit).not.toHaveBeenCalled();
  });

  // Fix round 2: the row can be evicted (another submit's success, or a fresh
  // search) between the click landing in the webview and this call running —
  // without this post, that row's buttons stay disabled until the panel reloads.
  it("posts deck:reviewSubmitDone(cancelled) for an id that is not in the queue", async () => {
    h.reviewWrites = true;
    const p = await showAndWarm();
    await p._fire(submitMsg({ id: "who/what#1" }));
    expect(posts(p)).toContainEqual({
      type: "deck:reviewSubmitDone", id: "who/what#1", outcome: "cancelled",
    });
  });

  // --- Fix round 1: gate 0 — a verb outside the ReviewVerb union must fail closed
  // before any dialog, mirroring provider.ts's own Object.hasOwn guard on the same
  // value. "constructor" specifically exercises the prototype-pollution case a
  // plain `!VERB_LABEL[verb]` check would let through as truthy.
  //
  // --- Fix round 2: the invalid verb must not have marked the id as in flight.
  // The code is correct today only because the verb gate runs *before*
  // `reviewSubmitsInFlight.add(id)` — a refactor that moved the `add` above the
  // verb check would permanently lock this id out of every future submit for the
  // rest of the session, and every other test in this file would stay green.
  // Firing a valid `comment` for the same id right after and asserting the
  // provider *is* reached this time is what pins the ordering.
  it.each(["merge", "constructor"])(
    "refuses an out-of-union verb (%s) before any dialog or provider call, and does not lock the id out of a later valid submit",
    async (verb) => {
      h.reviewWrites = true;
      const p = await showAndWarm();
      await p._fire(submitMsg({ verb: verb as unknown as ReviewVerb }));
      expect(window.showWarningMessage).not.toHaveBeenCalled();
      expect(h.reviewSubmit).not.toHaveBeenCalled();
      await p._fire(submitMsg({ verb: "comment", body: "now a real one" }));
      expect(h.reviewSubmit).toHaveBeenCalledWith("CyberJackGit/aws-ops", 8491, "comment", "now a real one");
    },
  );

  // Fix round 2: same reasoning as the reviewWrites-off and row-missing gates above —
  // an out-of-union verb (a malformed webview message) must still release the row
  // it named, not strand it.
  it("posts deck:reviewSubmitDone(cancelled) for an out-of-union verb", async () => {
    h.reviewWrites = true;
    const p = await showAndWarm();
    await p._fire(submitMsg({ verb: "merge" as unknown as ReviewVerb }));
    expect(posts(p)).toContainEqual({
      type: "deck:reviewSubmitDone", id: "CyberJackGit/aws-ops#8491", outcome: "cancelled",
    });
  });

  // An invalid verb must never ride a `review_submitted` event at all — not even
  // the value the gate itself is rejecting. The webview reply above still posts,
  // unaffected; only the telemetry emit is withheld.
  it("emits no review_submitted for an out-of-union verb", async () => {
    h.reviewWrites = true;
    const p = await showAndWarm();
    await p._fire(submitMsg({ verb: "merge" as unknown as ReviewVerb }));
    expect(trackSpy.mock.calls.flat().find((e: any) => e.name === "review_submitted")).toBeUndefined();
  });

  // --- Fix round 1: a double click (or any second deck:reviewSubmit for the same
  // id while the first is still awaiting confirmation/gh) must not reach the
  // provider twice — GitHub does not deduplicate reviews. Two `_fire` calls with
  // neither awaited yet is this file's established pattern for overlapping async
  // work (see "posts one busy pair for overlapping refreshes" above): the first
  // call's synchronous prefix — every gate up through marking the id in flight —
  // completes before the second call is even made, so the second sees the flag set.
  it("refuses a second submit for the same id while the first is still in flight", async () => {
    h.reviewWrites = true;
    const p = await showAndWarm();
    const first = p._fire(submitMsg());
    const second = p._fire(submitMsg());
    await Promise.all([first, second]);
    expect(window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(h.reviewSubmit).toHaveBeenCalledTimes(1);
  });

  // Fix round 2: unlike the three gates above, the already-in-flight gate must
  // stay silent. The genuine call for this id is still running and will post
  // its own outcome; a "cancelled" from the rejected duplicate would release the
  // webview's disable while that real submit is still in the air — re-enabling
  // the buttons mid-write, the opposite of what the guard is for. Exactly one
  // deck:reviewSubmitDone must land, and it must be the real call's.
  it("posts no deck:reviewSubmitDone from a rejected duplicate — only the real submit's own outcome lands", async () => {
    h.reviewWrites = true;
    const p = await showAndWarm();
    const first = p._fire(submitMsg());
    const second = p._fire(submitMsg());
    await Promise.all([first, second]);
    const dones = posts(p).filter((m) => m.type === "deck:reviewSubmitDone");
    expect(dones).toHaveLength(1);
    expect(dones[0]).toEqual({ type: "deck:reviewSubmitDone", id: "CyberJackGit/aws-ops#8491", outcome: "ok" });
  });

  it("allows submitting the same id again once the previous submit has finished", async () => {
    // Verb "comment", deliberately: approve/request-changes evict the row on
    // success, and a second submit for an evicted id would legitimately stop at
    // gate 2 (not in the queue) regardless of the in-flight flag — that would
    // confound this test with eviction behaviour rather than isolating whether
    // the flag itself is cleared in the `finally`.
    h.reviewWrites = true;
    const p = await showAndWarm();
    await p._fire(submitMsg({ verb: "comment", body: "first" }));
    await p._fire(submitMsg({ verb: "comment", body: "second" }));
    expect(h.reviewSubmit).toHaveBeenCalledTimes(2);
  });

  // --- Fix round 1: reviewWrites must be read fresh on every submit, not cached at
  // construction the way `this.prFacts` is (the single most plausible copy-paste
  // mistake in this file, per the coordinator). Both directions: flipping the
  // setting after the panel is already open and warmed must take effect on the
  // very next submit.
  it("reads reviewWrites fresh at submit time — turning it on after the panel opened still lets a submit through", async () => {
    h.reviewWrites = false;
    const p = await showAndWarm();
    h.reviewWrites = true;
    await p._fire(submitMsg());
    expect(h.reviewSubmit).toHaveBeenCalledWith("CyberJackGit/aws-ops", 8491, "approve", "");
  });

  it("reads reviewWrites fresh at submit time — turning it off after the panel opened still refuses", async () => {
    h.reviewWrites = true;
    const p = await showAndWarm();
    h.reviewWrites = false;
    await p._fire(submitMsg());
    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(h.reviewSubmit).not.toHaveBeenCalled();
  });

  // --- Fix round 1: the eviction-on-success side effect, split per verb. A comment
  // does not clear GitHub's requested_reviewers, so — unlike approve and
  // request-changes — it must not make a PR you still owe vanish from the strip.
  it("evicts the row and decrements issueCount after a successful approve", async () => {
    h.reviewWrites = true;
    const p = await showAndWarm();
    await p._fire(submitMsg({ verb: "approve" }));
    const last = posts(p).filter((m) => m.type === "deck:reviews").at(-1);
    expect(last.requests).toHaveLength(0);
    expect(last.issueCount).toBe(0);
  });

  it("evicts the row and decrements issueCount after a successful request-changes", async () => {
    h.reviewWrites = true;
    const p = await showAndWarm();
    await p._fire(submitMsg({ verb: "request-changes", body: "please address the retry budget" }));
    const last = posts(p).filter((m) => m.type === "deck:reviews").at(-1);
    expect(last.requests).toHaveLength(0);
    expect(last.issueCount).toBe(0);
  });

  it("keeps the row and issueCount after a successful comment — a comment does not clear requested_reviewers", async () => {
    h.reviewWrites = true;
    const p = await showAndWarm();
    await p._fire(submitMsg({ verb: "comment", body: "nice work" }));
    const last = posts(p).filter((m) => m.type === "deck:reviews").at(-1);
    expect(last.requests).toHaveLength(1);
    expect(last.requests[0].id).toBe("CyberJackGit/aws-ops#8491");
    expect(last.issueCount).toBe(1);
  });

  it("persists the evicted cache to disk, so a reopened Deck can't resurrect the row from a stale file", async () => {
    h.reviewWrites = true;
    const p = await showAndWarm();
    await p._fire(submitMsg({ verb: "approve" }));
    const lastWrite = h.writeReviewCache.mock.calls.at(-1)?.[1] as { requests: unknown[]; issueCount: number };
    expect(lastWrite.requests).toHaveLength(0);
    expect(lastWrite.issueCount).toBe(0);
  });

  // --- Fix round 1: four assertions for behaviour that was already correct but
  // unpinned — each survives its own mutation today.
  it("declines when the dialog resolves a truthy value that is not the expected label", async () => {
    // Pins comparison against the exact label (`answer !== label`), not mere
    // truthiness (`!answer`) — a wrong-but-truthy answer must still decline.
    h.reviewWrites = true;
    (window.showWarningMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Comment");
    const p = await showAndWarm();
    await p._fire(submitMsg({ verb: "approve" }));
    expect(h.reviewSubmit).not.toHaveBeenCalled();
  });

  it("does not stamp a whitespace-only approve body — the guard checks body.trim(), not body's own truthiness", async () => {
    // A non-empty-but-all-whitespace body is truthy on its own; only `.trim()`
    // reveals it is empty. Pins that the provenance line is never appended to
    // nothing, and that the untrimmed body passes through unchanged on this branch.
    h.reviewWrites = true;
    h.stampLabelOnWrite = true;
    const p = await showAndWarm();
    await p._fire(submitMsg({ verb: "approve", body: "   ", fromDraft: true }));
    expect(h.reviewSubmit.mock.calls[0][3]).toBe("   ");
  });

  it("logs the write attempt before it reaches the provider — the audit trail", async () => {
    // Mirrors this file's existing log-spy precedent ("logs which gh it tried...",
    // "posts nothing and logs when the detail fetch fails"): a custom log passed
    // straight into DeckPanel.show, rather than the show() helper's () => {}.
    h.reviewWrites = true;
    const log = vi.fn();
    DeckPanel.show(fakeContext().context as any, fakeConnector(false), log);
    await settled();
    const p = lastPanel();
    await p._fire({ type: "deck:refresh" });
    await settled();
    await p._fire(submitMsg({ verb: "approve" }));
    expect(log).toHaveBeenCalledWith("deck: submitting approve on CyberJackGit/aws-ops#8491");
  });

  it("keeps the row in the queue after a failed submit, so the user can still act on it", async () => {
    h.reviewWrites = true;
    h.reviewSubmit.mockResolvedValueOnce({ ok: false, message: "Can not approve your own pull request" });
    const p = await showAndWarm();
    await p._fire(submitMsg());
    // If a failed submit had evicted the row anyway, reviewById would find nothing
    // and reviewDetail would never reach the provider — this is the same "still
    // resolvable" check the DeckPanel review detail suite uses elsewhere.
    await p._fire({ type: "deck:reviewExpand", id: "CyberJackGit/aws-ops#8491" });
    await settled(); // row expansion is queued (Task 5), not awaited directly
    expect(h.reviewDetail).toHaveBeenCalledWith("CyberJackGit/aws-ops", 8491);
  });

  // Task 3 (blocking): `post()` used to call `postMessage` with no guard, and the
  // real VS Code webview API throws synchronously once the panel is disposed.
  // Closing the Deck mid-submit used to let that throw land right between the
  // success toast and the cache eviction below it — so a write that actually
  // succeeded never evicted its row, and reopening the Deck showed the just-
  // approved PR as still owed.
  it("still evicts and persists a successful submit's row even if the panel is disposed and postMessage throws", async () => {
    h.reviewWrites = true;
    const p = await showAndWarm();
    p.webview.postMessage.mockImplementation(() => { throw new Error("Webview is disposed"); });
    await p._fire(submitMsg({ verb: "approve" }));
    const lastWrite = h.writeReviewCache.mock.calls.at(-1)?.[1] as { requests: unknown[]; issueCount: number };
    expect(lastWrite.requests).toHaveLength(0);
    expect(lastWrite.issueCount).toBe(0);
  });

  // Task 3 (blocking), second fix: even with `post()` itself guarded, anything
  // else that throws after the in-flight guard was set (writeReviewCache here)
  // must not strand the row — nothing else was ever going to post a
  // deck:reviewSubmitDone to release the webview's disable.
  it("posts a failed outcome and releases the in-flight guard when something throws after the write succeeded", async () => {
    h.reviewWrites = true;
    const p = await showAndWarm();
    // showAndWarm's own search success already calls writeReviewCache once —
    // clear that call first so `mockImplementationOnce` below throws on the
    // submit's own eviction write, not on that unrelated earlier one.
    h.writeReviewCache.mockClear();
    h.writeReviewCache.mockImplementationOnce(() => { throw new Error("disk full"); });
    await p._fire(submitMsg({ verb: "approve" }));
    expect(posts(p)).toContainEqual({
      type: "deck:reviewSubmitDone", id: "CyberJackGit/aws-ops#8491", outcome: "failed",
    });
    // The `finally` still ran despite the throw: a second submit for the same id
    // reaches the "no longer in the queue" gate (the row really was evicted in
    // memory before the write threw) rather than being silently swallowed by a
    // guard that never released.
    const before = posts(p).filter((m) => m.type === "deck:reviewSubmitDone").length;
    await p._fire(submitMsg({ verb: "comment", body: "x" }));
    const dones = posts(p).filter((m) => m.type === "deck:reviewSubmitDone");
    expect(dones.length).toBe(before + 1);
    expect(dones.at(-1)).toEqual({ type: "deck:reviewSubmitDone", id: "CyberJackGit/aws-ops#8491", outcome: "cancelled" });
  });
});

describe("deck:mergePr", () => {
  /** A run with one repo whose PR is green by every clause mergeTarget checks. */
  const greenFacts = (): PrFacts => ({
    number: 124, url: "https://github.com/o/svc/pull/124", title: "t", state: "OPEN",
    isDraft: false, ci: { passing: 6, pending: 0, failing: [] }, review: "approved",
    unresolved: 0, mergeable: "clean", ciAdvisory: false,
  });

  /** One tracked run — `mkRun()`'s PROJ-1, whose single repo `svc` is checked out at
   * /r/svc — with `facts` cached against it. `readPrEntries` is mocked to ignore its
   * arguments and hand back `h.prEntries`, so seeding the store IS assigning that
   * field; there is no temp directory in this suite.
   *
   * `show()` rather than `showAndWarm()`: mergePr never consults the gh probe (its
   * facts come from the store, not a fetch), so the extra warmed tick would only add
   * runtime to every case here. */
  const openWith = async (facts: PrFacts | null): Promise<ReturnType<typeof lastPanel>> => {
    h.runs = [mkRun()];
    h.prEntries = facts ? { svc: { facts, fetchedAt: Date.now() } } : {};
    show();
    await settled();
    return lastPanel();
  };

  it("does nothing when mergeWrites is off, however green the PR", async () => {
    h.mergeWrites = false;
    const p = await openWith(greenFacts());
    await p._fire({ type: "deck:mergePr", key: "PROJ-1", repo: "svc", number: 124 });
    expect(h.prMerge).not.toHaveBeenCalled();
    expect(window.showWarningMessage).not.toHaveBeenCalled();
  });

  it("does nothing for a key with no run record", async () => {
    h.mergeWrites = true;
    const p = await openWith(greenFacts());
    await p._fire({ type: "deck:mergePr", key: "NOPE-9", repo: "svc", number: 124 });
    expect(h.prMerge).not.toHaveBeenCalled();
  });

  it("does nothing for a local card, whose ticket is only inferred from a branch name", async () => {
    // Same guard, same reason, as seedPrWork's: a local card's key came from a
    // branch that may name someone else's ticket. Merging off that inference on
    // one click is what this must never do — and the host enforces it rather
    // than trusting the webview's own local check.
    //
    // The session's cwd is /r/svc on purpose, so the local card's one repo is
    // `svc` at /r/svc — exactly the checkout the green facts below name. Every
    // later gate therefore PASSES for this message, which is what makes the test
    // fail if the local guard is removed rather than being caught downstream by a
    // checkout lookup that happens not to resolve.
    h.mergeWrites = true;
    h.runs = [];
    h.openSessions = [sess({ cwd: "/r/svc", name: "svc-7e" })];
    h.prEntries = { svc: { facts: greenFacts(), fetchedAt: Date.now() } };
    show();
    await settled();
    const localKey = builtLocal().run.key;
    const p = lastPanel();
    await p._fire({ type: "deck:mergePr", key: localKey, repo: "svc", number: 124 });
    expect(h.prMerge).not.toHaveBeenCalled();
    expect(window.showWarningMessage).not.toHaveBeenCalled();
  });

  it("refuses when its own re-check disagrees with the message", async () => {
    // The webview is a renderer, never the authority for a write. Facts on disk
    // say review_required; a hand-crafted (or merely stale) message says merge.
    h.mergeWrites = true;
    const p = await openWith({ ...greenFacts(), review: "review_required" });
    await p._fire({ type: "deck:mergePr", key: "PROJ-1", repo: "svc", number: 124 });
    expect(h.prMerge).not.toHaveBeenCalled();
    expect(window.showWarningMessage).not.toHaveBeenCalled();
  });

  it("refuses when the message names a different repo or number than the re-check found", async () => {
    h.mergeWrites = true;
    const p = await openWith(greenFacts());
    await p._fire({ type: "deck:mergePr", key: "PROJ-1", repo: "svc", number: 999 });
    expect(h.prMerge).not.toHaveBeenCalled();
    expect(window.showWarningMessage).not.toHaveBeenCalled();
  });

  // Beyond the brief's own list: the fourth gate — the target repo has to be one of
  // THIS run's checkouts, since `merge` is spawned in that directory. A run whose
  // PR store names a repo it does not have checked out is the shape a renamed or
  // re-scoped run leaves behind, and there is nowhere to run `gh` for it.
  it("refuses when the run has no checkout for the repo its own re-check named", async () => {
    h.mergeWrites = true;
    h.runs = [mkRun({ repos: [{ name: "other", path: "/r/other", isGit: true, branch: "b" }] })];
    h.prEntries = { svc: { facts: greenFacts(), fetchedAt: Date.now() } };
    show();
    await settled();
    await lastPanel()._fire({ type: "deck:mergePr", key: "PROJ-1", repo: "svc", number: 124 });
    expect(h.prMerge).not.toHaveBeenCalled();
    expect(window.showWarningMessage).not.toHaveBeenCalled();
  });

  // Every gate above refuses the message and has to release the card's Merge
  // button as well, because the webview sets its `merging` flag before sending and
  // clears it only on a `deck:mergeDone` — a `deck:runs` post does not clear it, so
  // a silent return would strand that button disabled until the panel is reloaded.
  // Split one test per gate, the way the review-submit block splits its own: the
  // gates are independently removable, and one combined case would let four of them
  // regress silently behind the fifth.
  const CANCELLED = (over: { key?: string; number?: number } = {}) =>
    ({ type: "deck:mergeDone", key: "PROJ-1", repo: "svc", number: 124, outcome: "cancelled", ...over });

  it("releases the button when mergeWrites is off", async () => {
    h.mergeWrites = false;
    const p = await openWith(greenFacts());
    await p._fire({ type: "deck:mergePr", key: "PROJ-1", repo: "svc", number: 124 });
    expect(posts(p)).toContainEqual(CANCELLED());
  });

  it("releases the button when prFacts is off, however green the stored facts", async () => {
    // The store is only authoritative while `prFacts` is on — with it off the board
    // posts `prs: {}`, so no card renders a Merge button and no honest message can
    // arrive. A crafted one would otherwise merge off facts the board itself
    // declines to show, which is the whole reason the write re-gates what the render
    // gated.
    h.mergeWrites = true;
    h.prFacts = false;
    const p = await openWith(greenFacts());
    await p._fire({ type: "deck:mergePr", key: "PROJ-1", repo: "svc", number: 124 });
    expect(h.prMerge).not.toHaveBeenCalled();
    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(posts(p)).toContainEqual(CANCELLED());
  });

  it("releases the button for a key with no run record", async () => {
    h.mergeWrites = true;
    const p = await openWith(greenFacts());
    await p._fire({ type: "deck:mergePr", key: "NOPE-9", repo: "svc", number: 124 });
    expect(posts(p)).toContainEqual(CANCELLED({ key: "NOPE-9" }));
  });

  it("releases the button for a local card, and emits pr_merged refused/local", async () => {
    h.mergeWrites = true;
    h.runs = [];
    h.openSessions = [sess({ cwd: "/r/svc", name: "svc-7e" })];
    h.prEntries = { svc: { facts: greenFacts(), fetchedAt: Date.now() } };
    show();
    await settled();
    const localKey = builtLocal().run.key;
    const p = lastPanel();
    trackSpy.mockClear();
    await p._fire({ type: "deck:mergePr", key: localKey, repo: "svc", number: 124 });
    expect(posts(p)).toContainEqual(CANCELLED({ key: localKey }));
    expect(trackSpy.mock.calls.flat().find((e: any) => e.name === "pr_merged")).toMatchObject({
      outcome: "refused", refusal: "local",
    });
  });

  // The wrong-number shape rather than the unmergeable-facts one, though both reach
  // the same gate: it is the case that pins the outcome carrying the MESSAGE's own
  // number (999) rather than the re-checked target's (124). The webview keyed its
  // `merging` entry on what it sent, so only that triple clears it — a post built
  // from the target would look right in every other test and release nothing here.
  it("releases the button, on the message's own triple, when the re-check disagrees", async () => {
    h.mergeWrites = true;
    const p = await openWith(greenFacts());
    await p._fire({ type: "deck:mergePr", key: "PROJ-1", repo: "svc", number: 999 });
    expect(posts(p)).toContainEqual(CANCELLED({ number: 999 }));
  });

  it("releases the button when the run has no checkout for the target repo", async () => {
    h.mergeWrites = true;
    h.runs = [mkRun({ repos: [{ name: "other", path: "/r/other", isGit: true, branch: "b" }] })];
    h.prEntries = { svc: { facts: greenFacts(), fetchedAt: Date.now() } };
    show();
    await settled();
    const p = lastPanel();
    await p._fire({ type: "deck:mergePr", key: "PROJ-1", repo: "svc", number: 124 });
    expect(posts(p)).toContainEqual(CANCELLED());
  });

  it("names the repo, number and strategy in the confirmation, and merges on confirm", async () => {
    h.mergeWrites = true;
    h.mergeMethod = "squash";
    vi.mocked(window.showWarningMessage).mockResolvedValue("Squash and merge");
    const p = await openWith(greenFacts());
    await p._fire({ type: "deck:mergePr", key: "PROJ-1", repo: "svc", number: 124 });

    const [message, opts] = vi.mocked(window.showWarningMessage).mock.calls[0] as [string, unknown];
    expect(message).toContain("svc#124");
    expect(message).toContain("Squash and merge");
    expect(opts).toMatchObject({ modal: true });
    expect(h.prMerge).toHaveBeenCalledWith("/r/svc", 124, "squash");
  });

  // `Merge on svc#124?` read like a typo. Every label is already a verb phrase, so
  // the dialog drops the preposition and reads as a sentence for all three. Pinned
  // exactly, not by substring: this is the one string the user parses with a write
  // behind it, and a substring assertion would not have caught the old wording.
  it.each([
    ["squash", "Squash and merge", "Squash and merge svc#124?"],
    ["merge", "Merge", "Merge svc#124?"],
    ["rebase", "Rebase and merge", "Rebase and merge svc#124?"],
  ] as const)("asks about %s as a sentence, with no preposition", async (method, label, expected) => {
    h.mergeWrites = true;
    h.mergeMethod = method;
    vi.mocked(window.showWarningMessage).mockResolvedValue(label);
    const p = await openWith(greenFacts());
    await p._fire({ type: "deck:mergePr", key: "PROJ-1", repo: "svc", number: 124 });
    const [message] = vi.mocked(window.showWarningMessage).mock.calls[0] as [string, unknown];
    expect(message).toBe(expected);
    expect(h.prMerge).toHaveBeenCalledWith("/r/svc", 124, method);
  });

  it("passes the configured strategy through, not a hardcoded squash", async () => {
    h.mergeWrites = true;
    h.mergeMethod = "rebase";
    vi.mocked(window.showWarningMessage).mockResolvedValue("Rebase and merge");
    const p = await openWith(greenFacts());
    await p._fire({ type: "deck:mergePr", key: "PROJ-1", repo: "svc", number: 124 });
    expect(h.prMerge).toHaveBeenCalledWith("/r/svc", 124, "rebase");
  });

  it("does not merge when the confirmation is declined, and releases the button", async () => {
    h.mergeWrites = true;
    vi.mocked(window.showWarningMessage).mockResolvedValue(undefined);
    const p = await openWith(greenFacts());
    await p._fire({ type: "deck:mergePr", key: "PROJ-1", repo: "svc", number: 124 });
    expect(h.prMerge).not.toHaveBeenCalled();
    expect(posts(p)).toContainEqual(
      expect.objectContaining({ type: "deck:mergeDone", key: "PROJ-1", repo: "svc", number: 124, outcome: "cancelled" }),
    );
  });

  it("toasts the forge's own wording with an Open PR action on failure", async () => {
    h.mergeWrites = true;
    vi.mocked(window.showWarningMessage).mockResolvedValue("Squash and merge");
    h.prMerge.mockResolvedValue({ ok: false, message: "Pull request is not mergeable" });
    const p = await openWith(greenFacts());
    await p._fire({ type: "deck:mergePr", key: "PROJ-1", repo: "svc", number: 124 });
    expect(posts(p)).toContainEqual(
      expect.objectContaining({
        type: "toast", level: "error",
        message: expect.stringContaining("Pull request is not mergeable"),
        action: { label: "Open PR", url: "https://github.com/o/svc/pull/124" },
      }),
    );
    expect(posts(p)).toContainEqual(expect.objectContaining({ type: "deck:mergeDone", outcome: "failed" }));
  });

  it("stales the merged repo's cache entry on success, so the card stops offering a merged PR", async () => {
    // Without this the card keeps its Merge button for up to
    // prFactsTtlSeconds (default 120s) after the PR has merged.
    //
    // Asserted on the write rather than on a read back: `readPrEntries` is mocked
    // to ignore its arguments and return `h.prEntries`, so a re-read here would
    // only show the fixture this test seeded. One assertion covers both halves —
    // `fetchedAt: 0` (so the next tick refetches) and the facts surviving (so the
    // card does not blink to "no PR" before the refetch lands).
    h.mergeWrites = true;
    vi.mocked(window.showWarningMessage).mockResolvedValue("Squash and merge");
    const p = await openWith(greenFacts());
    await p._fire({ type: "deck:mergePr", key: "PROJ-1", repo: "svc", number: 124 });
    expect(h.writePrEntry).toHaveBeenCalledWith(
      "/prfacts", "PROJ-1", "svc",
      { facts: expect.objectContaining({ number: 124 }), fetchedAt: 0 },
    );
    expect(posts(p)).toContainEqual(expect.objectContaining({ type: "deck:mergeDone", outcome: "ok" }));
  });

  // Beyond the brief's own list, and the same reasoning submitReview's own
  // threw-after-starting case has: a throw anywhere past the confirmation must
  // still release the row, because nothing else is ever going to post an outcome
  // for it. The cache-staling write is the one step after a completed merge that
  // touches the filesystem, so it is where the throw is injected.
  it("still releases the button when the post-merge bookkeeping throws", async () => {
    h.mergeWrites = true;
    vi.mocked(window.showWarningMessage).mockResolvedValue("Squash and merge");
    h.writePrEntry.mockImplementationOnce(() => {
      throw new Error("prfacts is read-only");
    });
    const p = await openWith(greenFacts());
    await p._fire({ type: "deck:mergePr", key: "PROJ-1", repo: "svc", number: 124 });
    expect(h.prMerge).toHaveBeenCalledTimes(1);
    expect(posts(p)).toContainEqual(
      expect.objectContaining({ type: "deck:mergeDone", key: "PROJ-1", repo: "svc", number: 124, outcome: "failed" }),
    );
  });

  it("ignores a second message for the same PR while the first is still in flight", async () => {
    // Deliberately posts NO outcome for the duplicate: the real call owns the
    // outcome, and a "cancelled" here would re-enable the button mid-merge —
    // the opposite of what the guard exists for. Same shape as
    // reviewSubmitsInFlight.
    h.mergeWrites = true;
    vi.mocked(window.showWarningMessage).mockResolvedValue("Squash and merge");
    let release!: () => void;
    h.prMerge.mockImplementation(() => new Promise((res) => { release = () => res({ ok: true }); }));
    const p = await openWith(greenFacts());
    trackSpy.mockClear();
    const first = p._fire({ type: "deck:mergePr", key: "PROJ-1", repo: "svc", number: 124 });
    await p._fire({ type: "deck:mergePr", key: "PROJ-1", repo: "svc", number: 124 });
    release();
    await first;
    expect(h.prMerge).toHaveBeenCalledTimes(1);
    // Exactly ONE outcome across both fires, and it is the real call's. This is the
    // assertion that fails if someone "fixes" the in-flight guard's silence to match
    // the five releasing gates above: a `cancelled` from the rejected duplicate
    // would land here as a second message, releasing the button while the merge was
    // still in the air.
    const dones = posts(p).filter((m) => m.type === "deck:mergeDone");
    expect(dones).toHaveLength(1);
    expect(dones).toEqual([
      { type: "deck:mergeDone", key: "PROJ-1", repo: "svc", number: 124, outcome: "ok" },
    ]);
    // The rejected duplicate still gets its own pr_merged{ refused, in-flight } —
    // trackEvent isn't gated by the same "don't release the button" reasoning the
    // webview post is, so both this and the real call's pr_merged{ ok } land.
    const merged = trackSpy.mock.calls.flat().filter((e: any) => e.name === "pr_merged");
    expect(merged).toContainEqual(expect.objectContaining({ outcome: "refused", refusal: "in-flight" }));
    expect(merged).toContainEqual(expect.objectContaining({ outcome: "ok", merge_method: "squash" }));
  });

  it("carries mergeWrites on deck:runs so the card can render the row", async () => {
    h.mergeWrites = true;
    await openWith(greenFacts());
    expect(lastRunsPost()).toMatchObject({ mergeWrites: true });
  });

  // The other half, so the field is threaded from the setting rather than posted
  // as a constant: off is the shipped default, and the card's Merge row is
  // supposed to be invisible there.
  it("carries mergeWrites off when the setting is off", async () => {
    h.mergeWrites = false;
    await openWith(greenFacts());
    expect(lastRunsPost().mergeWrites).toBe(false);
  });

  it("emits pr_merged refused/writes-off when mergeWrites is off, with no repo or key in the serialized calls", async () => {
    h.mergeWrites = false;
    trackSpy.mockClear();
    const p = await openWith(greenFacts());
    await p._fire({ type: "deck:mergePr", key: "PROJ-1", repo: "svc", number: 124 });
    expect(trackSpy.mock.calls.flat().find((e: any) => e.name === "pr_merged")).toMatchObject({
      outcome: "refused", refusal: "writes-off",
    });
    expect(JSON.stringify(trackSpy.mock.calls.flat())).not.toContain("PROJ-1");
    expect(JSON.stringify(trackSpy.mock.calls.flat())).not.toContain("svc");
  });

  it.each([
    ["facts-off", () => { h.mergeWrites = true; h.prFacts = false; }],
    ["no-run", () => { h.mergeWrites = true; }],
    ["target-mismatch", () => { h.mergeWrites = true; }],
    ["no-checkout", () => { h.mergeWrites = true; }],
  ] as const)("emits pr_merged refused/%s for that gate", async (refusal, setup) => {
    setup();
    trackSpy.mockClear();
    let p: ReturnType<typeof lastPanel>;
    if (refusal === "no-run") {
      p = await openWith(greenFacts());
      await p._fire({ type: "deck:mergePr", key: "NOPE-9", repo: "svc", number: 124 });
    } else if (refusal === "target-mismatch") {
      p = await openWith(greenFacts());
      await p._fire({ type: "deck:mergePr", key: "PROJ-1", repo: "svc", number: 999 });
    } else if (refusal === "no-checkout") {
      h.runs = [mkRun({ repos: [{ name: "other", path: "/r/other", isGit: true, branch: "b" }] })];
      h.prEntries = { svc: { facts: greenFacts(), fetchedAt: Date.now() } };
      show();
      await settled();
      p = lastPanel();
      await p._fire({ type: "deck:mergePr", key: "PROJ-1", repo: "svc", number: 124 });
    } else {
      p = await openWith(greenFacts());
      await p._fire({ type: "deck:mergePr", key: "PROJ-1", repo: "svc", number: 124 });
    }
    expect(trackSpy.mock.calls.flat().find((e: any) => e.name === "pr_merged")).toMatchObject({
      outcome: "refused", refusal,
    });
  });

  it("emits pr_merged ok with merge_method on a successful merge", async () => {
    h.mergeWrites = true;
    h.mergeMethod = "squash";
    vi.mocked(window.showWarningMessage).mockResolvedValue("Squash and merge");
    trackSpy.mockClear();
    const p = await openWith(greenFacts());
    await p._fire({ type: "deck:mergePr", key: "PROJ-1", repo: "svc", number: 124 });
    expect(trackSpy.mock.calls.flat().find((e: any) => e.name === "pr_merged")).toMatchObject({
      outcome: "ok", merge_method: "squash",
    });
    expect(JSON.stringify(trackSpy.mock.calls.flat())).not.toContain("PROJ-1");
    expect(JSON.stringify(trackSpy.mock.calls.flat())).not.toContain("124");
  });

  it("emits pr_merged failed with merge_method when the forge rejects the merge", async () => {
    h.mergeWrites = true;
    vi.mocked(window.showWarningMessage).mockResolvedValue("Squash and merge");
    h.prMerge.mockResolvedValue({ ok: false, message: "Pull request is not mergeable" });
    trackSpy.mockClear();
    const p = await openWith(greenFacts());
    await p._fire({ type: "deck:mergePr", key: "PROJ-1", repo: "svc", number: 124 });
    expect(trackSpy.mock.calls.flat().find((e: any) => e.name === "pr_merged")).toMatchObject({
      outcome: "failed", merge_method: "squash",
    });
  });

  it("emits pr_merged cancelled, with no merge_method, when the confirmation is declined", async () => {
    h.mergeWrites = true;
    vi.mocked(window.showWarningMessage).mockResolvedValue(undefined);
    trackSpy.mockClear();
    const p = await openWith(greenFacts());
    await p._fire({ type: "deck:mergePr", key: "PROJ-1", repo: "svc", number: 124 });
    const ev = trackSpy.mock.calls.flat().find((e: any) => e.name === "pr_merged") as any;
    expect(ev).toMatchObject({ outcome: "cancelled" });
    expect(ev.merge_method).toBeUndefined();
  });

  // `merge_method` belongs on the failure event only once the forge was actually
  // asked to merge (docs: "present only once a merge was actually attempted") — a
  // throw from the confirm modal itself, before the forge is ever called, must not
  // claim a merge method was in play.
  it("emits pr_merged failed with no merge_method when the confirm dialog itself throws", async () => {
    h.mergeWrites = true;
    vi.mocked(window.showWarningMessage).mockRejectedValueOnce(new Error("dialog crashed"));
    trackSpy.mockClear();
    const p = await openWith(greenFacts());
    await p._fire({ type: "deck:mergePr", key: "PROJ-1", repo: "svc", number: 124 });
    expect(h.prMerge).not.toHaveBeenCalled();
    const ev = trackSpy.mock.calls.flat().find((e: any) => e.name === "pr_merged") as any;
    expect(ev).toMatchObject({ outcome: "failed" });
    expect(ev.merge_method).toBeUndefined();
  });
});

describe("DeckPanel — Address PR", () => {
  // Every case here predates the destination question and asserts the destination it
  // has always had: the run's own window. `its-window` is that answer as a setting, so
  // these keep proving the same behaviour instead of proving the picker's default.
  // Where the picker itself is covered — including that it can answer this — see
  // "DeckPanel — PR-work destination" below.
  beforeEach(() => setConfig({ prWorkOpenIn: "its-window" }));

  it("writes one plan matching the repo window for a per-window run", async () => {
    h.runs = [mkRun()];
    show();
    await lastPanel()._fire({ type: "deck:addressPr", key: "PROJ-1" });
    expect(h.writePlanFile).toHaveBeenCalledWith({
      key: "PROJ-1",
      createdAt: expect.any(Number),
      seedAgent: true,
      matches: [{
        matchPath: "/r/svc",
        prompt: "Assess the PR for {key}.{files} [key=PROJ-1 brief=(relative)]",
      }],
    });
    expect(h.openInEditor).toHaveBeenCalledWith("/r/svc");
  });

  it("matches the workspace file and the launch's own brief for a multiroot run", async () => {
    h.runs = [mkRun({
      mode: "multiroot",
      workspaceFile: "/ws/PROJ-1.code-workspace",
      briefPaths: ["/r/svc/.pick-task/TASK.md"],
    })];
    show();
    await lastPanel()._fire({ type: "deck:addressPr", key: "PROJ-1" });
    expect(h.writePlanFile).toHaveBeenCalledWith(expect.objectContaining({
      matches: [{
        matchPath: "/ws/PROJ-1.code-workspace",
        prompt: "Assess the PR for {key}.{files} [key=PROJ-1 brief=/r/svc/.pick-task/TASK.md]",
      }],
    }));
    expect(h.openInEditor).toHaveBeenCalledWith("/ws/PROJ-1.code-workspace");
  });

  it("seeds every window of a multi-repo per-window run", async () => {
    h.runs = [mkRun({
      repos: [
        { name: "svc", path: "/r/svc", isGit: true, branch: "b" },
        { name: "ui", path: "/r/ui", isGit: true, branch: "b" },
      ],
    })];
    show();
    await lastPanel()._fire({ type: "deck:addressPr", key: "PROJ-1" });
    const plan = h.writePlanFile.mock.calls.at(-1)![0] as { matches: { matchPath: string }[] };
    expect(plan.matches.map((m) => m.matchPath)).toEqual(["/r/svc", "/r/ui"]);
    expect(h.openInEditor).toHaveBeenCalledWith("/r/svc");
    expect(h.openInEditor).toHaveBeenCalledWith("/r/ui");
  });

  it("applies the auto-fix clause when prReviewAutoFix is on", async () => {
    h.prReviewAutoFix = true;
    h.runs = [mkRun()];
    show();
    await lastPanel()._fire({ type: "deck:addressPr", key: "PROJ-1" });
    const plan = h.writePlanFile.mock.calls.at(-1)![0] as { matches: { prompt: string }[] };
    expect(plan.matches[0].prompt).toContain(PR_REVIEW_AUTOFIX_CLAUSE);
  });

  it("leaves the run record untouched — the card keeps its launched-at", async () => {
    h.runs = [mkRun({ createdAt: 1_700_000_000_000 })];
    // Unpushed work is what keeps this one on the board. A run this old with
    // nothing open and nothing on disk reaches the closed shelf, and the retire
    // sweep stamps `closedAt` there — a write of its own that would mask the one
    // this test is watching for. It goes through buildRunStatus rather than
    // h.gitState because this file mocks buildRunStatus wholesale.
    h.buildRunStatus.mockImplementation((i: { run: Run; ticket: { category: string | null } | null }) => ({
      ...statusFor(i.run, i.ticket?.category ?? null),
      repos: [{ name: "svc", path: "/r/svc", branch: "b", dirty: true, ahead: 1, added: 1, removed: 0, files: 1 }],
    }));
    show();
    await lastPanel()._fire({ type: "deck:addressPr", key: "PROJ-1" });
    // A positive assertion that the handler actually ran: without it, deleting
    // addressPr outright would still leave writeRun uncalled, and the test below
    // would pass for the wrong reason.
    expect(h.writePlanFile).toHaveBeenCalled();
    expect(h.writeRun).not.toHaveBeenCalled();
    // The record itself still carries its original launched-at — the whole
    // point of not routing through openWorkspace (which stamps a fresh one).
    expect(h.runs.find((r) => r.key === "PROJ-1")?.createdAt).toBe(1_700_000_000_000);
  });

  it("opens the window but writes no plan when seedAgent is off", async () => {
    h.seedAgent = false;
    h.runs = [mkRun()];
    show();
    await lastPanel()._fire({ type: "deck:addressPr", key: "PROJ-1" });
    expect(h.writePlanFile).not.toHaveBeenCalled();
    expect(h.openInEditor).toHaveBeenCalledWith("/r/svc");
  });

  it("toasts an error when there is no run record for the key, and emits pr_work_seeded refused", async () => {
    h.runs = [];
    show();
    const p = lastPanel();
    trackSpy.mockClear();
    await p._fire({ type: "deck:addressPr", key: "PROJ-9" });
    expect(h.writePlanFile).not.toHaveBeenCalled();
    expect(posts(p)).toContainEqual(
      expect.objectContaining({ type: "toast", level: "error", message: "No run record for PROJ-9." }),
    );
    expect(trackSpy.mock.calls.flat().find((e: any) => e.name === "pr_work_seeded")).toMatchObject({
      outcome: "refused",
    });
  });

  it("toasts an error when the run has nothing to open", async () => {
    h.runs = [mkRun({ repos: [] })];
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:addressPr", key: "PROJ-1" });
    expect(h.writePlanFile).not.toHaveBeenCalled();
    expect(posts(p)).toContainEqual(
      expect.objectContaining({ type: "toast", level: "error", message: "Nothing to open for PROJ-1." }),
    );
  });

  it("toasts an error when the editor refuses to open", async () => {
    h.runs = [mkRun()];
    h.openInEditor.mockResolvedValueOnce(false);
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:addressPr", key: "PROJ-1" });
    expect(posts(p)).toContainEqual(
      expect.objectContaining({ type: "toast", level: "error", message: "Couldn't open PROJ-1." }),
    );
  });

  it("collects failures across a multi-repo run into a single toast naming each repo", async () => {
    h.runs = [mkRun({
      repos: [
        { name: "svc", path: "/r/svc", isGit: true, branch: "b" },
        { name: "ui", path: "/r/ui", isGit: true, branch: "b" },
      ],
    })];
    h.openInEditor.mockResolvedValue(false);
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:addressPr", key: "PROJ-1" });
    const toasts = posts(p).filter((m) => m.type === "toast" && m.level === "error");
    // One toast, not one per failing window — and it names both.
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe("Couldn't open PROJ-1 (svc, ui).");
  });

  it("uses the real Jira key for the prompt and the plan file, not a promoted local card's place-hash", async () => {
    // track() saves a promoted local card under its place-hash key when the
    // inferred Jira key already belongs to another run — kind: "task", so it
    // still reaches the PR-review status and shows the button — but the ticket
    // itself only lives in its url. run.key here is exactly that hash.
    h.runs = [mkRun({ key: "local-api-1a2b3c4d", url: "https://jira/browse/PROJ-7" })];
    show();
    await lastPanel()._fire({ type: "deck:addressPr", key: "local-api-1a2b3c4d" });
    const plan = h.writePlanFile.mock.calls.at(-1)![0] as { key: string; matches: { prompt: string }[] };
    // The mock agentPrompt encodes the ticket key it was given as "[key=...]".
    expect(plan.matches[0].prompt).toContain("[key=PROJ-7 ");
    expect(plan.matches[0].prompt).not.toContain("local-api-1a2b3c4d");
    expect(plan.key).toBe("PROJ-7");
  });

  it("ignores an addressPr for a local card, even though run(key) can resolve one from localRuns", async () => {
    // The webview never sends this — a local card's button is gated off — but
    // run(key) falls back to the in-memory localRuns map regardless of kind, so
    // the guard has to be enforced here too, not just trusted to the webview.
    h.runs = [];
    h.openSessions = [sess({ cwd: "/r/webapp", name: "webapp-7e" })];
    show();
    await settled();
    const localKey = builtLocal().run.key;
    const p = lastPanel();
    trackSpy.mockClear();
    await p._fire({ type: "deck:addressPr", key: localKey });
    await settled();
    expect(h.writePlanFile).not.toHaveBeenCalled();
    expect(h.openInEditor).not.toHaveBeenCalled();
    expect(trackSpy.mock.calls.flat().find((e: any) => e.name === "pr_work_seeded")).toMatchObject({
      outcome: "refused",
    });
  });

  it("tells the user nothing was seeded when agentFlow.seedAgent is off", async () => {
    h.seedAgent = false;
    h.runs = [mkRun()];
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:addressPr", key: "PROJ-1" });
    expect(h.openInEditor).toHaveBeenCalledWith("/r/svc");
    expect(posts(p)).toContainEqual(
      expect.objectContaining({ type: "toast", level: "info", message: expect.stringContaining("agentFlow.seedAgent") }),
    );
  });

  it("emits pr_work_seeded with reason review and source deck, and no ticket key in the serialized calls", async () => {
    h.runs = [mkRun()];
    show();
    trackSpy.mockClear();
    await lastPanel()._fire({ type: "deck:addressPr", key: "PROJ-1" });
    expect(trackSpy.mock.calls.flat().find((e: any) => e.name === "pr_work_seeded")).toMatchObject({
      reason: "review", source: "deck", outcome: "seeded",
      window_count: 1, failed_repo_count: 0, agent_seeded: true,
    });
    expect(JSON.stringify(trackSpy.mock.calls.flat())).not.toContain("PROJ-1");
  });

  it("emits pr_work_seeded opened-not-seeded when agentFlow.seedAgent is off", async () => {
    h.seedAgent = false;
    h.runs = [mkRun()];
    show();
    trackSpy.mockClear();
    await lastPanel()._fire({ type: "deck:addressPr", key: "PROJ-1" });
    expect(trackSpy.mock.calls.flat().find((e: any) => e.name === "pr_work_seeded")).toMatchObject({
      outcome: "opened-not-seeded", agent_seeded: false,
    });
  });

  it("emits pr_work_seeded open-failed, with the failed count, when the editor refuses to open", async () => {
    h.runs = [mkRun()];
    h.openInEditor.mockResolvedValueOnce(false);
    show();
    trackSpy.mockClear();
    await lastPanel()._fire({ type: "deck:addressPr", key: "PROJ-1" });
    expect(trackSpy.mock.calls.flat().find((e: any) => e.name === "pr_work_seeded")).toMatchObject({
      outcome: "open-failed", window_count: 1, failed_repo_count: 1,
    });
  });

  it("emits pr_work_seeded refused for a run with nothing to open", async () => {
    h.runs = [mkRun({ repos: [] })];
    show();
    trackSpy.mockClear();
    await lastPanel()._fire({ type: "deck:addressPr", key: "PROJ-1" });
    expect(trackSpy.mock.calls.flat().find((e: any) => e.name === "pr_work_seeded")).toMatchObject({
      outcome: "refused",
    });
  });
});

// I3: nothing here ever fired `deck:seedPrWork` before this — every existing
// case above dispatches the older `deck:addressPr` instead, which always seeds
// reason "review" with no detail. Proven by mutation: hardcoding the handler's
// dispatch to seedPrWork(m.key, "review") and dropping `detail` still passed
// every test in this file and in engine/prompt.test.ts. prWorkClause itself is
// unit-tested there; what was missing is proof the message handler actually
// reads `m.reason`/`m.detail` off the wire and carries them into the seeded
// prompt, rather than ignoring them the way `deck:addressPr` always has.
describe("DeckPanel — seedPrWork", () => {
  // Same pin, same reason, as the Address PR block above: these are about the
  // seeded PROMPT, and the destination they assert is the run's own window.
  beforeEach(() => setConfig({ prWorkOpenIn: "its-window" }));

  it("carries the CI clause and check names from reason: \"ci\" into the seeded prompt", async () => {
    h.runs = [mkRun()];
    show();
    await lastPanel()._fire({
      type: "deck:seedPrWork", key: "PROJ-1", reason: "ci", detail: "integration, lint",
    });
    const plan = h.writePlanFile.mock.calls.at(-1)![0] as { matches: { matchPath: string; prompt: string }[] };
    expect(plan.matches).toEqual([{
      matchPath: "/r/svc",
      prompt: "CI is failing on this PR (integration, lint). Find out why and make it pass.\n\n"
        + "Assess the PR for {key}.{files} [key=PROJ-1 brief=(relative)]",
    }]);
    expect(h.openInEditor).toHaveBeenCalledWith("/r/svc");
  });

  it("produces the plain review template for reason: \"review\", byte-identical to deck:addressPr", async () => {
    h.runs = [mkRun()];
    show();
    await lastPanel()._fire({ type: "deck:seedPrWork", key: "PROJ-1", reason: "review" });
    const plan = h.writePlanFile.mock.calls.at(-1)![0] as { matches: { prompt: string }[] };
    expect(plan.matches[0].prompt).toBe("Assess the PR for {key}.{files} [key=PROJ-1 brief=(relative)]");
  });

  it("carries the conflict clause from reason: \"conflict\" into the seeded prompt", async () => {
    h.runs = [mkRun()];
    show();
    await lastPanel()._fire({ type: "deck:seedPrWork", key: "PROJ-1", reason: "conflict" });
    const plan = h.writePlanFile.mock.calls.at(-1)![0] as { matches: { prompt: string }[] };
    expect(plan.matches[0].prompt).toContain(
      "This PR conflicts with its base branch. Rebase it onto the base and resolve the conflicts.",
    );
  });
});

// ── where PR work opens (agentFlow.prWorkOpenIn) ──────────────────────────────
// The buttons on a card — Fix CI, Resolve conflict, Address review — used to re-seed
// the run's own window with no question. They now ask, unless the setting pins the
// old answer. The blocks above are the no-regression guard for that pinned answer;
// these cover the picker itself.
describe("DeckPanel — PR-work destination", () => {
  const HERE = { identity: "/repos/bite-me", kind: "folder" as const, roots: [{ path: "/repos/bite-me" }] };
  const plan = () => h.writePlanFile.mock.calls.at(-1)?.[0] as { matches: { matchPath: string; prompt: string }[] } | undefined;
  const fire = async (reason = "conflict") => {
    h.runs = [mkRun({ briefPaths: ["/r/svc/.pick-task/TASK.md"] })];
    show();
    await lastPanel()._fire({ type: "deck:seedPrWork", key: "PROJ-1", reason });
    return lastPanel();
  };

  it("asks where to open, in the button's own words", async () => {
    window.showQuickPick.mockResolvedValueOnce({ target: { kind: "stay" } });
    await fire();
    expect(window.showQuickPick).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: "Resolve conflict for PROJ-1 — open where?" }),
    );
  });

  it("leads with the run's own window, named by the repo it holds", async () => {
    window.showQuickPick.mockResolvedValueOnce({ target: { kind: "stay" } });
    await fire("ci");
    const items = window.showQuickPick.mock.calls[0][0] as { label: string; detail: string }[];
    expect(items[0]).toMatchObject({ label: "$(window) Its own window", detail: "svc" });
    // Never both: for a run that already has windows, "New window" would be a second
    // name for the row above it.
    expect(items.some((i) => i.label.includes("New window"))).toBe(false);
  });

  it("re-seeds the run's own window when that is what was picked", async () => {
    window.showQuickPick.mockResolvedValueOnce({ target: { kind: "stay" } });
    await fire();
    expect(plan()!.matches).toEqual([{ matchPath: "/r/svc", prompt: expect.stringContaining("brief=(relative)") }]);
    expect(h.openInEditor).toHaveBeenCalledWith("/r/svc");
  });

  it("seeds a live window instead, against the run's brief by absolute path", async () => {
    // The relative .pick-task/TASK.md is nothing in a folder that is not the repo, so
    // a destination the user picked has to carry the brief's real location.
    window.showQuickPick.mockResolvedValueOnce({ target: { kind: "live-folder", folder: "/repos/bite-me" } });
    await fire();
    expect(plan()!.matches).toEqual([{
      matchPath: "/repos/bite-me",
      prompt: expect.stringContaining("brief=/r/svc/.pick-task/TASK.md"),
    }]);
    expect(h.openInEditor).toHaveBeenCalledWith("/repos/bite-me");
    expect(h.openInEditor).not.toHaveBeenCalledWith("/r/svc");
  });

  it("seeds this window in place, opening nothing, and says so", async () => {
    h.currentWindow = HERE;
    window.showQuickPick.mockResolvedValueOnce({ target: { kind: "current" } });
    const p = await fire();
    expect(plan()!.matches).toEqual([{ matchPath: "/repos/bite-me", prompt: expect.any(String) }]);
    expect(h.openInEditor).not.toHaveBeenCalled();
    expect(posts(p)).toContainEqual(expect.objectContaining({
      type: "toast", message: "Resolve conflict for PROJ-1 — seeded in this window.",
    }));
  });

  it("refuses this window when it has no identity between the pick and the seed, and emits pr_work_seeded refused", async () => {
    h.currentWindow = undefined;
    window.showQuickPick.mockResolvedValueOnce({ target: { kind: "current" } });
    trackSpy.mockClear();
    const p = await fire();
    expect(h.writePlanFile).not.toHaveBeenCalled();
    expect(posts(p)).toContainEqual(expect.objectContaining({
      type: "toast", level: "error", message: expect.stringContaining("no workspace file"),
    }));
    expect(trackSpy.mock.calls.flat().find((e: any) => e.name === "pr_work_seeded")).toMatchObject({
      outcome: "refused",
    });
  });

  // The plan file is the durable half of this click: written after the question, never
  // before, so an Escape cannot leave one on disk for a window to act on later.
  it("writes nothing and opens nothing when the picker is dismissed", async () => {
    window.showQuickPick.mockResolvedValueOnce(undefined);
    const p = await fire();
    expect(h.writePlanFile).not.toHaveBeenCalled();
    expect(h.openInEditor).not.toHaveBeenCalled();
    expect(posts(p).some((m) => m.type === "toast")).toBe(false);
  });

  it("emits pr_work_seeded cancelled when the destination picker is dismissed", async () => {
    window.showQuickPick.mockResolvedValueOnce(undefined);
    trackSpy.mockClear();
    await fire();
    expect(trackSpy.mock.calls.flat().find((e: any) => e.name === "pr_work_seeded")).toMatchObject({
      outcome: "cancelled",
    });
  });

  it("emits pr_work_seeded seeded-in-place when re-seeding this window without opening anything", async () => {
    h.currentWindow = HERE;
    window.showQuickPick.mockResolvedValueOnce({ target: { kind: "current" } });
    trackSpy.mockClear();
    await fire();
    expect(trackSpy.mock.calls.flat().find((e: any) => e.name === "pr_work_seeded")).toMatchObject({
      outcome: "seeded-in-place", window_count: 0, agent_seeded: true,
    });
  });

  it("asks nothing at all when the setting pins the run's own window", async () => {
    setConfig({ prWorkOpenIn: "its-window" });
    await fire();
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(h.openInEditor).toHaveBeenCalledWith("/r/svc");
  });

  it("names one window per repo on a multi-repo run", async () => {
    window.showQuickPick.mockResolvedValueOnce({ target: { kind: "stay" } });
    h.runs = [mkRun({ repos: [
      { name: "svc", path: "/r/svc", isGit: true, branch: "b" },
      { name: "web", path: "/r/web", isGit: true, branch: "b" },
    ] })];
    show();
    await lastPanel()._fire({ type: "deck:seedPrWork", key: "PROJ-1", reason: "conflict" });
    const items = window.showQuickPick.mock.calls[0][0] as { detail: string }[];
    expect(items[0].detail).toBe("svc, web — one window each");
    expect(plan()!.matches.map((m) => m.matchPath)).toEqual(["/r/svc", "/r/web"]);
  });

  it("collapses a multi-repo run onto the one window it was sent to", async () => {
    window.showQuickPick.mockResolvedValueOnce({ target: { kind: "existing", file: "/ws/team.code-workspace" } });
    h.runs = [mkRun({ briefPaths: ["/r/svc/.pick-task/TASK.md"], repos: [
      { name: "svc", path: "/r/svc", isGit: true, branch: "b" },
      { name: "web", path: "/r/web", isGit: true, branch: "b" },
    ] })];
    show();
    await lastPanel()._fire({ type: "deck:seedPrWork", key: "PROJ-1", reason: "conflict" });
    expect(plan()!.matches).toEqual([{
      matchPath: "/ws/team.code-workspace",
      prompt: expect.stringContaining("brief=/r/svc/.pick-task/TASK.md"),
    }]);
  });

  it("asks nothing for a run with nowhere to open", async () => {
    h.runs = [mkRun({ repos: [] })];
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:seedPrWork", key: "PROJ-1", reason: "conflict" });
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(posts(p)).toContainEqual(expect.objectContaining({
      type: "toast", level: "error", message: "Nothing to open for PROJ-1.",
    }));
  });
});

const mkFlow = (id: string, name: string): Flow =>
  ({ id, name, armed: false, createdAt: 1_000, nodes: [], edges: [] });

/** A RunStatus whose one repo's PR is in the given state, so a place node bound to
 * `{ runKey: key, repo }` resolves and its PR conditions have data. */
const prStatus = (key: string, repo: string, state: "OPEN" | "MERGED"): RunStatus => ({
  run: {
    key, summary: "s", url: `https://j/browse/${key}`, createdAt: 1, mode: "multiroot",
    repos: [{ name: repo, path: `/r/${repo}`, isGit: true }], briefPaths: [],
  },
  column: "progress",
  shelf: "board",
  ticketStatus: "In Progress",
  ticketCategory: "indeterminate",
  repos: [{ name: repo, path: `/r/${repo}`, branch: "b", dirty: false, ahead: 0, added: 0, removed: 0, files: 0 }],
  agent: { state: "working", lastActivityMs: 1, slug: null },
  windowOpen: true,
  prs: {
    [repo]: {
      facts: {
        number: 1, url: "u", title: "t", state, isDraft: false,
        ci: { passing: 2, pending: 0, failing: [] }, review: "none", unresolved: null,
        mergeable: "clean", ciAdvisory: false,
      },
      fetchedAt: 1,
    },
  },
  agents: [],
});
const mergedStatus = (key: string, repo: string) => prStatus(key, repo, "MERGED");
const openStatus = (key: string, repo: string) => prStatus(key, repo, "OPEN");

/** Let the panel's in-flight refresh land. Two microtask drains is enough with
 * these mocks — nothing here does real I/O. */
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("orchestrator flows", () => {
  /** Open a panel and return it plus a way to deliver an inbound message — the
   * same `show()` + `settled()` + `_fire` idiom every other describe block in
   * this file uses, rather than reaching into `webview.onDidReceiveMessage`
   * directly. */
  const openPanel = async () => {
    show();
    await settled();
    const p = lastPanel();
    return { p, send: async (m: unknown) => { await p._fire(m); await settled(); } };
  };

  it("posts deck:flows with enabled false when the setting is off", async () => {
    // With the setting off the webview renders no chip at all, but the host still
    // posts: silence is indistinguishable from "not loaded yet".
    setConfig({ orchestrator: false });
    const { p } = await openPanel();
    expect(posts(p).find((m) => m.type === "deck:flows")).toMatchObject({ enabled: false, flows: [] });
  });

  it("posts the flows it read from the store when enabled", async () => {
    setConfig({ orchestrator: true });
    h.flows = [mkFlow("f1", "Ship it")];
    const { p } = await openPanel();
    const msg = posts(p).find((m) => m.type === "deck:flows");
    expect(msg).toMatchObject({ enabled: true });
    expect(msg.flows.map((f: Flow) => f.name)).toEqual(["Ship it"]);
  });

  // The inspector's USING selector needs the six configured modes, but never the
  // `prompt` text itself — that can be long and is never displayed there. This
  // is what makes the mode list configuration rather than a second copy of it.
  // Setting off on purpose: this is configuration, not flow data, so it must
  // still post — the same reasoning `flows`/`pendingResume` are emptied for,
  // applied in the opposite direction.
  it("posts the configured prompt modes narrowed to id and label, even with the setting off", async () => {
    setConfig({ orchestrator: false });
    const { p } = await openPanel();
    const msg = posts(p).find((m) => m.type === "deck:flows") as { promptModes: { id: string; label: string }[] };
    expect(msg.promptModes.length).toBe(DEFAULT_PROMPT_MODES.length);
    expect(msg.promptModes).toEqual(DEFAULT_PROMPT_MODES.map((m) => ({ id: m.id, label: m.label })));
    // Narrowed, not the whole PromptMode — `prompt` never reaches the webview.
    expect(msg.promptModes[0]).not.toHaveProperty("prompt");
  });

  // The drawer builds a command node by naming one of these, and a webview has
  // no fs access to read the setting for itself. Sent whole rather than narrowed
  // the way `promptModes` is: a command's `run` is short and IS what the rule
  // executes. Setting off on purpose, same as the modes above — configuration,
  // not flow data.
  it("posts the configured commands, even with the setting off", async () => {
    setConfig({ orchestrator: false });
    // Through `h.commands`, which is what this file's config mock serves for
    // this setting (see its own comment there) — a `setConfig` would not reach
    // it.
    h.commands = [{ id: "deploy-staging", label: "Deploy to staging", run: "deploy.sh --env={note}" }];
    const { p } = await openPanel();
    const msg = posts(p).find((m) => m.type === "deck:flows") as { commands: unknown[] };
    expect(msg.commands).toEqual([
      { id: "deploy-staging", label: "Deploy to staging", run: "deploy.sh --env={note}" },
    ]);
  });

  it("posts an empty command list through when the harness has none — a user can clear the setting", async () => {
    setConfig({ orchestrator: true });
    h.commands = [];
    const { p } = await openPanel();
    const msg = posts(p).find((m) => m.type === "deck:flows") as { commands: unknown[] };
    expect(msg.commands).toEqual([]);
  });

  it("flow:create writes a new disarmed flow with a store-safe id", async () => {
    setConfig({ orchestrator: true });
    const { send } = await openPanel();
    await send({ type: "flow:create" });
    expect(h.writeFlow).toHaveBeenCalledTimes(1);
    const written = h.writeFlow.mock.calls[0][2] as Flow;
    expect(written).toMatchObject({ name: "New flow", armed: false, nodes: [], edges: [] });
    expect(written.id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("flow:create re-mints rather than overwriting an id already on disk", async () => {
    // newFlowId is probabilistic. A collision must not clobber the user's flow.
    // The flowIo mock's newFlowId is deterministic, so seed the store with exactly
    // what it will return first and assert the write does not target that id.
    setConfig({ orchestrator: true });
    h.flows = [mkFlow("fTEST-1", "already here")];
    const { send } = await openPanel();
    await send({ type: "flow:create" });
    const written = h.writeFlow.mock.calls.at(-1)![2] as Flow;
    // It must re-mint past the taken id. Overwriting "fTEST-1" is the one outcome
    // that must never happen — that is the user's saved flow.
    expect(written.id).not.toBe("fTEST-1");
    expect(written.id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(h.flows[0].name).toBe("already here");
  });

  it("refuses to write rather than clobber when every re-mint collides", async () => {
    // The bound is 9 attempts (one plus eight retries). Seed all nine ids as
    // already taken, so exhaustion is the only path left. Refusing is what stops
    // a collision from silently overwriting a flow the user saved.
    setConfig({ orchestrator: true });
    h.flows = Array.from({ length: 9 }, (_, i) => mkFlow(`fTEST-${i + 1}`, `taken ${i + 1}`));
    const { send } = await openPanel();
    await send({ type: "flow:create" });
    expect(h.writeFlow).not.toHaveBeenCalled();
    // And nothing already on disk was disturbed.
    expect(h.flows.map((f) => f.name)).toEqual(
      Array.from({ length: 9 }, (_, i) => `taken ${i + 1}`),
    );
  });

  it("flow:rename changes only the name", async () => {
    setConfig({ orchestrator: true });
    h.flows = [mkFlow("f1", "old")];
    const { send } = await openPanel();
    await send({ type: "flow:rename", id: "f1", name: "Ship the migration" });
    expect(h.writeFlow.mock.calls.at(-1)![2]).toMatchObject({ id: "f1", name: "Ship the migration" });
  });

  it("flow:rename ignores an id it does not have", async () => {
    setConfig({ orchestrator: true });
    h.flows = [mkFlow("f1", "old")];
    const { send } = await openPanel();
    await send({ type: "flow:rename", id: "nope", name: "x" });
    expect(h.writeFlow).not.toHaveBeenCalled();
  });

  it("flow:save persists the whole graph", async () => {
    setConfig({ orchestrator: true });
    h.flows = [mkFlow("f1", "n")];
    const { send } = await openPanel();
    const edited: Flow = {
      ...mkFlow("f1", "n"),
      nodes: [{ id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "PROJ-1", repo: "agent-flow" }],
    };
    await send({ type: "flow:save", flow: edited });
    expect((h.writeFlow.mock.calls.at(-1)![2] as Flow).nodes).toHaveLength(1);
  });

  it("flow:save refuses a flow whose id is not in the store", async () => {
    // The drawer can only ever edit a flow the host gave it. Anything else is a
    // bug or a hostile message, and writing it would create a file from nothing.
    setConfig({ orchestrator: true });
    h.flows = [mkFlow("f1", "n")];
    const { send } = await openPanel();
    await send({ type: "flow:save", flow: mkFlow("intruder", "x") });
    expect(h.writeFlow).not.toHaveBeenCalled();
  });

  it("flow:delete removes it", async () => {
    setConfig({ orchestrator: true });
    h.flows = [mkFlow("f1", "n")];
    const { send } = await openPanel();
    await send({ type: "flow:delete", id: "f1" });
    expect(h.removeFlow).toHaveBeenCalledWith(expect.anything(), "/flows", "f1");
  });

  it("flow:delete refuses an id that is not in the store", async () => {
    // The same membership check flow:save and flow:rename make. This arm reaches
    // fs.rmSync on a path built from webview-supplied text, and it was the only
    // flow handler that took that id on trust.
    setConfig({ orchestrator: true });
    h.flows = [mkFlow("f1", "n")];
    const { send } = await openPanel();
    await send({ type: "flow:delete", id: "intruder" });
    expect(h.removeFlow).not.toHaveBeenCalled();
    expect(h.flows.map((f) => f.id)).toEqual(["f1"]);
  });

  it("ignores every flow message when the setting is off", async () => {
    setConfig({ orchestrator: false });
    const { send } = await openPanel();
    await send({ type: "flow:create" });
    await send({ type: "flow:delete", id: "f1" });
    await send({ type: "flow:addPlanned", id: "f1" });
    expect(h.writeFlow).not.toHaveBeenCalled();
    expect(h.removeFlow).not.toHaveBeenCalled();
    // Not even the first question gets asked — the setting gate is checked
    // before the connector is ever touched.
    expect(window.showQuickPick).not.toHaveBeenCalled();
  });

  // A template is a workflow's shape with the ticket taken out (templates.ts).
  // One planned node by default — enough to instantiate against — with a fresh
  // `nodes` array per call so a test that mutates one fixture's nodes cannot
  // bleed into another's.
  const mkTemplate = (id: string, name: string, nodes: FlowNode[] = [
    { id: "n1", x: 0, y: 0, join: "any", kind: "planned", ticketKey: "", repos: ["aws-ops"], mode: "plan", dest: "worktree" },
  ]): FlowTemplate => ({
    schema: 1, id, name, params: {}, savedAt: 1_000,
    flow: { id: "unused", name, armed: false, createdAt: 0, nodes, edges: [] },
  });

  describe("flow:attach — instantiating a template onto a card (Task 8)", () => {
    it("writes a disarmed workflow bound to the card's ticket", async () => {
      setConfig({ orchestrator: true });
      h.templates = [mkTemplate("k1", "Ship it")];
      const { send } = await openPanel();
      await send({ type: "flow:attach", runKey: "PROJ-142", templateId: "k1" });
      expect(h.writeFlow).toHaveBeenCalledTimes(1);
      const written = h.writeFlow.mock.calls.at(-1)![2] as Flow;
      expect(written.armed).toBe(false);
      expect(
        written.nodes.filter((n) => n.kind === "planned")
          .every((n) => (n as { ticketKey: string }).ticketKey === "PROJ-142"),
      ).toBe(true);
      // launchConfirmedAt/commandConfirmedAt are never set here — that is
      // instantiate()'s own contract (templates.test.ts pins it), not this
      // handler's, so it is not re-pinned here.
    });

    it("derives the ticket key from the run's url when a run is on the board", async () => {
      // ticketKeyFor, not runKey verbatim: a promoted local card can be saved
      // under a place-hash key while its ticket lives only in the run's url
      // (see ticketKeyFor's own comment in types.ts) — the same derivation
      // every other card action already goes through.
      setConfig({ orchestrator: true });
      h.templates = [mkTemplate("k1", "Ship it")];
      h.runs = [mkRun({ key: "hash-abc123", url: "https://jira/browse/PROJ-99" })];
      const { send } = await openPanel();
      await send({ type: "flow:attach", runKey: "hash-abc123", templateId: "k1" });
      const written = h.writeFlow.mock.calls.at(-1)![2] as Flow;
      const planned = written.nodes.find((n) => n.kind === "planned") as { ticketKey: string };
      expect(planned.ticketKey).toBe("PROJ-99");
    });

    it("refuses when a workflow is already attached and replace is absent", async () => {
      setConfig({ orchestrator: true });
      h.templates = [mkTemplate("k1", "Ship it")];
      h.flows = [{
        id: "f-old", name: "Already running", armed: true, createdAt: 500,
        nodes: [{ id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-142", repo: "aws-ops" }],
        edges: [],
      }];
      const { p, send } = await openPanel();
      await send({ type: "flow:attach", runKey: "PROJ-142", templateId: "k1" });
      expect(h.writeFlow).not.toHaveBeenCalled();
      const toast = posts(p).find((m) => m.type === "toast");
      expect(toast?.message).toMatch(/already/i);
      expect(toast?.message).toContain("Already running");
    });

    it("with replace detaches the old workflow first", async () => {
      setConfig({ orchestrator: true });
      h.templates = [mkTemplate("k1", "Ship it")];
      h.flows = [{
        id: "f-old", name: "Already running", armed: true, createdAt: 500,
        nodes: [{ id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-142", repo: "aws-ops" }],
        edges: [],
      }];
      const { send } = await openPanel();
      await send({ type: "flow:attach", runKey: "PROJ-142", templateId: "k1", replace: true });
      expect(h.removeFlow).toHaveBeenCalledWith(expect.anything(), "/flows", "f-old");
      expect(h.writeFlow).toHaveBeenCalledTimes(1);
      // Not just "a write happened" — the replacement is the freshly
      // instantiated workflow, bound to the card's ticket, not the old flow
      // (which has no planned node at all) written back untouched.
      const written = h.writeFlow.mock.calls.at(-1)![2] as Flow;
      const planned = written.nodes.find((n) => n.kind === "planned") as { ticketKey: string } | undefined;
      expect(planned?.ticketKey).toBe("PROJ-142");
    });

    it("warns when the template is no longer on disk", async () => {
      setConfig({ orchestrator: true });
      h.templates = [];
      const { p, send } = await openPanel();
      await send({ type: "flow:attach", runKey: "PROJ-142", templateId: "missing" });
      expect(h.writeFlow).not.toHaveBeenCalled();
      const toast = posts(p).find((m) => m.type === "toast");
      expect(toast?.message).toMatch(/no longer on disk/i);
    });

    it("warns, rather than writing a rootless workflow, for a template with no planned step", async () => {
      // instantiate() throws for exactly this shape: a graph of notifications
      // with nothing to bind the ticket to.
      setConfig({ orchestrator: true });
      h.templates = [mkTemplate("k1", "Notify only", [
        { id: "n1", x: 0, y: 0, join: "any", kind: "notify", message: "hi" },
      ])];
      const { p, send } = await openPanel();
      await send({ type: "flow:attach", runKey: "PROJ-142", templateId: "k1" });
      expect(h.writeFlow).not.toHaveBeenCalled();
      const toast = posts(p).find((m) => m.type === "toast");
      expect(toast?.message).toMatch(/no planned step/i);
    });

    // The bug this task fixes: a built-in starter is never on disk
    // (`readTemplates` skips a file claiming a `builtin-` id, store.ts), and
    // this handler used to look the template up ONLY on disk — so attaching
    // any of the three starters the drawer offers always hit the "no longer
    // on disk" refusal above. `allTemplates()` (deckView.ts) is what makes a
    // starter resolvable here. The starter's own planned node carries no
    // `repos`/`mode` (starters.ts, deliberately), so this also exercises
    // `instantiate`'s fallback onto the card's repos and the config's prompt
    // modes — h.runs supplies the former, the config mock's default
    // `promptModes` the latter.
    it("attaches a built-in starter onto a card", async () => {
      setConfig({ orchestrator: true });
      h.runs = [mkRun()];
      // `mkRun()`'s checkout is named "svc" — on disk here too, so the fallback
      // onto the card's own repos (below) has something real to resolve to. See
      // "refuses, at the click, when a local card's repos aren't on disk" for the
      // case where it is not.
      h.repos = [{ name: "svc", path: "/r/svc", isGit: true }];
      const { send } = await openPanel();
      await send({ type: "flow:attach", runKey: "PROJ-1", templateId: "builtin-ship-it" });
      expect(h.writeFlow).toHaveBeenCalledTimes(1);
      const written = h.writeFlow.mock.calls.at(-1)![2] as Flow;
      expect(written.fromTemplate).toBe("builtin-ship-it");
      const planned = written.nodes.find((n) => n.kind === "planned") as
        { ticketKey: string; repos: string[] } | undefined;
      expect(planned?.ticketKey).toBe("PROJ-1");
      // The starter's planned node ships with `repos: []` on purpose
      // (starters.ts) — `instantiate` falls back to the card's own repos,
      // which is `mkRun()`'s single "svc" checkout.
      expect(planned?.repos).toEqual(["svc"]);
    });

    // The defect this task's own review found: `run.repos[].name` is the
    // checkout name ONLY for a run Agent Flow itself launched. For a LOCAL
    // card (localRuns.ts) it is synthesized from the worktree's folder path,
    // which can name something `discoverRepos` does not recognize — a
    // hand-made worktree, or a repo outside `agentFlow.reposRoot`. Before this
    // fix, `instantiate` would happily build a workflow around that name, the
    // card would look attached, and the launch rule would fail ~6s later with
    // "isn't checked out under your repos root" — the edge latching stopped
    // with no actionable moment. Now the mismatch is caught here, at the
    // click, as instantiate's own "no repo to launch in" refusal.
    it("refuses, at the click, when a local card's repos aren't on disk under agentFlow.reposRoot", async () => {
      setConfig({ orchestrator: true });
      // A local card whose checkout path.basename is "side-quest" — not
      // reported by discoverRepos, which only sees what's under reposRoot.
      h.runs = [mkRun({ repos: [{ name: "side-quest", path: "/elsewhere/side-quest", isGit: true, branch: "b" }] })];
      h.repos = [{ name: "aws-ops", path: "/repos/aws-ops", isGit: true }];
      const { p, send } = await openPanel();
      await send({ type: "flow:attach", runKey: "PROJ-1", templateId: "builtin-ship-it" });
      expect(h.writeFlow).not.toHaveBeenCalled();
      const toast = posts(p).find((m) => m.type === "toast");
      expect(toast?.message).toMatch(/no repo to launch in/i);
    });

    it("keeps only the repos that resolve on disk, rather than dropping the whole attach", async () => {
      // A partial mismatch is worse silently: before this fix, an unresolved
      // repo among several was dropped with only an output-channel line, and
      // the session launched missing a repo the card claimed. Now the
      // resolvable one still attaches (the template itself names no repos, so
      // this exercises the fallback with a MIX of good and bad names).
      setConfig({ orchestrator: true });
      h.runs = [mkRun({
        repos: [
          { name: "svc", path: "/r/svc", isGit: true, branch: "b" },
          { name: "side-quest", path: "/elsewhere/side-quest", isGit: true, branch: "b" },
        ],
      })];
      h.repos = [{ name: "svc", path: "/r/svc", isGit: true }];
      const { send } = await openPanel();
      await send({ type: "flow:attach", runKey: "PROJ-1", templateId: "builtin-ship-it" });
      expect(h.writeFlow).toHaveBeenCalledTimes(1);
      const written = h.writeFlow.mock.calls.at(-1)![2] as Flow;
      const planned = written.nodes.find((n) => n.kind === "planned") as { repos: string[] } | undefined;
      expect(planned?.repos).toEqual(["svc"]);
    });
  });

  describe("flow:detach — removing an attached workflow (Task 8)", () => {
    it("removes the workflow's flow file", async () => {
      setConfig({ orchestrator: true });
      h.flows = [mkFlow("f1", "Ship it")];
      const { send } = await openPanel();
      await send({ type: "flow:detach", id: "f1" });
      expect(h.removeFlow).toHaveBeenCalledWith(expect.anything(), "/flows", "f1");
    });

    it("ignores an id that is not in the store", async () => {
      setConfig({ orchestrator: true });
      h.flows = [mkFlow("f1", "Ship it")];
      const { send } = await openPanel();
      await send({ type: "flow:detach", id: "intruder" });
      expect(h.removeFlow).not.toHaveBeenCalled();
    });
  });

  describe("flow:saveTemplate — saving a flow as a reusable template (Task 8)", () => {
    it("demotes places using the choices it was given", async () => {
      setConfig({ orchestrator: true });
      h.flows = [{
        id: "f1", name: "Ship it", armed: false, createdAt: 1_000,
        nodes: [{ id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" }],
        edges: [],
      }];
      const { send } = await openPanel();
      await send({
        type: "flow:saveTemplate", id: "f1", name: "Ship it",
        choices: [{ nodeId: "n1", mode: "plan", dest: "worktree" }] satisfies DemotionChoice[],
      });
      expect(h.writeTemplate).toHaveBeenCalledTimes(1);
      const t = h.writeTemplate.mock.calls.at(-1)![2] as FlowTemplate;
      expect(t.name).toBe("Ship it");
      expect(t.flow.nodes[0]).toMatchObject({ kind: "planned", mode: "plan", dest: "worktree", ticketKey: "" });
    });

    it("refuses a flow whose id is not in the store", async () => {
      setConfig({ orchestrator: true });
      h.flows = [];
      const { send } = await openPanel();
      await send({ type: "flow:saveTemplate", id: "nope", name: "x", choices: [] });
      expect(h.writeTemplate).not.toHaveBeenCalled();
    });

    it("warns, rather than writing an unusable template, when a place has no demotion choice", async () => {
      setConfig({ orchestrator: true });
      h.flows = [{
        id: "f1", name: "Ship it", armed: false, createdAt: 1_000,
        nodes: [{ id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" }],
        edges: [],
      }];
      const { p, send } = await openPanel();
      await send({ type: "flow:saveTemplate", id: "f1", name: "Ship it", choices: [] });
      expect(h.writeTemplate).not.toHaveBeenCalled();
      const toast = posts(p).find((m) => m.type === "toast");
      expect(toast?.message).toMatch(/no prompt mode and destination chosen/i);
    });

    // The drawer's own button already disables "Save as template…" for this
    // shape (`canBindTicket`, templates.ts) — but that guard lives in a
    // webview, which can be stale (open from before it shipped, or simply not
    // re-rendered), and this handler is the one place that actually writes to
    // disk. Without a refusal here, a command/gate/notify-only flow saves
    // cleanly (`toTemplate` only throws on an EMPTY flow) and then fails
    // `instantiate` at every single future attach, forever.
    it("refuses a flow with no place or planned node — nothing for a saved template to ever bind a ticket to", async () => {
      setConfig({ orchestrator: true });
      h.flows = [{
        id: "f1", name: "Notify only", armed: false, createdAt: 1_000,
        nodes: [{ id: "n1", kind: "notify", x: 0, y: 0, join: "any", message: "done" }],
        edges: [],
      }];
      const { p, send } = await openPanel();
      await send({ type: "flow:saveTemplate", id: "f1", name: "Notify only", choices: [] });
      expect(h.writeTemplate).not.toHaveBeenCalled();
      const toast = posts(p).find((m) => m.type === "toast");
      expect(toast?.message).toMatch(/nothing to bind|no step/i);
    });
  });

  describe("flow:writeTemplate — the canvas's own save, create and update in one message (Task 12b)", () => {
    // A graph the canvas could plausibly have open: one planned node, so
    // `canBindTicket` passes. `id` is deliberately a real-looking flow id —
    // the whole point of the normalization under test is that it never
    // survives into the saved template.
    const okFlow: Flow = {
      id: "canvas-draft", name: "Ship it", armed: true, createdAt: 1_000,
      nodes: [
        { id: "n1", x: 0, y: 0, join: "any", kind: "planned", ticketKey: "", repos: ["aws-ops"], mode: "plan", dest: "worktree" },
      ],
      edges: [],
    };

    it("create (no templateId): mints a fresh, non-built-in id and normalizes the inner flow.id away", async () => {
      setConfig({ orchestrator: true });
      const { send } = await openPanel();
      await send({ type: "flow:writeTemplate", name: "New template", flow: okFlow });
      expect(h.writeTemplate).toHaveBeenCalledTimes(1);
      const t = h.writeTemplate.mock.calls.at(-1)![2] as FlowTemplate;
      expect(t.id).not.toBe("");
      expect(t.id.startsWith("builtin-")).toBe(false);
      expect(t.name).toBe("New template");
      // The inner flow's id is inert (nothing resolves it) and leaking the
      // canvas's real on-disk flow id into a saved template would be
      // misleading — normalized away exactly as `toTemplate` normalizes it.
      expect(t.flow.id).toBe("");
      expect(t.flow.nodes).toEqual(okFlow.nodes);
    });

    // `toTemplate` normalizes a whole set of fields on the inner flow, not just
    // `id` (see `normalizedTemplateFlow`, templates.ts): a template's stored
    // flow is a SHAPE, never a live workflow's history. Fix-round finding:
    // the first cut of this handler only normalized `id`, so the same graph
    // saved through `flow:saveTemplate` and through this new path produced two
    // different stored templates. `launchConfirmedAt`/`commandConfirmedAt`
    // live on `Flow` itself, not on an edge — `instantiate` still strips edge
    // host stamps again on its own copy (`templates.ts:123`), so this is not a
    // consent hole either way, but a stored template carrying any of this is
    // meaningless or misleading state that should never have been written.
    it("normalizes the inner flow like toTemplate does: armed, createdAt, flow-level consent stamps, and every edge's host stamps are all cleared", async () => {
      setConfig({ orchestrator: true });
      const dirtyFlow: Flow = {
        id: "canvas-draft", name: "Ship it", armed: true, createdAt: 1_000,
        launchConfirmedAt: 2_000, commandConfirmedAt: 3_000,
        nodes: [
          { id: "n1", x: 0, y: 0, join: "any", kind: "planned", ticketKey: "", repos: ["aws-ops"], mode: "plan", dest: "worktree" },
        ],
        edges: [
          {
            id: "e1", from: "n1", to: "n1", cond: { kind: "pr-merged" }, action: "launch",
            firedAt: 5_000, firedNote: "done", error: "boom", performed: true,
          },
        ],
      };
      const { send } = await openPanel();
      await send({ type: "flow:writeTemplate", name: "New template", flow: dirtyFlow });
      const t = h.writeTemplate.mock.calls.at(-1)![2] as FlowTemplate;
      expect(t.flow.armed).toBe(false);
      expect(t.flow.createdAt).toBe(0);
      expect(t.flow.launchConfirmedAt).toBeUndefined();
      expect(t.flow.commandConfirmedAt).toBeUndefined();
      const edge = t.flow.edges[0] as FlowEdge;
      expect(edge.firedAt).toBeUndefined();
      expect(edge.firedNote).toBeUndefined();
      expect(edge.error).toBeUndefined();
      expect(edge.performed).toBeUndefined();
      // The condition itself is the user's graph, not host state — it survives.
      expect(edge.cond).toEqual({ kind: "pr-merged" });
    });

    it("update (templateId present and on disk): preserves id and params, replaces name and graph", async () => {
      setConfig({ orchestrator: true });
      h.templates = [mkTemplate("k1", "Old name")];
      const { send } = await openPanel();
      await send({ type: "flow:writeTemplate", templateId: "k1", name: "New name", flow: okFlow });
      expect(h.writeTemplate).toHaveBeenCalledTimes(1);
      const t = h.writeTemplate.mock.calls.at(-1)![2] as FlowTemplate;
      expect(t.id).toBe("k1");
      expect(t.name).toBe("New name");
      expect(t.params).toEqual({});
      expect(t.flow.id).toBe("");
      expect(t.flow.nodes).toEqual(okFlow.nodes);
    });

    it("a templateId that names nothing on disk falls through to create, rather than silently doing nothing", async () => {
      setConfig({ orchestrator: true });
      const { send } = await openPanel();
      await send({ type: "flow:writeTemplate", templateId: "not-on-disk", name: "New template", flow: okFlow });
      expect(h.writeTemplate).toHaveBeenCalledTimes(1);
      const t = h.writeTemplate.mock.calls.at(-1)![2] as FlowTemplate;
      expect(t.id).not.toBe("not-on-disk");
    });

    // A built-in is never on disk, so without the `isBuiltinTemplateId` guard
    // this id would ALSO fall through to the not-on-disk create path above and
    // silently mint a brand new template — a write, not a no-op, and the
    // opposite of "refused". Asserting the specific toast is what tells
    // "refused because built-in" apart from "wrote nothing", so this fails
    // the moment the guard is removed rather than only when writeTemplate is
    // asserted not-called.
    it("refuses a built-in templateId with the specific built-in toast, and writes nothing", async () => {
      setConfig({ orchestrator: true });
      const { p, send } = await openPanel();
      await send({ type: "flow:writeTemplate", templateId: "builtin-ship-it", name: "x", flow: okFlow });
      expect(h.writeTemplate).not.toHaveBeenCalled();
      const toast = posts(p).find((m) => m.type === "toast");
      expect(toast).toMatchObject({
        level: "error",
        message: "That is a built-in template. Duplicate it to make a version you can change.",
      });
    });

    it("refuses a graph with no place or planned node — nothing to ever bind a ticket to — and writes nothing", async () => {
      setConfig({ orchestrator: true });
      const { p, send } = await openPanel();
      const badFlow: Flow = {
        id: "x", name: "Notify only", armed: false, createdAt: 0,
        nodes: [{ id: "n1", x: 0, y: 0, join: "any", kind: "notify", message: "done" }],
        edges: [],
      };
      await send({ type: "flow:writeTemplate", name: "Notify only", flow: badFlow });
      expect(h.writeTemplate).not.toHaveBeenCalled();
      const toast = posts(p).find((m) => m.type === "toast");
      expect(toast?.message).toMatch(/nothing to bind|no step/i);
    });

    it("does nothing when the orchestrator setting is off", async () => {
      setConfig({ orchestrator: false });
      const { send } = await openPanel();
      await send({ type: "flow:writeTemplate", name: "New template", flow: okFlow });
      expect(h.writeTemplate).not.toHaveBeenCalled();
    });
  });

  describe("flow:renameTemplate, flow:deleteTemplate, flow:duplicateTemplate (Task 8)", () => {
    it("flow:renameTemplate changes only the name", async () => {
      setConfig({ orchestrator: true });
      h.templates = [mkTemplate("k1", "old")];
      const { send } = await openPanel();
      await send({ type: "flow:renameTemplate", templateId: "k1", name: "Ship the migration" });
      expect(h.writeTemplate.mock.calls.at(-1)![2]).toMatchObject({ id: "k1", name: "Ship the migration" });
    });

    it("flow:renameTemplate ignores an id it does not have", async () => {
      setConfig({ orchestrator: true });
      h.templates = [mkTemplate("k1", "old")];
      const { send } = await openPanel();
      await send({ type: "flow:renameTemplate", templateId: "nope", name: "x" });
      expect(h.writeTemplate).not.toHaveBeenCalled();
    });

    // A built-in has no file on disk to overwrite, so "ignores an unknown id"
    // (above) is not the same refusal as "recognized this as a built-in and
    // refused on purpose" — both leave `writeTemplate` uncalled. Asserting the
    // specific toast is what tells them apart: without the
    // `isBuiltinTemplateId` guard in the handler, this would fall through to
    // the ordinary not-found path (`existing` is undefined for a builtin- id,
    // since `readTemplates` never returns one) and post no toast at all, so
    // this test fails the moment the guard is removed.
    it("refuses to rename a built-in starter, with the specific built-in toast", async () => {
      setConfig({ orchestrator: true });
      const { p, send } = await openPanel();
      await send({ type: "flow:renameTemplate", templateId: "builtin-ship-it", name: "My ship it" });
      expect(h.writeTemplate).not.toHaveBeenCalled();
      const toast = posts(p).find((m) => m.type === "toast");
      expect(toast).toMatchObject({
        level: "error",
        message: "That is a built-in template. Duplicate it to make a version you can change.",
      });
    });

    it("flow:deleteTemplate leaves workflows already made from it alone", async () => {
      setConfig({ orchestrator: true });
      h.templates = [mkTemplate("k1", "Ship it")];
      h.flows = [{ ...mkFlow("f1", "Ship it"), fromTemplate: "k1" }];
      const { send } = await openPanel();
      await send({ type: "flow:deleteTemplate", templateId: "k1" });
      expect(h.removeTemplate).toHaveBeenCalledWith(expect.anything(), "/templates", "k1");
      expect(h.removeFlow).not.toHaveBeenCalled();
    });

    it("flow:deleteTemplate ignores an id it does not have", async () => {
      setConfig({ orchestrator: true });
      h.templates = [mkTemplate("k1", "Ship it")];
      const { send } = await openPanel();
      await send({ type: "flow:deleteTemplate", templateId: "nope" });
      expect(h.removeTemplate).not.toHaveBeenCalled();
    });

    // Same reasoning as the rename refusal above: a built-in is not on disk,
    // so "ignores an unknown id" and "refused because it is a built-in" both
    // leave `removeTemplate` uncalled — only the specific toast tells them
    // apart, and only that assertion fails when the guard is removed.
    it("refuses to delete a built-in starter, with the specific built-in toast", async () => {
      setConfig({ orchestrator: true });
      const { p, send } = await openPanel();
      await send({ type: "flow:deleteTemplate", templateId: "builtin-ship-it" });
      expect(h.removeTemplate).not.toHaveBeenCalled();
      const toast = posts(p).find((m) => m.type === "toast");
      expect(toast).toMatchObject({
        level: "error",
        message: "That is a built-in template. Duplicate it to make a version you can change.",
      });
    });

    it("flow:duplicateTemplate writes a copy whose name is derived from, but different from, the original", async () => {
      setConfig({ orchestrator: true });
      h.templates = [mkTemplate("k1", "Ship it")];
      const { send } = await openPanel();
      await send({ type: "flow:duplicateTemplate", templateId: "k1" });
      expect(h.writeTemplate).toHaveBeenCalledTimes(1);
      const written = h.writeTemplate.mock.calls.at(-1)![2] as FlowTemplate;
      // The one thing worth pinning about the name: it is NOT a verbatim copy
      // (that would be indistinguishable from forgetting to rename it) but it
      // still reads as "Ship it" plus something, not an unrelated string.
      expect(written.name).not.toBe("Ship it");
      expect(written.name).toContain("Ship it");
      // A duplicate, not a rename-in-place: the original template is untouched.
      expect(h.templates.some((t) => t.id === "k1" && t.name === "Ship it")).toBe(true);
    });

    it("flow:duplicateTemplate ignores an id it does not have", async () => {
      setConfig({ orchestrator: true });
      const { send } = await openPanel();
      await send({ type: "flow:duplicateTemplate", templateId: "nope" });
      expect(h.writeTemplate).not.toHaveBeenCalled();
    });

    // The other half of the bug this task fixes: `flow:duplicateTemplate` used
    // the same disk-only lookup `flow:attach` did, so "Duplicate it to make a
    // version you can change" — the very message the refusal toasts above
    // advertise — silently did nothing for a built-in. `allTemplates()` is
    // deliberately NOT guarded on `isBuiltinTemplateId` here: duplicating a
    // built-in is the supported path to owning one, not a refusal.
    it("duplicates a built-in starter into an ordinary user template with a fresh, non-builtin id", async () => {
      setConfig({ orchestrator: true });
      const { send } = await openPanel();
      await send({ type: "flow:duplicateTemplate", templateId: "builtin-ship-it" });
      expect(h.writeTemplate).toHaveBeenCalledTimes(1);
      const written = h.writeTemplate.mock.calls.at(-1)![2] as FlowTemplate;
      // Not the built-in's own id — `newFlowId` mints a fresh one, always
      // prefixed "f…", never `builtin-` (flowIo.ts).
      expect(written.id).not.toMatch(/^builtin-/);
      expect(written.id).not.toBe("builtin-ship-it");
      expect(written.name).not.toBe("Ship it");
      expect(written.name).toContain("Ship it");
    });

    it("flow:duplicateTemplate refuses to write rather than clobber when every re-mint collides", async () => {
      // The same bound flow:create's equivalent test pins: 9 attempts (one plus
      // eight retries) against the deterministic counter mock. Seeding all nine
      // ids as already taken makes exhaustion the only path left.
      setConfig({ orchestrator: true });
      h.templates = Array.from({ length: 9 }, (_, i) => mkTemplate(`fTEST-${i + 1}`, `taken ${i + 1}`));
      const { send } = await openPanel();
      await send({ type: "flow:duplicateTemplate", templateId: "fTEST-1" });
      expect(h.writeTemplate).not.toHaveBeenCalled();
      // And nothing already on disk was disturbed.
      expect(h.templates.map((t) => t.name)).toEqual(
        Array.from({ length: 9 }, (_, i) => `taken ${i + 1}`),
      );
    });
  });

  it("deck:flows carries templates alongside flows", async () => {
    setConfig({ orchestrator: true });
    h.templates = [mkTemplate("k1", "Ship it")];
    const { p } = await openPanel();
    const msg = posts(p).find((m) => m.type === "deck:flows") as { templates: FlowTemplate[] };
    // Was `.map((t) => t.name)).toEqual(["Ship it"])` before the built-in
    // starters (Task 5) were prepended to this list. That assertion is now
    // ambiguous two ways over: it would also pass with three starters plus
    // this disk template counted wrong, and the built-in named "Ship it"
    // (starters.ts) collides by name with this fixture's own "Ship it" — so a
    // name-based list no longer identifies which "Ship it" is which. Asserting
    // on ids instead disambiguates the collision and still pins the on-disk
    // template's presence (and position, last) exactly, the same way the old
    // assertion pinned `["Ship it"]` exactly.
    expect(msg.templates.map((t) => t.id)).toEqual([...STARTERS.map((s) => s.id), "k1"]);
  });

  it("empties templates alongside flows when the setting is off", async () => {
    setConfig({ orchestrator: false });
    h.templates = [mkTemplate("k1", "Ship it")];
    const { p } = await openPanel();
    const msg = posts(p).find((m) => m.type === "deck:flows") as { templates: FlowTemplate[] };
    expect(msg.templates).toEqual([]);
  });

  it("serves the built-in starters alongside the user's own templates", async () => {
    setConfig({ orchestrator: true });
    h.templates = [mkTemplate("k1", "Ship it")];
    const { p } = await openPanel();
    const msg = posts(p).find((m) => m.type === "deck:flows") as { templates: FlowTemplate[] };
    expect(msg.templates.map((t) => t.id)).toEqual(
      expect.arrayContaining(["builtin-ship-it", "builtin-test-and-merge", "builtin-review-only"]),
    );
  });

  it("serves no starters at all when the orchestrator setting is off", async () => {
    // Starters follow `flows` and `pendingResume`: with the setting off there
    // is nothing to attach, and silence must not read as "not loaded yet".
    setConfig({ orchestrator: false });
    const { p } = await openPanel();
    const msg = posts(p).find((m) => m.type === "deck:flows") as { templates: FlowTemplate[] };
    expect(msg.templates).toEqual([]);
  });

  it("ignores every attach/detach/template message when the setting is off", async () => {
    setConfig({ orchestrator: false });
    h.templates = [mkTemplate("k1", "Ship it")];
    h.flows = [mkFlow("f1", "n")];
    const { send } = await openPanel();
    await send({ type: "flow:attach", runKey: "PROJ-1", templateId: "k1" });
    await send({ type: "flow:detach", id: "f1" });
    await send({ type: "flow:saveTemplate", id: "f1", name: "x", choices: [] });
    await send({ type: "flow:renameTemplate", templateId: "k1", name: "x" });
    await send({ type: "flow:deleteTemplate", templateId: "k1" });
    await send({ type: "flow:duplicateTemplate", templateId: "k1" });
    expect(h.writeFlow).not.toHaveBeenCalled();
    expect(h.removeFlow).not.toHaveBeenCalled();
    expect(h.writeTemplate).not.toHaveBeenCalled();
    expect(h.removeTemplate).not.toHaveBeenCalled();
  });

  describe("flow:addPlanned — the missing ticket picker (Task 4b)", () => {
    // `openPanel()` above defaults to an UNAUTHENTICATED connector (`show()`'s
    // own default), which is exactly right for every other flow:* handler —
    // none of them ever touch the connector — but wrong for this one. Every
    // test below that means to get past the auth gate needs its own panel.
    const openAuthedPanel = async () => {
      show(true);
      await settled();
      const p = lastPanel();
      return { p, send: async (m: unknown) => { await p._fire(m); await settled(); } };
    };

    const TASK = {
      key: "PROJ-9", summary: "Ship the migration", status: "", statusCategory: "new" as const, priority: "",
      assignee: "Unassigned", labels: [], components: [], sprint: null, inOpenSprint: false,
      updated: "", url: "https://jira/browse/PROJ-9", estimateSeconds: null,
    };
    const REPO = { name: "aws-ops", path: "/repos/aws-ops", isGit: true };
    // The real default, unset by any test — resolveModes falls back to it with
    // no setConfig override needed, exactly as the earlier promptModes test
    // (line ~2918) already relies on.
    const MODE = DEFAULT_PROMPT_MODES[0];

    const quickPick = () => window.showQuickPick as ReturnType<typeof vi.fn>;

    /** Script all four pickers to succeed, in ticket → repos → mode → dest order. */
    const pickAllFour = () => {
      quickPick()
        .mockResolvedValueOnce({ label: TASK.key, description: TASK.summary, task: TASK })
        .mockResolvedValueOnce([{ label: REPO.name, detail: REPO.path, repo: REPO }])
        .mockResolvedValueOnce({ label: MODE.label, detail: MODE.detail, mode: MODE })
        .mockResolvedValueOnce({ label: "Worktree", dest: "worktree" });
    };

    it("asks ticket, repos, mode, then destination, and appends a planned node carrying all four answers", async () => {
      setConfig({ orchestrator: true });
      h.flows = [mkFlow("f1", "Ship it")];
      h.discoverRepos.mockReturnValueOnce([REPO]);
      pickAllFour();
      const { send } = await openAuthedPanel();
      await send({ type: "flow:addPlanned", id: "f1" });
      expect(quickPick()).toHaveBeenCalledTimes(4);
      const saved = h.writeFlow.mock.calls.at(-1)![2] as Flow;
      expect(saved.nodes).toHaveLength(1);
      expect(saved.nodes[0]).toMatchObject({
        kind: "planned", join: "any", ticketKey: "PROJ-9", repos: ["aws-ops"], mode: MODE.id, dest: "worktree",
      });
    });

    it("posts the flow it just appended to, so the drawer sees the new node", async () => {
      setConfig({ orchestrator: true });
      h.flows = [mkFlow("f1", "Ship it")];
      h.discoverRepos.mockReturnValueOnce([REPO]);
      pickAllFour();
      const { p, send } = await openAuthedPanel();
      await send({ type: "flow:addPlanned", id: "f1" });
      const msg = posts(p).filter((m) => m.type === "deck:flows").at(-1) as { flows: Flow[] };
      expect(msg.flows.find((f) => f.id === "f1")?.nodes).toHaveLength(1);
    });

    it("cancelling the ticket picker writes nothing and never opens the repos, mode, or destination picker", async () => {
      setConfig({ orchestrator: true });
      h.flows = [mkFlow("f1", "n")];
      quickPick().mockResolvedValueOnce(undefined); // ticket picker dismissed
      const { send } = await openAuthedPanel();
      await send({ type: "flow:addPlanned", id: "f1" });
      expect(quickPick()).toHaveBeenCalledTimes(1);
      expect(h.writeFlow).not.toHaveBeenCalled();
    });

    it("cancelling the repos picker writes nothing and never opens the mode or destination picker", async () => {
      setConfig({ orchestrator: true });
      h.flows = [mkFlow("f1", "n")];
      quickPick()
        .mockResolvedValueOnce({ label: TASK.key, task: TASK })
        .mockResolvedValueOnce(undefined); // repos picker dismissed
      const { send } = await openAuthedPanel();
      await send({ type: "flow:addPlanned", id: "f1" });
      expect(quickPick()).toHaveBeenCalledTimes(2);
      expect(h.writeFlow).not.toHaveBeenCalled();
    });

    it("picking no repos at all (an empty multi-select) is treated as a cancel, and writes nothing", async () => {
      setConfig({ orchestrator: true });
      h.flows = [mkFlow("f1", "n")];
      quickPick()
        .mockResolvedValueOnce({ label: TASK.key, task: TASK })
        .mockResolvedValueOnce([]); // Enter with nothing toggled on
      const { send } = await openAuthedPanel();
      await send({ type: "flow:addPlanned", id: "f1" });
      expect(quickPick()).toHaveBeenCalledTimes(2);
      expect(h.writeFlow).not.toHaveBeenCalled();
    });

    it("cancelling the prompt-mode picker writes nothing and never opens the destination picker", async () => {
      setConfig({ orchestrator: true });
      h.flows = [mkFlow("f1", "n")];
      quickPick()
        .mockResolvedValueOnce({ label: TASK.key, task: TASK })
        .mockResolvedValueOnce([{ label: REPO.name, repo: REPO }])
        .mockResolvedValueOnce(undefined); // mode picker dismissed
      const { send } = await openAuthedPanel();
      await send({ type: "flow:addPlanned", id: "f1" });
      expect(quickPick()).toHaveBeenCalledTimes(3);
      expect(h.writeFlow).not.toHaveBeenCalled();
    });

    it("cancelling the destination picker writes nothing, even with every other answer already given", async () => {
      setConfig({ orchestrator: true });
      h.flows = [mkFlow("f1", "n")];
      quickPick()
        .mockResolvedValueOnce({ label: TASK.key, task: TASK })
        .mockResolvedValueOnce([{ label: REPO.name, repo: REPO }])
        .mockResolvedValueOnce({ label: MODE.label, mode: MODE })
        .mockResolvedValueOnce(undefined); // destination picker dismissed
      const { send } = await openAuthedPanel();
      await send({ type: "flow:addPlanned", id: "f1" });
      expect(quickPick()).toHaveBeenCalledTimes(4);
      expect(h.writeFlow).not.toHaveBeenCalled();
    });

    it("toasts and writes nothing when the connector is not authenticated, without opening any picker", async () => {
      setConfig({ orchestrator: true });
      h.flows = [mkFlow("f1", "n")];
      // openPanel() (the outer describe's helper) is the unauthenticated default.
      const { p, send } = await openPanel();
      await send({ type: "flow:addPlanned", id: "f1" });
      expect(quickPick()).not.toHaveBeenCalled();
      expect(h.writeFlow).not.toHaveBeenCalled();
      expect(posts(p)).toContainEqual(
        expect.objectContaining({ type: "toast", level: "error", message: expect.stringContaining("Sign in") }),
      );
    });

    it("toasts and writes nothing when the connector has no tickets to offer, without opening any picker", async () => {
      setConfig({ orchestrator: true });
      h.flows = [mkFlow("f1", "n")];
      h.taskList.mockResolvedValueOnce([]);
      const { p, send } = await openAuthedPanel();
      await send({ type: "flow:addPlanned", id: "f1" });
      expect(quickPick()).not.toHaveBeenCalled();
      expect(h.writeFlow).not.toHaveBeenCalled();
      expect(posts(p)).toContainEqual(
        expect.objectContaining({ type: "toast", level: "error", message: expect.stringContaining("No tickets") }),
      );
    });

    it("toasts and writes nothing when there are no repos to offer, after the ticket is already picked", async () => {
      // Same dead-end as an unauthenticated connector or an empty ticket list: a
      // picker the user can only dismiss, with nothing said about why. Named the
      // same way tasksView.ts's explore()/resolveKickoffTarget already do for the
      // identical cause, so this reads as familiar rather than a new phrasing.
      setConfig({ orchestrator: true });
      h.flows = [mkFlow("f1", "n")];
      quickPick().mockResolvedValueOnce({ label: TASK.key, task: TASK }); // ticket answered
      // Not mockReturnValueOnce: the panel's own initial refresh calls
      // discoverRepos before this message is even sent (e.g. for review-request
      // decoration), and a "once" stub would be consumed by that call instead of
      // addPlanned's. h.repos backs discoverRepos's default implementation for
      // every call in this test.
      h.repos = [];
      const { p, send } = await openAuthedPanel();
      await send({ type: "flow:addPlanned", id: "f1" });
      // Only the ticket picker opened — the repos step never got as far as a
      // QuickPick with nothing in it.
      expect(quickPick()).toHaveBeenCalledTimes(1);
      expect(h.writeFlow).not.toHaveBeenCalled();
      expect(posts(p)).toContainEqual(
        expect.objectContaining({
          type: "toast", level: "error",
          message: "No repos found under /repos. Check agentFlow.reposRoot.",
        }),
      );
    });

    it("refuses when the flow was deleted while the pickers were open", async () => {
      // The same re-read-before-write every other flow:* handler in this file
      // does: the four modals were up long enough for another window (or a
      // flow:delete from this one) to remove the flow entirely.
      setConfig({ orchestrator: true });
      h.flows = []; // "f1" is not on disk by the time the write would happen
      pickAllFour();
      const { send } = await openAuthedPanel();
      await send({ type: "flow:addPlanned", id: "f1" });
      expect(h.writeFlow).not.toHaveBeenCalled();
    });

    it("positions the new node the way the tray's own drop path does, so it never lands on an existing node", async () => {
      setConfig({ orchestrator: true });
      h.flows = [{
        ...mkFlow("f1", "n"),
        nodes: [
          { id: "n1", kind: "place", x: 24, y: 24, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
          { id: "n2", kind: "notify", x: 24, y: 112, join: "any", message: "hi" },
        ],
      }];
      pickAllFour();
      const { send } = await openAuthedPanel();
      await send({ type: "flow:addPlanned", id: "f1" });
      const saved = h.writeFlow.mock.calls.at(-1)![2] as Flow;
      const added = saved.nodes.find((n) => n.kind === "planned")!;
      // The same fixed formula OrchestratorDrawer.tsx's tray-drop `attachAt`
      // call uses: `24, 24 + flow.nodes.length * 88` — two existing nodes puts
      // this one at y=200, past both.
      expect(added.x).toBe(24);
      expect(added.y).toBe(200);
      expect(saved.nodes.some((n) => n.id !== added.id && n.x === added.x && n.y === added.y)).toBe(false);
    });

    // `addPlanned` returns `true` only once the node is actually written — every
    // early return below is a refusal — and the `flow_action{add_planned}` emit
    // in the switch case rides on that return, not on the message merely having
    // arrived. One control (the node lands) plus one refusal per distinct early
    // return proves the boolean is threaded correctly at every site, not just
    // the first.
    describe("flow_action{add_planned} fires only once the node actually lands", () => {
      it("emits it once the node is appended", async () => {
        setConfig({ orchestrator: true });
        h.flows = [mkFlow("f1", "Ship it")];
        h.discoverRepos.mockReturnValueOnce([REPO]);
        pickAllFour();
        const { send } = await openAuthedPanel();
        trackSpy.mockClear();
        await send({ type: "flow:addPlanned", id: "f1" });
        expect(trackSpy.mock.calls.flat().filter((e: any) => e.name === "flow_action")).toEqual([
          { name: "flow_action", action: "add_planned" },
        ]);
      });

      it("stays silent when the connector is not authenticated", async () => {
        setConfig({ orchestrator: true });
        h.flows = [mkFlow("f1", "n")];
        const { send } = await openPanel(); // the outer describe's unauthenticated default
        trackSpy.mockClear();
        await send({ type: "flow:addPlanned", id: "f1" });
        expect(trackSpy.mock.calls.flat().filter((e: any) => e.name === "flow_action")).toEqual([]);
      });

      it("stays silent when the connector has no tickets to offer", async () => {
        setConfig({ orchestrator: true });
        h.flows = [mkFlow("f1", "n")];
        h.taskList.mockResolvedValueOnce([]);
        const { send } = await openAuthedPanel();
        trackSpy.mockClear();
        await send({ type: "flow:addPlanned", id: "f1" });
        expect(trackSpy.mock.calls.flat().filter((e: any) => e.name === "flow_action")).toEqual([]);
      });

      it("stays silent when the ticket picker is cancelled", async () => {
        setConfig({ orchestrator: true });
        h.flows = [mkFlow("f1", "n")];
        quickPick().mockResolvedValueOnce(undefined);
        const { send } = await openAuthedPanel();
        trackSpy.mockClear();
        await send({ type: "flow:addPlanned", id: "f1" });
        expect(trackSpy.mock.calls.flat().filter((e: any) => e.name === "flow_action")).toEqual([]);
      });

      it("stays silent when no repos are picked (an empty multi-select)", async () => {
        setConfig({ orchestrator: true });
        h.flows = [mkFlow("f1", "n")];
        quickPick()
          .mockResolvedValueOnce({ label: TASK.key, task: TASK })
          .mockResolvedValueOnce([]);
        const { send } = await openAuthedPanel();
        trackSpy.mockClear();
        await send({ type: "flow:addPlanned", id: "f1" });
        expect(trackSpy.mock.calls.flat().filter((e: any) => e.name === "flow_action")).toEqual([]);
      });

      it("stays silent when the prompt-mode picker is cancelled", async () => {
        setConfig({ orchestrator: true });
        h.flows = [mkFlow("f1", "n")];
        quickPick()
          .mockResolvedValueOnce({ label: TASK.key, task: TASK })
          .mockResolvedValueOnce([{ label: REPO.name, repo: REPO }])
          .mockResolvedValueOnce(undefined);
        const { send } = await openAuthedPanel();
        trackSpy.mockClear();
        await send({ type: "flow:addPlanned", id: "f1" });
        expect(trackSpy.mock.calls.flat().filter((e: any) => e.name === "flow_action")).toEqual([]);
      });

      it("stays silent when the destination picker is cancelled, even with every other answer already given", async () => {
        setConfig({ orchestrator: true });
        h.flows = [mkFlow("f1", "n")];
        quickPick()
          .mockResolvedValueOnce({ label: TASK.key, task: TASK })
          .mockResolvedValueOnce([{ label: REPO.name, repo: REPO }])
          .mockResolvedValueOnce({ label: MODE.label, mode: MODE })
          .mockResolvedValueOnce(undefined);
        const { send } = await openAuthedPanel();
        trackSpy.mockClear();
        await send({ type: "flow:addPlanned", id: "f1" });
        expect(trackSpy.mock.calls.flat().filter((e: any) => e.name === "flow_action")).toEqual([]);
      });

      it("stays silent when the flow was deleted while the pickers were open", async () => {
        setConfig({ orchestrator: true });
        h.flows = [];
        pickAllFour();
        const { send } = await openAuthedPanel();
        trackSpy.mockClear();
        await send({ type: "flow:addPlanned", id: "f1" });
        expect(trackSpy.mock.calls.flat().filter((e: any) => e.name === "flow_action")).toEqual([]);
      });
    });
  });

  describe("flow:saveCommand — keeping a free-text command in settings", () => {
    const commands = () => workspace.getConfiguration().get("commands") as any[];

    it("appends the command to agentFlow.commands under a slugged id", async () => {
      setConfig({ orchestrator: true, commands: [{ id: "smoke", label: "Smoke", run: "npm run smoke" }] });
      const { send } = await openPanel();
      await send({ type: "flow:saveCommand", run: "deploy.sh --env=staging", label: "Deploy to staging" });
      expect(commands()).toEqual([
        { id: "smoke", label: "Smoke", run: "npm run smoke" },
        { id: "deploy-to-staging", label: "Deploy to staging", run: "deploy.sh --env=staging" },
      ]);
    });

    it("seeds an untouched setting from the shipped default, so the picker never LOSES an entry", async () => {
      // An explicit array REPLACES the default (see readCommands), so writing
      // `[mine]` would silently drop the example the user is looking at out of the
      // very picker they just used.
      setConfig({ orchestrator: true });
      const { send } = await openPanel();
      await send({ type: "flow:saveCommand", run: "deploy.sh", label: "Deploy" });
      expect(commands()).toEqual([
        ...DEFAULT_COMMANDS,
        { id: "deploy", label: "Deploy", run: "deploy.sh" },
      ]);
    });

    it("writes to the scope the user's own value lives in, never promoting it to global", async () => {
      // The rule modesNotice's hide-write already follows. A workspace list of
      // repo-specific deploy commands promoted to global would follow the user
      // into every other project they open.
      setConfig({ orchestrator: true, commands: [] });
      setConfigScope("commands", "workspace");
      const { send } = await openPanel();
      await send({ type: "flow:saveCommand", run: "deploy.sh", label: "Deploy" });
      expect(configUpdateTargets.commands).toBe(ConfigurationTarget.Workspace);
    });

    it("writes to global when the setting is untouched", async () => {
      setConfig({ orchestrator: true });
      const { send } = await openPanel();
      await send({ type: "flow:saveCommand", run: "deploy.sh", label: "Deploy" });
      expect(configUpdateTargets.commands).toBe(ConfigurationTarget.Global);
    });

    it("names what it saved, so the picker's new entry is findable", async () => {
      setConfig({ orchestrator: true });
      const { p, send } = await openPanel();
      await send({ type: "flow:saveCommand", run: "deploy.sh", label: "Deploy to staging" });
      expect(posts(p)).toContainEqual(
        expect.objectContaining({ type: "toast", message: expect.stringContaining("Deploy to staging") }),
      );
    });

    it("re-posts the flows message, so the drawer's picker holds the entry immediately", async () => {
      // The config-change listener would eventually do this, but not
      // synchronously — and the toast says "saved" now. What the payload CARRIES
      // is not assertable here: this file stubs `getConfig()` (see the vi.mock at
      // the top) and feeds `commands` from its own fixture, so the settings write
      // itself is pinned by the append tests above instead.
      setConfig({ orchestrator: true });
      const { p, send } = await openPanel();
      const before = posts(p).filter((m) => m.type === "deck:flows").length;
      await send({ type: "flow:saveCommand", run: "deploy.sh", label: "Deploy" });
      expect(posts(p).filter((m) => m.type === "deck:flows").length).toBeGreaterThan(before);
    });

    it("posts no flows message when the write failed", async () => {
      // The other half of the same claim: a re-post says "the picker changed", and
      // it must not say that when nothing was written.
      setConfig({ orchestrator: true });
      const { p, send } = await openPanel();
      const factory = workspace.getConfiguration.getMockImplementation()!;
      workspace.getConfiguration.mockImplementation((section?: string) => {
        const c = factory(section);
        (c.update as any).mockRejectedValue(new Error("EROFS"));
        return c;
      });
      const before = posts(p).filter((m) => m.type === "deck:flows").length;
      await send({ type: "flow:saveCommand", run: "deploy.sh", label: "Deploy" });
      expect(posts(p).filter((m) => m.type === "deck:flows").length).toBe(before);
    });

    it("says a command is already saved rather than writing a second copy", async () => {
      setConfig({ orchestrator: true, commands: [{ id: "d", label: "Deploy to staging", run: "deploy.sh" }] });
      const { p, send } = await openPanel();
      await send({ type: "flow:saveCommand", run: "deploy.sh", label: "Ship it" });
      expect(commands()).toHaveLength(1);
      expect(posts(p)).toContainEqual(
        expect.objectContaining({ type: "toast", message: expect.stringContaining("Already saved as") }),
      );
    });

    it("refuses a save with no name, and says so rather than writing a nameless entry", async () => {
      // Unreachable from the drawer, which disables Save without a name. This is a
      // message handler: the webview is not the only thing that can post one.
      setConfig({ orchestrator: true, commands: [] });
      const { p, send } = await openPanel();
      await send({ type: "flow:saveCommand", run: "deploy.sh", label: "  " });
      expect(commands()).toEqual([]);
      expect(posts(p)).toContainEqual(
        expect.objectContaining({ type: "toast", message: expect.stringContaining("needs a name") }),
      );
    });

    it("replaces a non-array value in the scope that holds it, rather than appending to it", async () => {
      // A hand-edited settings.json can put anything under the key. There is
      // nothing to append to — but the user's configuration still lives in that
      // scope, so the replacement belongs there too.
      setConfig({ orchestrator: true, commands: "not a list" });
      setConfigScope("commands", "workspace");
      const { send } = await openPanel();
      await send({ type: "flow:saveCommand", run: "deploy.sh", label: "Deploy" });
      expect(commands()).toEqual([
        ...DEFAULT_COMMANDS,
        { id: "deploy", label: "Deploy", run: "deploy.sh" },
      ]);
      expect(configUpdateTargets.commands).toBe(ConfigurationTarget.Workspace);
    });

    it("says so when the settings write itself fails, instead of looking like it saved", async () => {
      setConfig({ orchestrator: true });
      const { p, send } = await openPanel();
      // `getConfiguration()` hands back a FRESH stub per call, so mocking `update`
      // on a handle this test holds would not be the handle the panel writes
      // through. Wrap the factory instead, leaving everything else about it intact.
      const factory = workspace.getConfiguration.getMockImplementation()!;
      workspace.getConfiguration.mockImplementation((section?: string) => {
        const c = factory(section);
        (c.update as any).mockRejectedValue(new Error("EROFS"));
        return c;
      });
      await send({ type: "flow:saveCommand", run: "deploy.sh", label: "Deploy" });
      expect(posts(p)).toContainEqual(
        expect.objectContaining({ type: "toast", level: "error", message: expect.stringContaining("EROFS") }),
      );
    });

    it("writes nothing when the orchestrator setting is off", async () => {
      setConfig({ orchestrator: false, commands: [] });
      const { send } = await openPanel();
      await send({ type: "flow:saveCommand", run: "deploy.sh", label: "Deploy" });
      expect(commands()).toEqual([]);
    });

    // `saveCommand` returns `true` only once the config write actually lands —
    // "invalid", "duplicate", and a failed `update()` are all refusals, each with
    // its own toast already saying nothing happened — and the switch case's
    // `flow_action{save_command}` emit rides on that return. The success side of
    // this claim is already covered by "emits a flow_action for each flow
    // gesture that did something" above (in the `orchestrator telemetry`
    // describe further down this file), which includes `flow:saveCommand` in its
    // sequence.
    describe("flow_action{save_command} stays silent on every refusal", () => {
      it("stays silent on a blank label", async () => {
        setConfig({ orchestrator: true, commands: [] });
        const { send } = await openPanel();
        trackSpy.mockClear();
        await send({ type: "flow:saveCommand", run: "deploy.sh", label: "  " });
        expect(trackSpy.mock.calls.flat().filter((e: any) => e.name === "flow_action")).toEqual([]);
      });

      it("stays silent on a duplicate command", async () => {
        setConfig({ orchestrator: true, commands: [{ id: "d", label: "Deploy to staging", run: "deploy.sh" }] });
        const { send } = await openPanel();
        trackSpy.mockClear();
        await send({ type: "flow:saveCommand", run: "deploy.sh", label: "Ship it" });
        expect(trackSpy.mock.calls.flat().filter((e: any) => e.name === "flow_action")).toEqual([]);
      });

      it("stays silent when the settings write itself fails", async () => {
        setConfig({ orchestrator: true });
        const { send } = await openPanel();
        const factory = workspace.getConfiguration.getMockImplementation()!;
        workspace.getConfiguration.mockImplementation((section?: string) => {
          const c = factory(section);
          (c.update as any).mockRejectedValue(new Error("EROFS"));
          return c;
        });
        trackSpy.mockClear();
        await send({ type: "flow:saveCommand", run: "deploy.sh", label: "Deploy" });
        expect(trackSpy.mock.calls.flat().filter((e: any) => e.name === "flow_action")).toEqual([]);
      });
    });
  });
});

describe("an armed flow advances on refresh", () => {
  /** Open a panel and return it plus a way to deliver an inbound message — the
   * same `show()` + `settled()` + `_fire` idiom every other describe block in
   * this file uses, rather than reaching into `webview.onDidReceiveMessage`
   * directly. */
  const openPanel = async () => {
    show();
    await settled();
    const p = lastPanel();
    return { p, send: async (m: unknown) => { await p._fire(m); await settled(); } };
  };

  /** A place node plus a notify terminal, wired with one condition. */
  const armedFlow = (over: Partial<Flow> = {}): Flow => ({
    ...mkFlow("f1", "Ship the migration"),
    armed: true,
    nodes: [
      { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
      { id: "n2", kind: "notify", x: 0, y: 0, join: "any", message: "the migration has landed" },
    ],
    edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" }],
    ...over,
  });

  it("posts the stamped flow on deck:flows in the SAME pass it fired, not one poll later", async () => {
    // advanceArmedFlows writes before postFlows() reads — that ordering is the
    // whole point of doing this work inline in refresh() rather than on its own
    // timer. If the two lines were ever swapped, postFlows() would read the
    // store before this pass's write landed, and the webview would show the
    // rule as still pending for one extra poll tick.
    setConfig({ orchestrator: true });
    h.flows = [armedFlow()];
    // Warm the resume gate first (Task 4): a first pass that finds nothing
    // ready clears it without ever needing an approval, leaving the very next
    // pass to fire in the ordinary way this test is actually about.
    h.buildRunStatus.mockReturnValue(openStatus("PROJ-1", "aws-ops"));
    const { p, send } = await openPanel();
    await settle();
    h.buildRunStatus.mockReturnValue(mergedStatus("PROJ-1", "aws-ops"));
    await send({ type: "deck:refresh" });
    const msg = posts(p).filter((m) => m.type === "deck:flows").at(-1) as { flows: Flow[] } | undefined;
    expect(msg?.flows[0]?.edges[0]?.firedAt).toBeTypeOf("number");
  });

  it("stamps a met rule and notifies naming the flow, not as a webview toast", async () => {
    // A fired notify has to reach the human even when the Deck panel is not the
    // focused tab — a webview toast is invisible then. `showInformationMessage`
    // persists in the Notifications bell instead.
    setConfig({ orchestrator: true });
    h.flows = [armedFlow()];
    // Warm the resume gate first (Task 4) — see the test above.
    h.buildRunStatus.mockReturnValue(openStatus("PROJ-1", "aws-ops"));
    const { p, send } = await openPanel();
    await settle();
    // The status the evaluator will see: PROJ-1's aws-ops PR is merged.
    h.buildRunStatus.mockReturnValue(mergedStatus("PROJ-1", "aws-ops"));
    await send({ type: "deck:refresh" });
    const written = h.writeFlow.mock.calls.at(-1)?.[2] as Flow | undefined;
    expect(written?.edges[0].firedAt).toBeTypeOf("number");
    expect(window.showInformationMessage).toHaveBeenCalledWith(expect.stringMatching(/Ship the migration/));
    expect(posts(p).some((m) => m.type === "toast" && /Ship the migration/.test(m.message ?? ""))).toBe(false);
    // A notify telling you something is not a failure, and must not borrow the
    // red-error notification reserved for a rule that actually failed.
    expect(window.showErrorMessage).not.toHaveBeenCalled();
  });

  it("fires once and not again on the next refresh", async () => {
    setConfig({ orchestrator: true });
    h.flows = [armedFlow()];
    // Warm the resume gate first (Task 4) — see the test above.
    h.buildRunStatus.mockReturnValue(openStatus("PROJ-1", "aws-ops"));
    const { send } = await openPanel();
    await settle();
    h.buildRunStatus.mockReturnValue(mergedStatus("PROJ-1", "aws-ops"));
    await send({ type: "deck:refresh" });
    // The store now returns the stamped flow, as it would on disk.
    h.flows = [h.writeFlow.mock.calls.at(-1)![2] as Flow];
    h.writeFlow.mockClear();
    // A real third poll tick, not just draining microtasks — nothing here
    // advances the panel's own 6s timer, so each pass has to be asked for.
    await send({ type: "deck:refresh" });
    expect(h.writeFlow).not.toHaveBeenCalled();
  });

  it("does nothing for a disarmed flow whose condition is met", async () => {
    setConfig({ orchestrator: true });
    h.flows = [armedFlow({ armed: false })];
    h.buildRunStatus.mockReturnValue(mergedStatus("PROJ-1", "aws-ops"));
    await openPanel();
    await settle();
    expect(h.writeFlow).not.toHaveBeenCalled();
  });

  it("does nothing when the setting is off, even for an armed flow", async () => {
    setConfig({ orchestrator: false });
    h.flows = [armedFlow()];
    h.buildRunStatus.mockReturnValue(mergedStatus("PROJ-1", "aws-ops"));
    await openPanel();
    await settle();
    expect(h.writeFlow).not.toHaveBeenCalled();
  });

  it("does not fire when the condition is not met", async () => {
    setConfig({ orchestrator: true });
    h.flows = [armedFlow()];
    h.buildRunStatus.mockReturnValue(openStatus("PROJ-1", "aws-ops"));
    await openPanel();
    await settle();
    expect(h.writeFlow).not.toHaveBeenCalled();
  });

  it("never launches a rule whose target is not planned work", async () => {
    // There is nothing to launch, so it must be recorded as an error — stamped,
    // so it does not re-evaluate forever, and never as a success — and nothing
    // may be opened.
    //
    // The fixture this used to use — a hand-edited `action: "launch"` aimed at a
    // notify node — cannot reach this path any more, and not because the guard
    // went away: an action is DERIVED from the target now, so a notify node
    // derives `notify` and there is no launch to refuse. (That hand-edited shape
    // is caught one layer earlier instead: `readFlows`' `latchActionMismatches`
    // settles a stored action that disagrees with its target, covered in
    // migration.test.ts.) Under derivation the only edit that can change an
    // action is a change to the TARGET NODE's KIND, so a `launch` with nothing
    // to launch is reachable exactly one way — evaluation derived `launch` from
    // a `planned` node, and by the time this pass acts the store holds a notify
    // terminal in its place.
    setConfig({ orchestrator: true });
    const withTarget = (kind: "planned" | "notify"): Flow => armedFlow({
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
        kind === "planned"
          ? {
              id: "n2", kind: "planned", x: 0, y: 0, join: "any",
              ticketKey: "PROJ-12", repos: ["aws-ops"], mode: "implementation", dest: "worktree",
            }
          : { id: "n2", kind: "notify", x: 0, y: 0, join: "any", message: "the migration has landed" },
      ],
      // No stored `action` at all: the mirror decides nothing, so a fixture that
      // set one would only invite the reader to think it did.
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" } }],
    });
    h.flows = [withTarget("planned")];
    // Warm the resume gate first (Task 4): without this, the met condition
    // would only ever be reported and held on the first pass, and this test
    // would pass without ever reaching the perform path it means to guard —
    // nothing is performed for a HELD flow either, gate or no gate, so that
    // would prove nothing about the launch/seed guard specifically.
    h.buildRunStatus.mockReturnValue(openStatus("PROJ-1", "aws-ops"));
    const { p, send } = await openPanel();
    await settle();
    h.buildRunStatus.mockReturnValue(mergedStatus("PROJ-1", "aws-ops"));
    h.writeFlow.mockClear();
    // Read 1 of the pass is evaluation's own — planned work, so `launch`. Every
    // read after it (the `fresh` copy this pass acts and gates against, the
    // pre-write `atWrite` read, and postFlows') sees what the node has become.
    let reads = 0;
    h.readFlows.mockImplementation(() => (++reads === 1 ? [withTarget("planned")] : [withTarget("notify")]));
    await send({ type: "deck:refresh" });
    // The second read has to have actually happened, or everything below would
    // pass on a pass that simply never got that far.
    expect(reads).toBeGreaterThan(1);
    expect(h.launchPlanned).not.toHaveBeenCalled();
    expect(h.openInEditor).not.toHaveBeenCalled();
    expect(h.writePlanFile).not.toHaveBeenCalled();
    // Nor was consent ever asked for — asserted BEFORE the write is read, because
    // a pass that asks writes only the answer and never reaches the stamp below.
    // `armedFlow` carries no `launchConfirmedAt`, and a launch with no planned
    // node left to launch spends nothing, so gating on it would ask the user
    // about something that can never happen — the launch side of the same claim
    // the seed suite's "does NOT gate" case makes.
    expect(window.showWarningMessage).not.toHaveBeenCalled();
    // The pass STAMPED rather than diverging into the ask branch, which writes
    // only the answer and never reaches an edge at all. Spelled out so a
    // regression that makes this rule gate fails here, on a named expectation,
    // instead of on `.at(-1)!` of an empty call list.
    expect(h.writeFlow).toHaveBeenCalled();
    const written = h.writeFlow.mock.calls.at(-1)![2] as Flow;
    expect(written.edges[0].error).toMatch(/planned/i);
    expect(written.edges[0].firedAt).toBeUndefined();
    expect(written.launchConfirmedAt).toBeUndefined();
    // And no toast claims it ran.
    expect(posts(p).some((m) => m.type === "toast" && /launched/i.test(m.message ?? ""))).toBe(false);
  });

  // Two VS Code windows share ~/.agentflow/flows (defaultFlowsDir is global) and a
  // DeckPanel is per-extension-host, so both evaluate the same file and both can
  // fire the same unfired edge. Probe-proved: two identical toasts, the second
  // window's firedAt overwriting the first's. advanceArmedFlows now re-reads the
  // store immediately before writing and drops anything already stamped there.
  //
  // Every test below steers `h.readFlows` per call. Read 1 of a pass is
  // advanceArmedFlows' own evaluate read; read 2 is the guard read right before the
  // write; read 3 is postFlows'. The `reads` assertion in the first test is what
  // proves the guard read exists at all rather than the mock simply never firing.
  describe("the two-window race", () => {
    const stampedByOtherWindow = (): Flow => {
      const f = armedFlow();
      return { ...f, edges: [{ ...f.edges[0], firedAt: 111, firedNote: "told you: the migration has landed" }] };
    };

    /** Warm the resume gate with an unmet condition, then arm the met one — the
     * same two-pass idiom every firing test in this file uses. */
    const warmed = async () => {
      h.buildRunStatus.mockReturnValue(openStatus("PROJ-1", "aws-ops"));
      const opened = await openPanel();
      await settle();
      h.buildRunStatus.mockReturnValue(mergedStatus("PROJ-1", "aws-ops"));
      return opened;
    };

    it("neither stamps nor toasts an edge the other window stamped between the read and the write", async () => {
      setConfig({ orchestrator: true });
      h.flows = [armedFlow()];
      const { p, send } = await warmed();
      let reads = 0;
      h.readFlows.mockImplementation(() => (++reads === 1 ? [armedFlow()] : [stampedByOtherWindow()]));
      h.writeFlow.mockClear();
      const toastsBefore = posts(p).filter((m) => m.type === "toast").length;
      await send({ type: "deck:refresh" });
      // The guard read has to have actually happened, or the two branches below
      // would both pass on a pass that simply never got that far.
      expect(reads).toBeGreaterThan(1);
      expect(h.writeFlow).not.toHaveBeenCalled();
      // No second toast: the other window already announced this rule.
      expect(posts(p).filter((m) => m.type === "toast").length).toBe(toastsBefore);
    });

    it("bases its write on the FRESH copy, so it cannot erase the other window's stamp on a different edge", async () => {
      // The subtler half of the same defect. Dropping the claimed edge from what we
      // stamp is not enough on its own: writing the STALE flow we evaluated would
      // erase the other window's `firedAt` on e2, un-latching a rule that already
      // ran and firing it a second time on the next pass.
      setConfig({ orchestrator: true });
      const twoRules = (): Flow => ({
        ...armedFlow(),
        nodes: [
          { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
          { id: "n2", kind: "notify", x: 0, y: 0, join: "any", message: "the migration has landed" },
          { id: "n3", kind: "notify", x: 0, y: 0, join: "any", message: "ci went red" },
        ],
        edges: [
          { id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" },
          // Never met against these fixtures (no failing checks) — it is only here
          // to be the edge the other window stamped.
          { id: "e2", from: "n1", to: "n3", cond: { kind: "ci-failed" }, action: "notify" },
        ],
      });
      const otherWindowStampedE2 = (): Flow => {
        const f = twoRules();
        return { ...f, edges: [f.edges[0], { ...f.edges[1], firedAt: 777, firedNote: "told you: ci went red" }] };
      };
      h.flows = [twoRules()];
      const { send } = await warmed();
      let reads = 0;
      h.readFlows.mockImplementation(() => (++reads === 1 ? [twoRules()] : [otherWindowStampedE2()]));
      h.writeFlow.mockClear();
      await send({ type: "deck:refresh" });
      const w = h.writeFlow.mock.calls.at(-1)![2] as Flow;
      // This pass's own rule is stamped…
      expect(w.edges.find((e) => e.id === "e1")!.firedAt).toBeTypeOf("number");
      // …and the other window's stamp survives rather than being written back to
      // undefined.
      expect(w.edges.find((e) => e.id === "e2")!.firedAt).toBe(777);
    });

    it("writes nothing when the flow vanished from the store between the two reads", async () => {
      // Another window deleted it. Writing would recreate the file the user removed.
      setConfig({ orchestrator: true });
      h.flows = [armedFlow()];
      const { send } = await warmed();
      let reads = 0;
      h.readFlows.mockImplementation(() => (++reads === 1 ? [armedFlow()] : []));
      h.writeFlow.mockClear();
      await send({ type: "deck:refresh" });
      expect(reads).toBeGreaterThan(1);
      expect(h.writeFlow).not.toHaveBeenCalled();
    });

    it("still fires the rules the other window did NOT claim", async () => {
      // The guard drops claimed edges, not the whole pass: e1 is stamped on disk
      // already, e2's condition is met here, and e2 must still fire.
      setConfig({ orchestrator: true });
      const twoRules = (over: { e1Fired?: boolean } = {}): Flow => ({
        ...armedFlow(),
        nodes: [
          { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
          { id: "n2", kind: "notify", x: 0, y: 0, join: "any", message: "the migration has landed" },
          { id: "n3", kind: "notify", x: 0, y: 0, join: "any", message: "also merged" },
        ],
        edges: [
          { id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify", ...(over.e1Fired ? { firedAt: 111 } : {}) },
          { id: "e2", from: "n1", to: "n3", cond: { kind: "pr-merged" }, action: "notify" },
        ],
      });
      h.flows = [twoRules()];
      const { send } = await warmed();
      let reads = 0;
      h.readFlows.mockImplementation(() => (++reads === 1 ? [twoRules()] : [twoRules({ e1Fired: true })]));
      h.writeFlow.mockClear();
      await send({ type: "deck:refresh" });
      const w = h.writeFlow.mock.calls.at(-1)![2] as Flow;
      expect(w.edges.find((e) => e.id === "e1")!.firedAt).toBe(111);
      expect(w.edges.find((e) => e.id === "e2")!.firedAt).not.toBe(111);
      expect(w.edges.find((e) => e.id === "e2")!.firedAt).toBeTypeOf("number");
      // One notification, for e2's message only — e1's was the other window's to post.
      const messages = (window.showInformationMessage as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
      expect(messages.filter((t) => /also merged/.test(t))).toHaveLength(1);
      expect(messages.filter((t) => /the migration has landed/.test(t))).toHaveLength(0);
    });
  });

  it("keeps advancing the other flows when one throws while evaluating", async () => {
    // A hand-edited or half-migrated flow on disk can be armed with a shape
    // evaluateFlow chokes on (here: edges that are not an array). It must not
    // take the whole pass down with it — the flow after it in the store still
    // gets its own chance to fire, same as readFlows degrading one corrupt file
    // rather than the whole drawer.
    setConfig({ orchestrator: true });
    const brokenFlow = { ...mkFlow("bad", "Broken"), armed: true, edges: null } as unknown as Flow;
    h.flows = [brokenFlow, armedFlow()];
    // Warm f1's resume gate first (Task 4) so this test isolates the throwing
    // flow's effect on its sibling, not the resume gate holding f1 anyway.
    h.buildRunStatus.mockReturnValue(openStatus("PROJ-1", "aws-ops"));
    const log = vi.fn();
    DeckPanel.show(fakeContext().context as any, fakeConnector(), log);
    await settled();
    await settle();
    h.buildRunStatus.mockReturnValue(mergedStatus("PROJ-1", "aws-ops"));
    await lastPanel()._fire({ type: "deck:refresh" });
    await settle();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("bad"));
    const written = h.writeFlow.mock.calls.at(-1)?.[2] as Flow | undefined;
    expect(written?.id).toBe("f1");
    expect(written?.edges[0].firedAt).toBeTypeOf("number");
  });
});

describe("a met launch rule acts", () => {
  /** `log` is injectable because two cases here assert on the output channel: a
   * deferred rule says so in the log and nowhere else. */
  const openPanel = async (log: (m: string) => void = () => {}) => {
    DeckPanel.show(fakeContext().context as any, fakeConnector(), log);
    await settled();
    const p = lastPanel();
    return { p, send: async (m: unknown) => { await p._fire(m); await settled(); } };
  };

  /** A place whose PR is watched, wired to planned work. `launchConfirmedAt` is
   * SET by default: most cases here are about what an already-approved flow does,
   * and the first-launch question has its own cases below. */
  const launchFlow = (over: Partial<Flow> = {}): Flow => ({
    ...mkFlow("f1", "Ship the migration"),
    armed: true,
    launchConfirmedAt: 500,
    nodes: [
      { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
      {
        id: "n2", kind: "planned", x: 0, y: 0, join: "any",
        ticketKey: "PROJ-12", repos: ["aws-ops"], mode: "implementation", dest: "worktree",
      },
    ],
    edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "launch" }],
    ...over,
  });

  /** Open with the condition UNMET so the resume gate clears itself (Task 4), then
   * arm the met one — the same two-pass idiom every firing test in this file uses.
   * Without it the first met pass would only ever be held and reported, and every
   * assertion below about launching would be about the resume gate instead. */
  /** An open PR with CI red, so NEITHER `pr-merged` nor `ci-passed` is met. The plain
   * `openStatus` fixture has CI green, which is enough to fire a `ci-passed` rule — and
   * a rule that fires during the warm-up pass is HELD by the resume gate instead of
   * clearing it, which would silently make every later assertion about the gate rather
   * than about acting. Any fixture wiring `ci-passed` has to warm with this. */
  const redStatus = (key: string, repo: string): RunStatus => {
    const s = openStatus(key, repo);
    const entry = s.prs[repo]!;
    return {
      ...s,
      prs: {
        [repo]: {
          ...entry,
          facts: { ...entry.facts!, ci: { passing: 0, pending: 0, failing: [{ name: "build", url: "" }] } },
        },
      },
    };
  };

  const warmed = async (flows: Flow[], log?: (m: string) => void, warm?: RunStatus) => {
    setConfig({ orchestrator: true });
    h.flows = flows;
    h.buildRunStatus.mockReturnValue(warm ?? openStatus("PROJ-1", "aws-ops"));
    const opened = await openPanel(log);
    await settle();
    h.buildRunStatus.mockReturnValue(mergedStatus("PROJ-1", "aws-ops"));
    h.writeFlow.mockClear();
    return opened;
  };

  const toastCount = (p: ReturnType<typeof lastPanel>) => posts(p).filter((m) => m.type === "toast").length;
  const lastWrite = () => h.writeFlow.mock.calls.at(-1)![2] as Flow;

  it("acts on the node's action, not the record's stale mirror of it", async () => {
    // The edge's stored `action` is a backward-compatibility mirror (see
    // `FlowEdge.action`'s own doc comment), never an instruction: an edge saved
    // as `notify` that points at PLANNED WORK is a launch, because the TARGET
    // NODE is what decides. If the dispatch ever read the mirror again, this
    // rule would silently do nothing but toast, for a wire the user drew to
    // start a paid session.
    const { send } = await warmed([launchFlow({
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" }],
    })]);
    await send({ type: "deck:refresh" });
    // The observable effect of a launch, not a mock shape: the launcher was
    // called, and for the ticket the planned node names.
    expect(h.launchPlanned).toHaveBeenCalledTimes(1);
    expect((h.launchPlanned.mock.calls.at(-1)![0] as { node: { ticketKey: string } }).node.ticketKey).toBe("PROJ-12");
    // And it is recorded as the launch it was, so `applyFired`'s stamp agrees
    // with what this pass actually performed.
    const w = lastWrite();
    expect(w.edges[0].firedAt).toBeTypeOf("number");
    expect(w.edges[0].error).toBeUndefined();
    expect(w.edges[0].firedNote).toContain("PROJ-12");
  });

  // ── the receipt's agent name ────────────────────────────────────────────────
  // An Orchestrator launch resolves the agent from the SETTING (`agentName` on the
  // request says so), so `cursor` really does start Cursor and the hardcoded copy
  // became wrong when this branch added that value.
  it("names Cursor in the launch receipt when Cursor is configured", async () => {
    h.agentProvider = "cursor";
    const { p, send } = await warmed([launchFlow()]);
    await send({ type: "deck:refresh" });
    const toast = posts(p).find((m) => m.type === "toast" && m.level === "success") as { message: string };
    expect(toast.message).toContain("Cursor pre-seeded — press Enter to start.");
  });

  it("names Codex in the launch receipt when Codex is configured", async () => {
    h.agentProvider = "codex";
    const { p, send } = await warmed([launchFlow()]);
    await send({ type: "deck:refresh" });
    const toast = posts(p).find((m) => m.type === "toast" && m.level === "success") as { message: string };
    expect(toast.message).toContain("Codex pre-seeded — press Enter to start.");
  });

  it.each([["claude-code"], ["ask"], ["copilot"]])(
    "keeps the launch receipt saying Claude Code under %s",
    async (agentProvider) => {
      // `claude-code` and `ask` are right — an unattended launch pins Claude Code.
      // `copilot` is wrong and stays wrong: that string predates this branch.
      h.agentProvider = agentProvider as typeof h.agentProvider;
      const { p, send } = await warmed([launchFlow()]);
      await send({ type: "deck:refresh" });
      const toast = posts(p).find((m) => m.type === "toast" && m.level === "success") as { message: string };
      expect(toast.message).toContain("Claude Code pre-seeded — press Enter to start.");
    },
  );

  it("does nothing at all when another window holds the flows lock", async () => {
    const { p, send } = await warmed([launchFlow()]);
    h.acquire.mockReturnValue(false);
    const toastsBefore = toastCount(p);
    await send({ type: "deck:refresh" });
    // The board itself still refreshed — the lock gates the flows pass, not the Deck.
    expect(h.buildRunStatus).toHaveBeenCalled();
    expect(h.writeFlow).not.toHaveBeenCalled();
    expect(h.launchPlanned).not.toHaveBeenCalled();
    expect(toastCount(p)).toBe(toastsBefore);
    // Not vacuous: the very same fixture launches the moment the lock is free, so
    // the three assertions above are about the lock and not about an unmet rule.
    h.acquire.mockReturnValue(true);
    await send({ type: "deck:refresh" });
    expect(h.launchPlanned).toHaveBeenCalledTimes(1);
  });

  it("releases the lock with the same token it acquired, even when the launch throws", async () => {
    const { send } = await warmed([launchFlow()]);
    h.launchPlanned.mockRejectedValue(new Error("boom"));
    h.release.mockClear();
    await send({ type: "deck:refresh" });
    expect(h.release).toHaveBeenCalled();
    // acquire(io, dir, nowMs, ttlMs, token) and release(io, dir, token) — the same
    // token, or a suspended window's release could delete a live holder's lock.
    const token = h.acquire.mock.calls.at(-1)![4];
    expect(token).toBeTypeOf("string");
    expect(h.release.mock.calls.at(-1)![2]).toBe(token);
  });

  it("releases the lock when the pass itself throws, not only when a launch does", async () => {
    // A throwing launch is caught per flow (one bad flow must not stop the others),
    // so it never reaches the pass's own `finally`. This is what does: a throw from
    // the store read, outside every per-flow guard. Without the `finally` the lock
    // file would be left behind and every window would skip until the TTL reaped it.
    const log = vi.fn();
    setConfig({ orchestrator: true });
    h.flows = [launchFlow()];
    h.buildRunStatus.mockReturnValue(mergedStatus("PROJ-1", "aws-ops"));
    DeckPanel.show(fakeContext().context as any, fakeConnector(), log);
    await settled();
    h.release.mockClear();
    h.readFlows.mockImplementation(() => { throw new Error("store on fire"); });
    await lastPanel()._fire({ type: "deck:refresh" });
    await settled();
    expect(h.release).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("store on fire"));
    // Put the store back before afterEach disposes the panel: the close path reads
    // the flows too (hasArmedFlow), and a throw from there is nobody's to catch.
    h.readFlows.mockImplementation(() => h.flows);
  });

  it("releases the lock BEFORE it asks, so no other window waits on a human", async () => {
    // A modal is answered on human time; the lock is held on machine time. Awaiting
    // one inside the other stalls every other window's pass for as long as the
    // question is up, and past the TTL the lock is reaped and someone else acquires
    // while this pass is still inside the modal — the very read-then-write window the
    // lock exists to close.
    const order: string[] = [];
    h.release.mockImplementation(() => { order.push("release"); });
    (window.showWarningMessage as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("ask");
      return "Launch";
    });
    const { send } = await warmed([launchFlow({ launchConfirmedAt: undefined })]);
    order.length = 0;
    await send({ type: "deck:refresh" });
    expect(order).toEqual(["release", "ask"]);
  });

  it("mints a fresh lock token per pass, so a release can only remove its own lock", async () => {
    // A token shared across passes is worse than no token: when a modal outlives the
    // TTL and this panel's next poll reacquires, the first pass's release passes
    // lock.ts's token check and deletes the lock the second pass believes it holds.
    const { send } = await warmed([launchFlow()]);
    await send({ type: "deck:refresh" });
    await send({ type: "deck:refresh" });
    const tokens = h.acquire.mock.calls.map((c) => c[4]);
    expect(tokens.length).toBeGreaterThan(1);
    expect(new Set(tokens).size).toBe(tokens.length);
    // And each release used the token its own pass acquired with.
    for (const [i, call] of h.release.mock.calls.entries()) expect(call[2]).toBe(tokens[i]);
  });

  it("gives the lock's IO a logger that reaches the output channel", async () => {
    // `log` is optional on nodeLockIo, so dropping it compiles and every other test
    // stays green — while EEXIST and "the filesystem is broken" both return false, so
    // a permissions failure would present as ordinary contention and strand an armed
    // flow forever with nothing to diagnose.
    const log = vi.fn();
    await warmed([launchFlow()], log);
    expect(h.lockIoLog).toBeTypeOf("function");
    h.lockIoLog!("orchestrator: could not take the flows lock: EACCES");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
  });

  it("passes the real TTL to acquire, not a value that would reap a live holder", async () => {
    const { send } = await warmed([launchFlow()]);
    await send({ type: "deck:refresh" });
    const ttl = h.acquire.mock.calls.at(-1)![3];
    expect(ttl).toBe(LOCK_TTL_MS);
    // The invariant behind the constant: a TTL under the poll interval would reap a
    // live holder between two of its own polls.
    expect(ttl).toBeGreaterThan(POLL_MS);
  });

  it("skips a pass while another is still running on this panel", async () => {
    // Two concurrent passes on one panel is what makes a shared token corrupting, and
    // it is reachable today: refresh() polls every six seconds and a modal can sit for
    // minutes. The second pass must not evaluate, acquire, or ask anything.
    let answer!: (v: string) => void;
    (window.showWarningMessage as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<string>((r) => { answer = r; }),
    );
    const { p } = await warmed([launchFlow({ launchConfirmedAt: undefined })]);
    h.acquire.mockClear();
    const first = p._fire({ type: "deck:refresh" });
    await settled();
    const second = p._fire({ type: "deck:refresh" });
    await settled();
    expect(h.acquire).toHaveBeenCalledTimes(1);
    expect(window.showWarningMessage).toHaveBeenCalledTimes(1);
    answer("Launch");
    await first;
    await second;
  });

  it("asks before a flow's first launch, naming the ticket, the repo and the prompt mode", async () => {
    const { send } = await warmed([launchFlow({ launchConfirmedAt: undefined })]);
    await send({ type: "deck:refresh" });
    const call = (window.showWarningMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect(call[0]).toContain("PROJ-12");
    expect(call[0]).toContain("aws-ops");
    expect(call[0]).toContain("Implementation"); // the configured mode's label
    expect(call[1]).toMatchObject({ modal: true });
    expect(call.slice(2)).toEqual(["Launch", "Disarm"]);
    // The asking pass performs NOTHING.
    expect(h.launchPlanned).not.toHaveBeenCalled();
    expect(lastWrite().edges[0].firedAt).toBeUndefined();
  });

  it("stamps launchConfirmedAt on Launch and lets the NEXT pass act", async () => {
    const { send } = await warmed([launchFlow({ launchConfirmedAt: undefined })]);
    await send({ type: "deck:refresh" });
    expect(lastWrite().launchConfirmedAt).toBeTypeOf("number");
    expect(h.launchPlanned).not.toHaveBeenCalled();
    // The store now holds the approval, as it would on disk.
    await send({ type: "deck:refresh" });
    expect(h.launchPlanned).toHaveBeenCalledTimes(1);
    // Asked once per flow, not once per pass.
    expect(window.showWarningMessage).toHaveBeenCalledTimes(1);
  });

  it("journals the question a pass asked instead of spending", async () => {
    const { send } = await warmed([launchFlow({ launchConfirmedAt: undefined })]);
    await send({ type: "deck:refresh" });
    const asked = journal().filter((e) => e.kind === "consent-asked");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ kind: "consent-asked", action: "launch", target: "n2" });
    // A pass that asks performs nothing, so it must claim nothing.
    expect(journal().some((e) => e.kind === "fired")).toBe(false);
  });

  it("journals the answer to a first-spend question", async () => {
    const { send } = await warmed([launchFlow({ launchConfirmedAt: undefined })]);
    await send({ type: "deck:refresh" });
    // The second pass acts on the stored approval and asks nothing, so the answer
    // is recorded once per question rather than once per pass.
    await send({ type: "deck:refresh" });
    const consented = journal().filter((e) => e.kind === "consented");
    expect(consented).toHaveLength(1);
    expect(consented[0]).toMatchObject({ kind: "consented", answer: "act", flow: "f1" });
  });

  it("includes the edge's note in the spend confirmation when one is set", async () => {
    const note = "Careful: this repo has a flaky test suite.";
    const { send } = await warmed([launchFlow({
      launchConfirmedAt: undefined,
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "launch", note }],
    })]);
    await send({ type: "deck:refresh" });
    const call = (window.showWarningMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect(call[0]).toContain(note);
  });

  it("truncates a long note in the spend confirmation instead of growing the modal unbounded", async () => {
    const longNote = "x".repeat(500);
    const { send } = await warmed([launchFlow({
      launchConfirmedAt: undefined,
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "launch", note: longNote }],
    })]);
    await send({ type: "deck:refresh" });
    const call = (window.showWarningMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect(call[0]).toContain("x".repeat(160) + "…");
    expect(call[0]).not.toContain("x".repeat(161));
  });

  it("reads exactly as it did before notes existed when the edge has none", async () => {
    const { send } = await warmed([launchFlow({ launchConfirmedAt: undefined })]);
    await send({ type: "deck:refresh" });
    const call = (window.showWarningMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect(call[0]).toBe(
      'Ship the migration is ready to launch PROJ-12 in aws-ops with the "Implementation" prompt, unattended. It will keep launching and seeding on its own from now on. It will still ask before it runs a shell command.',
    );
  });

  it("treats a whitespace-only note as no note at all in the spend confirmation", async () => {
    // composeAgentPrompt (Task 1) already ignores a whitespace-only note when
    // building the agent's actual prompt. The modal must agree — showing it here
    // as if the agent will be told something would misrepresent what the user
    // is being asked to approve.
    const { send } = await warmed([launchFlow({
      launchConfirmedAt: undefined,
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "launch", note: "   " }],
    })]);
    await send({ type: "deck:refresh" });
    const call = (window.showWarningMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect(call[0]).toBe(
      'Ship the migration is ready to launch PROJ-12 in aws-ops with the "Implementation" prompt, unattended. It will keep launching and seeding on its own from now on. It will still ask before it runs a shell command.',
    );
  });

  it("disarms on Disarm, and never launches on any later pass", async () => {
    (window.showWarningMessage as ReturnType<typeof vi.fn>).mockImplementation(
      async (_m: string, _o: unknown, ...items: string[]) => items[1], // "Disarm"
    );
    const { send } = await warmed([launchFlow({ launchConfirmedAt: undefined })]);
    await send({ type: "deck:refresh" });
    expect(lastWrite().armed).toBe(false);
    expect(lastWrite().launchConfirmedAt).toBeUndefined();
    expect(h.launchPlanned).not.toHaveBeenCalled();
    await send({ type: "deck:refresh" });
    expect(h.launchPlanned).not.toHaveBeenCalled();
  });

  it("journals a Disarm answer to a first-spend question", async () => {
    (window.showWarningMessage as ReturnType<typeof vi.fn>).mockImplementation(
      async (_m: string, _o: unknown, ...items: string[]) => items[1], // "Disarm"
    );
    const { send } = await warmed([launchFlow({ launchConfirmedAt: undefined })]);
    await send({ type: "deck:refresh" });
    // Disarmed by that answer, so no later pass can ask — or answer — again.
    await send({ type: "deck:refresh" });
    const consented = journal().filter((e) => e.kind === "consented");
    expect(consented).toHaveLength(1);
    expect(consented[0]).toMatchObject({ kind: "consented", answer: "disarm", flow: "f1" });
  });

  it("writes nothing and launches nothing when the question is dismissed", async () => {
    // Escape, or the modal being closed. Neither approval nor disarm: the flow
    // stays armed and is asked again on a later pass.
    (window.showWarningMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const { send } = await warmed([launchFlow({ launchConfirmedAt: undefined })]);
    await send({ type: "deck:refresh" });
    expect(h.writeFlow).not.toHaveBeenCalled();
    expect(h.launchPlanned).not.toHaveBeenCalled();
  });

  it("journals a dismissed first-spend question as neither act nor disarm", async () => {
    // A dismissal writes no flow file at all, so this line is the ONLY evidence
    // the question was seen and waved away rather than never shown.
    (window.showWarningMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const { send } = await warmed([launchFlow({ launchConfirmedAt: undefined })]);
    await send({ type: "deck:refresh" });
    const consented = journal().filter((e) => e.kind === "consented");
    expect(consented).toHaveLength(1);
    expect(consented[0]).toMatchObject({ kind: "consented", answer: "dismissed", flow: "f1" });
    expect(h.writeFlow).not.toHaveBeenCalled();
  });

  it("does not ask a second time while its own question is still on screen", async () => {
    // The lock is mocked open here, so nothing but this guard stops a second poll
    // from queueing another modal — which is exactly what happens in production
    // once a question has been up longer than the lock's TTL.
    let answer!: (v: string) => void;
    (window.showWarningMessage as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<string>((r) => { answer = r; }),
    );
    const { p, send } = await warmed([launchFlow({ launchConfirmedAt: undefined })]);
    const first = p._fire({ type: "deck:refresh" });
    await settled();
    const second = p._fire({ type: "deck:refresh" });
    await settled();
    expect(window.showWarningMessage).toHaveBeenCalledTimes(1);
    answer("Launch");
    await first;
    await second;
    await send({ type: "deck:refresh" });
    expect(h.launchPlanned).toHaveBeenCalledTimes(1);
  });

  it("forgets the question when the flow is deleted while it is on screen", async () => {
    let answer!: (v: string) => void;
    (window.showWarningMessage as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<string>((r) => { answer = r; }),
    );
    const { p } = await warmed([launchFlow({ launchConfirmedAt: undefined })]);
    const pass = p._fire({ type: "deck:refresh" });
    await settled();
    h.flows = []; // another window deleted it
    answer("Launch");
    await pass;
    await settled();
    // Writing would recreate the file the user removed.
    expect(h.writeFlow).not.toHaveBeenCalled();
  });

  it("promotes the launched node and stamps the edge in ONE write", async () => {
    const { p, send } = await warmed([launchFlow()]);
    await send({ type: "deck:refresh" });
    expect(h.writeFlow).toHaveBeenCalledTimes(1); // a crash between the two is impossible
    const w = lastWrite();
    expect(w.nodes.find((n) => n.id === "n2")).toMatchObject({
      kind: "place", runKey: "PROJ-12", repo: "aws-ops", x: 0, y: 0, join: "any",
    });
    expect(w.edges[0].firedAt).toBeTypeOf("number");
    expect(w.edges[0].error).toBeUndefined();
    expect(w.edges[0].firedNote).toContain("PROJ-12");
    expect(posts(p).some((m) => m.type === "toast" && /PROJ-12/.test(m.message ?? ""))).toBe(true);
  });

  it("journals a fired rule with the verb evaluation decided, after the flow is written", async () => {
    const { send } = await warmed([launchFlow()]);
    await send({ type: "deck:refresh" });
    const fired = journal().filter((e) => e.kind === "fired");
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ kind: "fired", action: "launch", edge: "e1", from: "n1", to: "n2" });
    expect(fired[0].note).toEqual(expect.stringContaining("launched"));
  });

  it("journals the promotion alongside the rule that caused it", async () => {
    const { send } = await warmed([launchFlow()]);
    await send({ type: "deck:refresh" });
    const promoted = journal().filter((e) => e.kind === "promoted");
    expect(promoted).toHaveLength(1);
    expect(promoted[0]).toMatchObject({ kind: "promoted", node: "n2" });
  });

  it("journals a failed launch as errored, carrying the reason the edge was latched with", async () => {
    h.launchPlanned.mockResolvedValue({ ok: false, message: "Couldn't create a git worktree in aws-ops" });
    const { send } = await warmed([launchFlow()]);
    await send({ type: "deck:refresh" });
    const errored = journal().filter((e) => e.kind === "errored");
    expect(errored).toHaveLength(1);
    expect(errored[0]).toMatchObject({ kind: "errored", action: "launch", edge: "e1" });
    expect(errored[0].error).toBeTruthy();
    expect(journal().some((e) => e.kind === "fired")).toBe(false);
  });

  it("journals nothing at all for a pass in which no rule was decided", async () => {
    h.getDetail.mockRejectedValue(new Error("Jira said 503"));
    const { send } = await warmed([launchFlow({
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
        {
          id: "n2", kind: "planned", x: 0, y: 0, join: "any",
          ticketKey: "PROJ-12", repos: ["aws-ops"], mode: "implementation", dest: "worktree",
        },
        {
          id: "n3", kind: "planned", x: 0, y: 0, join: "any",
          ticketKey: "PROJ-13", repos: ["aws-ops"], mode: "implementation", dest: "worktree",
        },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "launch" },
        { id: "e2", from: "n1", to: "n3", cond: { kind: "pr-merged" }, action: "launch" },
      ],
    })]);
    await send({ type: "deck:refresh" });
    expect(h.getDetail).toHaveBeenCalledTimes(2); // both rules really were attempted
    expect(journal().filter((e) => ["fired", "errored", "promoted"].includes(e.kind as string))).toEqual([]);
  });

  it("keeps firing when the journal itself is broken — a lost record is not a lost deploy", async () => {
    h.journalThrows = true;
    const log = vi.fn();
    const { send } = await warmed([launchFlow()], log);
    await send({ type: "deck:refresh" });
    expect(h.launchPlanned).toHaveBeenCalled();
    expect(lastWrite().edges[0].firedAt).toBeTypeOf("number");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("flow journal unavailable"));
    // The IO's OWN message, not merely that something complained: a journal never
    // called at all would satisfy the line above.
    expect(log).toHaveBeenCalledWith(expect.stringContaining("ENOSPC"));
  });

  it("says the journal is unavailable ONCE, not once per rule", async () => {
    h.journalThrows = true;
    const log = vi.fn();
    const { send } = await warmed([launchFlow({
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
        {
          id: "n2", kind: "planned", x: 0, y: 0, join: "any",
          ticketKey: "PROJ-12", repos: ["aws-ops"], mode: "implementation", dest: "worktree",
        },
        {
          id: "n3", kind: "planned", x: 0, y: 0, join: "any",
          ticketKey: "PROJ-13", repos: ["aws-ops"], mode: "implementation", dest: "worktree",
        },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "launch" },
        { id: "e2", from: "n1", to: "n3", cond: { kind: "pr-merged" }, action: "launch" },
      ],
    })], log);
    await send({ type: "deck:refresh" });
    // Both rules really did fire — otherwise "once" would be trivially true.
    expect(h.launchPlanned).toHaveBeenCalledTimes(2);
    const complaints = log.mock.calls.flat().filter((m) => String(m).includes("flow journal unavailable"));
    expect(complaints).toHaveLength(1);
    // And it carries what actually failed, not a generic apology.
    expect(complaints[0]).toEqual(expect.stringContaining("ENOSPC"));
  });

  it("writes the flow BEFORE it journals, so a crash cannot invent an event", async () => {
    // The harness has no `writeFlow` hook, so the ordering is recorded from the
    // store mock itself. `h.journalLines` IS the journal fake's record, so how
    // many lines it holds AT THE MOMENT OF THE WRITE is exactly how many events
    // were journaled first — zero, or this pass invented an event the flow file
    // has no stamp for. Moving the journal block above `writeFlow` makes this
    // read "write after 3 journal lines".
    const { send } = await warmed([launchFlow()]);
    const order: string[] = [];
    h.writeFlow.mockImplementation((_io: unknown, _dir: string, flow: Flow) => {
      order.push(`write after ${h.journalLines.length} journal lines`);
      const i = h.flows.findIndex((f) => f.id === flow.id);
      h.flows = i >= 0 ? h.flows.map((f, idx) => (idx === i ? flow : f)) : [...h.flows, flow];
    });
    await send({ type: "deck:refresh" });
    expect(order).toEqual(["write after 0 journal lines"]);
    expect(h.journalLines.length).toBeGreaterThan(0); // and it did journal, after
  });

  it("does not notify for a successful launch — the opened window already announces it", async () => {
    // A successful launch already announces itself by opening a window; a
    // notification on top would be noise. Assert the call COUNT is zero, not
    // merely that a toast happened — that would pass even if a notification
    // also fired alongside it.
    const { send } = await warmed([launchFlow()]);
    await send({ type: "deck:refresh" });
    expect(lastWrite().edges[0].firedAt).toBeTypeOf("number"); // the launch really did succeed
    expect(window.showInformationMessage).not.toHaveBeenCalled();
    expect(window.showErrorMessage).not.toHaveBeenCalled();
  });

  it("asks the launcher for the node, the ticket, the repos and the resolved prompt", async () => {
    const { send } = await warmed([launchFlow()]);
    await send({ type: "deck:refresh" });
    expect(h.getDetail).toHaveBeenCalledWith("PROJ-12");
    const req = h.launchPlanned.mock.calls.at(-1)![0] as any;
    expect(req.node).toMatchObject({ kind: "planned", ticketKey: "PROJ-12" });
    expect(req.detail).toMatchObject({ key: "PROJ-12", summary: "do it", descriptionText: "the description" });
    expect(req.repos).toEqual(h.repos);
    // …discovered with the reposRoot as the root and the blocklist as the blocklist.
    // Asserting the ARGUMENTS, not just the return: the mock ignores them, so passing
    // them the other way round would look identical from `req.repos` alone.
    expect(h.discoverRepos).toHaveBeenCalledWith("/repos", ["vendored"]);
    // The node's `mode` is a PromptMode id, resolved against the configured modes.
    expect(req.promptTemplate).toContain("Begin implementing");
    expect(req.seedAgent).toBe(true);
    expect(req.workspaceDir).toBeTypeOf("string");
    // One repo, so one window — never "ask", which an unattended launch cannot do.
    expect(req.workspaceMode).toBe("per-window");
  });

  it("composes the edge's note into the prompt template handed to the launcher", async () => {
    const note = "Also update the migration doc while you're in there.";
    const implMode = DEFAULT_PROMPT_MODES.find((m) => m.id === "implementation")!;
    const { send } = await warmed([launchFlow({
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "launch", note }],
    })]);
    await send({ type: "deck:refresh" });
    const req = h.launchPlanned.mock.calls.at(-1)![0] as any;
    // Assert the actual composed argument, not a substring of some other message —
    // and mutation-check by construction: dropping the note at this call site would
    // make promptTemplate equal the bare mode.prompt, failing the second assertion.
    expect(req.promptTemplate).toBe(composeAgentPrompt(implMode.prompt, note));
    expect(req.promptTemplate).not.toBe(implMode.prompt);
  });

  it("passes the mode's template byte-identically to the launcher when the edge has no note", async () => {
    const implMode = DEFAULT_PROMPT_MODES.find((m) => m.id === "implementation")!;
    // launchFlow()'s edge carries no `note` — today's behaviour, provably preserved.
    const { send } = await warmed([launchFlow()]);
    await send({ type: "deck:refresh" });
    const req = h.launchPlanned.mock.calls.at(-1)![0] as any;
    expect(req.promptTemplate).toBe(implMode.prompt);
  });

  it("stamps an error and promotes nothing when the launch fails, and never retries it", async () => {
    h.launchPlanned.mockResolvedValue({ ok: false, message: "Couldn't create a git worktree in aws-ops" });
    const { p, send } = await warmed([launchFlow()]);
    await send({ type: "deck:refresh" });
    const w = lastWrite();
    expect(w.edges[0].error).toBe("Couldn't create a git worktree in aws-ops");
    expect(w.edges[0].firedAt).toBeUndefined();
    expect(w.nodes.find((n) => n.id === "n2")!.kind).toBe("planned");
    // No toast claims a launch that never happened…
    expect(posts(p).some((m) => m.type === "toast" && m.level === "success")).toBe(false);
    // …but the failure — "Couldn't create a git worktree in aws-ops — not
    // launching PROJ-12" is exactly the class of message that must not die
    // inside an unfocused panel — reaches the human as a notification too. It
    // goes through showErrorMessage specifically, not showInformationMessage —
    // red is reserved for a rule that tried and actually failed (the same
    // house rule .fl-receipt .err leans on), and it is what keeps this failure
    // reading as visibly different from an ordinary `notify` firing.
    expect(window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("Couldn't create a git worktree in aws-ops"),
    );
    expect(window.showInformationMessage).not.toHaveBeenCalled();
    // …and the failure is not retried on the next poll: twenty windows is how that ends.
    h.launchPlanned.mockClear();
    await send({ type: "deck:refresh" });
    expect(h.launchPlanned).not.toHaveBeenCalled();
  });

  it("refuses a node whose prompt mode is no longer configured, rather than substituting one", async () => {
    // A user who deleted a mode must not get an agent seeded with someone else's prompt.
    const { send } = await warmed([launchFlow({
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
        {
          id: "n2", kind: "planned", x: 0, y: 0, join: "any",
          ticketKey: "PROJ-12", repos: ["aws-ops"], mode: "deleted-mode", dest: "worktree",
        },
      ],
    })]);
    await send({ type: "deck:refresh" });
    expect(h.launchPlanned).not.toHaveBeenCalled();
    const w = lastWrite();
    expect(w.edges[0].error).toContain("deleted-mode");
    expect(w.edges[0].firedAt).toBeUndefined();
    expect(w.nodes.find((n) => n.id === "n2")!.kind).toBe("planned");
  });

  it("leaves a rule pending when the ticket read fails, and retries it on the next pass", async () => {
    // A pre-flight READ spent nothing and decided nothing: a Jira blip, an expired
    // token, a dropped VPN. Latching there would let one hiccup permanently kill a
    // rule the user then has to go and find. Distinct from a failed LAUNCH, which
    // stays latched because it may have spent something.
    const log = vi.fn();
    h.getDetail.mockRejectedValueOnce(new Error("Jira said 503"));
    const { p, send } = await warmed([launchFlow()], log);
    const toastsBefore = toastCount(p);
    await send({ type: "deck:refresh" });
    expect(h.launchPlanned).not.toHaveBeenCalled();
    // Nothing decided: nothing written, and nothing said out loud either — an
    // unattended flow must not pop a notification for a transient read.
    expect(h.writeFlow).not.toHaveBeenCalled();
    expect(toastCount(p)).toBe(toastsBefore);
    expect(h.flows[0].edges[0].error).toBeUndefined();
    expect(h.flows[0].edges[0].firedAt).toBeUndefined();
    // It is in the log, though — a rule quietly not advancing is otherwise invisible.
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Jira said 503"));
    // And the next pass gets on with it.
    await send({ type: "deck:refresh" });
    expect(h.launchPlanned).toHaveBeenCalledTimes(1);
    expect(lastWrite().edges[0].firedAt).toBeTypeOf("number");
    expect(lastWrite().nodes.find((n) => n.id === "n2")).toMatchObject({ kind: "place", runKey: "PROJ-12" });
  });

  it("writes nothing and says nothing when EVERY rule defers", async () => {
    // Two deferring rules rather than one, so this cannot pass by way of a check
    // that happens to hold for a single edge. An unchanged flow is not worth a write,
    // and there is nothing to announce.
    h.getDetail.mockRejectedValue(new Error("Jira said 503"));
    const { p, send } = await warmed([launchFlow({
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
        {
          id: "n2", kind: "planned", x: 0, y: 0, join: "any",
          ticketKey: "PROJ-12", repos: ["aws-ops"], mode: "implementation", dest: "worktree",
        },
        {
          id: "n3", kind: "planned", x: 0, y: 0, join: "any",
          ticketKey: "PROJ-13", repos: ["aws-ops"], mode: "implementation", dest: "worktree",
        },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "launch" },
        { id: "e2", from: "n1", to: "n3", cond: { kind: "pr-merged" }, action: "launch" },
      ],
    })]);
    const toastsBefore = toastCount(p);
    await send({ type: "deck:refresh" });
    expect(h.getDetail).toHaveBeenCalledTimes(2); // both rules really were attempted
    expect(h.writeFlow).not.toHaveBeenCalled();
    expect(toastCount(p)).toBe(toastsBefore);
    expect(h.flows[0].edges.every((e) => e.firedAt === undefined && e.error === undefined)).toBe(true);
  });

  it("still stamps the rules that DID decide when one of them defers", async () => {
    // The defer is per rule, not per pass: a notify that fired in the same pass has
    // already been announced, so leaving it unstamped would announce it again forever.
    h.getDetail.mockRejectedValue(new Error("Jira said 503"));
    const { send } = await warmed([launchFlow({
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
        {
          id: "n2", kind: "planned", x: 0, y: 0, join: "any",
          ticketKey: "PROJ-12", repos: ["aws-ops"], mode: "implementation", dest: "worktree",
        },
        { id: "n3", kind: "notify", x: 0, y: 0, join: "any", message: "the migration has landed" },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "launch" },
        { id: "e2", from: "n1", to: "n3", cond: { kind: "pr-merged" }, action: "notify" },
      ],
    })]);
    await send({ type: "deck:refresh" });
    const w = lastWrite();
    expect(w.edges.find((e) => e.id === "e2")!.firedAt).toBeTypeOf("number");
    const deferredEdge = w.edges.find((e) => e.id === "e1")!;
    expect(deferredEdge.firedAt).toBeUndefined();
    expect(deferredEdge.error).toBeUndefined();
    expect(window.showInformationMessage).toHaveBeenCalledWith(expect.stringMatching(/the migration has landed/));
  });

  it("journals a deferred rule with the reason, so a silently-stalled flow is diagnosable", async () => {
    // Same fixture as the case above: e1's Jira read fails, so it defers, while the
    // notify beside it decides normally.
    h.getDetail.mockRejectedValue(new Error("Jira said 503"));
    const { send } = await warmed([launchFlow({
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
        {
          id: "n2", kind: "planned", x: 0, y: 0, join: "any",
          ticketKey: "PROJ-12", repos: ["aws-ops"], mode: "implementation", dest: "worktree",
        },
        { id: "n3", kind: "notify", x: 0, y: 0, join: "any", message: "the migration has landed" },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "launch" },
        { id: "e2", from: "n1", to: "n3", cond: { kind: "pr-merged" }, action: "notify" },
      ],
    })]);
    await send({ type: "deck:refresh" });
    const deferred = journal().filter((e) => e.kind === "deferred");
    expect(deferred).toHaveLength(1);
    expect(deferred[0]).toMatchObject({ kind: "deferred", edge: "e1" });
    expect(deferred[0].reason).toBeTruthy();
  });

  it("never routes a seed rule through the launcher — see \"a met seed rule acts\" below for its own path", async () => {
    // `seed` opens another agent in a place that already exists; it has no ticket
    // and nothing to launch, so it must never reach launchPlanned, however its own
    // rule resolves. The full seed behavior (success, and every latch) has its own
    // describe block below, with its own fixtures — a place's run/repo has to be
    // resolvable against the statuses this pass built, which this file's `PROJ-1`
    // fixture (repo "aws-ops" only) does not model for a second place.
    const { send } = await warmed([launchFlow({
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
        { id: "n2", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-9", repo: "aws-ops" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "seed", mode: "implementation" }],
    })]);
    await send({ type: "deck:refresh" });
    expect(h.launchPlanned).not.toHaveBeenCalled();
    expect(h.openWorkspace).not.toHaveBeenCalled();
    // PROJ-9 is not in the statuses this pass built (only PROJ-1 is), so this
    // particular rule happens to latch on the missing-run guard — proven properly,
    // with its own message assertion, below.
    expect(lastWrite().edges[0].error).toBeTypeOf("string");
    expect(lastWrite().edges[0].firedAt).toBeUndefined();
  });

  it("fires a notify rule with no confirmation at all — notify spends nothing", async () => {
    const { send } = await warmed([launchFlow({
      launchConfirmedAt: undefined,
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
        { id: "n2", kind: "notify", x: 0, y: 0, join: "any", message: "the migration has landed" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" }],
    })]);
    await send({ type: "deck:refresh" });
    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(lastWrite().edges[0].firedAt).toBeTypeOf("number");
    expect(lastWrite().launchConfirmedAt).toBeUndefined();
    expect(window.showInformationMessage).toHaveBeenCalledWith(expect.stringMatching(/the migration has landed/));
  });

  it("launches ONCE for an \"all\" junction, not once per incoming edge", async () => {
    // An "all" junction stamps every incoming edge and acts once. Both edges here
    // point at the same planned node, so acting per stamped edge would open two
    // worktrees and pay for two sessions on one ticket.
    const { send } = await warmed([launchFlow({
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
        {
          id: "n2", kind: "planned", x: 0, y: 0, join: "all",
          ticketKey: "PROJ-12", repos: ["aws-ops"], mode: "implementation", dest: "worktree",
        },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "launch" },
        { id: "e2", from: "n1", to: "n2", cond: { kind: "ci-passed" }, action: "launch" },
      ],
    })]);
    await send({ type: "deck:refresh" });
    expect(h.launchPlanned).toHaveBeenCalledTimes(1);
    const w = lastWrite();
    expect(w.edges.find((e) => e.id === "e1")!.firedNote).toContain("launched");
    // The sibling is stamped as closed — never as a launch it did not perform.
    expect(w.edges.find((e) => e.id === "e2")!.firedNote).toBe("another edge into this target already acted");
    expect(w.nodes.filter((n) => n.kind === "place")).toHaveLength(2);
  });

  /** The same two rules into one planned node, but with the DEFAULT `join: "any"` —
   * the shape `evaluate.ts` does NOT collapse to a single performer. `pr-merged` and
   * `ci-passed` are both true the moment a PR merges, so this is the ordinary way a
   * user wires "when it lands, start the next ticket". */
  const twoRulesOneTarget = (over: Partial<Flow> = {}): Flow => launchFlow({
    nodes: [
      { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
      {
        id: "n2", kind: "planned", x: 0, y: 0, join: "any",
        ticketKey: "PROJ-12", repos: ["aws-ops"], mode: "implementation", dest: "worktree",
      },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "launch" },
      { id: "e2", from: "n1", to: "n2", cond: { kind: "ci-passed" }, action: "launch" },
    ],
    ...over,
  });

  it("launches ONCE for a join:any node with two met rules, and stamps both edges", async () => {
    // THE unit of work is the target node, not the edge. `evaluate.ts` marks every met
    // edge into a non-all target as performing, so acting per edge here would open two
    // worktrees and pay for two sessions on one ticket — and promote the same node
    // twice, the second runKey orphaning the run the first launch actually created.
    const { p, send } = await warmed([twoRulesOneTarget()], undefined, redStatus("PROJ-1", "aws-ops"));
    await send({ type: "deck:refresh" });
    expect(h.launchPlanned).toHaveBeenCalledTimes(1);
    const w = lastWrite();
    // Both edges fired — leaving the second unstamped would re-evaluate it forever…
    expect(w.edges.find((e) => e.id === "e1")!.firedAt).toBeTypeOf("number");
    expect(w.edges.find((e) => e.id === "e2")!.firedAt).toBeTypeOf("number");
    // …but only one of them claims to have launched anything.
    expect(w.edges.find((e) => e.id === "e1")!.firedNote).toContain("launched");
    // Not "closed with its junction" — a default `join: "any"` node with two
    // rules into it is not a junction at all; this is the per-target dedupe.
    expect(w.edges.find((e) => e.id === "e2")!.firedNote).toBe("another edge into this target already acted");
    expect(w.edges.find((e) => e.id === "e2")!.error).toBeUndefined();
    // Promoted exactly once, to the run the one launch returned.
    expect(w.nodes.find((n) => n.id === "n2")).toMatchObject({ kind: "place", runKey: "PROJ-12" });
    // And said out loud once, not twice.
    expect(posts(p).filter((m) => m.type === "toast" && /launched PROJ-12/.test(m.message ?? ""))).toHaveLength(1);
  });

  it("settles a fan-in sibling whose condition never held, instead of leaving it live as a seed", async () => {
    // The end state this phase needs. Promotion turns the target `planned -> place`,
    // so an unsettled sibling's verb changes under it: clearing its stored action
    // stops the false latch, but left live it becomes a `seed` rule, and its own
    // condition coming true later opens an ADDITIONAL paid agent session the user
    // never wrote — under a consent stamped for a launch. In a `join: "any"` fan-in
    // the sibling means "this is another reason to get PROJ-12 running", and PROJ-12 is
    // running.
    //
    // `review-approved` is never met by this fixture (its PR carries no review), so
    // e2 is genuinely unsettled when e1 launches.
    const unmetSibling = (): Flow => launchFlow({
      edges: [
        { id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "launch" },
        { id: "e2", from: "n1", to: "n2", cond: { kind: "review-approved" }, action: "launch" },
      ],
    });
    const { send } = await warmed([unmetSibling()]);
    await send({ type: "deck:refresh" });
    expect(h.launchPlanned).toHaveBeenCalledTimes(1);
    const w = lastWrite();
    const e2 = w.edges.find((e) => e.id === "e2")!;
    // Satisfied, with a receipt that says why — visible in the drawer, and Resettable
    // if the user genuinely wanted a seed out of this wire.
    expect(e2.firedAt).toBeTypeOf("number");
    expect(e2.firedNote).toBe("PROJ-12 was already launched by another rule");
    // It ran nothing, so it must not read as a performer…
    expect(e2.performed).toBeUndefined();
    // …and nothing failed, so it is not an error either.
    expect(e2.error).toBeUndefined();
    // The next pass leaves it alone: no second session, and nothing new written.
    h.flows = [w];
    h.writeFlow.mockClear();
    h.launchPlanned.mockClear();
    await send({ type: "deck:refresh" });
    expect(h.launchPlanned).not.toHaveBeenCalled();
    expect(h.openWorkspace).not.toHaveBeenCalled();
    expect(h.writeFlow).not.toHaveBeenCalled();
  });

  it("holds a whole target back when its acting rule defers, siblings included", async () => {
    // e1 acts and defers; e2 points at the same node and must NOT act in its place —
    // that would spend exactly what the defer avoided. Nothing about this target is
    // stamped either, so the next pass retries the target as a whole.
    h.getDetail.mockRejectedValue(new Error("Jira said 503"));
    const { p, send } = await warmed([twoRulesOneTarget()], undefined, redStatus("PROJ-1", "aws-ops"));
    const toastsBefore = toastCount(p);
    await send({ type: "deck:refresh" });
    expect(h.launchPlanned).not.toHaveBeenCalled();
    expect(h.getDetail).toHaveBeenCalledTimes(1); // one attempt for the target, not one per edge
    expect(h.writeFlow).not.toHaveBeenCalled();
    expect(toastCount(p)).toBe(toastsBefore);
    expect(h.flows[0].edges.every((e) => e.firedAt === undefined && e.error === undefined)).toBe(true);
    expect(h.flows[0].nodes.find((n) => n.id === "n2")!.kind).toBe("planned");
  });

  it("promotes and toasts only the targets that survive into the write", async () => {
    // One target defers, another succeeds. The successful one is stamped, promoted and
    // announced; the deferred one is left entirely alone. A promotion or a toast that
    // outran its own stamp would leave the drawer showing a rule as still waiting on a
    // node that is already a place — which the next pass then latches as "must point
    // at planned work".
    h.getDetail.mockImplementation(async (key: string) => {
      if (key === "PROJ-12") throw new Error("Jira said 503");
      return {
        key, summary: "do it", url: `https://jira/browse/${key}`, descriptionText: "the description",
        labels: [], components: [], status: null, statusCategory: null,
      };
    });
    const { p, send } = await warmed([launchFlow({
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
        {
          id: "n2", kind: "planned", x: 0, y: 0, join: "any",
          ticketKey: "PROJ-12", repos: ["aws-ops"], mode: "implementation", dest: "worktree",
        },
        {
          id: "n3", kind: "planned", x: 0, y: 0, join: "any",
          ticketKey: "PROJ-13", repos: ["aws-ops"], mode: "implementation", dest: "worktree",
        },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "launch" },
        { id: "e2", from: "n1", to: "n3", cond: { kind: "pr-merged" }, action: "launch" },
      ],
    })]);
    await send({ type: "deck:refresh" });
    const w = lastWrite();
    // The one that worked: stamped, promoted, announced.
    expect(w.edges.find((e) => e.id === "e2")!.firedAt).toBeTypeOf("number");
    expect(w.nodes.find((n) => n.id === "n3")).toMatchObject({ kind: "place", runKey: "PROJ-13" });
    expect(posts(p).some((m) => m.type === "toast" && /launched PROJ-13/.test(m.message ?? ""))).toBe(true);
    // The one that deferred: untouched in every respect.
    expect(w.edges.find((e) => e.id === "e1")!.firedAt).toBeUndefined();
    expect(w.edges.find((e) => e.id === "e1")!.error).toBeUndefined();
    expect(w.nodes.find((n) => n.id === "n2")!.kind).toBe("planned");
    expect(posts(p).some((m) => m.type === "toast" && /PROJ-12/.test(m.message ?? ""))).toBe(false);
  });

  it("still launches at most three per pass, and the rest on the next one", async () => {
    // The cap is evaluateFlow's, and acting must not loop around it: five met
    // launch rules are five paid sessions if the cap is bypassed.
    const many = (): Flow => ({
      ...launchFlow(),
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
        ...[1, 2, 3, 4, 5].map((i) => ({
          id: `p${i}`, kind: "planned" as const, x: 0, y: 0, join: "any" as const,
          ticketKey: `PROJ-2${i}`, repos: ["aws-ops"], mode: "implementation", dest: "worktree" as const,
        })),
      ],
      edges: [1, 2, 3, 4, 5].map((i) => ({
        id: `e${i}`, from: "n1", to: `p${i}`, cond: { kind: "pr-merged" as const }, action: "launch" as const,
      })),
    });
    const { send } = await warmed([many()]);
    await send({ type: "deck:refresh" });
    expect(h.launchPlanned).toHaveBeenCalledTimes(3);
    const keys = h.launchPlanned.mock.calls.map((c) => (c[0] as any).node.ticketKey);
    expect(keys).toEqual(["PROJ-21", "PROJ-22", "PROJ-23"]);
    // Each promoted to its own run, not all collapsed onto one.
    const w = lastWrite();
    expect(w.nodes.filter((n) => n.kind === "place").map((n: any) => n.runKey))
      .toEqual(["PROJ-1", "PROJ-21", "PROJ-22", "PROJ-23"]);
    h.launchPlanned.mockClear();
    await send({ type: "deck:refresh" });
    expect(h.launchPlanned.mock.calls.map((c) => (c[0] as any).node.ticketKey)).toEqual(["PROJ-24", "PROJ-25"]);
  });

  it("stops a later acting edge in the same pass once the flow is disarmed mid-pass", async () => {
    // Three targets, so this pass has three `performEdge` calls to make, each one
    // an await — room for `flow:arm` (this window, or another) to disarm the flow
    // between the first launch and the second. Harmless for a toast; not for a
    // launch, which is exactly why this guard exists.
    const many = (): Flow => ({
      ...launchFlow(),
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
        ...[1, 2, 3].map((i) => ({
          id: `p${i}`, kind: "planned" as const, x: 0, y: 0, join: "any" as const,
          ticketKey: `PROJ-2${i}`, repos: ["aws-ops"], mode: "implementation", dest: "worktree" as const,
        })),
      ],
      edges: [1, 2, 3].map((i) => ({
        id: `e${i}`, from: "n1", to: `p${i}`, cond: { kind: "pr-merged" as const }, action: "launch" as const,
      })),
    });
    const { send } = await warmed([many()]);
    h.launchPlanned.mockClear().mockImplementation(async (req: { node: { ticketKey: string; repos: string[] } }) => {
      // The disarm itself: written straight to the store, exactly as a `flow:arm`
      // handler (this window) or another window's own write would land on disk
      // while THIS pass sits inside the first launch's await.
      h.flows = h.flows.map((f) => ({ ...f, armed: false }));
      return { ok: true, runKey: req.node.ticketKey, repo: req.node.repos[0] };
    });
    await send({ type: "deck:refresh" });
    // Only the first edge got to launch.
    expect(h.launchPlanned).toHaveBeenCalledTimes(1);
    const w = lastWrite();
    expect(w.edges.find((e) => e.id === "e1")!.firedAt).toBeTypeOf("number");
    // The two stopped mid-pass are left exactly as they were — no error, no
    // firedAt — so a re-arm gets a clean retry rather than a latched failure.
    expect(w.edges.find((e) => e.id === "e2")!.firedAt).toBeUndefined();
    expect(w.edges.find((e) => e.id === "e2")!.error).toBeUndefined();
    expect(w.edges.find((e) => e.id === "e3")!.firedAt).toBeUndefined();
    expect(w.edges.find((e) => e.id === "e3")!.error).toBeUndefined();
    expect(w.nodes.find((n) => n.id === "p2")!.kind).toBe("planned");
    expect(w.nodes.find((n) => n.id === "p3")!.kind).toBe("planned");
    // The Disarm itself must survive this pass's own write. `fresh` was read
    // BEFORE the disarm landed, so writing straight from `fresh` would silently
    // resurrect `armed: true` over the disarm the mock above just wrote to
    // `h.flows` — undoing the very thing the guard above is supposed to make
    // stick. Stopping a later edge is worthless if the write undoes the stop.
    expect(w.armed).toBe(false);
    // And a stop, not a pause: the two edges left pending must not launch on the
    // NEXT pass either, because the flow they belong to is disarmed. If the write
    // above resurrected `armed: true`, this is where that would show up.
    h.launchPlanned.mockClear();
    await send({ type: "deck:refresh" });
    expect(h.launchPlanned).not.toHaveBeenCalled();
  });

  it("journals a rule skipped because the flow was disarmed mid-pass", async () => {
    // The fixture above, exactly: three acting rules, and the first launch disarms
    // the flow from under the pass.
    const many = (): Flow => ({
      ...launchFlow(),
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
        ...[1, 2, 3].map((i) => ({
          id: `p${i}`, kind: "planned" as const, x: 0, y: 0, join: "any" as const,
          ticketKey: `PROJ-2${i}`, repos: ["aws-ops"], mode: "implementation", dest: "worktree" as const,
        })),
      ],
      edges: [1, 2, 3].map((i) => ({
        id: `e${i}`, from: "n1", to: `p${i}`, cond: { kind: "pr-merged" as const }, action: "launch" as const,
      })),
    });
    const { send } = await warmed([many()]);
    h.launchPlanned.mockClear().mockImplementation(async (req: { node: { ticketKey: string; repos: string[] } }) => {
      h.flows = h.flows.map((f) => ({ ...f, armed: false }));
      return { ok: true, runKey: req.node.ticketKey, repo: req.node.repos[0] };
    });
    await send({ type: "deck:refresh" });
    // BOTH rules the single Disarm left pending, not one: the log line and the
    // telemetry event are per flow (one disarm happened), but a skip is per rule,
    // and which rules were left pending is the fact only the journal carries.
    const skipped = journal().filter((e) => e.kind === "skipped");
    expect(skipped).toHaveLength(2);
    expect(skipped.every((e) => e.kind === "skipped" && e.reason === "disarmed-mid-pass")).toBe(true);
    expect(skipped.map((e) => e.edge)).toEqual(["e2", "e3"]);
  });

  it("a concurrent flow:resetEdge on another edge survives this pass's write", async () => {
    // e2 is already settled (errored) before this pass starts, so `evaluateFlow`
    // never touches it — `isSettled` skips it outright. The user Resets it (the
    // real handler rebuilds it from only its structural fields, dropping
    // firedAt/firedNote/error) while THIS pass is inside e1's launch await. The
    // pass's own write, built from a read taken before the Reset landed, must not
    // silently restore the error the user just cleared.
    const withErroredSibling = (): Flow => {
      const base = launchFlow();
      return {
        ...base,
        nodes: [...base.nodes, { id: "n3", kind: "notify", x: 0, y: 0, join: "any", message: "already done" }],
        edges: [
          ...base.edges,
          { id: "e2", from: "n1", to: "n3", cond: { kind: "ci-failed" }, action: "notify", error: "boom" },
        ],
      };
    };
    const { send } = await warmed([withErroredSibling()]);
    h.launchPlanned.mockClear().mockImplementation(async (req: { node: { ticketKey: string; repos: string[] } }) => {
      // The Reset itself: written straight to the store, exactly as
      // `flow:resetEdge`'s handler would while this pass sits inside e1's await.
      h.flows = h.flows.map((f) => ({
        ...f,
        edges: f.edges.map((e) =>
          (e.id === "e2" ? { id: e.id, from: e.from, to: e.to, cond: e.cond, action: e.action, mode: e.mode } : e)),
      }));
      return { ok: true, runKey: req.node.ticketKey, repo: req.node.repos[0] };
    });
    await send({ type: "deck:refresh" });
    const w = lastWrite();
    expect(w.edges.find((e) => e.id === "e1")!.firedAt).toBeTypeOf("number");
    expect(w.edges.find((e) => e.id === "e2")!.error).toBeUndefined();
  });

  it("a concurrent flow:rename survives this pass's write", async () => {
    const { send } = await warmed([launchFlow()]);
    h.launchPlanned.mockClear().mockImplementation(async (req: { node: { ticketKey: string; repos: string[] } }) => {
      // The rename itself: written straight to the store, exactly as
      // `flow:rename`'s handler would while this pass sits inside e1's await.
      h.flows = h.flows.map((f) => ({ ...f, name: "Renamed mid-pass" }));
      return { ok: true, runKey: req.node.ticketKey, repo: req.node.repos[0] };
    });
    await send({ type: "deck:refresh" });
    const w = lastWrite();
    expect(w.edges[0].firedAt).toBeTypeOf("number");
    expect(w.name).toBe("Renamed mid-pass");
  });

  it("chains a promotion into the next hop: pass 2 sees the new place and fires out of it", async () => {
    // The phase's headline behavior, end to end rather than in its two separate,
    // already-unit-tested halves (a launch promotes its target; a place-node
    // condition evaluates against a run). "PROJ-1 merged -> launch PROJ-12 ->
    // PROJ-12 merged -> notify" is the design doc's own worked example for why
    // the planned-to-place rewrite exists at all — nothing here proves the chain
    // actually completes across two real passes.
    const chain = (): Flow => ({
      ...mkFlow("f1", "Ship the migration"),
      armed: true,
      launchConfirmedAt: 500,
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
        {
          id: "n2", kind: "planned", x: 0, y: 0, join: "any",
          ticketKey: "PROJ-12", repos: ["aws-ops"], mode: "implementation", dest: "worktree",
        },
        { id: "n3", kind: "notify", x: 0, y: 0, join: "any", message: "chain complete" },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "launch" },
        { id: "e2", from: "n2", to: "n3", cond: { kind: "pr-merged" }, action: "notify" },
      ],
    });
    const { send } = await warmed([chain()]);
    await send({ type: "deck:refresh" });
    // e1 fired: n2 is now a place, bound to the run the launch returned.
    let w = lastWrite();
    expect(w.edges.find((e) => e.id === "e1")!.firedAt).toBeTypeOf("number");
    expect(w.nodes.find((n) => n.id === "n2")).toMatchObject({ kind: "place", runKey: "PROJ-12" });
    // e2 has NOT fired — n2 was still planned work when THIS pass evaluated, so
    // there was no run for its condition to read yet.
    expect(w.edges.find((e) => e.id === "e2")!.firedAt).toBeUndefined();

    // The run a real launch's `writeRun` would have recorded now exists —
    // `launchPlanned` is mocked here, so this is that record's stand-in — and its
    // PR is already merged.
    h.runs.push(mkRun({ key: "PROJ-12", repos: [{ name: "aws-ops", path: "/r/aws-ops", isGit: true, branch: "b" }] }));
    h.buildRunStatus.mockImplementation((i: { run: Run }) =>
      (i.run.key === "PROJ-12" ? mergedStatus("PROJ-12", "aws-ops") : mergedStatus("PROJ-1", "aws-ops")));
    h.writeFlow.mockClear();
    await send({ type: "deck:refresh" });
    w = lastWrite();
    expect(w.edges.find((e) => e.id === "e2")!.firedAt).toBeTypeOf("number");
    expect(window.showInformationMessage).toHaveBeenCalledWith(expect.stringMatching(/chain complete/));
  });
});

describe("an edge whose target changes kind between evaluation and the write", () => {
  // `advanceUnderLock` evaluates against one read of the store and then re-reads
  // it immediately before writing, to drop anything another window claimed in
  // between (Task 5). That guard is about WHICH edges got claimed — this is
  // about a still-unclaimed edge whose ACTION is no longer the same question it
  // was a read ago.
  //
  // An action is DERIVED from the target node's kind now, which is why this
  // block is about the NODE and not about `edge.action`: editing the stored
  // mirror mid-pass changes nothing at all, so a fixture that did it would be
  // pinning a scenario that cannot happen. Re-pointing or re-kinding the TARGET
  // is the only edit that can make evaluation and the write disagree about what
  // a rule does.
  //
  // The vintage rule this block exists to pin: `evaluateFlow` derives the verb
  // ONCE, onto `FiredEdge.action`, and the dispatch, the spend gate,
  // `performEdge`, `applyFired` and `notifyLines` all read that one carried
  // value. A second derivation against the fresh copy is what used to let a
  // refused launch be stamped and announced as a notify success.
  const flow = (target: "notify" | "planned"): Flow => ({
    ...mkFlow("f1", "Ship the migration"),
    armed: true,
    launchConfirmedAt: 500,
    nodes: [
      { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
      target === "notify"
        ? { id: "n2", kind: "notify", x: 0, y: 0, join: "any", message: "it happened" }
        : {
            id: "n2", kind: "planned", x: 0, y: 0, join: "any",
            ticketKey: "PROJ-12", repos: ["aws-ops"], mode: "implementation", dest: "worktree",
          },
    ],
    // No stored `action`: the record's mirror decides nothing, and a fixture
    // that set one would invite the reader to think it did.
    edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" } }],
  });

  /** Open with the condition UNMET so the resume gate clears itself (Task 4),
   * then arm the met one — the same two-pass idiom every firing test in this
   * file uses. Returns the panel and a way to drive one more pass. */
  const warmed = async (first: Flow) => {
    setConfig({ orchestrator: true });
    h.flows = [first];
    h.buildRunStatus.mockReturnValue(openStatus("PROJ-1", "aws-ops"));
    show();
    await settled();
    const p = lastPanel();
    const send = async (m: unknown) => { await p._fire(m); await settled(); };
    await settle();
    h.buildRunStatus.mockReturnValue(mergedStatus("PROJ-1", "aws-ops"));
    h.writeFlow.mockClear();
    return { p, send };
  };

  it("stands by a notify decision for a target that became planned work, and launches nothing", async () => {
    // This case USED to assert that such an edge is attempted as a launch and
    // refused, because the dispatch re-read the action from the fresh copy. It
    // inverts under the carried action, deliberately: a concurrent edit does not
    // retroactively change what evaluation decided. The decision stands as the
    // `notify` it was, and standing by it is SAFE precisely because a notify
    // spends nothing — the direction that could spend is the case below, and
    // there the target it would spend on is what has gone missing.
    const { p, send } = await warmed(flow("notify"));
    const toastsBefore = posts(p).filter((m) => m.type === "toast").length;

    // Read 1 is evaluation's own — a notify terminal, so `notify`. Every read
    // after it (the `fresh` copy, the pre-write `atWrite` read, and postFlows')
    // sees planned work in its place, as if a drawer edit landed in between.
    let reads = 0;
    h.readFlows.mockImplementation(() => (++reads === 1 ? [flow("notify")] : [flow("planned")]));
    await send({ type: "deck:refresh" });
    expect(reads).toBeGreaterThan(1);

    // The money guarantee, verbatim: a mid-pass edit cannot promote a decided
    // notify into a paid session.
    expect(h.launchPlanned).not.toHaveBeenCalled();
    const w = h.writeFlow.mock.calls.at(-1)![2] as Flow;
    // Stamped as the notify it was decided as — not refused as an unperformed
    // launch, which is what a second derivation here would produce.
    expect(w.edges[0].firedAt).toBeTypeOf("number");
    expect(w.edges[0].error).toBeUndefined();
    // But the receipt does NOT quote a message the target no longer has: the
    // node it points at is planned work now, so `performedNote` falls back to
    // the generic line rather than claiming words that are gone.
    expect(w.edges[0].firedNote).toBe("told you");
    // Same discipline one layer out — the announcement is the generic line, and
    // must NOT claim the notify's message was told.
    expect(window.showInformationMessage).toHaveBeenCalledWith("Ship the migration: a rule fired.");
    expect(window.showInformationMessage).not.toHaveBeenCalledWith(expect.stringContaining("it happened"));
    // And nothing reached the webview as a toast either.
    expect(posts(p).filter((m) => m.type === "toast").length).toBe(toastsBefore);
  });

  it("does not launch, or spend anything, for a target revoked to a notify before the write", async () => {
    // The dangerous direction. The other one (tested above) spends nothing
    // either way. This one would: a `launch` decided against planned work whose
    // node the user has since turned into a notify terminal must not go ahead
    // and launch on the strength of a verdict the user has already revoked.
    //
    // The revocation is a NODE edit, not an edge edit — under derivation that is
    // what revoking a launch means, and it is also what makes the carried action
    // safe: the verb stands, but the planned node it would have spent on is gone,
    // so there is nothing left to launch and the rule is refused.
    const { p, send } = await warmed(flow("planned"));

    let reads = 0;
    h.readFlows.mockImplementation(() => (++reads === 1 ? [flow("planned")] : [flow("notify")]));
    await send({ type: "deck:refresh" });
    expect(reads).toBeGreaterThan(1);

    // No worktree, no window, no agent session — the whole point.
    expect(h.launchPlanned).not.toHaveBeenCalled();
    expect(h.openWorkspace).not.toHaveBeenCalled();
    const w = h.writeFlow.mock.calls.at(-1)![2] as Flow;
    // Settled as a refusal: an `error` so it cannot re-fire in a loop, and NO
    // `firedAt`, which would consume the latch as a success.
    expect(w.edges[0].error).toBe("a launch rule must point at planned work, and n2 is not.");
    expect(w.edges[0].firedAt).toBeUndefined();
    expect(w.edges[0].firedNote).toBeUndefined();
    // Nothing was promoted — a launch that had gone ahead would have turned this
    // node into a place bound to the run it created.
    expect(w.nodes.find((n) => n.id === "n2")!.kind).toBe("notify");
    // And nothing announced it as told, either: `notifyLines` reads the same
    // carried `launch`, so this edge produces no line at all.
    expect(window.showInformationMessage).not.toHaveBeenCalled();
    expect(posts(p).some((m) => m.type === "toast" && /launched/i.test(m.message ?? ""))).toBe(false);
  });
});

describe("a met seed rule acts", () => {
  /** `log` is injectable for the same reason `a met launch rule acts` above wants
   * it: nothing here asserts on it today, but keeping the same shape means a case
   * that later wants to assert on the log does not have to change this helper. */
  const openPanel = async (log: (m: string) => void = () => {}) => {
    DeckPanel.show(fakeContext().context as any, fakeConnector(), log);
    await settled();
    const p = lastPanel();
    return { p, send: async (m: unknown) => { await p._fire(m); await settled(); } };
  };

  /** One run, two repos: `aws-ops` is the watched place whose PR merging is the
   * rule's condition, `bite-me` is the place a `seed` opens another agent in. One
   * RunStatus covers both, since `Run.repos` is a single array and place nodes
   * only ever narrow it to one entry each. */
  const seedRunStatus = (prState: "OPEN" | "MERGED"): RunStatus => ({
    run: {
      key: "PROJ-1", summary: "ship the migration", url: "https://jira/PROJ-1", createdAt: 1, mode: "multiroot",
      repos: [
        { name: "aws-ops", path: "/r/aws-ops", isGit: true },
        { name: "bite-me", path: "/r/bite-me", isGit: true },
      ],
      briefPaths: [],
    },
    column: "progress", ticketStatus: "In Progress", ticketCategory: "indeterminate",
    shelf: "board",
    repos: [{ name: "aws-ops", path: "/r/aws-ops", branch: "b", dirty: false, ahead: 0, added: 0, removed: 0, files: 0 }],
    agent: { state: "working", lastActivityMs: 1, slug: null },
    windowOpen: true,
    prs: {
      "aws-ops": {
        facts: {
          number: 1, url: "u", title: "t", state: prState, isDraft: false,
          ci: { passing: 2, pending: 0, failing: [] }, review: "none", unresolved: null,
          mergeable: "clean", ciAdvisory: false,
        },
        fetchedAt: 1,
      },
    },
    agents: [],
  });

  /** A place watching `aws-ops`, wired to seed another agent into `bite-me` — both
   * places belong to the same run, `PROJ-1`. `launchConfirmedAt` is set by default,
   * exactly as `launchFlow` does above: most cases here are about what an
   * already-approved flow does, and the first-spend question has its own cases in
   * "the resume gate"/gate-widening tests below. */
  const seedFlow = (over: Partial<Flow> = {}): Flow => ({
    ...mkFlow("f1", "Ship the migration"),
    armed: true,
    launchConfirmedAt: 500,
    nodes: [
      { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
      { id: "n2", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "bite-me" },
    ],
    edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "seed", mode: "implementation" }],
    ...over,
  });

  /** Open with the condition UNMET so the resume gate clears itself (Task 4), then
   * arm the met one — the same two-pass idiom every firing test in this file uses. */
  const warmed = async (flows: Flow[], log?: (m: string) => void) => {
    setConfig({ orchestrator: true });
    h.flows = flows;
    h.buildRunStatus.mockReturnValue(seedRunStatus("OPEN"));
    const opened = await openPanel(log);
    await settle();
    h.buildRunStatus.mockReturnValue(seedRunStatus("MERGED"));
    h.writeFlow.mockClear();
    h.openWorkspace.mockClear();
    return opened;
  };

  const lastWrite = () => h.writeFlow.mock.calls.at(-1)![2] as Flow;

  /** `seedFlow` with its TARGET node's kind switched. An action is DERIVED from
   * that node, so re-kinding it is the only edit that can change what a rule
   * does — the two cases below steer `h.readFlows` between these variants to put
   * evaluation and the acting step in disagreement, which is the one way a
   * `seed` can find no place to seed. */
  const seedFlowTargeting = (kind: "place" | "notify", over: Partial<Flow> = {}): Flow => seedFlow({
    nodes: [
      { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
      kind === "place"
        ? { id: "n2", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "bite-me" }
        : { id: "n2", kind: "notify", x: 0, y: 0, join: "any", message: "not a place" },
    ],
    ...over,
  });

  it("opens another agent in the place's resolved directory, stamps the edge, and promotes nothing", async () => {
    const { p, send } = await warmed([seedFlow()]);
    await send({ type: "deck:refresh" });
    expect(h.openWorkspace).toHaveBeenCalledTimes(1);
    const req = h.openWorkspace.mock.calls.at(-1)![0] as any;
    // The failure this whole task is about: a seed pointed at the wrong directory
    // spends money in the wrong place. Assert the actual argument object, not a
    // substring of some derived message.
    expect(req.existingFolder).toBe("/r/bite-me");
    // The run this place belongs to already exists — a seed must not let
    // openWorkspace's own writeRun overwrite that record under the same key.
    expect(req.recordRun).toBe(false);
    // Nor overwrite the brief the agent ALREADY working in this worktree was given,
    // which is also the file this seeded prompt's own {brief} resolves to. With
    // planMd and descriptionText both empty, a rewrite replaces it with an empty one.
    expect(req.keepExistingBrief).toBe(true);
    expect(req.planMd).toBe("");
    expect(req.openIn).toBe("new");
    expect(req.mode).toBe("per-window");
    expect(req.services).toEqual([{ name: "bite-me", path: "/r/bite-me", isGit: true }]);
    expect(req.promptTemplate).toContain("Begin implementing"); // "implementation" mode, resolved
    expect(req.seedAgent).toBe(true);
    expect(req.workspaceDir).toBeTypeOf("string");
    expect(h.launchPlanned).not.toHaveBeenCalled();

    const w = lastWrite();
    expect(w.edges[0].firedAt).toBeTypeOf("number");
    expect(w.edges[0].error).toBeUndefined();
    expect(w.edges[0].firedNote).toContain("bite-me");
    // The place already existed — nothing was promoted, and the node is
    // byte-identical to what it was before this pass.
    expect(w.nodes.find((n) => n.id === "n2")).toMatchObject({ kind: "place", runKey: "PROJ-1", repo: "bite-me" });
    expect(posts(p).some((m) => m.type === "toast" && m.level === "success" && /bite-me/.test(m.message ?? ""))).toBe(true);
  });

  // ── the receipt's agent name ────────────────────────────────────────────────
  // `provider: "claude-code"` here is a PIN, read only under `ask` — so a `cursor`
  // user's unattended seed really does start Cursor, and the hardcoded "Claude Code"
  // in the receipt became wrong the moment this branch added that value.
  it("names Cursor in the seed receipt when Cursor is configured", async () => {
    h.agentProvider = "cursor";
    const { p, send } = await warmed([seedFlow()]);
    await send({ type: "deck:refresh" });
    const toast = posts(p).find((m) => m.type === "toast" && m.level === "success") as { message: string };
    expect(toast.message).toContain("Cursor pre-seeded — press Enter to start.");
  });

  it.each([["claude-code"], ["ask"], ["copilot"]])(
    "keeps the seed receipt saying Claude Code under %s",
    async (agentProvider) => {
      // `claude-code` and `ask` are simply right — the pin resolves to Claude Code on
      // both. `copilot` is wrong and stays wrong: that string predates this branch,
      // and thousands of Copilot users already read it.
      h.agentProvider = agentProvider as typeof h.agentProvider;
      const { p, send } = await warmed([seedFlow()]);
      await send({ type: "deck:refresh" });
      const toast = posts(p).find((m) => m.type === "toast" && m.level === "success") as { message: string };
      expect(toast.message).toContain("Claude Code pre-seeded — press Enter to start.");
    },
  );

  it("composes the edge's note into the prompt template handed to openWorkspace", async () => {
    const note = "This place already has context — just wire up the retry logic.";
    const implMode = DEFAULT_PROMPT_MODES.find((m) => m.id === "implementation")!;
    const { send } = await warmed([seedFlow({
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "seed", mode: "implementation", note }],
    })]);
    await send({ type: "deck:refresh" });
    const req = h.openWorkspace.mock.calls.at(-1)![0] as any;
    // Assert the actual composed argument, not a substring of some other message —
    // and mutation-check by construction: dropping the note at THIS call site (as
    // opposed to the launch one above) would make promptTemplate equal the bare
    // mode.prompt, failing the second assertion. A single shared test for both
    // call sites would not catch that.
    expect(req.promptTemplate).toBe(composeAgentPrompt(implMode.prompt, note));
    expect(req.promptTemplate).not.toBe(implMode.prompt);
  });

  it("passes the mode's template byte-identically to openWorkspace when the seed edge has no note", async () => {
    const implMode = DEFAULT_PROMPT_MODES.find((m) => m.id === "implementation")!;
    // seedFlow()'s edge carries no `note` — today's behaviour, provably preserved.
    const { send } = await warmed([seedFlow()]);
    await send({ type: "deck:refresh" });
    const req = h.openWorkspace.mock.calls.at(-1)![0] as any;
    expect(req.promptTemplate).toBe(implMode.prompt);
  });

  it("pins claude-code, so an unattended seed can never reach the `ask` picker", async () => {
    // A seed rule fires from the poll loop with nobody watching, exactly like a
    // launch rule. openWorkspace's picker is `ignoreFocusOut: true`, so reaching it
    // here would not time out — it would hold the refresh open until someone came
    // back and answered. Read ONLY under `ask`: a user whose setting says `cursor`
    // still gets Cursor, because openWorkspace ignores a pin under a fixed setting.
    const { send } = await warmed([seedFlow()]);
    await send({ type: "deck:refresh" });
    const req = h.openWorkspace.mock.calls.at(-1)![0] as any;
    expect(req.provider).toBe("claude-code");
  });

  it("latches when the place's run is no longer on the board, naming the run", async () => {
    const { send } = await warmed([seedFlow({
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
        { id: "n2", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-GONE", repo: "bite-me" },
      ],
    })]);
    await send({ type: "deck:refresh" });
    expect(h.openWorkspace).not.toHaveBeenCalled();
    const w = lastWrite();
    expect(w.edges[0].error).toContain("PROJ-GONE");
    expect(w.edges[0].firedAt).toBeUndefined();
    // Deterministic, so it is not retried on the next pass either.
    h.openWorkspace.mockClear();
    await send({ type: "deck:refresh" });
    expect(h.openWorkspace).not.toHaveBeenCalled();
  });

  it("latches when the place's repo is no longer one of that run's repos, naming the repo", async () => {
    const { send } = await warmed([seedFlow({
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
        { id: "n2", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "not-in-this-run" },
      ],
    })]);
    await send({ type: "deck:refresh" });
    expect(h.openWorkspace).not.toHaveBeenCalled();
    const w = lastWrite();
    expect(w.edges[0].error).toContain("not-in-this-run");
    expect(w.edges[0].firedAt).toBeUndefined();
  });

  it("refuses a seed rule whose target is no longer a place, the mirror of launch's not-planned guard", async () => {
    // The static fixture this used to use — a `seed` edge pointing at a notify
    // node — cannot reach `performSeed` any more: the verb is derived from the
    // target, so that node derives `notify` and there is no seed to refuse. A
    // seed with no place to seed is reachable exactly one way, the same way its
    // launch mirror is: the target's KIND changed between the read evaluation
    // derived the verb from and the copy this pass acts against.
    const { send } = await warmed([seedFlowTargeting("place")]);
    // Read 1 is evaluation's own — a place, so `seed`. Every read after it (the
    // `fresh` copy this pass acts and gates against, the pre-write `atWrite`
    // read, and postFlows') sees the notify terminal the node has become.
    let reads = 0;
    h.readFlows.mockImplementation(() => (++reads === 1 ? [seedFlowTargeting("place")] : [seedFlowTargeting("notify")]));
    await send({ type: "deck:refresh" });
    expect(reads).toBeGreaterThan(1);
    expect(h.openWorkspace).not.toHaveBeenCalled();
    expect(h.writeFlow).toHaveBeenCalled();
    const w = lastWrite();
    // Settled as a refusal: an `error` so it cannot re-fire in a loop, and NO
    // `firedAt`, which would consume the latch as a success.
    expect(w.edges[0].error).toBe("a seed rule must point at a place, and n2 is not.");
    expect(w.edges[0].firedAt).toBeUndefined();
  });

  it("refuses a seed whose prompt mode is no longer configured, rather than substituting one", async () => {
    const { send } = await warmed([seedFlow({
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "seed", mode: "deleted-mode" }],
    })]);
    await send({ type: "deck:refresh" });
    expect(h.openWorkspace).not.toHaveBeenCalled();
    const w = lastWrite();
    expect(w.edges[0].error).toContain("deleted-mode");
    expect(w.edges[0].firedAt).toBeUndefined();
  });

  it("stamps an error and never retries when openWorkspace itself throws", async () => {
    h.openWorkspace.mockRejectedValueOnce(new Error("disk full"));
    const { p, send } = await warmed([seedFlow()]);
    await send({ type: "deck:refresh" });
    const w = lastWrite();
    expect(w.edges[0].error).toContain("disk full");
    expect(w.edges[0].firedAt).toBeUndefined();
    expect(posts(p).some((m) => m.type === "toast" && m.level === "error")).toBe(true);
    h.openWorkspace.mockClear();
    await send({ type: "deck:refresh" });
    expect(h.openWorkspace).not.toHaveBeenCalled();
  });

  it("asks before a flow's first seed, naming the place and the prompt mode — not a ticket", async () => {
    // Step 1's own test: a `seed` starts a paid session exactly like a `launch`
    // does, so the once-per-flow confirmation must see it too, or a flow whose
    // only acting rule is a `seed` would spend money with no consent at all.
    const { send } = await warmed([seedFlow({ launchConfirmedAt: undefined })]);
    await send({ type: "deck:refresh" });
    const call = (window.showWarningMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect(call[0]).toContain("bite-me");
    expect(call[0]).toContain("Implementation"); // the configured mode's label
    expect(call[0]).not.toMatch(/\blaunch\b/i); // no ticket to launch — say so
    expect(call[1]).toMatchObject({ modal: true });
    expect(call.slice(2)).toEqual(["Seed", "Disarm"]);
    // The asking pass performs NOTHING — whatever the answer, THIS pass never
    // calls openWorkspace or stamps the edge (see "stamps launchConfirmedAt on
    // Seed" below for what the confirmed answer itself does).
    expect(h.openWorkspace).not.toHaveBeenCalled();
    expect(lastWrite().edges[0].firedAt).toBeUndefined();
  });

  it("includes the seed edge's note in the spend confirmation when one is set", async () => {
    const note = "There's already a review comment thread; read it first.";
    const { send } = await warmed([seedFlow({
      launchConfirmedAt: undefined,
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "seed", mode: "implementation", note }],
    })]);
    await send({ type: "deck:refresh" });
    const call = (window.showWarningMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect(call[0]).toContain(note);
  });

  it("reads exactly as it did before notes existed when the seed edge has none", async () => {
    const { send } = await warmed([seedFlow({ launchConfirmedAt: undefined })]);
    await send({ type: "deck:refresh" });
    const call = (window.showWarningMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect(call[0]).toBe(
      'Ship the migration is ready to start another session in bite-me with the "Implementation" prompt, unattended. It will keep seeding and launching on its own from now on. It will still ask before it runs a shell command.',
    );
  });

  it("treats a whitespace-only note as no note at all in the seed spend confirmation", async () => {
    const { send } = await warmed([seedFlow({
      launchConfirmedAt: undefined,
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "seed", mode: "implementation", note: "\n\t " }],
    })]);
    await send({ type: "deck:refresh" });
    const call = (window.showWarningMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect(call[0]).toBe(
      'Ship the migration is ready to start another session in bite-me with the "Implementation" prompt, unattended. It will keep seeding and launching on its own from now on. It will still ask before it runs a shell command.',
    );
  });

  it("writes nothing and seeds nothing when the question is dismissed", async () => {
    // Escape, or the modal being closed. Neither approval nor disarm: the flow
    // stays armed and is asked again on a later pass.
    (window.showWarningMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const { send } = await warmed([seedFlow({ launchConfirmedAt: undefined })]);
    await send({ type: "deck:refresh" });
    expect(h.writeFlow).not.toHaveBeenCalled();
    expect(h.openWorkspace).not.toHaveBeenCalled();
  });

  it("stamps launchConfirmedAt on Seed and lets the NEXT pass act", async () => {
    const { send } = await warmed([seedFlow({ launchConfirmedAt: undefined })]);
    await send({ type: "deck:refresh" });
    expect(lastWrite().launchConfirmedAt).toBeTypeOf("number");
    expect(h.openWorkspace).not.toHaveBeenCalled();
    h.flows = [lastWrite()];
    await send({ type: "deck:refresh" });
    expect(h.openWorkspace).toHaveBeenCalledTimes(1);
    expect(window.showWarningMessage).toHaveBeenCalledTimes(1); // asked once per flow
  });

  it("disarms on Disarm, and never seeds on any later pass", async () => {
    (window.showWarningMessage as ReturnType<typeof vi.fn>).mockImplementation(
      async (_m: string, _o: unknown, ...items: string[]) => items[1], // "Disarm"
    );
    const { send } = await warmed([seedFlow({ launchConfirmedAt: undefined })]);
    await send({ type: "deck:refresh" });
    expect(lastWrite().armed).toBe(false);
    expect(h.openWorkspace).not.toHaveBeenCalled();
    h.flows = [lastWrite()];
    await send({ type: "deck:refresh" });
    expect(h.openWorkspace).not.toHaveBeenCalled();
  });

  it("does NOT gate on a seed edge whose target is not a place — nothing would be spent", async () => {
    // The same reasoning the "never launches a rule whose target is not planned
    // work" case rests on: gating on a rule that can never spend anything would
    // ask about something that will never happen.
    //
    // Split from the refusal case above, which owns the `error` stamp — this one
    // owns the gate, on the same fixture but with NO approval on file. Kept on a
    // `seed` verb rather than the notify the old static fixture now derives,
    // because "a rule that cannot resolve what it would spend on must not ask" is
    // only a claim about a SPENDING verb.
    const { send } = await warmed([seedFlowTargeting("place", { launchConfirmedAt: undefined })]);
    let reads = 0;
    h.readFlows.mockImplementation(() => (++reads === 1
      ? [seedFlowTargeting("place", { launchConfirmedAt: undefined })]
      : [seedFlowTargeting("notify", { launchConfirmedAt: undefined })]));
    await send({ type: "deck:refresh" });
    expect(reads).toBeGreaterThan(1);
    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(h.openWorkspace).not.toHaveBeenCalled();
    // And no approval was recorded for a flow that was never asked.
    expect(lastWrite().launchConfirmedAt).toBeUndefined();
  });
});

describe("shellCommandRunner", () => {
  const optsOf = () => h.exec.mock.calls.at(-1)![1] as {
    cwd: string; timeout: number; killSignal: string; maxBuffer: number; encoding: string;
  };

  it("hands exec the cwd and a REAL timeout, with a signal a trapping script cannot ignore", async () => {
    await shellCommandRunner("deploy.sh", { cwd: "/r/aws-ops", timeoutMs: 90_000 });
    expect(h.exec.mock.calls.at(-1)![0]).toBe("deploy.sh");
    const opts = optsOf();
    expect(opts.cwd).toBe("/r/aws-ops");
    // The contract command.ts cannot enforce: exec's own `timeout` option is what
    // actually kills the child. Passing the value straight through is the whole
    // mechanism — a runner that dropped it would hang forever holding the flows
    // lock, which is the failure this assertion exists to make impossible.
    expect(opts.timeout).toBe(90_000);
    // SIGTERM (exec's default) is trappable, and a deploy script that traps it
    // would outlive its own deadline while the runner reported it killed.
    expect(opts.killSignal).toBe("SIGKILL");
    // Bounded capture: a chatty deploy must not grow the host's heap without limit.
    expect(opts.maxBuffer).toBeGreaterThan(0);
  });

  it("resolves code 0 with both streams when the command succeeds", async () => {
    h.exec.mockImplementation((_c: string, _o: unknown, cb: ExecCallback) => cb(null, "out", "err"));
    expect(await shellCommandRunner("ok.sh", { cwd: "/r/a", timeoutMs: 1 })).toEqual({
      code: 0, stdout: "out", stderr: "err",
    });
  });

  it("passes a command's OWN exit code through untouched", async () => {
    h.exec.mockImplementation((_c: string, _o: unknown, cb: ExecCallback) =>
      cb(Object.assign(new Error("Command failed"), { code: 2 }), "partial", "boom"));
    // 2, not a generic 1: `runCommand`'s message quotes this number back to the
    // user, and "exited with code 2" is a fact about their script.
    expect(await shellCommandRunner("nope.sh", { cwd: "/r/a", timeoutMs: 1 })).toEqual({
      code: 2, stdout: "partial", stderr: "boom",
    });
  });

  it("reports a killed command as a kill, naming the signal and the deadline it missed", async () => {
    // What a timeout looks like coming back out of exec: no numeric code, `killed`
    // set, and the signal the runner asked for. Reported as 124 (timeout(1)'s
    // convention) with the reason written into stderr, because a bare 124 would
    // read as the command's own choice of exit code.
    h.exec.mockImplementation((_c: string, _o: unknown, cb: ExecCallback) =>
      cb(Object.assign(new Error("Command failed"), { killed: true, signal: "SIGKILL" }), "started…", ""));
    const res = await shellCommandRunner("hangs.sh", { cwd: "/r/a", timeoutMs: 120_000 });
    expect(res.code).toBe(124);
    expect(res.stdout).toBe("started…");
    expect(res.stderr).toContain("SIGKILL");
    expect(res.stderr).toContain("120000 ms");
  });

  it("keeps a partial line off the runner's own explanation", async () => {
    h.exec.mockImplementation((_c: string, _o: unknown, cb: ExecCallback) =>
      cb(Object.assign(new Error("Command failed"), { killed: true, signal: "SIGKILL" }), "", "deploying"));
    const res = await shellCommandRunner("hangs.sh", { cwd: "/r/a", timeoutMs: 5 });
    // Not "deployingkilled by…": the command's last unterminated line and the
    // runner's reason are two different statements.
    expect(res.stderr.split("\n")).toEqual(["deploying", expect.stringContaining("SIGKILL")]);
  });

  it("explains a failure that never produced an exit code at all", async () => {
    // A shell that could not start, or output past maxBuffer: Node's own string
    // code. The message is the only evidence there is, so it must reach stderr.
    h.exec.mockImplementation((_c: string, _o: unknown, cb: ExecCallback) =>
      cb(Object.assign(new Error("spawn /bin/sh ENOENT"), { code: "ENOENT" }), "", ""));
    const res = await shellCommandRunner("deploy.sh", { cwd: "/r/a", timeoutMs: 1 });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("ENOENT");
  });

  it("never rejects, whatever exec reports", async () => {
    // The caller is a poll loop inside the Deck's refresh: a rejection here would
    // escape `runCommand`'s "never throws" contract and take the whole pass down.
    h.exec.mockImplementation((_c: string, _o: unknown, cb: ExecCallback) => cb(new Error("weird"), "", ""));
    await expect(shellCommandRunner("x.sh", { cwd: "/r/a", timeoutMs: 1 })).resolves.toMatchObject({ code: 1 });
  });
});

describe("a met run rule acts", () => {
  /** `log` is injectable because this suite's whole diagnosability claim is about
   * it: a command's stdout/stderr reaches the Deck's output channel and nowhere
   * else, and a failed unattended deploy is undiagnosable without it. */
  const openPanel = async (log: (m: string) => void = () => {}) => {
    DeckPanel.show(fakeContext().context as any, fakeConnector(), log);
    await settled();
    const p = lastPanel();
    return { p, send: async (m: unknown) => { await p._fire(m); await settled(); } };
  };

  /** One run, two repos: `aws-ops` is the watched place whose PR merging is the
   * rule's condition, `bite-me` is a second checkout of the SAME run that a command
   * node can name with `cwdRepo`. Both paths are `/r/…` — deliberately different
   * from `h.repos`'s `/repos/…` (what `discoverRepos` reports), which is what makes
   * "resolved against the run's own worktrees, not the main checkouts" assertable.
   *
   * `ciGreen` is steerable so the warm-up pass can leave `ci-passed` unmet as well
   * as `pr-merged` — a rule that fires during warm-up is held by the resume gate
   * instead of clearing it, which would silently make every case below about the
   * gate rather than about running a command. */
  const runStatus = (prState: "OPEN" | "MERGED", ciGreen = true): RunStatus => ({
    run: {
      key: "PROJ-1", summary: "ship the migration", url: "https://jira/PROJ-1", createdAt: 1, mode: "multiroot",
      repos: [
        { name: "aws-ops", path: "/r/aws-ops", isGit: true },
        { name: "bite-me", path: "/r/bite-me", isGit: true },
      ],
      briefPaths: [],
    },
    column: "progress", ticketStatus: "In Progress", ticketCategory: "indeterminate",
    shelf: "board",
    repos: [{ name: "aws-ops", path: "/r/aws-ops", branch: "b", dirty: false, ahead: 0, added: 0, removed: 0, files: 0 }],
    agent: { state: "working", lastActivityMs: 1, slug: null },
    windowOpen: true,
    prs: {
      "aws-ops": {
        facts: {
          number: 1, url: "u", title: "t", state: prState, isDraft: false,
          ci: ciGreen ? { passing: 2, pending: 0, failing: [] } : { passing: 0, pending: 0, failing: [{ name: "build", url: "" }] },
          review: "none", unresolved: null, mergeable: "clean", ciAdvisory: false,
        },
        fetchedAt: 1,
      },
    },
    agents: [],
  });

  /** A place watching `aws-ops`, wired to a command node that deploys. Free-text
   * `run` by default — the shape needing no configuration at all.
   * `launchConfirmedAt` is SET by default, exactly as `launchFlow`/`seedFlow` do:
   * most cases here are about what an already-approved flow does, and the consent
   * gate has its own cases below. */
  const cmdFlow = (over: Partial<Flow> = {}): Flow => ({
    ...mkFlow("f1", "Ship the migration"),
    armed: true,
    // BOTH gates confirmed by default. `commandConfirmedAt` is the one that
    // authorises a command (see `Flow.commandConfirmedAt`) — `launchConfirmedAt` is
    // set too so that no case here passes merely because the flow had never been
    // asked anything, and so a fixture reads like a flow in ordinary use.
    launchConfirmedAt: 500,
    commandConfirmedAt: 500,
    nodes: [
      { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
      { id: "n2", kind: "command", x: 0, y: 0, join: "any", run: "deploy.sh staging" },
    ],
    edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "run" }],
    ...over,
  });

  /** `cmdFlow` with its command node's own fields replaced — the node is what
   * decides both the text that runs and the directory it runs in, so most cases
   * here vary only it. */
  const withCommandNode = (node: Partial<CommandNode>, over: Partial<Flow> = {}): Flow => cmdFlow({
    nodes: [
      { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
      { id: "n2", kind: "command", x: 0, y: 0, join: "any", ...node },
    ],
    ...over,
  });

  /** Open with the conditions UNMET so the resume gate clears itself, then arm the
   * met ones — the same two-pass idiom every firing test in this file uses. */
  const warmed = async (flows: Flow[], log?: (m: string) => void) => {
    setConfig({ orchestrator: true });
    h.flows = flows;
    h.buildRunStatus.mockReturnValue(runStatus("OPEN", false));
    const opened = await openPanel(log);
    await settle();
    h.buildRunStatus.mockReturnValue(runStatus("MERGED"));
    h.writeFlow.mockClear();
    h.exec.mockClear();
    return opened;
  };

  const lastWrite = () => h.writeFlow.mock.calls.at(-1)![2] as Flow;
  const ran = () => h.exec.mock.calls.at(-1)! as [string, { cwd: string; timeout: number; killSignal: string }, unknown];
  /** Fail the next command with a real exit code, the ordinary "the deploy broke"
   * shape: partial stdout, a message on stderr, and a non-zero code. */
  const failsWith = (code: number, stderr = "boom") =>
    h.exec.mockImplementation((_c: string, _o: unknown, cb: ExecCallback) =>
      cb(Object.assign(new Error("Command failed"), { code }), "", stderr));

  it("runs the node's command in the source place's checkout, stamps the edge, and promotes nothing", async () => {
    const { p, send } = await warmed([cmdFlow()]);
    await send({ type: "deck:refresh" });
    expect(h.exec).toHaveBeenCalledTimes(1);
    const [command, opts] = ran();
    // The two facts that decide what actually happened on the user's machine.
    expect(command).toBe("deploy.sh staging");
    expect(opts.cwd).toBe("/r/aws-ops");
    // Threaded from command.ts's own constant, through runCommand, into exec.
    expect(opts.timeout).toBe(COMMAND_TIMEOUT_MS);
    expect(h.openWorkspace).not.toHaveBeenCalled();
    expect(h.launchPlanned).not.toHaveBeenCalled();

    const w = lastWrite();
    expect(w.edges[0].firedAt).toBeTypeOf("number");
    expect(w.edges[0].error).toBeUndefined();
    expect(w.edges[0].firedNote).toBe("ran deploy.sh staging in aws-ops");
    // A command node is not a place: nothing was promoted, and the node is
    // byte-identical to what it was before this pass.
    expect(w.nodes.find((n) => n.id === "n2")).toEqual({
      id: "n2", kind: "command", x: 0, y: 0, join: "any", run: "deploy.sh staging",
    });
    expect(posts(p).some((m) => m.type === "toast" && m.level === "success" && /deploy\.sh staging/.test(m.message ?? ""))).toBe(true);
    expect(window.showErrorMessage).not.toHaveBeenCalled();
  });

  it("journals a run rule's command output, which the flow file has never carried", async () => {
    const { send } = await warmed([cmdFlow()]);
    h.exec.mockImplementation((_c: string, _o: unknown, cb: ExecCallback) => cb(null, "deploying to staging", ""));
    await send({ type: "deck:refresh" });
    // The edge itself carries only the one-sentence receipt — the output reached
    // the output channel and nowhere else before the journal existed.
    expect(lastWrite().edges[0].firedNote).not.toContain("deploying to staging");
    const fired = journal().filter((e) => e.kind === "fired");
    expect(fired).toHaveLength(1);
    expect(fired[0].output).toEqual(expect.stringContaining("deploying to staging"));
  });

  it("journals a FAILED command's output — the whole reason this record exists", async () => {
    // The headline case: a 2am deploy that failed, Reset the next morning, and the
    // only evidence of what went wrong was a line in an output channel nobody kept.
    // The edge's own stamp carries a one-sentence receipt and nothing else.
    failsWith(2, 'psql: FATAL: role "deployer" does not exist');
    const { send } = await warmed([cmdFlow()]);
    await send({ type: "deck:refresh" });
    expect(lastWrite().edges[0].error).not.toContain("deployer");
    const errored = journal().filter((e) => e.kind === "errored");
    expect(errored).toHaveLength(1);
    expect(errored[0].output).toEqual(expect.stringContaining('role "deployer" does not exist'));
  });

  it("elides the middle of an enormous command output rather than journalling all of it", async () => {
    // Over the head+tail budget, so `truncateOutput` actually has something to do —
    // an ordinary deploy's output is far under it, which is why every other case
    // here passes with the call removed.
    const huge = "x".repeat(OUTPUT_HEAD_BYTES + OUTPUT_TAIL_BYTES + 5_000);
    const { send } = await warmed([cmdFlow()]);
    h.exec.mockImplementation((_c: string, _o: unknown, cb: ExecCallback) => cb(null, huge, ""));
    await send({ type: "deck:refresh" });
    const fired = journal().filter((e) => e.kind === "fired");
    expect(fired).toHaveLength(1);
    const output = fired[0].output as string;
    expect(output).toContain("bytes elided");
    expect(output.length).toBeLessThan(huge.length);
  });

  it("stamps a rule pointing at an unknown node kind with what is wrong, not with 'undefined'", async () => {
    // End to end for the arm `applyFired` now owns: `validNode` admits an unknown
    // kind on purpose (a newer build's flow must still render), nothing derives a
    // verb for it, the dispatch performs nothing — and the stamp used to read
    // "undefined was not performed", while the sentence written for this case sat
    // unreachable in `performEdge`.
    const { send } = await warmed([cmdFlow({
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
        { id: "n2", kind: "webhook", x: 0, y: 0, join: "any" } as unknown as FlowNode,
      ],
    })]);
    await send({ type: "deck:refresh" });
    expect(h.exec).not.toHaveBeenCalled();
    const e = lastWrite().edges[0];
    expect(e.error).toBe("this rule points at n2, which is not a place, planned work, a notification, or a command.");
    expect(e.error).not.toContain("undefined");
    expect(e.firedAt).toBeUndefined();
  });

  it("runs a CONFIGURED command's text, never its label", async () => {
    h.commands = [{ id: "deploy", label: "Deploy staging", run: "make deploy ENV=staging" }];
    const { send } = await warmed([withCommandNode({ commandId: "deploy" })]);
    await send({ type: "deck:refresh" });
    expect(ran()[0]).toBe("make deploy ENV=staging");
    // The receipt names the label, which is the whole point of configuring one.
    expect(lastWrite().edges[0].firedNote).toBe("ran Deploy staging in aws-ops");
  });

  it("splices the rule's note into the command at {note}", async () => {
    const { send } = await warmed([cmdFlow({
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
        { id: "n2", kind: "command", x: 0, y: 0, join: "any", run: "deploy.sh --env={note}" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "run", note: "staging" }],
    })]);
    await send({ type: "deck:refresh" });
    // The resolved text, not the template: dropping the note at this call site
    // would run `deploy.sh --env={note}` verbatim.
    expect(ran()[0]).toBe("deploy.sh --env=staging");
    // And the RECEIPT says what ran, not what was configured. With the template
    // here instead, a staging deploy and a prod deploy leave byte-identical
    // receipts and only the output channel knows which happened.
    expect(lastWrite().edges[0].firedNote).toBe("ran deploy.sh --env=staging in aws-ops");
  });

  it("runs in the repo the node names, resolved against that run's own worktree", async () => {
    const { send } = await warmed([withCommandNode({ run: "smoke.sh", cwdRepo: "bite-me" })]);
    await send({ type: "deck:refresh" });
    expect(ran()[1].cwd).toBe("/r/bite-me");
    expect(lastWrite().edges[0].firedNote).toBe("ran smoke.sh in bite-me");
  });

  it("prefers the run's worktree over the main checkout of the same name", async () => {
    // `discoverRepos` reports `/repos/aws-ops` — the user's own checkout — while the
    // run's copy is `/r/aws-ops`, this task's worktree. Resolving the name against
    // the machine first would deploy from the wrong tree with the right name.
    h.repos = [{ name: "aws-ops", path: "/repos/aws-ops", isGit: true }];
    const { send } = await warmed([withCommandNode({ run: "deploy.sh", cwdRepo: "aws-ops" })]);
    await send({ type: "deck:refresh" });
    expect(ran()[1].cwd).toBe("/r/aws-ops");
  });

  it("falls back to the machine's checkouts for a repo outside the run", async () => {
    h.repos = [{ name: "infra", path: "/repos/infra", isGit: true }];
    const { send } = await warmed([withCommandNode({ run: "terraform apply", cwdRepo: "infra" })]);
    await send({ type: "deck:refresh" });
    expect(ran()[1].cwd).toBe("/repos/infra");
    expect(h.discoverRepos).toHaveBeenCalledWith("/repos", ["vendored"]);
  });

  it("refuses a named repo that is checked out nowhere, rather than running somewhere else", async () => {
    h.repos = [{ name: "aws-ops", path: "/repos/aws-ops", isGit: true }];
    const { send } = await warmed([withCommandNode({ run: "deploy.sh", cwdRepo: "ghost" })]);
    await send({ type: "deck:refresh" });
    // Nothing ran at all — not in aws-ops, not in the place's own checkout.
    expect(h.exec).not.toHaveBeenCalled();
    const w = lastWrite();
    expect(w.edges[0].error).toContain("ghost");
    expect(w.edges[0].firedAt).toBeUndefined();
    // Deterministic, so it does not retry on the next pass either.
    await send({ type: "deck:refresh" });
    expect(h.exec).not.toHaveBeenCalled();
  });

  it("treats a blank cwdRepo as absent and inherits the place's checkout", async () => {
    // A hand-edited flow file can carry `"cwdRepo": ""`. Refusing it would strand a
    // rule whose author plainly meant "wherever the rule came from" — and
    // `readCommands`/`resolveCommand` both already treat blank text as absent.
    const { send } = await warmed([withCommandNode({ run: "deploy.sh", cwdRepo: "   " })]);
    await send({ type: "deck:refresh" });
    expect(ran()[1].cwd).toBe("/r/aws-ops");
  });

  describe("neverAutoRun", () => {
    // `agentFlow.neverAutoRun` outranks `commandConfirmedAt`. Every fixture here is
    // a FULLY CONSENTED flow (`cmdFlow` stamps both gates), which is the whole
    // point: these cases would all run without the setting.
    it("refuses a command matching neverAutoRun even though the flow is confirmed", async () => {
      setConfig({ orchestrator: true, neverAutoRun: ["*rm -rf*"] });
      const { p, send } = await warmed([withCommandNode({ run: "deploy.sh && rm -rf /tmp/x" })]);
      await send({ type: "deck:refresh" });
      expect(h.exec).not.toHaveBeenCalled();
      const w = lastWrite();
      // The same latch a failed command gets: an `error`, no `firedAt`. A refused
      // rule that kept re-deciding every six seconds would ask the same question
      // forever, and one stamped as fired would show in the drawer as a deploy
      // that happened.
      expect(w.edges[0].error).toContain("neverAutoRun");
      expect(w.edges[0].firedAt).toBeUndefined();
      expect(posts(p).some((m) => m.type === "toast" && m.level === "error")).toBe(true);
    });

    it("names the blocking pattern on the edge, so the user knows which line to edit", async () => {
      setConfig({ orchestrator: true, neverAutoRun: ["*nope*", "*rm -rf*"] });
      const { send } = await warmed([withCommandNode({ run: "rm -rf /tmp/x" })]);
      await send({ type: "deck:refresh" });
      expect(lastWrite().edges[0].error).toContain("*rm -rf*");
    });

    it("never retries a refused command", async () => {
      setConfig({ orchestrator: true, neverAutoRun: ["*rm -rf*"] });
      const { send } = await warmed([withCommandNode({ run: "rm -rf /tmp/x" })]);
      await send({ type: "deck:refresh" });
      await send({ type: "deck:refresh" });
      await send({ type: "deck:refresh" });
      expect(h.exec).not.toHaveBeenCalled();
    });

    // The reason this setting exists at all. The TEMPLATE is harmless; the note a
    // rule carries is spliced in unquoted (see `withNote`), and a per-flow approval
    // given months ago cannot have known what that note would say.
    it("blocks on the note-spliced text, not the template", async () => {
      setConfig({ orchestrator: true, neverAutoRun: ["*rm -rf*"] });
      const flow = withCommandNode({ run: "deploy.sh --env={note}" });
      flow.edges[0].note = "prod; rm -rf ~";
      const { send } = await warmed([flow]);
      await send({ type: "deck:refresh" });
      expect(h.exec).not.toHaveBeenCalled();
      expect(lastWrite().edges[0].error).toContain("neverAutoRun");
    });

    it("still runs a command no pattern matches", async () => {
      setConfig({ orchestrator: true, neverAutoRun: ["*rm -rf*"] });
      const { send } = await warmed([cmdFlow()]);
      await send({ type: "deck:refresh" });
      expect(h.exec).toHaveBeenCalledTimes(1);
      expect(ran()[0]).toBe("deploy.sh staging");
    });

    // A blocked command must never reach the consent modal. Asking someone to
    // approve a thing that cannot happen either teaches them the approval is
    // meaningless or — worse — reads as "approve this and it will run".
    it("never asks for consent about a command it will refuse", async () => {
      setConfig({ orchestrator: true, neverAutoRun: ["*rm -rf*"] });
      const { send } = await warmed([
        withCommandNode({ run: "rm -rf /tmp/x" }, { commandConfirmedAt: undefined }),
      ]);
      await send({ type: "deck:refresh" });
      expect(window.showWarningMessage).not.toHaveBeenCalled();
      expect(lastWrite().commandConfirmedAt).toBeUndefined();
      expect(h.exec).not.toHaveBeenCalled();
    });
  });

  it("latches a failed command and never retries it", async () => {
    failsWith(2);
    const { p, send } = await warmed([cmdFlow()]);
    await send({ type: "deck:refresh" });
    expect(h.exec).toHaveBeenCalledTimes(1);
    const w = lastWrite();
    // An `error` and NO `firedAt`: the second would consume the latch as a success,
    // and the drawer would show a broken deploy as done.
    expect(w.edges[0].error).toContain("exited with code 2");
    expect(w.edges[0].firedAt).toBeUndefined();
    // A failed unattended command must escape an unfocused panel, exactly as a
    // failed launch does.
    expect(window.showErrorMessage).toHaveBeenCalledTimes(1);
    expect((window.showErrorMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]).toContain("exited with code 2");
    expect(posts(p).some((m) => m.type === "toast" && m.level === "error")).toBe(true);
    // The second pass: a broken deploy that re-ran every six seconds would be a
    // real side effect on real infrastructure, over and over.
    await send({ type: "deck:refresh" });
    await send({ type: "deck:refresh" });
    expect(h.exec).toHaveBeenCalledTimes(1);
  });

  it("latches a command killed at the timeout, naming the deadline it missed", async () => {
    h.exec.mockImplementation((_c: string, _o: unknown, cb: ExecCallback) =>
      cb(Object.assign(new Error("Command failed"), { killed: true, signal: "SIGKILL" }), "", ""));
    const { send } = await warmed([cmdFlow()]);
    await send({ type: "deck:refresh" });
    const w = lastWrite();
    expect(w.edges[0].error).toContain("exited with code 124");
    // The deadline reaches the EDGE, not only stderr and the channel: a user
    // looking at a stalled rule in the drawer sees this sentence and nothing else,
    // and a bare "code 124" tells them nothing about a limit they never chose.
    expect(w.edges[0].error).toContain(String(COMMAND_TIMEOUT_MS));
    expect(w.edges[0].error).toContain("killed");
    expect(w.edges[0].firedAt).toBeUndefined();
  });

  it("refuses a command node it cannot resolve, and runs nothing", async () => {
    // Both a configured id and free text: picking either would make the drawer's
    // display and what executes disagree, which is the failure this whole feature
    // exists to remove.
    const { send } = await warmed([withCommandNode({ commandId: "deploy", run: "rm -rf /" })]);
    await send({ type: "deck:refresh" });
    expect(h.exec).not.toHaveBeenCalled();
    const w = lastWrite();
    expect(w.edges[0].error).toContain("refusing rather than guessing");
    expect(w.edges[0].firedAt).toBeUndefined();
  });

  it("writes the command's output to the Deck output channel", async () => {
    const lines: string[] = [];
    h.exec.mockImplementation((_c: string, _o: unknown, cb: ExecCallback) =>
      cb(null, "deployed 3 services", "warning: slow"));
    const { send } = await warmed([cmdFlow()], (m) => lines.push(m));
    await send({ type: "deck:refresh" });
    // Both streams, and the command itself: the channel is the ONLY place a
    // failed unattended deploy can be diagnosed from.
    expect(lines).toContain("running: deploy.sh staging");
    expect(lines).toContain("deployed 3 services\nwarning: slow");
  });

  it("writes a FAILED command's output to the channel too, and points the receipt at it", async () => {
    const lines: string[] = [];
    h.exec.mockImplementation((_c: string, _o: unknown, cb: ExecCallback) =>
      cb(Object.assign(new Error("Command failed"), { code: 1 }), "step 1 ok", "step 2 failed: no such cluster"));
    const { send } = await warmed([cmdFlow()], (m) => lines.push(m));
    await send({ type: "deck:refresh" });
    expect(lines).toContain("step 1 ok\nstep 2 failed: no such cluster");
    const shown = (window.showErrorMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as string;
    expect(shown).toContain("output channel");
  });

  it("does not send the user to an empty channel when nothing ran", async () => {
    const { send } = await warmed([withCommandNode({})]); // neither commandId nor run
    await send({ type: "deck:refresh" });
    expect(h.exec).not.toHaveBeenCalled();
    const shown = (window.showErrorMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as string;
    expect(shown).toContain("names neither");
    expect(shown).not.toContain("output channel");
  });

  it("asks once before a flow runs its first command, and runs nothing that pass", async () => {
    // BLOCKER: `isSpendAction("run")` is true, but until `spendTarget` had a `run`
    // arm the once-per-flow ask could never see a command edge — so the first shell
    // command ran unattended with no prompt ever shown, while package.json's own
    // `agentFlow.commands` copy promised "a flow asks once before it runs its first
    // command". This is that promise, asserted.
    const { send } = await warmed([cmdFlow({ commandConfirmedAt: undefined })]);
    await send({ type: "deck:refresh" });
    expect(h.exec).not.toHaveBeenCalled();
    const call = (window.showWarningMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect(call[1]).toMatchObject({ modal: true });
    expect(call.slice(2)).toEqual(["Run", "Disarm"]);
    // The asking pass performs NOTHING — whatever the answer, this pass never
    // executes and never stamps the edge.
    expect(lastWrite().edges[0].firedAt).toBeUndefined();
    expect(lastWrite().edges[0].error).toBeUndefined();
  });

  it("names the resolved command in the confirmation, not just the flow", async () => {
    const { send } = await warmed([cmdFlow({ commandConfirmedAt: undefined })]);
    await send({ type: "deck:refresh" });
    const message = (window.showWarningMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as string;
    expect(message).toBe(
      'Ship the migration is ready to run "deploy.sh staging" on this machine, unattended. It will keep running commands on its own from now on.',
    );
  });

  it("names a configured command's TEXT in the confirmation, not its label", async () => {
    // Approving "Deploy staging" is not approving `make deploy ENV=staging`: for a
    // shell command the text is not a description of what will happen, it IS what
    // will happen.
    h.commands = [{ id: "deploy", label: "Deploy staging", run: "make deploy ENV=staging" }];
    const { send } = await warmed([withCommandNode({ commandId: "deploy" }, { commandConfirmedAt: undefined })]);
    await send({ type: "deck:refresh" });
    const message = (window.showWarningMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as string;
    expect(message).toContain("make deploy ENV=staging");
  });

  it("shows the command with the rule's note already spliced in", async () => {
    // The consent gate resolves through the SAME resolveCommand the run does, so
    // the modal cannot show one string while another executes.
    const { send } = await warmed([cmdFlow({
      commandConfirmedAt: undefined,
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
        { id: "n2", kind: "command", x: 0, y: 0, join: "any", run: "deploy.sh --env={note}" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "run", note: "prod" }],
    })]);
    await send({ type: "deck:refresh" });
    const message = (window.showWarningMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as string;
    expect(message).toContain('"deploy.sh --env=prod"');
    expect(message).not.toContain("{note}");
  });

  it("keeps a very long command's TAIL visible, where the dangerous part lives", async () => {
    // A shell command is not prose. The operative clause is often at the END, and a
    // note is spliced in unquoted — so head-only truncation is exactly how
    // `; rm -rf ~` ends up hidden behind an "…" in the one dialog that was supposed
    // to show the user what will run.
    const long = `deploy.sh ${"--flag ".repeat(120)}; rm -rf ~`;
    const { send } = await warmed([withCommandNode({ run: long }, { commandConfirmedAt: undefined })]);
    await send({ type: "deck:refresh" });
    const message = (window.showWarningMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as string;
    expect(long.length).toBeGreaterThan(600); // long enough that it really is elided
    expect(message).toContain("…");
    expect(message).not.toContain(long);
    // Both ends survive: what it starts with, and what it ends with.
    expect(message).toContain("deploy.sh --flag");
    expect(message).toContain("; rm -rf ~");
    // And a command far longer than a note's cap is NOT cut at 160 characters.
    expect(message).toContain(long.slice(0, 300));
  });

  it("shows a moderately long command in full, where a note would already be cut", async () => {
    // 300 characters is a perfectly ordinary one-liner and is nearly twice
    // `NOTE_PREVIEW_MAX`. Eliding it would hide real arguments for no reason.
    const cmd = `deploy.sh ${"--flag ".repeat(40)}--last`;
    const { send } = await warmed([withCommandNode({ run: cmd }, { commandConfirmedAt: undefined })]);
    await send({ type: "deck:refresh" });
    const message = (window.showWarningMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as string;
    expect(cmd.length).toBeGreaterThan(160);
    expect(message).toContain(cmd);
    expect(message).not.toContain("…");
  });

  it("stamps commandConfirmedAt on Run and lets the NEXT pass execute", async () => {
    const { send } = await warmed([cmdFlow({ commandConfirmedAt: undefined })]);
    await send({ type: "deck:refresh" });
    expect(lastWrite().commandConfirmedAt).toBeTypeOf("number");
    expect(h.exec).not.toHaveBeenCalled();
    h.flows = [lastWrite()];
    await send({ type: "deck:refresh" });
    expect(h.exec).toHaveBeenCalledTimes(1);
    expect(window.showWarningMessage).toHaveBeenCalledTimes(1); // asked once per flow
  });

  it("runs nothing at all on Disarm", async () => {
    (window.showWarningMessage as ReturnType<typeof vi.fn>).mockImplementation(
      async (_m: string, _o: unknown, ...items: string[]) => items[1], // "Disarm"
    );
    const { send } = await warmed([cmdFlow({ commandConfirmedAt: undefined })]);
    await send({ type: "deck:refresh" });
    expect(lastWrite().armed).toBe(false);
    expect(h.exec).not.toHaveBeenCalled();
    h.flows = [lastWrite()];
    await send({ type: "deck:refresh" });
    expect(h.exec).not.toHaveBeenCalled();
  });

  it("asks before the first command even when the flow was already confirmed for a launch", async () => {
    // The case a single shared gate gets wrong, and it is not hypothetical: EVERY
    // flow an existing user armed and confirmed before commands shipped carries
    // `launchConfirmedAt` and nothing else. Consent to open an agent session is not
    // consent to execute shell, and the modal those users saw closed with "It will
    // keep launching on its own" — which says nothing about a shell at all.
    const { send } = await warmed([cmdFlow({ launchConfirmedAt: 500, commandConfirmedAt: undefined })]);
    await send({ type: "deck:refresh" });
    expect(h.exec).not.toHaveBeenCalled();
    const call = (window.showWarningMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect(call[0]).toContain("deploy.sh staging");
    expect(call.slice(2)).toEqual(["Run", "Disarm"]);
  });

  it("runs a command with no fresh prompt once THAT gate is confirmed", async () => {
    // The other half: the command gate is still once per flow, not once per rule.
    const { send } = await warmed([cmdFlow()]); // both gates confirmed
    await send({ type: "deck:refresh" });
    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(h.exec).toHaveBeenCalledTimes(1);
  });

  it("records the command approval on its OWN field, never on the launch gate", async () => {
    const { send } = await warmed([cmdFlow({ launchConfirmedAt: undefined, commandConfirmedAt: undefined })]);
    await send({ type: "deck:refresh" });
    const w = lastWrite();
    expect(w.commandConfirmedAt).toBeTypeOf("number");
    // Approving a command must not silently authorise agent sessions the user was
    // never asked about.
    expect(w.launchConfirmedAt).toBeUndefined();
  });

  it("still asks before a LAUNCH in a flow that has only ever confirmed commands", async () => {
    // The mirror, so the separation cannot be half-implemented: a flow confirmed
    // for shell must not thereby be allowed to open a paid session.
    const { send } = await warmed([cmdFlow({
      launchConfirmedAt: undefined,
      commandConfirmedAt: 500,
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
        {
          id: "n2", kind: "planned", x: 0, y: 0, join: "any",
          ticketKey: "PROJ-12", repos: ["aws-ops"], mode: "implementation", dest: "worktree",
        },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "launch" }],
    })]);
    await send({ type: "deck:refresh" });
    expect(h.launchPlanned).not.toHaveBeenCalled();
    const call = (window.showWarningMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect(call.slice(2)).toEqual(["Launch", "Disarm"]);
  });

  it("tells the user, in the launch modal, that a shell command will be asked about separately", async () => {
    const { send } = await warmed([cmdFlow({
      launchConfirmedAt: undefined,
      commandConfirmedAt: undefined,
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
        {
          id: "n2", kind: "planned", x: 0, y: 0, join: "any",
          ticketKey: "PROJ-12", repos: ["aws-ops"], mode: "implementation", dest: "worktree",
        },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "launch" }],
    })]);
    await send({ type: "deck:refresh" });
    const message = (window.showWarningMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as string;
    expect(message).toContain("still ask before it runs a shell command");
  });

  it("does not promise a further question once the command gate is already confirmed", async () => {
    // The clause has to be true when it is shown: a flow that has already approved
    // commands will NOT be asked again, and saying otherwise is a false statement in
    // a consent dialog.
    const { send } = await warmed([cmdFlow({
      launchConfirmedAt: undefined,
      commandConfirmedAt: 500,
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
        {
          id: "n2", kind: "planned", x: 0, y: 0, join: "any",
          ticketKey: "PROJ-12", repos: ["aws-ops"], mode: "implementation", dest: "worktree",
        },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "launch" }],
    })]);
    await send({ type: "deck:refresh" });
    const message = (window.showWarningMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as string;
    expect(message).not.toContain("still ask");
  });

  it("tells the user, in the command modal, that an agent session will be asked about separately", async () => {
    const { send } = await warmed([cmdFlow({ launchConfirmedAt: undefined, commandConfirmedAt: undefined })]);
    await send({ type: "deck:refresh" });
    const message = (window.showWarningMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as string;
    expect(message).toContain("still ask before it starts a session");
  });

  it("does NOT gate on a command edge it cannot resolve — nothing would be spent", async () => {
    // The same reasoning the launch and seed gates rest on: asking about a rule
    // that can never run would be asking about something that will never happen.
    // The refusal itself is stamped (see the case above); this owns the gate.
    const { send } = await warmed([withCommandNode({ run: "  " }, { commandConfirmedAt: undefined })]);
    await send({ type: "deck:refresh" });
    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(h.exec).not.toHaveBeenCalled();
    expect(lastWrite().commandConfirmedAt).toBeUndefined();
    expect(lastWrite().edges[0].error).toContain("blank");
  });

  it("runs a command node ONCE when two rules point at it", async () => {
    // Two conditions into one command node is the ordinary way to wire "when it
    // lands, deploy" — `pr-merged` and `ci-passed` are both true the moment a PR
    // merges. Running per edge would deploy twice.
    const { send } = await warmed([cmdFlow({
      edges: [
        { id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "run" },
        { id: "e2", from: "n1", to: "n2", cond: { kind: "ci-passed" }, action: "run" },
      ],
    })]);
    await send({ type: "deck:refresh" });
    expect(h.exec).toHaveBeenCalledTimes(1);
    const w = lastWrite();
    expect(w.edges[0].firedNote).toBe("ran deploy.sh staging in aws-ops");
    // The second edge DID fire, so it is stamped — an unstamped met edge is
    // re-evaluated every pass forever — but it performed nothing and says so.
    expect(w.edges[1].firedAt).toBeTypeOf("number");
    expect(w.edges[1].firedNote).toBe("another edge into this target already acted");
    // And no later pass picks it up as unrun work.
    await send({ type: "deck:refresh" });
    expect(h.exec).toHaveBeenCalledTimes(1);
  });

  it("refuses a run rule whose target is no longer a command", async () => {
    // Reachable exactly one way, the same way its launch and seed mirrors are: the
    // target's KIND changed between the read evaluation derived the verb from and
    // the copy this pass acts against.
    const asCommand = () => cmdFlow();
    const asNotify = () => cmdFlow({
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
        { id: "n2", kind: "notify", x: 0, y: 0, join: "any", message: "not a command" },
      ],
    });
    const { send } = await warmed([asCommand()]);
    let reads = 0;
    h.readFlows.mockImplementation(() => (++reads === 1 ? [asCommand()] : [asNotify()]));
    await send({ type: "deck:refresh" });
    expect(reads).toBeGreaterThan(1);
    expect(h.exec).not.toHaveBeenCalled();
    expect(lastWrite().edges[0].error).toBe("a run rule must point at a command, and n2 is not.");
    expect(lastWrite().edges[0].firedAt).toBeUndefined();
  });

  /** Two command nodes off one place, each with its own rule, so ONE pass has two
   * spending steps — the shape the lock hold is actually about: 120 s each, and the
   * pass stamps nothing until both are done. */
  const twoCommandFlow = (): Flow => cmdFlow({
    nodes: [
      { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
      { id: "n2", kind: "command", x: 0, y: 0, join: "any", run: "deploy.sh staging" },
      { id: "n3", kind: "command", x: 0, y: 0, join: "any", run: "smoke.sh staging" },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "run" },
      { id: "e2", from: "n1", to: "n3", cond: { kind: "ci-passed" }, action: "run" },
    ],
  });

  it("renews the flows lock after each command, with the token it acquired under", async () => {
    const { send } = await warmed([twoCommandFlow()]);
    await send({ type: "deck:refresh" });
    expect(h.exec).toHaveBeenCalledTimes(2);
    // One renewal per performed step: the hold is bounded by the longest single
    // command, not by the whole pass.
    expect(h.renew).toHaveBeenCalledTimes(2);
    // The SAME token — `acquire(io, dir, nowMs, ttl, token)` and
    // `renew(io, dir, token, nowMs)` do not agree on argument order, and renewing
    // under a token nobody holds would silently answer false forever.
    const token = h.acquire.mock.calls.at(-1)![4] as string;
    expect(token).toBeTypeOf("string");
    expect(h.renew.mock.calls[0][2]).toBe(token);
    expect(h.renew.mock.calls[0][1]).toBe(h.acquire.mock.calls.at(-1)![1]); // same dir
  });

  it("stops the pass when the lock was reaped mid-pass, and does not run the next command", async () => {
    // The hazard this closes: past the TTL, window B reaps and starts its own pass.
    // Because THIS pass stamps only at the end, B sees the same edges unfired and
    // would run the same commands again. A pass that has lost the lock must stop.
    h.renew.mockReturnValue(false);
    const { send } = await warmed([twoCommandFlow()]);
    await send({ type: "deck:refresh" });
    expect(h.exec).toHaveBeenCalledTimes(1);
    expect(ran()[0]).toBe("deploy.sh staging");
    const w = lastWrite();
    // What already ran IS stamped: it happened, and an unstamped success is exactly
    // what makes the next pass repeat it.
    expect(w.edges[0].firedAt).toBeTypeOf("number");
    expect(w.edges[0].firedNote).toBe("ran deploy.sh staging in aws-ops");
    // What never ran is left untouched — NOT stamped with "run was not performed",
    // which would latch a rule that never executed.
    expect(w.edges[1].firedAt).toBeUndefined();
    expect(w.edges[1].error).toBeUndefined();
  });

  it("journals a rule skipped because this window lost the flows lock", async () => {
    // The fixture above: two met run rules, and `renew` answers false after the
    // first command.
    //
    // ONE site emits lock-lost — the `if (lostLock)` guard at the top of the
    // acting loop, which covers every rule that never got its turn. The rule that
    // WAS the last step is NOT journalled as skipped: it ran, and its outcome is
    // recorded as `fired`/`errored`.
    h.renew.mockReturnValue(false);
    const { send } = await warmed([twoCommandFlow()]);
    await send({ type: "deck:refresh" });
    const events = journal();
    const skipped = events.filter((e) => e.kind === "skipped");
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.every((e) => e.reason === "lock-lost")).toBe(true);
    // The rule that never got its turn is recorded, which is the point.
    expect(skipped.map((e) => e.edge)).toContain("e2");
    // e1 DID run: it must appear as an outcome and never as a skip. An edge
    // journalled both ways would make the documented "why did nothing fire?"
    // query (`kind == "deferred" or "skipped"`) name a rule that acted.
    const acted = events.filter((e) => e.kind === "fired" || e.kind === "errored").map((e) => e.edge);
    expect(acted).toContain("e1");
    expect(skipped.map((e) => e.edge)).not.toContain("e1");
    for (const edge of acted) expect(skipped.map((e) => e.edge)).not.toContain(edge);
  });

  it("leaves the un-run command for the next pass, once the lock is held again", async () => {
    h.renew.mockReturnValue(false);
    const { send } = await warmed([twoCommandFlow()]);
    await send({ type: "deck:refresh" });
    expect(h.exec).toHaveBeenCalledTimes(1);
    // Next poll: this window acquires cleanly again.
    h.renew.mockReturnValue(true);
    h.flows = [lastWrite()];
    await send({ type: "deck:refresh" });
    expect(h.exec).toHaveBeenCalledTimes(2);
    expect(ran()[0]).toBe("smoke.sh staging");
    expect(lastWrite().edges[1].firedAt).toBeTypeOf("number");
  });

  it("stops before the NEXT flow when the lock was reaped, not just the next rule", async () => {
    // The hold is over the whole pass, so the abort has to be too: a second armed
    // flow must not be advanced under a lock this window no longer owns. The second
    // flow's rule is a NOTIFY on purpose — a command in it proves nothing here,
    // since the per-edge guard already stops that; a notify is the cheapest action
    // there is, and stamping and announcing one is still a write to its file.
    const second: Flow = {
      ...cmdFlow(),
      id: "f2",
      name: "Second flow",
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
        { id: "n2", kind: "notify", x: 0, y: 0, join: "any", message: "the migration has landed" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" }],
    };
    h.renew.mockReturnValue(false);
    const { send } = await warmed([cmdFlow(), second]);
    await send({ type: "deck:refresh" });
    expect(h.exec).toHaveBeenCalledTimes(1);
    expect(ran()[0]).toBe("deploy.sh staging");
    // The second flow was never advanced: nothing stamped, and nothing announced.
    expect(h.writeFlow.mock.calls.some((c) => (c[2] as Flow).id === "f2")).toBe(false);
    expect((window.showInformationMessage as ReturnType<typeof vi.fn>).mock.calls
      .some((c) => /the migration has landed/.test(c[0] as string))).toBe(false);
    // And the next pass, holding the lock again, does announce it.
    h.renew.mockReturnValue(true);
    await send({ type: "deck:refresh" });
    expect((window.showInformationMessage as ReturnType<typeof vi.fn>).mock.calls
      .some((c) => /the migration has landed/.test(c[0] as string))).toBe(true);
  });

  it("does not ask the user for consent from a pass that already lost the lock", async () => {
    // What makes the flow-loop `break` load-bearing, and it is not a stamp — it is a
    // MODAL. A later flow's gate check runs BEFORE the edge loop, so the per-edge
    // guard never sees it: without the break, `unconfirmedSpend` pushes an ask, and
    // once the lock is released the user gets a consent question — and that flow's
    // consent stamp gets written — from a pass that had already abandoned itself.
    const second: Flow = {
      ...cmdFlow(),
      id: "f2",
      name: "Second flow",
      commandConfirmedAt: undefined,
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
        { id: "n2", kind: "command", x: 0, y: 0, join: "any", run: "publish.sh" },
      ],
    };
    h.renew.mockReturnValue(false);
    const { send } = await warmed([cmdFlow(), second]);
    await send({ type: "deck:refresh" });
    expect(h.exec).toHaveBeenCalledTimes(1);
    expect(window.showWarningMessage).not.toHaveBeenCalled();
    // And no consent was recorded for the flow that was never asked about.
    expect(h.writeFlow.mock.calls.some((c) => (c[2] as Flow).id === "f2")).toBe(false);
    // The question is not lost, only deferred: the next pass holds the lock and asks.
    h.renew.mockReturnValue(true);
    await send({ type: "deck:refresh" });
    const call = (window.showWarningMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect(call[0]).toContain("publish.sh");
    expect(call.slice(2)).toEqual(["Run", "Disarm"]);
  });

  it("does not stamp or announce a notify that follows a lost lock in the SAME flow", async () => {
    // The guard sits above the spend filter for this: a notify is free, but its
    // stamp is a write, and writing this file without the lock is the read-then-write
    // race the lock exists to close.
    h.renew.mockReturnValue(false);
    const { send } = await warmed([cmdFlow({
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
        { id: "n2", kind: "command", x: 0, y: 0, join: "any", run: "deploy.sh staging" },
        { id: "n3", kind: "notify", x: 0, y: 0, join: "any", message: "deployed" },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "run" },
        { id: "e2", from: "n1", to: "n3", cond: { kind: "ci-passed" }, action: "notify" },
      ],
    })]);
    await send({ type: "deck:refresh" });
    expect(h.exec).toHaveBeenCalledTimes(1);
    const w = lastWrite();
    expect(w.edges[0].firedAt).toBeTypeOf("number"); // the command that ran
    expect(w.edges[1].firedAt).toBeUndefined(); // the notify that did not
    expect((window.showInformationMessage as ReturnType<typeof vi.fn>).mock.calls
      .some((c) => /deployed/.test(c[0] as string))).toBe(false);
  });

  it("says in the log that the pass stopped because the lock was lost", async () => {
    const lines: string[] = [];
    h.renew.mockReturnValue(false);
    const { send } = await warmed([twoCommandFlow()], (m) => lines.push(m));
    await send({ type: "deck:refresh" });
    // A pass that silently does half its work is invisible without this.
    expect(lines.some((l) => /lock was lost/.test(l) && /f1/.test(l))).toBe(true);
  });

  it("does not run a command when the flow is disarmed mid-pass", async () => {
    // The per-edge `stillArmed` re-read, for the verb that executes shell: a
    // command that goes ahead after Disarm is a real side effect the user just
    // said stop to. Left pending rather than stamped, so a re-arm retries cleanly.
    const lines: string[] = [];
    const { send } = await warmed([twoCommandFlow()], (m) => lines.push(m));
    let reads = 0;
    // Reads 1 and 2 are evaluation's and the `fresh` copy's; from the per-edge
    // check onward the flow is disarmed.
    h.readFlows.mockImplementation(() => (++reads <= 2
      ? [twoCommandFlow()]
      : [{ ...twoCommandFlow(), armed: false }]));
    await send({ type: "deck:refresh" });
    expect(h.exec).not.toHaveBeenCalled();
    expect(lines.some((l) => /disarmed mid-pass/.test(l))).toBe(true);
    expect(h.writeFlow).not.toHaveBeenCalled();
  });

  it("treats a non-string cwdRepo as absent rather than crashing on it", async () => {
    // A hand-edited flow file can carry `"cwdRepo": 42`; `validNode` rejects none
    // of that, and neither `.find()` nor a template string would throw on it — but
    // refusing it outright would strand a rule whose author meant the default.
    const { send } = await warmed([withCommandNode({ run: "deploy.sh", cwdRepo: 42 as unknown as string })]);
    await send({ type: "deck:refresh" });
    expect(ran()[1].cwd).toBe("/r/aws-ops");
    expect(lastWrite().edges[0].firedAt).toBeTypeOf("number");
  });

  it("refuses, rather than guessing a directory, when nothing upstream is a place", async () => {
    // No `cwdRepo` and nothing to inherit from — not even through a chain. Refused,
    // never a guessed checkout: running a deploy in the wrong one is not
    // recoverable. LATCHED rather than deferred, which is the correction: a defer
    // stamps nothing and leaves no `error`, and there is no `BlockedNote` for this
    // kind, so the rule would have retried every six seconds forever, invisibly.
    // A notify source can never become a place on its own, so the next pass would
    // answer identically.
    const fromPlace = () => cmdFlow();
    const fromNotify = () => cmdFlow({
      nodes: [
        { id: "n1", kind: "notify", x: 0, y: 0, join: "any", message: "not a place" },
        { id: "n2", kind: "command", x: 0, y: 0, join: "any", run: "deploy.sh staging" },
      ],
    });
    const { send } = await warmed([fromPlace()]);
    let reads = 0;
    h.readFlows.mockImplementation(() => (++reads === 1 ? [fromPlace()] : [fromNotify()]));
    await send({ type: "deck:refresh" });
    expect(h.exec).not.toHaveBeenCalled();
    const e = lastWrite().edges[0];
    // Settled with an `error` and NO `firedAt`: visible in the drawer, with a Reset
    // beside it, and never re-run under the latch.
    expect(e.firedAt).toBeUndefined();
    expect(e.error).toContain("nothing upstream of n1 is a place");
    // Names what to set, since nothing else here can tell the user how to fix it.
    expect(e.error).toContain("cwdRepo");
  });

  /** The feature's headline example: `place -> deploy.sh -> smoke.sh`, "deploy,
   * then smoke test". `command-succeeded` is the default AND only condition a
   * picker offers off a command node, so this is the shape the UI steers users
   * into — and the second command's source is a command node, not a place. */
  const chainedFlow = (): Flow => cmdFlow({
    nodes: [
      { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
      { id: "n2", kind: "command", x: 0, y: 0, join: "any", run: "deploy.sh staging" },
      { id: "n3", kind: "command", x: 0, y: 0, join: "any", run: "smoke.sh staging" },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "run" },
      { id: "e2", from: "n2", to: "n3", cond: { kind: "command-succeeded" }, action: "run" },
    ],
  });

  it("runs a chained command in the checkout of the place at the head of the chain", async () => {
    // The defect: `commandCwd` asked only whether the rule's OWN source was a
    // place, so this rule hit the "not a place" arm and deferred — stamping
    // nothing, every six seconds, forever, while `spendTarget` still resolved and
    // asked the user to approve a command that could never run.
    const { send } = await warmed([chainedFlow()]);
    // Pass one: the deploy runs and stamps `performed`, which is what
    // `command-succeeded` reads.
    await send({ type: "deck:refresh" });
    expect(ran()[0]).toBe("deploy.sh staging");
    h.flows = [lastWrite()];
    // Pass two: the smoke test's condition is now met.
    await send({ type: "deck:refresh" });
    expect(h.exec).toHaveBeenCalledTimes(2);
    expect(ran()[0]).toBe("smoke.sh staging");
    // Inherited from n1, two hops back — the place at the head of the chain.
    expect(ran()[1].cwd).toBe("/r/aws-ops");
    const w = lastWrite();
    expect(w.edges[1].firedAt).toBeTypeOf("number");
    expect(w.edges[1].firedNote).toBe("ran smoke.sh staging in aws-ops");
  });

  it("resolves a chained command's own cwdRepo against the chain's run, not just the machine", async () => {
    // `cwdRepo` already won over the inherited directory; what a chained source
    // used to lose was the RUN to resolve it against, so a name belonging to the
    // chain's own run fell through to `discoverRepos`'s main checkout. `bite-me` is
    // a second checkout of the same run (`/r/bite-me`), and the machine's copy is
    // deliberately elsewhere.
    h.repos = [{ name: "bite-me", path: "/repos/bite-me", isGit: true }];
    const flow = chainedFlow();
    flow.nodes[2] = { id: "n3", kind: "command", x: 0, y: 0, join: "any", run: "smoke.sh", cwdRepo: "bite-me" };
    const { send } = await warmed([flow]);
    await send({ type: "deck:refresh" });
    h.flows = [lastWrite()];
    await send({ type: "deck:refresh" });
    expect(ran()[1].cwd).toBe("/r/bite-me");
  });

  it("runs a chained command where the rule that DID fire came from, not where flow order points", async () => {
    // Two places into one command node is an ordinary two-wire build ("when either
    // merges, deploy"), and the two roots are different checkouts of the run. The
    // chained `smoke.sh` used to walk back to whichever root sorted FIRST — here the
    // branch whose condition never held — and execute unattended shell in a checkout
    // the user did not intend. e1 is first in flow order and never met; e2 is the one
    // that runs, so the two answers genuinely disagree.
    const fanIn = (): Flow => cmdFlow({
      nodes: [
        // FIRST in flow order, and the branch that never fires: this fixture's run
        // carries `bite-me` as a second checkout with no pull request of its own, so
        // no place-shaped condition on it is ever met.
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "bite-me" },
        { id: "n2", kind: "place", x: 0, y: 88, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
        { id: "n3", kind: "command", x: 0, y: 0, join: "any", run: "deploy.sh staging" },
        { id: "n4", kind: "command", x: 0, y: 88, join: "any", run: "smoke.sh staging" },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n3", cond: { kind: "pr-merged" }, action: "run" },
        { id: "e2", from: "n2", to: "n3", cond: { kind: "pr-merged" }, action: "run" },
        { id: "e3", from: "n3", to: "n4", cond: { kind: "command-succeeded" }, action: "run" },
      ],
    });
    const { send } = await warmed([fanIn()]);
    await send({ type: "deck:refresh" });
    // Pass one: only e2 fires, and it runs in its OWN place's checkout.
    expect(h.exec).toHaveBeenCalledTimes(1);
    expect(ran()[1].cwd).toBe("/r/aws-ops");
    expect(lastWrite().edges[1].performed).toBe(true);
    // The waiting wire is untouched, so the disagreement is still live for pass two.
    expect(lastWrite().edges[0].firedAt).toBeUndefined();
    h.flows = [lastWrite()];
    await send({ type: "deck:refresh" });
    // Pass two: the chained command inherits the PERFORMER's checkout, not the
    // first-in-flow-order one (`/r/bite-me`).
    expect(ran()[0]).toBe("smoke.sh staging");
    expect(ran()[1].cwd).toBe("/r/aws-ops");
    expect(lastWrite().edges[2].firedNote).toBe("ran smoke.sh staging in aws-ops");
  });

  it("refuses a chained command whose chain reaches no place at all", async () => {
    // A hand-edited file, or one written by a newer build: `validNode` admits an
    // unknown kind on purpose so such a flow still renders. Its incoming edge is
    // already stamped `performed`, so `command-succeeded` is met — and nothing
    // upstream is, or will become, a place. Refused and latched, not deferred: no
    // later pass would answer differently.
    const chainRootUnknown = (): Flow => cmdFlow({
      nodes: [
        { id: "n1", kind: "webhook", x: 0, y: 0, join: "any" } as unknown as FlowNode,
        { id: "n2", kind: "command", x: 0, y: 0, join: "any", run: "deploy.sh staging" },
        { id: "n3", kind: "command", x: 0, y: 0, join: "any", run: "smoke.sh staging" },
      ],
      edges: [
        {
          id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "run",
          firedAt: 400, firedNote: "ran deploy.sh staging in aws-ops", performed: true,
        },
        { id: "e2", from: "n2", to: "n3", cond: { kind: "command-succeeded" }, action: "run" },
      ],
    });
    // Not `warmed`: this rule's condition is met from the very first evaluation
    // (its performer is already stamped in the fixture), so the resume gate holds
    // it and approval — not a second poll — is what lets the pass act.
    setConfig({ orchestrator: true });
    h.flows = [chainRootUnknown()];
    h.buildRunStatus.mockReturnValue(runStatus("MERGED"));
    const { send } = await openPanel();
    await settle();
    h.writeFlow.mockClear();
    h.exec.mockClear();
    await send({ type: "flow:resumeApprove", id: "f1" });
    await settle();
    expect(h.exec).not.toHaveBeenCalled();
    const e = lastWrite().edges[1];
    expect(e.firedAt).toBeUndefined();
    expect(e.error).toContain("nothing upstream of n2 is a place");
    expect(e.error).toContain("cwdRepo");
  });

  it("refuses a chained command whose chain reaches a place whose run is not on the board", async () => {
    // A chained rule is NOT the mid-pass race a defer is for: `commandSucceeded`
    // reads a receipt off the flow itself, so nothing in this pass ever proved the
    // upstream run was live. A retired run is an ordinary durable fact here, and
    // deferring on it is the invisible forever-loop this fix removes.
    const chainRootGone = (): Flow => cmdFlow({
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-GONE", repo: "aws-ops" },
        { id: "n2", kind: "command", x: 0, y: 0, join: "any", run: "deploy.sh staging" },
        { id: "n3", kind: "command", x: 0, y: 0, join: "any", run: "smoke.sh staging" },
      ],
      edges: [
        {
          id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "run",
          firedAt: 400, firedNote: "ran deploy.sh staging in aws-ops", performed: true,
        },
        { id: "e2", from: "n2", to: "n3", cond: { kind: "command-succeeded" }, action: "run" },
      ],
    });
    setConfig({ orchestrator: true });
    h.flows = [chainRootGone()];
    h.buildRunStatus.mockReturnValue(runStatus("MERGED"));
    const { send } = await openPanel();
    await settle();
    h.writeFlow.mockClear();
    h.exec.mockClear();
    await send({ type: "flow:resumeApprove", id: "f1" });
    await settle();
    expect(h.exec).not.toHaveBeenCalled();
    const e = lastWrite().edges[1];
    expect(e.firedAt).toBeUndefined();
    expect(e.error).toContain("PROJ-GONE");
    expect(e.error).toContain("cwdRepo");
  });

  it("still DEFERS when the rule's own source is a place whose repo left this pass's board", async () => {
    // The one shape a defer is honest for, kept: `evaluateFlow` only fires an edge
    // out of a place with a live status, so a missing repo means the graph changed
    // under the pass. Nothing was spent and nothing is decided — the next pass gets
    // a clean read rather than a permanent latch.
    const lines: string[] = [];
    const moved = () => cmdFlow({
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "gone-repo" },
        { id: "n2", kind: "command", x: 0, y: 0, join: "any", run: "deploy.sh staging" },
      ],
    });
    const { send } = await warmed([cmdFlow()], (m) => lines.push(m));
    let reads = 0;
    h.readFlows.mockImplementation(() => (++reads === 1 ? [cmdFlow()] : [moved()]));
    await send({ type: "deck:refresh" });
    expect(h.exec).not.toHaveBeenCalled();
    // No stamp of any kind, so a corrected flow retries cleanly.
    expect(h.writeFlow).not.toHaveBeenCalled();
    expect(lines.some((l) => /deferred — gone-repo is not among run PROJ-1's repos/.test(l))).toBe(true);
  });
});

describe("the resume gate", () => {
  /** Open a panel and return it plus a way to deliver an inbound message — the
   * same `show()` + `settled()` + `_fire` idiom every other describe block in
   * this file uses, rather than reaching into `webview.onDidReceiveMessage`
   * directly. */
  const openPanel = async () => {
    show();
    await settled();
    const p = lastPanel();
    return { p, send: async (m: unknown) => { await p._fire(m); await settled(); } };
  };

  const armedFlow = (): Flow => ({
    ...mkFlow("f1", "Ship the migration"),
    armed: true,
    nodes: [
      { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
      { id: "n2", kind: "notify", x: 0, y: 0, join: "any", message: "the migration has landed" },
    ],
    edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" }],
  });

  /** The last deck:flows post. `.filter(...).at(-1)` rather than `.findLast`:
   * this project's tsconfig caps `lib` at ES2022, one short of the ES2023
   * `findLast` needs, so that would fail `tsc --noEmit` despite reading fine. */
  const lastFlowsPost = (p: ReturnType<typeof lastPanel>) =>
    posts(p).filter((m) => m.type === "deck:flows").at(-1) as { pendingResume: unknown };

  it("does not act on the first pass — it reports what is ready", async () => {
    setConfig({ orchestrator: true });
    h.flows = [armedFlow()];
    h.buildRunStatus.mockReturnValue(mergedStatus("PROJ-1", "aws-ops"));
    const { p } = await openPanel();
    await settle();
    expect(h.writeFlow).not.toHaveBeenCalled();
    expect(lastFlowsPost(p).pendingResume).toEqual([
      { flowId: "f1", flowName: "Ship the migration", lines: [expect.any(String)] },
    ]);
  });

  it("falls back to a generic line when the held rule is not a notify", async () => {
    // notifyLines only ever describes a PERFORMED notify edge (Task 3) — a
    // pending launch or seed rule has no such line, but the banner still needs
    // something to show while it holds.
    setConfig({ orchestrator: true });
    h.flows = [{
      ...armedFlow(),
      // n2 must actually BE planned work, not a notify node stored as "launch":
      // the latter derives to "notify" (its target's real kind), which is a
      // genuine notify rule and correctly gets a "told you" line — see Task 2's
      // fix for the deckView.test.ts fixture that used to assert the opposite.
      nodes: [
        armedFlow().nodes[0],
        {
          id: "n2", kind: "planned", x: 0, y: 0, join: "any",
          ticketKey: "PROJ-12", repos: ["aws-ops"], mode: "implementation", dest: "worktree",
        },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "launch" }],
    }];
    h.buildRunStatus.mockReturnValue(mergedStatus("PROJ-1", "aws-ops"));
    const { p } = await openPanel();
    await settle();
    expect(lastFlowsPost(p).pendingResume).toEqual([
      { flowId: "f1", flowName: "Ship the migration", lines: ["Ship the migration: a rule is ready."] },
    ]);
  });

  it("fires on the pass after approval", async () => {
    setConfig({ orchestrator: true });
    h.flows = [armedFlow()];
    h.buildRunStatus.mockReturnValue(mergedStatus("PROJ-1", "aws-ops"));
    const { send } = await openPanel();
    await settle();
    await send({ type: "flow:resumeApprove", id: "f1" });
    await settle();
    expect((h.writeFlow.mock.calls.at(-1)![2] as Flow).edges[0].firedAt).toBeTypeOf("number");
  });

  it("disarms instead, if that is what you choose", async () => {
    setConfig({ orchestrator: true });
    h.flows = [armedFlow()];
    h.buildRunStatus.mockReturnValue(mergedStatus("PROJ-1", "aws-ops"));
    const { send } = await openPanel();
    await settle();
    await send({ type: "flow:resumeDisarm", id: "f1" });
    expect((h.writeFlow.mock.calls.at(-1)![2] as Flow).armed).toBe(false);
    h.writeFlow.mockClear();
    // A genuine subsequent poll, not just a microtask drain — the brief's own
    // `await settle()` here would never exercise a second pass at all (nothing
    // advances the panel's real 6s timer), which would make "nothing fires
    // afterwards" pass even if the disarm write never actually landed on disk.
    await send({ type: "deck:refresh" });
    expect(h.writeFlow).not.toHaveBeenCalled();
  });

  it("holds the gate across several passes until you answer", async () => {
    setConfig({ orchestrator: true });
    h.flows = [armedFlow()];
    h.buildRunStatus.mockReturnValue(mergedStatus("PROJ-1", "aws-ops"));
    const { send } = await openPanel();
    await settle();
    // Three genuine, separate polls — not three microtask drains of the same
    // one pass, which is all the brief's own `await settle()` × 3 would be.
    await send({ type: "deck:refresh" });
    await send({ type: "deck:refresh" });
    await send({ type: "deck:refresh" });
    expect(h.writeFlow).not.toHaveBeenCalled();
  });

  it("does not gate a flow with nothing ready — there is nothing to approve", async () => {
    setConfig({ orchestrator: true });
    h.flows = [armedFlow()];
    h.buildRunStatus.mockReturnValue(openStatus("PROJ-1", "aws-ops"));
    const { p } = await openPanel();
    await settle();
    expect(lastFlowsPost(p).pendingResume).toEqual([]);
  });

  it("fires without a gate once a rule becomes met later in the same session", async () => {
    // The gate protects the moment you come back, not every future firing.
    setConfig({ orchestrator: true });
    h.flows = [armedFlow()];
    h.buildRunStatus.mockReturnValue(openStatus("PROJ-1", "aws-ops"));
    const { send } = await openPanel();
    await settle();
    h.buildRunStatus.mockReturnValue(mergedStatus("PROJ-1", "aws-ops"));
    // A real second pass: the brief's own bare `await settle()` here never asks
    // the panel for one (nothing here advances its real 6s timer), so
    // `h.writeFlow.mock.calls.at(-1)` would still be the FIRST pass's call — or,
    // since the first pass never wrote (openStatus), `undefined`, throwing on
    // the `!` below rather than merely passing for the wrong reason.
    await send({ type: "deck:refresh" });
    expect((h.writeFlow.mock.calls.at(-1)![2] as Flow).edges[0].firedAt).toBeTypeOf("number");
  });

  it("ignores an approval for an id it is not holding", async () => {
    setConfig({ orchestrator: true });
    h.flows = [armedFlow()];
    h.buildRunStatus.mockReturnValue(mergedStatus("PROJ-1", "aws-ops"));
    const { p, send } = await openPanel();
    await settle();
    const loadsBefore = posts(p).filter((m) => m.type === "deck:loading").length;
    await send({ type: "flow:resumeApprove", id: "nope" });
    // An id nobody is holding must not even kick off a refresh — asserting only
    // "no write" would still pass if the guard were deleted outright, since
    // "nope" doesn't match any real flow's id either way. Asserting on the
    // busy indicator instead catches the guard's absence directly.
    expect(posts(p).filter((m) => m.type === "deck:loading").length).toBe(loadsBefore);
    // And f1's own gate is still intact on a genuine subsequent poll — proving
    // the bogus id did not clear (or otherwise disturb) a real held gate.
    await send({ type: "deck:refresh" });
    expect(h.writeFlow).not.toHaveBeenCalled();
  });

  it("flow:resumeDisarm ignores an id that is not in the store", async () => {
    setConfig({ orchestrator: true });
    h.flows = [armedFlow()];
    h.buildRunStatus.mockReturnValue(mergedStatus("PROJ-1", "aws-ops"));
    const { send } = await openPanel();
    await settle();
    await send({ type: "flow:resumeDisarm", id: "nope" });
    expect(h.writeFlow).not.toHaveBeenCalled();
  });

  it("ignores both resume messages when the setting is off", async () => {
    setConfig({ orchestrator: false });
    h.flows = [armedFlow()];
    const { send } = await openPanel();
    await send({ type: "flow:resumeApprove", id: "f1" });
    await send({ type: "flow:resumeDisarm", id: "f1" });
    expect(h.writeFlow).not.toHaveBeenCalled();
  });
});

describe("arm, disarm and reset", () => {
  /** Open a panel and return it plus a way to deliver an inbound message — the
   * same `show()` + `settled()` + `_fire` idiom every other describe block in
   * this file uses, rather than reaching into `webview.onDidReceiveMessage`
   * directly. */
  const openPanel = async () => {
    show();
    await settled();
    const p = lastPanel();
    return { p, send: async (m: unknown) => { await p._fire(m); await settled(); } };
  };

  it("flow:arm sets armed and reports nothing when both sources are on", async () => {
    // this.liveSignal defaults true and beforeEach already sets h.prFacts true
    // (the mocked getConfig() returns h.prFacts, not whatever setConfig stores —
    // see the module mock above), so both sources are already on without
    // needing to steer either one here.
    setConfig({ orchestrator: true });
    h.flows = [mkFlow("f1", "n")];
    const { p, send } = await openPanel();
    await send({ type: "flow:arm", id: "f1", armed: true });
    expect((h.writeFlow.mock.calls.at(-1)![2] as Flow).armed).toBe(true);
    expect(posts(p).some((m) => m.type === "toast" && /can never fire/i.test(m.message ?? ""))).toBe(false);
  });

  it("flow:arm names the rules that can never fire with a source off", async () => {
    // h.prFacts, not setConfig({ prFacts: false }): the mocked getConfig() in
    // this file always returns h.prFacts for the `prFacts` field, regardless of
    // what the fake vscode configuration store holds — the same knob every
    // other "PR facts off" test in this suite turns (see e.g. line ~1457).
    // setConfig({ prFacts: false }) alone would leave this.prFacts seeded true
    // in the constructor, and the dead-rule toast would never fire.
    setConfig({ orchestrator: true });
    h.prFacts = false;
    h.flows = [{
      ...mkFlow("f1", "n"),
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" }],
    }];
    const { p, send } = await openPanel();
    await send({ type: "flow:arm", id: "f1", armed: true });
    // Armed anyway — a flow with one dead rule and three live ones is still worth arming.
    expect((h.writeFlow.mock.calls.at(-1)![2] as Flow).armed).toBe(true);
    const toast = posts(p).find((m) => m.type === "toast" && /PR facts/i.test(m.message ?? ""));
    expect(toast).toBeTruthy();
  });

  // A blank parameter is the reason that does not depend on any toggle, and the
  // one that replaced the old picker filter: `branch-ci-passed`,
  // `ticket-status-is` and `agent-idle-over` are offered in the drawer now, so a
  // rule CAN be armed with a status nobody typed. Silence would leave the user
  // watching a rule that looks configured and can never fire.
  it("flow:arm names a rule whose condition has a blank setting, with every source on", async () => {
    setConfig({ orchestrator: true });
    h.flows = [{
      ...mkFlow("f1", "n"),
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "ticket-status-is", status: "" }, action: "notify" }],
    }];
    const { p, send } = await openPanel();
    await send({ type: "flow:arm", id: "f1", armed: true });
    // Armed anyway, like every other dead-rule reason — a flow with one blank
    // rule and three filled ones is still worth arming.
    expect((h.writeFlow.mock.calls.at(-1)![2] as Flow).armed).toBe(true);
    const toast = posts(p).find((m) => m.type === "toast" && /can never fire/i.test(m.message ?? ""));
    expect(toast?.message).toContain("1 rule has a setting left blank");
  });

  it("flow:arm puts the blank setting FIRST, ahead of a toggle it outranks", async () => {
    // With PR facts off, a `branch-ci-passed` rule qualifies for both reasons.
    // Leading with the toggle would send the user to turn on a setting that
    // still leaves the rule dead; the branch is the fix.
    setConfig({ orchestrator: true });
    h.prFacts = false;
    h.flows = [{
      ...mkFlow("f1", "n"),
      edges: [
        { id: "e1", from: "n1", to: "n2", cond: { kind: "branch-ci-passed", repo: "r", branch: "" }, action: "notify" },
        { id: "e2", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" },
      ],
    }];
    const { p, send } = await openPanel();
    await send({ type: "flow:arm", id: "f1", armed: true });
    const toast = posts(p).find((m) => m.type === "toast" && /can never fire/i.test(m.message ?? ""));
    expect(toast?.message).toContain("1 rule has a setting left blank");
    // The other rule still earns its own, unchanged reason — and after this one.
    expect(toast?.message).toContain("1 needs PR facts");
    expect(toast!.message!.indexOf("left blank")).toBeLessThan(toast!.message!.indexOf("PR facts"));
  });

  it("flow:arm says nothing about a parameterised rule that is filled in", async () => {
    setConfig({ orchestrator: true });
    h.flows = [{
      ...mkFlow("f1", "n"),
      edges: [{
        id: "e1", from: "n1", to: "n2",
        cond: { kind: "agent-idle-over", minutes: 30 }, action: "notify",
      }],
    }];
    const { p, send } = await openPanel();
    await send({ type: "flow:arm", id: "f1", armed: true });
    expect(posts(p).some((m) => m.type === "toast" && /can never fire/i.test(m.message ?? ""))).toBe(false);
  });

  // Task 10 threads `forge: this.caps()` through this call site — until now,
  // `unfirableRules` was always called with no `forge` at all, so the
  // "forge-unsupported" branch (Task 9, armability.ts) was dead code from here.
  // GitLab has no `resolveCaps` (Task 7's addition is a no-op for it), so
  // `caps()` here just reads the static `Forge.caps` record — no probe-warming
  // tick is needed the way a PR-facts or footer-note test needs one. A forge
  // that DOES resolve its caps asynchronously (Bitbucket) is covered in the
  // "forge selection" suite instead.
  it("flow:arm names a changes-requested rule as forge-unsupported on gitlab", async () => {
    setConfig({ orchestrator: true, forge: "gitlab" });
    h.flows = [{
      ...mkFlow("f1", "n"),
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "changes-requested" }, action: "notify" }],
    }];
    const { p, send } = await openPanel();
    await send({ type: "flow:arm", id: "f1", armed: true });
    const toast = posts(p).find((m) => m.type === "toast" && /can never fire/i.test(m.message ?? ""));
    // Reworded (Task 10) from the em-dash aside "1 needs — your forge cannot
    // report this" to read naturally alongside its siblings "1 needs PR facts"
    // and "1 needs the Live signal".
    expect(toast?.message).toContain("1 rule's forge cannot report this");
  });

  // The negative of the test above, and the ONLY thing that exercises the
  // `resolveCaps()` assignment in `forgeReady()`: deleting that whole `void
  // this.forge.resolveCaps?.().then(...)` block left all 556 tests in this file
  // passing. Bitbucket in passthrough mode is the one forge whose caps are only
  // knowable after a probe — `caps.changesRequested` is statically false and
  // becomes true once `bb api --help` has answered — so with the block gone,
  // `caps()` falls back to the conservative static record and this flow is told
  // its rule can never fire, when in fact it can. Restore the block and this is
  // green; delete it and it goes red.
  it("does NOT name a changes-requested rule unfirable on a passthrough bitbucket", async () => {
    setConfig({ orchestrator: true, forge: "bitbucket" });
    // `bb api --help` exiting zero is the entire passthrough signal (probeBbApi),
    // and the mocked `execRunner` seam is what atlassian-cli spawns through here —
    // the same seam the gitlab cases above use, with no new mock of its own.
    h.ghRun.mockResolvedValue("Usage: atlassian-cli bb api <PATH>");
    h.flows = [{
      ...mkFlow("f1", "n"),
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "changes-requested" }, action: "notify" }],
    }];
    const { p, send } = await openPanel();
    // Bitbucket's caps are ASYNC, unlike gitlab's static record: the probe is
    // kicked off inside the tick that first reads it, so it cannot have settled by
    // the time that tick returns. One warmed tick, exactly as `showAndWarm` does.
    await p._fire({ type: "deck:refresh" });
    await settled();

    await send({ type: "flow:arm", id: "f1", armed: true });
    expect((h.writeFlow.mock.calls.at(-1)![2] as Flow).armed).toBe(true);
    expect(posts(p).some((m) => m.type === "toast" && /can never fire/i.test(m.message ?? ""))).toBe(false);
  });

  it("flow:arm with armed:false disarms", async () => {
    setConfig({ orchestrator: true });
    h.flows = [{ ...mkFlow("f1", "n"), armed: true }];
    const { send } = await openPanel();
    await send({ type: "flow:arm", id: "f1", armed: false });
    expect((h.writeFlow.mock.calls.at(-1)![2] as Flow).armed).toBe(false);
  });

  it("flow:arm ignores an unknown id", async () => {
    setConfig({ orchestrator: true });
    h.flows = [mkFlow("f1", "n")];
    const { send } = await openPanel();
    await send({ type: "flow:arm", id: "nope", armed: true });
    expect(h.writeFlow).not.toHaveBeenCalled();
  });

  it("flow:arm(false) drops any held resume gate, so re-arming starts the cycle over", async () => {
    // Task 4's resume gate: a flow whose first evaluation finds a rule already
    // met holds it for approval rather than firing outright. Disarming while
    // that gate is held must drop it — otherwise re-arming later would resume
    // exactly where it left off instead of starting a fresh first evaluation.
    setConfig({ orchestrator: true });
    h.flows = [{
      ...mkFlow("f1", "n"),
      armed: true,
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
        { id: "n2", kind: "notify", x: 0, y: 0, join: "any", message: "done" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" }],
    }];
    h.buildRunStatus.mockReturnValue(mergedStatus("PROJ-1", "aws-ops"));
    const { p, send } = await openPanel();
    await settle();
    const held = posts(p).filter((m) => m.type === "deck:flows").at(-1) as { pendingResume: unknown[] };
    expect(held.pendingResume).toHaveLength(1);
    await send({ type: "flow:arm", id: "f1", armed: false });
    const clearedPost = posts(p).filter((m) => m.type === "deck:flows").at(-1) as { pendingResume: unknown[] };
    expect(clearedPost.pendingResume).toEqual([]);
    await send({ type: "flow:arm", id: "f1", armed: true });
    await send({ type: "deck:refresh" });
    // Re-armed after a drop: the very next pass must hold again rather than
    // fire straight away — proof the resume gate's own bookkeeping was reset,
    // not just the flow's `armed` bit.
    const again = posts(p).filter((m) => m.type === "deck:flows").at(-1) as { pendingResume: unknown[] };
    expect(again.pendingResume).toHaveLength(1);
  });

  it("journals arming and disarming, naming which gesture it was", async () => {
    setConfig({ orchestrator: true });
    h.flows = [mkFlow("f1", "n")];
    const { send } = await openPanel();
    await send({ type: "flow:arm", id: "f1", armed: true });
    await send({ type: "flow:arm", id: "f1", armed: false });
    const armed = journal().filter((e) => e.kind === "armed");
    expect(armed).toHaveLength(2);
    expect(armed[0]).toMatchObject({ kind: "armed", armed: true, source: "toggle", flow: "f1" });
    expect(armed[1]).toMatchObject({ kind: "armed", armed: false, source: "toggle", flow: "f1" });
  });

  it("journals the resume banner's disarm, naming that gesture rather than the toggle", async () => {
    // The banner's Disarm switches the flow off exactly as the toggle does, and a
    // journal that recorded only one of the two ways would leave a flow reading
    // as armed when it is not. `source` matches the `flow_armed` telemetry the
    // same handler emits, so the two records of one gesture agree.
    setConfig({ orchestrator: true });
    h.flows = [{
      ...mkFlow("f1", "n"),
      armed: true,
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
        { id: "n2", kind: "notify", x: 0, y: 0, join: "any", message: "done" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" }],
    }];
    h.buildRunStatus.mockReturnValue(mergedStatus("PROJ-1", "aws-ops"));
    const { p, send } = await openPanel();
    await settle();
    const held = posts(p).filter((m) => m.type === "deck:flows").at(-1) as { pendingResume: unknown[] };
    expect(held.pendingResume).toHaveLength(1);
    await send({ type: "flow:resumeDisarm", id: "f1" });
    const armed = journal().filter((e) => e.kind === "armed");
    expect(armed).toHaveLength(1);
    expect(armed[0]).toMatchObject({ kind: "armed", armed: false, source: "resume-banner", flow: "f1" });
  });

  it("does not journal an arm for a flow id that is not on disk", async () => {
    setConfig({ orchestrator: true });
    h.flows = [mkFlow("f1", "n")];
    const { send } = await openPanel();
    await send({ type: "flow:arm", id: "nope", armed: true });
    expect(journal().filter((e) => e.kind === "armed")).toEqual([]);
  });

  it("flow:resetEdge clears firedAt, firedNote and error for one edge only", async () => {
    setConfig({ orchestrator: true });
    h.flows = [{
      ...mkFlow("f1", "n"),
      edges: [
        { id: "e1", from: "a", to: "z", cond: { kind: "pr-merged" }, action: "notify", firedAt: 5, firedNote: "told you", error: "boom" },
        { id: "e2", from: "a", to: "y", cond: { kind: "pr-merged" }, action: "notify", firedAt: 7 },
      ],
    }];
    const { send } = await openPanel();
    await send({ type: "flow:resetEdge", id: "f1", edgeId: "e1" });
    const w = h.writeFlow.mock.calls.at(-1)![2] as Flow;
    expect(w.edges[0].firedAt).toBeUndefined();
    expect(w.edges[0].firedNote).toBeUndefined();
    expect(w.edges[0].error).toBeUndefined();
    expect(w.edges[1].firedAt).toBe(7);
  });

  it("flow:resetEdge clears `performed` along with the other stamps", async () => {
    // `performed` names the edge that actually ran among a command node's several
    // incoming edges (see its own doc comment) and `commandSucceeded` reads it, so
    // a Reset that left it behind would leave a reset performer still claiming to
    // be one. It used to be cleared for free by the allow-list rebuild; now that
    // Reset deletes named stamps instead, this is the pin that it is still named.
    setConfig({ orchestrator: true });
    h.flows = [{
      ...mkFlow("f1", "n"),
      edges: [{
        id: "e1", from: "a", to: "z", cond: { kind: "pr-merged" }, action: "run",
        firedAt: 5, firedNote: "ran deploy in aws-ops", performed: true,
      }],
    }];
    const { send } = await openPanel();
    await send({ type: "flow:resetEdge", id: "f1", edgeId: "e1" });
    const e = (h.writeFlow.mock.calls.at(-1)![2] as Flow).edges[0];
    expect(e.performed).toBeUndefined();
    expect(e.firedAt).toBeUndefined();
    expect(e.firedNote).toBeUndefined();
  });

  it("flow:resetEdge keeps the rule's note, so the command it re-runs is the one that was approved", async () => {
    // The defect this pins: the handler rebuilt the edge from an allow-list of
    // `{id, from, to, cond, mode}` and dropped `note`. For a `run` rule the note is
    // spliced into the command at `{note}` (`command.ts`'s `withNote`), so Reset on
    // a failed `deploy.sh --env={note}` carrying `note: "staging"` made the next
    // poll execute `deploy.sh --env=` — a DIFFERENT command from the one that
    // failed and from the one the modal named — with `commandConfirmedAt` already
    // stamped, so with no second ask.
    setConfig({ orchestrator: true });
    h.flows = [{
      ...mkFlow("f1", "n"),
      commandConfirmedAt: 1,
      nodes: [
        { id: "a", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
        { id: "z", kind: "command", x: 0, y: 0, join: "any", run: "deploy.sh --env={note}" },
      ],
      edges: [{
        id: "e1", from: "a", to: "z", cond: { kind: "pr-merged" }, action: "run",
        note: "staging", error: "\"deploy.sh --env=staging\" exited with code 1.",
      }],
    }];
    const { send } = await openPanel();
    await send({ type: "flow:resetEdge", id: "f1", edgeId: "e1" });
    const e = (h.writeFlow.mock.calls.at(-1)![2] as Flow).edges[0];
    expect(e.note).toBe("staging");
    expect(e.error).toBeUndefined();
  });

  it("flow:resetEdge carries an unknown field through, so a newer build's edge survives a Reset here", async () => {
    // `coerceFlow`'s own rule: unknown fields ride along untouched so a newer
    // build's flow survives an older build rewriting it. An allow-list rebuild
    // broke exactly that for the one edge being Reset.
    setConfig({ orchestrator: true });
    h.flows = [{
      ...mkFlow("f1", "n"),
      edges: [{
        id: "e1", from: "a", to: "z", cond: { kind: "pr-merged" }, firedAt: 5,
        // A field a LATER build added, which this one knows nothing about.
        ...({ retryAfter: 42 } as Record<string, unknown>),
      }],
    }];
    const { send } = await openPanel();
    await send({ type: "flow:resetEdge", id: "f1", edgeId: "e1" });
    const e = (h.writeFlow.mock.calls.at(-1)![2] as Flow).edges[0] as unknown as { retryAfter?: number };
    expect(e.retryAfter).toBe(42);
    expect((h.writeFlow.mock.calls.at(-1)![2] as Flow).edges[0].firedAt).toBeUndefined();
  });

  it("flow:resetEdge drops the stored action, so the store re-derives it from the target", async () => {
    // The host half of making Reset mean what `latchActionMismatches` promises:
    // "Reset the rule to accept that". Carrying the disagreeing stored action
    // through this write left the value on disk unchanged, so the very next read
    // compared it against the derived one again and stamped the identical error —
    // a rule that could never fire and could never be repaired. Dropping it lets
    // `writeFlow`'s `e.action ?? edgeAction(...)` fill it from the target.
    //
    // `writeFlow` is mocked in this suite, so this asserts the handler's own
    // output; migration.test.ts owns the store half — that the field still lands
    // on disk, derived, which is what an older build's `validEdge` needs.
    setConfig({ orchestrator: true });
    h.flows = [{
      ...mkFlow("f1", "n"),
      nodes: [
        { id: "a", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
        {
          id: "z", kind: "planned", x: 0, y: 0, join: "any",
          ticketKey: "PROJ-2", repos: ["aws-ops"], mode: "implementation", dest: "worktree",
        },
      ],
      // A `notify` pointing at planned work: the ordinary leftover shape, since
      // `finishWire` wires everything as `notify` whatever it points at.
      edges: [{
        id: "e1", from: "a", to: "z", cond: { kind: "pr-merged" }, action: "notify",
        mode: "implementation", error: `${ACTION_MISMATCH_PREFIX}: it was saved as "notify" …`,
      }],
    }];
    const { send } = await openPanel();
    await send({ type: "flow:resetEdge", id: "f1", edgeId: "e1" });
    const e = (h.writeFlow.mock.calls.at(-1)![2] as Flow).edges[0];
    expect(e.action).toBeUndefined();
    expect(e.error).toBeUndefined();
    // The user's own configuration is not dropped along with the mirror — a seed's
    // prompt mode lives on the edge and has nowhere else to go.
    expect(e.mode).toBe("implementation");
  });

  it("journals a Reset, which is the gesture that destroys the edge's receipt", async () => {
    setConfig({ orchestrator: true });
    h.flows = [{
      ...mkFlow("f1", "n"),
      edges: [
        { id: "e1", from: "a", to: "z", cond: { kind: "pr-merged" }, action: "notify", firedAt: 5, firedNote: "told you", error: "boom" },
        { id: "e2", from: "a", to: "y", cond: { kind: "pr-merged" }, action: "notify", firedAt: 7 },
      ],
    }];
    const { send } = await openPanel();
    await send({ type: "flow:resetEdge", id: "f1", edgeId: "e1" });
    const reset = journal().filter((e) => e.kind === "reset");
    expect(reset).toHaveLength(1);
    expect(reset[0]).toMatchObject({ kind: "reset", edge: "e1", flow: "f1" });
  });

  it("flow:resetEdge ignores an unknown flow id", async () => {
    setConfig({ orchestrator: true });
    h.flows = [{
      ...mkFlow("f1", "n"),
      edges: [{ id: "e1", from: "a", to: "z", cond: { kind: "pr-merged" }, action: "notify", firedAt: 5 }],
    }];
    const { send } = await openPanel();
    await send({ type: "flow:resetEdge", id: "nope", edgeId: "e1" });
    expect(h.writeFlow).not.toHaveBeenCalled();
  });

  describe("flow:answerGate", () => {
    beforeEach(() => setConfig({ orchestrator: true }));

    // A gate `g` with two incoming edges: `ask1` already fired and is the
    // PERFORMER (it posed the question, hence `performed: true`). `sibling`
    // is the shape `FlowEdge.performed`'s own doc comment names — a
    // per-target-dedupe or "all"-junction sibling that `applyFired`
    // (runner.ts) stamps with the identical `firedAt`-set, `error`-absent
    // shape without ever running anything, so it carries `firedAt` but never
    // `performed`. Giving it `firedAt` here (rather than leaving the edge
    // unfired) is what makes "ignores an answer for an edge that is not the
    // performer" a real test of the guard's `performed` half: an unfired
    // sibling would also be refused by the guard's separate `firedAt` half,
    // masking a deleted `performed` check. Mirrors the shape
    // `flow:resetEdge`'s own fixtures use above, plus the gate node and the
    // second edge this handler has to tell apart from the performer.
    const gateFixture = (): Flow => ({
      ...mkFlow("f1", "n"),
      nodes: [{ id: "g", kind: "gate", x: 0, y: 0, join: "any", question: "deploy to prod?" }],
      edges: [
        { id: "ask1", from: "a", to: "g", cond: { kind: "pr-merged" }, action: "ask", firedAt: 5, performed: true },
        { id: "sibling", from: "b", to: "g", cond: { kind: "pr-merged" }, action: "ask", firedAt: 5 },
      ],
    });

    it("stamps the answer on the performer edge", async () => {
      h.flows = [gateFixture()];
      const { send } = await openPanel();
      await send({ type: "flow:answerGate", id: "f1", edgeId: "ask1", answer: "approved" });
      const written = h.writeFlow.mock.calls.at(-1)![2] as Flow;
      expect(written.edges.find((e) => e.id === "ask1")!.gateAnswer).toBe("approved");
      // The sibling edge is untouched — proof the write targeted one edge, not a
      // blanket stamp across the flow.
      expect(written.edges.find((e) => e.id === "sibling")!.gateAnswer).toBeUndefined();
    });

    it("keeps the first answer and ignores a second", async () => {
      h.flows = [gateFixture()];
      const { send } = await openPanel();
      await send({ type: "flow:answerGate", id: "f1", edgeId: "ask1", answer: "approved" });
      // h.writeFlow's default mockImplementation (beforeEach) folds the write
      // back into h.flows, so the second send's own re-read under the lock sees
      // the first answer already stamped — exactly the on-disk state a second
      // click would actually find.
      const beforeSecond = h.writeFlow.mock.calls.length;
      await send({ type: "flow:answerGate", id: "f1", edgeId: "ask1", answer: "rejected" });
      // No second write at all: the handler refuses before it ever calls writeFlow.
      expect(h.writeFlow.mock.calls.length).toBe(beforeSecond);
      expect(h.flows[0].edges.find((e) => e.id === "ask1")!.gateAnswer).toBe("approved");
    });

    it("journals the answer, naming the edge and what was answered", async () => {
      h.flows = [gateFixture()];
      const { send } = await openPanel();
      await send({ type: "flow:answerGate", id: "f1", edgeId: "ask1", answer: "approved" });
      const answered = journal().filter((e) => e.kind === "answered");
      expect(answered).toHaveLength(1);
      expect(answered[0]).toMatchObject({ kind: "answered", edge: "ask1", answer: "approved", flow: "f1" });
    });

    it("journals nothing for a second answer, which the handler refuses", async () => {
      // First-answer-wins means the second call never reaches writeFlow (see
      // "keeps the first answer and ignores a second" above). A journal entry
      // for that refused call would record a decision the flow file itself does
      // not reflect — approve, then a "rejected" line nobody's edge carries.
      h.flows = [gateFixture()];
      const { send } = await openPanel();
      await send({ type: "flow:answerGate", id: "f1", edgeId: "ask1", answer: "approved" });
      await send({ type: "flow:answerGate", id: "f1", edgeId: "ask1", answer: "rejected" });
      const answered = journal().filter((e) => e.kind === "answered");
      expect(answered).toHaveLength(1);
      expect(answered[0]).toMatchObject({ kind: "answered", edge: "ask1", answer: "approved" });
    });

    it("ignores an answer for an edge that is not the performer", async () => {
      h.flows = [gateFixture()];
      const { send } = await openPanel();
      await send({ type: "flow:answerGate", id: "f1", edgeId: "sibling", answer: "approved" });
      expect(h.writeFlow).not.toHaveBeenCalled();
      // A valid answer on the SAME fixture does land — proof this is a targeted
      // refusal (not-the-performer) and not a handler that never writes at all.
      await send({ type: "flow:answerGate", id: "f1", edgeId: "ask1", answer: "approved" });
      expect(h.writeFlow).toHaveBeenCalledTimes(1);
      expect((h.writeFlow.mock.calls.at(-1)![2] as Flow).edges.find((e) => e.id === "ask1")!.gateAnswer)
        .toBe("approved");
    });

    it("ignores an answer for an edge that errored before it ever asked", async () => {
      // The other half of the guard's shape: `performed: true` names it as the
      // one that ran, but no `firedAt` — exactly what a FAILED action gets (see
      // `applyFired`, runner.ts: a failure takes `error` and NO `firedAt`, so a
      // failed launch can't look done). If the guard's `firedAt === undefined`
      // clause were removed, this edge would read as "already asked" and take
      // an answer to a question it never actually posed.
      h.flows = [{
        ...gateFixture(),
        edges: [
          ...gateFixture().edges,
          { id: "errored", from: "c", to: "g", cond: { kind: "pr-merged" }, action: "ask",
            performed: true, error: "ask was not performed" },
        ],
      }];
      const { send } = await openPanel();
      await send({ type: "flow:answerGate", id: "f1", edgeId: "errored", answer: "approved" });
      expect(h.writeFlow).not.toHaveBeenCalled();
      // A valid answer on the real performer, same fixture, does land — proof
      // this is a targeted refusal (no firedAt) and not a handler that never
      // writes at all.
      await send({ type: "flow:answerGate", id: "f1", edgeId: "ask1", answer: "approved" });
      expect(h.writeFlow).toHaveBeenCalledTimes(1);
      expect((h.writeFlow.mock.calls.at(-1)![2] as Flow).edges.find((e) => e.id === "ask1")!.gateAnswer)
        .toBe("approved");
    });

    it("ignores an answer for a flow that is gone", async () => {
      h.flows = [gateFixture()];
      const { send } = await openPanel();
      await send({ type: "flow:answerGate", id: "nope", edgeId: "ask1", answer: "approved" });
      // Not just "did not throw": the real flow on disk is untouched, and the
      // SAME message with the right id still lands — proof the id is what was
      // refused, not that the handler is a no-op for every call.
      expect(h.writeFlow).not.toHaveBeenCalled();
      await send({ type: "flow:answerGate", id: "f1", edgeId: "ask1", answer: "approved" });
      expect((h.writeFlow.mock.calls.at(-1)![2] as Flow).edges.find((e) => e.id === "ask1")!.gateAnswer)
        .toBe("approved");
    });

    it("ignores an answer for an edge that is gone", async () => {
      h.flows = [gateFixture()];
      const { send } = await openPanel();
      await send({ type: "flow:answerGate", id: "f1", edgeId: "nope", answer: "approved" });
      expect(h.writeFlow).not.toHaveBeenCalled();
      await send({ type: "flow:answerGate", id: "f1", edgeId: "ask1", answer: "approved" });
      expect((h.writeFlow.mock.calls.at(-1)![2] as Flow).edges.find((e) => e.id === "ask1")!.gateAnswer)
        .toBe("approved");
    });
  });

  it("flow:resetEdge clears the gate answer along with the other stamps", async () => {
    setConfig({ orchestrator: true });
    h.flows = [{
      ...mkFlow("f1", "n"),
      nodes: [{ id: "g", kind: "gate", x: 0, y: 0, join: "any", question: "deploy to prod?" }],
      edges: [
        { id: "ask1", from: "a", to: "g", cond: { kind: "pr-merged" }, action: "ask", firedAt: 5, performed: true },
      ],
    }];
    const { send } = await openPanel();
    await send({ type: "flow:answerGate", id: "f1", edgeId: "ask1", answer: "approved" });
    expect(h.flows[0].edges.find((e) => e.id === "ask1")!.gateAnswer).toBe("approved");
    await send({ type: "flow:resetEdge", id: "f1", edgeId: "ask1" });
    const e = (h.writeFlow.mock.calls.at(-1)![2] as Flow).edges[0];
    expect(e.gateAnswer).toBeUndefined();
    expect(e.firedAt).toBeUndefined();
    expect(e.performed).toBeUndefined();
  });

  describe("flow:openOutput", () => {
    // `1_000` and `1_002`ms both fall in the same whole second, so the header's
    // timestamp is identical across these fixtures — the point is that the
    // header's PRESENCE, `kind` and `action` are asserted, not that the clock
    // resolution matters here.
    const WHEN = "1970-01-01T00:00:01Z";

    it("opens a fired edge's captured output in a plain-text editor tab, headed with its provenance", async () => {
      setConfig({ orchestrator: true });
      seedJournal("f1", { kind: "fired", edge: "e1", from: "a", to: "z", action: "run", note: "", output: "deployed ok" }, 1_000);
      const { send } = await openPanel();
      await send({ type: "flow:openOutput", id: "f1", edgeId: "e1" });
      expect(workspace.openTextDocument).toHaveBeenCalledWith({
        content: `# fired · run · e1 · ${WHEN}\n\ndeployed ok`, language: "plaintext",
      });
      expect(window.showTextDocument).toHaveBeenCalledWith(expect.anything(), { preview: true });
    });

    it("echoes the journaled action verbatim in the header, not a hardcoded one", async () => {
      // Every other fixture in this block happens to use action "run" — since
      // that is the only kind the UI ever offers Output for — so this pins
      // the header actually READS `result.action` off the journal line rather
      // than a literal that would coincidentally match every other test here.
      setConfig({ orchestrator: true });
      seedJournal("f1", { kind: "fired", edge: "e1", from: "a", to: "z", action: "notify", note: "", output: "told you" }, 1_000);
      const { send } = await openPanel();
      await send({ type: "flow:openOutput", id: "f1", edgeId: "e1" });
      expect(workspace.openTextDocument).toHaveBeenCalledWith({
        content: `# fired · notify · e1 · ${WHEN}\n\ntold you`, language: "plaintext",
      });
    });

    it("opens an errored edge's captured output too, headed as errored", async () => {
      setConfig({ orchestrator: true });
      seedJournal("f1", { kind: "errored", edge: "e1", from: "a", to: "z", action: "run", error: "boom", output: "stack trace" }, 1_000);
      const { send } = await openPanel();
      await send({ type: "flow:openOutput", id: "f1", edgeId: "e1" });
      expect(workspace.openTextDocument).toHaveBeenCalledWith({
        content: `# errored · run · e1 · ${WHEN}\n\nstack trace`, language: "plaintext",
      });
    });

    it("shows the LATEST run's output, not an earlier one, when a Reset separates two runs", async () => {
      setConfig({ orchestrator: true });
      seedJournal("f1", { kind: "fired", edge: "e1", from: "a", to: "z", action: "run", note: "", output: "old run" }, 1_000);
      seedJournal("f1", { kind: "reset", edge: "e1" }, 1_001);
      seedJournal("f1", { kind: "errored", edge: "e1", from: "a", to: "z", action: "run", error: "boom", output: "new run" }, 1_002);
      const { send } = await openPanel();
      await send({ type: "flow:openOutput", id: "f1", edgeId: "e1" });
      expect(workspace.openTextDocument).toHaveBeenCalledWith({
        content: `# errored · run · e1 · ${WHEN}\n\nnew run`, language: "plaintext",
      });
    });

    it("toasts honestly when nothing has been journaled for this workflow, admitting a read failure reads the same", async () => {
      // `nodeJournalIo().readFile` swallows an unreadable file to `null`
      // exactly like a missing one — `JournalIo`'s own contract — so an
      // EACCES journal and an empty one both land here. The message must not
      // claim more certainty than the code actually has.
      setConfig({ orchestrator: true });
      const { p, send } = await openPanel();
      await send({ type: "flow:openOutput", id: "f1", edgeId: "e1" });
      expect(workspace.openTextDocument).not.toHaveBeenCalled();
      const toast = posts(p).find((m) => m.type === "toast");
      expect(toast).toMatchObject({ level: "info" });
      expect(toast.message).toMatch(/nothing.*recorded/i);
      expect(toast.message).toMatch(/could not be read/i);
    });

    it("toasts honestly when this step hasn't run yet, distinct from nothing journaled at all", async () => {
      setConfig({ orchestrator: true });
      // The journal is not empty — a SIBLING edge fired — but e1 itself never has.
      seedJournal("f1", { kind: "fired", edge: "e2", from: "a", to: "z", action: "run", note: "", output: "sibling output" }, 1_000);
      const { p, send } = await openPanel();
      await send({ type: "flow:openOutput", id: "f1", edgeId: "e1" });
      expect(workspace.openTextDocument).not.toHaveBeenCalled();
      const toast = posts(p).find((m) => m.type === "toast");
      expect(toast.message).toMatch(/hasn't run yet/i);
    });

    it("toasts honestly when the run captured no output, distinct from never having run", async () => {
      setConfig({ orchestrator: true });
      seedJournal("f1", { kind: "fired", edge: "e1", from: "a", to: "z", action: "run", note: "" }, 1_000);
      const { p, send } = await openPanel();
      await send({ type: "flow:openOutput", id: "f1", edgeId: "e1" });
      expect(workspace.openTextDocument).not.toHaveBeenCalled();
      const toast = posts(p).find((m) => m.type === "toast");
      expect(toast.message).toMatch(/no output was recorded/i);
    });

    it("toasts an ERROR, distinct from the three info refusals, when the journal itself cannot be read", async () => {
      // `readJournal` never throws for a missing or unreadable FILE — see
      // `JournalIo`'s own doc comment — so the one path left that can throw is
      // `journalPath` rejecting a flow id that fails `VALID_FLOW_ID`. Every
      // other id this suite sends comes off disk; this one is deliberately
      // shaped like something a webview payload could carry that no reader
      // upstream has validated yet.
      setConfig({ orchestrator: true });
      const { p, send } = await openPanel();
      await send({ type: "flow:openOutput", id: "../evil", edgeId: "e1" });
      expect(workspace.openTextDocument).not.toHaveBeenCalled();
      const toast = posts(p).find((m) => m.type === "toast");
      expect(toast).toMatchObject({ level: "error" });
      expect(toast.message).toMatch(/couldn't read this workflow's journal/i);
    });

    it("does nothing when the orchestrator setting is off", async () => {
      setConfig({ orchestrator: false });
      seedJournal("f1", { kind: "fired", edge: "e1", from: "a", to: "z", action: "run", note: "", output: "deployed ok" }, 1_000);
      const { send } = await openPanel();
      await send({ type: "flow:openOutput", id: "f1", edgeId: "e1" });
      expect(workspace.openTextDocument).not.toHaveBeenCalled();
    });

    it("emits flow_action open_output only once the editor actually opened", async () => {
      setConfig({ orchestrator: true });
      seedJournal("f1", { kind: "fired", edge: "e1", from: "a", to: "z", action: "run", note: "", output: "deployed ok" }, 1_000);
      const { send } = await openPanel();
      trackSpy.mockClear();
      await send({ type: "flow:openOutput", id: "f1", edgeId: "e1" });
      const flowActions = trackSpy.mock.calls.flat().filter((e: any) => e.name === "flow_action");
      expect(flowActions.map((e: any) => e.action)).toEqual(["open_output"]);
    });

    it("emits nothing for a refusal — no editor opened, nothing to report", async () => {
      setConfig({ orchestrator: true });
      const { send } = await openPanel();
      trackSpy.mockClear();
      await send({ type: "flow:openOutput", id: "f1", edgeId: "e1" });
      const flowActions = trackSpy.mock.calls.flat().filter((e: any) => e.name === "flow_action");
      expect(flowActions).toEqual([]);
    });

    it("never writes anything — a read, not a mutation", async () => {
      setConfig({ orchestrator: true });
      seedJournal("f1", { kind: "fired", edge: "e1", from: "a", to: "z", action: "run", note: "", output: "deployed ok" }, 1_000);
      const linesBefore = h.journalLines.length;
      const { send } = await openPanel();
      await send({ type: "flow:openOutput", id: "f1", edgeId: "e1" });
      expect(h.writeFlow).not.toHaveBeenCalled();
      expect(h.journalLines).toHaveLength(linesBefore);
    });
  });

  it("flow:save preserves the host's own firedAt when the drawer's copy is stale", async () => {
    // The hazard: the host stamped e1 during a poll; the drawer still holds the
    // pre-stamp flow and saves a node move. Writing its copy verbatim would clear
    // the latch and re-fire a rule that already ran.
    setConfig({ orchestrator: true });
    h.flows = [{
      ...mkFlow("f1", "n"),
      edges: [{ id: "e1", from: "a", to: "z", cond: { kind: "pr-merged" }, action: "notify", firedAt: 5, firedNote: "told you" }],
    }];
    const stale: Flow = {
      ...mkFlow("f1", "n"),
      nodes: [{ id: "n1", kind: "place", x: 99, y: 99, join: "any", runKey: "PROJ-1", repo: "r" }],
      edges: [{ id: "e1", from: "a", to: "z", cond: { kind: "pr-merged" }, action: "notify" }],
    };
    const { send } = await openPanel();
    await send({ type: "flow:save", flow: stale });
    const w = h.writeFlow.mock.calls.at(-1)![2] as Flow;
    expect(w.edges[0].firedAt).toBe(5);
    expect(w.edges[0].firedNote).toBe("told you");
    // The drawer's actual edit still lands.
    expect(w.nodes[0].x).toBe(99);
  });

  it("flow:save keeps an error the host recorded", async () => {
    setConfig({ orchestrator: true });
    h.flows = [{
      ...mkFlow("f1", "n"),
      edges: [{ id: "e1", from: "a", to: "z", cond: { kind: "pr-merged" }, action: "notify", error: "worktree exists" }],
    }];
    const stale: Flow = {
      ...mkFlow("f1", "n"),
      edges: [{ id: "e1", from: "a", to: "z", cond: { kind: "pr-merged" }, action: "notify" }],
    };
    const { send } = await openPanel();
    await send({ type: "flow:save", flow: stale });
    expect((h.writeFlow.mock.calls.at(-1)![2] as Flow).edges[0].error).toBe("worktree exists");
  });

  it("flow:save does not resurrect host fields for an edge the drawer deleted", async () => {
    setConfig({ orchestrator: true });
    h.flows = [{
      ...mkFlow("f1", "n"),
      edges: [{ id: "e1", from: "a", to: "z", cond: { kind: "pr-merged" }, action: "notify", firedAt: 5 }],
    }];
    const { send } = await openPanel();
    await send({ type: "flow:save", flow: { ...mkFlow("f1", "n"), edges: [] } });
    expect((h.writeFlow.mock.calls.at(-1)![2] as Flow).edges).toEqual([]);
  });

  it("flow:save lets the drawer's condition edit win over the host's copy", async () => {
    // Only the three host-owned fields are preserved. Everything else is the
    // drawer's to change.
    setConfig({ orchestrator: true });
    h.flows = [{
      ...mkFlow("f1", "n"),
      edges: [{ id: "e1", from: "a", to: "z", cond: { kind: "pr-merged" }, action: "notify", firedAt: 5 }],
    }];
    const edited: Flow = {
      ...mkFlow("f1", "n"),
      edges: [{ id: "e1", from: "a", to: "z", cond: { kind: "ci-failed" }, action: "notify" }],
    };
    const { send } = await openPanel();
    await send({ type: "flow:save", flow: edited });
    const w = h.writeFlow.mock.calls.at(-1)![2] as Flow;
    expect(w.edges[0].cond).toEqual({ kind: "ci-failed" });
    expect(w.edges[0].firedAt).toBe(5);
  });

  it("flow:save cannot re-arm a disarmed flow", async () => {
    // `armed` is a HOST-owned flow field: only flow:arm and flow:resumeDisarm write
    // it. A save built from a `flow` prop captured before a `deck:flows` post landed
    // carries a stale value, and writing it verbatim silently re-arms the flow.
    setConfig({ orchestrator: true });
    h.flows = [{ ...mkFlow("f1", "n"), armed: false }];
    const stale: Flow = {
      ...mkFlow("f1", "n"),
      armed: true,
      nodes: [{ id: "n1", kind: "place", x: 12, y: 12, join: "any", runKey: "PROJ-1", repo: "r" }],
    };
    const { send } = await openPanel();
    await send({ type: "flow:save", flow: stale });
    const w = h.writeFlow.mock.calls.at(-1)![2] as Flow;
    expect(w.armed).toBe(false);
    // The drawer's actual graph edit still lands — this preserves a field, it does
    // not reject the save.
    expect(w.nodes).toHaveLength(1);
  });

  it("flow:save cannot drop either consent stamp", async () => {
    // Both confirmations are HOST-owned flow fields written only by
    // `askFirstSpend`'s answer. A save built from a `flow` prop captured before
    // either landed carries `undefined` for it, and writing that verbatim un-asks a
    // question the user already answered — so the next met rule asks again, on a
    // flow that is running unattended precisely because it was approved.
    setConfig({ orchestrator: true });
    h.flows = [{ ...mkFlow("f1", "n"), launchConfirmedAt: 111, commandConfirmedAt: 222 }];
    const { send } = await openPanel();
    await send({ type: "flow:save", flow: { ...mkFlow("f1", "n"), nodes: [{ id: "n1", kind: "place", x: 3, y: 4, join: "any", runKey: "PROJ-1", repo: "r" }] } });
    const w = h.writeFlow.mock.calls.at(-1)![2] as Flow;
    expect(w.launchConfirmedAt).toBe(111);
    expect(w.commandConfirmedAt).toBe(222);
    expect(w.nodes).toHaveLength(1); // the graph edit itself still lands
  });

  it("flow:save keeps the template a workflow came from", async () => {
    // `fromTemplate` is HOST-written (by `instantiate`, once) and HOST-read: the
    // Templates tab's "on N cards" count is a lookup over it. A save carrying
    // `undefined` for it would silently drop a workflow out of its own
    // template's count. It survives today only because every `with*` transform
    // in the drawer spreads the whole flow object; one reconstruction that did
    // not, and the count goes quietly wrong.
    setConfig({ orchestrator: true });
    h.flows = [{ ...mkFlow("f1", "n"), fromTemplate: "k1" }];
    const { send } = await openPanel();
    await send({ type: "flow:save", flow: { ...mkFlow("f1", "n"), nodes: [{ id: "n1", kind: "place", x: 3, y: 4, join: "any", runKey: "PROJ-1", repo: "r" }] } });
    const w = h.writeFlow.mock.calls.at(-1)![2] as Flow;
    expect(w.fromTemplate).toBe("k1");
    expect(w.nodes).toHaveLength(1); // the graph edit itself still lands
  });

  it("flow:save cannot invent a template origin the host never recorded", async () => {
    // The other direction: a hand-drawn workflow must not be able to claim it
    // came from a template and inflate that template's "on N cards" count.
    setConfig({ orchestrator: true });
    h.flows = [{ ...mkFlow("f1", "n") }];
    const { send } = await openPanel();
    await send({ type: "flow:save", flow: { ...mkFlow("f1", "n"), fromTemplate: "k1" } });
    expect((h.writeFlow.mock.calls.at(-1)![2] as Flow).fromTemplate).toBeUndefined();
  });

  it("flow:save cannot invent a consent the host never recorded", async () => {
    // The other direction, and the one that matters more: the drawer must not be
    // able to hand the host a `commandConfirmedAt` and thereby authorise shell
    // execution that was never approved in a modal.
    setConfig({ orchestrator: true });
    h.flows = [{ ...mkFlow("f1", "n") }];
    const { send } = await openPanel();
    await send({ type: "flow:save", flow: { ...mkFlow("f1", "n"), launchConfirmedAt: 999, commandConfirmedAt: 999 } });
    const w = h.writeFlow.mock.calls.at(-1)![2] as Flow;
    expect(w.launchConfirmedAt).toBeUndefined();
    expect(w.commandConfirmedAt).toBeUndefined();
  });

  it("flow:save cannot disarm an armed one either", async () => {
    // The other direction of the same branch. A save is not a consent point in
    // either direction; Arm is.
    setConfig({ orchestrator: true });
    h.flows = [{ ...mkFlow("f1", "n"), armed: true }];
    const { send } = await openPanel();
    await send({ type: "flow:save", flow: { ...mkFlow("f1", "n"), armed: false } });
    expect((h.writeFlow.mock.calls.at(-1)![2] as Flow).armed).toBe(true);
  });

  it("a save queued before Disarm cannot re-arm the flow with the resume gate already cleared", async () => {
    // The worst case this preserves against, end to end. Disarm in the resume
    // banner ALSO clears the gate (resumeCleared), so a stale save that puts
    // `armed: true` back leaves the flow armed and ungated — it fires on the very
    // next poll, which is precisely what the user just refused.
    setConfig({ orchestrator: true });
    const shape: Flow = {
      ...mkFlow("f1", "Ship the migration"),
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
        { id: "n2", kind: "notify", x: 0, y: 0, join: "any", message: "the migration has landed" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" }],
    };
    h.flows = [{ ...shape, armed: true }];
    h.buildRunStatus.mockReturnValue(mergedStatus("PROJ-1", "aws-ops"));
    const { send } = await openPanel();
    await settle();
    await send({ type: "flow:resumeDisarm", id: "f1" });
    // The drawer's copy still says armed — it was captured before the disarm.
    await send({ type: "flow:save", flow: { ...shape, armed: true } });
    expect((h.writeFlow.mock.calls.at(-1)![2] as Flow).armed).toBe(false);
    h.writeFlow.mockClear();
    // And a genuine subsequent poll fires nothing, rather than acting on the gate
    // the disarm cleared.
    await send({ type: "deck:refresh" });
    expect(h.writeFlow).not.toHaveBeenCalled();
  });

  it("flow:save cannot rename a flow or rewrite its createdAt", async () => {
    // flow:rename owns the name; createdAt is the store's sort key. Neither is the
    // drawer's to overwrite on a node drag.
    setConfig({ orchestrator: true });
    h.flows = [{ ...mkFlow("f1", "Ship the migration"), createdAt: 1_234 }];
    const stale: Flow = {
      ...mkFlow("f1", "clobbered"),
      createdAt: 9_999,
      nodes: [{ id: "n1", kind: "place", x: 48, y: 48, join: "any", runKey: "PROJ-1", repo: "r" }],
    };
    const { send } = await openPanel();
    await send({ type: "flow:save", flow: stale });
    const w = h.writeFlow.mock.calls.at(-1)![2] as Flow;
    expect(w.name).toBe("Ship the migration");
    expect(w.createdAt).toBe(1_234);
    expect(w.nodes[0].x).toBe(48);
  });

  it("flow:save cannot drop launchConfirmedAt — the host owns it too", async () => {
    // The host writes `launchConfirmedAt` when the user answers the once-per-flow
    // spend question (`askFirstSpend`). A save built from a `flow` prop captured
    // before that write landed holds `undefined` for it — writing that verbatim
    // would silently un-ask the question, and the very next met launch rule would
    // pop the modal again for a flow the user already confirmed.
    setConfig({ orchestrator: true });
    h.flows = [{ ...mkFlow("f1", "Ship the migration"), launchConfirmedAt: 500 }];
    const stale: Flow = {
      ...mkFlow("f1", "Ship the migration"),
      nodes: [{ id: "n1", kind: "place", x: 48, y: 48, join: "any", runKey: "PROJ-1", repo: "r" }],
    };
    const { send } = await openPanel();
    await send({ type: "flow:save", flow: stale });
    const w = h.writeFlow.mock.calls.at(-1)![2] as Flow;
    expect(w.launchConfirmedAt).toBe(500);
    expect(w.nodes[0].x).toBe(48);
  });

  it("flow:save writes a brand-new edge through untouched, alongside preserving an existing one's host fields", async () => {
    // The merge's other branch: `mine.get(e.id)` misses for an edge the drawer
    // just drew, since the host has never seen it. That edge must land exactly
    // as the drawer sent it — no firedAt/firedNote/error appear from nowhere —
    // while a pre-existing edge in the SAME save still gets its host fields
    // preserved. Asserting both in one test is what proves the two branches
    // (host has this edge / host does not) are actually distinguished, rather
    // than both happening to produce the right answer by accident.
    setConfig({ orchestrator: true });
    h.flows = [{
      ...mkFlow("f1", "n"),
      edges: [{ id: "e1", from: "a", to: "z", cond: { kind: "pr-merged" }, action: "notify", firedAt: 5, firedNote: "told you" }],
    }];
    const withNewEdge: Flow = {
      ...mkFlow("f1", "n"),
      edges: [
        { id: "e1", from: "a", to: "z", cond: { kind: "pr-merged" }, action: "notify" },
        { id: "e2", from: "a", to: "y", cond: { kind: "ci-passed" }, action: "notify" },
      ],
    };
    const { send } = await openPanel();
    await send({ type: "flow:save", flow: withNewEdge });
    const w = h.writeFlow.mock.calls.at(-1)![2] as Flow;
    const e1 = w.edges.find((e) => e.id === "e1")!;
    const e2 = w.edges.find((e) => e.id === "e2")!;
    expect(e1.firedAt).toBe(5);
    expect(e1.firedNote).toBe("told you");
    // The new edge has no host counterpart — it must arrive exactly as the
    // drawer sent it, not stamped with anything the host never wrote.
    expect(e2.firedAt).toBeUndefined();
    expect(e2.firedNote).toBeUndefined();
    expect(e2.error).toBeUndefined();
    expect(e2.cond).toEqual({ kind: "ci-passed" });
  });
});

describe("the poll and the close confirmation", () => {
  // A 6s interval never fires under real timers within a test's lifetime, so
  // this describe alone runs on fake ones — the rest of the file depends on
  // real timers (e.g. `settled()`'s macrotask wait), so this must not be global.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Advance fake time AND drain whatever microtasks that unblocks — `settled()`
   * (a real setTimeout) cannot be used here since fake timers intercept it too. */
  const settle = async (ms = 0) => {
    await vi.advanceTimersByTimeAsync(ms);
  };

  /** Open a panel and return it plus a way to deliver an inbound message — the
   * same shape every other describe block's own `openPanel` uses, adapted to
   * this describe's fake-timer-safe `settle`. */
  const openPanel = async () => {
    show();
    await settle();
    const p = lastPanel();
    return { p, send: async (m: unknown) => { await p._fire(m); await settle(); } };
  };

  const armed = (): Flow => ({ ...mkFlow("f1", "Ship the migration"), armed: true });

  it("keeps polling when the panel is hidden and a flow is armed", async () => {
    setConfig({ orchestrator: true });
    h.flows = [armed()];
    const { p } = await openPanel();
    const before = h.buildRunStatus.mock.calls.length;
    p.visible = false;
    p._fireViewState();
    await settle(POLL_MS + 1);
    expect(h.buildRunStatus.mock.calls.length).toBeGreaterThan(before);
  });

  it("stops polling when hidden with nothing armed", async () => {
    setConfig({ orchestrator: true });
    h.flows = [mkFlow("f1", "n")];
    const { p } = await openPanel();
    const before = h.buildRunStatus.mock.calls.length;
    p.visible = false;
    p._fireViewState();
    await settle(POLL_MS + 1);
    expect(h.buildRunStatus.mock.calls.length).toBe(before);
  });

  it("says so when the panel closes with a flow armed", async () => {
    setConfig({ orchestrator: true });
    h.flows = [armed()];
    const { p } = await openPanel();
    p._fireDispose();
    await settle();
    expect(window.showWarningMessage).toHaveBeenCalled();
  });

  it("says nothing when the panel closes with nothing armed", async () => {
    setConfig({ orchestrator: true });
    h.flows = [mkFlow("f1", "n")];
    const { p } = await openPanel();
    p._fireDispose();
    await settle();
    expect(window.showWarningMessage).not.toHaveBeenCalled();
  });

  it("reopens the Deck when the user answers the close notice", async () => {
    setConfig({ orchestrator: true });
    h.flows = [armed()];
    (window.showWarningMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Reopen the Deck");
    const { p } = await openPanel();
    p._fireDispose();
    await settle();
    expect(commands.executeCommand).toHaveBeenCalledWith("agentFlow.openDeck");
  });

  // Task 5 fix round 1: sweepTargets() must cover a local card, not just tracked
  // runs — a local card has no record in `readRuns`, only in the in-memory
  // `localRuns` map the status build itself populates. Pins the coverage at the
  // observable seam (a local run's own posted `usage`) rather than reaching into
  // the private `sweepTargets`/`sweepUsage` methods.
  it("keeps the usage sweep covering a local run, not just tracked ones", async () => {
    h.runs = [];
    h.openSessions = [sess({ cwd: "/r/webapp", name: "webapp-7e" })];
    const { p } = await openPanel();
    // The panel's construction already ran one sweep (before this local card
    // existed) and one buildAll (which just minted it) — from here, only the
    // usage timer's own cadence sweeps again, and only then does the local
    // card's key exist for the reader to be called with.
    h.usageReadRun.mockReturnValueOnce({ input: 3, output: 7, cacheWrite: 0, cacheRead: 1 });
    await settle(USAGE_POLL_MS + 1);
    // The sweep updates `usageByRun` in memory; a fresh build is what actually
    // reads it back onto a `RunStatus` for the webview.
    await p._fire({ type: "deck:refresh" });
    await settle();
    const local = lastRunsPost().runs.find((r: RunStatus) => r.run.kind === "local");
    expect(local?.usage).toEqual({ input: 3, output: 7, cacheWrite: 0, cacheRead: 1 });
  });

  // The board-wide sweep exists only to feed the header total, which ships off. With
  // it off nothing on screen shows a board-wide figure, so parsing every run's
  // transcripts every minute would be pure cost — the drawer reads its one run on
  // demand instead. This is the test that makes "off by default" mean "costs
  // nothing by default" rather than merely "displays nothing by default".
  it("never sweeps the board when the token total is switched off", async () => {
    h.showTokenTotal = false;
    await openPanel();
    h.usageReadRun.mockClear();
    await settle(USAGE_POLL_MS * 2 + 1);
    expect(h.usageReadRun).not.toHaveBeenCalled();
  });

  it("still sweeps the board when the token total is switched on", async () => {
    h.showTokenTotal = true;
    await openPanel();
    h.usageReadRun.mockClear();
    await settle(USAGE_POLL_MS + 1);
    expect(h.usageReadRun).toHaveBeenCalled();
  });

  // The drawer's own path, and the only transcript read a default install performs.
  it("answers deck:usageFor with that run's usage", async () => {
    const { p } = await openPanel();
    h.usageReadRun.mockClear().mockReturnValueOnce({ input: 1, output: 2, cacheWrite: 3, cacheRead: 4 });
    await p._fire({ type: "deck:usageFor", key: mkRun().key });
    await settle();
    const post = posts(lastPanel()).filter((m) => m.type === "deck:usage").at(-1);
    expect(post).toEqual({ type: "deck:usage", key: mkRun().key, usage: { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 } });
  });

  // null, not a zeroed total: the drawer distinguishes "could not read" from "cost
  // nothing", and a zero would assert the latter.
  it("answers deck:usageFor with null when the read throws", async () => {
    const { p } = await openPanel();
    h.usageReadRun.mockClear().mockImplementationOnce(() => { throw new Error("EACCES"); });
    await p._fire({ type: "deck:usageFor", key: mkRun().key });
    await settle();
    const post = posts(lastPanel()).filter((m) => m.type === "deck:usage").at(-1);
    expect(post).toEqual({ type: "deck:usage", key: mkRun().key, usage: null });
  });

  it("answers deck:usageFor even with the board sweep off — the drawer is its own path", async () => {
    h.showTokenTotal = false;
    const { p } = await openPanel();
    h.usageReadRun.mockClear().mockReturnValueOnce({ input: 0, output: 5, cacheWrite: 0, cacheRead: 0 });
    await p._fire({ type: "deck:usageFor", key: mkRun().key });
    await settle();
    const post = posts(lastPanel()).filter((m) => m.type === "deck:usage").at(-1);
    expect(post).toMatchObject({ type: "deck:usage", usage: { output: 5 } });
  });
});

// The branch-CI condition (Task 8) is the only one whose fact does not come out of
// a `RunStatus`: it names a repo and a branch, and the verdict is fetched with `gh`
// here, host-side, because `conditions.ts` is bundled into the webview and cannot
// spawn anything. What these cases pin is the FETCH — its argv and cwd, how often it
// runs, and that nothing it cannot read ever reads as green.
describe("branch-CI verdicts for an armed flow", () => {
  const REPO = "aws-ops";
  const branchRule = (id: string, branch: string, repo = REPO): FlowEdge => ({
    id, from: "n1", to: `z-${id}`,
    cond: { kind: "branch-ci-passed", repo, branch },
    action: "notify",
  });

  /** An armed flow whose rules all wait on a branch. One notify terminal per rule,
   * so a met rule settles without spending anything. */
  const branchFlow = (...edges: FlowEdge[]): Flow => ({
    ...mkFlow("f1", "Deploy to staging"),
    armed: true,
    nodes: [
      { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: REPO },
      ...edges.map((e) => ({ id: e.to, kind: "notify" as const, x: 0, y: 0, join: "any" as const, message: `${e.id} fired` })),
    ],
    edges,
  });

  /** Three passes, because the fetch is deliberately out of band: pass 1 cannot even
   * enqueue (the one-time `gh auth status` probe cannot settle inside the tick that
   * starts it — see `showAndWarm`), pass 2 enqueues, pass 3 reads the verdict. The
   * cost of not awaiting `gh` under the flows lock is exactly this one-poll delay,
   * and it is safe only because an unfetched verdict is not green. */
  const passes = async (n: number, statuses?: () => void) => {
    setConfig({ orchestrator: true });
    if (statuses) statuses();
    else h.buildRunStatus.mockReturnValue(openStatus("PROJ-1", REPO));
    const log = vi.fn();
    DeckPanel.show(fakeContext().context as any, fakeConnector(), log);
    await settled();
    await settle();
    for (let i = 1; i < n; i++) {
      await lastPanel()._fire({ type: "deck:refresh" });
      await settled();
      await settle();
    }
    return { p: lastPanel(), log };
  };

  /** More polls on the panel `passes` already opened. */
  const poll = async (n: number) => {
    for (let i = 0; i < n; i++) {
      await lastPanel()._fire({ type: "deck:refresh" });
      await settled();
      await settle();
    }
  };

  /** The same status, for a checkout at a different path — a worktree of the repo, or
   * a second, unrelated repo that happens to share its basename. Derived from
   * `prStatus` rather than hand-built, so only the path differs. */
  const atPath = (s: RunStatus, p: string): RunStatus => ({ ...s, repos: s.repos.map((r) => ({ ...r, path: p })) });

  /** The flow as it was last written to the store, or undefined if it never was. */
  const lastWritten = (): Flow | undefined => h.writeFlow.mock.calls.at(-1)?.[2] as Flow | undefined;
  const firedIds = (): string[] =>
    (lastWritten()?.edges ?? []).filter((e) => e.firedAt !== undefined).map((e) => e.id);

  it("fetches once per distinct repo and branch, not once per rule", async () => {
    // Ten rules on master. One `gh` call — the whole point of caching by
    // `repo#branch` rather than fetching per node.
    h.flows = [branchFlow(...Array.from({ length: 10 }, (_, i) => branchRule(`e${i}`, "master")))];
    await passes(3);
    const branchCalls = h.ghRun.mock.calls.filter((c) => c[1].includes("graphql"));
    expect(branchCalls).toHaveLength(1);
    const [file, args, opts] = branchCalls[0];
    // Located, not the bare name — the extension host can inherit launchd's bare
    // PATH, under which a Homebrew `gh` is invisible.
    expect(file).toMatch(/gh$/);
    expect(args).toEqual(BRANCH_CI_ARGS("master"));
    // Asked from a checkout of that repo, because gh reads owner/name off its remote.
    expect(opts).toEqual({ cwd: `/r/${REPO}`, timeoutMs: GH_TIMEOUT_MS });
  });

  it("fetches each branch of the same repo separately", async () => {
    h.flows = [branchFlow(branchRule("e1", "master"), branchRule("e2", "release"))];
    await passes(3);
    const branches = h.ghRun.mock.calls
      .filter((c) => c[1].includes("graphql"))
      .map((c) => c[1].find((a: string) => a.startsWith("branch=")));
    expect(branches.sort()).toEqual(["branch=master", "branch=release"]);
  });

  it("fires the rule once the branch reads as passed", async () => {
    h.flows = [branchFlow(branchRule("e1", "master"))];
    await passes(3);
    expect(firedIds()).toEqual(["e1"]);
  });

  // Task 8 left the verdicts host-only, so the drawer's own "what is this rule
  // waiting on" line read "not checked yet" forever — even for a branch this panel
  // had just measured as PENDING. They ride `deck:flows` because `postFlows` runs
  // AFTER the pass that reads them, unlike the `deck:runs` post.
  it("posts the branch-CI verdicts it has fetched, so the drawer can say what a rule is waiting on", async () => {
    h.ghRun.mockResolvedValue(
      JSON.stringify({ data: { repository: { ref: { target: { statusCheckRollup: { state: "PENDING" } } } } } }),
    );
    h.flows = [branchFlow(branchRule("e1", "master"))];
    const { p } = await passes(3);
    const msg = posts(p).filter((m) => m.type === "deck:flows").at(-1) as {
      branchCi: Record<string, string>;
    };
    // Keyed by the engine's own key function, not a hand-spelled string.
    expect(msg.branchCi).toEqual({ [branchCiKey(REPO, "master")]: "pending" });
  });

  it("stops posting a verdict once PR facts are switched off", async () => {
    // The webview must not show a verdict the engine would refuse to act on, or
    // the drawer claims a branch is green while `branchCiFor` reads it as unknown.
    // What actually enforces it here is `onConfigChanged` clearing the cache —
    // `postFlows`'s own `ghReady()` gate mirrors the serve-side rule but has no
    // independently reachable case (see its comment there). This pins the
    // OUTCOME, which is the part a user can see. Measured, so the redundancy is
    // stated rather than assumed: removing EITHER mechanism alone still leaves
    // this green, and removing BOTH makes it fail with the stale
    // `{ "<repo>#master": "passed" }` a user would otherwise have been shown.
    h.ghRun.mockResolvedValue(
      JSON.stringify({ data: { repository: { ref: { target: { statusCheckRollup: { state: "SUCCESS" } } } } } }),
    );
    h.flows = [branchFlow(branchRule("e1", "master"))];
    const { p } = await passes(3);
    expect(Object.keys((posts(p).filter((m) => m.type === "deck:flows").at(-1) as {
      branchCi: Record<string, string>;
    }).branchCi)).toEqual([branchCiKey(REPO, "master")]);
    // Switched off the way the panel actually learns about it: it seeds `prFacts`
    // from config once and holds it, so a bare `h.prFacts = false` would not reach
    // the panel at all (see `onConfigChanged`'s own comment in deckView.ts).
    h.prFacts = false;
    setConfig({ prFacts: false });
    fireConfigurationChanged("agentFlow.prFacts");
    await settled();
    await poll(1);
    expect((posts(p).filter((m) => m.type === "deck:flows").at(-1) as {
      branchCi: Record<string, string>;
    }).branchCi).toEqual({});
  });

  it("never fires when the gh call fails — an unreadable branch is not a green one", async () => {
    // The worst outcome this feature can produce is a deploy triggered by a failed
    // API call. A rejected fetch must leave the rule exactly where it was.
    h.ghRun.mockRejectedValue(new Error("gh: API rate limit exceeded"));
    h.flows = [branchFlow(branchRule("e1", "master"))];
    const { log } = await passes(4);
    expect(firedIds()).toEqual([]);
    // Said out loud in the log, because an unfired rule looks like patience and
    // nothing in the UI distinguishes "not green yet" from "could not be read".
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`branch CI ${REPO}#master unreadable`));
  });

  it("never fires on a failing or still-running branch", async () => {
    for (const state of ["FAILURE", "PENDING", "EXPECTED", "NONSENSE"]) {
      h.writeFlow.mockClear();
      h.ghRun.mockClear().mockResolvedValue(
        JSON.stringify({ data: { repository: { ref: { target: { statusCheckRollup: { state } } } } } }),
      );
      h.flows = [branchFlow(branchRule("e1", "master"))];
      await passes(4);
      expect(firedIds()).toEqual([]);
    }
  });

  it("does not re-fetch inside the TTL, and does again once past it", async () => {
    // A branch whose CI is still running, so the rule keeps WAITING for every poll
    // in this test: a rule that fired would settle and stop being fetched for, which
    // would make "one call" true for a reason that has nothing to do with the cache.
    const pending = JSON.stringify({ data: { repository: { ref: { target: { statusCheckRollup: { state: "PENDING" } } } } } });
    h.ghRun.mockResolvedValue(pending);

    // Four polls, one fetch: the entry is minutes fresh, and a rule that keeps
    // waiting must not keep paying for the answer.
    h.ttlSeconds = 120;
    h.flows = [branchFlow(branchRule("e1", "master"))];
    await passes(4);
    expect(h.ghRun.mock.calls.filter((c) => c[1].includes("graphql"))).toHaveLength(1);

    // With no TTL at all, every poll re-fetches — proof the cache is consulted
    // through the staleness rule rather than filled once and trusted forever.
    h.ghRun.mockClear();
    h.ttlSeconds = 0;
    h.flows = [branchFlow(branchRule("e1", "master"))];
    await passes(4);
    expect(h.ghRun.mock.calls.filter((c) => c[1].includes("graphql")).length).toBeGreaterThan(1);
  });

  it("makes no call at all with PR facts off, and the rule stays unfired", async () => {
    // Same `gh` path, same toggle — which is why `armability.ts` reports a rule of
    // this kind as needing PR facts.
    h.prFacts = false;
    h.flows = [branchFlow(branchRule("e1", "master"))];
    await passes(4);
    expect(h.ghRun.mock.calls.filter((c) => c[1].includes("graphql"))).toHaveLength(0);
    expect(firedIds()).toEqual([]);
  });

  it("makes no call for a repo no run on the board has", async () => {
    // Nothing to run `gh` in, so the verdict stays absent — which reads as unknown,
    // which is not met.
    h.flows = [branchFlow(branchRule("e1", "master", "not-on-the-board"))];
    await passes(4);
    expect(h.ghRun.mock.calls.filter((c) => c[1].includes("graphql"))).toHaveLength(0);
    expect(firedIds()).toEqual([]);
  });

  it("drops a green verdict once a refetch fails, instead of gating on a stale pass", async () => {
    // The comment on that catch claims stamping `unknown` "stops a branch that was
    // green an hour ago from opening a deploy gate on the strength of a call that
    // failed since". Nothing pinned it: the rejection test above fails from the very
    // first call, so there is never a previous verdict to preserve, and a catch that
    // kept `prev.status` passed the whole suite.
    //
    // To watch a verdict be REPLACED, the rule has to keep waiting while the branch
    // is already green — so it hangs off an "all" junction whose sibling (`pr-merged`)
    // is still unmet. Nothing fires, nothing settles, and `ttlSeconds: 0` re-fetches
    // every poll.
    h.ttlSeconds = 0;
    const junction = (): Flow => ({
      ...mkFlow("f1", "Deploy to staging"),
      armed: true,
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: REPO },
        { id: "z", kind: "notify", x: 0, y: 0, join: "all", message: "shipped" },
      ],
      edges: [
        { id: "e1", from: "n1", to: "z", cond: { kind: "branch-ci-passed", repo: REPO, branch: "master" }, action: "notify" },
        { id: "e2", from: "n1", to: "z", cond: { kind: "pr-merged" }, action: "notify" },
      ],
    });
    h.flows = [junction()];
    // Green lands and is held by the junction, not fired.
    await passes(3);
    expect(firedIds()).toEqual([]);

    // The branch becomes unreadable while the sibling is STILL unmet, so the failed
    // refetch lands before anything can act on the old answer. (Order matters, and
    // the first draft of this test got it wrong: a pass serves the cached verdict and
    // only enqueues the refresh, so failing gh and merging the PR in the same tick
    // fires on the stale green quite correctly.)
    h.ghRun.mockRejectedValue(new Error("gh: API rate limit exceeded"));
    await poll(2);
    expect(firedIds()).toEqual([]);

    // Now the sibling arrives. A retained green verdict would close the junction
    // here; a dropped one cannot.
    h.buildRunStatus.mockReturnValue(mergedStatus("PROJ-1", REPO));
    await poll(3);
    expect(firedIds()).toEqual([]);

    // The control, and the whole proof this test is not passing for some unrelated
    // reason: the junction DOES close the moment the branch reads green again, from
    // the same panel, the same flow and the same sibling state.
    h.ghRun.mockResolvedValue(
      JSON.stringify({ data: { repository: { ref: { target: { statusCheckRollup: { state: "SUCCESS" } } } } } }),
    );
    await poll(3);
    expect(firedIds().sort()).toEqual(["e1", "e2"]);
  });

  it("asks a worktree of the repo like any other checkout — several paths for one name is normal", async () => {
    // Every task worktree Agent Flow creates carries the repo's NAME with the
    // worktree's PATH, so a board with two tasks on one repo has two `aws-ops`
    // entries. They share a remote, so either answers; refusing here would make this
    // condition unusable in the setup this product creates constantly.
    h.runs = [mkRun(), mkRun({ key: "PROJ-2" })];
    h.flows = [branchFlow(branchRule("e1", "master"))];
    await passes(3, () => {
      h.buildRunStatus.mockImplementation((i: { run: Run }) =>
        i.run.key === "PROJ-2"
          ? atPath(openStatus("PROJ-2", REPO), `/r/${REPO}/.claude/worktrees/PROJ-2`)
          : openStatus("PROJ-1", REPO));
    });
    expect(h.ghRun.mock.calls.filter((c) => c[1].includes("graphql"))).toHaveLength(1);
    expect(firedIds()).toEqual(["e1"]);
  });

  it("refuses to answer when two different repositories on the board share the name", async () => {
    // A local card's repo name is `path.basename` of the folder its session was found
    // in, so ~/work/api and ~/repos/api both present as "api". Answering a deploy gate
    // from the wrong remote — a fork's green master opening the gate for upstream — is
    // the mistake this condition's whole posture exists to prevent, so it refuses.
    h.runs = [mkRun(), mkRun({ key: "PROJ-2" })];
    h.flows = [branchFlow(branchRule("e1", "master"))];
    const { log } = await passes(4, () => {
      h.buildRunStatus.mockImplementation((i: { run: Run }) =>
        i.run.key === "PROJ-2"
          ? atPath(openStatus("PROJ-2", REPO), `/elsewhere/${REPO}`)
          : openStatus("PROJ-1", REPO));
    });
    expect(h.ghRun.mock.calls.filter((c) => c[1].includes("graphql"))).toHaveLength(0);
    expect(firedIds()).toEqual([]);
    // Named in the log, once — silence is how a rule that can never fire looks like
    // patience.
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`branch CI "${REPO}" is ambiguous`));
    expect(log.mock.calls.filter((c) => /is ambiguous/.test(String(c[0])))).toHaveLength(1);
  });

  it("makes no call for a settled rule or a disarmed flow", async () => {
    // Neither is waiting on anything; paying a round trip for them is pure cost.
    h.flows = [
      branchFlow({ ...branchRule("e1", "master"), firedAt: 1 }),
      { ...branchFlow(branchRule("e2", "release")), id: "f2", armed: false },
    ];
    await passes(3);
    expect(h.ghRun.mock.calls.filter((c) => c[1].includes("graphql"))).toHaveLength(0);
  });
});

// ── where a review opens (agentFlow.reviewOpenIn) ─────────────────────────────
// Every release up to now opened a new window on the review worktree. The setting
// defaults to that, so the tests above — which never set it — are the no-regression
// guard for the one-click launch. These cover the arms it can be turned to.
describe("DeckPanel review destination", () => {
  const HERE = { identity: "/repos/bite-me", kind: "folder" as const, roots: [{ path: "/repos/bite-me" }] };
  const launched = () => (h.launchReview.mock.calls[0]?.[0] as { openTarget?: Record<string, unknown> } | undefined);

  it("asks nothing and hands down no destination on a stock install", async () => {
    const p = await showAndWarm();
    await p._fire({ type: "deck:reviewLaunch", id: "CyberJackGit/aws-ops#8491" });
    expect(window.showQuickPick).not.toHaveBeenCalled();
    // Not merely "no picker": launchReview must be told nothing, so it takes the
    // new-window-on-the-worktree path every earlier release took.
    expect(launched()?.openTarget).toEqual({ mode: "per-window", openIn: "new" });
  });

  it("asks where to open when the setting says ask, and hands the answer down", async () => {
    setConfig({ reviewOpenIn: "ask" });
    h.currentWindow = HERE;
    window.showQuickPick.mockResolvedValueOnce({ target: { kind: "current" } });
    const p = await showAndWarm();
    await p._fire({ type: "deck:reviewLaunch", id: "CyberJackGit/aws-ops#8491" });
    expect(window.showQuickPick).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: "Review aws-ops#8491 — open where?" }),
    );
    expect(launched()?.openTarget).toEqual({ mode: "per-window", openIn: "current", currentWindow: HERE });
  });

  // The same ordering the mode picker already obeys, and for the same reason:
  // launchReview's first act is createWorktrees, so a question raised after it would
  // leave a worktree and a branch behind on every Escape.
  it("creates nothing when the destination picker is dismissed", async () => {
    setConfig({ reviewOpenIn: "ask" });
    window.showQuickPick.mockResolvedValueOnce(undefined);
    const p = await showAndWarm();
    const before = posts(p).length;
    await p._fire({ type: "deck:reviewLaunch", id: "CyberJackGit/aws-ops#8491" });
    expect(h.launchReview).not.toHaveBeenCalled();
    expect(posts(p).slice(before).some((m) => m.type === "toast")).toBe(false);
  });

  it("asks which mode first and where to open second, both before anything is created", async () => {
    setConfig({
      reviewOpenIn: "ask",
      reviewRequestModes: [
        { id: "backend", label: "Backend services", prompt: "BE {number}" },
        { id: "frontend", label: "Frontend", prompt: "FE {number}" },
      ],
    });
    window.showQuickPick
      .mockResolvedValueOnce({ label: "Frontend", mode: { id: "frontend", label: "Frontend", prompt: "FE {number}" } })
      .mockResolvedValueOnce({ target: { kind: "new" } });
    const p = await showAndWarm();
    await p._fire({ type: "deck:reviewLaunch", id: "CyberJackGit/aws-ops#8491" });
    expect(window.showQuickPick.mock.calls.map((c: unknown[]) => (c[1] as { title: string }).title)).toEqual([
      "Review aws-ops#8491",
      "Review aws-ops#8491 — open where?",
    ]);
    expect(launched()).toEqual(expect.objectContaining({ template: "FE {number}" }));
  });

  it("takes this window from the setting without asking", async () => {
    setConfig({ reviewOpenIn: "this-window" });
    h.currentWindow = HERE;
    const p = await showAndWarm();
    await p._fire({ type: "deck:reviewLaunch", id: "CyberJackGit/aws-ops#8491" });
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(launched()?.openTarget).toEqual({ mode: "per-window", openIn: "current", currentWindow: HERE });
  });

  it("falls back to a new window when this window can't hold a session", async () => {
    setConfig({ reviewOpenIn: "this-window" }); // h.currentWindow stays undefined
    const p = await showAndWarm();
    await p._fire({ type: "deck:reviewLaunch", id: "CyberJackGit/aws-ops#8491" });
    expect(launched()?.openTarget).toEqual({ mode: "per-window", openIn: "new" });
    expect(posts(p)).toContainEqual(
      expect.objectContaining({ type: "toast", level: "info", message: expect.stringContaining("can't hold a session") }),
    );
  });

  it("offers the windows already open, and focuses the one picked", async () => {
    setConfig({ reviewOpenIn: "ask" });
    h.liveWindows = [{ identity: "/repos/webapp", kind: "folder", label: "webapp", folders: 1 }];
    window.showQuickPick.mockImplementationOnce(async (items: unknown) => {
      const row = (items as { label: string }[]).find((i) => i.label.includes("webapp"));
      expect(row).toBeTruthy();
      return row;
    });
    const p = await showAndWarm();
    await p._fire({ type: "deck:reviewLaunch", id: "CyberJackGit/aws-ops#8491" });
    expect(launched()?.openTarget).toEqual({ mode: "per-window", openIn: "new", existingFolder: "/repos/webapp" });
  });

  it("says where the session landed when no window opened", async () => {
    setConfig({ reviewOpenIn: "this-window" });
    h.currentWindow = HERE;
    h.launchReview.mockResolvedValueOnce({
      ok: true, runKey: "review-aws-ops-8491", provider: "claude-code", seededInPlace: true,
    });
    const p = await showAndWarm();
    await p._fire({ type: "deck:reviewLaunch", id: "CyberJackGit/aws-ops#8491" });
    // Nothing opens on this path, so a toast that only says "in a worktree" reads as
    // though the click did nothing.
    expect(posts(p)).toContainEqual(
      expect.objectContaining({
        type: "toast", level: "success",
        message: expect.stringContaining("in this window"),
      }),
    );
  });

  it("does not claim this window for a launch that opened one", async () => {
    const p = await showAndWarm();
    await p._fire({ type: "deck:reviewLaunch", id: "CyberJackGit/aws-ops#8491" });
    const toast = posts(p).find((m) => m.type === "toast" && m.level === "success") as { message: string };
    expect(toast.message).not.toContain("in this window");
  });
});

describe("latestCandidates", () => {
  it("publishes its attention candidates for the host's badge tick", async () => {
    // The tick prefers these over gathering its own, so the badge and the column
    // are the same reduction over the same inputs rather than two guesses.
    show(true);
    await settled();
    const published = DeckPanel.latestCandidates();
    expect(published).not.toBeNull();
    expect(published!.at).toBeGreaterThan(0);
    expect(Array.isArray(published!.candidates)).toBe(true);
  });

  it("is null when no panel is open", () => {
    // Not "before any panel has ever run" — the top-level afterEach disposes
    // whatever panel a previous test opened, which is what actually makes this
    // pass. It would also catch a module-level cache that outlived its panel.
    expect(DeckPanel.latestCandidates()).toBeNull();
  });

  it("counts a local card in Action required, not just tracked runs", async () => {
    // Distinguishes the local-candidate push from its own absence: deleting it
    // leaves `published.candidates` a valid (empty) array, which the two tests
    // above cannot tell apart from this. A local card has no run record to
    // hold a mocked status by key, so the stub keys off `run.kind` instead.
    h.runs = [];
    h.openSessions = [sess({ cwd: "/r/webapp", name: "webapp-7e" })];
    h.buildRunStatus.mockReset().mockImplementation(
      (i: { run: Run; ticket: { category: string | null } | null }) =>
        i.run.kind === "local"
          ? { ...statusFor(i.run, i.ticket?.category ?? null), agent: { state: "blocked" as const, lastActivityMs: null, slug: null } }
          : statusFor(i.run, i.ticket?.category ?? null),
    );
    show(true);
    await settled();
    const published = DeckPanel.latestCandidates();
    expect(published?.candidates.length).toBe(1);
    const [local] = published!.candidates;
    expect(local.hasLiveSession).toBe(true);
    expect(local.agentState).toBe("blocked");
    expect(attentionKeys(published!.candidates)).toEqual([local.key]);
  });

  it("does not count a local card whose PR already merged, even though its agent state alone would need you", async () => {
    // Pins the direction of the sibling fix in attentionFs.ts's gatherer: a
    // local candidate has to carry its own real `prs`, not an empty map — an
    // empty map would hide the merge veto here exactly as it did there, and
    // this test would then wrongly see the key counted.
    const facts: PrFacts = {
      number: 1, url: "https://github.com/o/r/pull/1", title: "t", state: "MERGED", isDraft: false,
      ci: { passing: 1, pending: 0, failing: [] }, review: "none", unresolved: null,
      mergeable: "clean", ciAdvisory: false,
    };
    h.runs = [];
    h.openSessions = [sess({ cwd: "/r/webapp", name: "webapp-7e" })];
    h.buildRunStatus.mockReset().mockImplementation(
      (i: { run: Run; ticket: { category: string | null } | null }) =>
        i.run.kind === "local"
          ? {
              ...statusFor(i.run, i.ticket?.category ?? null),
              agent: { state: "blocked" as const, lastActivityMs: null, slug: null },
              prs: { webapp: { facts, fetchedAt: Date.now() } },
            }
          : statusFor(i.run, i.ticket?.category ?? null),
    );
    show(true);
    await settled();
    const published = DeckPanel.latestCandidates();
    expect(published?.candidates.length).toBe(1);
    const [local] = published!.candidates;
    expect(local.prs.webapp?.facts?.state).toBe("MERGED");
    expect(attentionKeys(published!.candidates)).toEqual([]);
  });
});

describe("latestCandidates: the tracked half", () => {
  // Every test in the suite above survives DELETING the tracked
  // `attentionCandidates.push` in buildAll: two assert only the published
  // shape, two clear `h.runs` so a local card is the only candidate there is.
  // What would ship is this feature's signature failure — with the Deck OPEN
  // the badge counts local cards only, and the number jumps the moment the
  // panel closes, because the host's own gatherer does count tracked runs.
  // Nothing pinned the pushed field VALUES either, so inverting hasWorkToLose
  // or justLaunched in that literal was invisible.
  const dirtyRepo = (over: Partial<RepoGit> = {}): RepoGit => ({
    name: "svc", path: "/r/svc", branch: "b", dirty: true, ahead: 0,
    added: 1, removed: 0, files: 1, ...over,
  });
  /** buildRunStatus, answering `blocked` with the repos a test hands it. */
  const needsYou = (repos: RepoGit[]) =>
    h.buildRunStatus.mockReset().mockImplementation(
      (i: { run: Run; ticket: { category: string | null } | null }) => ({
        ...statusFor(i.run, i.ticket?.category ?? null),
        agent: { state: "blocked" as const, lastActivityMs: null, slug: null },
        repos,
      }),
    );

  it("counts a tracked run that needs you, with the fields the shelf beside it was given", async () => {
    // showAll off and no session, no PR, and not just launched: `hasWorkToLose`
    // is the ONLY thing boarding this card, so `hasWorkToLose: false` in the
    // literal drops the key from attentionKeys as well as failing the field
    // assertion.
    h.inflightShowAll = false;
    h.runs = [mkRun({ key: "PROJ-7", createdAt: Date.now() - 60 * 60_000 })];
    h.openSessions = [];
    needsYou([dirtyRepo()]);
    show(true);
    await settled();
    const published = DeckPanel.latestCandidates();
    expect(published!.candidates.map((c) => c.key)).toContain("PROJ-7");
    expect(attentionKeys(published!.candidates)).toContain("PROJ-7");
    const c = published!.candidates.find((x) => x.key === "PROJ-7")!;
    expect({ hasWorkToLose: c.hasWorkToLose, justLaunched: c.justLaunched, showAll: c.showAll })
      .toEqual({ hasWorkToLose: true, justLaunched: false, showAll: false });
    expect(c.agentState).toBe("blocked");
  });

  it("marks a run launched moments ago as just launched, with nothing on disk to lose", async () => {
    // The other direction of the same pair: a clean, brand-new run is on the
    // board on the strength of `justLaunched` alone.
    h.inflightShowAll = false;
    h.runs = [mkRun({ key: "PROJ-8", createdAt: Date.now() })];
    h.openSessions = [];
    needsYou([dirtyRepo({ dirty: false, added: 0, files: 0 })]);
    show(true);
    await settled();
    const c = DeckPanel.latestCandidates()!.candidates.find((x) => x.key === "PROJ-8")!;
    expect({ hasWorkToLose: c.hasWorkToLose, justLaunched: c.justLaunched })
      .toEqual({ hasWorkToLose: false, justLaunched: true });
    expect(attentionKeys([c])).toEqual(["PROJ-8"]);
  });

  it("passes agentFlow.inflightShowAll through to the tracked candidate", async () => {
    // `h.inflightShowAll`, not setConfig: this suite's getConfig mock reads the
    // flag off the harness (see its `inflightShowAll: h.inflightShowAll`).
    h.inflightShowAll = true;
    h.runs = [mkRun({ key: "PROJ-9", createdAt: Date.now() - 60 * 60_000 })];
    h.openSessions = [];
    needsYou([dirtyRepo({ dirty: false, added: 0, files: 0 })]);
    show(true);
    await settled();
    expect(DeckPanel.latestCandidates()!.candidates.find((x) => x.key === "PROJ-9")!.showAll).toBe(true);
  });

  it("labels a tracked run with its ticket key, which is what the toast says", async () => {
    // `label ?? key` in attentionJob.ts: a task run's key IS its ticket key, so
    // this label leaves the released wording ("PROJ-7 is waiting on you")
    // untouched — the field exists for the keys that are hashes.
    h.runs = [mkRun({ key: "PROJ-7", summary: "isolate the renew queue", createdAt: Date.now() - 60 * 60_000 })];
    h.openSessions = [];
    needsYou([dirtyRepo()]);
    show(true);
    await settled();
    expect(DeckPanel.latestCandidates()!.candidates.find((x) => x.key === "PROJ-7")!.label).toBe("PROJ-7");
  });

  it("labels a local card with a name, never with localKey's hash", async () => {
    // The toast a first-time user of the setting actually sees. Without the
    // label it read "local-webapp-<sha1> is waiting on you". This fixture's
    // place is on a branch the fake connector infers a ticket from, so the name
    // is that ticket key — the same rule the tracked half follows. A place whose
    // branch names no ticket falls back to the card's own summary, which is what
    // the gatherer's local candidates always use (attentionFs.test.ts).
    h.runs = [];
    h.openSessions = [sess({ cwd: "/r/webapp", name: "webapp-7e" })];
    h.buildRunStatus.mockReset().mockImplementation(
      (i: { run: Run; ticket: { category: string | null } | null }) =>
        i.run.kind === "local"
          ? { ...statusFor(i.run, i.ticket?.category ?? null), agent: { state: "blocked" as const, lastActivityMs: null, slug: null } }
          : statusFor(i.run, i.ticket?.category ?? null),
    );
    show(true);
    await settled();
    const [local] = DeckPanel.latestCandidates()!.candidates;
    expect(local.key).toContain("local-");
    expect(local.label).toBe("PROJ-5641");
    expect(local.label).not.toBe(local.key);
  });

  it("labels a local card whose branch names no ticket with the card's own name", async () => {
    // The exact toast the finding named: a session in an unclaimed place on an
    // ordinary branch, whose key is `local-<slug>-<sha1>`.
    h.branch = "main";
    h.runs = [];
    h.openSessions = [sess({ cwd: "/r/webapp", name: "webapp-7e" })];
    h.buildRunStatus.mockReset().mockImplementation(
      (i: { run: Run; ticket: { category: string | null } | null }) =>
        i.run.kind === "local"
          ? { ...statusFor(i.run, i.ticket?.category ?? null), agent: { state: "blocked" as const, lastActivityMs: null, slug: null } }
          : statusFor(i.run, i.ticket?.category ?? null),
    );
    show(true);
    await settled();
    const [local] = DeckPanel.latestCandidates()!.candidates;
    expect(local.key).toMatch(/^local-webapp-[0-9a-f]{8}$/);
    expect(local.label).toBe("webapp");
  });
});

describe("forgeNote", () => {
  const gh = "gh";

  it("says nothing when PR facts are switched off entirely", () => {
    // Nothing was attempted, so there is no gap to report — a note here would
    // read as a failure to a user who turned the feature off on purpose.
    expect(forgeNote({ prFacts: false, gap: null, cli: gh, unreadRuns: 4 })).toBeNull();
  });

  it("says nothing when every read succeeded", () => {
    expect(forgeNote({ prFacts: true, gap: null, cli: gh, unreadRuns: 0 })).toBeNull();
  });

  it("keeps the released wording when the CLI itself is the gap", () => {
    // The existing two notes must survive verbatim: they name a cause a user can
    // act on, which "could not read 4 runs" does not.
    expect(forgeNote({ prFacts: true, gap: { kind: "missing", detail: "" }, cli: gh, unreadRuns: 0 }))
      .toBe("gh CLI not found — PR facts off. Run Doctor");
    expect(forgeNote({ prFacts: true, gap: { kind: "signed-out", detail: "" }, cli: gh, unreadRuns: 0 }))
      .toBe("gh is not signed in — PR facts off. Run Doctor");
  });

  it("lets a real gap outrank the count, because it names the actual cause", () => {
    // Both are true during an outage — the probe failing means every fetch fails
    // too. The gap is the more useful of the two, so it wins.
    expect(forgeNote({ prFacts: true, gap: { kind: "missing", detail: "" }, cli: gh, unreadRuns: 9 }))
      .toBe("gh CLI not found — PR facts off. Run Doctor");
  });

  it("reports the count when the CLI is fine but the reads are not", () => {
    // The case that has no note today: `gh auth status` passes, so `forgeGap` is
    // null, while every `pr list` fails because the signed-in account cannot see
    // the repo. The board looked healthy and said nothing.
    expect(forgeNote({ prFacts: true, gap: null, cli: gh, unreadRuns: 6 }))
      .toBe("gh could not read the PR state for 6 runs. Run Doctor");
  });

  it("says run, not runs, for one", () => {
    expect(forgeNote({ prFacts: true, gap: null, cli: gh, unreadRuns: 1 }))
      .toBe("gh could not read the PR state for 1 run. Run Doctor");
  });

  it("names the configured forge's own CLI, never a hardcoded gh", () => {
    expect(forgeNote({ prFacts: true, gap: null, cli: "glab", unreadRuns: 2 }))
      .toBe("glab could not read the PR state for 2 runs. Run Doctor");
  });

  it("stands down when the account row is showing, which already names the count", () => {
    // One slot in the legend. The account row carries the count when it shows,
    // and a note repeating it would say the same thing twice in one line.
    expect(forgeNote({ prFacts: true, gap: null, cli: gh, unreadRuns: 6, accountSlotShowing: true }))
      .toBeNull();
  });

  it("still reports the count when there is no account row to carry it", () => {
    // A single-account user gets no account row at all, so the note is the only
    // thing that can say the reads are failing.
    expect(forgeNote({ prFacts: true, gap: null, cli: gh, unreadRuns: 6, accountSlotShowing: false }))
      .toBe("gh could not read the PR state for 6 runs. Run Doctor");
  });

  it("lets a real gap outrank the account row too", () => {
    // The gap owns the slot outright: accountSlot returns null on a gap, so the
    // note must not stand down for a row that is not there.
    expect(forgeNote({ prFacts: true, gap: { kind: "missing", detail: "" }, cli: gh, unreadRuns: 6, accountSlotShowing: true }))
      .toBe("gh CLI not found — PR facts off. Run Doctor");
  });
});

describe("switching the forge account", () => {
  const TWO = JSON.stringify({ hosts: { "github.com": [
    { state: "success", active: true, login: "oznasi1", scopes: "repo, workflow" },
    { state: "success", active: false, login: "OznasiAb", scopes: "repo" },
  ] } });
  const ONE = JSON.stringify({ hosts: { "github.com": [
    { state: "success", active: true, login: "solo", scopes: "repo" },
  ] } });

  /** Answer the account calls; leave every other gh spawn as the file's default. */
  const ghAccounts = (json: string, onSwitch: () => string = () => "") => {
    h.ghRun.mockImplementation(async (_f: string, args: string[]) => {
      if (args[0] === "auth" && args[1] === "status") return json;
      if (args[0] === "auth" && args[1] === "switch") return onSwitch();
      return "[]";
    });
  };

  const switched = () =>
    h.ghRun.mock.calls.filter((c) => c[1][0] === "auth" && c[1][1] === "switch");

  it("offers only the accounts that are not already active", async () => {
    ghAccounts(TWO);
    const p = await showAndWarm();
    window.showQuickPick.mockResolvedValueOnce(undefined);
    await p._fire({ type: "deck:switchAccount" });
    const items = window.showQuickPick.mock.calls[0][0] as { label: string; detail: string }[];
    expect(items.map((i) => i.label)).toEqual(["OznasiAb"]);
    expect(items[0].detail).toBe("repo");
  });

  // Machine-wide is the whole reason the modal exists.
  it("confirms with a modal that discloses the machine-wide effect", async () => {
    ghAccounts(TWO);
    const p = await showAndWarm();
    window.showQuickPick.mockResolvedValueOnce({ label: "OznasiAb" });
    window.showWarningMessage.mockResolvedValueOnce(undefined);
    await p._fire({ type: "deck:switchAccount" });
    const opts = window.showWarningMessage.mock.calls[0][1] as { modal?: boolean; detail?: string };
    expect(opts.modal).toBe(true);
    expect(opts.detail).toMatch(/whole machine/i);
  });

  it("switches nothing when the modal is declined", async () => {
    ghAccounts(TWO);
    const p = await showAndWarm();
    window.showQuickPick.mockResolvedValueOnce({ label: "OznasiAb" });
    window.showWarningMessage.mockResolvedValueOnce(undefined);
    await p._fire({ type: "deck:switchAccount" });
    expect(switched()).toHaveLength(0);
    expect(h.removePrEntries).not.toHaveBeenCalled();
  });

  it("switches nothing when the picker is dismissed", async () => {
    ghAccounts(TWO);
    const p = await showAndWarm();
    window.showQuickPick.mockResolvedValueOnce(undefined);
    await p._fire({ type: "deck:switchAccount" });
    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(switched()).toHaveLength(0);
  });

  it("spawns the switch with the account the user picked", async () => {
    ghAccounts(TWO);
    const p = await showAndWarm();
    window.showQuickPick.mockResolvedValueOnce({ label: "OznasiAb" });
    window.showWarningMessage.mockResolvedValueOnce("Switch");
    await p._fire({ type: "deck:switchAccount" });
    expect(switched()[0][1]).toEqual(["auth", "switch", "--hostname", "github.com", "--user", "OznasiAb"]);
  });

  // Without this the switch appears inert: every error entry survives, the board
  // re-renders identically, and the user concludes the feature is broken.
  it("forgets every run's stored PR entries, because they are the old identity's answers", async () => {
    h.runs = [mkRun({ key: "PROJ-1" }), mkRun({ key: "PROJ-2" })];
    ghAccounts(TWO);
    const p = await showAndWarm();
    h.removePrEntries.mockClear();
    window.showQuickPick.mockResolvedValueOnce({ label: "OznasiAb" });
    window.showWarningMessage.mockResolvedValueOnce("Switch");
    await p._fire({ type: "deck:switchAccount" });
    expect(h.removePrEntries.mock.calls.map((c) => c[1])).toEqual(["PROJ-1", "PROJ-2"]);
  });

  // Fix wave, IMPORTANT 1: a local (untracked) card has no record in
  // `readRuns` — only in the in-memory `localRuns` map — but `buildAll` fetches
  // PR facts for it the same way it does for a tracked run (`sweepTargets`
  // already unions the two for this reason). Before this fix the switch's
  // invalidation loop only walked `readRuns`, so a local card's stale
  // `error: true` entries survived a switch and the success toast lied to it.
  it("forgets a local card's stored PR entries too, since it has no record in readRuns", async () => {
    h.runs = [];
    h.openSessions = [sess({ cwd: "/r/webapp", name: "webapp-7e" })];
    ghAccounts(TWO);
    const p = await showAndWarm();
    const localKey = builtLocal().run.key;
    expect(localKey).toMatch(/^local-/);
    h.removePrEntries.mockClear();
    window.showQuickPick.mockResolvedValueOnce({ label: "OznasiAb" });
    window.showWarningMessage.mockResolvedValueOnce("Switch");
    await p._fire({ type: "deck:switchAccount" });
    expect(h.removePrEntries.mock.calls.map((c) => c[1])).toContain(localKey);
  });

  it("leaves the stored entries alone when the switch fails, and says why", async () => {
    h.runs = [mkRun({ key: "PROJ-1" })];
    ghAccounts(TWO, () => { throw new Error("no such account"); });
    const p = await showAndWarm();
    h.removePrEntries.mockClear();
    window.showQuickPick.mockResolvedValueOnce({ label: "OznasiAb" });
    window.showWarningMessage.mockResolvedValueOnce("Switch");
    await p._fire({ type: "deck:switchAccount" });
    expect(h.removePrEntries).not.toHaveBeenCalled();
    expect(posts(p)).toContainEqual(
      expect.objectContaining({ type: "toast", level: "error", message: expect.stringContaining("no such account") }),
    );
  });

  it("says so rather than opening an empty picker when there is only one account", async () => {
    ghAccounts(ONE);
    const p = await showAndWarm();
    await p._fire({ type: "deck:switchAccount" });
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(posts(p)).toContainEqual(expect.objectContaining({ type: "toast", level: "info" }));
  });

  // The legend hides the link on such a forge, so this should be unreachable —
  // which is exactly why the host must not depend on it being unreachable.
  it("refuses outright on a forge that cannot switch accounts", async () => {
    setConfig({ forge: "gitlab" });
    const p = await showAndWarm();
    await p._fire({ type: "deck:switchAccount" });
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(switched()).toHaveLength(0);
  });

  // Fix wave, IMPORTANT 2a (spec §8: "An in-flight fetch that lands after the
  // switch is discarded"). Deleting the `this.prEpoch.set(...)` line from the
  // switch passes the whole suite, because line coverage there is already
  // satisfied by the sibling `removePrEntries` assertion in the same loop body
  // — this test fails on that mutant, because without the epoch bump the stale
  // fetch below would write its answer instead of being silently dropped.
  it("discards a fetch that was already in flight under the old account when it lands after the switch", async () => {
    const releases: Array<() => void> = [];
    h.runs = [mkRun({ key: "PROJ-1" })];
    h.prFetch.mockImplementation(() => new Promise((res) => { releases.push(() => res({ ok: true, facts: null })); }));
    ghAccounts(TWO);
    show();
    await settled(); // warms the gh probe and the accounts read; no fetch yet
    const p = lastPanel();
    await p._fire({ type: "deck:refresh" }); // the OLD-account fetch is now in flight, unresolved
    expect(releases).toHaveLength(1);
    window.showQuickPick.mockResolvedValueOnce({ label: "OznasiAb" });
    window.showWarningMessage.mockResolvedValueOnce("Switch");
    await p._fire({ type: "deck:switchAccount" }); // bumps PROJ-1's epoch and re-enqueues a fresh fetch
    h.writePrEntry.mockClear();
    releases[0](); // the pre-switch fetch lands now, epoch mismatched
    await settled();
    expect(h.writePrEntry).not.toHaveBeenCalled();
  });

  // Fix wave, IMPORTANT 2b: nothing anywhere asserted that a posted `deck:runs`
  // ever carries a non-null `ghAccount` — `accountSlot` was tested on hand-built
  // inputs, and `startForgeAccountsRead` → `this.forgeAccounts` had no seam test
  // of its own. Deleting the `startForgeAccountsRead()` call from `refresh()`
  // passes the whole suite; this test fails on that mutant, because
  // `this.forgeAccounts` then never leaves its initial `[]` and `accountSlot`
  // stays null forever.
  //
  // The read is fire-and-forget (see `startForgeAccountsRead`'s own comment): the
  // pass that starts it posts before the promise resolves, so `showAndWarm`'s two
  // passes — one to start it, one after it has resolved — are both required.
  it("posts a deck:runs whose ghAccount names the active login once the accounts read resolves", async () => {
    ghAccounts(TWO);
    const p = await showAndWarm();
    expect(lastRunsPost().ghAccount).toEqual({ cli: "gh", login: "oznasi1", canSwitch: true });
  });
});

describe("orchestrator telemetry", () => {
  /** Open a panel and return it plus a way to deliver an inbound message — the
   * same `show()` + `settled()` + `_fire` idiom every other describe block in
   * this file uses. */
  const openPanel = async () => {
    show();
    await settled();
    const p = lastPanel();
    return { p, send: async (m: unknown) => { await p._fire(m); await settled(); } };
  };

  const events = (name: string) => trackSpy.mock.calls.flat().filter((e: any) => e.name === name) as any[];

  /** A place node wired to a notify terminal by one `pr-merged` rule — the
   * smallest flow that can both be armed and fire. */
  const wired = (over: Partial<Flow> = {}): Flow => ({
    ...mkFlow("f1", "Ship the migration"),
    nodes: [
      { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
      { id: "n2", kind: "notify", x: 0, y: 0, join: "any", message: "the migration has landed" },
    ],
    edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "notify" }],
    ...over,
  });

  /** A place whose PR is watched, wired to planned work — the launch fixture the
   * "a met launch rule acts" block uses, with its first-spend question already
   * answered. */
  const launchFlow = (over: Partial<Flow> = {}): Flow => ({
    ...mkFlow("f1", "Ship the migration"),
    armed: true,
    launchConfirmedAt: 500,
    nodes: [
      { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
      {
        id: "n2", kind: "planned", x: 0, y: 0, join: "any",
        ticketKey: "PROJ-12", repos: ["aws-ops"], mode: "implementation", dest: "worktree",
      },
    ],
    edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "launch" }],
    ...over,
  });

  /** Warm the resume gate with the condition UNMET, then leave the met status in
   * place for the pass under test — the two-pass idiom every firing test in this
   * file uses. Telemetry from the warm-up passes is cleared, so each assertion is
   * about the pass the test itself asks for. */
  const warmed = async (flows: Flow[]) => {
    setConfig({ orchestrator: true });
    h.flows = flows;
    h.buildRunStatus.mockReturnValue(openStatus("PROJ-1", "aws-ops"));
    const opened = await openPanel();
    await settle();
    h.buildRunStatus.mockReturnValue(mergedStatus("PROJ-1", "aws-ops"));
    h.writeFlow.mockClear();
    trackSpy.mockClear();
    return opened;
  };

  it("emits flow_armed on the arm toggle, with the unfirable split by what each rule needs", async () => {
    // PR facts off, so the one `pr-merged` rule is unfirable for want of them —
    // h.prFacts, not setConfig, for the reason the arm block above documents.
    setConfig({ orchestrator: true });
    h.prFacts = false;
    h.flows = [wired()];
    const { send } = await openPanel();
    trackSpy.mockClear();
    await send({ type: "flow:arm", id: "f1", armed: true });
    expect(events("flow_armed")).toHaveLength(1);
    expect(events("flow_armed")[0]).toEqual({
      name: "flow_armed", armed: true, node_count: 2, edge_count: 1,
      unfirable_live: 0, unfirable_pr_facts: 1, unfirable_forge: 0, source: "toggle",
    });
  });

  it("never carries the flow's id, its name or a node's ticket key", async () => {
    setConfig({ orchestrator: true });
    h.flows = [wired({ nodes: [
      { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
      {
        id: "n2", kind: "planned", x: 0, y: 0, join: "any",
        ticketKey: "PROJ-12", repos: ["aws-ops"], mode: "implementation", dest: "worktree",
      },
    ] })];
    const { send } = await openPanel();
    trackSpy.mockClear();
    await send({ type: "flow:arm", id: "f1", armed: true });
    await send({ type: "flow:save", flow: wired() });
    const wire = JSON.stringify(trackSpy.mock.calls.flat());
    // A minted flow id is not ours to send, not even fingerprinted; the name, the
    // ticket key and the repo are user strings.
    for (const secret of ["f1", "Ship the migration", "PROJ-12", "aws-ops"]) {
      expect(wire).not.toContain(secret);
    }
  });

  it("emits flow_armed with zeroed counts and the toggle source on a disarm", async () => {
    setConfig({ orchestrator: true });
    h.flows = [{ ...wired(), armed: true }];
    const { send } = await openPanel();
    trackSpy.mockClear();
    await send({ type: "flow:arm", id: "f1", armed: false });
    expect(events("flow_armed")[0]).toMatchObject({
      armed: false, source: "toggle", unfirable_live: 0, unfirable_pr_facts: 0, unfirable_forge: 0,
    });
  });

  it("emits a flow_action for each flow gesture that did something", async () => {
    setConfig({ orchestrator: true });
    h.flows = [wired()];
    const { send } = await openPanel();
    trackSpy.mockClear();
    await send({ type: "flow:create" });
    await send({ type: "flow:rename", id: "f1", name: "Ship it" });
    await send({ type: "flow:save", flow: wired() });
    await send({ type: "flow:resetEdge", id: "f1", edgeId: "e1" });
    await send({ type: "flow:saveCommand", run: "deploy.sh", label: "Deploy" });
    await send({ type: "flow:delete", id: "f1" });
    expect(events("flow_action").map((e) => e.action)).toEqual([
      "create", "rename", "save", "reset_edge", "save_command", "delete",
    ]);
    // Only `save` knows the shape of a graph.
    expect(events("flow_action").find((e) => e.action === "save")).toMatchObject({ node_count: 2, edge_count: 1 });
    expect(events("flow_action").find((e) => e.action === "create").node_count).toBeUndefined();
  });

  it("emits nothing for a flow gesture the host refuses", async () => {
    setConfig({ orchestrator: true });
    h.flows = [wired()];
    const { send } = await openPanel();
    trackSpy.mockClear();
    await send({ type: "flow:rename", id: "intruder", name: "x" });
    await send({ type: "flow:save", flow: mkFlow("intruder", "x") });
    await send({ type: "flow:delete", id: "intruder" });
    await send({ type: "flow:resumeApprove", id: "f1" }); // no gate is held
    // `openPanel()` here defaults to an unauthenticated connector, so this
    // refuses before ever opening a picker — `addPlanned` returns `false`, and
    // that return is what the switch case's emit is gated on.
    await send({ type: "flow:addPlanned", id: "f1" });
    expect(events("flow_action")).toEqual([]);
  });

  it("emits resume_approve and resume_disarm from the resume banner, and the disarm's flow_armed", async () => {
    // A real resume gate: the first pass to find a rule ready HOLDS it and
    // reports, rather than firing, so the banner this test clicks is genuine.
    setConfig({ orchestrator: true });
    h.flows = [{ ...wired(), armed: true }];
    h.buildRunStatus.mockReturnValue(mergedStatus("PROJ-1", "aws-ops"));
    const { p, send } = await openPanel();
    await settle();
    const gated = posts(p).filter((m) => m.type === "deck:flows").at(-1) as any;
    expect(gated.pendingResume).toHaveLength(1);
    trackSpy.mockClear();
    await send({ type: "flow:resumeApprove", id: "f1" });
    expect(events("flow_action").map((e) => e.action)).toEqual(["resume_approve"]);
    trackSpy.mockClear();
    await send({ type: "flow:resumeDisarm", id: "f1" });
    expect(events("flow_action").map((e) => e.action)).toEqual(["resume_disarm"]);
    expect(events("flow_armed")[0]).toMatchObject({ armed: false, source: "resume-banner" });
  });

  it("emits flow_action dry_run from the webview's counts", async () => {
    setConfig({ orchestrator: true });
    const { send } = await openPanel();
    trackSpy.mockClear();
    await send({ type: "flow:dryRun", edges: 3, fired: 1, blocked: 0 });
    expect(events("flow_action")).toEqual([
      { name: "flow_action", action: "dry_run", edge_count: 3, fired_count: 1, blocked_count: 0 },
    ]);
  });

  it("drops a dry-run payload whose counts are not finite, non-negative numbers", async () => {
    setConfig({ orchestrator: true });
    const { send } = await openPanel();
    trackSpy.mockClear();
    // A webview payload is untrusted whatever the wire type says.
    await send({ type: "flow:dryRun", edges: "x", fired: 1, blocked: 0 });
    await send({ type: "flow:dryRun", edges: 3, fired: -1, blocked: 0 });
    await send({ type: "flow:dryRun", edges: 3, fired: 1, blocked: Number.NaN });
    await send({ type: "flow:dryRun", edges: 3, fired: 1 });
    expect(events("flow_action")).toEqual([]);
  });

  it("emits nothing at all for any flow message when the orchestrator is off", async () => {
    setConfig({ orchestrator: false });
    const { send } = await openPanel();
    trackSpy.mockClear();
    await send({ type: "flow:create" });
    await send({ type: "flow:arm", id: "f1", armed: true });
    await send({ type: "flow:dryRun", edges: 3, fired: 1, blocked: 0 });
    expect(trackSpy.mock.calls.flat().filter((e: any) => /^flow_/.test(e.name))).toEqual([]);
  });

  it("emits flow_edge_fired for a launch that acted, with the planned node's own launch shape", async () => {
    const { send } = await warmed([launchFlow()]);
    await send({ type: "deck:refresh" });
    expect(h.launchPlanned).toHaveBeenCalledTimes(1);
    expect(events("flow_edge_fired")).toEqual([{
      name: "flow_edge_fired", edge_action: "launch", ok: true, deferred: false,
      dest: "worktree", prompt_mode: "implementation", repo_count: 1,
    }]);
  });

  it("reports a launch that tried and failed as ok:false, still not deferred", async () => {
    h.launchPlanned.mockResolvedValue({ ok: false, message: "Couldn't create a git worktree in aws-ops" });
    const { send } = await warmed([launchFlow()]);
    await send({ type: "deck:refresh" });
    expect(events("flow_edge_fired")[0]).toMatchObject({ ok: false, deferred: false });
  });

  it("emits no flow_edge_fired for a pass in which nothing was performed", async () => {
    // A notify spends nothing and is not performed through this seam.
    const { send } = await warmed([{ ...wired(), armed: true }]);
    await send({ type: "deck:refresh" });
    expect((h.writeFlow.mock.calls.at(-1)![2] as Flow).edges[0].firedAt).toBeTypeOf("number");
    expect(events("flow_edge_fired")).toEqual([]);
  });

  it("omits dest from flow_edge_fired when the planned node's dest is not one of the three known values", async () => {
    // The flows file is hand-editable and only shape-checked on read (`validNode`
    // in store.ts never looks at `dest`), so a stray or hand-typed value must not
    // ride the event through unvalidated.
    const flow = launchFlow();
    (flow.nodes[1] as unknown as { dest: string }).dest = "not-a-real-dest";
    const { send } = await warmed([flow]);
    await send({ type: "deck:refresh" });
    expect(events("flow_edge_fired")).toEqual([{
      name: "flow_edge_fired", edge_action: "launch", ok: true, deferred: false,
      prompt_mode: "implementation", repo_count: 1,
    }]);
  });

  it("emits exactly one flow_settled when the last edge settles, and never again", async () => {
    const { send } = await warmed([launchFlow()]);
    await send({ type: "deck:refresh" });
    expect(events("flow_settled")).toEqual([{ name: "flow_settled", node_count: 2, edge_count: 1 }]);
    // The store now holds the stamped flow, as disk would. A settled flow left
    // armed on the board is polled every six seconds and must not re-report.
    h.flows = [h.writeFlow.mock.calls.at(-1)![2] as Flow];
    trackSpy.mockClear();
    await send({ type: "deck:refresh" });
    await send({ type: "deck:refresh" });
    expect(events("flow_settled")).toEqual([]);
  });

  it("does not call a flow settled while one of its rules is still pending", async () => {
    const twoRules = launchFlow({
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
        {
          id: "n2", kind: "planned", x: 0, y: 0, join: "any",
          ticketKey: "PROJ-12", repos: ["aws-ops"], mode: "implementation", dest: "worktree",
        },
        { id: "n3", kind: "notify", x: 0, y: 0, join: "any", message: "shipped" },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, action: "launch" },
        { id: "e2", from: "n1", to: "n3", cond: { kind: "ticket-status-is", status: "Shipped" }, action: "notify" },
      ],
    });
    const { send } = await warmed([twoRules]);
    await send({ type: "deck:refresh" });
    const written = h.writeFlow.mock.calls.at(-1)![2] as Flow;
    expect(written.edges[0].firedAt).toBeTypeOf("number");
    expect(written.edges[1].firedAt).toBeUndefined();
    expect(events("flow_settled")).toEqual([]);
  });

  it("reports a mid-pass disarm once, as an auto-skip, however many rules it skipped", async () => {
    // Three acting edges, so this pass has three `performEdge` calls to make —
    // room for another window's Disarm to land between the first and the second,
    // leaving TWO rules skipped by one disarm. The event must be about the
    // disarm, not about the rules.
    const many = (): Flow => ({
      ...launchFlow(),
      nodes: [
        { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
        ...[1, 2, 3].map((i) => ({
          id: `p${i}`, kind: "planned" as const, x: 0, y: 0, join: "any" as const,
          ticketKey: `PROJ-2${i}`, repos: ["aws-ops"], mode: "implementation", dest: "worktree" as const,
        })),
      ],
      edges: [1, 2, 3].map((i) => ({
        id: `e${i}`, from: "n1", to: `p${i}`, cond: { kind: "pr-merged" as const }, action: "launch" as const,
      })),
    });
    const { send } = await warmed([many()]);
    h.launchPlanned.mockClear().mockImplementation(async (req: { node: { ticketKey: string; repos: string[] } }) => {
      // The disarm itself, landing on disk while this pass sits inside the first
      // launch's await — exactly as another window's write would.
      h.flows = h.flows.map((f) => ({ ...f, armed: false }));
      return { ok: true, runKey: req.node.ticketKey, repo: req.node.repos[0] };
    });
    await send({ type: "deck:refresh" });
    expect(h.launchPlanned).toHaveBeenCalledTimes(1);
    // Two rules skipped, one event.
    expect(events("flow_armed")).toEqual([{
      name: "flow_armed", armed: false, node_count: 4, edge_count: 3,
      unfirable_live: 0, unfirable_pr_facts: 0, unfirable_forge: 0, source: "auto-skip",
    }]);
  });
});

// ── Hardening: defensive guards appended by the deckView hardening pass ──────

describe("hardening — review launch double-click", () => {
  it("ignores a second launch for the same review while the first is still in flight", async () => {
    // launchReview is where the worktree is cut and the window opened — the
    // seconds it takes are exactly the window a double click lands in. Two
    // launches of one PR would start two paid review sessions, and the
    // deterministic reviewRunKey means the second writeRun orphans the first's
    // worktree.
    const releases: (() => void)[] = [];
    h.launchReview.mockImplementation(
      () => new Promise((res) => releases.push(() => res({ ok: true, runKey: "review-aws-ops-8491", provider: "claude-code" }))),
    );
    const p = await showAndWarm();
    const first = p._fire({ type: "deck:reviewLaunch", id: "CyberJackGit/aws-ops#8491" });
    const second = p._fire({ type: "deck:reviewLaunch", id: "CyberJackGit/aws-ops#8491" });
    await settled();
    // The first click's launch is still unresolved; the second click must not
    // have started another one for the same PR.
    expect(h.launchReview).toHaveBeenCalledTimes(1);
    releases.forEach((r) => r());
    await Promise.all([first, second]);
    expect(h.launchReview).toHaveBeenCalledTimes(1);
  });

  it("ignores a second batch launch naming the same review while the first is still asking", async () => {
    // The batch always asks its mode question (batchReviewModes holds at least
    // two entries), so the picker is the natural place the second click lands.
    const picks: ((v: unknown) => void)[] = [];
    window.showQuickPick.mockImplementation(() => new Promise((res) => picks.push(res)));
    const p = await showAndWarm();
    const first = p._fire({ type: "deck:reviewBatch", ids: ["CyberJackGit/aws-ops#8491"] });
    const second = p._fire({ type: "deck:reviewBatch", ids: ["CyberJackGit/aws-ops#8491"] });
    await settled();
    // One question on screen, not a queued duplicate behind it.
    expect(window.showQuickPick).toHaveBeenCalledTimes(1);
    picks.forEach((r) => r(undefined)); // dismiss — nothing launches either way
    await Promise.all([first, second]);
    expect(h.launchReview).not.toHaveBeenCalled();
  });

  it("a row launch already in flight also blocks a batch naming that id", async () => {
    const releases: (() => void)[] = [];
    h.launchReview.mockImplementation(
      () => new Promise((res) => releases.push(() => res({ ok: true, runKey: "review-aws-ops-8491", provider: "claude-code" }))),
    );
    const p = await showAndWarm();
    const row = p._fire({ type: "deck:reviewLaunch", id: "CyberJackGit/aws-ops#8491" });
    await settled();
    const batch = p._fire({ type: "deck:reviewBatch", ids: ["CyberJackGit/aws-ops#8491"] });
    await settled();
    // The batch had nothing left to launch, so it never asked its mode question.
    expect(window.showQuickPick).not.toHaveBeenCalled();
    releases.forEach((r) => r());
    await Promise.all([row, batch]);
    expect(h.launchReview).toHaveBeenCalledTimes(1);
  });
});

describe("hardening — PR-work double-seed", () => {
  it("seeds once for a double click across the destination picker", async () => {
    // The shipped default (prWorkOpenIn: "ask") parks seedPrWork on a picker,
    // which is exactly where a second click lands: without a guard it queues a
    // second picker and, once both are answered, writes the plan file twice and
    // seeds the same window twice.
    h.runs = [mkRun()];
    const picks: ((v: unknown) => void)[] = [];
    window.showQuickPick.mockImplementation(() => new Promise((res) => picks.push(res)));
    show();
    const p = lastPanel();
    const first = p._fire({ type: "deck:seedPrWork", key: "PROJ-1", reason: "conflict" });
    const second = p._fire({ type: "deck:seedPrWork", key: "PROJ-1", reason: "conflict" });
    await settled();
    // One destination question on screen, not a queued duplicate behind it.
    expect(window.showQuickPick).toHaveBeenCalledTimes(1);
    picks.forEach((r) => r({ target: { kind: "stay" } }));
    await Promise.all([first, second]);
    expect(h.writePlanFile).toHaveBeenCalledTimes(1);
  });

  it("still seeds a second time once the first is done", async () => {
    // The guard is about overlap, not about once-per-session: a deliberate
    // second Address PR after the first finished must keep working.
    h.runs = [mkRun()];
    window.showQuickPick.mockResolvedValue({ target: { kind: "stay" } });
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:seedPrWork", key: "PROJ-1", reason: "conflict" });
    await p._fire({ type: "deck:seedPrWork", key: "PROJ-1", reason: "conflict" });
    expect(h.writePlanFile).toHaveBeenCalledTimes(2);
  });
});

describe("hardening — a refresh outliving the panel", () => {
  it("performs nothing once the panel is disposed mid-build", async () => {
    // The close dialog promises that closing the Deck stops flows advancing —
    // but a refresh already past its build used to carry on after dispose():
    // acquiring the global flows lock, running commands, launching sessions,
    // or raising askFirstSpend from a dead panel.
    setConfig({ orchestrator: true });
    const releases: (() => void)[] = [];
    h.getStatus.mockImplementation(
      () => new Promise((res) => releases.push(() => res({ status: "In Review", category: "indeterminate" }))),
    );
    show(true);
    const p = lastPanel();
    await settled(); // the constructor's refresh is now parked on the ticket read
    expect(h.acquire).not.toHaveBeenCalled();
    p._fireDispose();
    releases.forEach((r) => r());
    await settled();
    await settled();
    // Neither the flows lock nor the board post — the pass died with the panel.
    expect(h.acquire).not.toHaveBeenCalled();
    expect(posts(p).some((m) => m.type === "deck:runs")).toBe(false);
  });
});

describe("hardening — usageFor answers for a missing run", () => {
  it("posts a null usage for a key with no run, instead of leaving the drawer loading forever", async () => {
    // The webview asks once per drawer opening and treats no-reply as loading:
    // a silent return leaves "Reading transcripts…" on screen until the panel
    // reloads. null is the shape it already renders as "couldn't read".
    show();
    const p = lastPanel();
    await settled();
    await p._fire({ type: "deck:usageFor", key: "PROJ-GONE" });
    const post = posts(p).filter((m) => m.type === "deck:usage").at(-1);
    expect(post).toEqual({ type: "deck:usage", key: "PROJ-GONE", usage: null });
  });
});

describe("hardening — onMessage failures surface", () => {
  /** Like `show()`, but with a log this describe can read. */
  const showWithLog = () => {
    const log = vi.fn();
    DeckPanel.show(fakeContext().context as any, fakeConnector(), log);
    return log;
  };

  it("logs and toasts when a handler throws, instead of a silent unhandled rejection", async () => {
    // deck:forget is the sharpest case: the webview drops the card
    // optimistically before removeRun runs, so a throw here (EACCES on the
    // runs directory, say) used to resurrect the card on the next poll with no
    // explanation at all.
    const log = showWithLog();
    const p = lastPanel();
    await settled();
    h.removeRun.mockImplementationOnce(() => { throw new Error("EACCES: /runs"); });
    await p._fire({ type: "deck:forget", key: "PROJ-1" }); // resolves — the throw is owned
    expect(log.mock.calls.some((c) => String(c[0]).includes("deck:forget") && String(c[0]).includes("EACCES"))).toBe(true);
    expect(posts(p)).toContainEqual(expect.objectContaining({
      type: "toast", level: "error", message: expect.stringContaining("deck:forget"),
    }));
  });

  it("logs a message type it does not know instead of dropping it silently", async () => {
    // Most plausibly a webview newer than the host — the panel survives an
    // extension update until its window reloads.
    const log = showWithLog();
    const p = lastPanel();
    await settled();
    await p._fire({ type: "deck:not-a-thing" });
    expect(log.mock.calls.some((c) => String(c[0]).includes("deck:not-a-thing"))).toBe(true);
  });
});

describe("hardening — Clear stale re-entrancy and failure", () => {
  /** The same landed-run fixture the Clear stale describe above uses. */
  const landed = () => {
    setConfig({ retireFinishedAfterHours: 999 });
    h.runs = [mkRun({ key: "PROJ-DONE" })];
    h.getStatus.mockResolvedValue({ status: "Done", category: "done" });
  };

  it("runs one clear for a double click across the confirm modal", async () => {
    // The confirm modal can sit open for as long as the user thinks; VS Code
    // queues modals rather than dropping one, so without a guard a second
    // click confirms a second full retire-and-sweep pass.
    landed();
    show(true);
    await settled();
    const p = lastPanel();
    const answers: (() => void)[] = [];
    (window.showWarningMessage as ReturnType<typeof vi.fn>).mockImplementation(
      (_m: string, _o: unknown, ...items: string[]) => new Promise((res) => answers.push(() => res(items[0]))),
    );
    const first = p._fire({ type: "deck:clearStale" });
    const second = p._fire({ type: "deck:clearStale" });
    await settled();
    // One confirm on screen, not a queued duplicate behind it.
    expect(answers).toHaveLength(1);
    answers.forEach((a) => a());
    await Promise.all([first, second]);
    await settled();
    expect(h.removeRun.mock.calls.filter((c) => c[1] === "PROJ-DONE")).toHaveLength(1);
  });

  it("tells the user when the rebuild behind a confirmed Clear stale throws", async () => {
    // A destructive bulk op must not fail silently after the user confirmed
    // it: the throw is owned by onMessage's catch (logged and toasted), pinned
    // here specifically for this path.
    landed();
    show(true);
    await settled();
    const p = lastPanel();
    h.buildRunStatus.mockImplementation(() => { throw new Error("EACCES: /runs"); });
    await p._fire({ type: "deck:clearStale" }); // the default modal answer confirms
    expect(posts(p)).toContainEqual(expect.objectContaining({
      type: "toast", level: "error", message: expect.stringContaining("deck:clearStale"),
    }));
  });
});

describe("hardening — flipping the token total mid-session", () => {
  // Fake timers for the same reason "the poll and the close confirmation"
  // above uses them: the usage cadence never fires under real timers within a
  // test's lifetime. Same settle shape, too.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const settle = async (ms = 0) => {
    await vi.advanceTimersByTimeAsync(ms);
  };

  it("arms the usage sweep when the setting turns on, without a reload", async () => {
    // The sweep timer was only ever armed in startPolling, so flipping the
    // setting on mid-session showed a confident $0 forever.
    h.showTokenTotal = false;
    show();
    await settle();
    h.usageReadRun.mockClear();
    h.showTokenTotal = true;
    fireConfigurationChanged("agentFlow.deck.showTokenTotal");
    await settle();
    expect(h.usageReadRun).toHaveBeenCalled(); // the eager sweep, exactly as startPolling's
    h.usageReadRun.mockClear();
    await settle(USAGE_POLL_MS + 1);
    expect(h.usageReadRun).toHaveBeenCalled(); // and the cadence behind it
  });

  it("clears the sweep timer when the setting turns off, instead of leaking it", async () => {
    h.showTokenTotal = true;
    show();
    await settle();
    h.showTokenTotal = false;
    fireConfigurationChanged("agentFlow.deck.showTokenTotal");
    await settle();
    h.usageReadRun.mockClear();
    await settle(USAGE_POLL_MS * 2 + 1);
    expect(h.usageReadRun).not.toHaveBeenCalled();
  });
});

describe("hardening — local cards survive a failed rebuild", () => {
  it("still resolves a local card's run after a rebuild threw mid-loop", async () => {
    // buildAll used to clear localRuns up front and repopulate it as it went:
    // a throw mid-loop left the map empty, so every local card still on screen
    // answered Open/Diff/Track with "No run record" until the next successful
    // pass.
    h.runs = [];
    h.openSessions = [
      sess({ cwd: "/r/aaa", sessionId: "sA", pid: 1, name: "aaa-1x" }),
      sess({ cwd: "/r/webapp", sessionId: "sB", pid: 2, name: "webapp-7e" }),
    ];
    show();
    await settled();
    const p = lastPanel();
    const webappKey = h.buildRunStatus.mock.calls
      .map((c) => c[0] as { run: Run })
      .filter((i) => i.run.kind === "local" && i.run.repos[0]?.path === "/r/webapp")
      .at(-1)!.run.key;
    // The next rebuild dies on the FIRST group (/r/aaa), before it ever gets
    // to /r/webapp's.
    h.sessionActivity.mockImplementation((_root: string, cwd: string) => {
      if (cwd === "/r/aaa") throw new Error("EACCES: transcript");
      return { state: "working", lastActivityMs: 4242, slug: "svc-7e-slug" };
    });
    await p._fire({ type: "deck:refresh" });
    await settled();
    await p._fire({ type: "deck:inspect", key: webappKey, action: "open" });
    expect(posts(p)).not.toContainEqual(
      expect.objectContaining({ type: "toast", message: `No run record for ${webappKey}.` }),
    );
    expect(h.openInEditor).toHaveBeenCalledWith("/r/webapp");
  });
});

describe("deadlines on an armed flow", () => {
  const openPanel = async () => {
    show();
    await settled();
    const p = lastPanel();
    return { p, send: async (m: unknown) => { await p._fire(m); await settled(); } };
  };

  /** A place feeding a notify terminal, the notify rule carrying a deadline, and
   * a sibling `deadline-passed` rule out of the same place into a second notify. */
  const deadlineFlow = (over: Partial<Flow> = {}, edgeOver: Partial<FlowEdge> = {}): Flow => ({
    ...mkFlow("f1", "Ship the migration"),
    armed: true,
    nodes: [
      { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
      { id: "n2", kind: "notify", x: 0, y: 0, join: "any", message: "the migration has landed" },
      { id: "n3", kind: "notify", x: 0, y: 0, join: "any", message: "it has not landed in time" },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, timeoutMinutes: 10, ...edgeOver },
      { id: "e2", from: "n1", to: "n3", cond: { kind: "deadline-passed" } },
    ],
    ...over,
  });

  it("starts a rule's clock the first pass its card is on the board, and writes nothing for a flow without deadlines", async () => {
    setConfig({ orchestrator: true });
    h.flows = [deadlineFlow()];
    h.buildRunStatus.mockReturnValue(openStatus("PROJ-1", "aws-ops"));
    await openPanel();
    await settle();
    const written = h.writeFlow.mock.calls.at(-1)?.[2] as Flow | undefined;
    expect(written?.edges[0].liveSince).toBeTypeOf("number");
    // The sibling has no deadline of its own, and nothing else was stamped.
    expect(written?.edges[1].liveSince).toBeUndefined();
    expect(written?.edges[0].firedAt).toBeUndefined();

    // Once running, a second pass does not write the clock again.
    h.writeFlow.mockClear();
    const { send } = await openPanel();
    await send({ type: "deck:refresh" });
    expect(h.writeFlow).not.toHaveBeenCalled();
  });

  it("expires a rule whose clock has run out, journals it, and lets the deadline-passed sibling fire on the next pass", async () => {
    setConfig({ orchestrator: true });
    h.flows = [deadlineFlow({}, { liveSince: Date.now() - 11 * 60_000 })];
    h.buildRunStatus.mockReturnValue(openStatus("PROJ-1", "aws-ops"));
    // Warm the resume gate: the first pass holds a ready rule for approval.
    const { send } = await openPanel();
    await settle();
    const afterFirst = h.flows[0];
    expect(afterFirst.edges[0].expiredAt).toBeTypeOf("number");
    expect(afterFirst.edges[0].firedAt).toBeUndefined();
    expect(afterFirst.edges[0].error).toBeUndefined();
    const expired = journal().filter((e) => e.kind === "expired");
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ edge: "e1", from: "n1", to: "n2" });
    expect(expired[0].since).toBeTypeOf("number");

    await send({ type: "deck:refresh" });
    await send({ type: "deck:refresh" });
    expect(h.flows[0].edges[1].firedAt).toBeTypeOf("number");
    expect(window.showInformationMessage).toHaveBeenCalledWith(expect.stringMatching(/not landed in time/));
    // Expiry is never announced as a notification of its own — it told nobody anything.
    expect(window.showInformationMessage).not.toHaveBeenCalledWith(expect.stringMatching(/has landed$/));
  });

  it("does not expire a rule whose condition arrived, however late — it fires instead", async () => {
    setConfig({ orchestrator: true });
    h.flows = [deadlineFlow({}, { liveSince: Date.now() - 60 * 60_000 })];
    h.buildRunStatus.mockReturnValue(openStatus("PROJ-1", "aws-ops"));
    const { send } = await openPanel();
    await settle();
    // Nothing expires while the flow is held at the resume gate? No — the clock
    // is not a spend. But the condition is met from the first pass here, so the
    // rule must fire, not expire.
    h.flows = [deadlineFlow({}, { liveSince: Date.now() - 60 * 60_000 })];
    h.buildRunStatus.mockReturnValue(mergedStatus("PROJ-1", "aws-ops"));
    await send({ type: "deck:refresh" });
    expect(h.flows[0].edges[0].expiredAt).toBeUndefined();
    expect(h.flows[0].edges[0].firedAt).toBeTypeOf("number");
  });

  it("re-arming restarts the clocks of pending rules and leaves settled ones alone", async () => {
    setConfig({ orchestrator: true });
    h.flows = [deadlineFlow({ armed: false, edges: [
      { id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, timeoutMinutes: 10, liveSince: 5 },
      { id: "e2", from: "n1", to: "n3", cond: { kind: "pr-merged" }, timeoutMinutes: 10, liveSince: 5, expiredAt: 9 },
    ] })];
    const { send } = await openPanel();
    await send({ type: "flow:arm", id: "f1", armed: true });
    const w = h.writeFlow.mock.calls.find((c) => (c[2] as Flow).armed === true)![2] as Flow;
    expect("liveSince" in w.edges[0]).toBe(false);
    expect(w.edges[1].liveSince).toBe(5);
    expect(w.edges[1].expiredAt).toBe(9);
  });

  it("disarming does not touch the clocks", async () => {
    setConfig({ orchestrator: true });
    h.flows = [deadlineFlow({}, { liveSince: 5 })];
    const { send } = await openPanel();
    await send({ type: "flow:arm", id: "f1", armed: false });
    const w = h.writeFlow.mock.calls.at(-1)![2] as Flow;
    expect(w.armed).toBe(false);
    expect(w.edges[0].liveSince).toBe(5);
  });

  it("flow:resetEdge clears the clock and the expiry, and keeps the deadline", async () => {
    setConfig({ orchestrator: true });
    h.flows = [deadlineFlow({}, { liveSince: 5, expiredAt: 9 })];
    const { send } = await openPanel();
    await send({ type: "flow:resetEdge", id: "f1", edgeId: "e1" });
    const e = (h.writeFlow.mock.calls.at(-1)![2] as Flow).edges[0];
    expect(e.liveSince).toBeUndefined();
    expect(e.expiredAt).toBeUndefined();
    expect(e.timeoutMinutes).toBe(10);
  });
});

describe("a command-printed rule", () => {
  const openPanel = async () => {
    show();
    await settled();
    const p = lastPanel();
    return { p, send: async (m: unknown) => { await p._fire(m); await settled(); } };
  };

  /** place → command (already performed) → notify on "the command printed…". */
  const printedFlow = (text = "DEPLOYED"): Flow => ({
    ...mkFlow("f1", "Ship the migration"),
    armed: true,
    nodes: [
      { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
      { id: "c", kind: "command", x: 0, y: 0, join: "any", run: "deploy.sh" },
      { id: "n2", kind: "notify", x: 0, y: 0, join: "any", message: "it printed the word" },
    ],
    edges: [
      { id: "e1", from: "n1", to: "c", cond: { kind: "pr-merged" }, firedAt: 5, firedNote: "ran", performed: true },
      { id: "e2", from: "c", to: "n2", cond: { kind: "command-printed", text } },
    ],
  });
  const ranWith = (output: string) =>
    seedJournal("f1", { kind: "fired", edge: "e1", from: "n1", to: "c", action: "run", note: "ran", output }, 1_000);

  it("fires when the journal shows the command printed the text", async () => {
    ranWith("building…\nDEPLOYED to prod\n");
    setConfig({ orchestrator: true });
    h.flows = [printedFlow()];
    h.buildRunStatus.mockReturnValue(openStatus("PROJ-1", "aws-ops"));
    const { send } = await openPanel();
    await settle();
    // The first pass holds a ready rule at the resume gate; Go is the next pass.
    await send({ type: "flow:resumeApprove", id: "f1" });
    await send({ type: "deck:refresh" });
    expect(h.flows[0].edges[1].firedAt).toBeTypeOf("number");
    expect(window.showInformationMessage).toHaveBeenCalledWith(expect.stringMatching(/printed the word/));
  });

  it("waits when the output lacks the text, and when nothing was journaled", async () => {
    ranWith("rolled back\n");
    setConfig({ orchestrator: true });
    h.flows = [printedFlow()];
    h.buildRunStatus.mockReturnValue(openStatus("PROJ-1", "aws-ops"));
    const { send } = await openPanel();
    await settle();
    await send({ type: "deck:refresh" });
    expect(h.flows[0].edges[1].firedAt).toBeUndefined();
    expect(h.writeFlow).not.toHaveBeenCalled();
  });

  it("posts the verdict per flow on deck:flows so the drawer agrees with the engine", async () => {
    ranWith("DEPLOYED");
    setConfig({ orchestrator: true });
    h.flows = [{ ...printedFlow(), armed: false }];
    const { p } = await openPanel();
    const msg = posts(p).filter((m) => m.type === "deck:flows").at(-1) as { printed?: Record<string, Record<string, boolean>> };
    expect(msg.printed).toEqual({ f1: { e2: true } });
  });

  it("posts nothing for a flow without such a rule — and reads no journal for it", async () => {
    setConfig({ orchestrator: true });
    h.flows = [{ ...mkFlow("f2", "plain"), armed: false }];
    const { p } = await openPanel();
    const msg = posts(p).filter((m) => m.type === "deck:flows").at(-1) as { printed?: Record<string, unknown> };
    expect(msg.printed).toEqual({});
  });
});

describe("opt-in retry on an armed flow", () => {
  const openPanel = async () => {
    show();
    await settled();
    const p = lastPanel();
    return { p, send: async (m: unknown) => { await p._fire(m); await settled(); } };
  };

  /** A consented launch rule that opted into two retries, 30s apart. */
  const retryFlow = (edgeOver: Partial<FlowEdge> = {}): Flow => ({
    ...mkFlow("f1", "Ship the migration"),
    armed: true,
    launchConfirmedAt: 500,
    nodes: [
      { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "aws-ops" },
      { id: "n2", kind: "planned", x: 0, y: 0, join: "any", ticketKey: "PROJ-12", repos: ["aws-ops"], mode: "implementation", dest: "worktree" },
    ],
    edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, retry: { max: 2, backoffMs: 30_000 }, ...edgeOver }],
  });

  const warmed = async (flow: Flow) => {
    setConfig({ orchestrator: true });
    h.flows = [flow];
    h.buildRunStatus.mockReturnValue(openStatus("PROJ-1", "aws-ops"));
    const opened = await openPanel();
    await settle();
    h.buildRunStatus.mockReturnValue(mergedStatus("PROJ-1", "aws-ops"));
    h.writeFlow.mockClear();
    return opened;
  };

  it("schedules a retry when a launch fails, journals errored then retrying, and does not try again before the backoff", async () => {
    h.launchPlanned.mockResolvedValueOnce({ ok: false, message: "worktree exists" });
    const { send } = await warmed(retryFlow());
    await send({ type: "deck:refresh" });
    const e = h.flows[0].edges[0];
    expect(e.error).toMatch(/worktree exists/);
    expect(e.attempts).toBe(1);
    expect(e.retryAt).toBeTypeOf("number");
    const kinds = journal().map((j) => j.kind);
    expect(kinds.indexOf("retrying")).toBe(kinds.indexOf("errored") + 1);
    expect(journal().find((j) => j.kind === "retrying")).toMatchObject({ edge: "e1", attempt: 1, max: 2 });
    // Not due yet: nothing launches on the next pass.
    h.launchPlanned.mockClear();
    await send({ type: "deck:refresh" });
    expect(h.launchPlanned).not.toHaveBeenCalled();
  });

  it("tries again once the backoff has elapsed, and a success clears the failure", async () => {
    const { send } = await warmed(retryFlow({ error: "worktree exists", attempts: 1, retryAt: Date.now() - 1, performed: true }));
    await send({ type: "deck:refresh" });
    expect(h.launchPlanned).toHaveBeenCalledTimes(1);
    const e = h.flows[0].edges[0];
    expect(e.firedAt).toBeTypeOf("number");
    expect(e.error).toBeUndefined();
    expect(e.retryAt).toBeUndefined();
    expect(e.firedNote).toMatch(/after 1 retry/);
    // No consent asked again: the flow's first spend was already approved.
    expect(window.showWarningMessage).not.toHaveBeenCalled();
  });

  it("latches for good once the retries are spent", async () => {
    h.launchPlanned.mockResolvedValueOnce({ ok: false, message: "still no worktree" });
    const { send } = await warmed(retryFlow({ error: "worktree exists", attempts: 2, retryAt: Date.now() - 1, performed: true }));
    await send({ type: "deck:refresh" });
    const e = h.flows[0].edges[0];
    expect(e.attempts).toBe(3);
    expect(e.retryAt).toBeUndefined();
    expect(journal().some((j) => j.kind === "retrying")).toBe(false);
  });

  it("a rule that never opted in fails exactly as before — no retry stamps, no retrying line", async () => {
    h.launchPlanned.mockResolvedValueOnce({ ok: false, message: "worktree exists" });
    const { send } = await warmed(retryFlow({ retry: undefined }));
    await send({ type: "deck:refresh" });
    const e = h.flows[0].edges[0];
    expect(e.error).toMatch(/worktree exists/);
    expect(e.retryAt).toBeUndefined();
    expect(journal().some((j) => j.kind === "retrying")).toBe(false);
  });

  it("flow:resetEdge clears attempts and retryAt and keeps the policy", async () => {
    setConfig({ orchestrator: true });
    h.flows = [retryFlow({ error: "x", attempts: 1, retryAt: 5, retryOk: true })];
    const { send } = await openPanel();
    await send({ type: "flow:resetEdge", id: "f1", edgeId: "e1" });
    const e = (h.writeFlow.mock.calls.at(-1)![2] as Flow).edges[0];
    expect(e.attempts).toBeUndefined();
    expect(e.retryAt).toBeUndefined();
    expect(e.retry).toEqual({ max: 2, backoffMs: 30_000 });
    expect(e.retryOk).toBe(true);
  });
});
