import * as vscode from "vscode";
import { DEFAULT_PROMPT_MODES, DEFAULT_REVIEW_REQUEST_MODES } from "./config";
import { PromptMode } from "./types";

export const MODES_NOTICE_KEY = "agentFlow.promptModes.layeringNoticeShown";
export const LAYERING_DOCS_URL = "https://github.com/oznasi1/agent-flow/blob/main/CHANGELOG.md";

const DETAILS = "What changed";
const HIDE = "Hide the new ones";

/** The mode-list settings that layer over built-ins, and what they layer over. */
const MODE_SETTINGS: { key: string; builtIns: PromptMode[] }[] = [
  { key: "promptModes", builtIns: DEFAULT_PROMPT_MODES },
  { key: "reviewRequestModes", builtIns: DEFAULT_REVIEW_REQUEST_MODES },
];

/** A setting whose explicit value omits built-ins, so modes are about to appear. */
interface Affected {
  key: string;
  /** The user's array exactly as authored, so a hide-write appends to it. */
  entries: unknown[];
  /** Built-in ids the user never listed. */
  missing: string[];
  /** The scope the user's value lives in, so the write stays there. */
  target: vscode.ConfigurationTarget;
}

/** Minimal shape of what `WorkspaceConfiguration.inspect` returns, narrowed to
 * the three scopes a user can author. `key` is declared (though unused) because
 * the real return value always carries it, and so do the inspect fixtures the
 * tests build by hand — omitting it would make every one of those an excess
 * property under a literal's type check. */
interface Inspected<T> {
  key?: string;
  workspaceFolderValue?: T;
  workspaceValue?: T;
  globalValue?: T;
}

/** The most specific user-authored value and the scope holding it, matching the
 * folder > workspace > global precedence `explicitConfigValue` uses in config.ts.
 * Returning the scope is the point: a hide-write must land where the user's value
 * already is, never silently promote a workspace override to global. */
export function pickExplicit<T>(
  i: Inspected<T> | undefined,
): { value: T; target: vscode.ConfigurationTarget } | undefined {
  if (!i) return undefined;
  // Neither agentFlow.promptModes nor agentFlow.reviewRequestModes declares a
  // `scope` in package.json, so both are window-scoped and VS Code never
  // actually reports a workspaceFolderValue for them — this branch is
  // unreachable in practice. It stays anyway to mirror explicitConfigValue's
  // precedence in config.ts; the two functions agreeing is the point, even
  // though only two of the three scopes here are ever exercised.
  if (i.workspaceFolderValue !== undefined) {
    return { value: i.workspaceFolderValue, target: vscode.ConfigurationTarget.WorkspaceFolder };
  }
  if (i.workspaceValue !== undefined) {
    return { value: i.workspaceValue, target: vscode.ConfigurationTarget.Workspace };
  }
  if (i.globalValue !== undefined) {
    return { value: i.globalValue, target: vscode.ConfigurationTarget.Global };
  }
  return undefined;
}

/** Which built-ins a user's explicit list omits — the modes that layering is
 * about to make appear for them. An id they listed only to hide counts as
 * listed: they already made that choice and nothing is about to change for it.
 * Undefined when the setting is untouched, unusable, or already names them all.
 * Takes `Inspected<unknown>`, not `Inspected<unknown[]>`: a hand-edited
 * settings.json can put anything under the key, and the non-array case below is
 * exactly that — a value the setting's schema wouldn't produce but the file on
 * disk still can. */
export function affectedFromInspect(
  i: Inspected<unknown> | undefined,
  key: string,
  builtIns: PromptMode[],
): Affected | undefined {
  const explicit = pickExplicit(i);
  if (!explicit || !Array.isArray(explicit.value)) return undefined;
  // An explicit `[]` already resolves to the built-ins today, before this
  // function ever runs — nothing is about to change for that user, so treat
  // it the same as an untouched setting rather than reporting every built-in
  // as newly missing.
  if (!explicit.value.length) return undefined;
  const listed = new Set<string>();
  for (const raw of explicit.value) {
    if (!raw || typeof raw !== "object") continue;
    const id = (raw as { id?: unknown }).id;
    if (typeof id === "string" && id.trim()) listed.add(id.trim());
  }
  const missing = builtIns.filter((m) => !listed.has(m.id)).map((m) => m.id);
  return missing.length ? { key, entries: explicit.value, missing, target: explicit.target } : undefined;
}

/** Tell the users whose customized mode list used to *replace* the built-ins
 * that it now layers over them, so modes they never listed are about to appear.
 * Fires once ever, and only for them — an untouched setting, or one that already
 * names every built-in, says nothing, which is the majority of installs.
 * **Hide the new ones** restores exactly the picker they had.
 *
 * Deferred while first-run setup is on screen, without consuming the key, so it
 * still appears on a later activation. Never throws: a notice that fails to
 * render must not break activation. */
export async function maybeShowModesNotice(
  context: vscode.ExtensionContext,
  opts: { setupRunning: boolean },
): Promise<void> {
  try {
    if (opts.setupRunning) return;
    if (context.globalState.get<boolean>(MODES_NOTICE_KEY)) return;

    const c = vscode.workspace.getConfiguration("agentFlow");
    const affected: Affected[] = [];
    for (const s of MODE_SETTINGS) {
      const a = affectedFromInspect(c.inspect<unknown[]>(s.key), s.key, s.builtIns);
      if (a) affected.push(a);
    }
    if (!affected.length) return;
    await context.globalState.update(MODES_NOTICE_KEY, true);

    const n = affected.reduce((sum, a) => sum + a.missing.length, 0);
    const choice = await vscode.window.showInformationMessage(
      `Your customized prompt mode lists now layer on top of the built-in ones — ${n} new ` +
        `${n === 1 ? "mode is" : "modes are"} showing.`,
      DETAILS,
      HIDE,
    );
    if (choice === DETAILS) {
      await vscode.env.openExternal(vscode.Uri.parse(LAYERING_DOCS_URL));
    } else if (choice === HIDE) {
      for (const a of affected) {
        const hidden = a.missing.map((id) => ({ id, hidden: true }));
        await c.update(a.key, [...a.entries, ...hidden], a.target);
      }
    }
  } catch {
    // A notice that fails to render must never break activation.
  }
}
