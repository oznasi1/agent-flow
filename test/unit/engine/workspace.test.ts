import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as childProcess from "child_process";
import { openWorkspace, maybeSeedAgent, watchPlansAndSeed, listWorkspaceFiles, mergeReposIntoWorkspace, type OpenRequest } from "../../../src/engine/workspace";
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
    const planWrite = writeArg((p) => p.includes(".flowdeck") && p.includes("plans") && p.endsWith(".json"));
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
    expect(writeArg((p) => p.includes(".flowdeck") && p.includes("plans") && p.endsWith(".json"))).toBeUndefined();
  });

  it("always writes a durable run record for the Deck (even with seedAgent off)", async () => {
    await openWorkspace(baseReq({ seedAgent: false }));
    const runWrite = writeArg((p) => p.includes(".flowdeck") && p.includes("runs") && p.endsWith(".json"));
    expect(runWrite).toBeTruthy();
    const run = JSON.parse(String(runWrite![1]));
    expect(run.key).toBe("ASM-1");
    expect(run.mode).toBe("multiroot");
    expect(run.repos.map((r: { name: string }) => r.name)).toEqual(["account-service", "centaur"]);
  });
});

describe("openWorkspace — per-window", () => {
  it("opens one window per repo and records each path as a match", async () => {
    const result = await openWorkspace(baseReq({ mode: "per-window" }));
    expect(result.workspaceFile).toBeUndefined();
    expect(result.opened).toEqual(["/repos/account-service", "/repos/centaur"]);
    const planWrite = writeArg((p) => p.includes(".flowdeck") && p.includes("plans") && p.endsWith(".json"));
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
    const planWrite = writeArg((p) => p.includes(".flowdeck") && p.includes("plans") && p.endsWith(".json"));
    const plan = JSON.parse(String(planWrite![1]));
    expect(plan.matches[0].prompt).toContain("Relevant files:");
    expect(plan.matches[0].prompt).toContain("export.py");
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
    readdirSync.mockReturnValue(["ASM-1-1.json"] as never);
    readFileSync.mockReturnValue(planJson());
    commands.getCommands.mockResolvedValue([CLAUDE_OPEN_CMD]);
    const { context, globalState } = fakeContext();

    await maybeSeedAgent(context, () => {});

    expect(commands.executeCommand).toHaveBeenCalledWith(CLAUDE_OPEN_CMD, undefined, "do it");
    expect(globalState.update).toHaveBeenCalledWith("seeded:ASM-1:/ws/ASM-1.code-workspace", true);
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

  it("does not re-seed a window already seeded (globalState guard)", async () => {
    withWorkspaceFile();
    readdirSync.mockReturnValue(["ASM-1-1.json"] as never);
    readFileSync.mockReturnValue(planJson());
    commands.getCommands.mockResolvedValue([CLAUDE_OPEN_CMD]);
    const { context } = fakeContext({
      globalState: { "seeded:ASM-1:/ws/ASM-1.code-workspace": true },
    });

    await maybeSeedAgent(context, () => {});
    expect(commands.executeCommand).not.toHaveBeenCalledWith(CLAUDE_OPEN_CMD, undefined, "do it");
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

describe("watchPlansAndSeed", () => {
  it("debounces plan-dir changes and re-runs seeding, and disposes cleanly", () => {
    vi.useFakeTimers();
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
    vi.advanceTimersByTime(300);
    expect(readdirSync).toHaveBeenCalledTimes(1); // maybeSeedAgent read the plan dir once (debounced)

    disp.dispose();
    expect(close).toHaveBeenCalled(); // closes the real fs.watch, which stops further callbacks

    vi.useRealTimers();
  });

  it("clears a pending debounce timer on dispose so it never fires", () => {
    vi.useFakeTimers();
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
    vi.advanceTimersByTime(300);
    expect(readdirSync).not.toHaveBeenCalled();

    vi.useRealTimers();
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
});

describe("openWorkspace — existing workspace", () => {
  it("merges repos into the picked file and does not generate a new one", async () => {
    // Picked workspace already contains centaur; account-service is missing.
    readFileSync.mockImplementation((p) =>
      String(p).endsWith(".code-workspace") ? '{ "folders": [{ "path": "/repos/centaur" }] }' : "",
    );

    const result = await openWorkspace(baseReq({ existingWorkspaceFile: "/ws/team.code-workspace" }));

    expect(result.mode).toBe("multiroot");
    expect(result.workspaceFile).toBe("/ws/team.code-workspace");
    expect(result.mergedRepos).toEqual(["account-service"]);
    expect(result.mergeFailed).toBeUndefined();
    // No generated <KEY>.code-workspace was written.
    expect(writeArg((p) => p.endsWith("ASM-1.code-workspace"))).toBeUndefined();
    // It opened the picked file.
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
    const planCall = writeArg((p) => p.includes("/.flowdeck/plans/"));
    expect(planCall).toBeDefined();
    expect(String(planCall![1])).toContain('"matchPath": "/ws/team.code-workspace"');
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
});
