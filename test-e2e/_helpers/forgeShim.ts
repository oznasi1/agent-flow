import * as fs from "fs";
import * as path from "path";
import type { Sandbox } from "./sandbox";

export interface ForgeAnswers {
  gh?: Record<string, string>; // "first two argv words" → JSON string to print
  glab?: Record<string, string>;
}

/** Install `gh`/`glab` shims into the sandbox's PATH dir. Each shim matches
 *  the FIRST TWO argv words against its canned answers and prints the JSON.
 *  Anything unmatched is SELF-DISCOVERING: the shim appends the full argv to
 *  unknown.jsonl and exits 0 with an empty JSON array — an empty answer shows
 *  up in the journey's assertions, a crash would not. resolveBin (which.ts)
 *  prefers PATH over its Homebrew fallbacks, so the shim always wins over a
 *  developer's real CLI. */
export function installForgeShims(sb: Sandbox, answers: ForgeAnswers): { unknownLog: string } {
  const bin = path.join(sb.root, "bin");
  const answersDir = path.join(sb.root, "forge-answers");
  fs.mkdirSync(answersDir, { recursive: true });
  const unknownLog = path.join(answersDir, "unknown.jsonl");

  for (const cli of ["gh", "glab"] as const) {
    const map = answers[cli] ?? {};
    for (const [sig, body] of Object.entries(map)) {
      // Per-CHAR, not per-run: the shim mangles with `tr`, which maps every
      // non-alphanumeric character to its own underscore.
      fs.writeFileSync(path.join(answersDir, `${cli}.${sig.replace(/[^A-Za-z0-9]/g, "_")}.json`), body);
    }
    fs.writeFileSync(
      path.join(bin, cli),
      [
        "#!/bin/sh",
        `printf '{"cli":"${cli}","argv":"%s"}\n' "$*" >> "${answersDir}/calls.jsonl"`,
        `sig=$(printf '%s_%s' "$1" "$2" | tr -c 'A-Za-z0-9' '_')`,
        `f="${answersDir}/${cli}.$sig.json"`,
        `if [ -f "$f" ]; then cat "$f"; exit 0; fi`,
        `printf '{"cli":"${cli}","argv":"%s"}\\n' "$*" >> "${unknownLog}"`,
        `echo "[]"`,
      ].join("\n") + "\n",
      { mode: 0o755 },
    );
  }
  return { unknownLog };
}

/** One open PR in gh's --json shape, for the branch the take's worktree is on. */
export function ghPrListAnswer(branch: string): string {
  return JSON.stringify([{
    number: 41, url: "https://github.invalid/oznasi1/rocket/pull/41",
    title: "Fix the rocket telemetry panel", state: "OPEN", isDraft: false,
    headRefName: branch, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }],
  }]);
}

export interface ReviewReq {
  number: number;
  repo: string;   // "owner/name"
  title: string;
  author: string;
  branch: string;
}

/** The `gh api graphql` answer the review rail parses.
 *
 *  Shape matters more than content: `parseReviewSearch` (src/engine/review/search.ts)
 *  returns NULL for anything that is not `data.search.{issueCount,nodes}`, and a
 *  null parse is indistinguishable from "no review requests" — which would make
 *  the journey pass against a broken product. Both members are mandatory here.
 *
 *  The shim keys on the first two argv words, so this registers under the
 *  signature "api graphql" (tr-mangled to `api_graphql`). */
export function ghReviewRequestsAnswer(reqs: ReviewReq[]): string {
  return JSON.stringify({
    data: {
      search: {
        issueCount: reqs.length,
        nodes: reqs.map((r) => ({
          __typename: "PullRequest",
          number: r.number,
          title: r.title,
          url: `https://github.invalid/${r.repo}/pull/${r.number}`,
          isDraft: false,
          createdAt: "2026-08-20T00:00:00Z",
          updatedAt: "2026-08-21T00:00:00Z",
          author: { login: r.author },
          headRefName: r.branch,
          baseRefName: "main",
          repository: { nameWithOwner: r.repo },
        })),
      },
    },
  });
}

/** Fail when the product shelled a subcommand nobody faked.
 *
 *  Call this in the teardown of every forge journey. Without it the shim's
 *  empty-answer fallback silently absorbs a real behaviour change: the journey
 *  stays green while the product asks a question the test never answered. */
export function expectNoUnknownForgeCalls(sb: Sandbox): void {
  const log = path.join(sb.root, "forge-answers", "unknown.jsonl");
  if (!fs.existsSync(log)) return;
  const lines = fs.readFileSync(log, "utf8").trim();
  if (lines === "") return;
  throw new Error(
    `the product shelled forge subcommands with no canned answer — add them to the shim:\n${lines}`,
  );
}
