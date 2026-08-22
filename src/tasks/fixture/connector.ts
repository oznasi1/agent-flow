import * as fs from "fs";
import * as path from "path";
import type { AuthProbe, ProjectProbe } from "../../engine/doctor";
import {
  Capabilities, ChildRef, SourceInfo, StatusTarget, Task, TaskConnector, TaskDetail, TaskProvider,
} from "../provider";

/** One task in `tasks.json`: everything the pool renders plus the detail body.
 *  A record with `parent` is a CHILD: it is reachable through `caps.children`
 *  and deliberately absent from `list()`, so adding tree fixtures cannot change
 *  the card count any existing journey asserts. */
export type FixtureTaskRecord = Task & { descriptionText: string; parent?: string };

/** A JSON-backed task source for the real-host E2E lane. No server, no network,
 * no auth: `tasks.json` in the fixture dir is the truth, and every write lands as
 * a line in `writes.jsonl` for the test to assert on. Reached ONLY through the
 * registry's env gate — see resolveConnector — so a shipped install can never
 * resolve it by accident.
 *
 * Distinct from `test/_helpers/fixtureConnector.ts` on purpose: that one is an
 * in-memory, capability-free double proving the seam needs nothing Jira-shaped,
 * and lives in `test/` where the extension bundle cannot reach it. This one is
 * file-backed because the E2E host is a separate process — the test and the
 * extension can only meet on disk. */
export function makeFixtureConnector(dir: string): TaskConnector {
  const read = (): FixtureTaskRecord[] =>
    JSON.parse(fs.readFileSync(path.join(dir, "tasks.json"), "utf8")) as FixtureTaskRecord[];
  const record = (entry: Record<string, unknown>): void => {
    fs.appendFileSync(path.join(dir, "writes.jsonl"), JSON.stringify({ ...entry, at: Date.now() }) + "\n");
  };
  const find = (key: string): FixtureTaskRecord => {
    const t = read().find((r) => r.key === key);
    if (!t) throw new Error(`fixture: no task ${key} in ${dir}/tasks.json`);
    return t;
  };

  const caps: Capabilities = {
    supportedFilters: ["mine", "all"],
    sizes: false,
    labels: {
      add: async (key, label) => { find(key); record({ op: "addLabel", key, label }); },
    },
    // Recorded, not written through — matching `moveTo` and `addLabel`. The pool
    // updates optimistically; the assertion of record is `writes.jsonl`.
    sprints: {
      activeId: async () => "fixture-sprint-1",
      add: async (sprintId, key) => { find(key); record({ op: "addToSprint", key, sprintId }); },
      remove: async (key) => { find(key); record({ op: "removeFromSprint", key }); },
    },
    components: {
      list: async () => ["landing-gear", "telemetry"],
      update: async (key, delta) => {
        find(key);
        record({ op: "setComponents", key, add: delta.add ?? [], remove: delta.remove ?? [] });
      },
    },
    children: {
      of: async (key) => {
        find(key); // an unknown parent is a fixture authoring error, not an empty tree
        return read()
          .filter((r) => r.parent === key)
          .map((r): ChildRef => ({
            key: r.key, summary: r.summary, type: "Sub-task", statusCategory: r.statusCategory,
          }));
      },
    },
  };

  const provider: TaskProvider = {
    caps,
    list: async () => read().filter((r) => !r.parent).map(({ descriptionText: _d, parent: _p, ...task }) => task),
    detail: async (key) => {
      const { key: k, summary, descriptionText, labels, components, url, status, statusCategory } = find(key);
      return { key: k, summary, descriptionText, labels, components, url, status, statusCategory } as TaskDetail;
    },
    status: async (key) => {
      const t = find(key);
      return { status: t.status, category: t.statusCategory };
    },
    statusTargets: async (): Promise<StatusTarget[]> => [
      { id: "in-progress", toName: "In Progress", toCategory: "indeterminate", fields: [] },
      { id: "done", toName: "Done", toCategory: "done", fields: [] },
    ],
    moveTo: async (key, targetId, values) => { find(key); record({ op: "moveTo", key, targetId, values }); },
    assignToMe: async (key, meId) => { find(key); record({ op: "assignToMe", key, meId: meId ?? "fixture-user" }); },
    me: async () => ({ id: "fixture-user", displayName: "Fixture User" }),
  };

  return {
    id: "fixture",
    setupSteps: 0,
    info: (): SourceInfo => ({
      label: "Fixture",
      scopeNoun: "file",
      scopeValue: path.join(dir, "tasks.json"),
      endpoint: dir,
      exampleKey: "E2E-1",
      endpointSetting: "agentFlow.taskSource",
      scopeSetting: "agentFlow.taskSource",
    }),
    isConfigured: () => true,
    configure: async () => async () => {},
    isAuthenticated: async () => true,
    signIn: async () => true,
    signOut: async () => {},
    provider: () => provider,
    // Both members absent → Doctor renders "skip", never a fake pass.
    probe: async (): Promise<{ auth?: AuthProbe; scope?: ProjectProbe }> => ({}),
    taskUrl: (key) => `https://fixture.invalid/browse/${key}`,
    keyFromUrl: (url) => {
      const m = /^https:\/\/fixture\.invalid\/browse\/([A-Za-z0-9-]+)$/.exec(url);
      return m ? m[1] : null;
    },
  };
}
