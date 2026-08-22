import * as React from "react";
import { DRAWER_ANIM_MS } from "./deckStyles";

/** The Deck's one drawer shell, and the exit it needs code for.
 *
 * Both drawers on this surface — the card detail and the Orchestrator — are the
 * same object: a panel below the header, anchored to the right edge, no scrim,
 * in one fixed slot only one of them may occupy. They used to be two
 * independent implementations of that object, and they drifted: the
 * Orchestrator slid in and out, the card detail appeared and vanished in a
 * frame. This module is the seam that keeps them one thing — the element and
 * the exit here, the geometry in `.drawer` (deckStyles.ts). A drawer's own
 * sheet carries only what genuinely differs, which is its width and how it
 * scrolls.
 */
export interface DrawerProps {
  /** The drawer's own class — `dd` or `orch` — carrying its width and scrolling.
   * Composed onto `.drawer`, never instead of it. */
  surface: string;
  /** Names the landmark. Ignored by screen readers while closing (see
   * `closing`), because for those milliseconds this is a picture of a drawer
   * already dismissed. */
  label: string;
  /** Sliding out. Comes from `useDrawerExit` below, never from a caller's own
   * bookkeeping — the whole point of this pair is that there is one answer to
   * "is a drawer leaving" and one thing that draws it. */
  closing: boolean;
  style?: React.CSSProperties;
  children: React.ReactNode;
}

export function Drawer({ surface, label, closing, style, children }: DrawerProps): JSX.Element {
  return (
    <aside
      className={`drawer ${surface}${closing ? " closing" : ""}`}
      aria-label={label}
      /* Hidden from the accessibility tree for the length of the slide-out, not
         merely dimmed: a drawer already on its way out must not answer a role
         query, a screen reader, or a Tab — the click that closed it has already
         sent focus back to the control that opens it. Left off entirely while
         open — `aria-hidden={false}` is not the same as absent to every screen
         reader, and this element is the drawer's own landmark. */
      aria-hidden={closing || undefined}
      style={style}
    >
      {children}
    </aside>
  );
}

/** Holds a drawer's contents on screen for the length of its slide-out.
 *
 * Closing a drawer drops the key that opened it, which on its own unmounts the
 * panel in the same frame — and an element that is already gone cannot be
 * animated out. So the last open item is held for exactly as long as the slide
 * takes, then dropped.
 *
 * The two arguments are the whole design, and they are NOT the same signal:
 *
 *  - `openKey` is what the user is pointing at — a flow id, a card id.
 *  - `open` is the record that key currently resolves to on the board.
 *
 * A dismissal drops the key. An item disappearing from under an open drawer —
 * another window deleted the flow, the run left the board — drops `open` while
 * the key still names it, and that case must unmount at once rather than
 * animate: sliding out a record that no longer exists would be a picture of
 * something the drawer cannot show. Passing `open` alone could not tell those
 * apart, which is why the caller hands over both.
 */
export function useDrawerExit<T>(
  openKey: string | null,
  open: T | null | undefined,
): { shown: T | null; closing: boolean } {
  const [exiting, setExiting] = React.useState<T | null>(null);
  const last = React.useRef<T | null>(null);

  /** Remember what is open, so the close can still draw it. Deliberately keyed
   * on `open` as well as the key: `open` changes identity on every host post
   * while the drawer sits there, and that is wanted — the frame the slide-out
   * paints should be the item as it last was, not as it was when it opened.
   *
   * The `else` is the vanish case, and it is why this is not simply
   * `if (open) last.current = open`. A key that still names a record the board
   * no longer has must leave nothing behind to animate, or the drawer would
   * slide back in to slide out again the moment the caller drops the key. */
  React.useEffect(() => {
    if (openKey === null) return;
    last.current = open ?? null;
  }, [openKey, open]);

  /** Start the slide-out. Keyed on `openKey` alone: this fires on dismissal,
   * and reads the item the effect above left behind — which is null exactly
   * when there was nothing left worth animating. */
  React.useEffect(() => {
    if (openKey !== null) return;
    const prev = last.current;
    if (!prev) return;
    last.current = null;
    setExiting(prev);
    const t = window.setTimeout(() => setExiting(null), DRAWER_ANIM_MS);
    return () => window.clearTimeout(t);
  }, [openKey]);

  return { shown: open ?? exiting, closing: !open && exiting !== null };
}
