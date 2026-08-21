import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as childProcess from "child_process";
import { openSharedWorkspace, type SharedOpenRequest } from "../../../src/engine/batchWorkspace";
import { commands } from "../../_mocks/vscode";

vi.mock("fs");
vi.mock("child_process");

const existsSync = vi.mocked(fs.existsSync);
const readFileSync = vi.mocked(fs.readFileSync);
const writeFileSync = vi.mocked(fs.writeFileSync);
const realpathSync = vi.mocked(fs.realpathSync);
const execSync = vi.mocked(childProcess.execSync);
const execFileSync = vi.mocked(childProcess.execFileSync);
const exec = vi.mocked(childProcess.exec);

beforeEach(() => {
  vi.mocked(fs).mkdirSync.mockReset();
  writeFileSync.mockReset();
  vi.mocked(fs).appendFileSync.mockReset();
  existsSync.mockReset().mockImplementation((p) => String(p).endsWith("/.git"));
  readFileSync.mockReset().mockReturnValue("");
  realpathSync.mockReset().mockImplementation((p) => String(p));
  execSync.mockReset().mockReturnValue(""); // git ls-files → no files
  execFileSync.mockReset().mockReturnValue(""); // gitState's git calls → no state
  exec.mockReset().mockImplementation(((_c: string, cb: (e: unknown) => void) => cb(null)) as never);
});

/** Two tasks, each with one worktree in `api`. */
const baseReq = (over: Partial<SharedOpenRequest> = {}): SharedOpenRequest => ({
  tasks: [
    {
      ticket: { key: "ASM-1", summary: "one", url: "https://jira/ASM-1" },
      planMd: "## Plan\n\na",
      descriptionText: "",
      services: [{ name: "api", path: "/repos/api/.claude/worktrees/ASM-1", isGit: true }],
    },
    {
      ticket: { key: "ASM-2", summary: "two", url: "https://jira/ASM-2" },
      planMd: "## Plan\n\nb",
      descriptionText: "",
      services: [{ name: "api", path: "/repos/api/.claude/worktrees/ASM-2", isGit: true }],
    },
  ],
  promptTemplate: "Start {key} — brief at {brief}{files}",
  workspaceDir: "/ws",
  seedAgent: true,
  target: { kind: "new" },
  ...over,
});

const writes = (predicate: (p: string) => boolean) =>
  writeFileSync.mock.calls.filter((c) => predicate(String(c[0])));

describe("openSharedWorkspace", () => {
  it("writes one brief per task-service pair, none overwriting another", async () => {
    const result = await openSharedWorkspace(baseReq());
    const briefs = writes((p) => p.endsWith("TASK.md"));
    expect(briefs.map((c) => String(c[0]))).toEqual([
      "/repos/api/.claude/worktrees/ASM-1/.pick-task/TASK.md",
      "/repos/api/.claude/worktrees/ASM-2/.pick-task/TASK.md",
    ]);
    expect(result.briefs).toHaveLength(2);
  });

  it("names each folder <repo>-<KEY> so two worktrees of one repo stay distinct", async () => {
    await openSharedWorkspace(baseReq());
    const ws = JSON.parse(String(writes((p) => p.endsWith(".code-workspace"))[0][1]));
    expect(ws.folders).toEqual([
      { name: "api-ASM-1", path: "/repos/api/.claude/worktrees/ASM-1" },
      { name: "api-ASM-2", path: "/repos/api/.claude/worktrees/ASM-2" },
    ]);
  });

  it("names the workspace file after the first key and the remaining count", async () => {
    const result = await openSharedWorkspace(baseReq());
    expect(result.workspaceFile).toBe("/ws/ASM-1+1.code-workspace");
  });

  it("writes one plan and one run per task, all pointing at the same window", async () => {
    await openSharedWorkspace(baseReq());
    const plans = writes((p) => p.includes("/plans/")).map((c) => JSON.parse(String(c[1])));
    expect(plans.map((p) => p.key)).toEqual(["ASM-1", "ASM-2"]);
    expect(plans.map((p) => p.seq)).toEqual([0, 1]);
    expect(plans.every((p) => p.matches[0].matchPath === "/ws/ASM-1+1.code-workspace")).toBe(true);

    const runs = writes((p) => p.includes("/runs/")).map((c) => JSON.parse(String(c[1])));
    expect(runs.map((r) => r.key)).toEqual(["ASM-1", "ASM-2"]);
    expect(runs.every((r) => r.workspaceFile === "/ws/ASM-1+1.code-workspace")).toBe(true);
    expect(runs.every((r) => r.mode === "multiroot")).toBe(true);
  });

  // ── Task 6: the batch's resolved agent ────────────────────────────────────
  it("stamps the caller's resolved agent onto every plan file", async () => {
    // The shared path never calls openWorkspace, so nothing else can carry the answer
    // to the target window: without this the plan files say nothing, that window falls
    // back to reading `agentProvider` live, and under `ask` it degrades the whole
    // batch to Claude Code — an agent the user did not pick, minutes after picking one.
    await openSharedWorkspace(baseReq({ provider: "cursor" }));
    const plans = writes((p) => p.includes("/plans/")).map((c) => JSON.parse(String(c[1])));
    expect(plans.map((p) => p.provider)).toEqual(["cursor", "cursor"]);
  });

  it("writes no provider at all when the caller sends none", async () => {
    // Inertness: under a fixed setting the caller sends nothing, and the plan file has
    // to stay byte-identical — absent is how "read the setting live at seed time" is
    // spelled, and it is what every plan file said before `ask` existed.
    await openSharedWorkspace(baseReq());
    const plans = writes((p) => p.includes("/plans/")).map((c) => JSON.parse(String(c[1])));
    expect(plans.every((p) => !("provider" in p))).toBe(true);
  });

  it("stamps the pinned provider onto every run in the batch", async () => {
    await openSharedWorkspace(baseReq({ seedAgent: true, provider: "cursor" }));
    const runs = writes((p) => p.includes("/runs/")).map((c) => JSON.parse(String(c[1])));
    expect(runs.length).toBeGreaterThan(1);
    expect(runs.map((r) => r.provider)).toEqual(runs.map(() => "cursor"));
  });

  it("stamps no provider on a batch that seeded no agent", async () => {
    await openSharedWorkspace(baseReq({ seedAgent: false }));
    const runs = writes((p) => p.includes("/runs/")).map((c) => JSON.parse(String(c[1])));
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs) expect(r.provider).toBeUndefined();
  });

  it("seeds each prompt with that task's absolute brief path", async () => {
    await openSharedWorkspace(baseReq());
    const plans = writes((p) => p.includes("/plans/")).map((c) => JSON.parse(String(c[1])));
    expect(plans[0].matches[0].prompt).toContain("/repos/api/.claude/worktrees/ASM-1/.pick-task/TASK.md");
    expect(plans[1].matches[0].prompt).toContain("/repos/api/.claude/worktrees/ASM-2/.pick-task/TASK.md");
  });

  it("qualifies file mentions with the folder name so they resolve to the right root", async () => {
    execSync.mockReturnValue("src/foo.ts\n");
    await openSharedWorkspace(
      baseReq({
        tasks: [
          {
            ticket: { key: "ASM-1", summary: "one", url: "" },
            planMd: "p",
            descriptionText: "look at `src/foo.ts`",
            services: [{ name: "api", path: "/repos/api/.claude/worktrees/ASM-1", isGit: true }],
          },
        ],
      }),
    );
    const plan = JSON.parse(String(writes((p) => p.includes("/plans/"))[0][1]));
    expect(plan.matches[0].prompt).toContain("@api-ASM-1/src/foo.ts");
  });

  it("writes no plan file when seeding is off", async () => {
    const result = await openSharedWorkspace(baseReq({ seedAgent: false }));
    expect(writes((p) => p.includes("/plans/"))).toHaveLength(0);
    expect(result.seeded).toBe(0);
  });

  it("reports mergeFailed and writes nothing when the existing workspace is unparseable", async () => {
    readFileSync.mockReturnValue("{ not json");
    const result = await openSharedWorkspace(baseReq({ target: { kind: "existing", file: "/ws/team.code-workspace" } }));
    expect(result.mergeFailed).toBe(true);
    expect(result.mergedFolders ?? []).toEqual([]);
  });

  it("adds no folders to a live folder window and reports them unadded", async () => {
    const result = await openSharedWorkspace(baseReq({ target: { kind: "live-folder", folder: "/repos/web" } }));
    expect(result.workspaceFile).toBeUndefined();
    expect(result.unaddedFolders).toEqual(["api-ASM-1", "api-ASM-2"]);
    const plans = writes((p) => p.includes("/plans/")).map((c) => JSON.parse(String(c[1])));
    expect(plans.every((p) => p.matches[0].matchPath === "/repos/web")).toBe(true);
  });

  it("bares the mentions for a live folder window, whose roots never gain the worktrees", async () => {
    execSync.mockReturnValue("src/foo.ts\n");
    await openSharedWorkspace(
      baseReq({
        target: { kind: "live-folder", folder: "/repos/web" },
        tasks: [
          {
            ticket: { key: "ASM-1", summary: "one", url: "" },
            planMd: "p",
            descriptionText: "look at `src/foo.ts`",
            services: [{ name: "api", path: "/repos/api/.claude/worktrees/ASM-1", isGit: true }],
          },
        ],
      }),
    );
    const plan = JSON.parse(String(writes((p) => p.includes("/plans/"))[0][1]));
    expect(plan.matches[0].prompt).toContain("@src/foo.ts");
    expect(plan.matches[0].prompt).not.toContain("@api-ASM-1/src/foo.ts");
  });

  it("bares the mentions when merging into an existing workspace failed", async () => {
    execSync.mockReturnValue("src/foo.ts\n");
    readFileSync.mockReturnValue("{ not json");
    await openSharedWorkspace(
      baseReq({
        target: { kind: "existing", file: "/ws/team.code-workspace" },
        tasks: [
          {
            ticket: { key: "ASM-1", summary: "one", url: "" },
            planMd: "p",
            descriptionText: "look at `src/foo.ts`",
            services: [{ name: "api", path: "/repos/api/.claude/worktrees/ASM-1", isGit: true }],
          },
        ],
      }),
    );
    const plan = JSON.parse(String(writes((p) => p.includes("/plans/"))[0][1]));
    expect(plan.matches[0].prompt).not.toContain("@api-ASM-1/src/foo.ts");
  });

  // The plan-dir watcher coalesces events 300ms after the last one, so an N-plan batch
  // is only seen as one batch if its plan files land back-to-back. gitState spawns four
  // git subprocesses per repo, which is enough to split the debounce window.
  it("writes every plan file back-to-back, with no git subprocess between them", async () => {
    const order: string[] = [];
    writeFileSync.mockImplementation((p) => {
      const s = String(p);
      if (s.includes("/plans/")) order.push("plan");
      else if (s.includes("/runs/")) order.push("run");
    });
    execFileSync.mockImplementation((() => {
      order.push("git");
      return "";
    }) as never);

    await openSharedWorkspace(baseReq());

    expect(order.filter((o) => o === "plan")).toHaveLength(2);
    const first = order.indexOf("plan");
    const last = order.lastIndexOf("plan");
    expect(order.slice(first, last + 1)).toEqual(["plan", "plan"]);
    // …and the durable writes still all precede the open.
    expect(order.indexOf("run")).toBeGreaterThan(last);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("opens the destination exactly once", async () => {
    await openSharedWorkspace(baseReq());
    expect(exec).toHaveBeenCalledTimes(1);
    expect(String(exec.mock.calls[0][0])).toContain("/ws/ASM-1+1.code-workspace");
  });

  // "This window" is the one destination that changes nothing about the window it
  // targets: every task's plan names it, and no window is opened or reloaded.
  describe("target 'current'", () => {
    const here = { identity: "/repos/api", kind: "folder" as const, roots: [{ name: "api", path: "/repos/api" }] };

    it("seeds this window without opening or reloading anything", async () => {
      const result = await openSharedWorkspace(
        baseReq({ target: { kind: "current" }, currentWindow: here }),
      );
      expect(exec).not.toHaveBeenCalled();
      expect(commands.executeCommand).not.toHaveBeenCalledWith("vscode.openFolder", expect.anything(), expect.anything());
      expect(result.seededInPlace).toBe(true);
      expect(result.opened).toBe(true);
    });

    // The Run record's mode describes the window it landed in, not the batch layout —
    // a workspace window is multiroot even though no workspace file was written for it.
    it("records multiroot for a workspace-kind window", async () => {
      await openSharedWorkspace(
        baseReq({
          target: { kind: "current" },
          currentWindow: { identity: "/ws/team.code-workspace", kind: "workspace", roots: [{ name: "api", path: "/repos/api" }] },
        }),
      );
      const runs = writes((p) => p.includes("runs") && p.endsWith(".json"));
      expect(runs.length).toBeGreaterThan(0);
      for (const r of runs) expect(JSON.parse(String(r[1])).mode).toBe("multiroot");
    });

    it("points every task's plan at this window and writes no workspace file", async () => {
      const result = await openSharedWorkspace(
        baseReq({ target: { kind: "current" }, currentWindow: here }),
      );
      const plans = writes((p) => p.includes(".agentflow") && p.includes("plans") && p.endsWith(".json"));
      expect(plans).toHaveLength(2);
      for (const p of plans) {
        expect(JSON.parse(String(p[1])).matches[0].matchPath).toBe("/repos/api");
      }
      expect(writes((p) => p.endsWith(".code-workspace"))).toHaveLength(0);
      expect(result.workspaceFile).toBeUndefined();
    });

    // The worktrees live at /repos/api/.claude/worktrees/<KEY>, i.e. inside the root
    // this window has, so each one earns a precise mention through that root.
    it("resolves mentions against this window's roots", async () => {
      execSync.mockReturnValue("src/export.py\n");
      await openSharedWorkspace(
        baseReq({
          target: { kind: "current" },
          currentWindow: here,
          promptTemplate: "Go{files}",
          tasks: [
            {
              ticket: { key: "ASM-1", summary: "one", url: "https://jira/ASM-1" },
              planMd: "## Plan\n\na",
              descriptionText: "fix `src/export.py`",
              services: [{ name: "api", path: "/repos/api/.claude/worktrees/ASM-1", isGit: true }],
            },
          ],
        }),
      );
      const plan = JSON.parse(String(writes((p) => p.includes("plans") && p.endsWith(".json"))[0][1]));
      expect(String(plan.matches[0].prompt)).toContain("@api/.claude/worktrees/ASM-1/src/export.py");
    });
  });
});

describe("openSharedWorkspace — existing workspace", () => {
  const existing = () => {
    readFileSync.mockImplementation((p) =>
      String(p).endsWith(".code-workspace") ? '{ "folders": [{ "path": "/repos/api" }] }' : "",
    );
  };

  it("leaves the file untouched when foldersToAdd is absent", async () => {
    existing();
    const result = await openSharedWorkspace(
      baseReq({ target: { kind: "existing", file: "/ws/team.code-workspace" } }),
    );
    expect(writes((p) => p.endsWith(".code-workspace"))).toHaveLength(0);
    expect(result.mergedFolders).toEqual([]);
    expect(result.workspaceFile).toBe("/ws/team.code-workspace");
  });

  it("merges exactly foldersToAdd", async () => {
    existing();
    const result = await openSharedWorkspace(
      baseReq({
        target: { kind: "existing", file: "/ws/team.code-workspace" },
        foldersToAdd: [
          { name: "infra-ASM-1", path: "/repos/infra/.claude/worktrees/ASM-1" },
          { name: "infra-ASM-2", path: "/repos/infra/.claude/worktrees/ASM-2" },
        ],
      }),
    );
    expect(result.mergedFolders).toEqual(["infra-ASM-1", "infra-ASM-2"]);
    expect(result.workspaceFile).toBe("/ws/team.code-workspace");
    // No new batch workspace file is written when the destination is an existing one.
    expect(writes((p) => p.endsWith("ASM-1+1.code-workspace"))).toHaveLength(0);
  });

  it("routes a worktree's mentions through its containing root", async () => {
    execSync.mockReturnValue("src/export.py\n");
    existing();
    await openSharedWorkspace(
      baseReq({
        tasks: [
          {
            ticket: { key: "ASM-1", summary: "one", url: "" },
            planMd: "p",
            descriptionText: "fix `src/export.py`",
            services: [{ name: "api", path: "/repos/api/.claude/worktrees/ASM-1", isGit: true }],
          },
        ],
        target: { kind: "existing", file: "/ws/team.code-workspace" },
      }),
    );
    const plan = JSON.parse(String(writes((p) => p.includes("/.agentflow/plans/"))[0][1]));
    expect(plan.matches[0].prompt).toContain("@api/.claude/worktrees/ASM-1/src/export.py");
  });
});

describe("openSharedWorkspace: parentKey on each run", () => {
  const lastWrittenRun = () => {
    const runWrites = writes((p) => p.includes("/runs/"));
    expect(runWrites.length).toBeGreaterThan(0);
    return JSON.parse(String(runWrites[runWrites.length - 1][1]));
  };

  it("stamps the parentKey a batch task carries", async () => {
    await openSharedWorkspace(
      baseReq({
        tasks: [
          {
            ticket: { key: "ASM-2", summary: "two", url: "https://jira/ASM-2" },
            planMd: "## Plan\n\nb",
            descriptionText: "",
            services: [{ name: "api", path: "/repos/api/.claude/worktrees/ASM-2", isGit: true }],
            parentKey: "ASM-1",
          },
        ],
      }),
    );
    expect(lastWrittenRun().parentKey).toBe("ASM-1");
  });

  // `in` rather than `toBeUndefined()`: a key that exists holding `undefined` would
  // satisfy the latter. Note the limit of this assertion — `writeRun` serialises with
  // JSON.stringify, which drops undefined-valued keys, so it cannot distinguish the
  // conditional spread from an unconditional `parentKey: t.parentKey`. What it DOES
  // catch is a falsy default (`?? ""`, `|| null`), which is how this realistically
  // regresses: those land in the JSON and a reader then sees a run whose parent is "".
  it("omits the field for an ordinary batch", async () => {
    await openSharedWorkspace(
      baseReq({
        tasks: [
          {
            ticket: { key: "ASM-2", summary: "two", url: "https://jira/ASM-2" },
            planMd: "## Plan\n\nb",
            descriptionText: "",
            services: [{ name: "api", path: "/repos/api/.claude/worktrees/ASM-2", isGit: true }],
          },
        ],
      }),
    );
    expect("parentKey" in lastWrittenRun()).toBe(false);
  });
});
