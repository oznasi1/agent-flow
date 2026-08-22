# All-time Reach Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record GitHub traffic and marketplace install counts daily to a durable store, so the project accumulates permanent history instead of losing everything older than GitHub's 14-day traffic window.

**Architecture:** A zero-dependency Node collector in `scripts/reach/` fetches eight endpoints across three services, merges daily buckets into JSON on an orphan `reach-data` branch, and renders a self-contained HTML dashboard. A daily GitHub Actions cron drives it. Nothing under `src/` is touched — this is maintainer tooling, not extension code.

**Tech Stack:** Node 20+ ESM (`.mjs`), native `fetch`, no dependencies. Vitest for tests. GitHub Actions.

**Spec:** [docs/superpowers/specs/2026-08-22-repo-reach-stats-design.md](../specs/2026-08-22-repo-reach-stats-design.md)

## Global Constraints

Every task's requirements implicitly include this section. Read it before Task 1.

- **The CI gate is exactly four commands, all of which must pass:** `npm ci`, `npm run typecheck`, `npm test`, `npm run build`. Do not assume CONTRIBUTING.md was read — this is the whole gate.
- **`node_modules` in the root checkout is currently EMPTY.** Run `npm ci` before anything else, or the test and typecheck commands will fail for reasons unrelated to your change.
- **`npm test` is ~4,500 tests across 122+ files and takes 2+ minutes.** It exceeds the default Bash tool timeout and auto-backgrounds at 120s — pass `timeout: 600000`. While iterating, run one file: `npx vitest run test/unit/reach/merge.test.ts`.
- **Never pipe vitest through `tail` or `head`.** It discards the failure list you need.
- **A single failure under CPU contention is usually flake, not a regression.** Re-run that file alone before believing it.
- **Never let two vitest runs overlap.**
- **Zero new dependencies.** Native `fetch` covers every source. `package.json` and `package-lock.json` must not change. [.npmrc](../../../.npmrc) pins `registry.npmjs.org`; if a lockfile diff ever grows internal registry URLs, drop them — CI fails with `E401`.
- **Every `.mjs` file that a test imports MUST have a hand-written `.d.mts` sibling.** `tsconfig.json` includes `test` but not `scripts`, so an undeclared `.mjs` import fails `npm run typecheck` with **TS7016**. This was verified empirically, not assumed. The `.d.mts` fix was also verified to work.
- **Do NOT add `scripts/**` to `coverage.include` in [vitest.config.ts](../../../vitest.config.ts).** It is `src/**` only, which is what keeps this work from moving the 90% lines / 85% branches thresholds in either direction. Leave that file untouched.
- **No CHANGELOG entry.** CLAUDE.md scopes that requirement to user-facing change; this ships no user-facing behaviour.
- **Work in a git worktree.** `main` moves fast and several sessions land on it a day. Use absolute paths in Bash — the shared root checkout may switch branches under you.
- **Commit after every task.** Subagent rounds get killed mid-flight; an uncommitted tree is lost work.
- **Repo constants** (hardcode these at the top of the scripts — this is single-repo maintainer tooling, not a shipped feature that needs `agentFlow.*` settings):
  - GitHub owner/repo: `oznasi1` / `agent-flow`
  - VS Marketplace extension id: `oznasi1.oznasi1-agent-flow`
  - Open VSX namespace/name: `oznasi1` / `oznasi1-agent-flow`

### The one rule that must not be broken

**A source that fails must leave its file untouched and must never write `0`.**

A `0` written because a token expired is indistinguishable on the chart from a real collapse in traffic, and because the store is append-only and the upstream 14-day window has moved on, that false zero can **never** be corrected. A missing day is honest and repairable; a fabricated zero is neither.

**Do not confuse this with legitimate zeros.** GitHub really does report `count: 0` for quiet days — 2026-08-15 and 2026-08-16 are both genuine zeros in live data. Zero-count days from a *successful* fetch are real data and must be stored. The rule is about *failed* fetches, which must write nothing at all.

---

### Task 1: The pure merge module

The heart of the design. Pure functions, no I/O, no `fetch`.

**Files:**
- Create: `scripts/reach/merge.mjs`
- Create: `scripts/reach/merge.d.mts`
- Test: `test/unit/reach/merge.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `toDailyMap(buckets: TrafficBucket[]): DailyMap` — converts GitHub's array of `{timestamp, count, uniques}` into a map keyed by `YYYY-MM-DD`.
  - `mergeDaily(existing: DailyMap, incoming: DailyMap): DailyMap` — the merge rule.
  - Types `DailyBucket = { count: number; uniques: number }`, `DailyMap = Record<string, DailyBucket>`, `TrafficBucket = { timestamp: string; count: number; uniques: number }`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/reach/merge.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mergeDaily, toDailyMap } from "../../../scripts/reach/merge.mjs";

// Real payload shape, captured from the live API on 2026-08-22.
const LIVE_BUCKETS = [
  { timestamp: "2026-08-08T00:00:00Z", count: 1, uniques: 1 },
  { timestamp: "2026-08-15T00:00:00Z", count: 0, uniques: 0 },
  { timestamp: "2026-08-21T00:00:00Z", count: 18, uniques: 3 },
];

describe("toDailyMap", () => {
  it("keys buckets by calendar date, dropping the time component", () => {
    expect(toDailyMap(LIVE_BUCKETS)).toEqual({
      "2026-08-08": { count: 1, uniques: 1 },
      "2026-08-15": { count: 0, uniques: 0 },
      "2026-08-21": { count: 18, uniques: 3 },
    });
  });

  it("keeps genuine zero-count days — a quiet day is real data", () => {
    expect(toDailyMap(LIVE_BUCKETS)["2026-08-15"]).toEqual({ count: 0, uniques: 0 });
  });

  it("skips malformed buckets rather than inventing a date", () => {
    expect(toDailyMap([{ count: 5, uniques: 1 }, null, { timestamp: 7 }])).toEqual({});
  });

  it("returns an empty map for an empty payload", () => {
    expect(toDailyMap([])).toEqual({});
  });
});

describe("mergeDaily", () => {
  it("overwrites any date the incoming payload reports", () => {
    const existing = { "2026-08-21": { count: 4, uniques: 1 } };
    const incoming = { "2026-08-21": { count: 18, uniques: 3 } };
    expect(mergeDaily(existing, incoming)["2026-08-21"]).toEqual({ count: 18, uniques: 3 });
  });

  it("keeps dates the incoming payload no longer mentions", () => {
    const existing = { "2026-07-20": { count: 9, uniques: 2 } };
    const incoming = { "2026-08-21": { count: 18, uniques: 3 } };
    const merged = mergeDaily(existing, incoming);
    expect(merged["2026-07-20"]).toEqual({ count: 9, uniques: 2 });
    expect(Object.keys(merged)).toHaveLength(2);
  });

  it("is idempotent — merging the same payload twice equals merging it once", () => {
    const existing = { "2026-08-01": { count: 3, uniques: 1 } };
    const incoming = toDailyMap(LIVE_BUCKETS);
    const once = mergeDaily(existing, incoming);
    const twice = mergeDaily(once, incoming);
    expect(twice).toEqual(once);
  });

  it("backfills a fourteen-day gap without losing anything", () => {
    const existing = { "2026-08-01": { count: 3, uniques: 1 } };
    const incoming = toDailyMap(LIVE_BUCKETS);
    const merged = mergeDaily(existing, incoming);
    expect(Object.keys(merged).sort()).toEqual([
      "2026-08-01", "2026-08-08", "2026-08-15", "2026-08-21",
    ]);
  });

  it("never deletes a date, even when incoming is empty", () => {
    const existing = { "2026-08-01": { count: 3, uniques: 1 } };
    expect(mergeDaily(existing, {})).toEqual(existing);
  });

  it("does not mutate either argument", () => {
    const existing = { "2026-08-01": { count: 3, uniques: 1 } };
    const incoming = { "2026-08-01": { count: 99, uniques: 9 } };
    mergeDaily(existing, incoming);
    expect(existing["2026-08-01"]).toEqual({ count: 3, uniques: 1 });
    expect(incoming["2026-08-01"]).toEqual({ count: 99, uniques: 9 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/unit/reach/merge.test.ts
```

Expected: FAIL — cannot resolve `../../../scripts/reach/merge.mjs`.

- [ ] **Step 3: Write the implementation**

Create `scripts/reach/merge.mjs`:

```js
// Pure merge arithmetic for the reach store. No I/O, no fetch, no imports —
// this module is the one piece of real logic in the collector and is the only
// part with a test suite behind it.

/** Coerce to a finite number, or 0. Used only on values from a SUCCESSFUL
 * fetch, where a zero is genuine data (GitHub reports quiet days as count: 0).
 * A failed fetch never reaches this module at all. */
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Convert GitHub's traffic array into a map keyed by calendar date.
 * Buckets without a string `timestamp` are skipped rather than guessed at.
 */
export function toDailyMap(buckets) {
  const out = {};
  if (!Array.isArray(buckets)) return out;
  for (const b of buckets) {
    if (!b || typeof b.timestamp !== "string") continue;
    out[b.timestamp.slice(0, 10)] = { count: num(b.count), uniques: num(b.uniques) };
  }
  return out;
}

/**
 * The merge rule, in full: the API is authoritative for every date it returns,
 * so overwrite those dates, keep every date it does not mention, and never
 * delete one.
 *
 * Those three properties are what make the collector idempotent, make today's
 * partial count self-correcting (tomorrow's window includes today and replaces
 * it), and make a gap of up to fourteen days backfill with no special case.
 *
 * Returns a new object; neither argument is mutated.
 */
export function mergeDaily(existing, incoming) {
  return { ...existing, ...incoming };
}
```

Create `scripts/reach/merge.d.mts` — **required**, or `npm run typecheck` fails with TS7016:

```ts
export interface DailyBucket {
  count: number;
  uniques: number;
}
export type DailyMap = Record<string, DailyBucket>;
export interface TrafficBucket {
  timestamp: string;
  count: number;
  uniques: number;
}
export declare function toDailyMap(buckets: unknown): DailyMap;
export declare function mergeDaily(existing: DailyMap, incoming: DailyMap): DailyMap;
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run test/unit/reach/merge.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Verify the typecheck gate specifically**

```bash
npm run typecheck
```

Expected: clean exit. If you see `TS7016: Could not find a declaration file`, the `.d.mts` is missing or misnamed — it must sit beside the `.mjs` with the exact same basename.

- [ ] **Step 6: Commit**

```bash
git add scripts/reach/merge.mjs scripts/reach/merge.d.mts test/unit/reach/merge.test.ts
git commit -m "feat(reach): pure daily-bucket merge with idempotent overwrite rule"
```

- [ ] **Step 7: Mutation-check the tests (commit FIRST — this step reverts files)**

The tests are the deliverable here, so prove they can fail. Apply each mutation, confirm the expected test fails, then restore.

```bash
# Mutation A: break the overwrite rule (incoming should win)
perl -pi -e 's/\{ \.\.\.existing, \.\.\.incoming \}/{ ...incoming, ...existing }/' scripts/reach/merge.mjs
npx vitest run test/unit/reach/merge.test.ts   # EXPECT: "overwrites any date" FAILS
git checkout -- scripts/reach/merge.mjs

# Mutation B: drop genuine zero days
perl -pi -e 's/if \(!b \|\| typeof b\.timestamp !== "string"\) continue;/if (!b || typeof b.timestamp !== "string" || !b.count) continue;/' scripts/reach/merge.mjs
npx vitest run test/unit/reach/merge.test.ts   # EXPECT: "keeps genuine zero-count days" FAILS
git checkout -- scripts/reach/merge.mjs

# Confirm the tree is clean and green again
git status --porcelain scripts/reach/   # EXPECT: no output
npx vitest run test/unit/reach/merge.test.ts   # EXPECT: PASS
```

If a mutation does **not** produce a failure, the corresponding test is vacuous. Fix the test, re-commit, and repeat.

---

### Task 2: Source parsers

Each service gets a pure `parse*` function. Parsing is separated from fetching so the payload shapes are testable without a network — the same pure-versus-`Fs` split the repo already uses for `claudeAssets` / `claudeAssetsFs`.

**Files:**
- Create: `scripts/reach/sources.mjs`
- Create: `scripts/reach/sources.d.mts`
- Test: `test/unit/reach/sources.test.ts`

**Interfaces:**
- Consumes: `toDailyMap` from `./merge.mjs` (Task 1).
- Produces:
  - `parseTraffic(payload: unknown): DailyMap`
  - `parseOpenVsx(payload: unknown): { downloads: number; reviews: number; version: string | null }`
  - `parseVsMarketplace(payload: unknown): { downloads: number; installs: number | null; updates: number | null; rating: number | null; version: string | null }`
  - `parseStars(payload: unknown): string[]` — sorted ISO timestamps.
  - Each **throws** on a malformed payload. Throwing is what enforces the never-write-a-zero rule one layer up.

- [ ] **Step 1: Write the failing test**

Create `test/unit/reach/sources.test.ts`. Every fixture below is the real shape captured from the live APIs on 2026-08-22.

```ts
import { describe, it, expect } from "vitest";
import {
  parseTraffic, parseOpenVsx, parseVsMarketplace, parseStars,
} from "../../../scripts/reach/sources.mjs";

const VIEWS = {
  count: 97, uniques: 9,
  views: [
    { timestamp: "2026-08-08T00:00:00Z", count: 1, uniques: 1 },
    { timestamp: "2026-08-21T00:00:00Z", count: 18, uniques: 3 },
  ],
};
const CLONES = {
  count: 290, uniques: 105,
  clones: [{ timestamp: "2026-08-21T00:00:00Z", count: 20, uniques: 7 }],
};
const OPEN_VSX = { version: "0.36.0", downloadCount: 18596, reviewCount: 4 };
const VS_MARKETPLACE = {
  results: [{ extensions: [{
    versions: [{ version: "0.36.0" }],
    statistics: [
      { statisticName: "install", value: 11 },
      { statisticName: "downloadCount", value: 1066 },
      { statisticName: "updateCount", value: 77 },
      { statisticName: "weightedRating", value: 4.451494509719119 },
    ],
  }] }],
};

describe("parseTraffic", () => {
  it("reads the views array", () => {
    expect(parseTraffic(VIEWS)["2026-08-21"]).toEqual({ count: 18, uniques: 3 });
  });

  it("reads the clones array from the same function", () => {
    expect(parseTraffic(CLONES)["2026-08-21"]).toEqual({ count: 20, uniques: 7 });
  });

  it("throws on a payload with neither array — never returns an empty map", () => {
    expect(() => parseTraffic({ message: "Not Found" })).toThrow(/malformed/i);
    expect(() => parseTraffic(null)).toThrow(/malformed/i);
  });
});

describe("parseOpenVsx", () => {
  it("extracts the download count", () => {
    expect(parseOpenVsx(OPEN_VSX)).toEqual({ downloads: 18596, reviews: 4, version: "0.36.0" });
  });

  it("throws when downloadCount is absent rather than reporting zero", () => {
    expect(() => parseOpenVsx({ version: "0.36.0" })).toThrow(/malformed/i);
    expect(() => parseOpenVsx({ error: "not found" })).toThrow(/malformed/i);
  });
});

describe("parseVsMarketplace", () => {
  it("pulls each named statistic out of the flat array", () => {
    expect(parseVsMarketplace(VS_MARKETPLACE)).toEqual({
      downloads: 1066, installs: 11, updates: 77,
      rating: 4.451494509719119, version: "0.36.0",
    });
  });

  it("throws when the extension is missing rather than reporting zero", () => {
    expect(() => parseVsMarketplace({ results: [{ extensions: [] }] })).toThrow(/malformed/i);
  });

  it("throws when downloadCount is absent from the statistics", () => {
    const noDownloads = { results: [{ extensions: [{ statistics: [{ statisticName: "install", value: 11 }] }] }] };
    expect(() => parseVsMarketplace(noDownloads)).toThrow(/downloadCount/i);
  });
});

describe("parseStars", () => {
  it("returns sorted ISO timestamps", () => {
    const payload = [{ starred_at: "2026-07-27T07:38:56Z" }, { starred_at: "2026-07-23T08:46:16Z" }];
    expect(parseStars(payload)).toEqual(["2026-07-23T08:46:16Z", "2026-07-27T07:38:56Z"]);
  });

  it("returns an empty array for a repo with no stars", () => {
    expect(parseStars([])).toEqual([]);
  });

  it("throws when the payload is not an array", () => {
    expect(() => parseStars({ message: "Bad credentials" })).toThrow(/malformed/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/unit/reach/sources.test.ts
```

Expected: FAIL — cannot resolve `../../../scripts/reach/sources.mjs`.

- [ ] **Step 3: Write the implementation**

Create `scripts/reach/sources.mjs`:

```js
// Payload parsers, one per service. Pure: each takes an already-decoded JSON
// value and returns a normalised record, or THROWS.
//
// Throwing is the mechanism behind the collector's one hard rule. A parser that
// returned zeros on a malformed payload would let an expired token write a
// permanent false cliff into the store, so every failure path here is an
// exception and none of them is a default value.

import { toDailyMap } from "./merge.mjs";

/** GitHub's views and clones endpoints differ only in the array's key. */
export function parseTraffic(payload) {
  const buckets = payload?.views ?? payload?.clones;
  if (!Array.isArray(buckets)) {
    throw new Error("reach: malformed traffic payload — no views/clones array");
  }
  return toDailyMap(buckets);
}

export function parseOpenVsx(payload) {
  if (!payload || typeof payload.downloadCount !== "number") {
    throw new Error("reach: malformed Open VSX payload — no numeric downloadCount");
  }
  return {
    downloads: payload.downloadCount,
    reviews: typeof payload.reviewCount === "number" ? payload.reviewCount : 0,
    version: typeof payload.version === "string" ? payload.version : null,
  };
}

export function parseVsMarketplace(payload) {
  const ext = payload?.results?.[0]?.extensions?.[0];
  if (!ext || !Array.isArray(ext.statistics)) {
    throw new Error("reach: malformed VS Marketplace payload — no extension record");
  }
  const stat = (name) => {
    const hit = ext.statistics.find((s) => s?.statisticName === name);
    return typeof hit?.value === "number" ? hit.value : null;
  };
  const downloads = stat("downloadCount");
  if (downloads === null) {
    throw new Error("reach: VS Marketplace payload has no downloadCount statistic");
  }
  return {
    downloads,
    installs: stat("install"),
    updates: stat("updateCount"),
    rating: stat("weightedRating"),
    version: typeof ext.versions?.[0]?.version === "string" ? ext.versions[0].version : null,
  };
}

export function parseStars(payload) {
  if (!Array.isArray(payload)) {
    throw new Error("reach: malformed stargazers payload — not an array");
  }
  return payload
    .map((s) => s?.starred_at)
    .filter((t) => typeof t === "string")
    .sort();
}
```

Create `scripts/reach/sources.d.mts`:

```ts
import type { DailyMap } from "./merge.mjs";

export interface OpenVsxReach {
  downloads: number;
  reviews: number;
  version: string | null;
}
export interface VsMarketplaceReach {
  downloads: number;
  installs: number | null;
  updates: number | null;
  rating: number | null;
  version: string | null;
}
export declare function parseTraffic(payload: unknown): DailyMap;
export declare function parseOpenVsx(payload: unknown): OpenVsxReach;
export declare function parseVsMarketplace(payload: unknown): VsMarketplaceReach;
export declare function parseStars(payload: unknown): string[];
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run test/unit/reach/sources.test.ts
npm run typecheck
```

Expected: PASS (11 tests), clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add scripts/reach/sources.mjs scripts/reach/sources.d.mts test/unit/reach/sources.test.ts
git commit -m "feat(reach): payload parsers that throw rather than default to zero"
```

- [ ] **Step 6: Mutation-check (commit FIRST — this step reverts files)**

```bash
# Mutation: make a malformed payload return zeros instead of throwing
perl -0pi -e 's/throw new Error\("reach: malformed Open VSX payload — no numeric downloadCount"\);/return { downloads: 0, reviews: 0, version: null };/' scripts/reach/sources.mjs
npx vitest run test/unit/reach/sources.test.ts   # EXPECT: "throws when downloadCount is absent" FAILS
git checkout -- scripts/reach/sources.mjs
npx vitest run test/unit/reach/sources.test.ts   # EXPECT: PASS
```

---

### Task 3: The store

Thin filesystem I/O. Deliberately dumb — all the judgment lives in Task 1.

**Files:**
- Create: `scripts/reach/store.mjs`
- Create: `scripts/reach/store.d.mts`
- Test: `test/unit/reach/store.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `readJson(dir: string, rel: string, fallback: T): T`
  - `writeJson(dir: string, rel: string, value: unknown): void` — creates parent directories.
  - `appendJsonl(dir: string, rel: string, record: unknown): void`

- [ ] **Step 1: Write the failing test**

Create `test/unit/reach/store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readJson, writeJson, appendJsonl } from "../../../scripts/reach/store.mjs";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("readJson", () => {
  it("returns the fallback when the file does not exist", () => {
    expect(readJson(dir, "traffic/views.json", { seed: true })).toEqual({ seed: true });
  });

  it("returns the fallback when the file is corrupt rather than throwing", () => {
    fs.mkdirSync(path.join(dir, "traffic"), { recursive: true });
    fs.writeFileSync(path.join(dir, "traffic/views.json"), "{not json");
    expect(readJson(dir, "traffic/views.json", { seed: true })).toEqual({ seed: true });
  });

  it("round-trips through writeJson", () => {
    writeJson(dir, "traffic/views.json", { "2026-08-21": { count: 18, uniques: 3 } });
    expect(readJson(dir, "traffic/views.json", null)).toEqual({ "2026-08-21": { count: 18, uniques: 3 } });
  });
});

describe("writeJson", () => {
  it("creates missing parent directories", () => {
    writeJson(dir, "snapshots/referrers/2026-08-22.json", [{ referrer: "Google" }]);
    expect(fs.existsSync(path.join(dir, "snapshots/referrers/2026-08-22.json"))).toBe(true);
  });

  it("writes a trailing newline so git diffs stay clean", () => {
    writeJson(dir, "meta.json", { lastRun: "2026-08-22" });
    expect(fs.readFileSync(path.join(dir, "meta.json"), "utf8").endsWith("\n")).toBe(true);
  });
});

describe("appendJsonl", () => {
  it("appends one line per record and never rewrites earlier lines", () => {
    appendJsonl(dir, "marketplace.jsonl", { ts: "2026-08-22", downloads: 18596 });
    appendJsonl(dir, "marketplace.jsonl", { ts: "2026-08-23", downloads: 18700 });
    const lines = fs.readFileSync(path.join(dir, "marketplace.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ ts: "2026-08-22", downloads: 18596 });
    expect(JSON.parse(lines[1])).toEqual({ ts: "2026-08-23", downloads: 18700 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/unit/reach/store.test.ts
```

Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write the implementation**

Create `scripts/reach/store.mjs`:

```js
// Filesystem layer for the reach store. Deliberately dumb: all judgment lives
// in ./merge.mjs. A corrupt file reads as the fallback rather than throwing,
// because a store the collector cannot parse should be rebuilt from the next
// fetch, not treated as a fatal error.

import * as fs from "fs";
import * as path from "path";

export function readJson(dir, rel, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, rel), "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(dir, rel, value) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function appendJsonl(dir, rel, record) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
}
```

Create `scripts/reach/store.d.mts`:

```ts
export declare function readJson<T>(dir: string, rel: string, fallback: T): T;
export declare function writeJson(dir: string, rel: string, value: unknown): void;
export declare function appendJsonl(dir: string, rel: string, record: unknown): void;
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run test/unit/reach/store.test.ts
npm run typecheck
```

Expected: PASS (6 tests), clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add scripts/reach/store.mjs scripts/reach/store.d.mts test/unit/reach/store.test.ts
git commit -m "feat(reach): json and jsonl store with corrupt-file fallback"
```

---

### Task 4: The collector, with per-source failure isolation

Wires Tasks 1–3 into a runnable CLI. This is where the never-write-a-zero rule is enforced.

**Files:**
- Create: `scripts/reach/collect.mjs`
- Create: `scripts/reach/collect.d.mts`
- Test: `test/unit/reach/collect.test.ts`

**Interfaces:**
- Consumes: `mergeDaily`, `toDailyMap` (Task 1); all four parsers (Task 2); `readJson`, `writeJson`, `appendJsonl` (Task 3).
- Produces:
  - `collect(opts: { dir: string; token: string; fetchImpl: typeof fetch; now: string }): Promise<{ ok: string[]; failed: { source: string; error: string }[] }>`
  - `now` is injected as an ISO string rather than read from the clock, so tests are deterministic.

- [ ] **Step 1: Write the failing test**

Create `test/unit/reach/collect.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { collect } from "../../../scripts/reach/collect.mjs";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const OK_BODIES: Record<string, unknown> = {
  "traffic/views": { views: [{ timestamp: "2026-08-21T00:00:00Z", count: 18, uniques: 3 }] },
  "traffic/clones": { clones: [{ timestamp: "2026-08-21T00:00:00Z", count: 20, uniques: 7 }] },
  "traffic/popular/referrers": [{ referrer: "Google", count: 21, uniques: 3 }],
  "traffic/popular/paths": [{ path: "/oznasi1/agent-flow", count: 34, uniques: 6 }],
  stargazers: [{ starred_at: "2026-07-23T08:46:16Z" }],
  openvsx: { version: "0.36.0", downloadCount: 18596, reviewCount: 4 },
  vsmarketplace: {
    results: [{ extensions: [{
      versions: [{ version: "0.36.0" }],
      statistics: [{ statisticName: "downloadCount", value: 1066 }, { statisticName: "install", value: 11 }],
    }] }],
  },
};

/** A fetch stub. `broken` names the substrings whose requests should 403.
 *  Cast to `typeof fetch`: collect() only ever calls it as fetchImpl(url, init),
 *  but the real signature's first parameter is `RequestInfo | URL`, which a
 *  narrower stub cannot satisfy contravariantly under `strict: true`. */
function stubFetch(broken: string[] = []): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    if (broken.some((b) => u.includes(b))) {
      return { ok: false, status: 403, json: async () => ({ message: "Forbidden" }) } as unknown as Response;
    }
    const key = Object.keys(OK_BODIES).find((k) => u.includes(k.split("/").pop()!))
      ?? (u.includes("open-vsx") ? "openvsx" : "vsmarketplace");
    return { ok: true, status: 200, json: async () => OK_BODIES[key] } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("collect", () => {
  it("writes every source on a fully successful run", async () => {
    const res = await collect({ dir, token: "t", fetchImpl: stubFetch(), now: "2026-08-22T06:17:00Z" });
    expect(res.failed).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "traffic/views.json"), "utf8"))["2026-08-21"])
      .toEqual({ count: 18, uniques: 3 });
    expect(fs.existsSync(path.join(dir, "marketplace.jsonl"))).toBe(true);
  });

  it("merges into an existing store rather than replacing it", async () => {
    fs.mkdirSync(path.join(dir, "traffic"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "traffic/views.json"),
      JSON.stringify({ "2026-07-20": { count: 9, uniques: 2 } }),
    );
    await collect({ dir, token: "t", fetchImpl: stubFetch(), now: "2026-08-22T06:17:00Z" });
    const views = JSON.parse(fs.readFileSync(path.join(dir, "traffic/views.json"), "utf8"));
    expect(views["2026-07-20"]).toEqual({ count: 9, uniques: 2 });
    expect(views["2026-08-21"]).toEqual({ count: 18, uniques: 3 });
  });

  it("NEVER writes a zero when a source fails — the file stays byte-identical", async () => {
    const seed = JSON.stringify({ "2026-08-20": { count: 10, uniques: 2 } }, null, 2) + "\n";
    fs.mkdirSync(path.join(dir, "traffic"), { recursive: true });
    fs.writeFileSync(path.join(dir, "traffic/views.json"), seed);

    const res = await collect({ dir, token: "t", fetchImpl: stubFetch(["traffic/views"]), now: "2026-08-22T06:17:00Z" });

    expect(fs.readFileSync(path.join(dir, "traffic/views.json"), "utf8")).toBe(seed);
    expect(res.failed.map((f) => f.source)).toContain("views");
  });

  it("lands the sibling sources even when one fails", async () => {
    const res = await collect({ dir, token: "t", fetchImpl: stubFetch(["traffic/views"]), now: "2026-08-22T06:17:00Z" });
    expect(fs.existsSync(path.join(dir, "traffic/clones.json"))).toBe(true);
    expect(res.ok).toContain("clones");
  });

  it("records firstCollected once and never moves it", async () => {
    await collect({ dir, token: "t", fetchImpl: stubFetch(), now: "2026-08-22T06:17:00Z" });
    await collect({ dir, token: "t", fetchImpl: stubFetch(), now: "2026-09-01T06:17:00Z" });
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
    expect(meta.firstCollected).toBe("2026-08-22T06:17:00Z");
    expect(meta.lastRun).toBe("2026-09-01T06:17:00Z");
  });

  it("appends one marketplace line per run", async () => {
    await collect({ dir, token: "t", fetchImpl: stubFetch(), now: "2026-08-22T06:17:00Z" });
    await collect({ dir, token: "t", fetchImpl: stubFetch(), now: "2026-08-23T06:17:00Z" });
    const lines = fs.readFileSync(path.join(dir, "marketplace.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/unit/reach/collect.test.ts
```

Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write the implementation**

Create `scripts/reach/collect.mjs`:

```js
// The collector: fetch every source, merge, write. Runnable as
//   node scripts/reach/collect.mjs --out <dir>
//
// Each source is isolated in its own try/catch. A source that throws writes
// NOTHING and is reported in `failed`; its siblings still land. That isolation
// is the whole enforcement of the never-write-a-zero rule — see the spec.

import { mergeDaily } from "./merge.mjs";
import { parseTraffic, parseOpenVsx, parseVsMarketplace, parseStars } from "./sources.mjs";
import { readJson, writeJson, appendJsonl } from "./store.mjs";

const OWNER = "oznasi1";
const REPO = "agent-flow";
const VSX_NAMESPACE = "oznasi1";
const VSX_NAME = "oznasi1-agent-flow";
const VS_EXT_ID = "oznasi1.oznasi1-agent-flow";

const GH = `https://api.github.com/repos/${OWNER}/${REPO}`;

async function getJson(fetchImpl, url, init) {
  const res = await fetchImpl(url, init);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

const ghInit = (token, accept = "application/vnd.github+json") => ({
  headers: { Accept: accept, Authorization: `Bearer ${token}`, "User-Agent": "agent-flow-reach" },
});

export async function collect({ dir, token, fetchImpl, now }) {
  const ok = [];
  const failed = [];

  /** Run one source in isolation. A throw writes nothing at all. */
  const source = async (name, fn) => {
    try {
      await fn();
      ok.push(name);
    } catch (e) {
      failed.push({ source: name, error: e instanceof Error ? e.message : String(e) });
    }
  };

  const day = now.slice(0, 10);

  await source("views", async () => {
    const incoming = parseTraffic(await getJson(fetchImpl, `${GH}/traffic/views`, ghInit(token)));
    writeJson(dir, "traffic/views.json", mergeDaily(readJson(dir, "traffic/views.json", {}), incoming));
  });

  await source("clones", async () => {
    const incoming = parseTraffic(await getJson(fetchImpl, `${GH}/traffic/clones`, ghInit(token)));
    writeJson(dir, "traffic/clones.json", mergeDaily(readJson(dir, "traffic/clones.json", {}), incoming));
  });

  // Referrers and paths are top-10 rankings, not totals — two snapshots do not
  // compose, so each run writes its own dated file and the dashboard reads the
  // series rather than a merged aggregate.
  await source("referrers", async () => {
    const payload = await getJson(fetchImpl, `${GH}/traffic/popular/referrers`, ghInit(token));
    if (!Array.isArray(payload)) throw new Error("reach: malformed referrers payload");
    writeJson(dir, `snapshots/referrers/${day}.json`, payload);
  });

  await source("paths", async () => {
    const payload = await getJson(fetchImpl, `${GH}/traffic/popular/paths`, ghInit(token));
    if (!Array.isArray(payload)) throw new Error("reach: malformed paths payload");
    writeJson(dir, `snapshots/paths/${day}.json`, payload);
  });

  await source("stars", async () => {
    const payload = await getJson(
      fetchImpl, `${GH}/stargazers?per_page=100`,
      ghInit(token, "application/vnd.github.star+json"),
    );
    writeJson(dir, "stars.json", parseStars(payload));
  });

  // Both marketplaces feed ONE jsonl line, so a run where either fails appends
  // nothing — a half-filled line would be worse than a missing one.
  await source("marketplace", async () => {
    const vsx = parseOpenVsx(
      await getJson(fetchImpl, `https://open-vsx.org/api/${VSX_NAMESPACE}/${VSX_NAME}`, {}),
    );
    const vsm = parseVsMarketplace(await getJson(
      fetchImpl,
      "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery",
      {
        method: "POST",
        headers: {
          Accept: "application/json;api-version=3.0-preview.1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          filters: [{ criteria: [{ filterType: 7, value: VS_EXT_ID }] }],
          flags: 914,
        }),
      },
    ));
    appendJsonl(dir, "marketplace.jsonl", { ts: now, openvsx: vsx, vsmarketplace: vsm });
  });

  const meta = readJson(dir, "meta.json", {});
  writeJson(dir, "meta.json", {
    firstCollected: meta.firstCollected ?? now,
    lastRun: now,
    schemaVersion: 1,
  });

  return { ok, failed };
}

// CLI entry. Only runs when invoked directly, so the test can import `collect`.
if (process.argv[1] && process.argv[1].endsWith("collect.mjs")) {
  const outIdx = process.argv.indexOf("--out");
  const dir = outIdx >= 0 ? process.argv[outIdx + 1] : ".";
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) {
    console.error("reach: GH_TOKEN or GITHUB_TOKEN is required");
    process.exit(1);
  }
  const { ok, failed } = await collect({
    dir, token, fetchImpl: fetch, now: new Date().toISOString(),
  });
  console.log(`reach: ok=[${ok.join(", ")}]`);
  for (const f of failed) console.error(`reach: FAILED ${f.source} — ${f.error}`);
  // Non-zero on any failure so the workflow surfaces it, but the successful
  // sources have already been written and committed.
  process.exit(failed.length > 0 ? 1 : 0);
}
```

Create `scripts/reach/collect.d.mts`:

```ts
export interface CollectOptions {
  dir: string;
  token: string;
  fetchImpl: typeof fetch;
  now: string;
}
export interface CollectResult {
  ok: string[];
  failed: { source: string; error: string }[];
}
export declare function collect(opts: CollectOptions): Promise<CollectResult>;
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run test/unit/reach/collect.test.ts
npm run typecheck
```

Expected: PASS (6 tests), clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add scripts/reach/collect.mjs scripts/reach/collect.d.mts test/unit/reach/collect.test.ts
git commit -m "feat(reach): collector with per-source failure isolation"
```

- [ ] **Step 6: Mutation-check the rule that matters most (commit FIRST)**

```bash
# Mutation: write the merged result even when the fetch threw
perl -0pi -e 's/\} catch \(e\) \{\n      failed\.push/} catch (e) {\n      writeJson(dir, "traffic\/views.json", {});\n      failed.push/' scripts/reach/collect.mjs
npx vitest run test/unit/reach/collect.test.ts   # EXPECT: "NEVER writes a zero" FAILS
git checkout -- scripts/reach/collect.mjs
npx vitest run test/unit/reach/collect.test.ts   # EXPECT: PASS
```

If that mutation does not fail the suite, the most important test in this plan is vacuous. Do not proceed until it does.

---

### Task 5: The dashboard renderer

**Files:**
- Create: `scripts/reach/render.mjs`
- Create: `scripts/reach/render.d.mts`
- Test: `test/unit/reach/render.test.ts`

**Interfaces:**
- Consumes: `readJson` (Task 3).
- Produces: `renderDashboard(data: DashboardData): string` — returns a complete self-contained HTML document.

- [ ] **Step 1: Write the failing test**

Create `test/unit/reach/render.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderDashboard } from "../../../scripts/reach/render.mjs";

const DATA = {
  meta: { firstCollected: "2026-08-22T06:17:00Z", lastRun: "2026-08-22T06:17:00Z", schemaVersion: 1 },
  views: { "2026-08-20": { count: 10, uniques: 2 }, "2026-08-21": { count: 18, uniques: 3 } },
  clones: { "2026-08-21": { count: 20, uniques: 7 } },
  stars: ["2026-07-23T08:46:16Z"],
  marketplace: [
    { ts: "2026-08-22T06:17:00Z", openvsx: { downloads: 18596, reviews: 4, version: "0.36.0" },
      vsmarketplace: { downloads: 1066, installs: 11, updates: 77, rating: 4.45, version: "0.36.0" } },
  ],
};

describe("renderDashboard", () => {
  it("returns a complete standalone HTML document", () => {
    const html = renderDashboard(DATA);
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain("</html>");
  });

  it("embeds no external resources — the CSP-safe, offline-safe requirement", () => {
    const html = renderDashboard(DATA);
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href="https?:/i);
    expect(html).not.toMatch(/https?:\/\/[^"']*\.(js|css)/i);
  });

  it("states when recording began, so a short series is not read as all-time", () => {
    expect(renderDashboard(DATA)).toContain("2026-08-22");
    expect(renderDashboard(DATA)).toMatch(/recording since/i);
  });

  it("labels Open VSX as downloads and never as users", () => {
    const html = renderDashboard(DATA);
    expect(html).toContain("18,596");
    expect(html).toMatch(/downloads/i);
    expect(html).not.toMatch(/18,596\s*users/i);
  });

  it("warns rather than drawing a trend when only one sample exists", () => {
    expect(renderDashboard(DATA)).toMatch(/not enough history|single sample|one sample/i);
  });

  it("does not warn once several samples exist", () => {
    const many = {
      ...DATA,
      marketplace: [
        { ...DATA.marketplace[0], ts: "2026-08-22T06:17:00Z" },
        { ...DATA.marketplace[0], ts: "2026-08-23T06:17:00Z" },
        { ...DATA.marketplace[0], ts: "2026-08-24T06:17:00Z" },
      ],
    };
    expect(renderDashboard(many)).not.toMatch(/not enough history/i);
  });

  it("escapes values that came from a remote service", () => {
    const hostile = {
      ...DATA,
      marketplace: [{ ...DATA.marketplace[0], openvsx: { downloads: 1, reviews: 0, version: "<script>x</script>" } }],
    };
    expect(renderDashboard(hostile)).not.toContain("<script>x</script>");
  });

  it("renders an empty store without throwing", () => {
    const empty = { meta: {}, views: {}, clones: {}, stars: [], marketplace: [] };
    expect(() => renderDashboard(empty)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/unit/reach/render.test.ts
```

Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write the implementation**

Create `scripts/reach/render.mjs`. Build a self-contained document: inline `<style>`, hand-rolled inline SVG for the charts, no libraries.

```js
// Dashboard generator. Emits ONE self-contained HTML file: inline CSS, inline
// SVG charts, no CDN, no scripts with a src. It must open correctly from a
// file:// URL with no network.

import * as fs from "fs";
import * as path from "path";
import { readJson } from "./store.mjs";

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const fmt = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : "—");

/** A bar chart as inline SVG. `series` is [[label, value], …]. */
function barChart(series, { width = 720, height = 160 } = {}) {
  if (series.length === 0) return '<p class="empty">No data yet.</p>';
  const max = Math.max(1, ...series.map(([, v]) => v));
  const bw = width / series.length;
  const bars = series
    .map(([label, v], i) => {
      const h = Math.round((v / max) * (height - 24));
      return `<g><title>${esc(label)}: ${fmt(v)}</title>` +
        `<rect x="${(i * bw).toFixed(1)}" y="${height - h}" width="${Math.max(1, bw - 2).toFixed(1)}"` +
        ` height="${h}" rx="2" fill="var(--bar)"/></g>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" class="chart">${bars}</svg>`;
}

export function renderDashboard(data) {
  const { meta = {}, views = {}, clones = {}, stars = [], marketplace = [] } = data;
  const latest = marketplace[marketplace.length - 1];
  const thin = marketplace.length < 3;

  const viewSeries = Object.entries(views).sort().map(([d, b]) => [d, b.count]);
  const cloneSeries = Object.entries(clones).sort().map(([d, b]) => [d, b.count]);

  const since = meta.firstCollected
    ? `Recording since ${esc(String(meta.firstCollected).slice(0, 10))}`
    : "Recording has not started yet";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Flow — reach</title>
<style>
  :root { --bg:#fff; --fg:#1a1a1a; --muted:#666; --bar:#3b6ea5; --line:#e3e3e3; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#16181c; --fg:#e6e6e6; --muted:#9aa0a6; --bar:#6ea8dc; --line:#2c2f36; }
  }
  body { background:var(--bg); color:var(--fg); font:14px/1.5 system-ui,sans-serif;
         margin:0 auto; padding:32px; max-width:820px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .since { color:var(--muted); margin:0 0 24px; }
  .tiles { display:flex; gap:24px; flex-wrap:wrap; margin-bottom:8px; }
  .tile b { display:block; font-size:26px; font-weight:600; }
  .tile span { color:var(--muted); font-size:12px; }
  .note { color:var(--muted); font-size:12px; border-left:2px solid var(--line);
          padding-left:10px; margin:16px 0; }
  .chart { width:100%; height:auto; }
  h2 { font-size:14px; margin:28px 0 8px; }
  .empty { color:var(--muted); }
</style></head><body>
<h1>Agent Flow — reach</h1>
<p class="since">${since}. Last run ${esc(String(meta.lastRun ?? "—").slice(0, 10))}.
Latest published version ${esc(latest?.openvsx?.version ?? "—")}.</p>

<div class="tiles">
  <div class="tile"><b>${fmt(latest?.openvsx?.downloads)}</b><span>Open VSX downloads</span></div>
  <div class="tile"><b>${fmt(latest?.vsmarketplace?.downloads)}</b><span>VS Marketplace downloads</span></div>
  <div class="tile"><b>${fmt(latest?.vsmarketplace?.installs)}</b><span>VS Marketplace installs</span></div>
  <div class="tile"><b>${fmt(stars.length)}</b><span>Stars</span></div>
</div>

<p class="note">Download counts include CI pulls, updates and repeat installs. They are
<strong>downloads</strong>, not people.</p>

${thin ? '<p class="note">Not enough history to show a trend yet — this needs at least three daily samples.</p>' : ""}

<h2>Daily views</h2>
${barChart(viewSeries)}

<h2>Daily clones</h2>
${barChart(cloneSeries)}
</body></html>
`;
}

// CLI entry: node scripts/reach/render.mjs --data <dir> --out <file>
if (process.argv[1] && process.argv[1].endsWith("render.mjs")) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : fallback;
  };
  const dir = arg("--data", ".");
  const out = arg("--out", path.join(dir, "index.html"));
  const marketplace = fs.existsSync(path.join(dir, "marketplace.jsonl"))
    ? fs.readFileSync(path.join(dir, "marketplace.jsonl"), "utf8")
        .split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const html = renderDashboard({
    meta: readJson(dir, "meta.json", {}),
    views: readJson(dir, "traffic/views.json", {}),
    clones: readJson(dir, "traffic/clones.json", {}),
    stars: readJson(dir, "stars.json", []),
    marketplace,
  });
  fs.writeFileSync(out, html, "utf8");
  console.log(`reach: wrote ${out}`);
}
```

Create `scripts/reach/render.d.mts`:

```ts
import type { DailyMap } from "./merge.mjs";
import type { OpenVsxReach, VsMarketplaceReach } from "./sources.mjs";

export interface DashboardData {
  meta: { firstCollected?: string; lastRun?: string; schemaVersion?: number };
  views: DailyMap;
  clones: DailyMap;
  stars: string[];
  marketplace: { ts: string; openvsx: OpenVsxReach; vsmarketplace: VsMarketplaceReach }[];
}
export declare function renderDashboard(data: DashboardData): string;
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run test/unit/reach/render.test.ts
npm run typecheck
```

Expected: PASS (8 tests), clean typecheck.

- [ ] **Step 5: Eyeball the real output**

```bash
node scripts/reach/render.mjs --data /tmp/reach-demo --out /tmp/reach-demo/index.html
open /tmp/reach-demo/index.html
```

Create `/tmp/reach-demo` with a couple of hand-written fixture files first. Confirm it renders in both light and dark, and that the "downloads, not people" note is visible.

- [ ] **Step 6: Commit**

```bash
git add scripts/reach/render.mjs scripts/reach/render.d.mts test/unit/reach/render.test.ts
git commit -m "feat(reach): self-contained html dashboard"
```

- [ ] **Step 7: Mutation-check the escaping (commit FIRST)**

The version string is the only remote-supplied *text* the page prints. If this
mutation does not fail the suite, the escaping test is vacuous — as it was in an
earlier draft of this plan, where nothing rendered `version` at all and the test
passed no matter what.

```bash
# Mutation: stop escaping the remote-supplied version string
python3 - <<'EOF'
p = "scripts/reach/render.mjs"
s = open(p).read()
s = s.replace('${esc(latest?.openvsx?.version ?? "\u2014")}', '${latest?.openvsx?.version ?? "\u2014"}')
open(p, "w").write(s)
EOF
npx vitest run test/unit/reach/render.test.ts   # EXPECT: "escapes values" FAILS
git checkout -- scripts/reach/render.mjs
npx vitest run test/unit/reach/render.test.ts   # EXPECT: PASS
```

---

### Task 6: Workflow, bootstrap, and the first live run

The only task with a genuine unknown in it. Do not mark it done on a green file — it is done when a real run has written real data.

**Files:**
- Create: `.github/workflows/reach.yml`
- Create: `docs/REACH.md`

**Interfaces:**
- Consumes: `collect.mjs` and `render.mjs` CLI entries (Tasks 4, 5).
- Produces: an orphan `reach-data` branch carrying the store and `index.html`.

- [ ] **Step 1: Bootstrap the orphan branch**

The workflow checks out `reach-data`; that fails if the branch does not exist, so create it first. Use a **push refspec** so the shared root checkout never switches branches.

```bash
cd "$(mktemp -d)"
git clone --depth 1 https://github.com/oznasi1/agent-flow.git bootstrap
cd bootstrap
git checkout --orphan reach-data
git rm -rf . >/dev/null
printf '# reach-data\n\nCollected reach statistics. Generated by .github/workflows/reach.yml on main.\nDo not merge this branch into main — it shares no history with it.\n' > README.md
git add README.md
git commit -m "chore(reach): bootstrap the reach-data store"
git push origin reach-data
```

- [ ] **Step 2: Write the workflow**

Create `.github/workflows/reach.yml`:

```yaml
name: reach

on:
  schedule:
    # 06:17 UTC daily. An odd minute avoids the top-of-hour scheduling crush.
    - cron: "17 6 * * *"
  workflow_dispatch:

# Never part of the CI gate — this workflow must not be able to block a PR.
permissions:
  contents: write

concurrency:
  group: reach
  cancel-in-progress: false

jobs:
  collect:
    runs-on: ubuntu-latest
    steps:
      - name: Check out main (for the collector scripts)
        uses: actions/checkout@v4

      - name: Check out the data branch
        uses: actions/checkout@v4
        with:
          ref: reach-data
          path: .reach-data

      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      # No `npm ci` — the collector has zero dependencies by design.
      - name: Collect
        env:
          # Falls back to the built-in token. The traffic API requires push
          # access; if the built-in token is rejected, set the REACH_TOKEN
          # secret to a PAT with `repo` scope. See docs/REACH.md.
          GH_TOKEN: ${{ secrets.REACH_TOKEN || github.token }}
        run: node scripts/reach/collect.mjs --out .reach-data

      - name: Render the dashboard
        # Runs even if a source failed: the sources that succeeded were written.
        if: always()
        run: node scripts/reach/render.mjs --data .reach-data --out .reach-data/index.html

      - name: Commit the day's data
        if: always()
        working-directory: .reach-data
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add -A
          git diff --staged --quiet && echo "reach: nothing changed" && exit 0
          git commit -m "chore(reach): $(date -u +%Y-%m-%d)"
          git push origin reach-data
```

- [ ] **Step 3: Commit and push the workflow**

```bash
git add .github/workflows/reach.yml
git commit -m "ci(reach): daily collection workflow"
```

- [ ] **Step 4: Resolve the token unknown with a real run**

The traffic API requires **push access**, and whether the built-in `GITHUB_TOKEN` satisfies it is **unverified**. Find out now — do not wait for the cron.

```bash
gh workflow run reach.yml --repo oznasi1/agent-flow
sleep 30
gh run list --workflow reach.yml --repo oznasi1/agent-flow --limit 1
gh run view --repo oznasi1/agent-flow --log | grep -i "reach:"
```

- If the log shows `FAILED views — … HTTP 403`, the built-in token is insufficient. Create a PAT with `repo` scope on the `oznasi1` account, add it as the `REACH_TOKEN` secret (`gh secret set REACH_TOKEN --repo oznasi1/agent-flow`), and re-run. The workflow already prefers it when present.
- Note the active `gh` account is `OznasiAb` with read-only access to `oznasi1` repos; these commands need the `oznasi1` account. Use `gh auth token -u oznasi1` or switch accounts.

- [ ] **Step 5: Verify real data landed**

```bash
git fetch origin reach-data
git show origin/reach-data:traffic/views.json | head -20
git show origin/reach-data:meta.json
```

Expected: real dates with counts, and a `firstCollected` timestamp. **This is the step that makes the task done.** A green workflow that wrote an empty store is a failure.

- [ ] **Step 6: Write the operator doc**

Create `docs/REACH.md` covering: what is collected and from where; why views and clones cannot be backfilled before the first run; the merge rule; the never-write-a-zero rule; how to run the collector locally (`GH_TOKEN=… node scripts/reach/collect.mjs --out /tmp/reach`); how to rotate `REACH_TOKEN`; and the note that GitHub disables scheduled workflows after 60 days of repository inactivity.

Confirm this does not break the docs test, which asserts that registered connectors and forges are documented:

```bash
npx vitest run test/unit/docs.test.ts
```

- [ ] **Step 7: Run the full gate before opening the PR**

```bash
npm run typecheck
npm test          # pass timeout: 600000 — this takes 2+ minutes
npm run build
```

All three must pass, plus `npm ci` on a clean checkout. Do not pipe vitest through `tail` or `head`. A single failure under contention is probably flake — re-run that file alone before believing it.

- [ ] **Step 8: Commit and open the PR**

```bash
git add docs/REACH.md
git commit -m "docs(reach): operator guide for the reach collector"
git push origin <branch>
```

`main` is branch-protected; open a PR rather than pushing to it. No CHANGELOG entry — this ships no user-facing behaviour.

---

## Self-review

**Spec coverage.** Every section of the spec maps to a task: collector → Tasks 2, 4; store → Task 3; merge rule → Task 1; dashboard → Task 5; workflow and the token unknown → Task 6; failure posture → Tasks 2 and 4, with a dedicated mutation check; testing → the test file in every task; honest limits → the dashboard copy tested in Task 5 and `docs/REACH.md` in Task 6.

**Deliberately deferred to Follow-ups** (already recorded in the spec, not silently dropped): GitHub Pages publication, GitHub Releases download counts, and a reach line in the company cycle report.

**Type consistency.** `DailyMap` and `DailyBucket` are declared once in `merge.d.mts` and imported by `sources.d.mts` and `render.d.mts`. `OpenVsxReach` / `VsMarketplaceReach` are declared in `sources.d.mts` and reused in `render.d.mts`. `collect()` returns `{ ok, failed }` in Task 4 and is destructured as `{ ok, failed }` in both its CLI entry and its tests.

**Known risk carried, not hidden.** The `GITHUB_TOKEN` traffic permission is unverified until Task 6 Step 4. The fallback is designed in (`secrets.REACH_TOKEN || github.token`) so discovering it fails costs one secret, not a redesign.
