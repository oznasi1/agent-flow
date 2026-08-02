# Design: Explore action — verify a feature on an environment

**Date:** 2026-08-02
**Status:** Approved, ready for planning

## Summary

Explore today offers four actions — `jiraTicket`, `knowledge`, `debug`, `general`
— each seeding its own settings-page-editable prompt. This adds a fifth,
**`verify`**: verify that a feature works on a specific **environment** for a
specific set of **services**.

The services are the repos the flow already asks for; the only genuinely new
input is the environment, picked from a new settings-page-editable list. The
seeded prompt is observability-led and read-only: the agent inspects logs,
errors, metrics, traces and the deployed version for those services in that env,
then returns a verdict. As with every other Explore action, the extension only
chooses and fills in prompt text — it performs no environment access itself.

## Decisions

| Question | Decision |
|----------|----------|
| What are "services"? | The repos picked by the existing multi-select. No new service catalog, no second picker. The prompt names them via a new `{services}` placeholder. |
| Where does the env list come from? | New `agentFlow.environments` (`string[]`, defaults `dev`/`staging`/`production`), shown as a QuickPick with a `$(edit) Custom…` entry for one-off envs. |
| How does the env reach the prompt? | A new `{env}` placeholder substituted in `explore()` just before `openWorkspace`, the same pre-substitution pattern `engine/review/launch.ts` uses for `{repo}`/`{number}`/`{author}`. **Not** added to `renderPrompt`/`PromptVars`. |
| Which actions ask for an env? | Only actions whose def sets `needsEnv: true` — currently just `verify`. |
| Is the focus box still optional? | **Required** for `verify` (there is nothing to verify otherwise), optional for the other four, as today. |
| What does the default prompt tell the agent to do? | Observability-led and read-only: logs, error rates, metrics, traces, deployed version → a working / broken / inconclusive verdict with evidence. Tool-agnostic wording — this repo is public OSS. |
| Configurable in the settings page? | Yes: the prompt (`agentFlow.explorePrompts.verify`, multiline), the env list (`agentFlow.environments`, string array), the Slack-DM checkbox, and `verify` as an `agentFlow.exploreMode` value. |

## Approach rationale

Three ways to get the env into the seeded prompt were considered:

1. **Per-action extra step + assembly-time substitution** — *chosen.* The action
   def declares `needsEnv`; `explore()` runs the env step only for those actions
   and substitutes `{env}`/`{services}` into the template immediately before
   `openWorkspace`. Blast radius is `config.ts` + `explore()`, and it reuses a
   substitution pattern already in the codebase.
2. **Make `{env}` a first-class `renderPrompt` placeholder** — rejected. Every
   other caller (task modes, PR-review kick-off, review requests) would have to
   supply an env it does not have, and `{env}` would become a documented
   placeholder in prompts where it is permanently empty.
3. **Fold the env into the focus text** ("checkout retries on staging") —
   rejected. It saves almost nothing: the env list, the picker and the settings
   still have to exist, and the env can no longer be positioned deliberately
   within the prompt.

Two supporting choices follow the existing design:

- **String array, not array-of-objects, for the env list.** The configurable
  Explore actions design established that VS Code renders an array-of-objects as
  a bare "Edit in settings.json" link. A `string[]` renders as an editable list
  widget, so `agentFlow.environments` stays settings-page editable. The cost is
  that an environment is a bare name — no per-env URL, tenant id, or dashboard
  link (see Non-goals).
- **Fixed built-in action, like the other four.** Adding `verify` is an extension
  change, not a user setting, because its prompt must be its own textarea
  setting.

## The action (code constant)

`EXPLORE_ACTION_DEFS` in `config.ts` gains a fifth entry. `ExploreAction` and the
def type both gain `needsEnv: boolean` (`false` for the existing four):

| id | label (picker) | prompt setting | needsEnv |
|----|----------------|----------------|----------|
| `jiraTicket` | Open a Jira ticket | `agentFlow.explorePrompts.jiraTicket` | false |
| `knowledge` | Enhance knowledge / flow | `agentFlow.explorePrompts.knowledge` | false |
| `debug` | Debug | `agentFlow.explorePrompts.debug` | false |
| `general` | General | `agentFlow.explorePrompts.general` | false |
| **`verify`** | **Verify on an environment** | **`agentFlow.explorePrompts.verify`** | **true** |

`verify` is appended last so the existing picker order is unchanged.
`DEFAULT_EXPLORE_ACTIONS` (consumed by `settingsSnapshot.ts` to detect a
customized prompt without transmitting prompt text) picks the new entry up
automatically.

## Settings (package.json `contributes.configuration`)

| Setting | Type | Default | Renders as |
|---------|------|---------|------------|
| `agentFlow.environments` | `array`, `items: {type: "string"}`, `uniqueItems: true` | `["dev", "staging", "production"]` | Editable string list. |
| `agentFlow.explorePrompts.verify` | string, `multilineText` | the default prompt below | Textarea. |
| `agentFlow.exploreMode` | *existing enum* | `"ask"` | Gains `"verify"` in `enum` and a matching `enumDescriptions` entry: *"Verify on an environment — check a feature against a live env for the picked services"*. |
| `agentFlow.exploreSlackDm` | *existing object* | gains `"verify": false` | Gains a `verify` boolean property (description "Verify on an environment") and a `false` in the object default. |

`agentFlow.environments` description: the environments offered when an Explore
action asks which environment to verify against; the picker always also offers
`Custom…` for a one-off value.

`agentFlow.explorePrompts.verify` documents placeholders `{summary}` (the
feature), `{env}`, `{services}`, `{brief}`, `{files}`, and states that `{env}` is
available only on this action.

## Default verify prompt (`config.ts` — `DEFAULT_EXPLORE_VERIFY_PROMPT`)

```
Verification session — checking a feature in a live environment, not the code in
this checkout. Feature: "{summary}". Environment: {env}. Services in scope:
{services}. A brief listing the repos in scope is at {brief}. Using the
observability tools available to you, check these services in {env}: recent logs
and error rates, the relevant metrics and traces, and which version is actually
deployed. Then give a verdict — working, broken, or inconclusive — with the
evidence behind it and where to look next. Read-only: don't change code, and
don't mutate the environment.{files}
```

Shipped as a single-line concatenated string constant, matching the other
`DEFAULT_EXPLORE_*_PROMPT` constants, and duplicated verbatim as the setting's
`default` in `package.json`. The existing *"keeps each explore prompt schema
default byte-identical to its config constant"* test in `config.test.ts` gains an
assertion for it — if the two drift, `explore_prompts_customized` reports a false
positive for every user.

Wording is deliberately tool-agnostic ("the observability tools available to
you"): Agent Flow is public OSS, so no vendor or internal environment names are
baked in.

## Config loading (`config.ts`)

`AgentFlowConfig` gains `environments: string[]`.

`DEFAULT_ENVIRONMENTS = ["dev", "staging", "production"]`.

Normalization, in order: read the array; drop non-string entries; trim each; drop
empties; dedupe preserving first-seen order. If the result is empty (setting
absent, not an array, or all entries invalid) fall back to
`DEFAULT_ENVIRONMENTS` — the same empty-means-default behavior `promptModes`
already has.

`resolvePrompt` needs no change: `verify` uses the plain
`c.get(settingKey) || defaultPrompt` branch (only `knowledge` carries the legacy
`explorePrompt` migration).

## Prompt substitution (`engine/prompt.ts`)

New export:

```ts
export function applyExploreVars(template: string, vars: { env?: string; services: string }): string
```

- Replaces every `{services}` with `vars.services`.
- Replaces every `{env}` with `vars.env` **only when `vars.env` is provided**;
  when it is absent the `{env}` text is left untouched, so a user who adds
  `{env}` to a non-verify prompt sees an unfilled placeholder rather than a
  silent blank.
- Uses function-replacers (`.replace(/\{env\}/g, () => v)`) so `$&`/`$1` inside a
  typed env or repo name is never interpreted, matching
  `engine/review/launch.ts`.

## Behavior & flow (`tasksView.explore()`)

1. **Action picker** — unchanged mechanism; now five entries.
2. **Focus box.** When `action.needsEnv`, the box is titled *"Verify — which
   feature or change?"* with prompt *"The feature or change to verify on the
   environment."* and placeholder *"e.g. the new retry banner on checkout"*, and
   sets `validateInput` returning *"Name the feature or change to verify"* for
   blank input — VS Code blocks Enter until it is non-empty, and Esc still
   cancels. Other actions keep today's copy and today's optional/`"Codebase
   exploration"` fallback.
3. **Environment step — new, only when `action.needsEnv`.** A QuickPick of
   `cfg.environments` plus a trailing `$(edit) Custom…` item (title *"Verify —
   which environment?"*, `ignoreFocusOut: true`). Choosing `Custom…` opens an
   input box (*"Verify — environment name"*) whose `validateInput` rejects blank;
   the value is trimmed. Cancelling either the QuickPick or the custom input
   aborts the whole flow — before the destination step, so nothing has been
   created or opened.
4. **Destination → repo multi-select → open args → remote control** — unchanged.
5. **Session identity.** For a `needsEnv` action the synthetic ticket becomes
   `key: verify-<env-slug>-<topic-slug>`, `summary: "<topic> on <env>"`; the
   `planMd` heading becomes `## Verify: <topic> on <env>` with a line naming the
   env and the services. Non-env actions keep `explore-<slug>` and today's
   heading exactly. Slugging reuses the existing lowercase/non-alphanumeric-to-
   dash/trim/40-char rule.
6. **Template assembly**, in this order:
   1. `injectSlackDm(action.prompt, action.slackDm)` — operates on the authored
      template, so a `{files}` sequence inside a typed env value cannot become
      the anchor `insertBeforeFiles` uses.
   2. `applyExploreVars(...)` with `services` = the picked repo names joined with
      `", "`, and `env` = the chosen env for `needsEnv` actions (omitted
      otherwise).
   The result is passed as `promptTemplate` to `openWorkspace`; `renderPrompt`
   downstream still fills `{summary}`/`{brief}`/`{files}` as today.
7. **Toast** — unchanged wording for the existing actions; the verify path says
   it opened a session to verify on `<env>`.

## Telemetry (`src/telemetry/`)

- `EXPLORE_MODES` gains `"verify"`, and the `explore_mode` union in `events.ts`
  widens to include it, so pinning Explore to verify is not reported as
  `"invalid"`.
- `explore_prompts_customized` picks the new action up automatically through
  `DEFAULT_EXPLORE_ACTIONS`.
- New `environments_customized: boolean` — true when `cfg.environments` differs
  from `DEFAULT_ENVIRONMENTS` (order-sensitive array comparison). **Environment
  names are never transmitted**, only the boolean.

## Surfaces (files touched)

- `src/config.ts` — `DEFAULT_EXPLORE_VERIFY_PROMPT`, `DEFAULT_ENVIRONMENTS`,
  `needsEnv` on `ExploreAction` and the def type, fifth def entry,
  `environments` on `AgentFlowConfig` + its normalization in `getConfig()`.
- `src/engine/prompt.ts` — `applyExploreVars`.
- `src/tasksView.ts` — `chooseEnvironment()`, per-action focus-box copy and
  validation, env-aware ticket key / summary / planMd / toast, assembly order.
- `src/telemetry/settingsSnapshot.ts`, `src/telemetry/events.ts` — as above.
- `package.json` — the four settings changes.
- `README.md` (settings table / Explore section), `CHANGELOG.md` `[Unreleased]`.
- `docs/TELEMETRY.md` — document `environments_customized`.
- No change to `src/types.ts` or any webview: the Explore button still posts
  `{ type: "explore" }`.

## Testing

`test/unit/config.test.ts`
- Five actions in order, with the built-in labels; only `verify` has
  `needsEnv: true`.
- `verify` prompt defaults to `DEFAULT_EXPLORE_VERIFY_PROMPT`; a user value wins.
- `exploreSlackDm.verify` flows into the fifth action's `slackDm`.
- `environments`: default when unset; trims; drops non-strings and empties;
  dedupes preserving order; empty/all-invalid array falls back to defaults.
- In the existing `package.json ⇄ config constants` block: the
  `agentFlow.explorePrompts.verify` schema default is byte-identical to
  `DEFAULT_EXPLORE_VERIFY_PROMPT`, and the `agentFlow.environments` schema
  default deep-equals `DEFAULT_ENVIRONMENTS`.

`test/unit/engine/prompt.test.ts`
- `applyExploreVars` replaces every occurrence of `{env}` and `{services}`.
- `{env}` left literal when no env is supplied; `{services}` always substituted.
- A value containing `$&` is inserted verbatim.
- Other placeholders (`{summary}`, `{brief}`, `{files}`) are untouched.

`test/unit/tasksView.test.ts`
- Picker offers five actions; choosing `verify` runs the env step, and the other
  four do not.
- Env QuickPick lists `cfg.environments` plus `Custom…`; choosing `Custom…` opens
  the input box and the typed value is used (trimmed).
- Cancelling the env QuickPick, and cancelling the custom input, each abort
  before `chooseOpenTarget` is called.
- Blank focus is rejected for `verify` (the `validateInput` callback returns a
  message) and still accepted for the other actions.
- `openWorkspace` receives a `promptTemplate` with `{env}` and `{services}`
  filled from the picks, and the ticket `key`/`summary` carry the env.
- With `slackDm.verify` on, the Slack sentence sits before `{files}` and the env
  substitution still applies (order test).

`test/unit/telemetry/settingsSnapshot.test.ts`
- `explore_mode: "verify"` is reported as `"verify"`, not `"invalid"`.
- `environments_customized` is false for the defaults, true for a changed list,
  and no env name appears anywhere in the snapshot.

## Non-goals (YAGNI)

- **Per-environment metadata** — no URL, tenant id, dashboard link or credentials
  per env. An environment is a name; a `string[]` is what keeps the list
  editable in the settings page.
- **Any environment access from the extension** — no health checks, no HTTP, no
  log queries, no E2E triggering. The agent does all of it through its own tools.
- **A separate service catalog** — services are the picked repos.
- **A default-environment setting** to skip the env picker. `exploreMode` can pin
  the action; the env is still asked each time, which is the point.
- **`{env}` on the other four actions** — the placeholder is only filled for
  actions with `needsEnv`.
- **User-defined Explore actions** — still a fixed built-in set, for the same
  settings-page-editability reason as the original four.
- **A webview control for the env** — the native QuickPick matches the rest of
  the Explore flow.
