import { describe, expect, it } from "vitest";
import {
  buildSchedule, DEFAULT_INTERVAL_MINUTES, INTERVAL_CHOICES_MINUTES, intervalIn, SCHEDULE_LABEL, scheduleFile,
  schedulePath, SCHTASKS_NAME, ScheduleSpec, SYSTEMD_UNIT, tickArgv, tickLogPath, tickPathIn,
} from "../../../../src/engine/orchestrator/schedule";

const spec = (over: Partial<ScheduleSpec> = {}): ScheduleSpec => ({
  platform: "darwin",
  home: "/Users/me",
  node: "/opt/homebrew/bin/node",
  env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin" },
  tickJs: "/Users/me/.cursor/extensions/oznasi1.agent-flow-0.69.0/dist/tick.js",
  settings: "/Users/me/Library/Application Support/Cursor/User/settings.json",
  intervalMinutes: 5,
  uid: 502,
  ...over,
});

describe("tickArgv", () => {
  it("is node, tick.js, and --settings only when a path is known", () => {
    expect(tickArgv(spec())).toEqual([
      "/opt/homebrew/bin/node",
      "/Users/me/.cursor/extensions/oznasi1.agent-flow-0.69.0/dist/tick.js",
      "--settings",
      "/Users/me/Library/Application Support/Cursor/User/settings.json",
    ]);
    expect(tickArgv(spec({ settings: undefined }))).toHaveLength(2);
  });
});

describe("the launchd recipe", () => {
  const r = buildSchedule(spec());

  it("writes one plist under LaunchAgents and loads it into the user's gui domain", () => {
    expect(r.kind).toBe("launchd");
    expect(r.files.map((f) => f.path)).toEqual([`/Users/me/Library/LaunchAgents/${SCHEDULE_LABEL}.plist`]);
    expect(r.install).toEqual([
      { argv: ["launchctl", "bootout", `gui/502/${SCHEDULE_LABEL}`], optional: true },
      { argv: ["launchctl", "bootstrap", "gui/502", r.files[0].path] },
    ]);
    expect(r.remove).toEqual([{ argv: ["launchctl", "bootout", `gui/502/${SCHEDULE_LABEL}`], optional: true }]);
  });

  it("names the label, the argv, the interval in seconds, the environment and the log", () => {
    const text = r.files[0].contents;
    expect(text).toContain(`<string>${SCHEDULE_LABEL}</string>`);
    expect(text).toContain("<string>/opt/homebrew/bin/node</string>");
    expect(text).toContain("<string>--settings</string>");
    expect(text).toContain("<integer>300</integer>");
    expect(text).toContain("<key>PATH</key>");
    expect(text).toContain("<string>/Users/me/.agentflow/tick.log</string>");
    expect(r.logFile).toBe("/Users/me/.agentflow/tick.log");
  });

  it("escapes XML in every path it embeds", () => {
    const t = buildSchedule(spec({ settings: '/Users/me/we"ird & <odd>/settings.json' })).files[0].contents;
    expect(t).toContain("we&quot;ird &amp; &lt;odd&gt;");
    expect(t).not.toContain('we"ird');
  });

  it("omits the EnvironmentVariables dict when there is nothing to set", () => {
    expect(buildSchedule(spec({ env: {} })).files[0].contents).not.toContain("EnvironmentVariables");
  });

  it("carries the electron flag when the editor's own runtime is the node", () => {
    const t = buildSchedule(spec({ node: "/Applications/Cursor.app/Contents/MacOS/Cursor", env: { ELECTRON_RUN_AS_NODE: "1" } })).files[0].contents;
    expect(t).toContain("<key>ELECTRON_RUN_AS_NODE</key>");
    expect(t).toContain("<string>1</string>");
  });
});

describe("the systemd recipe", () => {
  const r = buildSchedule(spec({ platform: "linux", home: "/home/me" }));

  it("writes a oneshot service and a timer under the user unit dir, then enables the timer", () => {
    expect(r.kind).toBe("systemd");
    expect(r.files.map((f) => f.path)).toEqual([
      `/home/me/.config/systemd/user/${SYSTEMD_UNIT}.service`,
      `/home/me/.config/systemd/user/${SYSTEMD_UNIT}.timer`,
    ]);
    expect(r.install.map((s) => s.argv)).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", `${SYSTEMD_UNIT}.timer`],
    ]);
    expect(r.remove[0].argv).toEqual(["systemctl", "--user", "disable", "--now", `${SYSTEMD_UNIT}.timer`]);
  });

  it("honours XDG_CONFIG_HOME for the unit directory", () => {
    const x = buildSchedule(spec({ platform: "linux", home: "/home/me" }), { XDG_CONFIG_HOME: "/xdg" });
    expect(x.files[1].path).toBe(`/xdg/systemd/user/${SYSTEMD_UNIT}.timer`);
    expect(scheduleFile("linux", "/home/me", { XDG_CONFIG_HOME: "  " })).toBe(`/home/me/.config/systemd/user/${SYSTEMD_UNIT}.timer`);
  });

  it("quotes the ExecStart, appends to the log, and treats the tick's own retry codes as success", () => {
    const service = r.files[0].contents;
    expect(service).toContain('ExecStart="/opt/homebrew/bin/node" "/Users/me/.cursor/extensions/oznasi1.agent-flow-0.69.0/dist/tick.js" "--settings"');
    expect(service).toContain("StandardOutput=append:/home/me/.agentflow/tick.log");
    expect(service).toContain("SuccessExitStatus=2 3");
    expect(service).toContain('Environment="PATH=/opt/homebrew/bin:/usr/bin:/bin"');
    expect(r.files[1].contents).toContain("OnUnitActiveSec=5min");
    expect(r.files[1].contents).toContain(`Unit=${SYSTEMD_UNIT}.service`);
  });

  it("escapes a double quote or a dollar inside a quoted systemd value", () => {
    const t = buildSchedule(spec({ platform: "linux", settings: '/h/o"m$e/settings.json' })).files[0].contents;
    expect(t).toContain('"/h/o\\"m\\$e/settings.json"');
  });

  it("is what any non-darwin, non-windows platform gets", () => {
    expect(buildSchedule(spec({ platform: "freebsd" })).kind).toBe("systemd");
  });
});

describe("the schtasks recipe", () => {
  const r = buildSchedule(spec({
    platform: "win32", home: "C:\\Users\\me", node: "C:\\Program Files\\nodejs\\node.exe",
    env: {}, tickJs: "C:\\Users\\me\\.vscode\\extensions\\oznasi1.agent-flow-0.69.0\\dist\\tick.js",
    settings: "C:\\Users\\me\\AppData\\Roaming\\Code\\User\\settings.json",
  }));

  it("writes a .cmd wrapper under ~/.agentflow and registers it with schtasks every N minutes", () => {
    expect(r.kind).toBe("schtasks");
    expect(r.files[0].path).toBe("C:\\Users\\me\\.agentflow\\tick.cmd");
    expect(r.install[0].argv).toEqual([
      "schtasks", "/Create", "/F", "/SC", "MINUTE", "/MO", "5", "/TN", SCHTASKS_NAME, "/TR", '"C:\\Users\\me\\.agentflow\\tick.cmd"',
    ]);
    expect(r.remove[0].argv).toEqual(["schtasks", "/Delete", "/F", "/TN", SCHTASKS_NAME]);
    expect(r.logFile).toBe("C:\\Users\\me\\.agentflow\\tick.log");
  });

  it("uses CRLF, quotes every argument, and redirects both streams to the log", () => {
    const t = r.files[0].contents;
    expect(t.split("\r\n")[0]).toBe("@echo off");
    expect(t).toContain('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\.vscode\\extensions\\oznasi1.agent-flow-0.69.0\\dist\\tick.js" "--settings"');
    expect(t).toContain('>> "C:\\Users\\me\\.agentflow\\tick.log" 2>&1');
  });

  it("sets the environment with `set` lines", () => {
    const t = buildSchedule(spec({ platform: "win32", home: "C:\\Users\\me", env: { ELECTRON_RUN_AS_NODE: "1" } })).files[0].contents;
    expect(t).toContain('set "ELECTRON_RUN_AS_NODE=1"');
  });
});

describe("reading a recipe back", () => {
  it("recovers the tick path and interval from each platform's file", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const r = buildSchedule(spec({ platform, intervalMinutes: 15 }));
      for (const f of r.files) {
        expect(tickPathIn(f.contents)).toBe(spec().tickJs);
        expect(intervalIn(f.contents)).toBe(15);
      }
    }
  });

  it("survives a tick path with a quote in it", () => {
    const r = buildSchedule(spec({ tickJs: '/odd "dir"/dist/tick.js' }));
    expect(tickPathIn(r.files[0].contents)).toBe('/odd "dir"/dist/tick.js');
  });

  it("answers nothing for a file this module did not write", () => {
    expect(tickPathIn("<plist/>")).toBeUndefined();
    expect(intervalIn("[Timer]\nOnUnitActiveSec=5min")).toBeUndefined();
    expect(tickPathIn('agentflow-tick tick="unterminated every=5m')).toBeUndefined();
  });
});

describe("guards and helpers", () => {
  it("refuses a fractional or non-positive interval", () => {
    expect(() => buildSchedule(spec({ intervalMinutes: 0 }))).toThrow(/whole number/);
    expect(() => buildSchedule(spec({ intervalMinutes: 2.5 }))).toThrow(/whole number/);
    expect(() => buildSchedule(spec({ intervalMinutes: Number.NaN }))).toThrow(/whole number/);
  });

  it("offers whole-minute intervals with the recommended one among them", () => {
    expect(INTERVAL_CHOICES_MINUTES).toContain(DEFAULT_INTERVAL_MINUTES);
    for (const m of INTERVAL_CHOICES_MINUTES) expect(Number.isInteger(m) && m >= 1).toBe(true);
  });

  it("builds a PATH that puts the found node first, then Homebrew and the system dirs, once each", () => {
    const p = schedulePath("darwin", "/Users/me", ["/opt/homebrew/bin"]).split(":");
    expect(p[0]).toBe("/opt/homebrew/bin");
    expect(p.filter((d) => d === "/opt/homebrew/bin")).toHaveLength(1);
    expect(p).toContain("/usr/bin");
    expect(p).toContain("/Users/me/.local/bin");
    expect(schedulePath("win32", "C:\\Users\\me")).toBe("");
  });

  it("puts the log beside the flows on every platform", () => {
    expect(tickLogPath("darwin", "/Users/me")).toBe("/Users/me/.agentflow/tick.log");
    expect(tickLogPath("win32", "C:\\Users\\me")).toBe("C:\\Users\\me\\.agentflow\\tick.log");
  });

  it("defaults launchd's domain to uid 501 when none is known", () => {
    expect(buildSchedule(spec({ uid: undefined })).install[1].argv[2]).toBe("gui/501");
  });
});
