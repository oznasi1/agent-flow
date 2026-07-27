# Changelog

All notable changes to **Agent Flow** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
