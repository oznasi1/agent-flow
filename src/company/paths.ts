import * as fs from "fs";
import * as path from "path";

/** Absolute locations of every piece of private company state. */
export interface CompanyPaths {
  repoRoot: string;
  root: string;
  queue: string;
  archive: string;
  landed: string;
  cycles: string;
  drafts: string;
  decisions: string;
  paused: string;
  charter: string;
  backlog: string;
  metrics: string;
}

export function companyPaths(repoRoot: string): CompanyPaths {
  const root = path.join(repoRoot, ".claude", "company");
  return {
    repoRoot,
    root,
    queue: path.join(root, "queue"),
    archive: path.join(root, "archive"),
    landed: path.join(root, "landed"),
    cycles: path.join(root, "cycles"),
    drafts: path.join(root, "drafts"),
    decisions: path.join(root, "decisions.jsonl"),
    paused: path.join(root, "PAUSED"),
    charter: path.join(root, "CHARTER.md"),
    backlog: path.join(root, "backlog.md"),
    metrics: path.join(root, "metrics.md"),
  };
}

/** Creates the directories. Files are created lazily by whoever writes them. */
export function ensureCompanyDirs(p: CompanyPaths): void {
  for (const dir of [p.root, p.queue, p.archive, p.landed, p.cycles, p.drafts]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
