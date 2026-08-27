# Deck: derive `blocked`, and put a guardrail on `exited`

**Date:** 2026-08-27
**Status:** Design approved, not implemented
**Related:** `2026-08-17-deck-card-anatomy-design.md` (D3, which E3 feeds), `docs/mockups/2026-08-13-deck-vs-ao.html` (E3's brief), `docs/mockups/2026-08-27-e3-ux-deltas.html` (the before/after this design was approved against)

## Two decisions made in the approving session

Both are recorded here first because they are the design's only real judgement calls, and either can be reversed without touching anything else:

1. **The `Bash` ceiling is 720s.** 660s leaves 21s over the measured max of 639s — too thin against clock skew and a slow transcript flush. 900s is safer still but leaves the board's most common case reading wrong for a full fifteen minutes, which defeats the point. 720s is the 600s schema cap plus a two-minute margin.
2. **`pendingTool` renders on `stalled` as well as `blocked`.** The tool name is parsed either way, so `stalled · Bash · 4m` costs one render arm and is strictly more informative than today's `stalled · 4m`.

## Problem

E3's brief says a session stopped at a permission prompt "currently reduces to `idle`, so the one genuinely stuck card looks like the calmest thing on the board."

**That has not been true since 0.24.0.** That release shipped `stalled` and `exited` — its changelog entry reads "Both now route to Action required, so expect one or two cards to move there on upgrade" — and 0.31.0 made Action required agent-signals-only. The brief was written against 0.23.x. The Done-when's first half, *"appears in Action required"*, is already met on every build back to 0.24.0.

What is left is real, and it is two things:

**The card cannot say why.** `deriveActivity` assigns `stalled` to any transcript that is stale with a tool call outstanding, and [`transcript.ts`](../../../src/engine/transcript.ts) is explicit that this is a hedge: "the agent is at a permission prompt, or a long command is running. The transcript cannot separate the two, so the label is chosen to be true under either." So a permission prompt and a running `terraform apply` render identically, and the only way to tell them apart is to open the window. Measured on the author's machine, one `AskUserQuestion` gate sat pending for 24.7 hours reading `stalled`.

**A frozen session loses the reduction to a politer one.** `mostActive` reduces every session in a run to one reading for the card, and `needs-you` (5) outranks `stalled` (4). A run holding one session that finished its turn and one frozen mid-work reads *"ended turn"* — the frozen session is visible only if you expand the row, and the collapsed card gives you no reason to. This is the same bug the file's own comment already describes for `needs-you` over `working`: "letting the working agent bury the stuck one is the identical bug."

**And `exited` is over-reported.** `promoteExited` fires when the live session count is zero, but [`readOpenSessions`](../../../src/engine/sessions.ts) returns `[]` for an *unreadable* directory too, which is indistinguishable from "nothing is running". One failed `readdirSync` on `~/.claude/sessions` marks every mid-work card on the board `exited` on the next 6-second poll, and inflates the sidebar attention badge to match. This has been live since 0.24.0. The brief frames the guardrail as a nicety borrowed from AO; it is a bug fix.

## Goal

Split `blocked` out of `stalled` where the transcript can support the claim, name the tool either way, rank a frozen session above a polite one, and stop calling a card dead on a probe that failed rather than reported.

## Scope

In scope: `AgentState` and `AgentActivity` in `src/types.ts`; the derivation in `src/engine/transcript.ts`; rank and promotion in `src/engine/activity.ts`; the sessions probe in `src/engine/sessions.ts`; the `needs` rung in `src/engine/bucket.ts`; the `NEEDS_STATES` set and two `promoteExited` calls in `src/engine/attentionFs.ts`; one `promoteExited` call and one input field in `src/engine/status.ts`; the two state-label maps in `src/webview/deckParts.tsx` and `src/webview/DeckApp.tsx`; `CHANGELOG.md`.

Out of scope, deliberately:

- **A `blocked` orchestrator condition.** A condition key is frozen surface once released, and `agent-needs-you` plus `agent-idle-over` already cover the rules users have written. Adding one is its own task with its own migration question.
- **A settings gate.** See **Why this ships ungated** below.
- **`WebFetch` / `WebSearch` in the ceiling table.** Both are permission-gated and bounded in practice, but n=8 is not a sample. They stay in the fall-through class until there is data.
- **Reading `permissions.allow` from `.claude/settings.json`.** The most precise signal in theory and the most wrong in practice: `bypassPermissions` and auto-accept mode make an allowlist match say nothing, and it adds an `fs` read to the poll path.
- **`status.ts`'s provider inference.** [`status.ts:88`](../../../src/engine/status.ts) infers `provider = "claude-code"` from `agents.length > 0`, which lies under the same unreadable-directory condition this design fixes for `exited`. Same root cause, different blast radius, not this task.
- **The `gone` in E3's title.** `exited` already covers "process gone". There is no third state here, and nothing in the brief's body asks for one.

## The calibration this design rests on

Every threshold below is measured, not assumed: 279 transcripts in `~/.claude/projects` over eight days, ~13,000 tool calls, gaps taken between each `stop_reason: "tool_use"` line and the `type: "user"` line that answered it.

| tool | n | p50 | p95 | max |
|---|---|---|---|---|
| `AskUserQuestion` | 143 | 65.5s | 2516s | **88782s** (24.7h) |
| `Agent` | 279 | 178s | 1489s | **2775s** (46m) |
| `TaskOutput` | 52 | 354s | 605s | 606s |
| `Bash` | 10172 | 3.2s | 34.8s | **639s** |
| `Edit` | 1232 | 1.3s | 6.5s | **47.2s** |
| `Read` | 1024 | 0.2s | 5.4s | 15.5s |
| `Write` | 334 | 1.1s | 6.3s | 12.0s |

Three things fall out, and each one shapes a class below:

- **`AskUserQuestion` pendency *is* the gate.** No timing inference is needed or wanted — the tool's identity is the whole signal, and it is the case where today's reading is most misleading.
- **`Bash` has a *provable* ceiling.** The tool schema caps `timeout` at 600000ms, so a pending `Bash` past that cannot be a running command. This is the one threshold here that is not a heuristic.
- **A blanket ceiling would have been wrong.** `Agent` legitimately pends 46 minutes. Any single cutoff low enough to catch a `Bash` prompt would flag every backgrounded subagent on the board.

## Design

### The pending tool becomes readable

`TranscriptLine.message` gains `content?: unknown[]`. When `stop_reason === "tool_use"`, `deriveActivity` reads the `name` of the last `tool_use` block in that array and carries it on `AgentActivity` as `pendingTool?: string | null`.

Narrowing stays defensive in the style the file already uses for `RawSession`: the array, its members, their `type` and their `name` are all `unknown` until checked, because Claude Code owns this format and may change it under us. Anything unparseable yields `null`, which is the fall-through case below — so a format change degrades to today's behaviour rather than to a crash or a wrong state.

### Three classes select the state

Past the existing 45s `WORKING_WINDOW_MS`, with a tool outstanding, the tool's name selects a rule:

| class | tools | rule | why this threshold |
|---|---|---|---|
| **human gate** | `AskUserQuestion`, `ExitPlanMode` | `blocked` immediately | pendency is the gate; no timing claim to make |
| **gated + instant** | `Edit`, `Write`, `NotebookEdit` | `blocked` past 60s | max 47.2s across 1,566 calls |
| **gated + capped** | `Bash` | `blocked` past 720s | 600s schema cap + 2min margin; measured max 639s |
| **fall-through** | everything else, and any unreadable name | `stalled`, as today | 46-min pendency is legitimate for `Agent` |

The fall-through class is the design's load-bearing member, and it holds two distinct groups for two distinct reasons. `Agent`, `Workflow`, `TaskOutput`, `Monitor` and `mcp__*` are permission-gated but *unbounded* — no ceiling can be honest. `Read`, `Grep`, `Glob` and `TodoWrite` are bounded but *not gated*: a hung `Read` is a wedged host, not a question, and calling it `blocked` would claim someone is being asked something when nobody is. Both groups keep reading `stalled`, which remains exactly as true of them as it is today.

This is the correction that matters most against a first draft of this design, which had a single "instant tools" class covering `Read` alongside `Edit`. `blocked` means *approval pending*. Gated **and** bounded is the entry requirement, and only four tool names clear it.

### Rank, routing, and the sets

`STATE_RANK` gains `blocked: 6`, above `needs-you`. The argument is the one [`activity.ts`](../../../src/engine/activity.ts) already makes twice for the rungs below it: in a run holding both, the frozen session is the one that cannot make progress, and letting an `end_turn` bury it is the identical bug the existing ordering was written to fix.

`deriveBucket` adds `blocked` to the `needs` rung — the same rung `stalled` and `exited` already hold, so no card changes column on this account.

Two sets need editing and one deliberately does not:

- **`NEEDS_STATES`** in `attentionFs.ts` gains it, or the sidebar attention badge silently stops counting a state that routes to Action required. The badge count does not actually move for permission prompts — `stalled` already counted them — but the set and the rung must not disagree, which is what its doc comment ("named once so the cost ladder and its test agree") exists to prevent.
- **`IDLE_LIKE`** does **not**. A session waiting on your approval is not idle, and "Agent idle over N minutes" firing on it would auto-nudge past a modal dialog. This is also what keeps every existing user flow's behaviour fixed.
- **`promoteExited`** needs no change to handle `blocked`: `midWork` is true for any pending tool and the existing `state !== "working"` guard lets `blocked` through, so a blocked session whose process died correctly becomes `exited`. A dead process is not waiting for your approval.

### The guardrail

AO terminates only when runtime and process are both dead, activity is stale, and no merged PR is owned. Audited against what is already here, three of the four clauses hold:

- *no merged PR owned* — structural: `prMerged` is `deriveBucket`'s first rung, and its doc comment already explains why it outranks every agent state.
- *activity is stale* — `state !== "working"`, i.e. an mtime older than 45s.
- *runtime dead* — `midWork`: the transcript stops owing work.
- *process dead* — **the gap.** `liveSessionCount === 0` is assumed, not known.

The fix is to make the probe report its own failure, at the seam where the failure is known:

```
readOpenSessionsProbe(dir): { sessions: OpenSession[]; readable: boolean }
readOpenSessions(dir): OpenSession[]   // now a one-line wrapper over .sessions
```

`readOpenSessions` keeps its signature and its return type, so **all six existing call sites are untouched** — `deckView.ts:2844`, `deckView.ts:3182`, three in `tasksView.ts` (`420`, `1347`, `2765`), and `attentionFs.ts:85` — along with the mocks in `deckView.test.ts` and `tasksView.test.ts` and the three doc comments in `runs.ts`, `ownership.ts` and `notepad.ts` that quote the call verbatim. Making it nullable instead would have put a `?? []` at every one of them and taught nothing extra.

`promoteExited(reduced, liveSessionCount: number | null)` then refuses to promote on `null`. `BuildRunStatusInput` gains `sessionsReadable?: boolean` and `AttentionDeps` gains the same, both **defaulting to `true`** — so every existing caller and every existing test compiles and passes unchanged, and only the two call sites that actually have the fact pass it.

### What the card says

`AGENT_STATE` in `deckParts.tsx` and the `switch` in `DeckApp.tsx` are both exhaustive over the union, so TypeScript forces the new arm in both — there is no silent miss here. Copy:

- `blocked · waiting on Bash · 20m`
- `stalled · Bash · 4m` (the `pendingTool` decision, applied to the state that already existed)
- `blocked · 20m` when `pendingTool` is null — the human-gate class always has a name, so this arises only from an unreadable line, and the state is still worth stating.

Tone stays `attn` for both. Per the project's colour rule, amber is correct for "a human has to do something" and red is reserved for a real failure; a permission prompt is not a failure.

## Why this ships ungated

CLAUDE.md requires new behaviour to ship inert behind a default-off setting. The invariant's stated purpose is that "the existing suite must pass **unmodified**", and this design satisfies that by construction rather than by a flag:

- **`AgentState` is not frozen surface.** It is absent from `runs/` (nothing in `runs.ts` writes it), absent from telemetry wire values (nothing in `telemetry/events.ts` reads it), and derived fresh on every 6s poll. The union can grow without moving anything `compat.test.ts` pins.
- **Existing fixtures carry no `message.content`.** So `deriveActivity` finds no tool name, takes the fall-through arm, and returns `stalled` exactly as today. `transcript.test.ts` passes untouched. If a test has to be edited to go green, that is the signal to stop and re-examine this claim.
- **Precedent is directly on point.** `stalled` and `exited` made a strictly larger change — cards genuinely moved column — and shipped ungated in 0.24.0, with the changelog telling users to expect the move. A default-off setting would mean nobody sees the fix, and a new setting id is itself permanent surface.

The changelog entry should say plainly that some cards reading `exited` will now read something calmer, because that is the one change a user could mistake for a regression.

## Files

| file | change |
|---|---|
| `src/types.ts` | `AgentState` gains `blocked`; `AgentActivity` gains `pendingTool`; `TranscriptLine.message` gains `content` |
| `src/engine/transcript.ts` | parse the pending tool name; the three-class rule |
| `src/engine/activity.ts` | `STATE_RANK.blocked = 6`; `promoteExited` takes `number \| null` |
| `src/engine/sessions.ts` | `readOpenSessionsProbe`; `readOpenSessions` becomes a wrapper |
| `src/engine/bucket.ts` | `blocked` joins the `needs` rung |
| `src/engine/status.ts` | `sessionsReadable?: boolean` threaded to `promoteExited` |
| `src/engine/attentionFs.ts` | `NEEDS_STATES` gains `blocked`; two `promoteExited` calls |
| `src/webview/deckParts.tsx` | `AGENT_STATE` arm; `pendingTool` in the text |
| `src/webview/DeckApp.tsx` | `cardSignal` arm; `pendingTool` in the text |
| `CHANGELOG.md` | one entry under `## [Unreleased]` |

`activity.ts` and `bucket.ts` stay free of `fs`-touching imports — both are reachable from a webview entry point, and `bucket.test.ts` and `test/webview/webviewGraph.test.ts` each enforce it from a different direction. The tool-class table lives in `transcript.ts`, which is host-only, so nothing new becomes reachable from a browser bundle.

## Test plan

Coverage thresholds are enforced (`90% lines/statements, 85% branches/functions`), and every arm below is a branch:

- **`transcript.test.ts`** — one case per class: `AskUserQuestion` blocked at 46s; `Edit` stalled at 50s and blocked at 61s; `Bash` stalled at 700s and blocked at 721s; `Agent` stalled at 3000s; `Read` stalled at 700s. Plus the two that guard the additive property: a line with no `content` derives `stalled`, and a line whose `content` is malformed derives `stalled` with `pendingTool: null`.
- **`activity.test.ts`** — `blocked` outranks `needs-you` in a mixed `mostActive` reduction; `promoteExited(reduced, null)` refuses to promote; `promoteExited` still promotes a `blocked` reading when the count is a real `0`.
- **`bucket.test.ts`** — `blocked → "needs"`, and the existing `fs`-free assertion still holds.
- **`sessions.test.ts`** — probe returns `readable: false` on an unreadable dir and `readable: true` on an empty one; `readOpenSessions` returns `[]` for both.
- **`status.test.ts` / `attentionFs.test.ts`** — `sessionsReadable: false` suppresses the promotion; the default keeps every existing case identical.
- **Webview** — both label maps render the new arm, with and without `pendingTool`.
- **`vocabulary.test.ts`** — `pendingTool` and `blocked` introduce no "agent"-where-"session"-belongs violation, but the gate fires on hyphenated words in prose, so the changelog entry needs a read before commit.

The whole suite must pass unmodified. `npm test` is ~4,500 tests over 2+ minutes and needs `timeout: 600000`.

## What this does not fix

Worth stating so a later reader does not assume it was covered:

- A `Bash` permission prompt still reads `stalled` for twelve minutes before it reads `blocked`. That is the price of a provable threshold over a guessed one.
- A permission prompt on a tool in the fall-through class — an MCP write, a `WebFetch` — reads `stalled` forever. The classes are an allowlist, and that is the safe direction to be wrong in.
- `blocked` is an inference, not an observation. Claude Code writes nothing to the transcript when a prompt opens; this was verified against 279 transcripts, which contain no permission trace of any kind. If Claude Code ever records the prompt directly, every threshold here should be deleted rather than tuned.
