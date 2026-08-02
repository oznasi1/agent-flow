# Changelog

All notable changes to **Agent Flow** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Explore can verify a feature on an environment.** A fifth Explore action, **Verify on
  an environment**, asks which environment to check — from the new `agentFlow.environments`
  list, or a one-off you type — alongside the repos you already pick, then seeds a
  read-only prompt asking the agent to inspect those services in that environment (logs,
  error rates, metrics and traces, deployed version) and return a working / broken /
  inconclusive verdict with evidence. The prompt is editable at
  `agentFlow.explorePrompts.verify`, and `agentFlow.exploreMode` can pin Explore to it.
  Agent Flow itself never touches the environment — the agent does that with its own tools.

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
  naming the verb, repo and PR number. This is the first thing in Agent Flow
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

- **`Agent Flow: Doctor` — one command that checks everything Agent Flow depends
  on and offers the fix.** It probes your Jira site and project, your stored
  credentials, `git`, your repos root and workspace directory, `gh`, the Claude Code
  extension and its version, and the runs store — then lists what's broken, worst
  first, with the action that fixes each one a click away. There's a **Copy
  diagnostic report** row for pasting into a ticket. Nothing is repaired
  automatically, and nothing is written anywhere but your clipboard.

  Three things that used to fail without telling you:

  - **A revoked or expired Jira token read as signed-in.** Agent Flow only checked
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
  ticket on a workflow that demands a Resolution used to fail outright. Agent Flow
  now reads the transition's screen and prompts for each required field first —
  a pick list for Resolution and friends, an input box for text, numbers and
  dates — then sends them with the transition. Escape at any prompt and nothing
  is written.
- Some workflows enforce requirements that aren't on the transition screen at all,
  so a refusal gets **one rescue attempt**: Agent Flow reads which field the
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
  Jira ticket has a made-up key and no branch Agent Flow named, so looking it up
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

- **The Agent Flow icon in the activity bar looked smaller than its neighbours.**
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
  destination already fixes which repos are present — so Agent Flow now uses that repo
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
