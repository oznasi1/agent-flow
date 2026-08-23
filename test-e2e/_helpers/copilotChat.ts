import { execFileSync } from "child_process";
import * as fs from "fs";
import * as https from "https";
import * as os from "os";
import * as path from "path";
import { resolveCliArgsFromVSCodeExecutablePath } from "@vscode/test-electron";
import type { Sandbox } from "./sandbox";

/** Pinned GitHub Copilot Chat build for the panel-seeding journey. The gallery's
 *  own package.json declares `engines.vscode: "^1.96.0-20241122"` for this exact
 *  version — verified by inspecting the downloaded vsix, not inferred from the
 *  marketplace listing — which is VS Code's own caret semantics (same MINOR
 *  release only, not "any newer minor"), so this is the newest published build
 *  still installable against the pinned host's 1.96.2. The very next release,
 *  0.24.1, jumps to `^1.97.0` and refuses to install on 1.96.x. Bump deliberately,
 *  never float — a floated version would silently start failing to install the
 *  moment VS_CODE_VERSION and the gallery's newest build diverge by a minor. */
export const COPILOT_CHAT_VERSION = "0.24.2024121201";

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

/** Install the pinned Copilot Chat into the sandbox's extensions dir. The vsix
 *  and the installed form are cached under .vscode-test/ (keyed on version +
 *  platform), so the marketplace is hit once per machine, not per test. */
export async function installCopilotChat(vscodeExecutablePath: string, sb: Sandbox): Promise<void> {
  const platform = targetPlatform();
  const cacheRoot = path.resolve(".vscode-test");
  const cachedExtDir = path.join(cacheRoot, `copilot-chat-ext-${COPILOT_CHAT_VERSION}-${platform}`);

  if (!fs.existsSync(cachedExtDir)) {
    const vsix = path.join(cacheRoot, `copilot-chat-${COPILOT_CHAT_VERSION}-${platform}.vsix`);
    if (!fs.existsSync(vsix)) {
      // Unlike Claude Code, Copilot Chat ships one platform-neutral vsix — the
      // gallery 404s on this version if `?targetPlatform=` is appended (verified
      // by hand against the live endpoint), so the query param is omitted here.
      // The cache dir is still keyed by platform for parity with claudeCode.ts's
      // cache layout, even though the downloaded artifact itself is identical.
      const url =
        `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/GitHub/vsextensions/copilot-chat/${COPILOT_CHAT_VERSION}/vspackage`;
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
