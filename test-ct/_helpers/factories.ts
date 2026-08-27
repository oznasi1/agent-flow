import type { FilterVisibility, NotepadItemView, Task } from "../../src/types";
// `SerializedCaps` lives on the provider module and is not re-exported by
// `src/types`. Type-only, so nothing host-side reaches the browser bundle.
import type { SerializedCaps } from "../../src/tasks/provider";

export function mkTask(over: Partial<Task> = {}): Task {
  const key = over.key ?? "PROJ-1";
  return {
    key, summary: key, status: "", statusCategory: "new", priority: "",
    assignee: "Unassigned", labels: [], components: [], sprint: null,
    inOpenSprint: false, updated: "", url: "", estimateSeconds: null, ...over,
  };
}

export function mkNote(over: Partial<NotepadItemView> = {}): NotepadItemView {
  return { id: "n1", title: "Ship the thing", body: "body", done: false, createdAt: 1, ...over };
}

export const ALL_FILTERS: FilterVisibility = { size: true, status: true, repo: true, search: true };

/** What the shipped Jira connector reports. `sprints: true` is what gates the
 *  my-sprint reorder affordance the drag specs depend on. */
export const JIRA_CAPS: SerializedCaps = {
  supportedFilters: ["unassigned", "mine", "mysprint", "sprint", "backlog", "all"],
  sizes: true, labels: true, sprints: true, components: true,
};
