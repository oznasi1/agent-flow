## What this changes

<!-- What behavior is different after this PR, from the user's point of view. -->

## Why

<!-- The problem it solves. Link the issue if there is one: Fixes #123 -->

## How it was verified

<!--
What you actually ran, and what it said. "Tests pass" is less useful than the
command and its output. If you exercised it in an Extension Development Host
(F5), say what you clicked and what happened.
-->

## Checklist

- [ ] `npm run typecheck` is clean
- [ ] `npm test` passes
- [ ] `npm run build` succeeds — this is the only thing that catches a webview importing
      `fs`/`path`/`child_process`; `tsc` and the test suite both pass regardless
- [ ] Tests added or updated for the behavior change
- [ ] No organization-specific values hardcoded — anything that varies per user is an
      `agentFlow.*` setting read through `getConfig()`
- [ ] `CHANGELOG.md` has an entry under `## [Unreleased]` for any user-facing change
- [ ] Existing behavior is unchanged for people who do not opt in to this

<!--
See CONTRIBUTING.md for the conventions behind these. Thanks for contributing.
-->
