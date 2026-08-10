// Resolve a command node's shell command and run it. This is the file Task 6's
// wiring will call from the Deck's poll loop; it does not touch the panel or the
// webview itself.
//
// No `vscode`, no `child_process` — this directory is webview-reachable, and only
// `npm run build` catches such an import (`tsc` and the tests pass regardless).
// The actual process spawn is an injected `CommandRunner`, the same posture
// `launch.ts` takes with `openWorkspace`.
import type { CommandNode } from "./model";
import type { FlowCommand } from "../../types";

/** 120 s. Must stay well under `LOCK_TTL_MS` (300 s, `lock.ts`): the flows lock is
 * held across the whole act, and a command outliving the TTL would have its own
 * lock reaped by another window while the command is still running — the same
 * hazard `LOCK_TTL_MS`'s own comment describes for a launch or a seed. */
export const COMMAND_TIMEOUT_MS = 120_000;

export interface CommandRunner {
  (command: string, opts: { cwd: string; timeoutMs: number }):
    Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface RunCommandRequest {
  node: CommandNode;
  commands: FlowCommand[];
  note?: string;
  cwd: string;
}

export type CommandOutcome =
  | { ok: true; code: 0; label: string; output: string }
  | { ok: false; message: string; label: string; output?: string };

/** Substitute `{note}` slice-by-slice. NEVER `String.replace`: its replacement
 * argument interprets `$&`, `$1` and friends, and a note is user text that must
 * reach the shell exactly as typed.
 *
 * A template with no `{note}` gets NOTHING appended, which is where this differs
 * from `composeAgentPrompt` (`prompt.ts`). Appending stray words to a prompt adds
 * context; appending them to a shell command changes what executes. */
function withNote(template: string, note: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const at = template.indexOf("{note}", i);
    if (at === -1) return out + template.slice(i);
    out += template.slice(i, at) + note;
    i = at + "{note}".length;
  }
}

/** The label to show when a node can't even be resolved enough to have a real
 * one — the drawer or a log line still needs SOMETHING to name the rule by. */
function fallbackLabel(node: CommandNode): string {
  return node.commandId ?? node.run ?? "command";
}

/** Resolve a command node to the text that will actually run. Refuses rather than
 * guesses on every ambiguous or incomplete shape: a `commandId` naming nothing
 * configured, a node with neither `commandId` nor `run`, and a node with BOTH
 * (picking one would make the drawer's display and what executes disagree, which
 * is the failure mode this whole feature exists to remove). */
export function resolveCommand(
  node: CommandNode,
  commands: FlowCommand[],
  note?: string,
): { ok: true; label: string; text: string } | { ok: false; message: string } {
  const hasId = node.commandId !== undefined;
  const hasRun = node.run !== undefined;

  if (hasId && hasRun) {
    return {
      ok: false,
      message:
        `command node carries both a configured command ("${node.commandId}") and a free-text ` +
        `run — refusing rather than guessing which one actually executes.`,
    };
  }

  if (hasId) {
    const cmd = commands.find((c) => c.id === node.commandId);
    if (!cmd) {
      return { ok: false, message: `no command named "${node.commandId}" is configured in agentFlow.commands.` };
    }
    return { ok: true, label: cmd.label, text: withNote(cmd.run, note ?? "") };
  }

  if (hasRun) {
    return { ok: true, label: node.run as string, text: withNote(node.run as string, note ?? "") };
  }

  return { ok: false, message: "command node names neither a configured commandId nor a free-text run." };
}

/** Run a rule's command. Never throws — the caller is a poll loop inside the
 * Deck's own refresh, and an exception here would take the whole refresh down,
 * not just this one rule, exactly the guarantee `launchPlanned` gives for the
 * same reason. The whole body runs inside one `try` so that holds regardless of
 * what the injected `run` does, not only for the await we know is async.
 *
 * Resolves first and returns without calling `deps.run` at all on a refusal —
 * a rule that can't be resolved must not run SOMETHING anyway. */
export async function runCommand(
  req: RunCommandRequest,
  deps: { run: CommandRunner; log: (m: string) => void },
): Promise<CommandOutcome> {
  const { node, commands, note, cwd } = req;
  try {
    const resolved = resolveCommand(node, commands, note);
    if (!resolved.ok) {
      return { ok: false, message: resolved.message, label: fallbackLabel(node) };
    }

    deps.log(`running: ${resolved.text}`);
    const { code, stdout, stderr } = await deps.run(resolved.text, { cwd, timeoutMs: COMMAND_TIMEOUT_MS });
    const output = stdout + stderr;
    deps.log(output);

    if (code === 0) {
      return { ok: true, code: 0, label: resolved.label, output };
    }
    return { ok: false, message: `"${resolved.label}" exited with code ${code}.`, label: resolved.label, output };
  } catch (e) {
    return { ok: false, message: `Couldn't run ${fallbackLabel(node)}: ${e}`, label: fallbackLabel(node) };
  }
}
