# Deck Attention Badge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Badge the Agent Flow activity-bar icon with the Action-required count and raise one opt-in toast when a run enters Action required, both working while the Deck panel is closed and without any forge traffic.

**Architecture:** One pure reduction (`src/engine/attention.ts`) decides what "Action required" means; the Deck's `buildAll` and a new cheap gatherer (`src/engine/attentionFs.ts`) are its two input paths, so the badge cannot disagree with the column. The gatherer spends transcript reads for every run but git and PR-cache reads only for runs already in a needs agent state. `runAttentionPass` in `src/attentionJob.ts` is one pass, injected end to end so it is testable without timers; `extension.ts` runs it on every other tick of the 6s `setInterval` it already has.

**Tech Stack:** TypeScript on the VS Code extension host, Vitest with the hand-written `vscode` mock at `test/_mocks/vscode.ts`, esbuild bundles.

**Spec:** `docs/superpowers/specs/2026-08-24-deck-attention-badge-design.md` — read it before Task 1. It carries the three decisions (exact Deck parity, focused-window-only announcement, badge on / toast off) and the accepted trade-offs.

## Global Constraints

Every task's requirements implicitly include this section.

- **Worktree.** All work happens in `/Users/oznasi/dev/agent-flow-e1-spec`. Before Task 1, branch: `git checkout -b feat/deck-attention` (off `docs/e1-attention-spec`, so the spec travels with the code). Use absolute paths in every shell command — parallel sessions share the root checkout at `/Users/oznasi/dev/agent-flow` and switch its branch.
- **CI gate is exactly four commands, all must pass:** `npm ci`, `npm run typecheck`, `npm test`, `npm run build`.
- **`npm run build` is a real gate.** Any module reachable from a webview entry point that imports `fs`/`os`/`path`/`child_process` breaks the build even if the code never runs — esbuild resolves statically. `tsc` and most of the suite pass regardless.
- **`npm test` is ~4,500 tests across 122 files and takes 2+ minutes.** It auto-backgrounds at 120s, so pass `timeout: 600000` when running it through a tool. **Never pipe vitest through `tail` or `head`** — it loses the failure list. A single failure under CPU contention is usually flake: re-run that file alone before believing it.
- **Run one file while iterating:** `npx vitest run test/unit/engine/attention.test.ts`.
- **Coverage thresholds are enforced** by `npm run test:cov`: 90% lines/statements, 85% branches/functions.
- **`test/unit/compat.test.ts` must pass UNMODIFIED.** It asserts manifest command ids as an **exact set** — do not add a command. Settings are checked as a superset, so adding a setting is free.
- **Vocabulary invariant, enforced by `test/unit/vocabulary.test.ts`:** user-facing text says **"sessions"**, never "agents". Identifiers keep their released spelling (`run.agents[]` stays `agents`).
- **New behavior ships inert:** `agentFlow.notifyOnActionRequired` defaults to `false`. The badge ships on.
- **No hardcoded organization values.** Settings are read through `getConfig()` in `src/config.ts`.
- **Commit after every task.** End every commit message with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

## File Structure

| File | Responsibility |
| --- | --- |
| `src/engine/activity.ts` | *(modify)* gains `promoteExited` — the "died holding the work" rule, so `status.ts` and the gatherer share one definition |
| `src/engine/attention.ts` | *(create)* pure: `AttentionCandidate`, `attentionKeys`, `ownsWorkToLose`, `nextAnnouncements`. Imports only `../types`, `./bucket`, `./visibility` |
| `src/engine/attentionFs.ts` | *(create)* `gatherAttention` + `defaultAttentionDeps` — candidates from injected cheap readers |
| `src/engine/attentionStore.ts` | *(create)* the cross-window announcement latch at `~/.agentflow/attention.json` |
| `src/engine/status.ts` | *(modify)* calls `promoteExited` instead of inlining it |
| `src/engine/paths.ts` | *(modify)* gains `claudeProjectsRoot`, moved out of `deckView.ts` so two readers can reach it |
| `src/attentionJob.ts` | *(create)* `runAttentionPass` — one pass: badge, then the focus-gated coalesced toast |
| `src/deckView.ts` | *(modify)* `buildAll` builds candidates and calls the shared reduction; `DeckPanel.latestCandidates()` exposes them |
| `src/tasksView.ts` | *(modify)* `setAttention` sets `WebviewView.badge`, holding the value across an unresolved view |
| `src/config.ts`, `package.json` | *(modify)* `notifyOnActionRequired` |
| `src/extension.ts` | *(modify)* runs the pass on every other tick of the existing 6s poll, and builds its deps |
| `test/_mocks/vscode.ts` | *(modify)* gains `window.state` |

---

### Task 1: Share the "died holding the work" rule

`buildRunStatus` inlines the promotion of a mid-work transcript to `exited`. The gatherer needs the identical rule, and a second copy is exactly the fork this feature exists to avoid.

**Files:**
- Modify: `src/engine/activity.ts` (append after `mostActive`)
- Modify: `src/engine/status.ts:86-90`
- Test: `test/unit/engine/activity.test.ts` (create)

**Interfaces:**
- Consumes: nothing
- Produces: `promoteExited(reduced: AgentActivity, liveSessionCount: number): AgentActivity`

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine/activity.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { promoteExited } from "../../../src/engine/activity";
import { AgentActivity } from "../../../src/types";

const act = (over: Partial<AgentActivity> = {}): AgentActivity => ({
  state: "idle", lastActivityMs: 1, slug: null, ...over,
});

describe("promoteExited", () => {
  it("promotes a mid-work transcript with no live session to exited", () => {
    // The one thing a per-file reducer cannot know: nobody is running, and the
    // transcript stops owing work. That agent died holding it.
    expect(promoteExited(act({ midWork: true }), 0).state).toBe("exited");
  });

  it("leaves a working reading alone — a pending tool call moments ago is alive, not dead", () => {
    expect(promoteExited(act({ state: "working", midWork: true }), 0).state).toBe("working");
  });

  it("leaves a mid-work reading alone while a session is still open", () => {
    expect(promoteExited(act({ midWork: true }), 1).state).toBe("idle");
  });

  it("leaves a transcript that finished its turn alone", () => {
    expect(promoteExited(act(), 0).state).toBe("idle");
  });

  it("preserves every other field, so the caller's activity is not rebuilt", () => {
    const out = promoteExited(act({ midWork: true, slug: "fix-ci", lastActivityMs: 42 }), 0);
    expect(out).toEqual({ state: "exited", lastActivityMs: 42, slug: "fix-ci", midWork: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/engine/activity.test.ts`
Expected: FAIL — `promoteExited` is not exported from `activity.ts`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/engine/activity.ts`:

```ts
/**
 * A transcript that stops mid-work with no live session behind it did not finish
 * — the agent died holding the work. "idle" renders that in the calmest tone on
 * the board, which is exactly backwards.
 *
 * Liveness is invisible to a per-file reducer, which is why this is a separate
 * step applied against the session registry rather than a rank in `mostActive`.
 * Deliberately narrow: "has a transcript, no live session" would be half the
 * board on a working machine. `state !== "working"` is also required —
 * `deriveActivity` stamps `midWork` on a transcript written moments ago with a
 * pending tool call, and that reading is alive, however sparse the caller's
 * session list happens to be.
 *
 * Lives here rather than in status.ts so `attentionFs.ts` derives the same state
 * the Deck does. Two copies of this rule is the fork the attention badge exists
 * to avoid.
 */
export function promoteExited(reduced: AgentActivity, liveSessionCount: number): AgentActivity {
  return reduced.midWork && reduced.state !== "working" && liveSessionCount === 0
    ? { ...reduced, state: "exited" }
    : reduced;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/engine/activity.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Point status.ts at it**

In `src/engine/status.ts`, add `promoteExited` to the existing import from `./activity`, then replace the inline expression (the `const agent: AgentActivity = reduced.midWork && …` block around line 86) with:

```ts
  const agent: AgentActivity = promoteExited(reduced, agents.length);
```

Move the long explanatory comment that sat above it into `promoteExited`'s doc comment (Step 3 already carries it) rather than duplicating it.

- [ ] **Step 6: Prove the refactor changed no behavior**

Run: `npx vitest run test/unit/engine/status.test.ts`
Expected: PASS, **unmodified**. If a status test needs editing, the refactor is wrong — stop and re-read Step 5.

- [ ] **Step 7: Typecheck and commit**

```bash
cd /Users/oznasi/dev/agent-flow-e1-spec
npm run typecheck
git add src/engine/activity.ts src/engine/status.ts test/unit/engine/activity.test.ts
git commit -m "refactor(engine): share the died-holding-the-work rule

promoteExited moves out of buildRunStatus into activity.ts so the coming
attention gatherer derives the same agent state the Deck does, rather than
carrying a second copy of the rule.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The shared reduction

**Files:**
- Create: `src/engine/attention.ts`
- Test: `test/unit/engine/attention.test.ts` (create)

**Interfaces:**
- Consumes: `deriveBucket`, `prSignals` from `./bucket`; `shelfFor` from `./visibility`; `runKind`, `isTicketRun` from `../types` — exactly these three specifiers, which the leaf test asserts
- Produces:
  - `interface AttentionCandidate { key: string; agentState: AgentState; prs: PrEntryMap; ticketStatus: string | null; hasLiveSession: boolean; justLaunched: boolean; hasWorkToLose: boolean; showAll: boolean }`
  - `attentionKeys(candidates: readonly AttentionCandidate[]): string[]`
  - `ownsWorkToLose(run: Run): boolean`

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine/attention.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { AttentionCandidate, attentionKeys, ownsWorkToLose } from "../../../src/engine/attention";
import { PrEntryMap, PrFacts, Run } from "../../../src/types";

const facts = (over: Partial<PrFacts> = {}): PrFacts => ({
  number: 1, url: "https://github.com/o/r/pull/1", title: "t", state: "OPEN", isDraft: false,
  ci: { passing: 1, pending: 0, failing: [] }, review: "none", unresolved: null,
  mergeable: "clean", ciAdvisory: false, ...over,
});
const prs = (...f: (PrFacts | null)[]): PrEntryMap =>
  Object.fromEntries(f.map((x, i) => [`repo${i}`, { facts: x, fetchedAt: 0 }]));

const cand = (over: Partial<AttentionCandidate> = {}): AttentionCandidate => ({
  key: "BITE-1", agentState: "needs-you", prs: {}, ticketStatus: null,
  hasLiveSession: true, justLaunched: false, hasWorkToLose: false, showAll: false, ...over,
});

const run = (over: Partial<Run> = {}): Run => ({
  key: "BITE-1", summary: "s", url: "https://jira/BITE-1", createdAt: 0,
  mode: "per-window", repos: [], briefPaths: [], ...over,
});

describe("attention.ts stays a leaf", () => {
  it("imports nothing that could reach a Node builtin", () => {
    const src = fs.readFileSync(path.join(__dirname, "../../../src/engine/attention.ts"), "utf8");
    const specifiers = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(specifiers.sort()).toEqual(["../types", "./bucket", "./visibility"]);
  });
});

describe("attentionKeys", () => {
  it("counts every state that means a human has to do something", () => {
    const keys = attentionKeys([
      cand({ key: "A", agentState: "needs-you" }),
      cand({ key: "B", agentState: "stalled" }),
      cand({ key: "C", agentState: "exited", hasLiveSession: false, justLaunched: true }),
    ]);
    expect(keys).toEqual(["A", "B", "C"]);
  });

  it("ignores a run nobody is waiting on", () => {
    expect(attentionKeys([
      cand({ key: "A", agentState: "working" }),
      cand({ key: "B", agentState: "idle" }),
      cand({ key: "C", agentState: "unknown" }),
    ])).toEqual([]);
  });

  it("drops a merged run — the merge is the answer to the question it asked", () => {
    expect(attentionKeys([cand({ prs: prs(facts({ state: "MERGED" })) })])).toEqual([]);
  });

  it("drops a run the board would have shelved", () => {
    // Exited, nobody in it, no PR, nothing to lose, not just launched: this card
    // is on the Recently closed strip, not in Action required.
    expect(attentionKeys([
      cand({ agentState: "exited", hasLiveSession: false }),
    ])).toEqual([]);
  });

  it("keeps a shelvable run when inflightShowAll is on", () => {
    expect(attentionKeys([
      cand({ key: "A", agentState: "exited", hasLiveSession: false, showAll: true }),
    ])).toEqual(["A"]);
  });

  it("keeps an exited run held on the board by work you could lose", () => {
    expect(attentionKeys([
      cand({ key: "A", agentState: "exited", hasLiveSession: false, hasWorkToLose: true }),
    ])).toEqual(["A"]);
  });

  it("treats a draft PR as work in flight, so an exited run with one stays countable", () => {
    // shelfFor's prOpen counts drafts; prSignals().open does not. Reading the
    // wrong one here would shelve this card and lose the badge.
    expect(attentionKeys([
      cand({ key: "A", agentState: "exited", hasLiveSession: false, prs: prs(facts({ isDraft: true })) }),
    ])).toEqual(["A"]);
  });

  it("never lets the ticket status change an attention verdict", () => {
    // The gatherer passes null because reading Jira on the hidden path is
    // forbidden; the Deck passes the real value. That is only safe while nothing
    // above `needs` in deriveBucket's ladder reads it. This test is the guard.
    for (const ticketStatus of [null, "In Review", "Done", "In Progress", "QA"]) {
      expect(attentionKeys([cand({ ticketStatus })])).toEqual(["BITE-1"]);
      expect(attentionKeys([cand({ ticketStatus, agentState: "working" })])).toEqual([]);
    }
  });

  it("keeps input order, so the count and the board agree on which card is first", () => {
    expect(attentionKeys([cand({ key: "Z" }), cand({ key: "A" })])).toEqual(["Z", "A"]);
  });
});

describe("ownsWorkToLose", () => {
  it("refuses a ticketless Explore run — that dirty checkout is your own work", () => {
    expect(ownsWorkToLose(run({ kind: "explore", url: "" }))).toBe(false);
  });

  it("refuses a ticketless Notepad run for the same reason", () => {
    expect(ownsWorkToLose(run({ kind: "notepad", url: "" }))).toBe(false);
  });

  it("allows an Explore run taken against a ticket — it owns its branch", () => {
    expect(ownsWorkToLose(run({ kind: "explore", url: "https://jira/BITE-1" }))).toBe(true);
  });

  it("allows a plain task run", () => {
    expect(ownsWorkToLose(run())).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/engine/attention.test.ts`
Expected: FAIL — cannot resolve `../../../src/engine/attention`.

- [ ] **Step 3: Write the implementation**

Create `src/engine/attention.ts`:

```ts
// What "Action required" means, in one place. The Deck's `buildAll` and the
// extension host's attention tick are its two input paths, so a badge can never
// disagree with the column it is counting.
//
// Keep this file importing nothing but `../types`, `./bucket` and `./visibility`
// — all three are leaves that touch no Node builtin. attention.test.ts asserts
// the specifier list.
import { AgentState, PrEntryMap, Run, isTicketRun, runKind } from "../types";
import { deriveBucket, prSignals } from "./bucket";
import { shelfFor } from "./visibility";

/** Everything the reduction needs about one run, and nothing it does not.
 *
 * `prOpen` and `merged` are deliberately NOT fields: `shelfFor`'s prOpen counts
 * drafts and `prSignals().open` does not, and a caller that has to remember
 * which is which is a caller that will get it wrong. Both are derived from
 * `prs` below.
 *
 * `ticketStatus` is carried and passed to `deriveBucket` even though nothing
 * above `needs` in its ladder reads it: the Deck supplies the real value, the
 * gatherer supplies null (Jira on the hidden path is forbidden), and a test
 * asserts the two can never diverge. */
export interface AttentionCandidate {
  key: string;
  agentState: AgentState;
  prs: PrEntryMap;
  ticketStatus: string | null;
  hasLiveSession: boolean;
  justLaunched: boolean;
  hasWorkToLose: boolean;
  /** `agentFlow.inflightShowAll` — puts every run on the board unconditionally. */
  showAll: boolean;
}

/** Does this run's dirty/ahead state count as work it would be a shame to lose?
 *
 * An in-place run — Explore or Notepad — opened your checkout rather than
 * creating a worktree, so its dirty state is your own work in progress far more
 * often than the session's, and ownership hands it to whichever record happens
 * to be newest. Counting it pinned such a card to the board for as long as the
 * checkout stayed dirty, which for a repo you work in is forever. Ticketless on
 * purpose: a task run launched in place (`agentFlow.worktree: "never"`) does own
 * its branch and keeps the veto. */
export function ownsWorkToLose(run: Run): boolean {
  const kind = runKind(run);
  return !((kind === "explore" || kind === "notepad") && !isTicketRun(run));
}

/** The keys of every candidate the Deck would draw in Action required, in the
 * order they were handed in. Keys rather than a count: the badge needs only
 * cardinality, but the toast needs to name what parked. */
export function attentionKeys(candidates: readonly AttentionCandidate[]): string[] {
  const out: string[] = [];
  for (const c of candidates) {
    const pr = prSignals(c.prs);
    const shelf = c.showAll
      ? "board"
      : shelfFor({
          hasLiveSession: c.hasLiveSession,
          // Drafts included — a draft PR is unmerged work in flight.
          prOpen: Object.values(c.prs).some((e) => e.facts?.state === "OPEN"),
          merged: pr.merged,
          justLaunched: c.justLaunched,
          hasWorkToLose: c.hasWorkToLose,
        });
    if (shelf !== "board") continue;
    const column = deriveBucket({
      ticketStatus: c.ticketStatus,
      agentState: c.agentState,
      prOpen: pr.open,
      prBlocked: pr.blocked,
      prReady: pr.ready,
      prMerged: pr.merged,
    });
    if (column === "needs") out.push(c.key);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/engine/attention.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Mutation-check the parity guard**

The ticket-status test is the one guarding a real invariant, so prove it can fail. Temporarily change `ticketStatus: c.ticketStatus` to `ticketStatus: "In Review"` in `attentionKeys`, re-run the file, and confirm a test fails. Then `git checkout src/engine/attention.ts` is NOT safe here (it would revert the whole new file, which is uncommitted) — revert the single line by hand instead, and re-run to confirm PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/oznasi/dev/agent-flow-e1-spec
npm run typecheck
git add src/engine/attention.ts test/unit/engine/attention.test.ts
git commit -m "feat(engine): one definition of Action required

attentionKeys runs shelfFor then deriveBucket over an explicit candidate, so
the Deck's column and the coming activity-bar badge are two callers of one
rule rather than two implementations of it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The edge latch

**Files:**
- Modify: `src/engine/attention.ts` (append)
- Test: `test/unit/engine/attention.test.ts` (append a describe block)

**Interfaces:**
- Consumes: nothing from Task 2's exports
- Produces: `nextAnnouncements(current: readonly string[], announced: Record<string, number>, nowMs: number): { toAnnounce: string[]; announced: Record<string, number> }`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/engine/attention.test.ts`:

```ts
describe("nextAnnouncements", () => {
  it("announces a run that just entered Action required", () => {
    const out = nextAnnouncements(["A"], {}, 100);
    expect(out.toAnnounce).toEqual(["A"]);
    expect(out.announced).toEqual({ A: 100 });
  });

  it("says nothing on the next pass — level-triggered, not repeated every tick", () => {
    const first = nextAnnouncements(["A"], {}, 100);
    const second = nextAnnouncements(["A"], first.announced, 200);
    expect(second.toAnnounce).toEqual([]);
    expect(second.announced).toEqual({ A: 100 });
  });

  it("re-announces a run that parked, was answered, and parked again", () => {
    const parked = nextAnnouncements(["A"], {}, 100);
    const answered = nextAnnouncements([], parked.announced, 200);
    expect(answered.toAnnounce).toEqual([]);
    const again = nextAnnouncements(["A"], answered.announced, 300);
    expect(again.toAnnounce).toEqual(["A"]);
    expect(again.announced).toEqual({ A: 300 });
  });

  it("prunes itself — a stamp survives only while its run is still waiting", () => {
    const out = nextAnnouncements([], { GONE: 1, ALSO_GONE: 2 }, 300);
    expect(out.announced).toEqual({});
  });

  it("hands back every new key at once, so the caller can raise one toast", () => {
    const out = nextAnnouncements(["A", "B", "C"], { B: 50 }, 100);
    expect(out.toAnnounce).toEqual(["A", "C"]);
    expect(out.announced).toEqual({ A: 100, B: 50, C: 100 });
  });

  it("does not mutate the record it was given", () => {
    const announced = { A: 1 };
    nextAnnouncements(["B"], announced, 100);
    expect(announced).toEqual({ A: 1 });
  });
});
```

Add `nextAnnouncements` to the existing import at the top of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/engine/attention.test.ts`
Expected: FAIL — `nextAnnouncements` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/engine/attention.ts`:

```ts
/**
 * Which of `current` has not been announced yet, and the record to persist.
 *
 * Level-triggered, unlike the flow engine's `firedAt` (a permanent stamp cleared
 * only by Reset): a stamp survives exactly as long as its key stays in
 * `current`. So a run that parks, gets answered, and parks again is announced
 * twice — the second parking is new news — and the record prunes itself without
 * needing to be told which runs still exist.
 *
 * Pure and total: the caller owns reading and writing the record, and owns the
 * decision about whether this window is the one that gets to announce.
 */
export function nextAnnouncements(
  current: readonly string[],
  announced: Record<string, number>,
  nowMs: number,
): { toAnnounce: string[]; announced: Record<string, number> } {
  const live = new Set(current);
  const next: Record<string, number> = {};
  for (const [key, at] of Object.entries(announced)) {
    if (live.has(key)) next[key] = at;
  }
  const toAnnounce = current.filter((key) => !(key in next));
  for (const key of toAnnounce) next[key] = nowMs;
  return { toAnnounce, announced: next };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/engine/attention.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/oznasi/dev/agent-flow-e1-spec
npm run typecheck
git add src/engine/attention.ts test/unit/engine/attention.test.ts
git commit -m "feat(engine): a level-triggered latch for attention announcements

A stamp lives only while its run is still waiting, so a run answered and
re-parked is announced again and the record needs no separate prune.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The cross-window latch file

**Files:**
- Create: `src/engine/attentionStore.ts`
- Test: `test/unit/engine/attentionStore.test.ts` (create)

**Interfaces:**
- Consumes: nothing
- Produces: `defaultAttentionFile(): string`, `readAnnounced(file: string): Record<string, number>`, `writeAnnounced(file: string, announced: Record<string, number>): void`

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine/attentionStore.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { defaultAttentionFile, readAnnounced, writeAnnounced } from "../../../src/engine/attentionStore";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "attention-"));
  file = path.join(dir, "attention.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("defaultAttentionFile", () => {
  it("sits in ~/.agentflow beside runs/ and prfacts/", () => {
    expect(defaultAttentionFile()).toBe(path.join(os.homedir(), ".agentflow", "attention.json"));
  });
});

describe("readAnnounced", () => {
  it("returns {} for a file that does not exist", () => {
    expect(readAnnounced(file)).toEqual({});
  });

  it("returns {} for corrupt JSON rather than throwing into the poll", () => {
    fs.writeFileSync(file, "{not json");
    expect(readAnnounced(file)).toEqual({});
  });

  it("returns {} for an array, which would silently drop every write", () => {
    fs.writeFileSync(file, "[]");
    expect(readAnnounced(file)).toEqual({});
  });

  it("drops non-number values rather than handing them to the latch", () => {
    fs.writeFileSync(file, JSON.stringify({ A: 1, B: "nope", C: null }));
    expect(readAnnounced(file)).toEqual({ A: 1 });
  });

  it("round-trips what writeAnnounced wrote", () => {
    writeAnnounced(file, { A: 1, B: 2 });
    expect(readAnnounced(file)).toEqual({ A: 1, B: 2 });
  });
});

describe("writeAnnounced", () => {
  it("creates ~/.agentflow when this is the first thing to touch it", () => {
    const nested = path.join(dir, "agentflow", "attention.json");
    writeAnnounced(nested, { A: 1 });
    expect(readAnnounced(nested)).toEqual({ A: 1 });
  });

  it("leaves no temp file behind", () => {
    writeAnnounced(file, { A: 1 });
    expect(fs.readdirSync(dir)).toEqual(["attention.json"]);
  });

  it("swallows an unwritable path — a failed latch write costs a duplicate toast, never a crash", () => {
    expect(() => writeAnnounced(path.join(dir, "attention.json", "nope.json"), { A: 1 })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/engine/attentionStore.test.ts`
Expected: FAIL — cannot resolve `../../../src/engine/attentionStore`.

- [ ] **Step 3: Write the implementation**

Create `src/engine/attentionStore.ts`:

```ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** ~/.agentflow/attention.json — which runs have already had their toast.
 *
 * Cross-window on purpose: every open editor window runs its own extension host
 * over the same runs store, so an in-memory latch would announce the same run
 * once per window, and would forget everything on an extension-host restart.
 *
 * Advisory rather than locked. The worst a lost race can do is raise one
 * duplicate toast, which is not worth the coordination the orchestrator's flows
 * need — and the write is atomic (temp + rename) so a crash mid-write cannot
 * leave a truncated file behind for the next window to read. */
export function defaultAttentionFile(): string {
  return path.join(os.homedir(), ".agentflow", "attention.json");
}

/** The record, or `{}` for a missing, unreadable or corrupt file. Values are
 * filtered to numbers: a hand-edited or half-written file must degrade to
 * "nothing announced yet", never hand the latch something it will compare
 * against a timestamp. */
export function readAnnounced(file: string): Record<string, number> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    // An array passes `typeof === "object"` but takes non-index properties that
    // JSON.stringify silently drops, which would wedge the file at "[]" forever.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, v]) => typeof v === "number"),
    ) as Record<string, number>;
  } catch {
    return {};
  }
}

/** Persist the record. Best-effort: a failed write costs at most one duplicate
 * toast on the next pass, and must never propagate into the poll. */
export function writeAnnounced(file: string, announced: Record<string, number>): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(announced) + "\n");
    fs.renameSync(temp, file);
  } catch {
    // See the doc comment: advisory store, deliberately silent.
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/engine/attentionStore.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/oznasi/dev/agent-flow-e1-spec
npm run typecheck
git add src/engine/attentionStore.ts test/unit/engine/attentionStore.test.ts
git commit -m "feat(engine): a cross-window store for announced attention

N open windows share one latch file, so a run entering Action required
raises one toast rather than one per window.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Gather candidates for tracked runs

The cheap half of the gatherer. Local session cards are Task 6; this task leaves a named seam.

Every reader is **injected**, not called through a module import. Two reasons, both load-bearing: the cost invariant ("no git call for a run nobody is waiting on") is only assertable against a spy, and `readOpenSessions` / `readLiveWindows` both filter their fixtures by *live PID*, so a temp-dir fixture would need two simultaneously-alive process ids to model two sessions. Injection sidesteps both.

**Files:**
- Create: `src/engine/attentionFs.ts`
- Modify: `src/engine/paths.ts` (gains `claudeProjectsRoot`), `src/deckView.ts:77-79` (imports it instead of defining it)
- Test: `test/unit/engine/attentionFs.test.ts` (create)

**Interfaces:**
- Consumes: `AttentionCandidate`, `ownsWorkToLose` (Task 2); `promoteExited`, `mostActive` (Task 1 / `./activity`); `resolveOwnership` from `./ownership`; `canon` from `./paths`; `JUST_LAUNCHED_MS` from `./visibility`; `groupByPlace` from `./sessions`; `runKind` from `../types`
- Produces:

```ts
export interface AttentionDeps {
  runs: () => Run[];
  sessions: () => OpenSession[];
  windows: () => PresenceRecord[];
  prEntries: (key: string) => PrEntryMap;
  sessionActivity: (cwd: string, sessionId: string) => AgentActivity;
  repoActivity: (repoPath: string, branch: string | null) => AgentActivity;
  gitState: (name: string, repoPath: string) => RepoGit;
  repoRootOf: (dir: string) => string;
  nowMs: number;
  showAll: boolean;
  openAgents: boolean;
}
export function defaultAttentionDeps(nowMs: number, showAll: boolean, openAgents: boolean): AttentionDeps;
export function gatherAttention(deps: AttentionDeps): AttentionCandidate[];
export const NEEDS_STATES: ReadonlySet<AgentState>;
```

- [ ] **Step 1: Move `claudeProjectsRoot` to where two callers can reach it**

It is currently a private function in `src/deckView.ts:77-79`. Move it verbatim — comment included — into `src/engine/paths.ts`, export it, and import it in `deckView.ts`. Its own comment already says it exists so two readers "cannot drift onto two different roots"; a third reader is the same argument.

Run: `npx vitest run test/unit/engine/paths.test.ts test/unit/deckView.test.ts` (timeout 600000)
Expected: PASS, both unmodified.

- [ ] **Step 2: Write the failing test**

Create `test/unit/engine/attentionFs.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { AttentionDeps, NEEDS_STATES, gatherAttention } from "../../../src/engine/attentionFs";
import { AgentActivity, OpenSession, PresenceRecord, RepoGit, Run } from "../../../src/types";

const activity = (over: Partial<AgentActivity> = {}): AgentActivity => ({
  state: "idle", lastActivityMs: 1, slug: null, ...over,
});

const repoGit = (over: Partial<RepoGit> = {}): RepoGit => ({
  name: "api", path: "/repo/api", branch: "feat", dirty: false,
  ahead: 0, added: 0, removed: 0, files: 0, ...over,
});

const run = (over: Partial<Run> = {}): Run => ({
  key: "BITE-1", summary: "s", url: "https://jira/BITE-1", createdAt: 0,
  mode: "per-window",
  repos: [{ name: "api", path: "/repo/api", isGit: true, branch: "feat" }],
  briefPaths: [], ...over,
});

const session = (over: Partial<OpenSession> = {}): OpenSession => ({
  pid: 1, sessionId: "sess-1", cwd: "/repo/api",
  startedAt: 1_700_000_000_000, name: "api-1", ...over,
});

let gitState: ReturnType<typeof vi.fn>;
let prEntries: ReturnType<typeof vi.fn>;
let sessionActivity: ReturnType<typeof vi.fn>;
let repoActivity: ReturnType<typeof vi.fn>;

beforeEach(() => {
  gitState = vi.fn((name: string, repoPath: string) => repoGit({ name, path: repoPath }));
  prEntries = vi.fn(() => ({}));
  sessionActivity = vi.fn(() => activity({ state: "working" }));
  repoActivity = vi.fn(() => activity({ state: "unknown" }));
});

const deps = (over: Partial<AttentionDeps> = {}): AttentionDeps => ({
  runs: () => [],
  sessions: () => [],
  windows: () => [],
  prEntries: prEntries as unknown as AttentionDeps["prEntries"],
  sessionActivity: sessionActivity as unknown as AttentionDeps["sessionActivity"],
  repoActivity: repoActivity as unknown as AttentionDeps["repoActivity"],
  gitState: gitState as unknown as AttentionDeps["gitState"],
  repoRootOf: (dir: string) => dir,
  nowMs: 1_000_000_000,
  showAll: false,
  openAgents: true,
  ...over,
});

describe("NEEDS_STATES", () => {
  it("names exactly deriveBucket's needs rung", () => {
    expect([...NEEDS_STATES].sort()).toEqual(["exited", "needs-you", "stalled"]);
  });
});

describe("gatherAttention: tracked runs", () => {
  it("returns nothing when there are no runs and no sessions", () => {
    expect(gatherAttention(deps())).toEqual([]);
  });

  it("skips review runs — they live on the strip, never in a column", () => {
    expect(gatherAttention(deps({ runs: () => [run({ key: "PR-1", kind: "review" })] }))).toEqual([]);
  });

  it("carries a run through with the fields the reduction needs", () => {
    const [c] = gatherAttention(deps({ runs: () => [run()] }));
    expect(c.key).toBe("BITE-1");
    expect(c.ticketStatus).toBeNull();   // Jira on the hidden path is forbidden
    expect(c.showAll).toBe(false);
    expect(c.hasLiveSession).toBe(false);
  });

  it("takes the liveliest reading across a run's sessions and repos", () => {
    sessionActivity.mockReturnValue(activity({ state: "needs-you" }));
    const [c] = gatherAttention(deps({
      runs: () => [run()],
      sessions: () => [session()],
    }));
    expect(c.agentState).toBe("needs-you");
    expect(c.hasLiveSession).toBe(true);
  });

  it("promotes a transcript that died holding the work to exited", () => {
    repoActivity.mockReturnValue(activity({ state: "idle", midWork: true }));
    const [c] = gatherAttention(deps({ runs: () => [run()] }));
    expect(c.agentState).toBe("exited");
  });

  it("passes inflightShowAll straight through", () => {
    expect(gatherAttention(deps({ runs: () => [run()], showAll: true }))[0].showAll).toBe(true);
  });

  it("marks a run created moments ago as just launched", () => {
    const [c] = gatherAttention(deps({ runs: () => [run({ createdAt: 1_000_000_000 - 1000 })] }));
    expect(c.justLaunched).toBe(true);
  });

  it("does not mark a run launched an hour ago as just launched", () => {
    const [c] = gatherAttention(deps({ runs: () => [run({ createdAt: 1_000_000_000 - 3_600_000 })] }));
    expect(c.justLaunched).toBe(false);
  });
});

describe("gatherAttention: the cost ladder", () => {
  it("spends no git call and no PR read on a run nobody is waiting on", () => {
    // The whole point of the hidden path: a quiet machine costs transcript reads
    // and nothing else. If someone hoists either reader out of the needs branch,
    // this fails.
    repoActivity.mockReturnValue(activity({ state: "working" }));
    const [c] = gatherAttention(deps({ runs: () => [run()] }));
    expect(gitState).not.toHaveBeenCalled();
    expect(prEntries).not.toHaveBeenCalled();
    expect(c.prs).toEqual({});
  });

  it("reads the PR cache for a run that IS waiting", () => {
    repoActivity.mockReturnValue(activity({ state: "needs-you" }));
    gatherAttention(deps({ runs: () => [run()] }));
    expect(prEntries).toHaveBeenCalledWith("BITE-1");
  });

  it("spends git on an exited run with nobody in it — the shelf turns on dirty state", () => {
    repoActivity.mockReturnValue(activity({ state: "idle", midWork: true }));
    gitState.mockReturnValue(repoGit({ dirty: true }));
    const [c] = gatherAttention(deps({ runs: () => [run()] }));
    expect(gitState).toHaveBeenCalledTimes(1);
    expect(c.hasWorkToLose).toBe(true);
  });

  it("spends no git on a waiting run that already has a live session", () => {
    // A live session boards the card on its own, so the answer could not change.
    sessionActivity.mockReturnValue(activity({ state: "needs-you" }));
    gatherAttention(deps({ runs: () => [run()], sessions: () => [session()] }));
    expect(gitState).not.toHaveBeenCalled();
  });

  it("refuses to count a ticketless Explore run's dirty checkout as work to lose", () => {
    repoActivity.mockReturnValue(activity({ state: "idle", midWork: true }));
    gitState.mockReturnValue(repoGit({ dirty: true }));
    const [c] = gatherAttention(deps({
      runs: () => [run({ kind: "explore", url: "" })],
    }));
    expect(c.hasWorkToLose).toBe(false);
    expect(gitState).not.toHaveBeenCalled();
  });

  it("reaches no forge module at all", () => {
    // Asserted on the import graph, not a mocked call site: a mocked call site
    // would not catch a new import.
    const src = fs.readFileSync(
      path.join(__dirname, "../../../src/engine/attentionFs.ts"), "utf8");
    expect(src).not.toMatch(/forge|child_process|execFile|spawnSync/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/unit/engine/attentionFs.test.ts`
Expected: FAIL — cannot resolve `../../../src/engine/attentionFs`.

- [ ] **Step 4: Write the implementation**

Create `src/engine/attentionFs.ts`:

```ts
// The cheap half of the attention badge: build `AttentionCandidate`s without
// touching a forge, a ticket tracker, or the network.
//
// Every reader is injected rather than imported at the call site. The cost ladder
// below is the reason: "no git call for a run nobody is waiting on" is a promise
// about behaviour, and a promise about behaviour needs a spy to hold it.
// `defaultAttentionDeps` wires the real ones.
import { AgentActivity, AgentState, OpenSession, PresenceRecord, PrEntryMap, RepoGit, Run, runKind } from "../types";
import { AttentionCandidate, ownsWorkToLose } from "./attention";
import { mostActive, promoteExited } from "./activity";
import { canon, claudeProjectsRoot } from "./paths";
import { resolveOwnership } from "./ownership";
import { groupByPlace, readOpenSessions, defaultSessionsDir } from "./sessions";
import { readPrEntries, defaultPrFactsDir } from "./pr/store";
import { readRuns, defaultRunsDir } from "./runs";
import { readLiveWindows, defaultWindowsDir } from "./presence";
import { readAgentActivity, readSessionActivity } from "./transcript";
import { gitState as realGitState, repoRoot } from "./git";
import { JUST_LAUNCHED_MS } from "./visibility";

/** `deriveBucket`'s needs rung, named once so the cost ladder and its test agree. */
export const NEEDS_STATES: ReadonlySet<AgentState> = new Set<AgentState>([
  "needs-you", "stalled", "exited",
]);

export interface AttentionDeps {
  runs: () => Run[];
  sessions: () => OpenSession[];
  windows: () => PresenceRecord[];
  prEntries: (key: string) => PrEntryMap;
  sessionActivity: (cwd: string, sessionId: string) => AgentActivity;
  repoActivity: (repoPath: string, branch: string | null) => AgentActivity;
  /** The expensive one: three git calls per repo. The tests assert it is never
   * called for a run nobody is waiting on. */
  gitState: (name: string, repoPath: string) => RepoGit;
  repoRootOf: (dir: string) => string;
  nowMs: number;
  showAll: boolean;
  openAgents: boolean;
}

/** A directory's repo root does not change under us, and the alternative is one
 * `git rev-parse --show-toplevel` per unclaimed session place per tick, forever,
 * in every open window. Module-level so it survives across ticks. */
const repoRootMemo = new Map<string, string>();

export function defaultAttentionDeps(nowMs: number, showAll: boolean, openAgents: boolean): AttentionDeps {
  const projectsRoot = claudeProjectsRoot();
  return {
    runs: () => readRuns(defaultRunsDir()),
    sessions: () => readOpenSessions(defaultSessionsDir()),
    windows: () => readLiveWindows(defaultWindowsDir()),
    prEntries: (key) => readPrEntries(defaultPrFactsDir(), key),
    sessionActivity: (cwd, sessionId) => readSessionActivity(projectsRoot, cwd, sessionId, nowMs),
    repoActivity: (repoPath, branch) => readAgentActivity(projectsRoot, repoPath, branch, nowMs),
    gitState: (name, repoPath) => realGitState(name, repoPath),
    repoRootOf: (dir) => {
      const hit = repoRootMemo.get(dir);
      if (hit !== undefined) return hit;
      const resolved = repoRoot(dir);
      repoRootMemo.set(dir, resolved);
      return resolved;
    },
    nowMs,
    showAll,
    openAgents,
  };
}

export function gatherAttention(deps: AttentionDeps): AttentionCandidate[] {
  const runs = deps.runs().filter((r) => runKind(r) !== "review");
  const allPlaces = groupByPlace(deps.sessions());
  const ownership = resolveOwnership({
    runs: runs.map((r) => ({
      key: r.key, createdAt: r.createdAt, paths: r.repos.map((repo) => canon(repo.path)),
    })),
    sessionsByPlace: allPlaces,
  });

  const out: AttentionCandidate[] = [];
  const claimed = new Set<string>();
  for (const run of runs) {
    // Rung 2: transcripts. One read per owned session plus one per repo — the
    // same union buildRunStatus takes, so the state matches the card.
    const owned: AgentActivity[] = [];
    for (const repo of run.repos) {
      const place = canon(repo.path);
      const sessions = allPlaces.get(place);
      if (!sessions) continue;
      claimed.add(place);
      for (const s of sessions) {
        if (ownership.sessionOwner.get(s.sessionId) !== run.key) continue;
        owned.push(deps.sessionActivity(s.cwd, s.sessionId));
      }
    }
    const reduced = mostActive([
      ...owned,
      ...run.repos.map((r) => deps.repoActivity(r.path, r.branch ?? null)),
    ]);
    const agentState = promoteExited(reduced, owned.length).state;
    const hasLiveSession = ownership.runsWithSession.has(run.key);

    // Rungs 3 and 4, spent ONLY where they could change the answer. A quiet
    // machine reaches neither. Do NOT hoist either out of this branch —
    // attentionFs.test.ts asserts both spies stay untouched otherwise.
    const waiting = NEEDS_STATES.has(agentState);
    const prs = waiting ? deps.prEntries(run.key) : {};
    // `!hasLiveSession`: with a session open the shelf is already `board`, so
    // git could only confirm what is settled. Task 7's parity test is what
    // proves this skip changes no verdict — if it ever could, delete it.
    const hasWorkToLose =
      waiting && !hasLiveSession && ownsWorkToLose(run)
        ? run.repos.some((r) => {
            if (ownership.pathOwner.get(canon(r.path)) !== run.key) return false;
            const g = deps.gitState(r.name, r.path);
            return g.dirty || g.ahead > 0;
          })
        : false;

    out.push({
      key: run.key,
      agentState,
      prs,
      // Forbidden on the hidden path; attention.test.ts proves it cannot change
      // a verdict.
      ticketStatus: null,
      hasLiveSession,
      justLaunched: deps.nowMs - run.createdAt < JUST_LAUNCHED_MS,
      hasWorkToLose,
      showAll: deps.showAll,
    });
  }
  // Task 6 appends local session candidates here, using `claimed`.
  return out;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/engine/attentionFs.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 6: Mutation-check the cost invariant**

Hoist `const prs = ...` out of the `waiting` branch so it always calls `deps.prEntries`. Re-run: the "spends no git call and no PR read" test must FAIL. Restore the branch by hand — **not** with `git checkout`, which would revert the whole uncommitted file — and re-run to PASS. A cost test that cannot fail is the defect, not the protection.

- [ ] **Step 7: Commit**

```bash
cd /Users/oznasi/dev/agent-flow-e1-spec
npm run typecheck
git add src/engine/attentionFs.ts src/engine/paths.ts src/deckView.ts test/unit/engine/attentionFs.test.ts
git commit -m "feat(engine): gather attention candidates for tracked runs

Transcripts for every run; the PR cache and git only for a run already in a
needs state. Readers are injected so that promise is assertable, and a quiet
machine costs no git call at all.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Gather candidates for local session cards

A session running somewhere the Deck has never heard of is an Action-required card too — and it is the common case, since a bare `claude` in your own checkout has no run record while a run the Deck launched still does.

**Files:**
- Modify: `src/engine/attentionFs.ts`
- Test: `test/unit/engine/attentionFs.test.ts` (append)

**Interfaces:**
- Consumes: Task 5's `AttentionDeps` and `gatherAttention`
- Produces: `groupPlacesByWindow`, `localKey` from `./localRuns` become imports of `attentionFs.ts`

- [ ] **Step 1: Read the Deck's own local-card path first**

Read `src/deckView.ts:2524-2600`. Four things must be mirrored exactly or the count diverges:

1. `places` is empty when `openAgents` is off — **no local cards exist at all** in that mode.
2. Unclaimed places are folded by window via `groupPlacesByWindow(unclaimed, liveWindows)`: two roots in one multi-root window are **one** card.
3. Each root is normalized through `repoRoot(root)` then `canon(...)` **before** the `claimed` filter, and kept only if it names a git repo **or** has a live session in it.
4. The key is `localKey(group.workspaceFile ?? group.roots[0])` — no git call needed for the key itself.

- [ ] **Step 2: Write the failing test**

Append to `test/unit/engine/attentionFs.test.ts`:

```ts
const windowRec = (over: Partial<PresenceRecord> = {}): PresenceRecord => ({
  identity: "/ws/team.code-workspace", kind: "workspace", label: "team.code-workspace",
  folders: 2, roots: ["/repo/a", "/repo/b"], pid: 4242, updatedAt: 1_700_000_000_000, ...over,
});

describe("gatherAttention: local session cards", () => {
  it("makes no local candidate when openAgents is off", () => {
    expect(gatherAttention(deps({
      sessions: () => [session({ cwd: "/repo/solo" })],
      openAgents: false,
    }))).toEqual([]);
  });

  it("makes a candidate for a session in a place no run claims", () => {
    sessionActivity.mockReturnValue(activity({ state: "needs-you" }));
    const got = gatherAttention(deps({ sessions: () => [session({ cwd: "/repo/solo" })] }));
    expect(got.length).toBe(1);
    expect(got[0].agentState).toBe("needs-you");
    expect(got[0].hasLiveSession).toBe(true);
    expect(got[0].hasWorkToLose).toBe(false);
    expect(got[0].prs).toEqual({});
  });

  it("does not double-count a place a tracked run already owns", () => {
    const got = gatherAttention(deps({
      runs: () => [run()],
      sessions: () => [session({ cwd: "/repo/api" })],
    }));
    expect(got.map((c) => c.key)).toEqual(["BITE-1"]);
  });

  it("folds two roots of one multi-root window into a single card", () => {
    const got = gatherAttention(deps({
      sessions: () => [
        session({ pid: 1, sessionId: "s1", cwd: "/repo/a" }),
        session({ pid: 2, sessionId: "s2", cwd: "/repo/b" }),
      ],
      windows: () => [windowRec()],
    }));
    expect(got.length).toBe(1);
  });

  it("keeps two unrelated places as two cards", () => {
    const got = gatherAttention(deps({
      sessions: () => [
        session({ pid: 1, sessionId: "s1", cwd: "/repo/a" }),
        session({ pid: 2, sessionId: "s2", cwd: "/repo/c" }),
      ],
    }));
    expect(got.length).toBe(2);
  });

  it("spends no gitState call on a local card — a live session already boards it", () => {
    gatherAttention(deps({ sessions: () => [session({ cwd: "/repo/solo" })] }));
    expect(gitState).not.toHaveBeenCalled();
  });

  it("gives a local card a stable key across passes, so the latch holds", () => {
    const d = { sessions: () => [session({ cwd: "/repo/solo" })] };
    const first = gatherAttention(deps(d)).map((c) => c.key);
    const second = gatherAttention(deps({ ...d, nowMs: 2_000_000_000 })).map((c) => c.key);
    expect(second).toEqual(first);
    expect(first[0]).toBeTruthy();
  });

  it("passes inflightShowAll to a local card too", () => {
    const got = gatherAttention(deps({
      sessions: () => [session({ cwd: "/repo/solo" })], showAll: true,
    }));
    expect(got[0].showAll).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/unit/engine/attentionFs.test.ts`
Expected: FAIL — local candidates are not produced yet.

- [ ] **Step 4: Write the implementation**

Replace the `// Task 6 appends local session candidates here, using \`claimed\`.` comment. Import `groupPlacesByWindow` and `localKey` from `./localRuns`.

```ts
  // Whatever no tracked run claimed is a place you are working in that the Deck
  // has never heard of. `openAgents` gates this exactly as buildAll does: with the
  // display toggle off, the board has no local cards, so neither does the badge.
  //
  // A local card always has a live session by construction, so its shelf is
  // `board` without asking git anything, and there is no PR cache for a key the
  // Deck never launched. The only git this pass can reach is the memoized
  // `repoRootOf` normalization.
  if (!deps.openAgents) return out;
  const unclaimed = [...allPlaces.keys()].filter((place) => !claimed.has(place));
  for (const group of groupPlacesByWindow(unclaimed, deps.windows())) {
    const isGitByRoot = new Map<string, boolean>();
    for (const root of group.roots) {
      const rr = deps.repoRootOf(root);
      const norm = canon(rr || root);
      if (!isGitByRoot.has(norm)) isGitByRoot.set(norm, rr !== "");
    }
    const roots = [...isGitByRoot.keys()].filter(
      (root) => !claimed.has(root) && (isGitByRoot.get(root) || allPlaces.has(root)),
    );
    if (roots.length === 0) continue;
    const sessions = group.places.flatMap((place) => allPlaces.get(place) ?? []);
    const reduced = mostActive(sessions.map((s) => deps.sessionActivity(s.cwd, s.sessionId)));
    out.push({
      key: localKey(group.workspaceFile ?? group.roots[0]),
      // Called even though it cannot fire here (the sessions exist), so both
      // paths in this file read identically.
      agentState: promoteExited(reduced, sessions.length).state,
      prs: {},
      ticketStatus: null,
      hasLiveSession: true,
      justLaunched: false,
      hasWorkToLose: false,
      showAll: deps.showAll,
    });
  }
  return out;
```

Note the early `return out` before the loop rather than wrapping it: `buildAll` reaches the same state by leaving `places` empty, and a guard clause says why more plainly than an empty map would.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/engine/attentionFs.test.ts`
Expected: PASS, 23 tests.

- [ ] **Step 6: Commit**

```bash
cd /Users/oznasi/dev/agent-flow-e1-spec
npm run typecheck
git add src/engine/attentionFs.ts test/unit/engine/attentionFs.test.ts
git commit -m "feat(engine): count sessions the Deck never launched

Grouped by window like the board does and keyed by localKey so the
announcement latch holds across ticks, costing one memoized repoRoot per
place rather than a git call per tick.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Point the Deck at the shared reduction

The task that makes parity true by construction. It is a refactor of the Deck's hottest path — the diff should move code, not add behavior.

**Files:**
- Modify: `src/deckView.ts:2680-2711` (candidate construction), the private-static area near line 274, and `buildAll`'s return path near line 2470
- Test: `test/unit/engine/attention.test.ts` (append the parity test), `test/unit/deckView.test.ts` (append one test)

**Interfaces:**
- Consumes: `attentionKeys`, `ownsWorkToLose`, `AttentionCandidate` (Task 2)
- Produces: `DeckPanel.latestCandidates(): { candidates: AttentionCandidate[]; at: number } | null`

- [ ] **Step 1: Write the parity test**

Append to `test/unit/engine/attention.test.ts`. This is the guard that a future edit to `deriveBucket`'s precedence cannot silently desynchronize the badge from the column:

```ts
describe("attentionKeys agrees with the column the Deck draws", () => {
  it("selects exactly the boarded candidates deriveBucket calls needs", () => {
    const states: AgentState[] = ["needs-you", "stalled", "exited", "working", "idle", "unknown"];
    const prSets: PrEntryMap[] = [
      {},
      prs(facts()),
      prs(facts({ state: "MERGED" })),
      prs(facts({ isDraft: true })),
      prs(facts({ review: "changes_requested" })),
      prs(facts({ review: "approved" })),
    ];
    const all: AttentionCandidate[] = [];
    let n = 0;
    for (const agentState of states) {
      for (const p of prSets) {
        for (const hasLiveSession of [true, false]) {
          for (const hasWorkToLose of [true, false]) {
            all.push(cand({ key: `k${n++}`, agentState, prs: p, hasLiveSession, hasWorkToLose }));
          }
        }
      }
    }

    // The independent restatement: shelf, then column, exactly as buildAll does.
    const expected = all
      .filter((c) => {
        const pr = prSignals(c.prs);
        return shelfFor({
          hasLiveSession: c.hasLiveSession,
          prOpen: Object.values(c.prs).some((e) => e.facts?.state === "OPEN"),
          merged: pr.merged,
          justLaunched: c.justLaunched,
          hasWorkToLose: c.hasWorkToLose,
        }) === "board";
      })
      .filter((c) => {
        const pr = prSignals(c.prs);
        return deriveBucket({
          ticketStatus: c.ticketStatus, agentState: c.agentState,
          prOpen: pr.open, prBlocked: pr.blocked, prReady: pr.ready, prMerged: pr.merged,
        }) === "needs";
      })
      .map((c) => c.key);

    expect(attentionKeys(all)).toEqual(expected);
    // A parity test that compares two empty arrays proves nothing.
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(all.length);
  });
});
```

Add the imports it needs: `AgentState` from `../../../src/types`, `deriveBucket` and `prSignals` from `../../../src/engine/bucket`, `shelfFor` from `../../../src/engine/visibility`.

- [ ] **Step 2: Run it — it should already pass**

Run: `npx vitest run test/unit/engine/attention.test.ts`
Expected: PASS. This test describes Task 2's code; it lives here because it is the contract Task 7 relies on. If it fails, Task 2 is wrong — fix Task 2, not the test.

- [ ] **Step 3: Refactor `buildAll` onto the shared pieces**

In `src/deckView.ts`:

- Replace the inline `inPlace` computation at line 2697 with `ownsWorkToLose(run)`, inverting the sense:
  `hasWorkToLose: ownsWorkToLose(run) && status.repos.some((r) => ownsPath(r.path) && (r.dirty || r.ahead > 0))`
- Build an `AttentionCandidate` per run from the same values that `shelfFor` call already uses, plus `agentState: status.agent.state` and `ticketStatus: status.ticketStatus`, and collect them into a local array.
- Store `{ candidates, at: now }` in a private field at the end of `buildAll`, and add the static reader:

```ts
  /** The candidates this panel built on its last pass, for the extension host's
   * attention tick. Reading them rather than re-gathering means the badge cannot
   * disagree with the column beside it, and costs the tick no I/O at all while
   * the Deck is open. `null` when no panel is open. */
  static latestCandidates(): { candidates: AttentionCandidate[]; at: number } | null {
    return DeckPanel.current?.attentionCandidates ?? null;
  }
```

**Do not** try to replace the `shelfFor` call with `attentionKeys`: `buildAll` needs the shelf for *every* card, not just the waiting ones. The shared pieces here are `ownsWorkToLose` and the candidate shape.

- [ ] **Step 4: Prove the Deck's behavior did not change**

Run: `npx vitest run test/unit/deckView.test.ts` (timeout 600000)
Expected: PASS, **unmodified**. A deckView test you had to edit means the refactor changed behavior — stop and re-read Step 3. If the file dies rather than fails, run `npm ci` first; that has fixed it before.

- [ ] **Step 5: Add the one new deckView test**

Append to `test/unit/deckView.test.ts`, reusing the file's existing `show()` helper and its `waitFor` convention — read the neighbouring tests first rather than introducing a second harness:

```ts
  it("publishes its attention candidates for the host's badge tick", async () => {
    // The tick prefers these over gathering its own, so the badge and the column
    // are the same reduction over the same inputs rather than two guesses.
    show(true);
    await waitFor(() => expect(DeckPanel.latestCandidates()).not.toBeNull());
    const published = DeckPanel.latestCandidates()!;
    expect(published.at).toBeGreaterThan(0);
    expect(Array.isArray(published.candidates)).toBe(true);
  });
```

- [ ] **Step 6: Commit**

```bash
cd /Users/oznasi/dev/agent-flow-e1-spec
npm run typecheck
npx vitest run test/unit/engine/attention.test.ts
git add src/deckView.ts test/unit/engine/attention.test.ts test/unit/deckView.test.ts
git commit -m "refactor(deck): build attention candidates in buildAll

The board shares ownsWorkToLose and the candidate shape with the coming badge,
and publishes what it built so the host tick reads the Deck's own reduction
instead of repeating it. No behavior change: deckView.test.ts passes
unmodified.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: The badge

**Files:**
- Modify: `src/tasksView.ts` (the `resolveWebviewView` / `post` area, lines 195-230)
- Test: `test/unit/tasksView.test.ts` (append)

**Interfaces:**
- Consumes: nothing
- Produces: `TasksViewProvider.setAttention(keys: readonly string[]): void`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/tasksView.test.ts`. The file already mounts a provider by building a plain object literal and calling `provider.resolveWebviewView(view as never)` (see around line 345) — these tests build the smallest version of that themselves, because they need a provider both before and after mounting:

```ts
describe("setAttention", () => {
  // Deliberately minimal and local: setAttention touches nothing but `view.badge`,
  // and the file's full mount helper builds a webview these tests never use.
  const bareView = () => ({ title: "Tasks", description: undefined as string | undefined,
    badge: undefined as unknown,
    webview: {
      options: {}, html: "", asWebviewUri: (u: unknown) => u, cspSource: "",
      postMessage: vi.fn(), onDidReceiveMessage: () => ({ dispose() {} }),
    } });
  const bareProvider = () =>
    new TasksViewProvider(fakeContext().context as never, connector as never, () => {});

  it("badges the count of sessions waiting on you", () => {
    const provider = bareProvider();
    const view = bareView();
    provider.resolveWebviewView(view as never);
    provider.setAttention(["BITE-1", "BITE-2"]);
    expect(view.badge).toEqual({ value: 2, tooltip: "2 sessions are waiting on you — open the Deck" });
  });

  it("says session, singular, for one", () => {
    const provider = bareProvider();
    const view = bareView();
    provider.resolveWebviewView(view as never);
    provider.setAttention(["BITE-1"]);
    expect(view.badge).toEqual({ value: 1, tooltip: "1 session is waiting on you — open the Deck" });
  });

  it("clears the badge to undefined rather than badging a zero", () => {
    const provider = bareProvider();
    const view = bareView();
    provider.resolveWebviewView(view as never);
    provider.setAttention(["BITE-1"]);
    provider.setAttention([]);
    expect(view.badge).toBeUndefined();
  });

  it("applies a count set before the sidebar was ever opened", () => {
    // VS Code resolves a webview view lazily, so the first ticks of a window land
    // before there is any view to badge. Dropping them would mean no badge at all
    // until the count next changed.
    const provider = bareProvider();
    provider.setAttention(["BITE-1", "BITE-2"]);
    const view = bareView();
    provider.resolveWebviewView(view as never);
    expect(view.badge).toEqual({ value: 2, tooltip: "2 sessions are waiting on you — open the Deck" });
  });

  it("does not throw when no view has ever been resolved", () => {
    expect(() => bareProvider().setAttention(["BITE-1"])).not.toThrow();
  });
});
```

`fakeContext` and `connector` are the names this file already uses for its context and connector stubs — check the top of the file and use whatever it actually calls them.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/tasksView.test.ts`
Expected: FAIL — `setAttention` is not a function.

- [ ] **Step 3: Write the implementation**

In `src/tasksView.ts`:

```ts
  /** The last attention count, held so a tick that fires before VS Code has
   * resolved this view is not simply lost — see `setAttention`. */
  private attention = 0;

  /**
   * Badge the view with how many sessions are waiting on you. Driven by the
   * attention job in extension.ts, which outlives the Deck panel — the whole
   * point of the badge is that it is there when the Deck is not.
   *
   * `undefined` rather than `{ value: 0 }` for an empty count: VS Code renders a
   * zero badge, and "0" on the activity bar reads as a broken feature.
   *
   * The value is held in a field as well as applied, because VS Code resolves a
   * webview view lazily — a window whose sidebar has not been opened has no
   * `this.view` to badge, and the first ticks of every window land there.
   * `resolveWebviewView` replays it. A sidebar never opened at all in a window
   * still gets no badge; that is a VS Code constraint, not something to work
   * around here.
   *
   * "sessions", not "agents": a session is one run of a coding tool, which is
   * what this counts. test/unit/vocabulary.test.ts enforces the distinction.
   */
  public setAttention(keys: readonly string[]): void {
    this.attention = keys.length;
    this.applyAttention();
  }

  private applyAttention(): void {
    if (!this.view) return;
    const n = this.attention;
    this.view.badge =
      n === 0
        ? undefined
        : { value: n, tooltip: `${n} session${n === 1 ? " is" : "s are"} waiting on you — open the Deck` };
  }
```

Call `this.applyAttention()` as the last statement of `resolveWebviewView`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/tasksView.test.ts`
Expected: PASS, 5 new tests.

- [ ] **Step 5: Check the vocabulary gate**

Run: `npx vitest run test/unit/vocabulary.test.ts`
Expected: PASS. If it fails, the new string says "agent" somewhere — fix the string, never the allowlist.

- [ ] **Step 6: Commit**

```bash
cd /Users/oznasi/dev/agent-flow-e1-spec
npm run typecheck
git add src/tasksView.ts test/unit/tasksView.test.ts
git commit -m "feat(tasks): badge the activity bar with sessions waiting on you

Held across an unresolved view, because VS Code resolves a webview view
lazily and a window's first ticks land before there is one.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: The setting

**Files:**
- Modify: `src/config.ts` (interface near line 446, reader near line 705)
- Modify: `package.json` (`contributes.configuration.properties`)
- Test: `test/unit/config.test.ts` (append)

**Interfaces:**
- Consumes: nothing
- Produces: `getConfig().notifyOnActionRequired: boolean`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/config.test.ts`, matching the file's existing pattern for asserting a default:

```ts
  it("defaults notifyOnActionRequired off — a toast interrupts, so it ships inert", () => {
    expect(getConfig().notifyOnActionRequired).toBe(false);
  });

  it("reads notifyOnActionRequired when the user turns it on", () => {
    setConfig({ notifyOnActionRequired: true });
    expect(getConfig().notifyOnActionRequired).toBe(true);
  });
```

`setConfig` is the mock's own setter — check how the neighbouring tests in this file drive settings and use the same call.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/config.test.ts`
Expected: FAIL — the property does not exist.

- [ ] **Step 3: Add the setting**

In `src/config.ts`, beside `inflightShowAll` in the interface:

```ts
  /** Raise a notification when a run enters Action required. Off by default: the
   * badge is ambient, but a toast interrupts, and this ships to installs that did
   * not ask for one. */
  notifyOnActionRequired: boolean;
```

and in the reader, beside `inflightShowAll`:

```ts
    notifyOnActionRequired: c.get<boolean>("notifyOnActionRequired") ?? false,
```

In `package.json`, beside `agentFlow.inflightShowAll`:

```json
        "agentFlow.notifyOnActionRequired": {
          "type": "boolean",
          "default": false,
          "markdownDescription": "Show a notification when a run enters **Action required** — a session has stopped and is waiting on you. Announced once when a run parks, in whichever window is focused at the time, and not repeated until that run is answered and parks again. The activity-bar badge tracks the count whether this is on or off."
        },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/config.test.ts test/unit/compat.test.ts`
Expected: PASS both, `compat.test.ts` **unmodified**. It checks settings as a superset (a new one is fine) but command ids as an exact set — confirm you added no command.

- [ ] **Step 5: Commit**

```bash
cd /Users/oznasi/dev/agent-flow-e1-spec
npm run typecheck
git add src/config.ts package.json test/unit/config.test.ts
git commit -m "feat(config): agentFlow.notifyOnActionRequired, default off

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: The attention pass

The job lives in its own module, called directly by its tests. `extension.test.ts` drives real intervals rather than fake timers (see its `liveContexts` teardown comment), so a pass buried in a 12-second `setInterval` callback would be untestable — and this is the logic that most needs tests.

**Files:**
- Create: `src/attentionJob.ts`
- Test: `test/unit/attentionJob.test.ts` (create)

**Interfaces:**
- Consumes: `attentionKeys`, `nextAnnouncements`, `AttentionCandidate` (Tasks 2-3); `readAnnounced`, `writeAnnounced` (Task 4)
- Produces:

```ts
export interface AttentionPassDeps {
  candidates: () => AttentionCandidate[];
  setAttention: (keys: readonly string[]) => void;
  notify: boolean;
  focused: boolean;
  latchFile: string;
  nowMs: number;
  log: (m: string) => void;
}
export function runAttentionPass(deps: AttentionPassDeps): void;
```

- [ ] **Step 1: Write the failing test**

Create `test/unit/attentionJob.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { commands, window } from "../_mocks/vscode";
import { AttentionPassDeps, runAttentionPass } from "../../src/attentionJob";
import { AttentionCandidate } from "../../src/engine/attention";

let dir: string;
let setAttention: ReturnType<typeof vi.fn>;
let logged: string[];

const cand = (key: string, over: Partial<AttentionCandidate> = {}): AttentionCandidate => ({
  key, agentState: "needs-you", prs: {}, ticketStatus: null,
  hasLiveSession: true, justLaunched: false, hasWorkToLose: false, showAll: false, ...over,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "attentionjob-"));
  setAttention = vi.fn();
  logged = [];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const deps = (over: Partial<AttentionPassDeps> = {}): AttentionPassDeps => ({
  candidates: () => [],
  setAttention: setAttention as unknown as AttentionPassDeps["setAttention"],
  notify: false,
  focused: true,
  latchFile: path.join(dir, "attention.json"),
  nowMs: 1_000,
  log: (m: string) => logged.push(m),
  ...over,
});

describe("runAttentionPass: the badge", () => {
  it("badges what the reduction selected", () => {
    runAttentionPass(deps({ candidates: () => [cand("A"), cand("B", { agentState: "working" })] }));
    expect(setAttention).toHaveBeenCalledWith(["A"]);
  });

  it("badges zero when nothing is waiting", () => {
    runAttentionPass(deps({ candidates: () => [cand("A", { agentState: "working" })] }));
    expect(setAttention).toHaveBeenCalledWith([]);
  });

  it("badges even in an unfocused window — the badge is ambient, not an interrupt", () => {
    runAttentionPass(deps({ candidates: () => [cand("A")], focused: false }));
    expect(setAttention).toHaveBeenCalledWith(["A"]);
  });

  it("survives a throwing candidate source without taking the poll down", () => {
    runAttentionPass(deps({ candidates: () => { throw new Error("EACCES"); } }));
    expect(logged.join()).toContain("attention");
  });
});

describe("runAttentionPass: the notification", () => {
  it("stays silent when the setting is off, and writes no latch file", () => {
    const latchFile = path.join(dir, "attention.json");
    runAttentionPass(deps({ candidates: () => [cand("A")], notify: false, latchFile }));
    expect(window.showInformationMessage).not.toHaveBeenCalled();
    expect(fs.existsSync(latchFile)).toBe(false);
  });

  it("names the single run that parked", () => {
    runAttentionPass(deps({ candidates: () => [cand("BITE-42")], notify: true }));
    expect(window.showInformationMessage).toHaveBeenCalledWith("BITE-42 is waiting on you", "Open Deck");
  });

  it("coalesces several runs parking in one pass into one notification", () => {
    runAttentionPass(deps({ candidates: () => [cand("A"), cand("B"), cand("C")], notify: true }));
    expect(window.showInformationMessage).toHaveBeenCalledTimes(1);
    expect(window.showInformationMessage).toHaveBeenCalledWith("3 sessions are waiting on you", "Open Deck");
  });

  it("does not announce the same run again on the next pass", () => {
    const d = { candidates: () => [cand("A")], notify: true, latchFile: path.join(dir, "attention.json") };
    runAttentionPass(deps(d));
    runAttentionPass(deps({ ...d, nowMs: 2_000 }));
    expect(window.showInformationMessage).toHaveBeenCalledTimes(1);
  });

  it("announces again after the run was answered and parked a second time", () => {
    const latchFile = path.join(dir, "attention.json");
    runAttentionPass(deps({ candidates: () => [cand("A")], notify: true, latchFile }));
    runAttentionPass(deps({ candidates: () => [], notify: true, latchFile, nowMs: 2_000 }));
    runAttentionPass(deps({ candidates: () => [cand("A")], notify: true, latchFile, nowMs: 3_000 }));
    expect(window.showInformationMessage).toHaveBeenCalledTimes(2);
  });

  it("stays silent in an unfocused window and leaves the edge unclaimed", () => {
    // A toast is in-app only, so one raised in a window you are not looking at is
    // spent on nobody. Leaving the edge unclaimed lets a focused window announce
    // it on its own next pass.
    const latchFile = path.join(dir, "attention.json");
    runAttentionPass(deps({ candidates: () => [cand("A")], notify: true, focused: false, latchFile }));
    expect(window.showInformationMessage).not.toHaveBeenCalled();
    runAttentionPass(deps({ candidates: () => [cand("A")], notify: true, focused: true, latchFile, nowMs: 2_000 }));
    expect(window.showInformationMessage).toHaveBeenCalledTimes(1);
  });

  it("opens the Deck when the button is pressed", async () => {
    vi.mocked(window.showInformationMessage).mockResolvedValueOnce("Open Deck");
    runAttentionPass(deps({ candidates: () => [cand("A")], notify: true }));
    await vi.waitFor(() =>
      expect(commands.executeCommand).toHaveBeenCalledWith("agentFlow.openDeck"));
  });

  it("does nothing on the button when the notification is dismissed", async () => {
    vi.mocked(window.showInformationMessage).mockResolvedValueOnce(undefined);
    runAttentionPass(deps({ candidates: () => [cand("A")], notify: true }));
    await Promise.resolve();
    expect(commands.executeCommand).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/attentionJob.test.ts`
Expected: FAIL — cannot resolve `../../src/attentionJob`.

- [ ] **Step 3: Write the implementation**

Create `src/attentionJob.ts`:

```ts
import * as vscode from "vscode";
import { AttentionCandidate, attentionKeys, nextAnnouncements } from "./engine/attention";
import { readAnnounced, writeAnnounced } from "./engine/attentionStore";

export interface AttentionPassDeps {
  /** Either the open Deck's own candidates or a fresh gather — the caller
   * decides, so this function never does I/O it cannot be told about. */
  candidates: () => AttentionCandidate[];
  setAttention: (keys: readonly string[]) => void;
  notify: boolean;
  focused: boolean;
  latchFile: string;
  nowMs: number;
  log: (m: string) => void;
}

/**
 * One pass of the attention job: badge what is waiting on you, and announce what
 * just started waiting.
 *
 * Runs whether or not the Deck panel is open — that is the whole point. The Deck's
 * own poll stops when its panel hides, so a run entering Action required used to be
 * completely silent.
 *
 * Split out of extension.ts and injected rather than inlined in the interval
 * callback because extension.test.ts drives real timers, not fake ones: a pass
 * buried in a 12-second callback would be the least-tested code in the feature.
 */
export function runAttentionPass(deps: AttentionPassDeps): void {
  try {
    const keys = attentionKeys(deps.candidates());
    // The badge is ambient and unconditional — it updates in an unfocused window,
    // and whether or not notifications are on.
    deps.setAttention(keys);

    // Everything below is the interrupt tier. With the setting off nothing is read
    // or written, so a user who did not opt in gets no file in ~/.agentflow either.
    if (!deps.notify) return;
    // Only a focused window announces, and it claims the edge for every window.
    // showInformationMessage is in-app, so a toast raised in a background window is
    // an announcement spent on nobody — and leaving the edge unclaimed means a
    // focused window still gets to raise it on its own next pass. Deliberately no
    // backlog announcement when a window later gains focus: a toast about a run
    // that parked an hour ago is noise, and the badge already covers it.
    if (!deps.focused) return;

    const { toAnnounce, announced } = nextAnnouncements(
      keys, readAnnounced(deps.latchFile), deps.nowMs,
    );
    writeAnnounced(deps.latchFile, announced);
    if (toAnnounce.length === 0) return;
    // Coalesced: three runs parking in one pass is one notification, not three.
    // "sessions", never "agents" — see vocabulary.test.ts.
    const message =
      toAnnounce.length === 1
        ? `${toAnnounce[0]} is waiting on you`
        : `${toAnnounce.length} sessions are waiting on you`;
    void vscode.window.showInformationMessage(message, "Open Deck").then((choice) => {
      // The EXISTING command — compat.test.ts asserts the manifest's command ids
      // as an exact set, so this feature adds none.
      if (choice === "Open Deck") void vscode.commands.executeCommand("agentFlow.openDeck");
    });
  } catch (e) {
    // Same posture as every other best-effort nicety on this poll: a failure here
    // must never take the badge, the notepad poll, or the extension down with it.
    deps.log(`attention: pass failed: ${e}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/attentionJob.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Mutation-check the focus gate**

Delete the `if (!deps.focused) return;` line and re-run. The "stays silent in an unfocused window" test must FAIL. Restore it by hand and re-run to PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/oznasi/dev/agent-flow-e1-spec
npm run typecheck
git add src/attentionJob.ts test/unit/attentionJob.test.ts
git commit -m "feat(deck): one attention pass — badge always, toast on the edge

Its own module with injected deps, because extension.test.ts drives real
timers and a pass inside a 12s interval callback would go untested.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Wire it to the poll that outlives the panel

E1 asked for a new host-side tick. It does not need one: `extension.ts:144` already runs a 6s interval that outlives every panel, and its comment already reasons about badge staleness.

**Files:**
- Modify: `src/extension.ts:141-146`
- Modify: `test/_mocks/vscode.ts` (add `window.state`)
- Test: `test/unit/extension.test.ts` (append)

**Interfaces:**
- Consumes: `runAttentionPass` (Task 10); `defaultAttentionDeps`, `gatherAttention` (Tasks 5-6); `DeckPanel.latestCandidates` (Task 7); `TasksViewProvider.setAttention` (Task 8); `getConfig().notifyOnActionRequired` (Task 9); `defaultAttentionFile` (Task 4); `POLL_MS` from `./deckView`
- Produces: nothing further

- [ ] **Step 1: Add `window.state` to the mock**

In `test/_mocks/vscode.ts`, beside `onDidChangeWindowState` (line 143):

```ts
  state: { focused: true, active: true },
```

and in the reset function beside the `onDidChangeWindowState` reset (line 326):

```ts
  window.state.focused = true;
```

Run: `npx vitest run test/unit/extension.test.ts`
Expected: PASS — the mock addition breaks nothing.

- [ ] **Step 2: Write the failing test**

Append to `test/unit/extension.test.ts`. Add `setAttention: vi.fn()` to the existing `providerStub` (line 34-39) first, then:

```ts
  it("runs an attention pass on the poll that outlives the panel", () => {
    // The interval itself is not driven here: extension.test.ts uses real timers
    // (see the liveContexts teardown), and Task 10's own suite covers the pass.
    // What this asserts is the wiring — that activate() sets up a poll at all and
    // that disposing the context tears it down, so ~30 activations in this file
    // cannot leave intervals firing into a mocked-out module.
    const { context } = fakeContext();
    activate(context);
    expect(context.subscriptions.length).toBeGreaterThan(0);
    expect(() => context.subscriptions.forEach((d) => d.dispose())).not.toThrow();
  });
```

If `extension.test.ts` already has an equivalent assertion about the notepad poll's disposal, extend that test instead of adding a near-duplicate — read the file before writing.

- [ ] **Step 3: Wire the job**

Replace the `notepadPoll` block in `src/extension.ts`:

```ts
  // The notepad badge and the attention badge share one timer, deliberately: both
  // must outlive every panel, and a second interval doing the same directory reads
  // would be pure duplication.
  //
  // Attention runs every OTHER tick. Transcript reads are its recurring cost, and
  // nobody needs sub-10-second latency on an activity-bar badge.
  let ticks = 0;
  const poll = setInterval(() => {
    provider.postNotepad();
    if (++ticks % 2 === 0) attentionPass(provider, log);
  }, 6000);
  context.subscriptions.push({ dispose: () => clearInterval(poll) });
```

and add, as a module-level function in the same file:

```ts
/** Build one attention pass's inputs and run it.
 *
 * Prefers the open Deck's own candidates when a panel built some within two of its
 * poll intervals: same reduction, so the badge cannot contradict the column beside
 * it, and while the Deck is open the pass costs no I/O at all. Falls back to its
 * own cheap gather — transcripts always, git and the PR cache only for a run
 * already waiting, and never a forge call. */
function attentionPass(provider: TasksViewProvider, log: (m: string) => void): void {
  const cfg = getConfig();
  const now = Date.now();
  const fresh = DeckPanel.latestCandidates();
  const usable = fresh && now - fresh.at < 2 * DECK_POLL_MS ? fresh.candidates : null;
  runAttentionPass({
    candidates: () => usable ?? gatherAttention(defaultAttentionDeps(now, cfg.inflightShowAll, cfg.openAgents)),
    setAttention: (keys) => provider.setAttention(keys),
    notify: cfg.notifyOnActionRequired,
    focused: vscode.window.state.focused,
    latchFile: defaultAttentionFile(),
    nowMs: now,
    log,
  });
}
```

Import `POLL_MS as DECK_POLL_MS` from `./deckView`.

- [ ] **Step 3b: Export `attentionPass` and test it directly**

`export function attentionPass(...)` rather than a bare module-local function. The interval
callback is never driven by `extension.test.ts` (real timers), so without an export this
function's body is unreachable from any test and `npm run test:cov` will be short on
`extension.ts`. Exporting it is safe: `compat.test.ts` freezes the *manifest* surface —
commands, settings, storage keys — not this module's exports.

Append to `test/unit/extension.test.ts`:

```ts
  it("prefers the open Deck's candidates over gathering its own", () => {
    // Same reduction over the same inputs is what keeps the badge from
    // contradicting the column beside it.
    vi.mocked(DeckPanel.latestCandidates).mockReturnValue({
      candidates: [{ key: "BITE-9", agentState: "needs-you", prs: {}, ticketStatus: null,
        hasLiveSession: true, justLaunched: false, hasWorkToLose: false, showAll: false }],
      at: Date.now(),
    });
    attentionPass(providerStub as never, () => {});
    expect(providerStub.setAttention).toHaveBeenCalledWith(["BITE-9"]);
  });

  it("gathers its own candidates when no Deck panel is open", () => {
    vi.mocked(DeckPanel.latestCandidates).mockReturnValue(null);
    attentionPass(providerStub as never, () => {});
    expect(providerStub.setAttention).toHaveBeenCalled();
  });
```

`extension.test.ts` already mocks `../../src/deckView` (it stubs `DeckPanel.show`) — add
`latestCandidates: vi.fn(() => null)` to that stub rather than creating a second mock.

- [ ] **Step 4: Run the full gate**

```bash
cd /Users/oznasi/dev/agent-flow-e1-spec
npm run typecheck
npm test        # timeout: 600000 through a tool; never pipe through tail
npm run build   # the real gate for the webview import rule
```

Expected: all three pass. `npm run build` matters here: `attentionFs.ts` reaches `fs` and `child_process` transitively, so if anything reachable from a webview entry point ever imports it, this is where you find out — `tsc` and the suite pass regardless.

If one test out of ~4,500 fails, re-run that file alone before believing it — the suite flakes under CPU contention.

- [ ] **Step 5: Verify in a real editor window**

`npm test` cannot see a badge. Build and launch the dev host:

```bash
cd /Users/oznasi/dev/agent-flow-e1-spec
npm run build
code --extensionDevelopmentPath=/Users/oznasi/dev/agent-flow-e1-spec
```

Only VS Code's own `code` CLI works — the Cursor CLI silently drops `--extensionDevelopmentPath`. In the dev window: open the Agent Flow sidebar once, start a Claude Code session in a repo and let it ask you something, close the Deck panel, and confirm the activity-bar icon badges within ~12 seconds. Then turn `agentFlow.notifyOnActionRequired` on and confirm one notification, not one per pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/oznasi/dev/agent-flow-e1-spec
git add src/extension.ts test/_mocks/vscode.ts test/unit/extension.test.ts
git commit -m "feat(deck): attention that survives a closed panel

The sidebar badge tracks Action required whether or not the Deck is open,
riding the poll that already outlives every panel at half its cadence. While
the Deck is open the pass reuses the board's own candidates, so the badge and
the column can never disagree.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Coverage, changelog, README

**Files:**
- Modify: `CHANGELOG.md`, `README.md`

- [ ] **Step 1: Check coverage on the new modules**

Run: `npm run test:cov` (timeout 600000)
Expected: thresholds hold — 90% lines/statements, 85% branches/functions.

If `attention.ts`, `attentionFs.ts`, `attentionStore.ts`, `attentionJob.ts` or the new `extension.ts` branches are short, add the missing cases as real tests. Do not lower a threshold, and do not add an assertion-free test to move a number.

- [ ] **Step 2: Add the changelog entry**

Under `## [Unreleased]` in `CHANGELOG.md`:

```markdown
- **The activity-bar icon now badges how many sessions are waiting on you**, and keeps
  tracking it while the Deck is closed — the Deck's own poll stops when its panel hides, so
  a run entering Action required used to be silent. The badge costs no PR or ticket lookups:
  it reads Claude Code's transcripts, your open sessions, and PR facts already cached.
- **Optional notification when a run enters Action required**, off by default
  (`agentFlow.notifyOnActionRequired`). Raised once when a run parks, by whichever window is
  focused at the time, and not repeated until that run is answered and parks again.
```

- [ ] **Step 3: Document the setting**

Add `agentFlow.notifyOnActionRequired` to the README's settings table, matching the surrounding rows' wording and column order. Read the table first; do not restructure it.

- [ ] **Step 4: Final gate and commit**

```bash
cd /Users/oznasi/dev/agent-flow-e1-spec
npm run typecheck && npm test && npm run build
git add CHANGELOG.md README.md
git commit -m "docs: changelog and settings entry for the attention badge

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Notes for the reviewer between tasks

- **Tasks 1 and 7 are refactors.** Their proof is that `status.test.ts` and `deckView.test.ts` pass **unmodified**. A test edited to go green in either task is the signal to stop and re-read the change.
- **Tasks 2, 5 and 6 carry the invariants.** Task 2's ticket-status test and Task 7's parity test are what keep the badge honest; Task 5's git-spy test is what keeps the hidden path cheap. All three were mutation-checked in their own steps — if a step was skipped, the test may be vacuous.
- **The accepted trade-offs are in the spec, not bugs to fix here:** `prMerged` read from the on-disk cache can badge a since-merged run until something refreshes it; a sidebar never opened in a window gets no badge; a run that parks while no window is focused never toasts.
