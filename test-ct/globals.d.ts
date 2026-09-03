import type { InboundMessage } from "../src/types";

declare global {
  interface Window {
    __posted: InboundMessage[];
    /** The vscodeApi double's persisted `setState` value — see
     *  `test-ct/_doubles/vscodeApi.ts` for why this round-trips for real
     *  rather than discarding writes the way `__posted`'s sibling used to. */
    __state: unknown;
  }
}

export {};
