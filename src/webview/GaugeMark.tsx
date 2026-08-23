import * as React from "react";
import { OUTER, INNER, OUTER_R, INNER_R, VIEW_BOX } from "./markGeometry";
// The outer dots carry the count; the inner ones are texture, at fixed opacity always.

/** Dots lit when the host isn't reporting a count — the brand's resting state. */
const STATIC_LIT = 6;

/**
 * The mark, doubling as a gauge. `live` is the number of Agent Flow Deck windows open,
 * as of the host's last `state` or `tasks` post — it updates whenever the pool
 * refreshes, not just at mount. Omit it (the host omits it when trackOpenWindows
 * is off) to get the static lockup. It never animates: the sidebar has no turn
 * state, so a pulse would imply activity this component cannot see.
 */
export function GaugeMark({ live, size = 15 }: { live?: number; size?: number }): JSX.Element {
  const known = live !== undefined;
  const count = known ? Math.max(0, Math.min(live, OUTER.length)) : STATIC_LIT;
  const label = known ? `${live} Agent Flow Deck window${live === 1 ? "" : "s"} open` : undefined;

  return (
    <svg
      className="gauge"
      width={size}
      height={size}
      viewBox={VIEW_BOX}
      role={known ? "img" : undefined}
      aria-label={label}
      aria-hidden={known ? undefined : true}
    >
      {OUTER.map(([cx, cy], i) => (
        <circle key={`o${i}`} cx={cx} cy={cy} r={OUTER_R} className={i < count ? "lit" : "unlit"} />
      ))}
      {INNER.map(([cx, cy], i) => (
        <circle key={`i${i}`} cx={cx} cy={cy} r={INNER_R} className="tex" />
      ))}
    </svg>
  );
}
