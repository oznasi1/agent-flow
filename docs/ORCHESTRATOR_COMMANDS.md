# Orchestrator commands: how they run, and where they stop

A rule can end in a shell command — deploy on a merge, smoke-test after the
deploy. This page is the complete, accurate account of what the machinery
actually does on each pass, and the list of things it deliberately will not
do. Every claim below is checkable against the source it is drawn from: the
engine ([`src/engine/orchestrator/`](../src/engine/orchestrator/)), the host
([`src/deckView.ts`](../src/deckView.ts)), and the drawer
([`src/webview/OrchestratorDrawer.tsx`](../src/webview/OrchestratorDrawer.tsx)) —
not the spec, which is older than some of these decisions. If this document
and the code ever disagree, the code wins.

Feature gate: `agentFlow.orchestrator`.

## The model

A flow is a graph: **nodes** are things a condition can be about or an action
can happen to, and each **rule** joins two of them with one condition. What a
rule *does* is not stored anywhere — it is derived from the kind of node it
points at, every time it is read.

That is why there is no "action" picker in the drawer. Point a rule at a
command node and it runs a command; point it at a notify node and it posts a
message. One fact, one place.

| Target node | Verb    | What it costs                                  |
|-------------|---------|-------------------------------------------------|
| `planned`   | launch  | Opens a new session — real money                 |
| `place`     | seed    | Sends a prompt into a live session — real money  |
| `command`   | run     | Executes shell on your machine                   |
| `notify`    | notify  | Nothing — a toast on the Deck, and a receipt on the rule |
| `gate`      | ask     | Nothing — the node shows Approve/Reject and a later rule reads the answer |
| `subflow`   | start   | Nothing directly — the child workflow it starts spends under its own consent |

Condition **keys** keep their released spelling — `agent-ended-turn`,
`agent-idle-over`, `no-agent-left` — because they are serialized into flow
files under `~/.agentflow/flows`. The labels shown beside them read
"session". That mismatch is deliberate; renaming a key breaks every saved flow.

## One pass

The Deck polls every **6 seconds** (`POLL_MS` in `src/deckView.ts`).
Everything below happens inside one pass, in this order, and any of the
first four steps can end the pass without a command ever running.

1. **Take the flows lock.** Flows live in one global directory
   (`~/.agentflow/flows`), shared by every VS Code window. A pass that
   cannot take the lock does **nothing at all** — no evaluation, no write, no
   toast — and tries again on the next poll. Without this, two windows read
   the same unfired rule and both act on it.
2. **Evaluate each armed flow's rules.** Conditions are read off the
   statuses this same pass already built — PR state, CI, review threads, git
   cleanliness, session activity, ticket status. A rule whose condition is not
   met, or cannot yet be answered, is simply left alone.
3. **Hold, if this is the first look.** The first evaluation after arming —
   or after a restart — that finds rules *already* met does not act. It
   reports them and waits for **Go**. A flow armed last week must not spend
   anything the moment you reopen the Deck.
4. **Stop at the ceiling, if you set one.** A flow's optional **spend
   ceiling** bounds what it may spend over its whole life — sessions opened
   plus commands run — counted off its own journal. A pass whose spends would
   take that total past the ceiling performs none of them, disarms the flow,
   and says so in a notification. A second, optional **token ceiling** does
   the same in the card's `eq` unit, read off the runs' transcripts. See
   [The ceiling](#the-ceiling).
5. **Ask for consent.** Two separate gates: one covers launching and seeding
   sessions, asked once per flow; the other covers running shell, asked once
   per **distinct command text** by default (`agentFlow.commandConsent`, see
   [Consent per command](#consent-per-command)). Consent to open a session is
   **not** consent to execute a command, so a flow you approved before commands
   existed is asked again. The modal names the actual command text. The pass
   that asks performs nothing — approval only lets the *next* pass act.
6. **Run it.** Resolve the command (a named entry from settings, or the free
   text on the node), substitute `{note}`, decide the working directory, then
   hand it to the shell with a hard 120-second deadline.
7. **Stamp the outcome — once, for the whole pass.** Success or failure, the
   rule is marked and will not be evaluated again until you Reset it. Every
   outcome from the pass is written in a single write, so a crash between two
   rules cannot leave one of them looking like it never ran.

Four branches leave a pass without running anything: **busy** (lock not
taken → skip pass), **not met** (condition unmet → wait), **at the ceiling**
(the flow disarms itself), **unapproved** (consent pending → ask, act next
pass). The other two outcomes — exit 0, or
non-zero/killed — both land in the same latch, which is terminal until
Reset.

## The shell

Three decisions get made before anything runs, and each can refuse instead:
**which command**, **with what text**, and **in which directory**.

### Which command

A command node holds either a `commandId` naming an entry in
`agentFlow.commands`, or free-text `run` — never both. A node carrying both
is refused rather than guessed at; a node naming an id that is no longer in
settings is refused too, and the drawer prints `(not configured)` instead of
quietly showing the first entry in the list.

### With what text

Every `{note}` in the command is replaced with that rule's note. A template
with no `{note}` gets nothing appended — the note is then documentation, not
an argument.

> **Injection is by design.** The note is spliced in **unquoted, exactly as
> typed**. With `deploy.sh --env={note}`, a note of `prod; rm -rf ~` runs
> both commands. Quoting it yourself (`--env="{note}"`) does not fix it
> either — a `"` inside the note closes your quote. This is the cost of
> free-text commands, which is the trade you asked for; treat the note field
> as shell you are typing. `agentFlow.neverAutoRun`, below, is the brake.

### Never, whatever you approved

`agentFlow.neverAutoRun` is a list of patterns matched against the command
**after** the note has been spliced in. A rule whose command matches does not
run. There is no button that overrides it — not the consent modal, not a flow
you confirmed months ago, not Reset. The rule stops with an error naming the
pattern, and the only way past it is editing the list.

```jsonc
"agentFlow.neverAutoRun": ["*rm -rf*", "*| sh*", "*| bash*", "*--force*"]
```

`*` matches any run of characters, `?` matches exactly one, everything else is
literal — a `.` means a dot, not "any character" — and matching ignores case.

It is empty by default, so nothing changes until you add a pattern.

Why this exists beside consent: an approval is given about the text as it read
when you were asked. Under `agentFlow.commandConsent: flow` that approval is per
flow and permanent — approve one `deploy.sh` and every command node in that flow
runs unattended from then on, **including ones added afterwards**. Under the
default per-command mode a changed note is a changed text and asks again, but
"Always for this command" is still a standing approval for a string you read
once. Neither can know what it will authorise later. This list can, because it
is checked against the text that is actually about to run, every time.

The check happens in two places: the rule never reaches the consent modal (you
are not asked to approve something that cannot happen), and it is refused again
immediately before the shell. The second is the guarantee; the first is
courtesy.

### In which directory

The command runs in a repo checkout, resolved in this order: the node's own
`cwdRepo` if it names one; otherwise the repo of the place the rule came
from; otherwise, for a chained command, the nearest place reached by walking
back through the command nodes ahead of it. If none of those answer, the
rule is refused — it never falls back to some other checkout, because
`cd`-ing a deploy into the wrong worktree is not something a later pass can
undo.

### Then, the process

```js
child_process.exec(command, {
  cwd,                      // resolved above — never a guess
  timeout: 120_000,         // Node arms this; nothing else can kill the child
  killSignal: "SIGKILL",    // a script that traps TERM still dies
  maxBuffer: 1 MiB,         // more output than this counts as a failure
  windowsHide: true,
})
```

stdout and stderr go to the Deck's output channel, and — for any armed flow —
into [the flow journal](FLOW_JOURNAL.md) alongside the `fired`/`errored` line
the rule stamps. When that flow is attached to a card as a workflow, the
card drawer's Workflow block offers an **Output** button on the step, which
reopens the journal's copy in its own editor tab — the way to read it back
after the output channel itself has scrolled past it or the window has
closed. The rule's own receipt carries the exit code and a sentence, not the
output.

## Subflows

A **subflow** node starts a saved template as a workflow of its own — a
workflow inside a workflow. It is what lets a starter compose into a bigger
shape instead of being copied into it: "when this merges, run the *Ship it*
template on this card, and when *that* finishes, notify me" is a place, a
subflow node and a notify node.

Add one from **+ Add subflow…** (the picker lists your templates and the
starters). A rule that reaches the node **starts** the template — the same
`instantiate` the card's own Attach uses, with the same repos and modes —
bound to the card the rule's **source place** is on. The child is written
**armed**, named `<parent> › <template>`, and carries a pointer back
(`parentFlow`, `parentNode`); the node records the child's id (`childFlowId`)
in the same write as the rule's stamp. A later rule out of the node on
**the subflow finished** fires once every rule in the child has settled; a
child that *stopped* on a failure has not finished, and a deadline on that rule
is how a parent bounds the wait.

Three things are deliberately so:

- **Starting is not a spend.** No cap, no consent modal for the start itself.
  The child spends under its **own** consent — it inherits none, so its first
  launch or command asks exactly as an attached template's would — and it sits
  behind its own resume gate on a fresh Deck.
- **The card keeps showing the parent.** A child binds the same card its parent
  does; it is never offered as the card's workflow, so "one workflow per card"
  stays a question about the parent alone. The child is still a real flow in
  the Workflows list and on the canvas (the node's inspector opens it), armable,
  resettable and deletable on its own.
- **It nests three deep and no deeper.** A template that starts itself is
  refused outright; a chain already three subflows deep refuses a fourth, with
  the reason on the rule. Reset on the rule that started a child does **not**
  clear the node's pointer — the child exists, with its own history — so a rule
  into a node that already started one latches with that fact; delete the child
  to start it again.

Deleting a parent leaves its children where they are. The journal records the
start as `fired` (action `spawn`) and `spawned` on the parent, and `armed` with
`source: "spawn"` on the child. A headless tick does not start subflows: it
needs the templates store and the card's ticket, which live with the editor, so
it leaves the rule pending and says so.

## A pass without the editor

The flows worth arming are the ones that watch overnight, and until now the
pass was a timer on the Deck panel: close the window and nothing moved. The
extension ships a second Node bundle for exactly that gap:

```bash
node ~/.vscode/extensions/oznasi1.agent-flow-<version>/dist/tick.js [--settings <path>] [--dry-run] [--no-fetch]
```

One invocation is one pass — the same pass the Deck runs, over the same
`~/.agentflow/flows`, behind the same lock, writing the same stamps and the same
[journal](FLOW_JOURNAL.md) lines — so a cron or launchd entry every few minutes
is the whole scheduler, and the Deck picks up whatever the tick did the next time
it opens. Exit `0` after a pass, `2` when a Deck or another tick held the lock,
`3` when it could not start.

**Where its settings come from.** There is no editor to ask, so it reads the
same `settings.json` the editor would — Code, Code Insiders or Cursor, found by
platform, or the file `--settings` names (`AGENT_FLOW_SETTINGS` works too).
`agentFlow.orchestrator` must be on in that file; `agentFlow.commands`,
`agentFlow.neverAutoRun`, `agentFlow.commandConsent`, `agentFlow.forge`,
`agentFlow.prFacts` and `agentFlow.reposRoot` are read exactly as the editor
reads them. Workspace-level settings are not: a tick has no workspace.

**What it performs, and what it refuses.**

- **`notify`** fires: the rule is stamped with its receipt and the line the Deck
  would have toasted is printed instead. Nobody is notified beyond your log —
  a cron job's stdout is the notification.
- **`run`** fires **only when the flow already consented** — a covering
  per-command record under the default `agentFlow.commandConsent: command` (a
  bounded approval is counted down), or `commandConfirmedAt` under `flow`. The
  tick never asks and never invents an approval; an unconsented command is left
  pending and named in the report. `agentFlow.neverAutoRun` is honoured before
  consent is even consulted, and the command runs through the same runner, with
  the same 120 s deadline, as it would in the Deck.
- **`launch`, `seed` and `ask` are refused**, not degraded. They need an editor
  and a person. Their met rules are left exactly as met as they were — not
  stamped, not errored — and named as `needs an editor, left pending`, so the next
  Deck pass finds them. A target whose performer is held has its siblings held
  too, so an `"all"` junction is never half-stamped.

Deadlines tick, the spend ceiling disarms, retries are scheduled and honoured,
and `the command printed…` is answered from the journal — every rule the engine
knows behaves the same, because it is the same engine.

**What is different, and stated.**

- **No resume gate.** The Deck holds first-look fires until you press Go, because
  reopening a window must not spend. A scheduled tick is you asking for
  unattended passes; it spends only what the flow already consented to.
- **No ticket.** The connector's credentials live in the editor's secret store,
  so a headless status carries no ticket: `ticket reached done` and `ticket
  status is…` never fire from a tick.
- **PR facts are refreshed** — but only for repos an armed flow's place watches,
  and only past the Deck's own TTL, through the forge CLI the settings name.
  `--no-fetch` reads the cache as the last Deck pass left it.
- **No windows.** A card's "window open" reads false; nothing here opens one.

`--dry-run` evaluates every armed flow, prints what a pass would do — `would
notify`, `would run "…" in <repo>`, what needs an editor or consent — and
writes nothing, runs nothing, and takes no lock.

### Scheduling the tick

The exit codes were designed for a timer: `2` means another pass held the lock
and the next slot will do, `3` means the tick could not start (no settings
file, or `agentFlow.orchestrator` off) and will keep saying so until you fix
the file. Nothing in the tick sets that timer up, so the extension does:

**Agent Flow: Schedule the Orchestrator Tick…** (Command Palette) asks for an
interval — every 2, 5, 15 or 30 minutes — shows exactly what it will write and
run, and then installs it with the platform's own scheduler. It finds a `node`
on your PATH or in the usual Homebrew places and, failing that, runs the
editor's own executable as Node (`ELECTRON_RUN_AS_NODE=1`). It passes
`--settings` naming *this* editor's `settings.json`, so a machine with both
Code and Cursor schedules the right one. The tick's stdout and stderr go to
`~/.agentflow/tick.log`, beside the flows and journals it writes. Run the
command again to change the interval or to **Remove the schedule**.

| Platform | What is written | How it is loaded |
|----------|-----------------|------------------|
| macOS    | `~/Library/LaunchAgents/com.agentflow.tick.plist` — `StartInterval`, `RunAtLoad`, a `PATH` wide enough to find `gh`/`glab` | `launchctl bootstrap gui/<uid> <plist>` (after a `bootout` of any earlier copy) |
| Linux    | `~/.config/systemd/user/agentflow-tick.service` + `.timer` (`XDG_CONFIG_HOME` honoured); the service lists `SuccessExitStatus=2 3` so a skipped pass is not a failed unit | `systemctl --user daemon-reload && systemctl --user enable --now agentflow-tick.timer` |
| Windows  | `%USERPROFILE%\.agentflow\tick.cmd` | `schtasks /Create /SC MINUTE /MO <n> /TN AgentFlowTick /TR <cmd>` |

**The path moves on every update.** The recipe names `dist/tick.js` by its
versioned extension directory, and the editor deletes the old directory after an
update — so a schedule left alone stops running, silently. Every activation
checks the installed recipe against the current path and, when they differ,
offers **Update the schedule** once per stale path, keeping the interval you
chose. Dismiss it and you are not asked again until the next update moves the
file.

The recipe is data (`src/engine/orchestrator/schedule.ts`), so anyone who
would rather write their own has the same facts. A cron line for a machine with
no systemd:

```cron
*/5 * * * * PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin /usr/local/bin/node ~/.vscode/extensions/oznasi1.agent-flow-<version>/dist/tick.js --settings ~/.config/Code/User/settings.json >> ~/.agentflow/tick.log 2>&1
```

Whatever drives it, the pass is the same one the Deck runs: it performs
`notify` rules and already-consented commands, leaves launches, seeds and gates
for an editor, and takes the same lock — so a Deck left open and a scheduled
tick never both act on one rule.

## Consent per command

The session gate is one timestamp per flow, and that is proportionate: a
launch names its ticket and repos, and the next one looks the same. The shell
gate used to be one timestamp too, and that was not proportionate for a
template: a shape attached to twenty cards is twenty flows, each asking once
about its first `deploy.sh` and then running every command it has — including
ones added to it later — unattended from then on. The denylist bounds what can
never run; it says nothing about the far larger set of commands that are fine
once and surprising the twentieth time.

So the shell gate is **per command** by default (`agentFlow.commandConsent:
"command"`): the approval is keyed to the **resolved command text** — the
string the modal shows, and the same one `agentFlow.neverAutoRun` matches
against. Each new text asks, and the ask offers the approval's size: **Run
once**, **Run the next 5**, **Always for this command**, or **Disarm**. A
bounded approval counts down one per run, failures included (the command ran),
and asks again when spent. A different command — or the same command with a
different note spliced in, which is a different text — asks on its own. The
answer lands in the flow's `commandConsents` record, never in
`commandConfirmedAt`.

`agentFlow.commandConsent: "flow"` is the behaviour every install had before
0.69: one approval per flow, then every command it holds runs unattended. It
is still there, and it reads exactly the `commandConfirmedAt` stamps it always
did — switching back finds the flow-wide approvals you actually gave and none
you did not. Switching *to* per-command has the opposite effect, and it is the
one thing the upgrade changes for an existing user: a flow whose commands you
approved under `flow` asks again, once per command text, because the per-flow
stamp is not consulted. The first activation after the upgrade says so, once,
to anyone with the orchestrator on who has not set the mode themselves, and
offers **Ask once per workflow** as a one-click return. Two things make the
switch safe now that did not exist when the concern was first raised: the
denylist outranks every approval, and [the ceiling](#the-ceiling) caps what any
one flow can do before it disarms itself.

Sessions (launch and seed) are unchanged either way — their gate was never the
problem.

## The latch

A rule that ran successfully is stamped fired. A rule that failed is stamped
with the error. Both are terminal until you press **Reset** on that rule.

A deploy that fails on every poll would be a real side effect on real
infrastructure, six seconds apart, until someone noticed. So a failure is a
full stop, and the drawer shows it in red with the exit code. Reset clears
the stamps and keeps your configuration — the note and the mode survive,
because they are what the rule *is*, not a record of what it did.

Every armed flow also keeps an append-only record of what it did — see
[the flow journal](FLOW_JOURNAL.md).

> **One gap, known and accepted.** The act and the record are not atomic. If
> the write after a successful command fails, the command really ran but
> nothing was stamped — and the next pass will run it again. This is the
> same gap the launch path has.

## The ceiling

`MAX_LAUNCHES_PER_PASS` is 3, and it bounds one pass of one flow. Nothing
accumulates across passes, and evaluation runs once per flow — so a poll
across *N* armed flows can spend 3*N*, every six seconds, for as long as the
conditions keep holding. Templates make *N* large cheaply: one shape attached
to twenty cards is twenty flows, each entitled to that.

A flow's **spend ceiling** is the lifetime bound. Set it in the flow header,
beside the line that says what the flow has spent so far. It counts
**sessions opened plus commands run**, and it counts them off the flow's own
[journal](FLOW_JOURNAL.md): every spend is already a `fired` line there, so
nothing is stored on the flow but the ceiling itself, and no existing flow
needed migrating. Because the journal is lifetime, so is the count — **Reset**
puts a rule back in play but un-spends nothing, and an `errored` launch that
opened no window counts for nothing.

When a pass finds that the spends it is about to perform would take the total
**past** the ceiling, it performs **none** of them, writes the flow disarmed,
and raises a notification naming the flow, the count against the ceiling, and
how many this pass wanted. Reaching the ceiling exactly is allowed. The whole
pass stops rather than the last edge over the line, so an `"all"` junction is
never left with its siblings stamped around a performer that did not run. The
journal records the stop as an `armed` event with `source: "ceiling"`. Raise
the ceiling, or re-arm, to continue.

One honest caveat: the journal is capped at 1 MB and trims its oldest lines.
A flow chatty enough to be trimmed has lost its oldest spends, so on such a
flow the count is a floor, not an exact total.

### A ceiling in tokens, not events

Sessions opened and commands run are the units you worry about at 2am, but a
poor proxy for cost: a session that loops for six hours and one that answers in
a minute both count as one. The second field in the header — **token ceiling**
— is denominated in what the work actually cost: the effort-weighted **token
equivalent** (`eq`) a Deck card already prints, computed by `engine/usage.ts`
from the same Claude Code transcripts, and summed over the runs this flow's
places belong to. Type it the way the card shows it — `800k`, `1.5M`, or a
plain number.

It is a second reader of a number already computed, not new machinery, and it
keeps a few honest edges:

- **It is the runs' figure, not the flow's.** A transcript does not say which
  session a workflow started and which you opened by hand, so the tally is
  everything spent in those runs, including your own sessions there. Reset
  un-spends none of it; neither does deleting the flow.
- **At the ceiling stops.** A new session's cost cannot be known in advance, so
  there is no "would land under" arithmetic as there is for the count: a pass
  that wants to spend while the figure is at or past the ceiling performs
  nothing, disarms the flow, and says so — journaled as `armed` with
  `source: "token-ceiling"`. A session already running keeps spending; the
  ceiling stops the flow from starting the next one.
- **Not measured is not zero.** A transcript that cannot be read is no evidence
  of spend, so such a flow is not stopped by its token ceiling — the count
  ceiling still is, and the header shows `—` where the figure would be.
- **Only a flow that sets one is read.** The figure costs a `stat` per
  transcript on every pass, so the header shows `eq` only once a token ceiling
  is on the flow. To pick a sensible number, read the card: its footer prints
  the run's `eq` today.

Keep both: the count answers "how many times did this start something", the
token figure answers "what has this cost". The headless tick enforces both
from the same transcripts.

## Retry, if you ask for it

A failure is still a full stop — for every rule that has not said otherwise,
which is every rule on disk today. But it over-applied in one place: a launch
that failed because a worktree could not be created is safe to try again, and
latching it until someone presses Reset at 2am helps nobody.

A rule that **spends** — launch, seed or run — can carry a **RETRY**: how many
more times to try, and how long to wait between tries. Off by default. When set,
a failed attempt keeps its error (the drawer shows it in red, as it always did)
but is not settled: it gains a schedule, the dry run and the card's stepper read
`retry 1 of 3 in 40s`, and once the wait has passed the rule is evaluated again
exactly as if it had never fired — the condition must still hold, and the
consent the flow already gave still covers it. A success clears the error and
says what it took (`opened bite-me-3a · after 2 retries`). The last allowed
retry failing is the full stop, with the count kept: `gave up after 3 retries`.

**A command is different, and the difference is the whole point.** A `run`
rule's retry is honoured only alongside an explicit **safe to re-run** tick on
that rule. A deploy that half-ran is not safe to run twice, and no default can
know which of your commands are idempotent — so the retry policy on a command
without the tick is inert, and the tick is asked for where it is decided, with
the one sentence that matters beside it.

Reset still works on a rule mid-retry — it is how you say "stop trying" — and
clears the count and the schedule while keeping the policy. The journal records
each scheduled retry as its own `retrying` line after the `errored` line, so
"why did nothing fire?" does not mistake a retry for a stop.

Two things a retry does **not** do. It does not retry a refusal — a rule whose
target vanished under it, or a command `agentFlow.neverAutoRun` blocked, was
never performed, so there is nothing to attempt again. And it does not paper
over the act-then-record gap described under [The latch](#the-latch): an act
whose write failed looks unfired, not failed, and is re-run by the ordinary
path regardless of any retry policy.

## Reading what a command printed

`the command succeeded` reads one bit off a command. `the command printed…`
reads its output: a rule out of a command node with a **text**, met when the
command's captured stdout+stderr contains that text — anywhere, as a plain
case-insensitive substring, not a pattern. "Deploy printed `ROLLBACK`, so page
me" and "the smoke test printed `0 failures`, so promote" are both this.

The output never enters the engine. It lives in the flow's
[journal](FLOW_JOURNAL.md) — the `fired` and `errored` lines carry it — and the
engine is bundled into the webview, which can open no file. So the host reads
each such flow's journal once per pass, answers every `printed…` rule off the
command's **latest** `fired`/`errored` line, and hands the verdicts to the
engine alongside the branch-CI verdicts; the same map rides `deck:flows` so the
dry run and the card's stepper say what the engine says. Three consequences:

- **A failed command counts.** The rule is answered once the command's own rule
  has *performed* — ran and succeeded or ran and failed — because a failure's
  output is often exactly the text worth acting on. Before it has run there is
  nothing to have printed, and the rule waits.
- **Reset resets the reading.** After Reset the command's rule is pending again,
  and this rule waits for the *next* run rather than re-reading the last one's
  line — the engine checks the performer's stamps, not just the verdict.
- **No journal, no match.** If the journal could not be written (the output
  channel says so once), a `printed…` rule waits forever. It never guesses.

A blank text is a rule that can never fire, reported as such in the inspector
and at arm time, like a blank status.

## Deadlines

An armed flow waiting on something that will never come looks exactly like one
that is working. A **deadline** is how a rule says how long it is willing to
wait. Every rule has a **WITHIN** field in the inspector and in the list — a
number of minutes, or blank for "forever", which is what every rule did before
the field existed.

Two stamps carry it, both host-owned and both cleared by **Reset**:

- **The clock starts** (`liveSince`) on the first pass that finds the rule
  *live* — its source is a place whose card is on the board, a command node
  whose own rule has already run (and succeeded or failed), or a gate whose
  question has been asked. A rule out of planned work has nothing to wait on
  yet; its clock starts when the launch promotes that node into a place. Only a
  rule **with** a deadline is ever stamped, so a flow that never sets one is
  never written for this.
- **It expires** (`expiredAt`) on the first pass past the deadline whose
  condition is still unmet. That is the third terminal stamp, beside fired and
  errored, and it is neither: nothing ran, and nothing broke. The drawer says
  `expired — waited 61m` in its ordinary voice, not in red, and the card's
  stepper marks the step `⊘`. An expired rule does not stop the workflow.

A deadline never makes the rule itself fire. What acts on it is a **sibling** —
another rule out of the same source — whose condition is **a deadline here
passed**. "If it hasn't merged in an hour, tell me" is two rules out of one
place: `PR is merged → notify` with a 60-minute deadline, and `a deadline here
passed → notify`. "Wait ten minutes, then re-seed" is the same shape pointed at
the place itself. The sibling fires on the pass after the expiry.

Three edges of the rule, stated rather than left to be discovered:

- **Met wins.** A condition that arrives late still fires the rule; the deadline
  catches a condition that never arrives, it does not refuse one that does. The
  dry run reads such a rule as *would fire*, never *would expire*.
- **A gone card does not stop the clock.** The clock started while the card
  was observable; that it has since left the board did not make the condition
  arrive. The rule expires on schedule.
- **An "all" junction dies on an expiry** exactly as it does on an error. A
  settled rule normally counts as an arrival at the junction; an expired one is
  precisely a rule that did not arrive, and "both PRs merged" is not met by one
  of them running out of time.

Disarming pauses every clock and **re-arming restarts** the pending ones, so a
flow paused for a day does not expire the moment it wakes. The dry run shows
`expires in 12m` beside a waiting rule whose clock is running, and *would
expire* on the pass that would settle it; the journal records the expiry as its
own event (see [the flow journal](FLOW_JOURNAL.md)).

## Saving a command

Type a command on a node, name it, and press **Save to settings**. The host
appends it to `agentFlow.commands` — and three things about that are
deliberate:

- It **appends to your array as you wrote it**, and writes back to the scope
  that already holds the setting. A workspace list of repo-specific deploys
  is not promoted into your global settings.
- An untouched setting is seeded from the shipped example first, so the list
  gains an entry rather than being replaced — an explicit array replaces the
  default, and writing just your command would have dropped the example out
  of the picker you were looking at.
- The **node is left as free text**. Saving means "keep this for next time",
  not "rewire this node" — and a node carrying both a saved id and free text
  is refused by the runner, so a half-applied swap would be an errored rule.

Once the text matches an entry, the row is replaced by `Saved in settings as
"…"`. Duplicates are matched on the **command**, not the name, so saving the
same line under a second name tells you it is already there.

## The picker

`+ Add command…` and `+ Add place…` are search-and-tick lists, not menus.
Type to filter — across both lines a row shows, so a place's repo is
findable and not merely visible — tick as many as you mean, and **Add**
creates one node per tick in a single write. A menu created exactly one node
per trip, which made the feature's own headline example (deploy, then smoke
test) two trips through the same menu.

Free text stays a footer action rather than a tickable row: there is nothing
to batch about a command you have not typed yet.

## Templates and workflows

A **template** is a flow with no ticket and no run, saved so its shape can be
reused. A **workflow** is a template attached to one card. That split is
UI-only — a workflow is an ordinary flow underneath, and everything above
about one pass, consent, and the latch applies to it exactly as it does to
any other flow. The names never appear in the source: the code keeps `Flow`,
`FlowTemplate`, and every `flow:*` message, because they are frozen by
`test/unit/compat.test.ts` and thousands of installs read them.

- **`flow:saveTemplate`** demotes every `place` node in the flow to a
  `planned` node — stripping the run it was bound to — and writes the result
  to a sibling `templates` directory, next to the flows directory this whole
  page has been describing. A template is never armed and never evaluated by
  the pass above: it has no ticket and nothing to watch.
- **`flow:attach`** instantiates a template against one card, binding the
  card's ticket to every planned node the template holds. The result is an
  ordinary flow, disarmed, with neither consent stamp — arming it and giving
  consent both happen exactly as described above, from scratch. Its optional
  `replace: true` first detaches whatever workflow the card already carries;
  omitting it while one is already there is a refusal, not a silent second
  attachment.
- **`flow:detach`** deletes the flow's file outright. Attachment is derived
  from the graph — a `place`/`planned` node bound to the card's run or ticket
  — never stored, so there is no separate link to clear.
- **`flow:renameTemplate`**, **`flow:deleteTemplate`**, **`flow:duplicateTemplate`**
  act on the template file only. Deleting a template never touches a workflow
  already instantiated from it: `instantiate` copies the whole shape rather
  than sharing it, so an existing workflow keeps running unaffected — a later
  rename or delete of the template it came from changes none of its rules.
  Each instantiated workflow does keep one pointer back, `Flow.fromTemplate`,
  set once by `instantiate` and never re-read for shape — its only reader is
  the Templates tab's own `on N cards` count (`OrchestratorDrawer.tsx`), which
  is why that count is exact rather than a guess by name and rule count.
- **`flow:openOutput`** reads [the flow journal](FLOW_JOURNAL.md) for the
  named edge and opens its most recent `fired`/`errored` output in its own
  editor tab — never back across the wire to the drawer, since output can be
  far larger than any receipt sentence and the drawer is a fixed 620px.
  Offered on a workflow's `done` or `fail` step whenever its rule runs a
  command; every other rule kind (launch, seed, notify, a gate's `ask`) has
  no output to read, so the button never appears for one. The opened tab is
  headed with a one-line pointer back to the journal line it came from —
  `fired`/`errored`, the action, the edge, and when — so two Output tabs
  don't read as the same undifferentiated blob. A flow or edge the journal has
  nothing for is a toast naming which of three things is true — nothing
  journaled at all (which reads the same as a journal that failed to read —
  see [FLOW_JOURNAL.md](FLOW_JOURNAL.md)), this edge never ran, or it ran
  without capturing
  output — never a blank tab.

### Finding them

The Deck's header carries two buttons where a single "Orchestrator" chip used
to sit: **Workflows** (badged `N needs you` once at least one workflow is
`waiting-on-you` or `stopped`, else a plain count of every card carrying one)
and **Templates** (badged with the total, starters included). Each opens the
drawer straight to its own view — clicking Workflows a second time while
Templates is showing switches to Active rather than closing, matching how the
drawer's own in-panel tabs behave. Neither button ever mints a blank flow;
the old chip's zero-flows click did, which meant "no flows yet" was also "no
way to reach Templates at all".

The drawer itself has three top-level views, replacing a "Flows · N ▾"
disclosure that buried Templates behind Canvas:

- **Active** lists every card carrying a workflow, one row per card, ranked
  the same way the board's own chip ranks a card with several — `stopped` and
  `waiting-on-you` first. Clicking a row closes the drawer and opens that
  card. The Workflows button's own badge and the rows underneath it are read
  from the same derivation, so the two can never name a different count.
- **Templates** lists every reusable shape — the built-in starters below,
  then whatever is saved to disk.
- **Canvas** is the flow editor itself: drawing rules, arming, dry-running,
  resuming, and now also drafting an unsaved template (below). With nothing
  open it shows an explanation instead of a blank panel.

### Built-in starters

Three shapes ship inside the extension itself, never written to
`~/.agentflow/templates/`: **Ship it** (launch → `npm test` → ask to open a
PR), **Test & notify** (launch → `npm test` → notify), and **Review only**
(launch → notify) — see `STARTERS` in `src/engine/orchestrator/starters.ts`.
**Test & notify** neither checks branch CI nor merges anything, despite the
similar name; it names honestly what a built-in CAN do without the user's own
settings — run the tests, then say so. The shape that would actually gate on
CI and merge needs a `branch-ci-passed` condition parameterised by
`{ repo, branch }`, which is unknowable before the user's own repo exists —
the same reason every starter's `planned` node ships empty `repos`/`mode`.
They carry a `builtin-` id prefix rather than a flag, so they are ordinary
`FlowTemplate` records everywhere one is read — `flow:attach`,
`flow:duplicateTemplate`, the Templates list — but every WRITE path
(`flow:renameTemplate`, `flow:deleteTemplate`, saving over one directly)
checks the prefix and refuses: *"That is a built-in template. Duplicate it to
make a version you can change."* **Duplicate** copies the shape into an
ordinary, disk-backed template the user owns; the original stays exactly as
shipped. Because none is ever copied into a user's own storage, a starter
improved in a later release reaches every install on upgrade, not only a
fresh one.

A starter's `planned` node ships with empty `repos` and `mode` — it cannot
know a checkout name or a configured prompt mode before the user's own
settings exist, and baking either in would be exactly the kind of hardcoded
value this project refuses to ship. `instantiate` fills both in at attach
time from the card being bound to: `repos` from the card's own checkouts,
`mode` from the configured prompt modes (falling back to the first one if the
node's own is empty or no longer valid). A template saved with its own
populated `repos` or a configured `mode` still wins — this fallback only
fires when the template leaves either blank, which every starter does and any
older user template might. One consequence worth stating plainly: a template
saved against one repo no longer carries that repo onto a card attached in a
different one — attaching always resolves against the card in front of you,
never the card the template happened to be saved from.

### Authoring a template directly

**＋ New template…**, on the Templates view and on an empty Canvas, opens a
fresh draft held only in memory — nothing reaches `~/.agentflow/templates/`
until Save is pressed. The draft's SHAPE can be built up the same way any
flow's can — add a notify, a gate, a command, or another planned step, and
wire rules between them — but every WORKFLOW verb is hidden: arm, disarm,
dry-run, resume, save-as-template, and **attach** (offered elsewhere as
"+ Add place…") all assume a live card with a ticket to watch, and a draft
has neither. Only **Cancel** and **Save** are offered.

Save sends `flow:writeTemplate` with the draft's flow and a name; the host
normalizes it the same way `flow:saveTemplate` does (ids cleared, disarmed,
every host stamp stripped) and writes it, then closes the draft back to the
Templates view.

**Edit**, on a saved template's own row, reopens that template on Canvas to
change it. The template is copied into the same in-memory draft a new one
uses, so edits accumulate off disk exactly as a fresh draft's do, and the
canvas paints the working copy rather than the saved one — a `deck:flows`
refresh landing mid-edit re-posts the saved copy without disturbing what you
have typed. Save then sends `flow:writeTemplate` **with** `templateId`, the
update-in-place branch: the template keeps its id (so any workflow's
`fromTemplate` and the row's "on N cards" count still point at it) and its
graph is replaced. A built-in has no Edit — the host refuses to overwrite one —
which is why its refusal says to **Duplicate** it first: the duplicate is
yours, and Edit appears on it.

**Cancel** discards the draft outright — there was never anything on disk to
clean up. Closing the drawer a different way (the panel's own Close, or
selecting a card) does **not**: the draft survives in memory, and the next
**＋ New template…** click reopens that same half-drawn draft rather than
minting a blank one — see `draftTemplate`'s own doc comment in `DeckApp.tsx`
for why only one can exist at a time. The one exception: if what is open is a
saved template being edited (not a new draft), **＋ New template…** mints a
fresh blank rather than handing that template back under a new-template
label.

### Reaching Templates from a stuck attach picker

A card's attach picker used to dead-end on "No templates saved yet" whenever
`templates` came back empty. It now offers an **Open Templates** button right
there, which closes the picker and opens the drawer's Templates view instead.

## Boundaries

### You can

- **Run any shell one-liner** — from `agentFlow.commands`, or typed on the
  node as a one-off.
- **Vary it per rule** — `{note}` is substituted with that rule's own note,
  every occurrence.
- **Chain commands** — `place → deploy.sh → smoke.sh`. A rule leaving a
  command node offers "the command succeeded", and the second command
  inherits the first one's directory.
- **Add several nodes at once** — tick multiple commands or places; each
  becomes its own node in one write.
- **Keep a one-off** — name it in the drawer and it lands in `settings.json`,
  in the right scope.
- **Read the output** — full stdout and stderr in the Deck's output channel
  while the window is open, or later from a workflow's own card drawer: a
  `done` or `fail` step whose rule runs a command offers **Output**, which
  reads the journal's `fired`/`errored` line for that edge and opens it in an
  editor tab (`flow:openOutput`). It shows the LATEST such line for that
  edge — the one the step's own done/fail state already reflects — and
  refuses honestly rather than guess when there is nothing to show: nothing
  journaled for the flow yet, this edge specifically hasn't run, or it ran
  but captured no output (which reads the same whether the command printed
  nothing or its output predates this build — the journal does not
  distinguish the two).
- **Recover a failed rule** — Reset clears the latch and keeps the note and
  mode.
- **Refuse the whole thing** — the command gate is separate from the session
  gate, so approving session launches never silently approved shell.
- **Put commands out of reach entirely** — `agentFlow.neverAutoRun` patterns
  outrank every approval, and no answer to any modal overrides one.

### You cannot

- **Wait on another branch's CI from the UI.** `branch CI passed` takes a
  repo *and* a branch, and no picker asks for them — so "wait for the build
  to pass on master, then deploy" has to be hand-written in the flow file
  today. Same for `session idle over…` and `ticket status is…`. Hand-authored
  rules do render and do run.
- **Choose the directory from the UI.** `cwdRepo` is respected by the engine
  but has no control; without it the directory is inherited from the rule's
  source.
- **Wait for several conditions.** A node's `join` is always "any" — the
  model has "all", the drawer has no way to set it.
- **Exceed two minutes.** At 120 s the child is SIGKILLed and the rule
  latches errored. Long deploys need to be fire-and-check, not
  fire-and-wait.
- **Return data to the flow.** Later rules see only succeeded or failed.
  Output over 1 MiB is itself a failure.
- **Retry automatically.** A failed command never runs again until you
  Reset it. There is no backoff.
- **Control the environment.** No env-var editing, no shell choice, no
  argument array — one string, your default shell, the extension host's
  environment.
- **Launch, seed or ask with the Deck closed.** The Deck's pass is a timer on
  the panel; closing the window stops it. A scheduled `node dist/tick.js`
  (see [A pass without the editor](#a-pass-without-the-editor)) performs
  `notify` and already-consented `run` rules, and leaves the three verbs that
  need an editor and a person pending, saying so.
- **Have two windows share the work.** One window holds the lock and acts;
  the others skip that pass entirely.

## Numbers

| What                          | Value          | Why that value                                                             |
|-------------------------------|----------------|------------------------------------------------------------------------------|
| Poll interval                  | 6 s            | The Deck's own refresh; evaluation is free once the statuses exist.         |
| Command timeout                | 120 s          | Well under the lock TTL, so a command cannot outlive the lock protecting it. |
| Flows lock TTL                 | 300 s          | Held across a whole pass; a stale lock is reaped, never stolen.             |
| Max output                     | 1 MiB          | Beyond it the process is torn down and the rule latches errored.            |
| Kill signal                    | SIGKILL        | A script that traps TERM would otherwise run past its own deadline.        |
| Consent prompts                | 1 per flow for sessions, 1 per distinct command text for shell | Sessions ask once and are remembered; shell asks per resolved text, sized once / next 5 / always. `agentFlow.commandConsent: flow` makes shell ask once per flow instead, as every release before 0.69 did. |
| Spend ceiling                  | none by default | Optional lifetime bound per flow on sessions + commands, counted off the journal; the pass that would cross it disarms the flow instead. |
| Token ceiling                  | none by default | Optional bound per flow in effort-weighted token equivalents (`eq`), read off the runs' transcripts; a pass that wants to spend at or past it disarms the flow instead. |
| Telemetry about commands       | count only     | Never an id, a label, or the command text: a `run` string carries hostnames and sometimes tokens. |

## Proven in a real editor

Everything above is what the code does, covered by the test suite. The command
path used to be unproven beyond that — no test could establish behaviour that
only exists in a real editor, and it had never run in one. It has now:
`test-e2e/orchestrator-nodes.e2e.ts` drives it in a real sandboxed VS Code.

- **Which shell you actually get.** `/bin/sh` — read from `$0` in the child, not
  inferred from the platform.
- **The settings write.** Save to settings writes a real `settings.json`: the
  host's own file gains the `agentFlow.commands` entry, with the shipped
  examples preserved and the node left as free text.
- **The chained shape end to end** — `place → command → command`, with a real
  repo, a real condition and real processes; the order is visible in the bytes
  one command appends after the other, and the second inherits the first's
  checkout.

Consent, `agentFlow.neverAutoRun`, the gate's ask-once-and-latch, Reset, and the
output tab are driven there too. Nothing in that pass found a defect.

## Still not proven

- **Windows.** That lane is macOS and Linux, so `cmd.exe` and `windowsHide`
  remain unexercised.

There is precedent for taking the remaining gap seriously: an earlier provider
shipped with the same kind of gap and its paths turned out never to have run in
an editor at all.

---

Numbers verified against `src/engine/orchestrator/lock.ts`,
`src/engine/orchestrator/command.ts`, and `src/deckView.ts` at the time this
page was written. First written against the Orchestrator on
`worktree-orchestrator-core`, merged with `main` at 0.13.0.
