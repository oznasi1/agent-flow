import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "../../_mocks/vscode";
import {
  disposeTelemetry, fingerprint, initTelemetry, resetTelemetryForTests, startFlow, track, trackError,
} from "../../../src/telemetry/telemetry";

function makeContext() {
  return {
    globalState: vscode.makeMemento(),
    extensionMode: vscode.ExtensionMode.Development,
    subscriptions: [] as { dispose(): void }[],
  } as never;
}

/** The sender the facade built, reached through the mocked createTelemetryLogger. */
function sentEvents(): { name: string; data: Record<string, unknown> }[] {
  const logger = vscode.env.createTelemetryLogger.mock.results[0]?.value;
  const calls = [...(logger?.logUsage.mock.calls ?? []), ...(logger?.logError.mock.calls ?? [])];
  return calls.map(([name, data]: [string, Record<string, unknown>]) => ({ name, data }));
}

/** The real PostHogSender the facade built — it's the first (and, per test,
 * only) argument createTelemetryLogger was called with. Spying on its own
 * methods (rather than on the module-level createPostHogSender factory) lets
 * a test assert exactly which sender method a consent-withdrawal path called,
 * without caring how the facade obtained the sender. */
function currentSender(): { drop(): void; flush(): Promise<void>; dispose(): void } {
  return vscode.env.createTelemetryLogger.mock.calls[0][0];
}

beforeEach(() => resetTelemetryForTests());
// resetTelemetryForTests() alone is sufficient to isolate — it disposes any
// listeners a previous initTelemetry() registered, same as disposeTelemetry().
afterEach(() => resetTelemetryForTests());

describe("track", () => {
  it("no-ops before init rather than throwing", () => {
    expect(() => track({ name: "extension_installed" })).not.toThrow();
  });

  it("sends through the logger once initialised", () => {
    initTelemetry(makeContext(), vi.fn());
    track({ name: "command_invoked", command: "openDeck" });
    expect(sentEvents().map((e) => e.name)).toContain("command_invoked");
  });

  it("sends nothing when agentFlow.telemetry.enabled is false", () => {
    vscode.setConfig({ "telemetry.enabled": false });
    initTelemetry(makeContext(), vi.fn());
    track({ name: "command_invoked", command: "openDeck" });
    expect(sentEvents()).toHaveLength(0);
  });

  it("sends nothing when the host's telemetry is off", () => {
    vscode.env.isTelemetryEnabled = false;
    initTelemetry(makeContext(), vi.fn());
    track({ name: "command_invoked", command: "openDeck" });
    expect(sentEvents()).toHaveLength(0);
  });

  it("attaches the common properties", () => {
    initTelemetry(makeContext(), vi.fn());
    track({ name: "extension_installed" });
    const data = sentEvents()[0].data;
    expect(data.env_type).toBe("development");
    expect(data.app_name).toBe("Cursor");
    expect(data.session_id).toBe("test-session-id");
  });

  it("never lets a throwing logger reach the caller", () => {
    initTelemetry(makeContext(), vi.fn());
    const logger = vscode.env.createTelemetryLogger.mock.results[0].value;
    logger.logUsage.mockImplementationOnce(() => { throw new Error("boom"); });
    expect(() => track({ name: "extension_installed" })).not.toThrow();
  });

  it("routes error events through logError", () => {
    initTelemetry(makeContext(), vi.fn());
    trackError({ name: "operation_failed", op: "jira_fetch", failure_class: "network", retryable: true });
    const logger = vscode.env.createTelemetryLogger.mock.results[0].value;
    expect(logger.logError).toHaveBeenCalled();
    expect(logger.logUsage).not.toHaveBeenCalled();
  });

  it("never lets a throwing logger reach the caller from trackError either", () => {
    initTelemetry(makeContext(), vi.fn());
    const logger = vscode.env.createTelemetryLogger.mock.results[0].value;
    logger.logError.mockImplementationOnce(() => { throw new Error("boom"); });
    expect(() =>
      trackError({ name: "operation_failed", op: "jira_fetch", failure_class: "network", retryable: true }),
    ).not.toThrow();
  });

  it("treats a broken configuration read as consent withheld rather than throwing", () => {
    initTelemetry(makeContext(), vi.fn());
    vscode.workspace.getConfiguration.mockImplementationOnce(() => { throw new Error("boom"); });
    expect(() => track({ name: "extension_installed" })).not.toThrow();
    expect(sentEvents()).toHaveLength(0);
  });
});

describe("consent withdrawn mid-session", () => {
  it("drops the queue instead of flushing it when the host's telemetry flag flips off", () => {
    const log = vi.fn();
    initTelemetry(makeContext(), log);
    track({ name: "extension_installed" });
    const sender = currentSender();
    const dropSpy = vi.spyOn(sender, "drop");
    const flushSpy = vi.spyOn(sender, "flush");
    vscode.fireTelemetryEnabled(false);
    expect(dropSpy).toHaveBeenCalledTimes(1);
    expect(flushSpy).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(" ")).toMatch(/discarded|consent withdrawn/i);
  });

  it("drops the queue instead of flushing it when agentFlow.telemetry.enabled flips to false", () => {
    const log = vi.fn();
    initTelemetry(makeContext(), log);
    track({ name: "extension_installed" });
    const sender = currentSender();
    const dropSpy = vi.spyOn(sender, "drop");
    const flushSpy = vi.spyOn(sender, "flush");
    vscode.setConfig({ "telemetry.enabled": false });
    vscode.fireConfigurationChanged("agentFlow.telemetry.enabled");
    expect(dropSpy).toHaveBeenCalledTimes(1);
    expect(flushSpy).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(" ")).toMatch(/discarded|consent withdrawn/i);
  });

  it("ignores unrelated configuration changes", () => {
    const log = vi.fn();
    initTelemetry(makeContext(), log);
    track({ name: "extension_installed" });
    const sender = currentSender();
    const dropSpy = vi.spyOn(sender, "drop");
    vscode.fireConfigurationChanged("agentFlow.reposRoot");
    expect(dropSpy).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(" ")).not.toMatch(/discarded|consent withdrawn/i);
  });
});

describe("resetTelemetryForTests / disposeTelemetry isolation", () => {
  it("disposeTelemetry disposes the sender and stops its listeners from firing", () => {
    const log = vi.fn();
    initTelemetry(makeContext(), log);
    const sender = currentSender();
    const disposeSpy = vi.spyOn(sender, "dispose");
    disposeTelemetry();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    log.mockClear();
    vscode.fireTelemetryEnabled(false);
    expect(log).not.toHaveBeenCalled();
  });

  it("resetting between tests disposes the previous listeners instead of leaking them", () => {
    const staleLog = vi.fn();
    initTelemetry(makeContext(), staleLog);
    resetTelemetryForTests();

    const currentLog = vi.fn();
    initTelemetry(makeContext(), currentLog);
    vscode.fireTelemetryEnabled(false);

    // Exactly one listener responds: the current test's, not the stale one
    // from before reset.
    expect(staleLog).not.toHaveBeenCalled();
    expect(currentLog).toHaveBeenCalledTimes(1);
  });
});

describe("startFlow", () => {
  it("mints a distinct id per flow and measures elapsed time", () => {
    const a = startFlow();
    const b = startFlow();
    expect(a.id).not.toBe(b.id);
    expect(a.elapsedMs()).toBeGreaterThanOrEqual(0);
  });
});

describe("fingerprint", () => {
  it("returns 16 hex chars after init and an empty string before it", () => {
    expect(fingerprint("ABC-1")).toBe("");
    initTelemetry(makeContext(), vi.fn());
    expect(fingerprint("ABC-1")).toMatch(/^[0-9a-f]{16}$/);
  });
});
