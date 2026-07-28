import { describe, it, expect } from "vitest";
import { runChecks, summarize, formatReport, CLAUDE_CODE_FLOOR, type DoctorInputs } from "../../../src/engine/doctor";

/** A wholly healthy machine. Each test spoils exactly one thing. */
const healthy = (): DoctorInputs => ({
  baseUrl: "https://jira.test",
  project: "ASM",
  hasCredentials: true,
  authProbe: { ok: true, displayName: "Jane Doe" },
  projectProbe: { ok: true, name: "Assembly" },
  gitOnPath: true,
  reposRoot: { path: "/home/j/projects", exists: true, repos: 12, gitRepos: 11 },
  workspaceDir: { path: "/home/j/projects", exists: true, writable: true },
  prFacts: true,
  gh: { gap: null, foundAt: "/opt/homebrew/bin/gh" },
  claudeCode: { installed: true, version: "2.1.220" },
  claudeProjectsReadable: true,
  runs: 7,
});

const find = (inputs: DoctorInputs, label: string) => {
  const c = runChecks(inputs).find((x) => x.label === label);
  if (!c) throw new Error(`no check labelled "${label}"`);
  return c;
};

describe("runChecks — a healthy machine", () => {
  it("reports no failures and no warnings", () => {
    const checks = runChecks(healthy());
    expect(checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(checks.filter((c) => c.status === "warn")).toEqual([]);
  });

  it("covers every group", () => {
    expect(new Set(runChecks(healthy()).map((c) => c.group))).toEqual(
      new Set(["Jira", "Local", "GitHub", "Claude Code", "State"]),
    );
  });

  it("names who the credentials belong to", () => {
    expect(find(healthy(), "Credentials valid").detail).toContain("Jane Doe");
  });

  it("names the project it resolved", () => {
    expect(find(healthy(), "Project resolves").detail).toContain("Assembly");
  });

  it("says where gh was found — the case a bare PATH makes invisible", () => {
    expect(find(healthy(), "gh").detail).toContain("/opt/homebrew/bin/gh");
  });
});

describe("runChecks — Jira", () => {
  it("fails an empty site URL", () => {
    const c = find({ ...healthy(), baseUrl: "" }, "Site configured");
    expect(c.status).toBe("fail");
    expect(c.action).toEqual({ kind: "command", command: "agentFlow.setup", label: "Run Setup" });
  });

  it("fails a site URL that isn't https", () => {
    expect(find({ ...healthy(), baseUrl: "http://jira.test" }, "Site configured").status).toBe("fail");
  });

  it("fails an empty project key", () => {
    expect(find({ ...healthy(), project: "" }, "Project configured").status).toBe("fail");
  });

  it("fails when no credentials are stored, and offers sign-in", () => {
    const c = find({ ...healthy(), hasCredentials: false, authProbe: undefined }, "Credentials stored");
    expect(c.status).toBe("fail");
    expect(c.action).toEqual({ kind: "command", command: "agentFlow.signIn", label: "Sign in" });
  });

  it("fails rejected credentials — the revoked-token case isAuthenticated() can't see", () => {
    const c = find(
      { ...healthy(), authProbe: { ok: false, reason: "auth", message: "Jira auth failed (401). Sign in again." } },
      "Credentials valid",
    );
    expect(c.status).toBe("fail");
    expect(c.detail).toBe("Jira auth failed (401). Sign in again.");
    expect(c.action).toEqual({ kind: "command", command: "agentFlow.signIn", label: "Sign in" });
  });

  it("only warns when the site is unreachable — that isn't the token's fault", () => {
    const c = find(
      { ...healthy(), authProbe: { ok: false, reason: "network", message: "Couldn't reach Jira at https://jira.test" } },
      "Credentials valid",
    );
    expect(c.status).toBe("warn");
    expect(c.detail).toBe("Couldn't reach Jira at https://jira.test");
  });

  it("skips the credential probe when there was nothing to probe with", () => {
    expect(find({ ...healthy(), hasCredentials: false, authProbe: undefined }, "Credentials valid").status).toBe("skip");
  });

  it("fails a project key Jira can't resolve", () => {
    const c = find(
      { ...healthy(), projectProbe: { ok: false, reason: "not-found", message: "Jira couldn't find that issue (404)." } },
      "Project resolves",
    );
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("not found, or not visible to you");
    expect(c.action).toEqual({ kind: "command", command: "agentFlow.setup", label: "Run Setup" });
  });

  it("warns rather than fails when the project lookup itself errored", () => {
    const c = find(
      { ...healthy(), projectProbe: { ok: false, reason: "error", message: "Jira didn't respond within 15s" } },
      "Project resolves",
    );
    expect(c.status).toBe("warn");
    expect(c.detail).toBe("Jira didn't respond within 15s");
  });

  it("skips the project probe when the credentials never worked", () => {
    const c = find(
      { ...healthy(), authProbe: { ok: false, reason: "auth", message: "nope" }, projectProbe: undefined },
      "Project resolves",
    );
    expect(c.status).toBe("skip");
    expect(c.detail).toContain("credentials");
  });
});

describe("runChecks — local environment", () => {
  it("fails when git isn't on PATH", () => {
    expect(find({ ...healthy(), gitOnPath: false }, "git on PATH").status).toBe("fail");
  });

  it("fails a reposRoot that doesn't exist, and offers the setting", () => {
    const c = find(
      { ...healthy(), reposRoot: { path: "/typo", exists: false, repos: 0, gitRepos: 0 } },
      "Repos root",
    );
    expect(c.status).toBe("fail");
    expect(c.action).toEqual({ kind: "setting", setting: "agentFlow.reposRoot", label: "Open setting" });
  });

  it("only warns when the reposRoot exists but is empty — legitimate on a fresh machine", () => {
    const c = find(
      { ...healthy(), reposRoot: { path: "/home/j/projects", exists: true, repos: 0, gitRepos: 0 } },
      "Repos root",
    );
    expect(c.status).toBe("warn");
  });

  it("counts repos and git checkouts separately", () => {
    expect(find(healthy(), "Repos root").detail).toBe("12 repos, 11 git — /home/j/projects");
  });

  it("fails a workspace dir that is missing or read-only", () => {
    expect(
      find({ ...healthy(), workspaceDir: { path: "/x", exists: false, writable: false } }, "Workspace dir").status,
    ).toBe("fail");
    expect(
      find({ ...healthy(), workspaceDir: { path: "/x", exists: true, writable: false } }, "Workspace dir").status,
    ).toBe("fail");
  });
});

describe("runChecks — gh", () => {
  it("fails a missing gh with a link to install it", () => {
    const c = find({ ...healthy(), gh: { gap: { kind: "missing", detail: "spawn ENOENT" }, foundAt: null } }, "gh");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("not installed");
    expect(c.action).toEqual({ kind: "external", url: "https://cli.github.com", label: "Install gh" });
  });

  it("distinguishes a gh that is installed but signed out", () => {
    const c = find(
      { ...healthy(), gh: { gap: { kind: "signed-out", detail: "auth status: exit 1" }, foundAt: "/usr/bin/gh" } },
      "gh",
    );
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("signed out");
    expect(c.detail).toContain("/usr/bin/gh");
  });

  it("skips gh entirely when PR facts are switched off", () => {
    const c = find({ ...healthy(), prFacts: false, gh: undefined }, "gh");
    expect(c.status).toBe("skip");
    expect(c.detail).toContain("prFacts");
  });
});

describe("runChecks — Claude Code", () => {
  it("fails when the extension isn't installed", () => {
    const c = find({ ...healthy(), claudeCode: { installed: false, version: null } }, "Claude Code installed");
    expect(c.status).toBe("fail");
    expect(c.action).toEqual({ kind: "extension", id: "anthropic.claude-code", label: "Show extension" });
  });

  it("warns below the version floor and says what needs it", () => {
    const c = find({ ...healthy(), claudeCode: { installed: true, version: "2.0.4" } }, "Claude Code version");
    expect(c.status).toBe("warn");
    expect(c.detail).toContain(CLAUDE_CODE_FLOOR);
    expect(c.detail).toContain("shared-window");
  });

  it("accepts a version above the floor, including a longer patch number", () => {
    expect(find({ ...healthy(), claudeCode: { installed: true, version: "2.1.221" } }, "Claude Code version").status)
      .toBe("ok");
    expect(find({ ...healthy(), claudeCode: { installed: true, version: "3.0.0" } }, "Claude Code version").status)
      .toBe("ok");
  });

  it("compares numerically, not as strings — 2.1.99 is below 2.1.220", () => {
    expect(find({ ...healthy(), claudeCode: { installed: true, version: "2.1.99" } }, "Claude Code version").status)
      .toBe("warn");
  });

  it("warns on a version it cannot parse rather than claiming it is fine", () => {
    expect(find({ ...healthy(), claudeCode: { installed: true, version: "insiders" } }, "Claude Code version").status)
      .toBe("warn");
  });

  it("skips the version check when the extension is absent", () => {
    expect(find({ ...healthy(), claudeCode: { installed: false, version: null } }, "Claude Code version").status)
      .toBe("skip");
  });

  it("warns when the projects directory can't be read — the live signal degrades", () => {
    const c = find({ ...healthy(), claudeProjectsReadable: false }, "Claude session files");
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("git");
  });
});

describe("runChecks — state", () => {
  it("reports the tracked run count as information, never a problem", () => {
    expect(find(healthy(), "Tracked runs").status).toBe("ok");
    expect(find({ ...healthy(), runs: 0 }, "Tracked runs").status).toBe("ok");
    expect(find(healthy(), "Tracked runs").detail).toContain("7");
  });
});

describe("ordering", () => {
  it("puts failures first, then warnings, then skips, then passes", () => {
    const checks = runChecks({
      ...healthy(),
      gitOnPath: false,
      claudeCode: { installed: true, version: "2.0.4" },
      prFacts: false,
      gh: undefined,
    });
    const rank = checks.map((c) => c.status);
    const order = ["fail", "warn", "skip", "ok"];
    const idx = rank.map((s) => order.indexOf(s));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });

  it("keeps a stable group order inside one status", () => {
    const checks = runChecks({ ...healthy(), baseUrl: "", gitOnPath: false });
    const fails = checks.filter((c) => c.status === "fail").map((c) => c.label);
    expect(fails).toEqual(["Site configured", "git on PATH"]);
  });
});

describe("summarize", () => {
  it("counts problems and warnings", () => {
    const checks = runChecks({ ...healthy(), baseUrl: "", gitOnPath: false, claudeProjectsReadable: false });
    expect(summarize(checks)).toBe("2 problems · 1 warning");
  });

  it("uses the singular for one of each", () => {
    expect(summarize(runChecks({ ...healthy(), baseUrl: "", claudeProjectsReadable: false })))
      .toBe("1 problem · 1 warning");
  });

  it("says everything checks out when nothing is wrong", () => {
    expect(summarize(runChecks(healthy()))).toBe("Everything checks out");
  });

  it("omits the warning half when there are none", () => {
    expect(summarize(runChecks({ ...healthy(), baseUrl: "" }))).toBe("1 problem");
  });
});

describe("formatReport", () => {
  it("writes one line per check, grouped, with a summary header", () => {
    const report = formatReport(runChecks({ ...healthy(), baseUrl: "" }));
    expect(report).toContain("Agent Flow Doctor");
    expect(report).toContain("1 problem");
    expect(report).toContain("[fail] Site configured");
    expect(report).toContain("Jira");
  });

  it("is plain text with no VS Code markup, so it can be pasted anywhere", () => {
    expect(formatReport(runChecks(healthy()))).not.toMatch(/\$\(|<[a-z]/);
  });
});
