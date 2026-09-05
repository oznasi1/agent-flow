import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

/** `dist/tick.js` runs where no `vscode` module exists, and its esbuild config
 * marks nothing external — so an import of `vscode` anywhere in its graph fails
 * `npm run build`. This is the nearer gate: it names the file, and it runs in the
 * unit suite. Relative imports are followed; a bare specifier is a dependency,
 * and only `vscode` is the one that cannot be there. */
const ROOT = path.join(__dirname, "../../../src");

function imports(file: string): string[] {
  const src = fs.readFileSync(file, "utf8");
  // `import type` is erased by esbuild and never loads the module; only a value
  // import puts a file in the bundle.
  return [...src.matchAll(/^import\s(?!type\s)[^;]*?\sfrom\s+"([^"]+)";?$/gm)].map((m) => m[1]);
}

describe("the headless tick's import graph", () => {
  it("never reaches vscode, directly or through a relative import", () => {
    const seen = new Set<string>();
    const offenders: string[] = [];
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const spec of imports(file)) {
        if (spec === "vscode") offenders.push(path.relative(ROOT, file));
        if (!spec.startsWith(".")) continue;
        const base = path.resolve(path.dirname(file), spec);
        const target = [base + ".ts", base + ".tsx", path.join(base, "index.ts")].find((p) => fs.existsSync(p));
        if (target) walk(target);
      }
    };
    walk(path.join(ROOT, "headless", "main.ts"));
    expect(offenders).toEqual([]);
    // The walk really covered the engine: a graph this small would mean the
    // entry point stopped importing it.
    expect(seen.size).toBeGreaterThan(20);
  });
});
