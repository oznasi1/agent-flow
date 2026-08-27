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

const ATTR = { plugin: "cicd-plugin", marketplace: "acme-plugins", category: "deployment", state: "installed" as const, enabled: true };

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
    expect(a.marketplace).toBe("acme-plugins");
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

import { resolveEnabled, resolveContentDir, scanClaudeAssets } from "../../../src/engine/claudeAssets";

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

// marketplace.json comes from a cloned third-party repo, so `source` and
// `metadata.pluginRoot` are attacker-controlled. resolveContentDir must never
// hand back a directory outside `installLocation`, no matter how the manifest
// tries to climb out of it.
describe("resolveContentDir containment", () => {
  const root = "/home/u/.claude/plugins/marketplaces/acme";

  it("refuses a source that climbs out of installLocation", () => {
    // memReader has no real ".." resolution — it matches literal path strings.
    // So a naive `${root}/${rel}` concatenation (the pre-fix bug) would find
    // this literal directory and treat it as a legitimate clone dir. Lexical
    // containment must refuse the source before that join ever happens.
    const reader = memReader({ [`${root}/../../../../etc/passwd`]: "root:x:0:0:root:/root:/bin/bash" });
    const { dir, state } = resolveContentDir(reader, { name: "evil", source: "../../../../etc" }, root, "", []);
    expect(state).toBe("manifest");
    expect(dir).toBe("");
  });

  it("contains a pluginRoot that climbs out via metadata, even with no source", () => {
    // No `source`, so resolveContentDir falls back to `${pluginRoot}/${name}` —
    // the literal path a naive join would have produced from this pluginRoot.
    const reader = memReader({ [`${root}/../../../../etc/p/x`]: "root:x:0:0:root:/root:/bin/bash" });
    const { dir, state } = resolveContentDir(reader, { name: "p" }, root, "../../../../etc", []);
    expect(state).toBe("manifest");
    expect(dir).toBe("");
  });

  it("resolves a legitimately dotted relative path onto installLocation", () => {
    const reader = memReader({ [`${root}/b/skills/x/SKILL.md`]: "" });
    const { dir, state } = resolveContentDir(reader, { name: "p", source: "a/../b" }, root, "", []);
    expect(state).toBe("clone");
    expect(dir).toBe(`${root}/b`);
  });

  it("refuses a source that climbs out using backslashes", () => {
    // Node on Windows treats "\" as a path separator even though POSIX doesn't —
    // splitting only on "/" left "..\..\.." as one opaque segment, so the pre-fix
    // `${root}/${rel}` concatenation landed on this exact literal string. Plant
    // it (memReader has no real ".." resolution) to prove the old split "finds" it.
    const reader = memReader({ [`${root}/..\\..\\../secret`]: "root:x:0:0:root:/root:/bin/bash" });
    const { dir, state } = resolveContentDir(reader, { name: "evil", source: "..\\..\\.." }, root, "", []);
    expect(state).toBe("manifest");
    expect(dir).toBe("");
  });

  it("resolves a legitimately dotted relative path written with backslashes", () => {
    // Consistent with the forward-slash case above: "a" is pushed then popped
    // by "..", leaving "b" — not "a/b". A manifest author who writes backslash
    // separators (e.g. authored on Windows) gets the same answer either way.
    const reader = memReader({ [`${root}/b/skills/x/SKILL.md`]: "" });
    const { dir, state } = resolveContentDir(reader, { name: "p", source: "a\\..\\b" }, root, "", []);
    expect(state).toBe("clone");
    expect(dir).toBe(`${root}/b`);
  });

  it("resolves source '.' to installLocation itself, not to manifest", () => {
    // A real pattern on this machine: a single-plugin marketplace repo whose
    // `source` is "." because the plugin *is* the repo root. Pre-fix this
    // collapsed to installLocation via the real filesystem; containment must
    // preserve that, not just refuse escapes — the root is inside the
    // container, so returning it costs nothing security-wise.
    const reader = memReader({ [`${root}/SKILL.md`]: "" });
    const { dir, state } = resolveContentDir(reader, { name: "ui-ux-pro-max", source: "." }, root, "", []);
    expect(state).toBe("clone");
    expect(dir).toBe(root);
  });

  it("still refuses a climb-out after the '.' fix", () => {
    const reader = memReader({ [`${root}/../../../../etc/passwd`]: "root:x:0:0:root:/root:/bin/bash" });
    const { dir, state } = resolveContentDir(reader, { name: "evil", source: "../../../../etc" }, root, "", []);
    expect(state).toBe("manifest");
    expect(dir).toBe("");
  });

  it("still resolves the ordinary happy path identically", () => {
    const reader = memReader({ [`${root}/plugins/installed-one/skills/x/SKILL.md`]: "" });
    const { dir, state } = resolveContentDir(
      reader, { name: "installed-one", source: "./plugins/installed-one" }, root, "", [],
    );
    expect(state).toBe("clone");
    expect(dir).toBe(`${root}/plugins/installed-one`);
  });
});

const CLAUDE = "/home/u/.claude";
const P = `${CLAUDE}/plugins`;

/** A fixture with one github marketplace holding three plugins, one of each state. */
function fixture(extra: Record<string, string> = {}): Record<string, string> {
  const mkt = `${P}/marketplaces/acme`;
  return {
    [`${P}/known_marketplaces.json`]: JSON.stringify({
      acme: { source: { source: "github", repo: "org/acme" }, installLocation: mkt },
    }),
    [`${P}/installed_plugins.json`]: JSON.stringify({
      version: 2,
      plugins: {
        "installed-one@acme": [
          { scope: "user", version: "1.2.3", installPath: `${P}/cache/acme/installed-one/1.2.3` },
        ],
      },
    }),
    [`${CLAUDE}/settings.json`]: JSON.stringify({
      enabledPlugins: { "installed-one@acme": true, "clone-one@acme": false },
      skillOverrides: { "off-skill": "off" },
    }),
    [`${mkt}/.claude-plugin/marketplace.json`]: JSON.stringify({
      name: "acme",
      metadata: { pluginRoot: "./plugins" },
      plugins: [
        { name: "installed-one", description: "installed", source: "./plugins/installed-one" },
        { name: "clone-one", description: "in the clone", source: "./plugins/clone-one" },
        { name: "remote-one", description: "elsewhere", source: { source: "github", repo: "x/y" } },
      ],
    }),
    [`${P}/cache/acme/installed-one/1.2.3/skills/from-cache/SKILL.md`]: "---\ndescription: cached\n---",
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
    expect(v.marketplaces[0]).toMatchObject({ name: "acme", kind: "github", origin: "org/acme", pluginCount: 3, stale: false });
    expect(v.notSetUp).toBe(false);
  });

  it("reads an installed plugin from its cache installPath, not the clone", () => {
    const v = scan(fixture());
    const names = v.assets.filter((a) => a.plugin === "installed-one").map((a) => a.name);
    expect(names).toEqual(["from-cache"]);
    expect(v.plugins.find((p) => p.name === "installed-one")).toMatchObject({
      state: "installed", enabled: true, version: "1.2.3", scopes: ["user"],
      installCommand: "/plugin install installed-one@acme",
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

  it("refuses a plugin source that climbs out of installLocation", () => {
    const tree = fixture();
    const mkt = `${P}/marketplaces/acme`;
    tree[`${mkt}/.claude-plugin/marketplace.json`] = JSON.stringify({
      name: "acme",
      metadata: { pluginRoot: "./plugins" },
      plugins: [{ name: "escapee", description: "hostile", source: "../../../../etc" }],
    });
    // memReader matches literal path strings rather than resolving "..", so the
    // pre-fix `${installLocation}/${rel}` concatenation would land exactly here
    // and treat it as a legitimate clone dir — the fix must refuse before that.
    tree[`${mkt}/../../../../etc/passwd`] = "root:x:0:0:root:/root:/bin/bash";
    const v = scan(tree);
    const p = v.plugins.find((x) => x.name === "escapee")!;
    expect(p.state).toBe("manifest");
    expect(p.readme).toBe("");
    expect(p.counts).toEqual({ skill: 0, command: 0, agent: 0, hook: 0 });
    expect(v.assets.some((a) => a.plugin === "escapee")).toBe(false);
  });

  it("falls back to pluginRoot/name when a plugin omits source", () => {
    const tree = fixture();
    const mkt = `${P}/marketplaces/acme`;
    tree[`${mkt}/.claude-plugin/marketplace.json`] = JSON.stringify({
      name: "acme", metadata: { pluginRoot: "./plugins" }, plugins: [{ name: "no-source" }],
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
        "installed-one@acme": [
          { scope: "user", version: "0.0.1", installPath: `${P}/cache/acme/installed-one/gone` },
          { scope: "project", version: "1.2.3", installPath: `${P}/cache/acme/installed-one/1.2.3` },
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
      acme: { source: { source: "github", repo: "org/acme" }, installLocation: `${P}/marketplaces/acme` },
      ghost: { source: { source: "directory", path: "/nowhere" }, installLocation: "/nowhere" },
    });
    const v = scan(tree);
    expect(v.marketplaces.find((m) => m.name === "ghost")).toMatchObject({ stale: true, kind: "directory", pluginCount: 0 });
    expect(v.marketplaces.find((m) => m.name === "acme")!.stale).toBe(false);
  });

  it("survives malformed JSON in a manifest without losing other marketplaces", () => {
    const tree = fixture();
    tree[`${P}/marketplaces/acme/.claude-plugin/marketplace.json`] = "{ not json";
    const v = scan(tree);
    expect(v.notSetUp).toBe(false);
    expect(v.plugins).toEqual([]);
    expect(v.marketplaces[0].pluginCount).toBe(0);
  });

  it("marks a skill disabled when skillOverrides turns it off inside an enabled plugin", () => {
    const tree = fixture();
    tree[`${P}/cache/acme/installed-one/1.2.3/skills/off-skill/SKILL.md`] = "";
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
      "/ws/.claude/settings.json": JSON.stringify({ enabledPlugins: { "installed-one@acme": false } }),
      "/ws/.claude/settings.local.json": JSON.stringify({ enabledPlugins: { "installed-one@acme": true } }),
    });
    const v = scan(tree, { workspaceDir: "/ws", workspaceName: "ws" });
    expect(v.plugins.find((p) => p.name === "installed-one")!.enabled).toBe(true);
  });
});

describe("scanClaudeAssets categories", () => {
  const tree = (over: Record<string, string> = {}) => ({
    "/h/.claude/plugins/known_marketplaces.json": JSON.stringify({
      acme: { installLocation: "/mk", source: { source: "github", repo: "org/acme" } },
    }),
    "/h/.claude/plugins/installed_plugins.json": JSON.stringify({ plugins: {} }),
    "/mk/.claude-plugin/marketplace.json": JSON.stringify({
      name: "acme",
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
