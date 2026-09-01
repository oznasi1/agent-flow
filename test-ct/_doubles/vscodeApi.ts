import type { InboundMessage } from "../../src/types";

/** Every message the component posted to the host, in order. Specs read it
 *  through `window.__posted`. */
const posted: InboundMessage[] = [];
window.__posted = posted;

/** The real webview's `getState`/`setState` round-trip through a value the
 *  host persists across reloads — `drawerResize.ts`'s `persist`/`read` depend
 *  on that round trip actually working, not merely being called. A double
 *  whose `setState` was a no-op (the original shape here) could never prove a
 *  width survived a drag: `read()` would always answer `null` on the very
 *  next call, whether `persist` genuinely wrote anything or not. Specs read
 *  the stored value back through `window.__state`, the same idiom `__posted`
 *  already gives the message log. */
let state: unknown;
Object.defineProperty(window, "__state", { get: () => state });

export const vscodeApi = {
  postMessage: (msg: InboundMessage): void => { posted.push(msg); },
  getState: <T,>(): T | undefined => state as T | undefined,
  setState: <T,>(next: T): void => { state = next; },
};

export function send(msg: InboundMessage): void {
  posted.push(msg);
}
