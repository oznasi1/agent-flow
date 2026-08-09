# Start a session with GitHub Copilot instead of Claude Code

- **Date:** 2026-08-09
- **Branch:** `worktree-copilot-agent-provider`
- **Status:** Draft for review

## Problem

Agent Flow can start a session in two places — the Claude Code extension panel or the
`claude` CLI in an integrated terminal — chosen by `agentFlow.agentSurface`
([2026-08-08 terminal agent surface](2026-08-08-terminal-agent-surface-design.md)). Both
run **Claude Code**. A VS Code user whose coding agent is GitHub Copilot has no way to land
a taken task in it: the workspace opens, the worktree is ready, the prompt is written, and
then nothing they use lights up.

Cursor ships its own agent and no Copilot. The Copilot choice is therefore meaningless
there and should not be offered.

Claude Code stays the default everywhere.

## Chosen approach: split the one setting into two axes

The destination is now two independent questions — **which agent** and **where it runs** —
and the four combinations are all real:

|  | `extension` | `terminal` |
|---|---|---|
| `claude-code` | Claude Code panel *(today's default)* | `claude` in a terminal *(ships today)* |
| `copilot` | Copilot Chat panel, agent mode | `copilot` in a terminal |

So `agentFlow.agentSurface` keeps its exact key and values and gains a sibling,
`agentFlow.agentProvider`. Nothing migrates; every existing user's stored value keeps its
current meaning and behavior.

The fork still happens in the single seeding chokepoint. Every launch path — take a task,
batch launch, Deck relaunch, Explore, Notepad, PR review — funnels through `writePlanFile`
→ `runSeedPass` → `seedClaudeCode` in
[`src/engine/workspace.ts`](../../../src/engine/workspace.ts). That function is renamed
`seedAgentSession`, resolves `(provider, surface)`, and dispatches. **No call site
changes.**

Both settings are read **at seed time**, in the target window, never carried in the plan
file — the rule established by the terminal-surface work. Flipping either setting therefore
also affects plans already on disk, which is what a preference should do.

### Rejected alternatives

- **One four-value enum** (`extension | terminal | copilot | copilot-terminal`). Rejected:
  the values conflate two independent axes, so `extension` would quietly come to mean
  "Claude Code panel"; VS Code cannot hide individual enum values, so Cursor users would
  see two dead options; and a third agent would mean six values.
- **A per-take picker in Agent Flow's own UI.** Rejected: it gives total control over what
  renders in Cursor, but the ask was a preference, and it taxes every single take with a
  choice the user makes once.
- **Reading the provider from the plan file.** Rejected for the same reason the surface
  isn't: it turns a live preference into a stale snapshot.

## The settings

### `agentFlow.agentProvider` — new

Enum, default `"claude-code"`.

| Value | Meaning |
|---|---|
| `claude-code` | Claude Code (today's behavior) |
| `copilot` | GitHub Copilot — **VS Code only** |

The description must state the two things a user would otherwise discover the hard way:
that the choice is ignored outside VS Code, and that **Copilot sessions do not appear as
live agents on the Deck** (see [Non-goals](#non-goals)).

Named `agentProvider` rather than `agent` because `agentFlow.seedAgent` and
`agentFlow.openAgents` already exist and a bare `agentFlow.agent` would read as a sibling
of those rather than as the partner of `agentFlow.agentSurface`.

### `agentFlow.agentSurface` — unchanged key and values

`extension` | `terminal`, default `extension`. Only the prose changes: the description and
`enumDescriptions` stop naming Claude Code, becoming *"the agent's chat panel"* and *"the
agent's CLI in an integrated terminal"*.

### Wiring

- `package.json` `contributes.configuration.properties` — the new enum +
  `enumDescriptions`, plus a `when` clause on `agentProvider` (see below).
- [`src/config.ts`](../../../src/config.ts) — `export type AgentProvider = "claude-code" |
  "copilot"`, `readAgentProvider(c?)`, and `AgentFlowConfig.agentProvider`. Any
  unrecognized value falls back to `claude-code`, matching `readAgentSurface`.
- [`src/telemetry/settingsSnapshot.ts`](../../../src/telemetry/settingsSnapshot.ts) —
  `AGENT_PROVIDERS` and `agent_provider: enumOrInvalid(cfg.agentProvider, AGENT_PROVIDERS)`
  alongside `agent_surface`.

## Hiding it in Cursor

Two independent mechanisms, because one is cosmetic and one is load-bearing.

**Load-bearing — the runtime guard.** `readAgentProvider()` returns `"claude-code"` unless
the host is in the VS Code family, whatever `settings.json` says. Settings sync carries
values between editors, so this is the mechanism that actually keeps behavior correct; the
setting degrades quietly instead of failing at seed time.

Host detection is on `vscode.env.uriScheme`: the VS Code family is `vscode` and
`vscode-insiders`, Cursor is `cursor`, Windsurf is `windsurf`. A **prefix match on
`vscode`** covers Insiders and exploration builds. `uriScheme` is preferred over
`env.appName` because it is not localized, and the seeding path already reads it.

**Cosmetic — the `when` clause.** A context key set at activation (via `setContext`) gates
the `agentFlow.agentProvider` contribution so the row does not render in Cursor's settings
UI. This is the only granularity VS Code offers — a `when` clause hides a whole setting,
never one enum value, which is precisely why the two axes had to be split.

> **Unverified.** Whether the Settings UI honors `when` clauses on configuration
> contributions must be confirmed in the dev host. If it does not, the fallback is wording
> in the description and nothing else in this design changes — the runtime guard is what
> makes behavior correct either way.

## Seeding mechanics

`seedClaudeCode` → `seedAgentSession`, which resolves the pair and dispatches four ways.

### Terminal, either provider

`seedViaTerminal` is parameterized by CLI command, terminal name, and boot delay; its
bracketed-paste handling, conditional `cwd`, and no-trailing-newline contract are unchanged.

| Provider | Command | Terminal name | Boot delay |
|---|---|---|---|
| `claude-code` | `claude` | `Claude · ${key}` | `CLI_BOOT_MS` = 1500 ms (verified) |
| `copilot` | `copilot` | `Copilot · ${key}` | new constant — **must be measured** |

The Copilot CLI is an interactive TUI like `claude`, so the existing pre-type-then-wait
shape transfers directly. Its boot time is the one value not derivable from the codebase
and gets the same "verified against version X" comment the Claude constant carries.

### Copilot chat panel

```
workbench.action.chat.open  { query, isPartialQuery: true, mode: "agent" }
```

`isPartialQuery: true` fills the input without submitting — the same "we pre-fill, you
press Enter" contract the Claude panel path honors. The command is polled with the existing
7 × 700 ms loop, because Agent Flow and the chat extension both activate on
`onStartupFinished` and the race is identical.

The fallback chain is **one rung shorter** than Claude's: command → clipboard. There is no
URI-handler step, because Copilot publishes no documented open-with-prompt URI.

### Batch

Claude Code's batch path opens one tab per task via `claude-vscode.editor.open`. Copilot's
chat panel is single-instance, so N prompts into it would overwrite each other. Batch
therefore attempts Copilot's **open-chat-in-editor** command once per task so each gets its
own tab, staggered by the existing `SEED_STAGGER_MS` loop.

This is the least-verified element of the design. If that command will not accept a
prefilled query, batch falls back to the existing "the briefs are in `.agentflow/`"
notification — the same degradation the flow already performs when no agent is reachable —
rather than overwriting one panel N times.

## Remote Control × Copilot is blocked

Remote Control seeds `/remote-control <key>`, a Claude Code slash command with no Copilot
equivalent. The combination is refused, checked in two places:

- **Pre-flight, at take time.** `remoteControlForLaunch`
  ([`src/tasksView.ts:1275`](../../../src/tasksView.ts)) already resolves once per launch.
  If it resolves on while the provider is Copilot, the take aborts with an error naming
  both settings — **before** any workspace opens, so the user is not left with an open
  window and nothing in it.
- **At seed time, as a backstop.** A plan file can outlive a settings flip, so
  `seedAgentSession` refuses to seed the same combination and logs why.

## Doctor

`DoctorGroup` gains `"Copilot"`, and `claudeChecks` in
[`src/engine/doctor.ts`](../../../src/engine/doctor.ts) dispatches on the configured
provider, so a user only sees checks for the agent they actually use.

Under `copilot`, one row — *"Copilot Chat available"* — probed by whether
`workbench.action.chat.open` is registered, **not** by extension id: chat is built into
VS Code and Copilot ships bundled in some builds, so an id check would false-negative. A
failing row offers `github.copilot-chat` as its install action. The `CLAUDE_CODE_FLOOR`
version row is skipped, since that floor exists specifically for
`claude-vscode.editor.open`.

Because the provider always resolves to `claude-code` in Cursor, the Copilot group can
never appear there — no extra gating needed.

## Naming the agent

A `providerLabel(provider)` helper returns `"Claude Code"` or `"Copilot"`, applied to the
strings that name the agent at seed time:

- the two pre-seeded confirmations, [`src/tasksView.ts:1371-1372`](../../../src/tasksView.ts)
- the batch confirm, *"That's N Claude Code sessions"*, [`src/tasksView.ts:1582`](../../../src/tasksView.ts)
- the review-in-worktree message, [`src/deckView.ts:426`](../../../src/deckView.ts)
- the clipboard fallback, [`src/engine/workspace.ts:812`](../../../src/engine/workspace.ts)
- the Explore and batch tooltips, [`src/webview/App.tsx:508`](../../../src/webview/App.tsx)
  and [`:675`](../../../src/webview/App.tsx)

The webview cannot read configuration itself, so the label is posted in its state next to
`sourceLabel`.

One more is a factual claim rather than a tooltip: `REVIEW_PROVENANCE`
([`src/deckView.ts:44`](../../../src/deckView.ts)) writes *"Drafted with Claude Code via
Agent Flow Deck"* into PR review bodies. Under Copilot that sentence is false, so it becomes
provider-aware too.

## Testing

The suite mocks `vscode`; `env.uriScheme` becomes settable so host detection can be driven
from tests.

- `config.test.ts` — provider default, valid value, unrecognized value → `claude-code`; and
  `copilot` + a `cursor` uriScheme → `claude-code`, `copilot` + `vscode-insiders` →
  `copilot`.
- `workspace.test.ts` — each of the four `(provider, surface)` cells dispatches to the right
  mechanism and to nothing else; the Copilot panel call passes `isPartialQuery: true` and
  agent mode; the terminal path uses `copilot` and the Copilot terminal name; Remote Control
  + Copilot refuses to seed; batch attempts one chat editor tab per task and falls back to
  the brief notification when the command is absent.
- `settingsSnapshot.test.ts` — `agent_provider` reported, plus the two manifest-parity tests
  that already guard `agentSurface` (enum equality, `enumDescriptions` length).
- the doctor tests — the Copilot group replaces the Claude Code group under `copilot`, and
  the version-floor row is skipped.

Telemetry reports the **effective** provider, so a Cursor user with `copilot` in synced
settings reports `claude-code`. That is the honest answer: it is what ran.

## Repo gates

- `npm run typecheck`, `npm test`, and `npm run test:cov` (thresholds enforced).
- `npm run build` — not just `tsc`. `config.ts` is imported by webview code, and only the
  build catches a Node-only import leaking into `src/webview/`.
- `package.json` enum ↔ `config.ts` parity via the existing manifest-defaults test pattern.
- README setting table + CHANGELOG entry.
- ≥95% coverage on changed files.
- Version bump + a fresh `.vsix` on merge to main; remove the superseded one.

## Manual verification

In a VS Code dev host, launched with VS Code's own `code` CLI — the Cursor CLI silently
drops `--extensionDevelopmentPath`. Five things this design assumes and does not yet know:

1. `workbench.action.chat.open` accepts `{ query, isPartialQuery, mode }` and lands
   unsubmitted, in agent mode.
2. The `copilot` TUI's boot time, to pin its delay constant.
3. Which command opens a Copilot chat **editor tab** with a prefilled query, for batch.
4. Whether a configuration `when` clause hides the provider row in the Settings UI.
5. Regression: provider unset → the Claude Code panel behaves exactly as it does today.
   This is the path every existing user is on.

## Non-goals

- **Copilot sessions will not appear as live agents on the Deck.** Deck presence reads
  `~/.claude/sessions` and Claude transcripts; there is no Copilot equivalent. This is the
  largest functional gap in the feature, which is why it belongs in the setting's
  description rather than in a user's bug report.
- **Marketplace stays Claude-Code-only** — it browses `~/.claude/plugins`.
- **Remote Control stays Claude-Code-only**, blocked as above.
- **No `"ask"` third value** on either setting. A per-user preference, not a per-launch
  decision.
- **No configurable command or flags.** `claude` and `copilot`, fixed.
- Worktrees, workspace modes, `seedAgent`, and prompt modes are orthogonal and untouched.
