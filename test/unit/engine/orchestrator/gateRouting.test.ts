import { describe, expect, it } from "vitest";
import {
  GATE_POLL_MS, gateAnswerFrom, gateSourcePlace, isRouted, parseGateReply, routedGateQuestion, routedGatesAwaitingAnswer,
} from "../../../../src/engine/orchestrator/gateRouting";
import { emptyFlow, Flow, FlowEdge, FlowNode, GateNode } from "../../../../src/engine/orchestrator/model";

const gate = (over: Partial<GateNode> = {}): GateNode => ({ id: "g", kind: "gate", x: 0, y: 0, join: "any", question: "deploy to prod?", ...over });
const place = (id: string, runKey: string, repo = "aws-ops"): FlowNode => ({ id, kind: "place", x: 0, y: 0, join: "any", runKey, repo });
const command = (id: string): FlowNode => ({ id, kind: "command", x: 0, y: 0, join: "any", run: "deploy.sh" });
const edge = (id: string, from: string, to: string, over: Partial<FlowEdge> = {}): FlowEdge => ({ id, from, to, cond: { kind: "pr-merged" }, ...over });
const flowWith = (nodes: FlowNode[], edges: FlowEdge[]): Flow => ({ ...emptyFlow("f1", "Ship it", 0), armed: true, nodes, edges });

describe("parseGateReply", () => {
  it("reads the first word only, case-insensitively, with trailing punctuation", () => {
    for (const ok of ["approve", "Approved.", "LGTM!", "yes, go ahead", "  approve\nthanks"]) expect(parseGateReply(ok)).toBe("approved");
    for (const no of ["reject", "Rejected", "no", "NO."]) expect(parseGateReply(no)).toBe("rejected");
  });

  it("treats anything else as conversation, not an answer — never a substring match", () => {
    expect(parseGateReply("I would not approve this yet")).toBeUndefined();
    expect(parseGateReply("looks good, will approve after lunch")).toBeUndefined();
    expect(parseGateReply("")).toBeUndefined();
    expect(parseGateReply("@bot approve")).toBeUndefined();
  });
});

describe("gateAnswerFrom", () => {
  const c = (login: string, body: string, at: number) => ({ login, body, at });

  it("takes the first answering reply from the named login after the ask, ignoring everyone else", () => {
    const replies = [c("bob", "approve", 200), c("alice", "hmm", 300), c("alice", "reject", 400), c("alice", "approve", 500)];
    expect(gateAnswerFrom(replies, "alice", 100)).toEqual({ answer: "rejected", at: 400, url: undefined });
  });

  it("ignores replies before the ask, matches the login case-insensitively and without the sigil, and sorts by time", () => {
    const replies = [c("Alice", "approve", 900), c("alice", "reject", 50)];
    expect(gateAnswerFrom(replies, "@alice", 100)?.answer).toBe("approved");
    expect(gateAnswerFrom([c("alice", "approve", 700), c("alice", "reject", 600)], "alice", 0)?.answer).toBe("rejected");
    expect(gateAnswerFrom([], "alice", 0)).toBeUndefined();
    expect(gateAnswerFrom([c("alice", "thinking", 700)], "alice", 0)).toBeUndefined();
  });

  it("carries the reply's url when the forge gave one", () => {
    expect(gateAnswerFrom([{ login: "alice", body: "approve", at: 5, url: "https://gh/c/1" }], "alice", 0)?.url).toBe("https://gh/c/1");
  });
});

describe("routedGateQuestion", () => {
  it("names the person, the flow and the question, and says how to answer", () => {
    const body = routedGateQuestion("Ship it", "deploy to prod?", "@alice");
    expect(body.startsWith("@alice — **Ship it** is waiting on you: deploy to prod?")).toBe(true);
    expect(body).toContain("Reply `approve` or `reject`");
    expect(body).toContain("Agent Flow Deck");
    expect(routedGateQuestion("f", "q", "alice")).toContain("@alice");
  });
});

describe("gateSourcePlace", () => {
  it("finds the place directly behind the gate, or behind a chain of commands, or none", () => {
    expect(gateSourcePlace(flowWith([place("p", "PROJ-1"), gate()], [edge("e1", "p", "g")]), "g")).toMatchObject({ runKey: "PROJ-1" });
    const chained = flowWith([place("p", "PROJ-2", "bite-me"), command("c1"), command("c2"), gate()],
      [edge("e1", "p", "c1"), edge("e2", "c1", "c2"), edge("e3", "c2", "g")]);
    expect(gateSourcePlace(chained, "g")).toMatchObject({ runKey: "PROJ-2", repo: "bite-me" });
    expect(gateSourcePlace(flowWith([command("c"), gate()], [edge("e1", "c", "g")]), "g")).toBeUndefined();
    // A cycle terminates.
    expect(gateSourcePlace(flowWith([command("c"), gate()], [edge("e1", "c", "g"), edge("e2", "g", "c")]), "g")).toBeUndefined();
  });
});

describe("routedGatesAwaitingAnswer", () => {
  it("lists asked, delivered, unanswered routed gates — and nothing else", () => {
    const asked = { firedAt: 5, performed: true as const };
    const delivered = { ...asked, routed: { at: 5, login: "alice" } };
    const cases: [string, Partial<GateNode>, Partial<FlowEdge>, boolean][] = [
      ["delivered and unanswered", { askWho: "alice" }, delivered, true],
      ["not routed", {}, delivered, false],
      ["blank login", { askWho: "  " }, delivered, false],
      ["not yet asked", { askWho: "alice" }, {}, false],
      ["asked but not delivered yet", { askWho: "alice" }, asked, false],
      ["delivery failed", { askWho: "alice" }, { ...asked, routed: { at: 5, login: "alice", error: "no PR" } }, false],
      ["already answered", { askWho: "alice" }, { ...delivered, gateAnswer: "approved" }, false],
    ];
    for (const [name, g, e, expected] of cases) {
      const f = flowWith([place("p", "PROJ-1"), gate(g)], [edge("e1", "p", "g", e)]);
      expect(routedGatesAwaitingAnswer(f).length, name).toBe(expected ? 1 : 0);
    }
    expect(isRouted(gate({ askWho: "alice" }))).toBe(true);
    expect(isRouted(gate())).toBe(false);
    expect(GATE_POLL_MS).toBeGreaterThanOrEqual(30_000);
  });
});
