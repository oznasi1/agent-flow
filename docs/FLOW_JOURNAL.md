# The flow journal

Every armed flow keeps an append-only record of what it did, beside the flow
itself:

```
~/.agentflow/flows/<flow-id>.json        the flow — nodes, rules, and their current stamps
~/.agentflow/flows/<flow-id>.log.jsonl   the journal — one line per event, oldest first
```

The journal exists because the flow file is not a history. A rule's receipt lives
on the rule itself, and **Reset deletes it** so the rule can fire again. Without a
journal, resetting a deploy that failed overnight leaves no evidence it ever ran.

It is written whenever `agentFlow.orchestrator` is on. There is no separate
setting: a record you have to switch on in advance is empty for the first incident,
which is the incident you wanted it for.

## Reading it

From the editor, without touching the file directly: a workflow's card
drawer offers an **Output** button on a `done` or `fail` step whose rule runs
a command (see [ORCHESTRATOR_COMMANDS.md](ORCHESTRATOR_COMMANDS.md)'s
`flow:openOutput`). It opens the LATEST `fired`/`errored` line's `output` for
that edge in its own editor tab — headed with a one-line pointer back to that
line (`kind`, `action`, the edge, and when) so two Output tabs don't read as
the same undifferentiated blob — and refuses honestly, as a toast, never a
blank tab, when there is nothing to show: nothing journaled for the flow at
all (which, per the missing-reads-as-empty posture below, reads the same as
a journal that failed to read), no line for that edge, or a line with no
`output` field at all (which reads the same whether the command printed
nothing or the output was never captured).

Or straight from the file — one JSON object per line, so `jq` works directly:

```bash
# Everything a flow did, newest last
jq -c . ~/.agentflow/flows/f1x2-ab3c.log.jsonl

# Only the failures, with their command output
jq 'select(.kind == "errored")' ~/.agentflow/flows/f1x2-ab3c.log.jsonl

# Why did nothing fire?
jq 'select(.kind == "deferred" or .kind == "skipped") | {at, edge, reason}' \
  ~/.agentflow/flows/f1x2-ab3c.log.jsonl
```

## The fields

Every line has these:

| Field | Meaning |
|---|---|
| `id` | Sortable event id — a millisecond timestamp, a within-millisecond sequence, and a random tail. Lexical order is chronological order. |
| `at` | Epoch milliseconds. |
| `flow` | The flow id, so a journal stays self-describing if it is copied or concatenated. |
| `kind` | What happened — see below. |
| `sum` | A checksum of the rest of the line. |

`sum` guards against **torn writes**, not tampering. Two editor windows can advance
flows at the same time, and a large command output can interleave mid-line. A line
whose checksum does not match is skipped when the journal is read; the lines around
it are unaffected.

## The events

| `kind` | Extra fields | Meaning |
|---|---|---|
| `armed` | `armed`, `source` | The flow was switched on or off. `source` is `toggle`, `resume-banner`, `auto-skip`, `ceiling` (the pass disarmed the flow itself at its spend ceiling), `token-ceiling` (the same, at its token ceiling), or `spawn` (a child a subflow node started). |
| `consent-asked` | `action`, `target` | A pass needed first-spend approval, so it performed nothing and asked. |
| `consented` | `answer` | You answered that question: `act`, `disarm`, or `dismissed` — and, under per-command consent, `act-once` or `act-batch` for a bounded approval. |
| `fired` | `edge`, `from`, `to`, `action`, `note`, `output?`, `result?` | A rule fired. `result` is the one JSON object a command printed as its last line, parsed from the full output before `output` was truncated — what `the command reported…` reads. Absent when nothing was reported. |
| `errored` | `edge`, `from`, `to`, `action`, `error`, `output?`, `result?` | A rule ran or was refused, and was latched with an error. `result` as above — a failed command can still report. |
| `deferred` | `edge`, `reason` | Nothing was decided; the next pass will try again. |
| `skipped` | `edge`, `reason` | `disarmed-mid-pass` (switched off while a pass was in flight) or `lock-lost` (another window took over). |
| `promoted` | `node`, `runKey`, `repo` | Planned work became a real place on the board. |
| `reset` | `edge` | A rule's receipt was cleared so it can fire again. |
| `answered` | `edge`, `answer`, `by?` | A gate was approved or rejected, on the rule that asked — by you on the node, or, with `by`, by the named login replying on the pull request. |
| `routed` | `edge`, `login`, `url?`, `error?` | A routed gate's question was posted on the pull request for `login` (`url` when the forge gave one) — or, with `error`, could not be, and the gate stays a local one. |
| `expired` | `edge`, `from`, `to`, `since` | A rule's deadline passed with its condition unmet; `since` is when its clock started. It ran nothing — see [Deadlines](ORCHESTRATOR_COMMANDS.md#deadlines). |
| `retrying` | `edge`, `attempt`, `max`, `retryAt` | A failed rule that opted into retry was scheduled to try again rather than latched — always right after its `errored` line. See [Retry](ORCHESTRATOR_COMMANDS.md#retry-if-you-ask-for-it). |
| `spawned` | `node`, `template`, `child` | A `subflow` node started a child workflow; `child` is the flow whose own journal continues the story. The child's journal opens with `armed`, `source: spawn`. |

`output` carries a command's stdout and stderr, truncated to the first and last
4 KB with the elided byte count stated in between.

## Lifetime

- **The journal outlives its flow.** Deleting a flow removes `<id>.json` and leaves
  `<id>.log.jsonl`, because the moment you most want the history is usually just
  after you deleted the thing that produced it. Delete the `.log.jsonl` by hand
  when you want it gone.
- **It is capped at 1 MB per flow.** Past that, the oldest whole lines are dropped
  as new ones arrive. A single event larger than the cap is kept anyway.
- **A trim can lose a line or two under heavy concurrent use.** Dropping the oldest
  lines rewrites the file, so if another editor window is appending at that exact
  moment its lines can be discarded. It is rare, it costs only journal lines, and it
  never affects the flow itself.
- **A journal failure never stops a flow.** If the file cannot be written, the Agent
  Flow Deck output channel says so once and flows keep running unrecorded.
