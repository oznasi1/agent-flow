import type { Flow, FlowEdge, FlowNode } from "../../src/engine/orchestrator/model";
import type { OutboundMessage, RunStatus } from "../../src/types";

/** Restated from `test/webview/DeckApp.test.tsx`'s own `mkStatus`, not
 *  imported: that file carries a `// @vitest-environment jsdom` docblock and
 *  calls `vi.mock` at module scope, and Vitest globals do not exist in a
 *  Playwright CT worker. Kept field-for-field identical so a fixture built
 *  here means the same thing it means over there. */
export const mkStatus = (over: Partial<RunStatus> = {}): RunStatus => ({
  run: {
    key: "PROJ-1", summary: "Export fails on large accounts", url: "https://jira/PROJ-1",
    createdAt: 1, mode: "per-window",
    repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "PROJ-1-x" }], briefPaths: [],
  },
  column: "progress",
  ticketStatus: "In Progress",
  ticketCategory: "indeterminate",
  repos: [{ name: "svc", path: "/r/svc", branch: "PROJ-1-x", dirty: true, ahead: 1, added: 12, removed: 2, files: 3 }],
  agent: { state: "working", lastActivityMs: 1_000, slug: "export-streaming" },
  windowOpen: false,
  prs: {},
  agents: [],
  shelf: "board",
  ...over,
});

export const runsMsg = (runs: RunStatus[]): Extract<OutboundMessage, { type: "deck:runs" }> => ({
  type: "deck:runs", runs, ghNote: null, prReviewStatus: "PR initiated", showTokenTotal: false,
  staleCount: 0, sourceLabel: "Jira", agentLabel: "Claude Code",
});

/** Same shape `DeckApp.test.tsx`'s own `flowsMsg` posts — every list on this
 *  message is defaulted by the real handler, but a CT spec should still send
 *  a complete, honest payload rather than lean on that tolerance. */
export const flowsMsg = (flows: Flow[], enabled = true): Extract<OutboundMessage, { type: "deck:flows" }> => ({
  type: "deck:flows", commands: [], branchCi: {}, flows, enabled, pendingResume: [], promptModes: [], templates: [],
});

/** Node/edge builders restated from the same test file's "the card's workflow
 *  chip" describe block — one place feeding a notify terminal, with a gate
 *  spliced in for the waiting case and an `error` stamp for the stopped one.
 *  Kept in lockstep with that file on purpose: a CT fixture that drifted from
 *  the jsdom one would prove a DIFFERENT graph shape works, not the same one
 *  the class-name assertions already pin. */
export const place = (id: string, runKey: string): FlowNode =>
  ({ id, x: 0, y: 0, join: "any", kind: "place", runKey, repo: "svc" });
export const notify = (id: string): FlowNode => ({ id, x: 0, y: 0, join: "any", kind: "notify", message: "" });
export const gateNode = (id: string, question: string): FlowNode =>
  ({ id, x: 0, y: 0, join: "any", kind: "gate", question });
export const edge = (over: Partial<FlowEdge> & { id: string; from: string; to: string }): FlowEdge =>
  ({ cond: { kind: "pr-merged" }, ...over });

export const shipItOn = (runKey: string): Flow => ({
  id: "f1", name: "Ship it", armed: true, createdAt: 100,
  nodes: [place("n1", runKey), notify("n2")],
  edges: [edge({ id: "e1", from: "n1", to: "n2" })],
});

export const gateOn = (runKey: string, question = "approve deploy"): Flow => ({
  id: "f1", name: "Ship it", armed: true, createdAt: 100,
  nodes: [place("n1", runKey), gateNode("g1", question), notify("n2")],
  edges: [
    edge({ id: "e-ask", from: "n1", to: "g1", performed: true, firedAt: 1, firedNote: `asked you: ${question}` }),
    edge({ id: "e-gate", from: "g1", to: "n2", cond: { kind: "gate-approved" } }),
  ],
});

export const failedOn = (runKey: string): Flow => ({
  id: "f1", name: "Ship it", armed: true, createdAt: 100,
  nodes: [place("n1", runKey), notify("n2")],
  edges: [edge({ id: "e1", from: "n1", to: "n2", error: "smoke test failed" })],
});

export const doneOn = (runKey: string): Flow => ({
  id: "f1", name: "Ship it", armed: true, createdAt: 100,
  nodes: [place("n1", runKey), notify("n2")],
  edges: [edge({ id: "e1", from: "n1", to: "n2", performed: true, firedAt: 1, firedNote: "merged" })],
});
