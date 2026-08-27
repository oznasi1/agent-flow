# Orchestrator: instructing an agent, and notifying a human — design

**Date:** 2026-08-09
**Status:** approved, ready to plan
**Found by:** manual testing of the Phase 4 build in a dev host

## The two problems

**1. You cannot tell a launched or seeded agent anything.**

An acting rule's only expressive control is `mode` — one of the configured prompt modes. There is no free text anywhere on the path from the drawer to the agent.

It is worse for `seed` than for `launch`. A seeded agent receives (`deckView.ts:829-858`) the mode's canned template, interpolated with the *place's run* key/summary/url, and a `{brief}` that resolves to **the brief the first agent was already given** — `planMd` and `descriptionText` are deliberately empty, because a seed has no ticket of its own. So the only thing a user can say to a second agent joining a worktree is which of six canned modes to use. It inherits the first agent's instructions and cannot be told why it is there.

For `launch` the ticket description becomes the brief, so the ticket carries intent — but there is still no way to add "and this time, focus on X".

**2. `notify me` does not say who, and reaches almost nobody.**

`notifyLines`' output is posted as a webview toast (`deckView.ts:588-590`). Not a VS Code notification, not Slack. It appears only if the Deck panel is open and the user is looking at it. For a feature whose premise is unattended work on a six-second poll, that is the wrong delivery. The message *text* is not the problem — it lives on the notify node and is authored by the user.

The same flaw applies to **failure receipts**, which matter more: `Couldn't create a git worktree in bite-me — not launching PROJ-12` currently dies inside an unfocused panel.

## Decisions

### The instruction lives on the rule

`FlowEdge` gains `note?: string`. Optional and additive, and the store was designed for exactly this: `validEdge` (`store.ts:56-66`) checks only the required fields, and the comment above it states the intent outright — "unknown fields must ride along untouched so a newer build's flow survives an older build rewriting it." `coerceFlow` spreads the parsed record rather than rebuilding it (`:95`). So an existing flow file stays valid, and a note written by this build survives a downgrade. No existing field changes meaning.

On the **rule**, not the node, because the instruction describes the transition — which is what the user authors. `mode` already lives on the edge for `seed`, so this follows the established shape. Two rules into one node can each say something different, which is correct: they are different events.

Applies to `launch` and `seed`. `notify` does not get one — the notify node's `message` already is its text.

### Reusable instructions already exist. Do not build a third surface.

`agentFlow.promptModes` is fully user-extensible — its own setting description says "Add your own (e.g. a `spike` mode). Your entries **layer over** the built-in modes." Each is `{id, label, detail?, prompt}`, and an orchestrator rule already picks one in `USING`. So a saved, named, reusable instruction is expressible today.

The two compose, and cover different needs:

- **mode** — the reusable named instruction, shared across every rule and flow
- **note** — what is specific to this transition, authored once and stored in the flow file

Without the note, a user needs a separate mode per combination ("TDD", "TDD on staging", "TDD on prod"). Together they pick `TDD` and add `on staging`. A note that turns out to be worth reusing is promoted to a mode with a two-line settings edit.

**Explore is the wrong pattern to copy**, though it looks superficially right. `EXPLORE_ACTION_DEFS` is a *fixed* set of built-in actions whose prompt text is editable via `explorePrompts.<id>`; users cannot add their own. And `ExploreAction.needsEnv` means the action **collects the environment from the user at use time** — an armed rule fires while nobody is present, so there is nothing to collect from. That mechanism cannot work unattended.

### A typed instruction must never silently vanish

One pure function, shared by both acting paths:

```ts
composeAgentPrompt(template: string, note?: string): string
```

- `{note}` present in the template → substitute there, so a mode author controls placement.
- No `{note}` but a note exists → append under a clear heading.
- No note → return the template unchanged, so current behaviour is byte-identical.

The append fallback is the point: a user's instruction disappearing because their customised template lacks a placeholder would be the worst outcome available.

A note containing brace sequences of its own must not be re-interpolated — substitute once, and do not feed the result back through `renderPrompt`.

`deckView` already resolves `mode.prompt` before both `launchPlanned` and the seed's `openWorkspace`, so composition happens at those two call sites. **Neither `launchPlanned` nor `openWorkspace` changes signature.**

`{note}` joins the documented placeholder list in `agentFlow.promptModes`' description, since it becomes real.

### UI

A single-line input under `USING`, in the canvas inspector and in an open list row — one control expressed once through the shared rule module (`src/webview/orchestratorRule.ts`), not two implementations. Closed list rows show the note truncated after the mode, so a rule's full intent reads at a glance.

The mode and note controls sit adjacent and mean different things, so the copy has to earn that distinction: the note's placeholder names it as extra, once-off text rather than a second mode.

House rules unchanged: monospace for identifiers and counts only; red only for a real failure; **Arm remains the only filled control on the surface**; no persistent hint lines.

### The spend confirmation shows the note

The first-launch modal names the ticket, repos and prompt mode. When a note exists it is shown there too. That modal is the consent gate for spending money unattended, and what the agent will actually be told is material to consent.

### Notification delivery

- `notify` → `vscode.window.showInformationMessage`. It persists in the Notifications bell, so a rule that fires while the user is elsewhere stays discoverable.
- **Failed** actions → a notification as well. This is the class of message that must not be missed.
- **Successful** actions → stay Deck toasts. A successful launch already announces itself by opening a window; a notification on top is noise.

## Testing

- `composeAgentPrompt` is pure: the placeholder path, the append path, an absent note, an empty-string note, and a note containing `{brief}`-style braces that must survive uninterpolated.
- A fired `notify` calls `showInformationMessage` and does **not** post a toast.
- A failed action notifies; a successful one does not.
- The spend modal includes the note when present, and reads correctly when absent.
- Per this project's record — six plan-authored tests were found vacuous across earlier phases — **every guard above needs a test that fails when the guard is removed**, verified by mutation, not by inspection.

## Out of scope, and what was learned about it

### `tell` — injecting into a running session

The user's stronger idea: rather than always creating a session, a rule should type a prompt into the agent **already running** in a place, so a workflow can drive one session instead of spawning several.

**This is now possible, and it was not when the orchestrator was designed.** The original spec's central constraint — Agent Flow can launch a session with a prompt pre-filled but cannot type into a running one — was true for the Claude Code panel and is no longer true universally, because `main` added the terminal surface. `seedViaTerminal` (`workspace.ts:734-757`) already does exactly this for a *new* terminal:

```ts
const terminal = vscode.window.createTerminal({ name: `Claude · ${key}`, cwd });
terminal.sendText(CLI_CMD, true);
await delay(CLI_BOOT_MS);
terminal.sendText(bracketedPaste(seedText), false);
```

Reaching an *existing* session is a few lines on machinery that already exists (`bracketedPaste` exists precisely so multi-line text pastes without prematurely submitting):

```ts
const t = vscode.window.terminals.find((t) => t.name === `Claude · ${key}`);
if (t && !t.exitStatus) { t.show(); t.sendText(bracketedPaste(text), false); }
```

Nothing in the codebase currently reads `vscode.window.terminals` or `exitStatus`.

**Four constraints a design must resolve:**

1. **Terminal surface only.** `agentSurface` defaults to `extension`, where the session lives in the Claude Code panel and no API can type into a running one — the seed path can only *open* with a prompt, then fall back to a URI handler, then the clipboard. A `tell` rule is unfirable on the default surface, so the UI must say so rather than let users wire rules that silently never fire.
2. **Same window only.** `vscode.window.terminals` sees only terminals this window created, while the flows directory is global. An armed flow in one window cannot reach a session in another.
3. **A safety hazard, and the reason this is a separate phase.** `exitStatus` reports that the *shell* exited; it does not report whether `claude` is still running inside it. If `claude` exited and the shell did not, `sendText` types the instruction **into a live shell, which executes it as a command**. An instruction like "delete the old migration" is not safe to hand to bash. No reliable way to detect "claude is at its prompt" is known yet, and finding one is a prerequisite, not an implementation detail.
4. **Ambiguity.** The terminal name is `Claude · <runKey>`; a seed can create a second terminal for the same run, so more than one can match.

Sequencing decision: ship this spec's work first, because it is small and unblocks the release. Design `tell` afterwards, with constraint 3 solved before any code is written.
