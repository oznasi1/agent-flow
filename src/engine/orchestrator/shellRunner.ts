// The one place a flow's command actually reaches a shell, and the only module in
// this feature that holds a process handle. Lifted out of `deckView.ts` so the
// headless tick (`src/headless/`) can run a consented command with the very same
// runner the Deck uses — same timeout contract, same kill signal, same output cap
// — without importing anything that needs an editor.
import { exec } from "child_process";
import { COMMAND_KILLED_EXIT_CODE, CommandRunner } from "./command";

/** How much of a command's captured output `exec` buffers before it kills the child.
 * `exec`'s own default is 1 MiB; stated here rather than left implicit because it is
 * a real limit on what the output channel can show for a chatty deploy, and because
 * exceeding it is one of the non-numeric failures `shellCommandRunner` has to map to
 * an exit code below. */
export const COMMAND_MAX_OUTPUT_BYTES = 1024 * 1024;

/** `child_process.exec`, deliberately, not `spawn`: `exec` takes a `timeout` option
 * and Node arms that timer itself, sending `killSignal` to the child when it
 * expires. That is what makes `CommandRunner`'s timeout a real contract instead of
 * a number passed around — `command.ts` awaits this promise unconditionally and adds
 * no `Promise.race` (see its own doc comment on why a caller-side race would trade a
 * hung pass for a silently orphaned process), so a runner that never settled would
 * hold the flows-directory lock for the life of the extension host and stall every
 * other window's Deck refresh. A `spawn` with a hand-rolled timer would have to
 * reimplement exactly this and could get it wrong; `exec` cannot forget.
 *
 * `SIGKILL`, not the default `SIGTERM`: a deploy script that traps or ignores TERM
 * would otherwise keep running past its own deadline while the runner reported it
 * killed.
 *
 * Never rejects. Every failure — a non-zero exit, a timeout kill, a shell that could
 * not even start, more output than `maxBuffer` holds — resolves as a `code`/`stdout`/
 * `stderr` triple, because the caller is a poll loop inside the Deck's refresh and
 * `runCommand`'s "never throws" guarantee is worth more than a distinction between
 * kinds of failure that all end the same way: the rule latches with an error. */
export const shellCommandRunner: CommandRunner = (command, opts) =>
  new Promise((resolve) => {
    exec(
      command,
      {
        cwd: opts.cwd,
        // The contract. Node kills the child here; nothing else in this feature can.
        timeout: opts.timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: COMMAND_MAX_OUTPUT_BYTES,
        // Pins the string-typed `exec` overload as well as the decoding: a Buffer
        // pair would satisfy `CommandRunner`'s types only after a cast, and the
        // output is going straight into a log channel and a receipt.
        encoding: "utf8",
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr });
        // A number means the command chose it: an ordinary failing exit, and the
        // most common case by far. Nothing to explain — the code IS the reason.
        if (typeof err.code === "number") return resolve({ code: err.code, stdout, stderr });
        // A STRING code is one of Node's own (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`,
        // `ENOENT` for a shell that isn't there). The command never got to report
        // anything, so the message is the only evidence there is.
        if (typeof err.code === "string") return resolve({ code: 1, stdout, stderr: withReason(stderr, err.message) });
        // No code at all and a signal: this is the timeout kill above (or a kill
        // from outside). Reported as `COMMAND_KILLED_EXIT_CODE`, which `command.ts`
        // owns precisely so it can turn it into a receipt that names the deadline —
        // the reason line below reaches the output channel, but the edge's `error`
        // is built from the code.
        if (err.killed || err.signal) {
          return resolve({
            code: COMMAND_KILLED_EXIT_CODE,
            stdout,
            stderr: withReason(stderr, `killed by ${err.signal ?? "signal"} — it did not finish within ${opts.timeoutMs} ms.`),
          });
        }
        return resolve({ code: 1, stdout, stderr: withReason(stderr, err.message) });
      },
    );
  });

/** Append the runner's own explanation to whatever the command managed to write,
 * on its own line. Joined rather than concatenated for the same reason
 * `runCommand` joins stdout and stderr: a partial last line with no newline would
 * otherwise run straight into the reason ("Deploying…killed by SIGKILL"). */
function withReason(stderr: string, reason: string): string {
  return stderr.length > 0 ? `${stderr}\n${reason}` : reason;
}
