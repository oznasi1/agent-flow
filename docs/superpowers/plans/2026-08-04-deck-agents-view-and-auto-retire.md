# Deck Agents View & Run Auto-Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Deck's In-flight board show one card per Claude Code agent by default, keep today's per-workspace grouping behind a persisted toggle, and have run records retire themselves once provably over.

**Architecture:** The host keeps posting `RunStatus[]` exactly as it does today; a new pure module re-projects that payload into per-agent cards in the webview, so both views share one payload and the mode switch needs no round trip. Column logic is extracted into a webview-importable `engine/bucket.ts` so it stays single-sourced. Retirement is a pure verdict function called from `buildAll` after statuses are built, with a `finishedAt` stamp written onto the record to time the grace window across panel reloads.

**Tech Stack:** TypeScript, React 18 (webview), esbuild, Vitest + @testing-library/react, VS Code extension API.

**Spec:** [docs/superpowers/specs/2026-08-04-deck-agents-view-and-auto-retire-design.md](../specs/2026-08-04-deck-agents-view-and-auto-retire-design.md)

## Global Constraints

- **Gates before every commit:** `npm run typecheck`, `npm test`, `npm run test:cov` (thresholds enforced), `npm run build`. A commit that skips these is a failed task.
- **The `vscode` module is mocked** in `test/_mocks/vscode.ts`. Never import real `vscode` in a test.
- **`src/webview/**` must never import a module that touches `fs`.** The webview is bundled for `platform: "browser"` ([esbuild.js:33-49](../../../esbuild.js)).
- **Card copy conventions:** red only for real failures; mono (`.id`, `var(--mono)`) only for identifiers, never for prose; no persistent hint lines on cards.
- **Column vocabulary:** the id is `needs`, the user-facing label is always **"Action required"** — in the stat tile, the column header and the legend alike.
- **Never widen a webview message union without adding the host handler in the same task**, and vice versa.
- **Retirement deletes only the run record and its PR-facts cache.** It must never touch a worktree, branch, or commit.
- **Default for `agentFlow.deckGrouping` is `"agents"`.**

## Coordination with the in-flight diff-editor plan

[2026-08-04-deck-diff-multi-file-editor.md](2026-08-04-deck-diff-multi-file-editor.md)
rewrites the same Diff button this plan touches — its own Task edits
`DeckApp.tsx:293`, replacing that `<button className="act" … action: "diff" …>`
line wholesale with a new tooltip and **no `repo` argument**.

Whichever plan lands second must not clobber the other. The merged line carries
both changes:

```tsx
          <button className="act" title="Show everything this task changed, file by file" onClick={() => send({ type: "deck:inspect", key: r.run.key, action: "diff", ...(agent?.repo ? { repo: agent.repo } : {}) })}>Diff</button>
```

Dropping the spread silently un-scopes Diff on an agent card back to the run's
first repo — a regression no test in that plan would catch, since its own suite
fires `deck:inspect` messages directly rather than clicking the button.

---

## File Structure

| file | responsibility |
|---|---|
| `src/engine/bucket.ts` | **new.** Pure column derivation: `BucketInput`, `deriveBucket`, `prSignals`. Imports only `../types`. The one engine module the webview may import. |
| `src/engine/status.ts` | keeps `mostActive` and `buildRunStatus`; imports + re-exports `bucket.ts` so existing callers are untouched. |
| `src/engine/retire.ts` | **new.** Pure `retireVerdict()` — the three rules, the dirty/unpushed veto, and the stamp/unstamp decision. Filesystem access is injected. |
| `src/webview/deckCards.ts` | **new.** Pure `projectCards()` — turns `RunStatus[]` into per-agent + parked cards with their columns. |
| `src/types.ts` | `Run.finishedAt?`, `CardAgent.repo?`, the two new inbound messages, the two new `deck:runs` fields. |
| `src/config.ts` | three new settings. |
| `package.json` | manifest declarations for those settings. |
| `src/deckView.ts` | fills `CardAgent.repo`, reads sessions unconditionally, runs both sweeps, persists the grouping, handles `deck:clearStale`. |
| `src/webview/DeckApp.tsx` | one `Card` component driven by an `agent` prop, the grouping state, the segmented control, the `Clear stale` button. |
| `src/webview/deckStyles.ts` | segmented-control active state, agent-name line. |

---

### Task 1: Extract pure column derivation into `engine/bucket.ts`

The webview needs `deriveBucket` and `prSignals` to bucket a per-agent card. They live in `status.ts`, which imports `./git`, `./transcript`, `./runs` and `./paths` — all of which touch `fs`, so no webview module can import that file.

**Deviation from the spec, deliberate:** the spec said to move `mostActive` as well. Leave it in `status.ts`. It depends on `UNKNOWN_ACTIVITY` from `engine/transcript.ts` ([transcript.ts:51](../../../src/engine/transcript.ts)), which imports `fs` at line 1 — moving `mostActive` would mean moving that constant too and re-pointing every importer, for a function the webview never calls. Moving two functions instead of three is the smaller change that fully unblocks the webview.

**Files:**
- Create: `src/engine/bucket.ts`
- Modify: `src/engine/status.ts:1-60` (remove the two functions and `BucketInput`, import + re-export them)
- Create: `test/unit/engine/bucket.test.ts`
- Modify: `test/unit/engine/status.test.ts:23-73, 106-159` (move the `deriveBucket`, `deriveBucket with PR signals` and `prSignals` describes out)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `src/engine/bucket.ts` exporting
  - `interface BucketInput { jiraCategory?: string | null; jiraStatus?: string | null; agentState?: AgentState; prOpen?: boolean; prBlocked?: boolean; prMerged?: boolean }`
  - `function deriveBucket(i: BucketInput): DeckColumn`
  - `function prSignals(prs: PrEntryMap): { open: boolean; blocked: boolean; merged: boolean }`

  `src/engine/status.ts` continues to export all three names, so no other file's imports change.

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine/bucket.test.ts`. The first case is the import guard — the whole point of the new file is that it is browser-safe, and nothing else in the suite would notice if someone later added `import * as fs from "fs"` to it:

```ts
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import { deriveBucket, prSignals } from "../../../src/engine/bucket";
import { PrEntryMap, PrFacts } from "../../../src/types";

const prFacts = (over: Partial<PrFacts> = {}): PrFacts => ({
  number: 1, url: "https://github.com/o/r/pull/1", title: "t", state: "OPEN", isDraft: false,
  ci: { passing: 2, pending: 0, failing: [] }, review: "none", unresolved: null,
  mergeable: "clean", ciAdvisory: false, ...over,
});
const entries = (...facts: (PrFacts | null)[]): PrEntryMap =>
  Object.fromEntries(facts.map((f, i) => [`r${i}`, { facts: f, fetchedAt: 0 }]));

describe("bucket.ts is webview-safe", () => {
  it("imports nothing but ../types, so the browser bundle can include it", () => {
    const src = fs.readFileSync(new URL("../../../src/engine/bucket.ts", import.meta.url), "utf8");
    const specifiers = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(specifiers).toEqual(["../types"]);
  });
});

describe("deriveBucket", () => {
  it("puts a Jira-done ticket in Done even if the agent is working", () => {
    expect(deriveBucket({ jiraCategory: "done", agentState: "working" })).toBe("done");
  });

  it("surfaces a needs-you agent even while Jira is in progress", () => {
    expect(deriveBucket({ jiraCategory: "indeterminate", agentState: "needs-you" })).toBe("needs");
  });

  it("keeps a working agent in In-progress even in a review status (live beats review)", () => {
    expect(deriveBucket({ jiraStatus: "In Review", agentState: "working" })).toBe("progress");
  });

  it("promotes a blocked PR into Needs you even while the agent is working", () => {
    expect(deriveBucket({ agentState: "working", prBlocked: true })).toBe("needs");
  });

  it("falls back to In-progress for an unknown agent with nothing else", () => {
    expect(deriveBucket({ agentState: "unknown" })).toBe("progress");
  });
});

describe("prSignals", () => {
  it("is all false for no entries", () => {
    expect(prSignals({})).toEqual({ open: false, blocked: false, merged: false });
  });

  it("does not report open for a draft PR", () => {
    expect(prSignals(entries(prFacts({ isDraft: true }))).open).toBe(false);
  });

  it("reports merged only when every PR-bearing repo has merged", () => {
    expect(prSignals(entries(prFacts({ state: "MERGED" }), prFacts())).merged).toBe(false);
    expect(prSignals(entries(prFacts({ state: "MERGED" }))).merged).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/engine/bucket.test.ts`
Expected: FAIL — `Failed to resolve import "../../../src/engine/bucket"`.

- [ ] **Step 3: Create `src/engine/bucket.ts`**

Move the code verbatim out of `status.ts` — including the doc comments, which carry the precedence rationale and must not be lost:

```ts
import { AgentState, DeckColumn, PrEntryMap } from "../types";

/** Inputs to the column decision — every field observable, none required. */
export interface BucketInput {
  jiraCategory?: string | null; // "new" | "indeterminate" | "done"
  jiraStatus?: string | null; // status name, e.g. "In Review"
  agentState?: AgentState;
  prOpen?: boolean; // an open, non-draft PR exists
  prBlocked?: boolean; // a PR needs a human decision: CI, changes requested, or a conflict
  prMerged?: boolean; // every PR-bearing repo has merged
}

function isReviewStatus(name?: string | null): boolean {
  return !!name && /review|qa|verif/i.test(name);
}

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
 *
 * Lives here rather than in status.ts so `src/webview/deckCards.ts` can import it:
 * status.ts reaches for git, the transcript and paths, none of which exist in a
 * browser bundle. Keep this file free of `fs`-touching imports — bucket.test.ts
 * enforces it.
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

- [ ] **Step 4: Delete the moved code from `status.ts` and re-export**

In `src/engine/status.ts`, delete `BucketInput`, `isReviewStatus`, `deriveBucket` and `prSignals` (lines 7-60). Change the import block at the top to add:

```ts
import { BucketInput, deriveBucket, prSignals } from "./bucket";

// Re-exported so every existing importer of status.ts keeps working — these moved
// to ./bucket.ts only so the webview could import them.
export { deriveBucket, prSignals };
export type { BucketInput };
```

`mostActive` and `buildRunStatus` stay exactly as they are; `buildRunStatus` already calls both re-exported functions by bare name, so its body needs no edit.

- [ ] **Step 5: Move the corresponding tests out of `status.test.ts`**

Delete the `describe("deriveBucket")`, `describe("deriveBucket with PR signals")` and `describe("prSignals")` blocks from `test/unit/engine/status.test.ts` (lines 23-73 and 106-159), and copy every case not already written in Step 1 into `bucket.test.ts` — all of them, not a sample. `status.test.ts` keeps `mostActive` and `buildRunStatus`, and keeps importing `deriveBucket`/`prSignals` only if a remaining case uses them (it does not — drop them from its import list).

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run test/unit/engine/bucket.test.ts test/unit/engine/status.test.ts`
Expected: PASS, with the moved case count intact — `deriveBucket` + `prSignals` cases now in `bucket.test.ts`, `mostActive` + `buildRunStatus` still in `status.test.ts`.

- [ ] **Step 7: Gates + commit**

```bash
npm run typecheck && npm test && npm run test:cov && npm run build
git add src/engine/bucket.ts src/engine/status.ts test/unit/engine/bucket.test.ts test/unit/engine/status.test.ts
git commit -m "refactor(engine): extract pure column derivation into bucket.ts

deriveBucket and prSignals move to a module with no fs-touching imports, so
src/webview can bundle them. status.ts re-exports both, so no other importer
changes. mostActive stays put: it needs UNKNOWN_ACTIVITY from transcript.ts,
which imports fs, and the webview never calls it."
```

---

### Task 2: Three new settings

**Files:**
- Modify: `src/config.ts:180-234` (the `AgentFlowConfig` interface) and `src/config.ts:363-424` (the `getConfig()` return)
- Modify: `package.json` (`contributes.configuration.properties`)
- Modify: `test/unit/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AgentFlowConfig` gains
  - `deckGrouping: "agents" | "workspaces"`
  - `retireFinishedAfterHours: number` (≥ 0)
  - `retireAbandonedAfterDays: number` (≥ 0)

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/config.test.ts` — inside the existing top-level area, following the file's `setConfig` style:

```ts
describe("deck grouping and retirement settings", () => {
  it("defaults to the Agents view, a 24h finished window and a 7-day abandoned window", () => {
    const c = getConfig();
    expect(c.deckGrouping).toBe("agents");
    expect(c.retireFinishedAfterHours).toBe(24);
    expect(c.retireAbandonedAfterDays).toBe(7);
  });

  it("honours the workspaces grouping", () => {
    setConfig({ deckGrouping: "workspaces" });
    expect(getConfig().deckGrouping).toBe("workspaces");
  });

  it("falls back to agents for an unknown grouping value", () => {
    setConfig({ deckGrouping: "sideways" });
    expect(getConfig().deckGrouping).toBe("agents");
  });

  it("honours custom retirement windows", () => {
    setConfig({ retireFinishedAfterHours: 2, retireAbandonedAfterDays: 30 });
    expect(getConfig().retireFinishedAfterHours).toBe(2);
    expect(getConfig().retireAbandonedAfterDays).toBe(30);
  });

  it("keeps zero as zero — it is the documented way to disable each window", () => {
    setConfig({ retireFinishedAfterHours: 0, retireAbandonedAfterDays: 0 });
    expect(getConfig().retireFinishedAfterHours).toBe(0);
    expect(getConfig().retireAbandonedAfterDays).toBe(0);
  });

  it("floors a negative window at zero rather than retiring on a clock that runs backwards", () => {
    setConfig({ retireFinishedAfterHours: -5, retireAbandonedAfterDays: -1 });
    expect(getConfig().retireFinishedAfterHours).toBe(0);
    expect(getConfig().retireAbandonedAfterDays).toBe(0);
  });
});
```

And in the existing `describe("package.json ⇄ config constants")` block:

```ts
  it("declares deckGrouping defaulting to agents, and both retirement windows", () => {
    const g = props["agentFlow.deckGrouping"] as { default?: unknown; enum?: unknown };
    expect(g.default).toBe("agents");
    expect(g.enum).toEqual(["agents", "workspaces"]);
    const fin = props["agentFlow.retireFinishedAfterHours"] as { default?: unknown; minimum?: unknown };
    expect(fin.default).toBe(24);
    expect(fin.minimum).toBe(0);
    const ab = props["agentFlow.retireAbandonedAfterDays"] as { default?: unknown; minimum?: unknown };
    expect(ab.default).toBe(7);
    expect(ab.minimum).toBe(0);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/config.test.ts`
Expected: FAIL — `expect(undefined).toBe("agents")` on the first case.

- [ ] **Step 3: Add the fields to `AgentFlowConfig`**

In `src/config.ts`, inside the interface, after the `openAgents` block:

```ts
  // Which lens the Deck's In-flight board opens in: one card per Claude Code
  // agent ("agents"), or today's one card per launched run with its agents
  // nested ("workspaces"). Written by the board's own segmented control.
  deckGrouping: "agents" | "workspaces";
  // How long a landed run (every PR merged, or Jira done with no PR open) stays
  // on the board with no agent in it before its record is retired. 0 = retire as
  // soon as it lands.
  retireFinishedAfterHours: number;
  // How long an abandoned run (no ticket, no PR, nothing uncommitted) may sit
  // untouched before its record is retired. 0 = never.
  retireAbandonedAfterDays: number;
```

- [ ] **Step 4: Read them in `getConfig()`**

After the `openAgents` line in the returned object:

```ts
    deckGrouping: c.get<string>("deckGrouping") === "workspaces" ? "workspaces" : "agents",
    // Floored, not defaulted: 0 is meaningful (disable the window) and must
    // survive, while a negative value is a typo that would retire on a clock
    // running backwards.
    retireFinishedAfterHours: Math.max(0, c.get<number>("retireFinishedAfterHours") ?? 24),
    retireAbandonedAfterDays: Math.max(0, c.get<number>("retireAbandonedAfterDays") ?? 7),
```

- [ ] **Step 5: Declare them in `package.json`**

In `contributes.configuration.properties`, beside `agentFlow.openAgents`:

```json
    "agentFlow.deckGrouping": {
      "type": "string",
      "enum": ["agents", "workspaces"],
      "enumDescriptions": [
        "One card per Claude Code agent, with the repo, ticket and PR it belongs to on the card",
        "One card per launched task, with every agent open in its directories nested underneath"
      ],
      "default": "agents",
      "markdownDescription": "Which lens the Deck's In-flight board opens in. The board's own **Agents / Workspaces** control writes this setting, so whichever you pick sticks."
    },
    "agentFlow.retireFinishedAfterHours": {
      "type": "number",
      "default": 24,
      "minimum": 0,
      "markdownDescription": "How long landed work stays on the Deck after its last agent closes — every pull request merged, or the Jira issue done with no PR still open. When the window elapses the run record is deleted (never the worktree, branch, or commits). `0` retires it as soon as it lands."
    },
    "agentFlow.retireAbandonedAfterDays": {
      "type": "number",
      "default": 7,
      "minimum": 0,
      "markdownDescription": "How long a run with no Jira ticket, no pull request and nothing uncommitted may sit untouched before its record is deleted (never the worktree, branch, or commits). `0` disables this cleanup."
    },
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/unit/config.test.ts`
Expected: PASS.

- [ ] **Step 7: Gates + commit**

```bash
npm run typecheck && npm test && npm run test:cov && npm run build
git add src/config.ts package.json test/unit/config.test.ts
git commit -m "feat(config): add deckGrouping and the two retirement windows"
```

---

### Task 3: `Run.finishedAt`, `CardAgent.repo`, and filling the repo name

An agent card's `Open` and `Diff` must act on the directory that agent actually runs in. `deck:inspect` already takes an optional `repo` name, so the host needs no new action code — but the webview has no way to map a session's `cwd` to a run repo. The host does: it finds each session *inside* a loop over `run.repos`.

**Files:**
- Modify: `src/types.ts:61-77` (`Run`), `src/types.ts:142-148` (`CardAgent`)
- Modify: `src/deckView.ts:567-584` (the tracked-run agent loop) and `src/deckView.ts:592-606` (the local-run loop)
- Modify: `test/unit/deckView.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `Run.finishedAt?: number` — epoch ms, stamped by Task 4's sweep. Nothing reads it before Task 5.
  - `CardAgent.repo?: string` — the `run.repos[].name` whose directory this session runs in.

- [ ] **Step 1: Write the failing test**

In `test/unit/deckView.test.ts`, alongside the existing open-sessions cases:

```ts
  it("tags each agent with the run repo whose directory it runs in", async () => {
    h.runs = [runFixture({
      key: "PROJ-9",
      repos: [
        { name: "api", path: "/repos/api", isGit: true, branch: "PROJ-9-x" },
        { name: "web", path: "/repos/web", isGit: true, branch: "PROJ-9-x" },
      ],
    })];
    h.openSessions = [
      { pid: 11, sessionId: "s-api", cwd: "/repos/api", startedAt: 1, name: "api-1a" },
      { pid: 12, sessionId: "s-web", cwd: "/repos/web", startedAt: 2, name: "web-2b" },
    ];
    await showAndSettle();
    const agents = lastRuns()[0].agents;
    expect(agents.map((a) => [a.session.sessionId, a.repo])).toEqual([
      ["s-api", "api"],
      ["s-web", "web"],
    ]);
  });
```

Use whatever helpers the suite already defines for `runFixture`, `showAndSettle` and reading the last posted `deck:runs` payload; if a helper is named differently, use the existing name rather than inventing one.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/deckView.test.ts -t "run repo whose directory"`
Expected: FAIL — `repo` is `undefined` on both agents.

- [ ] **Step 3: Add the two optional fields in `src/types.ts`**

In `Run`, after `briefPaths`:

```ts
  /** When this run was first observed to have landed — every PR merged, or Jira
   * done with no PR open — and no agent left in it. Stamped by the Deck's retire
   * sweep, not by any launch, and cleared again if the run stops satisfying that
   * condition. It exists because `createdAt` cannot time the grace window: a
   * three-week task would retire the instant it landed. Absent on every record
   * written before this field existed, and on every run still in flight. */
  finishedAt?: number;
```

In `CardAgent`, after `activity`:

```ts
  /** The `run.repos[].name` whose directory this session runs in. Set host-side,
   * where the session was matched against that repo's path in the first place —
   * the webview only has a `cwd`, and an agent card's Open and Diff must act on
   * the directory its own agent is in, not the run's first repo. Absent on a
   * local card's agents, which have exactly one repo to act on anyway. */
  repo?: string;
```

- [ ] **Step 4: Fill it in `deckView.ts`**

In the tracked-run loop, the `mine.push` call becomes:

```ts
          mine.push({
            session: s,
            // Addressed by sessionId, so two sessions in one worktree report
            // their own states rather than sharing the newest transcript's.
            activity: this.liveSignal ? readSessionActivity(projectsRoot, s.cwd, s.sessionId, now) : UNKNOWN_ACTIVITY,
            repo: repo.name,
          });
```

In the local-run loop, the mapped agents become:

```ts
        sessions.map((s) => ({
          session: s,
          activity: this.liveSignal ? readSessionActivity(projectsRoot, s.cwd, s.sessionId, now) : UNKNOWN_ACTIVITY,
          repo: run.repos[0]?.name,
        })),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: PASS.

- [ ] **Step 6: Gates + commit**

```bash
npm run typecheck && npm test && npm run test:cov && npm run build
git add src/types.ts src/deckView.ts test/unit/deckView.test.ts
git commit -m "feat(deck): tag each card agent with the run repo it runs in

Adds Run.finishedAt too, unread until the retire sweep lands."
```

---

### Task 4: The retirement verdict

Pure, injectable, and the only place the three rules live. No `fs` import: path existence is passed in, so every rule is testable without a temp directory.

**Files:**
- Create: `src/engine/retire.ts`
- Create: `test/unit/engine/retire.test.ts`

**Interfaces:**
- Consumes: `Run`, `RepoGit`, `PrEntryMap`, `PrFacts`, `isTicketRun` from `../types`.
- Produces:

```ts
export type RetireReason = "unreachable" | "finished" | "abandoned";
export type RetireVerdict =
  | { action: "keep" }
  | { action: "stamp"; finishedAt: number }
  | { action: "unstamp" }
  | { action: "retire"; reason: RetireReason };
export interface RetireInput {
  run: Run;
  repos: RepoGit[];
  jiraCategory: string | null;
  prs: PrEntryMap;
  hasLiveSession: boolean;
  prsAuthoritative: boolean;
  finishedAfterMs: number;
  abandonedAfterMs: number;
  nowMs: number;
  exists: (p: string) => boolean;
}
export function retireVerdict(i: RetireInput): RetireVerdict;
```

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine/retire.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { retireVerdict, RetireInput } from "../../../src/engine/retire";
import { PrEntryMap, PrFacts, RepoGit, Run } from "../../../src/types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000_000;

const run = (over: Partial<Run> = {}): Run => ({
  key: "PROJ-1", summary: "s", url: "https://jira/browse/PROJ-1", createdAt: NOW - 30 * DAY,
  mode: "per-window", repos: [{ name: "api", path: "/r/api", isGit: true, branch: "PROJ-1-x" }],
  briefPaths: [], ...over,
});
const repo = (over: Partial<RepoGit> = {}): RepoGit => ({
  name: "api", path: "/r/api", branch: "PROJ-1-x", dirty: false, ahead: 0,
  added: 0, removed: 0, files: 0, ...over,
});
const facts = (over: Partial<PrFacts> = {}): PrFacts => ({
  number: 1, url: "https://github.com/o/r/pull/1", title: "t", state: "OPEN", isDraft: false,
  ci: { passing: 1, pending: 0, failing: [] }, review: "none", unresolved: null,
  mergeable: "clean", ciAdvisory: false, ...over,
});
const prs = (f: PrFacts | null): PrEntryMap => ({ api: { facts: f, fetchedAt: NOW } });

const input = (over: Partial<RetireInput> = {}): RetireInput => ({
  run: run(), repos: [repo()], jiraCategory: "indeterminate", prs: {},
  hasLiveSession: false, prsAuthoritative: true,
  finishedAfterMs: 24 * HOUR, abandonedAfterMs: 7 * DAY, nowMs: NOW,
  exists: () => true, ...over,
});

describe("rule 1 — unreachable", () => {
  it("retires a run whose every repo path is gone", () => {
    expect(retireVerdict(input({ exists: () => false })))
      .toEqual({ action: "retire", reason: "unreachable" });
  });

  it("keeps a run with one surviving repo", () => {
    const r = run({ repos: [
      { name: "api", path: "/r/api", isGit: true, branch: "b" },
      { name: "web", path: "/r/web", isGit: true, branch: "b" },
    ] });
    expect(retireVerdict(input({ run: r, exists: (p) => p === "/r/web" })).action).toBe("keep");
  });

  it("never fires for a run with no repos at all", () => {
    expect(retireVerdict(input({ run: run({ repos: [] }), exists: () => false })).action).toBe("keep");
  });

  it("ignores workspaceFile — several runs share one, so its survival proves nothing", () => {
    const r = run({ workspaceFile: "/r/both.code-workspace" });
    expect(retireVerdict(input({ run: r, exists: (p) => p === "/r/both.code-workspace" })))
      .toEqual({ action: "retire", reason: "unreachable" });
  });

  it("fires even with dirty work — a deleted directory has none to lose", () => {
    expect(retireVerdict(input({ repos: [repo({ dirty: true })], exists: () => false })))
      .toEqual({ action: "retire", reason: "unreachable" });
  });
});

describe("rule 2 — finished", () => {
  it("stamps rather than retires the first time it sees a merged run", () => {
    expect(retireVerdict(input({ prs: prs(facts({ state: "MERGED" })) })))
      .toEqual({ action: "stamp", finishedAt: NOW });
  });

  it("keeps a stamped run until the window elapses", () => {
    const r = run({ finishedAt: NOW - 2 * HOUR });
    expect(retireVerdict(input({ run: r, prs: prs(facts({ state: "MERGED" })) })).action).toBe("keep");
  });

  it("retires once the window has elapsed", () => {
    const r = run({ finishedAt: NOW - 25 * HOUR });
    expect(retireVerdict(input({ run: r, prs: prs(facts({ state: "MERGED" })) })))
      .toEqual({ action: "retire", reason: "finished" });
  });

  it("retires immediately, without stamping, when the window is zero", () => {
    expect(retireVerdict(input({ prs: prs(facts({ state: "MERGED" })), finishedAfterMs: 0 })))
      .toEqual({ action: "retire", reason: "finished" });
  });

  it("counts a Jira-done run with no open PR as finished", () => {
    expect(retireVerdict(input({ jiraCategory: "done", prs: {} })))
      .toEqual({ action: "stamp", finishedAt: NOW });
  });

  it("spares a Jira-done run whose PR is still open", () => {
    expect(retireVerdict(input({ jiraCategory: "done", prs: prs(facts()) })).action).toBe("keep");
  });

  it("spares a Jira-done run whose PR is still a draft — a draft is unmerged work", () => {
    expect(retireVerdict(input({ jiraCategory: "done", prs: prs(facts({ isDraft: true })) })).action).toBe("keep");
  });

  it("clears the stamp when the run stops being finished", () => {
    const r = run({ finishedAt: NOW - 2 * HOUR });
    expect(retireVerdict(input({ run: r, jiraCategory: "indeterminate", prs: prs(facts()) })))
      .toEqual({ action: "unstamp" });
  });

  it("fails closed with no Jira and no PR facts: nothing stamped, nothing retired", () => {
    expect(retireVerdict(input({ jiraCategory: null, prs: {}, prsAuthoritative: false,
      run: run({ createdAt: NOW - DAY }) })).action).toBe("keep");
  });
});

describe("the veto", () => {
  it("blocks a merged run with uncommitted work", () => {
    expect(retireVerdict(input({ repos: [repo({ dirty: true })], prs: prs(facts({ state: "MERGED" })) })).action)
      .toBe("keep");
  });

  it("blocks a merged run with unpushed commits", () => {
    expect(retireVerdict(input({ repos: [repo({ ahead: 2 })], prs: prs(facts({ state: "MERGED" })) })).action)
      .toBe("keep");
  });

  it("blocks an abandoned run with unpushed commits", () => {
    const r = run({ url: "", createdAt: NOW - 30 * DAY });
    expect(retireVerdict(input({ run: r, repos: [repo({ ahead: 1 })], jiraCategory: null })).action).toBe("keep");
  });
});

describe("rule 3 — abandoned", () => {
  const abandoned = (over: Partial<RetireInput> = {}) =>
    retireVerdict(input({ run: run({ url: "", createdAt: NOW - 30 * DAY }), jiraCategory: null, ...over }));

  it("retires a ticketless, PR-less, clean, old run", () => {
    expect(abandoned()).toEqual({ action: "retire", reason: "abandoned" });
  });

  it("keeps it inside the window", () => {
    expect(abandoned({ abandonedAfterMs: 60 * DAY }).action).toBe("keep");
  });

  it("is disabled by a zero window", () => {
    expect(abandoned({ abandonedAfterMs: 0 }).action).toBe("keep");
  });

  it("is skipped when the prs map is not authoritative", () => {
    expect(abandoned({ prsAuthoritative: false }).action).toBe("keep");
  });

  it("spares a run that still has a ticket", () => {
    expect(retireVerdict(input({ run: run({ createdAt: NOW - 30 * DAY }), jiraCategory: null })).action)
      .toBe("keep");
  });

  it("spares a run that has a PR entry", () => {
    expect(abandoned({ prs: prs(facts()) }).action).toBe("keep");
  });
});

describe("a live session", () => {
  it("blocks every rule, even an unreachable run", () => {
    expect(retireVerdict(input({ hasLiveSession: true, exists: () => false })).action).toBe("keep");
  });

  it("clears a stamp — work with somebody in it is not over", () => {
    const r = run({ finishedAt: NOW - 25 * HOUR });
    expect(retireVerdict(input({ run: r, hasLiveSession: true, prs: prs(facts({ state: "MERGED" })) })))
      .toEqual({ action: "unstamp" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/engine/retire.test.ts`
Expected: FAIL — `Failed to resolve import "../../../src/engine/retire"`.

- [ ] **Step 3: Write `src/engine/retire.ts`**

```ts
import { PrEntryMap, PrFacts, RepoGit, Run, isTicketRun } from "../types";

/** Why a run was retired. Reaches the log, never the user. */
export type RetireReason = "unreachable" | "finished" | "abandoned";

/** What the sweep should do with one run this pass. `stamp` and `unstamp` are
 * writes to the record, not deletions: they only move `finishedAt`, which is how
 * the finished window is timed across panel reloads. */
export type RetireVerdict =
  | { action: "keep" }
  | { action: "stamp"; finishedAt: number }
  | { action: "unstamp" }
  | { action: "retire"; reason: RetireReason };

export interface RetireInput {
  run: Run;
  /** Live git state per repo, as `buildRunStatus` already computed it. The
   * source of the veto, and the reason the sweep runs after statuses are built. */
  repos: RepoGit[];
  jiraCategory: string | null;
  prs: PrEntryMap;
  /** Any Claude Code session open in one of this run's directories. */
  hasLiveSession: boolean;
  /** Is an empty `prs` trustworthy as "this run has no PR"? False when PR facts
   * are switched off, where empty means "never asked" — and the difference decides
   * whether rule 3 may fire at all. */
  prsAuthoritative: boolean;
  /** `agentFlow.retireFinishedAfterHours` in ms. 0 retires on sight. */
  finishedAfterMs: number;
  /** `agentFlow.retireAbandonedAfterDays` in ms. 0 disables rule 3. */
  abandonedAfterMs: number;
  nowMs: number;
  /** Injected rather than imported, so every rule is testable without a temp
   * directory — and so this module stays free of `fs`. */
  exists: (p: string) => boolean;
}

/** Has this run's work landed? Either every PR-bearing repo merged, or the ticket
 * is done and no PR is still open. `state === "OPEN"` deliberately rather than
 * `prSignals().open`, which excludes drafts: a draft PR is unmerged work, and its
 * worktree must keep the pointer that leads back to it. */
function landed(i: RetireInput): boolean {
  const all = Object.values(i.prs)
    .map((e) => e.facts)
    .filter((f): f is PrFacts => f !== null);
  if (all.length > 0 && all.every((f) => f.state === "MERGED")) return true;
  return i.jiraCategory === "done" && !all.some((f) => f.state === "OPEN");
}

/**
 * What to do with one run. Three rules, every one of them requiring that no agent
 * is open in the run — see the design spec for the full rationale.
 *
 * The veto is the load-bearing safety property: a record is the only pointer back
 * to its worktree, so uncommitted or unpushed work blocks rules 2 and 3 outright.
 * Rule 1 is exempt because a directory that no longer exists has neither.
 *
 * Pure. Every filesystem question is asked through `exists`.
 */
export function retireVerdict(i: RetireInput): RetireVerdict {
  const stamped = typeof i.run.finishedAt === "number" ? i.run.finishedAt : null;

  // Somebody is working in here. Clear any stamp: a window that started while
  // the run sat idle should not keep running once you reopen an agent in it.
  if (i.hasLiveSession) return stamped !== null ? { action: "unstamp" } : { action: "keep" };

  // Rule 1 — unreachable. `repos.length > 0` so a malformed record with no repos
  // is never vacuously "all gone", and `workspaceFile` is not consulted: several
  // runs share one, so its survival says nothing about any single run.
  if (i.run.repos.length > 0 && i.run.repos.every((r) => !i.exists(r.path))) {
    return { action: "retire", reason: "unreachable" };
  }

  const hasWorkToLose = i.repos.some((r) => r.dirty || r.ahead > 0);

  // Rule 2 — finished, after its grace window.
  if (landed(i) && !hasWorkToLose) {
    if (i.finishedAfterMs <= 0) return { action: "retire", reason: "finished" };
    if (stamped === null) return { action: "stamp", finishedAt: i.nowMs };
    if (i.nowMs - stamped >= i.finishedAfterMs) return { action: "retire", reason: "finished" };
    return { action: "keep" };
  }
  // No longer finished (a PR reopened, a ticket moved back, work appeared): the
  // window restarts from scratch next time rather than resuming mid-count.
  if (stamped !== null) return { action: "unstamp" };

  // Rule 3 — abandoned. Needs a trustworthy empty `prs`, or "no PR" is a guess.
  if (
    i.abandonedAfterMs > 0 &&
    i.prsAuthoritative &&
    i.nowMs - i.run.createdAt >= i.abandonedAfterMs &&
    !isTicketRun(i.run) &&
    Object.keys(i.prs).length === 0 &&
    !hasWorkToLose
  ) {
    return { action: "retire", reason: "abandoned" };
  }

  return { action: "keep" };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/engine/retire.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Gates + commit**

```bash
npm run typecheck && npm test && npm run test:cov && npm run build
git add src/engine/retire.ts test/unit/engine/retire.test.ts
git commit -m "feat(engine): add the run retirement verdict

Three rules — unreachable, finished after a grace window, abandoned — with
uncommitted or unpushed work vetoing the latter two. Pure: path existence is
injected, so no rule needs a temp directory to test."
```

---

### Task 5: Wire the sweep into the Deck

**Files:**
- Modify: `src/deckView.ts:549-650` (`buildAll`) and its import block
- Modify: `test/unit/deckView.test.ts`

**Interfaces:**
- Consumes: `retireVerdict`, `RetireVerdict`, `RetireReason` from `./engine/retire` (Task 4); `Run.finishedAt` (Task 3); `deckGrouping`/`retireFinishedAfterHours`/`retireAbandonedAfterDays` from `getConfig()` (Task 2).
- Produces: a private `sweep(...)` on `DeckPanel` used again by Task 8, and the guarantee that `deck:runs` never carries a retired run.

- [ ] **Step 1: Write the failing tests**

In `test/unit/deckView.test.ts`:

```ts
describe("retire sweep", () => {
  it("drops an unreachable run from the board and deletes its record and PR cache", async () => {
    h.runs = [runFixture({ key: "PROJ-GONE", repos: [{ name: "api", path: "/gone/api", isGit: true, branch: "b" }] })];
    h.exists = (p: string) => !p.startsWith("/gone");
    await showAndSettle();
    expect(lastRuns().map((r) => r.run.key)).not.toContain("PROJ-GONE");
    expect(h.removeRun).toHaveBeenCalledWith(expect.any(String), "PROJ-GONE");
    expect(h.removePrEntries).toHaveBeenCalledWith(expect.any(String), "PROJ-GONE");
  });

  it("stamps a landed run, keeps rendering it, and does not delete it", async () => {
    h.runs = [runFixture({ key: "PROJ-DONE" })];
    h.getStatus = vi.fn(async () => ({ status: "Done", category: "done" }));
    await showAndSettle();
    expect(h.writeRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ key: "PROJ-DONE", finishedAt: expect.any(Number) }),
    );
    expect(h.removeRun).not.toHaveBeenCalled();
    expect(lastRuns().map((r) => r.run.key)).toContain("PROJ-DONE");
  });

  it("retires a landed run once its stamp is older than the window", async () => {
    setConfig({ retireFinishedAfterHours: 1 });
    h.runs = [runFixture({ key: "PROJ-OLD", finishedAt: Date.now() - 2 * 3_600_000 })];
    h.getStatus = vi.fn(async () => ({ status: "Done", category: "done" }));
    await showAndSettle();
    expect(h.removeRun).toHaveBeenCalledWith(expect.any(String), "PROJ-OLD");
    expect(lastRuns().map((r) => r.run.key)).not.toContain("PROJ-OLD");
  });

  it("still sees open sessions with the Open agents toggle off, so it cannot retire live work", async () => {
    setConfig({ openAgents: false });
    h.runs = [runFixture({ key: "PROJ-LIVE", repos: [{ name: "api", path: "/repos/api", isGit: true, branch: "b" }] })];
    h.openSessions = [{ pid: 3, sessionId: "s1", cwd: "/repos/api", startedAt: 1, name: "api-1a" }];
    h.exists = () => false; // rule 1 would fire but for the live session
    await showAndSettle();
    expect(h.removeRun).not.toHaveBeenCalled();
    // The toggle still does its own job: no agents are attached to the card.
    expect(lastRuns()[0].agents).toEqual([]);
  });

  it("never writes a record for a local card, which has none on disk", async () => {
    h.runs = [];
    h.openSessions = [{ pid: 4, sessionId: "s2", cwd: "/repos/loose", startedAt: 1, name: "loose-1a" }];
    await showAndSettle();
    expect(h.writeRun).not.toHaveBeenCalled();
    expect(h.removeRun).not.toHaveBeenCalled();
  });

  it("sweeps review runs, which never render as cards", async () => {
    h.runs = [runFixture({ key: "review-svc-1", kind: "review", url: "https://github.com/o/r/pull/1",
      repos: [{ name: "svc", path: "/gone/svc", isGit: true, branch: "b" }] })];
    h.exists = () => false;
    await showAndSettle();
    expect(h.removeRun).toHaveBeenCalledWith(expect.any(String), "review-svc-1");
  });
});
```

Add `exists: ((p: string) => boolean) | null` to the hoisted `h` block (defaulting to `null` so untouched tests keep real behaviour), reset it in the suite's `beforeEach`, and mock `fs.existsSync` through it — following whatever mocking style the suite already uses for `fs`. If it does not mock `fs` yet, inject instead: give `DeckPanel` a `private readonly exists: (p: string) => boolean = fs.existsSync` field and have the test construct through the existing `show()` path with `setConfig` only, mocking `node:fs` via `vi.mock` at the top of the file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/deckView.test.ts -t "retire sweep"`
Expected: FAIL — the unreachable run is still posted and `removeRun` was never called.

- [ ] **Step 3: Read sessions unconditionally**

In `buildAll`, replace the `places` assignment:

```ts
    // Read unconditionally: `openAgents` is a *display* toggle, but the retire
    // sweep must never mistake "not showing agents" for "no agent is running" —
    // that would retire a run with somebody actively working in it.
    const allPlaces = groupByPlace(readOpenSessions(defaultSessionsDir()));
    const places = this.openAgents ? allPlaces : new Map<string, OpenSession[]>();
    const livePlaces = new Set(allPlaces.keys());
```

- [ ] **Step 4: Add the sweep**

Add these two private methods to `DeckPanel`:

```ts
  /** Apply one verdict. Returns true when the run should leave the board. */
  private applyVerdict(run: Run, v: RetireVerdict): boolean {
    const dir = defaultRunsDir();
    switch (v.action) {
      case "retire":
        removeRun(dir, run.key);
        removePrEntries(defaultPrFactsDir(), run.key);
        // Any fetch already in flight belongs to the incarnation just deleted.
        this.prEpoch.set(run.key, (this.prEpoch.get(run.key) ?? 0) + 1);
        this.log(`deck: retired ${run.key} (${v.reason})`);
        return true;
      case "stamp":
        writeRun(dir, { ...run, finishedAt: v.finishedAt });
        return false;
      case "unstamp": {
        const { finishedAt: _dropped, ...rest } = run;
        writeRun(dir, rest);
        return false;
      }
      default:
        return false;
    }
  }

  /** The verdict for one run. `overrideGates` ignores both time windows — that is
   * what Clear stale means, and the counting pass uses it too. */
  private verdictFor(
    s: RunStatus,
    livePlaces: ReadonlySet<string>,
    nowMs: number,
    overrideGates = false,
  ): RetireVerdict {
    const cfg = getConfig();
    return retireVerdict({
      run: s.run,
      repos: s.repos,
      jiraCategory: s.jiraCategory,
      prs: s.prs,
      hasLiveSession: s.run.repos.some((r) => livePlaces.has(canon(r.path))),
      prsAuthoritative: this.prFacts,
      finishedAfterMs: overrideGates ? 0 : cfg.retireFinishedAfterHours * 3_600_000,
      abandonedAfterMs: overrideGates ? 1 : cfg.retireAbandonedAfterDays * 86_400_000,
      nowMs,
      exists: (p) => fs.existsSync(p),
    });
  }
```

Import `retireVerdict` and `RetireVerdict` from `./engine/retire` at the top of the file.

- [ ] **Step 5: Call it from `buildAll`**

Replace the `out.push(buildRunStatus({...}))` tail so the loop collects statuses and then filters:

```ts
      const status = buildRunStatus({
        run, jira, projectsRoot, nowMs: now,
        liveSignal: this.liveSignal, openIdentities, prs,
        agents: agentsByKey.get(run.key) ?? [],
      });
      // A local card has no record on disk — `removeRun` would be a no-op but
      // `writeRun` would *create* one, promoting a card the user never tracked.
      if (runKind(run) === "local") {
        out.push(status);
        continue;
      }
      if (!this.applyVerdict(run, this.verdictFor(status, livePlaces, now))) out.push(status);
```

- [ ] **Step 6: Sweep review runs too**

Review runs are filtered out before statuses are built, so they never reach the loop above — but their records and worktrees accumulate all the same. Add a third method and call it from `buildAll` just before the `return out`:

```ts
  /**
   * Review runs never render as cards, so they never get a `RunStatus` — but they
   * still pile up in the store. Sweep them with the same rules against a
   * git-only status: no Jira (a review run's url is a PR's) and no PR facts,
   * which are never fetched for them. `prsAuthoritative: true` is honest here in
   * a way it would not be for a tracked run: the map is *structurally* empty for
   * a review run, not merely unfetched, so rule 3's "no PR" test is sound.
   */
  private sweepReviewRuns(livePlaces: ReadonlySet<string>, nowMs: number, overrideGates = false): void {
    for (const run of readRuns(defaultRunsDir()).filter((r) => runKind(r) === "review")) {
      // Computed once and passed in: the counting pass in Task 8 asks for a
      // second verdict on the same run, and git state cannot change between them.
      const repos = run.repos.map((r) => gitState(r.name, r.path));
      this.applyVerdict(run, this.reviewVerdictFor(run, repos, livePlaces, nowMs, overrideGates));
    }
  }

  /** One review run's verdict, against a git-only picture. */
  private reviewVerdictFor(
    run: Run,
    repos: RepoGit[],
    livePlaces: ReadonlySet<string>,
    nowMs: number,
    overrideGates: boolean,
  ): RetireVerdict {
    const cfg = getConfig();
    return retireVerdict({
      run,
      repos,
      jiraCategory: null,
      prs: {},
      hasLiveSession: run.repos.some((r) => livePlaces.has(canon(r.path))),
      prsAuthoritative: true,
      finishedAfterMs: overrideGates ? 0 : cfg.retireFinishedAfterHours * 3_600_000,
      abandonedAfterMs: overrideGates ? 1 : cfg.retireAbandonedAfterDays * 86_400_000,
      nowMs,
      exists: (p) => fs.existsSync(p),
    });
  }
```

Add `RepoGit` to the type import from `./types`.

Import `gitState` from `./engine/git` (the file already imports `currentBranch`, `prEligible`, `repoRoot` and `taskDiff` from there — add it to that list). Call `this.sweepReviewRuns(livePlaces, now);` immediately before `return out;`.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: PASS.

- [ ] **Step 8: Gates + commit**

```bash
npm run typecheck && npm test && npm run test:cov && npm run build
git add src/deckView.ts test/unit/deckView.test.ts
git commit -m "feat(deck): retire runs that are provably over

Sweeps after statuses are built, so the veto can read real git state. Local
cards are skipped — they have no record to write — and review runs get their
own git-only pass, since they never render as cards. Sessions are now read
regardless of the Open agents toggle: that toggle is about display, and
treating it as 'no agent is running' would retire live work."
```

---

### Task 6: The card projection

Pure, so the column decisions are testable without rendering anything.

**Files:**
- Create: `src/webview/deckCards.ts`
- Create: `test/webview/deckCards.test.ts`

**Interfaces:**
- Consumes: `deriveBucket`, `prSignals` from `../engine/bucket` (Task 1); `CardAgent.repo` (Task 3).
- Produces:

```ts
export interface DeckCard {
  id: string;              // React key
  status: RunStatus;       // the owning run — ticket, repos, PRs, actions
  agent: CardAgent | null; // null = a parked card, one per agentless run
  column: DeckColumn;
}
export function projectCards(runs: RunStatus[]): DeckCard[];
```

- [ ] **Step 1: Write the failing test**

Create `test/webview/deckCards.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { projectCards } from "../../src/webview/deckCards";
import type { AgentActivity, CardAgent, PrEntryMap, PrFacts, RunStatus } from "../../src/types";

const mkAgent = (sessionId: string, state: AgentActivity["state"], repo = "api"): CardAgent => ({
  session: { pid: 1, sessionId, cwd: `/r/${repo}`, startedAt: 1, name: sessionId },
  activity: { state, lastActivityMs: 100, slug: null },
  repo,
});

const facts = (over: Partial<PrFacts> = {}): PrFacts => ({
  number: 1, url: "u", title: "t", state: "OPEN", isDraft: false,
  ci: { passing: 1, pending: 0, failing: [] }, review: "none", unresolved: null,
  mergeable: "clean", ciAdvisory: false, ...over,
});
const prs = (f: PrFacts): PrEntryMap => ({ api: { facts: f, fetchedAt: 0 } });

const mkStatus = (over: Partial<RunStatus> = {}): RunStatus => ({
  run: { key: "PROJ-1", summary: "s", url: "https://jira/browse/PROJ-1", createdAt: 1,
    mode: "per-window", repos: [{ name: "api", path: "/r/api", isGit: true, branch: "b" }], briefPaths: [] },
  column: "progress", jiraStatus: "In Progress", jiraCategory: "indeterminate",
  repos: [{ name: "api", path: "/r/api", branch: "b", dirty: false, ahead: 0, added: 0, removed: 0, files: 0 }],
  agent: { state: "unknown", lastActivityMs: null, slug: null },
  windowOpen: false, prs: {}, agents: [], ...over,
});

describe("projectCards", () => {
  it("makes one card per agent, keyed by session id", () => {
    const cards = projectCards([mkStatus({ agents: [mkAgent("s1", "working"), mkAgent("s2", "idle")] })]);
    expect(cards.map((c) => c.id)).toEqual(["a:s1", "a:s2"]);
    expect(cards.every((c) => c.agent !== null)).toBe(true);
  });

  it("splits one run across columns by each agent's own state", () => {
    const cards = projectCards([mkStatus({ agents: [mkAgent("s1", "working"), mkAgent("s2", "needs-you")] })]);
    expect(cards.map((c) => c.column)).toEqual(["progress", "needs"]);
  });

  it("still lets a blocked PR outrank a working agent, per run", () => {
    const cards = projectCards([mkStatus({
      agents: [mkAgent("s1", "working")],
      prs: prs(facts({ mergeable: "conflicting" })),
    })]);
    expect(cards[0].column).toBe("needs");
  });

  it("makes one parked card for an agentless run, keeping the host's own column", () => {
    const cards = projectCards([mkStatus({ agents: [], column: "review" })]);
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe("p:PROJ-1");
    expect(cards[0].agent).toBeNull();
    expect(cards[0].column).toBe("review");
  });

  it("never collides an agent card with a parked card", () => {
    const parked = mkStatus({ run: { ...mkStatus().run, key: "s1" }, agents: [] });
    const live = mkStatus({ agents: [mkAgent("s1", "working")] });
    const ids = projectCards([parked, live]).map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("carries the owning status onto every card so the ticket and PR still render", () => {
    const s = mkStatus({ agents: [mkAgent("s1", "working"), mkAgent("s2", "idle")] });
    expect(projectCards([s]).every((c) => c.status === s)).toBe(true);
  });

  it("returns nothing for no runs", () => {
    expect(projectCards([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/webview/deckCards.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/webview/deckCards"`.

- [ ] **Step 3: Write `src/webview/deckCards.ts`**

```ts
import { CardAgent, DeckColumn, RunStatus } from "../types";
import { deriveBucket, prSignals } from "../engine/bucket";

/** One card on the Agents board. A run with two agents open in it produces two of
 * these; a run with none produces exactly one, with `agent: null`. */
export interface DeckCard {
  /** React key. Prefixed because a run key and a session id are both opaque
   * strings from different namespaces and could otherwise collide. */
  id: string;
  /** The owning run's status — where the ticket, repo chips, PR block and every
   * card action still come from. Shared by reference across sibling cards. */
  status: RunStatus;
  /** null on a parked card: the run has no agent open in it. */
  agent: CardAgent | null;
  column: DeckColumn;
}

/**
 * Re-project the runs the host posted into per-agent cards.
 *
 * An agent card is bucketed by *its own* state, which is the whole point of the
 * view: a run with one agent working and one that ended its turn belongs in two
 * columns at once, and the run-level `mostActive` reduction the host does can only
 * ever report one of them.
 *
 * A parked card keeps `status.column` untouched rather than re-deriving it. The
 * host computed that from the run's own transcript reads, which still say
 * something useful about an agentless run (a session that exited two minutes ago
 * leaves a warm transcript) — and `stateView` renders from the same source, so
 * re-deriving here would let the dot and the column disagree.
 */
export function projectCards(runs: RunStatus[]): DeckCard[] {
  const cards: DeckCard[] = [];
  for (const status of runs) {
    if (status.agents.length === 0) {
      cards.push({ id: `p:${status.run.key}`, status, agent: null, column: status.column });
      continue;
    }
    const pr = prSignals(status.prs);
    for (const agent of status.agents) {
      cards.push({
        id: `a:${agent.session.sessionId}`,
        status,
        agent,
        column: deriveBucket({
          jiraCategory: status.jiraCategory,
          jiraStatus: status.jiraStatus,
          agentState: agent.activity.state,
          prOpen: pr.open,
          prBlocked: pr.blocked,
          prMerged: pr.merged,
        }),
      });
    }
  }
  return cards;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/webview/deckCards.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the browser bundle still builds**

Run: `npm run build`
Expected: success. This is the real check that `engine/bucket.ts` is importable from a `platform: "browser"` entry point — a stray `fs` import would fail here, not in the tests.

- [ ] **Step 6: Gates + commit**

```bash
npm run typecheck && npm test && npm run test:cov && npm run build
git add src/webview/deckCards.ts test/webview/deckCards.test.ts
git commit -m "feat(deck): project run statuses into per-agent cards"
```

---

### Task 7: Render the Agents view, with the persisted switch

**Files:**
- Modify: `src/webview/DeckApp.tsx` (`Card` gains two props; `DeckApp` gains grouping state, the segmented control, and two board paths)
- Modify: `src/webview/deckStyles.ts` (segmented-control active state, agent-name line)
- Modify: `src/types.ts` (`deck:setGrouping` inbound, `grouping` on `deck:runs`)
- Modify: `src/deckView.ts` (persist and echo the grouping)
- Modify: `test/webview/DeckApp.test.tsx`, `test/unit/deckView.test.ts`

**Interfaces:**
- Consumes: `projectCards`, `DeckCard` from `./deckCards` (Task 6); `deckGrouping` from `getConfig()` (Task 2).
- Produces: `{ type: "deck:setGrouping"; grouping: "agents" | "workspaces" }` inbound; `grouping: "agents" | "workspaces"` on every `deck:runs`.

**Design note — one card component, not two.** `Card` already renders the ticket, title, branch, repo chips, PR blocks, Jira pill and every action. An agent card differs in exactly three ways: the state line reads the agent's activity instead of the run's, the agent's name appears on that line, and `Open`/`Diff` carry `repo`. So `Card` takes `agent: CardAgent | null` and `column: DeckColumn`; `AgentsRow` renders only when `agent === null`. Workspaces mode passes `agent={null} column={r.column}` and is bit-for-bit what ships today.

- [ ] **Step 1: Write the failing tests**

In `test/webview/DeckApp.test.tsx` — note `runsMsg` must be extended with `grouping` for every existing test, so update the helper itself:

```ts
const runsMsg = (runs: RunStatus[], prReviewStatus = "PR initiated",
                grouping: "agents" | "workspaces" = "agents"): OutboundMessage =>
  ({ type: "deck:runs", runs, liveSignal: true, prFacts: true, openAgents: true,
     reviewQueue: true, ghNote: null, prReviewStatus, grouping });
```

`reviewQueue` is not yours — it arrived with the Review queue toggle in `2ce0996`.
Keep whatever fields the helper has when you get there and only add `grouping`;
if the helper has drifted again, follow the current shape rather than this snippet.

Then add:

```ts
describe("Agents view", () => {
  it("renders one card per agent, each with its own state and name", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ agents: [
      { ...mkAgent("agent-flow-2e", "working", 100), repo: "svc" },
      { ...mkAgent("svc-7f", "needs-you", 200), repo: "svc" },
    ] })]));
    expect(screen.getByText("agent-flow-2e")).toBeInTheDocument();
    expect(screen.getByText("svc-7f")).toBeInTheDocument();
    expect(screen.getByText(/working ·/)).toBeInTheDocument();
    expect(screen.getByText(/ended turn ·/)).toBeInTheDocument();
    // One run, two cards, so the ticket appears twice.
    expect(screen.getAllByText("PROJ-1")).toHaveLength(2);
  });

  it("sends the agent's own repo with Open, so each opens its own directory", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ agents: [{ ...mkAgent("a1", "working", 100), repo: "web" }] })]));
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:inspect", key: "PROJ-1", action: "open", repo: "web" });
  });

  it("renders one parked card with no agent name for an agentless run", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ agents: [], agent: { state: "unknown", lastActivityMs: null, slug: null } })]));
    expect(screen.getByText(/parked · git \+ Jira only/)).toBeInTheDocument();
    expect(screen.getAllByText("PROJ-1")).toHaveLength(1);
  });

  it("collapses to one card per run when Open agents is off", () => {
    render(<DeckApp />);
    host({ ...runsMsg([mkStatus({ agents: [] })]), openAgents: false } as OutboundMessage);
    expect(screen.getAllByText("PROJ-1")).toHaveLength(1);
  });

  it("shows the workspace view's nested agents row instead when grouping is workspaces", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ agents: [{ ...mkAgent("agent-flow-2e", "working", 100), repo: "svc" }] })],
                 "PR initiated", "workspaces"));
    // The collapsed agents row, not a card per agent.
    expect(screen.getByTitle(/sessions open in this directory/i)).toBeInTheDocument();
    expect(screen.getAllByText("PROJ-1")).toHaveLength(1);
  });

  it("asks the host to persist the grouping when the control is clicked", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    fireEvent.click(screen.getByRole("button", { name: "Workspaces" }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:setGrouping", grouping: "workspaces" });
  });
});
```

In `test/unit/deckView.test.ts`:

```ts
  it("persists the grouping globally and echoes it back on the next post", async () => {
    await showAndSettle();
    await onMessage({ type: "deck:setGrouping", grouping: "workspaces" });
    const cfg = workspace.getConfiguration("agentFlow");
    expect(cfg.update).toHaveBeenCalledWith("deckGrouping", "workspaces", ConfigurationTarget.Global);
    expect(lastPost("deck:runs").grouping).toBe("workspaces");
  });
```

Use the suite's existing helpers for dispatching an inbound message and reading the last post of a given type; if they are named differently, use the existing names. Import `ConfigurationTarget` from `../_mocks/vscode`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/webview/DeckApp.test.tsx test/unit/deckView.test.ts`
Expected: FAIL — no `Workspaces` button, and `deck:setGrouping` is not in the union.

- [ ] **Step 3: Widen the message types**

In `src/types.ts`, add to `InboundMessage` beside the other `deck:` entries:

```ts
  | { type: "deck:setGrouping"; grouping: "agents" | "workspaces" }
```

And add the field to `deck:runs` — append to whatever the union member holds when
you get there rather than retyping this line, which was accurate at
`0c35f56` and gains a field every few releases:

```ts
  | { type: "deck:runs"; runs: RunStatus[]; liveSignal: boolean; prFacts: boolean; openAgents: boolean; reviewQueue: boolean; ghNote: string | null; prReviewStatus: string;
      // Which lens to render. Echoed on every post rather than sent once, so a
      // reload or a settings-page edit lands without a separate message.
      grouping: "agents" | "workspaces" }
```

- [ ] **Step 4: Persist and echo it in `deckView.ts`**

In `refresh()`'s post, add `grouping: getConfig().deckGrouping,` beside `prReviewStatus`. In `onMessage`, add:

```ts
      case "deck:setGrouping":
        // Persisted, unlike the three trust toggles beside it: a view preference
        // re-picked on every panel open is a daily papercut.
        await vscode.workspace
          .getConfiguration("agentFlow")
          .update("deckGrouping", m.grouping, vscode.ConfigurationTarget.Global);
        await this.refreshBusy();
        break;
```

- [ ] **Step 5: Give `Card` the two new props**

In `src/webview/DeckApp.tsx`, change the signature and the three places that read run-level state:

```tsx
function Card({ r, live, prReviewStatus, onForget, agent, column }: {
  r: RunStatus; live: boolean; prReviewStatus: string; onForget: (key: string) => void;
  /** Non-null on the Agents board: this card is that one session, and its state
   * line, name and action target come from the agent rather than the run. */
  agent: CardAgent | null;
  column: DeckColumn;
}): JSX.Element {
  const col = COLUMNS.find((c) => c.id === column)!;
  const accent = `var(${col.varName})`;
  // The agent's own activity when this card is an agent; the run's reduction
  // otherwise. `column` is threaded in rather than read off `r` for the same
  // reason: on the Agents board both are per-session.
  const sv = stateView({ ...r, agent: agent ? agent.activity : r.agent, column }, live);
```

Replace `r.column === "needs"` in the wrapper `className` with `column === "needs"`. After the `<span className={...status}>` block in `.c-top`, render the name:

```tsx
        {agent && (
          <span className="c-agent id" title={`Claude Code session in ${agent.repo ?? r.run.repos[0]?.name ?? "this run"}`}>
            {agent.session.name ?? agent.session.sessionId.slice(0, 8)}
          </span>
        )}
```

Change the two inspect calls to carry the agent's repo, and gate `AgentsRow`:

```tsx
            onClick={() => send({ type: "deck:inspect", key: r.run.key, action: "open", ...(agent?.repo ? { repo: agent.repo } : {}) })}
```
```tsx
          <button className="act" title="Show everything this task changed, as a diff" onClick={() => send({ type: "deck:inspect", key: r.run.key, action: "diff", ...(agent?.repo ? { repo: agent.repo } : {}) })}>Diff</button>
```
```tsx
      {agent === null && <AgentsRow agents={r.agents} />}
```

Import `DeckColumn` and `CardAgent` (already imported) plus `projectCards`/`DeckCard` from `./deckCards`.

- [ ] **Step 6: Add the grouping state, the control, and the two board paths**

In `DeckApp`, beside the other toggles:

```tsx
  const [grouping, setGrouping] = React.useState<"agents" | "workspaces">("agents");
```

Set it in the `deck:runs` handler (`setGrouping(m.grouping);`). Add the control right after the existing `.ctls` block:

```tsx
        <div className="ctls seg">
          {(["agents", "workspaces"] as const).map((g) => (
            <button
              key={g}
              type="button"
              className={`ctl ${grouping === g ? "on" : ""}`}
              title={g === "agents"
                ? "One card per Claude Code agent, with the repo, ticket and PR it belongs to"
                : "One card per launched task, with its agents nested underneath"}
              onClick={() => { setGrouping(g); send({ type: "deck:setGrouping", grouping: g }); }}
            >
              {g === "agents" ? "Agents" : "Workspaces"}
            </button>
          ))}
        </div>
```

Replace the column body so each column renders from whichever list the mode calls for. Compute the cards once, above the `return`:

```tsx
  // One list either way, so the columns, counts, stat tiles and sort all read
  // from the same shape. Workspaces mode is today's board exactly: one card per
  // run, agent nested, bucketed by the run's own column.
  const cards: DeckCard[] = grouping === "agents"
    ? projectCards(runs)
    : runs.map((r) => ({ id: `w:${r.run.key}`, status: r, agent: null, column: r.column }));
```

Then in the board, rename the `COLUMNS.map` callback's parameter from `c` to `col`
(it would otherwise shadow the card variable below) and replace the
`runs.filter(...).sort(...)` chain with this. Sorting reads the agent's own
activity on an agent card and the run's reduction on a parked one, so a column
still orders by "most recently alive":

```tsx
            const list = cards
              .filter((c) => c.column === col.id)
              .sort((a, b) =>
                ((b.agent?.activity ?? b.status.agent).lastActivityMs ?? 0) -
                ((a.agent?.activity ?? a.status.agent).lastActivityMs ?? 0) ||
                b.status.run.createdAt - a.status.run.createdAt);
```

Every other reference to `c` inside that callback (`c.varName`, `c.label`, `c.id`)
becomes `col.*`. The card render becomes:

```tsx
                  {list.map((c) => (
                    <Card key={c.id} r={c.status} live={live} prReviewStatus={prReviewStatus}
                      onForget={forget} agent={c.agent} column={c.column} />
                  ))}
```

Update the four stat tiles and the empty-state check to count `cards` rather than `runs` (`cards.filter((c) => c.column === "progress").length`, and `cards.length` for Total); keep the empty-state guard on `runs.length === 0`, since "no tasks in flight" is about runs, not cards.

- [ ] **Step 7: Style the segmented control and the agent name**

In `src/webview/deckStyles.ts`, after the `.ctl.on .switch` rules (line 74):

```css
  /* A segmented control, not a switch: `.ctls` already draws the joined frame,
     so the active side only needs to read as pressed. No .switch inside these. */
  .ctls.seg .ctl.on { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
```

And beside the `.c-top` / `.sdot` rules:

```css
  /* An agent's name is an identifier, so it earns the mono treatment. Pushed to
     the trailing edge so the state dot stays at one x down the whole column. */
  .c-agent { margin-left: auto; flex: none; color: var(--vscode-foreground); font-size: 11px;
    max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run test/webview/DeckApp.test.tsx test/unit/deckView.test.ts`
Expected: PASS. Existing `DeckApp` tests must pass unchanged apart from the `runsMsg` helper gaining `grouping`.

- [ ] **Step 9: Gates + commit**

```bash
npm run typecheck && npm test && npm run test:cov && npm run build
git add src/types.ts src/deckView.ts src/webview/DeckApp.tsx src/webview/deckStyles.ts test/webview/DeckApp.test.tsx test/unit/deckView.test.ts
git commit -m "feat(deck): default the board to one card per agent

One Card component drives both lenses: an agent prop swaps the state line,
adds the session name, and scopes Open and Diff to that agent's own repo.
The Agents/Workspaces control persists to settings, unlike the trust
toggles beside it."
```

---

### Task 8: `Clear stale`

**Files:**
- Modify: `src/types.ts` (`deck:clearStale` inbound, `staleCount` on `deck:runs`)
- Modify: `src/deckView.ts` (count during the sweep; handle the message)
- Modify: `src/webview/DeckApp.tsx` (the button)
- Modify: `test/unit/deckView.test.ts`, `test/webview/DeckApp.test.tsx`

**Interfaces:**
- Consumes: `verdictFor`, `sweepReviewRuns`, `applyVerdict` from Task 5; `staleCount` plumbing follows `grouping` from Task 7.
- Produces: `{ type: "deck:clearStale" }` inbound; `staleCount: number` on `deck:runs`.

- [ ] **Step 1: Write the failing tests**

In `test/unit/deckView.test.ts`:

```ts
describe("Clear stale", () => {
  it("counts runs that would retire if both windows were ignored", async () => {
    h.runs = [runFixture({ key: "PROJ-DONE" })];
    h.getStatus = vi.fn(async () => ({ status: "Done", category: "done" }));
    setConfig({ retireFinishedAfterHours: 999 });
    await showAndSettle();
    expect(lastPost("deck:runs").staleCount).toBe(1);
    expect(h.removeRun).not.toHaveBeenCalled(); // counted, not cleared
  });

  it("clears them on request, after the user confirms", async () => {
    h.runs = [runFixture({ key: "PROJ-DONE" })];
    h.getStatus = vi.fn(async () => ({ status: "Done", category: "done" }));
    setConfig({ retireFinishedAfterHours: 999 });
    window.showWarningMessage.mockResolvedValueOnce("Clear 1");
    await showAndSettle();
    await onMessage({ type: "deck:clearStale" });
    expect(h.removeRun).toHaveBeenCalledWith(expect.any(String), "PROJ-DONE");
  });

  it("clears nothing when the user declines", async () => {
    h.runs = [runFixture({ key: "PROJ-DONE" })];
    h.getStatus = vi.fn(async () => ({ status: "Done", category: "done" }));
    setConfig({ retireFinishedAfterHours: 999 });
    window.showWarningMessage.mockResolvedValueOnce(undefined);
    await showAndSettle();
    await onMessage({ type: "deck:clearStale" });
    expect(h.removeRun).not.toHaveBeenCalled();
  });

  it("still respects the veto — dirty work is never cleared in bulk", async () => {
    h.runs = [runFixture({ key: "PROJ-DIRTY" })];
    h.getStatus = vi.fn(async () => ({ status: "Done", category: "done" }));
    h.buildRunStatus = vi.fn((i) => ({
      ...passThroughStatus(i),
      repos: [{ name: "api", path: "/r/api", branch: "b", dirty: true, ahead: 0, added: 1, removed: 0, files: 1 }],
    }));
    window.showWarningMessage.mockResolvedValueOnce("Clear 1");
    await showAndSettle();
    await onMessage({ type: "deck:clearStale" });
    expect(h.removeRun).not.toHaveBeenCalled();
  });
});
```

Use the suite's existing pass-through `buildRunStatus` helper rather than `passThroughStatus` if it is named differently.

In `test/webview/DeckApp.test.tsx`:

```ts
  it("offers Clear stale only when something is actually stale", () => {
    render(<DeckApp />);
    host({ ...runsMsg([mkStatus()]), staleCount: 0 } as OutboundMessage);
    expect(screen.queryByRole("button", { name: /clear stale/i })).not.toBeInTheDocument();
    host({ ...runsMsg([mkStatus()]), staleCount: 2 } as OutboundMessage);
    fireEvent.click(screen.getByRole("button", { name: /clear stale \(2\)/i }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:clearStale" });
  });
```

and add `staleCount: 0` to the shared `runsMsg` helper.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/deckView.test.ts -t "Clear stale" test/webview/DeckApp.test.tsx -t "Clear stale"`
Expected: FAIL — `staleCount` is undefined and `deck:clearStale` is not in the union.

- [ ] **Step 3: Widen the message types**

In `src/types.ts`, add to `InboundMessage`:

```ts
  | { type: "deck:clearStale" }
```

And to `deck:runs`, beside `grouping`:

```ts
      // How many runs would retire right now if both retirement windows were
      // ignored. Drives the Clear stale button, which is hidden at zero.
      staleCount: number;
```

- [ ] **Step 4: Count during the sweep**

Add the field the post will read:

```ts
  /** How many run records `Clear stale` would take right now — the sweep's own
   * verdict with both time gates ignored. Recomputed on every `buildAll`. */
  private staleCount = 0;
```

Declare `let stale = 0;` just before `buildAll`'s status loop, and change the
non-local branch from Task 5 to count what it kept:

```ts
      if (this.applyVerdict(run, this.verdictFor(status, livePlaces, now))) continue;
      // Counted, not cleared: this is exactly what Clear stale would take. The
      // second call is free of side effects — `verdictFor` is pure, and only
      // `applyVerdict` ever writes.
      if (this.verdictFor(status, livePlaces, now, true).action === "retire") stale++;
      out.push(status);
```

Review runs need counting too, and `sweepReviewRuns` already walks them. Give it an
optional callback rather than a second walk — Task 5 already had it compute each
run's git state once and pass it to `reviewVerdictFor`, so the counting verdict
costs no extra git calls:

```ts
  private sweepReviewRuns(
    livePlaces: ReadonlySet<string>,
    nowMs: number,
    overrideGates = false,
    onStale?: () => void,
  ): void {
    for (const run of readRuns(defaultRunsDir()).filter((r) => runKind(r) === "review")) {
      const repos = run.repos.map((r) => gitState(r.name, r.path));
      if (this.applyVerdict(run, this.reviewVerdictFor(run, repos, livePlaces, nowMs, overrideGates))) continue;
      if (onStale && this.reviewVerdictFor(run, repos, livePlaces, nowMs, true).action === "retire") onStale();
    }
  }
```

Then in `buildAll`, call it as `this.sweepReviewRuns(livePlaces, now, false, () => stale++);`,
set `this.staleCount = stale;` immediately before `return out;`, and add
`staleCount: this.staleCount,` to `refresh`'s `deck:runs` post.

- [ ] **Step 5: Handle the message**

```ts
      case "deck:clearStale":
        await this.clearStale();
        break;
```

```ts
  /**
   * Retire everything that is only waiting out a window. Rules and vetoes are
   * exactly the sweep's — the *only* difference is that both time gates are
   * ignored — so nothing with uncommitted or unpushed work can be cleared here
   * either. Modal-gated, unlike per-card Forget: a bulk delete earns a
   * confirmation.
   */
  private async clearStale(): Promise<void> {
    const n = this.staleCount;
    if (n === 0) return;
    const label = `Clear ${n}`;
    const answer = await vscode.window.showWarningMessage(
      `Retire ${n} stale run record${n === 1 ? "" : "s"}? Worktrees, branches and commits are left untouched.`,
      { modal: true },
      label,
    );
    if (answer !== label) return;
    const nowMs = Date.now();
    const livePlaces = new Set(groupByPlace(readOpenSessions(defaultSessionsDir())).keys());
    for (const status of await this.buildAll()) {
      if (runKind(status.run) === "local") continue;
      this.applyVerdict(status.run, this.verdictFor(status, livePlaces, nowMs, true));
    }
    this.sweepReviewRuns(livePlaces, nowMs, true);
    await this.refreshBusy();
  }
```

Give `sweepReviewRuns` the `overrideGates` parameter it already takes in Task 5's signature.

- [ ] **Step 6: Add the button**

In `DeckApp`, hold `const [staleCount, setStaleCount] = React.useState(0);`, set it from `m.staleCount`, and render beside the refresh control:

```tsx
        {staleCount > 0 && (
          <button
            type="button"
            className="ctl"
            title="Retire run records that are only waiting out their window. Worktrees, branches and commits are left untouched."
            onClick={() => send({ type: "deck:clearStale" })}
          >
            Clear stale ({staleCount})
          </button>
        )}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run test/unit/deckView.test.ts test/webview/DeckApp.test.tsx`
Expected: PASS.

- [ ] **Step 8: Gates + commit**

```bash
npm run typecheck && npm test && npm run test:cov && npm run build
git add src/types.ts src/deckView.ts src/webview/DeckApp.tsx test/unit/deckView.test.ts test/webview/DeckApp.test.tsx
git commit -m "feat(deck): add Clear stale for runs only waiting out a window

Same rules and same vetoes as the automatic sweep, with both time gates
ignored. Modal-gated, and hidden when nothing qualifies."
```

---

### Task 9: Documentation

**Files:**
- Modify: `README.md` (the Deck section and the settings table)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Find the sections to edit**

Run: `grep -n "openAgents\|prFactsTtlSeconds\|In-flight" README.md | head -20`
Expected: the settings table rows and the Deck description.

- [ ] **Step 2: Document the view**

In the Deck section of `README.md`, after the existing description of the board, add:

```markdown
The board opens with **one card per Claude Code agent** — its live state and
session name lead, and the repo, branch, Jira key and pull request it belongs to
sit underneath, so two agents in one worktree read as two different pieces of
work. Switch the header control to **Workspaces** for one card per launched task
with its agents nested instead; whichever you pick sticks.

Run records retire themselves once a task is provably over: its directories are
gone, it landed a day ago with no agent left in it, or it is an old session with
no ticket, no PR and nothing uncommitted. Uncommitted or unpushed work always
stops a record being retired, and retirement only ever deletes Agent Flow's own
pointer — never a worktree, a branch, or a commit.
```

- [ ] **Step 3: Add the three settings rows**

Match the existing table's column shape exactly:

```markdown
| `agentFlow.deckGrouping` | `agents` | One card per agent, or per launched task (`workspaces`). |
| `agentFlow.retireFinishedAfterHours` | `24` | How long landed work stays on the board after its last agent closes. `0` retires on sight. |
| `agentFlow.retireAbandonedAfterDays` | `7` | How long a ticketless, PR-less, clean run may sit before its record is deleted. `0` disables it. |
```

- [ ] **Step 4: Add the changelog entry**

Under the current unreleased/next heading, following the file's existing style:

```markdown
- **Deck: one card per agent.** The In-flight board now opens with a card per
  Claude Code session, showing the repo, ticket and PR it belongs to. The old
  per-workspace grouping is still there behind the header's **Workspaces**
  control, and your choice persists.
- **Deck: runs retire themselves.** A record is deleted once its directories are
  gone, once it has been landed for `agentFlow.retireFinishedAfterHours` with no
  agent in it, or once an untracked session passes
  `agentFlow.retireAbandonedAfterDays`. Uncommitted or unpushed work always
  blocks it, and only Agent Flow's own pointer is ever deleted. **Clear stale**
  in the header does it on demand.
```

- [ ] **Step 5: Gates + commit**

```bash
npm run typecheck && npm test && npm run test:cov && npm run build
git add README.md CHANGELOG.md
git commit -m "docs: document the Agents view and run auto-retirement"
```

---

## Manual verification

After Task 9, confirm the real thing works — the test suite cannot see a webview render in VS Code.

- [ ] Launch the dev host with **VS Code's** `code` CLI (the Cursor CLI silently drops `--extensionDevelopmentPath`):
  `code --extensionDevelopmentPath=/Users/oznasi/dev/agent-flow --new-window`
- [ ] Open the Deck. Confirm it opens in **Agents** mode with one card per open Claude Code session, each showing its own state, name, repo chips, ticket and PR.
- [ ] With two agents open in one worktree, confirm two cards appear and land in different columns when one ends its turn.
- [ ] Click **Open** on an agent card of a multi-repo run; confirm it opens that agent's own repo.
- [ ] Switch to **Workspaces**; confirm today's board with the nested agents row. Close and reopen the Deck; confirm it comes back in Workspaces.
- [ ] Check `~/.agentflow/runs`: confirm `PROJ-5809` (both worktrees deleted) is gone, and that nothing with uncommitted work was removed.
- [ ] Confirm the Agent Flow output channel logs a `deck: retired <key> (<reason>)` line for each retirement.

---

## Self-Review

**Spec coverage:** Agents view → T6, T7. Parked cards → T6, T7. Four columns unchanged → T6 (reuses `deriveBucket`), T7. Card anatomy → T7. `Open`/`Diff` per-session scope → T3, T7. Degenerate cases (`Open agents` off, `Live signal` off, stat tiles, sort) → T7. Mode switch + persistence → T2, T7. `bucket.ts` extraction → T1. Retire rules 1–3 + veto → T4. `finishedAt` timing → T3, T4, T5. Reading sessions independently of `openAgents` → T5. Review-run sweep → T5. `Clear stale` → T8. Docs → T9.

**Known deviations from the spec, both deliberate:**
1. `mostActive` stays in `status.ts` (T1) — it needs `UNKNOWN_ACTIVITY` from the `fs`-importing `transcript.ts`, and the webview never calls it.
2. Rule 2 cannot fire for a **review** run, because PR facts are never fetched for one, so `landed()` has nothing to read. Review runs are still caught by rules 1 and 3. Fetching PR state for review runs purely to retire them is scope the spec does not ask for.

**Type consistency:** `RetireInput`/`RetireVerdict`/`RetireReason` (T4) are consumed only by T5 and T8 under those names. `DeckCard`/`projectCards` (T6) are consumed by T7 under those names. `Run.finishedAt` and `CardAgent.repo` (T3) are read by T4/T5 and T6/T7 respectively. `grouping` and `staleCount` are added to `deck:runs` in T7 and T8, and both tasks update the shared `runsMsg` test helper so every earlier `DeckApp` test keeps compiling.
