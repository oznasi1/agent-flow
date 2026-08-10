import { describe, it, expect, vi } from "vitest";
import { COMMAND_TIMEOUT_MS, resolveCommand, runCommand } from "../../../../src/engine/orchestrator/command";
import type { CommandNode } from "../../../../src/engine/orchestrator/model";
import { LOCK_TTL_MS } from "../../../../src/engine/orchestrator/lock";

const node = (over: Partial<CommandNode> = {}): CommandNode =>
  ({ id: "c1", kind: "command", x: 0, y: 0, join: "any", ...over });

const COMMANDS = [
  { id: "deploy", label: "Deploy to staging", run: "gh workflow run deploy.yml -f env={note}" },
  { id: "plain", label: "Plain", run: "echo hi" },
  { id: "double", label: "Double", run: "deploy.sh --env={note} --tag={note}" },
];

// The flows lock (lock.ts) is held across the whole act. A command outliving
// LOCK_TTL_MS would have its own lock reaped by another window mid-flight —
// this pins the relationship against the REAL constant, not a hand-copied
// number, so a change to either side that breaks the invariant fails here
// instead of only in a production incident.
it("keeps COMMAND_TIMEOUT_MS well under the flows lock TTL", () => {
  expect(COMMAND_TIMEOUT_MS).toBeLessThan(LOCK_TTL_MS);
});

describe("resolveCommand", () => {
  it("substitutes the note into a configured command", () => {
    const r = resolveCommand(node({ commandId: "deploy" }), COMMANDS, "staging-eu");
    expect(r).toEqual({ ok: true, label: "Deploy to staging", text: "gh workflow run deploy.yml -f env=staging-eu" });
  });

  // Unlike a prompt, appending free text to a shell command changes what runs —
  // `echo hi` plus a note must never become `echo hi <note>`.
  it("never appends a note to a template with no placeholder", () => {
    const r = resolveCommand(node({ commandId: "plain" }), COMMANDS, "danger");
    expect(r).toEqual({ ok: true, label: "Plain", text: "echo hi" });
  });

  // `String.replace`'s replacement argument interprets $& and $1. A note is user
  // text and must reach the command verbatim.
  it("inserts a note containing $& and $1 verbatim", () => {
    const r = resolveCommand(node({ commandId: "deploy" }), COMMANDS, "a$&b$1c");
    expect(r).toMatchObject({ ok: true, text: "gh workflow run deploy.yml -f env=a$&b$1c" });
  });

  it("substitutes an absent note with the empty string", () => {
    expect(resolveCommand(node({ commandId: "deploy" }), COMMANDS, undefined))
      .toMatchObject({ text: "gh workflow run deploy.yml -f env=" });
  });

  it("uses a free-text command as written", () => {
    expect(resolveCommand(node({ run: "npm run deploy:staging" }), COMMANDS, "x"))
      .toEqual({ ok: true, label: "npm run deploy:staging", text: "npm run deploy:staging" });
  });

  it("refuses a node naming a command that is not configured", () => {
    const r = resolveCommand(node({ commandId: "gone" }), COMMANDS, undefined);
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toContain("gone");
  });

  it("refuses a node with neither a commandId nor a command", () => {
    expect(resolveCommand(node(), COMMANDS, undefined).ok).toBe(false);
  });

  // Both set is ambiguous, and guessing which wins would make the drawer's
  // display and what actually runs disagree.
  it("refuses a node carrying both", () => {
    expect(resolveCommand(node({ commandId: "plain", run: "rm -rf /" }), COMMANDS, undefined).ok).toBe(false);
  });

  // A template can name the same placeholder more than once (env AND tag from
  // one note, say). Every test above uses a template with exactly one {note},
  // so this is the only thing that would catch a substitution that stops after
  // the first hit and ships a literal "{note}" to the shell.
  it("substitutes every occurrence of {note}, not just the first", () => {
    const r = resolveCommand(node({ commandId: "double" }), COMMANDS, "v1");
    expect(r).toEqual({ ok: true, label: "Double", text: "deploy.sh --env=v1 --tag=v1" });
  });

  // Materially the same as having no run at all — config.ts's readCommands
  // already drops a blank run on the config side, so this side must agree
  // rather than hand an empty string to the runner.
  it("refuses a node whose run is an empty string", () => {
    const r = resolveCommand(node({ run: "" }), COMMANDS, undefined);
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toContain("blank");
  });

  it("refuses a node whose run is whitespace only", () => {
    expect(resolveCommand(node({ run: "   " }), COMMANDS, undefined).ok).toBe(false);
  });

  // A hand-edited flow file can carry a run that isn't even a string.
  // store.ts's validNode does not reject it; resolveCommand must refuse it
  // rather than crash — it is exported and callable directly by a future
  // preview (Task 9), not only from inside runCommand's try.
  it("refuses, rather than throws, when run is not a string", () => {
    const bad = node({ run: 42 as unknown as string });
    expect(() => resolveCommand(bad, COMMANDS, undefined)).not.toThrow();
    expect(resolveCommand(bad, COMMANDS, undefined).ok).toBe(false);
  });
});

describe("runCommand", () => {
  it("reports success on exit 0 and keeps the output", async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: "deployed\n", stderr: "" });
    const out = await runCommand(
      { node: node({ commandId: "plain" }), commands: COMMANDS, cwd: "/repo" },
      { run, log: () => {} },
    );
    expect(out).toMatchObject({ ok: true, code: 0, label: "Plain" });
    expect((out as { output: string }).output).toContain("deployed");
    expect(run).toHaveBeenCalledWith("echo hi", { cwd: "/repo", timeoutMs: COMMAND_TIMEOUT_MS });
  });

  it("reports failure on a non-zero exit, naming the code", async () => {
    const run = vi.fn().mockResolvedValue({ code: 3, stdout: "", stderr: "boom" });
    const out = await runCommand(
      { node: node({ commandId: "plain" }), commands: COMMANDS, cwd: "/repo" },
      { run, log: () => {} },
    );
    expect(out.ok).toBe(false);
    expect((out as { message: string }).message).toContain("3");
  });

  // The caller is a poll loop inside the Deck's own refresh. An exception here
  // would take the whole refresh down, not just this rule — the same guarantee
  // launch.ts gives, and for the same reason.
  it("never throws when the runner rejects", async () => {
    const run = vi.fn().mockRejectedValue(new Error("ENOENT"));
    const out = await runCommand(
      { node: node({ commandId: "plain" }), commands: COMMANDS, cwd: "/repo" },
      { run, log: () => {} },
    );
    expect(out.ok).toBe(false);
    expect((out as { message: string }).message).toContain("ENOENT");
  });

  it("never runs anything when the command cannot be resolved", async () => {
    const run = vi.fn();
    const out = await runCommand(
      { node: node({ commandId: "gone" }), commands: COMMANDS, cwd: "/repo" },
      { run, log: () => {} },
    );
    expect(out.ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  // "Never runs anything on a refusal" was only exercised via the unknown-id
  // path above. Both-set and neither-set refuse for a different reason each
  // (ambiguity vs. nothing to run) and must be just as inert.
  it("never runs anything for a node carrying both commandId and run", async () => {
    const run = vi.fn();
    const out = await runCommand(
      { node: node({ commandId: "plain", run: "rm -rf /" }), commands: COMMANDS, cwd: "/repo" },
      { run, log: () => {} },
    );
    expect(out.ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("never runs anything for a node with neither commandId nor run", async () => {
    const run = vi.fn();
    const out = await runCommand(
      { node: node(), commands: COMMANDS, cwd: "/repo" },
      { run, log: () => {} },
    );
    expect(out.ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  // stdout with no trailing newline must not run into stderr's first line —
  // that would corrupt both the log line and the receipt the drawer shows.
  it("joins stdout and stderr with a separator instead of concatenating them bare", async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: "deployed", stderr: "boom" });
    const out = await runCommand(
      { node: node({ commandId: "plain" }), commands: COMMANDS, cwd: "/repo" },
      { run, log: () => {} },
    );
    expect((out as { output: string }).output).toBe("deployed\nboom");
  });
});
