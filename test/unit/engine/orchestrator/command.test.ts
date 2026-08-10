import { describe, it, expect, vi } from "vitest";
import { COMMAND_TIMEOUT_MS, resolveCommand, runCommand } from "../../../../src/engine/orchestrator/command";
import type { CommandNode } from "../../../../src/engine/orchestrator/model";

const node = (over: Partial<CommandNode> = {}): CommandNode =>
  ({ id: "c1", kind: "command", x: 0, y: 0, join: "any", ...over });

const COMMANDS = [
  { id: "deploy", label: "Deploy to staging", run: "gh workflow run deploy.yml -f env={note}" },
  { id: "plain", label: "Plain", run: "echo hi" },
];

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
});
