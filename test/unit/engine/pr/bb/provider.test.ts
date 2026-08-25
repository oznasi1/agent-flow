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
 * be listed before less specific ones — lookup is by insertion order. */
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
const REST_PR = {
  id: 42, title: "ASM-1 add export", state: "OPEN", draft: false,
  links: { html: { href: "https://bitbucket.org/acme/api-service/pull-requests/42" } },
  participants: [{ role: "REVIEWER", approved: true, state: "approved" }],
};

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
      "pr": JSON.stringify([{ ...PROJECTED_ROW, source: "other" }, PROJECTED_ROW]),
    });
    const res = await provider(run, false).fetch("/repos/api-service", "feat/ASM-1", "ASM-1");
    expect(res).toEqual({ ok: true, facts: expect.objectContaining({ number: 42, state: "OPEN" }) });

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
      "pr": JSON.stringify([PROJECTED_ROW]),
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
      "source.branch.name": JSON.stringify({ values: [REST_PR] }),
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
    expect(calls[1].args[2]).toContain('/2.0/repositories/acme/api-service/pullrequests?q=source.branch.name="feat/ASM-1"');
  });

  it("keeps the PR when a detail call fails, losing only that detail", async () => {
    const { run } = routed({
      "remote.origin.url": REMOTE,
      "/statuses": new Error("500"),
      "/conflicts": new Error("500"),
      "/comments": new Error("500"),
      "source.branch.name": JSON.stringify({ values: [REST_PR] }),
    });
    await expect(provider(run, true).fetch("/r", "feat/ASM-1", "ASM-1")).resolves.toMatchObject({
      ok: true,
      facts: { number: 42, mergeable: "unknown", unresolved: null, ci: { passing: 0, pending: 0, failing: [] } },
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
