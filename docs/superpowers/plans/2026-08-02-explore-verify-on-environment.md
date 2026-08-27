# Explore "Verify on an environment" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fifth Explore action, `verify`, that asks which environment to verify a feature on (on top of the repos the flow already picks) and seeds an observability-led, read-only verification prompt.

**Architecture:** Everything stays in the prompt layer, as with the existing four Explore actions. `config.ts` gains a `DEFAULT_ENVIRONMENTS` list, a `verify` entry in `EXPLORE_ACTION_DEFS` carrying `needsEnv: true`, and an `environments: string[]` config field. `engine/prompt.ts` gains a pure `applyExploreVars()` that fills `{env}` and `{services}` — pre-substitution just before `openWorkspace`, the same technique `engine/review/launch.ts` uses for `{repo}`/`{number}`/`{author}`; `renderPrompt` and `PromptVars` are untouched. `tasksView.explore()` runs an environment QuickPick only for actions with `needsEnv`. The extension never touches an environment itself — the agent does that with its own tools.

**Tech Stack:** TypeScript, VS Code extension API, vitest (+ the hand-written `vscode` mock at `test/_mocks/vscode.ts`), esbuild.

## Global Constraints

- **This repo is public OSS.** No organization-specific environment names, tenant ids, vendor/MCP tool names, or internal URLs in any default, description, or prompt. Default environments are `dev`, `staging`, `production`; the prompt says "the observability tools available to you".
- **Settings must be editable in the VS Code settings page.** Prompts are `string` + `"editPresentation": "multilineText"`; the environment list is `array` of `string`. Never an array-of-objects — VS Code renders those as a bare "Edit in settings.json" link.
- **Manifest defaults must be byte-identical to their `config.ts` constants.** `test/unit/config.test.ts` asserts this. Drift makes `explore_prompts_customized` fire for every user.
- **`EXPLORE_MODES` in `src/telemetry/settingsSnapshot.ts` must equal `agentFlow.exploreMode`'s manifest `enum`.** A parity test in `test/unit/telemetry/settingsSnapshot.test.ts` enforces it — the manifest and this constant change in the *same* task or the suite goes red.
- **Telemetry never transmits user-authored text.** Environment names contribute at most a boolean.
- **Action ids are camelCase and canonical** — the same string is the `exploreMode` enum value, the `exploreSlackDm` key, and the `explorePrompts.*` suffix.
- Existing behavior for the four current actions must not change: same picker order, same focus-box copy, same `explore-<slug>` ticket key, same toast text.
- Test isolation is global: `test/_setup.ts` calls `resetVscodeMocks()` in a `beforeEach`, so `setConfig({...})` inside a test never leaks. `clearMocks: true` clears call history between tests.
- Verification commands: `npm test` (vitest), `npm run typecheck` (tsc --noEmit). Both must pass before every commit.

## File Structure

| File | Responsibility | Task |
|------|----------------|------|
| `src/config.ts` | `DEFAULT_ENVIRONMENTS`, `readEnvironments()`, `environments` on `AgentFlowConfig`; `DEFAULT_EXPLORE_VERIFY_PROMPT`, `needsEnv` on `ExploreAction`, fifth action def | 1, 3 |
| `package.json` | `agentFlow.environments`; `agentFlow.explorePrompts.verify`; `verify` in `exploreMode` enum and `exploreSlackDm` | 1, 3 |
| `src/engine/prompt.ts` | `applyExploreVars()` — pure `{env}`/`{services}` substitution | 2 |
| `src/tasksView.ts` | `chooseEnvironment()`, per-action focus-box copy + validation, env-aware session identity, template assembly | 4 |
| `src/telemetry/settingsSnapshot.ts` | `EXPLORE_MODES` gains `verify`; `environments_customized` | 3, 5 |
| `src/telemetry/events.ts` | `explore_mode` union widens; `environments_customized` on `SettingsSnapshot` | 3, 5 |
| `README.md`, `CHANGELOG.md`, `docs/TELEMETRY.md` | User- and analytics-facing docs | 5 |
| `test/unit/config.test.ts` | environments normalization, five actions, manifest parity | 1, 3 |
| `test/unit/engine/prompt.test.ts` | `applyExploreVars` | 2 |
| `test/unit/tasksView.test.ts` | `CFG` fixture upkeep + the verify flow | 1, 3, 4 |
| `test/unit/telemetry/settingsSnapshot.test.ts` | `verify` not `invalid`; `environments_customized` | 3, 5 |

No change to `src/types.ts` or any webview file — the Explore button still posts `{ type: "explore" }`.

---

### Task 1: The `environments` setting

Adds the configurable environment list. Nothing consumes it yet — that comes in Task 4.

**Files:**
- Modify: `src/config.ts` (constant + reader + `AgentFlowConfig` field + `getConfig()`)
- Modify: `package.json` (`contributes.configuration.properties`)
- Test: `test/unit/config.test.ts`
- Modify (typecheck upkeep): `test/unit/tasksView.test.ts:91-129` — the `CFG` fixture

**Interfaces:**
- Consumes: nothing.
- Produces: `DEFAULT_ENVIRONMENTS: string[]` exported from `src/config.ts`; `AgentFlowConfig.environments: string[]`.

- [ ] **Step 1: Write the failing tests**

Add this `describe` to `test/unit/config.test.ts`, immediately after the `describe("getConfig — explore actions", ...)` block (which currently ends at line 271):

```ts
describe("getConfig — environments", () => {
  it("defaults to the shipped environment list", () => {
    expect(getConfig().environments).toEqual(["dev", "staging", "production"]);
  });

  it("trims, drops blanks and non-strings, and de-duplicates preserving order", () => {
    setConfig({ environments: ["  prod ", "dev", "", "prod", 7, null, "dev"] });
    expect(getConfig().environments).toEqual(["prod", "dev"]);
  });

  it("falls back to the defaults when the list holds nothing usable", () => {
    setConfig({ environments: ["", "   "] });
    expect(getConfig().environments).toEqual(DEFAULT_ENVIRONMENTS);
  });

  it("falls back to the defaults when the setting is not an array", () => {
    setConfig({ environments: "staging" });
    expect(getConfig().environments).toEqual(DEFAULT_ENVIRONMENTS);
  });

  it("hands back a copy, so a caller cannot mutate the shipped defaults", () => {
    getConfig().environments.push("mutated");
    expect(DEFAULT_ENVIRONMENTS).toEqual(["dev", "staging", "production"]);
  });
});
```

Add this assertion inside the existing `describe("package.json ⇄ config constants", ...)` block (starts at line 379):

```ts
  it("keeps the environments schema default equal to DEFAULT_ENVIRONMENTS", () => {
    expect(props["agentFlow.environments"].default).toEqual(DEFAULT_ENVIRONMENTS);
  });
```

Add `DEFAULT_ENVIRONMENTS` to the existing `from "../../src/config"` import list at the top of the file (lines 4-14).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/config.test.ts`
Expected: FAIL — `DEFAULT_ENVIRONMENTS` is not exported (the import resolves to `undefined`, and `getConfig().environments` is `undefined`).

- [ ] **Step 3: Implement the config side**

In `src/config.ts`, add the constant just above the `ExploreAction` interface (currently line 93):

```ts
/** Environments offered when an Explore action asks which environment to verify
 * against. A bare string list — not an array of objects — so VS Code's settings
 * page renders it as an editable list widget; the same constraint that made each
 * explore prompt its own setting. */
export const DEFAULT_ENVIRONMENTS = ["dev", "staging", "production"];
```

Add the reader next to `explicitConfigValue` (currently line 203):

```ts
/** Trimmed, de-duplicated, non-empty environment names. Falls back to the shipped
 * defaults when the setting is absent, isn't an array, or holds nothing usable —
 * the same empty-means-default behavior `promptModes` has. A `Set` gives dedupe
 * with first-seen order for free. */
function readEnvironments(c: vscode.WorkspaceConfiguration): string[] {
  const raw = c.get<unknown[]>("environments");
  if (!Array.isArray(raw)) return [...DEFAULT_ENVIRONMENTS];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const trimmed = v.trim();
    if (trimmed) seen.add(trimmed);
  }
  return seen.size ? [...seen] : [...DEFAULT_ENVIRONMENTS];
}
```

Add the field to `AgentFlowConfig`, directly under `exploreActions: ExploreAction[];` (line 161):

```ts
  // Environments offered by Explore actions that verify against a live env.
  environments: string[];
```

And in the object `getConfig()` returns, directly under `exploreActions,` (line 248):

```ts
    environments: readEnvironments(c),
```

- [ ] **Step 4: Add the setting to the manifest**

In `package.json`, insert this property immediately after the `"agentFlow.exploreSlackDm"` block (which ends with its `"default"` object, before `"agentFlow.prReviewStatus"`):

```json
        "agentFlow.environments": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "uniqueItems": true,
          "default": [
            "dev",
            "staging",
            "production"
          ],
          "markdownDescription": "Environments offered when an Explore action asks which environment to verify against. The picker always also offers **Custom…**, so a one-off environment doesn't need to be added here first."
        },
```

- [ ] **Step 5: Keep the tasksView test fixture type-checking**

`AgentFlowConfig` gained a required field, so the `CFG` fixture in `test/unit/tasksView.test.ts` no longer satisfies it. Add this line directly under `exploreActions: [...],` (after line 110):

```ts
  environments: ["dev", "staging", "production"],
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS — all suites green, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts package.json test/unit/config.test.ts test/unit/tasksView.test.ts
git commit -m "feat(config): add the agentFlow.environments setting"
```

---

### Task 2: `applyExploreVars` — `{env}` / `{services}` substitution

A pure function, testable on its own. Nothing calls it until Task 4.

**Files:**
- Modify: `src/engine/prompt.ts`
- Test: `test/unit/engine/prompt.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `applyExploreVars(template: string, vars: { env?: string; services: string }): string`, exported from `src/engine/prompt.ts`.

- [ ] **Step 1: Write the failing tests**

Append this `describe` to the end of `test/unit/engine/prompt.test.ts`:

```ts
describe("applyExploreVars", () => {
  it("fills {env} and {services}", () => {
    expect(applyExploreVars("check {services} on {env}", { env: "staging", services: "api, worker" })).toBe(
      "check api, worker on staging",
    );
  });

  it("replaces every occurrence of each placeholder", () => {
    expect(applyExploreVars("{env}/{services}/{env}", { env: "dev", services: "api" })).toBe("dev/api/dev");
  });

  it("leaves {env} untouched when no environment was collected", () => {
    expect(applyExploreVars("look at {services} on {env}", { services: "api" })).toBe("look at api on {env}");
  });

  it("does not interpret $ patterns in a substituted value", () => {
    expect(applyExploreVars("{env} {services}", { env: "$&", services: "$1" })).toBe("$& $1");
  });

  it("leaves the placeholders renderPrompt owns alone", () => {
    expect(applyExploreVars("{summary} {brief} {env}{files}", { env: "prod", services: "api" })).toBe(
      "{summary} {brief} prod{files}",
    );
  });

  it("returns a template with no explore placeholders verbatim", () => {
    expect(applyExploreVars("just start{files}", { env: "prod", services: "api" })).toBe("just start{files}");
  });
});
```

Add `applyExploreVars` to the existing import on line 2 of that file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/prompt.test.ts`
Expected: FAIL — `applyExploreVars is not a function`.

- [ ] **Step 3: Implement it**

Append to `src/engine/prompt.ts`:

```ts
/** Fill the Explore-only placeholders in a seeded template: `{services}` (the repos
 * picked for the session) and `{env}` (the environment, for actions that ask for
 * one). Substituted here rather than in renderPrompt so no other prompt path has to
 * supply an env it doesn't have — the same pre-substitution engine/review/launch.ts
 * does for {repo}/{number}/{author}. `{env}` is left as-is when no env was
 * collected, so a user who adds it to an action that never asks sees an unfilled
 * placeholder rather than a silent blank. Function-replacers keep `$&`/`$1` inside
 * a typed value verbatim. */
export function applyExploreVars(template: string, vars: { env?: string; services: string }): string {
  const { env, services } = vars;
  const filled = template.replace(/\{services\}/g, () => services);
  return env === undefined ? filled : filled.replace(/\{env\}/g, () => env);
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/unit/engine/prompt.test.ts && npm run typecheck`
Expected: PASS — 6 new tests green, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/engine/prompt.ts test/unit/engine/prompt.test.ts
git commit -m "feat(prompt): add applyExploreVars for {env} and {services}"
```

---

### Task 3: The `verify` action

Adds the fifth action to the config layer and the manifest. The telemetry enum ships in this task too: the moment `agentFlow.exploreMode`'s manifest `enum` grows, the `EXPLORE_MODES` parity test fails unless both move together.

**Files:**
- Modify: `src/config.ts`
- Modify: `package.json`
- Modify: `src/telemetry/settingsSnapshot.ts:34,41-43`
- Modify: `src/telemetry/events.ts:118` (the `explore_mode` union)
- Test: `test/unit/config.test.ts`, `test/unit/telemetry/settingsSnapshot.test.ts`
- Modify (typecheck upkeep): `test/unit/tasksView.test.ts:105-110` — `CFG.exploreActions`

**Interfaces:**
- Consumes: `DEFAULT_ENVIRONMENTS` (Task 1) — not directly, but the same settings block.
- Produces: `DEFAULT_EXPLORE_VERIFY_PROMPT: string`; `ExploreAction.needsEnv: boolean`; a fifth `ExploreAction` with `id: "verify"`, `label: "Verify on an environment"`, `needsEnv: true`, appended last.

- [ ] **Step 1: Write the failing tests**

In `test/unit/config.test.ts`, replace the existing `it("defaults to four actions with built-in labels and default prompts, all Slack-off", ...)` (lines 236-243) with:

```ts
  it("defaults to five actions with built-in labels and default prompts, all Slack-off", () => {
    expect(getConfig().exploreActions).toEqual([
      { id: "jiraTicket", label: "Open a Jira ticket", prompt: DEFAULT_EXPLORE_JIRA_TICKET_PROMPT, slackDm: false, needsEnv: false },
      { id: "knowledge", label: "Enhance knowledge / flow", prompt: DEFAULT_EXPLORE_PROMPT, slackDm: false, needsEnv: false },
      { id: "debug", label: "Debug", prompt: DEFAULT_EXPLORE_DEBUG_PROMPT, slackDm: false, needsEnv: false },
      { id: "general", label: "General", prompt: DEFAULT_EXPLORE_GENERAL_PROMPT, slackDm: false, needsEnv: false },
      { id: "verify", label: "Verify on an environment", prompt: DEFAULT_EXPLORE_VERIFY_PROMPT, slackDm: false, needsEnv: true },
    ]);
  });

  it("marks only the verify action as needing an environment", () => {
    const needsEnv = getConfig().exploreActions.filter((a) => a.needsEnv).map((a) => a.id);
    expect(needsEnv).toEqual(["verify"]);
  });

  it("uses a verify prompt override from settings", () => {
    setConfig({ "explorePrompts.verify": "check {summary} on {env}{files}" });
    expect(getConfig().exploreActions.find((x) => x.id === "verify")?.prompt).toBe("check {summary} on {env}{files}");
  });
```

Update the existing `it("flips slackDm per action id and ignores non-boolean values", ...)` (lines 256-260) — its `toEqual` now needs the fifth id:

```ts
  it("flips slackDm per action id and ignores non-boolean values", () => {
    setConfig({ exploreSlackDm: { jiraTicket: true, knowledge: "yes", debug: 1 } });
    const byId = Object.fromEntries(getConfig().exploreActions.map((x) => [x.id, x.slackDm]));
    expect(byId).toEqual({ jiraTicket: true, knowledge: false, debug: false, general: false, verify: false });
  });
```

Add to the existing `it("keeps each explore prompt schema default byte-identical to its config constant", ...)` (line 382):

```ts
    expect(props["agentFlow.explorePrompts.verify"].default).toBe(DEFAULT_EXPLORE_VERIFY_PROMPT);
```

Add `DEFAULT_EXPLORE_VERIFY_PROMPT` to the `from "../../src/config"` import list.

In `test/unit/telemetry/settingsSnapshot.test.ts`, add to the `describe("settingsSnapshot", ...)` block:

```ts
  it("reports a verify exploreMode as itself, not as invalid", () => {
    expect(settingsSnapshot({ ...getConfig(), exploreMode: "verify" }).explore_mode).toBe("verify");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/config.test.ts test/unit/telemetry/settingsSnapshot.test.ts`
Expected: FAIL — only four actions returned, no `needsEnv` key, `DEFAULT_EXPLORE_VERIFY_PROMPT` undefined, and `explore_mode` collapses `"verify"` to `"invalid"`.

- [ ] **Step 3: Add the prompt constant and the action def**

In `src/config.ts`, add after `DEFAULT_EXPLORE_GENERAL_PROMPT` (line 91):

```ts
/** Seed for the "Verify on an environment" action — check a feature against a live
 * environment for the picked services. Placeholders: {summary} (the feature), {env},
 * {services}, {brief}, {files}. Deliberately tool-agnostic: which observability tools
 * the agent has is the user's own Claude Code setup, not ours. */
export const DEFAULT_EXPLORE_VERIFY_PROMPT =
  'Verification session — checking a feature in a live environment, not the code in this checkout. Feature: "{summary}". ' +
  "Environment: {env}. Services in scope: {services}. A brief listing the repos in scope is at {brief}. " +
  "Using the observability tools available to you, check these services in {env}: recent logs and error rates, " +
  "the relevant metrics and traces, and which version is actually deployed. Then give a verdict — working, broken, " +
  "or inconclusive — with the evidence behind it and where to look next. " +
  "Read-only: don't change code, and don't mutate the environment.{files}";
```

Add `needsEnv` to the `ExploreAction` interface (line 94):

```ts
export interface ExploreAction {
  id: string;
  label: string;
  prompt: string;
  slackDm: boolean;
  /** This action collects an environment before opening, and its prompt may use {env}. */
  needsEnv: boolean;
}
```

Widen the def type and append the fifth entry (lines 102-107) — `needsEnv` is optional on the def so the four existing entries stay unchanged:

```ts
const EXPLORE_ACTION_DEFS: { id: string; label: string; settingKey: string; defaultPrompt: string; needsEnv?: boolean }[] = [
  { id: "jiraTicket", label: "Open a Jira ticket", settingKey: "explorePrompts.jiraTicket", defaultPrompt: DEFAULT_EXPLORE_JIRA_TICKET_PROMPT },
  { id: "knowledge", label: "Enhance knowledge / flow", settingKey: "explorePrompts.knowledge", defaultPrompt: DEFAULT_EXPLORE_PROMPT },
  { id: "debug", label: "Debug", settingKey: "explorePrompts.debug", defaultPrompt: DEFAULT_EXPLORE_DEBUG_PROMPT },
  { id: "general", label: "General", settingKey: "explorePrompts.general", defaultPrompt: DEFAULT_EXPLORE_GENERAL_PROMPT },
  { id: "verify", label: "Verify on an environment", settingKey: "explorePrompts.verify", defaultPrompt: DEFAULT_EXPLORE_VERIFY_PROMPT, needsEnv: true },
];
```

Both places that build an `ExploreAction` need the new field. In `DEFAULT_EXPLORE_ACTIONS` (line 113):

```ts
export const DEFAULT_EXPLORE_ACTIONS: ExploreAction[] = EXPLORE_ACTION_DEFS.map((def) => ({
  id: def.id,
  label: def.label,
  prompt: def.defaultPrompt,
  slackDm: false,
  needsEnv: def.needsEnv === true,
}));
```

And in `getConfig()` (line 222):

```ts
  const exploreActions: ExploreAction[] = EXPLORE_ACTION_DEFS.map((def) => ({
    id: def.id,
    label: def.label,
    prompt: resolvePrompt(def),
    slackDm: slackRaw[def.id] === true,
    needsEnv: def.needsEnv === true,
  }));
```

- [ ] **Step 4: Add the three manifest changes**

In `package.json`:

1. `"agentFlow.exploreMode"` — append `"verify"` to `enum` and its description to `enumDescriptions` (both arrays must stay index-aligned):

```json
          "enum": [
            "ask",
            "jiraTicket",
            "knowledge",
            "debug",
            "general",
            "verify"
          ],
          "enumDescriptions": [
            "Choose an action each time you click Explore",
            "Open a Jira ticket — explore, then create a ticket capturing the findings",
            "Enhance knowledge / flow — map the code paths and explain how it works",
            "Debug — reproduce and root-cause a problem",
            "General — open-ended working session",
            "Verify on an environment — check a feature against a live env for the picked services"
          ],
```

2. A new prompt setting, immediately after `"agentFlow.explorePrompts.general"`:

```json
        "agentFlow.explorePrompts.verify": {
          "type": "string",
          "editPresentation": "multilineText",
          "markdownDescription": "Prompt seeded for the **Verify on an environment** Explore action. Placeholders: `{summary}` (the feature), `{env}` (only this action collects one), `{services}` (the repos you picked), `{brief}`, `{files}`.",
          "default": "Verification session — checking a feature in a live environment, not the code in this checkout. Feature: \"{summary}\". Environment: {env}. Services in scope: {services}. A brief listing the repos in scope is at {brief}. Using the observability tools available to you, check these services in {env}: recent logs and error rates, the relevant metrics and traces, and which version is actually deployed. Then give a verdict — working, broken, or inconclusive — with the evidence behind it and where to look next. Read-only: don't change code, and don't mutate the environment.{files}"
        },
```

3. `"agentFlow.exploreSlackDm"` — a `verify` property and a `verify` entry in the default object:

```json
            "general": {
              "type": "boolean",
              "description": "General"
            },
            "verify": {
              "type": "boolean",
              "description": "Verify on an environment"
            }
          },
          "additionalProperties": {
            "type": "boolean"
          },
          "default": {
            "jiraTicket": false,
            "knowledge": false,
            "debug": false,
            "general": false,
            "verify": false
          }
```

- [ ] **Step 5: Widen the telemetry enum in the same task**

In `src/telemetry/settingsSnapshot.ts`, line 34:

```ts
export const EXPLORE_MODES = ["ask", "jiraTicket", "knowledge", "debug", "general", "verify"] as const;
```

And the comment on lines 41-42, so it doesn't name a stale id set:

```ts
/** Shipped default prompt per explore-action id (the id set never varies, only each
 * action's `.prompt` can be customized). */
```

In `src/telemetry/events.ts`, line 118:

```ts
  explore_mode: "ask" | "jiraTicket" | "knowledge" | "debug" | "general" | "verify" | "invalid";
```

- [ ] **Step 6: Keep the tasksView test fixture type-checking**

`ExploreAction.needsEnv` is required, so every entry in `CFG.exploreActions` (`test/unit/tasksView.test.ts:105-110`) needs it. Replace that array with:

```ts
  exploreActions: [
    { id: "jiraTicket", label: "Open a Jira ticket", prompt: "JT {summary}{files}", slackDm: false, needsEnv: false },
    { id: "knowledge", label: "Enhance knowledge / flow", prompt: "Explore {summary}{files}", slackDm: false, needsEnv: false },
    { id: "debug", label: "Debug", prompt: "DBG {summary}{files}", slackDm: false, needsEnv: false },
    { id: "general", label: "General", prompt: "GEN {summary}{files}", slackDm: false, needsEnv: false },
    { id: "verify", label: "Verify on an environment", prompt: "VER {summary} on {env} for {services}{files}", slackDm: false, needsEnv: true },
  ],
```

`verify` is appended last, so the existing `CFG.exploreActions[2]` (Debug) and `[3]` (General) references at lines 947 and 976 still point at the same actions.

- [ ] **Step 7: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS — including the `EXPLORE_MODES` ⇄ manifest parity test and the byte-identical prompt-default test. If the prompt-default test fails, the `package.json` string and the `config.ts` concatenation differ — diff them character by character (em dashes and the apostrophe in "don't" are the usual culprits).

- [ ] **Step 8: Commit**

```bash
git add src/config.ts src/telemetry/settingsSnapshot.ts src/telemetry/events.ts package.json test/unit/config.test.ts test/unit/telemetry/settingsSnapshot.test.ts test/unit/tasksView.test.ts
git commit -m "feat(explore): add the verify-on-an-environment action"
```

---

### Task 4: The environment step in `explore()`

Wires it together: the env picker, the required focus box, env-aware session identity, and the substituted template.

**Files:**
- Modify: `src/tasksView.ts` — the import on line 4, a new `chooseEnvironment()` beside `chooseExploreAction()` (line 649), and `explore()` (lines 664-741)
- Test: `test/unit/tasksView.test.ts` — the `describe("explore", ...)` block (lines 940-1007)

**Interfaces:**
- Consumes: `AgentFlowConfig.environments` (Task 1); `applyExploreVars(template, { env?, services })` (Task 2); `ExploreAction.needsEnv` (Task 3).
- Produces: no new exported surface — `chooseEnvironment` is private.

- [ ] **Step 1: Write the failing tests**

Add these to the existing `describe("explore", ...)` block in `test/unit/tasksView.test.ts`, after the Slack-DM test (line 1006). The mock's `showQuickPick` and `showInputBox` are consumed in call order, so each `mockResolvedValueOnce` chain below mirrors the exact sequence of prompts the flow raises.

```ts
  it("asks for an environment and fills {env} and {services} for the verify action", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "verify" });
    const repos = mkRepos(["account-service", "webapp"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("retry banner");
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ label: "staging", env: "staging" } as never) // env picker
      .mockResolvedValueOnce([{ repo: repos[0] }, { repo: repos[1] }] as never); // repo picker
    const { send } = setup();
    await send({ type: "explore" });
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        promptTemplate: "VER {summary} on staging for account-service, webapp{files}",
        ticket: expect.objectContaining({ key: "verify-staging-retry-banner", summary: "retry banner on staging" }),
      }),
    );
  });

  it("offers the configured environments plus a Custom… entry", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "verify", environments: ["dev", "prod"] });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("focus");
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ label: "dev", env: "dev" } as never)
      .mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { send } = setup();
    await send({ type: "explore" });
    const items = vi.mocked(window.showQuickPick).mock.calls[0][0] as { label: string }[];
    expect(items.map((i) => i.label)).toEqual(["dev", "prod", "$(edit) Custom…"]);
  });

  it("takes a one-off environment through the Custom… input box", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "verify" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox)
      .mockResolvedValueOnce("retry banner") // focus
      .mockResolvedValueOnce("  staging-eu  "); // custom env, untrimmed
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ label: "$(edit) Custom…" } as never) // no `env` → custom
      .mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { send } = setup();
    await send({ type: "explore" });
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ promptTemplate: "VER {summary} on staging-eu for account-service{files}" }),
    );
  });

  it("aborts before the destination step when the environment picker is cancelled", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "verify" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["account-service"]));
    vi.mocked(window.showInputBox).mockResolvedValueOnce("retry banner");
    vi.mocked(window.showQuickPick).mockResolvedValueOnce(undefined as never); // cancel env pick
    const { send } = setup();
    await send({ type: "explore" });
    expect(window.showQuickPick).toHaveBeenCalledTimes(1);
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it("aborts when the Custom… environment input is cancelled", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "verify" });
    vi.mocked(discoverRepos).mockReturnValue(mkRepos(["account-service"]));
    vi.mocked(window.showInputBox)
      .mockResolvedValueOnce("retry banner")
      .mockResolvedValueOnce(undefined); // cancel the custom env box
    vi.mocked(window.showQuickPick).mockResolvedValueOnce({ label: "$(edit) Custom…" } as never);
    const { send } = setup();
    await send({ type: "explore" });
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it("requires a focus for verify and leaves it optional for the other actions", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "verify" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("retry banner");
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ label: "dev", env: "dev" } as never)
      .mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { send } = setup();
    await send({ type: "explore" });
    const opts = vi.mocked(window.showInputBox).mock.calls[0][0] as {
      title: string;
      validateInput?: (v: string) => string | undefined;
    };
    expect(opts.title).toBe("Verify — which feature or change?");
    expect(opts.validateInput?.("   ")).toBe("Name the feature or change to verify");
    expect(opts.validateInput?.("retry banner")).toBeUndefined();
  });

  it("leaves the other actions' focus box optional and unvalidated", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "knowledge" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("");
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { send } = setup();
    await send({ type: "explore" });
    const opts = vi.mocked(window.showInputBox).mock.calls[0][0] as {
      title: string;
      validateInput?: (v: string) => string | undefined;
    };
    expect(opts.title).toBe("Explore — what do you want to dig into?");
    expect(opts.validateInput).toBeUndefined();
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ ticket: expect.objectContaining({ key: "explore-codebase-exploration" }) }),
    );
  });

  it("applies the Slack sentence before substituting the environment", async () => {
    const actions = CFG.exploreActions.map((a) => (a.id === "verify" ? { ...a, slackDm: true } : a));
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "verify", exploreActions: actions });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("retry banner");
    vi.mocked(window.showQuickPick)
      .mockResolvedValueOnce({ label: "prod", env: "prod" } as never)
      .mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { send } = setup();
    await send({ type: "explore" });
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        promptTemplate: `VER {summary} on prod for account-service ${SLACK_DM_SENTENCE}{files}`,
      }),
    );
  });

  it("does not ask for an environment for an action that does not need one", async () => {
    vi.mocked(getConfig).mockReturnValue({ ...CFG, exploreMode: "debug" });
    const repos = mkRepos(["account-service"]);
    vi.mocked(discoverRepos).mockReturnValue(repos);
    vi.mocked(window.showInputBox).mockResolvedValueOnce("focus");
    vi.mocked(window.showQuickPick).mockResolvedValueOnce([{ repo: repos[0] }] as never);
    const { send } = setup();
    await send({ type: "explore" });
    expect(window.showQuickPick).toHaveBeenCalledTimes(1); // the repo picker only
    expect(openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        promptTemplate: "DBG {summary}{files}",
        ticket: expect.objectContaining({ key: "explore-focus", summary: "focus" }),
      }),
    );
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/tasksView.test.ts -t explore`
Expected: FAIL — no env picker is shown, so the repo picker receives the env mock and `openWorkspace` is called with `"VER {summary} on {env} for {services}{files}"` unsubstituted (or not called at all).

- [ ] **Step 3: Add `chooseEnvironment`**

In `src/tasksView.ts`, add directly after `chooseExploreAction()` (which ends at line 660):

```ts
  /** Pick the environment for an action that needs one: the configured list plus a
   * Custom… escape hatch for a one-off value. The item carries its own `env` rather
   * than reusing `label`, so an environment literally named like the Custom… entry
   * can't be mistaken for it. Returns undefined when the user cancels either step. */
  private async chooseEnvironment(cfg: AgentFlowConfig): Promise<string | undefined> {
    const pick = await vscode.window.showQuickPick<vscode.QuickPickItem & { env?: string }>(
      [...cfg.environments.map((e) => ({ label: e, env: e })), { label: "$(edit) Custom…" }],
      { title: "Verify — which environment?", placeHolder: "Pick an environment", ignoreFocusOut: true },
    );
    if (!pick) return undefined;
    if (pick.env) return pick.env;
    const typed = await vscode.window.showInputBox({
      title: "Verify — environment name",
      prompt: "The environment to verify against.",
      placeHolder: "e.g. staging-eu",
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : "Name the environment"),
    });
    return typed?.trim() || undefined;
  }
```

- [ ] **Step 4: Make the focus box action-aware and add the env step**

In `explore()`, replace the focus-box block (lines 675-682) with:

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

    // Verify needs to know where; the other actions never ask. Before the destination
    // step, so cancelling here has created and opened nothing.
    let env: string | undefined;
    if (action.needsEnv) {
      env = await this.chooseEnvironment(cfg);
      if (!env) return; // environment pick cancelled
    }
```

- [ ] **Step 5: Make the session identity and template env-aware**

Replace lines 718-733 (the `slug`/`planMd`/`openWorkspace` block) with:

```ts
    const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    const slug = slugify(topic) || "explore";
    const serviceNames = services.map((s) => s.name).join(", ");
    const key = env ? `verify-${slugify(env) || "env"}-${slug}` : `explore-${slug}`;
    const summary = env ? `${topic} on ${env}` : topic;
    const planMd = env
      ? `## Verify: ${topic} on ${env}\n\n_Verification session — environment: ${env}. Services in scope: ${serviceNames}._`
      : `## Exploration: ${topic}\n\n_No Jira ticket yet — a knowledge/exploration session. If it turns into work, open a ticket afterwards._`;
    const result = await openWorkspace({
      ticket: { key, summary, url: "" },
      planMd,
      descriptionText: "",
      services,
      mode: args.mode,
      // Slack sentence first: it anchors on {files} in the *authored* template, so a
      // typed environment containing "{files}" can never become that anchor.
      promptTemplate: applyExploreVars(injectSlackDm(action.prompt, action.slackDm), { env, services: serviceNames }),
      workspaceDir: cfg.workspaceDir,
      seedAgent: cfg.seedAgent,
      openIn: args.openIn,
      existingWorkspaceFile: args.existingWorkspaceFile,
      existingFolder: args.existingFolder,
      remoteControl: wantRemoteControl,
    });
```

Then the toast (lines 735-740) — unchanged wording for the four existing actions:

```ts
    const where = result.workspaceFile
      ? `workspace ${result.workspaceFile.split("/").pop()}`
      : `${result.opened.length} window(s)`;
    const seeded = this.seededNote(cfg.seedAgent, result.remoteControl);
    const rcNote = this.remoteControlNote(wantRemoteControl, result.remoteControl);
    const what = env ? `to verify on ${env}` : "to explore";
    this.toast("success", `Opened ${where} ${what}. Brief seeded in each repo.${seeded}${rcNote}`);
```

Finally, add `applyExploreVars` to the `from "./engine/prompt"` import that already brings in `injectSlackDm` (near line 4 — find the exact line with `grep -n 'engine/prompt' src/tasksView.ts`).

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS — the nine new explore tests plus every pre-existing one, including `describe("explore — open target", ...)` (line 2592) which pins `exploreMode` to `knowledge` and must be unaffected.

- [ ] **Step 7: Commit**

```bash
git add src/tasksView.ts test/unit/tasksView.test.ts
git commit -m "feat(explore): ask for an environment on the verify action"
```

---

### Task 5: `environments_customized` telemetry and the docs

**Files:**
- Modify: `src/telemetry/settingsSnapshot.ts`
- Modify: `src/telemetry/events.ts:102` (the count in the doc comment) and the `SettingsSnapshot` interface
- Modify: `docs/TELEMETRY.md:170,180`
- Modify: `README.md` (the settings table around line 257 and the paragraph at 259-263)
- Modify: `CHANGELOG.md` (`## [Unreleased]`)
- Test: `test/unit/telemetry/settingsSnapshot.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_ENVIRONMENTS` and `AgentFlowConfig.environments` (Task 1).
- Produces: `SettingsSnapshot.environments_customized: boolean`.

- [ ] **Step 1: Write the failing tests**

Add to `describe("settingsSnapshot", ...)` in `test/unit/telemetry/settingsSnapshot.test.ts`:

```ts
  it("does not flag the shipped environment list as customized", () => {
    expect(settingsSnapshot(getConfig()).environments_customized).toBe(false);
  });

  it("flags a customized environment list without revealing the names", () => {
    const s = settingsSnapshot({ ...getConfig(), environments: ["acme-prod-eu", "acme-canary"] });
    expect(s.environments_customized).toBe(true);
    expect(JSON.stringify(s)).not.toContain("acme");
  });

  it("treats a reordered environment list as customized", () => {
    const s = settingsSnapshot({ ...getConfig(), environments: ["production", "staging", "dev"] });
    expect(s.environments_customized).toBe(true);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/telemetry/settingsSnapshot.test.ts`
Expected: FAIL — `environments_customized` is `undefined`, so both boolean assertions fail.

- [ ] **Step 3: Implement the snapshot field**

In `src/telemetry/settingsSnapshot.ts`, add `DEFAULT_ENVIRONMENTS` to the `from "../config"` import on line 1, then add beside `STOCK_PROMPT_MODE_IDS` (line 39):

```ts
const DEFAULT_ENVIRONMENT_LIST = DEFAULT_ENVIRONMENTS.join(",");
```

And add to the returned object, directly after `explore_prompts_customized` (line 78):

```ts
    // Order-sensitive, and only ever a boolean — environment names are user-authored
    // and never transmitted.
    environments_customized: cfg.environments.join(",") !== DEFAULT_ENVIRONMENT_LIST,
```

In `src/telemetry/events.ts`, add to the `SettingsSnapshot` interface after `explore_prompts_customized`:

```ts
  environments_customized: boolean;
```

and update the count in its doc comment (line 102): `/** The 25 safe reductions of AgentFlowConfig, built by settingsSnapshot.ts.`

- [ ] **Step 4: Update the telemetry doc**

In `docs/TELEMETRY.md`, line 170: `24-field` → `25-field`. On line 180, add the new property to the boolean row:

```
| `prompt_modes_customized`, `explore_prompts_customized`, `environments_customized`, `pr_review_prompt_customized` | `true` / `false` — *whether* the corresponding user-authored text was changed from the shipped default, never the text itself |
```

- [ ] **Step 5: Update the README**

Add a row to the settings table, after the `agentFlow.remoteControl` row (line 257):

```
| `agentFlow.environments` | `["dev", "staging", "production"]` | Environments offered by the **Verify on an environment** Explore action. The picker also offers **Custom…** for a one-off. |
```

Then make the new action discoverable in the paragraph that follows. **Do not rewrite that paragraph** — it also documents `promptModes` / `taskMode` / worktrees, and all of that stays. Insert only these three sentences, immediately after the existing sentence that ends `` `agentFlow.taskMode` to skip the question. `` and before `` The **Address PR** kick-off always runs in a worktree. ``:

```
**Explore** asks what kind of session to start: **Open a Jira ticket**, **Enhance
knowledge / flow**, **Debug**, **General**, or **Verify on an environment**. Verify also
asks which environment to check the repos you picked against — from
`agentFlow.environments`, or a one-off you type — and seeds a read-only prompt that
inspects their logs, errors, metrics and deployed version there. Edit any Explore prompt
under `agentFlow.explorePrompts.*`, or pin one action with `agentFlow.exploreMode`.
```

- [ ] **Step 6: Add the changelog entry**

Under `## [Unreleased]` in `CHANGELOG.md`:

```markdown
### Added

- **Explore can verify a feature on an environment.** A fifth Explore action, **Verify on
  an environment**, asks which environment to check — from the new `agentFlow.environments`
  list, or a one-off you type — alongside the repos you already pick, then seeds a
  read-only prompt asking the agent to inspect those services in that environment (logs,
  error rates, metrics and traces, deployed version) and return a working / broken /
  inconclusive verdict with evidence. The prompt is editable at
  `agentFlow.explorePrompts.verify`, and `agentFlow.exploreMode` can pin Explore to it.
  Agent Flow itself never touches the environment — the agent does that with its own tools.
```

- [ ] **Step 7: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS — every suite green.

- [ ] **Step 8: Verify the setting renders in the settings page**

Run: `npm run build`
Then press F5 (or launch the Extension Development Host), open Settings and search `agentFlow.environments`. Confirm it renders as an **editable string list** with three default items — not an "Edit in settings.json" link — and that `agentFlow.explorePrompts.verify` renders as a textarea. Then click **Explore**, choose **Verify on an environment**, and confirm the focus box refuses an empty value, the env picker lists the three defaults plus **Custom…**, and the seeded prompt names the env and the repos you picked.

- [ ] **Step 9: Commit**

```bash
git add src/telemetry/settingsSnapshot.ts src/telemetry/events.ts docs/TELEMETRY.md README.md CHANGELOG.md test/unit/telemetry/settingsSnapshot.test.ts
git commit -m "feat(telemetry): report whether the environment list was customized"
```

---

## Spec coverage

| Spec section | Task |
|---|---|
| `verify` action def, `needsEnv`, label, appended last | 3 |
| `DEFAULT_EXPLORE_VERIFY_PROMPT` + manifest parity | 3 |
| `agentFlow.environments` + normalization + fallback | 1 |
| `agentFlow.explorePrompts.verify`, `exploreMode` enum, `exploreSlackDm.verify` | 3 |
| `applyExploreVars`, `{env}` only when collected, `$&`-safe | 2 |
| Env QuickPick + `Custom…`, cancel semantics | 4 |
| Required focus box for verify only | 4 |
| Env-aware ticket key / summary / planMd / toast | 4 |
| Assembly order: `injectSlackDm` then substitution | 4 |
| `EXPLORE_MODES` + `explore_mode` union | 3 |
| `environments_customized`, names never transmitted | 5 |
| README / CHANGELOG / TELEMETRY.md | 5 |
