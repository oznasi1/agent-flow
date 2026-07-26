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
