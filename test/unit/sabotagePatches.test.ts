// test/unit/sabotagePatches.test.ts
import { describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

// The sabotage lane (scripts/sabotage.mjs) runs weekly, not per-PR, so a patch
// whose context drifted with the source used to sit broken for weeks — five of
// them did, and the weekly job failed from 2026-08-31 on. `git apply --check` is
// cheap and touches nothing, so the drift is caught here, on the PR that caused it.
const ROOT = path.join(__dirname, "../..");
const DIR = path.join(ROOT, "test-e2e/sabotage");
const patches = fs.readdirSync(DIR).filter((f) => f.endsWith(".patch"));

describe("the sabotage patches", () => {
  it("exist", () => {
    expect(patches.length).toBeGreaterThan(0);
  });

  it.each(patches)("%s still applies to the current source", (patch) => {
    let error = "";
    try {
      execFileSync("git", ["apply", "--check", path.join("test-e2e/sabotage", patch)], { cwd: ROOT, stdio: "pipe" });
    } catch (err) {
      error = String((err as { stderr?: Buffer }).stderr ?? err);
    }
    expect(error, `${patch} no longer applies — regenerate it against the current source`).toBe("");
  });
});
