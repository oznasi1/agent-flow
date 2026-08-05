# Deck Agent Card Place Label and Session Tooltips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Deck agent card's "first repo" fallback bug (a multi-repo workspace showed only the first repo's name) and surface the transcript-derived session slug in tooltips so hovering an agent's opaque codename explains what it's actually doing.

**Architecture:** Both changes live entirely in `src/webview/DeckApp.tsx`, a pure display projection of `RunStatus`/`CardAgent` data the extension host already posts. No new types, no host-side changes, no new files — `Run.workspaceFile` and `AgentActivity.slug` already exist and already reach the webview unused for this purpose.

**Tech Stack:** React (TSX), Vitest + @testing-library/react (jsdom environment), existing `test/webview/DeckApp.test.tsx` harness (`host()`, `mkStatus()`, `mkAgent()`, `runsMsg()`).

## Global Constraints

- No new host-side plumbing — this plan only touches `src/webview/DeckApp.tsx` and its test file.
- Single-repo runs (`run.workspaceFile` unset) must render identically to today — verify this explicitly in Task 1.
- Follow the existing tooltip convention in this file: plain HTML `title` attribute, no custom tooltip component.
- Match existing test style: `screen.getByTitle(...)` / `screen.queryByTitle(...)` with the `host()` + `mkStatus()`/`mkAgent()`/`runsMsg()` helpers already defined in `test/webview/DeckApp.test.tsx` — do not introduce new test scaffolding.
- Per `CONTRIBUTING.md`, before this is done: `npm run typecheck` (`tsc --noEmit`) must be clean, `npm test` (`vitest run`) must pass, and `npm run build` (the esbuild bundle) must succeed. These are exact `package.json` script names — run them by name, not by guessing an equivalent command.
- This is a user-facing change (a visible tooltip-text fix plus new tooltip content), so per `CONTRIBUTING.md` it needs an entry under `## [Unreleased]` in `CHANGELOG.md` — done as the last step of Final Verification, not skipped as "just a UI tweak."
- Coverage thresholds are enforced by `npm run test:cov` (`CONTRIBUTING.md`) — every new branch this plan adds (`workspaceLabel`'s two return paths, the slug-present/slug-absent branches in both tooltips) has a dedicated test in Tasks 1–3; don't remove or merge those tests for brevity.

---

### Task 1: Fix the repo/workspace fallback on the agent chip's tooltip

**Files:**
- Modify: `src/webview/DeckApp.tsx:3` (import), `src/webview/DeckApp.tsx:232` (fallback chain), plus a new `workspaceLabel` helper placed immediately above the `Card` function (currently starting at line 175)
- Test: `test/webview/DeckApp.test.tsx`

**Interfaces:**
- Produces: `function workspaceLabel(run: Run): string | undefined` — returns the run's `.code-workspace` file's basename with the `.code-workspace` extension stripped, or `undefined` when `run.workspaceFile` is unset. Used by Task 1 and available to Tasks 2 and 3 if needed (they don't need it, but it's exported at module scope, not nested, so nothing later has to redefine it).

- [ ] **Step 1: Write the failing test**

Add to `test/webview/DeckApp.test.tsx`, inside the existing `describe("DeckApp", () => { ... })` block (near the other agent-chip tests, e.g. after the "splits one run's agents across the columns" test around line 1110):

```ts
  it("falls back to the workspace name, not the first repo, when an agent's repo is unresolved", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({
      run: {
        ...mkStatus().run,
        mode: "multiroot",
        workspaceFile: "/Users/x/.agentflow/workspaces/ASM-1+2.code-workspace",
        repos: [
          { name: "svc-api", path: "/r/svc-api", isGit: true, branch: "ASM-1-x" },
          { name: "svc-web", path: "/r/svc-web", isGit: true, branch: "ASM-1-x" },
        ],
      },
      agents: [mkAgent("agent-flow-2e", "working", 100)],
    })]));
    expect(screen.getByTitle(/Claude Code session in ASM-1\+2/)).toBeInTheDocument();
    expect(screen.queryByTitle(/Claude Code session in svc-api/)).not.toBeInTheDocument();
  });

  it("still falls back to the first repo when the run has no workspace file", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({
      agents: [mkAgent("agent-flow-2e", "working", 100)],
    })]));
    expect(screen.getByTitle(/Claude Code session in svc/)).toBeInTheDocument();
  });
```

`mkAgent` (test/webview/DeckApp.test.tsx:41) builds a `CardAgent` with no `repo` field set, so `agent.repo` is `undefined` in both cases — exactly the "unresolved" scenario this task fixes. `mkStatus`'s default run (test/webview/DeckApp.test.tsx:20-35) has `mode: "per-window"` and no `workspaceFile`, which is what the second test relies on for the unchanged-behavior case.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/webview/DeckApp.test.tsx -t "falls back to the workspace name"`
Expected: FAIL — the first new test fails because the current code renders `title="Claude Code session in svc-api"` (the first repo), not `ASM-1+2`. The second new test passes already (it's the pre-existing behavior); that's fine, it's there to pin the no-regression case for Task 1's change.

- [ ] **Step 3: Write minimal implementation**

In `src/webview/DeckApp.tsx:3`, add `Run` to the type import:

```ts
import { AgentActivity, CardAgent, DeckColumn, OutboundMessage, PrEntryMap, PrFacts, RepoGit, ReviewDetail, ReviewRequest, ReviewSort, Run, RunStatus, isTicketRun, runKind, ticketKeyFor } from "../types";
```

Immediately above the `Card` function (currently `src/webview/DeckApp.tsx:175`), add:

```ts
/** The run's `.code-workspace` file's name, extension stripped — e.g.
 * "ASM-1+2.code-workspace" → "ASM-1+2". `undefined` for a single-repo
 * (per-window) run, which has no workspace file at all. */
function workspaceLabel(run: Run): string | undefined {
  return run.workspaceFile?.split("/").pop()?.replace(/\.code-workspace$/, "");
}
```

In the `Card` function, change line 232 from:

```tsx
          <span className="c-agent" title={`Claude Code session in ${agent.repo ?? r.run.repos[0]?.name ?? "this run"}`}>
```

to:

```tsx
          <span className="c-agent" title={`Claude Code session in ${agent.repo ?? workspaceLabel(r.run) ?? r.run.repos[0]?.name ?? "this run"}`}>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/webview/DeckApp.test.tsx`
Expected: PASS — every test in the file, including both new ones and the full existing suite (this is a fallback-chain change on a line other tests already exercise; run the whole file, not just the new tests, to catch any regression).

- [ ] **Step 5: Commit**

```bash
git add src/webview/DeckApp.tsx test/webview/DeckApp.test.tsx
git commit -m "fix(deck): show workspace name, not first repo, on agent chip tooltip"
```

---

### Task 2: Lead the agent chip tooltip with the session's slug

**Files:**
- Modify: `src/webview/DeckApp.tsx:232` (tooltip text)
- Test: `test/webview/DeckApp.test.tsx`

**Interfaces:**
- Consumes: `workspaceLabel(run: Run): string | undefined` from Task 1 (unchanged, already in scope for `Card`).
- Consumes: `CardAgent.activity.slug: string | null` (`src/types.ts:146`, already present on every `CardAgent` the host posts).

- [ ] **Step 1: Write the failing test**

Add to `test/webview/DeckApp.test.tsx`, next to the Task 1 tests:

```ts
  it("leads the agent chip tooltip with the session slug when one is known", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({
      agents: [{ ...mkAgent("agent-flow-2e", "working", 100), activity: { state: "working", lastActivityMs: 100, slug: "export-streaming-fix" } }],
    })]));
    expect(screen.getByTitle(/^export-streaming-fix — Claude Code session in svc$/)).toBeInTheDocument();
  });

  it("keeps the repo-only tooltip when no slug is known yet", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({
      agents: [mkAgent("agent-flow-2e", "working", 100)],
    })]));
    expect(screen.getByTitle(/^Claude Code session in svc$/)).toBeInTheDocument();
  });
```

`mkAgent` sets `activity.slug: null` (test/webview/DeckApp.test.tsx:41-44), so the second test exercises the "no slug yet" path without any overrides.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/webview/DeckApp.test.tsx -t "leads the agent chip tooltip with the session slug"`
Expected: FAIL — current tooltip text is only `"Claude Code session in svc"`, with no slug prefix.

- [ ] **Step 3: Write minimal implementation**

In `src/webview/DeckApp.tsx`, change the `.c-agent` span (from Task 1's version) from:

```tsx
          <span className="c-agent" title={`Claude Code session in ${agent.repo ?? workspaceLabel(r.run) ?? r.run.repos[0]?.name ?? "this run"}`}>
```

to:

```tsx
          <span className="c-agent" title={`${agent.activity.slug ? `${agent.activity.slug} — ` : ""}Claude Code session in ${agent.repo ?? workspaceLabel(r.run) ?? r.run.repos[0]?.name ?? "this run"}`}>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/webview/DeckApp.test.tsx`
Expected: PASS — all tests, including Task 1's.

- [ ] **Step 5: Commit**

```bash
git add src/webview/DeckApp.tsx test/webview/DeckApp.test.tsx
git commit -m "feat(deck): lead agent chip tooltip with the session's transcript slug"
```

---

### Task 3: Add the slug tooltip to the expanded agent-list row

**Files:**
- Modify: `src/webview/DeckApp.tsx:161` (`.ag-name` span, inside `AgentsRow`)
- Test: `test/webview/DeckApp.test.tsx`

**Interfaces:**
- Consumes: `CardAgent.activity.slug: string | null` (same field Task 2 uses, on the same `CardAgent` type — `AgentsRow`'s `agents: CardAgent[]` prop already carries it).

- [ ] **Step 1: Write the failing test**

Add to `test/webview/DeckApp.test.tsx`. `AgentsRow` renders on a *run* card, i.e. `agent === null` (the "Workspaces" grouping, or any parked run card) — use `grouping: "workspaces"` as the existing test at line 1089-1096 does, and expand the row by clicking the toggle button (`.ag-toggle`, `title="Claude Code sessions open in this directory"`) since the per-agent rows only render when `open` is true (`src/webview/DeckApp.tsx:156`):

```ts
  it("shows the session slug as a tooltip on an expanded agent row", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({
      agents: [{ ...mkAgent("agent-flow-2e", "working", 100), activity: { state: "working", lastActivityMs: 100, slug: "export-streaming-fix" } }],
    })], "PR initiated", "workspaces"));
    fireEvent.click(screen.getByTitle(/sessions open in this directory/i));
    expect(screen.getByTitle("export-streaming-fix")).toBeInTheDocument();
  });

  it("has no title on an expanded agent row when no slug is known yet", () => {
    const { container } = render(<DeckApp />);
    host(runsMsg([mkStatus({
      agents: [mkAgent("agent-flow-2e", "working", 100)],
    })], "PR initiated", "workspaces"));
    fireEvent.click(screen.getByTitle(/sessions open in this directory/i));
    expect(container.querySelector(".ag-name")).not.toHaveAttribute("title");
  });
```

`fireEvent` is already imported at the top of the test file (test/webview/DeckApp.test.tsx:4). The second test queries `.ag-name` directly by class rather than by text: with exactly one agent, the collapsed toggle's own label (`.ag-label`, line 154) renders the same session name and stays mounted once expanded, so `getByText("agent-flow-2e")` would ambiguously match both spans.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/webview/DeckApp.test.tsx -t "shows the session slug as a tooltip on an expanded agent row"`
Expected: FAIL — `.ag-name` has no `title` attribute today, so `screen.getByTitle("export-streaming-fix")` finds nothing.

- [ ] **Step 3: Write minimal implementation**

In `src/webview/DeckApp.tsx:161`, change:

```tsx
            <span className="ag-name">{a.session.name ?? a.session.sessionId.slice(0, 8)}</span>
```

to:

```tsx
            <span className="ag-name" title={a.activity.slug ?? undefined}>{a.session.name ?? a.session.sessionId.slice(0, 8)}</span>
```

React omits the `title` attribute entirely when its value is `undefined`, so the "no slug yet" case renders with no `title` at all — matching the second test's assertion.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/webview/DeckApp.test.tsx`
Expected: PASS — all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add src/webview/DeckApp.tsx test/webview/DeckApp.test.tsx
git commit -m "feat(deck): show session slug as a tooltip on expanded agent rows"
```

---

## Final Verification

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS — no regressions outside `DeckApp.test.tsx` either (nothing else imports the new `workspaceLabel` helper or touches these two spans, but this confirms it).

- [ ] **Step 2: Type-check**

Run: `npm run typecheck`
Expected: no errors — confirms the `Run` import added in Task 1 and the new helper's signature are consistent with the rest of the codebase's types.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: the esbuild bundle succeeds — confirms nothing in the webview bundle broke (this is a required pre-PR gate per `CONTRIBUTING.md`, separate from and not covered by typecheck or tests).

- [ ] **Step 4: Add the CHANGELOG entry**

This is a user-facing change, so per `CONTRIBUTING.md` it needs an entry. Edit `CHANGELOG.md`, adding under the existing empty `## [Unreleased]` heading (line 8):

```markdown
## [Unreleased]

### Fixed

- **Deck: agent chip shows the workspace name, not the first repo.** A multi-repo
  run whose session couldn't be matched to one specific repo used to fall back to
  `repos[0]`'s name on hover, no matter how many repos the run actually had. It now
  shows the run's `.code-workspace` file name instead (`src/webview/DeckApp.tsx`).

### Added

- **Deck: agent tooltips show what a session is doing.** Hovering an agent's
  codename (top-right of its card, and each row of an expanded agent list) now
  leads with Claude Code's own transcript-derived session title when one is known,
  instead of just naming the repo (`src/webview/DeckApp.tsx`).
```

- [ ] **Step 5: Commit the CHANGELOG entry**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog entry for agent card place label and session tooltips"
```
