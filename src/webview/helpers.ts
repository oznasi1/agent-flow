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

/** Map a Jira priority name to its card CSS class. Pure. */
export function prioClass(p: string): string {
  const s = (p || "").toLowerCase();
  if (s === "highest" || s === "high") return "p-high";
  if (s === "medium") return "p-med";
  return "p-low";
}
