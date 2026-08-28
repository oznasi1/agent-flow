import * as React from "react";

/** Whether a clamped element is hiding any of its content — measured from the box,
 * never guessed from the text.
 *
 * A character-count estimate is the tempting alternative and it is wrong in the one
 * direction that matters: the sidebar is resizable, so at a narrow width a body that
 * "should" fit is clipped anyway, and the estimate would leave the hidden text with
 * no control to reveal it. Measuring costs a ResizeObserver and is right at every
 * width.
 *
 * `measuring` is false while the caller has the clamp turned off. Nothing is
 * overflowing then — the box has grown to its content — so re-measuring would report
 * `false` and retract the very control that undoes the expansion. Holding the last
 * measurement instead is what keeps "Show less" on screen.
 *
 * Returns the ref to put on the clamped element, and whether it is currently hiding
 * anything.
 */
export function useOverflowing<T extends HTMLElement>(measuring: boolean): [React.RefObject<T>, boolean] {
  const ref = React.useRef<T>(null);
  const [overflowing, setOverflowing] = React.useState(false);

  React.useEffect(() => {
    const el = ref.current;
    if (!el || !measuring) return;
    // A line box's height rounds to a fraction, so an exactly-fitting element can
    // measure a hair taller than its own box. One pixel of slack keeps that from
    // reading as hidden content.
    const measure = () => setOverflowing(el.scrollHeight > el.clientHeight + 1);
    measure();
    // Absent in jsdom, and this is a progressive enhancement in any case: without it
    // the element is still measured once per render, just not on a bare resize.
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  });

  return [ref, overflowing];
}
