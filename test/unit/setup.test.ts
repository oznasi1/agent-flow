import { describe, it, expect, vi } from "vitest";
import * as vscode from "../_mocks/vscode";
import { runSetup, maybeRunSetup, SETUP_COMPLETE_KEY } from "../../src/setup";
import { fakeContext } from "../_helpers/factories";
import { makeFixtureConnector } from "../_helpers/fixtureConnector";
import type { TaskConnector } from "../../src/tasks/provider";

const log = vi.fn();

/** Queue the value(s) the wizard's own showInputBox step (repos root) should
 * resolve to, in order. The connector's own settings (site URL, project key
 * for Jira) are collected by `connector.configure()`, not by this file — that
 * behaviour is the connector's, and lives in its own test (e.g.
 * test/unit/tasks/jira/connector.test.ts). */
function stubInputBox(...vals: (string | undefined)[]): void {
  const m = vi.mocked(vscode.window.showInputBox);
  for (const v of vals) m.mockResolvedValueOnce(v);
}

/** Read an agentFlow setting back out of the mock config store. */
function readCfg(key: string): unknown {
  return vscode.workspace.getConfiguration("agentFlow").get(key);
}

/** A commit thunk for a connector that has settings of its own, so a test can
 * assert WHEN the write happens rather than only that it did. `configure`
 * resolving to one of these means "collected, cancel no longer possible". */
function commitSpy(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => undefined);
}

/** A fixture connector with `configure`/`signIn` wrapped as spies, so a test
 * can assert on calls without redeclaring the connector's whole shape. Override
 * any member per test. */
function connector(over: Partial<TaskConnector> = {}): TaskConnector {
  return {
    ...makeFixtureConnector(),
    configure: vi.fn(async () => async () => undefined),
    signIn: vi.fn(async () => true),
    ...over,
  };
}

describe("runSetup", () => {
  it("numbers the wizard across the connector's steps plus the repos root", async () => {
    const configure = vi.fn(async () => async () => undefined);
    const c = connector({ setupSteps: 2, configure });
    stubInputBox("~/projects");

    await runSetup(fakeContext().context, c, log);

    // 2 connector steps + 1 repos root = 3 total, connector starts at 1.
    expect(configure).toHaveBeenCalledWith(1, 3);
  });

  it("titles the repos-root box with the same total it gave the connector", async () => {
    const c = connector({ setupSteps: 2 });
    stubInputBox("~/projects");

    await runSetup(fakeContext().context, c, log);

    const opts = vi.mocked(vscode.window.showInputBox).mock.calls[0][0] as { title: string };
    expect(opts.title).toBe("Agent Flow Deck Setup (3/3)");
  });

  it("writes the repos root and workspace dir, signs in, sets the flag, and refreshes on the happy path", async () => {
    const c = connector();
    stubInputBox("~/code/");
    const { context, globalState } = fakeContext();
    const refresh = vi.fn();

    const ok = await runSetup(context, c, log, refresh);

    expect(ok).toBe(true);
    expect(c.configure).toHaveBeenCalledWith(1, 2); // fixture connector: setupSteps 1 + repos root
    expect(readCfg("reposRoot")).toBe("~/code"); // trailing slash trimmed
    expect(readCfg("workspaceDir")).toBe("~/code"); // derived from reposRoot
    expect(c.signIn).toHaveBeenCalledTimes(1);
    expect(globalState.get(SETUP_COMPLETE_KEY)).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    // The diagnostic must still name the connector's scope (e.g. a Jira project
    // key), not just the repos root — setup.ts no longer holds that value itself,
    // so it has to come from the connector's own info().
    expect(log).toHaveBeenCalledWith("setup: config saved (board FX, root ~/code)");
  });

  it("does not mark setup complete when the connector's configure is cancelled", async () => {
    const c = connector({ configure: vi.fn(async () => null) });
    const { context, globalState } = fakeContext();

    const ok = await runSetup(context, c, log);

    expect(ok).toBe(false);
    expect(vscode.window.showInputBox).not.toHaveBeenCalled(); // never reached the repos-root step
    expect(c.signIn).not.toHaveBeenCalled();
    expect(globalState.get(SETUP_COMPLETE_KEY)).toBeUndefined();
  });

  it("aborts when the repos root step is cancelled, leaving the connector's own settings unwritten", async () => {
    // The commit spy is the load-bearing assertion: `readCfg("reposRoot")` alone
    // passes even against a connector that writes inside `configure()`, because the
    // fixture has no settings of its own to write. Cancelling here has to leave the
    // SOURCE's settings untouched too — that is what an existing, already-configured
    // user re-running the wizard is promised. The same guarantee is pinned against
    // the real Jira connector in test/unit/compat.test.ts.
    const commit = commitSpy();
    const c = connector({ configure: vi.fn(async () => commit) });
    stubInputBox(undefined);
    const { context, globalState } = fakeContext();

    const ok = await runSetup(context, c, log);

    expect(ok).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(readCfg("reposRoot")).toBeUndefined();
    expect(readCfg("workspaceDir")).toBeUndefined();
    expect(c.signIn).not.toHaveBeenCalled();
    expect(globalState.get(SETUP_COMPLETE_KEY)).toBeUndefined();
  });

  it("commits the connector's settings only after the repos-root step, in the same block as ours", async () => {
    const commit = commitSpy();
    const c = connector({ configure: vi.fn(async () => commit) });
    stubInputBox("~/code");

    await runSetup(fakeContext().context, c, log);

    expect(commit).toHaveBeenCalledTimes(1);
    // Ordering, not just occurrence: the write must follow the box it can abort at.
    const [commitOrder] = commit.mock.invocationCallOrder;
    const [boxOrder] = vi.mocked(vscode.window.showInputBox).mock.invocationCallOrder;
    expect(commitOrder).toBeGreaterThan(boxOrder);
    expect(readCfg("reposRoot")).toBe("~/code");
  });

  it("saves the repos root but warns and does not complete when sign-in is cancelled", async () => {
    const c = connector({ signIn: vi.fn(async () => false) });
    stubInputBox("~/code");
    const { context, globalState } = fakeContext();

    const ok = await runSetup(context, c, log);

    expect(ok).toBe(false);
    expect(readCfg("reposRoot")).toBe("~/code"); // config was saved
    expect(globalState.get(SETUP_COMPLETE_KEY)).toBeUndefined(); // but not marked complete
    expect(vscode.window.showWarningMessage).toHaveBeenCalled();
  });

  it("names the connector's own label in the sign-in-cancelled warning", async () => {
    const fixture = makeFixtureConnector();
    const c = connector({
      signIn: vi.fn(async () => false),
      info: () => ({ ...fixture.info(), label: "Acme Tracker" }),
    });
    stubInputBox("~/code");

    await runSetup(fakeContext().context, c, log);

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      'Agent Flow Deck: settings saved, but Acme Tracker sign-in was cancelled. Use "Sign in to Acme Tracker" to finish.',
    );
  });

  it("validates the repos-root input", async () => {
    const c = connector();
    stubInputBox("~/code");

    await runSetup(fakeContext().context, c, log);

    const opts = vi.mocked(vscode.window.showInputBox).mock.calls[0][0] as {
      validateInput: (v: string) => string | undefined;
    };
    expect(opts.validateInput("")).toBeTruthy();
    expect(opts.validateInput("   ")).toBeTruthy();
    expect(opts.validateInput("~/x")).toBeUndefined();
  });
});

describe("runSetup — settings write failure", () => {
  it("resolves false and warns when persisting settings rejects (read-only settings.json)", async () => {
    // A settings.json the editor cannot write (EROFS, managed machine, corrupt
    // file) makes `getConfiguration().update` reject. The commit block must not
    // escape as an unhandled rejection, must not mark setup complete, and must
    // tell the user something failed instead of dying silently.
    const commit = commitSpy();
    const c = connector({ configure: vi.fn(async () => commit) });
    stubInputBox("~/code");
    vi.mocked(vscode.workspace.getConfiguration).mockImplementation(
      () =>
        ({
          get: vi.fn(),
          inspect: vi.fn((key: string) => ({ key })),
          update: vi.fn(async () => {
            throw Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
          }),
        }) as never,
    );
    const { context, globalState } = fakeContext();

    await expect(runSetup(context, c, log)).resolves.toBe(false);
    expect(globalState.get(SETUP_COMPLETE_KEY)).toBeUndefined();
    expect(c.signIn).not.toHaveBeenCalled(); // don't collect credentials for settings that never landed
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    const [warning] = vi.mocked(vscode.window.showWarningMessage).mock.calls[0] as [string];
    expect(warning).toContain("EROFS");
  });

  it("resolves false and warns when the connector's own commit thunk rejects", async () => {
    const c = connector({
      configure: vi.fn(async () => async () => {
        throw new Error("boom from source commit");
      }),
    });
    stubInputBox("~/code");
    const { context, globalState } = fakeContext();

    await expect(runSetup(context, c, log)).resolves.toBe(false);
    expect(globalState.get(SETUP_COMPLETE_KEY)).toBeUndefined();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
  });
});

describe("runSetup — re-entrancy", () => {
  it("a second concurrent invocation joins the first wizard instead of interleaving", async () => {
    // The wizard is reachable simultaneously from the palette command and the
    // lingering first-run welcome toast. Two interleaved wizards mean duplicate
    // input boxes and duplicate credential prompts; the second call must join
    // the in-flight run rather than start its own.
    const c = connector();
    stubInputBox("~/code");
    const { context, globalState } = fakeContext();

    const first = runSetup(context, c, log);
    const second = runSetup(context, c, log);
    const [r1, r2] = await Promise.all([first, second]);

    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(c.configure).toHaveBeenCalledTimes(1);
    expect(c.signIn).toHaveBeenCalledTimes(1);
    expect(globalState.get(SETUP_COMPLETE_KEY)).toBe(true);
  });

  it("a later invocation after the first settles runs the wizard afresh", async () => {
    const c = connector();
    stubInputBox("~/code", "~/other");
    const { context } = fakeContext();

    await runSetup(context, c, log);
    await runSetup(context, c, log);

    expect(c.configure).toHaveBeenCalledTimes(2);
  });
});

describe("maybeRunSetup", () => {
  it("does nothing when setup is already complete", async () => {
    const { context } = fakeContext({ globalState: { [SETUP_COMPLETE_KEY]: true } });

    await maybeRunSetup(context, connector(), log);

    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("stays quiet when the connector reports itself already configured", async () => {
    const c = connector({ isConfigured: () => true });
    const { context, globalState } = fakeContext();

    await maybeRunSetup(context, c, log);

    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    expect(globalState.get(SETUP_COMPLETE_KEY)).toBe(true);
  });

  it("welcomes the user by the connector's own label", async () => {
    const fixture = makeFixtureConnector();
    const c = connector({
      isConfigured: () => false,
      info: () => ({ ...fixture.info(), label: "Acme Tracker" }),
    });
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce("Later");

    await maybeRunSetup(fakeContext().context, c, log);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Welcome to Agent Flow Deck — let's connect it to your Acme Tracker.",
      "Set up",
      "Later",
    );
  });

  it("runs the wizard when the user accepts the welcome prompt", async () => {
    const c = connector({ isConfigured: () => false });
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce("Set up");
    stubInputBox("~/code");
    const { context, globalState } = fakeContext();

    await maybeRunSetup(context, c, log, vi.fn());

    expect(c.signIn).toHaveBeenCalled();
    expect(globalState.get(SETUP_COMPLETE_KEY)).toBe(true);
  });

  it("leaves setup pending when the user defers", async () => {
    const c = connector({ isConfigured: () => false });
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce("Later");
    const { context, globalState } = fakeContext();

    await maybeRunSetup(context, c, log);

    expect(globalState.get(SETUP_COMPLETE_KEY)).toBeUndefined();
  });
});
