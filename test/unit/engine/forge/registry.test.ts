import { describe, it, expect, vi } from "vitest";
import { FORGE_IDS, resolveForge } from "../../../../src/engine/forge/registry";
import { makeBitbucketForge } from "../../../../src/engine/forge/bitbucket";
import type { Runner } from "../../../../src/engine/pr/provider";

const never: Runner = async () => { throw new Error("no call expected"); };

describe("FORGE_IDS", () => {
  // The registry's own pin on this list. Its title used to say "both shipped
  // forges" — a count that had been right since before Bitbucket existed, and
  // stopped being right the moment it did.
  //
  // The other pin lives in `test/unit/telemetry/settingsSnapshot.test.ts`, which
  // checks this list against the manifest's `agentFlow.forge` enum. That one is
  // a different assertion, not a duplicate of this one: it catches a forge
  // registered in code but never offered in settings.
  it("lists exactly the three registered forges, github first", () => {
    expect(FORGE_IDS).toEqual(["github", "gitlab", "bitbucket"]);
  });
});

describe("resolveForge", () => {
  it("returns the GitHub forge, which describes itself with gh's own name and install url", () => {
    const f = resolveForge("github", () => {}, never);
    expect(f.id).toBe("github");
    expect(f.label).toBe("GitHub");
    expect(f.cli).toEqual({ name: "gh", installUrl: "https://cli.github.com" });
    expect(f.caps.changesRequested).toBe(true);
  });

  it("returns the GitLab forge, which cannot report changes_requested", () => {
    const f = resolveForge("gitlab", () => {}, never);
    expect(f.id).toBe("gitlab");
    expect(f.label).toBe("GitLab");
    expect(f.cli).toEqual({ name: "glab", installUrl: "https://gitlab.com/gitlab-org/cli" });
    expect(f.caps.changesRequested).toBe(false);
  });

  // This test previously used "bitbucket" as its example unknown id, and broke
  // the day Bitbucket became a registered forge. A deliberately non-real string
  // like "not-a-forge" protects the test from becoming stale if (when) forge #4
  // arrives. Naming another plausible forge like "gitea" or "sourcehut" would
  // just re-arm the same trap.
  it("falls back to github, and says so, for an unknown id", () => {
    const log = vi.fn();
    expect(resolveForge("not-a-forge", log, never).id).toBe("github");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("not-a-forge"));
  });

  // `agentFlow.forge` comes from settings.json and can be any string. A bare index
  // would resolve a prototype key to a truthy non-factory and then call it.
  it.each(["constructor", "__proto__", "toString"])("falls back to github for the prototype key %s", (id) => {
    expect(resolveForge(id, () => {}, never).id).toBe("github");
  });

  // Not a prototype key, and it never reaches here in practice: `getConfig`
  // normalizes a blank `agentFlow.forge` to "github" before `resolveForge` is
  // called. Pinned anyway, and separately, because `resolveForge` is exported and
  // a caller that skips getConfig must still get a forge rather than a crash.
  it("falls back to github for an empty id", () => {
    expect(resolveForge("", () => {}, never).id).toBe("github");
  });

  it("both shipped forges can answer a review search, and neither needs a runtime probe", () => {
    for (const id of ["github", "gitlab"]) {
      const f = resolveForge(id, () => {});
      expect(f.caps.reviewSearch).toBe(true);
      // A forge whose caps are fully static omits resolveCaps, so deckView's
      // fallback to the static record is what runs for both of these.
      expect(f.resolveCaps).toBeUndefined();
    }
  });

  it("registers bitbucket, and names the binary rather than its alias", () => {
    const f = resolveForge("bitbucket", () => {});
    expect(f.id).toBe("bitbucket");
    expect(f.label).toBe("Bitbucket");
    // `bb` is a subcommand alias inside atlassian-cli, not a binary on PATH —
    // looking for one would find nothing, or find craftamap/bb, an unrelated tool.
    expect(f.cli.name).toBe("atlassian-cli");
  });

  it("reports bitbucket's static caps conservatively, and resolves the real ones", async () => {
    const f = resolveForge("bitbucket", () => {});
    // Static caps are what a forge claims before any probe. Claiming
    // changesRequested here would let armability promise a rule that a projected
    // build can never fire.
    expect(f.caps).toEqual({ changesRequested: false, reviewSearch: false, accounts: false });
    expect(typeof f.resolveCaps).toBe("function");
  });

  it("resolves changesRequested from the CLI's mode, and probes it once", async () => {
    let probes = 0;
    const run: Runner = async (_f, args) => {
      if (args.includes("--help")) {
        probes++;
        return "Usage: atlassian-cli bb api <PATH>";
      }
      return "";
    };
    const f = makeBitbucketForge(run);
    await expect(f.resolveCaps?.()).resolves.toEqual({ changesRequested: true, reviewSearch: false, accounts: false });
    await f.resolveCaps?.();
    // Memoized on the forge, so the PR provider, the review provider and this all
    // share one answer — a per-call probe would spawn on every card, every tick.
    expect(probes).toBe(1);
  });

  it("never claims a review queue, in either mode", async () => {
    // Not a CLI gap: Bitbucket Cloud has no cross-repo reviewer query at all, so
    // passthrough mode does not fix it either.
    const run: Runner = async (_f, args) =>
      args.includes("--help") ? "Usage: atlassian-cli bb api <PATH>" : "";
    const caps = await makeBitbucketForge(run).resolveCaps?.();
    expect(caps?.reviewSearch).toBe(false);
  });
});

describe("Forge.branchCi", () => {
  it("grades a GitHub rollup response", async () => {
    const run: Runner = async (_f, args) => {
      expect(args[0]).toBe("api");
      expect(args).toContain("graphql");
      return JSON.stringify({ data: { repository: { ref: { target: { statusCheckRollup: { state: "SUCCESS" } } } } } });
    };
    expect(await resolveForge("github", () => {}, run).branchCi("/r/api", "main")).toBe("passed");
  });

  it("grades a GitLab pipelines response", async () => {
    const run: Runner = async (_f, args) => {
      expect(args[1]).toContain("pipelines");
      return JSON.stringify([{ id: 1, status: "failed" }]);
    };
    expect(await resolveForge("gitlab", () => {}, run).branchCi("/r/api", "main")).toBe("failed");
  });

  it.each(["github", "gitlab"] as const)("answers unknown for %s when the call fails", async (id) => {
    const run: Runner = async () => { throw new Error("boom"); };
    expect(await resolveForge(id, () => {}, run).branchCi("/r/api", "main")).toBe("unknown");
  });

  it.each(["github", "gitlab"] as const)("answers unknown for %s on unparseable output", async (id) => {
    const run: Runner = async () => "not json";
    expect(await resolveForge(id, () => {}, run).branchCi("/r/api", "main")).toBe("unknown");
  });

  it("runs the call in the given repo directory", async () => {
    let cwd = "";
    const run: Runner = async (_f, _a, opts) => { cwd = opts.cwd; return "[]"; };
    await resolveForge("gitlab", () => {}, run).branchCi("/r/api", "main");
    expect(cwd).toBe("/r/api");
  });
});
