// Makes Vitest's globals (describe/it/expect/vi/…) available to `tsc --noEmit`
// program-wide, matching `test.globals: true` in vitest.config.ts. A single
// reference in an included .d.ts applies globally without a `types` array
// (which would otherwise disable automatic @types inclusion for node/react/vscode).
/// <reference types="vitest/globals" />
