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

async function main() {
  if (watch) {
    const ctxs = await Promise.all([extensionConfig, webviewConfig, deckConfig].map((c) => esbuild.context(c)));
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log("[esbuild] watching…");
  } else {
    await Promise.all([extensionConfig, webviewConfig, deckConfig].map((c) => esbuild.build(c)));
    console.log("[esbuild] build complete");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
