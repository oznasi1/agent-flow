import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { commands, window, workspace, setConfig } from "../_mocks/vscode";
import { fakeContext as rawFakeContext } from "../_helpers/factories";

// The connector's default answer, restored before every test (see beforeEach) so a
// test that overrides it (e.g. "reads the connector's own label") can never leak its
// custom shape into whatever runs after it. `clearMocks: true` (vitest.config.ts)
// clears call history via `mockClear()` before each test but does NOT undo a
// `mockReturnValue()` override — that needs its own reset.
const DEFAULT_CONNECTOR_INFO = {
  label: "Jira",
  scopeNoun: "project",
  scopeValue: "ABC",
  endpoint: "https://x.atlassian.net",
  exampleKey: "ABC-1234",
  endpointSetting: "agentFlow.jira.baseUrl",
  scopeSetting: "agentFlow.jira.project",
};
const connectorStub = {
  id: "jira",
  setupSteps: 2,
  info: vi.fn(() => DEFAULT_CONNECTOR_INFO),
  isConfigured: vi.fn(() => true),
  configure: vi.fn(async () => true),
  isAuthenticated: vi.fn(async () => true),
  signIn: vi.fn(async () => true),
  signOut: vi.fn(async () => undefined),
  provider: vi.fn(() => ({})),
  probe: vi.fn(async () => ({})),
  taskUrl: vi.fn(() => ""),
  keyFromUrl: vi.fn(() => null),
};
const providerStub = {
  refresh: vi.fn(async () => undefined),
  takeTask: vi.fn(async () => undefined),
  postNotepad: vi.fn(() => undefined),
  sweepNotepadImages: vi.fn(() => undefined),
  setAttention: vi.fn(),
};

const trackSpy = vi.fn();
const initSpy = vi.fn();
const disposeSpy = vi.fn();

// Only `resolveConnector` is overridden — `CONNECTOR_IDS` stays real so
// settingsSnapshot's task_source allow-list (which imports it independently)
// keeps seeing the actual registered ids rather than `undefined`.
vi.mock("../../src/tasks/registry", async () => {
  const actual =
    await vi.importActual<typeof import("../../src/tasks/registry")>("../../src/tasks/registry");
  return { ...actual, resolveConnector: vi.fn(() => connectorStub) };
});
vi.mock("../../src/tasksView", () => ({
  TasksViewProvider: Object.assign(vi.fn(() => providerStub), { viewType: "agentFlow.tasks" }),
}));
vi.mock("../../src/engine/workspace", () => ({
  maybeSeedAgent: vi.fn(async () => undefined),
  watchPlansAndSeed: vi.fn(() => ({ dispose: vi.fn() })),
}));
vi.mock("../../src/setup", () => ({
  maybeRunSetup: vi.fn(async () => undefined),
  runSetup: vi.fn(async () => true),
}));
vi.mock("../../src/engine/presence", () => ({
  windowIdentity: vi.fn(() => ({ identity: "/ws/team.code-workspace", kind: "workspace", label: "team.code-workspace", folders: 2 })),
  writePresence: vi.fn(),
  removePresence: vi.fn(),
  defaultWindowsDir: vi.fn(() => "/win"),
}));
vi.mock("../../src/marketplaceView", () => ({
  MarketplacePanel: { show: vi.fn() },
}));
vi.mock("../../src/deckView", () => ({
  DeckPanel: { show: vi.fn(), latestCandidates: vi.fn(() => null) },
  POLL_MS: 6000,
}));
// The gather half of the attention pass — mocked so the "no fresh Deck
// candidates" tests never touch this machine's real ~/.agentflow or
// ~/.claude/projects (and never spawn a real `git` process for a run record
// that happens to live there). `defaultAttentionDeps` is asserted against
// directly (it echoes its input back) rather than left to build real reader
// closures nothing here would exercise.
vi.mock("../../src/engine/attentionFs", () => ({
  gatherAttention: vi.fn(() => [{
    key: "GATHERED-1", agentState: "needs-you", prs: {}, ticketStatus: null,
    hasLiveSession: true, justLaunched: false, hasWorkToLose: false, showAll: false,
  }]),
  defaultAttentionDeps: vi.fn((o: unknown) => o),
}));
vi.mock("../../src/doctorView", () => ({
  showDoctor: vi.fn(async () => undefined),
  defaultDeps: vi.fn(() => ({})),
}));
vi.mock("../../src/telemetry/telemetry", () => ({
  initTelemetry: (...a: unknown[]) => initSpy(...a),
  track: (...a: unknown[]) => trackSpy(...a),
  disposeTelemetry: (...a: unknown[]) => disposeSpy(...a),
}));

import { activate, deactivate, attentionPass } from "../../src/extension";
import { maybeSeedAgent, watchPlansAndSeed } from "../../src/engine/workspace";
import { maybeRunSetup, runSetup } from "../../src/setup";
import { windowIdentity, writePresence, removePresence } from "../../src/engine/presence";
import { MarketplacePanel } from "../../src/marketplaceView";
import { DeckPanel } from "../../src/deckView";
import { gatherAttention, defaultAttentionDeps } from "../../src/engine/attentionFs";
import { BASE_SCHEME } from "../../src/engine/diffView";
import { resolveConnector } from "../../src/tasks/registry";

const cmd = (id: string) =>
  vi.mocked(commands.registerCommand).mock.calls.find((c) => c[0] === id)?.[1] as
    | ((...a: unknown[]) => Promise<unknown>)
    | undefined;

// Every context this file hands to activate() gets disposed in afterEach below —
// otherwise activate()'s notepadPoll setInterval (and anything else pushed onto
// context.subscriptions) outlives the test that created it. Left running, ~30
// undisposed intervals from this file alone fire 6s later while other test files
// share the same worker thread, calling providerStub.postNotepad() long after the
// mock module has moved on — a real, previously-unhandled TypeError under a
// single-threaded run. Wrapping fakeContext here (instead of editing every call
// site) also means any future test that calls it is covered automatically.
const liveContexts: { subscriptions: { dispose(): void }[] }[] = [];
const fakeContext: typeof rawFakeContext = (...args: Parameters<typeof rawFakeContext>) => {
  const result = rawFakeContext(...args);
  liveContexts.push(result.context);
  return result;
};

afterEach(() => {
  // Exercises the real production disposal path (nothing else in this file does):
  // every disposable activate() pushed — commands, the interval, watchPlansAndSeed's
  // handle — gets torn down exactly as VS Code would on deactivate.
  for (const context of liveContexts.splice(0)) {
    for (const sub of context.subscriptions) sub.dispose();
  }
});

beforeEach(() => {
  connectorStub.signIn.mockResolvedValue(true);
  connectorStub.isAuthenticated.mockResolvedValue(true);
  connectorStub.isConfigured.mockReturnValue(true);
  // Re-establish the default every test starts from — see DEFAULT_CONNECTOR_INFO's
  // comment. Without this, a test that calls `connectorStub.info.mockReturnValue(…)`
  // would leak that override into every test that runs after it in this file.
  connectorStub.info.mockReturnValue(DEFAULT_CONNECTOR_INFO);
});

describe("activate", () => {
  it("registers the diff base content provider so the Diff editor's left side resolves", () => {
    const { context } = fakeContext();
    activate(context);

    expect(workspace.registerTextDocumentContentProvider).toHaveBeenCalledWith(
      BASE_SCHEME,
      expect.anything(),
    );
  });

  it("registers the webview provider, all commands, and seeds the agent", () => {
    const { context } = fakeContext();
    activate(context);

    expect(window.registerWebviewViewProvider).toHaveBeenCalledWith("agentFlow.tasks", providerStub);
    const ids = vi.mocked(commands.registerCommand).mock.calls.map((c) => c[0]);
    expect(ids).toEqual(
      expect.arrayContaining([
        "agentFlow.refresh",
        "agentFlow.signIn",
        "agentFlow.signOut",
        "agentFlow.takeTask",
        "agentFlow.setup",
        "agentFlow.openDeck",
        "agentFlow.openMarketplace",
      ]),
    );
    expect(maybeSeedAgent).toHaveBeenCalledWith(context, expect.any(Function));
    expect(watchPlansAndSeed).toHaveBeenCalledTimes(1);
    expect(watchPlansAndSeed).toHaveBeenCalledWith(context, expect.any(Function));
    expect(context.subscriptions.length).toBeGreaterThan(0);
  });

  it("runs the attention pass on every other tick, and the notepad poll on every one", () => {
    // The one place this file drives the shared interval itself, rather than
    // calling attentionPass() directly — proving the wiring (the modulo, and
    // that the call is actually there) rather than just the pass's own logic.
    // DeckPanel.latestCandidates is the first thing attentionPass touches, so
    // its call count is a sound proxy for "did the pass run this tick".
    vi.useFakeTimers();
    try {
      const { context } = fakeContext();
      activate(context);
      vi.advanceTimersByTime(6000);
      expect(providerStub.postNotepad).toHaveBeenCalledTimes(1);
      expect(DeckPanel.latestCandidates).not.toHaveBeenCalled();
      vi.advanceTimersByTime(6000);
      expect(providerStub.postNotepad).toHaveBeenCalledTimes(2);
      expect(DeckPanel.latestCandidates).toHaveBeenCalledTimes(1);
    } finally {
      // The rest of this file (and its afterEach's context.dispose() calls)
      // depends on real timers — this must run even if an assertion above throws.
      vi.useRealTimers();
    }
  });

  it("survives a live-seeding failure — activate does not throw and commands stay registered", () => {
    // watchPlansAndSeed touches the filesystem (mkdir/watch under ~/.agentflow). A throw
    // there must NOT bubble out of activate(), or VS Code disposes every command + the
    // view provider → "command 'agentFlow.setup' not found" and a dead panel.
    vi.mocked(watchPlansAndSeed).mockImplementationOnce(() => {
      throw new Error("EACCES: cannot watch ~/.agentflow/plans");
    });
    const { context } = fakeContext();
    expect(() => activate(context)).not.toThrow();
    const ids = vi.mocked(commands.registerCommand).mock.calls.map((c) => c[0]);
    expect(ids).toEqual(expect.arrayContaining(["agentFlow.setup", "agentFlow.refresh"]));
  });

  it("sweeps orphaned notepad images once on activation", () => {
    const { context } = fakeContext();
    activate(context);
    expect(providerStub.sweepNotepadImages).toHaveBeenCalledTimes(1);
  });

  it("survives a failing image sweep — activate does not throw and commands stay registered", () => {
    // The sweep reads and unlinks under globalStorage. A throw there must not bubble
    // out of activate(), for the same reason the live-seeding failure above must not.
    providerStub.sweepNotepadImages.mockImplementationOnce(() => {
      throw new Error("EACCES: cannot read globalStorage");
    });
    const { context } = fakeContext();
    expect(() => activate(context)).not.toThrow();
    const ids = vi.mocked(commands.registerCommand).mock.calls.map((c) => c[0]);
    expect(ids).toEqual(expect.arrayContaining(["agentFlow.setup", "agentFlow.refresh"]));
  });

  it("offers first-run setup on activation", () => {
    const { context } = fakeContext();
    activate(context);
    expect(maybeRunSetup).toHaveBeenCalledWith(context, expect.anything(), expect.any(Function), expect.any(Function));
  });

  it("setup command runs the setup wizard", async () => {
    const { context } = fakeContext();
    activate(context);
    await cmd("agentFlow.setup")!();
    expect(runSetup).toHaveBeenCalledWith(context, expect.anything(), expect.any(Function), expect.any(Function));
  });

  it("refresh command triggers a provider refresh", async () => {
    const { context } = fakeContext();
    activate(context);
    await cmd("agentFlow.refresh")!();
    expect(providerStub.refresh).toHaveBeenCalled();
  });

  it("registers the openMarketplace command and delegates to MarketplacePanel.show", async () => {
    const { context } = fakeContext();
    activate(context);
    expect(cmd("agentFlow.openMarketplace")).toBeTypeOf("function");
    await cmd("agentFlow.openMarketplace")!();
    expect(MarketplacePanel.show).toHaveBeenCalledWith(context, expect.any(Function));
  });

  it("signIn command refreshes and notifies on success", async () => {
    const { context } = fakeContext();
    activate(context);
    const ok = await cmd("agentFlow.signIn")!();
    expect(ok).toBe(true);
    expect(connectorStub.signIn).toHaveBeenCalled();
    expect(window.showInformationMessage).toHaveBeenCalled();
    expect(providerStub.refresh).toHaveBeenCalled();
  });

  it("signIn command does not refresh when sign-in is cancelled", async () => {
    connectorStub.signIn.mockResolvedValue(false);
    const { context } = fakeContext();
    activate(context);
    const ok = await cmd("agentFlow.signIn")!();
    expect(ok).toBe(false);
    expect(providerStub.refresh).not.toHaveBeenCalled();
    expect(window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("signOut command signs out and notifies", async () => {
    const { context } = fakeContext();
    activate(context);
    await cmd("agentFlow.signOut")!();
    expect(connectorStub.signOut).toHaveBeenCalled();
    expect(window.showInformationMessage).toHaveBeenCalled();
  });

  it("takeTask command normalizes the entered key and delegates, tagging the Take as a command (not a card)", async () => {
    // The palette is the only caller that can know this: takeTask must be told
    // "command" explicitly, since a palette Take is indistinguishable from a
    // collapsed-card Take by its arguments alone (both carry no preselection).
    vi.mocked(window.showInputBox).mockResolvedValue("  asm-1 ");
    const { context } = fakeContext();
    activate(context);
    await cmd("agentFlow.takeTask")!();
    expect(providerStub.takeTask).toHaveBeenCalledWith("ASM-1", "command");
  });

  it("takeTask command does nothing when the input is cancelled", async () => {
    vi.mocked(window.showInputBox).mockResolvedValue(undefined);
    const { context } = fakeContext();
    activate(context);
    await cmd("agentFlow.takeTask")!();
    expect(providerStub.takeTask).not.toHaveBeenCalled();
  });

  it("signIn/signOut toasts and the takeTask prompt read the connector's own label, not a hardcoded 'Jira'", async () => {
    connectorStub.info.mockReturnValue({
      label: "Acme",
      scopeNoun: "board",
      scopeValue: "AT",
      endpoint: "https://acme.example",
      exampleKey: "AT-99",
      endpointSetting: "agentFlow.acme.baseUrl",
      scopeSetting: "agentFlow.acme.board",
    });
    const { context } = fakeContext();
    activate(context);

    await cmd("agentFlow.signIn")!();
    expect(window.showInformationMessage).toHaveBeenCalledWith("Agent Flow Deck: signed in to Acme.");

    await cmd("agentFlow.signOut")!();
    // Its own verb, not a copy-paste of the signIn toast's.
    expect(window.showInformationMessage).toHaveBeenCalledWith("Agent Flow Deck: signed out of Acme.");

    await cmd("agentFlow.takeTask")!();
    expect(window.showInputBox).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Take a Acme task", prompt: "Ticket key (e.g. AT-99)" }),
    );
  });

  it("does not leak the previous test's connector label override", async () => {
    // Regression probe for a leaking mock override: `connectorStub.info` above is
    // switched with `mockReturnValue`, which `clearMocks` (vitest.config.ts) does not
    // undo — only the beforeEach's explicit reset does. Without it this test would
    // see "Acme" here instead of the connector's real default.
    const { context } = fakeContext();
    activate(context);
    await cmd("agentFlow.signIn")!();
    expect(window.showInformationMessage).toHaveBeenCalledWith("Agent Flow Deck: signed in to Jira.");
  });

  it("writes this window's presence on activation", () => {
    const { context } = fakeContext();
    activate(context);
    expect(writePresence).toHaveBeenCalledWith(
      "/win",
      expect.objectContaining({ identity: "/ws/team.code-workspace", pid: expect.any(Number) }),
    );
  });

  it("does not write presence for a window with no identity", () => {
    vi.mocked(windowIdentity).mockReturnValueOnce(undefined);
    const { context } = fakeContext();
    activate(context);
    expect(writePresence).not.toHaveBeenCalled();
  });

  it("removes this window's presence on deactivate", () => {
    deactivate();
    expect(removePresence).toHaveBeenCalledWith("/win", expect.any(Number));
  });

  it("does not track presence when trackOpenWindows is disabled", () => {
    setConfig({ trackOpenWindows: false });
    const { context } = fakeContext();
    activate(context);
    expect(writePresence).not.toHaveBeenCalled();
    expect(window.onDidChangeWindowState).not.toHaveBeenCalled();
  });

  it("re-stamps presence when the window state changes", () => {
    const { context } = fakeContext();
    activate(context);
    const cb = vi.mocked(window.onDidChangeWindowState).mock.calls[0]?.[0] as (() => void) | undefined;
    expect(cb).toBeTypeOf("function");
    vi.mocked(writePresence).mockClear();
    cb!();
    expect(writePresence).toHaveBeenCalledTimes(1);
  });

  it("re-stamps presence when a folder is added or removed from the workspace", () => {
    // `roots` now decides which repos render on this window's card — adding or
    // removing a folder from an already-open multi-root workspace does not
    // reload the extension host, so onDidChangeWindowState's focus-change
    // trigger alone would leave it stale until the user next switches windows.
    const { context } = fakeContext();
    activate(context);
    const cb = vi.mocked(workspace.onDidChangeWorkspaceFolders).mock.calls[0]?.[0] as (() => void) | undefined;
    expect(cb).toBeTypeOf("function");
    vi.mocked(writePresence).mockClear();
    cb!();
    expect(writePresence).toHaveBeenCalledTimes(1);
  });

  it("initialises telemetry before the commands are registered", () => {
    const { context } = fakeContext();
    activate(context);
    const initOrder = initSpy.mock.invocationCallOrder[0];
    const firstRegisterOrder = vi.mocked(commands.registerCommand).mock.invocationCallOrder[0];
    expect(initOrder).toBeLessThan(firstRegisterOrder);
  });

  it("creates the output channel before resolving the connector, since the registry's unknown-id fallback logs through it", () => {
    const { context } = fakeContext();
    activate(context);
    const outputOrder = vi.mocked(window.createOutputChannel).mock.invocationCallOrder[0];
    const connectorOrder = vi.mocked(resolveConnector).mock.invocationCallOrder[0];
    expect(outputOrder).toBeLessThan(connectorOrder);
  });

  it("reports extension_installed on the very first activation only", () => {
    const { context, globalState } = fakeContext();
    activate(context);
    expect(trackSpy.mock.calls.flat().map((e: any) => e.name)).toContain("extension_installed");

    trackSpy.mockClear();
    const { context: context2 } = fakeContext({ sharedGlobalState: globalState });
    activate(context2);
    expect(trackSpy.mock.calls.flat().map((e: any) => e.name)).not.toContain("extension_installed");
  });

  it("reports extension_activated with the settings snapshot", async () => {
    const { context } = fakeContext();
    activate(context);
    await vi.waitFor(() => {
      expect(trackSpy.mock.calls.flat().some((e: any) => e.name === "extension_activated")).toBe(true);
    });
    const ev = trackSpy.mock.calls.flat().find((e: any) => e.name === "extension_activated") as any;
    expect(ev.is_first_ever).toBe(true);
    expect(ev.has_jira_auth).toBe(true);
    // is_configured comes from connector.isConfigured() now, not a raw
    // cfg.baseUrl/cfg.project check — the real (unmocked) getConfig() sees an
    // empty baseUrl/project in this harness, so the old inline check would
    // have reported false here even though the connector reports configured.
    expect(ev.is_configured).toBe(true);
    expect(ev.workspace_mode).toBe("auto");
    expect(ev.prompt_modes_count).toBe(6);
  });

  it("reports is_configured false when the connector says it isn't, regardless of raw settings", async () => {
    connectorStub.isConfigured.mockReturnValue(false);
    const { context } = fakeContext();
    activate(context);
    await vi.waitFor(() => {
      expect(trackSpy.mock.calls.flat().some((e: any) => e.name === "extension_activated")).toBe(true);
    });
    const ev = trackSpy.mock.calls.flat().find((e: any) => e.name === "extension_activated") as any;
    expect(ev.is_configured).toBe(false);
  });

  it("does not throw an unhandled rejection when isAuthenticated() rejects", async () => {
    connectorStub.isAuthenticated.mockRejectedValueOnce(new Error("network down"));
    const { context } = fakeContext();
    expect(() => activate(context)).not.toThrow();
    // Give the rejected promise's handlers a chance to run; a missing rejection
    // handler here would surface as an unhandledRejection failing the test run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(trackSpy.mock.calls.flat().some((e: any) => e.name === "extension_activated")).toBe(false);
  });

  it("does not propagate a failure raised while building extension_activated", async () => {
    // `track()` self-guards internally, but the surrounding getConfig()/settingsSnapshot()
    // calls run inside the isAuthenticated().then() continuation, after activate() has
    // already returned — a throw there must be caught locally, not become an unhandled
    // rejection. The first track() call is the synchronous extension_installed one; make
    // only the second (extension_activated) throw.
    trackSpy.mockImplementationOnce(() => undefined);
    trackSpy.mockImplementationOnce(() => {
      throw new Error("logUsage exploded");
    });
    const { context } = fakeContext();
    expect(() => activate(context)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(trackSpy).toHaveBeenCalledTimes(2);
  });

  it("still activates when telemetry init throws", () => {
    initSpy.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const { context } = fakeContext();
    expect(() => activate(context)).not.toThrow();
    // The commands must still be registered — a telemetry failure cannot dispose them.
    expect(commands.registerCommand).toHaveBeenCalled();
  });

  it("still activates and registers every command when the host-context setContext call throws", () => {
    // The exact failure the try/catch around `setContext("agentFlow.host.vscode", …)`
    // exists to contain (extension.ts:59-63): an uncaught throw there disposes every
    // registration that follows it, per the comment above that try/catch. So the point
    // of this test is proving those registrations still land — not just that
    // activate() itself didn't throw, which alone wouldn't catch a regression that
    // moved the setContext call after the registrations.
    commands.executeCommand.mockImplementationOnce(() => {
      throw new Error("setContext boom");
    });
    const { context } = fakeContext();

    expect(() => activate(context)).not.toThrow();

    // Confirms the throw really came from the setContext call this test means to
    // exercise, not some unrelated first executeCommand call.
    expect(commands.executeCommand).toHaveBeenNthCalledWith(
      1,
      "setContext",
      "agentFlow.host.vscode",
      expect.any(Boolean),
    );

    // Every registration after the try/catch still happens: the view provider…
    expect(window.registerWebviewViewProvider).toHaveBeenCalledWith("agentFlow.tasks", providerStub);
    // …and every command, not just "some" command.
    const ids = vi.mocked(commands.registerCommand).mock.calls.map((c) => c[0]);
    expect(ids).toEqual(
      expect.arrayContaining([
        "agentFlow.refresh",
        "agentFlow.signIn",
        "agentFlow.signOut",
        "agentFlow.takeTask",
        "agentFlow.setup",
        "agentFlow.openDeck",
        "agentFlow.openMarketplace",
        "agentFlow.doctor",
      ]),
    );

    // The failure is logged, not silently swallowed.
    const output = window.createOutputChannel.mock.results[0]?.value as {
      appendLine: ReturnType<typeof vi.fn>;
    };
    expect(output.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("could not set the host context key"),
    );
  });

  it("logs a non-Error setContext throw via String(), not e.message", () => {
    // The catch's message is `e instanceof Error ? e.message : String(e)` — a plain
    // thrown value (not an Error instance) exercises the ternary's other arm, which
    // the Error-throwing test above does not reach.
    commands.executeCommand.mockImplementationOnce(() => {
      throw "setContext boom";
    });
    const { context } = fakeContext();
    expect(() => activate(context)).not.toThrow();
    const output = window.createOutputChannel.mock.results[0]?.value as {
      appendLine: ReturnType<typeof vi.fn>;
    };
    expect(output.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("could not set the host context key: setContext boom"),
    );
  });

  it("still activates and registers every command when the host-context setContext call REJECTS (real-host shape)", async () => {
    // The two setContext tests above throw SYNCHRONOUSLY, which a plain try/catch
    // already handles. The real VS Code host returns a Thenable from
    // executeCommand — a rejection there would escape the synchronous try/catch as
    // an unhandled rejection and never reach the log, unless a rejection handler is
    // attached to the returned promise. This test is the one that would have caught
    // that gap: it makes executeCommand RETURN a rejected promise instead of
    // throwing, and asserts both that the failure is logged and that every
    // registration after it still happens.
    commands.executeCommand.mockImplementationOnce(() => Promise.reject(new Error("setContext boom (async)")));
    const { context } = fakeContext();

    expect(() => activate(context)).not.toThrow();
    // Let the rejection's .then(undefined, ...) handler run.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(commands.executeCommand).toHaveBeenNthCalledWith(
      1,
      "setContext",
      "agentFlow.host.vscode",
      expect.any(Boolean),
    );

    const output = window.createOutputChannel.mock.results[0]?.value as {
      appendLine: ReturnType<typeof vi.fn>;
    };
    expect(output.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("could not set the host context key: setContext boom (async)"),
    );

    // Registrations after the setContext call still land — a lost rejection handler
    // wouldn't break this (the promise rejecting doesn't throw synchronously either
    // way), but it is the same "must not dispose later registrations" guarantee the
    // sync-throw tests pin, restated for the async arm.
    expect(window.registerWebviewViewProvider).toHaveBeenCalledWith("agentFlow.tasks", providerStub);
    const ids = vi.mocked(commands.registerCommand).mock.calls.map((c) => c[0]);
    expect(ids).toEqual(
      expect.arrayContaining([
        "agentFlow.refresh",
        "agentFlow.signIn",
        "agentFlow.signOut",
        "agentFlow.takeTask",
        "agentFlow.setup",
        "agentFlow.openDeck",
        "agentFlow.openMarketplace",
        "agentFlow.doctor",
      ]),
    );
  });

  it("reports command_invoked with the matching command id for every registered command", async () => {
    const { context } = fakeContext();
    activate(context);
    const registered = commands.registerCommand.mock.calls.map(([id]) => id as string);
    expect(registered).toHaveLength(8);

    for (const [id, cb] of commands.registerCommand.mock.calls) {
      trackSpy.mockClear();
      await (cb as (...a: unknown[]) => unknown)();
      const invoked = trackSpy.mock.calls.flat().filter((e: any) => e.name === "command_invoked");
      expect(invoked, `${id} should report exactly one command_invoked`).toHaveLength(1);
      // The payload's `command` must be exactly the id with the "agentFlow." prefix
      // stripped — not just that *some* command_invoked event fired, which would
      // pass even if a future change decoupled the reported id from the real one.
      expect((invoked[0] as any).command, `${id}'s command_invoked payload`).toBe(
        (id as string).slice("agentFlow.".length),
      );
    }
  });

  it("still runs the handler and returns its value when track() throws", async () => {
    const { context } = fakeContext();
    activate(context);
    // Let the async extension_activated continuation settle first so its own
    // track() call doesn't consume the mockImplementationOnce meant for the
    // command below.
    await new Promise((resolve) => setTimeout(resolve, 0));
    trackSpy.mockClear();
    trackSpy.mockImplementationOnce(() => {
      throw new Error("telemetry exploded");
    });

    const ok = await cmd("agentFlow.signIn")!();

    expect(ok).toBe(true);
    expect(connectorStub.signIn).toHaveBeenCalled();
    expect(window.showInformationMessage).toHaveBeenCalled();
  });
});

describe("deactivate", () => {
  it("flushes telemetry", () => {
    deactivate();
    expect(disposeSpy).toHaveBeenCalled();
  });

  it("still flushes telemetry when removePresence throws", () => {
    vi.mocked(removePresence).mockImplementationOnce(() => {
      throw new Error("EACCES: cannot remove presence file");
    });
    expect(() => deactivate()).not.toThrow();
    expect(disposeSpy).toHaveBeenCalled();
  });

  it("still runs removePresence, and does not throw, when disposeTelemetry throws", () => {
    disposeSpy.mockImplementationOnce(() => {
      throw new Error("dispose boom");
    });
    expect(() => deactivate()).not.toThrow();
    expect(removePresence).toHaveBeenCalled();
  });
});

describe("attentionPass", () => {
  it("prefers the open Deck's candidates over gathering its own", () => {
    // Same reduction over the same inputs is what keeps the badge from
    // contradicting the column beside it.
    vi.mocked(DeckPanel.latestCandidates).mockReturnValue({
      candidates: [{ key: "BITE-9", agentState: "needs-you", prs: {}, ticketStatus: null,
        hasLiveSession: true, justLaunched: false, hasWorkToLose: false, showAll: false }],
      at: Date.now(),
    });
    attentionPass(providerStub as never, () => {});
    expect(providerStub.setAttention).toHaveBeenCalledWith(["BITE-9"]);
    // "While the Deck is open the pass costs no I/O at all" — the whole point
    // of preferring the panel's own candidates.
    expect(gatherAttention).not.toHaveBeenCalled();
  });

  it("gathers its own candidates when the Deck's are stale (older than 2 * POLL_MS)", () => {
    // Same shape as the "prefers" test above, but `at` is just past the freshness
    // window — proves the gate actually reads `at`, not just presence/absence of
    // a panel. Without this, deleting the freshness check entirely (always trust
    // whatever the Deck last built) would pass every other test in this file.
    vi.mocked(DeckPanel.latestCandidates).mockReturnValue({
      candidates: [{ key: "STALE-1", agentState: "needs-you", prs: {}, ticketStatus: null,
        hasLiveSession: true, justLaunched: false, hasWorkToLose: false, showAll: false }],
      at: Date.now() - 2 * 6000 - 1,
    });
    attentionPass(providerStub as never, () => {});
    expect(providerStub.setAttention).not.toHaveBeenCalledWith(["STALE-1"]);
    expect(providerStub.setAttention).toHaveBeenCalledWith(["GATHERED-1"]);
  });

  it("gathers its own candidates when no Deck panel is open", () => {
    vi.mocked(DeckPanel.latestCandidates).mockReturnValue(null);
    attentionPass(providerStub as never, () => {});
    // Pins that the gather's own result is what reaches the badge — not just
    // that setAttention was called at all, which runAttentionPass does
    // unconditionally regardless of what candidates() returns.
    expect(providerStub.setAttention).toHaveBeenCalledWith(["GATHERED-1"]);
  });

  it("maps config fields to defaultAttentionDeps by name, not by position", () => {
    vi.mocked(DeckPanel.latestCandidates).mockReturnValue(null);
    setConfig({ inflightShowAll: false, openAgents: true, prFacts: true });
    attentionPass(providerStub as never, () => {});
    expect(defaultAttentionDeps).toHaveBeenCalledWith({
      nowMs: expect.any(Number),
      showAll: false,
      openAgents: true,
      prFacts: true,
    });
  });

  it("does not announce when the window is unfocused, even with notifications on", () => {
    setConfig({ notifyOnActionRequired: true });
    window.state.focused = false;
    vi.mocked(DeckPanel.latestCandidates).mockReturnValue({
      candidates: [{ key: "BITE-9", agentState: "needs-you", prs: {}, ticketStatus: null,
        hasLiveSession: true, justLaunched: false, hasWorkToLose: false, showAll: false }],
      at: Date.now(),
    });
    attentionPass(providerStub as never, () => {});
    expect(providerStub.setAttention).toHaveBeenCalledWith(["BITE-9"]);
    expect(window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("never lets a synchronous read (getConfig, latestCandidates, window.state, the latch path) escape activate()'s interval", () => {
    // attentionPass's own eager reads run before runAttentionPass's internal
    // try/catch. A throw here must be caught right here, matching this file's
    // stated posture (see the comment above the shared poll in extension.ts)
    // that nothing may propagate out of the interval callback.
    vi.mocked(DeckPanel.latestCandidates).mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const log = vi.fn();
    expect(() => attentionPass(providerStub as never, log)).not.toThrow();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("attention:"));
  });
});
