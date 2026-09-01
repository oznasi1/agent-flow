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
4. **Ask for consent, once per kind of spend.** Two separate gates: one
   covers launching and seeding sessions, the other covers running
   shell. Consent to open a session is **not** consent to execute a command,
   so a flow you approved before commands existed is asked again. The modal
   names the actual command text. The pass that asks performs nothing —
   approval only lets the *next* pass act.
5. **Run it.** Resolve the command (a named entry from settings, or the free
   text on the node), substitute `{note}`, decide the working directory, then
   hand it to the shell with a hard 120-second deadline.
6. **Stamp the outcome — once, for the whole pass.** Success or failure, the
   rule is marked and will not be evaluated again until you Reset it. Every
   outcome from the pass is written in a single write, so a crash between two
   rules cannot leave one of them looking like it never ran.

Four branches leave a pass without running anything: **busy** (lock not
taken → skip pass), **not met** (condition unmet → wait), **unapproved**
(consent pending → ask, act next pass). The other two outcomes — exit 0, or
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

Why this exists and not a finer consent: the two approvals a flow stores
(`launchConfirmedAt`, `commandConfirmedAt`) are per flow and permanent. Approve
one `deploy.sh` and every command node in that flow runs unattended from then
on, **including ones added afterwards** — and a note added later can extend the
command it lands in. An approval given once cannot know what it will authorise
later. This list can, because it is checked against the text that is actually
about to run, every time.

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

stdout and stderr go to the Deck's output channel and **nowhere else** —
that is the only place an unattended deploy's output can be read afterwards.
The rule's own receipt carries the exit code and a sentence, not the output.

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
- **Read the output** — full stdout and stderr in the Deck's output channel.
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
- **Run with the Deck closed.** The pass is a timer on the Deck panel. An
  armed flow keeps polling in a background tab, but closing the tab or the
  window stops everything. Nothing runs on a schedule outside the editor.
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
| Consent prompts                | 2 per flow     | One for sessions, one for shell — asked once each, then remembered.  |
| Telemetry about commands       | count only     | Never an id, a label, or the command text: a `run` string carries hostnames and sometimes tokens. |

## Not yet proven

Everything above is what the code does, covered by the test suite. What no
test can establish is behaviour that only exists in a real editor, and the
command path has never run in one:

- **Which shell you actually get.** No shell is specified, so it is Node's
  default — `/bin/sh` on macOS and Linux, `cmd.exe` on Windows. The Windows
  path is unexercised, including `windowsHide`.
- **The settings write.** Save to settings has only ever run against a mock
  configuration, never a real `settings.json`.
- **The chained shape end to end** — `place → deploy.sh → smoke.sh` — with a
  real repo, a real condition, and a real process.

There is precedent for taking this seriously: an earlier provider shipped
with the same kind of gap and its paths turned out never to have run in an
editor at all.

---

Numbers verified against `src/engine/orchestrator/lock.ts`,
`src/engine/orchestrator/command.ts`, and `src/deckView.ts` at the time this
page was written. First written against the Orchestrator on
`worktree-orchestrator-core`, merged with `main` at 0.13.0.
