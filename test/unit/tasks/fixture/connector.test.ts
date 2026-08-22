import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { makeFixtureConnector } from "../../../../src/tasks/fixture/connector";
import { resolveConnector, CONNECTOR_IDS } from "../../../../src/tasks/registry";

// resolveConnector reads getConfig().taskSource — mock it the way other unit
// tests mock config, pointing taskSource wherever each test needs.
vi.mock("../../../../src/config", () => ({
  getConfig: vi.fn(() => ({ taskSource: "fixture" })),
}));
import { getConfig } from "../../../../src/config";

const RECORD = {
  key: "E2E-1", summary: "Fix the rocket telemetry panel", status: "To Do",
  statusCategory: "new" as const, priority: "P2", assignee: "Unassigned",
  labels: ["telemetry"], components: [], sprint: null, inOpenSprint: false,
  updated: "2026-08-21T00:00:00.000Z", url: "https://fixture.invalid/browse/E2E-1",
  estimateSeconds: null, descriptionText: "The rocket panel shows stale numbers.",
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-fixture-"));
  fs.writeFileSync(path.join(dir, "tasks.json"), JSON.stringify([RECORD]));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.AGENT_FLOW_FIXTURE_DIR;
});

describe("the fixture provider", () => {
  it("lists the tasks from tasks.json for any lens", async () => {
    const p = makeFixtureConnector(dir).provider();
    const tasks = await p.list("all", "any");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].key).toBe("E2E-1");
    // Task fields only — descriptionText is detail's, not list's.
    expect((tasks[0] as unknown as Record<string, unknown>).descriptionText).toBeUndefined();
  });

  it("serves detail for a listed key and throws for an unknown one", async () => {
    const p = makeFixtureConnector(dir).provider();
    const d = await p.detail("E2E-1");
    expect(d.summary).toBe("Fix the rocket telemetry panel");
    expect(d.descriptionText).toBe("The rocket panel shows stale numbers.");
    await expect(p.detail("NOPE-1")).rejects.toThrow(/NOPE-1/);
  });

  it("records moveTo to writes.jsonl instead of talking to any server", async () => {
    const p = makeFixtureConnector(dir).provider();
    await p.moveTo("E2E-1", "done", { resolution: "Done" });
    const lines = fs.readFileSync(path.join(dir, "writes.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(lines[0])).toMatchObject({ op: "moveTo", key: "E2E-1", targetId: "done" });
  });

  it("records a label add — journey 3's provenance-label assertion reads this", async () => {
    const conn = makeFixtureConnector(dir);
    await conn.provider().caps.labels!.add("E2E-1", "claude-code");
    const lines = fs.readFileSync(path.join(dir, "writes.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(lines[0])).toMatchObject({ op: "addLabel", key: "E2E-1", label: "claude-code" });
  });

  it("is authenticated and configured without any interaction", async () => {
    const conn = makeFixtureConnector(dir);
    expect(conn.isConfigured()).toBe(true);
    await expect(conn.isAuthenticated()).resolves.toBe(true);
  });
});

const PARENT = {
  key: "E2E-1", summary: "Fix the rocket telemetry panel", status: "To Do",
  statusCategory: "new" as const, priority: "P2", assignee: "Unassigned", labels: [],
  components: [], sprint: null, inOpenSprint: false,
  updated: "2026-08-21T00:00:00.000Z", url: "https://fixture.invalid/browse/E2E-1",
  estimateSeconds: null, descriptionText: "The rocket panel shows stale numbers.",
};
const CHILD = {
  ...PARENT, key: "E2E-1-a", summary: "Repoint the telemetry feed",
  url: "https://fixture.invalid/browse/E2E-1-a", parent: "E2E-1",
};

const writes = (): Record<string, unknown>[] =>
  fs.readFileSync(path.join(dir, "writes.jsonl"), "utf8")
    .trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

describe("fixture connector capabilities", () => {
  // The outer beforeEach seeds tasks.json with RECORD (a single flat task);
  // these tests need a parent/child pair instead, so overwrite it here.
  beforeEach(() => {
    fs.writeFileSync(path.join(dir, "tasks.json"), JSON.stringify([PARENT, CHILD]));
  });

  it("keeps parented records out of the pool list", async () => {
    const p = makeFixtureConnector(dir).provider();
    expect((await p.list("all", "any")).map((t) => t.key)).toEqual(["E2E-1"]);
  });

  it("answers children one level down", async () => {
    const p = makeFixtureConnector(dir).provider();
    expect(await p.caps.children!.of("E2E-1")).toEqual([
      { key: "E2E-1-a", summary: "Repoint the telemetry feed", type: "Sub-task", statusCategory: "new" },
    ]);
    expect(await p.caps.children!.of("E2E-1-a")).toEqual([]);
  });

  it("records sprint membership changes", async () => {
    const p = makeFixtureConnector(dir).provider();
    expect(await p.caps.sprints!.activeId()).toBe("fixture-sprint-1");
    await p.caps.sprints!.add("fixture-sprint-1", "E2E-1");
    await p.caps.sprints!.remove("E2E-1");
    expect(writes().map((w) => w.op)).toEqual(["addToSprint", "removeFromSprint"]);
  });

  it("records component updates and lists the fixture's components", async () => {
    const p = makeFixtureConnector(dir).provider();
    expect(await p.caps.components!.list()).toEqual(["landing-gear", "telemetry"]);
    await p.caps.components!.update("E2E-1", { add: ["telemetry"] });
    expect(writes()[0]).toMatchObject({ op: "setComponents", key: "E2E-1", add: ["telemetry"] });
  });

  it("throws for an unknown key rather than silently recording", async () => {
    const p = makeFixtureConnector(dir).provider();
    await expect(p.caps.sprints!.add("fixture-sprint-1", "NOPE-9")).rejects.toThrow(/no task NOPE-9/);
  });
});

describe("the registry gate", () => {
  it("does NOT advertise the fixture in CONNECTOR_IDS — telemetry allowlist stays as shipped", () => {
    expect(CONNECTOR_IDS).toEqual(["jira"]);
  });

  it("falls back to jira for taskSource=fixture when the env var is unset — ships inert", () => {
    delete process.env.AGENT_FLOW_FIXTURE_DIR;
    const log = vi.fn();
    const conn = resolveConnector({} as never, log);
    expect(conn.id).toBe("jira");
  });

  it("resolves the fixture only when BOTH the setting and the env var say so", () => {
    process.env.AGENT_FLOW_FIXTURE_DIR = dir;
    const conn = resolveConnector({} as never, vi.fn());
    expect(conn.id).toBe("fixture");
  });

  it("ignores the env var when taskSource is jira — an exported var cannot hijack a real user", () => {
    process.env.AGENT_FLOW_FIXTURE_DIR = dir;
    vi.mocked(getConfig).mockReturnValueOnce({ taskSource: "jira" } as ReturnType<typeof getConfig>);
    const conn = resolveConnector({} as never, vi.fn());
    expect(conn.id).toBe("jira");
  });
});
