// GitHub as a Forge. Every provider here already existed and is wrapped
// unchanged: this file adds a description and a branch-CI spawn, nothing else.
// That is deliberate — it is what makes "GitHub still works" structural rather
// than a promise backed by tests.
import { BRANCH_CI_ARGS, mapBranchStatus } from "../orchestrator/branchCi";
import { execRunner, GH_TIMEOUT_MS, GhProvider, probeGh } from "../pr/provider";
import type { Runner } from "../pr/provider";
import { resolveBin } from "../pr/which";
import { GhReviewProvider } from "../review/provider";
import { parseGhAccounts } from "./accounts";
import type { Forge } from "./types";

/** The only host this forge speaks for. A GitHub Enterprise host in the same gh
 *  config belongs to a different forge instance — see `parseGhAccounts`. */
const GH_HOST = "github.com";

export function makeGithubForge(run: Runner = execRunner): Forge {
  return {
    id: "github",
    label: "GitHub",
    cli: { name: "gh", installUrl: "https://cli.github.com" },
    caps: { changesRequested: true, accounts: true },
    probe: () => probeGh(run),
    async accounts() {
      try {
        const out = await run(resolveBin("gh") ?? "gh", ["auth", "status", "--json", "hosts"], {
          cwd: process.cwd(),
          timeoutMs: GH_TIMEOUT_MS,
        });
        return parseGhAccounts(out, GH_HOST);
      } catch {
        // Not installed, not signed in, timed out, or a shape this build does
        // not recognise: all the same answer, and it is "we cannot say".
        return [];
      }
    },
    async switchAccount(login) {
      try {
        await run(resolveBin("gh") ?? "gh", ["auth", "switch", "--hostname", GH_HOST, "--user", login], {
          cwd: process.cwd(),
          timeoutMs: GH_TIMEOUT_MS,
        });
        return { ok: true };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    },
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
        return "unknown";
      }
    },
  };
}
