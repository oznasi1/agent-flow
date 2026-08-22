#!/usr/bin/env node
// Apply a mutation, rebuild, run ONE journey, require it to fail, revert, prove
// the tree is clean. A journey that still passes under its mutation is vacuous.
//
// Deliberately not a per-PR gate: it rebuilds and re-runs per patch, far too
// slow for a required check, and "a test stopped being able to fail" is a
// standing-health question, not a merge-blocking one.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = "test-e2e/sabotage";
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });

function dirty() {
  return execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() !== "";
}

if (dirty()) {
  console.error("sabotage: working tree is dirty. Commit first — the revert would discard your changes.");
  process.exit(1);
}

const only = process.argv[2];
const patches = readdirSync(DIR).filter((f) => f.endsWith(".patch"))
  .filter((f) => !only || f === `${only}.patch`);
if (patches.length === 0) {
  console.error(`sabotage: no patches matched${only ? ` "${only}"` : ""} in ${DIR}`);
  process.exit(1);
}

let failures = 0;
for (const patch of patches) {
  const journey = patch.replace(/\.patch$/, "");
  const spec = `test-e2e/${journey}.e2e.ts`;
  if (!existsSync(spec)) {
    console.error(`sabotage: ${patch} has no matching ${spec}`);
    failures++;
    continue;
  }
  console.log(`\n=== sabotage: ${journey} ===`);
  run("git", ["apply", join(DIR, patch)]);
  let survived = false;
  try {
    // Rebuild: E2E asserts the BUNDLE, so without this the mutation is not in
    // the code under test and every journey would "survive" every patch.
    run("npm", ["run", "build"]);
    run("npx", ["playwright", "test", "-c", "playwright-e2e.config.ts", spec]);
    survived = true; // exit 0 under the mutation
  } catch {
    console.log(`sabotage: ${journey} correctly FAILED under its mutation`);
  } finally {
    run("git", ["apply", "-R", join(DIR, patch)]);
  }
  if (dirty()) {
    console.error(`sabotage: tree not clean after reverting ${patch} — fix by hand before continuing`);
    process.exit(1);
  }
  if (survived) {
    console.error(`sabotage: ${journey} PASSED under its mutation — the journey is vacuous`);
    failures++;
  }
}

run("npm", ["run", "build"]); // leave dist/ matching the clean tree
process.exit(failures === 0 ? 0 : 1);
