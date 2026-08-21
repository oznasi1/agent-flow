# Start a session with Cursor's agent, or be asked which agent every time

- **Date:** 2026-08-19
- **Branch:** `feat/cursor-agent-provider`
- **Base:** `origin/main` @ 38e178d (0.30.1)
- **Status:** Draft for review

## Problem

`agentFlow.agentProvider` offers two agents — Claude Code and GitHub Copilot
([2026-08-09 Copilot agent provider](2026-08-09-copilot-agent-provider-design.md)). Copilot
is VS Code only and degrades to Claude Code elsewhere, so **a Cursor user has exactly one
choice**: the workspace opens, the worktree is ready, the prompt is written, and the agent
they actually use — Cursor's own composer — is the one thing Agent Flow cannot start.

Separately, the provider is a single global preference. A user who moves between agents by
task ("this one's a Claude Code job, that one's a quick Cursor edit") has to visit settings
between takes. The Copilot spec rejected a per-take picker on the grounds that "the ask was
a preference, and it taxes every single take with a choice the user makes once". That
reasoning holds for a *default*; it does not hold for an *opt-in fourth value* that only
users who want the tax ever select.

Claude Code stays the default everywhere.

## Chosen approach

Two changes to one setting:

1. `agentFlow.agentProvider` gains **`cursor`** — Cursor's composer, Cursor-only, the exact
   mirror of `copilot` being VS Code only.
2. It gains **`ask`** — no fixed agent; every launch shows a picker over the agents the
   current host can run.

`agentFlow.agentSurface` is untouched and stays orthogonal. The six combinations are all
real:

|  | `extension` | `terminal` |
|---|---|---|
| `claude-code` | Claude Code panel *(default)* | `claude` in a terminal |
| `copilot` | Copilot Chat panel | `copilot` in a terminal |
| `cursor` | Cursor composer tab | `cursor-agent` in a terminal |

Under `ask`, the picker chooses the row and `agentSurface` still chooses the column.

### Key finding: Cursor registers the command we already call

Cursor's workbench registers **`workbench.action.chat.open`** — the same command id the
Copilot path already uses. Read directly from
`/Applications/Cursor.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js`:

```js
Ni.registerCommand("workbench.action.chat.open", async (e, t) => {
  const s = typeof t == "string" ? t : t?.query,
        o = await n.createComposer({ partialState: s ? { text: s, richText: s } : void 0,
                                     openInNewTab: true });
  ...
  s && r.fireShouldForceText({ composerId: a });
  await i.showAndFocus(a);
});
```

Three consequences:

- It accepts `{ query }` (or a bare string) and sets the composer text **without
  submitting** — exactly the "we pre-fill, you press Enter" contract in
  [`src/engine/workspace.ts`](../../../src/engine/workspace.ts).
- It ignores `isPartialQuery` and `mode`. Harmless: prefill-without-submit is its default,
  so the argument object the Copilot path already sends works unmodified.
- `openInNewTab: true` means **each call opens its own composer tab**. Cursor therefore gets
  the per-task batch behavior that `seedCopilotPanel` had to abandon, because Copilot's chat
  panel is single-instance and a batch would overwrite its own prompt N times.

Cursor also registers `deeplink.prompt.prefill`, which is **not** used here: it raises a
"Create chat with prompt" confirmation modal before doing anything, which is worse than the
clipboard fallback that already exists.

### Rejected alternatives

- **Resolving `ask` in the target window at seed time**, which would preserve the rule that
  the provider is never carried in the plan file. Rejected: `openWorkspace` returns before
  the new window activates, a batch would fire N pickers across N windows, and the target
  window may not be focused.
- **Resolving `ask` at each of the six `openWorkspace` call sites.** Keeps the QuickPick out
  of the engine layer and makes each path explicit, but the invariant "every path resolves
  before calling" would be enforced only by review — a seventh call site would silently get
  no picker.
- **Remembering the `ask` choice for the window session.** Rejected: the memory is invisible
  (you cannot tell what it will pick without launching), it dies unpredictably on reload,
  and it diverges from `workspaceMode: ask` and `exploreMode: ask`, which are both stateless.
- **A separate `agentFlow.askAgentEveryTime` boolean** alongside the enum. Rejected: two
  settings that can contradict each other (`copilot` + ask?) where one four-value enum
  cannot.

## Settings and types

### `agentFlow.agentProvider` — widened

| Value | Meaning |
|---|---|
| `claude-code` | Claude Code (default, works everywhere) |
| `copilot` | GitHub Copilot — **VS Code only** |
| `cursor` | Cursor's composer — **Cursor only** |
| `ask` | Pick per launch, from the agents this host can run |

The description must state what a user would otherwise learn the hard way: that
`copilot` and `cursor` are ignored outside their host, and that **neither Copilot nor Cursor
sessions appear as live agents on the Deck**, which reads Claude Code's session files.

The `"when": "agentFlow.host.vscode"` clause is **removed**. It exists so the Copilot choice
does not render in Cursor, but Cursor users now need this setting more than anyone. That
makes the `agentFlow.host.vscode` context key in
[`src/extension.ts`](../../../src/extension.ts) dead, and it is removed with it. VS Code
cannot hide individual enum values, so `copilot` and `cursor` both render in every host and
the **runtime guard is what makes them correct** — the same trade the Copilot spec accepted,
now applying in both directions.

### Types

```ts
export type AgentProvider = "claude-code" | "copilot" | "cursor";  // a real agent
export type AgentProviderSetting = AgentProvider | "ask";          // what the setting holds
```

Keeping `ask` out of `AgentProvider` is deliberate: `providerLabel(p: AgentProvider)` and
the `CLI` record stay total, so no copy site or lookup has to invent a value for "ask".

### Host detection

`isVSCodeHost()` gains two siblings in [`src/config.ts`](../../../src/config.ts):

```ts
export function isCursorHost(): boolean {
  return (vscode.env.uriScheme ?? "") === "cursor";
}

/** The agents this host can actually start, in picker order. */
export function hostProviders(): AgentProvider[] {
  return [
    "claude-code",
    ...(isVSCodeHost() ? ["copilot" as const] : []),
    ...(isCursorHost() ? ["cursor" as const] : []),
  ];
}
```

`readAgentProvider` is replaced by `readAgentProviderSetting`, which returns
`AgentProviderSetting`:

- `copilot` outside VS Code → `claude-code` (today's behavior, unchanged)
- `cursor` outside Cursor → `claude-code` (the mirror rule)
- `ask` → `ask`
- anything unrecognized, including `undefined` → `claude-code`

`cfg.agentProvider` becomes `AgentProviderSetting`.

## How the resolved choice travels

`OpenRequest`, `PlanFile`, and `OpenResult` each gain a `provider` field:

```ts
interface OpenRequest { provider?: AgentProvider; /* … */ }  // caller pins the agent
interface PlanFile    { provider?: AgentProvider; /* … */ }  // present ONLY when ask resolved it
interface OpenResult  {
  provider: AgentProvider;   // what actually got seeded
  cancelled?: true;          // picker dismissed; nothing was opened
  /* … */
}
```

`openWorkspace` resolves the provider **once, before it opens or writes anything**:

```
if (!seedAgent)                      → no picker; provider is irrelevant
else if (req.provider)               → use it, no picker      (batch, orchestrator)
else if (setting !== "ask")          → use the setting, no picker
else                                 → QuickPick over hostProviders()
                                        cancelled → return { cancelled: true, … }
```

The resolved value is written into the plan file **only when `ask` produced it**. For the
three fixed settings the field stays absent and the target window reads the setting live at
seed time, byte-identical to today. The rule the terminal-surface and Copilot specs
established — *a live preference, not a stale snapshot* — is preserved everywhere except
the one case where it cannot be, because there is no preference left to read.

### The two deliberate opt-outs

**Batch** resolves once before its loop and passes `provider` to all N calls, so a batch of
twelve asks once, not twelve times. This follows the precedent already sitting in that loop
for `workspaceMode`: *"The loop stays non-interactive, so the 'ask' setting can't be honoured
here"* ([`src/tasksView.ts`](../../../src/tasksView.ts)).

**Orchestrator** rules launch unattended — the code already refuses to fall back to the main
checkout there because *"nobody is watching an unattended launch"*
([`src/engine/orchestrator/launch.ts`](../../../src/engine/orchestrator/launch.ts)). A modal
picker would block a rule on a dialog no one sees, so orchestrator passes `"claude-code"`
explicitly. The setting description states this.

### Cancellation

The picker runs before any window, worktree, or brief work, so cancelling means **nothing
happens at all**. `openWorkspace` returns early with `cancelled: true` and otherwise empty
fields, and the five interactive call sites add `if (result.cancelled) return;`.

This is the one real cost of resolving inside `openWorkspace` rather than at each call site,
and it is named rather than hidden. It buys the structural guarantee that a future call site
gets the picker for free instead of silently skipping it.

## Seeding Cursor

`seedAgentSession` resolves its provider through one total function, so the `CLI` record and
`providerLabel` — both keyed by `AgentProvider` — can never be handed an `"ask"`:

```ts
/** The agent to seed with, in the target window at seed time. A plan carries `provider`
 *  only when `ask` resolved it in the source window; otherwise the setting is read live,
 *  which is what makes flipping the preference affect plans already on disk. A bare `ask`
 *  reaching here means the plan predates its own resolution (a settings flip inside the
 *  15-minute PLAN_TTL_MS window), so it degrades to the one agent every host can run. */
function seedProvider(plan: PlanFile): AgentProvider {
  if (plan.provider) return plan.provider;
  const setting = readAgentProviderSetting();
  return setting === "ask" ? "claude-code" : setting;
}
```

That last branch is reachable, not theoretical: a plan written under `claude-code` can sit
on disk while the user switches the setting to `ask`, and the plan is re-read at seed time.
Degrading beats prompting in a window the user did not expect a dialog in.

### Extension surface

`seedCopilotPanel` generalizes to `seedChatPanel(provider, seedText, key, log, multi)`. Same
`workbench.action.chat.open` command, same activation-race polling (7 attempts × 700ms —
Agent Flow and the chat extension both activate on `onStartupFinished`), same
try-exactly-once-then-fall-through once the command is registered.

The single behavioral fork is `multi`:

| | `multi` batch |
|---|---|
| `copilot` | Bails immediately → briefs fallback (single-instance panel would self-overwrite) |
| `cursor` | Proceeds — `createComposer({ openInNewTab: true })` gives one composer tab per task |

### Terminal surface

`CLI` gains a third row:

```ts
cursor: { cmd: "cursor-agent", label: "Cursor", bootMs: 2000 },  // UNVERIFIED
```

Consistent with the fixed-command policy already documented on that record: a missing binary
shows as `command not found` in the terminal, which is self-explanatory and leaves the
pre-typed prompt there to reuse. Worth knowing that unlike `claude`, **`cursor-agent` is not
installed alongside Cursor** — it is a separate install — so this fallback will be hit more
often than the others.

### Remote Control

Remote Control is Claude Code only. Three changes:

1. The last-moment refusal in `seedAgentSession` widens from `=== "copilot"` to
   `!== "claude-code"`.
2. Under a fixed `copilot` or `cursor` setting, the existing tasksView pre-flight refusals
   apply unchanged, extended to cover `cursor`.
3. Under `ask` the provider is unknown at pre-flight, so **nothing is refused up front**.
   Instead `openWorkspace`'s existing computation
   `remoteControl = !!req.remoteControl && seedAgent && matches.length === 1`
   gains `&& provider === "claude-code"`.

Point 3 costs no new user-facing message: `OpenResult.remoteControl` already feeds
`seededNote`, so picking Cursor with Remote Control on silently drops it *and the toast
already says so*. Dropping is right where refusing is wrong — the user made an interactive
choice a moment ago and a hard error telling them to re-take the task would punish them for
using the feature as designed.

## Copy

`OpenResult.provider` splits the ~15 `providerLabel(cfg.agentProvider)` sites in two:

- **Post-launch** — `seededNote`, the Deck's review toast, `reviewProvenance` — switch to
  `result.provider`. `seededNote` already takes `provider: AgentProvider` as a parameter, so
  callers only change what they pass. This is **strictly more accurate than today**: it
  names the agent that actually started rather than the setting's value.
- **Pre-launch** — the batch confirmation's "That's N Claude Code sessions", the brief's
  agent name via `briefMarkdown` — have no concrete provider under `ask` and degrade to
  neutral wording ("N agent sessions", "your coding agent").

Under the three fixed setting values every string stays byte-identical.

## Doctor

`DoctorInputs.agentProvider` widens to `AgentProviderSetting`. The existing `copilotChat`
probe checks **command registration of `workbench.action.chat.open`**, which is the same
command Cursor registers — so it generalizes to `chatCommand: { available: boolean }` with
no change to the probe itself, only to the row's label.

| Setting | Rows |
|---|---|
| `claude-code` | Claude Code rows (today) |
| `copilot` | Chat-command row + `claudeSessionChecks` |
| `cursor` | Chat-command row + `claudeSessionChecks` |
| `ask` | Union for the current host |

`cursor` gets `claudeSessionChecks` for the same reason `copilot` does: **Cursor composer
sessions do not appear on the Deck**, which reads Claude Code's session files, and the Deck
rows still need to explain themselves.

## Telemetry

`AGENT_PROVIDERS` in [`src/telemetry/settingsSnapshot.ts`](../../../src/telemetry/settingsSnapshot.ts)
gains `"cursor"` and `"ask"`. `enumOrInvalid` handles everything else. No new events, no new
properties.

## Testing

Repo gates, all four required: `npm run typecheck`, `npm test`, `npm run test:cov`
(thresholds enforced), `npm run build`. The build is the only gate that catches a `vscode`
or `fs` import leaking into a webview bundle; typecheck and the full suite pass regardless.

**The existing suite must pass unmodified.** Every new behavior is inert under the three
current setting values, and that is the property the existing tests are there to hold.

New coverage:

- `readAgentProviderSetting` across the host-degradation matrix — 3 hosts (VS Code, Cursor,
  other) × 4 values, plus `undefined` and a garbage string.
- `hostProviders()` per host.
- The picker fires **only** when `seedAgent && !req.provider && setting === "ask"`; each of
  the three negatives is its own test.
- `PlanFile.provider` is written under `ask` and **absent** under each fixed value.
- Cancel returns `cancelled: true` and opens nothing — no window, no worktree, no brief.
- `plan.provider` beats a conflicting live setting at seed time.
- `cursor` + `multi` takes the per-tab path; `copilot` + `multi` still bails to briefs.
- Remote Control drops (not refuses) when `ask` resolves to `cursor` or `copilot`, and the
  toast reflects it.
- Doctor rows per setting value, including the `ask` union.
- Telemetry enum accepts `cursor` and `ask`.

## Out of scope

- **Verifying `bootMs` and the chat-command argument shape in a real editor.** Copilot's
  values have never been run in an editor, and Cursor's `bootMs` is a guess. Cursor's
  extension path is the better-evidenced of the two — its handler was read directly from the
  workbench bundle — but reading source is not running it. A dev-host verification pass in
  Cursor is a task in the implementation plan, not something this design closes.
- **Making Cursor sessions appear on the Deck.** The Deck reads Claude Code session files;
  surfacing Cursor composers is a separate piece of work with its own discovery problem.
- **Per-repo or per-task provider overrides.** `ask` covers the by-task case; a persisted
  per-repo mapping is speculative until someone asks for it.
- **The `deeplink.prompt.prefill` rung.** Its confirmation modal makes it worse than the
  clipboard fallback it would sit above.
