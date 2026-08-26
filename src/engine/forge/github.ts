// GitHub as a Forge. Every PR/review provider here already existed and is
// wrapped unchanged; this file also owns a description, a branch-CI spawn, and
// the two account-capability spawns (`accounts`, `switchAccount` — the latter
// the one call in this seam that mutates machine state rather than reading it).
// "GitHub still works" is structural for the wrapped providers rather than a
// promise backed by tests; the account spawns are new code and are covered by
// `test/unit/engine/forge/seam.test.ts` and `accounts.test.ts` instead.
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
    caps: { changesRequested: true, reviewSearch: true, accounts: true },
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
        // execRunner attaches `stderr` — gh's own complaint — separately from
        // `.message`, which for a real spawn failure is Node's reconstructed
        // `Command failed: <file> <full argv joined>` (docs/FORGES.md §4): here
        // that argv is the account name and hostname flags, which a toast must
        // never echo back verbatim ahead of what gh actually said. Prefer
        // stderr whenever gh wrote one. When it did not — a process that failed
        // silently, or (never in production, but in a test double) a runner
        // that isn't execRunner at all — fall back to `.message`, unless that
        // message is itself the argv-shaped leak, in which case say something
        // fixed and argv-free instead of the command line. Not `stripCommandLine`:
        // that helper's fallback assumes an execFile-shaped message with a
        // trailing `\n<stderr>`, which is PR-specific and wrong here.
        const stderr = (e as { stderr?: string }).stderr?.trim();
        if (stderr) return { ok: false, message: stderr };
        const message = e instanceof Error ? e.message : String(e);
        return {
          ok: false,
          message: message.startsWith("Command failed:")
            ? "gh auth switch failed with no further detail — check gh directly."
            : message,
        };
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
