# Deck Two-Tier Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the Deck card into a four-row summary and a right-hand detail drawer, so a column reads as a list of same-shaped cards instead of a stack of unrelated blocks.

**Architecture:** A new pure module derives the card's one-line signal. A new `DeckDetail` component renders the relocated detail (work, PR blocks, agents, actions) in a fixed right drawer with the Orchestrator drawer's geometry. `DeckApp` gains one piece of state — the selected `DeckCard.id` — which mounts the drawer and is mutually exclusive with the Orchestrator drawer. The card is thinned **last**, once the detail has somewhere to live, so the existing suite stays green until the one task that must change it.

**Tech Stack:** TypeScript, React 18, esbuild, Vitest + @testing-library/react (jsdom). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-16-deck-two-tier-card-design.md` — read it before Task 1. This plan implements it and does not restate its reasoning.

## Global Constraints

- **Worktree:** all work happens in `/Users/oznasi/dev/agent-flow-d2` on branch `feat/deck-two-tier-card`. Use absolute paths in shell commands — parallel sessions share the root checkout at `/Users/oznasi/dev/agent-flow` and will switch its branch under you.
- **Node is not on the bare PATH.** Prefix every command: `export PATH="/Users/oznasi/.nvm/versions/node/v22.22.3/bin:$PATH"`.
- **Gates, all four, before every commit:** `npm run typecheck` (clean), `npm test` (green), `npm run test:cov` (thresholds enforced), `npm run build` (succeeds). A commit that has not run all four is not done.
- **`npm run build` is not optional.** `src/webview/` must not import `fs`, `os`, `path`, or `child_process`, even transitively. `tsc` and the full test suite pass regardless — only the build catches it.
- **Never break existing users.** Thousands of installs. Behavior not named in the spec must not change.
- **Test-first.** Write the failing test, run it, watch it fail for the stated reason, then implement.
- **Mutation-check every new test.** After a test passes, break the implementation line it targets (flip a comparison, return an empty array, delete a branch), re-run, and confirm the test fails. Restore. A test that still passes against broken code is a defect — rewrite it. Do this for every assertion block, not once per file.
- **Monospace is for identifiers only.** Issue keys, branches, repo names, diff counts, PR fields. Anything that reads as English is set in the UI font. This rule is load-bearing in `deckStyles.ts`; see its file header.
- **Saturated color is spent on attention debt only.** Red means a real failure. A card that needs nothing from you stays monochrome.

---

### Task 1: The signal line's pure core

A card's one-line signal is derived, capped at three bits, and worst-fact-first. It is pure data with no React in it, so it is built and tested first and alone.

**Files:**
- Create: `src/webview/deckSignal.ts`
- Create: `test/webview/deckSignal.test.ts`

**Interfaces:**
- Consumes: `RunStatus`, `CardAgent`, `PrFacts` from `src/types.ts`.
- Produces: `export type SignalBit`, `export function cardSignal(r: RunStatus, agent: CardAgent | null): SignalBit[]` — returns at most 3 bits. Task 4 renders these.

- [ ] **Step 1: Write the failing tests**

Create `test/webview/deckSignal.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { cardSignal } from "../../src/webview/deckSignal";
import type { CardAgent, PrEntryMap, PrFacts, RepoGit, RunStatus } from "../../src/types";

const facts = (over: Partial<PrFacts> = {}): PrFacts => ({
  number: 10, url: "https://gh/pr/10", title: "t", state: "OPEN", isDraft: false,
  ci: { passing: 3, pending: 0, failing: [] },
  review: "none", unresolved: null, mergeable: "clean", ciAdvisory: false, ...over,
});

const repo = (over: Partial<RepoGit> = {}): RepoGit => ({
  name: "svc", path: "/r/svc", branch: "feat/x", dirty: false, ahead: 0,
  added: 0, removed: 0, files: 0, ...over,
});

const status = (over: Partial<RunStatus> = {}): RunStatus => ({
  run: {
    key: "ASM-1", summary: "s", url: "https://jira/ASM-1", createdAt: 1, mode: "per-window",
    repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "feat/x" }], briefPaths: [],
  },
  column: "progress", ticketStatus: null, ticketCategory: null,
  repos: [repo()], agent: { state: "working", lastActivityMs: 1, slug: null },
  windowOpen: false, prs: {} as PrEntryMap, agents: [], shelf: "board", ...over,
});

const pr = (f: PrFacts): PrEntryMap => ({ svc: { facts: f, fetchedAt: 1 } } as PrEntryMap);

describe("cardSignal", () => {
  it("never returns more than three bits", () => {
    const bits = cardSignal(status({
      repos: [repo({ added: 9, removed: 1 }), repo({ name: "b", added: 2, removed: 2 })],
      prs: pr(facts({ ci: { passing: 0, pending: 0, failing: [{ name: "e2e", url: "" }] },
        review: "changes_requested", mergeable: "conflicting" })),
    }), null);
    expect(bits).toHaveLength(3);
  });

  it("leads a PR card with the number, then CI, then the worst merge blocker", () => {
    const bits = cardSignal(status({
      prs: pr(facts({ number: 42, ci: { passing: 1, pending: 0, failing: [{ name: "e2e", url: "" }] },
        mergeable: "conflicting" })),
    }), null);
    expect(bits).toEqual([
      { kind: "text", text: "#42", mono: true },
      { kind: "text", text: "✗ e2e", tone: "bad" },
      { kind: "text", text: "conflicts", tone: "warn" },
    ]);
  });

  it("prefers conflicts over requested changes as the third bit", () => {
    const bits = cardSignal(status({
      prs: pr(facts({ review: "changes_requested", mergeable: "conflicting" })),
    }), null);
    expect(bits[2]).toEqual({ kind: "text", text: "conflicts", tone: "warn" });
  });

  it("says changes when there is no conflict", () => {
    const bits = cardSignal(status({
      prs: pr(facts({ review: "changes_requested", mergeable: "clean" })),
    }), null);
    expect(bits[2]).toEqual({ kind: "text", text: "changes", tone: "warn" });
  });

  it("reports running checks rather than a pass count", () => {
    const bits = cardSignal(status({
      prs: pr(facts({ ci: { passing: 2, pending: 3, failing: [] } })),
    }), null);
    expect(bits[1]).toEqual({ kind: "text", text: "3 running" });
  });

  it("drops the merge bit on a merged PR — it has no blocker left", () => {
    const bits = cardSignal(status({
      prs: pr(facts({ state: "MERGED", review: "approved" })),
    }), null);
    expect(bits).toEqual([
      { kind: "text", text: "#10", mono: true },
      { kind: "text", text: "merged", tone: "ok" },
      { kind: "text", text: "approved", tone: "ok" },
    ]);
  });

  it("never puts diff totals on a card that has a PR", () => {
    const bits = cardSignal(status({
      repos: [repo({ added: 99, removed: 4 })], prs: pr(facts()),
    }), null);
    expect(bits.some((b) => b.kind === "diff")).toBe(false);
  });

  it("falls back to branch, diff totals and repo count without a PR", () => {
    const bits = cardSignal(status({
      repos: [repo({ added: 9, removed: 1 }), repo({ name: "b", added: 2, removed: 2 })],
    }), null);
    expect(bits).toEqual([
      { kind: "text", text: "⎇ feat/x", mono: true },
      { kind: "diff", added: 11, removed: 3 },
      { kind: "text", text: "2 repos" },
    ]);
  });

  it("counts agents instead of repos when there is only one repo", () => {
    const agents = [
      { session: { pid: 1, sessionId: "a", cwd: "/r/svc", startedAt: 0, name: "a" },
        activity: { state: "working", lastActivityMs: 1, slug: null } },
      { session: { pid: 2, sessionId: "b", cwd: "/r/svc", startedAt: 0, name: "b" },
        activity: { state: "idle", lastActivityMs: 1, slug: null } },
    ] as CardAgent[];
    const bits = cardSignal(status({ repos: [repo({ added: 1, removed: 1 })], agents }), null);
    expect(bits[2]).toEqual({ kind: "text", text: "2 agents" });
  });

  it("omits the diff bit when nothing changed", () => {
    const bits = cardSignal(status(), null);
    expect(bits).toEqual([{ kind: "text", text: "⎇ feat/x", mono: true }]);
  });

  it("reads the agent's own repo for the branch, not repos[0]", () => {
    const agent = {
      session: { pid: 1, sessionId: "a", cwd: "/r/b", startedAt: 0, name: "a" },
      activity: { state: "working", lastActivityMs: 1, slug: null }, repo: "b",
    } as CardAgent;
    const bits = cardSignal(status({
      run: {
        ...status().run,
        repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "feat/x" },
                { name: "b", path: "/r/b", isGit: true, branch: "feat/other" }],
      },
    }), agent);
    expect(bits[0]).toEqual({ kind: "text", text: "⎇ feat/other", mono: true });
  });

  it("picks the failing PR when several repos have one", () => {
    const prs = {
      alpha: { facts: facts({ number: 1 }), fetchedAt: 1 },
      beta: { facts: facts({ number: 2, ci: { passing: 0, pending: 0, failing: [{ name: "unit", url: "" }] } }), fetchedAt: 1 },
    } as PrEntryMap;
    const bits = cardSignal(status({ prs }), null);
    expect(bits[0]).toEqual({ kind: "text", text: "#2", mono: true });
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
export PATH="/Users/oznasi/.nvm/versions/node/v22.22.3/bin:$PATH"
cd /Users/oznasi/dev/agent-flow-d2 && npx vitest run test/webview/deckSignal.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/webview/deckSignal"`.

- [ ] **Step 3: Implement `deckSignal.ts`**

Create `src/webview/deckSignal.ts`:

```ts
import { CardAgent, PrFacts, RunStatus } from "../types";

/** One element of a card's signal line. `diff` is its own kind rather than a
 * formatted string because the two halves take different colors, and a card
 * must never set a count in anything but mono. */
export type SignalBit =
  | { kind: "text"; text: string; tone?: "bad" | "warn" | "ok"; mono?: boolean }
  | { kind: "diff"; added: number; removed: number };

const REVIEW_TEXT: Record<PrFacts["review"], string> = {
  approved: "approved",
  changes_requested: "changes",
  review_required: "required",
  none: "pending",
};

/** The PR this card speaks for. A card names one PR, so when several repos have
 * one it must pick the same one every render: the first failing PR by repo name,
 * else the first PR by repo name. Sorting is what makes it deterministic —
 * `Object.entries` order follows insertion, which the host does not promise. */
function leadPr(r: RunStatus): PrFacts | null {
  const withFacts = Object.entries(r.prs)
    .map(([repo, e]) => [repo, e.facts] as const)
    .filter((x): x is readonly [string, PrFacts] => x[1] !== null)
    .sort((a, b) => a[0].localeCompare(b[0]));
  if (withFacts.length === 0) return null;
  return (withFacts.find(([, f]) => f.ci.failing.length > 0) ?? withFacts[0])[1];
}

/**
 * The one line a card at rest gets, worst fact first and capped at three bits.
 *
 * The cap is the whole design: a card that says five things says nothing, and
 * the fourth bit is always the least decisive one. Diff totals lose to PR news
 * outright — "how big" never outranks "what is wrong".
 */
export function cardSignal(r: RunStatus, agent: CardAgent | null): SignalBit[] {
  const bits: SignalBit[] = [];
  const f = leadPr(r);

  if (f) {
    bits.push({ kind: "text", text: `#${f.number}`, mono: true });

    if (f.ci.failing.length > 0) {
      bits.push({ kind: "text", text: `✗ ${f.ci.failing[0].name}`, tone: "bad" });
    } else if (f.ci.pending > 0) {
      bits.push({ kind: "text", text: `${f.ci.pending} running` });
    } else if (f.state === "MERGED") {
      bits.push({ kind: "text", text: "merged", tone: "ok" });
    } else {
      bits.push({ kind: "text", text: "✓ ci", tone: "ok" });
    }

    // Only an open PR has a mergeability worth reporting — GitHub stops computing
    // it once the PR closes, exactly as PrBlock's own comment explains.
    if (f.state === "OPEN" && f.mergeable === "conflicting") {
      bits.push({ kind: "text", text: "conflicts", tone: "warn" });
    } else if (f.review === "changes_requested") {
      bits.push({ kind: "text", text: "changes", tone: "warn" });
    } else if (f.review === "approved") {
      bits.push({ kind: "text", text: "approved", tone: "ok" });
    } else if (f.state !== "MERGED") {
      bits.push({ kind: "text", text: REVIEW_TEXT[f.review] });
    }

    return bits.slice(0, 3);
  }

  // The agent's own repo, not repos[0]: on a multi-root card the first repo may
  // be one this session never touched.
  const own = agent?.repo ? r.run.repos.find((x) => x.name === agent.repo) : undefined;
  const branch = (own ?? r.run.repos[0])?.branch;
  if (branch) bits.push({ kind: "text", text: `⎇ ${branch}`, mono: true });

  const tot = r.repos.reduce((s, g) => ({ a: s.a + g.added, d: s.d + g.removed }), { a: 0, d: 0 });
  if (tot.a > 0 || tot.d > 0) bits.push({ kind: "diff", added: tot.a, removed: tot.d });

  if (r.repos.length > 1) bits.push({ kind: "text", text: `${r.repos.length} repos` });
  else if (r.agents.length > 1) bits.push({ kind: "text", text: `${r.agents.length} agents` });

  return bits.slice(0, 3);
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
cd /Users/oznasi/dev/agent-flow-d2 && npx vitest run test/webview/deckSignal.test.ts
```

Expected: PASS, 12 tests.

- [ ] **Step 5: Mutation-check the new tests**

For each of these, make the edit, re-run the file, confirm a test **fails**, then revert:

1. Change `bits.slice(0, 3)` (the PR branch) to `bits` → "never returns more than three bits" must fail.
2. Swap the `conflicting` and `changes_requested` branches → "prefers conflicts over requested changes" must fail.
3. Delete the `f.state !== "MERGED"` guard on the last `else if` → "drops the merge bit on a merged PR" must fail.
4. Change `(own ?? r.run.repos[0])` to `r.run.repos[0]` → "reads the agent's own repo" must fail.
5. Drop `.sort(...)` from `leadPr` and remove the `.find(failing)` → "picks the failing PR" must fail.

If any of those five edits leaves the suite green, that test is vacuous — rewrite it before continuing.

- [ ] **Step 6: Run the full gates and commit**

```bash
cd /Users/oznasi/dev/agent-flow-d2
npm run typecheck && npm test && npm run test:cov && npm run build
git add src/webview/deckSignal.ts test/webview/deckSignal.test.ts
git commit -m "feat(deck): derive a card's one-line signal, capped at three bits

The card at rest gets one line, so the line has to choose. PR news
outranks size outright — how big a change is never beats what is wrong
with it — and the third bit is whatever stands between the PR and a
merge, conflicts first.

Pure and standalone: nothing renders it yet."
```

---

### Task 2: The detail drawer component

Build the drawer as a standalone component with its own tests. Nothing mounts it yet, so the existing suite is untouched and stays green.

**Files:**
- Create: `src/webview/DeckDetail.tsx`
- Create: `test/webview/DeckDetail.test.tsx`
- Modify: `src/webview/deckStyles.ts` (append the drawer's rules to `DECK_CSS`)

**Interfaces:**
- Consumes: `DeckCard` from `src/webview/deckCards.ts`; `send` from `src/webview/vscodeApi`; `cardSignal` is **not** used here.
- Produces: `export function DeckDetail(p: DeckDetailProps): JSX.Element`, with
  `interface DeckDetailProps { card: DeckCard; sourceLabel: string; onClose: () => void; onForget: (key: string) => void; }`. Task 3 mounts it.

- [ ] **Step 1: Write the failing tests**

Create `test/webview/DeckDetail.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";

vi.mock("../../src/webview/vscodeApi", () => ({ send: vi.fn() }));

import { DeckDetail } from "../../src/webview/DeckDetail";
import { send } from "../../src/webview/vscodeApi";
import type { DeckCard } from "../../src/webview/deckCards";
import type { PrEntryMap, PrFacts, RunStatus } from "../../src/types";

const sent = vi.mocked(send);
beforeEach(() => sent.mockClear());

const facts = (over: Partial<PrFacts> = {}): PrFacts => ({
  number: 10, url: "https://gh/pr/10", title: "t", state: "OPEN", isDraft: false,
  ci: { passing: 3, pending: 0, failing: [] },
  review: "none", unresolved: null, mergeable: "clean", ciAdvisory: false, ...over,
});

const mkCard = (over: Partial<RunStatus> = {}, agent: DeckCard["agent"] = null): DeckCard => {
  const status: RunStatus = {
    run: {
      key: "ASM-1", summary: "Export fails", url: "https://jira/ASM-1", createdAt: 1,
      mode: "per-window",
      repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "feat/x" }], briefPaths: [],
    },
    column: "review", ticketStatus: "In Review", ticketCategory: "indeterminate",
    repos: [{ name: "svc", path: "/r/svc", branch: "feat/x", dirty: false, ahead: 0,
      added: 5, removed: 1, files: 2 }],
    agent: { state: "unknown", lastActivityMs: null, slug: null },
    windowOpen: false, prs: {} as PrEntryMap, agents: [], shelf: "board", ...over,
  };
  return { id: `p:${status.run.key}`, status, agent, agents: status.agents,
    column: status.column, lane: "waiting" };
};

const render1 = (card: DeckCard, onClose = vi.fn(), onForget = vi.fn()) =>
  render(<DeckDetail card={card} sourceLabel="Jira" onClose={onClose} onForget={onForget} />);

describe("DeckDetail", () => {
  it("names the run in its header", () => {
    render1(mkCard());
    const hd = document.querySelector(".dd-hd")!;
    expect(hd.textContent).toContain("ASM-1");
    expect(hd.textContent).toContain("Export fails");
  });

  it("relocates the branch, launched time and repo chips", () => {
    render1(mkCard());
    expect(document.querySelector(".dd .c-branch .bn")!.textContent).toContain("feat/x");
    expect(document.querySelector(".dd .c-repos .repo")!.textContent).toContain("svc");
  });

  it("relocates the PR block", () => {
    render1(mkCard({ prs: { svc: { facts: facts({ number: 77 }), fetchedAt: 1 } } as PrEntryMap }));
    expect(document.querySelector(".dd .pr-block")!.textContent).toContain("#77");
  });

  it("says so rather than rendering an empty section when there is no PR", () => {
    render1(mkCard());
    expect(document.querySelector(".dd .pr-block")).toBeNull();
    expect(screen.getByText(/no pull request yet/i)).toBeTruthy();
  });

  it("opens the workspace", () => {
    render1(mkCard());
    fireEvent.click(screen.getByRole("button", { name: /open workspace/i }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:inspect", key: "ASM-1", action: "open" });
  });

  it("scopes a per-repo diff to that repo", () => {
    const card = mkCard({
      repos: [
        { name: "svc", path: "/r/svc", branch: "feat/x", dirty: false, ahead: 0, added: 1, removed: 0, files: 1 },
        { name: "web", path: "/r/web", branch: "feat/x", dirty: false, ahead: 0, added: 2, removed: 0, files: 1 },
      ],
    });
    render1(card);
    fireEvent.click(screen.getByRole("button", { name: /diff — web/i }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:inspect", key: "ASM-1", action: "diff", repo: "web" });
  });

  it("offers no per-repo diff on a single-repo card — the all-repos one already is it", () => {
    render1(mkCard());
    expect(screen.queryByRole("button", { name: /diff — svc/i })).toBeNull();
  });

  it("offers Address PR on the waiting lane", () => {
    const { container } = render1(mkCard());
    expect(within(container).getByRole("button", { name: /address pr/i })).toBeTruthy();
  });

  it("offers no Address PR on the ready lane", () => {
    const { container } = render1({ ...mkCard(), lane: "ready" });
    expect(within(container).queryByRole("button", { name: /address pr/i })).toBeNull();
  });

  it("offers no Address PR on a local card, whatever the lane", () => {
    const card = mkCard({ run: { ...mkCard().status.run, key: "local-abc", url: "", kind: "local" } as never });
    const { container } = render1(card);
    expect(within(container).queryByRole("button", { name: /address pr/i })).toBeNull();
  });

  it("links each failing check by name", () => {
    render1(mkCard({
      prs: { svc: { facts: facts({ ci: { passing: 0, pending: 0, failing: [{ name: "e2e", url: "https://ci/e2e" }] } }), fetchedAt: 1 } } as PrEntryMap,
    }));
    fireEvent.click(screen.getByRole("button", { name: /open failing check — e2e/i }));
    expect(sent).toHaveBeenCalledWith({ type: "openExternal", url: "https://ci/e2e" });
  });

  it("copies the branch name without touching the host", () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    render1(mkCard());
    fireEvent.click(screen.getByRole("button", { name: /copy branch name/i }));
    expect(writeText).toHaveBeenCalledWith("feat/x");
    expect(sent).not.toHaveBeenCalled();
  });

  it("forgets through the callback, not a raw post", () => {
    const onForget = vi.fn();
    render1(mkCard(), vi.fn(), onForget);
    fireEvent.click(screen.getByRole("button", { name: /^forget$/i }));
    expect(onForget).toHaveBeenCalledWith("ASM-1");
  });

  it("offers Track it instead of Forget on a local card", () => {
    render1(mkCard({ run: { ...mkCard().status.run, key: "local-abc", url: "", kind: "local" } as never }));
    expect(screen.queryByRole("button", { name: /^forget$/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /track it/i }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:track", key: "local-abc" });
  });

  it("prints how many actions it is offering", () => {
    render1(mkCard());
    const n = document.querySelectorAll(".dd-act").length;
    expect(document.querySelector(".dd-count")!.textContent).toContain(String(n));
  });

  it("closes on its close button", () => {
    const onClose = vi.fn();
    render1(mkCard(), onClose);
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
cd /Users/oznasi/dev/agent-flow-d2 && npx vitest run test/webview/DeckDetail.test.tsx
```

Expected: FAIL — cannot resolve `../../src/webview/DeckDetail`.

- [ ] **Step 3: Extract the pieces the drawer reuses**

`PrBlock`, `RepoChip`, `WorkspaceChip`, `AgentsRow` and `workspaceLabel` are module-private in `src/webview/DeckApp.tsx`. Add `export` to each of those five declarations. Do **not** move them — Task 4 removes their last use inside `DeckApp` and they can move then if it reads better. Changing only the visibility keeps this task's diff reviewable.

- [ ] **Step 4: Implement `DeckDetail.tsx`**

Create `src/webview/DeckDetail.tsx`:

```tsx
import * as React from "react";
import { send } from "./vscodeApi";
import { isTicketRun, runKind } from "../types";
import type { DeckCard } from "./deckCards";
import { AgentsRow, PrBlock, RepoChip, WorkspaceChip, workspaceLabel } from "./DeckApp";
import { timeAgo } from "./helpers";

export interface DeckDetailProps {
  card: DeckCard;
  sourceLabel: string;
  onClose: () => void;
  onForget: (key: string) => void;
}

/** One row in the action list. `run` does the work; the list itself is data so
 * the count the header prints can never drift from the rows rendered. */
interface Action {
  label: string;
  /** The identifier this action acts on — a branch, a key, a url. Set in mono
   * beside the label, and left out when the label already says everything. */
  hint?: string;
  danger?: boolean;
  run: () => void;
}

/** Clipboard writes are webview-local on purpose: routing them through the host
 * would mean a new message for something the browser already does. Guarded
 * because a webview without clipboard permission has no `navigator.clipboard`,
 * and an unguarded read throws out of the click handler. */
function copy(text: string): void {
  void navigator.clipboard?.writeText(text);
}

export function DeckDetail({ card, sourceLabel, onClose, onForget }: DeckDetailProps): JSX.Element {
  const r = card.status;
  const key = r.run.key;
  const tracked = isTicketRun(r.run);
  const local = runKind(r.run) === "local";
  const repo = card.agent?.repo;
  const own = repo ? r.run.repos.find((x) => x.name === repo) : undefined;
  const branch = (own ?? r.run.repos[0])?.branch ?? "";
  const withPr = Object.entries(r.prs)
    .filter((e): e is [string, { facts: NonNullable<typeof e[1]["facts"]> }] => e[1].facts !== null);
  const lead = withPr[0]?.[1].facts;

  // Address PR rides the lane, not the ticket status. The `local` guard stays:
  // a local card's key is read off its branch, so its status may belong to a
  // ticket somebody else owns — not something to seed an agent against.
  const canAddressPr = !local && card.column === "review" && card.lane === "waiting";

  const actions: { group: string; items: Action[] }[] = [
    { group: "This task", items: [
      { label: "Open workspace", hint: r.windowOpen ? "already running" : undefined,
        run: () => send({ type: "deck:inspect", key, action: "open", ...(repo ? { repo } : {}) }) },
      { label: "Diff — all repos",
        run: () => send({ type: "deck:inspect", key, action: "diff", ...(repo ? { repo } : {}) }) },
      ...(r.repos.length > 1
        ? r.repos.map((g) => ({ label: `Diff — ${g.name}`,
            run: () => send({ type: "deck:inspect", key, action: "diff", repo: g.name }) }))
        : []),
      ...(canAddressPr
        ? [{ label: "Address PR", hint: "seed an agent against the review",
            run: () => send({ type: "deck:addressPr", key }) }]
        : []),
      ...(tracked
        ? [{ label: `Open in ${sourceLabel}`, hint: key,
            run: () => send({ type: "openExternal", url: r.run.url }) }]
        : []),
    ] },
    { group: "Pull request", items: lead
      ? [
          { label: `Open PR #${lead.number}`, run: () => send({ type: "openExternal", url: lead.url }) },
          ...lead.ci.failing.filter((c) => c.url).map((c) => ({
            label: `Open failing check — ${c.name}`,
            run: () => send({ type: "openExternal", url: c.url }),
          })),
        ]
      : [] },
    { group: "Copy", items: [
      ...(branch ? [{ label: "Copy branch name", hint: branch, run: () => copy(branch) }] : []),
      ...(tracked ? [{ label: "Copy ticket key", hint: key, run: () => copy(key) }] : []),
      ...(lead ? [{ label: "Copy PR url", hint: `#${lead.number}`, run: () => copy(lead.url) }] : []),
      ...((own ?? r.run.repos[0])
        ? [{ label: "Copy worktree path", hint: (own ?? r.run.repos[0]).path,
            run: () => copy((own ?? r.run.repos[0]).path) }]
        : []),
    ] },
    { group: "Record", items: [
      local
        ? { label: "Track it", hint: "give this place a ticket", run: () => send({ type: "deck:track", key }) }
        : { label: "Forget", hint: "the worktree is left untouched", danger: true, run: () => onForget(key) },
    ] },
  ];

  const groups = actions.filter((g) => g.items.length > 0);
  const count = groups.reduce((n, g) => n + g.items.length, 0);
  const ws = workspaceLabel(r.run);

  return (
    <aside className="dd" aria-label={`Detail for ${key}`}>
      <div className="dd-hd">
        <span className="k">{key}</span>
        <span className="t" title={r.run.summary}>{r.run.summary}</span>
        <button type="button" className="dd-x" aria-label="Close" onClick={onClose}>✕</button>
      </div>

      <div className="dd-sec">
        <div className="dd-lbl">Work</div>
        <div className="c-branch">
          {branch && <span className="bn" title={branch}>⎇ {branch}</span>}
          <span className="elapsed">launched {timeAgo(r.run.createdAt)}</span>
        </div>
        {ws && r.repos.length > 1
          ? <WorkspaceChip label={ws} repos={r.repos} filePath={r.run.workspaceFile ?? ws} />
          : r.repos.length > 0 && (
              <div className="c-repos">{r.repos.map((g) => <RepoChip key={g.name} g={g} />)}</div>
            )}
      </div>

      <div className="dd-sec">
        <div className="dd-lbl">Pull requests</div>
        {withPr.length > 0
          ? withPr.map(([name, e]) => <PrBlock key={name} repo={name} f={e.facts} showRepo={withPr.length > 1} />)
          : <div className="dd-none">No pull request yet</div>}
      </div>

      <div className="dd-sec">
        <div className="dd-lbl">Agents</div>
        {card.agents.length > 0
          ? <AgentsRow agents={card.agents} />
          : <div className="dd-none">No agent open — git + {sourceLabel} only</div>}
      </div>

      <div className="dd-lbl dd-count">{count} actions</div>
      {groups.map((g) => (
        <div className="dd-sec" key={g.group}>
          <div className="dd-lbl">{g.group}</div>
          {g.items.map((a) => (
            <button type="button" className={`dd-act${a.danger ? " danger" : ""}`} key={a.label} onClick={a.run}>
              <span className="t">{a.label}</span>
              {a.hint && <span className="h">{a.hint}</span>}
            </button>
          ))}
        </div>
      ))}
    </aside>
  );
}
```

`AgentsRow` renders a collapsed fold. The spec calls for expanded rows in the drawer; that is Task 4's cleanup, when `AgentsRow` loses its only other caller. Leaving it folded here keeps this task's diff to one new file.

- [ ] **Step 5: Add the drawer's CSS**

Append to the `DECK_CSS` template literal in `src/webview/deckStyles.ts`, before its closing backtick:

```css
  /* The selected card's detail. Same geometry as the Orchestrator drawer — below
     the header, anchored right, no scrim — because it is the same kind of object
     and the two are mutually exclusive. 460px is the narrowest width at which a
     .pr-block's label column and value column both fit without wrapping. */
  .dd { position: fixed; top: 53px; right: 0; bottom: 0; width: 460px; z-index: 40;
    display: flex; flex-direction: column; overflow: auto;
    background: var(--vscode-editorWidget-background);
    border-left: 1px solid var(--hair); box-shadow: -10px 0 26px rgba(0,0,0,.28); }
  .dd-hd { display: flex; align-items: center; gap: 8px; padding: 9px 12px;
    border-bottom: 1px solid var(--hair); }
  .dd-hd .k { font-family: var(--vscode-editor-font-family); font-size: 12px; white-space: nowrap; }
  .dd-hd .t { font-size: var(--t-body); color: var(--dim);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dd-x { margin-left: auto; background: none; border: none; cursor: pointer;
    color: var(--dim); font-size: 13px; padding: 2px 5px; }
  .dd-x:hover { color: var(--vscode-foreground); }
  .dd-sec { padding: 10px 12px; }
  .dd-sec + .dd-sec { border-top: 1px solid var(--hair); }
  .dd-lbl { font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase;
    color: var(--dim); opacity: .8; margin-bottom: 7px; }
  .dd-count { padding: 9px 12px 0; margin: 0; }
  .dd-none { font-size: var(--t-body); color: var(--dim); }
  /* A list row, not a button slab: twelve bordered controls in a column would
     read as twelve competing calls to action. */
  .dd-act { display: flex; align-items: baseline; gap: 8px; width: 100%; text-align: left;
    background: none; border: none; border-radius: var(--r-ctl); cursor: pointer;
    padding: 5px 7px; color: var(--vscode-foreground); font-size: var(--t-body); }
  .dd-act:hover { background: var(--vscode-toolbar-hoverBackground); }
  .dd-act:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .dd-act.danger { color: var(--c-attn); }
  .dd-act .h { margin-left: auto; font-family: var(--vscode-editor-font-family);
    font-size: 11.5px; color: var(--dim);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

- [ ] **Step 6: Run the tests and confirm they pass**

```bash
cd /Users/oznasi/dev/agent-flow-d2 && npx vitest run test/webview/DeckDetail.test.tsx
```

Expected: PASS, 16 tests.

- [ ] **Step 7: Mutation-check**

Make each edit, re-run, confirm a failure, revert:

1. Drop the `repo` spread from the per-repo Diff's `send` → "scopes a per-repo diff" must fail.
2. Change `canAddressPr` to `!local && card.column === "review"` → "offers Address PR on the waiting lane and not elsewhere" must fail.
3. Replace `copy(branch)` with `send({ type: "openExternal", url: branch })` → "copies the branch name without touching the host" must fail.
4. Hard-code `{count}` to `12` → "prints how many actions" must fail.
5. Remove the `.filter((c) => c.url)` on failing checks and pass a check with `url: ""` → confirm the existing check test still passes and add nothing; this one is a **read**, not an edit: satisfy yourself the filter is covered, and if it is not, add a test that a check with no url renders no action.

- [ ] **Step 8: Full gates and commit**

```bash
cd /Users/oznasi/dev/agent-flow-d2
npm run typecheck && npm test && npm run test:cov && npm run build
git add src/webview/DeckDetail.tsx src/webview/deckStyles.ts src/webview/DeckApp.tsx test/webview/DeckDetail.test.tsx
git commit -m "feat(deck): a detail drawer for the selected card

Holds what the card is about to stop carrying: the branch row, the repo
chips, every PR block, the agent list, and the actions — ten-odd of them,
grouped, with the drawer printing its own count so the header cannot
drift from the rows.

No new host message. Per-repo Diff uses deck:inspect's existing repo
parameter and the copies are webview-local, which is why three otherwise
obvious actions (reveal in Finder, open a terminal, focus an agent) are
not here.

Nothing mounts this yet."
```

---

### Task 3: Selection, mounting, and the Orchestrator's slot

Wire the drawer up while the card still looks exactly as it does today. The existing suite must stay green through this task — if a card test breaks here, the change was too wide.

**Files:**
- Modify: `src/webview/DeckApp.tsx`
- Modify: `src/webview/deckStyles.ts`
- Modify: `test/webview/DeckApp.test.tsx` (additions only)

**Interfaces:**
- Consumes: `DeckDetail` from Task 2.
- Produces: `.card.sel` on the selected card; the board's `sel` state. Task 4 renders the summary against it.

- [ ] **Step 1: Write the failing tests**

Append to `test/webview/DeckApp.test.tsx`:

```tsx
describe("card selection", () => {
  const card = () => document.querySelector(".card") as HTMLElement;

  it("mounts no drawer until a card is selected", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    expect(document.querySelector(".dd")).toBeNull();
  });

  it("selects on click and opens the drawer for that card", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    fireEvent.click(card());
    expect(document.querySelector(".dd")).not.toBeNull();
    expect(document.querySelector(".dd-hd .k")!.textContent).toBe("ASM-1");
    expect(card().className).toContain("sel");
  });

  it("does not select when a card action is clicked", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    fireEvent.click(within(card()).getByRole("button", { name: /^open$/i }));
    expect(document.querySelector(".dd")).toBeNull();
  });

  it("clicking the selected card again clears it", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    fireEvent.click(card());
    fireEvent.click(card());
    expect(document.querySelector(".dd")).toBeNull();
  });

  it("re-targets the drawer when a second card is selected", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus(), mkStatus({ run: { ...mkStatus().run, key: "ASM-2" } })]));
    const cards = document.querySelectorAll(".card");
    fireEvent.click(cards[0]);
    fireEvent.click(cards[1]);
    expect(document.querySelectorAll(".dd")).toHaveLength(1);
    expect(document.querySelector(".dd-hd .k")!.textContent).toBe("ASM-2");
  });

  it("clears the selection on Escape", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    fireEvent.click(card());
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(document.querySelector(".dd")).toBeNull();
  });

  it("drops a selection whose card is gone from the next post", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    fireEvent.click(card());
    expect(document.querySelector(".dd")).not.toBeNull();
    host(runsMsg([mkStatus({ run: { ...mkStatus().run, key: "ASM-9" } })]));
    expect(document.querySelector(".dd")).toBeNull();
  });

  it("gives the board scroll run-out so a covered column stays reachable", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    expect(document.querySelector(".board")!.className).not.toContain("dd-open");
    fireEvent.click(card());
    expect(document.querySelector(".board")!.className).toContain("dd-open");
  });
});
```

- [ ] **Step 2: Run and confirm they fail**

```bash
cd /Users/oznasi/dev/agent-flow-d2 && npx vitest run test/webview/DeckApp.test.tsx -t "card selection"
```

Expected: FAIL — no `.dd` in the document.

- [ ] **Step 3: Add the state and mount the drawer**

In `src/webview/DeckApp.tsx`:

Add the state beside `openFlowId`:

```tsx
  /** The selected card's `DeckCard.id`, not a run key: the Agents lens renders
   * one card per session, so two cards can share a run and a key could not tell
   * them apart. */
  const [selId, setSelId] = React.useState<string | null>(null);
```

Add the Escape handler beside the other effects:

```tsx
  React.useEffect(() => {
    if (selId === null) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSelId(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selId]);
```

After `cards` is computed, resolve the selection and drop it if its card is gone:

```tsx
  // Resolved from the freshly projected list, so a selection whose run was
  // forgotten, closed, or re-bucketed into a different card id clears itself
  // rather than leaving the drawer rendering against a card that is no longer
  // on the board.
  const selected = selId === null ? null : cards.find((c) => c.id === selId) ?? null;
  React.useEffect(() => {
    if (selId !== null && selected === null) setSelId(null);
  }, [selId, selected]);
```

Give `Card` the two props and pass them from `card()`:

```tsx
  const card = (c: DeckCard): JSX.Element => (
    <Card key={c.id} r={c.status} prReviewStatus={prReviewStatus}
      onForget={forget} agent={c.agent} agents={c.agents} column={c.column} sourceLabel={sourceLabel}
      selected={c.id === selId}
      onSelect={() => setSelId((cur) => (cur === c.id ? null : c.id))} />
  );
```

In `Card`'s signature add `selected: boolean; onSelect: () => void;`, put `selected` on the class list and `onSelect` on the root:

```tsx
    <div
      className={`card ${column === "needs" ? "attn" : ""} ${selected ? "sel" : ""}`}
      onClick={onSelect}
```

Stop the footer's controls from selecting — wrap the existing `.c-foot` in a click guard rather than touching each button:

```tsx
      <div className="c-foot" onClick={(e) => e.stopPropagation()}>
```

The `.key` button and the `WorkspaceChip`/`AgentsRow` toggles need the same guard; add `onClick={(e) => e.stopPropagation()}` to the `c-top` and to the wrapper of any fold that is still on the card. A click that opens Jira must not also select.

Mark the board while the drawer is open, and mount the drawer last so it paints over the board:

```tsx
        <div className={`board${selected ? " dd-open" : ""}`}>
```

```tsx
      {selected && (
        <DeckDetail
          card={selected}
          sourceLabel={sourceLabel}
          onClose={() => setSelId(null)}
          onForget={forget}
        />
      )}
```

Import it: `import { DeckDetail } from "./DeckDetail";`

Make the two drawers mutually exclusive — they share the slot:

```tsx
            onClick={() => {
              setSelId(null);
              if (flows.length === 0) send({ type: "flow:create" });
              else setOpenFlowId((cur) => (cur ? null : flows[0].id));
            }}
```

and in the card's `onSelect`, close the Orchestrator:

```tsx
      onSelect={() => { setOpenFlowId(null); setSelId((cur) => (cur === c.id ? null : c.id)); }}
```

- [ ] **Step 4: Add the board's run-out**

Append to `DECK_CSS` in `src/webview/deckStyles.ts`:

```css
  /* At any realistic panel width there is no arrangement in which four columns
     and a 460px drawer all fit — something is always off-screen. .board is
     already a horizontal scroller, so this does not MOVE the columns: it adds
     scroll run-out past the last one, which is what lets a covered column be
     scrolled clear of the drawer. Nothing becomes unreachable. */
  .board.dd-open { padding-right: 470px; }
```

- [ ] **Step 5: Run the new tests, then the whole suite**

```bash
cd /Users/oznasi/dev/agent-flow-d2
npx vitest run test/webview/DeckApp.test.tsx -t "card selection"
npm test
```

Expected: the new block PASSes, and **the whole existing suite still passes unchanged**. The card's markup has not moved yet. If an existing test fails here, the edit reached further than this task allows — revert it rather than editing the test.

- [ ] **Step 6: Mutation-check**

1. Remove the `stopPropagation` guard on `.c-foot` → "does not select when a card action is clicked" must fail.
2. Change the selection reset effect to `if (false)` → "drops a selection whose card is gone" must fail.
3. Change `onSelect` to always `setSelId(c.id)` → "clicking the selected card again clears it" must fail.
4. Remove `setOpenFlowId(null)` from `onSelect` → add and run this assertion, which must fail without it:

```tsx
  it("closes the Orchestrator drawer when a card is selected", () => {
    render(<DeckApp />);
    host({ type: "deck:flows", flows: [{ id: "f1", name: "F", nodes: [], edges: [], armed: false } as never],
      enabled: true, pendingResume: [], promptModes: [], commands: [], branchCi: {} } as OutboundMessage);
    host(runsMsg([mkStatus()]));
    fireEvent.click(screen.getByRole("button", { name: /orchestrator/i }));
    expect(document.querySelector(".orch")).not.toBeNull();
    fireEvent.click(document.querySelector(".card") as HTMLElement);
    expect(document.querySelector(".dd")).not.toBeNull();
  });
```

Keep this test in the file.

- [ ] **Step 7: Full gates and commit**

```bash
cd /Users/oznasi/dev/agent-flow-d2
npm run typecheck && npm test && npm run test:cov && npm run build
git add src/webview/DeckApp.tsx src/webview/deckStyles.ts test/webview/DeckApp.test.tsx
git commit -m "feat(deck): select a card to open its detail drawer

Selection is keyed on DeckCard.id rather than the run key — the Agents
lens gives one card per session, so a key cannot tell two cards apart.
A selection resolved out of the freshly projected list clears itself when
its card leaves the board, so the drawer can never render against a card
that is gone.

The card drawer and the Orchestrator drawer share the slot and the
geometry, so opening either closes the other.

The card itself is untouched: the whole existing suite passes unchanged."
```

---

### Task 4: Thin the card

The one task that changes the card's DOM, and therefore the one that touches the existing assertions. Everything it removes already has a home.

**Files:**
- Modify: `src/webview/DeckApp.tsx`
- Modify: `src/webview/deckStyles.ts`
- Modify: `test/webview/DeckApp.test.tsx`

**Interfaces:**
- Consumes: `cardSignal`, `SignalBit` from Task 1; `DeckDetail` mounted in Task 3.

- [ ] **Step 1: Write the failing tests**

Append to `test/webview/DeckApp.test.tsx`:

```tsx
describe("the card at rest", () => {
  it("renders the signal line and no PR block, repo chips or branch row", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({
      prs: { svc: { facts: {
        number: 5, url: "u", title: "t", state: "OPEN", isDraft: false,
        ci: { passing: 1, pending: 0, failing: [] }, review: "approved",
        unresolved: 0, mergeable: "clean", ciAdvisory: false,
      }, fetchedAt: 1 } } as never,
    })]));
    const card = document.querySelector(".card")!;
    expect(card.querySelector(".c-sig")).not.toBeNull();
    expect(card.querySelector(".pr-block")).toBeNull();
    expect(card.querySelector(".c-repos")).toBeNull();
    expect(card.querySelector(".c-branch")).toBeNull();
    expect(card.querySelector(".c-agents")).toBeNull();
    expect(card.querySelector(".pill")).toBeNull();
  });

  it("shows Open and Diff in the footer, and no overflow menu", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    const labels = Array.from(document.querySelectorAll(".card .c-foot2 .act")).map((b) => b.textContent);
    expect(labels).toEqual(["Open", "Diff"]);
    expect(document.querySelector(".card .more")).toBeNull();
  });

  it("adds Address PR on the review column's waiting lane", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({
      column: "review",
      prs: { svc: { facts: {
        number: 5, url: "u", title: "t", state: "OPEN", isDraft: false,
        ci: { passing: 1, pending: 0, failing: [] }, review: "review_required",
        unresolved: 0, mergeable: "clean", ciAdvisory: false,
      }, fetchedAt: 1 } } as never,
    })]));
    const labels = Array.from(document.querySelectorAll(".card .c-foot2 .act")).map((b) => b.textContent);
    expect(labels).toContain("Address PR");
  });

  it("keeps Address PR off a local card even on that lane", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({
      column: "review", run: { ...mkStatus().run, key: "local-a", url: "", kind: "local" } as never,
      prs: { svc: { facts: {
        number: 5, url: "u", title: "t", state: "OPEN", isDraft: false,
        ci: { passing: 1, pending: 0, failing: [] }, review: "review_required",
        unresolved: 0, mergeable: "clean", ciAdvisory: false,
      }, fetchedAt: 1 } } as never,
    })]));
    const labels = Array.from(document.querySelectorAll(".card .c-foot2 .act")).map((b) => b.textContent);
    expect(labels).not.toContain("Address PR");
  });

  it("renders a diff bit with its two halves separately colored", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    const sig = document.querySelector(".card .c-sig")!;
    expect(sig.querySelector(".add")!.textContent).toBe("+12");
    expect(sig.querySelector(".del")!.textContent).toBe("−2");
  });
});
```

- [ ] **Step 2: Run and confirm they fail**

```bash
cd /Users/oznasi/dev/agent-flow-d2 && npx vitest run test/webview/DeckApp.test.tsx -t "the card at rest"
```

Expected: FAIL — no `.c-sig`, no `.c-foot2`.

- [ ] **Step 3: Rewrite `Card`'s body**

In `src/webview/DeckApp.tsx`, replace everything in `Card`'s returned JSX **after** `c-title` and **before** the closing `</div>` with the signal line and the new footer. Delete the `c-branch` block, the workspace/repo-chips block, the PR-block map, the `AgentsRow` call, the whole `c-foot` (pill, actions, overflow menu), and the now-unused `menuOpen` state and its effect.

```tsx
      <div className="c-sig">
        {cardSignal(r, agent).map((b, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span className="sep">·</span>}
            {b.kind === "diff"
              ? <span className="dd-diff"><span className="add">+{b.added}</span><span className="del">−{b.removed}</span></span>
              : <span className={`${b.mono ? "m" : ""} ${b.tone ?? ""}`.trim()}>{b.text}</span>}
          </React.Fragment>
        ))}
      </div>

      <div className="c-foot2" onClick={(e) => e.stopPropagation()}>
        <button
          className={`act primary ${r.windowOpen ? "live" : ""}`}
          title={r.windowOpen ? "Open now — Open focuses the window already running this task" : "Open this task's workspace"}
          onClick={() => send({ type: "deck:inspect", key: r.run.key, action: "open", ...(agent?.repo ? { repo: agent.repo } : {}) })}
        >
          Open
        </button>
        <button className="act" title="Show everything this task changed, file by file"
          onClick={() => send({ type: "deck:inspect", key: r.run.key, action: "diff", ...(agent?.repo ? { repo: agent.repo } : {}) })}>
          Diff
        </button>
        {canAddressPr && (
          <button className="act" title={`Address the PR for ${r.run.key} — open its workspace and work through the review feedback`}
            onClick={() => send({ type: "deck:addressPr", key: r.run.key })}>
            Address PR
          </button>
        )}
      </div>
```

Replace `canAddressPr`'s definition. The old ticket-status test goes; `lane` comes in as a new prop from `card()` (`lane={c.lane}`), typed `lane: DeckLane | null`:

```tsx
  // The lane, not the ticket status: Address PR belongs to the card that is
  // waiting on a human, which is exactly what the waiting lane means. The local
  // guard survives the change — a local card's key is inferred from its branch,
  // so its status may belong to a ticket somebody else owns.
  const canAddressPr = !local && column === "review" && lane === "waiting";
```

`prReviewStatus` and `isPrReviewStatus` now have no reader in `Card`. Leave the `prReviewStatus` state and the `deck:runs` field alone — the host still sends it and removing it is a protocol change — but drop the unused prop and the unused import so `typecheck` stays clean.

- [ ] **Step 4: Add the card's CSS**

Append to `DECK_CSS` in `src/webview/deckStyles.ts`:

```css
  /* The two-tier card. A floor with no flex column would hang dead space under
     the last row; making the card a column is what lets the footer's margin-top:
     auto seat it on the bottom edge, so a card taller than its content reads as
     deliberately that tall rather than as one that ran out of things to say.
     152px is the approved density — 132 crowds a two-line title, 176 leaves a
     hollow middle on the one-line cards that dominate a real board. */
  .card { display: flex; flex-direction: column; min-height: 152px;
    padding: 13px 14px 13px 16px; gap: 9px; cursor: pointer; }
  .col-body { gap: 14px; }
  .c-title { line-height: 1.45; }
  .card.sel { border-color: var(--vscode-focusBorder);
    background: color-mix(in srgb, var(--vscode-focusBorder) 7%, var(--vscode-editor-background)); }
  .card.sel::before { opacity: 1; width: 3px; }

  /* One line, always. The three-bit cap in cardSignal is not enough on its own —
     a long branch name still pushes the third bit onto a second row — so the line
     never wraps and the one elastic bit (the mono branch) takes the ellipsis. */
  .c-sig { display: flex; align-items: center; gap: 7px; flex-wrap: nowrap; overflow: hidden;
    font-size: 11.5px; color: var(--dim); }
  .c-sig > * { flex: none; white-space: nowrap; }
  .c-sig .m { font-family: var(--vscode-editor-font-family);
    flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .c-sig .sep { opacity: .45; }
  .c-sig .bad, .c-sig .warn { color: var(--c-attn); }
  .c-sig .ok { color: var(--c-done); }
  .dd-diff { display: inline-flex; gap: 5px; font-family: var(--vscode-editor-font-family); }

  .c-foot2 { display: flex; gap: 5px; margin-top: auto; padding-top: 2px; }
```

The existing `.card { ... }` rule earlier in the file keeps its border, background, rail and transition. This block overrides only padding and adds the column behavior; do not delete the original.

- [ ] **Step 5: Re-point the existing assertions**

Run the suite and work the failures. **The rule, from the spec:**

> A test asserting a fact that is still true must keep asserting it, re-pointed at the drawer. Only a test whose subject genuinely no longer exists may be deleted, and each such deletion is called out in the PR body.

Nothing in this design is removed, so a deletion should be very hard to justify. In practice each failure is one of:

- Asserts `.c-repos`, `.c-branch`, `.pr-block`, `.c-agents`, `.pill`, `.actions .act` labels, or the overflow menu → **select the card first**, then assert inside `.dd`. Add `fireEvent.click(document.querySelector(".card") as HTMLElement);` before the assertion and change the query root.
- Asserts `.act.primary.live` → still on the card, now inside `.c-foot2`. Re-point the selector, keep the assertion.
- Asserts Address PR from a ticket status → this rule genuinely changed. Rewrite the test around the lane, and keep a test proving the ticket-status path no longer drives it.
- `getByTitle(/more actions/i)` → the menu moved wholesale into the drawer's action list. Re-point at the drawer's `.dd-act` by name.

```bash
cd /Users/oznasi/dev/agent-flow-d2 && npm test 2>&1 | tail -40
```

- [ ] **Step 6: Confirm the whole suite is green and mutation-check the new tests**

1. Delete the `!local` guard from `canAddressPr` → "keeps Address PR off a local card" must fail.
2. Change `lane === "waiting"` to `lane !== null` → "adds Address PR on the review column's waiting lane" must still pass but the `ready` lane gains the button; add an assertion that a `ready`-lane card has no Address PR and confirm it fails under this mutation.
3. Remove `onClick={(e) => e.stopPropagation()}` from `.c-foot2` → Task 3's "does not select when a card action is clicked" must fail.

- [ ] **Step 7: Look at it**

Tests cannot see layout. Rebuild the preview and shoot the real bundle:

```bash
cd /Users/oznasi/dev/agent-flow-d2
npm run build
node preview/build-d2.js 2>/dev/null || true
node preview/shoot-any.js preview/deck-head.html preview/_d2-after-real.png
node preview/shoot-any.js preview/deck-head.html preview/_d2-after-real-light.png light
```

Open both. Confirm against `preview/_d2-h2-rest.png`: every card the same shape, the footer on the bottom edge, no signal line wrapping, and the light theme holding. If `preview/` is absent in this worktree it is gitignored and lives in the root checkout — copy the three scripts across rather than skipping this step.

- [ ] **Step 8: Full gates and commit**

```bash
cd /Users/oznasi/dev/agent-flow-d2
npm run typecheck && npm test && npm run test:cov && npm run build
git add -A
git commit -m "feat(deck): thin the card to four rows

State and key, title, one signal line, a footer of Open and Diff. Every
other block the card carried now renders in the drawer, so nothing is
lost — the existing assertions for those facts were re-pointed at .dd
rather than deleted, which is the evidence the detail moved.

Address PR moves from a ticket-status test to the review/waiting lane and
keeps its local guard: a local card's key is inferred from its branch, so
its status may belong to somebody else's ticket.

A uniform 152px floor with the footer seated on the bottom edge is the
point of the change. It does not fit more cards on screen — measured, it
fits the same number — it makes them the same shape."
```

---

## Self-Review

**Spec coverage.** Signal line → Task 1 and Task 4 Step 3/4. Footer and Address PR rule → Task 4. Floor and flex column → Task 4 Step 4. Drawer geometry, contents, mutual exclusion, board run-out → Tasks 2 and 3. Actions table → Task 2 Step 4, all eleven rows present with the same conditions. Selection semantics → Task 3. The test rule → Task 4 Step 5, quoted from the spec. Risks: Agents-lens repo handled in `cardSignal` and `DeckDetail` (`own ?? repos[0]`); no `fs`/`path` import anywhere — `Copy worktree path` uses `RepoGit.path`, which is already a string on the wire; `npm run build` is in every task's gate.

**Not covered, deliberately:** the drawer's resize grip, which the spec lists as a follow-up.

**Known rough edge for the executor:** Task 2 Step 3 exports five helpers from `DeckApp.tsx` and Task 4 removes their last in-file use. Moving them into their own module at that point is reasonable and welcome, but it is not required and must not expand Task 4's diff if the suite is already churning.
