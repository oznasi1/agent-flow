# Data & privacy

> The short version lives in the [README](../README.md#privacy). This is the complete one.

Agent Flow Deck talks to **your** Jira Cloud site, reads your **local** repo checkouts,
and — when `agentFlow.prFacts` is on — reads your **own** GitHub through your
existing `gh` login. The review-requests strip shares that same gate rather than
adding a new one: `agentFlow.reviewRequests` only produces a GitHub read while
`agentFlow.prFacts` is also on, so turning PR facts off silences the strip too,
regardless of its own setting. Nothing about your tickets, code or repos is sent
to any service that isn't already yours, and Agent Flow Deck stores no GitHub
credentials of its own: every GitHub call goes through `gh`, so it inherits
whatever host, SSO and token your CLI already
has. When `agentFlow.openAgents` is on, the Deck also reads `~/.claude/sessions` —
Claude Code's own local registry of what's running — to find sessions it didn't
launch; nothing in that registry leaves your machine either, but when `agentFlow.prFacts`
is also on, a session sitting on a feature branch gets the same `gh pr list` (and,
when needed, `gh api graphql`) read run *in that directory* too — even one you never
pointed Agent Flow Deck at, like an OSS clone, a client checkout, or another team's repo.
Separately, Agent Flow Deck
also sends anonymous *usage* telemetry (not any of the above) — see
[Telemetry](TELEMETRY.md).

GitHub access is **read-only by default** — Agent Flow Deck never pushes, and out
of the box it never merges either. There are exactly **two** exceptions, each
behind its own setting, each shipping **off**, and each asking for a modal
confirmation before anything reaches GitHub.

The first is `agentFlow.reviewWrites`: with it on, the Deck's review strip can
submit a review — approve, comment, or request changes — on a PR that asked for
yours. Every submit shows a modal confirmation naming the verb, the repo and the
PR number before anything reaches GitHub, and every submit attempt — success or
failure — is logged to the **Agent Flow Deck** output channel. A review body
loaded from the session's draft is marked as session-drafted when it goes out (a
fixed line, not the configurable `agentFlow.provenanceLabel`), unless
`agentFlow.stampLabelOnWrite` is off. Nothing else about the feature writes
anywhere: the review session itself is told, in its seeded prompt, not to post
anything to GitHub — the human submits the review.

The second is `agentFlow.mergeWrites`: with it on, a card whose one pull request
is provably ready — approved, every check green, no unresolved review threads,
and mergeable cleanly — offers a **Merge** button, and pressing it merges that
pull request into its base branch. That is the only write Agent Flow Deck makes
that lands code on a default branch, so it is fenced the same way the review
write is: every merge shows a modal confirmation naming the repo, the pull
request number and the strategy (`agentFlow.mergeMethod`, `squash` by default)
before anything reaches GitHub, and every merge attempt — success or failure — is
logged to the **Agent Flow Deck** output channel. The button is the only path:
nothing merges on a timer, from an Orchestrator rule, or in the background, and
one press merges one pull request.

The **Doctor** command probes rather than only reading config: it makes two
authenticated GETs to your own Jira site and runs `gh auth status`, which is what
catches a revoked token instead of reporting it as a network problem. It writes
nothing anywhere except your clipboard, and only when you ask it to copy the
report. Your Jira credentials are stored in VS Code **SecretStorage** (encrypted),
never in `settings.json`. Reads are the default; the only Jira **writes** are the
optional status changes you trigger from a card (which stamp the provenance
label). Task briefs are written to a git-excluded `.pick-task/` directory in each
repo, so they never get committed.

