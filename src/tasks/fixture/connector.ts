import * as fs from "fs";
import * as path from "path";
import type { AuthProbe, ProjectProbe } from "../../engine/doctor";
import type { Filter } from "../../types";
import type { FieldPrompt } from "../fields";
import {
  Capabilities, ChildRef, SourceInfo, StatusTarget, Task, TaskConnector, TaskDetail, TaskProvider,
  TaskWriteError,
} from "../provider";

/** One task in `tasks.json`: everything the pool renders plus the detail body.
 *  A record with `parent` is a CHILD: it is reachable through `caps.children`
 *  and deliberately absent from `list()`, so adding tree fixtures cannot change
 *  the card count any existing journey asserts. */
export type FixtureTaskRecord = Task & { descriptionText: string; parent?: string };

/** Optional `<dir>/config.json`. Every knob maps to one documented edge the E2E
 *  lane proves; an absent file is the shipped behaviour, byte-for-byte, so the
 *  journeys written before this existed are untouched. Re-read per call, like
 *  tasks.json, so a journey can flip a knob between two clicks. */
export interface FixtureConfig {
  /** Default `["mine", "all", "mysprint"]`. */
  supportedFilters?: Filter[];
  /** Default `false`. */
  sizes?: boolean;
  /** Default all `true`; `false` OMITS the capability (the seam's "absent means
   *  unsupported" contract), it never supplies a stub. */
  caps?: { sprints?: boolean; labels?: boolean; components?: boolean; children?: boolean };
  /** Default `{ id: "fixture-user", displayName: "Fixture User" }`. `null` means
   *  the source names nobody; `id: ""` is a name-only identity. */
  me?: { id: string; displayName: string } | null;
  /** Default the two shipped targets (`in-progress`, `done`). */
  statusTargets?: StatusTarget[];
  /** When set, every `moveTo` is recorded with `rejected: true` and then throws
   *  `TaskWriteError(message, retryWith)`. */
  reject?: { moveTo?: { message: string; retryWith?: FieldPrompt[] } };
  /** Keys whose `detail()` throws. */
  failDetail?: string[];
}

const DEFAULT_FILTERS: Filter[] = ["mine", "all", "mysprint"];
const DEFAULT_ME = { id: "fixture-user", displayName: "Fixture User" };
const DEFAULT_TARGETS: StatusTarget[] = [
  { id: "in-progress", toName: "In Progress", toCategory: "indeterminate", fields: [] },
  { id: "done", toName: "Done", toCategory: "done", fields: [] },
];

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

  const config = (): FixtureConfig => {
    const f = path.join(dir, "config.json");
    return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as FixtureConfig) : {};
  };
  const on = (c: FixtureConfig, k: keyof NonNullable<FixtureConfig["caps"]>): boolean => c.caps?.[k] !== false;

  // Built per access so a journey's config.json flip is visible to the next
  // reader. `caps` is a getter on the provider below — the seam explicitly
  // allows one (see the `refreshCaps` doc in provider.ts).
  const buildCaps = (): Capabilities => {
    const c = config();
    const caps: Capabilities = {
      supportedFilters: c.supportedFilters ?? DEFAULT_FILTERS,
      sizes: c.sizes ?? false,
    };
    if (on(c, "labels")) {
      caps.labels = {
        add: async (key, label) => { find(key); record({ op: "addLabel", key, label }); },
      };
    }
    // Recorded, not written through — matching `moveTo` and `addLabel`. The pool
    // updates optimistically; the assertion of record is `writes.jsonl`.
    if (on(c, "sprints")) {
      caps.sprints = {
        activeId: async () => "fixture-sprint-1",
        add: async (sprintId, key) => { find(key); record({ op: "addToSprint", key, sprintId }); },
        remove: async (key) => { find(key); record({ op: "removeFromSprint", key }); },
      };
    }
    if (on(c, "components")) {
      caps.components = {
        list: async () => ["landing-gear", "telemetry"],
        update: async (key, delta) => {
          find(key);
          record({ op: "setComponents", key, add: delta.add ?? [], remove: delta.remove ?? [] });
        },
      };
    }
    if (on(c, "children")) {
      caps.children = {
        of: async (key) => {
          find(key); // an unknown parent is a fixture authoring error, not an empty tree
          return read()
            .filter((r) => r.parent === key)
            .map((r): ChildRef => ({
              key: r.key, summary: r.summary, type: "Sub-task", statusCategory: r.statusCategory,
            }));
        },
      };
    }
    return caps;
  };

  const provider: TaskProvider = {
    get caps() { return buildCaps(); },
    list: async () => read().filter((r) => !r.parent).map(({ descriptionText: _d, parent: _p, ...task }) => task),
    detail: async (key) => {
      if (config().failDetail?.includes(key)) throw new Error(`fixture: detail for ${key} is configured to fail`);
      const { key: k, summary, descriptionText, labels, components, url, status, statusCategory } = find(key);
      return { key: k, summary, descriptionText, labels, components, url, status, statusCategory } as TaskDetail;
    },
    status: async (key) => {
      const t = find(key);
      return { status: t.status, category: t.statusCategory };
    },
    statusTargets: async (): Promise<StatusTarget[]> => config().statusTargets ?? DEFAULT_TARGETS,
    moveTo: async (key, targetId, values) => {
      find(key);
      const rej = config().reject?.moveTo;
      if (rej) {
        // Recorded first, so a journey can prove the attempt was made.
        record({ op: "moveTo", key, targetId, values, rejected: true });
        throw new TaskWriteError(rej.message, rej.retryWith ?? []);
      }
      record({ op: "moveTo", key, targetId, values });
    },
    assignToMe: async (key, meId) => { find(key); record({ op: "assignToMe", key, meId: meId ?? "fixture-user" }); },
    me: async () => {
      const c = config();
      return c.me === undefined ? DEFAULT_ME : c.me;
    },
  };

  return {
    id: "fixture",
    setupSteps: 0,
    signInSteps: 0,
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
