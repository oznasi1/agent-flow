// A gate with someone else's name on it.
//
// A gate node closed the "a flow can only tell you, never ask you" gap — but
// only for the person sitting at the machine that asked. `GateNode.askWho` names
// a forge login; when the ask fires, the host posts the question as a comment on
// the card's pull request mentioning them, and each pass reads that thread for
// their reply. `approve` or `reject` there answers the gate exactly as the
// drawer's buttons do, from a phone, with no Deck open anywhere.
//
// This module is the pure half: what the comment says, how a reply is read, and
// which place a gate hangs off. No imports beyond the model, so the webview can
// show the same words the host posts. The forge calls live in
// `engine/forge/gateChannels.ts`; the writes live in the hosts.
import { Flow, FlowEdge, GateNode, PlaceNode, findNode, gateAskEdge, incomingEdges, isPlace } from "./model";

/** One reply on the thread, as the forge returned it. `login` is the forge's own
 * identity for the author — the only thing that decides whether a reply counts. */
export interface GateComment {
  login: string;
  body: string;
  /** Epoch ms. */
  at: number;
  url?: string;
}

/** How often a routed gate's thread is read. A forge call per pass per gate
 * would be a request every six seconds for as long as nobody answers; once a
 * minute is prompt enough for a question a person answers from their phone. */
export const GATE_POLL_MS = 60_000;

/** The words that answer. First word of the reply, case-insensitive, trailing
 * punctuation ignored — `Approve.`, `approved`, `LGTM`, `yes`; `reject`,
 * `rejected`, `no`. Anything else is conversation, not an answer, and the
 * thread keeps being read. Deliberately not a substring search: "I would not
 * approve this yet" must not approve. */
export function parseGateReply(body: string): "approved" | "rejected" | undefined {
  const first = body.trim().split(/\s+/)[0]?.replace(/[.,!:;]+$/, "").toLowerCase() ?? "";
  if (first === "approve" || first === "approved" || first === "lgtm" || first === "yes") return "approved";
  if (first === "reject" || first === "rejected" || first === "no") return "rejected";
  return undefined;
}

/** The first reply from `login` after `sinceMs` that answers, or nothing. Only
 * that login — the thread is public to whoever can read the PR, and the gate
 * named who may answer it. Matched case-insensitively: a forge login's case is
 * not significant, and a person types `@Alice` as readily as `@alice`. */
export function gateAnswerFrom(
  comments: readonly GateComment[],
  login: string,
  sinceMs: number,
): { answer: "approved" | "rejected"; at: number; url?: string } | undefined {
  const who = login.trim().replace(/^@/, "").toLowerCase();
  for (const c of [...comments].sort((a, b) => a.at - b.at)) {
    if (c.at < sinceMs || c.login.trim().toLowerCase() !== who) continue;
    const answer = parseGateReply(c.body);
    if (answer) return { answer, at: c.at, url: c.url };
  }
  return undefined;
}

/** The comment the host posts. Names the person, the flow and the question, and
 * says exactly how to answer. Ends with the extension's name so a reader of the
 * PR knows what posted it. */
export function routedGateQuestion(flowName: string, question: string, login: string): string {
  const who = `@${login.trim().replace(/^@/, "")}`;
  return `${who} — **${flowName}** is waiting on you: ${question}\n\nReply \`approve\` or \`reject\` here to answer. (Agent Flow Deck)`;
}

/** The place a gate hangs off — where the pull request it is asked on lives.
 * Walks BACK from the gate through whatever asked it (a command chain, another
 * gate) until it reaches a place node, the same way a chained command finds its
 * checkout. `undefined` for a gate nothing has wired to a place: there is no PR
 * to ask on, and the host says so. */
export function gateSourcePlace(flow: Flow, gateNodeId: string): PlaceNode | undefined {
  const seen = new Set<string>();
  const queue = [gateNodeId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of incomingEdges(flow, id)) {
      const from = findNode(flow, e.from);
      if (!from) continue;
      if (isPlace(from)) return from;
      queue.push(from.id);
    }
  }
  return undefined;
}

/** Is this gate routed to someone? A non-blank `askWho`. */
export function isRouted(n: GateNode): boolean {
  return typeof n.askWho === "string" && n.askWho.trim() !== "";
}

/** The routed gates a host should read a thread for: asked (the performer edge
 * has fired), delivered (`routed` with no error), and still unanswered. Returns
 * the gate and the edge the answer is stamped on. */
export function routedGatesAwaitingAnswer(flow: Flow): { node: GateNode; edge: FlowEdge }[] {
  const out: { node: GateNode; edge: FlowEdge }[] = [];
  for (const n of flow.nodes) {
    if (n.kind !== "gate" || !isRouted(n)) continue;
    const edge = gateAskEdge(flow, n.id);
    if (!edge || edge.gateAnswer !== undefined || !edge.routed || edge.routed.error !== undefined) continue;
    out.push({ node: n, edge });
  }
  return out;
}
