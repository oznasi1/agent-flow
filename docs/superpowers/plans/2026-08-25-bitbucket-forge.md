# Bitbucket Forge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `bitbucket` as a third forge alongside `github` and `gitlab`, reading pull requests, CI and review writes through the `atlassian-cli` CLI, in two modes depending on whether that CLI has a raw `bb api` passthrough.

**Architecture:** A new `Forge` implementation behind the existing seam in `src/engine/forge/types.ts`. Logic lives in pure modules (`pr/bb/pr.ts`, `pr/bb/projected.ts`, `pr/bb/rest.ts`); only `pr/bb/provider.ts` and `review/bb/provider.ts` spawn, through the injected `Runner`. The CLI's capability is probed once per Deck session (`bb api --help`) and selects which mapper runs. One optional seam member, `Forge.resolveCaps()`, lets the forge report capabilities that are only knowable after that probe.

**Tech Stack:** TypeScript on the VS Code extension host, Vitest, esbuild. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-08-25-bitbucket-forge-design.md](../specs/2026-08-25-bitbucket-forge-design.md)

## Global Constraints

These apply to **every** task. They are the repo's CI gate and its invariants, restated because an executor reads their task, not `CONTRIBUTING.md`.

- **The gate is exactly four commands, all must pass:** `npm ci`, `npm run typecheck`, `npm test`, `npm run build`.
- **`npm test` is ~4,500 tests across 122 files and takes 2+ minutes.** It exceeds the default Bash tool timeout and auto-backgrounds at 120s — pass `timeout: 600000`. **Never pipe vitest through `tail` or `head`**: it loses the failure list. A single failure under CPU contention is usually flake — re-run that file alone before believing it.
- **Run a subset while iterating:** `npx vitest run test/unit/engine/pr/bb/pr.test.ts`.
- **`npm run build` is a real gate.** Anything reachable from a browser entry point that imports `fs`/`os`/`path`/`child_process` breaks it even if the code never runs — esbuild resolves statically. `tsc` and the whole suite pass regardless. Nothing in this plan may be imported from `src/webview/`.
- **Never break existing users.** New behavior ships inert. The existing suite must pass **unmodified** — a test you had to edit to go green is the signal to stop and ask. The only pre-existing tests this plan edits are the ones whose subject genuinely gains a field (Task 1), and those edits are additive assertions, never changed ones.
- **Coverage thresholds are enforced** by `npm run test:cov`: 90% lines/statements, 85% branches/functions.
- **No hardcoded organization values.** Everything configurable reads through `getConfig()` in `src/config.ts`.
- **Vocabulary.** A *session* is one run of a coding tool. An *agent* is a worker a session delegates to. The tool is named ("Review with Claude Code"), never called "the agent". `test/unit/vocabulary.test.ts` enforces this.
- **`vscode` is aliased** to the hand-written mock in `test/_mocks/vscode.ts`.
- **Every user-facing change gets a `CHANGELOG.md` entry** under `## [Unreleased]` (Task 10).
- **Commit after every task.** Work in a git worktree — `main` moves fast and parallel sessions share the root checkout.

### Names this plan fixes (use these exactly)

| Name | Where |
|---|---|
| `BbRepo` = `{ workspace: string; slug: string }` | `pr/bb/pr.ts` |
| `parseBitbucketRemote(url: string): BbRepo \| null` | `pr/bb/pr.ts` |
| `bbPrUrl(repo: BbRepo, id: number): string` | `pr/bb/pr.ts` |
| `mapBbState(state: unknown): PrFacts["state"]` | `pr/bb/pr.ts` |
| `gradeBbPipeline(status: string \| null \| undefined): BranchCiStatus` | `pr/bb/pr.ts` |
| `pickBbPr<T>(prs: T[]): T \| undefined` | `pr/bb/pr.ts` |
| `toProjectedFacts(pr, repo, ci): PrFacts \| null` | `pr/bb/projected.ts` |
| `projectedCi(rows: unknown): PrFacts["ci"]` | `pr/bb/projected.ts` |
| `projectedBranchStatus(rows: unknown): BranchCiStatus` | `pr/bb/projected.ts` |
| `toRestFacts(pr, extra): PrFacts \| null` | `pr/bb/rest.ts` |
| `mapBbReview(participants): PrFacts["review"]` | `pr/bb/rest.ts` |
| `mapBbStatuses(json: unknown): PrFacts["ci"]` | `pr/bb/rest.ts` |
| `mapBbMergeable(json: unknown): PrFacts["mergeable"]` | `pr/bb/rest.ts` |
| `countBbUnresolved(json: unknown): number \| null` | `pr/bb/rest.ts` |
| `restBranchStatus(json: unknown): BranchCiStatus` | `pr/bb/rest.ts` |
| `BB_TIMEOUT_MS = 10_000` | `pr/bb/provider.ts` |
| `probeBb(run?, locate?): Promise<ForgeGap \| null>` | `pr/bb/provider.ts` |
| `probeBbApi(run?, locate?): Promise<boolean>` | `pr/bb/provider.ts` |
| `BbProvider` | `pr/bb/provider.ts` |
| `BbReviewProvider` | `review/bb/provider.ts` |
| `makeBitbucketForge(run?): Forge` | `forge/bitbucket.ts` |
| `ForgeCaps.reviewSearch: boolean` | `forge/types.ts` |
| `Forge.resolveCaps?(): Promise<ForgeCaps>` | `forge/types.ts` |

**Deviation from the spec, deliberate:** the spec calls the new capability
`reviewQueue`. `deckView.ts` already has a field named `this.reviewQueue` (the
session's own Review-queue flag), and `this.reviewQueue && this.caps().reviewQueue`
is unreadable in a file this carefully commented. The capability is named
**`reviewSearch`** — it maps exactly onto `reviews.search()`, which is the
capability in question.

**Second deviation, deliberate:** the spec's §7.4 says passthrough mode calls
`/2.0/user` for our own uuid. It does not need to. `PrFacts.review` describes the
*PR's* review state (GitHub's `reviewDecision`), not the viewer's, so
`mapBbReview` grades the whole `participants[]` array with no notion of "me".
One fewer call, one fewer failure mode.

---

## Task 1: The seam — `reviewSearch` capability and `resolveCaps`

Ships inert: both existing forges declare the new flag and omit `resolveCaps`, so their behavior is byte-identical.

**Files:**
- Modify: `src/engine/forge/types.ts`
- Modify: `src/engine/forge/github.ts:17`
- Modify: `src/engine/forge/gitlab.ts:18`
- Modify: `src/deckView.ts` (~340, ~1658-1673, ~1880, ~2992)
- Test: `test/unit/engine/forge/registry.test.ts`, `test/unit/deckView.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ForgeCaps.reviewSearch: boolean`; `Forge.resolveCaps?(): Promise<ForgeCaps>`; `DeckView`'s private `caps(): ForgeCaps`.

- [ ] **Step 1: Write the failing test**

In `test/unit/engine/forge/registry.test.ts`, add to the existing describe block:

```ts
it("both shipped forges can answer a review search, and neither needs a runtime probe", () => {
  for (const id of ["github", "gitlab"]) {
    const f = resolveForge(id, () => {});
    expect(f.caps.reviewSearch).toBe(true);
    // A forge whose caps are fully static omits resolveCaps, so deckView's
    // fallback to the static record is what runs for both of these.
    expect(f.resolveCaps).toBeUndefined();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/engine/forge/registry.test.ts`
Expected: FAIL — `expected undefined to be true` on `caps.reviewSearch`.

- [ ] **Step 3: Add the capability and the optional member**

In `src/engine/forge/types.ts`, add to `ForgeCaps` (after `changesRequested`):

```ts
  /** Can this forge answer "which pull requests are waiting on MY review"? A
   *  forge with no cross-repo reviewer query cannot, and must not fake it:
   *  `reviews.search()` returning `null` means THE ATTEMPT FAILED, so a forge
   *  that answered that way would leave the strip permanently stale and log a
   *  failure every TTL for a question that was never answerable. False hides
   *  the strip instead, through `deckView`'s existing `reviewsEnabled()` gate. */
  reviewSearch: boolean;
```

And add to `Forge`, after `caps`:

```ts
  /** Capabilities that cannot be known until the CLI has been probed — for a CLI
   *  whose command surface differs by version, where the same forge id is more
   *  capable on a newer build. Resolved once per Deck session, alongside
   *  `probe()`, and reset with it when settings change.
   *
   *  Optional on purpose: a forge whose caps are fully static omits this, and
   *  the static `caps` record above stands. That is what keeps this addition
   *  inert for `github` and `gitlab`. */
  resolveCaps?(): Promise<ForgeCaps>;
```

In `src/engine/forge/github.ts:17`: `caps: { changesRequested: true, reviewSearch: true },`
In `src/engine/forge/gitlab.ts:18`: `caps: { changesRequested: false, reviewSearch: true },`

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/engine/forge/registry.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing deckView test**

In `test/unit/deckView.test.ts`, near the existing `caps.changesRequested` test at ~line 3733:

```ts
it("prefers resolveCaps() over the static record, and probes it once", async () => {
  let calls = 0;
  const forge = fakeForge({
    caps: { changesRequested: false, reviewSearch: true },
    resolveCaps: async () => {
      calls++;
      return { changesRequested: true, reviewSearch: false };
    },
  });
  const view = await mountDeck({ forge });
  await view.refresh();
  await view.refresh();
  expect(calls).toBe(1);
  // reviewSearch:false came from the RESOLVED caps, not the static ones.
  expect(lastReviewsPost(view).enabled).toBe(false);
  expect(forge.reviews.search).not.toHaveBeenCalled();
});

it("falls back to the static caps when a forge has no resolveCaps", async () => {
  const forge = fakeForge({ caps: { changesRequested: false, reviewSearch: true } });
  const view = await mountDeck({ forge });
  await view.refresh();
  expect(lastReviewsPost(view).enabled).toBe(true);
});
```

> Use this file's existing helpers for mounting and for reading the last
> `deck:reviews` post — do not introduce new ones. Match the names already in
> use; `fakeForge`, `mountDeck` and `lastReviewsPost` above are placeholders for
> whatever this file already calls them. Read the file's top 80 lines first.

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/unit/deckView.test.ts -t "resolveCaps"`
Expected: FAIL — the strip is enabled, because nothing reads the resolved caps yet.

- [ ] **Step 7: Wire it into deckView**

Beside `private forgeGap` (~line 340):

```ts
  /** The forge's caps once `resolveCaps()` has settled, or undefined while it is
   *  in flight or for a forge that has none. `caps()` below falls back to the
   *  static record, which is what every forge without a runtime probe uses. */
  private forgeCaps: ForgeCaps | undefined;
```

Inside `forgeReady()`'s `void p.then(...)` block, after `this.forgeGap = gap;`:

```ts
        // Resolved in the same block as the probe, and guarded by the same
        // identity check: a caps read orphaned by a settings change must not
        // clobber a fresh one, exactly as a stale gap must not.
        void this.forge.resolveCaps?.().then((caps) => {
          if (this.forgeProbe !== p) return;
          this.forgeCaps = caps;
        });
```

Add the accessor next to `reviewsEnabled()`:

```ts
  /** The forge's capabilities, preferring anything `resolveCaps()` has settled.
   *  A forge without one — every forge but Bitbucket today — reads its static
   *  record here, so this is a no-op for them. */
  private caps(): ForgeCaps {
    return this.forgeCaps ?? this.forge.caps;
  }
```

Change `reviewsEnabled()` (~1880) to add the third gate, and update its docblock's "Two gates, not three" to "Three gates":

```ts
  private reviewsEnabled(): boolean {
    return this.reviewQueue && this.forgeReady() && this.caps().reviewSearch;
  }
```

Change the two `this.forge.caps` read sites to `this.caps()`:
- `src/deckView.ts:2392` — `verb === "request-changes" && !this.caps().changesRequested`
- `src/deckView.ts:3194` — `forge: this.caps()`

In `onConfigChanged` (~2992), reset alongside the gap:

```ts
      if (cfg.prFacts) {
        this.forgeGap = undefined;
        this.forgeProbe = null;
        this.forgeCaps = undefined;
      }
```

Import `ForgeCaps` as a **type-only** import in `deckView.ts`, beside the existing `ForgeGap` import:

```ts
import type { ForgeCaps, ForgeGap } from "./engine/forge/types";
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run test/unit/deckView.test.ts test/unit/engine/forge/registry.test.ts`
Expected: PASS, with no pre-existing test edited.

- [ ] **Step 9: Full gate**

Run: `npm run typecheck && npm run build`, then `npm test` with `timeout: 600000`.
Expected: all pass. Existing tests unmodified.

- [ ] **Step 10: Commit**

```bash
git add src/engine/forge/types.ts src/engine/forge/github.ts src/engine/forge/gitlab.ts src/deckView.ts test/unit/deckView.test.ts test/unit/engine/forge/registry.test.ts
git commit -m "feat(forge): a reviewSearch capability, and caps a forge resolves at probe time"
```

---

## Task 2: `pr/bb/pr.ts` — the pure shared half

No imports from `child_process`. Imported by nothing yet.

**Files:**
- Create: `src/engine/pr/bb/pr.ts`
- Test: `test/unit/engine/pr/bb/pr.test.ts`

**Interfaces:**
- Consumes: `pickByState` from `src/engine/pr/facts.ts`; `PrFacts` from `src/types.ts`; `BranchCiStatus` from `src/engine/orchestrator/branchCi.ts` (type-only).
- Produces: `BbRepo`, `parseBitbucketRemote`, `bbPrUrl`, `mapBbState`, `gradeBbPipeline`, `pickBbPr`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine/pr/bb/pr.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  bbPrUrl, gradeBbPipeline, mapBbState, parseBitbucketRemote, pickBbPr,
} from "../../../../../src/engine/pr/bb/pr";

describe("parseBitbucketRemote", () => {
  it("reads https, scp-style and ssh:// remotes, with or without .git", () => {
    const want = { workspace: "acme", slug: "api-service" };
    expect(parseBitbucketRemote("https://bitbucket.org/acme/api-service.git")).toEqual(want);
    expect(parseBitbucketRemote("https://bitbucket.org/acme/api-service")).toEqual(want);
    expect(parseBitbucketRemote("git@bitbucket.org:acme/api-service.git")).toEqual(want);
    expect(parseBitbucketRemote("ssh://git@bitbucket.org/acme/api-service.git")).toEqual(want);
    expect(parseBitbucketRemote("https://someone@bitbucket.org/acme/api-service.git")).toEqual(want);
    expect(parseBitbucketRemote("  https://bitbucket.org/acme/api-service.git\n")).toEqual(want);
  });

  it("refuses any host that is not bitbucket.org", () => {
    // Not defensive trivia: pointing the Bitbucket forge at a GitHub checkout
    // would synthesize bitbucket.org URLs for GitHub PRs (see bbPrUrl).
    expect(parseBitbucketRemote("https://github.com/acme/api-service.git")).toBeNull();
    expect(parseBitbucketRemote("git@gitlab.com:acme/api-service.git")).toBeNull();
  });

  it("returns null for anything without a workspace and a slug", () => {
    expect(parseBitbucketRemote("https://bitbucket.org/acme")).toBeNull();
    expect(parseBitbucketRemote("not a url at all")).toBeNull();
    expect(parseBitbucketRemote("")).toBeNull();
    expect(parseBitbucketRemote("   ")).toBeNull();
  });
});

describe("bbPrUrl", () => {
  it("builds the Cloud pull-request url", () => {
    expect(bbPrUrl({ workspace: "acme", slug: "api-service" }, 42))
      .toBe("https://bitbucket.org/acme/api-service/pull-requests/42");
  });
});

describe("mapBbState", () => {
  it("maps Bitbucket's four states onto the Deck's three", () => {
    expect(mapBbState("OPEN")).toBe("OPEN");
    expect(mapBbState("MERGED")).toBe("MERGED");
    expect(mapBbState("DECLINED")).toBe("CLOSED");
    expect(mapBbState("SUPERSEDED")).toBe("CLOSED");
    expect(mapBbState("open")).toBe("OPEN");
    expect(mapBbState(undefined)).toBe("CLOSED");
    expect(mapBbState(7)).toBe("CLOSED");
  });
});

describe("gradeBbPipeline", () => {
  it("grades the vocabulary both modes share", () => {
    expect(gradeBbPipeline("SUCCESSFUL")).toBe("passed");
    expect(gradeBbPipeline("successful")).toBe("passed");
    for (const s of ["FAILED", "ERROR", "STOPPED", "EXPIRED"]) {
      expect(gradeBbPipeline(s)).toBe("failed");
    }
    for (const s of ["PENDING", "IN_PROGRESS", "BUILDING", "PAUSED", "HALTED"]) {
      expect(gradeBbPipeline(s)).toBe("pending");
    }
  });

  it("calls anything it does not recognise unknown, and unknown is not green", () => {
    // COMPLETED is a `state.name` with no `state.result` — terminal, but it does
    // not say whether the pipeline passed. Reading it as green would open a
    // deploy gate on a pipeline that may have failed.
    expect(gradeBbPipeline("COMPLETED")).toBe("unknown");
    expect(gradeBbPipeline("SOMETHING_NEW")).toBe("unknown");
    expect(gradeBbPipeline("")).toBe("unknown");
    expect(gradeBbPipeline(null)).toBe("unknown");
    expect(gradeBbPipeline(undefined)).toBe("unknown");
  });
});

describe("pickBbPr", () => {
  it("prefers the live PR, then the merged one, then the declined one", () => {
    const prs = [
      { id: 1, state: "MERGED" }, { id: 2, state: "DECLINED" }, { id: 3, state: "OPEN" },
    ];
    expect(pickBbPr(prs)?.id).toBe(3);
    expect(pickBbPr([{ id: 1, state: "MERGED" }, { id: 2, state: "DECLINED" }])?.id).toBe(1);
  });

  it("takes the newest id within a state, and skips rows with no numeric id", () => {
    expect(pickBbPr([{ id: 4, state: "OPEN" }, { id: 9, state: "OPEN" }])?.id).toBe(9);
    expect(pickBbPr([{ id: "x", state: "OPEN" }])).toBeUndefined();
    expect(pickBbPr([])).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/engine/pr/bb/pr.test.ts`
Expected: FAIL — cannot resolve `../../../../../src/engine/pr/bb/pr`.

- [ ] **Step 3: Write the implementation**

Create `src/engine/pr/bb/pr.ts`:

```ts
// The pure half of the Bitbucket forge: everything both modes share. No process,
// no filesystem — `provider.ts` beside this file does the spawning.
//
// `import type` on BranchCiStatus, deliberately: `orchestrator/branchCi.ts` is on
// the webview import graph, and a value import from it here would be a runtime
// edge from a forge module into a module the Deck bundle also compiles.
import type { BranchCiStatus } from "../../orchestrator/branchCi";
import { pickByState } from "../facts";
import { PrFacts } from "../../../types";

/** A Bitbucket Cloud repo's two coordinates. Agent Flow's name for a CHECKOUT is
 * never the repo's name — this product's own worktrees are directories like
 * `bite-me-3a` — so these always come from the git remote, never from a path. */
export interface BbRepo {
  workspace: string;
  slug: string;
}

const BB_HOST = "bitbucket.org";

/** Workspace and slug from a git remote url, or null when this is not a
 * Bitbucket Cloud remote.
 *
 * The host check is load-bearing rather than defensive: `bbPrUrl` synthesizes a
 * bitbucket.org url from whatever this returns, so a GitHub remote sailing
 * through here would put a bitbucket.org link on a GitHub pull request's card.
 *
 * Bitbucket workspaces do not nest the way GitLab groups do, so the first two
 * path segments are the whole answer — no `projectFromMrUrl`-style walk needed. */
export function parseBitbucketRemote(url: string): BbRepo | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  let host = "";
  let path = "";
  // scp-style (`git@bitbucket.org:ws/slug.git`) is not a URL: `new URL` reads the
  // whole thing as a `git:` scheme with an empty host, so it must be matched first.
  const scp = /^[^@\s/]+@([^:\s]+):(.+)$/.exec(trimmed);
  if (scp) {
    host = scp[1];
    path = scp[2];
  } else {
    try {
      const u = new URL(trimmed);
      host = u.hostname;
      path = u.pathname;
    } catch {
      return null;
    }
  }
  if (host.toLowerCase() !== BB_HOST) return null;
  const parts = path.replace(/\.git$/i, "").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return { workspace: parts[0], slug: parts[1] };
}

/** The Cloud url for one pull request.
 *
 * In passthrough mode this is unused — `links.html.href` is on the PR object. In
 * projected mode it is the only url there is, because `bb pr list`/`pr get` emit
 * none and `PrFacts.url` is required. It matches the CLI's own convention: its
 * `get_pr_diff` builds this exact string. The day `pr get` starts emitting a
 * url, prefer it and delete this. */
export function bbPrUrl(repo: BbRepo, id: number): string {
  return `https://${BB_HOST}/${repo.workspace}/${repo.slug}/pull-requests/${id}`;
}

/** Bitbucket's four PR states onto the Deck's three. `DECLINED` and `SUPERSEDED`
 * both mean "abandoned", which is what CLOSED means here, and so does anything
 * unrecognised — a state we cannot read must not rank as OPEN in `pickBbPr`. */
export function mapBbState(state: unknown): PrFacts["state"] {
  const s = typeof state === "string" ? state.toUpperCase() : "";
  if (s === "OPEN") return "OPEN";
  if (s === "MERGED") return "MERGED";
  return "CLOSED";
}

const BB_FAILED = new Set(["FAILED", "ERROR", "STOPPED", "EXPIRED"]);
const BB_PENDING = new Set(["PENDING", "IN_PROGRESS", "BUILDING", "PAUSED", "HALTED"]);

/** One pipeline status string in the Deck's vocabulary.
 *
 * Shared by both modes, and that is not a coincidence worth refactoring apart
 * later: the CLI's projected `state` field is `state.result.name` falling back to
 * `state.name`, which is exactly the flattening `restBranchStatus` does itself.
 * One grader, two extractors.
 *
 * `COMPLETED` grades as `unknown`, not `passed`: it is a `state.name` that
 * arrives when `state.result` is absent, so it says the pipeline finished and
 * says nothing about whether it succeeded. `"unknown"` is NOT green, and this is
 * the one place that rule could be quietly broken. */
export function gradeBbPipeline(status: string | null | undefined): BranchCiStatus {
  if (!status) return "unknown";
  const s = status.toUpperCase();
  if (s === "SUCCESSFUL") return "passed";
  if (BB_FAILED.has(s)) return "failed";
  if (BB_PENDING.has(s)) return "pending";
  return "unknown";
}

/** One branch can carry several PRs across its history. Same precedence policy as
 * the other two forges, shared through `pickByState`: prefer the live one, then
 * the one that landed, then the abandoned one; newest id wins within a state. */
export function pickBbPr<T extends { id?: unknown; state?: unknown }>(prs: T[]): T | undefined {
  return pickByState(prs, (p) => ({
    number: typeof p.id === "number" ? p.id : undefined,
    state: mapBbState(p.state),
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/engine/pr/bb/pr.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine/pr/bb/pr.ts test/unit/engine/pr/bb/pr.test.ts
git commit -m "feat(bitbucket): pure remote, state and pipeline mapping"
```

---

## Task 3: `pr/bb/projected.ts` — the lean mapper

**Files:**
- Create: `src/engine/pr/bb/projected.ts`
- Test: `test/unit/engine/pr/bb/projected.test.ts`

**Interfaces:**
- Consumes: `BbRepo`, `bbPrUrl`, `mapBbState`, `gradeBbPipeline` from `./pr`.
- Produces: `BbProjectedPr`, `toProjectedFacts(pr, repo, ci)`, `projectedCi(rows)`, `projectedBranchStatus(rows)`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine/pr/bb/projected.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  projectedBranchStatus, projectedCi, toProjectedFacts,
} from "../../../../../src/engine/pr/bb/projected";

const REPO = { workspace: "acme", slug: "api-service" };

/** One `bb pr list --format json` row, with EVERY field that command emits and
 * no others. Taken from `Row` in `crates/cli/src/commands/bitbucket/pullrequests.rs`
 * at omar16100/atlassian-cli@main — NOT from Bitbucket's API docs, which describe
 * a far richer object this command never passes through. Adding a field here that
 * the CLI does not emit would test the mapper against a response that can never
 * arrive. */
const ROW = {
  id: 42, title: "Add export", state: "OPEN",
  author: "Ada Lovelace", source: "feat/PROJ-1", destination: "main",
};

describe("toProjectedFacts", () => {
  it("fills what the CLI emits and synthesizes the url", () => {
    const facts = toProjectedFacts(ROW, REPO, { passing: 1, pending: 0, failing: [] });
    expect(facts).toMatchObject({
      number: 42,
      url: "https://bitbucket.org/acme/api-service/pull-requests/42",
      title: "Add export",
      state: "OPEN",
      ci: { passing: 1, pending: 0, failing: [] },
    });
  });

  it("reports every unreadable field as an ABSENCE, never as a value", () => {
    // Pinned one by one on purpose. Each of these is a fact `bb pr list` does not
    // carry, and the failure mode this guards is a later change that starts
    // inventing one — a card claiming "no conflicts" or "not a draft" from a
    // response that said neither.
    const facts = toProjectedFacts(ROW, REPO, { passing: 0, pending: 0, failing: [] });
    expect(facts?.isDraft).toBe(false);
    expect(facts?.mergeable).toBe("unknown");
    expect(facts?.review).toBe("none");
    expect(facts?.unresolved).toBeNull();
    expect(facts?.ciAdvisory).toBe(false);
  });

  it("returns null without a numeric id, since there is no url to build", () => {
    expect(toProjectedFacts({ ...ROW, id: "42" }, REPO, { passing: 0, pending: 0, failing: [] })).toBeNull();
    expect(toProjectedFacts({}, REPO, { passing: 0, pending: 0, failing: [] })).toBeNull();
  });

  it("survives a missing title rather than throwing", () => {
    expect(toProjectedFacts({ id: 7 }, REPO, { passing: 0, pending: 0, failing: [] })?.title).toBe("");
  });
});

describe("projectedCi", () => {
  it("turns the newest pipeline row into a one-check tally", () => {
    expect(projectedCi([{ build_number: 12, state: "SUCCESSFUL" }]))
      .toEqual({ passing: 1, pending: 0, failing: [] });
    expect(projectedCi([{ build_number: 12, state: "IN_PROGRESS" }]))
      .toEqual({ passing: 0, pending: 1, failing: [] });
    expect(projectedCi([{ build_number: 12, state: "FAILED" }]))
      .toEqual({ passing: 0, pending: 0, failing: [{ name: "Pipeline #12", url: "" }] });
  });

  it("tallies zeros for no pipeline, an unknown state, or a non-array", () => {
    const none = { passing: 0, pending: 0, failing: [] };
    expect(projectedCi([])).toEqual(none);
    expect(projectedCi([{ build_number: 1, state: "COMPLETED" }])).toEqual(none);
    expect(projectedCi({ message: "404 Not Found" })).toEqual(none);
    expect(projectedCi(null)).toEqual(none);
  });

  it("names a failing pipeline without a build number", () => {
    expect(projectedCi([{ state: "FAILED" }]))
      .toEqual({ passing: 0, pending: 0, failing: [{ name: "Pipeline", url: "" }] });
  });
});

describe("projectedBranchStatus", () => {
  it("grades the newest row, and calls anything unreadable unknown", () => {
    expect(projectedBranchStatus([{ state: "SUCCESSFUL" }])).toBe("passed");
    expect(projectedBranchStatus([{ state: "FAILED" }])).toBe("failed");
    expect(projectedBranchStatus([])).toBe("unknown");
    expect(projectedBranchStatus({ message: "404" })).toBe("unknown");
    expect(projectedBranchStatus(null)).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/engine/pr/bb/projected.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/engine/pr/bb/projected.ts`:

```ts
// Projected mode: mapping `atlassian-cli`'s own row structs, for a CLI with no
// `bb api` passthrough. Pure — no process, no filesystem.
//
// Every shape here is what the CLI SERIALIZES, not what Bitbucket sends. The CLI
// deserializes each API response into a narrow hand-written struct and emits
// that, so these types are deliberately much thinner than Bitbucket's own. Read
// `crates/cli/src/commands/bitbucket/` before adding a field: one that the CLI
// does not project can never arrive, however plainly the API docs list it.
import type { BranchCiStatus } from "../../orchestrator/branchCi";
import { BbRepo, bbPrUrl, gradeBbPipeline, mapBbState } from "./pr";
import { PrCheck, PrFacts } from "../../../types";

/** One `bb pr list --format json` row. Every field the command emits, and no
 * others; all `unknown`, because nothing has validated them yet. */
export interface BbProjectedPr {
  id?: unknown;
  title?: unknown;
  state?: unknown;
  author?: unknown;
  source?: unknown;
  destination?: unknown;
}

/** One `bb pipeline list --format json` row. `state` is already flattened by the
 * CLI to `state.result.name` falling back to `state.name`, which is why
 * `gradeBbPipeline` can be shared with the REST path. */
interface BbProjectedPipeline {
  build_number?: unknown;
  state?: unknown;
  ref_name?: unknown;
}

function newestPipeline(rows: unknown): BbProjectedPipeline | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const first: unknown = rows[0];
  return first && typeof first === "object" ? (first as BbProjectedPipeline) : null;
}

/** The newest pipeline's verdict as a CI tally.
 *
 * One check, never a breakdown: projected mode has no per-check data at all, so
 * this is a single synthetic entry standing for the whole pipeline. An
 * unrecognised state tallies to zeros rather than to a failure — inventing a red
 * check from a state we do not know would send the user to a PR that is fine. */
export function projectedCi(rows: unknown): PrFacts["ci"] {
  const none: PrFacts["ci"] = { passing: 0, pending: 0, failing: [] };
  const p = newestPipeline(rows);
  if (!p) return none;
  const verdict = gradeBbPipeline(typeof p.state === "string" ? p.state : null);
  if (verdict === "passed") return { passing: 1, pending: 0, failing: [] };
  if (verdict === "pending") return { passing: 0, pending: 1, failing: [] };
  if (verdict === "failed") {
    const name = typeof p.build_number === "number" ? `Pipeline #${p.build_number}` : "Pipeline";
    const failing: PrCheck[] = [{ name, url: "" }];
    return { passing: 0, pending: 0, failing };
  }
  return none;
}

/** The newest pipeline's verdict for the orchestrator's branch-CI gate. */
export function projectedBranchStatus(rows: unknown): BranchCiStatus {
  const p = newestPipeline(rows);
  return gradeBbPipeline(p && typeof p.state === "string" ? p.state : null);
}

/** One projected row → `PrFacts`, or null when it carries no id to build a url
 * from.
 *
 * Everything this cannot fill is an ABSENCE rather than a value, and each one is
 * pinned by its own assertion in the tests: `isDraft: false` because the CLI
 * emits no draft flag — not because we checked and it is not a draft; `mergeable:
 * "unknown"` because it emits no conflict state; `review: "none"` because
 * `approvals` is a count with no identity attached; `unresolved: null` because
 * `comment_count` is a total with no resolution state.
 *
 * `ciAdvisory` is false in both modes: Bitbucket draws no required/optional line
 * across build statuses, so there is no "everything required passed, something
 * optional did not" for it to mean. */
export function toProjectedFacts(pr: BbProjectedPr, repo: BbRepo, ci: PrFacts["ci"]): PrFacts | null {
  if (typeof pr.id !== "number") return null;
  return {
    number: pr.id,
    url: bbPrUrl(repo, pr.id),
    title: typeof pr.title === "string" ? pr.title : "",
    state: mapBbState(pr.state),
    isDraft: false,
    ci,
    review: "none",
    unresolved: null,
    mergeable: "unknown",
    ciAdvisory: false,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/engine/pr/bb/projected.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine/pr/bb/projected.ts test/unit/engine/pr/bb/projected.test.ts
git commit -m "feat(bitbucket): map the CLI's projected rows to PrFacts"
```

---

## Task 4: `pr/bb/rest.ts` — the passthrough mapper

**Files:**
- Create: `src/engine/pr/bb/rest.ts`
- Test: `test/unit/engine/pr/bb/rest.test.ts`

**Interfaces:**
- Consumes: `mapBbState`, `gradeBbPipeline` from `./pr`.
- Produces: `BbRestPr`, `toRestFacts(pr, extra)`, `mapBbReview(participants)`, `mapBbStatuses(json)`, `mapBbMergeable(json)`, `countBbUnresolved(json)`, `restBranchStatus(json)`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine/pr/bb/rest.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  countBbUnresolved, mapBbMergeable, mapBbReview, mapBbStatuses,
  restBranchStatus, toRestFacts,
} from "../../../../../src/engine/pr/bb/rest";

/** One PR as `GET /2.0/repositories/{ws}/{slug}/pullrequests/{id}` sends it.
 * Fields taken from the `pullrequest` schema in Bitbucket's OpenAPI spec. */
const PR = {
  id: 42, title: "Add export", state: "OPEN", draft: false,
  links: { html: { href: "https://bitbucket.org/acme/api-service/pull-requests/42" } },
  source: { branch: { name: "feat/PROJ-1" } },
  destination: { branch: { name: "main" } },
  participants: [] as unknown[],
};
const NO_CI = { passing: 0, pending: 0, failing: [] };

describe("toRestFacts", () => {
  it("reads the url and the draft flag the passthrough actually carries", () => {
    const facts = toRestFacts({ ...PR, draft: true }, { ci: NO_CI, mergeable: "clean", unresolved: 0 });
    expect(facts).toMatchObject({
      number: 42,
      url: "https://bitbucket.org/acme/api-service/pull-requests/42",
      state: "OPEN",
      isDraft: true,
      mergeable: "clean",
      unresolved: 0,
    });
  });

  it("returns null without an id or a usable html link", () => {
    expect(toRestFacts({ ...PR, id: "42" }, { ci: NO_CI, mergeable: "unknown", unresolved: null })).toBeNull();
    expect(toRestFacts({ ...PR, links: {} }, { ci: NO_CI, mergeable: "unknown", unresolved: null })).toBeNull();
    expect(toRestFacts({ ...PR, links: { html: { href: "" } } }, { ci: NO_CI, mergeable: "unknown", unresolved: null })).toBeNull();
  });
});

describe("mapBbReview", () => {
  const reviewer = (over: Record<string, unknown>) => ({ role: "REVIEWER", approved: false, state: null, ...over });

  it("reports the PR's review state, not any one person's", () => {
    // PrFacts.review is GitHub's `reviewDecision`: a fact about the pull request.
    // So changes-requested by ANYONE outranks an approval by someone else.
    expect(mapBbReview([reviewer({ approved: true, state: "approved" }), reviewer({ state: "changes_requested" })]))
      .toBe("changes_requested");
    expect(mapBbReview([reviewer({ approved: true, state: "approved" })])).toBe("approved");
    expect(mapBbReview([reviewer({})])).toBe("review_required");
  });

  it("ignores participants who are not reviewers", () => {
    // A commenter is a participant too. Counting one as an outstanding reviewer
    // would leave every commented-on PR reading as review_required forever.
    expect(mapBbReview([{ role: "PARTICIPANT", approved: false, state: null }])).toBe("none");
    expect(mapBbReview([{ role: "PARTICIPANT", approved: true, state: "approved" }])).toBe("none");
  });

  it("says none when there are no reviewers at all", () => {
    expect(mapBbReview([])).toBe("none");
    expect(mapBbReview(null)).toBe("none");
    expect(mapBbReview(undefined)).toBe("none");
  });
});

describe("mapBbStatuses", () => {
  it("tallies build statuses and names the failing ones", () => {
    const json = { values: [
      { state: "SUCCESSFUL", key: "PIPE", name: "Pipeline", url: "https://ci/1" },
      { state: "INPROGRESS", key: "LINT", name: "Lint", url: "" },
      { state: "FAILED", key: "TEST", name: "Tests", url: "https://ci/3" },
    ] };
    expect(mapBbStatuses(json)).toEqual({
      passing: 1, pending: 1, failing: [{ name: "Tests", url: "https://ci/3" }],
    });
  });

  it("falls back to the status key, then to a fixed name", () => {
    expect(mapBbStatuses({ values: [{ state: "FAILED", key: "TEST" }] }).failing)
      .toEqual([{ name: "TEST", url: "" }]);
    expect(mapBbStatuses({ values: [{ state: "FAILED" }] }).failing)
      .toEqual([{ name: "check", url: "" }]);
  });

  it("tallies zeros for a non-list, and skips rows it cannot read", () => {
    expect(mapBbStatuses({ message: "404 Not Found" })).toEqual(NO_CI);
    expect(mapBbStatuses(null)).toEqual(NO_CI);
    expect(mapBbStatuses({ values: [null, "nope", { state: "WHAT" }] })).toEqual(NO_CI);
  });
});

describe("mapBbMergeable", () => {
  it("reads an empty conflicts list as clean and a populated one as conflicting", () => {
    expect(mapBbMergeable({ values: [] })).toBe("clean");
    expect(mapBbMergeable({ values: [{ path: "src/a.ts" }] })).toBe("conflicting");
  });

  it("says unknown when the call gave us no list", () => {
    expect(mapBbMergeable({ message: "404 Not Found" })).toBe("unknown");
    expect(mapBbMergeable(null)).toBe("unknown");
  });
});

describe("countBbUnresolved", () => {
  const thread = (over: Record<string, unknown>) => ({
    id: 1, inline: { path: "src/a.ts", to: 4 }, resolution: null, ...over,
  });

  it("counts unresolved inline threads", () => {
    expect(countBbUnresolved({ values: [thread({ id: 1 }), thread({ id: 2 })] })).toBe(2);
    expect(countBbUnresolved({ values: [thread({ resolution: { type: "resolved" } })] })).toBe(0);
  });

  it("skips replies, deleted comments, and comments that are not review threads", () => {
    // A reply inherits its thread's resolution, so counting it would double-count
    // one conversation. A plain PR comment is not a review thread at all.
    expect(countBbUnresolved({ values: [thread({ parent: { id: 1 } })] })).toBe(0);
    expect(countBbUnresolved({ values: [thread({ deleted: true })] })).toBe(0);
    expect(countBbUnresolved({ values: [thread({ inline: undefined })] })).toBe(0);
  });

  it("returns null when the call gave us no list", () => {
    expect(countBbUnresolved({ message: "404 Not Found" })).toBeNull();
    expect(countBbUnresolved(null)).toBeNull();
  });
});

describe("restBranchStatus", () => {
  it("flattens state.result over state.name, exactly as the CLI does", () => {
    expect(restBranchStatus({ values: [{ state: { name: "COMPLETED", result: { name: "SUCCESSFUL" } } }] })).toBe("passed");
    expect(restBranchStatus({ values: [{ state: { name: "IN_PROGRESS" } }] })).toBe("pending");
    // COMPLETED with no result says the pipeline finished, not that it passed.
    expect(restBranchStatus({ values: [{ state: { name: "COMPLETED" } }] })).toBe("unknown");
  });

  it("says unknown for an empty list, a non-list, or a missing state", () => {
    expect(restBranchStatus({ values: [] })).toBe("unknown");
    expect(restBranchStatus({ message: "404" })).toBe("unknown");
    expect(restBranchStatus(null)).toBe("unknown");
    expect(restBranchStatus({ values: [{}] })).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/engine/pr/bb/rest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/engine/pr/bb/rest.ts`:

```ts
// Passthrough mode: mapping Bitbucket Cloud's own REST payloads, reached through
// `bb api <path>`. Pure — no process, no filesystem.
//
// Shapes here come from Bitbucket's OpenAPI spec (`pullrequest`, `participant`,
// `pullrequest_comment`, `commitstatus`, `pipeline`), which is the real contract
// on this path — unlike `projected.ts`, whose shapes are the CLI's own structs.
// Keep the two straight: a field that exists here may well not exist there.
import type { BranchCiStatus } from "../../orchestrator/branchCi";
import { gradeBbPipeline, mapBbState } from "./pr";
import { PrCheck, PrFacts } from "../../../types";

interface BbRestParticipant {
  role?: unknown;
  approved?: unknown;
  state?: unknown;
}

/** One PR as the single-PR route sends it. Every field `unknown` or narrowly
 * shaped: nothing has validated it, and each reader below checks what it uses. */
export interface BbRestPr {
  id?: unknown;
  title?: unknown;
  state?: unknown;
  draft?: unknown;
  links?: { html?: { href?: unknown } | null } | null;
  participants?: unknown;
}

function values(json: unknown): unknown[] | null {
  const v = (json as { values?: unknown } | null | undefined)?.values;
  return Array.isArray(v) ? v : null;
}

/** The PR's review state, in the Deck's vocabulary.
 *
 * A fact about the PULL REQUEST, not about the viewer — the same thing GitHub's
 * `reviewDecision` reports. That is why nothing here needs to know who we are,
 * and why no `/2.0/user` call is required on this path.
 *
 * Changes-requested outranks an approval: one reviewer blocking is the state of
 * the pull request even when another has approved. Only `REVIEWER` participants
 * count — a commenter is a participant too, and counting one as an outstanding
 * reviewer would leave every commented-on PR reading `review_required` forever. */
export function mapBbReview(participants: unknown): PrFacts["review"] {
  if (!Array.isArray(participants)) return "none";
  let reviewers = 0;
  let approved = false;
  for (const raw of participants) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as BbRestParticipant;
    if (typeof p.role !== "string" || p.role.toUpperCase() !== "REVIEWER") continue;
    reviewers++;
    const state = typeof p.state === "string" ? p.state.toLowerCase() : "";
    if (state === "changes_requested") return "changes_requested";
    if (state === "approved" || p.approved === true) approved = true;
  }
  if (reviewers === 0) return "none";
  return approved ? "approved" : "review_required";
}

const BB_STATUS_FAIL = new Set(["FAILED", "STOPPED", "ERROR"]);

/** Build statuses on a PR as a CI tally. Unlike projected mode, this is a real
 * per-check breakdown, so a failing card names the checks that failed.
 *
 * An unrecognised state is skipped rather than counted as failing: inventing a
 * red check from a state we do not know would send the user to a PR that is fine. */
export function mapBbStatuses(json: unknown): PrFacts["ci"] {
  const failing: PrCheck[] = [];
  let passing = 0;
  let pending = 0;
  for (const raw of values(json) ?? []) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as { state?: unknown; name?: unknown; key?: unknown; url?: unknown };
    const s = typeof c.state === "string" ? c.state.toUpperCase() : "";
    if (s === "SUCCESSFUL") {
      passing++;
    } else if (s === "INPROGRESS") {
      pending++;
    } else if (BB_STATUS_FAIL.has(s)) {
      const name =
        (typeof c.name === "string" && c.name) || (typeof c.key === "string" && c.key) || "check";
      failing.push({ name, url: typeof c.url === "string" ? c.url : "" });
    }
  }
  return { passing, pending, failing };
}

/** The conflicts route as a mergeability verdict. An empty list is a real
 * "clean"; anything that is not a list at all — an error object, a truncated
 * body — is `"unknown"`, which is not clean. */
export function mapBbMergeable(json: unknown): PrFacts["mergeable"] {
  const v = values(json);
  if (v === null) return "unknown";
  return v.length > 0 ? "conflicting" : "clean";
}

/** Unresolved review threads, or null when we could not get a list.
 *
 * Counts thread ROOTS only, and only inline ones, which is what makes this
 * comparable to GitHub's `reviewThreads`: a reply inherits its thread's
 * resolution, so counting replies would count one conversation several times,
 * and a plain PR comment is not a review thread at all. */
export function countBbUnresolved(json: unknown): number | null {
  const v = values(json);
  if (v === null) return null;
  let n = 0;
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as { parent?: unknown; deleted?: unknown; inline?: unknown; resolution?: unknown };
    if (c.deleted === true) continue;
    if (c.parent) continue;
    if (!c.inline) continue;
    if (c.resolution == null) n++;
  }
  return n;
}

/** The newest pipeline for a ref, graded.
 *
 * The flattening — `state.result.name`, falling back to `state.name` — is the
 * same one the CLI performs before emitting its projected `state` string, which
 * is what lets both modes share `gradeBbPipeline`. */
export function restBranchStatus(json: unknown): BranchCiStatus {
  const first = values(json)?.[0];
  if (!first || typeof first !== "object") return "unknown";
  const state = (first as { state?: { name?: unknown; result?: { name?: unknown } | null } | null }).state;
  const result = state?.result?.name;
  if (typeof result === "string") return gradeBbPipeline(result);
  return gradeBbPipeline(typeof state?.name === "string" ? state.name : null);
}

/** One REST PR → `PrFacts`, or null when it carries no identity we could render
 * or link. Stricter than a falsy test on the url: a non-string href would
 * otherwise reach `PrFacts.url`. */
export function toRestFacts(
  pr: BbRestPr,
  extra: { ci: PrFacts["ci"]; mergeable: PrFacts["mergeable"]; unresolved: number | null },
): PrFacts | null {
  if (typeof pr.id !== "number") return null;
  const href = pr.links?.html?.href;
  if (typeof href !== "string" || !href) return null;
  return {
    number: pr.id,
    url: href,
    title: typeof pr.title === "string" ? pr.title : "",
    state: mapBbState(pr.state),
    isDraft: pr.draft === true,
    ci: extra.ci,
    review: mapBbReview(pr.participants),
    unresolved: extra.unresolved,
    mergeable: extra.mergeable,
    // Bitbucket draws no required/optional line across build statuses, so there
    // is no "everything required passed, something optional did not" to report.
    ciAdvisory: false,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/engine/pr/bb/rest.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine/pr/bb/rest.ts test/unit/engine/pr/bb/rest.test.ts
git commit -m "feat(bitbucket): map Bitbucket REST payloads to PrFacts"
```

---

## Task 5: `pr/bb/provider.ts` — probes, mode detection, and both fetch paths

**Files:**
- Create: `src/engine/pr/bb/provider.ts`
- Test: `test/unit/engine/pr/bb/provider.test.ts`

**Interfaces:**
- Consumes: `Runner`, `Locate`, `FetchResult`, `PrProvider`, `execRunner` from `src/engine/pr/provider.ts`; `ForgeGap` (type-only) from `src/engine/forge/types.ts`; `resolveBin` from `src/engine/pr/which.ts`; everything from `./pr`, `./projected`, `./rest`.
- Produces: `BB_TIMEOUT_MS`, `BB_BIN`, `probeBb`, `probeBbApi`, `BbProvider` (constructor `(run, locate, apiMode: () => Promise<boolean>)`), `bbBranchCi(run, locate, apiMode, repoPath, branch)`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine/pr/bb/provider.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { BbProvider, bbBranchCi, probeBb, probeBbApi } from "../../../../../src/engine/pr/bb/provider";
import type { Runner } from "../../../../../src/engine/pr/provider";

/** An absolute path, as a real lookup returns: nothing here may depend on the
 * bare name `atlassian-cli` being resolvable from the test process's own PATH. */
const BB = "/opt/homebrew/bin/atlassian-cli";
const REMOTE = "https://bitbucket.org/acme/api-service.git";

/** A Runner that replies by matching an argv fragment, so a test states what each
 * call returns instead of depending on call order. An unmatched call throws,
 * which is what the real CLI does for a bad route. More specific fragments must
 * be listed before less specific ones — lookup is by insertion order. */
function routed(routes: Record<string, string | Error>): {
  run: Runner;
  calls: { args: string[]; cwd: string }[];
} {
  const calls: { args: string[]; cwd: string }[] = [];
  const run: Runner = async (file, args, opts) => {
    calls.push({ args, cwd: opts.cwd });
    expect(file).toBe(BB);
    const hit = Object.entries(routes).find(([frag]) => args.some((a) => a.includes(frag)));
    if (!hit) throw new Error(`unrouted: ${args.join(" ")}`);
    if (hit[1] instanceof Error) throw hit[1];
    return hit[1];
  };
  return { run, calls };
}

const provider = (run: Runner, apiMode: boolean) =>
  new BbProvider(run, () => BB, async () => apiMode);

const PROJECTED_ROW = {
  id: 42, title: "PROJ-1 add export", state: "OPEN",
  author: "Ada", source: "feat/PROJ-1", destination: "main",
};
const REST_PR = {
  id: 42, title: "PROJ-1 add export", state: "OPEN", draft: false,
  links: { html: { href: "https://bitbucket.org/acme/api-service/pull-requests/42" } },
  participants: [{ role: "REVIEWER", approved: true, state: "approved" }],
};

describe("probeBbApi", () => {
  it("is true when `bb api --help` exits zero and false when it does not", async () => {
    const ok = routed({ "--help": "Usage: atlassian-cli bb api <PATH>" });
    await expect(probeBbApi(ok.run, () => BB)).resolves.toBe(true);
    expect(ok.calls[0].args).toEqual(["bb", "api", "--help"]);

    const old = routed({ "--help": new Error("unrecognized subcommand 'api'") });
    await expect(probeBbApi(old.run, () => BB)).resolves.toBe(false);
  });
});

describe("probeBb", () => {
  it("authenticates against Bitbucket specifically", async () => {
    const { run, calls } = routed({ "auth": "" });
    await expect(probeBb(run, () => BB)).resolves.toBeNull();
    expect(calls[0].args).toEqual(["auth", "test", "--bitbucket"]);
  });

  it("blames the install only for ENOENT", async () => {
    const missing = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    await expect(probeBb(routed({ auth: missing }).run, () => BB))
      .resolves.toMatchObject({ kind: "missing" });
    // Anything else came from a CLI that ran, so blaming the install would send
    // the user hunting for a binary they already have.
    await expect(probeBb(routed({ auth: new Error("401 Unauthorized") }).run, () => BB))
      .resolves.toMatchObject({ kind: "signed-out" });
  });
});

describe("BbProvider.fetch — projected mode", () => {
  it("reads the remote, lists open PRs, and matches the branch client-side", async () => {
    const { run, calls } = routed({
      "remote.origin.url": REMOTE,
      "pipeline": JSON.stringify([{ build_number: 7, state: "SUCCESSFUL" }]),
      "pr": JSON.stringify([{ ...PROJECTED_ROW, source: "other" }, PROJECTED_ROW]),
    });
    const res = await provider(run, false).fetch("/repos/api-service", "feat/PROJ-1", "PROJ-1");
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({ number: 42, state: "OPEN" }) });

    // Argv is what actually reached the CLI — the honest thing to pin. An
    // exported path helper would only let this test agree with itself about a
    // string the CLI never saw.
    expect(calls[1].args).toEqual([
      "--workspace", "acme", "bb", "pr", "list", "api-service",
      "--state", "OPEN", "--limit", "25", "--format", "json",
    ]);
    expect(calls[1].cwd).toBe("/repos/api-service");
  });

  it("falls back to a title match on the task key when no branch matches", async () => {
    const { run } = routed({
      "remote.origin.url": REMOTE,
      "pipeline": JSON.stringify([]),
      "pr": JSON.stringify([PROJECTED_ROW]),
    });
    const res = await provider(run, false).fetch("/repos/api-service", "some/other-branch", "PROJ-1");
    expect(res).toMatchObject({ ok: true, facts: { number: 42 } });
  });

  it("reports no PR — not a failure — when nothing matches", async () => {
    const { run } = routed({ "remote.origin.url": REMOTE, "pr": JSON.stringify([]) });
    await expect(provider(run, false).fetch("/r", "feat/x", "PROJ-9")).resolves.toEqual({ ok: true, facts: null });
  });
});

describe("BbProvider.fetch — passthrough mode", () => {
  it("filters server-side and fills draft, review, conflicts and statuses", async () => {
    const { run, calls } = routed({
      "remote.origin.url": REMOTE,
      "/statuses": JSON.stringify({ values: [{ state: "SUCCESSFUL", name: "Pipeline" }] }),
      "/conflicts": JSON.stringify({ values: [] }),
      "/comments": JSON.stringify({ values: [] }),
      "source.branch.name": JSON.stringify({ values: [REST_PR] }),
    });
    const res = await provider(run, true).fetch("/repos/api-service", "feat/PROJ-1", "PROJ-1");
    expect(res).toMatchObject({
      ok: true,
      facts: {
        number: 42,
        url: "https://bitbucket.org/acme/api-service/pull-requests/42",
        review: "approved",
        mergeable: "clean",
        unresolved: 0,
        ci: { passing: 1, pending: 0, failing: [] },
      },
    });
    expect(calls[1].args[0]).toBe("bb");
    expect(calls[1].args[1]).toBe("api");
    expect(calls[1].args[2]).toContain('/2.0/repositories/acme/api-service/pullrequests?q=source.branch.name="feat/PROJ-1"');
  });

  it("keeps the PR when a detail call fails, losing only that detail", async () => {
    const { run } = routed({
      "remote.origin.url": REMOTE,
      "/statuses": new Error("500"),
      "/conflicts": new Error("500"),
      "/comments": new Error("500"),
      "source.branch.name": JSON.stringify({ values: [REST_PR] }),
    });
    await expect(provider(run, true).fetch("/r", "feat/PROJ-1", "PROJ-1")).resolves.toMatchObject({
      ok: true,
      facts: { number: 42, mergeable: "unknown", unresolved: null, ci: { passing: 0, pending: 0, failing: [] } },
    });
  });
});

describe("BbProvider.fetch — failure contract", () => {
  it("fails the fetch when the remote is not a Bitbucket one", async () => {
    // Not a curiosity: a GitHub remote would otherwise get bitbucket.org urls.
    const { run } = routed({ "remote.origin.url": "https://github.com/acme/api-service.git" });
    await expect(provider(run, false).fetch("/r", "b", "K")).resolves.toEqual({ ok: false });
  });

  it("fails the fetch rather than reading an error object as an empty list", async () => {
    const { run } = routed({
      "remote.origin.url": REMOTE,
      "pr": JSON.stringify({ message: "404 Not Found" }),
    });
    await expect(provider(run, false).fetch("/r", "b", "K")).resolves.toEqual({ ok: false });
  });

  it("never throws, whatever the runner does", async () => {
    // An uncaught throw here leaves the caller's cache entry unstamped, which
    // re-arms this repo's fetch on every 6s tick, forever.
    for (const reply of [new Error("boom"), "not json at all", "null"]) {
      const { run } = routed({ "remote.origin.url": REMOTE, "pr": reply, "pipeline": reply });
      await expect(provider(run, false).fetch("/r", "b", "K")).resolves.toEqual({ ok: false });
    }
  });

  it("probes the mode once, however many fetches run", async () => {
    let modeCalls = 0;
    const { run } = routed({ "remote.origin.url": REMOTE, "pr": JSON.stringify([]) });
    const p = new BbProvider(run, () => BB, async () => {
      modeCalls++;
      return false;
    });
    await p.fetch("/r", "b", "K");
    await p.fetch("/r", "b", "K");
    expect(modeCalls).toBe(2); // the forge memoizes, not the provider — see makeBitbucketForge
  });
});

describe("bbBranchCi", () => {
  it("grades the newest pipeline in each mode", async () => {
    const projected = routed({
      "remote.origin.url": REMOTE,
      "pipeline": JSON.stringify([{ build_number: 7, state: "FAILED" }]),
    });
    await expect(bbBranchCi(projected.run, () => BB, async () => false, "/r", "main")).resolves.toBe("failed");

    const rest = routed({
      "remote.origin.url": REMOTE,
      "pipelines": JSON.stringify({ values: [{ state: { name: "COMPLETED", result: { name: "SUCCESSFUL" } } }] }),
    });
    await expect(bbBranchCi(rest.run, () => BB, async () => true, "/r", "main")).resolves.toBe("passed");
  });

  it("answers unknown rather than throwing, and unknown is not green", async () => {
    const { run } = routed({ "remote.origin.url": REMOTE, "pipeline": new Error("timeout") });
    await expect(bbBranchCi(run, () => BB, async () => false, "/r", "main")).resolves.toBe("unknown");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/engine/pr/bb/provider.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/engine/pr/bb/provider.ts`:

```ts
// PR facts for one repo's one branch, through `atlassian-cli`. The Bitbucket
// counterpart of `../provider.ts` and `../glab/provider.ts`, spawning through the
// same injected `Runner` so no test forks a process.
//
// Two modes, selected by an injected thunk rather than probed here: `passthrough`
// when the CLI has a raw `bb api`, `projected` when it does not. See
// `docs/FORGES.md` and the design spec for why the difference is this large.
import type { BranchCiStatus } from "../../orchestrator/branchCi";
// `import type`, matching `../../forge/types`'s own discipline: it is an
// interfaces-only module whose safety rests on every import of and from it being
// erased at build time (see its header).
import type { ForgeGap } from "../../forge/types";
import { execRunner } from "../provider";
import type { FetchResult, Locate, PrProvider, Runner } from "../provider";
import { resolveBin } from "../which";
import { PrFacts } from "../../../types";
import { BbRepo, parseBitbucketRemote, pickBbPr } from "./pr";
import { BbProjectedPr, projectedBranchStatus, projectedCi, toProjectedFacts } from "./projected";
import {
  BbRestPr, countBbUnresolved, mapBbMergeable, mapBbStatuses, restBranchStatus, toRestFacts,
} from "./rest";

export const BB_TIMEOUT_MS = 10_000;

/** The binary. `bb` is a SUBCOMMAND ALIAS inside `atlassian-cli`, not a second
 * executable — `atlassian-cli bb pr list …` and `atlassian-cli bitbucket pr list …`
 * are the same command. Looking for a `bb` on PATH would find nothing on a
 * correct install, or worse, find `craftamap/bb`, an unrelated tool with an
 * incompatible command surface. */
export const BB_BIN = "atlassian-cli";

const locateBb: Locate = () => resolveBin(BB_BIN);

/** How many open PRs projected mode lists before matching client-side. `bb pr
 * list` has no source-branch filter and no title search, so the selectors run
 * over whatever this returns — a repo with more than this many open PRs can miss
 * one that passthrough mode would have found by direct query. Documented in
 * docs/FORGES.md rather than quietly raised: a bigger number is a slower call for
 * every repo, to fix a case a newer CLI removes entirely. */
const PROJECTED_LIST_LIMIT = 25;

/** Is `atlassian-cli` installed and signed in TO BITBUCKET? `auth test --bitbucket`
 * rather than `auth status`, which renders a table for every configured service
 * and exits zero with Bitbucket unconfigured, or `whoami`, which is Jira-shaped. */
export async function probeBb(run: Runner = execRunner, locate: Locate = locateBb): Promise<ForgeGap | null> {
  const bb = locate() ?? BB_BIN;
  try {
    await run(bb, ["auth", "test", "--bitbucket"], { cwd: process.cwd(), timeoutMs: BB_TIMEOUT_MS });
    return null;
  } catch (e) {
    // ENOENT is the only answer that means "not installed" — anything else came
    // from a CLI that ran, so blaming the install would send the user hunting for
    // a binary they already have.
    const kind = (e as { code?: unknown }).code === "ENOENT" ? "missing" : "signed-out";
    return { kind, detail: `${bb} auth test --bitbucket: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Does this build have a raw `bb api` passthrough?
 *
 * `--help` is handled by clap at parse time, before workspace resolution and
 * before any HTTP, so this costs no network call, needs no repo, and answers
 * correctly while signed out. A build without the subcommand exits non-zero with
 * "unrecognized subcommand", which is the whole signal. */
export async function probeBbApi(run: Runner = execRunner, locate: Locate = locateBb): Promise<boolean> {
  try {
    await run(locate() ?? BB_BIN, ["bb", "api", "--help"], { cwd: process.cwd(), timeoutMs: BB_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

function exec(run: Runner, locate: Locate, repoPath: string, args: string[]): Promise<string> {
  return run(locate() ?? BB_BIN, args, { cwd: repoPath, timeoutMs: BB_TIMEOUT_MS });
}

/** The repo's Bitbucket coordinates, from its git remote.
 *
 * Neither `gh` nor `glab` needs this — both infer the repo themselves — and
 * `atlassian-cli` infers `--workspace`, but `bb pr list <repo>` takes the slug as
 * a REQUIRED POSITIONAL and ignores git context entirely. Passthrough mode needs
 * both coordinates to build a REST path. So the forge resolves them itself and
 * passes both explicitly, which also means no call depends on the CLI's own
 * detection heuristics agreeing with ours. */
async function repoOf(run: Runner, locate: Locate, repoPath: string): Promise<BbRepo | null> {
  try {
    const url = await run("git", ["config", "--get", "remote.origin.url"], {
      cwd: repoPath,
      timeoutMs: BB_TIMEOUT_MS,
    });
    return parseBitbucketRemote(url);
  } catch {
    return null;
  }
}

const listArgs = (repo: BbRepo): string[] => [
  "--workspace", repo.workspace, "bb", "pr", "list", repo.slug,
  "--state", "OPEN", "--limit", String(PROJECTED_LIST_LIMIT), "--format", "json",
];

const pipelineArgs = (repo: BbRepo, branch: string): string[] => [
  "--workspace", repo.workspace, "--repo", repo.slug, "bb", "pipeline", "list",
  "--branch", branch, "--recent", "1", "--format", "json",
];

const apiArgs = (path: string): string[] => ["bb", "api", path, "--format", "json"];

const prSearchPath = (repo: BbRepo, q: string): string =>
  `/2.0/repositories/${repo.workspace}/${repo.slug}/pullrequests?q=${encodeURIComponent(q)}&state=OPEN&pagelen=10`;

const prSubPath = (repo: BbRepo, id: number, leaf: string): string =>
  `/2.0/repositories/${repo.workspace}/${repo.slug}/pullrequests/${id}${leaf}`;

const pipelinesPath = (repo: BbRepo, branch: string): string =>
  `/2.0/repositories/${repo.workspace}/${repo.slug}/pipelines?target.ref_name=${encodeURIComponent(branch)}` +
  `&sort=-created_on&pagelen=1`;

async function jsonList(p: Promise<string>): Promise<unknown[]> {
  const parsed = JSON.parse(await p) as unknown;
  // Bitbucket and the CLI both answer an error with an OBJECT
  // (`{"message":"404 Not Found"}`), which must fail the fetch rather than read
  // as an empty list — "no pull request" and "we could not ask" are different.
  if (!Array.isArray(parsed)) throw new Error(`${BB_BIN}: expected an array`);
  return parsed;
}

/** Branch CI for the orchestrator's gate, in whichever mode is live.
 *
 * A free function rather than a `BbProvider` method: `forge/bitbucket.ts` calls
 * it directly, exactly as the other two forges spawn their branch-CI read
 * themselves. `"unknown"` for every unreadable fact — a failed call, a timeout, a
 * branch with no pipeline — and `"unknown"` is NOT green. */
export async function bbBranchCi(
  run: Runner,
  locate: Locate,
  apiMode: () => Promise<boolean>,
  repoPath: string,
  branch: string,
): Promise<BranchCiStatus> {
  try {
    const repo = await repoOf(run, locate, repoPath);
    if (!repo) return "unknown";
    if (await apiMode()) {
      const out = await exec(run, locate, repoPath, apiArgs(pipelinesPath(repo, branch)));
      return restBranchStatus(JSON.parse(out) as unknown);
    }
    const out = await exec(run, locate, repoPath, pipelineArgs(repo, branch));
    return projectedBranchStatus(JSON.parse(out) as unknown);
  } catch {
    return "unknown";
  }
}

export class BbProvider implements PrProvider {
  constructor(
    private readonly run: Runner = execRunner,
    private readonly locate: Locate = locateBb,
    private readonly apiMode: () => Promise<boolean> = () => probeBbApi(),
  ) {}

  async fetch(repoPath: string, branch: string | null, key: string): Promise<FetchResult> {
    try {
      const repo = await repoOf(this.run, this.locate, repoPath);
      // A remote we cannot read as Bitbucket is a FAILED fetch, not "no PR": the
      // alternative is synthesizing bitbucket.org urls for someone else's forge.
      if (!repo) return { ok: false };
      return (await this.apiMode())
        ? await this.fetchRest(repoPath, repo, branch, key)
        : await this.fetchProjected(repoPath, repo, branch, key);
    } catch {
      // Nothing may throw out of `fetch` — an uncaught throw leaves the caller's
      // cache entry unstamped, which re-arms this repo's fetch on every tick,
      // forever. The mappers are inside this try for the same reason.
      return { ok: false };
    }
  }

  /** Projected mode: one list call, both selectors applied client-side, then one
   * pipeline call for the card's CI. */
  private async fetchProjected(
    repoPath: string, repo: BbRepo, branch: string | null, key: string,
  ): Promise<FetchResult> {
    const rows = (await jsonList(exec(this.run, this.locate, repoPath, listArgs(repo)))) as BbProjectedPr[];
    const byBranch = branch
      ? rows.filter((r) => typeof r.source === "string" && r.source === branch)
      : [];
    // The live branch is exact. The key search only covers a PR opened from a
    // branch Agent Flow did not name.
    const byKey = rows.filter((r) => typeof r.title === "string" && r.title.includes(key));
    const found = pickBbPr(byBranch.length > 0 ? byBranch : byKey);
    if (!found) return { ok: true, facts: null };

    const source = typeof found.source === "string" ? found.source : branch;
    const ci = source ? projectedCi(await this.pipelineRows(repoPath, repo, source)) : { passing: 0, pending: 0, failing: [] };
    return { ok: true, facts: toProjectedFacts(found, repo, ci) };
  }

  /** The newest pipeline for a branch, or null when we cannot read one. A failure
   * costs the CI tally and nothing else — the PR we already found still renders. */
  private async pipelineRows(repoPath: string, repo: BbRepo, branch: string): Promise<unknown> {
    try {
      return JSON.parse(await exec(this.run, this.locate, repoPath, pipelineArgs(repo, branch))) as unknown;
    } catch {
      return null;
    }
  }

  /** Passthrough mode: server-side filtering, then three sub-calls that each
   * degrade on their own. */
  private async fetchRest(
    repoPath: string, repo: BbRepo, branch: string | null, key: string,
  ): Promise<FetchResult> {
    let found: BbRestPr | undefined;
    if (branch) found = pickBbPr(await this.search(repoPath, prSearchPath(repo, `source.branch.name="${branch}"`)));
    if (!found) found = pickBbPr(await this.search(repoPath, prSearchPath(repo, `title~"${key}"`)));
    if (!found) return { ok: true, facts: null };
    const id = found.id as number; // `pickBbPr` only ever returns a row whose id is a number.

    return {
      ok: true,
      facts: toRestFacts(found, {
        ci: mapBbStatuses(await this.sub(repoPath, repo, id, "/statuses")),
        mergeable: mapBbMergeable(await this.sub(repoPath, repo, id, "/conflicts")),
        unresolved: countBbUnresolved(await this.sub(repoPath, repo, id, "/comments?pagelen=100")),
      }),
    };
  }

  private async search(repoPath: string, path: string): Promise<BbRestPr[]> {
    const parsed = JSON.parse(await exec(this.run, this.locate, repoPath, apiArgs(path))) as unknown;
    const values = (parsed as { values?: unknown } | null)?.values;
    if (!Array.isArray(values)) throw new Error(`${BB_BIN} api: expected a paginated body`);
    return values as BbRestPr[];
  }

  /** One sub-resource, or null when we cannot read it. Each mapper reads null as
   * its own absence — `"unknown"`, a zero tally, `null` — never as a failed fetch. */
  private async sub(repoPath: string, repo: BbRepo, id: number, leaf: string): Promise<unknown> {
    try {
      return JSON.parse(await exec(this.run, this.locate, repoPath, apiArgs(prSubPath(repo, id, leaf)))) as unknown;
    } catch {
      return null;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/engine/pr/bb/provider.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine/pr/bb/provider.ts test/unit/engine/pr/bb/provider.test.ts
git commit -m "feat(bitbucket): PR facts in both projected and passthrough modes"
```

---

## Task 6: `review/bb/provider.ts` — the write path

Unreachable while `reviewSearch` is false (the strip populates the cache both other entry points key off), so it is tested directly rather than through `deckView`.

**Files:**
- Create: `src/engine/review/bb/provider.ts`
- Test: `test/unit/engine/review/bb/provider.test.ts`

**Interfaces:**
- Consumes: `ReviewProvider` from `src/engine/review/provider.ts`; `Runner`, `Locate` from `src/engine/pr/provider.ts`; `BB_BIN`, `BB_TIMEOUT_MS` from `src/engine/pr/bb/provider.ts`; `ReviewDetail`, `ReviewRequest`, `ReviewVerb` from `src/types.ts`.
- Produces: `BbReviewProvider` (constructor `(run, locate, apiMode)`).

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine/review/bb/provider.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { BbReviewProvider } from "../../../../../src/engine/review/bb/provider";
import type { Runner } from "../../../../../src/engine/pr/provider";

const BB = "/opt/homebrew/bin/atlassian-cli";
const REPO = "acme/api-service";
const BODY = "This looks good, but see line 12.";

const ok: Runner = async () => "";
const provider = (run: Runner, apiMode: boolean) => new BbReviewProvider(run, () => BB, async () => apiMode);

describe("BbReviewProvider.search", () => {
  it("is null, because Bitbucket Cloud has no cross-repo reviewer query", async () => {
    // Never called today: `caps.reviewSearch` is false, so `reviewsEnabled()`
    // hides the strip and nothing populates the cache this provider serves.
    await expect(provider(ok, true).search()).resolves.toBeNull();
  });
});

describe("BbReviewProvider.submit — projected mode", () => {
  it("approves and comments through the CLI's own subcommands", async () => {
    const calls: string[][] = [];
    const run: Runner = async (_f, args) => {
      calls.push(args);
      return "";
    };
    await expect(provider(run, false).submit(REPO, 42, "approve", "")).resolves.toEqual({ ok: true });
    expect(calls[0]).toEqual(["--workspace", "acme", "bb", "pr", "approve", "api-service", "42", "--format", "json"]);

    await expect(provider(run, false).submit(REPO, 42, "comment", BODY)).resolves.toEqual({ ok: true });
    expect(calls[1]).toEqual([
      "--workspace", "acme", "bb", "pr", "comment", "api-service", "42",
      "--text", BODY, "--format", "json",
    ]);
  });

  it("refuses request-changes without spawning anything", async () => {
    const run = vi.fn<Runner>(async () => "");
    const res = await provider(run, false).submit(REPO, 42, "request-changes", BODY);
    expect(res).toEqual({ ok: false, message: expect.stringContaining("request changes") });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("BbReviewProvider.submit — passthrough mode", () => {
  it("posts request-changes to the endpoint the API does have", async () => {
    const calls: string[][] = [];
    const run: Runner = async (_f, args) => {
      calls.push(args);
      return "";
    };
    await expect(provider(run, true).submit(REPO, 42, "request-changes", BODY)).resolves.toEqual({ ok: true });
    // The comment carrying the reviewer's reasoning goes first: if the second
    // call fails, a posted note with no state change is a better outcome than a
    // blocking state with no explanation.
    expect(calls[0][2]).toContain("/2.0/repositories/acme/api-service/pullrequests/42/comments");
    expect(calls[1][2]).toContain("/2.0/repositories/acme/api-service/pullrequests/42/request-changes");
    expect(calls[1]).toContain("-X");
    expect(calls[1]).toContain("POST");
  });
});

describe("BbReviewProvider.submit — refusals and failures", () => {
  it("fails closed on a verb outside the union, prototype keys included", async () => {
    const run = vi.fn<Runner>(async () => "");
    // `!VERB[verb]` would sail through on "constructor". The one command that
    // writes to someone else's pull request does not get to guess.
    const res = await provider(run, true).submit(REPO, 42, "constructor" as never, BODY);
    expect(res).toMatchObject({ ok: false });
    expect(run).not.toHaveBeenCalled();
  });

  it("requires a message for anything but an approval", async () => {
    const run = vi.fn<Runner>(async () => "");
    await expect(provider(run, true).submit(REPO, 42, "comment", "   ")).resolves.toMatchObject({ ok: false });
    expect(run).not.toHaveBeenCalled();
  });

  it("never returns the review body in an error message", async () => {
    // execFile's `.message` is `Command failed: <file> <argv joined>`, which for
    // a comment embeds the entire body verbatim. This is the last line of
    // defense against returning it to the webview.
    const leaky = Object.assign(new Error(`Command failed: ${BB} bb pr comment api-service 42 --text ${BODY}`), {});
    const run: Runner = async () => {
      throw leaky;
    };
    const res = await provider(run, false).submit(REPO, 42, "comment", BODY);
    expect(res.ok).toBe(false);
    expect((res as { message: string }).message).not.toContain(BODY);
  });

  it("prefers the CLI's own stderr over the reconstructed argv", async () => {
    const run: Runner = async () => {
      throw Object.assign(new Error(`Command failed: ${BB} bb pr comment ... ${BODY}`), {
        stderr: "403 Forbidden: you are not a reviewer on this pull request",
      });
    };
    const res = await provider(run, false).submit(REPO, 42, "comment", BODY);
    expect((res as { message: string }).message).toBe("403 Forbidden: you are not a reviewer on this pull request");
  });

  it("keeps the timeout branch's distinct wording", async () => {
    // A killed process may already have reached Bitbucket, so "Bitbucket
    // refused" would be a flat lie about a write that could have succeeded.
    const run: Runner = async () => {
      throw Object.assign(new Error("killed"), { killed: true });
    };
    const res = await provider(run, false).submit(REPO, 42, "approve", "");
    expect((res as { message: string }).message).toMatch(/may already have gone through/);
  });

  it("fails rather than guessing when the repo is not workspace/slug", async () => {
    const run = vi.fn<Runner>(async () => "");
    await expect(provider(run, false).submit("api-service", 42, "approve", "")).resolves.toMatchObject({ ok: false });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("BbReviewProvider.detail", () => {
  it("fills size and CI in passthrough mode", async () => {
    const run: Runner = async (_f, args) => {
      if (args.some((a) => a.includes("/diffstat"))) {
        return JSON.stringify({ values: [{ lines_added: 10, lines_removed: 3 }, { lines_added: 1, lines_removed: 0 }] });
      }
      return JSON.stringify({ values: [{ state: "FAILED", name: "Tests", url: "https://ci/3" }] });
    };
    await expect(provider(run, true).detail(REPO, 42)).resolves.toMatchObject({
      failing: [{ name: "Tests", url: "https://ci/3" }],
    });
  });

  it("is null in projected mode, where `bb pr diff` is a stub", async () => {
    await expect(provider(ok, false).detail(REPO, 42)).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/engine/review/bb/provider.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/engine/review/bb/provider.ts`:

```ts
// The Bitbucket write path. Reachable only through the review strip, which
// `caps.reviewSearch: false` currently hides — so nothing in this file runs in a
// Bitbucket install today.
//
// Implemented rather than stubbed anyway: the `Forge` interface requires a
// `ReviewProvider`, and a stub that threw would become a lie the day the strip is
// enabled. Its tests call it directly for the same reason.
import * as os from "os";
import { ReviewDetail, ReviewRequest, ReviewVerb } from "../../../types";
import { BB_BIN, BB_TIMEOUT_MS } from "../../pr/bb/provider";
import { probeBbApi } from "../../pr/bb/provider";
import { execRunner } from "../../pr/provider";
import type { Locate, Runner } from "../../pr/provider";
import { mapBbStatuses } from "../../pr/bb/rest";
import { resolveBin } from "../../pr/which";
import type { ReviewProvider } from "../provider";

const locateBb: Locate = () => resolveBin(BB_BIN);

/** Node's execFile error `.message` is always `Command failed: <file> <full argv
 * joined>` — for a comment, that embeds the entire review text verbatim. Used
 * only when a rejection carries no `stderr` of its own, this keeps whatever
 * follows the first newline and falls back to a fixed, argv-free string when
 * there is nothing there — never the reconstructed command. */
function stripCommandLine(message: string): string {
  const nl = message.indexOf("\n");
  const rest = nl === -1 ? "" : message.slice(nl + 1).trim();
  return rest || `${BB_BIN} failed without further detail — open the pull request to check.`;
}

/** `"workspace/slug"` split, or null. `ReviewRequest.repo` is `nameWithOwner`
 * across every forge; for Bitbucket that is exactly workspace and slug. */
function splitRepo(repo: string): { workspace: string; slug: string } | null {
  const parts = repo.split("/").filter(Boolean);
  return parts.length === 2 ? { workspace: parts[0], slug: parts[1] } : null;
}

const VERBS: Record<ReviewVerb, true> = { approve: true, comment: true, "request-changes": true };

export class BbReviewProvider implements ReviewProvider {
  constructor(
    private readonly run: Runner = execRunner,
    private readonly locate: Locate = locateBb,
    private readonly apiMode: () => Promise<boolean> = () => probeBbApi(),
  ) {}

  /** Every call here is repo-independent: a PR requesting your review may live in
   * a repository you have never cloned. The home directory is only somewhere that
   * exists for the CLI to run in. */
  private exec(args: string[]): Promise<string> {
    return this.run(this.locate() ?? BB_BIN, args, { cwd: os.homedir(), timeoutMs: BB_TIMEOUT_MS });
  }

  private api(path: string, method?: string): Promise<string> {
    const args = ["bb", "api", path];
    if (method) args.push("-X", method);
    args.push("--format", "json");
    return this.exec(args);
  }

  /** Null, permanently.
   *
   * Bitbucket Cloud has no cross-repo "pull requests where I am a reviewer"
   * query: `GET /2.0/workspaces/{ws}/pullrequests/{user}` is AUTHORED-BY. This is
   * an API limit, so passthrough mode does not fix it — which is why the honest
   * answer is `caps.reviewSearch: false` hiding the strip, rather than this
   * method's null, which by convention means "the attempt failed". Nothing calls
   * this while that flag is false. */
  async search(): Promise<{ issueCount: number; requests: ReviewRequest[] } | null> {
    return null;
  }

  /** The two things a queue row cannot show unexpanded. Projected mode has
   * neither: `bb pr diff` is a stub that prints a web url, and there is no
   * failing-checks projection to read. */
  async detail(repo: string, number: number): Promise<ReviewDetail | null> {
    const r = splitRepo(repo);
    if (!r || !(await this.apiMode())) return null;
    const base = `/2.0/repositories/${r.workspace}/${r.slug}/pullrequests/${number}`;
    let failing: ReviewDetail["failing"];
    try {
      failing = mapBbStatuses(JSON.parse(await this.api(`${base}/statuses`)) as unknown).failing;
    } catch {
      return null;
    }
    // Bitbucket has no thread-resolution count on a route this cheap; the size
    // chip is what this call is really for.
    return { failing, unresolved: null };
  }

  /** The only command here that writes to Bitbucket. The caller confirms first;
   * this only refuses what Bitbucket would refuse anyway.
   *
   * `verb` is not to be trusted just because the type says `ReviewVerb`:
   * `Object.hasOwn` (not `!VERBS[verb]`, which a prototype key like
   * `"constructor"` would sail through as truthy) fails closed before a single
   * argv is built. `body` likewise arrives from a webview message, untyped at
   * runtime — `String(body ?? "")` keeps a stray null from throwing instead of
   * returning the discriminated result this promises never to skip. */
  async submit(
    repo: string, number: number, verb: ReviewVerb, body: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    if (!Object.hasOwn(VERBS, verb)) return { ok: false, message: `Unknown review verb: ${String(verb)}` };
    const r = splitRepo(repo);
    if (!r) return { ok: false, message: `Not a Bitbucket workspace/repository: ${repo}` };
    const text = String(body ?? "").trim();
    if (verb !== "approve" && !text) {
      return { ok: false, message: "Bitbucket requires a message for this kind of review." };
    }
    const passthrough = await this.apiMode();
    if (verb === "request-changes" && !passthrough) {
      return {
        ok: false,
        message:
          "This build of atlassian-cli has no way to request changes — upgrade to one with `bb api`, " +
          "or use the pull request in your browser.",
      };
    }
    try {
      await this.write(r, number, verb, text, passthrough);
      return { ok: true };
    } catch (e) {
      // A killed-by-timeout rejection has the same shape as any other execFile
      // failure but means something different: the CLI may well have reached
      // Bitbucket before the clock ran out, so "Bitbucket refused" would be a
      // flat lie about a write that could have succeeded server-side.
      const err = e as { killed?: boolean; code?: unknown; stderr?: string };
      if (err.killed || err.code === "ETIMEDOUT") {
        return {
          ok: false,
          message: `Timed out after ${BB_TIMEOUT_MS / 1000}s — the review may already have gone through. Open the pull request to check.`,
        };
      }
      // `stderr` is the CLI's own complaint, with none of the reconstructed argv
      // `.message` carries. Prefer it; a killed process may carry none, so the
      // fallback strips `.message`'s "Command failed: …" line rather than ever
      // returning it whole. This catch must never return the body.
      const msg = err.stderr?.trim() || (e instanceof Error ? stripCommandLine(e.message) : String(e));
      return { ok: false, message: msg };
    }
  }

  private async write(
    r: { workspace: string; slug: string }, number: number, verb: ReviewVerb, text: string, passthrough: boolean,
  ): Promise<void> {
    if (!passthrough) {
      const head = ["--workspace", r.workspace, "bb", "pr"];
      const tail = ["--format", "json"];
      if (verb === "approve") {
        await this.exec([...head, "approve", r.slug, String(number), ...tail]);
        return;
      }
      await this.exec([...head, "comment", r.slug, String(number), "--text", text, ...tail]);
      return;
    }
    const base = `/2.0/repositories/${r.workspace}/${r.slug}/pullrequests/${number}`;
    // The comment goes FIRST for anything carrying reasoning: if the state change
    // then fails, a posted note with no state change is a better outcome than a
    // blocking state with no explanation attached to it.
    if (text) await this.api(`${base}/comments`, "POST");
    if (verb === "approve") await this.api(`${base}/approve`, "POST");
    else if (verb === "request-changes") await this.api(`${base}/request-changes`, "POST");
  }
}
```

> **Note for the implementer:** the `comments` POST above needs a body. `bb api`
> takes one via `-d '<json>'` (see `ApiArgs` in `crates/cli/src/commands/api.rs`).
> Extend `api()` with an optional `data?: string` parameter and pass
> `JSON.stringify({ content: { raw: text } })`. Add the matching argv assertion to
> the passthrough test in Step 1 before implementing.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/engine/review/bb/provider.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine/review/bb/provider.ts test/unit/engine/review/bb/provider.test.ts
git commit -m "feat(bitbucket): the review write path, in both modes"
```

---

## Task 7: `forge/bitbucket.ts` and the registry

**Files:**
- Create: `src/engine/forge/bitbucket.ts`
- Modify: `src/engine/forge/registry.ts`
- Test: `test/unit/engine/forge/registry.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1, 5, 6.
- Produces: `makeBitbucketForge(run?): Forge`; `"bitbucket"` in `FORGES` and so in `FORGE_IDS`.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/engine/forge/registry.test.ts`:

```ts
it("registers bitbucket, and names the binary rather than its alias", () => {
  const f = resolveForge("bitbucket", () => {});
  expect(f.id).toBe("bitbucket");
  expect(f.label).toBe("Bitbucket");
  // `bb` is a subcommand alias inside atlassian-cli, not a binary on PATH —
  // looking for one would find nothing, or find craftamap/bb, an unrelated tool.
  expect(f.cli.name).toBe("atlassian-cli");
});

it("reports bitbucket's static caps conservatively, and resolves the real ones", async () => {
  const f = resolveForge("bitbucket", () => {});
  // Static caps are what a forge claims before any probe. Claiming
  // changesRequested here would let armability promise a rule that a projected
  // build can never fire.
  expect(f.caps).toEqual({ changesRequested: false, reviewSearch: false });
  expect(typeof f.resolveCaps).toBe("function");
});

it("resolves changesRequested from the CLI's mode, and probes it once", async () => {
  let probes = 0;
  const run = async (_f: string, args: string[]) => {
    if (args.includes("--help")) {
      probes++;
      return "Usage: atlassian-cli bb api <PATH>";
    }
    return "";
  };
  const f = makeBitbucketForge(run);
  await expect(f.resolveCaps?.()).resolves.toEqual({ changesRequested: true, reviewSearch: false });
  await f.resolveCaps?.();
  // Memoized on the forge, so the PR provider, the review provider and this all
  // share one answer — a per-call probe would spawn on every card, every tick.
  expect(probes).toBe(1);
});

it("never claims a review queue, in either mode", async () => {
  // Not a CLI gap: Bitbucket Cloud has no cross-repo reviewer query at all, so
  // passthrough mode does not fix it either.
  const run = async (_f: string, args: string[]) =>
    args.includes("--help") ? "Usage: atlassian-cli bb api <PATH>" : "";
  const caps = await makeBitbucketForge(run).resolveCaps?.();
  expect(caps?.reviewSearch).toBe(false);
});

it("lists exactly the three registered forges", () => {
  expect(FORGE_IDS).toEqual(["github", "gitlab", "bitbucket"]);
});
```

Add `makeBitbucketForge` to this file's imports.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/engine/forge/registry.test.ts`
Expected: FAIL — `resolveForge("bitbucket", …)` falls back to github.

- [ ] **Step 3: Write the implementation**

Create `src/engine/forge/bitbucket.ts`:

```ts
// Bitbucket Cloud as a Forge, through `atlassian-cli`.
//
// Two modes, because the CLI's command surface differs by version: `passthrough`
// when it has a raw `bb api`, `projected` when it does not. The mode is probed
// ONCE per forge instance and shared by both providers and by `resolveCaps` —
// see `once` below.
import { bbBranchCi, BB_BIN, BbProvider, probeBb, probeBbApi } from "../pr/bb/provider";
import { execRunner } from "../pr/provider";
import type { Runner } from "../pr/provider";
import { resolveBin } from "../pr/which";
import { BbReviewProvider } from "../review/bb/provider";
import type { Forge } from "./types";

/** Memoize a promise-returning thunk. The mode probe spawns a process, and both
 * providers plus `resolveCaps` ask for it — without this, every card on every
 * 6s tick would spawn `bb api --help`. */
function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= fn());
}

export function makeBitbucketForge(run: Runner = execRunner): Forge {
  const locate = () => resolveBin(BB_BIN);
  const apiMode = once(() => probeBbApi(run, locate));
  return {
    id: "bitbucket",
    label: "Bitbucket",
    // `atlassian-cli`, never `bb`: that is a subcommand alias inside this binary,
    // and a `bb` on PATH is craftamap/bb, an unrelated tool with an incompatible
    // command surface.
    cli: { name: BB_BIN, installUrl: "https://atlassiancli.com/install/" },
    // The STATIC caps are what this forge claims before any probe has run, so
    // they state the weaker mode: claiming `changesRequested` here would let
    // `armability.ts` promise a `changes-requested` rule that a projected build
    // can never fire. `resolveCaps` below reports the truth once we know it.
    //
    // `reviewSearch` is false in BOTH modes and is not resolved: Bitbucket Cloud
    // has no cross-repo reviewer query — `GET /2.0/workspaces/{ws}/pullrequests/{user}`
    // is authored-by — so this is an API limit no CLI version fixes.
    caps: { changesRequested: false, reviewSearch: false },
    async resolveCaps() {
      return { changesRequested: await apiMode(), reviewSearch: false };
    },
    probe: () => probeBb(run, locate),
    prs: new BbProvider(run, locate, apiMode),
    reviews: new BbReviewProvider(run, locate, apiMode),
    branchCi: (repoPath, branch) => bbBranchCi(run, locate, apiMode, repoPath, branch),
  };
}
```

In `src/engine/forge/registry.ts`, add the import and the map entry:

```ts
import { makeBitbucketForge } from "./bitbucket";
```

```ts
const FORGES: Record<string, (run?: Runner) => Forge> = {
  github: makeGithubForge,
  gitlab: makeGitlabForge,
  bitbucket: makeBitbucketForge,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/engine/forge/registry.test.ts`
Expected: PASS

- [ ] **Step 5: Verify the webview bundle still builds**

Run: `npm run build`
Expected: PASS. This is the only gate that catches a forge module reaching a browser entry point.

- [ ] **Step 6: Commit**

```bash
git add src/engine/forge/bitbucket.ts src/engine/forge/registry.ts test/unit/engine/forge/registry.test.ts
git commit -m "feat(forge): register bitbucket as forge #3"
```

---

## Task 8: Settings, seeded prompts, and telemetry

**Files:**
- Modify: `package.json` (~150-162)
- Modify: `src/config.ts` (~273-355)
- Modify: `src/engine/review/batch.ts` (~25-50)
- Test: `test/unit/config.test.ts`, `test/unit/engine/review/batch.test.ts`, `test/unit/telemetry/settingsSnapshot.test.ts`

**Interfaces:**
- Consumes: `"bitbucket"` as a registered forge id (Task 7).
- Produces: `BITBUCKET_PR_REVIEW_PROMPT`, `BITBUCKET_REVIEW_REQUEST_PROMPT` from `src/config.ts`.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/config.test.ts`:

```ts
describe("forge-flavoured shipped prompts", () => {
  it("ships Bitbucket wording for a Bitbucket install", () => {
    const prompt = shippedPrReviewPrompt("bitbucket");
    expect(prompt).toContain("Bitbucket");
    expect(prompt).not.toContain("GitHub");
    expect(prompt).not.toContain("GitLab");
    // `atlassian-cli` has NO checkout subcommand — `gh pr checkout` has no
    // equivalent here, and naming one would send the session to a command that
    // does not exist.
    expect(prompt).not.toContain("pr checkout");
    expect(prompt).toContain("git checkout");
  });

  it("gives the first stock review mode the Bitbucket wording", () => {
    const modes = shippedReviewRequestModes("bitbucket");
    expect(modes[0].prompt).toContain("Bitbucket");
    expect(modes.slice(1)).toEqual(DEFAULT_REVIEW_REQUEST_MODES.slice(1));
  });

  it("still falls back to the GitHub baseline for an unknown forge", () => {
    // `resolveForge` falls back to github for an unregistered id, so the shipped
    // prompt must agree — otherwise a typo'd setting yields a card whose prompt
    // and whose forge disagree about which tool the session should reach for.
    expect(shippedPrReviewPrompt("wat")).toBe(DEFAULT_PR_REVIEW_PROMPT);
    expect(shippedReviewRequestModes("wat")).toBe(DEFAULT_REVIEW_REQUEST_MODES);
  });
});
```

Add to `test/unit/telemetry/settingsSnapshot.test.ts`:

```ts
it("reports a stock Bitbucket install as uncustomized", () => {
  // Comparing a Bitbucket install against the GitHub default would report a
  // customized prompt for every stock install — the direction that destroys the
  // metric, since it makes "the user wrote their own words" indistinguishable
  // from "the user picked a forge".
  const snap = snapshotFor({ forge: "bitbucket" });
  expect(snap.pr_review_prompt_customized).toBe(false);
  expect(snap.review_modes_overridden).toBe(0);
});
```

> Use whatever helper this file already uses to build a snapshot; `snapshotFor`
> is a placeholder for its real name. Read the file's existing GitLab case first
> and mirror it exactly.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/config.test.ts test/unit/telemetry/settingsSnapshot.test.ts`
Expected: FAIL — `shippedPrReviewPrompt("bitbucket")` returns the GitHub default.

- [ ] **Step 3: Add the prompts and make the lookups three-way**

In `src/config.ts`, after `GITLAB_REVIEW_REQUEST_PROMPT`:

```ts
/** The Bitbucket wording of DEFAULT_PR_REVIEW_PROMPT, seeded instead when
 * `agentFlow.forge` is "bitbucket" and the user hasn't customized
 * `prReviewPrompt`. Substitution-only, exactly the relationship
 * GITLAB_PR_REVIEW_PROMPT has with its GitHub twin — with one difference that
 * is not cosmetic: there is NO `bb pr checkout`. `atlassian-cli` has no checkout
 * subcommand at all, so this names plain git instead of inventing a command the
 * session would fail to run. */
export const BITBUCKET_PR_REVIEW_PROMPT =
  'Jira {key} ({url}): "{summary}". This task has an open Bitbucket pull request — all our PRs carry the Jira key in their title and branch. ' +
  "Using `atlassian-cli` (or the Bitbucket tools available to you): find the PR for {key}, then " +
  "`git fetch && git checkout <its source branch>` to bring it into the working tree, " +
  "and assess whether it is ready to merge.{brief}{files}";

/** The Bitbucket wording of DEFAULT_REVIEW_REQUEST_PROMPT, substituted into the
 * first stock review mode when `agentFlow.forge` is "bitbucket". Same
 * relationship as BITBUCKET_PR_REVIEW_PROMPT above, and the same checkout
 * caveat. */
export const BITBUCKET_REVIEW_REQUEST_PROMPT =
  'Review Bitbucket pull request {repo}#{number} by {author}: "{summary}" ({url}). ' +
  "Check it out with `git fetch && git checkout <its source branch>`, then read the full diff against its destination branch. " +
  "Report what you find as a review: a short overall assessment, then specific comments, " +
  "each with the file and line it refers to. Do not post anything to Bitbucket; the human submits the review.{files}";
```

Replace the two ternaries with lookups:

```ts
/** The `prReviewPrompt` each forge SHIPS — what a user who never wrote one gets.
 *
 * A lookup rather than a chain of ternaries now that there are three forges. The
 * fallback is the GitHub default and must stay that way: `resolveForge` falls
 * back to github for an unregistered id, so an unknown forge here has to agree
 * with it, or a typo'd setting yields a prompt and a forge that name different
 * tools. */
const SHIPPED_PR_REVIEW_PROMPT: Record<string, string> = {
  gitlab: GITLAB_PR_REVIEW_PROMPT,
  bitbucket: BITBUCKET_PR_REVIEW_PROMPT,
};

export function shippedPrReviewPrompt(forge: string): string {
  return Object.hasOwn(SHIPPED_PR_REVIEW_PROMPT, forge)
    ? SHIPPED_PR_REVIEW_PROMPT[forge]
    : DEFAULT_PR_REVIEW_PROMPT;
}

const SHIPPED_REVIEW_REQUEST_PROMPT: Record<string, string> = {
  gitlab: GITLAB_REVIEW_REQUEST_PROMPT,
  bitbucket: BITBUCKET_REVIEW_REQUEST_PROMPT,
};

/** The review modes each forge SHIPS — `DEFAULT_REVIEW_REQUEST_MODES` with only
 * the first stock mode's prompt forge-flavoured. The github arm returns
 * `DEFAULT_REVIEW_REQUEST_MODES` itself, exactly as the inline ternary this
 * replaced did — `settingsSnapshot`'s `modeCounts` diffs against identity. */
export function shippedReviewRequestModes(forge: string): PromptMode[] {
  if (!Object.hasOwn(SHIPPED_REVIEW_REQUEST_PROMPT, forge)) return DEFAULT_REVIEW_REQUEST_MODES;
  const prompt = SHIPPED_REVIEW_REQUEST_PROMPT[forge];
  return DEFAULT_REVIEW_REQUEST_MODES.map((m, i) => (i === 0 ? { ...m, prompt } : m));
}
```

`Object.hasOwn`, not a bare index: `agentFlow.forge` comes from settings.json and can be any string, including a prototype key like `"constructor"` that a bare index would resolve to a truthy non-string.

In `src/engine/review/batch.ts`, add `READ_ONLY_BITBUCKET_PROMPT` mirroring `READ_ONLY_GITLAB_PROMPT` (Bitbucket's own nouns: "pull request", "destination branch"), and replace the ternary at ~line 50 with the same `Object.hasOwn` lookup shape.

Update the `agentFlow.forge` comment in `AgentFlowConfig` (~361) to name all three.

- [ ] **Step 4: Add the manifest entry**

In `package.json`, extend `agentFlow.forge`:

```json
        "agentFlow.forge": {
          "type": "string",
          "enum": [
            "github",
            "gitlab",
            "bitbucket"
          ],
          "enumDescriptions": [
            "GitHub, through the `gh` CLI.",
            "GitLab, through the `glab` CLI.",
            "Bitbucket Cloud, through the `atlassian-cli` CLI. Full support needs a build with `bb api`; without it, cards show branch CI only. Bitbucket has no review-requests queue in either case. Run Doctor to see which mode you are in."
          ],
          "default": "github",
          "description": "Which forge Agent Flow Deck reads pull/merge requests, CI, and review requests from. Each forge needs its own CLI installed and signed in — run Doctor to check. Requires a window reload."
        },
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/unit/config.test.ts test/unit/telemetry/settingsSnapshot.test.ts test/unit/engine/review/batch.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add package.json src/config.ts src/engine/review/batch.ts test/unit/config.test.ts test/unit/telemetry/settingsSnapshot.test.ts test/unit/engine/review/batch.test.ts
git commit -m "feat(bitbucket): the forge setting, seeded prompts and telemetry baseline"
```

---

## Task 9: Doctor reports the mode

Doctor is where a user goes when the board looks wrong. "Signed in" is not the answer they need on Bitbucket — "which mode" is.

**Files:**
- Modify: `src/engine/doctor.ts` (`DoctorInputs.forge`, `forgeChecks` ~250)
- Modify: `src/deckView.ts` (wherever `DoctorInputs` is assembled)
- Test: `test/unit/engine/doctor.test.ts`

**Interfaces:**
- Consumes: `Forge.resolveCaps` (Task 1), `makeBitbucketForge` (Task 7).
- Produces: `DoctorInputs.forge.mode?: string | null`.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/engine/doctor.test.ts`:

```ts
it("names the forge's mode when it has one, and stays silent when it does not", () => {
  const withMode = doctor(inputs({
    forge: { label: "Bitbucket", cli: "atlassian-cli", gap: null, mode: "projected (limited)" },
  }));
  const row = withMode.checks.find((c) => c.group === "Bitbucket");
  expect(row?.detail).toContain("projected (limited)");

  // gh and glab have one mode, so a mode row would be noise.
  const noMode = doctor(inputs({ forge: { label: "GitHub", cli: "gh", gap: null, mode: null } }));
  expect(noMode.checks.find((c) => c.group === "GitHub")?.detail ?? "").not.toContain("mode");
});
```

> `doctor` and `inputs` are placeholders for this file's existing helpers — read
> its current forge cases and mirror them.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/engine/doctor.test.ts -t "mode"`
Expected: FAIL — `mode` is not a field on `DoctorInputs.forge`.

- [ ] **Step 3: Implement**

In `src/engine/doctor.ts`, add to the `forge` member of `DoctorInputs`:

```ts
    /** A human-readable mode, for a forge whose capability depends on which
     *  build of its CLI is installed — `"passthrough (full)"` or
     *  `"projected (limited — upgrade atlassian-cli for full support)"`. Null for
     *  the forges that have exactly one mode, where a mode row would be noise.
     *
     *  Structural rather than importing anything from `forge/`, matching how
     *  `gap` is already declared here. */
    mode: string | null;
```

In `forgeChecks`, append the mode to the passing row's detail when it is non-null.

In `src/deckView.ts`, where `DoctorInputs` is assembled, derive it from the resolved caps:

```ts
      // Only a forge that resolves caps at probe time has a mode worth naming.
      mode: this.forge.resolveCaps
        ? this.caps().changesRequested
          ? "passthrough (full)"
          : "projected (limited — upgrade atlassian-cli for full support)"
        : null,
```

Update every other construction of `DoctorInputs` (tests included) to pass `mode: null`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/unit/engine/doctor.test.ts test/unit/deckView.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine/doctor.ts src/deckView.ts test/unit/engine/doctor.test.ts
git commit -m "feat(doctor): report which mode the Bitbucket CLI is in"
```

---

## Task 10: Docs and changelog

`test/unit/docs.test.ts` fails if a registered forge is not backticked in `docs/FORGES.md`, so this task is a gate, not a courtesy.

**Files:**
- Modify: `docs/FORGES.md`
- Modify: `docs/SETTINGS.md`
- Modify: `CHANGELOG.md`
- Test: `test/unit/docs.test.ts` (existing, unmodified)

- [ ] **Step 1: Confirm the docs gate currently fails**

Run: `npx vitest run test/unit/docs.test.ts`
Expected: FAIL — `bitbucket` is registered but not documented.

- [ ] **Step 2: Update `docs/FORGES.md`**

- §1: "Three are registered: `github` … `gitlab` … and `bitbucket`."
- Retitle §3 to "What GitLab and Bitbucket cannot answer" and add the four-column
  table from the spec's §8 (GitHub / GitLab / BB passthrough / BB projected).
- Add a new subsection, **"Bitbucket has two modes"**, carrying the spec's §3:
  the CLI projects rather than passes through; `bb api --help` is the detection;
  what each mode answers; and that `reviewSearch` is false in both because
  Bitbucket Cloud has no cross-repo reviewer query.
- Add to §4's conventions: **a forge whose capability depends on its CLI version
  reports the weaker mode in its static `caps` and the truth from `resolveCaps()`.**
- Update §2 to name `src/engine/pr/bb/provider.ts` among the modules that reach
  `child_process`, and to note that `pr.ts`, `projected.ts` and `rest.ts` are pure.

- [ ] **Step 3: Update `docs/SETTINGS.md`**

Add `bitbucket` to the `agentFlow.forge` row with the manifest's wording.

- [ ] **Step 4: Add the changelog entry**

Under `## [Unreleased]`:

```markdown
### Added

- **Bitbucket Cloud as a third forge.** Set `agentFlow.forge` to `bitbucket` to
  read pull requests and CI through the `atlassian-cli` CLI. Support depends on
  which build you have: one with a `bb api` passthrough gives cards their review
  state, draft flag, mergeability and per-check CI, while one without shows
  branch CI only. Doctor reports which mode you are in. Bitbucket Cloud offers no
  cross-repo "waiting on my review" query, so the review-requests strip is hidden
  on this forge in both modes. GitHub remains the default and is unchanged.
```

- [ ] **Step 5: Run the docs gate and the full suite**

Run: `npx vitest run test/unit/docs.test.ts`, then `npm run typecheck && npm run build`, then `npm test` with `timeout: 600000`.
Expected: all pass.

- [ ] **Step 6: Check coverage**

Run: `npm run test:cov` with `timeout: 600000`.
Expected: thresholds met (90% lines/statements, 85% branches/functions).

- [ ] **Step 7: Commit**

```bash
git add docs/FORGES.md docs/SETTINGS.md CHANGELOG.md
git commit -m "docs(bitbucket): document forge #3 and its two modes"
```

---

## Task 11: The manual verification pass

**This is a release gate, not a nice-to-have.** Every wire shape in this plan was
derived from reading `atlassian-cli`'s Rust source and Bitbucket's OpenAPI spec.
Nobody on this project has the CLI installed and it is not on the CI image, so
**nothing here has met a real response.** `copilot-provider-shipped-unverified` is
the precedent for shipping a provider that never ran.

- [ ] **Step 1: Install and authenticate**

```bash
brew tap omar16100/atlassian-cli && brew install atlassian-cli
atlassian-cli auth login --profile bb --bitbucket --email <you> --token <api-token>
atlassian-cli auth test --bitbucket
atlassian-cli bb api --help   # records which mode this build is in
```

- [ ] **Step 2: Capture real responses**

From inside a Bitbucket Cloud checkout with an open PR:

```bash
atlassian-cli bb pr list <slug> --state OPEN --limit 25 --format json
atlassian-cli bb pipeline list --branch <source-branch> --recent 1 --format json
# passthrough builds only:
atlassian-cli bb api '/2.0/repositories/<ws>/<slug>/pullrequests?q=source.branch.name="<branch>"&state=OPEN&pagelen=10' --format json
```

**Diff each response against the fixtures.** Any field that differs is a bug in
this plan, not in the CLI — fix the mapper and the fixture together, and note the
correction in `docs/FORGES.md`.

- [ ] **Step 3: Verify in a dev host**

Press **F5** ("Run Agent Flow Deck") — only VS Code's own `code` CLI works if
launching from a terminal; the Cursor CLI silently drops
`--extensionDevelopmentPath`. Set `agentFlow.forge` to `bitbucket`, reload, and
confirm: Doctor shows the Bitbucket group with the right mode; a card with an
open PR renders its number, title and CI; a card without one shows no PR; the
review strip is absent; the orchestrator's branch-CI gate reads the right verdict.

- [ ] **Step 4: Record the result**

Add a line to `docs/FORGES.md` stating which CLI version was verified, in which
mode, and on what date — so the next contributor knows what was actually
exercised rather than inferred.

- [ ] **Step 5: Commit**

```bash
git add docs/FORGES.md
git commit -m "docs(bitbucket): record the manual verification pass"
```

---

## Self-review notes

Checked against the spec:

- **Spec §4's `reviewQueue` is implemented as `reviewSearch`** — renamed to avoid
  colliding with `deckView`'s existing `this.reviewQueue` field. Recorded in
  Global Constraints.
- **Spec §7.4's `/2.0/user` call is dropped.** `PrFacts.review` is a fact about
  the pull request, not the viewer, so `mapBbReview` needs no identity. One fewer
  call and one fewer failure mode. Recorded in Global Constraints.
- **Spec §6.4's "strip hides" is implemented through the existing
  `reviewsEnabled()` gate** rather than a new early return in `enqueueReviews` —
  that method already gates both the enqueue and the `enabled: false` post, so
  one added conjunct covers both paths the spec describes separately.
- Spec §9.1's "every provider test runs twice, once per mode" is satisfied by
  separate describe blocks per mode rather than a shared table — clearer failure
  output, same coverage.
- Not implemented, and correctly so: the spec's §7.7 per-repo reviewer fan-out
  (explicitly out of scope) and §11's mitigations, which land in Tasks 8 and 9.
