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
