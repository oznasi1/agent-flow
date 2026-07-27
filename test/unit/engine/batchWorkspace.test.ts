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

  it("names each folder <KEY>-<repo> so two worktrees of one repo stay distinct", async () => {
    await openSharedWorkspace(baseReq());
    const ws = JSON.parse(String(writes((p) => p.endsWith(".code-workspace"))[0][1]));
    expect(ws.folders).toEqual([
      { name: "ASM-1-api", path: "/repos/api/.claude/worktrees/ASM-1" },
      { name: "ASM-2-api", path: "/repos/api/.claude/worktrees/ASM-2" },
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
    expect(plan.matches[0].prompt).toContain("@ASM-1-api/src/foo.ts");
  });

  it("writes no plan file when seeding is off", async () => {
    const result = await openSharedWorkspace(baseReq({ seedAgent: false }));
    expect(writes((p) => p.includes("/plans/"))).toHaveLength(0);
    expect(result.seeded).toBe(0);
  });

  it("merges the folders into an existing workspace instead of writing a new one", async () => {
    readFileSync.mockReturnValue(JSON.stringify({ folders: [{ path: "/repos/web" }] }));
    const result = await openSharedWorkspace(baseReq({ target: { kind: "existing", file: "/ws/team.code-workspace" } }));
    expect(result.workspaceFile).toBe("/ws/team.code-workspace");
    expect(result.mergedFolders).toEqual(["ASM-1-api", "ASM-2-api"]);
    expect(writes((p) => p === "/ws/ASM-1+1.code-workspace")).toHaveLength(0);
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
    expect(result.unaddedFolders).toEqual(["ASM-1-api", "ASM-2-api"]);
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
    expect(plan.matches[0].prompt).not.toContain("@ASM-1-api/src/foo.ts");
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
    expect(plan.matches[0].prompt).not.toContain("@ASM-1-api/src/foo.ts");
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

  // `target.kind !== "current"` is the whole this-window flow: the current window has to
  // be replaced in place (which reloads it, firing the seed handshake), never spawned.
  it("reloads the current window instead of spawning one for target 'current'", async () => {
    const result = await openSharedWorkspace(baseReq({ target: { kind: "current" } }));
    expect(exec).not.toHaveBeenCalled();
    expect(commands.executeCommand).toHaveBeenCalledWith(
      "vscode.openFolder",
      expect.objectContaining({ fsPath: "/ws/ASM-1+1.code-workspace" }),
      { forceNewWindow: false },
    );
    expect(result.opened).toBe(true);
  });
});
