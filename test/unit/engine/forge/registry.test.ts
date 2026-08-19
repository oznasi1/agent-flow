import { describe, it, expect, vi } from "vitest";
import { FORGE_IDS, resolveForge } from "../../../../src/engine/forge/registry";
import type { Runner } from "../../../../src/engine/pr/provider";

const never: Runner = async () => { throw new Error("no call expected"); };

describe("FORGE_IDS", () => {
  it("lists both shipped forges, github first", () => {
    expect(FORGE_IDS).toEqual(["github", "gitlab"]);
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

  it("falls back to github, and says so, for an unknown id", () => {
    const log = vi.fn();
    expect(resolveForge("bitbucket", log, never).id).toBe("github");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("bitbucket"));
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
