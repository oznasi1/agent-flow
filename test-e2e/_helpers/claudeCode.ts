import { execFileSync } from "child_process";
import * as fs from "fs";
import * as https from "https";
import * as os from "os";
import * as path from "path";
import { resolveCliArgsFromVSCodeExecutablePath } from "@vscode/test-electron";
import type { Sandbox } from "./sandbox";

/** Pinned Claude Code build for the panel-seeding journey. Platform-specific
 *  vsix (the extension ships native binaries), so the cache key carries the
 *  target platform. Bump deliberately, never float — the seed's command
 *  contract (claude-vscode.primaryEditor.open) is exactly what this pin
 *  protects against silent upstream change. */
export const CLAUDE_CODE_VERSION = "2.1.238";

function targetPlatform(): string {
  const osName = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${osName}-${arch}`;
}

function download(url: string, dest: string, redirects = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "agent-flow-e2e" } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(download(res.headers.location, dest, redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`download ${url}: HTTP ${res.statusCode}`));
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on("finish", () => out.close(() => resolve()));
      out.on("error", reject);
    }).on("error", reject);
  });
}

/** Install the pinned Claude Code into the sandbox's extensions dir. The vsix
 *  and the installed form are cached under .vscode-test/ (keyed on version +
 *  platform), so the marketplace is hit once per machine, not per test. */
export async function installClaudeCode(vscodeExecutablePath: string, sb: Sandbox): Promise<void> {
  const platform = targetPlatform();
  const cacheRoot = path.resolve(".vscode-test");
  const cachedExtDir = path.join(cacheRoot, `claude-code-ext-${CLAUDE_CODE_VERSION}-${platform}`);

  if (!fs.existsSync(cachedExtDir)) {
    const vsix = path.join(cacheRoot, `claude-code-${CLAUDE_CODE_VERSION}-${platform}.vsix`);
    if (!fs.existsSync(vsix)) {
      const url =
        `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/Anthropic/vsextensions/claude-code/${CLAUDE_CODE_VERSION}/vspackage?targetPlatform=${platform}`;
      const tmp = `${vsix}.part`;
      await download(url, tmp);
      // The gallery serves the package gzip-wrapped regardless of headers; a
      // vsix is a zip, so gunzip when the magic bytes say so.
      const head = fs.readFileSync(tmp).subarray(0, 2);
      if (head[0] === 0x1f && head[1] === 0x8b) {
        const { gunzipSync } = await import("zlib");
        fs.writeFileSync(tmp, gunzipSync(fs.readFileSync(tmp)));
      }
      fs.renameSync(tmp, vsix);
    }
    // Install through VS Code's own CLI into a staging dir, then move into the
    // cache atomically enough for a single-worker suite. The CLI writes the
    // extensions.json metadata a bare unzip would not.
    const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "af-ccext-"));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE; // same trap as launchHost — the CLI manages it itself
    execFileSync(cli, [...cliArgs, `--extensions-dir=${staging}`, "--install-extension", vsix], { env, stdio: "pipe" });
    fs.renameSync(staging, cachedExtDir);
  }

  fs.cpSync(cachedExtDir, sb.extensionsDir, { recursive: true });
}
