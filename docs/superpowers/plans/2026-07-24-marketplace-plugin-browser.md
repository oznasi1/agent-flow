# Marketplace Plugin/Skill Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only "Marketplace" webview to Agent Flow that lets a user register GitHub plugin-marketplace repos and browse their plugins (skills/agents/commands) with copy-able `/plugin` install commands, opened from a button beside the Deck.

**Architecture:** Mirrors the existing Deck: a singleton `WebviewPanel` (`MarketplacePanel`) whose React UI (`MarketplaceApp`) talks to the host over a typed `mkt:`-namespaced message protocol. A pure engine module (`src/engine/marketplace.ts`) reads repos through the user's `gh` CLI (two `gh api` calls per repo) and derives the view model with no I/O in its core builder, so the derivation is fully unit-tested from fixtures. The list of repos persists in VS Code global config (`agentFlow.marketplaces`); add/remove happens inside the panel.

**Tech Stack:** TypeScript, VS Code extension API, React (classic JSX runtime), esbuild (IIFE webview bundles), Vitest (+ jsdom + @testing-library/react for webview tests), the `gh` CLI (via `child_process.execFile`).

## Global Constraints

- **VS Code engine:** `^1.90.0` (do not use newer APIs).
- **No new runtime npm dependencies.** Use Node built-ins (`child_process`, `util`) and existing deps only.
- **`gh` is invoked via `execFile`/`execFileSync` with an argument array — never a shell string.** All `gh` failures must be caught and mapped to a typed error; a failure for one repo must never blank the panel or break others.
- **Webview CSP:** identical to the Deck's — `default-src 'none'; img-src ${cspSource} https: data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'`.
- **Theme:** style with `--vscode-*` theme variables only (works in light and dark).
- **Panel is read-only:** never write to `~/.claude`, never run `/plugin install`. Only display and copy commands.
- **Coverage thresholds are enforced** (`vitest.config.ts`): statements 90, branches 85, functions 85, lines 90. New logic files must be tested; pure-view/style/entry files go in the coverage `exclude` list (as `deckStyles.ts`/`deck.tsx` already are).
- **Test commands:** `npm test` (all), `npm run test -- <path>` (one file). Type-check with `npm run check-types` (`tsc --noEmit`). Build with `npm run build`.
- **Org rule:** any Jira work item created/updated via a Jira connector must get the `claude-code` label. (No Jira writes occur in this feature, so nothing to do here — noted for completeness.)
- **Release-on-merge:** every merge to `main` bumps the version, rebuilds a fresh `.vsix`, and removes the old one (see Task 8).

---

## File Structure

**New files**
- `src/engine/marketplace.ts` — `gh` runner + `normalizeRepo` + pure `buildMarketplaceView` + `fetchMarketplace` (error mapping). The tested core.
- `src/marketplaceView.ts` — the `MarketplacePanel` singleton (host side, message handling).
- `src/webview/MarketplaceApp.tsx` — the React UI.
- `src/webview/marketplace.tsx` — webview entry (mounts CSS, external-link intercept, renders `MarketplaceApp`).
- `src/webview/marketplaceStyles.ts` — the panel CSS string.
- `test/unit/engine/marketplace.test.ts` — engine tests.
- `test/unit/marketplaceView.test.ts` — panel tests.
- `test/webview/MarketplaceApp.test.tsx` — UI tests (jsdom).

**Modified files**
- `src/types.ts` — view types + `mkt:` messages.
- `src/config.ts` — `marketplaces: string[]` in `AgentFlowConfig` + `getConfig()`.
- `src/extension.ts` — register `agentFlow.openMarketplace`.
- `package.json` — command, `view/title` menu (re-ordered), `agentFlow.marketplaces` config property.
- `esbuild.js` — 4th bundle → `dist/marketplace.js`.
- `vitest.config.ts` — add `marketplace.tsx` + `marketplaceStyles.ts` to coverage `exclude`.
- `test/unit/config.test.ts`, `test/unit/extension.test.ts` — extend for the new config field + command.
- `README.md`, `CHANGELOG.md`, `package.json` version — Task 8.

---

## Task 1: Shared types + config field

**Files:**
- Modify: `src/types.ts` (append view types; extend `InboundMessage`/`OutboundMessage` unions)
- Modify: `src/config.ts` (`AgentFlowConfig` + `getConfig()`)
- Test: `test/unit/config.test.ts`

**Interfaces:**
- Consumes: nothing (foundation task).
- Produces:
  - `SkillRef { name: string; path: string }`
  - `PluginView { name: string; description: string; source: string; skills: SkillRef[]; agents: SkillRef[]; commands: SkillRef[]; installCommand: string }`
  - `MarketplaceErrorKind = "gh-missing" | "gh-unauthenticated" | "repo-not-found" | "not-a-marketplace" | "parse-error" | "unknown"`
  - `MarketplaceView { repo: string; name: string; description: string; owner: string; addCommand: string; plugins: PluginView[]; error?: { kind: MarketplaceErrorKind; message: string } }`
  - Inbound messages: `{ type: "mkt:ready" }`, `{ type: "mkt:refresh" }`, `{ type: "mkt:add"; repo: string }`, `{ type: "mkt:remove"; repo: string }`, `{ type: "mkt:copy"; text: string }`
  - Outbound messages: `{ type: "mkt:state"; marketplaces: MarketplaceView[] }`, `{ type: "mkt:loading"; loading: boolean }`
  - `getConfig().marketplaces: string[]`

- [ ] **Step 1: Add the view types to `src/types.ts`**

Append at the end of the file (after the Deck types, before or after the message unions is fine — but the message unions reference these, so put them ABOVE the unions):

```ts
// ── The Marketplace: plugin/skill browser ───────────────────────────────────

/** A named item inside a plugin (skill, agent, or command) + its repo-relative path. */
export interface SkillRef {
  name: string;
  path: string;
}

/** One plugin listed by a marketplace, with its discovered contents. */
export interface PluginView {
  name: string;
  description: string;
  source: string; // repo-relative plugin directory, e.g. "plugins/cicd-plugin"
  skills: SkillRef[];
  agents: SkillRef[];
  commands: SkillRef[];
  installCommand: string; // "/plugin install <name>@<marketplace-name>"
}

export type MarketplaceErrorKind =
  | "gh-missing"
  | "gh-unauthenticated"
  | "repo-not-found"
  | "not-a-marketplace"
  | "parse-error"
  | "unknown";

/** A resolved marketplace repo — either its parsed contents, or a scoped error. */
export interface MarketplaceView {
  repo: string; // canonical "owner/repo"
  name: string; // marketplace.json name (the @handle for installs)
  description: string;
  owner: string;
  addCommand: string; // "/plugin marketplace add owner/repo"
  plugins: PluginView[];
  error?: { kind: MarketplaceErrorKind; message: string };
}
```

- [ ] **Step 2: Extend the message unions in `src/types.ts`**

In `InboundMessage`, add these members (before the closing `;`):

```ts
  // The Marketplace (separate webview panel)
  | { type: "mkt:ready" }
  | { type: "mkt:refresh" }
  | { type: "mkt:add"; repo: string }
  | { type: "mkt:remove"; repo: string }
  | { type: "mkt:copy"; text: string }
```

In `OutboundMessage`, add:

```ts
  // The Marketplace
  | { type: "mkt:state"; marketplaces: MarketplaceView[] }
  | { type: "mkt:loading"; loading: boolean }
```

- [ ] **Step 3: Write the failing config test**

Add to `test/unit/config.test.ts` (inside the existing top-level `describe`, matching the file's style):

```ts
  it("defaults marketplaces to an empty array", () => {
    setConfig({});
    expect(getConfig().marketplaces).toEqual([]);
  });

  it("reads marketplaces and drops non-string / empty entries", () => {
    setConfig({ marketplaces: ["owner/repo", "", 42, "a/b"] });
    expect(getConfig().marketplaces).toEqual(["owner/repo", "a/b"]);
  });
```

If `setConfig`/`getConfig` aren't already imported at the top of `test/unit/config.test.ts`, verify the existing imports (the file already imports `getConfig` from `../../src/config` and `setConfig` from `../_mocks/vscode`); reuse them.

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm test -- test/unit/config.test.ts`
Expected: FAIL — `getConfig().marketplaces` is `undefined` (property doesn't exist yet).

- [ ] **Step 5: Add `marketplaces` to `AgentFlowConfig`**

In `src/config.ts`, add to the `AgentFlowConfig` interface (near `repoBlocklist`):

```ts
  marketplaces: string[];
```

- [ ] **Step 6: Populate it in `getConfig()`**

In `src/config.ts`, inside the returned object (place it right after the `repoBlocklist` block), add:

```ts
    marketplaces: (() => {
      const m = c.get<string[]>("marketplaces");
      return Array.isArray(m) ? m.filter((x) => typeof x === "string" && x.length > 0) : [];
    })(),
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm test -- test/unit/config.test.ts`
Expected: PASS.

- [ ] **Step 8: Type-check**

Run: `npm run check-types`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/types.ts src/config.ts test/unit/config.test.ts
git commit -m "feat(marketplace): shared types + agentFlow.marketplaces config"
```

---

## Task 2: `normalizeRepo` — accept owner/repo or a GitHub URL

**Files:**
- Create: `src/engine/marketplace.ts`
- Test: `test/unit/engine/marketplace.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `normalizeRepo(input: string): string | null` — returns canonical `"owner/repo"`, or `null` if the input isn't a recognizable GitHub repo reference.

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine/marketplace.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { normalizeRepo } from "../../../src/engine/marketplace";

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
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/unit/engine/marketplace.test.ts`
Expected: FAIL — cannot import `normalizeRepo` (module/function doesn't exist).

- [ ] **Step 3: Implement `normalizeRepo`**

Create `src/engine/marketplace.ts` with:

```ts
import { execFile } from "child_process";
import { promisify } from "util";
import {
  MarketplaceView,
  MarketplaceErrorKind,
  PluginView,
  SkillRef,
} from "../types";

const execFileAsync = promisify(execFile);

/** Accept "owner/repo", an https GitHub URL, or an scp-style git@ URL. Returns
 * the canonical "owner/repo", or null if it isn't a recognizable GitHub repo. */
export function normalizeRepo(input: string): string | null {
  const s = (input ?? "").trim();
  if (!s) return null;
  const strip = (owner: string, repo: string): string | null => {
    const o = owner.trim();
    const r = repo.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
    return o && r && !o.includes("/") && !r.includes("/") ? `${o}/${r}` : null;
  };
  // git@github.com:owner/repo.git
  const scp = s.match(/^git@github\.com:([^/]+)\/(.+)$/i);
  if (scp) return strip(scp[1], scp[2]);
  // https://github.com/owner/repo(.git)
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (u.hostname.toLowerCase() !== "github.com") return null;
      const parts = u.pathname.replace(/^\/+/, "").split("/");
      if (parts.length < 2) return null;
      return strip(parts[0], parts[1]);
    } catch {
      return null;
    }
  }
  // owner/repo (allow a trailing slash)
  const bare = s.replace(/\/+$/, "");
  const parts = bare.split("/");
  if (parts.length === 2) return strip(parts[0], parts[1]);
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/unit/engine/marketplace.test.ts`
Expected: PASS (all `normalizeRepo` cases).

- [ ] **Step 5: Commit**

```bash
git add src/engine/marketplace.ts test/unit/engine/marketplace.test.ts
git commit -m "feat(marketplace): normalizeRepo repo-reference parser"
```

---

## Task 3: `buildMarketplaceView` — pure derivation from manifest + tree

**Files:**
- Modify: `src/engine/marketplace.ts`
- Test: `test/unit/engine/marketplace.test.ts`

**Interfaces:**
- Consumes: `normalizeRepo` (same module); types from Task 1.
- Produces: `buildMarketplaceView(repo: string, manifestJson: string, treePaths: string[]): MarketplaceView`. Pure — no I/O. Throws `MarketplaceParseError` (exported) when `manifestJson` isn't valid JSON. Skill discovery: any tree path matching `<source>/**/<skillName>/SKILL.md` yields a skill named after the immediate parent folder. Agents: `<source>/agents/<name>.md`. Commands: `<source>/commands/<name>.md`. Each list is sorted by name.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/engine/marketplace.test.ts`:

```ts
import { buildMarketplaceView, MarketplaceParseError } from "../../../src/engine/marketplace";

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

  it("throws MarketplaceParseError on malformed JSON", () => {
    expect(() => buildMarketplaceView("o/r", "{ not json", [])).toThrow(MarketplaceParseError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/unit/engine/marketplace.test.ts`
Expected: FAIL — `buildMarketplaceView` / `MarketplaceParseError` not exported.

- [ ] **Step 3: Implement `buildMarketplaceView`**

Add to `src/engine/marketplace.ts` (below `normalizeRepo`):

```ts
/** Thrown by buildMarketplaceView when the manifest isn't valid JSON. */
export class MarketplaceParseError extends Error {}

/** Strip a leading "./" and any trailing "/" from a repo-relative path. */
function cleanPath(p: string): string {
  return (p ?? "").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** Given a plugin's source dir and the full tree, discover its skills/agents/commands. */
function discover(source: string, treePaths: string[]): Pick<PluginView, "skills" | "agents" | "commands"> {
  const prefix = source ? `${source}/` : "";
  const under = treePaths.filter((p) => p.startsWith(prefix));
  const byName = (a: SkillRef, b: SkillRef) => a.name.localeCompare(b.name);

  // Skill: any "<...>/<skillName>/SKILL.md" under the plugin dir → name = parent folder.
  const skills: SkillRef[] = under
    .filter((p) => p.endsWith("/SKILL.md"))
    .map((p) => {
      const segs = p.split("/");
      return { name: segs[segs.length - 2], path: p };
    })
    .sort(byName);

  // Agent / command: "<source>/agents/<name>.md" and "<source>/commands/<name>.md".
  const direct = (dir: string): SkillRef[] =>
    under
      .filter((p) => p.startsWith(`${prefix}${dir}/`) && p.endsWith(".md") && p.split("/").length === prefix.split("/").length + 1)
      .map((p) => ({ name: p.split("/").pop()!.replace(/\.md$/, ""), path: p }))
      .sort(byName);

  return { skills, agents: direct("agents"), commands: direct("commands") };
}

/** Pure: derive the view model from the raw manifest JSON + the repo's file tree. */
export function buildMarketplaceView(repo: string, manifestJson: string, treePaths: string[]): MarketplaceView {
  let m: any;
  try {
    m = JSON.parse(manifestJson);
  } catch {
    throw new MarketplaceParseError(`marketplace.json in ${repo} is not valid JSON`);
  }
  const name: string = typeof m?.name === "string" && m.name ? m.name : repo;
  const description: string =
    (typeof m?.description === "string" && m.description) ||
    (typeof m?.metadata?.description === "string" && m.metadata.description) ||
    "";
  const owner: string =
    typeof m?.owner === "string" ? m.owner : typeof m?.owner?.name === "string" ? m.owner.name : "";

  const plugins: PluginView[] = Array.isArray(m?.plugins)
    ? m.plugins
        .filter((p: any) => p && typeof p.name === "string")
        .map((p: any): PluginView => {
          const source = cleanPath(typeof p.source === "string" ? p.source : p.name);
          return {
            name: p.name,
            description: typeof p.description === "string" ? p.description : "",
            source,
            installCommand: `/plugin install ${p.name}@${name}`,
            ...discover(source, treePaths),
          };
        })
    : [];

  return {
    repo,
    name,
    description,
    owner,
    addCommand: `/plugin marketplace add ${repo}`,
    plugins,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/unit/engine/marketplace.test.ts`
Expected: PASS (all `buildMarketplaceView` cases).

Note: the `direct()` length check uses `prefix.split("/").length + 1`. When `source` is `"plugins/cicd-plugin"`, `prefix` = `"plugins/cicd-plugin/"` → `split("/")` = `["plugins","cicd-plugin",""]` (length 3); an agent path `"plugins/cicd-plugin/agents/pipeline-agent.md"` splits to length 4 = 3 + 1. Verify the test passes; if the off-by-one differs on your machine, adjust to compare against `${prefix}${dir}/<one-segment>.md` via a regex `new RegExp(\`^\${escaped}\${dir}/[^/]+\\.md$\`)` instead of the length check. Prefer the regex form if in doubt:

```ts
  const direct = (dir: string): SkillRef[] => {
    const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${dir}/[^/]+\\.md$`);
    return under
      .filter((p) => re.test(p))
      .map((p) => ({ name: p.split("/").pop()!.replace(/\.md$/, ""), path: p }))
      .sort(byName);
  };
```

Use the regex form in the committed code (it's unambiguous).

- [ ] **Step 5: Commit**

```bash
git add src/engine/marketplace.ts test/unit/engine/marketplace.test.ts
git commit -m "feat(marketplace): pure buildMarketplaceView derivation"
```

---

## Task 4: `fetchMarketplace` — gh calls + typed error mapping

**Files:**
- Modify: `src/engine/marketplace.ts`
- Test: `test/unit/engine/marketplace.test.ts`

**Interfaces:**
- Consumes: `buildMarketplaceView`, `MarketplaceParseError` (same module).
- Produces:
  - `type GhResult = { ok: boolean; stdout: string; stderr: string }`
  - `type GhRunner = (args: string[]) => Promise<GhResult>`
  - `fetchMarketplace(repo: string, run?: GhRunner): Promise<MarketplaceView>` — never rejects; on failure returns a `MarketplaceView` with `error` set (empty `plugins`). The default runner shells out to `gh`. Call sequence per repo: (1) `gh api repos/{repo}/git/trees/HEAD?recursive=1 --jq .tree[].path`; (2) `gh api repos/{repo}/contents/.claude-plugin/marketplace.json --jq .content` → base64-decode → `buildMarketplaceView`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/engine/marketplace.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/unit/engine/marketplace.test.ts`
Expected: FAIL — `fetchMarketplace` / `GhRunner` not exported.

- [ ] **Step 3: Implement the gh runner + `fetchMarketplace`**

Add to `src/engine/marketplace.ts`:

```ts
export interface GhResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}
export type GhRunner = (args: string[]) => Promise<GhResult>;

const GH_TIMEOUT_MS = 20_000;

/** Default runner: shell out to the `gh` CLI. Never throws for a non-zero exit —
 * only a spawn failure (e.g. gh missing) rejects, which fetchMarketplace catches. */
const defaultGh: GhRunner = async (args: string[]) => {
  try {
    const { stdout, stderr } = await execFileAsync("gh", args, {
      timeout: GH_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr };
  } catch (e: any) {
    if (e && e.code === "ENOENT") throw e; // gh not installed — surface to the mapper
    return { ok: false, stdout: e?.stdout ?? "", stderr: e?.stderr ?? String(e?.message ?? e) };
  }
};

function mapStderr(stderr: string): MarketplaceErrorKind | null {
  if (/HTTP 401|HTTP 403|auth|login|Bad credentials/i.test(stderr)) return "gh-unauthenticated";
  if (/HTTP 404|Not Found|Could not resolve/i.test(stderr)) return "repo-not-found";
  return null;
}

function errView(repo: string, kind: MarketplaceErrorKind): MarketplaceView {
  const messages: Record<MarketplaceErrorKind, string> = {
    "gh-missing": "GitHub CLI (gh) not found. Install it to browse marketplaces.",
    "gh-unauthenticated": "Not authenticated. Run `gh auth login` to browse marketplaces.",
    "repo-not-found": "Repo not found, or you don't have access.",
    "not-a-marketplace": "No .claude-plugin/marketplace.json — this repo isn't a Claude Code marketplace.",
    "parse-error": "Couldn't read this marketplace's manifest (invalid JSON).",
    unknown: "Couldn't load this marketplace.",
  };
  return { repo, name: repo, description: "", owner: "", addCommand: `/plugin marketplace add ${repo}`, plugins: [], error: { kind, message: messages[kind] } };
}

/** Read a marketplace repo via gh (2 calls). Never rejects — failures become an
 * `error` on the returned view so one bad repo can't break the panel. */
export async function fetchMarketplace(repo: string, run: GhRunner = defaultGh): Promise<MarketplaceView> {
  // 1) tree
  let tree: GhResult;
  try {
    tree = await run(["api", `repos/${repo}/git/trees/HEAD?recursive=1`, "--jq", ".tree[].path"]);
  } catch (e: any) {
    return errView(repo, e?.code === "ENOENT" ? "gh-missing" : "unknown");
  }
  if (!tree.ok) return errView(repo, mapStderr(tree.stderr) ?? "unknown");
  const treePaths = tree.stdout.split("\n").map((s) => s.trim()).filter(Boolean);

  // 2) manifest
  let manifest: GhResult;
  try {
    manifest = await run(["api", `repos/${repo}/contents/.claude-plugin/marketplace.json`, "--jq", ".content"]);
  } catch (e: any) {
    return errView(repo, e?.code === "ENOENT" ? "gh-missing" : "unknown");
  }
  if (!manifest.ok) {
    const kind = mapStderr(manifest.stderr);
    return errView(repo, kind === "repo-not-found" ? "not-a-marketplace" : kind ?? "unknown");
  }
  const json = Buffer.from(manifest.stdout.replace(/\s+/g, ""), "base64").toString("utf8");
  try {
    return buildMarketplaceView(repo, json, treePaths);
  } catch (e) {
    if (e instanceof MarketplaceParseError) return errView(repo, "parse-error");
    return errView(repo, "unknown");
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/unit/engine/marketplace.test.ts`
Expected: PASS (all engine tests). Confirm both the tree-404→repo-not-found and manifest-404→not-a-marketplace cases pass.

- [ ] **Step 5: Type-check**

Run: `npm run check-types`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/engine/marketplace.ts test/unit/engine/marketplace.test.ts
git commit -m "feat(marketplace): fetchMarketplace via gh with typed error mapping"
```

---

## Task 5: `MarketplacePanel` — the host-side singleton webview

**Files:**
- Create: `src/marketplaceView.ts`
- Test: `test/unit/marketplaceView.test.ts`

**Interfaces:**
- Consumes: `fetchMarketplace`, `normalizeRepo` from `./engine/marketplace`; `InboundMessage`, `OutboundMessage`, `MarketplaceView` from `./types`.
- Produces: `class MarketplacePanel` with `static show(context: vscode.ExtensionContext, log: (m: string) => void): void`. Reads/writes the repo list via `vscode.workspace.getConfiguration("agentFlow")` key `marketplaces` (global target). Caches views in-memory with a 1h TTL; `mkt:refresh` bypasses the cache.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/marketplaceView.test.ts` (modeled on `test/unit/deckView.test.ts`):

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { window, ViewColumn, env, workspace, setConfig, ConfigurationTarget } from "../_mocks/vscode";
import { fakeContext } from "../_helpers/factories";
import type { MarketplaceView } from "../../src/types";

const h = vi.hoisted(() => ({
  fetchMarketplace: vi.fn(),
  normalizeRepo: vi.fn((s: string) => s),
}));
vi.mock("../../src/engine/marketplace", () => ({
  fetchMarketplace: h.fetchMarketplace,
  normalizeRepo: h.normalizeRepo,
}));

import { MarketplacePanel } from "../../src/marketplaceView";

const mkView = (over: Partial<MarketplaceView> = {}): MarketplaceView => ({
  repo: "o/r", name: "mkt", description: "", owner: "", addCommand: "/plugin marketplace add o/r", plugins: [], ...over,
});
const lastPanel = () => window.createWebviewPanel.mock.results.at(-1)!.value as ReturnType<typeof import("../_mocks/vscode").makeWebviewPanel>;
const posts = (p: ReturnType<typeof lastPanel>) => p.webview.postMessage.mock.calls.map((c) => c[0] as any);
const show = () => MarketplacePanel.show(fakeContext().context as any, () => {});

beforeEach(() => {
  setConfig({ marketplaces: ["o/r"] });
  h.fetchMarketplace.mockReset().mockResolvedValue(mkView());
  h.normalizeRepo.mockReset().mockImplementation((s: string) => (s.includes("/") ? s : null));
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

  it("posts mkt:state with a fetched view on ready", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    const state = posts(p).reverse().find((m) => m.type === "mkt:state");
    expect(state.marketplaces).toHaveLength(1);
    expect(state.marketplaces[0].name).toBe("mkt");
    expect(h.fetchMarketplace).toHaveBeenCalledWith("o/r");
  });

  it("adds a repo: normalizes, writes global config, fetches, re-posts", async () => {
    setConfig({ marketplaces: [] });
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:add", repo: "new/repo" });
    expect(workspace.getConfiguration("agentFlow").get("marketplaces")).toContain("new/repo");
    expect(h.fetchMarketplace).toHaveBeenCalledWith("new/repo");
    expect(posts(p).some((m) => m.type === "mkt:state")).toBe(true);
  });

  it("rejects an invalid repo with an error toast and no config write", async () => {
    setConfig({ marketplaces: [] });
    h.normalizeRepo.mockReturnValue(null);
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:add", repo: "garbage" });
    expect(posts(p).some((m) => m.type === "toast" && m.level === "error")).toBe(true);
    expect(workspace.getConfiguration("agentFlow").get("marketplaces")).toEqual([]);
  });

  it("does not add a duplicate repo", async () => {
    setConfig({ marketplaces: ["o/r"] });
    show();
    await lastPanel()._fire({ type: "mkt:add", repo: "o/r" });
    expect(workspace.getConfiguration("agentFlow").get("marketplaces")).toEqual(["o/r"]);
  });

  it("removes a repo from config and re-posts", async () => {
    setConfig({ marketplaces: ["o/r", "a/b"] });
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:remove", repo: "o/r" });
    expect(workspace.getConfiguration("agentFlow").get("marketplaces")).toEqual(["a/b"]);
    expect(posts(p).some((m) => m.type === "mkt:state")).toBe(true);
  });

  it("copies text to the clipboard and toasts success", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:copy", text: "/plugin install x@y" });
    expect(env.clipboard.writeText).toHaveBeenCalledWith("/plugin install x@y");
    expect(posts(p).some((m) => m.type === "toast" && m.level === "success")).toBe(true);
  });

  it("opens an external url via the host", async () => {
    show();
    await lastPanel()._fire({ type: "openExternal", url: "https://github.com/o/r" });
    expect(env.openExternal).toHaveBeenCalled();
  });

  it("refresh re-fetches even when cached", async () => {
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    h.fetchMarketplace.mockClear();
    await p._fire({ type: "mkt:refresh" });
    expect(h.fetchMarketplace).toHaveBeenCalledWith("o/r");
  });

  it("renders a scoped error view without throwing", async () => {
    h.fetchMarketplace.mockResolvedValue(mkView({ error: { kind: "repo-not-found", message: "nope" } }));
    show();
    const p = lastPanel();
    await p._fire({ type: "mkt:ready" });
    const state = posts(p).reverse().find((m) => m.type === "mkt:state");
    expect(state.marketplaces[0].error.kind).toBe("repo-not-found");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/unit/marketplaceView.test.ts`
Expected: FAIL — `src/marketplaceView.ts` doesn't exist.

- [ ] **Step 3: Implement `MarketplacePanel`**

Create `src/marketplaceView.ts`:

```ts
import * as vscode from "vscode";
import { fetchMarketplace, normalizeRepo } from "./engine/marketplace";
import { InboundMessage, OutboundMessage, MarketplaceView } from "./types";

const CACHE_TTL_MS = 60 * 60 * 1000; // 1h — marketplace contents are effectively static

/** The Marketplace: a full-window board of registered plugin-marketplace repos and
 * their plugins/skills. Singleton editor-area panel; read-only (browse + copy). */
export class MarketplacePanel {
  private static current: MarketplacePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly cache = new Map<string, { at: number; view: MarketplaceView }>();

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
  }

  private post(msg: OutboundMessage): void {
    void this.panel.webview.postMessage(msg);
  }
  private toast(level: "success" | "error" | "info", message: string): void {
    this.post({ type: "toast", level, message });
  }

  private repos(): string[] {
    const v = vscode.workspace.getConfiguration("agentFlow").get<string[]>("marketplaces");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.length > 0) : [];
  }
  private async writeRepos(next: string[]): Promise<void> {
    await vscode.workspace.getConfiguration("agentFlow").update("marketplaces", next, vscode.ConfigurationTarget.Global);
  }

  private async view(repo: string, force: boolean): Promise<MarketplaceView> {
    const hit = this.cache.get(repo);
    if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.view;
    const view = await fetchMarketplace(repo);
    this.cache.set(repo, { at: Date.now(), view });
    return view;
  }

  private async render(force: boolean): Promise<void> {
    this.post({ type: "mkt:loading", loading: true });
    const repos = this.repos();
    const marketplaces: MarketplaceView[] = [];
    for (const repo of repos) {
      try {
        marketplaces.push(await this.view(repo, force));
      } catch (e) {
        this.log(`marketplace: unexpected failure for ${repo}: ${e}`);
        marketplaces.push({ repo, name: repo, description: "", owner: "", addCommand: `/plugin marketplace add ${repo}`, plugins: [], error: { kind: "unknown", message: "Couldn't load this marketplace." } });
      }
    }
    this.post({ type: "mkt:state", marketplaces });
    this.post({ type: "mkt:loading", loading: false });
  }

  private async onMessage(m: InboundMessage): Promise<void> {
    switch (m.type) {
      case "mkt:ready":
        await this.render(false);
        break;
      case "mkt:refresh":
        this.cache.clear();
        await this.render(true);
        break;
      case "mkt:add": {
        const repo = normalizeRepo(m.repo);
        if (!repo) {
          this.toast("error", `"${m.repo}" isn't a GitHub repo (use owner/repo or a github.com URL).`);
          return;
        }
        const current = this.repos();
        if (!current.includes(repo)) await this.writeRepos([...current, repo]);
        await this.render(false);
        break;
      }
      case "mkt:remove":
        await this.writeRepos(this.repos().filter((r) => r !== m.repo));
        this.cache.delete(m.repo);
        await this.render(false);
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

  private dispose(): void {
    MarketplacePanel.current = undefined;
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "marketplace.js"));
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let s = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/unit/marketplaceView.test.ts`
Expected: PASS (all `MarketplacePanel` cases).

- [ ] **Step 5: Type-check**

Run: `npm run check-types`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/marketplaceView.ts test/unit/marketplaceView.test.ts
git commit -m "feat(marketplace): MarketplacePanel host webview with add/remove/copy"
```

---

## Task 6: The webview UI — `MarketplaceApp` + styles + entry

**Files:**
- Create: `src/webview/MarketplaceApp.tsx`
- Create: `src/webview/marketplaceStyles.ts`
- Create: `src/webview/marketplace.tsx`
- Test: `test/webview/MarketplaceApp.test.tsx`

**Interfaces:**
- Consumes: `send` from `./vscodeApi`; `OutboundMessage`, `MarketplaceView`, `PluginView` from `../types`.
- Produces: `export function MarketplaceApp(): JSX.Element`. On mount posts `{ type: "mkt:ready" }`. Renders: a manage bar (add input + Add button + Refresh), a "How it works" explainer, one card per `MarketplaceView` (with remove `×` and repo link), and per-plugin skill/agent/command chip rows + a copy block. Empty state when no marketplaces.

- [ ] **Step 1: Write the failing tests**

Create `test/webview/MarketplaceApp.test.tsx` (modeled on `test/webview/DeckApp.test.tsx`):

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";

vi.mock("../../src/webview/vscodeApi", () => ({ send: vi.fn() }));

import { MarketplaceApp } from "../../src/webview/MarketplaceApp";
import { send } from "../../src/webview/vscodeApi";
import type { OutboundMessage, MarketplaceView } from "../../src/types";

const sent = vi.mocked(send);
function host(msg: OutboundMessage) {
  act(() => { window.dispatchEvent(new MessageEvent("message", { data: msg })); });
}
const mkView = (over: Partial<MarketplaceView> = {}): MarketplaceView => ({
  repo: "o/r", name: "atbay-plugins", description: "At-Bay plugins", owner: "At-Bay",
  addCommand: "/plugin marketplace add o/r",
  plugins: [{
    name: "cicd-plugin", description: "CI/CD automation", source: "plugins/cicd-plugin",
    skills: [{ name: "build", path: "plugins/cicd-plugin/skills/build/SKILL.md" }],
    agents: [{ name: "pipeline-agent", path: "plugins/cicd-plugin/agents/pipeline-agent.md" }],
    commands: [{ name: "deploy", path: "plugins/cicd-plugin/commands/deploy.md" }],
    installCommand: "/plugin install cicd-plugin@atbay-plugins",
  }],
  ...over,
});
const stateMsg = (marketplaces: MarketplaceView[]): OutboundMessage => ({ type: "mkt:state", marketplaces });

beforeEach(() => sent.mockClear());

describe("MarketplaceApp", () => {
  it("announces readiness on mount", () => {
    render(<MarketplaceApp />);
    expect(sent).toHaveBeenCalledWith({ type: "mkt:ready" });
  });

  it("shows the empty state with no marketplaces", () => {
    render(<MarketplaceApp />);
    host(stateMsg([]));
    expect(screen.getByText(/No marketplaces yet/i)).toBeInTheDocument();
  });

  it("renders a marketplace card with its plugin and item chips", () => {
    render(<MarketplaceApp />);
    host(stateMsg([mkView()]));
    expect(screen.getByText("atbay-plugins")).toBeInTheDocument();
    expect(screen.getByText("cicd-plugin")).toBeInTheDocument();
    expect(screen.getByText("build")).toBeInTheDocument();
    expect(screen.getByText("pipeline-agent")).toBeInTheDocument();
    expect(screen.getByText("deploy")).toBeInTheDocument();
  });

  it("sends mkt:add when a repo is typed and Add is clicked", () => {
    render(<MarketplaceApp />);
    fireEvent.change(screen.getByPlaceholderText(/owner\/repo/i), { target: { value: "new/repo" } });
    fireEvent.click(screen.getByRole("button", { name: /add/i }));
    expect(sent).toHaveBeenCalledWith({ type: "mkt:add", repo: "new/repo" });
  });

  it("sends mkt:remove when the card's × is clicked", () => {
    render(<MarketplaceApp />);
    host(stateMsg([mkView()]));
    fireEvent.click(screen.getByTitle(/remove/i));
    expect(sent).toHaveBeenCalledWith({ type: "mkt:remove", repo: "o/r" });
  });

  it("sends mkt:copy with the install snippet when Copy is clicked", () => {
    render(<MarketplaceApp />);
    host(stateMsg([mkView()]));
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(sent).toHaveBeenCalledWith({
      type: "mkt:copy",
      text: "/plugin marketplace add o/r\n/plugin install cicd-plugin@atbay-plugins",
    });
  });

  it("sends mkt:refresh when Refresh is clicked", () => {
    render(<MarketplaceApp />);
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(sent).toHaveBeenCalledWith({ type: "mkt:refresh" });
  });

  it("renders a scoped error message on a card", () => {
    render(<MarketplaceApp />);
    host(stateMsg([mkView({ plugins: [], error: { kind: "repo-not-found", message: "Repo not found, or you don't have access." } })]));
    expect(screen.getByText(/Repo not found/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/webview/MarketplaceApp.test.tsx`
Expected: FAIL — `src/webview/MarketplaceApp.tsx` doesn't exist.

- [ ] **Step 3: Implement `MarketplaceApp.tsx`**

Create `src/webview/MarketplaceApp.tsx`:

```tsx
import * as React from "react";
import { send } from "./vscodeApi";
import { OutboundMessage, MarketplaceView, PluginView, SkillRef } from "../types";

let toastSeq = 0;

function ChipRow({ label, icon, items }: { label: string; icon: string; items: SkillRef[] }): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <div className="chiprow">
      <span className="chiprow-l">{icon} {label}</span>
      <span className="chips">
        {items.map((it) => <span key={it.path} className="chip" title={it.path}>{it.name}</span>)}
      </span>
    </div>
  );
}

function Plugin({ p, addCommand }: { p: PluginView; addCommand: string }): JSX.Element {
  const snippet = `${addCommand}\n${p.installCommand}`;
  return (
    <div className="plugin">
      <div className="plugin-hd">
        <span className="plugin-nm">{p.name}</span>
      </div>
      {p.description && <div className="plugin-desc">{p.description}</div>}
      <ChipRow label="Skills" icon="🧩" items={p.skills} />
      <ChipRow label="Agents" icon="🤖" items={p.agents} />
      <ChipRow label="Commands" icon="⌘" items={p.commands} />
      <div className="snippet">
        <pre>{snippet}</pre>
        <button className="copy" onClick={() => send({ type: "mkt:copy", text: snippet })}>📋 Copy</button>
      </div>
    </div>
  );
}

function Market({ m }: { m: MarketplaceView }): JSX.Element {
  return (
    <section className="mkt">
      <div className="mkt-hd">
        <span className="mkt-nm">{m.name}</span>
        <a className="mkt-repo" href={`https://github.com/${m.repo}`}>{m.repo}</a>
        {!m.error && <span className="mkt-ct">{m.plugins.length} plugin{m.plugins.length === 1 ? "" : "s"}</span>}
        <span className="sp" />
        <span className="mkt-x" title={`Remove ${m.repo}`} onClick={() => send({ type: "mkt:remove", repo: m.repo })}>×</span>
      </div>
      {m.description && !m.error && <div className="mkt-desc">{m.description}</div>}
      {m.error ? (
        <div className="mkt-err">{m.error.message}</div>
      ) : m.plugins.length === 0 ? (
        <div className="mkt-err">No plugins listed in this marketplace.</div>
      ) : (
        <div className="plugins">{m.plugins.map((p) => <Plugin key={p.name} p={p} addCommand={m.addCommand} />)}</div>
      )}
    </section>
  );
}

export function MarketplaceApp(): JSX.Element {
  const [markets, setMarkets] = React.useState<MarketplaceView[]>([]);
  const [ready, setReady] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [input, setInput] = React.useState("");
  const [toasts, setToasts] = React.useState<{ id: number; level: string; message: string }[]>([]);

  React.useEffect(() => {
    const handler = (ev: MessageEvent<OutboundMessage>) => {
      const m = ev.data;
      if (m.type === "mkt:state") { setMarkets(m.marketplaces); setReady(true); }
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

  const add = () => {
    const v = input.trim();
    if (!v) return;
    send({ type: "mkt:add", repo: v });
    setInput("");
  };

  return (
    <>
      <div className="hd">
        <div className="title">Marketplace<span className="sub">Claude Code plugins & skills</span></div>
        <span className="sp" />
        <div className="add">
          <input
            value={input}
            spellCheck={false}
            placeholder="owner/repo or github.com URL…"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
          <button className="btn" onClick={add}>+ Add</button>
        </div>
        <button className="btn ghost" onClick={() => send({ type: "mkt:refresh" })}>⟳ Refresh</button>
      </div>

      <details className="how">
        <summary>How it works</summary>
        <div className="how-body">
          A marketplace is a GitHub repo of Claude Code plugins. Add one above, then install its
          plugins from Claude Code:
          <pre>/plugin marketplace add owner/repo{"\n"}/plugin install &lt;plugin&gt;@&lt;marketplace&gt;</pre>
        </div>
      </details>

      {loading && <div className="loading">Loading…</div>}

      {ready && markets.length === 0 ? (
        <div className="empty">
          <div className="big">No marketplaces yet</div>
          <div>Add a GitHub plugin-marketplace repo above to browse its plugins and skills.</div>
        </div>
      ) : (
        <div className="list">{markets.map((m) => <Market key={m.repo} m={m} />)}</div>
      )}

      <div className="toasts">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.level}`}>{t.message}</div>)}
      </div>
    </>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/webview/MarketplaceApp.test.tsx`
Expected: PASS. Note: the "sends mkt:copy" test expects the snippet `"/plugin marketplace add o/r\n/plugin install cicd-plugin@atbay-plugins"` — the `Plugin` component builds exactly that. The "×" element uses `title="Remove o/r"` so `getByTitle(/remove/i)` matches.

- [ ] **Step 5: Create the styles file `src/webview/marketplaceStyles.ts`**

This file is coverage-excluded (Task 7) and not unit-tested. Create `src/webview/marketplaceStyles.ts`:

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
  #root { min-height: 100vh; display: flex; flex-direction: column; }

  :root {
    --hair: var(--vscode-panel-border);
    --mono: var(--vscode-editor-font-family, ui-monospace, monospace);
    --accent: var(--vscode-charts-blue, #4aa3df);
  }

  .hd { flex: none; display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    padding: 14px 20px; border-bottom: 1px solid var(--hair); }
  .hd .title { font-size: 15px; font-weight: 600; }
  .hd .title .sub { color: var(--vscode-descriptionForeground); font-weight: 400; margin-left: 6px; font-size: 12px; }
  .hd .sp, .sp { flex: 1; }

  .add { display: inline-flex; align-items: center; gap: 6px; }
  .add input { min-width: 260px; padding: 5px 8px; border-radius: 6px;
    border: 1px solid var(--hair); background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  .btn { cursor: pointer; font-size: 12px; padding: 5px 12px; border-radius: 6px;
    border: 1px solid var(--hair); background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn:hover { background: var(--vscode-button-hoverBackground); }
  .btn.ghost { background: transparent; color: var(--vscode-foreground); }
  .btn.ghost:hover { background: var(--vscode-toolbar-hoverBackground); }

  .how { margin: 12px 20px 0; }
  .how summary { cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 12px; }
  .how-body { margin-top: 8px; font-size: 12px; color: var(--vscode-descriptionForeground); }
  .how-body pre, .snippet pre { font-family: var(--mono); font-size: 12px;
    background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.1)); padding: 8px 10px; border-radius: 6px; overflow-x: auto; margin: 6px 0 0; }

  .loading { padding: 10px 20px; color: var(--vscode-descriptionForeground); }
  .list { padding: 14px 20px 40px; display: flex; flex-direction: column; gap: 16px; }
  .empty { padding: 60px 20px; text-align: center; color: var(--vscode-descriptionForeground); }
  .empty .big { font-size: 16px; font-weight: 600; color: var(--vscode-foreground); margin-bottom: 6px; }

  .mkt { border: 1px solid var(--hair); border-radius: 10px; overflow: hidden; }
  .mkt-hd { display: flex; align-items: center; gap: 10px; padding: 10px 14px;
    background: var(--vscode-editorWidget-background, transparent); border-bottom: 1px solid var(--hair); }
  .mkt-nm { font-weight: 650; }
  .mkt-repo { font-size: 12px; color: var(--vscode-textLink-foreground); text-decoration: none; }
  .mkt-repo:hover { text-decoration: underline; }
  .mkt-ct { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .mkt-x { cursor: pointer; font-size: 16px; line-height: 1; color: var(--vscode-descriptionForeground); padding: 0 4px; }
  .mkt-x:hover { color: var(--vscode-errorForeground); }
  .mkt-desc { padding: 8px 14px 0; font-size: 12px; color: var(--vscode-descriptionForeground); }
  .mkt-err { padding: 12px 14px; font-size: 12px; color: var(--vscode-errorForeground); }

  .plugins { padding: 12px 14px; display: flex; flex-direction: column; gap: 12px; }
  .plugin { border: 1px solid var(--hair); border-radius: 8px; padding: 10px 12px; }
  .plugin-nm { font-weight: 600; }
  .plugin-desc { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 4px 0 8px; }
  .chiprow { display: flex; align-items: baseline; gap: 8px; margin: 4px 0; }
  .chiprow-l { font-size: 11px; color: var(--vscode-descriptionForeground); min-width: 78px; }
  .chips { display: flex; flex-wrap: wrap; gap: 5px; }
  .chip { font-size: 11px; padding: 2px 8px; border-radius: 10px;
    border: 1px solid var(--hair); background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .snippet { position: relative; margin-top: 8px; }
  .snippet .copy { position: absolute; top: 6px; right: 6px; cursor: pointer; font-size: 11px;
    padding: 3px 8px; border-radius: 6px; border: 1px solid var(--hair); background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-foreground); }

  .toasts { position: fixed; bottom: 16px; right: 16px; display: flex; flex-direction: column; gap: 8px; }
  .toast { padding: 8px 14px; border-radius: 6px; font-size: 12px; border: 1px solid var(--hair);
    background: var(--vscode-editorWidget-background); }
  .toast.success { border-color: var(--vscode-charts-green, #4ac26b); }
  .toast.error { border-color: var(--vscode-errorForeground); }
`;
```

- [ ] **Step 6: Create the webview entry `src/webview/marketplace.tsx`**

Mirror `src/webview/deck.tsx` exactly, swapping the app + CSS:

```tsx
import * as React from "react";
import { createRoot } from "react-dom/client";
import { MarketplaceApp } from "./MarketplaceApp";
import { MARKETPLACE_CSS } from "./marketplaceStyles";
import { send } from "./vscodeApi";

const style = document.createElement("style");
style.textContent = MARKETPLACE_CSS;
document.head.appendChild(style);

// Same defense-in-depth as the other webviews: any external link click goes to the
// host to open in the real browser, never navigating the panel iframe away.
document.addEventListener(
  "click",
  (e) => {
    const anchor = (e.target as HTMLElement | null)?.closest?.("a") as HTMLAnchorElement | null;
    if (anchor && /^https?:/i.test(anchor.getAttribute("href") || "")) {
      e.preventDefault();
      send({ type: "openExternal", url: anchor.href });
    }
  },
  true,
);

const root = createRoot(document.getElementById("root")!);
root.render(<MarketplaceApp />);
```

- [ ] **Step 7: Type-check and run the UI tests**

Run: `npm run check-types && npm test -- test/webview/MarketplaceApp.test.tsx`
Expected: no type errors; UI tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/webview/MarketplaceApp.tsx src/webview/marketplaceStyles.ts src/webview/marketplace.tsx test/webview/MarketplaceApp.test.tsx
git commit -m "feat(marketplace): webview UI (MarketplaceApp), styles, entry"
```

---

## Task 7: Wire it up — command, menu, config schema, build, coverage

**Files:**
- Modify: `package.json` (`contributes.commands`, `contributes.menus["view/title"]`, `contributes.configuration.properties`)
- Modify: `esbuild.js` (4th bundle)
- Modify: `src/extension.ts` (register command)
- Modify: `vitest.config.ts` (coverage exclude)
- Test: `test/unit/extension.test.ts`

**Interfaces:**
- Consumes: `MarketplacePanel.show` from `./marketplaceView`.
- Produces: command `agentFlow.openMarketplace`; `dist/marketplace.js` build output.

- [ ] **Step 1: Add the command to `package.json`**

In `contributes.commands`, add (keep array style consistent with siblings):

```json
      {
        "command": "agentFlow.openMarketplace",
        "title": "Agent Flow: Open the Marketplace",
        "icon": "$(extensions)"
      }
```

- [ ] **Step 2: Re-order the `view/title` menu in `package.json`**

Replace the `contributes.menus["view/title"]` array with (Marketplace · Deck · Refresh):

```json
    "view/title": [
      {
        "command": "agentFlow.openMarketplace",
        "when": "view == agentFlow.tasks",
        "group": "navigation@1"
      },
      {
        "command": "agentFlow.openDeck",
        "when": "view == agentFlow.tasks",
        "group": "navigation@2"
      },
      {
        "command": "agentFlow.refresh",
        "when": "view == agentFlow.tasks",
        "group": "navigation@3"
      }
    ]
```

- [ ] **Step 3: Add the config property to `package.json`**

In `contributes.configuration.properties`, add:

```json
    "agentFlow.marketplaces": {
      "type": "array",
      "items": { "type": "string" },
      "default": [],
      "scope": "application",
      "markdownDescription": "GitHub repos that are Claude Code plugin marketplaces. Accepts `owner/repo` or a full github.com URL. Managed from the Marketplace panel (the puzzle-piece button beside the Deck)."
    }
```

- [ ] **Step 4: Add the 4th esbuild bundle in `esbuild.js`**

After the `deckConfig` definition, add:

```js
// The Marketplace panel is a third, independent browser bundle.
const marketplaceConfig = {
  ...webviewConfig,
  entryPoints: ["src/webview/marketplace.tsx"],
  outfile: "dist/marketplace.js",
};
```

Then include it in BOTH the watch and build arrays in `main()`:

```js
  if (watch) {
    const ctxs = await Promise.all([extensionConfig, webviewConfig, deckConfig, marketplaceConfig].map((c) => esbuild.context(c)));
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log("[esbuild] watching…");
  } else {
    await Promise.all([extensionConfig, webviewConfig, deckConfig, marketplaceConfig].map((c) => esbuild.build(c)));
    console.log("[esbuild] build complete");
  }
```

- [ ] **Step 5: Register the command in `src/extension.ts`**

Add the import near the top (after the `DeckPanel` import):

```ts
import { MarketplacePanel } from "./marketplaceView";
```

Add the command registration inside `context.subscriptions.push(...)`, right after the `openDeck` registration:

```ts
    vscode.commands.registerCommand("agentFlow.openMarketplace", () => MarketplacePanel.show(context, log)),
```

- [ ] **Step 6: Add the coverage excludes in `vitest.config.ts`**

In `test.coverage.exclude`, add these two entries alongside `deck.tsx`/`deckStyles.ts`:

```ts
        "src/webview/marketplaceStyles.ts",
        "src/webview/marketplace.tsx",
```

- [ ] **Step 7: Extend the extension test**

In `test/unit/extension.test.ts`, mock the new module near the other `vi.mock` calls:

```ts
vi.mock("../../src/marketplaceView", () => ({
  MarketplacePanel: { show: vi.fn() },
}));
```

Then add an assertion in the test that checks registered commands (the file already grabs commands via the `cmd(id)` helper). Add:

```ts
  it("registers the openMarketplace command", () => {
    activate(fakeContext().context as any);
    expect(cmd("agentFlow.openMarketplace")).toBeTypeOf("function");
  });
```

If the existing tests call `activate` in a `beforeEach`, follow that structure instead of calling `activate` inline — match the file's existing pattern (check how `agentFlow.openDeck` is asserted, if at all, and mirror it).

- [ ] **Step 8: Run the extension test**

Run: `npm test -- test/unit/extension.test.ts`
Expected: PASS.

- [ ] **Step 9: Full build + type-check + whole test suite (coverage gate)**

Run: `npm run check-types && npm run build && npm test`
Expected: build emits `dist/marketplace.js`; all tests PASS; coverage stays at/above thresholds (90/85/85/90). If coverage dipped below on a new file, add the missing-branch test (most likely an untested `onMessage` branch or `discover` edge) before proceeding.

- [ ] **Step 10: Commit**

```bash
git add package.json esbuild.js src/extension.ts vitest.config.ts test/unit/extension.test.ts
git commit -m "feat(marketplace): wire command, menu button, config, build bundle"
```

---

## Task 8: Docs, manual smoke test, release build

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `package.json` (version)

- [ ] **Step 1: Manual smoke test in the Extension Development Host**

Run: `npm run build`, then press F5 (or "Run Extension") in VS Code. In the dev host:
1. Open the Agent Flow Tasks sidebar; confirm a puzzle-piece (`$(extensions)`) button sits to the LEFT of the Deck (dashboard) button.
2. Click it → the "Agent Flow — Marketplace" panel opens.
3. Add `anthropics/claude-plugins` (a public marketplace) → confirm plugins render with command chips; click Copy → paste elsewhere to confirm the snippet.
4. Add a private At-Bay marketplace (e.g. the org's `atbay-plugins` repo) → confirm it loads via `gh` auth.
5. Add `garbage` → confirm an error toast, no card.
6. Add a real repo that has no `.claude-plugin/marketplace.json` → confirm the "isn't a Claude Code marketplace" card.
7. Remove a repo with `×` → confirm it disappears and stays gone after reopening the panel.
Record any issue and fix before releasing. (This step has no automated assertion — it verifies the pieces that unit tests mock out: real `gh`, real clipboard, the actual toolbar button.)

- [ ] **Step 2: Update `README.md`**

Add a short section after "The Deck" describing the Marketplace: what it is (browse registered GitHub plugin-marketplace repos and their plugins/skills), how to open it (the puzzle-piece button beside the Deck), how to add a repo, that it reads via your `gh` login (so private repos work), and that it's read-only — it shows the `/plugin` commands to copy, it doesn't install. Keep the tone/length consistent with the existing Deck section.

- [ ] **Step 3: Update `CHANGELOG.md`**

Add a new entry at the top for the new version (see Step 4 for the number), e.g.:

```markdown
## 0.1.20

- **The Marketplace** — a new panel (puzzle-piece button beside the Deck) to register GitHub
  Claude Code plugin-marketplace repos and browse their plugins, skills, agents, and commands,
  with copy-able `/plugin` install commands. Reads repos via your `gh` CLI login (public + private).
```

- [ ] **Step 4: Bump the version in `package.json`**

Change `"version": "0.1.19"` to `"version": "0.1.20"` (next patch). This follows the repo's release-on-merge convention.

- [ ] **Step 5: Build a fresh `.vsix` and remove the old one**

Run:
```bash
npm run build
npx vsce package
rm -f oznasi1-agent-flow-0.1.19.vsix
```
Expected: a new `oznasi1-agent-flow-0.1.20.vsix` exists; the old one is gone. (If the repo has a package script for this, use it instead — check `package.json` `scripts`.)

- [ ] **Step 6: Final verification**

Run: `npm run check-types && npm test`
Expected: type-check clean, all tests pass, coverage at/above thresholds.

- [ ] **Step 7: Commit**

```bash
git add README.md CHANGELOG.md package.json oznasi1-agent-flow-0.1.20.vsix
git commit -m "docs+release: document the Marketplace, release 0.1.20"
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** Every spec section maps to a task — entry point/button (T7), config/storage (T1, T5, T7), gh fetch + parse + errors (T2–T4), panel (T5), UI + install snippets + how-it-works (T6), message protocol/types (T1), caching/refresh (T5), docs/testing/release (T8). One deliberate refinement vs. the spec: skills are discovered as *any `SKILL.md` under the plugin dir (name = parent folder)* rather than convention-plus-a-plugin.json fetch — this covers custom skill paths (the `ui-ux-pro-max` shape) while keeping it to 2 `gh` calls. Recorded here so it's not mistaken for a gap.
- **Type consistency:** `MarketplaceView` / `PluginView` / `SkillRef` / `MarketplaceErrorKind` and the `mkt:*` message shapes are defined once in Task 1 and used verbatim in Tasks 4–6. `fetchMarketplace(repo)` (Task 4) is called with a single arg by the panel (Task 5, default runner). `normalizeRepo` returns `string | null` (Task 2) and the panel branches on `null` (Task 5). The copy snippet format (`addCommand \n installCommand`) matches between the UI (Task 6) and its test.
- **No placeholders:** every code step contains complete, runnable code; every test step has real assertions; commands include expected outcomes.
