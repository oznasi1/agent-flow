// The facts about the mark that more than one file has to agree on: the dot
// positions shared by GaugeMark (the static lockup that doubles as a window-count
// gauge) and LoadingMark (the in-flight animation), and the loader's cycle length,
// which the component's stagger and the keyframes in tokens.ts both depend on.
// A loader a pixel off the lockup reads as a different logo, and a stagger that
// disagrees with the cycle bunches the dots instead of chasing them.

/** The eight large dots of the mark (media/agent-flow.svg), in ring order starting at twelve o'clock. */
export const OUTER: readonly [number, number][] = [
  [12, 3.12], [18.28, 5.72], [20.88, 12], [18.28, 18.28],
  [12, 20.88], [5.72, 18.28], [3.12, 12], [5.72, 5.72],
];

/** The eight small dots between them. Texture, not data. */
export const INNER: readonly [number, number][] = [
  [15.4, 3.8], [20.2, 8.6], [20.2, 15.4], [15.4, 20.2],
  [8.6, 20.2], [3.8, 15.4], [3.8, 8.6], [8.6, 3.8],
];

export const OUTER_R = 2.02;
export const INNER_R = 1.21;

/** The viewBox both marks are drawn in. */
export const VIEW_BOX = "0 0 24 24";

/**
 * One trip of the lit dot round the ring. Lives here rather than beside either
 * user because both need it: tokens.ts spends it as the animation's duration,
 * LoadingMark divides it into the per-dot head start that makes the dot travel.
 */
export const CYCLE_MS = 1400;

/** A dot's slice of the cycle — its head start over the dot behind it. */
export const STEP_MS = CYCLE_MS / OUTER.length;
