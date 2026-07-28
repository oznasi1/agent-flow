# Review Requests on the Deck — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a collapsible strip above the Deck's four columns listing every open GitHub PR that requests your review, sortable by age or size, able to launch a review agent into a worktree and (opt-in) submit a review back to GitHub.

**Architecture:** One `gh api graphql` search feeds a disk-cached list of `ReviewRequest` records. Pure mappers and comparators live in `src/engine/review/`, spawning is confined to an injected `Runner` (the same pattern `src/engine/pr/` already uses), and `DeckPanel` decorates the cached list with locally-observed facts (checkout path, in-flight review run, agent draft file) before posting it to the webview. Writes to GitHub are a separate, default-off slice gated behind a modal.

**Tech Stack:** TypeScript, VS Code extension API, React (webview), Vitest + @testing-library/react, the `gh` CLI.

**Spec:** [docs/superpowers/specs/2026-07-28-deck-review-requests-design.md](../specs/2026-07-28-deck-review-requests-design.md)

## Global Constraints

- **No new runtime dependencies.** `package.json` dependencies must not change. (This repo is public OSS and the maintainer's global `~/.npmrc` points at a private CodeArtifact registry — any lockfile churn risks re-polluting it and failing CI with E401.)
- **Coverage thresholds must keep passing:** statements 90, branches 85, functions 85, lines 90 (`vitest.config.ts`). Run `npx vitest run --coverage` before the final commit of each slice.
- **No test may fork a real process.** Every `gh` call goes through the injected `Runner` type from `src/engine/pr/provider.ts`.
- **All `gh` access is read-only until Slice 3.** Tasks 1–12 must not introduce any command that writes.
- **Existing on-disk records must keep working.** `~/.agentflow/runs/*.json` files written before this change have no `kind` field and must continue to behave exactly as they do today.
- **Setting names are exact:** `agentFlow.reviewRequests`, `agentFlow.reviewRequestsTtlSeconds`, `agentFlow.reviewWrites`, `agentFlow.reviewRequestPrompt`. Note `reviewRequestPrompt` is deliberately distinct from the existing `prReviewPrompt`, which does the opposite thing.
- **Search query is exactly** `is:pr is:open review-requested:@me`, limit 50.
- **Size buckets:** `S` ≤ 100 lines changed, `M` ≤ 500, `L` > 500. Lines changed = `additions + deletions`.
- **Commit style:** conventional commits (`feat:`, `test:`, `docs:`, `refactor:`), matching `git log`.

### Webview design system — read `src/webview/deckStyles.ts`'s header before writing any CSS

The Deck was restyled in `9775224` (one commit before this branch). Every rule below is enforced there and is easy to break by accident:

- **Mono is for identifiers and counts only** — repo names, PR numbers, diff counts, sizes. Anything that reads as English (a PR title, "3 PRs waiting on your review", an author handle) uses the UI font. Prose in mono is what made the board read as a log dump.
- **Every `font-size` is one of four tokens:** `--t-micro` (10px), `--t-data` (10.5px, mono identifiers), `--t-body` (11px, status/meta/controls), `--t-title` (13px). Do not introduce a fifth value.
- **Borders:** `--hair` for structural rules between things; `--edge` for a control's own outline (`--hair` is invisible against a card surface).
- **Radii:** `--r-card`, `--r-ctl`, `--r-chip`. **Dimmed text:** `color: var(--dim)`, not `opacity`.
- **Colour is spent on attention debt.** `--c-attn` (orange) means "your turn"; `--c-danger` (red) is only for something broken or destructive — failing checks, deletions, Forget. A review request waiting on you is *not* red.
- **Ticking numbers get `font-variant-numeric: tabular-nums`** so a re-render cannot reflow the row.
- **Every clickable is a real `<button type="button">`.** The toggles were divs; that commit fixed it, and no keyboard user should lose ground here.
- **`.act` dims to 70% unless it is inside a hovered `.card`.** The strip is not a card, so any `.act` reused there must have its opacity restored explicitly, or the buttons render permanently faded.
- The board's column formerly labelled "Needs you" is now **"Action required"** (`--c-attn`, tone `attn`). The `needs` column *id* is unchanged — it is engine vocabulary and never reaches a user.

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/engine/review/sort.ts` | `sizeBucket`, `linesChanged`, `sortRequests`. Pure, no I/O. |
| `src/engine/review/search.ts` | The GraphQL document, its constants, and pure `gh` JSON → `ReviewRequest` mapping. |
| `src/engine/review/provider.ts` | `GhReviewProvider`: `search()`, `detail()`, `submit()`. All spawning, via an injected `Runner`. |
| `src/engine/review/store.ts` | `~/.agentflow/reviews.json` read/write/staleness. |
| `src/engine/review/launch.ts` | Review-run key, prompt substitution, and the worktree launch. |
| `src/webview/ReviewStrip.tsx` | The strip, rows, expansion, and (Slice 3) the review box. |
| `test/unit/engine/review/sort.test.ts` | |
| `test/unit/engine/review/search.test.ts` | |
| `test/unit/engine/review/provider.test.ts` | |
| `test/unit/engine/review/store.test.ts` | |
| `test/unit/engine/review/launch.test.ts` | |
| `test/webview/ReviewStrip.test.tsx` | |

**Modified:**

| File | Change |
|---|---|
| `src/types.ts` | `ReviewRequest`, `ReviewDetail`, `ReviewSize`, `ReviewSort`, `ReviewVerb`; `Run.kind` + `runKind()`; `isTicketRun` update; new inbound/outbound messages. |
| `src/config.ts` | Four new settings + the default review prompt. |
| `package.json` | `contributes.configuration.properties` for the four settings. |
| `src/deckView.ts` | Review fetch scheduling, decoration, message handling, submit + confirm. |
| `src/webview/DeckApp.tsx` | Mount `ReviewStrip`, hold its state, add the **To review** stat. |
| `src/webview/deckStyles.ts` | Strip styles. |
| `src/engine/pr/facts.ts` | Export `countUnresolved` (extracted from `GhProvider.unresolved`). |
| `src/engine/pr/provider.ts` | Export `THREADS_QUERY`; use `countUnresolved`. |
| `src/engine/workspace.ts` | `OpenRequest.kind` → `Run.kind`. |
| `README.md`, `CHANGELOG.md` | Feature docs + the amended read-only claim. |

---

## Slice 1 — Discovery and the strip (read-only)

### Task 1: Review types and the sort/size rules

**Files:**
- Modify: `src/types.ts` (append a new section after the PR & CI block, which ends at line 145)
- Create: `src/engine/review/sort.ts`
- Test: `test/unit/engine/review/sort.test.ts`

**Interfaces:**
- Consumes: `PrCheck`, `PrFacts` (already in `src/types.ts`).
- Produces: `ReviewRequest`, `ReviewDetail`, `ReviewSize`, `ReviewSort`, `ReviewVerb`; `sizeBucket(lines: number): ReviewSize`, `linesChanged(r: ReviewRequest): number`, `sortRequests(reqs: ReviewRequest[], sort: ReviewSort): ReviewRequest[]`.

- [ ] **Step 1: Add the types**

Append to `src/types.ts`, after the `PrEntryMap` declaration:

```ts
// ── Review requests: PRs waiting on you ─────────────────────────────────────

export type ReviewSize = "S" | "M" | "L";
export type ReviewSort = "oldest" | "smallest";
export type ReviewVerb = "approve" | "comment" | "request-changes";

/** One PR asking for your review — everything the strip renders unexpanded.
 * `localPath`, `runKey` and `draftPath` are observed locally on every refresh and
 * never persisted: a cached path to a worktree since forgotten would render an
 * action that cannot work. */
export interface ReviewRequest {
  id: string; // "owner/repo#number" — stable across refreshes
  repo: string; // nameWithOwner
  repoName: string; // short name, for matching a local checkout
  number: number;
  title: string;
  url: string;
  author: string;
  isDraft: boolean;
  createdAt: number; // epoch ms
  updatedAt: number; // epoch ms
  additions: number;
  deletions: number;
  changedFiles: number;
  ci: "passing" | "failing" | "pending" | "none";
  review: PrFacts["review"];
  mergeable: PrFacts["mergeable"];
  localPath: string | null; // matched checkout; null disables the agent action
  runKey: string | null; // a review run in flight for this PR
  draftPath: string | null; // .pick-task/REVIEW-<n>.md, once the agent writes it
}

/** What expanding a row adds — the two things the search cannot return. */
export interface ReviewDetail {
  failing: PrCheck[];
  unresolved: number | null;
}
```

- [ ] **Step 2: Write the failing test**

Create `test/unit/engine/review/sort.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sizeBucket, linesChanged, sortRequests } from "../../../../src/engine/review/sort";
import type { ReviewRequest } from "../../../../src/types";

const mk = (over: Partial<ReviewRequest> = {}): ReviewRequest => ({
  id: "o/r#1", repo: "o/r", repoName: "r", number: 1, title: "t", url: "u", author: "a",
  isDraft: false, createdAt: 1000, updatedAt: 1000,
  additions: 10, deletions: 0, changedFiles: 1,
  ci: "passing", review: "review_required", mergeable: "clean",
  localPath: null, runKey: null, draftPath: null,
  ...over,
});

describe("sizeBucket", () => {
  it.each([
    [0, "S"], [100, "S"], [101, "M"], [500, "M"], [501, "L"], [5921, "L"],
  ])("buckets %i lines as %s", (lines, bucket) => {
    expect(sizeBucket(lines)).toBe(bucket);
  });
});

describe("linesChanged", () => {
  it("sums additions and deletions", () => {
    expect(linesChanged(mk({ additions: 409, deletions: 50 }))).toBe(459);
  });
});

describe("sortRequests", () => {
  it("orders oldest first", () => {
    const out = sortRequests([mk({ id: "b", createdAt: 200 }), mk({ id: "a", createdAt: 100 })], "oldest");
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("orders smallest first by lines changed, not files", () => {
    const big = mk({ id: "big", additions: 3923, deletions: 1998, changedFiles: 50 });
    const small = mk({ id: "small", additions: 106, deletions: 0, changedFiles: 1 });
    expect(sortRequests([big, small], "smallest").map((r) => r.id)).toEqual(["small", "big"]);
  });

  it("breaks a size tie on age", () => {
    const newer = mk({ id: "newer", additions: 50, deletions: 0, createdAt: 200 });
    const older = mk({ id: "older", additions: 50, deletions: 0, createdAt: 100 });
    expect(sortRequests([newer, older], "smallest").map((r) => r.id)).toEqual(["older", "newer"]);
  });

  it("pins drafts last in both orders", () => {
    const draft = mk({ id: "draft", isDraft: true, createdAt: 1, additions: 1, deletions: 0 });
    const real = mk({ id: "real", createdAt: 999, additions: 900, deletions: 900 });
    expect(sortRequests([draft, real], "oldest").map((r) => r.id)).toEqual(["real", "draft"]);
    expect(sortRequests([draft, real], "smallest").map((r) => r.id)).toEqual(["real", "draft"]);
  });

  it("does not mutate its input", () => {
    const input = [mk({ id: "b", createdAt: 200 }), mk({ id: "a", createdAt: 100 })];
    sortRequests(input, "oldest");
    expect(input.map((r) => r.id)).toEqual(["b", "a"]);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run test/unit/engine/review/sort.test.ts`
Expected: FAIL — `Cannot find module '../../../../src/engine/review/sort'`.

- [ ] **Step 4: Implement**

Create `src/engine/review/sort.ts`:

```ts
import { ReviewRequest, ReviewSize, ReviewSort } from "../../types";

/** Lines changed, the size signal the strip sorts and buckets on. Files changed
 * alone would call a 3,000-line single-file rewrite "small". */
export function linesChanged(r: ReviewRequest): number {
  return r.additions + r.deletions;
}

/** S/M/L by lines changed — the same vocabulary the task pool's size lens uses,
 * so one mental model covers both panels. */
export function sizeBucket(lines: number): ReviewSize {
  if (lines <= 100) return "S";
  if (lines <= 500) return "M";
  return "L";
}

/** Order the strip. Drafts pin last in both modes — a draft asking for review is
 * still not the thing you should pick up first. Ties break on age, so "smallest"
 * stays deterministic across refreshes. Pure: returns a new array. */
export function sortRequests(reqs: ReviewRequest[], sort: ReviewSort): ReviewRequest[] {
  return [...reqs].sort((a, b) => {
    if (a.isDraft !== b.isDraft) return a.isDraft ? 1 : -1;
    if (sort === "smallest") {
      const bySize = linesChanged(a) - linesChanged(b);
      if (bySize !== 0) return bySize;
    }
    return a.createdAt - b.createdAt;
  });
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/unit/engine/review/sort.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/types.ts src/engine/review/sort.ts test/unit/engine/review/sort.test.ts
git commit -m "feat(review): review-request types, size buckets and sort orders"
```

---

### Task 2: The GraphQL search and its mapper

**Files:**
- Create: `src/engine/review/search.ts`
- Test: `test/unit/engine/review/search.test.ts`

**Interfaces:**
- Consumes: `ReviewRequest` (Task 1); `mapReview` from `src/engine/pr/facts.ts`.
- Produces: `REVIEW_SEARCH_QUERY: string`, `REVIEW_SEARCH_Q: string`, `REVIEW_SEARCH_LIMIT: number`, `mapRollupState(s?: string | null): ReviewRequest["ci"]`, `mapGraphMergeable(m?: string | null): PrFacts["mergeable"]`, `parseSearch(json: unknown): { issueCount: number; requests: ReviewRequest[] } | null`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine/review/search.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mapRollupState, mapGraphMergeable, parseSearch, REVIEW_SEARCH_Q } from "../../../../src/engine/review/search";

const node = (over: Record<string, unknown> = {}) => ({
  number: 8491,
  title: "[ASM-5752] isolate renew queue",
  url: "https://github.com/CyberJackGit/aws-ops/pull/8491",
  isDraft: false,
  createdAt: "2026-07-23T07:28:26Z",
  updatedAt: "2026-07-23T16:33:30Z",
  additions: 350,
  deletions: 4,
  changedFiles: 7,
  author: { login: "einavsaad" },
  repository: { nameWithOwner: "CyberJackGit/aws-ops" },
  reviewDecision: "APPROVED",
  mergeable: "MERGEABLE",
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
  ...over,
});
const payload = (nodes: unknown[], issueCount = nodes.length) => ({ data: { search: { issueCount, nodes } } });

describe("REVIEW_SEARCH_Q", () => {
  it("is the exact qualifier set, including team requests", () => {
    expect(REVIEW_SEARCH_Q).toBe("is:pr is:open review-requested:@me");
  });
});

describe("mapRollupState", () => {
  it.each([
    ["SUCCESS", "passing"], ["FAILURE", "failing"], ["ERROR", "failing"],
    ["PENDING", "pending"], ["EXPECTED", "pending"],
  ])("maps %s to %s", (state, expected) => {
    expect(mapRollupState(state)).toBe(expected);
  });

  it("reports no CI for a null rollup or an unknown state", () => {
    expect(mapRollupState(null)).toBe("none");
    expect(mapRollupState(undefined)).toBe("none");
    expect(mapRollupState("WAT")).toBe("none");
  });
});

describe("mapGraphMergeable", () => {
  it.each([
    ["MERGEABLE", "clean"], ["CONFLICTING", "conflicting"], ["UNKNOWN", "unknown"],
  ])("maps %s to %s", (m, expected) => {
    expect(mapGraphMergeable(m)).toBe(expected);
  });

  it("treats a missing value as unknown — GitHub computes it lazily", () => {
    expect(mapGraphMergeable(undefined)).toBe("unknown");
  });
});

describe("parseSearch", () => {
  it("maps a full node", () => {
    const out = parseSearch(payload([node()]));
    expect(out).not.toBeNull();
    expect(out!.issueCount).toBe(1);
    expect(out!.requests[0]).toMatchObject({
      id: "CyberJackGit/aws-ops#8491",
      repo: "CyberJackGit/aws-ops",
      repoName: "aws-ops",
      number: 8491,
      author: "einavsaad",
      additions: 350,
      deletions: 4,
      changedFiles: 7,
      ci: "passing",
      review: "approved",
      mergeable: "clean",
      isDraft: false,
      localPath: null,
      runKey: null,
      draftPath: null,
    });
    expect(out!.requests[0].createdAt).toBe(Date.parse("2026-07-23T07:28:26Z"));
  });

  it("keeps issueCount when it exceeds the returned nodes", () => {
    expect(parseSearch(payload([node()], 73))!.issueCount).toBe(73);
  });

  it("drops a node with no number or no url, and keeps the rest", () => {
    const out = parseSearch(payload([node({ number: undefined }), node({ url: "" }), node({ number: 12 })]));
    expect(out!.requests.map((r) => r.number)).toEqual([12]);
  });

  it("drops a non-PullRequest node — the search type is ISSUE", () => {
    expect(parseSearch(payload([{}, node()]))!.requests).toHaveLength(1);
  });

  it("survives a missing author, rollup, counts and decision", () => {
    const out = parseSearch(payload([
      node({ author: null, commits: null, additions: undefined, deletions: undefined, changedFiles: undefined, reviewDecision: null }),
    ]));
    expect(out!.requests[0]).toMatchObject({
      author: "unknown", ci: "none", additions: 0, deletions: 0, changedFiles: 0, review: "none",
    });
  });

  it("survives an empty commits list", () => {
    expect(parseSearch(payload([node({ commits: { nodes: [] } })]))!.requests[0].ci).toBe("none");
  });

  it("zeroes an unparsable timestamp rather than yielding NaN", () => {
    expect(parseSearch(payload([node({ createdAt: "not a date" })]))!.requests[0].createdAt).toBe(0);
  });

  it("returns null for a shape that is not a search response", () => {
    expect(parseSearch({ errors: [{ message: "Bad credentials" }] })).toBeNull();
    expect(parseSearch(null)).toBeNull();
    expect(parseSearch({ data: { search: { nodes: "nope" } } })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/unit/engine/review/search.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/engine/review/search.ts`:

```ts
import { PrFacts, ReviewRequest } from "../../types";
import { mapReview } from "../pr/facts";

/** The one call the whole strip rides on. Verified against gh 2.89.0: returns
 * size, rollup, decision and mergeability for every request in ~3s. The rollup
 * exposes only an aggregate `state` — failing check *names* need a per-PR call,
 * which is what row expansion is for. */
export const REVIEW_SEARCH_QUERY =
  "query($q:String!,$n:Int!){search(query:$q,type:ISSUE,first:$n){issueCount nodes{" +
  "... on PullRequest{number title url isDraft createdAt updatedAt additions deletions changedFiles " +
  "author{login} repository{nameWithOwner} reviewDecision mergeable " +
  "commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}}";

/** `review-requested:` is the superset — it includes requests made to a team you
 * belong to, which `user-review-requested:` excludes. */
export const REVIEW_SEARCH_Q = "is:pr is:open review-requested:@me";

export const REVIEW_SEARCH_LIMIT = 50;

const CI_FAILING = new Set(["FAILURE", "ERROR"]);
const CI_PENDING = new Set(["PENDING", "EXPECTED"]);

/** The rollup's aggregate state. Anything unrecognised reads as "no CI" rather
 * than as a failure — inventing a red row from a state we don't know would send
 * the user to a PR that is fine. */
export function mapRollupState(state?: string | null): ReviewRequest["ci"] {
  if (!state) return "none";
  if (CI_FAILING.has(state)) return "failing";
  if (CI_PENDING.has(state)) return "pending";
  if (state === "SUCCESS") return "passing";
  return "none";
}

/** GraphQL's `mergeable` enum, which is not gh's REST pair — `mapMergeable`
 * would read MERGEABLE as "unknown" because it looks at mergeStateStatus. */
export function mapGraphMergeable(m?: string | null): PrFacts["mergeable"] {
  if (m === "CONFLICTING") return "conflicting";
  if (m === "MERGEABLE") return "clean";
  return "unknown";
}

/** Epoch ms, or 0 for anything unparsable — NaN would poison every comparator. */
function ms(iso: unknown): number {
  if (typeof iso !== "string") return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

function count(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

interface RawNode {
  number?: unknown;
  title?: unknown;
  url?: unknown;
  isDraft?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  additions?: unknown;
  deletions?: unknown;
  changedFiles?: unknown;
  author?: { login?: unknown } | null;
  repository?: { nameWithOwner?: unknown } | null;
  reviewDecision?: unknown;
  mergeable?: unknown;
  commits?: { nodes?: { commit?: { statusCheckRollup?: { state?: unknown } | null } }[] } | null;
}

/** One node → a request, or null when it lacks an identity we could render or
 * link. `type: ISSUE` means issues and non-PR nodes come back as `{}`. */
function toRequest(raw: RawNode): ReviewRequest | null {
  const repo = raw.repository?.nameWithOwner;
  if (typeof raw.number !== "number" || typeof raw.url !== "string" || !raw.url) return null;
  if (typeof repo !== "string" || !repo) return null;
  const rollup = raw.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  return {
    id: `${repo}#${raw.number}`,
    repo,
    repoName: repo.split("/").pop() ?? repo,
    number: raw.number,
    title: typeof raw.title === "string" ? raw.title : "",
    url: raw.url,
    author: typeof raw.author?.login === "string" ? raw.author.login : "unknown",
    isDraft: raw.isDraft === true,
    createdAt: ms(raw.createdAt),
    updatedAt: ms(raw.updatedAt),
    additions: count(raw.additions),
    deletions: count(raw.deletions),
    changedFiles: count(raw.changedFiles),
    ci: mapRollupState(typeof rollup === "string" ? rollup : null),
    review: mapReview(typeof raw.reviewDecision === "string" ? raw.reviewDecision : null),
    mergeable: mapGraphMergeable(typeof raw.mergeable === "string" ? raw.mergeable : null),
    localPath: null,
    runKey: null,
    draftPath: null,
  };
}

/** Parse a `gh api graphql` response. Null means "this is not a search result" —
 * an errors payload, a truncated body, anything the caller must treat as a failed
 * attempt rather than as an empty queue. An empty `nodes` array is a *success*
 * that says you owe nobody a review, which is a different thing entirely. */
export function parseSearch(json: unknown): { issueCount: number; requests: ReviewRequest[] } | null {
  const search = (json as { data?: { search?: { issueCount?: unknown; nodes?: unknown } } } | null)?.data?.search;
  if (!search || !Array.isArray(search.nodes)) return null;
  const requests = (search.nodes as RawNode[])
    .map((n) => (n && typeof n === "object" ? toRequest(n) : null))
    .filter((r): r is ReviewRequest => r !== null);
  const issueCount = typeof search.issueCount === "number" ? search.issueCount : requests.length;
  return { issueCount, requests };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/unit/engine/review/search.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx tsc --noEmit
git add src/engine/review/search.ts test/unit/engine/review/search.test.ts
git commit -m "feat(review): the review-request search query and its mapper"
```

---

### Task 3: Extract `countUnresolved` from the PR provider

This is groundwork: the review provider needs the same unresolved-thread count `GhProvider` already computes, and duplicating the parse would let the two drift.

**Files:**
- Modify: `src/engine/pr/facts.ts` (append)
- Modify: `src/engine/pr/provider.ts:13-15` (export `THREADS_QUERY`), `:108-125` (`unresolved` uses the helper)
- Test: `test/unit/engine/pr/facts.test.ts` (append)

**Interfaces:**
- Produces: `countUnresolved(json: unknown): number | null` from `src/engine/pr/facts.ts`; `THREADS_QUERY` exported from `src/engine/pr/provider.ts`.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/engine/pr/facts.test.ts`:

```ts
import { countUnresolved } from "../../../../src/engine/pr/facts";

describe("countUnresolved", () => {
  const wrap = (nodes: unknown) => ({
    data: { repository: { pullRequest: { reviewThreads: { nodes } } } },
  });

  it("counts threads that are neither resolved nor outdated", () => {
    expect(countUnresolved(wrap([
      { isResolved: false, isOutdated: false },
      { isResolved: true, isOutdated: false },
      { isResolved: false, isOutdated: true },
      { isResolved: false, isOutdated: false },
    ]))).toBe(2);
  });

  it("counts zero for an empty thread list", () => {
    expect(countUnresolved(wrap([]))).toBe(0);
  });

  it("returns null when the shape is not a thread list", () => {
    expect(countUnresolved(wrap("nope"))).toBeNull();
    expect(countUnresolved({})).toBeNull();
    expect(countUnresolved(null)).toBeNull();
  });

  // The three cases that separate a preserved refactor from a broken one. The
  // container-shape cases above pass against either version.
  it("returns null for a null entry inside an otherwise valid list", () => {
    expect(countUnresolved(wrap([null, { isResolved: false, isOutdated: false }]))).toBeNull();
  });

  it("returns null for a non-object entry", () => {
    expect(countUnresolved(wrap(["nope", { isResolved: false, isOutdated: false }]))).toBeNull();
    expect(countUnresolved(wrap([7]))).toBeNull();
  });

  it("counts a thread with neither flag set — absent means unresolved", () => {
    expect(countUnresolved(wrap([{}]))).toBe(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/unit/engine/pr/facts.test.ts`
Expected: FAIL — `countUnresolved is not a function`.

- [ ] **Step 3: Add the helper**

Append to `src/engine/pr/facts.ts`:

```ts
/** Unresolved review threads in a `reviewThreads` GraphQL response. Null means the
 * shape was not one we recognise — a caller must not render that as "0 open".
 * An outdated thread is not counted: it refers to code the PR has since replaced. */
export function countUnresolved(json: unknown): number | null {
  const nodes = (json as {
    data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: unknown } } } };
  } | null)?.data?.repository?.pullRequest?.reviewThreads?.nodes;
  if (!Array.isArray(nodes)) return null;
  // A null or non-object entry means this is not a thread list we understand.
  // The pre-extraction code reached the same verdict by throwing into the
  // caller's catch; saying so outright removes the dependence on an exception
  // and keeps the answer honest — a wrong count reads as fact, `null` does not.
  if (nodes.some((n) => !n || typeof n !== "object")) return null;
  return (nodes as { isResolved?: boolean; isOutdated?: boolean }[]).filter(
    (n) => !n.isResolved && !n.isOutdated,
  ).length;
}
```

**Why the guard, and not `n?.isResolved`:** an earlier draft of this task used optional chaining on `n` instead. That silently *counts* a null entry as an open thread (`!undefined` is `true`), where the code being replaced threw a `TypeError` that the caller's `try/catch` turned into `null`. A refactor that turns "we could not find out" into a confidently wrong number is not behaviour-preserving. Three tests below pin it.

- [ ] **Step 4: Use it in the PR provider**

In `src/engine/pr/provider.ts`, change the `THREADS_QUERY` declaration (line 13) from `const` to `export const`, add `countUnresolved` to the existing import from `./facts` (line 3), and replace the body of `unresolved` after the `try {` with:

```ts
      const out = await this.run(
        this.locate() ?? "gh",
        ["api", "graphql", "-f", `query=${THREADS_QUERY}`, "-F", `o=${loc.owner}`, "-F", `r=${loc.repo}`, "-F", `n=${pr.number}`],
        { cwd: repoPath, timeoutMs: GH_TIMEOUT_MS },
      );
      return countUnresolved(JSON.parse(out));
```

- [ ] **Step 5: Run the whole PR suite — this is a refactor, nothing may change**

Run: `npx vitest run test/unit/engine/pr/`
Expected: PASS, including the pre-existing provider tests unchanged.

- [ ] **Step 6: Commit**

```bash
npx tsc --noEmit
git add src/engine/pr/facts.ts src/engine/pr/provider.ts test/unit/engine/pr/facts.test.ts
git commit -m "refactor(pr): extract countUnresolved so the review provider can share it"
```

---

### Task 4: `GhReviewProvider` — search and detail

**Files:**
- Create: `src/engine/review/provider.ts`
- Test: `test/unit/engine/review/provider.test.ts`

**Interfaces:**
- Consumes: `Runner`, `Locate`, `execRunner`, `GH_TIMEOUT_MS`, `THREADS_QUERY` (`src/engine/pr/provider.ts`); `resolveBin` (`src/engine/pr/which.ts`); `mapRollup`, `countUnresolved`, `parseRepoFromUrl` (`src/engine/pr/facts.ts`); `parseSearch` and friends (Task 2).
- Produces: `ReviewProvider` interface and `GhReviewProvider` with
  `search(): Promise<{ issueCount: number; requests: ReviewRequest[] } | null>` and
  `detail(repo: string, number: number): Promise<ReviewDetail | null>`.
  (`submit` arrives in Task 13.)

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine/review/provider.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { GhReviewProvider } from "../../../../src/engine/review/provider";
import type { Runner } from "../../../../src/engine/pr/provider";

const searchPayload = JSON.stringify({
  data: {
    search: {
      issueCount: 1,
      nodes: [{
        number: 850, title: "Encrypt only Synqly credential",
        url: "https://github.com/CyberJackGit/centaur/pull/850",
        isDraft: false, createdAt: "2026-07-27T14:31:30Z", updatedAt: "2026-07-28T06:23:08Z",
        additions: 409, deletions: 50, changedFiles: 8,
        author: { login: "OshriBay" }, repository: { nameWithOwner: "CyberJackGit/centaur" },
        reviewDecision: null, mergeable: "MERGEABLE",
        commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
      }],
    },
  },
});

const runner = (impl: Runner) => vi.fn(impl) as unknown as Runner & ReturnType<typeof vi.fn>;
const locate = () => "/opt/homebrew/bin/gh";

describe("GhReviewProvider.search", () => {
  it("asks gh for the review-request search and maps the result", async () => {
    const run = runner(async () => searchPayload);
    const out = await new GhReviewProvider(run, locate).search();
    expect(out!.issueCount).toBe(1);
    expect(out!.requests[0].id).toBe("CyberJackGit/centaur#850");
    const [file, args, opts] = (run as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(file).toBe("/opt/homebrew/bin/gh");
    expect(args[0]).toBe("api");
    expect(args[1]).toBe("graphql");
    expect(args).toContain("q=is:pr is:open review-requested:@me");
    expect(args).toContain("n=50");
    // No cwd inside a checkout: the repos may not be cloned at all.
    expect(opts.cwd).toBe(require("os").homedir());
  });

  it("returns null when gh fails", async () => {
    const run = runner(async () => { throw new Error("gh: not logged in"); });
    expect(await new GhReviewProvider(run, locate).search()).toBeNull();
  });

  it("returns null on unparsable stdout", async () => {
    const run = runner(async () => "<html>proxy error</html>");
    expect(await new GhReviewProvider(run, locate).search()).toBeNull();
  });

  it("returns null on a GraphQL errors payload", async () => {
    const run = runner(async () => JSON.stringify({ errors: [{ message: "Bad credentials" }] }));
    expect(await new GhReviewProvider(run, locate).search()).toBeNull();
  });

  it("falls back to the bare binary name when gh cannot be located", async () => {
    const run = runner(async () => searchPayload);
    await new GhReviewProvider(run, () => null).search();
    expect((run as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("gh");
  });
});

describe("GhReviewProvider.detail", () => {
  const rollup = JSON.stringify({
    statusCheckRollup: [
      { __typename: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "CheckRun", name: "e2e", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://ci/e2e" },
    ],
  });
  const threads = JSON.stringify({
    data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: false, isOutdated: false }] } } } },
  });

  it("returns failing check names and the unresolved count", async () => {
    const run = runner(async (_f, args) => (args[0] === "pr" ? rollup : threads));
    const out = await new GhReviewProvider(run, locate).detail("CyberJackGit/aws-ops", 8491);
    expect(out).toEqual({ failing: [{ name: "e2e", url: "https://ci/e2e" }], unresolved: 1 });
  });

  it("targets the repo by name, not by working directory", async () => {
    const run = runner(async (_f, args) => (args[0] === "pr" ? rollup : threads));
    await new GhReviewProvider(run, locate).detail("CyberJackGit/aws-ops", 8491);
    const [, args] = (run as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(args).toEqual([
      "pr", "view", "8491", "--repo", "CyberJackGit/aws-ops", "--json", "statusCheckRollup",
    ]);
  });

  it("keeps the checks when the thread call fails", async () => {
    const run = runner(async (_f, args) => {
      if (args[0] === "pr") return rollup;
      throw new Error("graphql exploded");
    });
    const out = await new GhReviewProvider(run, locate).detail("o/r", 1);
    expect(out).toEqual({ failing: [{ name: "e2e", url: "https://ci/e2e" }], unresolved: null });
  });

  it("returns null when the checks call fails", async () => {
    const run = runner(async () => { throw new Error("nope"); });
    expect(await new GhReviewProvider(run, locate).detail("o/r", 1)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/unit/engine/review/provider.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/engine/review/provider.ts`:

```ts
import * as os from "os";
import { ReviewDetail, ReviewRequest } from "../../types";
import { countUnresolved, mapRollup } from "../pr/facts";
import { execRunner, GH_TIMEOUT_MS, Locate, Runner, THREADS_QUERY } from "../pr/provider";
import { resolveBin } from "../pr/which";
import { REVIEW_SEARCH_LIMIT, REVIEW_SEARCH_Q, REVIEW_SEARCH_QUERY, parseSearch } from "./search";

const locateGh: Locate = () => resolveBin("gh");

export interface ReviewProvider {
  search(): Promise<{ issueCount: number; requests: ReviewRequest[] } | null>;
  detail(repo: string, number: number): Promise<ReviewDetail | null>;
}

/** Every call here is repo-independent: a PR requesting your review may live in a
 * repository you have never cloned. `--repo owner/name` carries the target, and
 * the home directory is only somewhere that exists for `gh` to run in. */
export class GhReviewProvider implements ReviewProvider {
  constructor(
    private readonly run: Runner = execRunner,
    private readonly locate: Locate = locateGh,
  ) {}

  private gh(): string {
    return this.locate() ?? "gh";
  }

  private exec(args: string[]): Promise<string> {
    return this.run(this.gh(), args, { cwd: os.homedir(), timeoutMs: GH_TIMEOUT_MS });
  }

  /** Null means the attempt failed — never "you owe nobody a review". The caller
   * keeps its cached list and flags it stale rather than emptying the strip. */
  async search(): Promise<{ issueCount: number; requests: ReviewRequest[] } | null> {
    try {
      const out = await this.exec([
        "api", "graphql",
        "-f", `query=${REVIEW_SEARCH_QUERY}`,
        "-f", `q=${REVIEW_SEARCH_Q}`,
        "-F", `n=${REVIEW_SEARCH_LIMIT}`,
      ]);
      return parseSearch(JSON.parse(out) as unknown);
    } catch {
      return null;
    }
  }

  /** The two things the search cannot return: which checks failed, and how many
   * review threads are still open. A thread-call failure degrades to `null`
   * rather than discarding the checks we did get. */
  async detail(repo: string, number: number): Promise<ReviewDetail | null> {
    let failing: ReviewDetail["failing"];
    try {
      const out = await this.exec(["pr", "view", String(number), "--repo", repo, "--json", "statusCheckRollup"]);
      const parsed = JSON.parse(out) as { statusCheckRollup?: Parameters<typeof mapRollup>[0] };
      failing = mapRollup(parsed.statusCheckRollup).failing;
    } catch {
      return null;
    }
    const [owner, name] = repo.split("/");
    let unresolved: number | null = null;
    if (owner && name) {
      try {
        const out = await this.exec([
          "api", "graphql", "-f", `query=${THREADS_QUERY}`,
          "-F", `o=${owner}`, "-F", `r=${name}`, "-F", `n=${number}`,
        ]);
        unresolved = countUnresolved(JSON.parse(out) as unknown);
      } catch {
        unresolved = null;
      }
    }
    return { failing, unresolved };
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/unit/engine/review/provider.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
npx tsc --noEmit
git add src/engine/review/provider.ts test/unit/engine/review/provider.test.ts
git commit -m "feat(review): a gh-backed provider for the review search and per-PR detail"
```

---

### Task 5: The reviews cache

**Files:**
- Create: `src/engine/review/store.ts`
- Test: `test/unit/engine/review/store.test.ts`

**Interfaces:**
- Produces: `defaultReviewsFile(): string`, `ReviewCache` (`{ fetchedAt: number; issueCount: number; requests: ReviewRequest[] }`), `readReviewCache(file: string): ReviewCache | null`, `writeReviewCache(file: string, cache: ReviewCache): void`, `isReviewCacheStale(cache: ReviewCache | null, ttlMs: number, nowMs: number): boolean`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine/review/store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  defaultReviewsFile, readReviewCache, writeReviewCache, isReviewCacheStale,
} from "../../../../src/engine/review/store";
import type { ReviewRequest } from "../../../../src/types";

const req: ReviewRequest = {
  id: "o/r#1", repo: "o/r", repoName: "r", number: 1, title: "t", url: "https://gh/o/r/pull/1",
  author: "a", isDraft: false, createdAt: 1, updatedAt: 2,
  additions: 3, deletions: 4, changedFiles: 5,
  ci: "passing", review: "review_required", mergeable: "clean",
  localPath: null, runKey: null, draftPath: null,
};

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-reviews-"));
  file = path.join(dir, "reviews.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("defaultReviewsFile", () => {
  it("sits beside the other agentflow stores", () => {
    expect(defaultReviewsFile()).toBe(path.join(os.homedir(), ".agentflow", "reviews.json"));
  });
});

describe("readReviewCache / writeReviewCache", () => {
  it("round-trips a cache", () => {
    writeReviewCache(file, { fetchedAt: 111, issueCount: 9, requests: [req] });
    expect(readReviewCache(file)).toEqual({ fetchedAt: 111, issueCount: 9, requests: [req] });
  });

  it("creates the directory when it is missing", () => {
    const nested = path.join(dir, "deep", "reviews.json");
    writeReviewCache(nested, { fetchedAt: 1, issueCount: 0, requests: [] });
    expect(readReviewCache(nested)).not.toBeNull();
  });

  it("returns null for a missing file", () => {
    expect(readReviewCache(path.join(dir, "nope.json"))).toBeNull();
  });

  it("returns null for corrupt JSON rather than throwing", () => {
    fs.writeFileSync(file, "{ half-writ");
    expect(readReviewCache(file)).toBeNull();
  });

  it("returns null when requests is not an array", () => {
    fs.writeFileSync(file, JSON.stringify({ fetchedAt: 1, issueCount: 0, requests: {} }));
    expect(readReviewCache(file)).toBeNull();
  });

  it("returns null when fetchedAt is missing", () => {
    fs.writeFileSync(file, JSON.stringify({ issueCount: 0, requests: [] }));
    expect(readReviewCache(file)).toBeNull();
  });

  // The failing write must target the SAME file being asserted on, and the failure
  // must be forced rather than coaxed out of platform errno behaviour. An earlier
  // draft pointed the failing write at a different path, so it asserted only that an
  // untouched file was untouched — a naive `writeFileSync(file, json)` with no temp
  // file passed it unchanged.
  it("leaves the previous cache intact when the rename fails", () => {
    writeReviewCache(file, { fetchedAt: 1, issueCount: 1, requests: [req] });
    const spy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("EXDEV: cross-device link not permitted");
    });
    try {
      writeReviewCache(file, { fetchedAt: 2, issueCount: 0, requests: [] });
    } finally {
      spy.mockRestore();
    }
    expect(readReviewCache(file)).toEqual({ fetchedAt: 1, issueCount: 1, requests: [req] });
    // …and the temp file was cleaned up rather than left as litter.
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("round-trips a present-but-empty queue as a real object, not null", () => {
    writeReviewCache(file, { fetchedAt: 5, issueCount: 0, requests: [] });
    expect(readReviewCache(file)).toEqual({ fetchedAt: 5, issueCount: 0, requests: [] });
  });

  it("drops a malformed request but keeps the rest", () => {
    fs.writeFileSync(file, JSON.stringify({ fetchedAt: 1, issueCount: 2, requests: [null, req] }));
    expect(readReviewCache(file)!.requests).toEqual([req]);
  });

  it("keeps a readable file whose rows are all unusable, as an empty queue", () => {
    fs.writeFileSync(file, JSON.stringify({ fetchedAt: 1, requests: ["garbage"] }));
    expect(readReviewCache(file)).toEqual({ fetchedAt: 1, issueCount: 0, requests: [] });
  });
});

describe("isReviewCacheStale", () => {
  it("treats a missing cache as stale", () => {
    expect(isReviewCacheStale(null, 1000, 5000)).toBe(true);
  });

  it("is stale exactly at the TTL", () => {
    expect(isReviewCacheStale({ fetchedAt: 4000, issueCount: 0, requests: [] }, 1000, 5000)).toBe(true);
  });

  it("is fresh below the TTL", () => {
    expect(isReviewCacheStale({ fetchedAt: 4001, issueCount: 0, requests: [] }, 1000, 5000)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/unit/engine/review/store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/engine/review/store.ts`:

```ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ReviewRequest } from "../../types";

/** One file, not a directory: unlike PR facts there is no per-run partition —
 * the review queue is a single list belonging to you. Sits beside `runs/`,
 * `windows/` and `prfacts/`. */
export function defaultReviewsFile(): string {
  return path.join(os.homedir(), ".agentflow", "reviews.json");
}

export interface ReviewCache {
  fetchedAt: number;
  issueCount: number;
  requests: ReviewRequest[];
}

/** Null for missing, unreadable, or structurally wrong — a broken cache must
 * degrade to "we have nothing yet", never to a half-rendered strip. */
export function readReviewCache(file: string): ReviewCache | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ReviewCache> | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.fetchedAt !== "number" || !Array.isArray(parsed.requests)) return null;
    // Filter to values that actually look like a request. The Deck maps over these and
    // reads .repoName/.number off each one, so a null or string element would throw out
    // of the refresh and freeze the board — the same failure pr/store.ts guards against.
    // Filtered, not rejected: one bad row must not cost the user the whole queue.
    const requests = (parsed.requests as unknown[]).filter(
      (r): r is ReviewRequest =>
        !!r &&
        typeof r === "object" &&
        typeof (r as ReviewRequest).id === "string" &&
        typeof (r as ReviewRequest).number === "number",
    );
    return {
      fetchedAt: parsed.fetchedAt,
      issueCount: typeof parsed.issueCount === "number" ? parsed.issueCount : requests.length,
      requests,
    };
  } catch {
    return null;
  }
}

/** Atomic (temp + rename), so a failed write leaves the previous list untouched
 * rather than truncating the strip to nothing. Best-effort: a cache write must
 * never fail a refresh. */
export function writeReviewCache(file: string, cache: ReviewCache): void {
  const dir = path.dirname(file);
  const tempFile = path.join(dir, `.reviews.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tempFile, JSON.stringify(cache, null, 2) + "\n");
    fs.renameSync(tempFile, file);
  } catch {
    try {
      fs.rmSync(tempFile, { force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

/** Due for a refetch? A missing cache is stale; exactly at the TTL is stale.
 * Pure — the clock is injected. */
export function isReviewCacheStale(cache: ReviewCache | null, ttlMs: number, nowMs: number): boolean {
  if (!cache) return true;
  return nowMs - cache.fetchedAt >= ttlMs;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/unit/engine/review/store.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
npx tsc --noEmit
git add src/engine/review/store.ts test/unit/engine/review/store.test.ts
git commit -m "feat(review): an atomic on-disk cache for the review queue"
```

---

### Task 6: Settings

**Files:**
- Modify: `src/config.ts` (interface near line 148, reader near line 225)
- Modify: `package.json` (`contributes.configuration.properties`)
- Test: `test/unit/config.test.ts` (append)

**Interfaces:**
- Produces: `AgentFlowConfig.reviewRequests: boolean`, `.reviewRequestsTtlSeconds: number`, `.reviewWrites: boolean`, `.reviewRequestPrompt: string`; `DEFAULT_REVIEW_REQUEST_PROMPT` exported from `src/config.ts`.

`reviewWrites` and the prompt are read here even though Slices 2 and 3 consume them — one settings commit is easier to review than three.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/config.test.ts`, following the file's existing pattern for stubbing `workspace.getConfiguration`:

```ts
describe("review-request settings", () => {
  it("defaults to the strip on, a 5-minute TTL, and writes off", () => {
    const cfg = readConfigWith({}); // the file's existing helper for an empty settings map
    expect(cfg.reviewRequests).toBe(true);
    expect(cfg.reviewRequestsTtlSeconds).toBe(300);
    expect(cfg.reviewWrites).toBe(false);
    expect(cfg.reviewRequestPrompt).toContain("REVIEW-{number}.md");
  });

  it("floors the TTL at 60 seconds", () => {
    expect(readConfigWith({ reviewRequestsTtlSeconds: 5 }).reviewRequestsTtlSeconds).toBe(60);
  });

  it("honours an explicit TTL above the floor", () => {
    expect(readConfigWith({ reviewRequestsTtlSeconds: 900 }).reviewRequestsTtlSeconds).toBe(900);
  });

  it("honours an explicit prompt override", () => {
    expect(readConfigWith({ reviewRequestPrompt: "just look at it" }).reviewRequestPrompt).toBe("just look at it");
  });

  it("falls back to the default prompt for an empty override", () => {
    expect(readConfigWith({ reviewRequestPrompt: "" }).reviewRequestPrompt).toContain("REVIEW-{number}.md");
  });
});
```

If `readConfigWith` does not exist under that name, use whatever the file already uses to drive `getConfig()` with a settings map — do not invent a second harness.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/unit/config.test.ts`
Expected: FAIL — `cfg.reviewRequests` is undefined.

- [ ] **Step 3: Add the default prompt**

In `src/config.ts`, after `PR_REVIEW_AUTOFIX_CLAUSE` (line 122):

```ts
/** Seed for reviewing a teammate's PR from the Deck's review strip. Distinct from
 * DEFAULT_PR_REVIEW_PROMPT, which addresses feedback on *your own* PR. The agent
 * writes its findings to a file; the human submits the review. Placeholders:
 * {repo} {number} {author} are substituted at launch, then {key} {summary} {url}
 * {brief} {files} by renderPrompt. */
export const DEFAULT_REVIEW_REQUEST_PROMPT =
  'Review pull request {url} — {repo}#{number}, "{summary}", by {author}. ' +
  "Check it out with `gh pr checkout {number} --repo {repo}`, then read the full diff against its base branch. " +
  "Assess correctness, edge cases, tests, and anything that would break in production. " +
  "Write your findings to `.pick-task/REVIEW-{number}.md` as a short prioritised list — most serious first, " +
  "each with the file and line it refers to. Do not post anything to GitHub; the human submits the review.{files}";
```

- [ ] **Step 4: Extend the interface and reader**

Add to `AgentFlowConfig`, after `prFactsTtlSeconds`:

```ts
  // Show the Deck's review-requests strip: open PRs that ask for your review.
  reviewRequests: boolean;
  // How stale the cached review queue may be before a refetch. Floored at 60s —
  // review requests move on a human timescale, not a CI one.
  reviewRequestsTtlSeconds: number;
  // Allow submitting approve / comment / request-changes from the Deck. The only
  // setting in Agent Flow that lets it write to GitHub.
  reviewWrites: boolean;
  // Seeded prompt for Review-with-agent.
  reviewRequestPrompt: string;
```

Add to the returned object in `getConfig`, after `prFactsTtlSeconds`:

```ts
    reviewRequests: c.get<boolean>("reviewRequests") ?? true,
    reviewRequestsTtlSeconds: Math.max(60, c.get<number>("reviewRequestsTtlSeconds") ?? 300),
    reviewWrites: c.get<boolean>("reviewWrites") ?? false,
    reviewRequestPrompt: c.get<string>("reviewRequestPrompt") || DEFAULT_REVIEW_REQUEST_PROMPT,
```

- [ ] **Step 5: Declare them in package.json**

Add to `contributes.configuration.properties`, after `agentFlow.prFactsTtlSeconds`:

```json
"agentFlow.reviewRequests": {
  "type": "boolean",
  "default": true,
  "description": "Show the Deck's review-requests strip: open GitHub PRs that ask for your review, read with the gh CLI."
},
"agentFlow.reviewRequestsTtlSeconds": {
  "type": "number",
  "default": 300,
  "minimum": 60,
  "description": "How stale the cached review queue may be before the Deck re-fetches it (minimum 60). Only fetched while the Deck is open."
},
"agentFlow.reviewWrites": {
  "type": "boolean",
  "default": false,
  "markdownDescription": "Allow submitting **approve / comment / request changes** to GitHub from the Deck's review strip. Off by default — this is the only setting that lets Agent Flow write to GitHub. Every submit still asks for confirmation."
},
"agentFlow.reviewRequestPrompt": {
  "type": "string",
  "editPresentation": "multilineText",
  "default": "",
  "markdownDescription": "Prompt seeded when you launch **Review with agent** on a review request. Empty uses the built-in default. Placeholders: `{repo}` `{number}` `{author}` `{key}` `{summary}` `{url}` `{brief}` `{files}`."
}
```

- [ ] **Step 6: Run the tests and commit**

Run: `npx vitest run test/unit/config.test.ts`
Expected: PASS.

```bash
npx tsc --noEmit
git add src/config.ts package.json test/unit/config.test.ts
git commit -m "feat(review): settings for the review strip, its TTL, writes and prompt"
```

---

### Task 7: Deck wiring — fetch, decorate, post

**Files:**
- Modify: `src/types.ts` (message unions, lines 203–264)
- Modify: `src/deckView.ts`
- Test: `test/unit/deckView.test.ts` (append; extend the existing hoisted mock block)

**Interfaces:**
- Consumes: `GhReviewProvider` (Task 4), the store (Task 5), config (Task 6), `sortRequests` (Task 1), `discoverRepos` (`src/engine/repos.ts`), `RefreshQueue` (`src/engine/pr/queue.ts`).
- Produces: outbound `deck:reviews`, inbound `deck:setReviewSort`. `DeckPanel` gains private `reviewSort`, `reviewCache`, `reviewProvider`.

- [ ] **Step 1: Add the messages**

In `src/types.ts`, add to `InboundMessage` after `deck:forget`:

```ts
  | { type: "deck:setReviewSort"; sort: ReviewSort }
```

and to `OutboundMessage` after `deck:loading`:

```ts
  | {
      type: "deck:reviews";
      requests: ReviewRequest[];
      issueCount: number;
      sort: ReviewSort;
      stale: boolean; // the last fetch failed; these are the previous results
    }
```

- [ ] **Step 2: Write the failing test**

Append to `test/unit/deckView.test.ts`. Add to the `vi.hoisted` block:

```ts
  reviewSearch: vi.fn(async () => ({ issueCount: 1, requests: [reviewFixture()] })),
  reviewCache: null as unknown,
  writeReviewCache: vi.fn(),
  repos: [{ name: "aws-ops", path: "/repos/aws-ops", isGit: true }],
  reviewRequests: true as boolean,
```

**Before writing any of these tests, extend the file's existing `getConfig` mock** with every field this slice reads: `reviewRequests: h.reviewRequests`, `reviewRequestsTtlSeconds: 300`, `reviewWrites: false`, `reviewRequestPrompt: "t"`, `reposRoot: "/repos"`, `repoBlocklist: []`, `workspaceDir: "/ws"`, `seedAgent: true`, `stampLabelOnWrite: true`. A missing field reads as `undefined`, which is falsy — the strip would silently never enable and every new test would fail for a reason the assertion does not name.

and the mocks:

```ts
vi.mock("../../src/engine/review/provider", () => ({
  GhReviewProvider: class {
    search = h.reviewSearch;
    detail = vi.fn(async () => null);
  },
}));
vi.mock("../../src/engine/review/store", () => ({
  defaultReviewsFile: () => "/reviews.json",
  readReviewCache: () => h.reviewCache,
  writeReviewCache: h.writeReviewCache,
  isReviewCacheStale: (c: { fetchedAt: number } | null, ttl: number, now: number) => !c || now - c.fetchedAt >= ttl,
}));
vi.mock("../../src/engine/repos", () => ({ discoverRepos: () => h.repos }));
```

Then the tests:

```ts
describe("DeckPanel review strip", () => {
  it("posts the review queue after a search", async () => {
    show();                        // the file's existing helper that opens the panel
    await settle();                // the file's existing flush helper
    const msg = posted().find((m) => m.type === "deck:reviews");
    expect(msg).toMatchObject({ issueCount: 1, sort: "oldest", stale: false });
    expect(msg.requests).toHaveLength(1);
  });

  it("resolves a local checkout for a repo under reposRoot", async () => {
    show();
    await settle();
    const msg = posted().find((m) => m.type === "deck:reviews");
    expect(msg.requests[0].localPath).toBe("/repos/aws-ops");
  });

  it("leaves localPath null for a repo that is not checked out", async () => {
    h.repos = [];
    show();
    await settle();
    expect(posted().find((m) => m.type === "deck:reviews").requests[0].localPath).toBeNull();
  });

  it("keeps the cached queue and flags it stale when the search fails", async () => {
    h.reviewCache = { fetchedAt: 0, issueCount: 4, requests: [reviewFixture()] };
    h.reviewSearch.mockResolvedValueOnce(null);
    show();
    await settle();
    const msg = posted().find((m) => m.type === "deck:reviews");
    expect(msg.stale).toBe(true);
    expect(msg.issueCount).toBe(4);
  });

  it("does not search while the review strip is disabled", async () => {
    h.reviewRequests = false;
    show();
    await settle();
    expect(h.reviewSearch).not.toHaveBeenCalled();
    expect(posted().some((m) => m.type === "deck:reviews")).toBe(false);
  });

  it("does not search while PR facts are off", async () => {
    h.prFacts = false;
    show();
    await settle();
    expect(h.reviewSearch).not.toHaveBeenCalled();
  });

  it("does not search while gh is unusable", async () => {
    h.probeGh.mockResolvedValueOnce({ kind: "missing", detail: "no gh" });
    show();
    await settle();
    expect(h.reviewSearch).not.toHaveBeenCalled();
  });

  it("re-sorts without re-searching when the sort changes", async () => {
    show();
    await settle();
    h.reviewSearch.mockClear();
    await onMessage({ type: "deck:setReviewSort", sort: "smallest" });
    expect(posted().at(-1)).toMatchObject({ type: "deck:reviews", sort: "smallest" });
    expect(h.reviewSearch).not.toHaveBeenCalled();
  });
});
```

Add a `reviewFixture()` helper near the file's other fixtures:

```ts
const reviewFixture = () => ({
  id: "CyberJackGit/aws-ops#8491", repo: "CyberJackGit/aws-ops", repoName: "aws-ops",
  number: 8491, title: "isolate renew queue", url: "https://github.com/CyberJackGit/aws-ops/pull/8491",
  author: "einavsaad", isDraft: false, createdAt: 1, updatedAt: 2,
  additions: 350, deletions: 4, changedFiles: 7,
  ci: "passing" as const, review: "review_required" as const, mergeable: "clean" as const,
  localPath: null, runKey: null, draftPath: null,
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: FAIL — no `deck:reviews` message is ever posted.

- [ ] **Step 4: Implement in `src/deckView.ts`**

Add imports:

```ts
import { discoverRepos } from "./engine/repos";
import { GhReviewProvider, ReviewProvider } from "./engine/review/provider";
import { ReviewCache, defaultReviewsFile, isReviewCacheStale, readReviewCache, writeReviewCache } from "./engine/review/store";
import { sortRequests } from "./engine/review/sort";
```

and to the message-type import: `ReviewRequest, ReviewSort`.

Add fields:

```ts
  private readonly reviewProvider: ReviewProvider = new GhReviewProvider();
  private reviewSort: ReviewSort = "oldest";
  /** Last successful search. Held in memory as well as on disk so a failed fetch
   * can keep rendering it with a stale marker instead of emptying the strip. */
  private reviewCache: ReviewCache | null = null;
  private reviewStale = false;
```

Add the scheduler and the post, called from `refresh()`:

```ts
  /** Is the review strip live? Three independent conditions: the persistent
   * setting, the session PR-facts toggle (same gh dependency, so the same
   * switch), and a usable gh. */
  private reviewsEnabled(): boolean {
    return getConfig().reviewRequests && this.ghReady();
  }

  /** Queue a search when the cache has aged out. Never awaited — a hanging `gh`
   * must not stall the board's git and transcript reads. */
  private enqueueReviews(nowMs: number): void {
    const ttlMs = getConfig().reviewRequestsTtlSeconds * 1000;
    if (this.reviewCache === null) this.reviewCache = readReviewCache(defaultReviewsFile());
    if (!isReviewCacheStale(this.reviewCache, ttlMs, nowMs)) return;
    this.prQueue.push("reviews", async () => {
      const res = await this.reviewProvider.search();
      if (res === null) {
        // Keep whatever we had: an empty strip would read as "you owe nobody a
        // review", which is the opposite of what a failed fetch means.
        this.reviewStale = true;
        this.log("deck: review search failed");
        return;
      }
      this.reviewStale = false;
      this.reviewCache = { fetchedAt: Date.now(), issueCount: res.issueCount, requests: res.requests };
      writeReviewCache(defaultReviewsFile(), this.reviewCache);
    });
  }

  /** Decorate the cached queue with what only this machine can know. Recomputed
   * every post: a checkout can appear, and a worktree can be forgotten. */
  private decorateReviews(requests: ReviewRequest[]): ReviewRequest[] {
    const cfg = getConfig();
    const byName = new Map(discoverRepos(cfg.reposRoot, cfg.repoBlocklist).map((r) => [r.name, r]));
    return requests.map((r) => {
      const local = byName.get(r.repoName);
      return { ...r, localPath: local?.isGit ? local.path : null };
    });
  }

  private postReviews(): void {
    if (!this.reviewsEnabled() || !this.reviewCache) return;
    this.post({
      type: "deck:reviews",
      requests: sortRequests(this.decorateReviews(this.reviewCache.requests), this.reviewSort),
      issueCount: this.reviewCache.issueCount,
      sort: this.reviewSort,
      stale: this.reviewStale,
    });
  }
```

In `refresh()`, after the existing `this.post({ type: "deck:runs", … })` call:

```ts
      if (this.reviewsEnabled()) this.enqueueReviews(Date.now());
      this.postReviews();
```

In `onMessage`, add:

```ts
      case "deck:setReviewSort":
        this.reviewSort = m.sort;
        this.postReviews();
        break;
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 6: Commit**

```bash
npx tsc --noEmit
npx vitest run
git add src/types.ts src/deckView.ts test/unit/deckView.test.ts
git commit -m "feat(review): fetch, cache and post the review queue from the Deck"
```

---

### Task 8: The strip in the webview

**Files:**
- Create: `src/webview/ReviewStrip.tsx`
- Modify: `src/webview/DeckApp.tsx` (state + the stats row at lines 243–248, mount above `.board` at line 268)
- Modify: `src/webview/deckStyles.ts`
- Test: `test/webview/ReviewStrip.test.tsx`

**Interfaces:**
- Consumes: `ReviewRequest`, `ReviewSort` (Task 1); `send` (`src/webview/vscodeApi`); `sizeBucket`, `linesChanged` (Task 1).
- Produces: `ReviewStrip({ requests, issueCount, sort, stale, expanded, details, onToggle, onExpand })` as a named export.

The strip is presentational: `DeckApp` owns the state and the messages, so the strip can be tested without a host.

- [ ] **Step 1: Write the failing test**

Create `test/webview/ReviewStrip.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { ReviewStrip } from "../../src/webview/ReviewStrip";
import type { ReviewRequest } from "../../src/types";

const mk = (over: Partial<ReviewRequest> = {}): ReviewRequest => ({
  id: "CyberJackGit/aws-ops#8491", repo: "CyberJackGit/aws-ops", repoName: "aws-ops",
  number: 8491, title: "isolate renew queue", url: "https://github.com/CyberJackGit/aws-ops/pull/8491",
  author: "einavsaad", isDraft: false, createdAt: Date.now() - 5 * 86_400_000, updatedAt: Date.now(),
  additions: 350, deletions: 4, changedFiles: 7,
  ci: "passing", review: "review_required", mergeable: "clean",
  localPath: "/repos/aws-ops", runKey: null, draftPath: null,
  ...over,
});

const props = (over: Partial<React.ComponentProps<typeof ReviewStrip>> = {}) => ({
  requests: [mk()], issueCount: 1, sort: "oldest" as const, stale: false,
  expanded: null, details: {}, onExpand: vi.fn(), onSort: vi.fn(), onOpen: vi.fn(),
  collapsed: false, onCollapse: vi.fn(),
  ...over,
});

describe("ReviewStrip", () => {
  it("renders nothing when nothing is waiting", () => {
    const { container } = render(<ReviewStrip {...props({ requests: [], issueCount: 0 })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("heads the strip with the count", () => {
    render(<ReviewStrip {...props()} />);
    expect(screen.getByText(/1 PR waiting on your review/i)).toBeInTheDocument();
  });

  it("pluralises the count", () => {
    render(<ReviewStrip {...props({ requests: [mk(), mk({ id: "x#2", number: 2 })], issueCount: 2 })} />);
    expect(screen.getByText(/2 PRs waiting on your review/i)).toBeInTheDocument();
  });

  it("reports truncation when more requests exist than were returned", () => {
    render(<ReviewStrip {...props({ issueCount: 73 })} />);
    expect(screen.getByText(/showing 1 of 73/i)).toBeInTheDocument();
  });

  it("renders repo, number, title, author, size and age", () => {
    render(<ReviewStrip {...props()} />);
    expect(screen.getByText("aws-ops")).toBeInTheDocument();
    expect(screen.getByText("#8491")).toBeInTheDocument();
    expect(screen.getByText("isolate renew queue")).toBeInTheDocument();
    expect(screen.getByText("@einavsaad")).toBeInTheDocument();
    expect(screen.getByText("M")).toBeInTheDocument();       // 354 lines
    expect(screen.getByText("+350")).toBeInTheDocument();
    expect(screen.getByText("−4")).toBeInTheDocument();      // U+2212, as on the cards
    expect(screen.getByText("7 files")).toBeInTheDocument();
    expect(screen.getByText("5d")).toBeInTheDocument();
  });

  it("marks a draft", () => {
    render(<ReviewStrip {...props({ requests: [mk({ isDraft: true })] })} />);
    expect(screen.getByText("draft")).toBeInTheDocument();
  });

  it("marks a stale queue", () => {
    render(<ReviewStrip {...props({ stale: true })} />);
    expect(screen.getByText(/couldn't refresh/i)).toBeInTheDocument();
  });

  it("asks to expand a row on click, once", () => {
    const onExpand = vi.fn();
    render(<ReviewStrip {...props({ onExpand })} />);
    fireEvent.click(screen.getByText("isolate renew queue"));
    expect(onExpand).toHaveBeenCalledWith("CyberJackGit/aws-ops#8491");
  });

  it("shows failing check names once the detail arrives", () => {
    render(<ReviewStrip {...props({
      expanded: "CyberJackGit/aws-ops#8491",
      details: { "CyberJackGit/aws-ops#8491": { failing: [{ name: "e2e", url: "https://ci/e2e" }], unresolved: 2 } },
    })} />);
    expect(screen.getByText("e2e")).toBeInTheDocument();
    expect(screen.getByText(/2 open/)).toBeInTheDocument();
  });

  it("says it is loading the detail before it arrives", () => {
    render(<ReviewStrip {...props({ expanded: "CyberJackGit/aws-ops#8491", details: {} })} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("switches sort", () => {
    const onSort = vi.fn();
    render(<ReviewStrip {...props({ onSort })} />);
    fireEvent.click(screen.getByText("smallest"));
    expect(onSort).toHaveBeenCalledWith("smallest");
  });

  it("opens the PR externally", () => {
    const onOpen = vi.fn();
    render(<ReviewStrip {...props({ expanded: "CyberJackGit/aws-ops#8491", onOpen })} />);
    fireEvent.click(screen.getByText("Open PR"));
    expect(onOpen).toHaveBeenCalledWith("https://github.com/CyberJackGit/aws-ops/pull/8491");
  });

  it("hides the rows while collapsed but keeps the header", () => {
    render(<ReviewStrip {...props({ collapsed: true })} />);
    expect(screen.getByText(/1 PR waiting on your review/i)).toBeInTheDocument();
    expect(screen.queryByText("isolate renew queue")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/webview/ReviewStrip.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the strip**

Create `src/webview/ReviewStrip.tsx`:

```tsx
import * as React from "react";
import { ReviewDetail, ReviewRequest, ReviewSort } from "../types";
import { linesChanged, sizeBucket } from "../engine/review/sort";

function age(ms: number): string {
  const d = Math.max(0, Math.round((Date.now() - ms) / 86_400_000));
  if (d >= 1) return `${d}d`;
  const h = Math.max(1, Math.round((Date.now() - ms) / 3_600_000));
  return `${h}h`;
}

const CI_GLYPH: Record<ReviewRequest["ci"], { text: string; cls: string }> = {
  passing: { text: "✓", cls: "pr-ok" },
  failing: { text: "✗", cls: "pr-bad" },
  pending: { text: "·", cls: "pr-wait" },
  none: { text: "", cls: "" },
};

export interface ReviewStripProps {
  requests: ReviewRequest[];
  issueCount: number;
  sort: ReviewSort;
  stale: boolean;
  collapsed: boolean;
  expanded: string | null;
  details: Record<string, ReviewDetail>;
  onCollapse: (next: boolean) => void;
  onExpand: (id: string) => void;
  onSort: (sort: ReviewSort) => void;
  onOpen: (url: string) => void;
}

function Row({ r, expanded, detail, onExpand, onOpen }: {
  r: ReviewRequest;
  expanded: boolean;
  detail: ReviewDetail | undefined;
  onExpand: (id: string) => void;
  onOpen: (url: string) => void;
}): JSX.Element {
  const ci = CI_GLYPH[r.ci];
  return (
    <div className={`rv-row ${expanded ? "open" : ""}`}>
      {/* A real button, not a div: this is the feature's primary interaction, and
          Open PR plus the check links only exist once a row is expanded — so a div
          here locks a keyboard user out of every row's detail. The board already
          learned this lesson once (9775224). */}
      <button type="button" className="rv-line" onClick={() => onExpand(r.id)}>
        <span className="rv-caret">{expanded ? "▾" : "▸"}</span>
        <span className="rv-repo">{r.repoName}</span>
        <span className="rv-num">#{r.number}</span>
        <span className="rv-title" title={r.title}>{r.title}</span>
        {r.isDraft && <span className="rv-draft">draft</span>}
        <span className={`rv-size s-${sizeBucket(linesChanged(r))}`}>{sizeBucket(linesChanged(r))}</span>
        {/* Three separate text nodes, not one interpolated string: each is then a
            single queryable element, and the +/− keep the card chips' colours. */}
        <span className="add">+{r.additions}</span>
        <span className="del">−{r.deletions}</span>
        <span className="rv-files">{r.changedFiles} files</span>
        <span className={`rv-ci ${ci.cls}`}>{ci.text}</span>
        <span className="rv-author">@{r.author}</span>
        <span className="rv-age">{age(r.createdAt)}</span>
      </button>
      {expanded && (
        <div className="rv-detail">
          {detail ? (
            <div className="rv-facts">
              {detail.failing.length > 0 ? (
                <span className="pr-bad">✗ {detail.failing.map((c, i) => (
                  <React.Fragment key={c.name}>
                    {i > 0 && ", "}
                    {c.url
                      ? <button className="pr-link" title={c.url} onClick={() => onOpen(c.url)}>{c.name}</button>
                      : <span>{c.name}</span>}
                  </React.Fragment>
                ))}</span>
              ) : (
                <span className="pr-ok">✓ checks passing</span>
              )}
              <span className="rv-sep">·</span>
              <span>{r.review === "changes_requested" ? "changes requested" : r.review === "approved" ? "approved" : "review required"}</span>
              {detail.unresolved !== null && detail.unresolved > 0 && (
                <><span className="rv-sep">·</span><span>{detail.unresolved} open</span></>
              )}
              <span className="rv-sep">·</span>
              <span className={r.mergeable === "conflicting" ? "pr-warn" : ""}>
                {r.mergeable === "conflicting" ? "conflicts" : r.mergeable}
              </span>
            </div>
          ) : (
            <div className="rv-facts dim">loading…</div>
          )}
          <div className="rv-actions">
            <button type="button" className="act" onClick={() => onOpen(r.url)}>Open PR</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The queue of PRs waiting on you, above the board. Renders nothing at zero — an
 * empty rail over the columns is noise; the header's "To review" stat carries the
 * zero instead. */
export function ReviewStrip(p: ReviewStripProps): JSX.Element | null {
  if (p.requests.length === 0) return null;
  const shown = p.requests.length;
  return (
    <div className="rv-strip">
      <div className="rv-hd">
        <button type="button" className="rv-toggle" onClick={() => p.onCollapse(!p.collapsed)}>
          {p.collapsed ? "▸" : "▾"} {p.issueCount} {p.issueCount === 1 ? "PR" : "PRs"} waiting on your review
        </button>
        {p.issueCount > shown && <span className="rv-note">showing {shown} of {p.issueCount}</span>}
        {p.stale && <span className="rv-note warn">couldn't refresh — showing the last result</span>}
        <span className="sp" />
        <span className="rv-sort">
          sort:{" "}
          <button type="button" className={p.sort === "oldest" ? "on" : ""} onClick={() => p.onSort("oldest")}>oldest</button>
          <span className="rv-sep">·</span>
          <button type="button" className={p.sort === "smallest" ? "on" : ""} onClick={() => p.onSort("smallest")}>smallest</button>
        </span>
      </div>
      {!p.collapsed && (
        <div className="rv-rows">
          {p.requests.map((r) => (
            <Row key={r.id} r={r} expanded={p.expanded === r.id} detail={p.details[r.id]}
                 onExpand={p.onExpand} onOpen={p.onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Add the styles**

Append to `src/webview/deckStyles.ts`, inside the exported `DECK_CSS` string, after the `.pr-*` block. Every value below comes from the token set — re-read the Global Constraints' design-system rules before changing any of it.

```css
  /* The review queue: what other people are waiting on you for, above the board of
     what you are waiting on yourself. Inside the board's own 20px gutter, and
     flex: none so it never steals height from .board, which is the scrollport. */
  .rv-strip { flex: none; margin: 0 20px 10px; border: 1px solid var(--hair);
    border-radius: var(--r-card); overflow: hidden; }
  .rv-hd { display: flex; align-items: center; gap: 10px; padding: 7px 12px;
    font-size: var(--t-body); color: var(--dim); }
  .rv-toggle { display: inline-flex; align-items: center; gap: 6px; border: 0; background: none;
    padding: 0; cursor: pointer; font-size: var(--t-body); font-weight: 550;
    color: var(--vscode-foreground); }
  .rv-hd .sp { flex: 1; }
  .rv-sort { display: inline-flex; align-items: center; gap: 5px; }
  .rv-sort button { border: 0; background: none; padding: 0; cursor: pointer;
    font-size: var(--t-body); color: var(--dim); }
  .rv-sort button.on { color: var(--vscode-foreground); text-decoration: underline; text-underline-offset: 2px; }
  /* A queue we could not refresh is stale, not broken — attn, never danger. */
  .rv-note.warn { color: var(--c-attn); }

  .rv-rows { border-top: 1px solid var(--hair); }
  .rv-row + .rv-row { border-top: 1px solid var(--hair); }
  /* A button, so reset the button chrome and let it fill the row. outline-offset is
     negative because .rv-strip clips overflow — a ring drawn outside would vanish. */
  .rv-line { display: flex; align-items: baseline; gap: 8px; padding: 6px 12px; cursor: pointer;
    font-size: var(--t-body); font-variant-numeric: tabular-nums;
    width: 100%; text-align: left; background: none; border: 0; color: inherit; font-family: inherit;
    outline-offset: -2px; }
  .rv-line:hover { background: var(--vscode-list-hoverBackground, var(--vscode-toolbar-hoverBackground)); }
  .rv-caret { flex: none; width: 9px; color: var(--dim); }
  /* Identifiers and counts — the only mono on the row. The title and the handle
     beside them are English, and stay in the UI font. */
  /* flex: none + nowrap so a long title absorbs the squeeze through its own ellipsis
     rather than these badges wrapping to a second line in a narrow panel. */
  .rv-repo, .rv-num, .rv-size, .rv-line .add, .rv-line .del {
    font-family: var(--mono); font-size: var(--t-data); flex: none; white-space: nowrap; }
  .rv-repo, .rv-num { color: var(--dim); }
  .rv-size { font-weight: 600; color: var(--dim); }
  .rv-line .add { color: var(--c-done); }
  .rv-line .del { color: var(--c-danger); }
  .rv-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--vscode-foreground); }
  .rv-draft { flex: none; font-size: var(--t-micro); color: var(--dim);
    border: 1px solid var(--hair); border-radius: var(--r-chip); padding: 0 4px; }
  .rv-files, .rv-author, .rv-age { flex: none; color: var(--dim); }
  .rv-running { flex: none; color: var(--c-progress); }

  .rv-detail { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 8px;
    padding: 2px 12px 9px 29px; font-size: var(--t-body); }
  .rv-facts { flex-basis: 100%; display: flex; align-items: baseline; gap: 6px; color: var(--dim); }
  .rv-facts.dim { font-style: italic; }
  .rv-sep { color: var(--dim); }
  .rv-actions { margin-left: auto; flex: none; display: flex; align-items: center; gap: 5px; }
  /* .act dims to .7 unless it sits in a hovered .card. A row is not a card, so the
     rule never re-brightens and every button here would render permanently faded. */
  .rv-actions .act { opacity: 1; }

  .rv-box { flex: 1; min-width: 0; }
  .rv-box textarea { width: 100%; min-height: 46px; resize: vertical; font: inherit;
    font-size: var(--t-body); color: var(--vscode-input-foreground);
    background: var(--vscode-input-background); border: 1px solid var(--edge);
    border-radius: var(--r-ctl); padding: 5px 7px; }
```

- [ ] **Step 5: Run the strip tests**

Run: `npx vitest run test/webview/ReviewStrip.test.tsx`
Expected: PASS, 14 tests.

- [ ] **Step 6: Mount it in `DeckApp`**

In `src/webview/DeckApp.tsx`, add state:

```tsx
  const [reviews, setReviews] = React.useState<{ requests: ReviewRequest[]; issueCount: number; sort: ReviewSort; stale: boolean }>(
    { requests: [], issueCount: 0, sort: "oldest", stale: false },
  );
  const [reviewsCollapsed, setReviewsCollapsed] = React.useState(false);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [details, setDetails] = React.useState<Record<string, ReviewDetail>>({});
```

Handle the message in the existing `handler`:

```tsx
      } else if (m.type === "deck:reviews") {
        // Collapse a long queue on arrival, once: nine rows would push the board
        // off-screen, and the user's later choice must survive every refresh after.
        // A ref rather than reading state: this fires inside a message handler
        // registered once, and a setState called from inside another setState's
        // updater runs twice under StrictMode.
        setReviewsSeen(true);
        if (!seededCollapse.current && m.requests.length > 0) {
          seededCollapse.current = true;
          if (m.requests.length > 5) setReviewsCollapsed(true);
        }
        setReviews({ requests: m.requests, issueCount: m.issueCount, sort: m.sort, stale: m.stale });
      }
```

The ref sits with the other state declarations:

```tsx
  /** Has a queue ever arrived? Gates the one-time collapse. */
  const seededCollapse = React.useRef(false);
  /** Has the host ever posted a queue? That is the webview's only signal that the
   * feature is on: `postReviews` stays silent when the setting is off or `gh` is
   * unusable, but posts `requests: []` when it is on and you owe nobody a review.
   * The stat needs the difference — "0 To review" is information, a missing tile is
   * not — while the strip itself only appears once there is a row to show. */
  const [reviewsSeen, setReviewsSeen] = React.useState(false);
```

Add the stat, after the "In review" stat. It keys off `reviewsSeen`, **not** the count — a zero here means "you owe nobody a review", which is worth stating; a missing tile would instead read as "this feature isn't running":

```tsx
          {reviewsSeen && (
            <div className="stat"><span className="n">{reviews.issueCount}</span><span className="l">To review</span></div>
          )}
```

Render the strip directly above the `runs.length === 0 ? … : <div className="board">` block:

```tsx
      <ReviewStrip
        requests={reviews.requests}
        issueCount={reviews.issueCount}
        sort={reviews.sort}
        stale={reviews.stale}
        collapsed={reviewsCollapsed}
        expanded={expanded}
        details={details}
        onCollapse={setReviewsCollapsed}
        onSort={(sort) => { setReviews((r) => ({ ...r, sort })); send({ type: "deck:setReviewSort", sort }); }}
        onExpand={(id) => setExpanded((cur) => (cur === id ? null : id))}
        onOpen={(url) => send({ type: "openExternal", url })}
      />
```

`details` stays empty until Task 9 wires the fetch; the strip already renders "loading…" for that case.

- [ ] **Step 7: Add DeckApp coverage**

Append to `test/webview/DeckApp.test.tsx`:

```tsx
const reviewsMsg = (requests: ReviewRequest[], issueCount = requests.length): OutboundMessage =>
  ({ type: "deck:reviews", requests, issueCount, sort: "oldest", stale: false });

const mkReview = (over: Partial<ReviewRequest> = {}): ReviewRequest => ({
  id: "o/r#1", repo: "o/r", repoName: "r", number: 1, title: "a small fix", url: "https://gh/o/r/pull/1",
  author: "dana", isDraft: false, createdAt: Date.now() - 3_600_000, updatedAt: Date.now(),
  additions: 10, deletions: 2, changedFiles: 1,
  ci: "passing", review: "review_required", mergeable: "clean",
  localPath: null, runKey: null, draftPath: null, ...over,
});

describe("DeckApp review strip", () => {
  it("shows no To review stat until the host posts a queue", () => {
    render(<DeckApp />);
    expect(screen.queryByText("To review")).not.toBeInTheDocument();
    host(reviewsMsg([mkReview()]));
    expect(screen.getByText("To review")).toBeInTheDocument();
  });

  // The strip and the stat part company here, deliberately: an empty rail above the
  // board is noise, but a "0" tile is the only thing telling you the feature is alive.
  it("keeps the To review stat at zero, while the strip itself disappears", () => {
    render(<DeckApp />);
    host(reviewsMsg([], 0));
    expect(screen.getByText("To review")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.queryByText(/waiting on your review/i)).not.toBeInTheDocument();
  });

  it("renders the strip above the board", () => {
    render(<DeckApp />);
    host(reviewsMsg([mkReview()]));
    expect(screen.getByText("a small fix")).toBeInTheDocument();
  });

  it("sends the new sort to the host", () => {
    render(<DeckApp />);
    host(reviewsMsg([mkReview()]));
    fireEvent.click(screen.getByText("smallest"));
    expect(sent).toHaveBeenCalledWith({ type: "deck:setReviewSort", sort: "smallest" });
  });

  it("starts a queue of more than five collapsed", () => {
    render(<DeckApp />);
    host(reviewsMsg(Array.from({ length: 6 }, (_, i) => mkReview({ id: `o/r#${i}`, number: i, title: `pr ${i}` }))));
    expect(screen.queryByText("pr 0")).not.toBeInTheDocument();
    expect(screen.getByText(/6 PRs waiting on your review/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 8: Run everything and commit**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS.

```bash
git add src/webview/ReviewStrip.tsx src/webview/DeckApp.tsx src/webview/deckStyles.ts \
        test/webview/ReviewStrip.test.tsx test/webview/DeckApp.test.tsx
git commit -m "feat(review): the review-requests strip above the Deck's columns"
```

---

### Task 9: Row expansion fetches its detail

**Files:**
- Modify: `src/types.ts` (two messages)
- Modify: `src/deckView.ts` (`onMessage`)
- Modify: `src/webview/DeckApp.tsx` (`onExpand`, detail message)
- Test: `test/unit/deckView.test.ts`, `test/webview/DeckApp.test.tsx` (append)

**Interfaces:**
- Produces: inbound `{ type: "deck:reviewExpand"; id: string }`; outbound `{ type: "deck:reviewDetail"; id: string; detail: ReviewDetail }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/deckView.test.ts`:

```ts
describe("DeckPanel review detail", () => {
  it("fetches a row's detail and posts it", async () => {
    show();
    await settle();
    await onMessage({ type: "deck:reviewExpand", id: "CyberJackGit/aws-ops#8491" });
    expect(posted().at(-1)).toMatchObject({
      type: "deck:reviewDetail",
      id: "CyberJackGit/aws-ops#8491",
      detail: { failing: [], unresolved: null },
    });
  });

  it("ignores an id that is not in the queue", async () => {
    show();
    await settle();
    const before = posted().length;
    await onMessage({ type: "deck:reviewExpand", id: "who/what#1" });
    expect(posted()).toHaveLength(before);
  });

  it("posts nothing when the detail fetch fails", async () => {
    h.reviewDetail.mockResolvedValueOnce(null);
    show();
    await settle();
    const before = posted().length;
    await onMessage({ type: "deck:reviewExpand", id: "CyberJackGit/aws-ops#8491" });
    expect(posted().filter((m) => m.type === "deck:reviewDetail")).toHaveLength(0);
    expect(posted().length).toBe(before);
  });
});
```

Adjust the hoisted provider mock so `detail` is a controllable `h.reviewDetail` returning `{ failing: [], unresolved: null }` by default, and have the failure test override it with `mockResolvedValueOnce(null)`.

Append to `test/webview/DeckApp.test.tsx`:

```tsx
  it("asks the host for a row's detail on expand, and renders it", () => {
    render(<DeckApp />);
    host(reviewsMsg([mkReview()]));
    fireEvent.click(screen.getByText("a small fix"));
    expect(sent).toHaveBeenCalledWith({ type: "deck:reviewExpand", id: "o/r#1" });
    host({ type: "deck:reviewDetail", id: "o/r#1", detail: { failing: [{ name: "e2e", url: "" }], unresolved: 0 } });
    expect(screen.getByText("e2e")).toBeInTheDocument();
  });

  it("does not re-ask for a detail it already has", () => {
    render(<DeckApp />);
    host(reviewsMsg([mkReview()]));
    fireEvent.click(screen.getByText("a small fix"));
    host({ type: "deck:reviewDetail", id: "o/r#1", detail: { failing: [], unresolved: null } });
    fireEvent.click(screen.getByText("a small fix")); // collapse
    sent.mockClear();
    fireEvent.click(screen.getByText("a small fix")); // expand again
    expect(sent).not.toHaveBeenCalledWith({ type: "deck:reviewExpand", id: "o/r#1" });
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run test/unit/deckView.test.ts test/webview/DeckApp.test.tsx`
Expected: FAIL on the new cases.

- [ ] **Step 3: Add the messages to `src/types.ts`**

Inbound: `| { type: "deck:reviewExpand"; id: string }`
Outbound: `| { type: "deck:reviewDetail"; id: string; detail: ReviewDetail }`

- [ ] **Step 4: Handle it in `src/deckView.ts`**

```ts
      case "deck:reviewExpand":
        await this.reviewDetail(m.id);
        break;
```

and the method:

```ts
  /** Fetch the two facts the search cannot return. Silent on failure: the row
   * keeps its search-level detail, which is still useful, and a toast per
   * expanded row would be worse than the gap. */
  private async reviewDetail(id: string): Promise<void> {
    const req = this.reviewCache?.requests.find((r) => r.id === id);
    if (!req) return;
    const detail = await this.reviewProvider.detail(req.repo, req.number);
    if (!detail) {
      this.log(`deck: review detail ${id} failed`);
      return;
    }
    this.post({ type: "deck:reviewDetail", id, detail });
  }
```

- [ ] **Step 5: Wire the webview**

In `DeckApp.tsx`, replace `onExpand` with:

```tsx
        onExpand={(id) => {
          setExpanded((cur) => (cur === id ? null : id));
          // Once per session per row: the strip re-renders constantly (the 1s
          // clock tick), and a fetch on every render would spawn a gh call a second.
          if (!details[id]) send({ type: "deck:reviewExpand", id });
        }}
```

and handle the reply in the message handler:

```tsx
      } else if (m.type === "deck:reviewDetail") {
        setDetails((d) => ({ ...d, [m.id]: m.detail }));
      }
```

- [ ] **Step 6: Run and commit**

Run: `npx vitest run && npx tsc --noEmit`

```bash
git add src/types.ts src/deckView.ts src/webview/DeckApp.tsx test/unit/deckView.test.ts test/webview/DeckApp.test.tsx
git commit -m "feat(review): expand a row to fetch its failing checks and open threads"
```

- [ ] **Step 7: Coverage gate for Slice 1**

Run: `npx vitest run --coverage`
Expected: all four thresholds still met. If `src/webview/ReviewStrip.tsx` drags branches below 85, add the missing row-state cases to `ReviewStrip.test.tsx` — do not add the file to the coverage `exclude` list.

---

## Slice 2 — The Review agent

### Task 10: `Run.kind`

**Files:**
- Modify: `src/types.ts` (`Run`, `isTicketRun` at lines 61–79)
- Modify: `src/engine/workspace.ts` (`OpenRequest` line 36, the `Run` literal at line 249)
- Modify: `src/deckView.ts` (`buildAll` — exclude review runs from the columns)
- Test: `test/unit/types.test.ts`, `test/unit/engine/workspace.test.ts`, `test/unit/deckView.test.ts` (append)

**Interfaces:**
- Produces: `Run.kind?: "task" | "explore" | "review"`, `runKind(run: Run): "task" | "explore" | "review"`, `OpenRequest.kind?`.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/types.test.ts`:

```ts
import { runKind, isTicketRun } from "../../src/types";
import type { Run } from "../../src/types";

const run = (over: Partial<Run> = {}): Run => ({
  key: "ASM-1", summary: "s", url: "https://jira/ASM-1", createdAt: 1,
  mode: "per-window", repos: [], briefPaths: [], ...over,
});

describe("runKind", () => {
  it("treats a record with no kind as a task — every run written before this change", () => {
    expect(runKind(run())).toBe("task");
  });

  it("reads an explicit kind", () => {
    expect(runKind(run({ kind: "review" }))).toBe("review");
    expect(runKind(run({ kind: "explore" }))).toBe("explore");
  });

  it("falls back to task for a hand-edited nonsense kind", () => {
    expect(runKind(run({ kind: "banana" as unknown as Run["kind"] }))).toBe("task");
  });
});

describe("isTicketRun with kinds", () => {
  it("still recognises a plain ticket run", () => {
    expect(isTicketRun(run())).toBe(true);
  });

  it("still rejects an explore run, which has no ticket url", () => {
    expect(isTicketRun(run({ url: "" }))).toBe(false);
  });

  it("rejects a review run even though its url is a real PR", () => {
    expect(isTicketRun(run({ kind: "review", url: "https://github.com/o/r/pull/1" }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/unit/types.test.ts`
Expected: FAIL — `runKind` is not exported.

- [ ] **Step 3: Implement in `src/types.ts`**

Add to `Run`, after `createdAt`:

```ts
  /** What launched this run. Absent means "task" — every record written before
   * review runs existed. Review runs carry a PR url rather than a Jira one, so
   * this, not the url, is what keeps them out of Jira polling and the columns. */
  kind?: "task" | "explore" | "review";
```

Add above `isTicketRun` and rewrite it:

```ts
const RUN_KINDS = new Set(["task", "explore", "review"]);

/** A run's kind, tolerant of an old record with no field and of a hand-edited
 * one with a value we don't know. */
export function runKind(run: Run): "task" | "explore" | "review" {
  return RUN_KINDS.has(run.kind as string) ? (run.kind as "task" | "explore" | "review") : "task";
}

/** Is this run attached to a Jira ticket? An Explore session is launched with a
 * synthetic `explore-<slug>` key and no ticket url: there is no Jira issue to
 * poll, and `gh pr list --head <default-branch>` can only return a pull request
 * belonging to somebody else. A **review** run is excluded for the opposite
 * reason — it has a url, but it is a PR's, and polling Jira for
 * `review-centaur-850` would 404 every 30 seconds forever. Tolerates an older or
 * hand-edited record with no url field at all. */
export function isTicketRun(run: Run): boolean {
  if (runKind(run) === "review") return false;
  return typeof run.url === "string" && run.url.trim().length > 0;
}
```

- [ ] **Step 4: Carry the kind through `openWorkspace`**

In `src/engine/workspace.ts`, add to `OpenRequest`:

```ts
  kind?: Run["kind"]; // what launched this run; omitted means a task
```

and to the `Run` literal, after `createdAt: Date.now(),`:

```ts
    kind: req.kind,
```

- [ ] **Step 5: Keep review runs out of the columns**

In `src/deckView.ts`'s `buildAll`, change the first line from
`const runs = readRuns(defaultRunsDir());` to:

```ts
    // Review runs are work in flight, but not *your ticket's* work: they surface
    // on their strip row, not as a fifth kind of card in In progress.
    const runs = readRuns(defaultRunsDir()).filter((r) => runKind(r) !== "review");
```

and add `runKind` to the import from `./types`.

- [ ] **Step 6: Add the Deck and workspace tests**

Append to `test/unit/deckView.test.ts`:

```ts
  it("keeps review runs off the board", async () => {
    h.runs = [
      { key: "ASM-1", summary: "s", url: "https://jira/ASM-1", createdAt: 2, mode: "per-window", repos: [], briefPaths: [] },
      { key: "review-aws-ops-8491", summary: "review", url: "https://gh/pr/8491", createdAt: 1, kind: "review", mode: "per-window", repos: [], briefPaths: [] },
    ];
    show();
    await settle();
    const msg = posted().find((m) => m.type === "deck:runs");
    expect(msg.runs).toHaveLength(1);
  });
```

Append to `test/unit/engine/workspace.test.ts`, matching how that file already asserts on the written run record:

```ts
  it("stamps the run's kind when one is given", async () => {
    await openWorkspace({ ...baseRequest(), kind: "review" });
    expect(writtenRun().kind).toBe("review");
  });

  it("leaves the kind absent for a plain take", async () => {
    await openWorkspace(baseRequest());
    expect(writtenRun().kind).toBeUndefined();
  });
```

- [ ] **Step 7: Run and commit**

Run: `npx vitest run && npx tsc --noEmit`

```bash
git add src/types.ts src/engine/workspace.ts src/deckView.ts \
        test/unit/types.test.ts test/unit/engine/workspace.test.ts test/unit/deckView.test.ts
git commit -m "feat(review): a run kind, so review runs stay off the board and out of Jira"
```

---

### Task 11: Launching the review agent

**Files:**
- Create: `src/engine/review/launch.ts`
- Test: `test/unit/engine/review/launch.test.ts`

**Interfaces:**
- Consumes: `createWorktrees` (`src/engine/worktree.ts`), `openWorkspace` (`src/engine/workspace.ts`), `getConfig` (`src/config.ts`).
- Produces: `reviewRunKey(repoName: string, number: number): string`, `renderReviewTemplate(template: string, v: { repo: string; number: number; author: string }): string`, `launchReview(req, deps): Promise<{ ok: true; runKey: string } | { ok: false; message: string }>`.

`launchReview` takes its side effects as injected deps so it is testable without VS Code.

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine/review/launch.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { reviewRunKey, renderReviewTemplate, launchReview } from "../../../../src/engine/review/launch";
import type { ReviewRequest } from "../../../../src/types";

const req: ReviewRequest = {
  id: "CyberJackGit/aws-ops#8491", repo: "CyberJackGit/aws-ops", repoName: "aws-ops",
  number: 8491, title: "isolate renew queue", url: "https://github.com/CyberJackGit/aws-ops/pull/8491",
  author: "einavsaad", isDraft: false, createdAt: 1, updatedAt: 2,
  additions: 350, deletions: 4, changedFiles: 7,
  ci: "passing", review: "review_required", mergeable: "clean",
  localPath: "/repos/aws-ops", runKey: null, draftPath: null,
};

const deps = (over = {}) => ({
  createWorktrees: vi.fn((services) => services.map((s: { name: string; path: string }) => ({ ...s, path: `${s.path}/.claude/worktrees/review-aws-ops-8491` }))),
  openWorkspace: vi.fn(async () => ({ mode: "per-window", briefs: [], opened: ["/w"], remoteControl: false })),
  log: vi.fn(),
  ...over,
});

describe("reviewRunKey", () => {
  it("is a filesystem-safe synthetic key", () => {
    expect(reviewRunKey("aws-ops", 8491)).toBe("review-aws-ops-8491");
  });

  it("strips characters that cannot be a directory name", () => {
    expect(reviewRunKey("weird/name repo", 7)).toBe("review-weird-name-repo-7");
  });
});

describe("renderReviewTemplate", () => {
  it("substitutes the review-only placeholders and leaves the rest alone", () => {
    const out = renderReviewTemplate(
      "Review {url} — {repo}#{number} by {author}; {summary} stays for renderPrompt.{files}",
      { repo: "o/r", number: 12, author: "dana" },
    );
    expect(out).toBe("Review {url} — o/r#12 by dana; {summary} stays for renderPrompt.{files}");
  });

  it("substitutes every occurrence", () => {
    expect(renderReviewTemplate("{number} {number}", { repo: "o/r", number: 3, author: "a" })).toBe("3 3");
  });
});

describe("launchReview", () => {
  it("refuses a request with no local checkout", async () => {
    const d = deps();
    const out = await launchReview({ req: { ...req, localPath: null }, template: "t", workspaceDir: "/ws", seedAgent: true }, d);
    expect(out).toEqual({ ok: false, message: "aws-ops isn't checked out under your repos root — open the PR on GitHub instead." });
    expect(d.createWorktrees).not.toHaveBeenCalled();
  });

  it("creates a worktree keyed to the PR", async () => {
    const d = deps();
    await launchReview({ req, template: "t", workspaceDir: "/ws", seedAgent: true }, d);
    expect(d.createWorktrees).toHaveBeenCalledWith(
      [{ name: "aws-ops", path: "/repos/aws-ops", isGit: true }],
      "review-aws-ops-8491",
      "Review aws-ops#8491: isolate renew queue",
      d.log,
    );
  });

  it("opens the worktree as a review run with the PR as its url", async () => {
    const d = deps();
    const out = await launchReview({ req, template: "Review {repo}#{number}", workspaceDir: "/ws", seedAgent: true }, d);
    expect(out).toEqual({ ok: true, runKey: "review-aws-ops-8491" });
    const arg = d.openWorkspace.mock.calls[0][0];
    expect(arg.kind).toBe("review");
    expect(arg.ticket).toEqual({
      key: "review-aws-ops-8491",
      summary: "Review aws-ops#8491: isolate renew queue",
      url: "https://github.com/CyberJackGit/aws-ops/pull/8491",
    });
    expect(arg.promptTemplate).toBe("Review CyberJackGit/aws-ops#8491");
    expect(arg.mode).toBe("per-window");
  });

  it("reports a failure from openWorkspace rather than throwing", async () => {
    const d = deps({ openWorkspace: vi.fn(async () => { throw new Error("disk full"); }) });
    const out = await launchReview({ req, template: "t", workspaceDir: "/ws", seedAgent: true }, d);
    expect(out).toEqual({ ok: false, message: "Couldn't open a review worktree for aws-ops#8491: Error: disk full" });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/unit/engine/review/launch.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/engine/review/launch.ts`:

```ts
import { ReviewRequest, ServiceRef } from "../../types";
import type { OpenRequest, OpenResult } from "../workspace";

/** A review's synthetic run key, and therefore its worktree directory name under
 * `<repo>/.claude/worktrees/`. Mirrors `explore-<slug>`: not a Jira key, and never
 * mistaken for one. */
export function reviewRunKey(repoName: string, number: number): string {
  const slug = repoName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `review-${slug}-${number}`;
}

/** Fill the review-only placeholders. `renderPrompt` handles {key} {summary}
 * {url} {brief} {files} later, inside openWorkspace — doing these here keeps
 * the shared prompt renderer unaware of a concept only this flow has. */
export function renderReviewTemplate(
  template: string,
  v: { repo: string; number: number; author: string },
): string {
  return template
    .replace(/\{repo\}/g, v.repo)
    .replace(/\{number\}/g, String(v.number))
    .replace(/\{author\}/g, v.author);
}

export interface LaunchReviewRequest {
  req: ReviewRequest;
  template: string;
  workspaceDir: string;
  seedAgent: boolean;
}

export interface LaunchReviewDeps {
  createWorktrees: (services: ServiceRef[], key: string, summary: string, log: (m: string) => void) => ServiceRef[];
  openWorkspace: (req: OpenRequest) => Promise<OpenResult>;
  log: (m: string) => void;
}

/** Open a teammate's PR in its own worktree with a review agent seeded. Always a
 * worktree and always one window: a review is a side errand, and it must not
 * disturb whatever the main checkout is in the middle of. */
export async function launchReview(
  { req, template, workspaceDir, seedAgent }: LaunchReviewRequest,
  deps: LaunchReviewDeps,
): Promise<{ ok: true; runKey: string } | { ok: false; message: string }> {
  if (!req.localPath) {
    return { ok: false, message: `${req.repoName} isn't checked out under your repos root — open the PR on GitHub instead.` };
  }
  const key = reviewRunKey(req.repoName, req.number);
  const summary = `Review ${req.repoName}#${req.number}: ${req.title}`;
  const base: ServiceRef = { name: req.repoName, path: req.localPath, isGit: true };
  const services = deps.createWorktrees([base], key, summary, deps.log);
  try {
    await deps.openWorkspace({
      ticket: { key, summary, url: req.url },
      kind: "review",
      planMd: `## Review: ${req.repo}#${req.number}\n\n${req.title}\n\nOpened by @${req.author}. ${req.url}`,
      descriptionText: "",
      services,
      mode: "per-window",
      promptTemplate: renderReviewTemplate(template, { repo: req.repo, number: req.number, author: req.author }),
      workspaceDir,
      seedAgent,
    });
  } catch (e) {
    return { ok: false, message: `Couldn't open a review worktree for ${req.repoName}#${req.number}: ${e}` };
  }
  return { ok: true, runKey: key };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/unit/engine/review/launch.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
npx tsc --noEmit
git add src/engine/review/launch.ts test/unit/engine/review/launch.test.ts
git commit -m "feat(review): launch a review agent into a worktree for a teammate's PR"
```

---

### Task 12: Wire the launch button and the draft handoff

**Files:**
- Modify: `src/types.ts` (two inbound messages)
- Modify: `src/deckView.ts` (handler, `decorateReviews`)
- Modify: `src/webview/ReviewStrip.tsx` (the button, the run state, Load)
- Test: `test/unit/deckView.test.ts`, `test/webview/ReviewStrip.test.tsx` (append)

**Interfaces:**
- Produces: inbound `{ type: "deck:reviewLaunch"; id: string }` and `{ type: "deck:reviewLoadDraft"; id: string }`; outbound reuse of `deck:reviewDraft` → add `{ type: "deck:reviewDraft"; id: string; body: string }`.
- `ReviewStrip` props gain `onLaunch: (id: string) => void` and `onLoadDraft: (id: string) => void`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/deckView.test.ts`:

```ts
describe("DeckPanel review launch", () => {
  it("launches a review and toasts", async () => {
    h.repos = [{ name: "aws-ops", path: "/repos/aws-ops", isGit: true }];
    show();
    await settle();
    await onMessage({ type: "deck:reviewLaunch", id: "CyberJackGit/aws-ops#8491" });
    expect(h.launchReview).toHaveBeenCalled();
    expect(posted().some((m) => m.type === "toast" && m.level === "success")).toBe(true);
  });

  it("toasts the reason when a launch is refused", async () => {
    h.launchReview.mockResolvedValueOnce({ ok: false, message: "no checkout" });
    show();
    await settle();
    await onMessage({ type: "deck:reviewLaunch", id: "CyberJackGit/aws-ops#8491" });
    expect(posted().some((m) => m.type === "toast" && m.level === "error" && m.message === "no checkout")).toBe(true);
  });

  it("ignores a launch for an id that is not in the queue", async () => {
    show();
    await settle();
    await onMessage({ type: "deck:reviewLaunch", id: "who/what#1" });
    expect(h.launchReview).not.toHaveBeenCalled();
  });

  it("reports a review run and its draft file on the row", async () => {
    h.runs = [{
      key: "review-aws-ops-8491", summary: "Review", url: "https://gh/pr/8491", createdAt: 1, kind: "review",
      mode: "per-window", repos: [{ name: "aws-ops", path: "/repos/aws-ops/.claude/worktrees/review-aws-ops-8491", isGit: true }],
      briefPaths: [],
    }];
    h.existsSync = vi.fn(() => true);
    show();
    await settle();
    const row = posted().find((m) => m.type === "deck:reviews").requests[0];
    expect(row.runKey).toBe("review-aws-ops-8491");
    expect(row.draftPath).toBe("/repos/aws-ops/.claude/worktrees/review-aws-ops-8491/.pick-task/REVIEW-8491.md");
  });

  it("posts the draft body when asked to load it", async () => {
    h.runs = [{
      key: "review-aws-ops-8491", summary: "Review", url: "https://gh/pr/8491", createdAt: 1, kind: "review",
      mode: "per-window", repos: [{ name: "aws-ops", path: "/wt", isGit: true }], briefPaths: [],
    }];
    h.existsSync = vi.fn(() => true);
    h.readFileSync = vi.fn(() => "1. The retry budget is unbounded.");
    show();
    await settle();
    await onMessage({ type: "deck:reviewLoadDraft", id: "CyberJackGit/aws-ops#8491" });
    expect(posted().at(-1)).toMatchObject({
      type: "deck:reviewDraft",
      id: "CyberJackGit/aws-ops#8491",
      body: "1. The retry budget is unbounded.",
    });
  });
});
```

Add `launchReview: vi.fn(async () => ({ ok: true, runKey: "review-aws-ops-8491" }))`, `existsSync: vi.fn(() => false)` and `readFileSync: vi.fn(() => "")` to the hoisted block, and mock `../../src/engine/review/launch`.

`fs` needs a **partial** mock — `deckView.ts` and everything it pulls in use far more of it than these two functions, and a bare `vi.mock("fs")` would blank the rest:

```ts
vi.mock("fs", async (importActual) => {
  const actual = await importActual<typeof import("fs")>();
  return { ...actual, existsSync: (p: string) => h.existsSync(p), readFileSync: (p: string, e: string) => h.readFileSync(p, e) };
});
```

Append to `test/webview/ReviewStrip.test.tsx`:

```tsx
  it("offers Review with agent when the repo is checked out", () => {
    const onLaunch = vi.fn();
    render(<ReviewStrip {...props({ expanded: "CyberJackGit/aws-ops#8491", onLaunch })} />);
    fireEvent.click(screen.getByText(/Review with agent/i));
    expect(onLaunch).toHaveBeenCalledWith("CyberJackGit/aws-ops#8491");
  });

  it("disables the agent action with a reason when the repo is not checked out", () => {
    render(<ReviewStrip {...props({
      expanded: "CyberJackGit/aws-ops#8491",
      requests: [mk({ localPath: null })],
    })} />);
    const btn = screen.getByText(/Review with agent/i) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toMatch(/not checked out/i);
  });

  it("says a review is already running", () => {
    render(<ReviewStrip {...props({ requests: [mk({ runKey: "review-aws-ops-8491" })] })} />);
    expect(screen.getByText(/reviewing/i)).toBeInTheDocument();
  });

  it("offers to load the agent's draft only once the file exists", () => {
    const onLoadDraft = vi.fn();
    render(<ReviewStrip {...props({ expanded: "CyberJackGit/aws-ops#8491", onLoadDraft })} />);
    expect(screen.queryByText(/Load agent's review/i)).not.toBeInTheDocument();
    render(<ReviewStrip {...props({
      expanded: "CyberJackGit/aws-ops#8491", onLoadDraft,
      requests: [mk({ draftPath: "/wt/.pick-task/REVIEW-8491.md" })],
    })} />);
    fireEvent.click(screen.getByText(/Load agent's review/i));
    expect(onLoadDraft).toHaveBeenCalledWith("CyberJackGit/aws-ops#8491");
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run test/unit/deckView.test.ts test/webview/ReviewStrip.test.tsx`
Expected: FAIL on the new cases.

- [ ] **Step 3: Add the messages**

Inbound: `| { type: "deck:reviewLaunch"; id: string } | { type: "deck:reviewLoadDraft"; id: string }`
Outbound: `| { type: "deck:reviewDraft"; id: string; body: string }`

- [ ] **Step 4: Implement in `src/deckView.ts`**

Add imports for `fs`, `createWorktrees`, `openWorkspace`, `launchReview`, `reviewRunKey`, and `BRIEF_DIR`.

Extend `decorateReviews` to resolve the run and the draft:

```ts
  private decorateReviews(requests: ReviewRequest[]): ReviewRequest[] {
    const cfg = getConfig();
    const byName = new Map(discoverRepos(cfg.reposRoot, cfg.repoBlocklist).map((r) => [r.name, r]));
    const reviewRuns = new Map(
      readRuns(defaultRunsDir()).filter((r) => runKind(r) === "review").map((r) => [r.key, r]),
    );
    return requests.map((r) => {
      const local = byName.get(r.repoName);
      const run = reviewRuns.get(reviewRunKey(r.repoName, r.number));
      // The draft lives in the worktree the agent was launched into, not the main
      // checkout — that is the only place the agent could have written it.
      const wt = run?.repos[0]?.path;
      const draft = wt ? path.join(wt, BRIEF_DIR, `REVIEW-${r.number}.md`) : null;
      return {
        ...r,
        localPath: local?.isGit ? local.path : null,
        runKey: run?.key ?? null,
        draftPath: draft && fs.existsSync(draft) ? draft : null,
      };
    });
  }
```

Add the handlers:

```ts
      case "deck:reviewLaunch":
        await this.launchReviewFor(m.id);
        break;
      case "deck:reviewLoadDraft":
        this.loadReviewDraft(m.id);
        break;
```

```ts
  private reviewById(id: string): ReviewRequest | undefined {
    return this.decorateReviews(this.reviewCache?.requests ?? []).find((r) => r.id === id);
  }

  private async launchReviewFor(id: string): Promise<void> {
    const req = this.reviewById(id);
    if (!req) return;
    const cfg = getConfig();
    const res = await launchReview(
      { req, template: cfg.reviewRequestPrompt, workspaceDir: cfg.workspaceDir, seedAgent: cfg.seedAgent },
      { createWorktrees, openWorkspace, log: this.log },
    );
    if (!res.ok) {
      this.toast("error", res.message);
      return;
    }
    this.toast("success", `Reviewing ${req.repoName}#${req.number} in a worktree.${cfg.seedAgent ? " Claude Code pre-seeded — press Enter to start." : ""}`);
    await this.refreshBusy();
  }

  /** Hand the agent's findings to the review box. Read on demand rather than
   * carried in every deck:reviews post — the file is a whole review, and the
   * strip re-posts on every tick. */
  private loadReviewDraft(id: string): void {
    const req = this.reviewById(id);
    if (!req?.draftPath) return;
    try {
      this.post({ type: "deck:reviewDraft", id, body: fs.readFileSync(req.draftPath, "utf8").trim() });
    } catch (e) {
      this.log(`deck: review draft ${id} unreadable: ${e}`);
      this.toast("error", `Couldn't read the agent's review for ${req.repoName}#${req.number}.`);
    }
  }
```

- [ ] **Step 5: Add the strip's actions**

In `ReviewStrip.tsx`, extend the props with `onLaunch` and `onLoadDraft`, add a `reviewing` marker to the collapsed line when `r.runKey` is set:

```tsx
        {r.runKey && <span className="rv-running">reviewing</span>}
```

and put the actions in `.rv-actions`, before **Open PR**:

```tsx
            <button
              type="button"
              className="act primary"
              disabled={!r.localPath}
              title={r.localPath ? `Review in a worktree of ${r.repoName}` : `${r.repoName} is not checked out locally`}
              onClick={() => onLaunch(r.id)}
            >
              ▶ Review with agent
            </button>
            {r.draftPath && (
              <button type="button" className="act" onClick={() => onLoadDraft(r.id)}>Load agent's review</button>
            )}
```

Pass both through from `DeckApp`:

```tsx
        onLaunch={(id) => send({ type: "deck:reviewLaunch", id })}
        onLoadDraft={(id) => send({ type: "deck:reviewLoadDraft", id })}
```

Add `.rv-running { color: var(--c-progress); font-size: 11px; }` to `deckStyles.ts`.

- [ ] **Step 6: Run and commit**

Run: `npx vitest run && npx tsc --noEmit`

```bash
git add src/types.ts src/deckView.ts src/webview/ReviewStrip.tsx src/webview/DeckApp.tsx src/webview/deckStyles.ts \
        test/unit/deckView.test.ts test/webview/ReviewStrip.test.tsx
git commit -m "feat(review): Review-with-agent, and the draft handoff from the worktree"
```

- [ ] **Step 7: Coverage gate for Slice 2**

Run: `npx vitest run --coverage`
Expected: thresholds met.

---

## Slice 3 — Submitting a review

### Task 13: `submit()` on the provider

**Files:**
- Modify: `src/engine/review/provider.ts`
- Test: `test/unit/engine/review/provider.test.ts` (append)

**Interfaces:**
- Produces: `ReviewProvider.submit(repo: string, number: number, verb: ReviewVerb, body: string): Promise<{ ok: true } | { ok: false; message: string }>`.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/engine/review/provider.test.ts`:

```ts
describe("GhReviewProvider.submit", () => {
  it("approves with no body", async () => {
    const run = runner(async () => "");
    const out = await new GhReviewProvider(run, locate).submit("o/r", 7, "approve", "");
    expect(out).toEqual({ ok: true });
    expect((run as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual([
      "pr", "review", "7", "--repo", "o/r", "--approve",
    ]);
  });

  it("approves with a body when one is given", async () => {
    const run = runner(async () => "");
    await new GhReviewProvider(run, locate).submit("o/r", 7, "approve", "nice");
    expect((run as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual([
      "pr", "review", "7", "--repo", "o/r", "--approve", "--body", "nice",
    ]);
  });

  it("requests changes with a body", async () => {
    const run = runner(async () => "");
    await new GhReviewProvider(run, locate).submit("o/r", 7, "request-changes", "retry budget");
    expect((run as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual([
      "pr", "review", "7", "--repo", "o/r", "--request-changes", "--body", "retry budget",
    ]);
  });

  it("comments with a body", async () => {
    const run = runner(async () => "");
    await new GhReviewProvider(run, locate).submit("o/r", 7, "comment", "a thought");
    expect((run as ReturnType<typeof vi.fn>).mock.calls[0][1]).toContain("--comment");
  });

  it.each(["comment", "request-changes"] as const)("refuses %s with an empty body, before spawning", async (verb) => {
    const run = runner(async () => "");
    const out = await new GhReviewProvider(run, locate).submit("o/r", 7, verb, "   ");
    expect(out).toEqual({ ok: false, message: "GitHub requires a message for this kind of review." });
    expect(run).not.toHaveBeenCalled();
  });

  it("returns GitHub's own message on rejection", async () => {
    const run = runner(async () => { throw new Error("GraphQL: Can not approve your own pull request"); });
    const out = await new GhReviewProvider(run, locate).submit("o/r", 7, "approve", "");
    expect(out).toEqual({ ok: false, message: "GraphQL: Can not approve your own pull request" });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/unit/engine/review/provider.test.ts`
Expected: FAIL — `submit is not a function`.

- [ ] **Step 3: Implement**

Add `ReviewVerb` to the type import, extend the interface with the `submit` signature, and add:

```ts
const VERB_FLAG: Record<ReviewVerb, string> = {
  approve: "--approve",
  comment: "--comment",
  "request-changes": "--request-changes",
};

  /** The only command in Agent Flow that writes to GitHub. The caller confirms
   * first; this only refuses what GitHub would refuse anyway, and reports the
   * rejection verbatim — GitHub's own wording is more useful than ours. */
  async submit(repo: string, number: number, verb: ReviewVerb, body: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const text = body.trim();
    if (verb !== "approve" && !text) {
      return { ok: false, message: "GitHub requires a message for this kind of review." };
    }
    const args = ["pr", "review", String(number), "--repo", repo, VERB_FLAG[verb]];
    if (text) args.push("--body", text);
    try {
      await this.exec(args);
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }
```

- [ ] **Step 4: Run and commit**

Run: `npx vitest run test/unit/engine/review/provider.test.ts`

```bash
npx tsc --noEmit
git add src/engine/review/provider.ts test/unit/engine/review/provider.test.ts
git commit -m "feat(review): submit a review through gh, refusing a bodiless comment"
```

---

### Task 14: The confirm gate and the provenance line

**Files:**
- Modify: `src/types.ts` (inbound message)
- Modify: `src/deckView.ts`
- Test: `test/unit/deckView.test.ts` (append)

**Interfaces:**
- Produces: inbound `{ type: "deck:reviewSubmit"; id: string; verb: ReviewVerb; body: string; fromDraft: boolean }`; `REVIEW_PROVENANCE` exported from `src/deckView.ts`.

This is where the write guarantee actually lives — the webview only posts a message.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/deckView.test.ts`:

```ts
describe("DeckPanel review submit", () => {
  const submitMsg = (over = {}) =>
    ({ type: "deck:reviewSubmit", id: "CyberJackGit/aws-ops#8491", verb: "approve", body: "", fromDraft: false, ...over }) as const;

  it("refuses to submit while reviewWrites is off, without asking or spawning", async () => {
    h.reviewWrites = false;
    show();
    await settle();
    await onMessage(submitMsg());
    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(h.reviewSubmit).not.toHaveBeenCalled();
  });

  it("asks for confirmation naming the verb, repo and number", async () => {
    h.reviewWrites = true;
    show();
    await settle();
    await onMessage(submitMsg({ verb: "request-changes" }));
    expect(window.showWarningMessage).toHaveBeenCalledWith(
      "Request changes on CyberJackGit/aws-ops#8491?",
      { modal: true },
      "Request changes",
    );
  });

  it("spawns nothing when the confirmation is declined", async () => {
    h.reviewWrites = true;
    (window.showWarningMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    show();
    await settle();
    await onMessage(submitMsg());
    expect(h.reviewSubmit).not.toHaveBeenCalled();
  });

  it("submits and toasts on success", async () => {
    h.reviewWrites = true;
    show();
    await settle();
    await onMessage(submitMsg({ verb: "approve", body: "lgtm" }));
    expect(h.reviewSubmit).toHaveBeenCalledWith("CyberJackGit/aws-ops", 8491, "approve", "lgtm");
    expect(posted().some((m) => m.type === "toast" && m.level === "success")).toBe(true);
  });

  it("appends the provenance line to an agent-drafted body", async () => {
    h.reviewWrites = true;
    h.stampLabelOnWrite = true;
    show();
    await settle();
    await onMessage(submitMsg({ verb: "comment", body: "the retry budget is unbounded", fromDraft: true }));
    expect(h.reviewSubmit.mock.calls[0][3]).toBe(
      "the retry budget is unbounded\n\n_Drafted with Claude Code via Agent Flow._",
    );
  });

  it("leaves a hand-typed body alone", async () => {
    h.reviewWrites = true;
    h.stampLabelOnWrite = true;
    show();
    await settle();
    await onMessage(submitMsg({ verb: "comment", body: "mine, all mine", fromDraft: false }));
    expect(h.reviewSubmit.mock.calls[0][3]).toBe("mine, all mine");
  });

  it("omits provenance when stamping is off", async () => {
    h.reviewWrites = true;
    h.stampLabelOnWrite = false;
    show();
    await settle();
    await onMessage(submitMsg({ verb: "comment", body: "b", fromDraft: true }));
    expect(h.reviewSubmit.mock.calls[0][3]).toBe("b");
  });

  it("toasts GitHub's message with an Open PR action on rejection", async () => {
    h.reviewWrites = true;
    h.reviewSubmit.mockResolvedValueOnce({ ok: false, message: "Can not approve your own pull request" });
    show();
    await settle();
    await onMessage(submitMsg());
    const toast = posted().find((m) => m.type === "toast" && m.level === "error");
    expect(toast.message).toContain("Can not approve your own pull request");
    expect(toast.action).toEqual({ label: "Open PR", url: "https://github.com/CyberJackGit/aws-ops/pull/8491" });
  });
});
```

Add `reviewWrites`, `stampLabelOnWrite` and `reviewSubmit: vi.fn(async () => ({ ok: true }))` to the hoisted block, expose `submit` on the mocked provider class, and make `window.showWarningMessage` resolve its confirm label by default.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Add the message**

```ts
  | { type: "deck:reviewSubmit"; id: string; verb: ReviewVerb; body: string; fromDraft: boolean }
```

- [ ] **Step 4: Implement in `src/deckView.ts`**

```ts
/** Appended to a review body the agent drafted, when provenance stamping is on.
 * Posting an agent's words as unmarked human review is the kind of thing worth
 * being straight about with teammates. */
export const REVIEW_PROVENANCE = "_Drafted with Claude Code via Agent Flow._";

const VERB_LABEL: Record<ReviewVerb, string> = {
  approve: "Approve",
  comment: "Comment",
  "request-changes": "Request changes",
};
```

```ts
      case "deck:reviewSubmit":
        await this.submitReview(m.id, m.verb, m.body, m.fromDraft);
        break;
```

```ts
  /** The one write path. Three gates before anything reaches GitHub: the setting,
   * the row still being in the queue, and a modal the user has to accept. */
  private async submitReview(id: string, verb: ReviewVerb, body: string, fromDraft: boolean): Promise<void> {
    const cfg = getConfig();
    if (!cfg.reviewWrites) return;
    const req = this.reviewById(id);
    if (!req) return;
    const label = VERB_LABEL[verb];
    const answer = await vscode.window.showWarningMessage(
      `${label} on ${req.repo}#${req.number}?`,
      { modal: true },
      label,
    );
    if (answer !== label) return;
    const text = fromDraft && cfg.stampLabelOnWrite && body.trim()
      ? `${body.trim()}\n\n${REVIEW_PROVENANCE}`
      : body;
    this.log(`deck: submitting ${verb} on ${req.repo}#${req.number}`);
    const res = await this.reviewProvider.submit(req.repo, req.number, verb, text);
    if (!res.ok) {
      this.log(`deck: review submit failed: ${res.message}`);
      this.post({
        type: "toast",
        level: "error",
        message: `GitHub refused: ${res.message}`,
        action: { label: "Open PR", url: req.url },
      });
      return;
    }
    this.toast("success", `${label} sent on ${req.repoName}#${req.number}.`);
    // Approving clears the request server-side; drop it now rather than after a
    // TTL, and let the next search be authoritative.
    if (this.reviewCache) {
      this.reviewCache = { ...this.reviewCache, requests: this.reviewCache.requests.filter((r) => r.id !== id) };
    }
    this.postReviews();
  }
```

Add `ReviewVerb` to the type imports and `submit` to the `ReviewProvider` usage.

- [ ] **Step 5: Run and commit**

Run: `npx vitest run test/unit/deckView.test.ts && npx tsc --noEmit`

```bash
git add src/types.ts src/deckView.ts test/unit/deckView.test.ts
git commit -m "feat(review): confirm-gated review submission with agent provenance"
```

---

### Task 15: The review box in the strip

**Files:**
- Modify: `src/webview/ReviewStrip.tsx`, `src/webview/DeckApp.tsx`, `src/webview/deckStyles.ts`
- Modify: `src/types.ts` (`deck:runs` already carries toggles; add `reviewWrites` to `deck:reviews`)
- Modify: `src/deckView.ts` (`postReviews` sends `reviewWrites`)
- Test: `test/webview/ReviewStrip.test.tsx`, `test/webview/DeckApp.test.tsx` (append)

**Interfaces:**
- `deck:reviews` gains `reviewWrites: boolean`.
- `ReviewStrip` props gain `reviewWrites: boolean`, `bodies: Record<string, string>`, `onBody: (id: string, body: string) => void`, `onSubmit: (id: string, verb: ReviewVerb) => void`.

- [ ] **Step 1: Write the failing tests**

Append to `test/webview/ReviewStrip.test.tsx`:

```tsx
  it("renders no box and no verbs while writes are off", () => {
    render(<ReviewStrip {...props({ expanded: "CyberJackGit/aws-ops#8491", reviewWrites: false })} />);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByText("Approve")).not.toBeInTheDocument();
  });

  it("renders the box and three verbs when writes are on", () => {
    render(<ReviewStrip {...props({ expanded: "CyberJackGit/aws-ops#8491", reviewWrites: true })} />);
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(screen.getByText("Approve")).toBeInTheDocument();
    expect(screen.getByText("Comment")).toBeInTheDocument();
    expect(screen.getByText("Request changes")).toBeInTheDocument();
  });

  it("disables comment and request-changes with an empty box, but not approve", () => {
    render(<ReviewStrip {...props({ expanded: "CyberJackGit/aws-ops#8491", reviewWrites: true })} />);
    expect((screen.getByText("Comment") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("Request changes") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("Approve") as HTMLButtonElement).disabled).toBe(false);
  });

  it("enables every verb once the box has text", () => {
    render(<ReviewStrip {...props({
      expanded: "CyberJackGit/aws-ops#8491", reviewWrites: true,
      bodies: { "CyberJackGit/aws-ops#8491": "the retry budget" },
    })} />);
    expect((screen.getByText("Request changes") as HTMLButtonElement).disabled).toBe(false);
  });

  it("reports typing and submitting", () => {
    const onBody = vi.fn();
    const onSubmit = vi.fn();
    render(<ReviewStrip {...props({ expanded: "CyberJackGit/aws-ops#8491", reviewWrites: true, onBody, onSubmit })} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "lgtm" } });
    expect(onBody).toHaveBeenCalledWith("CyberJackGit/aws-ops#8491", "lgtm");
    fireEvent.click(screen.getByText("Approve"));
    expect(onSubmit).toHaveBeenCalledWith("CyberJackGit/aws-ops#8491", "approve");
  });
```

Add `reviewWrites: false`, `bodies: {}`, `onBody: vi.fn()`, `onSubmit: vi.fn()` to the shared `props()` helper.

Append to `test/webview/DeckApp.test.tsx`:

```tsx
  it("submits with fromDraft true only after loading the agent's draft", () => {
    render(<DeckApp />);
    host({ ...reviewsMsg([mkReview({ draftPath: "/wt/REVIEW-1.md" })]), reviewWrites: true } as OutboundMessage);
    fireEvent.click(screen.getByText("a small fix"));
    fireEvent.click(screen.getByText(/Load agent's review/i));
    host({ type: "deck:reviewDraft", id: "o/r#1", body: "1. unbounded retry" });
    fireEvent.click(screen.getByText("Comment"));
    expect(sent).toHaveBeenCalledWith({
      type: "deck:reviewSubmit", id: "o/r#1", verb: "comment", body: "1. unbounded retry", fromDraft: true,
    });
  });

  it("submits with fromDraft false for a hand-typed body", () => {
    render(<DeckApp />);
    host({ ...reviewsMsg([mkReview()]), reviewWrites: true } as OutboundMessage);
    fireEvent.click(screen.getByText("a small fix"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "mine" } });
    fireEvent.click(screen.getByText("Comment"));
    expect(sent).toHaveBeenCalledWith({
      type: "deck:reviewSubmit", id: "o/r#1", verb: "comment", body: "mine", fromDraft: false,
    });
  });
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run test/webview/`
Expected: FAIL on the new cases.

- [ ] **Step 3: Carry `reviewWrites` to the webview**

In `src/types.ts`, add `reviewWrites: boolean;` to the `deck:reviews` payload. In `postReviews`, add `reviewWrites: getConfig().reviewWrites,`.

- [ ] **Step 4: Add the box to the strip**

In the expanded block of `Row`, after `.rv-facts`:

```tsx
          {reviewWrites && (
            <div className="rv-box">
              <textarea
                value={body}
                placeholder="Leave a message… (required for Comment and Request changes)"
                onChange={(e) => onBody(r.id, e.target.value)}
              />
            </div>
          )}
```

and in `.rv-actions`, after **Open PR**:

```tsx
            {reviewWrites && (
              <>
                <button type="button" className="act" onClick={() => onSubmit(r.id, "approve")}>Approve</button>
                <button type="button" className="act" disabled={!body.trim()} onClick={() => onSubmit(r.id, "comment")}>Comment</button>
                <button type="button" className="act" disabled={!body.trim()} onClick={() => onSubmit(r.id, "request-changes")}>Request changes</button>
              </>
            )}
```

Thread `reviewWrites`, `body`, `onBody` and `onSubmit` from `ReviewStrip` into `Row`.

- [ ] **Step 5: Own the bodies in `DeckApp`**

```tsx
  const [bodies, setBodies] = React.useState<Record<string, string>>({});
  const [fromDraft, setFromDraft] = React.useState<Record<string, boolean>>({});
```

```tsx
      } else if (m.type === "deck:reviewDraft") {
        setBodies((b) => ({ ...b, [m.id]: m.body }));
        setFromDraft((f) => ({ ...f, [m.id]: true }));
      }
```

```tsx
        reviewWrites={reviews.reviewWrites}
        bodies={bodies}
        onBody={(id, body) => {
          setBodies((b) => ({ ...b, [id]: body }));
          // Editing a loaded draft does NOT clear the flag: the line tells a
          // teammate an agent read their code, which stays true however much you
          // reword it. Only emptying the box does — at that point nothing of the
          // agent's text is left to disclose.
          if (!body.trim()) setFromDraft((f) => (f[id] ? { ...f, [id]: false } : f));
        }}
        onSubmit={(id, verb) => send({ type: "deck:reviewSubmit", id, verb, body: bodies[id] ?? "", fromDraft: !!fromDraft[id] })}
```

Three places need `reviewWrites` in `DeckApp`, and missing any one leaves the verbs permanently hidden: the state's type, its initial value (`false`), and the `deck:reviews` handler, whose `setReviews` call becomes

```tsx
        setReviews({ requests: m.requests, issueCount: m.issueCount, sort: m.sort, stale: m.stale, reviewWrites: m.reviewWrites });
```

- [ ] **Step 6: Style the box**

```css
.rv-box { flex: 1; }
.rv-box textarea { width: 100%; min-height: 46px; resize: vertical; font: inherit;
  color: var(--vscode-input-foreground); background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; padding: 4px 6px; }
```

- [ ] **Step 7: Run and commit**

Run: `npx vitest run && npx tsc --noEmit`

```bash
git add src/types.ts src/deckView.ts src/webview/ReviewStrip.tsx src/webview/DeckApp.tsx src/webview/deckStyles.ts \
        test/webview/ReviewStrip.test.tsx test/webview/DeckApp.test.tsx
git commit -m "feat(review): the review box and its three verbs, behind reviewWrites"
```

Add one more DeckApp test, because this is the decided behaviour and nothing else pins it:

```tsx
  it("keeps fromDraft set when a loaded draft is edited", () => {
    render(<DeckApp />);
    host({ ...reviewsMsg([mkReview({ draftPath: "/wt/REVIEW-1.md" })]), reviewWrites: true } as OutboundMessage);
    fireEvent.click(screen.getByText("a small fix"));
    fireEvent.click(screen.getByText(/Load agent's review/i));
    host({ type: "deck:reviewDraft", id: "o/r#1", body: "1. unbounded retry" });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "1. the retry budget is unbounded" } });
    fireEvent.click(screen.getByText("Comment"));
    expect(sent).toHaveBeenCalledWith({
      type: "deck:reviewSubmit", id: "o/r#1", verb: "comment",
      body: "1. the retry budget is unbounded", fromDraft: true,
    });
  });

  it("clears fromDraft when the box is emptied", () => {
    render(<DeckApp />);
    host({ ...reviewsMsg([mkReview({ draftPath: "/wt/REVIEW-1.md" })]), reviewWrites: true } as OutboundMessage);
    fireEvent.click(screen.getByText("a small fix"));
    fireEvent.click(screen.getByText(/Load agent's review/i));
    host({ type: "deck:reviewDraft", id: "o/r#1", body: "1. unbounded retry" });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "all mine now" } });
    fireEvent.click(screen.getByText("Comment"));
    expect(sent).toHaveBeenCalledWith({
      type: "deck:reviewSubmit", id: "o/r#1", verb: "comment", body: "all mine now", fromDraft: false,
    });
  });
```

---

### Task 16: Documentation and the amended privacy claim

**Files:**
- Modify: `README.md` (the Deck section, the Settings table, Data & privacy, Requirements)
- Modify: `CHANGELOG.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Document the strip in the Deck section**

After the paragraph ending "cards fall back to the git + Jira backbone.", add:

```markdown
Above the columns sits your **review queue** — every open PR that asks for your
review, found with one `gh` search. Each row carries the repo, PR number, title,
author, age, and its size both as `+409 −50 · 8 files` and as an S/M/L bucket;
sort by **oldest** (what you owe most) or **smallest** (what you can clear before
standup). Expanding a row fetches which checks failed and how many review threads
are still open. **Review with agent** checks the PR out into a worktree and seeds
Claude Code to review the diff and write its findings to
`.pick-task/REVIEW-<number>.md`, which the row can then load into the review box.
Turn the strip off with `agentFlow.reviewRequests`; it shares the **PR facts**
toggle and the same `gh` dependency.

With `agentFlow.reviewWrites` on (**off by default**), the expanded row also
submits: **Approve**, **Comment**, or **Request changes**, each behind a
confirmation. A body drafted by the agent is marked as such when it goes out,
unless you turn `agentFlow.stampLabelOnWrite` off.
```

- [ ] **Step 2: Add the four settings to the table**

```markdown
| `agentFlow.reviewRequests` | `true` | Show the Deck's review-requests strip: open GitHub PRs that ask for your review. |
| `agentFlow.reviewRequestsTtlSeconds` | `300` | How stale the cached review queue may be before a refetch (minimum 60). |
| `agentFlow.reviewWrites` | `false` | Allow submitting approve / comment / request changes to GitHub from the Deck. |
| `agentFlow.reviewRequestPrompt` | *(built-in)* | Prompt seeded by **Review with agent**. |
```

- [ ] **Step 3: Amend Data & privacy — this is the claim that stops being true**

Replace "All GitHub access is **read-only** — Agent Flow never merges, comments, or pushes." with:

```markdown
GitHub access is **read-only by default** — Agent Flow never merges or pushes,
and stores no GitHub credentials of its own. The one exception is opt-in:
with `agentFlow.reviewWrites` on (it ships **off**), the Deck's review strip can
submit a review — approve, comment, or request changes — on a PR that asked for
yours. Every submit names the verb, repo and PR number in a confirmation dialog
first, each one is logged to the **Agent Flow** output channel, and a body the
review agent drafted is marked as agent-drafted when it goes out. Nothing else
about the feature writes anywhere: the review agent itself is told not to post to
GitHub at all.
```

- [ ] **Step 4: Note the `gh` requirement covers the strip**

In Requirements, extend the `gh` bullet's parenthetical from "for the Deck's PR/CI state" to "for the Deck's PR/CI state and its review-requests strip".

- [ ] **Step 5: Add the changelog entry**

At the top of `CHANGELOG.md`, under a new `## Unreleased` heading if one is not already open, following the file's existing style:

```markdown
### Added

- **The Deck's review queue.** A strip above the columns listing every open PR
  that asks for your review, with size (S/M/L and `+/−`), CI, review state and
  age; sortable by oldest or smallest. Expanding a row shows which checks failed
  and how many threads are open.
- **Review with agent** — checks a teammate's PR out into a worktree and seeds
  Claude Code to review it, writing findings to `.pick-task/REVIEW-<n>.md` that
  the row can load into the review box.
- **Opt-in review submission** (`agentFlow.reviewWrites`, default off): approve,
  comment or request changes from the Deck, each behind a confirmation. This is
  the first thing in Agent Flow that writes to GitHub.
- Settings: `agentFlow.reviewRequests`, `agentFlow.reviewRequestsTtlSeconds`,
  `agentFlow.reviewWrites`, `agentFlow.reviewRequestPrompt`.
```

- [ ] **Step 6: Final verification and commit**

Run: `npx vitest run --coverage && npx tsc --noEmit && npm run lint --if-present`
Expected: all tests pass, all four coverage thresholds met.

```bash
git add README.md CHANGELOG.md
git commit -m "docs: the Deck's review queue, and the amended read-only claim"
```

- [ ] **Step 7: Manual smoke test before merging**

The unit suite never spawns `gh`, so exercise the real thing once:

1. `npm run compile` (or the repo's build script) and launch the Extension Development Host.
2. Open the Deck. The strip should list your real review requests — the author's account had 9 at design time.
3. Expand the largest one; failing check names should appear.
4. Sort by **smallest**; a 1-file PR should rise to the top and drafts stay last.
5. With `agentFlow.reviewWrites` still **off**, confirm there is no box and no verbs.
6. Launch **Review with agent** on a repo you have cloned; confirm a worktree appears at `<repo>/.claude/worktrees/review-<repo>-<n>` and that `git status` in the main checkout is clean.
7. Confirm the review run does **not** appear as a card in any of the four columns.

Report anything that differs rather than fixing it silently — steps 6 and 7 are the two guarantees the design rests on.

---

## Plan Self-Review

**Spec coverage:** discovery (Tasks 2, 4), locality (Task 7), enrichment (Tasks 4, 9), the modules table (Tasks 1–5, 8, 11), types (Task 1), messages (Tasks 7, 9, 12, 14, 15), the strip and its rules (Task 8), the three render conditions (Tasks 7, 8), sort and size (Tasks 1, 8), collapse-above-five (Task 8), the Review agent and prompt (Tasks 6, 11, 12), `Run.kind` (Task 10), not-cloned repos (Tasks 11, 12), the write path (Tasks 13, 14, 15), provenance (Task 14), settings (Task 6), failure modes (Tasks 4, 5, 7, 9, 11, 14), tests (throughout), README/CHANGELOG (Task 16), build order (the three slices).

**Decisions taken before execution, recorded so no task relitigates them:**

- *"Collapse state and sort choice persist in `workspaceState`"* (spec) → **session only**. Sort is a mode picked for a moment, not a durable preference, and collapse already adapts to queue size. Adding persistence later is additive and touches nothing else. The spec's line is superseded by this ruling.
- **Provenance survives editing.** `fromDraft` is set when a draft loads and cleared only when the box is emptied — not on edit. The line discloses that an agent read the teammate's code, which stays true however much the wording changes; dropping it after a one-word tweak would strip the disclosure in exactly the case that wants it. Two tests in Task 15 pin both directions.
- *"`> 50` requests: showing 50 of N."* Implemented, with `REVIEW_SEARCH_LIMIT` as a module constant rather than a setting. That matches the spec; noted so nobody adds a setting for it unasked.
- **Collapse-on-arrival uses a ref, not a `setState` inside another `setState`'s updater** — the original phrasing would have fired twice under StrictMode.
