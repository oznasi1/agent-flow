# Design: prompt modes layer on top of the built-ins

**Date:** 2026-08-03
**Status:** Approved, ready for planning

## Summary

`agentFlow.promptModes` and `agentFlow.reviewRequestModes` are array settings.
VS Code **replaces** an array default with the user's value rather than merging
them, and `getConfig` honours that replacement literally:

```ts
const m = c.get<PromptMode[]>("promptModes");
return Array.isArray(m) && m.length ? m.filter(/* … */) : DEFAULT_PROMPT_MODES;
```

So a user who customized the list in 0.1.20 is frozen at the modes that shipped
that day. Everything added since — Test-driven, Investigate & root-cause,
Orchestrator, Refine the ticket — is invisible to them, with no error, no
warning, and nothing in the UI to suggest anything is missing. Confirmed in the
wild: a two-entry `promptModes` in Cursor's `settings.json` hid four modes for a
user running 0.1.42, a build that contains all six.

This makes the setting a **layer over the shipped catalogue** instead of a
replacement for it. An entry whose `id` matches a built-in overrides that
built-in; a new `id` adds a mode; a new `hidden: true` flag is the explicit way
to drop a built-in. New built-ins then reach every user, customized or not.

## Decisions

| Question | Decision |
|----------|----------|
| What does a short array mean? | A **stale snapshot**, not deliberate pruning. Missing built-ins are added back. |
| How do I drop a built-in, then? | `{"id": "tdd", "hidden": true}` — an explicit, discoverable opt-out that survives upgrades. |
| Picker order | The user's listed entries **first, in their order**; then unlisted built-ins in shipped order. |
| Overriding a built-in | Field-wise: `{...builtIn, ...definedFieldsOf(entry)}`. `{"id":"plan","prompt":"…"}` keeps the shipped `label` and `detail`. |
| Adding a mode of your own | Needs both `label` and `prompt`. An entry with neither, on an unknown id, is dropped. |
| Which settings? | `promptModes` **and** `reviewRequestModes`, via one shared helper. **Not** `environments`. |
| Untouched users | Unchanged. No explicit value → return the built-ins, same as today. |
| Empty array | Unchanged: still means "give me the defaults". |
| Do we announce it? | One notification, once, and only to users who will actually see new modes. |
| Manifest default | Stays a full copy of the catalogue. It drives the settings UI and fresh installs; the test pinning it to `DEFAULT_PROMPT_MODES` stays. |

## Approach rationale

Three options were weighed.

**Notify but keep replace-semantics** — leave the merge alone and nag on
upgrade. Rejected: it preserves the trap. Every future built-in needs another
notification, and a user who dismisses one is silently stale again.

**Split the setting** — built-ins live only in code; `promptModes` is redeclared
as *extra* modes, with sibling settings for hiding and for overriding prompt
text. Structurally immune to shadowing, and rejected only on cost: three
settings where there was one, a real migration for anyone who edited a built-in's
prompt text, and a deprecation cycle on the existing key.

**Layer over the catalogue (chosen)** — one setting, one new optional flag, no
key renames, and no migration: existing values keep working and simply mean
slightly less than they used to. It fixes every affected user on upgrade without
asking them to do anything.

### Why user-order-first

Ordering by the shipped catalogue would be simpler, but it discards a real
intent. A user whose array reads `[implementation, plan]` reordered it on
purpose; forcing catalogue order would silently undo that. Listing their entries
first preserves reordering *and* per-mode overrides, and sends new built-ins to
the bottom of the picker — the one position that never disturbs an existing
arrangement and is predictable release over release.

The single intent this design does not preserve is "I want fewer modes." That is
the deliberate trade, and `hidden` is its replacement.

## Components

### `resolveModes(builtIns, key)` — `src/config.ts`

Pure, total, and shared by both settings. Never throws and never returns an
empty list.

```
explicit = explicitConfigValue<unknown[]>(c, key)   // inspect(): folder > workspace > global
if not Array.isArray(explicit) → return builtIns    // fast path, untouched user

hidden = ids of valid entries where entry.hidden === true
listed = for each valid entry NOT in hidden, in the user's order:
           id matches a built-in → { ...builtIn, ...defined(label, detail, prompt) }
           unknown id            → entry itself, only if label and prompt are both present
                                   (otherwise dropped)
result = [...listed, ...builtIns not listed]
           minus hidden ids
           deduped by id, first occurrence wins
return result.length ? result : builtIns
```

Entry validity: a non-null object whose `id` is a non-empty string after
trimming. Anything else is skipped — same tolerance the current `.filter()` has.

`explicitConfigValue` already exists at `src/config.ts:249` for the
`explorePrompt` → `explorePrompts.knowledge` migration; this reuses it. The
distinction it provides is essential: `c.get()` cannot tell a user's array from
the manifest default, and merging the manifest default into itself would make
`hidden` unusable for someone who never set the key.

Both call sites in `getConfig` collapse to
`resolveModes(DEFAULT_PROMPT_MODES, "promptModes")` and
`resolveModes(DEFAULT_REVIEW_REQUEST_MODES, "reviewRequestModes")`. The existing
legacy-`prReviewPrompt` migration inside the `reviewRequestModes` branch is
preserved: it still supplies the seed array when no explicit modes value exists.

### Manifest — `package.json`

For both settings' `items`:

- `required` drops from `["id", "label", "prompt"]` to `["id"]`.
- `hidden`: `boolean` is added, described as dropping a built-in mode.
- `label` / `prompt` descriptions gain "omit to keep the built-in value;
  required when adding a mode of your own."
- The setting's `markdownDescription` states the layering and shows the `hidden`
  form.

Without the `required` change, both a hide-entry and a prompt-only override draw
a red squiggle in the settings JSON editor while working correctly — an
invitation to "fix" the file back into the trap.

### `maybeShowModesNotice(context, {setupRunning})` — `src/modesNotice.ts`

Modeled on `src/telemetry/notice.ts`: a `globalState` key guards it to once ever,
it defers while first-run setup is on screen (without consuming the key), and it
swallows every error so a notification can never break activation.

**One notice covers both settings.** Each is examined independently: a setting is
*affected* when an explicit value exists for it **and** that value omits at least
one built-in id. The notice fires if either is affected, and `N` is the total
number of built-ins about to appear across both. Users who never customized, and
users whose lists already cover the catalogue, see nothing.

`reviewRequestModes` is affected in a real case, not a theoretical one: a
reviewer who replaced the single stock `full` mode with a backend/frontend pair
gets `full` back.

- Message: *"Your customized prompt modes now layer on top of the built-in ones —
  N new modes are showing."* Deliberately says "prompt modes", not "task modes",
  since the review picker may be the one that changed.
- **What changed** → opens the CHANGELOG entry.
- **Hide the new ones** → for **each** affected setting, appends
  `{id, hidden: true}` for exactly that setting's previously-missing ids,
  restoring both pickers to what the user had.

Each write targets the `ConfigurationTarget` that setting's value already
occupies, read from `inspect()` per setting. A workspace-scoped override must not
be silently promoted to global.

### Telemetry — `src/telemetry/settingsSnapshot.ts`

`prompt_modes_customized` / `review_modes_customized` compare a joined id string
against the stock join (`settingsSnapshot.ts:85-94`). Under layering the ids
almost always include the full catalogue, so the flag would read `false` for
users who have customized heavily. Both are replaced by counts — overridden,
custom, hidden — alongside the existing totals. Shapes and numbers only; no
labels, no prompt text, no new PII.

## Data flow

```
settings.json (user)  ─┐
                       ├─→ resolveModes ─→ cfg.promptModes ─→ Take picker
DEFAULT_PROMPT_MODES  ─┘                                    └→ settingsSnapshot

                                          cfg.reviewRequestModes ─→ Review picker
activation ─→ maybeShowModesNotice ─→ (optional) settings.json write
```

Nothing downstream of `getConfig` changes. `tasksView` and `deckView` keep
consuming `PromptMode[]`, and `hidden` never reaches them — it is resolved away.

## Error handling

- Malformed entries are skipped, not fatal; the list degrades toward the
  built-ins rather than emptying.
- Every built-in hidden → the resolver returns the built-ins. An empty picker is
  a dead end with no in-product way out, so it is not a reachable state.
- `taskMode` / `reviewRequestMode` naming a hidden or unknown id keeps today's
  behavior: fall back to showing the picker.
- The notice never throws; a failed settings write surfaces as a VS Code error
  and leaves the resolved list correct regardless.

## Testing

Gates, per `CONTRIBUTING.md`: `npm run typecheck`, `npm run test:cov`
(thresholds enforced), `npm run build`.

`resolveModes`, as a table — untouched (no explicit value), empty array,
pruned, reordered, partial override, custom addition, hidden built-in, hidden
custom entry, unusable entry (no id / not an object / non-string id), duplicate
ids, every built-in hidden. Both settings.

Regression: the observed failure — an explicit `[plan, implementation]` resolves
to all six modes, the two user entries keeping their prompts and gaining the
shipped `detail`.

`maybeShowModesNotice` — fires for a pruned `promptModes`; fires when only
`reviewRequestModes` is affected; silent for untouched values, complete values,
and while `setupRunning`; shows once across activations; `N` counts across both
settings; **Hide the new ones** writes exactly the missing ids to the target
`inspect()` reports, for each affected setting independently; a throwing
`showInformationMessage` does not propagate.

Manifest: existing default-parity tests stay green, and a new assertion that
`items.required` is `["id"]` for both settings.

## Out of scope

- Editing any user's `settings.json` outside the **Hide the new ones** action.
- `agentFlow.environments`, whose values are a user's own environment names —
  merging `dev`/`staging`/`production` into them would be wrong.
- The explore prompts, which are per-action string settings and cannot shadow.
- Any change to the picker UI, the mode catalogue itself, or `prReviewPrompt`.
