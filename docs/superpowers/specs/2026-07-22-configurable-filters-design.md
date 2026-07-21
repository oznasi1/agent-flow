# Configurable filter visibility

## Problem

The task-pool sidebar shows several filter controls: the tab bar
(Unassigned/My sprint/Mine/Sprint/Backlog), a Size lens (Any/S/M/L), a Status
chip row, and a "Filter by repo…" search box. Not all of these are relevant to
every user. Users want to hide the ones they don't use.

## Goal

Let a user hide filter controls they don't care about via settings. Default
behaviour is unchanged — every control is shown, exactly as today.

## Scope

Three controls get an on/off visibility toggle:

- **Size lens** — the Any/S/M/L row
- **Status lens** — the client-side status chip row
- **Repo search** — the "Filter by repo…" box

Out of scope (decided during brainstorming):

- The **tab bar** stays always-visible. Hiding it would lock the view to
  `defaultFilter` with no in-UI way to switch tabs — a bigger change we chose
  not to make.
- **Per-option** toggles (e.g. drop just the "L" size bucket, or just the
  "Backlog" tab). We chose whole-control on/off only.

## Design

### 1. Settings (`package.json` → `contributes.configuration`)

Three booleans, each defaulting to `true`:

| Setting | Default | Hides |
| --- | --- | --- |
| `agentFlow.filters.size` | `true` | the Size lens row |
| `agentFlow.filters.status` | `true` | the Status chip row |
| `agentFlow.filters.repo` | `true` | the Repo search box |

Grouped under a `filters.*` namespace, distinct from the existing
`agentFlow.defaultFilter` (which selects the default *tab*, a different concept).

### 2. Config accessor (`src/config.ts`)

Add to `AgentFlowConfig`:

```ts
filters: { size: boolean; status: boolean; repo: boolean };
```

Read each with a `?? true` fallback, so an unset value means "shown".

### 3. Host → webview (`src/types.ts`, `src/tasksView.ts`)

Extend the existing `state` outbound message — the same channel that already
carries `prReviewStatus` — with a `filters` field. `postState()` folds in
`cfg.filters`. No new message type.

### 4. Webview (`src/webview/App.tsx`)

Store `filters` from the `state` message (default all-`true` before the first
message, so nothing flashes hidden). Wrap each control in its flag:

- Size row → `{filters.size && (…)}`
- Status row → `{filters.status && availableStatuses.length > 0 && (…)}`
- Repo box → `{filters.repo && (…)}`

**Correctness:** a hidden control keeps its neutral value, so results are never
silently narrowed:

- Size stays `"any"` (no estimate restriction) — it is React state that resets
  to `"any"` on every panel load and can't be changed while hidden.
- The status set stays empty (all statuses match).
- The repo query stays `""` (all tasks match).

Because those are already the neutral defaults and a hidden control can't be
interacted with, no extra reset logic is needed. `canReorder`
(`filter === "mysprint" && !q && statuses.size === 0`) keeps working unchanged.

### 5. When toggles take effect (option A)

Applied on refresh/reload, consistent with every other setting today
(`defaultFilter`, `prReviewStatus` also only apply on refresh — there is no
`onDidChangeConfiguration` watcher in the extension). The user runs
"Agent Flow: refresh" or reloads the panel to see a change. No live-update
watcher.

## Testing

- **`src/config.ts`** — unit tests: the three flags default to `true` when
  unset, and honour an explicit `false`.
- **`src/webview/App.tsx`** — component tests (harness exists at
  `test/webview/App.test.tsx`): each control renders when its flag is `true`
  and is absent when `false`; hidden controls do not narrow the visible task
  list.

## Non-goals / YAGNI

- No live config-change watcher.
- No per-option filtering.
- No migration — new settings, additive, default preserves current behaviour.
