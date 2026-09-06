import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "..", "..", ".github", "workflows");

/** Every job in a workflow file, as a name plus its own indented block of lines. */
function jobs(yaml: string): { name: string; block: string[] }[] {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => l === "jobs:");
  if (start === -1) return [];
  const found: { name: string; block: string[] }[] = [];
  for (const line of lines.slice(start + 1)) {
    // A non-indented key ends the jobs section; a two-space key opens a job.
    if (/^\S/.test(line)) break;
    const opener = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (opener) found.push({ name: opener[1], block: [] });
    else found.at(-1)?.block.push(line);
  }
  return found;
}

// A hang and a failure read the same on the checks page, but an unbounded job
// inherits the runner's 6-hour ceiling: PR #79 held a runner for 6h0m15s on a
// vitest worker that never exited, for a suite that normally takes ~50s. Every
// job carries its own bound so the answer arrives in minutes.
describe("every workflow job is bounded by timeout-minutes", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".yml"));

  it("finds the workflow files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const yaml = readFileSync(join(DIR, file), "utf8");
    for (const { name, block } of jobs(yaml)) {
      it(`${file} › ${name}`, () => {
        const bound = block
          .map((l) => /^ {4}timeout-minutes: (\d+)\s*$/.exec(l))
          .find((m) => m !== null);
        expect(bound, `${file}: job "${name}" has no timeout-minutes`).toBeTruthy();
        // The 6h ceiling is what we are escaping; anything near it is not a bound.
        expect(Number(bound![1])).toBeLessThanOrEqual(90);
      });
    }
  }
});
