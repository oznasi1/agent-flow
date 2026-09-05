# Agent Flow Deck — the full guide

> A short tour lives in the [README](../README.md). This page is the complete behaviour of
> every panel, including the edge cases. For settings see [SETTINGS.md](SETTINGS.md); for
> what leaves your machine, [PRIVACY.md](PRIVACY.md).

## What it does

- **Sidebar panel** with two tabs — **Tasks**, the pool of tickets, and
  **[Notepad](#the-notepad--work-that-isnt-a-ticket)**, for work that never had one. The
  project key and your name live in VS Code's own view title bar, and the open-window
  gauge and **Explore** sit at the end of the tab row.
- **Task pool** with filter tabs (My sprint · Unassigned · Mine ·
  Sprint · Backlog) and a size lens (S/M/L by original estimate). The size lens, status
  lens, and repo search can each be hidden if you don't use them (`agentFlow.filters.size` /
  `.status` / `.repo`, all on by default).
- **Jira fetch** over the REST API. Reads are the default; the only writes are optional
  status changes from a card — which also stamp a provenance label (default `claude-code`,
  configurable via `agentFlow.provenanceLabel`, toggle with `agentFlow.stampLabelOnWrite`).
- **Service inference** — reads the ticket's components/labels/text and matches your
  local repo checkouts (backend *and* frontend).
- **Open + seed** — writes `.pick-task/TASK.md` into each repo (git-excluded), generates a
  `<KEY>.code-workspace` (or one window per repo, or a per-task git worktree), and pre-fills
  your tool — the Claude Code panel, Copilot Chat, or either one's CLI in a terminal —
  with your chosen prompt mode (you press Enter to start).
- **Address PR** — an **Address PR** button appears once a task has an open PR waiting on you.
  On the sidebar's Tasks card that means reaching your PR-review status (default `PR initiated`);
  on a Deck card it means the review column's waiting lane, with an actual open PR behind it —
  the two surfaces gate on different things. From the sidebar's task card the button kicks off
  a session **in a fresh worktree**; from a Deck card it re-seeds the workspace that run already
  has — and asks where to put it: the run's own window, this window, a `.code-workspace` you
  have, or an Agent Flow window that is already open (`agentFlow.prWorkOpenIn`, set it to
  `its-window` to be asked nothing). Either way the session finds
  the task's GitHub PR by its Jira key, checks out its branch, and assesses whether it's ready
  for your fixes — then, by default, starts implementing the requested changes (toggle with
  `agentFlow.prReviewAutoFix`).
- **Review queue** — a strip on the Deck lists every open PR that asks for *your* review,
  sortable by oldest or smallest, with per-row size, CI and age. **Review with …** (the
  button names your configured tool — `Review with Claude Code`, `Review with Cursor`, or
  `Review with Copilot`) — a play button on every row, or the labelled button once you open
  one — checks it out into a worktree and seeds a session to review it; submitting the
  review itself from the Deck is opt-in and ships **off** (`agentFlow.reviewWrites`).
- **Launch in parallel** — filter the repo lens to one repo **or several** and a checkbox
  appears on each task. Tick a few, then **Launch in parallel**: each task gets its own git
  worktree (its own branch) in whichever of the filtered repos it's inferred to touch — or
  in all of them, when the ticket names none, so no task launches with no repo. You're
  asked once where the batch goes (the same destinations a single **Take** offers), and for
  a new window, how to lay it out: **separate windows**, one per task, or **one shared
  window** holding every task's worktrees with a Claude Code session seeded per task,
  stacked as tabs in one Claude group in the order you picked them. Every other destination
  *is* a single window, so it goes straight to the shared layout. Batches larger than
  `agentFlow.batchLaunchConfirmThreshold` (default 6) ask first. (Under Copilot, a batch
  writes every brief but seeds no chat panel — Copilot Chat is single-instance. See
  [Where the session opens](SETTINGS.md#where-the-session-opens).)


## The Notepad — work that isn't a ticket

Not everything worth a session has a Jira key. The panel's second tab, **Notepad**, is a
plain list of things you want to do: a title, optional detail, a checkbox.

<p align="center">
<img src="../media/notepad.png" alt="The Notepad tab of the Agent Flow Deck sidebar panel: an add-note form (title field, detail textarea, Add note button), an All / Active / Done segmented filter with a Clear completed button under it, and three notes. Each note leads with a drag grip and a done checkbox, then its title and detail, and — in its top right corner — a filled Start button above quiet edit and delete icon buttons that together span Start's width; one note carries a blue rail and a Running badge, another a green rail and a Finished badge." width="420" />
</p>

- **Notes are yours, not the workspace's.** They're stored in the editor's global state,
  not per-workspace, so the same list is there whichever repo or workspace the panel
  happens to be open against.
- **Start** kicks off a session from a note the same way **Explore** does: it asks where to
  open and which repos to use, writes a `## Notepad:` brief from the note's title and
  detail (with Explore's topic-agnostic prompt), and seeds the session. The note stays in
  the list afterwards — running it isn't the same as finishing it.
- **The run lands on the Deck** like any other, and the note grows a badge tracking it:
  **Running** while a session is attached, **Stale** once nothing is, **Finished** when the
  Deck records it as landed. Re-running a note replaces that note's previous run rather
  than piling up a second record.
- **A screenshot is a detail too.** Paste an image straight into the detail field — the
  field says so — drop an image file onto a note, or pick one with **Attach image**,
  which sits beside **Add note** and in a note's edit form. Thumbnails sit under the
  note's text and open full size in an editor tab. **Start** copies them into
  `.pick-task/images/<run key>/` beside the brief and names them in both the brief and the
  seeded prompt, so the session reads what you saw instead of your description of it. The run
  key in that path is what keeps a note you start now from overwriting the screenshot a
  session started earlier is still working from. PNG, JPEG,
  GIF and WebP, up to 10 MB each; the files live beside your notes in the editor's global
  storage and go when the note or the image does.
- **Order is yours.** Each note has a grip — drag it to put the list in whatever order you
  want. That order persists across reloads and holds under every filter; **Reset order**
  (it appears once you've dragged something) puts the list back to newest-first.
- **Filter and clear.** The list opens on **Active**; **All** and **Done** are a click
  away, and **Clear completed** removes every checked note in one action (it only appears
  when there's something to clear).

The fields are ordinary text inputs, so your operating system's own dictation — double-tap
Control on macOS, `Win`+`H` on Windows — types straight into them. Agent Flow Deck ships no
microphone button of its own: a VS Code webview can't reach the microphone, and Electron
can't run the Web Speech API.

## The Deck — your in-flight board

Once you've taken tasks, the **Deck** (open it with **"Open the Deck (in-flight)"**)
is the board of everything you've launched, in a classic pipeline —
**In progress · Action required · In review · Merge**. Attention rises left to right and
ends at the merge, which spans both sides of it — `ready to merge` for a pull request one
click from landing, `merged · wrap up` for one that already has and still owes you a ticket
transition or a branch to delete. A ticket closed with nothing merged left no wrap-up, and
drops into **Recently closed** underneath.

<img src="../media/deck.png" alt="The Agent Flow Deck: a four-column in-flight board (In progress, Action required, In review, Merge). Its header carries the title, four tiles counting In progress, Action required, In review and Merge, a Sessions / Workspaces lens and a refresh reading 'synced 4s ago'. Each card shows its branch and launch time, per-repo diff stats with dirty/ahead markers, a live session status (working, idle, ended turn, parked, ready to merge, or merged), the PR and CI state, the Jira status, and Open / Diff actions. A note started from the Notepad tab sits among the tickets marked 'notepad'. Each column carries its own hue in its dot, header rule and a faint tint down the top of the column; the Merge column is split into 'ready to merge' and 'merged · wrap up' lanes, and a collapsed 'Recently closed' strip sits under the board. Cards are monochrome except in Action required, whose one card carries an orange rail, status and Open button." />

The columns are a neutral git + Jira backbone; each **card** carries the true live state.
A best-effort **Live signal** (read from your local Claude Code transcripts) tells `working ·
Ns ago` from `idle`, `ended turn` (needs you), or `parked` — a card only reads `parked` when
its transcript can't be read, or doesn't exist yet, which is the one route back to the git +
Jira backbone. The live signal is **Claude Code only** — it reads Claude Code's own
transcripts, and Copilot writes nothing equivalent, so a task launched under
`agentFlow.agentProvider: copilot` still gets a card, with the git + Jira + PR
backbone but no session on it. **Open** focuses the window if it's already open (never a duplicate) and
opens it fresh otherwise; **Diff** shows the working diff; **⋯** offers *Open in Jira* and
*Forget*.

The board opens with **one card per session** — its live state and
session name lead, and the repo, branch, Jira key and pull request it belongs to
sit underneath, so two sessions in one worktree read as two different pieces of
work, in whichever columns their own states put them. **Open** and **Diff** on
such a card act on that session's own directory. Switch the header control to
**Workspaces** for one card per launched task with its sessions nested instead;
whichever you pick sticks.

Run records retire themselves once a task is provably over: its directories are
gone, it landed a day ago with no session left in it, or it is an old session with
no ticket, no PR and nothing uncommitted. Uncommitted or unpushed work always
stops a record being retired, and retirement only ever deletes Agent Flow Deck's own
pointer — never a worktree, a branch, or a commit. **Clear stale** appears in the
header when records are only waiting out their window, and takes them on the spot.

The Deck also shows **every Claude Code session open on this machine**, not only
the ones it launched — read from `~/.claude/sessions`, the registry Claude Code
keeps of its running sessions. Sessions attach to the card that owns their
directory, so a worktree with two sessions in it lists both, in the order you
opened them; a place with no tracked run of its own gets a card of its own,
marked `local`. A local card reads its branch for a ticket key
(`PROJ-5641-team-table` → `PROJ-5641`, marked `~inferred` since a branch can name
a ticket somebody else owns) and for its pull request, so a worktree Claude Code
made on its own lands on the board as complete as one you took. It disappears
the moment you close its last session — **⋯** → **Track it** pins it to the runs
store first, and from there it behaves exactly like a task you took, **Forget**
included. Turn it off with `agentFlow.openAgents`, which the board picks up
immediately — no need to close and reopen the panel.

Each card also carries the **PR state** of every repo it touches, read from your forge
with its CLI — `gh`, or `glab` when `agentFlow.forge` is `gitlab`: the PR number, CI
(failing check names link to their runs, or a
passing count), the review decision with any unresolved-thread count, and
mergeability. A PR that needs a human decision — failing required checks,
requested changes, or a conflict — pulls its card into **In review**'s `fixes needed`
lane, even while the session is still working, because a session can't know CI broke until
you tell it. **Action required** is session signals only — a session that ended its turn,
stalled, or exited — so "Claude is asking you something" and "GitHub is asking you
something" stay under separate headers. A PR that is approved, mergeable and green moves
the card to **Merge**'s `ready to merge` lane, and a merged PR to `merged · wrap up`,
which is the only thing that makes a card say *merged*. Turn it off with `agentFlow.prFacts`, applied the moment you save
the setting, and cards fall back to the git + Jira backbone.

An **Orchestrator** drawer (off by default, `agentFlow.orchestrator`) lets you wire the
sessions already on the board into a *flow*: drag a card in, connect two nodes, and put a
condition on the connection — a merged PR, failing CI, a session that ended its turn, a
clean tree, a Jira status, **the command succeeded**, **the command printed** a given text, **the command
reported** a field of the JSON object it printed last as a given value, or CI passing on a
named branch of a named repo. That last one has no picker yet: you get it only by hand-editing the flow file,
not through the drawer or the list. The drawer resizes by dragging its edge or pressing
**Expand**, and switching to **List** gives the same flow a keyboard path — build, wire,
edit and arm it without a pointer.

What a connection *does* comes from the node it points at, not from a choice you make on the
rule — there is no action picker anywhere in the drawer or the list. Point a rule at
unstarted work and it **launches** that session in a fresh worktree; point it at a place that
already exists and it **seeds** a second session there; point it at a **notify** node and it
does exactly what that node says: **"Notify me in VS Code"** — a notification popped in your
own window, nothing more. It messages nobody; if you were hoping for a Slack DM or an email,
that's not what this does. Point it at
a **command** node and it runs a shell command, configured under `agentFlow.commands` (an
`id`, a `label` for the picker, the `run` string, and an optional `detail` line — see
[ORCHESTRATOR_COMMANDS.md](ORCHESTRATOR_COMMANDS.md)) or typed as
free text straight onto the node. A `run` template can contain `{note}`, replaced with the
rule's own note. A **launch** or **seed** rule can also carry a note of its own, folded into
whichever prompt mode it uses: put anything reusable in the prompt mode, and save the note
for what is specific to just this one rule.

**A command's `{note}` substitution is spliced in unquoted, exactly as typed.** A template
`deploy.sh --env={note}` fed a note of `prod; rm -rf ~` runs both commands — quoting the
template yourself (`--env="{note}"`) does not close that off either, since a `"` inside the
note still breaks out. That's inherent to letting a rule's free text reach a shell command at
all, not a bug waiting on a fix: quoting is the template author's job. A command is killed
120 seconds after it starts, but only the shell process it started — anything that process
goes on to spawn can outlive the kill. Its captured output is capped at 1 MiB; a chattier
command is killed the same way and its rule latched as a failure. A failed command (like a
failed launch or seed) latches and is never retried automatically until you click **Reset** —
deliberately, so a broken deploy doesn't run again every six seconds. A rule can opt into a
**RETRY** — a count and a wait — and then a failed launch or seed is tried again that many
times before it latches; a command's retry counts only once you have also ticked **safe to
re-run** on that rule, because no default can know which of your commands are harmless twice. Any rule can also carry a
**deadline** — a number of minutes in its **WITHIN** field — after which, if its condition
still hasn't arrived, it settles as *expired* rather than waiting forever: not a failure, not
red, just over. A sibling rule out of the same node on **a deadline here passed** is what then
acts — "if it hasn't merged in an hour, tell me" is those two rules out of one card. A condition
that arrives late still fires; the deadline only catches one that never does. The CI-passing-on-a-branch
condition reads GitHub's aggregate status rollup, which folds skipped and neutral checks
toward success — so a branch whose required build was merely *skipped* can read as passed
here. A commit with no checks at all correctly reads as unknown rather than passed, and
anything the check can't read (a failed call, a repo not checked out anywhere, an unparseable
response) reads as not-met, never as green.
A **gate** node makes the flow stop and ask you. A rule into it poses its
question; the node shows **Approve** and **Reject**; and a later rule fires on
*you approved* or *you rejected*. That is what makes "deploy to staging → ask me
→ deploy to prod" expressible without leaving the flow disarmed. A gate asks
once and latches, so Reset on the rule that asked is what poses the question
again. There is no notification: the gate node itself is the signal — it sits in
the drawer with its question, an amber state dot, and the two buttons, for as
long as it is unanswered. A **subflow** node starts a saved template as a child
workflow bound to the same card, armed and named after both; a later rule on **the subflow
finished** waits for every rule in it to settle. The card keeps showing the parent. A **dry run** reports waiting gates in words: a rule
waiting on a gate reads "waiting for your answer" there. Nothing outside
the drawer will tell you a flow is stalled at a gate.

The drawer says what each condition is waiting on right now. **Arm** a flow and it is checked
on every Deck refresh; a rule that is met fires exactly once and tells you, rather than firing
again on every later pass. It keeps advancing while the Deck is hidden — an armed flow that
only ran while you were looking at the board would not be armed — and closing the Deck
genuinely does stop it, since the panel owns the poll; closing with something armed says so. To keep
watching with the editor closed, schedule `node dist/tick.js` from the installed extension —
one pass per run, performing notifications and already-approved commands and leaving anything
that needs a window or a person pending; see
[ORCHESTRATOR_COMMANDS.md](ORCHESTRATOR_COMMANDS.md#a-pass-without-the-editor).
Reopening the Deck, including after a restart, shows you what is already ready and waits for a
**Go** before acting on it, so an armed flow can never spend anything the moment you come
back. Before it ever launches or seeds for the first time, a flow asks once — naming the
ticket, the repos, and the prompt mode it would use — and only then runs unattended. Running
its first command asks again, separately: approving a flow's launches only approves opening
sessions, never running a shell command on your machine, so a flow you already
confirmed for a launch still asks before one of its rules would run a command — and asks
per distinct command text, letting you approve one run, the next five, or always for that
text. A different command, or the same one with a different note, asks on its own.
`agentFlow.commandConsent: "flow"` asks once per flow instead and then runs every command
the flow holds unattended, which is what every release before 0.69 did. At most three of
these — launches, seeds and
commands together — happen in a single pass, with the rest picked up on the next one. A flow
can also carry a **spend ceiling** — a lifetime cap on sessions opened plus commands run,
counted off its journal and shown in its header — and a **token ceiling** in the `eq` unit a
card prints, read off its runs' transcripts; a pass that would cross the first, or wants to
spend at or past the second, performs nothing and disarms the flow with a notification saying so. A
launch, seed or command that fails stamps its rule as errored and stops it there until you
**Reset** it; a pre-flight read that fails instead — Jira unreachable, say — is retried on the
next pass rather than latched as a failure. Two VS Code windows with the Deck open cannot fire
the same rule twice.

Above the columns sits your **review queue** — every open PR that asks for your
review, found with one `gh` search. PRs in archived repositories are left out:
an archived repo is read-only, so GitHub refuses a review on one, and those
requests otherwise sit in the queue forever. Every row is visible in a height-capped,
independently scrollable list rather than being collapsed away, so a nine-request
queue is still a scroll, not a count. Each row carries the repo, PR number, title,
author, age, and its size both as `+409 −50 · 8 files` and as an S/M/L bucket;
sort by **oldest** (what you owe most) or **smallest** (what you can clear before
standup). Expanding a row fetches which checks failed and how many review threads
are still open, alongside the review decision and mergeability. **Review with …**
checks the PR out into a worktree and seeds
a session to review the diff and write its findings to
`.pick-task/REVIEW-<number>.md`, which the row can then load into the review box.
That action is also on the line itself, as a play glyph at the end of every row, so
clearing a queue does not mean expanding each row to reach it. A row already being
reviewed shows the loading mark there instead and cannot be launched twice; a row
whose repo isn't checked out locally is greyed but still live, and says why when you
hover it. Either way it opens a new window on that worktree; set
`agentFlow.reviewOpenIn` to `ask` (or straight to `this-window`) to send the session
somewhere you already have open instead — the review still runs in its own worktree
whichever you pick, and the seeded prompt names that worktree by absolute path so
nothing is checked out in your main checkout.

To clear several at once, press **select** in the strip's header: the carets become
checkboxes, clicking a row picks it instead of expanding it, shift-click takes a range,
and the bar underneath launches the lot — one reviewer per PR. The batch asks two
questions, once each, rather than once per row:

- **How should the session read each PR?** A **read-only review** fetches the PR's own
  commit and reads the diff without checking anything out, so several reviews can share
  one window and none of them can move your working tree — but it cannot run tests. Any
  other mode checks the branch out, so every PR gets its own worktree, exactly as a
  single review does. The read-only mode is offered by the batch only: it is deliberately
  not one of `agentFlow.reviewRequestModes`, so a single-row launch stays a one-click
  launch. Add the `read-only` id to that setting yourself if you want it per row.
- **Where should they open?** The same question, setting and picker a single review
  uses — `agentFlow.reviewOpenIn`: a new window, this one, a saved `.code-workspace`, or a
  window you already have open. Pin it and the batch stops asking, exactly as a single
  review does. Landing in a new window with more than one PR then asks whether you want
  them all in one window (a session each) or a window per PR.

Batches larger than `agentFlow.batchLaunchConfirmThreshold` confirm first and name the
cost in sessions. PRs in a repo you have not checked out are named once and skipped; the
rest launch. A batch never submits anything: **Approve**, **Comment** and **Request
changes** stay one row at a time, each behind its own confirmation.
Turn the strip off with `agentFlow.reviewRequests`; it also goes dark whenever
`agentFlow.prFacts` is off, since both lean on the same forge CLI — `gh`, or
`glab` when `agentFlow.forge` is `gitlab`.

With `agentFlow.reviewWrites` on (**off by default**), the expanded row also
submits: **Approve**, **Comment**, or **Request changes** — each disabled while a
submit for that row is already in flight, and each behind a confirmation dialog
that names the verb, the repo and the PR number before anything is sent. A body
loaded from the session's draft is marked as session-drafted when it goes out, unless
you turn `agentFlow.stampLabelOnWrite` off.

## The Marketplace — browse your skills, commands & agents

The **Marketplace** (open it with the puzzle-piece (`$(extensions)`) button beside the
Deck's button in the sidebar title bar, or **"Open the Marketplace"**) is a
searchable browser of everything Claude Code can do on this machine — the one panel that is
Claude-specific whatever `agentFlow.agentProvider` says, since it browses Claude Code's own
plugin ecosystem. It reads your local
`~/.claude` — the marketplaces you've added, the plugins you've installed, and the skills,
slash commands, agents and hooks inside them — plus any skills or commands you wrote
yourself in `~/.claude` or in the open workspace's `.claude/`.

<img src="../media/marketplace.png" alt="The Agent Flow Deck Marketplace: a search box over type pills (All, Skills, Commands, Agents, Hooks, Plugins) with live counts, scope pills (Everywhere, Installed only, Enabled only) and a Plugins picker, and a row of clickable marketplace tags. The browse list is grouped into category sections — Yours first, then Development — each row showing its type glyph, name, plugin, marketplace and blurb, with disabled ones struck through. The detail pane on the right shows the selected skill's tags, description, where it came from, a Copy snippet, Open file / Reveal in Finder actions, and its SKILL.md rendered underneath." />

Search is fuzzy and ranked — `revw` finds `/review`, `mkpl` finds `marketplace` — with the
best match selected as you type and the type tallies following the query. From the search
box, **↑/↓** move the selection and **Enter** opens its file. When you aren't searching,
the list groups into **category sections** read from each plugin's own manifest —
Development, Monitoring, Deployment, and so on — with everything you wrote yourself under
**Yours** first, the rest ordered by descending size, and anything whose manifest omits
the field under **Uncategorized** last. Click a section header to focus that category.

Narrow further by type, by what's installed or enabled, by **several plugins at once**
(the searchable `Plugins ▾` picker, or click a plugin name in any row), or by marketplace
(click its tag). Query, type, scope, category, plugins and marketplace all AND together,
and active selections show up as removable chips with a **Clear** action — the chip row
disappears when nothing is selected.

<img src="../media/marketplace-filters.png" alt="The same panel with the Plugins picker open: a filter box above a checkbox list of plugins, each with its marketplace and the number of rows it would reveal, two of them ticked, and a Clear 2 button. The ticked plugins appear as removable chips beside a Clear action, the type counts have dropped to match, and the list behind now shows only those plugins' assets." />

It also shows which plugins are disabled, and lists the plugins your marketplaces
catalogue but haven't downloaded yet, with the `/plugin install` command to get them.

Selecting a row **renders its file** in the pane on the right, under the metadata — a
skill's `SKILL.md`, a hook's `hooks.json` as a fenced JSON block, a plugin's README — so
you can read what something actually does without opening it; **Open file** still opens it
in an editor tab, **Reveal in Finder** shows it on disk, and **Copy** grabs the command
you'd type to use it. Files over 262,144 characters are truncated, with the same **Open
file** button covering the rest in the editor. The renderer builds elements from a parsed
tree instead of injecting HTML, so a hostile file from a third-party marketplace can't run
anything; only `http`/`https` links become clickable.

The panel is **read-only and offline** — it never writes to `~/.claude`, never runs
`/plugin install`, and makes no network calls to populate itself (opening it is a
tracked command like any other — see [Telemetry](TELEMETRY.md)). **⟳ Rescan** re-reads the disk (so does
coming back to the panel after a pause), and **+ Add a marketplace** copies the
`/plugin marketplace add owner/repo` command for you to run in Claude Code itself — new
marketplaces show up here on the next scan.

