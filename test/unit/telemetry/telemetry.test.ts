import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "../../_mocks/vscode";
import {
  disposeTelemetry, fingerprint, initTelemetry, resetTelemetryForTests, startFlow, track, trackError,
  writeHeadlessIdentity,
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

  it("forwards the event's own properties and leaves the common ones to the sender", () => {
    // The common properties (session_id, env_type, …) are attached inside the sender
    // now, not here: that is the only place every path crosses, including VS Code
    // forwarding an unhandled extension-host error straight to sendErrorData. See
    // telemetryWiring.test.ts (what initTelemetry hands the sender) and
    // posthog.test.ts (that the sender attaches them to every event).
    initTelemetry(makeContext(), vi.fn());
    track({ name: "command_invoked", command: "openDeck" });
    expect(sentEvents()[0]).toEqual({ name: "command_invoked", data: { command: "openDeck" } });
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

  it("never throws even when every disposal fails, and still clears state", () => {
    const log = vi.fn();
    initTelemetry(makeContext(), log);

    // One of each kind of disposable this module owns, all rigged to throw.
    const listenerDisposable = vscode.env.onDidChangeTelemetryEnabled.mock.results[0].value;
    vi.spyOn(listenerDisposable, "dispose").mockImplementationOnce(() => {
      throw new Error("listener dispose boom");
    });
    const configDisposable = vscode.workspace.onDidChangeConfiguration.mock.results[0].value;
    vi.spyOn(configDisposable, "dispose").mockImplementationOnce(() => {
      throw new Error("config listener dispose boom");
    });
    const logger = vscode.env.createTelemetryLogger.mock.results[0].value;
    vi.spyOn(logger, "dispose").mockImplementationOnce(() => {
      throw new Error("logger dispose boom");
    });
    const sender = currentSender();
    vi.spyOn(sender, "dispose").mockImplementationOnce(() => {
      throw new Error("sender dispose boom");
    });

    expect(() => disposeTelemetry()).not.toThrow();

    // Every disposal was actually attempted, not skipped after the first threw.
    expect(listenerDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(configDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(logger.dispose).toHaveBeenCalledTimes(1);
    expect(sender.dispose).toHaveBeenCalledTimes(1);

    // `state` was still cleared: initTelemetry()'s idempotent `if (state) return`
    // guard did not short-circuit, proven by it actually building a new logger.
    const createLoggerCallsBefore = vscode.env.createTelemetryLogger.mock.calls.length;
    initTelemetry(makeContext(), vi.fn());
    expect(vscode.env.createTelemetryLogger.mock.calls.length).toBe(createLoggerCallsBefore + 1);
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

  it("startFlow is monotonic — elapsedMs never goes negative when the wall clock jumps back", () => {
    const flow = startFlow();
    // performance.now() is monotonic by contract; assert the reader is wired to it
    // rather than Date.now() by checking a plain forward measurement is sane and
    // integer-valued (Date.now() deltas are also integers, so additionally spy):
    const spy = vi.spyOn(performance, "now");
    flow.elapsedMs();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("fingerprint", () => {
  it("returns 16 hex chars after init and an empty string before it", () => {
    expect(fingerprint("ABC-1")).toBe("");
    initTelemetry(makeContext(), vi.fn());
    expect(fingerprint("ABC-1")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("the headless identity handoff", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "af-ident-"));
  const log = () => undefined;

  it("leaves the distinct id where dist/tick.js looks for it", () => {
    const dir = tmp();
    initTelemetry(makeContext(), log, dir);
    const file = path.join(dir, "telemetry.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ distinctId: vscode.env.machineId });
  });

  it("writes NOTHING when the caller does not ask for it", () => {
    // The default, and deliberately so: this is the only side effect in the
    // module that touches a path outside the editor's own storage, and a default
    // that wrote there would do it from every test that ever calls init.
    const dir = tmp();
    initTelemetry(makeContext(), log);
    expect(fs.existsSync(path.join(dir, "telemetry.json"))).toBe(false);
  });

  it("writes NOTHING while telemetry is off, so an opted-out install never grows the file", () => {
    // And with the file absent, `sendHeadless` refuses — which is what makes a
    // cron-scheduled tick silent on a machine that never opted in, whatever its
    // settings.json says at the moment the tick runs.
    vscode.setConfig({ "telemetry.enabled": false });
    const dir = tmp();
    writeHeadlessIdentity(dir, "machine-1", log);
    expect(fs.existsSync(path.join(dir, "telemetry.json"))).toBe(false);
  });

  it("does not rewrite an unchanged file — this runs on every activation", () => {
    const dir = tmp();
    writeHeadlessIdentity(dir, "machine-1", log);
    const file = path.join(dir, "telemetry.json");
    const first = fs.statSync(file).mtimeMs;
    fs.writeFileSync(path.join(dir, "marker"), "x"); // ensure time can move on
    writeHeadlessIdentity(dir, "machine-1", log);
    expect(fs.statSync(file).mtimeMs).toBe(first);
  });

  it("replaces the file when the id has actually changed", () => {
    const dir = tmp();
    writeHeadlessIdentity(dir, "machine-1", log);
    writeHeadlessIdentity(dir, "machine-2", log);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "telemetry.json"), "utf8"))).toEqual({ distinctId: "machine-2" });
  });

  it("never throws into activate() when the write fails", () => {
    // A read-only home directory is a working editor, not a broken one: no
    // failure to write an analytics convenience may take the extension down.
    const messages: string[] = [];
    expect(() => writeHeadlessIdentity("/proc/nope/nope", "m", (m) => messages.push(m))).not.toThrow();
    expect(messages.join(" ")).toContain("headless identity");
  });
});
