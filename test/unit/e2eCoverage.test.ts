// test/unit/e2eCoverage.test.ts
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.join(__dirname, "../..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

interface Row { id: string; doc: string; claim: string; proof: string; line: number }

/** Parse every 4-column table row whose first cell is a backticked id. Header and
 *  separator rows never match because their first cell is not backticked. */
export function parseMatrix(md: string): Row[] {
  const rows: Row[] = [];
  md.split("\n").forEach((line, i) => {
    const m = /^\|\s*`([^`]+)`\s*\|\s*([^|]*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*$/.exec(line);
    if (m) rows.push({ id: m[1], doc: m[2], claim: m[3], proof: m[4], line: i + 1 });
  });
  return rows;
}

/** Every `test("…")` / `test.fail("…")` title in test-e2e/*.e2e.ts, with its file. */
export function e2eTitles(): { file: string; title: string }[] {
  const dir = path.join(ROOT, "test-e2e");
  const out: { file: string; title: string }[] = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".e2e.ts"))) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    // Titles are always string literals in this suite — a template literal would
    // defeat the substring contract sabotage/*.expect already relies on.
    for (const m of src.matchAll(/\btest(?:\.fail|\.skip|\.fixme)?\(\s*(["'])((?:\\.|(?!\1).)*)\1/g)) {
      out.push({ file: f, title: m[2] });
    }
  }
  return out;
}

const matrix = read("test-e2e/COVERAGE.md");
const rows = parseMatrix(matrix);
const backfilling = matrix.includes("## Backfill in progress");
const titles = e2eTitles();

describe("the E2E coverage matrix", () => {
  it("has rows", () => {
    expect(rows.length).toBeGreaterThan(100);
  });

  it("uses unique ids", () => {
    const seen = new Map<string, number>();
    for (const r of rows) {
      expect(seen.has(r.id), `duplicate id ${r.id} at lines ${seen.get(r.id)} and ${r.line}`).toBe(false);
      seen.set(r.id, r.line);
    }
  });

  it("uses only the proof grammar", () => {
    for (const r of rows) {
      const ok = /^(e2e|ct|unit|untestable): .+/.test(r.proof) || r.proof === "todo";
      expect(ok, `line ${r.line} (${r.id}): unrecognised proof "${r.proof}"`).toBe(true);
      if (r.proof === "todo") {
        expect(backfilling, `line ${r.line} (${r.id}): "todo" is only allowed under "## Backfill in progress"`).toBe(true);
      }
    }
  });

  it("points every e2e proof at exactly one real test title", () => {
    for (const r of rows.filter((r) => r.proof.startsWith("e2e: "))) {
      const needle = r.proof.slice("e2e: ".length);
      const hits = titles.filter((t) => t.title.includes(needle));
      expect(hits.length, `line ${r.line} (${r.id}): "${needle}" matched ${hits.length} titles: ${hits.map((h) => `${h.file}: ${h.title}`).join(" | ")}`).toBe(1);
    }
  });

  it("cites every E2E test from at least one row", () => {
    const needles = rows.filter((r) => r.proof.startsWith("e2e: ")).map((r) => r.proof.slice(5));
    for (const t of titles) {
      const cited = needles.some((n) => t.title.includes(n));
      expect(cited, `${t.file}: "${t.title}" is not cited by any COVERAGE.md row`).toBe(true);
    }
  });

  it("points ct:/unit: proofs at files that exist", () => {
    for (const r of rows.filter((r) => /^(ct|unit): /.test(r.proof))) {
      const p = r.proof.replace(/^(ct|unit): /, "");
      expect(fs.existsSync(path.join(ROOT, p)), `line ${r.line} (${r.id}): ${p} does not exist`).toBe(true);
    }
  });

  it("mentions every agentFlow.* setting in the manifest", () => {
    const pkg = JSON.parse(read("package.json")) as { contributes: { configuration: { properties: Record<string, unknown> } | { properties: Record<string, unknown> }[] } };
    const cfg = pkg.contributes.configuration;
    const props = Array.isArray(cfg) ? cfg.flatMap((c) => Object.keys(c.properties)) : Object.keys(cfg.properties);
    const text = rows.map((r) => `${r.id} ${r.claim}`).join("\n");
    for (const id of props.filter((p) => p.startsWith("agentFlow."))) {
      expect(text.includes(id), `setting ${id} has no COVERAGE.md row naming it`).toBe(true);
    }
  });
});
