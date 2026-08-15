import * as React from "react";
import { OUTER, INNER, OUTER_R, INNER_R, VIEW_BOX } from "./markGeometry";

/** One trip round the ring. Kept in sync with the `mark-comet` keyframes in tokens.ts. */
const CYCLE_MS = 1400;

/**
 * Below this the inner texture dots stop being texture and start being noise:
 * they sit close enough to the outer ring that at 12px the two blur into one
 * fuzzy circle and the travelling dot stops reading.
 */
const TEXTURE_FLOOR = 14;

/**
 * The mark, animated: one dot bright and three fading behind it, running the ring.
 * Use it wherever the app is waiting on something.
 *
 * Pass `label` only where the mark stands alone — beside text that already says
 * "Loading…" it is decoration, and a second announcement is noise, so it hides
 * itself by default.
 *
 * The animation itself lives in BASE_CSS, which also holds the reduced-motion
 * rest state: motion off leaves a legible static mark, not a blank ring.
 */
export function LoadingMark({ size = 15, label }: { size?: number; label?: string }): JSX.Element {
  const named = label !== undefined;

  return (
    <svg
      className="lmark"
      width={size}
      height={size}
      viewBox={VIEW_BOX}
      role={named ? "img" : undefined}
      aria-label={label}
      aria-hidden={named ? undefined : true}
    >
      {size >= TEXTURE_FLOOR &&
        INNER.map(([cx, cy], i) => (
          <circle key={`i${i}`} cx={cx} cy={cy} r={INNER_R} className="tex" />
        ))}
      {OUTER.map(([cx, cy], i) => (
        <circle
          key={`o${i}`}
          cx={cx}
          cy={cy}
          r={OUTER_R}
          className="ldot"
          // Each dot runs the same keyframes, started a slice earlier than the one
          // before it — that offset, not any transform, is what makes the lit dot
          // travel. A dot is bright as its cycle wraps, so offsets shrink clockwise
          // round the ring to make the bright one move clockwise too. The twelve
          // o'clock dot takes a full cycle rather than zero: same phase, and it keeps
          // the offsets monotonic, which is what the direction reads from.
          style={{
            animationDelay: `-${Math.round((1 - i / OUTER.length) * CYCLE_MS)}ms`,
          }}
        />
      ))}
    </svg>
  );
}
