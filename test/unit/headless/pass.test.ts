import { describe, it, expect, vi } from "vitest";
import * as path from "path";
import { commandCwd, PassDeps, runHeadlessPass } from "../../../src/headless/pass";
import { FlowIo, writeFlow } from "../../../src/engine/orchestrator/store";
import { LockIo, lockPath } from "../../../src/engine/orchestrator/lock";
import { JournalIo, appendEvent, readJournal } from "../../../src/engine/orchestrator/journal";
import { Flow, FlowEdge, FlowNode, emptyFlow } from "../../../src/engine/orchestrator/model";
import { PrEntryMap, PrFacts, RepoGit, Run, RunStatus } from "../../../src/types";

const NOW = 1_800_000_000_000;
const DIR = "/store/flows";

const facts = (state: "OPEN" | "MERGED"): PrFacts => ({
  number: 1, url: "u", title: "t", state, isDraft: false,
  ci: { passing: 2, pending: 0, failing: [] }, review: "none", unresolved: null, mergeable: "clean", ciAdvisory: false,
});
const status = (key: string, merged: boolean, repo = "aws-ops"): RunStatus => {
  const git: RepoGit = { name: repo, path: `/r/${repo}`, branch: "b", dirty: false, ahead: 0, added: 0, removed: 0, files: 0 };
  const run: Run = { key, summary: "s", url: `https://j/browse/${key}`, createdAt: 1, mode: "multiroot",
    repos: [{ name: repo, path: `/r/${repo}`, isGit: true }], briefPaths: [] };
  const prs: PrEntryMap = { [repo]: { facts: facts(merged ? "MERGED" : "OPEN"), fetchedAt: NOW } };
  return { run, column: "progress", ticketStatus: null, ticketCategory: null, repos: [git],
    agent: { state: "working", lastActivityMs: NOW, slug: null }, windowOpen: false, prs, agents: [], shelf: "board" };
};

const place = (id: string, runKey: string): FlowNode => ({ id, kind: "place", x: 0, y: 0, join: "any", runKey, repo: "aws-ops" });
const notify = (id: string, message: string): FlowNode => ({ id, kind: "notify", x: 0, y: 0, join: "any", message });
const command = (id: string, run: string, cwdRepo?: string): FlowNode => ({ id, kind: "command", x: 0, y: 0, join: "any", run, ...(cwdRepo ? { cwdRepo } : {}) });
const planned = (id: string): FlowNode => ({ id, kind: "planned", x: 0, y: 0, join: "any", ticketKey: "PROJ-12", repos: ["aws-ops"], mode: "tdd", dest: "worktree" });
const edge = (id: string, from: string, to: string, over: Partial<FlowEdge> = {}): FlowEdge => ({ id, from, to, cond: { kind: "pr-merged" }, ...over });

/** In-memory flows, lock and journal — the same fakes the store, lock and journal
 * suites use, sharing one `files` map so the pass sees its own writes. */
const world = (flows: Flow[]) => {
  const files: Record<string, string> = {};
  const flowIo: FlowIo = {
    readDir: (dir) => Object.keys(files).filter((p) => p.startsWith(dir + "/") && p.endsWith(".json")).map((p) => path.basename(p)),
    readFile: (p) => files[p] ?? null,
    writeFile: (p, text) => { files[p] = text; },
    remove: (p) => { delete files[p]; },
  };
  const lockIo: LockIo = {
    tryCreate: (p, text) => { if (p in files) return false; files[p] = text; return true; },
    read: (p) => files[p] ?? null,
    remove: (p) => { delete files[p]; },
  };
  const journalIo: JournalIo = {
    append: (p, text) => { files[p] = (files[p] ?? "") + text; },
    size: (p) => (p in files ? files[p].length : null),
    readFile: (p) => files[p] ?? null,
    replace: (p, text) => { files[p] = text; },
  };
  for (const f of flows) writeFlow(flowIo, DIR, f);
  const runner = vi.fn(async (_cmd: string, _opts: { cwd: string; timeoutMs: number }) => ({ code: 0, stdout: "DEPLOYED\n", stderr: "" }));
  const flowsNow = () => JSON.parse(files[path.join(DIR, "f1.json")]) as Flow;
  const events = () => readJournal(journalIo, DIR, "f1");
  const deps = (over: Partial<PassDeps> = {}): PassDeps => ({
    flowIo, lockIo, journalIo, flowsDir: DIR,
    statuses: [status("PROJ-1", true)],
    settings: { commands: [], neverAutoRun: [], commandConsent: "flow" },
    run: runner,
    discoverRepo: () => undefined,
    nowMs: NOW, now: () => NOW + 1, log: () => {}, dryRun: false, token: "t1",
    ...over,
  });
  return { files, flowIo, lockIo, journalIo, runner, flowsNow, events, deps };
};

const armed = (nodes: FlowNode[], edges: FlowEdge[], over: Partial<Flow> = {}): Flow =>
  ({ ...emptyFlow("f1", "Ship the migration", 0), armed: true, nodes, edges, ...over });

describe("runHeadlessPass — notify", () => {
  it("fires a met notify rule: stamps it, journals it, and reports the line the Deck would have toasted", async () => {
    const w = world([armed([place("n1", "PROJ-1"), notify("n2", "the migration has landed")], [edge("e1", "n1", "n2")])]);
    const r = await runHeadlessPass(w.deps());
    expect(r.lock).toBe("held");
    expect(r.flows[0].notified).toEqual(["Ship the migration: the migration has landed"]);
    expect(w.flowsNow().edges[0].firedAt).toBe(NOW);
    expect(w.events().map((e) => e.kind)).toEqual(["fired"]);
    // The lock is released afterwards.
    expect(w.files[lockPath(DIR)]).toBeUndefined();
  });

  it("does nothing for a disarmed flow or an unmet rule", async () => {
    const w = world([armed([place("n1", "PROJ-1"), notify("n2", "m")], [edge("e1", "n1", "n2")])]);
    const r = await runHeadlessPass(w.deps({ statuses: [status("PROJ-1", false)] }));
    expect(r.flows[0].fired).toEqual([]);
    expect(w.flowsNow().edges[0].firedAt).toBeUndefined();
    expect(w.events()).toEqual([]);
  });
});

describe("runHeadlessPass — run", () => {
  const cmdFlow = (over: Partial<Flow> = {}) =>
    armed([place("n1", "PROJ-1"), command("n2", "deploy.sh staging")], [edge("e1", "n1", "n2")], over);

  it("runs a consented command in the source place's checkout, stamps and journals it with its output", async () => {
    const w = world([cmdFlow({ commandConfirmedAt: 5 })]);
    const r = await runHeadlessPass(w.deps());
    expect(w.runner).toHaveBeenCalledWith("deploy.sh staging", expect.objectContaining({ cwd: "/r/aws-ops" }));
    expect(r.flows[0].fired[0]).toMatch(/ran deploy\.sh staging in aws-ops/);
    expect(w.flowsNow().edges[0].firedAt).toBe(NOW);
    expect(w.events()[0]).toMatchObject({ kind: "fired", action: "run", output: "DEPLOYED\n" });
  });

  it("leaves an UNCONSENTED command pending, says so, and never asks or invents an approval", async () => {
    const w = world([cmdFlow()]);
    const r = await runHeadlessPass(w.deps());
    expect(w.runner).not.toHaveBeenCalled();
    expect(r.flows[0].needsConsent).toEqual(['e1 (n1 → n2, run): "deploy.sh staging"']);
    expect(w.flowsNow().edges[0].firedAt).toBeUndefined();
    expect(w.flowsNow().commandConfirmedAt).toBeUndefined();
    expect(w.events()).toEqual([]);
  });

  it("under per-command consent, runs a covered text and counts the run against a bounded approval", async () => {
    const w = world([cmdFlow({ commandConsents: { "deploy.sh staging": { at: 1, remaining: 2 } } })]);
    await runHeadlessPass(w.deps({ settings: { commands: [], neverAutoRun: [], commandConsent: "command" } }));
    expect(w.runner).toHaveBeenCalledTimes(1);
    expect(w.flowsNow().commandConsents!["deploy.sh staging"].remaining).toBe(1);
  });

  it("under per-command consent, a flow-level stamp does not cover the run", async () => {
    const w = world([cmdFlow({ commandConfirmedAt: 5 })]);
    const r = await runHeadlessPass(w.deps({ settings: { commands: [], neverAutoRun: [], commandConsent: "command" } }));
    expect(w.runner).not.toHaveBeenCalled();
    expect(r.flows[0].needsConsent).toHaveLength(1);
  });

  it("a denylisted command is refused before consent is even consulted, and latches errored", async () => {
    const w = world([cmdFlow({ commandConfirmedAt: 5 })]);
    const r = await runHeadlessPass(w.deps({ settings: { commands: [], neverAutoRun: ["deploy*"], commandConsent: "flow" } }));
    expect(w.runner).not.toHaveBeenCalled();
    expect(w.flowsNow().edges[0].error).toMatch(/neverAutoRun/);
    expect(r.flows[0].errored).toHaveLength(1);
    expect(w.events()[0].kind).toBe("errored");
  });

  it("a failing command latches errored with its output journaled", async () => {
    const w = world([cmdFlow({ commandConfirmedAt: 5 })]);
    w.runner.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "boom" });
    const r = await runHeadlessPass(w.deps());
    expect(w.flowsNow().edges[0].error).toMatch(/exited with code 1/);
    expect(r.flows[0].errored[0]).toMatch(/exited with code 1/);
    expect(w.events()[0]).toMatchObject({ kind: "errored", output: "boom" });
  });
});

describe("runHeadlessPass — what needs an editor", () => {
  it("leaves a met launch pending and names it, writing nothing", async () => {
    const w = world([armed([place("n1", "PROJ-1"), planned("n2")], [edge("e1", "n1", "n2")], { launchConfirmedAt: 5 })]);
    const before = w.files[path.join(DIR, "f1.json")];
    const r = await runHeadlessPass(w.deps());
    expect(r.flows[0].needsEditor).toEqual(["e1 (n1 → n2, launch)"]);
    expect(w.files[path.join(DIR, "f1.json")]).toBe(before);
    expect(w.events()).toEqual([]);
  });

  it("leaves a met ask (gate) pending too — a question nobody is there to answer", async () => {
    const gate: FlowNode = { id: "g", kind: "gate", x: 0, y: 0, join: "any", question: "Ship?" };
    const w = world([armed([place("n1", "PROJ-1"), gate], [edge("e1", "n1", "g")])]);
    const r = await runHeadlessPass(w.deps());
    expect(r.flows[0].needsEditor).toEqual(["e1 (n1 → g, ask)"]);
    expect(w.flowsNow().edges[0].firedAt).toBeUndefined();
  });

  it("holds a whole target when its performer needs an editor, so a sibling is not stamped around it", async () => {
    const w = world([armed([place("n1", "PROJ-1"), place("n3", "PROJ-2"), planned("n2")],
      [edge("e1", "n1", "n2"), edge("e2", "n3", "n2")], { launchConfirmedAt: 5 })]);
    await runHeadlessPass(w.deps({ statuses: [status("PROJ-1", true), status("PROJ-2", true)] }));
    expect(w.flowsNow().edges.map((e) => e.firedAt)).toEqual([undefined, undefined]);
  });
});

describe("runHeadlessPass — the ceiling, the lock, and a dry run", () => {
  const cmdFlow = (over: Partial<Flow> = {}) =>
    armed([place("n1", "PROJ-1"), command("n2", "deploy.sh")], [edge("e1", "n1", "n2")], { commandConfirmedAt: 5, ...over });

  it("disarms at the ceiling instead of running, and journals the stop", async () => {
    const w = world([cmdFlow({ spendCeiling: 1 })]);
    appendEvent(w.journalIo, DIR, "f1", { kind: "fired", edge: "e0", from: "n1", to: "n2", action: "run", note: "" }, 1);
    const r = await runHeadlessPass(w.deps());
    expect(w.runner).not.toHaveBeenCalled();
    expect(r.flows[0].disarmedAtCeiling).toBe("1 of 1 spent, and this pass wanted 1");
    expect(w.flowsNow().armed).toBe(false);
    expect(w.events().at(-1)).toMatchObject({ kind: "armed", armed: false, source: "ceiling" });
  });

  it("does nothing at all when another process holds the lock", async () => {
    const w = world([cmdFlow()]);
    w.lockIo.tryCreate(lockPath(DIR), JSON.stringify({ token: "other", at: NOW }));
    const r = await runHeadlessPass(w.deps());
    expect(r).toEqual({ lock: "busy", flows: [] });
    expect(w.runner).not.toHaveBeenCalled();
  });

  it("a dry run evaluates and reports, but writes nothing, runs nothing, and takes no lock", async () => {
    const w = world([cmdFlow()]);
    const before = { ...w.files };
    const r = await runHeadlessPass(w.deps({ dryRun: true }));
    expect(r.flows[0].fired).toEqual(['would run "deploy.sh" in aws-ops']);
    expect(w.runner).not.toHaveBeenCalled();
    expect(w.files).toEqual(before);
  });

  it("a dry run reports the notify it would have toasted", async () => {
    const w = world([armed([place("n1", "PROJ-1"), notify("n2", "landed")], [edge("e1", "n1", "n2")])]);
    const r = await runHeadlessPass(w.deps({ dryRun: true }));
    expect(r.flows[0].notified).toEqual(["would notify: Ship the migration: landed"]);
    expect(w.flowsNow().edges[0].firedAt).toBeUndefined();
  });
});

describe("commandCwd", () => {
  const flow = armed([place("n1", "PROJ-1"), command("n2", "x", "tools")], [edge("e1", "n1", "n2")]);
  const node = flow.nodes[1] as Extract<FlowNode, { kind: "command" }>;

  it("prefers a named cwdRepo from the source run, then a checkout on disk, and refuses otherwise", () => {
    const withTools: RunStatus = { ...status("PROJ-1", true), run: { ...status("PROJ-1", true).run, repos: [
      { name: "aws-ops", path: "/r/aws-ops", isGit: true }, { name: "tools", path: "/r/tools", isGit: true },
    ] } };
    expect(commandCwd(flow, flow.edges[0], node, [withTools], () => undefined)).toEqual({ cwd: "/r/tools", repo: "tools" });
    expect(commandCwd(flow, flow.edges[0], node, [status("PROJ-1", true)], (n) => ({ name: n, path: `/disk/${n}` }))).toEqual({ cwd: "/disk/tools", repo: "tools" });
    expect(commandCwd(flow, flow.edges[0], node, [status("PROJ-1", true)], () => undefined)).toMatchObject({ error: expect.stringContaining("tools") });
  });

  it("defers when a direct place's repo is missing from its run this pass, and refuses a chain rooted in nothing", () => {
    const plain = armed([place("n1", "PROJ-1"), command("n2", "x")], [edge("e1", "n1", "n2")]);
    const other: RunStatus = { ...status("PROJ-1", true), run: { ...status("PROJ-1", true).run, repos: [{ name: "elsewhere", path: "/r/e", isGit: true }] } };
    expect(commandCwd(plain, plain.edges[0], plain.nodes[1] as never, [other], () => undefined)).toMatchObject({ defer: expect.stringContaining("aws-ops") });
    const rootless = armed([planned("p"), command("n2", "x")], [edge("e1", "p", "n2")]);
    expect(commandCwd(rootless, rootless.edges[0], rootless.nodes[1] as never, [], () => undefined)).toMatchObject({ error: expect.stringContaining("nothing upstream") });
  });
});
