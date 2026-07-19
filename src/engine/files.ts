import { execSync } from "child_process";
import { WorkspaceMode } from "../types";

const MAX_FILES_PER_REPO = 6;

const FILE_RE =
  /\b[\w./-]*\.(?:ts|tsx|js|jsx|py|go|java|rb|rs|yaml|yml|json|sql|md|sh|css|scss|html|vue|php|cs|kt|swift)\b/gi;

/** Pull file-ish tokens out of a ticket description (paths, filenames, backtick spans). */
export function extractFileHints(text: string): string[] {
  if (!text) return [];
  const hints = new Set<string>();
  for (const m of text.matchAll(/`([^`]+)`/g)) hints.add(m[1].trim());
  for (const m of text.matchAll(FILE_RE)) hints.add(m[0]);
  return [...hints]
    .map((h) => h.replace(/^[`'"()<>]+|[`'"()<>]+$/g, "").trim())
    .filter((h) => h.length > 2 && h.length < 120 && /\.[a-z0-9]{1,5}$/i.test(h.split("/").pop() || ""));
}

/** Match hints against a candidate file list (repo-relative paths). Path-like hints
 * match by suffix; bare filenames match by basename. Deduped and capped. */
export function matchFiles(hints: string[], candidates: string[], cap = MAX_FILES_PER_REPO): string[] {
  const out = new Set<string>();
  for (const h of hints) {
    const hl = h.toLowerCase();
    const base = (h.split("/").pop() || "").toLowerCase();
    for (const f of candidates) {
      const fl = f.toLowerCase();
      const isMatch = h.includes("/") ? fl.endsWith(hl) : (fl.split("/").pop() || "") === base;
      if (isMatch) out.add(f);
      if (out.size >= cap) return [...out];
    }
  }
  return [...out];
}

/** Find tracked files in a repo whose path/basename matches any hint. */
export function resolveFilesInRepo(repoPath: string, hints: string[]): string[] {
  if (hints.length === 0) return [];
  let files: string[];
  try {
    files = execSync("git ls-files", { cwd: repoPath, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
  return matchFiles(hints, files);
}

export function mention(mode: WorkspaceMode, repoName: string, rel: string): string {
  // In a multi-root workspace, asRelativePath includes the folder name.
  return mode === "multiroot" ? `@${repoName}/${rel}` : `@${rel}`;
}
