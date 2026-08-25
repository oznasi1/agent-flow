# Forge account switch — design

**Date:** 2026-08-25
**Status:** approved, not implemented
**Setting:** none (self-hiding — see §7)

## 1. Why

`gh` holds one active account per host. A user with two GitHub identities on
`github.com` — a personal one and a work one — is always reading as the wrong
account for half their repos, and Agent Flow says nothing about it.

The failure is silent, which is what makes it expensive. When `gh` is
authenticated as an account that cannot see a repo, the fetch fails with
`Could not resolve to a Repository`; `deckView.ts` stores
`{ facts: null, error: true }`; and `prSignals` in `src/engine/bucket.ts`
discards null facts before reducing. A run whose every PR read failed is
therefore **byte-identical to a run with no PR at all**: `open`, `blocked`,
`ready` and `merged` are all false, no PR block renders on the card, and the
card falls through `deriveBucket`'s ladder to whatever its local session state
says.

Observed on a real board: run `ASM-6029`, four repos, all four entries
`error: true` for a week. The card sat in **Action required** on a six-day-old
`needs-you` with no indication that its PR state was unreadable rather than
absent.

`probe()` does not catch this. It returns `null` — healthy — because
`gh auth status` genuinely succeeds; the CLI is installed and signed in. It is
signed in as the *wrong identity*, which is a third state the existing
`ForgeGap` union (`missing` | `signed-out`) has no name for.

## 2. Scope

In scope: show which account the forge is reading as, and let the user change
it from the Deck.

Out of scope, deliberately:

- **Per-repo or per-org account binding.** `gh auth token -u <login>` does hand
  back a token for a non-active account, so Agent Flow *could* pass `GH_TOKEN`
  per spawn and read every repo as the right identity with no global flip at
  all. That is the better answer to the underlying problem and it is a larger
  build; it is not this.
- **Making an unreadable PR state visible on the card.** `PrEntry.error` is
  written at `deckView.ts:1706` and read by nothing — not `prSignals`, not any
  webview. That defect is what let the auth failure masquerade as "no PR" for a
  week. It is real, it is independent of identity, and it deserves its own
  change.

Neither omission is blocked by this work; both compose with it.

## 3. The seam

`src/engine/forge/types.ts`:

```ts
/** One account the forge's CLI knows about. `scopes` is display-only. */
export interface ForgeAccount {
  login: string;
  active: boolean;
  scopes: string;
}

export interface ForgeCaps {
  changesRequested: boolean;
  /** Can this forge report which account it acts as, and be told to change it?
   *  Both directions, one flag, for the same reason `changesRequested` is one
   *  flag: a CLI with no multi-account model can neither be asked nor told. */
  accounts: boolean;
}
```

On `Forge`:

```ts
/** Every account the CLI holds credentials for, active one included.
 *  `[]` when the forge cannot answer — never a fabricated single entry, which
 *  would read as "you have exactly one account" and be indistinguishable from
 *  the truth. */
accounts(): Promise<ForgeAccount[]>;

/** Make `login` the active account. */
switchAccount(login: string): Promise<{ ok: true } | { ok: false; message: string }>;
```

Both are required members rather than optional ones. An optional method invites
a caller to feature-detect with `forge.accounts?.()`, which duplicates
`caps.accounts` and lets the two disagree. `caps.accounts` is the single
question a consumer asks.

`switchAccount` resolves a result object rather than a `ForgeGap`. A refused or
failed switch is not a gap in the forge's *health* — `probe()` owns that — and
reusing `ForgeGap` would force a third kind into a union that
`FORGE_NOTES` keys exhaustively, obliging a footer string for a state no user
can reach. The `{ ok }` shape mirrors `FetchResult` in
`src/engine/pr/provider.ts`, which already draws this distinction in this
codebase.

### 3.1 `github.ts`

`caps.accounts: true`.

`accounts()` spawns `gh auth status --json hosts` and reads the host entry.
Verified output shape:

```json
{"hosts":{"github.com":[
  {"state":"success","active":true,"host":"github.com","login":"oznasi1",
   "tokenSource":"keyring","scopes":"gist, read:org, repo, workflow",
   "gitProtocol":"https"},
  {"state":"success","active":false,"host":"github.com","login":"OznasiAb",
   "tokenSource":"keyring","scopes":"gist, read:org, repo",
   "gitProtocol":"https"}]}}
```

Structured output, not scraped text: `gh auth status` without `--json` is a
human-readable report whose wording has changed across releases.

Only entries with `state: "success"` are returned. An account whose token has
gone bad is not a switch target, and if the *active* account is the bad one,
`probe()` already reports `signed-out` and §5's precedence hands the slot to
that warning instead.

`--json` also changes the exit code: `gh auth status` exits 1 when any account
has an auth problem, but exits 0 with `--json` "unless there is a fatal error".
The implementation must not treat a nonzero exit as the only failure signal, and
must return `[]` rather than throwing on unparseable output.

`switchAccount(login)` spawns `gh auth switch -u <login>`.

Multi-host is out of scope: only the host matching the forge's own is read. A
GitHub Enterprise host in the same `gh` config is ignored rather than merged
into the list.

### 3.2 `gitlab.ts`

`caps.accounts: false`; `accounts()` resolves `[]`; `switchAccount()` resolves a
`ForgeGap` refusing the operation.

`glab` stores one token per host in its config and has no `auth switch`
equivalent. The seam states that rather than faking a single-entry list — the
rule `docs/FORGES.md` already sets for every other capability.

## 4. Data flow

The host reduces the account list to a string and a flag before anything crosses
the wire, exactly as `ghNote` does today. The webview learns nothing about
forges and `src/engine/forge/*` — which imports `child_process` — stays off
every browser bundle's import graph.

`deck:runs` gains one field:

```ts
ghAccount?: { cli: string; login: string; canSwitch: boolean } | null;
```

`cli` travels with the slot for the same reason `FORGE_NOTES` takes the CLI name
as an argument: the legend must not hardcode `gh`. Today only GitHub sets
`caps.accounts`, so the string is always `"gh"` — which is precisely when a
hardcode is cheapest to write and most expensive to find later.

**Optional, not required.** `test/webview/DeckApp.test.tsx`'s `runsMsg` helper
builds a `deck:runs` literal and is typed as
`Extract<OutboundMessage, { type: "deck:runs" }>`; a new required member stops
it compiling, which would mean editing an existing test to go green — the exact
signal `CLAUDE.md` says to stop on. Optional is also what `agentLabel` already
does, for the documented reason that a message posted before the host reloads
carries no such field.

`test/unit/compat.test.ts` freezes the released wire shape; adding a field does
not break a frozen shape, but the test must be re-read before implementation
rather than assumed.

`ghAccount` is null unless there are two or more good accounts. `canSwitch` is
therefore true in every case the webview actually receives; it exists so a
future forge that can *report* an identity without being able to change it — a
real possibility for forge #3 — has a way to say so without a second message
shape.

## 5. The legend slot

Placement: the footer legend, beside the existing forge note at
`src/webview/DeckApp.tsx:943`. Chosen over a header chip and over folding it
into the sync control: it is the row that already owns every forge-health fact,
so identity and "gh is not signed in" speak with one voice in one place, and the
header — already carrying four tiles and three controls — gains nothing.

One slot, three states, in precedence order:

| forge state | legend renders |
|---|---|
| `missing` or `signed-out` | today's `ghNote` warn, unchanged |
| signed in, ≥2 good accounts | `gh as `**`oznasi1`**` · switch` |
| signed in, 1 account | nothing — today's behavior |
| unreadable, or `caps.accounts` false | nothing — today's behavior |

A single-account user sees no new chrome. Naming the identity when there is only
one to have tells them nothing they can act on, and it would contradict §7: the
argument for shipping without a setting is precisely that nothing changes for
them.

`ghNote` and `ghAccount` are mutually exclusive by construction: a forge that is
missing or signed out has no account to name. The webview asserts the
precedence rather than relying on the host to send only one.

The login renders in mono — it is an identifier, the same rule the branch chip
and `~/.claude/projects` already follow. No colour: nothing here is wrong.
`--c-attn` stays reserved for the `signed-out` warning that shares the row.

## 6. The switch

`switch` posts `deck:switchAccount` (no payload — the host owns the list).

Host-side sequence:

1. `showQuickPick` over the non-active accounts, `login` as label and `scopes`
   as detail.
2. `showWarningMessage` with `{ modal: true }`, disclosing that this changes the
   active account **for the whole machine** — every editor window, every
   terminal, and every other tool that shells out to `gh`.
3. `forge.switchAccount(login)`.
4. On success, invalidate. On failure, toast the `ForgeGap` detail and change
   nothing.

A QuickPick and a modal rather than a popover in the webview: this is a
host-side, machine-global, mutating action. VS Code has the idiom, and the modal
is where the disclosure belongs — a footer link cannot carry it.

### 6.1 Invalidation

Without this the switch appears to do nothing: every `error: true` entry
survives in `~/.agentflow/prfacts/`, the board re-renders identically, and the
user concludes the feature is broken.

On success:

- `removePrEntries(defaultPrFactsDir(), key)` for every run — the cached
  failures were the *old* identity's answers and cannot be re-validated.
- Bump `prEpoch` for every run, so any fetch already in flight under the old
  account is discarded when it lands (`deckView.ts:1714` already does this
  check).
- `this.branchCi.clear()` and `this.branchCiAmbiguous.clear()`.
- `this.forgeGap = undefined; this.forgeProbe = null` — re-probe under the new
  identity.
- Refresh.

Steps 3–5 are what the `agentFlow.prFacts` config handler already does at
`deckView.ts:3128-3139`. Share them rather than writing a second copy that can
drift — but as **two** methods, not one: that handler clears the branch-CI
caches unconditionally and re-probes only when `prFacts` turns back *on*, so a
single method would either change its behavior or need a flag argument that
re-encodes the same split. `dropForgeCaches()` and `reprobeForge()`; the config
handler calls the first and conditionally the second, the switch calls both plus
the stored-entry sweep.

## 7. Why no setting

`CLAUDE.md`'s "new behavior ships inert" invariant exists so an update cannot
change what an existing user sees without them opting in.

This ships inert without a flag: the legend entry renders only when the forge
can enumerate accounts, and the switch affordance only when there are two or
more. Every existing single-account user — the overwhelming majority — sees the
board exactly as they see it today. A default-off setting would add a
permanently-frozen id to the manifest to gate UI that already hides itself.

The existing suite must pass unmodified. A test that needs editing to go green
is the signal to stop and revisit this section.

## 8. Testing

- **Parsing.** Fixtures from the real `--json hosts` output above: two accounts,
  one account, an account with `state != "success"`, a host that is absent, and
  unparseable bytes. Every failure path returns `[]`, none throws.
- **Precedence.** A table over the four rows in §5, asserting the legend string
  and that `ghNote` and `ghAccount` are never both rendered.
- **Invalidation.** A successful switch removes every PR entry, bumps every
  epoch, and re-probes. An in-flight fetch that lands after the switch is
  discarded.
- **Refusal.** With `caps.accounts: false`, no legend entry renders, and a
  `deck:switchAccount` that arrives anyway is refused rather than executed.
- **Cancellation.** Dismissing the QuickPick or declining the modal invalidates
  nothing and switches nothing.
- **Docs.** `docs/FORGES.md` must gain `ForgeAccount`, `caps.accounts`,
  `accounts()` and `switchAccount()`.

  Note, corrected after implementation: `test/unit/docs.test.ts` does **not**
  assert the interface block matches the real interface. It asserts only that
  every id in `FORGE_IDS` appears somewhere in `docs/FORGES.md` wrapped in
  backticks. Since this change registers no new forge, that test passes whether
  the interface block is updated or not — so keeping §1's code block honest is a
  manual discipline here, not a gate. Worth knowing before trusting "docs are
  tested" to catch a stale interface block.

Coverage thresholds are 90% lines/statements and 85% branches/functions
(`vitest.config.ts`), enforced by `npm run test:cov`.

## 9. Gates

`.github/workflows/ci.yml` is exactly `npm ci`, `npm run typecheck`, `npm test`,
`npm run build`. All four must pass.

`npm run build` is a real gate here, not a formality: this change touches
`src/engine/forge/*`, which imports `child_process`. If any of it becomes
reachable from a browser entry point, `tsc` and the whole Vitest suite still
pass and only `npm run build` fails. Keeping the reduction host-side (§4) is
what prevents that.

`npm test` is ~4,500 tests over 2+ minutes and exceeds the default Bash tool
timeout — pass `timeout: 600000`, and never pipe it through `tail` or `head`.

## 10. What this does not fix

The `ASM-6029` card that prompted this work will not move. Its four repos have
no PR on the run's recorded branch — the work shipped under `ASM-6030`,
`ASM-6031`, `ASM-6032` (all merged) and `ASM-6043` (open), on four different
branches. Post-switch, `facts: null` for that run is an honest "no PR on this
branch" rather than an auth artifact, and `prSignals.merged` stays false because
it requires every PR-bearing repo to have merged. **Forget** is what clears that
card.

What this buys is the general case: never again silently reading a board as an
identity that cannot see it.
