#!/usr/bin/env node
// Apply a mutation, rebuild, run ONE journey, require it to fail, revert, prove
// the tree is clean. A journey that still passes under its mutation is vacuous.
//
// A patch's companion `<journey>.expect` names the exact test the mutation is
// aimed at. Checking only the spec's overall exit code is not enough: Playwright
// runs `describeWithHost` suites in serial mode, which skips every test after the
// first genuine failure in a file — so an unrelated earlier failure can mask a
// target test that never even ran, and this gate would report "correctly failed"
// for the wrong reason. Reading the JSON report and requiring the NAMED test to
// have actually failed closes that hole.
//
// Deliberately not a per-PR gate: it rebuilds and re-runs per patch, far too
// slow for a required check, and "a test stopped being able to fail" is a
// standing-health question, not a merge-blocking one.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "test-e2e/sabotage";
// Matches the `json` reporter's `outputFile` in playwright-e2e.config.ts — that
// reporter is configured unconditionally (not gated on CI), and a single-spec
// run still writes it, confirmed by inspection while building this check.
const REPORT = "test-results/e2e-results.json";
// A gitignored marker (lives under test-results/, already ignored) naming the
// patch currently applied. This runner's `finally` reverts the patch, but a
// `finally` cannot survive a SIGKILL of its own process — a hard kill mid-patch
// (e.g. a tool timeout during `npm run build`) has left a mutated src/ on disk
// with no explanation beyond "tree is dirty". The marker lets the NEXT run say
// which patch and how to recover, instead of just refusing to proceed.
const MARKER_DIR = "test-results";
const MARKER = join(MARKER_DIR, ".sabotage-in-progress");
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });

function dirty() {
  return execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() !== "";
}

/** Flatten Playwright's nested suite tree (file suite > describe suite(s) > spec)
 *  into a plain list of specs. Nesting depth isn't fixed — `describeWithHost`
 *  itself is one more level than a bare `test.describe` — so this recurses
 *  rather than assuming a shape. */
function flattenSpecs(suite, acc = []) {
  for (const s of suite.specs ?? []) acc.push(s);
  for (const sub of suite.suites ?? []) flattenSpecs(sub, acc);
  return acc;
}

/** The final status of a spec's (only, given workers:1/retries:0-or-1) test run,
 *  after any CI retry — the LAST result, not the first, so a retried spec is
 *  judged on how it actually ended up. One of "passed" | "failed" | "timedOut" |
 *  "interrupted" | "skipped", or undefined if the spec has no results at all
 *  (shouldn't happen for a spec that was collected). */
function finalStatus(spec) {
  const results = spec.tests?.flatMap((t) => t.results ?? []) ?? [];
  return results.length > 0 ? results[results.length - 1].status : undefined;
}

/** Check whether the ONE test the patch targets (named by a substring of its
 *  title in `<journey>.expect`) actually failed under the mutation. Returns a
 *  {ok, message} pair — `ok` is only true when the target test's own result was
 *  a genuine failure, never inferred from the spec file's overall exit code. */
function checkTarget(journey, expectSubstring) {
  if (!existsSync(REPORT)) {
    return { ok: false, message: `${journey}: no ${REPORT} was written — cannot verify which test failed` };
  }
  let report;
  try {
    report = JSON.parse(readFileSync(REPORT, "utf8"));
  } catch (err) {
    // A malformed or truncated report (e.g. the run crashed mid-write) must not
    // throw out of this function — an uncaught throw here would escape the
    // per-patch loop below entirely (the `git apply -R` revert in that loop's
    // `finally` would still run, but the loop's own iteration, and the final
    // `npm run build` after it that restores dist/ to match the clean tree,
    // never would) — leaving a sabotaged dist/ behind a clean-looking git
    // tree. Fail just this one journey instead.
    return {
      ok: false,
      message: `${journey}: ${REPORT} could not be parsed as JSON (${err.message}) — cannot verify which test failed`,
    };
  }
  const specs = (report.suites ?? []).flatMap((top) => flattenSpecs(top));
  const matches = specs.filter((s) => s.title.includes(expectSubstring));
  if (matches.length === 0) {
    return {
      ok: false,
      message: `${journey}: no test title contains "${expectSubstring}" — ${journey}.expect is stale (was the test renamed?)`,
    };
  }
  for (const spec of matches) {
    const status = finalStatus(spec);
    if (status === "skipped") {
      return {
        ok: false,
        message: `${journey}: the target test ("${spec.title}") was SKIPPED, not failed — an earlier test in this ` +
          `file failed first and describeWithHost's serial mode cascade-skipped the rest, masking whether the ` +
          `intended assertion even ran. Re-aim the patch (or the .expect) so the mutation's OWN test fails first.`,
      };
    }
    if (status === "passed") {
      return {
        ok: false,
        message: `${journey}: the target test ("${spec.title}") PASSED under the mutation — the journey is ` +
          `vacuous for that assertion`,
      };
    }
    if (status !== "failed" && status !== "timedOut" && status !== "interrupted") {
      return { ok: false, message: `${journey}: the target test ("${spec.title}") has unexpected status "${status}"` };
    }
  }
  return { ok: true, message: `${journey}: target test "${matches[0].title}" correctly failed` };
}

if (existsSync(MARKER)) {
  const journey = readFileSync(MARKER, "utf8").trim();
  const patchPath = join(DIR, `${journey}.patch`);
  if (dirty()) {
    console.error(
      `sabotage: a previous run was killed while ${journey}.patch was applied — the working tree ` +
        `still carries that mutation, not just an unrelated dirty tree.\n` +
        `Recover with: git apply -R ${patchPath}\n` +
        `Then re-run \`npm run sabotage\` (the marker is cleared automatically once the tree is clean).`,
    );
    process.exit(1);
  }
  // The tree is already clean — the patch was reverted by hand (or some other
  // way) and the marker is just stale. Don't let a stale marker block every
  // future run forever; clean it up and fall through to a normal run.
  console.error(`sabotage: clearing stale marker for ${journey}.patch (tree is already clean)`);
  rmSync(MARKER, { force: true });
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
  const expectFile = join(DIR, `${journey}.expect`);
  if (!existsSync(spec)) {
    console.error(`sabotage: ${patch} has no matching ${spec}`);
    failures++;
    continue;
  }
  if (!existsSync(expectFile)) {
    console.error(`sabotage: ${patch} has no matching ${expectFile}`);
    failures++;
    continue;
  }
  const expectSubstring = readFileSync(expectFile, "utf8").trim();
  console.log(`\n=== sabotage: ${journey} ===`);
  // Record which patch is about to go on disk BEFORE applying it, so a hard
  // kill anywhere between here and the revert below leaves a trail. Written
  // ahead of `git apply` on purpose: the mutation itself is what dirties the
  // tree, so the marker must exist for the entire window the tree is dirty.
  mkdirSync(MARKER_DIR, { recursive: true });
  writeFileSync(MARKER, journey);
  run("git", ["apply", join(DIR, patch)]);
  let survived = false;
  let target;
  try {
    // Rebuild: E2E asserts the BUNDLE, so without this the mutation is not in
    // the code under test and every journey would "survive" every patch.
    run("npm", ["run", "build"]);
    // A stale report from an earlier run must never be mistaken for this run's
    // — if playwright fails to write a fresh one, checkTarget below should see
    // "no report", not yesterday's answer.
    rmSync(REPORT, { force: true });
    try {
      run("npx", ["playwright", "test", "-c", "playwright-e2e.config.ts", spec]);
      survived = true; // exit 0 under the mutation
    } catch {
      // Expected: the spec run exited non-zero. Which test caused that, and
      // whether it's the RIGHT one, is checked below via the JSON report —
      // the exit code alone cannot distinguish "our target test failed" from
      // "some other test failed and cascade-skipped our target."
    }
    // Read the report regardless of survived/not: a survived run still needs
    // reporting on (it's already a failure below), and a failed run needs its
    // target test checked before the patch — and the report — are gone.
    target = checkTarget(journey, expectSubstring);
  } finally {
    run("git", ["apply", "-R", join(DIR, patch)]);
  }
  if (dirty()) {
    console.error(`sabotage: tree not clean after reverting ${patch} — fix by hand before continuing`);
    process.exit(1);
  }
  // Revert confirmed clean — the marker's job is done.
  rmSync(MARKER, { force: true });
  if (survived) {
    console.error(`sabotage: ${journey} PASSED under its mutation — the journey is vacuous`);
    failures++;
    continue;
  }
  if (!target.ok) {
    console.error(`sabotage: ${target.message}`);
    failures++;
    continue;
  }
  console.log(`sabotage: ${journey} correctly FAILED under its mutation (${target.message})`);
}

run("npm", ["run", "build"]); // leave dist/ matching the clean tree
process.exit(failures === 0 ? 0 : 1);
