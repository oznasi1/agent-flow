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
   * Replaces the whole persisted state object with one containing only this
   * drawer's key — exactly what the Orchestrator drawer did before this
   * module existed. It does NOT merge with whatever is already stored, so a
   * second drawer persisting under a different key via this same function
   * would clobber the first drawer's key rather than sit beside it. That is
   * unchanged behaviour, carried forward on purpose by this refactor; a
   * caller that needs two keys to coexist has to merge before calling
   * `vscodeApi.setState` itself (or this module gains a merging `persist`
   * later) — this module does not invent that merge on its own. */
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
      vscodeApi.setState({ [key]: w });
    } catch {
      // Losing persistence is not worse than losing the drawer over it.
    }
  }

  return { MIN: min, DEFAULT: def, ceiling, clamp, full, read, persist };
}
