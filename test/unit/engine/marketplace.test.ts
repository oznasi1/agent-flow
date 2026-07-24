import { describe, it, expect } from "vitest";
import { normalizeRepo, buildMarketplaceView, MarketplaceParseError } from "../../../src/engine/marketplace";

describe("normalizeRepo", () => {
  it("accepts owner/repo", () => {
    expect(normalizeRepo("anthropics/claude-plugins")).toBe("anthropics/claude-plugins");
  });
  it("trims whitespace and a trailing slash", () => {
    expect(normalizeRepo("  owner/repo/  ")).toBe("owner/repo");
  });
  it("parses an https URL and strips .git", () => {
    expect(normalizeRepo("https://github.com/owner/repo.git")).toBe("owner/repo");
  });
  it("parses an scp-style git@ URL", () => {
    expect(normalizeRepo("git@github.com:owner/repo.git")).toBe("owner/repo");
  });
  it("rejects a bare word", () => {
    expect(normalizeRepo("justaword")).toBeNull();
  });
  it("rejects empty / whitespace", () => {
    expect(normalizeRepo("   ")).toBeNull();
  });
  it("rejects a non-github host URL", () => {
    expect(normalizeRepo("https://gitlab.com/owner/repo")).toBeNull();
  });
  it("rejects a non-github scp-style URL", () => {
    expect(normalizeRepo("git@gitlab.com:owner/repo.git")).toBeNull();
  });
  it("rejects a slug half containing stray punctuation", () => {
    expect(normalizeRepo("owner/repo:branch")).toBeNull();
  });
  it("strips a trailing slash after .git in an scp URL", () => {
    expect(normalizeRepo("git@github.com:owner/repo.git/")).toBe("owner/repo");
  });
});

const ATBAY_MANIFEST = JSON.stringify({
  name: "atbay-plugins",
  owner: { name: "At-Bay plugins marketplace" },
  metadata: { description: "At-Bay's Claude Code plugin marketplace", pluginRoot: "./plugins" },
  plugins: [
    { name: "cicd-plugin", source: "./plugins/cicd-plugin", description: "CI/CD automation" },
    { name: "ui-ux-pro-max", source: "./plugins/ui-ux", description: "UI/UX design" },
  ],
});
const ATBAY_TREE = [
  ".claude-plugin/marketplace.json",
  "plugins/cicd-plugin/.claude-plugin/plugin.json",
  "plugins/cicd-plugin/commands/build.md",
  "plugins/cicd-plugin/commands/deploy.md",
  "plugins/cicd-plugin/agents/pipeline-agent.md",
  "plugins/cicd-plugin/skills/build/SKILL.md",
  "plugins/cicd-plugin/README.md",
  "plugins/ui-ux/.claude/skills/ui-ux-pro-max/SKILL.md", // custom (non-conventional) skill path
];

describe("buildMarketplaceView", () => {
  it("derives marketplace name, description, owner and addCommand", () => {
    const v = buildMarketplaceView("cyberjackgit/atbay-plugins", ATBAY_MANIFEST, ATBAY_TREE);
    expect(v.name).toBe("atbay-plugins");
    expect(v.owner).toBe("At-Bay plugins marketplace");
    expect(v.description).toBe("At-Bay's Claude Code plugin marketplace");
    expect(v.addCommand).toBe("/plugin marketplace add cyberjackgit/atbay-plugins");
    expect(v.error).toBeUndefined();
    expect(v.plugins).toHaveLength(2);
  });

  it("discovers skills/agents/commands by convention and builds installCommand", () => {
    const v = buildMarketplaceView("cyberjackgit/atbay-plugins", ATBAY_MANIFEST, ATBAY_TREE);
    const cicd = v.plugins.find((p) => p.name === "cicd-plugin")!;
    expect(cicd.source).toBe("plugins/cicd-plugin");
    expect(cicd.commands.map((c) => c.name)).toEqual(["build", "deploy"]);
    expect(cicd.agents.map((a) => a.name)).toEqual(["pipeline-agent"]);
    expect(cicd.skills.map((s) => s.name)).toEqual(["build"]);
    expect(cicd.installCommand).toBe("/plugin install cicd-plugin@atbay-plugins");
  });

  it("discovers a skill under a non-conventional path (parent folder = skill name)", () => {
    const v = buildMarketplaceView("cyberjackgit/atbay-plugins", ATBAY_MANIFEST, ATBAY_TREE);
    const ui = v.plugins.find((p) => p.name === "ui-ux-pro-max")!;
    expect(ui.skills.map((s) => s.name)).toEqual(["ui-ux-pro-max"]);
    expect(ui.agents).toEqual([]);
    expect(ui.commands).toEqual([]);
  });

  it("falls back to metadata.description and repo name when top-level fields are absent", () => {
    const manifest = JSON.stringify({ metadata: { description: "meta desc" }, plugins: [] });
    const v = buildMarketplaceView("o/r", manifest, []);
    expect(v.name).toBe("o/r"); // no name → repo
    expect(v.description).toBe("meta desc");
    expect(v.owner).toBe("");
    expect(v.plugins).toEqual([]);
  });

  it("handles a commands-only plugin (empty skill/agent rows)", () => {
    const manifest = JSON.stringify({
      name: "official",
      plugins: [{ name: "commit-commands", source: "./plugins/commit-commands", description: "commits" }],
    });
    const tree = [
      "plugins/commit-commands/commands/commit.md",
      "plugins/commit-commands/commands/commit-push-pr.md",
    ];
    const v = buildMarketplaceView("anthropics/claude-plugins", manifest, tree);
    const p = v.plugins[0];
    expect(p.commands.map((c) => c.name).sort()).toEqual(["commit", "commit-push-pr"]);
    expect(p.skills).toEqual([]);
    expect(p.agents).toEqual([]);
  });

  it("resolves a nameless-source plugin under metadata.pluginRoot", () => {
    const manifest = JSON.stringify({
      name: "mkt",
      metadata: { pluginRoot: "./plugins" },
      plugins: [{ name: "foo" }],
    });
    const tree = ["plugins/foo/skills/x/SKILL.md", "plugins/foo/commands/run.md"];
    const v = buildMarketplaceView("o/r", manifest, tree);
    const p = v.plugins[0];
    expect(p.source).toBe("plugins/foo");
    expect(p.skills.map((s) => s.name)).toEqual(["x"]);
    expect(p.commands.map((c) => c.name)).toEqual(["run"]);
  });

  it("throws MarketplaceParseError on malformed JSON", () => {
    expect(() => buildMarketplaceView("o/r", "{ not json", [])).toThrow(MarketplaceParseError);
  });
});

import { fetchMarketplace, GhRunner } from "../../../src/engine/marketplace";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

// A GhRunner scripted by matching a substring of the joined args.
function runner(map: { treePaths?: string[]; manifest?: string; fail?: (args: string[]) => Partial<GhResultLike> | null }): GhRunner {
  return async (args: string[]) => {
    const joined = args.join(" ");
    const forced = map.fail?.(args);
    if (forced) return { ok: false, stdout: "", stderr: "", ...forced } as any;
    if (joined.includes("git/trees")) {
      return { ok: true, stdout: (map.treePaths ?? []).join("\n"), stderr: "" };
    }
    if (joined.includes("marketplace.json")) {
      return { ok: true, stdout: b64(map.manifest ?? "{}"), stderr: "" };
    }
    return { ok: false, stdout: "", stderr: "unexpected" };
  };
}
type GhResultLike = { ok: boolean; stdout: string; stderr: string };

describe("fetchMarketplace", () => {
  it("returns a built view on success", async () => {
    const manifest = JSON.stringify({ name: "mkt", plugins: [{ name: "p", source: "./p", description: "d" }] });
    const v = await fetchMarketplace("o/r", runner({ treePaths: ["p/skills/x/SKILL.md"], manifest }));
    expect(v.error).toBeUndefined();
    expect(v.name).toBe("mkt");
    expect(v.plugins[0].skills[0].name).toBe("x");
  });

  it("maps a missing gh binary (ENOENT) to gh-missing", async () => {
    const run: GhRunner = async () => { const e: any = new Error("spawn gh ENOENT"); e.code = "ENOENT"; throw e; };
    const v = await fetchMarketplace("o/r", run);
    expect(v.error?.kind).toBe("gh-missing");
  });

  it("maps an auth failure to gh-unauthenticated", async () => {
    const v = await fetchMarketplace("o/r", runner({ fail: () => ({ stderr: "gh auth login required (HTTP 401)" }) }));
    expect(v.error?.kind).toBe("gh-unauthenticated");
  });

  it("maps a 404 on the tree call to repo-not-found", async () => {
    const v = await fetchMarketplace("o/r", runner({ fail: (a) => (a.join(" ").includes("git/trees") ? { stderr: "gh: Not Found (HTTP 404)" } : null) }));
    expect(v.error?.kind).toBe("repo-not-found");
  });

  it("maps a 404 on the manifest to not-a-marketplace", async () => {
    const v = await fetchMarketplace("o/r", runner({ treePaths: [], fail: (a) => (a.join(" ").includes("marketplace.json") ? { stderr: "gh: Not Found (HTTP 404)" } : null) }));
    expect(v.error?.kind).toBe("not-a-marketplace");
  });

  it("maps malformed manifest JSON to parse-error", async () => {
    const v = await fetchMarketplace("o/r", runner({ treePaths: [], manifest: "{ nope" }));
    expect(v.error?.kind).toBe("parse-error");
  });
});
