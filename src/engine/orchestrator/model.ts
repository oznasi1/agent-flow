// The shape of a Deck flow. Types and shape-level helpers only — no evaluation,
// no persistence, no geometry, and deliberately no imports at all, so every other
// module in this directory can depend on it without dragging anything in.

/** What several incoming edges mean at their meeting point. "any" fires on the
 * first one met; "all" waits for every one. It lives on the target node rather
 * than the edge because it is a property of the junction, not of one arrow. A
 * node with fewer than two incoming edges is unaffected by it. */
export type JoinMode = "any" | "all";

/** Where an autonomous launch puts the work. The flow's own vocabulary, not
 * `WorkspaceMode` — that type is only "multiroot" | "per-window" and cannot
 * express the worktree choice a Take offers. Phase 3's runner maps these onto the
 * take path's arguments. */
export type LaunchDest = "worktree" | "new-window" | "current-window";

interface NodeBase {
  id: string;
  x: number;
  y: number;
  join: JoinMode;
}

/** A place on disk that already exists: a run, narrowed to one of its repos. It
 * stores `runKey` and `repo` and never a pid or session id — sessions come and go
 * inside a worktree, and the worktree is what a condition can be about. */
export type PlaceNode = NodeBase & { kind: "place"; runKey: string; repo: string };

/** Work that has not started. It carries its whole launch configuration, because
 * an armed launch cannot stop to ask which repo, which prompt or where it goes. */
export type PlannedNode = NodeBase & {
  kind: "planned";
  ticketKey: string;
  repos: string[];
  mode: string; // a PromptMode id
  dest: LaunchDest;
};

/** A terminal that tells you something. Not a place, so nothing observes it. */
export type NotifyNode = NodeBase & { kind: "notify"; message: string };

export type FlowNode = PlaceNode | PlannedNode | NotifyNode;

/** Every condition kind that needs no parameter. */
export type CondKind =
  | "pr-merged"
  | "ci-passed"
  | "ci-failed"
  | "review-approved"
  | "changes-requested"
  | "threads-resolved"
  | "pr-conflicting"
  | "agent-ended-turn"
  | "no-agent-left"
  | "tree-clean"
  | "has-uncommitted"
  | "nothing-to-push"
  | "ticket-done";

/** Parameterised where it has to be, a bare kind everywhere else. */
export type Condition =
  | { kind: CondKind }
  | { kind: "agent-idle-over"; minutes: number }
  | { kind: "ticket-status-is"; status: string };

/** What an edge does when its condition is met. `launch` starts a planned node;
 * `seed` opens another agent in a place that already exists; `notify` only tells
 * you. Nothing here instructs a running agent — that is impossible. */
export type FlowAction = "launch" | "seed" | "notify";

export interface FlowEdge {
  id: string;
  from: string; // node id
  to: string; // node id
  cond: Condition;
  action: FlowAction;
  /** A PromptMode id, for `seed` only. A launch's prompt and destination live on the
   * `planned` node it targets, which carries its whole launch configuration — see
   * `PlannedNode`. Two homes for one fact is deliberate here: a place has no mode
   * field, so a seed's has nowhere else to go. */
  mode?: string;
  /** Set once this edge has fired. Its presence IS the latch: an edge with a
   * `firedAt` is never evaluated again until Reset clears it. */
  firedAt?: number;
  /** The receipt the drawer shows, e.g. "opened bite-me-3a". */
  firedNote?: string;
  /** The action threw. Never retried until Reset — retrying a launch that failed
   * every poll is how you end up with twenty windows. */
  error?: string;
}

export interface Flow {
  id: string;
  name: string;
  armed: boolean;
  createdAt: number;
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** When the user approved this flow's first launch. A flow asks once, naming
   * what it is about to open, then runs unattended — the same reasoning as the
   * resume gate: a mis-wired flow should cost one prompt, not a string of paid
   * sessions. Absent means it has never launched anything. */
  launchConfirmedAt?: number;
}

export function emptyFlow(id: string, name: string, nowMs: number): Flow {
  return { id, name, armed: false, createdAt: nowMs, nodes: [], edges: [] };
}

/** Does this edge carry a terminal stamp? A shape-level fact about the record —
 * `firedAt` says it ran, `error` says it tried and failed — and either one is
 * terminal until Reset clears it.
 *
 * It lives here, not in `evaluate.ts`, because two modules answer this question
 * and they must not drift: `evaluate.ts` skips a settled edge, and
 * `armability.ts` must not report one as "waiting on a toggle" when the real
 * reason it will never fire is that it already errored. That drift was a real
 * defect — `armability.ts` used to check only `firedAt`. */
export function isSettled(e: FlowEdge): boolean {
  return e.firedAt !== undefined || e.error !== undefined;
}

/** Does this action spend money — open a window, start a paid session? The ONE
 * place that answers this, because it used to be answered three different ways
 * that had to be kept in sync by hand: `evaluate.ts`'s launch cap, the
 * once-per-target dedupe and the dispatch check in `deckView.ts`'s
 * `advanceUnderLock`, and (indirectly) whether `spendTarget()` resolves to
 * something. A fourth action added here without updating every call site by
 * hand would otherwise be silently treated as free by whichever site got
 * missed. `notify` is the only non-spending action today, but this is written
 * as an allowlist, not a `!== "notify"` negation, so a NEW action defaults to
 * "does not spend" until someone deliberately adds it here. */
export function isSpendAction(action: FlowAction): boolean {
  return action === "launch" || action === "seed";
}

export function isPlace(n: FlowNode): n is PlaceNode {
  return n.kind === "place";
}

export function isPlanned(n: FlowNode): n is PlannedNode {
  return n.kind === "planned";
}

export function isNotify(n: FlowNode): n is NotifyNode {
  return n.kind === "notify";
}

export function findNode(flow: Flow, id: string): FlowNode | undefined {
  return flow.nodes.find((n) => n.id === id);
}

/** Every edge pointing at `nodeId`, in flow order. Flow order is what makes a
 * join deterministic: an "all" junction performs the action of its first incoming
 * edge, and "first" has to mean something stable. */
export function incomingEdges(flow: Flow, nodeId: string): FlowEdge[] {
  return flow.edges.filter((e) => e.to === nodeId);
}
