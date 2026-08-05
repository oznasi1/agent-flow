import { Filter, Task } from "../types";

/** The lens to actually use, given what the user configured and what the source can
 * answer. `agentFlow.defaultFilter` ships as "mysprint" and four of the six filters
 * are inherently sprint-scoped, so a source without sprints supports neither the
 * shipped default nor most of the alternatives — asking it for one would fetch an
 * unanswerable lens and render a tab bar with no active tab.
 *
 * The shipped default is preferred over `supported[0]` for an unrecognized setting on
 * a source that supports it, because that is exactly where the pre-capability code
 * landed (`(cfg.defaultFilter as Filter) || "mysprint"`) and an already-configured
 * user's opening lens must not move. The last fallback covers a source declaring no
 * filters at all: it can answer nothing either way, so the only obligation left is
 * that the return stays a `Filter`.
 *
 * Pure — no DOM, no React — so the extension host imports it too rather than keeping
 * a second copy that could drift from what the webview renders. */
export function effectiveFilter(configured: string, supported: readonly Filter[]): Filter {
  if (supported.includes(configured as Filter)) return configured as Filter;
  if (supported.includes("mysprint")) return "mysprint";
  return supported[0] ?? "mysprint";
}

/** Format an original-estimate in seconds as a compact "3h" / "1.5d" (8h workday). Pure. */
export function fmtEst(sec: number): string {
  const h = sec / 3600;
  if (h < 8) return `${Math.round(h)}h`;
  const d = h / 8; // Jira workday
  return `${Number.isInteger(d) ? d : d.toFixed(1)}d`;
}

/** Move `fromKey` to sit before/after `toKey` within a task list. Pure. */
export function moveKey(list: Task[], fromKey: string, toKey: string, pos: "before" | "after"): Task[] {
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
export function deriveStatuses(tasks: Task[]): { name: string; category: string }[] {
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
export function matchesStatus(task: Task, selected: ReadonlySet<string>): boolean {
  return selected.size === 0 || selected.has(task.status);
}

/** Is this task in the configured PR-review status? Case-insensitive, whitespace-trimmed.
 *  Both sides must be non-empty. Drives the "Address PR" card action. Pure. */
export function isPrReviewStatus(status: string, configured: string): boolean {
  const a = (status || "").trim().toLowerCase();
  const b = (configured || "").trim().toLowerCase();
  return a.length > 0 && b.length > 0 && a === b;
}

/**
 * The card's left rail answers "where is this in the flow?", the same question the
 * Deck's rail answers — it used to answer "how urgent is this?", which meant the
 * same visual position meant two things across two surfaces. Jira's statusCategory
 * is the only status axis the sidebar receives, so there are exactly three hues.
 */
export function railClass(statusCategory: string | undefined): "s-new" | "s-progress" | "s-done" {
  if (statusCategory === "indeterminate") return "s-progress";
  if (statusCategory === "done") return "s-done";
  return "s-new";
}

/**
 * Urgency moved off the rail and onto a chip, because a chip can be ignored and a
 * 3px rail cannot. Highest only — flagging High as well made a third of the pool
 * urgent, which is the same as flagging none of it.
 */
export function isTopPriority(priority: string): boolean {
  return (priority || "").toLowerCase() === "highest";
}

/** Append `x` unless it's already there, returning the original array when it is —
 *  so an unchanged list keeps its reference and React skips the re-render. */
export function addOnce(xs: string[], x: string): string[] {
  return xs.includes(x) ? xs : [...xs, x];
}
