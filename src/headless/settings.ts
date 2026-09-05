// Where a headless pass gets its settings. There is no editor to ask, so the
// tick reads the same `settings.json` the editor would — found by platform, or
// named outright — and exposes it through the `SettingsReader` surface every
// pure reader in `configReaders.ts` already takes. One source of truth for what
// a setting means (the readers); two ways of getting the bytes (the editor, and
// this file).
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parse } from "jsonc-parser";
import { SettingsReader } from "../configReaders";

/** The editors whose user settings this tick knows how to find, most specific
 * first. Cursor and Insiders keep their own files; a machine with both an editor
 * and its Insiders build has two lists of commands, and the first one found is
 * the one that counts — `--settings` names one explicitly when that is wrong. */
const APPS = ["Code", "Code - Insiders", "Cursor"];

/** Every place a user-level `settings.json` can live for this platform, in the
 * order they are tried. Pure over its inputs so the test can walk all three
 * platforms without being on them. */
export function candidateSettingsPaths(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  if (env.AGENT_FLOW_SETTINGS) out.push(env.AGENT_FLOW_SETTINGS);
  for (const app of APPS) {
    if (platform === "darwin") out.push(path.join(home, "Library", "Application Support", app, "User", "settings.json"));
    else if (platform === "win32" && env.APPDATA) out.push(path.join(env.APPDATA, app, "User", "settings.json"));
    else out.push(path.join(home, ".config", app, "User", "settings.json"));
  }
  return out;
}

export interface LoadedSettings {
  path: string;
  reader: SettingsReader;
  /** The whole parsed file, for the handful of settings that are NOT ours.
   * `reader` deliberately answers only `agentFlow.*` keys, and telemetry consent
   * is two settings, one of them the editor's own `telemetry.telemetryLevel` —
   * which has no `agentFlow.` prefix and so cannot come through the reader. */
  raw: Record<string, unknown>;
}

export interface SettingsIo {
  exists(p: string): boolean;
  read(p: string): string;
}

const realIo: SettingsIo = { exists: (p) => fs.existsSync(p), read: (p) => fs.readFileSync(p, "utf8") };

/** A `SettingsReader` over a parsed settings object. VS Code writes `agentFlow.x`
 * as flat dotted keys, but a hand-organised file may nest them under an
 * `"agentFlow"` object; both are the same setting and both are read. */
export function readerFor(raw: Record<string, unknown>): SettingsReader {
  const nested = raw.agentFlow && typeof raw.agentFlow === "object" ? (raw.agentFlow as Record<string, unknown>) : {};
  return {
    get<T>(key: string): T | undefined {
      const flat = raw[`agentFlow.${key}`];
      return (flat !== undefined ? flat : nested[key]) as T | undefined;
    },
  };
}

/** Find and parse the settings. An explicit path is authoritative — a missing one
 * is an error, not a fallback — because a cron job that silently switched to a
 * different editor's file would run a different list of commands. Without one,
 * the first existing candidate wins. JSONC: the editor's file carries comments
 * and trailing commas, which a bare `JSON.parse` would refuse. */
export function loadSettings(
  explicit: string | undefined,
  io: SettingsIo = realIo,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): LoadedSettings | { error: string } {
  const candidates = explicit !== undefined ? [explicit] : candidateSettingsPaths(platform, home, env);
  const found = candidates.find((p) => io.exists(p));
  if (found === undefined) {
    return {
      error: explicit !== undefined
        ? `no settings file at ${explicit}`
        : `no editor settings.json found — looked in: ${candidates.join(", ")}. Pass --settings <path>.`,
    };
  }
  let raw: unknown;
  try {
    raw = parse(io.read(found));
  } catch (e) {
    return { error: `could not read ${found}: ${(e as Error).message}` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: `${found} is not a settings object` };
  return { path: found, reader: readerFor(raw as Record<string, unknown>), raw: raw as Record<string, unknown> };
}
