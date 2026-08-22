# Deck vocabulary: an agent runs a session

**Date:** 2026-08-22
**Status:** design approved, plan pending
**Branch:** `worktree-deck-session-semantics`

## Problem

"Agent" carries three unrelated meanings across Agent Flow Deck's user-facing
surface, and the reader has to infer which one is meant from context:

| meaning | where it appears |
| --- | --- |
| one run of a coding tool — one Deck card | Deck cards and counts, the `Agents / Workspaces` grouping toggle, `agentFlow.openAgents`, the orchestrator's rule labels |
| the tool being driven | `agentFlow.agentProvider`, `agentFlow.agentSurface`, "Review with agent", "Start this note as an agent run" |
| a Claude Code subagent | the Marketplace's Agents tab, `.claude/agents/`, `AssetType: "agent"` |

The first and third collide hardest: a Deck card is *not* an agent, because one
card routinely dispatches many subagents. Calling the card a **session** makes
the containment relationship sayable — a session dispatches subagents — and it
is what the codebase's own comments already say. `armability.ts` documents
`no-agent-left` as the condition that "counts sessions in the registry".

## Decisions

Five decisions, all settled before this document was written.

1. **Display layer only.** Every user-visible string changes. No identifier, no
   setting id, no stored enum value, no on-disk field, and no telemetry wire
   value changes.
2. **One word, one meaning.** In the UI, "agent" means a Claude Code subagent
   and nothing else. Actions that start a session name the tool instead of
   calling it "the agent".
3. **Whole product surface.** Deck, sidebar, Marketplace, all `agentFlow.*`
   setting and enum descriptions, README, `docs/`, CHANGELOG. A half-renamed
   product is worse than either end state.
4. **A vocabulary gate test** holds the new usage in place, with an explicit
   allowlist recording every place "agent" still legitimately means agent.
5. **`agentLabel` is plumbed into the Deck** so its review actions can name the
   user's tool.

## The vocabulary

Three words, one meaning each. This table is the whole specification; every
change below is derived from it.

| word | means | example |
| --- | --- | --- |
| **session** | one run of a coding tool — one Deck card, one row in `run.agents[]` | "3 sessions", `Sessions / Workspaces`, "session ended its turn" |
| **agent** | a Claude Code subagent | the Marketplace's Agents tab, `.claude/agents/`, `AssetType: "agent"` |
| *the tool's name* | Claude Code / Cursor / Copilot — never "the agent" | "Review with Claude Code", "Which tool starts your sessions" |

A useful test for any new string: if it could be preceded by "one of the many
things this card spawned", the word is *agent*. Otherwise it is *session*.

## Scope

### 1. The one non-copy change: `agentLabel` on `deck:runs`

The Deck's review actions currently read "Review with agent" and cannot say
otherwise, because the Deck's outbound message carries no tool name. A Cursor
user is told "agent" and never sees "Cursor".

`deck:runs` already solves this exact problem for the task source. It carries
`sourceLabel`, whose comment reads: *"the Deck is a separate panel with its own
outbound message, so it carries its own copy."* `agentLabel` follows that
pattern verbatim.

- `src/types.ts` — add `agentLabel: string` to the `deck:runs` payload, beside
  `sourceLabel`, with a comment pointing at the same reasoning.
- `src/deckView.ts` — in `refresh()`, send
  `agentLabel: providerLabel(resolvedProvider(getConfig().agentProvider))`.
  Read fresh on every post, like `sourceLabel`, `prReviewStatus` and
  `showTokenTotal` beside it — the provider is a setting a user can flip
  mid-session.
- `src/webview/DeckApp.tsx` — hold it in state with a `DEFAULT_AGENT_LABEL`
  fallback, mirroring `App.tsx:143`, and pass it to `ReviewStrip`.

The field is additive. Nothing reads it if absent, and no existing message
shape changes.

### 2. Deck webview

- **Grouping toggle** (`DeckApp.tsx:680-692`) — `Agents` → `Sessions`;
  `Workspaces` unchanged. Tooltips become "One card per Claude Code session,
  with the repo, ticket and PR it belongs to" and "One card per launched task,
  with its sessions nested underneath". **The stored value stays `"agents"`.**
- **Counts** — `deckSignal.ts:96` `${r.agents.length} agents` → `sessions`;
  the singular at `:94` likewise. `deckStyles.ts:301`'s comment example
  ("3 agents") follows.
- **Review actions** (`ReviewStrip.tsx:167,169,368`) — "Review with agent" →
  `Review with ${agentLabel}`; the batch action's accessible name →
  `` Review the ${n} selected PR${…} with ${agentLabel} ``. The two accessible
  names must stay distinct — `ReviewStrip`'s own comments explain why, and
  substituting the same label into both preserves the distinction.
  `deckStyles.ts:474`'s comment reference follows.
- **`DeckDetail.tsx:85`** — "seed an agent against the review" → "start a
  session against the review".
- **State copy** (`DeckApp.tsx:145-149`) — `working / ended turn / stalled /
  exited / idle` are already tool-neutral. No change.
- **Comments** at `DeckApp.tsx:166,196,806` describing agent-vs-run behaviour
  are updated for consistency; they are comments, not gated.

### 3. Orchestrator

Rule labels change; **condition keys do not**, because they are serialized into
flow files under `~/.agentflow/flows` and shared across windows.

- `orchestratorRule.ts:43-45` labels — "agent ended its turn" → "session ended
  its turn"; "agent idle over…" → "session idle over…"; "no agent left" → "no
  sessions left". Keys `agent-ended-turn`, `agent-idle-over`, `no-agent-left`
  are untouched, as is `status.agent`.
- `OrchestratorDrawer.tsx` — the `Agents` section header (`:1362`) →
  `Sessions`; "over every agent in every repo of the run" (`:250`) → "…every
  session…"; "agent state unknown" (`:254`) → "session state unknown"; "not an
  agent node" (`:509`) → "not a session node".
- `docs/ORCHESTRATOR_COMMANDS.md` carries no condition keys — only prose. Its
  display-label references become session ("Opens a new agent session" at
  `:28` → "Opens a new session"; "launching and seeding agent sessions" at
  `:53`; "`agent idle over…`" at `:199`), and "agent activity" at `:46` →
  "session activity".
- **The key/label mismatch is documented where the keys live**, not in the doc:
  one sentence on the `Condition` type in
  `src/engine/orchestrator/model.ts`, saying the keys are serialized into flow
  files and must keep their released spelling while the labels beside them read
  "session". Without it the next contributor reads `agent-idle-over` as a
  missed rename and "fixes" it, breaking every flow on disk.

### 4. Sidebar, Notepad, Marketplace

- `App.tsx:535` — "Explore repos with a `${agentLabel}` agent" → "Explore repos
  in a `${agentLabel}` session".
- `Notepad.tsx:649` — "Start this note as an agent run" → "Start this note as a
  session".
- `MarketplaceApp.tsx:18` — **unchanged.** Its Agents tab lists subagents,
  which is the one correct use of the word.

### 5. Settings and enum descriptions (~35 strings in `package.json`)

Setting **ids stay frozen**; only their prose changes. `agentFlow.openAgents`
will therefore describe sessions — deliberate, and recorded in the gate's
allowlist.

| setting | change |
| --- | --- |
| `agentProvider` | "Which agent Agent Flow starts a session with" → "Which tool…"; the `ask` enum's "pick from the agents this editor can run" → "…the tools…" |
| `agentSurface` | "the agent's chat panel" → "the tool's chat panel" |
| `openAgents` | "…as agents on the card that owns their directory" → "…as sessions…" |
| `seedAgent` | "pre-fill the agent's panel (or terminal)" → "pre-fill the session's panel…" |
| `deckGrouping` | both `enumDescriptions` per §2; the description's "**Agents / Workspaces** control" → "**Sessions / Workspaces**" |
| `retireFinishedAfterHours`, `retireClosedAfterHours`, `retireInPlaceAfterHours` | "after its last agent closes" / "no agent of its own open" / "once you close its agent" → session |
| `orchestrator` | "wire the agents already on your board" → "…sessions…" |
| `reviewRequestModes`, `reviewRequestMode`, `reviewOpenIn`, `reviewRequestPrompt` | "**Review with agent**" → "**Review with your agent tool**" (settings prose cannot interpolate `agentLabel`) |
| `prReviewAutoFix`, `prReviewPrompt`, `exploreSlackDm`, `childWorktrees`, `taskSource` … | remaining prose per the vocabulary table |

### 6. Host-side strings (~14)

Notifications, quick-pick labels and details in `src/*.ts` and `src/engine/`
that name "agent" in either the card sense or the tool sense. Tool-sense
strings use `providerLabel(resolvedProvider(...))`, both exported from
`src/config.ts:209` and `:227`; call sites import them where they do not
already. Card-sense strings become session outright.

### 7. Docs and changelog

`README.md` (~35), `docs/GUIDE.md` (~38), `docs/SETTINGS.md` (~24),
`docs/TELEMETRY.md` (~11), `docs/PRIVACY.md` (~9), `docs/CONNECTORS.md` (~6),
`docs/FORGES.md` (~2). `CONTRIBUTING.md` and `CLAUDE.md` gain a short
vocabulary note pointing at the table above, so the next contributor inherits
the convention rather than rediscovering it.

Files under `docs/superpowers/plans/` are **not** touched. They are historical
records of what was built at the time.

One `CHANGELOG.md` entry under `## [Unreleased]`, describing it as a renaming
of what the UI calls things, with the explicit note that no setting, flow or
run record changes.

## Explicitly out of scope

Each of these is an allowlist entry in the gate test, not an oversight:

- Every `agentFlow.*` setting id, including `agentProvider`, `agentSurface`,
  `openAgents`, `seedAgent`.
- Every stored enum value, including `deckGrouping: "agents"`.
- Every TypeScript identifier: `CardAgent`, `AgentActivity`, `run.agents[]`,
  `agentPick.ts`, `AgentProvider`, `agentLabel` itself.
- Every orchestrator condition key and `status.agent`.
- `AssetType: "agent"` and the Marketplace's Agents tab.
- Telemetry wire values.
- The product name, *Agent Flow Deck*.
- `.claude/agents/` paths.

## The gate: `test/unit/vocabulary.test.ts`

Shaped like the existing `docs.test.ts` source scan, which already reads real
files off disk and asserts on their content.

**What it does.** Reads `package.json` and every `.ts`/`.tsx` file under
`src/`. Extracts string literals, template-literal text and JSX text. Collects
every span matching `/\bagents?\b/i`. Compares the collected set against an
exported `ALLOWED` allowlist keyed by file path and matched substring.

**Set equality, not subset** — the same discipline
`test/webview/tokens.test.ts` applies to `--brand`. An unexpected "agent" fails, *and so does an allowlist entry that no
longer matches anything*. That second half is what stops the allowlist rotting
into a blanket suppression list, and it is the reason this gate is worth having
at all.

**Where it lives.** `test/unit/`, so it runs on the host side and reads `fs`
freely. It scans `src/webview/` as text; it never imports from it. No risk to
the webview import graph.

**Allowlist shape.** Each entry carries a one-line reason. The allowlist is the
durable answer to "why does this still say agent here?" — a design artifact,
not test scaffolding.

## Verification

The repo's CI gate, in order: `npm run typecheck`, `npm test`,
`npm run build`. All four steps of `.github/workflows/ci.yml` must pass.
`npm test` needs `timeout: 600000` when run through a tool.

**Existing tests.** 22 assertions across 8 files match on rendered copy and
must change:

| file | assertions |
| --- | --- |
| `test/webview/DeckApp.test.tsx` | 8 |
| `test/webview/ReviewStrip.test.tsx` | 5 |
| `test/webview/OrchestratorDrawer.test.tsx` | 3 |
| `test/unit/engine/runs.test.ts` | 2 |
| `test/webview/flowList.test.tsx` | 1 |
| `test/webview/App.test.tsx` | 1 |
| `test/unit/engine/doctor.test.ts` | 1 |
| `test/unit/deckView.test.ts` | 1 |

Every one is a string literal whose behavioural expectation is unchanged.
**Any edit to a test beyond a display-string literal is the signal to stop and
re-examine the change** — that is the `never break existing users` invariant
doing its job, and this rename does not get to weaken it.

The 166 test *names* mentioning "agent" assert nothing. They may be renamed for
readability, but they are not required to change and are not gated.

**`test/unit/compat.test.ts` must pass completely unmodified.** It is the proof
that no user's settings, flows or run records moved. If it needs an edit, the
change has exceeded decision 1 and the design is wrong.

**Coverage.** `npm run test:cov` thresholds (90% lines/statements, 85%
branches/functions) apply. The `agentLabel` plumbing is the only new logic and
needs a test: `deckView` sends the resolved provider label, and `DeckApp` falls
back to the default when the field is absent.

**Manual check.** Load the dev host (F5, VS Code's own `code` CLI only) and
confirm: the grouping toggle reads `Sessions / Workspaces` and still persists
across a reload; a Cursor-configured window shows "Review with Cursor"; an
existing flow file with `agent-idle-over` still loads and still arms.

## Risks

**Code and UI now disagree.** `run.agents[]` renders as "sessions". Accepted
under decision 1. Mitigated by the gate test plus one comment at each of four
boundary points — `run.agents[]` in `types.ts`, `deckGrouping`, `openAgents`,
and the orchestrator condition keys — reading, in substance: *the wire says
agent; the UI says session; both are correct.*

**Drift.** `main` takes several releases a day from parallel sessions. The gate
test is the whole mitigation; without it "agent" returns to a card within
weeks, which is how the present three-way ambiguity arose.

**A conflict-heavy diff.** ~110 doc mentions and ~35 manifest strings touch
files other sessions edit. Re-check `main`'s HEAD at the start of each
implementation phase, and land with a push refspec
(`git push origin <branch>:main`) so the shared root checkout is never switched.
