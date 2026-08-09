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

/** What a rule does when its condition is met, derived from the node it points
 * at — see `actionFor`. `run` executes a command node's command.
 *
 * Nothing here instructs a RUNNING agent; that remains impossible (see the
 * spec's out-of-scope note on `tell`). */
export type FlowAction = "launch" | "seed" | "notify" | "run";

export interface FlowEdge {
  id: string;
  from: string; // node id
  to: string; // node id
  cond: Condition;
  /** Mirrors the action its target implies — see `edgeAction`/`actionFor` — but
   * is NOT simply overwritten with that mirror: `writeFlow` writes `e.action ??
   * derived`, preserving a stored value that disagrees with the target, because
   * that disagreement is exactly what `latchActionMismatches` (`store.ts`) needs
   * to see on the next read to latch the edge instead of silently reinterpreting
   * it. The field also stays on the record for compatibility: an OLDER build's
   * `validEdge` *requires* it and DROPS any edge without it, so a file this
   * build wrote without the field would lose every rule after a downgrade or a
   * rollback — an edge THIS build created has no stored value yet, so it always
   * falls through to the derived one.
   *
   * As of this task it is still read directly for behaviour at several call
   * sites — `deckView.ts`'s spend-slot check, its dispatch, `spendTarget`/
   * `performAction`, and the webview's rule labels/mode/dest resolution in
   * `orchestratorRule.ts` — because moving each of those onto `edgeAction` is
   * Task 3's work, not this one. (`evaluate.ts`'s own spend-slot check moved
   * onto `edgeAction` in Task 2 — see `evaluate.ts`'s `costsSlot`.) Do not
   * read this comment as "nothing does" until Task 3 lands. */
  action?: FlowAction;
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
  /** Extra, once-off text for the agent this rule starts — appended to the prompt
   * mode's template, or substituted at `{note}` if the template has one. For
   * `launch` and `seed` only; a `notify` rule's words live on its notify node.
   * Reusable instructions belong in `agentFlow.promptModes`, which the rule
   * already picks from — this is for what is specific to THIS transition. */
  note?: string;
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
 * "does not spend" until someone deliberately adds it here.
 *
 * Takes `FlowAction | undefined` — `FlowEdge.action` is optional now (see its
 * own doc comment) — and answers `false` for `undefined`: an edge with no
 * derivable action cannot spend anything, the same as an edge with a known
 * non-spending one. Accepting the optional type here, rather than making
 * every caller check `e.action !== undefined` first, is what keeps this the
 * ONE place the question is answered. */
export function isSpendAction(action: FlowAction | undefined): boolean {
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

/** The action a node kind implies. This is the single source of truth for "what
 * does this rule do", replacing the copy that used to live on the edge — the
 * drawer already refused every pairing except these, which is the tell that the
 * edge's copy was always redundant.
 *
 * Takes a `string`, not `FlowNode["kind"]`: `store.ts`'s `validNode` admits an
 * unknown kind on purpose so a flow written by a newer build still renders, and
 * such a node must derive NO action rather than fall through to a wrong one. */
export function actionFor(kind: string): FlowAction | undefined {
  switch (kind) {
    case "planned": return "launch";
    case "place": return "seed";
    case "notify": return "notify";
    case "command": return "run";
    default: return undefined;
  }
}

/** The action this edge performs: the one its TARGET implies. `undefined` when
 * the target is missing or of a kind this build does not know. */
export function edgeAction(flow: Flow, e: FlowEdge): FlowAction | undefined {
  return actionFor(findNode(flow, e.to)?.kind ?? "");
}

/** The opening words of the error stamped on an edge whose stored action
 * disagrees with its target. Exported so the migration, the drawer's copy, and
 * the tests all name it once. */
export const ACTION_MISMATCH_PREFIX = "This rule's action no longer matches where it points";
