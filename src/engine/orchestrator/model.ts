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

/** A command to run when a condition is met: a deploy, a webhook call, a
 * smoke test. Either `commandId` (an entry in `agentFlow.commands`) or `run`
 * (typed into the drawer), never both — `resolveCommand` in command.ts resolves
 * which, and refuses a node carrying neither.
 *
 * A command node is not a place: nothing observes it, and no condition asks
 * what it is "doing". What a LATER rule can ask is whether it succeeded, which
 * is what the `command-succeeded` condition reads off the receipt. */
export type CommandNode = NodeBase & {
  kind: "command";
  commandId?: string;
  run?: string;
  /** Which repo's checkout to run in. Absent means the repo of the place the
   * incoming edge came from — the common case, and the one that needs no
   * configuration. */
  cwdRepo?: string;
};

/** A question the flow stops and asks you. A rule into it poses the question;
 * you answer Approve or Reject on the node; a LATER rule reads that answer as
 * `gate-approved` or `gate-rejected`.
 *
 * The same shape as `NotifyNode` with `question` where `message` is — but not
 * the same thing at all. A notify terminal is not observed by anything; a gate
 * is, which is why it keeps an out port and why the two conditions below read
 * off its incoming edge. It is the only node whose state a PERSON, rather than
 * the world, decides. */
export type GateNode = NodeBase & { kind: "gate"; question: string };

export type FlowNode = PlaceNode | PlannedNode | NotifyNode | CommandNode | GateNode;

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
  | "ticket-done"
  /** Whether the command a LATER rule points past a `CommandNode` actually ran
   * and succeeded — see that node's own doc comment. Bare, like every other
   * entry here, but answered nowhere near them: `evaluate.ts`'s `isMet`
   * intercepts this kind before `conditions.ts`'s `evalCond` ever sees it,
   * because the verdict lives on the command node's INCOMING edge, not on any
   * `RunStatus` `evalCond` could be handed. `conditions.ts` still carries a
   * documented arm for it, so it stays a total function over every kind. */
  | "command-succeeded"
  /** Did you approve — or reject — the gate this rule points back at? Bare, like
   * `command-succeeded` above, and answered in the same unusual place and for the
   * same reason: `evaluate.ts`'s `isMet` intercepts both before `conditions.ts`'s
   * `evalCond` ever sees them, because the verdict lives on the gate node's
   * INCOMING edge (`gateAnswer`, below) rather than on any `RunStatus`.
   *
   * Two kinds rather than one is not symmetry for its own sake. The stamp must
   * distinguish "rejected" from "unanswered" regardless — otherwise the drawer
   * cannot stop asking, and cannot show you what you decided — so the fact is on
   * disk either way. Reading only half of it would leave a rejected gate
   * indistinguishable from an unanswered one to every downstream rule. */
  | "gate-approved"
  | "gate-rejected";

/** The `kind` strings below are serialized into flow files under
 * ~/.agentflow/flows and shared across windows, so they keep their released
 * spelling — `agent-idle-over`, not `session-idle-over` — while the labels
 * rendered beside them read "session". That mismatch is deliberate: a card is a
 * session in the UI, and renaming a key would break every saved flow.
 *
 * Parameterised where it has to be, a bare kind everywhere else. */
export type Condition =
  | { kind: CondKind }
  | { kind: "agent-idle-over"; minutes: number }
  | { kind: "ticket-status-is"; status: string }
  /** Did CI pass on a NAMED BRANCH of a NAMED REPO — "wait for the build to pass
   * on master, then deploy to staging". Parameterised for a reason no other
   * condition here shares: every one of them asks about the place the rule's
   * source node already is (its PR, its git, its agent), so the repo is implied
   * and the branch is whatever that place has checked out. This one asks about a
   * branch nothing on the board need be sitting on, so both halves have to be
   * said out loud.
   *
   * `repo` is Agent Flow's name for a CHECKOUT (a `run.repos[].name`), not a
   * GitHub `owner/name` — it says which directory the fetch runs in, and gh
   * resolves the repository from that directory's remote. See
   * `branchCi.ts`'s `BRANCH_CI_QUERY` for why that distinction is load-bearing.
   *
   * Verdicts arrive on `CondContext.branchCi`, keyed `repo#branch`, and only an
   * explicit `"passed"` satisfies it: this condition is built to gate a deploy,
   * so an unreadable branch reads as not met (see `conditions.ts`'s arm). */
  | { kind: "branch-ci-passed"; repo: string; branch: string };

/** What a rule does when its condition is met, derived from the node it points
 * at — see `actionFor`. `run` executes a command node's command.
 *
 * Nothing here instructs a RUNNING agent; that remains impossible (see the
 * spec's out-of-scope note on `tell`). */
export type FlowAction = "launch" | "seed" | "notify" | "run" | "ask";

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
   * NOTHING on the host's acting path reads this field for behaviour any more:
   * `evaluate.ts` derives the verb from the target (`costsSlot`/`edgeAction`) and
   * carries it on `FiredEdge.action`, and `deckView.ts`'s spend-slot check, its
   * dispatch, `spendTarget` and `performEdge` all take that carried value as a
   * parameter. Nor does the WEBVIEW: Task 9 finished that half, so
   * `orchestratorRule.ts`'s labels, mode and destination all resolve through
   * `edgeAction` (the TARGET) — see `modeValueOf`'s own comment on what keying off
   * the stored field broke. `store.ts` reads it, but only to compare against the
   * derived value and latch a disagreement, and `promoteToPlace` CLEARS it on every
   * edge into a node it rewrites, because that rewrite is what would otherwise
   * manufacture such a disagreement. Comparison, compatibility and that one clear
   * are the field's whole remaining purpose. */
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
  /** Set, and only ever set to `true`, on the edge whose action actually ran —
   * as opposed to a per-target-dedupe or "all"-junction SIBLING that
   * `applyFired` (runner.ts) stamps with the identical `firedAt`-set,
   * `error`-absent shape without ever running anything. `firedAt`/`error`
   * alone cannot tell the two apart (a demoted sibling never gets `error`, so
   * it reads exactly like a successful performer); this field is the
   * explicit answer to "was THIS the one that ran", independent of whether it
   * then succeeded or failed.
   *
   * Read by `evaluate.ts`'s `commandSucceeded`, which needs to name the
   * performer among a command node's several incoming edges rather than
   * infer it from the absence of an error anywhere — the inference this
   * field replaces breaks the moment the performer alone is Reset (Reset is
   * per edge): the sibling's bare `firedAt` would otherwise outlive the
   * failure it was standing next to and read back as a success.
   *
   * Optional, absent on every edge from a build before this field existed and
   * on every non-performing edge going forward — both read the same as "not
   * this edge", which is what keeps an old flow file parsing unchanged.
   * Dropped by Reset (`flow:resetEdge`, deckView.ts), which names it in an
   * explicit list of the stamps it deletes. It used to be cleared for free —
   * that handler rebuilt the edge from an allow-list of its non-host fields —
   * but the allow-list also silently dropped `note`, the user's own
   * configuration, so it is a deny-list now: a HOST-OWNED field added here
   * needs a matching edit there, or Reset will leave it behind. */
  performed?: true;
  /** Your answer to the gate this edge points at, stamped on the PERFORMER edge
   * — the one carrying `performed: true` — for the same reason `commandSucceeded`
   * names its performer that way: `firedAt`/`error` alone cannot tell a real
   * performer from an "all"-junction or per-target-dedupe sibling that
   * `applyFired` stamps with an identical shape.
   *
   * It cannot be inferred from `firedAt`. An ask edge fires the moment the
   * question is POSED, which means "asked", never "approved" — the one place a
   * gate differs from the `command-succeeded` shape it otherwise copies.
   *
   * On the EDGE and not on the node, because Reset is per edge: clearing the ask
   * edge clears the answer and the next pass re-poses the question, which is the
   * whole Reset affordance inherited for nothing. `flow:resetEdge` (deckView.ts)
   * names it in the explicit deny-list of stamps it deletes — a host-owned field
   * added here needs a matching edit there or Reset leaves it behind.
   *
   * Optional, and absent on every flow written before this build: absent means
   * "not answered", which is what keeps an old file reading unchanged. */
  gateAnswer?: "approved" | "rejected";
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
  /** When the user approved this flow's first COMMAND. A second gate, deliberately
   * separate from `launchConfirmedAt`, because the two consents are not the same
   * one: approving a launch approves opening an agent session, and the modal that
   * asked closed with "It will keep launching on its own from now on", which
   * discloses nothing about executing shell. Every flow confirmed by an existing
   * user before commands shipped carries `launchConfirmedAt` and nothing else — one
   * shared gate would let all of those run their first `deploy.sh` with no ask at
   * all, on a machine whose owner approved a Claude Code window.
   *
   * Optional, and absent on every flow written before this build, which is what
   * makes an old file read unchanged: absent means "has never run a command", so
   * the first one asks. Nothing migrates it — a migration that copied
   * `launchConfirmedAt` into it would be inventing the consent this field exists to
   * require. */
  commandConfirmedAt?: number;
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
 * missed. `notify` and `ask` are the only non-spending actions today, but this
 * is written as an allowlist, not a `!== "notify"` negation, so a NEW action
 * defaults to "does not spend" until someone deliberately adds it here. `run`
 * was added deliberately: it executes a shell command on the user's machine,
 * unattended, which is exactly the kind of consequence the once-per-flow
 * consent gate exists to catch before the first one fires — an action that
 * reads as "free" here skips that gate entirely. `ask` earns its place in the
 * exclusion the same way `notify` does: it opens no window and starts nothing
 * paid, it only poses a question, so it must stay off the consent gate and out
 * of the once-per-pass launch cap the way `notify` already is.
 *
 * Takes `FlowAction | undefined` — `FlowEdge.action` is optional now (see its
 * own doc comment) — and answers `false` for `undefined`: an edge with no
 * derivable action cannot spend anything, the same as an edge with a known
 * non-spending one. Accepting the optional type here, rather than making
 * every caller check `e.action !== undefined` first, is what keeps this the
 * ONE place the question is answered.
 *
 * A type PREDICATE rather than a bare boolean, so the guard that decides whether
 * to spend also narrows the verb for the code that then spends it:
 * `deckView.ts`'s dispatch hands `performEdge` an action this has already
 * admitted, and `performEdge` therefore has no `undefined` case to write a
 * refusal for that nothing could reach (it had one, and it was dead). The
 * excluded set in the return type has to name `ask` alongside `notify`
 * explicitly for that same reason: leaving it as `Exclude<FlowAction,
 * "notify">` would let the type system believe an edge past this guard could
 * still be `ask`, which is exactly the false belief `deckView.ts`'s dispatch
 * would otherwise be handed. */
export function isSpendAction(action: FlowAction | undefined): action is Exclude<FlowAction, "notify" | "ask"> {
  return action === "launch" || action === "seed" || action === "run";
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

export function isCommand(n: FlowNode): n is CommandNode {
  return n.kind === "command";
}

export function isGate(n: FlowNode): n is GateNode {
  return n.kind === "gate";
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
    case "gate": return "ask";
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

/** Why this condition can never be met as written, or `undefined` when it is
 * complete. A parameterised condition with a blank parameter is not merely
 * unconfigured — it is a rule the engine will evaluate forever and never
 * satisfy: `evalCond` compares `ticketStatus === ""` and looks up
 * `branchCi["#"]`, neither of which any board can produce.
 *
 * It lives HERE rather than beside the pickers in `orchestratorRule.ts` because
 * two very different callers must agree about it and neither can import the
 * other: the webview's inspector, which marks the field so the blank is visible
 * while it is being made, and `armability.ts`, which is what makes arming SAY so
 * rather than leaving the user waiting on a rule that cannot fire. That is the
 * same drift argument `isSettled` above is written for.
 *
 * `agent-idle-over` is deliberately absent: `withCond` seeds it with a real
 * minute count and the picker's own control cannot produce a blank one, so it
 * has no incomplete shape to report. A hand-edited flow naming `minutes: 0`
 * is not incomplete either — it means "fires as soon as the session is idle",
 * which is a rule that works.
 *
 * The returned string is the REASON, phrased to sit inside both callers'
 * sentences ("branch CI passed… — no branch set" and "1 rule has no branch
 * set"), so neither has to invent wording the other might contradict. */
export function condIncomplete(cond: Condition): string | undefined {
  switch (cond.kind) {
    case "ticket-status-is":
      return blank(cond.status) ? "no status set" : undefined;
    case "branch-ci-passed":
      if (blank(cond.repo)) return "no repo set";
      return blank(cond.branch) ? "no branch set" : undefined;
    default:
      return undefined;
  }
}

/** Is this parameter missing? A `typeof` check and not just `=== ""`, because
 * the value can be genuinely ABSENT despite what `Condition` claims: a flow file
 * is JSON somebody can hand-edit, and `store.ts`'s `validEdge` admits an edge on
 * the strength of its `kind` without reading the parameters beside it — so
 * `{"kind":"ticket-status-is"}` reaches this function with no `status` at all.
 * A bare `.trim()` on that throws, and it throws inside `unfirableRules`, which
 * is called while ARMING: one hand-edited rule would take the whole arm down
 * rather than being reported as the one rule that cannot fire. Absent and blank
 * mean the same thing here anyway — nothing to match against. */
function blank(v: unknown): boolean {
  return typeof v !== "string" || v.trim() === "";
}
