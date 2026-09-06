// The seam between Agent Flow and whichever forge holds its pull/merge requests.
// Interfaces only: no runtime code, so nothing here can drag a dependency
// anywhere. The implementations DO import `child_process` — see this directory's
// other files, and the constraint in docs/FORGES.md.
//
// `import type` on all three, deliberately and load-bearing: it is erased at build
// time, so this module adds no runtime edge to anything. It also survives
// `test/unit/deckView.test.ts`'s mock of `../review/provider`, which is a
// non-spreading factory returning only `GhReviewProvider` — a value import of
// `ReviewProvider` from there would resolve to `undefined` under that mock.
import type { BranchCiStatus } from "../orchestrator/branchCi";
import type { PrProvider } from "../pr/provider";
import type { ReviewProvider } from "../review/provider";
import type { GateComment } from "../orchestrator/gateRouting";

/** Why forge reads are off. `missing`: there was no binary to spawn.
 * `signed-out`: a CLI we did find refused `auth status` — no token, or one it
 * could not validate. `detail` is for the log; the Deck shows only the kind. */
export type ForgeGap = { kind: "missing" | "signed-out"; detail: string };

/** One account the forge's CLI holds credentials for. `scopes` is display-only —
 *  it goes in the QuickPick's detail line so a user with two similar logins can
 *  tell them apart, and nothing branches on it. */
export interface ForgeAccount {
  login: string;
  active: boolean;
  scopes: string;
}

/** What a forge can answer, for the questions where they genuinely differ. Held
 * as data rather than probed, because the consumers are pure modules that must
 * not import this directory. */
export interface ForgeCaps {
  /** Does this forge have a first-class "changes requested" review state — one it
   *  can be TOLD and later ASKED? Deliberately one flag covering both directions,
   *  and both consumers use it accordingly: `armability.ts` reads it as "can the
   *  state be read back" (GitHub reports it in `reviewDecision`; GitLab exposes no
   *  equivalent, so the `changes-requested` condition is unfirable there), and
   *  `deckView.ts` reads it as "does `submit("request-changes")` do the real
   *  thing" (on GitLab it degrades to a note plus withdrawing any approval, which
   *  the confirmation dialog discloses).
   *
   *  They are one flag rather than two because they are one fact about the forge's
   *  review model, not a coincidence: a forge with no such state can neither be
   *  told nor asked, and one that has it does both. Splitting them would invite a
   *  third forge to claim it can be told but not asked — which would leave
   *  `armability` promising a rule that the write path can set and the read path
   *  can never see fire. If such a forge ever appears, split this deliberately and
   *  give each half its own consumer, rather than letting the two drift apart. */
  changesRequested: boolean;
  /** Can this forge answer "which pull requests are waiting on MY review"? A
   *  forge with no cross-repo reviewer query cannot, and must not fake it:
   *  `reviews.search()` returning `null` means THE ATTEMPT FAILED, so a forge
   *  that answered that way would leave the strip permanently stale and log a
   *  failure every TTL for a question that was never answerable. False hides
   *  the strip instead, through `deckView`'s existing `reviewsEnabled()` gate. */
  reviewSearch: boolean;
  /** Can this forge report which account its CLI acts as, and be told to change
   *  it? Both directions, one flag, for the same reason `changesRequested` is
   *  one flag: a CLI with no multi-account model can neither be asked nor told.
   *  `gh` can do both; `glab` holds one token per host and can do neither, and
   *  `atlassian-cli` has named profiles it can list but no verb to switch one. */
  accounts: boolean;
  /** Can a gate question be posted on a pull request and its reply read back
   *  (`gates` below)? Optional and absent-is-false, so a forge written before
   *  this capability degrades honestly: a routed gate on it stamps an error naming
   *  the forge rather than pretending to have asked anyone. */
  gateRouting?: boolean;
}

/** How a gate question travels to a person who is not at the Deck: a comment on
 * the card's pull request, and the replies to it. `post` returns the comment's
 * URL when the forge gives one; `replies` returns every non-system comment on
 * the PR since `sinceMs`, or `null` when the thread could not be read — which
 * the caller treats as "try again later", never as "nobody answered". */
export interface GateChannel {
  post(repoPath: string, number: number, body: string): Promise<{ ok: true; url?: string } | { ok: false; message: string }>;
  replies(repoPath: string, number: number, sinceMs: number): Promise<GateComment[] | null>;
}

export interface Forge {
  readonly id: string;
  /** The forge's own name, for every user-visible label. */
  readonly label: string;
  readonly cli: { name: string; installUrl: string };
  readonly caps: ForgeCaps;
  /** Capabilities that cannot be known until the CLI has been probed — for a CLI
   *  whose command surface differs by version, where the same forge id is more
   *  capable on a newer build. Resolved once per Deck session, alongside
   *  `probe()`, and re-resolved with it when settings change.
   *
   *  Re-resolved, but not necessarily re-PROBED: `deckView` clears its memo and
   *  calls this again, while the `Forge` object itself is built once in the
   *  panel's constructor, so an implementation that memoizes its probe (see
   *  `makeBitbucketForge`'s `once`) answers the second call from the first
   *  probe's result. The mode a Bitbucket install is in therefore lasts the
   *  panel's life, and installing a newer CLI mid-session needs the Deck
   *  reopened.
   *
   *  Optional on purpose: a forge whose caps are fully static omits this, and
   *  the static `caps` record above stands. That is what keeps this addition
   *  inert for `github` and `gitlab`.
   *
   *  **This MUST NEVER REJECT.** `deckView.forgeReady()` calls it as
   *  `void this.forge.resolveCaps?.().then(...)` with no `.catch()`, so a
   *  rejection here is an unhandled promise rejection on a background tick — not
   *  a caught degradation. An implementation that probes (Bitbucket spawns
   *  `bb api --help`) owns that probe's failure itself and answers with the
   *  CONSERVATIVE caps, which is the same thing `caps` above already claims. A
   *  cap this cannot establish is false, never a throw. */
  resolveCaps?(): Promise<ForgeCaps>;
  /** Is the CLI installed and logged in? Probed once per Deck session. */
  probe(): Promise<ForgeGap | null>;
  /** Every account the CLI holds credentials for, the active one included.
   *  Resolves `[]` when the forge cannot answer — never a fabricated single
   *  entry, which would be indistinguishable from a user who genuinely has one
   *  account. Must not reject: callers treat it as total. */
  accounts(): Promise<ForgeAccount[]>;
  /** Make `login` the active account, machine-wide. A result object rather than
   *  a `ForgeGap`: a refused switch is not a gap in the forge's health —
   *  `probe()` owns that — and a third `ForgeGap` kind would oblige
   *  `FORGE_NOTES` to carry a footer string for a state no user can reach. The
   *  `{ ok }` shape mirrors `FetchResult` in `../pr/provider`. */
  switchAccount(login: string): Promise<{ ok: true } | { ok: false; message: string }>;
  readonly prs: PrProvider;
  readonly reviews: ReviewProvider;
  /** Is this branch green? `"unknown"` for every unreadable fact — a failed call,
   *  a timeout, a rate limit, a shape this build does not recognise, a branch that
   *  does not exist — and `"unknown"` is NOT green. */
  branchCi(repoPath: string, branch: string): Promise<BranchCiStatus>;
  /** Present exactly when `caps.gateRouting` is true. */
  readonly gates?: GateChannel;
}
