# Design: Remote Control for new sessions

**Date:** 2026-07-26
**Status:** Approved, ready for planning
**Revision:** 2 — the mechanism changed from a global Claude settings key to seeding the
`/remote-control` slash command per session. Revision 1's ownership tracking, global
settings writes, and configuration listener are all dropped.

## Summary

Add a tri-state setting, `agentFlow.remoteControl` (`off` / `on` / `ask`, default
`off`), that offers Claude Code's **Remote Control** for the session Agent Flow just
opened — so a task taken from the pool can be driven from claude.ai or the Claude
mobile app.

When it is on, Agent Flow pre-fills the Claude Code panel with `/remote-control <KEY>`
instead of the task prompt, and puts the task prompt on the clipboard. The user presses
Enter to enable Remote Control, then pastes and presses Enter to start the task.

## Decisions

| Question | Decision |
|----------|----------|
| How is Remote Control enabled? | Seed the `/remote-control <KEY>` slash command into the panel; the user presses Enter. Scoped to that one session — nothing global is written. |
| Where does the task prompt go? | The clipboard, with a toast telling the user to paste it after enabling. |
| Setting shape? | `agentFlow.remoteControl`: `"off" \| "on" \| "ask"`, default `"off"` — the same tri-state shape as `agentFlow.worktree`. |
| Ask cadence? | Once per launch action. |
| Multi-window launches? | **Skipped.** There is one clipboard and N windows — the others would paste the wrong task's brief. Applies to parallel batch launches and per-window launches across more than one repo. |
| Session naming? | `/remote-control <KEY>` — the Jira key (or `explore-<slug>`) names the remote session, so several are tellable apart on claude.ai. |

## Approach rationale

- **Why the slash command and not a settings key.** `remoteControlAtStartup` in the
  global Claude settings would work with no keystrokes, but it is machine-wide: every
  Claude session started while it is on becomes remote-controlled, including ones Agent
  Flow did not launch. The slash command is scoped to exactly the session being opened,
  which is what the feature is for, and it leaves no state behind to clean up.
- **Why the task prompt cannot ride along.** Claude Code only stacks a slash command
  ahead of a prompt when the command is `type: "prompt"`
  (`peelStackedPromptCommands` breaks on anything else). `/remote-control` is
  `type: "local-jsx"` with an optional `[name]` argument, so a buffer holding
  `/remote-control` followed by the task brief would submit the entire brief as the
  session *name*. The panel takes one pre-filled buffer and one Enter —
  `createPanel(sessionId, prompt, column)` exposes no programmatic submit — so the two
  cannot share a submission. The clipboard is the second channel.
- **Why multi-window launches are skipped rather than partially supported.** The
  clipboard is a single global slot. Three windows opening 250 ms apart would each be
  pre-filled with their own `/remote-control <KEY>`, but only the last-seeded task
  prompt survives on the clipboard — the first two would paste another task's brief.
  Silently pasting the wrong brief is worse than not offering the feature, so a launch
  that opens more than one window keeps today's behavior and says so.
- **Naming the session after the ticket.** `/remote-control` takes an optional name.
  Passing the Jira key costs nothing and makes several concurrent remote sessions
  distinguishable on claude.ai, which is exactly the situation Agent Flow creates.

## Components

### 1. Setting — `package.json` + `src/config.ts`

```json
"agentFlow.remoteControl": {
  "type": "string",
  "enum": ["off", "on", "ask"],
  "enumDescriptions": [
    "Never offer Remote Control",
    "Offer Remote Control for every session Agent Flow launches",
    "Ask once each time you launch"
  ],
  "default": "off",
  "markdownDescription": "Offer Claude Code's **Remote Control** for the session Agent Flow opens, so you can drive it from claude.ai or the Claude mobile app. The panel is pre-filled with `/remote-control <KEY>` and your task prompt goes to the clipboard: press Enter to connect, then paste to start the task. Skipped for launches that open more than one window, because a single clipboard can't serve them."
}
```

`src/config.ts`: add `remoteControl: "off" | "on" | "ask"` to `AgentFlowConfig`, resolved
against the enum rather than with a bare `||` fallback so a stale value like `"true"`
lands on `off`.

### 2. Threading the decision to the window that seeds

The seeding does not happen in the launching window. `openWorkspace` writes a plan file
to `~/.agentflow/plans`; the newly opened window reads it during activation
(`maybeSeedAgent`) and calls `seedClaudeCode`. The decision therefore has to travel in
the plan file.

- `OpenRequest` gains `remoteControl?: boolean` — what the launch asked for.
- `PlanFile` gains `remoteControl?: boolean` — what actually applies.
- `OpenResult` gains `remoteControl: boolean` — what actually applied, so the launching
  window's toast can be honest.

In `openWorkspace`, after `matches` is built:

```ts
// One clipboard, one window. A launch that opens several windows would leave every
// window but the last pasting another task's brief.
const remoteControl = !!req.remoteControl && matches.length === 1;
```

That guard covers a per-window launch across several repos. The parallel batch path is a
separate concern — see §4.

### 3. Seeding — `src/engine/workspace.ts`

`maybeSeedAgent` passes `plan.remoteControl` through:

```ts
await seedClaudeCode(match.prompt, plan.key, log, plan.remoteControl === true);
```

`seedClaudeCode(prompt, key, log, remoteControl = false)`:

1. When `remoteControl`, the buffer to seed is `/remote-control ${key}` and the task
   prompt goes to the clipboard first, so it is already there when the panel opens.
2. The existing three-tier delivery (verified command → URI handler → clipboard) is
   unchanged apart from seeding that buffer instead of the prompt.
3. On success with `remoteControl`, a toast explains the two steps:

   ```
   Agent Flow: PROJ-1234 — press Enter to connect Remote Control, then ⌘V + Enter to
   start the task (it's on your clipboard).
   ```

   The paste chord is `⌘V` on darwin and `Ctrl+V` elsewhere.
4. **Tier-3 collision.** The last-resort fallback already uses the clipboard for the
   prompt. If delivery gets that far with `remoteControl` on, Remote Control is dropped
   and the existing behavior stands (clipboard holds the prompt, message says to paste
   it) — the clipboard cannot carry both, and the task prompt is the one that matters.
   Log that it was dropped.

### 4. Launch integration — `src/tasksView.ts`

```ts
/** Resolve whether this launch offers Remote Control. `ask` prompts once per launch
 *  action; dismissing the picker means no, not cancel. */
private async resolveRemoteControl(cfg: AgentFlowConfig): Promise<boolean>;
```

The `ask` picker:

```
┌────────────────────────────────────────────────────────────────┐
│ Enable Remote Control for this session?                        │
├────────────────────────────────────────────────────────────────┤
│ 📡 Enable Remote Control                                        │
│    Connect first, then paste the task prompt to start           │
│ ⊘  Local only                                                   │
│    Seed the task prompt as usual                                │
└────────────────────────────────────────────────────────────────┘
        Escape → Local only (the launch continues)
```

Escape resolves to "no" rather than aborting: by the time this runs in `launch()`,
worktrees and briefs already exist, and abandoning a launch over an optional toggle is
the worse failure.

| Path | Behavior |
|------|----------|
| Take (`launch()`) | Resolve once, pass to `openWorkspace`. |
| Address PR (`launch()`) | Same — it shares `launch()`. |
| Explore | Resolve once, pass to `openWorkspace`. |
| Parallel batch | **Never offered.** No picker, `remoteControl` is not passed. When the setting is `on` or `ask`, the completion toast notes it was skipped. |

When a launch asked for Remote Control but `openWorkspace` withheld it (more than one
window), the toast says so rather than leaving the user waiting for a prompt that never
comes.

## Testing

- **Config unit** (`test/unit/config.test.ts`): default `"off"`; each enum value
  round-trips; a value outside the enum falls back to `"off"`; the `package.json` schema
  declares the default and the enum.
- **Workspace unit** (`test/unit/engine/workspace.test.ts`):
  - `openWorkspace` records `remoteControl: true` in the plan file for a single-match
    launch that asked for it, and `false` when it did not ask.
  - A launch that produces more than one match records `false` even when asked, and
    `OpenResult.remoteControl` is `false`.
  - `maybeSeedAgent` with `remoteControl: true` seeds `/remote-control <KEY>` and writes
    the task prompt to the clipboard.
  - `maybeSeedAgent` with `remoteControl` absent or `false` seeds the prompt and does not
    touch the clipboard.
  - The tier-3 clipboard fallback still writes the task prompt when Remote Control was
    requested.
- **Host unit** (`test/unit/tasksView.test.ts`):
  - `off` never shows the picker and passes `remoteControl: false`.
  - `on` passes `remoteControl: true` without a picker.
  - `ask` shows the picker once; choosing Enable passes `true`, dismissing passes `false`
    and the launch still proceeds.
  - `takeBatch` never shows the picker and never passes `remoteControl: true`, even with
    the setting on.
- **Manual / end-to-end:**
  1. Set `ask`, take a task, choose Enable. The panel shows `/remote-control PROJ-1234`;
     Enter connects it and the session appears on claude.ai; paste + Enter starts the task.
  2. Set `off` and take a task — the task prompt is seeded exactly as before.
  3. Take a task spanning two repos in per-window mode with the setting `on` — both
     windows seed their task prompt normally and the toast says Remote Control was skipped.
  4. Launch three tasks in parallel with the setting `on` — no picker, all three seed
     normally, the toast notes the skip.

## Out of scope

- No Remote Control for parallel batch or multi-window launches (see §4). Supporting it
  needs a second channel for the task prompt that isn't the clipboard.
- The single-clipboard guard is per-launch, not global. Taking PROJ-1 with Remote Control
  and then taking PROJ-2 with Remote Control before pasting PROJ-1's prompt overwrites the
  clipboard — PROJ-1's rendered prompt is lost permanently (its brief still survives at
  `.pick-task/TASK.md`, but the seeded prompt does not). Plan files live 15 minutes, so
  the window for this collision is wide. No cross-launch clipboard reservation is
  implemented.
- No retrofitting a session that is already running in a live window.
- No global `remoteControlAtStartup` setting management — explicitly dropped in this
  revision.
- No Deck surfacing of which in-flight sessions are remote-controlled.
- No CLI launch path (`claude --remote-control`) — Agent Flow keeps seeding through the
  Claude Code panel.
