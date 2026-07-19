import { defineConfig } from "vitest/config";
import * as path from "path";

export default defineConfig({
  // App .tsx uses the classic JSX runtime (`import * as React`); keep esbuild in
  // classic mode so `React` is the factory in test files too.
  esbuild: { jsx: "transform", jsxFactory: "React.createElement", jsxFragment: "React.Fragment" },
  resolve: {
    alias: {
      // `vscode` is not a real npm module — it's injected by the extension host at
      // runtime. Point every host-side import at our hand-written mock.
      vscode: path.resolve(__dirname, "test/_mocks/vscode.ts"),
    },
  },
  test: {
    globals: true,
    // Clear mock call history before each test (keeps implementations) so call
    // counts never leak between tests.
    clearMocks: true,
    // Node by default; webview test files opt into jsdom via a
    // `// @vitest-environment jsdom` docblock at the top of the file.
    environment: "node",
    setupFiles: ["test/_setup.ts"],
    include: ["test/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: [
        "src/webview/styles.ts",
        "src/webview/deckStyles.ts",
        "src/webview/index.tsx",
        "src/webview/deck.tsx",
        "src/webview/vscodeApi.ts",
        "src/types.ts",
      ],
      reporter: ["text", "html"],
      // Guardrails, set with headroom below the current ~95% lines / ~89% branches.
      thresholds: { statements: 90, branches: 85, functions: 85, lines: 90 },
    },
  },
});
