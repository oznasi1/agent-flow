# Design: Agent card place label and session tooltips

**Date:** 2026-08-05
**Status:** Approved, ready to plan

## Summary

Two small, related display fixes on the Deck's in-flight [Card](../../../src/webview/DeckApp.tsx) component. Both are read-only projections of data already flowing into `CardAgent` — no new host-side plumbing.

**1. Fix the "first repo" fallback bug.** The top-right agent chip's tooltip states where a session runs: `agent.repo ?? r.run.repos[0]?.name ?? "this run"` ([DeckApp.tsx:232](../../../src/webview/DeckApp.tsx)). `agent.repo` is set correctly per-agent when its session's cwd exactly matches one of the run's repo paths ([deckView.ts:609-621](../../../src/deckView.ts)). When it doesn't match — observed for a session opened at the multi-root workspace level rather than inside one repo folder — it falls back to `repos[0].name`, always the first repo, regardless of how many repos the run actually has. A workspace with two repos was seen showing only the first repo's name on the agent card.

**2. Add session context to the tooltip.** The name in that same top-right chip is `agent.session.name` ([DeckApp.tsx:233](../../../src/webview/DeckApp.tsx)) — an opaque codename Claude Code itself derives (e.g. `agent-flow-2e`), carrying no information about what the session is doing. `AgentActivity.slug` ([types.ts:146](../../../src/types.ts)) — Claude Code's own per-session title, already read from the transcript ([transcript.ts:34](../../../src/engine/transcript.ts)) — is populated on every `CardAgent` but currently rendered nowhere. Surfacing it in the tooltip lets a hover answer "what is this agent doing" without changing the visible label.

## Decisions

| Question | Decision |
|----------|----------|
| What replaces the first-repo fallback? | The workspace name, when the run has one, ahead of the first-repo fallback: `agent.repo ?? workspaceLabel(run) ?? run.repos[0]?.name ?? "this run"`. |
| What is "the workspace name"? | The run's `.code-workspace` file's basename, extension stripped (e.g. `PROJ-123+2.code-workspace` → `PROJ-123+2`). Mirrors the existing display convention in [tasksView.ts:786](../../../src/tasksView.ts). |
| Does this touch single-repo runs? | No. `run.workspaceFile` is only set in multi-root mode ([types.ts:74](../../../src/types.ts)); `workspaceLabel` returns `undefined` for a single-repo run, so the chain falls through to today's behavior unchanged. |
| Does this touch the branch row? | No. [DeckApp.tsx:264-265](../../../src/webview/DeckApp.tsx) has a similar first-repo shape but displays a *branch*, a separate question (which branch to show when repos differ) that wasn't reported and isn't part of this fix. |
| Tooltip content when a slug is known? | Lead with it: `` `${slug} — Claude Code session in ${place}` ``. |
| Tooltip content when no slug yet? | Unchanged: `` `Claude Code session in ${place}` ``. |
| Where else does the same codename-with-no-context problem exist? | The expanded agent list on a run card, `.ag-name` at [DeckApp.tsx:161](../../../src/webview/DeckApp.tsx) — no tooltip at all today. In scope: add `title={a.activity.slug ?? undefined}`. That row already shows state and age, so the slug alone (no repo text) fills the gap. |

## Implementation sketch

Add one helper, colocated in `DeckApp.tsx`:

```ts
function workspaceLabel(run: Run): string | undefined {
  return run.workspaceFile?.split("/").pop()?.replace(/\.code-workspace$/, "");
}
```

Update the two tooltip sites (`.c-agent` at line 232, `.ag-name` at line 161) as described above. No new types, no host-side changes — `Run.workspaceFile` and `AgentActivity.slug` already exist and already reach the webview.

## Testing

Extend `test/webview/DeckApp.test.tsx`:
- A run with two repos and `workspaceFile` set, an agent whose `repo` is unset: assert the workspace basename (extension stripped) appears in the `.c-agent` title, not `repos[0].name`.
- A single-repo run: assert behavior is unchanged (no `workspaceFile`, falls through to `repos[0].name`).
- An agent with `activity.slug` set: assert the tooltip leads with the slug, on both the `.c-agent` chip and the expanded `.ag-name` row.
- An agent with `activity.slug: null`: assert both tooltips fall back to their pre-existing text (repo-only for `.c-agent`, no title for `.ag-name`).

No error handling to design: every input (`workspaceFile`, `repo`, `slug`) is already optional/nullable in the type system, and every fallback in the chain already has a defined terminal case.
