# Usage analytics — follow-ups

Residuals from the Phase 1 implementation of
[the usage-analytics design](../specs/2026-07-31-usage-analytics-design.md), recorded at
merge time. None of these changes shipped behaviour or makes the public disclosure
inaccurate — every one was adjudicated as a post-merge cleanup by the whole-branch review or
the fix-wave re-review. The five merge blockers those reviews found were fixed before merge.

Ordered roughly by value, not by discovery.

## Correctness and data fidelity

**`classifyFailure` reads `.code`, but `JiraApiError` carries `.status`.** So HTTP-status Jira
failures classify as `"unknown"`. Narrower than it first appears: 401/403 are converted to
`JiraAuthError` in `src/jira/client.ts` and classify correctly as `"auth"`, and of the
remainder only 404 has a home in `FailureClass` (`not_found`) — 400/409/429/5xx would be
`"unknown"` regardless. So the real loss is one class on one status. The failure itself is
never lost (`outcome:"failed"` + `flow_id` + `op` all still land). Fixing it touches a
classifier shared by `operation_failed` and `take_completed`. While there: `classifyFailure`'s
`code === "401" || code === "403"` branch is dead — nothing in `src/` sets a string `.code`.

**`inferred_count` means two different things.** It is hard-coded `0` on `take_started`
(inference has not run yet) and carries the real count on `take_repos_picked`. Any chart
grouping on that name across the funnel is silently wrong. Either drop it from `take_started`
or populate it.

**`take_completed{cancelled}` reports `prompt_mode: "custom"` when no mode was chosen**, since
`promptModeProp` is initialised to `"custom"`. That inflates `"custom"` in exactly the numbers
meant to decide whether the stock prompt modes are dead weight. Make it optional and omit it,
as `destination` already is.

**`duration_ms` is not monotonic.** `startFlow()` uses `Date.now()`; the spec specifies a
monotonic reader. A clock adjustment mid-Take yields a wrong or negative duration.
`performance.now()` is a one-line change.

**`used_worktree` means "we decided to", not "every repo got one".** The `onWorktreeDecision`
callback fires before `createWorktrees`, which can fall back to the main checkout. The
`docs/TELEMETRY.md` wording is defensible but marginally stronger than the code.

## Robustness

**The first-run notice can still collide with the setup wizard.** `activate()` passes
`setupRunning: isFirstEver` (keyed on `INSTALLED_KEY`), but `src/setup.ts` shows its welcome
prompt on every activation until `SETUP_COMPLETE_KEY` is set. A user who clicks "Later" gets
both on activation #2 — the collision the deferral exists to prevent. Worse: if the
`INSTALLED_KEY` write keeps failing, `isFirstEver` stays true forever and the disclosure is
suppressed permanently while events keep flowing. Gate on `!globalState.get(SETUP_COMPLETE_KEY)`.

**Two facade entry points are unguarded.** `fingerprint()` and `startFlow()` have no
try/catch, while the spec says every facade entry point is wrapped. `fingerprint(key)` is
called before any user-visible work in `takeTask`. Same shape in `onMessage`'s last-resort
catch, where `resolveOp`/`classifyFailure`/`isRetryable` run outside any guard — a throw
there would swallow the user-facing error toast.

**Common properties no longer pass through VS Code's `cleanData`.** The fix wave made the
sender the single merge point, which was correct, but it means the invariant "everything we
ship was scrubbed" no longer holds for the six common values. All six are editor-environment
constants today so nothing can leak, and the mock never modelled `cleanData` — so no test
would catch a future regression where someone adds a user-derived value to
`commonProperties`. Worth a comment on the field at minimum.

## Test quality

Five clusters were proven decorative by mutating production source and re-running:

| Location | Weakness |
|---|---|
| `posthog.test.ts` abort test | Asserts only that `signal` is defined. Replacing the abort callback with a no-op leaves all tests passing — `REQUEST_TIMEOUT_MS` is unverified. |
| `posthog.test.ts` interval test | Asserts only that `fetch` was *not* called — equally true if the interval never fired. Gutting the interval callback leaves all tests passing. No positive periodic-flush test exists. |
| `tasksView.test.ts` funnel assertions | `startFlow`/`fingerprint` are mocked to constants, so correlating `take_completed` with a brand-new unrelated flow, hard-coding `duration_ms: 0`, and fingerprinting the wrong string all leave the suite green. |
| `notice.test.ts` | Never inspects the URI — pointing the notice at an arbitrary URL passes. `TELEMETRY_DOCS_URL` is asserted nowhere. |
| `extension.test.ts` rejection tests | Deleting the rejection handler leaves all tests green; detection is delegated to vitest's global reporter rather than asserted. |

Smaller: `failure_class` asserted only with `toBeDefined()` in one place while siblings assert
the class; `not.toBe("mysprint")` immediately after `toBe("invalid")` is unfalsifiable;
`identity.test.ts` re-asserts mock literals already covered two lines away. Also add the
committed tests for `identity.ts`'s sync-throw and rejected-promise salt paths, which exist
only as an ad-hoc review probe.

**The drift test's substring match is too loose.** `doc.includes(name)` matches inside the
heading anchor `#errors--operation_failed-and-unhandled_error`, so an event could be
"documented" by an incidental cross-reference alone. Anchor the match to a table row.

## Documentation and hygiene

- `notice.ts`, `README.md` and `package.json`'s setting description all say "file paths"
  absolutely; `docs/TELEMETRY.md` is the only surface that qualifies it (`stack_digest`
  contains the path-shaped `dist/extension.js`). One word each.
- The spec still says the facade wraps `createTelemetryLogger(sender, { additionalCommonProperties })`,
  which the fix wave's restructure invalidated, and still credits `onDidChangeEnableStates`
  where the code uses `env.onDidChangeTelemetryEnabled`.
- `src/tasksView.ts` and two of its tests point at `tasksView.ts:255`/`:257` for `onMessage`'s
  catch, which is now at `:330`.
- `events.ts`'s header says the no-excess-props guard "belongs on the sending facade a later
  task adds" — it exists now. `telemetry.ts`'s comment is silent about the `sendErrorData`
  path.
- `JIRA_WRITE_MESSAGES` is entirely inert: all four members already map to `"jira_write"` in
  `MESSAGE_OPS`, so the branch can never change their result. Keep it as future-proofing, but
  say so rather than implying necessity.
- `POSTHOG_HOST`, `PLACEHOLDER_KEY` and `TELEMETRY_DOCS_URL` are exported with no consumer
  outside their own module; could be module-private.

## Phase 2

The remaining 20 events, sketched at the end of
[the Phase 1 plan](2026-07-31-usage-analytics.md): batch launch, Explore, PR-address, the
review queue, the Deck, the Marketplace, the tasks view and its lenses, setup, and Doctor.
Two Phase 1 notes feed into it — `take_started.source: "batch"` is documented but unreachable
until `takeBatch` is instrumented, and `takeBatch`'s per-key failures are caught internally
so they never reach the dispatcher's `operation_failed`.
