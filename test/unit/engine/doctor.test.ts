import { describe, it, expect } from "vitest";
import { runChecks, summarize, formatReport, CLAUDE_CODE_FLOOR, type DoctorInputs } from "../../../src/engine/doctor";

/** A wholly healthy machine. Each test spoils exactly one thing. */
const healthy = (): DoctorInputs => ({
  sourceLabel: "Jira",
  scopeNoun: "project",
  endpoint: "https://jira.test",
  scope: "PROJ",
  endpointSetting: "agentFlow.jira.baseUrl",
  scopeSetting: "agentFlow.jira.project",
  hasCredentials: true,
  authProbe: { ok: true, displayName: "Jane Doe" },
  projectProbe: { ok: true, name: "Assembly" },
  gitOnPath: true,
  reposRoot: { path: "/home/j/projects", exists: true, repos: 12, gitRepos: 11 },
  workspaceDir: { path: "/home/j/projects", exists: true, writable: true },
  prFacts: true,
  forge: { label: "GitHub", cli: "gh", installUrl: "https://cli.github.com", gap: null, foundAt: "/opt/homebrew/bin/gh" },
  claudeCode: { installed: true, version: "2.1.220" },
  claudeProjectsReadable: true,
  runs: 7,
  agentProvider: "claude-code",
  hostProviders: ["claude-code"],
  chatCommand: { available: false },
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
      new Set(["source", "Local", "GitHub", "Claude Code", "State"]),
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
    const c = find({ ...healthy(), endpoint: "" }, "Site configured");
    expect(c.status).toBe("fail");
    expect(c.action).toEqual({ kind: "command", command: "agentFlow.setup", label: "Run Setup" });
  });

  it("fails a site URL that isn't https", () => {
    expect(find({ ...healthy(), endpoint: "http://jira.test" }, "Site configured").status).toBe("fail");
  });

  it("fails an empty project key", () => {
    expect(find({ ...healthy(), scope: "" }, "Project configured").status).toBe("fail");
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
    const c = find(
      {
        ...healthy(),
        forge: {
          label: "GitHub",
          cli: "gh",
          installUrl: "https://cli.github.com",
          gap: { kind: "missing", detail: "spawn ENOENT" },
          foundAt: null,
        },
      },
      "gh",
    );
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("not installed");
    expect(c.action).toEqual({ kind: "external", url: "https://cli.github.com", label: "Install gh" });
  });

  it("distinguishes a gh that is installed but signed out", () => {
    const c = find(
      {
        ...healthy(),
        forge: {
          label: "GitHub",
          cli: "gh",
          installUrl: "https://cli.github.com",
          gap: { kind: "signed-out", detail: "auth status: exit 1" },
          foundAt: "/usr/bin/gh",
        },
      },
      "gh",
    );
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("signed out");
    expect(c.detail).toContain("/usr/bin/gh");
  });

  it("skips gh entirely when PR facts are switched off", () => {
    const c = find({ ...healthy(), prFacts: false }, "gh");
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
    // Byte-identical to the pre-seam wording for a Jira user…
    expect(c.detail).toBe("~/.claude/projects is unreadable — the Deck's live signal falls back to git and Jira");
  });

  it("names the configured source in the live-signal fallback, not Jira", () => {
    // …and the last check detail in this module that still hardcoded a source name
    // now reads the connector's own label, like its siblings' row labels do.
    const c = find({ ...healthy(), sourceLabel: "Acme Tracker", claudeProjectsReadable: false }, "Claude session files");
    expect(c.detail).toContain("git and Acme Tracker");
  });
});

describe("agent checks by provider", () => {
  it("reports Copilot Chat availability under the copilot provider", () => {
    const checks = runChecks({ ...healthy(), agentProvider: "copilot", chatCommand: { available: true } });
    expect(checks.find((c) => c.label === "Copilot Chat available")?.status).toBe("ok");
    expect(checks.find((c) => c.label === "Claude Code installed")).toBeUndefined();
    expect(checks.find((c) => c.label === "Claude Code version")).toBeUndefined();
  });

  it("offers the Copilot Chat extension when it isn't available", () => {
    const checks = runChecks({ ...healthy(), agentProvider: "copilot", chatCommand: { available: false } });
    const row = checks.find((c) => c.label === "Copilot Chat available");
    expect(row?.status).toBe("fail");
    expect(row?.action).toEqual({ kind: "extension", id: "github.copilot-chat", label: "Show extension" });
  });

  it("keeps the Claude Code rows under the default provider", () => {
    const checks = runChecks({ ...healthy(), agentProvider: "claude-code" });
    expect(checks.find((c) => c.label === "Claude Code installed")).toBeDefined();
    expect(checks.find((c) => c.label === "Copilot Chat available")).toBeUndefined();
  });

  it("keeps the Claude session-files row under either provider", () => {
    // The Deck's live signal reads ~/.claude/projects no matter which agent seeds
    // sessions, so this row is not provider-dependent.
    for (const agentProvider of ["claude-code", "copilot"] as const) {
      expect(runChecks({ ...healthy(), agentProvider }).find((c) => c.label === "Claude session files")).toBeDefined();
    }
  });

  it("shows the Cursor chat row and the Claude session-files row under cursor", () => {
    const checks = runChecks({ ...healthy(), agentProvider: "cursor", chatCommand: { available: true } });
    const groups = checks.map((c) => c.group);
    expect(groups).toContain("Cursor");
    expect(groups).not.toContain("Copilot");
    // Cursor's composer sessions don't show up on the Deck, which reads Claude
    // Code's session files — so the session-files row still has to explain itself.
    expect(checks.find((c) => c.label === "Claude session files")).toBeDefined();
    expect(checks.find((c) => c.label === "Cursor chat available")?.status).toBe("ok");
  });

  it("fails the Cursor chat row without an action — Cursor's agent ships with the editor", () => {
    const checks = runChecks({ ...healthy(), agentProvider: "cursor", chatCommand: { available: false } });
    const row = checks.find((c) => c.group === "Cursor");
    expect(row?.status).toBe("fail");
    expect(row?.action).toBeUndefined();
  });
});

describe("agent checks under ask", () => {
  it("under ask, shows the rows for every agent this host can run", () => {
    const checks = runChecks({
      ...healthy(),
      agentProvider: "ask",
      hostProviders: ["claude-code", "cursor"],
      chatCommand: { available: true },
    });
    const groups = checks.map((c) => c.group);
    expect(groups).toContain("Claude Code");
    expect(groups).toContain("Cursor");
    expect(groups).not.toContain("Copilot");
  });

  it("under ask in VS Code, shows Copilot's rows and not Cursor's", () => {
    const checks = runChecks({
      ...healthy(),
      agentProvider: "ask",
      hostProviders: ["claude-code", "copilot"],
      chatCommand: { available: true },
    });
    const groups = checks.map((c) => c.group);
    expect(groups).toContain("Copilot");
    expect(groups).not.toContain("Cursor");
  });

  it("under ask, still shows the Claude Code rows themselves, not just the other agents'", () => {
    const checks = runChecks({
      ...healthy(),
      agentProvider: "ask",
      hostProviders: ["claude-code", "cursor"],
      chatCommand: { available: true },
    });
    expect(checks.find((c) => c.label === "Claude Code installed")).toBeDefined();
    expect(checks.find((c) => c.label === "Claude session files")).toBeDefined();
  });

  // COUNTS rows rather than searching for one. Every other test in this block uses
  // `.find()`/`toContain`, which are structurally blind to a duplicated row — which is
  // exactly how a doubled "Claude session files" row shipped through four CI gates.
  it("under ask, emits each row exactly once — no agent's rows are duplicated", () => {
    for (const hostProviders of [
      ["claude-code"],
      ["claude-code", "cursor"],
      ["claude-code", "copilot"],
    ] as const) {
      const checks = runChecks({
        ...healthy(),
        agentProvider: "ask",
        hostProviders: [...hostProviders],
        chatCommand: { available: true },
      });
      const counts = new Map<string, number>();
      for (const c of checks) counts.set(c.label, (counts.get(c.label) ?? 0) + 1);
      const dupes = [...counts].filter(([, n]) => n > 1);
      expect(dupes).toEqual([]);
      expect(counts.get("Claude session files")).toBe(1);
    }
  });

  it("under ask, counts an unreadable ~/.claude/projects as ONE warning, not two", () => {
    const checks = runChecks({
      ...healthy(),
      agentProvider: "ask",
      hostProviders: ["claude-code", "cursor"],
      chatCommand: { available: true },
      claudeProjectsReadable: false,
    });
    expect(checks.filter((c) => c.status === "warn")).toHaveLength(1);
    expect(summarize(checks)).toBe("1 warning");
  });

  it("under ask with only Claude Code on this host, shows no chat-agent rows at all", () => {
    const checks = runChecks({ ...healthy(), agentProvider: "ask", hostProviders: ["claude-code"] });
    const groups = checks.map((c) => c.group);
    expect(groups).not.toContain("Copilot");
    expect(groups).not.toContain("Cursor");
    expect(checks.find((c) => c.label === "Claude Code installed")).toBeDefined();
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
    });
    const rank = checks.map((c) => c.status);
    const order = ["fail", "warn", "skip", "ok"];
    const idx = rank.map((s) => order.indexOf(s));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });

  it("keeps a stable group order inside one status", () => {
    const checks = runChecks({ ...healthy(), endpoint: "", gitOnPath: false });
    const fails = checks.filter((c) => c.status === "fail").map((c) => c.label);
    expect(fails).toEqual(["Site configured", "git on PATH"]);
  });
});

describe("summarize", () => {
  it("counts problems and warnings", () => {
    const checks = runChecks({ ...healthy(), endpoint: "", gitOnPath: false, claudeProjectsReadable: false });
    expect(summarize(checks)).toBe("2 problems · 1 warning");
  });

  it("uses the singular for one of each", () => {
    expect(summarize(runChecks({ ...healthy(), endpoint: "", claudeProjectsReadable: false })))
      .toBe("1 problem · 1 warning");
  });

  it("says everything checks out when nothing is wrong", () => {
    expect(summarize(runChecks(healthy()))).toBe("Everything checks out");
  });

  it("omits the warning half when there are none", () => {
    expect(summarize(runChecks({ ...healthy(), endpoint: "" }))).toBe("1 problem");
  });
});

describe("formatReport", () => {
  it("writes one line per check, grouped, with a summary header", () => {
    const report = formatReport(runChecks({ ...healthy(), endpoint: "" }), "Jira");
    expect(report).toContain("Agent Flow Deck Doctor");
    expect(report).toContain("1 problem");
    expect(report).toContain("[fail] Site configured");
    expect(report).toContain("Jira");
  });

  it("labels the source group with the connector's own label, not the placeholder", () => {
    const report = formatReport(runChecks(healthy()), "Fixture");
    expect(report).toContain("Fixture:");
    expect(report).not.toContain("source:");
  });

  it("is plain text with no VS Code markup, so it can be pasted anywhere", () => {
    expect(formatReport(runChecks(healthy()), "Jira")).not.toMatch(/\$\(|<[a-z]/);
  });
});

describe("runChecks — source-agnostic rows", () => {
  it("labels the source rows from the connector, not from Jira", () => {
    const checks = runChecks({
      ...healthy(),
      sourceLabel: "Fixture",
      scopeNoun: "board",
      endpoint: "https://fixture.test",
      scope: "FX",
      endpointSetting: "agentFlow.fixture.endpoint",
      scopeSetting: "agentFlow.fixture.board",
    }).filter((c) => c.group === "source");
    expect(checks.map((c) => c.label)).toContain("Board configured");
    expect(checks.some((c) => c.detail.includes("agentFlow.jira"))).toBe(false);
  });

  it("names the missing setting when the scope is empty", () => {
    const c = find({ ...healthy(), scope: "" }, "Project configured");
    expect(c.status).toBe("fail");
    expect(c.detail).toBe("agentFlow.jira.project is empty");
  });

  it("names the missing setting when the endpoint is empty", () => {
    const c = find({ ...healthy(), endpoint: "" }, "Site configured");
    expect(c.status).toBe("fail");
    expect(c.detail).toBe("agentFlow.jira.baseUrl is empty");
  });
});

describe("runChecks — a GitLab forge", () => {
  const gitlab = {
    label: "GitLab", cli: "glab", installUrl: "https://gitlab.com/gitlab-org/cli",
    gap: null, foundAt: "/opt/homebrew/bin/glab",
  };

  it("groups the row under GitLab and labels it with glab, naming where it was found", () => {
    const c = find({ ...healthy(), forge: gitlab }, "glab");
    expect(c.group).toBe("GitLab");
    expect(c.status).toBe("ok");
    // Naming WHERE the binary was found is the most valuable line in the report: a
    // Homebrew CLI invisible to the extension host's bare launchd PATH reads, to a
    // signed-in user, as the Deck simply being broken.
    expect(c.detail).toContain("/opt/homebrew/bin/glab");
  });

  it("offers GitLab's own install link when glab is missing", () => {
    const c = find({ ...healthy(), forge: { ...gitlab, gap: { kind: "missing" as const, detail: "spawn ENOENT" }, foundAt: null } }, "glab");
    expect(c.status).toBe("fail");
    expect(c.action).toEqual({ kind: "external", url: "https://gitlab.com/gitlab-org/cli", label: "Install glab" });
  });

  it("skips under the forge's own group and label when PR facts are off", () => {
    const c = find({ ...healthy(), prFacts: false, forge: gitlab }, "glab");
    expect(c.group).toBe("GitLab");
    expect(c.status).toBe("skip");
    expect(c.detail).toContain("prFacts");
  });

  it("replaces the GitHub group entirely — a GitLab user sees no GitHub row", () => {
    const groups = new Set(runChecks({ ...healthy(), forge: gitlab }).map((c) => c.group));
    expect(groups.has("GitLab")).toBe(true);
    expect(groups.has("GitHub")).toBe(false);
  });
});

describe("runChecks — forge mode", () => {
  it("names the forge's mode when it has one, and stays silent when it does not", () => {
    const withMode = runChecks({
      ...healthy(),
      forge: {
        label: "Bitbucket",
        cli: "atlassian-cli",
        installUrl: "https://example.test/atlassian-cli",
        gap: null,
        foundAt: "/opt/homebrew/bin/atlassian-cli",
        mode: "projected (limited)",
      },
    });
    const row = withMode.find((c) => c.group === "Bitbucket");
    // Exact equality, not just `.toContain`: a detail that leaked "undefined" or
    // "null" alongside the mode string, or hardcoded the wrong mode, would still
    // satisfy a bare substring check.
    expect(row?.detail).toBe("signed in — /opt/homebrew/bin/atlassian-cli — projected (limited)");

    // gh has one mode, so a mode row would be noise — byte-identical to the
    // pre-mode wording, so a stray "— null"/"— undefined" suffix would fail this.
    const noMode = runChecks({ ...healthy(), forge: { ...healthy().forge, mode: null } });
    expect(noMode.find((c) => c.group === "GitHub")?.detail).toBe("signed in — /opt/homebrew/bin/gh");
  });
});

describe("runChecks — PR reads that fail while the CLI looks fine", () => {
  const PR_ROW = "PR reads";

  it("adds no row at all when the last reads all succeeded", () => {
    // The healthy fixture omits `prReads` entirely, which is also what an older
    // caller passes — absent must mean "nothing to report", never a warning.
    expect(runChecks(healthy()).find((c) => c.label === PR_ROW)).toBeUndefined();
    expect(runChecks({ ...healthy(), prReads: { runs: 0, repos: [] } }).find((c) => c.label === PR_ROW))
      .toBeUndefined();
  });

  it("warns when reads are failing even though the CLI is signed in", () => {
    // The exact state that reported GitHub ✓ OK while every fetch failed: the
    // probe asks a global question ("are you signed in?") and cannot see a
    // per-repo answer ("this account cannot resolve that repository").
    const c = find({ ...healthy(), prReads: { runs: 6, repos: ["e2e_suite", "webapp"] } }, PR_ROW);
    expect(c.status).toBe("warn");
    expect(c.group).toBe("GitHub");
    expect(c.detail).toContain("6 runs");
    expect(c.detail).toContain("webapp");
  });

  it("keeps the CLI row itself OK — the binary really is fine", () => {
    // Two rows saying different things is the point: the CLI is healthy AND the
    // reads are failing, and collapsing them would hide which half to fix.
    const inputs = { ...healthy(), prReads: { runs: 6, repos: ["webapp"] } };
    expect(find(inputs, "gh").status).toBe("ok");
  });

  it("stays quiet when the CLI is the gap, which already has its own failing row", () => {
    // A missing CLI makes every read fail by construction. A second row would be
    // a consequence reported as a cause.
    const inputs: DoctorInputs = {
      ...healthy(),
      forge: { ...healthy().forge, gap: { kind: "missing", detail: "spawn ENOENT" }, foundAt: null },
      prReads: { runs: 6, repos: ["webapp"] },
    };
    expect(runChecks(inputs).find((c) => c.label === PR_ROW)).toBeUndefined();
  });

  it("stays quiet when PR facts are off, since nothing was ever read", () => {
    const inputs = { ...healthy(), prFacts: false, prReads: { runs: 6, repos: ["webapp"] } };
    expect(runChecks(inputs).find((c) => c.label === PR_ROW)).toBeUndefined();
  });

  it("names the forge's own group, not a hardcoded GitHub", () => {
    const gitlab = { label: "GitLab", cli: "glab", installUrl: "https://gitlab.com/cli", gap: null, foundAt: "/usr/bin/glab" };
    const c = find({ ...healthy(), forge: gitlab, prReads: { runs: 2, repos: ["infra"] } }, PR_ROW);
    expect(c.group).toBe("GitLab");
  });

  it("caps the repo list so one bad account does not print forty names", () => {
    // Real names, not single letters: "and 3 more" contains a bare "d", so a
    // one-letter fixture makes the not-listed assertion fail on the prose.
    const repos = ["webapp", "hermes", "aws-ops", "device-manager", "synqly-fetcher", "notification-service"];
    const c = find({ ...healthy(), prReads: { runs: 9, repos } }, PR_ROW);
    expect(c.detail).toContain("webapp, hermes, aws-ops");
    expect(c.detail).not.toContain("device-manager");
    expect(c.detail).toContain("and 3 more");
  });
});
