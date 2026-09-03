import { _electron, type ElectronApplication, type FrameLocator, type Page } from "@playwright/test";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { Sandbox } from "./sandbox";

/** Pinned host build ≥ the manifest's engines floor (^1.90.0). Cached under
 *  .vscode-test/ after the first download. Bump deliberately, never float. */
export const VSCODE_VERSION = "1.96.2";

/** A copy of the pinned install whose product.json says `urlProtocol: "cursor"` —
 *  which is exactly what `vscode.env.uriScheme` reports, and all `isCursorHost()`
 *  (src/config.ts) reads. The REAL Cursor app is unautomatable here (its CDP target
 *  never reaches the workbench — see cursor-provider.e2e.ts), but the host gate
 *  doesn't need Cursor, only Cursor's uri scheme, and stock VS Code takes the patch:
 *  ad-hoc re-signed on macOS (a modified bundle won't launch under arm64's signature
 *  requirement otherwise; linux has no such check). Prepared once beside the stock
 *  install and reused — a marker file says the copy is complete, because a killed
 *  first run would otherwise leave a half-copied app that boots flakily. */
export async function cursorHostExecutable(): Promise<string> {
  const stockExe = await downloadAndUnzipVSCode(VSCODE_VERSION);
  const testDir = path.dirname(stockExe).split(`${path.sep}.vscode-test${path.sep}`)[0] + `${path.sep}.vscode-test`;
  const stockRoot = path.join(testDir, `vscode-${process.platform === "darwin" ? `darwin-${process.arch}` : `linux-${process.arch === "arm64" ? "arm64" : "x64"}`}-${VSCODE_VERSION}`);
  const patchedRoot = path.join(testDir, `cursor-host-${VSCODE_VERSION}`);
  const marker = path.join(patchedRoot, "is-cursor-patched");
  const patchedExe = stockExe.replace(stockRoot, patchedRoot);

  if (!fs.existsSync(marker)) {
    fs.rmSync(patchedRoot, { recursive: true, force: true });
    // `cp -Rc` on macOS APFS-clones the 400MB bundle (instant, no extra space) and
    // preserves the framework symlinks a plain file walk can mangle; -R alone does
    // the same preserving on linux.
    execFileSync("cp", [process.platform === "darwin" ? "-Rc" : "-R", stockRoot, patchedRoot]);
    const productJson =
      process.platform === "darwin"
        ? path.join(path.dirname(patchedExe), "..", "Resources", "app", "product.json")
        : path.join(path.dirname(patchedExe), "resources", "app", "product.json");
    const product = JSON.parse(fs.readFileSync(productJson, "utf8"));
    if (product.urlProtocol !== "vscode") throw new Error(`expected stock urlProtocol "vscode", got ${product.urlProtocol}`);
    product.urlProtocol = "cursor";
    fs.writeFileSync(productJson, JSON.stringify(product, null, "\t"));
    if (process.platform === "darwin") {
      const appBundle = patchedExe.split(`${path.sep}Contents${path.sep}`)[0];
      execFileSync("codesign", ["--force", "--deep", "-s", "-", appBundle], { stdio: "ignore" });
    }
    fs.writeFileSync(marker, "");
  }
  return patchedExe;
}

/** `folder`: open the window ON this folder instead of empty. Opt-in and additive —
 *  every journey that omits it boots the same empty window it always did. A window
 *  with one folder has an identity (`windowIdentity`, src/engine/presence.ts:56), which
 *  is what lets the destination picker offer "This window" (engine/openTarget.ts); an
 *  empty window is deliberately unnameable and never gets that row. */
export async function launchHost(
  sb: Sandbox,
  opts: { host?: "vscode" | "cursor"; folder?: string } = {},
): Promise<{ app: ElectronApplication; page: Page }> {
  const executablePath = opts.host === "cursor" ? await cursorHostExecutable() : await downloadAndUnzipVSCode(VSCODE_VERSION);
  const app = await _electron.launch({
    executablePath,
    args: [
      `--extensionDevelopmentPath=${path.resolve(__dirname, "..", "..")}`,
      `--user-data-dir=${sb.userDataDir}`,
      `--extensions-dir=${sb.extensionsDir}`,
      "--disable-telemetry",
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--disable-updates",
      "--no-sandbox",
      "--disable-gpu",
      "--new-window",
      // Without this, the macOS extension host re-resolves PATH from the user's
      // login shell, silently dropping the sandbox's `open` shim — and
      // openInEditor's `open -a "Visual Studio Code"` then launches the REAL
      // installed editor in a separate process Playwright cannot see.
      "--force-disable-user-env",
      // With HOME pointed at the sandbox, macOS finds no login keychain and
      // throws a system-modal "Keychain Not Found" dialog at the developer on
      // every launch. --password-store=basic is not enough on macOS — safe
      // storage still initializes against the Keychain — so use VS Code's own
      // test seam and keep secrets in memory for the session.
      "--password-store=basic",
      "--use-inmemory-secretstorage",
      // Positional, after every flag: the folder the window opens on (see `opts.folder`).
      ...(opts.folder ? [opts.folder] : []),
    ],
    env: (() => {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
      // When this test itself runs inside an editor's extension host (Claude
      // Code, a VS Code task), ELECTRON_RUN_AS_NODE=1 is exported — and a child
      // Electron inheriting it boots as plain Node, rejecting every VS Code
      // flag with "bad option". Playwright strips it from its DEFAULT env, but
      // passing an explicit env reintroduces it unless we strip it ourselves.
      delete env.ELECTRON_RUN_AS_NODE;
      env.HOME = sb.home; // ~/.agentflow → sandbox
      env.AGENT_FLOW_FIXTURE_DIR = sb.fixtureDir; // the registry gate
      env.PATH = `${path.join(sb.root, "bin")}:${env.PATH ?? ""}`; // `open` shim first
      return env;
    })(),
  });
  const page = await app.firstWindow();
  // The workbench is alive when the activity bar exists.
  await page.locator(".activitybar").waitFor({ timeout: 60_000 });
  return { app, page };
}

/** Open the extension's sidebar. The activity-bar item carries the view
 *  container's title as its aria-label. */
export async function openTasksView(page: Page): Promise<void> {
  // `.first()`: the workbench nests an `<a aria-label>` inside an `<li aria-label>`
  // for the same item, so the bare attribute selector matches both.
  await page.locator('.activitybar [aria-label*="Agent Flow"]').first().click();
}

/** The tasks webview's DOM. VS Code nests webviews two iframes deep: an outer
 *  `iframe.webview` wrapper and the inner `#active-frame` that holds our React
 *  app. If the locator matches nothing, dump `page.content()` and adjust the
 *  outer selector — this nesting is workbench-internal and can shift between
 *  pinned versions (that is why it lives in exactly one helper). */
export function tasksFrame(page: Page): FrameLocator {
  return page.frameLocator("iframe.webview").last().frameLocator("#active-frame");
}
