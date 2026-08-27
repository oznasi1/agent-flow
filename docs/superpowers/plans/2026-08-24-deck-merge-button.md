# Merge from a Deck card — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a **Merge** button on a Deck card when its one open PR is provably green — CI passed, approved, no unresolved review threads, mergeable clean — and merge it through the configured forge's CLI after a modal confirm.

**Architecture:** A new pure predicate `mergeTarget()` in `src/engine/bucket.ts` (webview-importable, `fs`-free) decides whether a card has exactly one mergeable PR. The webview renders a Merge row from it; the host re-runs the same predicate before writing, then calls a new `merge()` method on `PrProvider`, implemented once per forge (`gh pr merge` / `glab api --method PUT …/merge`). The whole feature is inert behind `agentFlow.mergeWrites`, default `false`.

**Tech Stack:** TypeScript, React (webview), Vitest + @testing-library/react, esbuild.

**Spec:** [docs/superpowers/specs/2026-08-24-deck-merge-button-design.md](../specs/2026-08-24-deck-merge-button-design.md)

## Global Constraints

These apply to **every** task. They come from [CLAUDE.md](../../../CLAUDE.md) and [CONTRIBUTING.md](../../../CONTRIBUTING.md), and subagents follow the brief rather than the repo docs — so they are restated here.

- **Work in this worktree:** `/Users/oznasi/dev/agent-flow-merge-button`, branch `feat/deck-merge-button`. **Use absolute paths in every Bash call.** Parallel sessions share the root checkout at `/Users/oznasi/dev/agent-flow` and will switch its branch under you.
- **The CI gate is exactly four commands, all four must pass:** `npm ci`, `npm run typecheck`, `npm test`, `npm run build`. `npm run build` is a real gate, not a formality.
- **`npm test` is ~4,500 tests across 134 files and takes 2+ minutes.** It exceeds the default Bash tool timeout and auto-backgrounds at 120s — **pass `timeout: 600000`**. Never pipe vitest through `tail` or `head`: it loses the failure list. A single failure under CPU contention is usually flake — re-run that file alone before believing it.
- **Run a single file while iterating:** `npx vitest run test/unit/engine/bucket.test.ts`. Never let two vitest runs overlap.
- **`tsconfig.json` includes `test/`.** A type error in a test file fails `npm run typecheck`.
- **Never break existing users.** New behavior ships inert (default-off setting). The existing suite must pass **unmodified**. A test you had to edit to make green is the signal to stop and ask. Two deliberate, non-assertion exceptions are called out explicitly in Tasks 4 and 5 — nothing else may change in an existing test.
- **`src/engine/bucket.ts` may import from `"../types"` and nothing else.** `test/unit/engine/bucket.test.ts` asserts the import list is exactly `["../types"]`.
- **The webview cannot reach Node.** Nothing reachable from `src/webview/*` may import `fs`, `os`, `path`, or `child_process`, even transitively and even if never called — esbuild resolves statically and `npm run build` fails. `tsc` and most of the suite pass regardless.
- **`src/types.ts` holds zero runtime values** (`grep -c "^export const" src/types.ts` is `0`). Add types there, never a `const`.
- **`--brand` is an allowlist, not a colour.** `test/webview/tokens.test.ts` asserts set equality of `--brand` spenders per stylesheet. Never add `var(--brand)` to a new selector. Use `var(--c-done)` for a green/ok state.
- **Async reads leak across webview tests.** Assert with `waitFor`, never a bare `setTimeout(0)` tick.
- **Commit after every task.** Incremental commits only — a partial tree must be verifiable with `npx tsc --noEmit`.
- Every user-facing change gets a `CHANGELOG.md` entry under `## [Unreleased]` (Task 7).

**Deferred from the spec, deliberately — do not implement:**
- **The telemetry *event*.** The spec called for "one additive telemetry event". `src/telemetry/events.ts` is a tightly-guarded catalog whose privacy properties have their own frozen tests, and the *existing* review-write path (`ReviewProvider.submit`) emits no event either — there is no `review_submit` op in `Op`. Shipping merge without one matches the established pattern exactly. The two new **settings** still join the existing settings snapshot (Task 4), which every setting does.
- `--delete-branch`, `--match-head-commit`, the detail drawer, the review strip, and one-Merge-row-per-PR. See the spec's *Deferred* section.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/types.ts` | Modify | `MergeMethod` type; `deck:mergePr` inbound and `deck:mergeDone` outbound messages; optional `mergeWrites` on `deck:runs`. |
| `src/engine/bucket.ts` | Modify | `MergeTarget` + `mergeTarget()` — the pure predicate. Stays `fs`-free and imports only `../types`. |
| `src/engine/pr/provider.ts` | Modify | `merge()` on the `PrProvider` interface; `MERGE_FLAG`; `GhProvider.merge`; `stripCommandLine` moved here and exported. |
| `src/engine/review/provider.ts` | Modify | Imports `stripCommandLine` from `../pr/provider` instead of declaring it. Behaviour unchanged. |
| `src/engine/pr/glab/provider.ts` | Modify | `GlabProvider.merge` via `glab api --method PUT`. |
| `src/config.ts` | Modify | `mergeWrites` and `mergeMethod` on `AgentFlowConfig` + `getConfig()`. |
| `package.json` | Modify | The two settings; reword `agentFlow.reviewWrites`' now-false description. |
| `src/telemetry/settingsSnapshot.ts` | Modify | The two new snapshot fields (imports `MERGE_METHODS` from `../config`). |
| `src/telemetry/events.ts` | Modify | The two new settings-snapshot properties. |
| `src/deckView.ts` | Modify | The `deck:mergePr` handler; `mergeWrites` on the `deck:runs` post. |
| `src/webview/deckSignal.ts` | Modify | `cardMerge()` — the webview's one entry point to the predicate. |
| `src/webview/DeckApp.tsx` | Modify | The Merge row; `mergeWrites` state; `deck:mergeDone` disable release. |
| `src/webview/deckStyles.ts` | Modify | One rule: `.c-row .ok { color: var(--c-done); }`. |
| `docs/FORGES.md` | Modify | The merge row in *What GitLab cannot answer*. |
| `CHANGELOG.md` | Modify | The `## [Unreleased]` entry. |

Tests modified: `test/unit/engine/bucket.test.ts`, `test/unit/engine/pr/provider.test.ts`, `test/unit/engine/pr/glab/provider.test.ts`, `test/unit/config.test.ts`, `test/unit/telemetry/settingsSnapshot.test.ts`, `test/unit/deckView.test.ts`, `test/webview/deckSignal.test.ts`, `test/webview/DeckApp.test.tsx`.

---

## Task 1: The predicate

**Files:**
- Modify: `src/types.ts` (add `MergeMethod` beside `ReviewVerb`, currently line 357)
- Modify: `src/engine/bucket.ts` (append after `prSignals`, currently ends line 159)
- Test: `test/unit/engine/bucket.test.ts`

**Interfaces:**
- Consumes: `PrEntryMap`, `PrEntry`, `PrFacts` from `src/types.ts` (already exported).
- Produces:
  - `export type MergeMethod = "squash" | "merge" | "rebase"` in `src/types.ts`
  - `export interface MergeTarget { repo: string; number: number; url: string }` in `src/engine/bucket.ts`
  - `export function mergeTarget(prs: PrEntryMap): MergeTarget | null` in `src/engine/bucket.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/engine/bucket.test.ts`. The file's existing `prFacts()` and `entries()` helpers are at the top — reuse them; note `prFacts()` defaults `review: "none"` and `unresolved: null`, so a green PR must set both explicitly.

```ts
describe("mergeTarget", () => {
  const green = (over: Partial<PrFacts> = {}): PrFacts =>
    prFacts({ number: 124, url: "https://github.com/o/r/pull/124", review: "approved", unresolved: 0, ...over });

  it("names the one PR that is open, approved, green, thread-clear and clean", () => {
    expect(mergeTarget(entries(green()))).toEqual({
      repo: "repo0", number: 124, url: "https://github.com/o/r/pull/124",
    });
  });

  it("returns null when there are no PRs at all", () => {
    expect(mergeTarget({})).toBeNull();
  });

  it("returns null for a repo whose PR resolved to none", () => {
    expect(mergeTarget(entries(null))).toBeNull();
  });

  // Each of these is the ONLY thing wrong. Table-driven so a predicate that
  // forgets one clause fails on exactly that row.
  it.each([
    ["a closed PR", { state: "CLOSED" as const }],
    ["a merged PR", { state: "MERGED" as const }],
    ["a draft", { isDraft: true }],
    ["a failing check", { ci: { passing: 1, pending: 0, failing: [{ name: "lint", url: "" }] } }],
    ["a pending check", { ci: { passing: 1, pending: 1, failing: [] } }],
    ["review still required", { review: "review_required" as const }],
    ["changes requested", { review: "changes_requested" as const }],
    ["no review decision at all", { review: "none" as const }],
    ["an unresolved thread", { unresolved: 1 }],
    ["an unreadable thread count", { unresolved: null }],
    ["a conflicting merge state", { mergeable: "conflicting" as const }],
    ["an unknown merge state", { mergeable: "unknown" as const }],
    ["a blocked merge state", { mergeable: "blocked" as const }],
    ["a behind merge state", { mergeable: "behind" as const }],
  ])("withholds the target on %s", (_label, over) => {
    expect(mergeTarget(entries(green(over)))).toBeNull();
  });

  // ciAdvisory means the REQUIRED checks passed and something optional did not.
  // `prSignals.blocked` forgives that; this must not — the button promises
  // there is nothing left to look at, and an optional red is something to look at.
  it("withholds the target on an advisory failure, unlike prSignals.blocked", () => {
    const advisory = green({ ci: { passing: 4, pending: 0, failing: [{ name: "flaky-e2e", url: "" }] }, ciAdvisory: true });
    expect(prSignals(entries(advisory)).blocked).toBe(false);
    expect(mergeTarget(entries(advisory))).toBeNull();
  });

  it("withholds the target when the entry's last fetch failed, however green the facts look", () => {
    const stale: PrEntryMap = { svc: { facts: green(), fetchedAt: 0, error: true } };
    expect(mergeTarget(stale)).toBeNull();
  });

  it("withholds the target when two repos are both ready — a write must not pick one", () => {
    expect(mergeTarget(entries(green(), green({ number: 125 })))).toBeNull();
  });

  it("names the ready PR when every other PR-bearing repo has already merged", () => {
    const map: PrEntryMap = {
      api: { facts: green({ number: 900, url: "https://github.com/o/api/pull/900" }), fetchedAt: 1 },
      web: { facts: prFacts({ number: 800, state: "MERGED" }), fetchedAt: 1 },
    };
    expect(mergeTarget(map)).toEqual({ repo: "api", number: 900, url: "https://github.com/o/api/pull/900" });
  });

  it("withholds the target when another repo's PR is open but not ready", () => {
    const map: PrEntryMap = {
      api: { facts: green({ number: 900 }), fetchedAt: 1 },
      web: { facts: prFacts({ number: 800, review: "review_required" }), fetchedAt: 1 },
    };
    expect(mergeTarget(map)).toBeNull();
  });

  it("reads the target's own repo key, number and url — not the first entry's", () => {
    // Distinct values in a non-alphabetically-first repo: the only assertion that
    // catches an implementation returning entries[0] or a hardcoded field.
    const map: PrEntryMap = {
      alpha: { facts: prFacts({ number: 1, state: "MERGED" }), fetchedAt: 1 },
      zulu: { facts: green({ number: 4821, url: "https://github.com/acme/api/pull/4821" }), fetchedAt: 1 },
    };
    expect(mergeTarget(map)).toEqual({ repo: "zulu", number: 4821, url: "https://github.com/acme/api/pull/4821" });
  });
});
```

Add `mergeTarget` to the existing import at the top of the file:

```ts
import { deriveBucket, deriveLane, mergeTarget, prSignals } from "../../../src/engine/bucket";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/bucket.test.ts`
Expected: FAIL — `mergeTarget` is not exported (TypeScript / import error).

- [ ] **Step 3: Add `MergeMethod` to `src/types.ts`**

Insert immediately after the existing `ReviewVerb` line (`export type ReviewVerb = "approve" | "comment" | "request-changes";`):

```ts
/** How a merge is performed. One spelling shared by the `agentFlow.mergeMethod`
 * setting, the confirmation dialog, and each forge provider's flag map — a second
 * spelling anywhere is a merge strategy the user did not choose. */
export type MergeMethod = "squash" | "merge" | "rebase";
```

- [ ] **Step 4: Implement `mergeTarget` in `src/engine/bucket.ts`**

Extend the existing first-line import (it must stay the file's only import — `bucket.test.ts` asserts the specifier list is exactly `["../types"]`):

```ts
import { AgentState, DeckColumn, DeckLane, PrEntryMap, PrFacts } from "../types";
```

Append after `prSignals`:

```ts
/** The one PR a card may merge, named for the host that will do the merging. */
export interface MergeTarget {
  repo: string; // the PrEntryMap key — how the host finds the checkout
  number: number;
  url: string; // for the failure toast's "Open PR" action
}

/** Is every fact standing between this PR and its base branch green AND readable?
 *
 * Deliberately stricter than `prSignals.ready`, in two ways that matter:
 *
 *  - `unresolved === 0`, so `null` — the GraphQL/discussions call failed or was
 *    skipped — withholds the button. That is the exact case where "no comments
 *    open" is unproven, and it is the fact `ready` does not read at all.
 *  - No forgiveness for `ciAdvisory`. `prSignals.blocked` forgives a flaky
 *    optional check because it is not worth pinning a card in Action required;
 *    this cannot, because the button promises there is nothing left to look at.
 *
 * Every unknown fails, matching the rule `branchCi` already states for itself:
 * "unknown" is NOT green. `review === "none"` fails too — on GitHub it covers
 * both "no reviewers required" and "nobody has reviewed yet", and `PrFacts`
 * cannot tell them apart, so treating it as approved would put a Merge button on
 * an unreviewed PR.
 */
function isMergeReady(f: PrFacts): boolean {
  return (
    f.state === "OPEN" &&
    !f.isDraft &&
    f.ci.failing.length === 0 &&
    f.ci.pending === 0 &&
    f.review === "approved" &&
    f.unresolved === 0 &&
    f.mergeable === "clean"
  );
}

/**
 * The single PR this run can merge right now, or null.
 *
 * `prSignals.ready` is NOT reused: it drives column placement, so tightening it
 * would move existing users' cards between columns on upgrade. The two are
 * allowed to disagree — a card can sit in the Merge column's `ready` lane with
 * no Merge button (unreadable review threads, say). That is the honest pair: the
 * lane says "nothing looks wrong", the button says "I can prove nothing is wrong".
 *
 * Exactly ONE ready PR, and every other PR-bearing repo already merged. Not a
 * "lead PR" like `cardActions` picks: that function's buttons only seed a
 * session, so an arbitrary choice among several is harmless, whereas merging one
 * half of a coupled pair of PRs on a single click is the specific mistake worth
 * designing out. A card with two ready PRs therefore gets nothing.
 *
 * An entry whose last fetch failed (`error: true`) is refused outright: those
 * facts are the PREVIOUS value carried forward, and stale facts do not authorize
 * a write however green they look. Pure.
 */
export function mergeTarget(prs: PrEntryMap): MergeTarget | null {
  const withFacts = Object.entries(prs)
    .map(([repo, e]) => ({ repo, facts: e.facts, failed: e.error === true }))
    .filter((x): x is { repo: string; facts: PrFacts; failed: boolean } => x.facts !== null);
  const ready = withFacts.filter((x) => !x.failed && isMergeReady(x.facts));
  // `!== 1` covers both "nothing to merge" and "two, and picking is not ours".
  if (ready.length !== 1) return null;
  const rest = withFacts.filter((x) => x.repo !== ready[0].repo);
  if (!rest.every((x) => x.facts.state === "MERGED")) return null;
  return { repo: ready[0].repo, number: ready[0].facts.number, url: ready[0].facts.url };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/bucket.test.ts`
Expected: PASS, all tests in the file — including the pre-existing `"imports nothing but ../types"` guard.

- [ ] **Step 6: Mutation-check the predicate**

The predicate is the whole gate; a vacuous test here ships a Merge button on a red PR. Verify the tests bite, one clause at a time:

```bash
cd /Users/oznasi/dev/agent-flow-merge-button
# 1. Drop the unresolved clause — the clause `prSignals.ready` does not have.
sed -i '' 's/    f.unresolved === 0 &&/    true \&\&/' src/engine/bucket.ts
npx vitest run test/unit/engine/bucket.test.ts   # MUST FAIL
git checkout src/engine/bucket.ts
# 2. Allow two ready PRs.
sed -i '' 's/if (ready.length !== 1) return null;/if (ready.length === 0) return null;/' src/engine/bucket.ts
npx vitest run test/unit/engine/bucket.test.ts   # MUST FAIL
git checkout src/engine/bucket.ts
```

Both mutants must fail. `git checkout` here is safe only because nothing in this task is uncommitted yet — do not run a mutation check over an uncommitted fix.

- [ ] **Step 7: Typecheck and commit**

```bash
cd /Users/oznasi/dev/agent-flow-merge-button
npm run typecheck
git add src/types.ts src/engine/bucket.ts test/unit/engine/bucket.test.ts
git commit -m "feat(deck): a predicate for the one PR a card can merge"
```

---

## Task 2: `GhProvider.merge`

**Files:**
- Modify: `src/engine/pr/provider.ts`
- Modify: `src/engine/review/provider.ts` (import `stripCommandLine` instead of declaring it)
- Test: `test/unit/engine/pr/provider.test.ts`

**Interfaces:**
- Consumes: `MergeMethod` from `src/types.ts` (Task 1); the existing `Runner`, `Locate`, `GH_TIMEOUT_MS` from this file.
- Produces:
  - `merge(repoPath: string, number: number, method: MergeMethod): Promise<{ ok: true } | { ok: false; message: string }>` on the `PrProvider` interface — Task 3 implements it for GitLab, Task 5 calls it.
  - `export function stripCommandLine(message: string): string` from `src/engine/pr/provider.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/engine/pr/provider.test.ts`. Reuse the file's existing `GH` constant, `provider()` factory and `scripted()` helper from the top of the file.

```ts
describe("GhProvider.merge", () => {
  it.each([
    ["squash", "--squash"],
    ["merge", "--merge"],
    ["rebase", "--rebase"],
  ] as const)("merges with %s in the repo directory", async (method, flag) => {
    const { run, calls } = scripted("");
    const out = await provider(run).merge("/r/api", 4821, method);

    expect(out).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe(GH);
    // cwd, not --repo: a card's PR is a local checkout, exactly as fetch() treats it.
    expect(calls[0].cwd).toBe("/r/api");
    // Full argv, not toContain(flag): pinning it exactly is the only thing that
    // catches a swapped strategy, and the wrong strategy rewrites someone's history.
    expect(calls[0].args).toEqual(["pr", "merge", "4821", flag]);
  });

  it("threads the given number, not a hardcoded one", async () => {
    // Every other test here uses 4821; a distinct number is the only assertion
    // that catches an implementation ignoring its parameter.
    const { run, calls } = scripted("");
    await provider(run).merge("/r/web", 7, "squash");
    expect(calls[0].args).toEqual(["pr", "merge", "7", "--squash"]);
    expect(calls[0].cwd).toBe("/r/web");
  });

  it.each(["Squash", "constructor"] as const)("refuses an out-of-union method (%s) before spawning", async (method) => {
    // "constructor" is the adversarial case: `!MERGE_FLAG[method]` would see
    // Object.prototype.constructor as truthy and sail through into argv. Only
    // Object.hasOwn refuses it. `agentFlow.mergeMethod` is a settings.json string,
    // so this is a real input, not a hypothetical.
    const { run, calls } = scripted("");
    const out = await provider(run).merge("/r/api", 4821, method as unknown as MergeMethod);
    expect(out).toEqual({ ok: false, message: `Unknown merge method: ${method}` });
    expect(calls).toHaveLength(0);
  });

  it("prefers stderr — GitHub's own wording — over the reconstructed command line", async () => {
    const err = Object.assign(
      new Error("Command failed: gh pr merge 4821 --squash\nPull request is not mergeable: the merge commit cannot be cleanly created."),
      { stderr: "Pull request is not mergeable: the merge commit cannot be cleanly created." },
    );
    const { run } = scripted(err);
    const out = await provider(run).merge("/r/api", 4821, "squash");
    expect(out).toEqual({
      ok: false,
      message: "Pull request is not mergeable: the merge commit cannot be cleanly created.",
    });
    if (!out.ok) expect(out.message).not.toContain("Command failed");
  });

  it("never returns the raw command line when the rejection carries no stderr", async () => {
    const err = new Error("Command failed: gh pr merge 4821 --squash\n");
    const { run } = scripted(err);
    const out = await provider(run).merge("/r/api", 4821, "squash");
    expect(out).toEqual({ ok: false, message: "gh failed without further detail — check the PR directly." });
  });

  it.each([
    ["killed", { killed: true }],
    ["code ETIMEDOUT", { code: "ETIMEDOUT" }],
  ])("returns wording that does not claim GitHub refused, on a %s rejection", async (_label, shape) => {
    // A merge is not idempotent and the 10s clock can expire AFTER GitHub
    // committed. "GitHub refused" here would be a lie about a write that landed,
    // and would invite a retry.
    const err = Object.assign(new Error("Command failed: gh pr merge 4821 --squash"), shape);
    const { run } = scripted(err);
    const out = await provider(run).merge("/r/api", 4821, "squash");
    expect(out).toEqual({
      ok: false,
      message: `Timed out after ${GH_TIMEOUT_MS / 1000}s — the merge may already have gone through. Open the PR to check.`,
    });
    if (!out.ok) expect(out.message).not.toMatch(/refused|failed to merge/i);
  });
});
```

Extend the file's imports:

```ts
import { GhProvider, probeGh, PR_JSON_FIELDS, GH_TIMEOUT_MS } from "../../../../src/engine/pr/provider";
import type { Runner } from "../../../../src/engine/pr/provider";
import type { MergeMethod } from "../../../../src/types";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/pr/provider.test.ts`
Expected: FAIL — `merge` does not exist on `GhProvider`.

- [ ] **Step 3: Move `stripCommandLine` into `src/engine/pr/provider.ts`**

`src/engine/review/provider.ts` declares this function privately; `GhProvider` needs the same fallback and duplicating it would let the two drift. Move it, don't copy it.

Delete the whole `function stripCommandLine(...)` declaration **and its doc comment** from `src/engine/review/provider.ts`, and add `stripCommandLine` to that file's existing import from `../pr/provider`:

```ts
import { execRunner, GH_TIMEOUT_MS, Locate, Runner, stripCommandLine, THREADS_QUERY } from "../pr/provider";
```

Add to `src/engine/pr/provider.ts`, after `execRunner` and before the `PrProvider` interface:

```ts
/** Node's execFile error `.message` is always `Command failed: <file> <full argv
 * joined>`, optionally followed by a `\n` and stderr's own text. Used only when a
 * rejection carries no `stderr` of its own (a killed process, or a CLI failure
 * that wrote nothing to stderr): keeps whatever follows the first newline, and
 * falls back to a fixed, argv-free string when there is nothing there — never the
 * reconstructed command.
 *
 * Lives here rather than in `../review/provider.ts`, which used to own it
 * privately: `GhProvider.merge` needs the identical fallback, and two copies of
 * the last line of defense against leaking an argv is one copy too many. The
 * review path's own reason for needing it is stronger — its argv carries `--body
 * <the whole review text>` — so do not weaken this while touching the merge path. */
export function stripCommandLine(message: string): string {
  const nl = message.indexOf("\n");
  const rest = nl === -1 ? "" : message.slice(nl + 1).trim();
  return rest || "gh failed without further detail — check the PR directly.";
}
```

- [ ] **Step 4: Verify the move changed no behaviour**

Run: `npx vitest run test/unit/engine/review/provider.test.ts`
Expected: PASS, **unmodified** — that file has four tests pinning `stripCommandLine`'s exact output through `submit()`. They are the proof the move was behaviour-preserving. If any fails, the move was wrong; revert and redo it.

- [ ] **Step 5: Add `merge` to the interface and implement it**

In `src/engine/pr/provider.ts`, extend the imports and the interface:

```ts
import { MergeMethod, PrFacts } from "../../types";
```

```ts
/** The flags `gh pr merge` accepts, verified against gh 2.89.0 (`gh pr merge
 * --help`): `-s/--squash`, `-m/--merge`, `-r/--rebase`. gh refuses to run
 * non-interactively without one of them, which is why `agentFlow.mergeMethod`
 * exists rather than a "let the forge decide" default. */
const MERGE_FLAG: Record<MergeMethod, string> = {
  squash: "--squash",
  merge: "--merge",
  rebase: "--rebase",
};

export interface PrProvider {
  fetch(repoPath: string, branch: string | null, key: string): Promise<FetchResult>;
  /** Merge this repo's PR. The ONLY method on this seam that writes to the forge:
   * the caller confirms with the user first, and this refuses only what the forge
   * would refuse anyway, reporting the forge's own wording. */
  merge(repoPath: string, number: number, method: MergeMethod): Promise<{ ok: true } | { ok: false; message: string }>;
}
```

Add to `class GhProvider`:

```ts
  /** `cwd: repoPath` and no `--repo`, matching `fetch`: a card's PR is a local
   * checkout, and gh resolves the repository from that directory's git remote —
   * never from Agent Flow's name for the checkout, which routinely differs (this
   * product's own worktrees are directories like `bite-me-3a`).
   *
   * `method` is not to be trusted just because the type says `MergeMethod`: it
   * originates in `agentFlow.mergeMethod`, a settings.json string that can be
   * anything, including a prototype key. `Object.hasOwn` — not
   * `!MERGE_FLAG[method]`, which `"constructor"` sails through as truthy — fails
   * closed before a single argv is built. The one command in this extension that
   * merges to a default branch does not get to guess. */
  async merge(
    repoPath: string,
    number: number,
    method: MergeMethod,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    if (!Object.hasOwn(MERGE_FLAG, method)) {
      return { ok: false, message: `Unknown merge method: ${String(method)}` };
    }
    try {
      await this.run(this.locate() ?? "gh", ["pr", "merge", String(number), MERGE_FLAG[method]], {
        cwd: repoPath,
        timeoutMs: GH_TIMEOUT_MS,
      });
      return { ok: true };
    } catch (e) {
      const err = e as { killed?: boolean; code?: unknown; stderr?: string };
      // A killed-by-timeout rejection has the same shape as any other execFile
      // failure and means something different: gh may well have reached GitHub
      // before the clock ran out. A merge is not idempotent, so "GitHub refused"
      // would be a lie about a write that could have landed — and would invite a
      // retry that merges twice.
      if (err.killed || err.code === "ETIMEDOUT") {
        return {
          ok: false,
          message: `Timed out after ${GH_TIMEOUT_MS / 1000}s — the merge may already have gone through. Open the PR to check.`,
        };
      }
      // stderr is GitHub's actual wording, attached by execRunner separately from
      // `.message` — which is the reconstructed argv. Prefer it.
      return { ok: false, message: err.stderr?.trim() || (e instanceof Error ? stripCommandLine(e.message) : String(e)) };
    }
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/pr/provider.test.ts test/unit/engine/review/provider.test.ts`
Expected: PASS both files.

- [ ] **Step 7: Typecheck and commit**

`typecheck` will now report `GlabProvider` does not implement `PrProvider` — that is Task 3, and expected. Confirm that is the **only** new error before continuing.

```bash
cd /Users/oznasi/dev/agent-flow-merge-button
npm run typecheck 2>&1 | head -20
git add src/engine/pr/provider.ts src/engine/review/provider.ts test/unit/engine/pr/provider.test.ts
git commit -m "feat(forge): merge a PR through gh, behind the PrProvider seam"
```

---

## Task 3: `GlabProvider.merge`

**Files:**
- Modify: `src/engine/pr/glab/provider.ts`
- Test: `test/unit/engine/pr/glab/provider.test.ts`

**Interfaces:**
- Consumes: `merge(repoPath, number, method)` on `PrProvider` (Task 2); `GLAB_TIMEOUT_MS` from this file.
- Produces: nothing new — it satisfies the interface Task 2 declared.

**Why the REST API and not `glab mr merge`:** this provider already does everything through `glab api`, and GitLab's `PUT /projects/:id/merge_requests/:iid/merge` is fully documented, so the argv can be specified exactly here. `glab mr merge`'s flags could not be — `glab` is not installed on the authoring machine. The API also makes GitLab's real limit explicit rather than guessed: `squash` is the **only** per-request override. Whether a merge is rebased or gets a merge commit is the project's own `merge_method` setting, so `"rebase"` is not expressible per request and must be refused in words rather than silently substituted.

- [ ] **Step 1: Write the failing tests**

Open `test/unit/engine/pr/glab/provider.test.ts` and reuse whatever `Runner`/locate helpers it already defines at the top (they mirror the gh file's `scripted()`). Append:

```ts
describe("GlabProvider.merge", () => {
  it("squashes through the merge endpoint, in the repo directory", async () => {
    const { run, calls } = scripted("{}");
    const out = await provider(run).merge("/r/api", 4821, "squash");

    expect(out).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].cwd).toBe("/r/api");
    // `projects/:fullpath` is glab's own placeholder, resolved from the git remote
    // of the directory the call runs in — never from Agent Flow's name for the
    // checkout. `-F` (not `-f`) so `true`/`false` reach GitLab as a JSON boolean
    // rather than the string "true"; no user-authored text goes through this flag,
    // so `-F`'s leading-`@`-is-a-filename behaviour cannot bite here.
    expect(calls[0].args).toEqual([
      "api", "projects/:fullpath/merge_requests/4821/merge", "--method", "PUT", "-F", "squash=true",
    ]);
  });

  it("sends squash=false for a plain merge, leaving the commit shape to the project setting", async () => {
    const { run, calls } = scripted("{}");
    const out = await provider(run).merge("/r/api", 4821, "merge");
    expect(out).toEqual({ ok: true });
    expect(calls[0].args).toEqual([
      "api", "projects/:fullpath/merge_requests/4821/merge", "--method", "PUT", "-F", "squash=false",
    ]);
  });

  it("threads the given number, not a hardcoded one", async () => {
    const { run, calls } = scripted("{}");
    await provider(run).merge("/r/web", 7, "squash");
    expect(calls[0].args[1]).toBe("projects/:fullpath/merge_requests/7/merge");
    expect(calls[0].cwd).toBe("/r/web");
  });

  it("refuses rebase in words rather than substituting another strategy, before spawning", async () => {
    // GitLab's merge API has no per-request rebase: the project's Merge method
    // setting decides. Silently sending squash=false here would merge a way the
    // user did not choose — the worst possible degradation for this seam.
    const { run, calls } = scripted("{}");
    const out = await provider(run).merge("/r/api", 4821, "rebase");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.message).toContain("rebase");
      expect(out.message).toContain("agentFlow.mergeMethod");
    }
    expect(calls).toHaveLength(0);
  });

  it.each(["Squash", "constructor"] as const)("refuses an out-of-union method (%s) before spawning", async (method) => {
    const { run, calls } = scripted("{}");
    const out = await provider(run).merge("/r/api", 4821, method as unknown as MergeMethod);
    expect(out).toEqual({ ok: false, message: `Unknown merge method: ${method}` });
    expect(calls).toHaveLength(0);
  });

  it("prefers stderr — GitLab's own wording — over the reconstructed command line", async () => {
    const err = Object.assign(
      new Error("Command failed: glab api projects/:fullpath/merge_requests/4821/merge --method PUT -F squash=true\nPOST https://gitlab.com/api/v4/...: 405 {message: Method Not Allowed}"),
      { stderr: "405 {message: Method Not Allowed}" },
    );
    const { run } = scripted(err);
    const out = await provider(run).merge("/r/api", 4821, "squash");
    expect(out).toEqual({ ok: false, message: "405 {message: Method Not Allowed}" });
    if (!out.ok) expect(out.message).not.toContain("Command failed");
  });

  it("never returns the raw command line when the rejection carries no stderr", async () => {
    const { run } = scripted(new Error("Command failed: glab api projects/:fullpath/merge_requests/4821/merge --method PUT"));
    const out = await provider(run).merge("/r/api", 4821, "squash");
    expect(out).toEqual({
      ok: false,
      message: "glab failed without further detail — check the merge request directly.",
    });
  });

  it.each([
    ["killed", { killed: true }],
    ["code ETIMEDOUT", { code: "ETIMEDOUT" }],
  ])("returns wording that does not claim GitLab refused, on a %s rejection", async (_label, shape) => {
    const err = Object.assign(new Error("Command failed: glab api ... --method PUT"), shape);
    const { run } = scripted(err);
    const out = await provider(run).merge("/r/api", 4821, "squash");
    expect(out).toEqual({
      ok: false,
      message: `Timed out after ${GLAB_TIMEOUT_MS / 1000}s — the merge may already have gone through. Open the merge request to check.`,
    });
    if (!out.ok) expect(out.message).not.toMatch(/refused/i);
  });
});
```

If that file's helpers are named differently, rename the calls above to match — do **not** add a second copy of a helper it already has. Import `GLAB_TIMEOUT_MS` from `../../../../../src/engine/pr/glab/provider` and `MergeMethod` from `../../../../../src/types` (check the file's existing relative depth and match it).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/pr/glab/provider.test.ts`
Expected: FAIL — `merge` does not exist on `GlabProvider`.

- [ ] **Step 3: Implement it**

Add to `src/engine/pr/glab/provider.ts`. Put the path helper beside the file's five existing ones (`mrListPath`, `mrShowPath`, …), keeping their module-private style:

```ts
/** The one write route this provider has. `PUT …/merge` is the only endpoint that
 * merges; `squash` is the only strategy it takes per request. */
const mrMergePath = (iid: number): string =>
  `projects/:fullpath/merge_requests/${iid}/merge`;
```

Add `MergeMethod` to the file's existing `../../../types` import, and add to `class GlabProvider`:

```ts
  /** GitLab's merge API takes exactly one strategy override: `squash`. Whether a
   * non-squashed merge is rebased, fast-forwarded, or gets a merge commit is the
   * PROJECT's `merge_method` setting, not something a request can ask for — so
   * `"rebase"` is refused in words. Substituting `squash=false` for it would merge
   * a way the user did not choose, which is exactly the fake this seam forbids.
   * See docs/FORGES.md.
   *
   * No `Object.hasOwn` map here, unlike the gh side: the two accepted values are
   * compared literally, which is prototype-safe by construction — `"constructor"`
   * matches neither branch and falls through to the refusal below. */
  async merge(
    repoPath: string,
    number: number,
    method: MergeMethod,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    if (method === "rebase") {
      return {
        ok: false,
        message:
          "GitLab has no per-request rebase merge — a project's own Merge method setting decides that. " +
          "Set agentFlow.mergeMethod to squash or merge, or merge from GitLab.",
      };
    }
    if (method !== "squash" && method !== "merge") {
      return { ok: false, message: `Unknown merge method: ${String(method)}` };
    }
    try {
      // `-F`, not GLAB_FIELD_FLAG (`-f`): this value must reach GitLab as a JSON
      // boolean, not the string "true". `-F`'s leading-`@`-is-a-filename hazard,
      // which is why the review body uses `-f`, cannot apply to a literal
      // true/false that no user ever typed.
      await this.run(
        this.locate() ?? "glab",
        ["api", mrMergePath(number), "--method", "PUT", "-F", `squash=${method === "squash"}`],
        { cwd: repoPath, timeoutMs: GLAB_TIMEOUT_MS },
      );
      return { ok: true };
    } catch (e) {
      const err = e as { killed?: boolean; code?: unknown; stderr?: string };
      // Same reasoning as the gh side: glab may have reached GitLab before the
      // clock ran out, and a merge is not idempotent.
      if (err.killed || err.code === "ETIMEDOUT") {
        return {
          ok: false,
          message: `Timed out after ${GLAB_TIMEOUT_MS / 1000}s — the merge may already have gone through. Open the merge request to check.`,
        };
      }
      // stderr is GitLab's actual wording. Never `.message`, which is the
      // reconstructed argv — the same rule GlabReviewProvider.submit states.
      return {
        ok: false,
        message: err.stderr?.trim() || "glab failed without further detail — check the merge request directly.",
      };
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/pr/glab/provider.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
cd /Users/oznasi/dev/agent-flow-merge-button
npm run typecheck
git add src/engine/pr/glab/provider.ts test/unit/engine/pr/glab/provider.test.ts
git commit -m "feat(forge): merge an MR through glab, refusing rebase in words"
```

`npm run typecheck` must now be clean.

---

## Task 4: The two settings, shipped inert

**Files:**
- Modify: `src/config.ts` (`AgentFlowConfig` near `reviewWrites`, currently line 454; `getConfig()` near line 708)
- Modify: `package.json` (`contributes.configuration.properties`, beside `agentFlow.reviewWrites` at line 672)
- Modify: `src/telemetry/settingsSnapshot.ts` (the snapshot fields near line 121; imports `MERGE_METHODS` from `../config`)
- Modify: `src/telemetry/events.ts` (the settings-snapshot property list, near `review_writes` at line 156)
- Test: `test/unit/config.test.ts`, `test/unit/telemetry/settingsSnapshot.test.ts`

**Interfaces:**
- Consumes: `MergeMethod` from `src/types.ts` (Task 1).
- Produces: `getConfig().mergeWrites: boolean` and `getConfig().mergeMethod: MergeMethod`, read by Task 5; `MERGE_METHODS` exported from `src/config.ts`.

**One deliberate edit to an existing test.** `test/unit/config.test.ts` has a test titled *"declares reviewWrites defaulting to false — the only setting that writes to GitHub"*. That claim stops being true here. **Its assertion is not touched** — only the title, and only because leaving a knowingly-false statement in the suite is worse. Step 6 covers it. Nothing else in an existing test may change.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/config.test.ts`, in the same `describe` block as the existing `reviewWrites` tests (find them by searching for `honors an explicit reviewWrites override`):

```ts
  it("defaults mergeWrites off and mergeMethod to squash", () => {
    const c = getConfig();
    expect(c.mergeWrites).toBe(false);
    expect(c.mergeMethod).toBe("squash");
  });

  it("honors explicit mergeWrites and mergeMethod overrides", () => {
    setConfig({ mergeWrites: true, mergeMethod: "rebase" });
    expect(getConfig().mergeWrites).toBe(true);
    expect(getConfig().mergeMethod).toBe("rebase");
  });

  it("falls back to squash on a hand-edited mergeMethod", () => {
    // settings.json is a text file. An unrecognised value must not reach argv as
    // itself — the provider refuses it too, but the config layer should not hand
    // one down in the first place.
    setConfig({ mergeMethod: "fast-forward" as never });
    expect(getConfig().mergeMethod).toBe("squash");
  });
```

And in the manifest-defaults block (beside the existing `declares reviewWrites defaulting to false` test):

```ts
  // Same reasoning as the reviewWrites default above: getConfig()'s own `?? false`
  // only exercises the vscode mock's unset-key behaviour, never the manifest
  // default a real VS Code install serves. A `"default": true` typo here would
  // ship the only path in this extension that merges to a default branch switched
  // on, and every getConfig() test would stay green.
  it("declares mergeWrites defaulting to false — the only setting that merges", () => {
    expect(props["agentFlow.mergeWrites"].default).toBe(false);
  });

  it("declares mergeMethod defaulting to squash, over exactly the three strategies", () => {
    const m = props["agentFlow.mergeMethod"] as { default?: unknown; enum?: unknown };
    expect(m.default).toBe("squash");
    expect(m.enum).toEqual(["squash", "merge", "rebase"]);
  });
```

Append to `test/unit/telemetry/settingsSnapshot.test.ts`, matching the existing manifest-parity tests (search for `props["agentFlow.worktree"].enum`):

```ts
  it("keeps MERGE_METHODS in step with the manifest enum", () => {
    expect([...MERGE_METHODS]).toEqual(props["agentFlow.mergeMethod"].enum);
  });
```

Import `MERGE_METHODS` from `../../../src/config` in that test file — not from `settingsSnapshot`; see Step 3 for why it lives in config.ts.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/config.test.ts test/unit/telemetry/settingsSnapshot.test.ts`
Expected: FAIL — `mergeWrites`/`mergeMethod` are not on the config, and `agentFlow.mergeMethod` is not in the manifest.

- [ ] **Step 3: Add the settings to `src/config.ts`**

Add `MergeMethod` to the file's existing import from `./types`. Then, in `AgentFlowConfig`, immediately after `reviewWrites: boolean;`:

```ts
  /** Allow merging a green PR from a Deck card. Off by default, for the same
   * reason as `reviewWrites` and `orchestrator`: the feature writes on your
   * behalf, so nothing about it appears until you ask for it. */
  mergeWrites: boolean;
  /** Which strategy a card's Merge button uses. Exists because `gh pr merge`
   * refuses to run non-interactively without an explicit one — there is no
   * "let the forge decide" to fall back on. The confirmation dialog names the
   * resolved value, so this setting can never merge a way you did not see. */
  mergeMethod: MergeMethod;
```

And in `getConfig()`, immediately after the `reviewWrites:` line:

```ts
    mergeWrites: c.get<boolean>("mergeWrites") ?? false,
    // `|| "squash"`, the same shape as `worktree` above: an empty or missing value
    // takes the default. A hand-edited garbage value also lands on the default
    // here, and each provider's own method guard refuses anything out-of-union
    // besides — a merge strategy is not something to fail open on.
    mergeMethod: MERGE_METHODS.includes(c.get<string>("mergeMethod") as MergeMethod)
      ? (c.get<string>("mergeMethod") as MergeMethod)
      : "squash",
```

`MERGE_METHODS` lives in **`src/config.ts`**, not beside `WORKTREE_MODES` in `settingsSnapshot.ts`. Verified: `settingsSnapshot.ts` already imports `AgentFlowConfig` and four other names from `../config`, so importing it the other way would be a cycle. Declare it in `src/config.ts` above `getConfig()`:

```ts
/** The three merge strategies, as a value so both `getConfig()`'s fallback and the
 * telemetry snapshot's allowlist derive from one list. Here rather than beside
 * `WORKTREE_MODES` in `telemetry/settingsSnapshot.ts` because that module already
 * imports from this one — the reverse direction would be a cycle. */
export const MERGE_METHODS = ["squash", "merge", "rebase"] as const satisfies readonly MergeMethod[];
```

- [ ] **Step 4: Add the manifest entries**

In `package.json`, insert directly after the `agentFlow.reviewWrites` block:

```json
        "agentFlow.mergeWrites": {
          "type": "boolean",
          "default": false,
          "markdownDescription": "Show a **Merge** button on a Deck card when its pull request is provably ready — approved, every check green, no unresolved review threads, and mergeable cleanly. Off by default: this is the only setting that lets Agent Flow Deck merge. Every merge still asks for confirmation, and names the strategy from `#agentFlow.mergeMethod#`. A card with two ready pull requests shows no button — merging one of a pair on a single click is not something this decides for you."
        },
        "agentFlow.mergeMethod": {
          "type": "string",
          "enum": ["squash", "merge", "rebase"],
          "default": "squash",
          "markdownDescription": "Which strategy a card's **Merge** button uses. Named in the confirmation dialog every time, so you always see it before the merge. Under `#agentFlow.forge#: gitlab` only `squash` and `merge` can be expressed per request — GitLab's own project **Merge method** setting decides whether a merge is rebased — so `rebase` is refused with a message rather than quietly merging another way. See [docs/FORGES.md](https://github.com/oznasi1/agent-flow/blob/main/docs/FORGES.md)."
        },
```

Then reword the now-false claim in `agentFlow.reviewWrites`' own description — replace `this is the only setting that lets Agent Flow Deck write to GitHub.` with:

```
this is one of two settings that let Agent Flow Deck write to GitHub, alongside `#agentFlow.mergeWrites#`.
```

- [ ] **Step 5: Add the settings to the telemetry snapshot**

Add `MERGE_METHODS` to `src/telemetry/settingsSnapshot.ts`'s **existing** import block from `../config` (the one that already brings in `AgentFlowConfig`, `DEFAULT_ENVIRONMENTS`, …) — do not declare a second copy here.

In the snapshot object, immediately after `review_writes: cfg.reviewWrites,`:

```ts
    merge_writes: cfg.mergeWrites,
    merge_method: enumOrInvalid(cfg.mergeMethod, MERGE_METHODS),
```

In `src/telemetry/events.ts`, immediately after `review_writes: boolean;`:

```ts
  merge_writes: boolean;
  merge_method: "squash" | "merge" | "rebase" | "invalid";
```

This adds no new **event** — only two properties on the settings snapshot that already ships, which is what every other setting does.

- [ ] **Step 6: Correct the stale test title (title only)**

In `test/unit/config.test.ts`, change only the string in that one `it(...)`:

```ts
  it("declares reviewWrites defaulting to false — one of the two settings that write to GitHub", () => {
    expect(props["agentFlow.reviewWrites"].default).toBe(false);
  });
```

The assertion is byte-identical. This is the one and only edit to a pre-existing test in this plan besides the fixture additions in Task 5 — if you find yourself changing any other existing test, stop and ask.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/unit/config.test.ts test/unit/telemetry/settingsSnapshot.test.ts test/unit/compat.test.ts`
Expected: PASS all three. `compat.test.ts` must pass **unmodified** — it checks settings with `toContain` (additive-safe) and freezes only the **command** list by set equality, and this task adds no command.

- [ ] **Step 8: Typecheck and commit**

```bash
cd /Users/oznasi/dev/agent-flow-merge-button
npm run typecheck
git add src/config.ts package.json src/telemetry/settingsSnapshot.ts src/telemetry/events.ts test/unit/config.test.ts test/unit/telemetry/settingsSnapshot.test.ts
git commit -m "feat(config): agentFlow.mergeWrites and mergeMethod, both inert by default"
```

---

## Task 5: The host handler

**Files:**
- Modify: `src/types.ts` (inbound message near line 631; outbound near line 815; `deck:runs` near line 756)
- Modify: `src/deckView.ts` (an in-flight set near line 344; the handler; the `deck:runs` post near line 2878; the message switch near line 3026)
- Test: `test/unit/deckView.test.ts`

**Interfaces:**
- Consumes: `mergeTarget` from `src/engine/bucket.ts` (Task 1); `forge.prs.merge` (Tasks 2–3); `getConfig().mergeWrites` / `.mergeMethod` (Task 4); the existing `readPrEntries`, `writePrEntry`, `defaultPrFactsDir` from `src/engine/pr/store`; `this.run(key)`, `this.post`, `this.toast`, `this.log`, `runKind`.
- Produces:
  - inbound `{ type: "deck:mergePr"; key: string; repo: string; number: number }`
  - outbound `{ type: "deck:mergeDone"; key: string; repo: string; number: number; outcome: "ok" | "failed" | "cancelled" }`
  - `mergeWrites?: boolean` on `deck:runs` — Task 6 reads it.

**Two fixture additions to `test/unit/deckView.test.ts`.** Both are required for the new tests to run at all, and neither touches an assertion:
1. The `vi.mock("../../src/engine/pr/provider")` factory replaces `GhProvider` with `class { fetch = h.prFetch; }`. It needs `merge = h.prMerge;` or the handler calls `undefined`.
2. The `vi.mock("../../src/config")` factory returns a hand-written object literal. It needs `mergeWrites: h.mergeWrites` and `mergeMethod: h.mergeMethod` so tests can steer the settings the way they steer `reviewWrites`.

- [ ] **Step 1: Write the failing tests**

In the `vi.hoisted` block at the top of `test/unit/deckView.test.ts`, beside `reviewWrites`, add:

```ts
  mergeWrites: false as boolean,
  mergeMethod: "squash" as "squash" | "merge" | "rebase",
  prMerge: vi.fn(async (_p: string, _n: number, _m: string) => ({ ok: true }) as { ok: true } | { ok: false; message: string }),
```

Add `merge = h.prMerge;` to the mocked `GhProvider` class, and `mergeWrites: h.mergeWrites, mergeMethod: h.mergeMethod,` to the mocked `getConfig()` literal. In the file's `beforeEach`, reset them alongside the other `h` fields:

```ts
  h.mergeWrites = false;
  h.mergeMethod = "squash";
  h.prMerge.mockClear().mockResolvedValue({ ok: true });
```

Then append a new describe block. Follow the file's existing conventions for building a panel and firing a message — copy the setup shape from the `describe("review submit")` block rather than inventing one; `p._fire(...)` is how a webview message is delivered, `window.showWarningMessage` is the mocked modal, and `readPrEntries`/`writePrEntry` operate on a temp dir the file already sets up.

```ts
describe("deck:mergePr", () => {
  /** A run with one repo whose PR is green by every clause mergeTarget checks. */
  const greenFacts = (): PrFacts => ({
    number: 124, url: "https://github.com/o/svc/pull/124", title: "t", state: "OPEN",
    isDraft: false, ci: { passing: 6, pending: 0, failing: [] }, review: "approved",
    unresolved: 0, mergeable: "clean", ciAdvisory: false,
  });

  it("does nothing when mergeWrites is off, however green the PR", async () => {
    h.mergeWrites = false;
    // ...seed a run whose PR facts are greenFacts(), open the panel...
    await p._fire({ type: "deck:mergePr", key: "PROJ-1", repo: "svc", number: 124 });
    expect(h.prMerge).not.toHaveBeenCalled();
    expect(window.showWarningMessage).not.toHaveBeenCalled();
  });

  it("does nothing for a key with no run record", async () => {
    h.mergeWrites = true;
    await p._fire({ type: "deck:mergePr", key: "NOPE-9", repo: "svc", number: 124 });
    expect(h.prMerge).not.toHaveBeenCalled();
  });

  it("does nothing for a local card, whose ticket is only inferred from a branch name", async () => {
    // Same guard, same reason, as seedPrWork's: a local card's key came from a
    // branch that may name someone else's ticket. Merging off that inference on
    // one click is what this must never do — and the host enforces it rather
    // than trusting the webview's own local check.
    h.mergeWrites = true;
    // ...seed a LOCAL run (runKind "local") with greenFacts()...
    await p._fire({ type: "deck:mergePr", key: localKey, repo: "svc", number: 124 });
    expect(h.prMerge).not.toHaveBeenCalled();
  });

  it("refuses when its own re-check disagrees with the message", async () => {
    // The webview is a renderer, never the authority for a write. Facts on disk
    // say review_required; a hand-crafted (or merely stale) message says merge.
    h.mergeWrites = true;
    // ...seed facts with review: "review_required"...
    await p._fire({ type: "deck:mergePr", key: "PROJ-1", repo: "svc", number: 124 });
    expect(h.prMerge).not.toHaveBeenCalled();
    expect(window.showWarningMessage).not.toHaveBeenCalled();
  });

  it("refuses when the message names a different repo or number than the re-check found", async () => {
    h.mergeWrites = true;
    // ...seed greenFacts() under repo "svc" as PR 124...
    await p._fire({ type: "deck:mergePr", key: "PROJ-1", repo: "svc", number: 999 });
    expect(h.prMerge).not.toHaveBeenCalled();
  });

  it("names the repo, number and strategy in the confirmation, and merges on confirm", async () => {
    h.mergeWrites = true;
    h.mergeMethod = "squash";
    vi.mocked(window.showWarningMessage).mockResolvedValue("Squash and merge");
    // ...seed greenFacts()...
    await p._fire({ type: "deck:mergePr", key: "PROJ-1", repo: "svc", number: 124 });

    const [message, opts] = vi.mocked(window.showWarningMessage).mock.calls[0];
    expect(message).toContain("svc#124");
    expect(message).toContain("Squash and merge");
    expect(opts).toMatchObject({ modal: true });
    expect(h.prMerge).toHaveBeenCalledWith("/r/svc", 124, "squash");
  });

  it("passes the configured strategy through, not a hardcoded squash", async () => {
    h.mergeWrites = true;
    h.mergeMethod = "rebase";
    vi.mocked(window.showWarningMessage).mockResolvedValue("Rebase and merge");
    // ...seed greenFacts()...
    await p._fire({ type: "deck:mergePr", key: "PROJ-1", repo: "svc", number: 124 });
    expect(h.prMerge).toHaveBeenCalledWith("/r/svc", 124, "rebase");
  });

  it("does not merge when the confirmation is declined, and releases the button", async () => {
    h.mergeWrites = true;
    vi.mocked(window.showWarningMessage).mockResolvedValue(undefined);
    // ...seed greenFacts()...
    await p._fire({ type: "deck:mergePr", key: "PROJ-1", repo: "svc", number: 124 });
    expect(h.prMerge).not.toHaveBeenCalled();
    expect(posted()).toContainEqual(
      expect.objectContaining({ type: "deck:mergeDone", key: "PROJ-1", repo: "svc", number: 124, outcome: "cancelled" }),
    );
  });

  it("toasts the forge's own wording with an Open PR action on failure", async () => {
    h.mergeWrites = true;
    vi.mocked(window.showWarningMessage).mockResolvedValue("Squash and merge");
    h.prMerge.mockResolvedValue({ ok: false, message: "Pull request is not mergeable" });
    // ...seed greenFacts()...
    await p._fire({ type: "deck:mergePr", key: "PROJ-1", repo: "svc", number: 124 });
    expect(posted()).toContainEqual(
      expect.objectContaining({
        type: "toast", level: "error",
        message: expect.stringContaining("Pull request is not mergeable"),
        action: { label: "Open PR", url: "https://github.com/o/svc/pull/124" },
      }),
    );
    expect(posted()).toContainEqual(expect.objectContaining({ type: "deck:mergeDone", outcome: "failed" }));
  });

  it("stales the merged repo's cache entry on success, so the card stops offering a merged PR", async () => {
    // Without this the card keeps its Merge button for up to
    // prFactsTtlSeconds (default 120s) after the PR has merged.
    h.mergeWrites = true;
    vi.mocked(window.showWarningMessage).mockResolvedValue("Squash and merge");
    // ...seed greenFacts() and note the entry's fetchedAt...
    await p._fire({ type: "deck:mergePr", key: "PROJ-1", repo: "svc", number: 124 });
    expect(readPrEntries(tmpPrDir, "PROJ-1").svc.fetchedAt).toBe(0);
    // The facts themselves survive, so the card does not blink to "no PR" before
    // the refetch lands.
    expect(readPrEntries(tmpPrDir, "PROJ-1").svc.facts).toMatchObject({ number: 124 });
    expect(posted()).toContainEqual(expect.objectContaining({ type: "deck:mergeDone", outcome: "ok" }));
  });

  it("ignores a second message for the same PR while the first is still in flight", async () => {
    // Deliberately posts NO outcome for the duplicate: the real call owns the
    // outcome, and a "cancelled" here would re-enable the button mid-merge —
    // the opposite of what the guard exists for. Same shape as
    // reviewSubmitsInFlight.
    h.mergeWrites = true;
    vi.mocked(window.showWarningMessage).mockResolvedValue("Squash and merge");
    let release!: () => void;
    h.prMerge.mockImplementation(() => new Promise((res) => { release = () => res({ ok: true }); }));
    // ...seed greenFacts()...
    const first = p._fire({ type: "deck:mergePr", key: "PROJ-1", repo: "svc", number: 124 });
    await p._fire({ type: "deck:mergePr", key: "PROJ-1", repo: "svc", number: 124 });
    release();
    await first;
    expect(h.prMerge).toHaveBeenCalledTimes(1);
  });

  it("carries mergeWrites on deck:runs so the card can render the row", async () => {
    h.mergeWrites = true;
    // ...open the panel and let it post...
    expect(posted().find((m) => m.type === "deck:runs")).toMatchObject({ mergeWrites: true });
  });
});
```

Replace each `// ...seed…` comment with the file's existing fixture calls — `h.runs`, `h.prEntries`, `writePrEntry`, and whatever `posted()`/`lastPanel()`/`p` helper the neighbouring blocks use. Do not invent new helpers.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/deckView.test.ts` (add `timeout: 600000` if running through a tool — this file alone can take minutes; if it dies outright, run `npm ci` first, which is the known fix)
Expected: FAIL — `deck:mergePr` is not a message type.

- [ ] **Step 3: Add the message types**

In `src/types.ts`, add to the inbound union beside `deck:reviewSubmit`:

```ts
  /** Merge the one PR this card can merge. `repo` and `number` are what the
   * webview believed; the host re-derives them from its own PR store and refuses
   * if they disagree — the webview is a renderer, never the authority for a
   * write. */
  | { type: "deck:mergePr"; key: string; repo: string; number: number }
```

To the outbound union beside `deck:reviewSubmitDone`:

```ts
  /** The explicit outcome of one deck:mergePr, posted at every exit that reached
   * the confirmation, so the row's disable is always released. A duplicate
   * message rejected by the in-flight guard deliberately gets NO outcome: the
   * real call owns it. */
  | { type: "deck:mergeDone"; key: string; repo: string; number: number; outcome: "ok" | "failed" | "cancelled" }
```

And on the `deck:runs` message, beside `showTokenTotal`:

```ts
      /** `agentFlow.mergeWrites` — the card's Merge row renders only when true.
       * Optional, and read as `?? false` in the webview: an in-flight message
       * posted before this build's host reloads carries no such field, and the
       * safe reading of "I do not know" for a write path is off. Same reasoning
       * as `agentLabel`'s own runtime fallback. Optional also keeps every
       * existing `deck:runs` fixture compiling untouched. */
      mergeWrites?: boolean;
```

- [ ] **Step 4: Implement the handler**

In `src/deckView.ts`, add the imports (`mergeTarget` from `./engine/bucket`, `MergeMethod` from `./types`) and, beside `reviewSubmitsInFlight`:

```ts
  /** Keyed `${key}:${repo}#${number}` — a card can only merge one PR, but the key
   * says exactly which write is in flight rather than which card is busy. */
  private readonly mergesInFlight = new Set<string>();
```

Add the strategy labels near the file's other label maps:

```ts
/** What the confirmation dialog calls each strategy. The dialog names the
 * resolved `agentFlow.mergeMethod` every time, so the setting can never merge a
 * way the user did not see. */
const MERGE_LABEL: Record<MergeMethod, string> = {
  squash: "Squash and merge",
  merge: "Merge",
  rebase: "Rebase and merge",
};
```

Add the method (put it beside `submitReview`):

```ts
  /**
   * Merge one card's PR. The only path in this extension that merges anything.
   *
   * Every gate the webview already applied is applied AGAIN here, and that is the
   * point: a webview message is untyped at runtime and a renderer is not the
   * authority for a write. In particular `mergeTarget` is re-run against the
   * host's own PR store and must name the same repo and number the message did —
   * so a stale card, a hand-crafted message, or a PR that went red between render
   * and click all refuse instead of merging.
   */
  private async mergePr(key: string, repo: string, number: number): Promise<void> {
    const cfg = getConfig();
    if (!cfg.mergeWrites) {
      this.log(`deck: mergePr ignored — agentFlow.mergeWrites is off`);
      return;
    }
    const run = this.run(key);
    if (!run) {
      this.toast("error", `No run record for ${key}.`);
      return;
    }
    // Same guard, same reason, as seedPrWork's: a local card's ticket is inferred
    // from a branch name that may belong to somebody else's ticket.
    if (runKind(run) === "local") {
      this.log(`deck: mergePr ignored for local card ${key}`);
      return;
    }
    const target = mergeTarget(readPrEntries(defaultPrFactsDir(), key));
    if (!target || target.repo !== repo || target.number !== number) {
      this.log(`deck: mergePr refused — ${key}/${repo}#${number} is not this run's merge target`);
      return;
    }
    const checkout = run.repos.find((r) => r.name === target.repo);
    if (!checkout) {
      this.log(`deck: mergePr refused — no checkout for ${target.repo} in ${key}`);
      return;
    }

    const inflightKey = `${key}:${target.repo}#${target.number}`;
    // Deliberately silent, exactly as the review-submit guard is: the genuine
    // call still running owns posting the outcome, and a "cancelled" from this
    // rejected duplicate would release the button mid-merge.
    if (this.mergesInFlight.has(inflightKey)) return;
    this.mergesInFlight.add(inflightKey);
    try {
      const label = MERGE_LABEL[cfg.mergeMethod] ?? MERGE_LABEL.squash;
      const answer = await vscode.window.showWarningMessage(
        `${label} on ${target.repo}#${target.number}?`,
        { modal: true, detail: "Approved, every check green, and no unresolved review threads." },
        label,
      );
      if (answer !== label) {
        // Distinct from a failure: nothing was attempted, so there is nothing to
        // warn about — just release the row's disable.
        this.post({ type: "deck:mergeDone", key, repo: target.repo, number: target.number, outcome: "cancelled" });
        return;
      }
      this.log(`deck: merging ${target.repo}#${target.number} with ${cfg.mergeMethod}`);
      const res = await this.forge.prs.merge(checkout.path, target.number, cfg.mergeMethod);
      if (!res.ok) {
        this.log(`deck: merge failed: ${res.message}`);
        // Neutral prefix, for the same reason submitReview's is: the timeout
        // wording says the write MAY have gone through, and any prefix asserting
        // an outcome would contradict the message it is prefixing.
        this.post({
          type: "toast",
          level: "error",
          message: `Merge: ${res.message}`,
          action: { label: "Open PR", url: target.url },
        });
        this.post({ type: "deck:mergeDone", key, repo: target.repo, number: target.number, outcome: "failed" });
        return;
      }
      this.toast("success", `${target.repo}#${target.number} merged.`);
      // Stale the entry rather than deleting the run's whole file: the next tick
      // refetches (isStale is true at fetchedAt 0) while the facts stay on the
      // card, so it does not blink to "no PR" before the truth lands.
      const stored = readPrEntries(defaultPrFactsDir(), key)[target.repo];
      if (stored) writePrEntry(defaultPrFactsDir(), key, target.repo, { ...stored, fetchedAt: 0 });
      this.post({ type: "deck:mergeDone", key, repo: target.repo, number: target.number, outcome: "ok" });
    } catch (e) {
      // A throw anywhere above (a disposed panel's post, a rejected modal) must
      // still release the button — otherwise the row stays disabled forever.
      this.log(`deck: mergePr threw: ${e instanceof Error ? e.message : String(e)}`);
      this.post({ type: "deck:mergeDone", key, repo, number, outcome: "failed" });
    } finally {
      this.mergesInFlight.delete(inflightKey);
    }
  }
```

Wire it into the message switch, beside `case "deck:seedPrWork"`:

```ts
      case "deck:mergePr":
        await this.mergePr(m.key, m.repo, m.number);
        break;
```

And add to the `deck:runs` post, beside `showTokenTotal`:

```ts
        // Same reasoning as showTokenTotal above: a plain boolean setting the user
        // can flip mid-session, read fresh on every post.
        mergeWrites: getConfig().mergeWrites,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/unit/deckView.test.ts` (with `timeout: 600000` through a tool)
Expected: PASS — the new block and every pre-existing test in the file.

- [ ] **Step 6: Typecheck and commit**

```bash
cd /Users/oznasi/dev/agent-flow-merge-button
npm run typecheck
git add src/types.ts src/deckView.ts test/unit/deckView.test.ts
git commit -m "feat(deck): merge a card's PR, re-checking the predicate host-side"
```

---

## Task 6: The card's Merge row

**Files:**
- Modify: `src/webview/deckSignal.ts`
- Modify: `src/webview/DeckApp.tsx` (`Card`, currently line 163; the message effect, line 424; the `<Card ...>` call site, line 648)
- Modify: `src/webview/deckStyles.ts` (the card-row rules, currently lines 923–932)
- Test: `test/webview/deckSignal.test.ts`, `test/webview/DeckApp.test.tsx`

**Interfaces:**
- Consumes: `mergeTarget`, `MergeTarget` from `../engine/bucket` (Task 1); `deck:mergePr` / `deck:mergeDone` / `deck:runs.mergeWrites` (Task 5).
- Produces: `export function cardMerge(r: RunStatus): MergeTarget | null` in `src/webview/deckSignal.ts`.

- [ ] **Step 1: Write the failing `cardMerge` tests**

Append to `test/webview/deckSignal.test.ts`, reusing its `facts()`, `status()` and `pr()` helpers:

```ts
describe("cardMerge", () => {
  const green = () => facts({ number: 124, url: "https://gh/pr/124", review: "approved", unresolved: 0 });

  it("names the PR when everything is green and readable", () => {
    expect(cardMerge(status({ prs: pr(green()) }))).toEqual({
      repo: "svc", number: 124, url: "https://gh/pr/124",
    });
  });

  it("is null when there is no PR at all", () => {
    expect(cardMerge(status())).toBeNull();
  });

  it("is null when the thread count is unreadable", () => {
    expect(cardMerge(status({ prs: pr(facts({ review: "approved", unresolved: null })) }))).toBeNull();
  });

  // The two never appear together, and this is the assertion that pins it: a card
  // showing both "Fix CI" and "Merge" would be the board's loudest contradiction.
  it("never coexists with a problem row", () => {
    const red = facts({ review: "approved", unresolved: 0, ci: { passing: 1, pending: 0, failing: [{ name: "lint", url: "" }] } });
    const s = status({ prs: pr(red) });
    expect(cardActions(s).length).toBeGreaterThan(0);
    expect(cardMerge(s)).toBeNull();
  });
});
```

Add `cardMerge` to the file's import from `../../src/webview/deckSignal`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/webview/deckSignal.test.ts`
Expected: FAIL — `cardMerge` is not exported.

- [ ] **Step 3: Implement `cardMerge`**

Append to `src/webview/deckSignal.ts`:

```ts
/**
 * The one PR this card can merge, or null.
 *
 * A thin wrapper over `mergeTarget` so `DeckApp` reads one vocabulary for both
 * halves of a card's action area — the problem rows come from `cardActions`, the
 * merge row from here, and neither reaches into the engine directly.
 *
 * `mergeTarget` is a pure leaf in `engine/bucket.ts` (which may import nothing but
 * `../types`), so this stays inside the webview's Node-free budget.
 */
export function cardMerge(r: RunStatus): MergeTarget | null {
  return mergeTarget(r.prs);
}
```

with, at the top of the file:

```ts
import { mergeTarget, type MergeTarget } from "../engine/bucket";
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/webview/deckSignal.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing render tests**

Append to `test/webview/DeckApp.test.tsx`. Its `healthyPr()` helper is already approved + clean but has `unresolved: null`, so it is deliberately NOT merge-ready — that is a useful case, not a bug to fix. Add a new helper rather than editing `healthyPr`:

```ts
/** The card the Merge button exists for: approved, green, threads readable and clear. */
const mergeablePr = (): PrFacts => ({
  number: 2044, url: "https://gh/pr/2044", title: "t", state: "OPEN", isDraft: false,
  ci: { passing: 8, pending: 0, failing: [] },
  review: "approved", unresolved: 0, mergeable: "clean", ciAdvisory: false,
});

describe("the card's Merge row", () => {
  it("is absent when mergeWrites is off, even on a fully green card", () => {
    host(runsMsg([withPr(mergeablePr())]));
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
  });

  it("renders on a green card once mergeWrites is on", async () => {
    host({ ...runsMsg([withPr(mergeablePr())]), mergeWrites: true });
    // waitFor, never a bare tick: an async read from an earlier test can land its
    // postMessage in this one.
    await waitFor(() => expect(screen.getByRole("button", { name: "Merge" })).toBeTruthy());
  });

  it("is absent when the thread count is unreadable — healthyPr's own case", () => {
    host({ ...runsMsg([withPr(healthyPr())]), mergeWrites: true });
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
  });

  it("is absent on a card with a problem row, which wins", () => {
    host({ ...runsMsg([withPr(failingPr())]), mergeWrites: true });
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
    expect(screen.getByRole("button", { name: "Fix CI" })).toBeTruthy();
  });

  it("sends deck:mergePr with the run key, repo and number", async () => {
    host({ ...runsMsg([withPr(mergeablePr())]), mergeWrites: true });
    const btn = await waitFor(() => screen.getByRole("button", { name: "Merge" }));
    fireEvent.click(btn);
    expect(sent).toHaveBeenCalledWith({ type: "deck:mergePr", key: "PROJ-1", repo: "svc", number: 2044 });
  });

  it("disables the button until deck:mergeDone comes back", async () => {
    host({ ...runsMsg([withPr(mergeablePr())]), mergeWrites: true });
    const btn = await waitFor(() => screen.getByRole("button", { name: "Merge" }));
    fireEvent.click(btn);
    await waitFor(() => expect((screen.getByRole("button", { name: "Merge" }) as HTMLButtonElement).disabled).toBe(true));
    host({ type: "deck:mergeDone", key: "PROJ-1", repo: "svc", number: 2044, outcome: "cancelled" });
    await waitFor(() => expect((screen.getByRole("button", { name: "Merge" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("clicking the row does not select the card", async () => {
    // The problem rows already stopPropagation for this reason; the merge row
    // shares their container, so this pins that it kept the behaviour.
    host({ ...runsMsg([withPr(mergeablePr())]), mergeWrites: true });
    const btn = await waitFor(() => screen.getByRole("button", { name: "Merge" }));
    fireEvent.click(btn);
    expect(sent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "deck:usageFor" }));
  });
});
```

- [ ] **Step 6: Run to verify they fail**

Run: `npx vitest run test/webview/DeckApp.test.tsx`
Expected: FAIL — no Merge button exists.

- [ ] **Step 7: Implement the row**

In `src/webview/DeckApp.tsx`:

1. Import `cardMerge` alongside the existing `cardActions, cardSignal` import.
2. Add state and a `deck:mergeDone` branch in the message effect:

```ts
  /** `agentFlow.mergeWrites`. `?? false` is required, not defensive: the field is
   * optional on `deck:runs`, and an in-flight message from before this build's
   * host reloaded carries none — off is the safe reading of "I do not know" for
   * a write. Same shape as `agentLabel`'s fallback. */
  const [mergeWrites, setMergeWrites] = React.useState(false);
  /** PRs whose merge is in flight, keyed `${key}:${repo}#${number}` — the button
   * stays disabled until the host answers, so a double click cannot send twice. */
  const [merging, setMerging] = React.useState<Record<string, true>>({});
```

In the `deck:runs` branch, beside `setShowTokenTotal(m.showTokenTotal)`:

```ts
        setMergeWrites(m.mergeWrites ?? false);
```

And a new branch beside the `deck:usage` one:

```ts
      } else if (m.type === "deck:mergeDone") {
        // Keyed, not a single slot: the reply can land after the board re-rendered.
        setMerging((s) => {
          const next = { ...s };
          delete next[`${m.key}:${m.repo}#${m.number}`];
          return next;
        });
```

3. Thread the two through `Card`'s props (beside `sourceLabel`), and pass them at the call site on line 648:

```ts
  mergeWrites: boolean;
  merging: Record<string, true>;
  onMerge: (t: MergeTarget) => void;
```

```tsx
    <Card key={c.id} r={c.status} agent={c.agent} column={c.column} sourceLabel={sourceLabel}
      mergeWrites={mergeWrites} merging={merging}
      onMerge={(t) => {
        setMerging((s) => ({ ...s, [`${c.status.run.key}:${t.repo}#${t.number}`]: true }));
        send({ type: "deck:mergePr", key: c.status.run.key, repo: t.repo, number: t.number });
      }}
      selected={c.id === selId}
      onSelect={() => { setOpenFlowId(null); setSelId((cur) => (cur === c.id ? null : c.id)); }} />
```

4. Inside `Card`, beside the existing `const acts = local ? [] : cardActions(r);`:

```ts
  // The merge row and the problem rows are mutually exclusive by construction:
  // mergeTarget requires every fact cardActions reports as wrong to be absent.
  // The `acts.length === 0` guard below is therefore belt-and-braces, and cheap.
  // The `local` guard is the same one `acts` carries, for the same reason: a local
  // card's ticket is inferred from a branch name that may be someone else's, and
  // merging off that inference on one click is what must never ship. The host
  // re-checks it anyway.
  const merge = local || !mergeWrites ? null : cardMerge(r);
  const mergeBusy = merge ? merging[`${r.run.key}:${merge.repo}#${merge.number}`] === true : false;
```

5. Render it. Replace the `acts.length > 0 ? (...) : sigBits.length > 0 ? (...) : null` chain's first condition so the merge row shares the `c-rows` container — a green card and a red card must scan from one layout:

```tsx
      {acts.length > 0 || (merge && acts.length === 0) ? (
        <div className="c-rows" onClick={(e) => e.stopPropagation()}>
          {acts.map((a, i) => (
            /* ...existing problem-row JSX, unchanged... */
          ))}
          {acts.length === 0 && merge && (
            <div className="c-row">
              <span className="m">#{merge.number}</span>
              <span className="lbl ok">approved · green · no open threads</span>
              <button
                className="act"
                disabled={mergeBusy}
                title={`Merge ${merge.repo}#${merge.number} — asks for confirmation first`}
                onClick={() => onMerge(merge)}
              >
                Merge
              </button>
            </div>
          )}
        </div>
      ) : sigBits.length > 0 ? (
```

- [ ] **Step 8: Add the one CSS rule**

In `src/webview/deckStyles.ts`, directly after `.c-row .bad, .c-row .warn { color: var(--c-attn); }`:

```
  /* A state, not a brand accent — --c-done, never var(--brand): tokens.test.ts
     asserts set equality of this sheet's --brand spenders, and a merge-ready card
     is not a place to put the board's accent. */
  .c-row .ok { color: var(--c-done); }
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run test/webview/DeckApp.test.tsx test/webview/deckSignal.test.ts test/webview/tokens.test.ts test/webview/webviewGraph.test.ts`
Expected: PASS all four. `tokens.test.ts` proves no `--brand` spender was added; `webviewGraph.test.ts` proves the import graph stayed Node-free.

- [ ] **Step 10: Prove the bundle still builds**

Run: `npm run build`
Expected: success. This is the only real gate on the webview import rule — `webviewGraph.test.ts` follows relative imports only, so it can pass over a violation that still breaks the build.

- [ ] **Step 11: Typecheck and commit**

```bash
cd /Users/oznasi/dev/agent-flow-merge-button
npm run typecheck
git add src/webview/deckSignal.ts src/webview/DeckApp.tsx src/webview/deckStyles.ts test/webview/deckSignal.test.ts test/webview/DeckApp.test.tsx
git commit -m "feat(deck): a Merge button on a card whose PR is provably ready"
```

---

## Task 7: Docs, changelog, and the full gate

**Files:**
- Modify: `docs/FORGES.md` (the *What GitLab cannot answer* table, lines 82–91)
- Modify: `CHANGELOG.md` (under `## [Unreleased]`, line 8)

**Interfaces:** none — documentation and the final verification.

- [ ] **Step 1: Add the FORGES.md row**

Append to the table that starts at line 82, after the *Is a skipped required check green?* row:

```
| Merge with a named strategy | `--squash` / `--merge` / `--rebase` on `gh pr merge` | `squash` is the only per-request override; the project's own **Merge method** setting decides whether a merge is rebased or fast-forwarded | `agentFlow.mergeMethod: rebase` is REFUSED with a message naming the setting, never silently merged another way — a substituted merge strategy is the one degradation a user cannot see afterwards |
```

- [ ] **Step 2: Add the changelog entry**

Under `## [Unreleased]`:

```markdown
### Added

- **Merge a green pull request from its card.** A card whose one pull request is
  provably ready — approved, every check green, no unresolved review threads, and
  mergeable cleanly — now offers a **Merge** button where its problem rows would
  be. The Deck's Merge column already promoted such a card for being one click
  from done; this is the click. Every merge asks for confirmation and names the
  strategy first, and the host re-checks the pull request itself before writing,
  so a card that went stale refuses rather than merges.

  Off by default, behind `agentFlow.mergeWrites` — the second setting that lets
  Agent Flow Deck write to your forge, alongside `agentFlow.reviewWrites`.
  `agentFlow.mergeMethod` picks the strategy (`squash` by default).

  Two deliberate limits: a card with **two** ready pull requests shows no button,
  because merging one half of a coupled pair on a single click is not a decision
  to make for you; and an unreadable fact is not a green one, so a pull request
  whose review-thread count could not be fetched keeps its button withheld.

  On GitLab, `squash` and `merge` work; `rebase` is refused with a message, since
  GitLab's merge API takes no per-request rebase — a project's own **Merge
  method** setting decides that. See [docs/FORGES.md](docs/FORGES.md).
```

- [ ] **Step 3: Run the docs test**

Run: `npx vitest run test/unit/docs.test.ts`
Expected: PASS. (This test does not gate the merge row itself — it only asserts every registered forge id and the `taskSource`/`forge` settings appear. The row is a discipline item; add it regardless.)

- [ ] **Step 4: Run the whole gate**

All four, in order. Read the **real** exit code — `cmd > log; echo EXIT=$?` reports the echo's status, and npm can be SIGTERMed and still look green.

```bash
cd /Users/oznasi/dev/agent-flow-merge-button
npm ci
npm run typecheck
npm test          # timeout: 600000 — ~4,500 tests, 2+ minutes
npm run build
```

Expected: all four pass. If exactly one test fails under CPU contention, re-run that file alone before believing it — a single failure at high load is usually flake, not a regression.

- [ ] **Step 5: Verify the feature is genuinely inert**

The "ships inert" promise is worth checking directly rather than trusting:

```bash
cd /Users/oznasi/dev/agent-flow-merge-button
grep -n '"agentFlow.mergeWrites"' -A 3 package.json    # "default": false
```

Then, with `agentFlow.mergeWrites` unset, confirm no card renders a Merge button — Task 6's first test (`is absent when mergeWrites is off, even on a fully green card`) is the automated form of this.

- [ ] **Step 6: Commit**

```bash
cd /Users/oznasi/dev/agent-flow-merge-button
git add docs/FORGES.md CHANGELOG.md
git commit -m "docs: record the card Merge button and GitLab's rebase gap"
```

- [ ] **Step 7: Manual verification in a real editor window**

Automated tests cannot cover the last mile, and two of this repo's own invariants say so: jsdom is blind to drag and pointer behaviour, and a provider path that never ran in an editor has shipped broken here before.

1. `code --extensionDevelopmentPath=/Users/oznasi/dev/agent-flow-merge-button` — **VS Code's own `code` CLI only**; the Cursor CLI silently drops the flag. Or press **F5**.
2. Set `agentFlow.mergeWrites: true` on a repo where you have a real, approved, green PR with no open threads.
3. Confirm the Merge row appears, the confirm dialog names the strategy, and the merge lands.
4. Confirm the card stops offering Merge on the next refresh rather than after the 120s TTL.
5. **State the GitLab result honestly.** `glab` is not installed on the authoring machine. If it could not be verified against a real GitLab MR, say so in the PR description — do not report it as working.

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task: §1 predicate → Task 1; §2 seam → Tasks 2–3; §3 settings → Task 4; §4 webview → Task 6; §5 host → Task 5; §6 testing → distributed across all; *Open risk* → Task 7 Step 7.5. The spec's "one additive telemetry event" is the single item **not** implemented — deferred with reasons stated in Global Constraints, because the existing review-write path has no event either and `events.ts` is a separately-guarded subsystem. The two new *settings* do join the existing snapshot, which is what the spec's spirit (and every other setting) requires.

**Deviations from the spec, all deliberate.**
- `MergeMethod` is a type in `src/types.ts`, not a value — `src/types.ts` holds zero runtime consts and must keep doing so, `MERGE_METHODS`, the runtime list, lives in `src/config.ts`: `settingsSnapshot.ts` already imports from `config.ts`, so putting it beside `WORKTREE_MODES` there would be a cycle.
- `PrProvider` gains `merge`, and `Forge` is **unchanged** — better than the spec implied, since `forge.prs` already carries the seam.
- GitLab goes through `glab api --method PUT …/merge` rather than `glab mr merge`. This *removes* the spec's stated unknown: the REST contract is documented, so the argv is pinned exactly here, and GitLab's real limit (no per-request rebase) becomes an explicit refusal instead of a guess. Only the live end-to-end check remains unverifiable locally.
- `deck:runs.mergeWrites` is **optional**, so no existing `deck:runs` fixture needs editing and a pre-upgrade in-flight message renders the feature off.
- `stripCommandLine` moves from `review/provider.ts` to `pr/provider.ts` — not in the spec, but the alternative was a second copy of the argv-leak guard.

**Placeholders.** None. The one exception is intentional and marked: Task 5 Step 1's `// ...seed…` comments, where the plan tells the implementer to reuse `deckView.test.ts`'s existing fixture helpers rather than inventing parallel ones. That file's harness is 600+ lines of hoisted mocks; transcribing a wrong copy of it into this plan would be worse than pointing at it.

**Type consistency.** `mergeTarget(prs: PrEntryMap): MergeTarget | null` and `MergeTarget { repo, number, url }` are used identically in Tasks 1, 5 and 6. `merge(repoPath, number, method)` returning `{ ok: true } | { ok: false; message: string }` is identical in Tasks 2, 3 and 5. `MergeMethod = "squash" | "merge" | "rebase"` is one spelling in Tasks 1, 2, 3, 4 and 5. `deck:mergeDone`'s payload is `{ key, repo, number, outcome }` in both Task 5 and Task 6.

**Known risk to watch.** Task 5's fixture additions to `test/unit/deckView.test.ts` (the mocked `GhProvider` gaining `merge`, the mocked `getConfig` gaining two fields) and Task 4's one title correction are the only touches to pre-existing test files. Anything beyond those means stop and ask.
