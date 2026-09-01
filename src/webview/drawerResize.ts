import { vscodeApi } from "./vscodeApi";

/** How far the drawer's ceiling reserves from the viewport edge for a board
 * column to stay visible during an ORDINARY resize. `deckStyles.ts`'s board
 * column is 318px wide (`.col { flex: 0 0 318px }`); reserving somewhat more
 * than that keeps at least one column visible beside the drawer. Shared
 * across every drawer that uses this module — it is about the board, not
 * about which drawer is open. */
const BOARD_MARGIN = 340;

/** Arrow-key step, in pixels. Two grid units (see `GRID` in
 * `engine/orchestrator/layout.ts`) — a visible increment without needing
 * many presses to reach a useful width. Shared across every drawer that
 * uses this module. */
export const RESIZE_STEP = 16;

export interface DrawerResizeConfig {
  /** Floor. Narrow enough to give more room to the board, but whatever this
   * drawer's own header row holds must not wrap or clip at it. */
  min: number;
  /** The width before any drag or arrow-key resize, and the fallback for a
   * missing or corrupt stored value. Should match the default this same
   * drawer's own stylesheet carries for its width custom property, so the
   * very first paint — before persisted state can even be read — already
   * agrees with it. */
  def: number;
  /** The key this drawer's width is stored under in the shared persisted
   * state object (see `persist`/`read` below). Each drawer using this
   * module gets its own key so widths don't collide. */
  key: string;
}

/** One drawer's width arithmetic and persistence — the ceiling, the clamp,
 * the "full panel width" escape hatch, and the defensive read/write of the
 * one number that survives a reload. Everything here is shared behaviour;
 * only `min`, `def`, and `key` differ between drawers (see
 * `DrawerResizeConfig`). Built by `createDrawerResize` rather than exported
 * as loose functions so two drawers on the same surface can each get their
 * own closed-over `min`/`key` without passing them at every call site. */
export interface DrawerResize {
  MIN: number;
  DEFAULT: number;
  /** Recomputed on every call, not cached: the viewport can change (a window
   * resize, a panel dragged wider) while the drawer is open. */
  ceiling(): number;
  /** Clamps a candidate width to `[MIN, ceiling()]`. */
  clamp(w: number): number;
  /** "Full panel width" for an Expand toggle. Deliberately `window.innerWidth`
   * itself, not `ceiling()`'s clamp: the ceiling's whole job is reserving
   * room for a board column during an ordinary resize, and Expand exists
   * precisely to override that reservation when a graph genuinely needs the
   * room. */
  full(): number;
  /** Reads this drawer's persisted width. Defensive: a value written by a
   * future version of the persisted shape, or one that got corrupted, comes
   * back `null` rather than throwing or handing back garbage for a caller to
   * render with. */
  read(): number | null;
  /** Best-effort write of this drawer's width. A webview host that rejects
   * the write is not a reason to throw out of a keypress or a pointer
   * release.
   *
   * Merges into whatever is already persisted rather than replacing it:
   * `vscodeApi.setState` itself is a whole-state replace, and two drawers
   * share this one state object under two different keys, so writing only
   * `{ [key]: w }` would make each drawer's resize wipe out whatever the
   * OTHER drawer (or any other feature) had stored. Merging is this
   * function's job, not something a caller has to do before calling it. */
  persist(w: number): void;
}

export function createDrawerResize({ min, def, key }: DrawerResizeConfig): DrawerResize {
  function ceiling(): number {
    return Math.max(min, window.innerWidth - BOARD_MARGIN);
  }

  function clamp(w: number): number {
    return Math.min(ceiling(), Math.max(min, w));
  }

  function full(): number {
    return window.innerWidth;
  }

  function read(): number | null {
    let stored: unknown;
    try {
      stored = vscodeApi.getState<Record<string, unknown>>();
    } catch {
      return null;
    }
    if (!stored || typeof stored !== "object") return null;
    const w = (stored as Record<string, unknown>)[key];
    return typeof w === "number" && Number.isFinite(w) ? w : null;
  }

  function persist(w: number): void {
    try {
      // Merge, never replace. Two drawers persist under two keys in ONE state
      // object, so `setState({ [key]: w })` would make each drawer's resize wipe
      // the other's stored width — the first resize after an upgrade silently
      // losing a width the user had deliberately set. Reading first costs one
      // `getState` per resize COMMIT (not per pointer move), which is nothing.
      // Same defensive guard `read` above uses for a non-object/garbage `stored`.
      const stored = vscodeApi.getState<Record<string, unknown>>();
      const base = !stored || typeof stored !== "object" ? {} : stored;
      vscodeApi.setState({ ...base, [key]: w });
    } catch {
      // Losing persistence is not worse than losing the drawer over it.
    }
  }

  return { MIN: min, DEFAULT: def, ceiling, clamp, full, read, persist };
}
