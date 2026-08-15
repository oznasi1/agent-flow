import type { InboundMessage } from "../src/types";

declare global {
  interface Window {
    __posted: InboundMessage[];
  }
}

export {};
