import { Filter, Task } from "../types";

/** The tab bar's shipped order — NOT `types.ts`'s declaration order for `Filter`,
 * and not a connector's `supportedFilters` array order either. This has been the
 * rendered order since the "reorder task filter tabs" change (My sprint, Mine,
 * Sprint, Backlog, Unassigned), and it is the COMPLETE set of tabs the UI has
 * ever rendered. `"all"` is deliberately absent: it is a real `Filter` — the JQL
 * builder's fallback default, and `Jira`'s `supportedFilters` includes it — but no
 * UI has ever surfaced it as a tab (the old hardcoded `FILTERS` array in `App.tsx`
 * had exactly these same five entries, `agentFlow.defaultFilter`'s manifest `enum`
 * and `DEFAULT_FILTER_VALUES` agree). A connector's `supportedFilters` says which
 * of *these* tabs it can answer, never which tabs exist — so including `"all"`
 * there must not add a sixth tab an existing Jira user has never seen. */
const FILTER_ORDER: Filter[] = ["mysprint", "mine", "sprint", "backlog", "unassigned"];

/** Which filter tabs render, in the shipped order. A connector's `supportedFilters`
 * says *which* tabs exist, never in what order — the array a connector returns is
 * not meant to be rendered verbatim. */
export function visibleFilters(supported: readonly Filter[]): Filter[] {
  const allowed = new Set(supported);
  const shown = FILTER_ORDER.filter((f) => allowed.has(f));
  // An empty tab bar is a dead end with no in-product way out of it — the same
  // reasoning as config.ts's resolveModes falling back to its built-ins.
  return shown.length ? shown : [...FILTER_ORDER];
}

/** Every gate-screen string, with the source named. Pure so the copy is testable
 * without mounting the app. */
export function gateCopy(label: string): {
  connecting: string; unconfigured: string; unauthed: string; signIn: string; openIn: string;
} {
  return {
    connecting: `Connecting to ${label}…`,
    unconfigured: `Agent Flow Deck isn't connected to ${label} yet — add your site URL and project to get started.`,
    unauthed: `Connect Agent Flow Deck to your ${label} to see your task pool.`,
    signIn: `Sign in to ${label}`,
    openIn: `Open in ${label}`,
  };
}

/** The lens to actually use, given what the user configured and what the source can
 * answer. `agentFlow.defaultFilter` ships as "mysprint" and four of the six filters
 * are inherently sprint-scoped, so a source without sprints supports neither the
 * shipped default nor most of the alternatives — asking it for one would fetch an
 * unanswerable lens and render a tab bar with no active tab.
 *
 * All three branches read off `shown = visibleFilters(supported)` — the rendered
 * set — never the raw, connector-ordered `supported` array directly. That used to
 * be true only of the tail; the first two branches read `supported` directly, and
 * each independently let an unrendered filter through: `"all"` is a real `Filter` a
 * connector can legitimately list (Jira's `supportedFilters` always has), but no tab
 * bar has ever rendered it (see `FILTER_ORDER`'s comment) — the first branch would
 * return it verbatim whenever `supported` contained it literally
 * (`effectiveFilter("all", ["all", "unassigned"])` used to return `"all"`), and the
 * tail would return it whenever it sorted first in the connector's own array
 * (`["all", "mine"]`). Finding the same defect in two of three branches is what
 * moved the fix here, to the one place `shown` is computed, rather than patched
 * branch by branch again.
 *
 * The property this function guarantees, unconditionally: `visibleFilters(supported)`
 * always contains the return value. There is no carve-out — see
 * `test/webview/helpers.test.ts`'s "only ever returns a filter visibleFilters(supported)
 * actually renders" for every case that used to violate it.
 *
 * Compatibility, verified rather than assumed when this was consolidated: for Jira
 * (`supported` is all six values, so `shown` is the five real tabs) a configured
 * `"mysprint"` still returns `"mysprint"`, and an unrecognized configured value still
 * returns `"mysprint"` rather than `shown[0]` — the behaviour that keeps an existing
 * user's opening lens from moving, matching the pre-capability code's
 * `(cfg.defaultFilter as Filter) || "mysprint"`. For the Task 7 fixture
 * (`supported: ["mine", "all"]`, so `shown` is `["mine"]`) a configured `"mysprint"`
 * still returns `"mine"`, unchanged. Both hold with `shown` in place of `supported`
 * because `"mysprint"` and `"mine"` are real filters: if either is actually
 * supported, it survives into `shown` in the same position `FILTER_ORDER` gives it.
 *
 * The middle branch (prefer `"mysprint"` over the tail) is currently provable dead
 * code, not merely redundant-in-practice: `"mysprint"` is `FILTER_ORDER`'s first
 * entry, so whenever it is in `shown` at all it is unconditionally `shown[0]`,
 * making the tail return it anyway. Verified exhaustively (every subset of the six
 * `Filter` values as `supported`, crossed with every `Filter` plus `""` and
 * `"nonsense"` as `configured`) — removing this branch changes no output. Kept
 * anyway: it states the "mysprint" preference as an explicit guarantee rather than
 * an incidental consequence of `FILTER_ORDER` happening to list it first, so a
 * future reorder of `FILTER_ORDER` (for cosmetic reasons, unrelated to this
 * function) can't silently move an existing user's opening lens by ceasing to
 * imply it. If `FILTER_ORDER` ever stops listing `"mysprint"` first, this branch
 * stops being redundant and starts being the only thing protecting the preference.
 *
 * Pure — no DOM, no React — so the extension host imports it too rather than keeping
 * a second copy that could drift from what the webview renders. */
export function effectiveFilter(configured: string, supported: readonly Filter[]): Filter {
  const shown = visibleFilters(supported);
  if (shown.includes(configured as Filter)) return configured as Filter;
  if (shown.includes("mysprint")) return "mysprint";
  return shown[0] ?? "mysprint";
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
