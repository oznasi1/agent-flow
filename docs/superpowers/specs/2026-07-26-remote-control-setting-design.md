# Design: Remote Control for new sessions

**Date:** 2026-07-26
**Status:** Approved, ready for planning

## Summary

Add a tri-state setting, `agentFlow.remoteControl` (`off` / `on` / `ask`, default
`off`), that starts Claude Code's **Remote Control** bridge for the sessions Agent
Flow launches — so a session taken from the task pool can be driven from claude.ai
or the Claude mobile app without touching the keyboard that started it.

Claude Code exposes no per-launch flag through the VS Code panel; the panel honors
a settings key, `remoteControlAtStartup` ("Start Remote Control bridge
automatically each session"). Agent Flow therefore enables the feature by writing
that key to the **global** Claude settings file, and tracks whether it was the one
that wrote it so it can put things back.

## Decisions

| Question | Decision |
|----------|----------|
| How is Remote Control enabled? | Write `remoteControlAtStartup: true` to Claude's **global** settings (`$CLAUDE_CONFIG_DIR ?? ~/.claude` + `/settings.json`). The VS Code panel reads it at session start. |
| Setting shape? | `agentFlow.remoteControl`: `"off" \| "on" \| "ask"`, default `"off"` — the same tri-state shape as `agentFlow.worktree`. |
| Turning it back off? | **Ownership tracking.** Agent Flow records that it set the key, plus the value that was there before, and restores that prior value on `off` / `ask`+No. A value you set by hand is never overwritten or cleared. |
| Ask cadence? | **Once per launch action.** A parallel batch of N tasks asks once, not N times — all N sessions share the same global key, so a per-task answer could not be honored. |
| Dismissing the prompt? | **Escape means "no", not "cancel."** The launch proceeds without Remote Control. |
| Which launch paths? | All of them — Take, Explore, Address PR, and parallel batch launch. |
| Write mechanism? | `jsonc-parser` `modify`/`applyEdits`, preserving the user's formatting and comments. An unparseable file means no write. |

## Approach rationale

- **Global scope, deliberately.** Per-folder `.claude/settings.local.json` would
  scope the change to exactly the sessions Agent Flow opens, but it persists in
  permanent checkouts and silently changes `claude` runs the user starts there by
  hand. Global is one place, always effective, and honest about its reach — at the
  cost of also covering sessions Agent Flow did not start. That cost is documented
  in the setting's own description rather than left to be discovered.
- **Ownership tracking over "set and never revert."** The naive version leaks:
  turn the feature on once and every Claude session on the machine is remote-
  controlled until the user notices and edits their settings by hand. Recording
  ownership makes `off` mean off, while still refusing to stomp a value the user
  set themselves.
- **Storing the prior value, not just clearing.** If the user had an explicit
  `remoteControlAtStartup: false`, reverting by deleting the key would leave the
  same behavior but quietly erase their stated preference. Restoring the recorded
  prior value — including "the key was absent" — leaves the file as it was found.
- **`jsonc-parser` over parse-and-rewrite.** A real `~/.claude/settings.json`
  carries permissions, hooks, plugins, and a statusline. `JSON.parse` +
  `JSON.stringify` would reformat all of it. This mirrors the existing
  `mergeReposIntoWorkspace` treatment of `.code-workspace` files, including its
  failure posture: on a parse error, return without writing.
- **`CLAUDE_CONFIG_DIR` honored.** Claude Code resolves its config directory
  through that variable; a hardcoded `~/.claude` would silently write to a file
  nothing reads for anyone who sets it.
- **Once per launch action.** Because the key is global, the answer cannot be
  per-session — the last write would win for every session in a batch. Asking once
  per action is the granularity the mechanism can actually honor.

## Components

### 1. Setting — `package.json` + `src/config.ts`

`package.json`, alongside the other launch settings:

```json
"agentFlow.remoteControl": {
  "type": "string",
  "enum": ["off", "on", "ask"],
  "enumDescriptions": [
    "Never enable Remote Control",
    "Every session Agent Flow launches starts with Remote Control on",
    "Ask once each time you launch"
  ],
  "default": "off",
  "markdownDescription": "Start Claude Code's **Remote Control** bridge for sessions Agent Flow launches, so you can drive them from claude.ai or the Claude mobile app. This works by setting `remoteControlAtStartup` in your **global** Claude settings — while it is on, Claude sessions you start yourself are remote-controlled too. Agent Flow restores the previous value when you set this back to `off`."
}
```

`src/config.ts`: add `remoteControl: "off" | "on" | "ask"` to `AgentFlowConfig`, and
resolve it against the enum rather than with a bare `||` fallback — a stale or
hand-edited value like `"true"` must land on `off`, not flow through untyped:

```ts
remoteControl: (() => {
  const v = c.get<string>("remoteControl");
  return v === "on" || v === "ask" ? v : "off";
})(),
```

### 2. New module — `src/engine/remoteControl.ts`

No `vscode` import, so it unit-tests against a temp directory like `worktree.ts`:

```ts
/** Claude Code's global settings file, honoring CLAUDE_CONFIG_DIR. */
export function claudeSettingsPath(): string;

/** Current value of remoteControlAtStartup — undefined if absent or unreadable. */
export function readRemoteControlAtStartup(file: string): boolean | undefined;

/** Set (or, with `undefined`, remove) remoteControlAtStartup, preserving the
 *  file's formatting and comments. Returns false if the file can't be parsed
 *  or written — the caller degrades, it never throws. */
export function writeRemoteControlAtStartup(file: string, value: boolean | undefined): boolean;
```

A missing file is created with `{ "remoteControlAtStartup": true }`; a missing
parent directory is created with `mkdirSync(..., { recursive: true })`.

### 3. Ownership state + sync — `src/engine/remoteControl.ts`

One `globalState` record under `agentFlow.remoteControlOwned`:

```ts
interface RemoteControlOwnership {
  owned: boolean;                       // Agent Flow wrote the current value
  prior: boolean | undefined;           // what was there before (undefined = key absent)
}
```

The single entry point both the launch paths and the config listener call:

```ts
/** Bring the global Claude setting in line with `mode`. `ask` consults `confirm`
 *  (omitted by the config listener, which treats `ask` as "leave alone").
 *  Returns whether Remote Control is on for sessions started from here. */
export async function syncRemoteControl(
  state: OwnershipStore,                       // thin wrapper over context.globalState
  mode: "off" | "on" | "ask",
  confirm?: () => Promise<boolean>,
): Promise<boolean>;
```

Resolution:

| Mode | Behavior |
|------|----------|
| `on`, `ask`+Yes | Already `true` → nothing. Otherwise record `prior`, write `true`, `owned = true`. |
| `ask`+No, `off` | `owned` → restore `prior` (removing the key when `prior` is `undefined`), `owned = false`. Not owned → leave the file alone. |
| `ask` with no `confirm` | Leave the file alone (the config-listener case). |

Called at each launch — which also catches a settings file edited out of band —
and from an `onDidChangeConfiguration` listener in `extension.ts`, so flipping the
setting to `off` takes effect immediately rather than at the next launch.

### 4. Launch integration — `src/tasksView.ts`

A private helper wraps the QuickPick and the sync:

```ts
/** Resolve Remote Control for this launch action. Called once per action —
 *  a batch of N tasks asks once, since all N share the global key.
 *  Returns whether sessions started from here are remote-controlled. */
private async resolveRemoteControl(cfg: AgentFlowConfig): Promise<boolean>;
```

The `ask` picker, styled like the existing worktree prompt:

```
┌────────────────────────────────────────────────────────────────┐
│ ABC-12 — enable Remote Control for this session?               │
├────────────────────────────────────────────────────────────────┤
│ 📡 Enable Remote Control                                        │
│    Drive this session from claude.ai or the Claude mobile app   │
│ ⊘  Local only                                                   │
│    No remote bridge                                             │
└────────────────────────────────────────────────────────────────┘
        Escape → Local only (the launch continues)
```

Escape resolves to "no" rather than aborting: by the time this prompt appears in
`launch()`, worktrees have already been created, and cancelling the whole launch
over an optional toggle is the worse failure.

Three call sites, each immediately before `openWorkspace`:

| Path | Site |
|------|------|
| Take + Address PR | `launch()` — `src/tasksView.ts:590` |
| Explore | `explore()` — `src/tasksView.ts:415` |
| Parallel batch | `takeBatch()` — `src/tasksView.ts:705`, once **before** the loop |

### 5. Known limitation (documented, not fixed)

Opening into an already-live window (the `pick-existing` and `live-folder`
targets) seeds a Claude Code session that may already be running. That session
does not re-read the global setting; the change applies to the next session
started in that window. Fixing it would require a per-session toggle the Claude
Code extension does not expose. This goes in the README, not in code.

## Testing

- **Module unit** (`test/unit/engine/remoteControl.test.ts`), against a temp dir:
  - `claudeSettingsPath()` honors `CLAUDE_CONFIG_DIR` and falls back to `~/.claude`.
  - Writing into a populated settings file preserves the other keys, the
    formatting, and comments.
  - `read` returns `true` / `false` / `undefined` for present, present-false, and
    absent keys.
  - Missing file and missing parent directory are created.
  - An unparseable file returns `false` and leaves the bytes untouched.
- **Ownership unit** (same file, fake store):
  - `on` records `prior` and writes `true`; a second `on` is a no-op.
  - `off` with `owned` restores `prior` — both the `false` case and the
    absent-key case.
  - `off` without `owned` leaves a hand-set `true` alone.
  - `ask` without `confirm` never writes.
- **Config unit** (`test/unit/config.test.ts`): default is `"off"`; each enum
  value round-trips; an unknown value falls back to `"off"`.
- **Host unit** (`test/unit/tasksView.test.ts`):
  - `off` never shows the picker.
  - `on` enables without a picker.
  - `ask` shows the picker exactly once for a batch of N tasks.
  - Escaping the picker does not enable, and the launch still proceeds.
- **Manual / end-to-end:**
  1. Set `ask`, take a task, choose Enable → the new session shows Remote Control
     active and appears on claude.ai.
  2. Set the setting back to `off` → the key is gone from `~/.claude/settings.json`.
  3. Set `remoteControlAtStartup: true` by hand, then set Agent Flow to `off` →
     the hand-set value survives.
  4. Launch 3 tasks in parallel with `ask` → one prompt, all three remote-controlled.

## Out of scope

- No per-session or per-repo scoping — the mechanism Claude Code exposes is a
  global setting, and that is the scope this ships with.
- No Remote Control session naming (`--remote-control-session-name-prefix`).
- No retrofitting an already-running session in a live window (see §5).
- No Deck surfacing of which in-flight sessions are remote-controlled.
- No CLI-based launch path (`claude --remote-control`) — Agent Flow keeps seeding
  through the Claude Code panel.
