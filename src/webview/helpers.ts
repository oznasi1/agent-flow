import { Filter, isTicketRun, Run, runKind, Task } from "../types";

/** Case-fold a ticket key or a search query and drop every non-alphanumeric, so
 * the shapes a user actually types for one ticket — "PROJ-1234", "proj 1234",
 * "proj_1234" — all collapse to the same string. */
export function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The key's trailing number, read off the RAW key so a project whose prefix
 * itself ends in a digit ("AB2-1234") still yields "1234" — normalizing first
 * would glue the prefix's digit onto the number and break the bare-number match. */
function keyNumber(key: string): string {
  return /(\d+)\s*$/.exec(key)?.[1] ?? "";
}

/** Does `query` name this ticket? True for the whole key however it was
 * punctuated, for a prefix that reaches into the number ("PROJ-12"), and for a
 * bare number prefixing the key's own ("12" finds PROJ-1234).
 *
 * A digitless prefix deliberately does NOT match: "proj" prefixes every key in
 * the project, so honouring it would pin the entire pool above the title matches
 * and destroy the ranking the search box exists to provide. Reaching the number
 * is what separates "I am naming a ticket" from "I am typing a word". */
export function keyMatches(key: string, query: string): boolean {
  const q = normalizeKey(query);
  if (!q) return false;
  // Digitless: only the whole key, for a source that keys its work with a bare
  // slug rather than a number.
  if (!/\d/.test(q)) return normalizeKey(key) === q;
  if (normalizeKey(key).startsWith(q)) return true;
  return /^\d+$/.test(q) && keyNumber(key).startsWith(q);
}

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
 * Both branches read off `shown = visibleFilters(supported)` — the rendered set —
 * never the raw, connector-ordered `supported` array directly. `"all"` is a real
 * `Filter` a connector can legitimately list (Jira's `supportedFilters` always has),
 * but no tab bar has ever rendered it (see `FILTER_ORDER`'s comment); reading
 * `supported` directly let it through twice, independently, before this settled
 * here — once as a literal match (`effectiveFilter("all", ["all", "unassigned"])`
 * used to return `"all"` verbatim) and once positionally (`["all", "mine"]` used to
 * return `"all"` because it sorted first in the connector's own array). Finding the
 * same defect in two different places is what moved the fix to the one spot `shown`
 * is computed, rather than patching each occurrence separately.
 *
 * The property this function guarantees, unconditionally: `visibleFilters(supported)`
 * always contains the return value. There is no carve-out — see
 * `test/webview/helpers.test.ts`'s "only ever returns a filter visibleFilters(supported)
 * actually renders" for every case that used to violate it. `shown[0]` alone is
 * enough for the fallback, with no `?? "mysprint"`: `visibleFilters` always returns
 * a non-empty array (its own empty-input case falls back to all of `FILTER_ORDER`,
 * itself a non-empty constant), so `shown[0]` can never be `undefined`.
 *
 * The "mysprint" preference — that an UNRECOGNIZED configured value lands on the
 * shipped default rather than whatever `shown[0]` happens to be, matching the
 * pre-capability code's `(cfg.defaultFilter as Filter) || "mysprint"`, so an
 * existing user's opening lens doesn't move — is no longer a separate branch. It
 * holds ONLY because `"mysprint"` is `FILTER_ORDER`'s first entry: `shown` preserves
 * `FILTER_ORDER`'s order, so whenever `"mysprint"` is supported at all it is
 * `shown[0]`, and an unrecognized `configured` falls straight through to it. This
 * used to be an explicit branch (`if (shown.includes("mysprint")) return
 * "mysprint";`) — deleted once it was shown to be provably unreachable-differently
 * (every `shown` that contains `"mysprint"` already has it at index 0, so the
 * branch and the fallback could never disagree). The branch's own safety net was
 * unfalsifiable — nothing could make it wrong, so nothing could catch a regression
 * either. The real guard is `test/webview/helpers.test.ts`'s "falls back to the
 * shipped default when the setting is unrecognized"
 * (`effectiveFilter("nonsense", ALL)` → `"mysprint"`): reorder `FILTER_ORDER` so
 * `"mysprint"` isn't first and THAT test fails, forcing a conscious decision about
 * whether the tab order and this fallback preference should move together, rather
 * than the deleted branch silently answering "no" forever.
 *
 * Pure — no DOM, no React — so the extension host imports it too rather than keeping
 * a second copy that could drift from what the webview renders. */
export function effectiveFilter(configured: string, supported: readonly Filter[]): Filter {
  const shown = visibleFilters(supported);
  return shown.includes(configured as Filter) ? (configured as Filter) : shown[0];
}

/** Format an original-estimate in seconds as a compact "3h" / "1.5d" (8h workday). Pure. */
export function fmtEst(sec: number): string {
  const h = sec / 3600;
  if (h < 8) return `${Math.round(h)}h`;
  const d = h / 8; // Jira workday
  return `${Number.isInteger(d) ? d : d.toFixed(1)}d`;
}

/** Move `fromKey` to sit before/after `toKey` within a list. `keyOf` reads the
 *  item's identity — `t => t.key` for a task, `n => n.id` for a note. Pure. */
export function moveKey<T>(
  list: T[], fromKey: string, toKey: string, pos: "before" | "after", keyOf: (item: T) => string,
): T[] {
  if (fromKey === toKey) return list;
  const from = list.findIndex((t) => keyOf(t) === fromKey);
  if (from < 0) return list;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  const to = next.findIndex((t) => keyOf(t) === toKey);
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

/** What a ticket IS, as far as the card renders it. A different axis from status:
 * `statusCategory` says where the ticket is in the flow, this says what kind of
 * thing it is. "other" covers every type a project defined for itself. */
export type TicketKind = "story" | "epic" | "task" | "subtask" | "bug" | "other";

// A null-prototype map, not an object literal: a plain literal would resolve
// ticketKind("constructor") to Object's own constructor rather than to "other".
const TICKET_KINDS: Record<string, TicketKind> = Object.assign(Object.create(null), {
  story: "story",
  epic: "epic",
  task: "task",
  bug: "bug",
  "sub-task": "subtask",
  subtask: "subtask",
});

/** Map a source's type name onto a render kind. Unknown names — and the empty
 * string a source with no type produces — are "other", which still draws a
 * marker; the raw name is what the tooltip shows. */
export function ticketKind(typeName: string): TicketKind {
  return TICKET_KINDS[typeName.trim().toLowerCase()] ?? "other";
}

/** What names a run on screen — the card's key chip and the detail drawer's
 * header both. A ticket run is named by its key; an untracked one by the short
 * word for what it is, because its key is a generated slug (a notepad key runs
 * to ~64 characters of nothing a reader can use) and a surface sized for a
 * ticket key has no room for one.
 *
 * The short label is only honest for a real Explore session. `isTicketRun` keys
 * off an empty url and never inspects the key, so anything else untracked keeps
 * its key rather than being relabelled as something it is not — a review run,
 * whose "review-<slug>" key is a real identifier, included.
 *
 * `explore` is prefix-matched, unlike the other two: a Track'd ticketless place
 * is the one Explore shape with no "explore-" key — its record is kind:
 * "explore" but Track it never renames it off its "local-" place-hash, so that
 * prefix reads as "explore" here too, which is exactly what the record now is.
 * A notepad or local run always carries its kind, so those match exactly. */
export function keyLabel(run: Run): string {
  if (isTicketRun(run)) return run.key;
  if (runKind(run) === "local") return "local";
  if (run.key.startsWith("explore-") || run.key.startsWith("local-")) return "explore";
  if (runKind(run) === "notepad") return "notepad";
  return run.key;
}

/** "4m ago" from an epoch-ms stamp. `null` and 0 both render "" — a session
 * record with no startedAt must not read as "open 56y ago". */
export function timeAgo(ms: number | null): string {
  if (!ms) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
