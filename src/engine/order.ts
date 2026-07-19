import { JiraTask } from "../types";

/** Order tasks so keys present in `saved` come first (in saved order),
 *  then any remaining tasks in their incoming (server) order. Pure. */
export function sortBySavedOrder(tasks: JiraTask[], saved: string[]): JiraTask[] {
  const rank = new Map(saved.map((k, i) => [k, i] as const));
  const ranked = tasks
    .filter((t) => rank.has(t.key))
    .sort((a, b) => rank.get(a.key)! - rank.get(b.key)!);
  const unranked = tasks.filter((t) => !rank.has(t.key)); // preserves server order
  return [...ranked, ...unranked];
}

/** Rebuild the full saved order after the user reorders the *visible* subset.
 *  The visible keys follow `visibleNew` exactly; keys hidden by the size lens
 *  keep their original absolute slot. A brand-new key the user dragged into
 *  view keeps the position they dropped it at — only an untouched new ticket
 *  stays at the bottom, because the webview leaves it last in `visibleNew`.
 *  Pure. */
export function applyReorder(saved: string[], visibleNew: string[], visibleSet: Set<string>): string[] {
  const feed = [...visibleNew];
  const out: string[] = [];
  for (const key of saved) {
    if (visibleSet.has(key)) {
      const next = feed.shift();
      if (next !== undefined) out.push(next); // fill this visible slot from the new order
    } else {
      out.push(key); // hidden key keeps its slot
    }
  }
  for (const key of feed) if (!out.includes(key)) out.push(key); // new keys append
  return out;
}

/** Drop saved keys no longer present in the sprint. Only call on a full fetch
 *  (size "any"), so keys merely hidden by a size lens are never pruned. Pure. */
export function pruneOrder(saved: string[], presentKeys: string[]): string[] {
  const present = new Set(presentKeys);
  return saved.filter((k) => present.has(k));
}
