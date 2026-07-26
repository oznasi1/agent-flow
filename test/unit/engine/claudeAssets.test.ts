import { describe, it, expect } from "vitest";
import { parseFrontmatter } from "../../../src/engine/claudeAssets";

describe("parseFrontmatter", () => {
  it("reads flat name and description", () => {
    const fm = parseFrontmatter("---\nname: build\ndescription: Builds the thing\n---\nbody");
    expect(fm.name).toBe("build");
    expect(fm.description).toBe("Builds the thing");
  });

  it("folds a multi-line description into one value", () => {
    const text = [
      "---",
      "name: wrap-up",
      "description: Wrap up the branch —",
      "  verify coverage,",
      "  then review.",
      "---",
    ].join("\n");
    expect(parseFrontmatter(text).description).toBe("Wrap up the branch — verify coverage, then review.");
  });

  it("strips surrounding quotes", () => {
    expect(parseFrontmatter(`---\nname: "quoted"\ndescription: 'single'\n---`).name).toBe("quoted");
    expect(parseFrontmatter(`---\nname: "quoted"\ndescription: 'single'\n---`).description).toBe("single");
  });

  it("returns an empty object when there is no frontmatter", () => {
    expect(parseFrontmatter("# Just a heading\n")).toEqual({});
  });

  it("ignores a --- that appears after the body has started", () => {
    const fm = parseFrontmatter("---\nname: a\n---\nbody\n---\nname: b\n---");
    expect(fm.name).toBe("a");
  });

  it("tolerates CRLF line endings", () => {
    expect(parseFrontmatter("---\r\nname: crlf\r\n---\r\n").name).toBe("crlf");
  });

  it("ignores keys with no value and unparseable lines", () => {
    const fm = parseFrontmatter("---\nname: ok\nnot a key value line\n---");
    expect(fm.name).toBe("ok");
  });
});

import { discoverAssets, memReader } from "../../../src/engine/claudeAssets";

const ATTR = { plugin: "cicd-plugin", marketplace: "atbay-plugins", category: "deployment", state: "installed" as const, enabled: true };

describe("discoverAssets", () => {
  it("finds a skill at any depth, naming it from the parent folder", () => {
    const r = memReader({ "/p/skills/build/SKILL.md": "", "/p/.claude/skills/deep/SKILL.md": "" });
    const names = discoverAssets(r, "/p", ATTR).filter((a) => a.type === "skill").map((a) => a.name);
    expect(names).toEqual(["build", "deep"]);
  });

  it("prefers the frontmatter name over the folder name", () => {
    const r = memReader({ "/p/skills/folder/SKILL.md": "---\nname: real-name\ndescription: d\n---" });
    const s = discoverAssets(r, "/p", ATTR)[0];
    expect(s.name).toBe("real-name");
    expect(s.description).toBe("d");
  });

  it("namespaces nested commands with a colon", () => {
    const r = memReader({ "/p/commands/db/migrate.md": "", "/p/commands/build.md": "" });
    const names = discoverAssets(r, "/p", ATTR).filter((a) => a.type === "command").map((a) => a.name);
    expect(names).toEqual(["build", "db:migrate"]);
  });

  it("finds agents and carries attribution onto every asset", () => {
    const r = memReader({ "/p/agents/pipeline.md": "---\nname: pipeline-agent\n---" });
    const a = discoverAssets(r, "/p", ATTR)[0];
    expect(a.type).toBe("agent");
    expect(a.name).toBe("pipeline-agent");
    expect(a.plugin).toBe("cicd-plugin");
    expect(a.marketplace).toBe("atbay-plugins");
    expect(a.state).toBe("installed");
    expect(a.enabled).toBe(true);
    expect(a.file).toBe("/p/agents/pipeline.md");
    expect(a.rel).toBe("agents/pipeline.md");
  });

  it("flattens the nested hooks.json shape", () => {
    const r = memReader({
      "/p/hooks/hooks.json": JSON.stringify({
        hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "node hook.js" }] }] },
      }),
    });
    const h = discoverAssets(r, "/p", ATTR).filter((a) => a.type === "hook");
    expect(h).toHaveLength(1);
    expect(h[0].name).toBe("SessionStart");
    expect(h[0].description).toBe("node hook.js");
  });

  it("flattens the bare hooks.json shape and keeps the matcher in rel", () => {
    const r = memReader({
      "/p/hooks/hooks.json": JSON.stringify({
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }],
      }),
    });
    const h = discoverAssets(r, "/p", ATTR).filter((a) => a.type === "hook");
    expect(h[0].name).toBe("PreToolUse");
    expect(h[0].rel).toContain("Bash");
  });

  it("keeps hooks that share an event and matcher distinguishable by their if guard", () => {
    const r = memReader({
      "/p/hooks/hooks.json": JSON.stringify({
        PostToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: "review.sh", if: "Bash(git commit:*)" },
              { type: "command", command: "review.sh", if: "Bash(git push:*)" },
            ],
          },
        ],
      }),
    });
    const h = discoverAssets(r, "/p", ATTR).filter((a) => a.type === "hook");
    expect(h).toHaveLength(2);
    expect(h[0].rel).toContain("git commit");
    expect(h[1].rel).toContain("git push");
    expect(h[0].rel).not.toBe(h[1].rel);
  });

  it("ignores malformed hooks.json without throwing", () => {
    const r = memReader({ "/p/hooks/hooks.json": "{ not json" });
    expect(discoverAssets(r, "/p", ATTR)).toEqual([]);
  });

  it("skips .git, node_modules and tests directories", () => {
    const r = memReader({
      "/p/.git/skills/x/SKILL.md": "",
      "/p/node_modules/pkg/skills/y/SKILL.md": "",
      "/p/tests/skills/z/SKILL.md": "",
      "/p/skills/keep/SKILL.md": "",
    });
    expect(discoverAssets(r, "/p", ATTR).map((a) => a.name)).toEqual(["keep"]);
  });

  it("stops descending past the depth cap", () => {
    const deep = "/p/" + Array.from({ length: 12 }, (_, i) => `d${i}`).join("/") + "/skills/x/SKILL.md";
    expect(discoverAssets(memReader({ [deep]: "" }), "/p", ATTR)).toEqual([]);
  });

  it("returns nothing for a directory that does not exist", () => {
    expect(discoverAssets(memReader({}), "/nope", ATTR)).toEqual([]);
  });

  it("ignores non-markdown files in commands and agents", () => {
    const r = memReader({ "/p/commands/README.txt": "", "/p/agents/notes.json": "" });
    expect(discoverAssets(r, "/p", ATTR)).toEqual([]);
  });
});

import { resolveEnabled, scanClaudeAssets } from "../../../src/engine/claudeAssets";

describe("resolveEnabled", () => {
  it("returns null when the ref appears nowhere", () => {
    expect(resolveEnabled("p@m", [{ enabledPlugins: {} }])).toBeNull();
  });

  it("reads a plain true/false", () => {
    expect(resolveEnabled("p@m", [{ enabledPlugins: { "p@m": false } }])).toBe(false);
  });

  it("lets a later layer override an earlier one", () => {
    const layers = [{ enabledPlugins: { "p@m": true } }, { enabledPlugins: { "p@m": false } }];
    expect(resolveEnabled("p@m", layers)).toBe(false);
  });

  it("ignores a layer that does not mention the ref", () => {
    const layers = [{ enabledPlugins: { "p@m": true } }, { enabledPlugins: { "other@m": false } }];
    expect(resolveEnabled("p@m", layers)).toBe(true);
  });
});

const CLAUDE = "/home/u/.claude";
const P = `${CLAUDE}/plugins`;

/** A fixture with one github marketplace holding three plugins, one of each state. */
function fixture(extra: Record<string, string> = {}): Record<string, string> {
  const mkt = `${P}/marketplaces/atbay`;
  return {
    [`${P}/known_marketplaces.json`]: JSON.stringify({
      atbay: { source: { source: "github", repo: "org/atbay" }, installLocation: mkt },
    }),
    [`${P}/installed_plugins.json`]: JSON.stringify({
      version: 2,
      plugins: {
        "installed-one@atbay": [
          { scope: "user", version: "1.2.3", installPath: `${P}/cache/atbay/installed-one/1.2.3` },
        ],
      },
    }),
    [`${CLAUDE}/settings.json`]: JSON.stringify({
      enabledPlugins: { "installed-one@atbay": true, "clone-one@atbay": false },
      skillOverrides: { "off-skill": "off" },
    }),
    [`${mkt}/.claude-plugin/marketplace.json`]: JSON.stringify({
      name: "atbay",
      metadata: { pluginRoot: "./plugins" },
      plugins: [
        { name: "installed-one", description: "installed", source: "./plugins/installed-one" },
        { name: "clone-one", description: "in the clone", source: "./plugins/clone-one" },
        { name: "remote-one", description: "elsewhere", source: { source: "github", repo: "x/y" } },
      ],
    }),
    [`${P}/cache/atbay/installed-one/1.2.3/skills/from-cache/SKILL.md`]: "---\ndescription: cached\n---",
    [`${mkt}/plugins/installed-one/skills/from-clone/SKILL.md`]: "",
    [`${mkt}/plugins/clone-one/commands/run.md`]: "---\ndescription: runs\n---",
    ...extra,
  };
}
const scan = (tree: Record<string, string>, opts: Partial<Parameters<typeof scanClaudeAssets>[1]> = {}) =>
  scanClaudeAssets(memReader(tree), { claudeDir: CLAUDE, now: 1000, ...opts });

describe("scanClaudeAssets", () => {
  it("flags notSetUp when there is no plugins dir", () => {
    const v = scan({});
    expect(v.notSetUp).toBe(true);
    expect(v.assets).toEqual([]);
    expect(v.scannedAt).toBe(1000);
  });

  it("lists the marketplace with its origin and plugin count", () => {
    const v = scan(fixture());
    expect(v.marketplaces).toHaveLength(1);
    expect(v.marketplaces[0]).toMatchObject({ name: "atbay", kind: "github", origin: "org/atbay", pluginCount: 3, stale: false });
    expect(v.notSetUp).toBe(false);
  });

  it("reads an installed plugin from its cache installPath, not the clone", () => {
    const v = scan(fixture());
    const names = v.assets.filter((a) => a.plugin === "installed-one").map((a) => a.name);
    expect(names).toEqual(["from-cache"]);
    expect(v.plugins.find((p) => p.name === "installed-one")).toMatchObject({
      state: "installed", enabled: true, version: "1.2.3", scopes: ["user"],
      installCommand: "/plugin install installed-one@atbay",
    });
  });

  it("reads a not-installed plugin from the marketplace clone", () => {
    const v = scan(fixture());
    const p = v.plugins.find((x) => x.name === "clone-one")!;
    expect(p.state).toBe("clone");
    expect(p.enabled).toBe(false);
    expect(p.counts.command).toBe(1);
    expect(v.assets.find((a) => a.plugin === "clone-one")!.name).toBe("run");
  });

  it("marks a plugin whose source is an object as manifest-only with no assets", () => {
    const v = scan(fixture());
    const p = v.plugins.find((x) => x.name === "remote-one")!;
    expect(p.state).toBe("manifest");
    expect(p.enabled).toBeNull();
    expect(p.counts).toEqual({ skill: 0, command: 0, agent: 0, hook: 0 });
    expect(v.assets.some((a) => a.plugin === "remote-one")).toBe(false);
  });

  it("falls back to pluginRoot/name when a plugin omits source", () => {
    const tree = fixture();
    const mkt = `${P}/marketplaces/atbay`;
    tree[`${mkt}/.claude-plugin/marketplace.json`] = JSON.stringify({
      name: "atbay", metadata: { pluginRoot: "./plugins" }, plugins: [{ name: "no-source" }],
    });
    tree[`${mkt}/plugins/no-source/skills/found/SKILL.md`] = "";
    const v = scan(tree);
    expect(v.plugins.find((p) => p.name === "no-source")!.state).toBe("clone");
    expect(v.assets.map((a) => a.name)).toContain("found");
  });

  it("skips an install entry whose installPath is absent from disk", () => {
    const tree = fixture();
    tree[`${P}/installed_plugins.json`] = JSON.stringify({
      plugins: {
        "installed-one@atbay": [
          { scope: "user", version: "0.0.1", installPath: `${P}/cache/atbay/installed-one/gone` },
          { scope: "project", version: "1.2.3", installPath: `${P}/cache/atbay/installed-one/1.2.3` },
        ],
      },
    });
    const v = scan(tree);
    const p = v.plugins.find((x) => x.name === "installed-one")!;
    expect(p.state).toBe("installed");
    expect(p.version).toBe("1.2.3");
  });

  it("marks a marketplace stale when its installLocation is gone", () => {
    const tree = fixture();
    tree[`${P}/known_marketplaces.json`] = JSON.stringify({
      atbay: { source: { source: "github", repo: "org/atbay" }, installLocation: `${P}/marketplaces/atbay` },
      ghost: { source: { source: "directory", path: "/nowhere" }, installLocation: "/nowhere" },
    });
    const v = scan(tree);
    expect(v.marketplaces.find((m) => m.name === "ghost")).toMatchObject({ stale: true, kind: "directory", pluginCount: 0 });
    expect(v.marketplaces.find((m) => m.name === "atbay")!.stale).toBe(false);
  });

  it("survives malformed JSON in a manifest without losing other marketplaces", () => {
    const tree = fixture();
    tree[`${P}/marketplaces/atbay/.claude-plugin/marketplace.json`] = "{ not json";
    const v = scan(tree);
    expect(v.notSetUp).toBe(false);
    expect(v.plugins).toEqual([]);
    expect(v.marketplaces[0].pluginCount).toBe(0);
  });

  it("marks a skill disabled when skillOverrides turns it off inside an enabled plugin", () => {
    const tree = fixture();
    tree[`${P}/cache/atbay/installed-one/1.2.3/skills/off-skill/SKILL.md`] = "";
    const v = scan(tree);
    const off = v.assets.find((a) => a.name === "off-skill")!;
    expect(off.enabled).toBe(false);
    expect(v.assets.find((a) => a.name === "from-cache")!.enabled).toBe(true);
  });

  it("surfaces ~/.claude assets under (user) with state user", () => {
    const tree = fixture({
      [`${CLAUDE}/skills/mine/SKILL.md`]: "---\ndescription: my skill\n---",
      [`${CLAUDE}/commands/wrap-up.md`]: "",
    });
    const v = scan(tree);
    const mine = v.assets.find((a) => a.name === "mine")!;
    expect(mine).toMatchObject({ plugin: "(user)", marketplace: "~/.claude", state: "user", enabled: true });
    expect(v.assets.some((a) => a.plugin === "(user)" && a.name === "wrap-up")).toBe(true);
    expect(v.marketplaces.some((m) => m.kind === "user")).toBe(true);
  });

  it("surfaces workspace assets under (workspace)", () => {
    const tree = fixture({ "/ws/.claude/skills/proj/SKILL.md": "" });
    const v = scan(tree, { workspaceDir: "/ws", workspaceName: "my-repo" });
    expect(v.assets.find((a) => a.name === "proj")).toMatchObject({
      plugin: "(workspace)", marketplace: "my-repo", state: "user",
    });
  });

  it("surfaces settings-level hooks under (user)", () => {
    const tree = fixture();
    tree[`${CLAUDE}/settings.json`] = JSON.stringify({
      hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "notify.js" }] }] },
    });
    const v = scan(tree);
    const h = v.assets.find((a) => a.type === "hook" && a.plugin === "(user)")!;
    expect(h.name).toBe("SessionStart");
    expect(h.description).toBe("notify.js");
  });

  it("lets workspace settings.local.json override the user layer", () => {
    const tree = fixture({
      "/ws/.claude/settings.json": JSON.stringify({ enabledPlugins: { "installed-one@atbay": false } }),
      "/ws/.claude/settings.local.json": JSON.stringify({ enabledPlugins: { "installed-one@atbay": true } }),
    });
    const v = scan(tree, { workspaceDir: "/ws", workspaceName: "ws" });
    expect(v.plugins.find((p) => p.name === "installed-one")!.enabled).toBe(true);
  });
});

describe("scanClaudeAssets categories", () => {
  const tree = (over: Record<string, string> = {}) => ({
    "/h/.claude/plugins/known_marketplaces.json": JSON.stringify({
      atbay: { installLocation: "/mk", source: { source: "github", repo: "org/atbay" } },
    }),
    "/h/.claude/plugins/installed_plugins.json": JSON.stringify({ plugins: {} }),
    "/mk/.claude-plugin/marketplace.json": JSON.stringify({
      name: "atbay",
      plugins: [
        { name: "cicd", description: "Ships things", category: "Deployment" },
        { name: "plain", description: "No category" },
      ],
    }),
    "/mk/cicd/skills/build/SKILL.md": "---\nname: build\ndescription: d\n---",
    "/mk/cicd/hooks/hooks.json": JSON.stringify({ PreToolUse: [{ hooks: [{ command: "x.sh" }] }] }),
    "/mk/cicd/README.md": "# cicd",
    "/mk/plain/skills/other/SKILL.md": "---\nname: other\ndescription: d\n---",
    ...over,
  });
  const scan = (over?: Record<string, string>) =>
    scanClaudeAssets(memReader(tree(over)), { claudeDir: "/h/.claude", now: 1 });

  it("lower-cases the manifest category onto the plugin and its assets", () => {
    const v = scan();
    expect(v.plugins.find((p) => p.name === "cicd")!.category).toBe("deployment");
    expect(v.assets.find((a) => a.name === "build")!.category).toBe("deployment");
  });

  it("carries the category onto hooks too", () => {
    expect(scan().assets.find((a) => a.type === "hook")!.category).toBe("deployment");
  });

  it("falls back to uncategorized when the manifest omits the field", () => {
    const v = scan();
    expect(v.plugins.find((p) => p.name === "plain")!.category).toBe("uncategorized");
    expect(v.assets.find((a) => a.name === "other")!.category).toBe("uncategorized");
  });

  it("resolves a README in the plugin's content dir, case-insensitively", () => {
    expect(scan().plugins.find((p) => p.name === "cicd")!.readme).toBe("/mk/cicd/README.md");
    expect(scan().plugins.find((p) => p.name === "plain")!.readme).toBe("");
    const lower = scan({ "/mk/plain/readme.md": "# plain" });
    expect(lower.plugins.find((p) => p.name === "plain")!.readme).toBe("/mk/plain/readme.md");
  });

  it("labels your own assets 'yours' and gives their row no readme", () => {
    const v = scan({ "/h/.claude/skills/mine/SKILL.md": "---\nname: mine\ndescription: d\n---" });
    expect(v.assets.find((a) => a.name === "mine")!.category).toBe("yours");
    expect(v.plugins.find((p) => p.name === "(user)")!.category).toBe("yours");
    expect(v.plugins.find((p) => p.name === "(user)")!.readme).toBe("");
  });
});
