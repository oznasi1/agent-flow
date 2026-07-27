import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Where a package manager parks a CLI, searched after PATH. The extension host
 * inherits launchd's bare `/usr/bin:/bin:/usr/sbin:/sbin` whenever the editor
 * gives up resolving the user's shell environment — Cursor and VS Code both
 * abandon that after 10s ("Unable to resolve your shell environment in a
 * reasonable time") — and under that PATH a lookup finds /usr/bin/git but never
 * a Homebrew `gh`, however signed in the user is. */
const fallbackDirs = (home: string): string[] => [
  "/opt/homebrew/bin", // Homebrew on Apple silicon
  "/usr/local/bin", // Homebrew on Intel, and hand-installed binaries
  "/opt/local/bin", // MacPorts
  "/home/linuxbrew/.linuxbrew/bin",
  path.join(home, ".local", "bin"),
  path.join(home, "bin"),
];

/** The environment a lookup reads, injected so tests never touch the real
 * filesystem. */
export interface BinLookup {
  path: string | undefined;
  home: string;
  isExecutable: (file: string) => boolean;
}

/** The real environment: this process's PATH, this user's home, and an
 * executable-file test on disk. */
export const systemLookup = (): BinLookup => ({
  path: process.env.PATH,
  home: os.homedir(),
  isExecutable: (file) => {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  },
});

/** Absolute path to `name`, or null when we cannot find it. PATH wins; the
 * fallback dirs only answer when PATH cannot. Deliberately uncached — a
 * `brew install gh` mid-session should start working on the next probe. */
export function resolveBin(name: string, look: BinLookup = systemLookup()): string | null {
  // An empty PATH entry means the cwd to a shell; path.join("", name) is the
  // relative `name`, never something to hand to execFile as a located binary.
  const fromPath = (look.path ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of [...fromPath, ...fallbackDirs(look.home)]) {
    const file = path.join(dir, name);
    if (look.isExecutable(file)) return file;
  }
  return null;
}
