# Adding a task source

Agent Flow reads and writes tickets through a seam, not a hardwired dependency
on Jira. This guide is for whoever writes connector #2: what the seam
requires, what degrades gracefully when a source can't answer something, and
the handful of places where the seam doesn't reach yet — so you find those on
this page instead of in a bug report.

This guide is meant to be true, not encouraging. Where something is broken,
Jira-only, or just awkward, it says so.

## 1. What a connector is

A task source plugs in as two interfaces, both declared in
[`src/tasks/provider.ts`](../src/tasks/provider.ts):

- **`TaskConnector`** — the lifecycle. Configure, sign in, probe, describe,
  and hand out a `TaskProvider`. One instance lives for the life of the
  extension.
- **`TaskProvider`** — the per-operation surface. List tasks, fetch detail,
  read status, change status, assign, resolve identity. Built fresh per
  operation (`connector.provider()`), exactly like the pre-seam `client()`
  did.

`agentFlow.taskSource` selects which connector is active, by id. **`jira` is
the shipped default and, as of this writing, the only registered connector.**
`src/tasks/registry.ts`'s `CONNECTORS` map is the full list; `CONNECTOR_IDS`
(`Object.keys(CONNECTORS)`) is exported so the manifest, the telemetry
allowlist, and this file's own test all derive from the registry instead of a
second hand-written list that can drift from it.

## 2. `TaskProvider`, method by method

```ts
export interface TaskProvider {
  list(lens: Filter, size: Size, max?: number): Promise<Task[]>;
  detail(key: string): Promise<TaskDetail>;
  status(key: string): Promise<{ status: string | null; category: string | null }>;
  statusTargets(key: string): Promise<StatusTarget[]>;
  moveTo(key: string, targetId: string, values: Record<string, string | string[]>): Promise<void>;
  assignToMe(key: string, meId?: string): Promise<void>;
  me(): Promise<{ id: string; displayName: string } | null>;
  readonly caps: Capabilities;
}
```

- **`list(lens, size, max?)`** — the task pool for one filter tab. Called by
  `TasksViewProvider`'s `fetch` handler on refresh and on every tab switch.
  `lens` is always one your connector declared in `caps.supportedFilters` by
  the time it reaches here — `TasksViewProvider` clamps an unsupported or
  stale lens through `effectiveFilter(filter, caps.supportedFilters)` before
  calling `list` at all, so you never have to answer for a filter you didn't
  advertise.

- **`detail(key)`** — the expanded view for one task: description, labels,
  components, url, status. Called when a card is opened in the task pool.
  Returns `TaskDetail` (declared in `src/tasks/jira/client.ts` today, not
  `src/types.ts` — re-exported through `provider.ts` so a connector never
  needs to import anything under `src/tasks/jira/`). If the key can't be
  resolved at all (deleted, unreachable), throwing is the right answer here —
  unlike `status()` below, this is a foreground request the user just made by
  opening a card, and the host's generic error handling already turns a
  thrown `TaskApiError`/`TaskAuthError`/network error into a toast.

- **`status(key)`** — a cheap status readback for a persisted run, polled by
  the Deck to keep a run card's ticket state current. If the key is one your
  source can't resolve — deleted, moved, never existed — return
  `{ status: null, category: null }` rather than throwing: this is a
  background poll behind an already-rendered card, and a thrown error there
  is a worse failure mode than "unknown."

- **`statusTargets(key)`** — where a task can move to next, normalized to
  `StatusTarget[]`. Called before the "change status" QuickPick is shown.
  Every `fields` entry is already reduced to the generic prompt vocabulary
  (`pick` / `multipick` / `text` / `number` / `date` / `datetime` / `labels` —
  `FieldPrompt`, declared with its input validation in
  [`src/tasks/fields.ts`](../src/tasks/fields.ts) and re-exported by
  `provider.ts`) — no source-specific metadata escapes this method. A source with plain,
  unconditional statuses (open/in-progress/done, no screen fields) returns
  `fields: []` on every target — see the fixture connector — and gets the
  whole QuickPick-and-write interaction for free. A task with genuinely
  nowhere to go returns an **empty array** — `changeStatus` in
  `src/tasksView.ts` treats zero targets as a fully supported answer (an info
  toast, "No status transitions available for {key}", not an error).

- **`moveTo(key, targetId, values)`** — perform the move. `values` are raw
  answers to the `fields` you asked for; map them to your own wire shape
  yourself (the view never learns it). On a refusal, throw `TaskWriteError`
  with `retryWith` set to the fields worth re-prompting for — empty means
  there's nothing left to try, and the view just reports the message.

- **`assignToMe(key, meId?)`** — assign the task to the signed-in user.
  `meId` is an `id` a caller may have already resolved via `me()`, passed in
  to save a second identity round-trip and to stop a caller that pairs this
  with another write (e.g. add-to-sprint) from having the second lookup
  disagree with the first mid-operation. If your source has no real
  assignment concept, accept the call and do nothing — see the fixture
  connector's `assignToMe`. There's no capability flag to opt out of this
  one; it's part of the core loop every connector implements.

- **`me()`** — the signed-in identity, or `null` when it can't be resolved.
  Callers treat `null` as "unknown" rather than a failure: `postInitialState`
  swallows it and skips the display-name update (best-effort — the task list
  is the real payload), while a write path that needs an id reports
  `"Couldn't resolve your {label} account."` and stops. Don't throw here for
  an ordinary "not signed in" case; that's what `null` is for.

  **`id` may be `""`** when your source can name the user but has no stable
  identifier for them — enough to display, not enough to write with. Answer
  with the name in that case rather than `null`: the name alone drives the
  panel's header chip and every "is this task mine?" affordance in the card
  list. Callers that pair this with a write check `id`, not just non-`null`
  (see `addToMySprint` in `src/tasksView.ts`), so the half-done write that
  would otherwise imply is already ruled out.

- **`caps`** — see the capability table below.

## 3. The capability table

`caps` is read-only and its optional members are objects, not booleans — a
capability's presence and its callable shape are the same fact, so nothing
downstream can check one flag and reach for a differently-named method.

| Capability | Unlocks | Degrades to, when absent |
|---|---|---|
| `supportedFilters` | Which of the task-pool's five tab-bar lenses (`mysprint`, `mine`, `sprint`, `backlog`, `unassigned`) render at all, via `visibleFilters()` in `src/webview/helpers.ts`. **May change after `refreshCaps()`** — the Jira connector drops the three sprint-shaped lenses once it learns the project has no Scrum board. | Any tab you don't list simply never renders — no error, no disabled state. **This says which of the UI's five existing tabs you can answer, not which tabs exist.** `"all"` is a real `Filter` value (the JQL builder's fallback, and Jira declares it in `supportedFilters`) but no UI has ever shown it as a sixth tab — returning it does not add one. |
| `sizes` | The size-filter control (`XS`/`S`/`M`/`L` chips) above the task list. | The control doesn't render at all (`caps.sizes && filters.size && …` in `App.tsx`). Every `Task.estimateSeconds` should be `null` if you don't set `sizes: true` — there's nothing to size by. |
| `sprints` | The "add to my sprint" action, the "My sprint" tab's drag-to-reorder, and the "remove from sprint" (with Undo) action on a card. | All three disappear from the UI (`caps.sprints` gates each). Calling any of `TasksViewProvider`'s sprint handlers directly (e.g. from the command palette after a stale webview render) reports `"{label} doesn't have sprints."` rather than throwing — see `sprints()` in `src/tasksView.ts`. |
| `components` | The component-derived state on each repo chip in a task's detail panel — on-the-ticket (solid) vs. not (dashed, with a `↑` that pushes it) — and the two-way sync behind it. | The repo selection itself still renders, and is still editable: which repos a task touches is what `take` sends as `services`, and it is inferred from summary, description and labels as much as from components. Only the three-state classification goes: every chip renders plain, with no dash, no `↑`, and no title — there is nothing about the ticket to claim (`componentsSupported={caps.components}` in `App.tsx`; the same plain rendering also covers a components-having source whose list couldn't be read). |
| `refreshCaps?()` | Not a `caps` member but the thing that can change one: a source that must ask its own server what it can do. The Jira connector reads the project's boards and, when there is no Scrum board, drops `mysprint`/`sprint`/`backlog` and `sprints`. The host calls it once per panel init, alongside the first `list()`, and posts a `caps` message with the result. | Nothing is called and nothing is posted; the `caps` in the initial `state` message are final. A connector whose capabilities are static (the fixture connector) should **omit** it rather than implement a no-op. |
| `labels` | Provenance stamping — writing `agentFlow.provenanceLabel` onto a task after Agent Flow acts on it, when `agentFlow.stampLabelOnWrite` is on. | **A silent no-op**, not an error and not a toast: `stampProvenance()` in `src/tasksView.ts` returns immediately if `caps.labels` is absent. The write that mattered (the status change, the assignment) already succeeded; failing the whole operation over a label a source doesn't have would be the wrong trade. If you don't have labels, you don't need to do anything to make this safe — just don't declare the capability. |

One more field degrades the same way but isn't a `caps` entry:
**`Task.inOpenSprint` is a required `boolean`, with no honest "no sprint
concept" value.** A source with no sprints at all still has to report
`false` for every task, which overloads "not in the active sprint" with "this
source doesn't have sprints." It's harmless in practice only because every
place that reads `inOpenSprint` gates on `caps.sprints` first — the
"add to my sprint" affordance, for instance, checks
`caps.sprints && (unassigned || (isMe && !task.inOpenSprint))` in `App.tsx`,
never `inOpenSprint` alone. **Do not read meaning into `inOpenSprint` if you
don't declare `caps.sprints`** — just set it to `false` and move on.

## 4. `TaskConnector`, method by method

```ts
export interface TaskConnector {
  readonly id: string;
  info(): SourceInfo;
  isConfigured(): boolean;
  configure(from: number, total: number): Promise<(() => Promise<void>) | null>;
  readonly setupSteps: number;
  isAuthenticated(): Promise<boolean>;
  signIn(): Promise<boolean>;
  signOut(): Promise<void>;
  provider(): TaskProvider;
  probe(): Promise<{ auth?: AuthProbe; scope?: ProjectProbe }>;
  taskUrl(key: string): string;
  keyFromUrl(url: string): string | null;
}
```

- **`id`** — the `agentFlow.taskSource` value that selects this connector,
  e.g. `"jira"`. Must match the registry key in `src/tasks/registry.ts` and
  an entry in the manifest `enum` (§5).

- **`info(): SourceInfo`** — one call that answers every user-facing string
  a view needs, rather than five separate accessors:

  ```ts
  export interface SourceInfo {
    label: string;          // "Jira" — every "Sign in to X" / "Open in X" string
    scopeNoun: string;      // "project" — Doctor's row labels
    scopeValue: string;     // "ABC" — empty when unconfigured
    endpoint: string;       // the site URL — empty when unconfigured
    exampleKey: string;     // "ABC-1234" — placeholder text
    endpointSetting: string; // setting id Doctor names when endpoint is empty
    scopeSetting: string;    // setting id Doctor names when scope is empty
  }
  ```

  **`info()` feeds every user-facing string in the extension that used to say
  "Jira" literally** — the gate screens' "Connecting to {label}…", the sign-in
  button, the toast on a failed write, the setup wizard's prompts, Doctor's
  row labels. Get this right and the rest of the UI reads correctly with zero
  further work.

- **`isConfigured()`** — synchronous, no I/O. Whether your own settings are
  filled in. Trim before checking truthiness: a whitespace-only setting value
  should read as unconfigured, not as configured-but-broken.

- **`configure(from, total)`** — run your own settings wizard steps (input
  boxes, `showQuickPick`, whatever you need) and **collect, don't write**.
  `from`/`total` are the wizard's shared step counter — title your boxes
  `` `Agent Flow Deck Setup (${from}/${total})` `` so a multi-step connector
  numbers correctly alongside Agent Flow's own `reposRoot` step, which always
  comes last. Return `null` if the user cancels partway; `setup.ts` treats that
  as an abort, leaving first-run setup un-marked-complete so it offers itself
  again next launch.

  Otherwise return a **commit thunk**: an `async () => { … }` that performs the
  writes to `agentFlow.<id>.*` (global scope). `setup.ts` invokes it in a single
  block after its own last cancellable step, alongside `reposRoot` /
  `workspaceDir`. **Do not write inside `configure()` itself.** The wizard is
  re-runnable from the command palette by an already-configured user, and its
  promise is that cancelling leaves their configuration untouched — a connector
  that writes as it collects would overwrite their endpoint and scope, with no
  undo and no toast, whenever a later step is cancelled. `test/unit/compat.test.ts`
  asserts zero setting writes for a cancel at the last step, driving the real
  Jira connector.

- **`setupSteps`** — how many boxes `configure` shows, so `setup.ts` can
  compute `total = connector.setupSteps + 1` (the `+1` is Agent Flow's own
  `reposRoot` step, not yours).

- **`isAuthenticated()` / `signIn()` / `signOut()`** — your own credential
  lifecycle, stored however you like (SecretStorage is the expected place —
  see the compatibility rules below).

- **`provider()`** — build a `TaskProvider` from current settings, fresh per
  call. This mirrors the pre-seam `client()` pattern deliberately: settings
  can change between operations (a user editing `settings.json` mid-session),
  and a long-lived provider would go stale.

- **`probe()`** — Doctor's connectivity check, already classified into
  `AuthProbe` / `ProjectProbe` (both defined in `src/engine/doctor.ts`, which
  has no imports of its own, so importing its types here can't create a
  cycle). Leave a member `undefined` when you deliberately didn't run that
  probe — Doctor renders that as `skip`, not as a silent pass. Do the
  classification of a raw error into `{ok:false, reason, message}` here, once,
  rather than leaking your own error types into `engine/doctor.ts`.

- **`taskUrl(key)`** — a link to the task in your source's own UI, for "Open
  in {label}" actions.

- **`keyFromUrl(url)`** — the inverse: recover a task key from a url on an
  **already-persisted** run record on disk. **Must return `null` for a url
  that doesn't belong to your source**, never a guess — the caller
  (`ticketKeyFor` in `src/types.ts`) falls back to the run's own stored key
  when you return `null`, and a wrong non-null guess would silently point a
  user at someone else's task. The Jira connector's implementation matches
  the literal `/browse/` marker every already-persisted Jira run url
  contains; a connector whose urls have no equally reliable marker should
  return `null` more often, not invent one.

## 5. The checklist

1. Implement `TaskProvider` and `TaskConnector` for your source.
2. Put both under their own directory: `src/tasks/<id>/`.
3. Register one line in `src/tasks/registry.ts`'s `CONNECTORS` map:
   `<id>: makeYourConnector`.
4. Add your own settings under `agentFlow.<id>.*` in `package.json` — but
   that alone does not make them reach your connector. There is no
   per-connector settings bag: `AgentFlowConfig` (`src/config.ts:190-195`) is
   one flat interface shared by every connector, and `getConfig()` populates
   it by hand, field by field (e.g. `config.ts:389-390`:
   `baseUrl: c.get<string>("jira.baseUrl")…`, `project: c.get<string>("jira.project")…`).
   You must add your own fields to `AgentFlowConfig` **and** wire them up
   inside `getConfig()`'s return object yourself — this is an edit to a
   shared file, not something registering your connector gets you for free.
   **Naming trap:** `AgentFlowConfig.baseUrl` and `.project` read like
   generic per-connector fields but are **Jira's**, not a shape every
   connector fills in. Don't reach for them from view code — the
   source-agnostic equivalents are `SourceInfo.endpoint` and `.scopeValue`,
   which every connector computes in its own `info()` (see §4). Read your
   own settings through whatever fields you add to `AgentFlowConfig`, never
   by inlining a setting id (see the compatibility rules, and
   `CONTRIBUTING.md`'s "No hardcoded organization values" convention).
5. Add your id to **both** the `agentFlow.taskSource` `enum` **and**
   `enumDescriptions` arrays in `package.json`. **Both, not just one** — a
   registry entry with no manifest `enum` entry makes the setting
   un-pickable in the Settings UI even though `resolveConnector` would
   happily accept it if a user hand-typed it into `settings.json`.
   `test/unit/tasks/registry.test.ts` has a test asserting the `enum` and
   `CONNECTOR_IDS` are the same set, and that `enumDescriptions` has exactly
   as many entries as `enum` — so a mismatch fails CI, but only if you don't
   skip this step to begin with.
6. Add tests. `src/tasks/**` is **not** excluded from coverage thresholds
   (unlike `src/types.ts`, which is) — a new connector directory needs real
   test coverage, not a free pass because it's "just types."

## 6. The compatibility rules

- **Own your own settings namespace: `agentFlow.<id>.*`.** Never read or write
  another connector's settings, and never add a setting outside your own
  namespace.
- **Own your own SecretStorage keys**, namespaced the same way (the Jira
  connector uses `agentFlow.jira.email` / `agentFlow.jira.token`).
- **Never rename either once released.** A setting or SecretStorage key
  that ships is a promise to every user who configured it. Renaming a
  SecretStorage key silently signs every user of your connector out — the
  extension reads under the new name, finds nothing, and re-prompts for
  credentials it already has. Renaming a setting strands their configuration
  the same way: `isConfigured()` reads the new name, finds it empty, and
  offers the setup wizard to someone who already set everything up. Neither
  failure is loud — there's no error, just a user quietly asked to redo work
  they already did. If a setting or key genuinely needs to change shape, add
  the new one and read the old one as a fallback; don't just move it.

## 7. The inherited assumptions

Five things a connector author will hit that the seam does not (yet) make
source-agnostic:

- **`estimateSeconds` is rendered against an 8-hour workday.**
  `src/webview/helpers.ts`'s `fmtEst` divides by `3600` to get hours, then by
  `8` (commented `// Jira workday`) to decide when to switch from an "Nh"
  label to an "Nd" one. There is no per-connector override for the divisor.
  If your source has a size estimate at all (`caps.sizes: true`), report
  `Task.estimateSeconds` in seconds on the assumption that 8 of them make a
  day — there's no other contract to report it against.

- **Branch-name inference is still Jira-shaped and not behind the seam.**
  `engine/localRuns.ts:25`'s `inferTicket(branch, project, baseUrl)` matches
  a branch against a `PROJECT-123`-style pattern and, on a match, builds a
  `${baseUrl}/browse/${key}` url — both details are Jira's, and neither is
  reached through `TaskConnector`/`TaskProvider`. This is what powers the
  inferred ticket shown on a local Deck card for a workspace Agent Flow never
  launched.

  It's left this way deliberately, and it degrades **safely rather than
  wrongly**: `inferTicket` returns `null` whenever the `project` argument is
  empty (line 26), and its one caller, `deckView.ts`, always passes
  `agentFlow.jira.project` — a setting a non-Jira connector never populates.
  So on a non-Jira source, a local Deck card simply gets **no** inferred
  ticket, rather than a wrong one built from another source's project
  convention.

  The honest long-term home for this is a connector capability along the
  lines of `inferFromBranch(branch): { key, url, summary } | null` — "given a
  branch name, which task does it name" is genuinely connector knowledge —
  but nobody has designed it against a real second branch convention yet.
  Connector #2's author is the first person with a real case in hand, and
  should design it then rather than have it guessed at here.

- **`caps` is read on every access, not once — if you implement `refreshCaps`.**
  The Jira provider's `caps` is a getter over a cached project shape, so the
  same provider instance answers differently before and after `refreshCaps()`
  resolves. A field captured in your constructor would freeze the pre-probe
  answer into the very instance the panel is already reading. And make the
  un-probed answer your **optimistic** one: a failed probe must leave the user
  with the capabilities you would have claimed before detection existed, never
  with the narrowest set. One unreadable board list must not strip three tabs
  off a project that really does have sprints.

- **The `statusCategory != Done` in every Jira query matches a display name,
  and display names are localized.** Investigated 2026-08-13, deliberately left
  alone. Atlassian's advanced-searching reference gives `statusCategory` three
  locale-invariant aliases — `New`, `Indeterminate`, `Complete` — and ids
  (`statusCategory = 3` is the done category), alongside the localized display
  names `To Do` / `In Progress` / `Done` that `buildJql` uses today. So an
  escape hatch exists, but **nothing confirms a non-English site actually
  rejects `Done`**, and the literal is pinned by six assertions in
  `test/unit/tasks/jira/jql.test.ts`. If a localized site ever does reject it,
  the failure is loud rather than silent — the clause is in *every* candidate
  the fallback ladder tries, none of which strip it, so the panel surfaces a raw
  API error instead of degrading. The fix at that point is `statusCategory != 3`
  or the `Complete` alias, plus those six assertions. Don't spend them on the
  hypothesis alone.

- **Config is one shared, hand-written surface — and two of its fields are
  Jira's despite their generic names.** There is no `AgentFlowConfig.<id>`
  sub-object per connector. `AgentFlowConfig` (`src/config.ts:190-195`) is a
  single flat interface every connector's fields live in side by side, and
  `getConfig()` fills each field in by hand — for Jira, `config.ts:389-390`:

  ```ts
  baseUrl: (c.get<string>("jira.baseUrl") || "").replace(/\/+$/, ""),
  project: c.get<string>("jira.project") || "",
  ```

  Adding a connector means adding your own fields to `AgentFlowConfig` and
  populating them in `getConfig()` yourself — declaring `agentFlow.<id>.*`
  settings in `package.json` does not wire them into anything by itself.

  The trap: `baseUrl` and `project` are named as if they were generic
  per-connector concepts, but they are Jira's two settings, hand-wired to
  exactly the Jira connector's config keys above. A view or a new connector
  reaching for `getConfig().baseUrl` expecting "the current source's
  endpoint" would silently read Jira's — including when Jira isn't even the
  active source. The genuinely source-agnostic equivalents already exist:
  `SourceInfo.endpoint` and `SourceInfo.scopeValue`, both computed per
  connector inside its own `info()` (§4). Read those from view code; read
  your own `AgentFlowConfig` fields only from inside your own connector.

## 8. The minimal example

[`test/_helpers/fixtureConnector.ts`](../test/_helpers/fixtureConnector.ts)
is a second, complete `TaskConnector` + `TaskProvider` over two static,
in-memory tasks. It is deliberately the smallest connector that satisfies the
seam: it declares **no** optional capabilities at all —

```ts
readonly caps: Capabilities = {
  supportedFilters: ["mine", "all"],   // no sprint-shaped lens
  sizes: false,                        // no estimates
  // labels, sprints, components: all absent, not false
};
```

— and it deliberately imports nothing from `src/tasks/jira/`: `Task` and
`TaskDetail` both come from the seam itself (`src/tasks/provider.ts`, which
re-exports them), proving the interfaces can be satisfied by something that
has never heard of Jira.

It exists to make capability-gating load-bearing rather than assumed. Tests
in `test/unit/tasksView.test.ts`, `test/unit/setup.test.ts`, and
`test/webview/App.test.tsx` drive the host and the webview with it and assert
things like: only the two declared tabs render; the size control and the sprint
actions are absent, while the repo picker — which is not a capability — is
still there; `moveTo` with `fields: []` completes with no re-prompt; stamping a
provenance label onto a labels-less connector is silently accepted rather than
crashing.

If you're starting connector #2, read `fixtureConnector.ts` top to bottom
first — it is shorter than this document, and it is a working answer to
almost every question §2 and §4 raise.
