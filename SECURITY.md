# Security policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub:
[**Report a vulnerability**](https://github.com/oznasi1/agent-flow/security/advisories/new)
(the repository's **Security** tab → **Report a vulnerability**). That opens a private
advisory only you and the maintainer can see, and it keeps the discussion, the fix and the
eventual disclosure in one place.

Please include the extension version, your editor and its version, and the smallest set of
steps that reproduces the problem. If a report needs configuration to reproduce, redact
your Jira site, ticket keys and repo names — they are never needed to demonstrate a bug.

You should get a first response within about a week. This is a personal project maintained
in spare time, so there is no formal SLA beyond that; if a report is confirmed, the fix
ships in the next release and the advisory is published alongside it.

## Supported versions

Only the **latest published version** is supported. The extension releases frequently and
there are no maintenance branches — a fix lands in the next version rather than being
backported. Check what you are running against
[the changelog](CHANGELOG.md) before reporting.

## Scope

Agent Flow Deck runs entirely on your machine and talks only to services you are already
signed in to. The parts worth pointing a security question at:

- **Credential handling.** Jira credentials belong in VS Code SecretStorage and must never
  reach `settings.json`, a log, a task brief, a telemetry event, or a webview. GitHub
  access has no stored credential at all — every call shells out to your `gh` CLI.
- **What leaves the machine.** Anything that sends repo names, ticket keys, file paths,
  prompt text or error messages off the machine is a bug. See
  [docs/TELEMETRY.md](docs/TELEMETRY.md) for what the telemetry is allowed to contain.
- **The webview boundary.** The webviews render Markdown from files on disk, including
  files from third-party Claude Code marketplaces. That renderer builds elements from a
  parsed tree rather than injecting HTML; anything that gets script to run, or that reaches
  the extension host from webview content, is a vulnerability.
- **Shelling out.** Paths and refs are interpolated into `git` and `gh` invocations. A repo
  name, branch name, ticket key or PR title that escapes its argument is a vulnerability.
- **Files written outside the intended place.** Briefs go in a git-excluded `.pick-task/`
  and worktrees in `.claude/worktrees/`. A ticket key or repo name that traverses out of
  those (`../`) is a vulnerability.

## Out of scope

- **`{note}` substitution in Orchestrator commands is unquoted by design** and documented
  as such — see
  [docs/ORCHESTRATOR_COMMANDS.md](docs/ORCHESTRATOR_COMMANDS.md#with-what-text).
  You are writing a shell template for your own machine and quoting it is the template
  author's job. Reports that a note can run a second command are not vulnerabilities.
  A way for something *other than the person editing the flow* to control that note would
  be.
- **The agent can edit your files and run commands.** That is the product. Findings that
  amount to "the coding agent I authorized changed my code" are not vulnerabilities.
- **Anything requiring an attacker who already has your user account** on the machine.
  Everything here — tokens, transcripts, notes — is readable by that user by design.
- Vulnerabilities in Jira, GitHub, VS Code, Cursor, Claude Code or Copilot themselves.
  Please report those to their maintainers.
