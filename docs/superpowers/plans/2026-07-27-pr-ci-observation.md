# PR & CI Observation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Deck its own read-only view of GitHub, so each card shows its PR's CI, review and mergeability state, and a blocked PR pulls its card into **Needs you**.

**Architecture:** One `gh pr list --json` call per repo resolves the pull request and returns every fact in a single shot. Facts are normalised by pure mappers, cached on disk under `~/.agentflow/prfacts/<KEY>.json`, and fed into `deriveBucket` as three booleans. The Deck's existing 6s tick renders only what is cached and enqueues stale repos onto an out-of-band queue, so a slow `gh` can never stall the git and transcript reads the live signal depends on.

**Tech Stack:** TypeScript, VS Code extension API, React (webview), vitest, `gh` CLI ≥ 2.89.0.

**Spec:** [`docs/superpowers/specs/2026-07-27-pr-ci-observation-design.md`](../specs/2026-07-27-pr-ci-observation-design.md)

## Global Constraints

Every task's requirements implicitly include these.

- **Read-only.** No merge, no comment resolution, no branch update, no Jira transition, no agent nudge, no notification, no badge. Any write is out of scope.
- **Never throw, never toast, never show a modal** on any `gh` failure. Every failure path yields "no facts" and leaves the git + Jira backbone intact — the same contract `readAgentActivity` honours.
- **Nothing is evicted on failure, only overwritten on success.** A stale-but-present fact beats a blank card.
- `agentFlow.prFacts` default `true`. `agentFlow.prFactsTtlSeconds` default `120`.
- `gh` subprocess timeout: **10 seconds**. Refresh concurrency cap: **4**. In-flight dedupe keyed by **repo path**.
- CI conclusions `CANCELLED`, `NEUTRAL`, `SKIPPED`, `STALE` are **ignored**, never failures.
- Failing checks coexisting with `mergeStateStatus === "UNSTABLE"` **do not** set `prBlocked` (they render, but do not promote).
- A **draft** PR does not satisfy `prOpen`.
- `prMerged` requires **every** PR-bearing repo to be merged.
- PR resolution order: `--head <branch>` first, then `--search "<KEY> in:title"`. Winner preference `OPEN` → `MERGED` → `CLOSED`, ties broken by highest `number`.
- The GraphQL review-thread call runs **only** when `reviewDecision` is non-null.
- Facts live at `~/.agentflow/prfacts/<KEY>.json`, one file per run, a map of repo name → entry.
- Coverage thresholds from `vitest.config.ts` must keep passing: statements 90, branches 85, functions 85, lines 90.

**Conventions in this codebase you must follow:**
- `vscode` is aliased to `test/_mocks/vscode.ts` in tests. Never import the real module in a test.
- Engine modules are pure or filesystem-only, take an injected `nowMs` rather than calling `Date.now()`, and swallow their own errors.
- Webview tests use a `// @vitest-environment jsdom` docblock on line 1 and `vi.mock("../../src/webview/vscodeApi", …)`.
- Run a single test file with `npx vitest run <path>`; the whole suite with `npm test`; types with `npm run typecheck`.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/types.ts` (modify) | `PrCheck`, `PrFacts`, `PrEntry`, `PrEntryMap`; `RunStatus.prs`; two new message members. |
| `src/engine/pr/facts.ts` (create) | Pure: raw `gh` JSON → `PrFacts`. Rollup, mergeability, review and URL mappers, plus PR selection. No I/O, no clock. |
| `src/engine/pr/store.ts` (create) | Filesystem: read/write/remove `~/.agentflow/prfacts/<KEY>.json`, and `isStale`. |
| `src/engine/pr/provider.ts` (create) | `PrProvider` seam + `GhProvider`. The **only** place a subprocess is spawned. |
| `src/engine/pr/queue.ts` (create) | Out-of-band refresh scheduling: in-flight dedupe and a concurrency cap. Pure over an injected worker. |
| `src/engine/status.ts` (modify) | `prSignals` aggregator; two new ladder rungs; `buildRunStatus` threads entries through. |
| `src/config.ts`, `package.json` (modify) | The two settings. |
| `src/deckView.ts` (modify) | Wires the store, provider and queue into the existing 6s loop. |
| `src/webview/DeckApp.tsx`, `deckStyles.ts` (modify) | The PR block, the `prFacts` toggle, the footer note, the `cardTone` fix. |
| `README.md`, `CHANGELOG.md` (modify) | Docs and the privacy sentence. |

Tasks 1–4 are independent leaves and can be implemented in any order. Task 5 consumes 1. Task 7 consumes 1–6. Task 8 consumes 1 and 5.

---

### Task 1: Types and the pure fact mappers

**Files:**
- Modify: `src/types.ts` (append a new section after the `RunStatus` interface, currently ending line 97)
- Modify: `src/engine/status.ts` (one line in `buildRunStatus`'s return, so this commit typechecks)
- Create: `src/engine/pr/facts.ts`
- Test: `test/unit/engine/pr/facts.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PrCheck`, `PrFacts`, `PrEntry`, `PrEntryMap` (from `src/types`); and from `src/engine/pr/facts`: `GhPr`, `GhCheck`, `mapRollup(rollup): PrFacts["ci"]`, `mapMergeable(mergeable?, mergeState?): PrFacts["mergeable"]`, `mapReview(decision?): PrFacts["review"]`, `toPrFacts(pr: GhPr, unresolved: number | null): PrFacts | null`, `pickPr(prs: GhPr[]): GhPr | undefined`, `parseRepoFromUrl(url: string): { owner: string; repo: string } | null`.

- [ ] **Step 1: Add the types**

Append to `src/types.ts`, immediately after the `RunStatus` interface:

```ts
// ── PR & CI observation ─────────────────────────────────────────────────────

/** One CI check, named and linkable. */
export interface PrCheck {
  name: string;
  url: string; // "" when gh reports no details URL
}

/** One repo's observed pull-request state. Every field derived, none required. */
export interface PrFacts {
  number: number;
  url: string;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  ci: { passing: number; pending: number; failing: PrCheck[] };
  review: "approved" | "changes_requested" | "review_required" | "none";
  unresolved: number | null; // null = the GraphQL call was skipped
  mergeable: "clean" | "conflicting" | "behind" | "blocked" | "unknown";
  /** Every required check passed and something optional did not
   * (`mergeStateStatus === "UNSTABLE"`). Failing checks render, but do not block. */
  ciAdvisory: boolean;
}

/** What the store holds per repo. The wrapper — not `PrFacts` — carries the
 * timestamp, so that "this repo has no PR" is itself a cacheable answer. */
export interface PrEntry {
  facts: PrFacts | null; // null = resolved, and there is no PR for this repo
  fetchedAt: number; // epoch ms
  error?: boolean; // last attempt failed; `facts` is the previous value, if any
}

/** Repo name → its PR entry, as stored per run and rendered per card. */
export type PrEntryMap = Record<string, PrEntry>;
```

Then add `prs: PrEntryMap;` as the last member of `RunStatus`, with the comment `// repo name → observed PR state ({} when prFacts is off)`.

- [ ] **Step 2: Write the failing tests**

Create `test/unit/engine/pr/facts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mapRollup, mapMergeable, mapReview, toPrFacts, pickPr, parseRepoFromUrl } from "../../../../src/engine/pr/facts";
import type { GhCheck, GhPr } from "../../../../src/engine/pr/facts";

const checkRun = (over: Partial<GhCheck> = {}): GhCheck => ({
  __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS",
  detailsUrl: "https://ci/build", ...over,
});
const statusCtx = (over: Partial<GhCheck> = {}): GhCheck => ({
  __typename: "StatusContext", context: "legacy/ci", state: "SUCCESS",
  targetUrl: "https://ci/legacy", ...over,
});

describe("mapRollup", () => {
  it("counts an empty or missing rollup as all zeros", () => {
    expect(mapRollup([])).toEqual({ passing: 0, pending: 0, failing: [] });
    expect(mapRollup(null)).toEqual({ passing: 0, pending: 0, failing: [] });
    expect(mapRollup(undefined)).toEqual({ passing: 0, pending: 0, failing: [] });
  });

  it("counts a successful CheckRun as passing", () => {
    expect(mapRollup([checkRun()])).toEqual({ passing: 1, pending: 0, failing: [] });
  });

  it.each(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED"])("treats conclusion %s as failing, with its name and url", (conclusion) => {
    const ci = mapRollup([checkRun({ conclusion, name: "lint", detailsUrl: "https://ci/lint" })]);
    expect(ci.failing).toEqual([{ name: "lint", url: "https://ci/lint" }]);
    expect(ci.passing).toBe(0);
  });

  it.each(["CANCELLED", "NEUTRAL", "SKIPPED", "STALE"])("ignores conclusion %s entirely", (conclusion) => {
    expect(mapRollup([checkRun({ conclusion })])).toEqual({ passing: 0, pending: 0, failing: [] });
  });

  it.each(["QUEUED", "IN_PROGRESS"])("counts status %s as pending regardless of conclusion", (status) => {
    expect(mapRollup([checkRun({ status, conclusion: undefined })])).toEqual({ passing: 0, pending: 1, failing: [] });
  });

  it("reads a StatusContext by state, not conclusion", () => {
    expect(mapRollup([statusCtx()])).toEqual({ passing: 1, pending: 0, failing: [] });
    expect(mapRollup([statusCtx({ state: "PENDING" })]).pending).toBe(1);
  });

  it.each(["FAILURE", "ERROR"])("treats StatusContext state %s as failing, named by context", (state) => {
    expect(mapRollup([statusCtx({ state })]).failing).toEqual([{ name: "legacy/ci", url: "https://ci/legacy" }]);
  });

  it("falls back to a placeholder name and an empty url when gh omits them", () => {
    expect(mapRollup([{ __typename: "CheckRun", conclusion: "FAILURE" }]).failing).toEqual([{ name: "check", url: "" }]);
  });

  it("tallies a mixed rollup", () => {
    const ci = mapRollup([checkRun(), checkRun({ name: "lint", conclusion: "FAILURE" }), checkRun({ status: "IN_PROGRESS" }), checkRun({ conclusion: "SKIPPED" })]);
    expect(ci).toEqual({ passing: 1, pending: 1, failing: [{ name: "lint", url: "https://ci/build" }] });
  });
});

describe("mapMergeable", () => {
  it("reports conflicting from either signal", () => {
    expect(mapMergeable("CONFLICTING", "BLOCKED")).toBe("conflicting");
    expect(mapMergeable("MERGEABLE", "DIRTY")).toBe("conflicting");
  });

  it("maps behind and blocked", () => {
    expect(mapMergeable("MERGEABLE", "BEHIND")).toBe("behind");
    expect(mapMergeable("MERGEABLE", "BLOCKED")).toBe("blocked");
  });

  it.each(["CLEAN", "HAS_HOOKS", "UNSTABLE"])("maps %s to clean", (s) => {
    expect(mapMergeable("MERGEABLE", s)).toBe("clean");
  });

  it("maps anything else, including UNKNOWN and DRAFT, to unknown", () => {
    expect(mapMergeable("UNKNOWN", "UNKNOWN")).toBe("unknown");
    expect(mapMergeable(undefined, "DRAFT")).toBe("unknown");
    expect(mapMergeable(undefined, undefined)).toBe("unknown");
  });
});

describe("mapReview", () => {
  it("maps each decision", () => {
    expect(mapReview("APPROVED")).toBe("approved");
    expect(mapReview("CHANGES_REQUESTED")).toBe("changes_requested");
    expect(mapReview("REVIEW_REQUIRED")).toBe("review_required");
  });

  it("maps null, empty and unrecognised to none", () => {
    expect(mapReview(null)).toBe("none");
    expect(mapReview("")).toBe("none");
    expect(mapReview(undefined)).toBe("none");
    expect(mapReview("WAT")).toBe("none");
  });
});

describe("toPrFacts", () => {
  const raw = (over: Partial<GhPr> = {}): GhPr => ({
    number: 4821, url: "https://github.com/o/r/pull/4821", title: "Fix export",
    state: "OPEN", isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
    reviewDecision: null, statusCheckRollup: [checkRun()], ...over,
  });

  it("builds a full record", () => {
    expect(toPrFacts(raw(), 3)).toEqual({
      number: 4821, url: "https://github.com/o/r/pull/4821", title: "Fix export",
      state: "OPEN", isDraft: false,
      ci: { passing: 1, pending: 0, failing: [] },
      review: "none", unresolved: 3, mergeable: "clean", ciAdvisory: false,
    });
  });

  it("returns null without a usable number or url", () => {
    expect(toPrFacts(raw({ number: undefined }), null)).toBeNull();
    expect(toPrFacts(raw({ url: undefined }), null)).toBeNull();
  });

  it("keeps MERGED and CLOSED, and normalises anything else to OPEN", () => {
    expect(toPrFacts(raw({ state: "MERGED" }), null)!.state).toBe("MERGED");
    expect(toPrFacts(raw({ state: "CLOSED" }), null)!.state).toBe("CLOSED");
    expect(toPrFacts(raw({ state: undefined }), null)!.state).toBe("OPEN");
  });

  it("sets ciAdvisory only for UNSTABLE", () => {
    expect(toPrFacts(raw({ mergeStateStatus: "UNSTABLE" }), null)!.ciAdvisory).toBe(true);
    expect(toPrFacts(raw({ mergeStateStatus: "BLOCKED" }), null)!.ciAdvisory).toBe(false);
  });

  it("defaults a missing title to empty and a missing isDraft to false", () => {
    const f = toPrFacts(raw({ title: undefined, isDraft: undefined }), null)!;
    expect(f.title).toBe("");
    expect(f.isDraft).toBe(false);
  });
});

describe("pickPr", () => {
  const p = (number: number, state: string): GhPr => ({ number, state, url: `https://github.com/o/r/pull/${number}` });

  it("returns undefined for an empty list", () => {
    expect(pickPr([])).toBeUndefined();
  });

  it("prefers OPEN over MERGED over CLOSED", () => {
    expect(pickPr([p(1, "CLOSED"), p(2, "MERGED"), p(3, "OPEN")])!.number).toBe(3);
    expect(pickPr([p(1, "CLOSED"), p(2, "MERGED")])!.number).toBe(2);
  });

  it("breaks a same-state tie by highest number", () => {
    expect(pickPr([p(7, "OPEN"), p(9, "OPEN")])!.number).toBe(9);
  });

  it("skips entries with no number", () => {
    expect(pickPr([{ state: "OPEN" }, p(4, "CLOSED")])!.number).toBe(4);
  });
});

describe("parseRepoFromUrl", () => {
  it("reads owner and repo from a github.com PR url", () => {
    expect(parseRepoFromUrl("https://github.com/acme/web-ui/pull/12")).toEqual({ owner: "acme", repo: "web-ui" });
  });

  it("works on an enterprise host", () => {
    expect(parseRepoFromUrl("https://git.corp.example/acme/api/pull/3")).toEqual({ owner: "acme", repo: "api" });
  });

  it("returns null for a url with too few segments or a non-url", () => {
    expect(parseRepoFromUrl("https://github.com/acme")).toBeNull();
    expect(parseRepoFromUrl("not a url")).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/pr/facts.test.ts`
Expected: FAIL — `Failed to resolve import "../../../../src/engine/pr/facts"`.

- [ ] **Step 4: Write the implementation**

Create `src/engine/pr/facts.ts`:

```ts
import { PrCheck, PrFacts } from "../../types";

/** The subset of `gh pr list --json …` we read. Everything optional: gh's shape
 * varies by host and version, and a missing field must never throw. */
export interface GhPr {
  number?: number;
  url?: string;
  title?: string;
  state?: string;
  isDraft?: boolean;
  headRefName?: string;
  mergeable?: string;
  mergeStateStatus?: string;
  reviewDecision?: string | null;
  statusCheckRollup?: GhCheck[] | null;
}

/** One rollup entry. `CheckRun` carries status + conclusion + detailsUrl;
 * `StatusContext` (a legacy commit status) carries state + targetUrl instead. */
export interface GhCheck {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  detailsUrl?: string;
  targetUrl?: string;
}

const FAIL_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED"]);
const FAIL_STATES = new Set(["FAILURE", "ERROR"]);
const PENDING_STATUSES = new Set(["QUEUED", "IN_PROGRESS"]);
const CLEAN_MERGE_STATES = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);

/**
 * Tally a `statusCheckRollup`. `CANCELLED`/`NEUTRAL`/`SKIPPED`/`STALE` count as
 * neither pass nor fail: a cancelled run is usually a superseded one, and calling
 * it a failure would drag cards into Needs you on every force-push.
 */
export function mapRollup(rollup: GhCheck[] | null | undefined): PrFacts["ci"] {
  const failing: PrCheck[] = [];
  let passing = 0;
  let pending = 0;
  for (const c of rollup ?? []) {
    const name = c.name || c.context || "check";
    const url = c.detailsUrl || c.targetUrl || "";
    if (c.state) {
      // StatusContext — graded by `state`, which has no pending/queued split.
      if (FAIL_STATES.has(c.state)) failing.push({ name, url });
      else if (c.state === "PENDING") pending++;
      else if (c.state === "SUCCESS") passing++;
      continue;
    }
    // CheckRun — an unfinished run has no meaningful conclusion yet, so status wins.
    if (c.status && PENDING_STATUSES.has(c.status)) pending++;
    else if (c.conclusion && FAIL_CONCLUSIONS.has(c.conclusion)) failing.push({ name, url });
    else if (c.conclusion === "SUCCESS") passing++;
  }
  return { passing, pending, failing };
}

/** Collapse gh's two mergeability fields into one verdict. */
export function mapMergeable(mergeable?: string, mergeState?: string): PrFacts["mergeable"] {
  if (mergeable === "CONFLICTING" || mergeState === "DIRTY") return "conflicting";
  if (mergeState === "BEHIND") return "behind";
  if (mergeState === "BLOCKED") return "blocked";
  if (mergeState && CLEAN_MERGE_STATES.has(mergeState)) return "clean";
  return "unknown";
}

export function mapReview(decision?: string | null): PrFacts["review"] {
  switch (decision) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "REVIEW_REQUIRED":
      return "review_required";
    default:
      return "none";
  }
}

/** Normalise one gh PR into our record. Null when it lacks an identity we can
 * render or link — treated by the caller as "no PR", never as an error. */
export function toPrFacts(pr: GhPr, unresolved: number | null): PrFacts | null {
  if (typeof pr.number !== "number" || !pr.url) return null;
  const state = pr.state === "MERGED" || pr.state === "CLOSED" ? pr.state : "OPEN";
  return {
    number: pr.number,
    url: pr.url,
    title: pr.title ?? "",
    state,
    isDraft: pr.isDraft === true,
    ci: mapRollup(pr.statusCheckRollup),
    review: mapReview(pr.reviewDecision),
    unresolved,
    mergeable: mapMergeable(pr.mergeable, pr.mergeStateStatus),
    ciAdvisory: pr.mergeStateStatus === "UNSTABLE",
  };
}

const STATE_RANK: Record<string, number> = { OPEN: 3, MERGED: 2, CLOSED: 1 };

/** One branch can carry several PRs across its history. Prefer the live one, then
 * the one that landed, then the abandoned one; newest wins within a state. */
export function pickPr(prs: GhPr[]): GhPr | undefined {
  return [...prs]
    .filter((p) => typeof p.number === "number")
    .sort(
      (a, b) =>
        (STATE_RANK[b.state ?? ""] ?? 0) - (STATE_RANK[a.state ?? ""] ?? 0) ||
        (b.number as number) - (a.number as number),
    )[0];
}

/** Owner and repo from a PR url, so the GraphQL call needs no extra lookup.
 * Host-agnostic: the first two path segments, whatever the hostname. */
export function parseRepoFromUrl(url: string): { owner: string; repo: string } | null {
  let parts: string[];
  try {
    parts = new URL(url).pathname.split("/").filter(Boolean);
  } catch {
    return null;
  }
  if (parts.length < 2) return null;
  return { owner: parts[0], repo: parts[1] };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/pr/facts.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 6: Satisfy the new required field so this commit typechecks**

`RunStatus.prs` is required, and `buildRunStatus` is the only place a `RunStatus` is constructed. Add the literal empty map to its return so the type is satisfied now; Task 5 replaces it with the computed value.

In `src/engine/status.ts`, in `buildRunStatus`'s return statement, append `prs: {}` as the last property:

```ts
  return { run, column, jiraStatus: jira?.status ?? null, jiraCategory: jira?.category ?? null, repos, agent, windowOpen, prs: {} };
```

Do **not** add a parameter or any PR logic here — that is Task 5's job. This is a one-line placeholder whose only purpose is keeping every commit green.

- [ ] **Step 7: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: both clean. Every pre-existing test still passes — `prs: {}` is additive, and no existing assertion does an exact-object comparison on a `RunStatus`.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/engine/status.ts src/engine/pr/facts.ts test/unit/engine/pr/facts.test.ts
git commit -m "feat(pr): normalise gh PR JSON into PrFacts"
```

---

### Task 2: The fact store

**Files:**
- Create: `src/engine/pr/store.ts`
- Test: `test/unit/engine/pr/store.test.ts`

**Interfaces:**
- Consumes: `PrEntry`, `PrEntryMap` from `src/types` (Task 1).
- Produces: `defaultPrFactsDir(): string`, `readPrEntries(dir: string, key: string): PrEntryMap`, `writePrEntry(dir: string, key: string, repo: string, entry: PrEntry): void`, `removePrEntries(dir: string, key: string): void`, `isStale(entry: PrEntry | undefined, ttlMs: number, nowMs: number): boolean`.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/engine/pr/store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { defaultPrFactsDir, readPrEntries, writePrEntry, removePrEntries, isStale } from "../../../../src/engine/pr/store";
import type { PrEntry, PrFacts } from "../../../../src/types";

const facts = (over: Partial<PrFacts> = {}): PrFacts => ({
  number: 1, url: "https://github.com/o/r/pull/1", title: "t", state: "OPEN", isDraft: false,
  ci: { passing: 1, pending: 0, failing: [] }, review: "none", unresolved: null,
  mergeable: "clean", ciAdvisory: false, ...over,
});

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-prfacts-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("defaultPrFactsDir", () => {
  it("lives beside the other agentflow stores", () => {
    expect(defaultPrFactsDir()).toBe(path.join(os.homedir(), ".agentflow", "prfacts"));
  });
});

describe("readPrEntries / writePrEntry", () => {
  it("is empty for a key that was never written", () => {
    expect(readPrEntries(dir, "PROJ-1")).toEqual({});
  });

  it("is empty for a directory that does not exist", () => {
    expect(readPrEntries(path.join(dir, "nope"), "PROJ-1")).toEqual({});
  });

  it("round-trips an entry keyed by repo name", () => {
    const e: PrEntry = { facts: facts(), fetchedAt: 1000 };
    writePrEntry(dir, "PROJ-1", "api", e);
    expect(readPrEntries(dir, "PROJ-1")).toEqual({ api: e });
  });

  it("merges a second repo into the same run file", () => {
    writePrEntry(dir, "PROJ-1", "api", { facts: facts(), fetchedAt: 1 });
    writePrEntry(dir, "PROJ-1", "web", { facts: null, fetchedAt: 2 });
    expect(Object.keys(readPrEntries(dir, "PROJ-1")).sort()).toEqual(["api", "web"]);
  });

  it("overwrites the same repo rather than appending", () => {
    writePrEntry(dir, "PROJ-1", "api", { facts: facts({ number: 1 }), fetchedAt: 1 });
    writePrEntry(dir, "PROJ-1", "api", { facts: facts({ number: 2 }), fetchedAt: 2 });
    expect(readPrEntries(dir, "PROJ-1").api.facts!.number).toBe(2);
  });

  it("keeps runs separate", () => {
    writePrEntry(dir, "PROJ-1", "api", { facts: null, fetchedAt: 1 });
    expect(readPrEntries(dir, "PROJ-2")).toEqual({});
  });

  it("preserves a null-facts entry — 'no PR' is a real cached answer", () => {
    writePrEntry(dir, "PROJ-1", "api", { facts: null, fetchedAt: 5 });
    expect(readPrEntries(dir, "PROJ-1").api).toEqual({ facts: null, fetchedAt: 5 });
  });

  it("skips a corrupt file rather than throwing", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "PROJ-1.json"), "{ not json");
    expect(readPrEntries(dir, "PROJ-1")).toEqual({});
  });

  it("survives a write into a directory that does not exist yet", () => {
    const nested = path.join(dir, "deep", "deeper");
    writePrEntry(nested, "PROJ-1", "api", { facts: null, fetchedAt: 1 });
    expect(readPrEntries(nested, "PROJ-1").api.fetchedAt).toBe(1);
  });
});

describe("removePrEntries", () => {
  it("drops a run's file", () => {
    writePrEntry(dir, "PROJ-1", "api", { facts: null, fetchedAt: 1 });
    removePrEntries(dir, "PROJ-1");
    expect(readPrEntries(dir, "PROJ-1")).toEqual({});
  });

  it("is a no-op for a run that was never written", () => {
    expect(() => removePrEntries(dir, "PROJ-404")).not.toThrow();
  });
});

describe("isStale", () => {
  it("treats a missing entry as stale", () => {
    expect(isStale(undefined, 1000, 5000)).toBe(true);
  });

  it("is fresh strictly inside the ttl", () => {
    expect(isStale({ facts: null, fetchedAt: 4001 }, 1000, 5000)).toBe(false);
  });

  it("is stale exactly at the ttl", () => {
    expect(isStale({ facts: null, fetchedAt: 4000 }, 1000, 5000)).toBe(true);
  });

  it("is stale past the ttl", () => {
    expect(isStale({ facts: null, fetchedAt: 3999 }, 1000, 5000)).toBe(true);
  });

  it("ages a null-facts entry like any other, so a PR-less repo is not refetched every tick", () => {
    expect(isStale({ facts: null, fetchedAt: 4500 }, 1000, 5000)).toBe(false);
  });

  it("ages an errored entry like any other, so a broken gh is not retried every tick", () => {
    expect(isStale({ facts: null, fetchedAt: 4500, error: true }, 1000, 5000)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/pr/store.test.ts`
Expected: FAIL — cannot resolve `src/engine/pr/store`.

- [ ] **Step 3: Write the implementation**

Create `src/engine/pr/store.ts`:

```ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PrEntry, PrEntryMap } from "../../types";

/** ~/.agentflow/prfacts — one file per run, beside `runs/` and `windows/`.
 * Derived and disposable, so it stays out of the durable Run record. */
export function defaultPrFactsDir(): string {
  return path.join(os.homedir(), ".agentflow", "prfacts");
}

function fileFor(dir: string, key: string): string {
  return path.join(dir, `${key}.json`);
}

/** A run's entries, or `{}` for a missing, unreadable or corrupt file — a broken
 * cache must degrade to "no facts", never break the board. */
export function readPrEntries(dir: string, key: string): PrEntryMap {
  try {
    const parsed = JSON.parse(fs.readFileSync(fileFor(dir, key), "utf8")) as PrEntryMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Merge one repo's entry into the run's file. Best-effort — a cache write must
 * never fail a refresh. */
export function writePrEntry(dir: string, key: string, repo: string, entry: PrEntry): void {
  try {
    const all = readPrEntries(dir, key);
    all[repo] = entry;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fileFor(dir, key), JSON.stringify(all, null, 2) + "\n");
  } catch {
    /* the cache is a convenience — never fail a caller over it */
  }
}

/** Forget a run's PR facts (called alongside `removeRun`). */
export function removePrEntries(dir: string, key: string): void {
  try {
    fs.rmSync(fileFor(dir, key), { force: true });
  } catch {
    /* best-effort */
  }
}

/** Is this entry due for a refetch? A missing entry is stale; an entry exactly at
 * the TTL is stale. Pure — `nowMs` is injected so callers control the clock. */
export function isStale(entry: PrEntry | undefined, ttlMs: number, nowMs: number): boolean {
  if (!entry) return true;
  return nowMs - entry.fetchedAt >= ttlMs;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/pr/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/pr/store.ts test/unit/engine/pr/store.test.ts
git commit -m "feat(pr): cache PR facts per run under ~/.agentflow/prfacts"
```

---

### Task 3: The gh provider

**Files:**
- Create: `src/engine/pr/provider.ts`
- Test: `test/unit/engine/pr/provider.test.ts`

**Interfaces:**
- Consumes: `PrFacts` from `src/types`; `GhPr`, `pickPr`, `toPrFacts`, `parseRepoFromUrl` from `src/engine/pr/facts` (Task 1).
- Produces:
  - `type FetchResult = { ok: true; facts: PrFacts | null } | { ok: false }`
  - `type Runner = (file: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<string>`
  - `interface PrProvider { fetch(repoPath: string, branch: string | null, key: string): Promise<FetchResult> }`
  - `class GhProvider implements PrProvider` — `constructor(run: Runner = execRunner)`
  - `execRunner: Runner`
  - `ghAvailable(run?: Runner): Promise<boolean>`
  - `PR_JSON_FIELDS: string`, `GH_TIMEOUT_MS: number`

`ok: false` means *the attempt failed*; `ok: true, facts: null` means *there is genuinely no PR*. Task 7 depends on that distinction to set `PrEntry.error`.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/engine/pr/provider.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { GhProvider, ghAvailable, PR_JSON_FIELDS, GH_TIMEOUT_MS } from "../../../../src/engine/pr/provider";
import type { Runner } from "../../../../src/engine/pr/provider";

const pr = (over: Record<string, unknown> = {}) => ({
  number: 4821, url: "https://github.com/acme/api/pull/4821", title: "Fix export",
  state: "OPEN", isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
  reviewDecision: null, statusCheckRollup: [], ...over,
});

/** A Runner that replies from a queue of canned stdout strings. */
function scripted(...replies: (string | Error)[]): { run: Runner; calls: { file: string; args: string[]; cwd: string }[] } {
  const calls: { file: string; args: string[]; cwd: string }[] = [];
  let i = 0;
  const run: Runner = async (file, args, opts) => {
    calls.push({ file, args, cwd: opts.cwd });
    const r = replies[Math.min(i++, replies.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
  return { run, calls };
}

describe("GhProvider.fetch — argv", () => {
  it("asks gh for the head branch first, in the repo directory, with every field", async () => {
    const { run, calls } = scripted(JSON.stringify([pr()]));
    await new GhProvider(run).fetch("/r/api", "feat/PROJ-1", "PROJ-1");

    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("gh");
    expect(calls[0].cwd).toBe("/r/api");
    expect(calls[0].args).toEqual([
      "pr", "list", "--head", "feat/PROJ-1", "--state", "all", "--limit", "10", "--json", PR_JSON_FIELDS,
    ]);
  });

  it("falls back to a Jira-key title search when the branch has no PR", async () => {
    const { run, calls } = scripted("[]", JSON.stringify([pr({ number: 77 })]));
    const res = await new GhProvider(run).fetch("/r/api", "feat/PROJ-1", "PROJ-1");

    expect(calls).toHaveLength(2);
    expect(calls[1].args).toEqual([
      "pr", "list", "--search", "PROJ-1 in:title", "--state", "all", "--limit", "10", "--json", PR_JSON_FIELDS,
    ]);
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({ number: 77 }) });
  });

  it("goes straight to the key search when the repo has no branch", async () => {
    const { run, calls } = scripted(JSON.stringify([pr()]));
    await new GhProvider(run).fetch("/r/api", null, "PROJ-1");

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain("--search");
  });

  it("passes the 10s timeout to the runner", async () => {
    const run = vi.fn<Runner>(async () => "[]");
    await new GhProvider(run).fetch("/r/api", "b", "PROJ-1");
    expect(GH_TIMEOUT_MS).toBe(10_000);
    expect(run).toHaveBeenCalledWith("gh", expect.any(Array), { cwd: "/r/api", timeoutMs: 10_000 });
  });
});

describe("GhProvider.fetch — results", () => {
  it("reports no PR when both lookups come back empty", async () => {
    const { run } = scripted("[]", "[]");
    expect(await new GhProvider(run).fetch("/r/api", "b", "PROJ-1")).toEqual({ ok: true, facts: null });
  });

  it("prefers OPEN over MERGED when a branch has both", async () => {
    const { run } = scripted(JSON.stringify([pr({ number: 1, state: "MERGED" }), pr({ number: 2, state: "OPEN" })]));
    const res = await new GhProvider(run).fetch("/r/api", "b", "PROJ-1");
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({ number: 2, state: "OPEN" }) });
  });

  it("reports failure — not 'no PR' — when gh errors", async () => {
    const { run } = scripted(new Error("gh: command not found"));
    expect(await new GhProvider(run).fetch("/r/api", "b", "PROJ-1")).toEqual({ ok: false });
  });

  it("reports failure on unparseable stdout", async () => {
    const { run } = scripted("not json");
    expect(await new GhProvider(run).fetch("/r/api", "b", "PROJ-1")).toEqual({ ok: false });
  });

  it("reports failure when gh returns a non-array payload", async () => {
    const { run } = scripted(JSON.stringify({ message: "Not Found" }));
    expect(await new GhProvider(run).fetch("/r/api", "b", "PROJ-1")).toEqual({ ok: false });
  });
});

describe("GhProvider.fetch — review threads", () => {
  const threads = (nodes: { isResolved: boolean; isOutdated: boolean }[]) =>
    JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes } } } } });

  it("skips the GraphQL call when there is no review decision", async () => {
    const { run, calls } = scripted(JSON.stringify([pr({ reviewDecision: null })]));
    const res = await new GhProvider(run).fetch("/r/api", "b", "PROJ-1");
    expect(calls).toHaveLength(1);
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({ unresolved: null }) });
  });

  it("counts unresolved, non-outdated threads when a decision exists", async () => {
    const { run, calls } = scripted(
      JSON.stringify([pr({ reviewDecision: "CHANGES_REQUESTED" })]),
      threads([
        { isResolved: false, isOutdated: false },
        { isResolved: false, isOutdated: false },
        { isResolved: true, isOutdated: false },
        { isResolved: false, isOutdated: true },
      ]),
    );
    const res = await new GhProvider(run).fetch("/r/api", "b", "PROJ-1");

    expect(calls).toHaveLength(2);
    expect(calls[1].args[0]).toBe("api");
    expect(calls[1].args).toContain("graphql");
    expect(calls[1].args).toContain("o=acme");
    expect(calls[1].args).toContain("r=api");
    expect(calls[1].args).toContain("n=4821");
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({ unresolved: 2, review: "changes_requested" }) });
  });

  it("keeps the PR facts with a null count when the GraphQL call fails", async () => {
    const { run } = scripted(JSON.stringify([pr({ reviewDecision: "APPROVED" })]), new Error("rate limited"));
    const res = await new GhProvider(run).fetch("/r/api", "b", "PROJ-1");
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({ review: "approved", unresolved: null }) });
  });

  it("skips the GraphQL call when the PR url has no parseable owner/repo", async () => {
    const { run, calls } = scripted(JSON.stringify([pr({ reviewDecision: "APPROVED", url: "https://example.com/x" })]));
    const res = await new GhProvider(run).fetch("/r/api", "b", "PROJ-1");
    expect(calls).toHaveLength(1);
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({ unresolved: null }) });
  });
});

describe("ghAvailable", () => {
  it("is true when gh auth status succeeds", async () => {
    const { run, calls } = scripted("Logged in to github.com");
    expect(await ghAvailable(run)).toBe(true);
    expect(calls[0].args).toEqual(["auth", "status"]);
  });

  it("is false when gh is missing or unauthenticated", async () => {
    const { run } = scripted(new Error("not logged in"));
    expect(await ghAvailable(run)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/pr/provider.test.ts`
Expected: FAIL — cannot resolve `src/engine/pr/provider`.

- [ ] **Step 3: Write the implementation**

Create `src/engine/pr/provider.ts`:

```ts
import { execFile } from "child_process";
import { PrFacts } from "../../types";
import { GhPr, parseRepoFromUrl, pickPr, toPrFacts } from "./facts";

/** Every field we need, in one call. Verified against gh 2.89.0 — `pr list --json`
 * exposes the same rollup and review fields as `pr view --json`. */
export const PR_JSON_FIELDS =
  "number,url,title,state,isDraft,headRefName,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup";

export const GH_TIMEOUT_MS = 10_000;

const THREADS_QUERY =
  "query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){" +
  "reviewThreads(first:100){nodes{isResolved isOutdated}}}}}";

/** `ok: false` means the attempt failed; `ok: true, facts: null` means there is
 * genuinely no PR. The caller needs the difference to decide whether to keep a
 * previous value and flag an error. */
export type FetchResult = { ok: true; facts: PrFacts | null } | { ok: false };

/** Spawning, injected — so tests never fork a process. Resolves stdout, rejects
 * on non-zero exit or timeout. */
export type Runner = (
  file: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<string>;

export const execRunner: Runner = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout.toString()),
    );
  });

export interface PrProvider {
  fetch(repoPath: string, branch: string | null, key: string): Promise<FetchResult>;
}

/** Is `gh` installed and logged in? Probed once per Deck session; a false answer
 * turns PR facts off with a footer note rather than an error. */
export async function ghAvailable(run: Runner = execRunner): Promise<boolean> {
  try {
    await run("gh", ["auth", "status"], { cwd: process.cwd(), timeoutMs: GH_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

export class GhProvider implements PrProvider {
  constructor(private readonly run: Runner = execRunner) {}

  async fetch(repoPath: string, branch: string | null, key: string): Promise<FetchResult> {
    let chosen: GhPr | undefined;
    try {
      // The live branch is exact, and correct for Address PR runs too — the agent
      // checked out the PR's own head. The key search only covers a PR opened from
      // a branch Agent Flow didn't name.
      if (branch) chosen = pickPr(await this.list(repoPath, ["--head", branch]));
      if (!chosen) chosen = pickPr(await this.list(repoPath, ["--search", `${key} in:title`]));
    } catch {
      return { ok: false };
    }
    if (!chosen) return { ok: true, facts: null };

    const unresolved = chosen.reviewDecision ? await this.unresolved(repoPath, chosen) : null;
    return { ok: true, facts: toPrFacts(chosen, unresolved) };
  }

  private async list(repoPath: string, selector: string[]): Promise<GhPr[]> {
    const out = await this.run(
      "gh",
      ["pr", "list", ...selector, "--state", "all", "--limit", "10", "--json", PR_JSON_FIELDS],
      { cwd: repoPath, timeoutMs: GH_TIMEOUT_MS },
    );
    const parsed = JSON.parse(out) as unknown;
    if (!Array.isArray(parsed)) throw new Error("gh pr list: expected an array");
    return parsed as GhPr[];
  }

  /** Unresolved review-thread count, or null when we cannot get one. A failure
   * here never discards the PR facts we already have. */
  private async unresolved(repoPath: string, pr: GhPr): Promise<number | null> {
    const loc = pr.url ? parseRepoFromUrl(pr.url) : null;
    if (!loc || typeof pr.number !== "number") return null;
    try {
      const out = await this.run(
        "gh",
        ["api", "graphql", "-f", `query=${THREADS_QUERY}`, "-F", `o=${loc.owner}`, "-F", `r=${loc.repo}`, "-F", `n=${pr.number}`],
        { cwd: repoPath, timeoutMs: GH_TIMEOUT_MS },
      );
      const nodes = (JSON.parse(out) as {
        data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: { isResolved?: boolean; isOutdated?: boolean }[] } } } };
      }).data?.repository?.pullRequest?.reviewThreads?.nodes;
      if (!Array.isArray(nodes)) return null;
      return nodes.filter((n) => !n.isResolved && !n.isOutdated).length;
    } catch {
      return null;
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/pr/provider.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/pr/provider.ts test/unit/engine/pr/provider.test.ts
git commit -m "feat(pr): resolve a repo's PR through the gh CLI"
```

---

### Task 4: The out-of-band refresh queue

**Files:**
- Create: `src/engine/pr/queue.ts`
- Test: `test/unit/engine/pr/queue.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class RefreshQueue` with `constructor(limit = 4)`, `push(key: string, work: () => Promise<void>): void`, `readonly inFlight: number`, `readonly pending: number`, `idle(): Promise<void>`, `clear(): void`.

Why this exists: a 9s `gh` call under a 6s tick would otherwise be issued three times over, and a first-open with a dozen stale repos would fork a dozen processes at once.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/engine/pr/queue.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { RefreshQueue } from "../../../../src/engine/pr/queue";

/** A promise you resolve by hand, so concurrency is observable without timers. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("RefreshQueue", () => {
  it("starts work immediately", async () => {
    const q = new RefreshQueue();
    const work = vi.fn(async () => {});
    q.push("a", work);
    await flush();
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("ignores a second push for a key already in flight", async () => {
    const q = new RefreshQueue();
    const d = deferred();
    const work = vi.fn(() => d.promise);
    q.push("a", work);
    await flush();
    q.push("a", work);
    q.push("a", work);
    await flush();
    expect(work).toHaveBeenCalledTimes(1);
    expect(q.inFlight).toBe(1);
    d.resolve();
    await q.idle();
  });

  it("accepts the same key again once the first call has settled", async () => {
    const q = new RefreshQueue();
    const work = vi.fn(async () => {});
    q.push("a", work);
    await q.idle();
    q.push("a", work);
    await q.idle();
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("runs different keys concurrently up to the limit", async () => {
    const q = new RefreshQueue(2);
    const ds = [deferred(), deferred(), deferred()];
    const started: string[] = [];
    ["a", "b", "c"].forEach((k, i) => q.push(k, () => { started.push(k); return ds[i].promise; }));
    await flush();

    expect(started).toEqual(["a", "b"]);
    expect(q.inFlight).toBe(2);
    expect(q.pending).toBe(1);

    ds[0].resolve();
    await flush();
    expect(started).toEqual(["a", "b", "c"]);

    ds[1].resolve();
    ds[2].resolve();
    await q.idle();
  });

  it("frees a slot when work rejects, and never rethrows", async () => {
    const q = new RefreshQueue(1);
    const after = vi.fn(async () => {});
    q.push("a", async () => { throw new Error("boom"); });
    q.push("b", after);
    await q.idle();
    expect(after).toHaveBeenCalledTimes(1);
    expect(q.inFlight).toBe(0);
  });

  it("idle resolves immediately on an empty queue", async () => {
    await expect(new RefreshQueue().idle()).resolves.toBeUndefined();
  });

  it("clear drops pending work but lets in-flight work settle", async () => {
    const q = new RefreshQueue(1);
    const d = deferred();
    const never = vi.fn(async () => {});
    q.push("a", () => d.promise);
    await flush();
    q.push("b", never);
    expect(q.pending).toBe(1);

    q.clear();
    expect(q.pending).toBe(0);
    d.resolve();
    await q.idle();
    expect(never).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/pr/queue.test.ts`
Expected: FAIL — cannot resolve `src/engine/pr/queue`.

- [ ] **Step 3: Write the implementation**

Create `src/engine/pr/queue.ts`:

```ts
type Job = { key: string; work: () => Promise<void> };

/**
 * Schedules out-of-band refreshes so a Deck tick never awaits a subprocess.
 * Two bounds: one in-flight job per key (a slow call is not re-issued by the next
 * tick), and a hard concurrency cap (a first open with a dozen stale repos must
 * not fork a dozen processes). Never rejects — a failing job frees its slot.
 */
export class RefreshQueue {
  private readonly active = new Set<string>();
  private readonly queued: Job[] = [];
  private waiters: (() => void)[] = [];

  constructor(private readonly limit = 4) {}

  get inFlight(): number {
    return this.active.size;
  }

  get pending(): number {
    return this.queued.length;
  }

  /** Enqueue work for `key`. A no-op when that key is already active or queued. */
  push(key: string, work: () => Promise<void>): void {
    if (this.active.has(key) || this.queued.some((j) => j.key === key)) return;
    this.queued.push({ key, work });
    this.pump();
  }

  /** Resolves once nothing is active or queued. */
  idle(): Promise<void> {
    if (this.active.size === 0 && this.queued.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  /** Drop everything not yet started. In-flight work is left to settle — killing a
   * subprocess mid-flight would risk a half-written cache entry. */
  clear(): void {
    this.queued.length = 0;
    this.settle();
  }

  private pump(): void {
    while (this.queued.length > 0 && this.active.size < this.limit) {
      const job = this.queued.shift() as Job;
      this.active.add(job.key);
      void job
        .work()
        .catch(() => {
          /* a job owns its own errors; the queue only owns the slot */
        })
        .then(() => {
          this.active.delete(job.key);
          this.pump();
          this.settle();
        });
    }
  }

  private settle(): void {
    if (this.active.size > 0 || this.queued.length > 0) return;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/pr/queue.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/pr/queue.ts test/unit/engine/pr/queue.test.ts
git commit -m "feat(pr): bound refresh fan-out with an in-flight-deduping queue"
```

---

### Task 5: The status ladder

**Files:**
- Modify: `src/engine/status.ts` (`BucketInput` at lines 8–13, `deriveBucket` at 19–33, `buildRunStatus` at 66–86)
- Test: `test/unit/engine/status.test.ts` (extend; do not rewrite the existing describes)

**Interfaces:**
- Consumes: `PrEntryMap` from `src/types` (Task 1).
- Produces: `prSignals(prs: PrEntryMap): { open: boolean; blocked: boolean; merged: boolean }`; `BucketInput` gains `prBlocked?: boolean` and `prMerged?: boolean`; `buildRunStatus` gains a trailing `prs: PrEntryMap = {}` parameter and sets `RunStatus.prs`.

**Note on the existing tests:** two current cases assert the *old* precedence and must be updated, not deleted — `"keeps a working agent in In-progress even in a review status (live beats review)"` stays true (Jira review status is still outranked by `working`), but the docstring above `deriveBucket` must be rewritten because `prBlocked` now outranks `working`. Keep `"keeps a working agent in In-progress even with an open PR"` — an open PR alone is not blocked.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/engine/status.test.ts`. Add `prSignals` to the import from `../../../src/engine/status`, and add `PrEntryMap, PrFacts` to the type import from `../../../src/types`.

```ts
const prFacts = (over: Partial<PrFacts> = {}): PrFacts => ({
  number: 1, url: "https://github.com/o/r/pull/1", title: "t", state: "OPEN", isDraft: false,
  ci: { passing: 2, pending: 0, failing: [] }, review: "none", unresolved: null,
  mergeable: "clean", ciAdvisory: false, ...over,
});
const entries = (...facts: (PrFacts | null)[]): PrEntryMap =>
  Object.fromEntries(facts.map((f, i) => [`repo${i}`, { facts: f, fetchedAt: 0 }]));

describe("deriveBucket with PR signals", () => {
  it("promotes a blocked PR into Needs you even while the agent is working", () => {
    expect(deriveBucket({ agentState: "working", prBlocked: true })).toBe("needs");
  });

  it("puts a merged PR in Done even when Jira has not caught up", () => {
    expect(deriveBucket({ jiraCategory: "indeterminate", prMerged: true })).toBe("done");
  });

  it("lets Done outrank a blocked PR", () => {
    expect(deriveBucket({ prMerged: true, prBlocked: true })).toBe("done");
  });

  it("still treats an idle agent with an open, unblocked PR as In review", () => {
    expect(deriveBucket({ agentState: "idle", prOpen: true })).toBe("review");
  });
});

describe("prSignals", () => {
  it("is all false for no entries", () => {
    expect(prSignals({})).toEqual({ open: false, blocked: false, merged: false });
  });

  it("is all false when every entry resolved to no PR", () => {
    expect(prSignals(entries(null, null))).toEqual({ open: false, blocked: false, merged: false });
  });

  it("reports open for an open non-draft PR", () => {
    expect(prSignals(entries(prFacts())).open).toBe(true);
  });

  it("does not report open for a draft PR", () => {
    expect(prSignals(entries(prFacts({ isDraft: true }))).open).toBe(false);
  });

  it("does not report open for a closed or merged PR", () => {
    expect(prSignals(entries(prFacts({ state: "CLOSED" }))).open).toBe(false);
    expect(prSignals(entries(prFacts({ state: "MERGED" }))).open).toBe(false);
  });

  it("blocks on a failing check", () => {
    expect(prSignals(entries(prFacts({ ci: { passing: 0, pending: 0, failing: [{ name: "build", url: "" }] } }))).blocked).toBe(true);
  });

  it("does not block on a failing check that is only advisory (UNSTABLE)", () => {
    const f = prFacts({ ci: { passing: 0, pending: 0, failing: [{ name: "flaky-e2e", url: "" }] }, ciAdvisory: true });
    expect(prSignals(entries(f)).blocked).toBe(false);
  });

  it("blocks on requested changes and on a conflict", () => {
    expect(prSignals(entries(prFacts({ review: "changes_requested" }))).blocked).toBe(true);
    expect(prSignals(entries(prFacts({ mergeable: "conflicting" }))).blocked).toBe(true);
  });

  it("does not block on a closed PR's stale failures", () => {
    const f = prFacts({ state: "CLOSED", ci: { passing: 0, pending: 0, failing: [{ name: "build", url: "" }] } });
    expect(prSignals(entries(f)).blocked).toBe(false);
  });

  it("blocks the whole run when any one repo is blocked", () => {
    expect(prSignals(entries(prFacts(), prFacts({ mergeable: "conflicting" }))).blocked).toBe(true);
  });

  it("reports merged only when every PR-bearing repo has merged", () => {
    expect(prSignals(entries(prFacts({ state: "MERGED" }))).merged).toBe(true);
    expect(prSignals(entries(prFacts({ state: "MERGED" }), prFacts({ state: "OPEN" }))).merged).toBe(false);
  });

  it("ignores PR-less repos when deciding merged", () => {
    expect(prSignals(entries(prFacts({ state: "MERGED" }), null)).merged).toBe(true);
  });
});
```

Then, inside the existing `describe("buildRunStatus")`, append:

```ts
  it("defaults prs to an empty map when none are passed", () => {
    expect(buildRunStatus(run, null, projRoot, NOW, true).prs).toEqual({});
  });

  it("threads PR entries through onto the status", () => {
    const prs = entries(prFacts());
    const s = buildRunStatus(run, null, projRoot, NOW, true, new Set(), prs);
    expect(s.prs).toBe(prs);
  });

  it("promotes a run with a conflicting PR into Needs you despite a working agent", () => {
    const s = buildRunStatus(run, { status: "In Progress", category: "indeterminate" }, projRoot, NOW, true, new Set(), entries(prFacts({ mergeable: "conflicting" })));
    expect(s.agent.state).toBe("working");
    expect(s.column).toBe("needs");
  });

  it("puts a run whose PR merged into Done even when Jira says in progress", () => {
    const s = buildRunStatus(run, { status: "In Progress", category: "indeterminate" }, projRoot, NOW, true, new Set(), entries(prFacts({ state: "MERGED" })));
    expect(s.column).toBe("done");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/status.test.ts`
Expected: FAIL — `prSignals` is not exported, and `buildRunStatus` takes no 7th argument.

- [ ] **Step 3: Write the implementation**

In `src/engine/status.ts`, add `PrEntryMap` to the type import from `../types`. Extend `BucketInput`:

```ts
/** Inputs to the column decision — every field observable, none required. */
export interface BucketInput {
  jiraCategory?: string | null; // "new" | "indeterminate" | "done"
  jiraStatus?: string | null; // status name, e.g. "In Review"
  agentState?: AgentState;
  prOpen?: boolean; // an open, non-draft PR exists
  prBlocked?: boolean; // a PR needs a human decision: CI, changes requested, or a conflict
  prMerged?: boolean; // every PR-bearing repo has merged
}
```

Replace `deriveBucket` and its docstring:

```ts
/**
 * Decide which board column a run belongs in. Precedence, most-decisive first:
 *   done (a merged PR, or Jira done) → "waiting on a human" (the agent's needs-you
 *   signal, or a blocked PR) → the live "working" signal → review (an open PR /
 *   Jira review status) → else "progress" as the in-flight catch-all.
 *
 * Two rungs are worth spelling out. A **blocked PR outranks a working agent**: an
 * agent cannot know CI failed until something tells it, so the card belongs where
 * you will see it, green dot and all. A working agent still outranks the *review
 * stage*, so an agent addressing feedback reads as In progress rather than parked
 * in Review.
 */
export function deriveBucket(i: BucketInput): DeckColumn {
  if (i.prMerged || i.jiraCategory === "done") return "done";
  if (i.agentState === "needs-you" || i.prBlocked) return "needs";
  if (i.agentState === "working") return "progress";
  if (i.prOpen || isReviewStatus(i.jiraStatus)) return "review";
  return "progress";
}

/**
 * Reduce a run's per-repo PR entries to the three booleans the ladder needs, each
 * the worst state across the run. `blocked` only considers OPEN PRs — a closed
 * PR's stale red checks must not pin a card in Needs you forever. `merged` needs
 * *every* PR-bearing repo: a run whose backend landed and whose frontend has not
 * is not done. Pure.
 */
export function prSignals(prs: PrEntryMap): { open: boolean; blocked: boolean; merged: boolean } {
  const all = Object.values(prs)
    .map((e) => e.facts)
    .filter((f): f is NonNullable<typeof f> => f !== null);
  if (all.length === 0) return { open: false, blocked: false, merged: false };
  const open = all.some((f) => f.state === "OPEN" && !f.isDraft);
  const blocked = all.some(
    (f) =>
      f.state === "OPEN" &&
      ((f.ci.failing.length > 0 && !f.ciAdvisory) || f.review === "changes_requested" || f.mergeable === "conflicting"),
  );
  return { open, blocked, merged: all.every((f) => f.state === "MERGED") };
}
```

Then extend `buildRunStatus` — add the parameter, compute the signals, and replace Task 1's `prs: {}` placeholder in the return with the real map:

```ts
export function buildRunStatus(
  run: Run,
  jira: JiraInfo | null,
  projectsRoot: string,
  nowMs: number,
  liveSignal = true,
  openIdentities: ReadonlySet<string> = new Set(),
  prs: PrEntryMap = {},
): RunStatus {
  const repos = run.repos.map((r) => gitState(r.name, r.path));
  const agent = liveSignal
    ? mostActive(run.repos.map((r) => readAgentActivity(projectsRoot, r.path, r.branch ?? null, nowMs)))
    : UNKNOWN_AGENT;
  const pr = prSignals(prs);
  const column = deriveBucket({
    jiraCategory: jira?.category ?? null,
    jiraStatus: jira?.status ?? null,
    agentState: agent.state,
    prOpen: pr.open,
    prBlocked: pr.blocked,
    prMerged: pr.merged,
  });
  const target = runTarget(run);
  const windowOpen = target ? openIdentities.has(canon(target)) : false;
  return { run, column, jiraStatus: jira?.status ?? null, jiraCategory: jira?.category ?? null, repos, agent, windowOpen, prs };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/status.test.ts`
Expected: PASS, including every pre-existing case.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean. `buildRunStatus` is the only constructor of a `RunStatus`, and its new parameter is optional, so no call site changes.

- [ ] **Step 6: Commit**

```bash
git add src/engine/status.ts test/unit/engine/status.test.ts
git commit -m "feat(deck): let a blocked PR promote its card into Needs you"
```

---

### Task 6: The two settings

**Files:**
- Modify: `package.json` (`contributes.configuration.properties`)
- Modify: `src/config.ts` (`AgentFlowConfig` interface, `getConfig` return)
- Test: `test/unit/config.test.ts` (extend)

**Interfaces:**
- Consumes: nothing.
- Produces: `AgentFlowConfig.prFacts: boolean` and `AgentFlowConfig.prFactsTtlSeconds: number`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/config.test.ts`. It already imports `setConfig` from `../_mocks/vscode`; keys are passed **without** the `agentFlow.` prefix, because `getConfig` reads them off a scoped `WorkspaceConfiguration`. `resetVscodeMocks()` clears the store between tests via `test/_setup.ts`, so no manual cleanup is needed.

```ts
describe("PR facts settings", () => {
  it("defaults prFacts on and the TTL to 120 seconds", () => {
    const c = getConfig();
    expect(c.prFacts).toBe(true);
    expect(c.prFactsTtlSeconds).toBe(120);
  });

  it("honours prFacts set to false", () => {
    setConfig({ prFacts: false });
    expect(getConfig().prFacts).toBe(false);
  });

  it("honours a custom TTL", () => {
    setConfig({ prFactsTtlSeconds: 300 });
    expect(getConfig().prFactsTtlSeconds).toBe(300);
  });

  it("floors an absurdly small TTL at 30s so a typo cannot hammer the GitHub API", () => {
    setConfig({ prFactsTtlSeconds: 1 });
    expect(getConfig().prFactsTtlSeconds).toBe(30);
  });
});
```

Also add to the existing `describe("package.json ⇄ config constants")` block, which asserts schema/default parity for every other setting:

```ts
  it("declares prFacts defaulting to true and prFactsTtlSeconds to 120 with a floor of 30", () => {
    expect(props["agentFlow.prFacts"].default).toBe(true);
    const ttl = props["agentFlow.prFactsTtlSeconds"] as { default?: unknown; minimum?: unknown };
    expect(ttl.default).toBe(120);
    expect(ttl.minimum).toBe(30);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/config.test.ts`
Expected: FAIL — `prFacts` is undefined.

- [ ] **Step 3: Add the settings to `package.json`**

Insert into `contributes.configuration.properties`, after `agentFlow.trackOpenWindows`:

```json
"agentFlow.prFacts": {
  "type": "boolean",
  "default": true,
  "markdownDescription": "Read each in-flight task's pull-request state from GitHub with the `gh` CLI, and show it on the Deck's cards — CI, review and mergeability. Requires `gh` on your PATH and logged in (`gh auth login`); Agent Flow stores no GitHub credentials of its own. Off = the Deck's git + Jira backbone only."
},
"agentFlow.prFactsTtlSeconds": {
  "type": "number",
  "default": 120,
  "minimum": 30,
  "markdownDescription": "How stale a cached pull-request fact may be before the Deck re-reads it from GitHub. Only ever fetched while the Deck is open. Lower values cost more GitHub API calls; the floor is 30 seconds."
}
```

- [ ] **Step 4: Add the fields to `src/config.ts`**

In the `AgentFlowConfig` interface, after `trackOpenWindows: boolean;`:

```ts
  // Read PR/CI state from GitHub via the `gh` CLI and show it on the Deck's cards.
  prFacts: boolean;
  // How stale a cached PR fact may be before the Deck re-fetches it. Floored at 30s.
  prFactsTtlSeconds: number;
```

In the `getConfig` return object, after `trackOpenWindows`:

```ts
    prFacts: c.get<boolean>("prFacts") ?? true,
    prFactsTtlSeconds: Math.max(30, c.get<number>("prFactsTtlSeconds") ?? 120),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/unit/config.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json src/config.ts test/unit/config.test.ts
git commit -m "feat(config): add agentFlow.prFacts and prFactsTtlSeconds"
```

---

### Task 7: Wire the slow tier into the Deck panel

**Files:**
- Modify: `src/deckView.ts`
- Modify: `src/types.ts` (`InboundMessage`, `OutboundMessage`)
- Test: `test/unit/deckView.test.ts` (extend)

**Interfaces:**
- Consumes: `readPrEntries`, `writePrEntry`, `removePrEntries`, `isStale`, `defaultPrFactsDir` (Task 2); `GhProvider`, `ghAvailable`, `PrProvider` (Task 3); `RefreshQueue` (Task 4); `buildRunStatus` with its 7th parameter (Task 5); `getConfig().prFacts` / `.prFactsTtlSeconds` (Task 6).
- Produces: `OutboundMessage` member `deck:runs` gains `prFacts: boolean` and `ghNote: string | null`; `InboundMessage` gains `{ type: "deck:setPrFacts"; on: boolean }`.

- [ ] **Step 1: Write the failing tests**

First read `test/unit/deckView.test.ts` in full — it mocks every engine module the panel imports, and your new mocks must join that block. Add to the `vi.hoisted` object and the mock list:

```ts
// inside the existing vi.hoisted({...}) object
  prEntries: {} as Record<string, unknown>,
  writePrEntry: vi.fn(),
  removePrEntries: vi.fn(),
  prFetch: vi.fn(async (_p: string, _b: string | null, _k: string) => ({ ok: true as const, facts: null })),
  ghAvailable: vi.fn(async () => true),
  prFacts: true,
  ttlSeconds: 120,
```

```ts
vi.mock("../../src/engine/pr/store", () => ({
  defaultPrFactsDir: () => "/prfacts",
  readPrEntries: () => h.prEntries,
  writePrEntry: h.writePrEntry,
  removePrEntries: h.removePrEntries,
  // Exercise the real staleness rule rather than restating it here.
  isStale: (e: { fetchedAt: number } | undefined, ttl: number, now: number) => !e || now - e.fetchedAt >= ttl,
}));
vi.mock("../../src/engine/pr/provider", () => ({
  ghAvailable: h.ghAvailable,
  GhProvider: class { fetch = h.prFetch; },
}));
```

and change the existing config mock to serve the two new settings:

```ts
vi.mock("../../src/config", () => ({
  getConfig: () => ({ baseUrl: "https://jira", project: "PROJ", prFacts: h.prFacts, prFactsTtlSeconds: h.ttlSeconds }),
}));
```

Extend `beforeEach` with `h.prEntries = {}; h.prFacts = true; h.ttlSeconds = 120; h.writePrEntry.mockClear(); h.removePrEntries.mockClear(); h.prFetch.mockClear().mockResolvedValue({ ok: true, facts: null }); h.ghAvailable.mockClear().mockResolvedValue(true);`.

Then append:

```ts
describe("DeckPanel PR facts", () => {
  const settled = () => new Promise<void>((r) => setTimeout(r, 0));

  it("passes cached PR entries to the status builder", async () => {
    h.prEntries = { svc: { facts: null, fetchedAt: Date.now() } };
    show();
    await settled();
    expect(h.buildRunStatus).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.any(String), expect.any(Number),
      expect.any(Boolean), expect.any(Set), h.prEntries,
    );
  });

  it("does not await the fetch — a tick posts runs before gh returns", async () => {
    let release!: () => void;
    h.prFetch.mockImplementation(() => new Promise((res) => { release = () => res({ ok: true, facts: null }); }));
    show();
    await settled();
    expect(posts(lastPanel()).some((m) => m.type === "deck:runs")).toBe(true);
    release();
  });

  it("fetches a repo with no cached entry", async () => {
    show();
    await settled();
    expect(h.prFetch).toHaveBeenCalledWith("/r/svc", "b", "PROJ-1");
    expect(h.writePrEntry).toHaveBeenCalledWith("/prfacts", "PROJ-1", "svc", expect.objectContaining({ facts: null, fetchedAt: expect.any(Number) }));
  });

  it("does not refetch an entry inside its TTL", async () => {
    h.prEntries = { svc: { facts: null, fetchedAt: Date.now() } };
    show();
    await settled();
    expect(h.prFetch).not.toHaveBeenCalled();
  });

  it("refetches an entry past its TTL", async () => {
    h.prEntries = { svc: { facts: null, fetchedAt: Date.now() - 200_000 } };
    show();
    await settled();
    expect(h.prFetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the previous facts and flags an error when a fetch fails", async () => {
    const stale = { number: 5, url: "u", title: "t", state: "OPEN", isDraft: false, ci: { passing: 0, pending: 0, failing: [] }, review: "none", unresolved: null, mergeable: "clean", ciAdvisory: false };
    h.prEntries = { svc: { facts: stale, fetchedAt: Date.now() - 200_000 } };
    h.prFetch.mockResolvedValue({ ok: false });
    show();
    await settled();
    expect(h.writePrEntry).toHaveBeenCalledWith("/prfacts", "PROJ-1", "svc", expect.objectContaining({ facts: stale, error: true }));
  });

  it("fetches nothing when prFacts is off, and reports it to the webview", async () => {
    h.prFacts = false;
    show();
    await settled();
    expect(h.prFetch).not.toHaveBeenCalled();
    expect(posts(lastPanel()).find((m) => m.type === "deck:runs")).toMatchObject({ prFacts: false });
  });

  it("fetches nothing and notes why when gh is unavailable", async () => {
    h.ghAvailable.mockResolvedValue(false);
    show();
    await settled();
    expect(h.prFetch).not.toHaveBeenCalled();
    expect(posts(lastPanel()).find((m) => m.type === "deck:runs")!.ghNote).toMatch(/gh/i);
  });

  it("toggles prFacts from the webview", async () => {
    show();
    await settled();
    const p = lastPanel();
    await p._fire({ type: "deck:setPrFacts", on: false });
    expect(posts(p).filter((m) => m.type === "deck:runs").at(-1)).toMatchObject({ prFacts: false });
  });

  it("forgets a run's PR facts alongside its run record", async () => {
    show();
    await settled();
    await lastPanel()._fire({ type: "deck:forget", key: "PROJ-1" });
    expect(h.removePrEntries).toHaveBeenCalledWith("/prfacts", "PROJ-1");
  });

  it("skips repos with no branch and no key match rather than throwing", async () => {
    h.runs = [mkRun({ repos: [{ name: "svc", path: "/r/svc", isGit: true }] })];
    show();
    await settled();
    expect(h.prFetch).toHaveBeenCalledWith("/r/svc", null, "PROJ-1");
  });
});
```

`_fire(msg)` delivers a webview→host message and `_fireDispose()` simulates the user closing the panel; both are on the panel object returned by `makeWebviewPanel()` in `test/_mocks/vscode.ts`, which `lastPanel()` already returns. Note that `_fire` returns whatever the handler returns, so `await p._fire(...)` awaits the host's async handling.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: FAIL — `buildRunStatus` called with 6 args, no `prFacts` on the posted message.

- [ ] **Step 3: Extend the message types**

In `src/types.ts`, add to the `deck:runs` member of `OutboundMessage`: `prFacts: boolean; ghNote: string | null;`. Add to `InboundMessage`: `| { type: "deck:setPrFacts"; on: boolean }`.

- [ ] **Step 4: Wire the panel**

In `src/deckView.ts`, add imports:

```ts
import { defaultPrFactsDir, isStale, readPrEntries, removePrEntries, writePrEntry } from "./engine/pr/store";
import { GhProvider, PrProvider, ghAvailable } from "./engine/pr/provider";
import { RefreshQueue } from "./engine/pr/queue";
import { PrEntryMap } from "./types";
```

Add fields beside `liveSignal`:

```ts
  private prFacts = true;
  private readonly prQueue = new RefreshQueue();
  private readonly pr: PrProvider = new GhProvider();
  /** null until probed; false disables PR facts with a footer note. */
  private ghOk: boolean | null = null;
```

Add the probe and the enqueue, then read entries in `buildAll`:

```ts
  /** Probe `gh` once per panel: PR facts are worthless without it, and a missing
   * binary is a config fact, not a per-tick failure. */
  private async ghReady(): Promise<boolean> {
    if (!this.prFacts) return false;
    if (this.ghOk === null) this.ghOk = await ghAvailable();
    return this.ghOk;
  }

  /** Queue a stale repo's refresh. Deliberately not awaited by the caller: a
   * hanging `gh` must never stall the git and transcript reads. */
  private enqueuePr(key: string, repo: { name: string; path: string }, branch: string | null, previous?: PrEntry): void {
    this.prQueue.push(repo.path, async () => {
      const res = await this.pr.fetch(repo.path, branch, key);
      const entry: PrEntry = res.ok
        ? { facts: res.facts, fetchedAt: Date.now() }
        : { facts: previous?.facts ?? null, fetchedAt: Date.now(), error: true };
      writePrEntry(defaultPrFactsDir(), key, repo.name, entry);
    });
  }
```

(Add `PrEntry` to the `./types` import.)

In `buildAll`, after the Jira lookup and before `out.push`:

```ts
      const prs: PrEntryMap = this.prFacts ? readPrEntries(defaultPrFactsDir(), run.key) : {};
      if (ghReady) {
        const ttlMs = getConfig().prFactsTtlSeconds * 1000;
        for (const repo of run.repos) {
          if (isStale(prs[repo.name], ttlMs, now)) {
            this.enqueuePr(run.key, repo, repo.branch ?? null, prs[repo.name]);
          }
        }
      }
      out.push(buildRunStatus(run, jira, projectsRoot, now, this.liveSignal, openIdentities, prs));
```

Hoist `const ghReady = await this.ghReady();` next to the existing `const authed = …` so it is probed once per refresh, not once per run.

In `refresh`, post the two new fields:

```ts
      this.post({
        type: "deck:runs",
        runs,
        liveSignal: this.liveSignal,
        prFacts: this.prFacts,
        ghNote: this.prFacts && this.ghOk === false ? "gh not found or not signed in — PR facts off" : null,
      });
```

Add the message case, next to `deck:setLive`:

```ts
      case "deck:setPrFacts":
        this.prFacts = m.on;
        if (m.on) this.ghOk = null; // re-probe: the user may have run `gh auth login`
        await this.refresh();
        break;
```

Extend `deck:forget` with `removePrEntries(defaultPrFactsDir(), m.key);`, and `stopPolling` with `this.prQueue.clear();`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all green. `DeckApp.test.tsx` may fail on the now-required `prFacts`/`ghNote` message fields — if so, add them to that file's `runsMsg` helper as `prFacts: true, ghNote: null` and to `mkStatus` as `prs: {}`.

- [ ] **Step 7: Commit**

```bash
git add src/deckView.ts src/types.ts test/unit/deckView.test.ts test/webview/DeckApp.test.tsx
git commit -m "feat(deck): refresh PR facts on a TTL tier outside the render tick"
```

---

### Task 8: The PR block on the card

**Files:**
- Modify: `src/webview/DeckApp.tsx` (`stateView` at 25–34, `Card` at 50–108, `DeckApp` header at 147–164, legend at 194–199)
- Modify: `src/webview/deckStyles.ts` (append rules)
- Test: `test/webview/DeckApp.test.tsx` (extend)

**Interfaces:**
- Consumes: `PrEntryMap`, `PrFacts` from `src/types` (Task 1); the `deck:runs` message fields and `deck:setPrFacts` (Task 7).
- Produces: nothing consumed by later tasks.

**Layout** — one block per repo *that has a PR*, under the repo chips, headed by the repo name only when more than one repo has one:

```
pr      #4821
ci      ✗ build-backend, lint
review  changes · 3 open
merge   blocked
```

- [ ] **Step 1: Write the failing tests**

In `test/webview/DeckApp.test.tsx`: widen the type import to `import type { OutboundMessage, PrFacts, RunStatus } from "../../src/types";`, add `prs: {}` to `mkStatus`, and add `prFacts: true, ghNote: null` to `runsMsg`. Then add a facts helper and the tests:

```ts
const prFacts = (over: Partial<PrFacts> = {}): PrFacts => ({
  number: 4821, url: "https://github.com/acme/svc/pull/4821", title: "Fix export",
  state: "OPEN", isDraft: false, ci: { passing: 6, pending: 0, failing: [] },
  review: "none", unresolved: null, mergeable: "clean", ciAdvisory: false, ...over,
});

describe("DeckApp PR block", () => {
  it("renders no block for a run with no PR entries", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    expect(screen.queryByText("pr")).toBeNull();
  });

  it("renders no block for a repo whose entry resolved to no PR", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ prs: { svc: { facts: null, fetchedAt: 1 } } })]));
    expect(screen.queryByText("pr")).toBeNull();
  });

  it("shows the PR number, failing checks, review state and mergeability", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({
      prs: { svc: { facts: prFacts({
        ci: { passing: 4, pending: 0, failing: [{ name: "build-backend", url: "https://ci/1" }, { name: "lint", url: "https://ci/2" }] },
        review: "changes_requested", unresolved: 3, mergeable: "blocked",
      }), fetchedAt: 1 } },
    })]));

    expect(screen.getByText("#4821")).toBeTruthy();
    expect(screen.getByText("build-backend")).toBeTruthy();
    expect(screen.getByText("lint")).toBeTruthy();
    expect(screen.getByText(/changes/)).toBeTruthy();
    expect(screen.getByText(/3 open/)).toBeTruthy();
    expect(screen.getByText("blocked")).toBeTruthy();
  });

  it("omits the thread count when unresolved is null", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ prs: { svc: { facts: prFacts({ review: "changes_requested", unresolved: null }), fetchedAt: 1 } } })]));
    expect(screen.queryByText(/open$/)).toBeNull();
  });

  it("shows a passing-check count when nothing is failing", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ prs: { svc: { facts: prFacts(), fetchedAt: 1 } } })]));
    expect(screen.getByText(/6 passing/)).toBeTruthy();
  });

  it("heads each block with its repo name only when more than one repo has a PR", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ prs: { svc: { facts: prFacts(), fetchedAt: 1 } } })]));
    expect(screen.queryByText("svc", { selector: ".pr-repo" })).toBeNull();

    host(runsMsg([mkStatus({ prs: {
      svc: { facts: prFacts(), fetchedAt: 1 },
      web: { facts: prFacts({ number: 99, url: "https://github.com/acme/web/pull/99" }), fetchedAt: 1 },
    } })]));
    expect(screen.getByText("svc", { selector: ".pr-repo" })).toBeTruthy();
    expect(screen.getByText("web", { selector: ".pr-repo" })).toBeTruthy();
  });

  it("opens the PR externally from its number", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ prs: { svc: { facts: prFacts(), fetchedAt: 1 } } })]));
    fireEvent.click(screen.getByText("#4821"));
    expect(sent).toHaveBeenCalledWith({ type: "openExternal", url: "https://github.com/acme/svc/pull/4821" });
  });

  it("opens a failing check's run externally", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ prs: { svc: { facts: prFacts({ ci: { passing: 0, pending: 0, failing: [{ name: "build", url: "https://ci/run/7" }] } }), fetchedAt: 1 } } })]));
    fireEvent.click(screen.getByText("build"));
    expect(sent).toHaveBeenCalledWith({ type: "openExternal", url: "https://ci/run/7" });
  });

  it("does not linkify a failing check with no url", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ prs: { svc: { facts: prFacts({ ci: { passing: 0, pending: 0, failing: [{ name: "build", url: "" }] } }), fetchedAt: 1 } } })]));
    fireEvent.click(screen.getByText("build"));
    expect(sent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "openExternal" }));
  });
});

describe("DeckApp PR-facts chrome", () => {
  it("says merged only when a PR actually merged", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ column: "done", prs: { svc: { facts: prFacts({ state: "MERGED" }), fetchedAt: 1 } } })]));
    expect(screen.getByText("merged")).toBeTruthy();
  });

  it("says done for a Jira-done run with no merged PR", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ column: "done" })]));
    expect(screen.getByText("done")).toBeTruthy();
    expect(screen.queryByText("merged")).toBeNull();
  });

  it("toggles PR facts", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    fireEvent.click(screen.getByText("PR facts"));
    expect(sent).toHaveBeenCalledWith({ type: "deck:setPrFacts", on: false });
  });

  it("shows the gh note when the host sends one", () => {
    render(<DeckApp />);
    host({ type: "deck:runs", runs: [mkStatus()], liveSignal: true, prFacts: true, ghNote: "gh not found or not signed in — PR facts off" });
    expect(screen.getByText(/gh not found/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/webview/DeckApp.test.tsx`
Expected: FAIL — no PR block is rendered.

- [ ] **Step 3: Implement the block**

In `src/webview/DeckApp.tsx`, add `PrEntryMap`, `PrFacts` to the type import. Replace `stateView` so `merged` needs a merged PR:

```ts
type Tone = "working" | "idle" | "needs" | "parked" | "merged";

/** Did any of this run's PRs actually land? `column === "done"` alone can mean
 * only that Jira says done, which is not the same claim. */
function anyMerged(prs: PrEntryMap): boolean {
  return Object.values(prs).some((e) => e.facts?.state === "MERGED");
}

function stateView(r: RunStatus, live: boolean): { text: string; tone: Tone } {
  if (r.column === "done") return { text: anyMerged(r.prs) ? "merged" : "done", tone: "merged" };
  if (!live || r.agent.state === "unknown") return { text: "parked · git + Jira only", tone: "parked" };
  switch (r.agent.state) {
    case "working": return { text: `working · ${timeAgo(r.agent.lastActivityMs)}`, tone: "working" };
    case "needs-you": return { text: `ended turn · ${timeAgo(r.agent.lastActivityMs)}`, tone: "needs" };
    case "idle": return { text: `idle · ${timeAgo(r.agent.lastActivityMs)}`, tone: "idle" };
    default: return { text: "parked · git + Jira only", tone: "parked" };
  }
}

const REVIEW_TEXT: Record<PrFacts["review"], string> = {
  approved: "approved",
  changes_requested: "changes",
  review_required: "required",
  none: "pending",
};

function PrBlock({ repo, f, showRepo }: { repo: string; f: PrFacts; showRepo: boolean }): JSX.Element {
  const ci = f.ci.failing.length > 0
    ? <span className="pr-bad">
        ✗ {f.ci.failing.map((c, i) => (
          <React.Fragment key={c.name}>
            {i > 0 && ", "}
            {c.url
              ? <button className="pr-link" title={c.url} onClick={() => send({ type: "openExternal", url: c.url })}>{c.name}</button>
              : <span>{c.name}</span>}
          </React.Fragment>
        ))}
      </span>
    : f.ci.pending > 0
      ? <span className="pr-wait">· {f.ci.pending} running</span>
      : <span className="pr-ok">✓ {f.ci.passing} passing</span>;

  return (
    <div className="pr-block">
      {showRepo && <div className="pr-repo">{repo}</div>}
      <div className="pr-line">
        <span className="pr-lbl">pr</span>
        <button className="pr-link" title={f.title} onClick={() => send({ type: "openExternal", url: f.url })}>
          #{f.number}
        </button>
        {f.isDraft && <span className="pr-draft">draft</span>}
      </div>
      <div className="pr-line"><span className="pr-lbl">ci</span>{ci}</div>
      <div className="pr-line">
        <span className="pr-lbl">review</span>
        <span className={f.review === "changes_requested" ? "pr-warn" : f.review === "approved" ? "pr-ok" : ""}>
          {REVIEW_TEXT[f.review]}{f.unresolved !== null && f.unresolved > 0 ? ` · ${f.unresolved} open` : ""}
        </span>
      </div>
      <div className="pr-line">
        <span className="pr-lbl">merge</span>
        <span className={f.mergeable === "conflicting" ? "pr-warn" : f.mergeable === "clean" ? "pr-ok" : ""}>
          {f.mergeable === "conflicting" ? "conflicts" : f.mergeable}
        </span>
      </div>
    </div>
  );
}
```

In `Card`, immediately after the `c-repos` div:

```tsx
      {(() => {
        const withPr = Object.entries(r.prs).filter(([, e]) => e.facts !== null) as [string, { facts: PrFacts }][];
        return withPr.map(([name, e]) => (
          <PrBlock key={name} repo={name} f={e.facts} showRepo={withPr.length > 1} />
        ));
      })()}
```

In `DeckApp`, add state and wire the message:

```ts
  const [prFacts, setPrFacts] = React.useState(true);
  const [ghNote, setGhNote] = React.useState<string | null>(null);
```

inside the `deck:runs` branch: `setPrFacts(m.prFacts); setGhNote(m.ghNote);`

Add the toggle next to the Live-signal control:

```tsx
        <div className={`ctl ${prFacts ? "on" : ""}`} onClick={() => { const next = !prFacts; setPrFacts(next); send({ type: "deck:setPrFacts", on: next }); }} title="Read each task's PR state from GitHub with the gh CLI. Off → git + Jira only.">
          <span className="switch" />PR facts
        </div>
```

And in the legend, before the existing `note`:

```tsx
        {ghNote && <span className="note warn">{ghNote}</span>}
```

- [ ] **Step 4: Add the styles**

Append to `DECK_CSS` in `src/webview/deckStyles.ts`:

```css
  .pr-block { margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--hair);
    font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
  .pr-repo { color: var(--vscode-descriptionForeground); margin-bottom: 2px; }
  .pr-line { display: flex; align-items: baseline; gap: 6px; line-height: 1.5; }
  .pr-lbl { width: 42px; flex: none; color: var(--vscode-descriptionForeground); }
  .pr-link { background: none; border: 0; padding: 0; cursor: pointer;
    text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 2px; }
  .pr-ok { color: var(--c-done); }
  .pr-warn { color: var(--c-idle); }
  .pr-bad { color: var(--c-needs); }
  .pr-bad .pr-link { color: inherit; }
  .pr-wait { color: var(--vscode-descriptionForeground); }
  .pr-draft { color: var(--vscode-descriptionForeground); }
  .legend .note.warn { color: var(--c-idle); }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/webview/DeckApp.test.tsx`
Expected: PASS.

- [ ] **Step 6: Run the full suite, typecheck, and build**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/webview/DeckApp.tsx src/webview/deckStyles.ts test/webview/DeckApp.test.tsx
git commit -m "feat(deck): render each repo's PR, CI, review and merge state on its card"
```

---

### Task 9: Documentation

**Files:**
- Modify: `README.md` (the Deck section, the Settings table, Data & privacy, Requirements)
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Update the Deck section of `README.md`**

After the paragraph describing the Live signal, add:

```markdown
Each card also carries the **PR state** of every repo it touches, read from GitHub
with the `gh` CLI: the PR number, CI (failing check names link to their runs, or a
passing count), the review decision with any unresolved-thread count, and
mergeability. A PR that needs a human decision — failing required checks,
requested changes, or a conflict — pulls its card into **Needs you**, even while
the agent is still working, because an agent can't know CI broke until you tell
it. A merged PR moves the card to **Done** and is the only thing that makes a card
say *merged*. Turn it off with the **PR facts** toggle or `agentFlow.prFacts`, and
cards fall back to the git + Jira backbone.
```

- [ ] **Step 2: Update the Settings table**

Add two rows, after `agentFlow.trackOpenWindows`:

```markdown
| `agentFlow.prFacts` | `true` | Read each in-flight task's PR state from GitHub via the `gh` CLI and show it on the Deck's cards. |
| `agentFlow.prFactsTtlSeconds` | `120` | How stale a cached PR fact may be before the Deck re-fetches it (minimum 30). Only fetched while the Deck is open. |
```

- [ ] **Step 3: Update Requirements and Data & privacy**

Add to **Requirements**:

```markdown
- The **`gh` CLI**, signed in (`gh auth login`) — for the Deck's PR/CI state
  (optional; without it the Deck falls back to git + Jira).
```

In **Data & privacy**, replace the opening sentence so the third-party claim stays accurate:

```markdown
Agent Flow talks to **your** Jira Cloud site, reads your **local** repo checkouts,
and — when `agentFlow.prFacts` is on — reads your **own** GitHub through your
existing `gh` login. Nothing is sent to any service that isn't already yours, and
Agent Flow stores no GitHub credentials of its own: PR reads go through `gh`, so
they inherit whatever host, SSO and token your CLI already has. All GitHub access
is **read-only** — Agent Flow never merges, comments, or pushes.
```

- [ ] **Step 4: Add the changelog entry**

At the top of `CHANGELOG.md`, under a new `## Unreleased` heading (or extend an existing one), following the file's established style:

```markdown
### Added

- **The Deck reads your PRs.** Every card now shows the PR state of each repo it
  touches — number, CI with failing check names linked to their runs, review
  decision with unresolved-thread count, and mergeability — read from GitHub with
  the `gh` CLI. A blocked PR (failing required checks, requested changes, or a
  conflict) pulls its card into **Needs you**; a merged PR moves it to **Done**.
  Settings: `agentFlow.prFacts` (default on) and `agentFlow.prFactsTtlSeconds`
  (default 120). All access is read-only, through your existing `gh` login.

### Fixed

- A Deck card said *merged* whenever Jira said done, regardless of the PR. It now
  says *merged* only when a PR actually merged, and *done* otherwise.
```

- [ ] **Step 5: Verify the build and suite one last time**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: describe the Deck's PR & CI state and its read-only GitHub access"
```

---

## Verification

After Task 9, confirm the whole feature rather than each unit:

- [ ] `npm test` — full suite green.
- [ ] `npm run typecheck` — clean.
- [ ] `npx vitest run --coverage` — thresholds in `vitest.config.ts` still met (statements 90, branches 85, functions 85, lines 90).
- [ ] Press **F5**, open the Deck on a repo with a real open PR, and confirm: the block appears within one TTL; the PR number and a failing check both open in a browser; toggling **PR facts** off removes the blocks; a repo with no PR shows no block and does not re-fetch every tick (watch the extension host log).
- [ ] With `gh` temporarily off PATH, confirm the footer note appears and no error or toast does.
