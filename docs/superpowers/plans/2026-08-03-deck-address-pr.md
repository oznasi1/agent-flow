# Address PR on the Deck card — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put an **Address PR** button on a Deck card whose Jira status matches `agentFlow.prReviewStatus` (default `"PR initiated"`), which re-seeds the run's existing workspace with the PR-review prompt in one click.

**Architecture:** A Deck card acts on a *run*, not a ticket. The run record already holds `repos` (worktree paths), `workspaceFile`, and `briefPaths`, so the click asks nothing — no Jira read, no destination QuickPick, no repo QuickPick, no new worktree. It also does **not** go through `openWorkspace`, which rewrites the runs-store record with a fresh `createdAt` and would reset the card's "launched 4h ago". Instead it calls the two primitives underneath: `writePlanFile` + `openInEditor`. `watchPlansAndSeed` makes an already-open window seed itself, and `openInEditor` shells to `open -a`, which focuses an existing window rather than opening a second one.

**Tech Stack:** TypeScript, React (classic JSX runtime, `import * as React`), VS Code extension host + webview, Vitest (jsdom for `test/webview/**`), esbuild.

Spec: [docs/superpowers/specs/2026-08-03-deck-address-pr-design.md](../specs/2026-08-03-deck-address-pr-design.md)

## Global Constraints

Every task's requirements implicitly include this section.

- **Gates, all four must pass before any commit:** `npm run typecheck`, `npm test`, `npm run test:cov`, `npm run build`. Do not report a task complete on `npm test` alone.
- **Coverage thresholds are enforced** by `npm run test:cov` (vitest.config.ts): statements 90, branches 85, functions 85, lines 90. Every new branch needs a test.
- **`vscode` is not a real module.** It is aliased to `test/_mocks/vscode.ts` in vitest.config.ts. Never import the real thing in a test.
- **Webview tests need `// @vitest-environment jsdom`** as the first line. Host-side tests run in node.
- **No new dependencies.** Do not run `npm install`. This repo is public OSS and the machine's global `~/.npmrc` points at a private CodeArtifact registry that re-pollutes `package-lock.json` and breaks CI with E401.
- **Comment style:** this codebase writes comments that explain *why*, often several lines, on non-obvious decisions. Match the density of the surrounding file. Do not add comments that restate the code.
- **`src/types.ts` is excluded from coverage** — type-only changes there need no test of their own.
- Do not bump the version or build a `.vsix`. Releases happen on merge to main, handled elsewhere.

## File Structure

| File | Change | Responsibility |
|------|--------|----------------|
| `src/engine/prompt.ts` | modify | Gains `PR_REVIEW_AUTOFIX_CLAUSE` + `prReviewTemplate` — prompt fragments and their assembly, beside the identical `SLACK_DM_SENTENCE` / `injectSlackDm` pair. |
| `src/config.ts` | modify | Loses `PR_REVIEW_AUTOFIX_CLAUSE` (not a setting default). Keeps `DEFAULT_PR_REVIEW_PROMPT`, which is one. |
| `src/tasksView.ts` | modify | Drops its private `prReviewTemplate`; calls the shared one. |
| `src/types.ts` | modify | `deck:addressPr` inbound; `prReviewStatus` on `deck:runs`. |
| `src/deckView.ts` | modify | Host handler: re-seed an existing run. Posts `prReviewStatus`. |
| `src/webview/DeckApp.tsx` | modify | Renders the button, gated on status + not-local. |
| `test/unit/engine/prompt.test.ts` | modify | Covers `prReviewTemplate`. |
| `test/unit/tasksView.test.ts` | modify | Import moves; existing behavior assertions unchanged. |
| `test/unit/deckView.test.ts` | modify | Covers the handler. |
| `test/webview/DeckApp.test.tsx` | modify | Covers the button. |

**Why `engine/prompt.ts` and not `config.ts` for the shared function:** no file under `src/engine/` imports `config.ts` — the engine takes config as plain values (`launchReview` takes `template`, `workspaceDir`, `seedAgent` as separate fields, never a config object). A `prReviewTemplate` in `engine/prompt.ts` that reached back into `config.ts` for the clause would be the first edge to break that, so the clause moves with it.

---

### Task 1: Move the auto-fix clause and `prReviewTemplate` into `engine/prompt.ts`

Pure refactor. No behavior changes anywhere.

**Files:**
- Modify: `src/engine/prompt.ts` (append after `injectSlackDm`, line 37)
- Modify: `src/config.ts:152-155` (delete)
- Modify: `src/tasksView.ts:4`, `src/tasksView.ts:20`, `src/tasksView.ts:1455-1469`
- Test: `test/unit/engine/prompt.test.ts` (append a new `describe`)
- Test: `test/unit/tasksView.test.ts:79`, `test/unit/tasksView.test.ts:89` (imports only)

**Interfaces:**
- Produces: `PR_REVIEW_AUTOFIX_CLAUSE: string` and `prReviewTemplate(prompt: string, autoFix: boolean): string`, both exported from `src/engine/prompt.ts`. Task 2 consumes `prReviewTemplate`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/engine/prompt.test.ts`:

```ts
describe("prReviewTemplate", () => {
  it("inserts the auto-fix clause just before {files} when autoFix is on", () => {
    const t = prReviewTemplate("Assess the PR for {key}.{files}", true);
    expect(t).toContain(PR_REVIEW_AUTOFIX_CLAUSE);
    expect(t.indexOf(PR_REVIEW_AUTOFIX_CLAUSE)).toBeLessThan(t.indexOf("{files}"));
  });

  it("appends the clause at the end when the prompt has no {files}", () => {
    expect(prReviewTemplate("Assess the PR for {key}.", true)).toBe(
      `Assess the PR for {key}. ${PR_REVIEW_AUTOFIX_CLAUSE}`,
    );
  });

  it("returns the prompt untouched when autoFix is off", () => {
    expect(prReviewTemplate("Assess the PR for {key}.{files}", false)).toBe(
      "Assess the PR for {key}.{files}",
    );
  });
});
```

Extend the import on line 2 of that file to:

```ts
import { renderPrompt, injectSlackDm, insertBeforeFiles, SLACK_DM_SENTENCE, applyExploreVars, prReviewTemplate, PR_REVIEW_AUTOFIX_CLAUSE, type PromptVars } from "../../../src/engine/prompt";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/prompt.test.ts`
Expected: FAIL — `prReviewTemplate is not a function` (the import resolves to `undefined`).

- [ ] **Step 3: Add the clause and the function to `engine/prompt.ts`**

Append after `injectSlackDm` (currently ends line 37), before `applyExploreVars`:

```ts
/** Appended to the PR-review prompt (just before {files}) when prReviewAutoFix is on. */
export const PR_REVIEW_AUTOFIX_CLAUSE =
  "If it's ready, go ahead and implement the requested changes on this branch so it's ready for me to review — " +
  "do not push or merge without me.";

/** Assemble the Address PR prompt: the configured base, with the auto-fix clause
 * inserted just before the trailing {files} block when prReviewAutoFix is on. Lives
 * here rather than in a view because two callers now need it — the sidebar's ticket
 * kick-off and the Deck's re-seed of an already-launched run — and because the clause
 * is the same kind of thing as SLACK_DM_SENTENCE above: a fragment the code appends,
 * not a setting default. */
export function prReviewTemplate(prompt: string, autoFix: boolean): string {
  return autoFix ? insertBeforeFiles(prompt, " " + PR_REVIEW_AUTOFIX_CLAUSE) : prompt;
}
```

The clause text must be **byte-identical** to the one currently in `src/config.ts:153-155` — `test/unit/tasksView.test.ts` asserts on it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/prompt.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Delete the clause from `config.ts`**

Delete these four lines (`src/config.ts:152-155`):

```ts
/** Appended to the PR-review prompt (just before {files}) when prReviewAutoFix is on. */
export const PR_REVIEW_AUTOFIX_CLAUSE =
  "If it's ready, go ahead and implement the requested changes on this branch so it's ready for me to review — " +
  "do not push or merge without me.";
```

Leave `DEFAULT_PR_REVIEW_PROMPT` (immediately above) alone.

- [ ] **Step 6: Point `tasksView.ts` at the shared function**

Line 4 — drop `PR_REVIEW_AUTOFIX_CLAUSE`:

```ts
import { getConfig, AgentFlowConfig, ExploreAction } from "./config";
```

Line 20 — drop `insertBeforeFiles` (line 1467 was its only use in this file) and add `prReviewTemplate`:

```ts
import { applyExploreVars, injectSlackDm, prReviewTemplate } from "./engine/prompt";
```

Replace `addressPr` and delete the private method that follows it (`src/tasksView.ts:1451-1469`) with:

```ts
  /** PR-review kick-off: the same open+seed flow as Take, but always in a worktree and
   * seeding the PR-review prompt — the agent finds the task's GitHub PR by its Jira key,
   * checks out its branch, assesses readiness, and (when prReviewAutoFix) implements the
   * requested changes. Surfaced on a card whose status matches cfg.prReviewStatus. */
  public async addressPr(key: string, preselected?: string[]): Promise<void> {
    const resolved = await this.resolveKickoff(key, preselected);
    if (!resolved) return;
    const { detail, services, target } = resolved;
    const cfg = getConfig();
    await this.launch(detail, services, prReviewTemplate(cfg.prReviewPrompt, cfg.prReviewAutoFix), true, target);
  }
```

- [ ] **Step 7: Fix the two test imports**

`test/unit/tasksView.test.ts:79` — drop the clause:

```ts
import { getConfig } from "../../src/config";
```

`test/unit/tasksView.test.ts:89` — add it to the existing `engine/prompt` import:

```ts
import { SLACK_DM_SENTENCE, PR_REVIEW_AUTOFIX_CLAUSE } from "../../src/engine/prompt";
```

Also update the stale comment at `test/unit/tasksView.test.ts:5-6`, which names the clause as a config constant:

```ts
// Keep the real config constants (DEFAULT_PR_REVIEW_PROMPT, …) faithful — only
// getConfig is stubbed so tests control the resolved settings.
```

Change nothing else in that file. The four existing auto-fix assertions (around lines 2930-2952) must pass untouched — that is what proves this refactor is behavior-preserving.

- [ ] **Step 8: Run the full gates**

Run: `npm run typecheck && npm test && npm run test:cov && npm run build`
Expected: all pass. In particular `test/unit/tasksView.test.ts` "appends the auto-fix clause before {files} when prReviewAutoFix is on", "omits the auto-fix clause when prReviewAutoFix is off", and "appends the auto-fix clause at the end when the prompt has no {files}" pass with no edits to their bodies.

- [ ] **Step 9: Commit**

```bash
git add src/engine/prompt.ts src/config.ts src/tasksView.ts test/unit/engine/prompt.test.ts test/unit/tasksView.test.ts
git commit -m "refactor: move the PR-review auto-fix clause into engine/prompt

prReviewTemplate was a private method on TasksViewProvider and now has a
second caller coming on the Deck. It moves to engine/prompt.ts beside
insertBeforeFiles, which it already used, and PR_REVIEW_AUTOFIX_CLAUSE
moves with it: nothing under src/engine imports config.ts, and reaching
back for the clause would have been the first edge to break that.

The clause also just belongs there. SLACK_DM_SENTENCE is the same kind of
thing — a fragment inserted before {files}, paired with its own helper —
and it already lives in prompt.ts. DEFAULT_PR_REVIEW_PROMPT stays in
config.ts, because that one really is a setting default.

Behavior-preserving; the existing auto-fix assertions pass untouched."
```

---

### Task 2: `deck:addressPr` host handler

**Files:**
- Modify: `src/types.ts:322` (add to the Deck block of `InboundMessage`)
- Modify: `src/deckView.ts` — imports (lines 11, and a new one for `engine/prompt`), the message switch (after the `deck:track` case, line 741-743), and a new private method next to `inspect`
- Test: `test/unit/deckView.test.ts` — hoisted block, the `engine/workspace` mock, the `config` mock, and a new `describe`

**Interfaces:**
- Consumes: `prReviewTemplate(prompt: string, autoFix: boolean): string` from Task 1.
- Consumes (existing, already exported): `writePlanFile(plan: PlanFile): void` and `agentPrompt(t: TicketRef, mentions: string[], template: string, briefPath?: string): string` from `src/engine/workspace.ts`; `this.run(key): Run | undefined` and `this.toast(level, message)` from `src/deckView.ts`.
- Produces: inbound message `{ type: "deck:addressPr"; key: string }`, which Task 3's button sends.

- [ ] **Step 1: Add the message type**

In `src/types.ts`, in the Deck section of `InboundMessage`, after the `deck:track` line (line 322):

```ts
  | { type: "deck:addressPr"; key: string }
```

- [ ] **Step 2: Write the failing tests**

In `test/unit/deckView.test.ts`, add to the `vi.hoisted` block (alongside `openInEditor`, around line 11):

```ts
  writePlanFile: vi.fn(),
  prReviewPrompt: "Assess the PR for {key}.{files}" as string,
  prReviewAutoFix: false as boolean,
```

Extend the `engine/workspace` mock (currently lines 83-90) to:

```ts
vi.mock("../../src/engine/workspace", () => ({
  openInEditor: h.openInEditor,
  // Never actually invoked in this suite — launchReview itself is mocked below,
  // so it never calls through to its own deps. Present only so deckView's
  // import of BRIEF_DIR and openWorkspace resolves to something.
  openWorkspace: vi.fn(),
  BRIEF_DIR: ".pick-task",
  writePlanFile: h.writePlanFile,
  // A stub that encodes its brief argument in the output, so a test can assert
  // which brief a match was rendered against without re-testing renderPrompt —
  // engine/prompt.test.ts already owns that.
  agentPrompt: (t: { key: string }, _mentions: string[], template: string, briefPath?: string) =>
    `${template} [key=${t.key} brief=${briefPath ?? "(relative)"}]`,
}));
```

Add both PR-review settings to the `config` mock's `getConfig` return (around line 169), so the handler reads real values:

```ts
      prReviewPrompt: h.prReviewPrompt, prReviewAutoFix: h.prReviewAutoFix, seedAgent: h.seedAgent,
```

and to the `vi.hoisted` block:

```ts
  seedAgent: true as boolean,
```

Add the resets to `beforeEach` (alongside `h.openInEditor.mockClear()`, around line 256):

```ts
  h.writePlanFile.mockClear();
  h.prReviewPrompt = "Assess the PR for {key}.{files}";
  h.prReviewAutoFix = false;
  h.seedAgent = true;
```

Then add a new `describe` at the end of the file:

```ts
describe("DeckPanel — Address PR", () => {
  it("writes one plan matching the repo window for a per-window run", async () => {
    h.runs = [mkRun()];
    show();
    await lastPanel()._fire({ type: "deck:addressPr", key: "ASM-1" });
    expect(h.writePlanFile).toHaveBeenCalledWith({
      key: "ASM-1",
      createdAt: expect.any(Number),
      seedAgent: true,
      matches: [{
        matchPath: "/r/svc",
        prompt: "Assess the PR for {key}.{files} [key=ASM-1 brief=(relative)]",
      }],
    });
    expect(h.openInEditor).toHaveBeenCalledWith("/r/svc");
  });

  it("matches the workspace file and the launch's own brief for a multiroot run", async () => {
    h.runs = [mkRun({
      mode: "multiroot",
      workspaceFile: "/ws/ASM-1.code-workspace",
      briefPaths: ["/r/svc/.pick-task/TASK.md"],
    })];
    show();
    await lastPanel()._fire({ type: "deck:addressPr", key: "ASM-1" });
    expect(h.writePlanFile).toHaveBeenCalledWith(expect.objectContaining({
      matches: [{
        matchPath: "/ws/ASM-1.code-workspace",
        prompt: "Assess the PR for {key}.{files} [key=ASM-1 brief=/r/svc/.pick-task/TASK.md]",
      }],
    }));
    expect(h.openInEditor).toHaveBeenCalledWith("/ws/ASM-1.code-workspace");
  });

  it("seeds every window of a multi-repo per-window run", async () => {
    h.runs = [mkRun({
      repos: [
        { name: "svc", path: "/r/svc", isGit: true, branch: "b" },
        { name: "ui", path: "/r/ui", isGit: true, branch: "b" },
      ],
    })];
    show();
    await lastPanel()._fire({ type: "deck:addressPr", key: "ASM-1" });
    const plan = h.writePlanFile.mock.calls.at(-1)![0] as { matches: { matchPath: string }[] };
    expect(plan.matches.map((m) => m.matchPath)).toEqual(["/r/svc", "/r/ui"]);
    expect(h.openInEditor).toHaveBeenCalledWith("/r/svc");
    expect(h.openInEditor).toHaveBeenCalledWith("/r/ui");
  });

  it("applies the auto-fix clause when prReviewAutoFix is on", async () => {
    h.prReviewAutoFix = true;
    h.runs = [mkRun()];
    show();
    await lastPanel()._fire({ type: "deck:addressPr", key: "ASM-1" });
    const plan = h.writePlanFile.mock.calls.at(-1)![0] as { matches: { prompt: string }[] };
    expect(plan.matches[0].prompt).toContain(PR_REVIEW_AUTOFIX_CLAUSE);
  });

  it("leaves the run record untouched — the card keeps its launched-at", async () => {
    h.runs = [mkRun({ createdAt: 1_700_000_000_000 })];
    show();
    await lastPanel()._fire({ type: "deck:addressPr", key: "ASM-1" });
    expect(h.writeRun).not.toHaveBeenCalled();
  });

  it("opens the window but writes no plan when seedAgent is off", async () => {
    h.seedAgent = false;
    h.runs = [mkRun()];
    show();
    await lastPanel()._fire({ type: "deck:addressPr", key: "ASM-1" });
    expect(h.writePlanFile).not.toHaveBeenCalled();
    expect(h.openInEditor).toHaveBeenCalledWith("/r/svc");
  });

  it("toasts an error when there is no run record for the key", async () => {
    h.runs = [];
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:addressPr", key: "ASM-9" });
    expect(h.writePlanFile).not.toHaveBeenCalled();
    expect(posts(p)).toContainEqual(
      expect.objectContaining({ type: "toast", level: "error", message: "No run record for ASM-9." }),
    );
  });

  it("toasts an error when the run has nothing to open", async () => {
    h.runs = [mkRun({ repos: [] })];
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:addressPr", key: "ASM-1" });
    expect(h.writePlanFile).not.toHaveBeenCalled();
    expect(posts(p)).toContainEqual(
      expect.objectContaining({ type: "toast", level: "error", message: "Nothing to open for ASM-1." }),
    );
  });

  it("toasts an error when the editor refuses to open", async () => {
    h.runs = [mkRun()];
    h.openInEditor.mockResolvedValueOnce(false);
    show();
    const p = lastPanel();
    await p._fire({ type: "deck:addressPr", key: "ASM-1" });
    expect(posts(p)).toContainEqual(
      expect.objectContaining({ type: "toast", level: "error", message: "Couldn't open ASM-1." }),
    );
  });
});
```

Add the clause import near the top of the file, after the `DeckPanel` import (line 197):

```ts
import { PR_REVIEW_AUTOFIX_CLAUSE } from "../../src/engine/prompt";
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/unit/deckView.test.ts -t "Address PR"`
Expected: FAIL — `writePlanFile` never called; the `deck:addressPr` message falls through the switch with no case.

- [ ] **Step 4: Implement the handler**

In `src/deckView.ts`, extend the workspace import (line 11):

```ts
import { agentPrompt, openInEditor, openWorkspace, writePlanFile, BRIEF_DIR } from "./engine/workspace";
```

and add, next to the other engine imports:

```ts
import { prReviewTemplate } from "./engine/prompt";
```

Add a case to the message switch, after `case "deck:track":` (lines 741-743):

```ts
      case "deck:addressPr":
        await this.addressPr(m.key);
        break;
```

Add the method directly after `inspect` (which ends at line 824):

```ts
  /**
   * Re-seed an in-flight run with the Address PR prompt.
   *
   * The sidebar's kick-off acts on a *ticket*: nothing is on disk yet, so it reads
   * Jira, asks where to open, asks which repos, and makes a worktree. A Deck card acts
   * on a *run* that already has all three, so this asks nothing.
   *
   * Deliberately not openWorkspace, even though that is the function this mirrors:
   * openWorkspace rewrites the runs-store record with a fresh createdAt and re-derives
   * kind, which would reset "launched 4h ago" to "launched 0s ago" on a run taken
   * yesterday. It would rewrite every brief too, which needs a Jira fetch to do
   * faithfully. Re-seeding is the smaller operation, so it uses the smaller primitives
   * openWorkspace is itself built from, and the only thing that hits disk is the
   * transient plan file.
   *
   * Seeding reaches the window whether or not it is already open: watchPlansAndSeed
   * makes a live window seed itself when the plan lands, and openInEditor shells to
   * `open -a`, which focuses an existing window rather than opening a second one.
   */
  private async addressPr(key: string): Promise<void> {
    const run = this.run(key);
    if (!run) {
      this.toast("error", `No run record for ${key}.`);
      return;
    }
    const cfg = getConfig();
    const template = prReviewTemplate(cfg.prReviewPrompt, cfg.prReviewAutoFix);
    const ticket = { key: run.key, summary: run.summary, url: run.url };
    // Mirror the shape this run was launched in — that is what its windows are. A
    // multiroot run is one window on the workspace file, rendered against the absolute
    // brief the launch wrote; a per-window run is one window per repo, where the
    // relative .pick-task/TASK.md resolves inside each. Same split openWorkspace makes,
    // and it keeps every window of a multi-repo run seeded rather than just the first.
    // Keyed on workspaceFile's presence, not mode, the way inspect() already does it.
    // mentions is empty: file hints come from the ticket description, and re-fetching
    // Jira is exactly what this path exists to avoid.
    const matches = run.workspaceFile
      ? [{ matchPath: run.workspaceFile, prompt: agentPrompt(ticket, [], template, run.briefPaths[0]) }]
      : run.repos.map((r) => ({ matchPath: r.path, prompt: agentPrompt(ticket, [], template) }));
    if (matches.length === 0) {
      this.toast("error", `Nothing to open for ${key}.`);
      return;
    }
    // Honor seedAgent the way every other launch does: with it off, nothing seeds
    // anywhere, and writing a plan file no window will act on would just litter.
    if (cfg.seedAgent) {
      writePlanFile({ key: run.key, createdAt: Date.now(), seedAgent: true, matches });
    }
    for (const m of matches) {
      if (!(await openInEditor(m.matchPath))) this.toast("error", `Couldn't open ${key}.`);
    }
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: PASS — the nine new cases plus every pre-existing case in the file.

- [ ] **Step 6: Run the full gates**

Run: `npm run typecheck && npm test && npm run test:cov && npm run build`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/deckView.ts test/unit/deckView.test.ts
git commit -m "feat(deck): re-seed an in-flight run with the Address PR prompt

Handles deck:addressPr by writing a plan file against the run's existing
windows and opening them. No Jira read, no destination pick, no repo pick,
no new worktree — a Deck card acts on a run, and the run record already
answers all three.

Not via openWorkspace: that rewrites the runs-store record with a fresh
createdAt, which would reset a card's \"launched 4h ago\" to zero. This uses
the primitives underneath it, so nothing but the transient plan file is
written. watchPlansAndSeed covers the already-open-window case.

No button sends this yet."
```

---

### Task 3: The button on the card

**Files:**
- Modify: `src/types.ts:365` (`deck:runs` gains `prReviewStatus`)
- Modify: `src/deckView.ts:656-663` (post the field)
- Modify: `src/webview/DeckApp.tsx` — import (line 4), `Card` props and gate (lines 166-199), the actions row (line 258-270), `DeckApp` state + the `deck:runs` branch + the `<Card>` call site (lines 292-506)
- Test: `test/webview/DeckApp.test.tsx` — the `runsMsg` helper plus a new `describe`
- Test: `test/unit/deckView.test.ts` — one assertion that the post carries the setting

**Interfaces:**
- Consumes: `{ type: "deck:addressPr"; key: string }` from Task 2.
- Consumes (existing): `isPrReviewStatus(status: string, configured: string): boolean` from `src/webview/helpers.ts:45` — case-insensitive, whitespace-trimmed, false when either side is empty. `runKind(run: Run): "task" | "explore" | "review" | "local"` from `src/types.ts:83`.

- [ ] **Step 1: Write the failing webview tests**

In `test/webview/DeckApp.test.tsx`, extend the `runsMsg` helper (line 37) so every existing call site gets the new field. `"PR initiated"` here matches no existing fixture — `mkStatus` defaults `jiraStatus` to `"In Progress"` — so no current test changes behavior:

```tsx
const runsMsg = (runs: RunStatus[], prReviewStatus = "PR initiated"): OutboundMessage =>
  ({ type: "deck:runs", runs, liveSignal: true, prFacts: true, openAgents: true, ghNote: null, prReviewStatus });
```

Then add a new `describe` at the end of the file:

```tsx
describe("DeckApp — Address PR", () => {
  const prCard = (over: Partial<RunStatus> = {}) => mkStatus({ jiraStatus: "PR initiated", ...over });

  it("shows the button when the Jira status matches the configured one", () => {
    render(<DeckApp />);
    host(runsMsg([prCard()]));
    expect(screen.getByRole("button", { name: "Address PR" })).toBeInTheDocument();
  });

  it("matches the status case-insensitively and ignores surrounding space", () => {
    render(<DeckApp />);
    host(runsMsg([prCard({ jiraStatus: "  pr initiated  " })]));
    expect(screen.getByRole("button", { name: "Address PR" })).toBeInTheDocument();
  });

  it("hides the button on a card in any other status", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ jiraStatus: "In Progress" })]));
    expect(screen.queryByRole("button", { name: "Address PR" })).not.toBeInTheDocument();
  });

  it("hides the button when the run has no Jira status at all", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus({ jiraStatus: null })]));
    expect(screen.queryByRole("button", { name: "Address PR" })).not.toBeInTheDocument();
  });

  it("hides the button when the setting is empty", () => {
    render(<DeckApp />);
    host(runsMsg([prCard()], ""));
    expect(screen.queryByRole("button", { name: "Address PR" })).not.toBeInTheDocument();
  });

  it("hides the button on a local card, whose ticket key is only inferred", () => {
    render(<DeckApp />);
    host(runsMsg([prCard({ run: { ...mkStatus().run, kind: "local" } })]));
    expect(screen.queryByRole("button", { name: "Address PR" })).not.toBeInTheDocument();
  });

  it("posts deck:addressPr with the run key on click", () => {
    render(<DeckApp />);
    host(runsMsg([prCard()]));
    fireEvent.click(screen.getByRole("button", { name: "Address PR" }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:addressPr", key: "ASM-1" });
  });

  it("leads the action row, before Open", () => {
    render(<DeckApp />);
    host(runsMsg([prCard()]));
    const labels = Array.from(document.querySelectorAll(".actions .act")).map((b) => b.textContent);
    expect(labels).toEqual(["Address PR", "Open", "Diff"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/webview/DeckApp.test.tsx -t "Address PR"`
Expected: FAIL — `Unable to find an accessible element with the role "button" and name "Address PR"`.

- [ ] **Step 3: Add the field to the wire type and the post**

`src/types.ts:365`:

```ts
  | { type: "deck:runs"; runs: RunStatus[]; liveSignal: boolean; prFacts: boolean; openAgents: boolean; ghNote: string | null; prReviewStatus: string }
```

`src/deckView.ts`, in `refresh` (lines 656-663):

```ts
      this.post({
        type: "deck:runs",
        runs,
        liveSignal: this.liveSignal,
        prFacts: this.prFacts,
        openAgents: this.openAgents,
        ghNote: this.prFacts && this.ghGap ? GH_NOTES[this.ghGap.kind] : null,
        // Read fresh on every post rather than cached in a field: it is a plain
        // string setting a user can edit mid-session, and the board re-posts often
        // enough that this is the whole of "keep it live".
        prReviewStatus: getConfig().prReviewStatus,
      });
```

- [ ] **Step 4: Render the button**

`src/webview/DeckApp.tsx` — extend the helpers import (line 4 area; the file currently imports only from `./vscodeApi`, `../types` and `./ReviewStrip`, so this is a new line after the `ReviewStrip` import):

```tsx
import { isPrReviewStatus } from "./helpers";
```

Change the `Card` signature (line 166):

```tsx
function Card({ r, live, prReviewStatus, onForget }: { r: RunStatus; live: boolean; prReviewStatus: string; onForget: (key: string) => void }): JSX.Element {
```

Add the gate immediately after `const local = runKind(r.run) === "local";` (line 183):

```tsx
  // Offer Address PR once the ticket reaches the configured PR-review status. Never on
  // a local card: its key is read off the branch name (see inferredKey just below), so
  // the status on it may belong to a ticket that is not ours — not something to seed an
  // agent against on one click. A run with no Jira status needs no separate guard;
  // isPrReviewStatus is false whenever either side is empty.
  const canAddressPr = !local && isPrReviewStatus(r.jiraStatus ?? "", prReviewStatus);
```

Add the button as the first child of `.actions` (before the `Open` button at line 263):

```tsx
          {canAddressPr && (
            <button
              className="act"
              title={`Address the PR for ${r.run.key} — open its workspace and work through the review feedback`}
              onClick={() => send({ type: "deck:addressPr", key: r.run.key })}
            >
              Address PR
            </button>
          )}
```

No new CSS: `.act` already carries the shape, the rest-state dimming and the hover. Not `.act.primary` — Open is the primary on every card on the board, and that consistency outranks the extra emphasis here. No icon; the Deck's action row is text-only, unlike the sidebar's. The tooltip says "open its workspace", not the sidebar's "check it out in a worktree", because on the Deck the worktree already exists.

In `DeckApp`, add state beside the other `deck:runs` fields (line 297 area):

```tsx
  const [prReviewStatus, setPrReviewStatus] = React.useState("");
```

set it in the `deck:runs` branch (after `setGhNote(m.ghNote);`, line 344):

```tsx
        setPrReviewStatus(m.prReviewStatus);
```

and thread it at the `<Card>` call site (line 506):

```tsx
                  {list.map((r) => <Card key={r.run.key} r={r} live={live} prReviewStatus={prReviewStatus} onForget={forget} />)}
```

- [ ] **Step 5: Run the webview tests to verify they pass**

Run: `npx vitest run test/webview/DeckApp.test.tsx`
Expected: PASS — the eight new cases plus every pre-existing case in the file.

- [ ] **Step 6: Assert the host actually posts the setting**

Add to `test/unit/deckView.test.ts`, inside the existing top-level `describe` that holds the other `deck:runs` post assertions (near line 334):

```ts
  it("posts the configured PR-review status so cards can gate the button", async () => {
    show();
    await settled();
    const msg = posts(lastPanel()).find((m) => m.type === "deck:runs");
    expect(msg.prReviewStatus).toBe("PR initiated");
  });
```

This needs `prReviewStatus` in the suite's `getConfig` mock — add it beside the two settings Task 2 added:

```ts
      prReviewStatus: "PR initiated",
```

- [ ] **Step 7: Run the full gates**

Run: `npm run typecheck && npm test && npm run test:cov && npm run build`
Expected: all pass. `npm run typecheck` is the one that catches a missed `deck:runs` construction site, since the message type is a closed union.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/deckView.ts src/webview/DeckApp.tsx test/unit/deckView.test.ts test/webview/DeckApp.test.tsx
git commit -m "feat(deck): Address PR button on a PR-initiated card

Shows on a card whose Jira status matches agentFlow.prReviewStatus, using
the same isPrReviewStatus predicate the sidebar card uses. deck:runs now
carries the setting, so editing it takes effect on the next poll.

Not on a local card: its key is inferred from the branch name, so the
status shown could belong to somebody else's ticket, and one click is too
cheap for that. Runs with no Jira status need no extra guard — the
predicate is false whenever either side is empty.

Leads the action row as a plain .act. Open stays the primary on every card
on the board; that consistency is worth more than the extra emphasis."
```

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task: gating (Task 3), `deck:addressPr` + the `writePlanFile`/`openInEditor` path + the match/brief table + failure toasts (Task 2), the `engine/prompt.ts` move including the clause and the config/test import churn (Task 1), `prReviewStatus` on `deck:runs` (Task 3), presentation (Task 3), and every listed test.

**One addition beyond the spec.** `cfg.seedAgent` is not mentioned in the spec, but the handler has to decide something about it. It honors the setting — with `seedAgent` off nothing seeds anywhere in the product, and writing a plan file no window will act on would only litter `~/.agentflow/plans`. Covered by "opens the window but writes no plan when seedAgent is off" in Task 2.

**Placeholder scan.** No TBD/TODO, no "add error handling", no "similar to Task N". Every code step carries the literal code.

**Type consistency.** `prReviewTemplate(prompt: string, autoFix: boolean)` is defined in Task 1 and called with that arity in Task 1 (`tasksView`) and Task 2 (`deckView`). `writePlanFile` takes the `PlanFile` shape `{ key, createdAt, seedAgent, matches }` — `remoteControl` and `seq` are optional on that interface and correctly omitted. `agentPrompt(ticket, [], template, briefPath?)` matches `src/engine/workspace.ts:148`. The inbound message is `deck:addressPr` in the type, the switch, the button and every test.
