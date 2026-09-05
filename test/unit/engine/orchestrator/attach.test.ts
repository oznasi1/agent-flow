import { describe, expect, it } from "vitest";
import type { Flow, FlowNode } from "../../../../src/engine/orchestrator/model";
import { attachedWorkflows, bindsRun } from "../../../../src/engine/orchestrator/attach";

const place = (id: string, runKey: string): FlowNode =>
  ({ id, x: 0, y: 0, join: "any", kind: "place", runKey, repo: "ingest-worker" });
const planned = (id: string, ticketKey: string): FlowNode =>
  ({ id, x: 0, y: 0, join: "any", kind: "planned", ticketKey, repos: ["ingest-worker"], mode: "plan", dest: "worktree" });
const notify = (id: string): FlowNode => ({ id, x: 0, y: 0, join: "any", kind: "notify", message: "" });

const flow = (id: string, nodes: FlowNode[], createdAt = 0): Flow =>
  ({ id, name: "Ship it", armed: false, createdAt, nodes, edges: [] });

describe("bindsRun", () => {
  it("binds by a place's run key", () => {
    expect(bindsRun(flow("f1", [place("n1", "PROJ-142")]), "PROJ-142", "PROJ-142")).toBe(true);
  });

  it("binds by a planned node's ticket key", () => {
    expect(bindsRun(flow("f1", [planned("n1", "PROJ-142")]), "local-branch-key", "PROJ-142")).toBe(true);
  });

  it("does not bind a flow that names neither", () => {
    expect(bindsRun(flow("f1", [place("n1", "PROJ-9"), notify("n2")]), "PROJ-142", "PROJ-142")).toBe(false);
  });

  it("does not bind a planned node with a blank ticket key to a card with no ticket", () => {
    // A template's planned node carries "" until instantiate binds one. An
    // undefined ticket key on the card must not match it, or every untracked
    // card would claim every half-built workflow.
    expect(bindsRun(flow("f1", [planned("n1", "")]), "local-key", undefined)).toBe(false);
  });

  it("ignores case-insensitive near-misses — keys are exact", () => {
    expect(bindsRun(flow("f1", [place("n1", "proj-142")]), "PROJ-142", "PROJ-142")).toBe(false);
  });
});

describe("attachedWorkflows", () => {
  it("returns nothing when no flow binds the run", () => {
    expect(attachedWorkflows([flow("f1", [place("n1", "PROJ-9")])], "PROJ-142", "PROJ-142")).toEqual([]);
  });

  it("returns the one flow that binds it", () => {
    const flows = [flow("f1", [place("n1", "PROJ-9")]), flow("f2", [place("n1", "PROJ-142")])];
    expect(attachedWorkflows(flows, "PROJ-142", "PROJ-142").map((f) => f.id)).toEqual(["f2"]);
  });

  it("returns two hand-drawn matches oldest first", () => {
    // Nothing stops somebody hand-drawing two flows that touch one card. The
    // drawer must resolve deterministically rather than pick whichever the
    // filesystem listed first.
    const flows = [flow("f2", [place("n1", "PROJ-142")], 200), flow("f1", [place("n1", "PROJ-142")], 100)];
    expect(attachedWorkflows(flows, "PROJ-142", "PROJ-142").map((f) => f.id)).toEqual(["f1", "f2"]);
  });
});

import { rankByState, workflowState } from "../../../../src/engine/orchestrator/attach";
import type { FlowEdge } from "../../../../src/engine/orchestrator/model";

const edge = (over: Partial<FlowEdge> & { id: string }): FlowEdge =>
  ({ from: "n1", to: "n2", cond: { kind: "pr-merged" }, ...over });

/** A flow whose place names a run no board has — every condition on it reads
 * nothing, which `evaluate.ts` reports as blocked "gone". */
const withEdges = (edges: FlowEdge[], armed = true, createdAt = 0): Flow => ({
  id: "f1", name: "Ship it", armed, createdAt,
  nodes: [place("n1", "PROJ-142"), notify("n2")],
  edges,
});

/** A flow with a real gate node between the place and the notify terminal, so a
 * `gate-approved` edge can be genuinely posed-and-unanswered rather than merely
 * pending. `evaluate.ts`'s `gateAnswer` only reports `awaiting-answer` once an
 * incoming edge into the gate is itself settled (`performed` and `firedAt` both
 * set) — the caller supplies that "ask" edge. */
const gate = (id: string): FlowNode => ({ id, x: 0, y: 0, join: "any", kind: "gate", question: "Proceed?" });
const withGate = (edges: FlowEdge[], armed = true, createdAt = 0): Flow => ({
  id: "f1", name: "Ship it", armed, createdAt,
  nodes: [place("n1", "PROJ-142"), gate("g1"), notify("n2")],
  edges,
});

describe("workflowState", () => {
  it("is disarmed when the flow is not armed, whatever the rules say", () => {
    const s = workflowState(withEdges([edge({ id: "e1" })], false), [], 1000);
    expect(s.status).toBe("disarmed");
  });

  it("is stopped when any edge carries an error, and names the failed step", () => {
    const s = workflowState(withEdges([
      edge({ id: "e1", firedAt: 1, firedNote: "ran · exit 0" }),
      edge({ id: "e2", error: "exit 1 · 3 assertions failed" }),
    ]), [], 1000);
    expect(s.status).toBe("stopped");
    expect(s.steps.find((x) => x.edgeId === "e2")).toMatchObject({
      state: "fail", receipt: "exit 1 · 3 assertions failed",
    });
  });

  it("prefers stopped over waiting-on-you", () => {
    // A failure the user can act on outranks a question, because the failure is
    // what actually halted the workflow. Verified against a REAL awaiting-answer
    // step (a posed, unanswered gate) — not merely an ordinary pending edge that
    // happens to carry a `gate-approved` condition with no gate behind it.
    const s = workflowState(withGate([
      edge({ id: "e-fail", error: "exit 1" }),
      edge({ id: "e-ask", from: "n1", to: "g1", performed: true, firedAt: 1, firedNote: "asked" }),
      edge({ id: "e-gate", from: "g1", to: "n2", cond: { kind: "gate-approved" } }),
    ]), [], 1000);
    expect(s.status).toBe("stopped");
    expect(s.steps.find((x) => x.edgeId === "e-gate")).toMatchObject({
      state: "you", reason: "awaiting-answer",
    });
  });

  it("reaches waiting-on-you through a real posed, unanswered gate", () => {
    // The gate is asked (an incoming edge settled with `firedAt`) but never
    // answered (no `gateAnswer` on it), which is exactly what `evaluate.ts`
    // reports as blocked `awaiting-answer` — not a hand-built `WorkflowState`.
    const s = workflowState(withGate([
      edge({ id: "e-ask", from: "n1", to: "g1", performed: true, firedAt: 1, firedNote: "asked" }),
      edge({ id: "e-gate", from: "g1", to: "n2", cond: { kind: "gate-approved" } }),
    ]), [], 1000);
    expect(s.status).toBe("waiting-on-you");
    expect(s.steps.find((x) => x.edgeId === "e-gate")).toMatchObject({
      state: "you", reason: "awaiting-answer",
    });
    expect(s.steps.find((x) => x.edgeId === "e-gate")?.receipt).toBeUndefined();
  });

  it("reads a disarmed workflow with a failed edge as stopped", () => {
    // An error is a fact about what already happened, not about what will — so
    // it outranks the disarmed reading rather than being masked by it.
    const s = workflowState(withEdges([edge({ id: "e1", error: "exit 1" })], false), [], 1000);
    expect(s.status).toBe("stopped");
  });

  it("marks only the first pending step as current", () => {
    // Marking every pending step "now" would say the workflow is doing three
    // things at once. Nothing else in this file covers the latch.
    const s = workflowState(withEdges([
      edge({ id: "e1", firedAt: 5 }),
      edge({ id: "e2" }),
      edge({ id: "e3" }),
    ]), [], 1000);
    expect(s.steps.map((x) => x.state)).toEqual(["done", "now", "waiting"]);
  });

  it("carries previewFlow's reason as a code, not as prose", () => {
    // A place naming a run no board has cannot be observed at all, which
    // evaluate.ts reports as blocked "gone". The step hands that code on for
    // the webview to word — it must not invent a sentence itself.
    const s = workflowState(withEdges([edge({ id: "e1" })]), [], 1000);
    expect(s.steps[0].reason).toBe("gone");
    expect(s.steps[0].receipt).toBeUndefined();
  });

  it("reports a fired edge as done, with its receipt", () => {
    const s = workflowState(withEdges([edge({ id: "e1", firedAt: 5, firedNote: "told you" })]), [], 1000);
    expect(s.steps[0]).toMatchObject({ state: "done", receipt: "told you" });
    expect(s.done).toBe(1);
    expect(s.total).toBe(1);
  });

  it("is done when no rule is left in play", () => {
    // `done` is the ABSENCE of a pending rule, not a stored flag — same
    // reasoning as attachment itself.
    const s = workflowState(withEdges([
      edge({ id: "e1", firedAt: 5 }),
      edge({ id: "e2", firedAt: 6 }),
    ]), [], 1000);
    expect(s.status).toBe("done");
    expect(s.done).toBe(2);
  });

  it("counts done out of total for the header", () => {
    const s = workflowState(withEdges([
      edge({ id: "e1", firedAt: 5 }),
      edge({ id: "e2", firedAt: 6 }),
      edge({ id: "e3" }),
    ]), [], 1000);
    expect([s.done, s.total]).toEqual([2, 3]);
  });

  // The other four of `workflowState`'s five statuses are each asserted by
  // name above; `advancing` was only ever implied through `rankByState`'s
  // ordering ("puts a stopped workflow ahead of an advancing one" etc.),
  // never pinned directly here. Armed, no error, no gate, and not every edge
  // settled — the one status left once the other four are ruled out.
  it("is advancing when armed with a pending rule and no failure, question, or completion", () => {
    const s = workflowState(withEdges([edge({ id: "e1" })]), [], 1000);
    expect(s.status).toBe("advancing");
  });
});

describe("rankByState", () => {
  const armedWith = (id: string, edges: FlowEdge[], createdAt: number): Flow =>
    ({ ...withEdges(edges, true, createdAt), id });

  it("puts a stopped workflow ahead of an advancing one", () => {
    const stopped = armedWith("f-stop", [edge({ id: "e1", error: "exit 1" })], 200);
    const advancing = armedWith("f-adv", [edge({ id: "e1" })], 100);
    expect(rankByState([advancing, stopped], [], 1000).map((f) => f.id)).toEqual(["f-stop", "f-adv"]);
  });

  it("puts a done workflow last", () => {
    const done = armedWith("f-done", [edge({ id: "e1", firedAt: 1 })], 100);
    const advancing = armedWith("f-adv", [edge({ id: "e1" })], 200);
    expect(rankByState([done, advancing], [], 1000).map((f) => f.id)).toEqual(["f-adv", "f-done"]);
  });

  it("breaks a tie by createdAt, oldest first", () => {
    const a = armedWith("f-old", [edge({ id: "e1" })], 100);
    const b = armedWith("f-new", [edge({ id: "e1" })], 200);
    expect(rankByState([b, a], [], 1000).map((f) => f.id)).toEqual(["f-old", "f-new"]);
  });
});

import { boundTicketKeyOf, cardWorkflow } from "../../../../src/engine/orchestrator/attach";
import { ticketKeyFor, type PrEntryMap, type Run, type RunStatus } from "../../../../src/types";

// The seam these two halves meet at, tested as an EQUALITY rather than as two
// independent expectations: `deckView.ts`'s `flow:attach` binds the planned node
// it creates by `ticketKeyFor(run, connector)`, and the card's own drawer looks
// for that node by `boundTicketKeyOf`. They must be the same string for every run
// shape — when they were not, attaching a workflow to a local card created a flow
// the card could not see, and pressing Attach again produced a refusal naming a
// hash the user had never been shown.
//
// `ticketKeyFor` is the real host function, called here with the one method it
// asks for: a Jira-shaped `keyFromUrl` (a `/browse/` url yields its key, anything
// else — a PR url, an empty string — yields null, exactly as
// `src/tasks/jira/connector.ts` does). The connector itself cannot be imported
// into a unit test: it reaches `vscode`.
const BROWSE = "/browse/";
const connector = {
  keyFromUrl: (url: string): string | null => {
    const i = url.indexOf(BROWSE);
    if (i < 0) return null;
    return url.slice(i + BROWSE.length).trim() || null;
  },
};

const mkRun = (over: Partial<Run> & { key: string }): Run => ({
  summary: "Export fails", url: "", createdAt: 1, mode: "per-window",
  repos: [{ name: "ingest-worker", path: "/r/ingest-worker", isGit: true, branch: "feat/x" }],
  briefPaths: [], ...over,
});

/** What the host actually puts on the wire for a run — the rule `deckView.ts`'s
 * `ticketKeyPatch` applies: `inferredTicketKey` is present exactly when
 * `ticketKeyFor` disagrees with the record's own key. Mirrored here rather than
 * imported because the method is private to a class that needs a running editor;
 * `test/unit/deckView.test.ts` pins the host's half against the real thing. */
const wire = (run: Run): RunStatus => {
  const key = ticketKeyFor(run, connector);
  return {
    run,
    column: "review", ticketStatus: null, ticketCategory: "indeterminate",
    repos: [], agent: { state: "unknown", lastActivityMs: null, slug: null },
    windowOpen: false, prs: {} as PrEntryMap, agents: [], shelf: "board",
    ...(key === run.key ? {} : { inferredTicketKey: key }),
  };
};

/** Every run shape a card can have, with the ticket key a planned node must be
 * bound by on each. The local key is `localKey`'s real shape
 * (`local-<slug>-<sha1 prefix>`), and the Track-it row is that same hash after
 * `track()` promoted it to a "task" record because a real run already owned
 * PROJ-9 — its ticket then lives ONLY in the url. */
const SHAPES: [string, Run, string][] = [
  ["a launched task run", mkRun({ key: "PROJ-142", url: "https://jira/browse/PROJ-142", kind: "task" }), "PROJ-142"],
  ["a local run whose branch names a ticket", mkRun({ key: "local-webapp-9f2c1a4", url: "https://jira/browse/PROJ-9", kind: "local" }), "PROJ-9"],
  ["a local run with no ticket at all", mkRun({ key: "local-webapp-9f2c1a4", url: "", kind: "local" }), "local-webapp-9f2c1a4"],
  ["a Track-it run still keyed by its place hash", mkRun({ key: "local-webapp-9f2c1a4", url: "https://jira/browse/PROJ-9", kind: "task" }), "PROJ-9"],
  ["a review run", mkRun({ key: "review-webapp-850", url: "https://gh/o/r/pull/850", kind: "review" }), "review-webapp-850"],
];

describe("boundTicketKeyOf", () => {
  it.each(SHAPES)("%s: binds by the same key ticketKeyFor gives the host", (_name, run, expected) => {
    expect(boundTicketKeyOf(wire(run))).toBe(expected);
    expect(boundTicketKeyOf(wire(run))).toBe(ticketKeyFor(run, connector));
  });

  it("does not read a local card's hash as its ticket", () => {
    // The regression itself, stated as its own claim: the old derivation
    // (`isTicketRun(run) ? run.key : …`) returned the hash here, because a local
    // run has a real url and `isTicketRun` only excludes review runs.
    const local = mkRun({ key: "local-webapp-9f2c1a4", url: "https://jira/browse/PROJ-9", kind: "local" });
    expect(boundTicketKeyOf(wire(local))).not.toBe(local.key);
  });
});

describe("cardWorkflow", () => {
  // A freshly attached workflow, as `instantiate` builds one: a template carries
  // NO place nodes (saving demotes every place to planned), so the planned node's
  // ticket key is the only binding that exists. This is the shape the seam above
  // decides — nothing else in the flow names the card.
  const plannedOnly = (ticketKey: string): Flow =>
    ({ id: "f1", name: "Ship it", armed: false, createdAt: 100, nodes: [planned("n1", ticketKey)], edges: [] });

  it.each(SHAPES)("%s: finds the workflow the host bound to it", (_name, run, expected) => {
    const found = cardWorkflow([plannedOnly(expected)], wire(run), [], 1000);
    expect(found?.flow.id).toBe("f1");
    expect(found?.state.status).toBe("disarmed");
    expect(found?.extraCount).toBe(0);
  });

  it("returns undefined when no flow binds the card", () => {
    const run = mkRun({ key: "local-webapp-9f2c1a4", url: "https://jira/browse/PROJ-9", kind: "local" });
    expect(cardWorkflow([plannedOnly("PROJ-141")], wire(run), [], 1000)).toBeUndefined();
  });

  it("still binds by a place's run key, and counts the workflows it is not showing", () => {
    // Both halves of `bindsRun` on one card: a hand-drawn flow with a place on
    // the run key, plus the attached one bound by the ticket. The failed flow
    // ranks first (`rankByState`), and the other is what `extraCount` counts.
    const run = mkRun({ key: "local-webapp-9f2c1a4", url: "https://jira/browse/PROJ-9", kind: "local" });
    const stopped: Flow = {
      id: "f-stop", name: "Hotfix", armed: true, createdAt: 200,
      nodes: [place("n1", run.key), notify("n2")],
      edges: [edge({ id: "e1", error: "exit 1" })],
    };
    const found = cardWorkflow([plannedOnly("PROJ-9"), stopped], wire(run), [], 1000);
    expect(found?.flow.id).toBe("f-stop");
    expect(found?.state.status).toBe("stopped");
    expect(found?.extraCount).toBe(1);
  });
});

describe("workflowState — an expired rule", () => {
  it("reports an expired edge as expired, with no receipt of its own", () => {
    const s = workflowState(withEdges([edge({ id: "e1", timeoutMinutes: 10, liveSince: 1, expiredAt: 700 })]), [], 1000);
    expect(s.steps[0]).toMatchObject({ state: "expired" });
    expect(s.steps[0].receipt).toBeUndefined();
    expect(s.done).toBe(1);
  });

  it("does not stop the workflow — a sibling may be the one that acts on the deadline", () => {
    const s = workflowState(withEdges([
      edge({ id: "e1", expiredAt: 700 }),
      edge({ id: "e2", cond: { kind: "deadline-passed" } }),
    ]), [], 1000);
    expect(s.status).toBe("advancing");
    expect(s.steps[1].state).toBe("now");
  });

  it("is done when every rule has fired or expired", () => {
    const s = workflowState(withEdges([edge({ id: "e1", firedAt: 5 }), edge({ id: "e2", expiredAt: 6 })]), [], 1000);
    expect(s.status).toBe("done");
  });

  it("names the moment a current step's clock runs out", () => {
    const s = workflowState(withEdges([edge({ id: "e1", timeoutMinutes: 10, liveSince: 1_000 })]),
      [wire(mkRun({ key: "PROJ-142" }))], 61_000);
    expect(s.steps[0]).toMatchObject({ state: "now", deadlineAt: 1_000 + 10 * 60_000 });
  });
});
