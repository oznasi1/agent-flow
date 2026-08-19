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

/** What a forge can answer, for the questions where they genuinely differ. Held
 * as data rather than probed, because the consumers are pure modules that must
 * not import this directory. */
export interface ForgeCaps {
  /** Can a reviewer's "changes requested" state be read back? GitHub reports it
   *  in `reviewDecision`; GitLab exposes no equivalent, which makes the
   *  `changes-requested` orchestrator condition unfirable there. */
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
