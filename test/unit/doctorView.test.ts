import { describe, it, expect, vi } from "vitest";
import { commands, env, extensions, window, Uri } from "../_mocks/vscode";
import { collectInputs, showDoctor, probeClaudeExtension, probeChatCommand, type DoctorDeps } from "../../src/doctorView";
import { formatReport, runChecks } from "../../src/engine/doctor";

/** Every seam healthy. Each test spoils exactly one. */
const deps = (over: Partial<DoctorDeps> = {}): DoctorDeps => ({
  config: () => ({
    sourceLabel: "Jira",
    scopeNoun: "project",
    endpoint: "https://jira.test",
    scope: "ASM",
    endpointSetting: "agentFlow.jira.baseUrl",
    scopeSetting: "agentFlow.jira.project",
    reposRoot: "/repos",
    workspaceDir: "/ws",
    repoBlocklist: [],
    prFacts: true,
    agentProvider: "claude-code",
  }),
  hasCredentials: async () => true,
  probe: async () => ({
    auth: { ok: true, displayName: "Jane Doe" },
    scope: { ok: true, name: "Assembly" },
  }),
  which: (bin) => `/usr/bin/${bin}`,
  forge: () => ({ label: "GitHub", cli: "gh", installUrl: "https://cli.github.com" }),
  forgeProbe: async () => null,
  statDir: () => ({ exists: true, writable: true }),
  repos: () => ({ repos: 3, gitRepos: 3 }),
  claudeExtension: () => ({ installed: true, version: "2.1.220" }),
  claudeProjectsReadable: () => true,
  chatCommand: async () => ({ available: false }),
  runs: () => 4,
  log: () => undefined,
  ...over,
});

// The classification that used to be tested here — instanceof JiraAuthError, a
// 404 read as "not-found" — moved behind the connector's own probe() (Task 6);
// see test/unit/tasks/jira/connector.test.ts's "JiraConnector — probe()" suite
// for that coverage now. What's left for collectInputs is: does it forward
// probe()'s verdict verbatim, and does its own hasCredentials gate still hold.
describe("collectInputs — probing the source", () => {
  it("forwards probe()'s auth and scope verdicts verbatim", async () => {
    const i = await collectInputs(deps());
    expect(i.authProbe).toEqual({ ok: true, displayName: "Jane Doe" });
    expect(i.projectProbe).toEqual({ ok: true, name: "Assembly" });
  });

  it("reports whatever shape probe() hands back, unmodified", async () => {
    const i = await collectInputs(
      deps({
        probe: async () => ({
          auth: { ok: false, reason: "auth", message: "Jira auth failed (401). Sign in again." },
        }),
      }),
    );
    expect(i.authProbe).toEqual({ ok: false, reason: "auth", message: "Jira auth failed (401). Sign in again." });
    expect(i.projectProbe).toBeUndefined();
  });

  it("does not call probe() when there are no stored credentials", async () => {
    const probe = vi.fn();
    const i = await collectInputs(deps({ hasCredentials: async () => false, probe }));
    expect(probe).not.toHaveBeenCalled();
    expect(i.authProbe).toBeUndefined();
    expect(i.projectProbe).toBeUndefined();
  });
});

describe("collectInputs — local and tooling probes", () => {
  it("reports git by whether it resolves to a path", async () => {
    expect((await collectInputs(deps())).gitOnPath).toBe(true);
    expect((await collectInputs(deps({ which: () => null }))).gitOnPath).toBe(false);
  });

  it("names where gh was found — the bare-PATH case", async () => {
    const i = await collectInputs(deps({ which: (b) => (b === "gh" ? "/opt/homebrew/bin/gh" : "/usr/bin/git") }));
    expect(i.forge).toEqual({
      label: "GitHub",
      cli: "gh",
      installUrl: "https://cli.github.com",
      gap: null,
      foundAt: "/opt/homebrew/bin/gh",
    });
  });

  it("does not run the gh probe when PR facts are off", async () => {
    const forgeProbe = vi.fn();
    const cfg = deps().config;
    const i = await collectInputs(deps({ config: () => ({ ...cfg(), prFacts: false }), forgeProbe }));
    expect(forgeProbe).not.toHaveBeenCalled();
    expect(i.forge.gap).toBeNull();
    expect(i.prFacts).toBe(false);
  });

  it("carries the configured paths through with their stat results", async () => {
    const i = await collectInputs(
      deps({ statDir: (p) => ({ exists: p === "/repos", writable: p === "/repos" }) }),
    );
    expect(i.reposRoot).toEqual({ path: "/repos", exists: true, repos: 3, gitRepos: 3 });
    expect(i.workspaceDir).toEqual({ path: "/ws", exists: false, writable: false });
  });
});

describe("collectInputs — the agent provider", () => {
  it("forwards the configured provider", async () => {
    const cfg = deps().config;
    const i = await collectInputs(deps({ config: () => ({ ...cfg(), agentProvider: "copilot" }) }));
    expect(i.agentProvider).toBe("copilot");
  });

  it("probes Copilot Chat only when the provider is copilot", async () => {
    const chatCommand = vi.fn(async () => ({ available: true }));
    const cfg = deps().config;
    await collectInputs(deps({ config: () => ({ ...cfg(), agentProvider: "claude-code" }), chatCommand }));
    expect(chatCommand).not.toHaveBeenCalled();

    const i = await collectInputs(deps({ config: () => ({ ...cfg(), agentProvider: "copilot" }), chatCommand }));
    expect(chatCommand).toHaveBeenCalled();
    expect(i.chatCommand).toEqual({ available: true });
  });

  it("also probes the chat command under cursor", async () => {
    const chatCommand = vi.fn(async () => ({ available: true }));
    const cfg = deps().config;
    const i = await collectInputs(deps({ config: () => ({ ...cfg(), agentProvider: "cursor" }), chatCommand }));
    expect(chatCommand).toHaveBeenCalled();
    expect(i.chatCommand).toEqual({ available: true });
  });

  it("forwards ask unresolved — runChecks decides what that means, not collectInputs", async () => {
    const cfg = deps().config;
    const i = await collectInputs(deps({ config: () => ({ ...cfg(), agentProvider: "ask" }) }));
    expect(i.agentProvider).toBe("ask");
  });

  it("also probes the chat command under ask — any host agent could be the one that runs", async () => {
    const chatCommand = vi.fn(async () => ({ available: true }));
    const cfg = deps().config;
    const i = await collectInputs(deps({ config: () => ({ ...cfg(), agentProvider: "ask" }), chatCommand }));
    expect(chatCommand).toHaveBeenCalled();
    expect(i.chatCommand).toEqual({ available: true });
  });

  it("supplies the host's agent providers so runChecks can show ask's full set", async () => {
    env.uriScheme = "vscode";
    expect((await collectInputs(deps())).hostProviders).toEqual(["claude-code", "copilot"]);

    env.uriScheme = "cursor";
    expect((await collectInputs(deps())).hostProviders).toEqual(["claude-code", "cursor"]);

    env.uriScheme = "windsurf";
    expect((await collectInputs(deps())).hostProviders).toEqual(["claude-code"]);
  });
});

describe("showDoctor — the QuickPick", () => {
  it("titles the pick with the summary and marks each row with its status", async () => {
    await showDoctor(deps({ which: () => null })); // one failure: git
    const [items, opts] = window.showQuickPick.mock.calls[0];
    expect((opts as { title: string }).title).toContain("1 problem");
    const labels = (items as { label: string }[]).map((i) => i.label);
    expect(labels[0]).toContain("$(error)");
    expect(labels[0]).toContain("git on PATH");
    expect(labels.some((l) => l.includes("$(pass)"))).toBe(true);
  });

  it("offers a Copy diagnostic report row last", async () => {
    await showDoctor(deps());
    const [items] = window.showQuickPick.mock.calls[0];
    const labels = (items as { label: string }[]).map((i) => i.label);
    expect(labels[labels.length - 1]).toContain("Copy diagnostic report");
  });

  it("shows a healthy machine as everything checking out", async () => {
    await showDoctor(deps());
    const [, opts] = window.showQuickPick.mock.calls[0];
    expect((opts as { title: string }).title).toContain("Everything checks out");
  });

  it("copies the plaintext report to the clipboard when Copy is chosen", async () => {
    const d = deps();
    window.showQuickPick.mockImplementation(async (items: any) => items[items.length - 1]);
    await showDoctor(d);
    const inputs = await collectInputs(d);
    const expected = formatReport(runChecks(inputs), inputs.sourceLabel);
    expect(env.clipboard.writeText).toHaveBeenCalledWith(expected);
  });

  it("runs a check's command action when its row is chosen", async () => {
    window.showQuickPick.mockImplementation(async (items: any) => items[0]);
    await showDoctor(deps({ hasCredentials: async () => false }));
    expect(commands.executeCommand).toHaveBeenCalledWith("agentFlow.signIn");
  });

  it("opens Settings filtered to the key for a setting action", async () => {
    window.showQuickPick.mockImplementation(async (items: any) => items[0]);
    await showDoctor(deps({ statDir: () => ({ exists: false, writable: false }) }));
    expect(commands.executeCommand).toHaveBeenCalledWith("workbench.action.openSettings", "agentFlow.reposRoot");
  });

  it("reveals the extension for an extension action", async () => {
    window.showQuickPick.mockImplementation(async (items: any) => items[0]);
    await showDoctor(deps({ claudeExtension: () => ({ installed: false, version: null }) }));
    expect(commands.executeCommand).toHaveBeenCalledWith("workbench.extensions.search", "anthropic.claude-code");
  });

  it("opens the install page externally for a gh gap", async () => {
    window.showQuickPick.mockImplementation(async (items: any) => items[0]);
    await showDoctor(deps({ forgeProbe: async () => ({ kind: "missing", detail: "spawn ENOENT" }) }));
    expect(Uri.parse).toHaveBeenCalledWith("https://cli.github.com");
    expect(env.openExternal).toHaveBeenCalled();
  });

  it("does nothing when the pick is dismissed", async () => {
    window.showQuickPick.mockResolvedValue(undefined as never);
    await showDoctor(deps({ which: () => null }));
    expect(commands.executeCommand).not.toHaveBeenCalled();
    expect(env.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("does nothing when a passing row with no action is chosen", async () => {
    window.showQuickPick.mockImplementation(async (items: any) => items.find((i: any) => !i.action && i.check));
    await showDoctor(deps());
    expect(commands.executeCommand).not.toHaveBeenCalled();
    expect(env.clipboard.writeText).not.toHaveBeenCalled();
  });
});

describe("probeClaudeExtension", () => {
  it("reads the version out of the installed extension", () => {
    extensions.getExtension.mockReturnValue({ packageJSON: { version: "2.1.300" } } as never);
    expect(probeClaudeExtension()).toEqual({ installed: true, version: "2.1.300" });
    expect(extensions.getExtension).toHaveBeenCalledWith("anthropic.claude-code");
  });

  it("treats an absent extension as not installed", () => {
    extensions.getExtension.mockReturnValue(undefined as never);
    expect(probeClaudeExtension()).toEqual({ installed: false, version: null });
  });

  it("reports installed-but-unversioned rather than guessing", () => {
    extensions.getExtension.mockReturnValue({ packageJSON: {} } as never);
    expect(probeClaudeExtension()).toEqual({ installed: true, version: null });
  });
});

describe("probeChatCommand", () => {
  it("is available when the chat-open command is registered", async () => {
    commands.getCommands.mockResolvedValue(["workbench.action.chat.open", "other.command"]);
    await expect(probeChatCommand()).resolves.toEqual({ available: true });
  });

  it("is unavailable when no chat command is registered — an extension id would false-negative here", async () => {
    commands.getCommands.mockResolvedValue(["some.other.command"]);
    await expect(probeChatCommand()).resolves.toEqual({ available: false });
  });

  it("treats a failed command lookup as unavailable rather than throwing", async () => {
    commands.getCommands.mockRejectedValue(new Error("boom"));
    await expect(probeChatCommand()).resolves.toEqual({ available: false });
  });
});
