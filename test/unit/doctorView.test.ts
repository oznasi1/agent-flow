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
    scope: "PROJ",
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

  it("probes the codex CLI under codex and reports where it was found", async () => {
    const which = vi.fn((bin: string) => (bin === "codex" ? "/usr/local/bin/codex" : `/usr/bin/${bin}`));
    const cfg = deps().config;
    const i = await collectInputs(deps({ config: () => ({ ...cfg(), agentProvider: "codex" }), which }));
    expect(which).toHaveBeenCalledWith("codex");
    expect(i.codexCli).toEqual({ foundAt: "/usr/local/bin/codex" });
  });

  it("probes the codex CLI under ask too — codex is on every host's picker", async () => {
    const which = vi.fn((bin: string) => (bin === "codex" ? null : `/usr/bin/${bin}`));
    const cfg = deps().config;
    const i = await collectInputs(deps({ config: () => ({ ...cfg(), agentProvider: "ask" }), which }));
    expect(i.codexCli).toEqual({ foundAt: null });
  });

  it("does not probe the codex CLI under a provider that cannot be codex", async () => {
    const which = vi.fn((bin: string) => `/usr/bin/${bin}`);
    const cfg = deps().config;
    const i = await collectInputs(deps({ config: () => ({ ...cfg(), agentProvider: "claude-code" }), which }));
    expect(which).not.toHaveBeenCalledWith("codex");
    expect(i.codexCli).toBeUndefined();
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
    expect((await collectInputs(deps())).hostProviders).toEqual(["claude-code", "copilot", "codex"]);

    env.uriScheme = "cursor";
    expect((await collectInputs(deps())).hostProviders).toEqual(["claude-code", "cursor", "codex"]);

    env.uriScheme = "windsurf";
    expect((await collectInputs(deps())).hostProviders).toEqual(["claude-code", "codex"]);
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

// Doctor exists for exactly the machines where probes fail — a rejecting probe
// must become a failing row in the report, never a generic host error with no
// report at all.
describe("collectInputs — a broken machine still gets a report", () => {
  const econnreset = () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });

  it("a rejecting source probe becomes a failing auth row instead of aborting", async () => {
    const log = vi.fn();
    const i = await collectInputs(
      deps({
        log,
        probe: async () => {
          throw econnreset();
        },
      }),
    );
    expect(i.authProbe).toEqual({ ok: false, reason: "network", message: expect.stringContaining("ECONNRESET") });
    expect(i.projectProbe).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("ECONNRESET"));
  });

  it("a rejecting credentials check reads as signed out rather than aborting", async () => {
    const i = await collectInputs(
      deps({
        hasCredentials: async () => {
          throw new Error("SecretStorage unavailable");
        },
      }),
    );
    expect(i.hasCredentials).toBe(false);
    expect(i.authProbe).toBeUndefined();
  });

  it("a throwing repo scan reads as an empty root rather than aborting", async () => {
    const i = await collectInputs(
      deps({
        repos: () => {
          throw new Error("EACCES: permission denied");
        },
      }),
    );
    expect(i.reposRoot).toMatchObject({ repos: 0, gitRepos: 0 });
  });

  it("a rejecting forge probe becomes a fail row, never a clean bill of health", async () => {
    const i = await collectInputs(
      deps({
        forgeProbe: async () => {
          throw econnreset();
        },
      }),
    );
    expect(i.forge.gap).toEqual({ kind: "missing", detail: expect.stringContaining("ECONNRESET") });
  });

  it("a rejecting forge mode probe reads as no mode to report", async () => {
    const i = await collectInputs(
      deps({
        forgeMode: async () => {
          throw new Error("spawn bb ENOENT");
        },
      }),
    );
    expect(i.forge.mode).toBeNull();
  });

  it("a throwing runs reader reads as zero runs rather than aborting", async () => {
    const i = await collectInputs(
      deps({
        runs: () => {
          throw new Error("EACCES: permission denied");
        },
      }),
    );
    expect(i.runs).toBe(0);
  });

  it("a throwing PR-reads summary reads as nothing to report", async () => {
    const i = await collectInputs(
      deps({
        prReads: () => {
          throw new Error("corrupt cache");
        },
      }),
    );
    expect(i.prReads).toBeUndefined();
  });
});

describe("showDoctor — never rejects on the machines it diagnoses", () => {
  it("resolves and still renders the QuickPick with a failure when the source probe rejects", async () => {
    await expect(
      showDoctor(
        deps({
          probe: async () => {
            throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
          },
        }),
      ),
    ).resolves.toBeUndefined();
    const [items, opts] = window.showQuickPick.mock.calls[0];
    // The engine reads a network-shaped probe failure as a warning (the site,
    // not the user, is at fault) — the point pinned here is that the failure
    // SURFACES in a rendered report instead of killing the command.
    expect((opts as { title: string }).title).toContain("1 warning");
    const labels = (items as { label: string }[]).map((i) => i.label);
    expect(labels.some((l) => l.includes("$(warning)"))).toBe(true);
  });

  it("resolves with an error message rather than rejecting when even the config read throws", async () => {
    const log = vi.fn();
    await expect(
      showDoctor(
        deps({
          log,
          config: () => {
            throw new Error("config exploded");
          },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("config exploded"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("config exploded"));
  });
});
