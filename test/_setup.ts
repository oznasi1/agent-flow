import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach } from "vitest";
import { resetVscodeMocks } from "./_mocks/vscode";

const NATIVE_FETCH = globalThis.fetch;

// Fresh vscode mock state (call history, implementations, mutable fields) per test.
beforeEach(() => {
  resetVscodeMocks();
});

// Undo any scripted global.fetch installed by a client test.
afterEach(() => {
  globalThis.fetch = NATIVE_FETCH;
});

// Unmount any React trees rendered in jsdom tests. No-op under the node environment.
afterEach(async () => {
  if (typeof document !== "undefined") {
    const { cleanup } = await import("@testing-library/react");
    cleanup();
  }
});
