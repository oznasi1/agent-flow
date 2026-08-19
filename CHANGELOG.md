# Changelog

All notable changes to **Agent Flow Deck** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`agentFlow.agentProvider` accepts `cursor`.** Seed a task straight into
  Cursor's chat, or run `cursor-agent` in a terminal. Cursor only — a stored
  `cursor` value falls back to Claude Code in every other editor, the same way
  `copilot` already falls back outside VS Code. **Doctor** gains a Cursor group
  alongside Copilot's.
- **`agentFlow.agentProvider` accepts `ask`.** Pick the agent per launch instead
  of fixing one setting. A batch asks once and uses that answer for every task
  in it; Orchestrator rules and the Deck's unattended seed run with no picker to
  show, so they always use Claude Code. Under `ask`, **Doctor** shows every
  agent this host can run rather than guessing at one.

## [0.30.1] — 2026-08-18

No functional change. Re-released so the packaged build can be installed over an
older local install.

## [0.30.0] — 2026-08-18

### Changed

- **A ticket with children offers to work them, without a setting to turn on
  first.** `agentFlow.childWorktrees` now defaults to on, so taking a story that
  has subtasks asks how you want to work them — a worktree and session per child,
  one orchestrator session dispatching a subagent per child, or just the parent on
  its own — instead of silently taking the parent. Taking a ticket with no children
  is unchanged, and setting `agentFlow.childWorktrees` to `false` restores the old
  behaviour for every ticket.

## [0.29.0] — 2026-08-18

### Changed

- **The Deck card leads with what it is.** A 22px tile at the card's leading edge
  carries a glyph per kind — ticket, Notepad note, Explore place, PR review, or an
  untracked local place — so the kind no longer has to be inferred from the shape
  of the key. A ticket's glyph stays neutral because it appears in every column and
  an accent hue there reads as a status the card does not have; the four exception
  kinds each take the hue of the column they naturally live in. The detail drawer's
  header opens with the same mark, so a selected card and its detail read as one
  object.
- **The card's top row no longer holds three competing labels.** The title is the
  anchor (clamped to two lines instead of three) with the ticket key beside it, at
  full width — it can no longer be truncated to `DEMO…`. The signal line drops to a
  mono caption beneath the title, carrying exactly the bits it carried before, and
  the live state moves below a single hairline onto its own row with the tone dot,
  the state text, and how long ago the run was launched. Failure rows, footer
  actions, drag, selection and every signal bit are unchanged.

## [0.28.0] — 2026-08-18

### Fixed

- **A merged run leaves Action required.** A card whose PRs have all landed
  now sits in **Merge**, in the `merged · wrap up` lane, whatever its agent
  last said. Before, an agent that ended its turn before the merge pinned the
  card in Action required indefinitely: the merge is a fact read from GitHub,
  but the agent state is a reading of a transcript that nothing invalidates
  once the work lands, so the question sat there unanswered for the life of
  the card. The merge is the answer. A merge you have yet to press still
  ranks below Action required — approved and green is not landed, so an agent
  waiting on you is the more urgent of the two.

## [0.27.0] — 2026-08-18

### Changed

- **The In-flight board is four zones, ending at the merge.** The fourth
  column is **Merge**, and it spans both sides of the press: a `ready to
  merge` lane for a PR one click from landing, and a `merged · wrap up` lane
  for one that already has. A merge is where the wrap-up starts — move the
  ticket, delete the branch, watch the deploy — not where the work ends, so
  it stays somewhere you can see it until the retire sweep's finished window
  elapses. The merge outranks a still-working agent, the same way a blocked
  PR already did.
- **In review means one thing:** a pull request somebody still has to look
  at. Its `ready to merge` band moved out to the Merge column.
- **The Done column is gone.** A ticket somebody marked done that never had a
  PR merge produced no wrap-up, and goes straight to **Recently closed**,
  which already offers the only two things left to do with it — reopen and
  forget.
- **Column chrome.** Each zone carries its own hue through the header dot, its
  rule and a faint tint down the top of the column. The dot is haloed on the
  zones where something is genuinely alive — In review is a queue, so it is
  not. Zone names set in mono uppercase and counts align down the board's
  right edge. The header gains a Merge tile, lit in green when there is
  anything in it.

## [0.26.0] — 2026-08-17

### Added

- **Child worktrees for a ticket that has them.** Off by default — turn on
  `agentFlow.childWorktrees` and taking a ticket with subtasks asks how you
  want to work them: a worktree and session per child, one orchestrator
  session on the parent that dispatches a subagent into a worktree per child,
  or just the parent, today's behaviour. Every child branches off the
  parent's own branch rather than main, so nothing needs merging anywhere
  but there. Leave the setting off and a Take is exactly what it was before
  this feature existed — no extra ticket read, no children query, no picker.

## [0.25.0] — 2026-08-17

### Changed

- **A worktree's workspace folder now leads with its service.** A root pointing at
  a per-task worktree is named `<repo>-<KEY>` — `account-service-ASM-6031` — so the
  explorer says which checkout a row came from instead of showing a bare key beside
  the repos it belongs to. A folder pointing at a main checkout is still just the
  repo name. Batch launches carried the same qualifier the other way round
  (`ASM-6031-account-service`) and now group by service too. File mentions follow
  the folder name, so they keep resolving to the worktree they name; workspaces
  already on disk are untouched.

## [0.24.0] — 2026-08-17

### Added

- **Each task's token spend, in its detail drawer.** Selecting a card now shows
  what the task has cost: input, output, cache-write and cache-read counts, under
  a single effort-weighted total. The weighting matters — cache reads are the
  overwhelming majority of raw tokens at roughly a tenth the rate, so a plain sum
  ranks tasks by how long the conversation got rather than by what the work cost.
  The total is labelled `eq` for that reason, and is deliberately not the sum of
  the four rows above it. Read on demand when the drawer opens, so a session that
  never opens one reads no transcripts at all.
- **An optional "Tokens on board" total in the Deck header**, behind the new
  `agentFlow.deck.showTokenTotal` setting, off by default. It is the only thing
  that needs a board-wide transcript sweep, so leaving it off costs nothing.
- **An action per pull-request problem, beside the problem itself.** A card with a
  failing check, a conflict and requested changes now offers *Fix CI*, *Resolve
  conflict* and *Address review* as three separate rows, each seeding an agent
  with a prompt that names the specific failure. This replaces the single
  *Address PR* button, which was gated on the review column's waiting lane — so
  it appeared on cards with nothing to address and was missing from cards with a
  failing check. An unapproved but otherwise clean PR now correctly offers
  nothing: it is not a PR with a problem.

### Changed

- **A stuck agent no longer reads as an idle one.** Two new states join the card's
  status line: `stalled`, when a tool call has been outstanding for more than 45
  seconds (a permission prompt, or a genuinely long command — the transcript
  cannot tell, so the label does not claim to), and `exited`, when a transcript
  stops mid-work and no live session is left behind. Both used to render as
  `idle`, the calmest tone on the board, on exactly the cards most in need of
  attention. Both now route to Action required, so expect one or two cards to move
  there on upgrade.

### Fixed

- **"Agent idle over N minutes" flows fire again on stuck agents.** The condition
  tested for `idle` exactly, so the two new states above would have silently
  stopped it firing on precisely the runs it was written to catch.
- **Token counts include subagent sessions.** Claude Code writes those transcripts
  one directory below the session's own; reading only the top level reported
  roughly half of a task's real spend.

## [0.23.1] — 2026-08-17

### Fixed

- **The card drawer no longer scrolls sideways.** Selecting a notepad card put
  its full ~64-character key in the drawer header, which was wider than the
  drawer itself: the summary collapsed to nothing, the status pill squashed and
  the close button left the panel. The header now names an untracked run the way
  the card's own key chip always has — `notepad`, `local`, `explore`, with the
  full key on the tooltip and Copy ticket key unchanged — a long ticket key
  ellipsizes at half the header, and the drawer scrolls on the vertical axis only.

## [0.23.0] — 2026-08-16

### Changed

- **The Deck card is now two tiers.** At rest a card is four rows — state and
  key, title, one signal line, and a footer with Open and Diff. Everything it
  used to carry (the branch row, repo chips, every PR block, the agent list,
  the ticket-status pill and the overflow menu) moves into a detail drawer
  that opens when you select a card. Nothing was removed; a column now reads
  as a list of same-shaped cards instead of a stack of unrelated blocks.
- **The signal line says at most three things**, worst fact first. A card with
  a PR leads with its number, then how its checks stand, then whatever stands
  between it and a merge — conflicts before requested changes. A card without
  one falls back to branch, diff totals and how wide the work spreads. Diff
  size never outranks PR news.
- **Address PR now follows the board, not the ticket status.** It appears on a
  card that has an open non-draft PR, sits in the review column's
  waiting-on-review lane, and is not a local place. Previously it keyed off
  `agentFlow.prReviewStatus` matching exactly. That setting still governs the
  sidebar's Tasks card and is unchanged there.
- The card drawer and the Orchestrator drawer share a slot, so opening either
  closes the other.

## [0.22.0] — 2026-08-16

### Added

- **Ready to merge is its own lane.** A PR that is approved, green and
  conflict-free is the most actionable thing on the board, and it used to sit in
  **In review** looking exactly like a PR nobody had opened yet. That column now
  splits into **ready to merge** above **waiting on review**, and **Done** splits
  into **merged** above **done · not merged** — a run that actually landed no
  longer reads the same as a ticket someone marked done. Lanes, not new columns:
  the sidebar has no room for a fifth, and both splits are the same stage of the
  same work read differently. Every fact behind them was already on the card, so
  nothing new is fetched.

## [0.21.4] — 2026-08-15

### Changed

- **Waiting looks like Agent Flow.** Every loading indicator is now the product's
  own mark with one dot lit and chasing round its ring — the Deck's full-screen
  wait and its refresh button, the review strip, the sidebar's task list and
  ticket detail, the Marketplace scan, and the file preview. The `⟳` glyphs and
  the bare **Loading…** lines they replace never said which product was thinking.
  The mark keeps the lockup's exact geometry, drops its inner texture dots at
  small sizes where they smear, and rests fully lit, so readers who ask for
  reduced motion get a still mark rather than a blank space. The review strip's
  skeleton rows are unchanged — they show the shape of what is coming, which a
  mark cannot.

## [0.21.3] — 2026-08-15

### Fixed

- **A repo the ticket merely mentions is no longer treated as scope.** The task brief
  embeds the Jira description verbatim above its **Repos in scope** list, and
  descriptions routinely name repos nobody checked out for the task. Nothing said
  which list wins, so an agent could go hunting for — or clone — a repo that was only
  ever a suggestion. The brief now states outright that the listed repos are the only
  ones checked out, and asks the agent to say so if the task genuinely cannot be done
  within them. Repo selection itself was already correct; only the wording changed,
  in the one function every seeding path shares.

## [0.21.2] — 2026-08-15

### Changed

- **Marketplace discoverability.** The extension now lists itself under the **AI**
  category alongside **SCM Providers**, and its search keywords cover the four things
  people actually search for when they want this: Jira and sprint work, coding agents
  (Claude Code, Copilot), git worktrees and multi-repo workspaces, and PR review. On
  Open VSX keywords are the highest-weighted field an extension controls after its
  name, so the previous seven left most searches unreachable. No behaviour changes.

## [0.21.1] — 2026-08-15

### Fixed

- **A task no longer offers to add itself to the sprint it is already in.** In the
  **My sprint** lens a card could carry both **Add to my sprint** and the
  remove-from-sprint action at once, two contradictory answers to the same
  question. The two read different facts — remove from the lens, add from the
  task's own in-sprint flag — and that flag reads false for every task whenever
  Jira's Sprint field can't be resolved, which the connector remembers for a while
  once it happens. Where remove is offered the lens decides, since it is the one
  lens whose query is "in an open sprint". Every other tab is unchanged, including
  an unassigned card whose **Add to my sprint** also assigns it to you.

## [0.21.0] — 2026-08-14

### Added

- **A note's description takes images.** Paste a screenshot into the detail
  field — whose placeholder now says so — drop an image file onto a note, or pick
  one with **Attach image**, beside **Add note** and in a note's edit form.
  Thumbnails render under the note's text and open full size in an editor tab;
  removing one, deleting the note, or clearing completed notes deletes the file.
  **Start** copies a note's images into `.pick-task/images/` beside the brief and
  names their repo-relative paths in both the brief and the seeded prompt, so the
  agent opens what you saw rather than working from a description of it. PNG,
  JPEG, GIF and WebP up to 10 MB each; the bytes live under the editor's global
  storage, never in the note record itself.

## [0.20.0] — 2026-08-14

### Fixed

- Jira projects without a Scrum board no longer show three sprint filter tabs
  that silently returned the same list as **Mine**. The connector now reads the
  project's boards once per session and offers only the lenses it can answer —
  **Mine** and **Unassigned** on a Kanban or board-less project. Scrum projects
  are unaffected, and a board list that can't be read leaves every tab in place
  rather than hiding any.
- Every sprint operation in a session now uses one stable board, chosen by
  lowest id with Scrum boards preferred. A project with several boards could
  previously have its active sprint read from one board while **Add to my
  sprint** wrote to another, because each call took whichever board Jira
  happened to return first.
- The Sprint-field and component caches are keyed by Jira site, so changing
  `agentFlow.jira.baseUrl` mid-session no longer answers with the previous
  site's data, and two sites that define the same project key no longer share a
  cache entry. A failed Sprint-field lookup is now retried after ten minutes
  instead of disabling sprint detection until the window is reloaded.
- A project that rejects a query sorted by `priority` — the field hidden or
  unindexed — now falls back to sorting by `updated` instead of showing an
  error with no task list behind it.

## [0.19.3] — 2026-08-13

### Changed

- **Development tooling only, with no change to the extension itself.** The
  browser-preview builder injected the built bundle through a string
  replacement, which is scanned for `$` patterns first — and every bundle
  contains `$&`, the pattern meaning "the text that matched". Each occurrence
  pasted a stray `</body>` into the middle of the injected JavaScript, inert
  while it landed inside a string literal and fatal to the page when it did not.
  The replacement is now a function, whose return value is inserted verbatim.

## [0.19.2] — 2026-08-13

### Fixed

- **An Action required card with no agent open no longer reads as disabled.** A
  card reaches that column without an agent because a PR is blocked, but its
  state line read the parked grey — `parked · git + Jira only`, the wording for
  "nothing is happening" — on the one column that means act now. On a board with
  no agents open anywhere, that was every card in the column, so a column of
  real work looked uniformly greyed out. The line now leads with `pr blocked` in
  the column's own tone, the way a `done` card has always let its column
  outrank the agent read. The PR block beneath still names the failing check,
  the review and the conflict.

## [0.19.1] — 2026-08-13

### Fixed

- **An Action required card puts its accent on Address PR, not Open.** A card
  carries one primary button and Open held it unconditionally, so the orange
  call to action landed on Open while Address PR — the verb the board is
  actually asking for — sat at the secondary treatment's rest opacity and read
  as disabled. Address PR now takes the primary weight when it is on the card,
  and Open keeps it everywhere else.

## [0.19.0] — 2026-08-13

### Changed

- **Cards no longer show Claude Code's own session label.** A card's top row
  carried a CLI-internal identifier (e.g. `agent-flow-0a`) — not a name anyone
  picked or recognises. The source chip beside it already says where the work
  came from, as a ticket link or a notepad/explore/local label.
- **Agents in the same column now share one card.** The Agents board projects
  one card per session, so two agents on one task rendered as two cards that,
  without their session labels, looked identical. They now merge into a single
  card listing both in its collapsible agents row. Agents in *different*
  columns still appear separately — a task with one agent working and one
  awaiting you genuinely belongs in two columns at once.

## [0.18.0] — 2026-08-13

### Added

- **Notepad sections.** Notes can be grouped under sections you create,
  rename, and delete from the Notepad tab, each collapsing independently and
  remembering its state across reloads. Sections are opt-in — an existing
  notepad renders unchanged until the first one is created. Drag a note onto
  another section's note, or onto a section's own header, to refile it there.

## [0.17.3] — 2026-08-13

### Fixed

- **Loading state before the first sync.** The board showed "No tasks in
  flight" during the brief window between mount and the first `deck:runs`
  post, indistinguishable from a genuinely empty board. It now shows a
  loading state until real data has landed.

## [0.17.2] — 2026-08-13

### Docs

- **Orchestrator commands reference.** `docs/ORCHESTRATOR_COMMANDS.md` documents
  what happens on each poll pass when a rule ends in a shell command — lock,
  evaluate, consent, run, latch — and the boundaries around it.

## [0.17.1] — 2026-08-13

### Fixed

- **Take button height matches its neighbors.** It had no explicit height and
  rendered slightly shorter than Address PR and the sprint-remove control.

## [0.17.0] — 2026-08-13

### Changed

- **In-flight board shows only work that is moving.** A card stays while it has an
  agent open, a pull request, an active ticket, or uncommitted work. Everything else
  collapses into a new **Recently closed** strip below the board and retires on its
  own after `agentFlow.retireClosedAfterHours` (default 24). Set
  `agentFlow.inflightShowAll` to `true` for the previous behaviour.

### Fixed

- **One agent, one card.** Notepad and Explore runs launch in place rather than in a
  worktree, so several run records could point at the same checkout — and every one
  of them claimed every Claude Code session running there. Four notepad runs over one
  repo rendered two live agents as eight cards. Each session now belongs to exactly
  one run.

## [0.16.0] — 2026-08-12

### Changed

- **A task's diff says which repo you are looking at.** The multi-file diff editor lists files flat, so on a task spanning repos nothing on screen named the repo whose file was open — the tab said only `Changes in ASM-1`. It now names the scope: `Changes in ASM-1 — svc` for one repo, the workspace's own name for a whole multi-root task, `all repos` otherwise. Diffing a task that spans repos asks which one first, with **All repos** as the first answer; a single-repo task, or a card already acting on one repo, still opens straight into the diff.

## [0.15.2] — 2026-08-12

### Fixed

- **The README's Notepad screenshot is centred where it is actually read.** 0.15.1 centred it with a `<div align="center">` wrapper, which some renderers of the page — the Marketplace listing among them — strip on a `div`. The same `align` on a `<p>` survives, so the shot now sits under its section instead of hugging the left edge.

## [0.15.1] — 2026-08-12

### Changed

- **The README's Notepad screenshot matches the shipping panel again.** It was shot before drag-to-reorder landed, so it showed neither the per-note grip nor today's filter row. The section also documents the reordering it now pictures, and the image is centred like the panel shot at the top of the page.

## [0.15.0] — 2026-08-12

### Added

- **The Deck Orchestrator.** Off by default — turn on `agentFlow.orchestrator` and the Deck header gains a chip that opens a drawer where you draw what should happen next. Drag a card from the board to attach it, connect two nodes, and the connection carries a condition: a PR merged, CI passed, review approved, no unresolved threads, the tree clean, an agent ended its turn, a ticket reached done. What the rule *does* comes from the node it points at — launch work that isn't started yet, seed a prompt into a live session, post a message, or run a command. Nothing happens until you **Arm** the flow, and nothing is armed for you. Both presentations are complete: a canvas for the mouse, and a list view that builds the same rules from the keyboard.
- **A rule can run a command.** Point a rule at a command node and a met condition runs a shell command — deploy on a merge, then smoke-test after the deploy. Commands come from `agentFlow.commands` by name, or are typed on the node as a one-off, and `{note}` in either is replaced with that rule's own note. A command runs in the checkout the rule came from, with a two-minute ceiling; its full output goes to the Deck's output channel and its exit code becomes the rule's receipt. Consent is asked once per flow and **separately from agent sessions** — approving launches never silently approves shell — and the prompt names the actual command text. A failed command latches: it is never retried until you press Reset, because a deploy that fails on every poll is a real side effect on real infrastructure.
- **Keep a one-off command.** Type a command on a node, name it, and press **Save to settings** — it is appended to `agentFlow.commands` in whichever settings scope already holds your list, so the next node can pick it from the picker instead of retyping it. Saving the same command twice tells you it is already there rather than filling the list with twins.
- **The add-a-node pickers search, and take more than one at a time.** `+ Add command…` and `+ Add place…` filter as you type — across both lines a row shows, so a place's repo is findable and not merely visible — and every ticked entry becomes its own node in a single step. Staging a deploy and a smoke test is now one trip through the list instead of two.

## [0.14.0] — 2026-08-12

### Added

- **A ticket's type, on its card.** Every card in the Tasks list now carries a small coloured glyph before its key saying what the ticket is — story, epic, task, sub-task or bug — so a list can be scanned for the bug or the epic without opening anything. A type the project defined for itself (a spike, an incident, a renamed default) gets a neutral glyph and is named in full in the tooltip, so no card is ever left unmarked. Bug takes a muted red rather than the alarm red: an ordinary bug ticket is not a failure.

## [0.13.3] — 2026-08-12

### Added

- **Notepad: drag to reorder.** Each note has a grip — drag it to put the list in the order you want. The order is yours, persists across reloads, and applies under every filter; "Reset order" puts the list back to newest-first. A notepad you never drag looks exactly as it did.

## [0.13.2] — 2026-08-12

### Fixed

- **A Notepad note's detail reaches the agent, not just its title.** Running a note seeded a
  prompt built from the note's title alone — everything typed under it lived only in the
  `.pick-task/TASK.md` brief, which a session is least likely to open first. The detail is
  now appended to the seeded prompt itself, verbatim, so `{summary}`-shaped text inside a
  note stays the user's own words. A note with no detail, and every other kind of launch,
  seeds exactly the prompt it did before.

## [0.13.1] — 2026-08-12

### Fixed

- **A Notepad note reads as text beside its actions.** Start sat level with — and no wider
  than — the edit and delete buttons that follow it, and the cluster stretched under the
  note's text, leaving every title with a dead band of empty card to its right. Start now
  sits above the pair, which spans exactly Start's width, and the cluster holds the note's
  top right corner while the text takes the width it leaves.
- **A long note title wraps instead of running off the panel.** A dictated or pasted title
  can be one unbroken string, which offered nothing to wrap on and overflowed the sidebar's
  right edge. Both the title and the body now break mid-string when they have to, and
  neither is ever truncated.

## [0.13.0] — 2026-08-11

### Added

- **A card names the workspace its session runs in.** A Claude Code session opened inside
  a multi-root `.code-workspace` used to produce a card naming only the folder that
  session ran in — the workspace itself was invisible. Every folder of that window now
  belongs to one card, behind a single chip that unfolds its repo chips, with their diff
  and dirty markers, on hover, keyboard focus or click. A single-repo task's card is
  unchanged.

### Fixed

- **An agent card's branch line names that agent's own repo.** On a card spanning two
  repos, the line used to read the first repo's branch — which the session may never have
  touched.
- **A repo nobody is working in no longer speaks for the card.** A workspace root with no
  session in it shows as a chip, but its pull request can no longer render as the card's
  own or drag the card into Done, its leftover transcript can no longer hold the card at
  "ended turn", and its month-old branch can no longer name the card's ticket. A root that
  a launched task already owns is dropped from the card rather than counted twice.

## [0.12.1] — 2026-08-10

### Fixed

- **A notepad card no longer shows a pull request that is not its own.** A notepad run is
  launched into the window and branch you already had open, so any PR on that branch
  belongs to that branch's work, not to the note. Notepad runs are now treated as
  PR-less: no PR is fetched or read back for them, their cards drop the `pr`, `ci` and
  `review` rows, and they no longer land in Done reading "merged" off somebody else's
  merge.

## [0.12.0] — 2026-08-10

### Changed

- **"This window" no longer asks which repos the task touches.** Choosing it already says
  where the work happens, so the folders open in the window are taken as the repo set —
  the confirm-repos QuickPick is skipped, exactly as it is for an existing workspace or
  another open window. Applies to Take, Address PR, Explore and Notepad runs. A new
  window still gets the pick, with inferred repos pre-checked, and so does the rare case
  where the window loses its folders between the destination pick and the launch.

## [0.11.2] — 2026-08-10

### Changed

- **The sidebar screenshots show a real view title bar.** Both README shots frame the
  panel under a mock of VS Code's own title row, and that mock had drifted: the signed-in
  name sat 5px above the project key's baseline and a size larger, the row was 46px
  instead of 35px, the title started 6px inside the panel's text edge, and the three
  view actions were Unicode stand-ins (`⧉ ⊞ ⟳ ⋯`). They are now the real codicons the
  `view/title` menu contributes — `library` for the Marketplace, `dashboard` for the
  Deck, then `refresh` — followed by the container's More Actions button, and the title,
  name and icons share one centered 35px row aligned to the panel's own text edges.

  The name's drift was a CSS collision, not a layout bug: the harness reused the class
  `.desc`, which the webview bundle — injected into the same document — defines for task
  descriptions with a `margin-bottom` that the centered row counted as part of the item.
  The mock host chrome is now namespaced so the extension's own styles can't reach it.

No code changed in this release; only `media/screenshot.png` and `media/notepad.png`.

## [0.11.1] — 2026-08-09

### Changed

- **The docs stop calling this a Claude Code-only tool.** The listing blurb, the
  README and `agentFlow.seedAgent`'s description said the seeded agent was Claude
  Code, which stopped being true in 0.10.0. They now say "your agent" wherever both
  providers behave the same, and name the three places that really are Claude-only:
  the Deck's live signal, the Marketplace, and Remote Control (whose setting now
  says what `copilot` does to it).
- **The Notepad is documented.** It shipped in 0.6.0 and the README never mentioned
  it. There's now a section covering global storage, **Start**, the Running / Stale /
  Finished badge, the filter and **Clear completed** — with a screenshot.
- **Every screenshot re-shot from the current UI.** The sidebar one predated the
  0.9.0 tab bar and still showed the removed in-panel header row; the Deck one
  predated the 0.11.0 header redesign and still showed the four toggles and the two
  removed tiles. The Deck shot now also shows the Agents lens doing its job — one
  ticket with two sessions as two cards — and a Notepad run on the board.
- **The README's architecture tree matches the source again** (`jira/` has been
  `tasks/jira/` for several releases), and records that one seed chokepoint resolves
  provider × surface at seed time.

No code changed in this release.

## [0.11.0] — 2026-08-09

### Changed

- **The In-flight header is information again.** It was one non-wrapping row of a
  title, five stat tiles, four toggle switches, a lens and refresh — so below about
  1200px its right end was clipped off the panel rather than folded. It now carries
  the title, three tiles naming the board's own columns, the Agents/Workspaces lens
  and refresh, and the row wraps, so it cannot clip again however narrow the panel
  or wide the font.
- **The "To review" and "Total" tiles are gone.** "To review" restated a count the
  review strip renders on its own directly below; "Total" was the sum of the three
  tiles beside it, over a board displaying every card it counted.
- **The Live signal toggle is gone and the signal is always on.** It had no backing
  setting and reset to on every time the panel opened, so nothing changes for anyone.
  Cards still fall back to `parked · git + <source> only` when a transcript is
  unreadable or missing, which is now the only route to that state.
- **PR facts, Open agents and Review queue lost their header buttons**, not their
  settings. `agentFlow.prFacts`, `agentFlow.openAgents` and
  `agentFlow.reviewRequests` are unchanged — same keys, same defaults — and now take
  effect the moment you change them, with no need to reopen the panel.

### Fixed

- **Controls no longer flip back before they settle.** Control state was echoed to
  the panel only on the board post, which costs a full rebuild (git per repo plus a
  task-source round trip per run). A rebuild already in flight when you clicked
  landed carrying a pre-click value and visibly reverted the control, before the
  real value arrived seconds later. The lens now has its own message and the
  webview owns it.
- **Switching between Agents and Workspaces is instant.** It used to trigger a full
  board rebuild to redraw a board the panel already had the data for.

## [0.10.0] — 2026-08-09

### Added

- **`agentFlow.agentProvider` — start sessions with GitHub Copilot.** Set it to
  `copilot` and a taken task opens Copilot Chat in agent mode with the prompt
  pre-filled, or runs the `copilot` CLI when `agentFlow.agentSurface` is
  `terminal`. VS Code only — Cursor and other forks fall back to Claude Code.
  A **batch** launch under Copilot does not seed the chat panel (it's
  single-instance, so a second prompt would overwrite the first); it writes
  every task's brief and points a notification at them instead. Remote Control
  needs Claude Code: with `agentFlow.remoteControl` set to `on`, taking a task
  under Copilot is refused before anything is created; set to `ask`, the picker
  isn't offered and the launch proceeds without it. Copilot sessions don't show
  up as live agents on the Deck, and **Doctor** now reports on whichever
  provider is configured. Defaults to `claude-code`, so nothing changes unless
  you ask for it.

## [0.9.0] — 2026-08-08

### Changed

- **Tabs at the top of the sidebar.** `Tasks | Notepad` is now the panel's first
  row, with the project key and your name moved into the view's own title bar —
  so the panel no longer says "Tasks" twice, and it's a row shorter on both
  tabs. The window gauge and **Explore** trail the tabs on that same row.

### Fixed

- **Notepad fields focus like every other input.** The title and detail fields
  lit up with a detached outline in the theme's focus hue, offset from the field
  and at the wrong corner radius. They now move focus onto their own border,
  matching the task search and the repo picker.

## [0.8.0] — 2026-08-08

### Added

- **`agentFlow.agentSurface` — open a session in the terminal.** Set it to
  `terminal` and a taken task starts the `claude` CLI in an integrated terminal
  named for the ticket, with the prompt pre-typed and waiting on your Enter,
  instead of the Claude Code extension panel. Applies to every launch path —
  take, batch, Explore, Notepad and **Address PR**. Defaults to `extension`, so
  nothing changes unless you ask for it.

## [0.7.0] — 2026-08-08

### Changed

- **"This window" no longer replaces the window.** Taking a task into the window
  you're already in starts a Claude session there and leaves everything else
  alone — the folders, the open editors, and any session already running stay
  put. It used to swap the window's folder set and reload the extension host,
  throwing all of that away. A batch opened into one shared window behaves the
  same way.
- **A window with nothing to seed is no longer offered.** An empty window, or an
  untitled multi-root window with no saved `.code-workspace`, can't be named by
  the seed handshake, so **This window** is hidden there and
  `agentFlow.openIn: this-window` opens a new window instead.
## [0.6.0] — 2026-08-08

### Added

- **Notepad tab.** A second tab in the Tasks panel holding freeform items that
  aren't tied to any ticket, saved globally so the same list follows you across
  every workspace. Notes can be checked off, filtered (Active by default), and
  cleared once done. The fields are ordinary text inputs, so your operating
  system's own dictation (double-tap Control on macOS, Win+H on Windows) types
  straight into them.
- **Kick off an agent from a note.** **Start** on a note opens a workspace and
  seeds a brief from it, the same way Explore does. The run appears on the Deck
  board like any other, and the note shows whether it is running, stale, or
  finished.

### Changed

- **Notepad restyled to match the rest of the panel.** Text links are now real
  buttons — a filled Start (formerly "Run agent") and quiet icon-only Edit and
  Delete — status badges are outline pills instead of filled ones, and notes
  render as a hairline-separated list with a status rail instead of boxed cards.

## [0.5.0] — 2026-08-07

### Added

- **Pluggable task sources.** Where Agent Flow reads tasks from is now a
  connector behind a `TaskProvider` / `TaskConnector` seam, selected by the new
  `agentFlow.taskSource` setting. Jira remains the default and the only shipped
  source, and every existing install keeps its settings, credentials and board
  untouched — the setting defaults to `jira`. A new source lives in its own
  directory under `src/tasks/`; [docs/CONNECTORS.md](docs/CONNECTORS.md) is the
  checklist for wiring one up, including the shared files it still has to touch
  (`src/tasks/`, `src/tasksView.ts`, `src/deckView.ts`, `src/doctorView.ts`).

### Changed

- **First-run setup counts to 3, not 4.** The wizard's numbered steps now read
  "(1/3)" through "(3/3)" instead of "(1/4)" through "(3/4)" — the old fourth
  step was always the sign-in flow, which was never actually a numbered box.
  Nothing about the steps themselves changed. Only a brand-new, unconfigured
  install sees this; anyone already set up never runs the wizard again.
- **A whitespace-only Jira site URL now reads as unconfigured.** Previously a
  `agentFlow.jira.baseUrl` containing only spaces counted as "configured" and
  the task pool would try to load and fail; it now shows the same setup
  call-to-action as leaving the setting empty. Doesn't affect anyone with a
  real URL already set.
## [0.4.3] — 2026-08-06

### Fixed

- **README lockup broken on the Marketplace and Open VSX listings.** The
  light-mode `<source srcset>` in the logo `<picture>` tag was left as a
  repo-relative path; `vsce`/`ovsx` rewrite `<img src>` attributes in the
  README to absolute GitHub URLs at publish time but not `<source srcset>`,
  so it 404'd against each listing's own host. It's now a hardcoded absolute
  URL, same as the existing rewritten fallback.

## [0.4.2] — 2026-08-05

### Fixed

- **Deck: "Review with agent" is never disabled.** The button used to grey out
  when the repo behind a queued PR wasn't checked out locally, with no way to
  launch a review agent for it at all. It's now always clickable; if the repo
  really isn't checked out, clicking it surfaces the existing explanatory toast
  instead of doing nothing (`src/webview/ReviewStrip.tsx`).

## [0.4.1] — 2026-08-05

### Changed

- **Deck: the In-flight header stacks its gloss under the title.** "everything you've
  launched" used to sit inline after "In-flight", reading as one sentence that changed
  weight mid-way; it now sits on its own line beneath the label. The header is no taller
  for it — the stat tiles beside it already set its height (`src/webview/deckStyles.ts`).

## [0.4.0] — 2026-08-05

### Added

- **Explore: Supervise running tasks.** A new Explore action seeds a session whose
  brief lists Agent Flow's other active runs — task, explore, and review — and
  whether each still has a live Claude Code agent attached, so you can check on
  and unblock stalled or waiting work from a fresh session instead of hunting
  through windows (`src/config.ts`, `src/engine/runs.ts`, `src/tasksView.ts`).

## [0.3.0] — 2026-08-05

### Fixed

- **Deck: agent chip shows the workspace name, not the first repo.** A multi-repo
  run whose session couldn't be matched to one specific repo used to fall back to
  `repos[0]`'s name on hover, no matter how many repos the run actually had. It now
  shows the run's `.code-workspace` file name instead (`src/webview/DeckApp.tsx`).

### Added

- **Deck: agent tooltips show what a session is doing.** Hovering an agent's
  codename (top-right of its card, and each row of an expanded agent list) now
  leads with Claude Code's own transcript-derived session title when one is known,
  instead of just naming the repo (`src/webview/DeckApp.tsx`).

## [0.2.0] — 2026-08-04

### Added

- **Deck: one card per agent.** The In-flight board now opens with a card per
  Claude Code session, showing the repo, ticket and PR it belongs to, and bucketed
  by that session's own state — two agents in one worktree can sit in two
  different columns. **Open** and **Diff** act on the agent's own directory. The
  old per-workspace grouping is still there behind the header's **Workspaces**
  control, and your choice persists (`agentFlow.deckGrouping`,
  `src/webview/deckCards.ts`, `src/webview/DeckApp.tsx`).
- **Deck: runs retire themselves.** A record is deleted once its directories are
  gone, once it has been landed for `agentFlow.retireFinishedAfterHours` with no
  agent in it, or once an untracked session passes
  `agentFlow.retireAbandonedAfterDays`. Uncommitted or unpushed work always
  blocks it, and only Agent Flow's own pointer is ever deleted — never a worktree,
  a branch, or a commit. **Clear stale** in the header does it on demand
  (`src/engine/retire.ts`, `src/deckView.ts`).

## [0.1.59] — 2026-08-04

### Changed

- **A card's Diff button opens the editor's own multi-file diff view.** It used to
  concatenate every repo's patch into one read-only text document — searchable, but with
  no file tree, no per-file navigation, and no way to fix a typo you spotted while
  reading. Now each changed file is a real diff editor with the merge-base on the left and
  the live worktree file on the right, so edits save straight into the run. Renames diff as
  one change rather than an add plus a delete, and a multi-repo run groups by repo root.
  Binary files are left out: their "before" side would arrive through a text provider and
  render as mojibake. The flat patch survives as a fallback for editors that never
  registered `vscode.changes`, and a run whose only changes are binary says so instead of
  opening an empty editor.

### Fixed

- **The Marketplace listing has a Changelog tab again.** Releases are packaged by
  `scripts/pack-vsix.sh`, not `vsce` — the hand-rolled zip exists so publishing does not
  need npm — and it staged the extension by copying a literal list of files that never
  included `CHANGELOG.md`, nor declared the `Content.Changelog` asset the gallery reads to
  render the tab. So the notes were written for every version and shipped with none of
  them. `LICENSE` was missing for the same reason, and the manifest hardcoded an empty
  `Tags`, `Categories = Other` — dropping the `SCM Providers` listing — and a description
  that had drifted from `package.json`'s. All four now come from `package.json` or the
  repo, so there is nothing left to keep in sync by hand (`scripts/pack-vsix.sh`).
- **The plugin browser's script is in the vsix.** The same literal list named three
  bundles; `src/marketplaceView.ts` loads a fourth, `dist/marketplace.js`, so the view
  shipped without the script that draws it. This is the second time the list has lost a
  bundle — `fix: package the deck bundle and PNG icon in the vsix` was the first — so it
  is now a `dist/*.js` glob, which picks up the next bundle on its own and still skips the
  sourcemaps and the test helper (`scripts/pack-vsix.sh`).

## [0.1.57] — 2026-08-04

### Added

- **A Review queue toggle in the Deck's header.** The review-requests strip could only
  be silenced from Settings — a trip out of the panel to quiet a rail sitting above the
  board. It now has a control beside Live signal, PR facts and Open agents, session-scoped
  like all three: `agentFlow.reviewRequests` stays the persistent seed and the pill is the
  per-session override. Off stops the `gh` search outright, which is what distinguishes it
  from the strip's own collapse caret (`src/deckView.ts`, `src/webview/DeckApp.tsx`).

### Changed

- **The review rows read as columns.** Every field the row carried is still there, but the
  trailing cluster was sized naturally, so no two rows lined up and each line had to be
  re-parsed from scratch. The fields now take fixed widths, the `+`/`−` pair shares one
  column, and the repo ellipsises so every title starts at the same x — with the full name
  on its `title` attribute. Below 860px the widths are released and the row behaves exactly
  as it did before (`src/webview/ReviewStrip.tsx`, `src/webview/deckStyles.ts`).

### Fixed

- **The review queue no longer appears out of nowhere after the board.** `refresh()` only
  reached the queue after `buildAll()` had finished — git per repo and Jira per run — so a
  queue already cached on disk waited out the entire board for no reason, then landed and
  shoved it down. `deck:ready` now posts the cache before the build starts, so a warm
  machine has the strip on first paint (`src/deckView.ts`).
- **A cold start says it is working, instead of showing nothing.** With no cache to fall
  back on, the strip used to render nothing at all for the seconds the first `gh` search
  took. It now shows its header with a spinner and three skeleton rows, and the "To review"
  tile spins rather than claiming a count it does not have yet. A first search that fails
  reads as "couldn't check" rather than shimmering forever waiting on a search that already
  gave up (`src/webview/ReviewStrip.tsx`, `src/webview/DeckApp.tsx`).

## [0.1.56] — 2026-08-04

### Fixed

- **The light-background lockup no longer reads as dark speckle on the Marketplace.**
  0.1.54 inverted the mark's non-brand dots to the word's ink at the icon's own 80%,
  which does hold the dark variant's contrast *relationship* — cluster 9.3:1, teal
  4.9:1 on white, against 12.2:1 and 6.4:1 on the icon's near-black. But small dark
  dots on white carry far more perceptual weight than small light dots on black, so
  the cluster outweighed the accents instead of framing them, and the teal had been
  darkened to `#157F76` until it stopped reading as teal. The Marketplace listing
  shows the banner at roughly 660px on pure white — it ignores the README's
  `width="280"` — so it got the full effect where the README's shrunk copy hid it.
  The light lockup now uses the icon's own `#2AA79B` for the six accent dots, with
  the cluster dropped to `#16191C` at 30% so it recedes into texture. This reverses
  the 2026-08-04 ruling that picked `#157F76` for its 4.9:1 on white: WCAG exempts
  logotypes from contrast minimums, the wordmark beside the mark carries 16:1, and
  the ring's legibility comes from its shape rather than from the teal alone.
- **The lockup PNGs are no longer upscaled on the Marketplace.** Both re-render at
  1120px instead of 560px — 2x the README's display width, so the listing's ~660px
  rendering downsamples a sharp source instead of stretching a soft one. The README
  is unchanged; it still asks for 280px.

## [0.1.55] — 2026-08-04

### Fixed

- **A landed PR no longer reads `merge unknown` on its card.** GitHub only computes
  mergeability for an open PR: once one merges or closes, both `mergeable` and
  `mergeStateStatus` come back `UNKNOWN`, so `mapMergeable` had nothing to go on and
  every merged card ended on a `merge unknown` line — a question with no answer left,
  directly under a header already reading "merged". The row now renders only while the
  PR is open (`src/webview/DeckApp.tsx`). `pr`, `ci` and `review` still carry real
  values after a merge, so they stay.

## [0.1.54] — 2026-08-04

### Changed

- **The README lockup carries the real mark instead of a one-colour stand-in.** The
  banner drew a simplified sixteen-dot ring in flat teal, so the README opened with a
  mark that shared nothing but a silhouette with the icon sitting next to it in the
  extensions list. Both lockups (`media/logo.svg`, `media/logo-light.svg`, PNGs
  re-rendered at 560px) now use the icon's own dot cluster, lifted from
  `media/icon-src.svg` — the six teal dots plus the non-brand dots at the same 80%.
  The light-background variant inverts those dots to the word's ink `#16191C`, which
  holds the same contrast relationship the dark one has, so the teal still reads as
  the brand colour on white rather than getting buried. The old lockup also clipped
  its bottom dot — the mark's box ran past the viewBox — so the canvas is recomposed
  at 373×88 with even padding and the mark centred on the wordmark's cap height. The
  README displays it at the same size as before.

## [0.1.53] — 2026-08-04

### Changed

- **The mark's non-brand dots are near-white instead of dark grey.** They sat at 26%
  opacity everywhere they appear — in the extension icon that resolved to roughly
  `#3F4142` on the graphite tile, so at the 32px the extensions list actually renders
  only the six teal dots read and the rest of the ring turned into a smudge. The
  extension and Marketplace icons now draw them at 80% white (`media/icon-src.svg`,
  `media/icon-store-src.svg`, PNGs re-rendered at 256×256), and the sidebar's gauge
  mark takes the theme foreground at 85% for both its unlit and texture dots, so it
  stays theme-correct on light backgrounds instead of hardcoding white. The teal is
  unchanged, and the gauge count is still readable because lit and unlit dots differ
  in hue, not only in weight.

## [0.1.52] — 2026-08-04

### Fixed

- **Opening a task into a saved workspace could add a folder the workspace already
  reached.** The guard compared repo **names**, which cannot see a candidate nested
  inside a root whose name matches nothing — a workspace rooted at the repos' parent
  directory, or a root you renamed. A worktree path is never name-equal to its repo's
  root in that setup, so each launch appended another root; one real workspace grew
  from 2 folders to 5, with a single repo appearing three times. This is prevention
  only — it does not repair a workspace file an older version already polluted, so if
  yours has grown this way you'll need to remove the extra roots yourself.
- **A workspace folder pointing at one of our git-worktree folders
  (`<repo>/.claude/worktrees/<TICKET-KEY>`) was mistaken for a repo of its own,** and the
  next launch then created a worktree *inside* that worktree — compounding with every
  task after. The folder's basename is a ticket key and its `.git` is a pointer **file**
  rather than a directory, which was enough to pass the is-this-a-git-repo check. As
  with the fix above, this prevents new phantom-repo folders from being added; a
  workspace file that already has one still needs a manual edit.

## [0.1.51] — 2026-08-04

### Added

- **The sidebar header mark doubles as a live gauge.** The dot-ring lights one outer
  dot per Agent Flow window currently open, up to eight, and relights whenever the
  task pool refreshes rather than only once at panel load. With window tracking off
  it falls back to its static ring instead of claiming a count it doesn't have.

### Changed

- **A single teal accent, spent in exactly seven places**: the sidebar's header gauge,
  its `Take` button, its sticky batch-launch bar, and its sign-in/setup button; the
  Deck's ordinary primary action and its `Live signal`/`PR facts` toggle track (a
  state indicator, not a second verb); and the Marketplace's `Open file`. Everything
  else — status dots, rails, chips, links — stays monochrome, on purpose.
- **The sidebar's task, size and status filters read as grouped, segmented
  controls**, matching the Deck's — not three separate rows of blue-filled pills.
  The active choice is announced to assistive tech, not only drawn.
- **A card's left rail now means "where is this ticket in the flow"** (not started,
  in progress, or done) instead of priority. Urgency moved to a small `Highest` chip
  shown only for the highest-priority tickets, so an urgent ticket no longer looks
  identical to a broken one — both used to be red.
- **`Address PR` gave up its green.** Green means done on the Deck, and a pull
  request waiting on you is the opposite of done; the action now reads as a quiet
  secondary control like the row's other actions.
- **The Marketplace's filter pills became segmented controls too**, sharing the
  sidebar's and the Deck's control language.
- **New store tile and wordmark.** The README leads with the new lockup and shows
  the branded UI throughout.

## [0.1.50] — 2026-08-03

### Fixed

- `agentFlow.promptModes` and `agentFlow.reviewRequestModes` now **layer over**
  the built-in modes instead of replacing them. A customized list used to freeze
  at the modes that shipped the day it was written, so every mode added later —
  **Test-driven**, **Investigate & root-cause**, **Orchestrator**, **Refine the
  ticket** — was invisible, with nothing in the UI to suggest one was missing.
  Reuse a built-in `id` to override only the fields you set, use a new `id` to
  add a mode of your own, and `{"id": "tdd", "hidden": true}` to drop a built-in.
  Modes you don't list are appended, so future built-ins reach you too. If your
  list omitted built-ins, a one-time notification offers to hide the newcomers
  and keep the picker you had. If your `reviewRequestModes` held a single mode,
  **Review with agent** now asks which mode to use, because the built-in
  **Full review** is offered alongside yours — **Hide the new ones** (or a
  `hidden: true` entry) restores the single-click launch.

## [0.1.49] — 2026-08-03

### Added

- **Address PR now appears on Deck cards too.** Once a card's Jira status matches
  `agentFlow.prReviewStatus`, an **Address PR** button shows up next to Open, the same
  as the sidebar's task card. The sidebar's version acts on a bare ticket — nothing is
  on disk yet, so it has to read Jira, ask where to open, ask which repos, and make a
  worktree. A Deck card already has all three: its own repos, its own workspace, its
  own brief. So its Address PR asks nothing and just re-seeds the workspace you already
  have with the PR-review prompt, in place.

## [0.1.48] — 2026-08-03

### Changed

- **Take's repo confirmation puts the pre-checked repos on top.** The
  "confirm the repos this task touches" list was in plain discovery order, so on a
  `reposRoot` with dozens of repos the ones inferred from the ticket — the whole point
  of the step — sat below the fold, and the pick read as if nothing had been suggested.
  Inferred repos now lead the list; discovery order still holds within each group.

## [0.1.47] — 2026-08-03

### Changed

- **One name everywhere: Agent Flow Deck.** The marketplace listing already said it,
  but every surface inside the extension still said "Agent Flow" — a name other tools
  use too. Renamed: the activity-bar and settings section titles, the output channel,
  the Deck and Marketplace window titles, the Doctor report header, the setup steps,
  and every notification, empty state, tooltip and setting description. Review
  comments drafted from the Deck now sign off with _"Drafted with Claude Code via
  Agent Flow Deck."_
- **Commands lost their name prefix.** They read `Agent Flow: Refresh Tasks`,
  `Agent Flow: Doctor` and so on; they are now simply **Refresh Tasks**, **Doctor**,
  **Run Setup…**, **Sign in to Jira**, **Sign out of Jira**, **Take Task…**,
  **Open the Deck (in-flight)** and **Open the Marketplace** — the extension's own
  name was doubling up with the Deck's, and the sidebar title-bar buttons read as
  plain verbs. Command IDs (`agentFlow.*`) are unchanged, so keybindings and
  `workbench.action` references keep working; searching the palette for "agent flow"
  no longer finds them by name.
- Setting keys (`agentFlow.*`) and the extension ID are unchanged, so nothing you
  have configured breaks.

## [0.1.46] — 2026-08-03

### Added

- **The Deck reflects every Claude Code session open on this machine**, not only the
  tasks Agent Flow Deck launched. Sessions attach to the card that owns their directory —
  a worktree with two agents now shows both, each with its own live state — and a
  place with no tracked run becomes a card of its own, marked `local`, with its
  ticket key inferred from its branch and its pull request found from it. `⋯` →
  **Track it** pins one to the runs store so it survives its agents closing. Read
  from `~/.claude/sessions`; toggle with **Open agents** / `agentFlow.openAgents`.

### Changed

- **An agent waiting on you now outranks one that is busy.** When a card has several
  agents, the one that has ended its turn decides the column, so the card lands in
  **Action required** instead of hiding it behind the ones still working.
- **A pull request is found by branch, not by ticket.** The Deck looks for a PR by
  whether a repo is on a branch of its own rather than by whether the run has a Jira
  ticket, so an Explore session that made a branch now finds its PR.

## [0.1.45] — 2026-08-02

### Added

- **Review with agent can offer more than one seed prompt.** The new
  `agentFlow.reviewRequestModes` holds a list of named review modes — same shape as
  `agentFlow.promptModes` — and with two or more configured, clicking **Review with
  agent** asks which to seed. Written for reviewers who keep separate review skills per
  area, e.g. one for backend services and one for frontend. Pin one with
  `agentFlow.reviewRequestMode` to skip the question. One **Full review** mode ships, so
  an install that changes nothing still launches a review in a single click.

### Deprecated

- `agentFlow.reviewRequestPrompt` — superseded by `agentFlow.reviewRequestModes`. A value
  you customized is migrated into the **Full review** mode automatically; nothing to do.

## [0.1.44] — 2026-08-02

### Added

- **Explore can verify a feature on an environment.** A fifth Explore action, **Verify on
  an environment**, asks which environment to check — from the new `agentFlow.environments`
  list, or a one-off you type — alongside the repos you already pick, then seeds a
  read-only prompt asking the agent to inspect those services in that environment (logs,
  error rates, metrics and traces, deployed version) and return a working / broken /
  inconclusive verdict with evidence. The prompt is editable at
  `agentFlow.explorePrompts.verify`, and `agentFlow.exploreMode` can pin Explore to it.
  Agent Flow Deck itself never touches the environment — the agent does that with its own tools.

## [0.1.43] — 2026-08-02

### Changed

- **Existing workspaces are no longer modified without asking.** Taking a task into a saved
  `.code-workspace` used to append every repo that wasn't already a folder — and because a
  worktree keeps its repo's name, a workspace with `api` grew a second root also called
  `api`, then a third. Repos whose name the workspace already has are now skipped, and
  anything genuinely new is added only after you approve it. The task still opens in its
  worktree either way, and its `@mentions` now resolve through the containing root instead
  of silently naming the main checkout. This only stops new duplicates — if a workspace
  already picked up `api`-style duplicates under the old behavior, you'll want to delete
  those leftover folders from it yourself.

## [0.1.42] — 2026-08-02

### Added

- **Anonymous usage analytics**, so the features nobody uses can be found and
  removed rather than maintained on a hunch. Events record *shape* only: which
  feature was used, how many repos a task touched, which prompt mode was picked,
  how long a flow took, and whether it succeeded, was cancelled or failed. They
  never carry a repo name, ticket key, Jira project, summary, file path, prompt
  text, or error message — the event catalogue is typed so that attaching one is a
  compile error rather than a review oversight. Identity is VS Code's own
  anonymous machine id; nothing new is minted, and the salt used to group a
  ticket's events within one install never leaves the machine.

  **Two independent switches turn it off, and either one is enough:** the new
  `agentFlow.telemetry.enabled` setting, and VS Code's own
  `telemetry.telemetryLevel` — which is honoured with no action required, so if
  you already have telemetry off editor-wide, this sends nothing. Setting that
  level to `error` sends failures only and no usage at all. Turning either off
  mid-session discards whatever was queued rather than flushing it. A one-time,
  non-blocking notice on first run says all of this, and
  [`docs/TELEMETRY.md`](docs/TELEMETRY.md) lists every event, every property, and
  everything that is never collected.

## [0.1.41] — 2026-07-30

### Changed

- The Deck's review queue now skips PRs in **archived repositories**. An archived
  repo is read-only, so GitHub refuses a review on one — those rows could only
  ever fail, and they never aged out of the queue. Filtered in the `gh` search
  itself, so the strip's "showing N of M" count drops with them.

## [0.1.40] — 2026-07-29

### Added

- **The Deck's review queue.** A strip above the columns listing every open PR
  that asks for your review, with size (S/M/L and `+/−`), CI and age; sortable
  by oldest or smallest. Every row stays visible in a height-capped,
  independently scrollable list rather than collapsing away. Expanding a row
  shows the review state, which checks failed, and how many threads are open.
- **Review with agent** — checks a teammate's PR out into a worktree and seeds
  Claude Code to review it, writing findings to `.pick-task/REVIEW-<n>.md` that
  the row can load into the review box.
- **Opt-in review submission** (`agentFlow.reviewWrites`, default off): approve,
  comment or request changes from the Deck, each behind a confirmation dialog
  naming the verb, repo and PR number. This is the first thing in Agent Flow Deck
  that writes to GitHub.
- Settings: `agentFlow.reviewRequests`, `agentFlow.reviewRequestsTtlSeconds`,
  `agentFlow.reviewWrites`, `agentFlow.reviewRequestPrompt`.

## [0.1.39] — 2026-07-28

### Changed

- **"Needs you" is now "Action required", in orange rather than red.** Red is the
  colour of something broken, and the column was reading as an error when all it
  means is that it's your turn. The column, its summary tile and the legend now all
  say **Action required** — they previously disagreed ("Needs you" on the column,
  "Need you" on the tile) — and the attention accent has split away from the danger
  accent: orange is your turn, red stays for failing checks, deletions and *Forget*.

- **In-flight typography.** Monospace is now reserved for identifiers and counts —
  ticket keys, branches, repo names, diff stats, the PR block. Everything that reads
  as English (`ended turn · 4m ago`, `launched 22m ago`, the Jira status, the footer,
  toasts) is set in the editor's UI font, where it used to be mono and made the board
  look like a log dump. Font sizes now come from a four-step scale instead of six
  ad-hoc values, and every ticking relative time is tabular so it can't reflow the row
  it sits in.

- **Card buttons are one language.** **Open**, **Diff** and **⋯** now share a height,
  radius and border, and **Diff**'s outline is visible against the card surface instead
  of vanishing into it. **Open** is a quiet raised surface at rest and only takes the
  theme's button colour under the pointer: a bright blue slab on every card was ambient
  noise, not emphasis. The single card in **Action required** carries the board's only
  coloured call to action.

- **The branch and launch time share a row.** The branch line was half empty while
  `launched 22m ago` trailed the repo chips, reading as one more chip that had lost its
  border.

- **The Live signal and PR facts toggles are one segmented control**, and both are real
  buttons — they were `div`s, so neither could be reached from the keyboard.

### Removed

- **The `open now — Open will focus this window` line.** It occupied a line on every
  card with a live window. **Open** now carries it as a tooltip, with a small marker on
  the button so the state is still visible at a glance.

## [0.1.38] — 2026-07-28

### Added

- **`Agent Flow: Doctor` — one command that checks everything Agent Flow Deck depends
  on and offers the fix.** It probes your Jira site and project, your stored
  credentials, `git`, your repos root and workspace directory, `gh`, the Claude Code
  extension and its version, and the runs store — then lists what's broken, worst
  first, with the action that fixes each one a click away. There's a **Copy
  diagnostic report** row for pasting into a ticket. Nothing is repaired
  automatically, and nothing is written anywhere but your clipboard.

  Three things that used to fail without telling you:

  - **A revoked or expired Jira token read as signed-in.** Agent Flow Deck only checked
    that an email and token were *stored*, so an invalid one looked fine and every
    later fetch failed in a way indistinguishable from a network problem. Doctor
    actually calls Jira, and tells the two apart: bad credentials are a problem,
    an unreachable site is a warning.
  - **A `gh` your editor can't see looked like a broken Deck.** Doctor names the
    exact binary it found, and distinguishes "not installed" from "installed but
    signed out".
  - **A mistyped repos root and an empty one looked identical** — both rendered an
    empty pool. A missing path is now a problem; an empty one is only a warning,
    since that's normal on a fresh machine.

  It also reports whether Claude Code is installed at all, which nothing checked
  before, and warns when it's below **2.1.220** — the version shared-window batch
  launches need.

- Doctor is offered where things actually break, rather than waiting to be
  remembered: the task panel's error banner gains a **Run Doctor** button, and the
  Deck's `gh` notes point at the command.

## [0.1.37] — 2026-07-28

### Added

- **Change Status now asks for the fields your workflow requires.** Closing a
  ticket on a workflow that demands a Resolution used to fail outright. Agent Flow Deck
  now reads the transition's screen and prompts for each required field first —
  a pick list for Resolution and friends, an input box for text, numbers and
  dates — then sends them with the transition. Escape at any prompt and nothing
  is written.
- Some workflows enforce requirements that aren't on the transition screen at all,
  so a refusal gets **one rescue attempt**: Agent Flow Deck reads which field the
  rejection names, asks for it, and retries once. A second refusal is reported
  rather than retried.

### Fixed

- **Jira failures read as sentences instead of raw JSON.** A refused write used to
  surface as `Jira 400: {"errorMessages":[…],"errors":{}}`. It now reads
  *"Couldn't update ASM-1. Ticket cannot be closed unless Resolution will be
  provided."*, with field-level problems named by their display name rather than
  their `customfield_10042` id. Error pages and empty bodies become a plain
  status sentence instead of being dumped on screen.
- **A failed write no longer clears your task list.** Any Jira error used to
  replace the whole panel with an error banner, so one refused status change threw
  away the list you were working from. Only the actions that populate the panel can
  replace it now; a failed write leaves everything on screen and reports itself in
  a toast.
- **Error toasts stay until you dismiss them**, and carry an **Open in Jira**
  button. They used to vanish after 4.2 seconds — less time than it takes to read
  a workflow validator's message, let alone act on it. Success and info toasts are
  unchanged.

## [0.1.36] — 2026-07-28

### Added

- **Four more ways to start a task.** The "how should the agent start?" picker
  now offers **Test-driven** (write the failing test first, then implement until
  it's green), **Investigate & root-cause** (reproduce and trace it, propose a
  fix, no code edits), **Orchestrator** (split the ticket into parallel subtasks,
  then integrate and verify), and **Refine the ticket** (sharpen the description
  and acceptance criteria instead of building it) — alongside Plan first and
  Implementation.

### Fixed

- **The prompt-mode picker mangled its own descriptions.** The line under each
  mode's name was built by stripping the `{placeholders}` out of the prompt
  template and cutting the remainder at 80 characters, so it read
  `Jira : "". Read the task brief at .` and stopped mid-word. Each mode now
  carries a description written for the person reading the picker. A mode without
  one shows just its name, the way the Explore picker beside it already did.

If you have customized `agentFlow.promptModes`, your own list still applies and
you won't see the four new modes — that setting replaces the whole array rather
than adding to it. Copy the ones you want out of the setting's default, where a
new optional `detail` field holds the description line.

## [0.1.35] — 2026-07-27

### Fixed

- **Exploration sessions showed someone else's pull request.** A session with no
  Jira ticket has a made-up key and no branch Agent Flow Deck named, so looking it up
  asked Jira about an issue that doesn't exist and asked GitHub for pull requests
  from the default branch — which matched whatever was opened from it last, quite
  possibly a colleague's. Ticketless cards are now left out of both lookups, their
  key is no longer a dead "open in Jira" button, and an Explore session says
  `explore` instead of its internal slug.
- **Diff said a task had changed nothing the moment it committed.** The button
  diffed against `HEAD`, which goes blank as soon as an agent commits — so every
  task that got as far as opening a PR reported "no uncommitted changes". Diff now
  shows everything the task changed since it left the default branch, committed
  work included. A large diff no longer comes back empty either; it was hitting a
  1 MB buffer limit that read as "nothing to show".
- **Forget felt like nothing had happened.** The card stayed on the board through a
  full rebuild — a Jira round trip per run plus git per repo — with nothing on
  screen to say the Deck was working. The card now leaves immediately, the refresh
  button spins while a rebuild is in flight, and the next authoritative update
  brings the card back if the delete really did fail.

### Changed

- **The board stopped fighting itself on refresh.** Overlapping refreshes are
  sequenced, so a slow pass that started before a Forget can no longer put the
  forgotten card back; `origin/HEAD` is checked before it's trusted, since it goes
  stale after a default-branch rename; and a refresh's Jira lookups now run
  concurrently instead of one run at a time, which is most of what a cold refresh
  used to spend its time on.

## [0.1.34] — 2026-07-27

### Fixed

- **The Agent Flow Deck icon in the activity bar looked smaller than its neighbours.**
  Every view-container icon is normalised into the same 24px box, so only the
  artwork's extent inside it decides how big the mark reads — and ours filled 18.90
  of 24 against the ~21px Files, Search and Source Control occupy. The mark is now
  scaled to match the rail around it, with the same 16-dot design.
- **The Marketplace button wore Cursor's own Extensions icon.** The "Open the
  Marketplace" action in the Tasks header used `$(extensions)`, byte-for-byte the
  glyph Cursor uses for its extension marketplace, so the button read as "open
  Cursor's extensions". It now uses a distinct library glyph.

## [0.1.33] — 2026-07-27

### Fixed

- **The Deck said `gh` was missing when it wasn't.** PR facts stayed off with a
  "gh not found or not signed in" note on windows where the editor had failed to
  resolve your shell environment — the extension then only sees
  `/usr/bin:/bin:/usr/sbin:/sbin`, which holds `git` but no Homebrew `gh`. The
  Deck now looks for `gh` on `PATH` and in the usual install dirs, says which of
  the two things is actually wrong, and logs the binary it tried with what that
  binary said.

## [0.1.32] — 2026-07-27

### Added

- **The Deck reads your PRs.** Every card now shows the PR state of each repo it
  touches — number, CI with failing check names linked to their runs, review
  decision with unresolved-thread count, and mergeability — read from GitHub with
  the `gh` CLI. A blocked PR (failing required checks, requested changes, or a
  conflict) pulls its card into **Needs you**; a merged PR moves it to **Done**.
  Settings: `agentFlow.prFacts` (default on) and `agentFlow.prFactsTtlSeconds`
  (default 120). All access is read-only, through your existing `gh` login.

### Fixed

- A Deck card said *merged* whenever Jira said done, regardless of the PR. It now
  says *merged* only when a PR actually merged, and *done* otherwise.

## [0.1.31] — 2026-07-27

### Added

- **Launch a multi-select batch across several repos, into any destination.** The task
  checkboxes used to appear only with exactly one repo filtered, and every batch ignored
  where you wanted it and took its own new window per task. Now the checkboxes appear with
  **one or more** repos filtered, and each ticked task gets a worktree in the repos it's
  inferred to touch that are in your filter — falling back to the whole filtered set when
  the ticket names none, so a task never launches with no repo. The batch then walks the
  same destination chain a single **Take** does (new window, this window, a saved
  `.code-workspace`, or a window you already have open), and for a new window it asks how to
  lay the tasks out: **separate windows**, one per task, or **one shared window** holding
  every task's worktrees with a Claude Code session seeded per task — each stacked as a tab
  in one Claude group, in the order you selected them, carrying its own brief. Every other
  destination *is* a single window, so it goes straight to the shared layout. Remote Control
  is skipped for a shared window, because each session is seeded from its own plan file and
  there's no clipboard paste to attach it to, and the toast says so.

### Fixed

- **Re-taking a task seeds its agent again.** The "already seeded this window" guard was
  keyed on the ticket key and the window alone and nothing ever cleared it, while the
  workspace file a launch generates is deterministic — so taking the same task into the same
  window a second time opened it with the right folders and briefs and no Claude session at
  all, while the toast still promised one. The guard now carries the launch's own timestamp,
  so a fresh launch is never mistaken for one already consumed.

## [0.1.30] — 2026-07-27

### Added

- **The Marketplace is documented with screenshots.** `media/marketplace.png` shows the
  browse view — the search box, the type and scope pills with their live counts, the
  marketplace tags, the **category sections** (Yours first) and a selected skill's
  `SKILL.md` rendered in the detail pane. `media/marketplace-filters.png` shows the
  `Plugins ▾` picker open with two plugins ticked and the matching chips. Both are
  captured from the real webview with sanitized fictional demo data.

### Changed

- **The README's Marketplace section now covers what wasn't written down** — keyboard
  navigation (**↑/↓** to move, **Enter** to open), **Reveal in Finder**, **⟳ Rescan** and
  the rescan when the panel regains focus, and that **+ Add a marketplace** copies the
  `/plugin marketplace add` command rather than running it. The architecture tree, which
  still described the pre-Deck layout, now lists `deckView.ts`, `marketplaceView.ts` and
  the engine modules behind them, and **Status** names the Deck and the Marketplace.

## [0.1.29] — 2026-07-27

### Fixed

- **The In-flight deck scrolls as one board.** Vertical scrolling was per column, so each
  column moved on its own and a card's position told you nothing about the cards beside it.
  The board now scrolls as a whole, vertically and horizontally, and the column headers stay
  pinned while their cards pass underneath. The per-column bottom fade added in 0.1.28 is
  gone with it — it advertised a scroll the columns no longer own, and it would have sat on
  top of the board's horizontal scrollbar.

## [0.1.28] — 2026-07-26

### Fixed

- **In-flight columns scroll instead of clipping cards.** A column holding more cards than
  fit squeezed every card flat, so card content was cut off mid-card and no scrollbar ever
  appeared. Cards now keep their natural height and the column scrolls, with a fade at the
  bottom edge showing there is more below.

### Changed

- **In-flight cards read at a glance.** Each card leads with its agent state from the same
  position, so a column scans as one strip of what needs you, and the ticket key trails as
  quiet metadata instead of a mono block that wrapped to three lines. The summary is now the
  most prominent line (clamped to three lines, full text on hover), long branches and keys
  truncate to one line, and the footer no longer flips between one and two rows. Cards that
  need you carry a full-strength rail, red status text and a faint wash. Card controls are
  real buttons with visible focus rings, and motion respects `prefers-reduced-motion`.

## [0.1.27] — 2026-07-26

### Added

- **Remote Control for the session you just opened.** A new `agentFlow.remoteControl`
  setting (`off` / `on` / `ask`, default `off`) pre-fills the Claude Code panel with
  `/remote-control <KEY>` and puts the task prompt on your clipboard, so a task taken from
  the pool can be driven from claude.ai or the Claude mobile app: Enter to connect, paste
  and Enter to start. Nothing global is written — it applies only to the session being
  opened. Launches that open more than one window (a parallel batch, or a per-window Take
  across several repos) keep the normal seeding and say that Remote Control was skipped,
  because one clipboard can't carry a different task prompt for each window.

## [0.1.26] — 2026-07-26

### Added

- **Marketplace category sections.** The browse list groups by each plugin's manifest
  `category` — Yours first, then by descending size, Uncategorized last. Grouping applies
  under any type filter and drops away while searching. Click a header to focus that
  category.
- **Multi-select plugin and marketplace filters.** A searchable `Plugins ▾` picker, plus
  click-a-name-in-a-row, plus clickable marketplace tags, all with removable chips and a
  Clear action. All six filter dimensions — query, type, scope, category, plugins,
  marketplaces — AND together.
- **File preview in the detail pane.** Selecting a row renders its file under the
  metadata — a skill's `SKILL.md`, a hook's `hooks.json` as fenced JSON, a plugin's
  README — truncated at 262,144 characters. The renderer builds elements from a parsed
  tree and never injects HTML, so a hostile file from a third-party marketplace can't run
  anything.

### Fixed

- **A marketplace manifest can no longer point the scan outside its own directory.** A
  plugin's `source` (and a marketplace's `metadata.pluginRoot`) comes from a third-party
  repo, and the scan joined it onto the install location without resolving `..` — so a
  manifest declaring `../../../..` reached files anywhere on disk, on every scan, whether
  or not the plugin was installed. Those paths are now resolved and contained; anything
  climbing out is treated as not-on-disk. This mattered more with the file preview
  landing in the same release, which serves the full contents of whatever the scan found.

## [0.1.25] — 2026-07-26

### Fixed

- **Hooks no longer show up under every Marketplace filter.** A plugin can register
  several hooks that share an event, matcher and file and differ only by an `if` guard,
  which the scan discarded — the rows became identical, so did their React keys, and
  React left the duplicates mounted through every later filter change. Hooks now carry
  their `if` guard, so those declarations are told apart in both the list and the detail
  pane, and rows are keyed by their position in the scan.
- **One heading per type when browsing All.** Assets are scanned plugin by plugin, so the
  type headings repeated once per run — dozens of times on a well-stocked machine. Rows
  are now ordered by type, with each plugin's grouping preserved inside a block.

### Changed

- **Search is fuzzy and ranked.** `revw` finds `/review`, `mkpl` finds `marketplace`, and
  the best match is selected as you type. Names match as subsequences; descriptions match
  literally, so a short query no longer drags in nearly every asset. Extra words narrow
  the result rather than widening it, and the type pills retally against the query so it
  is obvious where the remaining matches are.

## [0.1.24] — 2026-07-26

### Changed

- **The Marketplace is now a local asset browser.** It reads `~/.claude` and the open
  workspace instead of GitHub repos you had to register by hand, so it shows your skills,
  slash commands, agents and hooks with no setup and no `gh`. Search across everything,
  filter by type or down to installed/enabled only, open a source file in an editor tab,
  or copy the invocation. Disabled plugins, `skillOverrides`, and plugins your
  marketplaces catalogue but haven't downloaded are all surfaced.

### Removed

- The `agentFlow.marketplaces` setting and the `gh`-backed remote fetch, along with the
  auth and not-found failure modes that came with them. Add marketplaces in Claude Code
  (`/plugin marketplace add owner/repo`); they appear here on the next scan.

## [0.1.23] — 2026-07-26

### Added
- **Remove from sprint.** Each card on the **My sprint** tab now has a **Remove**
  button that moves the ticket to the backlog — taking it out of the active sprint
  while leaving its assignee and status untouched. Removal is instant, and a native
  VS Code notification offers a one-click **Undo** that puts the ticket back in the
  sprint. The action appears only on the My sprint tab.

## [0.1.22] — 2026-07-24

### Changed
- **Skip the repo picker for existing-workspace destinations.** When you open a task
  (Explore, Take, or Address PR) into an existing workspace or a live folder, the
  destination already fixes which repos are present — so Agent Flow Deck now uses that repo
  set directly instead of prompting you to pick repos again. The picker still appears
  for new / current-window destinations. Workspace folders outside `reposRoot` are
  honored too.

## [0.1.21] — 2026-07-24

### Added
- **The Marketplace** — a new panel (puzzle-piece button beside the Deck) to register
  GitHub Claude Code plugin-marketplace repos and browse their plugins, skills, agents,
  and commands, with copy-able `/plugin` install commands. Reads repos via your `gh` CLI
  login (public + private).

## [0.1.20] — 2026-07-24

### Added
- **Multi-select & parallel launch.** When the repo filter is narrowed to a single
  repo, a checkbox appears on each task card and a **Launch in parallel** bar lets you
  kick off several tasks at once. Each selected task opens in its own git worktree
  (its own branch) in its own window, with its own Claude Code session pre-seeded —
  several agents working the same repo simultaneously. The prompt mode is asked once
  and applied to the whole batch; a task whose worktree can't be created is skipped
  and reported rather than launched into the shared checkout.
- **`agentFlow.batchLaunchConfirmThreshold`** (default `6`) — batches larger than this
  prompt a confirmation first, guarding against accidentally opening a swarm of windows.

## [0.1.19] — 2026-07-22

### Changed
- **Refreshed the README screenshots to the current UI.** `media/screenshot.png` now
  shows the task pool in its current design — reordered filter tabs (**My sprint**
  first), the **Filter repos** multiselect, the **Search title** fuzzy box, and the
  per-card **Address PR** action — captured from the real webview with sanitized
  fictional demo data (no internal names).

### Added
- **`media/deck.png`** and a **"The Deck — your in-flight board"** README section
  documenting the Deck (`Agent Flow: Open the Deck (in-flight)`): the four-column
  pipeline (**In progress · Needs you · In review · Done**) with the live-status
  vocabulary (working / idle / ended turn / parked / merged), diff-stat chips, the
  summary strip, and the Live-signal toggle.

## [0.1.18] — 2026-07-22

### Fixed
- **Filter repos dropdown rendered transparent** on themes whose `input.background`
  token carries an alpha channel — the task deck bled through the popup. The dropdown
  now uses an opaque, theme-aware background (`dropdown-background` → widget/editor
  fallbacks).

## [0.1.17] — 2026-07-22

### Added
- **Repo filter is now a multiselect dropdown.** The old free-text *"Filter by repo…"*
  box is replaced by a **Filter repos** dropdown: pick one or more repos from a
  checkbox list (filter-as-you-type, keyboard-navigable) and the task list narrows to
  tasks touching **any** selected repo.
- **Fuzzy title search.** A new **Search title…** box fuzzy-matches task titles
  (powered by fuse.js) and orders results best-match-first.
- New setting **`agentFlow.filters.search`** (default on) to show/hide the search box.

### Changed
- **`agentFlow.filters.repo`** now shows/hides the repo **multiselect** (previously the
  free-text repo box).

## [0.1.16] — 2026-07-22

### Changed
- **Take a task & Explore:** you now choose *where* the task opens **before** the repo
  list, not after. The destination picker (new window · this window · an existing
  `.code-workspace` · a live window) comes first, and the repo list then **pre-checks
  the repos that destination already contains** — so opening into a workspace you've
  already set up no longer means re-picking everything.
- **Take a task:** the *"how should the agent start?"* prompt-mode question is now the
  first step (when `agentFlow.taskMode` is `ask`).

## [0.1.15] — 2026-07-22

### Changed
- **The Deck (in-flight board):** renamed the **Working** column to **In progress**
  and moved the true live state onto each card, so an idle task reads *idle* and a
  parked task reads *parked* instead of everything collapsing into one column.
  Columns now run in pipeline order — **In progress → Needs you → In review → Done**.
- Cards carry a state-driven status dot (working = green pulse, idle = amber,
  needs-you = red, parked/merged = hollow), a branch chip, a "launched … ago" stamp,
  and the header now shows a summary strip of counts.
- **Open** is presence-aware: an already-open window is silently focused (no duplicate,
  no toast) and marked with an "open now" hint; only failures notify.

### Added
- Per-card **⋯** overflow menu with **Forget** (drop a stale/merged run from the board)
  and **Open in Jira**.

## [0.1.14] — 2026-07-22

### Fixed
- Build/CI: pin the public npm registry via a committed `.npmrc` so `npm ci`
  resolves from `registry.npmjs.org` regardless of a contributor's global npm
  config. Fixes the CI `npm ci` authentication failure and keeps
  `package-lock.json` free of private-registry URLs.

## [0.1.13] — 2026-07-22

### Added
- **Configurable filter visibility.** Three settings — `agentFlow.filters.size`,
  `agentFlow.filters.status`, and `agentFlow.filters.repo` (all default `true`) — let you
  hide the Size lens, the Status chip row, or the "Filter by repo…" box in the task-pool
  sidebar. Hidden controls keep their neutral value, so results are never narrowed. The
  tab bar stays always-visible. Applies on refresh/reload.

### Changed
- Documentation overhaul for the open-source release: README with a UI screenshot,
  quick-start walkthrough, and badges; a `CHANGELOG.md`; and refreshed copyright.

### Fixed
- Packaging: include the Deck webview bundle (`dist/deck.js`) and the PNG marketplace
  icon in the `.vsix`, declare the `png` content type, and register the icon in the
  manifest. Previously only `dist/{extension,webview}.js` and `media/*.svg` were packaged.

## [0.1.12] — 2026-07-22

### Changed
- Reordered the task filter tabs so the most-used lens comes first:
  **My sprint · Unassigned · Mine · Sprint · Backlog**.

## [0.1.11] — 2026-07-22

### Changed
- Maintenance release (version bump; no user-facing changes).

## [0.1.10] — 2026-07-21

### Changed
- Renamed the card action **"Review PR" → "Address PR"** to better describe what it
  kicks off (assess *and* fix, not just review).

## [0.1.9] — 2026-07-21

### Added
- **Address PR kick-off.** When a task reaches your PR-review status (default
  `PR initiated`), an **Address PR** button appears on the card. It starts an agent
  **in a git worktree** that finds the task's GitHub PR by its Jira key, checks out the
  branch, and assesses readiness — then, by default, implements the requested changes
  (toggle with `agentFlow.prReviewAutoFix`).
- **Configurable Explore actions.** Four Explore modes — open a Jira ticket, enhance
  knowledge/flow, debug, and general — each with its own editable prompt template and an
  optional "DM me a summary on Slack" toggle.
- **Open into an already-open window.** A window-presence registry lets you drop a task
  into a VS Code window you already have open (a repo folder or a saved workspace),
  instead of always spawning a new one. Toggle with `agentFlow.trackOpenWindows`.

## [0.1.8] — 2026-07-21

### Added
- **Per-task git worktrees.** Optionally isolate a task in a worktree/branch created
  inside each repo at `.claude/worktrees/<KEY>` (git-excluded automatically). Controlled
  by `agentFlow.worktree` (`ask` / `always` / `never`).

## [0.1.7] — 2026-07-20

### Added
- **Status filter lens.** A client-side multi-select to narrow the task pool by Jira
  status.

## [0.1.0] — 2026-07-19

Initial release (and the early `0.1.x` patch line that followed on the same day).

### Added
- **Sidebar task pool** — a React webview with filter tabs and an S/M/L size lens
  (by original estimate).
- **Jira integration** over the REST API: JQL builder, search, issue detail, and status
  transitions. Reads are the default; the only writes are optional status changes from a
  card, which stamp a configurable provenance label (default `claude-code`).
- **Service inference** — matches a ticket's components, labels, and text against your
  local repo checkouts (backend *and* frontend).
- **Open + seed** — writes a git-excluded `.pick-task/TASK.md` brief into each repo,
  generates a `<KEY>.code-workspace` (or one window per repo), and pre-fills the Claude
  Code panel with your chosen prompt mode.
- **Open-where choices** (`agentFlow.openIn`): a new window, the current window, or
  merge the task's repos into an existing `.code-workspace` (non-destructive, additive).
- **Workspace modes** (`agentFlow.workspaceMode`): auto, multi-root, per-window, or ask.
- **First-run setup wizard** — collects Jira site, project key, and repos directory with
  no organization-specific defaults baked in; credentials go to encrypted SecretStorage.
- **Branding** — logo, activity-bar icon, and unique Marketplace identifiers.

### Fixed
- Hardened activation: an optional step (e.g. a missing command or a dead panel) can no
  longer crash the extension, and every failure surfaces a clear state instead of a blank
  loading panel.
- Bundled `jsonc-parser`'s ESM build so activation stops crashing.

[Unreleased]: https://github.com/oznasi1/agent-flow/compare/v0.1.12...HEAD
[0.1.12]: https://github.com/oznasi1/agent-flow/releases/tag/v0.1.12
[0.1.11]: https://github.com/oznasi1/agent-flow/releases/tag/v0.1.11
[0.1.10]: https://github.com/oznasi1/agent-flow/releases/tag/v0.1.10
[0.1.9]: https://github.com/oznasi1/agent-flow/releases/tag/v0.1.9
[0.1.8]: https://github.com/oznasi1/agent-flow/releases/tag/v0.1.8
[0.1.7]: https://github.com/oznasi1/agent-flow/releases/tag/v0.1.7
[0.1.0]: https://github.com/oznasi1/agent-flow/releases/tag/v0.1.0
