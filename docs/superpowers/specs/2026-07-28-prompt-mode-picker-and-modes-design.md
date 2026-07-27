# Design: readable prompt-mode picker, and four more task modes

**Date:** 2026-07-28
**Status:** Approved, ready for planning

## Summary

Taking a task opens a QuickPick asking how the agent should start. Its second
line is currently derived from the prompt template by deleting every
`{placeholder}` and truncating at 80 characters, so `Jira {key}: "{summary}"`
renders as `Jira : ""` and the sentence stops mid-word. The picker reads as
broken at the exact moment a user is deciding what the agent will do.

This replaces the derived line with a **hand-written `detail` per mode**, and
grows the built-in set from two modes to six: **Test-driven**, **Investigate &
root-cause**, **Orchestrator**, and **Refine the ticket** join **Plan first** and
**Implementation**. Every mode stays what it is today — pure text. Nothing in the
launch flow changes.

## The defect

`tasksView.choosePromptMode()`:

```ts
detail: mm.prompt.replace(/\{[a-z]+\}/g, "").replace(/\s+/g, " ").trim().slice(0, 80),
```

Two independent faults. Deleting a placeholder leaves the punctuation that framed
it (`Jira : ""`, `the task brief at for context`), and a hard `slice(0, 80)` cuts
mid-word. No wording of a prompt template avoids this — the line is derived from
the wrong source. The Explore picker sitting beside it passes `label` only and
looks correct, which is the shape to move toward.

The mode picker deliberately runs **before** the ticket is fetched, so
substituting the real `{key}`/`{summary}` would mean reordering `takeTask` and
paying a network round-trip before the first click. Rejected: the fix does not
need the ticket.

## Decisions

| Question | Decision |
|----------|----------|
| What does the picker's second line show? | A **hand-written `detail`** written per mode, describing what the agent will do. Never derived from the prompt. |
| What about modes that have no `detail`? | The line is **omitted** — the item renders label-only, exactly like the Explore picker. A user-defined mode degrades to clean, not to broken. |
| Is `detail` user-editable? | Yes. It joins `id`/`label`/`prompt` in the `promptModes` item schema as an **optional** property. |
| Does the ticket get fetched earlier? | **No.** `takeTask` keeps picking the mode first. |
| How deep does Orchestrator go? | **Prompt-only.** It asks the agent to decompose and dispatch subagents. No worktree flag, no `.claude/orchestrator/` scaffold, no new `PromptMode` behavior fields. |
| Do existing customized `promptModes` gain the new modes? | **No** — the setting is a whole-array override, as it already is. Changelog note, not code. |

## Approach rationale

- **A blurb is a different kind of text than a prompt.** The prompt addresses the
  agent in the second person and carries placeholders; the picker line addresses
  the user and must stand alone. Deriving one from the other was the mistake, and
  no amount of cleanup — collapsing orphan punctuation, truncating on a word
  boundary — makes `Jira . Read the task brief at for context` read well. Two
  fields, written for two readers.
- **Omission beats a bad fallback.** For a mode with no `detail`, any generated
  line reintroduces the original defect in weaker form. Label-only is already the
  established look next door in the Explore picker, and a user who wrote a custom
  mode knows what their own label means.
- **Orchestrator stays text.** Letting a mode carry `worktree: true` would make
  `PromptMode` a behavior carrier and put the extension in the business of
  enforcing one workflow. The worktree question is already asked at launch and
  already configurable via `agentFlow.worktree`; a mode does not need to
  short-circuit it.
- **Six items is still one screenful.** And `agentFlow.taskMode` already lets
  someone pin a single mode and never see the picker.

## The six modes (`DEFAULT_PROMPT_MODES` in `config.ts`)

Picker order is array order — most-reached-for first, `refine` last.

| id | label | detail |
|----|-------|--------|
| `plan` | Plan first | Propose a step-by-step plan and wait for approval — no code edits |
| `implementation` | Implementation | Start building; check in only when something's ambiguous |
| `tdd` | Test-driven | Write the failing test first, then implement until it's green |
| `investigate` | Investigate & root-cause | Reproduce, trace to a root cause, propose a fix — no code edits |
| `orchestrator` | Orchestrator | Split into parallel subtasks, then integrate and verify |
| `refine` | Refine the ticket | Sharpen the description and acceptance criteria — no code |

`plan` and `implementation` keep their exact prompt text; they gain only a
`detail`. Every new prompt keeps the established template shape — opens with
`Jira {key}: "{summary}". Read the task brief at {brief} for context and the
repos involved.`, closes with `Ticket: {url}{files}` — so the placeholder
contract is unchanged and `renderPrompt` needs no work.

Intent of each new prompt (exact wording finalized in implementation):

- **tdd** — work test-first: write the failing test that captures this ticket's
  acceptance criteria, confirm it fails for the right reason, then implement
  until it passes.
- **investigate** — reproduce the problem, trace it to a root cause, explain what
  is going wrong with evidence from the code, propose a fix, don't change code
  unless asked. Deliberately echoes `DEFAULT_EXPLORE_DEBUG_PROMPT` so the
  ticket-bound and ticket-less debug flows read alike.
- **orchestrator** — break the ticket into independent subtasks, report the
  breakdown before dispatching, run a subagent per subtask, then integrate the
  results and verify the whole works.
- **refine** — dig into the code, then rewrite the Jira description and
  acceptance criteria so they are unambiguous and testable, list what is still
  unclear, add the `claude-code` label, and stop short of implementing. Matches
  the provenance convention the `jiraTicket` Explore prompt already follows.

## Surfaces

- **`types.ts`** — `PromptMode` gains `detail?: string`.
- **`config.ts`** — `DEFAULT_PROMPT_MODES` grows to six entries, each with a
  `detail`. The validator's required-field filter (`x.id && x.label && x.prompt`)
  is unchanged, so `detail` is optional in fact as well as in type.
- **`tasksView.ts`** — `choosePromptMode()` maps to `{ label, detail: mm.detail,
  mode: mm }`. A `detail` of `undefined` is what VS Code already treats as "no
  second line", so no branch is needed.
- **`package.json`** — `detail` added to the `promptModes` item schema
  (optional, described as the line shown under the label in the picker), and the
  four new modes added to the setting's `default` array. `agentFlow.taskMode`
  stays a free-form string, so it accepts the new ids without a schema change.
- **`README.md`** — the settings section mentions `agentFlow.promptModes`; it
  gets the new mode list.
- **`CHANGELOG.md`** — not touched by this task, per the orchestrator protocol.
  The user-visible line goes in the status file instead.

## Testing

- **`config.test.ts`**
  - `DEFAULT_PROMPT_MODES` has six entries; ids are unique; every entry has a
    non-empty `detail`, `label`, and `prompt`.
  - Every default prompt contains `{key}`, `{summary}`, `{brief}`, `{url}` and
    ends with `{files}`.
  - A custom mode carrying a `detail` survives validation with the field intact.
  - A custom mode **without** `detail` still validates (the field is optional).
  - Existing assertions that a customized array overrides the defaults, that an
    empty array falls back, and that a non-array falls back, all still hold.
- **`tasksView.test.ts`**
  - The picker items expose the mode's `detail` verbatim — specifically, the
    rendered detail is **not** derived from the prompt (assert no `Jira : ""`).
  - A mode with no `detail` produces an item whose `detail` is `undefined`.
  - Existing coverage — `taskMode` pinning skips the picker, cancelling aborts,
    the chosen mode's prompt reaches `launch` — is unchanged. Fixtures that build
    a one-mode `promptModes` array keep working because `detail` is optional.
- **`prompt.test.ts`** — unaffected; the placeholder set does not change.

## Non-goals (YAGNI)

- Fetching the ticket before the mode picker so the preview can show the real
  summary.
- `PromptMode` behavior fields of any kind — `worktree`, `seedAgent`, per-mode
  destinations.
- Writing a `.claude/orchestrator/` scaffold from Orchestrator mode.
- Inferring a default mode from the ticket's issue type (Bug → investigate).
- Backfilling the new modes into a user's already-customized `promptModes`.
- Touching the Explore actions, the PR-review prompt, or the batch-launch flow.
