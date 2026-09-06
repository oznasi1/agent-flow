// "Agent Flow: Schedule the Orchestrator Tick…" — the command that puts
// `dist/tick.js` on the platform's own scheduler, and the activation check that
// notices when an extension update has moved the file it points at.
//
// The recipe itself is pure (`engine/orchestrator/schedule.ts`); this file is
// the host shell around it: it finds a Node binary, decides which editor's
// settings the tick should read, asks for an interval, confirms, writes the
// files and runs the scheduler's own commands — through `execFile` with an argv
// list, never a shell, because every argument here is a path. Everything the
// shell touches is behind `ScheduleHost` so the tests drive it with a fake and
// never write to a real LaunchAgents directory.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import * as vscode from "vscode";
import {
  buildSchedule, DEFAULT_INTERVAL_MINUTES, INTERVAL_CHOICES_MINUTES, intervalIn, scheduleFile, schedulePath,
  ScheduleRecipe, ScheduleSpec, tickPathIn,
} from "./engine/orchestrator/schedule";
import { candidateSettingsPaths, loadSettings } from "./headless/settings";
import { resolveBin } from "./engine/pr/which";

export const STALE_NOTICE_KEY = "agentFlow.tick.staleNoticeFor";

export const REMOVE = "Remove the schedule";
export const SCHEDULE = "Schedule";
export const UPDATE = "Update the schedule";
export const NOT_NOW = "Not now";

/** Everything about the machine this command reads or changes. */
export interface ScheduleHost {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  uid?: number;
  /** `process.execPath` — the editor's own Electron, the fallback Node. */
  execPath: string;
  /** `vscode.env.appName`, which says whose settings.json the tick should read. */
  appName: string;
  /** The extension's install directory; `dist/tick.js` lives under it. */
  extensionPath: string;
  exists(p: string): boolean;
  read(p: string): string | null;
  /** Write, creating parent directories. */
  write(p: string, text: string): void;
  remove(p: string): void;
  /** Run one scheduler command; reject with its stderr on a non-zero exit. */
  run(argv: string[]): Promise<void>;
  resolveBin(name: string): string | null;
}

export function defaultScheduleHost(context: Pick<vscode.ExtensionContext, "extensionPath">): ScheduleHost {
  return {
    platform: process.platform,
    home: os.homedir(),
    env: process.env,
    uid: typeof process.getuid === "function" ? process.getuid() : undefined,
    execPath: process.execPath,
    appName: vscode.env.appName,
    extensionPath: context.extensionPath,
    exists: (p) => fs.existsSync(p),
    read: (p) => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    write: (p, text) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text);
    },
    remove: (p) => {
      try {
        fs.unlinkSync(p);
      } catch {
        /* already gone */
      }
    },
    run: (argv) =>
      new Promise((resolve, reject) => {
        execFile(argv[0], argv.slice(1), { timeout: 30_000, windowsHide: true }, (err, _out, stderr) => {
          if (err) reject(new Error(String(stderr ?? "").trim() || err.message));
          else resolve();
        });
      }),
    resolveBin: (name) => resolveBin(name),
  };
}

/** Which editor's `settings.json` the tick should read: the one this window
 * belongs to. `candidateSettingsPaths` lists every editor's file for the
 * platform; the app name picks the directory, and the file must exist — the
 * tick's own discovery takes over otherwise. Without this, a machine with both
 * Code and Cursor installed would schedule a tick reading the OTHER editor's
 * command list. */
export function settingsFor(host: Pick<ScheduleHost, "platform" | "home" | "env" | "appName" | "exists">): string | undefined {
  const app = /insiders/i.test(host.appName) ? "Code - Insiders" : /cursor/i.test(host.appName) ? "Cursor" : "Code";
  const sep = host.platform === "win32" ? "\\" : "/";
  const hit = candidateSettingsPaths(host.platform, host.home, { ...host.env, AGENT_FLOW_SETTINGS: undefined })
    .find((p) => p.includes(`${sep}${app}${sep}`));
  return hit && host.exists(hit) ? hit : undefined;
}

/** The spec this machine would schedule today. Prefers a real `node` on the
 * PATH (or in the usual Homebrew places); falls back to the editor's own
 * executable run as Node, which every VS Code and Cursor build supports. */
export function currentSpec(host: ScheduleHost, intervalMinutes: number): ScheduleSpec {
  const node = host.resolveBin("node");
  const tickJs = path.join(host.extensionPath, "dist", "tick.js");
  const env: Record<string, string> = {};
  const pathVar = schedulePath(host.platform, host.home, node ? [path.dirname(node)] : []);
  if (pathVar) env.PATH = pathVar;
  if (!node) env.ELECTRON_RUN_AS_NODE = "1";
  return {
    platform: host.platform, home: host.home, uid: host.uid,
    node: node ?? host.execPath, env, tickJs, settings: settingsFor(host), intervalMinutes,
  };
}

export interface Installed {
  file: string;
  tickJs?: string;
  intervalMinutes?: number;
}

/** What is on disk now, read from the recipe's own marker line. */
export function installedSchedule(host: Pick<ScheduleHost, "platform" | "home" | "env" | "exists" | "read">): Installed | undefined {
  const file = scheduleFile(host.platform, host.home, host.env as Record<string, string | undefined>);
  if (!host.exists(file)) return undefined;
  const text = host.read(file) ?? "";
  return { file, tickJs: tickPathIn(text), intervalMinutes: intervalIn(text) };
}

async function runSteps(host: ScheduleHost, steps: ScheduleRecipe["install"], log: (m: string) => void): Promise<void> {
  for (const s of steps) {
    try {
      await host.run(s.argv);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!s.optional) throw new Error(`${s.argv.join(" ")} failed: ${msg}`);
      log(`tick schedule: ${s.argv.join(" ")} — ${msg} (ignored)`);
    }
  }
}

async function install(host: ScheduleHost, recipe: ScheduleRecipe, log: (m: string) => void): Promise<void> {
  for (const f of recipe.files) host.write(f.path, f.contents);
  await runSteps(host, recipe.install, log);
}

async function uninstall(host: ScheduleHost, recipe: ScheduleRecipe, log: (m: string) => void): Promise<void> {
  await runSteps(host, recipe.remove, log);
  for (const f of recipe.files) host.remove(f.path);
}

/** Is `agentFlow.orchestrator` on in the file the tick will read? The tick exits
 * 3 until it is, and saying so before scheduling beats a log full of refusals. */
function orchestratorOnIn(host: ScheduleHost, settings: string | undefined): boolean | undefined {
  const io = { exists: (p: string) => host.exists(p), read: (p: string) => host.read(p) ?? "" };
  const loaded = loadSettings(settings, io, host.platform, host.home, host.env);
  if ("error" in loaded) return undefined;
  return loaded.reader.get<boolean>("orchestrator") === true;
}

/** The command body. */
export async function scheduleTickCommand(host: ScheduleHost, log: (m: string) => void): Promise<void> {
  const installed = installedSchedule(host);
  const items: vscode.QuickPickItem[] = INTERVAL_CHOICES_MINUTES.map((m) => ({
    label: `Every ${m} minutes`,
    description: m === DEFAULT_INTERVAL_MINUTES ? "recommended" : undefined,
    detail: installed?.intervalMinutes === m ? "the current schedule" : undefined,
  }));
  if (installed) items.push({ label: REMOVE, detail: installed.file });
  const picked = await vscode.window.showQuickPick(items, {
    title: "Schedule the Orchestrator tick",
    placeHolder: installed
      ? `A tick is scheduled from ${installed.file}. Pick a new interval, or remove it.`
      : "How often should a pass run with no editor open?",
    ignoreFocusOut: true,
  });
  if (!picked) return;

  if (picked.label === REMOVE && installed) {
    const recipe = buildSchedule(currentSpec(host, installed.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES), host.env as Record<string, string | undefined>);
    try {
      await uninstall(host, recipe, log);
      void vscode.window.showInformationMessage(`Agent Flow Deck: the scheduled tick was removed (${installed.file}).`);
    } catch (e) {
      void vscode.window.showErrorMessage(`Agent Flow Deck: could not remove the schedule — ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }

  const minutes = Number(/^Every (\d+) minutes$/.exec(picked.label)?.[1] ?? DEFAULT_INTERVAL_MINUTES);
  const spec = currentSpec(host, minutes);
  if (!host.exists(spec.tickJs)) {
    void vscode.window.showErrorMessage(`Agent Flow Deck: ${spec.tickJs} is missing — this build has no tick to schedule.`);
    return;
  }
  const recipe = buildSchedule(spec, host.env as Record<string, string | undefined>);
  const on = orchestratorOnIn(host, spec.settings);
  const detail = [
    recipe.summary,
    `It runs ${spec.node}${spec.env.ELECTRON_RUN_AS_NODE ? " (the editor's own runtime, as Node)" : ""} on ${spec.tickJs}` +
      (spec.settings ? `, reading ${spec.settings}.` : ", reading whichever editor settings.json it finds."),
    on === false ? "agentFlow.orchestrator is OFF in that file: every pass will exit 3 until you turn it on." : "",
    "The tick performs notify rules and already-consented commands only; launches, seeds and gates wait for an editor. " +
      "An extension update moves tick.js — the next activation will offer to re-point the schedule.",
  ].filter(Boolean).join("\n\n");
  const answer = await vscode.window.showWarningMessage(
    `Schedule the Orchestrator tick every ${minutes} minutes?`, { modal: true, detail }, SCHEDULE,
  );
  if (answer !== SCHEDULE) return;
  try {
    await install(host, recipe, log);
    log(`tick schedule: installed ${recipe.kind} every ${minutes}m → ${recipe.files.map((f) => f.path).join(", ")}`);
    void vscode.window.showInformationMessage(
      `Agent Flow Deck: the tick runs every ${minutes} minutes. Output: ${recipe.logFile}`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`tick schedule: install failed — ${msg}`);
    void vscode.window.showErrorMessage(`Agent Flow Deck: scheduling failed — ${msg}. The files were written; see the docs for the manual step.`);
  }
}

/** On activation: a schedule pointing at a `tick.js` that is not this build's is
 * pointing at a directory the editor deletes after an update, so the overnight
 * passes have silently stopped. Offer to re-point it at the same interval.
 * Asked once per stale path — dismissing it is an answer until the next update
 * moves the file again. */
export async function maybeOfferScheduleRefresh(
  context: Pick<vscode.ExtensionContext, "globalState">,
  host: ScheduleHost,
  log: (m: string) => void,
): Promise<void> {
  try {
    const installed = installedSchedule(host);
    if (!installed?.tickJs) return;
    const current = path.join(host.extensionPath, "dist", "tick.js");
    if (installed.tickJs === current || !host.exists(current)) return;
    if (context.globalState.get<string>(STALE_NOTICE_KEY) === installed.tickJs) return;
    await context.globalState.update(STALE_NOTICE_KEY, installed.tickJs);
    const minutes = installed.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES;
    const choice = await vscode.window.showInformationMessage(
      `The scheduled Orchestrator tick points at a previous Agent Flow Deck version (${installed.tickJs}), ` +
        `which is gone after the update. Re-point it at this one, every ${minutes} minutes?`,
      UPDATE,
      NOT_NOW,
    );
    if (choice !== UPDATE) return;
    const recipe = buildSchedule(currentSpec(host, minutes), host.env as Record<string, string | undefined>);
    await install(host, recipe, log);
    void vscode.window.showInformationMessage(`Agent Flow Deck: the scheduled tick now runs this version, every ${minutes} minutes.`);
  } catch (e) {
    log(`tick schedule: refresh failed — ${e instanceof Error ? e.message : String(e)}`);
  }
}
