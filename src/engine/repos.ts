import * as fs from "fs";
import * as path from "path";
import { ServiceRef } from "../types";

/**
 * List candidate service repos under reposRoot — the ground truth of what's
 * checked out locally (backend and frontend). Git repos are flagged.
 *
 * `blocklist` names directories under reposRoot that are never task-target repos
 * (infra, tooling, generated). Hidden dirs (leading ".") are always skipped.
 */
export function discoverRepos(reposRoot: string, blocklist: string[] = []): ServiceRef[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(reposRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const blocked = new Set(blocklist);
  const repos: ServiceRef[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".") || blocked.has(e.name)) continue;
    const p = path.join(reposRoot, e.name);
    repos.push({ name: e.name, path: p, isGit: fs.existsSync(path.join(p, ".git")) });
  }
  return repos.sort((a, b) => a.name.localeCompare(b.name));
}
