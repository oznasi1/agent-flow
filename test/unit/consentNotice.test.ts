import { describe, expect, it } from "vitest";
import * as vscode from "../_mocks/vscode";
import {
  CONSENT_DOCS_URL,
  CONSENT_NOTICE_KEY,
  consentNoticeApplies,
  DETAILS,
  hasExplicitConsentSetting,
  KEEP,
  maybeShowConsentNotice,
  PER_WORKFLOW,
} from "../../src/consentNotice";

function ctx() {
  return { globalState: vscode.makeMemento() } as never;
}
const shown = (c: unknown) => (c as { globalState: { _store: Record<string, unknown> } }).globalState._store[CONSENT_NOTICE_KEY];

describe("hasExplicitConsentSetting", () => {
  it("is true for a value at any scope", () => {
    expect(hasExplicitConsentSetting({ key: "k", globalValue: "flow" })).toBe(true);
    expect(hasExplicitConsentSetting({ key: "k", workspaceValue: "command" })).toBe(true);
    expect(hasExplicitConsentSetting({ key: "k", workspaceFolderValue: "flow" })).toBe(true);
  });

  it("is false when no scope holds one", () => {
    expect(hasExplicitConsentSetting({ key: "k" })).toBe(false);
    expect(hasExplicitConsentSetting(undefined)).toBe(false);
  });
});

describe("consentNoticeApplies", () => {
  it("applies only with the orchestrator on and no explicit choice", () => {
    expect(consentNoticeApplies(true, { key: "k" })).toBe(true);
    expect(consentNoticeApplies(true, undefined)).toBe(true);
    expect(consentNoticeApplies(false, { key: "k" })).toBe(false);
    expect(consentNoticeApplies(undefined, { key: "k" })).toBe(false);
    // An explicit `command` is still a choice: nothing changed for that user.
    expect(consentNoticeApplies(true, { key: "k", globalValue: "command" })).toBe(false);
    expect(consentNoticeApplies(true, { key: "k", globalValue: "flow" })).toBe(false);
  });
});

describe("maybeShowConsentNotice", () => {
  it("says nothing while first-run setup is on screen, and does not mark itself shown", async () => {
    vscode.setConfig({ orchestrator: true });
    const c = ctx();
    await maybeShowConsentNotice(c, { setupRunning: true });
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    expect(shown(c)).toBeUndefined();
  });

  it("says nothing to a user with the orchestrator off, and stays armed for later", async () => {
    const c = ctx();
    await maybeShowConsentNotice(c, { setupRunning: false });
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    expect(shown(c)).toBeUndefined();
  });

  it("says nothing to a user who already chose a mode", async () => {
    vscode.setConfig({ orchestrator: true, commandConsent: "flow" });
    const c = ctx();
    await maybeShowConsentNotice(c, { setupRunning: false });
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("shows once to an orchestrator user on the default, names what changes, and records that it did", async () => {
    vscode.setConfig({ orchestrator: true });
    const c = ctx();
    await maybeShowConsentNotice(c, { setupRunning: false });
    await maybeShowConsentNotice(c, { setupRunning: false });
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
    const [message, ...buttons] = vscode.window.showInformationMessage.mock.calls[0] as string[];
    expect(message).toContain("each distinct shell command");
    expect(message).toContain("asks again");
    expect(buttons).toEqual([KEEP, PER_WORKFLOW, DETAILS]);
    expect(shown(c)).toBe(true);
  });

  it("writes commandConsent: flow globally on 'Ask once per workflow'", async () => {
    vscode.setConfig({ orchestrator: true });
    vscode.window.showInformationMessage.mockResolvedValueOnce(PER_WORKFLOW);
    await maybeShowConsentNotice(ctx(), { setupRunning: false });
    const cfg = vscode.workspace.getConfiguration("agentFlow");
    expect(cfg.get("commandConsent")).toBe("flow");
    expect(vscode.configUpdateTargets.commandConsent).toBe(vscode.ConfigurationTarget.Global);
  });

  it("writes nothing on 'Keep per-command' or dismissal", async () => {
    vscode.setConfig({ orchestrator: true });
    vscode.window.showInformationMessage.mockResolvedValueOnce(KEEP);
    await maybeShowConsentNotice(ctx(), { setupRunning: false });
    await maybeShowConsentNotice(ctx(), { setupRunning: false });
    expect(vscode.workspace.getConfiguration("agentFlow").get("commandConsent")).toBeUndefined();
    expect(vscode.env.openExternal).not.toHaveBeenCalled();
  });

  it("opens the consent docs on 'What changed'", async () => {
    vscode.setConfig({ orchestrator: true });
    vscode.window.showInformationMessage.mockResolvedValueOnce(DETAILS);
    await maybeShowConsentNotice(ctx(), { setupRunning: false });
    expect(vscode.env.openExternal).toHaveBeenCalledTimes(1);
    expect(String((vscode.env.openExternal.mock.calls[0] as unknown[])[0])).toContain(CONSENT_DOCS_URL.slice(-22));
  });

  it("never throws when the notification API fails", async () => {
    vscode.setConfig({ orchestrator: true });
    vscode.window.showInformationMessage.mockRejectedValueOnce(new Error("boom"));
    await expect(maybeShowConsentNotice(ctx(), { setupRunning: false })).resolves.toBeUndefined();
  });
});
