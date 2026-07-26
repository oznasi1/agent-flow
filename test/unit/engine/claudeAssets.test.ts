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

const ATTR = { plugin: "cicd-plugin", marketplace: "atbay-plugins", state: "installed" as const, enabled: true };

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
