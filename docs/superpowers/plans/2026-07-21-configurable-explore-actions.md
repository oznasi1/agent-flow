# Configurable Explore Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single fixed Explore prompt into a menu of four built-in actions (Open a Jira ticket / Enhance knowledge / Debug / General), each with a settings-page-editable prompt and a per-action "DM me on Slack when done" checkbox.

**Architecture:** Prompt-layer only. Four fixed actions live in code (ids + labels); each action's prompt is an individual `multilineText` string setting so it is editable in the VS Code settings UI, and `getConfig()` assembles them into an `ExploreAction[]`. Clicking Explore shows a native QuickPick of the actions (unless `exploreMode` pins one), then seeds the chosen action's prompt — with a Slack-DM sentence appended when that action's checkbox is on. Creating the Jira ticket and sending the Slack DM are the **agent's** job via the seeded prompt; the extension adds no Jira/Slack integration.

**Tech Stack:** TypeScript, VS Code extension API (`WorkspaceConfiguration`), esbuild, vitest (with a hand-written `vscode` mock).

## Global Constraints

- **Prompt-layer only.** No extension-side Jira create, Slack send, or session-completion detection. The seeded prompt instructs the agent.
- **Placeholders** in every prompt: `{summary}` (the Explore focus), `{brief}`, `{files}`. (`{key}`/`{url}` render empty in Explore, unchanged.)
- **Fixed action set of four.** Canonical ids `jiraTicket`, `knowledge`, `debug`, `general` — used verbatim as the `exploreMode` enum values and the `exploreSlackDm` keys.
- **Slack checkboxes default OFF** for all actions.
- **package.json setting defaults MUST match the `config.ts` default constants verbatim** — the code uses the constant as the fallback and VS Code shows the schema default; drift between them is a bug.
- **`agentFlow.explorePrompt` stays as a (deprecated) setting** so a user's existing value is still valid config and can be read for migration; it is removed only from the internal `AgentFlowConfig` type.
- **Verification per task:** `npm test` (vitest) AND `npm run typecheck` (tsc covers `src` + `test`) must both pass before committing.
- **Commit messages** end with the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File Structure

- **Modify `package.json`** (`contributes.configuration.properties`): add `agentFlow.exploreMode`, `agentFlow.explorePrompts.{jiraTicket,knowledge,debug,general}`, `agentFlow.exploreSlackDm`; add a deprecation message to `agentFlow.explorePrompt`. — *Task 1*
- **Modify `src/config.ts`**: new default-prompt constants, `ExploreAction` interface, `EXPLORE_ACTION_DEFS`, `explicitConfigValue()` helper, and `exploreActions`/`exploreMode` on `AgentFlowConfig`; later remove the `explorePrompt` field. — *Tasks 1 & 3*
- **Modify `test/_mocks/vscode.ts`**: add `inspect` to the config stub (migration needs it). — *Task 1*
- **Modify `test/unit/config.test.ts`**: new "explore actions" describe block. — *Task 1*
- **Modify `src/engine/prompt.ts`**: add `SLACK_DM_SENTENCE` + `injectSlackDm()`. — *Task 2*
- **Modify `test/unit/engine/prompt.test.ts`**: new "injectSlackDm" describe block. — *Task 2*
- **Modify `src/tasksView.ts`**: import `injectSlackDm` + `ExploreAction`; add `chooseExploreAction()`; rewrite the body of `explore()`. — *Task 3*
- **Modify `test/unit/tasksView.test.ts`**: update the `CFG` fixture; add an "explore" describe block. — *Tasks 1 (fixture fields) & 3 (tests)*

---

### Task 1: Config layer — settings, constants, and `getConfig` assembly

**Files:**
- Modify: `src/config.ts`
- Modify: `package.json` (`contributes.configuration.properties`)
- Modify: `test/_mocks/vscode.ts` (`makeConfig`)
- Modify: `test/unit/config.test.ts`
- Modify: `test/unit/tasksView.test.ts` (`CFG` fixture — add the two new required fields so `tsc` stays green)

**Interfaces:**
- Produces:
  - `interface ExploreAction { id: string; label: string; prompt: string; slackDm: boolean }`
  - `AgentFlowConfig.exploreActions: ExploreAction[]` (order: `jiraTicket`, `knowledge`, `debug`, `general`)
  - `AgentFlowConfig.exploreMode: string` (default `"ask"`)
  - exported constants `DEFAULT_EXPLORE_JIRA_TICKET_PROMPT`, `DEFAULT_EXPLORE_DEBUG_PROMPT`, `DEFAULT_EXPLORE_GENERAL_PROMPT` (and the existing `DEFAULT_EXPLORE_PROMPT` = knowledge default)
- Consumes: nothing from other tasks.

- [ ] **Step 1: Add `inspect` to the vscode config mock**

In `test/_mocks/vscode.ts`, extend `makeConfig()` so an explicitly-set key reports a value (models "user set this"); an unset key reports none:

```ts
function makeConfig() {
  return {
    get: vi.fn((key: string, def?: unknown) => (key in configStore ? configStore[key] : def)),
    update: vi.fn(async (key: string, value: unknown, _target?: unknown): Promise<void> => {
      configStore[key] = value;
    }),
    inspect: vi.fn((key: string) =>
      key in configStore ? { key, globalValue: configStore[key] } : { key },
    ),
  };
}
```

- [ ] **Step 2: Write the failing config tests**

Add to `test/unit/config.test.ts`. First extend the import on line 4:

```ts
import {
  expandHome,
  getConfig,
  DEFAULT_PROMPT_MODES,
  DEFAULT_EXPLORE_PROMPT,
  DEFAULT_EXPLORE_JIRA_TICKET_PROMPT,
  DEFAULT_EXPLORE_DEBUG_PROMPT,
  DEFAULT_EXPLORE_GENERAL_PROMPT,
} from "../../src/config";
```

Then append this describe block:

```ts
describe("getConfig — explore actions", () => {
  it("defaults to four actions with built-in labels and default prompts, all Slack-off", () => {
    expect(getConfig().exploreActions).toEqual([
      { id: "jiraTicket", label: "Open a Jira ticket", prompt: DEFAULT_EXPLORE_JIRA_TICKET_PROMPT, slackDm: false },
      { id: "knowledge", label: "Enhance knowledge / flow", prompt: DEFAULT_EXPLORE_PROMPT, slackDm: false },
      { id: "debug", label: "Debug", prompt: DEFAULT_EXPLORE_DEBUG_PROMPT, slackDm: false },
      { id: "general", label: "General", prompt: DEFAULT_EXPLORE_GENERAL_PROMPT, slackDm: false },
    ]);
  });

  it("defaults exploreMode to 'ask' and honors a configured value", () => {
    expect(getConfig().exploreMode).toBe("ask");
    setConfig({ exploreMode: "debug" });
    expect(getConfig().exploreMode).toBe("debug");
  });

  it("uses a per-action prompt override from settings", () => {
    setConfig({ "explorePrompts.debug": "repro {summary}{files}" });
    expect(getConfig().exploreActions.find((x) => x.id === "debug")?.prompt).toBe("repro {summary}{files}");
  });

  it("flips slackDm per action id and ignores non-boolean values", () => {
    setConfig({ exploreSlackDm: { jiraTicket: true, knowledge: "yes", debug: 1 } });
    const byId = Object.fromEntries(getConfig().exploreActions.map((x) => [x.id, x.slackDm]));
    expect(byId).toEqual({ jiraTicket: true, knowledge: false, debug: false, general: false });
  });

  it("migrates a customized legacy explorePrompt into the knowledge action", () => {
    setConfig({ explorePrompt: "legacy explore {summary}{files}" });
    expect(getConfig().exploreActions.find((x) => x.id === "knowledge")?.prompt).toBe("legacy explore {summary}{files}");
  });

  it("prefers an explicit explorePrompts.knowledge over the legacy explorePrompt", () => {
    setConfig({ explorePrompt: "legacy {files}", "explorePrompts.knowledge": "new {files}" });
    expect(getConfig().exploreActions.find((x) => x.id === "knowledge")?.prompt).toBe("new {files}");
  });
});
```

- [ ] **Step 3: Run the config tests to verify they fail**

Run: `npx vitest run test/unit/config.test.ts`
Expected: FAIL — `DEFAULT_EXPLORE_JIRA_TICKET_PROMPT` (and siblings) are not exported; `exploreActions`/`exploreMode` are `undefined`.

- [ ] **Step 4: Add the default-prompt constants and `ExploreAction` in `src/config.ts`**

Keep the existing `DEFAULT_EXPLORE_PROMPT` (it is the `knowledge` default). Immediately after it, add:

```ts
/** Seed for the "Open a Jira ticket" action — explore, then create a ticket. */
export const DEFAULT_EXPLORE_JIRA_TICKET_PROMPT =
  'Exploration session. Focus: "{summary}". A brief listing the repos in scope is at {brief}. ' +
  "Dig into this, then draft and create a Jira ticket that captures what you found — a clear problem " +
  "statement, the affected code paths, and a proposed approach. Add the `claude-code` label to the ticket, " +
  "and share the ticket key and URL when you're done.{files}";

/** Seed for the "Debug" action — reproduce, root-cause, propose a fix. */
export const DEFAULT_EXPLORE_DEBUG_PROMPT =
  'Debugging session — no Jira ticket yet. Focus: "{summary}". A brief listing the repos in scope is at {brief}. ' +
  "Reproduce the problem, trace it to a root cause, and explain what's going wrong with evidence from the code. " +
  "Propose a fix, but don't change code unless I ask.{files}";

/** Seed for the "General" action — open-ended working session. */
export const DEFAULT_EXPLORE_GENERAL_PROMPT =
  'Working session. Focus: "{summary}". A brief listing the repos in scope is at {brief}. ' +
  "Help me make progress on this — ask what I need if it's unclear before diving in. " +
  "Don't change code unless I ask.{files}";

/** One Explore action as seen by the flow: id + picker label + resolved prompt + Slack toggle. */
export interface ExploreAction {
  id: string;
  label: string;
  prompt: string;
  slackDm: boolean;
}

/** Fixed built-in actions. `settingKey` is the multiline string setting holding the prompt. */
const EXPLORE_ACTION_DEFS: { id: string; label: string; settingKey: string; defaultPrompt: string }[] = [
  { id: "jiraTicket", label: "Open a Jira ticket", settingKey: "explorePrompts.jiraTicket", defaultPrompt: DEFAULT_EXPLORE_JIRA_TICKET_PROMPT },
  { id: "knowledge", label: "Enhance knowledge / flow", settingKey: "explorePrompts.knowledge", defaultPrompt: DEFAULT_EXPLORE_PROMPT },
  { id: "debug", label: "Debug", settingKey: "explorePrompts.debug", defaultPrompt: DEFAULT_EXPLORE_DEBUG_PROMPT },
  { id: "general", label: "General", settingKey: "explorePrompts.general", defaultPrompt: DEFAULT_EXPLORE_GENERAL_PROMPT },
];
```

- [ ] **Step 5: Extend `AgentFlowConfig` and add the `explicitConfigValue` helper**

In the `AgentFlowConfig` interface, **keep** `explorePrompt: string;` for now and add:

```ts
  exploreMode: string; // "ask", or an ExploreAction id
  exploreActions: ExploreAction[];
```

Add this module-level helper (near `expandHome`):

```ts
/** The user-set value of a setting (folder > workspace > global), or undefined if
 * only the schema default applies. Used to detect an explicit legacy value for migration. */
function explicitConfigValue<T>(c: vscode.WorkspaceConfiguration, key: string): T | undefined {
  const i = c.inspect<T>(key);
  return (i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue) as T | undefined;
}
```

- [ ] **Step 6: Assemble `exploreActions` + `exploreMode` in `getConfig`**

Inside `getConfig()`, before the `return`, add:

```ts
  const slackRaw = c.get<Record<string, unknown>>("exploreSlackDm") ?? {};
  const resolvePrompt = (def: { id: string; settingKey: string; defaultPrompt: string }): string => {
    if (def.id === "knowledge") {
      // Migrate a customized legacy explorePrompt into the knowledge action.
      return (
        explicitConfigValue<string>(c, def.settingKey) ??
        explicitConfigValue<string>(c, "explorePrompt") ??
        def.defaultPrompt
      );
    }
    return c.get<string>(def.settingKey) || def.defaultPrompt;
  };
  const exploreActions: ExploreAction[] = EXPLORE_ACTION_DEFS.map((def) => ({
    id: def.id,
    label: def.label,
    prompt: resolvePrompt(def),
    slackDm: (slackRaw as Record<string, unknown>)[def.id] === true,
  }));
```

Then add these two entries to the returned object (keep `explorePrompt` as-is for now):

```ts
    exploreMode: c.get<string>("exploreMode") || "ask",
    exploreActions,
```

- [ ] **Step 7: Add the two new fields to the test `CFG` fixture (keeps `tsc` green)**

In `test/unit/tasksView.test.ts`, in the `CFG` object (around line 23-40), leave `explorePrompt` for now and add:

```ts
  exploreMode: "ask",
  exploreActions: [
    { id: "jiraTicket", label: "Open a Jira ticket", prompt: "JT {summary}{files}", slackDm: false },
    { id: "knowledge", label: "Enhance knowledge / flow", prompt: "Explore {summary}{files}", slackDm: false },
    { id: "debug", label: "Debug", prompt: "DBG {summary}{files}", slackDm: false },
    { id: "general", label: "General", prompt: "GEN {summary}{files}", slackDm: false },
  ],
```

- [ ] **Step 8: Add the settings to `package.json`**

In `contributes.configuration.properties`, add a `markdownDeprecationMessage` to the existing `agentFlow.explorePrompt` (leave its `type`/`default`/`markdownDescription`):

```json
        "agentFlow.explorePrompt": {
          "type": "string",
          "editPresentation": "multilineText",
          "markdownDeprecationMessage": "Deprecated — use the per-action prompts under `agentFlow.explorePrompts`. If you customized this, its value is migrated into the **Enhance knowledge / flow** action automatically.",
          "markdownDescription": "Prompt seeded when you start an **Explore** session (no ticket). Placeholders: `{summary}` (your focus), `{brief}`, `{files}`.",
          "default": "Exploration session — no Jira ticket yet. Focus: \"{summary}\". A brief listing the repos in scope is at {brief}. Help me understand how this works: map the relevant code paths, explain the flow, and flag anything surprising or worth a follow-up ticket. Don't change code unless I ask.{files}"
        },
```

Then add the new properties (defaults MUST match the `config.ts` constants verbatim):

```json
        "agentFlow.exploreMode": {
          "type": "string",
          "enum": ["ask", "jiraTicket", "knowledge", "debug", "general"],
          "enumDescriptions": [
            "Choose an action each time you click Explore",
            "Open a Jira ticket — explore, then create a ticket capturing the findings",
            "Enhance knowledge / flow — map the code paths and explain how it works",
            "Debug — reproduce and root-cause a problem",
            "General — open-ended working session"
          ],
          "default": "ask",
          "markdownDescription": "Which Explore action to start. `ask` shows a picker each time; otherwise that action's prompt is seeded directly. Prompts are editable under `agentFlow.explorePrompts`."
        },
        "agentFlow.explorePrompts.jiraTicket": {
          "type": "string",
          "editPresentation": "multilineText",
          "markdownDescription": "Prompt seeded for the **Open a Jira ticket** Explore action. Placeholders: `{summary}` (your focus), `{brief}`, `{files}`.",
          "default": "Exploration session. Focus: \"{summary}\". A brief listing the repos in scope is at {brief}. Dig into this, then draft and create a Jira ticket that captures what you found — a clear problem statement, the affected code paths, and a proposed approach. Add the `claude-code` label to the ticket, and share the ticket key and URL when you're done.{files}"
        },
        "agentFlow.explorePrompts.knowledge": {
          "type": "string",
          "editPresentation": "multilineText",
          "markdownDescription": "Prompt seeded for the **Enhance knowledge / flow** Explore action. Placeholders: `{summary}` (your focus), `{brief}`, `{files}`.",
          "default": "Exploration session — no Jira ticket yet. Focus: \"{summary}\". A brief listing the repos in scope is at {brief}. Help me understand how this works: map the relevant code paths, explain the flow, and flag anything surprising or worth a follow-up ticket. Don't change code unless I ask.{files}"
        },
        "agentFlow.explorePrompts.debug": {
          "type": "string",
          "editPresentation": "multilineText",
          "markdownDescription": "Prompt seeded for the **Debug** Explore action. Placeholders: `{summary}` (your focus), `{brief}`, `{files}`.",
          "default": "Debugging session — no Jira ticket yet. Focus: \"{summary}\". A brief listing the repos in scope is at {brief}. Reproduce the problem, trace it to a root cause, and explain what's going wrong with evidence from the code. Propose a fix, but don't change code unless I ask.{files}"
        },
        "agentFlow.explorePrompts.general": {
          "type": "string",
          "editPresentation": "multilineText",
          "markdownDescription": "Prompt seeded for the **General** Explore action. Placeholders: `{summary}` (your focus), `{brief}`, `{files}`.",
          "default": "Working session. Focus: \"{summary}\". A brief listing the repos in scope is at {brief}. Help me make progress on this — ask what I need if it's unclear before diving in. Don't change code unless I ask.{files}"
        },
        "agentFlow.exploreSlackDm": {
          "type": "object",
          "markdownDescription": "Per-action: when checked, the seeded prompt asks the agent to send you a Slack DM summarizing the session when it ends. Off by default. (The agent does this via its own Slack connector.)",
          "properties": {
            "jiraTicket": { "type": "boolean", "description": "Open a Jira ticket" },
            "knowledge": { "type": "boolean", "description": "Enhance knowledge / flow" },
            "debug": { "type": "boolean", "description": "Debug" },
            "general": { "type": "boolean", "description": "General" }
          },
          "additionalProperties": { "type": "boolean" },
          "default": { "jiraTicket": false, "knowledge": false, "debug": false, "general": false }
        },
```

- [ ] **Step 9: Run tests + typecheck to verify green**

Run: `npx vitest run test/unit/config.test.ts && npm run typecheck`
Expected: config tests PASS; `tsc` reports no errors (the `CFG` fixture now satisfies `AgentFlowConfig`).

- [ ] **Step 10: Run the full suite**

Run: `npm test`
Expected: all files pass (378 prior tests + the new config tests).

- [ ] **Step 11: Commit**

```bash
git add src/config.ts package.json test/_mocks/vscode.ts test/unit/config.test.ts test/unit/tasksView.test.ts
git commit -m "$(cat <<'EOF'
feat(config): four configurable Explore actions with per-action prompts + Slack toggle

Add exploreMode, explorePrompts.{jiraTicket,knowledge,debug,general} (multiline,
settings-page-editable), and exploreSlackDm (per-action checkboxes). getConfig
assembles ExploreAction[]; legacy explorePrompt migrates into the knowledge action.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `injectSlackDm` prompt helper

**Files:**
- Modify: `src/engine/prompt.ts`
- Modify: `test/unit/engine/prompt.test.ts`

**Interfaces:**
- Produces:
  - `const SLACK_DM_SENTENCE: string`
  - `function injectSlackDm(template: string, enabled: boolean): string` — when enabled, inserts `" " + SLACK_DM_SENTENCE` immediately before the first `{files}` placeholder (or appends it if there is none); returns the template unchanged when disabled.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Write the failing tests**

In `test/unit/engine/prompt.test.ts`, extend the import and add a describe block:

```ts
import { renderPrompt, injectSlackDm, SLACK_DM_SENTENCE, type PromptVars } from "../../../src/engine/prompt";
```

```ts
describe("injectSlackDm", () => {
  it("returns the template unchanged when disabled", () => {
    expect(injectSlackDm("do it{files}", false)).toBe("do it{files}");
  });

  it("inserts the Slack sentence just before a trailing {files}", () => {
    expect(injectSlackDm("do it{files}", true)).toBe(`do it ${SLACK_DM_SENTENCE}{files}`);
  });

  it("appends the Slack sentence when there is no {files} placeholder", () => {
    expect(injectSlackDm("do it", true)).toBe(`do it ${SLACK_DM_SENTENCE}`);
  });

  it("inserts before the first {files} only", () => {
    expect(injectSlackDm("a{files}b{files}", true)).toBe(`a ${SLACK_DM_SENTENCE}{files}b{files}`);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/prompt.test.ts`
Expected: FAIL — `injectSlackDm` / `SLACK_DM_SENTENCE` are not exported.

- [ ] **Step 3: Implement the helper**

Append to `src/engine/prompt.ts`:

```ts
/** Sentence appended to a seeded Explore prompt when the action's Slack-DM toggle
 * is on. The agent performs the DM via its own Slack connector. */
export const SLACK_DM_SENTENCE =
  "When you're done, send me a direct message on Slack summarizing the session (and link any Jira ticket you opened).";

/** Append the Slack-DM instruction to a prompt template. Placed just before the
 * first {files} placeholder so the relevant-files block stays at the very end;
 * appended to the end when the template has no {files}. A no-op when disabled. */
export function injectSlackDm(template: string, enabled: boolean): string {
  if (!enabled) return template;
  const sentence = " " + SLACK_DM_SENTENCE;
  return template.includes("{files}")
    ? template.replace("{files}", sentence + "{files}")
    : template + sentence;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/prompt.test.ts`
Expected: PASS (all renderPrompt tests + the four injectSlackDm tests).

- [ ] **Step 5: Commit**

```bash
git add src/engine/prompt.ts test/unit/engine/prompt.test.ts
git commit -m "$(cat <<'EOF'
feat(prompt): add injectSlackDm to append the Slack-DM instruction before {files}

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Wire the actions into the Explore flow

**Files:**
- Modify: `src/tasksView.ts` (imports; new `chooseExploreAction`; rewrite `explore()` body)
- Modify: `src/config.ts` (remove the now-unused `explorePrompt` field from `AgentFlowConfig` + `getConfig`)
- Modify: `test/unit/tasksView.test.ts` (drop `explorePrompt` from `CFG`; add an "explore" describe block)

**Interfaces:**
- Consumes:
  - `ExploreAction`, `AgentFlowConfig.exploreActions`, `AgentFlowConfig.exploreMode` (Task 1)
  - `injectSlackDm`, `SLACK_DM_SENTENCE` (Task 2)
- Produces: no new exports (behavioral change to `TasksViewProvider.explore`).

- [ ] **Step 1: Write the failing explore tests**

In `test/unit/tasksView.test.ts`, extend the imports and add a describe block. Add the import near the other `src` imports:

```ts
import { SLACK_DM_SENTENCE } from "../../src/engine/prompt";
```

```ts
describe("explore", () => {
  it("prompts for an action when exploreMode is 'ask' and seeds the chosen action's prompt", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "ask" });
    const repos = mkRepos(["account-service", "centaur"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("retry logic");
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ action: CFG.exploreActions[2] } as never) // action picker → Debug
      .mockResolvedValueOnce([{ repo: repos[0] }, { repo: repos[1] }] as never); // repo picker
    const { send } = setup();
    await send({ type: "explore" });
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ promptTemplate: "DBG {summary}{files}" }),
    );
  });

  it("uses the configured action directly and skips the action picker", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "jiraTicket" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("focus");
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never); // only the repo picker
    const { send } = setup();
    await send({ type: "explore" });
    expect(window.showQuickPick).toHaveBeenCalledTimes(1);
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ promptTemplate: "JT {summary}{files}" }),
    );
  });

  it("falls back to the action picker when the configured exploreMode id is unknown", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "bogus" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("focus");
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ action: CFG.exploreActions[3] } as never) // picker → General
      .mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { send } = setup();
    await send({ type: "explore" });
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ promptTemplate: "GEN {summary}{files}" }),
    );
  });

  it("aborts before opening a workspace when the action picker is cancelled", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "ask" });
    vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined); // cancel action pick
    const { send } = setup();
    await send({ type: "explore" });
    expect(window.showInputBox).not.toHaveBeenCalled();
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it("appends the Slack-DM sentence before {files} when the action's slackDm is on", async () => {
    const actions = CFG.exploreActions.map((a) => (a.id === "jiraTicket" ? { ...a, slackDm: true } : a));
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "jiraTicket", exploreActions: actions });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("focus");
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { send } = setup();
    await send({ type: "explore" });
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ promptTemplate: `JT {summary} ${SLACK_DM_SENTENCE}{files}` }),
    );
  });
});
```

- [ ] **Step 2: Run the explore tests to verify they fail**

Run: `npx vitest run test/unit/tasksView.test.ts -t explore`
Expected: FAIL — current `explore()` ignores `exploreActions`/`exploreMode` and seeds `cfg.explorePrompt`, so the action picker isn't shown and `promptTemplate` is wrong.

- [ ] **Step 3: Update `src/tasksView.ts` imports**

Change the config import and add the prompt import:

```ts
import { getConfig, AgentFlowConfig, ExploreAction } from "./config";
import { injectSlackDm } from "./engine/prompt";
```

- [ ] **Step 4: Add the `chooseExploreAction` helper**

Add this private method to `TasksViewProvider` (near `chooseWorkspaceMode`):

```ts
  /** Pick which Explore action to run. Uses cfg.exploreMode directly when it names a
   * known action; otherwise ("ask" or an unknown id) shows a QuickPick. Returns
   * undefined when the user cancels the picker. */
  private async chooseExploreAction(cfg: AgentFlowConfig): Promise<ExploreAction | undefined> {
    const configured = cfg.exploreActions.find((a) => a.id === cfg.exploreMode);
    if (configured) return configured;
    const pick = await vscode.window.showQuickPick(
      cfg.exploreActions.map((a) => ({ label: a.label, action: a })),
      { title: "Explore — what kind of session?", placeHolder: "Pick an action", ignoreFocusOut: true },
    );
    return pick?.action;
  }
```

- [ ] **Step 5: Rewrite the body of `explore()`**

Replace the current `explore()` implementation (the method body from `const cfg = getConfig();` through the closing brace) with:

```ts
  public async explore(): Promise<void> {
    const cfg = getConfig();
    const repos = discoverRepos(cfg.reposRoot, cfg.repoBlocklist);
    if (repos.length === 0) {
      this.toast("error", `No repos found under ${cfg.reposRoot}. Check agentFlow.reposRoot.`);
      return;
    }

    const action = await this.chooseExploreAction(cfg);
    if (!action) return; // picker cancelled

    const raw = await vscode.window.showInputBox({
      title: "Explore — what do you want to dig into?",
      prompt: "A focus for the session (optional). A Jira ticket can come later.",
      placeHolder: "e.g. how the aggregator retries failed scans",
      ignoreFocusOut: true,
    });
    if (raw === undefined) return; // cancelled (empty is allowed → generic focus)
    const topic = raw.trim() || "Codebase exploration";

    const picks = await vscode.window.showQuickPick<vscode.QuickPickItem & { repo: ServiceRef }>(
      repos.map((r) => ({
        label: r.name,
        detail: r.isGit ? r.path : `${r.path}  (not a git repo)`,
        repo: r,
      })),
      {
        canPickMany: true,
        title: "Explore — pick the repos to open",
        placeHolder: "Space to toggle · Enter to open",
        ignoreFocusOut: true,
      },
    );
    if (!picks || picks.length === 0) return;
    const services = picks.map((p) => p.repo);

    const mode = await this.chooseWorkspaceMode(services.length, cfg.workspaceMode, "Explore");
    if (!mode) return;

    const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "explore";
    const planMd = `## Exploration: ${topic}\n\n_No Jira ticket yet — a knowledge/exploration session. If it turns into work, open a ticket afterwards._`;
    const result = await openWorkspace({
      ticket: { key: `explore-${slug}`, summary: topic, url: "" },
      planMd,
      descriptionText: "",
      services,
      mode,
      promptTemplate: injectSlackDm(action.prompt, action.slackDm),
      workspaceDir: cfg.workspaceDir,
      seedAgent: cfg.seedAgent,
    });

    const where = result.workspaceFile
      ? `workspace ${result.workspaceFile.split("/").pop()}`
      : `${result.opened.length} window(s)`;
    const seeded = cfg.seedAgent ? " Claude Code pre-seeded — press Enter to start." : "";
    this.toast("success", `Opened ${where} to explore. Brief seeded in each repo.${seeded}`);
  }
```

- [ ] **Step 6: Remove the now-unused `explorePrompt` field from `src/config.ts`**

Delete `explorePrompt: string;` from the `AgentFlowConfig` interface and delete the `explorePrompt: c.get<string>("explorePrompt") || DEFAULT_EXPLORE_PROMPT,` line from the returned object in `getConfig`. Keep `DEFAULT_EXPLORE_PROMPT` (still the `knowledge` default and migration fallback).

- [ ] **Step 7: Drop `explorePrompt` from the test `CFG` fixture**

In `test/unit/tasksView.test.ts`, remove the `explorePrompt: "Explore {summary}{files}",` line from `CFG` (the `exploreActions`/`exploreMode` fields added in Task 1 remain).

- [ ] **Step 8: Run tests + typecheck to verify green**

Run: `npx vitest run test/unit/tasksView.test.ts && npm run typecheck`
Expected: all tasksView tests PASS (including the new explore block); `tsc` reports no errors (no remaining reference to `explorePrompt`).

- [ ] **Step 9: Run the full suite**

Run: `npm test`
Expected: every test file passes.

- [ ] **Step 10: Commit**

```bash
git add src/tasksView.ts src/config.ts test/unit/tasksView.test.ts
git commit -m "$(cat <<'EOF'
feat(explore): pick an action on Explore and seed its prompt (+ optional Slack DM)

Explore now offers the four configured actions via a QuickPick (or uses the
pinned exploreMode), seeds that action's prompt, and appends the Slack-DM
instruction when the action's checkbox is on. Removes the unused explorePrompt
field from AgentFlowConfig.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**1. Spec coverage:**
- Four actions, fixed set, ids `jiraTicket|knowledge|debug|general` → Task 1 (`EXPLORE_ACTION_DEFS`).
- Each prompt editable in settings page (multilineText) → Task 1 (`explorePrompts.*`).
- `exploreMode` dropdown, default `ask` → Task 1.
- Per-action Slack checkboxes, default off, object keyed by id → Task 1 (`exploreSlackDm`).
- Agent does ticket/DM via prompt (no integration) → default prompts (Task 1) + `injectSlackDm` (Task 2); no Jira/Slack code added.
- `explorePrompt` deprecated + migrated into `knowledge` → Task 1 (deprecation message + `resolvePrompt` migration via `explicitConfigValue`).
- Action QuickPick at front of `explore()`; configured id skips it; unknown id falls back → Task 3 (`chooseExploreAction` + tests).
- Slack sentence inserted before `{files}` → Task 2 helper + Task 3 test.
- Webview/`{ type: "explore" }` unchanged → no webview/types task; confirmed untouched.

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows complete code and exact commands.

**3. Type consistency:** `ExploreAction { id,label,prompt,slackDm }` defined in Task 1 and consumed unchanged in Task 3. `injectSlackDm(template, enabled)` / `SLACK_DM_SENTENCE` defined in Task 2, imported by Task 3 test and `tasksView.ts`. `chooseExploreAction(cfg: AgentFlowConfig): Promise<ExploreAction | undefined>` consistent between definition and call. `exploreMode`/`exploreActions` added to `AgentFlowConfig` in Task 1 and to `CFG` in the same task (keeps `tsc` green); `explorePrompt` removed from both interface and fixture together in Task 3.
