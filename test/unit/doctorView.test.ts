import { describe, it, expect, vi } from "vitest";
import { commands, env, extensions, window, Uri } from "../_mocks/vscode";
import { collectInputs, showDoctor, probeClaudeExtension, type DoctorDeps } from "../../src/doctorView";
import { JiraAuthError, JiraApiError } from "../../src/jira/client";
import { formatReport, runChecks } from "../../src/engine/doctor";

/** Every seam healthy. Each test spoils exactly one. */
const deps = (over: Partial<DoctorDeps> = {}): DoctorDeps => ({
  config: () => ({
    baseUrl: "https://jira.test",
    project: "ASM",
    reposRoot: "/repos",
    workspaceDir: "/ws",
    repoBlocklist: [],
    prFacts: true,
  }),
  hasCredentials: async () => true,
  probeMyself: async () => ({ accountId: "a1", displayName: "Jane Doe" }),
  getProject: async () => ({ id: "1", key: "ASM", name: "Assembly" }),
  which: (bin) => `/usr/bin/${bin}`,
  gh: async () => null,
  statDir: () => ({ exists: true, writable: true }),
  repos: () => ({ repos: 3, gitRepos: 3 }),
  claudeExtension: () => ({ installed: true, version: "2.1.220" }),
  claudeProjectsReadable: () => true,
  runs: () => 4,
  log: () => undefined,
  ...over,
});

describe("collectInputs — Jira probes", () => {
  it("records a successful probe with the display name", async () => {
    const i = await collectInputs(deps());
    expect(i.authProbe).toEqual({ ok: true, displayName: "Jane Doe" });
    expect(i.projectProbe).toEqual({ ok: true, name: "Assembly" });
  });

  it("classifies a JiraAuthError as the credentials' fault", async () => {
    const i = await collectInputs(
      deps({
        probeMyself: async () => {
          throw new JiraAuthError("Jira auth failed (401). Sign in again.");
        },
      }),
    );
    expect(i.authProbe).toEqual({ ok: false, reason: "auth", message: "Jira auth failed (401). Sign in again." });
  });

  it("classifies any other error as a reachability problem, verbatim", async () => {
    const i = await collectInputs(
      deps({
        probeMyself: async () => {
          throw new Error("Jira didn't respond within 15s (https://jira.test).");
        },
      }),
    );
    expect(i.authProbe).toEqual({
      ok: false,
      reason: "network",
      message: "Jira didn't respond within 15s (https://jira.test).",
    });
  });

  it("does not probe at all when there are no stored credentials", async () => {
    const probeMyself = vi.fn();
    const getProject = vi.fn();
    const i = await collectInputs(deps({ hasCredentials: async () => false, probeMyself, getProject }));
    expect(probeMyself).not.toHaveBeenCalled();
    expect(getProject).not.toHaveBeenCalled();
    expect(i.authProbe).toBeUndefined();
    expect(i.projectProbe).toBeUndefined();
  });

  it("skips the project lookup when the credentials were rejected — it cannot succeed", async () => {
    const getProject = vi.fn();
    const i = await collectInputs(
      deps({
        probeMyself: async () => {
          throw new JiraAuthError("nope");
        },
        getProject,
      }),
    );
    expect(getProject).not.toHaveBeenCalled();
    expect(i.projectProbe).toBeUndefined();
  });

  it("skips the project lookup when no project is configured", async () => {
    const getProject = vi.fn();
    const cfg = deps().config;
    await collectInputs(deps({ config: () => ({ ...cfg(), project: "" }), getProject }));
    expect(getProject).not.toHaveBeenCalled();
  });

  it("reads a 404 as a key that isn't there, through describeJiraError", async () => {
    const i = await collectInputs(
      deps({
        getProject: async () => {
          throw new JiraApiError(404, "No project could be found.", {}, ["No project could be found"]);
        },
      }),
    );
    expect(i.projectProbe).toEqual({ ok: false, reason: "not-found", message: "No project could be found." });
  });

  it("reads any other project failure as an error, not a missing key", async () => {
    const i = await collectInputs(
      deps({
        getProject: async () => {
          throw new Error("Couldn't reach Jira at https://jira.test");
        },
      }),
    );
    expect(i.projectProbe).toEqual({
      ok: false,
      reason: "error",
      message: "Couldn't reach Jira at https://jira.test",
    });
  });
});

describe("collectInputs — local and tooling probes", () => {
  it("reports git by whether it resolves to a path", async () => {
    expect((await collectInputs(deps())).gitOnPath).toBe(true);
    expect((await collectInputs(deps({ which: () => null }))).gitOnPath).toBe(false);
  });

  it("names where gh was found — the bare-PATH case", async () => {
    const i = await collectInputs(deps({ which: (b) => (b === "gh" ? "/opt/homebrew/bin/gh" : "/usr/bin/git") }));
    expect(i.gh).toEqual({ gap: null, foundAt: "/opt/homebrew/bin/gh" });
  });

  it("does not run the gh probe when PR facts are off", async () => {
    const gh = vi.fn();
    const cfg = deps().config;
    const i = await collectInputs(deps({ config: () => ({ ...cfg(), prFacts: false }), gh }));
    expect(gh).not.toHaveBeenCalled();
    expect(i.gh).toBeUndefined();
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
    const expected = formatReport(runChecks(await collectInputs(d)));
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
    await showDoctor(deps({ gh: async () => ({ kind: "missing", detail: "spawn ENOENT" }) }));
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
