# Marketplace Local Asset Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the empty, `gh`-backed Marketplace panel with a search-first browser of every Claude Code skill, command, agent and hook found on the local machine.

**Architecture:** A pure engine module (`src/engine/claudeAssets.ts`) reads Claude Code's on-disk state through an injected `AssetReader` interface, so all discovery logic is unit-testable against in-memory fixture trees with no real filesystem and no network. The existing `MarketplacePanel` keeps its webview shell and swaps its data layer for one `scanClaudeAssets()` call, gaining `mkt:open` / `mkt:reveal` handlers guarded by an allow-list of paths the scan actually emitted. The webview becomes a single filtered list plus a detail pane.

**Tech Stack:** TypeScript, React 18 (classic JSX runtime, `import * as React`), esbuild (4 bundles), vitest + @testing-library/react + jsdom, VS Code extension API.

## Global Constraints

- **No network calls.** No `gh`, no GitHub API, no `fetch`. Every read is local disk.
- **No mutation of `~/.claude`.** Read-only: no install, uninstall, enable or disable.
- **Nothing in `src/engine/claudeAssets.ts` may import `vscode`.** It is pure over `AssetReader`.
- **Classic JSX**: every `.tsx` file starts with `import * as React from "react";`.
- **Coverage thresholds must keep passing** (`vitest.config.ts`): statements 90, branches 85, functions 85, lines 90. `src/webview/marketplaceStyles.ts` and `src/webview/marketplace.tsx` are coverage-excluded; `MarketplaceApp.tsx` and `claudeAssets.ts` are **not**.
- **Commands are namespaced with a colon**: `commands/db/migrate.md` → `db:migrate`.
- **Walk depth cap: 8 levels.** Directory names always skipped: `.git`, `node_modules`, `tests`, `test`.
- **Asset attribution strings** are exactly `(user)` for `~/.claude` and `(workspace)` for the open folder.
- **The new outbound message is named `mkt:assets`**, not `mkt:state`. The old `mkt:state`, `mkt:add` and `mkt:remove` survive until Task 6 so every intermediate commit typechecks.
- Run `npm test` and `npm run typecheck` before every commit.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/engine/claudeAssets.ts` (new) | All discovery + parsing. Pure over `AssetReader`. Exports `parseFrontmatter`, `discoverAssets`, `resolveContentDir`, `resolveEnabled`, `scanClaudeAssets`. |
| `src/engine/claudeAssetsFs.ts` (new) | The only filesystem-touching code: builds a `node:fs`-backed `AssetReader`. Separated so `claudeAssets.ts` stays trivially testable. |
| `src/marketplaceView.ts` (modify) | Panel shell unchanged; data layer becomes one `scanClaudeAssets` call. Adds `mkt:open` / `mkt:reveal` with path allow-listing and visibility-based rescan. |
| `src/webview/MarketplaceApp.tsx` (rewrite) | The Palette UI: search, filter pills, results list, detail pane. |
| `src/webview/marketplaceStyles.ts` (rewrite) | CSS for the above, on VS Code theme variables. |
| `src/types.ts` (modify) | New view types + messages; old marketplace types removed in Task 6. |
| `test/unit/engine/claudeAssets.test.ts` (new) | Engine tests over fixture trees. |
| `test/unit/marketplaceView.test.ts` (rewrite) | Host panel tests. |
| `test/webview/MarketplaceApp.test.tsx` (rewrite) | UI tests. |

---

### Task 1: New view types and the frontmatter parser

**Files:**
- Modify: `src/types.ts` (append after the existing `MarketplaceView` block, around line 135)
- Create: `src/engine/claudeAssets.ts`
- Test: `test/unit/engine/claudeAssets.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AssetType`, `PluginState`, `AssetView`, `PluginRowView`, `MarketplaceSourceView`, `ClaudeAssetsView`, `AssetReader`, `DirEntry` types; `parseFrontmatter(text: string): Record<string, string>`.

Additive only — the old marketplace types stay, so nothing else breaks.

- [ ] **Step 1: Add the new types to `src/types.ts`**

Insert immediately after the closing `}` of `interface MarketplaceView` (currently line 135):

```ts
// ── The Marketplace: local asset browser ────────────────────────────────────

export type AssetType = "skill" | "command" | "agent" | "hook";

/** Where a plugin's content came from. "user" = yours, not from a plugin at all
 * (covers both ~/.claude and the open workspace). */
export type PluginState = "installed" | "clone" | "manifest" | "user";

/** One discoverable thing: a skill, slash command, subagent, or hook. */
export interface AssetView {
  type: AssetType;
  name: string;
  description: string;
  plugin: string; // "(user)" for ~/.claude, "(workspace)" for the open folder
  marketplace: string; // "~/.claude" or the workspace folder name, for those two
  file: string; // absolute path, for open/reveal
  rel: string; // shown in the detail pane
  enabled: boolean | null; // null = not declared in any settings file
  state: PluginState;
}

/** A plugin row — shown under the "Plugins" filter, including ones not on disk. */
export interface PluginRowView {
  name: string;
  marketplace: string;
  description: string;
  state: PluginState;
  enabled: boolean | null;
  scopes: string[];
  version: string;
  counts: Record<AssetType, number>;
  installCommand: string; // "/plugin install <plugin>@<marketplace>"
}

export interface MarketplaceSourceView {
  name: string;
  kind: "github" | "directory" | "user";
  origin: string; // "owner/repo", an absolute path, or "~/.claude"
  pluginCount: number;
  stale: boolean; // installLocation is gone from disk
}

export interface ClaudeAssetsView {
  marketplaces: MarketplaceSourceView[];
  plugins: PluginRowView[];
  assets: AssetView[];
  notSetUp: boolean; // no ~/.claude/plugins at all
  scannedAt: number;
}
```

- [ ] **Step 2: Add the new messages to the unions in `src/types.ts`**

In `InboundMessage`, replace the three Marketplace lines
`| { type: "mkt:add"; repo: string }`, `| { type: "mkt:remove"; repo: string }`,
`| { type: "mkt:copy"; text: string };` with:

```ts
  | { type: "mkt:add"; repo: string }
  | { type: "mkt:remove"; repo: string }
  | { type: "mkt:copy"; text: string }
  | { type: "mkt:open"; file: string }
  | { type: "mkt:reveal"; file: string };
```

In `OutboundMessage`, after `| { type: "mkt:state"; marketplaces: MarketplaceView[] }` add:

```ts
  | { type: "mkt:assets"; view: ClaudeAssetsView }
```

- [ ] **Step 3: Write the failing frontmatter tests**

Create `test/unit/engine/claudeAssets.test.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/claudeAssets.test.ts`
Expected: FAIL — `Failed to resolve import "../../../src/engine/claudeAssets"`.

- [ ] **Step 5: Create `src/engine/claudeAssets.ts` with the parser**

```ts
// Reads Claude Code's on-disk state (~/.claude and the open workspace) and derives
// the browsable asset list. Pure over an injected AssetReader so every rule here is
// unit-testable from fixture trees — this module must never import "vscode" or "fs".
import {
  AssetType,
  AssetView,
  ClaudeAssetsView,
  MarketplaceSourceView,
  PluginRowView,
  PluginState,
} from "../types";

export interface DirEntry {
  name: string;
  isDir: boolean;
}

/** The only I/O surface. Implementations return empty/null rather than throwing,
 * so one unreadable file degrades a single entry instead of the whole scan. */
export interface AssetReader {
  readFile(path: string): string | null;
  readDir(path: string): DirEntry[];
  isDir(path: string): boolean;
}

/** Parse a leading `---` fenced block into flat key/value pairs. Continuation
 * lines (indented, no `key:`) fold into the preceding value — real skill
 * descriptions routinely wrap across several lines. */
export function parseFrontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text ?? "");
  if (!m) return {};
  const out: Record<string, string> = {};
  let key: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (key) out[key] = unquote(buf.join(" ").trim());
  };
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (kv) {
      flush();
      key = kv[1];
      buf = [kv[2]];
    } else if (key && /^\s+\S/.test(line)) {
      buf.push(line.trim());
    }
  }
  flush();
  return out;
}

function unquote(s: string): string {
  return s.replace(/^["']|["']$/g, "").trim();
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/claudeAssets.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/types.ts src/engine/claudeAssets.ts test/unit/engine/claudeAssets.test.ts
git commit -m "feat(marketplace): asset view types and frontmatter parser"
```

---

### Task 2: Asset discovery inside a plugin directory

**Files:**
- Modify: `src/engine/claudeAssets.ts`
- Test: `test/unit/engine/claudeAssets.test.ts`

**Interfaces:**
- Consumes: `AssetReader`, `DirEntry`, `parseFrontmatter` from Task 1.
- Produces:
  - `Attribution = { plugin: string; marketplace: string; state: PluginState; enabled: boolean | null }`
  - `discoverAssets(reader: AssetReader, dir: string, attr: Attribution, skip?: Set<string>): AssetView[]`
  - `flattenHooks(json: string | null, file: string, rel: string, attr: Attribution): AssetView[]`
  - `memReader(tree: Record<string, string>): AssetReader` — exported test helper, also used by Task 3.

`memReader` lives in the engine module (not the test file) because Task 3's tests need it too and duplicating it would let the two copies drift.

- [ ] **Step 1: Write the failing discovery tests**

Append to `test/unit/engine/claudeAssets.test.ts`:

```ts
import { discoverAssets, memReader } from "../../../src/engine/claudeAssets";

const ATTR = { plugin: "cicd-plugin", marketplace: "acme-plugins", state: "installed" as const, enabled: true };

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/claudeAssets.test.ts`
Expected: FAIL — `discoverAssets is not a function` / `memReader is not exported`.

- [ ] **Step 3: Implement discovery in `src/engine/claudeAssets.ts`**

Append:

```ts
/** Never descended into, at any level. */
export const SKIP_DIRS = new Set([".git", "node_modules", "tests", "test"]);
/** Additionally skipped when walking ~/.claude or a workspace .claude, where the
 * neighbouring plugin cache, transcripts and worktrees are large and irrelevant. */
export const SKIP_DIRS_OWN = new Set([
  ...SKIP_DIRS, "plugins", "projects", "cache", "backups", "sessions",
  "shell-snapshots", "file-history", "history", "todos", "downloads",
  "paste-cache", "worktrees", "debug", "statsig", "ide", "telemetry",
]);
const MAX_DEPTH = 8;

export interface Attribution {
  plugin: string;
  marketplace: string;
  state: PluginState;
  enabled: boolean | null;
}

/** An in-memory AssetReader over a flat {absolutePath: contents} map. Exported so
 * the engine tests and any future fixture-driven test share one implementation. */
export function memReader(tree: Record<string, string>): AssetReader {
  const paths = Object.keys(tree);
  const dirs = new Set<string>();
  for (const p of paths) {
    const segs = p.split("/");
    for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join("/") || "/");
  }
  return {
    readFile: (p) => (p in tree ? tree[p] : null),
    isDir: (p) => dirs.has(p.replace(/\/+$/, "")),
    readDir: (p) => {
      const base = p.replace(/\/+$/, "");
      const seen = new Map<string, boolean>();
      for (const full of paths) {
        if (!full.startsWith(base + "/")) continue;
        const rest = full.slice(base.length + 1);
        const slash = rest.indexOf("/");
        const name = slash === -1 ? rest : rest.slice(0, slash);
        if (name) seen.set(name, slash !== -1);
      }
      return [...seen].map(([name, isDir]) => ({ name, isDir })).sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}

/** Every file under `dir`, depth-capped, skipping noise directories.
 * Returns paths relative to `dir`, in stable sorted order. */
function walk(reader: AssetReader, dir: string, skip: Set<string>): string[] {
  const out: string[] = [];
  const visit = (rel: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    const abs = rel ? `${dir}/${rel}` : dir;
    for (const e of reader.readDir(abs)) {
      if (e.isDir) {
        if (skip.has(e.name)) continue;
        visit(rel ? `${rel}/${e.name}` : e.name, depth + 1);
      } else {
        out.push(rel ? `${rel}/${e.name}` : e.name);
      }
    }
  };
  if (!reader.isDir(dir)) return out;
  visit("", 0);
  return out;
}

function mdAsset(
  reader: AssetReader,
  dir: string,
  rel: string,
  type: AssetType,
  fallbackName: string,
  attr: Attribution,
): AssetView {
  const fm = parseFrontmatter(reader.readFile(`${dir}/${rel}`) ?? "");
  return {
    type,
    name: fm.name || fallbackName,
    description: fm.description ?? "",
    plugin: attr.plugin,
    marketplace: attr.marketplace,
    file: `${dir}/${rel}`,
    rel,
    enabled: attr.enabled,
    state: attr.state,
  };
}

/** Flatten a hooks.json body. Accepts {"hooks":{Event:[…]}} and bare {Event:[…]}. */
export function flattenHooks(json: string | null, file: string, rel: string, attr: Attribution): AssetView[] {
  if (json === null) return [];
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const byEvent = parsed && typeof parsed === "object" ? (parsed.hooks ?? parsed) : null;
  if (!byEvent || typeof byEvent !== "object") return [];
  const out: AssetView[] = [];
  for (const [event, entries] of Object.entries<any>(byEvent)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      for (const h of entry?.hooks ?? []) {
        if (!h || typeof h !== "object") continue;
        const matcher = typeof entry.matcher === "string" ? entry.matcher : "";
        out.push({
          type: "hook",
          name: event,
          description: String(h.command ?? h.type ?? ""),
          plugin: attr.plugin,
          marketplace: attr.marketplace,
          file,
          rel: matcher ? `${rel} (${matcher})` : rel,
          enabled: attr.enabled,
          state: attr.state,
        });
      }
    }
  }
  return out;
}

/** Skills, commands, agents and hooks inside one plugin (or user) directory. */
export function discoverAssets(
  reader: AssetReader,
  dir: string,
  attr: Attribution,
  skip: Set<string> = SKIP_DIRS,
): AssetView[] {
  const rels = walk(reader, dir, skip);
  const skills: AssetView[] = [];
  const commands: AssetView[] = [];
  const agents: AssetView[] = [];

  for (const rel of rels) {
    const segs = rel.split("/");
    const base = segs[segs.length - 1];
    if (base === "SKILL.md") {
      const folder = segs.length >= 2 ? segs[segs.length - 2] : "";
      skills.push(mdAsset(reader, dir, rel, "skill", folder, attr));
      continue;
    }
    if (!base.endsWith(".md")) continue;
    const bucket = segs[0] === "commands" ? commands : segs[0] === "agents" ? agents : null;
    if (!bucket || segs.length < 2) continue;
    const name = segs.slice(1).join(":").replace(/\.md$/, "");
    bucket.push(mdAsset(reader, dir, rel, segs[0] === "commands" ? "command" : "agent", name, attr));
  }

  const hookRel = "hooks/hooks.json";
  const hooks = flattenHooks(reader.readFile(`${dir}/${hookRel}`), `${dir}/${hookRel}`, hookRel, attr);

  const byName = (a: AssetView, b: AssetView) => a.name.localeCompare(b.name);
  return [...skills.sort(byName), ...commands.sort(byName), ...agents.sort(byName), ...hooks];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/claudeAssets.test.ts`
Expected: PASS, 18 tests total.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/engine/claudeAssets.ts test/unit/engine/claudeAssets.test.ts
git commit -m "feat(marketplace): discover skills, commands, agents and hooks in a plugin dir"
```

---

### Task 3: Marketplace resolution and the full scan

**Files:**
- Modify: `src/engine/claudeAssets.ts`
- Test: `test/unit/engine/claudeAssets.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–2.
- Produces:
  - `resolveEnabled(ref: string, settings: SettingsLayer[]): boolean | null`
  - `resolveContentDir(reader, plugin, installLocation, pluginRoot, installs): { dir: string; state: PluginState }`
  - `scanClaudeAssets(reader: AssetReader, opts: ScanOptions): ClaudeAssetsView`
  - `ScanOptions = { claudeDir: string; workspaceDir?: string; workspaceName?: string; now: number }`

`now` is injected rather than read from `Date.now()` so `scannedAt` is assertable.

- [ ] **Step 1: Write the failing tests for enabled-state precedence**

Append to `test/unit/engine/claudeAssets.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/unit/engine/claudeAssets.test.ts`
Expected: FAIL — `resolveEnabled is not a function`.

- [ ] **Step 3: Implement `resolveEnabled` and the settings layer type**

Append to `src/engine/claudeAssets.ts`:

```ts
/** One parsed settings.json, in increasing precedence order. */
export interface SettingsLayer {
  enabledPlugins?: Record<string, unknown>;
  skillOverrides?: Record<string, unknown>;
  hooks?: unknown;
}

/** Enabled state for "<plugin>@<marketplace>". Later layers win; a ref that no
 * layer mentions is `null` (unknown), which renders as no badge — deliberately
 * distinct from an explicit `false`, which renders as "disabled". */
export function resolveEnabled(ref: string, layers: SettingsLayer[]): boolean | null {
  let out: boolean | null = null;
  for (const l of layers) {
    const v = l.enabledPlugins?.[ref];
    if (typeof v === "boolean") out = v;
  }
  return out;
}
```

- [ ] **Step 4: Run to verify the four tests pass**

Run: `npx vitest run test/unit/engine/claudeAssets.test.ts -t resolveEnabled`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing tests for `scanClaudeAssets`**

Append to `test/unit/engine/claudeAssets.test.ts`:

```ts
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
```

- [ ] **Step 6: Run to verify failure**

Run: `npx vitest run test/unit/engine/claudeAssets.test.ts`
Expected: FAIL — `scanClaudeAssets is not a function`.

- [ ] **Step 7: Implement `resolveContentDir` and `scanClaudeAssets`**

Append to `src/engine/claudeAssets.ts`:

```ts
export interface ScanOptions {
  claudeDir: string;
  workspaceDir?: string;
  workspaceName?: string;
  now: number;
}

interface InstallEntry {
  scope?: string;
  version?: string;
  installPath?: string;
}

/** Strip a leading "./" and any trailing "/" from a manifest-declared path. */
function cleanPath(p: string): string {
  return (p ?? "").replace(/^\.\//, "").replace(/\/+$/, "");
}

function readJson(reader: AssetReader, path: string): any {
  const raw = reader.readFile(path);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Where a plugin's content lives: the installed copy if present, else the
 * marketplace clone if `source` is a real string path, else nowhere. */
export function resolveContentDir(
  reader: AssetReader,
  plugin: { name: string; source?: unknown },
  installLocation: string,
  pluginRoot: string,
  installs: InstallEntry[],
): { dir: string; state: PluginState } {
  for (const i of installs) {
    if (i.installPath && reader.isDir(i.installPath)) return { dir: i.installPath, state: "installed" };
  }
  const rel =
    typeof plugin.source === "string"
      ? cleanPath(plugin.source)
      : cleanPath([pluginRoot, plugin.name].filter(Boolean).join("/"));
  const dir = `${installLocation}/${rel}`;
  if (rel && reader.isDir(dir)) return { dir, state: "clone" };
  return { dir: "", state: "manifest" };
}

const EMPTY_COUNTS = (): Record<AssetType, number> => ({ skill: 0, command: 0, agent: 0, hook: 0 });

function countsOf(assets: AssetView[]): Record<AssetType, number> {
  const c = EMPTY_COUNTS();
  for (const a of assets) c[a.type]++;
  return c;
}

/** Read every local source and derive the browsable view. Never throws: an
 * unreadable file degrades its own entry and the rest of the scan continues. */
export function scanClaudeAssets(reader: AssetReader, opts: ScanOptions): ClaudeAssetsView {
  const pluginsDir = `${opts.claudeDir}/plugins`;
  const marketplaces: MarketplaceSourceView[] = [];
  const plugins: PluginRowView[] = [];
  const assets: AssetView[] = [];

  const userSettings: SettingsLayer = readJson(reader, `${opts.claudeDir}/settings.json`) ?? {};
  const wsSettings: SettingsLayer = opts.workspaceDir
    ? readJson(reader, `${opts.workspaceDir}/.claude/settings.json`) ?? {}
    : {};
  const wsLocal: SettingsLayer = opts.workspaceDir
    ? readJson(reader, `${opts.workspaceDir}/.claude/settings.local.json`) ?? {}
    : {};
  const layers = [userSettings, wsSettings, wsLocal];
  const skillOff = new Set(
    layers.flatMap((l) => Object.entries(l.skillOverrides ?? {}).filter(([, v]) => v === "off").map(([k]) => k)),
  );

  const notSetUp = !reader.isDir(pluginsDir);
  const known = notSetUp ? null : readJson(reader, `${pluginsDir}/known_marketplaces.json`);
  const installed = notSetUp ? null : readJson(reader, `${pluginsDir}/installed_plugins.json`);
  const installsByRef: Record<string, InstallEntry[]> = (installed?.plugins ?? {}) as any;

  for (const [key, meta] of Object.entries<any>(known ?? {})) {
    const installLocation: string = typeof meta?.installLocation === "string" ? meta.installLocation : "";
    const src = meta?.source ?? {};
    const kind: MarketplaceSourceView["kind"] = src.source === "directory" ? "directory" : "github";
    const origin: string = src.repo ?? src.path ?? "";
    const stale = !installLocation || !reader.isDir(installLocation);
    const manifest = stale ? null : readJson(reader, `${installLocation}/.claude-plugin/marketplace.json`);
    const name: string = typeof manifest?.name === "string" && manifest.name ? manifest.name : key;
    const pluginRoot = cleanPath(typeof manifest?.metadata?.pluginRoot === "string" ? manifest.metadata.pluginRoot : "");
    const list: any[] = Array.isArray(manifest?.plugins) ? manifest.plugins : [];

    marketplaces.push({ name, kind, origin, pluginCount: list.length, stale });

    for (const p of list) {
      if (!p || typeof p.name !== "string" || !p.name) continue;
      const ref = `${p.name}@${name}`;
      const installs = Array.isArray(installsByRef[ref]) ? installsByRef[ref] : [];
      const { dir, state } = resolveContentDir(reader, p, installLocation, pluginRoot, installs);
      const enabled = resolveEnabled(ref, layers);
      const used = installs.find((i) => i.installPath && reader.isDir(i.installPath));
      const mine = dir
        ? discoverAssets(reader, dir, { plugin: p.name, marketplace: name, state, enabled })
        : [];
      for (const a of mine) {
        if (a.type === "skill" && skillOff.has(a.name)) a.enabled = false;
        assets.push(a);
      }
      plugins.push({
        name: p.name,
        marketplace: name,
        description: typeof p.description === "string" ? p.description : "",
        state,
        enabled,
        scopes: [...new Set(installs.map((i) => i.scope).filter((s): s is string => !!s))].sort(),
        version: used?.version ?? "",
        counts: countsOf(mine),
        installCommand: `/plugin install ${ref}`,
      });
    }
  }

  // ── assets you wrote yourself, plus settings-level hooks ──────────────────
  const own = (dir: string, plugin: string, marketplace: string, settings: SettingsLayer): void => {
    const attr: Attribution = { plugin, marketplace, state: "user", enabled: true };
    // SKIP_DIRS_OWN, not the plugin default: this walk starts at ~/.claude (or a
    // workspace .claude), whose siblings include the plugin cache, 300+ MB of
    // transcripts, and git worktrees — none of which hold user-authored assets.
    const found = discoverAssets(reader, dir, attr, SKIP_DIRS_OWN);
    const hooks = flattenHooks(JSON.stringify(settings.hooks ?? null), `${dir}/settings.json`, "settings.json", attr);
    const all = [...found, ...hooks];
    for (const a of all) {
      if (a.type === "skill" && skillOff.has(a.name)) a.enabled = false;
      assets.push(a);
    }
    if (all.length) {
      marketplaces.push({ name: marketplace, kind: "user", origin: marketplace, pluginCount: 1, stale: false });
      plugins.push({
        name: plugin,
        marketplace,
        description: "Skills, commands, agents and hooks outside any plugin.",
        state: "user",
        enabled: true,
        scopes: [plugin === "(user)" ? "user" : "workspace"],
        version: "",
        counts: countsOf(all),
        installCommand: "",
      });
    }
  };

  own(opts.claudeDir, "(user)", "~/.claude", userSettings);
  if (opts.workspaceDir) {
    own(`${opts.workspaceDir}/.claude`, "(workspace)", opts.workspaceName || "workspace", { ...wsSettings, ...wsLocal });
  }

  return { marketplaces, plugins, assets, notSetUp, scannedAt: opts.now };
}
```

- [ ] **Step 8: Run the whole engine suite**

Run: `npx vitest run test/unit/engine/claudeAssets.test.ts`
Expected: PASS, all tests.

- [ ] **Step 9: Typecheck and commit**

```bash
npm run typecheck
git add src/engine/claudeAssets.ts test/unit/engine/claudeAssets.test.ts
git commit -m "feat(marketplace): resolve marketplaces, plugin states and the full local scan"
```

---

### Task 4: Filesystem reader and host wiring

**Files:**
- Create: `src/engine/claudeAssetsFs.ts`
- Modify: `src/marketplaceView.ts`
- Test: `test/unit/marketplaceView.test.ts` (rewrite)

**Interfaces:**
- Consumes: `scanClaudeAssets`, `AssetReader`, `DirEntry` from Tasks 1–3; `ClaudeAssetsView` from `src/types.ts`.
- Produces: `fsReader(): AssetReader`, `claudeConfigDir(): string`. `MarketplacePanel.show(context, log)` keeps its signature.

After this task the host posts `mkt:assets`; the old UI (still listening for `mkt:state`) shows its empty state until Task 5. That is expected and typechecks cleanly.

- [ ] **Step 1: Create the fs-backed reader**

Create `src/engine/claudeAssetsFs.ts`:

```ts
// The only filesystem-touching part of the asset scan. Kept apart from
// claudeAssets.ts so that module stays pure and trivially testable.
import * as fs from "fs";
import * as os from "os";
import { AssetReader, DirEntry } from "./claudeAssets";

/** Claude Code's config dir: $CLAUDE_CONFIG_DIR when set, else ~/.claude. */
export function claudeConfigDir(): string {
  const env = process.env.CLAUDE_CONFIG_DIR;
  return env && env.trim() ? env.replace(/\/+$/, "") : `${os.homedir()}/.claude`;
}

/** A reader over the real filesystem. Every method swallows errors and returns
 * the empty answer, so a permission failure degrades one entry, not the scan. */
export function fsReader(): AssetReader {
  return {
    readFile(p: string): string | null {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    readDir(p: string): DirEntry[] {
      try {
        return fs
          .readdirSync(p, { withFileTypes: true })
          .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        return [];
      }
    },
    isDir(p: string): boolean {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
  };
}
```

- [ ] **Step 2: Write the failing host tests**

Replace the whole contents of `test/unit/marketplaceView.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { window, ViewColumn, env, commands, workspace } from "../_mocks/vscode";
import { fakeContext } from "../_helpers/factories";
import type { ClaudeAssetsView } from "../../src/types";

const h = vi.hoisted(() => ({ scanClaudeAssets: vi.fn(), fsReader: vi.fn(() => ({})), claudeConfigDir: vi.fn(() => "/home/u/.claude") }));
vi.mock("../../src/engine/claudeAssets", () => ({ scanClaudeAssets: h.scanClaudeAssets }));
vi.mock("../../src/engine/claudeAssetsFs", () => ({ fsReader: h.fsReader, claudeConfigDir: h.claudeConfigDir }));

import { MarketplacePanel } from "../../src/marketplaceView";

const view = (over: Partial<ClaudeAssetsView> = {}): ClaudeAssetsView => ({
  marketplaces: [{ name: "acme", kind: "github", origin: "org/acme", pluginCount: 1, stale: false }],
  plugins: [],
  assets: [{
    type: "skill", name: "build", description: "d", plugin: "cicd", marketplace: "acme",
    file: "/home/u/.claude/plugins/cache/acme/cicd/1/skills/build/SKILL.md",
    rel: "skills/build/SKILL.md", enabled: true, state: "installed",
  }],
  notSetUp: false,
  scannedAt: 1,
  ...over,
});
const lastPanel = () => window.createWebviewPanel.mock.results.at(-1)!.value as ReturnType<typeof import("../_mocks/vscode").makeWebviewPanel>;
const posts = (p: ReturnType<typeof lastPanel>) => p.webview.postMessage.mock.calls.map((c) => c[0] as any);
const show = () => MarketplacePanel.show(fakeContext().context as any, () => {});

beforeEach(() => {
  h.scanClaudeAssets.mockReset().mockReturnValue(view());
});
afterEach(() => {
  const r = window.createWebviewPanel.mock.results.at(-1);
  if (r) (r.value as any)._fireDispose();
});

describe("MarketplacePanel", () => {
  it("creates a singleton panel and wires html", () => {
    show();
    expect(window.createWebviewPanel).toHaveBeenCalledWith("agentFlow.marketplace", expect.any(String), ViewColumn.Active, expect.any(Object));
    expect(lastPanel().webview.html).toContain('<div id="root">');
    show();
    expect(window.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(lastPanel().reveal).toHaveBeenCalled();
  });

  it("posts mkt:assets on ready", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    const msg = posts(p).reverse().find((m) => m.type === "mkt:assets");
    expect(msg.view.assets).toHaveLength(1);
    expect(h.scanClaudeAssets).toHaveBeenCalled();
  });

  it("passes the workspace folder into the scan when one is open", async () => {
    workspace.workspaceFolders = [{ uri: { fsPath: "/ws/my-repo" } }] as any;
    show();
    await lastPanel()._fire({ type: "mkt:ready" });
    expect(h.scanClaudeAssets).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      claudeDir: "/home/u/.claude", workspaceDir: "/ws/my-repo", workspaceName: "my-repo",
    }));
  });

  it("rescans on mkt:refresh", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    h.scanClaudeAssets.mockClear();
    await p._fire({ type: "mkt:refresh" });
    expect(h.scanClaudeAssets).toHaveBeenCalledTimes(1);
  });

  it("brackets each scan with mkt:loading true/false", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    const loads = posts(p).filter((m) => m.type === "mkt:loading").map((m) => m.loading);
    expect(loads[0]).toBe(true);
    expect(loads.at(-1)).toBe(false);
  });

  it("opens a file that the last scan emitted", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    await p._fire({ type: "mkt:open", file: view().assets[0].file });
    expect(workspace.openTextDocument).toHaveBeenCalled();
    expect(window.showTextDocument).toHaveBeenCalled();
  });

  it("refuses to open a path the scan never emitted", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    await p._fire({ type: "mkt:open", file: "/etc/passwd" });
    expect(workspace.openTextDocument).not.toHaveBeenCalled();
    expect(posts(p).some((m) => m.type === "toast" && m.level === "error")).toBe(true);
  });

  it("reveals a known file in the OS file manager", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    await p._fire({ type: "mkt:reveal", file: view().assets[0].file });
    expect(commands.executeCommand).toHaveBeenCalledWith("revealFileInOS", expect.anything());
  });

  it("refuses to reveal an unknown path", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    await p._fire({ type: "mkt:reveal", file: "/etc/hosts" });
    expect(commands.executeCommand).not.toHaveBeenCalledWith("revealFileInOS", expect.anything());
  });

  it("copies text and toasts success", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:copy", text: "/plugin install x@y" });
    expect(env.clipboard.writeText).toHaveBeenCalledWith("/plugin install x@y");
    expect(posts(p).some((m) => m.type === "toast" && m.level === "success")).toBe(true);
  });

  it("opens an external url via the host", async () => {
    show();
    await lastPanel()._fire({ type: "openExternal", url: "https://example.com" });
    expect(env.openExternal).toHaveBeenCalled();
  });

  it("rescans when the panel becomes visible again after the stale window", async () => {
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(0);
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    h.scanClaudeAssets.mockClear();
    nowSpy.mockReturnValue(60_000);
    await p._fireViewState();
    expect(h.scanClaudeAssets).toHaveBeenCalledTimes(1);
    nowSpy.mockRestore();
  });

  it("does not rescan on a visibility change inside the stale window", async () => {
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(0);
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    h.scanClaudeAssets.mockClear();
    nowSpy.mockReturnValue(1_000);
    await p._fireViewState();
    expect(h.scanClaudeAssets).not.toHaveBeenCalled();
    nowSpy.mockRestore();
  });

  it("still posts a view when the scan throws", async () => {
    h.scanClaudeAssets.mockImplementation(() => { throw new Error("boom"); });
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    const msg = posts(p).reverse().find((m) => m.type === "mkt:assets");
    expect(msg.view.assets).toEqual([]);
    expect(msg.view.notSetUp).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/unit/marketplaceView.test.ts`
Expected: FAIL — the mock for `src/engine/claudeAssetsFs` resolves but `marketplaceView.ts` still imports `./engine/marketplace`, so `mkt:assets` is never posted.

- [ ] **Step 4: Rewrite the data layer of `src/marketplaceView.ts`**

Replace lines 1–5 (the imports) with:

```ts
import * as vscode from "vscode";
import { scanClaudeAssets } from "./engine/claudeAssets";
import { claudeConfigDir, fsReader } from "./engine/claudeAssetsFs";
import { InboundMessage, OutboundMessage, ClaudeAssetsView } from "./types";
```

Replace the `CACHE_TTL_MS` constant and the class body from `private static current` down to the end of `onMessage` with:

```ts
const STALE_MS = 30_000; // re-scan on re-focus only if the last scan is older than this

/** The Marketplace: a searchable board of every Claude Code skill, command, agent
 * and hook on this machine. Singleton editor-area panel; strictly read-only. */
export class MarketplacePanel {
  private static current: MarketplacePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  /** Paths the last scan emitted — the allow-list for open/reveal. */
  private openable = new Set<string>();
  private lastScan = 0;

  static show(context: vscode.ExtensionContext, log: (m: string) => void): void {
    if (MarketplacePanel.current) {
      MarketplacePanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "agentFlow.marketplace",
      "Agent Flow — Marketplace",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [context.extensionUri] },
    );
    MarketplacePanel.current = new MarketplacePanel(panel, context, log);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly log: (m: string) => void,
  ) {
    this.panel = panel;
    this.panel.webview.html = this.html(this.panel.webview);
    this.panel.webview.onDidReceiveMessage((m: InboundMessage) => this.onMessage(m), null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    // Cheap enough (a full scan measured ~0.2s) that re-focus after a pause just rescans.
    this.panel.onDidChangeViewState(
      () => {
        if (this.panel.visible && Date.now() - this.lastScan > STALE_MS) void this.render();
      },
      null,
      this.disposables,
    );
  }

  private post(msg: OutboundMessage): void {
    void this.panel.webview.postMessage(msg);
  }
  private toast(level: "success" | "error" | "info", message: string): void {
    this.post({ type: "toast", level, message });
  }

  private scan(): ClaudeAssetsView {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const workspaceDir = folder?.uri.fsPath;
    return scanClaudeAssets(fsReader(), {
      claudeDir: claudeConfigDir(),
      workspaceDir,
      workspaceName: workspaceDir ? workspaceDir.split("/").filter(Boolean).pop() : undefined,
      now: Date.now(),
    });
  }

  private render(): void {
    this.post({ type: "mkt:loading", loading: true });
    let view: ClaudeAssetsView;
    try {
      view = this.scan();
    } catch (e) {
      this.log(`marketplace: scan failed: ${e}`);
      view = { marketplaces: [], plugins: [], assets: [], notSetUp: true, scannedAt: Date.now() };
    }
    this.lastScan = Date.now();
    this.openable = new Set(view.assets.map((a) => a.file));
    this.post({ type: "mkt:assets", view });
    this.post({ type: "mkt:loading", loading: false });
  }

  /** Only paths the last scan emitted may be opened — the webview must never be
   * able to talk the host into opening an arbitrary file. */
  private allowed(file: string): boolean {
    if (this.openable.has(file)) return true;
    this.log(`marketplace: refused to open unlisted path ${file}`);
    this.toast("error", "That file isn't part of the current scan.");
    return false;
  }

  private async onMessage(m: InboundMessage): Promise<void> {
    switch (m.type) {
      case "mkt:ready":
      case "mkt:refresh":
        this.render();
        break;
      case "mkt:open": {
        if (!this.allowed(m.file)) return;
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(m.file));
        await vscode.window.showTextDocument(doc, { preview: true });
        break;
      }
      case "mkt:reveal":
        if (!this.allowed(m.file)) return;
        await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(m.file));
        break;
      case "mkt:copy":
        await vscode.env.clipboard.writeText(m.text);
        this.toast("success", "Copied to clipboard.");
        break;
      case "openExternal":
        await vscode.env.openExternal(vscode.Uri.parse(m.url));
        break;
    }
  }
```

Leave `dispose()`, `html()` and `getNonce()` exactly as they are.

- [ ] **Step 5: Run the host tests**

Run: `npx vitest run test/unit/marketplaceView.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 6: Run the whole suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS. The old `MarketplaceApp.test.tsx` still passes — it drives `mkt:state` itself.

- [ ] **Step 7: Commit**

```bash
git add src/engine/claudeAssetsFs.ts src/marketplaceView.ts test/unit/marketplaceView.test.ts
git commit -m "feat(marketplace): scan local Claude state from the panel host"
```

---

### Task 5: The Palette UI

**Files:**
- Rewrite: `src/webview/MarketplaceApp.tsx`
- Rewrite: `src/webview/marketplaceStyles.ts`
- Test: `test/webview/MarketplaceApp.test.tsx` (rewrite)

**Interfaces:**
- Consumes: `ClaudeAssetsView`, `AssetView`, `PluginRowView`, `AssetType` from `src/types.ts`; the `mkt:assets` / `mkt:loading` / `toast` outbound messages; `send` from `./vscodeApi`.
- Produces: `MarketplaceApp` (default panel component). Reference mockup: `docs/mockups/2026-07-26-marketplace-ui.html`, layout **A**. That file is gitignored; if absent, this task's spec section is authoritative.

- [ ] **Step 1: Write the failing UI tests**

Replace the whole contents of `test/webview/MarketplaceApp.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";

vi.mock("../../src/webview/vscodeApi", () => ({ send: vi.fn() }));

import { MarketplaceApp } from "../../src/webview/MarketplaceApp";
import { send } from "../../src/webview/vscodeApi";
import type { AssetView, ClaudeAssetsView, OutboundMessage, PluginRowView } from "../../src/types";

const sent = vi.mocked(send);
function host(msg: OutboundMessage) {
  act(() => { window.dispatchEvent(new MessageEvent("message", { data: msg })); });
}

const asset = (over: Partial<AssetView> = {}): AssetView => ({
  type: "skill", name: "build", description: "Builds the thing", plugin: "cicd-plugin",
  marketplace: "acme", file: "/a/skills/build/SKILL.md", rel: "skills/build/SKILL.md",
  enabled: true, state: "installed", ...over,
});
const plugin = (over: Partial<PluginRowView> = {}): PluginRowView => ({
  name: "remote-one", marketplace: "acme", description: "Lives elsewhere", state: "manifest",
  enabled: null, scopes: [], version: "", counts: { skill: 0, command: 0, agent: 0, hook: 0 },
  installCommand: "/plugin install remote-one@acme", ...over,
});
const view = (over: Partial<ClaudeAssetsView> = {}): ClaudeAssetsView => ({
  marketplaces: [{ name: "acme", kind: "github", origin: "org/acme", pluginCount: 2, stale: false }],
  plugins: [plugin()],
  assets: [
    asset(),
    asset({ type: "command", name: "deploy", description: "Ships it", file: "/a/commands/deploy.md", rel: "commands/deploy.md" }),
    asset({ type: "agent", name: "pipeline", description: "Runs CI", file: "/a/agents/pipeline.md", rel: "agents/pipeline.md" }),
    asset({ type: "hook", name: "SessionStart", description: "node hook.js", file: "/a/hooks/hooks.json", rel: "hooks/hooks.json" }),
  ],
  notSetUp: false,
  scannedAt: 1,
  ...over,
});
const assetsMsg = (v: ClaudeAssetsView = view()): OutboundMessage => ({ type: "mkt:assets", view: v });

beforeEach(() => sent.mockClear());

// The detail pane repeats the selected row's name, so any name that is BOTH listed
// and selected appears twice. Assert with getAllByText for those, never getByText.
const rowText = (t: string) => screen.getAllByText(t)[0];

describe("MarketplaceApp", () => {
  it("announces readiness on mount", () => {
    render(<MarketplaceApp />);
    expect(sent).toHaveBeenCalledWith({ type: "mkt:ready" });
  });

  it("lists every asset with its description", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    expect(screen.getAllByText("build").length).toBeGreaterThan(0); // also in the detail pane
    expect(screen.getByText("/deploy")).toBeInTheDocument();
    expect(screen.getByText("pipeline")).toBeInTheDocument();
    expect(screen.getByText("SessionStart")).toBeInTheDocument();
    expect(screen.getAllByText(/Builds the thing/).length).toBeGreaterThan(0);
  });

  it("filters by the search box", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "deploy" } });
    expect(screen.getAllByText("/deploy").length).toBeGreaterThan(0);
    expect(screen.queryByText("pipeline")).not.toBeInTheDocument();
  });

  it("filters to one type via its pill", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    fireEvent.click(screen.getByRole("button", { name: /^Agents/i }));
    expect(screen.getAllByText("pipeline").length).toBeGreaterThan(0);
    expect(screen.queryByText("build")).not.toBeInTheDocument();
  });

  it("shows plugin rows under the Plugins pill, including not-downloaded ones", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    fireEvent.click(screen.getByRole("button", { name: /^Plugins/i }));
    expect(screen.getAllByText("remote-one").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/not downloaded/i).length).toBeGreaterThan(0);
  });

  it("sends mkt:open when Open file is clicked", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    fireEvent.click(screen.getByRole("button", { name: /open file/i }));
    expect(sent).toHaveBeenCalledWith({ type: "mkt:open", file: "/a/skills/build/SKILL.md" });
  });

  it("sends mkt:reveal when Reveal is clicked", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    fireEvent.click(screen.getByRole("button", { name: /reveal/i }));
    expect(sent).toHaveBeenCalledWith({ type: "mkt:reveal", file: "/a/skills/build/SKILL.md" });
  });

  it("copies a command as /name and a skill as its bare name", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    fireEvent.click(screen.getByRole("button", { name: /^copy$/i }));
    expect(sent).toHaveBeenCalledWith({ type: "mkt:copy", text: "build" });
    sent.mockClear();
    fireEvent.click(screen.getByText("/deploy"));
    fireEvent.click(screen.getByRole("button", { name: /^copy$/i }));
    expect(sent).toHaveBeenCalledWith({ type: "mkt:copy", text: "/deploy" });
  });

  it("copies the install command for a plugin row", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    fireEvent.click(screen.getByRole("button", { name: /^Plugins/i }));
    fireEvent.click(rowText("remote-one")); // the list row, not the detail heading
    fireEvent.click(screen.getByRole("button", { name: /^copy$/i }));
    expect(sent).toHaveBeenCalledWith({ type: "mkt:copy", text: "/plugin install remote-one@acme" });
  });

  it("moves the selection with the arrow keys", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    const box = screen.getByPlaceholderText(/search/i);
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("button", { name: /open file/i }));
    expect(sent).toHaveBeenCalledWith({ type: "mkt:open", file: "/a/commands/deploy.md" });
  });

  it("restricts to installed assets via the scope pill", () => {
    render(<MarketplaceApp />);
    host(assetsMsg(view({ assets: [asset(), asset({ name: "listed", state: "manifest", file: "/b.md" })] })));
    fireEvent.click(screen.getByRole("button", { name: /installed only/i }));
    expect(screen.getAllByText("build").length).toBeGreaterThan(0);
    expect(screen.queryByText("listed")).not.toBeInTheDocument();
  });

  it("hides explicitly disabled assets under Enabled only", () => {
    render(<MarketplaceApp />);
    host(assetsMsg(view({ assets: [asset(), asset({ name: "off-one", enabled: false, file: "/c.md" })] })));
    fireEvent.click(screen.getByRole("button", { name: /enabled only/i }));
    expect(screen.queryByText("off-one")).not.toBeInTheDocument();
  });

  it("marks a disabled asset in the list", () => {
    render(<MarketplaceApp />);
    host(assetsMsg(view({ assets: [asset({ enabled: false })] })));
    expect(screen.getAllByText(/disabled/i).length).toBeGreaterThan(0);
  });

  it("shows the not-set-up state", () => {
    render(<MarketplaceApp />);
    host(assetsMsg(view({ notSetUp: true, assets: [], plugins: [], marketplaces: [] })));
    expect(screen.getByText(/isn't set up on this machine/i)).toBeInTheDocument();
  });

  it("shows a no-match state for a query that matches nothing", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "zzzz" } });
    expect(screen.getByText(/nothing matches/i)).toBeInTheDocument();
  });

  it("flags a stale marketplace", () => {
    render(<MarketplaceApp />);
    host(assetsMsg(view({ marketplaces: [{ name: "ghost", kind: "directory", origin: "/gone", pluginCount: 0, stale: true }] })));
    expect(screen.getByText(/stale/i)).toBeInTheDocument();
  });

  it("sends mkt:refresh when Rescan is clicked", () => {
    render(<MarketplaceApp />);
    fireEvent.click(screen.getByRole("button", { name: /rescan/i }));
    expect(sent).toHaveBeenCalledWith({ type: "mkt:refresh" });
  });

  it("copies the marketplace-add hint", () => {
    render(<MarketplaceApp />);
    host(assetsMsg());
    fireEvent.click(screen.getByRole("button", { name: /add a marketplace/i }));
    expect(sent).toHaveBeenCalledWith({ type: "mkt:copy", text: "/plugin marketplace add owner/repo" });
  });

  it("renders a toast from the host", () => {
    render(<MarketplaceApp />);
    host({ type: "toast", level: "success", message: "Copied to clipboard." });
    expect(screen.getByText("Copied to clipboard.")).toBeInTheDocument();
  });

  it("shows a loading line while the host scans", () => {
    render(<MarketplaceApp />);
    host({ type: "mkt:loading", loading: true });
    expect(screen.getByText(/scanning/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/webview/MarketplaceApp.test.tsx`
Expected: FAIL — the current component listens for `mkt:state` and has no search box.

- [ ] **Step 3: Rewrite `src/webview/MarketplaceApp.tsx`**

```tsx
import * as React from "react";
import { send } from "./vscodeApi";
import { AssetType, AssetView, ClaudeAssetsView, OutboundMessage, PluginRowView } from "../types";

let toastSeq = 0;

const EMPTY: ClaudeAssetsView = { marketplaces: [], plugins: [], assets: [], notSetUp: false, scannedAt: 0 };
const TYPES: { k: AssetType; label: string; glyph: string }[] = [
  { k: "skill", label: "Skills", glyph: "S" },
  { k: "command", label: "Commands", glyph: "/" },
  { k: "agent", label: "Agents", glyph: "A" },
  { k: "hook", label: "Hooks", glyph: "H" },
];
const LABEL: Record<AssetType, string> = { skill: "Skills", command: "Commands", agent: "Agents", hook: "Hooks" };
const GLYPH: Record<AssetType, string> = { skill: "S", command: "/", agent: "A", hook: "H" };

type TypeFilter = AssetType | "all" | "plugins";
type ScopeFilter = "all" | "installed" | "enabled";

/** One selectable thing — an asset, or a plugin under the Plugins filter. */
interface Row {
  key: string;
  kind: "asset" | "plugin";
  type: AssetType | null;
  name: string;
  display: string;
  description: string;
  where: string;
  enabled: boolean | null;
  state: AssetView["state"];
  file: string;
  rel: string;
  copy: string;
  extra: string[];
}

const stateLabel: Record<AssetView["state"], string> = {
  installed: "installed",
  clone: "on disk",
  manifest: "not downloaded",
  user: "yours",
};

function assetRow(a: AssetView): Row {
  return {
    key: `a:${a.type}:${a.marketplace}:${a.plugin}:${a.rel}:${a.name}`,
    kind: "asset",
    type: a.type,
    name: a.name,
    display: a.type === "command" ? `/${a.name}` : a.name,
    description: a.description,
    where: `${a.plugin}${a.marketplace ? ` · ${a.marketplace}` : ""}`,
    enabled: a.enabled,
    state: a.state,
    file: a.file,
    rel: a.rel,
    copy: a.type === "command" ? `/${a.name}` : a.name,
    extra: [LABEL[a.type].replace(/s$/, "")],
  };
}

function pluginRow(p: PluginRowView): Row {
  const counts = TYPES.filter((t) => p.counts[t.k] > 0).map((t) => `${t.glyph} ${p.counts[t.k]}`);
  return {
    key: `p:${p.marketplace}:${p.name}`,
    kind: "plugin",
    type: null,
    name: p.name,
    display: p.name,
    description: p.description,
    where: p.marketplace,
    enabled: p.enabled,
    state: p.state,
    file: "",
    rel: "",
    copy: p.installCommand,
    extra: [...(p.version ? [`v${p.version}`] : []), ...p.scopes.map((s) => `${s} scope`), ...counts],
  };
}

function Pill({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <button type="button" className={`pill${on ? " on" : ""}`} onClick={onClick}>
      {children}
    </button>
  );
}

export function MarketplaceApp(): JSX.Element {
  const [view, setView] = React.useState<ClaudeAssetsView>(EMPTY);
  const [loading, setLoading] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [type, setType] = React.useState<TypeFilter>("all");
  const [scope, setScope] = React.useState<ScopeFilter>("all");
  const [sel, setSel] = React.useState(0);
  const [toasts, setToasts] = React.useState<{ id: number; level: string; message: string }[]>([]);

  React.useEffect(() => {
    const handler = (ev: MessageEvent<OutboundMessage>) => {
      const m = ev.data;
      if (m.type === "mkt:assets") setView(m.view);
      else if (m.type === "mkt:loading") setLoading(m.loading);
      else if (m.type === "toast") {
        const id = ++toastSeq;
        setToasts((t) => [...t.slice(-2), { id, level: m.level, message: m.message }]);
        setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600);
      }
    };
    window.addEventListener("message", handler);
    send({ type: "mkt:ready" });
    return () => window.removeEventListener("message", handler);
  }, []);

  const counts = React.useMemo(() => {
    const c: Record<AssetType, number> = { skill: 0, command: 0, agent: 0, hook: 0 };
    for (const a of view.assets) c[a.type]++;
    return c;
  }, [view]);

  const rows = React.useMemo(() => {
    const base: Row[] = type === "plugins" ? view.plugins.map(pluginRow) : view.assets.map(assetRow);
    const needle = q.trim().toLowerCase();
    return base.filter((r) => {
      if (type !== "all" && type !== "plugins" && r.type !== type) return false;
      if (scope === "installed" && r.state !== "installed" && r.state !== "user") return false;
      if (scope === "enabled" && r.enabled === false) return false;
      if (!needle) return true;
      return `${r.name} ${r.description} ${r.where}`.toLowerCase().includes(needle);
    });
  }, [view, q, type, scope]);

  const active = rows[Math.min(sel, rows.length - 1)];
  const setFilter = (next: TypeFilter) => { setType(next); setSel(0); };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { setSel((s) => Math.min(s + 1, rows.length - 1)); e.preventDefault(); }
    else if (e.key === "ArrowUp") { setSel((s) => Math.max(s - 1, 0)); e.preventDefault(); }
    else if (e.key === "Enter" && active?.file) send({ type: "mkt:open", file: active.file });
  };

  let lastType: AssetType | null | undefined;

  return (
    <>
      <div className="hd">
        <div className="title">Marketplace<span className="sub">everything Claude Code can do on this machine</span></div>
        <span className="sp" />
        <button type="button" className="btn" onClick={() => send({ type: "mkt:copy", text: "/plugin marketplace add owner/repo" })}>
          + Add a marketplace
        </button>
        <button type="button" className="btn" onClick={() => send({ type: "mkt:refresh" })}>⟳ Rescan</button>
      </div>

      <div className="bar">
        <div className="search">
          <input
            value={q}
            spellCheck={false}
            autoFocus
            placeholder="Search skills, commands, agents, hooks…"
            onChange={(e) => { setQ(e.target.value); setSel(0); }}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="pills">
          <Pill on={type === "all"} onClick={() => setFilter("all")}>All<span className="n">{view.assets.length}</span></Pill>
          {TYPES.map((t) => (
            <Pill key={t.k} on={type === t.k} onClick={() => setFilter(t.k)}>
              {t.label}<span className="n">{counts[t.k]}</span>
            </Pill>
          ))}
          <Pill on={type === "plugins"} onClick={() => setFilter("plugins")}>
            Plugins<span className="n">{view.plugins.length}</span>
          </Pill>
        </div>
        <div className="pills">
          <Pill on={scope === "all"} onClick={() => { setScope("all"); setSel(0); }}>Everywhere</Pill>
          <Pill on={scope === "installed"} onClick={() => { setScope("installed"); setSel(0); }}>Installed only</Pill>
          <Pill on={scope === "enabled"} onClick={() => { setScope("enabled"); setSel(0); }}>Enabled only</Pill>
        </div>
        {view.marketplaces.length > 0 && (
          <div className="srcs">
            {view.marketplaces.map((m) => (
              <span key={`${m.name}:${m.origin}`} className={`tag${m.stale ? " bad" : ""}`} title={m.origin}>
                {m.name}{m.stale ? " — stale" : ""}
              </span>
            ))}
          </div>
        )}
      </div>

      {loading && <div className="loading">Scanning ~/.claude…</div>}

      {view.notSetUp ? (
        <div className="empty">
          <div className="big">Claude Code isn't set up on this machine yet</div>
          <div>Nothing was found under <code>~/.claude/plugins</code>. Add a marketplace in Claude Code and its plugins, skills and commands will show up here.</div>
        </div>
      ) : (
        <div className="split">
          <div className="results">
            {rows.length === 0 ? (
              <div className="empty">
                <div className="big">Nothing matches{q.trim() ? ` “${q.trim()}”` : ""}</div>
                <div>Try a shorter word, or clear the filters.</div>
              </div>
            ) : (
              rows.map((r, i) => {
                const head = type === "all" && r.type !== lastType ? ((lastType = r.type), r.type) : null;
                return (
                  <React.Fragment key={r.key}>
                    {head && <div className="grouphd"><span className="lb">{LABEL[head]}</span><span className="rule" /></div>}
                    <div
                      className={`row t-${r.type ?? "plugin"}${i === Math.min(sel, rows.length - 1) ? " on" : ""}`}
                      onClick={() => setSel(i)}
                    >
                      <span className="glyph">{r.type ? GLYPH[r.type] : "P"}</span>
                      <span className="body">
                        <span className="top">
                          <span className={`nm${r.type === "command" ? " mono" : ""}`}>{r.display}</span>
                          <span className="meta">{r.where}</span>
                          {r.enabled === false && <span className="tag off">disabled</span>}
                          {r.kind === "plugin" && <span className="tag dim">{stateLabel[r.state]}</span>}
                        </span>
                        {r.description && <span className="ds">{r.description}</span>}
                      </span>
                    </div>
                  </React.Fragment>
                );
              })
            )}
          </div>

          {active && (
            <div className="detail">
              <div className={`dh t-${active.type ?? "plugin"}`}>
                <span className="glyph">{active.type ? GLYPH[active.type] : "P"}</span>
                <span className="dn">{active.display}</span>
              </div>
              <div className="tags">
                <span className="tag">{stateLabel[active.state]}</span>
                {active.enabled === false && <span className="tag off">disabled</span>}
                {active.enabled === true && <span className="tag ok">enabled</span>}
                {active.extra.map((x) => <span key={x} className="tag">{x}</span>)}
              </div>
              <div className="dd">{active.description || "No description in the frontmatter."}</div>
              <dl className="kv">
                <dt>Where</dt><dd>{active.where}</dd>
                {active.rel && (<><dt>File</dt><dd>{active.rel}</dd></>)}
              </dl>
              {active.copy && (
                <div className="snip">
                  <pre>{active.copy}</pre>
                  <button type="button" className="btn cp" onClick={() => send({ type: "mkt:copy", text: active.copy })}>Copy</button>
                </div>
              )}
              {active.file && (
                <div className="acts">
                  <button type="button" className="btn pri" onClick={() => send({ type: "mkt:open", file: active.file })}>Open file</button>
                  <button type="button" className="btn" onClick={() => send({ type: "mkt:reveal", file: active.file })}>Reveal in Finder</button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="toasts">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.level}`}>{t.message}</div>)}
      </div>
    </>
  );
}
```

- [ ] **Step 4: Rewrite `src/webview/marketplaceStyles.ts`**

Port the `#A` rules and shared primitives from `docs/mockups/2026-07-26-marketplace-ui.html`, swapping the mockup's hardcoded hex values for VS Code theme variables:

```ts
// Injected into the Marketplace panel <head>. Uses VS Code theme variables so it
// matches the editor theme (light or dark). Mirrors the Deck's visual grammar.
export const MARKETPLACE_CSS = `
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background); }
  #root { height: 100vh; display: flex; flex-direction: column; }

  :root {
    --hair: var(--vscode-panel-border);
    --mono: var(--vscode-editor-font-family, ui-monospace, monospace);
    --skill: var(--vscode-charts-blue, #4aa3df);
    --command: var(--vscode-charts-green, #4ac26b);
    --agent: var(--vscode-charts-purple, #b083f0);
    --hook: var(--vscode-charts-yellow, #d7a531);
    --plugin: var(--vscode-descriptionForeground);
  }

  .hd { flex: none; display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    padding: 13px 18px; border-bottom: 1px solid var(--hair); }
  .hd .title { font-size: 15px; font-weight: 600; letter-spacing: -.01em; }
  .hd .title .sub { color: var(--vscode-descriptionForeground); font-weight: 400; margin-left: 7px; font-size: 12px; }
  .sp { flex: 1; }

  .btn { cursor: pointer; font-family: inherit; font-size: 12px; padding: 5px 11px; border-radius: 6px;
    border: 1px solid var(--hair); background: transparent; color: var(--vscode-foreground); }
  .btn:hover { background: var(--vscode-toolbar-hoverBackground); }
  .btn.pri { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border-color: var(--vscode-button-background); }
  .btn.pri:hover { background: var(--vscode-button-hoverBackground); }

  .bar { flex: none; padding: 11px 18px; display: flex; flex-direction: column; gap: 9px;
    border-bottom: 1px solid var(--hair); }
  .search { max-width: 520px; }
  .search input { width: 100%; padding: 7px 10px; border-radius: 7px; font-size: 13px; font-family: inherit;
    border: 1px solid var(--hair); background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  .search input:focus { outline: none; border-color: var(--vscode-focusBorder); }

  .pills { display: flex; gap: 5px; flex-wrap: wrap; }
  .pill { cursor: pointer; font-family: inherit; display: inline-flex; align-items: center; gap: 6px;
    font-size: 11.5px; padding: 4px 10px; border-radius: 20px; border: 1px solid var(--hair);
    background: transparent; color: var(--vscode-foreground); }
  .pill:hover { background: var(--vscode-toolbar-hoverBackground); }
  .pill.on { background: var(--vscode-list-activeSelectionBackground); border-color: var(--vscode-focusBorder);
    color: var(--vscode-list-activeSelectionForeground); }
  .pill .n { font-family: var(--mono); font-size: 10px; opacity: .8; }

  .srcs { display: flex; gap: 5px; flex-wrap: wrap; }
  .tag { font-size: 10px; padding: 1px 7px; border-radius: 20px; border: 1px solid var(--hair);
    color: var(--vscode-descriptionForeground); white-space: nowrap; }
  .tag.ok { color: var(--vscode-charts-green, #4ac26b); }
  .tag.off { text-decoration: line-through; }
  .tag.bad { color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
  .tag.dim { opacity: .8; }

  .loading { flex: none; padding: 8px 18px; color: var(--vscode-descriptionForeground); font-size: 12px; }
  .split { flex: 1; min-height: 0; display: flex; }
  .results { flex: 1; min-width: 0; overflow-y: auto; border-right: 1px solid var(--hair); padding: 6px 0 30px; }
  .grouphd { display: flex; align-items: center; gap: 8px; padding: 11px 18px 5px; }
  .grouphd .lb { font-size: 10px; text-transform: uppercase; letter-spacing: .09em;
    color: var(--vscode-descriptionForeground); font-weight: 600; }
  .grouphd .rule { flex: 1; height: 1px; background: var(--hair); }

  .row { display: flex; align-items: flex-start; gap: 10px; padding: 7px 18px; cursor: pointer;
    border-left: 2px solid transparent; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.on { background: var(--vscode-list-activeSelectionBackground); border-left-color: var(--vscode-focusBorder); }
  .row .body { min-width: 0; flex: 1; }
  .row .top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .row .nm { font-size: 12.5px; font-weight: 500; }
  .row .mono { font-family: var(--mono); }
  .row .meta, .row .ds { font-size: 11.5px; color: var(--vscode-descriptionForeground); }
  .row .ds { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .glyph { flex: none; width: 19px; height: 19px; border-radius: 5px; display: inline-flex;
    align-items: center; justify-content: center; font-size: 10.5px; font-weight: 700; font-family: var(--mono); }
  .t-skill .glyph { background: color-mix(in srgb, var(--skill) 18%, transparent); color: var(--skill); }
  .t-command .glyph { background: color-mix(in srgb, var(--command) 18%, transparent); color: var(--command); }
  .t-agent .glyph { background: color-mix(in srgb, var(--agent) 18%, transparent); color: var(--agent); }
  .t-hook .glyph { background: color-mix(in srgb, var(--hook) 18%, transparent); color: var(--hook); }
  .t-plugin .glyph { background: color-mix(in srgb, var(--plugin) 18%, transparent); color: var(--plugin); }

  .detail { flex: 0 0 39%; max-width: 460px; overflow-y: auto; padding: 18px;
    display: flex; flex-direction: column; gap: 13px; }
  .detail .dh { display: flex; align-items: center; gap: 9px; }
  .detail .dn { font-size: 16px; font-weight: 600; word-break: break-word; }
  .detail .tags, .acts { display: flex; gap: 6px; flex-wrap: wrap; }
  .detail .dd { font-size: 12.5px; }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 5px 12px; font-size: 11.5px; margin: 0; }
  .kv dt { color: var(--vscode-descriptionForeground); }
  .kv dd { margin: 0; font-family: var(--mono); font-size: 11px; word-break: break-all; }
  .snip { position: relative; }
  .snip pre { margin: 0; font-family: var(--mono); font-size: 11.5px; overflow-x: auto;
    background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.1));
    border: 1px solid var(--hair); border-radius: 7px; padding: 9px 74px 9px 11px; }
  .snip .cp { position: absolute; top: 6px; right: 6px; }

  .empty { padding: 44px 20px; text-align: center; color: var(--vscode-descriptionForeground); }
  .empty .big { font-size: 15px; color: var(--vscode-foreground); margin-bottom: 5px; }
  .empty code { font-family: var(--mono); font-size: 11.5px; }

  .toasts { position: fixed; bottom: 16px; right: 16px; display: flex; flex-direction: column; gap: 8px; }
  .toast { padding: 8px 14px; border-radius: 6px; font-size: 12px; border: 1px solid var(--hair);
    background: var(--vscode-editorWidget-background); }
  .toast.success { border-color: var(--vscode-charts-green, #4ac26b); }
  .toast.error { border-color: var(--vscode-errorForeground); }

  .results::-webkit-scrollbar, .detail::-webkit-scrollbar { width: 9px; }
  .results::-webkit-scrollbar-thumb, .detail::-webkit-scrollbar-thumb {
    background: var(--vscode-scrollbarSlider-background); border-radius: 8px; }
`;
```

- [ ] **Step 5: Run the UI tests**

Run: `npx vitest run test/webview/MarketplaceApp.test.tsx`
Expected: PASS, 20 tests.

- [ ] **Step 6: Build, typecheck, run everything**

Run: `npm run build && npm run typecheck && npm test`
Expected: all PASS; `dist/marketplace.js` rebuilt.

- [ ] **Step 7: Commit**

```bash
git add src/webview/MarketplaceApp.tsx src/webview/marketplaceStyles.ts test/webview/MarketplaceApp.test.tsx
git commit -m "feat(marketplace): search-first Palette UI over local assets"
```

---

### Task 6: Remove the `gh` path and document the panel

**Files:**
- Delete: `src/engine/marketplace.ts`, `test/unit/engine/marketplace.test.ts`
- Modify: `src/types.ts`, `src/config.ts:106` and `:153-156`, `package.json:398-406`, `test/unit/config.test.ts:245-254`, `README.md:66-76` and `:139`, `CHANGELOG.md`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: no new API. Removes `normalizeRepo`, `buildMarketplaceView`, `fetchMarketplace`, `MarketplaceParseError`, `SkillRef`, `PluginView`, `MarketplaceErrorKind`, `MarketplaceView`, `AgentFlowConfig.marketplaces`, the `mkt:add` / `mkt:remove` / `mkt:state` messages, and the `agentFlow.marketplaces` setting.

- [ ] **Step 1: Delete the dead engine module and its test**

```bash
git rm src/engine/marketplace.ts test/unit/engine/marketplace.test.ts
```

- [ ] **Step 2: Remove the old types from `src/types.ts`**

Delete the block from the `// ── The Marketplace: plugin/skill browser ───` comment through the closing `}` of `interface MarketplaceView` — that is `SkillRef`, `PluginView`, `MarketplaceErrorKind` and `MarketplaceView`. Keep the new `// ── The Marketplace: local asset browser ───` block.

In `InboundMessage`, delete these two lines:

```ts
  | { type: "mkt:add"; repo: string }
  | { type: "mkt:remove"; repo: string }
```

In `OutboundMessage`, delete this line:

```ts
  | { type: "mkt:state"; marketplaces: MarketplaceView[] }
```

- [ ] **Step 3: Remove the config key**

In `src/config.ts`, delete the `marketplaces: string[];` field (line 106) from `AgentFlowConfig`, and delete this getter from `getConfig()`:

```ts
    marketplaces: (() => {
      const m = c.get<string[]>("marketplaces");
      return Array.isArray(m) ? m.filter((x) => typeof x === "string" && x.length > 0) : [];
    })(),
```

In `package.json`, delete the `"agentFlow.marketplaces"` property block (lines 398–406). Take care to leave the preceding property's trailing comma valid JSON.

In `test/unit/config.test.ts`, delete the whole `describe("getConfig — marketplaces", …)` block (lines 245–254).

- [ ] **Step 4: Run everything**

Run: `npm run typecheck && npm test`
Expected: PASS. Typecheck is the real gate here — it proves nothing still references the deleted types.

- [ ] **Step 5: Update `README.md`**

Replace the body of the `### The Marketplace — browse plugins & skills` section (lines ~66–76) with:

```markdown
### The Marketplace — browse your skills, commands & agents

The **Marketplace** (open it with the puzzle-piece (`$(extensions)`) button beside the
Deck button in the Tasks title bar) is a searchable browser of everything Claude Code
can do on this machine. It reads your local `~/.claude` — the marketplaces you've added,
the plugins you've installed, and the skills, slash commands, agents and hooks inside
them — plus any skills or commands you wrote yourself in `~/.claude` or in the open
workspace's `.claude/`.

Search across every asset, filter by type or to just what's installed or enabled, then
open a skill's `SKILL.md` in an editor tab or copy the command you'd type to use it. It
shows which plugins are disabled, and lists plugins your marketplaces catalogue but
haven't downloaded yet, with the `/plugin install` command to get them.

The panel is **read-only and offline** — it never writes to `~/.claude`, never runs
`/plugin install`, and makes no network calls. Add marketplaces in Claude Code itself
(`/plugin marketplace add owner/repo`) and they appear here on the next scan.
```

Delete the `agentFlow.marketplaces` row from the settings table (line ~139).

- [ ] **Step 6: Add the CHANGELOG entry and bump the version**

Read the current version in `package.json` (`0.1.23` at the time of writing; use whatever is there) and bump the patch. Add at the top of `CHANGELOG.md`, matching the file's existing heading style:

```markdown
## 0.1.24

### Changed

- **The Marketplace is now a local asset browser.** It reads `~/.claude` and the open
  workspace instead of GitHub repos you had to register by hand, so it shows your
  skills, slash commands, agents and hooks with no setup and no `gh`. Search across
  everything, filter by type or to installed/enabled only, open a source file, or copy
  the invocation. Disabled plugins and not-yet-downloaded plugins are shown too.

### Removed

- The `agentFlow.marketplaces` setting and the `gh`-backed remote fetch. Add
  marketplaces in Claude Code (`/plugin marketplace add owner/repo`); they appear here
  on the next scan.
```

- [ ] **Step 7: Final verification**

Run: `npm run build && npm run typecheck && npm test && npm run test:cov`
Expected: all PASS, and coverage still above the configured thresholds (statements 90, branches 85, functions 85, lines 90).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(marketplace)!: drop the gh remote path, document the local browser"
```

---

## Notes for the implementer

- **`npx vitest run <file>` for a single file, `npm test` for everything.** Vitest's `-t` flag filters by test name.
- **The `vscode` module is mocked** at `test/_mocks/vscode.ts` and aliased in `vitest.config.ts`. Host tests import the mock by relative path to get typed mock handles; `resetVscodeMocks()` runs before every test via `test/_setup.ts`.
- **Webview tests need `// @vitest-environment jsdom`** as the very first line of the file.
- **The fake panel exposes `_fire(msg)`, `_fireDispose()` and `_fireViewState()`** to drive the host's callbacks.
- **`color-mix()`** is used in the CSS; VS Code webviews run Chromium, so it is safe there. It is not exercised by jsdom tests.
- The reference mockup (`docs/mockups/2026-07-26-marketplace-ui.html`, layout A) is **gitignored** because it embeds real local plugin inventories. Regenerate it with the scripts noted in the spec if you want it, but do not commit it.
