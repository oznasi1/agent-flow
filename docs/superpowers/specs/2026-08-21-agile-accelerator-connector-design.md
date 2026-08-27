# Agile Accelerator (GUS) task connector — design

**Status:** approved design, not yet planned
**Date:** 2026-08-21
**Branch:** `worktree-gus-connector`
**Base:** `main` @ `2d86244` (0.33.2)

## 1. Purpose

Add a second task source to Agent Flow: Salesforce **Agile Accelerator**, the
AppExchange package that is the same code line as Salesforce's internal **GUS**
(Grand Unification System). One connector serves both — they differ only in the
namespace prefix on their objects.

This is the seam's first real second connector. `jira` has been the only
registered one since the seam was built.

### Why the connector is named for Agile Accelerator, not GUS

The user-facing ask was GUS. The connector id is `agileAccelerator` because:

- GUS is reachable only by Salesforce employees, on an internal org, behind SSO.
  **Nobody working on this repo can test against it.**
- Agile Accelerator is a free AppExchange managed package installable in any
  Salesforce org, including a free Developer Edition org. It is the same code
  line as GUS and exposes a subset of GUS's objects.
- So Agile Accelerator is the surface we can actually develop and test against,
  and it is also the larger potential audience for a public OSS extension.

A GUS user configures the same connector and points it at their instance.

`id` and `label` are **frozen on release** (CONNECTORS.md §6). They are
`agileAccelerator` and `"Agile Accelerator"`.

## 2. Scope

**v1 is read-only.** No write can reach a work item.

In scope: `list()`, `detail()`, `status()`, `me()`, the connector lifecycle,
Doctor probes, settings, the setup wizard, docs, tests.

Out of scope for v1, deliberately: status writes (`moveTo`), real assignment,
sprints, components, labels/provenance stamping, children/epics, size
estimates. Each is a `Capabilities` member we simply do not declare, which the
seam already degrades cleanly (CONNECTORS.md §3).

Rationale: the schema cannot be verified against real GUS from here, so v1
ships the smallest connector that proves the seam end to end and cannot corrupt
a record. Writes are a v2 decision for someone with real GUS access.

## 3. Transport: the `sf` CLI, for everything

Every read is a `sf` CLI invocation. There is no direct HTTP and **no stored
credential of any kind**.

- Data: `sf data query --query "<SOQL>" --json [--target-org <alias>]`
- Schema: `sf sobject describe --sobject <object> --json [--target-org <alias>]`
- Identity: `sf org display user --json [--target-org <alias>]`

An earlier design read an access token out of `sf org display --json` and then
spoke HTTPS directly. It was rejected: newer `sf` versions may redact the token
without `--verbose`, and that risk sits underneath every single call. Paying
process-spawn latency is preferable to a transport that might not work at all.

### Consequences that must be designed for, not discovered

Each spawn costs roughly 1–2 seconds. Two places feel it:

- **`list()` and `detail()`** are one spawn each, on an explicit user action
  (refresh, tab switch, opening a card). Acceptable.
- **`status(key)`** is polled by the Deck *per persisted run card*. One spawn
  per card per poll cycle is not acceptable.

`status()` therefore reads through a **connector-level** TTL memo (30s) that
batches misses into a single `WHERE Name IN (…)` query. It must live on the
connector, not the provider: `provider()` is rebuilt per operation by contract,
so a provider-level cache would never be hit.

`status()` returns `{status: null, category: null}` for anything it cannot
resolve. It must never throw — it runs behind an already-rendered card.

### The runner seam — and why it is not `Runner`

`cli.ts` is the only module in the connector that spawns a process.

It does **not** reuse the `Runner` type from `src/engine/pr/provider.ts`, and
that is a deliberate correction to an earlier version of this design.
`execRunner` rejects on a non-zero exit and attaches only `stderr` — it
**discards stdout**. But `sf --json` writes its error envelope to *stdout* and
still exits non-zero, so a `Runner`-based client would throw away the very
`name`/`message` it needs to classify the failure, and every `sf` error would
degrade to an uninformative exit code.

`cli.ts` therefore declares its own local runner type:

```ts
export interface SfResult { stdout: string; stderr: string; code: number }
export type SfRunner = (
  file: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<SfResult>;
```

The default implementation wraps `execFile` and **resolves** on a non-zero exit,
carrying stdout back so the envelope can be parsed. It rejects only when the
process could not be spawned at all.

Two things are still reused from the forge seam, because they are genuinely
shared concerns: `resolveBin("sf")` for locating the binary, and the
`code === "ENOENT"` ⇒ "not installed" / anything-else ⇒ "it ran and complained"
classification that `probeGh`/`probeGlab` already make.

`src/engine/pr/provider.ts` is **not modified**. Widening `execRunner` to carry
stdout would change a function every `gh` and `glab` call already runs through,
which is exactly the kind of shared-path edit this work is under instruction to
avoid.

Tests inject a fake `SfRunner` and never spawn a real process.

`child_process` must not appear anywhere in the connector except `cli.ts`.
`src/tasks/provider.ts` is contractually free of `vscode` and of dependencies
and is **not modified by this work**.

## 4. Schema discovery — the answer to "we cannot verify the schema"

The following object and field API names are **verified** from
[forcedotcom/git2gus](https://github.com/forcedotcom/git2gus), which is
Salesforce's own open-source GUS integration:

| Verified | Note |
|---|---|
| `ADM_Work__c` | the work item object |
| `Name` | the `W-234123` key |
| `agf__Subject__c` | title |
| `agf__Status__c` | status picklist |
| `agf__Assignee__c` | assignee lookup |
| `agf__External_ID__c`, `agf__Found_in_Build__c` | not used by v1 |
| `ADM_Epic__c`, `ADM_Build__c`, `ADM_Change_List__c` | not used by v1 |
| record types | User Story, Bug, Investigation |
| `agf__` prefix in the package; **bare in GUS** | git2gus carries a `getPrefix()` helper for exactly this |

Everything else this connector would like — priority, scrum team, product tag —
is **unverified**. That matters more than it sounds: a SOQL query naming a
field that does not exist fails **entirely** with `INVALID_FIELD`. An unverified
field name is a total-failure risk, not a graceful degradation.

Therefore the connector does not hardcode a field list. On first use it runs
**one** `sf sobject describe` and caches the result on the connector for the
session, then:

1. **Detects the namespace.** Describe `agf__ADM_Work__c`; if that fails, describe
   `ADM_Work__c`. The winner's prefix is used for every subsequent field name.
   If both fail, the connector reports a Doctor scope failure and lists nothing.
   Default assumption on an unreadable describe is `agf__`.
2. **Intersects wanted fields with existing fields.** The SELECT is built only
   from fields the describe confirmed. A field that is absent is simply not
   selected, and the `Task` member it would have filled takes a safe default
   (`priority: ""`, `components: []`, and so on).
3. **Resolves the team field by candidate list.** The scope filter needs a team
   field whose API name is unverified. The connector tries a documented ordered
   candidate list (`agf__Scrum_Team__c`, `agf__Team__c`, …) against the describe
   and uses the first that exists. If none exists, the team filter is dropped
   and `list()` falls back to an unbounded-but-capped query rather than failing.

This is why there is **no `namespacePrefix` setting**. The describe is required
regardless, and it can answer the namespace question itself. Not adding a
setting is the conservative choice: settings are frozen forever once released,
and an override can be added later purely additively if a real org ever needs
one.

## 5. Files

New directory `src/tasks/agileAccelerator/`:

| File | Responsibility | Pure? |
|---|---|---|
| `cli.ts` | The only spawner. `sf` invocations via its own `SfRunner` (§3), JSON envelope unwrapping, ENOENT classification. | no |
| `describe.ts` | Namespace detection, field intersection, team-field resolution. Takes a describe result as data. | yes |
| `soql.ts` | SOQL builder per lens. The analogue of `jql.ts`. | yes |
| `shape.ts` | Salesforce record → `Task` / `TaskDetail`, including status-category mapping. | yes |
| `provider.ts` | `TaskProvider`, read-only. | no |
| `connector.ts` | `TaskConnector`: settings, wizard, probes, `info()`, urls, the `status()` memo and the describe cache. | no |
| `errors.ts` | Salesforce error envelope → `TaskApiError` / `TaskAuthError`. | yes |

Four of seven modules are pure and exhaustively unit-testable without a
process, a network, or `vscode`.

## 6. Capabilities

```ts
readonly caps: Capabilities = {
  supportedFilters: ["mine", "unassigned", "all"],
  sizes: false,
  // labels, sprints, components, children: ABSENT, not false
};
```

- **Three lenses, not five.** `mine` and `unassigned` are cheap and bounded by
  team; `all` is the builder's fallback and renders no tab. `mysprint`,
  `sprint` and `backlog` are omitted because sprint modelling is the part most
  likely to be wrong un-verified. Omitted tabs simply never render.
- **`sizes: false`.** GUS estimates in story points; `Task.estimateSeconds` is
  rendered against a hardcoded 8-hour workday (`fmtEst` in
  `src/webview/helpers.ts`). Any points→seconds mapping would be a fiction, so
  every `Task.estimateSeconds` is `null` and the size control does not render.
- **No `refreshCaps()`.** Capabilities are static. CONNECTORS.md §3 says such a
  connector must omit it rather than implement a no-op.
- **`Task.inOpenSprint` is always `false`.** It is a required boolean with no
  honest "no sprint concept" value. Safe because every reader gates on
  `caps.sprints` first; the spec forbids reading meaning into it.

Read-only enforcement:

- `statusTargets()` returns `[]`. The seam treats zero targets as fully
  supported — `changeStatus` shows an info toast, not an error.
- `moveTo()` throws `TaskWriteError` with an empty `retryWith`, so the view
  reports the message and offers no retry.
- `assignToMe()` accepts the call and does nothing, exactly as the fixture
  connector does. There is no capability flag to opt out of it.

## 7. Status category mapping

`Task.statusCategory` is required and has no empty member, so the mapping must
be a total function over an open-ended picklist.

`shape.ts` holds one exported table mapping known `agf__Status__c` values to
`"new" | "indeterminate" | "done"`, seeded with the closed set git2gus itself
uses (`INTEGRATE`, `FIXED`, `CLOSED`) plus the obvious terminal values, and
matched case-insensitively.

**An unknown status maps to `"indeterminate"`, never `"done"`.** Only `"done"`
drives run retirement, so the conservative default cannot silently retire a
live run. This mirrors the reasoning already recorded on
`StatusTarget.toCategory`'s `""` member in `src/tasks/provider.ts`.

## 8. Identity

`me()` resolves via `sf org display user --json`, which yields both a username
and a user id, cached on the connector. If it yields a name but no usable id,
`me()` returns that name with `id: ""` — the seam explicitly supports this
("enough to display, not enough to write with"), and since v1 performs no
writes, nothing is lost. `me()` returns `null` only when identity cannot be
resolved at all, and never throws for an ordinary not-signed-in case.

`list("mine")` needs the id. When `id` is `""` the `mine` lens falls back to
matching the assignee's *name*, and if that is also unavailable it returns an
empty list rather than an unfiltered board.

## 9. Auth lifecycle

The connector owns no credentials. It reports on the CLI's state instead.

- `isAuthenticated()` — true when `sf org display user --json` succeeds.
- `signIn()` — the extension cannot own this flow. It shows an actionable
  message naming `sf org login web` and returns `false`. It does not spawn an
  interactive browser login on the user's behalf.
- `signOut()` — a no-op that points at `sf org logout`. It must not attempt to
  log the user out of an org other tooling on their machine depends on.

**Zero SecretStorage keys are added.** This is the single strongest guarantee in
this design that no existing user can be stranded: there is no key to rename and
no credential to lose.

## 10. URLs — the id-vs-key wrinkle

The user-facing key is `W-234123` (the `Name` field). The Lightning record URL
needs the 18-character `Id`:
`<instanceUrl>/lightning/r/ADM_Work__c/<Id>/view`.

`list()` and `detail()` select both `Id` and `Name`, so `Task.url` and
`TaskDetail.url` are always real record URLs for anything actually fetched.

- **`taskUrl(key)`** is synchronous and receives only the key, so it cannot look
  an `Id` up. It reads a connector-level `key→Id` memo populated by `list()` and
  `detail()`. On a hit it returns the record URL. **On a miss it returns
  `instanceUrl` itself** — the bare instance root.

  That is deliberately the dullest possible answer. A global-search deep link
  keyed on the `W-` number would be nicer, but its exact path is not something
  this work can verify against a real org, and a guessed URL shape that silently
  404s is worse than an honest landing page. Pinning that deep link is a v2
  item; the instance root is never wrong and never points at another record.
- **`keyFromUrl(url)`** returns `null` unless the URL literally contains a
  `W-\d+` token. Our own persisted URLs carry an `Id`, not a key, and
  CONNECTORS.md §4 is explicit: a connector whose URLs have no reliable marker
  must return `null` more often, never a guess, because a wrong non-null answer
  silently points a user at someone else's work item.

## 11. Settings, config, manifest

Three frozen settings under `agentFlow.agileAccelerator.*`:

| Setting | Required | Purpose |
|---|---|---|
| `instanceUrl` | yes | Lightning base URL, e.g. `https://gus.lightning.force.com`. Needed synchronously by `taskUrl()`, which is why it is a setting and not derived. |
| `team` | yes | The scope — the analogue of Jira's project key. Bounds every query. |
| `targetOrg` | no | `sf` org alias or username. Empty means use `sf`'s configured default org. |

`SourceInfo`: `label: "Agile Accelerator"`, `scopeNoun: "team"`,
`scopeValue: <team>`, `endpoint: <instanceUrl>`, `exampleKey: "W-1234567"`,
`endpointSetting: "agentFlow.agileAccelerator.instanceUrl"`,
`scopeSetting: "agentFlow.agileAccelerator.team"`.

`setupSteps = 3`. The wizard collects all three, titled
`` `Agent Flow Deck Setup (${from}/${total})` ``, and **collects without
writing** — `configure()` returns a commit thunk, per CONNECTORS.md §4. Writing
inside `configure()` would overwrite an already-configured user's settings when
a later wizard step is cancelled.

`isConfigured()` is synchronous, does no I/O, and trims before testing
truthiness, so a whitespace-only setting reads as unconfigured.

### Additive-only invariants

These are requirements on the implementation, not observations:

1. **`src/config.ts:628-629` is not touched.** `AgentFlowConfig.baseUrl` and
   `.project` are Jira's despite their generic names. New fields are added to
   `AgentFlowConfig` and populated in `getConfig()` alongside them.
2. **The manifest `default` stays `"jira"`.** New installs still get Jira.
   `registry.test.ts` already asserts this and must not be relaxed.
3. **The manifest enum is `["jira", "agileAccelerator"]` in that exact order.**
   `settingsSnapshot.test.ts:336` compares it to `CONNECTOR_IDS` — which is
   `Object.keys(CONNECTORS)` — with order-sensitive `toEqual`. An alphabetised
   enum fails CI.
4. **`enumDescriptions` gains exactly one entry**, keeping its length equal to
   `enum`'s.
5. **`docs/CONNECTORS.md` must contain `` `agileAccelerator` `` in backticks**,
   or `docs.test.ts:12` fails.
6. **No existing setting or SecretStorage key is read, written, or renamed.**
7. **`test/unit/compat.test.ts` is not edited.** It must pass byte-unchanged.

## 12. Errors

| Condition | Result |
|---|---|
| `sf` not installed (spawn `ENOENT`) | `probe()` reports an auth failure naming the CLI and its install URL. Never a crash. |
| `INVALID_SESSION_ID`, or `sf` reporting no authenticated org | `TaskAuthError` |
| `INVALID_FIELD` / `INVALID_TYPE` | `TaskApiError`, with the Salesforce `errorCode` and `fields` envelope preserved so a caller can react structurally rather than by matching prose |
| Any other non-success `sf` JSON | `TaskApiError` |
| Timeout / unreachable | `markTaskNetworkFailure(e, "ETIMEDOUT")`, keeping it an ordinary `Error` so views do not misclassify it as auth |
| Unresolvable key in `status()` | `{status: null, category: null}` — never a throw |
| Unresolvable key in `detail()` | throws; it is a foreground action the user just took |

`sf` writes errors as JSON to stdout with a non-zero exit. `cli.ts` must parse
the envelope before classifying, not match on the process's exit code alone.

### Doctor probes

- `auth: AuthProbe` — `{ok: true, displayName}` from the resolved identity, or
  `{ok: false, reason: "auth" | "network", message}`.
- `scope: ProjectProbe` — `{ok: true, name}` when the describe succeeds and the
  configured team resolves; `{ok: false, reason: "not-found"}` when the team
  does not exist (the user's mistake) and `"error"` for anything else (not the
  user's mistake). Classification happens in the connector, so no
  Salesforce-shaped error reaches `engine/doctor.ts`.

## 13. Telemetry and confidentiality

GUS content is Salesforce-confidential. Two requirements:

1. **No ticket content is telemetered.** This is already guaranteed
   structurally and does not need a new mechanism.
   `src/telemetry/events.ts` is the privacy guarantee: every string-typed event
   property is a literal union, so a plain `string` (a work item key, a subject,
   an assignee name) is rejected by the compiler wherever it flows into an
   event slot. The only opaque string properties are listed in
   `OPEN_STRING_PROPS`, and `test/unit/telemetry/events.test.ts` fails if that
   list grows.

   The requirements on this work are therefore narrow and checkable:
   - Add **no** new property to the event catalog and do **not** grow
     `OPEN_STRING_PROPS`.
   - If this connector ever constructs an event, construct it as an object
     literal at the call site. TypeScript's excess-property check does not fire
     once a literal has been bound to a variable or spread first, which is the
     one documented gap in the guarantee.
2. **The `jira_fetch` / `jira_write` wire names are left exactly as they are.**
   `src/tasksView.ts:116-129` maps message types to those names regardless of
   which connector is active, and `compat.test.ts` freezes the literals. So
   Agile Accelerator reads report as `jira_fetch`. This is a legacy label now
   meaning "task-source fetch", and it will be documented as such.

   Renaming them is forbidden by the compat test. Adding parallel generic names
   was considered and rejected: it means editing a hot path that every Jira user
   runs through, which is exactly the risk this work is under instruction to
   avoid. The cost is an inaccurate event *name*; the alternative risks the
   working Jira path.

`settingsSnapshot.ts:105` reports `task_source` through
`enumOrInvalid(cfg.taskSource, CONNECTOR_IDS)`, so registering the connector
automatically makes `agileAccelerator` a valid reported value instead of
`invalid`. No change is needed there.

## 14. Testing

`src/tasks/**` is **not** excluded from coverage thresholds. Thresholds are
enforced by `npm run test:cov`: **statements 90, branches 85, functions 85,
lines 90** (`vitest.config.ts:41`).

- `soql.ts`, `shape.ts`, `describe.ts`, `errors.ts` — pure, tested directly and
  exhaustively. This is where the bulk of coverage comes from.
- `cli.ts`, `provider.ts`, `connector.ts` — tested with an injected fake
  `SfRunner`. **No test spawns a real process or touches the network.**
- Fixtures are real `sf --json` envelope shapes, including its error envelope.
- Required behavioural tests: unknown status maps to `indeterminate`;
  `keyFromUrl` returns `null` for a foreign URL and for our own `Id`-shaped
  URL; the `status()` memo batches and expires; describe-driven field
  intersection omits an absent field instead of failing the query; namespace
  falls back from `agf__` to bare; the wizard writes nothing when cancelled at
  any step; no telemetry payload carries ticket content.

### Gates that must pass, restated

Stated here because an implementer follows this document, not `CONTRIBUTING.md`:

1. `npm run typecheck` — clean.
2. `npm test` — the full suite. Baseline on this branch is **122 files, 4523
   tests, 0 failures**. The suite takes ~130s+ and exceeds a 120s command
   timeout, so it must be run with a raised timeout and **never piped through
   `tail`**.
3. `npm run test:cov` — thresholds above.
4. `npm run build` — esbuild. This is the **only** gate that catches a
   `vscode`/`fs`/`child_process` dependency leaking somewhere it must not;
   `tsc` and the test suite both pass regardless.
5. `test/unit/compat.test.ts` passes **without being edited**.

`npm install` must not be run in this worktree. `node_modules` is symlinked from
the main checkout; a stray install rewrites `package-lock.json` `resolved` URLs
to a private registry and breaks public CI with `E401`. Verify with
`grep -c codeartifact package-lock.json` (must be `0`).

## 15. Risks

| Risk | Mitigation |
|---|---|
| Field API names beyond the git2gus-verified set are wrong | Describe-driven field intersection (§4). An absent field is not selected; it cannot fail the query. |
| The team field's API name is wrong | Ordered candidate list against the describe; drop the filter rather than fail (§4). |
| Namespace differs between GUS and the package | Detected, not configured (§4). |
| `sf` CLI absent or logged out | Classified and surfaced through Doctor; the board reports rather than crashing (§12). |
| Spawn latency degrades the Deck | Batched TTL memo on `status()` (§3). |
| **Never verified against real GUS** | Acknowledged and unmitigable from here. v1 is read-only precisely so the worst case is an empty or wrong-looking board, never a corrupted work item. Writes wait for someone with real GUS access. |
| Salesforce policy may not permit third-party tooling reading GUS | Out of our control. Noted so it is not discovered later; the connector is inert until a user configures it. |

## 16. Explicitly deferred

Sprint-shaped lenses and `caps.sprints`; `moveTo` and real assignment;
`caps.components` via product tags; `caps.children` via epics; provenance
labels; story-point sizing; a `namespacePrefix` override setting; the
`inferFromBranch` capability CONNECTORS.md §7 proposes — GUS branch conventions
are a real second case for it, but designing it needs a verified convention in
hand, which this work does not have.
