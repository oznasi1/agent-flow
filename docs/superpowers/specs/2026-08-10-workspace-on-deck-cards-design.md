# Workspace context on Deck cards

## Problem

An In-flight card built from a local Claude Code session names one repo, even when
the session runs inside a multi-root workspace. A window holding
`centaur+e2e.code-workspace` (two folders) with one Claude session open in
`automation_e2e` produces a card whose title, branch line and only repo chip all say
`automation_e2e`. The workspace the work actually belongs to is nowhere on the card.

The cause is in the data, not the rendering. `localRunFor` builds one `Run` per
*session place* — the git root of the session's cwd — with exactly one repo
(`src/engine/localRuns.ts:69`). The Deck already writes a presence record for every
open window, but that record carries only `identity`, `kind`, `label` and a folder
*count* (`src/engine/presence.ts:7-18`); it never stores which folders. So nothing
downstream can map a session place back to the workspace that contains it.

Tracked (Agent Flow-launched) runs do keep every repo, and the card renders a chip
for each. They are not broken, but they say nothing about the workspace either —
`workspaceLabel` exists and is used only inside a tooltip string
(`src/webview/DeckApp.tsx:186`).

## Goals

- A card whose session lives in a multi-root workspace names that workspace.
- The repos underneath are one hover away, with the git signal they carry today.
- The resting card gets no taller and no busier than it is now.
- One card per Claude Code session on the Agents lens, exactly as today.

## Non-goals

- Changing how tracked runs are launched, stored or retired.
- Any new git or connector work per refresh.
- Grouping sessions from different windows that happen to share a repo.

## Design

### 1. Presence records carry their roots

`WindowIdentity` gains `roots: string[]` — the window's folder paths, canonicalized.
`currentWindow()` already computes precisely this set (`src/engine/presence.ts:56-64`);
`windowIdentity()` grows the same field so every `PresenceRecord` written from now on
carries it.

The field is optional on read. A record written by an older extension host has no
`roots`, and every consumer treats that as "this window claims nothing" — the same
outcome as today, so a mixed-version machine degrades to current behavior rather than
misattributing a session.

### 2. Local places fold into their window

`deckView.refresh` already reads live windows and groups open sessions by place. It
gains one index: canonical root path → the live window that lists it. Then, for each
unclaimed place:

- **The place belongs to a live window with more than one root.** All of that
  window's places join a single local run, keyed off the workspace file
  (`localKey(identity)`), with `workspaceFile` set to the window identity and `repos`
  set to the window's roots that are git repos. Each session becomes a `CardAgent`
  whose `repo` is the root it sits in — not `repos[0]`, which is what the local path
  hardcodes today (`src/deckView.ts:646`).
- **Anything else** — no live window, a record with no `roots`, or a single-root
  window — keeps today's per-place run, byte for byte.

A root that a tracked run already claimed stays claimed; the existing `claimed` set
covers this, so a workspace whose repos are split between a tracked run and a stray
session does not double-count.

Each root gets its own `currentBranch` read, so the repo chips and the branch line
speak for the repo they name — one git call per root rather than one per place, over
the same set of directories the refresh already walks. Ticket inference runs over
those branches in root order and takes the first hit, so a workspace whose branches
disagree still resolves to one deterministic ticket. The run's `summary` becomes the
workspace label rather than a folder basename when no ticket is inferred, since the
card now stands for the workspace.

This does not change the Agents lens's rule that a card is a session: `projectCards`
emits one card per agent, so two sessions in one workspace remain two cards
(`src/webview/deckCards.ts:40-53`). The Workspaces lens gains the improvement of
showing one card instead of two unrelated ones.

### 3. The workspace chip

When a run has a `workspaceFile` and more than one repo, the flat `.c-repos` row is
replaced by a single chip:

```
▸ centaur+e2e  2 repos
```

The name is mono (an identifier); "2 repos" is UI font (prose) — the sheet's own rule.
Hovering the chip, or focusing it from the keyboard, unfolds the repo chips inline
underneath it, each with the `+/−`, `↑` and dirty markers `RepoChip` renders today.
Clicking toggles the same state open, so touch and keyboard reach it without a hover.
The chip's tooltip is the workspace file path.

A single-repo run renders exactly what it renders today. Tracked multi-repo runs get
the chip too — this is the one place where existing UI changes shape, and it makes a
two-repo `ASM-5989` card one line shorter at rest.

### 4. The branch line follows the agent

`c-branch` reads `run.repos[0].branch` (`src/webview/DeckApp.tsx:285`). On an agent
card with two repos, `repos[0]` may be a branch that session never touched. The line
takes the branch of the agent's own repo, falling back to `repos[0]` on a parked card
that has no agent.

## Testing

- `presence`: a record round-trips its roots; a record parsed without `roots` yields
  no claim; `windowIdentity()` reports the window's folders.
- `deckView` refresh: two sessions in one two-root window produce one local run with
  both repos and two agents, each tagged with the root it runs in; a session in a
  place no live window lists produces today's per-place run; a root already held by a
  tracked run is not re-emitted as a local one; a presence record with no `roots`
  falls back to per-place.
- `DeckApp`: the chip renders for a multi-repo workspace run and names it; the repo
  chips are in the DOM and hidden at rest; a single-repo run still renders the plain
  chip row; the branch line on an agent card is that agent's repo's branch.

## Gates

`npm run typecheck`, `npm test`, `npm run test:cov` (thresholds enforced), and
`npm run build` — the last is not optional here: the webview must never import `fs`,
`os`, `path` or `child_process`, even transitively, and only the bundle step catches
it.
