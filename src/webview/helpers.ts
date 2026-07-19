import { JiraTask } from "../types";

/** Format an original-estimate in seconds as a compact "3h" / "1.5d" (8h workday). Pure. */
export function fmtEst(sec: number): string {
  const h = sec / 3600;
  if (h < 8) return `${Math.round(h)}h`;
  const d = h / 8; // Jira workday
  return `${Number.isInteger(d) ? d : d.toFixed(1)}d`;
}

/** Move `fromKey` to sit before/after `toKey` within a task list. Pure. */
export function moveKey(list: JiraTask[], fromKey: string, toKey: string, pos: "before" | "after"): JiraTask[] {
  if (fromKey === toKey) return list;
  const from = list.findIndex((t) => t.key === fromKey);
  if (from < 0) return list;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  const to = next.findIndex((t) => t.key === toKey);
  if (to < 0) return list;
  next.splice(pos === "after" ? to + 1 : to, 0, moved);
  return next;
}

/** Distinct statuses present in a task list, ordered by workflow category
 *  (To Do → In Progress → Done) then alphabetically. Statuses are project-specific,
 *  so the set is derived from the loaded pool rather than hardcoded. Pure. */
export function deriveStatuses(tasks: JiraTask[]): { name: string; category: string }[] {
  const seen = new Map<string, string>(); // status name → category (first occurrence wins)
  for (const t of tasks) {
    if (t.status && !seen.has(t.status)) seen.set(t.status, t.statusCategory || "new");
  }
  const rank = (c: string) => (c === "new" ? 0 : c === "done" ? 2 : 1);
  return [...seen.entries()]
    .map(([name, category]) => ({ name, category }))
    .sort((a, b) => rank(a.category) - rank(b.category) || a.name.localeCompare(b.name));
}

/** Does a task pass the status filter? An empty selection means "all". Pure. */
export function matchesStatus(task: JiraTask, selected: ReadonlySet<string>): boolean {
  return selected.size === 0 || selected.has(task.status);
}

/** Map a Jira priority name to its card CSS class. Pure. */
export function prioClass(p: string): string {
  const s = (p || "").toLowerCase();
  if (s === "highest" || s === "high") return "p-high";
  if (s === "medium") return "p-med";
  return "p-low";
}
