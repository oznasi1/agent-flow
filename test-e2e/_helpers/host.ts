import { _electron, type ElectronApplication, type FrameLocator, type Page } from "@playwright/test";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import * as path from "path";
import type { Sandbox } from "./sandbox";

/** Pinned host build ≥ the manifest's engines floor (^1.90.0). Cached under
 *  .vscode-test/ after the first download. Bump deliberately, never float. */
export const VSCODE_VERSION = "1.96.2";

export async function launchHost(sb: Sandbox): Promise<{ app: ElectronApplication; page: Page }> {
  const executablePath = await downloadAndUnzipVSCode(VSCODE_VERSION);
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
