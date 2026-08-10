// Resolve a command node's shell command and run it. This is the file Task 6's
// wiring will call from the Deck's poll loop; it does not touch the panel or the
// webview itself.
//
// No `vscode`, no `child_process` — this directory is webview-reachable, and only
// `npm run build` catches such an import (`tsc` and the tests pass regardless).
// The actual process spawn is an injected `CommandRunner`, the same posture
// `launch.ts` takes with `openWorkspace`.
import { findNode, incomingEdges, isPlace } from "./model";
import type { CommandNode, Flow, PlaceNode } from "./model";
import type { FlowCommand } from "../../types";

/** 120 s. Must stay well under `LOCK_TTL_MS` (300 s, `lock.ts`): the flows lock is
 * held across the whole act, and a command outliving the TTL would have its own
 * lock reaped by another window while the command is still running — the same
 * hazard `LOCK_TTL_MS`'s own comment describes for a launch or a seed. Pinned by
 * a test against the real `LOCK_TTL_MS` (not a hand-copied number) so the two
 * cannot drift silently. */
export const COMMAND_TIMEOUT_MS = 120_000;

/** The exit code a `CommandRunner` MUST report for a command it had to KILL rather
 * than one that chose its own code — `timeout(1)`'s convention, so it reads as what
 * it is to anyone who has met a CI timeout.
 *
 * Part of the runner contract, not one runner's private detail, and that is why it
 * lives here: `runCommand` below turns this code into the sentence the drawer's
 * receipt shows, so the two cannot be defined in separate files and drift. A command
 * that genuinely exits 124 by itself is described the same way, which is why the
 * message names what the code MEANS here rather than asserting which of the two
 * happened — the output channel has the runner's own reason line. */
export const COMMAND_KILLED_EXIT_CODE = 124;

/** Spawns `command` in `opts.cwd` and resolves with its exit code and captured
 * stdout/stderr. `opts.timeoutMs` is a CONTRACT, not a hint: the runner MUST
 * enforce it itself — kill the child at (or shortly after) that many
 * milliseconds and resolve rather than hang. `runCommand` below holds no
 * process handle of its own and has no way to enforce this from the outside;
 * if a runner ignores `timeoutMs` (a `spawn` with no timeout wired up, or one
 * whose own timer silently fails), the `await` in `runCommand` never settles,
 * and the flows lock that pass is holding is held for the life of the
 * process — not just the 120 s ceiling `COMMAND_TIMEOUT_MS` promises. This
 * module deliberately does NOT add its own `Promise.race` backstop: a race can
 * only unblock the CALLER, not the child, so on a misbehaving runner it would
 * trade a hung pass for a silently orphaned process that keeps running (and
 * possibly still writing into `opts.cwd`) after `runCommand` has already told
 * everyone it failed. That is a worse failure to debug than a hung pass, which
 * at least fails loudly (the flows lock stays visibly held). The fix for a
 * runner that cannot honor its own timeout belongs in the runner. */
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

/** Substitute EVERY `{note}` occurrence slice-by-slice. NEVER `String.replace`:
 * its replacement argument interprets `$&`, `$1` and friends, and a note is
 * user text that must reach the shell exactly as typed.
 *
 * A template with no `{note}` gets NOTHING appended, which is where this differs
 * from `composeAgentPrompt` (`prompt.ts`). Appending stray words to a prompt adds
 * context; appending them to a shell command changes what executes.
 *
 * Splicing is unquoted and untouched otherwise: `note` lands in the command
 * string verbatim, so a template like `deploy.sh --env={note}` with a note of
 * `prod; rm -rf ~` produces a string carrying both commands. That is inherent
 * to letting a user type a free-text command at all — this module does not
 * remove it, because doing so would mean rewriting or rejecting the user's own
 * shell syntax — but it means quoting is the TEMPLATE AUTHOR'S job, and even
 * `--env="{note}"` does not neutralise a `"` inside the note. See the
 * `agentFlow.commands` setting's description, which is the only place a user
 * configuring a command actually reads this. */
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

/** The place a rule leaving `fromId` inherits its working directory from —
 * walking BACK through a chain of command nodes to reach it.
 *
 * A rule out of a place answers itself: that place is the source. A rule out of a
 * COMMAND node is the shape this function exists for, and it is the feature's own
 * headline example: `place -> deploy.sh -> smoke.sh`, "deploy, then smoke test".
 * `command-succeeded` is the default and only condition a picker offers off a
 * command node, so it is the shape the UI steers users into — and a command node
 * is not a place, so without this walk the second command had no directory at all
 * and its rule stalled invisibly on every pass.
 *
 * Depth-first over `incomingEdges` (flow order), so the answer is deterministic
 * for a command node fed by several rules — the same reason `incomingEdges`
 * documents its own ordering. It deliberately does NOT prefer the edge that
 * actually performed: the directory is a property of the CHAIN's root, and every
 * incoming edge of a command node comes from the same side of the graph in every
 * shape a picker can build.
 *
 * `visited` is not defensive tidiness: `tidy()` bounds its own relaxation because
 * the drawer can hold a cycle, and a cycle of command nodes would otherwise
 * recurse until the stack gave out — inside the Deck's poll loop, holding the
 * flows lock.
 *
 * `undefined` when no place is reachable: a chain rooted at planned work, at a
 * node of a kind this build does not know, or at nothing at all. The caller must
 * REFUSE such a rule rather than retry it — see `commandCwd` in deckView.ts. */
export function chainSourcePlace(flow: Flow, fromId: string): PlaceNode | undefined {
  const visited = new Set<string>();
  const walk = (id: string): PlaceNode | undefined => {
    if (visited.has(id)) return undefined;
    visited.add(id);
    const node = findNode(flow, id);
    if (!node) return undefined;
    if (isPlace(node)) return node;
    // Only a command node is walked THROUGH. A planned node has no run yet and a
    // notify terminal has no out-port, so neither can stand between a command and
    // the checkout it should run in.
    if (node.kind !== "command") return undefined;
    for (const e of incomingEdges(flow, id)) {
      const found = walk(e.from);
      if (found) return found;
    }
    return undefined;
  };
  return walk(fromId);
}

/** True for a usable string: present, and non-empty once whitespace is
 * stripped. Guards the RUNTIME type, not just presence — a hand-edited flow
 * file can carry `"run": 42`, `"run": ""`, or `"run": "   "`, and `store.ts`'s
 * `validNode` rejects none of that. `resolveCommand` is exported and callable
 * directly (a future "what would run" preview is the likely caller — see
 * Task 9), so it must refuse such input rather than crash on it (a bare
 * `as string` cast used to send a non-string into `withNote`'s `.indexOf`) or
 * treat blank text as a real command to hand to the runner. Same predicate as
 * `prompt.ts`'s `hasNote`, restated here rather than imported — one boolean
 * check does not justify coupling this module to `prompt.ts`. */
function isUsableText(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/** The label to show when a node can't even be resolved enough to have a real
 * one — the drawer or a log line still needs SOMETHING to name the rule by.
 * Deliberately permissive (no `isUsableText` guard): this is display-only text
 * interpolated into a template string, never passed to anything string-typed
 * that would throw on a non-string, so it is safe even for a hand-edited
 * node's `run: 42`. */
function fallbackLabel(node: CommandNode): string {
  return node.commandId ?? node.run ?? "command";
}

/** Resolve a command node to the text that will actually run. Refuses rather
 * than guesses on every ambiguous or incomplete shape:
 * - a `commandId` naming nothing configured,
 * - a node with neither a usable `commandId` nor a usable `run`,
 * - a node whose `run` is present but blank (empty or whitespace-only, or —
 *   on a hand-edited flow file — not even a string): materially the same as
 *   having no `run` at all, and `config.ts`'s `readCommands` already treats a
 *   blank `run` as absent on the config side, so this side must agree,
 * - and a node with BOTH a usable `commandId` and a usable `run` (picking one
 *   would make the drawer's display and what executes disagree, which is the
 *   failure mode this whole feature exists to remove). */
export function resolveCommand(
  node: CommandNode,
  commands: FlowCommand[],
  note?: string,
): { ok: true; label: string; text: string } | { ok: false; message: string } {
  const hasId = isUsableText(node.commandId);
  const hasRun = isUsableText(node.run);

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

  if (isUsableText(node.run)) {
    // The label is the SUBSTITUTED text, not the template. A free-text node has no
    // human name of its own, so its label is only ever used to say what ran — and
    // `deploy.sh --env={note}` is not what ran. The drawer's receipt is the one
    // downstream reader of this ("ran <label> in <repo>"), and with the template
    // there, a `staging` deploy and a `prod` deploy leave byte-identical receipts:
    // only the output channel would know which happened. A configured command keeps
    // its configured `label` instead — that one IS a human name, chosen by whoever
    // wrote the setting, and the drawer showing "Deploy staging" is the point of
    // configuring it.
    const text = withNote(node.run, note ?? "");
    return { ok: true, label: text, text };
  }

  if (node.run !== undefined) {
    return { ok: false, message: "command node's run is blank — nothing to execute." };
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
    // `timeoutMs` is passed as DATA to the injected runner; see CommandRunner's
    // doc comment for why enforcing it is entirely the runner's job, not
    // something this call can add a backstop for.
    const { code, stdout, stderr } = await deps.run(resolved.text, { cwd, timeoutMs: COMMAND_TIMEOUT_MS });
    // Joined with a newline, not concatenated bare: stdout with no trailing
    // newline would otherwise run into stderr's first line in both the log and
    // the receipt the drawer shows ("deployed" + "boom" -> "deployedboom").
    const output = [stdout, stderr].filter((s) => s.length > 0).join("\n");
    deps.log(output);

    if (code === 0) {
      return { ok: true, code: 0, label: resolved.label, output };
    }
    // A killed command says so IN THE MESSAGE, because the message is what gets
    // stamped on the edge as `error` and shown in the drawer. The runner writes its
    // reason to stderr, which reaches the output channel — but a user looking at a
    // stalled rule sees only this sentence, and "exited with code 124" alone tells
    // them nothing about a deadline they never chose.
    if (code === COMMAND_KILLED_EXIT_CODE) {
      return {
        ok: false,
        message:
          `"${resolved.label}" exited with code ${code} — the code reported for a command killed after ` +
          `${COMMAND_TIMEOUT_MS} ms without finishing.`,
        label: resolved.label,
        output,
      };
    }
    return { ok: false, message: `"${resolved.label}" exited with code ${code}.`, label: resolved.label, output };
  } catch (e) {
    return { ok: false, message: `Couldn't run ${fallbackLabel(node)}: ${e}`, label: fallbackLabel(node) };
  }
}
