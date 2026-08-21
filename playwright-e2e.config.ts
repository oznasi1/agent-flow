import { defineConfig } from "@playwright/test";

/** Real-host E2E: one worker (each test boots an Electron VS Code), long
 *  timeouts (first run downloads the host), artifacts on failure. Spec files
 *  use `.e2e.ts` so neither Vitest (test/·test.*) nor CT (test-ct/·spec.tsx)
 *  can ever claim them — three runners, three disjoint suffixes. */
export default defineConfig({
  testDir: "./test-e2e",
  testMatch: /.*\.e2e\.ts$/,
  timeout: 120_000,
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // The json reporter runs everywhere: it is what scripts/verify-report.mjs
  // reads to build the screenshot-strip verify-feature report (Layer C).
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/e2e-results.json" }],
    ...(process.env.CI ? ([["html", { open: "never", outputFolder: "playwright-e2e-report" }]] as const) : []),
  ],
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
