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
  // Every `app.close()` on a per-test host goes through `closeHost`: on Linux,
  // Electron's quit can stall after every window and extension host has already
  // gone (see `closeHost`), and a bare close then hangs the file's hook. Patched
  // here, once, rather than in forty files' afterEach — the raw close is kept
  // so the helper cannot recurse into itself.
  const rawClose = app.close.bind(app);
  (app as { close: () => Promise<void> }).close = () => closeHost(app, sb, rawClose);
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

/** How long `closeHost` waits for a graceful `app.close()` before it gives up
 *  on the Electron process. Well under every file's own hook timeout, so a hung
 *  close is settled HERE, with evidence, rather than as a bare
 *  `"afterEach" hook timeout` two minutes later. */
export const CLOSE_DEADLINE_MS = 30_000;

/** Close a per-test host, and when Electron does not quit, decide honestly
 *  whose fault that is before killing it.
 *
 *  Seen in CI's shard 4 (Linux) on `take-task` and `take-prompts`, with the
 *  test body already green: `electronApplication.close()` hangs after a test
 *  opened a second window and closed the app soon after it appeared. The
 *  sandbox's own logs say what happened — `main.log` records every extension
 *  host, the new window's included, exiting with code 0 within a second, and
 *  `ps` then shows only the Electron main process, its zygotes and one
 *  `<defunct>` child: a renderer torn down mid-initialisation and reaped as a
 *  zombie that Chromium's shutdown keeps waiting on. On macOS the same
 *  sequence quits in under a second. That is Electron's, not this extension's.
 *
 *  So on a hang this reads the logs and asks one question: did every
 *  extension host that started also exit? If yes, the product finished its
 *  shutdown and only Electron stalled — the pid is killed, the evidence goes
 *  to the job log as a warning, and the close resolves. If any host is still
 *  alive, something of ours may be holding the quit, and the close FAILS with
 *  the same evidence. A clean close prints nothing. `close` is the raw
 *  Playwright close, handed in by `launchHost` because it patches `app.close`
 *  to be this function. */
export async function closeHost(
  app: ElectronApplication | undefined,
  sb: Pick<Sandbox, "userDataDir"> | undefined,
  close: () => Promise<void>,
): Promise<void> {
  if (!app) return;
  // Read the pid BEFORE closing: once the app is gone, `process()` throws.
  let pid: number | undefined;
  try {
    pid = app.process().pid;
  } catch {
    pid = undefined;
  }
  let closed = false;
  await Promise.race([
    close().then(() => { closed = true; }, () => { closed = true; }),
    new Promise<void>((resolve) => setTimeout(resolve, CLOSE_DEADLINE_MS)),
  ]);
  if (closed) return;
  const lines: string[] = [`closeHost: app.close() did not return within ${CLOSE_DEADLINE_MS}ms (pid ${pid ?? "?"})`];
  try {
    for (const w of app.windows()) {
      const dialogs = await w.locator(".monaco-dialog-box").count().catch(() => -1);
      const notes = await w.locator(".notification-list-item-message").allTextContents().catch(() => []);
      lines.push(`  window ${w.url().slice(0, 80)}: dialogs=${dialogs} notifications=${JSON.stringify(notes)}`);
    }
  } catch (e) {
    lines.push(`  windows: unreadable — ${String(e)}`);
  }
  const hosts = sb ? extensionHostsExited(sb.userDataDir) : undefined;
  if (sb) lines.push(...hostLogTails(sb.userDataDir));
  try {
    lines.push(...execFileSync("ps", ["-o", "pid,ppid,etime,command", "-ax"], { encoding: "utf8" }).split("\n")
      .filter((l) => /code|electron|claude|cat$/i.test(l)).slice(0, 15).map((l) => `  ps ${l.slice(0, 150)}`));
  } catch {
    /* no ps — Windows, or a locked-down runner */
  }
  if (pid !== undefined) await killTree(pid);
  if (hosts && hosts.started.length > 0 && hosts.alive.length === 0) {
    lines.push(`  every extension host exited (${hosts.started.join(", ")}) — Electron's quit stalled on its own; killed pid ${pid ?? "?"} and carried on`);
    console.warn(lines.join("\n"));
    return;
  }
  lines.push(hosts
    ? `  extension hosts still alive: ${hosts.alive.join(", ") || "(none started)"} — the product may be holding the quit`
    : "  no sandbox logs to classify the hang by");
  const report = lines.join("\n");
  console.log(report);
  throw new Error(report);
}

/** SIGKILL a process and every descendant it still has, children first, then
 *  wait briefly for them to be gone. Killing the main process alone reparents
 *  its zygotes and renderers to init, where they linger and keep writing into
 *  the sandbox `dispose` is about to remove. Descendants are read off one `ps`
 *  pass; a platform without `ps` (Windows) falls back to the main pid alone. */
export async function killTree(pid: number): Promise<void> {
  const victims = [pid];
  try {
    const rows = execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" })
      .split("\n").map((l) => l.trim().split(/\s+/).map(Number)).filter((r) => r.length === 2 && !Number.isNaN(r[0]));
    const queue = [pid];
    while (queue.length > 0) {
      const parent = queue.shift()!;
      for (const [child, ppid] of rows) {
        if (ppid === parent && !victims.includes(child)) {
          victims.push(child);
          queue.push(child);
        }
      }
    }
  } catch {
    /* no ps — kill the main pid alone */
  }
  for (const v of [...victims].reverse()) {
    try {
      process.kill(v, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  // Wait for them to be gone — ASYNCHRONOUSLY. `kill(pid, 0)` keeps succeeding
  // on a zombie, and a killed child of THIS process stays a zombie until the
  // event loop turns and Node reaps it; a synchronous spin here would wait the
  // whole deadline on a corpse. Yielding lets the reap happen. ESRCH (or EPERM,
  // a reused pid) means gone.
  const gone = (v: number) => { try { process.kill(v, 0); return false; } catch { return true; } };
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !victims.every(gone)) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Which extension hosts the sandbox's VS Code started, and which of them
 *  never logged an exit. Read whole, not tailed: `exthost.log` says
 *  "Extension host with pid N started" per window and `main.log` says
 *  "Extension host with pid N exited" once each is gone — the difference is
 *  the list of hosts still up. `undefined` when there are no logs at all. */
export function extensionHostsExited(userDataDir: string): { started: number[]; alive: number[] } | undefined {
  const files = vscodeLogFiles(userDataDir);
  if (files.length === 0) return undefined;
  const started = new Set<number>();
  const exited = new Set<number>();
  for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    if (path.basename(f) === "exthost.log") {
      for (const m of text.matchAll(/Extension host with pid (\d+) started/g)) started.add(Number(m[1]));
    } else if (path.basename(f) === "main.log") {
      for (const m of text.matchAll(/Extension host with pid (\d+) exited/g)) exited.add(Number(m[1]));
    }
  }
  const startedList = [...started].sort((a, b) => a - b);
  return { started: startedList, alive: startedList.filter((p) => !exited.has(p)) };
}

/** Every VS Code log that can say why a quit stalled, under
 *  `<userDataDir>/logs/<timestamp>/…`: `main.log` (lifecycle, window and
 *  extension-host exits), each window's `exthost.log`, the shared and pty
 *  hosts', and every output channel file named for this extension. */
function vscodeLogFiles(userDataDir: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/^(main|exthost|sharedprocess|ptyhost)\.log$/.test(e.name) || /Agent Flow Deck\.log$/.test(e.name)) files.push(p);
    }
  };
  walk(path.join(userDataDir, "logs"), 0);
  return files.sort();
}

/** The last lines of each of those logs, for the job log. A missing directory
 *  reads as one line saying so, never as a throw — this runs while a failure
 *  is being reported. */
export function hostLogTails(userDataDir: string, tail = 40): string[] {
  const files = vscodeLogFiles(userDataDir);
  if (files.length === 0) return [`  no VS Code logs under ${path.join(userDataDir, "logs")}`];
  const out: string[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const last = text.split("\n").filter((l) => l.trim() !== "").slice(-tail);
    out.push(`  --- ${path.relative(userDataDir, f)} (last ${last.length} lines)`);
    for (const l of last) out.push(`  ${l.slice(0, 220)}`);
  }
  return out;
}
