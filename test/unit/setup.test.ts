import { describe, it, expect, vi } from "vitest";
import * as vscode from "../_mocks/vscode";
import { setConfig } from "../_mocks/vscode";
import { runSetup, maybeRunSetup, SETUP_COMPLETE_KEY } from "../../src/setup";
import { fakeContext, fakeAuth } from "../_helpers/factories";

const log = vi.fn();

/** Queue the values the wizard's showInputBox steps should resolve to, in order. */
function inputs(...vals: (string | undefined)[]): void {
  const m = vi.mocked(vscode.window.showInputBox);
  for (const v of vals) m.mockResolvedValueOnce(v);
}

/** Read a flowdeck setting back out of the mock config store. */
function readCfg(key: string): unknown {
  return vscode.workspace.getConfiguration("flowdeck").get(key);
}

type Validator = (v: string) => string | undefined;
function validatorFor(step: number): Validator {
  const opts = vi.mocked(vscode.window.showInputBox).mock.calls[step][0] as {
    validateInput: Validator;
  };
  return opts.validateInput;
}

describe("runSetup", () => {
  it("writes config, signs in, sets the flag, and refreshes on the happy path", async () => {
    inputs("https://acme.atlassian.net/", "abc", "~/code/");
    const { context, globalState } = fakeContext();
    const auth = fakeAuth();
    const refresh = vi.fn();

    const ok = await runSetup(context, auth, log, refresh);

    expect(ok).toBe(true);
    expect(readCfg("jira.baseUrl")).toBe("https://acme.atlassian.net"); // trailing slash trimmed
    expect(readCfg("jira.project")).toBe("ABC"); // upper-cased
    expect(readCfg("reposRoot")).toBe("~/code"); // trailing slash trimmed
    expect(readCfg("workspaceDir")).toBe("~/code"); // derived from reposRoot
    expect(readCfg("worktreeRoot")).toBe("~/code/.worktrees"); // derived from reposRoot
    expect(auth.signIn).toHaveBeenCalledTimes(1);
    expect(globalState.get(SETUP_COMPLETE_KEY)).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("aborts and writes nothing when the site URL step is cancelled", async () => {
    inputs(undefined);
    const { context, globalState } = fakeContext();
    const auth = fakeAuth();

    const ok = await runSetup(context, auth, log);

    expect(ok).toBe(false);
    expect(readCfg("jira.baseUrl")).toBeUndefined();
    expect(auth.signIn).not.toHaveBeenCalled();
    expect(globalState.get(SETUP_COMPLETE_KEY)).toBeUndefined();
  });

  it("aborts when the project key step is cancelled", async () => {
    inputs("https://acme.atlassian.net", undefined);
    const { context, globalState } = fakeContext();
    const auth = fakeAuth();

    const ok = await runSetup(context, auth, log);

    expect(ok).toBe(false);
    expect(readCfg("jira.project")).toBeUndefined();
    expect(readCfg("jira.baseUrl")).toBeUndefined(); // nothing persisted until all 3 collected
    expect(auth.signIn).not.toHaveBeenCalled();
    expect(globalState.get(SETUP_COMPLETE_KEY)).toBeUndefined();
  });

  it("aborts when the repos root step is cancelled", async () => {
    inputs("https://acme.atlassian.net", "abc", undefined);
    const { context, globalState } = fakeContext();
    const auth = fakeAuth();

    const ok = await runSetup(context, auth, log);

    expect(ok).toBe(false);
    expect(readCfg("reposRoot")).toBeUndefined();
    expect(auth.signIn).not.toHaveBeenCalled();
    expect(globalState.get(SETUP_COMPLETE_KEY)).toBeUndefined();
  });

  it("saves config but warns and does not complete when sign-in is cancelled", async () => {
    inputs("https://acme.atlassian.net", "abc", "~/code");
    const { context, globalState } = fakeContext();
    const auth = fakeAuth();
    vi.mocked(auth.signIn).mockResolvedValue(false);

    const ok = await runSetup(context, auth, log);

    expect(ok).toBe(false);
    expect(readCfg("jira.baseUrl")).toBe("https://acme.atlassian.net"); // config was saved
    expect(globalState.get(SETUP_COMPLETE_KEY)).toBeUndefined(); // but not marked complete
    expect(vscode.window.showWarningMessage).toHaveBeenCalled();
  });

  it("validates the wizard inputs", async () => {
    inputs("https://acme.atlassian.net", "abc", "~/code");
    await runSetup(fakeContext().context, fakeAuth(), log);

    const url = validatorFor(0);
    expect(url("")).toBeTruthy();
    expect(url("not a url")).toBeTruthy();
    expect(url("http://x.atlassian.net")).toBeTruthy(); // must be https
    expect(url("https://x.atlassian.net")).toBeUndefined();

    const project = validatorFor(1);
    expect(project("  ")).toBeTruthy();
    expect(project("ABC")).toBeUndefined();

    const root = validatorFor(2);
    expect(root("")).toBeTruthy();
    expect(root("~/x")).toBeUndefined();
  });
});

describe("maybeRunSetup", () => {
  it("does nothing when setup is already complete", async () => {
    const { context } = fakeContext({ globalState: { [SETUP_COMPLETE_KEY]: true } });
    await maybeRunSetup(context, fakeAuth(), log);
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("marks complete without prompting when already configured via settings", async () => {
    setConfig({ "jira.baseUrl": "https://acme.atlassian.net", "jira.project": "ABC" });
    const { context, globalState } = fakeContext();

    await maybeRunSetup(context, fakeAuth(), log);

    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    expect(globalState.get(SETUP_COMPLETE_KEY)).toBe(true);
  });

  it("runs the wizard when the user accepts the welcome prompt", async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce("Set up");
    inputs("https://acme.atlassian.net", "abc", "~/code");
    const { context, globalState } = fakeContext();
    const auth = fakeAuth();

    await maybeRunSetup(context, auth, log, vi.fn());

    expect(auth.signIn).toHaveBeenCalled();
    expect(globalState.get(SETUP_COMPLETE_KEY)).toBe(true);
  });

  it("leaves setup pending when the user defers", async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce("Later");
    const { context, globalState } = fakeContext();

    await maybeRunSetup(context, fakeAuth(), log);

    expect(globalState.get(SETUP_COMPLETE_KEY)).toBeUndefined();
  });
});
