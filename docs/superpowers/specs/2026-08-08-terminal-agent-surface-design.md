# Open a session in the terminal instead of the Claude Code extension

- **Date:** 2026-08-08
- **Branch:** `terminal-agent-surface`
- **Status:** Draft for review

## Problem

Agent Flow starts every session in one place: the Claude Code **extension panel**.
`seedClaudeCode` in [`src/engine/workspace.ts`](../../../src/engine/workspace.ts) calls
`claude-vscode.primaryEditor.open` with the prompt pre-filled, and you press Enter to
start.

Some users don't work that way. They live in the `claude` CLI — for its keybindings, its
scrollback, or because they run it under their own shell setup — and Agent Flow currently
gives them no way to land a taken task there. The task opens, a panel they don't use lights
up, and they retype the prompt into a terminal by hand.

The surface should be a setting. The extension panel stays the default.

## Chosen approach: fork inside the single seeding chokepoint

Every launch path — take a task, batch launch, Deck relaunch, Explore, Notepad, PR
review — funnels through `writePlanFile` → `runSeedPass` → **`seedClaudeCode`**. That one
function is the only place that decides how a session starts, so it is the only place that
needs to change. Its current body becomes the `extension` branch; a new `seedViaTerminal`
becomes the `terminal` branch. **No call site changes.**

The seed always runs in the *target* window, and that window reads its own configuration.
So the surface choice never enters the plan file. Plan files are a cross-window handshake
carrying what the *launching* window decided (which repo, which prompt, whether Remote
Control); how a session is *presented* is a property of the machine you're sitting at.
Keeping it out means flipping the setting also affects plans already on disk — which is the
behavior a user expects from a preference.

### Rejected alternatives

- **Carry the surface in the plan file.** Rejected: it makes a live preference into a
  snapshot, so a plan written 10 seconds before you change the setting still opens the old
  surface, for no benefit.
- **A separate "Open in terminal" card action alongside the existing take.** Rejected: the
  user asked for a preference, not a second launch path. It would double every launch
  entry point on the Deck and the task pool.
- **Run `claude "<prompt>"` as one command.** Rejected: it starts the agent immediately,
  breaking the product's consistent "we pre-fill, you press Enter" contract — the one
  moment a user gets to read the prompt before it runs.

## The setting

`agentFlow.agentSurface` — enum, default `"extension"`.

| Value | Meaning |
|---|---|
| `extension` | Claude Code extension panel, prompt pre-filled (today's behavior) |
| `terminal` | `claude` in an integrated terminal, prompt pre-typed |

Description: *"Where Agent Flow starts a session: the Claude Code extension panel, or the
`claude` CLI in an integrated terminal. Either way the prompt is pre-filled and you press
Enter to start."*

Named `agentSurface` rather than `openSessionIn`/`openAgentIn` because `agentFlow.openIn`
already means **which window** — a second `open*In` key would read as a sibling of it.

Wiring:

- `package.json` `contributes.configuration.properties` — enum + `enumDescriptions`.
- `AgentFlowConfig` in [`src/config.ts`](../../../src/config.ts) — `agentSurface:
  "extension" | "terminal"`, read in `getConfig()` with `"extension"` as the fallback for
  any unrecognized value.
- [`src/telemetry/settingsSnapshot.ts`](../../../src/telemetry/settingsSnapshot.ts) —
  `agent_surface: enumOrInvalid(cfg.agentSurface, AGENT_SURFACES)`, alongside `open_in`.

## Terminal mode mechanics

```
createTerminal({ name: `Claude · ${key}`, cwd: match.matchPath })
terminal.show()
sendText("claude", true)                // run the CLI
await delay(CLI_BOOT_MS)                // the TUI must be ready to receive input
sendText(bracketedPaste(seedText), false)   // pre-typed, NO trailing newline
```

**One terminal per task**, named for the ticket, `cwd` set to that task's matched repo
path. A batch of three tasks produces three named terminals — mirroring the three tabs the
extension path produces. The existing `SEED_STAGGER_MS` loop in `runSeedPass` needs no
change.

**No trailing newline** on the prompt. You review it and press Enter, exactly as in the
panel.

### Multi-line prompts require bracketed paste

`renderPrompt` in [`src/engine/prompt.ts`](../../../src/engine/prompt.ts) appends
`\n\nRelevant files: …` whenever the task has file mentions, so **most real task prompts
are multi-line**. Sent raw to the CLI's TUI, the first newline submits — the agent would
start on a truncated prompt with the file list silently dropped.

So the prompt is wrapped in bracketed-paste markers:

```
\x1b[200~  <prompt text>  \x1b[201~
```

The terminal then delivers it as *pasted* text and the TUI keeps the newlines inline
instead of treating them as submissions. This is the same path a human takes pasting a
multi-line prompt into `claude` today, not a new mechanism. Applied unconditionally — it is
harmless for single-line prompts, and conditioning on `\n` would leave the rare
user-customized multi-line template broken.

`CLI_BOOT_MS` (~1500ms) is a new constant. It is the one value not derivable from the
codebase and **must be verified by hand in the dev host** — too short and the prompt is
typed into a TUI that isn't listening yet. Launch the dev host with VS Code's `code` CLI;
the Cursor CLI silently drops `--extensionDevelopmentPath`.

## Remote Control

Unchanged in substance. When `remoteControl` is active, the task prompt goes to the
clipboard and the session is seeded with `/remote-control <key>`; terminal mode types that
same string. `announceRemoteControl` is already a closure inside `seedClaudeCode`, so both
branches fire the identical "press Enter to connect, then ⌘V + Enter to start"
notification.

## Error handling

The extension path's three-step fallback chain (poll for the command → URI handler →
clipboard) exists because the Claude Code extension may not be activated yet. Terminal mode
has no equivalent race — `createTerminal` is synchronous and local.

- **`claude` not on PATH** — the shell prints `command not found`. Visible,
  self-explanatory, and the pre-typed prompt is still in the terminal to reuse. No
  preflight check, no Doctor entry.
- **`createTerminal`/`sendText` throws** — caught, logged, and falls through to the
  existing clipboard fallback with its "prompt copied" notification. Terminal mode can
  never leave a task with no way to start.

## Testing

The suite mocks the `vscode` module, so `window.createTerminal` becomes a spy returning a
fake terminal that records `sendText` calls. Following the existing `seedClaudeCode`
coverage:

- `terminal` surface → creates one terminal, named for the key, `cwd` = the matched path;
  `executeCommand` is never called.
- `extension` surface (the default) → today's behavior byte for byte; `createTerminal` is
  never called.
- the prompt's `sendText` passes `addNewLine === false`.
- a multi-line prompt arrives wrapped in `\x1b[200~` / `\x1b[201~`, with its newlines
  intact.
- `remoteControl` + terminal → clipboard holds the prompt, the terminal receives
  `/remote-control KEY`, and the notification fires.
- a batch of two due plans → two terminals with the two ticket names.
- `createTerminal` throwing → clipboard fallback runs; no unhandled rejection.
- an unrecognized `agentSurface` value → treated as `extension`.

## Repo gates

- `package.json` enum ↔ `config.ts` parity (the existing manifest-defaults test pattern).
- README setting table + CHANGELOG entry.
- ≥95% coverage on changed files.
- `npm run build` — not just `tsc`. Config is imported by webview code, and only the build
  catches a Node-only import leaking into `src/webview/`.
- Version bump + a fresh `.vsix` on merge to main; remove the superseded one.

## Out of scope

- **No `"ask"` third value.** This is a per-user preference, not a per-launch decision.
  Trivial to add later if anyone asks for it.
- **No configurable command or flags.** `claude`, fixed.
- **No Doctor preflight** for the CLI's presence.
