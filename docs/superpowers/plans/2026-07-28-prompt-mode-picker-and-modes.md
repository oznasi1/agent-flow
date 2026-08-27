# Prompt-Mode Picker & Four More Modes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mangled, auto-derived second line in the "how should the agent start?" QuickPick with a hand-written `detail` per mode, and grow the built-in modes from two to six.

**Architecture:** `PromptMode` gains an optional `detail: string`. `choosePromptMode()` passes it straight through to the QuickPick instead of deriving a line from the prompt template; a mode without one renders label-only. `DEFAULT_PROMPT_MODES` and the matching `package.json` default array both grow to six entries. No change to the launch flow, the placeholder contract, or `renderPrompt`.

**Tech Stack:** TypeScript, VS Code extension API (`window.showQuickPick`), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-28-prompt-mode-picker-and-modes-design.md`

## Global Constraints

- **Do not touch** the `"version"` field in `package.json`, any version field in `package-lock.json`, or `CHANGELOG.md`. The orchestrator owns those. The `contributes.configuration` hunk in `package.json` is in scope and pre-approved.
- `detail` is **optional** on `PromptMode`. The config validator's required-field check stays `x && x.id && x.label && x.prompt` — do not add `detail` to it.
- Every default prompt keeps the established shape: opens `Jira {key}: "{summary}". Read the task brief at {brief} for context and the repos involved.` and ends `Ticket: {url}{files}`.
- `DEFAULT_PROMPT_MODES` in `src/config.ts` and the `default` array of `agentFlow.promptModes` in `package.json` must stay byte-identical in content. VS Code serves the manifest default to real users; the code constant is only the invalid-value fallback. Task 2 adds a test that enforces this.
- Verification bar before declaring done: `npm run typecheck` clean, `npm test` all pass, `npm run test:cov` at or above the project bar for changed files.

---

### Task 1: `detail` on `PromptMode`, rendered by the picker

Makes the picker correct for any mode that carries a `detail`, and clean for any that doesn't. Ships independently of the new modes.

**Files:**
- Modify: `src/types.ts:40-46` (the `PromptMode` interface)
- Modify: `src/tasksView.ts:678-686` (the `showQuickPick` call in `choosePromptMode`)
- Test: `test/unit/tasksView.test.ts` (new cases in the existing `takeTask` describe block)
- Test: `test/unit/config.test.ts` (new case in `describe("getConfig — promptModes validation")`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `PromptMode { id: string; label: string; detail?: string; prompt: string }` — Task 2 populates `detail` on all six defaults.

- [ ] **Step 1: Write the failing picker test**

Add to `test/unit/tasksView.test.ts`, inside the same `describe` that holds `"prompts for a mode when taskMode is 'ask'"`:

```ts
it("shows each mode's hand-written detail, and no line at all without one", async () => {
  const modes = [
    { id: "plan", label: "Plan", detail: "Propose a plan and wait", prompt: 'Jira {key}: "{summary}" at {brief}' },
    { id: "raw", label: "Raw", prompt: 'Jira {key}: "{summary}" at {brief}' },
  ];
  vi.mocked(getConfig).mockReturnValue({ ...CFG, taskMode: "ask", promptModes: modes });
  vi.mocked(window.showQuickPick).mockResolvedValueOnce({ mode: modes[0] } as never);
  const { provider } = setup();
  await provider.takeTask("PROJ-1", ["account-service"]);

  const items = vi.mocked(window.showQuickPick).mock.calls[0][0] as { label: string; detail?: string }[];
  expect(items.map((i) => ({ label: i.label, detail: i.detail }))).toEqual([
    { label: "Plan", detail: "Propose a plan and wait" },
    { label: "Raw", detail: undefined },
  ]);
});

it("never derives the picker line from the prompt template", async () => {
  const modes = [{ id: "plan", label: "Plan", prompt: 'Jira {key}: "{summary}". Read the task brief at {brief}.' }];
  vi.mocked(getConfig).mockReturnValue({ ...CFG, taskMode: "ask", promptModes: modes });
  vi.mocked(window.showQuickPick).mockResolvedValueOnce({ mode: modes[0] } as never);
  const { provider } = setup();
  await provider.takeTask("PROJ-1", ["account-service"]);

  const items = vi.mocked(window.showQuickPick).mock.calls[0][0] as { detail?: string }[];
  expect(items[0].detail).toBeUndefined();
});
```

Why `mock.calls[0][0]` is the mode picker: `takeTask` calls `choosePromptMode` before anything else, and the `CFG` fixture sets `openIn: "new-window"` and `worktree: "never"` while `preselected` skips the repo picker — so no other QuickPick runs first.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/tasksView.test.ts -t "picker line" --reporter=verbose`
(or just `npx vitest run test/unit/tasksView.test.ts`)

Expected: both new cases FAIL. The first reports `detail: 'Jira : "" at'` where `undefined` was expected; the second reports a non-empty derived string.

- [ ] **Step 3: Add `detail` to the type**

In `src/types.ts`, replace the `PromptMode` interface:

```ts
/** A selectable "how should the agent start" mode with a prompt template.
 * Template placeholders: {key} {summary} {url} {brief} {files}.
 * `detail` is the line shown under the label in the picker — written for the
 * user, not derived from the prompt. Omitted modes render label-only. */
export interface PromptMode {
  id: string;
  label: string;
  detail?: string;
  prompt: string;
}
```

- [ ] **Step 4: Pass it through in the picker**

In `src/tasksView.ts`, in `choosePromptMode`, replace the `modes.map(...)` argument:

```ts
    const p = await vscode.window.showQuickPick(
      modes.map((mm) => ({
        label: mm.label,
        detail: mm.detail,
        mode: mm,
      })),
      { title, ignoreFocusOut: true },
    );
```

A `detail` of `undefined` is what VS Code already treats as "no second line", so no branch is needed.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/unit/tasksView.test.ts`
Expected: PASS, including the pre-existing `"prompts for a mode when taskMode is 'ask'"` and `"asks the prompt mode first"` cases.

- [ ] **Step 6: Prove `detail` survives config validation**

Add to `test/unit/config.test.ts`, inside `describe("getConfig — promptModes validation")`:

```ts
  it("keeps an optional detail on a custom mode", () => {
    const custom = [{ id: "debug", label: "Debug", detail: "Reproduce it first", prompt: "reproduce {key}" }];
    setConfig({ promptModes: custom });
    expect(getConfig().promptModes).toEqual(custom);
  });
```

The existing `"filters out entries missing id/label/prompt"` case already proves a mode *without* `detail` still validates — leave it alone.

- [ ] **Step 7: Run typecheck and the full suite**

Run: `npm run typecheck && npm test`
Expected: typecheck clean, all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/tasksView.ts test/unit/tasksView.test.ts test/unit/config.test.ts
git commit -m "fix(tasks): the prompt-mode picker stops mangling its own prompt

Each mode's second line was built by deleting every {placeholder} from the
prompt template and cutting at 80 chars, so it read 'Jira : \"\". Read the
task brief at for context' and stopped mid-word. PromptMode now carries an
optional hand-written detail; a mode without one renders label-only, like
the Explore picker beside it."
```

---

### Task 2: six built-in modes, in the code and the manifest

Adds Test-driven, Investigate & root-cause, Orchestrator, and Refine the ticket, gives all six a `detail`, and locks the manifest default to the code default.

**Files:**
- Modify: `src/config.ts:6-21` (`DEFAULT_PROMPT_MODES`)
- Modify: `package.json` — the `agentFlow.promptModes` block in `contributes.configuration` (item schema + `default` array)
- Modify: `README.md:200-201` (the settings prose that names `agentFlow.promptModes`)
- Test: `test/unit/config.test.ts` (new `describe("DEFAULT_PROMPT_MODES")` block)

**Interfaces:**
- Consumes: `PromptMode.detail?: string` from Task 1.
- Produces: six exported defaults with ids `plan`, `implementation`, `tdd`, `investigate`, `orchestrator`, `refine` — in that order, which is picker order.

- [ ] **Step 1: Write the failing defaults tests**

Add to `test/unit/config.test.ts` as a new top-level `describe` (it needs `DEFAULT_PROMPT_MODES`, already imported by the file, plus `readFileSync`/`join` — add those imports if absent):

```ts
describe("DEFAULT_PROMPT_MODES", () => {
  it("ships six modes in picker order, each with a written detail", () => {
    expect(DEFAULT_PROMPT_MODES.map((m) => m.id)).toEqual([
      "plan",
      "implementation",
      "tdd",
      "investigate",
      "orchestrator",
      "refine",
    ]);
    for (const m of DEFAULT_PROMPT_MODES) {
      expect(m.label.trim().length).toBeGreaterThan(0);
      expect(m.detail?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });

  it("gives every mode the full placeholder set, ending in {files}", () => {
    for (const m of DEFAULT_PROMPT_MODES) {
      for (const ph of ["{key}", "{summary}", "{brief}", "{url}"]) {
        expect(m.prompt).toContain(ph);
      }
      expect(m.prompt.endsWith("{files}")).toBe(true);
    }
  });

  it("matches the default array VS Code actually serves from package.json", () => {
    const manifest = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8"));
    const shipped = manifest.contributes.configuration.properties["agentFlow.promptModes"].default;
    expect(shipped).toEqual(DEFAULT_PROMPT_MODES);
  });
});
```

That third case is the one that matters most: `c.get("promptModes")` returns the **manifest** default for a user who never touched the setting, so `DEFAULT_PROMPT_MODES` alone being right would not reach anybody. Drift between the two is a silent bug.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/config.test.ts`
Expected: FAIL — ids come back as `["plan", "implementation"]`, `detail` is `undefined` on both, and the manifest comparison mismatches.

- [ ] **Step 3: Write the six defaults**

In `src/config.ts`, replace `DEFAULT_PROMPT_MODES` in full:

```ts
/** The stock "how should the agent start" modes, in picker order. `detail` is
 * the line shown under the label — written for the user reading the picker.
 * Keep this array identical to the `agentFlow.promptModes` default in
 * package.json; that manifest default is what VS Code serves to real users. */
export const DEFAULT_PROMPT_MODES: PromptMode[] = [
  {
    id: "plan",
    label: "Plan first",
    detail: "Propose a step-by-step plan and wait for approval — no code edits",
    prompt:
      'Jira {key}: "{summary}". Read the task brief at {brief} for context and the repos involved. ' +
      "Propose a step-by-step PLAN for this task and wait for my approval — do not edit any code yet. Ticket: {url}{files}",
  },
  {
    id: "implementation",
    label: "Implementation",
    detail: "Start building; check in only when something's ambiguous",
    prompt:
      'Jira {key}: "{summary}". Read the task brief at {brief} for context and the repos involved. ' +
      "Begin implementing. Confirm your approach with me only if something is ambiguous. Ticket: {url}{files}",
  },
  {
    id: "tdd",
    label: "Test-driven",
    detail: "Write the failing test first, then implement until it's green",
    prompt:
      'Jira {key}: "{summary}". Read the task brief at {brief} for context and the repos involved. ' +
      "Work test-first: write the failing test that captures this ticket's acceptance criteria, confirm it fails " +
      "for the right reason, then implement until it passes. Ticket: {url}{files}",
  },
  {
    id: "investigate",
    label: "Investigate & root-cause",
    detail: "Reproduce, trace to a root cause, propose a fix — no code edits",
    prompt:
      'Jira {key}: "{summary}". Read the task brief at {brief} for context and the repos involved. ' +
      "Reproduce the problem, trace it to a root cause, and explain what's going wrong with evidence from the code. " +
      "Propose a fix, but don't change code unless I ask. Ticket: {url}{files}",
  },
  {
    id: "orchestrator",
    label: "Orchestrator",
    detail: "Split into parallel subtasks, then integrate and verify",
    prompt:
      'Jira {key}: "{summary}". Read the task brief at {brief} for context and the repos involved. ' +
      "Break this into independent subtasks and tell me the breakdown before you start. Then dispatch a subagent " +
      "per subtask so they run in parallel, integrate the results yourself, and verify the whole thing works. " +
      "Ticket: {url}{files}",
  },
  {
    id: "refine",
    label: "Refine the ticket",
    detail: "Sharpen the description and acceptance criteria — no code",
    prompt:
      'Jira {key}: "{summary}". Read the task brief at {brief} for context and the repos involved. ' +
      "This ticket needs sharpening before anyone builds it: dig into the code, then rewrite the description and " +
      "acceptance criteria so they're unambiguous and testable, and list what's still unclear. Update the ticket " +
      "and add the `claude-code` label. Don't implement it. Ticket: {url}{files}",
  },
];
```

- [ ] **Step 4: Mirror it into the manifest**

In `package.json`, under `contributes.configuration.properties`, update `agentFlow.promptModes`. Add `detail` to the item schema (**not** to `required`) and replace the `default` array with all six modes, matching Step 3 exactly — same order, same strings, the `prompt` values being the two concatenated halves joined:

```json
        "agentFlow.promptModes": {
          "type": "array",
          "markdownDescription": "Prompt modes offered when taking a task. Each has an `id`, `label`, `prompt` template, and an optional `detail` line shown under the label in the picker. Placeholders: `{key}`, `{summary}`, `{url}`, `{brief}`, `{files}`. Add your own (e.g. a `spike` mode).",
          "items": {
            "type": "object",
            "required": ["id", "label", "prompt"],
            "properties": {
              "id": { "type": "string", "description": "Stable id (used by taskMode)." },
              "label": { "type": "string", "description": "Shown in the picker." },
              "detail": { "type": "string", "description": "Optional line shown under the label in the picker. Omit it and the mode shows its label only." },
              "prompt": { "type": "string", "description": "Template with {key} {summary} {url} {brief} {files}." }
            }
          },
          "default": [ ...the six modes... ]
        },
```

Keep the file's existing 2-space JSON indentation and expanded property style — the snippet above is compressed for readability only. The `required` array must stay `["id", "label", "prompt"]`.

The Step 1 manifest-sync test is the check on this: if a single character differs, it fails.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/unit/config.test.ts`
Expected: PASS, all three new cases plus the four pre-existing validation cases.

- [ ] **Step 6: Update the README**

In `README.md`, replace the paragraph beginning `Plus \`agentFlow.workspaceMode\`, \`agentFlow.taskMode\`…` so it names the modes:

```markdown
Plus `agentFlow.workspaceMode`, `agentFlow.taskMode`, `agentFlow.promptModes`,
`agentFlow.exploreMode`, `agentFlow.explorePrompts.*`, `agentFlow.prReviewPrompt`, and
`agentFlow.worktree` — see the Settings UI. Taking a task asks how the agent should
start: **Plan first**, **Implementation**, **Test-driven**, **Investigate &
root-cause**, **Orchestrator**, or **Refine the ticket**. Edit those prompts, or add
your own mode, under `agentFlow.promptModes`; pin one with `agentFlow.taskMode` to skip
the question. The **Address PR** kick-off always runs in a worktree. Per-task worktrees
are created inside each repo at `.claude/worktrees/<KEY>` (and git-excluded
automatically).
```

- [ ] **Step 7: Run typecheck, the full suite, and coverage**

Run: `npm run typecheck && npm test && npm run test:cov`
Expected: typecheck clean, all tests pass, changed files at or above the project coverage bar.

- [ ] **Step 8: Commit**

```bash
git add src/config.ts package.json README.md test/unit/config.test.ts
git commit -m "feat(tasks): four more ways to start a task

Test-driven, Investigate & root-cause, Orchestrator, and Refine the ticket
join Plan first and Implementation, and all six now carry a written detail
line. A test pins the package.json default array to DEFAULT_PROMPT_MODES,
since the manifest default is what VS Code actually serves."
```

---

### Task 3: rebase and declare

- [ ] **Step 1: Rebase onto current `main`**

```bash
git fetch origin
git rebase main
```

Per the orchestrator's note, `main` moved to `38d94ca` (a spec file only, nothing in `src/`), and the two other live tasks are in `src/jira/` — no expected conflict with `types.ts`, `config.ts`, or `tasksView.ts`. If `main` has moved again, rebase onto whatever it is now.

- [ ] **Step 2: Re-verify after the rebase**

Run: `npm run typecheck && npm test && npm run test:cov`
Expected: all clean. A rebase can break what passed before it.

- [ ] **Step 3: Confirm no release files were touched**

Run: `git diff main --stat`
Expected: `package.json` appears (the `contributes` hunk, pre-approved), but **no** `package-lock.json` and **no** `CHANGELOG.md`. Confirm the `package.json` diff contains no `"version"` line.

- [ ] **Step 4: Update the status file to `ready-to-merge`**

Rewrite `/Users/oznasi/dev/agent-flow/.claude/orchestrator/prompt-modes.md` with `state: ready-to-merge` and the **actual pasted output** of typecheck, test, and coverage under `## Verification`. Claims without output are treated as unverified. Stop there — the orchestrator does the merge, the version bump, the changelog, and the `.vsix`.

---

## Self-Review

**Spec coverage.** Decisions table → Task 1 Steps 3-4 (hand-written detail, omission fallback, `detail` in the item schema at Task 2 Step 4), Task 2 Step 3 (six modes, prompt-only Orchestrator). "Does the ticket get fetched earlier? No" → no task touches `takeTask`'s ordering; Task 1 Step 1 relies on that ordering and the pre-existing `"asks the prompt mode first"` test guards it. "No backfill for customized arrays" → no migration task exists, per the orchestrator's ruling. Surfaces list → `types.ts` (T1), `config.ts` (T2), `tasksView.ts` (T1), `package.json` (T2), `README.md` (T2), `CHANGELOG.md` correctly absent. Testing section → all cases assigned. Non-goals → nothing in the plan reaches into them.

**Placeholder scan.** No TBD/TODO. Every code step carries real code. The one ellipsis, `default: [ ...the six modes... ]` in Task 2 Step 4, points at the fully-written array one step above it in the same task, and the manifest-sync test fails if it is filled in wrong.

**Type consistency.** `PromptMode.detail?: string` defined in T1 Step 3, consumed as `mm.detail` in T1 Step 4 and populated in T2 Step 3. Ids `plan`/`implementation`/`tdd`/`investigate`/`orchestrator`/`refine` are identical in the T2 Step 1 assertion and the T2 Step 3 constant. `DEFAULT_PROMPT_MODES` keeps its existing name and export.
