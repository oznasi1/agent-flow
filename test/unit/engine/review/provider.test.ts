import { describe, it, expect, vi } from "vitest";
import { GhReviewProvider } from "../../../../src/engine/review/provider";
import { THREADS_QUERY } from "../../../../src/engine/pr/provider";
import type { Runner } from "../../../../src/engine/pr/provider";
import { REVIEW_SEARCH_Q, REVIEW_SEARCH_QUERY } from "../../../../src/engine/review/search";

const searchPayload = JSON.stringify({
  data: {
    search: {
      issueCount: 1,
      nodes: [{
        number: 850, title: "Encrypt only Synqly credential",
        url: "https://github.com/CyberJackGit/centaur/pull/850",
        isDraft: false, createdAt: "2026-07-27T14:31:30Z", updatedAt: "2026-07-28T06:23:08Z",
        additions: 409, deletions: 50, changedFiles: 8,
        author: { login: "OshriBay" }, repository: { nameWithOwner: "CyberJackGit/centaur" },
        reviewDecision: null, mergeable: "MERGEABLE",
        commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
      }],
    },
  },
});

const runner = (impl: Runner) => vi.fn(impl) as unknown as Runner & ReturnType<typeof vi.fn>;
const locate = () => "/opt/homebrew/bin/gh";

describe("GhReviewProvider.search", () => {
  it("asks gh for the review-request search and maps the result", async () => {
    const run = runner(async () => searchPayload);
    const out = await new GhReviewProvider(run, locate).search();
    expect(out!.issueCount).toBe(1);
    expect(out!.requests[0].id).toBe("CyberJackGit/centaur#850");
    const [file, args, opts] = (run as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(file).toBe("/opt/homebrew/bin/gh");
    // Pins both the flag order and, crucially, which flag carries the query
    // string: `-f` (string) vs `-F` (typed) send gh a differently-typed value,
    // so a swap here would silently break the live call while a loose
    // `toContain` check stayed green.
    expect(args).toEqual([
      "api", "graphql",
      "-f", `query=${REVIEW_SEARCH_QUERY}`,
      "-f", `q=${REVIEW_SEARCH_Q}`,
      "-F", "n=50",
    ]);
    // No cwd inside a checkout: the repos may not be cloned at all.
    expect(opts.cwd).toBe(require("os").homedir());
  });

  it("returns null when gh fails", async () => {
    const run = runner(async () => { throw new Error("gh: not logged in"); });
    expect(await new GhReviewProvider(run, locate).search()).toBeNull();
  });

  it("returns null on unparsable stdout", async () => {
    const run = runner(async () => "<html>proxy error</html>");
    expect(await new GhReviewProvider(run, locate).search()).toBeNull();
  });

  it("returns null on a GraphQL errors payload", async () => {
    const run = runner(async () => JSON.stringify({ errors: [{ message: "Bad credentials" }] }));
    expect(await new GhReviewProvider(run, locate).search()).toBeNull();
  });

  it("falls back to the bare binary name when gh cannot be located", async () => {
    const run = runner(async () => searchPayload);
    await new GhReviewProvider(run, () => null).search();
    expect((run as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("gh");
  });
});

describe("GhReviewProvider.detail", () => {
  const rollup = JSON.stringify({
    statusCheckRollup: [
      { __typename: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "CheckRun", name: "e2e", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://ci/e2e" },
    ],
  });
  // Two threads, only one still open: a naive count-all-nodes implementation
  // would report 2 instead of 1, so this fixture actually exercises the
  // isResolved/isOutdated filtering rather than merely rubber-stamping nodes.length.
  const threads = JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              { isResolved: false, isOutdated: false },
              { isResolved: true, isOutdated: false },
            ],
          },
        },
      },
    },
  });

  it("returns failing check names and the unresolved count", async () => {
    const run = runner(async (_f, args) => (args[0] === "pr" ? rollup : threads));
    const out = await new GhReviewProvider(run, locate).detail("CyberJackGit/aws-ops", 8491);
    expect(out).toEqual({ failing: [{ name: "e2e", url: "https://ci/e2e" }], unresolved: 1 });
    // Pins the second call's full argv, including the owner/repo/number
    // variables threaded through THREADS_QUERY — previously unasserted.
    expect((run as ReturnType<typeof vi.fn>).mock.calls[1][1]).toEqual([
      "api", "graphql", "-f", `query=${THREADS_QUERY}`,
      "-F", "o=CyberJackGit", "-F", "r=aws-ops", "-F", "n=8491",
    ]);
  });

  it("targets the repo by name, not by working directory", async () => {
    const run = runner(async (_f, args) => (args[0] === "pr" ? rollup : threads));
    await new GhReviewProvider(run, locate).detail("CyberJackGit/aws-ops", 8491);
    const [, args, opts] = (run as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(args).toEqual([
      "pr", "view", "8491", "--repo", "CyberJackGit/aws-ops", "--json", "statusCheckRollup",
    ]);
    // The title's claim, made good: no repo checkout is involved anywhere here.
    expect(opts.cwd).toBe(require("os").homedir());
  });

  it("keeps the checks when the thread call fails", async () => {
    const run = runner(async (_f, args) => {
      if (args[0] === "pr") return rollup;
      throw new Error("graphql exploded");
    });
    const out = await new GhReviewProvider(run, locate).detail("o/r", 1);
    expect(out).toEqual({ failing: [{ name: "e2e", url: "https://ci/e2e" }], unresolved: null });
  });

  it("returns null when the checks call fails", async () => {
    const run = runner(async () => { throw new Error("nope"); });
    expect(await new GhReviewProvider(run, locate).detail("o/r", 1)).toBeNull();
  });

  it("degrades to null unresolved, without a second call, on a repo with no owner/name split", async () => {
    // "notarepo" has no "/" — owner and name both come back empty from split("/").
    // The guard must skip the GraphQL call entirely rather than fire it with an
    // empty owner; a deleted guard would still resolve (gh would just error on a
    // bogus query) and callCount would climb to 2.
    const run = runner(async () => rollup);
    const out = await new GhReviewProvider(run, locate).detail("notarepo", 1);
    expect(out).toEqual({ failing: [{ name: "e2e", url: "https://ci/e2e" }], unresolved: null });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
