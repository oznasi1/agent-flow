import {
  Capabilities, SourceInfo, StatusTarget, Task, TaskConnector, TaskDetail, TaskProvider,
} from "../../src/tasks/provider";
import { Filter, Size } from "../../src/types";
// Task and TaskDetail come from the seam itself, which re-exports them. This
// fixture must NOT import anything from src/tasks/jira/ — it exists to prove the
// seam can be satisfied by an implementation that knows nothing about Jira, and
// reaching into the Jira connector for a type would quietly defeat that.
// (JiraDetail is also not in types.ts at all — it is declared in jira/client.ts.)

/** A complete second connector over static data, declaring the bare minimum of
 * the seam. It exists so capability-gating is exercised rather than assumed: a
 * view that reaches for sprints, components, labels, estimates or a filter this
 * source never offers fails a test here instead of shipping.
 *
 * Deliberately NOT registered in src/tasks/registry.ts — it is a test double,
 * not a shipped feature. */
const MARKER = "/t/";

export const FIXTURE_TASKS: Task[] = [
  {
    key: "FX-1", summary: "First fixture task", status: "Open", statusCategory: "new",
    priority: "", assignee: "Unassigned", labels: [], components: [],
    sprint: null, inOpenSprint: false, updated: "2026-01-01T00:00:00.000Z",
    url: "https://fixture.test/t/FX-1", estimateSeconds: null,
  },
  {
    key: "FX-2", summary: "Second fixture task", status: "Doing", statusCategory: "indeterminate",
    priority: "", assignee: "Me", labels: [], components: [],
    sprint: null, inOpenSprint: false, updated: "2026-01-02T00:00:00.000Z",
    url: "https://fixture.test/t/FX-2", estimateSeconds: null,
  },
];

export interface FixtureOptions {
  configured: boolean;
  authed: boolean;
  tasks: Task[];
}

class FixtureProvider implements TaskProvider {
  constructor(private readonly tasks: Task[]) {}

  readonly caps: Capabilities = {
    // No sprint-shaped lens: this source has no sprints at all.
    supportedFilters: ["mine", "all"],
    sizes: false,
    // labels, sprints and components are absent, not false — see Capabilities.
  };

  async list(lens: Filter, _size: Size): Promise<Task[]> {
    return lens === "mine" ? this.tasks.filter((t) => t.assignee === "Me") : this.tasks;
  }

  async detail(key: string): Promise<TaskDetail> {
    const t = this.tasks.find((x) => x.key === key);
    return {
      key, summary: t?.summary ?? "", descriptionText: "A fixture task.",
      labels: [], components: [], url: `https://fixture.test${MARKER}${key}`,
      status: t?.status ?? null, statusCategory: t?.statusCategory ?? null,
    };
  }

  async status(key: string): Promise<{ status: string | null; category: string | null }> {
    const t = this.tasks.find((x) => x.key === key);
    return { status: t?.status ?? null, category: t?.statusCategory ?? null };
  }

  /** Plain statuses: no screen fields, so `fields` is always empty and `moveTo`
   * never needs a recovery round. */
  async statusTargets(_key: string): Promise<StatusTarget[]> {
    return [
      { id: "open", toName: "Open", toCategory: "new", fields: [] },
      { id: "doing", toName: "Doing", toCategory: "indeterminate", fields: [] },
      { id: "done", toName: "Done", toCategory: "done", fields: [] },
    ];
  }

  async moveTo(): Promise<void> { /* accepted */ }
  async assignToMe(): Promise<void> { /* accepted */ }
  async me(): Promise<{ id: string; displayName: string } | null> {
    return { id: "fx-me", displayName: "Me" };
  }
}

export function makeFixtureConnector(over: Partial<FixtureOptions> = {}): TaskConnector {
  const opts: FixtureOptions = { configured: true, authed: true, tasks: FIXTURE_TASKS, ...over };
  return {
    id: "fixture",
    setupSteps: 1,
    info(): SourceInfo {
      return {
        label: "Fixture", scopeNoun: "board", scopeValue: "FX",
        endpoint: "https://fixture.test", exampleKey: "FX-1234",
        endpointSetting: "agentFlow.fixture.endpoint",
        scopeSetting: "agentFlow.fixture.board",
      };
    },
    isConfigured: () => opts.configured,
    configure: async () => true,
    isAuthenticated: async () => opts.authed,
    signIn: async () => true,
    signOut: async () => undefined,
    provider: () => new FixtureProvider(opts.tasks),
    probe: async () => ({ auth: { ok: true, displayName: "Me" }, scope: { ok: true, name: "FX" } }),
    taskUrl: (key) => `https://fixture.test${MARKER}${key}`,
    keyFromUrl: (url) => {
      const i = typeof url === "string" ? url.indexOf(MARKER) : -1;
      return i < 0 ? null : url.slice(i + MARKER.length) || null;
    },
  };
}
