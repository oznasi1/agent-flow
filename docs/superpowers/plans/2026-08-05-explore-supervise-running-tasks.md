# "Supervise running tasks" Explore action Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sixth Explore action, "Supervise running tasks," that seeds a session whose brief lists every other run Agent Flow still has in flight — and whether each still has a live agent attached — so the seeded agent can check on and unblock them.

**Architecture:** Same mechanism every other Explore action already uses (a `EXPLORE_ACTION_DEFS` entry + one settings-page prompt textarea). One new pure formatting helper, `describeActiveTasks()`, turns `readRuns()` + a live-session set into a markdown block; `tasksView.explore()` folds that block into the seeded session's `planMd` (the same extension point already used for the "no ticket yet" note), reusing the exact live-session idiom `deckView.ts` already has (`groupByPlace(readOpenSessions(...)).keys()` → `canon(repo.path)` membership test). No new prompt placeholder, no change to the ticket-flow "Orchestrator" prompt mode, no change to `openWorkspace`'s signature.

**Tech Stack:** TypeScript, VS Code extension API, Vitest.

## Global Constraints

- Follow the approved spec exactly: `docs/superpowers/specs/2026-08-05-explore-supervise-running-tasks-design.md`.
- The ticket-flow "Orchestrator" prompt mode (`DEFAULT_PROMPT_MODES` in `config.ts`, reachable only via Take) is never touched by this work.
- No new `{placeholder}` — the active-tasks list is folded into `planMd`, which already fills `{brief}`.
- `exploreActions` stays a fixed, code-defined list — only the new action's prompt *text* is a user setting.
- Every task must leave `npx vitest run` green before moving to the next task.
- This work happens in the worktree at `.claude/worktrees/explore-supervise-tasks` (branch `worktree-explore-supervise-tasks`) — commit there, not on `main`.

---

## Task 1: `describeActiveTasks` helper

**Files:**
- Modify: `src/engine/runs.ts`
- Test: `test/unit/engine/runs.test.ts`

**Interfaces:**
- Produces: `describeActiveTasks(runs: Run[], livePlaces: ReadonlySet<string>): string` — exported from `src/engine/runs.ts`. Later tasks (Task 4) import this directly.

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block at the end of `test/unit/engine/runs.test.ts` (after the existing `describe("runTarget", ...)` block), and add `describeActiveTasks` to the existing import from `../../../src/engine/runs` on line 5:

```ts
import { writeRun, readRuns, removeRun, runTarget, describeActiveTasks } from "../../../src/engine/runs";
```

```ts
describe("describeActiveTasks", () => {
  it("returns the empty-state sentence when there are no runs", () => {
    expect(describeActiveTasks([], new Set())).toBe("_No other active tasks right now._");
  });

  it("excludes a finished run", () => {
    const finished = { ...mkRun("ASM-1", 100), finishedAt: 200 };
    expect(describeActiveTasks([finished], new Set())).toBe("_No other active tasks right now._");
  });

  it("includes only the unfinished runs from a mix of finished and unfinished", () => {
    const finished = { ...mkRun("ASM-1", 100), finishedAt: 200 };
    const unfinished = mkRun("ASM-2", 300);
    const md = describeActiveTasks([finished, unfinished], new Set());
    expect(md).not.toContain("ASM-1");
    expect(md).toContain("ASM-2");
  });

  it("lists an unfinished run as idle when its repo has no live session", () => {
    const run = mkRun("ASM-1", 100);
    expect(describeActiveTasks([run], new Set())).toBe(
      "## Active tasks\n- **ASM-1** (task) — ASM-1 summary — `/repos/svc` (branch: asm-1) — idle, no agent attached",
    );
  });

  it("marks a run as having an agent open when its repo is in livePlaces", () => {
    const run = mkRun("ASM-1", 100);
    expect(describeActiveTasks([run], new Set(["/repos/svc"]))).toContain("agent open");
    expect(describeActiveTasks([run], new Set(["/repos/svc"]))).not.toContain("idle");
  });

  it("renders a run's kind, tolerating an old record with no kind field", () => {
    const tagged = { ...mkRun("ASM-1", 100), kind: "explore" as const };
    expect(describeActiveTasks([tagged], new Set())).toContain("**ASM-1** (explore)");
    const untagged = mkRun("ASM-2", 100);
    expect(describeActiveTasks([untagged], new Set())).toContain("**ASM-2** (task)");
  });

  it("falls back to an 'unknown location' placeholder for a run with no repos", () => {
    const run = { ...mkRun("ASM-1", 100), repos: [] };
    expect(describeActiveTasks([run], new Set())).toContain("unknown location");
  });

  it("lists multiple active runs as separate bullets, newest first if readRuns already sorted them", () => {
    const a = mkRun("ASM-1", 100);
    const b = mkRun("ASM-2", 300);
    const md = describeActiveTasks([b, a], new Set());
    expect(md.split("\n")).toEqual([
      "## Active tasks",
      "- **ASM-2** (task) — ASM-2 summary — `/repos/svc` (branch: asm-2) — idle, no agent attached",
      "- **ASM-1** (task) — ASM-1 summary — `/repos/svc` (branch: asm-1) — idle, no agent attached",
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/runs.test.ts`
Expected: FAIL — `describeActiveTasks` is not exported from `src/engine/runs.ts`.

- [ ] **Step 3: Implement `describeActiveTasks`**

In `src/engine/runs.ts`, change the top imports (currently `import { Run } from "../types";`) to also pull in `runKind`, and import `canon` from `./paths`:

```ts
import { Run, runKind } from "../types";
import { canon } from "./paths";
```

Then add the function at the end of the file, after `runTarget`:

```ts
/** One bullet per still-active run, for folding into a supervising session's
 * brief.md via `planMd` — not a new prompt placeholder. `livePlaces` is the
 * canonicalised repo-root set of directories with a live Claude Code session
 * open right now: build it the same way `deckView.ts` already does for its
 * own retire-sweep check — `new Set(groupByPlace(readOpenSessions(dir)).keys())`. */
export function describeActiveTasks(runs: Run[], livePlaces: ReadonlySet<string>): string {
  const active = runs.filter((r) => !r.finishedAt);
  if (active.length === 0) return "_No other active tasks right now._";
  const lines = active.map((r) => {
    const live = r.repos.some((repo) => livePlaces.has(canon(repo.path)));
    const first = r.repos[0];
    const where = first ? `\`${first.path}\`${first.branch ? ` (branch: ${first.branch})` : ""}` : "unknown location";
    return `- **${r.key}** (${runKind(r)}) — ${r.summary} — ${where} — ${live ? "agent open" : "idle, no agent attached"}`;
  });
  return `## Active tasks\n${lines.join("\n")}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/runs.test.ts`
Expected: PASS (all tests in the file, including the new `describe("describeActiveTasks", ...)` block).

- [ ] **Step 5: Commit**

```bash
git add src/engine/runs.ts test/unit/engine/runs.test.ts
git commit -m "feat(runs): add describeActiveTasks for the supervise Explore action"
```

---

## Task 2: Register the `supervise` Explore action in `config.ts`

**Files:**
- Modify: `src/config.ts`
- Test: `test/unit/config.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `DEFAULT_EXPLORE_SUPERVISE_PROMPT` (exported string constant) and a `supervise` entry in `EXPLORE_ACTION_DEFS` / `DEFAULT_EXPLORE_ACTIONS`, positioned between `general` and `verify`. Task 3 imports `DEFAULT_EXPLORE_SUPERVISE_PROMPT`; Task 4 relies on `cfg.exploreActions` containing an action whose `id === "supervise"`.

- [ ] **Step 1: Write the failing tests**

In `test/unit/config.test.ts`, add `DEFAULT_EXPLORE_SUPERVISE_PROMPT` to the import block from `../../src/config` (after `DEFAULT_EXPLORE_VERIFY_PROMPT` on line 12):

```ts
  DEFAULT_EXPLORE_VERIFY_PROMPT,
  DEFAULT_EXPLORE_SUPERVISE_PROMPT,
```

Replace the existing test at line 361 (`"defaults to five actions with built-in labels and default prompts, all Slack-off"`) with a six-action version, inserting `supervise` before `verify`:

```ts
  it("defaults to six actions with built-in labels and default prompts, all Slack-off", () => {
    expect(getConfig().exploreActions).toEqual([
      { id: "jiraTicket", label: "Open a Jira ticket", prompt: DEFAULT_EXPLORE_JIRA_TICKET_PROMPT, slackDm: false, needsEnv: false },
      { id: "knowledge", label: "Enhance knowledge / flow", prompt: DEFAULT_EXPLORE_PROMPT, slackDm: false, needsEnv: false },
      { id: "debug", label: "Debug", prompt: DEFAULT_EXPLORE_DEBUG_PROMPT, slackDm: false, needsEnv: false },
      { id: "general", label: "General", prompt: DEFAULT_EXPLORE_GENERAL_PROMPT, slackDm: false, needsEnv: false },
      { id: "supervise", label: "Supervise running tasks", prompt: DEFAULT_EXPLORE_SUPERVISE_PROMPT, slackDm: false, needsEnv: false },
      { id: "verify", label: "Verify on an environment", prompt: DEFAULT_EXPLORE_VERIFY_PROMPT, slackDm: false, needsEnv: true },
    ]);
  });
```

Add a new prompt-override test right after the existing `"uses a verify prompt override from settings"` test (around line 379):

```ts
  it("uses a supervise prompt override from settings", () => {
    setConfig({ "explorePrompts.supervise": "watch {summary}{files}" });
    expect(getConfig().exploreActions.find((x) => x.id === "supervise")?.prompt).toBe("watch {summary}{files}");
  });
```

Update the existing `"flips slackDm per action id and ignores non-boolean values"` test (around line 392) to include `supervise` in the expected object:

```ts
  it("flips slackDm per action id and ignores non-boolean values", () => {
    setConfig({ exploreSlackDm: { jiraTicket: true, knowledge: "yes", debug: 1 } });
    const byId = Object.fromEntries(getConfig().exploreActions.map((x) => [x.id, x.slackDm]));
    expect(byId).toEqual({ jiraTicket: true, knowledge: false, debug: false, general: false, supervise: false, verify: false });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/config.test.ts`
Expected: FAIL — `DEFAULT_EXPLORE_SUPERVISE_PROMPT` is not exported, `exploreActions` has five entries not six, and the slackDm object is missing the `supervise` key.

- [ ] **Step 3: Implement the config changes**

In `src/config.ts`, add the new prompt constant right after `DEFAULT_EXPLORE_GENERAL_PROMPT` (after line 91) and before the `DEFAULT_EXPLORE_VERIFY_PROMPT` comment (line 93):

```ts
/** Seed for the "Supervise running tasks" action — check on Agent Flow's other
 * active runs rather than the current focus. Placeholders: {summary} (optional
 * priority), {brief} (includes the active-tasks list), {files}. */
export const DEFAULT_EXPLORE_SUPERVISE_PROMPT =
  "Supervision session — checking on your other active Agent Flow tasks. A brief listing them, and whether each " +
  "still has an agent attached, is at {brief}. Read it, judge which ones are stalled, blocked, or waiting on you, " +
  "and tell me what needs attention. Where it's safe and unambiguous, help unblock or integrate one yourself; " +
  "flag anything you're unsure about rather than guessing.{files}";
```

Then insert a new entry into `EXPLORE_ACTION_DEFS` (currently lines 122–128), between `general` and `verify`:

```ts
const EXPLORE_ACTION_DEFS: { id: string; label: string; settingKey: string; defaultPrompt: string; needsEnv?: boolean }[] = [
  { id: "jiraTicket", label: "Open a Jira ticket", settingKey: "explorePrompts.jiraTicket", defaultPrompt: DEFAULT_EXPLORE_JIRA_TICKET_PROMPT },
  { id: "knowledge", label: "Enhance knowledge / flow", settingKey: "explorePrompts.knowledge", defaultPrompt: DEFAULT_EXPLORE_PROMPT },
  { id: "debug", label: "Debug", settingKey: "explorePrompts.debug", defaultPrompt: DEFAULT_EXPLORE_DEBUG_PROMPT },
  { id: "general", label: "General", settingKey: "explorePrompts.general", defaultPrompt: DEFAULT_EXPLORE_GENERAL_PROMPT },
  { id: "supervise", label: "Supervise running tasks", settingKey: "explorePrompts.supervise", defaultPrompt: DEFAULT_EXPLORE_SUPERVISE_PROMPT },
  { id: "verify", label: "Verify on an environment", settingKey: "explorePrompts.verify", defaultPrompt: DEFAULT_EXPLORE_VERIFY_PROMPT, needsEnv: true },
];
```

No other code in `config.ts` needs to change: `getConfig()`'s `exploreActions` mapping and `resolvePrompt()` already iterate `EXPLORE_ACTION_DEFS` generically.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/unit/config.test.ts
git commit -m "feat(config): register the supervise Explore action"
```

---

## Task 3: Settings manifest — `package.json` + `EXPLORE_MODES`

**Files:**
- Modify: `package.json`
- Modify: `src/telemetry/settingsSnapshot.ts`
- Test: `test/unit/config.test.ts`
- Test: `test/unit/telemetry/settingsSnapshot.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_EXPLORE_SUPERVISE_PROMPT` from Task 2.
- Produces: `"supervise"` accepted by `agentFlow.exploreMode`'s manifest enum and by `EXPLORE_MODES` in `settingsSnapshot.ts` (kept in parity by the existing, unmodified `test/unit/telemetry/settingsSnapshot.test.ts` parity tests).

- [ ] **Step 1: Write the failing test**

Add one line to the existing `"keeps each explore prompt schema default byte-identical to its config constant"` test in `test/unit/config.test.ts` (around line 673):

```ts
  it("keeps each explore prompt schema default byte-identical to its config constant", () => {
    expect(props["agentFlow.explorePrompts.jiraTicket"].default).toBe(DEFAULT_EXPLORE_JIRA_TICKET_PROMPT);
    expect(props["agentFlow.explorePrompts.knowledge"].default).toBe(DEFAULT_EXPLORE_PROMPT);
    expect(props["agentFlow.explorePrompts.debug"].default).toBe(DEFAULT_EXPLORE_DEBUG_PROMPT);
    expect(props["agentFlow.explorePrompts.general"].default).toBe(DEFAULT_EXPLORE_GENERAL_PROMPT);
    expect(props["agentFlow.explorePrompts.supervise"].default).toBe(DEFAULT_EXPLORE_SUPERVISE_PROMPT);
    expect(props["agentFlow.explorePrompts.verify"].default).toBe(DEFAULT_EXPLORE_VERIFY_PROMPT);
  });
```

(`DEFAULT_EXPLORE_SUPERVISE_PROMPT` is already imported from Task 2's step.)

Also add a behavior test to `test/unit/telemetry/settingsSnapshot.test.ts`, right after the existing `"reports a verify exploreMode as itself, not as invalid"` test (around line 172):

```ts
  it("reports a supervise exploreMode as itself, not as invalid", () => {
    expect(settingsSnapshot({ ...getConfig(), exploreMode: "supervise" }).explore_mode).toBe("supervise");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/config.test.ts`
Expected: FAIL — `props["agentFlow.explorePrompts.supervise"]` is `undefined`.

Also run the new `settingsSnapshot.test.ts` behavior test:

Run: `npx vitest run test/unit/telemetry/settingsSnapshot.test.ts -t "supervise"`
Expected: FAIL — `EXPLORE_MODES` doesn't include `"supervise"` yet, so `enumOrInvalid` collapses it to `"invalid"`.

The two *parity* tests in that file (`"keeps EXPLORE_MODES equal to..."` and `"...the same length"`) still PASS at this point — nothing added to `EXPLORE_MODES` or the manifest enum yet, so both sides are still five-and-five and agree with each other. They start actually exercising the new value once Step 3 changes both files together; re-run after Step 3 to confirm they still pass with `"supervise"` present on both sides.

- [ ] **Step 3: Implement the manifest and telemetry changes**

In `package.json`, update `agentFlow.exploreMode` (currently around line 308–328) to add `"supervise"` before `"verify"` in both `enum` and `enumDescriptions`:

```json
        "agentFlow.exploreMode": {
          "type": "string",
          "enum": [
            "ask",
            "jiraTicket",
            "knowledge",
            "debug",
            "general",
            "supervise",
            "verify"
          ],
          "enumDescriptions": [
            "Choose an action each time you click Explore",
            "Open a Jira ticket — explore, then create a ticket capturing the findings",
            "Enhance knowledge / flow — map the code paths and explain how it works",
            "Debug — reproduce and root-cause a problem",
            "General — open-ended working session",
            "Supervise running tasks — check on your other active tasks and help unblock or integrate them",
            "Verify on an environment — check a feature against a live env for the picked services"
          ],
          "default": "ask",
          "markdownDescription": "Which Explore action to start. `ask` shows a picker each time; otherwise that action's prompt is seeded directly. Prompts are editable under `agentFlow.explorePrompts`."
        },
```

Add a new setting `agentFlow.explorePrompts.supervise` right after `agentFlow.explorePrompts.general` and before `agentFlow.explorePrompts.verify` (currently the boundary is around line 352–353):

```json
        "agentFlow.explorePrompts.supervise": {
          "type": "string",
          "editPresentation": "multilineText",
          "markdownDescription": "Prompt seeded for the **Supervise running tasks** Explore action. Placeholders: `{summary}` (optional priority), `{brief}` (includes a list of your other active tasks), `{files}`.",
          "default": "Supervision session — checking on your other active Agent Flow tasks. A brief listing them, and whether each still has an agent attached, is at {brief}. Read it, judge which ones are stalled, blocked, or waiting on you, and tell me what needs attention. Where it's safe and unambiguous, help unblock or integrate one yourself; flag anything you're unsure about rather than guessing.{files}"
        },
```

In `agentFlow.exploreSlackDm`'s `properties` (currently lines 362–383), add a `supervise` boolean property right after `general` and before `verify`:

```json
            "supervise": {
              "type": "boolean",
              "description": "Supervise running tasks"
            },
```

And add `"supervise": false` to that same setting's `default` object (currently lines 387–393):

```json
          "default": {
            "jiraTicket": false,
            "knowledge": false,
            "debug": false,
            "general": false,
            "supervise": false,
            "verify": false
          }
```

In `src/telemetry/settingsSnapshot.ts`, update the `EXPLORE_MODES` constant (line 40) to add `"supervise"` in the same position:

```ts
export const EXPLORE_MODES = ["ask", "jiraTicket", "knowledge", "debug", "general", "supervise", "verify"] as const;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/config.test.ts test/unit/telemetry/settingsSnapshot.test.ts`
Expected: PASS — including the pre-existing, unmodified `"keeps EXPLORE_MODES equal to agentFlow.exploreMode's manifest enum"` and `"keeps agentFlow.exploreMode's enum and enumDescriptions the same length"` tests, which now validate the six-and-six lists agree.

- [ ] **Step 5: Commit**

```bash
git add package.json src/telemetry/settingsSnapshot.ts test/unit/config.test.ts
git commit -m "feat(settings): expose the supervise Explore action's prompt and enum entries"
```

---

## Task 4: Wire `supervise` into `tasksView.explore()`

**Files:**
- Modify: `src/tasksView.ts`
- Test: `test/unit/tasksView.test.ts`

**Interfaces:**
- Consumes: `describeActiveTasks` from `src/engine/runs.ts` (Task 1); `readRuns`, `defaultRunsDir` from `src/engine/runs.ts`; `readOpenSessions`, `defaultSessionsDir`, `groupByPlace` from `src/engine/sessions.ts`.
- Produces: no new exports — this is the top-level behavior the whole feature exists for.

- [ ] **Step 1: Write the failing tests**

In `test/unit/tasksView.test.ts`, add two new `vi.mock` blocks right after the existing `vi.mock("../../src/engine/presence", ...)` block (around line 56), keeping every real (pure) export and stubbing only the fs-touching ones — the same pattern the file already uses for `../../src/config`:

```ts
vi.mock("../../src/engine/runs", async () => {
  const actual = await vi.importActual<typeof import("../../src/engine/runs")>("../../src/engine/runs");
  return { ...actual, readRuns: vi.fn(() => []), defaultRunsDir: vi.fn(() => "/runs") };
});
vi.mock("../../src/engine/sessions", async () => {
  const actual = await vi.importActual<typeof import("../../src/engine/sessions")>("../../src/engine/sessions");
  return { ...actual, readOpenSessions: vi.fn(() => []), defaultSessionsDir: vi.fn(() => "/sessions") };
});
```

Add the corresponding imports to the top import block, right after the existing `import { readLiveWindows, windowIdentity } from "../../src/engine/presence";` line (around line 92):

```ts
import { readRuns } from "../../src/engine/runs";
import { readOpenSessions } from "../../src/engine/sessions";
```

Insert a `supervise` entry into the shared `CFG.exploreActions` fixture (currently lines 113–119), between `general` and `verify`:

```ts
  exploreActions: [
    { id: "jiraTicket", label: "Open a Jira ticket", prompt: "JT {summary}{files}", slackDm: false, needsEnv: false },
    { id: "knowledge", label: "Enhance knowledge / flow", prompt: "Explore {summary}{files}", slackDm: false, needsEnv: false },
    { id: "debug", label: "Debug", prompt: "DBG {summary}{files}", slackDm: false, needsEnv: false },
    { id: "general", label: "General", prompt: "GEN {summary}{files}", slackDm: false, needsEnv: false },
    { id: "supervise", label: "Supervise running tasks", prompt: "SUP {summary}{files}", slackDm: false, needsEnv: false },
    { id: "verify", label: "Verify on an environment", prompt: "VER {summary} on {env} for {services}{files}", slackDm: false, needsEnv: true },
  ],
```

Update the existing test `"offers all five configured actions, in order, from the exploreMode 'ask' picker"` (around line 1025) to six:

```ts
  it("offers all six configured actions, in order, from the exploreMode 'ask' picker", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "ask" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("focus");
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ action: CFG.exploreActions[0] } as never) // action picker → Jira ticket
      .mockResolvedValueOnce([{ repo: repos[0] }] as never); // repo picker
    const { send } = setup();
    await send({ type: "explore" });
    const items = vi.mocked(window.showQuickPick).mock.calls[0][0] as { label: string }[];
    expect(items).toHaveLength(6);
    expect(items.map((i) => i.label)).toEqual(CFG.exploreActions.map((a) => a.label));
  });
```

Add two new tests at the end of the `describe("explore", ...)` block, right before its closing `});` (currently around line 1280, after the `"does not ask for an environment for an action that does not need one"` test):

```ts
  it("uses supervise-specific topic-box copy and a supervise-specific fallback when left blank", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "supervise" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("");
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { send } = setup();
    await send({ type: "explore" });
    const opts = vi.mocked(window.showInputBox).mock.calls[0][0] as { title: string };
    expect(opts.title).toBe("Supervise — anything specific to prioritize?");
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        ticket: expect.objectContaining({ key: "explore-check-on-active-tasks", summary: "Check on active tasks" }),
      }),
    );
  });

  it("folds the other active tasks into planMd for the supervise action", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "supervise" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(readRuns).mockReturnValue([
      {
        key: "ASM-9",
        summary: "Fix retry bug",
        url: "https://jira/ASM-9",
        createdAt: 1,
        mode: "per-window",
        repos: [{ name: "svc", path: "/repos/svc", isGit: true, branch: "fix/retry" }],
        briefPaths: [],
        kind: "task",
      },
    ]);
    vi.mocked(readOpenSessions).mockReturnValue([]);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("focus");
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { send } = setup();
    await send({ type: "explore" });
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        planMd: expect.stringContaining(
          "- **ASM-9** (task) — Fix retry bug — `/repos/svc` (branch: fix/retry) — idle, no agent attached",
        ),
      }),
    );
  });

  it("regression: leaves the generic-Explore planMd unchanged for a non-supervise action", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "knowledge" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("retry logic");
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { send } = setup();
    await send({ type: "explore" });
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        planMd: "## Exploration: retry logic\n\n_No Jira ticket yet — a knowledge/exploration session. If it turns into work, open a ticket afterwards._",
      }),
    );
  });

  it("regression: leaves the Verify planMd unchanged", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "verify" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("retry banner");
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ label: "staging", env: "staging" } as never)
      .mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { send } = setup();
    await send({ type: "explore" });
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        planMd: "## Verify: retry banner on staging\n\n_Verification session — environment: staging. Services in scope: account-service._",
      }),
    );
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/tasksView.test.ts`
Expected: FAIL on two tests — `"uses supervise-specific topic-box copy..."` (the title stays `"Explore — what do you want to dig into?"` and the fallback stays `"Codebase exploration"`, since `explore()` doesn't yet special-case `action.id === "supervise"`) and `"folds the other active tasks into planMd..."` (`planMd` never gets an `## Active tasks` section). The six-actions test already PASSES — the picker already reflects `cfg.exploreActions`, which the fixture now lists six of. The two new `"regression: ..."` tests also already PASS — they pin the two branches this task is *not* changing, so they must be green both before and after Step 3.

- [ ] **Step 3: Implement the `explore()` changes**

In `src/tasksView.ts`, add two new imports right after the existing `import { readLiveWindows, windowIdentity, defaultWindowsDir, PresenceRecord } from "./engine/presence";` line (around line 20):

```ts
import { readRuns, defaultRunsDir, describeActiveTasks } from "./engine/runs";
import { defaultSessionsDir, groupByPlace, readOpenSessions } from "./engine/sessions";
```

Replace the topic input-box block inside `explore()` (currently lines 699–716):

```ts
    const raw = await vscode.window.showInputBox(
      action.needsEnv
        ? {
            title: "Verify — which feature or change?",
            prompt: "The feature or change to verify on the environment.",
            placeHolder: "e.g. the new retry banner on checkout",
            ignoreFocusOut: true,
            validateInput: (v) => (v.trim() ? undefined : "Name the feature or change to verify"),
          }
        : {
            title: "Explore — what do you want to dig into?",
            prompt: "A focus for the session (optional). A Jira ticket can come later.",
            placeHolder: "e.g. how the aggregator retries failed scans",
            ignoreFocusOut: true,
          },
    );
    if (raw === undefined) return; // cancelled (empty is allowed → generic focus)
    const topic = raw.trim() || "Codebase exploration";
```

with:

```ts
    const raw = await vscode.window.showInputBox(
      action.needsEnv
        ? {
            title: "Verify — which feature or change?",
            prompt: "The feature or change to verify on the environment.",
            placeHolder: "e.g. the new retry banner on checkout",
            ignoreFocusOut: true,
            validateInput: (v) => (v.trim() ? undefined : "Name the feature or change to verify"),
          }
        : action.id === "supervise"
          ? {
              title: "Supervise — anything specific to prioritize?",
              prompt: "Optional — a priority among your other active tasks. Leave blank to check on all of them.",
              placeHolder: "e.g. the deck-agents-view task",
              ignoreFocusOut: true,
            }
          : {
              title: "Explore — what do you want to dig into?",
              prompt: "A focus for the session (optional). A Jira ticket can come later.",
              placeHolder: "e.g. how the aggregator retries failed scans",
              ignoreFocusOut: true,
            },
    );
    if (raw === undefined) return; // cancelled (empty is allowed → generic focus)
    const topic = raw.trim() || (action.id === "supervise" ? "Check on active tasks" : "Codebase exploration");
```

Replace the `planMd` assignment (currently lines 765–767):

```ts
    const planMd = env
      ? `## Verify: ${topic} on ${env}\n\n_Verification session — environment: ${env}. Services in scope: ${serviceNames}._`
      : `## Exploration: ${topic}\n\n_No Jira ticket yet — a knowledge/exploration session. If it turns into work, open a ticket afterwards._`;
```

with:

```ts
    const planMd = env
      ? `## Verify: ${topic} on ${env}\n\n_Verification session — environment: ${env}. Services in scope: ${serviceNames}._`
      : action.id === "supervise"
        ? `## Supervise: ${topic}\n\n_No Jira ticket yet — a supervision session over your other active Agent Flow tasks._\n\n` +
          describeActiveTasks(readRuns(defaultRunsDir()), new Set(groupByPlace(readOpenSessions(defaultSessionsDir())).keys()))
        : `## Exploration: ${topic}\n\n_No Jira ticket yet — a knowledge/exploration session. If it turns into work, open a ticket afterwards._`;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/tasksView.test.ts`
Expected: PASS — all tests in the file, including the two new ones and the updated six-actions test.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test`
Expected: PASS — every test file in the project (72+ files).

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/tasksView.ts test/unit/tasksView.test.ts
git commit -m "feat(explore): wire the supervise action into explore()'s topic box and planMd"
```

---

## Final check

After Task 4, manually confirm against the spec's own checklist (`docs/superpowers/specs/2026-08-05-explore-supervise-running-tasks-design.md`):

- [ ] `exploreActions` has six entries, `supervise` between `general` and `verify`.
- [ ] The ticket-flow "Orchestrator" prompt mode (`DEFAULT_PROMPT_MODES`, `choosePromptMode()`, Take) is untouched — `git diff main` should show no changes to those.
- [ ] No new `{placeholder}` was added to `renderPrompt`/`applyExploreVars`.
- [ ] `npm test` and `npm run typecheck` are both green.
