// The settings readers that need NO editor: pure functions over a `get(key)`
// surface, so `config.ts` (which reads `vscode.workspace.getConfiguration`) and
// the headless tick (which reads the same `settings.json` from disk) resolve the
// same setting to the same value. `vscode.WorkspaceConfiguration` satisfies
// `SettingsReader` structurally; `headless/settings.ts` builds one from a parsed
// file. Nothing here may import `vscode`: this module is bundled into
// `dist/tick.js`, which runs where no editor is.
import { FlowCommand } from "./types";

/** The one method both settings sources share. Keys are relative to the
 * `agentFlow.` section, exactly as `getConfiguration("agentFlow").get(key)`. */
export interface SettingsReader {
  get<T>(key: string): T | undefined;
}

/** The one command a fresh install's picker shows. A user who has not yet
 * configured this setting still gets a real row in the picker — one that
 * demonstrates `{note}` substitution — instead of a picker that looks empty
 * and gives no sign named commands are even a thing. See `readCommands`'
 * doc comment for the rule this single entry has to satisfy. */
export const DEFAULT_COMMANDS: FlowCommand[] = [
  {
    id: "verify-on-dev",
    label: "Verify on dev",
    detail: "Example — replace the command with your own check",
    run: "echo verify the feature on {note}",
  },
];

/** Read `agentFlow.commands`: the named commands a `run` rule's node can point at
 * by `commandId`. Each entry needs a non-blank `id` and `run`; `label` falls back
 * to the id; duplicate ids keep the first. A missing or non-array setting resolves
 * to `DEFAULT_COMMANDS` — spread, not aliased, so a caller cannot mutate the
 * constant through the result. */
export function readCommands(c: SettingsReader): FlowCommand[] {
  const raw = c.get<unknown[]>("commands");
  if (!Array.isArray(raw)) return [...DEFAULT_COMMANDS];
  const out: FlowCommand[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const e = v as Partial<FlowCommand>;
    const id = typeof e.id === "string" ? e.id.trim() : "";
    const run = typeof e.run === "string" ? e.run.trim() : "";
    if (!id || !run || seen.has(id)) continue;
    seen.add(id);
    const label = typeof e.label === "string" && e.label.trim() ? e.label.trim() : id;
    out.push({ id, label, run, ...(typeof e.detail === "string" && e.detail.trim() ? { detail: e.detail.trim() } : {}) });
  }
  return out;
}

/** Read `agentFlow.neverAutoRun`. Trims each entry and drops anything blank or
 * non-string, the same treatment `readCommands` gives a command's `run` — a
 * `settings.json` is a text file people edit by hand, and a stray `""` must not
 * become a rule.
 *
 * Deliberately does NOT fall back to a default list the way `readEnvironments`
 * does. There is no default: an unusable setting reads as an empty list, because
 * the alternative is this module refusing commands that nobody configured it to
 * refuse. The setting is a brake the user installs, never one shipped pre-applied.
 * That is also what makes it safe to ship to an existing install — see
 * `test/unit/compat.test.ts` on new behavior arriving inert. */
export function readNeverAutoRun(c: SettingsReader): string[] {
  const raw = c.get<unknown[]>("neverAutoRun");
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v !== "");
}

/** Read `agentFlow.commandConsent`: anything but the exact opt-in string is the
 * released once-per-flow behaviour — a hand-typed `"per-command"` must not
 * silently become the new mode, and must not break the old one either. */
export function readCommandConsent(c: SettingsReader): "flow" | "command" {
  return c.get<string>("commandConsent") === "command" ? "command" : "flow";
}
