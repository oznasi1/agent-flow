// Bitbucket Cloud as a Forge, through `atlassian-cli`.
//
// Two modes, because the CLI's command surface differs by version: `passthrough`
// when it has a raw `bb api`, `projected` when it does not. The mode is probed
// ONCE per forge instance and shared by both providers and by `resolveCaps` —
// see `once` below.
import { bbBranchCi, BB_BIN, BbProvider, probeBb, probeBbApi } from "../pr/bb/provider";
import { execRunner } from "../pr/provider";
import type { Runner } from "../pr/provider";
import { resolveBin } from "../pr/which";
import { BbReviewProvider } from "../review/bb/provider";
import type { Forge } from "./types";

/** Memoize a promise-returning thunk. The mode probe spawns a process, and both
 * providers plus `resolveCaps` ask for it — without this, every card on every
 * 6s tick would spawn `bb api --help`. */
function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= fn());
}

export function makeBitbucketForge(run: Runner = execRunner): Forge {
  const locate = () => resolveBin(BB_BIN);
  const apiMode = once(() => probeBbApi(run, locate));
  return {
    id: "bitbucket",
    label: "Bitbucket",
    // `atlassian-cli`, never `bb`: that is a subcommand alias inside this binary,
    // and a `bb` on PATH is craftamap/bb, an unrelated tool with an incompatible
    // command surface.
    cli: { name: BB_BIN, installUrl: "https://atlassiancli.com/install/" },
    // The STATIC caps are what this forge claims before any probe has run, so
    // they state the weaker mode: claiming `changesRequested` here would let
    // `armability.ts` promise a `changes-requested` rule that a projected build
    // can never fire. `resolveCaps` below reports the truth once we know it.
    //
    // `reviewSearch` is false in BOTH modes and is not resolved: Bitbucket Cloud
    // has no cross-repo reviewer query — `GET /2.0/workspaces/{ws}/pullrequests/{user}`
    // is authored-by — so this is an API limit no CLI version fixes.
    caps: { changesRequested: false, reviewSearch: false },
    async resolveCaps() {
      return { changesRequested: await apiMode(), reviewSearch: false };
    },
    probe: () => probeBb(run, locate),
    prs: new BbProvider(run, locate, apiMode),
    reviews: new BbReviewProvider(run, locate, apiMode),
    branchCi: (repoPath, branch) => bbBranchCi(run, locate, apiMode, repoPath, branch),
  };
}
