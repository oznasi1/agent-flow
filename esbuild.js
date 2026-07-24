// Build both bundles: the extension host (Node/CommonJS) and the webview (browser/IIFE).
const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: "info",
};

const extensionConfig = {
  ...shared,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  external: ["vscode"], // provided by the VS Code runtime
  target: "node18",
  // Prefer each dependency's ESM entry (`module`) over its CommonJS/UMD `main`.
  // jsonc-parser's UMD main calls `require("./impl/format")` through a factory
  // parameter that esbuild can't follow, leaving an unbundled require that crashes
  // activation at runtime ("Cannot find module './impl/format'") since node_modules
  // isn't shipped. The ESM build uses static imports esbuild bundles correctly.
  mainFields: ["module", "main"],
};

const webviewConfig = {
  ...shared,
  entryPoints: ["src/webview/index.tsx"],
  outfile: "dist/webview.js",
  platform: "browser",
  format: "iife",
  target: "es2020",
};

// The Deck panel is a second, independent browser bundle.
const deckConfig = {
  ...webviewConfig,
  entryPoints: ["src/webview/deck.tsx"],
  outfile: "dist/deck.js",
};

// The Marketplace panel is a third, independent browser bundle.
const marketplaceConfig = {
  ...webviewConfig,
  entryPoints: ["src/webview/marketplace.tsx"],
  outfile: "dist/marketplace.js",
};

async function main() {
  if (watch) {
    const ctxs = await Promise.all([extensionConfig, webviewConfig, deckConfig, marketplaceConfig].map((c) => esbuild.context(c)));
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log("[esbuild] watching…");
  } else {
    await Promise.all([extensionConfig, webviewConfig, deckConfig, marketplaceConfig].map((c) => esbuild.build(c)));
    console.log("[esbuild] build complete");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
