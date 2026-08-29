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

One JSON object per line, so `jq` works directly:

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
| `armed` | `armed`, `source` | The flow was switched on or off. |
| `consent-asked` | `action`, `target` | A pass needed first-spend approval, so it performed nothing and asked. |
| `consented` | `answer` | You answered that question: `act`, `disarm`, or `dismissed`. |
| `fired` | `edge`, `from`, `to`, `action`, `note`, `output?` | A rule fired. |
| `errored` | `edge`, `from`, `to`, `action`, `error`, `output?` | A rule ran or was refused, and was latched with an error. |
| `deferred` | `edge`, `reason` | Nothing was decided; the next pass will try again. |
| `skipped` | `edge`, `reason` | `disarmed-mid-pass` (switched off while a pass was in flight) or `lock-lost` (another window took over). |
| `promoted` | `node`, `runKey`, `repo` | Planned work became a real place on the board. |
| `reset` | `edge` | A rule's receipt was cleared so it can fire again. |

`output` carries a command's stdout and stderr, truncated to the first and last
4 KB with the elided byte count stated in between.

## Lifetime

- **The journal outlives its flow.** Deleting a flow removes `<id>.json` and leaves
  `<id>.log.jsonl`, because the moment you most want the history is usually just
  after you deleted the thing that produced it. Delete the `.log.jsonl` by hand
  when you want it gone.
- **It is capped at 1 MB per flow.** Past that, the oldest whole lines are dropped
  as new ones arrive. A single event larger than the cap is kept anyway.
- **A journal failure never stops a flow.** If the file cannot be written, the Agent
  Flow Deck output channel says so once and flows keep running unrecorded.
