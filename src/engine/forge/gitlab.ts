// GitLab as a Forge.
import { GLAB_BRANCH_CI_ARGS, mapGlabBranchStatus } from "../orchestrator/branchCi";
import { GLAB_TIMEOUT_MS, GlabProvider, probeGlab } from "../pr/glab/provider";
import { execRunner } from "../pr/provider";
import type { Runner } from "../pr/provider";
import { resolveBin } from "../pr/which";
import { GlabReviewProvider } from "../review/glab/provider";
import type { Forge } from "./types";

export function makeGitlabForge(run: Runner = execRunner): Forge {
  return {
    id: "gitlab",
    label: "GitLab",
    cli: { name: "glab", installUrl: "https://gitlab.com/gitlab-org/cli" },
    // GitLab exposes no reviewer "changes requested" state we can read back.
    // `armability.ts` uses this to name the `changes-requested` rule as unfirable
    // rather than letting a flow wait on it forever.
    caps: { changesRequested: false },
    probe: () => probeGlab(run),
    prs: new GlabProvider(run),
    reviews: new GlabReviewProvider(run),
    async branchCi(repoPath, branch) {
      try {
        const out = await run(resolveBin("glab") ?? "glab", GLAB_BRANCH_CI_ARGS(branch), {
          cwd: repoPath,
          timeoutMs: GLAB_TIMEOUT_MS,
        });
        return mapGlabBranchStatus(JSON.parse(out) as unknown);
      } catch {
        return "unknown";
      }
    },
  };
}
