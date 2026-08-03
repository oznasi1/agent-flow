import * as React from "react";

// The eight large dots of the existing mark (media/agent-flow.svg), in ring order
// starting at twelve o'clock. They carry the count.
const OUTER: [number, number][] = [
  [12, 3.12], [18.28, 5.72], [20.88, 12], [18.28, 18.28],
  [12, 20.88], [5.72, 18.28], [3.12, 12], [5.72, 5.72],
];
// The eight small dots between them. Texture, not data — fixed opacity always.
const INNER: [number, number][] = [
  [15.4, 3.8], [20.2, 8.6], [20.2, 15.4], [15.4, 20.2],
  [8.6, 20.2], [3.8, 15.4], [3.8, 8.6], [8.6, 3.8],
];

/** Dots lit when the host isn't reporting a count — the brand's resting state. */
const STATIC_LIT = 6;

/**
 * The mark, doubling as a gauge. `live` is the number of Agent Flow windows open
 * right now; omit it (the host omits it when trackOpenWindows is off) to get the
 * static lockup. It never animates: the sidebar has no turn state, so a pulse
 * would imply activity this component cannot see.
 */
export function GaugeMark({ live, size = 15 }: { live?: number; size?: number }): JSX.Element {
  const known = live !== undefined;
  const count = known ? Math.max(0, Math.min(live, OUTER.length)) : STATIC_LIT;
  const label = known ? `${live} Agent Flow window${live === 1 ? "" : "s"} open` : undefined;

  return (
    <svg
      className="gauge"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role={known ? "img" : undefined}
      aria-label={label}
      aria-hidden={known ? undefined : true}
    >
      {OUTER.map(([cx, cy], i) => (
        <circle key={`o${i}`} cx={cx} cy={cy} r={2.02} className={i < count ? "lit" : "unlit"} />
      ))}
      {INNER.map(([cx, cy], i) => (
        <circle key={`i${i}`} cx={cx} cy={cy} r={1.21} className="tex" />
      ))}
    </svg>
  );
}
