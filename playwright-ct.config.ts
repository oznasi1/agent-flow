import { defineConfig, devices } from "@playwright/experimental-ct-react";
import * as path from "path";

/**
 * Swap the webview's `vscodeApi` module for a recording double — the CT
 * analogue of `vi.mock("../../src/webview/vscodeApi")` in the Vitest suite.
 *
 * `src/webview/vscodeApi.ts` calls `acquireVsCodeApi()` at module scope, which
 * throws in a plain browser. Resolving the import away is order-independent,
 * unlike defining a global and hoping it lands before the module evaluates.
 */
const stubVscodeApi = {
  name: "agent-flow:stub-vscode-api",
  enforce: "pre" as const,
  resolveId(source: string) {
    if (source === "./vscodeApi" || source.endsWith("/webview/vscodeApi")) {
      return path.resolve(__dirname, "test-ct/_doubles/vscodeApi.ts");
    }
    return null;
  },
};

export default defineConfig({
  testDir: "./test-ct",
  // `.spec.tsx`, never `.test.tsx`: Vitest owns `test/**/*.test.{ts,tsx}` and
  // the two runners must never claim the same file.
  testMatch: /.*\.spec\.tsx?$/,
  timeout: 20_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ctViteConfig: {
      plugins: [stubVscodeApi],
      // Must match vitest.config.ts — the webview uses the classic JSX runtime.
      esbuild: { jsx: "transform", jsxFactory: "React.createElement", jsxFragment: "React.Fragment" },
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
