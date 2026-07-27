# Design: Transition required fields & readable Jira errors

**Date:** 2026-07-28
**Status:** Approved, ready for planning

## Summary

Moving a ticket to a status whose workflow demands extra input — most commonly a
**Resolution** on close — currently fails with a raw JSON dump:

```
⚠ Jira 400: {"errorMessages":["Ticket cannot be closed unless Resolution will be provided"],"errors":{}}
```

…and that banner replaces the entire task list, behind a **Retry** button that
re-fetches rather than retrying the write.

This design fixes both halves. **Change Status** now collects the fields the
transition requires — prompting from Jira's own metadata before the write, and
recovering from workflow validators that only reveal themselves on rejection —
and every Jira failure is rendered as a readable sentence in a sticky toast that
leaves the task list intact.

## Decisions

| Question | Decision |
|----------|----------|
| When to prompt? | **Both.** Read the transition's screen fields upfront; if the write is still rejected for a missing field, prompt from the rejection and retry once. |
| What to collect? | **Any required field, generically** — not just Resolution. Selects become QuickPicks, scalars become InputBoxes. |
| Unrenderable field types? | **Prompt what we can, try anyway.** Skip what we can't render and let Jira decide; many "required" fields have defaults and succeed. |
| Fields with defaults? | **Still prompted.** `hasDefaultValue` does not suppress the prompt — explicit beats implicit, and a wrong default silently applied is worse than one extra pick. |
| How do failures surface? | **Sticky error toast over the intact task list.** Write failures never gate the panel. |
| Toast action? | **Optional "Open in Jira" button** on the toast, reusing the existing `openExternal` message. |
| Retry ceiling? | **Exactly one** recovery re-POST. A second failure is reported, not retried. |

## Approach rationale

- **Upfront + recovery, not one or the other.** `GET /transitions?expand=transitions.fields`
  costs no extra round-trip and describes everything on the transition *screen*.
  But the error that prompted this work has a populated `errorMessages` and an
  **empty** `errors` object — the signature of a custom workflow validator, which
  screen metadata cannot see. Upfront alone would still fail on this exact ticket;
  recovery alone would burn a failed write on every close. Doing both covers the
  workflows we can predict and the ones we can only discover.
- **Pure modules for the two hard parts.** Error-body parsing and field
  classification are branchy, data-shaped logic. Both go in `vscode`-free modules
  so they are exhaustively unit-testable against real Jira payloads, leaving
  `tasksView` as thin orchestration.
- **Skip rather than guess on unsupported types.** API v3 rejects plain strings for
  rich-text fields (they must be ADF). Sending one anyway would trade a clear
  "we didn't fill this" for a confusing second rejection.
- **Write failures stop gating the panel.** The gate exists for states where there
  is genuinely nothing to render — unreachable site, bad project key, auth loss.
  A rejected status change is not one of them: the list behind it is still valid,
  and blanking it loses the user's place.
- **In-panel toast action, deviating from the `remove-from-sprint` precedent.**
  That spec chose a native VS Code notification for Undo specifically because
  toasts had no action support. Here the action is a plain link-out and the
  webview already sends `openExternal`, so the cost is one optional field on the
  toast message plus a button — cheaper than a notification, and it keeps the
  failure next to the list it refers to.

## Components

### 1. Jira error parsing — `src/jira/errors.ts` (new)

```ts
export class JiraApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly fieldErrors: Record<string, string>,
    readonly messages: string[],
  );
}

export function parseJiraError(status: number, body: string): JiraApiError;
export function describeJiraError(e: JiraApiError, fieldNames?: Record<string, string>): string;
```

`parseJiraError` reads Jira's standard error envelope
(`{errorMessages: string[], errors: Record<string,string>}`) and keeps both halves
on the error object so callers can act on `fieldErrors` structurally, not by
string-matching.

`describeJiraError` renders it for humans: `errorMessages` joined as sentences
(punctuation normalised), then each field error as `Display Name: message`, using
the optional id→name map the caller holds from transition metadata. Falls back to
the raw id when unmapped.

Fallbacks when the body is not a usable envelope — non-JSON, HTML error pages,
empty bodies:

| Status | Message |
|--------|---------|
| 400 | `Jira rejected the request (400).` |
| 404 | `Jira couldn't find that issue (404).` |
| 429 | `Jira is rate-limiting requests (429) — try again shortly.` |
| 5xx | `Jira is having trouble (503) — try again shortly.` |
| other | `Jira returned an error (${status}).` |

`JiraAuthError` keeps its current identity and behaviour — 401/403 still re-gate
to the sign-in screen.

### 2. Field classification — `src/jira/transitionFields.ts` (new)

```ts
export type FieldPrompt =
  | { kind: "pick";      id: string; name: string; choices: { id?: string; name: string }[] }
  | { kind: "multipick"; id: string; name: string; choices: { id?: string; name: string }[] }
  | { kind: "text" | "number" | "date" | "labels"; id: string; name: string };

/** `fields` is Jira's raw per-transition metadata, keyed by field id:
 *  { required, name, schema: { type, system?, custom?, items? }, allowedValues?, hasDefaultValue } */
export function promptableFields(fields: Record<string, unknown>): {
  prompts: FieldPrompt[];
  skipped: string[];   // display names, for logging
};

/** `input` is what the prompt produced: a chosen name (pick), chosen names
 *  (multipick/labels), or the raw box text (text/number/date). */
export function toJiraValue(prompt: FieldPrompt, input: string | string[]): unknown;
```

Classification, in order:

1. Not `required` → ignored entirely (optional screen fields are never prompted).
2. Has `allowedValues` → `pick`, or `multipick` when `schema.type === "array"`.
3. `schema.type === "array"` with string items (`labels`) → `labels`.
4. `schema.type` of `string` / `number` / `date` / `datetime` → the matching scalar
   prompt — **unless** it is a rich-text field (`schema.system` of `description` or
   `environment`, or a `...:textarea` custom field), which is skipped.
5. Anything else (cascading selects, `user` pickers with no `allowedValues`,
   unknown customfield types) → skipped.

`toJiraValue` maps back to Jira's wire shape: `{id}` for allowed values (falling
back to `{value: name}` when an entry has no id), `[{id}, …]` for arrays,
plain strings for `labels`, coerced `Number` for numerics, `YYYY-MM-DD` for dates.

### 3. Client — `src/jira/client.ts`

- `request()` throws `parseJiraError(res.status, body)` instead of
  `` new Error(`Jira ${status}: ${body}`) ``. Existing `JiraAuthError` branch is untouched.
- `getTransitions()` requests `?expand=transitions.fields` and returns a `fields`
  record alongside the existing `{id, name, toName, toCategory}`.
- `transition(key, transitionId, fields?)` merges `fields` into the POST body when
  non-empty; the no-fields call site is unchanged.
- `listResolutions()` — `GET /rest/api/3/resolution`, used only on the recovery
  path when a validator names Resolution but no field metadata exists to draw
  allowed values from.

### 4. Orchestration — `src/tasksView.ts`

`changeStatus(key)` becomes:

1. Fetch transitions (now with field metadata), pick the target status — unchanged.
2. `promptableFields()` on the chosen transition; run each prompt in order.
   **Esc at any prompt cancels the whole transition** — nothing is written.
   Skipped fields are logged, not surfaced.
3. POST with the collected fields.
4. On `JiraApiError`, run recovery **once**:
   - `fieldErrors` non-empty → prompt for exactly those ids, using the transition's
     metadata for choices (even where `required` was false).
   - Otherwise, match each `errorMessages` entry against the transition's field
     display names, case-insensitively.
   - Otherwise, if a message mentions "resolution", fall back to `listResolutions()`.
   - Anything to prompt for? Prompt and re-POST once. Nothing found, or the retry
     also fails → report via toast.
5. Success path (`statusChanged`, provenance label, success toast) — unchanged.

The catch block in `onMessage` gains one distinction: the full-panel `error` is
posted **only** for `ready`, `retry`, and `fetch`. Every other message type — all
the writes — gets a toast alone.

### 5. Toast action — `src/types.ts`, `src/webview/App.tsx`, `src/webview/styles.ts`

- `OutboundMessage`'s toast variant gains `action?: { label: string; url: string }`.
- `ToastStack` renders the action as a button that sends `openExternal`, and a
  dismiss control.
- **Error-level toasts no longer auto-dismiss** (today: 4.2s for every level).
  Success and info keep the existing timer. A validator message is multi-line and
  4.2s is not long enough to read it.

## Error handling

| Failure | Behaviour |
|---------|-----------|
| Transition fetch fails | Existing catch — toast, list intact. |
| User escapes a field prompt | Silent cancel. No write, no toast. |
| Invalid input (NaN, bad date) | InputBox `validateInput` blocks it inline; no round-trip. |
| POST rejected, fields identifiable | Prompt and retry once. |
| POST rejected, nothing identifiable | Readable toast + **Open in Jira**. |
| Retry also rejected | Readable toast + **Open in Jira**. No further retry. |
| 401/403 at any point | Unchanged — re-gate to sign-in. |
| Provenance label stamp fails | Unchanged — logged, swallowed. |

## Testing

**`test/unit/jira/errors.test.ts`** — every body shape against representative
statuses: `errorMessages` only (the reported 400), `errors` only, both, empty
envelope, non-JSON text, an HTML error page, an empty body. Plus
`describeJiraError` with and without an id→name map, and punctuation
normalisation.

**`test/unit/jira/transitionFields.test.ts`** — classification for each branch
(allowed values single and array, labels, string, number, date, datetime,
rich-text skip, cascading skip, non-required ignored) and the matching
`toJiraValue` output, including the no-id `{value}` fallback.

**`test/unit/jira/client.test.ts`** — `getTransitions` sends the expand parameter
and surfaces `fields`; `transition` includes `fields` only when non-empty;
`request` throws `JiraApiError` carrying status and both error halves.

**`test/unit/tasksView.test.ts`** — the required-field prompt sequence and the
exact POST payload; Esc mid-prompt writes nothing; recovery re-prompts and
re-POSTs exactly once from `fieldErrors`, from `errorMessages` name-matching, and
from the resolution fallback; a second failure does not retry; a write failure
emits a toast and **no** `error` message, while a failed `fetch` still does.

**`test/webview/`** — error toasts persist past the auto-dismiss window; the
action button posts `openExternal` with the issue URL.

## Out of scope

- Optional (non-required) transition screen fields.
- Rich-text / ADF field entry, cascading selects, user pickers.
- Any status-change affordance in the Deck view — it has none today.
- Comment-on-transition. The generic field path covers the workflows that ask for
  a written reason via a required field; a free-floating comment box is a separate
  feature.
