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
that. Two facts pull them apart:

1. A chip's name need not be a component the Jira project defines. It may have been
   inferred from a label or a whole-word mention in the description, or be a repo
   the project simply has no component for. Jira rejects a write naming a component
   that does not exist, so such a chip cannot be synced.
2. An issue can carry components with no local checkout — `Infra`, `Docs`. They
   never appear as chips today and must never be disturbed by an edit to the chips.

## Sync contract

The chip list stays a list of **local repo names**. One new fact rides alongside it:
which of those names is also a component defined in the Jira project. That mapping
is the sync boundary.

Three chip states follow, and the UI distinguishes all three:

| state | chip | affordances |
| --- | --- | --- |
| **A** — maps to a project component, and that component is on the issue | solid | `×` removes it from the ticket (a Jira write) |
| **B** — maps to a project component that is *not* on the issue — i.e. inferred from a label or a text mention | dashed | `↑` adds it to the ticket (a Jira write); `×` drops it locally, no write |
| **C** — no project component by that name | dashed, no `↑` | `×` drops it locally, no write |

State B is the common one and the reason this feature exists: inference found the
repo, the ticket never recorded it. It gets a per-chip push rather than an automatic
write, so expanding a card still never writes.

A component on the issue with no local checkout is in none of these states — it is
never listed and never touched.

Rules that follow:

- **Deltas only, never `set`.** A wholesale write would drop the issue's non-repo
  components.
- **Adds and removes both write, immediately** — adding a mappable repo from the
  picker, `↑` on a state-B chip, `×` on a state-A chip. This matches how status
  change and "Add to my sprint" already behave: a write on click, with a toast. To
  open a narrower set for one session without touching the ticket, leave the chips
  alone and use the Take repo picker.
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

`listComponents(): Promise<string[] | null>` — `GET /rest/api/3/project/{key}/components`,
returning component names. Cached at module level keyed by project key with a
5-minute TTL. The TTL is the one deviation from the `cachedSprintFieldId` pattern:
components are created far more often than a site's sprint field id changes, and a
component added in Jira should not require a window reload to become syncable.

A fetch failure resolves to `null` rather than throwing, which degrades the feature
to today's local-only behavior instead of breaking card expansion. **`null` and `[]`
are different answers and the distinction is load-bearing**: `[]` means the project
defines no components, `null` means we do not know. Collapsing them — as an earlier
draft of this spec did — makes both the host's toast and the chip's own title assert
"no component named X" when the truth is a dead token or an unreachable site, which
sends the user to fix a name that was never the problem. A failure is never cached,
so the next call retries.

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
provenance label, toasts, and echoes the toggle back with its verdict.

### `src/webview/App.tsx`

`DetailState` grows `jira` (the issue's component names) and `mappable` (the repo →
canonical-component map). Those two, plus the existing `selected`, are what classify
each chip A / B / C. The webview is the only place that decides whether a toggle is
worth a message; the host trusts what it is sent and never re-derives the state.

## Message plumbing

```
host → webview   detail            + jiraComponents: string[]
                                     // canonical component names on the issue
                                   + mappable: Record<string, string> | null
                                     // repo name → canonical component name, for
                                     // every repo in `repos` (not just the chipped
                                     // ones) — the user can add any of them.
                                     // null = the project's component list could
                                     // not be read, so no chip state is knowable

webview → host   setComponent      { key, repo, on, movedChip }

host → webview   componentsChanged { key, repo, on, movedChip, ok }
```

One chip per message. That keeps each write idempotent and makes a failure
attributable to a single chip, which is what makes the optimistic revert precise.

`movedChip` says whether the chip's presence in the list changed too, which is what
makes a failure exactly undoable without the host having to know the ticket's
pre-write component list — Jira's `PUT` returns `204 No Content`, so learning that
list would cost a second round trip on every toggle. The three legal combinations
and what `ok: false` undoes:

| action | `on` | `movedChip` | undo on failure |
| --- | --- | --- | --- |
| add a repo from the picker | `true` | `true` | drop the chip, drop the component |
| push a state-B chip with `↑` | `true` | `false` | drop the component, chip stays |
| `×` a state-A chip | `false` | `true` | restore the chip and the component |

The host echoes `repo`, `on` and `movedChip` back verbatim and appends `ok`. States
B and C dropped with `×` send nothing at all.

The collapsed card's `svc` chips render from `details[key].selected` when a detail
exists for that key, falling back to `task.services`. The expanded and collapsed
views therefore cannot drift, and a successful write needs no list refetch.

## UI

A state-A chip keeps the current appearance. States B and C get a dashed border,
which reads as "not on the ticket" without a word of explanation, plus a `title`
that says which it is:

- **B** — "not on `PROJ-1` in Jira — `↑` adds it". The `↑` sits left of the `×`, its
  own title reading "Add `Pricing-Api` to `PROJ-1`" — the component's spelling, not
  the repo's, since that's what Jira actually receives.
- **C** — "no `PROJ` component named `scratch-tool` — this selection stays local".

When `mappable` is `null` — the project's component list could not be read — there is
a fourth rendering, and it is the *absence* of a claim. Every chip takes the plain
solid form with no `↑` and a generic `Remove`, titled "couldn't read `PROJ`'s
components — can't tell which are on `PROJ-1`". The dashed border is what asserts "not
on the ticket", so applying it here would state something unknown as fact; the solid
form is the neutral one because it is what the chips looked like before this feature
existed. No write is attempted, since no canonical name is available to send.

No hint line and no red: red is reserved for real failures, and cards carry no
persistent hint lines.

Every write is optimistic. The chip changes at once and a toast confirms
(`Added billing-service to PROJ-1`, `Removed pricing-api from PROJ-1`), naming the
component's canonical spelling because that is what Jira received. On failure the
chip snaps back per the `movedChip` table above and the error toast carries the
existing "Open in Jira" action — when Jira rejects a component the panel believed in,
the ticket is the only place left to resolve it.

## Error handling

| failure | behavior |
| --- | --- |
| `JiraAuthError` on the write — which `JiraClient.request` raises for **every** 401 *and* 403, permission refusals included | echo `ok: false`, then the existing path: re-gate the panel to sign-in. Uniform with every other write in `tasksView.ts`; a refusal is indistinguishable from a dead token at this layer, and re-authenticating is the right first move either way |
| `JiraApiError` on the write — a 400, e.g. an unknown component from a stale cache | echo `ok: false` so the webview undoes the toggle, error toast with "Open in Jira" |
| `listComponents` fetch fails | resolves `[]`. An empty list is ambiguous — the project may define no components, or the read may have failed — so the failure must not be reported as "no component named X". Say the list couldn't be read instead |
| provenance label stamp fails | logged, never surfaced — the component write already succeeded |

## Testing

- `test/unit/engine/components.test.ts` — the mapping: exact match, case and
  whitespace differences, no match, canonical name returned over the repo's spelling.
- `test/unit/jira/client.test.ts` — the `PUT` body shape for add, remove, and both
  together; no request when the delta is empty; the cache and its TTL; a
  `listComponents` failure resolving to `[]`.
- `test/unit/tasksView.test.ts` — `detail` reports `jiraComponents` and `mappable`;
  `setComponent` writes the canonical name and echoes `ok: true`; the provenance
  stamp fires when configured and a stamp failure does not fail the write; a write
  failure echoes `ok: false` with an error toast; a repo the project has no component
  for produces no Jira call.
- `test/webview/App.test.tsx` — the three chip states render their own affordances;
  a picker add, an `↑` push and a state-A `×` each send the right
  `on` / `movedChip` pair; each of the three undoes correctly on `ok: false`; state-B
  and state-C `×` send nothing; collapsed chips agree with the expanded list.

## Out of scope

- Creating a Jira component that does not exist. It needs project-admin permission
  and is a different decision than picking repos for a ticket.
- Syncing labels. Only the Components field is written.
- Editing components on the Deck. This is the task pool's card only.
