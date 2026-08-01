import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as childProcess from "child_process";
import { openWorkspace, maybeSeedAgent, watchPlansAndSeed, listWorkspaceFiles, mergeReposIntoWorkspace, workspaceFolders, workspaceFolderPaths, planWorkspaceMerge, agentPrompt, mentionInWorkspace, BRIEF_DIR, BRIEF_FILE, type OpenRequest, type TicketRef, type MergeCandidate } from "../../../src/engine/workspace";
import { commands, env, window, workspace } from "../../_mocks/vscode";
import { fakeContext, mkRepos } from "../../_helpers/factories";

vi.mock("fs");
vi.mock("child_process");

const existsSync = vi.mocked(fs.existsSync);
const statSync = vi.mocked(fs.statSync);
const readFileSync = vi.mocked(fs.readFileSync);
const writeFileSync = vi.mocked(fs.writeFileSync);
const appendFileSync = vi.mocked(fs.appendFileSync);
const mkdirSync = vi.mocked(fs.mkdirSync);
const readdirSync = vi.mocked(fs.readdirSync);
const rmSync = vi.mocked(fs.rmSync);
const realpathSync = vi.mocked(fs.realpathSync);
const watch = vi.mocked(fs.watch);
const exec = vi.mocked(childProcess.exec);
const execSync = vi.mocked(childProcess.execSync);

const CLAUDE_OPEN_CMD = "claude-vscode.primaryEditor.open";

beforeEach(() => {
  vi.mocked(fs).mkdirSync.mockReset();
  writeFileSync.mockReset();
  appendFileSync.mockReset();
  rmSync.mockReset();
  // .git exists (dir), nothing else does → ensureGitExcluded appends once.
  existsSync.mockReset().mockImplementation((p) => String(p).endsWith("/.git"));
  statSync.mockReset().mockReturnValue({ isFile: () => false } as unknown as fs.Stats);
  readFileSync.mockReset().mockReturnValue("");
  readdirSync.mockReset().mockReturnValue([] as never);
  realpathSync.mockReset().mockImplementation((p) => String(p)); // identity canon
  execSync.mockReset().mockReturnValue(""); // git ls-files → no files
  // `open -a` succeeds by invoking its callback with no error.
  exec.mockReset().mockImplementation(((_cmd: string, cb: (e: unknown) => void) => cb(null)) as never);
});

const baseReq = (over: Partial<OpenRequest> = {}): OpenRequest => ({
  ticket: { key: "ASM-1", summary: "Do the thing", url: "https://jira/ASM-1" },
  planMd: "## Plan\n\nsteps",
  descriptionText: "no files here",
  services: mkRepos(["account-service", "centaur"]),
  mode: "multiroot",
  promptTemplate: "Start {key}: {summary} {url}{files}",
  workspaceDir: "/ws",
  seedAgent: true,
  ...over,
});

const writeArg = (predicate: (path: string) => boolean) =>
  writeFileSync.mock.calls.find((c) => predicate(String(c[0])));

describe("openWorkspace — multiroot", () => {
  it("writes a .code-workspace, briefs, git-excludes, opens, and seeds a plan", async () => {
    const result = await openWorkspace(baseReq());

    expect(result.mode).toBe("multiroot");
    expect(result.workspaceFile).toBe("/ws/ASM-1.code-workspace");
    expect(result.opened).toEqual(["/ws/ASM-1.code-workspace"]);
    expect(result.briefs).toHaveLength(2);
    expect(result.briefs.every((b) => b.gitExcluded)).toBe(true);

    // workspace file content lists both repos as folders
    const wsWrite = writeArg((p) => p.endsWith(".code-workspace"));
    expect(wsWrite).toBeTruthy();
    const ws = JSON.parse(String(wsWrite![1]));
    expect(ws.folders.map((f: { name: string }) => f.name)).toEqual(["account-service", "centaur"]);

    // each repo gets a TASK.md brief mentioning the ticket
    const brief = writeArg((p) => p.endsWith("TASK.md"));
    expect(String(brief![1])).toContain("ASM-1");

    // a plan file is written for the seed handshake, carrying the rendered prompt
    const planWrite = writeArg((p) => p.includes(".agentflow") && p.includes("plans") && p.endsWith(".json"));
    expect(planWrite).toBeTruthy();
    const plan = JSON.parse(String(planWrite![1]));
    expect(plan.seedAgent).toBe(true);
    expect(plan.matches[0].prompt).toContain("Start ASM-1");
  });

  it("falls back to openFolder when `open -a` fails", async () => {
    exec.mockImplementation(((_cmd: string, cb: (e: unknown) => void) => cb(new Error("no app"))) as never);
    const result = await openWorkspace(baseReq());
    expect(commands.executeCommand).toHaveBeenCalledWith(
      "vscode.openFolder",
      expect.anything(),
      expect.objectContaining({ forceNewWindow: true }),
    );
    expect(result.opened).toEqual(["/ws/ASM-1.code-workspace"]);
  });

  it("does not write a plan file when seedAgent is off", async () => {
    await openWorkspace(baseReq({ seedAgent: false }));
    expect(writeArg((p) => p.includes(".agentflow") && p.includes("plans") && p.endsWith(".json"))).toBeUndefined();
  });

  it("always writes a durable run record for the Deck (even with seedAgent off)", async () => {
    await openWorkspace(baseReq({ seedAgent: false }));
    const runWrite = writeArg((p) => p.includes(".agentflow") && p.includes("runs") && p.endsWith(".json"));
    expect(runWrite).toBeTruthy();
    const run = JSON.parse(String(runWrite![1]));
    expect(run.key).toBe("ASM-1");
    expect(run.mode).toBe("multiroot");
    expect(run.repos.map((r: { name: string }) => r.name)).toEqual(["account-service", "centaur"]);
  });
});

describe("openWorkspace — run kind", () => {
  const runWriteOf = () => {
    const runWrite = writeArg((p) => p.includes(".agentflow") && p.includes("runs") && p.endsWith(".json"));
    expect(runWrite).toBeTruthy();
    return JSON.parse(String(runWrite![1]));
  };

  it("stamps the run's kind when one is given", async () => {
    await openWorkspace(baseReq({ kind: "review" }));
    expect(runWriteOf().kind).toBe("review");
  });

  it("leaves the kind absent for a plain take — every pre-existing run record looks like this", async () => {
    await openWorkspace(baseReq());
    const runWrite = writeArg((p) => p.includes(".agentflow") && p.includes("runs") && p.endsWith(".json"));
    expect(runWriteOf().kind).toBeUndefined();
    // Not just "reads as undefined": the serialized record must not carry the key
    // at all, matching every runs/*.json file written before `kind` existed.
    expect(String(runWrite![1])).not.toContain("kind");
  });
});

describe("openWorkspace — per-window", () => {
  it("opens one window per repo and records each path as a match", async () => {
    const result = await openWorkspace(baseReq({ mode: "per-window" }));
    expect(result.workspaceFile).toBeUndefined();
    expect(result.opened).toEqual(["/repos/account-service", "/repos/centaur"]);
    const planWrite = writeArg((p) => p.includes(".agentflow") && p.includes("plans") && p.endsWith(".json"));
    const plan = JSON.parse(String(planWrite![1]));
    expect(plan.matches.map((m: { matchPath: string }) => m.matchPath)).toEqual([
      "/repos/account-service",
      "/repos/centaur",
    ]);
  });
});

describe("openWorkspace — git exclude", () => {
  it("appends .pick-task/ to info/exclude when absent", async () => {
    await openWorkspace(baseReq({ services: mkRepos(["solo"]) }));
    const appended = appendFileSync.mock.calls.find((c) => String(c[0]).endsWith("info/exclude"));
    expect(appended).toBeTruthy();
    expect(String(appended![1])).toContain(".pick-task/");
  });

  it("does not append when .pick-task/ is already excluded", async () => {
    existsSync.mockImplementation((p) => {
      const s = String(p);
      return s.endsWith("/.git") || s.endsWith("info/exclude");
    });
    readFileSync.mockReturnValue(".pick-task/\n");
    const result = await openWorkspace(baseReq({ services: mkRepos(["solo"]) }));
    expect(appendFileSync).not.toHaveBeenCalled();
    expect(result.briefs[0].gitExcluded).toBe(true);
  });

  it("reports gitExcluded=false for a non-git repo", async () => {
    existsSync.mockReturnValue(false); // no .git anywhere
    const result = await openWorkspace(baseReq({ services: mkRepos(["solo"], { isGit: false }) }));
    expect(result.briefs[0].gitExcluded).toBe(false);
  });

  it("resolves a worktree's shared commondir for the exclude path", async () => {
    existsSync.mockImplementation((p) => {
      const s = String(p);
      return s.endsWith("/.git") || s.endsWith("/commondir");
    });
    statSync.mockReturnValue({ isFile: () => true } as unknown as fs.Stats);
    readFileSync.mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith("/.git")) return "gitdir: /main/.git/worktrees/w";
      if (s.endsWith("/commondir")) return "../..";
      return "";
    });
    await openWorkspace(baseReq({ services: mkRepos(["solo"]) }));
    const appended = appendFileSync.mock.calls.find((c) => String(c[0]) === "/main/.git/info/exclude");
    expect(appended).toBeTruthy();
  });
});

describe("openWorkspace — relevant files", () => {
  it("threads matched files into the brief and the prompt mentions", async () => {
    execSync.mockReturnValue("src/export.py\n"); // git ls-files result
    const result = await openWorkspace(
      baseReq({
        services: mkRepos(["solo"]),
        descriptionText: "fix `src/export.py`",
      }),
    );
    expect(result.briefs[0].files).toBe(1);
    const planWrite = writeArg((p) => p.includes(".agentflow") && p.includes("plans") && p.endsWith(".json"));
    const plan = JSON.parse(String(planWrite![1]));
    expect(plan.matches[0].prompt).toContain("Relevant files:");
    expect(plan.matches[0].prompt).toContain("export.py");
  });
});

describe("agentPrompt", () => {
  const ticket: TicketRef = { key: "ASM-1", summary: "Do the thing", url: "https://jira/ASM-1" };

  it("defaults {brief} to the relative BRIEF_DIR/BRIEF_FILE path", () => {
    expect(agentPrompt(ticket, [], "{brief}")).toBe(`${BRIEF_DIR}/${BRIEF_FILE}`);
  });

  it("uses an explicit briefPath verbatim when given — the shared-window case", () => {
    // Task 4's shared window has N worktree roots each holding the same relative
    // .pick-task/TASK.md, so the seeded prompt needs an absolute, disambiguated path.
    expect(agentPrompt(ticket, [], "{brief}", "/abs/wt/.pick-task/TASK.md")).toBe("/abs/wt/.pick-task/TASK.md");
  });
});

describe("maybeSeedAgent", () => {
  const planJson = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      key: "ASM-1",
      createdAt: Date.now(),
      seedAgent: true,
      matches: [{ matchPath: "/ws/ASM-1.code-workspace", prompt: "do it" }],
      ...over,
    });

  const withWorkspaceFile = () => {
    workspace.workspaceFile = { scheme: "file", fsPath: "/ws/ASM-1.code-workspace" };
  };

  /** The "already seeded this window" guard for one plan file. It carries the plan's
   * createdAt, so a test that pre-sets it has to pin the same value into the plan. */
  const guardKey = (createdAt: number, key = "ASM-1", identity = "/ws/ASM-1.code-workspace") =>
    `seeded:${key}:${createdAt}:${identity}`;

  it("returns early with no single-workspace identity", async () => {
    workspace.workspaceFile = undefined;
    workspace.workspaceFolders = undefined;
    const { context } = fakeContext();
    await maybeSeedAgent(context, () => {});
    expect(readdirSync).not.toHaveBeenCalled();
  });

  it("returns quietly when the plan dir does not exist", async () => {
    withWorkspaceFile();
    readdirSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const { context } = fakeContext();
    await expect(maybeSeedAgent(context, () => {})).resolves.toBeUndefined();
  });

  it("seeds the matching plan via the Claude Code command", async () => {
    withWorkspaceFile();
    const createdAt = Date.now();
    readdirSync.mockReturnValue(["ASM-1-1.json"] as never);
    readFileSync.mockReturnValue(planJson({ createdAt }));
    commands.getCommands.mockResolvedValue([CLAUDE_OPEN_CMD]);
    const { context, globalState } = fakeContext();

    await maybeSeedAgent(context, () => {});

    expect(commands.executeCommand).toHaveBeenCalledWith(CLAUDE_OPEN_CMD, undefined, "do it");
    expect(globalState.update).toHaveBeenCalledWith(guardKey(createdAt), true);
  });

  it("deletes an expired plan and does not seed", async () => {
    withWorkspaceFile();
    readdirSync.mockReturnValue(["ASM-1-old.json"] as never);
    readFileSync.mockReturnValue(planJson({ createdAt: Date.now() - 16 * 60 * 1000 }));
    const { context } = fakeContext();

    await maybeSeedAgent(context, () => {});

    expect(rmSync).toHaveBeenCalled();
    expect(commands.executeCommand).not.toHaveBeenCalledWith(CLAUDE_OPEN_CMD, undefined, expect.anything());
  });

  it("skips a plan whose matchPath is a different window", async () => {
    withWorkspaceFile();
    readdirSync.mockReturnValue(["ASM-1-1.json"] as never);
    readFileSync.mockReturnValue(planJson({ matches: [{ matchPath: "/other/window", prompt: "do it" }] }));
    commands.getCommands.mockResolvedValue([CLAUDE_OPEN_CMD]);
    const { context } = fakeContext();

    await maybeSeedAgent(context, () => {});
    expect(commands.executeCommand).not.toHaveBeenCalledWith(CLAUDE_OPEN_CMD, undefined, "do it");
  });

  // Within one plan's life this guard is what stops the watcher and activation from
  // both seeding the same session.
  it("does not re-seed a window already seeded from this very plan (globalState guard)", async () => {
    withWorkspaceFile();
    const createdAt = Date.now();
    readdirSync.mockReturnValue(["ASM-1-1.json"] as never);
    readFileSync.mockReturnValue(planJson({ createdAt }));
    commands.getCommands.mockResolvedValue([CLAUDE_OPEN_CMD]);
    const { context } = fakeContext({ globalState: { [guardKey(createdAt)]: true } });

    await maybeSeedAgent(context, () => {});
    expect(commands.executeCommand).not.toHaveBeenCalledWith(CLAUDE_OPEN_CMD, undefined, "do it");
  });

  // Nothing ever clears a `seeded:` key, and the shared-window filename is deterministic
  // — so a key-and-window-only guard made re-launching the same selection open a window
  // with correct folders and briefs and zero Claude sessions, while the toast still
  // claimed a session per task.
  it("seeds a re-launch of the same task into the same window", async () => {
    withWorkspaceFile();
    commands.getCommands.mockResolvedValue([CLAUDE_OPEN_CMD]);
    const { context } = fakeContext(); // one window's globalState across both passes

    readdirSync.mockReturnValue(["ASM-1-1.json"] as never);
    readFileSync.mockReturnValue(
      planJson({
        createdAt: Date.now() - 60_000,
        matches: [{ matchPath: "/ws/ASM-1.code-workspace", prompt: "first take" }],
      }),
    );
    await maybeSeedAgent(context, () => {});

    // Re-taking the same key writes a NEW plan naming the same deterministic window.
    readdirSync.mockReturnValue(["ASM-1-2.json"] as never);
    readFileSync.mockReturnValue(
      planJson({ matches: [{ matchPath: "/ws/ASM-1.code-workspace", prompt: "second take" }] }),
    );
    await maybeSeedAgent(context, () => {});

    const seeds = commands.executeCommand.mock.calls.filter((c) => String(c[0]).startsWith("claude-vscode."));
    expect(seeds.map((c) => c[2])).toEqual(["first take", "second take"]);
  });

  it("seeds every plan matching this window, in (createdAt, seq) order", async () => {
    vi.useFakeTimers();
    try {
      withWorkspaceFile();
      readdirSync.mockReturnValue(["ASM-2-1.json", "ASM-1-1.json"] as never);
      readFileSync.mockImplementation((p) =>
        String(p).includes("ASM-1")
          ? planJson({ key: "ASM-1", seq: 0, matches: [{ matchPath: "/ws/ASM-1.code-workspace", prompt: "first" }] })
          : planJson({ key: "ASM-2", seq: 1, matches: [{ matchPath: "/ws/ASM-1.code-workspace", prompt: "second" }] }),
      );
      commands.getCommands.mockResolvedValue(["claude-vscode.editor.open", CLAUDE_OPEN_CMD]);
      const { context } = fakeContext();

      const pending = maybeSeedAgent(context, () => {});
      await vi.runAllTimersAsync();
      await pending;

      const seeds = commands.executeCommand.mock.calls.filter((c) => String(c[0]).startsWith("claude-vscode."));
      expect(seeds.map((c) => c[2])).toEqual(["first", "second"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the new-tab command when seeding more than one session", async () => {
    vi.useFakeTimers();
    try {
      withWorkspaceFile();
      readdirSync.mockReturnValue(["ASM-1-1.json", "ASM-2-1.json"] as never);
      readFileSync.mockImplementation((p) =>
        String(p).includes("ASM-1")
          ? planJson({ key: "ASM-1", seq: 0 })
          : planJson({ key: "ASM-2", seq: 1 }),
      );
      commands.getCommands.mockResolvedValue(["claude-vscode.editor.open", CLAUDE_OPEN_CMD]);
      const { context } = fakeContext();

      const pending = maybeSeedAgent(context, () => {});
      await vi.runAllTimersAsync();
      await pending;

      expect(commands.executeCommand).toHaveBeenCalledWith("claude-vscode.editor.open", undefined, "do it");
      expect(commands.executeCommand).not.toHaveBeenCalledWith(CLAUDE_OPEN_CMD, undefined, "do it");
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the primary-editor command when the new-tab command is unregistered", async () => {
    vi.useFakeTimers();
    try {
      withWorkspaceFile();
      readdirSync.mockReturnValue(["ASM-1-1.json", "ASM-2-1.json"] as never);
      readFileSync.mockImplementation((p) =>
        String(p).includes("ASM-1") ? planJson({ key: "ASM-1", seq: 0 }) : planJson({ key: "ASM-2", seq: 1 }),
      );
      commands.getCommands.mockResolvedValue([CLAUDE_OPEN_CMD]);
      const { context } = fakeContext();

      const pending = maybeSeedAgent(context, () => {});
      await vi.runAllTimersAsync();
      await pending;

      expect(commands.executeCommand).toHaveBeenCalledWith(CLAUDE_OPEN_CMD, undefined, "do it");
    } finally {
      vi.useRealTimers();
    }
  });

  it("seeds the remaining plans when one is already consumed", async () => {
    vi.useFakeTimers();
    try {
      withWorkspaceFile();
      const createdAt = Date.now();
      readdirSync.mockReturnValue(["ASM-1-1.json", "ASM-2-1.json"] as never);
      readFileSync.mockImplementation((p) =>
        String(p).includes("ASM-1")
          ? planJson({ key: "ASM-1", createdAt, seq: 0, matches: [{ matchPath: "/ws/ASM-1.code-workspace", prompt: "first" }] })
          : planJson({ key: "ASM-2", createdAt, seq: 1, matches: [{ matchPath: "/ws/ASM-1.code-workspace", prompt: "second" }] }),
      );
      commands.getCommands.mockResolvedValue(["claude-vscode.editor.open", CLAUDE_OPEN_CMD]);
      const { context } = fakeContext({ globalState: { [guardKey(createdAt)]: true } });

      const pending = maybeSeedAgent(context, () => {});
      await vi.runAllTimersAsync();
      await pending;

      const seeds = commands.executeCommand.mock.calls.filter((c) => String(c[0]).startsWith("claude-vscode."));
      expect(seeds.map((c) => c[2])).toEqual(["second"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the clipboard fallback when seeding several sessions", async () => {
    vi.useFakeTimers();
    try {
      withWorkspaceFile();
      readdirSync.mockReturnValue(["ASM-1-1.json", "ASM-2-1.json"] as never);
      readFileSync.mockImplementation((p) =>
        String(p).includes("ASM-1") ? planJson({ key: "ASM-1", seq: 0 }) : planJson({ key: "ASM-2", seq: 1 }),
      );
      commands.getCommands.mockResolvedValue([]); // no Claude command at all
      env.openExternal.mockResolvedValue(false); // URI handler fails too
      const { context } = fakeContext();

      const pending = maybeSeedAgent(context, () => {});
      await vi.runAllTimersAsync();
      await pending;

      expect(env.clipboard.writeText).not.toHaveBeenCalled();
      expect(window.showInformationMessage).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes overlapping passes so a batch is never seeded twice", async () => {
    vi.useFakeTimers();
    try {
      withWorkspaceFile();
      // Both passes read the same two plan FILES, and a plan file is written once — so
      // pin createdAt instead of letting the fixture re-stamp it on the second read.
      const createdAt = Date.now();
      readdirSync.mockReturnValue(["ASM-1-1.json", "ASM-2-1.json"] as never);
      readFileSync.mockImplementation((p) =>
        String(p).includes("ASM-1")
          ? planJson({ key: "ASM-1", createdAt, seq: 0, matches: [{ matchPath: "/ws/ASM-1.code-workspace", prompt: "first" }] })
          : planJson({ key: "ASM-2", createdAt, seq: 1, matches: [{ matchPath: "/ws/ASM-1.code-workspace", prompt: "second" }] }),
      );
      commands.getCommands.mockResolvedValue(["claude-vscode.editor.open", CLAUDE_OPEN_CMD]);
      const { context } = fakeContext();

      // Simulates the watcher's debounce firing a second pass mid-batch — e.g. another
      // plan-dir write lands while the first pass is still staggering between sessions.
      // Without serializing, the second pass would re-collect the still-unguarded ASM-2
      // (its `seeded:` guard isn't written until its turn in the first pass) and seed it again.
      const first = maybeSeedAgent(context, () => {});
      const second = maybeSeedAgent(context, () => {});
      await vi.runAllTimersAsync();
      await Promise.all([first, second]);

      const seeds = commands.executeCommand.mock.calls.filter((c) => String(c[0]).startsWith("claude-vscode."));
      expect(seeds.map((c) => c[2])).toEqual(["first", "second"]); // each plan seeded exactly once
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("seedClaudeCode fallback chain (via maybeSeedAgent)", () => {
  const setupMatchingPlan = () => {
    workspace.workspaceFile = { scheme: "file", fsPath: "/ws/ASM-1.code-workspace" };
    readdirSync.mockReturnValue(["ASM-1-1.json"] as never);
    readFileSync.mockReturnValue(
      JSON.stringify({
        key: "ASM-1",
        createdAt: Date.now(),
        seedAgent: true,
        matches: [{ matchPath: "/ws/ASM-1.code-workspace", prompt: "do it" }],
      }),
    );
  };

  it("falls back to the URI handler when the command never registers", async () => {
    vi.useFakeTimers();
    try {
      setupMatchingPlan();
      commands.getCommands.mockResolvedValue([]); // command never appears
      env.openExternal.mockResolvedValue(true);
      const { context } = fakeContext();

      const p = maybeSeedAgent(context, () => {});
      await vi.runAllTimersAsync(); // flush the 7 polling delays
      await p;

      expect(env.openExternal).toHaveBeenCalled();
      expect(commands.executeCommand).not.toHaveBeenCalledWith(CLAUDE_OPEN_CMD, undefined, "do it");
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the clipboard when the URI handler declines", async () => {
    vi.useFakeTimers();
    try {
      setupMatchingPlan();
      commands.getCommands.mockResolvedValue([]);
      env.openExternal.mockResolvedValue(false);
      const { context } = fakeContext();

      const p = maybeSeedAgent(context, () => {});
      await vi.runAllTimersAsync();
      await p;

      expect(env.clipboard.writeText).toHaveBeenCalledWith("do it");
      expect(window.showInformationMessage).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("seedClaudeCode — remote control", () => {
  const seedPlan = (over: Record<string, unknown> = {}) => {
    workspace.workspaceFile = { scheme: "file", fsPath: "/ws/ASM-1.code-workspace" };
    readdirSync.mockReturnValue(["ASM-1-1.json"] as never);
    readFileSync.mockReturnValue(
      JSON.stringify({
        key: "ASM-1",
        createdAt: Date.now(),
        seedAgent: true,
        matches: [{ matchPath: "/ws/ASM-1.code-workspace", prompt: "do it" }],
        ...over,
      }),
    );
    commands.getCommands.mockResolvedValue([CLAUDE_OPEN_CMD]);
  };

  it("seeds the slash command and puts the task prompt on the clipboard", async () => {
    seedPlan({ remoteControl: true });
    const { context } = fakeContext();

    await maybeSeedAgent(context, () => {});

    expect(commands.executeCommand).toHaveBeenCalledWith(CLAUDE_OPEN_CMD, undefined, "/remote-control ASM-1");
    expect(env.clipboard.writeText).toHaveBeenCalledWith("do it");
    expect(window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("Remote Control"));
  });

  it("seeds the prompt and leaves the clipboard alone when not requested", async () => {
    seedPlan({ remoteControl: false });
    const { context } = fakeContext();

    await maybeSeedAgent(context, () => {});

    expect(commands.executeCommand).toHaveBeenCalledWith(CLAUDE_OPEN_CMD, undefined, "do it");
    expect(env.clipboard.writeText).not.toHaveBeenCalled();
    // Removing the `if (!remoteControl) return` guard in announceRemoteControl would still
    // pass every assertion above — this is what actually catches that regression.
    expect(window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("treats an absent remoteControl flag as off", async () => {
    seedPlan();
    const { context } = fakeContext();

    await maybeSeedAgent(context, () => {});

    expect(commands.executeCommand).toHaveBeenCalledWith(CLAUDE_OPEN_CMD, undefined, "do it");
    expect(env.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("sends the slash command through the URI handler too", async () => {
    vi.useFakeTimers();
    try {
      seedPlan({ remoteControl: true });
      commands.getCommands.mockResolvedValue([]); // command never registers
      env.openExternal.mockResolvedValue(true);
      const { context } = fakeContext();

      const p = maybeSeedAgent(context, () => {});
      await vi.runAllTimersAsync();
      await p;

      const uri = String(vi.mocked(env.openExternal).mock.calls[0][0]);
      expect(uri).toContain(encodeURIComponent("/remote-control ASM-1"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops Remote Control and keeps the task prompt when it falls back to the clipboard", async () => {
    vi.useFakeTimers();
    try {
      seedPlan({ remoteControl: true });
      commands.getCommands.mockResolvedValue([]);
      env.openExternal.mockResolvedValue(false);
      const { context } = fakeContext();

      const p = maybeSeedAgent(context, () => {});
      await vi.runAllTimersAsync();
      await p;

      // the prompt — not the slash command — is what the user is told to paste
      expect(env.clipboard.writeText).toHaveBeenLastCalledWith("do it");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("watchPlansAndSeed", () => {
  it("debounces plan-dir changes and re-runs seeding, and disposes cleanly", async () => {
    vi.useFakeTimers();
    try {
      const close = vi.fn();
      let fire: (() => void) | undefined;
      watch.mockImplementation(((_dir: string, cb: () => void) => {
        fire = cb;
        return { close } as unknown as fs.FSWatcher;
      }) as never);
      // Resolve a single-workspace identity so maybeSeedAgent proceeds far enough to
      // read the plan dir; readdirSync (no plan files, per the default mock) is the
      // observable signal for "ran once" that lets this test prove the debounce.
      workspace.workspaceFile = { scheme: "file", fsPath: "/ws/ASM-1.code-workspace" };

      const disp = watchPlansAndSeed(fakeContext().context, () => {});
      expect(fs.mkdirSync).toHaveBeenCalled(); // ensured PLAN_DIR exists

      fire!();
      fire!(); // two rapid changes
      expect(readdirSync).not.toHaveBeenCalled(); // still debounced — timer hasn't fired yet
      // Async: maybeSeedAgent now chains onto a module-level promise (serializing
      // passes), so invoking it needs a flushed microtask, not just the timer firing.
      await vi.advanceTimersByTimeAsync(300);
      expect(readdirSync).toHaveBeenCalledTimes(1); // maybeSeedAgent read the plan dir once (debounced)

      disp.dispose();
      expect(close).toHaveBeenCalled(); // closes the real fs.watch, which stops further callbacks
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears a pending debounce timer on dispose so it never fires", async () => {
    vi.useFakeTimers();
    try {
      const close = vi.fn();
      let fire: (() => void) | undefined;
      watch.mockImplementation(((_dir: string, cb: () => void) => {
        fire = cb;
        return { close } as unknown as fs.FSWatcher;
      }) as never);
      workspace.workspaceFile = { scheme: "file", fsPath: "/ws/ASM-1.code-workspace" };

      const disp = watchPlansAndSeed(fakeContext().context, () => {});
      fire!(); // schedules a debounced maybeSeedAgent call
      disp.dispose(); // must clear that pending timer before it fires
      await vi.advanceTimersByTimeAsync(300);
      expect(readdirSync).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("mergeReposIntoWorkspace", () => {
  const repos = mkRepos(["account-service", "centaur"]); // paths: /repos/account-service, /repos/centaur

  it("appends only missing repos and preserves comments + settings", () => {
    readFileSync.mockReturnValue(
      '{\n  // my workspace\n  "folders": [{ "name": "centaur", "path": "/repos/centaur" }],\n  "settings": { "editor.tabSize": 2 }\n}\n',
    );
    let written = "";
    writeFileSync.mockImplementation((_p, data) => { written = String(data); });

    const res = mergeReposIntoWorkspace("/ws/ASM-1.code-workspace", repos);

    expect(res).toEqual({ added: ["account-service"], ok: true });
    expect(written).toContain("// my workspace");            // comment preserved
    expect(written).toContain('"editor.tabSize": 2');        // settings preserved
    expect(written).toContain('"path": "/repos/account-service"'); // repo added
    // centaur present exactly once (not duplicated)
    expect(written.match(/\/repos\/centaur/g)?.length).toBe(1);
  });

  it("is idempotent — no write when all repos already present", () => {
    readFileSync.mockReturnValue(
      '{ "folders": [{ "path": "/repos/account-service" }, { "path": "/repos/centaur" }] }',
    );
    const res = mergeReposIntoWorkspace("/ws/ASM-1.code-workspace", repos);
    expect(res).toEqual({ added: [], ok: true });
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("resolves relative existing-folder paths against the workspace dir", () => {
    // workspace lives in /repos, folder path "centaur" → /repos/centaur (already present)
    readFileSync.mockReturnValue('{ "folders": [{ "path": "centaur" }] }');
    writeFileSync.mockImplementation(() => {});
    const res = mergeReposIntoWorkspace("/repos/team.code-workspace", repos);
    expect(res.added).toEqual(["account-service"]); // centaur matched via relative resolution
  });

  it("does NOT write on unparseable input (ok:false)", () => {
    readFileSync.mockReturnValue("{ this is : not json");
    const res = mergeReposIntoWorkspace("/ws/bad.code-workspace", repos);
    expect(res).toEqual({ added: [], ok: false });
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("does NOT write when the file can't be read (ok:false)", () => {
    readFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
    const res = mergeReposIntoWorkspace("/ws/missing.code-workspace", repos);
    expect(res).toEqual({ added: [], ok: false });
  });

  it("degrades gracefully when the workspace root is a JSON array (valid JSON, wrong shape)", () => {
    readFileSync.mockReturnValue("[]");
    const res = mergeReposIntoWorkspace("/ws/array.code-workspace", repos);
    expect(res).toEqual({ added: [], ok: false });
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("degrades gracefully when folders is a string (valid JSON, wrong shape)", () => {
    readFileSync.mockReturnValue('{ "folders": "nope" }');
    const res = mergeReposIntoWorkspace("/ws/bad-folders-string.code-workspace", repos);
    expect(res).toEqual({ added: [], ok: false });
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("degrades gracefully when folders is an object (valid JSON, wrong shape)", () => {
    readFileSync.mockReturnValue('{ "folders": {} }');
    const res = mergeReposIntoWorkspace("/ws/bad-folders-object.code-workspace", repos);
    expect(res).toEqual({ added: [], ok: false });
    expect(writeFileSync).not.toHaveBeenCalled();
  });
});

describe("openWorkspace — existing workspace", () => {
  it("merges exactly foldersToAdd — never anything derived from services", async () => {
    // foldersToAdd names a repo that's in neither `services` nor the file, so a
    // regression to deriving the merge from `services` (which would settle on
    // account-service, the one of the two not already declared) is caught: it
    // wouldn't match "infra".
    readFileSync.mockImplementation((p) =>
      String(p).endsWith(".code-workspace") ? '{ "folders": [{ "path": "/repos/centaur" }] }' : "",
    );

    const result = await openWorkspace(
      baseReq({
        existingWorkspaceFile: "/ws/team.code-workspace",
        foldersToAdd: [{ name: "infra", path: "/repos/infra" }],
      }),
    );

    expect(result.mode).toBe("multiroot");
    expect(result.workspaceFile).toBe("/ws/team.code-workspace");
    expect(result.mergedRepos).toEqual(["infra"]);
    expect(result.mergeFailed).toBeUndefined();
    expect(writeArg((p) => p.endsWith("ASM-1.code-workspace"))).toBeUndefined();
    expect(result.opened).toContain("/ws/team.code-workspace");
  });

  it("reports mergeFailed when the picked file is unparseable and still opens it", async () => {
    readFileSync.mockImplementation((p) =>
      String(p).endsWith(".code-workspace") ? "{ broken" : "",
    );
    const result = await openWorkspace(baseReq({ existingWorkspaceFile: "/ws/bad.code-workspace" }));
    expect(result.mergeFailed).toBe(true);
    expect(result.opened).toContain("/ws/bad.code-workspace");
  });

  it("seeds a plan whose matchPath is the picked workspace", async () => {
    readFileSync.mockImplementation((p) =>
      String(p).endsWith(".code-workspace") ? '{ "folders": [] }' : "",
    );
    await openWorkspace(baseReq({ existingWorkspaceFile: "/ws/team.code-workspace" }));
    const planCall = writeArg((p) => p.includes("/.agentflow/plans/"));
    expect(planCall).toBeDefined();
    expect(String(planCall![1])).toContain('"matchPath": "/ws/team.code-workspace"');
  });

  it("leaves the file untouched when foldersToAdd is absent", async () => {
    // The user's workspace is their artifact: no approval, no write.
    readFileSync.mockImplementation((p) =>
      String(p).endsWith(".code-workspace") ? '{ "folders": [{ "path": "/repos/centaur" }] }' : "",
    );

    const result = await openWorkspace(baseReq({ existingWorkspaceFile: "/ws/team.code-workspace" }));

    expect(writeArg((p) => p.endsWith(".code-workspace"))).toBeUndefined();
    expect(result.mergedRepos).toEqual([]);
    expect(result.mergeFailed).toBeUndefined();
    expect(result.opened).toContain("/ws/team.code-workspace");
  });

  it("leaves the file untouched when foldersToAdd is empty", async () => {
    readFileSync.mockImplementation((p) =>
      String(p).endsWith(".code-workspace") ? '{ "folders": [{ "path": "/repos/centaur" }] }' : "",
    );
    await openWorkspace(baseReq({ existingWorkspaceFile: "/ws/team.code-workspace", foldersToAdd: [] }));
    expect(writeArg((p) => p.endsWith(".code-workspace"))).toBeUndefined();
  });

  it("routes a worktree's mentions through its containing root", async () => {
    execSync.mockReturnValue("src/export.py\n"); // git ls-files
    readFileSync.mockImplementation((p) =>
      String(p).endsWith(".code-workspace") ? '{ "folders": [{ "path": "/repos/centaur" }] }' : "",
    );

    await openWorkspace(
      baseReq({
        services: [{ name: "centaur", path: "/repos/centaur/.claude/worktrees/ASM-1", isGit: true }],
        descriptionText: "fix `src/export.py`",
        existingWorkspaceFile: "/ws/team.code-workspace",
      }),
    );

    const planWrite = writeArg((p) => p.includes("/.agentflow/plans/"));
    const plan = JSON.parse(String(planWrite![1]));
    expect(plan.matches[0].prompt).toContain("@centaur/.claude/worktrees/ASM-1/src/export.py");
  });

  it("drops mentions for a repo that is inside no root", async () => {
    execSync.mockReturnValue("src/export.py\n");
    readFileSync.mockImplementation((p) =>
      String(p).endsWith(".code-workspace") ? '{ "folders": [{ "path": "/repos/centaur" }] }' : "",
    );

    await openWorkspace(
      baseReq({
        services: mkRepos(["infra"]),
        descriptionText: "fix `src/export.py`",
        existingWorkspaceFile: "/ws/team.code-workspace",
      }),
    );

    const plan = JSON.parse(String(writeArg((p) => p.includes("/.agentflow/plans/"))![1]));
    expect(plan.matches[0].prompt).not.toContain("Relevant files:");
    expect(plan.matches[0].prompt).not.toContain("@infra");
  });

  it("uses an absolute {brief} path, which a non-root repo's relative form can't provide", async () => {
    readFileSync.mockImplementation((p) =>
      String(p).endsWith(".code-workspace") ? '{ "folders": [] }' : "",
    );

    await openWorkspace(
      baseReq({
        services: mkRepos(["centaur"]),
        promptTemplate: "brief at {brief}",
        existingWorkspaceFile: "/ws/team.code-workspace",
      }),
    );

    const plan = JSON.parse(String(writeArg((p) => p.includes("/.agentflow/plans/"))![1]));
    expect(plan.matches[0].prompt).toBe("brief at /repos/centaur/.pick-task/TASK.md");
  });
});

describe("openWorkspace — existing folder window", () => {
  it("focuses the folder, seeds a matching plan, and reports repos not added as roots", async () => {
    // Two services; the open folder window is /repos/account-service.
    const result = await openWorkspace(
      baseReq({ existingFolder: "/repos/account-service" }),
    );

    expect(result.mode).toBe("per-window");
    expect(result.workspaceFile).toBeUndefined();
    expect(result.opened).toEqual(["/repos/account-service"]);
    // account-service IS the open folder; centaur can't be added as a root.
    expect(result.unaddedRepos).toEqual(["centaur"]);

    const planWrite = writeArg((p) => p.includes(".agentflow") && p.includes("plans") && p.endsWith(".json"));
    const plan = JSON.parse(String(planWrite![1]));
    expect(plan.matches).toHaveLength(1);
    expect(plan.matches[0].matchPath).toBe("/repos/account-service");

    // The per-repo brief loop already writes account-service's TASK.md; the existingFolder
    // guard must not write a second one into the same folder.
    expect(
      writeFileSync.mock.calls.filter((c) => String(c[0]) === "/repos/account-service/.pick-task/TASK.md"),
    ).toHaveLength(1);
  });

  it("writes a brief into the target folder when it is not one of the repos", async () => {
    await openWorkspace(baseReq({ services: mkRepos(["solo"]), existingFolder: "/other/open-window" }));
    const brief = writeArg((p) => p === "/other/open-window/.pick-task/TASK.md");
    expect(brief).toBeTruthy();
    expect(String(brief![1])).toContain("ASM-1");
  });
});

describe("openWorkspace — remote control", () => {
  const planOf = () => {
    const w = writeArg((p) => p.includes(".agentflow") && p.includes("plans") && p.endsWith(".json"));
    return JSON.parse(String(w![1]));
  };

  it("records remoteControl on the plan for a single-window launch", async () => {
    const result = await openWorkspace(baseReq({ remoteControl: true }));
    expect(result.remoteControl).toBe(true);
    expect(planOf().remoteControl).toBe(true);
  });

  it("records false when the launch did not ask", async () => {
    const result = await openWorkspace(baseReq());
    expect(result.remoteControl).toBe(false);
    expect(planOf().remoteControl).toBe(false);
  });

  it("withholds it when the launch opens more than one window", async () => {
    // per-window across two repos → two matches → two windows, one clipboard
    const result = await openWorkspace(baseReq({ mode: "per-window", remoteControl: true }));
    expect(planOf().matches).toHaveLength(2);
    expect(result.remoteControl).toBe(false);
    expect(planOf().remoteControl).toBe(false);
  });

  it("allows it for a per-window launch of a single repo", async () => {
    const result = await openWorkspace(
      baseReq({ mode: "per-window", services: mkRepos(["account-service"]), remoteControl: true }),
    );
    expect(planOf().matches).toHaveLength(1);
    expect(result.remoteControl).toBe(true);
  });

  it("withholds it when seedAgent is off — no plan file means nothing could ever seed it", async () => {
    const result = await openWorkspace(baseReq({ seedAgent: false, remoteControl: true }));
    expect(result.remoteControl).toBe(false);
    expect(writeArg((p) => p.includes(".agentflow") && p.includes("plans") && p.endsWith(".json"))).toBeUndefined();
  });
});

describe("listWorkspaceFiles", () => {
  it("lists only .code-workspace files, newest first, with folder counts", () => {
    readdirSync.mockReturnValue(["b.code-workspace", "notes.txt", "a.code-workspace"] as never);
    statSync.mockImplementation((p) =>
      ({ isFile: () => true, mtimeMs: String(p).endsWith("a.code-workspace") ? 200 : 100 }) as unknown as fs.Stats,
    );
    readFileSync.mockImplementation((p) =>
      String(p).endsWith("a.code-workspace")
        ? '{ "folders": [{ "path": "x" }] }'
        : '{ /* c */ "folders": [{ "path": "y" }, { "path": "z" }] }',
    );

    const items = listWorkspaceFiles("/ws");

    expect(items.map((i) => i.file.split("/").pop())).toEqual(["a.code-workspace", "b.code-workspace"]);
    expect(items[0].folders).toBe(1);
    expect(items[1].folders).toBe(2);
  });

  it("returns [] when the directory can't be read", () => {
    readdirSync.mockImplementation(() => { throw new Error("ENOENT"); });
    expect(listWorkspaceFiles("/nope")).toEqual([]);
  });

  it("tolerates an unparseable workspace file (folders = 0)", () => {
    readdirSync.mockReturnValue(["broken.code-workspace"] as never);
    statSync.mockReturnValue({ isFile: () => true, mtimeMs: 1 } as unknown as fs.Stats);
    readFileSync.mockReturnValue("{ not json");
    expect(listWorkspaceFiles("/ws")[0].folders).toBe(0);
  });

  it("excludes a directory entry named like a workspace file", () => {
    readdirSync.mockReturnValue(["dir.code-workspace"] as never);
    statSync.mockReturnValue({ isFile: () => false, mtimeMs: 5 } as unknown as fs.Stats);
    expect(listWorkspaceFiles("/ws")).toEqual([]);
  });
});

describe("workspaceFolders", () => {
  it("returns each folder's name and canonical path, resolved against the file's dir", () => {
    readFileSync.mockReturnValue(
      '{ "folders": [{ "name": "API", "path": "api" }, { "path": "/repos/centaur" }] }',
    );
    expect(workspaceFolders("/repos/team.code-workspace")).toEqual([
      { name: "API", path: "/repos/api" },
      { path: "/repos/centaur" },
    ]);
  });

  it("skips folders with no string path", () => {
    readFileSync.mockReturnValue('{ "folders": [{ "name": "nameless" }, { "path": "/repos/centaur" }] }');
    expect(workspaceFolders("/ws/t.code-workspace")).toEqual([{ path: "/repos/centaur" }]);
  });

  it("distinguishes a valid empty folders array from a parse failure", () => {
    readFileSync.mockReturnValue('{ "folders": [] }');
    expect(workspaceFolders("/ws/empty.code-workspace")).toEqual([]);
  });

  it("treats an absent folders key as an empty workspace, not a parse failure", () => {
    readFileSync.mockReturnValue('{ "settings": {} }');
    expect(workspaceFolders("/ws/nofolders.code-workspace")).toEqual([]);
  });

  it("returns undefined when the file is unparseable", () => {
    readFileSync.mockReturnValue("{ this is : not json");
    expect(workspaceFolders("/ws/bad.code-workspace")).toBeUndefined();
  });

  it("returns undefined when the file can't be read", () => {
    readFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
    expect(workspaceFolders("/ws/missing.code-workspace")).toBeUndefined();
  });

  it("returns undefined when folders is the wrong shape", () => {
    readFileSync.mockReturnValue('{ "folders": "nope" }');
    expect(workspaceFolders("/ws/bad-shape.code-workspace")).toBeUndefined();
  });
});

describe("planWorkspaceMerge", () => {
  const cand = (repoName: string, p: string, label = repoName): MergeCandidate => ({
    label,
    repoName,
    path: p,
  });

  it("buckets an already-declared path as present", () => {
    readFileSync.mockReturnValue('{ "folders": [{ "path": "/repos/centaur" }] }');
    const plan = planWorkspaceMerge("/ws/t.code-workspace", [cand("centaur", "/repos/centaur")]);
    expect(plan.present.map((c) => c.repoName)).toEqual(["centaur"]);
    expect(plan.add).toEqual([]);
    expect(plan.duplicates).toEqual([]);
    expect(plan.ok).toBe(true);
  });

  it("buckets a worktree of an already-declared repo as a duplicate, not an addition", () => {
    // The core case: same repo NAME, different path. A second root called `centaur`
    // is indistinguishable in the explorer and makes @centaur/… ambiguous.
    readFileSync.mockReturnValue('{ "folders": [{ "path": "/repos/centaur" }] }');
    const plan = planWorkspaceMerge("/ws/t.code-workspace", [
      cand("centaur", "/repos/centaur/.claude/worktrees/ASM-1"),
    ]);
    expect(plan.duplicates.map((c) => c.repoName)).toEqual(["centaur"]);
    expect(plan.add).toEqual([]);
  });

  it("buckets a repo the workspace has by neither path nor name as an addition", () => {
    readFileSync.mockReturnValue('{ "folders": [{ "path": "/repos/centaur" }] }');
    const plan = planWorkspaceMerge("/ws/t.code-workspace", [cand("infra", "/repos/infra")]);
    expect(plan.add.map((c) => c.repoName)).toEqual(["infra"]);
    expect(plan.duplicates).toEqual([]);
  });

  it("dedups against a folder's custom name field", () => {
    readFileSync.mockReturnValue('{ "folders": [{ "name": "centaur", "path": "/elsewhere/c" }] }');
    const plan = planWorkspaceMerge("/ws/t.code-workspace", [cand("centaur", "/repos/centaur")]);
    expect(plan.duplicates.map((c) => c.repoName)).toEqual(["centaur"]);
  });

  it("dedups against a folder's path basename even when a custom name differs", () => {
    // servicesFromExistingDestination derives an unmatched folder's service name from
    // the BASENAME, so comparing only the `name` field would let a custom name defeat
    // the rule against the service derived from that very folder.
    readFileSync.mockReturnValue('{ "folders": [{ "name": "Custom Label", "path": "/repos/centaur" }] }');
    const plan = planWorkspaceMerge("/ws/t.code-workspace", [
      cand("centaur", "/repos/centaur/.claude/worktrees/ASM-1"),
    ]);
    expect(plan.duplicates.map((c) => c.repoName)).toEqual(["centaur"]);
  });

  it("compares names case-insensitively", () => {
    readFileSync.mockReturnValue('{ "folders": [{ "name": "API", "path": "/elsewhere/a" }] }');
    const plan = planWorkspaceMerge("/ws/t.code-workspace", [cand("api", "/repos/api")]);
    expect(plan.duplicates.map((c) => c.repoName)).toEqual(["api"]);
  });

  it("dedups a key-qualified batch label against the bare repo name", () => {
    // The label written into the file is ASM-1-api, but dedup must compare `api`.
    readFileSync.mockReturnValue('{ "folders": [{ "path": "/repos/api" }] }');
    const plan = planWorkspaceMerge("/ws/t.code-workspace", [
      cand("api", "/repos/api/.claude/worktrees/ASM-1", "ASM-1-api"),
    ]);
    expect(plan.duplicates.map((c) => c.label)).toEqual(["ASM-1-api"]);
    expect(plan.add).toEqual([]);
  });

  it("offers everything when the workspace declares no folders", () => {
    readFileSync.mockReturnValue('{ "folders": [] }');
    const plan = planWorkspaceMerge("/ws/empty.code-workspace", [
      cand("api", "/repos/api"),
      cand("centaur", "/repos/centaur"),
    ]);
    expect(plan.add.map((c) => c.repoName)).toEqual(["api", "centaur"]);
    expect(plan.ok).toBe(true);
  });

  it("offers everything when the folders key is absent entirely", () => {
    // A parseable file with no folders key is not a failure — mergeReposIntoWorkspace
    // has always accepted it. ok:false here would mean no prompt and no add at all.
    readFileSync.mockReturnValue('{ "settings": {} }');
    const plan = planWorkspaceMerge("/ws/nofolders.code-workspace", [cand("api", "/repos/api")]);
    expect(plan.add.map((c) => c.repoName)).toEqual(["api"]);
    expect(plan.ok).toBe(true);
  });

  it("reports ok:false with empty buckets when the file is unparseable", () => {
    readFileSync.mockReturnValue("{ broken");
    const plan = planWorkspaceMerge("/ws/bad.code-workspace", [cand("api", "/repos/api")]);
    expect(plan).toEqual({ add: [], duplicates: [], present: [], ok: false });
  });

  it("never writes", () => {
    readFileSync.mockReturnValue('{ "folders": [] }');
    planWorkspaceMerge("/ws/t.code-workspace", [cand("api", "/repos/api")]);
    expect(writeFileSync).not.toHaveBeenCalled();
  });
});

describe("workspaceFolderPaths", () => {
  it("returns canonical folder paths, resolving relative paths against the file dir", () => {
    // realpathSync is mocked to identity in beforeEach, so canon() returns its input.
    readFileSync.mockReturnValue('{ "folders": [{ "path": "/repos/centaur" }, { "path": "account-service" }] }');
    const paths = workspaceFolderPaths("/repos/team.code-workspace");
    expect(paths).toEqual(["/repos/centaur", "/repos/account-service"]);
  });

  it("returns [] on unparseable input", () => {
    readFileSync.mockReturnValue("{ not json");
    expect(workspaceFolderPaths("/ws/bad.code-workspace")).toEqual([]);
  });

  it("returns [] when the file can't be read", () => {
    readFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
    expect(workspaceFolderPaths("/ws/missing.code-workspace")).toEqual([]);
  });

  it("returns [] when folders is missing or not an array", () => {
    readFileSync.mockReturnValue('{ "settings": {} }');
    expect(workspaceFolderPaths("/ws/nofolders.code-workspace")).toEqual([]);
  });
});

describe("mentionInWorkspace", () => {
  it("uses the root's own name when the repo IS a root", () => {
    const roots = [{ path: "/repos/centaur" }];
    expect(mentionInWorkspace(roots, "/repos/centaur", "src/x.ts")).toBe("@centaur/src/x.ts");
  });

  it("prefers a root's custom name field over its basename", () => {
    const roots = [{ name: "Centaur Service", path: "/repos/centaur" }];
    expect(mentionInWorkspace(roots, "/repos/centaur", "src/x.ts")).toBe("@Centaur Service/src/x.ts");
  });

  it("routes a worktree through its containing root", () => {
    // The whole point: the worktree is not a root, but it IS inside one, so the
    // mention can name it precisely instead of resolving to the main checkout.
    const roots = [{ path: "/repos/centaur" }];
    expect(mentionInWorkspace(roots, "/repos/centaur/.claude/worktrees/ASM-1", "src/x.ts")).toBe(
      "@centaur/.claude/worktrees/ASM-1/src/x.ts",
    );
  });

  it("picks the deepest containing root, matching VS Code's most-specific resolution", () => {
    const roots = [{ path: "/repos" }, { path: "/repos/centaur" }];
    expect(mentionInWorkspace(roots, "/repos/centaur/.claude/worktrees/ASM-1", "src/x.ts")).toBe(
      "@centaur/.claude/worktrees/ASM-1/src/x.ts",
    );
  });

  it("returns undefined when the repo is inside no root", () => {
    // Emitting @centaur/src/x.ts here would point the agent at a DIFFERENT checkout.
    const roots = [{ path: "/repos/centaur" }];
    expect(mentionInWorkspace(roots, "/repos/infra", "src/x.ts")).toBeUndefined();
  });

  it("returns undefined when there are no roots at all", () => {
    expect(mentionInWorkspace([], "/repos/centaur", "src/x.ts")).toBeUndefined();
  });

  it("does not treat a sibling with a shared prefix as containment", () => {
    const roots = [{ path: "/repos/api" }];
    expect(mentionInWorkspace(roots, "/repos/api-gateway", "src/x.ts")).toBeUndefined();
  });
});
