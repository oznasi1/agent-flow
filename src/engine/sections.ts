// Category sections for the Marketplace's browse list. Pure and dependency-free —
// it must never import "vscode" or "fs" — so the webview and the unit tests share
// one ordering rule.

/** Your own assets, pinned to the top: what you wrote is what you look for most. */
const FIRST = "yours";
/** Plugins whose manifest omits `category`, pinned to the bottom. */
const LAST = "uncategorized";

export interface Section {
  category: string; // the raw value, which is what filtering compares
  label: string; // title-cased, for display only
  count: number;
}

/** A category as a heading. Presentation only — never feed this back into a filter. */
export function categoryLabel(category: string): string {
  if (!category) return "Uncategorized";
  return category
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/** Sections in display order: Yours, then by descending row count, then
 * Uncategorized. Count ties break alphabetically so two scans of the same disk
 * never reorder the page under the user. */
export function orderSections<T extends { category: string }>(rows: T[]): Section[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const c = r.category || LAST;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const rank = (c: string) => (c === FIRST ? -1 : c === LAST ? 1 : 0);
  return [...counts.entries()]
    .sort(([ac, an], [bc, bn]) => rank(ac) - rank(bc) || bn - an || ac.localeCompare(bc))
    .map(([category, count]) => ({ category, label: categoryLabel(category), count }));
}
