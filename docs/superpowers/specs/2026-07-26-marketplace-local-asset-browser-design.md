# The Marketplace — local skill/command/agent browser — design

**Date:** 2026-07-26
**Status:** Approved pending user review
**Area:** Rewrites `src/webview/MarketplaceApp.tsx`, `src/webview/marketplaceStyles.ts`, the data layer of
`src/marketplaceView.ts`; adds `src/engine/claudeAssets.ts`; deletes `src/engine/marketplace.ts`; touches
`src/types.ts`, `src/config.ts`, `package.json`, `README.md`, `CHANGELOG.md`

## Problem

The Marketplace panel shipped in 0.1.21 renders nothing. It lists only GitHub repos the user has
registered under the `agentFlow.marketplaces` setting, and that key defaults to `[]` — so on a fresh
install the panel shows "No marketplaces yet" and stays that way until the user hand-registers a repo
and has an authenticated `gh` on PATH.

Meanwhile the machine already holds everything worth showing. Claude Code keeps its plugin state under
`~/.claude/`, and on a representative developer machine that means **5 marketplaces, 301 catalogued
plugins, and 338 discoverable assets** — 223 skills, 41 commands, 46 agents, 28 hooks — all sitting on
disk, none of it visible in the editor. The user's ask: *"I don't see anything over there. I want a nice
UI to show the commands and skills available."*

Prior art is [Claude Code Manager](https://marketplace.visualstudio.com/items?itemName=vishalguptax.claude-manager),
which reads `~/.claude/` and renders skills, slash commands, agents, hooks, and MCP servers locally with
no network access.

## Goals

- The panel is **never empty** on a machine that has used Claude Code. No setup, no config, no auth.
- **Search across every asset** — the primary interaction, because 338 items is far past what card
  scrolling handles.
- Show each asset's **real description**, parsed from its `SKILL.md` / `.md` frontmatter, plus which
  plugin and marketplace it came from.
- Show **true enabled/disabled state**, including project-scope overrides and `skillOverrides`.
- **Open the source file** in an editor tab, and **copy** the thing you'd type to use it.

## Non-goals (YAGNI)

- **No mutation of `~/.claude`.** No install, uninstall, enable, or disable. Read-only.
- **No network.** No `gh`, no GitHub API, no PAT. Everything is read off local disk.
- **No usage or sessions view.** Deferred to its own spec — the only source is ~331 MB of transcript
  JSONL across 618 files in `~/.claude/projects`, with no pre-aggregated totals. It needs its own design
  for incremental scanning, caching, and a token-pricing table, and it is a different feature from an
  asset browser.
- **No MCP server view.** Deferred; not requested.
- No `fs.watch`, no background polling, no version pinning.

## Decisions

1. **Local-first.** Local disk is the only source of truth (chosen over keeping the remote model, and
   over a unified local+remote panel).
2. **Read-only**, with two actions per item: open the source file, and copy the invocation.
3. **Drop the `gh` path entirely** — delete `src/engine/marketplace.ts`, the `agentFlow.marketplaces`
   config key, and 4 of the 6 `MarketplaceErrorKind` variants. This removes every auth failure mode and
   makes an empty-by-default panel structurally impossible.
4. **Asset-first search layout** ("Palette") over a plugin tree or a card gallery, because the asset
   count demands search and it is the least code — one list renderer, no tree state.
5. **A "Plugins" filter pill** reusing the same list and detail panes, so the 217 plugins that aren't
   downloaded stay discoverable.
6. Surface **skills, commands, agents, and hooks**.
7. **Include the open workspace's `.claude/`** and its project-scope settings, not just `~/.claude`.
8. **Scan on open**, no persistent cache. Measured at **0.22 s** for the full tree.

## Data sources

All reads are local. Every one is best-effort: a missing or malformed file degrades that one entry and
never blanks the panel.

| Path | Provides |
| --- | --- |
| `~/.claude/plugins/known_marketplaces.json` | Marketplace list: key, `installLocation`, and origin (`github` repo or `directory` path) |
| `<installLocation>/.claude-plugin/marketplace.json` | Plugin catalog: `name`, `description`, `source`, and `metadata.pluginRoot` |
| `~/.claude/plugins/installed_plugins.json` | Installed refs → `scope`, `version`, `installPath` |
| `~/.claude/settings.json` | `enabledPlugins`, `skillOverrides`, global `hooks` |
| `<workspace>/.claude/settings.json`, `settings.local.json` | Project-scope `enabledPlugins` and `hooks` |
| `~/.claude/{skills,commands,agents}` | Assets the user wrote themselves |
| `<workspace>/.claude/{skills,commands,agents}` | Project-local assets |

`~/.claude` is resolved from `os.homedir()`, overridable by the `CLAUDE_CONFIG_DIR` environment
variable if set. The workspace root is `vscode.workspace.workspaceFolders?.[0]`; with no folder open,
the workspace-scoped sources are simply skipped.

### Content-dir resolution

A plugin's assets are read from the first of these that exists:

1. **Installed** — the `installPath` recorded in `installed_plugins.json`. When several entries exist
   for one ref (multiple scopes or versions), prefer the first whose `installPath` is an existing
   directory. State: `installed`.
2. **In the marketplace clone** — `<installLocation>/<source>`, but only when `source` is a **string**
   (a repo-relative path) and the directory exists. When a plugin omits `source`, fall back to
   `<installLocation>/<metadata.pluginRoot>/<name>`. State: `clone`.
3. **Neither** — the plugin is catalogued but its content isn't on disk. State: `manifest`. Name and
   description come from the manifest; it has no assets.

State 3 is the common case, not an edge case: in `claude-plugins-official`, **220 of 273** plugins carry
an *object* `source` (`{"source":"github","repo":"…"}`) pointing at an external repo, so nothing is on
disk until the plugin is installed. Only 53 carry a string path inside the clone. Measured across all
5 marketplaces: **19 installed, 65 in-clone, 217 manifest-only**.

### Enabled state

`enabledPlugins` maps `"<plugin>@<marketplace>"` → boolean. Project settings override user settings for
the same ref; `settings.local.json` overrides `settings.json`. A ref absent from every file has
**unknown** enabled state, rendered as no badge (distinct from an explicit `false`, which renders as
`disabled`). `skillOverrides` is keyed by **skill name**, not by plugin ref; a skill whose name maps to
`"off"` renders `disabled` even when its plugin is enabled.

## Discovery rules

These are the exact rules validated against the real tree; they are what produced 223 / 41 / 46 / 28.

- **skill** — any `**/SKILL.md` beneath the plugin's content dir. Name from frontmatter `name`, falling
  back to the containing folder's name. Walk skips `.git`, `node_modules`, `tests`, `test`.
- **command** — `commands/**/*.md`. Nested directories namespace with a colon, so
  `commands/db/migrate.md` is `db:migrate`, matching how Claude Code names it.
- **agent** — `agents/**/*.md`, same naming rule.
- **hook** — `hooks/hooks.json`, flattened to one row per `{event, matcher, command}`. Accepts both the
  `{"hooks":{Event:[…]}}` and bare `{Event:[…]}` shapes. Hooks declared in `~/.claude/settings.json`
  and in the workspace settings files are flattened the same way and surface as hook assets attributed
  to `(user)` / `(workspace)` rather than to a plugin — otherwise the data-source table would promise
  settings-level hooks that never appear in the list.
- **frontmatter** — a leading `---` fenced block, flat `key: value` scalars only, with continuation
  lines folded into the preceding value. Folding is required: many real skill descriptions wrap across
  several lines. Surrounding quotes are stripped. A file with no frontmatter yields no description,
  which is a normal state, not an error.

Walk depth is capped (8 levels) as a runaway guard, and symlinks are not followed.

## The UI — layout "Palette"

Header, then search, then two pill rows, then a split body. Existing VS Code theme variables and the
Deck's visual grammar carry over unchanged.

- **Header** — "Marketplace" + subtitle, a **Rescan** button, and a **How to add a marketplace**
  affordance that copies `/plugin marketplace add owner/repo` (a copy hint now, not an input, since the
  extension no longer fetches anything itself).
- **Search** — autofocused, matches case-insensitively against name, description, plugin, and
  marketplace. Matches are highlighted in the results.
- **Type pills** — `All · Skills · Commands · Agents · Hooks · Plugins`, each with a live count.
  Selecting `Plugins` swaps the list from asset rows to plugin rows, including manifest-only ones,
  reusing the same renderer and detail pane.
- **Scope pills** — `Everywhere · Installed only · Enabled only`.
- **Results** — grouped under type headers when unfiltered, flat when a type is selected. A row is:
  type glyph, name (commands shown as `/name` in mono), `plugin · marketplace` in muted text, a
  one-line clamped description, and a `disabled` tag where applicable. `↑`/`↓` move the selection and
  `Enter` opens the file.
- **Detail pane** — type glyph and name, state tags (`installed` / `on disk` / `not downloaded` /
  `yours`, plus `enabled` / `disabled` / version / scope), the full description, a definition list of
  plugin / marketplace / file path, and actions:
  - **Open file** (primary; also the `Enter` action)
  - **Reveal in Finder**
  - **Copy** — `/name` for a command, the bare name for a skill or agent, the hook's command for a
    hook, and `/plugin install <plugin>@<marketplace>` for a plugin row.

Type colours are one restrained categorical set — skill / command / agent / hook — each used as a glyph
tint and a section-label colour, drawn from `--vscode-charts-*` so both themes stay legible.

### Empty and degraded states

- **No `~/.claude/plugins`** — "Claude Code isn't set up on this machine yet," with a line explaining
  that adding a marketplace in Claude Code populates this panel.
- **A marketplace whose `installLocation` is missing** — the marketplace is tagged `stale` and
  contributes no plugins; every other marketplace still renders.
- **Malformed JSON in any source file** — that file is skipped and logged; the panel renders what it
  could read.
- **A search with no matches** — "Nothing matches …" with a prompt to shorten the query or clear filters.

## Code structure

### New — `src/engine/claudeAssets.ts`

The tested core. Pure over an injected reader so unit tests run against fixture trees with no real
filesystem:

```ts
export interface AssetReader {
  readFile(path: string): string | null;      // null when missing/unreadable
  readDir(path: string): DirEntry[];          // [] when missing
  isDir(path: string): boolean;
}
export interface DirEntry { name: string; isDir: boolean; }
```

Exports: `scanClaudeAssets(reader, opts): ClaudeAssetsView` plus the individually testable
`parseFrontmatter`, `discoverAssets`, `resolveContentDir`, and `resolveEnabled`. The host supplies a
`fs`-backed reader; nothing in this module imports `vscode`.

### Rewritten

- `src/webview/MarketplaceApp.tsx` — the Palette UI.
- `src/webview/marketplaceStyles.ts` — styles for it.
- `src/marketplaceView.ts` — keeps its panel shell, CSP/nonce HTML, singleton and disposal wiring.
  Its data layer becomes a `scanClaudeAssets` call; the 1 h cache map is deleted. Gains handlers for
  `mkt:open` (open a file in an editor tab) and `mkt:reveal` (reveal in OS file manager).

### Deleted

- `src/engine/marketplace.ts` and `test/unit/engine/marketplace.test.ts`.
- The `agentFlow.marketplaces` config key in `package.json` and its `marketplaces` field in
  `src/config.ts`.
- `MarketplaceErrorKind` and `MarketplaceView.error` in their entirety. Nothing in the new design
  consumes them: a broken marketplace is expressed by `MarketplaceSourceView.stale`, and unreadable
  files are skipped and logged rather than surfaced as a typed error. Keeping two unused variants
  would be dead code.
- `test/webview/MarketplaceApp.test.tsx` is rewritten alongside the component.

## Message protocol and types — `src/types.ts`

Replaces `MarketplaceView` / `PluginView` / `SkillRef`:

```ts
export type AssetType = "skill" | "command" | "agent" | "hook";
/** "user" = yours, not from a plugin — covers both ~/.claude and the workspace. */
export type PluginState = "installed" | "clone" | "manifest" | "user";

export interface AssetView {
  type: AssetType;
  name: string;
  description: string;
  plugin: string;            // "(user)" for ~/.claude, "(workspace)" for the open folder
  marketplace: string;       // "~/.claude" or the workspace folder name, for those two
  file: string;              // absolute, for open/reveal
  rel: string;               // shown in the detail pane
  enabled: boolean | null;   // null = not declared anywhere
  state: PluginState;
}

export interface PluginRowView {
  name: string;
  marketplace: string;
  description: string;
  state: PluginState;
  enabled: boolean | null;
  scopes: string[];
  version: string;
  counts: Record<AssetType, number>;
  installCommand: string;    // "/plugin install <plugin>@<marketplace>"
}

export interface MarketplaceSourceView {
  name: string;
  kind: "github" | "directory" | "user";
  origin: string;
  pluginCount: number;
  stale: boolean;
}

export interface ClaudeAssetsView {
  marketplaces: MarketplaceSourceView[];
  plugins: PluginRowView[];
  assets: AssetView[];
  notSetUp: boolean;         // no ~/.claude/plugins at all
  scannedAt: number;
}
```

Inbound messages: `mkt:ready`, `mkt:refresh`, `{ type: "mkt:copy"; text: string }`,
`{ type: "mkt:open"; file: string }`, `{ type: "mkt:reveal"; file: string }`.
Outbound: `{ type: "mkt:state"; view: ClaudeAssetsView }`, `{ type: "mkt:loading"; loading: boolean }`,
and the existing `toast`.

`mkt:open` and `mkt:reveal` accept only paths that the preceding scan actually emitted; a path not in
that set is rejected and logged, so the webview can't ask the host to open arbitrary files.

## Freshness

Scan on `mkt:ready`, on the **Rescan** button, and on `onDidChangeViewState` when the panel becomes
visible and the last scan is more than 30 s old. No `fs.watch`, no persistent cache — the full scan of
301 plugins measured 0.22 s, so caching would add invalidation bugs and buy nothing.

## Testing

Vitest against `src/engine/claudeAssets.ts`, driven by an in-memory `AssetReader` over fixture trees:

- **Content-dir resolution** — installed (prefers `installPath`); string `source` in the clone; object
  `source` → `manifest` with zero assets; missing `source` → `pluginRoot`/`name` fallback; several
  install entries where the first `installPath` is absent from disk.
- **Discovery** — nested `SKILL.md`; frontmatter `name` overriding the folder name; no frontmatter at
  all; `commands/db/migrate.md` → `db:migrate`; both `hooks.json` shapes; `.git`/`node_modules`/`tests`
  exclusion; depth cap.
- **Frontmatter** — folded multi-line descriptions, quoted values, `---` inside the body not being
  treated as a fence.
- **Enabled state** — user vs project vs `settings.local.json` precedence; ref absent everywhere → `null`;
  `skillOverrides: off` marking one skill disabled inside an enabled plugin.
- **Degraded input** — missing `known_marketplaces.json` → `notSetUp`; a marketplace whose
  `installLocation` is gone → `stale` and other marketplaces unaffected; malformed JSON skipped.
- **User-level assets** — `~/.claude/skills|commands|agents` surfacing under `(user)` and the workspace
  equivalents under `(workspace)`, both with state `user`.
- **Settings-level hooks** — hooks declared in `~/.claude/settings.json` and in the workspace settings
  files appearing as hook assets attributed to `(user)` / `(workspace)`, with `settings.local.json`
  taking precedence.

Webview components are not unit-tested beyond a render smoke test, matching the repo's existing practice
for `deckView` and the Deck webview.

## Files

**New**
- `src/engine/claudeAssets.ts`
- `test/unit/engine/claudeAssets.test.ts`

**Changed**
- `src/marketplaceView.ts` — data layer, `mkt:open` / `mkt:reveal`, path allow-listing, no cache.
- `src/webview/MarketplaceApp.tsx`, `src/webview/marketplaceStyles.ts` — the Palette UI.
- `test/webview/MarketplaceApp.test.tsx` — rewritten smoke test.
- `src/types.ts` — the types above.
- `src/config.ts`, `package.json` — remove `agentFlow.marketplaces`.
- `README.md`, `CHANGELOG.md` — document the panel; version bump per release-on-merge.
- `.gitignore` — ignore `docs/mockups/`, which embeds real local plugin inventories and must not reach
  this public repo.

**Deleted**
- `src/engine/marketplace.ts`, `test/unit/engine/marketplace.test.ts`

## Risks

- **Convention drift.** Discovery is convention-based; if Claude Code changes its on-disk layout, assets
  silently stop appearing. Mitigated by degrading per-plugin rather than globally, and by the
  `notSetUp` state naming the expected path.
- **Large marketplaces.** A future marketplace with far more in-clone plugins than today's 65 would slow
  the walk. The depth cap and directory-skip list bound it; if it ever matters, the scan moves off the
  extension host's critical path behind the existing `mkt:loading` message, which the UI already honours.
- **Path handling.** `mkt:open` is an arbitrary-file-open primitive if unguarded; the allow-list of
  scan-emitted paths is the control.
