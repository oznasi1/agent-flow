# Two-way component sync on task cards

## Problem

The expanded task card shows "Repos this task touches" as a list of chips, seeded by
`inferServices` from three sources — the ticket's Jira components, its labels, and
whole-word repo mentions in the summary and description — each matched against the
repos actually checked out under `reposRoot`.

Editing those chips is local only. It changes `detail.selected` in the webview and
nothing else, so it steers which repos Take and Address PR open and never reaches
Jira. A user who corrects the repo set on a card has corrected it for one session;
the ticket still carries the wrong components, and the next person to open the card
sees the same wrong inference.

The read direction already works. This spec adds the write direction.

## What the chip list is, and is not

The chip list is not a mirror of Jira's Components field, and the design turns on
that. Three cases exist:

1. A chip whose name matches a component defined in the Jira project. This is the
   only case that can be synced.
2. A chip with no matching project component — inferred from a label or a text
   mention, or simply a repo the Jira project has no component for. Jira rejects a
   write naming a component that does not exist, so this chip stays local.
3. A component on the issue with no local checkout — `Infra`, `Docs`. It never
   appears as a chip today and must never be disturbed by an edit to the chips.

## Sync contract

The chip list stays a list of **local repo names**. One new fact rides alongside it:
which of those names is also a component defined in the Jira project. That mapping
is the sync boundary.

| chip | on toggle |
| --- | --- |
| matches a project component | write an `add` / `remove` delta to the issue's Components |
| no matching project component | local only, no Jira call, chip marked in the UI |
| component on the issue with no local checkout | never listed, never touched |

Rules that follow:

- **Deltas only, never `set`.** A wholesale write would drop case 3.
- **Adds and removes both write, immediately.** The chip list becomes the ticket's
  repo set. This matches how status change and "Add to my sprint" already behave —
  a write on click, with a toast. To open a narrower set for one session without
  touching the ticket, leave the chips alone and use the Take repo picker.
- **Writes happen only on an explicit toggle.** Expanding a card never writes, so
  the inferred set is never reconciled against Jira behind the user's back.
- **Matching is case-insensitive on the trimmed name**, the same rule
  `inferServices` uses. The write sends the *component's* canonical name, not the
  repo's, so a `billing-service` checkout correctly writes the `Billing-Service`
  component.
- **Every successful write stamps `provenanceLabel`** when `stampLabelOnWrite` is
  on, best-effort and non-fatal, exactly as the three existing write paths do.

## Modules

### `src/jira/client.ts`

Two additions, both mirroring existing members.

`listComponents(): Promise<string[]>` — `GET /rest/api/3/project/{key}/components`,
returning component names. Cached at module level keyed by project key with a
5-minute TTL. The TTL is the one deviation from the `cachedSprintFieldId` pattern:
components are created far more often than a site's sprint field id changes, and a
component added in Jira should not require a window reload to become syncable. A
fetch failure resolves to `[]` rather than throwing — that degrades the feature to
today's local-only behavior instead of breaking card expansion.

`updateComponents(key, {add?: string[], remove?: string[]})` —
`PUT /rest/api/3/issue/{key}` with body
`{update: {components: [{add: {name}}, {remove: {name}}]}}`, the same additive shape
`addLabel` uses. A call with nothing to add or remove makes no request.

### `src/engine/components.ts` (new)

Pure, no `vscode` or network import. Resolves a repo name against the project's
component names and returns the canonical component name, or `null` when there is
no match.

This is the one piece with real edge cases — case folding, surrounding whitespace, a
repo matching nothing, two component names differing only by case — so it lives
beside `infer.ts` and `order.ts` and is unit-tested directly rather than through the
view. When two component names fold to the same key, the first in the order Jira
returned wins; the alternative is failing a write over a project misconfiguration
the user cannot see from here. Keeping it out of `tasksView.ts` also matters on its own: that
file is already 1185 lines, the largest in the repo.

### `src/tasksView.ts`

The `detail` handler additionally resolves the project's components and reports the
mapping to the webview. One new message handler performs the write, stamps the
provenance label, and reports the issue's resulting component list.

### `src/webview/App.tsx`

`DetailState` grows two fields. The chip toggle sends a message when the chip is
mappable and updates local state only when it is not.

## Message plumbing

```
host → webview   detail            + jiraComponents: string[]
                                     // canonical component names on the issue
                                   + mappable: Record<string, string>
                                     // repo name → canonical component name, for
                                     // every repo in `repos` (not just the chipped
                                     // ones) — the user can add any of them

webview → host   setComponent      { key, repo, on }

host → webview   componentsChanged { key, components, revert? }
                                     // authoritative after the write;
                                     // `revert` names the repo whose toggle to undo
```

One chip per message. That keeps each write idempotent and makes a failure
attributable to a single chip, which is what makes the optimistic revert precise.

The collapsed card's `svc` chips render from `details[key].selected` when a detail
exists for that key, falling back to `task.services`. The expanded and collapsed
views therefore cannot drift, and a successful write needs no list refetch.

## UI

Chips keep their current appearance. A local-only chip — case 2 — gets a dashed
border and a `title` reading "not a component in `PROJ` — this selection stays
local". No hint line and no red: red is reserved for real failures, and cards carry
no persistent hint lines.

Toggling is optimistic. The chip moves at once and a toast confirms the write
(`Added billing-service to PROJ-12`, `Removed pricing-api from PROJ-12`). On failure
the chip snaps back via `revert` and the error toast carries the existing
"Open in Jira" action — when a write is refused for permissions, the ticket is the
only place left to finish the job.

## Error handling

| failure | behavior |
| --- | --- |
| `JiraAuthError` on the write | existing path: re-gate the panel to sign-in |
| `JiraApiError` on the write (403 no permission, 400 unknown component from a stale cache) | revert the chip, error toast with "Open in Jira" |
| `listComponents` fetch fails | resolves `[]`; every chip is local-only, no writes attempted, failure logged |
| provenance label stamp fails | logged, never surfaced — the component write already succeeded |

## Testing

- `test/unit/engine/components.test.ts` — the mapping: exact match, case and
  whitespace differences, no match, canonical name returned over the repo's spelling.
- `test/unit/jira/client.test.ts` — the `PUT` body shape for add, remove, and both
  together; no request when the delta is empty; the cache and its TTL; a
  `listComponents` failure resolving to `[]`.
- `test/unit/tasksView.test.ts` — `setComponent` writes and posts
  `componentsChanged`; the provenance stamp fires when configured and a stamp
  failure does not fail the write; a write failure posts `revert` and an error toast;
  a non-mappable repo produces no Jira call.
- `test/webview/App.test.tsx` — optimistic toggle, revert on `componentsChanged`
  with `revert`, local-only chips marked and never messaged, collapsed chips
  agreeing with the expanded list.

## Out of scope

- Creating a Jira component that does not exist. It needs project-admin permission
  and is a different decision than picking repos for a ticket.
- Syncing labels. Only the Components field is written.
- Editing components on the Deck. This is the task pool's card only.
