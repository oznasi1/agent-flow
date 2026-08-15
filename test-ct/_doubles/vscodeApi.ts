import type { InboundMessage } from "../../src/types";

/** Every message the component posted to the host, in order. Specs read it
 *  through `window.__posted`. */
const posted: InboundMessage[] = [];
window.__posted = posted;

export const vscodeApi = {
  postMessage: (msg: InboundMessage): void => { posted.push(msg); },
  getState: <T,>(): T | undefined => undefined,
  setState: <T,>(_state: T): void => {},
};

export function send(msg: InboundMessage): void {
  posted.push(msg);
}
