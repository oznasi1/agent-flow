import { describe, it, expect } from "vitest";
import { BbProvider, bbBranchCi, probeBb, probeBbApi } from "../../../../../src/engine/pr/bb/provider";
import type { Runner } from "../../../../../src/engine/pr/provider";

/** An absolute path, as a real lookup returns: nothing here may depend on the
 * bare name `atlassian-cli` being resolvable from the test process's own PATH. */
const BB = "/opt/homebrew/bin/atlassian-cli";
const REMOTE = "https://bitbucket.org/acme/api-service.git";

/** A Runner that replies by matching an argv fragment, so a test states what each
 * call returns instead of depending on call order. An unmatched call throws,
 * which is what the real CLI does for a bad route. More specific fragments must
 * be listed before less specific ones — lookup is by insertion order.
 *
 * In particular: the sub-resource paths ("…/pullrequests/42/statuses",
 * "/conflicts", "/comments") all contain "pullrequests/42", so a test routing the
 * single-PR read must list those fragments BEFORE the bare "pullrequests/42" key
 * or they will match the wrong route. */
function routed(routes: Record<string, string | Error>): {
  run: Runner;
  calls: { args: string[]; cwd: string }[];
} {
  const calls: { args: string[]; cwd: string }[] = [];
  const run: Runner = async (file, args, opts) => {
    calls.push({ args, cwd: opts.cwd });
    // Every atlassian-cli call goes through the located binary; the repo's git
    // remote is read from the real `git` binary directly (see `repoOf` in
    // provider.ts) — neither `gh` nor `glab`'s providers need this since their
    // own CLI infers the repo itself, but `bb pr list <repo>` takes the slug as
    // a required positional and ignores git context entirely.
    expect([BB, "git"]).toContain(file);
    const hit = Object.entries(routes).find(([frag]) => args.some((a) => a.includes(frag)));
    if (!hit) throw new Error(`unrouted: ${args.join(" ")}`);
    if (hit[1] instanceof Error) throw hit[1];
    return hit[1];
  };
  return { run, calls };
}

const provider = (run: Runner, apiMode: boolean) =>
  new BbProvider(run, () => BB, async () => apiMode);

const PROJECTED_ROW = {
  id: 42, title: "ASM-1 add export", state: "OPEN",
  author: "Ada", source: "feat/ASM-1", destination: "main",
};

/** A second projected row that matches the KEY selector but not the BRANCH one,
 * and carries a HIGHER id than `PROJECTED_ROW`. Both halves are load-bearing:
 * `pickBbPr` breaks a tie by newest id, so two rows sharing an id would leave the
 * branch and key selectors indistinguishable to any assertion — which is exactly
 * how the branch matcher every projected user gets today shipped unpinned. */
const PROJECTED_OTHER_BRANCH = { ...PROJECTED_ROW, id: 99, source: "other" };

/** One row of a `…/pullrequests?q=…` LIST response, as Bitbucket Cloud actually
 * sends it: its PARTIAL representation of a pull request — **no `participants`,
 * and no `draft`.** Verified against the `pullrequest` schema's partial form. Do
 * not add either back "for completeness": a list fixture that carries them is
 * what let this provider ship reading the review verdict and the draft flag off a
 * row that never has them, with every passthrough card reporting `review: "none"`
 * and `isDraft: false` no matter the truth. Both belong in `shown()` below, which
 * is the only response that has them. */
const LIST_ROW = {
  id: 42, title: "ASM-1 add export", state: "OPEN",
  links: { html: { href: "https://bitbucket.org/acme/api-service/pull-requests/42" } },
  source: { branch: { name: "feat/ASM-1" } },
  destination: { branch: { name: "main" } },
};

/** The same PR as the SINGLE-PR endpoint sends it: everything the list row has,
 * plus the `participants` and `draft` that only this route carries. */
const shown = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    ...LIST_ROW,
    draft: false,
    participants: [{ role: "REVIEWER", approved: true, state: "approved" }],
    ...over,
  });

describe("probeBbApi", () => {
  it("is true when `bb api --help` exits zero and false when it does not", async () => {
    const ok = routed({ "--help": "Usage: atlassian-cli bb api <PATH>" });
    await expect(probeBbApi(ok.run, () => BB)).resolves.toBe(true);
    expect(ok.calls[0].args).toEqual(["bb", "api", "--help"]);

    const old = routed({ "--help": new Error("unrecognized subcommand 'api'") });
    await expect(probeBbApi(old.run, () => BB)).resolves.toBe(false);
  });
});

describe("probeBb", () => {
  it("authenticates against Bitbucket specifically", async () => {
    const { run, calls } = routed({ "auth": "" });
    await expect(probeBb(run, () => BB)).resolves.toBeNull();
    expect(calls[0].args).toEqual(["auth", "test", "--bitbucket"]);
  });

  it("blames the install only for ENOENT", async () => {
    const missing = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    await expect(probeBb(routed({ auth: missing }).run, () => BB))
      .resolves.toMatchObject({ kind: "missing" });
    // Anything else came from a CLI that ran, so blaming the install would send
    // the user hunting for a binary they already have.
    await expect(probeBb(routed({ auth: new Error("401 Unauthorized") }).run, () => BB))
      .resolves.toMatchObject({ kind: "signed-out" });
  });
});

describe("BbProvider.fetch — projected mode", () => {
  it("reads the remote, lists open PRs, and matches the branch client-side", async () => {
    const { run, calls } = routed({
      "remote.origin.url": REMOTE,
      "pipeline": JSON.stringify([{ build_number: 7, state: "SUCCESSFUL" }]),
      "pr": JSON.stringify([PROJECTED_OTHER_BRANCH, PROJECTED_ROW]),
    });
    const res = await provider(run, false).fetch("/repos/api-service", "feat/ASM-1", "ASM-1");
    // #42 is the BRANCH match; #99 shares the task key in its title and would win
    // the key selector outright, since `pickBbPr` breaks a tie by newest id. So
    // this number is the branch matcher's own signature — neuter that filter and
    // the fetch returns 99 instead of failing to find anything, which is how it
    // stayed unpinned before. This matcher is what EVERY projected user gets.
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({ number: 42, state: "OPEN" }) });
    expect(PROJECTED_OTHER_BRANCH.id).toBeGreaterThan(PROJECTED_ROW.id); // the premise, pinned

    // Argv is what actually reached the CLI — the honest thing to pin. An
    // exported path helper would only let this test agree with itself about a
    // string the CLI never saw.
    expect(calls[1].args).toEqual([
      "--workspace", "acme", "bb", "pr", "list", "api-service",
      "--state", "OPEN", "--limit", "25", "--format", "json",
    ]);
    expect(calls[1].cwd).toBe("/repos/api-service");
  });

  it("falls back to a title match on the task key when no branch matches", async () => {
    const { run } = routed({
      "remote.origin.url": REMOTE,
      "pipeline": JSON.stringify([]),
      // The decoy carries the higher id and no task key, so a key selector that
      // matched everything would pick 99 rather than 42.
      "pr": JSON.stringify([
        { ...PROJECTED_ROW, id: 99, title: "unrelated work", source: "other" },
        PROJECTED_ROW,
      ]),
    });
    const res = await provider(run, false).fetch("/repos/api-service", "some/other-branch", "ASM-1");
    expect(res).toMatchObject({ ok: true, facts: { number: 42 } });
  });

  it("reports no PR — not a failure — when nothing matches", async () => {
    const { run } = routed({ "remote.origin.url": REMOTE, "pr": JSON.stringify([]) });
    await expect(provider(run, false).fetch("/r", "feat/x", "ASM-9")).resolves.toEqual({ ok: true, facts: null });
  });
});

describe("BbProvider.fetch — passthrough mode", () => {
  it("filters server-side and fills draft, review, conflicts and statuses", async () => {
    const { run, calls } = routed({
      "remote.origin.url": REMOTE,
      "/statuses": JSON.stringify({ values: [{ state: "SUCCESSFUL", name: "Pipeline" }] }),
      "/conflicts": JSON.stringify({ values: [] }),
      "/comments": JSON.stringify({ values: [] }),
      "source.branch.name": JSON.stringify({ values: [LIST_ROW] }),
      "pullrequests/42": shown(),
    });
    const res = await provider(run, true).fetch("/repos/api-service", "feat/ASM-1", "ASM-1");
    expect(res).toMatchObject({
      ok: true,
      facts: {
        number: 42,
        url: "https://bitbucket.org/acme/api-service/pull-requests/42",
        review: "approved",
        mergeable: "clean",
        unresolved: 0,
        ci: { passing: 1, pending: 0, failing: [] },
      },
    });
    expect(calls[1].args[0]).toBe("bb");
    expect(calls[1].args[1]).toBe("api");
    // The branch VALUE is percent-encoded (its `/` becomes `%2F`); the filter's
    // own `=`, `"` and the trailing `&state=OPEN&pagelen=10` clause stay literal.
    expect(calls[1].args[2]).toContain('/2.0/repositories/acme/api-service/pullrequests?q=source.branch.name="feat%2FASM-1"&state=OPEN&pagelen=10');
  });

  it("encodes a branch's `&` as a value, so the filter's own `&state=OPEN` clause survives intact", async () => {
    // Unescaped, a branch named `feat/a&b` would inject a bogus `b="` query
    // param and truncate `&state=OPEN&pagelen=10` off the end — the search
    // would then return PRs of ANY state, not just OPEN ones. This is the case
    // ruling G exists to pin: mutate the value-encoding back to raw
    // interpolation and this must go red.
    const { run, calls } = routed({
      "remote.origin.url": REMOTE,
      "source.branch.name": JSON.stringify({ values: [LIST_ROW] }),
      "pullrequests/42": shown(),
    });
    await provider(run, true).fetch("/repos/api-service", "feat/a&b", "ASM-1");
    expect(calls[1].args[2]).toContain('q=source.branch.name="feat%2Fa%26b"&state=OPEN&pagelen=10');
  });

  // The KEY clause, which no test routed before: with the branch search empty,
  // the fallback must actually be issued, and ruling G's value-encoding applies to
  // its interpolated key exactly as it does to the branch clause above. Deleting
  // the fallback entirely used to leave all 24 tests green.
  it("falls back to a server-side `title~` search, with the key encoded as a value", async () => {
    const { run, calls } = routed({
      "remote.origin.url": REMOTE,
      "/statuses": JSON.stringify({ values: [] }),
      "/conflicts": JSON.stringify({ values: [] }),
      "/comments": JSON.stringify({ values: [] }),
      "source.branch.name": JSON.stringify({ values: [] }),
      "title~": JSON.stringify({ values: [LIST_ROW] }),
      "pullrequests/42": shown(),
    });
    const res = await provider(run, true).fetch("/repos/api-service", "feat/ASM-1", "ASM-1&2");

    expect(res).toMatchObject({ ok: true, facts: { number: 42 } });
    const search = calls.find((c) => c.args.some((a) => a.includes("title~")))!;
    // Unescaped, the key's `&` would inject a bogus query param and truncate
    // `&state=OPEN&pagelen=10` off the end — the search would then return PRs of
    // ANY state. The filter's own `=`, `~` and `"` stay literal.
    expect(search.args[2]).toContain('q=title~"ASM-1%262"&state=OPEN&pagelen=10');
  });

  it("does not run the key search at all when the branch search already found the PR", async () => {
    const { run, calls } = routed({
      "remote.origin.url": REMOTE,
      "/statuses": JSON.stringify({ values: [] }),
      "/conflicts": JSON.stringify({ values: [] }),
      "/comments": JSON.stringify({ values: [] }),
      "source.branch.name": JSON.stringify({ values: [LIST_ROW] }),
      "pullrequests/42": shown(),
    });
    await provider(run, true).fetch("/repos/api-service", "feat/ASM-1", "ASM-1");
    expect(calls.some((c) => c.args.some((a) => a.includes("title~")))).toBe(false);
  });

  // THE regression test for the bug this file's fixtures hid: Bitbucket's list
  // response is a PARTIAL representation carrying neither `participants` nor
  // `draft`, so a provider that maps from the list row reports `review: "none"`
  // and `isDraft: false` on every card forever — and, through
  // `makeBitbucketForge.resolveCaps`, leaves an armed `changes-requested` rule
  // waiting on a state it can never see. Both facts reach us only through the
  // single-PR read. Delete that `show` call and this goes red.
  it("reads review and draft from the single-PR route, because the list row carries neither", async () => {
    const { run, calls } = routed({
      "remote.origin.url": REMOTE,
      "/statuses": JSON.stringify({ values: [] }),
      "/conflicts": JSON.stringify({ values: [] }),
      "/comments": JSON.stringify({ values: [] }),
      "source.branch.name": JSON.stringify({ values: [LIST_ROW] }),
      "pullrequests/42": shown({
        draft: true,
        participants: [
          { role: "REVIEWER", state: "approved", approved: true },
          { role: "REVIEWER", state: "changes_requested" },
        ],
      }),
    });
    const res = await provider(run, true).fetch("/repos/api-service", "feat/ASM-1", "ASM-1");

    // The premise, pinned: neither field is on a list row, ever.
    expect(LIST_ROW).not.toHaveProperty("participants");
    expect(LIST_ROW).not.toHaveProperty("draft");
    const show = calls.find((c) =>
      c.args.some((a) => a.endsWith("/2.0/repositories/acme/api-service/pullrequests/42")))!;
    expect(show.args.slice(0, 2)).toEqual(["bb", "api"]);
    expect(res).toMatchObject({ ok: true, facts: { number: 42, review: "changes_requested", isDraft: true } });
  });

  it("keeps the PR when a detail call fails, losing only that detail", async () => {
    const { run } = routed({
      "remote.origin.url": REMOTE,
      "/statuses": new Error("500"),
      "/conflicts": new Error("500"),
      "/comments": new Error("500"),
      "source.branch.name": JSON.stringify({ values: [LIST_ROW] }),
      "pullrequests/42": shown(),
    });
    await expect(provider(run, true).fetch("/r", "feat/ASM-1", "ASM-1")).resolves.toMatchObject({
      ok: true,
      facts: { number: 42, mergeable: "unknown", unresolved: null, ci: { passing: 0, pending: 0, failing: [] } },
    });
  });

  // The single-PR read is a detail like any other: it exists to add the review
  // verdict and the draft flag, so losing it must cost those two and nothing else.
  // Drop the `?? found` fallback and this returns `{ ok: false }` instead — the PR
  // the user has open vanishes from the card because one optional round trip
  // failed. Asserted whole, not with objectContaining, so the fallback is pinned to
  // preserve every fact the list row already had right.
  it("still returns the list row's facts when the single-PR read fails", async () => {
    const { run } = routed({
      "remote.origin.url": REMOTE,
      "/statuses": JSON.stringify({ values: [] }),
      "/conflicts": JSON.stringify({ values: [] }),
      "/comments": JSON.stringify({ values: [] }),
      "source.branch.name": JSON.stringify({ values: [LIST_ROW] }),
      "pullrequests/42": new Error("500"),
    });
    await expect(provider(run, true).fetch("/r", "feat/ASM-1", "ASM-1")).resolves.toEqual({
      ok: true,
      facts: {
        number: 42,
        url: "https://bitbucket.org/acme/api-service/pull-requests/42",
        title: "ASM-1 add export",
        state: "OPEN",
        isDraft: false,
        ci: { passing: 0, pending: 0, failing: [] },
        review: "none",
        unresolved: 0,
        mergeable: "clean",
        ciAdvisory: false,
      },
    });
  });

  // An error body parses fine and is not a PR. Handing one to `toRestFacts` would
  // yield `facts: null` — "there is genuinely no pull request" — for a PR the list
  // just found, so anything without an identity falls back to the list row instead.
  it.each([
    ["an error object", '{"type":"error","error":{"message":"Not found"}}'],
    ["a null body", "null"],
    ["an array", "[]"],
    ["a record with no identity", '{"title":"ASM-1 add export"}'],
    // An empty href is no url: `toRestFacts` rejects on `!href`, so a guard that
    // accepted any string here would hand it a record it then turns into null.
    ["a record whose html href is empty", '{"id":42,"links":{"html":{"href":""}}}'],
  ])("falls back to the list row when the single-PR read answers with %s", async (_what, body) => {
    const { run } = routed({
      "remote.origin.url": REMOTE,
      "/statuses": JSON.stringify({ values: [] }),
      "/conflicts": JSON.stringify({ values: [] }),
      "/comments": JSON.stringify({ values: [] }),
      "source.branch.name": JSON.stringify({ values: [LIST_ROW] }),
      "pullrequests/42": body,
    });
    await expect(provider(run, true).fetch("/r", "feat/ASM-1", "ASM-1")).resolves.toMatchObject({
      ok: true,
      facts: { number: 42, title: "ASM-1 add export", url: "https://bitbucket.org/acme/api-service/pull-requests/42" },
    });
  });
});

describe("BbProvider.fetch — failure contract", () => {
  it("fails the fetch when the remote is not a Bitbucket one", async () => {
    // Not a curiosity: a GitHub remote would otherwise get bitbucket.org urls.
    const { run } = routed({ "remote.origin.url": "https://github.com/acme/api-service.git" });
    await expect(provider(run, false).fetch("/r", "b", "K")).resolves.toEqual({ ok: false });
  });

  it("fails the fetch rather than reading an error object as an empty list", async () => {
    const { run } = routed({
      "remote.origin.url": REMOTE,
      "pr": JSON.stringify({ message: "404 Not Found" }),
    });
    await expect(provider(run, false).fetch("/r", "b", "K")).resolves.toEqual({ ok: false });
  });

  it("never throws, whatever the runner does", async () => {
    // An uncaught throw here leaves the caller's cache entry unstamped, which
    // re-arms this repo's fetch on every 6s tick, forever.
    for (const reply of [new Error("boom"), "not json at all", "null"]) {
      const { run } = routed({ "remote.origin.url": REMOTE, "pr": reply, "pipeline": reply });
      await expect(provider(run, false).fetch("/r", "b", "K")).resolves.toEqual({ ok: false });
    }
  });

  it("probes the mode once, however many fetches run", async () => {
    let modeCalls = 0;
    const { run } = routed({ "remote.origin.url": REMOTE, "pr": JSON.stringify([]) });
    const p = new BbProvider(run, () => BB, async () => {
      modeCalls++;
      return false;
    });
    await p.fetch("/r", "b", "K");
    await p.fetch("/r", "b", "K");
    expect(modeCalls).toBe(2); // the forge memoizes, not the provider — see makeBitbucketForge
  });
});

describe("bbBranchCi", () => {
  it("grades the newest pipeline in each mode", async () => {
    const projected = routed({
      "remote.origin.url": REMOTE,
      "pipeline": JSON.stringify([{ build_number: 7, state: "FAILED" }]),
    });
    await expect(bbBranchCi(projected.run, () => BB, async () => false, "/r", "main")).resolves.toBe("failed");

    const rest = routed({
      "remote.origin.url": REMOTE,
      "pipelines": JSON.stringify({ values: [{ state: { name: "COMPLETED", result: { name: "SUCCESSFUL" } } }] }),
    });
    await expect(bbBranchCi(rest.run, () => BB, async () => true, "/r", "main")).resolves.toBe("passed");
  });

  it("answers unknown rather than throwing, and unknown is not green", async () => {
    const { run } = routed({ "remote.origin.url": REMOTE, "pipeline": new Error("timeout") });
    await expect(bbBranchCi(run, () => BB, async () => false, "/r", "main")).resolves.toBe("unknown");
  });
});

describe("BbProvider.merge", () => {
  it("maps each method to Bitbucket's own strategy name, in passthrough mode", async () => {
    for (const [method, strategy] of [["squash", "squash"], ["merge", "merge_commit"], ["rebase", "rebase_merge"]] as const) {
      const { run, calls } = routed({ "remote.origin.url": REMOTE, "/merge": "{}" });
      await expect(provider(run, true).merge("/r", 42, method)).resolves.toEqual({ ok: true });
      const merge = calls.find((c) => c.args.some((a) => a.includes("/merge")))!;
      expect(merge.args[2]).toContain("/2.0/repositories/acme/api-service/pullrequests/42/merge");
      expect(merge.args).toContain("POST");
      expect(merge.args.join(" ")).toContain(strategy);
    }
  });

  it("merges through the CLI's own subcommand in projected mode", async () => {
    const { run, calls } = routed({ "remote.origin.url": REMOTE, "merge": "{}" });
    await expect(provider(run, false).merge("/r", 42, "squash")).resolves.toEqual({ ok: true });
    const merge = calls.find((c) => c.args.includes("merge"))!;
    expect(merge.args).toEqual([
      "--workspace", "acme", "bb", "pr", "merge", "api-service", "42",
      "--strategy", "squash", "--format", "json",
    ]);
  });

  it("REFUSES rebase in projected mode instead of substituting a strategy", async () => {
    // The one degradation a user cannot see after the fact — the commit is
    // already made. Must name the setting so they can act on it.
    const { run, calls } = routed({ "remote.origin.url": REMOTE });
    const res = await provider(run, false).merge("/r", 42, "rebase");
    expect(res).toMatchObject({ ok: false });
    expect((res as { message: string }).message).toContain("agentFlow.mergeMethod");
    expect(calls.some((c) => c.args.includes("merge"))).toBe(false);
  });

  it("DOES rebase in passthrough mode, where Bitbucket's REST enum has one", async () => {
    // The one place Bitbucket beats GitLab, which has no per-request rebase at all.
    const { run } = routed({ "remote.origin.url": REMOTE, "/merge": "{}" });
    await expect(provider(run, true).merge("/r", 42, "rebase")).resolves.toEqual({ ok: true });
  });

  it("fails closed on a method outside the union, prototype keys included", async () => {
    // `calls.some(... includes("merge"))` is vacuous here: the passthrough merge
    // URL is one long path string (`.../pullrequests/42/merge`), never a
    // standalone "merge" token, so that assertion could not see a spawn that did
    // happen. With the guard correctly `Object.hasOwn`, the check fires before
    // `repoOf` is even reached, so zero spawns is the precise property — no argv
    // reaches the runner at all.
    const { run, calls } = routed({ "remote.origin.url": REMOTE });
    await expect(provider(run, true).merge("/r", 42, "constructor" as never)).resolves.toMatchObject({ ok: false });
    expect(calls.length).toBe(0);
  });

  it("fails when the checkout has no Bitbucket remote", async () => {
    // A `repoOf` git spawn is expected here (reading `remote.origin.url`), so
    // `calls.length === 0` would be wrong — the precise property is that no
    // atlassian-cli ("bb") merge spawn happened.
    const { run, calls } = routed({ "remote.origin.url": "https://github.com/acme/api-service.git" });
    await expect(provider(run, false).merge("/r", 42, "squash")).resolves.toMatchObject({ ok: false });
    expect(calls.some((c) => c.args.includes("bb"))).toBe(false);
  });

  it("says the merge may already have landed when the CLI is killed", async () => {
    // Not the same as a refusal: a merge is not idempotent, so claiming Bitbucket
    // refused would invite a retry that merges twice.
    const { run } = routed({
      "remote.origin.url": REMOTE,
      "merge": Object.assign(new Error("killed"), { killed: true }),
    });
    const res = await provider(run, false).merge("/r", 42, "squash");
    expect((res as { message: string }).message).toMatch(/may already have gone through/);
  });

  it("prefers the CLI's stderr over the reconstructed argv", async () => {
    const { run } = routed({
      "remote.origin.url": REMOTE,
      "merge": Object.assign(new Error("Command failed: /opt/homebrew/bin/atlassian-cli bb pr merge ..."), {
        stderr: "403 Forbidden: you do not have write access to this repository",
      }),
    });
    const res = await provider(run, false).merge("/r", 42, "squash");
    expect((res as { message: string }).message).toBe("403 Forbidden: you do not have write access to this repository");
  });

  it("names Bitbucket, not gh, when the CLI leaves no stderr and its message has no newline", async () => {
    // execFile produces a single-line `.message` with no `\n` when stderr is
    // empty. `stripCommandLine`'s own default fallback is gh's wording — this
    // provider is that function's first non-gh caller, so it must pass its own
    // fallback rather than inherit gh's.
    const { run } = routed({
      "remote.origin.url": REMOTE,
      "merge": new Error("Command failed: /opt/homebrew/bin/atlassian-cli bb pr merge api-service 42 --strategy squash"),
    });
    const res = await provider(run, false).merge("/r", 42, "squash");
    const message = (res as { message: string }).message;
    expect(message).not.toContain("gh");
    expect(message).not.toContain("--strategy squash");
  });
});
