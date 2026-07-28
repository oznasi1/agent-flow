import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// The injected-deps tests cover the classifying; this file covers the wiring those
// deliberately bypass — the filesystem probe and what defaultDeps actually calls.
vi.mock("../../src/config", () => ({ getConfig: vi.fn() }));
vi.mock("../../src/engine/repos", () => ({ discoverRepos: vi.fn(() => []) }));
vi.mock("../../src/engine/pr/provider", () => ({ probeGh: vi.fn(async () => null) }));
vi.mock("../../src/engine/pr/which", () => ({ resolveBin: vi.fn(() => null) }));
vi.mock("../../src/engine/runs", () => ({ defaultRunsDir: vi.fn(() => "/runs"), readRuns: vi.fn(() => []) }));
vi.mock("../../src/jira/client", () => ({
  JiraClient: vi.fn(),
  JiraAuthError: class JiraAuthError extends Error {},
  JiraApiError: class JiraApiError extends Error {},
}));

import { getConfig } from "../../src/config";
import { discoverRepos } from "../../src/engine/repos";
import { probeGh } from "../../src/engine/pr/provider";
import { resolveBin } from "../../src/engine/pr/which";
import { readRuns } from "../../src/engine/runs";
import { JiraClient } from "../../src/jira/client";
import { defaultDeps } from "../../src/doctorView";
import type { JiraAuth } from "../../src/jira/auth";

const CFG = {
  baseUrl: "https://jira.test",
  project: "ASM",
  reposRoot: "/repos",
  workspaceDir: "/ws",
  repoBlocklist: ["skipme"],
  prFacts: true,
};

const fakeAuth = (authed = true): JiraAuth =>
  ({
    isAuthenticated: vi.fn(async () => authed),
    getAuthHeader: vi.fn(async () => "Basic x"),
    signIn: vi.fn(async () => true),
    signOut: vi.fn(async () => undefined),
  }) as unknown as JiraAuth;

beforeEach(() => vi.mocked(getConfig).mockReturnValue(CFG as never));

describe("defaultDeps — the config slice", () => {
  it("passes only the settings Doctor reads", () => {
    expect(defaultDeps(fakeAuth(), () => undefined).config()).toEqual(CFG);
  });
});

describe("defaultDeps — delegation", () => {
  const deps = () => defaultDeps(fakeAuth(), () => undefined);

  it("asks the auth object whether credentials are stored", async () => {
    const auth = fakeAuth(false);
    expect(await defaultDeps(auth, () => undefined).hasCredentials()).toBe(false);
    expect(auth.isAuthenticated).toHaveBeenCalled();
  });

  it("builds the client from the configured site and project for probeMyself", async () => {
    const probeMyself = vi.fn(async () => ({ accountId: "a1", displayName: "Jane" }));
    vi.mocked(JiraClient).mockImplementation(() => ({ probeMyself }) as never);
    const auth = fakeAuth();
    await expect(defaultDeps(auth, () => undefined).probeMyself()).resolves.toEqual({
      accountId: "a1",
      displayName: "Jane",
    });
    expect(JiraClient).toHaveBeenCalledWith("https://jira.test", "ASM", auth);
  });

  it("delegates getProject to the client with the key it was given", async () => {
    const getProject = vi.fn(async () => ({ id: "1", key: "ASM", name: "Assembly" }));
    vi.mocked(JiraClient).mockImplementation(() => ({ getProject }) as never);
    await deps().getProject("ASM");
    expect(getProject).toHaveBeenCalledWith("ASM");
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
    defaultDeps(fakeAuth(), log).log("hello");
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

  const statDir = (p: string) => defaultDeps(fakeAuth(), () => undefined).statDir(p);

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
