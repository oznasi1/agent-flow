import { describe, it, expect, vi } from "vitest";
import { COMMAND_KILLED_EXIT_CODE, COMMAND_TIMEOUT_MS, chainSourcePlace, commandIdFrom, resolveCommand, runCommand, withSavedCommand } from "../../../../src/engine/orchestrator/command";
import { emptyFlow } from "../../../../src/engine/orchestrator/model";
import type { CommandNode, Flow, FlowEdge, FlowNode } from "../../../../src/engine/orchestrator/model";
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

  // A free-text node has no human name of its own, so its label exists only to say
  // WHAT RAN — and the template is not what ran. With the raw `run` as the label,
  // a `staging` deploy and a `prod` deploy leave byte-identical receipts on the
  // edge ("ran deploy.sh --env={note}"), and only the output channel knows which
  // actually happened. The drawer's receipt is this feature's one downstream
  // reader, so label and text must agree here.
  it("labels a free-text command with the SUBSTITUTED text, not the template", () => {
    expect(resolveCommand(node({ run: "deploy.sh --env={note}" }), COMMANDS, "prod"))
      .toEqual({ ok: true, label: "deploy.sh --env=prod", text: "deploy.sh --env=prod" });
  });

  // The mirror: a CONFIGURED command keeps its configured label, which is a human
  // name somebody chose in settings — "Deploy to staging" is the point of
  // configuring one, and substituting the text there would throw it away.
  it("keeps a configured command's own label rather than its substituted text", () => {
    const r = resolveCommand(node({ commandId: "deploy" }), COMMANDS, "prod");
    expect(r).toMatchObject({ label: "Deploy to staging" });
    expect((r as { label: string; text: string }).label).not.toBe((r as { text: string }).text);
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

  // The exit code a runner reports for a command it had to kill. The stamped
  // `error` is all a user looking at a stalled rule sees — the runner's own reason
  // line goes to the output channel, which the drawer does not show — so the
  // deadline has to be in the MESSAGE, not only in the code.
  it("names the timeout in the message for the killed exit code", async () => {
    const run = vi.fn().mockResolvedValue({ code: COMMAND_KILLED_EXIT_CODE, stdout: "started…", stderr: "" });
    const out = await runCommand(
      { node: node({ commandId: "plain" }), commands: COMMANDS, cwd: "/repo" },
      { run, log: () => {} },
    );
    expect(out.ok).toBe(false);
    const message = (out as { message: string }).message;
    expect(message).toContain(String(COMMAND_KILLED_EXIT_CODE));
    expect(message).toContain(String(COMMAND_TIMEOUT_MS));
    expect(message).toContain("killed");
  });

  it("says nothing about a timeout for an ordinary non-zero exit", async () => {
    // The kill sentence must not leak onto every failure: a script that exits 1 was
    // not killed, and telling the user it missed a deadline would be a fabrication.
    const run = vi.fn().mockResolvedValue({ code: 1, stdout: "", stderr: "boom" });
    const out = await runCommand(
      { node: node({ commandId: "plain" }), commands: COMMANDS, cwd: "/repo" },
      { run, log: () => {} },
    );
    expect((out as { message: string }).message).not.toContain("killed");
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

describe("chainSourcePlace", () => {
  const place = (id: string, runKey = "ASM-1", repo = "aws-ops"): FlowNode =>
    ({ id, kind: "place", x: 0, y: 0, join: "any", runKey, repo });
  const cmd = (id: string): FlowNode => ({ id, kind: "command", x: 0, y: 0, join: "any", run: "x" });
  const edge = (id: string, from: string, to: string): FlowEdge =>
    ({ id, from, to, cond: { kind: "command-succeeded" } });
  const flow = (nodes: FlowNode[], edges: FlowEdge[]): Flow =>
    ({ ...emptyFlow("f1", "f", 0), nodes, edges });

  it("answers a place source with that place", () => {
    const f = flow([place("n1"), cmd("n2")], [edge("e1", "n1", "n2")]);
    expect(chainSourcePlace(f, "n1")?.id).toBe("n1");
  });

  it("walks back through a command node to the place at the head of the chain", () => {
    // `place -> deploy.sh -> smoke.sh`: the second command's rule leaves n2, which
    // is not a place, and inherits n1's checkout.
    const f = flow(
      [place("n1"), cmd("n2"), cmd("n3")],
      [edge("e1", "n1", "n2"), edge("e2", "n2", "n3")],
    );
    expect(chainSourcePlace(f, "n2")?.id).toBe("n1");
  });

  it("walks back through several command nodes", () => {
    const f = flow(
      [place("n1"), cmd("n2"), cmd("n3"), cmd("n4")],
      [edge("e1", "n1", "n2"), edge("e2", "n2", "n3"), edge("e3", "n3", "n4")],
    );
    expect(chainSourcePlace(f, "n4")?.id).toBe("n1");
  });

  it("takes the first place in flow order when no incoming edge names a performer", () => {
    // Deterministic for the same reason `incomingEdges` documents its own order: an
    // unattended deploy must not change directory between passes. This is the
    // FALLBACK — see the performer case below.
    const f = flow(
      [place("n1", "ASM-1", "aws-ops"), place("n9", "ASM-9", "web"), cmd("n2")],
      [edge("e1", "n1", "n2"), edge("e2", "n9", "n2")],
    );
    expect(chainSourcePlace(f, "n2")?.id).toBe("n1");
  });

  it("prefers the source of the edge that actually PERFORMED the command", () => {
    // Two places into one command node is an ordinary two-wire build — `finishWire`
    // refuses only a duplicate (from, to) pair, and "when either merges, deploy" is
    // a natural thing to draw — so the two roots are DIFFERENT checkouts. Taking
    // whichever sorted first meant a chained `smoke.sh` could run in the branch that
    // never fired: unattended shell in a checkout the user did not intend.
    const f = flow(
      [place("n1", "ASM-1", "aws-ops"), place("n9", "ASM-9", "web"), cmd("n2")],
      // e2 is second in flow order AND is the one that ran, so flow order and the
      // performer disagree — which is what makes this fixture discriminating.
      [edge("e1", "n1", "n2"), { ...edge("e2", "n9", "n2"), firedAt: 5, performed: true }],
    );
    expect(chainSourcePlace(f, "n2")?.id).toBe("n9");
    expect(chainSourcePlace(f, "n2")?.repo).toBe("web");
  });

  it("falls back to flow order when the performer's own branch reaches no place", () => {
    // The preference is an ordering, not a veto: a performer whose source cannot
    // resolve must not shadow a sibling that can, or a resolvable chain would refuse.
    const planned: FlowNode = {
      id: "n0", kind: "planned", x: 0, y: 0, join: "any",
      ticketKey: "ASM-2", repos: ["aws-ops"], mode: "tdd", dest: "worktree",
    };
    const f = flow(
      [planned, place("n1", "ASM-1", "aws-ops"), cmd("n2")],
      [edge("e1", "n1", "n2"), { ...edge("e2", "n0", "n2"), firedAt: 5, performed: true }],
    );
    expect(chainSourcePlace(f, "n2")?.id).toBe("n1");
  });

  it("answers nothing for a chain rooted in planned work", () => {
    // A planned node has no run, so there is no checkout to inherit — the caller
    // must refuse such a rule rather than guess one.
    const planned: FlowNode = {
      id: "n0", kind: "planned", x: 0, y: 0, join: "any",
      ticketKey: "ASM-2", repos: ["aws-ops"], mode: "tdd", dest: "worktree",
    };
    const f = flow([planned, cmd("n2")], [edge("e1", "n0", "n2")]);
    expect(chainSourcePlace(f, "n2")).toBeUndefined();
  });

  it("answers nothing for a command node with no incoming edge, or a missing node", () => {
    const f = flow([cmd("n2")], []);
    expect(chainSourcePlace(f, "n2")).toBeUndefined();
    expect(chainSourcePlace(f, "nope")).toBeUndefined();
  });

  it("terminates on a cycle of command nodes instead of recursing forever", () => {
    // The drawer can hold a cycle — `tidy()` bounds its own relaxation for exactly
    // this reason — and this walk runs inside the poll loop, holding the flows lock.
    const f = flow(
      [cmd("n2"), cmd("n3")],
      [edge("e1", "n2", "n3"), edge("e2", "n3", "n2")],
    );
    expect(chainSourcePlace(f, "n3")).toBeUndefined();
  });

  it("still reaches the place when a cycle hangs off the chain", () => {
    // Visited-marking must not swallow the branch that does resolve.
    const f = flow(
      [place("n1"), cmd("n2"), cmd("n3"), cmd("n4")],
      [edge("e1", "n3", "n2"), edge("e2", "n2", "n3"), edge("e3", "n1", "n3"), edge("e4", "n3", "n4")],
    );
    expect(chainSourcePlace(f, "n4")?.id).toBe("n1");
  });
});

// Saving a free-text command into `agentFlow.commands` (the drawer's Save-to-
// settings row). Pure on purpose: the host half is one `update()` call, and
// everything that could get a user's settings file wrong lives here.
describe("commandIdFrom", () => {
  it("slugs a label into something a node can store and a human can read", () => {
    expect(commandIdFrom("Deploy to staging", new Set())).toBe("deploy-to-staging");
    expect(commandIdFrom("Smoke test (staging!)", new Set())).toBe("smoke-test-staging");
  });

  it("trims the punctuation it would otherwise leave dangling at either end", () => {
    expect(commandIdFrom("— deploy —", new Set())).toBe("deploy");
  });

  it("falls back to a generic id rather than an empty one", () => {
    // A label of pure punctuation is still a label the user chose. An empty id is
    // an entry `readCommands` drops on sight, so the save would silently do nothing.
    expect(commandIdFrom("…", new Set())).toBe("command");
    expect(commandIdFrom("", new Set())).toBe("command");
  });

  it("suffixes from -2, because the bare id is the first one", () => {
    expect(commandIdFrom("Deploy", new Set(["deploy"]))).toBe("deploy-2");
    expect(commandIdFrom("Deploy", new Set(["deploy", "deploy-2"]))).toBe("deploy-3");
    // Including the generic fallback, which two unnameable labels would collide on.
    expect(commandIdFrom("…", new Set(["command"]))).toBe("command-2");
  });
});

describe("withSavedCommand", () => {
  it("appends the command with a slugged id, leaving the existing entries untouched", () => {
    const existing = [{ id: "smoke", label: "Smoke", run: "npm run smoke" }];
    const out = withSavedCommand(existing, "deploy.sh --env=staging", "Deploy to staging");
    expect(out).toEqual({
      kind: "added",
      command: { id: "deploy-to-staging", label: "Deploy to staging", run: "deploy.sh --env=staging" },
      entries: [existing[0], { id: "deploy-to-staging", label: "Deploy to staging", run: "deploy.sh --env=staging" }],
    });
    // The caller writes `entries` back to settings, so an accidental mutation of
    // the user's own array is a corrupted settings.json rather than a stale read.
    expect(existing).toHaveLength(1);
  });

  it("preserves entries it cannot understand, rather than sanitizing them away", () => {
    // Straight off `inspect()`, so a hand-edited file can hold anything. A save
    // must ADD a line; rewriting the array through a validator would silently
    // delete whatever the user is midway through typing.
    const junk = [42, { label: "no run" }, null];
    const out = withSavedCommand(junk, "echo hi", "Hi");
    expect(out.kind).toBe("added");
    if (out.kind !== "added") return;
    expect(out.entries.slice(0, 3)).toEqual(junk);
  });

  it("trims both halves before storing them", () => {
    const out = withSavedCommand([], "  deploy.sh  ", "  Deploy  ");
    expect(out).toMatchObject({ kind: "added", command: { label: "Deploy", run: "deploy.sh", id: "deploy" } });
  });

  it("refuses a save with no name or nothing to run", () => {
    expect(withSavedCommand([], "deploy.sh", "   ")).toEqual({ kind: "invalid" });
    expect(withSavedCommand([], "   ", "Deploy")).toEqual({ kind: "invalid" });
  });

  it("reports a command it already holds instead of saving a second copy", () => {
    // Matched on the COMMAND, not the name: two names for one command line is how
    // a picker fills with entries that do the same thing.
    const out = withSavedCommand(
      [{ id: "d", label: "Deploy to staging", run: "deploy.sh --env=staging" }],
      "  deploy.sh --env=staging  ",
      "Ship it",
    );
    expect(out).toEqual({ kind: "duplicate", duplicateLabel: "Deploy to staging" });
  });

  it("names a duplicate by its id when the entry has no label", () => {
    const out = withSavedCommand([{ id: "d", run: "deploy.sh" }], "deploy.sh", "Ship it");
    expect(out).toEqual({ kind: "duplicate", duplicateLabel: "d" });
  });

  it("does not reuse an id an existing entry already holds", () => {
    // Two commands sharing an id is one command as far as `readCommands` is
    // concerned — it drops the second — so the save would look like it worked and
    // then not be there.
    const out = withSavedCommand(
      [{ id: "deploy", label: "Deploy", run: "old.sh" }],
      "new.sh",
      "Deploy",
    );
    expect(out).toMatchObject({ kind: "added", command: { id: "deploy-2", run: "new.sh" } });
  });

  it("counts a malformed entry's id as taken, since the file still holds it", () => {
    const out = withSavedCommand([{ id: "deploy" }], "new.sh", "Deploy");
    expect(out).toMatchObject({ kind: "added", command: { id: "deploy-2" } });
  });
});
