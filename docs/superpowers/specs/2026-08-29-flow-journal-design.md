# Append-only flow journal — the history the flow file keeps destroying

**Date:** 2026-08-29
**Branch:** `worktree-feat-flow-journal`
**Backlog item:** none — notepad item [03], from the orchestrator review against Babysitter

## Why

The flow file **is** the history. A rule's receipt lives on the edge that fired it —
`firedAt`, `firedNote`, `error`, `performed` — and that is the only record anywhere
that it ran. Reset (`flow:resetEdge`) exists precisely to clear those fields so the
rule can fire again, and it does exactly that: press Reset on a deploy that failed
at 2am and there is no longer any evidence it ever ran, what it printed, or why it
stopped.

Three more holes follow from the same root:

1. **Command output dies with the window.** `runCommand` joins stdout and stderr and
   hands them to `deps.log` — a VS Code output channel. Close the window and the
   only copy of a failed deploy's output is gone. The edge keeps a one-line
   `error`; the 400 lines that explain it do not survive.
2. **"Why did it not fire" is unanswerable after the fact.** A pass can leave a rule
   pending for four different reasons — deferred by `performEdge`, skipped because
   another window disarmed the flow mid-pass, skipped because the lock was reaped,
   or waiting on consent — and every one of them is a `this.log` line in a channel
   nobody was watching at 2am.
3. **A mangled flow file is unrecoverable.** `coerceFlow` is deliberately lossy: a
   shape-invalid node or edge is dropped on read, and dropped for good on the next
   write. That is the right call for keeping the drawer alive, and it means a
   hand-edit or a half-written file silently costs you wiring with nothing to
   reconstruct it from.

The cheapest good fix is the one Babysitter already ships: an append-only event log,
one line per thing that happened, sorted chronologically by construction. Every event
this design records is **already computed** inside `advanceUnderLock` — the pass
knows it fired, deferred, skipped or promoted, and throws that knowledge at a log
channel. The pass already writes once, atomically, under a lock. The append rides
along.

It is also the prerequisite for everything downstream: a drawer timeline, per-flow
cost accounting, and retry policy all need a record of what happened, and none of
them can be built on a file that Reset erases.

## Decisions taken

### 1. Journal only. No UI in this slice.

The deliverable is a correct, durable, `jq`-readable file and the appends that
produce it. Rendering a timeline in the drawer is a separate spec: it adds a read
path into the webview, a new message type, pagination, and real design work, and
none of that is needed for the journal to start being valuable — the file answers
the 2am question the moment it exists.

### 2. One `.jsonl` per flow, a sortable id per line — not one file per event

Babysitter's scheme is one ULID-named file per event, so lexical sort of a directory
listing is chronological. The same property is available for free inside a single
append-only file, where lines are already in write order, and the single file avoids
a directory of thousands of entries per flow and costs one `O_APPEND` write instead
of an `open`/`write`/`close` per event.

The ULID-shaped `id` stays on each line anyway, for two reasons that survive the
change of container: it makes two events in the same millisecond orderable (the
`at` timestamp alone does not), and it gives a stable handle for a future timeline
to key rows by.

### 3. The journal survives `removeFlow`; it is capped by bytes

`removeFlow` deletes `<id>.json` only. The `.log.jsonl` stays.

This is the case the feature exists for. The user who deletes a flow is very often
the user who just watched it fail — deleting the record along with the flow loses
the history at exactly the moment someone wanted it. A journal for a flow that no
longer exists is still the answer to "what did that thing do before I threw it
away".

Unbounded is not an option either: a `run` edge can emit a large output every six
seconds. A **1 MB per-file cap** trims oldest whole lines on append. The trade-off
is stated rather than hidden — a sufficiently chatty flow does lose its oldest
history — and byte-capping rather than line-capping is what makes the bound real,
since a single command output can be larger than a hundred ordinary events.

### 4. Command output is truncated head + tail to ~8 KB

The head carries which command actually ran and how it started; the tail carries the
failure. Both are what a person reads; the middle is what a person scrolls past.
Storing it verbatim would let one verbose deploy evict a flow's entire history under
the cap, so the truncation is what keeps decision 3's bound from being self-defeating.

The elision is explicit in the stored text (`… N bytes elided …`) so nobody
mistakes a truncated log for a complete one.

### 5. No new setting — it rides `agentFlow.orchestrator`

The repo invariant is that new behaviour ships inert behind a default-off setting.
The orchestrator itself **is** that default-off setting, and the journal changes no
user-visible behaviour: it writes a file, and in this slice nothing reads it back
into the UI.

The stronger argument is that a post-mortem record you have to enable in advance is
empty exactly when you need it. The 2am fire has already happened by the time anyone
goes looking for the setting. A journal that is off by default is a journal that is
blank for every first incident, which is every incident that matters.

### 6. Journal after the flow write, never before

The append happens *after* `writeFlow(next)` succeeds. A crash in between loses a
line rather than inventing an event the flow file does not corroborate.

This is the same direction as the existing, documented act-then-record trade-off in
`advanceUnderLock`: given a choice between under-claiming and over-claiming, the
orchestrator under-claims. A journal line asserting a launch the flow file has no
stamp for would be worse than a missing line, because the missing line is visibly
missing and the false line is not.

## Architecture

### The record

`~/.agentflow/flows/<flowId>.log.jsonl`, one JSON object per line:

```json
{"id":"01K5X8QZ4700A3","at":1756483200123,"flow":"f1x2-ab3c","kind":"fired","edge":"e7","from":"n1","to":"n4","action":"run","note":"\"deploy staging\" exited 0","sum":"3f9a1c2e"}
```

| Field | Meaning |
|---|---|
| `id` | ULID-shaped: 48-bit millisecond timestamp in Crockford base32, then a random tail. Lexically sortable; minted monotonically within a process so same-millisecond events keep their write order. |
| `at` | Epoch ms. Redundant with `id` on purpose — a human reading the file with `jq` should not have to decode base32. |
| `flow` | The flow id. Redundant with the filename, so a concatenated or copied journal is still self-describing. |
| `kind` | See the table below. |
| `sum` | Short checksum over the other fields. |

`sum` is not a tamper defence — it is a **torn-write** defence. `O_APPEND` makes the
write offset atomic, but not an 8 KB payload: two windows appending a large command
output can interleave their bytes. A line whose checksum does not match its content
is skipped on read, which is precisely the posture `readFlows` already takes toward
a corrupt flow file — one bad record costs that record, never the view.

Per-kind fields:

| `kind` | Fields | Emitted when |
|---|---|---|
| `armed` | `armed`, `source` | The flow is armed or disarmed |
| `consent-asked` | `target` | A pass needs first-spend consent and performs nothing |
| `consented` | `answer` | The user answers the first-spend modal |
| `fired` | `edge`, `from`, `to`, `action`, `note`, `output?` | A rule fired and was stamped |
| `errored` | `edge`, `from`, `to`, `action`, `error`, `output?` | A rule was stamped with an error |
| `deferred` | `edge`, `reason` | `performEdge` returned `defer` |
| `skipped` | `edge`, `reason` | `disarmed-mid-pass` or `lock-lost` |
| `promoted` | `node`, `runKey`, `repo` | A planned node became a place |
| `reset` | `edge` | `flow:resetEdge` cleared a stamp |

`output` appears only on a `run` edge's `fired`/`errored`, carrying the truncated
stdout+stderr.

### The module

`src/engine/orchestrator/journal.ts`, pure over an injected IO — the same seam
`store.ts` uses, and for the same reason: the whole trim-and-recover story is
testable from a plain object with no temp directory and no real clock.

```ts
export interface JournalIo {
  append(p: string, line: string): void;
  size(p: string): number | null;   // null when the file does not exist
  readFile(p: string): string | null;
  replace(p: string, text: string): void;  // write to a tmp path, then rename over p
}

export function appendEvent(
  io: JournalIo, dir: string, flowId: string, ev: JournalEventInput,
  nowMs: number, rand?: () => number,
): void;

export function readJournal(io: JournalIo, dir: string, flowId: string): JournalEvent[];
```

The journal path is built from a flow id exactly as `fileFor` builds a flow path,
and reuses the same `VALID_FLOW_ID` charset check. An id like `../../.zshrc` has to
be refused in both places or the second one is a hole; the check is exported from
`store.ts` rather than duplicated, so the two cannot drift.

**Trim lives inside `appendEvent`.** Before appending: if `size(p) + line.length`
exceeds `JOURNAL_CAP_BYTES` (1 MB), read the file, drop whole lines from the front
until the new line fits, `replace` atomically, then append. `replace` is
tmp-plus-rename rather than a truncating write so a crash mid-trim leaves the old
complete journal rather than a half-written one.

`readJournal` is not for the UI in this slice — the trim path needs it, and it is
what makes decision 6's "reconstruct a mangled flow" claim true today rather than
in a later spec. It skips any line that fails to parse or whose checksum does not
match, and returns the rest.

`nodeJournalIo()` joins `nodeFlowIo` and `nodeLockIo` in `flowIo.ts` — the one file
in this directory allowed to import `fs`. It is `fs.appendFileSync` (which opens
`O_APPEND`), `fs.statSync`, `fs.readFileSync`, and a `writeFileSync` +
`renameSync` pair.

### Where it hooks into the pass

Every site already has the fact in hand and currently throws it at `this.log`.

| Event | Site in `deckView.ts` | Under the lock? |
|---|---|---|
| `fired` / `errored` (+ `output`) | after `writeFlow(next)`, derived from `stamping` and `outcomes` | yes |
| `promoted` | same write, one line per `promotions` entry | yes |
| `deferred` | the `done.kind === "defer"` branch | yes |
| `skipped` | the `!stillArmed` branch and the `lostLock` branch | yes |
| `consent-asked` | the `asks.push` branch | yes |
| `consented` | `askFirstSpend`'s answer write | no |
| `armed` | the `flow:arm` handler | no |
| `reset` | the `flow:resetEdge` handler | no |

The three unlocked sites are genuinely unlocked, matching how those handlers already
write the flow file — they re-read immediately before writing and touch only
flow-level fields. Two windows appending concurrently is exactly the case the `sum`
field above exists for.

`fired`/`errored` are derived from the same `stamping` list and `outcomes` map that
`applyFired` consumed, and read `hit.action` — the action the *evaluation* decided —
for the same reason `applyFired` does: on a concurrent edit, `e.action` and
`hit.action` can disagree about what kind of edge this is, and the journal must
record the verb that actually ran.

### Failure posture

Every call site wraps its append so a journal failure logs once and the pass
continues. The journal observes; it never participates. A full disk, a permissions
error, or a bug in the trim path must not stop a deploy rule from firing — a missing
line is a lost record, an aborted pass is a lost deploy.

**The trim's cross-window race is accepted, not fixed.** `trimFor` is
read-modify-rename: window A reads the journal, window B appends, A renames its
trimmed copy over the file, and B's lines are gone. The per-line checksum defends a
torn line, not a discarded append. The low-water mark makes it rare — a trim now runs
once per ~250 KB of appends rather than once per line at the cap — but does not
eliminate it. We do not take the flows lock to close it, for two reasons.
`journal.ts` is the pure half of the pure/`*Fs` split and must not learn about
locking; and making a user gesture (arm, reset, consent) block on another window's
120-second command just to write a log line would be a real behavioural regression —
strictly worse than losing journal lines. The cost is bounded to journal lines and
never touches flow state.

## Out of scope

- **The drawer timeline.** No read path into the webview, no new message type, no
  rendering. A separate spec.
- **Viewing command output in the UI.** The output is stored; surfacing it is part
  of the timeline spec.
- **Cost and retry features.** This is their prerequisite, not their delivery.
- **A cross-flow journal or any aggregate view.** One file per flow, read one at a
  time.
- **Journalling flow creation, rename, save, or delete.** The note's six kinds plus
  `consent-asked`, `deferred` and `skipped` cover "what did this flow do"; node-drag
  events would bury them.
- **Migrating or backfilling.** Existing flows start with an empty journal; the
  stamps already on their edges are not replayed into one, because their timestamps
  are the only thing known about them and inventing the rest would be fiction.

## Testing

`test/unit/engine/orchestrator/journal.test.ts`, against an in-memory `JournalIo`:

- Round-trip: `appendEvent` then `readJournal` returns the events, in order.
- Ids are monotonic and lexically sortable for two events in the same millisecond.
- The trim evicts oldest-first, keeps the file under the cap, and never leaves a
  partial line at the front.
- A line with a mangled checksum is skipped and its neighbours survive.
- A line that is not JSON at all is skipped and its neighbours survive.
- A flow id outside `VALID_FLOW_ID` throws rather than resolving outside `dir`.
- Output truncation keeps the head and the tail and states the elided byte count;
  an output under the limit is stored verbatim with no marker.
- An append larger than the cap on its own still yields a readable file.

`test/unit/deckView.test.ts` additions, using the existing fake-IO pattern:

- One case per hook site, asserting the emitted line's `kind` and its edge/node id.
- A `fired` line for a `run` edge carries the truncated output.
- A `JournalIo` whose `append` throws does not abort the pass: the flow is still
  written and the remaining edges still fire.
- No journal line is written for a pass in which `stamping` is empty.

Coverage thresholds in `vitest.config.ts` apply as normal (90% lines/statements,
85% branches/functions).

## Global constraints

- **`npm run typecheck`, `npm test`, `npm run build` must all pass.** The CI gate is
  exactly `npm ci`, `npm run typecheck`, `npm test`, `npm run build`.
- **`npm test` is ~4,500 tests and takes 2+ minutes** — run it with a 600000 ms
  timeout, never pipe it through `tail` or `head`.
- **The existing suite must pass unmodified.** A test that had to be edited to go
  green is the signal to stop. `test/unit/compat.test.ts` in particular should be
  untouched: no new setting, no new command id, no new telemetry wire value, and no
  change to the on-disk run or flow shape.
- **`journal.ts` must not import `fs` or `child_process`.** It mirrors `store.ts`
  exactly, which is host-only and does import `os`/`path` to build a file path; all
  real IO lives in `flowIo.ts` behind the injected `JournalIo`. If the timeline spec
  later needs any of this from the webview, the repo's documented fix applies —
  extract the pure part into a leaf module, do not reshuffle the caller.
- **Vocabulary.** `test/unit/vocabulary.test.ts` is enforced: a session is one run of
  a coding tool; an agent is a worker a session delegates to. Journal `kind` values
  and field names are identifiers and keep whatever spelling they ship with.
- **No hardcoded organization values.** Nothing here reads one, but the cap and the
  truncation limit are module constants, not settings.
- **Changelog.** A `## [Unreleased]` entry in `CHANGELOG.md`.
- **Docs.** The on-disk format is now a surface users can `jq`, so it is documented
  in `docs/` alongside the orchestrator's other file formats.
