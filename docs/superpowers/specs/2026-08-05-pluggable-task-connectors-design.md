# Pluggable task connectors Design

**Status:** approved 2026-08-05
**Baseline:** `main` at `d9e36bd` (v0.4.2)

## Goal

Agent Flow gets its tickets from Jira, and Jira is wired through the whole
extension: `src/jira/` is imported directly by `tasksView.ts`, `deckView.ts`,
`doctorView.ts`, `setup.ts` and `extension.ts`; the board's task type is called
`JiraTask`; `engine/retire.ts` branches on `jiraCategory`; and
`types.ts`'s `ticketKeyFor` parses a Jira `/browse/` URL.

Put a seam in, so a contributor can add a second source — GitHub Projects,
GitHub Issues, Linear, an in-house tracker with an HTTP API — by writing one
directory and registering one line, without touching a view.

**Jira stays the default and the only shipped connector.** No second connector
ships here.

## Non-goals

- Shipping a second real connector.
- Changing anything an existing Jira user can observe. See
  [The frozen surface](#the-frozen-surface).
- A VS Code extension point letting *other extensions* register connectors.
  Nobody has asked; an in-repo registry is the right size.
- Generalizing `JiraAuth` into a cross-source auth abstraction. Auth is a
  per-connector concern and each connector owns its own.

## Decisions

| Question | Decision |
|---|---|
| How much of the surface does the seam cover? | Reads **and** writes. A connector must implement the core loop; everything Jira-idiosyncratic (sprints, components, labels, transition screen fields) is a **declared capability**. |
| How are optional capabilities declared? | As **objects, not booleans** — `caps.sprints?.add(...)`. "Supported" and "callable" become the same fact, so a view cannot check one flag and call a different method. |
| Do user-facing settings get renamed? | **No.** Settings are namespaced per connector: `agentFlow.jira.*` keeps its meaning, needs no migration, and a future connector adds `agentFlow.githubProjects.*`. One new neutral setting selects the source. |
| Do internal types get renamed? | Yes — `JiraTask` → `Task`, `JiraDetail` → `TaskDetail`, `jiraCategory` → `ticketCategory`. Invisible to users. |
| Is `Filter` renamed to `Lens`? | **No.** `Filter` is referenced by `OutboundMessage`, `App.tsx`, `agentFlow.defaultFilter` and `DEFAULT_FILTER_VALUES`. The type keeps its name; only parameters are named `lens` where it reads better. |
| How is the seam proven real? | A **second complete `TaskProvider`** backed by static fixtures, in the test suite, declaring **no** optional capabilities — so every view is forced to render a sprint-less, component-less, label-less source correctly or tests fail. Plus `docs/CONNECTORS.md`. |
| Does `addLabel` stay required? | **No** — it moved into `caps.labels`. One extra flag, and it is the honest answer for a tracker without labels; `stampLabelOnWrite` already has to degrade to a no-op there. |
| Do the shipped prompt defaults stop saying "Jira"? | **No.** Rewriting the seed prompt every uncustomized user's agent receives, for zero benefit while Jira is the only source, is a regression. A `{tracker}` placeholder is *added*; no shipped default uses it. |
| Do the `Sign in to Jira` command titles change? | **No.** `package.json` command titles cannot be dynamic, and degrading them to "Sign in to Task Source" is worse for 100% of current users. Known limitation, recorded below. |

## 1. The seam

### Layout

`src/jira/` moves to `src/tasks/jira/` — a pure move plus import updates. That
Jira is *one connector* is most of the point, and the directory name is where a
contributor looks first.

```
src/tasks/
  provider.ts      TaskProvider, TaskConnector, Capabilities, FieldPrompt, errors
  registry.ts      id → connector; resolves agentFlow.taskSource
  jira/
    connector.ts   TaskConnector (new)
    provider.ts    TaskProvider adapter over JiraClient (new)
    client.ts      moved, unchanged
    auth.ts        moved, unchanged
    jql.ts         moved, unchanged
    errors.ts      moved; JiraApiError now extends TaskApiError
    transitionFields.ts  moved; keeps the Jira→FieldPrompt classification
```

`JiraClient` is **not** made to implement `TaskProvider`. A thin
`JiraProvider` adapter wraps it, so `client.ts` stays the raw REST client and
`test/unit/tasks/jira/client.test.ts` keeps every assertion it has today. This
is what makes "behaviour-preserving by construction" a real claim rather than a
hope.

### Two interfaces, not one

`TaskConnector` is the lifecycle — configure, sign in, probe, build a provider.
`TaskProvider` is the per-operation surface. The split already exists
informally as `JiraAuth` + `JiraClient`; it just isn't named.

```ts
export interface TaskProvider {
  // required — the core loop
  list(lens: Filter, size: Size, max?: number): Promise<Task[]>;
  detail(key: string): Promise<TaskDetail>;
  status(key: string): Promise<{ status: string | null; category: string | null }>;
  statusTargets(key: string): Promise<StatusTarget[]>;
  moveTo(key: string, targetId: string, values: Record<string, string | string[]>): Promise<void>;
  assignToMe(key: string): Promise<void>;
  me(): Promise<{ id: string; displayName: string } | null>;

  readonly caps: Capabilities;
}

export interface Capabilities {
  /** Only these tabs render. */
  supportedFilters: readonly Filter[];
  /** The size control needs a per-task estimate; sources without one set false. */
  sizes: boolean;
  labels?: { add(key: string, label: string): Promise<void> };
  sprints?: {
    activeId(): Promise<string | null>;
    add(sprintId: string, key: string): Promise<void>;
    remove(key: string): Promise<void>;
  };
  components?: {
    list(): Promise<string[] | null>;
    update(key: string, delta: { add?: string[]; remove?: string[] }): Promise<void>;
  };
}
```

```ts
export interface TaskConnector {
  readonly id: string;      // the agentFlow.taskSource value, e.g. "jira"
  /** Every display fact a UI string needs, in one call rather than five
   *  accessors: label ("Jira"), scopeNoun ("project"), scopeValue ("ABC"),
   *  endpoint, exampleKey ("ABC-1234"), and the two setting ids Doctor names
   *  when endpoint/scope are empty. */
  info(): SourceInfo;

  isConfigured(): boolean;
  /** The connector's own wizard steps. `from`/`total` keep the "(2/4)" numbering. */
  configure(from: number, total: number): Promise<boolean>;
  /** How many steps `configure` will show, so setup.ts can compute `total`. */
  readonly setupSteps: number;

  isAuthenticated(): Promise<boolean>;
  signIn(): Promise<boolean>;
  signOut(): Promise<void>;

  /** Built from current settings, per operation — exactly like `client()` today. */
  provider(): TaskProvider;

  probe(): Promise<{ auth?: AuthProbe; scope?: ProjectProbe }>;
  taskUrl(key: string): string;
  /** Recover a task key from a persisted run url. See the frozen surface. */
  keyFromUrl(url: string): string | null;
}
```

`AuthProbe` and `ProjectProbe` are reused verbatim from `engine/doctor.ts` —
they are already source-agnostic (`{ok:true, displayName}` /
`{ok:false, reason:"auth"|"network", message}`). What moves into the connector
is only the *classification* of a raw error into them.

### `Task`

Identical in shape to today's `JiraTask`, with one narrowing:

```ts
export interface Task {
  key: string;
  summary: string;
  status: string;
  statusCategory: "new" | "indeterminate" | "done";  // was `string`
  priority: string;        // "" when the source has none
  assignee: string;        // display name, or "Unassigned"
  labels: string[];        // [] without caps.labels
  components: string[];    // [] without caps.components
  sprint: string | null;   // null without caps.sprints
  inOpenSprint: boolean;
  updated: string;         // ISO
  url: string;
  estimateSeconds: number | null;  // null without caps.sizes
  services?: string[];
}
```

`statusCategory` is narrowed because `engine/retire.ts:47` branches on
`=== "done"` to decide a run has landed. A connector author must not have to
reverse-engineer which three strings the board depends on.

### Status changes — the hard part

`changeStatus` at [`tasksView.ts:359-497`](../../../src/tasksView.ts) knows about
Jira transition ids, screen-field metadata, ADF-unfillable fields, error-string
parsing and the Resolution fallback. All of it moves behind the seam.

```ts
export interface StatusTarget {
  id: string;
  toName: string;
  toCategory: "new" | "indeterminate" | "done" | "";
  via?: string;           // Jira's transition name, when it differs from the target
  fields: FieldPrompt[];  // already normalized — no Jira metadata escapes
}

/** A refused write. `retryWith` is the connector saying "ask the user for these,
 *  then try again" — the only recovery the view knows how to perform. */
export class TaskWriteError extends Error {
  constructor(message: string, readonly retryWith: FieldPrompt[] = []) {
    super(message);
    this.name = "TaskWriteError";
  }
}
```

`FieldPrompt` is already source-agnostic (`pick` / `multipick` / `text` /
`number` / `date` / `datetime` / `labels`) and stays as it is. `toJiraValue`
moves inside the Jira connector, so the view hands back raw answers
(`string | string[]`) and never learns a wire format.

The view's flow becomes: `statusTargets` → QuickPick → prompt `target.fields`
→ `moveTo` → on `TaskWriteError` with a non-empty `retryWith`, prompt those and
`moveTo` once more → otherwise report. `promptableFields`, `missingFieldIds`,
`mentionsResolution` and `listResolutions` keep their current code, one layer
down. A connector with plain statuses returns `fields: []`, never throws
`retryWith`, and gets the whole interaction for free.

### Errors

```ts
export class TaskAuthError extends Error { /* this.name = "TaskAuthError" */ }
export class TaskApiError extends Error { /* status, fieldErrors, messages */ }
export function markTaskNetworkFailure(e: Error, code: "ETIMEDOUT" | "ENOTFOUND"): Error;
export function isTaskNetworkError(e: unknown): boolean;
```

`JiraAuthError extends TaskAuthError`, `JiraApiError extends TaskApiError`.
Every subclass keeps setting `this.name` to a **string literal**, for the
esbuild-minification reason documented at `src/jira/client.ts:9-17`: the build
runs `minify: true` without `keepNames`, so a class identifier is not a stable
runtime value. `telemetry/events.ts:50`'s `classifyFailure` switches its check
from `"JiraAuthError"` to `"TaskAuthError"`. The `failure_class` values it
emits (`"auth"`, …) do not change, so no telemetry series breaks.

## 2. The frozen surface

**The guarantee: an existing Jira install upgrades and notices nothing.** No
re-sign-in, no wizard, no settings migration, no lost board.

Every row below was verified against `d9e36bd`, not recalled.

| What | Frozen value | What breaks if touched |
|---|---|---|
| SecretStorage | `agentFlow.jira.email`, `agentFlow.jira.token` (`jira/auth.ts:16-17`) | **Sharpest risk.** Rename either and every user is silently signed out and re-prompted for an API token. Stay verbatim inside the Jira connector. |
| Settings | `agentFlow.jira.baseUrl`, `agentFlow.jira.project` | Owned by the Jira connector. No deprecation, no fallback reads, no migration code. |
| globalState | `agentFlow.setupComplete` (`setup.ts:5`) | The first-run wizard re-offers itself to everyone. |
| workspaceState | `agentFlow.sprintOrder` (`tasksView.ts:32`) | Drag-and-drop sprint order is lost. |
| Runs store | `Run` schema, runs dir, `isTicketRun` | The Deck's board is rebuilt from these on every launch. |
| **Run url parsing** | `ticketKeyFor`'s `/browse/` marker (`types.ts:118-129`) | See below. |
| Command ids | `agentFlow.refresh`, `setup`, `doctor`, `signIn`, `signOut`, `takeTask`, `openDeck`, `openMarketplace` | Keybindings and any user's own `tasks.json`. |
| Prompt defaults | Every `DEFAULT_*_PROMPT` in `config.ts`, byte-identical, incl. the "Jira {key}" wording | Changes the seed prompt every uncustomized user's agent receives. |
| Setting key | `agentFlow.explorePrompts.jiraTicket` | Renaming discards anyone's customization of it. |
| New setting | `agentFlow.taskSource`, default `"jira"` | A user who never opens settings must resolve to Jira on the default alone. |
| Telemetry wire values | `Op` members `"jira_fetch"` / `"jira_write"` / `"jira_auth"` (`events.ts:60`) | **Transmitted.** Renaming breaks the `operation_failed` analytics series. The surrounding code goes generic; these strings do not. |
| Telemetry wire value | the `extension_activated` property `has_jira_auth` (`events.ts:161`) | **Transmitted.** Same reason. Sourced from `connector.isAuthenticated()`, name unchanged. |

### The run-url landmine

`types.ts:118-129` is a **hardcoded Jira URL shape inside a reader of
already-persisted data**:

```ts
const marker = "/browse/";
const i = url.indexOf(marker);
return i >= 0 ? url.slice(i + marker.length) : run.key;
```

Every run record on an existing user's disk holds
`https://<site>.atlassian.net/browse/ABC-123`. So this logic must keep parsing
those verbatim, *and* stop being the mechanism a new connector relies on.
`ticketKeyFor(run)` becomes `ticketKeyFor(run, connector)` delegating to
`connector.keyFromUrl(url) ?? run.key`; the Jira connector keeps the `/browse/`
code character-for-character.

### The contributor trap

`telemetry/settingsSnapshot.ts:38-43` holds hand-written enum allowlists and
collapses anything unrecognized to the `"invalid"` sentinel. Adding
`taskSource` to the snapshot with a literal list means **every contributor's
connector reports as `"invalid"` forever, silently**. So the allowlist is
derived from the registry:

Note the trap has two directions, and an existing test only guards one of them.
`settingsSnapshot.ts:31-37` documents a **manifest-parity test** already in
`test/unit/telemetry/settingsSnapshot.test.ts` that asserts each hand-written
list matches its `package.json` `enum` — so a manifest enum that grows without
updating this file is already caught. What is *not* caught is the reverse: a
contributor registering a connector in `CONNECTORS` and forgetting the manifest
`enum`, which leaves the setting un-pickable in the settings UI while the
registry happily accepts it. Deriving from the registry and asserting
`package.json`'s `enum` equals `CONNECTOR_IDS` closes both directions.

```ts
// registry.ts
export const CONNECTOR_IDS = Object.keys(CONNECTORS);
// settingsSnapshot.ts
task_source: enumOrInvalid(cfg.taskSource, CONNECTOR_IDS),
```

The same applies to `DEFAULT_FILTER_VALUES` if a connector ever adds a filter id.

### How this is verified, not asserted

1. A characterization test pinning the exact secret keys, setting ids,
   globalState/workspaceState keys and `/browse/` parsing the Jira connector
   depends on. A future refactor that changes one fails a test instead of
   signing everybody out.
2. `registry.ts` resolves an unknown or absent `taskSource` to Jira and logs
   it — never an empty board.
3. Because Jira implements *every* capability, the refactor is
   behaviour-preserving by construction. The existing `test/unit/jira/*` and
   `test/unit/tasksView.test.ts` suites move but keep their assertions. **Any
   assertion that has to be weakened to make the suite green is a real
   regression, not a test needing an update.**
4. Manual check before merge: upgrade in place on a configured install, confirm
   the board loads with no prompt and no re-sign-in.

Deliberately unprotected: someone who hand-writes
`agentFlow.taskSource: "githubProjects"` before that connector exists gets Jira
and a log line.

## 3. Consumer-by-consumer

**`src/tasksView.ts`** — the bulk of the work.
- `client()` → `this.connector.provider()`.
- `changeStatus` becomes the generic four-step flow above; loses ~80 lines of
  Jira knowledge and its `toJiraValue` / `promptableFields` imports.
- Take, Add to sprint, Remove from sprint → guarded by `caps.sprints?`.
- Component two-way sync → guarded by `caps.components?`.
- Provenance label stamping → guarded by `caps.labels?`.
- `resolveOp` / the `catch` in `onMessage` → `TaskAuthError`, `TaskApiError`,
  `isTaskNetworkError`.
- `reportWriteFailure`'s toast action label `"Open in Jira"` →
  `` `Open in ${connector.label}` ``, url from `connector.taskUrl(key)`.
- `postState` gains `sourceLabel` and the serialized `caps` (below).
- `guessServices` and `reposForTask` are untouched — they already operate on
  the task/detail shape, not on Jira.

**`src/deckView.ts`** — `client().getStatus(key)` → `provider().status(key)`;
`JiraAuthError` → `TaskAuthError`; `ticketKeyFor` gains the connector argument.

**`src/doctorView.ts`** — the `probeMyself` / `getProject` deps collapse into
one `probe()` dep. `DoctorConfig.baseUrl`/`project` become
`endpoint`/`scope`, plus `sourceLabel` and `scopeNoun` for row labels. The
Jira-specific classification (`JiraAuthError` → `"auth"`, `JiraApiError` 404 →
`"not-found"`) moves into the Jira connector's `probe()`. `engine/doctor.ts`'s
pure classification is otherwise unchanged, and its row labels take the label
and noun so a Jira user still reads "Jira project".

**`src/setup.ts`** — `runSetup` computes
`total = connector.setupSteps + 1` (the `+1` being `reposRoot`, which is Agent
Flow's own, not the connector's), calls `connector.configure(1, total)`, keeps
its `reposRoot` step, then `connector.signIn()`. `maybeRunSetup`'s inline
`baseUrl && project` check → `connector.isConfigured()`. Its five hardcoded
"Jira" strings come from `connector.label` — identical rendered text for Jira.

**`src/extension.ts`** — `new ApiTokenAuth(context.secrets)` →
`resolveConnector(context, log)`; sign-in/out toasts and the
`"Take a Jira task"` QuickPick title read `connector.label`.

**`src/engine/status.ts`, `src/engine/retire.ts`** — field renames only:
`jira` → `ticket`, `jiraCategory` → `ticketCategory`, `jiraStatus` →
`ticketStatus`. `retire.ts:47`'s `=== "done"` comparison is unchanged.

**`src/types.ts`** — `JiraTask` → `Task`; `JiraDetail` → `TaskDetail`;
`ticketKeyFor` takes the connector. `OutboundMessage`:
- `state` gains `sourceLabel: string` and `caps: SerializedCaps`.
- `tasks` carries `Task[]`.
- `detail`'s `jiraComponents` → `sourceComponents`.

Capabilities cross the webview boundary as JSON, so the wire form is flat
booleans — the capability *objects* cannot be serialized:

```ts
export interface SerializedCaps {
  supportedFilters: Filter[];
  sizes: boolean;
  labels: boolean;
  sprints: boolean;
  components: boolean;
}
```

**`src/webview/App.tsx`** — the six gate/chip strings
(`Connecting to Jira…`, `isn't connected to Jira yet`, the `Sign in to Jira`
button, `Open in Jira`, `` Not on ${key} in Jira ``) read `sourceLabel`. The
tab bar renders only `caps.supportedFilters`; the size control hides unless
`caps.sizes`; sprint actions hide unless `caps.sprints`; component chips hide
unless `caps.components`. `TaskDetailState.jira?: string[]` →
`sourceComponents?: string[]`.

**`src/webview/helpers.ts`** — `JiraTask` → `Task`. The `h / 8 // Jira workday`
divisor at line 7 stays: it is an assumption every connector inherits when it
reports `estimateSeconds`, and `CONNECTORS.md` says so.

## 4. Registry, config, fixture, docs

### Registry

```ts
// src/tasks/registry.ts
const CONNECTORS: Record<string, (ctx: vscode.ExtensionContext) => TaskConnector> = {
  jira: makeJiraConnector,
};

export const CONNECTOR_IDS = Object.keys(CONNECTORS);

export function resolveConnector(ctx: vscode.ExtensionContext, log: Log): TaskConnector {
  const id = getConfig().taskSource;
  // `Object.hasOwn`, not `CONNECTORS[id]` — `taskSource` comes from settings.json
  // and can be any string, including a prototype key like "constructor", which a
  // bare index would resolve to a truthy non-connector. Same reason as
  // `review/provider.ts:112`.
  if (!Object.hasOwn(CONNECTORS, id)) {
    log(`taskSource "${id}" is not a known connector — falling back to jira`);
    return CONNECTORS.jira(ctx);
  }
  return CONNECTORS[id](ctx);
}
```

### Config

`agentFlow.taskSource`, `type: "string"`, `enum: ["jira"]`,
`enumDescriptions: ["Atlassian Jira Cloud"]`, `default: "jira"`. Added to
`AgentFlowConfig` and `getConfig()`. Adding a connector means adding its id to
this `enum` — which `CONNECTORS.md` lists as a checklist step, because a
missing entry makes the setting un-pickable in the settings UI even though the
registry would accept it.

### The fixture connector

`test/_helpers/fixtureConnector.ts` — a second complete `TaskProvider` and
`TaskConnector` over static fixtures, deliberately declaring the **minimum**:

```ts
caps: {
  supportedFilters: ["mine", "all"],   // no sprint/backlog lenses
  sizes: false,                        // no estimates
  // labels, sprints, components all absent
}
```

It exists to make capability-gating load-bearing. New tests drive `tasksView`
and the `App` webview with it and assert: only two tabs render; no size
control; no sprint actions; no component chips; `stampLabelOnWrite: true` is a
silent no-op rather than a crash; a `moveTo` with `fields: []` completes with
no prompts.

Without this, nothing mechanically stops the next view from reaching past the
interface into Jira specifics.

### Docs

`docs/CONNECTORS.md` — the contributor guide:
1. What `TaskProvider` and `TaskConnector` require, method by method.
2. The capability table: what each unlocks in the UI, and what degrades
   gracefully when it is absent.
3. The checklist: implement both interfaces → register in `registry.ts` → add
   your settings to `package.json` → add your id to the `taskSource` enum →
   add tests → note the `estimateSeconds` 8-hour-workday assumption.
4. The compatibility rules: own your own settings namespace
   (`agentFlow.<id>.*`), own your own SecretStorage keys, and never rename
   either once released.
5. A worked walkthrough of the fixture connector as the minimal example.

`CONTRIBUTING.md` gains a pointer to it under **Conventions**, beside the
existing "No hardcoded organization values" rule.

## 5. Gates

Every one of these must pass; they are the repo's CI bar, restated here so the
implementation is not written against `CONTRIBUTING.md` from memory.

- `npm run typecheck` — clean (`tsc --noEmit`).
- `npm test` — the full Vitest unit + webview suite.
- `npm run test:cov` — V8 coverage thresholds enforced: **statements 90,
  branches 85, functions 85, lines 90** (`vitest.config.ts`). Note
  `src/types.ts` is coverage-excluded, so type-only moves there earn nothing;
  the new `src/tasks/**` is **not** excluded and must carry real tests.
- `npm run build` — esbuild bundles host + both webviews.
- A `## [Unreleased]` entry in `CHANGELOG.md`. This is user-facing (a new
  setting) even though nothing else visibly changes.
- `vscode` is mocked at `test/_mocks/vscode.ts`; no test may touch a real Jira
  site, filesystem or `gh` binary.
- No hardcoded organization values — the existing convention. Every connector's
  own config goes in `agentFlow.<id>.*` and is read through `getConfig()`.

Test files move with their subjects: `test/unit/jira/*` →
`test/unit/tasks/jira/*`.

## 6. Sequencing: the Orchestrator collision

`docs/superpowers/specs/2026-08-05-deck-orchestrator-flows-design.md` (approved
the same day, not yet built) adds **two new Jira consumers**:

- flow nodes may be "untaken Jira tickets, added from a picker in the drawer";
- **"Jira status" is one of its four condition families**, and every condition
  "reads the snapshot `buildRunStatus` already builds" — i.e. exactly the
  `jiraCategory` / `jiraStatus` fields this design renames.

**Recommendation: land this seam first.** Then the Orchestrator is written
against `TaskProvider` from day one, its picker becomes "untaken tickets" via
`provider.list()`, and its condition family is "ticket status" rather than a
second hardcoded Jira dependency. The reverse order means writing Jira
coupling that this design then has to unpick, and it grows both changes.

If the Orchestrator must go first, the minimum is to land this design's
`types.ts` / `engine/status.ts` / `engine/retire.ts` renames ahead of it, so
the Orchestrator's condition code is written against `ticketStatus`.

## 7. Out of scope

- **No second shipped connector.** GitHub Issues would be the cheapest one (the
  `gh` runner infra already exists at `engine/pr/which.ts` and `execRunner`) and
  is a genuine stress test for the capability model, but it is a real feature
  with a real support surface that nobody has asked for yet.
- **Prompt wording.** `{tracker}` is added as an available placeholder resolving
  to `connector.label`; no shipped default uses it. Rewriting the defaults is
  connector #2's job, with a real second case to write for.
- **Command titles.** `Sign in to Jira` / `Sign out of Jira` stay literal;
  `package.json` titles cannot be templated. The honest fix is per-connector
  command entries with `when` clauses, which is premature at one connector.
- **`agentFlow.explorePrompts.jiraTicket`** keeps its setting key.
- **Cross-connector boards.** One `taskSource` at a time. Merging two sources
  into one pool is a different feature.
