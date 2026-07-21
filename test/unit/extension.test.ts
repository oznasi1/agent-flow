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

import { activate, deactivate } from "../../src/extension";
import { maybeSeedAgent, watchPlansAndSeed } from "../../src/engine/workspace";
import { maybeRunSetup, runSetup } from "../../src/setup";
import { windowIdentity, writePresence, removePresence } from "../../src/engine/presence";

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
});
