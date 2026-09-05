// The scheduling recipe for `dist/tick.js`: what to write, where, and what to
// run so a platform's own scheduler drives one orchestrator pass every few
// minutes with no editor open.
//
// `tick.js` was built to be put on a timer — it exits 2 when another process
// holds the flows lock and 3 when it cannot start, so a scheduler can simply run
// it again next time — but nothing in the product put it on one; a user had to
// write their own launchd plist or cron line and discover the binary first. This
// module is that plist, that timer, that task, built from a spec. It is PURE:
// no `fs`, no `child_process`, no `vscode`. The host (`scheduleTick.ts`) writes
// the files and runs the argv lists; the tests read the recipe as data. Every
// path it joins is joined for the TARGET platform, not the one running it, so a
// test on a Mac can check the Windows recipe byte for byte.
import * as path from "path";

/** The name the scheduler knows the job by. The same token on every platform so
 * a person who finds it in `launchctl list`, `systemctl --user`, or Task
 * Scheduler can connect it to the extension. */
export const SCHEDULE_LABEL = "com.agentflow.tick";
export const SYSTEMD_UNIT = "agentflow-tick";
export const SCHTASKS_NAME = "AgentFlowTick";

/** The intervals the command offers. Minutes, whole, and none shorter than the
 * lock TTL divided by a wide margin: a tick that started while the previous one
 * still held the lock exits 2 and simply waits for the next slot, so the floor
 * here is about not hammering the forge CLI, not about correctness. */
export const INTERVAL_CHOICES_MINUTES = [2, 5, 15, 30] as const;
export const DEFAULT_INTERVAL_MINUTES = 5;

export interface ScheduleSpec {
  platform: NodeJS.Platform;
  /** The user's home directory, as `os.homedir()` reports it on the target. */
  home: string;
  /** An absolute path to a binary that runs Node: `node` itself, or the editor's
   * own executable with `ELECTRON_RUN_AS_NODE=1` in `env`. */
  node: string;
  /** Environment the scheduler must set for `node` to run — `ELECTRON_RUN_AS_NODE`
   * when the binary is Electron, and a `PATH` wide enough to find `gh`/`glab`,
   * since a launchd or systemd job inherits neither a login shell nor Homebrew. */
  env: Record<string, string>;
  /** Absolute path to the extension's `dist/tick.js`. Versioned — see `tickPathIn`. */
  tickJs: string;
  /** `--settings <path>`, when the host knows which editor's file to read. Absent
   * lets the tick discover one by platform (see `headless/settings.ts`). */
  settings?: string;
  intervalMinutes: number;
  /** For launchd's `gui/<uid>` domain. Ignored elsewhere. */
  uid?: number;
}

export interface ScheduleRecipe {
  kind: "launchd" | "systemd" | "schtasks";
  /** Files to write, in order. Directories are the host's to create. */
  files: { path: string; contents: string }[];
  /** argv lists to run, in order, each as `execFile(argv[0], argv.slice(1))` —
   * never through a shell. `optional` steps may fail without aborting the
   * install (an `unload` before the first `load`). */
  install: { argv: string[]; optional?: boolean }[];
  /** How to take it out again. */
  remove: { argv: string[]; optional?: boolean }[];
  /** Where the scheduler puts the tick's stdout — the cron log a person reads. */
  logFile: string;
  /** One sentence for the confirmation modal. */
  summary: string;
}

/** The tick's own argv, shared by every platform's recipe. */
export function tickArgv(spec: Pick<ScheduleSpec, "node" | "tickJs" | "settings">): string[] {
  return [spec.node, spec.tickJs, ...(spec.settings ? ["--settings", spec.settings] : [])];
}

/** `~/.agentflow/tick.log` on the target platform — beside the flows, runs and
 * journals the tick writes, so everything about an unattended pass is in one
 * directory. */
export function tickLogPath(platform: NodeJS.Platform, home: string): string {
  const p = platform === "win32" ? path.win32 : path.posix;
  return p.join(home, ".agentflow", "tick.log");
}

/** Where each platform's recipe lives once installed — what `installedSchedule`
 * looks for. One path per platform; the systemd pair is reported by its timer. */
export function scheduleFile(platform: NodeJS.Platform, home: string, env: Record<string, string | undefined> = {}): string {
  if (platform === "darwin") return path.posix.join(home, "Library", "LaunchAgents", `${SCHEDULE_LABEL}.plist`);
  if (platform === "win32") return path.win32.join(home, ".agentflow", "tick.cmd");
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== "" ? env.XDG_CONFIG_HOME : path.posix.join(home, ".config");
  return path.posix.join(base, "systemd", "user", `${SYSTEMD_UNIT}.timer`);
}

const xml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A marker line every recipe carries, so `tickPathIn`/`intervalIn` read the
 * facts back without parsing three file formats: the host compares the tick
 * path on disk against the one it would write today, and re-installs at the
 * same interval when the extension has moved. */
const MARK = "agentflow-tick";
const marker = (spec: ScheduleSpec, comment: string): string =>
  `${comment} ${MARK} tick=${JSON.stringify(spec.tickJs)} every=${spec.intervalMinutes}m`;

/** The `tick.js` path a written recipe names, or `undefined` for a file this
 * module did not write. */
export function tickPathIn(contents: string): string | undefined {
  const m = new RegExp(`${MARK} tick=("(?:[^"\\\\]|\\\\.)*") every=`).exec(contents);
  if (!m) return undefined;
  try {
    return JSON.parse(m[1]) as string;
  } catch {
    return undefined;
  }
}

/** The interval a written recipe runs at, or `undefined`. */
export function intervalIn(contents: string): number | undefined {
  const m = new RegExp(`${MARK} tick="(?:[^"\\\\]|\\\\.)*" every=(\\d+)m`).exec(contents);
  return m ? Number(m[1]) : undefined;
}

function launchd(spec: ScheduleSpec): ScheduleRecipe {
  const file = scheduleFile("darwin", spec.home);
  const log = tickLogPath("darwin", spec.home);
  const env = Object.entries(spec.env).map(([k, v]) => `      <key>${xml(k)}</key>\n      <string>${xml(v)}</string>`).join("\n");
  const contents = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<!-- ${marker(spec, "")} — written by Agent Flow Deck; "Schedule the Orchestrator Tick…" rewrites it -->`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${SCHEDULE_LABEL}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...tickArgv(spec).map((a) => `    <string>${xml(a)}</string>`),
    `  </array>`,
    `  <key>StartInterval</key>`,
    `  <integer>${spec.intervalMinutes * 60}</integer>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    ...(env ? [`  <key>EnvironmentVariables</key>`, `  <dict>`, env, `  </dict>`] : []),
    `  <key>StandardOutPath</key>`,
    `  <string>${xml(log)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${xml(log)}</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
  const domain = `gui/${spec.uid ?? 501}`;
  return {
    kind: "launchd",
    files: [{ path: file, contents }],
    // `bootout` first so a re-install (a new version's path) replaces the loaded
    // job rather than failing with "service already loaded"; optional because
    // there is nothing to boot out the first time.
    install: [
      { argv: ["launchctl", "bootout", `${domain}/${SCHEDULE_LABEL}`], optional: true },
      { argv: ["launchctl", "bootstrap", domain, file] },
    ],
    remove: [{ argv: ["launchctl", "bootout", `${domain}/${SCHEDULE_LABEL}`], optional: true }],
    logFile: log,
    summary: `launchd runs the tick every ${spec.intervalMinutes} min from ${file}; output goes to ${log}.`,
  };
}

function systemd(spec: ScheduleSpec, envVars: Record<string, string | undefined>): ScheduleRecipe {
  const timer = scheduleFile("linux", spec.home, envVars);
  const service = timer.replace(/\.timer$/, ".service");
  const log = tickLogPath("linux", spec.home);
  const q = (a: string) => `"${a.replace(/(["\\$])/g, "\\$1")}"`;
  const serviceText = [
    marker(spec, "#"),
    `[Unit]`,
    `Description=Agent Flow Deck orchestrator tick`,
    ``,
    `[Service]`,
    `Type=oneshot`,
    ...Object.entries(spec.env).map(([k, v]) => `Environment=${q(`${k}=${v}`)}`),
    `ExecStart=${tickArgv(spec).map(q).join(" ")}`,
    `StandardOutput=append:${log}`,
    `StandardError=append:${log}`,
    // 2 (lock busy) and 3 (cannot start) are the tick's own "try again later";
    // listing them keeps `systemctl --user status` from reporting a failure for
    // a pass that was correctly skipped.
    `SuccessExitStatus=2 3`,
    ``,
  ].join("\n");
  const timerText = [
    marker(spec, "#"),
    `[Unit]`,
    `Description=Agent Flow Deck orchestrator tick, every ${spec.intervalMinutes} min`,
    ``,
    `[Timer]`,
    `OnBootSec=1min`,
    `OnUnitActiveSec=${spec.intervalMinutes}min`,
    `Unit=${SYSTEMD_UNIT}.service`,
    ``,
    `[Install]`,
    `WantedBy=timers.target`,
    ``,
  ].join("\n");
  return {
    kind: "systemd",
    files: [{ path: service, contents: serviceText }, { path: timer, contents: timerText }],
    install: [
      { argv: ["systemctl", "--user", "daemon-reload"] },
      { argv: ["systemctl", "--user", "enable", "--now", `${SYSTEMD_UNIT}.timer`] },
    ],
    remove: [
      { argv: ["systemctl", "--user", "disable", "--now", `${SYSTEMD_UNIT}.timer`], optional: true },
      { argv: ["systemctl", "--user", "daemon-reload"], optional: true },
    ],
    logFile: log,
    summary: `A systemd user timer runs the tick every ${spec.intervalMinutes} min from ${timer}; output goes to ${log}.`,
  };
}

function schtasks(spec: ScheduleSpec): ScheduleRecipe {
  const cmd = scheduleFile("win32", spec.home);
  const log = tickLogPath("win32", spec.home);
  const q = (a: string) => `"${a.replace(/"/g, '""')}"`;
  const contents = [
    `@echo off`,
    `rem ${marker(spec, "")} — written by Agent Flow Deck; "Schedule the Orchestrator Tick…" rewrites it`,
    ...Object.entries(spec.env).map(([k, v]) => `set "${k}=${v}"`),
    `${tickArgv(spec).map(q).join(" ")} >> ${q(log)} 2>&1`,
    ``,
  ].join("\r\n");
  return {
    kind: "schtasks",
    files: [{ path: cmd, contents }],
    install: [
      {
        argv: [
          "schtasks", "/Create", "/F", "/SC", "MINUTE", "/MO", String(spec.intervalMinutes),
          "/TN", SCHTASKS_NAME, "/TR", q(cmd),
        ],
      },
    ],
    remove: [{ argv: ["schtasks", "/Delete", "/F", "/TN", SCHTASKS_NAME], optional: true }],
    logFile: log,
    summary: `Task Scheduler runs ${cmd} every ${spec.intervalMinutes} min as ${SCHTASKS_NAME}; output goes to ${log}.`,
  };
}

/** The recipe for a platform. Linux and every other POSIX platform get systemd:
 * it is what the desktop distributions ship, and a cron line is one `crontab -e`
 * away for anyone who has something else — the docs give it. */
export function buildSchedule(spec: ScheduleSpec, envVars: Record<string, string | undefined> = {}): ScheduleRecipe {
  if (!Number.isInteger(spec.intervalMinutes) || spec.intervalMinutes < 1) {
    throw new Error(`the tick interval must be a whole number of minutes, not ${JSON.stringify(spec.intervalMinutes)}`);
  }
  if (spec.platform === "darwin") return launchd(spec);
  if (spec.platform === "win32") return schtasks(spec);
  return systemd(spec, envVars);
}

/** The `PATH` a scheduled tick runs with. A launchd or systemd job inherits
 * neither a login shell nor Homebrew, and the tick shells out to `gh`/`glab`
 * for PR facts — so the recipe carries the directories `resolveBin` itself
 * falls back to, plus the system ones. The host prepends the directory it found
 * `node` in. */
export function schedulePath(platform: NodeJS.Platform, home: string, extra: string[] = []): string {
  if (platform === "win32") return "";
  const dirs = [
    ...extra,
    "/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", "/home/linuxbrew/.linuxbrew/bin",
    path.posix.join(home, ".local", "bin"), path.posix.join(home, "bin"),
    "/usr/bin", "/bin", "/usr/sbin", "/sbin",
  ];
  return Array.from(new Set(dirs)).join(":");
}
