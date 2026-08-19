// GitHub as a Forge. Every provider here already existed and is wrapped
// unchanged: this file adds a description and a branch-CI spawn, nothing else.
// That is deliberate — it is what makes "GitHub still works" structural rather
// than a promise backed by tests.
import { BRANCH_CI_ARGS, BranchCiStatus, mapBranchStatus } from "../orchestrator/branchCi";
import { execRunner, GH_TIMEOUT_MS, GhProvider, probeGh } from "../pr/provider";
import type { Runner } from "../pr/provider";
import { resolveBin } from "../pr/which";
import { GhReviewProvider } from "../review/provider";
import type { Forge } from "./types";

export function makeGithubForge(run: Runner = execRunner): Forge {
  return {
    id: "github",
    label: "GitHub",
    cli: { name: "gh", installUrl: "https://cli.github.com" },
    caps: { changesRequested: true },
    probe: () => probeGh(run),
    prs: new GhProvider(run),
    reviews: new GhReviewProvider(run),
    async branchCi(repoPath, branch) {
      try {
        const out = await run(resolveBin("gh") ?? "gh", BRANCH_CI_ARGS(branch), {
          cwd: repoPath,
          timeoutMs: GH_TIMEOUT_MS,
        });
        return mapBranchStatus(JSON.parse(out) as unknown);
      } catch {
        // A non-zero exit, a timeout, a rate limit, unparseable output: all the
        // same answer, and it is not green.
        return "unknown" as BranchCiStatus;
      }
    },
  };
}
