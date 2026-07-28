import { describe, it, expect, vi } from "vitest";
import { GhReviewProvider } from "../../../../src/engine/review/provider";
import { THREADS_QUERY } from "../../../../src/engine/pr/provider";
import type { Runner } from "../../../../src/engine/pr/provider";
import { REVIEW_SEARCH_Q, REVIEW_SEARCH_QUERY } from "../../../../src/engine/review/search";
import type { ReviewVerb } from "../../../../src/types";

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

describe("GhReviewProvider.submit", () => {
  it("approves with no body", async () => {
    const run = runner(async () => "");
    const out = await new GhReviewProvider(run, locate).submit("o/r", 7, "approve", "");
    expect(out).toEqual({ ok: true });
    const [, args, opts] = (run as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(args).toEqual(["pr", "review", "7", "--repo", "o/r", "--approve"]);
    // No cwd inside a checkout, same as search/detail: the PR's repo may not be
    // cloned at all. A `this.exec(args)` swapped for an inline call using
    // `process.cwd()` would abandon that and still pass every other assertion.
    expect(opts.cwd).toBe(require("os").homedir());
  });

  it("approves with a body when one is given", async () => {
    const run = runner(async () => "");
    await new GhReviewProvider(run, locate).submit("o/r", 7, "approve", "nice");
    expect((run as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual([
      "pr", "review", "7", "--repo", "o/r", "--approve", "--body", "nice",
    ]);
  });

  it("requests changes with a body", async () => {
    const run = runner(async () => "");
    await new GhReviewProvider(run, locate).submit("o/r", 7, "request-changes", "retry budget");
    expect((run as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual([
      "pr", "review", "7", "--repo", "o/r", "--request-changes", "--body", "retry budget",
    ]);
  });

  it("comments with a body", async () => {
    const run = runner(async () => "");
    await new GhReviewProvider(run, locate).submit("o/r", 7, "comment", "a thought");
    // Full argv, not just toContain("--comment") — pinning every verb flag exactly
    // means a swap (e.g. --comment for --request-changes) cannot slip through,
    // which matters most here since the wrong verb posts the wrong review type
    // on someone else's pull request.
    expect((run as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual([
      "pr", "review", "7", "--repo", "o/r", "--comment", "--body", "a thought",
    ]);
  });

  it("trims surrounding whitespace before it reaches argv", async () => {
    const run = runner(async () => "");
    await new GhReviewProvider(run, locate).submit("o/r", 7, "comment", "  looks good  ");
    // A fixture with no surrounding whitespace can't tell `text` (trimmed) apart
    // from a raw `body` pushed straight into argv — this one can.
    expect((run as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual([
      "pr", "review", "7", "--repo", "o/r", "--comment", "--body", "looks good",
    ]);
  });

  it("threads the given repo and number, not a hardcoded one", async () => {
    const run = runner(async () => "");
    await new GhReviewProvider(run, locate).submit("CyberJackGit/aws-ops", 8491, "approve", "");
    // Every other test in this block uses ("o/r", 7); a distinct pair here is
    // the only thing that can catch an implementation that hardcodes those two
    // values instead of threading the parameters through — every other test
    // would still pass against that bug.
    expect((run as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual([
      "pr", "review", "8491", "--repo", "CyberJackGit/aws-ops", "--approve",
    ]);
  });

  it.each(["comment", "request-changes"] as const)("refuses %s with an empty body, before spawning", async (verb) => {
    const run = runner(async () => "");
    const out = await new GhReviewProvider(run, locate).submit("o/r", 7, verb, "   ");
    expect(out).toEqual({ ok: false, message: "GitHub requires a message for this kind of review." });
    expect(run).not.toHaveBeenCalled();
  });

  it("normalises a non-string body instead of throwing", async () => {
    const run = runner(async () => "");
    // A webview message is untyped at runtime no matter what the TS signature
    // claims. `body.trim()` on `undefined` would reject with a TypeError; this
    // asserts a resolved, discriminated result instead.
    const out = await new GhReviewProvider(run, locate).submit("o/r", 7, "approve", undefined as unknown as string);
    expect(out).toEqual({ ok: true });
  });

  it.each(["Approve", "constructor"] as const)("refuses an out-of-union verb (%s) before spawning", async (verb) => {
    const run = runner(async () => "");
    // "Approve" (wrong casing) is simply not a ReviewVerb. "constructor" is the
    // adversarial case: `!VERB_FLAG[verb]` would see `VERB_FLAG.constructor`
    // (inherited from Object.prototype) as truthy and sail through; only
    // `Object.hasOwn` correctly refuses it.
    const out = await new GhReviewProvider(run, locate).submit("o/r", 7, verb as unknown as ReviewVerb, "body text");
    expect(out).toEqual({ ok: false, message: `Unknown review verb: ${verb}` });
    expect(run).not.toHaveBeenCalled();
  });

  // These two fixtures are shaped exactly the way `execFile` (and this repo's
  // own `execRunner`) really produces a rejection — verified empirically
  // against a live `execFile` call, not assumed:
  //   - `.message` is ALWAYS `Command failed: <file> <full argv joined>`,
  //     optionally followed by `\n` + stderr's own text.
  //   - `.stderr` is a property `execRunner` attaches itself (Node's own
  //     error carries only `code`/`killed`/`signal`/`cmd` — never `.stderr`
  //     or `.stdout`); it is present whenever `execRunner` ran, empty or not.
  // A hand-built `Object.assign(new Error("some message"), { stderr: "..." })`
  // with no "Command failed: …" prefix at all is not a shape a real rejection
  // can have, and a test built on one can pass over a genuinely inert fix.

  it("prefers stderr — attached by execRunner — over the reconstructed command line", async () => {
    const secretBody = "the retry budget is unbounded and nobody noticed";
    const err = Object.assign(
      new Error(
        `Command failed: gh pr review 7 --repo o/r --approve --body ${secretBody}\nHTTP 422: Validation Failed`,
      ),
      { stderr: "HTTP 422: Validation Failed" },
    );
    const run = runner(async () => { throw err; });
    const out = await new GhReviewProvider(run, locate).submit("o/r", 7, "approve", secretBody);
    expect(out).toEqual({ ok: false, message: "HTTP 422: Validation Failed" });
    if (!out.ok) {
      expect(out.message).not.toContain("--body");
      expect(out.message).not.toContain(secretBody);
    }
  });

  // The critical case: no `.stderr` at all — a killed process typically has
  // none, and this is also exactly the shape a rejection had *before*
  // execRunner was fixed to attach it. Pins that the fallback strips
  // `.message`'s own reconstructed line rather than ever returning it —
  // reverting either half of the fix (execRunner no longer attaching
  // `stderr`, or this catch trusting `.message` verbatim again) reproduces
  // the exact leak the final review caught: the returned message containing
  // `--body` and the secret review text.
  it("never leaks --body or the review text when the rejection carries no stderr at all", async () => {
    const secretBody = "mine, all mine — nobody else gets a vote";
    const err = new Error(`Command failed: gh pr review 7 --repo o/r --approve --body ${secretBody}\n`);
    const run = runner(async () => { throw err; });
    const out = await new GhReviewProvider(run, locate).submit("o/r", 7, "approve", secretBody);
    expect(out).toEqual({
      ok: false,
      message: "gh failed without further detail — check the PR directly.",
    });
    if (!out.ok) {
      expect(out.message).not.toContain("--body");
      expect(out.message).not.toContain(secretBody);
    }
  });

  // A rejection with no stderr but with genuine stderr *text* baked into
  // .message (Node appends "\n" + stderr there too) and, for whatever reason,
  // no .stderr property of its own — still must not fall through to the raw
  // "Command failed: …" line; it keeps just what follows that line.
  it("keeps only what follows the reconstructed command line when stderr text is in .message but no .stderr property exists", async () => {
    const secretBody = "the retry budget is unbounded";
    const err = new Error(
      `Command failed: gh pr review 7 --repo o/r --approve --body ${secretBody}\nHTTP 422: Validation Failed`,
    );
    const run = runner(async () => { throw err; });
    const out = await new GhReviewProvider(run, locate).submit("o/r", 7, "approve", secretBody);
    expect(out).toEqual({ ok: false, message: "HTTP 422: Validation Failed" });
    if (!out.ok) {
      expect(out.message).not.toContain("--body");
      expect(out.message).not.toContain(secretBody);
    }
  });

  it.each([
    ["killed", { killed: true }],
    ["code ETIMEDOUT", { code: "ETIMEDOUT" }],
  ])("returns timeout wording that does not claim GitHub answered, on a %s rejection", async (_label, shape) => {
    const secretBody = "mine, all mine";
    const err = Object.assign(
      new Error(`Command failed: gh pr review 7 --repo o/r --approve --body ${secretBody}`),
      shape,
    );
    const run = runner(async () => { throw err; });
    const out = await new GhReviewProvider(run, locate).submit("o/r", 7, "approve", secretBody);
    expect(out).toEqual({
      ok: false,
      message: "Timed out after 10s — the review may already have gone through. Open the PR to check.",
    });
    if (!out.ok) {
      expect(out.message).not.toMatch(/refused/i);
      expect(out.message).not.toContain("--body");
    }
  });
});
