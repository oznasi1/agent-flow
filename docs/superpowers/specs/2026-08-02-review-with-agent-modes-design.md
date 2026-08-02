# Design: multiple seed modes for Review with agent

**Date:** 2026-08-02
**Status:** Approved, ready for planning

## Summary

**Review with agent** — the primary action on a row of the Deck's
review-requests strip — seeds exactly one prompt today, from the single string
setting `agentFlow.reviewRequestPrompt`. A reviewer with more than one review
style has nowhere to put the second one.

This replaces that one string with a list of named **review modes**, the same
`{id, label, detail?, prompt}` shape `agentFlow.promptModes` already uses for
Take. Configure two or more and clicking **Review with agent** raises a
QuickPick; the picked mode's template becomes the seeded prompt. The motivating
case is a reviewer with separate backend-services and frontend review skills who
wants to choose per PR.

Scope is the review strip only. **Address PR** (`agentFlow.prReviewPrompt`) is
deliberately untouched — it is the flow for fixing *your own* PR, one thing with
one prompt, and it was ruled out of scope during design.

## Decisions

| Question | Decision |
|----------|----------|
| Config shape | `agentFlow.reviewRequestModes`: array of `{id, label, detail?, prompt}`, identical item schema to `agentFlow.promptModes`. |
| How is a mode pinned? | `agentFlow.reviewRequestMode`: `"ask"` (default) or a mode `id` — mirrors `agentFlow.taskMode`. |
| Shipped default | Exactly **one** stock mode, `id: "full"`, carrying today's `DEFAULT_REVIEW_REQUEST_PROMPT` verbatim. Backend/frontend is one org's split, not a universal default. |
| Does a fresh install see a picker? | **No.** One configured mode short-circuits the picker, so the default install keeps today's single-click launch. |
| What happens to `agentFlow.reviewRequestPrompt`? | Deprecated in the manifest and migrated: an explicitly-set legacy value becomes the `full` mode's prompt, exactly as `explorePrompt` → `explorePrompts.knowledge` was handled. |
| Where does the picker live? | `vscode.window.showQuickPick` in `deckView.launchReviewFor`, before `launchReview` is called. Cancel aborts the launch silently. |
| Webview change? | **None.** The button text, the row, and the strip are unchanged; the QuickPick title carries the context. |
| Share the resolver with Take? | No. A new pure `resolveReviewMode` in `engine/review/launch.ts`; `tasksView.choosePromptMode` is left alone. |
| Placeholders | Unchanged: `{repo} {number} {author} {key} {summary} {url} {brief} {files}`. |

## Approach rationale

Three shapes were considered.

1. **A list of full prompt templates** — *chosen.* Byte-for-byte the
   `promptModes` pattern the codebase already ships, tests, and documents. A
   mode owns its whole prompt, so a backend mode and a frontend mode can differ
   in structure, not just in which skill they name.

2. **A list of short add-on fragments appended to one base prompt.** Attractive
   while Address PR was in scope, because one fragment list could have served
   both buttons. With Address PR out of scope the shared-list argument
   evaporates, and fragments buy nothing except a ceiling on what a mode can
   say.

3. **A second dropdown in the review strip.** Rejected: it puts a persistent
   control on every row for a choice made at most once per launch, against the
   project's rule that rows carry no standing hint UI.

## Components

### 1. `src/config.ts`

Add, next to `DEFAULT_PROMPT_MODES`:

```ts
/** The stock review modes offered by Review with agent, in picker order. One
 * entry by default: a single mode means no picker, which keeps a fresh install
 * at today's one-click launch. Keep this array identical to the
 * `agentFlow.reviewRequestModes` default in package.json; a test enforces it. */
export const DEFAULT_REVIEW_REQUEST_MODES: PromptMode[] = [
  {
    id: "full",
    label: "Full review",
    detail: "Correctness, edge cases, tests — findings to .pick-task/REVIEW-<n>.md",
    prompt: DEFAULT_REVIEW_REQUEST_PROMPT,
  },
];
```

`DEFAULT_REVIEW_REQUEST_PROMPT` stays exported — it is now the `full` mode's
`prompt` rather than a setting default in its own right.

`AgentFlowConfig`: **remove** `reviewRequestPrompt: string`, **add**

```ts
  // Seed modes offered by Review with agent. Never empty — an unusable
  // configured value falls back to DEFAULT_REVIEW_REQUEST_MODES.
  reviewRequestModes: PromptMode[];
  // "ask", or a reviewRequestModes id.
  reviewRequestMode: string;
```

`getConfig()`:

```ts
reviewRequestModes: (() => {
  const m = c.get<PromptMode[]>("reviewRequestModes");
  const valid = Array.isArray(m) ? m.filter((x) => x && x.id && x.label && x.prompt) : [];
  if (valid.length) return valid;
  // Migrate a customized legacy reviewRequestPrompt into the stock mode. Only
  // reached when reviewRequestModes is unset or unusable: an explicit modes
  // list is a deliberate replacement and wins over the deprecated string.
  const legacy = explicitConfigValue<string>(c, "reviewRequestPrompt");
  return legacy
    ? [{ ...DEFAULT_REVIEW_REQUEST_MODES[0], prompt: legacy }]
    : DEFAULT_REVIEW_REQUEST_MODES;
})(),
reviewRequestMode: c.get<string>("reviewRequestMode") || "ask",
```

The `filter` mirrors `promptModes` — a hand-edited `settings.json` can hold
anything, and a mode missing `prompt` would seed an empty session.

### 2. `src/engine/review/launch.ts`

A pure resolver, no vscode import, beside `reviewRunKey` and
`renderReviewTemplate`:

```ts
/** The review mode to seed without asking, or null when the user must pick.
 * Two ways to skip the picker: `configured` names a real mode, or there is only
 * one mode to offer — a QuickPick with a single item is friction, not a choice.
 * `modes` is never empty; getConfig guarantees it. */
export function resolveReviewMode(modes: PromptMode[], configured: string): PromptMode | null {
  const pinned = modes.find((m) => m.id === configured);
  if (pinned) return pinned;
  return modes.length === 1 ? modes[0] : null;
}
```

`launchReview` itself is unchanged — it already takes `template` as a plain
string, so it neither knows nor cares that the string now came from a mode.

### 3. `src/deckView.ts`

`launchReviewFor` gains the resolve-or-ask step:

```ts
const cfg = getConfig();
const mode =
  resolveReviewMode(cfg.reviewRequestModes, cfg.reviewRequestMode) ??
  (await vscode.window.showQuickPick(
    cfg.reviewRequestModes.map((m) => ({ label: m.label, detail: m.detail, mode: m })),
    { title: `Review ${req.repoName}#${req.number}`, ignoreFocusOut: true },
  ))?.mode;
if (!mode) return; // picker cancelled — no worktree, no window, no toast
await launchReview({ req, template: mode.prompt, ... }, ...);
```

Cancelling is silent and side-effect-free by construction: the QuickPick resolves
before `createWorktrees` runs, so a cancelled launch leaves no worktree behind.
That ordering is the point of putting the picker here rather than inside
`launchReview`.

`this.reviewById(id)` is called *before* the picker, as today. The queue can move
on while the picker is open; that is the same window `launchReview` already
tolerates, and a stale row fails at `gh pr checkout`, not silently.

### 4. `src/telemetry/events.ts` and `src/telemetry/settingsSnapshot.ts`

`events.ts` gains `export const STOCK_REVIEW_MODES = ["full"] as const;` beside
`STOCK_PROMPT_MODES`, and the `SettingsSnapshot` type gains three fields:
`review_mode: TaskModeProp`, `review_modes_count: number`,
`review_modes_customized: boolean`. `TaskModeProp` (`"ask" | "stock" | "custom"`)
is reused as-is; its name already reads generically enough for a second mode
setting.

In `settingsSnapshot.ts`, `taskModeProp(taskMode)` is generalized in place to
`modeProp(value, stock: readonly string[])` and `task_mode` re-expressed through
it — a two-line change inside one file, not the cross-module extraction rejected
above. `pr_review_prompt_customized` is unaffected. The new props:

```ts
review_mode: modeProp(cfg.reviewRequestMode, STOCK_REVIEW_MODES),
review_modes_count: cfg.reviewRequestModes.length,
review_modes_customized: cfg.reviewRequestModes.map((m) => m.id).join(",") !== STOCK_REVIEW_MODES.join(","),
```

No mode `label`, `detail`, `prompt` or custom `id` is ever transmitted: a custom
id collapses to `"custom"`, matching how `task_mode` has always handled
`promptModes`. The module doc-comment at `settingsSnapshot.ts:47`, which lists
`reviewRequestPrompt` among the user-authored settings, is updated to name
`reviewRequestModes`.

### 5. `package.json`

- `agentFlow.reviewRequestModes` — `array`, item schema copied from
  `agentFlow.promptModes` (required `id`/`label`/`prompt`, optional `detail`),
  `default` byte-identical to `DEFAULT_REVIEW_REQUEST_MODES`. Description names
  the placeholders and points at the backend/frontend case as the example.
- `agentFlow.reviewRequestMode` — `string`, default `"ask"`, described as
  `` `ask` to choose each time, or the `id` of one of `#agentFlow.reviewRequestModes#` ``.
  A plain string, not an `enum`, because the id set is user-extensible — same as
  `agentFlow.taskMode`.
- `agentFlow.reviewRequestPrompt` — keep the key and its default, add
  `markdownDeprecationMessage`: *"Deprecated — use `agentFlow.reviewRequestModes`.
  If you customized this, its value is migrated into the **Full review** mode
  automatically."*

Ordering: the two new keys go immediately after `agentFlow.reviewWrites`, where
`reviewRequestPrompt` sits today, so the settings page keeps the review block
together and the deprecated key sinks below them.

## Error handling

| Case | Behaviour |
|------|-----------|
| `reviewRequestModes` unset | Stock single mode (or the migrated legacy prompt). No picker. |
| `reviewRequestModes: []`, or every entry missing a required field | Falls back to the stock list. A malformed list must never seed an empty prompt. |
| Some entries valid, some not | Invalid entries dropped; the rest are offered. |
| `reviewRequestMode` names an unknown id | Treated as `"ask"`. A typo shows the picker rather than silently seeding a mode the user didn't name. |
| `reviewRequestMode` names an id whose entry was dropped as invalid | Same as unknown — picker. |
| Picker cancelled (Esc / focus loss) | Return before any side effect. No worktree, no window, no toast. |
| Both `reviewRequestModes` and legacy `reviewRequestPrompt` set | Modes win; the legacy value is ignored. |

## Testing

**`test/unit/config.test.ts`**
- default config yields `DEFAULT_REVIEW_REQUEST_MODES` and `reviewRequestMode === "ask"`
- an explicit `reviewRequestPrompt` migrates into the `full` mode's `prompt`, leaving its `id`/`label`/`detail` intact
- an explicit `reviewRequestModes` beats an explicit `reviewRequestPrompt`
- `[]` and an all-invalid array both fall back to the stock list; a mixed array keeps only the valid entries
- the `agentFlow.reviewRequestModes` schema default is deep-equal to `DEFAULT_REVIEW_REQUEST_MODES` (mirrors the existing `promptModes` parity test)
- `DEFAULT_REVIEW_REQUEST_MODES[0].prompt === DEFAULT_REVIEW_REQUEST_PROMPT`

**`test/unit/engine/review/launch.test.ts`** — `resolveReviewMode`: pinned id
returns that mode; unknown id with >1 mode returns `null`; unknown id with 1 mode
returns it; `"ask"` with 1 mode returns it; `"ask"` with >1 returns `null`.

**`test/unit/deckView.test.ts`**
- >1 mode + `"ask"` → QuickPick shown, and the picked mode's `prompt` is the
  `template` `launchReview` receives
- picker cancelled → `launchReview` not called, no toast, no worktree call
- pinned mode → no QuickPick, that mode's prompt seeded
- default single mode → no QuickPick (guards the no-regression-for-existing-users
  promise)

**`test/unit/telemetry/settingsSnapshot.test.ts`** — `review_mode` collapses a
custom id to `"custom"`; the existing "no user-authored text leaks" assertion is
extended to the new props.

Existing fixtures that set `reviewRequestPrompt` (`test/unit/tasksView.test.ts:124`,
`test/unit/deckView.test.ts`) move to `reviewRequestModes`/`reviewRequestMode`.

## Documentation

- `README.md:256` — replace the `agentFlow.reviewRequestPrompt` row with
  `agentFlow.reviewRequestModes` and `agentFlow.reviewRequestMode`, and add a
  sentence to the Review-with-agent prose showing the backend/frontend pair.
- `docs/TELEMETRY.md:53` — swap the `reviewRequestPrompt` mention for
  `reviewRequestModes`, and list the three new props in the property table.
- `CHANGELOG.md` — feature entry noting the deprecation and automatic migration.

## Out of scope

- **Address PR** (`agentFlow.prReviewPrompt`) keeps its single prompt.
- No per-mode `seedAgent`, worktree, or Slack-DM overrides — a mode is a prompt
  template and nothing else.
- No last-used-mode memory. `agentFlow.reviewRequestMode` is the way to stop
  being asked.
- No mode indicator on the review row.
