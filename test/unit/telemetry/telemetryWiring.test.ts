import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "../../_mocks/vscode";
import type { PostHogSenderDeps } from "../../../src/telemetry/posthog";

/** These tests are about what initTelemetry HANDS the sender, so the sender itself is
 * a stub: with the shipped placeholder API key a real PostHogSender no-ops before it
 * ever touches its deps, which would make the wiring invisible. The gate's own
 * behaviour (that a false `isConsented` stops even the host's unhandled-error path)
 * is covered in posthog.test.ts, against the real sender. */
const senderStub = {
  sendEventData: vi.fn(),
  sendErrorData: vi.fn(),
  flush: vi.fn(async () => undefined),
  drop: vi.fn(),
  dispose: vi.fn(),
};
const createSenderSpy = vi.fn((_deps: PostHogSenderDeps) => senderStub);

vi.mock("../../../src/telemetry/posthog", async () => {
  const actual = await vi.importActual<typeof import("../../../src/telemetry/posthog")>(
    "../../../src/telemetry/posthog",
  );
  return { ...actual, createPostHogSender: (deps: PostHogSenderDeps) => createSenderSpy(deps) };
});

import { initTelemetry, resetTelemetryForTests, track } from "../../../src/telemetry/telemetry";

function makeContext(mode: number = vscode.ExtensionMode.Development) {
  return {
    globalState: vscode.makeMemento(),
    extensionMode: mode,
    subscriptions: [] as { dispose(): void }[],
  } as never;
}

/** The deps initTelemetry built the sender with. */
function senderDeps(): PostHogSenderDeps {
  return createSenderSpy.mock.calls[0][0];
}

beforeEach(() => resetTelemetryForTests());
afterEach(() => resetTelemetryForTests());

describe("initTelemetry's sender wiring", () => {
  it("gives the sender a live consent gate, not a snapshot of the setting", () => {
    initTelemetry(makeContext(), vi.fn());
    const { isConsented } = senderDeps();
    expect(isConsented()).toBe(true);

    // Turning agentFlow.telemetry.enabled off must be visible to the sender
    // immediately — this is what stops the paths that never call track()/trackError(),
    // above all VS Code forwarding an unhandled extension-host error to
    // sender.sendErrorData on its own.
    vscode.setConfig({ "telemetry.enabled": false });
    expect(isConsented()).toBe(false);

    // …and turning it back on in the same session must resume sending, which is why
    // withdrawing consent drops the queue instead of disposing the sender.
    vscode.setConfig({ "telemetry.enabled": true });
    expect(isConsented()).toBe(true);
  });

  it("treats a broken configuration read as consent withheld", () => {
    initTelemetry(makeContext(), vi.fn());
    const { isConsented } = senderDeps();
    vscode.workspace.getConfiguration.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    expect(isConsented()).toBe(false);
  });

  it("gives the sender the common properties, so every event path carries them", () => {
    initTelemetry(makeContext(), vi.fn());
    expect(senderDeps().commonProperties).toEqual({
      session_id: "test-session-id",
      env_type: "development",
      app_name: "Cursor",
      app_host: "desktop",
      remote_name: "local",
      ui_kind: "desktop",
    });
    expect(senderDeps().distinctId).toBe("test-machine-id");
  });

  it("reports env_type production for a production extension host", () => {
    initTelemetry(makeContext(vscode.ExtensionMode.Production), vi.fn());
    expect(senderDeps().commonProperties.env_type).toBe("production");
  });

  it("does not merge the common properties a second time on the way to the logger", () => {
    // Single source of truth: the sender attaches them for every path (including
    // the host's own error path, which never reaches this facade). Merging here as
    // well — or passing `additionalCommonProperties` — would just duplicate them.
    initTelemetry(makeContext(), vi.fn());
    track({ name: "command_invoked", command: "openDeck" });
    const logger = vscode.env.createTelemetryLogger.mock.results[0].value;
    expect(logger.logUsage).toHaveBeenCalledWith("command_invoked", { command: "openDeck" });
    expect(vscode.env.createTelemetryLogger.mock.calls[0][1]).toBeUndefined();
  });
});
