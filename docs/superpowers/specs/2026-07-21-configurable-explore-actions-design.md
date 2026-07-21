# Design: configurable Explore actions

**Date:** 2026-07-21
**Status:** Approved, ready for planning

## Summary

Today the **Explore** button (the compass in the Tasks panel header) runs one
fixed flow — focus box → repo picker → workspace mode → open — and always seeds
the single `agentFlow.explorePrompt`. This turns that into a menu of four
**actions**, each with its own initial prompt that is **editable directly in the
VS Code settings page**, plus a per-action "DM me on Slack when done" checkbox.

The four actions are **jiraTicket** (open a Jira ticket), **knowledge** (enhance
knowledge / flow), **debug**, and **general**. Everything stays in the prompt
layer: the extension only chooses which prompt text to seed. Creating the Jira
ticket and sending the Slack DM are done by the **Claude Code agent** via its own
Jira/Slack connectors — driven by the seeded prompt, not by new integration code
in the extension.

## Decisions

| Question | Decision |
|----------|----------|
| What does clicking Explore do? | Unchanged in the webview (still sends `{ type: "explore" }`). Host-side, a native **QuickPick of the four actions** is added at the front of `explore()` when `exploreMode == "ask"`; a configured action skips the picker. |
| How are the action prompts configured? | **One `string` setting per action**, each with `editPresentation: "multilineText"`, so every prompt is an editable textarea in the settings page. **Not** an array-of-objects (which renders only as "Edit in settings.json"). |
| Fixed set or extensible? | **Fixed set of four** built-in actions (ids + labels in code). Adding a fifth action is an extension change, not a user setting. This is the cost of settings-page-editable prompts, and matches the ask. |
| Who creates the Jira ticket / sends the Slack DM? | The **agent**, via the seeded prompt. No session-completion detection, Slack auth, or Jira-write wiring is added to the extension. |
| How is "Slack DM" chosen? | Per-action, via a single object setting `agentFlow.exploreSlackDm` keyed by action id → boolean, rendered as **checkboxes** in the settings page. All default **off**. |
| What happens to `agentFlow.explorePrompt`? | **Deprecated but honored.** If it was explicitly customized, its value migrates into the `knowledge` action prompt (see Migration). |

## Approach rationale

- **Settings-page editability drives the schema.** The requirement is that each
  action's prompt be editable in the settings **UI**, not only `settings.json`.
  VS Code renders a `string` with `editPresentation: "multilineText"` as a
  textarea (this is exactly how the current `explorePrompt` renders), but renders
  an array-of-objects as a bare "Edit in settings.json" link. So the four prompts
  must be four individual string settings — which in turn fixes the action set at
  four built-ins.
- **Internal shape stays an array.** Even though the settings are individual,
  `getConfig()` assembles them into an `ExploreAction[]` (`{id, label, prompt,
  slackDm}`) so `explore()` can pick/iterate uniformly — the same ergonomics the
  array design had, without the JSON-only editing.
- **Native QuickPick, no new webview UI.** Focus, repos, and workspace mode are
  already chosen through native quick-picks in `explore()`. Adding the action
  picker there keeps the webview button untouched and the flow uniform.
- **Slack toggles in their own object setting.** A per-action boolean map is what
  lets VS Code render a real checkbox per action id (an array-of-objects would
  not), and keeps the Slack preference orthogonal to the prompt text.
- **Prompt layer only.** "Open a ticket" / "DM me on Slack" are instructions in
  the seeded text; whether they succeed depends on the user's own Claude Code MCP
  connectors, which is out of scope for the extension — the same division of
  labor the extension already relies on for seeding agents.

## The four actions (code constant)

`EXPLORE_ACTIONS` in `config.ts` — fixed ids + labels, paired with their prompt
setting key:

| id | label (picker) | prompt setting |
|----|----------------|----------------|
| `jiraTicket` | Open a Jira ticket | `agentFlow.explorePrompts.jiraTicket` |
| `knowledge` | Enhance knowledge / flow | `agentFlow.explorePrompts.knowledge` |
| `debug` | Debug | `agentFlow.explorePrompts.debug` |
| `general` | General | `agentFlow.explorePrompts.general` |

Ids are camelCase and used verbatim as the `exploreMode` enum values and the
`exploreSlackDm` keys, so there is a single canonical id per action.

## Settings (package.json `contributes.configuration`)

| Setting | Type | Default | Renders as |
|---------|------|---------|------------|
| `agentFlow.exploreMode` | string enum `["ask","jiraTicket","knowledge","debug","general"]` | `"ask"` | Dropdown. `"ask"` = pick each time; otherwise always that action. |
| `agentFlow.explorePrompts.jiraTicket` | string, `multilineText` | jira-ticket default (below) | Textarea. |
| `agentFlow.explorePrompts.knowledge` | string, `multilineText` | current `DEFAULT_EXPLORE_PROMPT` | Textarea. |
| `agentFlow.explorePrompts.debug` | string, `multilineText` | debug default (below) | Textarea. |
| `agentFlow.explorePrompts.general` | string, `multilineText` | general default (below) | Textarea. |
| `agentFlow.exploreSlackDm` | object, properties = the 4 ids, each `{type:"boolean"}` | all `false` | Checkbox per action id. |
| `agentFlow.explorePrompt` | string | *(unchanged text)* | **Deprecated** (`markdownDeprecationMessage`); migration source only. |

All prompt settings document the placeholders `{summary}` (the focus), `{brief}`,
`{files}`. (`{key}`/`{url}` are empty in Explore, as today.)

## Default action prompts (`config.ts`)

Exact wording is finalized in implementation; intent:

- **jiraTicket** — explore the focus, then **create a Jira ticket** capturing the
  findings and **add the `claude-code` label** (matches the extension's
  provenance convention). Ends with `{files}`.
- **knowledge** — the current `DEFAULT_EXPLORE_PROMPT`: map the relevant code
  paths, explain the flow, flag follow-ups; don't change code unless asked.
- **debug** — reproduce & investigate a problem, find the root cause, propose a
  fix; don't change code unless asked.
- **general** — open-ended pairing prompt scoped to the focus and repos.

## Config loading + migration (`config.ts`)

`AgentFlowConfig` gains:

- `exploreActions: ExploreAction[]` — assembled from `EXPLORE_ACTIONS`: for each,
  `prompt` = the resolved prompt setting, `slackDm` = `exploreSlackDm[id] === true`.
- `exploreMode: string` — `c.get("exploreMode") || "ask"`.

New type `ExploreAction { id: string; label: string; prompt: string; slackDm: boolean }`.

**Migration (knowledge prompt).** Prefer an explicitly-set
`explorePrompts.knowledge`; else an explicitly-set legacy `explorePrompt`; else
`DEFAULT_EXPLORE_PROMPT`. "Explicitly set" is detected with
`config.inspect(key)` (global/workspace/folder value present), so the schema
default of `explorePrompts.knowledge` doesn't mask a real legacy customization.
`explorePrompt` is retained in the config read solely for this.

## Behavior & flow (`tasksView.explore()`)

1. **Choose the action.** If `exploreMode == "ask"` (or the configured id isn't a
   known action), show a QuickPick of `cfg.exploreActions` (`label` + short
   `detail`). Cancel aborts before anything else happens. Otherwise use the
   configured action directly.
2. Focus box → repo picker → workspace mode — unchanged.
3. **Assemble the template.** Start from `action.prompt`; if `action.slackDm`,
   insert a Slack-DM sentence **just before the trailing `{files}`** (or append if
   absent) so the file list stays last. One generic sentence for all actions,
   e.g. *"When you're done, send me a direct message on Slack summarizing the
   session (and link any Jira ticket you opened)."*
4. `openWorkspace({ ..., promptTemplate: assembledTemplate })` — unchanged
   otherwise. The synthetic `ticket` (`key: "explore-<slug>"`, `summary: topic`,
   `url: ""`) and `planMd` are as today.

## Surfaces (types, functions)

- `config.ts`: `EXPLORE_ACTIONS` constant, `ExploreAction` type, the four default
  prompt constants, `exploreActions`/`exploreMode` on `AgentFlowConfig`, plus the
  getters + migration. `explorePrompt` retained (deprecated).
- `tasksView.ts`: the action pick + Slack-suffix assembly at the top of
  `explore()`. No change to `openWorkspace` or the message contract.
- `types.ts` / webview: **no change.** `{ type: "explore" }` is unchanged; the
  Explore button and its handler are untouched.

## Testing

- `config.test.ts`:
  - `exploreActions` yields four actions with the built-in labels and default
    prompts; each `slackDm` reflects `exploreSlackDm`.
  - `exploreMode` defaults to `"ask"`.
  - `exploreSlackDm` defaults to all four ids `false`; a user value flips only
    that action; non-boolean values are ignored.
  - Migration: an explicit legacy `explorePrompt` becomes the `knowledge` prompt;
    an explicit `explorePrompts.knowledge` wins over it; neither set → default.
- `tasksView.test.ts` (extends the existing `explore()` test):
  - Picker shown when `exploreMode == "ask"`; skipped when a valid id is set;
    unknown configured id falls back to the picker.
  - The chosen action's prompt is the `promptTemplate` passed to `openWorkspace`.
  - Slack sentence appended **iff** that action's `slackDm` is true, and placed
    before the `{files}` block.
  - Cancelling the action picker aborts before touching the workspace.
- `prompt.test.ts`: unaffected — `renderPrompt` and its placeholder set don't
  change.

## Non-goals (YAGNI)

- Arbitrary user-defined actions — the set is fixed at four so each prompt can be
  a settings-page-editable textarea.
- Any extension-side Jira create or Slack send — both are agent behaviors driven
  by the prompt.
- Session-completion detection or Slack auth/token/webhook storage.
- A new webview control for the action — the native QuickPick matches the rest of
  the Explore flow.
- Per-action focus-box copy or per-action repo defaults.
- Removing `agentFlow.explorePrompt` — deprecated and used for migration, not
  deleted.
