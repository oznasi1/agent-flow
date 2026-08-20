import { describe, it, expect, vi } from "vitest";
import { launchPlanned, LaunchDeps, LaunchRequest, LaunchTicketDetail } from "../../../../src/engine/orchestrator/launch";
import { PlannedNode } from "../../../../src/engine/orchestrator/model";
import type { ServiceRef } from "../../../../src/types";
import type { OpenRequest, OpenResult } from "../../../../src/engine/workspace";

const node = (over: Partial<PlannedNode> = {}): PlannedNode => ({
  id: "n1", kind: "planned", x: 0, y: 0, join: "any",
  ticketKey: "ASM-12", repos: ["aws-ops"], mode: "backend", dest: "new-window", ...over,
});

const detail: LaunchTicketDetail = {
  key: "ASM-12", summary: "Isolate renew queue", url: "https://jira.example/ASM-12", descriptionText: "do the thing",
};

const repos: ServiceRef[] = [
  { name: "aws-ops", path: "/repos/aws-ops", isGit: true },
  { name: "bite-me", path: "/repos/bite-me", isGit: true },
];

const makeReq = (over: Partial<LaunchRequest> = {}): LaunchRequest => ({
  node: node(),
  detail,
  repos,
  promptTemplate: "Fix {key}",
  workspaceDir: "/ws",
  seedAgent: true,
  workspaceMode: "per-window",
  agentName: "Claude Code",
  ...over,
});

const makeDeps = (over: Partial<LaunchDeps> = {}): LaunchDeps => ({
  createWorktrees: vi.fn((services: ServiceRef[]) =>
    services.map((s) => ({ ...s, path: `${s.path}/.claude/worktrees/ASM-12` })),
  ),
  openWorkspace: vi.fn(async (_req: OpenRequest): Promise<OpenResult> => ({
    mode: "per-window", briefs: [], opened: ["/w"], remoteControl: false, provider: "claude-code",
  })),
  log: vi.fn(),
  ...over,
});

describe("launchPlanned", () => {
  it("refuses when the node's ticketKey and the fetched detail's key disagree, and calls neither dep", async () => {
    // The node (what the user wired) and the detail (what the caller fetched) are two
    // independent sources of "which ticket". If a caller ever pairs them wrongly,
    // refusing costs one rule; proceeding would spend a session on the wrong ticket's
    // prompt and bind the promoted place to the wrong run, forever.
    const d = makeDeps();
    const out = await launchPlanned(makeReq({ node: node({ ticketKey: "OTHER-9" }) }), d);
    expect(out).toEqual({
      ok: false,
      message: "flow node names OTHER-9 but the ticket fetched was ASM-12 — not launching.",
    });
    expect(d.createWorktrees).not.toHaveBeenCalled();
    expect(d.openWorkspace).not.toHaveBeenCalled();
  });

  it("uses whichever ticket key node and detail agree on, not a value baked in from other fixtures", async () => {
    // Every other test in this file sets node.ticketKey and detail.key to the same
    // literal "ASM-12" — a launcher that read a hardcoded "ASM-12" (or always read
    // node.ticketKey where it should read detail.key, or vice versa) would still pass
    // every one of them. This uses an agreeing pair with a DIFFERENT shared value, so
    // the identity actually used has to flow through, not be assumed.
    const d = makeDeps();
    const altDetail: LaunchTicketDetail = { ...detail, key: "OTHER-7", summary: "Different ticket entirely" };
    const out = await launchPlanned(makeReq({ node: node({ ticketKey: "OTHER-7" }), detail: altDetail }), d);
    expect(out).toEqual({ ok: true, runKey: "OTHER-7", repo: "aws-ops" });
    const arg = (d.openWorkspace as ReturnType<typeof vi.fn>).mock.calls[0][0] as OpenRequest;
    expect(arg.ticket).toEqual({ key: "OTHER-7", summary: "Different ticket entirely", url: altDetail.url });
  });

  it("refuses a node naming no repos at all, with its own message rather than an empty-list one", async () => {
    const d = makeDeps();
    const out = await launchPlanned(makeReq({ node: node({ repos: [] }) }), d);
    expect(out).toEqual({
      ok: false,
      message: "the flow node names no repos — nothing to launch ASM-12 into.",
    });
    expect(d.createWorktrees).not.toHaveBeenCalled();
    expect(d.openWorkspace).not.toHaveBeenCalled();
  });

  it("logs the repos it drops because they aren't checked out here, and still launches with what resolved", async () => {
    const d = makeDeps();
    const out = await launchPlanned(makeReq({ node: node({ repos: ["aws-ops", "ghost-repo"] }) }), d);
    expect(out).toEqual({ ok: true, runKey: "ASM-12", repo: "aws-ops" });
    expect(d.log).toHaveBeenCalledWith(expect.stringMatching(/ghost-repo.*not checked out/));
    const arg = (d.openWorkspace as ReturnType<typeof vi.fn>).mock.calls[0][0] as OpenRequest;
    expect(arg.services).toEqual([{ name: "aws-ops", path: "/repos/aws-ops", isGit: true }]);
  });

  it("pluralizes the dropped-repos log when more than one name fails to resolve", async () => {
    const d = makeDeps();
    const out = await launchPlanned(makeReq({ node: node({ repos: ["ghost-one", "ghost-two", "aws-ops"] }) }), d);
    expect(out).toEqual({ ok: true, runKey: "ASM-12", repo: "aws-ops" });
    expect(d.log).toHaveBeenCalledWith(expect.stringMatching(/ghost-one, ghost-two.*without them/));
  });

  it("reports a failure when createWorktrees itself throws synchronously, rather than rejecting", async () => {
    const d = makeDeps({ createWorktrees: vi.fn(() => { throw new Error("git not found"); }) });
    await expect(launchPlanned(makeReq({ node: node({ dest: "worktree" }) }), d)).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining("git not found"),
    });
    expect(d.openWorkspace).not.toHaveBeenCalled();
  });

  it("launches into the resolved repo and reports the run key and repo", async () => {
    const d = makeDeps();
    const out = await launchPlanned(makeReq(), d);
    expect(out).toEqual({ ok: true, runKey: "ASM-12", repo: "aws-ops" });
    expect(d.openWorkspace).toHaveBeenCalledTimes(1);
    const arg = (d.openWorkspace as ReturnType<typeof vi.fn>).mock.calls[0][0] as OpenRequest;
    expect(arg.services).toEqual([{ name: "aws-ops", path: "/repos/aws-ops", isGit: true }]);
    expect(arg.mode).toBe("per-window");
    expect(arg.promptTemplate).toBe("Fix {key}");
    expect(arg.ticket).toEqual({ key: "ASM-12", summary: "Isolate renew queue", url: "https://jira.example/ASM-12" });
    expect(arg.openIn).toBe("new");
    expect(arg.kind).toBeUndefined();
  });

  it("refuses when the node's repos resolve to nothing on this machine, and calls neither dep", async () => {
    const d = makeDeps();
    const out = await launchPlanned(makeReq({ node: node({ repos: ["ghost-repo"] }) }), d);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain("ghost-repo");
    expect(d.createWorktrees).not.toHaveBeenCalled();
    expect(d.openWorkspace).not.toHaveBeenCalled();
  });

  it("pluralizes the refusal when several named repos all fail to resolve", async () => {
    const d = makeDeps();
    const out = await launchPlanned(makeReq({ node: node({ repos: ["ghost-one", "ghost-two"] }) }), d);
    expect(out).toEqual({
      ok: false,
      message: "ghost-one, ghost-two aren't checked out under your repos root — not launching ASM-12.",
    });
  });

  it("falls back to a placeholder plan when the ticket has no description", async () => {
    const d = makeDeps();
    await launchPlanned(makeReq({ detail: { ...detail, descriptionText: "   " } }), d);
    const arg = (d.openWorkspace as ReturnType<typeof vi.fn>).mock.calls[0][0] as OpenRequest;
    expect(arg.planMd).toContain("_(No description on the ticket.)_");
    expect(arg.planMd).not.toContain("## Ticket description");
  });

  it("dest: worktree creates a worktree and opens the worktree-mapped services", async () => {
    const d = makeDeps();
    await launchPlanned(makeReq({ node: node({ dest: "worktree" }) }), d);
    expect(d.createWorktrees).toHaveBeenCalledWith(
      [{ name: "aws-ops", path: "/repos/aws-ops", isGit: true }],
      "ASM-12",
      "Isolate renew queue",
      d.log,
    );
    const arg = (d.openWorkspace as ReturnType<typeof vi.fn>).mock.calls[0][0] as OpenRequest;
    // The whole point: openWorkspace must receive the WORKTREE-mapped services, not
    // the original checkout createWorktrees was given.
    expect(arg.services).toEqual([{ name: "aws-ops", path: "/repos/aws-ops/.claude/worktrees/ASM-12", isGit: true }]);
    expect(arg.openIn).toBe("new");
  });

  it("dest: new-window does not create a worktree", async () => {
    const d = makeDeps();
    await launchPlanned(makeReq({ node: node({ dest: "new-window" }) }), d);
    expect(d.createWorktrees).not.toHaveBeenCalled();
    const arg = (d.openWorkspace as ReturnType<typeof vi.fn>).mock.calls[0][0] as OpenRequest;
    expect(arg.openIn).toBe("new");
    expect(arg.services).toEqual([{ name: "aws-ops", path: "/repos/aws-ops", isGit: true }]);
  });

  it("dest: current-window does not create a worktree and reuses the running window", async () => {
    const d = makeDeps();
    await launchPlanned(makeReq({ node: node({ dest: "current-window" }) }), d);
    expect(d.createWorktrees).not.toHaveBeenCalled();
    const arg = (d.openWorkspace as ReturnType<typeof vi.fn>).mock.calls[0][0] as OpenRequest;
    expect(arg.openIn).toBe("current");
  });

  it("refuses rather than launching into the main checkout when createWorktrees falls back", async () => {
    // A stub that returns its input unchanged, exactly like createWorktrees's own
    // failure fallback (non-git repo, or `git worktree add` failing outright).
    const d = makeDeps({ createWorktrees: vi.fn((services: ServiceRef[]) => services) });
    const out = await launchPlanned(makeReq({ node: node({ dest: "worktree" }) }), d);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain("aws-ops");
    expect(d.openWorkspace).not.toHaveBeenCalled();
  });

  it("reports a failure from openWorkspace rather than throwing", async () => {
    const d = makeDeps({ openWorkspace: vi.fn(async () => { throw new Error("disk full"); }) });
    const out = await launchPlanned(makeReq(), d);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain("disk full");
  });

  it("passes the resolved prompt template through unchanged", async () => {
    const d = makeDeps();
    await launchPlanned(makeReq({ promptTemplate: "Investigate {key} carefully, then {summary}" }), d);
    const arg = (d.openWorkspace as ReturnType<typeof vi.fn>).mock.calls[0][0] as OpenRequest;
    expect(arg.promptTemplate).toBe("Investigate {key} carefully, then {summary}");
  });

  it("still succeeds when seedAgent is false, and forwards it rather than assuming true", async () => {
    const d = makeDeps();
    const out = await launchPlanned(makeReq({ seedAgent: false }), d);
    expect(out.ok).toBe(true);
    const arg = (d.openWorkspace as ReturnType<typeof vi.fn>).mock.calls[0][0] as OpenRequest;
    expect(arg.seedAgent).toBe(false);
  });

  it("binds the place to the first named repo that actually resolved, not literally the first name", async () => {
    const d = makeDeps();
    const out = await launchPlanned(makeReq({ node: node({ repos: ["ghost-repo", "bite-me"] }) }), d);
    expect(out).toEqual({ ok: true, runKey: "ASM-12", repo: "bite-me" });
    const arg = (d.openWorkspace as ReturnType<typeof vi.fn>).mock.calls[0][0] as OpenRequest;
    expect(arg.services).toEqual([{ name: "bite-me", path: "/repos/bite-me", isGit: true }]);
  });

  it("opens every resolved repo, not only the one it binds the place to", async () => {
    const d = makeDeps();
    const out = await launchPlanned(makeReq({ node: node({ repos: ["aws-ops", "bite-me"] }) }), d);
    expect(out).toEqual({ ok: true, runKey: "ASM-12", repo: "aws-ops" });
    const arg = (d.openWorkspace as ReturnType<typeof vi.fn>).mock.calls[0][0] as OpenRequest;
    expect(arg.services).toEqual([
      { name: "aws-ops", path: "/repos/aws-ops", isGit: true },
      { name: "bite-me", path: "/repos/bite-me", isGit: true },
    ]);
  });

  it("logs the binding decision when the node names more than one repo", async () => {
    // The comment on that log line says the choice is silent unless said out loud
    // here — deleting the call would keep every other assertion in this file green.
    const d = makeDeps();
    await launchPlanned(makeReq({ node: node({ repos: ["aws-ops", "bite-me"] }) }), d);
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining("binding the place to aws-ops"));
  });

  it("pins claude-code on the request, so an unattended rule can never reach the `ask` picker", async () => {
    // A flow rule fires with nobody watching. openWorkspace's picker is
    // `ignoreFocusOut: true`, so an unattended launch that reached it would not time
    // out — it would hang the poll loop until someone came back and answered. The pin
    // is what makes that unreachable, and it is read ONLY under `ask`: a user whose
    // setting says `cursor` still gets Cursor, because openWorkspace ignores a pin
    // under a fixed setting.
    const d = makeDeps();
    await launchPlanned(makeReq(), d);
    const arg = (d.openWorkspace as ReturnType<typeof vi.fn>).mock.calls[0][0] as OpenRequest;
    expect(arg.provider).toBe("claude-code");
  });
});
