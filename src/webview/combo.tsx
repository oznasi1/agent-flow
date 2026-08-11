// The command-palette combo: a trigger that opens a filter-as-you-type list.
// Two shapes share the scaffolding in `useComboFilter` — the sidebar's repo
// controls (RepoPicker / RepoMultiSelect, in App.tsx) and `MultiCombo` below.
//
// This module imports nothing but React on purpose: it is reachable from BOTH
// the sidebar bundle and the Deck bundle, and anything under src/webview/ that
// pulls in `fs`/`os`/`path`/`child_process` — even transitively — breaks the
// webview build (and only `npm run build` catches it, never tsc).
//
// Class names are deliberately surface-neutral (`combo-*`). The sheet that
// styles them lives with the surface that mounts them: ORCH_CSS today, since
// the Orchestrator drawer is `MultiCombo`'s only caller. The sidebar's own
// combos predate this and keep their `.repo-*` rules in styles.ts.
import * as React from "react";

/** One row in a `MultiCombo`. `value` is what `onCommit` reports; `label` is
 * what the user reads AND what the search filters on; `detail` is the optional
 * second line (a command's `detail`, a place's repo).
 *
 * `mono` marks the label as an IDENTIFIER rather than prose — a run key is one,
 * a command's human label is not. It is per-option because this component serves
 * both, and the house rule ("mono only for identifiers") is about the string,
 * not about the control. */
export type ComboOption = { value: string; label: string; detail?: string; mono?: boolean };

/** Shared scaffolding for the inline command-palette combos (RepoPicker,
 * RepoMultiSelect, MultiCombo): open/query/active state, focus-on-open,
 * active-reset on change, click-outside-to-close, and Arrow/Enter/Escape
 * handling. The consumer supplies what Enter does via `onEnter`.
 *
 * Generic over the item, with `textOf` naming the string to filter on, so a
 * caller whose options are objects (`MultiCombo`) is not forced to filter on a
 * label and then map back to a value — two options that happen to share a label
 * would collide on the way back. `textOf` defaults to the item itself for the
 * `string[]` callers, which is why those call sites read unchanged. */
export function useComboFilter<T>(
  items: T[],
  onEnter: (item: T) => void,
  textOf: (item: T) => string = (item) => String(item),
) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [active, setActive] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);

  const filtered = React.useMemo(
    () => items.filter((r) => textOf(r).toLowerCase().includes(q.toLowerCase())),
    // `textOf` is intentionally not a dependency: callers pass an inline arrow,
    // which is a fresh function every render, so listing it would recompute the
    // memo on every render and buy nothing. It is a pure accessor over `items`,
    // which IS a dependency.
    [items, q],
  );

  React.useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  React.useEffect(() => setActive(0), [q, open]);
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); if (filtered[active]) onEnter(filtered[active]); }
    else if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
  };

  return { open, setOpen, q, setQ, active, setActive, filtered, inputRef, rootRef, onKeyDown };
}

const SearchIcon = (): JSX.Element => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <circle cx="6.8" cy="6.8" r="4.4" />
    <path d="M10.2 10.2 14 14" strokeLinecap="round" />
  </svg>
);

/** A multi-select picker: search, tick as many rows as you mean, then commit
 * them in ONE call. Built for the Orchestrator's "add a node" bars, where the
 * native `<select>` it replaces could only ever create one node per pick —
 * three staged commands meant three trips through the same menu.
 *
 * `onCommit` receives the ticked values in the order `options` lists them, not
 * in click order: the caller folds them into one flow (one id per node, one
 * save), and a stable order is what makes that fold reproducible.
 *
 * `extra` is an action, not an option — a row that does something immediately
 * rather than toggling ("Free-text command…", which opens an empty node for the
 * inspector to fill). It sits in the footer for exactly that reason: a tickable
 * row that ignored its tick would be the more confusing lie. */
export function MultiCombo({
  trigger,
  ariaLabel,
  searchPlaceholder,
  options,
  emptyLabel,
  onCommit,
  extra,
}: {
  trigger: string;
  ariaLabel: string;
  searchPlaceholder: string;
  options: ComboOption[];
  emptyLabel: string;
  onCommit: (values: string[]) => void;
  extra?: { label: string; onPick: () => void };
}): JSX.Element {
  const [picked, setPicked] = React.useState<ReadonlySet<string>>(new Set());

  const toggle = (value: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value); else next.add(value);
      return next;
    });

  // Search spans BOTH lines a row prints. A place's repo lives in `detail`, so
  // filtering on the label alone would mean the repo name is on screen and
  // untypeable; a command's `detail` sentence is the other thing a user is
  // likely to remember about it.
  const { open, setOpen, q, setQ, active, setActive, filtered, inputRef, rootRef, onKeyDown } =
    useComboFilter(options, (o) => toggle(o.value), (o) => (o.detail ? `${o.label} ${o.detail}` : o.label));

  // Every close path — commit, Escape, click-outside, pressing the trigger
  // again — leaves the next open with a clean slate. Clearing at each of those
  // sites instead would mean four places to forget, and the click-outside one
  // lives inside the hook where this component cannot reach it.
  React.useEffect(() => { if (!open) { setPicked(new Set()); setQ(""); } }, [open, setQ]);

  const commit = () => {
    // Ordered by `options`, not by when each row was ticked. See the doc comment.
    const values = options.filter((o) => picked.has(o.value)).map((o) => o.value);
    setOpen(false);
    if (values.length > 0) onCommit(values);
  };

  return (
    <div className="combo" ref={rootRef}>
      <button
        type="button"
        className="combo-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="combo-trigger-t">{trigger}</span>
        <span className="combo-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="combo-pop">
          <div className="combo-search">
            <SearchIcon />
            <input
              ref={inputRef}
              value={q}
              spellCheck={false}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              onChange={(e) => setQ(e.target.value)}
              // Enter toggles the active row (the hook's `onEnter`), so committing
              // needs its own gesture from the keyboard — the modifier, or Tab to
              // the Add button. Handled before the hook sees the key, because the
              // hook's own Enter arm would otherwise toggle a row on the way out.
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); return; }
                onKeyDown(e);
              }}
            />
          </div>
          <div className="combo-list" role="listbox" aria-multiselectable="true" aria-label={ariaLabel}>
            {/* Three empty states, and they say different things: nothing is
                configured at all, nothing matches what was typed, or (below)
                a real list. Collapsing the first two would tell a user who
                has cleared `agentFlow.commands` that their query was wrong. */}
            {options.length === 0 && <div className="combo-empty">{emptyLabel}</div>}
            {options.length > 0 && filtered.length === 0 && (
              <div className="combo-empty">No match for “{q}”</div>
            )}
            {filtered.map((o, i) => {
              const on = picked.has(o.value);
              return (
                <div
                  key={o.value}
                  role="option"
                  aria-selected={on}
                  className={`combo-opt${i === active ? " active" : ""}${on ? " checked" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => { e.preventDefault(); toggle(o.value); }}
                >
                  <span className="combo-box" aria-hidden="true">{on ? "✓" : ""}</span>
                  <span className="combo-t">
                    <span className={o.mono ? "l k" : "l"}>{o.label}</span>
                    {o.detail !== undefined && o.detail !== "" && <span className="d">{o.detail}</span>}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="combo-foot">
            {extra && (
              <button
                type="button"
                className="combo-extra"
                onMouseDown={(e) => { e.preventDefault(); setOpen(false); extra.onPick(); }}
              >
                {extra.label}
              </button>
            )}
            <span className="sp" />
            <span className="combo-n">{picked.size} selected</span>
            <button
              type="button"
              className="combo-add"
              disabled={picked.size === 0}
              title="Add the ticked entries (⌘/Ctrl+Enter)"
              onMouseDown={(e) => { e.preventDefault(); commit(); }}
            >
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
