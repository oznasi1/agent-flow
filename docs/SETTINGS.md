# Settings

> Every setting also appears in VS Code's Settings UI — search `agentFlow`. The six
> you actually need to get started are in the [README](../README.md#settings).

| Setting | Default | Notes |
|---------|---------|-------|
| `agentFlow.jira.baseUrl` | `""` | Your Jira Cloud site, e.g. `https://your-org.atlassian.net`. |
| `agentFlow.jira.project` | `""` | Jira project key, e.g. `ABC`. |
| `agentFlow.reposRoot` | `~/projects` | Where your repo checkouts live. |
| `agentFlow.workspaceDir` | `~/projects` | Where generated `.code-workspace` files go. |
| `agentFlow.repoBlocklist` | `[]` | Directory names under `reposRoot` to exclude from discovery. |
| `agentFlow.githubOrg` | `""` | Reserved (clone support not yet implemented). |
| `agentFlow.provenanceLabel` | `claude-code` | Label stamped on Jira writes when enabled. |
| `agentFlow.stampLabelOnWrite` | `true` | Whether to stamp the provenance label on a Jira write, and whether a review body submitted from the Deck is marked as agent-drafted (a fixed line, distinct from `agentFlow.provenanceLabel`). |
| `agentFlow.defaultFilter` | `mysprint` | Default task filter lens (`unassigned`, `mysprint`, `mine`, `sprint`, `backlog`). |
| `agentFlow.seedAgent` | `true` | Pre-fill the agent's panel after opening. |
| `agentFlow.agentProvider` | `claude-code` | Which agent starts a session: `claude-code`, `copilot`, `cursor`, or `ask`. `copilot` uses GitHub Copilot and works **only in VS Code**; `cursor` uses Cursor's built-in agent and works **only in Cursor** — each falls back to Claude Code in the other editor. `ask` prompts you to pick per launch; a **batch** launch asks once and uses that answer for every task in it. Under `ask`, Orchestrator rules and the Deck's unattended seed (a stale plan reopened with no picker to show) use Claude Code, since nothing there can answer a prompt. Neither Copilot nor Cursor sessions appear as live agents on the Deck, which reads Claude Code's session files — and **Doctor** reports rows for whichever provider(s) are actually in play (every host agent, under `ask`). One more gap under `ask`: some briefs are written before the picker runs, and so name Claude Code even when a different agent was actually picked — taking a single task, an Orchestrator child task, and a one-key **batch** that opens its own window (which, being a single launch, resolves inside that launch rather than up front). Briefs are unaffected wherever the answer is known first: a multi-task batch resolves once up front, and a one-key batch landing in a **shared** window resolves before it writes anything. |
| `agentFlow.agentSurface` | `extension` | Where a session starts: the agent's chat panel, or `terminal` to run its CLI in an integrated terminal. Either way the prompt is pre-filled and you press Enter. |
| `agentFlow.trackOpenWindows` | `true` | Track open windows so a task can open into one you already have open. |
| `agentFlow.forge` | `github` | Which forge holds your pull/merge requests: `github` (via the `gh` CLI) or `gitlab` (via `glab`). Everything that reads a pull request — the cards' PR state, the review strip, review writes, the Orchestrator's branch-CI rule — goes through the one you pick, and **Address PR** / **Review with agent** seed a prompt worded for it. See [docs/FORGES.md](FORGES.md) for what GitLab cannot answer. |
| `agentFlow.prFacts` | `true` | Read each in-flight task's PR (or merge request) state from your configured forge via its CLI and show it on the Deck's cards. |
| `agentFlow.openAgents` | `true` | Show every Claude Code session open on this machine on the Deck: as agents on the card that owns their directory, and as a `local` card of its own for a place Agent Flow Deck never launched. Read from `~/.claude/sessions`. |
| `agentFlow.prFactsTtlSeconds` | `120` | How stale a cached PR fact may be before the Deck re-fetches it (minimum 30). Only fetched while the Deck is open. |
| `agentFlow.deckGrouping` | `agents` | One card per agent, or per launched task (`workspaces`). |
| `agentFlow.retireFinishedAfterHours` | `24` | How long landed work stays on the board after its last agent closes. `0` retires on sight. |
| `agentFlow.retireClosedAfterHours` | `24` | How long a closed run stays in the board's **Recently closed** strip before its record is deleted. `0` retires on sight. |
| `agentFlow.retireInPlaceAfterHours` | `0` | How long a finished **Explore** or **Notepad** session stays on the board once you close its agent. These run in your checkout, not a worktree, so `0` removes the card as soon as the session closes. |
| `agentFlow.inflightShowAll` | `false` | Show every run record on the board, the way it worked before the Recently closed strip. |
| `agentFlow.retireAbandonedAfterDays` | `7` | How long a ticketless, PR-less, clean run may sit before its record is deleted. `0` disables it. |
| `agentFlow.prReviewStatus` | `PR initiated` | Task status (case-insensitive) that shows the **Address PR** button on the sidebar's Tasks card. The Deck gates its own Address PR button on the review column's waiting lane instead — this setting does not affect it. |
| `agentFlow.prReviewAutoFix` | `true` | After the PR-review agent assesses the PR, let it implement the requested changes (off = assess only). |
| `agentFlow.reviewRequests` | `true` | Show the Deck's review-requests strip: open PRs (or merge requests) on your configured forge that ask for your review. |
| `agentFlow.reviewRequestsTtlSeconds` | `300` | How stale the cached review queue may be before a refetch (minimum 60). |
| `agentFlow.reviewWrites` | `false` | Allow submitting approve / comment / request changes to your configured forge from the Deck. On GitLab, request changes posts your message and withdraws any approval you had — GitLab has no such review state — and the confirmation dialog says so. |
| `agentFlow.reviewRequestModes` | *(one built-in mode)* | Seed modes offered by **Review with agent**, layered over the built-in one. Add your own — e.g. separate backend and frontend review modes — and clicking asks which to use. |
| `agentFlow.reviewRequestMode` | `ask` | Pin one review mode by `id` to skip the question. |
| `agentFlow.reviewOpenIn` | `new-window` | Where **Review with agent** opens: a new window on the review worktree (the default, and what every release so far did), `this-window`, `pick-existing` for a `.code-workspace` you already have, or `ask` to choose each time — the same question `agentFlow.openIn` asks for a task you take, kept separate because a review is a shorter errand. The review always runs in its own worktree whichever you pick; anything but a new window seeds a session that is told, by absolute path, to work in that worktree. |
| `agentFlow.remoteControl` | `off` | Offer Claude Code's **Remote Control** for the session Agent Flow Deck opens (`off` / `on` / `ask`), so you can drive it from claude.ai or the Claude mobile app. |
| `agentFlow.environments` | `["dev", "staging", "production"]` | Environments offered by the **Verify on an environment** Explore action. The picker also offers **Custom…** for a one-off. |
| `agentFlow.orchestrator` | `false` | Show the Deck's Orchestrator drawer, where you wire in-flight agents into a flow with a condition on each connection. |

Plus `agentFlow.workspaceMode`, `agentFlow.taskMode`, `agentFlow.promptModes`,
`agentFlow.exploreMode`, `agentFlow.explorePrompts.*`, `agentFlow.prReviewPrompt`, and
`agentFlow.worktree` — see the Settings UI. Taking a task asks how the agent should
start: **Plan first**, **Implementation**, **Test-driven**, **Investigate &
root-cause**, **Orchestrator**, or **Refine the ticket**. Edit those prompts, or add your own mode, under
`agentFlow.promptModes`; pin one with `agentFlow.taskMode` to skip the question.
Your entries layer over the built-in modes rather than replacing them — reuse a
built-in `id` to override just the fields you set, and add `"hidden": true` to an
entry to drop that built-in — so modes added in a later release still reach you. **Explore** asks what kind of session to start: **Open a Jira ticket**, **Enhance
knowledge / flow**, **Debug**, **General**, **Supervise running tasks**, or **Verify on an environment**. Verify also
asks which environment to check the repos you picked against — from
`agentFlow.environments`, or a one-off you type — and seeds a read-only prompt that
inspects their logs, error rates, metrics and traces, and deployed version there. Edit any Explore prompt
under `agentFlow.explorePrompts.*`, or pin one action with `agentFlow.exploreMode`.
**Review with agent** works the same way on its own list: one **Full review** mode ships,
and once you add one of your own — a backend-services reviewer, say — clicking asks which to
seed, since your entry joins **Full review** rather than replacing it. Pin one with
`agentFlow.reviewRequestMode`. Where it opens is a second, separate question —
`agentFlow.reviewOpenIn`, which ships pinned to a new window and asks nothing until you
set it to `ask` — and which a *batch* of reviews asks with too. Selecting several rows and
launching them together also offers one extra mode the single-row launch never shows —
**Read-only review**, which reads each PR at its own revision instead of checking it out,
so several reviews can share one window (it cannot run tests). Add the `read-only` id to
`agentFlow.reviewRequestModes` if you want it per row too. The sidebar's **Address PR**kick-off always runs in a fresh worktree; a Deck card's re-seeds that run's existing workspace
in place instead — whatever `agentFlow.worktree` gave it when it was
launched. Per-task worktrees are created inside each repo at
`.claude/worktrees/<KEY>` (and git-excluded automatically).

**Remote Control.** With `agentFlow.remoteControl` set to `on` or `ask`, the Claude Code
panel is pre-filled with `/remote-control <KEY>` instead of the task prompt, and the task
prompt goes to your clipboard: press Enter to connect the session, then paste and press
Enter to start the task. The Jira key names the remote session, so several are tellable
apart on claude.ai. It takes two steps because Claude Code can't run a slash command and a
prompt in one submission. It applies only where a single clipboard can carry the prompt: a
per-window Take across several repos keeps the normal single-Enter seeding, since one
clipboard can't hold a different prompt for each window — and so does any launch into a
**shared window**, batch or single task, because each session there is seeded from its own
plan file with no clipboard paste to attach to. Either way the toast says Remote Control
was skipped, so you're never left waiting for a `/remote-control` prompt.

Remote Control needs Claude Code — Copilot has no equivalent slash command. Under
`agentFlow.agentProvider: copilot`, setting `agentFlow.remoteControl` to `on` refuses
the launch outright, with an error toast and before anything (a worktree, a window) is
created. Set to `ask`, the picker simply isn't offered and the launch proceeds without
Remote Control — a Copilot user is never blocked over a toggle it can't honor.

## Where a task opens

`agentFlow.openIn` controls where a task you take gets opened: `ask` (ask each time),
`new-window`, `this-window` (start a session in the window you're already in), or
`pick-existing` — pick an existing `.code-workspace` file to open the task into. Repos
the workspace already has a folder for (matched by name) are skipped automatically and
named in the toast — a worktree keeps its repo's bare name, so adding it anyway would
grow a second root by that name. Anything genuinely new is added only after you approve
it in a prompt; declining leaves the file byte-identical. Either way the workspace's
existing folders, settings, and formatting are preserved and it opens as a multi-root
workspace.

`this-window` never replaces what's open. The window keeps its folders, its editors and
any session already running in it, and the task's agent starts alongside them. A window
Agent Flow can't name — an empty one, or several folders with no saved
`.code-workspace` — can't hold a seeded session, so **This window** isn't offered there
and `this-window` opens a new window instead.

When taking a task (or starting an Explore session) with `agentFlow.openIn` set to
`ask`, Agent Flow Deck also lists the windows you already have open — a repo folder or a
saved workspace — so you can drop the task straight into one of them. Choosing an open
**workspace** window offers to add any genuinely new repos to it (the same skip-and-approve
behavior above); choosing an open **folder** window focuses it and seeds the agent there
(a folder window can't gain root folders, so any other repos the task touches keep their
briefs but aren't added as roots). Set `agentFlow.trackOpenWindows` to `false` to turn
this off.

## Where the session opens

Three settings answer three different questions. `agentFlow.openIn` decides **which
window** a task lands in. `agentFlow.agentProvider` decides **which agent** starts the
session — Claude Code, Copilot in VS Code, Cursor in Cursor, or `ask` to pick per
launch. `agentFlow.agentSurface` decides **what starts the session** once it's there:

- `extension` (default) — the agent's chat panel, prompt pre-filled: the Claude Code
  panel, Copilot Chat in agent mode when `agentFlow.agentProvider` resolves to
  `copilot`, or Cursor's chat when it resolves to `cursor`.
- `terminal` — an integrated terminal named `Claude · <KEY>` (or `Copilot · <KEY>` /
  `Cursor · <KEY>`) running the agent's CLI (`claude`, `copilot`, or `cursor-agent`),
  prompt pre-typed.

Either way you press Enter to start, and both work for every launch path: taking a
task, batch launches, Explore, Notepad, and **Address PR** — with one exception. A
**batch** launch under Copilot's `extension` surface does not seed the chat panel at
all: Copilot Chat is single-instance, so a second task's prompt would silently
overwrite the first. Instead the batch writes every task's brief as usual and shows a
notification pointing at them; there is no per-task Copilot chat tab. Terminal mode
needs `claude` (or `copilot`) on your `PATH`; if it isn't, the terminal says
`command not found` and the prompt is still sitting there to reuse.

