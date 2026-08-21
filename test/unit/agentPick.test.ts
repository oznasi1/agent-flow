import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env, window } from "../_mocks/vscode";
import { providerPin, resolveBatchProvider } from "../../src/agentPick";
import type { AgentFlowConfig } from "../../src/config";

// `resolveBatchProvider` takes its config as an argument, so a literal is enough —
// no need to drive `getConfig` and the whole settings store to ask one question.
const cfg = (over: Partial<AgentFlowConfig> = {}) =>
  ({ agentProvider: "ask", seedAgent: true, ...over }) as AgentFlowConfig;

const scheme = env.uriScheme;
beforeEach(() => {
  window.showQuickPick.mockReset();
  env.uriScheme = "cursor"; // Cursor offers claude-code AND cursor, so there is a question
});
afterEach(() => {
  env.uriScheme = scheme;
});

describe("resolveBatchProvider", () => {
  it("does not ask when the setting names an agent", async () => {
    expect(await resolveBatchProvider(cfg({ agentProvider: "cursor" }), true)).toBe("cursor");
    expect(window.showQuickPick).not.toHaveBeenCalled();
  });

  it("does not ask when seeding is off", async () => {
    // Nothing is going to be started, so there is nothing to ask about — the same
    // condition `openWorkspace` guards its own picker with.
    await resolveBatchProvider(cfg({ seedAgent: false }), true);
    expect(window.showQuickPick).not.toHaveBeenCalled();
  });

  it("does not ask on a host with only one possible agent", async () => {
    env.uriScheme = "windsurf"; // neither VS Code nor Cursor
    expect(await resolveBatchProvider(cfg(), true)).toBe("claude-code");
    expect(window.showQuickPick).not.toHaveBeenCalled();
  });

  it("returns undefined when the picker is dismissed, so the caller can abandon", async () => {
    window.showQuickPick.mockResolvedValueOnce(undefined);
    expect(await resolveBatchProvider(cfg(), true)).toBeUndefined();
  });

  it("asks once, in openWorkspace's voice, and answers for the whole batch", async () => {
    window.showQuickPick.mockImplementationOnce(async (items: any) => items[1]);
    expect(await resolveBatchProvider(cfg(), true)).toBe("cursor");
    const opts = window.showQuickPick.mock.calls[0][1] as { title: string; placeHolder: string };
    expect(opts.title).toBe("Which agent?");
    expect(opts.placeHolder).toContain("every task in this batch");
  });

  it("says 'this session' when the launch is not really a batch", async () => {
    // A one-key batch reaches here only because a shared window seeds from plan files
    // and cannot ask later. It is a single launch, so it gets the single-launch words.
    window.showQuickPick.mockImplementationOnce(async (items: any) => items[0]);
    await resolveBatchProvider(cfg(), false);
    const opts = window.showQuickPick.mock.calls[0][1] as { placeHolder: string };
    expect(opts.placeHolder).toContain("this session");
  });
});

describe("providerPin", () => {
  it("pins only under ask — absent is how 'read the setting live' is spelled", () => {
    expect(providerPin(cfg({ agentProvider: "ask" }), "cursor")).toEqual({ provider: "cursor" });
    expect(providerPin(cfg({ agentProvider: "claude-code" }), "cursor")).toEqual({});
  });
});
