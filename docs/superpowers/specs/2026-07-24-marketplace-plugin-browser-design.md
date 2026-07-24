# The Marketplace — plugin/skill browser — design

**Date:** 2026-07-24
**Status:** Approved pending user review
**Area:** New feature — `src/marketplaceView.ts`, `src/engine/marketplace.ts`, `src/webview/marketplace.tsx`, `src/webview/MarketplaceApp.tsx`, `src/webview/marketplaceStyles.ts`; touches `src/extension.ts`, `src/types.ts`, `src/config.ts`, `package.json`, `esbuild.js`

## Problem

Agent Flow has no way to discover the Claude Code plugins and skills a team publishes.
A [Claude Code plugin marketplace](https://docs.claude.com/en/docs/claude-code/plugins) is a
GitHub repo carrying `.claude-plugin/marketplace.json` that lists plugins; each plugin bundles
skills, agents, and commands. Today a user has to know a repo exists, read its `marketplace.json`
by hand, and remember the `/plugin …` commands to install from it. There is no in-editor surface
that lets you register those repos and see what's inside them.

## Goals

- Let the user **register GitHub repos** that are plugin marketplaces, and add/remove them from
  within the extension.
- Present each marketplace's **plugins**, and under each plugin its **skills / agents / commands**,
  in a clear webview that matches the Deck's visual language.
- For each plugin, show the **exact Claude Code commands** to add the marketplace and install the
  plugin, with a copy button — the "short explanation of how to do it."
- Open it from a **button next to the Deck's open button** in the Tasks sidebar title bar.

## Non-goals (YAGNI)

- **No install action.** The panel is read-only; it never writes to `~/.claude` or runs
  `/plugin install`. It only shows and copies the commands. (Chosen over one-click install.)
- **No token config.** Repo reads go through the user's already-authenticated `gh` CLI, which
  covers public *and* private repos. No PAT to manage.
- No creating/editing marketplaces, no version pinning, no cross-plugin search/filter, no
  broader "settings webview." All deferrable.

## Decisions (from brainstorming)

1. **Read-only browse + copy install command** (not one-click install, not a generic bookmark list).
2. **`gh` CLI** for reading repo contents (not raw URLs, not a stored PAT) — reuses existing
   auth, works for private At-Bay repos.
3. **Manage the repo list inside the Marketplace panel** (not the VS Code Settings UI, not a
   separate settings webview) — self-contained Add/remove, list persisted to global config.
4. **Button left of the Deck button**, order in the title bar: **Marketplace · Deck · Refresh**.
5. **1h in-memory cache TTL**, manual refresh, no background polling (data is static).
6. Show **skills, agents, and commands** per plugin (not skills-only).

## Entry point

- New command `agentFlow.openMarketplace`, title *"Agent Flow: Open the Marketplace"*, icon
  `$(extensions)`.
- `package.json` `menus.view/title` (all `when: view == agentFlow.tasks`):
  `agentFlow.openMarketplace` → `navigation@1`, `agentFlow.openDeck` → `navigation@2`,
  `agentFlow.refresh` → `navigation@3`.
- Registered in `extension.ts`:
  `vscode.commands.registerCommand("agentFlow.openMarketplace", () => MarketplacePanel.show(context, log))`.
  No Jira `auth` dependency — the panel only talks to `gh`.

## Data model & storage

New config key (schema in `package.json` `contributes.configuration.properties`):

```jsonc
"agentFlow.marketplaces": {
  "type": "array",
  "items": { "type": "string" },
  "default": [],
  "scope": "application",
  "markdownDescription": "GitHub repos that are Claude Code plugin marketplaces. Accepts `owner/repo` or a full GitHub URL."
}
```

- Read into `AgentFlowConfig.marketplaces: string[]` in `config.ts` (filtered to non-empty strings).
- Add/remove writes through
  `vscode.workspace.getConfiguration("agentFlow").update("marketplaces", next, vscode.ConfigurationTarget.Global)`.
- **Normalization** (`normalizeRepo(input): {owner, repo} | null`): accepts `owner/repo`,
  `https://github.com/owner/repo(.git)`, `git@github.com:owner/repo.git`; strips trailing
  `.git`/slashes; returns `null` (→ inline validation error) for anything else. Stored form is
  the canonical `owner/repo`. Duplicates are ignored.

## Fetching & parsing — `src/engine/marketplace.ts` (the tested core)

Pure/host module. Per repo, **two `gh` calls** via `execFile` (never a shell string), each with a
timeout:

1. `gh api repos/{owner}/{repo}/git/trees/HEAD?recursive=1` → full file tree (`tree[].path`).
2. `gh api repos/{owner}/{repo}/contents/.claude-plugin/marketplace.json` → base64 `content`,
   decoded and `JSON.parse`d.

The module exposes a **pure** `buildMarketplaceView(marketplaceJson, treePaths): MarketplaceView`
that does all derivation with no I/O (so it is unit-testable from fixtures), plus a thin
`fetchMarketplace(repo): Promise<MarketplaceView | MarketplaceError>` wrapper that runs the two
`gh` calls and hands off to the pure builder.

Derivation rules:

- **Marketplace**: `name` (the install `@handle`), `description` ?? `metadata.description`,
  `owner.name`, and the resolved plugin root (`metadata.pluginRoot`, default repo root).
- **Plugins** from `plugins[]`: `name`, `description`, and the resolved `source` directory
  (join with `pluginRoot` when `source` is relative).
- **Skills / agents / commands** per plugin, derived from `treePaths` scoped to the plugin's
  `source` dir, by convention:
  - skill = a path matching `<source>/skills/<name>/SKILL.md` → skill name `<name>`.
  - agent = `<source>/agents/<name>.md` → `<name>`.
  - command = `<source>/commands/<name>.md` → `<name>`.
  - **Fallback:** if a `<source>/.claude-plugin/plugin.json` exists and declares `skills: [...]`
    custom paths, resolve those against the tree too (covers the `ui-ux-pro-max` shape:
    `"./.claude/skills/ui-ux-pro-max"`). Reading plugin.json is best-effort; failure just means
    convention-only discovery.

### Error mapping (each scoped to a card, never a dead panel)

`fetchMarketplace` classifies failures into a typed `MarketplaceError`:

- **gh-missing** — `gh` not on PATH → "GitHub CLI (`gh`) not found. Install it to browse marketplaces."
- **gh-unauthenticated** — `gh` exits with an auth error → "Run `gh auth login` to browse marketplaces."
- **repo-not-found** — 404 / no access → "Repo not found or you don't have access."
- **not-a-marketplace** — repo reached but no `.claude-plugin/marketplace.json` → "Not a Claude Code plugin marketplace."
- **parse-error** — malformed `marketplace.json` → "Couldn't read this marketplace's manifest."
- **unknown** — anything else, with the trimmed stderr in the log.

## The panel — `src/marketplaceView.ts`

Mirrors `DeckPanel`: a **singleton** `MarketplacePanel` with `static show(context, log)`, a
`WebviewPanel` (`enableScripts`, `retainContextWhenHidden`, `localResourceRoots`), nonce + CSP
HTML shell identical to the Deck's, and an `onDidReceiveMessage`/`onDidDispose` wiring.
Differences from the Deck: **no polling timer** (static data) and **no Jira client**. Holds an
in-memory `Map<repo, {at, view|error}>` cache with a 1h TTL.

Message handling (`mkt:` namespace):

- `mkt:ready` / `mkt:refresh` — build the full state (refresh bypasses the cache), post `mkt:state`.
- `mkt:add {repo}` — normalize; on success update global config, fetch just that repo, re-post state; on bad input post a `toast` error.
- `mkt:remove {repo}` — update global config, drop from cache, re-post state.
- `mkt:copy {text}` — `vscode.env.clipboard.writeText(text)` then a success `toast`.
- `openExternal {url}` — reuse existing `vscode.env.openExternal` handling.

## The UI — `src/webview/MarketplaceApp.tsx` + `marketplaceStyles.ts`

Its own esbuild bundle `dist/marketplace.js` (entry `src/webview/marketplace.tsx`, same shape as
`deck.tsx`: mount CSS, capture-phase external-link intercept, `createRoot`). Reuses VS Code theme
vars and the Deck's visual grammar. Top-down:

- **Manage bar** — `[ owner/repo… ] [+ Add]` with inline validation, and a global **Refresh**.
- **How it works** — small collapsible explainer: *"A marketplace is a GitHub repo of Claude Code
  plugins. Add one here, then install its plugins from Claude Code,"* with the two generic commands.
- **Marketplace card** (per repo) — header: marketplace `name`, repo link (opens in browser via the
  external-link intercept), plugin count, `×` remove. Body: plugin cards. A card in an error state
  renders its mapped message + a per-card retry.
- **Plugin card** — `name` + description; three labeled chip rows: **Skills** 🧩 / **Agents** 🤖 /
  **Commands** ⌘ (chip label = item name, `title` = relative path; a row with zero items is hidden).
  Then a copy block:
  ```
  /plugin marketplace add owner/repo
  /plugin install <plugin>@<marketplace-name>
  ```
  with a **📋 Copy** button (`mkt:copy`).
- **Empty state** (no marketplaces registered) — a friendly card explaining the concept with the
  Add input front and center.

## Message protocol & shared types — `src/types.ts`

New view types:

```ts
export interface SkillRef { name: string; path: string; }
export interface PluginView {
  name: string;
  description: string;
  source: string;                 // resolved dir within the repo
  skills: SkillRef[];
  agents: SkillRef[];
  commands: SkillRef[];
  installCommand: string;         // "/plugin install <name>@<marketplace>"
}
export type MarketplaceErrorKind =
  | "gh-missing" | "gh-unauthenticated" | "repo-not-found"
  | "not-a-marketplace" | "parse-error" | "unknown";
export interface MarketplaceView {
  repo: string;                   // canonical owner/repo
  name: string;                   // marketplace.json name (the @handle)
  description: string;
  owner: string;
  addCommand: string;             // "/plugin marketplace add owner/repo"
  plugins: PluginView[];
  error?: { kind: MarketplaceErrorKind; message: string };
}
```

Added to the message unions:

- **Inbound**: `mkt:ready`, `mkt:refresh`, `{ type: "mkt:add"; repo: string }`,
  `{ type: "mkt:remove"; repo: string }`, `{ type: "mkt:copy"; text: string }`.
- **Outbound**: `{ type: "mkt:state"; marketplaces: MarketplaceView[] }`,
  `{ type: "mkt:loading"; loading: boolean }`. Reuses existing `toast`.

## Caching, refresh, errors

- Cache keyed by canonical `owner/repo`; TTL 1h. `mkt:refresh` and re-adding a repo bypass it.
- Add/remove re-renders from cache and fetches only the changed repo.
- Every failure is scoped to its marketplace card; the rest of the panel always renders.

## Files

**New**
- `src/marketplaceView.ts` — the singleton panel.
- `src/engine/marketplace.ts` — `gh` calls + pure `buildMarketplaceView` + error mapping.
- `src/webview/marketplace.tsx` — webview entry.
- `src/webview/MarketplaceApp.tsx` — the React UI.
- `src/webview/marketplaceStyles.ts` — CSS.

**Changed**
- `package.json` — command, `view/title` menu (re-ordered), `agentFlow.marketplaces` config.
- `esbuild.js` — 4th bundle → `dist/marketplace.js`.
- `src/extension.ts` — register `agentFlow.openMarketplace`.
- `src/types.ts` — messages + view types above.
- `src/config.ts` — `marketplaces` in `AgentFlowConfig` + `getConfig()`.
- `README.md`, `CHANGELOG.md` — document the Marketplace; version bump per release-on-merge.

## Testing

Vitest against `src/engine/marketplace.ts`:

- **Fixtures** captured from real repos: `atbay-plugins` (many plugins, `pluginRoot`),
  `claude-plugins-official` (`commit-commands` = commands-only, no skills), and a
  `plugin.json`-declared custom skills path (`ui-ux-pro-max` shape).
- Assert `buildMarketplaceView` derives the right plugins and skill/agent/command lists
  (including the empty-row and custom-path cases) and the correct `addCommand`/`installCommand`.
- Assert each `MarketplaceError` mapping from mocked `gh` outcomes (missing binary, auth failure,
  404, missing manifest, malformed JSON).
- `gh` invocation is mocked; no network. Webview/UI is not unit-tested (matches the repo's
  existing approach for `deckView`/webviews).
