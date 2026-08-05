import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// The injected-deps tests (doctorView.test.ts) cover collectInputs' own logic;
// this file covers the wiring those deliberately bypass — the filesystem probe
// and what defaultDeps actually calls on the connector and on getConfig().
vi.mock("../../src/config", () => ({ getConfig: vi.fn() }));
vi.mock("../../src/engine/repos", () => ({ discoverRepos: vi.fn(() => []) }));
vi.mock("../../src/engine/pr/provider", () => ({ probeGh: vi.fn(async () => null) }));
vi.mock("../../src/engine/pr/which", () => ({ resolveBin: vi.fn(() => null) }));
vi.mock("../../src/engine/runs", () => ({ defaultRunsDir: vi.fn(() => "/runs"), readRuns: vi.fn(() => []) }));

import { getConfig } from "../../src/config";
import { discoverRepos } from "../../src/engine/repos";
import { probeGh } from "../../src/engine/pr/provider";
import { resolveBin } from "../../src/engine/pr/which";
import { readRuns } from "../../src/engine/runs";
import { defaultDeps } from "../../src/doctorView";
import type { TaskConnector } from "../../src/tasks/provider";
import type { AuthProbe } from "../../src/engine/doctor";

// The settings defaultDeps still reads off getConfig() directly — reposRoot,
// workspaceDir, repoBlocklist, prFacts. The source-facing fields (label, scope,
// endpoint, setting ids) come from the connector's info() instead; see
// fakeConnector below.
const CFG = {
  reposRoot: "/repos",
  workspaceDir: "/ws",
  repoBlocklist: ["skipme"],
  prFacts: true,
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

  it("reuses probeGh rather than re-implementing the gh check", async () => {
    vi.mocked(probeGh).mockResolvedValue({ kind: "signed-out", detail: "exit 1" });
    await expect(deps().gh()).resolves.toEqual({ kind: "signed-out", detail: "exit 1" });
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
