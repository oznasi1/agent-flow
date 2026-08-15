// The mark's dot positions, shared by everything that draws it: GaugeMark (the
// static lockup that doubles as a window-count gauge) and LoadingMark (the
// in-flight animation). Both must agree exactly — a loader that is a pixel off
// the lockup reads as a different logo.

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
