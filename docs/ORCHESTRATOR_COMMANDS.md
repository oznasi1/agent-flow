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
4. **Stop at the ceiling, if you set one.** A flow's optional **spend
   ceiling** bounds what it may spend over its whole life — sessions opened
   plus commands run — counted off its own journal. A pass whose spends would
   take that total past the ceiling performs none of them, disarms the flow,
   and says so in a notification. See [The ceiling](#the-ceiling).
5. **Ask for consent, once per kind of spend.** Two separate gates: one
   covers launching and seeding sessions, the other covers running
   shell. Consent to open a session is **not** consent to execute a command,
   so a flow you approved before commands existed is asked again. The modal
   names the actual command text. The pass that asks performs nothing —
   approval only lets the *next* pass act.
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

stdout and stderr go to the Deck's output channel, and — for any armed flow —
into [the flow journal](FLOW_JOURNAL.md) alongside the `fired`/`errored` line
the rule stamps. When that flow is attached to a card as a workflow, the
card drawer's Workflow block offers an **Output** button on the step, which
reopens the journal's copy in its own editor tab — the way to read it back
after the output channel itself has scrolled past it or the window has
closed. The rule's own receipt carries the exit code and a sentence, not the
output.

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
| Spend ceiling                  | none by default | Optional lifetime bound per flow on sessions + commands, counted off the journal; the pass that would cross it disarms the flow instead. |
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
