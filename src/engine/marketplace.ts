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
  const SLUG = /^[A-Za-z0-9._-]+$/;
  const strip = (owner: string, repo: string): string | null => {
    const o = owner.trim();
    const r = repo.trim().replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
    return o && r && SLUG.test(o) && SLUG.test(r) ? `${o}/${r}` : null;
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

  // Agent / command: "<source>/agents/<name>.md" and "<source>/commands/<name>.md"
  // (one segment directly under the dir — a regex avoids off-by-one length math).
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const direct = (dir: string): SkillRef[] => {
    const re = new RegExp(`^${escapedPrefix}${dir}/[^/]+\\.md$`);
    return under
      .filter((p) => re.test(p))
      .map((p) => ({ name: p.split("/").pop()!.replace(/\.md$/, ""), path: p }))
      .sort(byName);
  };

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

  const pluginRoot = cleanPath(typeof m?.metadata?.pluginRoot === "string" ? m.metadata.pluginRoot : "");
  const plugins: PluginView[] = Array.isArray(m?.plugins)
    ? m.plugins
        .filter((p: any) => p && typeof p.name === "string")
        .map((p: any): PluginView => {
          const source =
            typeof p.source === "string"
              ? cleanPath(p.source)
              : cleanPath([pluginRoot, p.name].filter(Boolean).join("/"));
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
