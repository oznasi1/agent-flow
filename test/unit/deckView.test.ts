import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { window, ViewColumn, env, workspace, commands, setConfig, ConfigurationTarget } from "../_mocks/vscode";
import { fakeContext } from "../_helpers/factories";
import type { ChangedFile } from "../../src/engine/git";
import type { AgentActivity, CardAgent, OpenSession, PrEntryMap, PrFacts, ReviewDetail, ReviewRequest, ReviewVerb, Run, RunStatus, ServiceRef } from "../../src/types";
import type { FetchResult, GhGap } from "../../src/engine/pr/provider";
import type { TaskConnector, TaskProvider } from "../../src/tasks/provider";

// Isolate the panel from the engine: fixtures for runs, a pass-through status
// builder, and a stubbed workspace opener.
const h = vi.hoisted(() => ({
  runs: [] as Run[],
  openInEditor: vi.fn(async (_t: string) => true),
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
  probeGh: vi.fn(async (): Promise<GhGap | null> => null),
  prFacts: true as boolean,
  ttlSeconds: 120,
  openAgents: true as boolean,
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
  // The write path (Task 14): the only setting that lets the Deck post to GitHub,
  // the Jira-provenance toggle reused for a review body, and the submit call itself.
  reviewWrites: false as boolean,
  stampLabelOnWrite: true as boolean,
  seedAgent: true as boolean,
  reviewSubmit: vi.fn(async (_repo: string, _number: number, _verb: ReviewVerb, _body: string): Promise<{ ok: true } | { ok: false; message: string }> => ({ ok: true })),
  repos: [{ name: "aws-ops", path: "/repos/aws-ops", isGit: true }] as ServiceRef[],
  reviewRequests: true as boolean,
  // Every Claude Code session open on this machine (Task 8) — the registry
  // readOpenSessions reads, stubbed here rather than touching real ~/.claude/sessions.
  openSessions: [] as OpenSession[],
  // Per-session live activity (Task 8) — stubbed so the liveSignal-on case can
  // assert a real, known AgentActivity is threaded through to the right
  // CardAgent, without this suite re-testing readSessionActivity's own parsing
  // of a real transcript file (engine/transcript.test.ts already does that).
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
  launchReview: vi.fn(async (..._args: unknown[]): Promise<{ ok: true; runKey: string } | { ok: false; message: string }> => ({
    ok: true,
    runKey: "review-aws-ops-8491",
  })),
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
  // Local cards (Task 11): the branch `currentBranch` reports for /r/centaur —
  // steerable per test, unlike repoRoot below, because the branch is exactly the
  // thing a local card's ticket inference and "no card twice" tests need to vary.
  branch: "ASM-5641-team-table" as string | null,
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
  // Never actually invoked in this suite — launchReview itself is mocked below,
  // so it never calls through to its own deps. Present only so deckView's
  // import of BRIEF_DIR and openWorkspace resolves to something.
  openWorkspace: vi.fn(),
  BRIEF_DIR: ".pick-task",
  writePlanFile: h.writePlanFile,
  // A stub that encodes its brief argument in the output, so a test can assert
  // which brief a match was rendered against without re-testing renderPrompt —
  // engine/prompt.test.ts already owns that.
  agentPrompt: (t: { key: string }, _mentions: string[], template: string, briefPath?: string) =>
    `${template} [key=${t.key} brief=${briefPath ?? "(relative)"}]`,
}));
vi.mock("../../src/engine/worktree", () => ({ createWorktrees: vi.fn() }));
// repoRoot stubbed alongside the real taskDiff: groupByPlace (engine/sessions)
// calls the real repoRoot, which would shell out to git for a fixture path like
// "/r/svc" and get "" back rather than the fixtures' own place key.
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
  repoRoot: (p: string) => p,
  currentBranch: (p: string) => (p === "/r/centaur" ? h.branch : "main"),
  prEligible: (r: { isGit: boolean; branch?: string }) => r.isGit && !!r.branch && r.branch !== "master",
  gitState: (name: string, path: string) => h.gitState(name, path),
}));
// groupByPlace and canon stay real — only the two functions that touch the real
// filesystem (~/.claude/sessions) are replaced.
vi.mock("../../src/engine/sessions", async (importActual) => ({
  ...(await importActual<typeof import("../../src/engine/sessions")>()),
  readOpenSessions: () => h.openSessions,
  defaultSessionsDir: () => "/sessions",
}));
// UNKNOWN_ACTIVITY stays real (deckView.ts imports it directly, and it is the
// exact value the liveSignal-off case asserts against) — only the transcript
// read itself, which would otherwise hit a real (absent) file, is replaced.
vi.mock("../../src/engine/transcript", async (importActual) => ({
  ...(await importActual<typeof import("../../src/engine/transcript")>()),
  readSessionActivity: (projectsRoot: string, cwd: string, sessionId: string, nowMs: number) =>
    h.sessionActivity(projectsRoot, cwd, sessionId, nowMs),
}));
vi.mock("../../src/engine/presence", () => ({
  readLiveWindows: () => [],
  defaultWindowsDir: () => "/windows",
}));
vi.mock("../../src/engine/pr/store", () => ({
  defaultPrFactsDir: () => "/prfacts",
  readPrEntries: () => h.prEntries,
  writePrEntry: h.writePrEntry,
  removePrEntries: h.removePrEntries,
  // Exercise the real staleness rule rather than restating it here.
  isStale: (e: { fetchedAt: number } | undefined, ttl: number, now: number) => !e || now - e.fetchedAt >= ttl,
}));
vi.mock("../../src/engine/pr/provider", () => ({
  probeGh: h.probeGh,
  GhProvider: class { fetch = h.prFetch; },
}));
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
vi.mock("../../src/engine/repos", () => ({ discoverRepos: () => h.repos }));
// Partial mock: deckView.ts and everything it pulls in (engine/worktree,
// engine/gitExclude, jsonc-parser's consumers, etc.) use far more of `fs` than
// the two functions this suite stubs — a bare vi.mock("fs") would blank the
// rest and break every real (unmocked) module transitively imported here.
vi.mock("fs", async (importActual) => {
  const actual = await importActual<typeof import("fs")>();
  return { ...actual, existsSync: (p: string) => h.existsSync(p), readFileSync: (p: string, e: string) => h.readFileSync(p, e) };
});
// Partial mock: reviewRunKey is real (its slugging is exactly what decorateReviews
// relies on to match a run to a queued PR); only launchReview — the side-effecting
// half — is replaced.
vi.mock("../../src/engine/review/launch", async (importActual) => {
  const actual = await importActual<typeof import("../../src/engine/review/launch")>();
  return { ...actual, launchReview: (...args: Parameters<typeof actual.launchReview>) => h.launchReview(...args) };
});
vi.mock("../../src/config", async (importActual) => {
  const actual = await importActual<typeof import("../../src/config")>();
  return {
    ...actual,
    getConfig: () => ({
      baseUrl: "https://jira", project: "ASM", prFacts: h.prFacts, prFactsTtlSeconds: h.ttlSeconds,
      openAgents: h.openAgents,
      reviewRequests: h.reviewRequests, reviewRequestsTtlSeconds: 300, reposRoot: "/repos", repoBlocklist: [],
      reviewWrites: h.reviewWrites, stampLabelOnWrite: h.stampLabelOnWrite,
      prReviewPrompt: h.prReviewPrompt, prReviewAutoFix: h.prReviewAutoFix, seedAgent: h.seedAgent,
      prReviewStatus: "PR initiated",
      // Sourced from the real getConfig() (itself driven by the globally-mocked
      // vscode module) rather than hardcoded here, so a test's setConfig({
      // reviewRequestModes / reviewRequestMode }) actually reaches launchReviewFor.
      reviewRequestModes: actual.getConfig().reviewRequestModes,
      reviewRequestMode: actual.getConfig().reviewRequestMode,
      // Same reason: the retire sweep reads both windows, and the grouping is a
      // persisted setting — a test steers all three through setConfig, so they
      // must come from the real getConfig() rather than being frozen here.
      deckGrouping: actual.getConfig().deckGrouping,
      retireFinishedAfterHours: actual.getConfig().retireFinishedAfterHours,
      retireAbandonedAfterDays: actual.getConfig().retireAbandonedAfterDays,
    }),
  };
});
import { DeckPanel } from "../../src/deckView";
import { PR_REVIEW_AUTOFIX_CLAUSE } from "../../src/engine/prompt";
import { TaskAuthError } from "../../src/tasks/provider";

// createdAt is *now*, not the epoch: a run minted in 1970 is older than any
// abandonment window, so the retire sweep would carry off every fixture that
// has no ticket. A test about an old run gives its own createdAt.
const mkRun = (over: Partial<Run> = {}): Run => ({
  key: "ASM-1", summary: "do it", url: "https://jira/ASM-1", createdAt: Date.now(), mode: "per-window",
  repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "b" }], briefPaths: [], ...over,
});
const statusFor = (run: Run, ticketCategory: string | null = null): RunStatus => ({
  run, column: "progress", ticketStatus: null, ticketCategory, repos: [],
  agent: { state: "unknown", lastActivityMs: null, slug: null }, windowOpen: false, prs: {}, agents: [],
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
 * `provider().status(key)`, `isAuthenticated()`, and `keyFromUrl()` (through
 * `ticketKeyFor`) — see src/deckView.ts — so nothing else here needs to do
 * anything real. `keyFromUrl` mirrors the real Jira connector's own /browse/
 * parsing (src/tasks/jira/connector.ts) rather than a stub that always answers
 * null: several fixtures below (a local card's inferred ticket, a promoted
 * local card's place-hash key) depend on that url shape actually resolving to
 * a key, exactly as it does against the shipped Jira connector. */
function fakeConnector(authed = false): TaskConnector {
  const BROWSE = "/browse/";
  return {
    id: "jira",
    setupSteps: 2,
    info: () => ({
      label: "Jira", scopeNoun: "project", scopeValue: "ASM", endpoint: "https://jira",
      exampleKey: "ASM-1234", endpointSetting: "agentFlow.jira.baseUrl", scopeSetting: "agentFlow.jira.project",
    }),
    isConfigured: () => true,
    configure: async () => true,
    isAuthenticated: async () => authed,
    signIn: async () => true,
    signOut: async () => undefined,
    provider: () => ({ status: h.getStatus }) as unknown as TaskProvider,
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
const show = (authed = false) => DeckPanel.show(fakeContext().context as any, fakeConnector(authed), () => {});
const settled = () => new Promise<void>((r) => setTimeout(r, 0));

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
  h.buildRunStatus.mock.calls.map((c) => c[0] as { run: Run; agents: CardAgent[] }).filter((i) => i.run.kind === "local").at(-1)!;

/** The last `deck:runs` message actually posted to the webview — the real,
 * host-computed output, as opposed to `builtLocal`/`builtFor` above, which only
 * see what was *passed into* the mocked buildRunStatus. Anything deckView.ts
 * layers on afterward (e.g. inferredTicketKey) only ever shows up here. */
const lastRunsPost = () => posts(lastPanel()).filter((m) => m.type === "deck:runs").at(-1)!;

const sess = (over: Partial<OpenSession> = {}): OpenSession => ({
  pid: 1, sessionId: "s1", cwd: "/r/svc", startedAt: 100, name: "svc-7e", ...over,
});

beforeEach(() => {
  h.runs = [mkRun()];
  h.openInEditor.mockClear().mockResolvedValue(true);
  h.writePlanFile.mockClear();
  h.prReviewPrompt = "Assess the PR for {key}.{files}";
  h.prReviewAutoFix = false;
  h.seedAgent = true;
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
  h.writePrEntry.mockClear();
  h.removePrEntries.mockClear();
  h.prFetch.mockClear().mockResolvedValue({ ok: true, facts: null });
  h.probeGh.mockClear().mockResolvedValue(null);
  h.reviewSearch.mockClear().mockResolvedValue({ issueCount: 1, requests: [reviewFixture()] });
  h.reviewCache = null;
  h.writeReviewCache.mockClear();
  h.reviewDetail.mockClear().mockResolvedValue({ failing: [], unresolved: null });
  h.repos = [{ name: "aws-ops", path: "/repos/aws-ops", isGit: true }];
  h.reviewRequests = true;
  h.openSessions = [];
  h.sessionActivity.mockClear().mockReturnValue({ state: "working", lastActivityMs: 4242, slug: "svc-7e-slug" });
  h.launchReview.mockClear().mockResolvedValue({ ok: true, runKey: "review-aws-ops-8491" });
  h.existsSync.mockClear().mockReturnValue(true);
  h.readFileSync.mockClear().mockReturnValue("");
  h.gitState.mockClear().mockImplementation((name: string, path: string) => ({
    name, path, branch: "b", dirty: false, ahead: 0, added: 0, removed: 0, files: 0,
  }));
  h.reviewWrites = false;
  h.stampLabelOnWrite = true;
  h.reviewSubmit.mockClear().mockResolvedValue({ ok: true });
  h.branch = "ASM-5641-team-table";
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
    expect(runsPost.runs[0].run.key).toBe("ASM-1");
    expect(runsPost.liveSignal).toBe(true);
  });

  it("posts the configured PR-review status so cards can gate the button", async () => {
    show();
    await settled();
    const msg = posts(lastPanel()).find((m) => m.type === "deck:runs");
    expect(msg.prReviewStatus).toBe("PR initiated");
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
    // Asserting the count, not merely that ASM-1 is present, is what actually
    // catches the filter being removed — buildRunStatus is a pass-through stub
    // that would happily produce a card for the review run too.
    expect(msg.runs).toHaveLength(1);
    expect(msg.runs[0].run.key).toBe("ASM-1");
  });

  it("re-posts with liveSignal off when toggled", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:setLive", on: false });
    const runsPost = posts(p).reverse().find((m) => m.type === "deck:runs");
    expect(runsPost.liveSignal).toBe(false);
    expect(h.buildRunStatus).toHaveBeenCalledWith(expect.objectContaining({
      ticket: null, projectsRoot: expect.any(String), nowMs: expect.any(Number),
      liveSignal: false, openIdentities: expect.any(Set), prs: {},
    }));
  });

  it("inspect open re-opens the repo path via the editor", async () => {
    show();
    await lastPanel()._fire({ type: "deck:inspect", key: "ASM-1", action: "open" });
    expect(h.openInEditor).toHaveBeenCalledWith("/r/svc");
  });

  it("inspect open prefers the multi-root workspace file when present", async () => {
    h.runs = [mkRun({ mode: "multiroot", workspaceFile: "/ws/ASM-1.code-workspace" })];
    show();
    await lastPanel()._fire({ type: "deck:inspect", key: "ASM-1", action: "open" });
    expect(h.openInEditor).toHaveBeenCalledWith("/ws/ASM-1.code-workspace");
  });

  it("opens without a success toast (silent focus)", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:inspect", key: "ASM-1", action: "open" });
    expect(h.openInEditor).toHaveBeenCalledWith("/r/svc");
    const successToast = posts(p).find((m) => m.type === "toast" && m.level === "success");
    expect(successToast).toBeUndefined();
  });

  it("toasts an error when opening fails", async () => {
    h.openInEditor.mockResolvedValueOnce(false);
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:inspect", key: "ASM-1", action: "open" });
    const errorToast = posts(p).find((m) => m.type === "toast" && m.level === "error");
    expect(errorToast).toBeTruthy();
  });

  it("inspect diff on a repo with no changes toasts instead of opening a doc", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:inspect", key: "ASM-1", action: "diff" });
    const toast = posts(p).find((m) => m.type === "toast");
    expect(toast.message).toMatch(/No changes to show/i);
    expect(workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it("inspect diff opens the native multi-file editor titled with the run key", async () => {
    h.taskChangedFiles.mockReturnValue([{ status: "M", path: "a.txt", binary: false }]);
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:inspect", key: "ASM-1", action: "diff" });
    const call = commands.executeCommand.mock.calls.at(-1)!;
    expect(call[0]).toBe("vscode.changes");
    expect(call[1]).toBe("Changes in ASM-1");
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
    await p._fire({ type: "deck:inspect", key: "ASM-1", action: "diff" });
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
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:inspect", key: "ASM-1", action: "diff" });
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
    await p._fire({ type: "deck:inspect", key: "ASM-1", action: "diff" });
    const toast = posts(p).find((m) => m.type === "toast");
    expect(toast.message).toMatch(/No changes to show/i);
    expect(workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it("toasts rather than opening an empty editor when only binaries changed", async () => {
    h.taskChangedFiles.mockReturnValue([{ status: "M", path: "pic.bin", binary: true }]);
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:inspect", key: "ASM-1", action: "diff" });
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
    await p._fire({ type: "deck:inspect", key: "ASM-1", action: "diff", repo: "web" });
    expect(h.taskChangedFiles).toHaveBeenCalledWith("/r/web");
    expect(h.taskChangedFiles).not.toHaveBeenCalledWith("/r/svc");
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
    await p._fire({ type: "deck:forget", key: "ASM-1" });
    expect(h.removeRun).toHaveBeenCalledWith("/runs", "ASM-1");
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
    expect(h.getStatus).toHaveBeenCalledWith("ASM-1");
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
    await lastPanel()._fire({ type: "openExternal", url: "https://jira/ASM-1" });
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
    await p._fire({ type: "deck:inspect", key: "ASM-1", action: "open" });
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
    expect(h.getStatus).toHaveBeenCalledWith("ASM-1");
    expect(h.buildRunStatus).toHaveBeenCalledWith(expect.objectContaining({
      ticket: { status: "In Review", category: "indeterminate" },
      projectsRoot: expect.any(String), nowMs: expect.any(Number),
      liveSignal: true, openIdentities: expect.any(Set), prs: {},
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
      liveSignal: true, openIdentities: expect.any(Set), prs: {},
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
    await p._fire({ type: "deck:forget", key: "ASM-1" });
    const loads = posts(p).filter((m) => m.type === "deck:loading").map((m) => m.loading);
    expect(loads).toContain(true);
    expect(loads.at(-1)).toBe(false);
  });

  it("brackets a prFacts toggle with the busy indicator", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:setPrFacts", on: false });
    const loads = posts(p).filter((m) => m.type === "deck:loading").map((m) => m.loading);
    expect(loads).toContain(true);
    expect(loads.at(-1)).toBe(false);
  });

  it("issues every run's Jira lookup at once rather than one at a time", async () => {
    // Serially, a cold board of six runs costs six round trips before anything
    // paints — and Forget waits on that whole pass.
    h.runs = [mkRun(), mkRun({ key: "ASM-2", url: "https://jira/ASM-2" }), mkRun({ key: "ASM-3", url: "https://jira/ASM-3" })];
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

describe("DeckPanel open agents", () => {
  it("attaches every open session in a run's repo to that run's card", async () => {
    h.runs = [mkRun({ key: "ASM-1", repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "ASM-1-x" }] })];
    h.openSessions = [sess(), sess({ pid: 2, sessionId: "s2", startedAt: 200, name: "svc-fa" })];
    show();
    await settled();
    expect(builtFor("ASM-1").agents.map((a) => a.session.name)).toEqual(["svc-7e", "svc-fa"]);
  });

  it("gives a run with no session open an empty agents list", async () => {
    h.runs = [mkRun({ key: "ASM-1" })];
    h.openSessions = [];
    show();
    await settled();
    expect(builtFor("ASM-1").agents).toEqual([]);
  });

  it("does not attach a session running somewhere else", async () => {
    h.runs = [mkRun({ key: "ASM-1", repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "b" }] })];
    h.openSessions = [sess({ cwd: "/r/other", name: "other-1" })];
    show();
    await settled();
    expect(builtFor("ASM-1").agents).toEqual([]);
  });

  it("marks every attached agent's activity unknown when the live signal is off, while still listing the session", async () => {
    // liveSignal off must not drop the session from the card — the registry
    // still knows it's open; only its transcript goes unread.
    h.runs = [mkRun({ key: "ASM-1", repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "b" }] })];
    h.openSessions = [sess()];
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:setLive", on: false });
    const agents = builtFor("ASM-1").agents;
    expect(agents).toHaveLength(1);
    expect(agents[0].session.name).toBe("svc-7e");
    expect(agents[0].activity).toEqual({ state: "unknown", lastActivityMs: null, slug: null });
    expect(h.sessionActivity).not.toHaveBeenCalled();
  });

  it("reads the session's own live activity when the live signal is on, keyed to that session", async () => {
    h.runs = [mkRun({ key: "ASM-1", repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "b" }] })];
    h.openSessions = [sess()];
    show();
    await settled();
    // Called with the session's own cwd and sessionId, not the run's repo path
    // or the place key — a session started in a subdirectory has its transcript
    // filed under that subdirectory, which only the session's own cwd names.
    expect(h.sessionActivity).toHaveBeenCalledWith(expect.any(String), "/r/svc", "s1", expect.any(Number));
    expect(builtFor("ASM-1").agents[0].activity).toEqual({ state: "working", lastActivityMs: 4242, slug: "svc-7e-slug" });
  });

  it("reads no sessions at all with open agents off", async () => {
    h.openAgents = false;
    h.runs = [mkRun({ key: "ASM-1", repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "b" }] })];
    h.openSessions = [sess()];
    show();
    await settled();
    expect(builtFor("ASM-1").agents).toEqual([]);
  });

  it("re-reads when the toggle comes back on", async () => {
    h.openAgents = false;
    h.runs = [mkRun({ key: "ASM-1", repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "b" }] })];
    h.openSessions = [sess()];
    show();
    await settled();
    const p = lastPanel();
    await p._fire({ type: "deck:setOpenAgents", on: true });
    await settled();
    expect(builtFor("ASM-1").agents).toHaveLength(1);
  });

  it("tells the webview which way the toggle is set", async () => {
    h.openAgents = false;
    show();
    await settled();
    const run = posts(lastPanel()).filter((m) => m.type === "deck:runs").at(-1)!;
    expect(run.openAgents).toBe(false);
  });

  it("tags each agent with the run repo whose directory it runs in", async () => {
    h.runs = [mkRun({
      key: "ASM-9",
      repos: [
        { name: "api", path: "/repos/api", isGit: true, branch: "ASM-9-x" },
        { name: "web", path: "/repos/web", isGit: true, branch: "ASM-9-x" },
      ],
    })];
    h.openSessions = [
      sess({ pid: 11, sessionId: "s-api", cwd: "/repos/api", startedAt: 1, name: "api-1a" }),
      sess({ pid: 12, sessionId: "s-web", cwd: "/repos/web", startedAt: 2, name: "web-2b" }),
    ];
    show();
    await settled();
    expect(builtFor("ASM-9").agents.map((a) => [a.session.sessionId, a.repo])).toEqual([
      ["s-api", "api"],
      ["s-web", "web"],
    ]);
  });

  it("tags a local card's agent with the synthetic run's only repo name", async () => {
    h.runs = [];
    h.openSessions = [sess({ cwd: "/r/centaur", name: "centaur-7e" })];
    show();
    await settled();
    const built = builtLocal();
    expect(built.agents.map((a) => a.repo)).toEqual([built.run.repos[0].name]);
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
    h.runs = [mkRun({ key: "ASM-GONE", repos: [{ name: "api", path: "/gone/api", isGit: true, branch: "b" }] })];
    h.existsSync.mockImplementation((p: string) => !p.startsWith("/gone"));
    await sweep();
    expect(lastRuns().map((r) => r.run.key)).not.toContain("ASM-GONE");
    expect(h.removeRun).toHaveBeenCalledWith(expect.any(String), "ASM-GONE");
    expect(h.removePrEntries).toHaveBeenCalledWith(expect.any(String), "ASM-GONE");
  });

  it("stamps a landed run, keeps rendering it, and does not delete it", async () => {
    h.runs = [mkRun({ key: "ASM-DONE" })];
    h.getStatus.mockResolvedValue({ status: "Done", category: "done" });
    await sweep();
    expect(h.writeRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ key: "ASM-DONE", finishedAt: expect.any(Number) }),
    );
    expect(h.removeRun).not.toHaveBeenCalled();
    expect(lastRuns().map((r) => r.run.key)).toContain("ASM-DONE");
  });

  it("retires a landed run once its stamp is older than the window", async () => {
    setConfig({ retireFinishedAfterHours: 1 });
    h.runs = [mkRun({ key: "ASM-OLD", finishedAt: Date.now() - 2 * 3_600_000 })];
    h.getStatus.mockResolvedValue({ status: "Done", category: "done" });
    await sweep();
    expect(h.removeRun).toHaveBeenCalledWith(expect.any(String), "ASM-OLD");
    expect(lastRuns().map((r) => r.run.key)).not.toContain("ASM-OLD");
  });

  it("clears the stamp when a run stops being finished", async () => {
    h.runs = [mkRun({ key: "ASM-BACK", finishedAt: Date.now() - 3_600_000 })];
    await sweep();
    const written = h.writeRun.mock.calls.at(-1)![1] as Run;
    expect(written.key).toBe("ASM-BACK");
    expect("finishedAt" in written).toBe(false);
    expect(h.removeRun).not.toHaveBeenCalled();
  });

  it("still sees open sessions with the Open agents toggle off, so it cannot retire live work", async () => {
    h.openAgents = false;
    h.runs = [mkRun({ key: "ASM-LIVE", repos: [{ name: "api", path: "/repos/api", isGit: true, branch: "b" }] })];
    h.openSessions = [sess({ pid: 3, sessionId: "s1", cwd: "/repos/api", startedAt: 1, name: "api-1a" })];
    h.existsSync.mockReturnValue(false); // rule 1 would fire but for the live session
    await sweep();
    expect(h.removeRun).not.toHaveBeenCalled();
    // The toggle still does its own job: no agents are attached to the card.
    expect(builtFor("ASM-LIVE").agents).toEqual([]);
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
  it("persists the grouping globally and echoes it back on the next post", async () => {
    show();
    await settled();
    const p = lastPanel();
    await p._fire({ type: "deck:setGrouping", grouping: "workspaces" });
    await settled();
    // getConfiguration hands out a fresh stub per call, so the write is asserted
    // across every stub this pass produced rather than against one of them.
    const updates = workspace.getConfiguration.mock.results
      .flatMap((r) => (r.value as { update: { mock: { calls: unknown[][] } } }).update.mock.calls);
    expect(updates).toContainEqual(["deckGrouping", "workspaces", ConfigurationTarget.Global]);
    expect(posts(p).filter((m) => m.type === "deck:runs").at(-1)!.grouping).toBe("workspaces");
  });

  it("posts the grouping the setting already holds, without being asked", async () => {
    setConfig({ deckGrouping: "workspaces" });
    show();
    await settled();
    expect(posts(lastPanel()).filter((m) => m.type === "deck:runs").at(-1)!.grouping).toBe("workspaces");
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
    landedRun("ASM-DONE");
    show(true);
    await settled();
    expect(lastRunsPost().staleCount).toBe(1);
    expect(h.removeRun).not.toHaveBeenCalled(); // counted, not cleared
  });

  it("clears them on request, after the user confirms", async () => {
    landedRun("ASM-DONE");
    show(true);
    await settled();
    const p = lastPanel();
    (window.showWarningMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Clear 1");
    await p._fire({ type: "deck:clearStale" });
    await settled();
    expect(h.removeRun).toHaveBeenCalledWith(expect.any(String), "ASM-DONE");
  });

  it("clears nothing when the user declines", async () => {
    landedRun("ASM-DONE");
    show(true);
    await settled();
    const p = lastPanel();
    (window.showWarningMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    await p._fire({ type: "deck:clearStale" });
    await settled();
    expect(h.removeRun).not.toHaveBeenCalled();
  });

  it("still respects the veto — dirty work is never cleared in bulk", async () => {
    landedRun("ASM-DIRTY");
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
    h.openSessions = [sess({ cwd: "/r/centaur", name: "centaur-7e" })];
    show();
    await settled();
    expect(h.buildRunStatus).toHaveBeenCalledTimes(1);
    expect(builtLocal().agents.map((a) => a.session.name)).toEqual(["centaur-7e"]);
  });

  it("infers the ticket a branch names, and polls Jira for it", async () => {
    h.runs = [];
    h.openSessions = [sess({ cwd: "/r/centaur", name: "centaur-7e" })];
    show(true);
    await settled();
    expect(builtLocal().run.url).toContain("/browse/ASM-5641");
    expect(h.getStatus).toHaveBeenCalledWith("ASM-5641");
  });

  it("infers nothing from a default branch, and polls no Jira", async () => {
    h.runs = [];
    h.branch = "main";
    h.openSessions = [sess({ cwd: "/r/centaur", name: "centaur-7e" })];
    show(true);
    await settled();
    expect(builtLocal().run.url).toBe("");
    expect(h.getStatus).not.toHaveBeenCalled();
  });

  it("sends the inferred ticket key on the wire, so the webview never has to parse a url itself", async () => {
    h.runs = [];
    h.openSessions = [sess({ cwd: "/r/centaur", name: "centaur-7e" })];
    show(true);
    await settled();
    const local = lastRunsPost().runs.find((r: RunStatus) => r.run.kind === "local")!;
    expect(local.inferredTicketKey).toBe("ASM-5641");
  });

  it("omits the inferred ticket key when the branch names no ticket", async () => {
    h.runs = [];
    h.branch = "main";
    h.openSessions = [sess({ cwd: "/r/centaur", name: "centaur-7e" })];
    show(true);
    await settled();
    const local = lastRunsPost().runs.find((r: RunStatus) => r.run.kind === "local")!;
    expect(local.inferredTicketKey).toBeUndefined();
  });

  it("does not make a second card for a place a tracked run already owns", async () => {
    h.runs = [mkRun({ key: "ASM-1", repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "ASM-1-x" }] })];
    h.openSessions = [sess()];
    show();
    await settled();
    expect(h.buildRunStatus).toHaveBeenCalledTimes(1);
  });

  it("makes no local cards with the toggle off", async () => {
    h.openAgents = false;
    h.runs = [];
    h.openSessions = [sess({ cwd: "/r/centaur" })];
    show();
    await settled();
    expect(h.buildRunStatus).not.toHaveBeenCalled();
  });

  it("still makes local cards with the live signal off", async () => {
    // The registry knows a session is open without any transcript being read, so
    // the card appears — its agents just report unknown.
    h.runs = [];
    h.openSessions = [sess({ cwd: "/r/centaur", name: "centaur-7e" })];
    show();
    await settled();
    const p = lastPanel();
    await p._fire({ type: "deck:setLive", on: false });
    await settled();
    const built = builtLocal();
    expect(built.agents).toHaveLength(1);
    expect(built.agents[0].activity.state).toBe("unknown");
  });

  it("opens a local card's directory", async () => {
    h.runs = [];
    h.openSessions = [sess({ cwd: "/r/centaur" })];
    show();
    await settled();
    const p = lastPanel();
    await p._fire({ type: "deck:inspect", key: builtLocal().run.key, action: "open" });
    expect(h.openInEditor).toHaveBeenCalledWith("/r/centaur");
  });
});

describe("DeckPanel track it", () => {
  /** Build one local card, track it, and hand back the record that was written. */
  const trackLocal = async (): Promise<Run> => {
    h.openSessions = [sess({ cwd: "/r/centaur", name: "centaur-7e" })];
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
    expect(written).toMatchObject({ key: "ASM-5641", kind: "task" });
    expect(written.url).toContain("/browse/ASM-5641");
  });

  it("keeps the local key when a tracked run already owns the inferred one", async () => {
    // Writing ASM-5641.json here would silently replace a real launch record.
    h.runs = [mkRun({ key: "ASM-5641" })];
    const written = await trackLocal();
    expect(written.key).toMatch(/^local-/);
    expect(written.kind).toBe("task");
    expect(written.url).toContain("/browse/ASM-5641");
  });

  it("polls the real ticket, not the place-hash, for a record Track it saved under its local key", async () => {
    // Exactly what the previous test just wrote to disk: on the *next* refresh
    // this is a tracked run (`readRuns` would return it), so it is no longer
    // synthesized as a local card and `localTickets`-style bookkeeping never
    // sees it. The ticket must still come from its own url, not its key —
    // otherwise every tick polls Jira for "local-centaur-1a2b3c4d", which 404s
    // forever.
    h.runs = [mkRun({
      key: "local-centaur-1a2b3c4d", url: "https://jira/browse/ASM-5641", kind: "task",
      repos: [{ name: "centaur", path: "/r/centaur", isGit: true, branch: "ASM-5641-team-table" }],
    })];
    show(true);
    const p = lastPanel();
    await p._fire({ type: "deck:refresh" });
    expect(h.getStatus).toHaveBeenCalledWith("ASM-5641");
    expect(h.getStatus).not.toHaveBeenCalledWith("local-centaur-1a2b3c4d");
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
    h.runs = [mkRun({ key: "ASM-1" })];
    h.openSessions = [];
    show();
    await settled();
    await lastPanel()._fire({ type: "deck:track", key: "ASM-1" });
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
    h.runs = [mkRun({ key: "ASM-1", repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "ASM-1-x" }] })];
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
        liveSignal: expect.any(Boolean), openIdentities: expect.any(Set), prs: h.prEntries,
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
    expect(h.prFetch).toHaveBeenCalledWith("/r/svc", "b", "ASM-1");
    expect(h.writePrEntry).toHaveBeenCalledWith("/prfacts", "ASM-1", "svc", expect.objectContaining({ facts: null, fetchedAt: expect.any(Number) }));
  });

  it("searches by the inferred ticket key, not the local place-hash, for an untracked place", async () => {
    // The provider's `--head` search already covers the common case; this is
    // the fallback `--search "<key> in:title"` term specifically. A local
    // card's own key (a place-hash) could never match a PR title — the ticket
    // a branch names is the one string that stands a chance.
    h.runs = [];
    h.openSessions = [sess({ cwd: "/r/centaur", name: "centaur-7e" })];
    await showAndWarm(true);
    expect(h.prFetch).toHaveBeenCalledWith("/r/centaur", "ASM-5641-team-table", "ASM-5641");
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
    expect(h.writePrEntry).toHaveBeenCalledWith("/prfacts", "ASM-1", "svc", expect.objectContaining({ facts: stale, error: true }));
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
    expect(h.writePrEntry).toHaveBeenCalledWith("/prfacts", "ASM-1", "svc", { facts, fetchedAt: expect.any(Number) });
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
    expect(h.prFetch).toHaveBeenCalledWith("/r/svc", "b", "ASM-1");
  });

  it("does not let an in-flight fetch resurrect a forgotten run's cache file", async () => {
    let release!: () => void;
    h.prFetch.mockImplementation(() => new Promise((res) => { release = () => res({ ok: true, facts: null }); }));
    show();
    await settled(); // first tick: only warms the gh probe, no fetch yet
    const p = lastPanel();
    await p._fire({ type: "deck:refresh" }); // second tick: the fetch is now in flight, unresolved
    await p._fire({ type: "deck:forget", key: "ASM-1" }); // forgotten mid-flight
    release(); // resolves *after* the run was forgotten
    await settled();
    expect(h.writePrEntry).not.toHaveBeenCalled();
  });

  it("fetches nothing when prFacts is off, reports it to the webview, and keeps the map empty", async () => {
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
        liveSignal: expect.any(Boolean), openIdentities: expect.any(Set), prs: {},
      }),
    );
    expect(posts(lastPanel()).find((m) => m.type === "deck:runs")).toMatchObject({ prFacts: false });
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
    const p = lastPanel();
    await p._fire({ type: "deck:setPrFacts", on: false });
    h.probeGh.mockClear();
    await p._fire({ type: "deck:setPrFacts", on: true });
    expect(h.probeGh).toHaveBeenCalled();
  });

  it("toggles prFacts from the webview", async () => {
    show();
    await settled();
    const p = lastPanel();
    await p._fire({ type: "deck:setPrFacts", on: false });
    expect(posts(p).filter((m) => m.type === "deck:runs").at(-1)).toMatchObject({ prFacts: false });
  });

  it("forgets a run's PR facts alongside its run record", async () => {
    show();
    await settled();
    await lastPanel()._fire({ type: "deck:forget", key: "ASM-1" });
    expect(h.removePrEntries).toHaveBeenCalledWith("/prfacts", "ASM-1");
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
    expect(h.writePrEntry).toHaveBeenCalledWith("/prfacts", "ASM-1", "svc", expect.objectContaining({ error: true }));
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
        liveSignal: expect.any(Boolean), openIdentities: expect.any(Set), prs: { svc: svcEntry },
      }),
    );
  });

  it("does not let a probe orphaned by a toggle overwrite a fresher one (F6)", async () => {
    // Two probes end up in flight: the one this test lets resolve late must not
    // win over the one started by the re-probe on `deck:setPrFacts on: true`.
    let resolveFirst!: (v: GhGap | null) => void;
    let resolveSecond!: (v: GhGap | null) => void;
    h.probeGh
      .mockImplementationOnce(() => new Promise((res) => { resolveFirst = res; }))
      .mockImplementationOnce(() => new Promise((res) => { resolveSecond = res; }));
    show();
    await settled(); // starts the first probe (left pending)
    const p = lastPanel();
    await p._fire({ type: "deck:setPrFacts", on: false });
    await p._fire({ type: "deck:setPrFacts", on: true }); // resets ghProbe, starts a second probe
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

  it("carries the review-queue toggle on deck:runs so the webview can render its pill", async () => {
    const p = await showAndWarm();
    expect(posts(p).find((m) => m.type === "deck:runs")).toMatchObject({ reviewQueue: true });
    await p._fire({ type: "deck:setReviewQueue", on: false });
    expect(posts(p).filter((m) => m.type === "deck:runs").at(-1)).toMatchObject({ reviewQueue: false });
  });

  it("stops searching and clears the strip when the review queue is toggled off", async () => {
    const p = await showAndWarm();
    expect(h.reviewSearch).toHaveBeenCalledTimes(1);

    await p._fire({ type: "deck:setReviewQueue", on: false });
    expect(posts(p).filter((m) => m.type === "deck:reviews").at(-1)).toMatchObject({
      requests: [], issueCount: 0, enabled: false,
    });
    expect(h.reviewSearch).toHaveBeenCalledTimes(1);
  });

  // The regression this guards: reading `getConfig().reviewRequests` inside
  // reviewsEnabled() rather than the session field. The setting stays true here,
  // so a config read would quietly re-enable the strip on the very next poll and
  // the toggle would appear to do nothing.
  it("keeps the toggle's answer across a refresh, rather than re-reading the setting", async () => {
    h.reviewRequests = true;
    const p = await showAndWarm();
    await p._fire({ type: "deck:setReviewQueue", on: false });
    await p._fire({ type: "deck:refresh" });
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
    await p._fire({ type: "deck:setReviewQueue", on: false });
    await p._fire({ type: "deck:setReviewQueue", on: true });
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

    await p._fire({ type: "deck:setPrFacts", on: false });
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

  it("appends the provenance line to an agent-drafted body", async () => {
    h.reviewWrites = true;
    h.stampLabelOnWrite = true;
    const p = await showAndWarm();
    await p._fire(submitMsg({ verb: "comment", body: "the retry budget is unbounded", fromDraft: true }));
    expect(h.reviewSubmit.mock.calls[0][3]).toBe(
      "the retry budget is unbounded\n\n_Drafted with Claude Code via Agent Flow Deck._",
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

describe("DeckPanel — Address PR", () => {
  it("writes one plan matching the repo window for a per-window run", async () => {
    h.runs = [mkRun()];
    show();
    await lastPanel()._fire({ type: "deck:addressPr", key: "ASM-1" });
    expect(h.writePlanFile).toHaveBeenCalledWith({
      key: "ASM-1",
      createdAt: expect.any(Number),
      seedAgent: true,
      matches: [{
        matchPath: "/r/svc",
        prompt: "Assess the PR for {key}.{files} [key=ASM-1 brief=(relative)]",
      }],
    });
    expect(h.openInEditor).toHaveBeenCalledWith("/r/svc");
  });

  it("matches the workspace file and the launch's own brief for a multiroot run", async () => {
    h.runs = [mkRun({
      mode: "multiroot",
      workspaceFile: "/ws/ASM-1.code-workspace",
      briefPaths: ["/r/svc/.pick-task/TASK.md"],
    })];
    show();
    await lastPanel()._fire({ type: "deck:addressPr", key: "ASM-1" });
    expect(h.writePlanFile).toHaveBeenCalledWith(expect.objectContaining({
      matches: [{
        matchPath: "/ws/ASM-1.code-workspace",
        prompt: "Assess the PR for {key}.{files} [key=ASM-1 brief=/r/svc/.pick-task/TASK.md]",
      }],
    }));
    expect(h.openInEditor).toHaveBeenCalledWith("/ws/ASM-1.code-workspace");
  });

  it("seeds every window of a multi-repo per-window run", async () => {
    h.runs = [mkRun({
      repos: [
        { name: "svc", path: "/r/svc", isGit: true, branch: "b" },
        { name: "ui", path: "/r/ui", isGit: true, branch: "b" },
      ],
    })];
    show();
    await lastPanel()._fire({ type: "deck:addressPr", key: "ASM-1" });
    const plan = h.writePlanFile.mock.calls.at(-1)![0] as { matches: { matchPath: string }[] };
    expect(plan.matches.map((m) => m.matchPath)).toEqual(["/r/svc", "/r/ui"]);
    expect(h.openInEditor).toHaveBeenCalledWith("/r/svc");
    expect(h.openInEditor).toHaveBeenCalledWith("/r/ui");
  });

  it("applies the auto-fix clause when prReviewAutoFix is on", async () => {
    h.prReviewAutoFix = true;
    h.runs = [mkRun()];
    show();
    await lastPanel()._fire({ type: "deck:addressPr", key: "ASM-1" });
    const plan = h.writePlanFile.mock.calls.at(-1)![0] as { matches: { prompt: string }[] };
    expect(plan.matches[0].prompt).toContain(PR_REVIEW_AUTOFIX_CLAUSE);
  });

  it("leaves the run record untouched — the card keeps its launched-at", async () => {
    h.runs = [mkRun({ createdAt: 1_700_000_000_000 })];
    show();
    await lastPanel()._fire({ type: "deck:addressPr", key: "ASM-1" });
    // A positive assertion that the handler actually ran: without it, deleting
    // addressPr outright would still leave writeRun uncalled, and the test below
    // would pass for the wrong reason.
    expect(h.writePlanFile).toHaveBeenCalled();
    expect(h.writeRun).not.toHaveBeenCalled();
    // The record itself still carries its original launched-at — the whole
    // point of not routing through openWorkspace (which stamps a fresh one).
    expect(h.runs.find((r) => r.key === "ASM-1")?.createdAt).toBe(1_700_000_000_000);
  });

  it("opens the window but writes no plan when seedAgent is off", async () => {
    h.seedAgent = false;
    h.runs = [mkRun()];
    show();
    await lastPanel()._fire({ type: "deck:addressPr", key: "ASM-1" });
    expect(h.writePlanFile).not.toHaveBeenCalled();
    expect(h.openInEditor).toHaveBeenCalledWith("/r/svc");
  });

  it("toasts an error when there is no run record for the key", async () => {
    h.runs = [];
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:addressPr", key: "ASM-9" });
    expect(h.writePlanFile).not.toHaveBeenCalled();
    expect(posts(p)).toContainEqual(
      expect.objectContaining({ type: "toast", level: "error", message: "No run record for ASM-9." }),
    );
  });

  it("toasts an error when the run has nothing to open", async () => {
    h.runs = [mkRun({ repos: [] })];
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:addressPr", key: "ASM-1" });
    expect(h.writePlanFile).not.toHaveBeenCalled();
    expect(posts(p)).toContainEqual(
      expect.objectContaining({ type: "toast", level: "error", message: "Nothing to open for ASM-1." }),
    );
  });

  it("toasts an error when the editor refuses to open", async () => {
    h.runs = [mkRun()];
    h.openInEditor.mockResolvedValueOnce(false);
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:addressPr", key: "ASM-1" });
    expect(posts(p)).toContainEqual(
      expect.objectContaining({ type: "toast", level: "error", message: "Couldn't open ASM-1." }),
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
    await p._fire({ type: "deck:addressPr", key: "ASM-1" });
    const toasts = posts(p).filter((m) => m.type === "toast" && m.level === "error");
    // One toast, not one per failing window — and it names both.
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe("Couldn't open ASM-1 (svc, ui).");
  });

  it("uses the real Jira key for the prompt and the plan file, not a promoted local card's place-hash", async () => {
    // track() saves a promoted local card under its place-hash key when the
    // inferred Jira key already belongs to another run — kind: "task", so it
    // still reaches the PR-review status and shows the button — but the ticket
    // itself only lives in its url. run.key here is exactly that hash.
    h.runs = [mkRun({ key: "local-api-1a2b3c4d", url: "https://jira/browse/ASM-7" })];
    show();
    await lastPanel()._fire({ type: "deck:addressPr", key: "local-api-1a2b3c4d" });
    const plan = h.writePlanFile.mock.calls.at(-1)![0] as { key: string; matches: { prompt: string }[] };
    // The mock agentPrompt encodes the ticket key it was given as "[key=...]".
    expect(plan.matches[0].prompt).toContain("[key=ASM-7 ");
    expect(plan.matches[0].prompt).not.toContain("local-api-1a2b3c4d");
    expect(plan.key).toBe("ASM-7");
  });

  it("ignores an addressPr for a local card, even though run(key) can resolve one from localRuns", async () => {
    // The webview never sends this — a local card's button is gated off — but
    // run(key) falls back to the in-memory localRuns map regardless of kind, so
    // the guard has to be enforced here too, not just trusted to the webview.
    h.runs = [];
    h.openSessions = [sess({ cwd: "/r/centaur", name: "centaur-7e" })];
    show();
    await settled();
    const localKey = builtLocal().run.key;
    const p = lastPanel();
    await p._fire({ type: "deck:addressPr", key: localKey });
    await settled();
    expect(h.writePlanFile).not.toHaveBeenCalled();
    expect(h.openInEditor).not.toHaveBeenCalled();
  });

  it("tells the user nothing was seeded when agentFlow.seedAgent is off", async () => {
    h.seedAgent = false;
    h.runs = [mkRun()];
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:addressPr", key: "ASM-1" });
    expect(h.openInEditor).toHaveBeenCalledWith("/r/svc");
    expect(posts(p)).toContainEqual(
      expect.objectContaining({ type: "toast", level: "info", message: expect.stringContaining("agentFlow.seedAgent") }),
    );
  });
});
