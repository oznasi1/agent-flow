// The gate that was missing. `npm run build` bundles each webview entry for a
// BROWSER target, and esbuild resolves imports statically: one module anywhere in a
// webview's import graph that names `fs`, `os`, `path` or `child_process` fails the
// whole build, whether or not that code could ever run. That is exactly how this
// branch shipped a broken `npm run build` — OrchestratorDrawer.tsx imported
// `describeCond`, `conditions.ts` imported `mostActive` from `status.ts`, and
// `status.ts` reaches `child_process` through git.ts.
//
// A unit test cannot notice: vitest runs in Node, where every builtin resolves
// fine. So this walks the real graph the bundler walks — from each entry point in
// esbuild.js, following relative imports file by file — and names the offender and
// the path that reached it.
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const REPO = path.resolve(__dirname, "../..");

/** The entry points esbuild.js builds with `platform: "browser"`. Kept as literal
 * paths rather than parsed out of esbuild.js: a config change that adds a fourth
 * browser bundle should require a deliberate edit here, not silently go unchecked. */
const BROWSER_ENTRIES = [
  "src/webview/deck.tsx",
  "src/webview/index.tsx",
  "src/webview/marketplace.tsx",
];

/** Builtins this codebase actually uses host-side. Bare `node:`-prefixed forms count
 * too — esbuild treats them the same way for a browser target. */
const NODE_BUILTINS = ["fs", "os", "path", "child_process", "crypto", "http", "https", "net", "url", "util", "stream", "zlib"];

/** Every module specifier `file` imports as a VALUE. `import type` / `export type`
 * are skipped: esbuild erases them, so they are not edges in the bundler's graph
 * and forbidding them here would ban a type-only reference to a host-side type. */
function specifiersIn(source: string): string[] {
  const src = source
    // Strip comments first: several modules in this repo discuss `import * as fs`
    // in prose, and a naive scan would follow the sentence.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const out: string[] = [];
  // `import … from "x"`, `import "x"`, `export … from "x"` — but never the
  // `type`-qualified forms.
  const re = /(?:^|\n)\s*(?:import|export)\s+(?!type\s)(?:[\s\S]*?\sfrom\s*)?["']([^"']+)["']/g;
  for (const m of src.matchAll(re)) out.push(m[1]);
  return out;
}

/** Resolve a relative specifier the way esbuild does for this repo's TS sources. */
function resolveRelative(fromFile: string, spec: string): string | null {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/** Walk the graph from `entry`, returning the first Node-builtin import found with
 * the chain of files that reached it, or null when the graph is clean.
 *
 * `overrides` (repo-relative path → source) lets the mutation test below stand a
 * broken version of one module up in front of the walker without writing to the
 * working tree — a real write would race the other test files vitest runs in
 * parallel workers off the same checkout. */
function walk(entry: string, overrides: Record<string, string> = {}): {
  hit: { builtin: string; chain: string[] } | null;
  visited: Set<string>;
} {
  const visited = new Set<string>();
  let hit: { builtin: string; chain: string[] } | null = null;
  // Depth-first with the chain carried along, so a failure names the whole path and
  // not just "somewhere in the graph". The walk finishes even after a hit, so
  // `visited` is always the complete graph for the coverage assertion below.
  const stack: { file: string; chain: string[] }[] = [
    { file: path.join(REPO, entry), chain: [entry] },
  ];
  while (stack.length > 0) {
    const { file, chain } = stack.pop()!;
    const rel = path.relative(REPO, file);
    if (visited.has(rel)) continue;
    visited.add(rel);
    const source = overrides[rel] ?? fs.readFileSync(file, "utf8");
    for (const spec of specifiersIn(source)) {
      const bare = spec.replace(/^node:/, "");
      if (NODE_BUILTINS.includes(bare)) {
        hit ??= { builtin: spec, chain };
        continue;
      }
      if (!spec.startsWith(".")) continue; // a real npm package; the bundler ships it
      const next = resolveRelative(file, spec);
      // An unresolvable relative import would break the build too, but that is
      // esbuild's error to report, not this test's subject.
      if (next) stack.push({ file: next, chain: [...chain, path.relative(REPO, next)] });
    }
  }
  return { hit, visited };
}

const findBuiltin = (entry: string, overrides: Record<string, string> = {}) => walk(entry, overrides).hit;

describe("the webview bundles are Node-free", () => {
  it.each(BROWSER_ENTRIES)("%s reaches no Node builtin", (entry) => {
    const hit = findBuiltin(entry);
    // The message is the point: it names the builtin and every hop that reached it,
    // which is what turns a red test into a five-second fix.
    const detail = hit ? `imports "${hit.builtin}" via ${hit.chain.join(" → ")}` : "clean";
    expect(detail).toBe("clean");
  });

  // The walker is only worth anything if it can actually see a violation. This
  // proves it against the real graph, re-introducing the exact import that broke
  // this branch — conditions.ts → status.ts → git.ts → child_process — with every
  // other file, including status.ts and git.ts themselves, read from disk.
  it("would catch the import that broke this branch", () => {
    const rel = "src/engine/orchestrator/conditions.ts";
    const original = fs.readFileSync(path.join(REPO, rel), "utf8");
    expect(original).toContain('from "../activity"'); // the fixed state
    expect(original).not.toContain('from "../status"');

    // Synthesize the broken variant by matching the import's module specifier
    // rather than a hardcoded list of its bound names — a binding list goes stale
    // the moment someone adds another name to this import (as this branch's own
    // fix did), and a stale literal makes the `.replace` below a silent no-op.
    // Pull `mostActive` out into its own import from "../status" — the exact
    // regression this guard exists to catch — leaving every other binding this
    // import happens to have imported from "../activity" as before. Built by
    // slicing rather than `String.replace(str, repoText)`, since `repoText` in
    // replacement-string position would have `$&`/`$1`/`$'` interpreted.
    const importRe = /import\s*\{([^}]*)\}\s*from\s*"\.\.\/activity";/;
    const match = importRe.exec(original);
    expect(match).not.toBeNull();
    const bindings = match![1].split(",").map((b) => b.trim()).filter(Boolean);
    expect(bindings).toContain("mostActive");
    const rest = bindings.filter((b) => b !== "mostActive");
    const replacement =
      `import { mostActive } from "../status";` +
      (rest.length > 0 ? `\nimport { ${rest.join(", ")} } from "../activity";` : "");
    const broken =
      original.slice(0, match!.index) +
      replacement +
      original.slice(match!.index + match![0].length);
    expect(broken).not.toBe(original); // the replacement actually matched
    const hit = findBuiltin("src/webview/deck.tsx", { [rel]: broken });
    expect(hit).not.toBeNull();
    expect(hit!.chain).toContain("src/engine/status.ts");
    // WHICH builtin surfaces first is a detail of the walk order — status.ts reaches
    // `child_process` (git.ts), `fs`/`path`/`os` (runs.ts), `fs` (transcript.ts) and
    // `fs` (paths.ts), and any of them fails the browser build identically.
    expect(NODE_BUILTINS).toContain(hit!.builtin);
  });

  // And that it does not simply flag every relative import: `import type` is erased
  // by esbuild, so types.ts's type-only reach into the host side is not an edge.
  it("does not follow an import type edge", () => {
    const types = fs.readFileSync(path.join(REPO, "src/types.ts"), "utf8");
    expect(types).toContain('import type { SerializedCaps, TaskConnector } from "./tasks/provider"');
    expect(specifiersIn(types)).not.toContain("./tasks/provider");
  });

  // A walker that stops one hop in would pass every assertion above while checking
  // nothing. This pins that the Deck's walk really does reach the far end of the
  // orchestrator chain — the deepest thing the entry point pulls in, and the exact
  // path the break travelled down.
  it("actually reaches the far end of the Deck's graph", () => {
    const { visited } = walk("src/webview/deck.tsx");
    expect([...visited]).toEqual(expect.arrayContaining([
      "src/webview/deck.tsx",
      "src/webview/DeckApp.tsx",
      "src/webview/OrchestratorDrawer.tsx",
      "src/engine/orchestrator/conditions.ts",
      "src/engine/orchestrator/layout.ts",
      "src/engine/orchestrator/model.ts",
      "src/engine/activity.ts",
      "src/types.ts",
    ]));
    // And that it is not walking the whole of src/ regardless of the entry point:
    // the host-only modules must be absent, which is the property under test.
    expect([...visited]).not.toContain("src/engine/status.ts");
    expect([...visited]).not.toContain("src/deckView.ts");
  });
});
