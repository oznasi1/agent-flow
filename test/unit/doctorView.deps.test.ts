import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// The injected-deps tests (doctorView.test.ts) cover collectInputs' own logic;
// this file covers the wiring those deliberately bypass — the filesystem probe
// and what defaultDeps actually calls on the connector and on getConfig().
vi.mock("../../src/config", () => ({ getConfig: vi.fn() }));
vi.mock("../../src/engine/repos", () => ({ discoverRepos: vi.fn(() => []) }));
vi.mock("../../src/engine/forge/registry", () => ({
  resolveForge: vi.fn(() => ({
    label: "GitHub",
    cli: { name: "gh", installUrl: "https://cli.github.com" },
    probe: vi.fn(async () => null),
  })),
}));
vi.mock("../../src/engine/pr/which", () => ({ resolveBin: vi.fn(() => null) }));
vi.mock("../../src/engine/runs", () => ({ defaultRunsDir: vi.fn(() => "/runs"), readRuns: vi.fn(() => []) }));

import { getConfig } from "../../src/config";
import { discoverRepos } from "../../src/engine/repos";
import { resolveForge } from "../../src/engine/forge/registry";
import { resolveBin } from "../../src/engine/pr/which";
import { readRuns } from "../../src/engine/runs";
import { defaultDeps } from "../../src/doctorView";
import type { TaskConnector } from "../../src/tasks/provider";
import { FORGE_MODE_PASSTHROUGH, FORGE_MODE_PROJECTED, type AuthProbe } from "../../src/engine/doctor";

// The settings defaultDeps still reads off getConfig() directly — reposRoot,
// workspaceDir, repoBlocklist, prFacts. The source-facing fields (label, scope,
// endpoint, setting ids) come from the connector's info() instead; see
// fakeConnector below.
const CFG = {
  reposRoot: "/repos",
  workspaceDir: "/ws",
  repoBlocklist: ["skipme"],
  prFacts: true,
  agentProvider: "claude-code" as const,
};

const fakeConnector = (over: Partial<TaskConnector> = {}): TaskConnector =>
  ({
    id: "jira",
    info: vi.fn(() => ({
      label: "Jira",
      scopeNoun: "project",
      scopeValue: "ASM",
      endpoint: "https://jira.test",
      exampleKey: "ASM-1234",
      endpointSetting: "agentFlow.jira.baseUrl",
      scopeSetting: "agentFlow.jira.project",
    })),
    isConfigured: () => true,
    configure: async () => true,
    setupSteps: 2,
    isAuthenticated: vi.fn(async () => true),
    signIn: vi.fn(async () => true),
    signOut: vi.fn(async () => undefined),
    provider: () => ({}) as never,
    probe: vi.fn(async () => ({})),
    taskUrl: () => "",
    keyFromUrl: () => null,
    ...over,
  }) as TaskConnector;

beforeEach(() => vi.mocked(getConfig).mockReturnValue(CFG as never));

describe("defaultDeps — the config slice", () => {
  it("builds config from the connector's info() plus the local settings", () => {
    const connector = fakeConnector();
    expect(defaultDeps(connector, () => undefined).config()).toEqual({
      sourceLabel: "Jira",
      scopeNoun: "project",
      endpoint: "https://jira.test",
      scope: "ASM",
      endpointSetting: "agentFlow.jira.baseUrl",
      scopeSetting: "agentFlow.jira.project",
      ...CFG,
    });
  });

  it("passes agentProvider through unresolved — collectInputs' hostProviders is what lets Doctor show every host agent under ask, not a guess made here", () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, agentProvider: "ask" } as never);
    const connector = fakeConnector();
    expect(defaultDeps(connector, () => undefined).config().agentProvider).toBe("ask");
  });
});

describe("defaultDeps — delegation", () => {
  const deps = () => defaultDeps(fakeConnector(), () => undefined);

  it("asks the connector whether it is authenticated", async () => {
    const connector = fakeConnector({ isAuthenticated: vi.fn(async () => false) });
    expect(await defaultDeps(connector, () => undefined).hasCredentials()).toBe(false);
    expect(connector.isAuthenticated).toHaveBeenCalled();
  });

  it("wires probe to connector.probe(), unmodified", async () => {
    const probeResult = { auth: { ok: true, displayName: "Jane" } as AuthProbe };
    const connector = fakeConnector({ probe: vi.fn(async () => probeResult) });
    await expect(defaultDeps(connector, () => undefined).probe()).resolves.toBe(probeResult);
    expect(connector.probe).toHaveBeenCalled();
  });

  it("resolves binaries through resolveBin, which looks beyond PATH", () => {
    vi.mocked(resolveBin).mockReturnValue("/opt/homebrew/bin/gh");
    expect(deps().which("gh")).toBe("/opt/homebrew/bin/gh");
    expect(resolveBin).toHaveBeenCalledWith("gh");
  });

  it("describes the forge through resolveForge rather than re-implementing it", () => {
    expect(deps().forge()).toEqual({ label: "GitHub", cli: "gh", installUrl: "https://cli.github.com" });
    expect(resolveForge).toHaveBeenCalled();
  });

  // Doctor is the surface built to report exactly this class of misconfiguration,
  // and it runs independently of the Deck panel — so `resolveForge`'s
  // fallback-to-github line must reach Doctor's OWN logger. With a swallowing
  // `() => {}` here, `agentFlow.forge: "gitla"` produced a report reading
  // "GitHub / gh: signed in" with nothing, anywhere, saying the setting was ignored.
  it.each(["forge", "forgeProbe"] as const)("passes Doctor's own logger to resolveForge from %s", (member) => {
    const log = vi.fn();
    const d = defaultDeps(fakeConnector(), log);
    if (member === "forge") d.forge();
    else void d.forgeProbe();
    expect(vi.mocked(resolveForge).mock.calls.at(-1)?.[1]).toBe(log);
  });

  it("reuses the forge's own probe rather than re-implementing the gh check", async () => {
    const probe = vi.fn(async () => ({ kind: "signed-out" as const, detail: "exit 1" }));
    vi.mocked(resolveForge).mockReturnValue({
      label: "GitHub",
      cli: { name: "gh", installUrl: "https://cli.github.com" },
      probe,
    } as never);
    await expect(deps().forgeProbe()).resolves.toEqual({ kind: "signed-out", detail: "exit 1" });
    expect(probe).toHaveBeenCalled();
  });

  // This is the seam the plumbing-only tests in doctorView.test.ts cannot reach:
  // those inject `forgeMode` as a literal and only prove collectInputs forwards
  // whatever it returns. Nothing there calls the real `defaultDeps` closure, so a
  // `forgeMode` that ignored `resolveCaps()` entirely and always answered `null`
  // — reporting NO Bitbucket user's mode, ever — passed every other test in this
  // plan undetected. These three prove `defaultDeps`'s own `forgeMode` actually
  // calls `resolveCaps()` and maps its answer, not just that something is wired.
  describe("forgeMode", () => {
    it("maps changesRequested: true to the passthrough mode via the forge's own resolveCaps", async () => {
      const resolveCaps = vi.fn(async () => ({ changesRequested: true, reviewSearch: false }));
      vi.mocked(resolveForge).mockReturnValue({
        label: "Bitbucket",
        cli: { name: "atlassian-cli", installUrl: "https://atlassiancli.com/install/" },
        resolveCaps,
      } as never);
      await expect(deps().forgeMode?.()).resolves.toBe(FORGE_MODE_PASSTHROUGH);
      expect(resolveCaps).toHaveBeenCalled();
    });

    it("maps changesRequested: false to the projected mode via the forge's own resolveCaps", async () => {
      vi.mocked(resolveForge).mockReturnValue({
        label: "Bitbucket",
        cli: { name: "atlassian-cli", installUrl: "https://atlassiancli.com/install/" },
        resolveCaps: vi.fn(async () => ({ changesRequested: false, reviewSearch: false })),
      } as never);
      await expect(deps().forgeMode?.()).resolves.toBe(FORGE_MODE_PROJECTED);
    });

    it("reports no mode for a forge with no resolveCaps — it has exactly one mode", async () => {
      // `clearMocks` (vitest.config.ts) only clears call history, not a prior
      // test's `mockReturnValue` — so this sets its own GitHub-shaped forge
      // rather than relying on the module-level default surviving the two
      // Bitbucket-shaped `mockReturnValue` calls above.
      vi.mocked(resolveForge).mockReturnValue({
        label: "GitHub",
        cli: { name: "gh", installUrl: "https://cli.github.com" },
        probe: vi.fn(async () => null),
      } as never);
      await expect(deps().forgeMode?.()).resolves.toBeNull();
    });
  });

  it("counts repos and git checkouts from discoverRepos, honouring the blocklist", () => {
    vi.mocked(discoverRepos).mockReturnValue([
      { name: "a", path: "/repos/a", isGit: true },
      { name: "b", path: "/repos/b", isGit: false },
    ]);
    expect(deps().repos()).toEqual({ repos: 2, gitRepos: 1 });
    expect(discoverRepos).toHaveBeenCalledWith("/repos", ["skipme"]);
  });

  it("counts tracked runs out of the runs store", () => {
    vi.mocked(readRuns).mockReturnValue([{}, {}, {}] as never);
    expect(deps().runs()).toBe(3);
  });

  it("passes the log function straight through", () => {
    const log = vi.fn();
    defaultDeps(fakeConnector(), log).log("hello");
    expect(log).toHaveBeenCalledWith("hello");
  });

  it("reports whether ~/.claude/projects can be read", () => {
    // Whatever this machine's answer is, it must be a boolean and must not throw —
    // an unreadable directory is a warning, never a crash.
    expect(typeof deps().claudeProjectsReadable()).toBe("boolean");
  });
});

describe("defaultDeps — statDir against a real filesystem", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "af-doctor-"));
  });
  afterEach(() => {
    try {
      fs.chmodSync(tmp, 0o700);
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  const statDir = (p: string) => defaultDeps(fakeConnector(), () => undefined).statDir(p);

  it("reports an existing writable directory", () => {
    expect(statDir(tmp)).toEqual({ exists: true, writable: true });
  });

  it("reports a path that isn't there at all", () => {
    expect(statDir(path.join(tmp, "nope"))).toEqual({ exists: false, writable: false });
  });

  it("treats a file as a missing directory rather than claiming it exists", () => {
    const file = path.join(tmp, "a-file");
    fs.writeFileSync(file, "x");
    expect(statDir(file)).toEqual({ exists: false, writable: false });
  });

  it("distinguishes an existing directory it cannot write to", () => {
    const ro = path.join(tmp, "readonly");
    fs.mkdirSync(ro);
    fs.chmodSync(ro, 0o500);
    // Root ignores the mode bits, so only assert the distinction where it applies.
    const canStillWrite = (() => {
      try {
        fs.accessSync(ro, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    })();
    expect(statDir(ro)).toEqual({ exists: true, writable: canStillWrite });
  });
});
