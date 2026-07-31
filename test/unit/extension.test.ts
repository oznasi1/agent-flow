import { describe, it, expect, vi, beforeEach } from "vitest";
import { commands, window, setConfig } from "../_mocks/vscode";
import { fakeContext } from "../_helpers/factories";

const authStub = {
  getAuthHeader: vi.fn(async () => "Basic x"),
  isAuthenticated: vi.fn(async () => true),
  signIn: vi.fn(async () => true),
  signOut: vi.fn(async () => undefined),
};
const providerStub = { refresh: vi.fn(async () => undefined), takeTask: vi.fn(async () => undefined) };

const trackSpy = vi.fn();
const initSpy = vi.fn();
const disposeSpy = vi.fn();

vi.mock("../../src/jira/auth", () => ({ ApiTokenAuth: vi.fn(() => authStub) }));
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
  DeckPanel: { show: vi.fn() },
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

import { activate, deactivate } from "../../src/extension";
import { maybeSeedAgent, watchPlansAndSeed } from "../../src/engine/workspace";
import { maybeRunSetup, runSetup } from "../../src/setup";
import { windowIdentity, writePresence, removePresence } from "../../src/engine/presence";
import { MarketplacePanel } from "../../src/marketplaceView";

const cmd = (id: string) =>
  vi.mocked(commands.registerCommand).mock.calls.find((c) => c[0] === id)?.[1] as
    | ((...a: unknown[]) => Promise<unknown>)
    | undefined;

beforeEach(() => {
  authStub.signIn.mockResolvedValue(true);
});

describe("activate", () => {
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
    expect(authStub.signIn).toHaveBeenCalled();
    expect(window.showInformationMessage).toHaveBeenCalled();
    expect(providerStub.refresh).toHaveBeenCalled();
  });

  it("signIn command does not refresh when sign-in is cancelled", async () => {
    authStub.signIn.mockResolvedValue(false);
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
    expect(authStub.signOut).toHaveBeenCalled();
    expect(window.showInformationMessage).toHaveBeenCalled();
  });

  it("takeTask command normalizes the entered key and delegates", async () => {
    vi.mocked(window.showInputBox).mockResolvedValue("  asm-1 ");
    const { context } = fakeContext();
    activate(context);
    await cmd("agentFlow.takeTask")!();
    expect(providerStub.takeTask).toHaveBeenCalledWith("ASM-1");
  });

  it("takeTask command does nothing when the input is cancelled", async () => {
    vi.mocked(window.showInputBox).mockResolvedValue(undefined);
    const { context } = fakeContext();
    activate(context);
    await cmd("agentFlow.takeTask")!();
    expect(providerStub.takeTask).not.toHaveBeenCalled();
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

  it("initialises telemetry before the commands are registered", () => {
    const { context } = fakeContext();
    activate(context);
    const initOrder = initSpy.mock.invocationCallOrder[0];
    const firstRegisterOrder = vi.mocked(commands.registerCommand).mock.invocationCallOrder[0];
    expect(initOrder).toBeLessThan(firstRegisterOrder);
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
    expect(ev.workspace_mode).toBe("auto");
    expect(ev.prompt_modes_count).toBe(6);
  });

  it("does not throw an unhandled rejection when isAuthenticated() rejects", async () => {
    authStub.isAuthenticated.mockRejectedValueOnce(new Error("network down"));
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
    expect(authStub.signIn).toHaveBeenCalled();
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
