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
}

export interface Forge {
  readonly id: string;
  /** The forge's own name, for every user-visible label. */
  readonly label: string;
  readonly cli: { name: string; installUrl: string };
  readonly caps: ForgeCaps;
  /** Is the CLI installed and logged in? Probed once per Deck session. */
  probe(): Promise<ForgeGap | null>;
  readonly prs: PrProvider;
  readonly reviews: ReviewProvider;
  /** Is this branch green? `"unknown"` for every unreadable fact — a failed call,
   *  a timeout, a rate limit, a shape this build does not recognise, a branch that
   *  does not exist — and `"unknown"` is NOT green. */
  branchCi(repoPath: string, branch: string): Promise<BranchCiStatus>;
}
