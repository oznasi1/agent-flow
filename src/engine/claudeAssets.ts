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
  category: string;
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
    category: attr.category,
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
        // Several hooks routinely share an event and matcher and differ only by
        // their `if` guard — prefer it, or they render as indistinguishable rows.
        const guard = typeof h.if === "string" && h.if ? h.if : matcher;
        out.push({
          type: "hook",
          name: event,
          description: String(h.command ?? h.type ?? ""),
          plugin: attr.plugin,
          marketplace: attr.marketplace,
          category: attr.category,
          file,
          rel: guard ? `${rel} (${guard})` : rel,
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

/** Join a manifest-declared relative path onto a root, resolving "." and ".."
 * lexically and refusing anything that climbs out. A marketplace.json comes from
 * a third-party repo, so `source` (and `metadata.pluginRoot`, folded into `rel`
 * by the caller) is attacker-controlled — and everything the scan discovers
 * becomes readable through the panel's preview. Returns null both when the path
 * climbs above the root and when it resolves to the root itself: no caller here
 * has ever relied on "the whole marketplace clone is this plugin's content",
 * and treating it as valid would attribute every sibling plugin's files to it. */
function containedJoin(root: string, rel: string): string | null {
  const out: string[] = [];
  for (const seg of rel.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (!out.length) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.length ? `${root}/${out.join("/")}` : null;
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
  const dir = rel ? containedJoin(installLocation, rel) : null;
  if (dir && reader.isDir(dir)) return { dir, state: "clone" };
  return { dir: "", state: "manifest" };
}

const EMPTY_COUNTS = (): Record<AssetType, number> => ({ skill: 0, command: 0, agent: 0, hook: 0 });

function countsOf(assets: AssetView[]): Record<AssetType, number> {
  const c = EMPTY_COUNTS();
  for (const a of assets) c[a.type]++;
  return c;
}

/** The manifest's category, normalised. Lower-cased so "Deployment" and
 * "deployment" are one section; absent becomes an explicit bucket rather than an
 * empty string, because "we don't know" is a thing the UI has to name. */
function categoryOf(plugin: { category?: unknown }): string {
  const raw = typeof plugin.category === "string" ? plugin.category.trim() : "";
  return raw ? raw.toLowerCase() : "uncategorized";
}

/** The plugin's own README, if it shipped one. Matched case-insensitively —
 * both README.md and readme.md occur in the wild. */
function readmeIn(reader: AssetReader, dir: string): string {
  if (!dir) return "";
  const hit = reader.readDir(dir).find((e) => !e.isDir && e.name.toLowerCase() === "readme.md");
  return hit ? `${dir}/${hit.name}` : "";
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
      const category = categoryOf(p);
      const mine = dir ? discoverAssets(reader, dir, { plugin: p.name, marketplace: name, category, state, enabled }) : [];
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
        category,
        readme: readmeIn(reader, dir),
        installCommand: `/plugin install ${ref}`,
      });
    }
  }

  // ── assets you wrote yourself, plus settings-level hooks ──────────────────
  const own = (dir: string, plugin: string, marketplace: string, settings: SettingsLayer): void => {
    const attr: Attribution = { plugin, marketplace, category: "yours", state: "user", enabled: true };
    // SKIP_DIRS_OWN, not the plugin default: this walk starts at ~/.claude (or a
    // workspace .claude), whose siblings include the plugin cache, hundreds of MB
    // of transcripts, and git worktrees — none of which hold user-authored assets.
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
        category: "yours",
        readme: "",
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
