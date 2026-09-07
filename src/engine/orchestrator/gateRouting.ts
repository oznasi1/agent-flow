// A gate with someone else's name on it.
//
// A gate node closed the "a flow can only tell you, never ask you" gap — but
// only for the person sitting at the machine that asked. `GateNode.askWho` names
// one or more forge logins; when the ask fires, the host posts the question as a
// comment on the card's pull request mentioning them, and each pass reads that
// thread for their replies. `approve` or `reject` there answers the gate exactly
// as the drawer's buttons do, from a phone, with no Deck open anywhere.
//
// With several names, `GateNode.askMode` says how many must speak: `any` — the
// first answer from any of them decides, which is the one-login behaviour
// generalised; `all` — every one of them must approve, and one reject from any
// of them rejects at once. Nothing more: no quorum counts, no weights.
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

/** One person's recorded answer — the value shape of `FlowEdge.routedAnswers`. */
export type RoutedAnswer = { answer: "approved" | "rejected"; at: number; url?: string };

/** The people a gate is routed to, parsed from `askWho`: split on commas and
 * whitespace, a leading `@` dropped, blanks dropped, de-duplicated
 * case-insensitively keeping the first spelling — a forge login's case is not
 * significant, and `alice, Alice` is one person. `[]` for a local gate. The ONE
 * parser of the field; every reader goes through it. */
export function gateLogins(n: GateNode): string[] {
  if (typeof n.askWho !== "string") return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of n.askWho.split(/[,\s]+/)) {
    const login = raw.replace(/^@/, "");
    if (login === "" || seen.has(login.toLowerCase())) continue;
    seen.add(login.toLowerCase());
    out.push(login);
  }
  return out;
}

/** How many of the gate's people must answer. `"all"` for exactly that string;
 * anything else — absent, `"any"`, or a hand-edited value — is `"any"`. The
 * choice follows `readCommandConsent`'s principle that a stray value must never
 * WIDEN what a stored decision means: `any` is what every released gate does and
 * what one login always meant, and `askMode` is only ever written by the
 * drawer's control, so an unrecognised value is a file edited by hand and reads
 * as the behaviour the author already had rather than as a new one. */
export function gateMode(n: GateNode): "any" | "all" {
  return n.askMode === "all" ? "all" : "any";
}

/** The comment the host posts. Names the people, the flow and the question, and
 * says exactly how to answer — and, with several names, how many of them must.
 * Ends with the extension's name so a reader of the PR knows what posted it.
 * One login produces exactly the text it always did, whatever the mode: there
 * is nobody else for "each of you" to mean. */
export function routedGateQuestion(flowName: string, question: string, login: string): string;
export function routedGateQuestion(flowName: string, question: string, logins: readonly string[], mode: "any" | "all"): string;
export function routedGateQuestion(flowName: string, question: string, who: string | readonly string[], mode: "any" | "all" = "any"): string {
  const logins = (typeof who === "string" ? [who] : who).map((l) => `@${l.trim().replace(/^@/, "")}`);
  const how = logins.length <= 1 ? "Reply `approve` or `reject` here to answer."
    : mode === "all" ? "Each of you must reply `approve` here; a single `reject` decides."
    : "Any one of you can answer: reply `approve` or `reject` here.";
  return `${logins.join(" ")} — **${flowName}** is waiting on you: ${question}\n\n${how} (Agent Flow Deck)`;
}

/** Each named person's first answer on the thread, merged into what was already
 * recorded. Keyed by lowercase login. A login already in `existing` is never
 * overwritten — first answer per person wins, the same rule `gateAnswerFrom`
 * applies within one person's replies — so a comment edited or deleted after it
 * was read changes nothing. Returns a NEW record; `existing` is not touched. */
export function collectRoutedAnswers(
  comments: readonly GateComment[],
  logins: readonly string[],
  sinceMs: number,
  existing: Readonly<Record<string, RoutedAnswer>> | undefined,
): Record<string, RoutedAnswer> {
  const out: Record<string, RoutedAnswer> = { ...(existing ?? {}) };
  for (const login of logins) {
    const key = login.trim().replace(/^@/, "").toLowerCase();
    if (key in out) continue;
    const hit = gateAnswerFrom(comments, login, sinceMs);
    if (hit) out[key] = hit;
  }
  return out;
}

/** What the recorded answers decide, or `undefined` while the gate still waits.
 * `any`: the earliest answer from a named person decides, and `by` is that one
 * login. `all`: a single `rejected` from any named person rejects at once (a
 * veto) and `by` names the rejecters; every named person `approved` approves
 * and `by` names them all; anything short of that is waiting. Only the gate's
 * own logins count — a key for anyone else is ignored. `by` carries the
 * spelling from `logins`, not the lowercase key, so a journal line reads as the
 * author wrote the name. */
export function gateVerdict(
  mode: "any" | "all",
  logins: readonly string[],
  answers: Readonly<Record<string, RoutedAnswer>>,
): { answer: "approved" | "rejected"; by: string[] } | undefined {
  const named = logins.map((l) => ({ login: l.trim().replace(/^@/, ""), hit: answers[l.trim().replace(/^@/, "").toLowerCase()] }));
  if (mode === "any") {
    const first = named.filter((n) => n.hit).sort((a, b) => a.hit!.at - b.hit!.at)[0];
    return first ? { answer: first.hit!.answer, by: [first.login] } : undefined;
  }
  const rejecters = named.filter((n) => n.hit?.answer === "rejected").map((n) => n.login);
  if (rejecters.length > 0) return { answer: "rejected", by: rejecters };
  if (named.length > 0 && named.every((n) => n.hit?.answer === "approved")) return { answer: "approved", by: named.map((n) => n.login) };
  return undefined;
}

/** Are two answer records the same? Absent reads as empty. What a host uses to
 * decide whether a poll that decided nothing still has a partial state worth
 * writing. */
export function sameRoutedAnswers(
  a: Readonly<Record<string, RoutedAnswer>> | undefined,
  b: Readonly<Record<string, RoutedAnswer>> | undefined,
): boolean {
  const ka = Object.keys(a ?? {}).sort();
  const kb = Object.keys(b ?? {}).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => a![k].answer === b![k].answer && a![k].at === b![k].at && a![k].url === b![k].url);
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

/** Is this gate routed to someone? At least one login in `askWho`. */
export function isRouted(n: GateNode): boolean {
  return gateLogins(n).length > 0;
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
