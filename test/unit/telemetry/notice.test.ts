import { describe, expect, it, vi } from "vitest";
import * as vscode from "../../_mocks/vscode";
import { maybeShowTelemetryNotice, NOTICE_KEY } from "../../../src/telemetry/notice";

function ctx() {
  return { globalState: vscode.makeMemento() } as never;
}

describe("maybeShowTelemetryNotice", () => {
  it("shows once and records that it did", async () => {
    const c = ctx();
    await maybeShowTelemetryNotice(c, { setupRunning: false });
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
    expect((c as any).globalState._store[NOTICE_KEY]).toBe(true);
  });

  it("does not show a second time", async () => {
    const c = ctx();
    await maybeShowTelemetryNotice(c, { setupRunning: false });
    await maybeShowTelemetryNotice(c, { setupRunning: false });
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
  });

  it("stays quiet while setup is running, and does not mark itself shown", async () => {
    const c = ctx();
    await maybeShowTelemetryNotice(c, { setupRunning: true });
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    expect((c as any).globalState._store[NOTICE_KEY]).toBeUndefined();
  });

  it("opens the docs on 'What's collected'", async () => {
    vscode.window.showInformationMessage.mockResolvedValueOnce("What's collected");
    await maybeShowTelemetryNotice(ctx(), { setupRunning: false });
    expect(vscode.env.openExternal).toHaveBeenCalled();
  });

  it("writes the global setting on 'Turn off'", async () => {
    const update = vi.fn(async () => undefined);
    vscode.workspace.getConfiguration.mockReturnValue({ get: vi.fn(), update, inspect: vi.fn() } as never);
    vscode.window.showInformationMessage.mockResolvedValueOnce("Turn off");
    await maybeShowTelemetryNotice(ctx(), { setupRunning: false });
    expect(update).toHaveBeenCalledWith("telemetry.enabled", false, vscode.ConfigurationTarget.Global);
  });

  it("never throws when the notification API fails", async () => {
    vscode.window.showInformationMessage.mockRejectedValueOnce(new Error("boom"));
    await expect(maybeShowTelemetryNotice(ctx(), { setupRunning: false })).resolves.toBeUndefined();
  });
});
